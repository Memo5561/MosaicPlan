/**
 * Pixel-Bildverarbeitung auf RGBA-Puffern (ohne DOM, auch im Worker und in
 * Node-Tests nutzbar). Geometrische Operationen (Drehen, Zuschneiden,
 * Skalieren) erledigt die Oberfläche über Canvas.
 */
import type { ImageAdjust, Region } from './types';

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function cloneImage(img: RGBAImage): RGBAImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** Separierbarer Boxfilter (Radius r), auf Float32-Kanal. */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  r = Math.max(0, Math.round(r));
  if (r === 0) return src.slice();
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / win;
      const add = src[row + Math.min(w - 1, x + r + 1)];
      const sub = src[row + Math.max(0, x - r)];
      acc += add - sub;
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / win;
      const add = tmp[Math.min(h - 1, y + r + 1) * w + x];
      const sub = tmp[Math.max(0, y - r) * w + x];
      acc += add - sub;
    }
  }
  return out;
}

/** Näherung eines Gaußfilters durch dreifachen Boxfilter. */
export function gaussBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0.3) return src.slice();
  const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2));
  return boxBlur(boxBlur(boxBlur(src, w, h, r), w, h, r), w, h, r);
}

export function splitChannels(img: RGBAImage): [Float32Array, Float32Array, Float32Array] {
  const n = img.width * img.height;
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    r[i] = d[i * 4];
    g[i] = d[i * 4 + 1];
    b[i] = d[i * 4 + 2];
  }
  return [r, g, b];
}

export function luminance(img: RGBAImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) out[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
  return out;
}

/** Sobel-Gradientenbetrag. */
export function sobel(L: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const at = (x: number, y: number) => L[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      out[y * w + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

export function percentile(arr: Float32Array, p: number): number {
  const step = Math.max(1, Math.floor(arr.length / 50000));
  const sample: number[] = [];
  for (let i = 0; i < arr.length; i += step) sample.push(arr[i]);
  sample.sort((a, b) => a - b);
  return sample[Math.min(sample.length - 1, Math.max(0, Math.floor(p * (sample.length - 1))))];
}

/**
 * Detailkarte 0..1: geglättete Kantendichte, auf das 90. Perzentil normiert.
 */
export function detailMap(img: RGBAImage, blurSigma?: number): Float32Array {
  const { width: w, height: h } = img;
  const g = sobel(luminance(img), w, h);
  const sigma = blurSigma ?? Math.max(1.5, Math.min(w, h) / 120);
  const bl = gaussBlur(g, w, h, sigma);
  const p = percentile(bl, 0.9) || 1;
  for (let i = 0; i < bl.length; i++) bl[i] = Math.min(1, bl[i] / p);
  return bl;
}

/** Maske (0..1) aus Bereichen (normierte Koordinaten). */
export function regionMask(w: number, h: number, regions: Region[], types: Region['type'][]): Float32Array {
  const m = new Float32Array(w * h);
  for (const r of regions) {
    if (!types.includes(r.type)) continue;
    const x0 = Math.max(0, Math.floor(r.x * w));
    const y0 = Math.max(0, Math.floor(r.y * h));
    const x1 = Math.min(w, Math.ceil((r.x + r.w) * w));
    const y1 = Math.min(h, Math.ceil((r.y + r.h) * h));
    const cx = (r.x + r.w / 2) * w;
    const cy = (r.y + r.h / 2) * h;
    const rx = (r.w * w) / 2;
    const ry = (r.h * h) / 2;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        if (r.shape === 'ellipse') {
          const dx = (x + 0.5 - cx) / rx;
          const dy = (y + 0.5 - cy) / ry;
          if (dx * dx + dy * dy > 1) continue;
        }
        m[y * w + x] = 1;
      }
  }
  return m;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Wendet die Farb-/Tonwert-/Schärfe-Einstellungen an.
 * Gesichts-/Schutzbereiche werden von der Hintergrundvereinfachung ausgenommen.
 */
export function applyAdjustments(src: RGBAImage, adj: ImageAdjust, regions: Region[] = []): RGBAImage {
  const { width: w, height: h } = src;
  const n = w * h;
  const [R, G, B] = splitChannels(src);

  if (adj.whiteBalance) {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let i = 0; i < n; i++) {
      sr += R[i];
      sg += G[i];
      sb += B[i];
    }
    const gray = (sr + sg + sb) / 3;
    const fr = sr > 0 ? gray / sr : 1;
    const fg = sg > 0 ? gray / sg : 1;
    const fb = sb > 0 ? gray / sb : 1;
    // abgeschwächter Grauwelt-Abgleich (50 %), um Bildstimmung nicht zu zerstören
    const mix = (f: number) => 1 + (f - 1) * 0.5;
    const mr = mix(fr);
    const mg = mix(fg);
    const mb = mix(fb);
    for (let i = 0; i < n; i++) {
      R[i] = clamp255(R[i] * mr);
      G[i] = clamp255(G[i] * mg);
      B[i] = clamp255(B[i] * mb);
    }
  }

  if (adj.autoLevels) {
    const L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
    const lo = percentile(L, 0.005);
    const hi = percentile(L, 0.995);
    if (hi - lo > 10) {
      const f = 255 / (hi - lo);
      for (let i = 0; i < n; i++) {
        R[i] = clamp255((R[i] - lo) * f);
        G[i] = clamp255((G[i] - lo) * f);
        B[i] = clamp255((B[i] - lo) * f);
      }
    }
  }

  if (adj.brightness !== 0 || adj.contrast !== 0) {
    const bv = adj.brightness * 1.28;
    const c = adj.contrast * 1.28;
    const f = (259 * (c + 255)) / (255 * (259 - c));
    for (let i = 0; i < n; i++) {
      R[i] = clamp255(f * (R[i] + bv - 128) + 128);
      G[i] = clamp255(f * (G[i] + bv - 128) + 128);
      B[i] = clamp255(f * (B[i] + bv - 128) + 128);
    }
  }

  if (adj.saturation !== 0) {
    const s = 1 + adj.saturation / 100;
    for (let i = 0; i < n; i++) {
      const y = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
      R[i] = clamp255(y + (R[i] - y) * s);
      G[i] = clamp255(y + (G[i] - y) * s);
      B[i] = clamp255(y + (B[i] - y) * s);
    }
  }

  const protect = regions.length ? regionMask(w, h, regions, ['face', 'detail']) : null;

  if (adj.bgSimplify > 0) {
    const tmp: RGBAImage = { width: w, height: h, data: mergeChannels(R, G, B, w, h).data };
    const dm = detailMap(tmp);
    const sigma = Math.max(2, Math.min(w, h) / 70);
    const bR = gaussBlur(R, w, h, sigma);
    const bG = gaussBlur(G, w, h, sigma);
    const bB = gaussBlur(B, w, h, sigma);
    const strength = adj.bgSimplify / 100;
    // Detailkarte weichzeichnen, damit Übergänge nicht hart werden
    const dmS = gaussBlur(dm, w, h, sigma);
    for (let i = 0; i < n; i++) {
      const keep = Math.max(dmS[i] * 1.6, protect ? protect[i] : 0);
      const t = strength * Math.max(0, 1 - Math.min(1, keep)) ** 1.5;
      R[i] = R[i] + (bR[i] - R[i]) * t;
      G[i] = G[i] + (bG[i] - G[i]) * t;
      B[i] = B[i] + (bB[i] - B[i]) * t;
    }
  }

  if (adj.detailBoost > 0) {
    const sigma = Math.max(2, Math.min(w, h) / 90);
    const amount = (adj.detailBoost / 100) * 0.9;
    const bR = gaussBlur(R, w, h, sigma);
    const bG = gaussBlur(G, w, h, sigma);
    const bB = gaussBlur(B, w, h, sigma);
    for (let i = 0; i < n; i++) {
      R[i] = clamp255(R[i] + (R[i] - bR[i]) * amount);
      G[i] = clamp255(G[i] + (G[i] - bG[i]) * amount);
      B[i] = clamp255(B[i] + (B[i] - bB[i]) * amount);
    }
  }

  if (adj.sharpen > 0) {
    const amount = adj.sharpen / 50;
    const bR = gaussBlur(R, w, h, 1.2);
    const bG = gaussBlur(G, w, h, 1.2);
    const bB = gaussBlur(B, w, h, 1.2);
    for (let i = 0; i < n; i++) {
      R[i] = clamp255(R[i] + (R[i] - bR[i]) * amount);
      G[i] = clamp255(G[i] + (G[i] - bG[i]) * amount);
      B[i] = clamp255(B[i] + (B[i] - bB[i]) * amount);
    }
  }

  const out = mergeChannels(R, G, B, w, h);
  // Alpha übernehmen (transparente Bereiche werden in der Berechnung als Weiß behandelt)
  for (let i = 0; i < n; i++) out.data[i * 4 + 3] = src.data[i * 4 + 3];
  return out;
}

export function mergeChannels(R: Float32Array, G: Float32Array, B: Float32Array, w: number, h: number): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = R[i];
    data[i * 4 + 1] = G[i];
    data[i * 4 + 2] = B[i];
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

/** Bilineares Herunterskalieren mit Flächenmittelung (für Tests ohne Canvas). */
export function resizeArea(src: RGBAImage, tw: number, th: number): RGBAImage {
  const out = new Uint8ClampedArray(tw * th * 4);
  const sx = src.width / tw;
  const sy = src.height / th;
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          c++;
        }
      const o = (y * tw + x) * 4;
      out[o] = r / c;
      out[o + 1] = g / c;
      out[o + 2] = b / c;
      out[o + 3] = 255;
    }
  }
  return { width: tw, height: th, data: out };
}

/** Schneidet ein Bild mittig auf ein Seitenverhältnis zu (ohne Verzerrung). */
export function centerCropToAspect(src: RGBAImage, aspect: number): RGBAImage {
  const ia = src.width / src.height;
  let cw = src.width;
  let ch = src.height;
  if (ia > aspect) cw = Math.round(src.height * aspect);
  else ch = Math.round(src.width / aspect);
  const ox = Math.floor((src.width - cw) / 2);
  const oy = Math.floor((src.height - ch) / 2);
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const s = ((y + oy) * src.width + ox) * 4;
    out.set(src.data.subarray(s, s + cw * 4), y * cw * 4);
  }
  return { width: cw, height: ch, data: out };
}
