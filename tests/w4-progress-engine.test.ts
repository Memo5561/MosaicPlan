/**
 * Paket w4-progress-engine: Fortschrittszähler, Übernahme des Fortschritts beim Neuberechnen, Fortschritt für
 * Projektlisten und Pflichtfarben als Eingabe der Berechnung.
 *
 *  - progressIndex: nach zufälligen Antipp-, Zellen-, Bereichs-, Form-, Farb- und Freiform-Änderungen sind die
 *    Zähler je Abschnitt und gesamt exakt gleich progressOf (Nachführen nur der geänderten Zellen bzw. Abgleich).
 *  - progressCarry: gleiches Raster und gleiche Berechnung → 100 % übernommen; andere Fuge → nichts, gemeldet;
 *    geänderte Farbe/Material/Geometrie → genau dieser Stein zurückgesetzt und gemeldet; verglichen werden
 *    Palettenfarben, nie Indizes.
 *  - db: progressSummary/lastCarryOver gehören zum Raster (Berechnen setzt sie, ein fremdes Raster übernimmt die
 *    gespeicherten), Anzeige nur bei passender Revision, Prozent nie „100“ vor dem letzten Stein.
 */
import { describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { setCellKind, setCellPlaced, setFreePieces, setPieceColor, setRangePlaced, togglePiecePlaced } from '../src/core/edits';
import { computeLayout, sectionsFor, type Layout, type SectionGrid } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { cellPieceCount, freePreset } from '../src/core/pieces';
import { carryOverProgress, CARRY_MAX_CELLS, pieceColorAt, placedCount, sameLayoutParams } from '../src/core/progressCarry';
import { applyDiff, applyDirty, buildProgressIndex, countProgress, pieceMask, popcount16, progressFromIndex, type ProgressIndex } from '../src/core/progressIndex';
import { packMosaic, unpackMosaic } from '../src/core/serialize';
import { computeStats, progressOf, popcount } from '../src/core/stats';
import { CellKind, DEFAULT_ADJUST, DEFAULT_SETTINGS, DEFAULT_SHAPES, type MosaicData, type PaletteColor } from '../src/core/types';
import { keepStoredComputeFields, laidPercent, listProgressOf, mergeComputeFields, type ComputeFields, type ProjectRecord } from '../src/storage/db';
import { carryBaseFromStored, carryFor, describeComputeInputs, pinnedFixedColors, sectionKeyOf, type ComputeEnv } from '../src/ui/project/useProject';
import { baseParams, sampleSetup } from './w1-mosaic-core.fixtures';

// ---------------------------------------------------------------- Hilfen

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cloneData = (d: MosaicData): MosaicData => unpackMosaic(structuredClone(packMosaic(d)));

function computed(key: string, patch: Parameters<typeof baseParams>[1] = {}) {
  const su = sampleSetup(key);
  const res = computeMosaic(su.img, baseParams(su, patch));
  return { su, layout: su.layout, lp: su.lp, data: res.data, palette: res.palette };
}

/** Zähler müssen je Abschnitt und gesamt exakt progressOf entsprechen (und einem frischen Aufbau). */
function expectIndexExact(index: ProgressIndex, layout: Layout, data: MosaicData, grid: SectionGrid, ctx: string) {
  const fresh = buildProgressIndex(layout, data, grid);
  const all = progressOf(layout, data);
  expect({ placed: index.placedAll, total: index.totalAll }, `${ctx}: gesamt`).toEqual(all);
  const pr = progressFromIndex(index);
  expect(pr.total).toEqual(all);
  for (let s = 0; s < grid.sections.length; s++) {
    const sec = grid.sections[s];
    const want = progressOf(layout, data, sec);
    expect(pr.perSection.get(sec.id), `${ctx}: Abschnitt ${sec.id}`).toEqual(want);
    expect(index.placed[s]).toBe(fresh.placed[s]);
    expect(index.total[s]).toBe(fresh.total[s]);
  }
  expect(index.masks).toEqual(fresh.masks);
  expect(index.counts).toEqual(fresh.counts);
}

// ---------------------------------------------------------------- progressIndex

describe('progressIndex: Zähler = progressOf', () => {
  it('popcount16 und pieceMask wie in stats.ts', () => {
    for (let v = 0; v < 65536; v += 97) expect(popcount16(v)).toBe(popcount(v));
    expect(pieceMask(0)).toBe(0);
    expect(pieceMask(1)).toBe(1);
    expect(pieceMask(9)).toBe(0x1ff);
    expect(pieceMask(16)).toBe(0xffff);
    expect(pieceMask(40)).toBe(0xffff);
  });

  it('nach zufälligem Antippen, Zellen, Bereichen, Form-, Farb- und Freiform-Änderungen: je Abschnitt und gesamt exakt', () => {
    const { layout, data, palette } = computed('portrait', { dither: 0 });
    // alle Zellarten kommen vor (Dreiecke, Kantenschnitte, k×k aus der Berechnung; Freiform unten)
    const kinds = new Set(data.kind);
    expect(kinds.has(CellKind.FULL) && kinds.has(CellKind.LINE)).toBe(true);
    const grid = sectionsFor(layout, { sectionMode: 'size', sectionWmm: 90, sectionHmm: 110 });
    expect(grid.sections.length).toBeGreaterThan(9);
    const index = buildProgressIndex(layout, data, grid);
    expectIndexExact(index, layout, data, grid, 'Start');
    const R = rng(4711);
    const n = layout.cols * layout.rows;
    const cellOf = () => {
      const idx = Math.floor(R() * n);
      return { idx, row: Math.floor(idx / layout.cols), col: idx % layout.cols };
    };
    const minPiece = DEFAULT_SHAPES.minPieceMm;
    let kindEdits = 0;
    let freeEdits = 0;
    for (let step = 0; step < 600; step++) {
      const op = R();
      if (op < 0.4) {
        // Antippen (ein Bit, ein- oder ausschalten)
        const { idx } = cellOf();
        togglePiecePlaced(data, idx, Math.floor(R() * cellPieceCount(data, idx)));
        applyDirty(index, data, [idx]);
      } else if (op < 0.55) {
        const { idx } = cellOf();
        setCellPlaced(data, idx, R() < 0.6);
        applyDirty(index, data, [idx, idx]); // Doppelte schaden nicht
      } else if (op < 0.65) {
        // Bereich (z. B. „Abschnitt fertig“ oder Rechteck) – Abgleich ohne Zellenliste
        const sec = grid.sections[Math.floor(R() * grid.sections.length)];
        setRangePlaced(layout, data, sec, R() < 0.7);
        applyDiff(index, data);
      } else if (op < 0.75) {
        // Bereich mit Zellenliste
        const r0 = Math.floor(R() * layout.rows);
        const c0 = Math.floor(R() * layout.cols);
        const rg = { r0, r1: Math.min(layout.rows, r0 + 1 + Math.floor(R() * 6)), c0, c1: Math.min(layout.cols, c0 + 1 + Math.floor(R() * 6)) };
        setRangePlaced(layout, data, rg, R() < 0.5);
        const cells: number[] = [];
        for (let r = rg.r0; r < rg.r1; r++) for (let c = rg.c0; c < rg.c1; c++) cells.push(r * layout.cols + c);
        applyDirty(index, data, cells);
      } else if (op < 0.85) {
        // Formänderung (setzt den Verlegestatus der Zelle zurück, Teilezahl ändert sich)
        const { idx, row, col } = cellOf();
        const choices = [{ kind: CellKind.FULL }, { kind: CellKind.DIAG_A }, { kind: CellKind.DIAG_B }, { kind: CellKind.SUB, k: 2 as const }, { kind: CellKind.LINE, angleDeg: 30, offsetMm: 0.5 }];
        const err = setCellKind(layout, data, row, col, choices[Math.floor(R() * choices.length)], minPiece);
        if (!err) kindEdits++;
        applyDirty(index, data, [idx]);
      } else if (op < 0.9) {
        // Freiform (bis zu zwei Teile)
        const { idx, row, col } = cellOf();
        const polys = freePreset(R() < 0.5 ? 'half' : 'diagA', layout.colW[col], layout.rowH[row], layout.joint);
        if (polys) {
          const v = setFreePieces(layout, data, row, col, polys.map((poly, i) => ({ poly, color: i % palette.length })), 0.5);
          if (v.ok) freeEdits++;
        }
        applyDirty(index, data, [idx]);
      } else {
        // Farbänderung: keine Wirkung auf die Zähler
        const { idx } = cellOf();
        setPieceColor(data, idx, 0, Math.floor(R() * palette.length));
        applyDirty(index, data, [idx]);
      }
      if (step % 25 === 0) expectIndexExact(index, layout, data, grid, `Schritt ${step}`);
    }
    expectIndexExact(index, layout, data, grid, 'Ende');
    expect(kindEdits).toBeGreaterThan(10);
    expect(freeEdits).toBeGreaterThan(3);
    // Summe der Steine = Statistik (exakte Geometrie)
    const st = computeStats(layout, data, palette, [], { reservePct: 0, groutDepthMm: 3 });
    expect(index.totalAll).toBe(st.pieces + st.invalidPieces);
    expect(index.placedAll).toBe(st.placed);
  });

  it('applyDiff findet jede geänderte Zelle; ungültige Zellindizes werden ignoriert', () => {
    const { layout, data } = computed('animal');
    const grid = sectionsFor(layout, DEFAULT_SETTINGS);
    const index = buildProgressIndex(layout, data, grid);
    const R = rng(9);
    for (let i = 0; i < 2000; i++) data.progress[Math.floor(R() * data.progress.length)] = Math.floor(R() * 65536);
    expect(applyDiff(index, data)).toBeGreaterThan(1500);
    expectIndexExact(index, layout, data, grid, 'nach Abgleich');
    expect(applyDirty(index, data, [-1, 1.5, data.progress.length, Number.NaN])).toBe(0);
    expect(applyDiff(index, data)).toBe(0);
  });

  it('countProgress = progressOf über das ganze Raster', () => {
    const { layout, data } = computed('city');
    const R = rng(3);
    for (let i = 0; i < 500; i++) togglePiecePlaced(data, Math.floor(R() * data.progress.length), 0);
    expect(countProgress(data)).toEqual(progressOf(layout, data));
  });

  it('sectionKeyOf unterscheidet genau die Abschnittseinstellungen', () => {
    const s = DEFAULT_SETTINGS;
    expect(sectionKeyOf(s)).toBe(sectionKeyOf({ ...s }));
    expect(sectionKeyOf({ ...s, sectionWmm: 200 })).not.toBe(sectionKeyOf(s));
    expect(sectionKeyOf({ ...s, sectionMode: 'count' })).not.toBe(sectionKeyOf(s));
  });
});

// ---------------------------------------------------------------- Übernahme beim Neuberechnen

/** Legt jeden 3. Stein (alle Teile) als verlegt fest; liefert die Anzahl verlegter Steine. */
function layEveryThird(layout: Layout, data: MosaicData): number {
  for (let idx = 0; idx < data.progress.length; idx += 3) setCellPlaced(data, idx, true);
  return progressOf(layout, data).placed;
}

describe('Fortschritt beim Neuberechnen übernehmen (nur nachweislich gleiche Steine)', () => {
  it('gleiche Einstellungen: 100 % übernommen, nichts zurückgesetzt', () => {
    const a = computed('portrait');
    const laid = layEveryThird(a.layout, a.data);
    expect(laid).toBeGreaterThan(1000);
    const b = computed('portrait'); // deterministisch: dieselbe Berechnung
    const res = carryOverProgress({ lp: a.lp, data: a.data, palette: a.palette }, { lp: b.lp, data: b.data, palette: b.palette });
    expect(res.report).toEqual({ status: 'kept', kept: laid, reset: 0, cells: [], cellCount: 0 });
    expect(res.progress).toEqual(a.data.progress.map((v, i) => v & pieceMask(cellPieceCount(a.data, i))));
    // Zahlen für Projektlisten exakt
    const out = carryFor({ rev: 'r0', lp: a.lp, data: a.data, palette: a.palette }, { lp: b.lp, data: b.data, fields: { mosaicRev: 'r1' } as ComputeFields }, b.palette, 5);
    expect(out.fields.progressSummary).toEqual({ ...progressOf(b.layout, { ...b.data, progress: out.progress }), rev: 'r1' });
    expect(out.fields.carryOver).toEqual({ status: 'kept', kept: laid, reset: 0, cells: [], cellCount: 0, rev: 'r1', at: 5 });
    // das neue Ergebnis selbst bleibt unverändert (neues Array)
    expect(b.data.progress.every((v) => v === 0)).toBe(true);
  });

  it('andere Fuge: Raster geändert – nichts übernommen, alle verlegten Steine gemeldet', () => {
    const a = computed('portrait');
    const laid = layEveryThird(a.layout, a.data);
    const su = sampleSetup('portrait');
    const lp2 = { ...su.lp, joint: su.lp.joint + 0.5 };
    const layout2 = computeLayout(lp2);
    const b = computeMosaic(su.img, { ...baseParams(su), layout: layout2 });
    const res = carryOverProgress({ lp: a.lp, data: a.data, palette: a.palette }, { lp: lp2, data: b.data, palette: b.palette });
    expect(res.report).toEqual({ status: 'layout', kept: 0, reset: laid, cells: [], cellCount: 0 });
    expect(res.progress.every((v) => v === 0)).toBe(true);
    expect(res.progress.length).toBe(layout2.cols * layout2.rows);
    // gleiche Spalten/Zeilen, aber anderer Mindestschnitt: ebenfalls „Raster geändert“ (Rastermaße verglichen)
    expect(sameLayoutParams(su.lp, { ...su.lp, minCutMm: su.lp.minCutMm + 1 })).toBe(false);
    // andere Feldreihenfolge (z. B. aus einem gespeicherten Schlüssel) zählt nicht
    const reordered = Object.fromEntries(Object.entries(su.lp).reverse()) as typeof su.lp;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(su.lp));
    expect(sameLayoutParams(su.lp, reordered)).toBe(true);
  });

  it('nichts verlegt: nichts zu melden', () => {
    const a = computed('animal');
    const b = computed('animal');
    expect(carryOverProgress({ lp: a.lp, data: a.data, palette: a.palette }, { lp: b.lp, data: b.data, palette: b.palette }).report).toBeNull();
    expect(carryOverProgress(null, { lp: b.lp, data: b.data, palette: b.palette }).report).toBeNull();
  });

  it('geänderte Farbe, geändertes Material oder geänderte Geometrie: genau diese Steine zurückgesetzt und gemeldet', () => {
    const a = computed('portrait');
    const laid = layEveryThird(a.layout, a.data);
    const b = computed('portrait');
    const nd = cloneData(b.data);
    const palette: PaletteColor[] = b.palette.map((p) => ({ ...p }));
    // (1) Farbe eines verlegten ganzen Steins: anderer Palettenindex mit anderem HEX
    const fullIdx = [...a.data.kind.keys()].find((i) => i % 3 === 0 && a.data.kind[i] === CellKind.FULL)!;
    const other = (nd.c1[fullIdx] + 1) % palette.length;
    expect(palette[other].hex).not.toBe(palette[nd.c1[fullIdx]].hex);
    setPieceColor(nd, fullIdx, 0, other);
    // (2) Material einer Palettenfarbe ergänzt: alle verlegten Steine dieser Farbe sind „anders“
    const matColor = 3;
    palette[matColor] = { ...palette[matColor], materialId: 'mat-neu' };
    // (3) Kantenschnitt mit minimal anderem Parameter (ein Float32-Schritt)
    const lineIdx = [...a.data.line.keys()].find((i) => i % 3 === 0 && i !== fullIdx && a.data.c1[i] !== matColor && a.data.c2[i] !== matColor)!;
    const lv = nd.line.get(lineIdx)!;
    const bumped = new Float32Array(lv);
    bumped[2] = bumped[2] + 0.01;
    expect(bumped[2]).not.toBe(lv[2]);
    nd.line.set(lineIdx, bumped);
    // erwartet: zurückgesetzte Teile exakt gezählt
    let expReset = 0;
    const expCells = new Set<number>();
    for (let idx = 0; idx < nd.kind.length; idx++) {
      const m = a.data.progress[idx] & pieceMask(cellPieceCount(a.data, idx));
      if (!m) continue;
      for (let i = 0; i < 16; i++) {
        if (!((m >> i) & 1)) continue;
        const geomDiff = idx === lineIdx;
        const colorDiff = idx === fullIdx || pieceColorAt(nd, idx, i) === matColor;
        if (geomDiff || colorDiff) {
          expReset++;
          expCells.add(idx);
        }
      }
    }
    const res = carryOverProgress({ lp: a.lp, data: a.data, palette: a.palette }, { lp: b.lp, data: nd, palette });
    expect(res.report?.status).toBe('kept');
    expect(res.report?.reset).toBe(expReset);
    expect(res.report?.kept).toBe(laid - expReset);
    expect(res.report?.cellCount).toBe(expCells.size);
    expect(new Set(res.report?.cells)).toEqual(new Set([...expCells].slice(0, CARRY_MAX_CELLS)));
    expect(res.report?.cells).toContain(fullIdx);
    expect(res.report?.cells).toContain(lineIdx);
    expect(res.progress[fullIdx]).toBe(0);
    expect(res.progress[lineIdx]).toBe(0);
    expect(placedCount({ ...nd, progress: res.progress })).toBe(laid - expReset);
  });

  it('je Stein: bei einer Diagonale mit einer geänderten Hälfte bleibt die andere verlegt', () => {
    const a = computed('portrait');
    const idx = [...a.data.kind.keys()].find((i) => a.data.kind[i] === CellKind.DIAG_A || a.data.kind[i] === CellKind.DIAG_B)!;
    expect(idx).toBeDefined();
    setCellPlaced(a.data, idx, true);
    const b = computed('portrait');
    const nd = cloneData(b.data);
    const other = [...b.palette.keys()].find((k) => b.palette[k].hex !== b.palette[nd.c2[idx]].hex)!;
    nd.c2[idx] = other;
    const res = carryOverProgress({ lp: a.lp, data: a.data, palette: a.palette }, { lp: b.lp, data: nd, palette: b.palette });
    expect(res.progress[idx]).toBe(0b01);
    expect(res.report).toMatchObject({ kept: 1, reset: 1, cells: [idx], cellCount: 1 });
  });

  it('Palettenfarben werden verglichen, nie Indizes: umsortierte Palette → alles übernommen', () => {
    const a = computed('animal');
    const laid = layEveryThird(a.layout, a.data);
    const b = computed('animal');
    const nd = cloneData(b.data);
    const P = b.palette.length;
    // Palette umkehren und alle Indizes umrechnen – dieselben Farben an anderen Indizes
    const rev = (c: number) => P - 1 - c;
    const pal2 = [...b.palette].reverse();
    for (let i = 0; i < nd.c1.length; i++) {
      nd.c1[i] = rev(nd.c1[i]);
      nd.c2[i] = rev(nd.c2[i]);
    }
    for (const s of nd.sub.values()) for (let i = 0; i < s.length; i++) s[i] = rev(s[i]);
    const res = carryOverProgress({ lp: a.lp, data: a.data, palette: a.palette }, { lp: b.lp, data: nd, palette: pal2 });
    expect(res.report).toMatchObject({ status: 'kept', kept: laid, reset: 0 });
    // dagegen: gleiche Indizes, aber umgekehrte Palette → die Farben stimmen nicht mehr
    const wrong = carryOverProgress({ lp: a.lp, data: a.data, palette: a.palette }, { lp: b.lp, data: b.data, palette: pal2 });
    expect(wrong.report!.reset).toBeGreaterThan(laid / 2);
  });

  it('Freiform: nur bei exakt gleichen Polygonen übernommen', () => {
    const a = computed('animal');
    const row = 3;
    const col = 4;
    const idx = row * a.layout.cols + col;
    const polys = freePreset('half', a.layout.colW[col], a.layout.rowH[row], a.layout.joint)!;
    expect(setFreePieces(a.layout, a.data, row, col, polys.map((poly) => ({ poly, color: 1 })), 0.5).ok).toBe(true);
    setCellPlaced(a.data, idx, true);
    const same = cloneData(a.data);
    same.progress.fill(0);
    const moved = cloneData(same);
    moved.free.get(idx)![1].poly[0] = { x: moved.free.get(idx)![1].poly[0].x + 0.01, y: moved.free.get(idx)![1].poly[0].y };
    const base = { lp: a.lp, data: a.data, palette: a.palette };
    expect(carryOverProgress(base, { lp: a.lp, data: same, palette: a.palette }).progress[idx]).toBe(0b11);
    const r2 = carryOverProgress(base, { lp: a.lp, data: moved, palette: a.palette });
    expect(r2.progress[idx]).toBe(0);
    expect(r2.report).toMatchObject({ reset: 2, cells: [idx] });
  });

  it('gemeldete Zellen sind auf CARRY_MAX_CELLS begrenzt, die Anzahl bleibt exakt', () => {
    const a = computed('city');
    for (let i = 0; i < a.data.progress.length; i++) setCellPlaced(a.data, i, true);
    const b = computed('city');
    const pal2 = b.palette.map((p) => ({ ...p, hex: p.hex === '#000000' ? '#000001' : '#000000' }));
    const res = carryOverProgress({ lp: a.lp, data: a.data, palette: a.palette }, { lp: b.lp, data: b.data, palette: pal2 });
    expect(res.report!.kept).toBe(0);
    expect(res.report!.reset).toBe(progressOf(a.layout, a.data).placed);
    expect(res.report!.cellCount).toBe(a.data.progress.length);
    expect(res.report!.cells.length).toBe(CARRY_MAX_CELLS);
  });

  it('gespeicherter Stand als Grundlage nur bei passender Revision und gültigen Farbindizes', () => {
    const a = computed('animal');
    layEveryThird(a.layout, a.data);
    const { progress, ...mosaic } = packMosaic({ ...a.data, rev: 'r0' });
    const rec: ProjectRecord = {
      meta: { id: 'p', name: 'T', createdAt: 0, updatedAt: 0, computed: true },
      settings: { ...DEFAULT_SETTINGS, ...a.lp, shapes: { ...DEFAULT_SHAPES }, materialIds: [] },
      adjust: { ...DEFAULT_ADJUST },
      regions: [],
      palette: a.palette,
      computedWith: JSON.stringify({ l: a.lp }),
      mosaicRev: 'r0',
    };
    const base = carryBaseFromStored({ rec, mosaic, progress });
    expect(base?.rev).toBe('r0');
    expect(placedCount(base!.data)).toBe(progressOf(a.layout, a.data).placed);
    // andere Revision → kein Vergleich (nie gegen ein anderes Raster)
    expect(carryBaseFromStored({ rec: { ...rec, mosaicRev: 'r9' }, mosaic, progress })).toBeNull();
    // Palette zu kurz für die Farbindizes → kein Vergleich
    expect(carryBaseFromStored({ rec: { ...rec, palette: a.palette.slice(0, 2) }, mosaic, progress })).toBeNull();
  });
});

// ---------------------------------------------------------------- Projektlisten (db.ts)

function prec(meta: Partial<ProjectRecord['meta']> = {}, extra: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    meta: { id: 'p', name: 'T', createdAt: 0, updatedAt: 0, computed: true, ...meta },
    settings: { ...DEFAULT_SETTINGS, shapes: { ...DEFAULT_SHAPES }, materialIds: [] },
    adjust: { ...DEFAULT_ADJUST },
    regions: [],
    palette: [],
    mosaicRev: 'r1',
    ...extra,
  };
}

describe('Fortschritt in Projektlisten', () => {
  it('nur mit Zahlen zum gespeicherten Raster; sonst nichts (nie geschätzt)', () => {
    expect(listProgressOf(prec({ progressSummary: { placed: 5, total: 20, rev: 'r1' } }))).toEqual({ placed: 5, total: 20 });
    expect(listProgressOf(prec())).toBeNull(); // ältere Projekte: kein Wert
    expect(listProgressOf(prec({ progressSummary: { placed: 5, total: 20, rev: 'r0' } }))).toBeNull(); // anderes Raster
    expect(listProgressOf(prec({ computed: false, progressSummary: { placed: 5, total: 20, rev: 'r1' } }))).toBeNull();
    expect(listProgressOf(prec({ progressSummary: { placed: 21, total: 20, rev: 'r1' } }))).toBeNull();
    expect(listProgressOf(prec({ progressSummary: { placed: 1.5, total: 20, rev: 'r1' } }))).toBeNull();
    expect(listProgressOf(prec({ progressSummary: { placed: 0, total: 0, rev: 'r1' } }))).toBeNull();
    // ältere Projekte ohne Revision: Zahlen ohne Revision gelten
    expect(listProgressOf(prec({ progressSummary: { placed: 2, total: 4 } }, { mosaicRev: undefined }))).toEqual({ placed: 2, total: 4 });
  });

  it('Prozent abgerundet: 100 % erst mit dem letzten Stein, ein Stein nie „0 %“', () => {
    expect(laidPercent(0, 10)).toEqual({ pct: 0, lessThanOne: false });
    expect(laidPercent(1, 1_000_000)).toEqual({ pct: 0, lessThanOne: true });
    expect(laidPercent(1526, 5969)).toEqual({ pct: 25, lessThanOne: false });
    expect(laidPercent(9999, 10000)).toEqual({ pct: 99, lessThanOne: false });
    expect(laidPercent(10000, 10000)).toEqual({ pct: 100, lessThanOne: false });
  });

  it('Berechnen setzt Fortschritt und Übernahme-Bericht des neuen Rasters; ohne Angabe werden alte Werte entfernt', () => {
    const latest = prec({ progressSummary: { placed: 7, total: 9, rev: 'r1' } }, { lastCarryOver: { status: 'kept', kept: 1, reset: 0, cells: [], cellCount: 0, rev: 'r1', at: 1 } });
    const f: ComputeFields = { palette: [], computedWith: '{}', mosaicRev: 'r2', updatedAt: 5 };
    const cleared = mergeComputeFields(latest, f);
    expect('progressSummary' in cleared.meta).toBe(false);
    expect('lastCarryOver' in cleared).toBe(false);
    const set = mergeComputeFields(latest, { ...f, progressSummary: { placed: 3, total: 9, rev: 'r2' }, carryOver: { status: 'kept', kept: 3, reset: 4, cells: [1], cellCount: 1, rev: 'r2', at: 5 } });
    expect(set.meta.progressSummary).toEqual({ placed: 3, total: 9, rev: 'r2' });
    expect(set.lastCarryOver?.reset).toBe(4);
    // fremdes, neueres Raster: dessen Werte gelten (nie die des eigenen, veralteten Rasters)
    const mine = prec({ name: 'Neu', progressSummary: { placed: 7, total: 9, rev: 'r1' } });
    const kept = keepStoredComputeFields(mine, set);
    expect(kept.meta.name).toBe('Neu');
    expect(kept.meta.progressSummary).toEqual({ placed: 3, total: 9, rev: 'r2' });
    expect(kept.lastCarryOver?.rev).toBe('r2');
    expect('progressSummary' in keepStoredComputeFields(mine, cleared).meta).toBe(false);
  });
});

// ---------------------------------------------------------------- Pflichtfarben

const ENV: ComputeEnv = { bitmap: null, bw: 1200, bh: 1600, srcW: 1200, srcH: 1600, reduced: false, hasOriginal: true, materials: [], lang: 'de' };

function srec(patch: Partial<ProjectRecord['settings']> = {}): ProjectRecord {
  return { ...prec({ computed: false }, { mosaicRev: undefined, imageRev: 'img' }), settings: { ...DEFAULT_SETTINGS, shapes: { ...DEFAULT_SHAPES }, materialIds: [], ...patch } };
}

describe('Pflichtfarben erreichen die Berechnung', () => {
  it('pinnedFixedColors: HEX normalisiert, Lab aus HEX, ungültige und doppelte entfernt, nur Automatik-Modi', () => {
    const list = [{ hex: '#1d1f1b', name: 'Pupille' }, { hex: 'abc' }, { hex: '#1D1F1B' }, { hex: 'xyz' }, { hex: '  #FFFFFF ', name: '  ' }];
    const out = pinnedFixedColors({ paletteMode: 'auto', pinnedColors: list })!;
    expect(out.map((f) => f.hex)).toEqual(['#1D1F1B', '#AABBCC', '#FFFFFF']);
    expect(out[0]).toEqual({ hex: '#1D1F1B', lab: hexToLab('#1D1F1B'), name: 'Pupille' });
    expect(out[2].name).toBe('#FFFFFF');
    expect(pinnedFixedColors({ paletteMode: 'auto-snap', pinnedColors: list })?.length).toBe(3);
    expect(pinnedFixedColors({ paletteMode: 'materials', pinnedColors: list })).toBeUndefined();
    expect(pinnedFixedColors({ paletteMode: 'custom', pinnedColors: list })).toBeUndefined();
    expect(pinnedFixedColors({ paletteMode: 'auto', pinnedColors: [] })).toBeUndefined();
    expect(pinnedFixedColors({ paletteMode: 'auto' })).toBeUndefined();
  });

  it('describeComputeInputs: Pflichtfarben in der Worker-Anfrage; ohne sie bleibt der Fingerabdruck unverändert', () => {
    const plain = describeComputeInputs(srec(), ENV);
    const empty = describeComputeInputs(srec({ pinnedColors: [] }), ENV);
    const pinned = describeComputeInputs(srec({ pinnedColors: [{ hex: '#101010' }] }), ENV);
    if (!plain.ok || !empty.ok || !pinned.ok) throw new Error('Eingaben ungültig');
    expect('pinnedColors' in plain.request.params).toBe(false);
    expect(empty.sig).toBe(plain.sig);
    expect(pinned.request.params.pinnedColors).toEqual([{ hex: '#101010', lab: hexToLab('#101010'), name: '#101010' }]);
    expect(pinned.sig).not.toBe(plain.sig);
    // in Modi ohne Wirkung: keine Pflichtfarben, gleicher Fingerabdruck
    const custom = describeComputeInputs(srec({ paletteMode: 'custom', pinnedColors: [{ hex: '#101010' }] }), ENV);
    expect(custom.ok).toBe(false); // eigene Palette leer → 'no-palette' (unverändertes Verhalten)
  });
});
