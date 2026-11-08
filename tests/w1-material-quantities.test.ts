/**
 * Rohstein-, Packungs-, Bestands- und Kostenbedarf (w1-material-quantities).
 * Rohsteine: je Farbe und gleicher Schnittform (Drehung erlaubt, keine Spiegelung) ⌈n / Ausbeute⌉.
 * Packungen/Bestand/Kosten: je Material, nicht je Farbe.
 */
import { describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { rectPoly } from '../src/core/geometry';
import { computeLayout, computeSections, type LayoutParams } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { analyzeCut, cellPieces, diagA, diagB } from '../src/core/pieces';
import { canonicalOutline, computeStats, makeRawSizeFn, packsFor, rawGroupKey, withReserve, type Stats } from '../src/core/stats';
import { CellKind, createEmptyMosaic, DEFAULT_ADJUST, DEFAULT_SHAPES, type Material, type MosaicData, type PaletteColor } from '../src/core/types';
import { applyAdjustments } from '../src/core/imageOps';
import { loadPng, prepareFor } from './helpers';

const OPTS0 = { reservePct: 0, groutDepthMm: 3 };
const OPTS10 = { reservePct: 10, groutDepthMm: 3 };

function pal(n: number, materialIds: (string | undefined)[] = []): PaletteColor[] {
  const hexes = ['#FFFFFF', '#2050C0', '#C02020', '#20A040', '#000000', '#808080'];
  return Array.from({ length: n }, (_, i) => ({
    code: i + 1,
    hex: hexes[i % hexes.length],
    name: `F${i + 1}`,
    lab: hexToLab(hexes[i % hexes.length]),
    materialId: materialIds[i],
  }));
}

function mat(id: string, over: Partial<Material> = {}): Material {
  return {
    id,
    type: 'glass',
    manufacturer: 'Test',
    product: 'Glas',
    colorNumber: id,
    colorName: id,
    hex: '#2050C0',
    lengthMm: 5,
    widthMm: 5,
    thicknessMm: 4,
    price: 0,
    packageSize: '',
    piecesPerPack: 0,
    ...over,
  };
}

function lp(cols: number, rows: number, tileW: number, tileH: number, joint: number): LayoutParams {
  return { widthMm: cols * tileW + (cols - 1) * joint, heightMm: rows * tileH + (rows - 1) * joint, tileW, tileH, joint, edgeMode: 'whole', minCutMm: 1 };
}

/** Rohsteine einer Farbe, wenn sich KEINE Teile einen Rohstein teilen (jede Gruppe = ein einzelnes Teil). */
function rawNoSharing(s: Stats, color: number) {
  return s.perColor[color].pieces;
}

describe('Rohsteinbedarf je Schnittform (nie zu niedrig)', () => {
  it('r6: Streifen + Diagonaldreieck derselben Farbe auf 8 × 8 brauchen 2 Rohsteine', () => {
    const L = computeLayout(lp(3, 1, 8, 8, 1));
    const d = createEmptyMosaic(L.cols, L.rows);
    // Zelle 0: Diagonale „\“, oben rechts Blau (1), unten links Weiß (0)
    d.kind[0] = CellKind.DIAG_A;
    d.c1[0] = 1;
    d.c2[0] = 0;
    // Zelle 1: ganz Weiß; Zelle 2: senkrechter Kantenschnitt, linker Streifen Blau
    d.kind[2] = CellKind.LINE;
    d.line.set(2, new Float32Array([-1, 0, 0]));
    d.c1[2] = 1;
    d.c2[2] = 0;
    const pieces = cellPieces(L, d, 0, 2);
    const blueStrip = pieces.find((p) => p.color === 1)!;
    const strip = analyzeCut(blueStrip.poly, 8, 8);
    expect(strip.shape).toBe('rectangle');
    expect(strip.w).toBeCloseTo(3.5, 9);
    expect(strip.yieldPerRaw).toBe(2);
    const tri = analyzeCut(cellPieces(L, d, 0, 0)[0].poly, 8, 8);
    expect(tri.shape).toBe('triangle');
    expect(tri.yieldPerRaw).toBe(2);

    const s = computeStats(L, d, pal(2), [], OPTS10);
    const blue = s.perColor[1];
    expect(blue.pieces).toBe(2);
    // früher: 1/2 + 1/2 = 1 Rohstein – physikalisch unmöglich (Dreieck ist mind. 5,15 mm breit, neben dem Streifen bleiben 4,5 mm)
    expect(blue.rawExact).toBeCloseTo(1, 9);
    expect(blue.raw).toBe(2);
    expect(blue.rawWithReserve).toBe(3); // ⌈2 · 1,1⌉
    expect(blue.rawWithReserve).toBeGreaterThanOrEqual(2);
    // Verschnitt passt zur angezeigten (gerundeten) Rohsteinzahl
    const rawArea = s.perColor.reduce((a, c) => a + c.raw * c.rawW * c.rawH, 0);
    expect(s.rawArea).toBeCloseTo(rawArea, 9);
    expect(s.wasteArea).toBeCloseTo(rawArea - s.stoneArea, 9);
    expect(s.wastePct).toBeCloseTo(((rawArea - s.stoneArea) / rawArea) * 100, 9);
  });

  it('eine Diagonalzelle mit beiden Hälften in einer Farbe: 1 Rohstein', () => {
    for (const kind of [CellKind.DIAG_A, CellKind.DIAG_B]) {
      for (const [tw, th] of [
        [8, 8],
        [6, 10],
      ]) {
        const L = computeLayout(lp(1, 1, tw, th, 1));
        const d = createEmptyMosaic(1, 1);
        d.kind[0] = kind;
        d.c1[0] = 0;
        d.c2[0] = 0;
        const s = computeStats(L, d, pal(1), [], OPTS0);
        expect(s.perColor[0].pieces).toBe(2);
        expect(s.perColor[0].raw).toBe(1);
        expect(s.rawTotal).toBe(1);
      }
    }
  });

  it('drei gleichschenklige Diagonaldreiecke auf 8 × 8 (gemischt ╲/╱): 2 Rohsteine', () => {
    const L = computeLayout(lp(2, 1, 8, 8, 1));
    const d = createEmptyMosaic(2, 1);
    d.kind[0] = CellKind.DIAG_A; // beide Hälften Blau
    d.c1[0] = 1;
    d.c2[0] = 1;
    d.kind[1] = CellKind.DIAG_B; // obere Hälfte Blau, untere Weiß
    d.c1[1] = 1;
    d.c2[1] = 0;
    const s = computeStats(L, d, pal(2), [], OPTS0);
    expect(s.perColor[1].pieces).toBe(3);
    // gleichschenklig: die gespiegelte Hälfte ist zugleich eine gedrehte → eine Gruppe
    expect(s.perColor[1].raw).toBe(2);
    expect(s.perColor[0].raw).toBe(1);
  });

  it('6 × 10: DIAG_A mit beiden Hälften Blau + eine gespiegelte DIAG_B-Hälfte Blau → 2 Rohsteine', () => {
    const L = computeLayout(lp(2, 1, 6, 10, 1));
    const d = createEmptyMosaic(2, 1);
    d.kind[0] = CellKind.DIAG_A;
    d.c1[0] = 1;
    d.c2[0] = 1;
    d.kind[1] = CellKind.DIAG_B;
    d.c1[1] = 1;
    d.c2[1] = 0;
    const s = computeStats(L, d, pal(2), [], OPTS0);
    expect(s.perColor[1].pieces).toBe(3);
    expect(s.perColor[1].raw).toBe(2);
  });

  it('6 × 10: eine ╲-Hälfte und eine ╱-Hälfte sind gespiegelt und teilen sich keinen Rohstein (Sichtseite)', () => {
    const L = computeLayout(lp(2, 1, 6, 10, 1));
    const d = createEmptyMosaic(2, 1);
    d.kind[0] = CellKind.DIAG_A;
    d.c1[0] = 1;
    d.c2[0] = 0;
    d.kind[1] = CellKind.DIAG_B;
    d.c1[1] = 1;
    d.c2[1] = 0;
    const s = computeStats(L, d, pal(2), [], OPTS0);
    expect(s.perColor[1].pieces).toBe(2);
    expect(s.perColor[1].rawExact).toBeCloseTo(1, 9);
    expect(s.perColor[1].raw).toBe(2);
    // dieselben zwei Teile in 8 × 8 (gleichschenklig) passen in einen Rohstein
    const L8 = computeLayout(lp(2, 1, 8, 8, 1));
    expect(computeStats(L8, d, pal(2), [], OPTS0).perColor[1].raw).toBe(1);
  });

  it('Drehschlüssel: 0/90/180/270° gleich, Spiegelbild verschieden (außer bei Symmetrie)', () => {
    const [a1, a2] = diagA({ x: 0, y: 0, w: 6, h: 10 }, 1);
    const [b1] = diagB({ x: 0, y: 0, w: 6, h: 10 }, 1);
    const ca = analyzeCut(a1, 6, 10);
    const ca2 = analyzeCut(a2, 6, 10);
    const cb = analyzeCut(b1, 6, 10);
    expect(rawGroupKey(ca)).toBe(rawGroupKey(ca2));
    expect(rawGroupKey(ca)).not.toBe(rawGroupKey(cb));
    // Umriss unabhängig von Startecke, Umlaufrichtung und Lage
    const r = rectPoly(3, 4, 2, 5);
    expect(canonicalOutline(r)).toBe(canonicalOutline([...r].reverse()));
    expect(canonicalOutline(r)).toBe(canonicalOutline(rectPoly(10, 20, 5, 2)));
    expect(canonicalOutline(r)).not.toBe(canonicalOutline(rectPoly(0, 0, 2, 4)));
    // gespiegeltes rechtwinkliges Dreieck mit ungleichen Katheten bleibt verschieden
    const t = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 0, y: 5 },
    ];
    const tm = t.map((p) => ({ x: -p.x, y: p.y }));
    expect(canonicalOutline(t)).not.toBe(canonicalOutline(tm));
    const tr = t.map((p) => ({ x: p.y, y: -p.x }));
    expect(canonicalOutline(t)).toBe(canonicalOutline(tr));
  });

  it('Streifen gleicher Breite teilen sich Rohsteine, auch um 90° gedreht', () => {
    // Zelle 0: senkrechter Schnitt, Zelle 1: waagrechter Schnitt → je ein blauer Streifen 3,5 × 8 bzw. 8 × 3,5 (Ausbeute 2)
    const L = computeLayout(lp(2, 1, 8, 8, 1));
    const d = createEmptyMosaic(2, 1);
    d.kind[0] = CellKind.LINE;
    d.line.set(0, new Float32Array([1, 0, 0]));
    d.kind[1] = CellKind.LINE;
    d.line.set(1, new Float32Array([0, 1, 0]));
    d.c1[0] = d.c1[1] = 1;
    const s = computeStats(L, d, pal(2), [], OPTS0);
    expect(s.perColor[1].pieces).toBe(2);
    expect(s.perColor[1].raw).toBe(1);
    expect(s.perColor[0].raw).toBe(1);
  });

  it('verschiedene Streifenbreiten werden getrennt gerechnet (sichere Obergrenze, keine Restverwertung)', () => {
    // d = 1 → Streifen 4,5 mm (Ausbeute 1) und 2,5 mm (Ausbeute 3)
    const d2 = createEmptyMosaic(1, 1);
    d2.kind[0] = CellKind.LINE;
    d2.line.set(0, new Float32Array([1, 0, 1]));
    d2.c1[0] = 1;
    d2.c2[0] = 1;
    const s2 = computeStats(computeLayout(lp(1, 1, 8, 8, 1)), d2, pal(2), [], OPTS0);
    expect(s2.perColor[1].pieces).toBe(2);
    expect(s2.perColor[1].raw).toBe(2);
    expect(s2.perColor[1].rawExact).toBeCloseTo(1 + 1 / 3, 9);
  });

  it('Material größer als die Rasterzelle: ganze Steine teilen sich den Rohstein (10 × 10 → 4 Stück à 5 × 5)', () => {
    const L = computeLayout(lp(3, 3, 5, 5, 1));
    const d = createEmptyMosaic(3, 3);
    const s = computeStats(L, d, pal(1, ['big']), [mat('big', { lengthMm: 10, widthMm: 10 })], OPTS0);
    expect(s.perColor[0].pieces).toBe(9);
    expect(s.perColor[0].rawW).toBe(10);
    expect(s.perColor[0].raw).toBe(3); // ⌈9 / 4⌉
    expect(s.rawArea).toBeCloseTo(3 * 100, 9);
    expect(s.wasteArea).toBeCloseTo(300 - 9 * 25, 9);
  });

  it('256 ganze Steine: weiterhin 256 / 282', () => {
    const L = computeLayout({ widthMm: 100, heightMm: 100, tileW: 5, tileH: 5, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const d = createEmptyMosaic(L.cols, L.rows);
    const s = computeStats(L, d, pal(1), [], OPTS10);
    expect(s.rawTotal).toBe(256);
    expect(s.rawWithReserveTotal).toBe(282);
    expect(s.wasteArea).toBeCloseTo(0, 9);
  });

  it('Reserve: exakte Ganzzahl wird nicht durch Gleitkomma aufgerundet', () => {
    expect(withReserve(10, 10)).toBe(11);
    expect(withReserve(100, 10)).toBe(110);
    expect(withReserve(256, 10)).toBe(282);
    expect(withReserve(0, 10)).toBe(0);
    expect(withReserve(7, 0)).toBe(7);
    expect(withReserve(1, 5)).toBe(2);
    expect(withReserve(3, 33.3334)).toBe(5);
    expect(Object.is(withReserve(0, 0), 0)).toBe(true);
  });

  it('ungültige Reserve (NaN/negativ) zählt als 0 %', () => {
    const L = computeLayout(lp(2, 2, 5, 5, 1));
    const d = createEmptyMosaic(2, 2);
    for (const reservePct of [Number.NaN, -10]) {
      const s = computeStats(L, d, pal(1), [], { reservePct, groutDepthMm: 3 });
      expect(s.rawWithReserveTotal).toBe(4);
      expect(s.reservePct).toBe(0);
    }
  });
});

/** Gemischtes Mosaik mit allen Zellarten und mehreren Farben. */
function mixedMosaic(L: ReturnType<typeof computeLayout>, colors: number, seed = 3): MosaicData {
  const d = createEmptyMosaic(L.cols, L.rows);
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const c = () => Math.floor(rnd() * colors);
  for (let i = 0; i < L.cols * L.rows; i++) {
    d.c1[i] = c();
    const m = rnd();
    if (m < 0.2) {
      d.kind[i] = CellKind.DIAG_A;
      d.c2[i] = c();
    } else if (m < 0.35) {
      d.kind[i] = CellKind.DIAG_B;
      d.c2[i] = c();
    } else if (m < 0.5) {
      d.kind[i] = CellKind.LINE;
      const a = Math.floor(rnd() * 12) * (Math.PI / 12);
      d.line.set(i, new Float32Array([Math.cos(a), Math.sin(a), Math.round(rnd() * 4 - 2) / 2]));
      d.c2[i] = c();
    } else if (m < 0.6) {
      d.kind[i] = CellKind.SUB;
      d.sub.set(i, new Uint16Array([c(), c(), c(), c()]));
    }
  }
  return d;
}

describe('Invarianten des Rohsteinbedarfs', () => {
  const L = computeLayout({ widthMm: 203, heightMm: 151, tileW: 6, tileH: 4, joint: 1.5, edgeMode: 'cut-end', minCutMm: 1.5 });
  const d = mixedMosaic(L, 4);
  const p = pal(4);
  const s = computeStats(L, d, p, [], OPTS10);

  it('Untergrenze ≤ Rohsteine ≤ Stückzahl, Summen stimmen', () => {
    for (const c of s.perColor) {
      expect(c.raw).toBeGreaterThanOrEqual(Math.ceil(c.rawExact - 1e-9));
      expect(c.raw).toBeLessThanOrEqual(rawNoSharing(s, c.color));
      expect(c.rawWithReserve).toBe(withReserve(c.raw, 10));
    }
    expect(s.rawTotal).toBe(s.perColor.reduce((a, c) => a + c.raw, 0));
    expect(s.rawWithReserveTotal).toBe(s.perColor.reduce((a, c) => a + c.rawWithReserve, 0));
    expect(s.rawArea).toBeCloseTo(s.perColor.reduce((a, c) => a + c.raw * c.rawW * c.rawH, 0), 6);
    expect(s.wasteArea).toBeCloseTo(s.rawArea - s.stoneArea, 6);
    expect(s.wastePct).toBeCloseTo((s.wasteArea / s.rawArea) * 100, 9);
  });

  it('Σ Rohsteine der Abschnitte ≥ Rohsteine gesamt (Rundung je Abschnitt), Stückzahlen gleich', () => {
    const G = computeSections(L, 60, 50);
    expect(G.sections.length).toBeGreaterThan(1);
    const sec = G.sections.map((r) => computeStats(L, d, p, [], OPTS10, r));
    expect(sec.reduce((a, x) => a + x.pieces, 0)).toBe(s.pieces);
    expect(sec.reduce((a, x) => a + x.rawTotal, 0)).toBeGreaterThanOrEqual(s.rawTotal);
    for (let i = 0; i < p.length; i++) {
      expect(sec.reduce((a, x) => a + x.perColor[i].raw, 0)).toBeGreaterThanOrEqual(s.perColor[i].raw);
      expect(sec.reduce((a, x) => a + x.perColor[i].pieces, 0)).toBe(s.perColor[i].pieces);
    }
  });

  it('gleiches Ergebnis mit gemeinsamem Schnitt-Cache (Worker) und ohne', async () => {
    const { CutCache } = await import('../src/core/stats');
    const cache = new CutCache();
    const a = computeStats(L, d, p, [], OPTS10, undefined, cache);
    const b = computeStats(L, d, p, [], OPTS10, undefined, cache);
    expect(b.rawTotal).toBe(s.rawTotal);
    expect(a.perColor.map((c) => c.raw)).toEqual(s.perColor.map((c) => c.raw));
  });
});

describe('Bedarf je Material (Packungen, Bestand, Kosten)', () => {
  /** 30 Steine Farbe 0, 30 Steine Farbe 1 (ganze 5-mm-Steine), optional weitere Farben. */
  function twoBy30(): { L: ReturnType<typeof computeLayout>; d: MosaicData } {
    const L = computeLayout(lp(10, 6, 5, 5, 1));
    const d = createEmptyMosaic(10, 6);
    for (let i = 30; i < 60; i++) d.c1[i] = 1;
    return { L, d };
  }

  it('zwei Farben teilen ein Material (100 Stück/Packung, Bestand 50, 30 + 30): 1 Packung, 10 zu kaufen', () => {
    const { L, d } = twoBy30();
    const M = mat('m1', { piecesPerPack: 100, stock: 50, price: 12.5 });
    const s = computeStats(L, d, pal(2, ['m1', 'm1']), [M], OPTS0);
    expect(s.perColor[0].rawWithReserve).toBe(30);
    expect(s.perColor[1].rawWithReserve).toBe(30);
    expect(s.perMaterial).toHaveLength(1);
    const pm = s.perMaterial[0];
    expect(pm.materialId).toBe('m1');
    expect(pm.material).toBe(M);
    expect(pm.colors).toEqual([0, 1]);
    expect(pm.pieces).toBe(60);
    expect(pm.raw).toBe(60);
    expect(pm.need).toBe(60);
    expect(pm.stock).toBe(50);
    expect(pm.toBuy).toBe(10);
    expect(pm.packs).toBe(1); // nicht 2
    expect(pm.packsToBuy).toBe(1);
    expect(pm.cost).toBeCloseTo(12.5, 9);
    expect(pm.rawW).toBe(5);
    expect(s.totalCost).toBeCloseTo(12.5, 9); // früher 25 (je Farbe eine Packung)
    expect(s.costComplete).toBe(true);
    expect(s.perMaterial.reduce((a, m) => a + m.need, 0)).toBe(s.rawWithReserveTotal);
  });

  it('Σ need je Material = rawWithReserveTotal, auch mit Reserve, gemischtem Mosaik und „ohne Material“', () => {
    const L = computeLayout({ widthMm: 203, heightMm: 151, tileW: 6, tileH: 4, joint: 1.5, edgeMode: 'cut-end', minCutMm: 1.5 });
    const d = mixedMosaic(L, 5, 11);
    const mats = [mat('a', { lengthMm: 4, widthMm: 6, piecesPerPack: 250, price: 9.9 }), mat('b', { lengthMm: 8, widthMm: 12, piecesPerPack: 40, price: 3, stock: 0 })];
    const s = computeStats(L, d, pal(5, ['a', 'b', 'a', undefined, 'gone']), mats, OPTS10);
    expect(s.perMaterial.map((m) => m.materialId)).toEqual(['a', 'b', null]);
    expect(s.perMaterial[0].colors).toEqual([0, 2]);
    expect(s.perMaterial[2].colors).toEqual([3, 4]);
    expect(s.perMaterial.reduce((a, m) => a + m.need, 0)).toBe(s.rawWithReserveTotal);
    expect(s.perMaterial.reduce((a, m) => a + m.raw, 0)).toBe(s.rawTotal);
    expect(s.perMaterial.reduce((a, m) => a + m.pieces, 0)).toBe(s.pieces);
    const b = s.perMaterial[1];
    expect(b.rawW).toBe(12);
    expect(b.rawH).toBe(8);
    // Bestand 0 gilt als erfasst
    expect(b.stock).toBe(0);
    expect(b.toBuy).toBe(b.need);
    expect(b.packsToBuy).toBe(b.packs);
    expect(b.packs).toBe(Math.ceil(b.need / 40));
    expect(s.totalCost).toBeCloseTo(s.perMaterial.reduce((a, m) => a + (m.cost ?? 0), 0), 9);
    expect(s.totalCost).toBeCloseTo(Math.ceil(s.perMaterial[0].need / 250) * 9.9 + Math.ceil(b.need / 40) * 3, 9);
    // Farben ohne (gültiges) Material → unvollständig
    expect(s.costComplete).toBe(false);
  });

  it('„ohne Material“: eine Gruppe mit Rastermaß, ohne Packungen/Kosten, Kosten unvollständig', () => {
    const { L, d } = twoBy30();
    const s = computeStats(L, d, pal(2), [], OPTS0);
    expect(s.perMaterial).toHaveLength(1);
    const g = s.perMaterial[0];
    expect(g.materialId).toBeNull();
    expect(g.material).toBeUndefined();
    expect(g.colors).toEqual([0, 1]);
    expect(g.rawW).toBe(5);
    expect(g.rawH).toBe(5);
    expect(g.need).toBe(60);
    expect(g.packs).toBeUndefined();
    expect(g.cost).toBeUndefined();
    expect(g.stock).toBeUndefined();
    expect(g.toBuy).toBeUndefined();
    expect(s.totalCost).toBe(0);
    expect(s.costComplete).toBe(false);
    expect(s.perColor.every((c) => c.rawAssumedGrid && !c.materialMissing)).toBe(true);
  });

  it('ohne Packungsgröße: keine Packungen, keine Kosten; ohne Preis: Packungen, aber keine Kosten', () => {
    const { L, d } = twoBy30();
    const s1 = computeStats(L, d, pal(2, ['x', 'x']), [mat('x', { price: 5, stock: 10 })], OPTS0);
    expect(s1.perMaterial[0].packs).toBeUndefined();
    expect(s1.perMaterial[0].packsToBuy).toBeUndefined();
    expect(s1.perMaterial[0].cost).toBeUndefined();
    expect(s1.perMaterial[0].toBuy).toBe(50);
    expect(s1.perColor[0].packs).toBeUndefined();
    expect(s1.costComplete).toBe(false);
    expect(s1.totalCost).toBe(0);
    const s2 = computeStats(L, d, pal(2, ['x', 'x']), [mat('x', { piecesPerPack: 25 })], OPTS0);
    expect(s2.perMaterial[0].packs).toBe(3); // ⌈60 / 25⌉
    expect(s2.perMaterial[0].cost).toBeUndefined();
    expect(s2.perMaterial[0].stock).toBeUndefined();
    expect(s2.perMaterial[0].toBuy).toBeUndefined();
    expect(s2.perMaterial[0].packsToBuy).toBeUndefined();
    expect(s2.costComplete).toBe(false);
    // je Farbe (nur Ansicht je Farbe): ⌈30 / 25⌉ = 2, Kosten erst mit Preis
    expect(s2.perColor[0].packs).toBe(2);
    expect(s2.perColor[0].cost).toBeUndefined();
  });

  it('Bestand größer als Bedarf: nichts zu kaufen', () => {
    const { L, d } = twoBy30();
    const s = computeStats(L, d, pal(2, ['m', 'm']), [mat('m', { piecesPerPack: 100, price: 2, stock: 500 })], OPTS0);
    expect(s.perMaterial[0].toBuy).toBe(0);
    expect(s.perMaterial[0].packsToBuy).toBe(0);
    expect(Object.is(s.perMaterial[0].packsToBuy, 0)).toBe(true);
    expect(s.perMaterial[0].packs).toBe(1);
  });

  it('Packungen: Ganzzahlen ohne Gleitkomma-Aufrundung, mindestens 1 bei Bedarf', () => {
    expect(packsFor(60, 100)).toBe(1);
    expect(packsFor(200, 100)).toBe(2);
    expect(packsFor(201, 100)).toBe(3);
    expect(packsFor(1, 1e12)).toBe(1);
    expect(packsFor(0, 100)).toBe(0);
    expect(packsFor(25, 12.5)).toBe(2);
  });

  it('Material gelöscht/nicht importiert: markiert, Rastermaß angenommen, Gruppe „ohne Material“', () => {
    const { L, d } = twoBy30();
    const s = computeStats(L, d, pal(2, ['weg', 'da']), [mat('da', { lengthMm: 0, widthMm: 0, piecesPerPack: 100, price: 1 })], OPTS0);
    expect(s.perColor[0].materialMissing).toBe(true);
    expect(s.perColor[0].rawAssumedGrid).toBe(true);
    expect(s.perColor[0].material).toBeUndefined();
    // Material vorhanden, aber ohne gültiges Maß → Rastermaß, nicht „fehlt“
    expect(s.perColor[1].materialMissing).toBe(false);
    expect(s.perColor[1].rawAssumedGrid).toBe(true);
    expect(s.perColor[1].material?.id).toBe('da');
    expect(s.missingMaterials).toEqual([0]);
    expect(s.perMaterial.map((m) => m.materialId)).toEqual(['da', null]);
    expect(s.perMaterial[0].rawW).toBe(5);
    expect(s.costComplete).toBe(false);
    const raw = makeRawSizeFn(L, pal(2, ['weg', 'da']), []);
    expect(raw(0).materialMissing).toBe(true);
    expect(raw(0).rawAssumedGrid).toBe(true);
    expect(raw(5).rawAssumedGrid).toBe(true);
  });

  it('Farben ohne Steine erscheinen nicht in der Einkaufsliste', () => {
    const { L, d } = twoBy30();
    const s = computeStats(L, d, pal(3, ['m', 'm', 'n']), [mat('m', { piecesPerPack: 100, price: 1 }), mat('n', { piecesPerPack: 100, price: 1 })], OPTS0);
    expect(s.perMaterial.map((m) => m.materialId)).toEqual(['m']);
    expect(s.costComplete).toBe(true);
  });
});

describe('Ungültige Farbindizes werden gemeldet statt übersprungen', () => {
  it('Index ≥ Palettenlänge: in Stückzahl/Fläche enthalten, in invalidColorPieces gezählt', () => {
    const L = computeLayout(lp(4, 4, 5, 5, 1));
    const d = createEmptyMosaic(4, 4);
    d.c1[5] = 7; // Palette hat nur 2 Farben
    d.kind[6] = CellKind.DIAG_A;
    d.c1[6] = 1;
    d.c2[6] = 9;
    d.kind[7] = CellKind.FREE;
    d.free.set(7, [
      { poly: rectPoly(0, 0, 2, 5), color: 0 },
      { poly: rectPoly(3, 0, 2, 5), color: 42 },
    ]);
    const s = computeStats(L, d, pal(2, ['m', 'm']), [mat('m', { piecesPerPack: 1000, price: 1 })], OPTS0);
    expect(s.invalidColorPieces).toBe(3);
    expect(s.pieces).toBe(16 - 2 + 2 + 2);
    expect(s.perColor.reduce((a, c) => a + c.pieces, 0) + s.invalidColorPieces).toBe(s.pieces);
    expect(Object.values(s.perShape).reduce((a, b) => a + b, 0)).toBe(s.pieces);
    // Fläche der ungültigen Steine zählt als Steinfläche, nicht als Fuge
    let stone = 0;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (const p of cellPieces(L, d, r, c)) stone += analyzeCut(p.poly, 5, 5).area;
    expect(s.stoneArea).toBeCloseTo(stone, 9);
    // Material vollständig, aber Bedarf unvollständig → Kosten unvollständig
    expect(s.costComplete).toBe(false);
    // Verschnitt nur über Steine mit gültiger Farbe
    const colorArea = s.perColor.reduce((a, c) => a + c.area, 0);
    expect(s.wasteArea).toBeCloseTo(Math.max(0, s.rawArea - colorArea), 9);
  });

  it('ohne ungültige Indizes: 0', () => {
    const L = computeLayout(lp(2, 2, 5, 5, 1));
    const s = computeStats(L, createEmptyMosaic(2, 2), pal(1), [], OPTS0);
    expect(s.invalidColorPieces).toBe(0);
    expect(s.missingMaterials).toEqual([]);
  });
});

describe('Berechnetes Testprojekt (Porträt, klein)', () => {
  const layout = computeLayout({ widthMm: 160, heightMm: 200, tileW: 5, tileH: 5, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
  const img = applyAdjustments(prepareFor(loadPng('public/samples/portrait.png'), layout), { ...DEFAULT_ADJUST }, []);
  const res = computeMosaic(img, { layout, shapes: { ...DEFAULT_SHAPES }, paletteMode: 'auto', colorCount: 12, dither: 0, deltaE: '2000', regions: [] });

  it('Rohsteine ≥ alte Untergrenze, ≤ Stückzahl; Verschnitt passt; Material je Farbe vs. je Material', () => {
    const mats = [mat('g', { piecesPerPack: 200, price: 4, stock: 100 })];
    const palette = res.palette.map((p, i) => ({ ...p, materialId: i < 4 ? 'g' : undefined }));
    const s = computeStats(layout, res.data, palette, mats, OPTS10);
    expect(s.invalidColorPieces).toBe(0);
    expect(s.cutPieces).toBeGreaterThan(0);
    let lower = 0;
    for (const c of s.perColor) {
      lower += Math.ceil(c.rawExact - 1e-9);
      expect(c.raw).toBeLessThanOrEqual(c.pieces);
    }
    expect(s.rawTotal).toBeGreaterThanOrEqual(lower);
    expect(s.wasteArea).toBeCloseTo(s.rawArea - s.stoneArea, 6);
    const g = s.perMaterial.find((m) => m.materialId === 'g')!;
    const need = [0, 1, 2, 3].reduce((a, i) => a + s.perColor[i].rawWithReserve, 0);
    expect(g.need).toBe(need);
    expect(g.packs).toBe(Math.ceil(need / 200));
    expect(g.toBuy).toBe(Math.max(0, need - 100));
    expect(s.totalCost).toBeCloseTo(Math.ceil(need / 200) * 4, 9);
    expect(s.perMaterial.reduce((a, m) => a + m.need, 0)).toBe(s.rawWithReserveTotal);
    // Packungen je Farbe einzeln summiert wären nie weniger als je Material
    const perColorPacks = [0, 1, 2, 3].reduce((a, i) => a + (s.perColor[i].packs ?? 0), 0);
    expect(perColorPacks).toBeGreaterThanOrEqual(g.packs!);
  });
});
