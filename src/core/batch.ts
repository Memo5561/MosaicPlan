/**
 * Bereichsbearbeitung (Paket w6-compare-batch): Farbe A → B, Heller/Dunkler und „Form zurücksetzen“ für einen
 * Zellbereich (Rechteck, Abschnitt oder ganzes Mosaik). Reiner TypeScript-Kern ohne DOM.
 *
 * Ablauf in der Oberfläche: erst planen (Probelauf – zählt exakt, ändert nichts), dann genau die geplanten Zellen
 * über api.editCells ändern. So ist jede Aktion EIN Verlaufseintrag (Rückgängig/Wiederholen) und der Eintrag enthält
 * nur die Zellen, die sich wirklich ändern können.
 *
 * Regeln:
 *  - Steine werden über die Rasterzellen → Teilstücke gezählt, in derselben Reihenfolge und mit denselben Farben wie
 *    cellPieces (pieces.ts) – ohne die Geometrie zu bauen. tests/w6-compare-batch.test.ts vergleicht das mit
 *    cellPieces und replaceColor (edits.ts).
 *  - Heller/Dunkler nimmt nur vorhandene Palettenfarben (shadeStep, gleicher Farbton wie im Steindetail ▲/▼, Welle 5).
 *    Gibt es keine, bleiben die Steine unverändert und werden gezählt – nie wird eine Farbe erfunden.
 *  - Alle Farben werden gleichzeitig umgesetzt (09 → 05 und 05 → 02 macht aus einem 09 nie ein 02).
 *  - Stückzahlen, Flächen und Statistik werden hier nie geändert oder geschätzt: nach dem Anwenden rechnet die
 *    Statistik wie nach jeder Bearbeitung neu.
 */
import type { DeltaEFormula } from './color';
import { setCellKind, setPieceColor, shadeStep, type ShadeCandidate } from './edits';
import { JOURNAL_MAX_BYTES } from './journal';
import type { Layout } from './layout';
import type { Range } from './stats';
import { CellKind, type MosaicData, type PaletteColor } from './types';

/** Bereich auf das Raster begrenzt (ganze Zahlen, halboffen); ohne Angabe das ganze Raster. */
export function clampRange(data: Pick<MosaicData, 'cols' | 'rows'>, rg?: Range | null): Range {
  if (!rg) return { r0: 0, r1: data.rows, c0: 0, c1: data.cols };
  const cl = (v: number, max: number) => Math.max(0, Math.min(max, Math.floor(v)));
  const r0 = cl(rg.r0, data.rows);
  const c0 = cl(rg.c0, data.cols);
  return {
    r0,
    r1: Math.max(r0, cl(rg.r1, data.rows)),
    c0,
    c1: Math.max(c0, cl(rg.c1, data.cols)),
  };
}

/** Anzahl Zellen im Bereich */
export function rangeCells(rg: Range): number {
  return Math.max(0, rg.r1 - rg.r0) * Math.max(0, rg.c1 - rg.c0);
}

/**
 * Farben der Teilstücke einer Zelle – dieselben Teilstücke in derselben Reihenfolge wie cellPieces, ohne Geometrie.
 * Ruft fn(teil, farbe) je Teilstück auf und liefert die Anzahl.
 */
export function forEachPieceColor(data: MosaicData, idx: number, fn: (piece: number, color: number) => void): number {
  switch (data.kind[idx]) {
    case CellKind.DIAG_A:
    case CellKind.DIAG_B:
      fn(0, data.c1[idx]);
      fn(1, data.c2[idx]);
      return 2;
    case CellKind.LINE:
      fn(0, data.c1[idx]);
      if (!data.line.get(idx)) return 1;
      fn(1, data.c2[idx]);
      return 2;
    case CellKind.SUB: {
      const s = data.sub.get(idx);
      if (!s) {
        fn(0, data.c1[idx]);
        return 1;
      }
      for (let q = 0; q < s.length; q++) fn(q, s[q]);
      return s.length;
    }
    case CellKind.FREE: {
      const f = data.free.get(idx);
      if (!f) return 0;
      for (let q = 0; q < f.length; q++) fn(q, f[q].color);
      return f.length;
    }
    default:
      fn(0, data.c1[idx]);
      return 1;
  }
}

/** Steine je Farbe im Bereich (exakt gezählt). */
export interface ColorCensus {
  /** Zellen im Bereich */
  cells: number;
  /** Steine (Teilstücke) im Bereich */
  pieces: number;
  /** Steine je Palettenindex (Länge = Palette; Farbindizes außerhalb der Palette zählen in `outside`) */
  perColor: Uint32Array;
  outside: number;
}

export function colorCensus(data: MosaicData, paletteSize: number, rg?: Range | null): ColorCensus {
  const r = clampRange(data, rg);
  const per = new Uint32Array(Math.max(0, paletteSize));
  let pieces = 0;
  let outside = 0;
  const cols = data.cols;
  const visit = (_q: number, c: number) => {
    if (c < per.length) per[c]++;
    else outside++;
  };
  for (let row = r.r0; row < r.r1; row++) for (let col = r.c0; col < r.c1; col++) pieces += forEachPieceColor(data, row * cols + col, visit);
  return { cells: rangeCells(r), pieces, perColor: per, outside };
}

/** Plan einer Farbänderung: betroffene Zellen (aufsteigend) und Anzahl der Steine, die sich ändern. */
export interface ColorPlan {
  cells: Uint32Array;
  pieces: number;
}

/** Zellen im Bereich, die mindestens ein Teilstück mit einer Farbe aus `match` haben (match[farbe] = true). */
function planByColors(data: MosaicData, rg: Range | null | undefined, match: (color: number) => boolean): ColorPlan {
  const r = clampRange(data, rg);
  const cells: number[] = [];
  let pieces = 0;
  const cols = data.cols;
  let hit = 0;
  const visit = (_q: number, c: number) => {
    if (match(c)) hit++;
  };
  for (let row = r.r0; row < r.r1; row++)
    for (let col = r.c0; col < r.c1; col++) {
      hit = 0;
      const idx = row * cols + col;
      forEachPieceColor(data, idx, visit);
      if (hit) {
        cells.push(idx);
        pieces += hit;
      }
    }
  return { cells: Uint32Array.from(cells), pieces };
}

/**
 * Probelauf „Farbe A → B“: welche Steine im Bereich würden umgefärbt? Gleich A und B: nichts zu tun (0 Steine).
 * Genau die Zahl, die applyReplace (bzw. replaceColor im selben Bereich) liefert.
 */
export function planReplace(data: MosaicData, rg: Range | null | undefined, from: number, to: number): ColorPlan {
  if (from === to) return { cells: new Uint32Array(0), pieces: 0 };
  return planByColors(data, rg, (c) => c === from);
}

/** Ersetzt Farbe `from` durch `to` in den Zellen `cells` (wie replaceColor). Liefert die Anzahl umgefärbter Steine. */
export function applyReplace(data: MosaicData, cells: ArrayLike<number>, from: number, to: number): number {
  if (from === to) return 0;
  const map = new Int32Array(Math.max(from, to) + 1).fill(-1);
  map[from] = to;
  return applyColorMap(data, cells, map);
}

/**
 * Setzt in den Zellen jede Farbe c mit map[c] ≥ 0 auf map[c] – alle gleichzeitig (gelesen wird die Farbe vor der
 * Änderung). Liefert die Anzahl geänderter Steine.
 */
export function applyColorMap(data: MosaicData, cells: ArrayLike<number>, map: Int32Array): number {
  let n = 0;
  const todo: [number, number][] = [];
  for (let k = 0; k < cells.length; k++) {
    const idx = cells[k];
    todo.length = 0;
    forEachPieceColor(data, idx, (q, c) => {
      const to = c < map.length ? map[c] : -1;
      if (to >= 0 && to !== c) todo.push([q, to]);
    });
    for (const [q, to] of todo) setPieceColor(data, idx, q, to);
    n += todo.length;
  }
  return n;
}

/** Eine Zeile der Zuordnung „Heller/Dunkler“: Ausgangsfarbe, Anzahl Steine im Bereich, Zielfarbe (oder keine). */
export interface ShadeRow {
  from: number;
  pieces: number;
  /** null: keine hellere/dunklere Palettenfarbe gleichen Farbtons – diese Steine bleiben unverändert */
  to: ShadeCandidate | null;
}

export interface ShadePlan extends ColorPlan {
  dir: 'lighter' | 'darker';
  /** je Farbe, die im Bereich vorkommt (aufsteigender Palettenindex) */
  rows: ShadeRow[];
  /** map[farbe] = Zielfarbe oder −1 */
  map: Int32Array;
  /** Steine, die sich ändern bzw. mangels passender Farbe unverändert bleiben (Summe = Steine im Bereich) */
  matched: number;
  unmatched: number;
}

/**
 * Probelauf „Heller“/„Dunkler“ für einen Bereich: je Farbe im Bereich die nächste hellere bzw. dunklere Palettenfarbe
 * gleichen Farbtons (shadeStep – dieselbe Regel wie im Steindetail). Farben ohne passende Palettenfarbe (und
 * Farbindizes außerhalb der Palette) werden gezählt und nicht geändert.
 */
export function planShade(palette: readonly PaletteColor[], data: MosaicData, rg: Range | null | undefined, dir: 'lighter' | 'darker', formula: DeltaEFormula): ShadePlan {
  const census = colorCensus(data, palette.length, rg);
  const map = new Int32Array(palette.length).fill(-1);
  const rows: ShadeRow[] = [];
  let matched = 0;
  let unmatched = census.outside;
  for (let c = 0; c < palette.length; c++) {
    const pieces = census.perColor[c];
    if (!pieces) continue;
    const to = shadeStep(palette, c, dir, formula);
    rows.push({ from: c, pieces, to });
    if (to) {
      map[c] = to.index;
      matched += pieces;
    } else unmatched += pieces;
  }
  const plan = matched ? planByColors(data, rg, (c) => c < map.length && map[c] >= 0) : { cells: new Uint32Array(0), pieces: 0 };
  return { ...plan, dir, rows, map, matched, unmatched };
}

/** Plan „Form zurücksetzen (ganzer Stein)“ */
export interface ShapeResetPlan {
  /** Zellen, die nicht schon ganze Steine sind (aufsteigend) */
  cells: Uint32Array;
  /** Steine in diesen Zellen vorher (nachher ist es je Zelle genau einer) */
  piecesBefore: number;
  /** davon als verlegt markiert – ihr Verlegestatus wird beim Zurücksetzen gelöscht (Rückgängig stellt ihn her) */
  laid: number;
  /** Freiformzellen darunter (von Hand gezeichnet) */
  freeCells: number;
}

const popcount16 = (v: number) => {
  let n = 0;
  for (let x = v & 0xffff; x; x &= x - 1) n++;
  return n;
};

export function planShapeReset(data: MosaicData, rg?: Range | null): ShapeResetPlan {
  const r = clampRange(data, rg);
  const cells: number[] = [];
  let piecesBefore = 0;
  let laid = 0;
  let freeCells = 0;
  const cols = data.cols;
  const none = () => {};
  for (let row = r.r0; row < r.r1; row++)
    for (let col = r.c0; col < r.c1; col++) {
      const idx = row * cols + col;
      if (data.kind[idx] === CellKind.FULL) continue;
      cells.push(idx);
      const n = forEachPieceColor(data, idx, none);
      piecesBefore += n;
      // nur Bits vorhandener Teilstücke zählen (wie der Verlegefortschritt)
      laid += popcount16(data.progress[idx] & ((1 << Math.min(16, n)) - 1));
      if (data.kind[idx] === CellKind.FREE) freeCells++;
    }
  return { cells: Uint32Array.from(cells), piecesBefore, laid, freeCells };
}

/** Setzt die Zellen auf ganze Steine (setCellKind FULL: Farbe des ersten Teils, Verlegestatus gelöscht). */
export function applyShapeReset(layout: Layout, data: MosaicData, cells: ArrayLike<number>, minPieceMm: number): number {
  let n = 0;
  for (let k = 0; k < cells.length; k++) {
    const idx = cells[k];
    if (data.kind[idx] === CellKind.FULL) continue;
    const row = Math.floor(idx / layout.cols);
    const col = idx - row * layout.cols;
    if (setCellKind(layout, data, row, col, { kind: CellKind.FULL }, minPieceMm) === null && data.kind[idx] === CellKind.FULL) n++;
  }
  return n;
}

/**
 * Obergrenze des Speicherbedarfs eines Verlaufseintrags für diese Zellen (wie journal.ts: Zellindex, Zustand vorher
 * und nachher samt Unterteilung/Schnitt/Freiform). Über JOURNAL_MAX_BYTES wäre die Aktion nicht rückgängig zu machen.
 */
export function journalBytesUpperBound(data: MosaicData, cells: ArrayLike<number>): number {
  let b = 128 + cells.length * (4 + 2 * 7);
  for (let k = 0; k < cells.length; k++) {
    const idx = cells[k];
    const s = data.sub.get(idx);
    if (s) b += 2 * (s.byteLength + 48);
    const l = data.line.get(idx);
    if (l) b += 2 * (l.byteLength + 48);
    const f = data.free.get(idx);
    if (f) for (const p of f) b += 2 * (48 + p.poly.length * 32);
    // Form zurücksetzen: nachher eine Teilung weniger, vorher wie gezählt – die Obergrenze bleibt gültig
  }
  return b;
}

/** Passt ein Verlaufseintrag für diese Zellen sicher in den Verlauf (Rückgängig möglich)? */
export function fitsJournal(data: MosaicData, cells: ArrayLike<number>): boolean {
  return journalBytesUpperBound(data, cells) <= JOURNAL_MAX_BYTES;
}
