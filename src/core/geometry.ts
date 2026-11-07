/**
 * Polygon-Geometrie in Millimetern. Alle Polygone sind einfache Polygone
 * (Ecken im Uhrzeigersinn oder gegen den Uhrzeigersinn, nicht geschlossen,
 * d. h. letzter Punkt ≠ erster Punkt).
 */

export interface Pt {
  x: number;
  y: number;
}

export type ShapeType = 'square' | 'rectangle' | 'triangle' | 'rhombus' | 'trapezoid' | 'parallelogram' | 'custom';

export const GEOM_EPS = 1e-6;
/** Toleranz für Maßvergleiche (Schnittgenauigkeit der Zange liegt deutlich darüber). */
export const DIM_TOL = 0.05;

export function signedArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

export function area(poly: Pt[]): number {
  return Math.abs(signedArea(poly));
}

export function bbox(poly: Pt[]): { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function rectPoly(x: number, y: number, w: number, h: number): Pt[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/**
 * Sutherland–Hodgman: behält den Teil des Polygons mit  nx*x + ny*y <= c.
 */
export function clipHalfPlane(poly: Pt[], nx: number, ny: number, c: number): Pt[] {
  const out: Pt[] = [];
  const n = poly.length;
  if (n === 0) return out;
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % n];
    const dc = nx * cur.x + ny * cur.y - c;
    const dn = nx * nxt.x + ny * nxt.y - c;
    const curIn = dc <= GEOM_EPS;
    const nxtIn = dn <= GEOM_EPS;
    if (curIn) out.push(cur);
    if (curIn !== nxtIn) {
      const t = dc / (dc - dn);
      out.push({ x: cur.x + t * (nxt.x - cur.x), y: cur.y + t * (nxt.y - cur.y) });
    }
  }
  return cleanPoly(out);
}

/** Entfernt doppelte und kollineare Punkte. */
export function cleanPoly(poly: Pt[]): Pt[] {
  let pts = poly.slice();
  // Duplikate
  const dedup: Pt[] = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (!last || Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9) dedup.push(p);
  }
  if (dedup.length > 1) {
    const f = dedup[0];
    const l = dedup[dedup.length - 1];
    if (Math.abs(f.x - l.x) <= 1e-9 && Math.abs(f.y - l.y) <= 1e-9) dedup.pop();
  }
  pts = dedup;
  // Kollineare Punkte
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const len = Math.hypot(c.x - a.x, c.y - a.y) || 1;
      if (Math.abs(cross) / len < 1e-7) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

export function edgeLengths(poly: Pt[]): number[] {
  return poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return Math.hypot(q.x - p.x, q.y - p.y);
  });
}

/** Innenwinkel in Grad an jeder Ecke (für einfache Polygone). */
export function interiorAngles(poly: Pt[]): number[] {
  const n = poly.length;
  const orient = Math.sign(signedArea(poly)) || 1;
  const res: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[(i - 1 + n) % n];
    const b = poly[i];
    const c = poly[(i + 1) % n];
    const v1x = a.x - b.x;
    const v1y = a.y - b.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    let ang = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y) * (180 / Math.PI);
    // Für gegen den Uhrzeigersinn (mathematisch positiv) orientierte Polygone ist der Innenwinkel 360 - ...
    ang = orient > 0 ? -ang : ang;
    if (ang < 0) ang += 360;
    res.push(ang);
  }
  return res;
}

export function isConvex(poly: Pt[]): boolean {
  const n = poly.length;
  if (n < 4) return true;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const c = poly[(i + 2) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function segIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

/** Prüft, ob sich Kanten (nicht benachbarte) schneiden. */
export function isSimple(poly: Pt[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segIntersect(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** true, wenn sich zwei einfache Polygone flächig überlappen. */
export function polygonsOverlap(a: Pt[], b: Pt[]): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
    }
  }
  const ca = centroid(a);
  const cb = centroid(b);
  if (pointInPolygon(ca, b) || pointInPolygon(cb, a)) return true;
  return false;
}

export function centroid(poly: Pt[]): Pt {
  let cx = 0;
  let cy = 0;
  let A = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const cr = p.x * q.y - q.x * p.y;
    A += cr;
    cx += (p.x + q.x) * cr;
    cy += (p.y + q.y) * cr;
  }
  if (Math.abs(A) < 1e-12) {
    const s = poly.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: s.x / poly.length, y: s.y / poly.length };
  }
  return { x: cx / (3 * A), y: cy / (3 * A) };
}

function parallel(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const ax = p2.x - p1.x;
  const ay = p2.y - p1.y;
  const bx = p4.x - p3.x;
  const by = p4.y - p3.y;
  const cr = ax * by - ay * bx;
  return Math.abs(cr) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1) < 1e-3;
}

/** Bestimmt die Form eines Polygons anhand seiner tatsächlichen Geometrie. */
export function classifyShape(poly: Pt[]): ShapeType {
  const p = cleanPoly(poly);
  if (p.length === 3) return 'triangle';
  if (p.length === 4 && isConvex(p)) {
    const L = edgeLengths(p);
    const ang = interiorAngles(p);
    const allRight = ang.every((a) => Math.abs(a - 90) < 0.5);
    const par02 = parallel(p[0], p[1], p[3], p[2]);
    const par13 = parallel(p[1], p[2], p[0], p[3]);
    const allEqual = L.every((l) => Math.abs(l - L[0]) < DIM_TOL);
    if (allRight) return allEqual ? 'square' : 'rectangle';
    if (par02 && par13) return allEqual ? 'rhombus' : 'parallelogram';
    if (par02 || par13) return 'trapezoid';
    return 'custom';
  }
  return 'custom';
}

/** Achsparalleles Rechteck? */
export function isAxisRect(poly: Pt[]): boolean {
  const p = cleanPoly(poly);
  if (p.length !== 4) return false;
  const b = bbox(p);
  return p.every(
    (q) => (Math.abs(q.x - b.minX) < 1e-6 || Math.abs(q.x - b.maxX) < 1e-6) && (Math.abs(q.y - b.minY) < 1e-6 || Math.abs(q.y - b.maxY) < 1e-6),
  );
}

export function translate(poly: Pt[], dx: number, dy: number): Pt[] {
  return poly.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

export function rotate90(poly: Pt[]): Pt[] {
  // (x, y) -> (-y, x), danach wieder in den positiven Quadranten verschieben
  const r = poly.map((p) => ({ x: -p.y, y: p.x }));
  const b = bbox(r);
  return translate(r, -b.minX, -b.minY);
}

/**
 * Schneidet die unendliche Gerade durch a–b mit dem Rechteck [0,W]×[0,H].
 * Liefert das Segment (Schnittlinie über den ganzen Rohstein) oder null.
 */
export function lineThroughRect(a: Pt, b: Pt, W: number, H: number): [Pt, Pt] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const pts: Pt[] = [];
  const add = (p: Pt) => {
    if (p.x < -1e-6 || p.x > W + 1e-6 || p.y < -1e-6 || p.y > H + 1e-6) return;
    if (pts.some((q) => Math.abs(q.x - p.x) < 1e-6 && Math.abs(q.y - p.y) < 1e-6)) return;
    pts.push({ x: Math.min(W, Math.max(0, p.x)), y: Math.min(H, Math.max(0, p.y)) });
  };
  if (Math.abs(dx) > 1e-12) {
    for (const X of [0, W]) {
      const t = (X - a.x) / dx;
      add({ x: X, y: a.y + t * dy });
    }
  }
  if (Math.abs(dy) > 1e-12) {
    for (const Y of [0, H]) {
      const t = (Y - a.y) / dy;
      add({ x: a.x + t * dx, y: Y });
    }
  }
  if (pts.length < 2) return null;
  // die beiden am weitesten entfernten Punkte
  let best: [Pt, Pt] = [pts[0], pts[1]];
  let bd = -1;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d > bd) {
        bd = d;
        best = [pts[i], pts[j]];
      }
    }
  if (bd < 1e-6) return null;
  return best;
}

/** Liegt die Kante a–b auf dem Rand des Rechtecks [0,W]×[0,H]? */
export function edgeOnRectBoundary(a: Pt, b: Pt, W: number, H: number): boolean {
  const tol = 1e-6;
  const onX0 = Math.abs(a.x) < tol && Math.abs(b.x) < tol;
  const onXW = Math.abs(a.x - W) < tol && Math.abs(b.x - W) < tol;
  const onY0 = Math.abs(a.y) < tol && Math.abs(b.y) < tol;
  const onYH = Math.abs(a.y - H) < tol && Math.abs(b.y - H) < tol;
  return onX0 || onXW || onY0 || onYH;
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Formatiert mm-Werte mit Komma (deutsch) oder Punkt. */
export function fmtMm(v: number, decimals = 1, locale = 'de'): string {
  const s = (Math.round(v * Math.pow(10, decimals)) / Math.pow(10, decimals)).toFixed(decimals);
  const trimmed = decimals > 0 ? s.replace(/\.?0+$/, '') : s;
  return locale === 'en' ? trimmed : trimmed.replace('.', ',');
}
