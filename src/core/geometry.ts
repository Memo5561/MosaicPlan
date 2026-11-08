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

/** Kreuzprodukt (a − o) × (b − o): > 0, wenn o → a → b mathematisch positiv dreht. */
function cross3(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** Echte Kreuzung zweier Strecken (beide Strecken wechseln die Seite der anderen; Berührungen zählen nicht). */
function segProperCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = cross3(p3, p4, p1);
  const d2 = cross3(p3, p4, p2);
  const d3 = cross3(p1, p2, p3);
  const d4 = cross3(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * Kleinster Abstand zweier Strecken in mm: 0, wenn sie sich kreuzen oder berühren (auch an einem
 * Endpunkt oder kollinear überlappend), sonst der kleinste Abstand eines Endpunkts zur anderen Strecke
 * (bei sich nicht schneidenden Strecken liegt das Minimum immer an einem Endpunkt).
 */
export function segmentDistance(p1: Pt, p2: Pt, p3: Pt, p4: Pt): number {
  if (segProperCross(p1, p2, p3, p4)) return 0;
  return Math.min(distToSegment(p1, p3, p4), distToSegment(p2, p3, p4), distToSegment(p3, p1, p2), distToSegment(p4, p1, p2));
}

/** Toleranz (mm), ab der sich zwei nicht benachbarte Kanten eines Polygons „berühren“. */
const TOUCH_EPS = 1e-7;

/**
 * Ist das Polygon einfach (ein zusammenhängender Rand ohne Selbstberührung)? Nicht benachbarte Kanten
 * dürfen sich weder kreuzen noch berühren – auch nicht an einer Ecke, die auf einer anderen Kante liegt,
 * oder kollinear überlappend (das frühere strikte Kriterium übersah diese Fälle). Benachbarte Kanten
 * dürfen nicht auf sich selbst zurücklaufen (Spitze mit 0°).
 */
export function isSimple(poly: Pt[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segmentDistance(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n]) <= TOUCH_EPS) return false;
    }
  }
  if (n > 3) {
    for (let i = 0; i < n; i++) {
      const a = poly[(i - 1 + n) % n];
      const b = poly[i];
      const c = poly[(i + 1) % n];
      const len = Math.hypot(c.x - a.x, c.y - a.y);
      // kollinear und zurücklaufend: a und c liegen auf derselben Seite von b
      const collinear = Math.abs(cross3(a, b, c)) <= 1e-12 * Math.max(1, len);
      if (collinear && (a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y) > 0) return false;
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

/**
 * true, wenn sich zwei einfache Polygone flächig überlappen, d. h. die exakte Schnittfläche
 * (polygonIntersectionArea) größer als `minArea` mm² ist. Berührungen an Kanten oder Ecken sind keine
 * Überlappung. (Früher: nur echte Kantenkreuzungen plus Schwerpunkttest – übersah kollineare Kanten und
 * Ecken auf Kanten.)
 */
export function polygonsOverlap(a: Pt[], b: Pt[], minArea = 1e-6): boolean {
  return polygonIntersectionArea(a, b) > minArea;
}

function pointInTriangleClosed(p: Pt, a: Pt, b: Pt, c: Pt): boolean {
  // Dreieck a, b, c mathematisch positiv orientiert; Punkte auf dem Rand zählen als innen
  return cross3(a, b, p) >= -1e-12 && cross3(b, c, p) >= -1e-12 && cross3(c, a, p) >= -1e-12;
}

/**
 * Zerlegt ein einfaches Polygon in Dreiecke (Ohrenschneiden). Das Polygon wird zuerst bereinigt
 * (cleanPoly) und mathematisch positiv orientiert (signedArea > 0); alle Dreiecke haben diese
 * Orientierung und zusammen genau die Fläche des Polygons. Weniger als drei Ecken oder Fläche 0 → [].
 * Für nicht einfache Polygone ist das Ergebnis nicht definiert (die Freiform-Prüfung meldet diese vorher).
 */
export function triangulate(poly: Pt[]): Pt[][] {
  let p = cleanPoly(poly);
  if (p.length < 3) return [];
  const sa = signedArea(p);
  if (!(Math.abs(sa) > 1e-12)) return [];
  if (sa < 0) p = p.slice().reverse();
  const out: Pt[][] = [];
  let guard = p.length * p.length + 16;
  while (p.length > 3 && guard-- > 0) {
    const n = p.length;
    let ear = -1;
    for (let i = 0; i < n && ear < 0; i++) {
      const a = p[(i - 1 + n) % n];
      const b = p[i];
      const c = p[(i + 1) % n];
      if (cross3(a, b, c) <= 1e-12) continue; // spitze nach innen (Reflexecke) oder kollinear
      let blocked = false;
      for (let k = 0; k < n && !blocked; k++) {
        if (k === i || k === (i - 1 + n) % n || k === (i + 1) % n) continue;
        if (pointInTriangleClosed(p[k], a, b, c)) blocked = true;
      }
      if (!blocked) ear = i;
    }
    if (ear < 0) {
      // numerisch entartet: eine kollineare Ecke trägt keine Fläche bei und darf entfallen
      const k = p.findIndex((_, i) => Math.abs(cross3(p[(i - 1 + n) % n], p[i], p[(i + 1) % n])) <= 1e-12);
      if (k >= 0) {
        p = p.filter((_, i) => i !== k);
        continue;
      }
      break;
    }
    out.push([p[(ear - 1 + n) % n], p[ear], p[(ear + 1) % n]]);
    p = p.filter((_, i) => i !== ear);
  }
  if (p.length === 3) {
    if (cross3(p[0], p[1], p[2]) > 1e-12) out.push(p);
  } else if (p.length > 3) {
    // nur bei nicht einfachen Polygonen erreichbar: Rest als Fächer
    for (let k = 1; k < p.length - 1; k++) out.push([p[0], p[k], p[k + 1]]);
  }
  return out;
}

/**
 * Exakte Schnittfläche eines Polygons `a` mit einem konvexen Polygon `b` (mm²): `a` wird an jeder
 * Kante von `b` mit clipHalfPlane beschnitten. Für konvexe `a` exakt; Orientierung beliebig.
 */
export function convexIntersectionArea(a: Pt[], b: Pt[]): number {
  if (a.length < 3 || b.length < 3) return 0;
  const s = Math.sign(signedArea(b));
  if (s === 0) return 0;
  let r = a;
  for (let i = 0; i < b.length && r.length >= 3; i++) {
    const p = b[i];
    const q = b[(i + 1) % b.length];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len < 1e-12) continue;
    // Inneres von b liegt links der Kante p → q (bei positiver Orientierung): behalte n·x ≤ n·p
    const nx = (s * (q.y - p.y)) / len;
    const ny = (-s * (q.x - p.x)) / len;
    r = clipHalfPlane(r, nx, ny, nx * p.x + ny * p.y);
  }
  return r.length >= 3 ? area(r) : 0;
}

function bboxesOverlap(a: Pt[], b: Pt[]): boolean {
  const A = bbox(a);
  const B = bbox(b);
  return A.minX < B.maxX && B.minX < A.maxX && A.minY < B.maxY && B.minY < A.maxY;
}

/**
 * Exakte Schnittfläche zweier einfacher (auch nicht konvexer) Polygone in mm²: Beide werden in Dreiecke
 * zerlegt (triangulate), die Schnittfläche ist die Summe der konvexen Schnittflächen aller Dreieckspaare.
 * 0, wenn sich die Polygone nur berühren.
 */
export function polygonIntersectionArea(a: Pt[], b: Pt[]): number {
  if (a.length < 3 || b.length < 3 || !bboxesOverlap(a, b)) return 0;
  return trianglesIntersectionArea(triangulate(a), triangulate(b));
}

/**
 * Schnittfläche zweier bereits zerlegter Polygone (Dreieckslisten aus triangulate) in mm² – für viele
 * Vergleiche derselben Polygone (z. B. alle Paare einer Freiformzelle) wird jedes Polygon nur einmal zerlegt.
 */
export function trianglesIntersectionArea(ta: Pt[][], tb: Pt[][]): number {
  let s = 0;
  for (const t of ta) for (const u of tb) if (bboxesOverlap(t, u)) s += convexIntersectionArea(t, u);
  return s;
}

/**
 * Kleinster Abstand zweier Polygone in mm (z. B. die Fuge zwischen zwei Freiformteilen):
 *  - 0, wenn sich Kanten kreuzen oder berühren (auch kollinear oder an einer Ecke)
 *    oder ein Polygon vollständig im anderen liegt,
 *  - sonst der kleinste Abstand einer Ecke des einen Polygons zu einer Kante des anderen
 *    (für sich nicht schneidende Kanten ist das exakt der kleinste Randabstand).
 * Polygone mit weniger als drei Ecken werden als offene Linienzüge bzw. Punkte behandelt.
 * Leere Polygone: Infinity.
 */
export function polygonDistance(a: Pt[], b: Pt[]): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  let m = Infinity;
  const na = a.length;
  const nb = b.length;
  for (let i = 0; i < na; i++) {
    const p1 = a[i];
    const p2 = a[(i + 1) % na];
    for (let j = 0; j < nb; j++) {
      const d = segmentDistance(p1, p2, b[j], b[(j + 1) % nb]);
      if (d < m) m = d;
      if (m === 0) return 0;
    }
  }
  if (nb >= 3 && pointInPolygon(a[0], b)) return 0;
  if (na >= 3 && pointInPolygon(b[0], a)) return 0;
  return m;
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

/**
 * Konvexe Hülle (Andrews Monotone-Chain-Verfahren). Doppelte und kollineare
 * Punkte entfallen; bei weniger als drei verschiedenen Punkten werden diese
 * unverändert (ohne Duplikate) zurückgegeben.
 */
export function convexHull(poly: Pt[]): Pt[] {
  const pts = poly.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x || a.y - b.y);
  const u: Pt[] = [];
  for (const p of pts) {
    const l = u[u.length - 1];
    if (!l || Math.abs(l.x - p.x) > 1e-12 || Math.abs(l.y - p.y) > 1e-12) u.push({ x: p.x, y: p.y });
  }
  if (u.length < 3) return u;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of u) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-12) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = u.length - 1; i >= 0; i--) {
    const p = u[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-12) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Kleinste Breite (minimale Kaliberweite, „schmalste Stelle“) in mm: Minimum über alle
 * Kantenrichtungen der konvexen Hülle von (max − min) der Projektion auf die Kantennormale.
 * Für konvexe Polygone ist das exakt die schmalste Stelle (die minimale Breite wird immer
 * an einer Kante angenommen). Für nicht-konvexe Polygone ist es die Breite der Hülle – also
 * eine obere Schranke, die dünne Stellen in Einbuchtungen nicht erkennt.
 * Kanten der Länge 0 werden übersprungen; weniger als drei Punkte ergeben 0.
 */
export function minCaliperWidth(poly: Pt[]): number {
  const p = convexHull(poly);
  const n = p.length;
  if (n < 3) return 0;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-12) continue;
    const nx = -ey / len;
    const ny = ex / len;
    let mn = Infinity;
    let mx = -Infinity;
    for (const q of p) {
      const d = nx * q.x + ny * q.y;
      if (d < mn) mn = d;
      if (d > mx) mx = d;
    }
    if (mx - mn < best) best = mx - mn;
  }
  return Number.isFinite(best) ? best : 0;
}

/** Kleinster Innenwinkel in Grad (0 bei weniger als drei Ecken). */
export function minInteriorAngle(poly: Pt[]): number {
  const p = cleanPoly(poly);
  if (p.length < 3) return 0;
  return Math.min(...interiorAngles(p));
}

/** Abstand eines Punkts zur Strecke a–b. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = dx * dx + dy * dy;
  let t = l > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Abstand eines Punkts zum Rand des Polygons. */
export function distToBoundary(p: Pt, poly: Pt[]): number {
  let m = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) m = Math.min(m, distToSegment(p, poly[i], poly[(i + 1) % n]));
  return m;
}

/** true, wenn p echt im Inneren liegt (nicht auf dem Rand, Toleranz eps in mm). */
export function pointStrictlyInside(p: Pt, poly: Pt[], eps = 1e-6): boolean {
  return pointInPolygon(p, poly) && distToBoundary(p, poly) > eps;
}
