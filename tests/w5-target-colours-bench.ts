/**
 * Messung für die Fotofarben je Stein (kein CI-Test):
 *   npx tsx tests/w5-target-colours-bench.ts [breiteMm=3800] [steinMm=2] [testbild=portrait]
 * Testbild aus public/samples (portrait, landscape, animal, city), Seitenverhältnis 4:5, Fuge 1 mm
 * (3800 mm Breite bei 2-mm-Steinen ≈ 2 Mio. Rasterzellen; 400 mm bei 5 mm = das Porträt-Testprojekt mit Schnitten).
 * Gibt aus:
 *  - Speicherbedarf der Fotofarben (Byte je Zelle) und Größe des gespeicherten Rasters mit/ohne Fotofarben
 *    (das ist, was IndexedDB je Speichern schreibt – ohne den Fortschritt, der getrennt gespeichert wird),
 *  - Zeit für eine strukturierte Kopie mit/ohne Fotofarben (Speichern, Übergabe an einen Worker),
 *  - Zeit für Abweichungskarte, Zusammenfassung, Abweichung je Farbe und die 50 größten Abweichungen,
 *  - Kontrolle: Zusammenfassung = Kennzahlen der Berechnung (exakt).
 */
import { deviationByColor, deviationMap, deviationSummary, topDeviations } from '../src/core/deviation';
import { computeLayout } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { packMosaic, type StoredMosaic } from '../src/core/serialize';
import { DEFAULT_SHAPES } from '../src/core/types';
import { loadPng, prepareFor } from './helpers';

const widthMm = Number(process.argv[2] ?? 3800);
const tile = Number(process.argv[3] ?? 2);
const layout = computeLayout({ widthMm, heightMm: Math.round((widthMm / 0.8) * 10) / 10, tileW: tile, tileH: tile, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
const cells = layout.cols * layout.rows;
const img = prepareFor(loadPng(`public/samples/${process.argv[4] ?? 'portrait'}.png`), layout);
const regions = [{ id: 'face', type: 'face' as const, shape: 'ellipse' as const, x: 0.27, y: 0.25, w: 0.46, h: 0.5 }];

const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
const storedBytes = (s: StoredMosaic): number => {
  let n = 0;
  for (const [k, v] of Object.entries(s)) if (k !== 'progress' && ArrayBuffer.isView(v)) n += v.byteLength;
  return n;
};
function time<T>(label: string, fn: () => T, runs = 3): T {
  let best = Infinity;
  let out!: T;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    out = fn();
    best = Math.min(best, performance.now() - t0);
  }
  console.log(`  ${label}: ${best.toFixed(1)} ms (${((best * 1e6) / cells).toFixed(0)} ns/Zelle)`);
  return out;
}

for (const shapesOn of [true, false]) {
  const shapes = shapesOn ? { ...DEFAULT_SHAPES } : { ...DEFAULT_SHAPES, diagonal: false, line: false, subdivide: false };
  const t0 = performance.now();
  const r = computeMosaic(img, { layout, shapes, paletteMode: 'auto', colorCount: 32, dither: 0.5, deltaE: '2000', regions, seed: 7 });
  const t = r.data.targets!;
  const tBytes = t.kind.byteLength + t.lab1.byteLength + t.lab2.byteLength + t.line.byteLength + t.subLen.byteLength + t.subLab.byteLength;
  console.log(
    `${shapesOn ? 'Formen an ' : 'Formen aus'} | ${cells.toLocaleString('de-DE')} Zellen | Berechnung ${Math.round(performance.now() - t0)} ms | ` +
      `Zweiteiler ${r.diagnostics.splitCells}, k×k ${r.diagnostics.subCells} | Fotofarben ${mb(tBytes)} = ${(tBytes / cells).toFixed(2)} Byte/Zelle`,
  );
  const withT = packMosaic(r.data);
  const without = packMosaic(r.data, { targets: false });
  console.log(`  gespeichertes Raster (ohne Fortschritt): ${mb(storedBytes(without))} ohne, ${mb(storedBytes(withT))} mit Fotofarben`);
  time('strukturierte Kopie ohne Fotofarben', () => structuredClone(without));
  time('strukturierte Kopie mit Fotofarben', () => structuredClone(withT));
  time('deviationMap', () => deviationMap(layout, r.data, r.palette, '2000'));
  const sum = time('deviationSummary', () => deviationSummary(r.data, r.palette, '2000'));
  time('deviationByColor', () => deviationByColor(r.data, r.palette, '2000'));
  const top = time('topDeviations(50)', () => topDeviations(layout, r.data, r.palette, '2000', 50));
  console.log(
    `  Kontrolle: mean ${sum.mean === r.diagnostics.meanDeltaE ? 'exakt' : 'ABWEICHEND'}, max ${sum.max === r.diagnostics.maxDeltaE ? 'exakt' : 'ABWEICHEND'}, ` +
      `p95 ${sum.p95 === r.diagnostics.p95DeltaE ? 'exakt' : 'ABWEICHEND'} | ΔE mean ${sum.mean.toFixed(2)}, max ${sum.max.toFixed(2)} | größte: ${top[0]?.id} ΔE ${top[0]?.deltaE.toFixed(2)}`,
  );
}
