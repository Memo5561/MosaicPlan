/// <reference lib="webworker" />
/**
 * Vergleichsfoto nachträglich erzeugen (Paket w5-undo-editing): dieselbe Bildbearbeitung wie die Berechnung
 * (applyAdjustments aus core/imageOps), aber ohne Mosaikberechnung – im eigenen Worker, damit die Oberfläche
 * nicht blockiert. Ändert weder Raster noch Fortschritt.
 */
import { applyAdjustments } from '../core/imageOps';
import type { ImageAdjust, Region } from '../core/types';

declare const self: DedicatedWorkerGlobalScope;

export interface ReferenceRequest {
  id: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
  adjust: ImageAdjust;
  regions: Region[];
}
export type ReferenceResponse = { id: number; ok: true; width: number; height: number; data: Uint8ClampedArray } | { id: number; ok: false; message: string };

self.onmessage = (ev: MessageEvent<ReferenceRequest>) => {
  const { id, width, height, data, adjust, regions } = ev.data;
  try {
    const out = applyAdjustments({ width, height, data }, adjust, regions);
    self.postMessage({ id, ok: true, width: out.width, height: out.height, data: out.data } satisfies ReferenceResponse, [out.data.buffer as ArrayBuffer]);
  } catch (e) {
    self.postMessage({ id, ok: false, message: String((e as Error)?.message ?? e) } satisfies ReferenceResponse);
  }
};
