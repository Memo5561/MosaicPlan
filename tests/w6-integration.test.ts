/**
 * Integration Welle 6 – Feinsteine (w6-fine-tiles) in den Teilen, die das Paket nicht selbst geändert hat:
 *  1. Koordinaten-CSV: Rohstein_mm = tatsächlich verwendetes Rohsteinmaß (Feinsteine: Feinstein-Maß).
 *  2. PDF und Materialansicht „Bedarf je Farbe“: Feinsteine mit eigenem Material und Bedarf; Σ = Rohsteine gesamt.
 *     „Rastermaß angenommen“ (*) nur für das Grundstein-Material einer Farbe.
 *  3. Hintergrund vereinfachen: Feinbereiche sind geschützt wie Gesichts- und Detailbereiche.
 *  4. Projektdatei: Feinstein-Materialien werden mit exportiert und beim Import zugeordnet (IDs umgeschrieben).
 */
import { inflateSync } from 'node:zlib';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { buildCsv } from '../src/core/csv';
import { setCellKind } from '../src/core/edits';
import { applyAdjustments } from '../src/core/imageOps';
import { computeLayout, computeSections, sectionsFor } from '../src/core/layout';
import { danglingMaterialRefs, referencedMaterialIds, remapPaletteMaterials } from '../src/core/materialImport';
import { DEFAULT_PDF_OPTIONS, generatePdfReport, type PdfInput } from '../src/core/pdf';
import { packMosaic } from '../src/core/serialize';
import { shoppingRows } from '../src/core/shoppingCsv';
import { colorNeedLines, computeStats, materialRowGridAssumed } from '../src/core/stats';
import { CellKind, createEmptyMosaic, DEFAULT_ADJUST, DEFAULT_SETTINGS, type Material, type PaletteColor, type Region } from '../src/core/types';
import { I18nContext, makeT, numberFormatter } from '../src/i18n';
import { de as extDe, en as extEn, tr as extTr } from '../src/i18n/ext/w6-integration';
import { paletteSignature, type ProjectRecord } from '../src/storage/db';
import { buildProjectExport, parseProjectFile, prepareProjectImport } from '../src/storage/projects';
import { PerColorTable } from '../src/ui/project/MaterialCalc';
import { computeKey } from '../src/ui/project/useProject';

function mat(id: string, w: number, extra: Partial<Material> = {}): Material {
  return {
    id,
    type: 'glass',
    manufacturer: 'Test',
    product: 'Glas',
    colorNumber: id.toUpperCase(),
    colorName: id,
    hex: '#808080',
    lengthMm: w,
    widthMm: w,
    thicknessMm: 4,
    price: 0,
    packageSize: '',
    piecesPerPack: 0,
    notes: '',
    ...extra,
  };
}

/**
 * 10 × 10 Raster (5-mm-Steine, 1 mm Fuge). Jede dritte Spalte als 2×2-Teilung: Teilsteine (5 + 1) / 2 − 1 = 2 mm.
 * Farbe 0 (Zeilen 0–3): Grundmaterial 5 × 5 + Feinstein-Material 2 × 2 → 16 Teilungen = 64 Feinsteine.
 * Farbe 1 (Zeilen 4–6): KEIN Grundmaterial (Rastermaß angenommen) + dasselbe Feinstein-Material → 48 Feinsteine.
 * Farbe 2 (Zeilen 7–9): Grundmaterial ohne Feinstein-Material → 48 Teilsteine aus dem Grundstein geschnitten.
 */
const LP = { widthMm: 59, heightMm: 59, tileW: 5, tileH: 5, joint: 1, edgeMode: 'whole' as const, minCutMm: 0 };
const layout = computeLayout(LP);
const data = createEmptyMosaic(layout.cols, layout.rows);
for (let row = 0; row < layout.rows; row++)
  for (let col = 0; col < layout.cols; col++) {
    const idx = row * layout.cols + col;
    data.kind[idx] = CellKind.FULL;
    data.c1[idx] = row < 4 ? 0 : row < 7 ? 1 : 2;
    data.c2[idx] = data.c1[idx];
    if (col % 3 === 0 && setCellKind(layout, data, row, col, { kind: CellKind.SUB, k: 2 }, 1)) throw new Error('Teilung abgelehnt');
  }
const MATS: Material[] = [
  mat('base-a', 5, { piecesPerPack: 100, price: 2 }),
  mat('fine-a', 2, { piecesPerPack: 50, price: 1, colorName: 'fein' }),
  mat('base-c', 5, { piecesPerPack: 100, price: 3 }),
];
const pc = (code: number, hex: string, extra: Partial<PaletteColor> = {}): PaletteColor => ({ code, hex, lab: hexToLab(hex), name: `F${code}`, userNamed: true, ...extra });
const FINE_PAL: PaletteColor[] = [pc(1, '#2050C0', { materialId: 'base-a', fineMaterialId: 'fine-a' }), pc(2, '#C02020', { fineMaterialId: 'fine-a' }), pc(3, '#20A040', { materialId: 'base-c' })];
const PLAIN_PAL: PaletteColor[] = FINE_PAL.map(({ fineMaterialId: _f, ...p }) => p);
const OPTS = { reservePct: 10, groutDepthMm: 3 };

describe('Integration w6: Bedarf je Farbe mit Feinsteinen (Zahlen)', () => {
  const st = computeStats(layout, data, FINE_PAL, MATS, OPTS);

  it('Feinsteine exakt gezählt; Bedarfszeilen je Farbe summieren sich zu Rohsteinen gesamt', () => {
    expect(st.perColor.map((c) => c.fine?.pieces ?? 0)).toEqual([64, 48, 0]);
    expect(st.perColor.map((c) => c.fine?.rawWithReserve ?? 0)).toEqual([71, 53, 0]);
    // Grundsteine: Farbe 0 hat 24 ganze Steine 5 × 5 (= Materialmaß, ungeschnitten), Farbe 1 18 ganze Steine
    expect(st.perColor[0].raw).toBe(24);
    expect(st.perColor[1].raw).toBe(18);
    const lines = st.perColor.flatMap(colorNeedLines);
    expect(lines.map((l) => [l.color, l.fine, l.material?.id ?? null, l.pieces, l.raw])).toEqual([
      [0, false, 'base-a', 24, 24],
      [0, true, 'fine-a', 64, 64],
      [1, false, null, 18, 18],
      [1, true, 'fine-a', 48, 48],
      [2, false, 'base-c', 18 + 48, st.perColor[2].raw],
    ]);
    expect(lines.reduce((a, l) => a + l.raw, 0)).toBe(st.rawTotal);
    expect(lines.reduce((a, l) => a + l.rawWithReserve, 0)).toBe(st.rawWithReserveTotal);
    expect(lines.reduce((a, l) => a + l.pieces, 0)).toBe(st.pieces);
    // Feinsteine nie geschnitten, nie Rastermaß angenommen
    for (const l of lines.filter((x) => x.fine)) expect([l.cut, l.rawAssumedGrid, l.rawW, l.rawH]).toEqual([0, false, 2, 2]);
    expect(lines[2].rawAssumedGrid).toBe(true);
  });

  it('nur Feinsteine einer Farbe: keine leere Grundstein-Zeile', () => {
    const only = createEmptyMosaic(layout.cols, layout.rows);
    for (let i = 0; i < only.kind.length; i++) {
      only.kind[i] = CellKind.FULL;
      only.c1[i] = i < 10 ? 0 : 2;
    }
    for (let col = 0; col < layout.cols; col++) setCellKind(layout, only, 0, col, { kind: CellKind.SUB, k: 2 }, 1);
    const s = computeStats(layout, only, FINE_PAL, MATS, OPTS);
    const lines = colorNeedLines(s.perColor[0]);
    expect(lines.map((l) => [l.fine, l.pieces])).toEqual([[true, 40]]);
    expect(s.perColor.flatMap(colorNeedLines).reduce((a, l) => a + l.rawWithReserve, 0)).toBe(s.rawWithReserveTotal);
  });

  it('„Rastermaß angenommen“ nur beim Grundstein-Material: Feinstein-Zeile ohne *, „ohne Material“ mit *', () => {
    const fineRow = st.perMaterial.find((m) => m.materialId === 'fine-a')!;
    expect(fineRow.colors).toEqual([0, 1]);
    // vorher (PDF): jede Farbe der Zeile mit angenommenem Rastermaß – Farbe 1 hat kein Grundmaterial
    expect(fineRow.colors.some((c) => st.perColor[c].rawAssumedGrid)).toBe(true);
    expect(materialRowGridAssumed(fineRow, st.perColor)).toBe(false);
    const none = st.perMaterial.find((m) => m.materialId === null)!;
    expect(none.colors).toEqual([1]);
    expect(materialRowGridAssumed(none, st.perColor)).toBe(true);
    expect(materialRowGridAssumed(st.perMaterial.find((m) => m.materialId === 'base-a')!, st.perColor)).toBe(false);
    // Einkaufsliste (CSV/Materialansicht) und PDF verwenden dieselbe Regel
    for (const r of shoppingRows(st, FINE_PAL, MATS)) expect(r.rawAssumedGrid).toBe(materialRowGridAssumed(r, st.perColor));
  });

  it('Materialansicht: Feinstein-Material und „+ N Fein“ je Farbe, Summenzeile = Rohsteine inkl. Reserve', () => {
    const html = renderToStaticMarkup(
      createElement(I18nContext.Provider, { value: { lang: 'de', t: makeT('de'), setLang: () => {}, n: numberFormatter('de') } }, createElement(PerColorTable, { st, pal: FINE_PAL, phone: false })),
    );
    expect(html.match(/data-testid="mc-color-row"/g)).toHaveLength(3);
    expect(html).toContain('data-fine-raw="64" data-fine-reserve="71"');
    expect(html).toContain('data-fine-raw="48" data-fine-reserve="53"');
    expect(html).toContain('+ 71 Fein');
    expect(html).toContain('+ 64 Fein');
    expect(html).toContain('+ 53 Fein');
    expect(html.match(/data-testid="mc-color-fine-mat"/g)).toHaveLength(2);
    expect(html).toContain('+ Feinstein: Test Glas FINE-A · 2 × 2 mm');
    const sumRes = Number(/data-testid="mc-color-sum-reserve"><b>([\d.]+)<\/b>/.exec(html)![1].replace(/\./g, ''));
    const sumRaw = Number(/data-testid="mc-color-sum-raw">([\d.]+)</.exec(html)![1].replace(/\./g, ''));
    expect(sumRes).toBe(st.rawWithReserveTotal);
    expect(sumRaw).toBe(st.rawTotal);
    // ohne Feinstein-Material: keine Feinstein-Angaben
    const plain = renderToStaticMarkup(createElement(PerColorTable, { st: computeStats(layout, data, PLAIN_PAL, MATS, OPTS), pal: PLAIN_PAL, phone: false }));
    expect(plain).not.toContain('data-fine-raw');
    expect(plain).not.toContain('w6ft-need');
  });
});

describe('Integration w6: Koordinaten-CSV mit Feinsteinen', () => {
  const grid = sectionsFor(layout, DEFAULT_SETTINGS);
  const rowsOf = (csv: string) => csv.split('\r\n').slice(1).map((l) => l.split(';'));
  const ZU = 14;
  const RAW = 15;

  it('Rohstein_mm: Feinsteine 2 × 2 mm (ungeschnitten), alles andere wie ohne Feinstein-Material', () => {
    const fine = rowsOf(buildCsv(layout, data, FINE_PAL, MATS, grid, null));
    const plain = rowsOf(buildCsv(layout, data, PLAIN_PAL, MATS, grid, null));
    expect(fine.length).toBe(plain.length);
    expect(fine.length).toBe(computeStats(layout, data, FINE_PAL, MATS, OPTS).pieces);
    const fineRows = fine.filter((r) => r[RAW] === '2,00x2,00');
    expect(fineRows.length).toBe(64 + 48);
    for (const r of fineRows) expect(r[ZU]).toBe('nein');
    // ohne Feinstein-Material: überall der Grundstein (bzw. das Rastermaß) – unverändert wie vor Welle 6
    expect(plain.every((r) => r[RAW] === '5,00x5,00')).toBe(true);
    fine.forEach((r, i) => {
      const p = plain[i];
      // Position, Maße, Farbe, Form, Verlegt, Kontur unverändert
      expect([...r.slice(0, ZU), ...r.slice(RAW + 1)]).toEqual([...p.slice(0, ZU), ...p.slice(RAW + 1)]);
      if (r[RAW] !== '2,00x2,00') expect(r[RAW]).toBe(p[RAW]);
      else expect(p[ZU]).toMatch(/^ja \(T\d+\)$/); // vorher aus dem 5-mm-Grundstein geschnitten
    });
    // Farbe 2 (ohne Feinstein-Material): Teilsteine weiter aus dem Grundstein geschnitten
    const c2sub = fine.filter((r) => r[10] === '03' && r[4] !== '1');
    expect(c2sub.length).toBe(36);
    for (const r of c2sub) expect([r[RAW], /^ja \(T\d+\)$/.test(r[ZU])]).toEqual(['5,00x5,00', true]);
    // Punkt statt Komma (en)
    expect(rowsOf(buildCsv(layout, data, FINE_PAL, MATS, grid, null, false)).filter((r) => r[RAW] === '2.00x2.00').length).toBe(112);
  });
});

// ---------------------------------------------------------------- PDF-Text (Standardschrift)
function pdfText(buf: ArrayBuffer): string {
  const s = Buffer.from(buf).toString('latin1');
  const out: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const len = Number(s.slice(Math.max(0, m.index - 200), m.index).match(/\/Length (\d+)(?![\s\S]*\/Length)/)?.[1]);
    const end = Number.isFinite(len) ? start + len : s.indexOf('endstream', start);
    if (end < 0) break;
    const raw = Buffer.from(s.slice(start, end), 'latin1');
    let txt: string;
    try {
      txt = inflateSync(raw).toString('latin1');
    } catch {
      txt = raw.toString('latin1');
    }
    for (const t of txt.replace(/\u0000/g, '').matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(t[1].replace(/\\(.)/g, '$1'));
    re.lastIndex = end + 9;
  }
  return out.join('\n');
}

describe('Integration w6: PDF mit Feinsteinen', () => {
  it('Farblegende „24 + 64 Fein“, Bedarf je Farbe mit eigener Feinstein-Zeile', async () => {
    const settings = { ...DEFAULT_SETTINGS, ...LP, reservePct: 10, sectionWmm: 300, sectionHmm: 300 };
    const input: PdfInput = {
      projectName: 'Fein',
      dateStr: '11.11.2026',
      layout,
      data,
      palette: FINE_PAL,
      materials: MATS,
      settings,
      sections: computeSections(layout, 300, 300),
      t: makeT('de'),
      locale: 'de',
    };
    const opts = { ...DEFAULT_PDF_OPTIONS, includeImages: false, includeTemplates: false, includeCoords: false };
    const txt = pdfText((await generatePdfReport(input, opts)).pdf);
    // Farblegende: Rohsteine und inkl. Reserve, Grundstein + Feinsteine
    expect(txt).toContain('24 + 64 Fein');
    expect(txt).toContain('27 + 71 Fein');
    expect(txt).toContain('18 + 48 Fein');
    expect(txt).toContain('20 + 53 Fein');
    // Bedarf je Farbe: je Farbe mit Feinsteinen eine eigene Zeile
    expect(txt.match(/Feinsteine/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    const plain = pdfText((await generatePdfReport({ ...input, palette: PLAIN_PAL }, opts)).pdf);
    expect(plain).not.toMatch(/\d \+ \d+ Fein/);
    expect(plain).not.toContain('Feinsteine');
  });
});

describe('Integration w6: Hintergrund vereinfachen schützt Feinbereiche', () => {
  it('Feinbereich wirkt genau wie ein Gesichtsbereich gleicher Form; ohne Schutz ändert sich der Bereich', () => {
    const W = 64;
    const H = 64;
    const img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        // Rand: hartes Schachbrett (viel Detail), Mitte: weiche Wellen (wenig Detail → würde vereinfacht)
        const edge = x < 12 || y < 12 || x >= W - 12 || y >= H - 12;
        const v = edge ? (((x >> 1) + (y >> 1)) % 2 ? 255 : 0) : 128 + Math.round(20 * Math.sin((2 * Math.PI * x) / 12) * Math.cos((2 * Math.PI * y) / 12));
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    const adj = { ...DEFAULT_ADJUST, bgSimplify: 100 };
    const area = { id: 'r', shape: 'rect' as const, x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    const fine = applyAdjustments(img, adj, [{ ...area, type: 'fine' } as Region]);
    const face = applyAdjustments(img, adj, [{ ...area, type: 'face' } as Region]);
    const none = applyAdjustments(img, adj, []);
    expect(Array.from(fine.data)).toEqual(Array.from(face.data));
    // Mitte des Bereichs: mit Schutz unverändert, ohne Schutz vereinfacht
    const c = (32 * W + 32) * 4;
    let changedNone = 0;
    let changedFine = 0;
    for (let y = 26; y < 38; y++)
      for (let x = 26; x < 38; x++) {
        const i = (y * W + x) * 4;
        for (let k = 0; k < 3; k++) {
          if (none.data[i + k] !== img.data[i + k]) changedNone++;
          if (fine.data[i + k] !== img.data[i + k]) changedFine++;
        }
      }
    expect(changedNone).toBeGreaterThan(0);
    expect(changedFine).toBe(0);
    expect(fine.data[c + 3]).toBe(255);
  });
});

describe('Integration w6: Projektdatei mit Feinstein-Material', () => {
  it('referencedMaterialIds / remapPaletteMaterials / danglingMaterialRefs beachten fineMaterialId', () => {
    expect(referencedMaterialIds(FINE_PAL, [])).toEqual(['base-a', 'base-c', 'fine-a']);
    expect(referencedMaterialIds(PLAIN_PAL, ['x'])).toEqual(['base-a', 'base-c', 'x']);
    const out = remapPaletteMaterials(FINE_PAL, { 'fine-a': 'L-fine', 'base-c': 'base-c' });
    expect(out.map((p) => [p.materialId, p.fineMaterialId])).toEqual([
      ['base-a', 'L-fine'],
      [undefined, 'L-fine'],
      ['base-c', undefined],
    ]);
    expect(out[2]).toBe(FINE_PAL[2]);
    expect('materialId' in out[1]).toBe(false);
    expect(danglingMaterialRefs(FINE_PAL, [], new Set(['base-a', 'base-c']))).toEqual({ colors: 2, selected: 0 });
    expect(danglingMaterialRefs(FINE_PAL, [], new Set(['base-a', 'base-c', 'fine-a']))).toEqual({ colors: 0, selected: 0 });
  });

  function record(palette: PaletteColor[]): ProjectRecord {
    const rec: ProjectRecord = {
      meta: { id: 'src', name: 'Fein', createdAt: 1, updatedAt: 2, computed: true },
      settings: { ...DEFAULT_SETTINGS, shapes: { ...DEFAULT_SETTINGS.shapes }, ...LP, reservePct: 10 },
      adjust: { ...DEFAULT_ADJUST },
      regions: [],
      palette,
      mosaicRev: 'rev-1',
      computedPaletteSig: paletteSignature(palette),
    };
    rec.computedWith = computeKey(rec);
    return rec;
  }

  async function roundTrip(materials: Material[]) {
    const rec = record(FINE_PAL);
    const mosaic = { ...packMosaic(data), rev: 'rev-1' };
    const blob = await buildProjectExport(rec, null, mosaic, new Uint16Array(data.kind.length), [...materials, mat('unused', 7)]);
    return { rec, parsed: parseProjectFile(await blob.text()) };
  }

  it('Rundreise in einen leeren Bestand: Feinstein-Material mit exportiert und angelegt, Bedarf wie auf Gerät A', async () => {
    const { rec, parsed } = await roundTrip(MATS);
    expect((parsed.materials as Material[]).map((m) => m.id)).toEqual(['base-a', 'base-c', 'fine-a']);
    const prep = prepareProjectImport(parsed, [], [], { id: 'new', now: 9 });
    expect(prep.inserts.map((m) => m.id)).toEqual(['base-a', 'base-c', 'fine-a']);
    expect(prep.summary.missing).toEqual({ colors: 0, selected: 0 });
    expect(prep.summary.refs.colors).toBe(3);
    expect(prep.rec.palette.map((p) => p.fineMaterialId)).toEqual(['fine-a', 'fine-a', undefined]);
    const a = computeStats(layout, data, rec.palette, MATS, OPTS);
    const b = computeStats(layout, data, prep.rec.palette, prep.inserts, OPTS);
    expect(b.perColor.map((c) => c.fine?.rawWithReserve ?? 0)).toEqual(a.perColor.map((c) => c.fine?.rawWithReserve ?? 0));
    expect(b.rawWithReserveTotal).toBe(a.rawWithReserveTotal);
    expect(b.totalCost).toBe(a.totalCost);
    // Gegenprobe: ohne Feinstein-Material im Bestand fielen die Teilsteine auf den Grundstein zurück
    const lost = computeStats(layout, data, prep.rec.palette, prep.inserts.filter((m) => m.id !== 'fine-a'), OPTS);
    expect(lost.perColor.every((c) => !c.fine)).toBe(true);
    expect(lost.rawWithReserveTotal).not.toBe(a.rawWithReserveTotal);
  });

  it('Feinstein-Material schon vorhanden (andere ID): fineMaterialId umgeschrieben, nichts doppelt angelegt', async () => {
    const { rec, parsed } = await roundTrip(MATS);
    const local = [{ ...MATS[1], id: 'b-own-fine' }];
    const prep = prepareProjectImport(parsed, local, [], { id: 'new', now: 9 });
    expect(prep.inserts.map((m) => m.id)).toEqual(['base-a', 'base-c']);
    expect(prep.summary.materials).toEqual({ inserted: 2, linked: 1, differing: 0 });
    expect(prep.rec.palette.map((p) => [p.materialId, p.fineMaterialId])).toEqual([
      ['base-a', 'b-own-fine'],
      [undefined, 'b-own-fine'],
      ['base-c', undefined],
    ]);
    expect(prep.summary.missing).toEqual({ colors: 0, selected: 0 });
    // Projekt bleibt aktuell
    expect(computeKey(prep.rec)).toBe(prep.rec.computedWith);
    // Quelle unverändert
    expect(parsed.record.palette.map((p) => p.fineMaterialId)).toEqual(['fine-a', 'fine-a', undefined]);
    const a = computeStats(layout, data, rec.palette, MATS, OPTS);
    const b = computeStats(layout, data, prep.rec.palette, [...local, ...prep.inserts], OPTS);
    expect(b.perMaterial.find((m) => m.materialId === 'b-own-fine')?.need).toBe(a.perMaterial.find((m) => m.materialId === 'fine-a')?.need);
    expect(b.rawWithReserveTotal).toBe(a.rawWithReserveTotal);
  });

  it('Datei ohne das Feinstein-Material: als fehlend gemeldet', async () => {
    const { parsed } = await roundTrip(MATS.filter((m) => m.id !== 'fine-a'));
    const prep = prepareProjectImport(parsed, [], [], { id: 'new', now: 9 });
    expect(prep.summary.missing).toEqual({ colors: 2, selected: 0 });
  });
});

describe('Integration w6: Texte', () => {
  it('de/en/tr mit denselben Schlüsseln und Platzhaltern', () => {
    const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    expect(Object.keys(extEn).sort()).toEqual(Object.keys(extDe).sort());
    expect(Object.keys(extTr).sort()).toEqual(Object.keys(extDe).sort());
    for (const k of Object.keys(extDe)) {
      expect(ph(extEn[k]), k).toEqual(ph(extDe[k]));
      expect(ph(extTr[k]), k).toEqual(ph(extDe[k]));
    }
  });
});
