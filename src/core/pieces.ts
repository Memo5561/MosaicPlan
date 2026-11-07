/**
 * Erzeugt aus Rasterzelle + Zellart die exakten Steinpolygone (in mm, absolut
 * zum Projektursprung) und berechnet daraus Form, Maße und Schnittvorlagen.
 */
import {
  area,
  bbox,
  classifyShape,
  cleanPoly,
  clipHalfPlane,
  DIM_TOL,
  edgeLengths,
  edgeOnRectBoundary,
  interiorAngles,
  isAxisRect,
  isConvex,
  lineThroughRect,
  rectPoly,
  rotate90,
  translate,
  type Pt,
  type ShapeType,
} from './geometry';
import type { Layout } from './layout';
import { CellKind, type MosaicData } from './types';

export interface PieceGeom {
  poly: Pt[];
  color: number;
}

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function cellRect(layout: Layout, row: number, col: number): CellRect {
  return { x: layout.colX[col], y: layout.rowY[row], w: layout.colW[col], h: layout.rowH[row] };
}

/** Teilt ein Rechteck entlang „\“ (TL→BR). Liefert [oben rechts, unten links]. */
export function diagA(r: CellRect, g: number): [Pt[], Pt[]] {
  const rect = rectPoly(r.x, r.y, r.w, r.h);
  const len = Math.hypot(r.w, r.h);
  const nx = r.h / len;
  const ny = -r.w / len;
  const c0 = nx * r.x + ny * r.y;
  // oben rechts: n·p ≥ c0 + g/2  ⇔  −n·p ≤ −c0 − g/2
  const upper = clipHalfPlane(rect, -nx, -ny, -c0 - g / 2);
  const lower = clipHalfPlane(rect, nx, ny, c0 - g / 2);
  return [upper, lower];
}

/** Teilt ein Rechteck entlang „/“ (BL→TR). Liefert [oben links, unten rechts]. */
export function diagB(r: CellRect, g: number): [Pt[], Pt[]] {
  const rect = rectPoly(r.x, r.y, r.w, r.h);
  const len = Math.hypot(r.w, r.h);
  const nx = r.h / len;
  const ny = r.w / len;
  const c0 = nx * r.x + ny * (r.y + r.h);
  const upper = clipHalfPlane(rect, nx, ny, c0 - g / 2);
  const lower = clipHalfPlane(rect, -nx, -ny, -c0 - g / 2);
  return [upper, lower];
}

/** Kantenschnitt: Gerade n·(p − Mitte) = d, Fuge g mittig auf der Geraden. */
export function lineSplit(r: CellRect, nx: number, ny: number, d: number, g: number): [Pt[], Pt[]] {
  const rect = rectPoly(r.x, r.y, r.w, r.h);
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const nc = nx * cx + ny * cy;
  const a = clipHalfPlane(rect, nx, ny, nc + d - g / 2);
  const b = clipHalfPlane(rect, -nx, -ny, -(nc + d) - g / 2);
  return [a, b];
}

export function subRects(r: CellRect, k: number, g: number): Pt[][] {
  const sw = (r.w - (k - 1) * g) / k;
  const sh = (r.h - (k - 1) * g) / k;
  const res: Pt[][] = [];
  for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) res.push(rectPoly(r.x + i * (sw + g), r.y + j * (sh + g), sw, sh));
  return res;
}

export function subK(data: MosaicData, idx: number): number {
  const s = data.sub.get(idx);
  return s ? Math.round(Math.sqrt(s.length)) : 1;
}

export function cellPieceCount(data: MosaicData, idx: number): number {
  switch (data.kind[idx]) {
    case CellKind.FULL:
      return 1;
    case CellKind.DIAG_A:
    case CellKind.DIAG_B:
    case CellKind.LINE:
      return 2;
    case CellKind.SUB:
      return data.sub.get(idx)?.length ?? 1;
    case CellKind.FREE:
      return data.free.get(idx)?.length ?? 0;
    default:
      return 1;
  }
}

/** Alle Steine einer Rasterzelle mit exakter Geometrie. */
export function cellPieces(layout: Layout, data: MosaicData, row: number, col: number): PieceGeom[] {
  const idx = row * layout.cols + col;
  const r = cellRect(layout, row, col);
  const g = layout.joint;
  const kind = data.kind[idx];
  switch (kind) {
    case CellKind.DIAG_A: {
      const [p, q] = diagA(r, g);
      return [
        { poly: p, color: data.c1[idx] },
        { poly: q, color: data.c2[idx] },
      ];
    }
    case CellKind.DIAG_B: {
      const [p, q] = diagB(r, g);
      return [
        { poly: p, color: data.c1[idx] },
        { poly: q, color: data.c2[idx] },
      ];
    }
    case CellKind.LINE: {
      const prm = data.line.get(idx);
      if (!prm) return [{ poly: rectPoly(r.x, r.y, r.w, r.h), color: data.c1[idx] }];
      const [p, q] = lineSplit(r, prm[0], prm[1], prm[2], g);
      return [
        { poly: p, color: data.c1[idx] },
        { poly: q, color: data.c2[idx] },
      ];
    }
    case CellKind.SUB: {
      const cols = data.sub.get(idx);
      if (!cols) return [{ poly: rectPoly(r.x, r.y, r.w, r.h), color: data.c1[idx] }];
      const k = Math.round(Math.sqrt(cols.length));
      return subRects(r, k, g).map((poly, i) => ({ poly, color: cols[i] }));
    }
    case CellKind.FREE: {
      const fp = data.free.get(idx) ?? [];
      return fp.map((f) => ({ poly: translate(f.poly, r.x, r.y), color: f.color }));
    }
    default:
      return [{ poly: rectPoly(r.x, r.y, r.w, r.h), color: data.c1[idx] }];
  }
}

/** Mindestdicke-Kriterium für schneidbare Teile: 2·Fläche/Umfang ≥ min/2. */
export function pieceCuttable(poly: Pt[], minPieceMm: number): boolean {
  if (poly.length < 3) return false;
  const A = area(poly);
  const P = edgeLengths(poly).reduce((s, v) => s + v, 0);
  if (P <= 0) return false;
  return (2 * A) / P >= minPieceMm / 2 - 1e-9;
}

export interface CutInfo {
  shape: ShapeType;
  /** Außenmaße (Begrenzungsrechteck) des Steins */
  w: number;
  h: number;
  area: number;
  /** Rohsteinmaß, aus dem geschnitten wird */
  rawW: number;
  rawH: number;
  needsCut: boolean;
  /** passt das Teil überhaupt in einen Rohstein? */
  fits: boolean;
  /** Teil wurde für die Vorlage um 90° gedreht */
  rotated: boolean;
  /** Teilpolygon im Rohstein-Koordinatensystem (Ursprung oben links am Rohstein) */
  polyInRaw: Pt[];
  /** Schnittlinien über den Rohstein */
  cutLines: [Pt, Pt][];
  edges: number[];
  angles: number[];
  convex: boolean;
  /** wie viele solche Teile liefert ein Rohstein (konservativ) */
  yieldPerRaw: number;
  /** Gruppierungsschlüssel identischer Schnittvorlagen */
  signature: string;
}

function placeCandidates(poly: Pt[], W: number, H: number): Pt[][] {
  const b = bbox(poly);
  const base = translate(poly, -b.minX, -b.minY);
  const dxs = [0, W - b.w];
  const dys = [0, H - b.h];
  const res: Pt[][] = [];
  for (const dx of dxs) for (const dy of dys) res.push(translate(base, dx, dy));
  return res;
}

function cutLinesFor(polyInRaw: Pt[], W: number, H: number): [Pt, Pt][] {
  const lines: [Pt, Pt][] = [];
  const n = polyInRaw.length;
  for (let i = 0; i < n; i++) {
    const a = polyInRaw[i];
    const b = polyInRaw[(i + 1) % n];
    if (edgeOnRectBoundary(a, b, W, H)) continue;
    const seg = lineThroughRect(a, b, W, H);
    if (!seg) continue;
    // Doppelte (kollineare) Linien vermeiden
    const dup = lines.some(([p, q]) => {
      const cr1 = (q.x - p.x) * (seg[0].y - p.y) - (q.y - p.y) * (seg[0].x - p.x);
      const cr2 = (q.x - p.x) * (seg[1].y - p.y) - (q.y - p.y) * (seg[1].x - p.x);
      return Math.abs(cr1) < 1e-6 && Math.abs(cr2) < 1e-6;
    });
    if (!dup) lines.push(seg);
  }
  return lines;
}

function isRightTriangleFittingTwice(poly: Pt[], W: number, H: number): boolean {
  if (poly.length !== 3) return false;
  const ang = interiorAngles(poly);
  const ri = ang.findIndex((a) => Math.abs(a - 90) < 0.5);
  if (ri < 0) return false;
  const p = poly[ri];
  const l1 = Math.hypot(poly[(ri + 1) % 3].x - p.x, poly[(ri + 1) % 3].y - p.y);
  const l2 = Math.hypot(poly[(ri + 2) % 3].x - p.x, poly[(ri + 2) % 3].y - p.y);
  const fit = (a: number, b: number) => a <= W + DIM_TOL && b <= H + DIM_TOL;
  return fit(l1, l2) || fit(l2, l1);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Berechnet die Schnittinformation eines Steins bezogen auf das Rohsteinmaß.
 * Alle Werte stammen aus der tatsächlichen Polygon-Geometrie.
 */
export function analyzeCut(polyAbs: Pt[], rawW: number, rawH: number): CutInfo {
  const poly = cleanPoly(polyAbs);
  const b = bbox(poly);
  const shape = classifyShape(poly);
  const A = area(poly);
  const axisRect = isAxisRect(poly);
  const exactRaw =
    axisRect &&
    ((Math.abs(b.w - rawW) < DIM_TOL && Math.abs(b.h - rawH) < DIM_TOL) || (Math.abs(b.w - rawH) < DIM_TOL && Math.abs(b.h - rawW) < DIM_TOL));

  // Platzierung im Rohstein mit möglichst wenigen Schnitten
  let best: { poly: Pt[]; lines: [Pt, Pt][]; rotated: boolean } | null = null;
  for (const rotated of [false, true]) {
    const src = rotated ? rotate90(poly) : poly;
    const sb = bbox(src);
    if (sb.w > rawW + DIM_TOL || sb.h > rawH + DIM_TOL) continue;
    for (const cand of placeCandidates(src, rawW, rawH)) {
      const lines = cutLinesFor(cand, rawW, rawH);
      if (!best || lines.length < best.lines.length) best = { poly: cand, lines, rotated };
    }
  }
  const fits = best !== null;
  const placed = best ?? { poly: translate(poly, -b.minX, -b.minY), lines: [], rotated: false };

  let yieldPerRaw = 1;
  if (!fits) yieldPerRaw = 0;
  else if (exactRaw) yieldPerRaw = 1;
  else if (axisRect) {
    const f = (W: number, H: number) => Math.floor((W + DIM_TOL) / b.w) * Math.floor((H + DIM_TOL) / b.h);
    yieldPerRaw = Math.max(1, f(rawW, rawH), f(rawH, rawW));
  } else if (shape === 'triangle' && isRightTriangleFittingTwice(poly, rawW, rawH)) {
    yieldPerRaw = 2;
  }

  const rel = placed.poly.map((p) => ({ x: round2(p.x), y: round2(p.y) }));
  const signature = `${shape}|${round2(rawW)}x${round2(rawH)}|${rel.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(';')}`;
  return {
    shape,
    w: b.w,
    h: b.h,
    area: A,
    rawW,
    rawH,
    needsCut: !exactRaw,
    fits,
    rotated: placed.rotated,
    polyInRaw: placed.poly,
    cutLines: exactRaw ? [] : placed.lines,
    edges: edgeLengths(placed.poly),
    angles: interiorAngles(placed.poly),
    convex: isConvex(placed.poly),
    yieldPerRaw,
    signature,
  };
}
