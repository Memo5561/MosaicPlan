/**
 * Stückzahlen, Flächen und Materialbedarf. Jeder Stein wird genau einmal
 * gezählt (Iteration über Rasterzellen → Teilstücke).
 */
import type { Pt, ShapeType } from './geometry';
import type { Layout } from './layout';
import { analyzeCut, cellPieces, type CutInfo } from './pieces';
import { CellKind, type Material, type MosaicData, type PaletteColor } from './types';

export interface ColorStat {
  color: number;
  pieces: number;
  uncut: number;
  cut: number;
  /** Summe der Steinflächen in mm² */
  area: number;
  /** benötigte Rohsteine (exakt, aus Ausbeute je Schnittart) */
  rawExact: number;
  raw: number;
  rawWithReserve: number;
  rawW: number;
  rawH: number;
  material?: Material;
  packs?: number;
  cost?: number;
  placed: number;
}

export interface SizeStat {
  key: string;
  shape: ShapeType;
  w: number;
  h: number;
  count: number;
}

export interface Stats {
  gridPositions: number;
  pieces: number;
  placed: number;
  finishedW: number;
  finishedH: number;
  finishedArea: number;
  stoneArea: number;
  jointArea: number;
  perColor: ColorStat[];
  perShape: Record<ShapeType, number>;
  perSize: SizeStat[];
  cutPieces: number;
  uncutPieces: number;
  notFitting: number;
  rawTotal: number;
  rawWithReserveTotal: number;
  rawArea: number;
  wasteArea: number;
  wastePct: number;
  reservePct: number;
  groutMl: number;
  groutKg: number;
  totalCost: number;
  costComplete: boolean;
}

export interface Range {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export type RawSizeFn = (color: number) => { w: number; h: number; material?: Material };

export function makeRawSizeFn(layout: Layout, palette: PaletteColor[], materials: Material[]): RawSizeFn {
  const byId = new Map(materials.map((m) => [m.id, m]));
  const cache = palette.map((p) => {
    const m = p.materialId ? byId.get(p.materialId) : undefined;
    if (m && m.lengthMm > 0 && m.widthMm > 0) return { w: m.widthMm, h: m.lengthMm, material: m };
    return { w: layout.tileW, h: layout.tileH, material: m };
  });
  return (c: number) => cache[c] ?? { w: layout.tileW, h: layout.tileH };
}

/** Zwischenspeicher für Schnittanalysen gleicher Geometrie. */
export class CutCache {
  private readonly map = new Map<string, CutInfo>();
  get(key: string, compute: () => CutInfo): CutInfo {
    let v = this.map.get(key);
    if (!v) {
      v = compute();
      if (this.map.size > 200_000) this.map.clear();
      this.map.set(key, v);
    }
    return v;
  }
}

/** Geometrie-Schlüssel einer Zelle (ohne Farben), damit gleiche Formen nur einmal analysiert werden. */
export function cellGeomKey(layout: Layout, data: MosaicData, row: number, col: number): string | null {
  const idx = row * layout.cols + col;
  const kind = data.kind[idx];
  const cw = layout.colW[col].toFixed(4);
  const ch = layout.rowH[row].toFixed(4);
  switch (kind) {
    case CellKind.FULL:
    case CellKind.DIAG_A:
    case CellKind.DIAG_B:
      return `${kind}|${cw}|${ch}`;
    case CellKind.LINE: {
      const p = data.line.get(idx);
      return p ? `${kind}|${cw}|${ch}|${p[0].toFixed(5)}|${p[1].toFixed(5)}|${p[2].toFixed(3)}` : `0|${cw}|${ch}`;
    }
    case CellKind.SUB:
      return `${kind}|${cw}|${ch}|${data.sub.get(idx)?.length ?? 1}`;
    default:
      return null; // Freiform: immer individuell
  }
}

export function pieceCutInfo(
  cache: CutCache,
  layout: Layout,
  data: MosaicData,
  row: number,
  col: number,
  pieceIdx: number,
  poly: Pt[],
  raw: { w: number; h: number },
): CutInfo {
  const gk = cellGeomKey(layout, data, row, col);
  if (gk === null) return analyzeCut(poly, raw.w, raw.h);
  return cache.get(`${gk}|${pieceIdx}|${raw.w}x${raw.h}`, () => analyzeCut(poly, raw.w, raw.h));
}

export function popcount(v: number): number {
  v = v - ((v >> 1) & 0x5555);
  v = (v & 0x3333) + ((v >> 2) & 0x3333);
  v = (v + (v >> 4)) & 0x0f0f;
  return (v + (v >> 8)) & 0x1f;
}

export function computeStats(
  layout: Layout,
  data: MosaicData,
  palette: PaletteColor[],
  materials: Material[],
  opts: { reservePct: number; groutDepthMm: number },
  range?: Range,
  cache: CutCache = new CutCache(),
): Stats {
  const raw = makeRawSizeFn(layout, palette, materials);
  const rg = range ?? { r0: 0, r1: layout.rows, c0: 0, c1: layout.cols };
  const perColor: ColorStat[] = palette.map((_, i) => {
    const r = raw(i);
    return { color: i, pieces: 0, uncut: 0, cut: 0, area: 0, rawExact: 0, raw: 0, rawWithReserve: 0, rawW: r.w, rawH: r.h, material: r.material, placed: 0 };
  });
  const perShape: Record<ShapeType, number> = { square: 0, rectangle: 0, triangle: 0, rhombus: 0, trapezoid: 0, parallelogram: 0, custom: 0 };
  const perSize = new Map<string, SizeStat>();
  let pieces = 0;
  let placed = 0;
  let stoneArea = 0;
  let cutPieces = 0;
  let notFitting = 0;
  let rawArea = 0;

  for (let row = rg.r0; row < rg.r1; row++) {
    for (let col = rg.c0; col < rg.c1; col++) {
      const idx = row * layout.cols + col;
      const ps = cellPieces(layout, data, row, col);
      const prog = data.progress[idx];
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        const cs = perColor[p.color];
        if (!cs) continue;
        const r = raw(p.color);
        const ci = pieceCutInfo(cache, layout, data, row, col, i, p.poly, r);
        pieces++;
        cs.pieces++;
        cs.area += ci.area;
        stoneArea += ci.area;
        const isPlaced = (prog >> i) & 1;
        if (isPlaced) {
          placed++;
          cs.placed++;
        }
        if (ci.needsCut) {
          cs.cut++;
          cutPieces++;
        } else cs.uncut++;
        if (!ci.fits) notFitting++;
        const y = ci.yieldPerRaw > 0 ? 1 / ci.yieldPerRaw : 1;
        cs.rawExact += y;
        rawArea += y * r.w * r.h;
        perShape[ci.shape]++;
        const key = `${ci.shape}|${ci.w.toFixed(1)}|${ci.h.toFixed(1)}`;
        const ss = perSize.get(key);
        if (ss) ss.count++;
        else perSize.set(key, { key, shape: ci.shape, w: Math.round(ci.w * 10) / 10, h: Math.round(ci.h * 10) / 10, count: 1 });
      }
    }
  }

  const x0 = layout.colX[rg.c0];
  const y0 = layout.rowY[rg.r0];
  const fw = layout.colX[rg.c1 - 1] + layout.colW[rg.c1 - 1] - x0;
  const fh = layout.rowY[rg.r1 - 1] + layout.rowH[rg.r1 - 1] - y0;
  let rawTotal = 0;
  let rawRes = 0;
  let totalCost = 0;
  let costComplete = true;
  for (const cs of perColor) {
    cs.raw = Math.ceil(cs.rawExact - 1e-9);
    cs.rawWithReserve = Math.ceil(cs.rawExact * (1 + opts.reservePct / 100) - 1e-9);
    rawTotal += cs.raw;
    rawRes += cs.rawWithReserve;
    if (cs.material && cs.material.piecesPerPack > 0 && cs.pieces > 0) {
      cs.packs = Math.ceil(cs.rawWithReserve / cs.material.piecesPerPack);
      cs.cost = cs.packs * (cs.material.price || 0);
      totalCost += cs.cost;
      if (!cs.material.price) costComplete = false;
    } else if (cs.pieces > 0) costComplete = false;
  }
  const finishedArea = fw * fh;
  const jointArea = finishedArea - stoneArea;
  const groutMl = (jointArea * opts.groutDepthMm) / 1000;
  return {
    gridPositions: (rg.r1 - rg.r0) * (rg.c1 - rg.c0),
    pieces,
    placed,
    finishedW: fw,
    finishedH: fh,
    finishedArea,
    stoneArea,
    jointArea,
    perColor,
    perShape,
    perSize: [...perSize.values()].sort((a, b) => b.count - a.count),
    cutPieces,
    uncutPieces: pieces - cutPieces,
    notFitting,
    rawTotal,
    rawWithReserveTotal: rawRes,
    rawArea,
    wasteArea: Math.max(0, rawArea - stoneArea),
    wastePct: rawArea > 0 ? (Math.max(0, rawArea - stoneArea) / rawArea) * 100 : 0,
    reservePct: opts.reservePct,
    groutMl,
    // Fugenmörtel ≈ 1,6 kg pro Liter Fugenvolumen (Schätzwert)
    groutKg: (groutMl / 1000) * 1.6,
    totalCost,
    costComplete,
  };
}

/** Verlegefortschritt eines Bereichs (schnell, ohne Geometrie). */
export function progressOf(layout: Layout, data: MosaicData, range?: Range): { placed: number; total: number } {
  const rg = range ?? { r0: 0, r1: layout.rows, c0: 0, c1: layout.cols };
  let placed = 0;
  let total = 0;
  for (let row = rg.r0; row < rg.r1; row++) {
    for (let col = rg.c0; col < rg.c1; col++) {
      const idx = row * layout.cols + col;
      const n = pieceCountFast(data, idx);
      total += n;
      placed += popcount(data.progress[idx] & ((1 << n) - 1));
    }
  }
  return { placed, total };
}

function pieceCountFast(data: MosaicData, idx: number): number {
  const k = data.kind[idx];
  if (k === CellKind.FULL) return 1;
  if (k === CellKind.SUB) return data.sub.get(idx)?.length ?? 1;
  if (k === CellKind.FREE) return data.free.get(idx)?.length ?? 0;
  return 2;
}

