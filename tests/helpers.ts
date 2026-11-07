import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { centerCropToAspect, resizeArea, type RGBAImage } from '../src/core/imageOps';
import type { Layout } from '../src/core/layout';

export function loadPng(path: string): RGBAImage {
  const png = PNG.sync.read(readFileSync(path));
  return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length) };
}

/** Bereitet ein Bild wie die App vor: mittiger Zuschnitt auf das Seitenverhältnis + Skalierung (~6×6 px je Zelle). */
export function prepareFor(img: RGBAImage, layout: Layout): RGBAImage {
  const aspect = layout.finishedW / layout.finishedH;
  const cropped = centerCropToAspect(img, aspect);
  const px = Math.min(6_000_000, Math.max(250_000, layout.cols * layout.rows * 36), cropped.width * cropped.height);
  const w = Math.max(16, Math.round(Math.sqrt(px * aspect)));
  const h = Math.max(16, Math.round(w / aspect));
  return resizeArea(cropped, w, h);
}

export function fontBase64(file: string): string {
  return readFileSync(file).toString('base64');
}
