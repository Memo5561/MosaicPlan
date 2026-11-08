/**
 * Schneidbare Teile und ehrliche Schnittanweisungen (Arbeitspaket w1-cut-correctness):
 * Mindestbreite als echte schmalste Stelle, geprüfte Dreiecksteilung, keine ±Infinity bei leeren
 * Teilen, keine Schnittlinien durch nicht-konvexe Steine.
 */
import { describe, expect, it } from 'vitest';
import {
  area,
  bbox,
  cleanPoly,
  convexHull,
  distToBoundary,
  edgeLengths,
  edgeOnRectBoundary,
  interiorAngles,
  isConvex,
  lineThroughRect,
  minCaliperWidth,
  minInteriorAngle,
  pointStrictlyInside,
  rectPoly,
  rotate90,
  translate,
  DIM_TOL,
  type Pt,
} from '../src/core/geometry';
import { applyAdjustments } from '../src/core/imageOps';
import { computeLayout, type EdgeMode, type Layout } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import {
  analyzeCut,
  cellPieces,
  cutLinesFor,
  diagA,
  diagB,
  isDegeneratePiece,
  lineSplit,
  pieceCuttable,
  subdivisionCuttable,
  subRects,
  type CutInfo,
} from '../src/core/pieces';
import { allowedCellKinds, checkCellKind, repairDegenerateCells, sameCellKind, setCellKind, type KindChange } from '../src/core/edits';
import { computeStats } from '../src/core/stats';
import { CellKind, createEmptyMosaic, DEFAULT_ADJUST, DEFAULT_SHAPES, type MosaicData, type Region } from '../src/core/types';
import { dictionaries, makeT, numberFormatter } from '../src/i18n';
import { loadPng, prepareFor } from './helpers';

// ---------------------------------------------------------------- Hilfen

/** Bisheriges Kriterium (vor diesem Paket) – zum Nachweis, dass nur verschärft wird. */
function oldPieceCuttable(poly: Pt[], minPieceMm: number): boolean {
  if (poly.length < 3) return false;
  const A = area(poly);
  const P = edgeLengths(poly).reduce((s, v) => s + v, 0);
  if (P <= 0) return false;
  return (2 * A) / P >= minPieceMm / 2 - 1e-9;
}

/** Bisherige Schnittlinien + Platzierung (vor diesem Paket), um konvexe Ergebnisse 1:1 zu vergleichen. */
function oldCutLinesFor(polyInRaw: Pt[], W: number, H: number): [Pt, Pt][] {
  const lines: [Pt, Pt][] = [];
  const n = polyInRaw.length;
  for (let i = 0; i < n; i++) {
    const a = polyInRaw[i];
    const b = polyInRaw[(i + 1) % n];
    if (edgeOnRectBoundary(a, b, W, H)) continue;
    const seg = lineThroughRect(a, b, W, H);
    if (!seg) continue;
    const dup = lines.some(([p, q]) => {
      const cr1 = (q.x - p.x) * (seg[0].y - p.y) - (q.y - p.y) * (seg[0].x - p.x);
      const cr2 = (q.x - p.x) * (seg[1].y - p.y) - (q.y - p.y) * (seg[1].x - p.x);
      return Math.abs(cr1) < 1e-6 && Math.abs(cr2) < 1e-6;
    });
    if (!dup) lines.push(seg);
  }
  return lines;
}
function oldPlacement(polyAbs: Pt[], rawW: number, rawH: number): { poly: Pt[]; lines: [Pt, Pt][]; rotated: boolean } | null {
  const poly = cleanPoly(polyAbs);
  let best: { poly: Pt[]; lines: [Pt, Pt][]; rotated: boolean } | null = null;
  for (const rotated of [false, true]) {
    const src = rotated ? rotate90(poly) : poly;
    const sb = bbox(src);
    if (sb.w > rawW + DIM_TOL || sb.h > rawH + DIM_TOL) continue;
    const base = translate(src, -sb.minX, -sb.minY);
    for (const dx of [0, rawW - sb.w])
      for (const dy of [0, rawH - sb.h]) {
        const cand = translate(base, dx, dy);
        const lines = oldCutLinesFor(cand, rawW, rawH);
        if (!best || lines.length < best.lines.length) best = { poly: cand, lines, rotated };
      }
  }
  return best;
}

/** Deterministischer Zufall */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Raster mit 3 × 3 ganzen Steinen; die mittlere Zelle (1,1) wird geprüft. */
function grid3(tileW: number, tileH: number, joint: number, edgeMode: EdgeMode = 'whole'): { layout: Layout; data: MosaicData } {
  const layout = computeLayout({ widthMm: 3 * tileW + 2 * joint, heightMm: 3 * tileH + 2 * joint, tileW, tileH, joint, edgeMode, minCutMm: 1 });
  const data = createEmptyMosaic(layout.cols, layout.rows);
  for (let i = 0; i < data.c1.length; i++) data.c1[i] = 3;
  return { layout, data };
}

/** Kein Punkt einer Schnittlinie darf echt im Stein liegen (dichte Abtastung). */
function cutViolations(info: CutInfo, samples = 400): string[] {
  const out: string[] = [];
  info.cutLines.forEach(([a, b], i) => {
    for (let k = 0; k <= samples; k++) {
      const t = k / samples;
      const p = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      if (pointStrictlyInside(p, info.polyInRaw, 1e-6)) {
        out.push(`Linie ${i + 1} bei (${p.x.toFixed(3)}|${p.y.toFixed(3)})`);
        break;
      }
    }
  });
  return out;
}

/** Jede Kante, die nicht auf dem Rohsteinrand liegt, muss vollständig auf einer Schnittlinie liegen. */
function uncoveredEdges(info: CutInfo): number[] {
  const P = info.polyInRaw;
  const onSeg = (p: Pt, a: Pt, b: Pt) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy);
    const cr = Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / l;
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (l * l);
    return cr < 1e-6 && t > -1e-6 && t < 1 + 1e-6;
  };
  const res: number[] = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[i];
    const b = P[(i + 1) % P.length];
    if (edgeOnRectBoundary(a, b, info.rawW, info.rawH)) continue;
    if (!info.cutLines.some(([p, q]) => onSeg(a, p, q) && onSeg(b, p, q))) res.push(i);
  }
  return res;
}

const finiteNumbers = (info: CutInfo) =>
  [info.w, info.h, info.area, info.rawW, info.rawH, info.yieldPerRaw, ...info.edges, ...info.angles, ...info.polyInRaw.flatMap((p) => [p.x, p.y]), ...info.cutLines.flatMap(([a, b]) => [a.x, a.y, b.x, b.y])].every(
    (v) => Number.isFinite(v),
  );

// Nicht-konvexe Prüfformen (Koordinaten im 10 × 10-mm-Rohstein)
const L_SHAPE: Pt[] = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 4 },
  { x: 10, y: 4 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];
const U_SHAPE: Pt[] = [
  { x: 0, y: 0 },
  { x: 3, y: 0 },
  { x: 3, y: 6 },
  { x: 7, y: 6 },
  { x: 7, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];
const CHEVRON: Pt[] = [
  { x: 0, y: 0 },
  { x: 5, y: 4 },
  { x: 10, y: 0 },
  { x: 10, y: 6 },
  { x: 5, y: 10 },
  { x: 0, y: 6 },
];
/** zwei Taschen gleicher Tiefe (kollineare Taschenböden) */
const COMB: Pt[] = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 5 },
  { x: 4, y: 5 },
  { x: 4, y: 0 },
  { x: 6, y: 0 },
  { x: 6, y: 5 },
  { x: 8, y: 5 },
  { x: 8, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];
/** L-Stein, kleiner als der Rohstein (liegt frei im Rohstein) */
const SMALL_L: Pt[] = [
  { x: 1, y: 1 },
  { x: 4, y: 1 },
  { x: 4, y: 3 },
  { x: 7, y: 3 },
  { x: 7, y: 7 },
  { x: 1, y: 7 },
];
/** Pfeil mit Kerbe, deren Verlängerung den anderen Arm trifft */
const ARROW: Pt[] = [
  { x: 0, y: 0 },
  { x: 3, y: 0 },
  { x: 3, y: 6 },
  { x: 7, y: 6 },
  { x: 7, y: 2 },
  { x: 10, y: 2 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

// ---------------------------------------------------------------- Geometrie

describe('Geometrie: Hülle, schmalste Stelle, kleinster Winkel', () => {
  it('konvexe Hülle (Monotone Chain)', () => {
    const h = convexHull(L_SHAPE);
    expect(h).toHaveLength(5);
    expect(area(h)).toBeCloseTo(100 - 0.5 * 6 * 4, 9);
    expect(isConvex(h)).toBe(true);
    expect(convexHull([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }])).toHaveLength(2);
    expect(convexHull([])).toEqual([]);
  });
  it('minCaliperWidth: Rechteck, gedrehtes Rechteck, Dreieck, L-Form', () => {
    expect(minCaliperWidth(rectPoly(0, 0, 1, 5))).toBeCloseTo(1, 12);
    expect(minCaliperWidth(rectPoly(3, 4, 7, 2.5))).toBeCloseTo(2.5, 12);
    const a = Math.PI / 6;
    const rot = rectPoly(0, 0, 1.2, 6).map((p) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }));
    expect(minCaliperWidth(rot)).toBeCloseTo(1.2, 9);
    // rechtwinkliges Dreieck 3/4/5: schmalste Stelle = Höhe auf die Hypotenuse = 2,4
    expect(minCaliperWidth([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 4 }])).toBeCloseTo(2.4, 12);
    // doppelte Punkte (Kantenlänge 0) werden übersprungen
    expect(minCaliperWidth([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 2 }, { x: 0, y: 2 }])).toBeCloseTo(2, 12);
    // nicht-konvex: Breite der Hülle
    expect(minCaliperWidth(L_SHAPE)).toBeCloseTo(minCaliperWidth(convexHull(L_SHAPE)), 12);
    expect(minCaliperWidth([])).toBe(0);
    expect(minCaliperWidth([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 9, y: 0 }])).toBe(0);
  });
  it('minInteriorAngle', () => {
    expect(minInteriorAngle(rectPoly(0, 0, 3, 8))).toBeCloseTo(90, 9);
    const [t] = diagA({ x: 0, y: 0, w: 4, h: 8 }, 0);
    expect(minInteriorAngle(t)).toBeCloseTo((Math.atan(4 / 8) * 180) / Math.PI, 9);
    expect(minInteriorAngle([])).toBe(0);
  });
});

// ---------------------------------------------------------------- Mindestbreite

describe('pieceCuttable: Mindestbreite = schmalste Stelle und Inkreismaß', () => {
  it('Streifen: 1 × 5 mm bei 1,5 mm abgelehnt, 1,5 × 5 mm angenommen; 1 × 8 und 1 × 10 abgelehnt', () => {
    expect(pieceCuttable(rectPoly(0, 0, 1, 5), 1.5)).toBe(false);
    expect(pieceCuttable(rectPoly(0, 0, 1.5, 5), 1.5)).toBe(true);
    expect(pieceCuttable(rectPoly(0, 0, 1, 8), 1.5)).toBe(false);
    expect(pieceCuttable(rectPoly(0, 0, 1, 10), 1.5)).toBe(false);
    expect(pieceCuttable(rectPoly(0, 0, 1.5, 10), 1.5)).toBe(true);
    // früher angenommen:
    expect(oldPieceCuttable(rectPoly(0, 0, 1, 5), 1.5)).toBe(true);
  });
  it('Diagonaldreieck eines 3-mm-Steins mit 1 mm Fuge bleibt bei 1,5 mm abgelehnt', () => {
    for (const f of [diagA, diagB]) {
      const [p, q] = f({ x: 0, y: 0, w: 3, h: 3 }, 1);
      expect(pieceCuttable(p, 1.5)).toBe(false);
      expect(pieceCuttable(q, 1.5)).toBe(false);
    }
    // 5-mm-Stein, 1 mm Fuge: Dreiecke bei 2 mm zulässig
    const [p] = diagA({ x: 0, y: 0, w: 5, h: 5 }, 1);
    expect(pieceCuttable(p, 2)).toBe(true);
  });
  it('leere Teile sind nie schneidbar (auch bei Mindestbreite 0)', () => {
    expect(pieceCuttable([], 0)).toBe(false);
    expect(pieceCuttable([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], 0)).toBe(false);
    expect(pieceCuttable(rectPoly(0, 0, 0, 3), 0)).toBe(false);
    expect(isDegeneratePiece(diagA({ x: 0, y: 0, w: 2, h: 2 }, 3)[0])).toBe(true);
  });
  it('wird gegenüber früher nur verschärft (nie gelockert) – 20.000 Zufallsteile', () => {
    const R = rng(42);
    let tightened = 0;
    for (let i = 0; i < 20000; i++) {
      const r = { x: R() * 50, y: R() * 50, w: 1 + R() * 11, h: 1 + R() * 11 };
      const g = [0, 0.5, 1, 1.5, 2, 3][Math.floor(R() * 6)];
      const min = 0.5 + R() * 3.5;
      const kind = Math.floor(R() * 4);
      let polys: Pt[][];
      if (kind === 0) polys = diagA(r, g);
      else if (kind === 1) polys = diagB(r, g);
      else if (kind === 2) {
        const a = Math.floor(R() * 12) * 15 * (Math.PI / 180);
        polys = lineSplit(r, Math.cos(a), Math.sin(a), (R() - 0.5) * Math.min(r.w, r.h), g);
      } else polys = subRects(r, 2 + Math.floor(R() * 2), g);
      for (const p of polys) {
        const nu = pieceCuttable(p, min);
        const old = oldPieceCuttable(p, min);
        if (nu) expect(old).toBe(true);
        if (old && !nu) tightened++;
        if (nu) expect(minCaliperWidth(p)).toBeGreaterThanOrEqual(min - 1e-6);
      }
    }
    expect(tightened).toBeGreaterThan(0);
  });
  it('k×k-Unterteilung: dieselbe Regel; Fuge breiter als der Stein ergibt leere Teile', () => {
    expect(subdivisionCuttable({ x: 0, y: 0, w: 5, h: 5 }, 2, 1, 2)).toBe(true); // 2,0 × 2,0 mm
    expect(subdivisionCuttable({ x: 0, y: 0, w: 5, h: 5 }, 3, 1, 2)).toBe(false); // 1,0 × 1,0 mm
    expect(subdivisionCuttable({ x: 0, y: 0, w: 3, h: 8 }, 2, 1, 2)).toBe(false); // 1,0 × 3,5 mm
    expect(subdivisionCuttable({ x: 0, y: 0, w: 4, h: 8 }, 2, 1, 2)).toBe(false); // 1,5 × 3,5 mm (früher in der Berechnung zugelassen)
    expect(subRects({ x: 0, y: 0, w: 2, h: 2 }, 3, 3).every((p) => isDegeneratePiece(p))).toBe(true);
    expect(subdivisionCuttable({ x: 0, y: 0, w: 2, h: 2 }, 3, 3, 0.5)).toBe(false);
  });
});

// ---------------------------------------------------------------- Formänderungen

describe('setCellKind: Dreiecke werden wie Kantenschnitte geprüft', () => {
  it('2 × 2-mm-Stein mit 3 mm Fuge: Dreiecke abgelehnt, Zelle bleibt ganzer Stein', () => {
    const { layout, data } = grid3(2, 2, 3);
    const idx = layout.cols + 1;
    data.progress[idx] = 1;
    for (const kind of [CellKind.DIAG_A, CellKind.DIAG_B]) {
      expect(setCellKind(layout, data, 1, 1, { kind }, 1.5)).toBe('diag-empty');
      expect(data.kind[idx]).toBe(CellKind.FULL);
      expect(data.c1[idx]).toBe(3);
      expect(data.progress[idx]).toBe(1);
    }
  });
  it('2 × 2-mm-Stein mit 1 mm Fuge bei 1,5 mm: „too-small“, genau wie ein Kantenschnitt unter 45°', () => {
    const { layout, data } = grid3(2, 2, 1);
    expect(setCellKind(layout, data, 1, 1, { kind: CellKind.DIAG_A }, 1.5)).toBe('too-small');
    expect(setCellKind(layout, data, 1, 1, { kind: CellKind.DIAG_B }, 1.5)).toBe('too-small');
    expect(setCellKind(layout, data, 1, 1, { kind: CellKind.LINE, angleDeg: 45, offsetMm: 0 }, 1.5)).toBe('too-small');
    expect(data.kind[layout.cols + 1]).toBe(CellKind.FULL);
  });
  it('8 × 8-mm-Stein mit 1 mm Fuge: Dreiecke angenommen', () => {
    const { layout, data } = grid3(8, 8, 1);
    expect(setCellKind(layout, data, 1, 1, { kind: CellKind.DIAG_A }, 1.5)).toBeNull();
    expect(data.kind[layout.cols + 1]).toBe(CellKind.DIAG_A);
    const ps = cellPieces(layout, data, 1, 1);
    expect(ps).toHaveLength(2);
    expect(ps.every((p) => pieceCuttable(p.poly, 1.5))).toBe(true);
  });
  it('Kantenschnitt 0°, Versatz 2,5 mm auf 8-mm-Stein mit 1 mm Fuge (Teile 6,0 / 1,0 mm) bei 1,5 mm: „too-small“', () => {
    const { layout, data } = grid3(8, 8, 1);
    expect(setCellKind(layout, data, 1, 1, { kind: CellKind.LINE, angleDeg: 0, offsetMm: 2.5 }, 1.5)).toBe('too-small');
    expect(setCellKind(layout, data, 1, 1, { kind: CellKind.LINE, angleDeg: 0, offsetMm: 2 }, 1.5)).toBeNull();
    expect(setCellKind(layout, data, 1, 1, { kind: CellKind.LINE, angleDeg: 0, offsetMm: 9 }, 1.5)).toBe('line-outside');
  });
  it('Unterteilung nutzt dieselbe Regel wie die Berechnung (4 × 8 mm, min 2: abgelehnt)', () => {
    const a = grid3(4, 8, 1);
    expect(setCellKind(a.layout, a.data, 1, 1, { kind: CellKind.SUB, k: 2 }, 2)).toBe('too-small');
    const b = grid3(5, 5, 1);
    expect(setCellKind(b.layout, b.data, 1, 1, { kind: CellKind.SUB, k: 2 }, 2)).toBeNull();
    expect(setCellKind(b.layout, b.data, 1, 1, { kind: CellKind.SUB, k: 3 }, 2)).toBe('too-small');
  });
  it('„Ganzer Stein“ auf einem verlegten ganzen Stein behält den Verlegestatus', () => {
    const { layout, data } = grid3(8, 8, 1);
    const idx = layout.cols + 1;
    data.progress[idx] = 1;
    expect(setCellKind(layout, data, 1, 1, { kind: CellKind.FULL }, 2)).toBeNull();
    expect(data.progress[idx]).toBe(1);
  });
  it('unveränderte Form mit gleichen Parametern behält den Verlegestatus; echte Änderungen setzen ihn zurück', () => {
    const { layout, data } = grid3(8, 8, 1);
    const idx = layout.cols + 1;
    const cases: KindChange[] = [{ kind: CellKind.DIAG_B }, { kind: CellKind.SUB, k: 2 }, { kind: CellKind.LINE, angleDeg: 30, offsetMm: 1 }];
    for (const ch of cases) {
      expect(setCellKind(layout, data, 1, 1, ch, 2)).toBeNull();
      data.progress[idx] = 0b11;
      expect(sameCellKind(layout, data, 1, 1, ch)).toBe(true);
      expect(setCellKind(layout, data, 1, 1, ch, 2)).toBeNull();
      expect(data.progress[idx]).toBe(0b11);
    }
    // anderer Versatz bzw. anderes k = echte Änderung
    expect(setCellKind(layout, data, 1, 1, { kind: CellKind.LINE, angleDeg: 30, offsetMm: 1.5 }, 2)).toBeNull();
    expect(data.progress[idx]).toBe(0);
    expect(setCellKind(layout, data, 1, 1, { kind: CellKind.SUB, k: 2 }, 2)).toBeNull();
    data.progress[idx] = 0b1111;
    const c = grid3(11, 11, 1);
    expect(setCellKind(c.layout, c.data, 1, 1, { kind: CellKind.SUB, k: 2 }, 2)).toBeNull();
    c.data.progress[c.layout.cols + 1] = 0b1111;
    expect(setCellKind(c.layout, c.data, 1, 1, { kind: CellKind.SUB, k: 3 }, 2)).toBeNull();
    expect(c.data.progress[c.layout.cols + 1]).toBe(0);
  });
  it('allowedCellKinds ist ein Trockenlauf derselben Prüfungen (zufällige Raster)', () => {
    const R = rng(7);
    for (let i = 0; i < 300; i++) {
      const tw = [2, 3, 4, 5, 6, 8, 10, 12][Math.floor(R() * 8)];
      const th = R() < 0.5 ? tw : [3, 4, 5, 8, 10, 12][Math.floor(R() * 6)];
      const g = [0, 0.5, 1, 1.5, 2, 3][Math.floor(R() * 6)];
      const min = [0.5, 1, 1.5, 2, 2.5, 3][Math.floor(R() * 6)];
      const { layout, data } = grid3(tw, th, g, 'cut-end');
      const row = Math.floor(R() * layout.rows);
      const col = Math.floor(R() * layout.cols);
      const al = allowedCellKinds(layout, data, row, col, min);
      const map: [keyof typeof al, KindChange][] = [
        ['full', { kind: CellKind.FULL }],
        ['diagA', { kind: CellKind.DIAG_A }],
        ['diagB', { kind: CellKind.DIAG_B }],
        ['sub2', { kind: CellKind.SUB, k: 2 }],
        ['sub3', { kind: CellKind.SUB, k: 3 }],
      ];
      for (const [key, ch] of map) {
        expect(checkCellKind(layout, row, col, ch, min)).toBe(al[key]);
        const copy = { ...data, kind: data.kind.slice(), c1: data.c1.slice(), c2: data.c2.slice(), progress: data.progress.slice(), sub: new Map(data.sub), line: new Map(data.line), free: new Map(data.free) };
        const err = setCellKind(layout, copy, row, col, ch, min);
        expect(err).toBe(al[key]);
        if (!err) for (const p of cellPieces(layout, copy, row, col)) if (ch.kind !== CellKind.FULL) expect(pieceCuttable(p.poly, min)).toBe(true);
      }
    }
  });
});

describe('repairDegenerateCells', () => {
  it('macht leere Diagonal-/Kantenschnitt-/Unterteilungszellen zu ganzen Steinen (Farbe c1, Status gelöscht)', () => {
    const bad = grid3(2, 2, 3);
    const d = bad.data;
    const L = bad.layout;
    // gespeicherter Altzustand: Dreiecke trotz 3 mm Fuge
    d.kind[0] = CellKind.DIAG_A;
    d.c1[0] = 5;
    d.c2[0] = 6;
    d.progress[0] = 0b11;
    d.kind[1] = CellKind.LINE; // ohne Parameter
    d.progress[1] = 1;
    d.kind[2] = CellKind.SUB;
    d.sub.set(2, new Uint16Array([7, 8, 9, 1, 2, 3, 4, 5, 6]));
    d.kind[4] = CellKind.DIAG_B; // ebenfalls leer
    expect(cellPieces(L, d, 0, 0).some((p) => isDegeneratePiece(p.poly))).toBe(true);
    expect(repairDegenerateCells(L, d)).toBe(4);
    expect(Array.from(d.kind.slice(0, 5))).toEqual([CellKind.FULL, CellKind.FULL, CellKind.FULL, CellKind.FULL, CellKind.FULL]);
    expect(d.c1[0]).toBe(5);
    expect(d.c1[2]).toBe(7);
    expect(d.progress[0]).toBe(0);
    expect(d.progress[1]).toBe(0);
    expect(d.sub.size).toBe(0);
    // gültige Zellen bleiben unverändert
    const ok = grid3(8, 8, 1);
    ok.data.kind[4] = CellKind.DIAG_A;
    ok.data.progress[4] = 0b10;
    expect(repairDegenerateCells(ok.layout, ok.data)).toBe(0);
    expect(ok.data.kind[4]).toBe(CellKind.DIAG_A);
    expect(ok.data.progress[4]).toBe(0b10);
  });
});

// ---------------------------------------------------------------- Schnittanalyse

describe('analyzeCut: leere Teile liefern endliche Werte', () => {
  it('analyzeCut([]) → invalid, nur endliche Zahlen', () => {
    const c = analyzeCut([], 5, 5);
    expect(c.invalid).toBe(true);
    expect(finiteNumbers(c)).toBe(true);
    expect(c.fits).toBe(false);
    expect(c.needsCut).toBe(false);
    expect(c.yieldPerRaw).toBe(1);
    expect(c.cutLines).toEqual([]);
    expect(c.cutKinds).toEqual([]);
    expect(c.polyInRaw).toEqual([]);
    expect(c.w).toBe(0);
    expect(c.area).toBe(0);
  });
  it('Dreiecke bei zu breiter Fuge und kollineare Punkte → invalid; Statistik bleibt endlich', () => {
    const [p] = diagA({ x: 0, y: 0, w: 2, h: 2 }, 3);
    expect(analyzeCut(p, 2, 2).invalid).toBe(true);
    expect(analyzeCut([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], 5, 5).invalid).toBe(true);
    expect(analyzeCut(rectPoly(0, 0, 2, 5), 5, 5).invalid).toBeUndefined();
    const { layout, data } = grid3(2, 2, 3);
    data.kind[4] = CellKind.DIAG_A;
    const st = computeStats(layout, data, [{ code: 1, name: 'a', hex: '#111111', lab: [5, 0, 0] }, { code: 2, name: 'b', hex: '#222222', lab: [10, 0, 0] }, { code: 3, name: 'c', hex: '#333333', lab: [15, 0, 0] }, { code: 4, name: 'd', hex: '#444444', lab: [20, 0, 0] }], [], { reservePct: 10, groutDepthMm: 3 });
    expect(st.perSize.every((s) => Number.isFinite(s.w) && Number.isFinite(s.h))).toBe(true);
    expect(Number.isFinite(st.stoneArea) && Number.isFinite(st.rawArea)).toBe(true);
  });
});

describe('Schnittlinien: nie durch den Stein', () => {
  const fixtures: [string, Pt[], number, number][] = [
    ['L', L_SHAPE, 10, 10],
    ['U', U_SHAPE, 10, 10],
    ['Chevron', CHEVRON, 10, 10],
    ['Kamm', COMB, 10, 10],
    ['kleines L', SMALL_L, 10, 10],
    ['Pfeil', ARROW, 10, 10],
    ['L im Rechteck-Rohstein', L_SHAPE.map((p) => ({ x: p.x * 0.8, y: p.y * 0.5 })), 8, 12],
  ];
  it.each(fixtures)('%s: kein Abtastpunkt einer Schnittlinie liegt im Stein, jede Innenkante ist geschnitten', (_n, poly, W, H) => {
    const c = analyzeCut(poly, W, H);
    expect(c.convex).toBe(false);
    expect(c.cutKinds).toHaveLength(c.cutLines.length);
    expect(c.cutKinds.filter((k) => k === 'notch').length).toBeGreaterThan(0);
    expect(cutViolations(c)).toEqual([]);
    expect(uncoveredEdges(c)).toEqual([]);
    // Einschnitte: Ende an der Steinkante; Anfang auf dem Rohsteinrand, einem durchgehenden Schnitt oder der Steinkante
    const throughLines = c.cutLines.filter((_, i) => c.cutKinds[i] === 'through');
    const onLine = (p: Pt, [a, b]: [Pt, Pt]) => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y) < 1e-6;
    const onRaw = (p: Pt) => Math.abs(p.x) < 1e-6 || Math.abs(p.y) < 1e-6 || Math.abs(p.x - W) < 1e-6 || Math.abs(p.y - H) < 1e-6;
    c.cutLines.forEach(([a, b], i) => {
      if (c.cutKinds[i] !== 'notch') return;
      expect(distToBoundary(b, c.polyInRaw)).toBeLessThan(1e-6);
      expect(onRaw(a) || throughLines.some((l) => onLine(a, l)) || distToBoundary(a, c.polyInRaw) < 1e-6).toBe(true);
    });
    // die alte Methode lief durch den Stein
    const old = oldPlacement(poly, W, H)!;
    expect(cutViolations({ ...c, polyInRaw: old.poly, cutLines: old.lines }).length).toBeGreaterThan(0);
  });
  it('L-Stein: zwei Einschnitte vom Rand bis zur Innenecke (4|4)', () => {
    const c = analyzeCut(L_SHAPE, 10, 10);
    expect(c.cutKinds).toEqual(['notch', 'notch']);
    const lines = c.cutLines.map(([a, b]) => [a.x, a.y, b.x, b.y].map((v) => Math.round(v * 1000) / 1000));
    expect(lines).toContainEqual([4, 0, 4, 4]);
    expect(lines).toContainEqual([10, 4, 4, 4]);
  });
  it('kleines L: Einschnitt beginnt am vorher ausgeführten durchgehenden Schnitt', () => {
    const c = analyzeCut(SMALL_L, 10, 10);
    expect(c.cutKinds).toEqual(['through', 'through', 'notch', 'notch']);
    const lines = c.cutLines.map(([a, b]) => [a.x, a.y, b.x, b.y].map((v) => Math.round(v * 1000) / 1000));
    expect(lines).toContainEqual([6, 2, 3, 2]);
    expect(lines).toContainEqual([3, 0, 3, 2]);
  });
  it('Kamm: kollineare Taschenböden werden nicht zusammengelegt', () => {
    const c = analyzeCut(COMB, 10, 10);
    const bottoms = c.cutLines.filter(([a, b]) => Math.abs(a.y - 5) < 1e-9 && Math.abs(b.y - 5) < 1e-9);
    expect(bottoms).toHaveLength(2);
  });
  it('Einschnitte stehen nach den durchgehenden Schnitten; Platzierung mit wenigsten Einschnitten', () => {
    for (const [, poly, W, H] of fixtures) {
      const c = analyzeCut(poly, W, H);
      const firstNotch = c.cutKinds.indexOf('notch');
      expect(c.cutKinds.slice(firstNotch).every((k) => k === 'notch')).toBe(true);
    }
    // kleines L frei im Rohstein: an eine Rohsteinecke geschoben
    const c = analyzeCut(SMALL_L, 10, 10);
    const b = bbox(c.polyInRaw);
    expect(b.minX === 0 || Math.abs(b.maxX - 10) < 1e-9).toBe(true);
    expect(b.minY === 0 || Math.abs(b.maxY - 10) < 1e-9).toBe(true);
  });
  it('konvexe Teile: Rechteck, Dreieck, Sechseck und 3.000 Zufallsteile identisch zur bisherigen Methode', () => {
    const hex: Pt[] = Array.from({ length: 6 }, (_, i) => ({ x: 5 + 4 * Math.cos((i * Math.PI) / 3), y: 5 + 4 * Math.sin((i * Math.PI) / 3) }));
    const cases: [Pt[], number, number][] = [
      [rectPoly(0, 0, 2, 5), 5, 5],
      [rectPoly(10, 20, 4, 3), 8, 8],
      [diagA({ x: 0, y: 0, w: 5, h: 5 }, 1)[0], 5, 5],
      [diagB({ x: 3, y: 7, w: 8, h: 4 }, 1.5)[1], 8, 4],
      [hex, 10, 10],
    ];
    const R = rng(99);
    for (let i = 0; i < 3000; i++) {
      const r = { x: R() * 40, y: R() * 40, w: 2 + R() * 10, h: 2 + R() * 10 };
      const g = [0, 0.5, 1, 2][Math.floor(R() * 4)];
      const a = Math.floor(R() * 12) * 15 * (Math.PI / 180);
      const polys = R() < 0.5 ? lineSplit(r, Math.cos(a), Math.sin(a), (R() - 0.5) * Math.min(r.w, r.h), g) : R() < 0.5 ? diagA(r, g) : diagB(r, g);
      const raw = R() < 0.7 ? [r.w, r.h] : [Math.max(r.w, r.h), Math.max(r.w, r.h) + 2];
      for (const p of polys) if (p.length >= 3) cases.push([p, raw[0], raw[1]]);
    }
    for (const [poly, W, H] of cases) {
      const c = analyzeCut(poly, W, H);
      const old = oldPlacement(poly, W, H);
      if (!old) {
        expect(c.fits).toBe(false);
        continue;
      }
      expect(c.polyInRaw).toEqual(old.poly);
      if (c.needsCut) expect(c.cutLines).toEqual(old.lines);
      expect(c.cutKinds.every((k) => k === 'through')).toBe(true);
      expect(cutViolations(c, 50)).toEqual([]);
    }
  });
  it('cutLinesFor liefert parallele Arten', () => {
    const { lines, kinds } = cutLinesFor(U_SHAPE, 10, 10);
    expect(kinds).toHaveLength(lines.length);
    expect(interiorAngles(U_SHAPE).some((a) => a > 180)).toBe(true);
  });
});

// ---------------------------------------------------------------- Berechnung

/** Testprojekte wie in src/ui/Home.tsx (Breite, Stein, Fuge, Farben; Höhe aus dem Seitenverhältnis; Randmodus „Rand zuschneiden“, Mindestschnitt 2 mm). */
const SAMPLES: { key: string; w: number; tile: number; joint: number; colors: number; regions?: Region[] }[] = [
  { key: 'portrait', w: 400, tile: 5, joint: 1, colors: 32, regions: [{ id: 'face', type: 'face', shape: 'ellipse', x: 0.27, y: 0.25, w: 0.46, h: 0.5 }] },
  { key: 'landscape', w: 1200, tile: 8, joint: 1.5, colors: 24 },
  { key: 'animal', w: 500, tile: 6, joint: 1, colors: 24 },
  { key: 'city', w: 2000, tile: 10, joint: 2, colors: 16 },
];

describe('Berechnung: jedes Schnittteil ist mindestens so breit wie eingestellt', () => {
  it.each(SAMPLES)('Testprojekt $key mit DEFAULT_SHAPES (Mindestbreite $tile mm-Steine)', (s) => {
    const png = loadPng(`public/samples/${s.key}.png`);
    const heightMm = Math.round((s.w / (png.width / png.height)) * 10) / 10;
    const layout = computeLayout({ widthMm: s.w, heightMm, tileW: s.tile, tileH: s.tile, joint: s.joint, edgeMode: 'cut-end', minCutMm: 2 });
    const img = applyAdjustments(prepareFor(png, layout), { ...DEFAULT_ADJUST }, s.regions ?? []);
    const res = computeMosaic(img, { layout, shapes: { ...DEFAULT_SHAPES }, paletteMode: 'auto', colorCount: s.colors, dither: 0, deltaE: '2000', regions: s.regions ?? [] });
    const min = DEFAULT_SHAPES.minPieceMm;
    expect(min).toBe(2);
    let cutPieces = 0;
    let narrowest = Infinity;
    const bad: string[] = [];
    for (let row = 0; row < layout.rows; row++)
      for (let col = 0; col < layout.cols; col++) {
        const k = res.data.kind[row * layout.cols + col];
        if (k !== CellKind.DIAG_A && k !== CellKind.DIAG_B && k !== CellKind.LINE && k !== CellKind.SUB) continue;
        for (const p of cellPieces(layout, res.data, row, col)) {
          cutPieces++;
          const w = minCaliperWidth(p.poly);
          narrowest = Math.min(narrowest, w);
          if (w < min - 1e-6 || !pieceCuttable(p.poly, min)) bad.push(`${row}/${col}: ${w.toFixed(3)} mm`);
        }
      }
    expect(cutPieces).toBeGreaterThan(0);
    expect(bad).toEqual([]);
    expect(narrowest).toBeGreaterThanOrEqual(min - 1e-6);
  });

  it('3 × 8-mm-Stein, 1 mm Fuge, 2 × 2, min 2: Hinweis „keine Unterteilung“ und 0 Teilstein-Zellen', () => {
    const shapes = { ...DEFAULT_SHAPES, subdivK: 2 as const, minPieceMm: 2, autoDetail: false };
    // Hinweis im Schritt Steinformen (gleiche Funktion wie StepShapes)
    expect(subdivisionCuttable({ x: 0, y: 0, w: 3, h: 8 }, 2, 1, shapes.minPieceMm)).toBe(false);
    for (const [tw, th] of [
      [3, 8],
      [4, 8],
    ]) {
      const layout = computeLayout({ widthMm: 240, heightMm: 300, tileW: tw, tileH: th, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
      const img = prepareFor(loadPng('public/samples/portrait.png'), layout);
      const res = computeMosaic(img, { layout, shapes, paletteMode: 'auto', colorCount: 16, dither: 0, deltaE: '2000', regions: [] });
      let sub = 0;
      for (let i = 0; i < res.data.kind.length; i++) if (res.data.kind[i] === CellKind.SUB) sub++;
      expect(sub).toBe(0);
      expect(res.diagnostics.subCells).toBe(0);
    }
    // Gegenprobe: 5 × 5 mm mit 1 mm Fuge erlaubt 2 × 2 (2,0 mm) – der Hinweis erscheint nicht
    expect(subdivisionCuttable({ x: 0, y: 0, w: 5, h: 5 }, 2, 1, 2)).toBe(true);
  });
});

describe('Texte', () => {
  it('alle Fehlercodes und neuen Texte in DE, EN und TR; Feld heißt „Mindestbreite eines Schnittteils“', () => {
    const keys = [
      ...(['line-outside', 'diag-empty', 'too-small', 'use-setFreePieces'] as const).map((c) => `edit.err.${c}`),
      'cut.invalid',
      'cut.notch',
      'cut.notchEdge',
      'cut.difficult',
      'stone.invalid',
      'stone.minWidth',
      'stone.belowMin',
      'shapes.minPieceHint',
      'shapes.subTooSmallW',
      'shapes.diagTooSmall',
      'edit.notPossible',
      'edit.diag',
      'width.failCaliper',
      'width.failIncircle',
      'width.degenerate',
      'shapes.diagMaxMin',
      'shapes.lineTooSmall',
      'cut.nonConvexNotchOnly',
      'cut.nonConvexPlain',
    ];
    for (const lang of ['de', 'en', 'tr'] as const) {
      const d = dictionaries[lang] as Record<string, string>;
      for (const k of keys) expect(d[k], `${lang}:${k}`).toBeTruthy();
    }
    const de = dictionaries.de as Record<string, string>;
    // Die Einstellung prüft schmalste Stelle UND Inkreismaß – der Name behauptet nicht nur eines davon
    expect(de['shapes.minPiece']).toBe('Mindestbreite eines Schnittteils (mm)');
    expect(de['shapes.minPieceHint']).toMatch(/schmalsten Stelle/);
    expect(de['shapes.minPieceHint']).toMatch(/Inkreismaß/);
    expect(de['cut.notch']).toMatch(/Einschnitt \{i\}: von .* bis Innenecke .* nicht durchritzen/);
  });

  it('Schnittanweisung im Steindetail: ungültig, Einschnitte, durchgehende Schnitte', async () => {
    const { cutInstructionItems } = await import('../src/ui/project/StoneDialog');
    const t = makeT('de');
    const n = numberFormatter('de');
    const inv = cutInstructionItems(analyzeCut([], 5, 5), t, n);
    expect(inv).toHaveLength(1);
    expect(inv[0].kind).toBe('invalid');
    expect(inv[0].text).toMatch(/Ungültiges Teil/);
    expect(inv[0].text).not.toMatch(/Infinity|NaN/);
    const L = cutInstructionItems(analyzeCut(L_SHAPE, 10, 10), t, n).map((x) => x.text);
    expect(L).toContain('Einschnitt 1: von (4 | 0) bis Innenecke (4 | 4) mm – nicht durchritzen, mit der Zange ausknabbern bzw. schleifen.');
    expect(L).toContain('Einschnitt 2: von (10 | 4) bis Innenecke (4 | 4) mm – nicht durchritzen, mit der Zange ausknabbern bzw. schleifen.');
    expect(L.some((s) => /^Schnitt \d/.test(s))).toBe(false);
    // nur Einschnitte: kein Hinweis „zuerst die durchgehenden Schnitte“ (die es hier nicht gibt)
    expect(L.some((s) => /Nicht konvex: Die Einschnitte/.test(s))).toBe(true);
    expect(L.some((s) => /durchgehenden Schnitte/.test(s))).toBe(false);
    // Pfeil: ein Einschnitt endet an der Steinkante (kein Eckpunkt)
    const A = cutInstructionItems(analyzeCut(ARROW, 10, 10), t, n).map((x) => x.text);
    expect(A.some((s) => /bis zur Steinkante \(3 \| 2\)/.test(s))).toBe(true);
    // kleines L: durchgehende Schnitte zuerst, eigene Nummerierung
    const S = cutInstructionItems(analyzeCut(SMALL_L, 10, 10), t, n).map((x) => x.text);
    expect(S.filter((s) => /^Schnitt \d: von/.test(s))).toEqual(['Schnitt 1: von (6 | 0) nach (6 | 10) mm', 'Schnitt 2: von (0 | 6) nach (10 | 6) mm']);
    expect(S.some((s) => s.startsWith('Einschnitt 2: von (6 | 2) bis Innenecke (3 | 2)'))).toBe(true);
    expect(S.some((s) => /Zuerst die durchgehenden Schnitte, dann die Einschnitte/.test(s))).toBe(true);
    const tri = cutInstructionItems(analyzeCut(diagA({ x: 0, y: 0, w: 5, h: 5 }, 1)[0], 5, 5), t, n);
    expect(tri.filter((x) => x.kind === 'through')).toHaveLength(1);
    expect(tri.some((x) => x.kind === 'notch')).toBe(false);
  });
});
