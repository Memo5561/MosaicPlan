/**
 * Nachbesserung „PDF“ (w5-fix-pdf) – Aufträge und fertige Dateien (ui/project/pdfExportStore.ts):
 *  - fertige Datei gehört zu ALLEM, was im PDF steht (Palette, Materialien, Einstellungen, Name, Foto …): ändert sich
 *    etwas davon, wird sie verworfen
 *  - Vermerk „Export läuft“ mit Kennung der Seite (Tab) und Lebenszeichen: ein zweiter Tab hält einen laufenden Export
 *    nie für einen Absturz, löscht den Vermerk nicht und senkt die Speichergrenze nicht; erst ein verwaister Vermerk
 *    (Lebenszeichen älter als 30 s bzw. Web-Sperre nicht mehr gehalten) gilt als Absturz
 *  - Dateinamen nur ASCII (safeFileName)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearInFlight, PDF_BUDGET_KEY, PDF_INFLIGHT_BEAT_MS, PDF_INFLIGHT_KEY, PDF_INFLIGHT_STALE_MS, type InFlightInfo } from '../src/core/pdfExportPlan';

const h = vi.hoisted(() => ({
  downloadBlob: vi.fn(async (_blob: Blob, name: string, _opts?: { announce?: boolean }) => ({ kind: 'download' as const, name })),
  announceSave: vi.fn(),
  cancelChannel: vi.fn(),
}));
vi.mock('../src/ui/components', async (orig) => ({ ...(await orig<typeof import('../src/ui/components')>()), downloadBlob: h.downloadBlob }));
vi.mock('../src/ui/SaveResultNote', () => ({ announceSave: h.announceSave }));
vi.mock('../src/platform', () => ({ isNative: () => false, saveNative: vi.fn() }));
vi.mock('../src/workers/client', () => ({ cancelChannel: h.cancelChannel }));

import { safeFileName } from '../src/ui/components';
import { crashNotice, detectCrashedExport, PDF_LOCK_NAME, pdfFileSig, pdfJobState, pruneFiles, resetPdfJobsForTest, runPdfJob, subscribePdfJobs, TAB_ID, type PdfSigInput } from '../src/ui/project/pdfExportStore';

const MB = 1024 * 1024;
const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
const info = (over: Partial<InFlightInfo> = {}): InFlightInfo => ({ projectId: 'p1', projectName: 'Test', sections: 4, stones: 1000, bytes: 20 * MB, budgetBytes: 100 * MB, at: 1, ...over });
const pdf = (n = 8) => new Uint8Array(n).buffer;
const marker = () => JSON.parse(store.get(PDF_INFLIGHT_KEY) ?? 'null') as InFlightInfo | null;

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', fakeStorage);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${Math.random()}`);
  resetPdfJobsForTest();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ================================================================ 1. fertige Datei veraltet
describe('fertige Datei gehört zu allem, was im PDF steht', () => {
  const sigIn: PdfSigInput = {
    optsKey: '{"format":"a4"}',
    version: 3,
    mosaicRev: 'r1',
    gridIds: [1, 2],
    lang: 'de',
    photoReplaced: false,
    original: '1800x1200',
    adjust: { rotate: 0, brightness: 0 },
    palette: [{ hex: '#112233', name: 'Blau' }],
    materials: [{ id: 'm1', price: 2 }],
    settings: { reservePct: 10, groutHex: '#cccccc' },
    projectName: 'Katze',
    parts: 0,
  };
  it('jede Änderung von Palette, Material, Einstellungen, Name, Foto, Raster, Sprache oder Aufteilung ergibt eine andere Kennung', () => {
    const a = pdfFileSig(sigIn);
    expect(pdfFileSig({ ...sigIn })).toBe(a);
    const changes: Partial<PdfSigInput>[] = [
      { palette: [{ hex: '#FF00FF', name: 'Blau' }] },
      { materials: [{ id: 'm1', price: 3 }] },
      { settings: { reservePct: 15, groutHex: '#cccccc' } },
      { settings: { reservePct: 10, groutHex: '#000000' } },
      { projectName: 'Hund' },
      { adjust: { rotate: 90, brightness: 0 } },
      { original: '' },
      { photoReplaced: true },
      { gridIds: [3, 2] },
      { version: 4 },
      { mosaicRev: 'r2' },
      { lang: 'en' },
      { optsKey: '{"format":"a3"}' },
      { parts: [4, 3, 2] },
    ];
    for (const c of changes) expect(pdfFileSig({ ...sigIn, ...c }), JSON.stringify(c)).not.toBe(a);
  });
  it('pruneFiles verwirft die Datei nach einer Palettenänderung (Adresse freigegeben)', async () => {
    const before = pdfFileSig(sigIn);
    await runPdfJob({ projectId: 'p1', key: 'single', name: 'a.pdf', sig: before, ids: null, inFlight: info(), produce: async () => pdf() });
    expect(pdfJobState('p1').files).toHaveLength(1);
    pruneFiles('p1', before);
    expect(pdfJobState('p1').files).toHaveLength(1);
    pruneFiles('p1', pdfFileSig({ ...sigIn, palette: [{ hex: '#FF00FF', name: 'Blau' }] }));
    expect(pdfJobState('p1').files).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});

// ================================================================ 2. zwei Tabs
describe('Vermerk „Export läuft“ mit Kennung und Lebenszeichen', () => {
  it('der Export trägt Kennung dieser Seite und erneuert sein Lebenszeichen; danach gelöscht', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(1_000_000);
    let finish: (b: ArrayBuffer) => void = () => {};
    const p = runPdfJob({ projectId: 'p1', key: 'single', name: 'a.pdf', sig: 's', ids: null, inFlight: info({ at: 1_000_000 }), produce: () => new Promise<ArrayBuffer>((res) => (finish = res)) });
    await Promise.resolve();
    expect(marker()).toMatchObject({ owner: TAB_ID, beat: 1_000_000 });
    vi.advanceTimersByTime(PDF_INFLIGHT_BEAT_MS * 3);
    expect(marker()?.beat).toBe(1_000_000 + PDF_INFLIGHT_BEAT_MS * 3);
    finish(pdf());
    await p;
    expect(store.has(PDF_INFLIGHT_KEY)).toBe(false);
  });

  it('Vermerk eines anderen Tabs mit frischem Lebenszeichen: kein Absturz, Vermerk und Grenze bleiben; verwaist: Absturz', () => {
    const now = 5_000_000;
    store.set(PDF_INFLIGHT_KEY, JSON.stringify(info({ owner: 'anderer-tab', at: now - 120_000, beat: now - 4_000, bytes: 60 * MB })));
    expect(detectCrashedExport(100 * MB, now)).toBeNull();
    expect(crashNotice()).toBeNull();
    expect(store.has(PDF_INFLIGHT_KEY)).toBe(true);
    expect(store.has(PDF_BUDGET_KEY)).toBe(false);
    // später erneut gefragt: Lebenszeichen inzwischen älter als 30 s → der andere Tab ist weg
    const c = detectCrashedExport(100 * MB, now - 4_000 + PDF_INFLIGHT_STALE_MS + 1);
    expect(c).toMatchObject({ info: { owner: 'anderer-tab' }, loweredToBytes: 30 * MB });
    expect(store.has(PDF_INFLIGHT_KEY)).toBe(false);
    expect(Number(store.get(PDF_BUDGET_KEY))).toBe(30);
  });

  it('der eigene Abschluss löscht nie den Vermerk eines anderen Tabs', () => {
    store.set(PDF_INFLIGHT_KEY, JSON.stringify(info({ owner: 'anderer-tab', beat: 10 })));
    clearInFlight(fakeStorage, TAB_ID);
    expect(store.has(PDF_INFLIGHT_KEY)).toBe(true);
    clearInFlight(fakeStorage, 'anderer-tab');
    expect(store.has(PDF_INFLIGHT_KEY)).toBe(false);
  });

  it('Web-Sperre gehalten: kein Absturz – auch wenn das Lebenszeichen alt ist (gedrosselter Hintergrund-Tab)', async () => {
    let held = true;
    vi.stubGlobal('navigator', { locks: { request: vi.fn(async () => undefined), query: vi.fn(async () => ({ held: held ? [{ name: PDF_LOCK_NAME }] : [] })) } });
    const now = 9_000_000;
    store.set(PDF_INFLIGHT_KEY, JSON.stringify(info({ owner: 'anderer-tab', at: now - 600_000, beat: now - 300_000, bytes: 60 * MB })));
    const seen = vi.fn();
    const stop = subscribePdfJobs(seen);
    expect(detectCrashedExport(100 * MB, now)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(crashNotice()).toBeNull();
    expect(store.has(PDF_INFLIGHT_KEY)).toBe(true);
    expect(store.has(PDF_BUDGET_KEY)).toBe(false);
    // Sperre freigegeben (Tab abgestürzt): beim nächsten Prüfen Absturz, gemeldet über subscribePdfJobs
    held = false;
    expect(detectCrashedExport(100 * MB, now + 10_000)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(crashNotice()).toMatchObject({ loweredToBytes: 30 * MB });
    expect(seen).toHaveBeenCalled();
    expect(store.has(PDF_INFLIGHT_KEY)).toBe(false);
    stop();
  });

  it('Web-Sperre frei, aber Vermerk ganz frisch (Sperre wird gerade angefordert): noch kein Absturz', async () => {
    vi.stubGlobal('navigator', { locks: { request: vi.fn(async () => undefined), query: vi.fn(async () => ({ held: [] })) } });
    const now = 9_000_000;
    store.set(PDF_INFLIGHT_KEY, JSON.stringify(info({ owner: 'anderer-tab', at: now - 500, beat: now - 500 })));
    expect(detectCrashedExport(100 * MB, now)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(crashNotice()).toBeNull();
    expect(store.has(PDF_INFLIGHT_KEY)).toBe(true);
  });

  it('der Export hält die Web-Sperre und gibt sie am Ende frei', async () => {
    let release: Promise<void> | undefined;
    const request = vi.fn((_name: string, _o: unknown, cb: (lock: unknown) => Promise<void> | void) => {
      const r = cb({ name: PDF_LOCK_NAME });
      release = r instanceof Promise ? r : undefined;
      return Promise.resolve();
    });
    vi.stubGlobal('navigator', { locks: { request, query: vi.fn(async () => ({ held: [] })) } });
    await runPdfJob({ projectId: 'p1', key: 'single', name: 'a.pdf', sig: 's', ids: null, inFlight: info(), produce: async () => pdf() });
    expect(request).toHaveBeenCalledWith(PDF_LOCK_NAME, { ifAvailable: true }, expect.any(Function));
    expect(release).toBeInstanceOf(Promise);
    await expect(release).resolves.toBeUndefined();
  });
});

// ================================================================ 6. Dateinamen
describe('safeFileName: nur ASCII', () => {
  it('Umlaute, ß und türkische Buchstaben umschrieben, Akzente entfernt', () => {
    expect(safeFileName('Größe Übung')).toBe('Groesse_Uebung');
    expect(safeFileName('Çiçek Şişli Ağaç ılık İstanbul')).toBe('Cicek_Sisli_Agac_ilik_Istanbul');
    expect(safeFileName('Café Noël')).toBe('Cafe_Noel');
    expect(safeFileName('Test: Menschenporträt')).toBe('Test_Menschenportraet');
    expect(safeFileName('kısım')).toBe('kisim');
    expect(safeFileName('★★★')).toBe('mosaicplan');
    expect(safeFileName('Katze 2026-11')).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
