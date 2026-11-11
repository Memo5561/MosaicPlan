/**
 * Vorschau als Bild (PNG) – Paket w6-compare-batch. Ein Bild der Vorschau (wie Schritt 8: Steine, Fuge, Glasur),
 * KEIN maßstäblicher Plan: Pixel je mm sind frei gewählt, Maße stehen nur im PDF und in der CSV.
 *
 *  - Größe: lange Seite 2000/4000/8000 px, höchstens PNG_MAX_MP (am Handy/APK PNG_MAX_MP_NATIVE) Megapixel.
 *  - Ganzes Mosaik oder ein Abschnitt (Weltrechteck bis zur Fugenmitte wie rangeWorldRect).
 *  - Das PNG trägt die Beschriftung „Vorschau – kein maßstäblicher Plan“ als iTXt-Textfeld (Description).
 */
import { buildOverviewRGBA, DEFAULT_GROUT_HEX, pitchPxOf, renderMosaic, type RenderOptions, type View } from './render';
import type { Layout } from './layout';
import type { MosaicData, PaletteColor } from './types';

/** Wählbare lange Seite in Pixeln (8000 nur am Desktop) */
export const PNG_SIZES = [2000, 4000, 8000] as const;
/** Obergrenze in Megapixeln (Browser am Desktop) bzw. im APK/am Handy (kleinere Canvas-Grenzen, weniger Speicher) */
export const PNG_MAX_MP = 40;
export const PNG_MAX_MP_NATIVE = 16;

/** Weltrechteck in mm (Projektkoordinaten) */
export interface WorldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bildgröße für ein Weltrechteck: lange Seite `maxPx`, Fläche ≤ maxMp Megapixel. */
export interface PngSize {
  width: number;
  height: number;
  /** Pixel je mm */
  pxPerMm: number;
  /** wegen der Megapixel-Grenze verkleinert */
  clamped: boolean;
}

export function pngSize(rect: Pick<WorldRect, 'w' | 'h'>, maxPx: number, maxMp: number): PngSize {
  const w = Math.max(1e-9, rect.w);
  const h = Math.max(1e-9, rect.h);
  let scale = Math.min(maxPx / w, maxPx / h);
  const cap = maxMp * 1_000_000;
  let clamped = false;
  const dims = (s: number) => [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))] as const;
  let [W, H] = dims(scale);
  if (W * H > cap) {
    clamped = true;
    scale *= Math.sqrt(cap / (W * H));
    [W, H] = dims(scale);
    // Rundung kann die Grenze knapp überschreiten
    while (W * H > cap && scale > 0) {
      scale *= 0.999;
      [W, H] = dims(scale);
    }
  }
  return { width: W, height: H, pxPerMm: scale, clamped };
}

/** Ganzes Mosaik als Weltrechteck */
export function mosaicRect(layout: Pick<Layout, 'finishedW' | 'finishedH'>): WorldRect {
  return { x: 0, y: 0, w: layout.finishedW, h: layout.finishedH };
}

export interface PreviewRenderOptions {
  groutHex?: string;
  realistic?: boolean;
  surface?: 'glass' | 'ceramic';
  showCodes?: boolean;
}

type Canvas2D = OffscreenCanvasRenderingContext2D;

/**
 * Zeichnet das Weltrechteck `rect` in ein OffscreenCanvas der Größe `size` – dieselbe Zeichnung wie renderFull
 * (bei kleinem Maßstab das Übersichtsbild, sonst jeder Stein mit Fuge), nur auf einen Ausschnitt verschoben.
 */
export function renderPreviewRegion(layout: Layout, data: MosaicData, palette: PaletteColor[], rect: WorldRect, size: PngSize, opt: PreviewRenderOptions = {}): OffscreenCanvas {
  const cv = new OffscreenCanvas(size.width, size.height);
  const ctx = cv.getContext('2d') as Canvas2D;
  const groutHex = opt.groutHex ?? DEFAULT_GROUT_HEX;
  const scale = size.pxPerMm;
  const view: View = {
    scale,
    ox: -rect.x * scale,
    oy: -rect.y * scale,
    width: size.width,
    height: size.height,
  };
  let overview: OffscreenCanvas | null = null;
  if (pitchPxOf(layout, scale) < 3) {
    overview = new OffscreenCanvas(layout.cols, layout.rows);
    const rgba = buildOverviewRGBA(layout, data, palette, groutHex);
    overview.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, layout.cols, layout.rows), 0, 0);
  }
  const ro: RenderOptions = {
    groutHex,
    realistic: opt.realistic ?? true,
    surface: opt.surface ?? 'glass',
    showCodes: opt.showCodes ?? false,
    progressMode: false,
    sections: null,
    focusColor: null,
    overview,
    overviewProgress: null,
    background: groutHex,
  };
  renderMosaic(ctx, layout, data, palette, view, ro);
  return cv;
}

// ---------------------------------------------------------------- PNG-Textfeld

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/** Ist das eine PNG-Datei (Signatur und IHDR als erster Block)? */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 33) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
  return String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) === 'IHDR';
}

/** Breite und Höhe aus dem IHDR-Block */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (!isPng(bytes)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/**
 * Fügt nach dem IHDR-Block iTXt-Textfelder ein (UTF-8, unkomprimiert), z. B. Description = „Vorschau – kein
 * maßstäblicher Plan“. Schlüsselwörter: 1–79 Zeichen Latin-1 ohne Nullbyte. Kein PNG → unverändert zurück.
 */
export function addPngText(bytes: Uint8Array, entries: { keyword: string; text: string }[]): Uint8Array {
  if (!isPng(bytes) || !entries.length) return bytes;
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const e of entries) {
    const kw = e.keyword.replace(/[^\x20-\x7e]/g, '').slice(0, 79) || 'Comment';
    const body = [...Array.from(kw, (ch) => ch.charCodeAt(0)), 0, 0, 0, 0, 0, ...enc.encode(e.text)];
    const chunk = new Uint8Array(12 + body.length);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, body.length);
    chunk.set([105, 84, 88, 116], 4); // "iTXt"
    chunk.set(body, 8);
    dv.setUint32(8 + body.length, crc32(chunk, 4, 8 + body.length));
    chunks.push(chunk);
  }
  const ihdrEnd = 8 + 12 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(8);
  const extra = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(bytes.length + extra);
  out.set(bytes.subarray(0, ihdrEnd), 0);
  let o = ihdrEnd;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  out.set(bytes.subarray(ihdrEnd), o);
  return out;
}

/** iTXt-Textfelder einer PNG-Datei lesen (für Tests und Prüfungen); prüft die CRC jedes Blocks. */
export function readPngText(bytes: Uint8Array): { keyword: string; text: string; crcOk: boolean }[] {
  const out: { keyword: string; text: string; crcOk: boolean }[] = [];
  if (!isPng(bytes)) return out;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  let o = 8;
  while (o + 12 <= bytes.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    if (o + 12 + len > bytes.length) break;
    if (type === 'iTXt') {
      const body = bytes.subarray(o + 8, o + 8 + len);
      const z = body.indexOf(0);
      const keyword = String.fromCharCode(...body.subarray(0, z));
      // Kompressionsflag, -methode, Sprache\0, übersetztes Schlüsselwort\0
      let p = z + 3;
      p = body.indexOf(0, p) + 1;
      p = body.indexOf(0, p) + 1;
      out.push({
        keyword,
        text: dec.decode(body.subarray(p)),
        crcOk: crc32(bytes, o + 4, o + 8 + len) === dv.getUint32(o + 8 + len),
      });
    }
    if (type === 'IEND') break;
    o += 12 + len;
  }
  return out;
}
