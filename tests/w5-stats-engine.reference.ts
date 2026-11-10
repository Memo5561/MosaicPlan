/**
 * EINGEFRORENE Referenz für tests/w5-stats-engine.test.ts – keine Testdatei, wird nur importiert.
 *
 * Das ist computeStats aus src/core/stats.ts im Stand VOR dem Einzeldurchlauf (w5-stats-engine), unverändert
 * übernommen: je Bereich ein eigener Durchlauf, je Stein Textschlüssel (cellGeomKey + Teil + Rohsteinmaß) im
 * CutCache. computeAllStats/computeStats müssen für das ganze Mosaik und jeden Abschnitt exakt dieselben Zahlen
 * liefern (JSON-gleich). Diese Datei NICHT an spätere Änderungen von stats.ts anpassen – sie ist der Maßstab,
 * gegen den der schnelle Durchlauf geprüft wird. Gemeinsam genutzt werden nur die Abschluss-Bausteine
 * (Rohsteingruppen, Reserve, Packungen, Material-Summen), deren Semantik nicht vom Durchlauf abhängt.
 */
import { rectPoly, type Pt, type ShapeType } from '../src/core/geometry';
import { computeLayout, type Layout } from '../src/core/layout';
import { invalidFreeCells } from '../src/core/edits';
import { analyzeCut, cellPieces, cellRect, FREE_PRESET_KINDS, freePreset, LINE_ANGLES, lineOffsets, type CutInfo } from '../src/core/pieces';
import { makeRawSizeFn, materialTotals, packsFor, rawFromSharedCuts, withReserve, type ColorStat, type Range, type SizeStat, type Stats } from '../src/core/stats';
import { CellKind, createEmptyMosaic, type Material, type MosaicData, type PaletteColor } from '../src/core/types';

const isPositive = (v: number) => Number.isFinite(v) && v > 0;

/** Zwischenspeicher wie der frühere CutCache (Textschlüssel). */
export class RefCutCache {
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

function refCellGeomKey(layout: Layout, data: MosaicData, row: number, col: number): string | null {
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
      return null;
  }
}

function refPieceCutInfo(cache: RefCutCache, layout: Layout, data: MosaicData, row: number, col: number, pieceIdx: number, poly: Pt[], raw: { w: number; h: number }): CutInfo {
  const gk = refCellGeomKey(layout, data, row, col);
  if (gk === null) return analyzeCut(poly, raw.w, raw.h);
  return cache.get(`${gk}|${pieceIdx}|${raw.w}x${raw.h}`, () => analyzeCut(poly, raw.w, raw.h));
}

export function refComputeStats(
  layout: Layout,
  data: MosaicData,
  palette: PaletteColor[],
  materials: Material[],
  opts: { reservePct: number; groutDepthMm: number },
  range?: Range,
  cache: RefCutCache = new RefCutCache(),
): Stats {
  const raw = makeRawSizeFn(layout, palette, materials);
  const reservePct = Number.isFinite(opts.reservePct) && opts.reservePct > 0 ? opts.reservePct : 0;
  const rg = range ?? { r0: 0, r1: layout.rows, c0: 0, c1: layout.cols };
  const perColor: ColorStat[] = palette.map((_, i) => {
    const r = raw(i);
    return {
      color: i,
      pieces: 0,
      uncut: 0,
      cut: 0,
      area: 0,
      rawExact: 0,
      raw: 0,
      rawWithReserve: 0,
      rawW: r.w,
      rawH: r.h,
      material: r.material,
      materialMissing: !!r.materialMissing,
      rawAssumedGrid: !!r.rawAssumedGrid,
      placed: 0,
    };
  });
  const shared: (Map<CutInfo, number> | undefined)[] = new Array(palette.length);
  const perShape: Record<ShapeType, number> = { square: 0, rectangle: 0, triangle: 0, rhombus: 0, trapezoid: 0, parallelogram: 0, custom: 0 };
  const perSize = new Map<string, SizeStat>();
  let pieces = 0;
  let placed = 0;
  let stoneArea = 0;
  let cutPieces = 0;
  let notFitting = 0;
  let invalidColorPieces = 0;
  let invalidPieces = 0;

  for (let row = rg.r0; row < rg.r1; row++) {
    for (let col = rg.c0; col < rg.c1; col++) {
      const idx = row * layout.cols + col;
      const ps = cellPieces(layout, data, row, col);
      const prog = data.progress[idx];
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        const cs = perColor[p.color] as ColorStat | undefined;
        const r = raw(p.color);
        const ci = refPieceCutInfo(cache, layout, data, row, col, i, p.poly, r);
        if (ci.invalid) {
          invalidPieces++;
          continue;
        }
        pieces++;
        stoneArea += ci.area;
        const isPlaced = (prog >> i) & 1;
        if (isPlaced) placed++;
        if (ci.needsCut) cutPieces++;
        if (!ci.fits) notFitting++;
        perShape[ci.shape]++;
        const key = `${ci.shape}|${ci.w.toFixed(1)}|${ci.h.toFixed(1)}`;
        const ss = perSize.get(key);
        if (ss) ss.count++;
        else perSize.set(key, { key, shape: ci.shape, w: Math.round(ci.w * 10) / 10, h: Math.round(ci.h * 10) / 10, count: 1 });
        if (!cs) {
          invalidColorPieces++;
          continue;
        }
        cs.pieces++;
        cs.area += ci.area;
        if (isPlaced) cs.placed++;
        if (ci.needsCut) cs.cut++;
        else cs.uncut++;
        const y = ci.yieldPerRaw;
        if (y > 1) {
          let m = shared[p.color];
          if (!m) shared[p.color] = m = new Map();
          m.set(ci, (m.get(ci) ?? 0) + 1);
          cs.rawExact += 1 / y;
        } else {
          cs.raw++;
          cs.rawExact += 1;
        }
      }
    }
  }

  const x0 = layout.colX[rg.c0];
  const y0 = layout.rowY[rg.r0];
  const fw = layout.colX[rg.c1 - 1] + layout.colW[rg.c1 - 1] - x0;
  const fh = layout.rowY[rg.r1 - 1] + layout.rowH[rg.r1 - 1] - y0;
  let rawTotal = 0;
  let rawRes = 0;
  let rawArea = 0;
  let colorStoneArea = 0;
  const missingMaterials: number[] = [];
  for (const cs of perColor) {
    const m = shared[cs.color];
    if (m) cs.raw += rawFromSharedCuts(m);
    cs.rawWithReserve = withReserve(cs.raw, reservePct);
    rawTotal += cs.raw;
    rawRes += cs.rawWithReserve;
    rawArea += cs.raw * cs.rawW * cs.rawH;
    colorStoneArea += cs.area;
    if (cs.materialMissing) missingMaterials.push(cs.color);
    const mat = cs.material;
    if (mat && isPositive(mat.piecesPerPack) && cs.pieces > 0) {
      cs.packs = packsFor(cs.rawWithReserve, mat.piecesPerPack);
      if (isPositive(mat.price)) cs.cost = cs.packs * mat.price;
    }
  }
  const mt = materialTotals(perColor, layout);
  const badFree = data.free.size ? invalidFreeCells(layout, data, rg).length : 0;
  const finishedArea = fw * fh;
  const jointArea = finishedArea - stoneArea;
  const groutMl = (jointArea * opts.groutDepthMm) / 1000;
  const wasteArea = Math.max(0, rawArea - colorStoneArea);
  return {
    gridPositions: (rg.r1 - rg.r0) * (rg.c1 - rg.c0),
    pieces,
    placed,
    finishedW: fw,
    finishedH: fh,
    finishedArea,
    stoneArea,
    jointArea,
    invalidFreeCells: badFree,
    perColor,
    perMaterial: mt.perMaterial,
    perShape,
    perSize: [...perSize.values()].sort((a, b) => b.count - a.count),
    cutPieces,
    uncutPieces: pieces - cutPieces,
    notFitting,
    invalidColorPieces,
    invalidPieces,
    missingMaterials,
    rawTotal,
    rawWithReserveTotal: rawRes,
    rawArea,
    wasteArea,
    wastePct: rawArea > 0 ? (wasteArea / rawArea) * 100 : 0,
    reservePct,
    groutMl,
    groutKg: (groutMl / 1000) * 1.6,
    totalCost: mt.totalCost,
    costComplete: mt.costComplete && invalidColorPieces === 0,
  };
}

/** Die vom Einzeldurchlauf neu hinzugefügten Prüfzähler entfernen (für den JSON-Vergleich mit der Referenz). */
export function withoutNewCounters(s: Stats): Stats {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { overlapCells, thinPieces, thinFreePieces, ...rest } = s;
  return rest as Stats;
}

// ---------------------------------------------------------------- Zufallsmosaike (Tests und Messung)

/** Deterministischer Zufall (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomCase {
  layout: Layout;
  data: MosaicData;
  palette: PaletteColor[];
  materials: Material[];
}

export interface RandomCaseOptions {
  cols: number;
  rows: number;
  tileW?: number;
  tileH?: number;
  joint?: number;
  edgeMode?: 'whole' | 'cut-end' | 'cut-both';
  /** Anteil der nicht ganzen Zellen (0…1) */
  cutShare?: number;
  /** Freiform, Teile ohne Fläche, ungültige Farben, unbekannte Arten einstreuen */
  oddities?: boolean;
  /** nur Kantenschnitte wie aus der Berechnung (keine manuellen mit beliebigem Winkel) – realistisch für Messungen */
  generatorLinesOnly?: boolean;
}

const HEXES = ['#FFFFFF', '#2050C0', '#C02020', '#20A040', '#000000', '#808080', '#F0C040', '#603020'];

/**
 * Zufallsmosaik mit allen Zellarten: ganze Steine, Dreiecke ╲/╱, Kantenschnitte wie aus der Berechnung (15°-Winkel,
 * 0,5-mm-Versätze) und manuell (beliebige Winkel/Versätze, Float32), Kantenschnitt ohne Parameter, Teilsteine 2×2 /
 * 3×3 (auch ohne Farbliste), Freiform (Vorlagen, Überlappungen, entartete Teile), unbekannte Zellarten,
 * ungültige Farbindizes, gesetzte Fortschrittsbits; Randsteine (Kantenschnitt am Rand) und Materialien mit
 * abweichendem Rohsteinmaß, fehlendem Material und Maß 0.
 */
export function randomCase(seed: number, o: RandomCaseOptions): RandomCase {
  const R = rng(seed);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(R() * a.length)];
  const tileW = o.tileW ?? pick([4, 5, 6, 8, 10]);
  const tileH = o.tileH ?? (R() < 0.7 ? tileW : pick([4, 5, 8, 10, 12]));
  const joint = o.joint ?? pick([0.5, 1, 1, 1.5, 2, 3]);
  const edgeMode = o.edgeMode ?? pick(['whole', 'cut-end', 'cut-both'] as const);
  const widthMm = o.cols * tileW + (o.cols - 1) * joint + (edgeMode === 'whole' ? 0 : 1 + R() * tileW);
  const heightMm = o.rows * tileH + (o.rows - 1) * joint + (edgeMode === 'whole' ? 0 : 1 + R() * tileH);
  const layout = computeLayout({ widthMm, heightMm, tileW, tileH, joint, edgeMode, minCutMm: 1 });
  const nPal = 3 + Math.floor(R() * 6);
  const materials: Material[] = [
    mat('m-big', 2 * tileW, 2 * tileH, { piecesPerPack: 100, price: 9.5, stock: 20 }),
    mat('m-odd', tileW * 1.3 + 0.17, tileH * 0.9 + 0.31, { piecesPerPack: 0, price: 0 }),
    mat('m-same', tileW, tileH, { piecesPerPack: 50, price: 3 }),
    mat('m-zero', 0, 0, { piecesPerPack: 10, price: 1 }),
  ];
  const ids = [undefined, 'm-big', 'm-odd', 'm-same', 'm-zero', 'm-gone'];
  const palette: PaletteColor[] = Array.from({ length: nPal }, (_, i) => ({
    code: i + 1,
    name: `F${i + 1}`,
    hex: HEXES[i % HEXES.length],
    lab: [50, 0, 0],
    materialId: i === 0 ? 'm-big' : pick(ids),
  }));
  const data = createEmptyMosaic(layout.cols, layout.rows);
  const cutShare = o.cutShare ?? 0.5;
  const color = () => (o.oddities && R() < 0.01 ? nPal + Math.floor(R() * 3) : Math.floor(R() * nPal));
  for (let row = 0; row < layout.rows; row++)
    for (let col = 0; col < layout.cols; col++) {
      const idx = row * layout.cols + col;
      data.c1[idx] = color();
      data.c2[idx] = color();
      data.progress[idx] = R() < 0.3 ? Math.floor(R() * 0x10000) : 0;
      if (R() >= cutShare) continue;
      const r = cellRect(layout, row, col);
      const x = R();
      if (x < 0.18) data.kind[idx] = CellKind.DIAG_A;
      else if (x < 0.34) data.kind[idx] = CellKind.DIAG_B;
      else if (x < 0.52 || (o.generatorLinesOnly && x < 0.62)) {
        // wie computeMosaic: 15°-Schritte, 0,5-mm-Versätze
        const a = pick(LINE_ANGLES);
        const nx = Math.cos(a);
        const ny = Math.sin(a);
        const offs = lineOffsets(r, nx, ny);
        data.kind[idx] = CellKind.LINE;
        data.line.set(idx, new Float32Array([nx, ny, offs.length ? pick(offs) : 0]));
      } else if (x < 0.62) {
        // manuell: beliebiger Winkel und Versatz (wie setCellKind/lineParams)
        const a = ((R() * 360 - 180) * Math.PI) / 180;
        const ext = (Math.abs(Math.cos(a)) * r.w + Math.abs(Math.sin(a)) * r.h) / 2;
        data.kind[idx] = CellKind.LINE;
        data.line.set(idx, new Float32Array([Math.cos(a), Math.sin(a), (R() * 2 - 1) * ext * 0.9]));
      } else if (x < 0.64) data.kind[idx] = CellKind.LINE; // ohne Parameter → ganzer Stein
      else if (x < 0.88) {
        const k = x < 0.78 ? 2 : 3;
        data.kind[idx] = CellKind.SUB;
        const s = new Uint16Array(k * k);
        for (let i = 0; i < s.length; i++) s[i] = color();
        data.sub.set(idx, s);
      } else if (x < 0.9) data.kind[idx] = CellKind.SUB; // ohne Farbliste → ganzer Stein
      else if (o.oddities && x < 0.96) {
        data.kind[idx] = CellKind.FREE;
        const y = R();
        let polys: Pt[][];
        if (y < 0.15) {
          // zwei überlappende Rechtecke (ältere/importierte Projekte)
          polys = [rectPoly(0, 0, r.w * 0.7, r.h), rectPoly(r.w * 0.3, 0, r.w * 0.7, r.h)];
        } else if (y < 0.2) {
          // entartetes Teil (2 Punkte) neben einem gültigen
          polys = [
            rectPoly(0, 0, r.w / 2, r.h),
            [
              { x: r.w * 0.7, y: 0 },
              { x: r.w * 0.8, y: r.h },
            ],
          ];
        } else polys = freePreset(pick(FREE_PRESET_KINDS), r.w, r.h, joint) ?? [rectPoly(0, 0, r.w, r.h)];
        data.free.set(
          idx,
          polys.map((poly) => ({ poly, color: color() })),
        );
      } else if (o.oddities && x < 0.965) data.kind[idx] = 7; // unbekannte Zellart → ganzer Stein, ungecacht
      else if (o.oddities && x < 0.97) {
        // fehlerhafte Teilstein-Liste (Länge kein Quadrat)
        data.kind[idx] = CellKind.SUB;
        data.sub.set(idx, new Uint16Array([color(), color(), color(), color(), color()]));
      } else data.kind[idx] = R() < 0.5 ? CellKind.DIAG_A : CellKind.DIAG_B;
    }
  return { layout, data, palette, materials };
}

function mat(id: string, w: number, h: number, over: Partial<Material> = {}): Material {
  return {
    id,
    type: 'glass',
    manufacturer: 'Test',
    product: 'Glas',
    colorNumber: id,
    colorName: id,
    hex: '#2050C0',
    lengthMm: h,
    widthMm: w,
    thicknessMm: 4,
    price: 0,
    packageSize: '',
    piecesPerPack: 0,
    ...over,
  };
}
