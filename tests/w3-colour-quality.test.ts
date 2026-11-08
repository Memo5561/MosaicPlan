/**
 * w3-colour-quality:
 *  1. Farbmischung nur mit ähnlichen Tönen: NearestColorMatcher.candidates exakt, keine fremden Farbtupfer,
 *     wahrgenommene Abweichung bei 50 % ≤ 0 %, Standard 50 % für neue Projekte, Zuordnung schnell genug.
 *  2. „Meine Steine – begrenzte Farbanzahl“: Auswahl direkt aus dem Bestand (angeforderte Anzahl, nie schlechter als
 *     das frühere Verfahren, deterministisch, nur Materialien des Bestands, Bestand bei fast gleicher Eignung bevorzugt).
 *  3. „Fehlende Farben“: exakte Steinzahlen, nur Bildfarben ohne Material auf ΔE ≤ 5, nie ein erfundenes Material.
 */
import { describe, expect, it } from 'vitest';
import { deltaE2000, deltaE76, DITHER_CANDIDATES_MAX, DITHER_TOLERANCE, hexToLab, NearestColorMatcher, rgbToHex, rgbToLab, type Lab } from '../src/core/color';
import { rng } from '../src/core/kmeans';
import { computeLayout } from '../src/core/layout';
import { computeMosaic, MISSING_DELTA_E, MISSING_IMAGE_COLORS, selectMaterials, type ComputeDiagnostics, type ComputeResult, type FixedColor } from '../src/core/mosaic';
import { cellPieces } from '../src/core/pieces';
import { computeStats } from '../src/core/stats';
import { DEFAULT_SETTINGS, DEFAULT_SHAPES } from '../src/core/types';
import { makeT } from '../src/i18n';
import { colorCountNotice } from '../src/ui/project/StepColors';
import { loadPng, prepareFor } from './helpers';
import { baseParams, GOLDEN_SAMPLES, materialFixed, MATERIALS12, mosaicHashes, sampleSetup } from './w1-mosaic-core.fixtures';
import { perceivedDeltaE, photoCellsLinear } from './w3-colour-quality.metrics';

const STATS_OPTS = { reservePct: 0, groutDepthMm: 3 };
const SAMPLES = GOLDEN_SAMPLES.map((s) => s.key);

function randLab(r: () => number): Lab {
  return [5 + r() * 90, (r() - 0.5) * 160, (r() - 0.5) * 160];
}

/** Erwartete Kandidaten per Vergleich mit jeder erlaubten Farbe. */
function bruteCandidates(pal: Lab[], l: Lab, formula: '2000' | '76', T: number, mask?: boolean[]): { idx: number[]; d: number[] } {
  const de = formula === '76' ? deltaE76 : deltaE2000;
  const all = pal
    .map((c, i) => ({ i, d: de(l[0], l[1], l[2], c[0], c[1], c[2]) }))
    .filter((x) => !mask || mask[x.i]);
  all.sort((a, b) => a.d - b.d || a.i - b.i);
  const best = all[0];
  const rest = all.slice(1).filter((x) => x.d <= best.d + T);
  const list = [best, ...rest].slice(0, DITHER_CANDIDATES_MAX);
  return { idx: list.map((x) => x.i), d: list.map((x) => x.d) };
}

describe('Farbmischung: Kandidaten (NearestColorMatcher.candidates)', () => {
  for (const formula of ['2000', '76'] as const)
    for (const size of [6, 16, 24, 64, 200]) {
      it(`exakt wie der Vergleich mit jeder Farbe (${size} Farben, ΔE${formula === '76' ? '76' : '00'})`, () => {
        const r = rng(size * 31 + (formula === '76' ? 7 : 0));
        const pal = Array.from({ length: size }, () => randLab(r));
        const m = new NearestColorMatcher(pal, formula);
        for (let q = 0; q < 300; q++) {
          // auch nahe an Palettenfarben (dort liegen die echten Steinfarben)
          const base = pal[Math.floor(r() * size)];
          const l: Lab = q % 2 ? randLab(r) : [base[0] + (r() - 0.5) * 10, base[1] + (r() - 0.5) * 10, base[2] + (r() - 0.5) * 10];
          const c = m.candidatesExact(l[0], l[1], l[2]);
          const ref = bruteCandidates(pal, l, formula, DITHER_TOLERANCE);
          expect(c.idx[0]).toBe(m.nearestExact(l[0], l[1], l[2]));
          expect(Array.from(c.idx)).toEqual(ref.idx);
          c.d.forEach((d, k) => expect(d).toBeCloseTo(ref.d[k], 9));
          expect(c.d[c.d.length - 1] - c.d[0]).toBeLessThanOrEqual(DITHER_TOLERANCE + 1e-9);
        }
      });
    }

  it('mit Maske und Toleranz 0 (nur die nächste Farbe und exakte Gleichstände)', () => {
    const r = rng(99);
    const pal = Array.from({ length: 90 }, () => randLab(r));
    const mask = pal.map((_, i) => i % 4 !== 1);
    const m = new NearestColorMatcher(pal, '2000', mask);
    for (let q = 0; q < 300; q++) {
      const l = randLab(r);
      expect(m.candidatesExact(l[0], l[1], l[2]).idx.length).toBeGreaterThan(0);
      expect(Array.from(m.candidatesExact(l[0], l[1], l[2]).idx)).toEqual(bruteCandidates(pal, l, '2000', DITHER_TOLERANCE, mask).idx);
      expect(Array.from(m.candidatesExact(l[0], l[1], l[2], 0).idx)).toEqual(bruteCandidates(pal, l, '2000', 0, mask).idx);
    }
  });

  it('Zwischenspeicher: auf dem Raster der gespeicherten Steinfarben gleich candidatesExact', () => {
    const r = rng(5);
    const pal = Array.from({ length: 48 }, () => randLab(r));
    const m = new NearestColorMatcher(pal, '2000');
    for (let q = 0; q < 500; q++) {
      // Steinfarben liegen auf L = k/2,55, a/b ganzzahlig (qL/qAB in mosaic.ts)
      const l: Lab = [Math.round(r() * 255) / 2.55, Math.round((r() - 0.5) * 160), Math.round((r() - 0.5) * 160)];
      const first = m.candidates(l[0], l[1], l[2]);
      const a = { idx: Array.from(first.idx), d: Array.from(first.d) };
      const again = m.candidates(l[0], l[1], l[2]); // aus dem Zwischenspeicher
      expect({ idx: Array.from(again.idx), d: Array.from(again.d) }).toEqual(a);
      const ex = m.candidatesExact(l[0], l[1], l[2]);
      expect(a).toEqual({ idx: Array.from(ex.idx), d: Array.from(ex.d) });
    }
  });
});

describe('Farbmischung im Mosaik', () => {
  it('Standard für neue Projekte: 50 %', () => {
    expect(DEFAULT_SETTINGS.dither).toBe(0.5);
  });

  it('keine fremden Farbtupfer: jeder Stein höchstens ΔE 3 schlechter als die nächste Farbe (auch bei 100 %)', () => {
    for (const key of SAMPLES) {
      const su = sampleSetup(key);
      for (const dither of [0.5, 1]) {
        const res = computeMosaic(su.img, baseParams(su, { dither }));
        const st = computeStats(su.layout, res.data, res.palette, [], STATS_OPTS);
        const d = res.diagnostics;
        expect(d.ditherExcessMax!).toBeLessThanOrEqual(DITHER_TOLERANCE + 1e-9);
        // Abnahme: höchstens die Zahl bei 0 % (dort 0 – jeder Stein erhält die nächste Farbe) plus 1 % der Steine
        expect(d.ditherExcessOver5!).toBeLessThanOrEqual(0 + 0.01 * st.pieces);
        expect(d.ditherExcessOver5).toBe(0);
      }
      expect(computeMosaic(su.img, baseParams(su, { dither: 0 })).diagnostics.ditherExcessMax).toBeUndefined();
    }
  });

  it('wahrgenommene Abweichung (σ = 1 Zelle, lineares Licht) bei 50 % ≤ 0 % auf allen vier Testprojekten', () => {
    const rows: string[] = [];
    for (const key of SAMPLES) {
      const su = sampleSetup(key);
      const photo = photoCellsLinear(su.layout, su.img);
      const p0 = computeMosaic(su.img, baseParams(su, { dither: 0 }));
      const p5 = computeMosaic(su.img, baseParams(su, { dither: 0.5 }));
      const a = perceivedDeltaE(su.layout, p0.data, p0.palette, su.img, photo);
      const b = perceivedDeltaE(su.layout, p5.data, p5.palette, su.img, photo);
      rows.push(`${key}: ${a.toFixed(3)} → ${b.toFixed(3)} (${(((b - a) / a) * 100).toFixed(0)} %)`);
      expect(b).toBeLessThanOrEqual(a);
    }
    console.log(`Wahrgenommenes ΔE00 0 % → 50 %: ${rows.join(', ')}`);
  });

  it('2 Mio. Positionen, 200 Farben, Mischung 50 %: Zuordnung schneller als die bisherigen 11 s', () => {
    const layout = computeLayout({ widthMm: 10000, heightMm: 5000, tileW: 4, tileH: 4, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const img = prepareFor(loadPng('public/samples/city.png'), layout);
    let tAssign = 0;
    let start = 0;
    const res = computeMosaic(
      img,
      { layout, shapes: { ...DEFAULT_SHAPES, diagonal: false, line: false, subdivide: false }, paletteMode: 'auto', colorCount: 200, dither: 0.5, deltaE: '2000', regions: [] },
      (phase, f) => {
        if (phase === 'assign' && f === 0) start = Date.now();
        if (phase === 'assign' && f === 1) tAssign = Date.now() - start;
      },
    );
    console.log(`2 Mio. Positionen, 200 Farben, Mischung 50 %: Zuordnung ${tAssign} ms`);
    expect(res.palette.reduce((s, p) => s + p.matchDeltaE!.pieces, 0)).toBe(2_000_000);
    expect(tAssign).toBeLessThan(11_000);
  }, 300000);
});

// ---------------------------------------------------------------- Materialauswahl

/** Katalog: 7 Stufen je sRGB-Kanal (gleichmäßig im Farbraum), die ersten 336 Farben (wie tests/w2-colour-honesty) */
function gamutCatalogue(): FixedColor[] {
  const steps = [0, 42, 85, 128, 170, 213, 255];
  const cat: FixedColor[] = [];
  for (const r of steps) for (const g of steps) for (const b of steps) cat.push({ lab: rgbToLab(r, g, b), hex: rgbToHex(r, g, b), name: `Kat ${cat.length + 1}`, materialId: `k${cat.length + 1}` });
  return cat.slice(0, 336);
}

function piecesOf(res: ComputeResult): number {
  return res.palette.reduce((s, p) => s + p.matchDeltaE!.pieces, 0);
}

describe('„Meine Steine – begrenzte Farbanzahl“: Auswahl direkt aus dem Bestand', () => {
  const catalogue = gamutCatalogue();
  const pool = new Set(catalogue.map((c) => c.materialId));

  for (const key of SAMPLES) {
    it(`${key}: 336 Katalogfarben, 24 angefordert – Anzahl, Abweichung, Zellarten, Bestand, deterministisch`, () => {
      const su = sampleSetup(key);
      const p = baseParams(su, { paletteMode: 'auto-snap', colorCount: 24, fixedPalette: catalogue });
      const res = computeMosaic(su.img, p);
      const old = computeMosaic(su.img, { ...p, snapMethod: 'nearest' });
      // Farben, die überhaupt Steine bekommen (jeder Stein → nächstes Material des ganzen Bestands)
      const usable = computeMosaic(su.img, baseParams(su, { paletteMode: 'materials', fixedPalette: catalogue })).palette.length;
      expect(res.palette.length).toBe(Math.min(24, usable));
      expect(res.diagnostics.usedColors).toBe(res.palette.length);
      expect(res.palette.length).toBeGreaterThanOrEqual(old.palette.length);
      expect(res.diagnostics.meanDeltaE).toBeLessThanOrEqual(old.diagnostics.meanDeltaE + 1e-9);
      expect(Array.from(res.data.kind)).toEqual(Array.from(old.data.kind));
      expect(res.palette.every((c) => pool.has(c.materialId))).toBe(true);
      expect(new Set(res.palette.map((c) => c.materialId)).size).toBe(res.palette.length);
      // Steine je Farbe = Steine gesamt (Geometrie unverändert)
      const st = computeStats(su.layout, res.data, res.palette, [], STATS_OPTS);
      expect(st.perColor.reduce((s, c) => s + c.pieces, 0)).toBe(st.pieces);
      expect(piecesOf(res)).toBe(st.pieces);
      // Kennzahlen der Auswahl
      const sel = res.diagnostics.snapSelection!;
      expect(sel.method).toBe('select');
      expect(sel.snapColors).toBe(old.palette.length);
      expect(sel.costSelected!).toBeLessThanOrEqual(sel.costSnap! + 1e-9);
      expect(res.diagnostics.poolColors).toBe(336);
      // deterministisch
      const again = computeMosaic(su.img, p);
      expect(mosaicHashes(again.data, again.palette)).toEqual(mosaicHashes(res.data, res.palette));
      console.log(`${key}: verwendet ${old.palette.length} → ${res.palette.length} (nutzbar ${usable}), Ø ΔE ${old.diagnostics.meanDeltaE.toFixed(3)} → ${res.diagnostics.meanDeltaE.toFixed(3)}`);
    });
  }

  it('wenige Materialien: alle, die das Bild verbessern; Gründe in der Meldung', () => {
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su, { paletteMode: 'auto-snap', colorCount: 16, fixedPalette: materialFixed(MATERIALS12) }));
    const old = computeMosaic(su.img, baseParams(su, { paletteMode: 'auto-snap', colorCount: 16, fixedPalette: materialFixed(MATERIALS12), snapMethod: 'nearest' }));
    expect(res.palette.length).toBeGreaterThanOrEqual(old.palette.length);
    expect(res.palette.length).toBeLessThanOrEqual(12);
    expect(res.diagnostics.poolColors).toBe(12);
    const text = colorCountNotice(res.diagnostics, makeT('de'))!;
    expect(text.warn).toBe(true);
    expect(text.text).toContain(`angefordert 16 – verwendet ${res.palette.length}`);
    expect(text.text).toContain('Ihre Materialauswahl hat nur 12 Farben.');
  });

  it('Meldung: angeforderte Anzahl erreicht, weitere Materialien ohne Nutzen, ältere Ergebnisse', () => {
    const t = makeT('de');
    const base: ComputeDiagnostics = { meanDeltaE: 1, maxDeltaE: 2, p95DeltaE: 2, splitCells: 0, subCells: 0, recommendCells: 0, timeMs: 1, samplesPerCell: 36, paletteMode: 'auto-snap', requestedColors: 24, imageColors: 24 };
    const sel = { method: 'select' as const, snapColors: 13, selected: 24, swaps: 0, filled: 0, stockSwaps: 0, budgetHit: false };
    const full = colorCountNotice({ ...base, usedColors: 24, mergedColors: 3, poolColors: 336, snapSelection: sel }, t)!;
    expect(full).toEqual({ text: 'Bei der Berechnung: angefordert 24 – verwendet 24.', warn: false });
    const few = colorCountNotice({ ...base, usedColors: 17, mergedColors: 7, poolColors: 336, snapSelection: { ...sel, selected: 18 } }, t)!;
    expect(few.warn).toBe(true);
    expect(few.text).toContain('Nur 18 Ihrer Materialien verbessern das Bild');
    expect(few.text).toContain('1 weitere Farbe erhielt keinen Stein.');
    const stock = colorCountNotice({ ...base, usedColors: 24, poolColors: 336, snapSelection: { ...sel, stockSwaps: 2 } }, t)!;
    expect(stock.text).toContain('2 Materialien mit Bestand wurden bei fast gleicher Eignung bevorzugt.');
    // ältere Ergebnisse (ohne poolColors): bisherige Meldung
    const legacy = colorCountNotice({ ...base, usedColors: 13, mergedColors: 11 }, t)!;
    expect(legacy.text).toContain('(11 Bildfarben zusammengelegt');
    for (const lang of ['en', 'tr'] as const) expect(colorCountNotice({ ...base, usedColors: 17, mergedColors: 7, poolColors: 12, snapSelection: sel }, makeT(lang))!.text).not.toMatch(/w3cq\./);
  });

  it('Bestand bevorzugen: fast gleiche Materialien mit Bestand > 0 werden gewählt, die Zuordnung bleibt nach Farbabstand', () => {
    const su = sampleSetup('portrait');
    const mats = materialFixed(MATERIALS12);
    // zu jedem Material ein fast gleiches (ΔE < 0,5) mit Bestand
    const twins: FixedColor[] = mats.map((m) => {
      const lab: Lab = [m.lab[0] + 0.3, m.lab[1], m.lab[2]];
      return { ...m, lab, materialId: `${m.materialId}-lager`, name: `${m.name} (Lager)`, stock: 200 };
    });
    for (const t of twins) expect(deltaE2000(...t.lab, ...mats[twins.indexOf(t)].lab)).toBeLessThan(0.5);
    const res = computeMosaic(su.img, baseParams(su, { paletteMode: 'auto-snap', colorCount: 10, fixedPalette: [...mats, ...twins] }));
    const sel = res.diagnostics.snapSelection!;
    expect(sel.stockSwaps).toBeGreaterThan(0);
    const stocked = res.palette.filter((p) => p.materialId!.endsWith('-lager')).length;
    expect(stocked).toBeGreaterThanOrEqual(sel.stockSwaps);
    expect(sel.costSelected!).toBeLessThanOrEqual(sel.costSnap! + 1e-9);
    // Zuordnung: jeder ganze Stein hat die nächste Palettenfarbe (ohne Mischung) – kein Bonus bei den Steinen
    expect(res.diagnostics.meanDeltaE).toBeGreaterThan(0);
    // ohne Bestandsangaben: gleiches Ergebnis wie ohne Zwillinge mit Bestand 0
    const none = computeMosaic(su.img, baseParams(su, { paletteMode: 'auto-snap', colorCount: 10, fixedPalette: [...mats, ...twins.map((t) => ({ ...t, stock: 0 }))] }));
    expect(none.diagnostics.snapSelection!.stockSwaps).toBe(0);
  });

  it('selectMaterials: nie teurer als die Startmenge, deterministisch, k und Bestand respektiert', () => {
    const r = rng(3);
    const X = Array.from({ length: 120 }, () => randLab(r));
    const w = X.map(() => 0.5 + r());
    const mats: FixedColor[] = Array.from({ length: 80 }, (_, i) => ({ lab: randLab(r), hex: '#000000', name: `M${i}`, materialId: `m${i}` }));
    const seed = [3, 17, 17, 40];
    const a = selectMaterials(X, w, mats, 12, '2000', seed);
    const b = selectMaterials(X, w, mats, 12, '2000', seed);
    expect(a).toEqual(b);
    expect(a.chosen.length).toBe(12);
    expect(new Set(a.chosen).size).toBe(12);
    expect(a.costSelected).toBeLessThanOrEqual(a.costSnap + 1e-12);
    // mehr Farben als Materialien: höchstens alle Materialien
    expect(selectMaterials(X, w, mats.slice(0, 5), 12, '76', [0]).chosen.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------- Fehlende Farben

describe('„Fehlende Farben – Farbton zum Nachkaufen (Zielwert)“', () => {
  it('exakte Steinzahlen: ein einziges, fernes Material → jede Bildfarbe fehlt, Summe = alle Steine', () => {
    const su = sampleSetup('portrait');
    const green: FixedColor = { lab: hexToLab('#00FF00'), hex: '#00FF00', name: 'Grün', materialId: 'g1' };
    for (const mode of ['auto-snap', 'materials'] as const) {
      const res = computeMosaic(su.img, baseParams(su, { paletteMode: mode, colorCount: 16, fixedPalette: [green] }));
      const d = res.diagnostics;
      const st = computeStats(su.layout, res.data, res.palette, [], STATS_OPTS);
      expect(d.missingThreshold).toBe(MISSING_DELTA_E);
      expect(d.missingChecked).toBe(mode === 'auto-snap' ? d.imageColors : MISSING_IMAGE_COLORS);
      expect(d.missingColors!.length).toBe(d.missingChecked);
      expect(d.missingColors!.reduce((s, m) => s + m.stones, 0)).toBe(st.pieces);
      for (const m of d.missingColors!) {
        expect(m.nearestMaterialId).toBe('g1');
        expect(m.nearestHex).toBe('#00FF00');
        expect(m.deltaE).toBeGreaterThan(MISSING_DELTA_E);
        expect(m.deltaE).toBeCloseTo(deltaE2000(...m.lab, ...green.lab), 1);
        expect(m.hex).toMatch(/^#[0-9A-F]{6}$/);
      }
      // sortiert nach Steinen
      const s = d.missingColors!.map((m) => m.stones);
      expect([...s].sort((a, b) => b - a)).toEqual(s);
    }
  });

  it('nur Bildfarben über ΔE 5; im Modus „Automatisch“ und bei eigener Palette keine Liste', () => {
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su, { paletteMode: 'auto-snap', colorCount: 24, fixedPalette: materialFixed(MATERIALS12) }));
    const d = res.diagnostics;
    expect(d.missingColors!.length).toBeGreaterThan(0);
    expect(d.missingColors!.length).toBeLessThan(d.missingChecked!);
    const ids = new Set(MATERIALS12.map((m) => m.id));
    for (const m of d.missingColors!) {
      expect(m.deltaE).toBeGreaterThan(MISSING_DELTA_E);
      expect(ids.has(m.nearestMaterialId!)).toBe(true);
      // ΔE zum nächsten Material: kein Material ist näher
      const nearest = Math.min(...materialFixed(MATERIALS12).map((f) => deltaE2000(...m.lab, ...f.lab)));
      expect(m.deltaE).toBeCloseTo(nearest, 1);
      expect(m.stones).toBeGreaterThan(0);
      expect(m.assignedDeltaE).toBeGreaterThan(0);
    }
    expect(d.missingColors!.reduce((s, m) => s + m.stones, 0)).toBeLessThanOrEqual(piecesOf(res));
    expect(computeMosaic(su.img, baseParams(su)).diagnostics.missingColors).toBeUndefined();
    const custom = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: materialFixed(MATERIALS12) }));
    expect(custom.diagnostics.missingColors).toBeUndefined();
  });

  it('jeder Stein genau einmal: Steine aller Bildfarben je Zelle über die exakte Geometrie gezählt', () => {
    const su = sampleSetup('animal');
    const far: FixedColor[] = [{ lab: hexToLab('#FF00FF'), hex: '#FF00FF', name: 'Magenta', materialId: 'x' }];
    const res = computeMosaic(su.img, baseParams(su, { paletteMode: 'materials', fixedPalette: far }));
    let pieces = 0;
    for (let r = 0; r < su.layout.rows; r++) for (let c = 0; c < su.layout.cols; c++) pieces += cellPieces(su.layout, res.data, r, c).length;
    expect(res.diagnostics.missingColors!.reduce((s, m) => s + m.stones, 0)).toBe(pieces);
  });
});
