import type { CsvWorkerRequest, CsvWorkerResponse } from './csv.worker';
import type { WorkerRequest, WorkerResponse } from './protocol';

/**
 * Je Kanal ein eigener Worker. 'preview' rechnet die Live-Vorschau der Schritte 2–7 (nie gespeichert):
 * cancelChannel('preview') beendet nur diesen Worker – eine laufende Berechnung ('compute') oder ein
 * PDF ('pdf') laufen ungestört weiter (und umgekehrt). 'pdfPlan' misst vorab den Seitenplan des PDFs (Schritt 10).
 * 'csv' (Paket w6-plan-exports) erzeugt die Koordinaten-CSV gestreamt in einem eigenen Worker (csv.worker.ts):
 * Antwort ist ein Blob statt eines Texts; cancelChannel('csv') bricht nur den CSV-Export ab.
 */
export type Channel = 'compute' | 'stats' | 'pdf' | 'preview' | 'pdfPlan' | 'csv';

type AnyResponse = WorkerResponse | CsvWorkerResponse;
/** Zusatzangaben einer Fortschrittsmeldung (CSV: Zeilen bzw. Rasterzeilen done / total) */
export interface ProgressInfo {
  done?: number;
  total?: number;
}
type ProgressFn = (phase: string, f: number, info?: ProgressInfo) => void;

const workers = new Map<Channel, Worker>();
const pending = new Map<number, { resolve: (r: AnyResponse) => void; reject: (e: Error) => void; progress?: ProgressFn; channel: Channel }>();
let nextId = 1;

/** Fehler aus einem Worker; `code` und Zusatzwerte, wenn der Worker sie mitschickt (z. B. 'csv-palette-index'). */
export interface WorkerError extends Error {
  code?: string;
  maxIndex?: number;
  paletteSize?: number;
}

function createWorker(ch: Channel): Worker {
  // je Datei ein eigener Ausdruck „new Worker(new URL(…))“ – nur so erkennt Vite die Worker beim Bauen
  if (ch === 'csv') return new Worker(new URL('./csv.worker.ts', import.meta.url), { type: 'module' });
  return new Worker(new URL('./compute.worker.ts', import.meta.url), { type: 'module' });
}

function getWorker(ch: Channel): Worker {
  let w = workers.get(ch);
  if (!w) {
    w = createWorker(ch);
    w.onmessage = (ev: MessageEvent<AnyResponse>) => {
      const m = ev.data;
      const p = pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') {
        p.progress?.(m.phase, m.fraction, 'done' in m ? { done: m.done, total: m.total } : undefined);
        return;
      }
      pending.delete(m.id);
      if (m.type === 'error') {
        const err: WorkerError = new Error(m.message);
        if ('code' in m && m.code) Object.assign(err, { code: m.code, maxIndex: m.maxIndex, paletteSize: m.paletteSize });
        p.reject(err);
      } else p.resolve(m);
    };
    w.onerror = (e) => {
      for (const [id, p] of pending) {
        if (p.channel !== ch) continue;
        pending.delete(id);
        p.reject(new Error(e.message || 'Worker-Fehler'));
      }
      workers.delete(ch);
    };
    workers.set(ch, w);
  }
  return w;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

function send<R>(channel: Channel, req: object, transfer: Transferable[], progress?: ProgressFn): Promise<R> {
  const id = nextId++;
  const w = getWorker(channel);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (r: AnyResponse) => void, reject, progress, channel });
    w.postMessage({ ...req, id }, transfer);
  });
}

export function runWorker<T extends WorkerResponse['type']>(
  channel: Channel,
  req: DistributiveOmit<WorkerRequest, 'id'>,
  transfer: Transferable[] = [],
  progress?: (phase: string, f: number) => void,
): Promise<Extract<WorkerResponse, { type: T }>> {
  return send(channel, req, transfer, progress);
}

/**
 * Koordinaten-CSV im Worker 'csv' (gestreamt): liefert den Blob (ohne BOM) und die Anzahl der Datenzeilen.
 * `progress(phase, fraction, {done, total})`: 'prepare' (Rasterzeilen) und 'rows' (geschriebene CSV-Zeilen).
 */
export function runCsvExport(req: Omit<CsvWorkerRequest, 'id'>, progress?: ProgressFn): Promise<{ blob: Blob; rows: number }> {
  return send<Extract<CsvWorkerResponse, { type: 'csv' }>>('csv', req, [], progress).then((r) => ({ blob: r.blob, rows: r.rows }));
}

/** Laufen auf diesem Kanal gerade Aufträge? */
export function channelBusy(channel: Channel): boolean {
  for (const p of pending.values()) if (p.channel === channel) return true;
  return false;
}

/** Bricht laufende Aufträge eines Kanals ab (nur dieser Worker wird beendet; andere Kanäle bleiben unberührt). */
export function cancelChannel(channel: Channel): void {
  const w = workers.get(channel);
  if (w) {
    w.terminate();
    workers.delete(channel);
  }
  for (const [id, p] of pending) {
    if (p.channel !== channel) continue;
    pending.delete(id);
    p.reject(new Error('abgebrochen'));
  }
}
