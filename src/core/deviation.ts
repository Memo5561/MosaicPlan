/**
 * Abweichung Foto ↔ Stein: ΔE zwischen der Fotofarbe eines Steins (gemessen bei der Berechnung, MosaicData.targets)
 * und seiner AKTUELLEN Farbe (Palettenfarbe von c1/c2/sub). Sie wird bei jedem Aufruf neu gerechnet – ein manuell
 * umgefärbter Stein oder eine geänderte Palettenfarbe zeigt sofort die neue Abweichung. Nichts davon wird geschätzt:
 *
 *  - Ohne Fotoreferenz (Ergebnis null bzw. NaN, Grund siehe TargetState): Freiformsteine ('free'), Zellen, deren Form
 *    seit der Berechnung geändert wurde ('shape' – die gemessene Fotofarbe gehört zu anderen Teilstücken), und Raster
 *    ohne gespeicherte Fotofarben ('legacy', vor dieser Funktion berechnet – eine neue Berechnung ergänzt sie).
 *  - Gemessen wird wie in der Berechnung (mosaic.ts, track()): dieselbe ΔE-Funktion, dieselbe Reihenfolge der
 *    Argumente, dieselbe Fotofarbe, gegen das gespeicherte L*a*b* der Palettenfarbe. Für ein unverändertes Raster
 *    ergibt das exakt die Zahlen der Berechnung: deviationSummary = ComputeDiagnostics (mean/max/p95DeltaE),
 *    deviationByColor = PaletteColor.matchDeltaE (tests/w5-target-colours.test.ts prüft das bitgenau).
 *  - `formula` muss die ΔE-Formel der BERECHNUNG sein (computedDeltaE(rec.computedWith) in
 *    src/ui/project/staleReasons.ts), nicht eine inzwischen geänderte Einstellung.
 *
 * Rein lesend: keine Änderung an Raster, Teilen, Zählungen, Statistik oder PDF.
 */
import { deltaE2000, deltaE76, type DeltaEFormula, type Lab } from './color';
import { pieceId, type Layout } from './layout';
import { cellPieceCount } from './pieces';
import type { Range } from './stats';
import { CellKind, type MatchDeltaE, type MosaicData, type PaletteColor, type PhotoTargets } from './types';

/**
 * Warum ein Stein (k)eine Fotoreferenz hat:
 *  - ok: Fotofarbe vorhanden und gilt für die heutige Form
 *  - legacy: Raster ohne gespeicherte Fotofarben (vor dieser Funktion berechnet) – neu berechnen ergänzt sie
 *  - free: Freiformstein (vom Benutzer gezeichnet, keine Messung)
 *  - shape: Form seit der Berechnung geändert (Zellart, Schnittgerade oder k×k-Teilung)
 */
export type TargetState = 'ok' | 'legacy' | 'free' | 'shape';

/** Warum ein Stein nicht gemessen wurde: keine Fotoreferenz (TargetState) oder Farbindex außerhalb der Palette ('color'). */
export type DeviationGap = Exclude<TargetState, 'ok'> | 'color';

/** Grenzen der festen Legende: unter 2 · 2 bis 5 · über 5 bis 10 · über 10 (wie MatchDeltaE.over5/over10: „über“ = echt größer). */
export const DEVIATION_LEGEND = [2, 5, 10] as const;

/** Klasse eines ΔE in der Legende: 0 = unter 2, 1 = 2 bis 5, 2 = über 5 bis 10, 3 = über 10. */
export function deviationBin(d: number): 0 | 1 | 2 | 3 {
  if (d < DEVIATION_LEGEND[0]) return 0;
  if (d <= DEVIATION_LEGEND[1]) return 1;
  if (d <= DEVIATION_LEGEND[2]) return 2;
  return 3;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

const isSplit = (k: number) => k === CellKind.DIAG_A || k === CellKind.DIAG_B || k === CellKind.LINE;

/** ΔE-Funktion der Formel (dieselbe Implementierung wie in der Berechnung) */
function dEFn(formula: DeltaEFormula) {
  return formula === '76' ? deltaE76 : deltaE2000;
}

// ---------------------------------------------------------------- Lage einer Zelle in den gepackten Feldern

/** Blockgröße des Rangindex (Zweiteiler/k×k-Zellen vor einer Zelle) */
const BLOCK = 256;

interface RankIndex {
  /** je Block: Zweiteiler, k×k-Zellen und k×k-Teilsteine vor dem Block */
  split: Int32Array;
  sub: Int32Array;
  subPieces: Int32Array;
  /** die gepackten Felder passen zur Zellart je Zelle (Längen, nur Zellarten der Berechnung) */
  valid: boolean;
}

/** Ränge einer Zelle: Zweiteiler, k×k-Zellen und k×k-Teilsteine VOR ihr (in Zellreihenfolge) */
interface Rank {
  split: number;
  sub: number;
  subOff: number;
}

const rankCache = new WeakMap<PhotoTargets, RankIndex>();

/** Rangindex der Fotofarben – einmal je Raster gebildet (ein Durchlauf), dabei werden die Feldlängen geprüft. */
function rankIndex(t: PhotoTargets): RankIndex {
  let ix = rankCache.get(t);
  if (ix) return ix;
  const n = t.kind.length;
  const nb = Math.ceil(n / BLOCK);
  ix = { split: new Int32Array(nb), sub: new Int32Array(nb), subPieces: new Int32Array(nb), valid: true };
  let s = 0;
  let u = 0;
  let o = 0;
  for (let i = 0; i < n; i++) {
    if (i % BLOCK === 0) {
      const b = i / BLOCK;
      ix.split[b] = s;
      ix.sub[b] = u;
      ix.subPieces[b] = o;
    }
    const k = t.kind[i];
    if (isSplit(k)) s++;
    else if (k === CellKind.SUB) {
      if (u >= t.subLen.length || t.subLen[u] < 1) ix.valid = false;
      else o += t.subLen[u];
      u++;
    } else if (k !== CellKind.FULL) ix.valid = false;
  }
  if (t.lab2.length !== s * 3 || t.line.length !== s * 3 || t.subLen.length !== u || t.subLab.length !== o * 3) ix.valid = false;
  rankCache.set(t, ix);
  return ix;
}

/**
 * Fotofarben des Rasters – nur, wenn sie zu genau diesem Raster gehören (gleiche Zellenzahl) und in sich stimmig sind.
 * Sonst gilt das Raster als ohne Fotofarben: lieber keine Abweichung als eine falsche.
 */
function targetsOf(data: MosaicData): PhotoTargets | undefined {
  const t = data.targets;
  if (!t || t.kind.length !== data.kind.length || t.lab1.length !== data.kind.length * 3) return undefined;
  return rankIndex(t).valid ? t : undefined;
}

/** Hat das Raster gespeicherte Fotofarben? (false: vor dieser Funktion berechnet – keine Abweichung je Stein bekannt) */
export function hasPhotoTargets(data: MosaicData): boolean {
  return !!targetsOf(data);
}

/** Ränge der Zelle `idx` (höchstens BLOCK Schritte ab dem Blockanfang; der Index entsteht beim ersten Aufruf). */
function locate(t: PhotoTargets, idx: number): Rank {
  const ix = rankIndex(t);
  const b = Math.floor(idx / BLOCK);
  let s = ix.split[b];
  let u = ix.sub[b];
  let o = ix.subPieces[b];
  for (let i = b * BLOCK; i < idx; i++) {
    const k = t.kind[i];
    if (isSplit(k)) s++;
    else if (k === CellKind.SUB) o += t.subLen[u++];
  }
  return { split: s, sub: u, subOff: o };
}

/** Dieselbe Schnittgerade wie bei der Berechnung? (exakter Vergleich der gespeicherten Float32-Werte) */
function sameLine(t: PhotoTargets, split: number, cur: Float32Array | undefined): boolean {
  if (!cur || cur.length !== 3) return false;
  const o = split * 3;
  return cur[0] === t.line[o] && cur[1] === t.line[o + 1] && cur[2] === t.line[o + 2];
}

/** Ränge werden für ganze Steine nicht gebraucht */
const FULL_RANK: Rank = { split: 0, sub: 0, subOff: 0 };

/**
 * Hat die Zelle heute noch die Form der Berechnung? Liefert dann ihre Ränge (ganze Steine: FULL_RANK), sonst null.
 * Freiform ist nie eine Form der Berechnung.
 */
function keptShape(t: PhotoTargets, data: MosaicData, idx: number): Rank | null {
  const k = t.kind[idx];
  if (data.kind[idx] !== k) return null;
  if (k === CellKind.FULL) return FULL_RANK;
  const at = locate(t, idx);
  if (k === CellKind.SUB) return (data.sub.get(idx)?.length ?? -1) === t.subLen[at.sub] ? at : null;
  if (k === CellKind.LINE) return sameLine(t, at.split, data.line.get(idx)) ? at : null;
  return at;
}

const validCell = (data: MosaicData, idx: number) => Number.isInteger(idx) && idx >= 0 && idx < data.kind.length;

/** Hat die Zelle `idx` eine Fotoreferenz – und wenn nicht, warum nicht? */
export function targetState(data: MosaicData, idx: number): TargetState {
  const t = targetsOf(data);
  if (!t) return 'legacy';
  if (data.kind[idx] === CellKind.FREE) return 'free';
  return validCell(data, idx) && keptShape(t, data, idx) ? 'ok' : 'shape';
}

/** Fotofarbe aus dem Speicherraster (identisch zu fromQ in mosaic.ts). */
function labQ(arr: Uint8Array, i: number): Lab {
  return [arr[i * 3] / 2.55, arr[i * 3 + 1] - 128, arr[i * 3 + 2] - 128];
}

/**
 * Fotofarbe (L*a*b*) von Teilstück `piece` der Zelle `idx`, gemessen bei der Berechnung – oder null ohne Fotoreferenz
 * (siehe targetState) bzw. bei einem Teilstück, das es nicht gibt.
 */
export function pieceTarget(data: MosaicData, idx: number, piece: number): Lab | null {
  const t = targetsOf(data);
  if (!t || !validCell(data, idx) || !Number.isInteger(piece) || piece < 0) return null;
  const at = keptShape(t, data, idx);
  if (!at) return null;
  const k = t.kind[idx];
  if (k === CellKind.SUB) {
    if (piece >= t.subLen[at.sub]) return null;
    const o = (at.subOff + piece) * 3;
    return [t.subLab[o], t.subLab[o + 1], t.subLab[o + 2]];
  }
  if (piece === 0) return labQ(t.lab1, idx);
  if (piece === 1 && isSplit(k)) return labQ(t.lab2, at.split);
  return null;
}

/** L*a*b* der Palettenfarbe `c` – null, wenn es die Farbe nicht gibt oder ihr L*a*b* kein gültiger Wert ist. */
function paletteLab(palette: readonly PaletteColor[], c: number): Lab | null {
  const lab = palette[c]?.lab;
  return lab && Number.isFinite(lab[0]) && Number.isFinite(lab[1]) && Number.isFinite(lab[2]) ? lab : null;
}

/** Aktueller Palettenindex von Teilstück `piece` – nur für Zellen mit der Form der Berechnung (FULL, Zweiteiler, k×k). */
function currentColor(data: MosaicData, idx: number, piece: number): number {
  if (data.kind[idx] === CellKind.SUB) return data.sub.get(idx)![piece];
  return piece === 0 ? data.c1[idx] : data.c2[idx];
}

/**
 * ΔE zwischen Fotofarbe und aktueller Farbe von Teilstück `piece` der Zelle `idx` (Formel der Berechnung) – oder null
 * ohne Fotoreferenz bzw. wenn die Farbe nicht in der Palette liegt.
 */
export function deviationForPiece(data: MosaicData, palette: readonly PaletteColor[], idx: number, piece: number, formula: DeltaEFormula): number | null {
  const l = pieceTarget(data, idx, piece);
  if (!l) return null;
  const p = paletteLab(palette, currentColor(data, idx, piece));
  if (!p) return null;
  return dEFn(formula)(l[0], l[1], l[2], p[0], p[1], p[2]);
}

/** Größte Abweichung über die Teilstücke einer Zelle; NaN ohne Fotoreferenz. */
export function deviationForCell(data: MosaicData, palette: readonly PaletteColor[], idx: number, formula: DeltaEFormula): number {
  let max = NaN;
  if (!validCell(data, idx)) return max;
  const n = cellPieceCount(data, idx);
  for (let q = 0; q < n; q++) {
    const d = deviationForPiece(data, palette, idx, q, formula);
    if (d !== null && !(d <= max)) max = d;
  }
  return max;
}

// ---------------------------------------------------------------- Durchlauf über alle Steine

/** Gemessenes Teilstück: Zelle, Teil, Teile der Zelle, Palettenindex, ΔE und die Fotofarbe (ohne Objekt je Stein). */
type PieceVisitor = (idx: number, piece: number, pieces: number, color: number, d: number, tl: number, ta: number, tb: number) => void;
/** `pieces` Teilstücke der Zelle ohne Messung (Grund siehe DeviationGap) */
type GapVisitor = (idx: number, pieces: number, why: DeviationGap) => void;

/** Größe des ΔE-Zwischenspeichers: höchstens 2^CACHE_BITS Einträge (kleine Bereiche: etwa doppelt so viele wie Zellen) */
const CACHE_BITS = 16;

/**
 * Läuft in Zellreihenfolge über alle Teilstücke im Bereich – dieselbe Reihenfolge wie die Zuordnung der Berechnung (Zeile
 * für Zeile, Teilstücke aufsteigend) – und misst jedes mit Fotoreferenz. Die Ränge in den gepackten Feldern laufen dabei
 * mit (der Rangindex wird nur am Zeilenanfang eines Teilbereichs gebraucht).
 *
 * Ganze Steine und Zweiteiler: Das ΔE eines Paars (Fotofarbe auf dem Speicherraster, Palettenfarbe) wird in einem kleinen
 * Zwischenspeicher gehalten – gleiche Paare (Flächen, Verläufe) werden nur einmal gerechnet. Der Zwischenspeicher hält
 * die ungerundeten Werte; das Ergebnis ist dasselbe wie ohne ihn.
 */
function walk(data: MosaicData, palette: readonly PaletteColor[], formula: DeltaEFormula, range: Range | undefined, hit: PieceVisitor, gap: GapVisitor): void {
  const cols = data.cols;
  const r0 = range ? Math.max(0, range.r0) : 0;
  const r1 = range ? Math.min(data.rows, range.r1) : data.rows;
  const c0 = range ? Math.max(0, range.c0) : 0;
  const c1 = range ? Math.min(cols, range.c1) : cols;
  if (c0 >= c1 || r0 >= r1) return;
  const t = targetsOf(data);
  if (!t) {
    for (let row = r0; row < r1; row++) for (let col = c0; col < c1; col++) gap(row * cols + col, cellPieceCount(data, row * cols + col), 'legacy');
    return;
  }
  const f = dEFn(formula);
  const nPal = palette.length;
  // L*a*b* der Palette als flaches Feld (NaN im ersten Wert = Farbe ohne gültiges L*a*b*)
  const pl = new Float64Array(nPal * 3).fill(NaN);
  for (let i = 0; i < nPal; i++) {
    const lab = paletteLab(palette, i);
    if (lab) pl.set(lab, i * 3);
  }
  // direkt abgebildeter Zwischenspeicher: Schlüssel = Palettenindex · 2²⁴ + Fotofarbe (24 Bit), exakt als Float64
  const bits = Math.max(8, Math.min(CACHE_BITS, Math.ceil(Math.log2((r1 - r0) * (c1 - c0))) + 1));
  const shift = 32 - bits;
  const ck = new Float64Array(1 << bits).fill(-1);
  const cv = new Float64Array(1 << bits);
  const onGrid = (arr: Uint8Array, at: number, color: number, idx: number, piece: number, pieces: number) => {
    if (!(color < nPal) || pl[color * 3] !== pl[color * 3]) {
      gap(idx, 1, 'color');
      return;
    }
    const o = at * 3;
    const q0 = arr[o];
    const q1 = arr[o + 1];
    const q2 = arr[o + 2];
    const lab24 = (q0 << 16) | (q1 << 8) | q2;
    const key = color * 16777216 + lab24;
    const h = (Math.imul(lab24, 0x9e3779b1) ^ Math.imul(color + 1, 0x85ebca6b)) >>> shift;
    const tl = q0 / 2.55;
    const ta = q1 - 128;
    const tb = q2 - 128;
    let d: number;
    if (ck[h] === key) d = cv[h];
    else {
      d = f(tl, ta, tb, pl[color * 3], pl[color * 3 + 1], pl[color * 3 + 2]);
      ck[h] = key;
      cv[h] = d;
    }
    hit(idx, piece, pieces, color, d, tl, ta, tb);
  };
  const fullWidth = c0 === 0 && c1 === cols;
  let s = 0;
  let u = 0;
  let o = 0;
  for (let row = r0; row < r1; row++) {
    // über die volle Breite laufen die Ränge einfach weiter, sonst am Zeilenanfang neu bestimmen
    if (!fullWidth || row === r0) {
      const at = locate(t, row * cols + c0);
      s = at.split;
      u = at.sub;
      o = at.subOff;
    }
    for (let col = c0; col < c1; col++) {
      const idx = row * cols + col;
      const tk = t.kind[idx];
      const dk = data.kind[idx];
      if (dk !== tk) gap(idx, cellPieceCount(data, idx), dk === CellKind.FREE ? 'free' : 'shape');
      else if (tk === CellKind.FULL) onGrid(t.lab1, idx, data.c1[idx], idx, 0, 1);
      else if (tk === CellKind.SUB) {
        const sc = data.sub.get(idx);
        const n = t.subLen[u];
        if (!sc || sc.length !== n) gap(idx, cellPieceCount(data, idx), 'shape');
        else
          for (let q = 0; q < n; q++) {
            const color = sc[q];
            if (!(color < nPal) || pl[color * 3] !== pl[color * 3]) {
              gap(idx, 1, 'color');
              continue;
            }
            const a = (o + q) * 3;
            const tl = t.subLab[a];
            const ta = t.subLab[a + 1];
            const tb = t.subLab[a + 2];
            hit(idx, q, n, color, f(tl, ta, tb, pl[color * 3], pl[color * 3 + 1], pl[color * 3 + 2]), tl, ta, tb);
          }
      } else if (tk === CellKind.LINE && !sameLine(t, s, data.line.get(idx))) gap(idx, cellPieceCount(data, idx), 'shape');
      else {
        onGrid(t.lab1, idx, data.c1[idx], idx, 0, 2);
        onGrid(t.lab2, s, data.c2[idx], idx, 1, 2);
      }
      if (isSplit(tk)) s++;
      else if (tk === CellKind.SUB) o += t.subLen[u++];
    }
  }
}

const NO_GAP: GapVisitor = () => {};

function assertSameGrid(fn: string, layout: Pick<Layout, 'cols' | 'rows'>, data: MosaicData): void {
  if (layout.cols !== data.cols || layout.rows !== data.rows) throw new Error(`${fn}: Raster passt nicht zum Layout`);
}

/**
 * Abweichungskarte: je Rasterzelle die größte Abweichung ihrer Teilstücke (Formel der Berechnung), NaN ohne
 * Fotoreferenz (Freiform, geänderte Form, Raster ohne Fotofarben). `layout` muss zum Raster gehören.
 * Einzelne Zellen nach einer Änderung: deviationForCell.
 */
export function deviationMap(layout: Pick<Layout, 'cols' | 'rows'>, data: MosaicData, palette: readonly PaletteColor[], formula: DeltaEFormula): Float32Array {
  assertSameGrid('deviationMap', layout, data);
  const out = new Float32Array(data.cols * data.rows).fill(NaN);
  walk(
    data,
    palette,
    formula,
    undefined,
    (idx, _q, _n, _c, d) => {
      if (!(out[idx] >= d)) out[idx] = d;
    },
    NO_GAP,
  );
  return out;
}

/** Ein Stein mit seiner Abweichung (für die Liste „Größte Abweichungen“). */
export interface PieceDeviation {
  /** Zellindex (Zeile · Spalten + Spalte) */
  idx: number;
  row: number;
  col: number;
  /** Teilstück (ab 0) und Anzahl Teilstücke der Zelle */
  piece: number;
  pieces: number;
  /** Bezeichnung wie A001 bzw. A001-2 */
  id: string;
  /** aktueller Palettenindex */
  color: number;
  /** ΔE (Formel der Berechnung) zwischen Fotofarbe und aktueller Farbe */
  deltaE: number;
  /** Fotofarbe (L*a*b*) */
  target: Lab;
}

interface Ranked {
  d: number;
  idx: number;
  piece: number;
}

/** a kommt vor b: größeres ΔE zuerst, bei Gleichstand Leserichtung (Zelle, dann Teilstück). */
function before(a: Ranked, b: Ranked): boolean {
  return a.d > b.d || (a.d === b.d && (a.idx < b.idx || (a.idx === b.idx && a.piece < b.piece)));
}

/**
 * Die `n` Steine mit der größten Abweichung (absteigend; bei Gleichstand in Leserichtung), optional nur im Bereich
 * `range` (z. B. ein Abschnitt). Steine ohne Fotoreferenz kommen nicht vor.
 */
export function topDeviations(layout: Pick<Layout, 'cols' | 'rows'>, data: MosaicData, palette: readonly PaletteColor[], formula: DeltaEFormula, n: number, range?: Range): PieceDeviation[] {
  assertSameGrid('topDeviations', layout, data);
  const k = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  if (k === 0) return [];
  // Min-Heap der besten k: an der Wurzel der Stein, der als nächster herausfällt
  type E = Ranked & { pieces: number; color: number; target: Lab };
  const heap: E[] = [];
  const worse = (a: E, b: E) => before(b, a);
  const up = (i: number) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!worse(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const down = (i: number) => {
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && worse(heap[l], heap[m])) m = l;
      if (r < heap.length && worse(heap[r], heap[m])) m = r;
      if (m === i) break;
      [heap[i], heap[m]] = [heap[m], heap[i]];
      i = m;
    }
  };
  walk(
    data,
    palette,
    formula,
    range,
    (idx, piece, pieces, color, d, tl, ta, tb) => {
      if (heap.length < k) {
        heap.push({ d, idx, piece, pieces, color, target: [tl, ta, tb] });
        up(heap.length - 1);
        return;
      }
      // Die Steine kommen in Leserichtung: Bei Gleichstand mit dem schwächsten behaltenen Stein bleibt der frühere.
      if (d <= heap[0].d) return;
      heap[0] = { d, idx, piece, pieces, color, target: [tl, ta, tb] };
      down(0);
    },
    NO_GAP,
  );
  heap.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
  return heap.map((e) => {
    const row = Math.floor(e.idx / data.cols);
    const col = e.idx % data.cols;
    return { idx: e.idx, row, col, piece: e.piece, pieces: e.pieces, id: pieceId(layout, row, col, e.piece, e.pieces), color: e.color, deltaE: e.d, target: e.target };
  });
}

/** Zusammenfassung der Abweichungen (exakt gezählt; Mittelwert über alle Steine mit Fotoreferenz). */
export interface DeviationSummary {
  /** alle Steine (Teilstücke) im Bereich */
  pieces: number;
  /** davon mit Fotoreferenz gemessen */
  measured: number;
  /** nicht gemessene Steine nach Grund (siehe DeviationGap) – Summe = pieces − measured */
  missing: Record<DeviationGap, number>;
  /** mittleres und größtes ΔE der gemessenen Steine (0 ohne Messung) */
  mean: number;
  max: number;
  /**
   * 95-%-Wert wie ComputeDiagnostics.p95DeltaE: obere Grenze der ganzzahligen ΔE-Klasse, bis zu der mindestens 95 % der
   * gemessenen Steine liegen (0 ohne Messung).
   */
  p95: number;
  /** gemessene Steine je Klasse der Legende (siehe deviationBin) */
  bins: [number, number, number, number];
  /** gemessene Steine mit ΔE über 5 bzw. über 10 (wie MatchDeltaE) */
  over5: number;
  over10: number;
}

/**
 * Zusammenfassung über alle Steine, optional nur im Bereich `range`. Für ein unverändertes Raster (ohne Bereich) sind
 * mean, max und p95 exakt die Werte der Berechnung (ComputeDiagnostics.meanDeltaE/maxDeltaE/p95DeltaE).
 */
export function deviationSummary(data: MosaicData, palette: readonly PaletteColor[], formula: DeltaEFormula, range?: Range): DeviationSummary {
  const s: DeviationSummary = { pieces: 0, measured: 0, missing: { legacy: 0, free: 0, shape: 0, color: 0 }, mean: 0, max: 0, p95: 0, bins: [0, 0, 0, 0], over5: 0, over10: 0 };
  const hist = new Uint32Array(101);
  let sum = 0;
  walk(
    data,
    palette,
    formula,
    range,
    (_idx, _q, _n, _c, d) => {
      s.pieces++;
      s.measured++;
      sum += d;
      if (d > s.max) s.max = d;
      hist[Math.min(100, Math.floor(d))]++;
      s.bins[deviationBin(d)]++;
      if (d > 5) s.over5++;
      if (d > 10) s.over10++;
    },
    (_idx, pieces, why) => {
      s.pieces += pieces;
      s.missing[why] += pieces;
    },
  );
  if (s.measured) {
    s.mean = sum / s.measured;
    let acc = 0;
    for (let i = 0; i <= 100; i++) {
      acc += hist[i];
      if (acc >= s.measured * 0.95) {
        s.p95 = i + 1;
        break;
      }
    }
  }
  return s;
}

/**
 * Abweichung je Palettenfarbe für den AKTUELLEN Stand (Index wie `palette`): Steine mit Fotoreferenz, die heute diese
 * Farbe haben – Anzahl, mittleres und größtes ΔE (auf 0,01 gerundet), Steine über 5 und über 10. Für ein unverändertes
 * Raster ist das exakt PaletteColor.matchDeltaE der Berechnung; nach manuellen Änderungen der aktuelle Wert dazu.
 * Steine ohne Fotoreferenz zählen nicht mit (`pieces` kann daher kleiner sein als die Stückzahl der Farbe).
 */
export function deviationByColor(data: MosaicData, palette: readonly PaletteColor[], formula: DeltaEFormula): MatchDeltaE[] {
  const n = palette.length;
  const cnt = new Uint32Array(n);
  const sum = new Float64Array(n);
  const max = new Float64Array(n);
  const over5 = new Uint32Array(n);
  const over10 = new Uint32Array(n);
  walk(
    data,
    palette,
    formula,
    undefined,
    (_idx, _q, _n, c, d) => {
      cnt[c]++;
      sum[c] += d;
      if (d > max[c]) max[c] = d;
      if (d > 5) over5[c]++;
      if (d > 10) over10[c]++;
    },
    NO_GAP,
  );
  return palette.map((_, i) => ({ pieces: cnt[i], mean: cnt[i] ? round2(sum[i] / cnt[i]) : 0, max: round2(max[i]), over5: over5[i], over10: over10[i] }));
}

/** Vorschlag einer besser passenden Palettenfarbe für einen Stein (siehe nearestColorForPiece). */
export interface NearestColor {
  /** Palettenindex der Farbe, die der Fotofarbe am nächsten liegt (bei Gleichstand der kleinere Index) */
  index: number;
  /** ihr ΔE zur Fotofarbe */
  deltaE: number;
  /** ΔE der aktuellen Farbe des Steins zur Fotofarbe; null, wenn sie nicht in der Palette liegt */
  current: number | null;
  /** die vorgeschlagene Farbe passt echt besser als die aktuelle (false: die aktuelle ist bereits die nächste) */
  better: boolean;
}

/**
 * Nächste Palettenfarbe zur Fotofarbe eines Steins (Formel der Berechnung, jede Palettenfarbe exakt verglichen) –
 * Vorschlag für eine besser passende Farbe. null ohne Fotoreferenz oder bei leerer Palette.
 * Hinweis: Mit Farbmischung (Dithering) hat die Berechnung absichtlich nicht immer die nächste Farbe gewählt.
 */
export function nearestColorForPiece(data: MosaicData, palette: readonly PaletteColor[], idx: number, piece: number, formula: DeltaEFormula): NearestColor | null {
  const l = pieceTarget(data, idx, piece);
  if (!l) return null;
  const near = nearestPaletteColor(palette, l, formula);
  if (!near) return null;
  const current = deviationForPiece(data, palette, idx, piece, formula);
  return { index: near.index, deltaE: near.deltaE, current, better: current === null || near.deltaE < current };
}

/**
 * Palettenfarbe mit dem kleinsten ΔE (Formel `formula`) zu einer Farbe `lab` – jede Palettenfarbe exakt verglichen, bei
 * Gleichstand der kleinere Index. null bei leerer Palette bzw. ohne gültiges L*a*b*.
 */
export function nearestPaletteColor(palette: readonly PaletteColor[], lab: Lab, formula: DeltaEFormula): { index: number; deltaE: number } | null {
  const f = dEFn(formula);
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = paletteLab(palette, i);
    if (!p) continue;
    const d = f(lab[0], lab[1], lab[2], p[0], p[1], p[2]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best < 0 ? null : { index: best, deltaE: bd };
}

/**
 * Flächengewichtete Fotofarbe einer ganzen Zelle: Mittel (L*a*b*) der Fotofarben ihrer Teilstücke, gewichtet mit den
 * Flächen `areas` (gleiche Reihenfolge wie cellPieces). null, wenn nicht JEDES Teilstück eine Fotoreferenz hat (siehe
 * targetState) oder die Flächen nicht passen.
 */
export function cellPhotoTarget(data: MosaicData, idx: number, areas: readonly number[]): Lab | null {
  if (!areas.length) return null;
  let L = 0;
  let a = 0;
  let b = 0;
  let w = 0;
  for (let q = 0; q < areas.length; q++) {
    const tg = pieceTarget(data, idx, q);
    const A = areas[q];
    if (!tg || !(A > 0)) return null;
    L += tg[0] * A;
    a += tg[1] * A;
    b += tg[2] * A;
    w += A;
  }
  return w > 0 ? [L / w, a / w, b / w] : null;
}
