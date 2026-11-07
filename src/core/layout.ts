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

export function computeAxis(L: number, w: number, g: number, mode: EdgeMode, minCut: number): AxisLayout {
  if (!(L > 0) || !(w > 0) || g < 0) throw new Error('Ungültige Maße.');
  const pitch = w + g;
  let n = Math.floor((L + g) / pitch + 1e-9);
  const sizes: number[] = [];
  if (n < 1) {
    // Projekt kleiner als ein Stein
    if (mode !== 'whole' && L >= minCut) {
      sizes.push(L);
    } else {
      throw new Error('Die Projektgröße ist kleiner als ein einzelner Stein.');
    }
  } else {
    const r = L - (n * w + (n - 1) * g);
    if (mode === 'whole' || r <= 1e-6) {
      for (let i = 0; i < n; i++) sizes.push(w);
    } else if (mode === 'cut-end') {
      const c = r - g;
      if (c >= minCut - 1e-9) {
        for (let i = 0; i < n; i++) sizes.push(w);
        sizes.push(c);
      } else {
        // Restbreite zu schmal: letzten ganzen Stein + Rest auf zwei gleich breite Randsteine verteilen
        const c2 = (w + c) / 2;
        if (n >= 1 && c2 >= minCut - 1e-9) {
          for (let i = 0; i < n - 1; i++) sizes.push(w);
          sizes.push(c2, c2);
        } else {
          for (let i = 0; i < n; i++) sizes.push(w);
        }
      }
    } else {
      // cut-both: symmetrisch zentriert, gleich breite Randsteine links/rechts
      let full = n - 1;
      let c = (L - full * w - (full + 1) * g) / 2;
      while (c < minCut - 1e-9 && full > 0) {
        full -= 1;
        c = (L - full * w - (full + 1) * g) / 2;
      }
      if (c >= minCut - 1e-9 && c <= w + 1e-9) {
        sizes.push(c);
        for (let i = 0; i < full; i++) sizes.push(w);
        sizes.push(c);
      } else {
        for (let i = 0; i < n; i++) sizes.push(w);
      }
    }
  }
  n = sizes.length;
  const pos = new Float64Array(n);
  const size = new Float64Array(n);
  let x = 0;
  let cutCount = 0;
  for (let i = 0; i < n; i++) {
    pos[i] = x;
    size[i] = sizes[i];
    if (Math.abs(sizes[i] - w) > 1e-9) cutCount++;
    x += sizes[i] + g;
  }
  const used = pos[n - 1] + size[n - 1];
  return { pos, size, used, rest: Math.max(0, L - used), cutCount };
}

export function computeLayout(p: LayoutParams): Layout {
  const ax = computeAxis(p.widthMm, p.tileW, p.joint, p.edgeMode, p.minCutMm);
  const ay = computeAxis(p.heightMm, p.tileH, p.joint, p.edgeMode, p.minCutMm);
  const cells = ax.pos.length * ay.pos.length;
  if (cells > MAX_CELLS) {
    throw new Error(
      `Das Projekt hätte ${cells.toLocaleString('de-DE')} Rasterpositionen; unterstützt werden höchstens ${MAX_CELLS.toLocaleString('de-DE')}.`,
    );
  }
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
  const m = /^([A-Za-z]+)(\d+)(?:-(\d+))?$/.exec(id.trim());
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
