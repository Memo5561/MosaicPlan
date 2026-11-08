/**
 * w1-mosaic-core – Rechenkern-Regressionen:
 *  1. Golden-Hashes: Die Berechnung liefert für die vier Testprojekte (und weitere Modi) bitgleiche Daten.
 *     Neu aufnehmen nur bewusst:  UPDATE_GOLDEN=1 npx vitest run tests/w1-mosaic-core.test.ts
 *  2. Eigene Palette: alle Farben, Reihenfolge und Nummern bleiben über eine Berechnung erhalten.
 *  3. Steine je Farbe, Farbe entfernen mit gewählter Ersatzfarbe.
 *  4. „Palette aus Materialien“ nach einer Berechnung: zusammenführen, nur Farben ohne Material umstellen.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addPaletteColor, removePaletteColor, setFreePieces } from '../src/core/edits';
import type { Layout } from '../src/core/layout';
import { computeMosaic, type ComputeParams, type FixedColor } from '../src/core/mosaic';
import { applyMaterialMerge, mergePaletteFromMaterials, piecesPerColor, planColorRemoval, planMaterialMerge } from '../src/core/paletteOps';
import { cellPieces, cellRect } from '../src/core/pieces';
import { computeStats } from '../src/core/stats';
import { CellKind, DEFAULT_SHAPES, type MosaicData, type PaletteColor } from '../src/core/types';
import {
  baseParams,
  CUSTOM8,
  customFixed,
  GOLDEN_SAMPLES,
  MATERIALS12,
  materialFixed,
  mosaicHashes,
  paletteFromMaterials,
  sampleSetup,
  YELLOW,
  type MosaicHashes,
} from './w1-mosaic-core.fixtures';

const GOLDEN = 'tests/golden/mosaic-hashes.json';
const UPDATE = process.env.UPDATE_GOLDEN === '1';

interface GoldenFile {
  _info: string;
  samples: Record<string, MosaicHashes>;
  modes: Record<string, MosaicHashes>;
}

/** Zusätzliche Modi (gleiche Bilder), damit auch Material-, Dithering-, CIE76- und Ohne-Formen-Pfade bitgleich bleiben. */
const MODES: { key: string; sample: string; patch: () => Partial<ComputeParams> }[] = [
  { key: 'portrait/materials', sample: 'portrait', patch: () => ({ paletteMode: 'materials', fixedPalette: materialFixed(MATERIALS12) }) },
  { key: 'portrait/auto-snap', sample: 'portrait', patch: () => ({ paletteMode: 'auto-snap', colorCount: 16, fixedPalette: materialFixed(MATERIALS12) }) },
  { key: 'portrait/dither-cie76', sample: 'portrait', patch: () => ({ dither: 0.6, deltaE: '76' }) },
  { key: 'city/detail-k3', sample: 'city', patch: () => ({ shapes: { ...DEFAULT_SHAPES, subdivK: 3, detailLevel: 0.9, autoDetail: false } }) },
  {
    key: 'animal/no-shapes',
    sample: 'animal',
    patch: () => ({ shapes: { diagonal: false, line: false, subdivide: false, subdivK: 2, detailLevel: 0.5, autoDetail: true, skinProtect: true, minPieceMm: 1.5 } }),
  },
];

const actual: GoldenFile = {
  _info:
    'Golden-Hashes der Mosaikberechnung (tests/w1-mosaic-core.test.ts): kind, c1, c2, rec, sub, line, free und Palette (Code+HEX). ' +
    'Jede Änderung muss bewusst erfolgen und im PR begründet werden. Neu aufnehmen: UPDATE_GOLDEN=1 npx vitest run tests/w1-mosaic-core.test.ts',
  samples: {},
  modes: {},
};
const golden: GoldenFile | null = existsSync(GOLDEN) ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as GoldenFile) : null;

describe('Golden-Hashes: bitgleiche Berechnung', () => {
  for (const s of GOLDEN_SAMPLES) {
    it(`Testprojekt ${s.key} (automatisch, Seed 7)`, () => {
      const su = sampleSetup(s.key);
      const res = computeMosaic(su.img, baseParams(su));
      const h = mosaicHashes(res.data, res.palette);
      actual.samples[s.key] = h;
      if (!UPDATE) expect(h).toEqual(golden?.samples[s.key]);
    });
  }
  for (const m of MODES) {
    it(`Modus ${m.key}`, () => {
      const su = sampleSetup(m.sample);
      const res = computeMosaic(su.img, baseParams(su, m.patch()));
      const h = mosaicHashes(res.data, res.palette);
      actual.modes[m.key] = h;
      if (!UPDATE) expect(h).toEqual(golden?.modes[m.key]);
    });
  }
  it('Golden-Datei vorhanden (bzw. neu geschrieben)', () => {
    if (UPDATE) {
      mkdirSync('tests/golden', { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
    }
    expect(existsSync(GOLDEN)).toBe(true);
  });
});

// ================================================================ 2. Eigene Palette ('custom') bleibt stabil

const REF = JSON.parse(readFileSync('tests/golden/w1-mosaic-core-custom-reference.json', 'utf8')) as Record<string, { totalPieces: number; perHex: Record<string, number> }>;
const STATS_OPTS = { reservePct: 0, groutDepthMm: 3 };

/** Größter Palettenindex, den Steine tatsächlich verwenden (c1/c2 nur, wo die Zellart sie nutzt). */
function maxUsedIndex(d: MosaicData): number {
  let m = -1;
  for (let i = 0; i < d.kind.length; i++) {
    const k = d.kind[i];
    if (k === CellKind.SUB) for (const c of d.sub.get(i)!) m = Math.max(m, c);
    else if (k === CellKind.FREE) for (const f of d.free.get(i)!) m = Math.max(m, f.color);
    else {
      m = Math.max(m, d.c1[i]);
      if (k !== CellKind.FULL) m = Math.max(m, d.c2[i]);
    }
  }
  return m;
}

/** HEX-Farbe jedes einzelnen Steins (Zelle → Teilstück), über die exakte Geometrie aufgezählt. */
function pieceHexes(layout: Layout, d: MosaicData, palette: PaletteColor[]): string[] {
  const out: string[] = [];
  for (let r = 0; r < layout.rows; r++) for (let c = 0; c < layout.cols; c++) for (const p of cellPieces(layout, d, r, c)) out.push(palette[p.color]?.hex ?? `?${p.color}`);
  return out;
}

function perHexOf(palette: PaletteColor[], stats: { perColor: { pieces: number }[] }): Record<string, number> {
  const out: Record<string, number> = {};
  palette.forEach((p, i) => (out[p.hex] = (out[p.hex] ?? 0) + stats.perColor[i].pieces));
  return out;
}

/** Palette → FixedColor wie useProject.compute (mit Farbnummer; ohne nur für den Rückfall 1…n). */
const fixedOf = (pal: PaletteColor[], withCode = true): FixedColor[] => pal.map((p) => ({ lab: p.lab, hex: p.hex, name: p.name, materialId: p.materialId, ...(withCode ? { code: p.code } : {}) }));

describe('Eigene Palette: Farben, Reihenfolge und Nummern bleiben erhalten', () => {
  for (const dither of [0, 0.6]) {
    it(`8 Farben mit Nummern 1,2,3,5,6,7,8,9 und unbenutztem Gelb (Dithering ${dither})`, () => {
      const su = sampleSetup('portrait');
      const res = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', dither, fixedPalette: customFixed(CUSTOM8) }));
      expect(res.palette.map((p) => p.hex)).toEqual(CUSTOM8.map((c) => c.hex));
      expect(res.palette.map((p) => p.code)).toEqual([1, 2, 3, 5, 6, 7, 8, 9]);
      expect(res.palette.map((p) => p.name)).toEqual(CUSTOM8.map((c) => c.name));
      expect(maxUsedIndex(res.data)).toBeLessThan(res.palette.length);
      const st = computeStats(su.layout, res.data, res.palette, [], STATS_OPTS);
      const yi = res.palette.findIndex((p) => p.hex === YELLOW);
      expect(st.perColor[yi].pieces).toBe(0);
      // Stückzahlen je HEX wie in der alten Implementierung (dort fehlte Gelb ganz)
      const ref = REF[`custom8/dither${dither}`];
      expect(perHexOf(res.palette, st)).toEqual({ ...ref.perHex, [YELLOW]: 0 });
      expect(st.pieces).toBe(ref.totalPieces);
      expect(st.perColor.reduce((s, c) => s + c.pieces, 0)).toBe(st.pieces);
      // zweite Berechnung mit der zurückgegebenen Palette → identische Palette
      const res2 = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', dither, fixedPalette: fixedOf(res.palette) }));
      expect(res2.palette).toEqual(res.palette);
    });
  }

  it('12 Materialfarben als eigene Palette: Reihenfolge, Material-IDs und Stückzahlen je HEX', () => {
    const su = sampleSetup('portrait');
    const pal = paletteFromMaterials(MATERIALS12);
    const res = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: fixedOf(pal) }));
    expect(res.palette.map((p) => [p.code, p.hex, p.materialId])).toEqual(pal.map((p) => [p.code, p.hex, p.materialId]));
    const st = computeStats(su.layout, res.data, res.palette, [], STATS_OPTS);
    expect(perHexOf(res.palette, st)).toEqual(REF['materials12/dither0'].perHex);
  });

  it('ohne Nummern (bzw. mit doppelten/ungültigen Nummern) wird fortlaufend 1…n vergeben – Reihenfolge bleibt', () => {
    const su = sampleSetup('portrait');
    const noCodes = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: customFixed(CUSTOM8.map(({ hex, name }) => ({ hex, name }))) }));
    expect(noCodes.palette.map((p) => p.code)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(noCodes.palette.map((p) => p.hex)).toEqual(CUSTOM8.map((c) => c.hex));
    const dup = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: customFixed(CUSTOM8.map((c, i) => ({ ...c, code: i < 2 ? 1 : c.code }))) }));
    expect(dup.palette.map((p) => p.code)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const bad = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: customFixed(CUSTOM8.map((c, i) => ({ ...c, code: i === 0 ? 0.5 : c.code }))) }));
    expect(bad.palette.map((p) => p.code)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('eine 9. Farbe ergänzen und neu berechnen: Nummern der ersten 8 Farben bleiben', () => {
    const su = sampleSetup('portrait');
    const first = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: customFixed(CUSTOM8) }));
    const more = addPaletteColor(first.palette, '#C87A5A', 'Terrakotta');
    const res = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: fixedOf(more) }));
    expect(res.palette.map((p) => p.code)).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10]);
    // matchDeltaE (w2-colour-honesty) ist eine Messung der jeweiligen Berechnung – die 9. Farbe übernimmt Steine
    const def = ({ matchDeltaE: _m, ...p }: PaletteColor) => p;
    expect(res.palette.slice(0, 8).map(def)).toEqual(first.palette.map(def));
  });

  it('Modus „Nur eigene Materialien“ listet weiterhin nur verwendete Materialien (nach Helligkeit, 1…n)', () => {
    const su = sampleSetup('portrait');
    const mats = [...MATERIALS12, { ...MATERIALS12[0], id: 'gelb', colorName: 'Gelb', hex: YELLOW }];
    const res = computeMosaic(su.img, baseParams(su, { paletteMode: 'materials', fixedPalette: materialFixed(mats) }));
    expect(res.palette.some((p) => p.materialId === 'gelb')).toBe(false);
    expect(res.palette.map((p) => p.code)).toEqual(res.palette.map((_, i) => i + 1));
    for (let i = 1; i < res.palette.length; i++) expect(res.palette[i].lab[0]).toBeLessThanOrEqual(res.palette[i - 1].lab[0]);
    const st = computeStats(su.layout, res.data, res.palette, [], STATS_OPTS);
    expect(st.perColor.every((c) => c.pieces > 0)).toBe(true);
  });
});

// ================================================================ 3. Stückzahl je Farbe, Entfernen mit Ersatzfarbe

describe('Steine je Farbe und Farbe entfernen', () => {
  it('piecesPerColor zählt genau wie computeStats (auch Freiform-, Unterteilungs- und Schnittzellen)', () => {
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su));
    const r = cellRect(su.layout, 5, 5);
    const v = setFreePieces(
      su.layout,
      res.data,
      5,
      5,
      [
        { poly: [{ x: 0, y: 0 }, { x: r.w, y: 0 }, { x: 0, y: r.h / 2 - 0.5 }], color: 1 },
        { poly: [{ x: r.w, y: 0.5 }, { x: r.w, y: r.h }, { x: 0, y: r.h }, { x: 0, y: r.h / 2 + 0.5 }], color: 2 },
      ],
      0.5,
    );
    expect(v.errors).toEqual([]);
    const st = computeStats(su.layout, res.data, res.palette, [], STATS_OPTS);
    expect(piecesPerColor(res.data, res.palette.length)).toEqual(st.perColor.map((c) => c.pieces));
    const kinds = new Set(res.data.kind);
    for (const k of [CellKind.FULL, CellKind.DIAG_A, CellKind.DIAG_B, CellKind.LINE, CellKind.SUB, CellKind.FREE]) expect(kinds.has(k)).toBe(true);
  });

  it('planColorRemoval: Stückzahl der Farbe, Ersatzfarben nach ΔE sortiert, gewählte Ersatzfarbe wird verwendet', () => {
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su));
    const pal = res.palette;
    const before = computeStats(su.layout, res.data, pal, [], STATS_OPTS);
    const idx = before.perColor.findIndex((c) => c.pieces > 50);
    const plan = planColorRemoval(pal, res.data, idx, '2000');
    expect(plan.pieces).toBe(before.perColor[idx].pieces);
    expect(plan.options.map((o) => o.index)).not.toContain(idx);
    expect(plan.options.length).toBe(pal.length - 1);
    for (let i = 1; i < plan.options.length; i++) expect(plan.options[i].deltaE).toBeGreaterThanOrEqual(plan.options[i - 1].deltaE);
    // bewusst NICHT die nächste Farbe wählen
    const chosen = plan.options[plan.options.length - 1].index;
    const hexBefore = pieceHexes(su.layout, res.data, pal);
    const next = removePaletteColor(pal, res.data, idx, chosen, '2000');
    const hexAfter = pieceHexes(su.layout, res.data, next);
    expect(hexAfter.length).toBe(hexBefore.length);
    let moved = 0;
    hexBefore.forEach((h, i) => {
      if (h === pal[idx].hex) {
        moved++;
        expect(hexAfter[i]).toBe(pal[chosen].hex);
      } else expect(hexAfter[i]).toBe(h);
    });
    expect(moved).toBe(plan.pieces);
    expect(maxUsedIndex(res.data)).toBeLessThan(next.length);
    const after = computeStats(su.layout, res.data, next, [], STATS_OPTS);
    expect(after.pieces).toBe(before.pieces);
    // Farbnummern der übrigen Farben unverändert
    expect(next.map((p) => p.code)).toEqual(pal.filter((_, i) => i !== idx).map((p) => p.code));
  });

  it('ohne Berechnung: 0 betroffene Steine', () => {
    const pal = paletteFromMaterials(MATERIALS12);
    expect(planColorRemoval(pal, null, 3, '76').pieces).toBe(0);
  });
});

// ================================================================ 4. „Palette aus Materialien“ zusammenführen

describe('Palette aus Materialien nach einer Berechnung (zusammenführen statt ersetzen)', () => {
  const compute12 = () => {
    const su = sampleSetup('portrait');
    return { su, res: computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: fixedOf(paletteFromMaterials(MATERIALS12)) })) };
  };
  const ROSA = { ...MATERIALS12[0], id: 'm13', colorNumber: 'M13', colorName: 'Rosa', hex: '#E3A08C' };
  const GONE = ['m3', 'm9', 'm12'];
  const reduced = [...MATERIALS12.filter((m) => !GONE.includes(m.id)), ROSA];

  it('reduzierte Materialliste: umgestellte Steine = Steine der entfernten Farben, Summe unverändert, Indizes gültig', () => {
    const { su, res } = compute12();
    const pal = res.palette;
    const before = computeStats(su.layout, res.data, pal, [], STATS_OPTS);
    const hashBefore = mosaicHashes(res.data, pal);
    const plan = planMaterialMerge(pal, res.data, reduced, '2000');
    expect(mosaicHashes(res.data, pal)).toEqual(hashBefore); // planen verändert nichts

    const removedIdx = pal.map((p, i) => (GONE.includes(p.materialId!) ? i : -1)).filter((i) => i >= 0);
    const expectedMoved = removedIdx.reduce((s, i) => s + before.perColor[i].pieces, 0);
    expect(expectedMoved).toBeGreaterThan(0);
    expect(plan.removed.map((r) => r.code)).toEqual(removedIdx.map((i) => pal[i].code));
    expect(plan.movedStones).toBe(expectedMoved);
    expect(plan.added.map((p) => [p.code, p.hex, p.materialId])).toEqual([[13, '#E3A08C', 'm13']]);

    const hexBefore = pieceHexes(su.layout, res.data, pal);
    const merged = mergePaletteFromMaterials(pal, res.data, reduced, '2000');
    expect(merged.palette).toEqual(plan.palette);
    expect(merged.movedStones).toBe(expectedMoved);
    expect(merged.palette.length).toBe(12 - 3 + 1);
    expect(maxUsedIndex(res.data)).toBeLessThan(merged.palette.length);

    const after = computeStats(su.layout, res.data, merged.palette, [], STATS_OPTS);
    expect(after.pieces).toBe(before.pieces);
    expect(after.perColor.reduce((s, c) => s + c.pieces, 0)).toBe(before.pieces);

    // Jeder Stein einer verbleibenden Farbe behält seine Farbe; Steine entfernter Farben → geplante Ersatzfarbe
    const targetOf = new Map(plan.removed.map((r) => [r.hex, r.targetHex]));
    const hexAfter = pieceHexes(su.layout, res.data, merged.palette);
    let moved = 0;
    hexBefore.forEach((h, i) => {
      const t = targetOf.get(h);
      if (t) {
        moved++;
        expect(hexAfter[i]).toBe(t);
      } else expect(hexAfter[i]).toBe(h);
    });
    expect(moved).toBe(expectedMoved);
    let maxDE = 0;
    for (const r of plan.removed) if (r.pieces > 0) maxDE = Math.max(maxDE, r.deltaE);
    expect(merged.maxDeltaE).toBe(maxDE);
    expect(merged.maxDeltaE).toBeGreaterThan(0);
    // Nummern verbleibender Farben unverändert; die neue Farbe steht am Ende und erhält genau die Steine,
    // für die sie die nächste Ersatzfarbe ist (hier: „Haut hell“ → „Rosa“)
    const kept = pal.filter((_, i) => !removedIdx.includes(i));
    expect(merged.palette.slice(0, kept.length).map((p) => [p.code, p.hex])).toEqual(kept.map((p) => [p.code, p.hex]));
    const toRosa = plan.removed.filter((r) => r.targetHex === '#E3A08C').reduce((s, r) => s + r.pieces, 0);
    expect(toRosa).toBeGreaterThan(0);
    expect(after.perColor[merged.palette.length - 1].pieces).toBe(toRosa);
  });

  it('gleiche Materialien: nichts zu tun', () => {
    const { res } = compute12();
    const plan = planMaterialMerge(res.palette, res.data, MATERIALS12, '2000');
    expect(plan.unchanged).toBe(true);
    expect(plan.palette).toEqual(res.palette);
    expect(plan.movedStones).toBe(0);
  });

  it('Farbe ohne Material-ID, aber mit gleichem HEX wird verknüpft statt entfernt; geänderte Materialfarbe wird übernommen', () => {
    const { su, res } = compute12();
    const pal = res.palette.map((p, i) => (i === 0 ? { ...p, materialId: undefined } : p));
    const mats = MATERIALS12.map((m) => (m.id === 'm2' ? { ...m, hex: '#202020' } : m));
    const before = computeStats(su.layout, res.data, pal, [], STATS_OPTS);
    const merged = mergePaletteFromMaterials(pal, res.data, mats, '2000');
    expect(merged.plan.linked).toBe(1);
    expect(merged.plan.removed).toEqual([]);
    expect(merged.plan.recolored.map((r) => [r.code, r.toHex])).toEqual([[2, '#202020']]);
    expect(merged.plan.recolored[0].pieces).toBe(before.perColor[1].pieces);
    expect(merged.movedStones).toBe(0);
    expect(merged.palette[0].materialId).toBe('m1');
    expect(merged.palette[1].hex).toBe('#202020');
    expect(merged.palette.map((p) => p.code)).toEqual(pal.map((p) => p.code));
  });

  it('automatisch berechnete Palette (ohne Material): alle Steine werden auf Materialfarben umgestellt, Gesamtzahl bleibt', () => {
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su, { colorCount: 16 }));
    const before = computeStats(su.layout, res.data, res.palette, [], STATS_OPTS);
    const merged = mergePaletteFromMaterials(res.palette, res.data, MATERIALS12, '2000');
    expect(merged.palette.length).toBe(12);
    expect(merged.palette.map((p) => p.code)).toEqual(Array.from({ length: 12 }, (_, i) => res.palette.length + 1 + i));
    expect(merged.movedStones).toBe(before.pieces);
    expect(maxUsedIndex(res.data)).toBeLessThan(12);
    expect(computeStats(su.layout, res.data, merged.palette, [], STATS_OPTS).pieces).toBe(before.pieces);
  });

  it('ohne berechnetes Mosaik bzw. ohne gültige Materialfarbe', () => {
    const pal = paletteFromMaterials(MATERIALS12);
    const m = mergePaletteFromMaterials(pal, null, reduced, '2000');
    expect(m.movedStones).toBe(0);
    expect(m.palette.map((p) => p.materialId)).toEqual(['m1', 'm2', 'm4', 'm5', 'm6', 'm7', 'm8', 'm10', 'm11', 'm13']);
    const bad = planMaterialMerge(pal, null, [{ ...ROSA, hex: 'xyz' }], '2000');
    expect(bad.noValidMaterials).toBe(true);
    expect(bad.palette).toEqual(pal);
    expect(() => applyMaterialMerge(bad, null, '2000')).toThrow();
  });
});
