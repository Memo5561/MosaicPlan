/**
 * Kompakte Koordinatenliste je Abschnitt – vollständig und exakt, rein (ohne jsPDF):
 *
 *  1. Spaltentabelle „Spalte n: X von–bis“ und Zeilentabelle „Zeile K: Y von–bis“ (direkt aus layout.colX/colW
 *     bzw. rowY/rowH). Ein ganzer Stein in Zeile R, Spalte C liegt mit seiner linken oberen Außenkante bei
 *     (X_C, Y_R) und ist Spaltenbreite × Zeilenhöhe groß. Spalten/Zeilen, deren Maß vom Raster abweicht
 *     (Randzuschnitt), sind gekennzeichnet.
 *  2. Farbfolge je Zeile (Lauflängen in der Reihenfolge des Verlegeblatts), z. B. „1–6 → 09 · 7 ◆ · 8–20 → 06“:
 *     jede ganze Zelle bekommt ihre Farbnummer, auch wenn das Blatt keine Nummern tragen kann. ◆ = Zelle mit
 *     Sonderteilen (Liste 3).
 *  3. Sonderteile: eine Zeile je Stein, der kein ganzer Rasterstein ist – Teilsteine geteilter/feinerer/freier
 *     Zellen (kind ≠ FULL), ganze Zellen, die zugeschnitten werden müssen (Randzuschnitt), und ganze Zellen mit
 *     anderem Rohsteinmaß als das Raster. Maße und Begrenzungsrechteck aus dem echten Polygon (cellPieces) und
 *     analyzeCut (pieceCutInfo) – keine neue Geometrie.
 *  4. Kontrollsumme: ganze Steine + Sonderteile = Steine des Abschnitts (computeStats().pieces).
 *
 * Dazu ein reines Seitenlayout (CoordFlow) mit gemessenen Texten – derselbe Code für das PDF und den Seitenplan.
 */
import { wrapWords, PT_MM, type Measure } from './pdfTable';
import { bbox, type ShapeType } from './geometry';
import { cellId, pieceId, rowLabel, type Layout } from './layout';
import { cellPieces, type CutInfo } from './pieces';
import { pieceCutInfo, type CutCache, type Range, type RawSizeFn } from './stats';
import { CellKind, type MosaicData } from './types';

const EPS = 1e-9;

// ---------------------------------------------------------------- Daten

export interface AxisEntry {
  /** Spalten- bzw. Zeilenindex (ab 0) */
  index: number;
  /** Spaltennummer „17“ bzw. Zeilenbuchstabe „K“ (wie auf dem Verlegeblatt) */
  label: string;
  /** Anfang und Ende in mm ab Projektursprung (Außenkanten des Steins) */
  start: number;
  end: number;
  size: number;
  /** Maß weicht vom Rastermaß ab (Randzuschnitt) */
  trimmed: boolean;
}

/** Lauf einer Rasterzeile: ganze Steine einer Farbe (Spalten c0 … c1−1) oder Zellen mit Sonderteilen. */
export type RunItem = { kind: 'color'; c0: number; c1: number; color: number } | { kind: 'special'; c0: number; c1: number };

export interface RunRow {
  row: number;
  label: string;
  items: RunItem[];
}

/** Warum ein Stein als Sonderteil einzeln steht. */
export type SpecialReason = 'split' | 'cut' | 'raw';

export interface SpecialPiece {
  /** Position, z. B. „C014-2“ */
  id: string;
  row: number;
  col: number;
  piece: number;
  /** Teile der Zelle */
  pieces: number;
  color: number;
  shape: ShapeType;
  /** Außenmaß (Begrenzungsrechteck) */
  w: number;
  h: number;
  /** Begrenzungsrechteck in mm ab Projektursprung */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  needsCut: boolean;
  /** Schnittvorlagen-Signatur (collectTemplates → T#), nur bei needsCut sinnvoll */
  signature: string;
  reason: SpecialReason;
}

export interface CompactCoords {
  range: Range;
  cols: AxisEntry[];
  rows: AxisEntry[];
  runs: RunRow[];
  specials: SpecialPiece[];
  /** ganze Steine (in der Farbfolge) */
  whole: number;
  /** whole + specials.length */
  total: number;
  /** erster ganzer Stein (für das Ablesebeispiel) */
  firstWhole: { row: number; col: number; color: number } | null;
}

/** Zwischenspeicher der Schnittanalyse ganzer Zellen: (Spaltenbreite, Zeilenhöhe, Rohsteinmaß) → CutInfo */
export type FullCutMemo = Map<string, CutInfo>;

function axis(pos: ArrayLike<number>, size: ArrayLike<number>, a: number, b: number, tile: number, label: (i: number) => string): AxisEntry[] {
  const out: AxisEntry[] = [];
  for (let i = a; i < b; i++) out.push({ index: i, label: label(i), start: pos[i], end: pos[i] + size[i], size: size[i], trimmed: Math.abs(size[i] - tile) > EPS });
  return out;
}

/**
 * Kompakte Koordinaten eines Rasterbereichs. Jeder Stein (Teil mit Fläche, wie computeStats().pieces) steht genau
 * einmal: als ganzer Stein in der Farbfolge oder als Sonderteil.
 */
export function buildCompactCoords(layout: Layout, data: MosaicData, raw: RawSizeFn, range: Range, cache: CutCache, memo: FullCutMemo = new Map()): CompactCoords {
  const cols = axis(layout.colX, layout.colW, range.c0, range.c1, layout.tileW, (i) => String(i + 1));
  const rows = axis(layout.rowY, layout.rowH, range.r0, range.r1, layout.tileH, rowLabel);
  const runs: RunRow[] = [];
  const specials: SpecialPiece[] = [];
  let whole = 0;
  let firstWhole: CompactCoords['firstWhole'] = null;
  for (let row = range.r0; row < range.r1; row++) {
    const items: RunItem[] = [];
    const push = (it: RunItem) => {
      const last = items[items.length - 1];
      if (last && last.c1 === it.c0 && last.kind === it.kind && (it.kind === 'special' || (last.kind === 'color' && last.color === it.color))) last.c1 = it.c1;
      else items.push(it);
    };
    for (let col = range.c0; col < range.c1; col++) {
      const idx = row * layout.cols + col;
      if (data.kind[idx] === CellKind.FULL) {
        const color = data.c1[idx];
        const rs = raw(color);
        const key = `${layout.colW[col]}|${layout.rowH[row]}|${rs.w}x${rs.h}`;
        let ci = memo.get(key);
        if (!ci) {
          const p = cellPieces(layout, data, row, col)[0];
          ci = pieceCutInfo(cache, layout, data, row, col, 0, p.poly, rs);
          memo.set(key, ci);
        }
        if (ci.invalid) continue; // kein Stein (keine Fläche)
        const sameRaw = Math.abs(rs.w - layout.tileW) <= EPS && Math.abs(rs.h - layout.tileH) <= EPS;
        if (!ci.needsCut && sameRaw) {
          whole++;
          if (!firstWhole) firstWhole = { row, col, color };
          push({ kind: 'color', c0: col, c1: col + 1, color });
          continue;
        }
        const x = layout.colX[col];
        const y = layout.rowY[row];
        specials.push({
          id: cellId(layout, row, col),
          row,
          col,
          piece: 0,
          pieces: 1,
          color,
          shape: ci.shape,
          w: ci.w,
          h: ci.h,
          minX: x,
          maxX: x + layout.colW[col],
          minY: y,
          maxY: y + layout.rowH[row],
          needsCut: ci.needsCut,
          signature: ci.signature,
          reason: ci.needsCut ? 'cut' : 'raw',
        });
        push({ kind: 'special', c0: col, c1: col + 1 });
        continue;
      }
      const ps = cellPieces(layout, data, row, col);
      let any = false;
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        const ci = pieceCutInfo(cache, layout, data, row, col, i, p.poly, raw(p.color));
        if (ci.invalid) continue;
        any = true;
        const b = bbox(p.poly);
        specials.push({
          id: pieceId(layout, row, col, i, ps.length),
          row,
          col,
          piece: i,
          pieces: ps.length,
          color: p.color,
          shape: ci.shape,
          w: ci.w,
          h: ci.h,
          minX: b.minX,
          maxX: b.maxX,
          minY: b.minY,
          maxY: b.maxY,
          needsCut: ci.needsCut,
          signature: ci.signature,
          reason: 'split',
        });
      }
      if (any) push({ kind: 'special', c0: col, c1: col + 1 });
    }
    runs.push({ row, label: rowLabel(row), items });
  }
  return { range, cols, rows, runs, specials, whole, total: whole + specials.length, firstWhole };
}

/** Ein Stein, wie er sich aus den Tabellen ablesen lässt (für Prüfungen): Position, linke obere Ecke, Farbe. */
export interface ReadStone {
  id: string;
  x: number;
  y: number;
  color: number;
  /** ganze Steine: Spaltenbreite × Zeilenhöhe; Sonderteile: Außenmaß */
  w: number;
  h: number;
  special: boolean;
}

/** Liest alle Steine aus den kompakten Tabellen zurück (ganze Steine aus Spalte/Zeile + Farbfolge, dazu die Sonderteile). */
export function readCompactCoords(cc: CompactCoords, layout: { cols: number }): ReadStone[] {
  const colOf = new Map(cc.cols.map((c) => [c.index, c]));
  const rowOf = new Map(cc.rows.map((r) => [r.index, r]));
  const out: ReadStone[] = [];
  for (const rr of cc.runs) {
    const ry = rowOf.get(rr.row)!;
    for (const it of rr.items) {
      if (it.kind !== 'color') continue;
      for (let c = it.c0; c < it.c1; c++) {
        const cx = colOf.get(c)!;
        out.push({ id: cellId(layout, rr.row, c), x: cx.start, y: ry.start, color: it.color, w: cx.size, h: ry.size, special: false });
      }
    }
  }
  for (const s of cc.specials) out.push({ id: s.id, x: s.minX, y: s.minY, color: s.color, w: s.w, h: s.h, special: true });
  return out;
}

/** Text eines Laufs, z. B. „1–6 → 09“, „7 → 12“, „8–9 ◆“ (Spaltennummern wie auf dem Verlegeblatt). */
export function runToken(it: RunItem, code: (color: number) => string, special = '◆'): string {
  const cols = it.c1 - it.c0 > 1 ? `${it.c0 + 1}–${it.c1}` : `${it.c0 + 1}`;
  return it.kind === 'color' ? `${cols} → ${code(it.color)}` : `${cols} ${special}`;
}

// ---------------------------------------------------------------- Seitenlayout (gemessen, ohne jsPDF)

export type CoordOp =
  | { k: 't'; s: string; x: number; y: number; size: number; bold?: boolean; color?: string; align?: 'right' }
  | { k: 'r'; x: number; y: number; w: number; h: number; fill: string; stroke?: string };

export interface CoordPage {
  /** Abschnitte mit Inhalt auf dieser Seite (für Kopfzeile) */
  ids: string[];
  /** Abschnitte, deren Liste auf dieser Seite beginnt (Lesezeichen) */
  starts: string[];
  ops: CoordOp[];
}

export interface CoordGeometry {
  /** linker Rand und nutzbare Breite */
  M: number;
  AW: number;
  /** erste Zeile einer neuen Seite (Oberkante) und Unterkante des Inhalts */
  top: number;
  bottom: number;
}

/** Schriftgrößen und Abstände der kompakten Liste (mm/pt). */
export const COORD_COMPACT = {
  introTitle: 12,
  intro: 7,
  title: 10,
  head: 7,
  data: 6,
  /** Zeilenhöhe = Schriftgröße · Faktor · PT_MM */
  lineFactor: 1.28,
  /** kleinste Tabellenschrift, bevor Sonderteil-Zeilen zweizeilig werden */
  minData: 4.8,
  cellGap: 3,
  tableGap: 4,
  sectionGap: 4,
  /** Abschnitt beginnt auf einer neuen Seite, wenn weniger Platz bleibt */
  minStart: 24,
} as const;

const lh = (size: number) => size * COORD_COMPACT.lineFactor * PT_MM;
/** Grundlinie relativ zur Oberkante einer Zeile */
const base = (size: number) => size * 0.86 * PT_MM;

/** Texte eines Abschnitts (vom Generator übersetzt und formatiert). */
export interface CoordSectionTexts {
  id: string;
  title: string;
  /** „Ablesebeispiel:“, Position (fett, eigener Text) und Rest – oder null (Abschnitt ohne ganze Steine) */
  example: { label: string; id: string; rest: string } | null;
  colsHead: string;
  colEntries: string[];
  rowsHead: string;
  rowEntries: string[];
  /** Hinweise zu Randzuschnitten (je Zeile ein Satz) */
  trimNotes: string[];
  runsHead: string;
  runRows: { label: string; tokens: string[] }[];
  specialHead: string;
  specialHeader: string[];
  /** Ausrichtung je Sonderteil-Spalte */
  specialAlign: ('left' | 'right')[];
  specialRows: string[][];
  /** Zusatz „(Fortsetzung)“ an wiederholten Überschriften */
  cont: string;
  control: string;
  controlOk: boolean;
}

/** Fließendes Seitenlayout der Koordinaten (mehrere Abschnitte nacheinander, Seitenumbrüche gemessen). */
export class CoordFlow {
  readonly pages: CoordPage[] = [];
  y = 0;
  private cur = '';
  constructor(
    readonly geo: CoordGeometry,
    readonly measure: Measure,
    /** false: nur Seiten zählen (Seitenplan), keine Zeichenbefehle aufbewahren */
    readonly keepOps = true,
  ) {}

  private get page(): CoordPage {
    return this.pages[this.pages.length - 1];
  }
  newPage(): void {
    if (!this.keepOps && this.pages.length) this.pages[this.pages.length - 1].ops = [];
    this.pages.push({ ids: this.cur ? [this.cur] : [], starts: [], ops: [] });
    this.y = this.geo.top;
  }
  /** Platz für h mm, sonst neue Seite; true = neue Seite begonnen */
  ensure(h: number): boolean {
    if (!this.pages.length || this.y + h > this.geo.bottom + 1e-9) {
      this.newPage();
      return true;
    }
    return false;
  }
  private op(o: CoordOp): void {
    if (this.keepOps) this.page.ops.push(o);
  }
  private mark(id: string): void {
    this.cur = id;
    const ids = this.page.ids;
    if (ids[ids.length - 1] !== id) ids.push(id);
  }
  width(s: string, size: number, bold = false): number {
    return this.measure(s, bold) * size;
  }
  /** Absatz (umbrochen, ganze Breite) */
  para(s: string, size: number, o: { bold?: boolean; color?: string; gap?: number; keep?: boolean } = {}): void {
    const lines = wrapWords(s, this.geo.AW, size, !!o.bold, this.measure);
    const h = lines.length * lh(size);
    if (o.keep && h <= this.geo.bottom - this.geo.top) this.ensure(h);
    for (const l of lines) {
      this.ensure(lh(size));
      this.op({ k: 't', s: l, x: this.geo.M, y: this.y + base(size), size, bold: o.bold, color: o.color });
      this.y += lh(size);
    }
    this.y += o.gap ?? 0;
  }

  /** Einleitung des Kapitels (einmal) */
  intro(title: string, text: string): void {
    this.ensure(30);
    const C = COORD_COMPACT;
    this.op({ k: 't', s: title, x: this.geo.M, y: this.y + base(C.introTitle), size: C.introTitle, bold: true });
    this.y += lh(C.introTitle) + 0.6;
    this.para(text, C.intro, { color: '#444444', gap: 2 });
  }

  /** Raster aus kurzen Einträgen (Spalten/Zeilen), spaltenweise gefüllt, über Seiten fortgesetzt */
  private grid(head: string, entries: string[], cont: string): void {
    const C = COORD_COMPACT;
    const size = C.data;
    let cellW = 0;
    for (const e of entries) cellW = Math.max(cellW, this.width(e, size));
    cellW += C.cellGap;
    const perLine = Math.max(1, Math.floor((this.geo.AW + C.cellGap) / cellW));
    let k = 0;
    let first = true;
    while (k < entries.length) {
      // Überschrift und mindestens eine Zeile zusammen
      this.ensure(lh(C.head) + lh(size));
      this.op({ k: 't', s: first ? head : `${head} ${cont}`, x: this.geo.M, y: this.y + base(C.head), size: C.head, bold: true });
      this.y += lh(C.head);
      first = false;
      const avail = Math.max(1, Math.floor((this.geo.bottom - this.y) / lh(size) + 1e-9));
      const left = entries.length - k;
      const lines = Math.min(avail, Math.ceil(left / perLine));
      const n = Math.min(left, lines * perLine);
      for (let j = 0; j < n; j++) {
        const col = Math.floor(j / lines);
        const line = j % lines;
        this.op({ k: 't', s: entries[k + j], x: this.geo.M + col * cellW, y: this.y + line * lh(size) + base(size), size });
      }
      this.y += lines * lh(size);
      k += n;
      if (k < entries.length) this.newPage();
    }
    this.y += 1;
  }

  /** Farbfolge: je Rasterzeile Beschriftung + Läufe (nur zwischen Läufen umbrochen) */
  private runs(head: string, rows: { label: string; tokens: string[] }[], cont: string): void {
    const C = COORD_COMPACT;
    const size = C.data;
    const sep = ' · ';
    const sepW = this.width(sep, size);
    let labW = 0;
    for (const r of rows) labW = Math.max(labW, this.width(r.label, size, true));
    labW += 2;
    const textW = this.geo.AW - labW;
    const blocks = rows.map((r) => {
      const lines: string[] = [];
      let cur = '';
      let w = 0;
      for (const tk of r.tokens) {
        const tw = this.width(tk, size);
        if (cur && w + sepW + tw > textW + 1e-6) {
          lines.push(`${cur}${sep.trimEnd()}`);
          cur = tk;
          w = tw;
        } else {
          cur = cur ? `${cur}${sep}${tk}` : tk;
          w = cur === tk ? tw : w + sepW + tw;
        }
      }
      lines.push(cur);
      return { label: r.label, lines };
    });
    const drawHead = (again: boolean) => {
      this.op({ k: 't', s: again ? `${head} ${cont}` : head, x: this.geo.M, y: this.y + base(C.head), size: C.head, bold: true });
      this.y += lh(C.head);
    };
    // eine Zeile des Mosaiks bleibt zusammen (außer sie ist länger als eine Seite)
    const maxBlock = this.geo.bottom - this.geo.top - lh(C.head);
    let headDrawn = false;
    for (const b of blocks) {
      const h = Math.min(b.lines.length * lh(size), maxBlock);
      const fresh = this.ensure((headDrawn ? 0 : lh(C.head)) + h);
      if (!headDrawn || fresh) drawHead(headDrawn);
      headDrawn = true;
      b.lines.forEach((l, i) => {
        if (i > 0 && this.ensure(lh(size))) drawHead(true);
        if (i === 0) this.op({ k: 't', s: b.label, x: this.geo.M, y: this.y + base(size), size, bold: true });
        this.op({ k: 't', s: l, x: this.geo.M + labW, y: this.y + base(size), size });
        this.y += lh(size);
      });
    }
    this.y += 1;
  }

  /** Sonderteil-Tabelle: gemessene Spalten, mehrere Tabellenspalten nebeneinander, wenn das Papier breit genug ist */
  private specials(head: string, header: string[], align: ('left' | 'right')[], rows: string[][], cont: string): void {
    const C = COORD_COMPACT;
    const pad = 1.6;
    const widthsAt = (size: number) =>
      header.map((h, j) => {
        let w = this.width(h, size, true);
        for (const r of rows) w = Math.max(w, this.width(r[j] ?? '', size));
        return w + pad;
      });
    let size: number = C.data;
    let widths = widthsAt(size);
    let tw = widths.reduce((a, b) => a + b, 0);
    while (tw > this.geo.AW && size > C.minData) {
      size = Math.max(C.minData, size - 0.4);
      widths = widthsAt(size);
      tw = widths.reduce((a, b) => a + b, 0);
    }
    // zu schmales Papier: zweite Hälfte der Spalten als zweite Zeile je Eintrag
    let split = header.length;
    if (tw > this.geo.AW) {
      split = Math.ceil(header.length / 2);
      const w1 = widths.slice(0, split);
      const w2 = widths.slice(split);
      const n = Math.max(w1.length, w2.length);
      widths = Array.from({ length: n }, (_, j) => Math.max(w1[j] ?? 0, w2[j] ?? 0));
      tw = widths.reduce((a, b) => a + b, 0);
    }
    const lines = split < header.length ? 2 : 1;
    const rowH = lines * lh(size) + 0.3;
    const headH = lines * lh(size) + 0.6;
    const k = Math.max(1, Math.floor((this.geo.AW + C.tableGap) / (tw + C.tableGap)));
    const cellX = (j: number) => {
      const jj = j < split ? j : j - split;
      let x = 0;
      for (let i = 0; i < jj; i++) x += widths[i];
      return { x, w: widths[jj], line: j < split ? 0 : 1 };
    };
    const drawRow = (cells: string[], x0: number, y0: number, bold: boolean) => {
      cells.forEach((c, j) => {
        if (!c) return;
        const p = cellX(j);
        const right = align[j] === 'right';
        this.op({ k: 't', s: c, x: x0 + p.x + (right ? p.w - pad / 2 : 0.4), y: y0 + p.line * lh(size) + base(size), size, bold, align: right ? 'right' : undefined });
      });
    };
    // Überschrift des Teils (umbrochen) mit mindestens Kopfzeile + einer Zeile
    const headLines = wrapWords(head, this.geo.AW, C.head, true, this.measure);
    this.ensure(headLines.length * lh(C.head) + headH + rowH);
    for (const l of headLines) {
      this.op({ k: 't', s: l, x: this.geo.M, y: this.y + base(C.head), size: C.head, bold: true });
      this.y += lh(C.head);
    }
    let i = 0;
    let first = true;
    while (i < rows.length) {
      if (!first) {
        this.newPage();
        this.op({ k: 't', s: `${headLines[0]} ${cont}`, x: this.geo.M, y: this.y + base(C.head), size: C.head, bold: true });
        this.y += lh(C.head);
      }
      first = false;
      let per = Math.floor((this.geo.bottom - this.y - headH) / rowH + 1e-9);
      if (per < 1) {
        this.newPage();
        per = Math.max(1, Math.floor((this.geo.bottom - this.y - headH) / rowH + 1e-9));
      }
      const left = rows.length - i;
      const perCol = Math.min(per, Math.ceil(left / k));
      const n = Math.min(left, perCol * k);
      const usedCols = Math.ceil(n / perCol);
      for (let c = 0; c < usedCols; c++) {
        const x0 = this.geo.M + c * (tw + C.tableGap);
        this.op({ k: 'r', x: x0, y: this.y, w: tw, h: headH - 0.3, fill: '#EEEAE3' });
        drawRow(header, x0, this.y + 0.2, true);
      }
      const y0 = this.y + headH;
      for (let j = 0; j < n; j++) {
        const c = Math.floor(j / perCol);
        const r = j % perCol;
        const x0 = this.geo.M + c * (tw + C.tableGap);
        const yy = y0 + r * rowH;
        if (r % 2 === 1) this.op({ k: 'r', x: x0, y: yy, w: tw, h: rowH, fill: '#F5F3EF' });
        drawRow(rows[i + j], x0, yy + 0.15, false);
      }
      this.y = y0 + perCol * rowH;
      i += n;
    }
    this.y += 1.2;
  }

  /** Ein Abschnitt: Titel, Ablesebeispiel, Spalten, Zeilen, Farbfolge, Sonderteile, Kontrolle */
  section(s: CoordSectionTexts): void {
    const C = COORD_COMPACT;
    if (this.pages.length && this.y > this.geo.top + 1e-9) this.y += C.sectionGap;
    this.ensure(C.minStart);
    this.mark(s.id);
    this.page.starts.push(s.id);
    // Titel (Schrift bis 7 pt verkleinert, nie gekürzt)
    let ts: number = C.title;
    while (ts > 7 && this.width(s.title, ts, true) > this.geo.AW) ts -= 0.5;
    this.para(s.title, ts, { bold: true, gap: 0.6 });
    if (s.example) {
      const size = 6.5;
      const lw = this.width(`${s.example.label} `, size);
      const iw = this.width(`${s.example.id} `, size, true);
      const restLines = wrapWords(s.example.rest, Math.max(20, this.geo.AW - lw - iw), size, false, this.measure);
      this.ensure(restLines.length * lh(size));
      this.op({ k: 't', s: s.example.label, x: this.geo.M, y: this.y + base(size), size, color: '#444444' });
      this.op({ k: 't', s: s.example.id, x: this.geo.M + lw, y: this.y + base(size), size, bold: true });
      restLines.forEach((l, i) => {
        this.op({ k: 't', s: l, x: this.geo.M + lw + iw, y: this.y + base(size), size, color: '#444444' });
        this.y += lh(size);
        if (i < restLines.length - 1) this.ensure(lh(size));
      });
      this.y += 0.8;
    }
    if (s.colEntries.length) this.grid(s.colsHead, s.colEntries, s.cont);
    if (s.rowEntries.length) this.grid(s.rowsHead, s.rowEntries, s.cont);
    for (const n of s.trimNotes) this.para(n, C.data, { color: '#8A3B00' });
    if (s.trimNotes.length) this.y += 1;
    if (s.runRows.length) this.runs(s.runsHead, s.runRows, s.cont);
    if (s.specialRows.length) this.specials(s.specialHead, s.specialHeader, s.specialAlign, s.specialRows, s.cont);
    if (s.controlOk) this.para(s.control, 6.5, { bold: true, color: '#1E5631', keep: true });
    else {
      const lines = wrapWords(s.control, this.geo.AW - 4, 8, true, this.measure);
      const h = lines.length * lh(8) + 3;
      this.ensure(h);
      this.op({ k: 'r', x: this.geo.M, y: this.y, w: this.geo.AW, h, fill: '#FDECEA', stroke: '#B3261E' });
      lines.forEach((l, i) => this.op({ k: 't', s: l, x: this.geo.M + 2, y: this.y + 1.5 + i * lh(8) + base(8), size: 8, bold: true, color: '#B3261E' }));
      this.y += h + 1;
    }
  }
}
