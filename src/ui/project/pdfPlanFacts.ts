/**
 * Seitenplan des PDFs vorab messen (Paket w5-pdf-export-ui): Der Worker lässt den PDF-Generator im Trockenlauf
 * laufen (ohne Bilder und ohne Verlegeblätter, Kanal 'pdfPlan') und liefert die gemessenen Teile. Mit ihnen ergibt
 * planPdfPages() genau die Seitenzahl, die das PDF haben wird.
 *
 * Gemessen wird nach jeder Änderung (entprellt); eine überholte Messung wird abgebrochen. Während ein Export läuft,
 * ruht die Messung (`paused`), damit nicht zwei Worker gleichzeitig Speicher belegen.
 */
import { useEffect, useRef, useState } from 'react';
import type { PdfLayoutFacts } from '../../core/pdfPlan';
import { cancelChannel, channelBusy, runWorker } from '../../workers/client';
import type { WorkerRequest } from '../../workers/protocol';

export type PdfPlanRequest = Omit<Extract<WorkerRequest, { type: 'pdfPlan' }>, 'id'>;

export interface PdfFactsState {
  /** 'measuring': noch kein Ergebnis für den aktuellen Stand · 'ready' · 'failed' (siehe error) */
  status: 'measuring' | 'ready' | 'failed';
  /** Messwerte des aktuellen Stands (nur bei 'ready') */
  facts: PdfLayoutFacts | null;
  error: string | null;
  /** Dauer der letzten Messung in ms (nur bei 'ready') */
  ms: number | null;
}

const DEBOUNCE_MS = 300;
const CANCELLED = 'abgebrochen';

/**
 * `token` steht für den Stand, zu dem gemessen wird (neues Objekt = neuer Stand). `build` erzeugt die Anfrage erst
 * beim Start der Messung (das Raster wird dabei kopiert).
 */
export function usePdfFacts(token: object, build: () => PdfPlanRequest, paused: boolean): PdfFactsState {
  const [result, setResult] = useState<{ token: object; facts: PdfLayoutFacts | null; error: string | null; ms: number } | null>(null);
  const buildRef = useRef(build);
  buildRef.current = build;
  const doneFor = useRef<object | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (paused || doneFor.current === token) return;
    const my = ++seq.current;
    let started = false;
    const finish = (facts: PdfLayoutFacts | null, error: string | null, t0: number) => {
      if (seq.current !== my) return;
      doneFor.current = token;
      setResult({ token, facts, error, ms: Math.round(performance.now() - t0) });
    };
    const timer = window.setTimeout(() => {
      started = true;
      const t0 = performance.now();
      let req: PdfPlanRequest;
      try {
        req = buildRef.current();
      } catch (e) {
        finish(null, e instanceof Error ? e.message : String(e), t0);
        return;
      }
      runWorker<'pdfPlan'>('pdfPlan', req).then(
        (res) => finish(res.facts, null, t0),
        (e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg !== CANCELLED) finish(null, msg, t0);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      // überholte Messung beenden (nur dieser Worker; ein laufender Export nutzt den Kanal 'pdf')
      if (started && seq.current === my && doneFor.current !== token && channelBusy('pdfPlan')) cancelChannel('pdfPlan');
      seq.current++;
    };
  }, [token, paused]);

  // Ansicht geschlossen: Worker (Schriften, Kopie des Rasters) freigeben
  useEffect(() => () => cancelChannel('pdfPlan'), []);

  if (result && result.token === token) return { status: result.facts ? 'ready' : 'failed', facts: result.facts, error: result.error, ms: result.facts ? result.ms : null };
  return { status: 'measuring', facts: null, error: null, ms: null };
}
