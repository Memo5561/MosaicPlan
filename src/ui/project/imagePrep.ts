/**
 * Geometrische Bildvorbereitung über Canvas: Drehen, Spiegeln, Zuschneiden,
 * Skalieren auf die Arbeitsauflösung.
 */
import type { ImageAdjust } from '../../core/types';
import type { RawImage } from '../../workers/protocol';

export type Crop = { x: number; y: number; w: number; h: number };

/** Volle Dekodierung (EXIF-Ausrichtung beachtet). Für Fotos über MAX_WORKING_PX `loadWorkingBitmap` verwenden. */
export async function loadBitmap(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(blob);
  }
}

// ---------- Foto laden: begrenzte Arbeitskopie

/**
 * Größte Arbeitskopie im Speicher (Pixel, ≈ 64 MB RGBA). Größere Fotos werden beim Laden einheitlich
 * verkleinert; die Berechnung liest bei Bedarf das Original in voller Auflösung (siehe useProject.compute).
 */
export const MAX_WORKING_PX = 16_000_000;

export interface WorkingBitmap {
  /** Arbeitskopie (bei großen Fotos verkleinert, sonst volle Auflösung) */
  bitmap: ImageBitmap;
  /** Pixelmaße des Originalfotos nach EXIF-Ausrichtung */
  srcW: number;
  srcH: number;
  /** true: `bitmap` ist kleiner als das Original */
  reduced: boolean;
}

/**
 * Pixelmaße eines Fotos über ein <img>, ohne das Bild vollständig zu dekodieren. naturalWidth/-Height
 * berücksichtigen die EXIF-Ausrichtung (Chromium/WebView ab 81, Safari ab 13.1, Firefox ab 77).
 */
export function readImageSize(blob: Blob): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w > 0 && h > 0) resolve({ w, h });
      else reject(new Error('image-size'));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image-size'));
    };
    img.src = url;
  });
}

/**
 * Zielbreite der Arbeitskopie für ein Foto srcW × srcH: EIN Maßstab für beide Achsen, Fläche ≤ maxPx
 * (die Höhe ergibt sich beim Dekodieren als ⌈srcH · w / srcW⌉). null = keine Verkleinerung nötig.
 */
export function workingBitmapTarget(srcW: number, srcH: number, maxPx = MAX_WORKING_PX): { w: number; h: number } | null {
  if (!(srcW > 0 && srcH > 0) || srcW * srcH <= maxPx) return null;
  let w = Math.max(1, Math.floor(srcW * Math.sqrt(maxPx / (srcW * srcH))));
  const hOf = (x: number) => Math.max(1, Math.ceil((srcH * x) / srcW));
  while (w > 1 && w * hOf(w) > maxPx) w--;
  return { w, h: hOf(w) };
}

/** Relative Abweichung zweier Seitenverhältnisse (0,005 = 0,5 %). */
export function aspectDrift(aW: number, aH: number, bW: number, bH: number): number {
  return Math.abs(aW / aH / (bW / bH) - 1);
}

/** Höchstens so viel darf das Seitenverhältnis der verkleinerten Kopie abweichen, sonst volle Dekodierung. */
export const MAX_ASPECT_DRIFT = 0.005;

/**
 * Lädt ein Foto als Arbeitskopie: Bis MAX_WORKING_PX unverändert, darüber einheitlich verkleinert
 * (EXIF-Ausrichtung, hochwertige Skalierung). Nur die Breite wird vorgegeben, damit der Browser das
 * Seitenverhältnis der ausgerichteten Quelle selbst erhält. Weicht das Ergebnis trotzdem um mehr als
 * 0,5 % ab (ältere WebViews skalieren vor dem Drehen) oder wirft der Aufruf, wird wie bisher voll dekodiert.
 * Hinweis: Chromium dekodiert auch beim Verkleinern zunächst voll – die Speicherspitze beim Laden
 * bleibt, danach belegt das Foto aber höchstens ≈ 64 MB statt z. B. 190 MB (48 MP).
 * Wirft, wenn das Foto nicht gelesen werden kann (beschädigt, nicht unterstütztes Format).
 */
export async function loadWorkingBitmap(blob: Blob, maxPx = MAX_WORKING_PX): Promise<WorkingBitmap> {
  let size: { w: number; h: number } | null = null;
  try {
    size = await readImageSize(blob);
  } catch {
    size = null; // die volle Dekodierung unten entscheidet, ob das Foto lesbar ist
  }
  const target = size ? workingBitmapTarget(size.w, size.h, maxPx) : null;
  if (size && target) {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: target.w, resizeQuality: 'high' });
      if (bmp.width < size.w && aspectDrift(bmp.width, bmp.height, size.w, size.h) <= MAX_ASPECT_DRIFT) return { bitmap: bmp, srcW: size.w, srcH: size.h, reduced: true };
      bmp.close();
    } catch {
      /* ältere Browser: volle Dekodierung */
    }
  }
  const full = await loadBitmap(blob);
  // Maße aus der vollen Dekodierung: dieselbe Ausrichtung wie die Arbeitskopie
  return { bitmap: full, srcW: full.width, srcH: full.height, reduced: false };
}

/**
 * Braucht die Berechnung das Original in voller Auflösung? Ja, wenn die (verkleinerte) Arbeitskopie im
 * Zuschnitt weniger Pixel hat als die Arbeitsauflösung `ws` – dann wäre das Ergebnis unschärfer als mit
 * dem Original. `bw × bh`: gedrehte Größe der Arbeitskopie.
 */
export function needsFullResolution(reduced: boolean, crop: Crop, bw: number, bh: number, ws: { w: number; h: number }): boolean {
  return reduced && crop.w * bw * crop.h * bh < ws.w * ws.h;
}

/** Fehler beim Speichern eines bereits gelesenen Fotos (für die Wahl der Fehlermeldung). */
export class PhotoSaveError extends Error {
  readonly original: unknown;
  constructor(original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'PhotoSaveError';
    this.original = original;
  }
}

export type PhotoErrorKey = 'photo.err.heic' | 'photo.err.decode' | 'photo.err.save';

/**
 * Passende Fehlermeldung, NACHDEM Lesen oder Speichern fehlschlug. Dateien werden vorher nie nach Typ
 * abgelehnt (manche Auswahldialoge melden einen leeren Typ, Safari kann HEIC lesen).
 */
export function photoErrorKey(file: { type?: string; name?: string }, err: unknown): PhotoErrorKey {
  const name = err && typeof err === 'object' ? (err as { name?: string }).name : undefined;
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (err instanceof PhotoSaveError || name === 'QuotaExceededError' || /quota/i.test(message)) return 'photo.err.save';
  if (/hei[cf]/i.test(file.type ?? '') || /\.hei[cf]$/i.test(file.name ?? '')) return 'photo.err.heic';
  return 'photo.err.decode';
}

// ---------- Zuschnitt: reine Geometrie (normierte Koordinaten 0…1 des gedrehten Bildes)

export type Corner = 'nw' | 'ne' | 'sw' | 'se';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Hält einen Zuschnitt im Bild (Größe bleibt, nur die Lage wird begrenzt). */
function placeInside(x: number, y: number, w: number, h: number): Crop {
  const wc = Math.min(1, w);
  const hc = Math.min(1, h);
  return { x: clamp(x, 0, 1 - wc), y: clamp(y, 0, 1 - hc), w: wc, h: hc };
}

/**
 * Größe ändern an einer Ecke; die gegenüberliegende Ecke bleibt fest. Gerechnet wird in Pixeln des
 * gedrehten Originals (rw × rh), damit das Seitenverhältnis `aspect` (Breite/Höhe der Mosaikfläche) exakt
 * bleibt. Die Zugbewegung (dx, dy in denselben Pixeln) wird auf die Diagonale projiziert – auch eine fast
 * senkrechte Fingerbewegung ändert die Größe. Begrenzt auf das Bild und auf `minShort` (kürzere Seite).
 */
export function resizeCropFromCorner(start: Crop, corner: Corner, dx: number, dy: number, rw: number, rh: number, aspect: number, minShort: number): Crop {
  const sx = corner === 'ne' || corner === 'se' ? 1 : -1;
  const sy = corner === 'sw' || corner === 'se' ? 1 : -1;
  const w0 = start.w * rw;
  const ax = sx > 0 ? start.x * rw : (start.x + start.w) * rw;
  const ay = sy > 0 ? start.y * rh : (start.y + start.h) * rh;
  const maxW = Math.max(0, Math.min(sx > 0 ? rw - ax : ax, (sy > 0 ? rh - ay : ay) * aspect));
  const minW = Math.min(minShort * Math.max(1, aspect), w0, maxW);
  const dW = (aspect * (sx * dx * aspect + sy * dy)) / (aspect * aspect + 1);
  const w = clamp(w0 + dW, minW, maxW);
  const h = w / aspect;
  const left = sx > 0 ? ax : ax - w;
  const top = sy > 0 ? ay : ay - h;
  return placeInside(left / rw, top / rh, w / rw, h / rh);
}

/** Verschieben um (dx, dy) normiert, im Bild begrenzt. */
export function moveCrop(start: Crop, dx: number, dy: number): Crop {
  return placeInside(start.x + dx, start.y + dy, start.w, start.h);
}

/** Größter Zuschnitt mit diesem Seitenverhältnis (= 100 % beim Zoom). */
export function maxCrop(rw: number, rh: number, aspect: number): Crop {
  return defaultCrop(rw, rh, aspect);
}

/** Größe des Zuschnitts relativ zum größtmöglichen (1 = ganzes Bild in einer Richtung). */
export function cropZoomOf(crop: Crop, rw: number, rh: number, aspect: number): number {
  const m = maxCrop(rw, rh, aspect);
  return clamp(crop.w / m.w, 0, 1);
}

/**
 * Zuschnitt auf `z` (0…1) des größtmöglichen skalieren; die Mitte bleibt, soweit das Bild es zulässt.
 * Seitenverhältnis exakt wie maxCrop.
 */
export function zoomCrop(crop: Crop, rw: number, rh: number, aspect: number, z: number): Crop {
  const m = maxCrop(rw, rh, aspect);
  const zz = clamp(z, 0.01, 1);
  const w = m.w * zz;
  const h = m.h * zz;
  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;
  return placeInside(cx - w / 2, cy - h / 2, w, h);
}

/**
 * Zwei-Finger-Zoom am Rahmen: Größe × `scale` um die Mitte, Mitte verschiebt sich um (dx, dy) normiert.
 * Begrenzt auf das Bild und `minShort` Pixel (kürzere Seite, Pixel des gedrehten Originals).
 */
export function pinchCrop(start: Crop, scale: number, dx: number, dy: number, rw: number, rh: number, aspect: number, minShort: number): Crop {
  const m = maxCrop(rw, rh, aspect);
  const w0 = start.w * rw;
  const minW = Math.min(minShort * Math.max(1, aspect), w0);
  const wPx = clamp(w0 * (Number.isFinite(scale) && scale > 0 ? scale : 1), minW, m.w * rw);
  const w = wPx / rw;
  const h = wPx / aspect / rh;
  const cx = start.x + start.w / 2 + dx;
  const cy = start.y + start.h / 2 + dy;
  return placeInside(cx - w / 2, cy - h / 2, w, h);
}

/**
 * Ausschnitt in Pixeln des Originals und Pixel je Rasterposition (Mittelwert: Breite/Spalten,
 * Höhe/Zeilen – Randsteine können schmaler sein, daher „≈“).
 */
export function cropPixelInfo(crop: Crop, rw: number, rh: number, cols: number, rows: number): { w: number; h: number; perStoneW: number; perStoneH: number } {
  const w = Math.round(crop.w * rw);
  const h = Math.round(crop.h * rh);
  return { w, h, perStoneW: cols > 0 ? (crop.w * rw) / cols : 0, perStoneH: rows > 0 ? (crop.h * rh) / rows : 0 };
}

/** Richtwert: darunter enthält ein Stein kaum noch eigene Bildinformation. */
export const LOW_PX_PER_STONE = 3;

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
