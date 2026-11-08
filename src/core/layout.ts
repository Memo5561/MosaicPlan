/**
 * Rasterberechnung mit Fugen.
 *
 * Projektursprung: obere linke Außenkante des ersten Steins (A001).
 * X wächst nach rechts, Y nach unten. Alle Maße in Millimetern.
 *
 * Für n Steine der Breite w mit Fugenbreite g gilt:
 *   belegte Breite = n·w + (n−1)·g
 * Fugen liegen nur ZWISCHEN den Steinen. Eine Randfuge/ein Rahmen ist nicht
 * Teil des Mosaikfelds.
 */

export type EdgeMode = 'whole' | 'cut-end' | 'cut-both';

export interface LayoutParams {
  widthMm: number;
  heightMm: number;
  tileW: number;
  tileH: number;
  joint: number;
  edgeMode: EdgeMode;
  /** Kleinste noch sinnvoll schneidbare Randsteinbreite. */
  minCutMm: number;
}

export interface AxisLayout {
  pos: Float64Array;
  size: Float64Array;
  /** tatsächlich belegte Länge (Außenkante bis Außenkante) */
  used: number;
  /** angefragte Länge − belegte Länge (≥ 0) */
  rest: number;
  /** Anzahl zugeschnittener Rand-Spalten bzw. -Zeilen */
  cutCount: number;
}

export interface Layout {
  cols: number;
  rows: number;
  colX: Float64Array;
  colW: Float64Array;
  rowY: Float64Array;
  rowH: Float64Array;
  finishedW: number;
  finishedH: number;
  requestedW: number;
  requestedH: number;
  restX: number;
  restY: number;
  tileW: number;
  tileH: number;
  joint: number;
  edgeMode: EdgeMode;
}

export const MAX_CELLS = 40_000_000;

export type LayoutErrorCode = 'invalidDims' | 'smallerThanTile' | 'tooManyCells';

/**
 * Fehler der Rasterberechnung mit maschinenlesbarem Code und Zahlenwerten, damit die Oberfläche ihn in der
 * gewählten Sprache anzeigen kann. `message` bleibt der bisherige deutsche Text (Rückfall, z. B. aus dem Worker).
 *
 * Parameter je Code:
 * - invalidDims: {} – Länge, Steinmaß oder Fuge ungültig (nicht endlich, ≤ 0 bzw. Fuge < 0)
 * - smallerThanTile: {axis: 'x'|'y', length, tile, minCut, mode} – Länge kleiner als ein Stein (Modus „nur
 *   ganze Steine“) bzw. kleiner als die kleinste Randsteinbreite (Modi mit Zuschnitt)
 * - tooManyCells: {cells, max, cols, rows}
 */
export class LayoutError extends Error {
  readonly code: LayoutErrorCode;
  readonly params: Record<string, number | string>;
  constructor(code: LayoutErrorCode, params: Record<string, number | string>, message: string) {
    super(message);
    this.name = 'LayoutError';
    this.code = code;
    this.params = params;
  }
}

export function isLayoutError(e: unknown): e is LayoutError {
  return e instanceof LayoutError;
}

/**
 * Aufteilung einer Achse ohne Arrays: führende Randsteine, `full` ganze Steine, nachfolgende Randsteine.
 * Dieselben Fälle wie zuvor in computeAxis. Erlaubt die Prüfung der Rastergröße VOR dem Anlegen der Arrays –
 * sonst liefe z. B. eine Breite von 10⁹ mm in eine riesige Schleife, bevor die Grenze greift.
 */
interface AxisPlan {
  lead: number[];
  full: number;
  trail: number[];
}

function axisPlan(L: number, w: number, g: number, mode: EdgeMode, minCut: number, axis: 'x' | 'y'): AxisPlan {
  if (!Number.isFinite(L) || !(L > 0) || !Number.isFinite(w) || !(w > 0) || !Number.isFinite(g) || !(g >= 0)) {
    throw new LayoutError('invalidDims', {}, 'Ungültige Maße.');
  }
  const pitch = w + g;
  const n = Math.floor((L + g) / pitch + 1e-9);
  if (n < 1) {
    // Projekt kleiner als ein Stein
    if (mode !== 'whole' && L >= minCut) return { lead: [L], full: 0, trail: [] };
    throw new LayoutError('smallerThanTile', { axis, length: L, tile: w, minCut, mode }, 'Die Projektgröße ist kleiner als ein einzelner Stein.');
  }
  const r = L - (n * w + (n - 1) * g);
  if (mode === 'whole' || r <= 1e-6) return { lead: [], full: n, trail: [] };
  if (mode === 'cut-end') {
    const c = r - g;
    if (c >= minCut - 1e-9) return { lead: [], full: n, trail: [c] };
    // Restbreite zu schmal: letzten ganzen Stein + Rest auf zwei gleich breite Randsteine verteilen
    const c2 = (w + c) / 2;
    if (c2 >= minCut - 1e-9) return { lead: [], full: n - 1, trail: [c2, c2] };
    return { lead: [], full: n, trail: [] };
  }
  // cut-both: symmetrisch zentriert, gleich breite Randsteine links/rechts
  let full = n - 1;
  let c = (L - full * w - (full + 1) * g) / 2;
  while (c < minCut - 1e-9 && full > 0) {
    full -= 1;
    c = (L - full * w - (full + 1) * g) / 2;
  }
  if (c >= minCut - 1e-9 && c <= w + 1e-9) return { lead: [c], full, trail: [c] };
  return { lead: [], full: n, trail: [] };
}

const planCount = (p: AxisPlan) => p.lead.length + p.full + p.trail.length;

function materialize(p: AxisPlan, w: number, g: number, L: number): AxisLayout {
  const n = planCount(p);
  const pos = new Float64Array(n);
  const size = new Float64Array(n);
  let x = 0;
  let cutCount = 0;
  let i = 0;
  // dieselbe Reihenfolge der Additionen wie zuvor → bitgleiche Positionen
  const put = (v: number) => {
    pos[i] = x;
    size[i] = v;
    if (Math.abs(v - w) > 1e-9) cutCount++;
    x += v + g;
    i++;
  };
  for (const v of p.lead) put(v);
  for (let k = 0; k < p.full; k++) put(w);
  for (const v of p.trail) put(v);
  const used = pos[n - 1] + size[n - 1];
  return { pos, size, used, rest: Math.max(0, L - used), cutCount };
}

function tooManyCells(cols: number, rows: number): LayoutError {
  const cells = cols * rows;
  return new LayoutError(
    'tooManyCells',
    { cells, max: MAX_CELLS, cols, rows },
    `Das Projekt hätte ${cells.toLocaleString('de-DE')} Rasterpositionen; unterstützt werden höchstens ${MAX_CELLS.toLocaleString('de-DE')}.`,
  );
}

export function computeAxis(L: number, w: number, g: number, mode: EdgeMode, minCut: number, axis: 'x' | 'y' = 'x'): AxisLayout {
  const p = axisPlan(L, w, g, mode, minCut, axis);
  const count = planCount(p);
  // eine Achse allein kann die Grenze schon sprengen (die andere hat mindestens eine Position)
  if (count > MAX_CELLS) throw axis === 'x' ? tooManyCells(count, 1) : tooManyCells(1, count);
  return materialize(p, w, g, L);
}

/**
 * Exakte Spalten- und Zeilenzahl ohne Arrays (dieselben Fälle wie computeLayout). Wirft dieselben
 * LayoutErrors für ungültige Maße und zu kleine Projekte, aber NICHT bei zu vielen Rasterpositionen.
 */
export function layoutCounts(p: LayoutParams): { cols: number; rows: number } {
  return {
    cols: planCount(axisPlan(p.widthMm, p.tileW, p.joint, p.edgeMode, p.minCutMm, 'x')),
    rows: planCount(axisPlan(p.heightMm, p.tileH, p.joint, p.edgeMode, p.minCutMm, 'y')),
  };
}

export function computeLayout(p: LayoutParams): Layout {
  const px = axisPlan(p.widthMm, p.tileW, p.joint, p.edgeMode, p.minCutMm, 'x');
  const py = axisPlan(p.heightMm, p.tileH, p.joint, p.edgeMode, p.minCutMm, 'y');
  // Grenze prüfen, BEVOR Arrays angelegt werden
  if (planCount(px) * planCount(py) > MAX_CELLS) throw tooManyCells(planCount(px), planCount(py));
  const ax = materialize(px, p.tileW, p.joint, p.widthMm);
  const ay = materialize(py, p.tileH, p.joint, p.heightMm);
  return {
    cols: ax.pos.length,
    rows: ay.pos.length,
    colX: ax.pos,
    colW: ax.size,
    rowY: ay.pos,
    rowH: ay.size,
    finishedW: ax.used,
    finishedH: ay.used,
    requestedW: p.widthMm,
    requestedH: p.heightMm,
    restX: ax.rest,
    restY: ay.rest,
    tileW: p.tileW,
    tileH: p.tileH,
    joint: p.joint,
    edgeMode: p.edgeMode,
  };
}

/** Schätzt die Rasterpositionen ohne Arrays anzulegen (für Warnungen in der UI). */
export function estimateCells(p: LayoutParams): { cols: number; rows: number } {
  const n = (L: number, w: number) => Math.max(1, Math.floor((L + p.joint) / (w + p.joint) + 1e-9) + (p.edgeMode === 'whole' ? 0 : 1));
  return { cols: n(p.widthMm, p.tileW), rows: n(p.heightMm, p.tileH) };
}

/** Fugenanteil an der fertigen Fläche (0…1): 1 − Steinfläche (Summe der Stein-Außenmaße) ÷ fertige Fläche. */
export function jointShareOf(layout: Pick<Layout, 'colW' | 'rowH' | 'finishedW' | 'finishedH'>): number {
  let sw = 0;
  let sh = 0;
  for (let i = 0; i < layout.colW.length; i++) sw += layout.colW[i];
  for (let i = 0; i < layout.rowH.length; i++) sh += layout.rowH[i];
  const total = layout.finishedW * layout.finishedH;
  return total > 0 ? (total - sw * sh) / total : 0;
}

/** Erster Index, dessen Zellmitte ≥ v (strict = false) bzw. > v (strict = true); Mitten steigen monoton. */
function firstCentre(pos: Float64Array, size: Float64Array, v: number, strict: boolean): number {
  let lo = 0;
  let hi = pos.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const c = pos[mid] + size[mid] / 2;
    if (strict ? c <= v : c < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Anzahl der Spalten/Zeilen, deren Mitte im geschlossenen Intervall [a, b] (mm) liegt. */
function centresIn(pos: Float64Array, size: Float64Array, a: number, b: number): number {
  if (!(b >= a)) return 0;
  return Math.max(0, firstCentre(pos, size, b, true) - firstCentre(pos, size, a, false));
}

/** Mitte der Spalte/Zeile, deren Mitte v am nächsten liegt. */
function nearestCentre(pos: Float64Array, size: Float64Array, v: number): number {
  const i = firstCentre(pos, size, v, false);
  let best = Math.min(i, pos.length - 1);
  if (i > 0 && (i >= pos.length || Math.abs(pos[i - 1] + size[i - 1] / 2 - v) <= Math.abs(pos[i] + size[i] / 2 - v))) best = i - 1;
  return pos[best] + size[best] / 2;
}

export interface RegionSpan {
  /** Rasterspalten, deren Mitte im Bereich liegt (Ellipse: entlang der Rasterzeile durch die Ellipsenmitte) */
  cols: number;
  /** Rasterzeilen, deren Mitte im Bereich liegt (Ellipse: entlang der Rasterspalte durch die Ellipsenmitte) */
  rows: number;
  /** Breite/Höhe des Bereichs auf dem fertigen Mosaik in mm (auf die Mosaikfläche begrenzt) */
  mmW: number;
  mmH: number;
}

/**
 * Wie viele Rasterpositionen ein (Gesichts-)Bereich überspannt – exakt aus colX/colW bzw. rowY/rowH.
 * Bereiche sind auf das zugeschnittene Bild normiert, das genau auf finishedW × finishedH abgebildet wird
 * (wie in computeMosaic). Gezählt werden Zellen, deren Mitte im Bereich liegt – dieselbe Regel, nach der die
 * Berechnung eine Zelle einem Bereich zuordnet. Bei Ellipsen entlang der Rasterzeile bzw. -spalte, deren Mitte
 * der Ellipsenmitte am nächsten liegt. Ohne k×k-Unterteilung (Teilsteine zählen nicht extra).
 */
export function regionCellSpan(
  layout: Pick<Layout, 'colX' | 'colW' | 'rowY' | 'rowH' | 'finishedW' | 'finishedH'>,
  r: { shape: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number },
): RegionSpan {
  const fW = layout.finishedW;
  const fH = layout.finishedH;
  const cl = (v: number) => Math.min(1, Math.max(0, v));
  const mmW = Math.max(0, cl(r.x + r.w) - cl(r.x)) * fW;
  const mmH = Math.max(0, cl(r.y + r.h) - cl(r.y)) * fH;
  if (!(r.w > 0) || !(r.h > 0) || layout.colX.length === 0 || layout.rowY.length === 0) return { cols: 0, rows: 0, mmW, mmH };
  if (r.shape === 'rect') {
    return {
      cols: centresIn(layout.colX, layout.colW, cl(r.x) * fW, cl(r.x + r.w) * fW),
      rows: centresIn(layout.rowY, layout.rowH, cl(r.y) * fH, cl(r.y + r.h) * fH),
      mmW,
      mmH,
    };
  }
  // Ellipse – wie in regionMask nicht beschnitten; Zellmitten liegen ohnehin innerhalb der Fläche
  const ecx = (r.x + r.w / 2) * fW;
  const ecy = (r.y + r.h / 2) * fH;
  const rx = (r.w * fW) / 2;
  const ry = (r.h * fH) / 2;
  /** halbe Sehnenlänge der Ellipse (Halbachsen a entlang, b quer) im Abstand d von der Mitte; −1 außerhalb */
  const halfChord = (d: number, a: number, b: number) => {
    const q = 1 - (d / b) * (d / b);
    return q < 0 ? -1 : a * Math.sqrt(q);
  };
  const hw = halfChord(nearestCentre(layout.rowY, layout.rowH, ecy) - ecy, rx, ry);
  const hh = halfChord(nearestCentre(layout.colX, layout.colW, ecx) - ecx, ry, rx);
  return {
    cols: hw < 0 ? 0 : centresIn(layout.colX, layout.colW, ecx - hw, ecx + hw),
    rows: hh < 0 ? 0 : centresIn(layout.rowY, layout.rowH, ecy - hh, ecy + hh),
    mmW,
    mmH,
  };
}

/** Zeilenbezeichnung im Tabellenstil: 0→A, 25→Z, 26→AA, … */
export function rowLabel(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function rowIndexFromLabel(label: string): number {
  let n = 0;
  for (const ch of label.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function colDigits(cols: number): number {
  return Math.max(3, String(cols).length);
}

/** Eindeutige Positionsbezeichnung einer Rasterzelle, z. B. „A001“. */
export function cellId(layout: { cols: number }, row: number, col: number): string {
  return rowLabel(row) + String(col + 1).padStart(colDigits(layout.cols), '0');
}

/** Bezeichnung eines Steins: Zelle + ggf. Teilstück (A001, A001-2). */
export function pieceId(layout: { cols: number }, row: number, col: number, piece: number, pieceCount: number): string {
  const base = cellId(layout, row, col);
  return pieceCount > 1 ? `${base}-${piece + 1}` : base;
}

export function parseCellId(layout: { cols: number; rows: number }, id: string): { row: number; col: number; piece: number } | null {
  // Teilstücke zählen ab 1: „A001-0“ oder „A001-00“ sind keine gültigen Bezeichnungen
  const m = /^([A-Za-z]+)(\d+)(?:-([1-9]\d*))?$/.exec(id.trim());
  if (!m) return null;
  const row = rowIndexFromLabel(m[1]);
  const col = parseInt(m[2], 10) - 1;
  if (row < 0 || row >= layout.rows || col < 0 || col >= layout.cols) return null;
  return { row, col, piece: m[3] ? parseInt(m[3], 10) - 1 : 0 };
}

/** Binärsuche: Index der Spalte/Zeile, die die Koordinate enthält (inkl. halber Fuge). */
export function indexAt(pos: Float64Array, size: Float64Array, v: number, joint: number): number {
  let lo = 0;
  let hi = pos.length - 1;
  if (v < pos[0] - joint / 2 || v > pos[hi] + size[hi] + joint / 2) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pos[mid] - joint / 2 <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Section {
  id: string;
  sr: number;
  sc: number;
  c0: number;
  c1: number;
  r0: number;
  r1: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SectionGrid {
  srows: number;
  scols: number;
  sections: Section[];
  colStarts: number[];
  rowStarts: number[];
}

function splitAxis(pos: Float64Array, size: Float64Array, maxLen: number): number[] {
  const n = pos.length;
  const span = (a: number, b: number) => pos[b - 1] + size[b - 1] - pos[a];
  // Mindestanzahl Abschnitte (gierig), danach gleichmäßig verteilen, damit kein schmaler Reststreifen entsteht
  let greedy = 1;
  for (let i = 1, s = 0; i < n; i++) {
    if (pos[i] + size[i] - pos[s] > maxLen + 1e-9) {
      greedy++;
      s = i;
    }
  }
  for (let k = greedy; k <= n; k++) {
    const starts: number[] = [];
    for (let i = 0; i < k; i++) {
      const v = Math.round((i * n) / k);
      if (!starts.includes(v)) starts.push(v);
    }
    const ok = starts.every((a, i) => span(a, i + 1 < starts.length ? starts[i + 1] : n) <= maxLen + 1e-9);
    if (ok) return starts;
  }
  return Array.from({ length: n }, (_, i) => i);
}

export function sectionLabel(sr: number, sc: number): string {
  return `${rowLabel(sr)}${sc + 1}`;
}

/**
 * Teilt das Raster in Abschnitte von höchstens sectionW × sectionH mm.
 * Abschnittsgrenzen liegen immer auf Rasterlinien (in der Fuge), daher passen
 * benachbarte Abschnitte exakt mit einer Fugenbreite Abstand aneinander.
 */
export function computeSections(layout: Layout, sectionW: number, sectionH: number): SectionGrid {
  return buildSections(layout, splitAxis(layout.colX, layout.colW, Math.max(sectionW, 1)), splitAxis(layout.rowY, layout.rowH, Math.max(sectionH, 1)));
}

function buildSections(layout: Layout, colStarts: number[], rowStarts: number[]): SectionGrid {
  const sections: Section[] = [];
  for (let sr = 0; sr < rowStarts.length; sr++) {
    const r0 = rowStarts[sr];
    const r1 = sr + 1 < rowStarts.length ? rowStarts[sr + 1] : layout.rows;
    for (let sc = 0; sc < colStarts.length; sc++) {
      const c0 = colStarts[sc];
      const c1 = sc + 1 < colStarts.length ? colStarts[sc + 1] : layout.cols;
      const x = layout.colX[c0];
      const y = layout.rowY[r0];
      sections.push({
        id: sectionLabel(sr, sc),
        sr,
        sc,
        c0,
        c1,
        r0,
        r1,
        x,
        y,
        w: layout.colX[c1 - 1] + layout.colW[c1 - 1] - x,
        h: layout.rowY[r1 - 1] + layout.rowH[r1 - 1] - y,
      });
    }
  }
  return { srows: rowStarts.length, scols: colStarts.length, sections, colStarts, rowStarts };
}

function evenStarts(n: number, parts: number): number[] {
  const k = Math.max(1, Math.min(n, Math.round(parts)));
  const starts: number[] = [];
  for (let i = 0; i < k; i++) {
    const v = Math.round((i * n) / k);
    if (!starts.includes(v)) starts.push(v);
  }
  return starts;
}

/** Teilt das Raster in nc × nr möglichst gleich große Abschnitte (Grenzen auf Rasterlinien). */
export function computeSectionsByCount(layout: Layout, nc: number, nr: number): SectionGrid {
  return buildSections(layout, evenStarts(layout.cols, nc), evenStarts(layout.rows, nr));
}

export interface SectionSettings {
  sectionMode?: 'size' | 'count';
  sectionWmm: number;
  sectionHmm: number;
  sectionCols?: number;
  sectionRows?: number;
}

export function sectionsFor(layout: Layout, s: SectionSettings): SectionGrid {
  return s.sectionMode === 'count' ? computeSectionsByCount(layout, s.sectionCols ?? 1, s.sectionRows ?? 1) : computeSections(layout, s.sectionWmm, s.sectionHmm);
}

export function sectionOfCell(grid: SectionGrid, row: number, col: number): Section {
  const find = (starts: number[], v: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= v) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const sr = find(grid.rowStarts, row);
  const sc = find(grid.colStarts, col);
  return grid.sections[sr * grid.scols + sc];
}
