/**
 * w4-cut-placement-accents:
 *  1. Schnitte außerhalb markierter Bereiche (ShapeOptions.bgCutFactor) – weniger Schnitte im Hintergrund, im Gesicht
 *     unverändert; ohne Bereiche bitgleich; exakte Zählung „davon in markierten Bereichen“.
 *  2. Fehlende Akzentfarben (diagnostics.missingAccents) und Pflichtfarben (ComputeParams.pinnedColors).
 *  3. Konturen durchgehend schneiden (ShapeOptions.contourContinuity).
 *  4. Berechnungsschlüssel / „Änderungen verwerfen“ für die neuen Einstellungen, Hilfsfunktionen der Oberfläche.
 * Alle Mengen- und Geometrie-Invarianten werden mitgeprüft.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deltaE2000, hexToLab, type Lab } from '../src/core/color';
import { minCaliperWidth } from '../src/core/geometry';
import { regionMask, type RGBAImage } from '../src/core/imageOps';
import { checkMosaicIntegrity } from '../src/core/integrity';
import { kmeansLab, kmeansLabFixed } from '../src/core/kmeans';
import { computeLayout, parseCellId, type Layout } from '../src/core/layout';
import { ACCENT_MIN_DE, computeMosaic, contourAlignment, imageToLab, normalizePinned, type ComputeResult, type FixedColor } from '../src/core/mosaic';
import { collectTemplates } from '../src/core/pdf';
import { cellPieces, cellRect } from '../src/core/pieces';
import { computeStats } from '../src/core/stats';
import { bgCutFactorOf, CellKind, createEmptyMosaic, DEFAULT_SHAPES, withShapeOption, type MosaicData, type ShapeOptions } from '../src/core/types';
import { addPinned, isPinned, normalizeHexInput, pinnedResultFor, removePinned, renamePinned } from '../src/ui/project/pinnedColors';
import { restoreComputedSettings, staleReasons } from '../src/ui/project/staleReasons';
import { computeKey } from '../src/ui/project/useProject';
import type { ProjectRecord } from '../src/storage/db';
import { DEFAULT_ADJUST, DEFAULT_SETTINGS } from '../src/core/types';
import { baseParams, materialFixed, MATERIALS12, mosaicHashes, sampleSetup, type SampleSetup } from './w1-mosaic-core.fixtures';

const GOLDEN = JSON.parse(readFileSync('tests/golden/mosaic-hashes.json', 'utf8')) as { samples: Record<string, unknown>; modes: Record<string, unknown> };
const shapes = (patch: Partial<ShapeOptions>): ShapeOptions => ({ ...DEFAULT_SHAPES, ...patch });
const SPLIT = new Set<number>([CellKind.DIAG_A, CellKind.DIAG_B, CellKind.LINE]);

/** Zellen, deren Mitte in einem Gesichts-/Detailbereich liegt – unabhängig nachgerechnet (dieselbe Regel wie computeMosaic). */
function regionCellsOf(su: SampleSetup): Uint8Array {
  const { layout, img } = su;
  const W = img.width;
  const H = img.height;
  const mask = regionMask(W, H, su.regions, ['face', 'detail']);
  const sx = W / layout.finishedW;
  const sy = H / layout.finishedH;
  const out = new Uint8Array(layout.cols * layout.rows);
  for (let r = 0; r < layout.rows; r++)
    for (let c = 0; c < layout.cols; c++) {
      const cx = Math.min(W - 1, Math.max(0, Math.floor((layout.colX[c] + layout.colW[c] / 2) * sx)));
      const cy = Math.min(H - 1, Math.max(0, Math.floor((layout.rowY[r] + layout.rowH[r] / 2) * sy)));
      out[r * layout.cols + c] = mask[cy * W + cx] > 0 ? 1 : 0;
    }
  return out;
}

function cutCounts(d: MosaicData, inside: Uint8Array) {
  let cutIn = 0;
  let cutOut = 0;
  let subOut = 0;
  let splitIn = 0;
  let subIn = 0;
  for (let i = 0; i < d.kind.length; i++) {
    const k = d.kind[i];
    const cut = SPLIT.has(k) || k === CellKind.SUB;
    if (!cut) continue;
    if (inside[i]) {
      cutIn++;
      if (k === CellKind.SUB) subIn++;
      else splitIn++;
    } else {
      cutOut++;
      if (k === CellKind.SUB) subOut++;
    }
  }
  return { cutIn, cutOut, subOut, splitIn, subIn };
}

/** Geometrie- und Mengen-Invarianten jedes Ergebnisses */
function expectInvariants(su: SampleSetup, res: ComputeResult) {
  const L = su.layout;
  const min = DEFAULT_SHAPES.minPieceMm;
  let narrow = 0;
  let pieces = 0;
  for (let r = 0; r < L.rows; r++)
    for (let c = 0; c < L.cols; c++) {
      const ps = cellPieces(L, res.data, r, c);
      pieces += ps.length;
      if (ps.length < 2) continue;
      for (const p of ps) if (minCaliperWidth(p.poly) < min - 1e-6) narrow++;
    }
  expect(narrow).toBe(0);
  // Kantenschnitte nur im 15°-Raster und 0,5-mm-Versatz
  for (const [, l] of res.data.line) {
    const deg = (Math.atan2(l[1], l[0]) * 180) / Math.PI;
    expect(Math.abs(deg / 15 - Math.round(deg / 15))).toBeLessThan(1e-4);
    expect(Math.abs(l[2] * 2 - Math.round(l[2] * 2))).toBeLessThan(1e-6);
  }
  const st = computeStats(L, res.data, res.palette, [], { reservePct: 10, groutDepthMm: 3 });
  expect(st.pieces).toBe(pieces);
  expect(st.perColor.reduce((s, cs) => s + cs.pieces, 0) + st.invalidColorPieces).toBe(st.pieces);
  expect(st.invalidColorPieces).toBe(0);
  expect(st.stoneArea + st.jointArea).toBeCloseTo(st.finishedArea, 6);
  // Palette: keine unbenutzten Farben (Automatik), eindeutige Nummern, Steine je Farbe = Messung der Berechnung
  expect(new Set(res.palette.map((p) => p.code)).size).toBe(res.palette.length);
  res.palette.forEach((p, i) => expect(p.matchDeltaE?.pieces).toBe(st.perColor[i].pieces));
  expect(checkMosaicIntegrity({ palette: res.palette }, res.data)).toEqual({ ok: true, reason: null });
  // Zählung „davon in markierten Bereichen“ exakt aus data.kind
  const d = res.diagnostics;
  let split = 0;
  let sub = 0;
  for (let i = 0; i < res.data.kind.length; i++) {
    if (SPLIT.has(res.data.kind[i])) split++;
    else if (res.data.kind[i] === CellKind.SUB) sub++;
  }
  expect(d.splitCells).toBe(split);
  expect(d.subCells).toBe(sub);
  if (su.regions.length) {
    const c = cutCounts(res.data, regionCellsOf(su));
    expect(d.splitCellsInRegions).toBe(c.splitIn);
    expect(d.subCellsInRegions).toBe(c.subIn);
    expect(d.regionCells).toBe(regionCellsOf(su).reduce((s, v) => s + v, 0));
  } else {
    expect(d.splitCellsInRegions).toBeUndefined();
    expect(d.regionCells).toBeUndefined();
  }
}

/**
 * Bildfarbe eines Steins, unabhängig von computeMosaic nachgerechnet: dieselben S×S Stichproben (bilinear in L*a*b*),
 * aufgeteilt nach der tatsächlichen Teilung der Zelle (nur für ganze Steine, Teilsteine k×k und Kantenschnitte).
 */
function stoneLab(img: RGBAImage, lab: Float32Array, layout: Layout, data: MosaicData, row: number, col: number, piece: number, S = 6): Lab {
  const W = img.width;
  const H = img.height;
  const sx = W / layout.finishedW;
  const sy = H / layout.finishedH;
  const x0 = layout.colX[col];
  const y0 = layout.rowY[row];
  const cw = layout.colW[col];
  const ch = layout.rowH[row];
  const idx = row * layout.cols + col;
  const kind = data.kind[idx];
  let n = 0;
  const acc = [0, 0, 0];
  for (let j = 0; j < S; j++)
    for (let i = 0; i < S; i++) {
      const mx = (i + 0.5) / S;
      const my = (j + 0.5) / S;
      let pc = 0;
      if (kind === CellKind.SUB) {
        const k = Math.round(Math.sqrt(data.sub.get(idx)!.length));
        const per = S / k;
        pc = Math.floor(j / per) * k + Math.floor(i / per);
      } else if (kind === CellKind.LINE) {
        const l = data.line.get(idx)!;
        pc = l[0] * (mx - 0.5) * cw + l[1] * (my - 0.5) * ch < l[2] ? 0 : 1;
      } else if (kind !== CellKind.FULL) throw new Error('nicht unterstützt');
      if (pc !== piece) continue;
      const py = (y0 + my * ch) * sy - 0.5;
      const iy = Math.max(0, Math.min(H - 1, Math.floor(py)));
      const iy1 = Math.min(H - 1, iy + 1);
      const fy = Math.max(0, Math.min(1, py - iy));
      const px = (x0 + mx * cw) * sx - 0.5;
      const ix = Math.max(0, Math.min(W - 1, Math.floor(px)));
      const ix1 = Math.min(W - 1, ix + 1);
      const fx = Math.max(0, Math.min(1, px - ix));
      const w = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      const at = [(iy * W + ix) * 3, (iy * W + ix1) * 3, (iy1 * W + ix) * 3, (iy1 * W + ix1) * 3];
      for (let q = 0; q < 3; q++) acc[q] += at.reduce((s, a, z) => s + lab[a + q] * w[z], 0);
      n++;
    }
  return [acc[0] / n, acc[1] / n, acc[2] / n];
}

// ================================================================ 1. Schnitte außerhalb markierter Bereiche

describe('Schnitte auf markierte Bereiche konzentrieren (bgCutFactor)', () => {
  const su = sampleSetup('portrait');
  const inside = regionCellsOf(su);
  const base = computeMosaic(su.img, baseParams(su));
  const b = cutCounts(base.data, inside);

  it('Porträt mit Gesichtsbereich, Faktor 3: außerhalb ≥ 30 % weniger Schnittzellen, im Gesicht ≤ 25 % weniger', () => {
    const res = computeMosaic(su.img, baseParams(su, { shapes: shapes({ bgCutFactor: 3 }) }));
    const c = cutCounts(res.data, inside);
    expect(b.cutOut).toBeGreaterThan(50);
    expect(c.cutOut).toBeLessThanOrEqual(b.cutOut * 0.7);
    expect(c.cutIn).toBeGreaterThanOrEqual(b.cutIn * 0.75);
    // In den Bereichen entscheidet die Formwahl genau wie ohne Faktor (die Palette ist dabei egal)
    for (let i = 0; i < inside.length; i++) if (inside[i]) expect(res.data.kind[i]).toBe(base.data.kind[i]);
    expect(res.diagnostics.bgCutFactor).toBe(3);
    expectInvariants(su, res);
  });

  it('Faktor > 1: keine feineren Steine außerhalb der Bereiche; Faktor steigt → Schnitte außerhalb sinken', () => {
    let prev = Infinity;
    for (const f of [1, 2, 3, 6]) {
      const res = computeMosaic(su.img, baseParams(su, { shapes: shapes({ bgCutFactor: f }) }));
      const c = cutCounts(res.data, inside);
      if (f > 1) expect(c.subOut).toBe(0);
      expect(c.cutOut).toBeLessThanOrEqual(prev);
      prev = c.cutOut;
    }
    expect(b.subOut).toBeGreaterThan(0);
  });

  it('Ohne Bereiche: Ergebnis für jeden Faktor bitgleich (= Golden-Hash)', () => {
    for (const key of ['landscape', 'animal']) {
      const s2 = sampleSetup(key);
      for (const f of [1, 3, 6]) {
        const res = computeMosaic(s2.img, baseParams(s2, { shapes: shapes({ bgCutFactor: f }) }));
        expect(mosaicHashes(res.data, res.palette)).toEqual(GOLDEN.samples[key]);
        expect(res.diagnostics.bgCutFactor).toBeUndefined();
      }
    }
  });

  it('Faktor fehlt/1/ungültig = Standard (bitgleich zum Golden-Hash des Porträts)', () => {
    for (const f of [undefined, 1, 0.5, Number.NaN]) {
      const res = computeMosaic(su.img, baseParams(su, { shapes: shapes({ bgCutFactor: f }) }));
      expect(mosaicHashes(res.data, res.palette)).toEqual(GOLDEN.samples.portrait);
    }
    expect(bgCutFactorOf({})).toBe(1);
    expect(bgCutFactorOf({ bgCutFactor: 99 })).toBe(6);
    expect(bgCutFactorOf({ bgCutFactor: -2 })).toBe(1);
  });

  it('Diagnose zählt Schnittzellen in Bereichen exakt aus data.kind (Standardberechnung)', () => {
    expectInvariants(su, base);
    expect(base.diagnostics.splitCellsInRegions! + base.diagnostics.subCellsInRegions!).toBe(b.cutIn);
  });
});

// ================================================================ 2. Akzentfarben und Pflichtfarben

describe('Fehlende Akzentfarben und Pflichtfarben', () => {
  const su = sampleSetup('portrait');
  const lab = imageToLab(su.img);
  const a = computeMosaic(su.img, baseParams(su));
  const acc = a.diagnostics.missingAccents!;

  it('Porträt (32 Farben): ein Vorschlag mit L* < 15 und mindestens 2 Steinen; alle Angaben gemessen', () => {
    expect(acc.length).toBeGreaterThan(0);
    expect(acc.length).toBeLessThanOrEqual(3);
    const dark = acc.find((x) => x.lab[0] < 15);
    expect(dark).toBeDefined();
    expect(dark!.stones).toBeGreaterThanOrEqual(2);
    for (const x of acc) {
      expect(x.stones).toBeGreaterThanOrEqual(2);
      expect(x.meanDE).toBeGreaterThan(ACCENT_MIN_DE);
      expect(x.nearestDE).toBeGreaterThan(ACCENT_MIN_DE / 2);
      expect(x.cellIds.length).toBe(Math.min(x.stones, 40));
      expect(x.inFace).toBeLessThanOrEqual(x.stones);
    }
    // Vorschlag = Mittel der Bildfarben genau dieser Steine; jeder Stein weicht von seiner Farbe um > 10 ab
    const pal = a.palette;
    let sum: Lab = [0, 0, 0];
    for (const id of dark!.cellIds) {
      const p = parseCellId(su.layout, id)!;
      const s = stoneLab(su.img, lab, su.layout, a.data, p.row, p.col, p.piece);
      const ci = cellPieces(su.layout, a.data, p.row, p.col)[p.piece].color;
      expect(deltaE2000(s[0], s[1], s[2], pal[ci].lab[0], pal[ci].lab[1], pal[ci].lab[2])).toBeGreaterThan(ACCENT_MIN_DE - 0.6);
      sum = [sum[0] + s[0], sum[1] + s[1], sum[2] + s[2]];
    }
    const k = dark!.cellIds.length;
    expect(Math.abs(sum[0] / k - dark!.lab[0])).toBeLessThan(0.6);
    expect(Math.abs(sum[1] / k - dark!.lab[1])).toBeLessThan(1);
    expect(Math.abs(sum[2] / k - dark!.lab[2])).toBeLessThan(1);
  });

  it('Pflichtfarbe übernommen: Pupillen-Steine ΔE00 ≤ 3, Ø ΔE steigt höchstens um 0,05, HEX unverändert in der Palette', () => {
    const dark = acc.find((x) => x.lab[0] < 15)!;
    const pin: FixedColor = { hex: dark.hex, lab: hexToLab(dark.hex), name: 'Pupillen' };
    const r = computeMosaic(su.img, baseParams(su, { pinnedColors: [pin] }));
    const pi = r.palette.findIndex((p) => p.hex === dark.hex);
    expect(pi).toBeGreaterThanOrEqual(0);
    expect(r.palette.length).toBe(a.palette.length);
    for (const id of dark.cellIds) {
      const p = parseCellId(su.layout, id)!;
      const s = stoneLab(su.img, lab, su.layout, r.data, p.row, p.col, p.piece);
      const piece = cellPieces(su.layout, r.data, p.row, p.col)[p.piece];
      expect(piece.color).toBe(pi);
      const pl = r.palette[pi].lab;
      expect(deltaE2000(s[0], s[1], s[2], pl[0], pl[1], pl[2])).toBeLessThanOrEqual(3);
    }
    expect(r.diagnostics.meanDeltaE - a.diagnostics.meanDeltaE).toBeLessThanOrEqual(0.05);
    // Diagnose: Steine der Pflichtfarbe exakt
    const st = computeStats(su.layout, r.data, r.palette, [], { reservePct: 0, groutDepthMm: 3 });
    expect(r.diagnostics.pinnedColors).toEqual([{ hex: dark.hex, stones: st.perColor[pi].pieces, snapDE: 0, paletteHex: dark.hex }]);
    // Die Gruppe fehlt danach nicht mehr
    expect((r.diagnostics.missingAccents ?? []).some((x) => x.hex === dark.hex)).toBe(false);
    // Analyse (Formwahl) unabhängig von der Palette: dieselben Zellarten und Schnitte
    expect(Array.from(r.data.kind)).toEqual(Array.from(a.data.kind));
    expectInvariants(su, r);
  });

  it('Pflichtfarbe ohne Steine fällt weg und wird als „nicht benötigt“ gemeldet; Doppelte zählen einmal', () => {
    const odd: FixedColor = { hex: '#00FF00', lab: hexToLab('#00FF00'), name: '' };
    const r = computeMosaic(su.img, baseParams(su, { pinnedColors: [odd, { ...odd, hex: '#00ff00' }] }));
    expect(r.palette.some((p) => p.hex === '#00FF00')).toBe(false);
    expect(r.diagnostics.pinnedColors).toEqual([{ hex: '#00FF00', stones: 0, snapDE: 0 }]);
    expectInvariants(su, r);
  });

  it('Mindestens so viele Pflichtfarben wie Farben: Palette nur aus (benutzten) Pflichtfarben', () => {
    const pins = ['#F1EAE3', '#301C12', '#C08A6A', '#2D4D3A'].map((hex) => ({ hex, lab: hexToLab(hex), name: '' }));
    const r = computeMosaic(su.img, baseParams(su, { colorCount: 4, pinnedColors: pins }));
    expect(r.palette.every((p) => pins.some((q) => q.hex === p.hex))).toBe(true);
    expect(r.diagnostics.pinnedColors!.reduce((s, p) => s + p.stones, 0)).toBe(computeStats(su.layout, r.data, r.palette, [], { reservePct: 0, groutDepthMm: 3 }).pieces);
    expectInvariants(su, r);
  });

  it('„Meine Steine – begrenzte Farbanzahl“: Pflichtfarbe → nächstes Material fest gewählt', () => {
    const fixed = materialFixed(MATERIALS12);
    const r0 = computeMosaic(su.img, baseParams(su, { paletteMode: 'auto-snap', colorCount: 8, fixedPalette: fixed }));
    const r = computeMosaic(su.img, baseParams(su, { paletteMode: 'auto-snap', colorCount: 8, fixedPalette: fixed, pinnedColors: [{ hex: '#000000', lab: hexToLab('#000000'), name: '' }] }));
    const black = fixed.reduce((best, f) => (deltaE2000(0, 0, 0, f.lab[0], f.lab[1], f.lab[2]) < deltaE2000(0, 0, 0, best.lab[0], best.lab[1], best.lab[2]) ? f : best));
    expect(r0.palette.some((p) => p.hex === black.hex)).toBe(false);
    expect(r.palette.some((p) => p.hex === black.hex && p.materialId === black.materialId)).toBe(true);
    expect(r.palette.length).toBeLessThanOrEqual(8);
    const pr = r.diagnostics.pinnedColors![0];
    expect(pr.materialId).toBe(black.materialId);
    expect(pr.paletteHex).toBe(black.hex);
    expect(pr.stones).toBeGreaterThan(0);
    // Akzent-Vorschläge im Materialmodus nennen das Material, auf das sie fielen (nie eines, das schon gewählt ist)
    for (const x of r0.diagnostics.missingAccents ?? []) {
      expect(x.snapHex).toBeDefined();
      expect(r0.palette.some((p) => p.hex === x.snapHex)).toBe(false);
      expect(x.snapDE!).toBeLessThanOrEqual(ACCENT_MIN_DE);
    }
    expectInvariants(su, r);
  });

  it('Ohne Pflichtfarben bleibt alles bitgleich (auch auto-snap) – „Nur eigene Materialien“ liefert keine Akzentliste', () => {
    const r = computeMosaic(su.img, baseParams(su, { pinnedColors: [] }));
    expect(mosaicHashes(r.data, r.palette)).toEqual(GOLDEN.samples.portrait);
    const m = computeMosaic(su.img, baseParams(su, { paletteMode: 'materials', fixedPalette: materialFixed(MATERIALS12), pinnedColors: [{ hex: '#000000', lab: [0, 0, 0], name: '' }] }));
    expect(mosaicHashes(m.data, m.palette)).toEqual(GOLDEN.modes['portrait/materials']);
    expect(m.diagnostics.missingAccents).toBeUndefined();
    expect(m.diagnostics.pinnedColors).toBeUndefined();
  });

  it('normalizePinned: gültige HEX-Werte, Großbuchstaben, ohne Doppelte, L*a*b* aus dem HEX', () => {
    const r = normalizePinned([
      { hex: '#abc', lab: [0, 0, 0] },
      { hex: 'AABBCC', lab: [0, 0, 0] },
      { hex: 'kaputt', lab: [50, 0, 0] },
      { hex: '', lab: [Number.NaN, 0, 0] },
    ]);
    expect(r.map((p) => p.hex)).toEqual(['#AABBCC', '#777777']);
    expect(r[0].lab).toEqual(hexToLab('#AABBCC'));
  });

  it('kmeansLabFixed: feste Zentren bleiben, freie Zentren = Startlösung ohne die günstigsten', () => {
    const pts = new Float32Array([0, 0, 0, 1, 0, 0, 50, 0, 0, 51, 0, 0, 90, 0, 0, 91, 0, 0, 20, 30, 0]);
    const w = new Float32Array([1, 1, 1, 1, 1, 1, 0.1]);
    const start = kmeansLab(pts, w, 4, 30, 1).centers;
    expect(start.length).toBe(4);
    // Die Pflichtfarbe liegt genau auf dem Ausreißer: dessen freies Zentrum ist das günstigste und entfällt
    const r = kmeansLabFixed(pts, w, start, [[20, 30, 0]], 1);
    expect(r.centers.map((c) => Math.round(c[0] * 10) / 10).sort((x, y) => x - y)).toEqual([0.5, 50.5, 90.5]);
    expect(r.fixedWeights![0]).toBeCloseTo(0.1, 5);
    expect(r.weights.reduce((s, v) => s + v, 0) + r.fixedWeights![0]).toBeCloseTo(6.1, 5);
    // Ohne Entfernen: Die Pflichtfarbe wird nie verschoben, auch wenn ihr Cluster wandert
    const r2 = kmeansLabFixed(pts, w, start.slice(0, 3), [[2, 0, 0]], 0);
    expect(r2.centers.length).toBe(3);
    expect(r2.fixedWeights!.length).toBe(1);
    const all = kmeansLabFixed(pts, w, start, [[0, 0, 0], [50, 0, 0], [90, 0, 0]], start.length);
    expect(all.centers).toEqual([]);
  });
});

// ================================================================ 3. Konturen durchgehend schneiden

describe('Konturen durchgehend schneiden (contourContinuity)', () => {
  const su = sampleSetup('portrait');
  const off = computeMosaic(su.img, baseParams(su));
  const on = computeMosaic(su.img, baseParams(su, { shapes: shapes({ contourContinuity: true }) }));

  it('Aus = Golden-Hash (fehlt und false)', () => {
    expect(mosaicHashes(off.data, off.palette)).toEqual(GOLDEN.samples.portrait);
    const f = computeMosaic(su.img, baseParams(su, { shapes: shapes({ contourContinuity: false }) }));
    expect(mosaicHashes(f.data, f.palette)).toEqual(GOLDEN.samples.portrait);
    // ohne Kantenschnitte wirkungslos
    const nl = computeMosaic(su.img, baseParams(su, { shapes: shapes({ line: false, contourContinuity: true }) }));
    const nl0 = computeMosaic(su.img, baseParams(su, { shapes: shapes({ line: false }) }));
    expect(mosaicHashes(nl.data, nl.palette)).toEqual(mosaicHashes(nl0.data, nl0.palette));
  });

  it('Porträt 5×5 mm: ≥ 65 % der gegenüberliegenden Schnittpaare treffen sich (±1 mm), Vorlagen +≤ 10 %, Ø ΔE +≤ 0,1', () => {
    const p = on.diagnostics.contourPairs!;
    expect(p).toEqual(contourAlignment(su.layout, on.data));
    expect(p.aligned / p.facing).toBeGreaterThanOrEqual(0.65);
    const p0 = off.diagnostics.contourPairs!;
    expect(p.aligned / p.facing).toBeGreaterThan(p0.aligned / p0.facing + 0.1);
    const t0 = collectTemplates(su.layout, off.data, off.palette, []).groups.length;
    const t1 = collectTemplates(su.layout, on.data, on.palette, []).groups.length;
    expect(t1).toBeLessThanOrEqual(t0 * 1.1);
    expect(on.diagnostics.meanDeltaE - off.diagnostics.meanDeltaE).toBeLessThanOrEqual(0.1);
    expect(on.diagnostics.contourContinuity).toBe(true);
    expectInvariants(su, on);
  });

  it('Mit fester Palette (ohne K-Means-Streuung): Bildtreue praktisch unverändert', () => {
    const fixed = off.palette.map((c) => ({ lab: c.lab, hex: c.hex, name: c.name, code: c.code }));
    const a = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: fixed }));
    const b = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: fixed, shapes: shapes({ contourContinuity: true }) }));
    expect(Math.abs(b.diagnostics.meanDeltaE - a.diagnostics.meanDeltaE)).toBeLessThanOrEqual(0.02);
  });

  it('Andere Beispiele: Anteil steigt, Vorlagen +≤ 10 %, Invarianten', () => {
    for (const key of ['landscape', 'animal']) {
      const s2 = sampleSetup(key);
      const a = computeMosaic(s2.img, baseParams(s2));
      const b = computeMosaic(s2.img, baseParams(s2, { shapes: shapes({ contourContinuity: true }) }));
      const pa = a.diagnostics.contourPairs!;
      const pb = b.diagnostics.contourPairs!;
      expect(pb.aligned / pb.facing).toBeGreaterThan(pa.aligned / pa.facing);
      expect(collectTemplates(s2.layout, b.data, b.palette, []).groups.length).toBeLessThanOrEqual(collectTemplates(s2.layout, a.data, a.palette, []).groups.length * 1.1);
      expectInvariants(s2, b);
    }
  });

  it('contourAlignment: zwei Kantenschnitte über eine Fuge – fluchtend bzw. versetzt', () => {
    const layout = computeLayout({ widthMm: 21, heightMm: 10, tileW: 10, tileH: 10, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    expect(layout.cols).toBe(2);
    const d = createEmptyMosaic(layout.cols, layout.rows);
    d.kind[0] = CellKind.LINE;
    d.kind[1] = CellKind.LINE;
    // waagerechte Linie (Normale nach unten) 1 mm unter der Zellmitte in beiden Zellen → fluchtend
    d.line.set(0, new Float32Array([0, 1, 1]));
    d.line.set(1, new Float32Array([0, 1, 1]));
    expect(contourAlignment(layout, d)).toEqual({ facing: 1, aligned: 1 });
    d.line.set(1, new Float32Array([0, 1, -1.5]));
    expect(contourAlignment(layout, d)).toEqual({ facing: 1, aligned: 0 });
    // senkrechte Linie zeigt nicht zur gemeinsamen Kante → kein Paar
    d.line.set(1, new Float32Array([1, 0, 0]));
    expect(contourAlignment(layout, d)).toEqual({ facing: 0, aligned: 0 });
    expect(cellRect(layout, 0, 1).x).toBe(11);
  });
});

// ================================================================ 4. Schlüssel, Verwerfen, Hilfsfunktionen

function rec(over: Partial<ProjectRecord['settings']> = {}): ProjectRecord {
  return {
    meta: { id: 'p', name: 'P', createdAt: 1, updatedAt: 1, computed: false },
    settings: { ...DEFAULT_SETTINGS, shapes: { ...DEFAULT_SHAPES }, ...over },
    adjust: { ...DEFAULT_ADJUST },
    regions: [],
    palette: [],
  } as ProjectRecord;
}

describe('Berechnungsschlüssel und „Änderungen verwerfen“', () => {
  it('Ohne neue Einstellungen ist der Schlüssel unverändert (kein pc, keine neuen Formfelder)', () => {
    const r = rec();
    const k = JSON.parse(computeKey(r));
    expect('pc' in k).toBe(false);
    expect(Object.keys(k.sh).sort()).toEqual(Object.keys(DEFAULT_SHAPES).sort());
    expect(computeKey(rec({ pinnedColors: [] }))).toBe(computeKey(r));
    // Pflichtfarben wirken nur in den Automatik-Modi
    expect(computeKey(rec({ paletteMode: 'materials', pinnedColors: [{ hex: '#000000' }] }))).toBe(computeKey(rec({ paletteMode: 'materials' })));
    expect(computeKey(rec({ shapes: withShapeOption(DEFAULT_SHAPES, { bgCutFactor: 1, contourContinuity: false }) }))).toBe(computeKey(r));
  });

  it('Pflichtfarbe übernommen → „Pflichtfarben“ geändert; Verwerfen stellt den berechneten Stand her', () => {
    const before = { ...rec(), computedWith: computeKey(rec()) };
    const after: ProjectRecord = { ...before, settings: { ...before.settings, pinnedColors: [{ hex: '#1d1f1b', name: 'Pupillen' }] } };
    expect(staleReasons(before.computedWith, computeKey(after)).map((x) => x.group)).toEqual(['pinned']);
    const back = restoreComputedSettings(after)!;
    expect(back.settings.pinnedColors).toBeUndefined();
    expect(computeKey(back)).toBe(before.computedWith);
    // umgekehrt: berechnet mit Pflichtfarbe, danach entfernt → Verwerfen holt sie (mit Notiz, falls noch bekannt) zurück
    const withPin: ProjectRecord = { ...after, computedWith: computeKey(after) };
    const removed: ProjectRecord = { ...withPin, settings: { ...withPin.settings, pinnedColors: undefined } };
    const back2 = restoreComputedSettings(removed)!;
    expect(back2.settings.pinnedColors).toEqual([{ hex: '#1D1F1B' }]);
    expect(computeKey(back2)).toBe(withPin.computedWith);
  });

  it('Schnitte konzentrieren / Konturen durchgehend → „Steinformen“; Verwerfen entfernt die neuen Felder', () => {
    const before = { ...rec(), computedWith: computeKey(rec()) };
    const sh = withShapeOption(DEFAULT_SHAPES, { bgCutFactor: 3, contourContinuity: true });
    expect(sh).toMatchObject({ bgCutFactor: 3, contourContinuity: true });
    const after: ProjectRecord = { ...before, settings: { ...before.settings, shapes: sh } };
    expect(staleReasons(before.computedWith, computeKey(after)).map((x) => x.group)).toEqual(['shapes']);
    const back = restoreComputedSettings(after)!;
    expect('bgCutFactor' in back.settings.shapes).toBe(false);
    expect('contourContinuity' in back.settings.shapes).toBe(false);
    expect(computeKey(back)).toBe(before.computedWith);
    expect(withShapeOption(sh, { bgCutFactor: 1 })).not.toHaveProperty('bgCutFactor');
  });
});

describe('Pflichtfarben-Liste (Oberfläche)', () => {
  it('HEX normalisieren, keine Doppelten, ungültige ablehnen, Notizen, leere Liste → undefined', () => {
    expect(normalizeHexInput(' #abc ')).toBe('#AABBCC');
    expect(normalizeHexInput('12345')).toBeNull();
    const a = addPinned(undefined, '1d1f1b', ' Pupillen ');
    expect(a).toEqual({ ok: true, hex: '#1D1F1B', list: [{ hex: '#1D1F1B', name: 'Pupillen' }] });
    if (!a.ok) throw new Error('unerwartet');
    expect(addPinned(a.list, '#1D1F1B')).toEqual({ ok: false, reason: 'dup', hex: '#1D1F1B' });
    expect(addPinned(a.list, 'xyz')).toEqual({ ok: false, reason: 'invalid' });
    expect(isPinned(a.list, '#1d1f1b')).toBe(true);
    expect(renamePinned(a.list, '#1D1F1B', '')).toEqual([{ hex: '#1D1F1B' }]);
    expect(removePinned(a.list, '#1d1f1b')).toBeUndefined();
  });

  it('Status je Pflichtfarbe nur für eine aktuelle Berechnung mit genau dieser Farbe', () => {
    const d = { pinnedColors: [{ hex: '#1D1F1B', stones: 4, snapDE: 0, paletteHex: '#1D1F1B' }] } as never;
    expect(pinnedResultFor(d, '#1d1f1b', false)?.stones).toBe(4);
    expect(pinnedResultFor(d, '#1d1f1b', true)).toBeNull();
    expect(pinnedResultFor(d, '#000000', false)).toBeNull();
    expect(pinnedResultFor(undefined, '#1d1f1b', false)).toBeNull();
  });
});
