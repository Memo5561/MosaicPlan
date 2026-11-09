/**
 * w5-stats-engine: Gesamt-, Abschnitts-, Farb- und Materialzahlen aus EINEM Durchlauf (computeAllStats).
 *
 * Maßstab ist die eingefrorene frühere Zählung in tests/w5-stats-engine.reference.ts (je Bereich ein Durchlauf,
 * Textschlüssel im Cache). Für das ganze Mosaik und jeden Abschnitt müssen die Ergebnisse JSON-gleich sein – auch
 * bei Gleitkommasummen und der Reihenfolge in perSize. Dazu: neue Prüfzähler (overlapCells, thinPieces,
 * thinFreePieces, invalidPieces) gegen eine unabhängige Nachrechnung, und der Statistik-Auftrag im Worker.
 */
import { describe, expect, it } from 'vitest';
import { rectPoly } from '../src/core/geometry';
import { setCellKind, setFreePieces } from '../src/core/edits';
import { computeLayout, computeSections, computeSectionsByCount, sectionsFor, type Layout, type SectionGrid } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { analyzeCut, cellPieces, pieceWidthCheck } from '../src/core/pieces';
import { packMosaic } from '../src/core/serialize';
import { computeAllStats, computeStats, CutCache, type Stats } from '../src/core/stats';
import { CellKind, createEmptyMosaic, DEFAULT_SETTINGS, DEFAULT_SHAPES, type Material, type MosaicData, type PaletteColor } from '../src/core/types';
import { baseParams, sampleSetup } from './w1-mosaic-core.fixtures';
import { randomCase, refComputeStats, RefCutCache, rng, withoutNewCounters, type RandomCase } from './w5-stats-engine.reference';

const OPTS = { reservePct: 10, groutDepthMm: 3 };
const J = (s: Stats) => JSON.stringify(withoutNewCounters(s));
const R = (s: Stats) => JSON.stringify(s);

/** Alle Vergleiche gegen die frühere Zählung für ein Mosaik und ein Abschnittsraster. */
function expectEquivalent(c: RandomCase, grid: SectionGrid, opts: { reservePct: number; groutDepthMm: number } = OPTS) {
  const { layout, data, palette, materials } = c;
  // früher im Worker: Gesamt, dann je Abschnitt mit DEMSELBEN Cache
  const rc = new RefCutCache();
  const refTotal = refComputeStats(layout, data, palette, materials, opts, undefined, rc);
  const refSec = grid.sections.map((s) => refComputeStats(layout, data, palette, materials, opts, s, rc));

  const all = computeAllStats(layout, data, palette, materials, opts, grid);
  expect(J(all.total)).toBe(R(refTotal));
  expect(all.perSection).toHaveLength(grid.sections.length);
  let bad = 0;
  all.perSection.forEach((s, i) => {
    if (J(s) !== R(refSec[i])) bad++;
  });
  expect(bad).toBe(0);
  // mit Mindestbreite: dieselben Zahlen, nur zusätzlich die Prüfzähler
  const allMin = computeAllStats(layout, data, palette, materials, { ...opts, minPieceMm: 2 }, grid);
  expect(J(allMin.total)).toBe(R(refTotal));
  allMin.perSection.forEach((s, i) => expect(J(s)).toBe(R(refSec[i])));

  // computeStats (dünne Hülle) je Bereich mit eigenem Cache = frühere Zählung mit eigenem Cache
  for (const s of grid.sections.slice(0, 6)) expect(J(computeStats(layout, data, palette, materials, opts, s))).toBe(R(refComputeStats(layout, data, palette, materials, opts, s)));
  // … und mit gemeinsamem Cache (so ruft generatePdf auf): Gesamt zuerst, dann die Abschnitte
  const cache = new CutCache();
  expect(J(computeStats(layout, data, palette, materials, opts, undefined, cache))).toBe(R(refTotal));
  grid.sections.forEach((s, i) => expect(J(computeStats(layout, data, palette, materials, opts, s, cache))).toBe(R(refSec[i])));
  return { all, allMin, refTotal, refSec };
}

describe('Einzeldurchlauf = frühere Zählung (Gesamt und jeder Abschnitt, JSON-gleich)', () => {
  it('Zufallsmosaike: alle Zellarten, Rand-Schnittsteine, Rohsteinmaße, Fortschritt, Freiform, Sonderfälle', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const c = randomCase(seed, { cols: 14 + (seed % 13), rows: 10 + (seed % 9), oddities: seed % 4 !== 0 });
      const grid = seed % 3 === 0 ? computeSectionsByCount(c.layout, 1 + (seed % 4), 1 + (seed % 3)) : computeSections(c.layout, 30 + (seed % 5) * 17, 25 + (seed % 7) * 11);
      expectEquivalent(c, grid, { reservePct: seed % 5 === 0 ? 0 : 7.5 + seed, groutDepthMm: 2 + (seed % 3) });
    }
  });

  it('alle Randmodi und Steinformate (auch rechteckige Steine)', () => {
    let seed = 100;
    for (const edgeMode of ['whole', 'cut-end', 'cut-both'] as const)
      for (const [tileW, tileH] of [
        [5, 5],
        [4, 8],
        [10, 6],
      ])
        for (const joint of [0.5, 2]) {
          const c = randomCase(seed++, { cols: 17, rows: 13, tileW, tileH, joint, edgeMode, cutShare: 0.7, oddities: true });
          expectEquivalent(c, computeSections(c.layout, 60, 45));
        }
  });

  it('Porträt-Beispiel aus computeMosaic + manuelle Änderungen (Kantenschnitt mit beliebigem Winkel/Versatz, Teilsteine, Dreiecke, Freiform)', () => {
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su));
    const L = su.layout;
    const d = res.data;
    const R0 = rng(7);
    let edits = 0;
    for (let n = 0; n < 400; n++) {
      const row = Math.floor(R0() * L.rows);
      const col = Math.floor(R0() * L.cols);
      const x = R0();
      const ch =
        x < 0.4
          ? { kind: CellKind.LINE, angleDeg: Math.round((R0() * 360 - 180) * 100) / 100, offsetMm: Math.round((R0() * 2 - 1) * 1.5 * 100) / 100 }
          : x < 0.6
            ? { kind: CellKind.SUB, k: (R0() < 0.5 ? 2 : 3) as 2 | 3 }
            : x < 0.8
              ? { kind: R0() < 0.5 ? CellKind.DIAG_A : CellKind.DIAG_B }
              : { kind: CellKind.FULL };
      if (!setCellKind(L, d, row, col, ch, 1)) edits++;
    }
    for (let n = 0; n < 20; n++) {
      const row = Math.floor(R0() * L.rows);
      const col = Math.floor(R0() * L.cols);
      const w = L.colW[col];
      const h = L.rowH[row];
      const v = setFreePieces(L, d, row, col, [{ poly: rectPoly(0, 0, w * 0.45, h), color: 0 }, { poly: [{ x: w * 0.6, y: 0 }, { x: w, y: 0 }, { x: w, y: h }], color: 1 }], 1);
      if (v.ok) edits++;
    }
    for (let i = 0; i < d.progress.length; i += 3) d.progress[i] = Math.floor(R0() * 16);
    expect(edits).toBeGreaterThan(200);
    const mats: Material[] = [
      { id: 'a', type: 'glass', manufacturer: 'T', product: 'G', colorNumber: '1', colorName: 'a', hex: '#000000', lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 5, packageSize: '', piecesPerPack: 100, stock: 50 },
      { id: 'b', type: 'glass', manufacturer: 'T', product: 'G', colorNumber: '2', colorName: 'b', hex: '#ffffff', lengthMm: 7.3, widthMm: 5.2, thicknessMm: 4, price: 0, packageSize: '', piecesPerPack: 0 },
    ];
    const palette: PaletteColor[] = res.palette.map((p, i) => ({ ...p, materialId: i % 3 === 0 ? 'a' : i % 3 === 1 ? 'b' : undefined }));
    const c: RandomCase = { layout: L, data: d, palette, materials: mats };
    expectEquivalent(c, computeSections(L, 80, 60));
    expectEquivalent(c, sectionsFor(L, DEFAULT_SETTINGS));
  });

  it('Kantenschnitte, deren frühere Textschlüssel gleich sind, bekommen weiterhin dieselbe Schnittinfo (keine Abweichung)', () => {
    const L = computeLayout({ widthMm: 6 * 10 + 5, heightMm: 10, tileW: 10, tileH: 10, joint: 1, edgeMode: 'whole', minCutMm: 1 });
    const d = createEmptyMosaic(L.cols, L.rows);
    const a = (35 * Math.PI) / 180;
    // gleiche Werte bis auf die 5. bzw. 3. Nachkommastelle, aber verschiedene Float32-Bitmuster
    const params = [
      [Math.cos(a), Math.sin(a), 0.1231],
      [Math.cos(a) + 2e-7, Math.sin(a) - 2e-7, 0.1234],
      [Math.cos(a), Math.sin(a), 0.1236],
      [Math.cos(a), Math.sin(a), -2.5],
      [Math.cos(a), Math.sin(a), 0.1231],
    ];
    params.forEach((p, i) => {
      d.kind[i] = CellKind.LINE;
      d.line.set(i, new Float32Array(p));
      d.c1[i] = 0;
      d.c2[i] = 1;
    });
    const palette = [0, 1].map((i) => ({ code: i + 1, name: `F${i}`, hex: '#808080', lab: [50, 0, 0] as [number, number, number] }));
    const c: RandomCase = { layout: L, data: d, palette, materials: [] };
    const { all } = expectEquivalent(c, computeSections(L, 25, 20));
    expect(all.total.pieces).toBe(params.length * 2 + 1);
  });
});

describe('Gesamt im selben Durchlauf, Abschnitte summieren sich', () => {
  it('ganzzahlige Zähler: Σ Abschnitte = Gesamt; Flächen bis auf Rundung; Rohsteine je Abschnitt ≥ Gesamt', () => {
    for (let seed = 200; seed < 210; seed++) {
      const c = randomCase(seed, { cols: 30, rows: 22, oddities: true });
      const grid = computeSections(c.layout, 50, 40);
      const { total, perSection } = computeAllStats(c.layout, c.data, c.palette, c.materials, { ...OPTS, minPieceMm: 2 }, grid);
      const sum = (f: (s: Stats) => number) => perSection.reduce((a, s) => a + f(s), 0);
      for (const k of ['gridPositions', 'pieces', 'placed', 'cutPieces', 'uncutPieces', 'notFitting', 'invalidColorPieces', 'invalidPieces', 'invalidFreeCells', 'overlapCells', 'thinPieces', 'thinFreePieces'] as const)
        expect(sum((s) => s[k] as number)).toBe(total[k]);
      for (const sh of Object.keys(total.perShape) as (keyof Stats['perShape'])[]) expect(sum((s) => s.perShape[sh])).toBe(total.perShape[sh]);
      total.perColor.forEach((cs, i) => {
        expect(sum((s) => s.perColor[i].pieces)).toBe(cs.pieces);
        expect(sum((s) => s.perColor[i].placed)).toBe(cs.placed);
        expect(sum((s) => s.perColor[i].cut)).toBe(cs.cut);
        expect(sum((s) => s.perColor[i].raw)).toBeGreaterThanOrEqual(cs.raw);
        expect(Math.abs(sum((s) => s.perColor[i].area) - cs.area)).toBeLessThanOrEqual(1e-9 * Math.max(1, cs.area));
      });
      for (const ps of total.perSize) expect(sum((s) => s.perSize.find((x) => x.key === ps.key)?.count ?? 0)).toBe(ps.count);
      expect(Math.abs(sum((s) => s.stoneArea) - total.stoneArea)).toBeLessThanOrEqual(1e-9 * total.stoneArea);
    }
  });

  it('Randfälle: leere Palette (alle Farben ungültig), 1 × 1-Raster, ein einziger Abschnitt', () => {
    const c = randomCase(11, { cols: 9, rows: 7, oddities: true });
    expectEquivalent({ ...c, palette: [] }, computeSections(c.layout, 30, 30));
    const L = computeLayout({ widthMm: 5, heightMm: 5, tileW: 5, tileH: 5, joint: 1, edgeMode: 'whole', minCutMm: 1 });
    const d = createEmptyMosaic(1, 1);
    d.kind[0] = CellKind.SUB;
    d.sub.set(0, new Uint16Array([0, 1, 0, 1]));
    d.progress[0] = 0b1010;
    const palette = [0, 1].map((i) => ({ code: i + 1, name: `F${i}`, hex: '#808080', lab: [50, 0, 0] as [number, number, number] }));
    expectEquivalent({ layout: L, data: d, palette, materials: [] }, computeSections(L, 100, 100));
  });

  it('ohne Abschnittsraster nur die Gesamtstatistik', () => {
    const c = randomCase(5, { cols: 12, rows: 9 });
    const a = computeAllStats(c.layout, c.data, c.palette, c.materials, OPTS);
    expect(a.perSection).toEqual([]);
    expect(J(a.total)).toBe(R(refComputeStats(c.layout, c.data, c.palette, c.materials, OPTS)));
  });
});

/** Unabhängige Nachrechnung der neuen Prüfzähler direkt aus cellPieces/analyzeCut/pieceWidthCheck. */
function bruteCounters(L: Layout, d: MosaicData, min: number) {
  let overlap = 0;
  let thin = 0;
  let thinFree = 0;
  let invalid = 0;
  for (let row = 0; row < L.rows; row++)
    for (let col = 0; col < L.cols; col++) {
      const kind = d.kind[row * L.cols + col];
      const ps = cellPieces(L, d, row, col);
      let sum = 0;
      for (const p of ps) {
        const ci = analyzeCut(p.poly, L.tileW, L.tileH);
        if (ci.invalid) {
          invalid++;
          continue;
        }
        sum += ci.area;
        const ok = pieceWidthCheck(p.poly, min).ok;
        if (kind === CellKind.FREE) thinFree += ok ? 0 : 1;
        else if (kind === CellKind.DIAG_A || kind === CellKind.DIAG_B || kind === CellKind.LINE || kind === CellKind.SUB) thin += ok ? 0 : 1;
      }
      const ca = L.colW[col] * L.rowH[row];
      if (sum > ca + 1e-6 + ca * 1e-9) overlap++;
    }
  return { overlap, thin, thinFree, invalid };
}

describe('Neue Prüfzähler', () => {
  it('overlapCells, thinPieces, thinFreePieces, invalidPieces = unabhängige Nachrechnung (Zufallsmosaike)', () => {
    for (let seed = 300; seed < 316; seed++) {
      const c = randomCase(seed, { cols: 20, rows: 15, oddities: true, cutShare: 0.6 });
      const min = [1, 1.5, 2, 3][seed % 4];
      const s = computeStats(c.layout, c.data, c.palette, c.materials, { ...OPTS, minPieceMm: min });
      const b = bruteCounters(c.layout, c.data, min);
      expect(s.overlapCells).toBe(b.overlap);
      expect(s.thinPieces).toBe(b.thin);
      expect(s.thinFreePieces).toBe(b.thinFree);
      expect(s.invalidPieces).toBe(b.invalid);
    }
  });

  it('ohne Mindestbreite: thinPieces/thinFreePieces nicht geprüft (undefined statt 0); overlapCells immer gesetzt', () => {
    const c = randomCase(9, { cols: 10, rows: 8, oddities: true });
    const s = computeStats(c.layout, c.data, c.palette, c.materials, OPTS);
    expect(s.thinPieces).toBeUndefined();
    expect(s.thinFreePieces).toBeUndefined();
    expect(typeof s.overlapCells).toBe('number');
    expect('thinPieces' in s).toBe(false);
    for (const bad of [NaN, -1, Infinity]) expect(computeStats(c.layout, c.data, c.palette, c.materials, { ...OPTS, minPieceMm: bad }).thinPieces).toBeUndefined();
  });

  it('berechnete Mosaike: kein automatisches Teil unter der Mindestbreite, keine Überlappung', () => {
    for (const key of ['portrait', 'animal']) {
      const su = sampleSetup(key);
      const res = computeMosaic(su.img, baseParams(su));
      const s = computeStats(su.layout, res.data, res.palette, [], { ...OPTS, minPieceMm: DEFAULT_SHAPES.minPieceMm });
      expect(s.cutPieces).toBeGreaterThan(0);
      expect(s.thinPieces).toBe(0);
      expect(s.thinFreePieces).toBe(0);
      expect(s.overlapCells).toBe(0);
      expect(s.invalidPieces).toBe(0);
      // mit größerer Mindestbreite werden die schmalen Teile gezählt – genau wie pieceWidthCheck
      const s4 = computeStats(su.layout, res.data, res.palette, [], { ...OPTS, minPieceMm: 4 });
      expect(s4.thinPieces).toBe(bruteCounters(su.layout, res.data, 4).thin);
    }
  });

  it('gezielte Fälle: zu schmales Dreieck am Rand, überlappende Freiformteile, Dreiecksteilung mit zu breiter Fuge', () => {
    // 3 ganze 8-mm-Steine + Randstreifen 2 mm (cut-end), Fuge 1 mm
    const L = computeLayout({ widthMm: 3 * 8 + 3 * 1 + 2, heightMm: 8, tileW: 8, tileH: 8, joint: 1, edgeMode: 'cut-end', minCutMm: 1 });
    expect(L.cols).toBe(4);
    expect(L.colW[3]).toBeCloseTo(2, 9);
    const d = createEmptyMosaic(L.cols, L.rows);
    d.kind[3] = CellKind.DIAG_A; // Dreiecke im 2-mm-Randstreifen: schmaler als 2 mm
    d.kind[0] = CellKind.FREE;
    d.free.set(0, [
      { poly: rectPoly(0, 0, 5, 8), color: 0 },
      { poly: rectPoly(3, 0, 5, 8), color: 0 },
    ]);
    d.kind[1] = CellKind.DIAG_B;
    const palette = [{ code: 1, name: 'F1', hex: '#808080', lab: [50, 0, 0] as [number, number, number] }];
    const s = computeStats(L, d, palette, [], { ...OPTS, minPieceMm: 2 });
    expect(s.overlapCells).toBe(1);
    expect(s.invalidFreeCells).toBe(1);
    expect(s.thinPieces).toBe(2);
    expect(s.invalidPieces).toBe(0);
    // Fuge breiter als der Randstreifen: beide Dreiecke ohne Fläche → keine Steine, nur gemeldet
    const L2 = computeLayout({ widthMm: 8 + 3 + 1, heightMm: 8, tileW: 8, tileH: 8, joint: 3, edgeMode: 'cut-end', minCutMm: 1 });
    const d2 = createEmptyMosaic(L2.cols, L2.rows);
    d2.kind[1] = CellKind.DIAG_A;
    const s2 = computeStats(L2, d2, palette, [], { ...OPTS, minPieceMm: 2 });
    expect(s2.invalidPieces).toBe(2);
    expect(s2.pieces).toBe(1);
    expect(s2.thinPieces).toBe(0);
  });
});

describe('Statistik-Auftrag im Worker', () => {
  it('ein Durchlauf liefert Gesamt und je Abschnitt (id und Reihenfolge wie sectionsFor), minPieceMm wird durchgereicht', async () => {
    const posted: { type: string; total?: Stats; perSection?: { id: string; stats: Stats }[]; message?: string }[] = [];
    const g = globalThis as unknown as { self?: { postMessage: (m: unknown) => void; onmessage?: (ev: { data: unknown }) => Promise<void> } };
    const prevSelf = g.self;
    g.self = { postMessage: (m) => posted.push(m as (typeof posted)[number]) };
    try {
      await import('../src/workers/compute.worker');
      const handler = g.self.onmessage;
      expect(typeof handler).toBe('function');
      const lp = { widthMm: 24 * 6 + 23 + 3, heightMm: 18 * 6 + 17 + 2, tileW: 6, tileH: 6, joint: 1, edgeMode: 'cut-end' as const, minCutMm: 1 };
      const layout = computeLayout(lp);
      const c = randomCase(77, { cols: 24, rows: 18, tileW: 6, tileH: 6, joint: 1, edgeMode: 'whole', oddities: true });
      // gleiches Mosaik-Raster wie das Worker-Layout (Zellen neu anlegen, Arten übernehmen, soweit vorhanden)
      const d = createEmptyMosaic(layout.cols, layout.rows);
      for (let row = 0; row < Math.min(layout.rows, c.layout.rows); row++)
        for (let col = 0; col < Math.min(layout.cols, c.layout.cols); col++) {
          const i = row * layout.cols + col;
          const j = row * c.layout.cols + col;
          d.kind[i] = c.data.kind[j] === CellKind.FREE || c.data.kind[j] > CellKind.FREE ? CellKind.FULL : c.data.kind[j];
          d.c1[i] = c.data.c1[j];
          d.c2[i] = c.data.c2[j];
          d.progress[i] = c.data.progress[j];
          const ln = c.data.line.get(j);
          if (ln) d.line.set(i, ln);
          const sb = c.data.sub.get(j);
          if (sb) d.sub.set(i, sb);
        }
      const sections = { sectionMode: 'size' as const, sectionWmm: 50, sectionHmm: 40 };
      const base = { type: 'stats', layoutParams: lp, palette: c.palette, materials: c.materials, reservePct: 10, groutDepthMm: 3 };
      await handler!({ data: { ...base, id: 1, mosaic: packMosaic(d), minPieceMm: 2, sections } });
      await handler!({ data: { ...base, id: 2, mosaic: packMosaic(d) } });
      expect(posted.map((p) => p.type)).toEqual(['stats', 'stats']);
      const grid = sectionsFor(layout, sections);
      const exp = computeAllStats(layout, d, c.palette, c.materials, { ...OPTS, minPieceMm: 2 }, grid);
      expect(R(posted[0].total!)).toBe(R(exp.total));
      expect(posted[0].total!.thinPieces).toBe(exp.total.thinPieces);
      expect(posted[0].perSection!.map((x) => x.id)).toEqual(grid.sections.map((s) => s.id));
      posted[0].perSection!.forEach((x, i) => expect(R(x.stats)).toBe(R(exp.perSection[i])));
      // ohne Abschnitte und ohne Mindestbreite: nur Gesamt, Prüfzähler für die Mindestbreite nicht gesetzt
      expect(posted[1].perSection).toEqual([]);
      expect(posted[1].total!.thinPieces).toBeUndefined();
      expect(J(posted[1].total!)).toBe(R(refComputeStats(layout, d, c.palette, c.materials, OPTS)));
    } finally {
      g.self = prevSelf;
    }
  });
});

describe('Laufzeit (grober Schutz gegen Rückschritte)', () => {
  it('Gesamt + Abschnitte in einem Durchlauf: höchstens halb so lang wie die frühere Zählung', () => {
    const c = randomCase(4242, { cols: 220, rows: 220, tileW: 6, tileH: 6, joint: 1, edgeMode: 'cut-end', cutShare: 0.3, generatorLinesOnly: true });
    const grid = computeSections(c.layout, 120, 120);
    const best = (f: () => void) => {
      let m = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        f();
        m = Math.min(m, performance.now() - t0);
      }
      return m;
    };
    const old = best(() => {
      const rc = new RefCutCache();
      refComputeStats(c.layout, c.data, c.palette, c.materials, OPTS, undefined, rc);
      for (const s of grid.sections) refComputeStats(c.layout, c.data, c.palette, c.materials, OPTS, s, rc);
    });
    const now = best(() => computeAllStats(c.layout, c.data, c.palette, c.materials, OPTS, grid));
    expect(now).toBeLessThan(old / 2);
  });
});
