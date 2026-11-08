/**
 * Offline-Gesichtserkennung (Vorschläge) mit pico.js und der mitgelieferten Kaskade „facefinder“
 * (beide MIT, src/vendor/pico/LICENSE). Reine Funktionen ohne DOM – laufen im Face-Worker und in den Tests.
 *
 * Grenzen (so auch in der Oberfläche beschrieben): erkannt werden nur annähernd frontale menschliche Gesichter,
 * aufrecht oder bis etwa 25° geneigt – keine Profile, keine Tiere, keine sehr kleinen Gesichter. Das Ergebnis
 * ist nur ein Vorschlag; die App übernimmt nie etwas ohne Bestätigung.
 */
import pico, { type ClassifyRegion, type PicoDetection } from '../vendor/pico/pico.js';

/** Erkanntes Gesicht, normiert auf 0..1 bezogen auf das untersuchte Bild (x/w über die Breite, y/h über die Höhe). */
export interface FaceBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Erkennungswert von pico (Summe der Einzeltreffer im besten Cluster) – keine Wahrscheinlichkeit */
  score: number;
  /** Neigung des Kopfes in Grad (Suchdurchgang, der den Treffer lieferte; 0 = aufrecht) */
  angle: number;
}

export interface FaceDetectOptions {
  /** kleinste gesuchte Gesichtsgröße als Anteil der kürzeren Bildseite */
  minSizeFrac?: number;
  /** kleinste gesuchte Gesichtsgröße in Pixeln (untere Grenze für minSizeFrac) */
  minSizePx?: number;
  /** Faktor zwischen den Suchgrößen */
  scaleFactor?: number;
  /** Schrittweite der Suche als Anteil der Suchgröße */
  shiftFactor?: number;
  /** Überlappung (IoU), ab der Einzeltreffer eines Durchgangs zu einem Gesicht zusammengefasst werden */
  iou?: number;
  /** Mindest-Erkennungswert eines Gesichts (Qualitätsschwelle) */
  minScore?: number;
  /** höchstens so viele Gesichter (die besten) */
  maxFaces?: number;
  /** Neigungen in Grad, für die gesucht wird (pico selbst findet nur etwa ±10° um die Senkrechte) */
  angles?: readonly number[];
}

/**
 * Qualitätsschwelle für den Erkennungswert. Gemessen mit den Standardwerten unten (Auswertung in
 * tests/w4-face-detector.test.ts und im Bericht des Pakets): echte, aufrechte Gesichter in 640-px-Bildern
 * erreichen etwa 70–400, Fehltreffer auf Landschaft, Stadt, Tieren und Gegenständen höchstens etwa 20.
 * Die pico-Beispiele verwenden ebenfalls 50.
 */
export const FACE_MIN_SCORE = 50;

/** Richtwert-Stufen für die Anzeige („Sicherheit: gering / mittel / hoch“), keine Wahrscheinlichkeiten. */
export const FACE_SCORE_MEDIUM = 90;
export const FACE_SCORE_HIGH = 150;
export type FaceConfidence = 'low' | 'medium' | 'high';
export function faceConfidence(score: number): FaceConfidence {
  return score >= FACE_SCORE_HIGH ? 'high' : score >= FACE_SCORE_MEDIUM ? 'medium' : 'low';
}

export const DEFAULT_FACE_OPTIONS: Required<FaceDetectOptions> = {
  minSizeFrac: 0.08,
  minSizePx: 24,
  scaleFactor: 1.05,
  shiftFactor: 0.1,
  iou: 0.2,
  minScore: FACE_MIN_SCORE,
  maxFaces: 8,
  angles: [0, -15, 15],
};

/** Kaskade aus den Bytes der Datei facefinder.bin entpacken (einmal je Worker). */
export function loadCascade(bytes: ArrayBuffer | Int8Array | Uint8Array): ClassifyRegion {
  const b = bytes instanceof Int8Array ? bytes : bytes instanceof Uint8Array ? new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Int8Array(bytes);
  // Kopf: 8 Bytes Version, Baumtiefe, Anzahl Bäume (je int32, little endian)
  if (b.length < 16) throw new Error('face-cascade');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const depth = dv.getInt32(8, true);
  const trees = dv.getInt32(12, true);
  const need = 16 + trees * (4 * 2 ** depth - 4 + 4 * 2 ** depth + 4);
  if (!(depth > 0 && depth < 16 && trees > 0 && trees < 10000) || b.length < need) throw new Error('face-cascade');
  return pico.unpack_cascade(b);
}

/** RGBA → Graustufen wie in den pico-Beispielen ((2R + 7G + B) / 10). */
export function rgbaToGray(rgba: ArrayLike<number>, w: number, h: number): Uint8Array {
  const n = w * h;
  if (rgba.length < n * 4) throw new Error('face-image');
  const g = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) g[i] = (2 * rgba[p] + 7 * rgba[p + 1] + rgba[p + 2]) / 10;
  return g;
}

/**
 * Graustufenbild um seine Mitte drehen (bilinear, gleiche Größe, außerhalb mittelgrau). Ein Punkt (x', y')
 * im Ergebnis entspricht `rotatePoint(x', y', w, h, deg)` im Original.
 */
export function rotateGray(gray: ArrayLike<number>, w: number, h: number, deg: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const t = (deg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const sx = cx + dx * cos - dy * sin;
      const sy = cy + dx * sin + dy * cos;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) {
        out[y * w + x] = 128;
        continue;
      }
      const fx = sx - x0;
      const fy = sy - y0;
      const i = y0 * w + x0;
      const top = gray[i] + (gray[i + 1] - gray[i]) * fx;
      const bot = gray[i + w] + (gray[i + w + 1] - gray[i + w]) * fx;
      out[y * w + x] = top + (bot - top) * fy + 0.5;
    }
  }
  return out;
}

/** Punkt des gedrehten Bildes (rotateGray mit deg) → Punkt im Original. */
export function rotatePoint(x: number, y: number, w: number, h: number, deg: number): [number, number] {
  const t = (deg * Math.PI) / 180;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * Math.cos(t) - dy * Math.sin(t), cy + dx * Math.sin(t) + dy * Math.cos(t)];
}

/** Treffer eines Durchgangs: Mitte (Pixel im Original), Kantenlänge, Wert, Neigung */
export interface RawFace {
  cx: number;
  cy: number;
  s: number;
  q: number;
  angle: number;
}

function runPass(classify: ClassifyRegion, gray: ArrayLike<number>, w: number, h: number, o: Required<FaceDetectOptions>, minsize: number): PicoDetection[] {
  const dets = pico.run_cascade({ pixels: gray, nrows: h, ncols: w, ldim: w }, classify, { shiftfactor: o.shiftFactor, minsize, maxsize: Math.min(w, h), scalefactor: o.scaleFactor });
  return pico.cluster_detections(dets, o.iou);
}

const inside = (a: RawFace, b: RawFace) => Math.abs(a.cx - b.cx) <= b.s / 2 && Math.abs(a.cy - b.cy) <= b.s / 2;

function iou(a: RawFace, b: RawFace): number {
  const ox = Math.max(0, Math.min(a.cx + a.s / 2, b.cx + b.s / 2) - Math.max(a.cx - a.s / 2, b.cx - b.s / 2));
  const oy = Math.max(0, Math.min(a.cy + a.s / 2, b.cy + b.s / 2) - Math.max(a.cy - a.s / 2, b.cy - b.s / 2));
  const i = ox * oy;
  return i / (a.s * a.s + b.s * b.s - i);
}

/**
 * Alle Kandidaten (ohne Qualitätsschwelle), nach Wert absteigend. Je Neigung ein Suchdurchgang; Treffer
 * verschiedener Durchgänge an derselben Stelle zählen einmal (der beste). Ein kleinerer Treffer, dessen Mitte in
 * einem besseren liegt (z. B. Nase/Mund im Gesicht), wird verworfen.
 */
export function faceCandidates(classify: ClassifyRegion, gray: ArrayLike<number>, w: number, h: number, opts: FaceDetectOptions = {}): RawFace[] {
  const o = { ...DEFAULT_FACE_OPTIONS, ...opts };
  if (!(w > 0 && h > 0) || gray.length < w * h) return [];
  const short = Math.min(w, h);
  const minsize = Math.max(o.minSizePx, Math.round(o.minSizeFrac * short));
  if (minsize > short) return [];
  const all: RawFace[] = [];
  for (const angle of o.angles) {
    const img = angle === 0 ? gray : rotateGray(gray, w, h, angle);
    for (const [r, c, s, q] of runPass(classify, img, w, h, o, minsize)) {
      const [cx, cy] = angle === 0 ? [c, r] : rotatePoint(c, r, w, h, angle);
      all.push({ cx, cy, s, q, angle });
    }
  }
  all.sort((a, b) => b.q - a.q);
  const kept: RawFace[] = [];
  for (const f of all) {
    if (kept.some((k) => iou(f, k) > 0.3 || (f.s <= k.s * 1.1 && inside(f, k)))) continue;
    kept.push(f);
  }
  return kept;
}

/**
 * Gesichter in einem Graustufenbild suchen. Ergebnis nach Erkennungswert absteigend, nur Treffer über der
 * Qualitätsschwelle, normiert auf 0..1 und auf das Bild begrenzt.
 */
export function detectFacesGray(classify: ClassifyRegion, gray: ArrayLike<number>, w: number, h: number, opts: FaceDetectOptions = {}): FaceBox[] {
  const o = { ...DEFAULT_FACE_OPTIONS, ...opts };
  const out: FaceBox[] = [];
  for (const f of faceCandidates(classify, gray, w, h, o)) {
    if (!(f.q >= o.minScore)) continue;
    const x0 = Math.max(0, f.cx - f.s / 2);
    const y0 = Math.max(0, f.cy - f.s / 2);
    const x1 = Math.min(w, f.cx + f.s / 2);
    const y1 = Math.min(h, f.cy + f.s / 2);
    if (x1 <= x0 || y1 <= y0) continue;
    out.push({ x: x0 / w, y: y0 / h, w: (x1 - x0) / w, h: (y1 - y0) / h, score: f.q, angle: f.angle });
    if (out.length >= o.maxFaces) break;
  }
  return out;
}

/** Bequem für Tests und den Worker: RGBA-Bild direkt. */
export function detectFacesRGBA(classify: ClassifyRegion, img: { width: number; height: number; data: ArrayLike<number> }, opts: FaceDetectOptions = {}): FaceBox[] {
  return detectFacesGray(classify, rgbaToGray(img.data, img.width, img.height), img.width, img.height, opts);
}
