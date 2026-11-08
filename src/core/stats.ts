/**
 * Stückzahlen, Flächen und Materialbedarf. Jeder Stein wird genau einmal
 * gezählt (Iteration über Rasterzellen → Teilstücke).
 *
 * Rohsteinbedarf (sichere Obergrenze nach dem Ausbeute-Modell aus analyzeCut):
 * Je Farbe werden die Teile nach Schnittform gruppiert – gleiche Form bis auf
 * Drehung um 0/90/180/270° (nicht gespiegelt, Glas hat eine Sichtseite), gleiches
 * Rohsteinmaß und gleiche Ausbeute. Je Gruppe gilt ⌈n / Ausbeute⌉; verschiedene
 * Schnittformen teilen sich keinen Rohstein, Reststücke werden nicht wiederverwendet.
 * Damit ist die Zahl nie zu niedrig; Bruch und Schnittverluste deckt die Reserve.
 *
 * Packungen, Bestand und Kosten werden je Material gezählt (perMaterial), sodass ein
 * Material, das mehreren Farben zugeordnet ist, nicht doppelt gekauft wird.
 */
import type { Pt, ShapeType } from './geometry';
import type { Layout } from './layout';
import { invalidFreeCells } from './edits';
import { analyzeCut, cellPieces, type CutInfo } from './pieces';
import { CellKind, type Material, type MosaicData, type PaletteColor } from './types';

export interface ColorStat {
  color: number;
  pieces: number;
  uncut: number;
  cut: number;
  /** Summe der Steinflächen in mm² */
  area: number;
  /**
   * Untergrenze Σ 1/Ausbeute: so viele Rohsteine wären nötig, wenn sich beliebige
   * Teile einen Rohstein teilen könnten (physikalisch meist nicht möglich).
   */
  rawExact: number;
  /** benötigte Rohsteine: Σ über gleiche Schnittformen (Drehung erlaubt) von ⌈n / Ausbeute⌉ */
  raw: number;
  /** ⌈raw · (1 + Reserve)⌉ */
  rawWithReserve: number;
  rawW: number;
  rawH: number;
  material?: Material;
  /** Material-ID gesetzt, aber das Material fehlt in der Materialdatenbank (gelöscht/nicht importiert) */
  materialMissing: boolean;
  /** Rohsteinmaß = Rastermaß angenommen (kein Material, Material fehlt oder ohne gültiges Maß) */
  rawAssumedGrid: boolean;
  /**
   * Packungen nur für diese Farbe allein. Teilen sich mehrere Farben ein Material,
   * gelten die Packungen je Material in `Stats.perMaterial`.
   */
  packs?: number;
  /** Kosten nur für diese Farbe allein (nur mit Packungsgröße und Preis); Gesamtkosten: perMaterial */
  cost?: number;
  placed: number;
}

/** Bedarf je Material (Einkaufsliste). `materialId === null`: Gruppe „ohne Material“. */
export interface MaterialStat {
  materialId: string | null;
  material?: Material;
  /** Palettenindizes der Farben mit Steinen, die dieses Material verwenden */
  colors: number[];
  rawW: number;
  rawH: number;
  /** Steine dieser Farben */
  pieces: number;
  /** Σ raw der Farben (ohne Reserve) */
  raw: number;
  /** Σ rawWithReserve der Farben – Σ need über alle Materialien = rawWithReserveTotal */
  need: number;
  /** erfasster Bestand (auch 0 gilt als erfasst) */
  stock?: number;
  /** max(0, need − stock), nur mit erfasstem Bestand */
  toBuy?: number;
  /** ⌈need / Stück je Packung⌉, nur mit Packungsgröße > 0 */
  packs?: number;
  /** ⌈toBuy / Stück je Packung⌉, nur mit Bestand und Packungsgröße */
  packsToBuy?: number;
  /** packs × Preis, nur mit Packungsgröße und Preis > 0 */
  cost?: number;
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
  perMaterial: MaterialStat[];
  perShape: Record<ShapeType, number>;
  perSize: SizeStat[];
  cutPieces: number;
  uncutPieces: number;
  notFitting: number;
  /**
   * Steine mit ungültigem Farbindex (≥ Palettenlänge). Sie sind in pieces/Flächen/Formen
   * enthalten, aber in keiner Farbe und in keinem Rohstein-/Materialbedarf.
   */
  invalidColorPieces: number;
  /**
   * Teile ohne Fläche (analyzeCut: invalid, z. B. Dreiecksteilung trotz zu breiter Fuge aus älteren
   * Projekten). Sie sind KEINE Steine: in keiner Summe (Steine, Formen, Größen, Rohsteine, „passt
   * nicht“) enthalten, sondern nur hier gezählt.
   */
  invalidPieces: number;
  /**
   * Freiformzellen mit ungültigen Teilen (z. B. überlappend, aus älteren oder importierten Projekten; siehe
   * invalidFreeCells). Ihre Teile sind in den Summen enthalten, aber die Flächen stimmen dann nicht: Überlappungen
   * zählen doppelt. Ist der Wert > 0, sind Fugenfläche und Fugenmasse nicht berechenbar (siehe jointAreaValid).
   */
  invalidFreeCells: number;
  /** Palettenindizes, deren Material-ID auf kein vorhandenes Material zeigt */
  missingMaterials: number[];
  rawTotal: number;
  rawWithReserveTotal: number;
  /** Σ raw · Rohsteinmaß – Grundlage für Verschnitt, passt zur angezeigten Rohsteinzahl */
  rawArea: number;
  wasteArea: number;
  wastePct: number;
  reservePct: number;
  groutMl: number;
  groutKg: number;
  /** Σ Kosten je Material */
  totalCost: number;
  /** false, sobald eine Farbe mit Steinen kein Material, keine Packungsgröße oder keinen Preis hat */
  costComplete: boolean;
}

/**
 * Sind Fugenfläche (Gesamtfläche − Steinfläche) und die daraus geschätzte Fugenmasse gültig? Nein, wenn eine
 * Freiformzelle ungültige (z. B. überlappende) Teile hat oder die Steinfläche die Gesamtfläche übersteigt – dann
 * sind die Flächen nicht exakt und werden nicht als Zahl angezeigt oder gedruckt.
 */
export function jointAreaValid(s: Pick<Stats, 'invalidFreeCells' | 'stoneArea' | 'finishedArea'>): boolean {
  return !(s.invalidFreeCells > 0) && s.stoneArea <= s.finishedArea * (1 + 1e-9) + 1e-6;
}

export interface Range {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export interface RawSize {
  w: number;
  h: number;
  material?: Material;
  /** Material-ID gesetzt, Material aber nicht gefunden */
  materialMissing?: boolean;
  /** w/h sind das Rastermaß, nicht das Maß eines Materials */
  rawAssumedGrid?: boolean;
}

export type RawSizeFn = (color: number) => RawSize;

/** endliche Zahl > 0 (Maße, Stück je Packung, Preis) */
const isPositive = (v: number) => Number.isFinite(v) && v > 0;

export function makeRawSizeFn(layout: Layout, palette: PaletteColor[], materials: Material[]): RawSizeFn {
  const byId = new Map(materials.map((m) => [m.id, m]));
  const grid: RawSize = { w: layout.tileW, h: layout.tileH, rawAssumedGrid: true, materialMissing: false };
  const cache = palette.map((p): RawSize => {
    const m = p.materialId ? byId.get(p.materialId) : undefined;
    const materialMissing = !!p.materialId && !m;
    if (m && isPositive(m.lengthMm) && isPositive(m.widthMm)) return { w: m.widthMm, h: m.lengthMm, material: m, materialMissing: false, rawAssumedGrid: false };
    return { w: layout.tileW, h: layout.tileH, material: m, materialMissing, rawAssumedGrid: true };
  });
  return (c: number) => cache[c] ?? grid;
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

/**
 * Umriss als Text: an den Ursprung des Begrenzungsrechtecks verschoben, auf 0,1 mm
 * gerundet, Umlaufsinn vereinheitlicht und mit dem kleinsten Startpunkt begonnen –
 * unabhängig davon, an welcher Ecke das Polygon beginnt oder in welcher Richtung es läuft.
 */
function outlineString(poly: Pt[]): string {
  let minX = Infinity;
  let minY = Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
  }
  const pts: [number, number][] = [];
  for (const p of poly) {
    const q: [number, number] = [Math.round((p.x - minX) * 10) || 0, Math.round((p.y - minY) * 10) || 0];
    const last = pts[pts.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
  }
  while (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  let s2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s2 += a[0] * b[1] - b[0] * a[1];
  }
  // Umkehren des Umlaufs beschreibt dasselbe Teil (keine Spiegelung)
  if (s2 < 0) pts.reverse();
  const toks = pts.map(([x, y]) => `${x},${y}`);
  let best = '';
  for (let s = 0; s < toks.length; s++) {
    const str = toks.slice(s).concat(toks.slice(0, s)).join(';');
    if (s === 0 || str < best) best = str;
  }
  return best;
}

/** Drehungsinvarianter Umriss (0/90/180/270°, ohne Spiegelung). */
export function canonicalOutline(poly: Pt[]): string {
  let best = '';
  let cur = poly;
  for (let r = 0; r < 4; r++) {
    const s = outlineString(cur);
    if (r === 0 || s < best) best = s;
    cur = cur.map((p) => ({ x: -p.y, y: p.x })); // Drehung um 90°, keine Spiegelung
  }
  return best;
}

const rawGroupMemo = new WeakMap<CutInfo, string>();

/**
 * Gruppenschlüssel für den Rohsteinbedarf: Form | Rohsteinmaß | Ausbeute | drehungsinvarianter
 * Umriss im Rohstein. Teile mit gleichem Schlüssel lassen sich aus denselben Rohsteinen schneiden.
 */
export function rawGroupKey(ci: CutInfo): string {
  let k = rawGroupMemo.get(ci);
  if (k === undefined) {
    k = `${ci.shape}|${ci.rawW.toFixed(2)}x${ci.rawH.toFixed(2)}|${ci.yieldPerRaw}|${canonicalOutline(ci.polyInRaw)}`;
    rawGroupMemo.set(ci, k);
  }
  return k;
}

/** Rohsteine aus Teilen mit Ausbeute > 1: gleiche Schnittformen zusammenfassen, je Gruppe aufrunden. */
export function rawFromSharedCuts(counts: Map<CutInfo, number>): number {
  const groups = new Map<string, { n: number; y: number }>();
  for (const [ci, n] of counts) {
    const k = rawGroupKey(ci);
    const g = groups.get(k);
    if (g) g.n += n;
    else groups.set(k, { n, y: ci.yieldPerRaw });
  }
  let raw = 0;
  for (const g of groups.values()) raw += Math.ceil(g.n / g.y);
  return raw;
}

/** ⌈raw · (1 + Reserve/100)⌉ ohne Gleitkomma-Aufrundung (z. B. 10 · 1,1 = 11,000000000000002 → 11). */
export function withReserve(raw: number, reservePct: number): number {
  const x = raw * (1 + reservePct / 100);
  return Math.max(raw, Math.ceil(x - 1e-9 - x * 1e-12));
}

/** Packungen für n Rohsteine: ⌈n / Stück je Packung⌉, mindestens 1 sobald n > 0. */
export function packsFor(n: number, piecesPerPack: number): number {
  if (!(n > 0)) return 0;
  const q = n / piecesPerPack;
  const r = Math.round(q);
  return Math.max(1, Math.abs(q - r) < 1e-9 * Math.max(1, q) ? r : Math.ceil(q));
}

export function popcount(v: number): number {
  v = v - ((v >> 1) & 0x5555);
  v = (v & 0x3333) + ((v >> 2) & 0x3333);
  v = (v + (v >> 4)) & 0x0f0f;
  return (v + (v >> 8)) & 0x1f;
}

/** Packungen/Bestand/Kosten je Material aus dem Bedarf je Farbe. */
export function materialTotals(perColor: ColorStat[], layout: Layout): { perMaterial: MaterialStat[]; totalCost: number; costComplete: boolean } {
  const byMat = new Map<string | null, MaterialStat>();
  let costComplete = true;
  for (const cs of perColor) {
    if (cs.pieces <= 0) continue;
    const m = cs.material;
    const key = m ? m.id : null;
    let ms = byMat.get(key);
    if (!ms) {
      ms = m
        ? { materialId: m.id, material: m, colors: [], rawW: cs.rawW, rawH: cs.rawH, pieces: 0, raw: 0, need: 0 }
        : { materialId: null, colors: [], rawW: layout.tileW, rawH: layout.tileH, pieces: 0, raw: 0, need: 0 };
      byMat.set(key, ms);
    }
    ms.colors.push(cs.color);
    ms.pieces += cs.pieces;
    ms.raw += cs.raw;
    ms.need += cs.rawWithReserve;
  }
  let totalCost = 0;
  const named: MaterialStat[] = [];
  let none: MaterialStat | undefined;
  for (const ms of byMat.values()) {
    const m = ms.material;
    if (!m) {
      none = ms;
      costComplete = false;
      continue;
    }
    const ppp = isPositive(m.piecesPerPack) ? m.piecesPerPack : 0;
    const price = isPositive(m.price) ? m.price : 0;
    if (typeof m.stock === 'number' && Number.isFinite(m.stock)) {
      ms.stock = Math.max(0, m.stock);
      ms.toBuy = Math.max(0, ms.need - ms.stock);
    }
    if (ppp > 0) {
      ms.packs = packsFor(ms.need, ppp);
      if (ms.toBuy !== undefined) ms.packsToBuy = packsFor(ms.toBuy, ppp);
      if (price > 0) {
        ms.cost = ms.packs * price;
        totalCost += ms.cost;
      }
    }
    if (!(ppp > 0 && price > 0)) costComplete = false;
    named.push(ms);
  }
  // Reihenfolge: nach der ersten Farbe (Palettenreihenfolge), „ohne Material“ zuletzt
  if (none) named.push(none);
  return { perMaterial: named, totalCost, costComplete };
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
  // Teile mit Ausbeute > 1 je Farbe: Schnittinfo (Objektidentität, aus dem CutCache) → Anzahl
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
        const ci = pieceCutInfo(cache, layout, data, row, col, i, p.poly, r);
        if (ci.invalid) {
          // kein Stein (keine Fläche): nicht zählen, nur melden
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
          // Farbindex außerhalb der Palette: geometrisch gezählt, aber keiner Farbe zuzuordnen
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
          // ganzer Stein (Ausbeute 1) oder passt nicht in den Rohstein (Ausbeute 0): je Teil ein Rohstein
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
  // Verschnitt nur über Steine mit gültiger Farbe – nur für sie gibt es einen Rohsteinbedarf
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
    // Fugenmörtel ≈ 1,6 kg pro Liter Fugenvolumen (Schätzwert)
    groutKg: (groutMl / 1000) * 1.6,
    totalCost: mt.totalCost,
    costComplete: mt.costComplete && invalidColorPieces === 0,
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
