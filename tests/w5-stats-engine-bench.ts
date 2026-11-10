/**
 * Laufzeitmessung der Statistik (kein CI-Test):
 *   npx tsx tests/w5-stats-engine-bench.ts [zellen=2000000] [quelle=sample|random]
 *
 * Vergleicht die frühere Zählung (computeStats für das ganze Mosaik + je Abschnitt ein weiterer Durchlauf mit
 * gemeinsamem Cache – so lief der Statistik-Auftrag im Worker) mit computeAllStats (ein Durchlauf für Gesamt und
 * alle Abschnitte) und computeStats allein (nur Gesamt, wie die App sie heute anfragt). Prüft dabei, dass alle
 * Ergebnisse JSON-gleich sind.
 *  - sample: Porträt-Testbild mit computeMosaic (6-mm-Steine, Fuge 1 mm, Standardformen), realistische Schnittanteile
 *  - random: Zufallsmosaik (randomCase, 40 % Schnittzellen: Dreiecke, Kantenschnitte wie aus der Berechnung,
 *    Teilsteine 2×2/3×3; ohne Freiform und ohne manuelle Kantenschnitte, die je Zelle einzeln analysiert werden)
 */
import { computeLayout, sectionsFor } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { computeAllStats, computeStats } from '../src/core/stats';
import { CellKind, DEFAULT_SETTINGS, DEFAULT_SHAPES, type Material, type MosaicData, type PaletteColor } from '../src/core/types';
import type { Layout } from '../src/core/layout';
import { loadPng, prepareFor } from './helpers';
import { randomCase, refComputeStats, RefCutCache, withoutNewCounters } from './w5-stats-engine.reference';

const cells = Number(process.argv[2] ?? 2_000_000);
const source = process.argv[3] ?? 'sample';
const opts = { reservePct: 10, groutDepthMm: 3 };

let layout: Layout;
let data: MosaicData;
let palette: PaletteColor[];
let materials: Material[] = [];
if (source === 'random') {
  const side = Math.round(Math.sqrt(cells));
  ({ layout, data, palette, materials } = randomCase(42, { cols: side, rows: side, tileW: 6, tileH: 6, joint: 1, edgeMode: 'cut-end', cutShare: 0.4, generatorLinesOnly: true }));
} else {
  const tile = 6;
  const cols = Math.round(Math.sqrt(cells * 0.8));
  const widthMm = cols * (tile + 1) + 3;
  layout = computeLayout({ widthMm, heightMm: Math.round((widthMm / 0.8) * 10) / 10, tileW: tile, tileH: tile, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
  const img = prepareFor(loadPng('public/samples/portrait.png'), layout);
  const regions = [{ id: 'face', type: 'face' as const, shape: 'ellipse' as const, x: 0.27, y: 0.25, w: 0.46, h: 0.5 }];
  const t0 = performance.now();
  const res = computeMosaic(img, { layout, shapes: { ...DEFAULT_SHAPES }, paletteMode: 'auto', colorCount: 32, dither: 0, deltaE: '2000', regions, seed: 7 });
  console.log(`computeMosaic: ${Math.round(performance.now() - t0)} ms`);
  data = res.data;
  palette = res.palette;
  // etwas Fortschritt, damit „verlegt“ mitgezählt wird
  for (let i = 0; i < data.progress.length; i += 7) data.progress[i] = 1;
}
const grid = sectionsFor(layout, DEFAULT_SETTINGS);
const kinds = [0, 0, 0, 0, 0, 0];
for (let i = 0; i < data.kind.length; i++) kinds[data.kind[i]]++;
const names = Object.keys(CellKind);
console.log(
  `${layout.cols}×${layout.rows} = ${layout.cols * layout.rows} Zellen, ${grid.sections.length} Abschnitte, Arten: ${kinds.map((n, i) => `${names[i]} ${n}`).join(', ')}`,
);

const time = <T,>(f: () => T): [T, number] => {
  const t0 = performance.now();
  const v = f();
  return [v, performance.now() - t0];
};

// früher: Gesamt + je Abschnitt ein Durchlauf (gemeinsamer Cache wie im Worker)
const rc = new RefCutCache();
const [refTotal, tRefTotal] = time(() => refComputeStats(layout, data, palette, materials, opts, undefined, rc));
const [refSec, tRefSec] = time(() => grid.sections.map((s) => refComputeStats(layout, data, palette, materials, opts, s, rc)));
// neu
const [all, tAll] = time(() => computeAllStats(layout, data, palette, materials, opts, grid));
const [tot, tTot] = time(() => computeStats(layout, data, palette, materials, opts));
const [allMin, tAllMin] = time(() => computeAllStats(layout, data, palette, materials, { ...opts, minPieceMm: DEFAULT_SHAPES.minPieceMm }, grid));

let mismatches = 0;
if (JSON.stringify(withoutNewCounters(all.total)) !== JSON.stringify(refTotal)) mismatches++;
if (JSON.stringify(withoutNewCounters(tot)) !== JSON.stringify(refTotal)) mismatches++;
if (JSON.stringify(withoutNewCounters(allMin.total)) !== JSON.stringify(refTotal)) mismatches++;
refSec.forEach((r, i) => {
  if (JSON.stringify(withoutNewCounters(all.perSection[i])) !== JSON.stringify(r)) mismatches++;
});
const old = tRefTotal + tRefSec;
console.log(`früher: Gesamt ${Math.round(tRefTotal)} ms + Abschnitte ${Math.round(tRefSec)} ms = ${Math.round(old)} ms`);
console.log(`computeAllStats (Gesamt + ${grid.sections.length} Abschnitte, ein Durchlauf): ${Math.round(tAll)} ms → ${(old / tAll).toFixed(1)}× schneller (${((tAll / old) * 100).toFixed(1)} % der früheren Zeit)`);
console.log(`computeAllStats mit Mindestbreiten-Prüfung: ${Math.round(tAllMin)} ms (dünne Teile ${allMin.total.thinPieces}, Freiform ${allMin.total.thinFreePieces})`);
console.log(`computeStats nur Gesamt: ${Math.round(tTot)} ms (früher ${Math.round(tRefTotal)} ms → ${(tRefTotal / tTot).toFixed(1)}×)`);
console.log(`Steine ${refTotal.pieces}, Abweichungen: ${mismatches}`);
if (mismatches) process.exitCode = 1;
