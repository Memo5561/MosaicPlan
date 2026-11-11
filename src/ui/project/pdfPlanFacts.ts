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

/**
 * Export in Teilen (w5-fix-pdf): misst JEDEN Teil mit genau seiner Abschnittsauswahl – mit demselben Trockenlauf wie
 * eine Einzeldatei dieser Abschnitte. So nennen Teil und gleich gewählte Einzeldatei dieselbe Seitenzahl. Die Teile
 * werden nacheinander gemessen (ein Worker), erst wenn `paused` false ist (nach der Messung des Ganzen, nie während
 * eines Exports); eine unterbrochene Messung wird später fortgesetzt. Neuer `token` oder andere Teile: neu gemessen.
 * Liefert je Teil die Messwerte oder null (noch nicht gemessen bzw. gescheitert).
 */
export function usePartFacts(
  token: object,
  parts: readonly (readonly string[])[],
  build: (ids: string[], index: number, total: number) => PdfPlanRequest,
  paused: boolean,
): (PdfLayoutFacts | null)[] {
  const key = JSON.stringify(parts);
  const [res, setRes] = useState<{ token: object; key: string; facts: (PdfLayoutFacts | null)[]; failed: boolean[] } | null>(null);
  const buildRef = useRef(build);
  buildRef.current = build;
  const partsRef = useRef(parts);
  partsRef.current = parts;
  const cur = res && res.token === token && res.key === key ? res : null;
  const curRef = useRef(cur);
  curRef.current = cur;
  const done = cur ? cur.facts.filter((f, i) => f || cur.failed[i]).length : 0;

  useEffect(() => {
    const ps = partsRef.current;
    if (paused || ps.length < 2) return;
    const c = curRef.current;
    const facts = c?.facts ?? ps.map(() => null);
    const failed = c?.failed ?? ps.map(() => false);
    const i = facts.findIndex((f, k) => !f && !failed[k]);
    if (i < 0) return;
    let started = false;
    let live = true;
    const store = (f: PdfLayoutFacts | null) => {
      if (!live) return;
      const nf = [...facts];
      const nx = [...failed];
      nf[i] = f;
      nx[i] = !f;
      setRes({ token, key, facts: nf, failed: nx });
    };
    const timer = window.setTimeout(() => {
      started = true;
      let req: PdfPlanRequest;
      try {
        req = buildRef.current([...ps[i]], i, ps.length);
      } catch {
        store(null);
        return;
      }
      runWorker<'pdfPlan'>('pdfPlan', req).then(
        (r) => store(r.facts),
        (e: unknown) => {
          // abgebrochen (neuer Stand, Export gestartet): später erneut; sonst als gescheitert merken
          if ((e instanceof Error ? e.message : String(e)) !== CANCELLED) store(null);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
      if (started && channelBusy('pdfPlan')) cancelChannel('pdfPlan');
    };
  }, [token, key, paused, done]);

  return cur ? cur.facts : parts.map(() => null);
}
