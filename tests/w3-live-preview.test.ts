/**
 * Paket w3-live-preview: Live-Vorschau, „Vorschau übernehmen“ ohne zweite Berechnung und Berechnungen,
 * die das Verlassen des Projekts überstehen.
 *
 *  - Auftragsregister (src/workers/jobs.ts): je Projekt ein Auftrag, app-weit eine Berechnung, Abbrechen,
 *    Fortschritt, Anmelden der geöffneten Ansicht, Bearbeitungszähler – und es funktioniert nach Abbruch/Fehler
 *    weiter (wie nach einem Neuladen: leer, nichts „läuft noch“).
 *  - Automatik der Vorschau (previewPolicy.ts): Grenzen, Richtwert der Dauer, Entprellen.
 *  - describeComputeInputs: Fingerabdruck aller Eingaben – gleiche Eingaben ⇒ gleicher Fingerabdruck,
 *    jede Eingabe des Workers ändert ihn, reine Darstellungswerte (Fugenfarbe, Oberfläche, Name) nicht.
 *  - Vorschau = Übernommenes: Für die vier Testprojekte liefert der Rechenweg der Vorschau und der von
 *    „Berechnen“ Byte für Byte dasselbe gepackte Raster (packMosaic) und dieselben Ergebnisfelder.
 */
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { applyAdjustments } from '../src/core/imageOps';
import { computeLayout } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { packMosaic } from '../src/core/serialize';
import { DEFAULT_ADJUST, DEFAULT_SETTINGS, DEFAULT_SHAPES, type Material, type PaletteColor } from '../src/core/types';
import type { ProjectRecord } from '../src/storage/db';
import {
  computeOverall,
  estimatePreviewMs,
  isSlowDevice,
  isTypingTarget,
  previewDebounceMs,
  previewPolicy,
  PREVIEW_AUTO_CELLS,
  PREVIEW_AUTO_CELLS_SLOW,
  PREVIEW_AUTO_MAX_MS,
} from '../src/ui/project/previewPolicy';
import { commitFieldsOf, computeKey, describeComputeInputs, rawCacheKey, type ComputeEnv, type ComputeInputs } from '../src/ui/project/useProject';
import { shortHash } from '../src/ui/project/LivePreview';
import {
  anyJob,
  attachProject,
  cancelJob,
  editCount,
  JobBusyError,
  jobFor,
  noteEdit,
  projectHandler,
  renameJob,
  resetJobsForTest,
  runningJob,
  startJob,
  subscribeJobs,
} from '../src/workers/jobs';
import type { RawImage } from '../src/workers/protocol';
import { GOLDEN_SAMPLES } from './w1-mosaic-core.fixtures';
import { loadPng, prepareFor } from './helpers';

afterEach(() => resetJobsForTest());

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Auftragsregister (jobs.ts)', () => {
  it('Auftrag ist während der Laufzeit sichtbar, meldet Fortschritt und verschwindet danach', async () => {
    const events: string[] = [];
    const unsub = subscribeJobs(() => events.push(jobFor('A')?.progress.phase ?? 'none'));
    let report!: (p: { phase: string; fraction: number }) => void;
    let finish!: (v: string) => void;
    const h = startJob<string>({
      projectId: 'A',
      projectName: 'Katze',
      exclusive: true,
      cancel: () => {},
      run: (ctx) => {
        report = ctx.report;
        return new Promise<string>((res) => (finish = res));
      },
    });
    expect(jobFor('A')?.projectName).toBe('Katze');
    expect(jobFor('A')?.progress).toEqual({ phase: 'prepare', fraction: 0 });
    expect(runningJob()).not.toBeNull();
    expect(runningJob('A')).toBeNull(); // „anderes Projekt“ aus Sicht von A: keins
    expect(runningJob('B')?.projectId).toBe('A');
    await tick();
    report({ phase: 'analyze', fraction: 0.5 });
    expect(jobFor('A')?.progress).toEqual({ phase: 'analyze', fraction: 0.5 });
    report({ phase: 'assign', fraction: 7 }); // auf 0…1 begrenzt
    expect(jobFor('A')?.progress.fraction).toBe(1);
    renameJob('A', 'Kater');
    expect(jobFor('A')?.projectName).toBe('Kater');
    finish('ok');
    await expect(h.promise).resolves.toBe('ok');
    expect(jobFor('A')).toBeNull();
    expect(anyJob()).toBe(false);
    expect(events).toContain('analyze');
    expect(events[events.length - 1]).toBe('none');
    unsub();
  });

  it('app-weit nur eine Berechnung; je Projekt nur ein Auftrag; Übernehmen (nicht exklusiv) ist erlaubt', async () => {
    let finish!: () => void;
    const a = startJob<void>({ projectId: 'A', projectName: 'A', exclusive: true, cancel: () => {}, run: () => new Promise<void>((r) => (finish = r)) });
    let err: unknown = null;
    try {
      startJob({ projectId: 'B', projectName: 'B', exclusive: true, cancel: () => {}, run: async () => {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JobBusyError);
    expect((err as JobBusyError).running.projectId).toBe('A');
    expect(() => startJob({ projectId: 'A', projectName: 'A', exclusive: false, cancel: () => {}, run: async () => {} })).toThrow(JobBusyError);
    // Übernehmen einer fertigen Vorschau braucht keinen Worker
    const b = startJob({ projectId: 'B', projectName: 'B', exclusive: false, phase: 'commit', cancel: () => {}, run: async () => 'committed' });
    expect(jobFor('B')?.progress.phase).toBe('commit');
    await expect(b.promise).resolves.toBe('committed');
    finish();
    await a.promise;
    expect(anyJob()).toBe(false);
  });

  it('Abbrechen beendet den Auftrag; danach (wie nach einem Neuladen) startet ein neuer normal', async () => {
    let cancelled = 0;
    let rejectRun!: (e: Error) => void;
    let seenCancelled = false;
    const h = startJob<void>({
      projectId: 'A',
      projectName: 'A',
      exclusive: true,
      cancel: () => {
        cancelled++;
        rejectRun(new Error('abgebrochen'));
      },
      run: (ctx) =>
        new Promise<void>((_, rej) => {
          rejectRun = (e) => {
            seenCancelled = ctx.cancelled;
            rej(e);
          };
        }),
    });
    await tick();
    expect(cancelJob('B')).toBe(false);
    expect(cancelJob('A')).toBe(true);
    await expect(h.promise).rejects.toThrow('abgebrochen');
    expect(cancelled).toBe(1);
    expect(seenCancelled).toBe(true);
    expect(jobFor('A')).toBeNull();
    // Fehler im Auftrag räumt ebenfalls auf
    const f = startJob({ projectId: 'A', projectName: 'A', exclusive: true, cancel: () => {}, run: async () => {
      throw new Error('kaputt');
    } });
    await expect(f.promise).rejects.toThrow('kaputt');
    expect(anyJob()).toBe(false);
    const g = startJob({ projectId: 'C', projectName: 'C', exclusive: true, cancel: () => {}, run: async () => 42 });
    await expect(g.promise).resolves.toBe(42);
  });

  it('angemeldete Ansicht: nur die eigene Abmeldung entfernt sie; Bearbeitungszähler je Projekt', () => {
    const h1 = { id: 1 };
    const h2 = { id: 2 };
    const off1 = attachProject('A', h1);
    const off2 = attachProject('A', h2); // neue Ansicht (z. B. Projekt erneut geöffnet)
    off1(); // alte Ansicht schließt später – darf die neue nicht abmelden
    expect(projectHandler<typeof h2>('A')).toBe(h2);
    off2();
    expect(projectHandler('A')).toBeUndefined();
    expect(editCount('A')).toBe(0);
    noteEdit('A');
    noteEdit('A');
    noteEdit('B');
    expect(editCount('A')).toBe(2);
    expect(editCount('B')).toBe(1);
  });
});

describe('Automatik der Vorschau (previewPolicy.ts)', () => {
  it('rechnet von selbst nur bei kleinen Mosaiken und schnellen Durchläufen', () => {
    expect(previewPolicy({ cells: PREVIEW_AUTO_CELLS, slow: false, lastMs: null })).toEqual({ auto: true, reason: null, limit: PREVIEW_AUTO_CELLS });
    expect(previewPolicy({ cells: PREVIEW_AUTO_CELLS + 1, slow: false, lastMs: null }).reason).toBe('cells');
    expect(previewPolicy({ cells: PREVIEW_AUTO_CELLS_SLOW + 1, slow: true, lastMs: null }).reason).toBe('cells');
    expect(previewPolicy({ cells: PREVIEW_AUTO_CELLS_SLOW, slow: true, lastMs: 200 }).auto).toBe(true);
    expect(previewPolicy({ cells: 1000, slow: false, lastMs: PREVIEW_AUTO_MAX_MS }).reason).toBe('slow');
    expect(previewPolicy({ cells: 1000, slow: false, lastMs: PREVIEW_AUTO_MAX_MS - 1 }).auto).toBe(true);
  });

  it('langsames Gerät: ≤ 4 Kerne oder Touch', () => {
    expect(isSlowDevice(4, false)).toBe(true);
    expect(isSlowDevice(8, false)).toBe(false);
    expect(isSlowDevice(16, true)).toBe(true);
    expect(isSlowDevice(undefined, false)).toBe(false);
  });

  it('Richtwert: aus der letzten Messung linear, sonst aus der Desktop-Messung (Mischen bis ×3, langsam ×2)', () => {
    expect(estimatePreviewMs(120_000, { ms: 600, cells: 30_000 }, false)).toBe(2400);
    expect(estimatePreviewMs(10, { ms: 600, cells: 30_000 }, false)).toBe(200);
    expect(estimatePreviewMs(100_000, null, false)).toBe(550);
    expect(estimatePreviewMs(100_000, null, true)).toBe(1100);
    expect(estimatePreviewMs(100_000, null, false, 1)).toBe(1150);
  });

  it('Entprellen: länger, solange in ein Zahlenfeld getippt wird', () => {
    expect(previewDebounceMs(false)).toBe(500);
    expect(previewDebounceMs(true)).toBe(800);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTypingTarget({ tagName: 'input' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'range' })).toBe(false);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('Gesamtfortschritt inkl. Phase „Ergebnis speichern“', () => {
    expect(computeOverall(null)).toBe(0);
    expect(computeOverall({ phase: 'prepare', fraction: 0 })).toBe(0);
    expect(computeOverall({ phase: 'commit', fraction: 1 })).toBe(1);
    expect(computeOverall({ phase: 'assign', fraction: 1 })).toBeCloseTo(6 / 7);
    expect(computeOverall({ phase: 'unbekannt', fraction: 0.5 })).toBeCloseTo(0.5 / 7);
  });
});

// ---------- Eingaben und Fingerabdruck

function rec(patch: Partial<ProjectRecord['settings']> = {}, extra: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    meta: { id: 'p', name: 'Test', createdAt: 0, updatedAt: 0, computed: false },
    settings: { ...DEFAULT_SETTINGS, shapes: { ...DEFAULT_SHAPES }, materialIds: [], ...patch },
    adjust: { ...DEFAULT_ADJUST },
    regions: [],
    palette: [],
    imageRev: 'img-1',
    ...extra,
  };
}

const ENV: ComputeEnv = { bitmap: null, bw: 1200, bh: 1600, srcW: 1200, srcH: 1600, reduced: false, hasOriginal: true, materials: [], lang: 'de' };

function sig(r: ProjectRecord, env: Partial<ComputeEnv> = {}): string {
  const d = describeComputeInputs(r, { ...ENV, ...env });
  if (!d.ok) throw new Error(d.error);
  return d.sig;
}

const MATS: Material[] = [
  { id: 'm1', type: 'glass', manufacturer: 'X', product: 'P', colorNumber: '1', colorName: 'Rot', hex: '#cc2222', lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 0, packageSize: '', piecesPerPack: 0 },
  { id: 'm2', type: 'glass', manufacturer: 'X', product: 'P', colorNumber: '2', colorName: 'Blau', hex: '#2244cc', lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 0, packageSize: '', piecesPerPack: 0 },
];

describe('describeComputeInputs: Fingerabdruck aller Eingaben', () => {
  it('gleiche Eingaben ⇒ gleicher Fingerabdruck; Darstellungswerte und Name zählen nicht', () => {
    const r = rec();
    expect(sig(r)).toBe(sig(rec()));
    expect(sig(rec({ groutHex: '#000000' }))).toBe(sig(r));
    expect(sig(rec({ surface: 'ceramic' }))).toBe(sig(r));
    expect(sig(rec({ reservePct: 20, groutDepthMm: 5, sectionCols: 9 }))).toBe(sig(r));
    expect(sig({ ...r, meta: { ...r.meta, name: 'Anders' } })).toBe(sig(r));
  });

  it('jede Eingabe des Workers ändert den Fingerabdruck', () => {
    const base = sig(rec());
    const changed = [
      sig(rec({ tileW: 4, tileH: 4 })),
      sig(rec({ joint: 2 })),
      sig(rec({ widthMm: 310 })),
      sig(rec({ colorCount: 16 })),
      sig(rec({ dither: DEFAULT_SETTINGS.dither === 0.25 ? 0.75 : 0.25 })), // nicht der Standardwert (w3-colour-quality: 0,5)
      sig(rec({ deltaE: '76' })),
      sig(rec({ shapes: { ...DEFAULT_SHAPES, diagonal: !DEFAULT_SHAPES.diagonal } })),
      sig(rec({}, { adjust: { ...DEFAULT_ADJUST, brightness: 10 } })),
      sig(rec({}, { regions: [{ id: 'f', type: 'face', shape: 'ellipse', x: 0.2, y: 0.2, w: 0.3, h: 0.3 }] })),
      sig(rec({}, { imageRev: 'img-2' })),
      sig(rec(), { lang: 'en' }),
      sig(rec(), { srcW: 1201 }),
    ];
    for (const s of changed) expect(s).not.toBe(base);
    expect(new Set(changed).size).toBe(changed.length);
  });

  it('Materialien zählen nur in den Materialmodi – dort auch Farbe, Name und Bestand', () => {
    expect(sig(rec(), { materials: MATS })).toBe(sig(rec()));
    const m = rec({ paletteMode: 'materials' });
    const s0 = sig(m, { materials: MATS });
    expect(sig(m, { materials: [{ ...MATS[0], hex: '#cc2223' }, MATS[1]] })).not.toBe(s0);
    expect(sig(m, { materials: [{ ...MATS[0], stock: 100 }, MATS[1]] })).not.toBe(s0);
    expect(sig(rec({ paletteMode: 'materials', materialIds: ['m1'] }), { materials: MATS })).not.toBe(s0);
    // computeKey kennt die Materialinhalte nicht – der Fingerabdruck schon (sonst würde eine falsche Vorschau übernommen)
    expect(computeKey(m)).toBe(computeKey(m));
  });

  it('eigene Palette: Name ist Eingabe (Fingerabdruck), aber nicht Teil von computeKey', () => {
    const pal: PaletteColor[] = [
      { code: 1, hex: '#FF0000', name: 'Rot', lab: [53.24, 80.09, 67.2], userNamed: true },
      { code: 2, hex: '#0000FF', name: 'Blau', lab: [32.3, 79.19, -107.86], userNamed: true },
    ];
    const a = rec({ paletteMode: 'custom' }, { palette: pal });
    const b = rec({ paletteMode: 'custom' }, { palette: [{ ...pal[0], name: 'Kirschrot' }, pal[1]] });
    expect(computeKey(a)).toBe(computeKey(b));
    expect(sig(a)).not.toBe(sig(b));
  });

  it('Fehler statt Ausnahme: ungültiges Raster, Materialmodus ohne Materialien, leere eigene Palette', () => {
    expect(describeComputeInputs(rec({ tileW: 0 }), ENV)).toEqual({ ok: false, error: 'layout' });
    expect(describeComputeInputs(rec({ paletteMode: 'materials' }), ENV)).toEqual({ ok: false, error: 'no-materials' });
    expect(describeComputeInputs(rec({ paletteMode: 'custom' }), ENV)).toEqual({ ok: false, error: 'no-palette' });
  });

  it('Arbeitsauflösung und volles Lesen des Originals wie bei „Berechnen“', () => {
    const r = rec({ widthMm: 3000, heightMm: 4000, tileW: 2, tileH: 2, joint: 0.5 }, { adjust: { ...DEFAULT_ADJUST, crop: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 } } });
    const d = describeComputeInputs(r, { ...ENV, srcW: 8000, srcH: 6000, bw: 4000, bh: 3000, reduced: true }) as ComputeInputs;
    expect(d.ok).toBe(true);
    expect(d.cells).toBe(d.layout.cols * d.layout.rows);
    expect(d.full).toBe(true); // kleiner Zuschnitt einer verkleinerten Arbeitskopie: Original wird voll gelesen
    const d2 = describeComputeInputs(r, { ...ENV, srcW: 8000, srcH: 6000, bw: 4000, bh: 3000, reduced: true, hasOriginal: false }) as ComputeInputs;
    expect(d2.full).toBe(false);
    expect(d2.sig).not.toBe(d.sig);
  });

  it('Arbeitsbild-Zwischenspeicher: Farbregler ändern die Bildpunkte nicht, Drehen/Zuschnitt schon', () => {
    const a = describeComputeInputs(rec(), ENV) as ComputeInputs;
    const b = describeComputeInputs(rec({}, { adjust: { ...DEFAULT_ADJUST, brightness: 20, contrast: 10, saturation: -5 } }), ENV) as ComputeInputs;
    const c = describeComputeInputs(rec({}, { adjust: { ...DEFAULT_ADJUST, rotation: 90 } }), ENV) as ComputeInputs;
    // kleine Steine: mehr Rasterzellen ⇒ höhere Arbeitsauflösung; kleine Änderungen über der Mindestauflösung nicht
    const d = describeComputeInputs(rec({ tileW: 2, tileH: 2 }), ENV) as ComputeInputs;
    const e = describeComputeInputs(rec({ tileW: 7, tileH: 7 }), ENV) as ComputeInputs;
    expect(e.ws).toEqual(a.ws);
    expect(rawCacheKey(e)).toBe(rawCacheKey(a));
    expect(rawCacheKey(b)).toBe(rawCacheKey(a));
    expect(b.sig).not.toBe(a.sig);
    expect(rawCacheKey(c)).not.toBe(rawCacheKey(a));
    expect(rawCacheKey(d)).not.toBe(rawCacheKey(a)); // andere Arbeitsauflösung
  });

  it('shortHash ist stabil und unterscheidet', () => {
    expect(shortHash('abc')).toBe(shortHash('abc'));
    expect(shortHash('abc')).not.toBe(shortHash('abd'));
  });
});

// ---------- Vorschau = Übernommenes (Byte für Byte)

/**
 * Was der Worker bei {type:'compute'} tut (src/workers/compute.worker.ts, unverändert): Raster aus den
 * Rasterparametern, Bildoptimierung, computeMosaic mit den Parametern der Anfrage, packMosaic.
 */
function workerCompute(inp: ComputeInputs, image: RawImage) {
  const req = inp.request;
  const layout = computeLayout(req.layoutParams);
  const processed = applyAdjustments(image, req.adjust, req.regions);
  const res = computeMosaic(processed, { ...req.params, layout, regions: req.regions });
  return { packed: packMosaic(res.data), palette: res.palette, diagnostics: res.diagnostics, data: res.data };
}

function pngSize(file: string) {
  const png = PNG.sync.read(readFileSync(file));
  return { w: png.width, h: png.height };
}

function sampleRecord(s: (typeof GOLDEN_SAMPLES)[number], patch: Partial<ProjectRecord['settings']> = {}, extra: Partial<ProjectRecord> = {}): ProjectRecord {
  const { w, h } = pngSize(s.file);
  return rec(
    { widthMm: s.w, heightMm: Math.round((s.w / (w / h)) * 10) / 10, tileW: s.tile, tileH: s.tile, joint: s.joint, colorCount: s.colors, ...patch },
    { regions: s.regions ?? [], ...extra },
  );
}

function bytesEqual(a: ArrayBufferView, b: ArrayBufferView) {
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

describe('Vorschau = Übernommenes: gleicher Rechenweg, gleiches Ergebnis', () => {
  for (const s of GOLDEN_SAMPLES) {
    it(`${s.key}: Vorschau und „Berechnen“ liefern Byte für Byte dasselbe Raster und dieselben Ergebnisfelder`, () => {
      const r = sampleRecord(s);
      const { w, h } = pngSize(s.file);
      const inp = describeComputeInputs(r, { ...ENV, bw: w, bh: h, srcW: w, srcH: h }) as ComputeInputs;
      expect(inp.ok).toBe(true);
      // Arbeitsbild wie in der App (Zuschnitt auf das Seitenverhältnis, ~6×6 px je Zelle)
      const raw = prepareFor(loadPng(s.file), inp.layout);
      // Vorschau (Kanal 'preview') und Berechnung (Kanal 'compute') bekommen dieselbe Anfrage und dieselben Bildpunkte
      const preview = workerCompute(inp, { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data) });
      const again = describeComputeInputs(r, { ...ENV, bw: w, bh: h, srcW: w, srcH: h }) as ComputeInputs;
      expect(again.sig).toBe(inp.sig); // „Übernehmen“ erkennt die passende Vorschau
      const compute = workerCompute(again, { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data) });
      for (const k of Object.keys(preview.packed) as (keyof typeof preview.packed)[]) {
        const a = preview.packed[k];
        const b = compute.packed[k];
        if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) expect(bytesEqual(a, b), `${s.key}.${String(k)}`).toBe(true);
        else expect(a).toEqual(b);
      }
      expect(preview.palette).toEqual(compute.palette);
      expect({ ...preview.diagnostics, timeMs: 0 }).toEqual({ ...compute.diagnostics, timeMs: 0 });
      // Ergebnisfelder: Schlüssel, Palette, Foto-Identität – identisch; der Schlüssel ist der der aktuellen Einstellungen
      const f1 = commitFieldsOf({ snapshot: r, palette: preview.palette, diagnostics: preview.diagnostics }, { now: 1, rev: 'x' });
      const f2 = commitFieldsOf({ snapshot: r, palette: compute.palette, diagnostics: compute.diagnostics }, { now: 1, rev: 'x' });
      expect({ ...f1, diagnostics: undefined }).toEqual({ ...f2, diagnostics: undefined });
      expect(f1.computedWith).toBe(computeKey(r));
      expect(f1.computedImageRev).toBe(r.imageRev);
      // Summe der Stückzahlen = Geometrie: jede Rasterzelle ist belegt
      expect(preview.data.kind.length).toBe(inp.cells);
    });
  }

  it('eigene Palette: Schlüssel mit der Ergebnispalette, Eingabepalette bleibt als customInput erhalten', () => {
    const s = GOLDEN_SAMPLES[0];
    const pal: PaletteColor[] = ['#2B1B17', '#7A4B3A', '#D9A38B', '#F2D3C2', '#3A5F8F', '#9DB7D5', '#B22234', '#F5F1E8'].map((hex, i) => ({
      code: i + 1,
      hex,
      name: `F${i + 1}`,
      userNamed: true,
      lab: [0, 0, 0] as [number, number, number],
    }));
    // Lab aus HEX wie in der App
    for (const p of pal) p.lab = hexToLab(p.hex);
    const r = sampleRecord(s, { paletteMode: 'custom' }, { palette: pal });
    const { w, h } = pngSize(s.file);
    const inp = describeComputeInputs(r, { ...ENV, bw: w, bh: h, srcW: w, srcH: h }) as ComputeInputs;
    const raw = prepareFor(loadPng(s.file), inp.layout);
    const out = workerCompute(inp, { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data) });
    const f = commitFieldsOf({ snapshot: r, palette: out.palette, diagnostics: out.diagnostics }, { now: 1, rev: 'y' });
    expect(f.customInput).toBe(r.palette);
    expect(f.computedWith).toBe(computeKey({ ...r, palette: out.palette }));
    expect(out.palette.map((p) => p.code)).toEqual(pal.map((p) => p.code));
  });
});
