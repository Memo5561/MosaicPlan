/// <reference lib="webworker" />
/**
 * Vorschau als Bild (PNG) im eigenen Worker (Paket w6-compare-batch): zeichnet das Mosaik oder einen Abschnitt wie die
 * Vorschau (renderMosaic) und kodiert es als PNG mit der Beschriftung „Vorschau – kein maßstäblicher Plan“.
 * Ändert nichts am Projekt. Die Oberfläche bleibt währenddessen bedienbar.
 */
import { addPngText, renderPreviewRegion, type PngSize, type PreviewRenderOptions, type WorldRect } from '../core/previewPng';
import type { Layout } from '../core/layout';
import type { MosaicData, PaletteColor } from '../core/types';

declare const self: DedicatedWorkerGlobalScope;

export interface PreviewPngRequest {
  id: number;
  layout: Layout;
  data: MosaicData;
  palette: PaletteColor[];
  rect: WorldRect;
  size: PngSize;
  opt: PreviewRenderOptions;
  text: { keyword: string; text: string }[];
}
export type PreviewPngResponse = { id: number; ok: true; png: ArrayBuffer; width: number; height: number } | { id: number; ok: false; message: string };

self.onmessage = async (ev: MessageEvent<PreviewPngRequest>) => {
  const { id, layout, data, palette, rect, size, opt, text } = ev.data;
  try {
    const cv = renderPreviewRegion(layout, data, palette, rect, size, opt);
    const blob = await cv.convertToBlob({ type: 'image/png' });
    const png = addPngText(new Uint8Array(await blob.arrayBuffer()), text);
    const buf = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
    self.postMessage(
      {
        id,
        ok: true,
        png: buf,
        width: cv.width,
        height: cv.height,
      } satisfies PreviewPngResponse,
      [buf],
    );
  } catch (e) {
    self.postMessage({
      id,
      ok: false,
      message: String((e as Error)?.message ?? e),
    } satisfies PreviewPngResponse);
  }
};
