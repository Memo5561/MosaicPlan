/**
 * Messgrößen für tests/w3-colour-quality.test.ts (keine Testdatei – wird nur importiert).
 *
 * perceivedDeltaE: Wirkung aus Betrachtungsabstand. Je Rasterzelle wird die Farbe des Fotos (Mittel der Bildpixel
 * der Zelle) und die des Mosaiks (Steinfarben, nach Fläche der exakten Steinpolygone gewichtet; Fugen bleiben
 * außen vor) in linearem Licht gebildet, beide mit einem Gauß (σ = 1 Zelle) weichgezeichnet und danach in CIELAB
 * per CIEDE2000 verglichen – Mittel über alle Zellen.
 */
import { deltaE2000, hexToRgb, type Lab } from '../src/core/color';
import { area } from '../src/core/geometry';
import type { RGBAImage } from '../src/core/imageOps';
import type { Layout } from '../src/core/layout';
import { cellPieces } from '../src/core/pieces';
import { CellKind, type MosaicData, type PaletteColor } from '../src/core/types';

const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linToLab(r: number, g: number, b: number): Lab {
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Separabler Gauß (σ in Zellen) über ein Zellraster mit 3 Kanälen (normiert am Rand). */
function blurGrid(v: Float64Array, cols: number, rows: number, sigma: number): Float64Array {
  const R = Math.ceil(3 * sigma);
  const k = Array.from({ length: 2 * R + 1 }, (_, i) => Math.exp(-((i - R) ** 2) / (2 * sigma * sigma)));
  const tmp = new Float64Array(v.length);
  const out = new Float64Array(v.length);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let ws = 0;
      for (let d = -R; d <= R; d++) {
        const cc = c + d;
        if (cc < 0 || cc >= cols) continue;
        const o = (r * cols + cc) * 3;
        const w = k[d + R];
        s0 += v[o] * w;
        s1 += v[o + 1] * w;
        s2 += v[o + 2] * w;
        ws += w;
      }
      const o = (r * cols + c) * 3;
      tmp[o] = s0 / ws;
      tmp[o + 1] = s1 / ws;
      tmp[o + 2] = s2 / ws;
    }
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let ws = 0;
      for (let d = -R; d <= R; d++) {
        const rr = r + d;
        if (rr < 0 || rr >= rows) continue;
        const o = (rr * cols + c) * 3;
        const w = k[d + R];
        s0 += tmp[o] * w;
        s1 += tmp[o + 1] * w;
        s2 += tmp[o + 2] * w;
        ws += w;
      }
      const o = (r * cols + c) * 3;
      out[o] = s0 / ws;
      out[o + 1] = s1 / ws;
      out[o + 2] = s2 / ws;
    }
  return out;
}

/** Fotofarbe je Zelle in linearem Licht (Mittel der Pixel, deren Mitte in der Zelle liegt). */
export function photoCellsLinear(layout: Layout, img: RGBAImage): Float64Array {
  const { cols, rows } = layout;
  const out = new Float64Array(cols * rows * 3);
  const sx = img.width / layout.finishedW;
  const sy = img.height / layout.finishedH;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x0 = Math.max(0, Math.floor(layout.colX[c] * sx));
      const x1 = Math.min(img.width - 1, Math.max(x0, Math.ceil((layout.colX[c] + layout.colW[c]) * sx) - 1));
      const y0 = Math.max(0, Math.floor(layout.rowY[r] * sy));
      const y1 = Math.min(img.height - 1, Math.max(y0, Math.ceil((layout.rowY[r] + layout.rowH[r]) * sy) - 1));
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let n = 0;
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const o = (y * img.width + x) * 4;
          s0 += LIN[img.data[o]];
          s1 += LIN[img.data[o + 1]];
          s2 += LIN[img.data[o + 2]];
          n++;
        }
      const o = (r * cols + c) * 3;
      out[o] = s0 / n;
      out[o + 1] = s1 / n;
      out[o + 2] = s2 / n;
    }
  return out;
}

/** Mosaikfarbe je Zelle in linearem Licht (Steinfarben nach Fläche der exakten Polygone). */
export function mosaicCellsLinear(layout: Layout, data: MosaicData, palette: PaletteColor[]): Float64Array {
  const lin = palette.map((p) => hexToRgb(p.hex).map((v) => LIN[v]));
  const { cols, rows } = layout;
  const out = new Float64Array(cols * rows * 3);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const o = (r * cols + c) * 3;
      if (data.kind[r * cols + c] === CellKind.FULL) {
        const q = lin[data.c1[r * cols + c]];
        out[o] = q[0];
        out[o + 1] = q[1];
        out[o + 2] = q[2];
        continue;
      }
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let at = 0;
      for (const p of cellPieces(layout, data, r, c)) {
        const a = area(p.poly);
        const q = lin[p.color];
        s0 += q[0] * a;
        s1 += q[1] * a;
        s2 += q[2] * a;
        at += a;
      }
      out[o] = s0 / at;
      out[o + 1] = s1 / at;
      out[o + 2] = s2 / at;
    }
  return out;
}

/** Wahrgenommene Abweichung (σ = 1 Zelle, lineares Licht, ΔE00 im Mittel über alle Zellen). */
export function perceivedDeltaE(layout: Layout, data: MosaicData, palette: PaletteColor[], img: RGBAImage, photo = photoCellsLinear(layout, img)): number {
  const { cols, rows } = layout;
  const a = blurGrid(photo, cols, rows, 1);
  const b = blurGrid(mosaicCellsLinear(layout, data, palette), cols, rows, 1);
  let s = 0;
  const n = cols * rows;
  for (let i = 0; i < n; i++) {
    const p = linToLab(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
    const q = linToLab(b[i * 3], b[i * 3 + 1], b[i * 3 + 2]);
    s += deltaE2000(p[0], p[1], p[2], q[0], q[1], q[2]);
  }
  return s / n;
}

/** Farbwechsel beim Legen: Anteil benachbarter ganzer Steine (rechts/unten) mit unterschiedlicher Farbe. */
export function colourChangeRate(data: MosaicData): number {
  let diff = 0;
  let pairs = 0;
  const { cols, rows } = data;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (data.kind[i] !== CellKind.FULL) continue;
      if (c + 1 < cols && data.kind[i + 1] === CellKind.FULL) {
        pairs++;
        if (data.c1[i] !== data.c1[i + 1]) diff++;
      }
      if (r + 1 < rows && data.kind[i + cols] === CellKind.FULL) {
        pairs++;
        if (data.c1[i] !== data.c1[i + cols]) diff++;
      }
    }
  return pairs ? diff / pairs : 0;
}
