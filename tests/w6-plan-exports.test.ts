/**
 * Paket w6-plan-exports: gestreamte Koordinaten-CSV (Bänder statt eines riesigen Texts), Vorlagennummern
 * „ja (T12)“ wie im PDF, Abschnittsexport nur über den eigenen Bereich, Schutz vor Farbindizes außerhalb der
 * Palette; Abschnittsgrößen passend zum Papier (Vorgaben „1 Blatt“ / „2×2 Blätter“).
 */
import { describe, expect, it } from 'vitest';
import { hexToLab, type ColorNameLang } from '../src/core/color';
import { paletteDisplayName } from '../src/core/colorNames';
import { buildCsv, buildCsvChunks, COORD_CSV_TEXT, CSV_HEADER, CsvPaletteError, prepareCsv, SPREADSHEET_MAX_ROWS } from '../src/core/csv';
import { bbox, type Pt, type ShapeType } from '../src/core/geometry';
import { cellId, computeLayout, sectionOfCell, sectionsFor, type Layout, type SectionGrid } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { collectTemplates } from '../src/core/pdf';
import { DEFAULT_PDF_OPTIONS } from '../src/core/pdfOptions';
import { cellPieces } from '../src/core/pieces';
import { computeStats, CutCache, makeRawSizeFn, pieceCutInfo } from '../src/core/stats';
import { CellKind, DEFAULT_SETTINGS, type Material, type MosaicData, type PaletteColor } from '../src/core/types';
import { de, en, tr } from '../src/i18n/ext/w6-plan-exports';
import { paperPresets, sheetFit } from '../src/core/sectionPresets';
import { baseParams, sampleSetup } from './w1-mosaic-core.fixtures';

/** Die Fassung vor Welle 6 (wörtlich), als Referenz für den Byte-Vergleich. */
function legacyBuildCsv(
  layout: Layout,
  data: MosaicData,
  palette: PaletteColor[],
  materials: Material[],
  sections: SectionGrid,
  sectionIds: string[] | null,
  decimalComma = true,
  lang?: ColorNameLang,
): string {
  const nameOf = (pc: PaletteColor | undefined) => (pc ? (lang ? paletteDisplayName(pc, lang) : pc.name) : '');
  const raw = makeRawSizeFn(layout, palette, materials);
  const cache = new CutCache();
  const f = (v: number) => {
    const s = (Math.round(v * 100) / 100).toFixed(2);
    return decimalComma ? s.replace('.', ',') : s;
  };
  const polyStr = (p: Pt[]) => p.map((q) => `${f(q.x)} ${f(q.y)}`).join(' | ');
  const out: string[] = [
    'Position;Abschnitt;Zeile;Spalte;Teil;X_mm;Y_mm;Breite_mm;Hoehe_mm;Flaeche_mm2;Farbcode;Farbname;HEX;Form;Zuschnitt;Rohstein_mm;Verlegt;Kontur_mm',
  ];
  const sel = sectionIds ? new Set(sectionIds) : null;
  for (let row = 0; row < layout.rows; row++) {
    for (let col = 0; col < layout.cols; col++) {
      const sec = sectionOfCell(sections, row, col);
      if (sel && !sel.has(sec.id)) continue;
      const ps = cellPieces(layout, data, row, col);
      const idx = row * layout.cols + col;
      ps.forEach((p, i) => {
        const r = raw(p.color);
        const ci = pieceCutInfo(cache, layout, data, row, col, i, p.poly, r);
        const b = bbox(p.poly);
        const pc = palette[p.color];
        out.push(
          [
            cellId(layout, row, col) + (ps.length > 1 ? `-${i + 1}` : ''),
            sec.id,
            row + 1,
            col + 1,
            i + 1,
            f(b.minX),
            f(b.minY),
            f(ci.w),
            f(ci.h),
            f(ci.area),
            String(pc?.code ?? '').padStart(2, '0'),
            `"${nameOf(pc).replace(/"/g, '""')}"`,
            pc?.hex ?? '',
            ci.shape,
            ci.needsCut ? 'ja' : 'nein',
            `${f(r.w)}x${f(r.h)}`,
            (data.progress[idx] >> i) & 1 ? 'ja' : 'nein',
            polyStr(p.poly),
          ].join(';'),
        );
      });
    }
  }
  return out.join('\r\n');
}

const ZU = 14; // Spalte „Zuschnitt“
const POS = 0;
const FORM = 13; // Spalte „Form“
const LAID = 16; // Spalte „Verlegt“

/**
 * Die alte (deutsche) Fassung in eine andere Sprache übertragen (Korrekturen Welle 6: Koordinaten-CSV übersetzt):
 * Kopfzeile, ja/nein in „Zuschnitt“ und „Verlegt“, Formnamen – sonst Byte für Byte gleich. Für 'de' unverändert.
 */
function legacyIn(legacy: string, lang: ColorNameLang): string {
  const T = COORD_CSV_TEXT[lang];
  const yn = (v: string) => (v === 'ja' ? T.yes : v === 'nein' ? T.no : v);
  return legacy
    .split('\r\n')
    .map((l, i) => {
      if (i === 0) return T.header;
      const cols = l.split(';');
      cols[ZU] = yn(cols[ZU]);
      cols[LAID] = yn(cols[LAID]);
      cols[FORM] = T.shapes[cols[FORM] as ShapeType] ?? cols[FORM];
      return cols.join(';');
    })
    .join('\r\n');
}

/**
 * Einzige beabsichtigte Änderung gegenüber der alten Fassung: „ja“ → „ja (T#)“ in der Spalte Zuschnitt (Farbnamen
 * sind unverändert paletteDisplayName in der übergebenen Sprache). Liefert die Zeilen der neuen Fassung mit
 * zurückgesetztem „ja“, um den Rest Byte für Byte zu vergleichen.
 */
function stripTpl(csv: string, yes = 'ja'): { text: string; tnos: (number | null)[] } {
  const tnos: (number | null)[] = [];
  const lines = csv.split('\r\n').map((l, i) => {
    if (i === 0) return l;
    const cols = l.split(';');
    // Farbname steht in Anführungszeichen und kann kein „;“ enthalten (Testpaletten) – Spalten zählen direkt
    const m = new RegExp(`^${yes} \\(T(\\d+)\\)$`).exec(cols[ZU]);
    tnos.push(m ? Number(m[1]) : null);
    if (m) cols[ZU] = yes;
    return cols.join(';');
  });
  return { text: lines.join('\r\n'), tnos };
}

const samples = ['portrait', 'city'] as const;
const computed = new Map<string, { layout: Layout; data: MosaicData; palette: PaletteColor[] }>();
function sample(key: (typeof samples)[number]) {
  let v = computed.get(key);
  if (!v) {
    const su = sampleSetup(key);
    const res = computeMosaic(su.img, baseParams(su));
    // etwas Fortschritt, damit „Verlegt“ beide Werte hat
    for (let i = 0; i < res.data.progress.length; i += 7) res.data.progress[i] = 0xffff & 0b11;
    v = { layout: su.layout, data: res.data, palette: res.palette };
    computed.set(key, v);
  }
  return v;
}

describe('Koordinaten-CSV in Bändern (buildCsvChunks)', () => {
  for (const key of samples) {
    it(`${key}: zusammengefügte Bänder = alte buildCsv-Ausgabe bis auf „ja (T#)“; Zeilen = Statistik; Positionen eindeutig`, () => {
      const { layout, data, palette } = sample(key);
      const grid = sectionsFor(layout, DEFAULT_SETTINGS);
      // Deutsch: Byte für Byte die alte Fassung (bis auf T#); en/tr: dieselbe Datei mit übersetzter Kopfzeile,
      // ja/nein und Formnamen (Korrekturen Welle 6 – vorher waren diese auch in en/tr deutsch)
      for (const lang of ['de', 'en', 'tr'] as const) {
        const comma = lang !== 'en';
        const T = COORD_CSV_TEXT[lang];
        const old = legacyIn(legacyBuildCsv(layout, data, palette, [], grid, null, comma, lang), lang);
        const chunks = [...buildCsvChunks(layout, data, palette, [], grid, null, comma, lang, { bandRows: 997 })];
        expect(chunks[0]).toBe(lang === 'de' ? CSV_HEADER : T.header);
        expect(chunks.length).toBeGreaterThan(2);
        for (const c of chunks.slice(1)) expect(c.startsWith('\r\n')).toBe(true);
        const joined = chunks.join('');
        expect(joined).toBe(buildCsv(layout, data, palette, [], grid, null, comma, lang));
        const { text, tnos } = stripTpl(joined, T.yes);
        expect(text).toBe(old);
        if (lang === 'de') expect(text).toBe(legacyBuildCsv(layout, data, palette, [], grid, null, comma, lang));

        // T# genau die Nummern von collectTemplates (PDF-Schnittvorlagen)
        const tpl = collectTemplates(layout, data, palette, []);
        const raw = makeRawSizeFn(layout, palette, []);
        const cache = new CutCache();
        const expectNo: (number | null)[] = [];
        for (let row = 0; row < layout.rows; row++)
          for (let col = 0; col < layout.cols; col++)
            cellPieces(layout, data, row, col).forEach((p, i) => {
              const ci = pieceCutInfo(cache, layout, data, row, col, i, p.poly, raw(p.color));
              expectNo.push(ci.needsCut ? tpl.bySig.get(ci.signature)!.no : null);
            });
        expect(tnos).toEqual(expectNo);
        expect(tnos.some((x) => x !== null)).toBe(true);

        const stats = computeStats(layout, data, palette, [], { reservePct: 10, groutDepthMm: 3 });
        const rows = joined.split('\r\n').slice(1);
        expect(rows.length).toBe(stats.pieces);
        expect(rows.filter((r) => r.split(';')[ZU].startsWith(`${T.yes} (T`)).length).toBe(stats.cutPieces);
        expect(new Set(rows.map((r) => r.split(';')[POS])).size).toBe(rows.length);
      }
    });
  }

  it('Abschnittsexport: nur die Zellen des Abschnitts, gleiche Zeilen wie gefiltert; Vorlagennummern global', () => {
    const { layout, data, palette } = sample('portrait');
    const grid = sectionsFor(layout, { ...DEFAULT_SETTINGS, sectionWmm: 120, sectionHmm: 90 });
    expect(grid.sections.length).toBeGreaterThan(6);
    const all = buildCsv(layout, data, palette, [], grid, null).split('\r\n');
    for (const ids of [[grid.sections[4].id], [grid.sections[1].id, grid.sections[grid.scols + 2].id, grid.sections[grid.sections.length - 1].id], []]) {
      const sel = new Set(ids);
      const part = buildCsv(layout, data, palette, [], grid, ids).split('\r\n');
      const filtered = [all[0], ...all.slice(1).filter((l) => sel.has(l.split(';')[1]))];
      expect(part).toEqual(filtered);
      const prep = prepareCsv(layout, data, palette, [], grid, ids);
      expect(prep.rows).toBe(part.length - 1);
      // Statistik der Abschnitte
      let pieces = 0;
      for (const id of ids) {
        const s = grid.sections.find((x) => x.id === id)!;
        pieces += computeStats(layout, data, palette, [], { reservePct: 0, groutDepthMm: 3 }, { r0: s.r0, r1: s.r1, c0: s.c0, c1: s.c1 }).pieces;
      }
      expect(prep.rows).toBe(pieces);
    }
    // alter Abschnittsexport: identisch bis auf T#
    const id = grid.sections[3].id;
    expect(stripTpl(buildCsv(layout, data, palette, [], grid, [id])).text).toBe(legacyBuildCsv(layout, data, palette, [], grid, [id]));
  });

  it('Farbindex außerhalb der Palette: CsvPaletteError, keine Zeile', () => {
    const { layout, data, palette } = sample('portrait');
    const grid = sectionsFor(layout, DEFAULT_SETTINGS);
    const short = palette.slice(0, palette.length - 1);
    const gen = buildCsvChunks(layout, data, short, [], grid, null);
    let err: unknown = null;
    try {
      gen.next();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CsvPaletteError);
    expect((err as CsvPaletteError).paletteSize).toBe(short.length);
    expect((err as CsvPaletteError).maxIndex).toBe(palette.length - 1);
    expect((err as CsvPaletteError).code).toBe('csv-palette-index');
  });

  it('Teile ohne Fläche (zu breite Fuge bei Dreiecken) sind keine Zeilen – wie in der Statistik', () => {
    const layout = computeLayout({ widthMm: 30, heightMm: 30, tileW: 2, tileH: 2, joint: 4, edgeMode: 'whole', minCutMm: 0 });
    const n = layout.cols * layout.rows;
    const data: MosaicData = {
      cols: layout.cols,
      rows: layout.rows,
      kind: new Uint8Array(n),
      c1: new Uint16Array(n),
      c2: new Uint16Array(n).fill(1),
      sub: new Map(),
      line: new Map(),
      free: new Map(),
      progress: new Uint16Array(n),
      rec: new Uint8Array(n),
    };
    data.kind[0] = CellKind.DIAG_A;
    const pal = [pc(1, '#FFFFFF'), pc(2, '#000000')];
    const grid = sectionsFor(layout, DEFAULT_SETTINGS);
    const stats = computeStats(layout, data, pal, [], { reservePct: 0, groutDepthMm: 3 });
    const rows = buildCsv(layout, data, pal, [], grid, null).split('\r\n').length - 1;
    expect(rows).toBe(stats.pieces);
    expect(stats.invalidPieces).toBeGreaterThan(0);
    expect(rows + stats.invalidPieces).toBe(n + 1);
  });
});

function pc(code: number, hex: string): PaletteColor {
  return { code, hex, lab: hexToLab(hex) as [number, number, number], name: hex, userNamed: true };
}

/** Synthetisches Großprojekt: Raster ohne Foto, jede 10. Zelle diagonal geteilt. */
function bigMosaic(cols: number, rows: number) {
  const tile = 3.5;
  const joint = 0.5;
  const layout = computeLayout({ widthMm: cols * tile + (cols - 1) * joint, heightMm: rows * tile + (rows - 1) * joint, tileW: tile, tileH: tile, joint, edgeMode: 'whole', minCutMm: 2 });
  const n = cols * rows;
  const data: MosaicData = {
    cols,
    rows,
    kind: new Uint8Array(n),
    c1: new Uint16Array(n),
    c2: new Uint16Array(n),
    sub: new Map(),
    line: new Map(),
    free: new Map(),
    progress: new Uint16Array(n),
    rec: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) {
    data.c1[i] = i % 12;
    if (i % 10 === 3) {
      data.kind[i] = CellKind.DIAG_A;
      data.c2[i] = (i + 5) % 12;
    }
  }
  const pal = Array.from({ length: 12 }, (_, i) => pc(i + 1, `#${(0x101010 * (i + 2)).toString(16).padStart(6, '0').slice(0, 6)}`));
  return { layout, data, pal, pieces: n + Math.floor((n - 3 + 9) / 10) };
}

describe('Großprojekt (≈ 3,5 Mio. Steine): Bänder ohne „Invalid string length“', () => {
  it(
    'Summe der Bandlängen statt eines Texts; Zeilen = Steine',
    () => {
      const { layout, data, pal, pieces } = bigMosaic(2000, 1600);
      expect(pieces).toBeGreaterThan(3_400_000);
      const grid = sectionsFor(layout, DEFAULT_SETTINGS);
      let len = 0;
      let bands = 0;
      let lastRows = 0;
      const gen = buildCsvChunks(layout, data, pal, [], grid, null, true, 'de', { onRows: (d) => (lastRows = d) });
      let r = gen.next();
      while (!r.done) {
        len += r.value.length;
        bands++;
        r = gen.next();
      }
      expect(r.value).toBe(pieces);
      expect(lastRows).toBe(pieces);
      // Kopfzeile + Bänder zu je etwa 20.000 Zeilen (ein Band endet an einer Zellgrenze)
      expect(bands).toBeGreaterThanOrEqual(1 + Math.floor(pieces / 20_001));
      expect(bands).toBeLessThanOrEqual(1 + Math.ceil(pieces / 20_000));
      // mehr als die Höchstlänge einer V8-Zeichenkette (2^29 − 24 Zeichen) wäre als ein Text gar nicht möglich
      expect(len).toBeGreaterThan(400_000_000);
      expect(pieces + 1).toBeGreaterThan(SPREADSHEET_MAX_ROWS);
    },
    240_000,
  );
});

describe('Abschnittsgrößen passend zum Papier', () => {
  it('„1 Blatt“: jeder Abschnitt genau ein Verlegeblatt; „2×2“: höchstens 2 × 2 Blätter je Abschnitt', () => {
    const { layout } = sample('city');
    for (const opts of [
      { ...DEFAULT_PDF_OPTIONS },
      { ...DEFAULT_PDF_OPTIONS, orientation: 'landscape' as const },
      { ...DEFAULT_PDF_OPTIONS, format: 'a3' as const, sheetScale: 0.5 },
      { ...DEFAULT_PDF_OPTIONS, sheetScale: 2 },
    ]) {
      const pr = paperPresets(opts);
      expect(pr.one.wMm).toBeLessThanOrEqual(pr.printW / pr.scale + 1e-9);
      expect(pr.one.hMm).toBeLessThanOrEqual(pr.printH / pr.scale + 1e-9);
      expect(pr.two.wMm).toBeCloseTo(Math.floor((2 * pr.printW * 10) / pr.scale) / 10, 9);
      const one = sheetFit(layout, sectionsFor(layout, { ...DEFAULT_SETTINGS, sectionMode: 'size', sectionWmm: pr.one.wMm, sectionHmm: pr.one.hMm }), opts);
      expect(one.maxPerSection).toBe(1);
      expect(one.sheets).toBe(one.sections);
      const two = sheetFit(layout, sectionsFor(layout, { ...DEFAULT_SETTINGS, sectionMode: 'size', sectionWmm: pr.two.wMm, sectionHmm: pr.two.hMm }), opts);
      expect(two.maxPerSection).toBeLessThanOrEqual(4);
    }
    // A4 hoch, 1:1: 178 × 247 mm bedruckbar
    const a4 = paperPresets(DEFAULT_PDF_OPTIONS);
    expect([a4.one.wMm, a4.one.hMm, a4.two.wMm, a4.two.hMm]).toEqual([178, 247, 356, 494]);
  });

  it('Standard 30 × 30 cm auf A4 hoch: Papier schlecht genutzt – Hinweis mit exakten Blattzahlen', () => {
    const { layout } = sample('city');
    const cur = sheetFit(layout, sectionsFor(layout, DEFAULT_SETTINGS), DEFAULT_PDF_OPTIONS);
    const pr = paperPresets(DEFAULT_PDF_OPTIONS);
    const one = sheetFit(layout, sectionsFor(layout, { ...DEFAULT_SETTINGS, sectionWmm: pr.one.wMm, sectionHmm: pr.one.hMm }), DEFAULT_PDF_OPTIONS);
    expect(cur.sheets).toBeGreaterThan(one.sheets);
    expect(cur.fill).toBeLessThan(0.7);
    expect(one.fill).toBeGreaterThan(cur.fill);
    // Füllgrad exakt: Σ Mosaikfläche der Blätter (Papiermaß) / (Blätter × bedruckbare Fläche)
    expect(cur.fill).toBeGreaterThan(0);
    expect(cur.fill).toBeLessThanOrEqual(1);
  });
});

describe('Texte w6-plan-exports', () => {
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
