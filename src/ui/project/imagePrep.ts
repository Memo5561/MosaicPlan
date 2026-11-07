/**
 * Geometrische Bildvorbereitung über Canvas: Drehen, Spiegeln, Zuschneiden,
 * Skalieren auf die Arbeitsauflösung.
 */
import type { ImageAdjust } from '../../core/types';
import type { RawImage } from '../../workers/protocol';

export type Crop = { x: number; y: number; w: number; h: number };

export async function loadBitmap(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(blob);
  }
}

export function rotatedSize(w: number, h: number, adj: Pick<ImageAdjust, 'rotation' | 'fineRotate'>) {
  const a = ((adj.rotation + adj.fineRotate) * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  return { w: w * c + h * s, h: w * s + h * c };
}

/** Standard-Zuschnitt: größtmögliches mittiges Rechteck mit Seitenverhältnis `aspect` (B/H). */
export function defaultCrop(rw: number, rh: number, aspect: number): Crop {
  const ia = rw / rh;
  if (ia > aspect) {
    const w = (rh * aspect) / rw;
    return { x: (1 - w) / 2, y: 0, w, h: 1 };
  }
  const h = rw / aspect / rh;
  return { x: 0, y: (1 - h) / 2, w: 1, h };
}

/** Passt einen vorhandenen Zuschnitt an ein neues Seitenverhältnis an (Mitte bleibt erhalten). */
export function fitCrop(c: Crop | null, rw: number, rh: number, aspect: number): Crop {
  if (!c) return defaultCrop(rw, rh, aspect);
  const cx = c.x + c.w / 2;
  const cy = c.y + c.h / 2;
  // Fläche ungefähr beibehalten
  const areaPx = c.w * rw * c.h * rh;
  let wPx = Math.sqrt(areaPx * aspect);
  let hPx = wPx / aspect;
  const sc = Math.min(1, rw / wPx, rh / hPx);
  wPx *= sc;
  hPx *= sc;
  const w = wPx / rw;
  const h = hPx / rh;
  const x = Math.min(1 - w, Math.max(0, cx - w / 2));
  const y = Math.min(1 - h, Math.max(0, cy - h / 2));
  return { x, y, w, h };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function drawRotated(ctx: CanvasRenderingContext2D, bmp: CanvasImageSource & { width: number; height: number }, adj: ImageAdjust, scale: number, rw: number, rh: number) {
  ctx.save();
  ctx.translate((rw * scale) / 2, (rh * scale) / 2);
  ctx.rotate(((adj.rotation + adj.fineRotate) * Math.PI) / 180);
  if (adj.flipH) ctx.scale(-1, 1);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, (-bmp.width * scale) / 2, (-bmp.height * scale) / 2, bmp.width * scale, bmp.height * scale);
  ctx.restore();
}

/** Gedrehtes/gespiegeltes Gesamtbild (ohne Zuschnitt), max. `maxPx` lange Seite. */
export function renderRotated(bmp: ImageBitmap, adj: ImageAdjust, maxPx: number): HTMLCanvasElement {
  const { w, h } = rotatedSize(bmp.width, bmp.height, adj);
  const scale = Math.min(1, maxPx / Math.max(w, h));
  const c = makeCanvas(w * scale, h * scale);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  drawRotated(ctx, bmp, adj, scale, w, h);
  return c;
}

/** Zugeschnittenes Bild in Zielgröße (tw × th) als Canvas. */
export function renderCropped(bmp: ImageBitmap, adj: ImageAdjust, crop: Crop, tw: number, th: number): HTMLCanvasElement {
  const { w: rw, h: rh } = rotatedSize(bmp.width, bmp.height, adj);
  const cropPxW = crop.w * rw;
  const finalScale = tw / cropPxW;
  // Zwischenstufen für hochwertiges Verkleinern
  let scale = Math.min(1, finalScale * 2);
  let src: HTMLCanvasElement = makeCanvas(cropPxW * scale, crop.h * rh * scale);
  {
    const ctx = src.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, src.width, src.height);
    ctx.translate(-crop.x * rw * scale, -crop.y * rh * scale);
    drawRotated(ctx, bmp, adj, scale, rw, rh);
  }
  while (scale > finalScale * 1.01) {
    const next = Math.max(finalScale, scale / 2);
    const c = makeCanvas(next === finalScale ? tw : cropPxW * next, next === finalScale ? th : crop.h * rh * next);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    src = c;
    scale = next;
  }
  if (src.width !== tw || src.height !== th) {
    const c = makeCanvas(tw, th);
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, tw, th);
    src = c;
  }
  return src;
}

export function canvasToRaw(c: HTMLCanvasElement): RawImage {
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
  return { width: d.width, height: d.height, data: d.data };
}

export function rawToCanvas(img: RawImage): HTMLCanvasElement {
  const c = makeCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

/** Arbeitsauflösung: ~6×6 Pixel je Rasterzelle, 0,25–6 Megapixel, nicht größer als die Quelle. */
export function workingSize(cells: number, aspect: number, sourcePx: number): { w: number; h: number } {
  const px = Math.min(6_000_000, Math.max(250_000, cells * 36), Math.max(sourcePx, 250_000));
  const w = Math.max(16, Math.round(Math.sqrt(px * aspect)));
  const h = Math.max(16, Math.round(w / aspect));
  return { w, h };
}

export async function canvasToJpeg(c: HTMLCanvasElement | OffscreenCanvas, quality = 0.88): Promise<string> {
  const blob = c instanceof HTMLCanvasElement ? await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/jpeg', quality)) : await c.convertToBlob({ type: 'image/jpeg', quality });
  return await new Promise<string>((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.readAsDataURL(blob);
  });
}

interface DetectedFace {
  boundingBox: DOMRectReadOnly;
}

/** Automatische Gesichtserkennung über die Shape-Detection-API, falls der Browser sie anbietet. */
export async function detectFaces(c: HTMLCanvasElement): Promise<{ x: number; y: number; w: number; h: number }[] | null> {
  const FD = (globalThis as unknown as { FaceDetector?: new (o?: object) => { detect: (s: CanvasImageSource) => Promise<DetectedFace[]> } }).FaceDetector;
  if (!FD) return null;
  try {
    const det = new FD({ fastMode: false, maxDetectedFaces: 10 });
    const faces = await det.detect(c);
    return faces.map((f) => ({ x: f.boundingBox.x / c.width, y: f.boundingBox.y / c.height, w: f.boundingBox.width / c.width, h: f.boundingBox.height / c.height }));
  } catch {
    return null;
  }
}
