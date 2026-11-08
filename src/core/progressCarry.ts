/**
 * Verlegefortschritt beim Neuberechnen übernehmen (Paket w4-progress-engine) – nur, wo es nachweislich derselbe
 * Stein ist (Anforderung 18: nie raten).
 *
 * Übernommen wird ausschließlich, wenn das Raster gleich bleibt (gleiche Rastermaße: Breite, Höhe, Steinmaß, Fuge,
 * Randmodus, Mindestschnitt – damit gleiche Spalten, Zeilen und Zellmaße). Dann wird je Zelle verglichen:
 *  - gleiche Zellart (ganzer Stein, Diagonale, Kantenschnitt, k×k, Freiform),
 *  - gleiche Geometrie: Kantenschnitt mit bitgleichen Float32-Parametern, k×k mit gleichem k, Freiform mit exakt
 *    gleichen Polygonen,
 *  - je Teil gleiche Farbe: HEX-Wert UND Material der Palettenfarbe (verglichen werden Palettenfarben, nie Indizes).
 * Ein Teil, das all das erfüllt, ist exakt derselbe Stein: Seine Markierung „verlegt“ bleibt. Jede andere
 * Markierung wird zurückgesetzt und gezählt; die betroffenen Zellen werden gemeldet.
 */
import type { LayoutParams } from './layout';
import { cellPieceCount } from './pieces';
import { pieceMask, popcount16 } from './progressIndex';
import { CellKind, type MosaicData, type PaletteColor } from './types';

/** Ein Stand für den Vergleich: Rastermaße, Daten und die Palette, auf die die Farbindizes zeigen. */
export interface CarrySide {
  lp: LayoutParams;
  data: MosaicData;
  palette: readonly Pick<PaletteColor, 'hex' | 'materialId'>[];
}

export interface CarryOverReport {
  /** 'kept': gleiches Raster – nachweislich gleiche Steine bleiben verlegt; 'layout': Raster geändert – nichts übertragbar */
  status: 'kept' | 'layout';
  /** übernommene verlegte Steine */
  kept: number;
  /** verlegte Steine, deren Markierung zurückgesetzt wurde (Stein hat sich geändert bzw. Raster geändert) */
  reset: number;
  /** Zellindizes (im neuen Raster) mit zurückgesetzten Steinen – die ersten `maxCells` */
  cells: number[];
  /** Anzahl aller Zellen mit zurückgesetzten Steinen */
  cellCount: number;
}

export interface CarryOverResult {
  /** Fortschritt für das neue Raster (neues Array) */
  progress: Uint16Array;
  /** null: im alten Stand war nichts verlegt (nichts zu melden) */
  report: CarryOverReport | null;
}

/** Höchstens so viele betroffene Zellen werden einzeln gemeldet */
export const CARRY_MAX_CELLS = 500;

const LP_FIELDS = ['widthMm', 'heightMm', 'tileW', 'tileH', 'joint', 'edgeMode', 'minCutMm'] as const;

/** Gleiche Rastermaße (feste Feldreihenfolge, unabhängig von der Reihenfolge im gespeicherten Schlüssel). */
export function sameLayoutParams(a: LayoutParams, b: LayoutParams): boolean {
  const pick = (p: LayoutParams) => JSON.stringify(LP_FIELDS.map((f) => (p as unknown as Record<string, unknown>)[f] ?? null));
  return pick(a) === pick(b);
}

/** Farbe von Teil i einer Zelle – in derselben Reihenfolge wie cellPieces. -1: nicht bestimmbar. */
export function pieceColorAt(data: MosaicData, idx: number, i: number): number {
  switch (data.kind[idx]) {
    case CellKind.FULL:
      return i === 0 ? data.c1[idx] : -1;
    case CellKind.DIAG_A:
    case CellKind.DIAG_B:
    case CellKind.LINE:
      return i === 0 ? data.c1[idx] : i === 1 ? data.c2[idx] : -1;
    case CellKind.SUB: {
      const s = data.sub.get(idx);
      return s && i < s.length ? s[i] : -1;
    }
    case CellKind.FREE: {
      const f = data.free.get(idx);
      return f && i < f.length ? f[i].color : -1;
    }
    default:
      return -1;
  }
}

function floatBitsEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let k = 0; k < ua.length; k++) if (ua[k] !== ub[k]) return false;
  return true;
}

/** Gleiche Zellart und exakt gleiche Geometrie (bei gleichem Raster). */
export function sameCellGeometry(a: MosaicData, b: MosaicData, idx: number): boolean {
  const k = a.kind[idx];
  if (k !== b.kind[idx]) return false;
  switch (k) {
    case CellKind.FULL:
    case CellKind.DIAG_A:
    case CellKind.DIAG_B:
      return true;
    case CellKind.LINE: {
      const la = a.line.get(idx);
      const lb = b.line.get(idx);
      // ohne Parameter ist die Geometrie nicht belegt → nicht nachweislich gleich
      return !!la && !!lb && la.length === 3 && floatBitsEqual(la, lb);
    }
    case CellKind.SUB: {
      const sa = a.sub.get(idx);
      const sb = b.sub.get(idx);
      return !!sa && !!sb && sa.length === sb.length;
    }
    case CellKind.FREE: {
      const fa = a.free.get(idx);
      const fb = b.free.get(idx);
      if (!fa || !fb || fa.length !== fb.length) return false;
      for (let i = 0; i < fa.length; i++) {
        const pa = fa[i].poly;
        const pb = fb[i].poly;
        if (pa.length !== pb.length) return false;
        for (let j = 0; j < pa.length; j++) if (pa[j].x !== pb[j].x || pa[j].y !== pb[j].y) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

function paletteKeys(palette: CarrySide['palette']): string[] {
  return palette.map((p) => `${String(p.hex).toUpperCase()}|${p.materialId ?? ''}`);
}

/** Verlegte Steine eines Stands (nur Bits vorhandener Teile). */
export function placedCount(data: MosaicData): number {
  let n = 0;
  const prog = data.progress;
  for (let idx = 0; idx < prog.length; idx++) {
    const m = prog[idx];
    if (m) n += popcount16(m & pieceMask(cellPieceCount(data, idx)));
  }
  return n;
}

/**
 * Fortschritt des alten Stands `old` für den neuen Stand `next` (dessen eigener Fortschritt wird nicht verändert).
 * `old` = null (kein lesbarer alter Stand): nichts übernommen, nichts zu melden.
 */
export function carryOverProgress(old: CarrySide | null, next: CarrySide, maxCells = CARRY_MAX_CELLS): CarryOverResult {
  const nd = next.data;
  const n = nd.cols * nd.rows;
  const progress = new Uint16Array(n);
  if (!old) return { progress, report: null };
  const od = old.data;
  const laidBefore = placedCount(od);
  if (laidBefore === 0) return { progress, report: null };
  if (!sameLayoutParams(old.lp, next.lp) || od.cols !== nd.cols || od.rows !== nd.rows || od.progress.length !== n) {
    return { progress, report: { status: 'layout', kept: 0, reset: laidBefore, cells: [], cellCount: 0 } };
  }
  const ok = paletteKeys(old.palette);
  const nk = paletteKeys(next.palette);
  let kept = 0;
  let reset = 0;
  let cellCount = 0;
  const cells: number[] = [];
  const op = od.progress;
  for (let idx = 0; idx < n; idx++) {
    const raw = op[idx];
    if (!raw) continue;
    const m = raw & pieceMask(cellPieceCount(od, idx));
    if (!m) continue;
    let keep = 0;
    if (sameCellGeometry(od, nd, idx)) {
      const pieces = cellPieceCount(nd, idx);
      for (let i = 0; i < pieces && i < 16; i++) {
        if (!((m >> i) & 1)) continue;
        const a = pieceColorAt(od, idx, i);
        const b = pieceColorAt(nd, idx, i);
        const ka = a >= 0 ? ok[a] : undefined;
        const kb = b >= 0 ? nk[b] : undefined;
        if (ka !== undefined && ka === kb) keep |= 1 << i;
      }
    }
    const lost = m & ~keep;
    if (keep) {
      progress[idx] = keep;
      kept += popcount16(keep);
    }
    if (lost) {
      reset += popcount16(lost);
      cellCount++;
      if (cells.length < maxCells) cells.push(idx);
    }
  }
  return { progress, report: { status: 'kept', kept, reset, cells, cellCount } };
}
