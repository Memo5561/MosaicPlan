/**
 * Werkbank „Verlegen“ (Schritt 9): reine Logik ohne DOM, getestet in tests/w4-laying-workbench.test.ts.
 *
 * - Farbe eines Teilstücks in derselben Reihenfolge wie cellPieces (ohne Geometrie)
 * - verlegte/gesamte Steine je Farbe in einem Bereich – Summe über alle Farben = progressOf(bereich)
 * - Verlegereihenfolge (Reihe für Reihe in Schlangenlinie oder Farbe für Farbe) und „nächster offener Stein“
 * - Rückgängig für den Verlegefortschritt (nur im Speicher, nur für diese Sitzung)
 *
 * Alle Zahlen stammen aus data.progress und cellPieceCount – nichts wird geschätzt. Teilstücke werden mit
 * cellPieceCount gezählt, genau wie in progressOf, setCellPlaced und beim Antippen im Viewer.
 */
import { parseCellId, type Layout } from './layout';
import { cellPieceCount } from './pieces';
import type { Range } from './stats';
import { CellKind, type MosaicData } from './types';

/** Höchstens 16 Teilstücke je Zelle (16-Bit-Fortschrittsmaske) */
export const MAX_PIECES_PER_CELL = 16;

/**
 * Farbe (Palettenindex) von Teilstück `i` der Zelle `idx` – dieselbe Reihenfolge wie cellPieces:
 * ganzer Stein c1; Dreiecke und Kantenschnitt c1 dann c2; Unterteilung sub[i]; Freiform free[i].color.
 * -1, wenn es das Teilstück nicht gibt.
 */
export function pieceColor(data: MosaicData, idx: number, i: number): number {
  switch (data.kind[idx]) {
    case CellKind.DIAG_A:
    case CellKind.DIAG_B:
    case CellKind.LINE:
      return i === 0 ? data.c1[idx] : i === 1 ? data.c2[idx] : -1;
    case CellKind.SUB: {
      const s = data.sub.get(idx);
      if (!s) return i === 0 ? data.c1[idx] : -1;
      return i < s.length ? s[i] : -1;
    }
    case CellKind.FREE:
      return data.free.get(idx)?.[i]?.color ?? -1;
    default:
      return i === 0 ? data.c1[idx] : -1;
  }
}

export function fullRange(layout: Pick<Layout, 'rows' | 'cols'>): Range {
  return { r0: 0, r1: layout.rows, c0: 0, c1: layout.cols };
}

/** Liegt die Zelle im Bereich (halboffen wie setRangePlaced)? */
export function cellInRange(rg: Range, row: number, col: number): boolean {
  return row >= rg.r0 && row < rg.r1 && col >= rg.c0 && col < rg.c1;
}

export interface ColorProgress {
  placed: number;
  total: number;
}

/**
 * Verlegte und gesamte Steine je Farbe im Bereich (ohne Bereich: ganzes Mosaik). Zählt wie progressOf:
 * cellPieceCount Teile je Zelle, Bit i der Fortschrittsmaske = Teil i verlegt.
 */
export function progressByColor(layout: Pick<Layout, 'rows' | 'cols'>, data: MosaicData, range?: Range | null): Map<number, ColorProgress> {
  const rg = range ?? fullRange(layout);
  const out = new Map<number, ColorProgress>();
  for (let row = rg.r0; row < rg.r1; row++) {
    for (let col = rg.c0; col < rg.c1; col++) {
      const idx = row * layout.cols + col;
      const n = cellPieceCount(data, idx);
      if (n <= 0) continue;
      const m = data.progress[idx];
      if (data.kind[idx] === CellKind.FULL) {
        // häufigster Fall ohne Umweg über pieceColor
        const c = data.c1[idx];
        let e = out.get(c);
        if (!e) out.set(c, (e = { placed: 0, total: 0 }));
        e.total++;
        e.placed += m & 1;
        continue;
      }
      for (let i = 0; i < n; i++) {
        const c = pieceColor(data, idx, i);
        let e = out.get(c);
        if (!e) out.set(c, (e = { placed: 0, total: 0 }));
        e.total++;
        e.placed += (m >> i) & 1;
      }
    }
  }
  return out;
}

/**
 * Zähler je Farbe für einen Bereich, der nach Änderungen am Fortschritt nur die geänderten Teilstücke
 * nachführt (statt bei jedem Antippen das ganze Raster zu durchlaufen). Bei Änderungen am Mosaik selbst
 * (Farbe, Form, neue Berechnung) wird er neu aufgebaut.
 */
export class ColorProgressCounter {
  private constructor(
    readonly cols: number,
    readonly range: Range,
    readonly counts: Map<number, ColorProgress>,
  ) {}

  static build(layout: Pick<Layout, 'rows' | 'cols'>, data: MosaicData, range?: Range | null): ColorProgressCounter {
    const rg = range ? { r0: range.r0, r1: range.r1, c0: range.c0, c1: range.c1 } : fullRange(layout);
    return new ColorProgressCounter(layout.cols, rg, progressByColor(layout, data, rg));
  }

  covers(idx: number): boolean {
    const row = Math.floor(idx / this.cols);
    return cellInRange(this.range, row, idx - row * this.cols);
  }

  /** Die Fortschrittsmaske der Zelle `idx` hat sich von `before` zu `after` geändert. */
  update(data: MosaicData, idx: number, before: number, after: number): void {
    if (!this.covers(idx)) return;
    const n = cellPieceCount(data, idx);
    const diff = (before ^ after) & ((1 << n) - 1);
    if (!diff) return;
    for (let i = 0; i < n; i++) {
      if (!((diff >> i) & 1)) continue;
      const e = this.counts.get(pieceColor(data, idx, i));
      if (e) e.placed += (after >> i) & 1 ? 1 : -1;
    }
  }

  totals(): ColorProgress {
    let placed = 0;
    let total = 0;
    for (const e of this.counts.values()) {
      placed += e.placed;
      total += e.total;
    }
    return { placed, total };
  }
}

// ---------------------------------------------------------------- Verlegereihenfolge

/** Ein Stein als Zahl: Zellindex · 16 + Teilstück (Teilstück < 16, Zellen ≤ 40 Mio. → < 2³¹) */
export function packRef(idx: number, piece: number): number {
  return idx * MAX_PIECES_PER_CELL + piece;
}
export function refIdx(code: number): number {
  return Math.floor(code / MAX_PIECES_PER_CELL);
}
export function refPiece(code: number): number {
  return code % MAX_PIECES_PER_CELL;
}

export function isRefPlaced(data: MosaicData, code: number): boolean {
  return ((data.progress[refIdx(code)] >> refPiece(code)) & 1) === 1;
}

/** 'serpentine': Reihe für Reihe, abwechselnd links→rechts und rechts→links; 'color': Farbe für Farbe */
export type LayingOrderKind = 'serpentine' | 'color';

export interface LayingOrderOptions {
  order: LayingOrderKind;
  /** nur Steine dieser Farbe (Palettenindex) */
  color?: number | null;
  /** Sortierschlüssel einer Farbe für 'color' (z. B. Farbnummer); ohne: Palettenindex */
  colorRank?: (color: number) => number;
}

/**
 * Alle Steine des Bereichs in Verlegereihenfolge, jeder genau einmal (gepackt, siehe packRef).
 * Reihe für Reihe: die erste Reihe des Bereichs von links nach rechts, die nächste von rechts nach links usw.;
 * innerhalb einer Zelle die Teilstücke in Indexreihenfolge. Farbe für Farbe: Farben nach colorRank, innerhalb
 * einer Farbe dieselbe Schlangenlinie. Mit `color` nur Steine dieser Farbe.
 */
export function layingOrder(layout: Pick<Layout, 'rows' | 'cols'>, data: MosaicData, range: Range | null | undefined, opts: LayingOrderOptions): Int32Array {
  const rg = range ?? fullRange(layout);
  const only = opts.color ?? null;
  // 1. Durchlauf: Anzahl (exakte Größe, keine wachsenden Arrays bei Millionen Steinen)
  let n = 0;
  for (let row = rg.r0; row < rg.r1; row++) {
    for (let col = rg.c0; col < rg.c1; col++) {
      const idx = row * layout.cols + col;
      const k = cellPieceCount(data, idx);
      if (only === null) n += Math.max(0, k);
      else for (let i = 0; i < k; i++) if (pieceColor(data, idx, i) === only) n++;
    }
  }
  const ser = new Int32Array(n);
  const colors = opts.order === 'color' && only === null ? new Int32Array(n) : null;
  let p = 0;
  for (let row = rg.r0; row < rg.r1; row++) {
    const ltr = (row - rg.r0) % 2 === 0;
    for (let j = 0; j < rg.c1 - rg.c0; j++) {
      const col = ltr ? rg.c0 + j : rg.c1 - 1 - j;
      const idx = row * layout.cols + col;
      const k = cellPieceCount(data, idx);
      for (let i = 0; i < k; i++) {
        if (only === null) {
          if (colors) colors[p] = pieceColor(data, idx, i);
          ser[p++] = packRef(idx, i);
        } else if (pieceColor(data, idx, i) === only) ser[p++] = packRef(idx, i);
      }
    }
  }
  if (!colors) return ser;
  // Farbe für Farbe: stabil nach Rang (Zählsortierung, Reihenfolge innerhalb einer Farbe bleibt)
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) counts.set(colors[i], (counts.get(colors[i]) ?? 0) + 1);
  const rank = opts.colorRank ?? ((c: number) => c);
  const keys = [...counts.keys()].sort((a, b) => rank(a) - rank(b) || a - b);
  const start = new Map<number, number>();
  let acc = 0;
  for (const c of keys) {
    start.set(c, acc);
    acc += counts.get(c)!;
  }
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const s = start.get(colors[i])!;
    out[s] = ser[i];
    start.set(colors[i], s + 1);
  }
  return out;
}

/**
 * Position des ersten nicht verlegten Steins ab `from` (einschließlich); mit `wrap` danach vom Anfang bis
 * vor `from`. -1, wenn alle verlegt sind.
 */
export function nextUnplaced(order: Int32Array, data: MosaicData, from = 0, wrap = true): number {
  const n = order.length;
  if (!n) return -1;
  const s = Math.max(0, Math.min(n, from));
  for (let p = s; p < n; p++) if (!isRefPlaced(data, order[p])) return p;
  if (wrap) for (let p = 0; p < s; p++) if (!isRefPlaced(data, order[p])) return p;
  return -1;
}

/** Position eines Steins in der Reihenfolge (-1: nicht enthalten) */
export function orderPosOf(order: Int32Array, idx: number, piece: number): number {
  const code = packRef(idx, piece);
  for (let p = 0; p < order.length; p++) if (order[p] === code) return p;
  return -1;
}

/**
 * Zusammenhängender Block der Reihenfolge mit derselben Rasterzeile wie Position `pos` – [start, end).
 * In der Reihenfolge „Reihe für Reihe“ sind das alle Steine dieser Zeile im Bereich (ggf. nur der gewählten Farbe).
 */
export function rowBlock(order: Int32Array, cols: number, pos: number): [number, number] {
  if (pos < 0 || pos >= order.length) return [pos, pos];
  const row = Math.floor(refIdx(order[pos]) / cols);
  let a = pos;
  let b = pos + 1;
  while (a > 0 && Math.floor(refIdx(order[a - 1]) / cols) === row) a--;
  while (b < order.length && Math.floor(refIdx(order[b]) / cols) === row) b++;
  return [a, b];
}

// ---------------------------------------------------------------- Ändern mit Rückgängig

/** Zustand vor einer Änderung: einzelne Zellen oder ein ganzer Bereich (Ausschnitt der Fortschrittsmasken) */
export type ProgressSnapshot = { kind: 'cells'; cells: Int32Array; before: Uint16Array } | { kind: 'range'; range: Range; before: Uint16Array };

/** Masken der Zellen merken (jede Zelle einmal) */
export function captureCells(data: MosaicData, cells: Iterable<number>): ProgressSnapshot {
  const uniq = [...new Set(cells)];
  const c = Int32Array.from(uniq);
  const before = new Uint16Array(c.length);
  for (let k = 0; k < c.length; k++) before[k] = data.progress[c[k]];
  return { kind: 'cells', cells: c, before };
}

/** Masken eines Bereichs merken (zeilenweise Ausschnitte) */
export function captureRange(layout: Pick<Layout, 'cols'>, data: MosaicData, rg: Range): ProgressSnapshot {
  const w = rg.c1 - rg.c0;
  const before = new Uint16Array(Math.max(0, (rg.r1 - rg.r0) * w));
  for (let r = rg.r0; r < rg.r1; r++) before.set(data.progress.subarray(r * layout.cols + rg.c0, r * layout.cols + rg.c1), (r - rg.r0) * w);
  return { kind: 'range', range: { r0: rg.r0, r1: rg.r1, c0: rg.c0, c1: rg.c1 }, before };
}

/** Speicherbedarf eines Schnappschusses in Byte */
export function snapshotBytes(s: ProgressSnapshot): number {
  return s.before.byteLength + (s.kind === 'cells' ? s.cells.byteLength : 0) + 64;
}

/**
 * Jede Zelle des Schnappschusses, deren Maske sich seitdem geändert hat: fn(idx, damals, jetzt).
 * Gleiche Reihenfolge wie beim Merken.
 */
export function forEachChanged(layout: Pick<Layout, 'cols'>, data: MosaicData, s: ProgressSnapshot, fn: (idx: number, before: number, now: number) => void): void {
  if (s.kind === 'cells') {
    for (let k = 0; k < s.cells.length; k++) {
      const idx = s.cells[k];
      if (data.progress[idx] !== s.before[k]) fn(idx, s.before[k], data.progress[idx]);
    }
    return;
  }
  const rg = s.range;
  const w = rg.c1 - rg.c0;
  for (let r = rg.r0; r < rg.r1; r++) {
    for (let c = rg.c0; c < rg.c1; c++) {
      const idx = r * layout.cols + c;
      const b = s.before[(r - rg.r0) * w + (c - rg.c0)];
      if (data.progress[idx] !== b) fn(idx, b, data.progress[idx]);
    }
  }
}

/**
 * Stellt die gemerkten Masken exakt wieder her. Liefert die tatsächlich geänderten Zellen mit ihren Masken
 * vor dem Zurücksetzen (für Zähler und das Speichern).
 */
export function restoreSnapshot(layout: Pick<Layout, 'cols'>, data: MosaicData, s: ProgressSnapshot): { idx: number; before: number; after: number }[] {
  const changed: { idx: number; before: number; after: number }[] = [];
  forEachChanged(layout, data, s, (idx, then, now) => {
    data.progress[idx] = then;
    changed.push({ idx, before: now, after: then });
  });
  return changed;
}

/**
 * Setzt einzelne Steine auf „verlegt“ (`set` = true) oder „offen“ – ein Teilstück über die Teilezahl der Zelle
 * hinaus wird übersprungen. Liefert die Anzahl wirklich geänderter Steine. Kein Umschalten: zweimal derselbe
 * Stein ändert nichts.
 */
export function setPiecesPlaced(data: MosaicData, refs: Iterable<{ idx: number; piece: number }>, set: boolean): number {
  let n = 0;
  for (const r of refs) {
    if (r.piece < 0 || r.piece >= cellPieceCount(data, r.idx)) continue;
    const bit = 1 << r.piece;
    const was = (data.progress[r.idx] & bit) !== 0;
    if (was === set) continue;
    data.progress[r.idx] = set ? data.progress[r.idx] | bit : data.progress[r.idx] & ~bit;
    n++;
  }
  return n;
}

/** Steine (Teilstücke) im Bereich, die verlegt bzw. insgesamt vorhanden sind – wie progressOf */
export function rangeCounts(layout: Pick<Layout, 'cols'>, data: MosaicData, rg: Range): ColorProgress {
  let placed = 0;
  let total = 0;
  for (let r = rg.r0; r < rg.r1; r++) {
    for (let c = rg.c0; c < rg.c1; c++) {
      const idx = r * layout.cols + c;
      const n = cellPieceCount(data, idx);
      total += n;
      const m = data.progress[idx] & ((1 << n) - 1);
      for (let v = m; v; v &= v - 1) placed++;
    }
  }
  return { placed, total };
}

/**
 * Rückgängig-Stapel für den Verlegefortschritt: höchstens `maxEntries` Schritte und `maxBytes` Speicher,
 * die ältesten fallen heraus. Lebt nur im Speicher (nicht über Neuladen/Verlassen des Projekts hinweg).
 */
export class ProgressUndo<M = unknown> {
  private entries: { snap: ProgressSnapshot; meta: M; bytes: number }[] = [];
  private bytes = 0;

  constructor(
    readonly maxEntries = 50,
    readonly maxBytes = 32 * 1024 * 1024,
  ) {}

  get size(): number {
    return this.entries.length;
  }

  push(snap: ProgressSnapshot, meta: M): void {
    const b = snapshotBytes(snap);
    this.entries.push({ snap, meta, bytes: b });
    this.bytes += b;
    while (this.entries.length > this.maxEntries || (this.bytes > this.maxBytes && this.entries.length > 1)) {
      const e = this.entries.shift()!;
      this.bytes -= e.bytes;
    }
  }

  pop(): { snap: ProgressSnapshot; meta: M } | undefined {
    const e = this.entries.pop();
    if (e) this.bytes -= e.bytes;
    return e;
  }

  clear(): void {
    this.entries = [];
    this.bytes = 0;
  }
}

// ---------------------------------------------------------------- Stein suchen

export type StoneLookup =
  | { ok: true; row: number; col: number; piece: number; pieces: number }
  | { ok: false; reason: 'empty' | 'unknown' }
  /** Zelle gibt es, das Teilstück nicht (z. B. A001-3 bei einer zweiteiligen Zelle, A001-0) */
  | { ok: false; reason: 'piece'; row: number; col: number; pieces: number };

/**
 * Stein-ID wie in Plan, PDF und CSV („AP034“, „AP034-2“) auflösen – inklusive Prüfung, ob es das Teilstück
 * in dieser Zelle wirklich gibt. „-1“ bei einer ungeteilten Zelle ist derselbe Stein wie ohne Zusatz.
 */
export function resolveStoneId(layout: Pick<Layout, 'rows' | 'cols'>, data: MosaicData, text: string): StoneLookup {
  const s = text.trim();
  if (!s) return { ok: false, reason: 'empty' };
  const p = parseCellId(layout, s);
  if (!p) {
    // gültige Zelle mit ungültigem Zusatz (A001-0, A001-00)?
    const m = /^([A-Za-z]+\d+)-\d+$/.exec(s);
    const base = m ? parseCellId(layout, m[1]) : null;
    if (base) return { ok: false, reason: 'piece', row: base.row, col: base.col, pieces: cellPieceCount(data, base.row * layout.cols + base.col) };
    return { ok: false, reason: 'unknown' };
  }
  const n = cellPieceCount(data, p.row * layout.cols + p.col);
  if (p.piece >= 0 && p.piece < n) return { ok: true, row: p.row, col: p.col, piece: p.piece, pieces: n };
  return { ok: false, reason: 'piece', row: p.row, col: p.col, pieces: n };
}

// ---------------------------------------------------------------- gemerkte Auswahl je Projekt (nur Komfort)

export interface LayingPrefs {
  section: string | null;
  order: LayingOrderKind;
}
export interface PrefStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
const PREFS_KEY = 'mosaicplan.laying';
const PREFS_MAX = 50;

function defaultStore(): PrefStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readPrefsMap(store: PrefStore | null): Record<string, LayingPrefs> {
  if (!store) return {};
  try {
    const v = JSON.parse(store.getItem(PREFS_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, LayingPrefs>) : {};
  } catch {
    return {};
  }
}

/** Zuletzt gewählter Abschnitt und Reihenfolge dieses Projekts (in diesem Browser) */
export function readLayingPrefs(projectId: string, store: PrefStore | null = defaultStore()): LayingPrefs {
  const v = readPrefsMap(store)[projectId];
  return {
    section: v && typeof v.section === 'string' ? v.section : null,
    order: v && v.order === 'color' ? 'color' : 'serpentine',
  };
}

export function writeLayingPrefs(projectId: string, prefs: LayingPrefs, store: PrefStore | null = defaultStore()): void {
  if (!store) return;
  try {
    const m = readPrefsMap(store);
    delete m[projectId];
    m[projectId] = { section: prefs.section, order: prefs.order };
    const keys = Object.keys(m);
    for (const k of keys.slice(0, Math.max(0, keys.length - PREFS_MAX))) delete m[k];
    store.setItem(PREFS_KEY, JSON.stringify(m));
  } catch {
    /* Speicher gesperrt oder voll: nur Komfort */
  }
}
