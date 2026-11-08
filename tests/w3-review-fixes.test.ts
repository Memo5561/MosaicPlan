/**
 * Korrekturen nach dem Review von Welle 3:
 *  - Auftragsregister: das Speichern eines Ergebnisses ist nicht abbrechbar (kein „abgebrochen“, das dann doch speichert);
 *    ein Ergebnis wird erst übernommen, wenn die (wieder) geöffnete Ansicht geladen ist (settledHandler).
 *  - Material-Fingerabdruck: Farbton/Name/Bestand der Materialien gehören zu den Eingaben – ein gespeichertes Mosaik
 *    gilt nach einer Materialänderung nicht mehr als „entspricht den aktuellen Einstellungen“.
 *  - Arbeitsbild: „Berechnen“ nimmt es aus dem Zwischenspeicher und gibt es ohne Kopie weiter.
 *  - Freiformzellen älterer/importierter Projekte mit überlappenden Teilen: gezählt, Flächen als ungültig markiert,
 *    PDF verweigert, Importzusammenfassung nennt sie.
 *  - Farbanzahl-Meldung: bei der direkten Auswahl aus dem Bestand kein „zusammengelegt“.
 *  - Fehlende Farben: nur erwähnte Materialien werden beim Import zugeordnet, nie angelegt.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { invalidFreeCells, setFreePieces, validateFreePieces } from '../src/core/edits';
import { computeLayout, sectionsFor } from '../src/core/layout';
import { linkReferencedMaterials, diagnosticMaterialIds } from '../src/core/materialImport';
import type { ComputeDiagnostics, FixedColor } from '../src/core/mosaic';
import { DEFAULT_PDF_OPTIONS, generatePdf } from '../src/core/pdf';
import { cellRect } from '../src/core/pieces';
import { packMosaic, unpackMosaic } from '../src/core/serialize';
import { computeStats, jointAreaValid } from '../src/core/stats';
import { CellKind, createEmptyMosaic, DEFAULT_ADJUST, DEFAULT_SETTINGS, DEFAULT_SHAPES, type FreePiece, type Material, type PaletteColor } from '../src/core/types';
import { makeT } from '../src/i18n';
import { mergeComputeFields, keepStoredComputeFields, type ProjectRecord } from '../src/storage/db';
import { buildProjectExport, invalidFreeCellIds, parseProjectFile, prepareProjectImport } from '../src/storage/projects';
import { colorCountNotice } from '../src/ui/project/StepColors';
import {
  buildFixedPalette,
  commitFieldsOf,
  materialInputSig,
  materialSigFor,
  rawFor,
  settledHandler,
  type ProjectHandler,
  type RawCache,
} from '../src/ui/project/useProject';
import { attachProject, cancelJob, isCommitting, jobFor, resetJobsForTest, startJob } from '../src/workers/jobs';
import type { RawImage } from '../src/workers/protocol';

afterEach(() => resetJobsForTest());
const tick = () => new Promise((r) => setTimeout(r, 0));

function mat(id: string, over: Partial<Material> = {}): Material {
  return { id, type: 'glass', manufacturer: 'X', product: 'P', colorNumber: id, colorName: `Farbe ${id}`, hex: '#2050C0', lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 0, packageSize: '', piecesPerPack: 0, ...over };
}

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

describe('Auftragsregister: Speichern ist nicht abbrechbar', () => {
  it('cancelJob in der Phase „commit“: false, Auftrag nicht als abgebrochen markiert', async () => {
    let release!: () => void;
    let seenCancelled: boolean | null = null;
    let cancelCalls = 0;
    const h = startJob<string>({
      projectId: 'A',
      projectName: 'A',
      exclusive: true,
      cancel: () => cancelCalls++,
      run: async (ctx) => {
        ctx.report({ phase: 'commit', fraction: 0 });
        await new Promise<void>((r) => (release = r));
        seenCancelled = ctx.cancelled;
        return ctx.cancelled ? 'abgebrochen' : 'gespeichert';
      },
    });
    await tick();
    expect(isCommitting(jobFor('A'))).toBe(true);
    expect(cancelJob('A')).toBe(false);
    expect(cancelCalls).toBe(0);
    release();
    await expect(h.promise).resolves.toBe('gespeichert');
    expect(seenCancelled).toBe(false);
  });

  it('vor dem Speichern bleibt Abbrechen möglich', async () => {
    let cancelled = false;
    const h = startJob<void>({ projectId: 'B', projectName: 'B', exclusive: true, cancel: () => (cancelled = true), run: () => new Promise<void>(() => {}) });
    void h.promise.catch(() => {});
    await tick();
    expect(isCommitting(jobFor('B'))).toBe(false);
    expect(cancelJob('B')).toBe(true);
    expect(cancelled).toBe(true);
  });
});

describe('Ergebnis erst nach dem Laden der (wieder) geöffneten Ansicht übernehmen', () => {
  const handler = (ready: Promise<void>, name: string) => ({ instance: name, ready: () => ready }) as unknown as ProjectHandler;

  it('wartet auf das Laden; eine während des Wartens neu angemeldete Ansicht wird ebenfalls abgewartet', async () => {
    let r1!: () => void;
    let r2!: () => void;
    const h1 = handler(new Promise<void>((r) => (r1 = r)), 'h1');
    const h2 = handler(new Promise<void>((r) => (r2 = r)), 'h2');
    attachProject('P', h1);
    let got: ProjectHandler | undefined | 'pending' = 'pending';
    void settledHandler('P').then((h) => (got = h));
    await tick();
    expect(got).toBe('pending');
    attachProject('P', h2); // Projekt erneut geöffnet, während die erste Ansicht noch lädt
    r1();
    await tick();
    expect(got).toBe('pending');
    r2();
    await tick();
    expect(got).toBe(h2);
  });

  it('ohne geöffnete Ansicht sofort undefined', async () => {
    expect(await settledHandler('Q')).toBeUndefined();
  });
});

describe('Material-Fingerabdruck (computedMaterialSig)', () => {
  const pool = [mat('a', { hex: '#cc2222' }), mat('b', { hex: '#2244cc', stock: 200 }), mat('c', { hex: '#22cc44' })];
  const sigOf = (mode: 'materials' | 'auto-snap', mats: Material[], ids: string[] = []) => materialSigFor(rec({ paletteMode: mode, materialIds: ids }), mats);

  it('nur in den Materialmodi; Farbton ändert ihn in beiden Modi', () => {
    expect(materialSigFor(rec({ paletteMode: 'auto' }), pool)).toBeUndefined();
    expect(materialSigFor(rec({ paletteMode: 'custom' }), pool)).toBeUndefined();
    for (const mode of ['materials', 'auto-snap'] as const) {
      const s0 = sigOf(mode, pool);
      expect(s0).toMatch(/^3:/);
      expect(sigOf(mode, [{ ...pool[0], hex: '#cc2223' }, pool[1], pool[2]])).not.toBe(s0);
      expect(sigOf(mode, [{ ...pool[0], colorName: 'Kirschrot' }, pool[1], pool[2]])).not.toBe(s0);
    }
  });

  it('Bestand: nur bei begrenzter Farbanzahl und nur „auf Lager ja/nein“', () => {
    const snap0 = sigOf('auto-snap', pool);
    expect(sigOf('auto-snap', [pool[0], { ...pool[1], stock: 150 }, pool[2]])).toBe(snap0); // 200 → 150: gleich
    expect(sigOf('auto-snap', [{ ...pool[0], stock: 5 }, pool[1], pool[2]])).not.toBe(snap0); // 0 → 5: anders
    const mat0 = sigOf('materials', pool);
    expect(sigOf('materials', [{ ...pool[0], stock: 5 }, pool[1], pool[2]])).toBe(mat0); // „Materialien“ liest keinen Bestand
  });

  it('„alle Materialien“: hinzugefügt/gelöscht ändert ihn; Auswahl begrenzt ihn; IDs zählen nicht (Import)', () => {
    const all = sigOf('materials', pool);
    expect(sigOf('materials', [...pool, mat('d', { hex: '#888888' })])).not.toBe(all);
    expect(sigOf('materials', pool.slice(0, 2))).not.toBe(all);
    expect(sigOf('materials', [...pool, mat('d')], ['a', 'b', 'c'])).toBe(all);
    expect(sigOf('materials', pool.map((m) => ({ ...m, id: `neu-${m.id}` })))).toBe(all);
    expect(sigOf('materials', [...pool].reverse())).toBe(all);
    expect(sigOf('materials', [])).toBe('none');
  });

  it('wird mit dem Ergebnis gespeichert und von einer Berechnung ohne Materialien wieder entfernt', () => {
    const r = rec({ paletteMode: 'materials' });
    const fixed = buildFixedPalette(r.settings, r.palette, pool) as FixedColor[];
    const ms = materialInputSig('materials', fixed);
    expect(ms).toBe(materialSigFor(r, pool));
    const f = commitFieldsOf({ snapshot: r, palette: [], diagnostics: { meanDeltaE: 0 } as ComputeDiagnostics, materialSig: ms }, { now: 1, rev: 'r1' });
    expect(f.computedMaterialSig).toBe(ms);
    const merged = mergeComputeFields(r, f);
    expect(merged.computedMaterialSig).toBe(ms);
    // „Neu berechnen“ im Modus „automatisch“: Fingerabdruck verschwindet
    const auto = rec({ paletteMode: 'auto' });
    const f2 = commitFieldsOf({ snapshot: auto, palette: [], diagnostics: { meanDeltaE: 0 } as ComputeDiagnostics }, { now: 2, rev: 'r2' });
    expect('computedMaterialSig' in mergeComputeFields(merged, f2)).toBe(false);
    // anderswo gespeichertes Ergebnis übernehmen: Fingerabdruck kommt mit
    expect(keepStoredComputeFields(auto, merged).computedMaterialSig).toBe(ms);
  });
});

describe('Arbeitsbild: „Berechnen“ verbraucht den Zwischenspeicher', () => {
  const bmp = {} as ImageBitmap;
  const inp = { bitmap: bmp, rec: rec(), crop: { x: 0, y: 0, w: 1, h: 1 }, ws: { w: 2, h: 2 }, full: false };
  const render = (): RawImage => ({ width: 2, height: 2, data: new Uint8ClampedArray(16).fill(7) });

  it('Vorschau: Kopie, Arbeitsbild bleibt; Berechnung: Original ohne Kopie, Zwischenspeicher leer', async () => {
    const cache: RawCache = { current: null };
    const a = await rawFor(inp, cache, null, false, render);
    expect(cache.current).not.toBeNull();
    expect(a.data).not.toBe(cache.current!.raw.data);
    const held = cache.current!.raw;
    const b = await rawFor(inp, cache, null, true, render);
    expect(b).toBe(held);
    expect(cache.current).toBeNull();
    // ohne Treffer: berechnet, aber nicht gespeichert
    const c = await rawFor(inp, cache, null, true, render);
    expect(c.data[0]).toBe(7);
    expect(cache.current).toBeNull();
  });
});

describe('Freiformzellen mit überlappenden Teilen (ältere/importierte Projekte)', () => {
  // 17 × 17 mm, Steine 8 mm, Fuge 1 mm → 2 × 2 Zellen; je Zelle zwei 8 × 5-Streifen, die sich 2 mm überlappen
  const settings = { ...DEFAULT_SETTINGS, shapes: { ...DEFAULT_SHAPES }, widthMm: 17, heightMm: 17, tileW: 8, tileH: 8, joint: 1, edgeMode: 'whole' as const, materialIds: [] };
  const lp = { widthMm: 17, heightMm: 17, tileW: 8, tileH: 8, joint: 1, edgeMode: 'whole' as const, minCutMm: settings.minCutMm };
  const layout = computeLayout(lp);
  const stacked: FreePiece[] = [
    { poly: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 5 }, { x: 0, y: 5 }], color: 0 },
    { poly: [{ x: 0, y: 3 }, { x: 8, y: 3 }, { x: 8, y: 8 }, { x: 0, y: 8 }], color: 1 },
  ];
  const palette: PaletteColor[] = [
    { code: 1, hex: '#FFFFFF', name: 'Weiß', lab: hexToLab('#FFFFFF') },
    { code: 2, hex: '#000000', name: 'Schwarz', lab: hexToLab('#000000') },
  ];
  /** gespeicherter Stand wie aus einem älteren Projekt: Teile ohne heutige Prüfung, über pack/unpack */
  const legacy = () => {
    const d = createEmptyMosaic(layout.cols, layout.rows);
    for (const idx of [0, 1, 2, 3]) {
      d.kind[idx] = CellKind.FREE;
      d.free.set(idx, stacked.map((p) => ({ poly: p.poly.map((q) => ({ ...q })), color: p.color })));
    }
    const { progress, ...m } = packMosaic(d);
    return { data: unpackMosaic({ ...m, progress }), mosaic: m };
  };

  it('heute abgelehnt (exakte Schnittfläche 16 mm²); gespeicherte Altdaten werden erkannt und gezählt', () => {
    expect(layout.cols).toBe(2);
    const r = cellRect(layout, 0, 0);
    const v = validateFreePieces(r.w, r.h, stacked, 0, 1);
    expect(v.errors.map((e) => e.code)).toEqual(['overlap']);
    const d = createEmptyMosaic(layout.cols, layout.rows);
    expect(setFreePieces(layout, d, 0, 0, stacked, 0).ok).toBe(false);
    const { data } = legacy();
    const bad = invalidFreeCells(layout, data);
    expect(bad.map((b) => b.idx)).toEqual([0, 1, 2, 3]);
    expect(bad[0].errors[0]).toMatchObject({ code: 'overlap', areaMm2: 16 });
    expect(invalidFreeCells(layout, data, { r0: 0, r1: 1, c0: 0, c1: 2 }).length).toBe(2);
  });

  it('Statistik: Zähler gesetzt, Flächen als ungültig erkannt (statt negativer Fugenfläche)', () => {
    const { data } = legacy();
    const st = computeStats(layout, data, palette, [], { reservePct: 10, groutDepthMm: 3 });
    expect(st.invalidFreeCells).toBe(4);
    expect(st.stoneArea).toBeGreaterThan(st.finishedArea); // so stünde es ohne Schutz da
    expect(jointAreaValid(st)).toBe(false);
    // gültige Freiformzellen: alles in Ordnung
    const ok = createEmptyMosaic(layout.cols, layout.rows);
    expect(setFreePieces(layout, ok, 0, 0, [stacked[0], { poly: [{ x: 0, y: 6 }, { x: 8, y: 6 }, { x: 8, y: 8 }, { x: 0, y: 8 }], color: 1 }], 0).ok).toBe(true);
    const st2 = computeStats(layout, ok, palette, [], { reservePct: 10, groutDepthMm: 3 });
    expect(st2.invalidFreeCells).toBe(0);
    expect(jointAreaValid(st2)).toBe(true);
    expect(st2.jointArea).toBeGreaterThan(0);
  });

  it('PDF wird verweigert und nennt die Steine', async () => {
    const { data } = legacy();
    await expect(
      generatePdf(
        { projectName: 'Alt', dateStr: '08.11.2026', layout, data, palette, materials: [], settings, sections: sectionsFor(layout, settings), t: makeT('de'), locale: 'de' },
        { ...DEFAULT_PDF_OPTIONS, includeImages: false },
      ),
    ).rejects.toThrow(/PDF nicht erstellt: 4 Freiform-Steine .*A001, A002, B001, B002/);
  });

  it('Import: Zusammenfassung nennt die betroffenen Steine', async () => {
    const { mosaic } = legacy();
    const r = rec({ ...settings }, { computedWith: JSON.stringify({ l: lp }), mosaicRev: 'x', palette, meta: { id: 'p', name: 'Alt', createdAt: 0, updatedAt: 0, computed: true } });
    expect(invalidFreeCellIds(r, { ...mosaic, rev: 'x' })).toEqual(['A001', 'A002', 'B001', 'B002']);
    const blob = await buildProjectExport(r, null, { ...mosaic, rev: 'x' }, null, []);
    const parsed = parseProjectFile(await blob.text());
    const prep = prepareProjectImport(parsed, [], [], { id: 'neu', now: 1 });
    expect(prep.summary.freeInvalid).toEqual(['A001', 'A002', 'B001', 'B002']);
  });
});

describe('Farbanzahl-Meldung: direkte Auswahl legt nichts zusammen', () => {
  it('weniger Farben als angefordert: Gründe ohne „zusammengelegt“ (de/en/tr)', () => {
    const base: ComputeDiagnostics = { meanDeltaE: 1, maxDeltaE: 2, p95DeltaE: 2, splitCells: 0, subCells: 0, recommendCells: 0, timeMs: 1, samplesPerCell: 36, paletteMode: 'auto-snap', requestedColors: 24, imageColors: 24 };
    const sel = { method: 'select' as const, snapColors: 13, selected: 20, swaps: 0, filled: 0, stockSwaps: 0, budgetHit: false };
    // auch ein älteres gespeichertes Ergebnis mit mergedColors zeigt es nicht mehr
    for (const lang of ['de', 'en', 'tr'] as const) {
      const txt = colorCountNotice({ ...base, usedColors: 20, mergedColors: 13, poolColors: 336, snapSelection: sel }, makeT(lang))!.text;
      expect(txt).not.toMatch(/zusammengelegt|merged|birleştirildi/);
    }
    expect(colorCountNotice({ ...base, usedColors: 20, poolColors: 336, snapSelection: sel }, makeT('de'))!.text).toContain('angefordert 24 – verwendet 20');
  });
});

describe('Fehlende Farben: erwähnte Materialien werden zugeordnet, nie angelegt', () => {
  it('Export enthält sie als materialRefs; Import ordnet gleiche Materialien zu, legt nichts an', async () => {
    const used = mat('u1', { hex: '#cc2222' });
    const nearest = mat('n1', { manufacturer: 'Kat', colorNumber: '228', hex: '#9E9582' });
    const diagnostics = { meanDeltaE: 1, missingColors: [{ hex: '#9E9582', lab: hexToLab('#9E9582'), stones: 10, nearestMaterialId: 'n1', nearestHex: '#9E9582', nearestName: 'Kat 228', deltaE: 10.9, gotDeltaE: 12 }] } as unknown as ComputeDiagnostics;
    expect(diagnosticMaterialIds(diagnostics, ['u1'])).toEqual(['n1']);
    expect(diagnosticMaterialIds(diagnostics, ['n1'])).toEqual([]);
    const r = rec({ paletteMode: 'auto-snap', materialIds: [] }, { palette: [{ code: 1, hex: '#CC2222', name: 'Farbe u1', lab: hexToLab('#CC2222'), materialId: 'u1' }], diagnostics });
    const blob = await buildProjectExport(r, null, null, null, [used, nearest]);
    const payload = JSON.parse(await blob.text()) as { materials: Material[]; materialRefs: Material[] };
    expect(payload.materials.map((m) => m.id)).toEqual(['u1']);
    expect(payload.materialRefs.map((m) => m.id)).toEqual(['n1']);
    const parsed = parseProjectFile(await blob.text());
    // anderes Gerät: gleicher Katalog unter anderen IDs → zugeordnet, nichts zusätzlich angelegt
    const local = [mat('B-u1', { ...used, id: 'B-u1' }), { ...nearest, id: 'B-n1' }];
    const prep = prepareProjectImport(parsed, local, [], { id: 'neu', now: 1 });
    expect(prep.inserts).toEqual([]);
    expect(prep.rec.diagnostics?.missingColors?.[0].nearestMaterialId).toBe('B-n1');
    expect(prep.rec.palette[0].materialId).toBe('B-u1');
    // leeres Gerät: das genutzte Material wird angelegt, das nur erwähnte nicht
    const fresh = prepareProjectImport(parsed, [], [], { id: 'neu2', now: 1 });
    expect(fresh.inserts.map((m) => m.id)).toEqual(['u1']);
    expect(linkReferencedMaterials(payload.materialRefs, [])).toEqual({});
  });
});

describe('Warten auf das Laden ist begrenzt', () => {
  it('hängt das Laden, endet das Warten nach der Frist (die Ansicht stellt das Ergebnis dann selbst zurück)', async () => {
    const h = { instance: 'x', ready: () => new Promise<void>(() => {}) } as unknown as ProjectHandler;
    attachProject('R', h);
    const t0 = Date.now();
    expect(await settledHandler('R', 30)).toBe(h);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
