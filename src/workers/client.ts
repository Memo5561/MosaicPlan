import type { WorkerRequest, WorkerResponse } from './protocol';

/**
 * Je Kanal ein eigener Worker. 'preview' rechnet die Live-Vorschau der Schritte 2–7 (nie gespeichert):
 * cancelChannel('preview') beendet nur diesen Worker – eine laufende Berechnung ('compute') oder ein
 * PDF ('pdf') laufen ungestört weiter (und umgekehrt).
 */
export type Channel = 'compute' | 'stats' | 'pdf' | 'preview';

const workers = new Map<Channel, Worker>();
const pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void; progress?: (phase: string, f: number) => void; channel: Channel }>();
let nextId = 1;

function getWorker(ch: Channel): Worker {
  let w = workers.get(ch);
  if (!w) {
    w = new Worker(new URL('./compute.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const m = ev.data;
      const p = pending.get(m.id);
      if (!p) return;
      if (m.type === 'progress') {
        p.progress?.(m.phase, m.fraction);
        return;
      }
      pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
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

export function runWorker<T extends WorkerResponse['type']>(
  channel: Channel,
  req: DistributiveOmit<WorkerRequest, 'id'>,
  transfer: Transferable[] = [],
  progress?: (phase: string, f: number) => void,
): Promise<Extract<WorkerResponse, { type: T }>> {
  const id = nextId++;
  const w = getWorker(channel);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (r: WorkerResponse) => void, reject, progress, channel });
    w.postMessage({ ...req, id } as WorkerRequest, transfer);
  });
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
