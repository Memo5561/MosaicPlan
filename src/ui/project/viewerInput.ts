/**
 * Reine Regeln für Malen, Rechteck-Auswahl und Bereichsfokus im Mosaik-Viewer (ohne DOM, getestet in
 * tests/w3-viewer-features.test.ts). Alle Treffer kommen aus der exakten Steingeometrie (cellPieces):
 * Ein Punkt in der Fuge trifft keinen Stein, Teilstücke werden einzeln getroffen.
 */
import { pointInPolygon } from '../../core/geometry';
import { indexAt, type Layout } from '../../core/layout';
import { cellPieceCount, cellPieces } from '../../core/pieces';
import type { Range } from '../../core/stats';
import type { MosaicData } from '../../core/types';

/** Ein einzelner Stein: Zellindex (row·cols + col) und Teilstück */
export interface PieceRef {
  idx: number;
  piece: number;
}

export interface PieceHit extends PieceRef {
  row: number;
  col: number;
}

/** Liegt die Zelle im Bereich (halboffen wie setRangePlaced: r0 ≤ row < r1, c0 ≤ col < c1)? Ohne Bereich immer. */
export function inRange(rg: Range | null | undefined, row: number, col: number): boolean {
  return !rg || (row >= rg.r0 && row < rg.r1 && col >= rg.c0 && col < rg.c1);
}

/** Stein genau unter dem Punkt (mm, Projektkoordinaten) – null in der Fuge oder außerhalb des Mosaiks. */
export function pieceAtPoint(layout: Layout, data: MosaicData, xMm: number, yMm: number): PieceHit | null {
  const col = indexAt(layout.colX, layout.colW, xMm, layout.joint);
  const row = indexAt(layout.rowY, layout.rowH, yMm, layout.joint);
  if (col < 0 || row < 0) return null;
  const ps = cellPieces(layout, data, row, col);
  for (let i = 0; i < ps.length; i++) {
    if (pointInPolygon({ x: xMm, y: yMm }, ps[i].poly)) return { idx: row * layout.cols + col, piece: i, row, col };
  }
  return null;
}

/** Nächste Zelle zum Punkt (für das Einrasten des Rechtecks): Fuge → angrenzende Zelle, außerhalb → Randzelle. */
export function cellNearPoint(layout: Layout, xMm: number, yMm: number): { row: number; col: number } {
  const near = (pos: Float64Array, size: Float64Array, n: number, v: number) => {
    if (v <= pos[0]) return 0;
    if (v >= pos[n - 1] + size[n - 1]) return n - 1;
    const i = indexAt(pos, size, v, layout.joint);
    return i < 0 ? 0 : i;
  };
  return { row: near(layout.rowY, layout.rowH, layout.rows, yMm), col: near(layout.colX, layout.colW, layout.cols, xMm) };
}

/** Zellbereich zwischen zwei Zellen (beide eingeschlossen), auf `focus` beschnitten; leer → null. */
export function rectRange(a: { row: number; col: number }, b: { row: number; col: number }, focus?: Range | null): Range | null {
  let r0 = Math.min(a.row, b.row);
  let r1 = Math.max(a.row, b.row) + 1;
  let c0 = Math.min(a.col, b.col);
  let c1 = Math.max(a.col, b.col) + 1;
  if (focus) {
    r0 = Math.max(r0, focus.r0);
    r1 = Math.min(r1, focus.r1);
    c0 = Math.max(c0, focus.c0);
    c1 = Math.min(c1, focus.c1);
  }
  return r1 > r0 && c1 > c0 ? { r0, r1, c0, c1 } : null;
}

/** Ist dieses Teilstück als verlegt markiert? */
export function isPieceLaid(data: MosaicData, idx: number, piece: number): boolean {
  return ((data.progress[idx] >> piece) & 1) === 1;
}

/**
 * Anzahl Steine im Bereich (Σ cellPieceCount, exakt wie progressOf/setRangePlaced). Über `maxCells` Zellen wird
 * nicht gezählt (null), damit das Ziehen großer Rechtecke flüssig bleibt.
 */
export function rangePieceCount(layout: Pick<Layout, 'cols'>, data: MosaicData, rg: Range, maxCells = 2_000_000): number | null {
  const cells = (rg.r1 - rg.r0) * (rg.c1 - rg.c0);
  if (!(cells > 0)) return 0;
  if (cells > maxCells) return null;
  let n = 0;
  for (let r = rg.r0; r < rg.r1; r++) for (let c = rg.c0; c < rg.c1; c++) n += cellPieceCount(data, r * layout.cols + c);
  return n;
}

/** Punkte auf der Strecke a→b im Abstand ≤ stepMm (ohne a, mit b) – schnelle Striche überspringen so keinen Stein. */
export function segmentSamples(ax: number, ay: number, bx: number, by: number, stepMm: number): [number, number][] {
  const d = Math.hypot(bx - ax, by - ay);
  const n = Math.max(1, Math.ceil(d / Math.max(1e-6, stepMm)));
  const out: [number, number][] = [];
  for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  return out;
}

/** Abtastschritt beim Malen: ein Sechstel der kleineren Steinseite (auch schmale Teilstücke werden getroffen). */
export function paintStepMm(layout: Pick<Layout, 'tileW' | 'tileH'>): number {
  return Math.max(0.05, Math.min(layout.tileW, layout.tileH) / 6);
}

/**
 * Ein Malstrich: Der erste getroffene Stein bestimmt den Zielzustand (nicht verlegt → „verlegt“ setzen, verlegt →
 * „nicht verlegt“ setzen). Gesammelt werden nur Steine, deren Zustand sich dadurch ändert – jeder genau einmal, in
 * der Reihenfolge der Berührung. Steine außerhalb des Fokusbereichs werden nie aufgenommen. Zweimal über denselben
 * Stein zu fahren macht nichts rückgängig.
 */
export class PaintStroke {
  set: boolean | null = null;
  readonly pieces: PieceRef[] = [];
  private readonly seen = new Set<number>();

  constructor(
    private readonly layout: Layout,
    private readonly data: MosaicData,
    private readonly focus: Range | null = null,
  ) {}

  /** Stein am Punkt aufnehmen; true, wenn er neu dazukam */
  addAt(xMm: number, yMm: number): boolean {
    const hit = pieceAtPoint(this.layout, this.data, xMm, yMm);
    return hit ? this.add(hit) : false;
  }

  add(hit: PieceHit): boolean {
    if (!inRange(this.focus, hit.row, hit.col)) return false;
    const key = hit.idx * 32 + hit.piece;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    const laid = isPieceLaid(this.data, hit.idx, hit.piece);
    if (this.set === null) this.set = !laid;
    if (laid === this.set) return false;
    this.pieces.push({ idx: hit.idx, piece: hit.piece });
    return true;
  }

  /** Alle Steine auf der Strecke a→b aufnehmen; Anzahl der neuen */
  addSegment(ax: number, ay: number, bx: number, by: number): number {
    let n = 0;
    for (const [x, y] of segmentSamples(ax, ay, bx, by, paintStepMm(this.layout))) if (this.addAt(x, y)) n++;
    return n;
  }
}
