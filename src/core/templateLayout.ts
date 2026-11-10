/**
 * Layout eines Schnittvorlagen-Kastens – rein (ohne jsPDF), damit es getestet werden kann; drawTemplate in pdf.ts
 * zeichnet nur das Ergebnis.
 *
 *  - Zuerst wird der Text gemessen (Warnungen zuerst, dann Rohstein/Maßstab, Außenmaß, Winkel, Schnitte, Farben,
 *    Vorkommen je Blatt). Jede umbrochene Zeile rückt um 2,4 mm vor; keine Zeile wird weggelassen – die Kastenhöhe
 *    folgt dem Inhalt (die Zeilenhöhe einer Kastenreihe ist die größte Kastenhöhe der Reihe).
 *  - Maßstab: der größte aus [10, 8, 6, 5, 4, 3, 2, 1,5, 1], bei dem Zeichnung + Maßbänder + 1:1-Kontur in die
 *    Kastenbreite passen (Zeichnung höchstens 36 mm). Passt selbst 1:1 nicht, wird der Kasten zwei (drei …) Spalten breit.
 *  - Kantenmaße als echte Maßlinien: parallel zur Kante im festen Papierabstand 2,5 mm (nicht mit dem Maßstab
 *    multipliziert) auf der Außenseite (Normale aus dem Umlaufsinn), mit Maßhilfslinien und Schrägstrichen; die Zahl
 *    steht parallel zur Kante (achsparallele Kanten waagerecht), nie kopfüber, auf weißem Grund.
 *  - Kollisionsprüfung gegen Titel, Text, 1:1-Kontur, Steinkontur, Schnittlinien, andere Maßlinien und andere Zahlen:
 *    erst weiter außen (4,5 / 6,5 mm) oder entlang der Kante verschoben, sonst mit Hinweislinie an einer freien Stelle.
 *    Reicht der Platz nicht, wird unter der Zeichnung ein weiteres Band frei gehalten.
 *  - Die gedruckten Werte bleiben exakt: Zahl = f1(ci.edges[i]); Schnittlinien und Winkel aus der CutInfo.
 */
import { bbox, signedArea, type Pt } from './geometry';
import { PT_MM, wrapWords, type Measure } from './pdfTable';
import { cutLineItems, type CutInfo, type CutLineItem } from './pieces';

export const TPL = {
  /** Rasterbreite einer Kastenspalte und Abstand zwischen Kästen (mm) */
  unitW: 60,
  gap: 3,
  pad: 1.5,
  titleSize: 8,
  subSize: 6.5,
  subMin: 4.8,
  /** Titelband (einzeilig) */
  titleH: 6,
  /** Abstand der Maßlinie von der Kante (Papier-mm, fest) */
  dimOffset: 2.5,
  dimOffsets: [2.5, 4.5, 6.5],
  dimSize: 5,
  /** Platz um die Zeichnung für Maßlinien und Zahlen */
  band: 4.8,
  /** zusätzliches Band, wenn Zahlen sonst keinen freien Platz finden */
  extraBand: 3,
  textSize: 5.5,
  lineH: 2.4,
  textGap: 1.2,
  bottomPad: 1.3,
  zooms: [10, 8, 6, 5, 4, 3, 2, 1.5, 1],
  /** größte Zeichnungsseite (mm) */
  maxDraw: 36,
  contourGap: 3,
  /** Kanten kürzer als dies (Papier-mm) bekommen ihre Zahl mit Hinweislinie */
  shortEdge: 4,
  /** höchstens so viele Zeilen „Vorkommen je Blatt“ (Rest ehrlich als „+ n weitere Blätter“) */
  occLines: 4,
  /** Sicherheitsabstand für die Kollisionsprüfung */
  clearance: 0.25,
} as const;

export interface TplRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TemplateTexts {
  /** „Vorlage T12“ */
  title: string;
  /** „Dreieck · 7×“ */
  subtitle: string;
  /** Warnungen (rot, zuerst) */
  warnings: string[];
  /** Kopfzeilen abhängig vom Zeichnungsmaßstab (Rohstein + Maßstab, Außenmaß, Winkel) */
  head: (zoom: number) => string[];
  /** Schnittlinien */
  cuts: string[];
  /** weitere Zeilen (z. B. Farben) – nie gekürzt */
  tail: string[];
  /** Vorkommen je Blatt in höchstens maxLines Zeilen (ehrlich zusammengefasst) */
  occ?: (maxLines: number, wrap: (s: string) => string[]) => string[];
  /** Zahl der Kante i (f1(ci.edges[i])) */
  edgeLabel: (i: number) => string;
}

export interface DimLabel {
  edge: number;
  text: string;
  /** Mitte der Zahl, Drehwinkel (Grad, gegen den Uhrzeigersinn wie jsPDF), Textbreite */
  cx: number;
  cy: number;
  angle: number;
  tw: number;
  /** Grundlinienanfang für doc.text(…, { angle }) */
  tx: number;
  ty: number;
  /** weißer Hintergrund (gedrehtes Rechteck) – auch die Kollisionsform */
  poly: Pt[];
  /** Maßlinie, Maßhilfslinien, Schrägstriche */
  line: [Pt, Pt];
  ext: [Pt, Pt][];
  ticks: [Pt, Pt][];
  /** Hinweislinie (Zahl abseits der Maßlinie) */
  leader: [Pt, Pt] | null;
}

export interface TemplateLayout {
  /** Kastenbreite und benötigte Höhe (mm, ohne Abstand zum nächsten Kasten) */
  w: number;
  h: number;
  /** Kastenspalten */
  span: number;
  zoom: number;
  title: { text: string; size: number; x: number; y: number };
  subtitle: { text: string; size: number; x: number; y: number; align: 'left' | 'right' };
  titleRect: TplRect;
  /** linke obere Rohsteinecke der Zeichnung und Rohstein-Rechteck */
  origin: Pt;
  rawRect: TplRect;
  /** Steinkontur und Schnittlinien in Kastenkoordinaten */
  piece: Pt[];
  cuts: (CutLineItem & { pa: Pt; pb: Pt })[];
  /** 1:1-Kontur (nur bei Maßstab > 1) */
  contour: { poly: Pt[]; rect: TplRect; label: { x: number; y: number } } | null;
  labels: DimLabel[];
  text: { lines: { s: string; warn: boolean; y: number }[]; size: number; rect: TplRect };
}

// ---------------------------------------------------------------- Geometrie-Helfer

const add = (a: Pt, b: Pt, k = 1): Pt => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const rectPoly = (r: TplRect): Pt[] => [
  { x: r.x, y: r.y },
  { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h },
  { x: r.x, y: r.y + r.h },
];

/** Drehung um φ Grad gegen den Uhrzeigersinn (y nach unten) */
function rot(u: number, v: number, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: u * c + v * s, y: -u * s + v * c };
}

function orientedRect(c: Pt, w: number, h: number, deg: number): Pt[] {
  return [rot(-w / 2, -h / 2, deg), rot(w / 2, -h / 2, deg), rot(w / 2, h / 2, deg), rot(-w / 2, h / 2, deg)].map((p) => add(c, p));
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function segmentsIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (a: Pt, b: Pt, p: Pt, d: number) => Math.abs(d) < 1e-12 && Math.min(a.x, b.x) - 1e-9 <= p.x && p.x <= Math.max(a.x, b.x) + 1e-9 && Math.min(a.y, b.y) - 1e-9 <= p.y && p.y <= Math.max(a.y, b.y) + 1e-9;
  return on(p3, p4, p1, d1) || on(p3, p4, p2, d2) || on(p1, p2, p3, d3) || on(p1, p2, p4, d4);
}

/** Punkt im (beliebigen) Polygon */
function inside(p: Pt, poly: Pt[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** Schneiden sich zwei Polygone (Flächen) – Kanten kreuzen sich oder eines liegt im anderen */
export function polysIntersect(a: Pt[], b: Pt[]): boolean {
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++) if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true;
  return (a.length > 2 && inside(b[0], a)) || (b.length > 2 && inside(a[0], b));
}

/** Berührt die Strecke die Polygonfläche */
export function segmentHitsPoly(p: Pt, q: Pt, poly: Pt[]): boolean {
  if (inside(p, poly) || inside(q, poly)) return true;
  for (let i = 0; i < poly.length; i++) if (segmentsIntersect(p, q, poly[i], poly[(i + 1) % poly.length])) return true;
  return false;
}

function grow(poly: Pt[], d: number): Pt[] {
  // gedrehtes Rechteck um d nach außen vergrößern (Ecken 0–3 wie orientedRect)
  const c = { x: (poly[0].x + poly[2].x) / 2, y: (poly[0].y + poly[2].y) / 2 };
  return poly.map((p) => {
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / l) * d * Math.SQRT2, y: p.y + (dy / l) * d * Math.SQRT2 };
  });
}

/** Lesewinkel einer Kante: achsparallel waagerecht, sonst parallel, nie kopfüber (−90°, 90°] */
function labelAngle(dx: number, dy: number): number {
  if (Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6) return 0;
  let a = (Math.atan2(-dy, dx) * 180) / Math.PI;
  if (a > 90) a -= 180;
  if (a <= -90) a += 180;
  return a;
}

// ---------------------------------------------------------------- Layout

interface Attempt {
  labels: DimLabel[];
}

function placeLabels(
  ci: CutInfo,
  texts: TemplateTexts,
  measure: Measure,
  o: { ox: number; oy: number; zoom: number; w: number; regionTop: number; regionBottom: number; obstacles: Pt[][]; segs: [Pt, Pt][]; piece: Pt[] },
): Attempt | null {
  const P = (p: Pt): Pt => ({ x: o.ox + p.x * o.zoom, y: o.oy + p.y * o.zoom });
  const poly = ci.polyInRaw;
  const n = poly.length;
  const sA = signedArea(poly);
  const size = TPL.dimSize;
  const capH = size * PT_MM * 0.72;
  const bh = capH + 0.8;
  const placedPolys: Pt[][] = [];
  const lineSegs: [Pt, Pt][] = [];
  const minX = TPL.pad;
  const maxX = o.w - TPL.pad;
  // Maßlinien aller Kanten im Grundabstand (Hindernisse für fremde Zahlen)
  const edges = Array.from({ length: n }, (_, i) => {
    const a = P(poly[i]);
    const b = P(poly[(i + 1) % n]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    const u = { x: dx / L, y: dy / L };
    const nrm = sA >= 0 ? { x: u.y, y: -u.x } : { x: -u.y, y: u.x };
    return { a, b, L, u, n: nrm };
  });
  const dimLine = (i: number, off: number): [Pt, Pt] => [add(edges[i].a, edges[i].n, off), add(edges[i].b, edges[i].n, off)];
  const inRegion = (p: Pt) => p.x >= minX - 1e-9 && p.x <= maxX + 1e-9 && p.y >= o.regionTop - 1e-9 && p.y <= o.regionBottom + 1e-9;
  /** Zahl (weißer Grund) frei von Titel, Kontur, Stein, Schnitten, Maßlinien und anderen Zahlen; eigene Linien frei von anderen Zahlen */
  const ok = (lab: DimLabel): boolean => {
    for (const p of lab.poly) if (!inRegion(p)) return false;
    const g = grow(lab.poly, TPL.clearance);
    for (const ob of o.obstacles) if (polysIntersect(g, ob)) return false;
    for (const pp of placedPolys) if (polysIntersect(g, pp)) return false;
    if (polysIntersect(g, o.piece)) return false;
    for (const [p, q] of o.segs) if (segmentHitsPoly(p, q, g)) return false;
    for (const [p, q] of lineSegs) if (segmentHitsPoly(p, q, g)) return false;
    const own: [Pt, Pt][] = [lab.line, ...lab.ext];
    if (lab.leader) own.push(lab.leader);
    for (const [p, q] of own) {
      if (!inRegion(p) || !inRegion(q)) return false;
      for (const pp of placedPolys) if (segmentHitsPoly(p, q, pp)) return false;
      for (const ob of o.obstacles) if (segmentHitsPoly(p, q, ob)) return false;
    }
    if (lab.leader && segmentHitsPoly(lab.leader[0], lab.leader[1], o.piece)) return false;
    return true;
  };
  /** Maßlinie im Abstand off schneidet den Stein nicht (nicht konvexe Teile) */
  const lineClear = (i: number, off: number) => {
    const [p, q] = dimLine(i, off);
    return !segmentHitsPoly(add(p, edges[i].u, 0.05), add(q, edges[i].u, -0.05), o.piece);
  };
  const tick = (p: Pt, e: (typeof edges)[number]): [Pt, Pt] => {
    const d = { x: (e.u.x + e.n.x) / Math.SQRT2, y: (e.u.y + e.n.y) / Math.SQRT2 };
    return [add(p, d, -0.55), add(p, d, 0.55)];
  };
  const make = (i: number, text: string, tw: number, c: Pt, angle: number, off: number, leader: boolean): DimLabel => {
    const e = edges[i];
    const line = dimLine(i, off);
    const bw = tw + 0.8;
    const lp = orientedRect(c, bw, bh, angle);
    const start = add(c, rot(-tw / 2, capH / 2, angle));
    let lead: [Pt, Pt] | null = null;
    if (leader) {
      const m = { x: (line[0].x + line[1].x) / 2, y: (line[0].y + line[1].y) / 2 };
      // Hinweislinie bis zur nächsten Kante des Zahlenkastens
      let best = lp[0];
      let bd = Infinity;
      for (let k = 0; k < 4; k++) {
        const p = lp[k];
        const q = lp[(k + 1) % 4];
        const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
        const d = Math.hypot(mid.x - m.x, mid.y - m.y);
        if (d < bd) {
          bd = d;
          best = mid;
        }
      }
      lead = [m, best];
    }
    return {
      edge: i,
      text,
      cx: c.x,
      cy: c.y,
      angle,
      tw,
      tx: start.x,
      ty: start.y,
      poly: lp,
      line,
      ext: [
        [add(e.a, e.n, 0.6), add(e.a, e.n, off + 0.8)],
        [add(e.b, e.n, 0.6), add(e.b, e.n, off + 0.8)],
      ],
      ticks: [tick(line[0], e), tick(line[1], e)],
      leader: lead,
    };
  };
  // längere Kanten zuerst (sie haben die meisten Möglichkeiten), Ausgabe in Kantenreihenfolge
  const order = edges.map((_, i) => i).sort((p, q) => edges[q].L - edges[p].L);
  const result: DimLabel[] = new Array(n);
  for (const i of order) {
    const e = edges[i];
    const text = texts.edgeLabel(i);
    const tw = measure(text, false) * size;
    const angle = labelAngle(e.b.x - e.a.x, e.b.y - e.a.y);
    // Ausdehnung der Zahl entlang der Kante
    const ang = (angle * Math.PI) / 180;
    const ax = { x: Math.cos(ang), y: -Math.sin(ang) };
    const along = Math.abs(ax.x * e.u.x + ax.y * e.u.y) * (tw + 0.8) + Math.abs(-ax.y * e.u.x + ax.x * e.u.y) * bh;
    const mid = { x: (e.a.x + e.b.x) / 2, y: (e.a.y + e.b.y) / 2 };
    let lab: DimLabel | null = null;
    if (e.L >= TPL.shortEdge && along <= e.L - 0.6) {
      outer: for (const off of TPL.dimOffsets)
        for (const f of [0, -0.25, 0.25, -0.4, 0.4]) {
          const shift = f * e.L;
          if (Math.abs(shift) + along / 2 > e.L / 2 - 0.3) continue;
          const c = add(add(mid, e.n, off), e.u, shift);
          if (!lineClear(i, off)) continue;
          const cand = make(i, text, tw, c, angle, off, false);
          if (ok(cand)) {
            lab = cand;
            break outer;
          }
        }
    }
    if (!lab) {
      // Hinweislinie: waagerechte Zahl an der nächstgelegenen freien Stelle im Zeichnungsbereich
      const off = TPL.dimOffsets.find((v) => lineClear(i, v)) ?? TPL.dimOffset;
      const anchor = add(mid, e.n, off);
      const bw = tw + 0.8;
      const cands: { c: Pt; d: number }[] = [];
      for (let y = o.regionTop + bh / 2; y <= o.regionBottom - bh / 2 + 1e-9; y += 0.75)
        for (let x = minX + bw / 2; x <= maxX - bw / 2 + 1e-9; x += 1) cands.push({ c: { x, y }, d: Math.hypot(x - anchor.x, y - anchor.y) });
      cands.sort((p, q) => p.d - q.d);
      for (const k of cands) {
        const cand = make(i, text, tw, k.c, 0, off, true);
        if (ok(cand)) {
          lab = cand;
          break;
        }
      }
    }
    if (!lab) return null;
    result[i] = lab;
    placedPolys.push(lab.poly);
    lineSegs.push(lab.line, ...lab.ext);
    if (lab.leader) lineSegs.push(lab.leader);
  }
  return { labels: result };
}

/**
 * Layout eines Vorlagenkastens. `measure` = Textbreite in mm bei 1 pt. Liefert Maßstab, Lage aller Teile in
 * Kastenkoordinaten (Ursprung oben links) und die benötigte Höhe.
 */
export function layoutTemplate(ci: CutInfo, texts: TemplateTexts, measure: Measure, o: { maxSpan?: number } = {}): TemplateLayout {
  const items = cutLineItems(ci);
  const raw = { w: ci.rawW, h: ci.rawH };
  const bb = ci.polyInRaw.length ? bbox(ci.polyInRaw) : { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  const maxSpan = Math.max(1, o.maxSpan ?? 3);
  const attempt = (span: number, zoom: number, force: boolean): TemplateLayout | null => {
    const w = span * TPL.unitW - TPL.gap;
    const inner = w - 2 * TPL.pad;
    // ---- Titel: Nummer links; Form und Anzahl rechts (verkleinert) oder in einer zweiten Zeile – nie übereinander
    const titleW = measure(texts.title, true) * TPL.titleSize;
    const subW = (size: number) => measure(texts.subtitle, false) * size;
    let subSize: number = TPL.subSize;
    const roomRight = inner - titleW - 3;
    while (subSize > TPL.subMin && subW(subSize) > roomRight) subSize = Math.max(TPL.subMin, subSize - 0.25);
    let titleH: number = TPL.titleH;
    let subtitle: TemplateLayout['subtitle'];
    if (subW(subSize) <= roomRight + 1e-9) subtitle = { text: texts.subtitle, size: subSize, x: w - TPL.pad, y: 4, align: 'right' };
    else {
      subSize = TPL.subSize;
      while (subSize > TPL.subMin && subW(subSize) > inner) subSize = Math.max(TPL.subMin, subSize - 0.25);
      subtitle = { text: texts.subtitle, size: subSize, x: TPL.pad, y: 7.3, align: 'left' };
      titleH = 9;
    }
    const titleRect: TplRect = { x: 0, y: 0, w, h: titleH };
    const wrap = (s: string) => wrapWords(s, inner, TPL.textSize, false, measure);
    const contourW = zoom > 1 ? bb.w + TPL.contourGap : 0;
    const drawW = raw.w * zoom;
    const drawH = raw.h * zoom;
    if (!force && drawW + 2 * TPL.band + contourW > inner + 1e-9) return null;
    // ---- Text (gemessen; Warnungen zuerst; nichts wird weggelassen)
    const lines: { s: string; warn: boolean }[] = [];
    for (const l of texts.warnings) for (const wl of wrap(l)) lines.push({ s: wl, warn: true });
    for (const l of [...texts.head(zoom), ...texts.cuts, ...texts.tail]) for (const wl of wrap(l)) lines.push({ s: wl, warn: false });
    if (texts.occ) for (const wl of texts.occ(TPL.occLines, wrap)) lines.push({ s: wl, warn: false });
    // ---- Zeichnung links (mittig im Platz neben der Kontur), 1:1-Kontur rechts oben
    const leftW = inner - contourW;
    const ox = TPL.pad + Math.max(TPL.band, (leftW - drawW) / 2);
    const oy = titleH + TPL.band;
    let contour: TemplateLayout['contour'] = null;
    if (zoom > 1) {
      const cx = w - TPL.pad - bb.maxX;
      const rect = { x: cx + bb.minX, y: oy + bb.minY, w: bb.w, h: bb.h };
      contour = { poly: ci.polyInRaw.map((p) => ({ x: cx + p.x, y: oy + p.y })), rect, label: { x: rect.x + rect.w / 2, y: rect.y + rect.h + 2.2 } };
    }
    const P = (p: Pt): Pt => ({ x: ox + p.x * zoom, y: oy + p.y * zoom });
    const piece = ci.polyInRaw.map(P);
    const cuts = items.map((it) => ({ ...it, pa: P(it.a), pb: P(it.b) }));
    const drawBottom = Math.max(oy + drawH + TPL.band, contour ? contour.label.y + 1 : 0);
    const obstacles: Pt[][] = [rectPoly(titleRect)];
    if (contour) obstacles.push(rectPoly({ x: contour.rect.x - 0.6, y: contour.rect.y - 0.6, w: contour.rect.w + 1.2, h: contour.label.y + 0.8 - contour.rect.y + 0.6 }));
    const segs: [Pt, Pt][] = cuts.map((c) => [c.pa, c.pb]);
    const maxExtra = Math.max(3, ci.polyInRaw.length) * TPL.extraBand * (force ? 4 : 1);
    for (let extra = 0; extra <= maxExtra + 1e-9; extra += TPL.extraBand) {
      const regionBottom = drawBottom + extra;
      const att = ci.polyInRaw.length ? placeLabels(ci, texts, measure, { ox, oy, zoom, w, regionTop: titleH, regionBottom, obstacles, segs, piece }) : { labels: [] };
      if (!att) continue;
      const textTop = regionBottom + TPL.textGap;
      return {
        w,
        h: textTop + lines.length * TPL.lineH + TPL.bottomPad,
        span,
        zoom,
        title: { text: texts.title, size: TPL.titleSize, x: TPL.pad, y: 4 },
        subtitle,
        titleRect,
        origin: { x: ox, y: oy },
        rawRect: { x: ox, y: oy, w: drawW, h: drawH },
        piece,
        cuts,
        contour,
        labels: att.labels,
        text: {
          lines: lines.map((l, i) => ({ ...l, y: textTop + TPL.textSize * PT_MM * 0.8 + i * TPL.lineH })),
          size: TPL.textSize,
          rect: { x: TPL.pad, y: textTop, w: inner, h: lines.length * TPL.lineH },
        },
      };
    }
    return null;
  };
  for (let span = 1; span <= maxSpan; span++)
    for (const zoom of TPL.zooms) {
      if (zoom > 1 && Math.max(raw.w, raw.h) * zoom > TPL.maxDraw + 1e-9) continue;
      const r = attempt(span, zoom, false);
      if (r) return r;
    }
  // Rohstein breiter als die breiteste Kastenreihe (praktisch nie): 1:1 in voller Breite, Zahlen wie üblich gesetzt
  const forced = attempt(maxSpan, 1, true);
  if (forced) return forced;
  throw new Error(`Schnittvorlage nicht darstellbar (${ci.signature})`);
}
