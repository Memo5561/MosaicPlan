/**
 * Korrekturen Welle 6 (Daten): Verlauf mit Feinstein-Material, PDF-Kennung mit Feinstein-Materialien, veraltete
 * Farbherkunft beim CSV-Reimport, „2×2 Blätter“ aus dem Raster, Feinbereiche an gekürzten Randsteinen, übersetzte
 * Koordinaten-CSV.
 */
import { describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { buildCsv, COORD_CSV_TEXT, CSV_HEADER } from '../src/core/csv';
import { bbox } from '../src/core/geometry';
import { classifyPaletteChange, EditJournal, paletteEntryFrom, paletteEntryKey } from '../src/core/journal';
import { computeLayout, sectionsFor, type Layout } from '../src/core/layout';
import { paletteMaterials } from '../src/core/materialImport';
import { materialsToCsv, parseMaterialsCsv, planMaterialImport, type MaterialsCsvOk } from '../src/core/materialsCsv';
import { computeMosaic } from '../src/core/mosaic';
import { DEFAULT_PDF_OPTIONS, type PdfOptions } from '../src/core/pdfOptions';
import { planSheets } from '../src/core/pdfPlan';
import { cellPieces } from '../src/core/pieces';
import { maxSpanForSheets, paperPresets, presetChoices, sameSectionGrid, sheetFit } from '../src/core/sectionPresets';
import { CellKind, DEFAULT_SETTINGS, fineTileSize, type Material, type PaletteColor, type Region } from '../src/core/types';
import { de, en, tr } from '../src/i18n/ext/w6-fix-data';
import * as fine from '../src/i18n/ext/w6-fine-tiles';
import { baseParams, sampleSetup } from './w1-mosaic-core.fixtures';

const pc = (code: number, hex: string, extra: Partial<PaletteColor> = {}): PaletteColor => ({ code, name: `c${code}`, hex, lab: hexToLab(hex), materialId: 'base', ...extra });

// ================================================================ 1. Verlauf: Feinstein-Material

describe('Verlauf: Feinstein-Material ist eine eigene Änderung', () => {
  const P0 = [pc(1, '#AA0000'), pc(2, '#00AA00')];
  const P1 = [P0[0], pc(2, '#00BB00')];
  const P2 = P1.map((p) => ({ ...p, fineMaterialId: 'fine2x2' }));

  it('fineMaterialId zählt im Inhalt (Zuordnen/Entfernen = „update“, nicht „cosmetic“)', () => {
    expect(paletteEntryKey(P1[0])).not.toBe(paletteEntryKey(P2[0]));
    expect(classifyPaletteChange(P1, P2)).toEqual({ kind: 'update', codes: [1, 2] });
    expect(classifyPaletteChange(P2, P1)).toEqual({ kind: 'update', codes: [1, 2] });
    expect(classifyPaletteChange(P2, P2.map((p) => ({ ...p })))).toEqual({ kind: 'cosmetic', codes: [] });
  });

  it('Rückgängig nimmt zuerst die Zuordnung zurück, dann den HEX-Wert – Wiederholen stellt beides wieder her', () => {
    const j = new EditJournal();
    expect(j.push(paletteEntryFrom(P0, P1, [], { label: { key: 'x' }, at: 0 }))).toBe('pushed');
    expect(j.push(paletteEntryFrom(P1, P2, [], { label: { key: 'x' }, at: 10_000 }))).toBe('pushed');
    let pal: PaletteColor[] = P2;
    const step = (dir: 'undo' | 'redo') => {
      const r = dir === 'undo' ? j.undo({ data: null, palette: pal }) : j.redo({ data: null, palette: pal });
      expect(r.status).toBe('ok');
      if (r.status === 'ok') pal = r.palette!;
    };
    step('undo');
    expect(pal.map((p) => [p.hex, p.fineMaterialId ?? null])).toEqual([
      ['#AA0000', null],
      ['#00BB00', null],
    ]);
    step('undo');
    expect(pal).toBe(P0);
    step('redo');
    step('redo');
    expect(pal.map((p) => p.fineMaterialId)).toEqual(['fine2x2', 'fine2x2']);
  });

  it('nie die Feinstein-Zuordnung einer anderen Farbe verwerfen: veralteter Eintrag wird verworfen, gültiger behält sie', () => {
    // Zuordnung ohne Verlaufseintrag (z. B. nach Neuberechnung übertragen): älterer Eintrag passt nicht mehr → stale
    const j = new EditJournal();
    j.push(paletteEntryFrom(P0, P1, [], { label: { key: 'x' } }));
    const r = j.undo({ data: null, palette: P2 });
    expect(r.status).toBe('stale');
    // Farbe 1 hat ein Feinstein-Material, Farbe 2 wird bearbeitet: Rückgängig behält das von Farbe 1
    const Q0 = [pc(1, '#AA0000', { fineMaterialId: 'f1' }), pc(2, '#00AA00')];
    const Q1 = [Q0[0], pc(2, '#00CC00')];
    const j2 = new EditJournal();
    j2.push(paletteEntryFrom(Q0, Q1, [], { label: { key: 'x' } }));
    const u = j2.undo({ data: null, palette: Q1 });
    expect(u.status).toBe('ok');
    if (u.status === 'ok') expect(u.palette!.map((p) => p.fineMaterialId ?? null)).toEqual(['f1', null]);
  });

  it('kurz hintereinander an derselben Farbe: Zuordnen und Entfernen heben sich auf (kein leerer Eintrag)', () => {
    const j = new EditJournal();
    const A = [pc(1, '#AA0000')];
    const B = [pc(1, '#AA0000', { fineMaterialId: 'f' })];
    expect(j.push(paletteEntryFrom(A, B, [], { label: { key: 'x' }, coalesce: 'upd:1', at: 1000 }))).toBe('pushed');
    expect(j.push(paletteEntryFrom(B, A, [], { label: { key: 'x' }, coalesce: 'upd:1', at: 1500 }))).toBe('noop');
    expect(j.undoSize).toBe(0);
  });
});

// ================================================================ 2. PDF-Kennung: Feinstein-Materialien

describe('PDF-Kennung: Materialien der Palette einschließlich Feinstein-Material', () => {
  const mat = (id: string, extra: Partial<Material> = {}): Material =>
    ({ id, type: 'glass', manufacturer: 'M', product: '', colorNumber: id, colorName: '', hex: '#808080', lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 3, packageSize: '', piecesPerPack: 100, ...extra }) as Material;
  const palette = [pc(1, '#AA0000', { materialId: 'base', fineMaterialId: 'fine' }), pc(2, '#00AA00', { materialId: 'other' })];
  const key = (ms: Material[]) => JSON.stringify(paletteMaterials(palette, ms));

  it('Grund- und Feinstein-Material sind enthalten, unbenutzte nicht – in der Reihenfolge der Materialliste', () => {
    const ms = [mat('unused'), mat('fine', { lengthMm: 4, widthMm: 4 }), mat('other'), mat('base')];
    expect(paletteMaterials(palette, ms).map((m) => m.id)).toEqual(['fine', 'other', 'base']);
  });

  it('Preis, Packung, Bestand, Name oder Maß des Feinstein-Materials geändert → andere Kennung (PDF nicht mehr fertig)', () => {
    const base = [mat('base'), mat('other'), mat('fine', { lengthMm: 4, widthMm: 4 })];
    const k0 = key(base);
    const withFine = (p: Partial<Material>) => base.map((m) => (m.id === 'fine' ? { ...m, ...p } : m));
    for (const p of [{ price: 30 }, { piecesPerPack: 50 }, { stock: 12 }, { colorName: 'Rot fein' }, { lengthMm: 5, widthMm: 5 }] as Partial<Material>[]) expect(key(withFine(p))).not.toBe(k0);
    // ein nicht verwendetes Material ändert nichts
    expect(key([...base, mat('x', { price: 99 })])).toBe(k0);
  });
});

// ================================================================ 3. CSV-Reimport: veraltete Farbherkunft

describe('Material-CSV: neuer HEX-Wert bei unveränderter Herkunft', () => {
  const photo = {
    id: 'p1',
    type: 'glass',
    manufacturer: 'Sicis',
    product: '',
    colorNumber: '09',
    colorName: '',
    hex: '#3A6EA5',
    lengthMm: 10,
    widthMm: 10,
    thicknessMm: 4,
    price: 0,
    packageSize: '',
    piecesPerPack: 0,
    colorSource: { kind: 'photo', measuredAt: '2026-11-10T12:00:00.000Z', reference: 'white', spreadDE: 1.8 },
  } as Material;
  const plan = (csv: string, existing: Material[] = [photo]) => {
    let i = 0;
    return planMaterialImport(parseMaterialsCsv(csv) as MaterialsCsvOk, existing, 'update', () => `n${++i}`);
  };

  it('Fotomessung gehört zum alten Wert: Herkunft „eingegeben“, als Änderung und mit Hinweis', () => {
    const csv = materialsToCsv([photo], 'de', { bom: false }).replace('#3A6EA5', '#FF0000');
    const p = plan(csv);
    expect(p.updates).toHaveLength(1);
    const u = p.updates[0];
    expect(u.after.hex).toBe('#FF0000');
    expect(u.after.colorSource).toEqual({ kind: 'manual' });
    expect(u.changed).toEqual(expect.arrayContaining(['hex', 'colorSource']));
    expect(p.warnings).toEqual([{ line: 2, field: 'srcKind', reason: 'source-stale', value: '#FF0000' }]);
  });

  it('gleicher HEX-Wert: Herkunft bleibt, kein Hinweis; geänderte Herkunftsspalten werden übernommen', () => {
    const same = plan(materialsToCsv([photo], 'de', { bom: false }));
    expect(same.updates).toHaveLength(0);
    expect(same.identical).toHaveLength(1);
    expect(same.warnings).toHaveLength(0);
    // neuer HEX UND neue Messung (anderes Datum): die Datei sagt, woher der neue Wert kommt – übernehmen, kein Hinweis
    const measured = { ...photo, hex: '#FF0000', colorSource: { ...photo.colorSource!, measuredAt: '2026-11-11T09:00:00.000Z' } } as Material;
    const p = plan(materialsToCsv([measured], 'de', { bom: false }));
    expect(p.updates[0].after.colorSource).toEqual({ kind: 'photo', measuredAt: '2026-11-11T09:00:00.000Z', reference: 'white', spreadDE: 1.8 });
    expect(p.warnings).toHaveLength(0);
  });

  it('Herkunft „eingegeben“: neuer HEX-Wert ohne Hinweis', () => {
    const manual = { ...photo, colorSource: { kind: 'manual' } } as Material;
    const p = plan(materialsToCsv([manual], 'de', { bom: false }).replace('#3A6EA5', '#FF0000'), [manual]);
    expect(p.updates[0].after.colorSource).toEqual({ kind: 'manual' });
    expect(p.updates[0].changed).toEqual(['hex']);
    expect(p.warnings).toHaveLength(0);
  });
});

// ================================================================ 4. „2×2 Blätter“ aus dem Raster

describe('„2×2 Blätter“: höchstens 2 × 2 Verlegeblätter je Abschnitt (Blattgrenzen auf Rasterlinien)', () => {
  const layoutOf = (W: number, H: number, tile: number, joint: number, edgeMode: 'whole' | 'cut-end' | 'cut-both') =>
    computeLayout({ widthMm: W, heightMm: H, tileW: tile, tileH: tile, joint, edgeMode, minCutMm: 2 });

  it('Fall aus der Prüfung: 5 mm Stein, 1 mm Fuge, 353 mm breit – früher 3 Blattspalten, jetzt 2', () => {
    const layout = layoutOf(353, 200, 5, 1, 'whole');
    const opts = { ...DEFAULT_PDF_OPTIONS };
    const old = paperPresets(opts);
    const pr = paperPresets(opts, layout);
    expect(old.two.wMm).toBe(356);
    const planOf = (w: number, h: number) => planSheets(layout, sectionsFor(layout, { ...DEFAULT_SETTINGS, sectionMode: 'size', sectionWmm: w, sectionHmm: h }), { ...opts, sectionIds: null });
    expect(Math.max(...planOf(old.two.wMm, old.two.hMm).sections.map((s) => s.cx.length))).toBe(3);
    // 2 Blätter à 29 Steine (29·5 + 28·1 = 173 ≤ 178): 58 Steine = 58·5 + 57·1 = 347 mm
    expect(pr.two.wMm).toBe(347);
    for (const s of planOf(pr.two.wMm, pr.two.hMm).sections) {
      expect(s.cx.length).toBeLessThanOrEqual(2);
      expect(s.ry.length).toBeLessThanOrEqual(2);
    }
    // „1 Blatt“ unverändert
    expect(pr.one).toEqual(old.one);
  });

  it('viele Raster, Papier und Maßstäbe: nie mehr als 2 Blattspalten/-zeilen je Abschnitt', () => {
    let n = 0;
    const optsList: PdfOptions[] = [
      { ...DEFAULT_PDF_OPTIONS },
      { ...DEFAULT_PDF_OPTIONS, orientation: 'landscape' },
      { ...DEFAULT_PDF_OPTIONS, format: 'a3', sheetScale: 0.5 },
      { ...DEFAULT_PDF_OPTIONS, sheetScale: 2 },
    ];
    for (const [tile, joint] of [
      [5, 1],
      [8, 1],
      [10, 2],
      [4.25, 0.8],
    ] as const)
      for (const edgeMode of ['whole', 'cut-end', 'cut-both'] as const)
        for (const opts of optsList)
          for (let W = 300; W <= 1300; W += 61) {
            const layout = layoutOf(W, W * 0.8, tile, joint, edgeMode);
            const pr = paperPresets(opts, layout);
            expect(pr.two.wMm).toBeLessThanOrEqual(Math.floor((2 * pr.printW * 10) / pr.scale) / 10);
            const plan = planSheets(layout, sectionsFor(layout, { ...DEFAULT_SETTINGS, sectionMode: 'size', sectionWmm: pr.two.wMm, sectionHmm: pr.two.hMm }), { ...opts, sectionIds: null });
            for (const s of plan.sections) {
              expect(s.cx.length).toBeLessThanOrEqual(2);
              expect(s.ry.length).toBeLessThanOrEqual(2);
            }
            n++;
          }
    expect(n).toBeGreaterThan(500);
  });

  it('maxSpanForSheets: Infinity, wenn jeder Rest passt; sonst eine echte Rasterlänge', () => {
    const layout = layoutOf(100, 100, 5, 1, 'whole');
    expect(maxSpanForSheets(layout.colX, layout.colW, 178, 1, 2)).toBe(Infinity);
    const big = layoutOf(1000, 100, 5, 1, 'whole');
    const w = maxSpanForSheets(big.colX, big.colW, 178, 1, 2);
    expect(w).toBeCloseTo(347, 9);
  });

  it('Vorgaben bewerten: aktuelle Einteilung nicht noch einmal, „2×2“ nur wenn besser, beste „empfohlen“', () => {
    const { layout } = sampleSetup('city');
    const opts = { ...DEFAULT_PDF_OPTIONS };
    const pr = paperPresets(opts, layout);
    const gridOf = (w: number, h: number) => sectionsFor(layout, { ...DEFAULT_SETTINGS, sectionMode: 'size', sectionWmm: w, sectionHmm: h });
    // Standard 30 × 30 cm: schlecht genutzt → eine Vorgabe empfohlen, keine aktiv
    const cur = presetChoices(layout, gridOf(DEFAULT_SETTINGS.sectionWmm, DEFAULT_SETTINGS.sectionHmm), pr, opts);
    expect(cur.presetActive).toBe(false);
    expect([cur.one, cur.two].filter((c) => c.recommended)).toHaveLength(1);
    expect(cur.cur).toEqual(sheetFit(layout, gridOf(DEFAULT_SETTINGS.sectionWmm, DEFAULT_SETTINGS.sectionHmm), opts, pr.scale));
    // „1 Blatt“ gilt: aktiv, nicht empfohlen
    const one = presetChoices(layout, gridOf(pr.one.wMm, pr.one.hMm), pr, opts);
    expect(one.presetActive).toBe(true);
    expect(one.one.current).toBe(true);
    expect(one.one.recommended).toBe(false);
    // „2×2“ angeboten ⇔ weniger Abschnitte und nicht mehr Blätter als „1 Blatt“
    expect(one.two.offered).toBe(one.two.fit.sections < one.one.fit.sections && one.two.fit.sheets <= one.one.fit.sheets);
    // aktuelle Einteilung = ein „2×2“, das schlechter ist als „1 Blatt“: nicht angeboten, Hinweis bleibt, „1 Blatt“ empfohlen
    const worse = layoutOf(360, 500, 5, 1, 'whole');
    const prw = paperPresets(opts, worse);
    const gw = sectionsFor(worse, { ...DEFAULT_SETTINGS, sectionMode: 'size', sectionWmm: prw.two.wMm, sectionHmm: prw.two.hMm });
    const cw = presetChoices(worse, gw, prw, opts);
    expect(cw.two.current).toBe(true);
    expect(cw.two.fit.sheets).toBeGreaterThan(cw.one.fit.sheets);
    expect(cw.two.offered).toBe(false);
    expect(cw.presetActive).toBe(false);
    expect(cw.one.recommended).toBe(true);
    // kleines Mosaik: „2×2“ ergäbe dieselbe Einteilung wie „1 Blatt“ → nicht angeboten
    const small = layoutOf(150, 150, 5, 1, 'whole');
    const prs = paperPresets(opts, small);
    const gs = sectionsFor(small, { ...DEFAULT_SETTINGS, sectionMode: 'size', sectionWmm: prs.one.wMm, sectionHmm: prs.one.hMm });
    const ch = presetChoices(small, gs, prs, opts);
    expect(sameSectionGrid(gs, sectionsFor(small, { ...DEFAULT_SETTINGS, sectionMode: 'size', sectionWmm: prs.two.wMm, sectionHmm: prs.two.hMm }))).toBe(true);
    expect(ch.two.offered).toBe(false);
    expect(ch.one.current).toBe(true);
    expect(ch.one.recommended).toBe(false);
  });
});

// ================================================================ 5. Feinbereiche an gekürzten Randsteinen

describe('Feinbereiche: k×k nur erzwingen, wo die Teilsteine das Feinsteinmaß haben', () => {
  const isFineSized = (L: Layout, row: number, col: number, k: number) => {
    const f = fineTileSize(L.tileW, L.tileH, L.joint, k);
    const sw = (L.colW[col] - (k - 1) * L.joint) / k;
    const sh = (L.rowH[row] - (k - 1) * L.joint) / k;
    return Math.abs(sw - f.w) < 0.05 && Math.abs(sh - f.h) < 0.05;
  };

  it('Feinbereich über gekürzten Randsteinen: dort nichts erzwungen, eigens gezählt; „sub“ nur echte Feinsteine', () => {
    const su = sampleSetup('city');
    const L = su.layout;
    // Randstreifen unten (gekürzte letzte Zeile) und rechts
    const regions: Region[] = [
      { id: 'b', type: 'fine', shape: 'rect', x: 0, y: 0.9, w: 1, h: 0.1 } as Region,
      { id: 'r', type: 'fine', shape: 'rect', x: 0.9, y: 0, w: 0.1, h: 1 } as Region,
    ];
    const res = computeMosaic(su.img, baseParams(su, { regions }));
    const fr = res.diagnostics.fineRegions!;
    const k = fr.k;
    const trimmedRows = Array.from({ length: L.rows }, (_, r) => r).filter((r) => !isFineSized(L, r, 0, k));
    expect(trimmedRows.length).toBeGreaterThan(0);
    expect(fr.notFineSize).toBeGreaterThan(0);
    // gezählte Feinsteine: genau die k×k-Zellen mit Feinsteinmaß im Bereich; jedes ihrer Teile hat das Feinsteinmaß
    const f = fineTileSize(L.tileW, L.tileH, L.joint, k);
    let subFine = 0;
    let subTrimmed = 0;
    for (let row = 0; row < L.rows; row++)
      for (let col = 0; col < L.cols; col++) {
        const i = row * L.cols + col;
        if (res.data.kind[i] !== CellKind.SUB) continue;
        const inRegion = row >= Math.floor(L.rows * 0.9) - 1 || col >= Math.floor(L.cols * 0.9) - 1;
        if (!inRegion) continue;
        if (isFineSized(L, row, col, k)) {
          subFine++;
          for (const p of cellPieces(L, res.data, row, col)) {
            const b = bbox(p.poly);
            expect(Math.abs(b.w - f.w)).toBeLessThan(0.05);
            expect(Math.abs(b.h - f.h)).toBeLessThan(0.05);
          }
        } else subTrimmed++;
      }
    expect(fr.sub).toBeLessThanOrEqual(subFine);
    expect(fr.sub).toBeGreaterThan(0);
    // gekürzte Zellen: höchstens die normale Wahl (an Bildkanten), nie flächendeckend erzwungen
    expect(subTrimmed).toBeLessThan(fr.notFineSize!);
    expect(fr.sub + fr.tooSmall + fr.notFineSize!).toBeLessThanOrEqual(fr.cells);
  });

  it('nur ganze Steine (keine gekürzten Ränder): notFineSize = 0, alle Feinbereichszellen erzwungen', () => {
    const su = sampleSetup('city');
    const L0 = su.layout;
    const layout = computeLayout({ widthMm: L0.cols * (L0.tileW + L0.joint) - L0.joint, heightMm: 20 * (L0.tileH + L0.joint) - L0.joint, tileW: L0.tileW, tileH: L0.tileH, joint: L0.joint, edgeMode: 'whole', minCutMm: 2 });
    const res = computeMosaic(su.img, baseParams({ ...su, layout }, { regions: [{ id: 'a', type: 'fine', shape: 'rect', x: 0.2, y: 0.2, w: 0.3, h: 0.5 } as Region] }));
    const fr = res.diagnostics.fineRegions!;
    expect(fr.cells).toBeGreaterThan(100);
    expect(fr.notFineSize).toBe(0);
    expect(fr.tooSmall).toBe(0);
    expect(fr.sub).toBe(fr.cells);
  });

  it('Texte: gekürzte Randsteine, Werkzeug „Feinbereich“, Materialverwaltung', () => {
    for (const d of [fine.de, fine.en, fine.tr]) {
      expect(d['w6ft.region.resultNotFine']).toContain('{n}');
      expect(d['w6ft.fine.addMats']).toContain('{w}');
    }
    expect(fine.de['w6ft.region.hint']).toMatch(/^Werkzeug „Feinbereich“ bei den Gesichts- und Detailbereichen/);
    expect(fine.de['w6ft.fine.addMats']).toContain('Materialverwaltung');
    expect(fine.de['w6ft.fine.noMats']).not.toContain('„Materialien“');
    expect(fine.de['w6ft.region.resultTooSmall']).not.toContain('Randstein');
  });
});

// ================================================================ 6. Koordinaten-CSV übersetzt

describe('Koordinaten-CSV in der Sprache der Oberfläche', () => {
  const su = sampleSetup('portrait');
  const res = computeMosaic(su.img, baseParams(su));
  for (let i = 0; i < res.data.progress.length; i += 5) res.data.progress[i] = 0xffff;
  const grid = sectionsFor(su.layout, DEFAULT_SETTINGS);
  const csvOf = (lang?: 'de' | 'en' | 'tr') => buildCsv(su.layout, res.data, res.palette, [], grid, null, lang !== 'en', lang).split('\r\n');

  it('Deutsch (auch ohne Angabe): bisherige Kopfzeile, ja/nein, Formkennungen', () => {
    const d = csvOf('de');
    expect(d[0]).toBe(CSV_HEADER);
    expect(csvOf()).toEqual(d);
    const cut = new Set(d.slice(1).map((l) => l.split(';')[14].replace(/ \(T\d+\)$/, '')));
    expect(cut).toEqual(new Set(['ja', 'nein']));
    expect(new Set(d.slice(1).map((l) => l.split(';')[16]))).toEqual(new Set(['ja', 'nein']));
  });

  for (const lang of ['en', 'tr'] as const) {
    it(`${lang}: Kopfzeile, ja/nein und Formnamen übersetzt, sonst gleiche Werte`, () => {
      const T = COORD_CSV_TEXT[lang];
      const d = csvOf('de');
      const x = csvOf(lang);
      expect(x[0]).toBe(T.header);
      expect(x[0].split(';')).toHaveLength(CSV_HEADER.split(';').length);
      expect(x.length).toBe(d.length);
      const shapesDe = new Map(Object.entries(COORD_CSV_TEXT.de.shapes).map(([k, v]) => [v, T.shapes[k as keyof typeof T.shapes]]));
      for (let i = 1; i < x.length; i += 37) {
        const a = d[i].split(';');
        const b = x[i].split(';');
        expect(b[0]).toBe(a[0]);
        expect(b[13]).toBe(shapesDe.get(a[13]));
        expect(b[14]).toBe(a[14].replace(/^ja/, T.yes).replace(/^nein$/, T.no));
        expect(b[16]).toBe(a[16] === 'ja' ? T.yes : T.no);
      }
      expect(x.slice(1).some((l) => l.split(';')[16] === T.yes)).toBe(true);
      expect(x.join('\n')).not.toMatch(/;(ja|nein)(;| \()/);
    });
  }

  it('Dateiendung je Sprache', () => {
    expect(COORD_CSV_TEXT.de.fileSuffix).toBe('koordinaten');
    expect(COORD_CSV_TEXT.en.fileSuffix).toBe('coordinates');
    expect(COORD_CSV_TEXT.tr.fileSuffix).toBe('koordinatlar');
  });
});

// ================================================================ Texte

describe('Texte w6-fix-data', () => {
  it('de/en/tr: gleiche Schlüssel und Platzhalter', () => {
    const keys = Object.keys(de).sort();
    expect(Object.keys(en).sort()).toEqual(keys);
    expect(Object.keys(tr).sort()).toEqual(keys);
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    for (const k of keys) {
      expect(ph(en[k])).toBe(ph(de[k]));
      expect(ph(tr[k])).toBe(ph(de[k]));
    }
  });
});
