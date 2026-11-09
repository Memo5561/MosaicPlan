/**
 * Einkaufsliste je Material (w5-material-shopping): Zeilen, Summen und CSV-Export.
 * Alle Werte müssen exakt aus stats.perMaterial kommen – Σ Bedarf = rawWithReserveTotal, Σ Kosten = totalCost,
 * ein Material für zwei Farben ist EINE Zeile, nichts wird geschätzt.
 */
import { describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { computeLayout, type LayoutParams } from '../src/core/layout';
import { buildShoppingCsv, formatMoney, SHOPPING_CSV_COLUMNS, shoppingRowNotes, shoppingRows, shoppingTotals } from '../src/core/shoppingCsv';
import { computeStats } from '../src/core/stats';
import { CellKind, createEmptyMosaic, type Material, type MosaicData, type PaletteColor } from '../src/core/types';

const OPTS0 = { reservePct: 0, groutDepthMm: 3 };
const OPTS10 = { reservePct: 10, groutDepthMm: 3 };

function pal(n: number, materialIds: (string | undefined)[] = []): PaletteColor[] {
  const hexes = ['#FFFFFF', '#2050C0', '#C02020', '#20A040', '#000000', '#808080'];
  return Array.from({ length: n }, (_, i) => ({
    code: i + 1,
    hex: hexes[i % hexes.length],
    name: `F${i + 1}`,
    lab: hexToLab(hexes[i % hexes.length]),
    materialId: materialIds[i],
  }));
}

function mat(id: string, over: Partial<Material> = {}): Material {
  return {
    id,
    type: 'glass',
    manufacturer: 'Test',
    product: 'Glas',
    colorNumber: id,
    colorName: id,
    hex: '#2050C0',
    lengthMm: 5,
    widthMm: 5,
    thicknessMm: 4,
    price: 0,
    packageSize: '',
    piecesPerPack: 0,
    ...over,
  };
}

function lp(cols: number, rows: number, tileW: number, tileH: number, joint: number): LayoutParams {
  return { widthMm: cols * tileW + (cols - 1) * joint, heightMm: rows * tileH + (rows - 1) * joint, tileW, tileH, joint, edgeMode: 'whole', minCutMm: 1 };
}

/** 10 × 6 Steine, Farbe 0 und Farbe 1 je 30 ganze Steine */
function twoBy30(): { L: ReturnType<typeof computeLayout>; d: MosaicData } {
  const L = computeLayout(lp(10, 6, 5, 5, 1));
  const d = createEmptyMosaic(10, 6);
  for (let i = 30; i < 60; i++) d.c1[i] = 1;
  return { L, d };
}

function mixedMosaic(L: ReturnType<typeof computeLayout>, colors: number, seed = 3): MosaicData {
  const d = createEmptyMosaic(L.cols, L.rows);
  let x = seed;
  const rnd = () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const c = () => Math.floor(rnd() * colors);
  for (let i = 0; i < L.cols * L.rows; i++) {
    d.c1[i] = c();
    const m = rnd();
    if (m < 0.2) {
      d.kind[i] = CellKind.DIAG_A;
      d.c2[i] = c();
    } else if (m < 0.35) {
      d.kind[i] = CellKind.DIAG_B;
      d.c2[i] = c();
    } else if (m < 0.5) {
      d.kind[i] = CellKind.LINE;
      const a = Math.floor(rnd() * 12) * (Math.PI / 12);
      d.line.set(i, new Float32Array([Math.cos(a), Math.sin(a), Math.round(rnd() * 4 - 2) / 2]));
      d.c2[i] = c();
    } else if (m < 0.6) {
      d.kind[i] = CellKind.SUB;
      d.sub.set(i, new Uint16Array([c(), c(), c(), c()]));
    }
  }
  return d;
}

/** Minimaler CSV-Leser (Anführungszeichen, verdoppelte "", beliebiges Trennzeichen) */
function parseCsv(text: string, delim: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') continue;
    else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const deNum = (s: string) => (s === '' ? NaN : Number(s.replace(',', '.')));
const col = (name: (typeof SHOPPING_CSV_COLUMNS)[number]) => SHOPPING_CSV_COLUMNS.indexOf(name);

describe('Einkaufsliste je Material (Zeilen und Summen)', () => {
  it('Fixture 100/50: ein gemeinsames Material für zwei Farben (30 + 30) ist EINE Zeile mit 1 Packung und 10 zu kaufen', () => {
    const { L, d } = twoBy30();
    const M = mat('m1', { piecesPerPack: 100, stock: 50, price: 12.5, packageSize: 'Beutel 100' });
    const s = computeStats(L, d, pal(2, ['m1', 'm1']), [M], OPTS0);
    const rows = shoppingRows(s, pal(2, ['m1', 'm1']), [M]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.materialId).toBe('m1');
    expect(r.codes).toEqual(['01', '02']);
    expect(r.need).toBe(60);
    expect(r.stock).toBe(50);
    expect(r.toBuy).toBe(10);
    expect(r.packs).toBe(1); // nicht 2 (je Farbe eine Packung)
    expect(r.packsToBuy).toBe(1);
    expect(r.cost).toBeCloseTo(12.5, 9);
    expect(r.buyCost).toBeCloseTo(12.5, 9);
    expect(r.short).toBe(true);
    expect(r.packageSize).toBe('Beutel 100');
    const t = shoppingTotals(s, rows);
    expect(t.need).toBe(s.rawWithReserveTotal);
    expect(t.cost).toBeCloseTo(s.totalCost, 9);
    expect(t.shortfalls.map((x) => x.materialId)).toEqual(['m1']);
    expect(t.toBuy).toBe(10);
    expect(t.shortPacks).toBe(1);
    expect(t.toBuyComplete).toBe(true);
    expect(t.buyCostComplete).toBe(true);

    // CSV: eine Materialzeile mit 1 Packung, dazu die Summenzeile
    const csv = buildShoppingCsv(s, pal(2, ['m1', 'm1']), [M], 'de');
    const lines = parseCsv(csv, ';');
    expect(lines).toHaveLength(3); // Kopf, Material, Summe
    const row = lines[1];
    expect(row[col('colors')]).toBe('01, 02');
    expect(deNum(row[col('need')])).toBe(60);
    expect(deNum(row[col('stock')])).toBe(50);
    expect(deNum(row[col('toBuy')])).toBe(10);
    expect(deNum(row[col('packs')])).toBe(1);
    expect(deNum(row[col('packsToBuy')])).toBe(1);
    expect(row[col('cost')]).toBe('12,50');
    expect(row[col('buyCost')]).toBe('12,50');
  });

  it('Bestand 0 zählt als erfasst; ohne Bestand bleibt „zu kaufen“ leer (nicht angenommen)', () => {
    const { L, d } = twoBy30();
    const P = pal(2, ['a', 'b']);
    const mats = [mat('a', { piecesPerPack: 25, price: 2, stock: 0 }), mat('b', { piecesPerPack: 25, price: 2 })];
    const s = computeStats(L, d, P, mats, OPTS0);
    const rows = shoppingRows(s, P, mats);
    const a = rows.find((r) => r.materialId === 'a')!;
    const b = rows.find((r) => r.materialId === 'b')!;
    expect(a.toBuy).toBe(30);
    expect(a.packsToBuy).toBe(2);
    expect(a.buyCost).toBe(4);
    expect(b.stock).toBeUndefined();
    expect(b.toBuy).toBeUndefined();
    expect(b.packsToBuy).toBeUndefined();
    expect(b.buyCost).toBeUndefined();
    expect(b.packs).toBe(2);
    expect(b.cost).toBe(4);
    const t = shoppingTotals(s, rows);
    expect(t.toBuyComplete).toBe(false);
    expect(t.buyCostComplete).toBe(false);
    expect(t.stockRecorded).toBe(1);
    expect(t.toBuy).toBe(30);
    const csv = parseCsv(buildShoppingCsv(s, P, mats, 'de'), ';');
    const rb = csv.find((r) => r[col('colorNumber')] === 'b')!;
    expect(rb[col('toBuy')]).toBe('');
    expect(rb[col('packsToBuy')]).toBe('');
    expect(rb[col('note')]).toMatch(/Bestand nicht erfasst/);
    const sum = csv[csv.length - 1];
    expect(sum[col('note')]).toMatch(/Einkaufskosten unvollständig/);
  });

  it('ohne Packungsgröße oder Preis: keine Packungen/Kosten (leer, nie geschätzt), Kosten unvollständig', () => {
    const { L, d } = twoBy30();
    const P = pal(2, ['a', 'b']);
    const mats = [mat('a', { piecesPerPack: 0, price: 5 }), mat('b', { piecesPerPack: 100, price: 0 })];
    const s = computeStats(L, d, P, mats, OPTS0);
    const rows = shoppingRows(s, P, mats);
    expect(rows.find((r) => r.materialId === 'a')!.packs).toBeUndefined();
    expect(rows.find((r) => r.materialId === 'a')!.cost).toBeUndefined();
    expect(rows.find((r) => r.materialId === 'b')!.packs).toBe(1);
    expect(rows.find((r) => r.materialId === 'b')!.cost).toBeUndefined();
    expect(s.costComplete).toBe(false);
    const csv = parseCsv(buildShoppingCsv(s, P, mats, 'de'), ';');
    const ra = csv.find((r) => r[col('colorNumber')] === 'a')!;
    expect(ra[col('packs')]).toBe('');
    expect(ra[col('cost')]).toBe('');
    expect(ra[col('note')]).toMatch(/Stück je Packung nicht erfasst/);
    const rb = csv.find((r) => r[col('colorNumber')] === 'b')!;
    expect(rb[col('note')]).toMatch(/Preis nicht erfasst/);
    const sum = csv[csv.length - 1];
    // keine einzige Kostenangabe → Summe leer statt 0
    expect(sum[col('cost')]).toBe('');
    expect(sum[col('note')]).toMatch(/Kosten unvollständig/);
  });

  it('„ohne Material“: fehlende und nicht zugeordnete Materialien getrennt benannt, Rastermaß angenommen', () => {
    const { L, d } = twoBy30();
    for (let i = 0; i < 10; i++) d.c1[i] = 2;
    const P = pal(3, ['geloescht', undefined, 'ok']);
    const mats = [mat('ok', { piecesPerPack: 100, price: 1, stock: 500 })];
    const s = computeStats(L, d, P, mats, OPTS0);
    const rows = shoppingRows(s, P, mats);
    const none = rows[rows.length - 1];
    expect(none.materialId).toBeNull();
    expect(none.missingColors).toEqual([0]);
    expect(none.unlinkedColors).toEqual([1]);
    expect(none.rawAssumedGrid).toBe(true);
    expect(none.packs).toBeUndefined();
    const notes = shoppingRowNotes(none, 'de', P).join(' · ');
    expect(notes).toMatch(/Material fehlt .* Farbe 01/);
    expect(notes).toMatch(/kein Material zugeordnet bei Farbe 02/);
    expect(notes).toMatch(/Rastermaß angenommen/);
    const ok = rows.find((r) => r.materialId === 'ok')!;
    expect(ok.short).toBe(false);
    expect(ok.toBuy).toBe(0);
    expect(ok.packsToBuy).toBe(0);
    expect(ok.buyCost).toBe(0);
    const t = shoppingTotals(s, rows);
    expect(t.shortfalls).toHaveLength(0);
    expect(t.need).toBe(s.rawWithReserveTotal);
    expect(t.toBuyComplete).toBe(false); // „ohne Material“ hat keinen Bestand
  });

  it('CSV-Summen = rawWithReserveTotal und totalCost (gemischtes Mosaik, Reserve 10 %, gemeinsames Material, ohne Material)', () => {
    const L = computeLayout({ widthMm: 203, heightMm: 151, tileW: 6, tileH: 4, joint: 1.5, edgeMode: 'cut-end', minCutMm: 1.5 });
    const d = mixedMosaic(L, 6, 11);
    const P = pal(6, ['a', 'b', 'a', 'c', undefined, 'b']);
    const mats = [
      mat('a', { lengthMm: 4, widthMm: 6, piecesPerPack: 250, price: 9.9, stock: 120 }),
      mat('b', { lengthMm: 8, widthMm: 12, piecesPerPack: 40, price: 3, stock: 0 }),
      mat('c', { lengthMm: 4, widthMm: 6, piecesPerPack: 1000, price: 0.35 }),
    ];
    const s = computeStats(L, d, P, mats, OPTS10);
    for (const lang of ['de', 'tr', 'en'] as const) {
      const delim = lang === 'en' ? ',' : ';';
      const num = lang === 'en' ? (x: string) => (x === '' ? NaN : Number(x)) : deNum;
      const text = buildShoppingCsv(s, P, mats, lang);
      expect(text.startsWith('﻿')).toBe(true);
      expect(text.endsWith('\r\n')).toBe(true);
      const csv = parseCsv(text, delim);
      expect(csv.every((r) => r.length === SHOPPING_CSV_COLUMNS.length)).toBe(true);
      const body = csv.slice(1, -1);
      const sum = csv[csv.length - 1];
      expect(body).toHaveLength(s.perMaterial.length); // a, b, c, ohne Material
      // Summenzeile = Statistik
      expect(num(sum[col('need')])).toBe(s.rawWithReserveTotal);
      expect(num(sum[col('cost')])).toBeCloseTo(Math.round(s.totalCost * 100) / 100, 9);
      expect(num(sum[col('raw')])).toBe(s.rawTotal);
      // Σ Zeilen = Summenzeile
      expect(body.reduce((a, r) => a + num(r[col('need')]), 0)).toBe(s.rawWithReserveTotal);
      expect(body.reduce((a, r) => a + (r[col('cost')] === '' ? 0 : num(r[col('cost')])), 0)).toBeCloseTo(s.totalCost, 6);
      expect(body.reduce((a, r) => a + num(r[col('pieces')]), 0)).toBe(s.pieces - s.invalidColorPieces);
      // Kopf mit Reserve
      expect(csv[0][col('need')]).toMatch(/10/);
    }
    // Dezimalkomma außer Englisch
    const de = parseCsv(buildShoppingCsv(s, P, mats, 'de'), ';');
    const en = parseCsv(buildShoppingCsv(s, P, mats, 'en'), ',');
    const ra = (rows: string[][]) => rows.find((r) => r[col('colorNumber')] === 'a')!;
    expect(ra(de)[col('price')]).toBe('9,9');
    expect(ra(en)[col('price')]).toBe('9.9');
    expect(ra(de)[col('cost')]).toMatch(/^\d+,\d\d$/);
    expect(ra(en)[col('cost')]).toMatch(/^\d+\.\d\d$/);
    expect(ra(de)[col('type')]).toBe('Glas');
  });

  it('Texte mit Trennzeichen oder Anführungszeichen werden verlustfrei gequotet', () => {
    const { L, d } = twoBy30();
    const P = pal(2, ['q', 'q']);
    const mats = [mat('q', { manufacturer: 'Firma; "Glas" & Co', product: 'A,B', piecesPerPack: 10, price: 1 })];
    const s = computeStats(L, d, P, mats, OPTS0);
    const de = parseCsv(buildShoppingCsv(s, P, mats, 'de'), ';');
    expect(de[1][col('manufacturer')]).toBe('Firma; "Glas" & Co');
    expect(de[1][col('product')]).toBe('A,B');
    const en = parseCsv(buildShoppingCsv(s, P, mats, 'en'), ',');
    expect(en[1][col('product')]).toBe('A,B');
    expect(en[1][col('colors')]).toBe('01, 02');
  });

  it('Beträge mit genau zwei Nachkommastellen, ohne Währungszeichen', () => {
    expect(formatMoney(7.5, 'de')).toBe('7,50');
    expect(formatMoney(1234.5, 'de')).toBe('1.234,50');
    expect(formatMoney(7.5, 'en')).toBe('7.50');
    expect(formatMoney(0, 'tr')).toBe('0,00');
    expect(formatMoney(NaN, 'de')).toBe('–');
  });
});
