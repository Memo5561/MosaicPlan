/**
 * w2-grout-preview: ehrliche Übersicht inklusive Fuge und Fugenfarben-Empfehlung (Schätzung).
 *  1. buildOverviewRGBA = optische Mischung des Fußabdrucks (flächengewichtet, lineares Licht, mit Fuge).
 *  2. Fortschritts-Overlay und abgeblendete Palette für die Übersicht.
 *  3. Fernwirkungs-Modell (grout.ts): Fußabdrücke, Bedeckung, Fotomittel, Unschärfe, ΔE00, Empfehlung.
 * Alles reine Anzeige/Schätzung: Raster und Stückzahlen bleiben unverändert.
 */
import { describe, expect, it } from 'vitest';
import { deltaE2000, hexToLab, hexToRgb, rgbToHex } from '../src/core/color';
import { area, pointInPolygon } from '../src/core/geometry';
import {
  blurField,
  cellCoverage,
  cellGrid,
  farDeltaE,
  footprints,
  GROUT_CANDIDATES,
  groutCandidates,
  hexToLinear,
  LIN_TO_SRGB8,
  linToLabInto,
  linToSrgb8,
  mosaicCells,
  normHex,
  perceivedDeltaE,
  prepareFarModel,
  recommendGrout,
  SRGB8_TO_LIN,
  targetLinear,
  worthSwitching,
} from '../src/core/grout';
import { centerCropToAspect, resizeArea, type RGBAImage } from '../src/core/imageOps';
import { computeLayout, type Layout } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { cellPieces } from '../src/core/pieces';
import { buildOverviewRGBA, buildProgressOverlayRGBA, DIM_ALPHA, dimmedPalette, LAID_ALPHA, LAID_TINT, overviewActive, pitchPxOf } from '../src/core/render';
import { computeStats } from '../src/core/stats';
import { CellKind, createEmptyMosaic, type MosaicData, type PaletteColor } from '../src/core/types';
import { loadPng } from './helpers';
import { baseParams, sampleSetup } from './w1-mosaic-core.fixtures';

const exactLin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const exactSrgb = (c: number) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
};
const pal = (hexes: string[]): PaletteColor[] => hexes.map((hex, i) => ({ code: i + 1, name: `F${i + 1}`, hex, lab: hexToLab(hex) }));
const px = (rgba: Uint8ClampedArray, layout: Layout, row: number, col: number) => {
  const o = (row * layout.cols + col) * 4;
  return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]];
};
const mixHex = (parts: [number, string][]): number[] => {
  const tot = parts.reduce((s, [w]) => s + w, 0);
  return [0, 1, 2].map((k) => exactSrgb(parts.reduce((s, [w, hex]) => s + w * exactLin(hexToRgb(hex)[k]), 0) / tot));
};
const close = (a: number[], b: number[], tol = 1) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const snapshot = (d: MosaicData) =>
  JSON.stringify({
    kind: Array.from(d.kind),
    c1: Array.from(d.c1),
    c2: Array.from(d.c2),
    progress: Array.from(d.progress),
    rec: Array.from(d.rec),
    sub: [...d.sub].map(([k, v]) => [k, Array.from(v)]),
    line: [...d.line].map(([k, v]) => [k, Array.from(v)]),
    free: [...d.free],
  });

describe('lineares Licht (Nachschlagetabellen)', () => {
  it('sRGB → linear → sRGB gibt jeden 8-Bit-Wert exakt zurück', () => {
    for (let v = 0; v < 256; v++) expect(linToSrgb8(SRGB8_TO_LIN[v])).toBe(v);
    expect(LIN_TO_SRGB8.length).toBe(4096);
    expect(linToSrgb8(-1)).toBe(0);
    expect(linToSrgb8(2)).toBe(255);
    expect(linToSrgb8(Number.NaN)).toBe(0);
  });
  it('Lab aus linearem RGB stimmt mit color.ts überein', () => {
    const out = [0, 0, 0];
    for (const hex of ['#000000', '#FFFFFF', '#BDB8AE', '#3A6EA5', '#C0262D']) {
      const l = hexToLinear(hex)!;
      linToLabInto(l[0], l[1], l[2], out, 0);
      const ref = hexToLab(hex);
      for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(ref[k], 3);
    }
  });
});

describe('buildOverviewRGBA: Übersicht = optische Mischung inkl. Fuge', () => {
  const colors = ['#000000', '#FFFFFF', '#C0262D', '#3A6EA5', '#7F7F7F', '#E8B04A'];

  it('Fuge 0 und nur ganze Steine: Pixel = Palettenfarbe exakt (unabhängig von der Fugenfarbe)', () => {
    const layout = computeLayout({ widthMm: 30, heightMm: 20, tileW: 5, tileH: 5, joint: 0, edgeMode: 'whole', minCutMm: 2 });
    const data = createEmptyMosaic(layout.cols, layout.rows);
    for (let i = 0; i < data.c1.length; i++) data.c1[i] = i % colors.length;
    for (const grout of ['#BDB8AE', '#000000', '#FFFFFF']) {
      const rgba = buildOverviewRGBA(layout, data, pal(colors), grout);
      for (let i = 0; i < data.c1.length; i++) {
        const want = hexToRgb(colors[i % colors.length]);
        expect([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]]).toEqual([...want, 255]);
      }
    }
  });

  it('5-mm-Stein mit 1 mm Fuge: Pixel = von Hand gerechnete lineare Mischung (innen, Rand, Ecke)', () => {
    const layout = computeLayout({ widthMm: 5 * 4 + 3, heightMm: 5 * 3 + 2, tileW: 5, tileH: 5, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    expect([layout.cols, layout.rows]).toEqual([4, 3]);
    const data = createEmptyMosaic(layout.cols, layout.rows);
    data.c1.fill(2); // #C0262D
    const grout = '#BDB8AE';
    const rgba = buildOverviewRGBA(layout, data, pal(colors), grout);
    // innen: Fußabdruck 6 × 6 mm, Stein 25 mm², Fuge 11 mm² (30,6 %)
    expect(close(px(rgba, layout, 1, 1).slice(0, 3), mixHex([[25, '#C0262D'], [11, grout]]))).toBe(true);
    // Rand oben (nicht Ecke): 6 × 5,5 mm
    expect(close(px(rgba, layout, 0, 1).slice(0, 3), mixHex([[25, '#C0262D'], [33 - 25, grout]]))).toBe(true);
    // Ecke: 5,5 × 5,5 mm
    expect(close(px(rgba, layout, 0, 0).slice(0, 3), mixHex([[25, '#C0262D'], [30.25 - 25, grout]]))).toBe(true);
    // die Fuge hellt den Stein auf (die alte Übersicht zeigte die reine Steinfarbe)
    const pure = hexToRgb('#C0262D');
    expect(px(rgba, layout, 1, 1)[1]).toBeGreaterThan(pure[1] + 40);
  });

  it('Fußabdrücke ergeben genau die fertige Fläche (auch mit Randzuschnitt)', () => {
    for (const edgeMode of ['whole', 'cut-end', 'cut-both'] as const) {
      const layout = computeLayout({ widthMm: 403.7, heightMm: 251.2, tileW: 8, tileH: 6, joint: 1.5, edgeMode, minCutMm: 2 });
      const { fw, fh } = footprints(layout);
      expect(fw.reduce((a, b) => a + b, 0)).toBeCloseTo(layout.finishedW, 9);
      expect(fh.reduce((a, b) => a + b, 0)).toBeCloseTo(layout.finishedH, 9);
    }
  });

  it('Kantenschnitt mit bekannter 30/70-Teilung wird nach Fläche gewichtet (nicht 50/50)', () => {
    // eine Zelle 10 × 10 mm ohne Fuge, senkrechte Schnittgerade bei x = 3 mm → Flächen 30 und 70 mm²
    const layout = computeLayout({ widthMm: 10, heightMm: 10, tileW: 10, tileH: 10, joint: 0, edgeMode: 'whole', minCutMm: 2 });
    const data = createEmptyMosaic(1, 1);
    data.kind[0] = CellKind.LINE;
    data.c1[0] = 0; // #000000 links
    data.c2[0] = 1; // #FFFFFF rechts
    data.line.set(0, new Float32Array([1, 0, -2]));
    const ps = cellPieces(layout, data, 0, 0);
    expect(area(ps[0].poly)).toBeCloseTo(30, 9);
    expect(area(ps[1].poly)).toBeCloseTo(70, 9);
    const rgba = buildOverviewRGBA(layout, data, pal(colors), '#BDB8AE');
    const want = mixHex([[30, '#000000'], [70, '#FFFFFF']]);
    expect(close(px(rgba, layout, 0, 0).slice(0, 3), want)).toBe(true);
    // die alte 50/50-Mittelung in sRGB hätte 128 ergeben
    expect(px(rgba, layout, 0, 0)[0]).toBeGreaterThan(200);
  });

  it('Kantenschnitt mit Fuge: Gewichte = echte Polygonflächen, Rest = Fuge', () => {
    const layout = computeLayout({ widthMm: 32, heightMm: 32, tileW: 10, tileH: 10, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const data = createEmptyMosaic(layout.cols, layout.rows);
    const idx = 1 * layout.cols + 1;
    data.kind[idx] = CellKind.LINE;
    data.c1[idx] = 2;
    data.c2[idx] = 3;
    data.line.set(idx, new Float32Array([1, 0, -2]));
    const ps = cellPieces(layout, data, 1, 1);
    const a1 = area(ps[0].poly);
    const a2 = area(ps[1].poly);
    expect(a1 + a2).toBeLessThan(100); // die Schnittfuge kostet Steinfläche
    const rgba = buildOverviewRGBA(layout, data, pal(colors), '#404040');
    const want = mixHex([
      [a1, '#C0262D'],
      [a2, '#3A6EA5'],
      [11 * 11 - a1 - a2, '#404040'],
    ]);
    expect(close(px(rgba, layout, 1, 1).slice(0, 3), want)).toBe(true);
  });

  it('Unterteilte und Freiform-Zellen: Teilflächen statt Anzahl', () => {
    const layout = computeLayout({ widthMm: 12, heightMm: 12, tileW: 12, tileH: 12, joint: 0, edgeMode: 'whole', minCutMm: 1 });
    const data = createEmptyMosaic(1, 1);
    data.kind[0] = CellKind.FREE;
    // großes weißes Teil (8 × 12) und kleines schwarzes (4 × 12): Fläche 2 : 1, Anzahl 1 : 1
    data.free.set(0, [
      { poly: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 12 }, { x: 0, y: 12 }], color: 1 },
      { poly: [{ x: 8, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 12 }, { x: 8, y: 12 }], color: 0 },
    ]);
    const rgba = buildOverviewRGBA(layout, data, pal(colors), '#BDB8AE');
    expect(close(px(rgba, layout, 0, 0).slice(0, 3), mixHex([[96, '#FFFFFF'], [48, '#000000']]))).toBe(true);
  });

  it('verändert das Mosaik nicht; Stückzahlen bleiben gleich; Fugenfarbe ändert die Pixel', () => {
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su));
    res.data.progress[5] = 1;
    const before = snapshot(res.data);
    const statsBefore = computeStats(su.layout, res.data, res.palette, [], { reservePct: 10, groutDepthMm: 3 });
    const a = buildOverviewRGBA(su.layout, res.data, res.palette, '#BDB8AE');
    const b = buildOverviewRGBA(su.layout, res.data, res.palette, '#404040');
    buildProgressOverlayRGBA(su.layout, res.data);
    expect(snapshot(res.data)).toBe(before);
    const statsAfter = computeStats(su.layout, res.data, res.palette, [], { reservePct: 10, groutDepthMm: 3 });
    expect(statsAfter.pieces).toBe(statsBefore.pieces);
    expect(statsAfter.perColor.map((c) => c.pieces)).toEqual(statsBefore.perColor.map((c) => c.pieces));
    let diff = 0;
    for (let i = 0; i < a.length; i += 4) diff += Math.abs(a[i] - b[i]);
    expect(diff / (a.length / 4)).toBeGreaterThan(10);
  });

  it('Probe-Mosaik: Übersicht = feine Rasterung der echten Polygone mit Fuge (ΔE00 klein)', () => {
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su));
    const L = su.layout;
    const grout = '#BDB8AE';
    const rgba = buildOverviewRGBA(L, res.data, res.palette, grout);
    const gl = hexToLinear(grout)!;
    const lp = res.palette.map((p) => hexToLinear(p.hex)!);
    const { fw, fh } = footprints(L);
    const S = 24;
    const errs: number[] = [];
    let split = 0;
    for (let row = 0; row < L.rows; row++)
      for (let col = 0; col < L.cols; col++) {
        const idx = row * L.cols + col;
        // alle geteilten Zellen und jede 7. ganze Zelle prüfen
        if (res.data.kind[idx] === CellKind.FULL && idx % 7) continue;
        if (res.data.kind[idx] !== CellKind.FULL) split++;
        const ps = cellPieces(L, res.data, row, col);
        const x0 = col === 0 ? 0 : L.colX[col] - L.joint / 2;
        const y0 = row === 0 ? 0 : L.rowY[row] - L.joint / 2;
        const acc = [0, 0, 0];
        for (let j = 0; j < S; j++)
          for (let i = 0; i < S; i++) {
            const p = { x: x0 + ((i + 0.5) / S) * fw[col], y: y0 + ((j + 0.5) / S) * fh[row] };
            const hit = ps.find((q) => pointInPolygon(p, q.poly));
            const c = hit ? lp[hit.color] : gl;
            for (let k = 0; k < 3; k++) acc[k] += c[k] / (S * S);
          }
        const want = hexToLab(rgbToHex(exactSrgb(acc[0]), exactSrgb(acc[1]), exactSrgb(acc[2])));
        const got = hexToLab(rgbToHex(...(px(rgba, L, row, col).slice(0, 3) as [number, number, number])));
        errs.push(deltaE2000(want[0], want[1], want[2], got[0], got[1], got[2]));
      }
    expect(split).toBeGreaterThan(50);
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    expect(mean).toBeLessThan(0.8);
    expect(Math.max(...errs)).toBeLessThan(4);
  });
});

describe('Übersicht: Fortschritt und hervorgehobene Farbe', () => {
  it('Fortschritts-Overlay: Deckkraft = LAID_ALPHA × verlegte Steinfläche ÷ Fußabdruck', () => {
    const layout = computeLayout({ widthMm: 23, heightMm: 17, tileW: 5, tileH: 5, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const data = createEmptyMosaic(layout.cols, layout.rows);
    expect(buildProgressOverlayRGBA(layout, data).any).toBe(false);
    const inner = 1 * layout.cols + 1;
    data.progress[inner] = 1;
    // SUB-Zelle mit 2×2 Teilsteinen, davon 2 verlegt
    const sub = 1 * layout.cols + 2;
    data.kind[sub] = CellKind.SUB;
    data.sub.set(sub, new Uint16Array([0, 0, 0, 0]));
    data.progress[sub] = 0b0101;
    const { rgba, any } = buildProgressOverlayRGBA(layout, data);
    expect(any).toBe(true);
    expect([rgba[inner * 4], rgba[inner * 4 + 1], rgba[inner * 4 + 2]]).toEqual(LAID_TINT);
    expect(rgba[inner * 4 + 3]).toBe(Math.round(255 * LAID_ALPHA * (25 / 36)));
    const ps = cellPieces(layout, data, 1, 2);
    const laid = area(ps[0].poly) + area(ps[2].poly);
    expect(rgba[sub * 4 + 3]).toBe(Math.round(255 * LAID_ALPHA * (laid / 36)));
    expect(rgba[0 * 4 + 3]).toBe(0);
  });

  it('abgeblendete Palette: andere Farben wie mit weißem Schleier, Fokusfarbe unverändert', () => {
    const p = pal(['#000000', '#C0262D', '#3A6EA5']);
    const d = dimmedPalette(p, 1);
    expect(d[1].hex).toBe('#C0262D');
    expect(hexToRgb(d[0].hex)).toEqual([0, 0, 0].map((v) => Math.round(v * (1 - DIM_ALPHA) + 255 * DIM_ALPHA)));
    expect(p[0].hex).toBe('#000000');
  });

  it('Übersicht nur bei kleinem Maßstab oder sehr vielen sichtbaren Steinen', () => {
    const layout = computeLayout({ widthMm: 1200, heightMm: 800, tileW: 8, tileH: 8, joint: 1.5, edgeMode: 'cut-end', minCutMm: 2 });
    const s1 = 2.9 / 9.5;
    expect(pitchPxOf(layout, s1)).toBeCloseTo(2.9, 9);
    expect(overviewActive(layout, { scale: s1, ox: 0, oy: 0, width: 390, height: 600 })).toBe(true);
    expect(overviewActive(layout, { scale: s1 * 1.5, ox: 0, oy: 0, width: 390, height: 600 })).toBe(false);
  });
});

describe('Fernwirkungs-Modell (grout.ts)', () => {
  it('Feldraster: k = 1 bei kleinen Projekten, sonst k × k Zellen; Grenzen von 0 bis zur fertigen Größe', () => {
    const small = computeLayout({ widthMm: 400, heightMm: 500, tileW: 5, tileH: 5, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
    const g1 = cellGrid(small);
    expect(g1.k).toBe(1);
    expect([g1.w, g1.h]).toEqual([small.cols, small.rows]);
    const big = computeLayout({ widthMm: 10000, heightMm: 5000, tileW: 5, tileH: 5, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
    const g2 = cellGrid(big);
    expect(g2.k).toBeGreaterThan(1);
    expect(g2.w * g2.h).toBeLessThanOrEqual(200_000);
    expect(g2.c0[g2.w]).toBe(big.cols);
    expect(g2.x[0]).toBe(0);
    expect(g2.x[g2.w]).toBeCloseTo(big.finishedW, 9);
    expect(g2.y[g2.h]).toBeCloseTo(big.finishedH, 9);
    for (let i = 0; i < g2.w; i++) expect(g2.x[i + 1]).toBeGreaterThan(g2.x[i]);
  });

  it('Bedeckung: ganze Steine 25/36 innen; mit Mosaikdaten aus den echten Teilflächen', () => {
    const layout = computeLayout({ widthMm: 41, heightMm: 29, tileW: 5, tileH: 5, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const grid = cellGrid(layout);
    const cov = cellCoverage(layout, null, grid);
    expect(cov[1 * grid.w + 1]).toBeCloseTo(25 / 36, 6);
    expect(cov[0]).toBeCloseTo(25 / 30.25, 6);
    const data = createEmptyMosaic(layout.cols, layout.rows);
    const same = cellCoverage(layout, data, grid);
    for (let i = 0; i < cov.length; i++) expect(same[i]).toBeCloseTo(cov[i], 6);
    const idx = 1 * layout.cols + 1;
    data.kind[idx] = CellKind.DIAG_A;
    const diag = cellCoverage(layout, data, grid);
    const ps = cellPieces(layout, data, 1, 1);
    expect(diag[idx]).toBeCloseTo((area(ps[0].poly) + area(ps[1].poly)) / 36, 6);
    expect(diag[idx]).toBeLessThan(cov[idx]);
    // grobes Raster: Bedeckung = Σ Steinfläche ÷ Σ Fußabdruck
    const big = computeLayout({ widthMm: 6000, heightMm: 3000, tileW: 5, tileH: 5, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const gb = cellGrid(big, 10_000);
    const cb = cellCoverage(big, null, gb);
    expect(gb.k).toBeGreaterThan(1);
    expect(cb[Math.floor(gb.h / 2) * gb.w + Math.floor(gb.w / 2)]).toBeCloseTo(25 / 36, 6);
  });

  it('Steinfarbe je Feld ist flächengewichtet (ohne Fuge)', () => {
    const layout = computeLayout({ widthMm: 10, heightMm: 10, tileW: 10, tileH: 10, joint: 0, edgeMode: 'whole', minCutMm: 2 });
    const data = createEmptyMosaic(1, 1);
    data.kind[0] = CellKind.LINE;
    data.c1[0] = 0;
    data.c2[0] = 1;
    data.line.set(0, new Float32Array([1, 0, -2]));
    const mc = mosaicCells(layout, data, pal(['#000000', '#FFFFFF']));
    expect(mc.coverage[0]).toBeCloseTo(1, 9);
    expect(mc.stones[0]).toBeCloseTo(0.7, 6);
  });

  it('Fotomittel je Fußabdruck (gleichmäßig über die fertige Fläche, Alpha über Weiß)', () => {
    const layout = computeLayout({ widthMm: 23, heightMm: 11, tileW: 5, tileH: 5, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const W = 46;
    const H = 22;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const v = x < W / 2 ? 0 : 255;
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = 255;
      }
    const img: RGBAImage = { width: W, height: H, data };
    const grid = cellGrid(layout);
    const tl = targetLinear(img, layout, grid);
    expect(tl[0]).toBeCloseTo(0, 6); // ganz links schwarz
    expect(tl[(grid.w - 1) * 3]).toBeCloseTo(1, 6); // ganz rechts weiß
    // Spalte 1 (x 5,5 … 11,5 mm) überdeckt die Bildmitte (11,5 mm) nicht → schwarz; Spalte 2 (11,5 … 17,5) weiß
    expect(tl[1 * 3]).toBeCloseTo(0, 6);
    expect(tl[2 * 3]).toBeCloseTo(1, 6);
    // transparent → weiß
    const tr = new Uint8ClampedArray(W * H * 4);
    expect(targetLinear({ width: W, height: H, data: tr }, layout, grid)[0]).toBeCloseTo(1, 6);
  });

  it('Unschärfe erhält Konstanten; ΔE = 0, wenn Fuge = Fotofarbe oder Steine alles bedecken', () => {
    const w = 30;
    const h = 20;
    const c = new Float32Array(w * h).fill(0.37);
    for (const s of [0.2, 0.8, 2, 5]) for (const v of blurField(c, w, h, s)) expect(v).toBeCloseTo(0.37, 5);
    const target = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) target.set([0.2, 0.3, 0.4], i * 3);
    const cov = new Float32Array(w * h).fill(0.7);
    expect(perceivedDeltaE(target, null, cov, [0.2, 0.3, 0.4], w, h).mean).toBeCloseTo(0, 3);
    expect(perceivedDeltaE(target, null, new Float32Array(w * h).fill(1), [1, 1, 1], w, h).mean).toBeCloseTo(0, 3);
    const r = perceivedDeltaE(target, null, cov, [1, 1, 1], w, h);
    expect(r.mean).toBeGreaterThan(5);
    expect(r.p95).toBeGreaterThanOrEqual(r.mean - 1e-6);
  });

  it('Kandidaten: allgemeine Namen, aktuelle Farbe ergänzt, HEX normalisiert', () => {
    expect(GROUT_CANDIDATES.map((c) => c.hex)).toEqual(['#F2F0EA', '#BDB8AE', '#9A9A96', '#808080', '#5A5A5A', '#404040', '#202020']);
    expect(groutCandidates('#bdb8ae').length).toBe(GROUT_CANDIDATES.length);
    const withCur = groutCandidates('#123456');
    expect(withCur[withCur.length - 1]).toEqual({ key: 'current', hex: '#123456' });
    expect(groutCandidates('kein hex').length).toBe(GROUT_CANDIDATES.length);
    expect(normHex('abc')).toBe('#AABBCC');
    expect(worthSwitching({ mean: 11, p95: 20 }, { mean: 5, p95: 8 })).toBe(true);
    expect(worthSwitching({ mean: 3.1, p95: 7 }, { mean: 2.8, p95: 6 })).toBe(false);
  });

  const photoModel = (key: string) => {
    const files: Record<string, string> = { portrait: 'public/samples/portrait.png', animal: 'public/samples/animal.png', landscape: 'public/samples/landscape.png' };
    const su = sampleSetup(key);
    const L = su.layout;
    const grid = cellGrid(L);
    const crop = centerCropToAspect(loadPng(files[key]), L.finishedW / L.finishedH);
    const img = resizeArea(crop, Math.min(crop.width, grid.w * 2), Math.min(crop.height, grid.h * 2));
    const target = targetLinear(img, L, grid);
    return { su, L, grid, target, model: prepareFarModel({ w: grid.w, h: grid.h, target, stones: null, coverage: cellCoverage(L, null, grid), k: grid.k }) };
  };
  const lightness = (hex: string) => hexToLab(hex)[0];

  it('Porträt (Standardeinstellungen): empfiehlt eine dunklere Fuge als #BDB8AE mit kleinerer Fernwirkungs-Abweichung', () => {
    const { model } = photoModel('portrait');
    const ranked = recommendGrout(model, groutCandidates('#BDB8AE'));
    const best = ranked[0];
    const cur = ranked.find((r) => r.hex === '#BDB8AE')!;
    expect(lightness(best.hex)).toBeLessThan(lightness('#BDB8AE'));
    expect(best.mean).toBeLessThan(cur.mean);
    expect(worthSwitching(cur, best)).toBe(true);
    // sortiert, endliche Werte
    for (let i = 1; i < ranked.length; i++) expect(ranked[i].mean).toBeGreaterThanOrEqual(ranked[i - 1].mean);
    for (const r of ranked) expect(Number.isFinite(r.mean) && Number.isFinite(r.p95)).toBe(true);
  });

  it('Tier (Katze): erzwingt keine dunkle Fuge', () => {
    const { model } = photoModel('animal');
    const ranked = recommendGrout(model, groutCandidates('#BDB8AE'));
    const best = ranked[0];
    const cur = ranked.find((r) => r.hex === '#BDB8AE')!;
    expect(['darkgrey', 'anthracite', 'black']).not.toContain(best.key);
    expect(worthSwitching(cur, best)).toBe(false);
  });

  it('nach der Berechnung: Steinfarben statt idealer Steine; Mosaik und Eingaben unverändert', () => {
    const { su, L, grid, target, model } = photoModel('portrait');
    const res = computeMosaic(su.img, baseParams(su));
    const before = snapshot(res.data);
    const tCopy = target.slice();
    const mc = mosaicCells(L, res.data, res.palette, grid);
    const m2 = prepareFarModel({ w: grid.w, h: grid.h, target, stones: mc.stones, coverage: mc.coverage, k: grid.k });
    const dark = farDeltaE(m2, hexToLinear('#5A5A5A')!);
    const light = farDeltaE(m2, hexToLinear('#BDB8AE')!);
    expect(dark.mean).toBeLessThan(light.mean);
    // echte Steine passen nie besser als ideale Steine in Fotofarbe (Palette begrenzt)
    expect(dark.mean).toBeGreaterThanOrEqual(farDeltaE(model, hexToLinear('#5A5A5A')!).mean - 0.3);
    expect(snapshot(res.data)).toBe(before);
    expect(Array.from(target)).toEqual(Array.from(tCopy));
  });
});
