/**
 * Korrekturen nach der Gegenprüfung von Welle 5 (w5-fix-ui):
 *  1. Fehlbestand-Summe nur über Materialien mit erfasstem Bestand → als Teilsumme/unvollständig gekennzeichnet
 *     (Banner-Werte aus shoppingTotals, Hinweis in der CSV-Summenzeile);
 *  3. „Heller“/„Dunkler“ (shadeSuggest) widerspricht nie den ▲/▼-Markierungen der Farbreihe.
 */
import { describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { addPaletteColor, SHADE_MARK_DL, SHADE_MIN_DL, shadeStep, shadeSuggest } from '../src/core/edits';
import { computeLayout } from '../src/core/layout';
import { buildShoppingCsv, SHOPPING_CSV_COLUMNS, SHOPPING_CSV_TEXT, shoppingRows, shoppingTotals } from '../src/core/shoppingCsv';
import { computeStats } from '../src/core/stats';
import { createEmptyMosaic, type Material, type PaletteColor } from '../src/core/types';
import { dictionaries } from '../src/i18n';

const OPTS0 = { reservePct: 0, groutDepthMm: 3 };

function mat(id: string, over: Partial<Material> = {}): Material {
  return { id, type: 'glass', manufacturer: 'Test', product: 'Glas', colorNumber: id, colorName: id, hex: '#2050C0', lengthMm: 5, widthMm: 5, thicknessMm: 4, price: 0, packageSize: '', piecesPerPack: 0, ...over };
}

/** Palette mit n Farben; materialIds[i] = Material der Farbe i */
function pal(materialIds: (string | undefined)[]): PaletteColor[] {
  const hexes = ['#FFFFFF', '#2050C0', '#C02020', '#20A040'];
  return materialIds.map((m, i) => ({ code: i + 1, hex: hexes[i], name: `F${i + 1}`, lab: hexToLab(hexes[i]), materialId: m }));
}

/** 10 × 6 ganze Steine (5 × 5 mm, Fuge 1), Farbe i für je 15 Steine */
function mosaic(colors: number) {
  const L = computeLayout({ widthMm: 10 * 5 + 9, heightMm: 6 * 5 + 5, tileW: 5, tileH: 5, joint: 1, edgeMode: 'whole', minCutMm: 1 });
  const d = createEmptyMosaic(10, 6);
  for (let i = 0; i < 60; i++) d.c1[i] = Math.min(colors - 1, Math.floor(i / 15));
  return { L, d };
}

function parseCsv(csv: string, D: string): string[][] {
  return csv
    .replace(/^﻿/, '')
    .trim()
    .split('\r\n')
    .map((l) => l.split(D));
}
const col = (c: string) => SHOPPING_CSV_COLUMNS.indexOf(c as (typeof SHOPPING_CSV_COLUMNS)[number]);

describe('Fehlbestand: Summe nur über Materialien mit erfasstem Bestand', () => {
  it('Material ohne Bestand und Farben ohne Material → Teilsumme, unvollständig; CSV-Summe mit Hinweis', () => {
    const { L, d } = mosaic(4);
    // a: Bestand 10 < 15 (Fehlbestand 5), Packung 10 Stück à 4; b: kein Bestand; Farben 2 und 3 ohne Material
    const P = pal(['a', 'b', undefined, undefined]);
    const mats = [mat('a', { piecesPerPack: 10, price: 4, stock: 10 }), mat('b', { piecesPerPack: 10, price: 4 })];
    const s = computeStats(L, d, P, mats, OPTS0);
    const rows = shoppingRows(s, P, mats);
    const t = shoppingTotals(s, rows);
    expect(t.shortfalls.map((r) => r.materialId)).toEqual(['a']);
    expect(t.shortToBuy).toBe(5);
    expect(t.shortCost).toBe(4);
    expect(t.shortCostKnown).toBe(true);
    // b hat keinen Bestand, „ohne Material“ hat nie einen → Summe deckt den Einkauf NICHT ab
    expect(t.toBuyComplete).toBe(false);
    expect(t.shortTotalComplete).toBe(false);
    expect(t.shortCostComplete).toBe(false);
    for (const lang of ['de', 'en', 'tr'] as const) {
      const D = lang === 'en' ? ',' : ';';
      const csv = parseCsv(buildShoppingCsv(s, P, mats, lang), D);
      const sum = csv[csv.length - 1];
      expect(sum[col('toBuy')]).toBe('5');
      expect(sum[col('note')]).toContain(SHOPPING_CSV_TEXT[lang].toBuyIncomplete);
    }
    expect(SHOPPING_CSV_TEXT.de.toBuyIncomplete).toMatch(/^Zu kaufen unvollständig – Bestand nicht für alle Materialien erfasst/);
  });

  it('Bestand für jedes Material erfasst, alle Farben mit Material → vollständig, kein Hinweis', () => {
    const { L, d } = mosaic(2);
    const P = pal(['a', 'b']);
    // Farbe 0: 15 Steine, Farbe 1: 45. a: Fehlbestand 5 (Packung + Preis); b: Bestand reicht, ohne Preis → kostet nichts, macht nichts unvollständig
    const mats = [mat('a', { piecesPerPack: 10, price: 4, stock: 10 }), mat('b', { stock: 100 })];
    const s = computeStats(L, d, P, mats, OPTS0);
    const rows = shoppingRows(s, P, mats);
    const t = shoppingTotals(s, rows);
    expect(t.shortfalls.map((r) => r.materialId)).toEqual(['a']);
    expect(t.shortToBuy).toBe(5);
    expect(t.toBuyComplete).toBe(true);
    expect(t.shortTotalComplete).toBe(true);
    expect(t.shortCostComplete).toBe(true);
    const csv = parseCsv(buildShoppingCsv(s, P, mats, 'de'), ';');
    expect(csv[csv.length - 1][col('note')]).not.toContain(SHOPPING_CSV_TEXT.de.toBuyIncomplete);
  });

  it('kein Bestand erfasst → keine Summe „zu kaufen“ und kein Teilsummen-Hinweis (Spalte bleibt leer)', () => {
    const { L, d } = mosaic(2);
    const P = pal(['a', 'b']);
    const mats = [mat('a'), mat('b')];
    const s = computeStats(L, d, P, mats, OPTS0);
    const csv = parseCsv(buildShoppingCsv(s, P, mats, 'de'), ';');
    const sum = csv[csv.length - 1];
    expect(sum[col('toBuy')]).toBe('');
    expect(sum[col('note')]).not.toContain(SHOPPING_CSV_TEXT.de.toBuyIncomplete);
  });

  it('Fehlbestand ohne Preis: Kosten nicht bekannt, nicht als 0 ausgegeben', () => {
    const { L, d } = mosaic(1);
    const P = pal(['a']);
    const mats = [mat('a', { piecesPerPack: 10, stock: 50 })];
    const s = computeStats(L, d, P, mats, OPTS0);
    const t = shoppingTotals(s, shoppingRows(s, P, mats));
    expect(t.shortToBuy).toBe(10);
    expect(t.shortCostKnown).toBe(false);
    expect(t.shortCostComplete).toBe(false);
    expect(t.shortTotalComplete).toBe(true);
  });

  it('Banner-Texte: Teilsumme und Hinweis in allen Sprachen', () => {
    for (const lang of ['de', 'en', 'tr'] as const) {
      expect(dictionaries[lang]['w5fu.short.totalPartial' as keyof (typeof dictionaries)['de']]).toContain('{n}');
      expect(dictionaries[lang]['w5fu.short.partialNote' as keyof (typeof dictionaries)['de']]).toBeTruthy();
    }
  });
});

describe('Heller / Dunkler: nie im Widerspruch zu ▲/▼', () => {
  const build = (hexes: string[]) => {
    let p: PaletteColor[] = [];
    for (const h of hexes) p = addPaletteColor(p, h, undefined, 'de');
    return p;
  };
  const marked = (p: PaletteColor[], from: number, dir: 'lighter' | 'darker') =>
    p.map((_, i) => i).filter((i) => i !== from && (dir === 'lighter' ? p[i].lab[0] - p[from].lab[0] >= SHADE_MARK_DL : p[from].lab[0] - p[i].lab[0] >= SHADE_MARK_DL));

  it('gleicher Farbton vorhanden → wie shadeStep, sameHue', () => {
    const p = build(['#CFE2F3', '#9FC5F8', '#6FA8DC', '#3D85C6', '#0B5394', '#FFFFFF']);
    const mid = p.findIndex((x) => x.hex === '#6FA8DC');
    const up = shadeSuggest(p, mid, 'lighter')!;
    expect(up.sameHue).toBe(true);
    expect(up.index).toBe(shadeStep(p, mid, 'lighter')!.index);
  });

  it('kein hellerer Ton desselben Farbtons, aber hellere Farben (▲) → ähnlichste hellere, als anderer Farbton', () => {
    const p = build(['#CFE2F3', '#9FC5F8', '#FFFFFF', '#F4CCCC', '#000000']);
    const lightest = p.findIndex((x) => x.hex === '#CFE2F3');
    expect(shadeStep(p, lightest, 'lighter')).toBeNull();
    const ups = marked(p, lightest, 'lighter');
    expect(ups.length).toBeGreaterThan(0);
    const s = shadeSuggest(p, lightest, 'lighter')!;
    expect(s).not.toBeNull();
    expect(s.sameHue).toBe(false);
    expect(ups).toContain(s.index);
    expect(s.dL).toBeGreaterThanOrEqual(SHADE_MIN_DL);
    // ähnlichste (kleinstes ΔE) unter den deutlich helleren
    for (const i of ups) if (p[i].lab[0] - p[lightest].lab[0] >= SHADE_MIN_DL) expect(s.dE).toBeLessThanOrEqual(shadeSuggest([p[lightest], p[i]], 0, 'lighter')!.dE + 1e-9);
  });

  it('nur knapp hellere Farbe (1 ≤ ΔL* < 3) → trotzdem angeboten, weil sie ▲ trägt', () => {
    // Grau L* ≈ 50 und ein Grau, das nur ~2 L* heller ist
    const p = build(['#777777', '#7C7C7C']);
    const dl = p[1].lab[0] - p[0].lab[0];
    expect(dl).toBeGreaterThanOrEqual(SHADE_MARK_DL);
    expect(dl).toBeLessThan(SHADE_MIN_DL);
    const s = shadeSuggest(p, 0, 'lighter')!;
    expect(s.index).toBe(1);
    expect(s.sameHue).toBe(false);
  });

  it('null nur, wenn keine Farbe ▲ bzw. ▼ trägt (nie erfunden)', () => {
    const p = build(['#FFFFFF', '#2050C0', '#000000']);
    const white = p.findIndex((x) => x.hex === '#FFFFFF');
    const black = p.findIndex((x) => x.hex === '#000000');
    expect(marked(p, white, 'lighter')).toEqual([]);
    expect(shadeSuggest(p, white, 'lighter')).toBeNull();
    expect(marked(p, black, 'darker')).toEqual([]);
    expect(shadeSuggest(p, black, 'darker')).toBeNull();
    // für jede Farbe und Richtung: Vorschlag genau dann, wenn eine Farbe markiert ist – und dann eine markierte
    const big = build(['#CFE2F3', '#9FC5F8', '#6FA8DC', '#F4CCCC', '#EED7C7', '#68615D', '#B7B7B7', '#FFFFFF', '#000000', '#20A040']);
    for (let i = 0; i < big.length; i++)
      for (const dir of ['lighter', 'darker'] as const) {
        const m = marked(big, i, dir);
        const s = shadeSuggest(big, i, dir);
        expect(s === null).toBe(m.length === 0);
        if (s) expect(m).toContain(s.index);
      }
  });

  it('Hinweistexte und „etwas anderer Farbton“ in allen Sprachen', () => {
    for (const lang of ['de', 'en', 'tr'] as const) {
      const d = dictionaries[lang] as Record<string, string>;
      for (const k of ['w5fu.shade.otherHue', 'w5fu.shade.titleOther', 'w5fu.shade.noLighter', 'w5fu.shade.otherLighter', 'w5fu.shade.rule']) expect(d[k], `${lang} ${k}`).toBeTruthy();
    }
    expect((dictionaries.de as Record<string, string>)['w5fu.shade.otherHue']).toBe('etwas anderer Farbton');
  });
});
