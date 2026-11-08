/// <reference lib="webworker" />
/**
 * Offline-Gesichtserkennung (pico.js + Kaskade „facefinder“, MIT) im eigenen Worker, damit die Oberfläche
 * nicht blockiert. Die Kaskade (≈ 240 KB) wird beim ersten Auftrag geladen; der Service Worker hat sie
 * vorab zwischengespeichert (vite.config.ts: „bin“ in globPatterns), sie ist also auch offline und in der
 * Android-App da.
 */
import { detectFacesRGBA, loadCascade } from '../core/faceDetect';
import type { ClassifyRegion } from '../vendor/pico/pico.js';
import type { FaceRequest, FaceResponse } from './faceProtocol';

declare const self: DedicatedWorkerGlobalScope;

let cascade: Promise<ClassifyRegion> | null = null;

function getCascade(): Promise<ClassifyRegion> {
  cascade ??= (async () => {
    const res = await fetch(new URL('../vendor/pico/facefinder.bin', import.meta.url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return loadCascade(await res.arrayBuffer());
  })();
  // bei einem Fehler beim nächsten Auftrag neu versuchen
  cascade.catch(() => (cascade = null));
  return cascade;
}

self.onmessage = async (ev: MessageEvent<FaceRequest>) => {
  const { id, width, height, data } = ev.data;
  let classify: ClassifyRegion;
  try {
    classify = await getCascade();
  } catch (e) {
    self.postMessage({ id, ok: false, error: 'cascade', message: String((e as Error)?.message ?? e) } satisfies FaceResponse);
    return;
  }
  try {
    const t0 = performance.now();
    const faces = detectFacesRGBA(classify, { width, height, data });
    self.postMessage({ id, ok: true, faces, ms: performance.now() - t0 } satisfies FaceResponse);
  } catch (e) {
    self.postMessage({ id, ok: false, error: 'detect', message: String((e as Error)?.message ?? e) } satisfies FaceResponse);
  }
};
