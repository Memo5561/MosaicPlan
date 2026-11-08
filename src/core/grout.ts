/**
 * Fuge und Fernwirkung (reine Anzeige und Schätzung – Geometrie und Stückzahlen bleiben unberührt).
 *
 * Aus einigen Metern Abstand verschwimmen Steine und Fuge: das Auge mischt ihr Licht (lineares RGB),
 * gewichtet mit der Fläche. Bei 5-mm-Steinen mit 1 mm Fuge bedeckt die Fuge rund 31 % der Fläche – eine
 * helle Fuge hellt dann jede dunkle Stelle auf und entsättigt Farben.
 *
 * Modell (wie in der Prüfung algo-quality#0, Schätzung):
 * - Jede Rasterzelle besitzt einen „Fußabdruck“: die Zelle plus je die halbe Fuge zu den Nachbarn,
 *   ohne Außenfuge am Rand. Die Fußabdrücke ergeben zusammen genau finishedW × finishedH.
 * - Bedeckung f = Steinfläche ÷ Fußabdruck; ganze Steine colW·rowH, sonst Σ Fläche der echten Teilpolygone.
 * - Wahrgenommene Farbe = f · Steinfarbe + (1 − f) · Fugenfarbe (lineares Licht).
 * - Betrachtung aus der Entfernung = Gauß-Unschärfe über das Zellraster (σ = 2 Steine), ebenso auf dem Foto;
 *   verglichen wird mit ΔE00 (Mittelwert und 95-%-Quantil).
 * Vor der Berechnung werden ideale Steine (Steinfarbe = Fotofarbe der Zelle) angenommen, danach die
 * tatsächlich zugeordneten Steinfarben. Echte Fugenmasse trocknet heller auf und variiert je Hersteller.
 */
import { deltaE2000, hexToRgb } from './color';
import { area } from './geometry';
import { gaussBlur, type RGBAImage } from './imageOps';
import type { Layout } from './layout';
import { cellPieces } from './pieces';
import { CellKind, type MosaicData, type PaletteColor } from './types';

// ---------------------------------------------------------------- lineares Licht

/** sRGB (0..255) → linear (0..1), 256 Einträge. */
export const SRGB8_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB8_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const LIN_STEPS = 4095;
/** linear (0..1, Schritt 1/4095) → sRGB (0..255), 4096 Einträge; gibt jeden 8-Bit-Wert exakt zurück. */
export const LIN_TO_SRGB8 = new Uint8Array(LIN_STEPS + 1);
for (let i = 0; i <= LIN_STEPS; i++) {
  const c = i / LIN_STEPS;
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  LIN_TO_SRGB8[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
}

export function linToSrgb8(v: number): number {
  if (!(v > 0)) return 0;
  if (v >= 1) return 255;
  return LIN_TO_SRGB8[Math.round(v * LIN_STEPS)];
}

export type Lin3 = [number, number, number];

/** HEX → lineares RGB (0..1). Ungültige Werte → null. */
export function hexToLinear(hex: string): Lin3 | null {
  try {
    const [r, g, b] = hexToRgb(hex);
    return [SRGB8_TO_LIN[r], SRGB8_TO_LIN[g], SRGB8_TO_LIN[b]];
  } catch {
    return null;
  }
}

// D65, wie src/core/color.ts
const XN = 0.95047;
const ZN = 1.08883;
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;
const fLab = (t: number) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);

/** Lineares RGB (0..1) → CIELAB (D65), schreibt nach out[o..o+2]. */
export function linToLabInto(r: number, g: number, b: number, out: Float32Array | number[], o: number): void {
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / XN;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / ZN;
  const fx = fLab(x);
  const fy = fLab(y);
  const fz = fLab(z);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

// ---------------------------------------------------------------- Fußabdrücke

/**
 * Fußabdruck je Spalte/Zeile in mm: Zelle plus halbe Fuge zu jedem Nachbarn, keine Außenfuge.
 * Σ fw = finishedW, Σ fh = finishedH.
 */
export function footprints(layout: Layout): { fw: Float64Array; fh: Float64Array } {
  const g = layout.joint;
  const fw = new Float64Array(layout.cols);
  const fh = new Float64Array(layout.rows);
  for (let c = 0; c < layout.cols; c++) fw[c] = layout.colW[c] + (c > 0 ? g / 2 : 0) + (c < layout.cols - 1 ? g / 2 : 0);
  for (let r = 0; r < layout.rows; r++) fh[r] = layout.rowH[r] + (r > 0 ? g / 2 : 0) + (r < layout.rows - 1 ? g / 2 : 0);
  return { fw, fh };
}

/** Steinfläche einer Zelle (mm²) und Σ Fläche·Farbe (linear); invalid colour indices → Magenta wie im Viewer. */
export function cellStoneMix(layout: Layout, data: MosaicData, linPalette: Lin3[], row: number, col: number, out: Float64Array): number {
  const idx = row * layout.cols + col;
  if (data.kind[idx] === CellKind.FULL) {
    const a = layout.colW[col] * layout.rowH[row];
    const c = linPalette[data.c1[idx]] ?? MAGENTA;
    out[0] = a * c[0];
    out[1] = a * c[1];
    out[2] = a * c[2];
    return a;
  }
  out[0] = 0;
  out[1] = 0;
  out[2] = 0;
  let covered = 0;
  for (const p of cellPieces(layout, data, row, col)) {
    const a = area(p.poly);
    if (!(a > 0)) continue;
    const c = linPalette[p.color] ?? MAGENTA;
    out[0] += a * c[0];
    out[1] += a * c[1];
    out[2] += a * c[2];
    covered += a;
  }
  return covered;
}

const MAGENTA: Lin3 = [1, 0, 1];

export function linearPalette(palette: PaletteColor[]): Lin3[] {
  return palette.map((p) => hexToLinear(p.hex) ?? MAGENTA);
}

// ---------------------------------------------------------------- reduziertes Zellraster

/**
 * Gitter für das Fernwirkungs-Modell: k × k Rasterzellen je Feld (k = 1, solange höchstens `maxCells` Zellen),
 * damit auch Millionen Steine schnell bleiben. Ränder der Felder sind Fußabdruck-Grenzen in mm.
 */
export interface CellGrid {
  k: number;
  w: number;
  h: number;
  /** erste Rasterspalte/-zeile je Feld (Länge w+1 bzw. h+1, letzter Eintrag = cols/rows) */
  c0: Int32Array;
  r0: Int32Array;
  /** Feldgrenzen in mm (Länge w+1 bzw. h+1, von 0 bis finishedW/H) */
  x: Float64Array;
  y: Float64Array;
}

export function cellGrid(layout: Layout, maxCells = 200_000): CellGrid {
  const n = layout.cols * layout.rows;
  const k = Math.max(1, Math.ceil(Math.sqrt(n / Math.max(1, maxCells))));
  const w = Math.ceil(layout.cols / k);
  const h = Math.ceil(layout.rows / k);
  const g = layout.joint;
  const c0 = new Int32Array(w + 1);
  const r0 = new Int32Array(h + 1);
  const x = new Float64Array(w + 1);
  const y = new Float64Array(h + 1);
  for (let i = 0; i <= w; i++) {
    const c = Math.min(layout.cols, i * k);
    c0[i] = c;
    x[i] = c === 0 ? 0 : c >= layout.cols ? layout.finishedW : layout.colX[c] - g / 2;
  }
  for (let j = 0; j <= h; j++) {
    const r = Math.min(layout.rows, j * k);
    r0[j] = r;
    y[j] = r === 0 ? 0 : r >= layout.rows ? layout.finishedH : layout.rowY[r] - g / 2;
  }
  return { k, w, h, c0, r0, x, y };
}

/**
 * Steinbedeckung je Feld (0..1) = Steinfläche ÷ Fußabdruck. Ohne `data` (vor der Berechnung) gelten alle
 * Zellen als ganze Steine; mit `data` zählen die echten Teilpolygone (Dreiecke, Kantenschnitte, 2×2, Freiform).
 */
export function cellCoverage(layout: Layout, data?: MosaicData | null, grid: CellGrid = cellGrid(layout)): Float32Array {
  const out = new Float32Array(grid.w * grid.h);
  if (!data) {
    const sw = new Float64Array(grid.w);
    const sh = new Float64Array(grid.h);
    for (let i = 0; i < grid.w; i++) for (let c = grid.c0[i]; c < grid.c0[i + 1]; c++) sw[i] += layout.colW[c];
    for (let j = 0; j < grid.h; j++) for (let r = grid.r0[j]; r < grid.r0[j + 1]; r++) sh[j] += layout.rowH[r];
    for (let j = 0; j < grid.h; j++) {
      const fh = grid.y[j + 1] - grid.y[j];
      for (let i = 0; i < grid.w; i++) {
        const fp = (grid.x[i + 1] - grid.x[i]) * fh;
        out[j * grid.w + i] = fp > 0 ? Math.min(1, (sw[i] * sh[j]) / fp) : 0;
      }
    }
    return out;
  }
  return mosaicCells(layout, data, [], grid).coverage;
}

/**
 * Bedeckung und flächengewichtete Steinfarbe (linear, ohne Fuge) je Feld eines berechneten Mosaiks.
 * Bei einer leeren Palette wird nur die Bedeckung bestimmt.
 */
export function mosaicCells(layout: Layout, data: MosaicData, palette: PaletteColor[], grid: CellGrid = cellGrid(layout)): { coverage: Float32Array; stones: Float32Array } {
  const n = grid.w * grid.h;
  const coverage = new Float32Array(n);
  const stones = new Float32Array(n * 3);
  const lp = linearPalette(palette);
  const mix = new Float64Array(3);
  for (let j = 0; j < grid.h; j++) {
    const fh = grid.y[j + 1] - grid.y[j];
    for (let i = 0; i < grid.w; i++) {
      let a = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let row = grid.r0[j]; row < grid.r0[j + 1]; row++)
        for (let col = grid.c0[i]; col < grid.c0[i + 1]; col++) {
          a += cellStoneMix(layout, data, lp, row, col, mix);
          r += mix[0];
          g += mix[1];
          b += mix[2];
        }
      const o = j * grid.w + i;
      const fp = (grid.x[i + 1] - grid.x[i]) * fh;
      coverage[o] = fp > 0 ? Math.min(1, a / fp) : 0;
      if (a > 0) {
        stones[o * 3] = r / a;
        stones[o * 3 + 1] = g / a;
        stones[o * 3 + 2] = b / a;
      }
    }
  }
  return { coverage, stones };
}

/** Pixelgewichte je Feld entlang einer Achse (Überdeckung der Feldgrenzen mit den Pixeln). */
function axisWeights(bounds: Float64Array, total: number, px: number): { start: Int32Array; idx: Int32Array; w: Float32Array } {
  const fields = bounds.length - 1;
  const start = new Int32Array(fields + 1);
  const idx: number[] = [];
  const wt: number[] = [];
  const s = px / total;
  for (let i = 0; i < fields; i++) {
    start[i] = idx.length;
    const a = Math.max(0, bounds[i] * s);
    const b = Math.min(px, Math.max(a, bounds[i + 1] * s));
    if (b - a < 1e-9) {
      // Feld schmaler als nichts: nächstes Pixel verwenden
      idx.push(Math.min(px - 1, Math.max(0, Math.floor(a))));
      wt.push(1);
      continue;
    }
    for (let p = Math.floor(a); p < Math.ceil(b) && p < px; p++) {
      const ov = Math.min(b, p + 1) - Math.max(a, p);
      if (ov > 1e-9) {
        idx.push(p);
        wt.push(ov);
      }
    }
  }
  start[fields] = idx.length;
  return { start, idx: Int32Array.from(idx), w: Float32Array.from(wt) };
}

/**
 * Mittlere Fotofarbe (linear) je Feld. Das Bild liegt wie in computeMosaic gleichmäßig auf
 * finishedW × finishedH (inklusive Fugen); gemittelt wird exakt über den Fußabdruck jedes Felds.
 * Transparente Pixel zählen wie in der Berechnung als Weiß.
 */
export function targetLinear(img: RGBAImage, layout: Layout, grid: CellGrid = cellGrid(layout)): Float32Array {
  const W = img.width;
  const H = img.height;
  const ax = axisWeights(grid.x, layout.finishedW, W);
  const ay = axisWeights(grid.y, layout.finishedH, H);
  const d = img.data;
  // 1. waagerecht: je Bildzeile die gewichteten Summen je Feldspalte
  const tmp = new Float32Array(H * grid.w * 3);
  const sumX = new Float32Array(grid.w);
  for (let i = 0; i < grid.w; i++) for (let q = ax.start[i]; q < ax.start[i + 1]; q++) sumX[i] += ax.w[q];
  for (let yy = 0; yy < H; yy++) {
    const row = yy * W;
    for (let i = 0; i < grid.w; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let q = ax.start[i]; q < ax.start[i + 1]; q++) {
        const p = (row + ax.idx[q]) * 4;
        const wq = ax.w[q];
        const al = d[p + 3] / 255;
        // Alpha über Weiß legen (wie die Berechnung)
        r += wq * (al * SRGB8_TO_LIN[d[p]] + (1 - al));
        g += wq * (al * SRGB8_TO_LIN[d[p + 1]] + (1 - al));
        b += wq * (al * SRGB8_TO_LIN[d[p + 2]] + (1 - al));
      }
      const o = (yy * grid.w + i) * 3;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
    }
  }
  // 2. senkrecht
  const out = new Float32Array(grid.w * grid.h * 3);
  for (let j = 0; j < grid.h; j++) {
    let sy = 0;
    for (let q = ay.start[j]; q < ay.start[j + 1]; q++) sy += ay.w[q];
    for (let i = 0; i < grid.w; i++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let q = ay.start[j]; q < ay.start[j + 1]; q++) {
        const o = (ay.idx[q] * grid.w + i) * 3;
        const wq = ay.w[q];
        r += wq * tmp[o];
        g += wq * tmp[o + 1];
        b += wq * tmp[o + 2];
      }
      const norm = sy * sumX[i];
      const o = (j * grid.w + i) * 3;
      out[o] = norm > 0 ? r / norm : 1;
      out[o + 1] = norm > 0 ? g / norm : 1;
      out[o + 2] = norm > 0 ? b / norm : 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------- Fernwirkung

export interface FarModelInput {
  w: number;
  h: number;
  /** Fotofarbe je Feld, linear, 3 Werte je Feld */
  target: Float32Array;
  /** Steinfarbe je Feld (linear) oder null = ideale Steine (Steinfarbe = Fotofarbe) */
  stones: Float32Array | null;
  /** Steinbedeckung je Feld (0..1) */
  coverage: Float32Array;
  /** Unschärfe in Rasterzellen (Steinen); Standard 2 */
  sigmaCells?: number;
  /** Rasterzellen je Feld und Achse (siehe CellGrid.k); Standard 1 */
  k?: number;
}

/** Vorbereitetes Modell: alles, was nicht von der Fugenfarbe abhängt, ist einmal berechnet. */
export interface FarModel {
  w: number;
  h: number;
  /** Lab des unscharfen Fotos je ausgewertetem Feld */
  targetLab: Float32Array;
  /** unscharf(f · Stein), 3 Werte je ausgewertetem Feld */
  fs: Float32Array;
  /** 1 − unscharf(f) je ausgewertetem Feld = Anteil der Fuge */
  groutShare: Float32Array;
  /** Anzahl ausgewerteter Felder */
  count: number;
  /** mittlere Steinbedeckung (zur Anzeige) */
  meanCoverage: number;
}

export interface FarResult {
  mean: number;
  p95: number;
}

/**
 * Gauß-Unschärfe über ein Feldraster (Ränder fortgesetzt, Kern normiert – Konstanten bleiben exakt erhalten).
 * Bis σ = 3 mit echtem Gaußkern, darüber die schnelle Dreifach-Box-Näherung aus imageOps.
 */
export function blurField(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (!(sigma > 0.3)) return src.slice();
  if (sigma >= 3) return gaussBlur(src, w, h, sigma);
  const r = Math.ceil(3 * sigma);
  const ker = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) ks += ker[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < ker.length; i++) ker[i] /= ks;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += ker[i + r] * src[row + Math.min(w - 1, Math.max(0, x + i))];
      tmp[row + x] = a;
    }
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += ker[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = a;
    }
  return out;
}

/** Höchstens so viele Felder werden je Fugenfarbe mit ΔE00 ausgewertet (gleichmäßiges Teilraster). */
export const MAX_EVAL_FIELDS = 25_000;

/**
 * Bereitet das Fernwirkungs-Modell vor. Weil die Unschärfe linear ist und die Fugenfarbe konstant, gilt
 * unscharf(f·S + (1−f)·G) = unscharf(f·S) + G·(1 − unscharf(f)) – jede Fugenfarbe kostet danach nur noch
 * eine Lab-Umrechnung und ΔE00 je ausgewertetem Feld. Bei k > 1 hat das Mitteln über k × k Zellen schon
 * einen Teil der Unschärfe erledigt (Varianz (k²−1)/12); nur der Rest wird noch weichgezeichnet.
 * Ausgewertet wird ein gleichmäßiges Teilraster von höchstens MAX_EVAL_FIELDS Feldern.
 */
export function prepareFarModel(inp: FarModelInput): FarModel {
  const { w, h, target, coverage } = inp;
  const n = w * h;
  const stones = inp.stones ?? target;
  const k = Math.max(1, inp.k ?? 1);
  const sc = inp.sigmaCells ?? 2;
  const sigma = Math.sqrt(Math.max(0, sc * sc - (k * k - 1) / 12)) / k;
  const ch = (src: Float32Array, c: number) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = src[i * 3 + c];
    return a;
  };
  const fsCh = (c: number) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = coverage[i] * stones[i * 3 + c];
    return blurField(a, w, h, sigma);
  };
  const tR = blurField(ch(target, 0), w, h, sigma);
  const tG = blurField(ch(target, 1), w, h, sigma);
  const tB = blurField(ch(target, 2), w, h, sigma);
  const fR = fsCh(0);
  const fG = fsCh(1);
  const fB = fsCh(2);
  const fC = blurField(coverage, w, h, sigma);
  const stride = Math.max(1, Math.ceil(Math.sqrt(n / MAX_EVAL_FIELDS)));
  const off = Math.floor((stride - 1) / 2);
  const sel: number[] = [];
  for (let y = Math.min(off, h - 1); y < h; y += stride) for (let x = Math.min(off, w - 1); x < w; x += stride) sel.push(y * w + x);
  const count = sel.length;
  const targetLab = new Float32Array(count * 3);
  const fs = new Float32Array(count * 3);
  const groutShare = new Float32Array(count);
  for (let q = 0; q < count; q++) {
    const i = sel[q];
    linToLabInto(tR[i], tG[i], tB[i], targetLab, q * 3);
    fs[q * 3] = fR[i];
    fs[q * 3 + 1] = fG[i];
    fs[q * 3 + 2] = fB[i];
    groutShare[q] = Math.max(0, Math.min(1, 1 - fC[i]));
  }
  let cov = 0;
  for (let i = 0; i < n; i++) cov += coverage[i];
  return { w, h, targetLab, fs, groutShare, count, meanCoverage: n ? cov / n : 0 };
}

/** Fernwirkung einer Fugenfarbe: ΔE00 zwischen unscharfem Mosaik (inkl. Fuge) und unscharfem Foto. */
export function farDeltaE(model: FarModel, grout: Lin3): FarResult {
  const { count, fs, groutShare, targetLab } = model;
  if (!count) return { mean: 0, p95: 0 };
  const d = new Float32Array(count);
  const lab = [0, 0, 0];
  let sum = 0;
  for (let q = 0; q < count; q++) {
    const s = groutShare[q];
    linToLabInto(fs[q * 3] + grout[0] * s, fs[q * 3 + 1] + grout[1] * s, fs[q * 3 + 2] + grout[2] * s, lab, 0);
    const e = deltaE2000(targetLab[q * 3], targetLab[q * 3 + 1], targetLab[q * 3 + 2], lab[0], lab[1], lab[2]);
    d[q] = e;
    sum += e;
  }
  d.sort();
  return { mean: sum / count, p95: d[Math.min(count - 1, Math.floor(count * 0.95))] };
}

/**
 * Wahrgenommene Abweichung aus der Entfernung (Mittelwert und 95-%-Quantil ΔE00), Schätzung.
 * targetLin/stoneLin: 3 Werte je Feld (linear); stoneLin = null → ideale Steine.
 */
export function perceivedDeltaE(
  targetLin: Float32Array,
  stoneLin: Float32Array | null,
  coverage: Float32Array,
  groutLin: Lin3,
  w: number,
  h: number,
  sigmaCells = 2,
  k = 1,
): FarResult {
  return farDeltaE(prepareFarModel({ w, h, target: targetLin, stones: stoneLin, coverage, sigmaCells, k }), groutLin);
}

// ---------------------------------------------------------------- Empfehlung

export interface GroutCandidate {
  /** i18n-Schlüssel-Teil: grout.c.<key>; 'current' = aktuelle Farbe des Projekts */
  key: string;
  hex: string;
}

/** Allgemeine Fugenfarben (keine Marken; echte Produkte weichen ab, getrocknete Probe messen). */
export const GROUT_CANDIDATES: readonly GroutCandidate[] = [
  { key: 'white', hex: '#F2F0EA' },
  { key: 'lightgrey', hex: '#BDB8AE' },
  { key: 'silver', hex: '#9A9A96' },
  { key: 'cement', hex: '#808080' },
  { key: 'darkgrey', hex: '#5A5A5A' },
  { key: 'anthracite', hex: '#404040' },
  { key: 'black', hex: '#202020' },
];

/** Kandidaten inkl. der aktuellen Farbe (falls sie keine der Standardfarben ist). */
export function groutCandidates(currentHex?: string | null): GroutCandidate[] {
  const list = GROUT_CANDIDATES.map((c) => ({ ...c }));
  const cur = currentHex ? normHex(currentHex) : null;
  if (cur && hexToLinear(cur) && !list.some((c) => c.hex === cur)) list.push({ key: 'current', hex: cur });
  return list;
}

export function normHex(hex: string): string {
  let s = hex.trim().replace(/^#/, '').toUpperCase();
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return `#${s}`;
}

export interface GroutScore extends GroutCandidate, FarResult {}

/** Alle Kandidaten bewerten, beste zuerst (kleinster Mittelwert, bei Gleichstand kleineres 95-%-Quantil). */
export function recommendGrout(model: FarModel, candidates: readonly GroutCandidate[] = GROUT_CANDIDATES): GroutScore[] {
  const res: GroutScore[] = [];
  for (const c of candidates) {
    const lin = hexToLinear(c.hex);
    if (!lin) continue;
    res.push({ ...c, hex: normHex(c.hex), ...farDeltaE(model, lin) });
  }
  return res.sort((a, b) => a.mean - b.mean || a.p95 - b.p95);
}

/**
 * Lohnt sich ein Wechsel? Nur wenn die beste Farbe die aktuelle klar schlägt (≥ 0,5 ΔE und ≥ 5 %),
 * sonst gilt die aktuelle Fuge als passend – das Modell ist eine Schätzung, kleine Unterschiede sind Rauschen.
 */
export const MIN_GAIN_ABS = 0.5;
export const MIN_GAIN_REL = 0.05;
export function worthSwitching(current: FarResult, best: FarResult): boolean {
  const gain = current.mean - best.mean;
  return gain >= MIN_GAIN_ABS && gain >= current.mean * MIN_GAIN_REL;
}
