/**
 * w6-fine-tiles – Feinsteine in echten, kaufbaren Größen:
 *  1. Feinstein-Größe (fineTileSize) und Formoptionen (withShapeOption, canonShapes).
 *  2. Feinbereiche (Region 'fine'): k×k-Feinsteine werden erzwungen, exakt gezählt; ohne Feinbereich bitgleich.
 *  3. „Feinere Steine in Bereichen bevorzugen“: nur in Gesichts-/Detailbereichen wirksam.
 *  4. Feinstein-Material je Farbe: passende Teilsteine sind ganze, ungeschnittene Feinsteine eines eigenen Materials –
 *     Gesamtzahl unverändert, ganze Steine bleiben beim Grundstein (notFitting 0), eigene Einkaufszeile.
 *  5. Reine UI-Helfer (Zuordnung automatisch, Übertragen über eine Neuberechnung).
 */
import { describe, expect, it } from 'vitest';
import { buildCsv } from '../src/core/csv';
import { deviationSummary } from '../src/core/deviation';
import { regionMask } from '../src/core/imageOps';
import { computeSections } from '../src/core/layout';
import { computeMosaic, type ComputeResult } from '../src/core/mosaic';
import { cloneMosaic } from '../src/core/serialize';
import { shoppingRows } from '../src/core/shoppingCsv';
import { piecesPerColor } from '../src/core/paletteOps';
import { analyzeCut, cellPieceCount, cellPieces } from '../src/core/pieces';
import { computeAllStats, computeStats, CutCache, fineRawFor, makeRawSizeFn, pieceCutInfo, pieceRawSize, type Stats } from '../src/core/stats';
import {
  canonShapes,
  CellKind,
  DEFAULT_SHAPES,
  fineTileSize,
  materialHasSize,
  Rec,
  withShapeOption,
  type Material,
  type PaletteColor,
  type Region,
} from '../src/core/types';
import { autoFineMaterials, carryFineMaterials, withFineMaterial } from '../src/ui/project/StepColors';
import { baseParams, materialFixed, MATERIALS12, sampleSetup } from './w1-mosaic-core.fixtures';

const EYES: Region = { id: 'eyes', type: 'fine', shape: 'rect', x: 0.33, y: 0.38, w: 0.34, h: 0.1 };
const OPTS = { reservePct: 10, groutDepthMm: 3 };

function mat(id: string, hex: string, w: number, h = w, extra: Partial<Material> = {}): Material {
  return { id, type: 'glass', manufacturer: 'Test', product: 'Glas', colorNumber: id.toUpperCase(), colorName: id, hex, lengthMm: h, widthMm: w, thicknessMm: 4, price: 0, packageSize: '', piecesPerPack: 0, ...extra };
}

/** Zellen, deren Mitte im Feinbereich liegt – dieselbe Pixelregel wie computeMosaic (unabhängig nachgezählt). */
function cellsInRegion(res: { layout: ReturnType<typeof sampleSetup>['layout']; img: ReturnType<typeof sampleSetup>['img'] }, regions: Region[]): number[] {
  const { layout, img } = res;
  const W = img.width;
  const H = img.height;
  const m = regionMask(W, H, regions, ['fine']);
  const sx = W / layout.finishedW;
  const sy = H / layout.finishedH;
  const out: number[] = [];
  for (let row = 0; row < layout.rows; row++)
    for (let col = 0; col < layout.cols; col++) {
      const cx = Math.min(W - 1, Math.max(0, Math.floor((layout.colX[col] + layout.colW[col] / 2) * sx)));
      const cy = Math.min(H - 1, Math.max(0, Math.floor((layout.rowY[row] + layout.rowH[row] / 2) * sy)));
      if (m[cy * W + cx] > 0) out.push(row * layout.cols + col);
    }
  return out;
}

/** Porträt mit Gesichtsbereich (wie Golden) plus Feinbereich über den Augen, eigene Materialpalette (12 Farben). */
let cached: { su: ReturnType<typeof sampleSetup>; res: ComputeResult; regions: Region[] } | null = null;
function portraitFine() {
  if (cached) return cached;
  const su = sampleSetup('portrait');
  const regions = [...su.regions, EYES];
  const res = computeMosaic(su.img, baseParams(su, { regions, paletteMode: 'materials', fixedPalette: materialFixed(MATERIALS12) }));
  cached = { su, res, regions };
  return cached;
}

/** Feinstein-Materialien 2 × 2 mm in den Farben der 12 Grundmaterialien (Portrait: 5-mm-Steine, 1 mm Fuge → 2×2 = 2 mm). */
const FINE12: Material[] = MATERIALS12.map((m) => mat(`f-${m.id}`, m.hex, 2, 2, { colorName: `${m.colorName} fein`, piecesPerPack: 100, price: 3 }));
/** Grundmaterialien im Rastermaß 5 × 5 mm (sonst wäre jeder ganze Stein aus einem 10er-Stein geschnitten) */
const BASE12: Material[] = MATERIALS12.map((m) => ({ ...m, lengthMm: 5, widthMm: 5, piecesPerPack: 200, price: 9 }));

function withFine(palette: PaletteColor[], fineMats: Material[] | null): PaletteColor[] {
  return palette.map((p) => {
    const id = p.materialId ? `f-${p.materialId}` : undefined;
    return fineMats && id && fineMats.some((m) => m.id === id) ? { ...p, fineMaterialId: id } : withFineMaterial(p, undefined);
  });
}

describe('w6-fine-tiles: Feinstein-Größe und Formoptionen', () => {
  it('fineTileSize: (Steinmaß + Fuge) / k − Fuge, exakt nur bei ganzen Millimetern', () => {
    expect(fineTileSize(10, 10, 2, 2)).toEqual({ w: 4, h: 4, exact: true, mm: 4 });
    expect(fineTileSize(5, 5, 1, 2)).toEqual({ w: 2, h: 2, exact: true, mm: 2 });
    expect(fineTileSize(8, 8, 1, 3)).toEqual({ w: 2, h: 2, exact: true, mm: 2 });
    expect(fineTileSize(12, 12, 2, 2)).toEqual({ w: 5, h: 5, exact: true, mm: 5 });
    const f = fineTileSize(8, 8, 1, 2);
    expect(f.exact).toBe(false);
    expect(f.w).toBe(3.5);
    expect(f.mm).toBeUndefined();
    expect(fineTileSize(8, 8, 1.5, 2).exact).toBe(false); // 3,25 mm
    // gleiche Formel wie subRects (pieces.ts): Teilsteinmaß eines ganzen Rastersteins
    const ps = cellPieces({ cols: 1, rows: 1, colX: new Float64Array([0]), colW: new Float64Array([10]), rowY: new Float64Array([0]), rowH: new Float64Array([10]), finishedW: 10, finishedH: 10, requestedW: 10, requestedH: 10, restX: 0, restY: 0, tileW: 10, tileH: 10, joint: 2, edgeMode: 'whole' }, { cols: 1, rows: 1, kind: new Uint8Array([CellKind.SUB]), c1: new Uint16Array(1), c2: new Uint16Array(1), sub: new Map([[0, new Uint16Array(4)]]), line: new Map(), free: new Map(), progress: new Uint16Array(1), rec: new Uint8Array(1) }, 0, 0);
    expect(analyzeCut(ps[0].poly, 4, 4).needsCut).toBe(false);
  });

  it('materialHasSize: exakt (± DIM_TOL), auch gedreht', () => {
    expect(materialHasSize(mat('a', '#000000', 4), 4, 4)).toBe(true);
    expect(materialHasSize(mat('a', '#000000', 4.04), 4, 4)).toBe(true);
    expect(materialHasSize(mat('a', '#000000', 4.06), 4, 4)).toBe(false);
    expect(materialHasSize(mat('a', '#000000', 2, 4), 4, 2)).toBe(true);
    expect(materialHasSize(mat('a', '#000000', 0, 0), 0, 0)).toBe(false);
  });

  it('withShapeOption: neue Felder nur bei Abweichung, feste Reihenfolge im Schlüssel', () => {
    const a = withShapeOption({ ...DEFAULT_SHAPES }, { preferSubInRegions: false, fineTileMm: undefined });
    expect('preferSubInRegions' in a).toBe(false);
    expect('fineTileMm' in a).toBe(false);
    expect(JSON.stringify(canonShapes(a))).toBe(JSON.stringify(canonShapes({ ...DEFAULT_SHAPES })));
    const b = withShapeOption({ ...DEFAULT_SHAPES }, { preferSubInRegions: true, fineTileMm: 2 });
    const c = withShapeOption(withShapeOption({ ...DEFAULT_SHAPES }, { fineTileMm: 2 }), { preferSubInRegions: true });
    expect(JSON.stringify(canonShapes(b))).toBe(JSON.stringify(canonShapes(c)));
    expect(withShapeOption(b, { fineTileMm: Number.NaN }).fineTileMm).toBeUndefined();
  });
});

describe('w6-fine-tiles: Feinbereiche in der Berechnung', () => {
  it('Porträt mit Feinbereich über den Augen: ≥ 50 % der Zellen darin sind Feinsteine, exakt gezählt', () => {
    const { su, res, regions } = portraitFine();
    const inside = cellsInRegion(su, regions);
    expect(inside.length).toBeGreaterThan(20);
    const sub = inside.filter((i) => res.data.kind[i] === CellKind.SUB);
    expect(sub.length / inside.length).toBeGreaterThanOrEqual(0.5);
    const d = res.diagnostics.fineRegions!;
    expect(d).toBeDefined();
    expect(d.cells).toBe(inside.length);
    expect(d.sub).toBe(sub.length);
    expect(d.k).toBe(2);
    // nicht als Feinsteine: nur Zellen, deren Teilsteine die Mindestbreite verfehlen (gekürzte Randzellen)
    expect(d.sub + d.tooSmall).toBe(d.cells);
    for (const i of sub) expect(res.data.sub.get(i)!.length).toBe(4);
    // keine erzwungene Feinstein-Zelle trägt zugleich eine Empfehlung „feinere Steine“
    for (const i of sub) expect(res.data.rec[i] & Rec.FINER).toBe(0);
  });

  it('Invarianten: Steine = Σ Zellteile, Steinfläche + Fugen = Gesamtfläche, Fotofarben exakt', () => {
    const { su, res } = portraitFine();
    const { layout } = su;
    const st = computeStats(layout, res.data, res.palette, [], OPTS);
    let pieces = 0;
    let area = 0;
    for (let row = 0; row < layout.rows; row++)
      for (let col = 0; col < layout.cols; col++) {
        pieces += cellPieceCount(res.data, row * layout.cols + col);
        for (const p of cellPieces(layout, res.data, row, col)) area += analyzeCut(p.poly, layout.tileW, layout.tileH).area;
      }
    expect(st.pieces).toBe(pieces);
    expect(st.perColor.reduce((a, c) => a + c.pieces, 0) + st.invalidColorPieces).toBe(st.pieces);
    expect(st.stoneArea).toBeCloseTo(area, 6);
    expect(st.stoneArea + st.jointArea).toBeCloseTo(layout.finishedW * layout.finishedH, 6);
    expect(st.overlapCells).toBe(0);
    // Fotofarben (w5-target-colours): auch erzwungene Feinsteine sind exakt die Zahlen der Berechnung
    const sum = deviationSummary(res.data, res.palette, '2000');
    expect(sum.pieces).toBe(piecesPerColor(res.data, res.palette.length).reduce((a, b) => a + b, 0));
    expect(sum.mean).toBe(res.diagnostics.meanDeltaE);
    expect(sum.max).toBe(res.diagnostics.maxDeltaE);
  });

  it('ohne Feinbereich: bitgleich (keine Diagnose fineRegions); außerhalb des Feinbereichs gleiche Formen', () => {
    const su = sampleSetup('portrait');
    const p = baseParams(su, { paletteMode: 'materials', fixedPalette: materialFixed(MATERIALS12) });
    const a = computeMosaic(su.img, p);
    expect(a.diagnostics.fineRegions).toBeUndefined();
    const { res, regions } = portraitFine();
    const inside = new Set(cellsInRegion(su, regions));
    // Formwahl je Zelle hängt nur von der Zelle ab: außerhalb des Feinbereichs dieselbe Zellart
    let diff = 0;
    for (let i = 0; i < a.data.kind.length; i++) if (!inside.has(i) && a.data.kind[i] !== res.data.kind[i]) diff++;
    expect(diff).toBe(0);
  });

  it('„Feinere Steine“ aus: im Feinbereich wird nichts erzwungen (und gemeldet)', () => {
    const su = sampleSetup('portrait');
    const regions = [EYES];
    const res = computeMosaic(su.img, baseParams(su, { regions, shapes: { ...DEFAULT_SHAPES, subdivide: false } }));
    const d = res.diagnostics.fineRegions!;
    expect(d.subdivideOff).toBe(true);
    expect(d.sub).toBe(0);
    expect(res.data.sub.size).toBe(0);
  });

  it('Teilsteine schmaler als die Mindestbreite: keine Feinsteine, alle Zellen als tooSmall gezählt', () => {
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su, { regions: [EYES], shapes: { ...DEFAULT_SHAPES, minPieceMm: 2.5 } }));
    const d = res.diagnostics.fineRegions!;
    expect(d.sub).toBe(0);
    expect(d.tooSmall).toBe(d.cells);
    expect(d.cells).toBeGreaterThan(0);
  });

  it('k = 3 im Feinbereich (city: 10/2 → 3×3 = 2 mm)', () => {
    const su = sampleSetup('city');
    const region: Region = { id: 'f', type: 'fine', shape: 'ellipse', x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    const res = computeMosaic(su.img, baseParams(su, { regions: [region], shapes: { ...DEFAULT_SHAPES, subdivK: 3 } }));
    const inside = cellsInRegion(su, [region]);
    const d = res.diagnostics.fineRegions!;
    expect(d.cells).toBe(inside.length);
    expect(d.sub).toBe(inside.filter((i) => res.data.kind[i] === CellKind.SUB).length);
    expect(d.sub).toBeGreaterThan(0.5 * d.cells);
    for (const i of inside) if (res.data.kind[i] === CellKind.SUB) expect(res.data.sub.get(i)!.length).toBe(9);
  });

  it('„Feinere Steine in Bereichen bevorzugen“: mehr Feinsteine im Gesicht, außerhalb unverändert', () => {
    const su = sampleSetup('portrait');
    const p = baseParams(su, { paletteMode: 'materials', fixedPalette: materialFixed(MATERIALS12) });
    const off = computeMosaic(su.img, p);
    const on = computeMosaic(su.img, { ...p, shapes: { ...DEFAULT_SHAPES, preferSubInRegions: true } });
    // gleiche Formwahl wie ohne die Option, wenn sie ausgeschaltet ist (Feld fehlt bzw. false)
    const offFalse = computeMosaic(su.img, { ...p, shapes: { ...DEFAULT_SHAPES, preferSubInRegions: false } });
    expect(Array.from(offFalse.data.kind)).toEqual(Array.from(off.data.kind));
    const faceMask = regionMask(su.img.width, su.img.height, su.regions, ['face']);
    const W = su.img.width;
    const sx = W / su.layout.finishedW;
    const sy = su.img.height / su.layout.finishedH;
    let subOff = 0;
    let subOn = 0;
    let outsideDiff = 0;
    for (let row = 0; row < su.layout.rows; row++)
      for (let col = 0; col < su.layout.cols; col++) {
        const i = row * su.layout.cols + col;
        const cx = Math.min(W - 1, Math.floor((su.layout.colX[col] + su.layout.colW[col] / 2) * sx));
        const cy = Math.min(su.img.height - 1, Math.floor((su.layout.rowY[row] + su.layout.rowH[row] / 2) * sy));
        if (faceMask[cy * W + cx] > 0) {
          if (off.data.kind[i] === CellKind.SUB) subOff++;
          if (on.data.kind[i] === CellKind.SUB) subOn++;
        } else if (off.data.kind[i] !== on.data.kind[i]) outsideDiff++;
      }
    expect(subOn).toBeGreaterThan(subOff);
    expect(outsideDiff).toBe(0);
    expect(on.diagnostics.subCellsInRegions).toBe(subOn);
  });
});

describe('w6-fine-tiles: Feinstein-Material in Statistik, Einkauf und Schnittinfo', () => {
  const setup = () => {
    const { su, res } = portraitFine();
    const mats = [...BASE12, ...FINE12];
    const plain = res.palette.map((p) => withFineMaterial(p, undefined));
    const fine = withFine(res.palette, FINE12);
    return { layout: su.layout, data: res.data, mats, plain, fine };
  };

  /** Teilsteine mit Außenmaß 2 × 2 mm (unabhängig nachgezählt) und alle Teilsteine */
  const subCount = (layout: ReturnType<typeof sampleSetup>['layout'], data: ComputeResult['data']) => {
    let exact = 0;
    let all = 0;
    for (let row = 0; row < layout.rows; row++)
      for (let col = 0; col < layout.cols; col++) {
        if (data.kind[row * layout.cols + col] !== CellKind.SUB) continue;
        for (const p of cellPieces(layout, data, row, col)) {
          all++;
          const xs = p.poly.map((q) => q.x);
          const ys = p.poly.map((q) => q.y);
          if (Math.abs(Math.max(...xs) - Math.min(...xs) - 2) < 0.05 && Math.abs(Math.max(...ys) - Math.min(...ys) - 2) < 0.05) exact++;
        }
      }
    return { exact, all };
  };

  it('Gesamtzahl unverändert; genau die passenden Teilsteine sind ganze Feinsteine; ganze Steine beim Grundstein', () => {
    const { layout, data, mats, plain, fine } = setup();
    const a = computeStats(layout, data, plain, mats, OPTS);
    const b = computeStats(layout, data, fine, mats, OPTS);
    const { exact, all } = subCount(layout, data);
    expect(all).toBeGreaterThan(100);
    expect(exact).toBeGreaterThan(0);
    // Gesamtzahlen, Flächen, Formen, Größen: unverändert
    expect(b.pieces).toBe(a.pieces);
    expect(b.stoneArea).toBe(a.stoneArea);
    expect(b.perShape).toEqual(a.perShape);
    expect(b.perSize).toEqual(a.perSize);
    expect(b.perColor.map((c) => c.pieces)).toEqual(a.perColor.map((c) => c.pieces));
    // Feinsteine: genau die Teilsteine mit Außenmaß 2 × 2 mm
    const finePieces = b.perColor.reduce((s, c) => s + (c.fine?.pieces ?? 0), 0);
    expect(finePieces).toBe(exact);
    // vorher: geschnitten aus dem 5-mm-Grundstein; jetzt ungeschnitten
    expect(b.cutPieces).toBe(a.cutPieces - exact);
    expect(b.uncutPieces).toBe(a.uncutPieces + exact);
    // ganze Steine bleiben beim Grundstein-Material: nichts passt nicht
    expect(a.notFitting).toBe(0);
    expect(b.notFitting).toBe(0);
    for (const cs of b.perColor) {
      expect(cs.pieces).toBe(cs.cut + cs.uncut);
      if (cs.fine) {
        expect(cs.fine.material.widthMm).toBe(2);
        expect(cs.fine.raw).toBe(cs.fine.pieces);
        expect(cs.material?.widthMm).toBe(5);
      }
    }
    // Summen: Rohsteine = Σ Grund + Fein, mit Reserve = Σ Bedarf je Material
    expect(b.rawTotal).toBe(b.perColor.reduce((s, c) => s + c.raw + (c.fine?.raw ?? 0), 0));
    expect(b.rawWithReserveTotal).toBe(b.perColor.reduce((s, c) => s + c.rawWithReserve + (c.fine?.rawWithReserve ?? 0), 0));
    expect(b.perMaterial.reduce((s, m) => s + m.need, 0)).toBe(b.rawWithReserveTotal);
    expect(b.perMaterial.reduce((s, m) => s + m.pieces, 0)).toBe(b.pieces - b.invalidColorPieces);
    expect(b.rawArea).toBeCloseTo(b.perColor.reduce((s, c) => s + c.raw * c.rawW * c.rawH + (c.fine ? c.fine.raw * c.fine.rawW * c.fine.rawH : 0), 0), 6);
    // eigene Einkaufszeilen für die Feinstein-Materialien
    const fineRows = b.perMaterial.filter((m) => m.materialId?.startsWith('f-'));
    expect(fineRows.length).toBeGreaterThan(0);
    expect(fineRows.reduce((s, m) => s + m.pieces, 0)).toBe(exact);
    for (const r of fineRows) {
      expect(r.rawW).toBe(2);
      expect(r.packs).toBe(Math.ceil(r.need / 100));
      expect(r.cost).toBe(r.packs! * 3);
    }
    expect(b.totalCost).toBeCloseTo(b.perMaterial.reduce((s, m) => s + (m.cost ?? 0), 0), 9);
    // Teilsteine sind 4 mm² statt geschnitten aus 25 mm²: weniger Verschnitt
    expect(b.wasteArea).toBeLessThan(a.wasteArea);
  });

  it('Teilsteine sind ungeschnitten genau dann, wenn das Feinstein-Maß dem Teilsteinmaß entspricht', () => {
    const { layout, mats } = setup();
    const { res } = portraitFine();
    // Kopie mit k×k-Teilung in einer gekürzten Randzelle (letzte Spalte/Zeile): ihre Teilsteine sind schmaler als 2 mm
    // bzw. anders hoch – sie dürfen nie als Feinstein gelten
    const data = cloneMosaic(res.data);
    const edge = (layout.rows - 1) * layout.cols + (layout.cols - 1);
    expect(layout.colW[layout.cols - 1] < layout.tileW || layout.rowH[layout.rows - 1] < layout.tileH).toBe(true);
    data.kind[edge] = CellKind.SUB;
    data.sub.set(edge, new Uint16Array([data.c1[edge], data.c1[edge], data.c1[edge], data.c1[edge]]));
    // Feinstein-Material 3 × 3 mm: passt zu keinem Teilstein → Statistik wie ohne Feinsteine (Teile bleiben geschnitten)
    const wrong = MATERIALS12.map((m) => mat(`f-${m.id}`, m.hex, 3));
    const wrongPal = withFine(res.palette, wrong);
    const plain = res.palette.map((p) => withFineMaterial(p, undefined));
    const all = [...BASE12, ...wrong];
    expect(JSON.stringify(computeStats(layout, data, wrongPal, all, OPTS))).toBe(JSON.stringify(computeStats(layout, data, plain, all, OPTS)));
    // Feinstein-Material fehlt (gelöscht): ebenso unverändert, gemeldet als fineMissing
    const missing = res.palette.map((p) => ({ ...p, fineMaterialId: 'gibt-es-nicht' }));
    expect(JSON.stringify(computeStats(layout, data, missing, mats, OPTS))).toBe(JSON.stringify(computeStats(layout, data, plain, mats, OPTS)));
    expect(makeRawSizeFn(layout, missing, mats)(0).fineMissing).toBe(true);
    // je Teil: Schnittinfo (pieceCutInfo, wie PDF/CSV) und Rohsteinmaß (pieceRawSize, wie Steindetail) stimmen überein
    const fine = withFine(res.palette, FINE12);
    const raw = makeRawSizeFn(layout, fine, mats);
    const cache = new CutCache();
    let checkedFine = 0;
    let checkedCut = 0;
    for (let row = 0; row < layout.rows; row++)
      for (let col = 0; col < layout.cols; col++) {
        const kind = data.kind[row * layout.cols + col];
        const ps = cellPieces(layout, data, row, col);
        ps.forEach((p, i) => {
          const rs = raw(p.color);
          const ci = pieceCutInfo(cache, layout, data, row, col, i, p.poly, rs);
          const used = pieceRawSize(layout, data, row, col, p.poly, rs);
          expect(ci.rawW).toBe(used.w);
          const fr = fineRawFor(kind, p.poly, rs);
          if (fr) {
            expect(kind).toBe(CellKind.SUB);
            expect(ci.needsCut).toBe(false);
            expect(ci.yieldPerRaw).toBe(1);
            expect(ci.rawW).toBe(2);
            checkedFine++;
          } else {
            expect(ci.rawW).toBe(5);
            if (kind === CellKind.SUB) {
              expect(ci.needsCut).toBe(true); // kleinerer Teilstein einer gekürzten Randzelle: geschnitten
              checkedCut++;
            }
          }
        });
      }
    expect(checkedFine).toBeGreaterThan(0);
    expect(checkedCut).toBeGreaterThan(0);
    // CSV (über pieceCutInfo): Spalte „Zuschnitt“ zählt die Feinsteine als ungeschnitten – wie die Statistik
    const st = computeStats(layout, data, fine, mats, OPTS);
    const csv = buildCsv(layout, data, fine, mats, computeSections(layout, 1000, 1000), null, false);
    const rows = csv.split('\r\n').slice(1).filter(Boolean);
    expect(rows.length).toBe(st.pieces);
    expect(rows.filter((r) => r.split(';')[14] === 'nein').length).toBe(st.uncutPieces);
  });

  it('wenn statt Feinstein-Material das Grundmaterial 2 × 2 wäre: ganze Steine passen nicht (darum zwei Materialien)', () => {
    const { layout, data } = setup();
    const { res } = portraitFine();
    const small = MATERIALS12.map((m) => mat(m.id, m.hex, 2));
    const st = computeStats(layout, data, res.palette.map((p) => withFineMaterial(p, undefined)), small, OPTS);
    expect(st.notFitting).toBeGreaterThan(0);
  });

  it('Abschnitte: Σ Feinsteine der Abschnitte = Gesamt, Gesamt = computeStats', () => {
    const { layout, data, mats, fine } = setup();
    const grid = computeSections(layout, 120, 120);
    const all = computeAllStats(layout, data, fine, mats, OPTS, grid);
    expect(JSON.stringify(all.total)).toBe(JSON.stringify(computeStats(layout, data, fine, mats, OPTS)));
    const sumFine = (s: Stats) => s.perColor.reduce((a, c) => a + (c.fine?.pieces ?? 0), 0);
    expect(all.perSection.reduce((a, s) => a + sumFine(s), 0)).toBe(sumFine(all.total));
    expect(all.perSection.reduce((a, s) => a + s.pieces, 0)).toBe(all.total.pieces);
    // gleicher Bereich einzeln gezählt (computeStats mit range): gleiche Zahlen je Abschnitt (die letzten Bits der
    // Flächen hängen – wie schon vor diesem Paket – vom ersten Vertreter einer Geometrieklasse ab)
    grid.sections.forEach((sec, i) => {
      const one = computeStats(layout, data, fine, mats, OPTS, { r0: sec.r0, r1: sec.r1, c0: sec.c0, c1: sec.c1 });
      const ps = all.perSection[i];
      expect([ps.pieces, ps.cutPieces, ps.uncutPieces, ps.rawTotal, ps.rawWithReserveTotal, ps.notFitting]).toEqual([one.pieces, one.cutPieces, one.uncutPieces, one.rawTotal, one.rawWithReserveTotal, one.notFitting]);
      expect(ps.perColor.map((c) => [c.pieces, c.raw, c.fine?.pieces ?? 0, c.fine?.rawWithReserve ?? 0])).toEqual(one.perColor.map((c) => [c.pieces, c.raw, c.fine?.pieces ?? 0, c.fine?.rawWithReserve ?? 0]));
      expect(ps.perMaterial.map((m) => [m.materialId, m.pieces, m.need])).toEqual(one.perMaterial.map((m) => [m.materialId, m.pieces, m.need]));
    });
  });

  it('Einkaufsliste: Feinstein-Zeile ohne „Rastermaß angenommen“, auch wenn die Farbe kein Grundmaterial hat', () => {
    const { layout, data } = setup();
    const { res } = portraitFine();
    // Farben ohne Grundmaterial (Rastermaß angenommen), aber mit Feinstein-Material 2 × 2 mm
    const pal = withFine(res.palette, FINE12).map((p) => {
      const q = { ...p };
      delete q.materialId;
      return q;
    });
    expect(pal.every((p) => p.fineMaterialId && !p.materialId)).toBe(true);
    const st = computeStats(layout, data, pal, FINE12, OPTS);
    const rows = shoppingRows(st, pal, FINE12);
    const none = rows.find((r) => r.materialId === null)!;
    expect(none.rawAssumedGrid).toBe(true);
    const fineRows = rows.filter((r) => r.materialId !== null);
    expect(fineRows.length).toBeGreaterThan(0);
    for (const r of fineRows) expect(r.rawAssumedGrid).toBe(false);
  });

  it('gleiches Material als Grund- und Feinstein zweier Farben: eine Einkaufszeile', () => {
    const { layout, data, mats } = setup();
    const { res } = portraitFine();
    // Farbe 0 bekommt als Feinstein das Feinmaterial von Farbe 1 → Material f-<m1> erscheint einmal
    const id1 = `f-${res.palette[1].materialId}`;
    const pal = withFine(res.palette, FINE12).map((p, i) => (i === 0 ? { ...p, fineMaterialId: id1 } : p));
    const st = computeStats(layout, data, pal, mats, OPTS);
    const rows = st.perMaterial.filter((m) => m.materialId === id1);
    expect(rows.length).toBe(1);
    const expected = (st.perColor[0].fine?.rawWithReserve ?? 0) + (st.perColor[1].fine?.rawWithReserve ?? 0);
    expect(rows[0].need).toBe(expected);
  });
});

describe('w6-fine-tiles: Zuordnung in Schritt 5 (reine Helfer)', () => {
  const pal = (hexes: string[], mats?: (string | undefined)[]): PaletteColor[] =>
    hexes.map((hex, i) => ({ code: i + 1, name: hex, hex, lab: [0, 0, 0] as [number, number, number], ...(mats?.[i] ? { materialId: mats[i] } : {}) }));

  it('autoFineMaterials: nächstes Material in Feinsteingröße bis ΔE00 10, sonst keins', () => {
    const p: PaletteColor[] = [
      { code: 1, name: 'Weiß', hex: '#F7F4EE', lab: [96.1, 0.1, 2.4] },
      { code: 2, name: 'Grün', hex: '#00FF00', lab: [87.7, -86.2, 83.2] },
    ];
    const fm = [mat('w2', '#F5F5F5', 2), mat('k2', '#101010', 2)];
    const r = autoFineMaterials(p, fm);
    expect(r.assigned).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.palette[0].fineMaterialId).toBe('w2');
    expect('fineMaterialId' in r.palette[1]).toBe(false);
  });

  it('carryFineMaterials: gleiche Farbe oder gleiches Grundmaterial behält das Feinstein-Material', () => {
    const prev = pal(['#111111', '#222222', '#333333'], ['m1', undefined, 'm3']).map((p, i) => (i < 2 ? { ...p, fineMaterialId: `f${i}` } : p));
    const next = pal(['#999999', '#222222', '#444444'], ['m1', undefined, 'm3']);
    const out = carryFineMaterials(prev, next)!;
    expect(out.map((p) => p.fineMaterialId)).toEqual(['f0', 'f1', undefined]);
    // nichts übertragen, wenn die neue Palette schon Zuordnungen hat oder die alte keine hatte
    expect(carryFineMaterials(prev, out)).toBeNull();
    expect(carryFineMaterials(next, next)).toBeNull();
  });
});
