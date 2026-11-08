/**
 * Laufzeitmessung der Bildanalyse (kein CI-Test):
 *   npx tsx tests/w1-mosaic-core-bench.ts [breiteMm=3000] [steinMm=2]
 * Porträt-Testbild, Fuge 1 mm, mit und ohne Formsuche. Vor w1-mosaic-core brauchte die Analyse bei
 * 1,25 Mio. Zellen ≈ 8,5 s (≈ 6,9 µs je Zelle), danach ≈ 1,8 s (≈ 1,4 µs je Zelle) auf demselben Rechner.
 * Steigt der Wert je Zelle wieder deutlich (z. B. > 4 µs), ist die heiße Schleife in computeMosaic
 * vermutlich wieder polymorph geworden (Objekte/Closures je Zelle). Ergebnis-Hashes: tests/w1-mosaic-core.test.ts.
 */
import { computeLayout } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { DEFAULT_SHAPES } from '../src/core/types';
import { loadPng, prepareFor } from './helpers';

const widthMm = Number(process.argv[2] ?? 3000);
const tile = Number(process.argv[3] ?? 2);
const layout = computeLayout({ widthMm, heightMm: Math.round((widthMm / 0.8) * 10) / 10, tileW: tile, tileH: tile, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
const cells = layout.cols * layout.rows;
const img = prepareFor(loadPng('public/samples/portrait.png'), layout);
const regions = [{ id: 'face', type: 'face' as const, shape: 'ellipse' as const, x: 0.27, y: 0.25, w: 0.46, h: 0.5 }];

for (const shapesOn of [true, false]) {
  const shapes = shapesOn ? { ...DEFAULT_SHAPES } : { ...DEFAULT_SHAPES, diagonal: false, line: false, subdivide: false };
  const ends = new Map<string, number>();
  const t0 = performance.now();
  const r = computeMosaic(img, { layout, shapes, paletteMode: 'auto', colorCount: 32, dither: 0, deltaE: '2000', regions, seed: 7 }, (phase, f) => {
    if (f === 1) ends.set(phase, performance.now());
  });
  const total = performance.now() - t0;
  const analyze = (ends.get('analyze') ?? 0) - (ends.get('lab') ?? 0);
  console.log(
    `${shapesOn ? 'Formen an ' : 'Formen aus'} | ${cells.toLocaleString('de-DE')} Zellen | Bild ${img.width}×${img.height} | ` +
      `Analyse ${Math.round(analyze)} ms (${((analyze * 1000) / cells).toFixed(2)} µs/Zelle) | gesamt ${Math.round(total)} ms | Schnittzellen ${r.diagnostics.splitCells}`,
  );
}
