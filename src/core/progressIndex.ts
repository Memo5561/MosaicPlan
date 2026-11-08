/**
 * Verlegefortschritt als Zähler (Paket w4-progress-engine): verlegte und vorhandene Steine je Abschnitt und gesamt,
 * ohne bei jedem Antippen das ganze Raster neu zu zählen.
 *
 * - buildProgressIndex zählt einmal über alle Zellen (nach Berechnen, Laden, Änderungen an Steinen und Abschnitten).
 * - applyDirty führt die Zähler für die angegebenen Zellen nach: Differenz der verlegten Teile (popcount) zwischen
 *   der gemerkten und der aktuellen Bitmaske – unabhängig davon, ob ein- oder ausgeschaltet wurde. Ändert sich die
 *   Teilezahl einer Zelle (Form geändert), werden auch die Gesamtzahlen nachgeführt.
 * - applyDiff vergleicht ohne Zellenliste alle Masken mit den gemerkten (nur Zahlenvergleich je Zelle).
 *
 * Gezählt wird mit cellPieceCount (die Teilezahl der Steinliste) und nur die Bits der vorhandenen Teile – dieselbe
 * Zählung wie progressOf in stats.ts. Alle Zahlen sind exakt (ganze Zahlen), nichts wird geschätzt.
 */
import type { Layout, SectionGrid } from './layout';
import { cellPieceCount } from './pieces';
import { CellKind, type MosaicData } from './types';

export interface ProgressIndex {
  cols: number;
  rows: number;
  /** Abschnittsspalten (Abschnitt s = sr · scols + sc, wie in SectionGrid.sections) */
  scols: number;
  /** Abschnittsbezeichnungen in der Reihenfolge von SectionGrid.sections */
  secIds: string[];
  /** Abschnittszeile je Rasterzeile */
  secOfRow: Int32Array;
  /** Abschnittsspalte je Rasterspalte */
  secOfCol: Int32Array;
  /** verlegte Steine je Abschnitt */
  placed: Int32Array;
  /** Steine je Abschnitt */
  total: Int32Array;
  /** Summe über alle Abschnitte */
  placedAll: number;
  totalAll: number;
  /** Bitmaske je Zelle beim letzten Abgleich (Kopie von data.progress) */
  masks: Uint16Array;
  /** Teilezahl je Zelle beim letzten Abgleich (cellPieceCount) */
  counts: Uint16Array;
}

/** Bits der vorhandenen Teile (höchstens 16 – die Fortschrittsmaske hat 16 Bit). */
export function pieceMask(n: number): number {
  return n >= 16 ? 0xffff : n <= 0 ? 0 : (1 << n) - 1;
}

/** Gesetzte Bits einer 16-Bit-Maske. */
export function popcount16(v: number): number {
  v = v - ((v >> 1) & 0x5555);
  v = (v & 0x3333) + ((v >> 2) & 0x3333);
  v = (v + (v >> 4)) & 0x0f0f;
  return (v + (v >> 8)) & 0x1f;
}

function secLookup(starts: number[], n: number): Int32Array {
  const out = new Int32Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    while (s + 1 < starts.length && starts[s + 1] <= i) s++;
    out[i] = s;
  }
  return out;
}

/** Zähler aus den Daten in einem Durchgang über alle Zellen. */
export function buildProgressIndex(layout: Pick<Layout, 'cols' | 'rows'>, data: MosaicData, sections: SectionGrid): ProgressIndex {
  const { cols, rows } = layout;
  const n = cols * rows;
  const S = sections.sections.length;
  const secOfRow = secLookup(sections.rowStarts, rows);
  const secOfCol = secLookup(sections.colStarts, cols);
  const placed = new Int32Array(S);
  const total = new Int32Array(S);
  const masks = new Uint16Array(n);
  const counts = new Uint16Array(n);
  const kind = data.kind;
  const prog = data.progress;
  const scols = sections.scols;
  for (let row = 0; row < rows; row++) {
    const base = secOfRow[row] * scols;
    let idx = row * cols;
    for (let col = 0; col < cols; col++, idx++) {
      const s = base + secOfCol[col];
      // ganzer Stein (häufigster Fall) ohne Funktionsaufruf; sonst dieselbe Zählung wie cellPieceCount
      const c = kind[idx] === CellKind.FULL ? 1 : cellPieceCount(data, idx);
      counts[idx] = c;
      total[s] += c;
      const m = prog[idx];
      masks[idx] = m;
      if (m) placed[s] += popcount16(m & pieceMask(c));
    }
  }
  let placedAll = 0;
  let totalAll = 0;
  for (let s = 0; s < S; s++) {
    placedAll += placed[s];
    totalAll += total[s];
  }
  return {
    cols,
    rows,
    scols,
    secIds: sections.sections.map((x) => x.id),
    secOfRow,
    secOfCol,
    placed,
    total,
    placedAll,
    totalAll,
    masks,
    counts,
  };
}

/** Abschnitt (Index in secIds) einer Zelle. */
export function sectionIndexOf(index: ProgressIndex, idx: number): number {
  const row = (idx / index.cols) | 0;
  return index.secOfRow[row] * index.scols + index.secOfCol[idx - row * index.cols];
}

/** Gleicht eine Zelle ab; liefert true, wenn sich etwas geändert hat. */
function syncCell(index: ProgressIndex, data: MosaicData, idx: number): boolean {
  const m = data.progress[idx];
  const kind = data.kind[idx];
  const c = kind === CellKind.FULL ? 1 : cellPieceCount(data, idx);
  const oldC = index.counts[idx];
  const oldM = index.masks[idx];
  if (m === oldM && c === oldC) return false;
  const s = sectionIndexOf(index, idx);
  if (c !== oldC) {
    index.total[s] += c - oldC;
    index.totalAll += c - oldC;
    index.counts[idx] = c;
  }
  const d = popcount16(m & pieceMask(c)) - popcount16(oldM & pieceMask(oldC));
  if (d) {
    index.placed[s] += d;
    index.placedAll += d;
  }
  index.masks[idx] = m;
  return true;
}

/**
 * Führt die Zähler für geänderte Zellen nach (Zellindizes; Doppelte schaden nicht). Die Zellen müssen bereits
 * geändert sein. Liefert die Anzahl tatsächlich geänderter Zellen.
 */
export function applyDirty(index: ProgressIndex, data: MosaicData, cells: Iterable<number>): number {
  const n = index.cols * index.rows;
  let changed = 0;
  for (const idx of cells) {
    if (!(idx >= 0 && idx < n) || idx !== Math.floor(idx)) continue;
    if (syncCell(index, data, idx)) changed++;
  }
  return changed;
}

/**
 * Gleicht alle Fortschrittsmasken mit den gemerkten ab (für Änderungen ohne Zellenliste, z. B. aus dem
 * Steindetail). Nur Zellen mit geänderter Maske werden gezählt; die Teilezahl wird dabei mitgeprüft.
 * Liefert die Anzahl geänderter Zellen.
 */
export function applyDiff(index: ProgressIndex, data: MosaicData): number {
  const prog = data.progress;
  const masks = index.masks;
  const n = Math.min(prog.length, masks.length);
  let changed = 0;
  for (let idx = 0; idx < n; idx++) {
    if (prog[idx] !== masks[idx] && syncCell(index, data, idx)) changed++;
  }
  return changed;
}

export interface ProgressCounts {
  placed: number;
  total: number;
}

/** Fortschritt gesamt und je Abschnitt (Bezeichnung → Zahlen) aus den Zählern. */
export function progressFromIndex(index: ProgressIndex): { total: ProgressCounts; perSection: Map<string, ProgressCounts> } {
  const perSection = new Map<string, ProgressCounts>();
  for (let s = 0; s < index.secIds.length; s++) perSection.set(index.secIds[s], { placed: index.placed[s], total: index.total[s] });
  return { total: { placed: index.placedAll, total: index.totalAll }, perSection };
}

/** Verlegte Steine und Steine insgesamt (ohne Abschnitte), in einem Durchgang – z. B. für ein neues Ergebnis. */
export function countProgress(data: MosaicData): ProgressCounts {
  const n = data.kind.length;
  let placed = 0;
  let total = 0;
  for (let idx = 0; idx < n; idx++) {
    const c = data.kind[idx] === CellKind.FULL ? 1 : cellPieceCount(data, idx);
    total += c;
    const m = data.progress[idx];
    if (m) placed += popcount16(m & pieceMask(c));
  }
  return { placed, total };
}
