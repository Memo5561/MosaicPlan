/**
 * Vergleichsfoto (bearbeitetes Foto der letzten Berechnung) speichern, laden und nachträglich erzeugen
 * (Paket w5-undo-editing). Das Foto gehört genau zu einem Raster (Revision); gespeichert wird es als JPEG mit
 * höchstens 2048 px Kantenlänge im Bild-Datensatz des Projekts (siehe storage/db.ts ImageRecord.reference).
 */
import type { LayoutParams } from '../../core/layout';
import type { ImageAdjust, Region } from '../../core/types';
import type { ProjectRecord, ReferenceImage } from '../../storage/db';
import type { RawImage } from '../../workers/protocol';
import type { ReferenceRequest, ReferenceResponse } from '../../workers/w5-reference.worker';

/** längste Kante des gespeicherten Vergleichsfotos (px) */
export const REFERENCE_MAX_PX = 2048;
export const REFERENCE_QUALITY = 0.88;

/** Maße des gespeicherten Fotos: Seitenverhältnis bleibt, längste Kante ≤ max, nie vergrößert. */
export function referenceSize(w: number, h: number, max = REFERENCE_MAX_PX): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Einstellungen, mit denen das gespeicherte Mosaik berechnet wurde (aus computedWith), oder null. */
export function computedSettings(rec: Pick<ProjectRecord, 'computedWith'>): { lp: LayoutParams; adjust: ImageAdjust; regions: Region[]; imageRev: string | null } | null {
  if (!rec.computedWith) return null;
  try {
    const k = JSON.parse(rec.computedWith) as { l?: LayoutParams; a?: ImageAdjust; rg?: Region[]; im?: string };
    if (!k || typeof k !== 'object' || !k.l || !k.a) return null;
    return { lp: k.l, adjust: k.a, regions: Array.isArray(k.rg) ? k.rg : [], imageRev: k.im ?? null };
  } catch {
    return null;
  }
}

/** Projektstand mit den Raster-, Foto- und Bereichseinstellungen der letzten Berechnung (für describeComputeInputs). */
export function recordAtCompute(rec: ProjectRecord): ProjectRecord | null {
  const k = computedSettings(rec);
  if (!k) return null;
  return { ...rec, settings: { ...rec.settings, ...k.lp }, adjust: { ...k.adjust }, regions: k.regions };
}

/**
 * Warum das Vergleichsfoto nicht neu erzeugt werden kann (null: möglich). Erzeugt wird es aus dem GESPEICHERTEN Foto
 * mit den Einstellungen der letzten Berechnung – nur, wenn das Foto noch dasselbe ist.
 */
export type RegenerateBlock = 'not-computed' | 'no-key' | 'no-photo' | 'photo-changed';
export function regenerateBlock(rec: Pick<ProjectRecord, 'computedWith' | 'imageRev'> | null, computed: boolean, hasPhoto: boolean): RegenerateBlock | null {
  if (!rec || !computed) return 'not-computed';
  const k = computedSettings(rec);
  if (!k) return 'no-key';
  if (!hasPhoto) return 'no-photo';
  if ((k.imageRev ?? null) !== (rec.imageRev ?? null)) return 'photo-changed';
  return null;
}

/** Kopie in höchstens `max` px Kantenlänge (für das Speichern) */
export function scaledCanvas(src: HTMLCanvasElement, max = REFERENCE_MAX_PX): HTMLCanvasElement {
  const { w, h } = referenceSize(src.width, src.height, max);
  if (w === src.width && h === src.height) return src;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

/** JPEG (≤ 2048 px) des bearbeiteten Fotos; null, wenn der Browser es nicht erzeugen kann. Revision setzt der Aufrufer. */
export async function encodeReference(src: HTMLCanvasElement, origin: ReferenceImage['origin']): Promise<ReferenceImage | null> {
  try {
    const c = scaledCanvas(src);
    const jpeg = await new Promise<Blob | null>((res) => c.toBlob((b) => res(b), 'image/jpeg', REFERENCE_QUALITY));
    if (!jpeg) return null;
    return { jpeg, w: c.width, h: c.height, origin, at: Date.now() };
  } catch (e) {
    console.warn('Vergleichsfoto konnte nicht kodiert werden', e);
    return null;
  }
}

/** Gespeichertes Vergleichsfoto als Canvas */
export async function decodeReference(ref: ReferenceImage): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(ref.jpeg);
  try {
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    return c;
  } finally {
    bmp.close();
  }
}

let seq = 1;
/** Bildbearbeitung wie bei der Berechnung (applyAdjustments) im eigenen Worker. Die Bildpunkte werden übergeben (nicht kopiert). */
export function processInWorker(raw: RawImage, adjust: ImageAdjust, regions: Region[]): Promise<RawImage> {
  return new Promise((resolve, reject) => {
    let w: Worker;
    try {
      w = new Worker(new URL('../../workers/w5-reference.worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const id = seq++;
    w.onmessage = (ev: MessageEvent<ReferenceResponse>) => {
      if (ev.data.id !== id) return;
      w.terminate();
      if (ev.data.ok) resolve({ width: ev.data.width, height: ev.data.height, data: ev.data.data });
      else reject(new Error(ev.data.message));
    };
    w.onerror = (e) => {
      e.preventDefault();
      w.terminate();
      reject(new Error(e.message || 'Worker-Fehler'));
    };
    const req: ReferenceRequest = { id, width: raw.width, height: raw.height, data: raw.data, adjust, regions };
    w.postMessage(req, [raw.data.buffer as ArrayBuffer]);
  });
}
