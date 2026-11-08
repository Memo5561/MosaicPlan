/**
 * Zuverlässiges Speichern: Zusammengehörigkeit von Palette und Raster (Revision + Farbindizes),
 * Foto-Identität im Berechnungsschlüssel, Zusammenführen von Berechnungsergebnis und Bearbeitungen.
 * (Das Verhalten in IndexedDB selbst prüft e2e/w1-persistence.e2e.cjs im Browser.)
 */
import { describe, expect, it } from 'vitest';
import { checkMosaicIntegrity, maxColorIndex } from '../src/core/integrity';
import { computeLayout, type LayoutParams } from '../src/core/layout';
import { packMosaic, unpackMosaic } from '../src/core/serialize';
import { CellKind, createEmptyMosaic, DEFAULT_ADJUST, DEFAULT_SETTINGS, type MosaicData, type PaletteColor } from '../src/core/types';
import { keepStoredComputeFields, mergeComputeFields, type ComputeFields, type ProjectRecord } from '../src/storage/db';
import { classifySaveError, computeKey, layoutParamsOf, restoreComputed } from '../src/ui/project/useProject';

const pal = (n: number): PaletteColor[] => Array.from({ length: n }, (_, i) => ({ code: i + 1, name: `F${i + 1}`, hex: '#808080', lab: [50, 0, 0] }));

function baseRec(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    meta: { id: 'p1', name: 'Test', createdAt: 1, updatedAt: 2, computed: false },
    settings: { ...DEFAULT_SETTINGS, shapes: { ...DEFAULT_SETTINGS.shapes }, widthMm: 50, heightMm: 30, tileW: 8, tileH: 8, joint: 2 },
    adjust: { ...DEFAULT_ADJUST },
    regions: [],
    palette: pal(4),
    ...over,
  };
}

/** Schlüssel genau so, wie ihn die Version vor diesem Paket gebildet hat (ohne Foto-Identität). */
function legacyKey(r: ProjectRecord): string {
  const s = r.settings;
  return JSON.stringify({
    l: { widthMm: s.widthMm, heightMm: s.heightMm, tileW: s.tileW, tileH: s.tileH, joint: s.joint, edgeMode: s.edgeMode, minCutMm: s.minCutMm },
    sh: s.shapes,
    pm: s.paletteMode,
    cc: s.colorCount,
    di: s.dither,
    de: s.deltaE,
    mi: s.paletteMode === 'materials' || s.paletteMode === 'auto-snap' ? s.materialIds : [],
    cp: s.paletteMode === 'custom' ? r.palette.map((p) => p.hex) : [],
    a: r.adjust,
    rg: r.regions,
  });
}

/** 3×2-Raster mit allen Zellarten; jede Zelle trägt ihren „echten“ Höchstindex in einem anderen Feld. */
function allKinds(): MosaicData {
  const d = createEmptyMosaic(3, 2);
  // 0 FULL: c1 = 1, c2 (unbenutzt) = 60
  d.kind[0] = CellKind.FULL;
  d.c1[0] = 1;
  d.c2[0] = 60;
  // 1 DIAG_A: c2 = 2
  d.kind[1] = CellKind.DIAG_A;
  d.c1[1] = 0;
  d.c2[1] = 2;
  // 2 DIAG_B: c2 = 3
  d.kind[2] = CellKind.DIAG_B;
  d.c2[2] = 3;
  // 3 LINE: c2 = 4
  d.kind[3] = CellKind.LINE;
  d.c2[3] = 4;
  d.line.set(3, new Float32Array([1, 0, 0]));
  // 4 SUB: k×k-Farben bis 5, c2 (unbenutzt) = 70
  d.kind[4] = CellKind.SUB;
  d.sub.set(4, new Uint16Array([0, 5, 1, 2]));
  d.c2[4] = 70;
  // 5 FREE: Teile bis 6
  d.kind[5] = CellKind.FREE;
  d.free.set(5, [
    { poly: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 4 }], color: 6 },
    { poly: [{ x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], color: 3 },
  ]);
  return d;
}

describe('maxColorIndex', () => {
  it('leeres Raster → −1, einfaches Raster → c1', () => {
    expect(maxColorIndex(createEmptyMosaic(0, 0))).toBe(-1);
    const d = createEmptyMosaic(2, 2);
    d.c1.set([0, 3, 1, 2]);
    expect(maxColorIndex(d)).toBe(3);
  });

  it('berücksichtigt jede Zellart mit genau den gezeichneten Farben', () => {
    const d = allKinds();
    expect(maxColorIndex(d)).toBe(6); // Freiform-Teil
    expect(maxColorIndex(packMosaic(d))).toBe(6); // gespeicherte Form liefert dasselbe
    d.free.get(5)![0].color = 0;
    expect(maxColorIndex(d)).toBe(5); // SUB
    d.sub.get(4)![1] = 0;
    expect(maxColorIndex(d)).toBe(4); // LINE c2
    d.c2[3] = 0;
    expect(maxColorIndex(d)).toBe(3); // DIAG_B c2 (und FREE-Teil 2)
    d.c2[2] = 0;
    d.free.get(5)![1].color = 0;
    expect(maxColorIndex(d)).toBe(2); // DIAG_A c2 / SUB
    d.c2[1] = 0;
    d.sub.get(4)!.fill(0);
    expect(maxColorIndex(d)).toBe(1); // FULL c1; c2 von FULL/SUB zählt nicht
    expect(maxColorIndex(packMosaic(d))).toBe(1);
  });

  it('c1 zählt bei jeder Zellart, auch bei SUB und FREE', () => {
    const d = allKinds();
    d.c1[5] = 9;
    expect(maxColorIndex(d)).toBe(9);
    expect(maxColorIndex(packMosaic(d))).toBe(9);
  });

  it('Unterteilungs- und Freiform-Farben von Zellen anderer Art werden ignoriert', () => {
    const d = createEmptyMosaic(2, 1);
    d.sub.set(0, new Uint16Array([40, 41, 42, 43])); // Zelle 0 ist FULL
    d.free.set(1, [{ poly: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], color: 50 }]); // Zelle 1 ist FULL
    expect(maxColorIndex(d)).toBe(0);
    expect(maxColorIndex(packMosaic(d))).toBe(0);
  });
});

describe('checkMosaicIntegrity', () => {
  const grid = () => {
    const d = createEmptyMosaic(2, 2);
    d.c1.set([0, 1, 2, 3]);
    return packMosaic(d);
  };

  it('ältere Daten ohne Revision bestehen die Revisionsprüfung, Indexprüfung greift weiter', () => {
    expect(checkMosaicIntegrity({ palette: pal(4) }, grid())).toEqual({ ok: true, reason: null });
    expect(checkMosaicIntegrity({ palette: pal(3) }, grid())).toEqual({ ok: false, reason: 'index' });
  });

  it('gleiche Revision + Indizes in der Palette → ok', () => {
    expect(checkMosaicIntegrity({ mosaicRev: 'r1', palette: pal(4) }, { ...grid(), rev: 'r1' })).toEqual({ ok: true, reason: null });
  });

  it('unterschiedliche oder einseitig fehlende Revision → rev', () => {
    expect(checkMosaicIntegrity({ mosaicRev: 'r1', palette: pal(16) }, { ...grid(), rev: 'r2' }).reason).toBe('rev');
    expect(checkMosaicIntegrity({ mosaicRev: 'r1', palette: pal(16) }, grid()).reason).toBe('rev');
    expect(checkMosaicIntegrity({ palette: pal(16) }, { ...grid(), rev: 'r2' }).reason).toBe('rev');
  });

  it('Index außerhalb der Palette → index (auch bei leerer Palette)', () => {
    expect(checkMosaicIntegrity({ mosaicRev: 'r', palette: pal(3) }, { ...grid(), rev: 'r' })).toEqual({ ok: false, reason: 'index' });
    expect(checkMosaicIntegrity({ palette: [] }, packMosaic(createEmptyMosaic(1, 1))).reason).toBe('index');
  });
});

describe('Revision im gespeicherten Raster', () => {
  it('pack/unpack behält rev; ohne rev entsteht kein Eintrag', () => {
    const d = allKinds();
    expect('rev' in packMosaic(d)).toBe(false);
    expect('rev' in unpackMosaic(packMosaic(d))).toBe(false);
    const withRev = unpackMosaic({ ...packMosaic(d), rev: 'abc' });
    expect(withRev.rev).toBe('abc');
    expect(packMosaic(withRev).rev).toBe('abc');
    expect(unpackMosaic(structuredClone(packMosaic(withRev))).rev).toBe('abc');
  });
});

describe('computeKey und Foto-Identität', () => {
  it('ohne imageRev ist der Schlüssel Zeichen für Zeichen der bisherige', () => {
    const r = baseRec();
    expect(computeKey(r)).toBe(legacyKey(r));
    const custom = baseRec({ settings: { ...baseRec().settings, paletteMode: 'custom' } });
    expect(computeKey(custom)).toBe(legacyKey(custom));
  });

  it('ein (neues) Foto ändert den Schlüssel', () => {
    const r = baseRec();
    const a = computeKey({ ...r, imageRev: 'foto-1' });
    const b = computeKey({ ...r, imageRev: 'foto-2' });
    expect(a).not.toBe(legacyKey(r));
    expect(a).not.toBe(b);
    expect(JSON.parse(a).im).toBe('foto-1');
  });

  it('layoutParamsOf übernimmt genau die Rastermaße', () => {
    const s = baseRec().settings;
    expect(JSON.parse(computeKey(baseRec())).l).toEqual(layoutParamsOf(s));
  });
});

describe('Berechnungsergebnis und Bearbeitungen zusammenführen', () => {
  const fields: ComputeFields = { palette: pal(8), computedWith: 'KEY', mosaicRev: 'new', computedImageRev: 'img-1', thumb: 'data:thumb', updatedAt: 99 };

  it('mergeComputeFields behält Name/Einstellungen des neuesten Stands und setzt nur Ergebnisfelder', () => {
    const latest = baseRec({ meta: { ...baseRec().meta, name: 'Umbenannt', manualEdits: 7 }, settings: { ...baseRec().settings, joint: 3 }, mosaicRev: 'old', imageRev: 'img-2' });
    const next = mergeComputeFields(latest, fields);
    expect(next.meta.name).toBe('Umbenannt');
    expect(next.settings.joint).toBe(3);
    expect(next.imageRev).toBe('img-2');
    expect(next.palette).toHaveLength(8);
    expect(next.mosaicRev).toBe('new');
    expect(next.computedImageRev).toBe('img-1');
    expect(next.computedWith).toBe('KEY');
    expect(next.meta).toMatchObject({ computed: true, thumb: 'data:thumb', updatedAt: 99, manualEdits: 0 });
    expect('diagnostics' in next).toBe(false);
  });

  it('keepStoredComputeFields: eigene Bearbeitungen bleiben, Raster-bezogene Felder kommen aus dem Speicher', () => {
    const stored = mergeComputeFields(baseRec({ meta: { ...baseRec().meta, name: 'Alt' } }), fields);
    const mine = baseRec({ meta: { ...baseRec().meta, name: 'Neu', manualEdits: 3, thumb: 'old-thumb' }, palette: pal(16), computedWith: 'OLD', mosaicRev: 'old', pdfOptions: { paper: 'A3' } as ProjectRecord['pdfOptions'] });
    const next = keepStoredComputeFields(mine, stored);
    expect(next.meta.name).toBe('Neu');
    expect(next.pdfOptions).toEqual({ paper: 'A3' });
    expect(next.palette).toHaveLength(8);
    expect(next.computedWith).toBe('KEY');
    expect(next.mosaicRev).toBe('new');
    expect(next.meta).toMatchObject({ computed: true, thumb: 'data:thumb', manualEdits: 0 });
    // fehlt im Speicher → fehlt auch im Ergebnis (keine veralteten Reste)
    const legacy = keepStoredComputeFields(mine, baseRec());
    expect('mosaicRev' in legacy).toBe(false);
    expect('computedWith' in legacy).toBe(false);
    expect('thumb' in legacy.meta).toBe(false);
  });
});

describe('restoreComputed (Laden nur zusammengehöriger Daten)', () => {
  const lp: LayoutParams = layoutParamsOf(baseRec().settings);
  const layout = computeLayout(lp);
  const computedRec = (over: Partial<ProjectRecord> = {}) => baseRec({ computedWith: computeKey(baseRec()), mosaicRev: 'r1', ...over });
  const storedGrid = (rev?: string, maxIdx = 3) => {
    const d = createEmptyMosaic(layout.cols, layout.rows);
    for (let i = 0; i < d.c1.length; i++) d.c1[i] = i % (maxIdx + 1);
    const { progress: _p, ...rest } = packMosaic(d);
    void _p;
    return rev ? { ...rest, rev } : rest;
  };

  it('passende Daten werden geladen, Fortschritt übernommen', () => {
    const prog = new Uint16Array(layout.cols * layout.rows);
    prog[0] = 1;
    const res = restoreComputed(computedRec(), storedGrid('r1'), prog);
    expect(res.mismatch).toBeNull();
    expect(res.computed?.layout.cols).toBe(layout.cols);
    expect(res.computed?.data.progress[0]).toBe(1);
  });

  it('ältere Projekte ohne Revision laden weiter', () => {
    const res = restoreComputed(computedRec({ mosaicRev: undefined }), storedGrid(undefined), undefined);
    expect(res.mismatch).toBeNull();
    expect(res.computed).not.toBeNull();
  });

  it('Raster einer anderen Berechnung oder mit Index außerhalb der Palette wird nicht angezeigt', () => {
    expect(restoreComputed(computedRec(), storedGrid('r2'), undefined)).toEqual({ computed: null, mismatch: 'rev' });
    expect(restoreComputed(computedRec({ palette: pal(3) }), storedGrid('r1', 3), undefined)).toEqual({ computed: null, mismatch: 'index' });
  });

  it('falsches Raster-Format oder fehlendes Raster bei berechnetem Projekt → mismatch', () => {
    const other = { ...storedGrid('r1'), cols: layout.cols + 1 };
    expect(restoreComputed(computedRec(), other, undefined).mismatch).toBe('layout');
    expect(restoreComputed(computedRec(), undefined, undefined).mismatch).toBe('missing');
    expect(restoreComputed(baseRec(), undefined, undefined)).toEqual({ computed: null, mismatch: null });
  });
});

describe('classifySaveError', () => {
  const dom = (name: string) => Object.assign(new Error('x'), { name });
  it('ordnet Speicherfehler zu', () => {
    expect(classifySaveError(dom('QuotaExceededError')).code).toBe('quota');
    expect(classifySaveError(dom('InvalidStateError')).code).toBe('connection');
    expect(classifySaveError(dom('UnknownError')).code).toBe('connection');
    expect(classifySaveError(new Error('deleted')).code).toBe('deleted');
    expect(classifySaveError(new Error('irgendwas')).code).toBe('other');
  });
});
