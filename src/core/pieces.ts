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
  minCaliperWidth,
  pointStrictlyInside,
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
  // Ist die Fuge so breit, dass kein Teilstein übrig bleibt, entstehen leere Teile (Fläche 0)
  // statt „umgeklappter“ Rechtecke mit negativer Breite – leere Teile gelten nie als schneidbar.
  const sw = Math.max(0, (r.w - (k - 1) * g) / k);
  const sh = Math.max(0, (r.h - (k - 1) * g) / k);
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

/** Teil ohne Fläche (weniger als drei Ecken oder Fläche < 1e-6 mm²), z. B. wenn die Fuge breiter als der Stein ist. */
export function isDegeneratePiece(poly: Pt[]): boolean {
  const p = cleanPoly(poly);
  if (p.length < 3) return true;
  if (p.some((q) => !Number.isFinite(q.x) || !Number.isFinite(q.y))) return true;
  return !(area(p) >= 1e-6);
}

/** Ergebnis der Mindestbreiten-Prüfung eines Teils mit den tatsächlich gemessenen Werten (mm). */
export interface WidthCheck {
  /** schmalste Stelle = minimale Kaliberweite (bei nicht-konvexen Teilen: der konvexen Hülle) */
  caliper: number;
  /** Inkreismaß = 4 · Fläche / Umfang; bei Dreiecken genau der Inkreisdurchmesser */
  incircle: number;
  ok: boolean;
  /** welche Bedingung nicht erfüllt ist ('caliper' hat Vorrang, wenn beide verletzt sind) */
  failed: 'degenerate' | 'caliper' | 'incircle' | null;
}

/**
 * Mindestbreite eines Schnittteils („Mindestbreite“ in Schritt Steinformen). Beide Bedingungen müssen gelten:
 *  1. schmalste Stelle (minimale Kaliberweite) ≥ min – verhindert schmale Streifen wie 1 × 5 mm,
 *  2. Inkreismaß 4·Fläche/Umfang ≥ min (gleichwertig zum früheren Kriterium 2·Fläche/Umfang ≥ min/2) –
 *     bei Dreiecken ist das der Inkreisdurchmesser und stets die strengere Bedingung (spitze Ecken).
 * Gegenüber früher wird nur verschärft, nie gelockert. Alle automatischen Teile (Diagonale,
 * Kantenschnitt, Teilsteine) sind konvex – dort ist die Breite exakt; bei nicht-konvexen
 * Freiformteilen ist es die Breite der konvexen Hülle (nur näherungsweise).
 */
export function pieceWidthCheck(poly: Pt[], minPieceMm: number): WidthCheck {
  if (poly.length < 3) return { caliper: 0, incircle: 0, ok: false, failed: 'degenerate' };
  const A = area(poly);
  const P = edgeLengths(poly).reduce((s, v) => s + v, 0);
  if (!(P > 0) || isDegeneratePiece(poly)) return { caliper: 0, incircle: 0, ok: false, failed: 'degenerate' };
  const incircle = (4 * A) / P;
  const caliper = minCaliperWidth(poly);
  // exakt dieselben Toleranzen wie bisher (Golden-Hashes bleiben gleich)
  const incOk = (2 * A) / P >= minPieceMm / 2 - 1e-9;
  const calOk = caliper >= minPieceMm - 1e-6;
  return { caliper, incircle, ok: incOk && calOk, failed: !calOk ? 'caliper' : !incOk ? 'incircle' : null };
}

/** Ist das Teil mit der eingestellten Mindestbreite schneidbar? (siehe pieceWidthCheck) */
export function pieceCuttable(poly: Pt[], minPieceMm: number): boolean {
  return pieceWidthCheck(poly, minPieceMm).ok;
}

/** Das am wenigsten breite Teil einer Liste (zuerst ein ungültiges, sonst das mit dem kleinsten Grenzwert). */
export function worstWidth(polys: Pt[][], minPieceMm: number): WidthCheck {
  let worst: WidthCheck | null = null;
  for (const p of polys) {
    const w = pieceWidthCheck(p, minPieceMm);
    if (!worst || (w.failed === 'degenerate' && worst.failed !== 'degenerate') || (worst.failed !== 'degenerate' && Math.min(w.caliper, w.incircle) < Math.min(worst.caliper, worst.incircle))) worst = w;
  }
  return worst ?? { caliper: 0, incircle: 0, ok: false, failed: 'degenerate' };
}

/**
 * Größte Mindestbreite (in 0,1-mm-Schritten abgerundet), bei der alle Teile noch zulässig sind –
 * für Hinweise wie „Dreiecke wären bis zu einer Mindestbreite von 1,9 mm möglich“. 0, wenn nie.
 */
export function maxAllowedMinWidth(polys: Pt[][]): number {
  let lim = Infinity;
  for (const p of polys) {
    const w = pieceWidthCheck(p, 0);
    if (w.failed === 'degenerate') return 0;
    lim = Math.min(lim, w.caliper, w.incircle);
  }
  if (!Number.isFinite(lim)) return 0;
  let v = Math.floor(lim * 10 + 1e-9) / 10;
  // gegen Rundung absichern: der angezeigte Wert muss die Prüfung tatsächlich bestehen
  while (v > 0 && !polys.every((p) => pieceCuttable(p, v))) v = Math.round((v - 0.1) * 10) / 10;
  return Math.max(0, v);
}

/** Winkel der automatischen Kantenschnitte (Normalenrichtung, 15°-Schritte) – wie in computeMosaic. */
export const LINE_ANGLES = Array.from({ length: 12 }, (_, i) => (i * 15 * Math.PI) / 180);

/** Versätze der automatischen Kantenschnitte für eine Richtung (0,5-mm-Raster) – wie in computeMosaic. */
export function lineOffsets(r: CellRect, nx: number, ny: number): number[] {
  const ext = Math.abs(nx) * (r.w / 2) + Math.abs(ny) * (r.h / 2);
  const out: number[] = [];
  for (let d = -ext + 0.5; d <= ext - 0.5 + 1e-9; d += 0.5) out.push(Math.round(d * 2) / 2);
  return out;
}

/**
 * Gibt es für diese Zelle überhaupt einen automatischen Kantenschnitt (Winkel/Versatz wie in der
 * Berechnung), dessen beide Teile die Mindestbreite erfüllen? Rein geometrisch, ohne Bildinhalt.
 */
export function anyLineSplitCuttable(r: CellRect, g: number, minPieceMm: number): boolean {
  for (const a of LINE_ANGLES) {
    const nx = Math.cos(a);
    const ny = Math.sin(a);
    for (const d of lineOffsets(r, nx, ny)) {
      const [pa, pb] = lineSplit(r, nx, ny, d, g);
      if (pieceCuttable(pa, minPieceMm) && pieceCuttable(pb, minPieceMm)) return true;
    }
  }
  return false;
}

/** Ist die k×k-Unterteilung dieser Zelle zulässig? Dieselbe Regel wie in der Berechnung und bei manuellen Änderungen. */
export function subdivisionCuttable(r: CellRect, k: number, g: number, minPieceMm: number): boolean {
  if (!(k >= 2)) return false;
  return subRects(r, k, g).every((p) => pieceCuttable(p, minPieceMm));
}

/** Art einer Schnittlinie: durchgehend (ritzen und brechen) oder Einschnitt, der an einer Innenecke endet. */
export type CutKind = 'through' | 'notch';

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
  /**
   * Schnittlinien im Rohstein. Durchgehende Schnitte laufen von Rohsteinrand zu Rohsteinrand.
   * Bei nicht-konvexen Teilen enden Einschnitte (cutKinds[i] === 'notch') an einer Innenecke
   * bzw. an der Steinkante; ihr erster Punkt liegt – falls vorhanden – auf dem Rohsteinrand oder
   * auf einem zuvor ausgeführten durchgehenden Schnitt. Durchgehende Schnitte stehen vorn.
   * Keine Linie führt durch das Innere des Teils.
   */
  cutLines: [Pt, Pt][];
  /** Art jeder Schnittlinie, parallel zu cutLines */
  cutKinds: CutKind[];
  edges: number[];
  angles: number[];
  convex: boolean;
  /** wie viele solche Teile liefert ein Rohstein (konservativ) */
  yieldPerRaw: number;
  /** Gruppierungsschlüssel identischer Schnittvorlagen */
  signature: string;
  /**
   * Das Teil hat keine Fläche (z. B. Fuge breiter als der Stein). Alle Zahlen sind dann endliche
   * Nullwerte; es gibt keine Schnittmaße und keine Vorlage.
   */
  invalid?: boolean;
}

/** Eine Schnittlinie mit Art und eigener Nummer (Schnitt 1, 2 … bzw. Einschnitt 1, 2 …). */
export interface CutLineItem {
  /** 'notch': Einschnitt bis zu einer Innenecke (Ecke des Teils), 'notchEdge': bis zur Steinkante */
  kind: 'through' | 'notch' | 'notchEdge';
  no: number;
  a: Pt;
  b: Pt;
}

/**
 * Schnittlinien in Ausführungsreihenfolge (durchgehende Schnitte zuerst), getrennt nummeriert –
 * dieselbe Liste für das Steindetail, die Schnittvorlage und das PDF.
 */
export function cutLineItems(info: CutInfo): CutLineItem[] {
  const isVertex = (p: Pt) => info.polyInRaw.some((q) => Math.abs(q.x - p.x) < 1e-6 && Math.abs(q.y - p.y) < 1e-6);
  let through = 0;
  let notch = 0;
  return info.cutLines.map(([a, b], i): CutLineItem => {
    if ((info.cutKinds[i] ?? 'through') === 'notch') return { kind: isVertex(b) ? 'notch' : 'notchEdge', no: ++notch, a, b };
    return { kind: 'through', no: ++through, a, b };
  });
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

function sameLine(p: Pt, q: Pt, seg: [Pt, Pt]): boolean {
  const cr1 = (q.x - p.x) * (seg[0].y - p.y) - (q.y - p.y) * (seg[0].x - p.x);
  const cr2 = (q.x - p.x) * (seg[1].y - p.y) - (q.y - p.y) * (seg[1].x - p.x);
  return Math.abs(cr1) < 1e-6 && Math.abs(cr2) < 1e-6;
}

const samePt = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

/** Konvexe Teile: jede Kante wird zur Geraden über den ganzen Rohstein verlängert (sie berührt das Teil nur am Rand). */
function cutLinesConvex(polyInRaw: Pt[], W: number, H: number): [Pt, Pt][] {
  const lines: [Pt, Pt][] = [];
  const n = polyInRaw.length;
  for (let i = 0; i < n; i++) {
    const a = polyInRaw[i];
    const b = polyInRaw[(i + 1) % n];
    if (edgeOnRectBoundary(a, b, W, H)) continue;
    const seg = lineThroughRect(a, b, W, H);
    if (!seg) continue;
    // Doppelte (kollineare) Linien vermeiden
    if (!lines.some(([p, q]) => sameLine(p, q, seg))) lines.push(seg);
  }
  return lines;
}

/**
 * Nicht-konvexe Teile: Die Verlängerung einer Kante darf nicht durch das Teil laufen.
 * Die Gerade über den Rohstein wird an allen Berührungs- und Schnittpunkten mit dem Teilrand in
 * Intervalle zerlegt; ein Intervall gilt als „innen“, wenn seine Mitte echt im Teil liegt.
 * Ausgegeben wird der längste zusammenhängende Abschnitt außerhalb des Teils, der die Kante enthält.
 * Reicht er von Rohsteinrand zu Rohsteinrand, ist es ein durchgehender Schnitt, sonst ein Einschnitt.
 */
function cutLinesNonConvex(poly: Pt[], W: number, H: number): { lines: [Pt, Pt][]; kinds: CutKind[] } {
  const through: [Pt, Pt][] = [];
  const notches: [Pt, Pt][] = [];
  const n = poly.length;
  const ON_LINE = 1e-7;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if (edgeOnRectBoundary(a, b, W, H)) continue;
    const full = lineThroughRect(a, b, W, H);
    if (!full) continue;
    const [P0, P1] = full;
    const dx = P1.x - P0.x;
    const dy = P1.y - P0.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    const at = (t: number): Pt => (t <= 0 ? P0 : t >= 1 ? P1 : { x: P0.x + t * dx, y: P0.y + t * dy });
    const tOf = (p: Pt) => ((p.x - P0.x) * dx + (p.y - P0.y) * dy) / (L * L);
    // vorzeichenbehafteter Abstand zur Geraden
    const sd = (p: Pt) => (dx * (p.y - P0.y) - dy * (p.x - P0.x)) / L;
    const ts: number[] = [0, 1];
    for (let j = 0; j < n; j++) {
      const c = poly[j];
      const d = poly[(j + 1) % n];
      const sc = sd(c);
      const sdd = sd(d);
      const cOn = Math.abs(sc) < ON_LINE;
      const dOn = Math.abs(sdd) < ON_LINE;
      if (cOn) ts.push(tOf(c));
      if (dOn) ts.push(tOf(d));
      if (!cOn && !dOn && sc * sdd < 0) {
        const u = sc / (sc - sdd);
        ts.push(tOf({ x: c.x + u * (d.x - c.x), y: c.y + u * (d.y - c.y) }));
      }
    }
    const sorted = ts.map((t) => Math.min(1, Math.max(0, t))).sort((p, q) => p - q);
    const T: number[] = [];
    for (const t of sorted) if (T.length === 0 || t - T[T.length - 1] > 1e-9) T.push(t);
    if (T[T.length - 1] < 1) T.push(1);
    const m = T.length - 1; // Anzahl Intervalle
    if (m < 1) continue;
    const inside: boolean[] = [];
    for (let k = 0; k < m; k++) inside.push(pointStrictlyInside(at((T[k] + T[k + 1]) / 2), poly));
    const tm = Math.min(1, Math.max(0, tOf({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })));
    let k0 = 0;
    while (k0 < m - 1 && T[k0 + 1] < tm) k0++;
    let seg: [Pt, Pt];
    let kind: CutKind;
    if (inside[k0]) {
      // numerisch unklarer Fall: nur die Kante selbst (liegt auf dem Rand, nie im Teil)
      seg = [a, b];
      kind = 'notch';
    } else {
      let lo = k0;
      while (lo > 0 && !inside[lo - 1]) lo--;
      let hi = k0;
      while (hi < m - 1 && !inside[hi + 1]) hi++;
      const onRaw0 = T[lo] <= 1e-9;
      const onRaw1 = T[hi + 1] >= 1 - 1e-9;
      const q0 = at(T[lo]);
      const q1 = at(T[hi + 1]);
      kind = onRaw0 && onRaw1 ? 'through' : 'notch';
      // Einschnitt: Punkt auf dem Rohsteinrand zuerst, Ende an der Innenecke als zweiter Punkt
      seg = !onRaw0 && onRaw1 ? [q1, q0] : [q0, q1];
    }
    if (kind === 'through') {
      if (!through.some(([p, q]) => sameLine(p, q, seg))) through.push(seg);
    } else notches.push(seg);
  }
  // Die durchgehenden Schnitte werden zuerst ausgeführt. Ein Einschnitt beginnt deshalb erst an der
  // Kante, die nach diesen Schnitten übrig ist (Rohstein ∩ Steinseite jedes durchgehenden Schnitts).
  // Der Stein liegt vollständig auf einer Seite jedes durchgehenden Schnitts (er wird nicht gekreuzt).
  const planes = through.map(([p, q]) => {
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const L = Math.hypot(dx, dy) || 1;
    const f = (r: Pt) => (dx * (r.y - p.y) - dy * (r.x - p.x)) / L;
    let side = 0;
    let far = 0;
    for (const v of poly) {
      const d = f(v);
      if (Math.abs(d) > far) {
        far = Math.abs(d);
        side = Math.sign(d);
      }
    }
    return { f, side };
  });
  const clippedNotches: [Pt, Pt][] = [];
  for (const [p, q] of notches) {
    let t0 = 0;
    let t1 = 1;
    for (const { f, side } of planes) {
      if (side === 0) continue;
      const a = side * f(p);
      const b = side * f(q);
      if (a < -1e-9 && b < -1e-9) {
        t0 = 1;
        t1 = 0;
        break;
      }
      if (a < -1e-9) t0 = Math.max(t0, a / (a - b));
      else if (b < -1e-9) t1 = Math.min(t1, a / (a - b));
    }
    if (t1 - t0 <= 1e-9) continue;
    const at = (t: number): Pt => (t <= 0 ? p : t >= 1 ? q : { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
    const seg: [Pt, Pt] = [at(t0), at(t1)];
    if (Math.hypot(seg[1].x - seg[0].x, seg[1].y - seg[0].y) < 1e-6) continue;
    if (!clippedNotches.some(([u, v]) => (samePt(u, seg[0]) && samePt(v, seg[1])) || (samePt(u, seg[1]) && samePt(v, seg[0])))) clippedNotches.push(seg);
  }
  return {
    lines: [...through, ...clippedNotches],
    kinds: [...through.map((): CutKind => 'through'), ...clippedNotches.map((): CutKind => 'notch')],
  };
}

/** Schnittlinien eines im Rohstein platzierten Teils. Für konvexe Teile unverändert gegenüber früher. */
export function cutLinesFor(polyInRaw: Pt[], W: number, H: number): { lines: [Pt, Pt][]; kinds: CutKind[] } {
  if (isConvex(polyInRaw)) {
    const lines = cutLinesConvex(polyInRaw, W, H);
    return { lines, kinds: lines.map((): CutKind => 'through') };
  }
  return cutLinesNonConvex(polyInRaw, W, H);
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
  if (isDegeneratePiece(poly)) {
    // Kein echtes Teil (z. B. Fuge breiter als der Stein): endliche Nullwerte statt ±Infinity
    return {
      shape: 'custom',
      w: 0,
      h: 0,
      area: 0,
      rawW,
      rawH,
      needsCut: false,
      fits: false,
      rotated: false,
      polyInRaw: [],
      cutLines: [],
      cutKinds: [],
      edges: [],
      angles: [],
      convex: true,
      yieldPerRaw: 1,
      signature: `invalid|${round2(rawW)}x${round2(rawH)}`,
      invalid: true,
    };
  }
  const b = bbox(poly);
  const shape = classifyShape(poly);
  const A = area(poly);
  const axisRect = isAxisRect(poly);
  const exactRaw =
    axisRect &&
    ((Math.abs(b.w - rawW) < DIM_TOL && Math.abs(b.h - rawH) < DIM_TOL) || (Math.abs(b.w - rawH) < DIM_TOL && Math.abs(b.h - rawW) < DIM_TOL));

  // Platzierung im Rohstein: möglichst wenige Einschnitte, dann möglichst wenige Schnitte
  let best: { poly: Pt[]; lines: [Pt, Pt][]; kinds: CutKind[]; notches: number; rotated: boolean } | null = null;
  for (const rotated of [false, true]) {
    const src = rotated ? rotate90(poly) : poly;
    const sb = bbox(src);
    if (sb.w > rawW + DIM_TOL || sb.h > rawH + DIM_TOL) continue;
    for (const cand of placeCandidates(src, rawW, rawH)) {
      const { lines, kinds } = cutLinesFor(cand, rawW, rawH);
      const notches = kinds.reduce((s, k) => s + (k === 'notch' ? 1 : 0), 0);
      if (!best || notches < best.notches || (notches === best.notches && lines.length < best.lines.length)) best = { poly: cand, lines, kinds, notches, rotated };
    }
  }
  const fits = best !== null;
  const placed = best ?? { poly: translate(poly, -b.minX, -b.minY), lines: [] as [Pt, Pt][], kinds: [] as CutKind[], rotated: false };

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
    cutKinds: exactRaw ? [] : placed.kinds,
    edges: edgeLengths(placed.poly),
    angles: interiorAngles(placed.poly),
    convex: isConvex(placed.poly),
    yieldPerRaw,
    signature,
  };
}
