/**
 * Gesichtsvorschläge für das Editorbild (w4-face-detector):
 * 1. FaceDetector des Browsers, falls vorhanden (Shape-Detection-API; in Chromium/WebView meist nicht aktiv);
 * 2. sonst – oder wenn er nichts findet bzw. scheitert – die mitgelieferte Offline-Erkennung (pico.js) in
 *    face.worker.ts. Sie läuft ohne Netz, auch in der Android-App.
 * Ergebnis sind nur Vorschläge; übernommen wird erst nach Bestätigung (RegionEditor).
 */
import type { FaceRequest, FaceResponse } from '../../workers/faceProtocol';
import { nativeSuggestion, picoSuggestion, type DetectSource, type FaceSuggestion } from './faceSuggest';

export type DetectOutcome = { kind: 'ok'; source: DetectSource; suggestions: FaceSuggestion[]; ms: number } | { kind: 'error'; reason: 'load' | 'detect' };

interface NativeFace {
  boundingBox: DOMRectReadOnly;
  landmarks?: { type?: string; locations?: { x: number; y: number }[] }[] | null;
}
type NativeDetector = new (o?: object) => { detect: (s: CanvasImageSource) => Promise<NativeFace[]> };

const nativeCtor = (): NativeDetector | undefined => (globalThis as unknown as { FaceDetector?: NativeDetector }).FaceDetector;

/** Bietet der Browser eine eigene Gesichtserkennung an? (nur Anzeige – die Offline-Erkennung gibt es immer) */
export const hasNativeFaceDetector = () => typeof nativeCtor() === 'function';

async function detectNative(c: HTMLCanvasElement, newId: () => string): Promise<FaceSuggestion[] | null> {
  const FD = nativeCtor();
  if (!FD) return null;
  try {
    const det = new FD({ fastMode: false, maxDetectedFaces: 8 });
    const faces = await det.detect(c);
    const W = c.width;
    const H = c.height;
    const out: FaceSuggestion[] = [];
    for (const f of faces) {
      const b = f.boundingBox;
      const box = { x: Math.max(0, b.x / W), y: Math.max(0, b.y / H), w: Math.min(1, b.width / W), h: Math.min(1, b.height / H) };
      if (!(box.w > 0 && box.h > 0)) continue;
      const eyes = (f.landmarks ?? []).filter((l) => l?.type === 'eye').flatMap((l) => (l.locations ?? []).slice(0, 1).map((p) => ({ x: p.x / W, y: p.y / H })));
      out.push(nativeSuggestion(box, newId(), eyes));
    }
    return out;
  } catch {
    return null;
  }
}

// ---------- Offline-Erkennung im Worker

let worker: Worker | null = null;
let seq = 1;
const pending = new Map<number, (r: FaceResponse) => void>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('../../workers/face.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent<FaceResponse>) => {
    const done = pending.get(ev.data.id);
    if (!done) return;
    pending.delete(ev.data.id);
    done(ev.data);
  };
  w.onerror = (e) => {
    e.preventDefault();
    for (const [id, done] of pending) done({ id, ok: false, error: 'cascade', message: e.message || 'worker' });
    pending.clear();
    worker = null;
    w.terminate();
  };
  worker = w;
  return w;
}

function detectPico(c: HTMLCanvasElement): Promise<FaceResponse> {
  return new Promise((resolve) => {
    let ctx: CanvasRenderingContext2D | null = null;
    let data: Uint8ClampedArray;
    try {
      ctx = c.getContext('2d', { willReadFrequently: true });
      data = ctx!.getImageData(0, 0, c.width, c.height).data;
    } catch (e) {
      resolve({ id: 0, ok: false, error: 'detect', message: String(e) });
      return;
    }
    const id = seq++;
    // Sicherheitsnetz: hängt der Worker (sollte nicht vorkommen), nach 30 s aufgeben und neu starten
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      worker?.terminate();
      worker = null;
      resolve({ id, ok: false, error: 'detect', message: 'timeout' });
    }, 30_000);
    pending.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    try {
      const msg: FaceRequest = { id, width: c.width, height: c.height, data };
      getWorker().postMessage(msg, [data.buffer]);
    } catch (e) {
      pending.delete(id);
      resolve({ id, ok: false, error: 'cascade', message: String(e) });
    }
  });
}

/** Gesichter im Editorbild vorschlagen – zuerst FaceDetector, sonst Offline-Erkennung. */
export async function suggestFaces(c: HTMLCanvasElement, newId: () => string): Promise<DetectOutcome> {
  const t0 = performance.now();
  const native = await detectNative(c, newId);
  if (native && native.length > 0) return { kind: 'ok', source: 'native', suggestions: native, ms: performance.now() - t0 };
  const r = await detectPico(c);
  if (!r.ok) return { kind: 'error', reason: r.error === 'cascade' ? 'load' : 'detect' };
  return { kind: 'ok', source: 'pico', suggestions: r.faces.map((f) => picoSuggestion(f, newId())), ms: r.ms };
}
