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
 *
 * Gesamt- und Abschnittsstatistik entstehen in EINEM Durchlauf über das Raster (computeAllStats); gleiche
 * Geometrien werden über ganzzahlige Klassen nur einmal analysiert. Die Zahlen sind exakt dieselben wie bei
 * einer Zählung je Bereich – alle Maße stammen weiterhin aus analyzeCut auf den echten Polygonen.
 *
 * Feinsteine (w6-fine-tiles): Hat eine Farbe ein Feinstein-Material (PaletteColor.fineMaterialId), werden ihre
 * Teilsteine (k×k), deren Außenmaß exakt dem Materialmaß entspricht, als ganze Feinsteine dieses Materials gezählt
 * (analyzeCut: ungeschnitten, Ausbeute 1) – je Farbe in einer eigenen Zeile ColorStat.fine und je Material in
 * perMaterial. Alles andere (ganze Steine, Randteile, abweichende Maße) bleibt beim Grundstein-Material.
 */
import { bbox, DIM_TOL, type Pt, type ShapeType } from './geometry';
import type { Layout, SectionGrid } from './layout';
import { invalidFreeCells } from './edits';
import { analyzeCut, cellPieces, pieceWidthCheck, type CutInfo } from './pieces';
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
  /**
   * Feinsteine dieser Farbe (w6-fine-tiles): Teilsteine, die als ganze Steine des Feinstein-Materials gezählt werden.
   * Nur gesetzt, wenn die Farbe solche Steine hat. Dann gilt:
   *  - pieces/uncut/cut/area/placed oben enthalten ALLE Steine der Farbe (Grund- und Feinsteine),
   *  - rawExact/raw/rawWithReserve/rawW/rawH/material/packs/cost oben gelten nur für das Grundstein-Material,
   *  - die Feinsteine stehen hier mit eigenem Material, Maß und Bedarf (eigene Einkaufszeile in perMaterial).
   * Σ (raw + fine.raw) über alle Farben = rawTotal, ebenso mit Reserve.
   */
  fine?: FineColorStat;
}

/** Feinsteine einer Farbe (siehe ColorStat.fine) – ganze, ungeschnittene Steine des Feinstein-Materials. */
export interface FineColorStat {
  material: Material;
  rawW: number;
  rawH: number;
  /** Feinsteine dieser Farbe (je Stein ein Feinstein, nie geschnitten) */
  pieces: number;
  area: number;
  placed: number;
  /** benötigte Feinsteine = pieces (Ausbeute 1) */
  raw: number;
  /** ⌈raw · (1 + Reserve)⌉ */
  rawWithReserve: number;
  /** Packungen nur für diese Farbe allein (nur mit Packungsgröße) */
  packs?: number;
  /** Kosten nur für diese Farbe allein (nur mit Packungsgröße und Preis) */
  cost?: number;
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
  /**
   * Zellen, deren Teile zusammen mehr Fläche haben als die Zelle selbst (Σ Teilflächen > Zellfläche) – nur bei
   * überlappenden oder über die Zelle hinausragenden Freiformteilen möglich (ältere/importierte Projekte). Reine
   * Prüfzahl; muss 0 sein. Von computeStats/computeAllStats immer gesetzt (optional nur für ältere Objekte).
   */
  overlapCells?: number;
  /**
   * Teile automatischer Schnittzellen (Dreiecke, Kantenschnitt, Teilsteine) unter der Mindestbreite eines
   * Schnittteils (pieceWidthCheck – dieselbe Regel wie Berechnung und Steindetail). Muss 0 sein; > 0 nur bei
   * Projekten, die mit einer älteren Regel oder kleineren Mindestbreite berechnet wurden. Nur gesetzt, wenn
   * opts.minPieceMm übergeben wurde – sonst nicht geprüft (undefined, nicht 0).
   */
  thinPieces?: number;
  /**
   * Freiformteile unter der Mindestbreite (gleiche Prüfung; bei nicht-konvexen Teilen nur näherungsweise über die
   * konvexe Hülle). Getrennt von thinPieces gezählt, weil Freiform bewusst gezeichnet wird. Nur mit opts.minPieceMm.
   */
  thinFreePieces?: number;
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
  /**
   * Feinstein-Material der Farbe (PaletteColor.fineMaterialId mit gültigem Maß). Gilt nur für Teilsteine (k×k), deren
   * Außenmaß exakt dem Materialmaß entspricht – siehe fineRawFor. pieceCutInfo wählt es selbst.
   */
  fine?: RawSize;
  /** fineMaterialId gesetzt, aber das Material fehlt oder hat kein gültiges Maß – Teilsteine bleiben beim Grundstein */
  fineMissing?: boolean;
}

export type RawSizeFn = (color: number) => RawSize;

/**
 * Rohsteinmaß eines Teils: das Feinstein-Material der Farbe, wenn das Teil ein Teilstein (k×k) ist und sein Außenmaß
 * exakt (± DIM_TOL, auch um 90° gedreht) dem Feinsteinmaß entspricht – dann ist es ein ganzer Feinstein (analyzeCut:
 * exactRaw, ungeschnitten, Ausbeute 1). Sonst null: Das Teil wird aus dem Grundstein geschnitten. Nie wird ein Teil als
 * ungeschnitten umgedeutet, dessen Maß nicht passt.
 */
export function fineRawFor(kind: number, poly: Pt[], raw: RawSize): RawSize | null {
  const f = raw.fine;
  if (!f || kind !== CellKind.SUB) return null;
  const b = bbox(poly);
  const ok = (Math.abs(b.w - f.w) < DIM_TOL && Math.abs(b.h - f.h) < DIM_TOL) || (Math.abs(b.w - f.h) < DIM_TOL && Math.abs(b.h - f.w) < DIM_TOL);
  return ok ? f : null;
}

/**
 * Rohsteinmaß, aus dem ein Teil der Zelle (row, col) tatsächlich kommt (Grundstein oder Feinstein, siehe fineRawFor) –
 * dasselbe, das pieceCutInfo verwendet. Für Anzeigen, die analyzeCut selbst aufrufen (Steindetail).
 */
export function pieceRawSize(layout: Layout, data: MosaicData, row: number, col: number, poly: Pt[], raw: RawSize): RawSize {
  return fineRawFor(data.kind[row * layout.cols + col], poly, raw) ?? raw;
}

/** endliche Zahl > 0 (Maße, Stück je Packung, Preis) */
const isPositive = (v: number) => Number.isFinite(v) && v > 0;

export function makeRawSizeFn(layout: Layout, palette: PaletteColor[], materials: Material[]): RawSizeFn {
  const byId = new Map(materials.map((m) => [m.id, m]));
  const grid: RawSize = { w: layout.tileW, h: layout.tileH, rawAssumedGrid: true, materialMissing: false };
  const cache = palette.map((p): RawSize => {
    const m = p.materialId ? byId.get(p.materialId) : undefined;
    const materialMissing = !!p.materialId && !m;
    const base: RawSize =
      m && isPositive(m.lengthMm) && isPositive(m.widthMm)
        ? { w: m.widthMm, h: m.lengthMm, material: m, materialMissing: false, rawAssumedGrid: false }
        : { w: layout.tileW, h: layout.tileH, material: m, materialMissing, rawAssumedGrid: true };
    // Feinstein-Material nur mit gültigem Maß – ein angenommenes Maß würde Teilsteine still als ungeschnitten zählen
    if (p.fineMaterialId) {
      const fm = byId.get(p.fineMaterialId);
      if (fm && isPositive(fm.lengthMm) && isPositive(fm.widthMm)) base.fine = { w: fm.widthMm, h: fm.lengthMm, material: fm, materialMissing: false, rawAssumedGrid: false };
      else base.fineMissing = true;
    }
    return base;
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
  /** Rohsteinmaß der Farbe (RawSizeFn); mit `fine` wählt pieceCutInfo für passende Teilsteine das Feinsteinmaß */
  raw: RawSize,
): CutInfo {
  // Teilsteine in Feinsteingröße: aus dem Feinstein-Material (ganzer Stein); sonst aus dem Grundstein
  const rs = raw.fine ? pieceRawSize(layout, data, row, col, poly, raw) : raw;
  const gk = cellGeomKey(layout, data, row, col);
  if (gk === null) return analyzeCut(poly, rs.w, rs.h);
  return cache.get(`${gk}|${pieceIdx}|${rs.w}x${rs.h}`, () => analyzeCut(poly, rs.w, rs.h));
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
  const addRow = (color: number, m: Material | undefined, rawW: number, rawH: number, pieces: number, raw: number, need: number) => {
    const key = m ? m.id : null;
    let ms = byMat.get(key);
    if (!ms) {
      ms = m
        ? { materialId: m.id, material: m, colors: [], rawW, rawH, pieces: 0, raw: 0, need: 0 }
        : { materialId: null, colors: [], rawW: layout.tileW, rawH: layout.tileH, pieces: 0, raw: 0, need: 0 };
      byMat.set(key, ms);
    }
    if (ms.colors[ms.colors.length - 1] !== color) ms.colors.push(color);
    ms.pieces += pieces;
    ms.raw += raw;
    ms.need += need;
  };
  for (const cs of perColor) {
    if (cs.pieces <= 0) continue;
    const f = cs.fine;
    // Grundstein-Zeile: alle Steine der Farbe außer den Feinsteinen (ohne Feinsteine = wie bisher)
    const basePieces = f ? cs.pieces - f.pieces : cs.pieces;
    if (basePieces > 0 || !f) addRow(cs.color, cs.material, cs.rawW, cs.rawH, basePieces, cs.raw, cs.rawWithReserve);
    // Feinsteine: eigene Einkaufszeile ihres Materials
    if (f && f.pieces > 0) addRow(cs.color, f.material, f.rawW, f.rawH, f.pieces, f.raw, f.rawWithReserve);
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

/**
 * Bedarf einer Farbe je Material (Integration Welle 6): die Grundstein-Zeile und – falls die Farbe Feinsteine hat
 * (ColorStat.fine) – eine Feinstein-Zeile mit eigenem Material und Maß. Dieselbe Aufteilung wie materialTotals
 * (Grundstein-Zeile entfällt nur, wenn alle Steine der Farbe Feinsteine sind). Σ rawWithReserve aller Zeilen aller
 * Farben = rawWithReserveTotal, Σ raw = rawTotal. Für die Tabellen „Bedarf je Farbe“ (Materialansicht, PDF).
 */
export interface ColorNeedLine {
  color: number;
  /** true: Feinsteine (ganze, ungeschnittene Steine des Feinstein-Materials) */
  fine: boolean;
  material?: Material;
  /** nur Grundstein-Zeile: Material-ID gesetzt, Material fehlt */
  materialMissing: boolean;
  /** nur Grundstein-Zeile: Rohsteinmaß = Rastermaß angenommen */
  rawAssumedGrid: boolean;
  rawW: number;
  rawH: number;
  /** Steine dieser Zeile (Grundstein: alle Steine der Farbe außer den Feinsteinen) */
  pieces: number;
  /** davon geschnitten (Feinsteine nie) */
  cut: number;
  raw: number;
  rawWithReserve: number;
}

export function colorNeedLines(cs: ColorStat): ColorNeedLine[] {
  const f = cs.fine;
  const out: ColorNeedLine[] = [];
  const basePieces = f ? cs.pieces - f.pieces : cs.pieces;
  if (basePieces > 0 || !f)
    out.push({
      color: cs.color,
      fine: false,
      material: cs.material,
      materialMissing: cs.materialMissing,
      rawAssumedGrid: cs.rawAssumedGrid,
      rawW: cs.rawW,
      rawH: cs.rawH,
      pieces: basePieces,
      cut: cs.cut,
      raw: cs.raw,
      rawWithReserve: cs.rawWithReserve,
    });
  if (f && f.pieces > 0)
    out.push({
      color: cs.color,
      fine: true,
      material: f.material,
      materialMissing: false,
      rawAssumedGrid: false,
      rawW: f.rawW,
      rawH: f.rawH,
      pieces: f.pieces,
      cut: 0,
      raw: f.raw,
      rawWithReserve: f.rawWithReserve,
    });
  return out;
}

/**
 * Einkaufszeile mit angenommenem Rastermaß („*“)? Nur das Grundstein-Material einer Farbe kann ein angenommenes
 * Maß haben – ein Feinstein-Material hat immer ein gültiges Maß (makeRawSizeFn). Die Zeile „ohne Material“ immer.
 */
export function materialRowGridAssumed(ms: Pick<MaterialStat, 'materialId' | 'colors'>, perColor: readonly ColorStat[]): boolean {
  return ms.materialId === null || ms.colors.some((c) => !!perColor[c]?.rawAssumedGrid && perColor[c]?.material?.id === ms.materialId);
}

/** Optionen der Statistik. */
export interface StatsOptions {
  reservePct: number;
  groutDepthMm: number;
  /**
   * Mindestbreite eines Schnittteils (Schritt Steinformen, `settings.shapes.minPieceMm`). Nur damit werden
   * thinPieces/thinFreePieces gezählt – ohne den Wert bleiben beide Felder leer (nicht geprüft, nicht 0).
   */
  minPieceMm?: number;
}

/** Gesamtstatistik und Statistik je Abschnitt aus EINEM Durchlauf (computeAllStats). */
export interface AllStats {
  total: Stats;
  /** in der Reihenfolge von grid.sections; leer ohne Abschnittsraster */
  perSection: Stats[];
}

const SHAPES: readonly ShapeType[] = ['square', 'rectangle', 'triangle', 'rhombus', 'trapezoid', 'parallelogram', 'custom'];
const SHAPE_INDEX = new Map<ShapeType, number>(SHAPES.map((s, i) => [s, i]));

/**
 * Schnittinfo einer Geometrieklasse mit den für die Zählung vorberechneten Werten. Die CutInfo stammt
 * unverändert aus analyzeCut auf dem echten Polygon (über den CutCache wie bei pieceCutInfo); hier wird nur
 * einmal je Klasse abgeleitet, was sonst bei jedem Stein neu berechnet würde (Größenschlüssel, Rohsteingruppe).
 */
interface Entry {
  ci: CutInfo;
  invalid: boolean;
  area: number;
  needsCut: boolean;
  fits: boolean;
  /** Index in SHAPES */
  shape: number;
  /** Index des Größenschlüssels `${shape}|${w.toFixed(1)}|${h.toFixed(1)}` */
  size: number;
  /** Ausbeute je Rohstein */
  y: number;
  /** Index des Rohsteingruppen-Schlüssels (rawGroupKey), nur bei Ausbeute > 1, sonst −1 */
  group: number;
  /** Mindestbreite (pieceWidthCheck) eingehalten: −1 noch nicht geprüft, 0 nein, 1 ja */
  widthOk: number;
}

// Kennzahlen je Bucket (Bucket 0 = Gesamt, Bucket 1 + s = Abschnitt s)
const S_PIECES = 0;
const S_PLACED = 1;
const S_AREA = 2;
const S_CUT = 3;
const S_NOTFIT = 4;
const S_BADCOLOR = 5;
const S_INVALID = 6;
const S_OVERLAP = 7;
const S_THIN = 8;
const S_THINFREE = 9;
const S_BADFREE = 10;
const NS = 11;

/** Höchstzahl Teilstücke je Zelle im Ganzzahl-Cache (Fortschrittsmaske: 16 Bit); mehr → Einzelweg wie bisher */
const PMAX = 16;

// Zellarten als Modulkonstanten (in der heißen Schleife kein Objektzugriff)
const K_FULL: number = CellKind.FULL;
const K_DIAG_A: number = CellKind.DIAG_A;
const K_DIAG_B: number = CellKind.DIAG_B;
const K_LINE: number = CellKind.LINE;
const K_SUB: number = CellKind.SUB;
const K_FREE: number = CellKind.FREE;

/** Obergrenze des Zähl-Arrays (Rohsteingruppe × Farbe) der Gesamtstatistik; darüber eine Map */
const SHARED_ARRAY_MAX = 1 << 22;

/** Murmur3-Mischung von sechs 32-Bit-Wörtern (Hash der exakten Kantenschnitt-Parameter). */
function hash6(u: Uint32Array): number {
  let h = 0x9747b28c;
  for (let i = 0; i < 6; i++) {
    let k = Math.imul(u[i], 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= 24;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

/** Int32Array auf mindestens n Einträge vergrößern (verdoppelnd, Inhalt bleibt). */
function grown(a: Int32Array, n: number): Int32Array<ArrayBuffer> {
  const b = new Int32Array(Math.max(n, a.length * 2, 16));
  b.set(a);
  return b;
}

/** Toleranz der Flächenprüfung je Zelle (Σ Teilflächen > Zellfläche) */
const overlapTol = (cellArea: number) => 1e-6 + cellArea * 1e-9;

/** Klassen gleicher Maße entlang einer Achse – dieselbe Gleichheit (toFixed(4)) wie im Geometrie-Schlüssel. */
function axisClasses(sizes: Float64Array): { cls: Int32Array; n: number } {
  const ids = new Map<string, number>();
  const cls = new Int32Array(sizes.length);
  for (let i = 0; i < sizes.length; i++) {
    const k = sizes[i].toFixed(4);
    let v = ids.get(k);
    if (v === undefined) ids.set(k, (v = ids.size));
    cls[i] = v;
  }
  return { cls, n: ids.size };
}

/** Abschnitt (Index in starts) je Zeile bzw. Spalte – wie sectionOfCell (letzter Start ≤ Index). */
function sectionLookup(starts: number[], n: number): Int32Array {
  const out = new Int32Array(n);
  for (let s = 0; s < starts.length; s++) {
    const a = Math.max(0, starts[s]);
    const b = s + 1 < starts.length ? Math.min(n, starts[s + 1]) : n;
    for (let i = a; i < b; i++) out[i] = s;
  }
  return out;
}

/**
 * Statistik für das ganze Mosaik und – mit `grid` – für jeden Abschnitt, in EINEM Durchlauf über das Raster.
 *
 * Exakt dieselben Zahlen wie computeStats je Bereich (gleiche Gleitkomma-Reihenfolge, gleiche Reihenfolge in
 * perSize): Die Gesamtsumme wird im selben Durchlauf direkt aufaddiert (nicht als Summe der Abschnitte), jeder
 * Abschnitt in Zeilen-, dann Spaltenreihenfolge seiner Zellen. Gleiche Geometrien werden über ganzzahlige
 * Schlüssel nur einmal analysiert:
 *  - ganze Steine, Dreiecke und Teilsteine: (Art, k², Spaltenbreiten-Klasse, Zeilenhöhen-Klasse, Teil, Rohsteinmaß),
 *  - Kantenschnitt: exakte Bitmuster von nx, ny, d (nie gerundet – manuelle Schnitte haben beliebige Winkel/Versätze),
 *  - Freiform: immer einzeln.
 * Jede Schnittinfo stammt weiterhin aus analyzeCut auf dem echten Polygon, geholt über `cache` mit demselben
 * Schlüssel wie pieceCutInfo – ein gemeinsam genutzter CutCache liefert also dieselben Objekte wie bisher.
 *
 * Zusätzliche Prüfzähler (siehe Stats): overlapCells, thinPieces/thinFreePieces (nur mit opts.minPieceMm),
 * invalidPieces.
 */
export function computeAllStats(
  layout: Layout,
  data: MosaicData,
  palette: PaletteColor[],
  materials: Material[],
  opts: StatsOptions,
  grid?: SectionGrid | null,
  cache: CutCache = new CutCache(),
): AllStats {
  const full: Range = { r0: 0, r1: layout.rows, c0: 0, c1: layout.cols };
  return statsPass(layout, data, palette, materials, opts, full, grid ?? null, cache);
}

/**
 * Statistik eines Rasterbereichs (ohne `range`: ganzes Mosaik). Dünne Hülle um denselben Durchlauf wie
 * computeAllStats – für Abschnitte in einem Rutsch computeAllStats mit dem Abschnittsraster verwenden.
 */
export function computeStats(
  layout: Layout,
  data: MosaicData,
  palette: PaletteColor[],
  materials: Material[],
  opts: StatsOptions,
  range?: Range,
  cache: CutCache = new CutCache(),
): Stats {
  return statsPass(layout, data, palette, materials, opts, range ?? { r0: 0, r1: layout.rows, c0: 0, c1: layout.cols }, null, cache).total;
}

function statsPass(
  layout: Layout,
  data: MosaicData,
  palette: PaletteColor[],
  materials: Material[],
  opts: StatsOptions,
  scan: Range,
  grid: SectionGrid | null,
  cache: CutCache,
): AllStats {
  const rawFn = makeRawSizeFn(layout, palette, materials);
  const reservePct = Number.isFinite(opts.reservePct) && opts.reservePct > 0 ? opts.reservePct : 0;
  const minPiece = typeof opts.minPieceMm === 'number' && Number.isFinite(opts.minPieceMm) && opts.minPieceMm >= 0 ? opts.minPieceMm : null;
  const thinOn = minPiece !== null;
  const cols = layout.cols;
  const nC = palette.length;
  const nSec = grid ? grid.sections.length : 0;
  const nB = 1 + nSec;
  const hasSec = nSec > 0;

  // ---------- Farbindizes und Rohsteinmaß-Klassen
  // gültige Farbe ⇔ perColor[c] existiert (dieselbe Indexsemantik wie bisher: Uint8Array[c] === 1)
  const okColor = new Uint8Array(nC).fill(1);
  const rawIds = new Map<string, number>();
  const rawClassOf = (r: RawSize) => {
    // mit Feinstein-Material eine eigene Klasse: Teilsteine derselben Geometrie bekommen dort eine andere Schnittinfo
    const k = r.fine ? `${r.w}x${r.h}|${r.fine.w}x${r.fine.h}` : `${r.w}x${r.h}`;
    let v = rawIds.get(k);
    if (v === undefined) rawIds.set(k, (v = rawIds.size));
    return v;
  };
  // rawOf[c + 1]: Klasse der Farbe c; rawOf[0]: ungültige Farbe (Rastermaß, wie makeRawSizeFn)
  const rawOf = new Int32Array(nC + 1);
  rawOf[0] = rawClassOf(rawFn(-1));
  for (let c = 0; c < nC; c++) rawOf[c + 1] = rawClassOf(rawFn(c));
  const nRaw = rawIds.size;

  // ---------- Geometrie-Klassen
  const colC = axisClasses(layout.colW);
  const rowC = axisClasses(layout.rowH);
  const colCls = colC.cls;
  const rowCls = rowC.cls;
  const nColCls = colC.n;
  const nRowCls = rowC.n;
  const perKind = nColCls * nRowCls * PMAX * nRaw;
  // Ganze Steine, Dreiecke, Teilsteine: dichtes Array (Art-Slot außen, damit es wachsen kann); bei sehr vielen
  // Klassen (nur bei ungewöhnlichen Layouts) eine Map
  const useArray = perKind <= 1 << 16;
  const denseArr: (Entry | undefined)[] = [];
  const denseMap = new Map<number, Entry>();
  // je dichtem Eintrag: Teil zählt als Feinstein (1) oder nicht (0) – siehe fineRawFor; nur bei Teilsteinen je 1 möglich
  const denseFineArr: number[] = [];
  const denseFineMap = new Map<number, number>();
  const kindSlots = new Map<number, number>(); // Art-Code → Slot (0 ganz, 1 ╲, 2 ╱, 3+ Teilsteine je Länge)
  const kindSlot = (code: number): number => {
    let v = kindSlots.get(code);
    if (v === undefined) {
      v = kindSlots.size;
      kindSlots.set(code, v);
      if (useArray)
        for (let i = 0; i < perKind; i++) {
          denseArr.push(undefined);
          denseFineArr.push(0);
        }
    }
    return v;
  };
  const SLOT_FULL = kindSlot(-1);
  const SLOT_DIAG_A = kindSlot(-2);
  const SLOT_DIAG_B = kindSlot(-3);
  const lineEntries = new Map<number, Entry>();

  // Kantenschnitt-Klassen: exaktes Bitmuster der drei Parameter (als Float64 – auch für Float32-Werte exakt)
  const f64 = new Float64Array(3);
  const u32 = new Uint32Array(f64.buffer);
  const lineByHash = new Map<number, number>();
  const lineBits: number[] = [];
  const lineAlt = new Map<string, number>();
  let lineCount = 0;
  const lineIdOf = (p: ArrayLike<number>): number => {
    f64[0] = p[0];
    f64[1] = p[1];
    f64[2] = p[2];
    const h = hash6(u32);
    const id = lineByHash.get(h);
    if (id === undefined) {
      const nid = lineCount++;
      lineByHash.set(h, nid);
      for (let i = 0; i < 6; i++) lineBits.push(u32[i]);
      return nid;
    }
    const o = id * 6;
    if (lineBits[o] === u32[0] && lineBits[o + 1] === u32[1] && lineBits[o + 2] === u32[2] && lineBits[o + 3] === u32[3] && lineBits[o + 4] === u32[4] && lineBits[o + 5] === u32[5]) return id;
    // Hash-Kollision: exakter Textschlüssel der Bitmuster
    const k = `${u32[0]},${u32[1]},${u32[2]},${u32[3]},${u32[4]},${u32[5]}`;
    let v = lineAlt.get(k);
    if (v === undefined) {
      lineAlt.set(k, (v = lineCount++));
      for (let i = 0; i < 6; i++) lineBits.push(u32[i]);
    }
    return v;
  };

  // ---------- Einträge (je CutInfo einmal)
  const sizeIds = new Map<string, number>();
  const sizeKeys: string[] = [];
  const groupIds = new Map<string, number>();
  const groupYield: number[] = [];
  const entryOfCi = new Map<CutInfo, Entry>();
  const makeEntry = (ci: CutInfo): Entry => {
    let size = -1;
    let group = -1;
    if (!ci.invalid) {
      const sk = `${ci.shape}|${ci.w.toFixed(1)}|${ci.h.toFixed(1)}`;
      let s = sizeIds.get(sk);
      if (s === undefined) {
        sizeIds.set(sk, (s = sizeKeys.length));
        sizeKeys.push(sk);
      }
      size = s;
      if (ci.yieldPerRaw > 1) {
        const gk = rawGroupKey(ci);
        let g = groupIds.get(gk);
        if (g === undefined) {
          groupIds.set(gk, (g = groupYield.length));
          groupYield.push(ci.yieldPerRaw);
        }
        group = g;
      }
    }
    return {
      ci,
      invalid: !!ci.invalid,
      area: ci.area,
      needsCut: ci.needsCut,
      fits: ci.fits,
      shape: SHAPE_INDEX.get(ci.shape) ?? SHAPES.length - 1,
      size,
      y: ci.yieldPerRaw,
      group,
      widthOk: -1,
    };
  };
  const entryFor = (ci: CutInfo): Entry => {
    let e = entryOfCi.get(ci);
    if (!e) entryOfCi.set(ci, (e = makeEntry(ci)));
    return e;
  };
  /** Teil zählt beim letzten resolve als Feinstein (fineRawFor) – nur Teilsteine einer Farbe mit Feinstein-Material */
  let resolvedFine = 0;
  /** Cache-Fehlschlag: Schnittinfo genau wie pieceCutInfo (gleicher Textschlüssel im CutCache) */
  const resolve = (row: number, col: number, i: number, color: number): Entry => {
    const p = cellPieces(layout, data, row, col)[i];
    const rs = rawFn(color);
    resolvedFine = rs.fine && fineRawFor(data.kind[row * cols + col], p.poly, rs) ? 1 : 0;
    return entryFor(pieceCutInfo(cache, layout, data, row, col, i, p.poly, rs));
  };
  /** Teil unter der Mindestbreite? (dieselbe Prüfung wie Berechnung und Steindetail, je Geometrieklasse einmal) */
  const thinFlag = (e: Entry, row: number, col: number, i: number): boolean => {
    if (e.widthOk < 0) e.widthOk = pieceWidthCheck(cellPieces(layout, data, row, col)[i].poly, minPiece as number).ok ? 1 : 0;
    return e.widthOk === 0;
  };

  // ---------- Akkumulatoren
  const SC = new Float64Array(nB * NS);
  const SH = new Int32Array(nB * SHAPES.length);
  const cPieces = new Int32Array(nB * nC);
  const cUncut = new Int32Array(nB * nC);
  const cCut = new Int32Array(nB * nC);
  const cRaw = new Int32Array(nB * nC);
  const cPlaced = new Int32Array(nB * nC);
  const cArea = new Float64Array(nB * nC);
  const cRawExact = new Float64Array(nB * nC);
  // Feinsteine je (Bucket, Farbe) – ganze Steine des Feinstein-Materials (Ausbeute 1); in cPieces/cArea/… mitgezählt
  const fPieces = new Int32Array(nB * nC);
  const fPlaced = new Int32Array(nB * nC);
  const fArea = new Float64Array(nB * nC);
  // Teile mit Ausbeute > 1 je (Rohsteingruppe · nC + Farbe): Gesamt in einem wachsenden Array, Abschnitte in je
  // einer Map mit Lauflängen-Puffer (gleiche Farbe und Form folgen in einer Zeile meist aufeinander)
  let sharedTot = new Int32Array(Math.max(16, nC * 4));
  let sharedTotMap: Map<number, number> | null = null;
  const sharedSec: (Map<number, number> | undefined)[] = new Array(nB);
  const lastKey = new Float64Array(nB).fill(-1);
  const pend = new Int32Array(nB);
  const flushShared = (b: number) => {
    if (pend[b] > 0) {
      let m = sharedSec[b];
      if (!m) sharedSec[b] = m = new Map();
      const k = lastKey[b];
      m.set(k, (m.get(k) ?? 0) + pend[b]);
      pend[b] = 0;
    }
  };
  const addShared = (b: number, key: number) => {
    if (b === 0) {
      if (key < sharedTot.length) sharedTot[key]++;
      else if (key < SHARED_ARRAY_MAX) {
        sharedTot = grown(sharedTot, key + 1);
        sharedTot[key]++;
      } else {
        if (!sharedTotMap) sharedTotMap = new Map();
        sharedTotMap.set(key, (sharedTotMap.get(key) ?? 0) + 1);
      }
    } else if (lastKey[b] === key) pend[b]++;
    else {
      flushShared(b);
      lastKey[b] = key;
      pend[b] = 1;
    }
  };
  // Größen je Bucket: Anzahl je Größenindex, Reihenfolge des ersten Auftretens und erste Schnittinfo
  const sizeCnt: Int32Array[] = [];
  const sizeOrd: number[][] = [];
  const sizeRep: CutInfo[][] = [];
  for (let b = 0; b < nB; b++) {
    sizeCnt.push(new Int32Array(b === 0 ? 64 : 0));
    sizeOrd.push([]);
    sizeRep.push([]);
  }

  /**
   * Ein Teil in Bucket b zählen. c: gültiger Farbindex oder −1. thin: 0 –, 1 automatisches Teil unter der
   * Mindestbreite, 2 Freiformteil unter der Mindestbreite. fine: 1 = ganzer Feinstein des Feinstein-Materials.
   */
  const addPiece = (b: number, e: Entry, c: number, placed: number, thin: number, fine = 0): void => {
    const o = b * NS;
    if (e.invalid) {
      // kein Stein (keine Fläche): nicht zählen, nur melden
      SC[o + S_INVALID]++;
      return;
    }
    SC[o + S_PIECES]++;
    SC[o + S_AREA] += e.area;
    if (placed) SC[o + S_PLACED]++;
    if (e.needsCut) SC[o + S_CUT]++;
    if (!e.fits) SC[o + S_NOTFIT]++;
    SH[b * 7 + e.shape]++;
    let cnt = sizeCnt[b];
    const sz = e.size;
    if (sz >= cnt.length) sizeCnt[b] = cnt = grown(cnt, sizeKeys.length);
    if (cnt[sz]++ === 0) {
      sizeOrd[b].push(sz);
      sizeRep[b].push(e.ci);
    }
    if (thin === 1) SC[o + S_THIN]++;
    else if (thin === 2) SC[o + S_THINFREE]++;
    if (c < 0) {
      // Farbindex außerhalb der Palette: geometrisch gezählt, aber keiner Farbe zuzuordnen
      SC[o + S_BADCOLOR]++;
      return;
    }
    const k = b * nC + c;
    cPieces[k]++;
    cArea[k] += e.area;
    if (placed) cPlaced[k]++;
    if (e.needsCut) cCut[k]++;
    else cUncut[k]++;
    if (fine) {
      // ganzer Feinstein (analyzeCut: exaktes Rohsteinmaß, Ausbeute 1): eigener Bedarf beim Feinstein-Material
      fPieces[k]++;
      fArea[k] += e.area;
      if (placed) fPlaced[k]++;
      return;
    }
    if (e.y > 1) {
      addShared(b, e.group * nC + c);
      cRawExact[k] += 1 / e.y;
    } else {
      // ganzer Stein (Ausbeute 1) oder passt nicht in den Rohstein (Ausbeute 0): je Teil ein Rohstein
      cRaw[k]++;
      cRawExact[k] += 1;
    }
  };
  const flagOverlap = (b2: number, row: number, col: number, sum: number) => {
    const ca = layout.colW[col] * layout.rowH[row];
    if (sum > ca + overlapTol(ca)) {
      SC[S_OVERLAP]++;
      if (b2) SC[b2 * NS + S_OVERLAP]++;
    }
  };

  // ---------- Abschnitte
  const rowSec = grid && hasSec ? sectionLookup(grid.rowStarts, layout.rows) : null;
  const colSec = grid && hasSec ? sectionLookup(grid.colStarts, cols) : null;
  const scols = grid ? grid.scols : 0;

  const K = data.kind;
  const P = data.progress;
  const C1 = data.c1;
  const C2 = data.c2;
  const colorOk = (c: number) => (okColor[c] === 1 ? c : -1);

  /** Feinstein-Kennzeichen des zuletzt mit denseEntry geholten Eintrags */
  let denseFine = 0;
  /** Dichter Eintrag (ganze Steine, Dreiecke, Teilsteine) */
  const denseEntry = (slot: number, cc: number, rc: number, i: number, cv: number, row: number, col: number): Entry => {
    const key = slot * perKind + ((cc * nRowCls + rc) * PMAX + i) * nRaw + rawOf[cv + 1];
    let e = useArray ? denseArr[key] : denseMap.get(key);
    if (e === undefined) {
      e = resolve(row, col, i, cv);
      if (useArray) {
        denseArr[key] = e;
        denseFineArr[key] = resolvedFine;
      } else {
        denseMap.set(key, e);
        if (resolvedFine) denseFineMap.set(key, 1);
      }
      denseFine = resolvedFine;
    } else denseFine = useArray ? denseFineArr[key] : (denseFineMap.get(key) ?? 0);
    return e;
  };

  /** Alle Teile einer Zelle ohne Ganzzahl-Schlüssel (Freiform, unbekannte Art, Teilsteine > PMAX): wie bisher */
  const slowCell = (row: number, col: number, kind: number, prog: number, b2: number) => {
    const ps = cellPieces(layout, data, row, col);
    const isFree = kind === K_FREE;
    const isCutKind = kind === K_DIAG_A || kind === K_DIAG_B || kind === K_LINE || kind === K_SUB;
    // nicht gecachte Teile (Freiform, unbekannte Art) einzeln, gecachte über den gemeinsamen Eintrag
    const cached = cellGeomKey(layout, data, row, col) !== null;
    let sum = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const rs = rawFn(p.color);
      const ci = pieceCutInfo(cache, layout, data, row, col, i, p.poly, rs);
      const e = cached ? entryFor(ci) : makeEntry(ci);
      const cv = okColor[p.color] === 1 ? p.color : -1;
      const fine = cv >= 0 && rs.fine && fineRawFor(kind, p.poly, rs) ? 1 : 0;
      let thin = 0;
      if (thinOn && !e.invalid) {
        if (isFree) thin = pieceWidthCheck(p.poly, minPiece as number).ok ? 0 : 2;
        else if (isCutKind) thin = thinFlag(e, row, col, i) ? 1 : 0;
      }
      const bit = (prog >> i) & 1;
      addPiece(0, e, cv, bit, thin, fine);
      if (b2) addPiece(b2, e, cv, bit, thin, fine);
      if (!e.invalid) sum += e.area;
    }
    if (ps.length > 1 || isFree) flagOverlap(b2, row, col, sum);
  };

  for (let row = scan.r0; row < scan.r1; row++) {
    const rc = rowCls[row];
    const bRow = rowSec ? 1 + rowSec[row] * scols : 0;
    const rowBase = row * cols;
    for (let col = scan.c0; col < scan.c1; col++) {
      const idx = rowBase + col;
      const b2 = colSec ? bRow + colSec[col] : 0;
      const kind = K[idx];
      const prog = P[idx];
      if (kind === K_FULL) {
        // häufigster Fall: ein ganzer Stein, Farbe c1
        const cv = colorOk(C1[idx]);
        const e = denseEntry(SLOT_FULL, colCls[col], rc, 0, cv, row, col);
        const bit = prog & 1;
        addPiece(0, e, cv, bit, 0);
        if (b2) addPiece(b2, e, cv, bit, 0);
        continue;
      }
      const cc = colCls[col];
      if (kind === K_DIAG_A || kind === K_DIAG_B) {
        const slot = kind === K_DIAG_A ? SLOT_DIAG_A : SLOT_DIAG_B;
        const ca = colorOk(C1[idx]);
        const cb = colorOk(C2[idx]);
        const ea = denseEntry(slot, cc, rc, 0, ca, row, col);
        const eb = denseEntry(slot, cc, rc, 1, cb, row, col);
        const ta = thinOn && !ea.invalid && thinFlag(ea, row, col, 0) ? 1 : 0;
        const tb = thinOn && !eb.invalid && thinFlag(eb, row, col, 1) ? 1 : 0;
        addPiece(0, ea, ca, prog & 1, ta);
        if (b2) addPiece(b2, ea, ca, prog & 1, ta);
        addPiece(0, eb, cb, (prog >> 1) & 1, tb);
        if (b2) addPiece(b2, eb, cb, (prog >> 1) & 1, tb);
        flagOverlap(b2, row, col, (ea.invalid ? 0 : ea.area) + (eb.invalid ? 0 : eb.area));
        continue;
      }
      if (kind === K_LINE) {
        const prm = data.line.get(idx);
        if (!prm) {
          // ohne Parameter: ganzer Stein (cellPieces), gleicher Schlüssel wie ein ganzer Stein
          const cv = colorOk(C1[idx]);
          const e = denseEntry(SLOT_FULL, cc, rc, 0, cv, row, col);
          const t = thinOn && !e.invalid && thinFlag(e, row, col, 0) ? 1 : 0;
          addPiece(0, e, cv, prog & 1, t);
          if (b2) addPiece(b2, e, cv, prog & 1, t);
          continue;
        }
        const geo = (lineIdOf(prm) * nColCls + cc) * nRowCls + rc;
        let sum = 0;
        for (let i = 0; i < 2; i++) {
          const cv = colorOk(i === 0 ? C1[idx] : C2[idx]);
          const key = (geo * 2 + i) * nRaw + rawOf[cv + 1];
          let e = lineEntries.get(key);
          if (e === undefined) lineEntries.set(key, (e = resolve(row, col, i, cv)));
          const t = thinOn && !e.invalid && thinFlag(e, row, col, i) ? 1 : 0;
          const bit = (prog >> i) & 1;
          addPiece(0, e, cv, bit, t);
          if (b2) addPiece(b2, e, cv, bit, t);
          if (!e.invalid) sum += e.area;
        }
        flagOverlap(b2, row, col, sum);
        continue;
      }
      if (kind === K_SUB) {
        const sub = data.sub.get(idx);
        const len = sub ? sub.length : 1;
        const k = sub ? Math.round(Math.sqrt(len)) : 1;
        const n = sub ? k * k : 1;
        if (n <= PMAX) {
          const slot = kindSlot(len);
          let sum = 0;
          for (let i = 0; i < n; i++) {
            const cv = colorOk(sub ? sub[i] : C1[idx]);
            const e = denseEntry(slot, cc, rc, i, cv, row, col);
            const fine = cv >= 0 ? denseFine : 0;
            const t = thinOn && !e.invalid && thinFlag(e, row, col, i) ? 1 : 0;
            const bit = (prog >> i) & 1;
            addPiece(0, e, cv, bit, t, fine);
            if (b2) addPiece(b2, e, cv, bit, t, fine);
            if (!e.invalid) sum += e.area;
          }
          if (n > 1) flagOverlap(b2, row, col, sum);
          continue;
        }
      }
      slowCell(row, col, kind, prog, b2);
    }
  }

  // Freiformzellen mit ungültigen Teilen (validateFreePieces) je Bucket
  if (data.free.size) {
    for (const f of invalidFreeCells(layout, data, scan)) {
      SC[S_BADFREE]++;
      if (rowSec && colSec) SC[(1 + rowSec[f.row] * scols + colSec[f.col]) * NS + S_BADFREE]++;
    }
  }

  /** Zähler der Teile mit Ausbeute > 1 eines Buckets als Map (Schlüssel Rohsteingruppe · nC + Farbe) */
  const sharedOf = (b: number): Map<number, number> | undefined => {
    if (b > 0) {
      flushShared(b);
      return sharedSec[b];
    }
    const m = new Map<number, number>(sharedTotMap ?? []);
    for (let i = 0; i < sharedTot.length; i++) if (sharedTot[i] > 0) m.set(i, sharedTot[i]);
    return m;
  };
  const fin = (b: number, rg: Range): Stats =>
    finalizeStats(layout, palette, rawFn, reservePct, opts.groutDepthMm, rg, {
      sc: SC.subarray(b * NS, (b + 1) * NS),
      shapes: SH.subarray(b * 7, (b + 1) * 7),
      pieces: cPieces.subarray(b * nC, (b + 1) * nC),
      uncut: cUncut.subarray(b * nC, (b + 1) * nC),
      cut: cCut.subarray(b * nC, (b + 1) * nC),
      raw: cRaw.subarray(b * nC, (b + 1) * nC),
      placed: cPlaced.subarray(b * nC, (b + 1) * nC),
      area: cArea.subarray(b * nC, (b + 1) * nC),
      rawExact: cRawExact.subarray(b * nC, (b + 1) * nC),
      finePieces: fPieces.subarray(b * nC, (b + 1) * nC),
      finePlaced: fPlaced.subarray(b * nC, (b + 1) * nC),
      fineArea: fArea.subarray(b * nC, (b + 1) * nC),
      shared: sharedOf(b),
      groupYield,
      sizeKeys,
      sizeCount: sizeCnt[b],
      sizeOrder: sizeOrd[b],
      sizeRep: sizeRep[b],
      thinOn,
    });
  return {
    total: fin(0, scan),
    perSection: grid && hasSec ? grid.sections.map((s, i) => fin(1 + i, { r0: s.r0, r1: s.r1, c0: s.c0, c1: s.c1 })) : [],
  };
}

/** Rohdaten eines Buckets für finalizeStats */
interface BucketView {
  sc: Float64Array;
  shapes: Int32Array;
  pieces: Int32Array;
  uncut: Int32Array;
  cut: Int32Array;
  /** Rohsteine aus Teilen mit Ausbeute ≤ 1 (je Teil einer) */
  raw: Int32Array;
  placed: Int32Array;
  area: Float64Array;
  rawExact: Float64Array;
  /** davon ganze Feinsteine je Farbe (in pieces/area/placed enthalten) */
  finePieces: Int32Array;
  finePlaced: Int32Array;
  fineArea: Float64Array;
  /** (Rohsteingruppe · Farbanzahl + Farbe) → Anzahl Teile mit Ausbeute > 1 */
  shared: Map<number, number> | undefined;
  groupYield: number[];
  sizeKeys: string[];
  sizeCount: Int32Array;
  sizeOrder: number[];
  /** erste Schnittinfo je Größe (Reihenfolge wie sizeOrder) – liefert die gerundeten Maße wie bisher */
  sizeRep: CutInfo[];
  thinOn: boolean;
}

/**
 * Abschluss einer Statistik aus den gezählten Werten eines Bereichs: Rohsteine je Schnittform-Gruppe,
 * Reserve, Packungen/Kosten je Farbe und Material, Flächen, Verschnitt, Fugenmasse. Gleiche Rechnung für die
 * Gesamtstatistik und jeden Abschnitt.
 */
function finalizeStats(
  layout: Layout,
  palette: PaletteColor[],
  rawFn: RawSizeFn,
  reservePct: number,
  groutDepthMm: number,
  rg: Range,
  v: BucketView,
): Stats {
  const nC = palette.length;
  const perColor: ColorStat[] = palette.map((_, i) => {
    const r = rawFn(i);
    return {
      color: i,
      pieces: v.pieces[i],
      uncut: v.uncut[i],
      cut: v.cut[i],
      area: v.area[i],
      rawExact: v.rawExact[i],
      raw: v.raw[i],
      rawWithReserve: 0,
      rawW: r.w,
      rawH: r.h,
      material: r.material,
      materialMissing: !!r.materialMissing,
      rawAssumedGrid: !!r.rawAssumedGrid,
      placed: v.placed[i],
    };
  });
  // Teile mit Ausbeute > 1: gleiche Schnittformen je Farbe zusammenfassen, je Gruppe aufrunden (rawFromSharedCuts)
  if (v.shared && nC > 0) {
    const add = new Float64Array(nC);
    for (const [key, n] of v.shared) {
      const c = key % nC;
      const g = (key - c) / nC;
      add[c] += Math.ceil(n / v.groupYield[g]);
    }
    for (let c = 0; c < nC; c++) perColor[c].raw += add[c];
  }

  const sc = v.sc;
  const pieces = sc[S_PIECES];
  const stoneArea = sc[S_AREA];
  const cutPieces = sc[S_CUT];
  const invalidColorPieces = sc[S_BADCOLOR];
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
    cs.rawWithReserve = withReserve(cs.raw, reservePct);
    rawTotal += cs.raw;
    rawRes += cs.rawWithReserve;
    rawArea += cs.raw * cs.rawW * cs.rawH;
    colorStoneArea += cs.area;
    if (cs.materialMissing) missingMaterials.push(cs.color);
    const fp = v.finePieces[cs.color];
    const fr = fp > 0 ? rawFn(cs.color).fine : undefined;
    const mat = cs.material;
    // Packungen/Kosten nur dieser Farbe beim Grundstein-Material (ohne Feinsteine wie bisher)
    if (mat && isPositive(mat.piecesPerPack) && cs.pieces - (fr ? fp : 0) > 0) {
      cs.packs = packsFor(cs.rawWithReserve, mat.piecesPerPack);
      if (isPositive(mat.price)) cs.cost = cs.packs * mat.price;
    }
    if (fr && fr.material) {
      const f: FineColorStat = {
        material: fr.material,
        rawW: fr.w,
        rawH: fr.h,
        pieces: fp,
        area: v.fineArea[cs.color],
        placed: v.finePlaced[cs.color],
        raw: fp,
        rawWithReserve: withReserve(fp, reservePct),
      };
      if (isPositive(fr.material.piecesPerPack)) {
        f.packs = packsFor(f.rawWithReserve, fr.material.piecesPerPack);
        if (isPositive(fr.material.price)) f.cost = f.packs * fr.material.price;
      }
      cs.fine = f;
      rawTotal += f.raw;
      rawRes += f.rawWithReserve;
      rawArea += f.raw * f.rawW * f.rawH;
    }
  }
  const mt = materialTotals(perColor, layout);
  const finishedArea = fw * fh;
  const jointArea = finishedArea - stoneArea;
  const groutMl = (jointArea * groutDepthMm) / 1000;
  // Verschnitt nur über Steine mit gültiger Farbe – nur für sie gibt es einen Rohsteinbedarf
  const wasteArea = Math.max(0, rawArea - colorStoneArea);
  const sh = v.shapes;
  const perSize: SizeStat[] = v.sizeOrder.map((id, i) => {
    const ci = v.sizeRep[i];
    return { key: v.sizeKeys[id], shape: ci.shape, w: Math.round(ci.w * 10) / 10, h: Math.round(ci.h * 10) / 10, count: v.sizeCount[id] };
  });
  const out: Stats = {
    gridPositions: (rg.r1 - rg.r0) * (rg.c1 - rg.c0),
    pieces,
    placed: sc[S_PLACED],
    finishedW: fw,
    finishedH: fh,
    finishedArea,
    stoneArea,
    jointArea,
    invalidFreeCells: sc[S_BADFREE],
    perColor,
    perMaterial: mt.perMaterial,
    perShape: { square: sh[0], rectangle: sh[1], triangle: sh[2], rhombus: sh[3], trapezoid: sh[4], parallelogram: sh[5], custom: sh[6] },
    perSize: perSize.sort((a, b) => b.count - a.count),
    cutPieces,
    uncutPieces: pieces - cutPieces,
    notFitting: sc[S_NOTFIT],
    invalidColorPieces,
    invalidPieces: sc[S_INVALID],
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
    overlapCells: sc[S_OVERLAP],
  };
  if (v.thinOn) {
    out.thinPieces = sc[S_THIN];
    out.thinFreePieces = sc[S_THINFREE];
  }
  return out;
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
