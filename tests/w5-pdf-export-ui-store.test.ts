/**
 * Paket w5-pdf-export-ui – Aufträge des PDF-Exports (ui/project/pdfExportStore.ts):
 *  - höchstens ein Export; Vermerk „Export läuft“ wird vor dem Auftrag gesetzt und danach immer gelöscht
 *    (Erfolg, Fehler, Abbruch)
 *  - Speichern wird abgewartet; die fertige Datei ersetzt eine frühere mit demselben Schlüssel, deren Adresse wird
 *    freigegeben; Dateien zu anderen Optionen werden verworfen
 *  - „Abbrechen“ beendet den PDF-Worker; kein Fehler, keine Datei
 *  - stehen gebliebener Vermerk: Hinweis, Speichergrenze gesenkt (nur wenn der Export unter der Grenze lag)
 *  - Ansicht geschlossen: Ergebnis wird app-weit gemeldet
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDF_BUDGET_KEY, PDF_INFLIGHT_KEY, type InFlightInfo } from '../src/core/pdfExportPlan';

const h = vi.hoisted(() => ({
  downloadBlob: vi.fn(async (_blob: Blob, name: string, _opts?: { announce?: boolean }) => ({ kind: 'download' as const, name })),
  announceSave: vi.fn(),
  cancelChannel: vi.fn(),
  native: false,
}));
vi.mock('../src/ui/components', () => ({ downloadBlob: h.downloadBlob }));
vi.mock('../src/ui/SaveResultNote', () => ({ announceSave: h.announceSave }));
vi.mock('../src/platform', () => ({ isNative: () => h.native }));
vi.mock('../src/workers/client', () => ({ cancelChannel: h.cancelChannel }));

import {
  CANCELLED,
  cancelPdfJob,
  clearPdfMessages,
  crashNotice,
  detectCrashedExport,
  dismissCrashNotice,
  dropOtherProjects,
  pdfJobRunning,
  pdfJobState,
  pruneFiles,
  resetPdfJobsForTest,
  runPdfJob,
  subscribePdfJobs,
  watchPdfJobs,
} from '../src/ui/project/pdfExportStore';

const MB = 1024 * 1024;
const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
const info = (over: Partial<InFlightInfo> = {}): InFlightInfo => ({ projectId: 'p1', projectName: 'Test', sections: 4, stones: 1000, bytes: 20 * MB, budgetBytes: 100 * MB, at: 1, ...over });
const pdf = (n = 8) => new Uint8Array(n).buffer;
const job = (over: Partial<Parameters<typeof runPdfJob>[0]> = {}) => ({ projectId: 'p1', key: 'single', name: 'a.pdf', sig: 's1', ids: null, inFlight: info(), produce: async () => pdf(), ...over });

let revoked: string[] = [];
beforeEach(() => {
  store.clear();
  revoked = [];
  h.native = false;
  h.downloadBlob.mockClear();
  h.announceSave.mockClear();
  h.cancelChannel.mockClear();
  vi.stubGlobal('localStorage', fakeStorage);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => void revoked.push(u));
  resetPdfJobsForTest();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runPdfJob', () => {
  it('Erfolg: Vermerk während des Auftrags gesetzt und danach gelöscht; Datei mit Größe, Adresse und Speicherergebnis', async () => {
    const seen: (string | null)[] = [];
    const phases: string[] = [];
    const unsub = subscribePdfJobs(() => {
      const b = pdfJobState('p1').busy;
      if (b) phases.push(`${b.label}:${b.f}`);
    });
    const stop = watchPdfJobs('p1');
    const ok = await runPdfJob(
      job({
        ids: ['A1', 'A2'],
        produce: async (progress) => {
          seen.push(store.get(PDF_INFLIGHT_KEY) ?? null);
          expect(pdfJobRunning()).toBe('p1');
          progress(0.5, 'sheets');
          return pdf(1234);
        },
      }),
    );
    unsub();
    stop();
    expect(ok).toBe(true);
    expect(JSON.parse(seen[0] as string)).toMatchObject({ projectId: 'p1', bytes: 20 * MB });
    expect(store.has(PDF_INFLIGHT_KEY)).toBe(false);
    expect(phases).toContain('sheets:0.5');
    const st = pdfJobState('p1');
    expect(st.busy).toBeNull();
    expect(st.error).toBeNull();
    expect(st.files).toHaveLength(1);
    expect(st.files[0]).toMatchObject({ key: 'single', name: 'a.pdf', size: 1234, sig: 's1', ids: ['A1', 'A2'], save: { kind: 'download', name: 'a.pdf' } });
    expect(st.files[0].url).toMatch(/^blob:/);
    // Speichern wurde abgewartet, ohne app-weite Meldung (die Ansicht zeigt das Ergebnis selbst)
    expect(h.downloadBlob).toHaveBeenCalledTimes(1);
    expect(h.downloadBlob.mock.calls[0][2]).toEqual({ announce: false });
    expect(h.announceSave).not.toHaveBeenCalled();
    expect(pdfJobRunning()).toBeNull();
  });

  it('gleicher Schlüssel: frühere Datei ersetzt, ihre Adresse freigegeben; anderer Schlüssel bleibt', async () => {
    await runPdfJob(job({ key: 'part-0', name: 'a.pdf' }));
    await runPdfJob(job({ key: 'part-1', name: 'b.pdf' }));
    const first = pdfJobState('p1').files.find((f) => f.key === 'part-0')!.url!;
    await runPdfJob(job({ key: 'part-0', name: 'a2.pdf' }));
    const files = pdfJobState('p1').files;
    expect(files.map((f) => `${f.key}:${f.name}`).sort()).toEqual(['part-0:a2.pdf', 'part-1:b.pdf']);
    expect(revoked).toEqual([first]);
  });

  it('pruneFiles: Dateien zu anderen Optionen verworfen und freigegeben; dropOtherProjects räumt fremde Projekte', async () => {
    await runPdfJob(job({ key: 'single', sig: 'alt' }));
    await runPdfJob(job({ key: 'part-0', sig: 'neu' }));
    await runPdfJob(job({ projectId: 'p2', sig: 'x' }));
    const old = pdfJobState('p1').files.find((f) => f.sig === 'alt')!.url!;
    pruneFiles('p1', 'neu');
    expect(pdfJobState('p1').files.map((f) => f.key)).toEqual(['part-0']);
    expect(revoked).toEqual([old]);
    const other = pdfJobState('p2').files[0].url!;
    dropOtherProjects('p1');
    expect(pdfJobState('p2').files).toEqual([]);
    expect(revoked).toContain(other);
    expect(pdfJobState('p1').files).toHaveLength(1);
  });

  it('Fehler: Meldung, keine Datei, Vermerk gelöscht', async () => {
    await runPdfJob(
      job({
        produce: async () => {
          throw new Error('PDF nicht erstellt: Farbzuordnung ungültig');
        },
      }),
    );
    const st = pdfJobState('p1');
    expect(st.error).toBe('PDF nicht erstellt: Farbzuordnung ungültig');
    expect(st.cancelled).toBe(false);
    expect(st.files).toEqual([]);
    expect(st.busy).toBeNull();
    expect(store.has(PDF_INFLIGHT_KEY)).toBe(false);
    expect(h.downloadBlob).not.toHaveBeenCalled();
    clearPdfMessages('p1');
    expect(pdfJobState('p1').error).toBeNull();
  });

  it('Abbrechen: PDF-Worker beendet, „abgebrochen“ statt Fehler, keine Datei, Vermerk gelöscht', async () => {
    let reject: (e: Error) => void = () => {};
    h.cancelChannel.mockImplementation(() => reject(new Error(CANCELLED)));
    const p = runPdfJob(job({ produce: () => new Promise<ArrayBuffer>((_, rej) => (reject = rej)) }));
    await Promise.resolve();
    expect(pdfJobState('p1').busy).not.toBeNull();
    cancelPdfJob();
    await p;
    expect(h.cancelChannel).toHaveBeenCalledWith('pdf');
    const st = pdfJobState('p1');
    expect(st).toMatchObject({ busy: null, error: null, cancelled: true, files: [] });
    expect(store.has(PDF_INFLIGHT_KEY)).toBe(false);
  });

  it('Abbrechen während der Bildvorbereitung (noch kein Worker): Auftrag endet als abgebrochen', async () => {
    let cont: () => void = () => {};
    const p = runPdfJob(
      job({
        produce: async (_progress, cancelled) => {
          await new Promise<void>((res) => (cont = res));
          if (cancelled()) throw new Error(CANCELLED);
          return pdf();
        },
      }),
    );
    await Promise.resolve();
    cancelPdfJob();
    cont();
    await p;
    expect(pdfJobState('p1')).toMatchObject({ cancelled: true, files: [] });
    // ohne laufenden Auftrag tut „Abbrechen“ nichts (ein CSV-Export auf demselben Kanal bleibt ungestört)
    h.cancelChannel.mockClear();
    cancelPdfJob();
    expect(h.cancelChannel).not.toHaveBeenCalled();
  });

  it('höchstens ein Export gleichzeitig – auch projektübergreifend', async () => {
    let finish: (b: ArrayBuffer) => void = () => {};
    const first = runPdfJob(job({ produce: () => new Promise<ArrayBuffer>((res) => (finish = res)) }));
    await Promise.resolve();
    expect(await runPdfJob(job({ key: 'part-1' }))).toBe(false);
    expect(await runPdfJob(job({ projectId: 'p2' }))).toBe(false);
    finish(pdf());
    expect(await first).toBe(true);
    expect(pdfJobState('p1').files).toHaveLength(1);
    expect(pdfJobState('p2').files).toEqual([]);
  });

  it('Ansicht geschlossen: Ergebnis app-weit gemeldet; offen: nicht', async () => {
    await runPdfJob(job());
    expect(h.announceSave).toHaveBeenCalledTimes(1);
    const stop = watchPdfJobs('p1');
    await runPdfJob(job({ key: 'part-0' }));
    expect(h.announceSave).toHaveBeenCalledTimes(1);
    stop();
  });

  it('APK: keine Adresse im Browser (die Datei liegt im Gerätespeicher)', async () => {
    h.native = true;
    await runPdfJob(job());
    expect(pdfJobState('p1').files[0].url).toBeNull();
  });
});

describe('nicht beendeter Export', () => {
  it('stehen gebliebener Vermerk: Hinweis, Vermerk gelöscht, Grenze auf die Hälfte des Richtwerts gesenkt', () => {
    store.set(PDF_INFLIGHT_KEY, JSON.stringify(info({ bytes: 60 * MB, budgetBytes: 100 * MB })));
    const c = detectCrashedExport(100 * MB);
    expect(c).toMatchObject({ info: { projectId: 'p1', bytes: 60 * MB }, loweredToBytes: 30 * MB });
    expect(store.has(PDF_INFLIGHT_KEY)).toBe(false);
    expect(Number(store.get(PDF_BUDGET_KEY))).toBe(30);
    // bleibt bis zum Schließen; wird je Sitzung nur einmal geprüft
    expect(crashNotice()).toBe(c);
    expect(detectCrashedExport(100 * MB)).toBe(c);
    dismissCrashNotice();
    expect(crashNotice()).toBeNull();
  });
  it('Export lag über der Grenze (bewusst als eine Datei): Hinweis, aber Grenze unverändert', () => {
    store.set(PDF_INFLIGHT_KEY, JSON.stringify(info({ bytes: 900 * MB, budgetBytes: 100 * MB })));
    const c = detectCrashedExport(100 * MB);
    expect(c?.loweredToBytes).toBeNull();
    expect(store.has(PDF_BUDGET_KEY)).toBe(false);
  });
  it('kein Vermerk: kein Hinweis', () => {
    expect(detectCrashedExport(100 * MB)).toBeNull();
    expect(crashNotice()).toBeNull();
  });
  it('während ein Export läuft, ist der Vermerk kein Absturz', async () => {
    let finish: (b: ArrayBuffer) => void = () => {};
    const p = runPdfJob(job({ produce: () => new Promise<ArrayBuffer>((res) => (finish = res)) }));
    await Promise.resolve();
    expect(store.has(PDF_INFLIGHT_KEY)).toBe(true);
    expect(detectCrashedExport(100 * MB)).toBeNull();
    expect(store.has(PDF_INFLIGHT_KEY)).toBe(true);
    finish(pdf());
    await p;
    expect(detectCrashedExport(100 * MB)).toBeNull();
  });
});
