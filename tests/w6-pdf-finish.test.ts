/**
 * Paket w6-pdf-finish – letzte Verdrahtung des PDF-Exports:
 *  - generatePdfReport (wie der Worker): zurückgegebene Seitenzahl = Seiten im PDF = Seitenplan; Aufteilung je Teil
 *    summiert sich zur Seitenzahl (4 Beispiele)
 *  - Statistik im PDF aus computeAllStats (EIN Durchlauf für Gesamt und Abschnitte, Blätter als Gitter): exakt dieselben
 *    Zahlen wie computeStats je Bereich; Blattlegende gleich, ob alle oder nur einzelne Abschnitte exportiert werden
 *  - collectTemplates mit dem schnellen Weg für ganze Zellen = bisherige Sammlung (Nummern, Stückzahlen, IDs, Blätter)
 *  - Koordinatenart: eine Messung liefert die exakte Seitenzahl jeder Art (kompakt, je Stein, aus)
 *  - Teil-PDF eines 6-Abschnitt-Projekts: „Teil 2/3 (Abschnitte …)“ in jeder Kopfzeile, T-Nummern wie im ganzen Export,
 *    Steine je Farbe über alle Teile = Statistik
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { hexToRgb } from '../src/core/color';
import { setCellKind, setFreePieces } from '../src/core/edits';
import { cellId, computeLayout, computeSectionsByCount, sectionsFor, type Layout, type SectionGrid } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { collectTemplates, DEFAULT_PDF_OPTIONS, generatePdfReport, pdfLayoutFacts, type PdfInput, type PdfOptions, type TemplateGroup } from '../src/core/pdf';
import { planForSelection } from '../src/core/pdfExportPlan';
import { makeSheetLocator, planPdfPages, planSheets, sheetGridOf } from '../src/core/pdfPlan';
import { cellPieces, cellRect, freePreset } from '../src/core/pieces';
import { CutCache, computeAllStats, computeStats, makeRawSizeFn, pieceCutInfo } from '../src/core/stats';
import { CellKind, DEFAULT_SETTINGS, DEFAULT_SHAPES, type Material, type MosaicData, type PaletteColor } from '../src/core/types';
import { dictionaries, makeT } from '../src/i18n';
import { loadPng, prepareFor } from './helpers';

// ---------------------------------------------------------------- kleiner PDF-Leser (jsPDF-Ausgabe)
function pdfString(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) =>
    /^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e,
  );
}
function parsePdf(buf: ArrayBuffer) {
  const raw = Buffer.from(buf).toString('latin1');
  const objs = new Map<number, string>();
  const starts = [...raw.matchAll(/(?:^|\n)(\d+) 0 obj\b/g)].map((m) => ({ n: Number(m[1]), i: (m.index ?? 0) + m[0].length }));
  starts.forEach((st, k) => objs.set(st.n, raw.slice(st.i, k + 1 < starts.length ? starts[k + 1].i : raw.length)));
  const pagesObj = [...objs.values()].find((o) => /\/Type \/Pages/.test(o)) ?? '';
  const pages = [...(pagesObj.match(/\/Kids \[([^\]]*)\]/)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  const pageContent = (pageNo: number) => {
    const po = objs.get(pages[pageNo - 1]) ?? '';
    const cn = Number(po.match(/\/Contents (\d+) 0 R/)?.[1]);
    const co = objs.get(cn) ?? '';
    const a = co.indexOf('stream');
    const len = Number(co.match(/\/Length (\d+)/)?.[1]);
    const data = co.slice(co.indexOf('\n', a) + 1).slice(0, len);
    try {
      return inflateSync(Buffer.from(data, 'latin1')).toString('latin1');
    } catch {
      return data;
    }
  };
  const pageStrings = (pageNo: number) => [...pageContent(pageNo).matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => pdfString(m[1]));
  return { pages, pageContent, pageStrings };
}
/** gefüllte+umrandete Flächen („B“ = Steine) je Füllfarbe außerhalb von Textblöcken */
function countFills(stream: string): Map<string, number> {
  const res = new Map<string, number>();
  let fill = '';
  let inText = false;
  for (const line of stream.split('\n')) {
    const l = line.trim();
    if (l === 'BT') inText = true;
    else if (l === 'ET') inText = false;
    else if (!inText && / rg$/.test(l)) fill = l.replace(/ rg$/, '');
    else if (!inText && / g$/.test(l)) {
      const v = l.replace(/ g$/, '');
      fill = `${v} ${v} ${v}`;
    } else if (l === 'B') res.set(fill, (res.get(fill) ?? 0) + 1);
  }
  return res;
}
function fmtColor(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const f = (v: number) => (v / 255).toFixed(2).replace(/\.?0+$/, '') || '0';
  return `${f(r)} ${f(g)} ${f(b)}`;
}
/** Verlegeblatt-Seiten (Kopf „Blatt A1-1 (1/4)“ und Kontrollstrecke): Blatt-ID → Seitennummer */
function sheetPagesOf(p: ReturnType<typeof parsePdf>): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i <= p.pages.length; i++) {
    const strs = p.pageStrings(i);
    if (!strs.some((s) => s.includes('Kontrollstrecke'))) continue;
    for (const s of strs) {
      const m = s.match(/Blatt ([A-Z]+\d+-\d+) \(\d+\/\d+\)/);
      if (m && !out.has(m[1])) out.set(m[1], i);
    }
  }
  return out;
}

const statOpts = { reservePct: 10, groutDepthMm: 3 };
const settingsOf = (w: number, h: number, tile: number, joint: number, secW = 300, secH = 300) => ({ ...DEFAULT_SETTINGS, widthMm: w, heightMm: h, tileW: tile, tileH: tile, joint, sectionWmm: secW, sectionHmm: secH, reservePct: 10 });
const inputOf = (layout: Layout, data: MosaicData, palette: PaletteColor[], sections: SectionGrid, materials: Material[] = [], name = 'W6'): PdfInput => ({
  projectName: name,
  dateStr: '11.11.2026',
  layout,
  data,
  palette,
  materials,
  settings: { ...DEFAULT_SETTINGS, reservePct: 10 },
  sections,
  t: makeT('de'),
  locale: 'de',
});

/** Beispielprojekte wie auf der Startseite (wie tests/w4-pdf-sheets.test.ts) */
const SAMPLES = {
  portrait: { w: 400, tile: 5, joint: 1, colors: 32 },
  landscape: { w: 1200, tile: 8, joint: 1.5, colors: 24 },
  animal: { w: 500, tile: 6, joint: 1, colors: 24 },
  city: { w: 2000, tile: 10, joint: 2, colors: 16 },
} as const;
function sample(key: keyof typeof SAMPLES) {
  const s = SAMPLES[key];
  const img0 = loadPng(`public/samples/${key}.png`);
  const settings = settingsOf(s.w, Math.round(s.w / (img0.width / img0.height)), s.tile, s.joint);
  const layout = computeLayout({ widthMm: settings.widthMm, heightMm: settings.heightMm, tileW: s.tile, tileH: s.tile, joint: s.joint, edgeMode: 'cut-end', minCutMm: 2 });
  const res = computeMosaic(prepareFor(img0, layout), { layout, shapes: DEFAULT_SHAPES, paletteMode: 'auto', colorCount: s.colors, dither: 0, deltaE: '2000', regions: [] });
  return { layout, data: res.data, palette: res.palette, sections: sectionsFor(layout, settings) };
}

/** Projekt mit vielen Sonderformen (halbe Steine, Schnittlinien beliebigen Winkels, Freiform) und 6 Abschnitten */
function specialProject() {
  const layout = computeLayout({ widthMm: 300, heightMm: 250, tileW: 5, tileH: 5, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
  const res = computeMosaic(prepareFor(loadPng('public/samples/portrait.png'), layout), { layout, shapes: DEFAULT_SHAPES, paletteMode: 'auto', colorCount: 16, dither: 0, deltaE: '2000', regions: [] });
  let k = 0;
  for (let row = 3; row < layout.rows; row += 7)
    for (let col = 2; col < layout.cols; col += 9) {
      const r = cellRect(layout, row, col);
      const m = k++ % 4;
      if (m === 0) setCellKind(layout, res.data, row, col, { kind: CellKind.SUB, k: 2 }, 1);
      else if (m === 1) setCellKind(layout, res.data, row, col, { kind: CellKind.LINE, angleDeg: 37 + (k % 5), offsetMm: 0.7 }, 1);
      else {
        const polys = freePreset(m === 2 ? 'rhombus' : 'trapezoid', r.w, r.h, layout.joint)!;
        setFreePieces(layout, res.data, row, col, polys.map((poly, i) => ({ poly, color: (row + col + i) % res.palette.length })), 1);
      }
    }
  const sections = computeSectionsByCount(layout, 2, 3);
  return { layout, data: res.data, palette: res.palette, sections };
}

/** bisherige collectTemplates (vor w6-pdf-finish) als Referenz: jede Zelle über cellPieces */
function referenceTemplates(layout: Layout, data: MosaicData, palette: PaletteColor[], materials: Material[], locate?: (row: number, col: number) => { key: string } | null) {
  const cache = new CutCache();
  const raw = makeRawSizeFn(layout, palette, materials);
  const bySig = new Map<string, TemplateGroup>();
  for (let row = 0; row < layout.rows; row++)
    for (let col = 0; col < layout.cols; col++) {
      const ps = cellPieces(layout, data, row, col);
      ps.forEach((p, i) => {
        const ci = pieceCutInfo(cache, layout, data, row, col, i, p.poly, raw(p.color));
        if (!ci.needsCut) return;
        let g = bySig.get(ci.signature);
        if (!g) {
          g = { no: 0, info: ci, count: 0, color: p.color, ids: [], colors: new Set(), sheets: new Map(), sheetColors: new Map() };
          bySig.set(ci.signature, g);
        }
        g.count++;
        g.colors.add(p.color);
        if (g.ids.length < 12) g.ids.push(cellId(layout, row, col) + (ps.length > 1 ? `-${i + 1}` : ''));
        if (locate) {
          const key = locate(row, col)?.key ?? '';
          g.sheets.set(key, (g.sheets.get(key) ?? 0) + 1);
          let cs = g.sheetColors.get(key);
          if (!cs) g.sheetColors.set(key, (cs = new Set()));
          cs.add(p.color);
        }
      });
    }
  const groups = [...bySig.values()].sort((a, b) => b.count - a.count);
  groups.forEach((g, i) => (g.no = i + 1));
  return groups;
}
const groupView = (groups: TemplateGroup[]) =>
  groups.map((g) => ({
    no: g.no,
    sig: g.info.signature,
    count: g.count,
    color: g.color,
    ids: g.ids,
    colors: [...g.colors],
    sheets: [...g.sheets],
    sheetColors: [...g.sheetColors].map(([k, v]) => [k, [...v]]),
    w: g.info.w,
    h: g.info.h,
    edges: g.info.edges,
  }));

// ================================================================ 1. Seitenzahl, wie sie der Worker zurückgibt
describe('Seitenzahl des erzeugten PDFs (generatePdfReport, wie im Worker)', () => {
  for (const key of Object.keys(SAMPLES) as (keyof typeof SAMPLES)[]) {
    it(`${key}: pages = Seiten im PDF = Seitenplan der Vorabmessung; Aufteilung summiert sich zur Seitenzahl`, async () => {
      const p = sample(key);
      const opts: PdfOptions = { ...DEFAULT_PDF_OPTIONS, includeImages: false };
      const input = inputOf(p.layout, p.data, p.palette, p.sections);
      const facts = pdfLayoutFacts(input, opts);
      const plan = planPdfPages(p.layout, p.sections, opts, facts.stones, facts.templateGroups, facts);
      const rep = await generatePdfReport(input, opts);
      const b = rep.breakdown;
      expect(rep.pages, key).toBe(parsePdf(rep.pdf).pages.length);
      expect(plan.total, key).toBe(rep.pages);
      expect(plan.estimated, key).toEqual([]);
      expect(rep.planMatches, key).toBe(true);
      expect(b.front + b.sectionCovers + b.sectionSummaries + b.sheets + b.sheetLegends + b.cutLists + b.codePlans + b.templates + b.coords, key).toBe(rep.pages);
    }, 300000);
  }
});

// ================================================================ 2. Statistik in einem Durchlauf
describe('Statistik im PDF: computeAllStats für Abschnitte und Blätter', () => {
  it('Blätter als Gitter (sheetGridOf): jedes Blatt genau einmal, lückenlos; Statistik je Blatt = computeStats über den Blattbereich', () => {
    const p = specialProject();
    for (const o of [
      { ...DEFAULT_PDF_OPTIONS, sheetScale: 2 },
      { ...DEFAULT_PDF_OPTIONS, sheetScale: 4, format: 'a3' as const, orientation: 'landscape' as const },
      { ...DEFAULT_PDF_OPTIONS, sheetScale: 0 },
    ]) {
      const plan = planSheets(p.layout, p.sections, o);
      const sg = sheetGridOf(plan, p.sections);
      const all = plan.sections.flatMap((s) => s.sheets);
      expect(sg.keys.slice().sort()).toEqual(all.map((s) => s.key).sort());
      let cells = 0;
      for (const s of sg.grid.sections) cells += (s.r1 - s.r0) * (s.c1 - s.c0);
      expect(cells).toBe(p.layout.rows * p.layout.cols);
      if (o.sheetScale > 0) expect(all.length).toBeGreaterThan(p.sections.sections.length);
      // wie im PDF: der Zwischenspeicher ist durch die Gesamtstatistik schon gefüllt (gleiche Vertreter je Geometrie)
      const warm = () => {
        const c = new CutCache();
        computeStats(p.layout, p.data, p.palette, [], statOpts, undefined, c);
        return c;
      };
      const st = computeAllStats(p.layout, p.data, p.palette, [], statOpts, sg.grid, warm());
      const ref = warm();
      sg.grid.sections.forEach((s, i) => {
        const sh = all.find((x) => x.key === sg.keys[i])!;
        expect({ r0: s.r0, r1: s.r1, c0: s.c0, c1: s.c1 }).toEqual({ r0: sh.r0, r1: sh.r1, c0: sh.c0, c1: sh.c1 });
        expect(JSON.stringify(st.perSection[i]), sh.key).toBe(JSON.stringify(computeStats(p.layout, p.data, p.palette, [], statOpts, sh, ref)));
      });
    }
  });

  it('Farblegende je Blatt gleich, ob alle Abschnitte (ein Durchlauf) oder einer (je Blatt gezählt) exportiert werden', async () => {
    const p = specialProject();
    const opts: PdfOptions = { ...DEFAULT_PDF_OPTIONS, includeImages: false, includeCoords: false, includeTemplates: false, sheetScale: 2 };
    const input = inputOf(p.layout, p.data, p.palette, p.sections);
    const full = parsePdf((await generatePdfReport(input, opts)).pdf);
    const one = parsePdf((await generatePdfReport(input, { ...opts, sectionIds: ['B2'] })).pdf);
    const chips = (pp: ReturnType<typeof parsePdf>, page: number) => pp.pageStrings(page).filter((s) => /^\d{2} ×[\d.]+$/.test(s) || /^Steine auf diesem Blatt/.test(s));
    const fs = sheetPagesOf(full);
    const os = sheetPagesOf(one);
    expect(os.size).toBeGreaterThan(1);
    for (const [key, page] of os) {
      expect(key.startsWith('B2-')).toBe(true);
      const a = chips(one, page);
      expect(a.length, key).toBeGreaterThan(1);
      expect(a, key).toEqual(chips(full, fs.get(key)!));
    }
  }, 120000);
});

// ================================================================ 3. Schnittvorlagen sammeln
describe('collectTemplates: schneller Weg für ganze Zellen = bisherige Sammlung', () => {
  it('Beispiele, Sonderformen, Randzuschnitt und Material mit anderem Rohsteinmaß: gleiche Nummern, Stückzahlen, IDs, Blätter', () => {
    const cases: { name: string; layout: Layout; data: MosaicData; palette: PaletteColor[]; sections: SectionGrid; materials: Material[] }[] = [];
    for (const key of ['portrait', 'city'] as const) cases.push({ name: key, ...sample(key), materials: [] });
    const sp = specialProject();
    cases.push({ name: 'Sonderformen', ...sp, materials: [] });
    // Material mit Rohstein 20 × 10 mm für Farbe 0 und 7,5 × 7,5 für Farbe 1: andere Schnittanalyse ganzer Zellen
    const mats: Material[] = [
      { id: 'm1', type: 'glass', manufacturer: 'X', product: 'Groß', colorNumber: 'G1', widthMm: 10, lengthMm: 20 } as unknown as Material,
      { id: 'm2', type: 'glass', manufacturer: 'X', product: 'Mittel', colorNumber: 'G2', widthMm: 7.5, lengthMm: 7.5 } as unknown as Material,
    ];
    const pal = sp.palette.map((c, i) => (i === 0 ? { ...c, materialId: 'm1' } : i === 1 ? { ...c, materialId: 'm2' } : c));
    cases.push({ name: 'Material-Rohmaße', ...sp, palette: pal, materials: mats });
    for (const c of cases) {
      const plan = planSheets(c.layout, c.sections, DEFAULT_PDF_OPTIONS);
      const locate = makeSheetLocator(plan, c.sections, c.layout);
      const ref = referenceTemplates(c.layout, c.data, c.palette, c.materials, locate);
      const now = collectTemplates(c.layout, c.data, c.palette, c.materials, new CutCache(), locate);
      expect(ref.length, c.name).toBeGreaterThan(0);
      expect(groupView(now.groups), c.name).toEqual(groupView(ref));
      expect(now.bySig.size, c.name).toBe(ref.length);
    }
  }, 120000);
});

// ================================================================ 4. Koordinatenart
describe('Koordinatenart: eine Messung nennt die Seiten jeder Art', () => {
  it('gemessen mit kompakt, je Stein oder aus: Seitenplan jeder Art = Seiten des PDFs in dieser Art', async () => {
    const p = sample('portrait');
    const input = inputOf(p.layout, p.data, p.palette, p.sections);
    const base: PdfOptions = { ...DEFAULT_PDF_OPTIONS, includeImages: false, coordLimit: 1500 };
    const modes: { name: string; o: Partial<PdfOptions> }[] = [
      { name: 'kompakt', o: { includeCoords: true, coordMode: 'compact' } },
      { name: 'je Stein', o: { includeCoords: true, coordMode: 'perStone' } },
      { name: 'aus', o: { includeCoords: false } },
    ];
    const real = new Map<string, number>();
    for (const m of modes) real.set(m.name, (await generatePdfReport(input, { ...base, ...m.o })).pages);
    expect(new Set(real.values()).size).toBe(3);
    for (const measured of modes) {
      const facts = pdfLayoutFacts(input, { ...base, ...measured.o });
      expect(facts.coordPages, measured.name).toBeGreaterThan(0);
      for (const target of modes) {
        const o = { ...base, ...target.o };
        const plan = planForSelection(p.layout, p.sections, o, null, facts.stones, facts, null);
        expect(plan.total, `gemessen ${measured.name} → ${target.name}`).toBe(real.get(target.name));
        expect(plan.estimated, `gemessen ${measured.name} → ${target.name}`).toEqual([]);
      }
    }
  }, 300000);
});

// ================================================================ 5. Export in Teilen
describe('Teil-PDFs eines Projekts mit 6 Abschnitten', () => {
  const p = specialProject();
  const input = inputOf(p.layout, p.data, p.palette, p.sections);
  const opts: PdfOptions = { ...DEFAULT_PDF_OPTIONS, includeImages: false, sheetScale: 2 };
  const ids = p.sections.sections.map((s) => s.id);
  const PARTS = [ids.slice(0, 2), ids.slice(2, 4), ids.slice(4, 6)];

  it('Projekt hat genau 6 Abschnitte', () => {
    expect(ids).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  });

  it('„Teil 2/3 (Abschnitte B1-B2)“ in jeder Kopfzeile; T-Nummern je Blatt wie im ganzen Export; Steine je Farbe über alle Teile = Statistik', async () => {
    const fullRep = await generatePdfReport(input, opts);
    const full = parsePdf(fullRep.pdf);
    const fullSheets = sheetPagesOf(full);
    const tOf = (pp: ReturnType<typeof parsePdf>, page: number) =>
      pp
        .pageStrings(page)
        .filter((s) => /^T\d+$/.test(s))
        .sort();
    const fullTitles = new Set<number>();
    for (let i = 1; i <= full.pages.length; i++) for (const s of full.pageStrings(i)) for (const m of s.matchAll(/^Vorlage T(\d+)/g)) fullTitles.add(Number(m[1]));
    const groups = collectTemplates(p.layout, p.data, p.palette, [], new CutCache(), makeSheetLocator(planSheets(p.layout, p.sections, opts), p.sections, p.layout)).groups;
    const fills = new Map<string, number>();
    let anyT = 0;
    for (const [k, part] of PARTS.entries()) {
      const rep = await generatePdfReport({ ...input, part: { index: k, total: 3 } }, { ...opts, sectionIds: part });
      const pp = parsePdf(rep.pdf);
      expect(rep.pages).toBe(pp.pages.length);
      const head = `Teil ${k + 1}/3 (Abschnitte ${part[0]}-${part[1]})`;
      for (let i = 1; i <= pp.pages.length; i++) {
        // Kopfzeile = erster Text der Seite
        expect(pp.pageStrings(i)[0], `Teil ${k + 1}, Seite ${i}`).toContain(head);
      }
      const sheets = sheetPagesOf(pp);
      expect(sheets.size).toBeGreaterThan(0);
      for (const [key, page] of sheets) {
        expect(part).toContain(key.split('-')[0]);
        const tHere = tOf(pp, page);
        anyT += tHere.length;
        expect(tHere, key).toEqual(tOf(full, fullSheets.get(key)!));
        for (const [c, v] of countFills(pp.pageContent(page))) fills.set(c, (fills.get(c) ?? 0) + v);
      }
      // Vorlagen dieses Teils: genau die in seinen Abschnitten vorkommenden – mit den globalen Nummern des ganzen Exports
      const titles = new Set<number>();
      for (let i = 1; i <= pp.pages.length; i++) for (const s of pp.pageStrings(i)) for (const m of s.matchAll(/^Vorlage T(\d+)/g)) titles.add(Number(m[1]));
      const keys = new Set(planSheets(p.layout, p.sections, opts).sections.filter((s) => part.includes(s.section.id)).flatMap((s) => s.sheets.map((sh) => sh.key)));
      const expected = groups.filter((g) => [...g.sheets.keys()].some((x) => keys.has(x))).map((g) => g.no);
      expect([...titles].sort((a, b) => a - b), `Teil ${k + 1}`).toEqual(expected.sort((a, b) => a - b));
      for (const no of titles) expect(fullTitles.has(no)).toBe(true);
    }
    expect(anyT).toBeGreaterThan(0);
    const stats = computeStats(p.layout, p.data, p.palette, [], statOpts);
    const expected = new Map<string, number>();
    p.palette.forEach((c, i) => {
      const key = fmtColor(c.hex);
      expected.set(key, (expected.get(key) ?? 0) + stats.perColor[i].pieces);
    });
    let sum = 0;
    for (const v of fills.values()) sum += v;
    expect(sum).toBe(stats.pieces);
    for (const [c, v] of expected) expect(fills.get(c) ?? 0, c).toBe(v);
  }, 300000);

  it('langer Projektname: die Teilangabe in der Kopfzeile wird nie gekürzt, nur der Name', async () => {
    const long = 'Ein sehr langer Projektname für das Wohnzimmer mit Meerblick und Sonnenuntergang '.repeat(3);
    const rep = await generatePdfReport({ ...inputOf(p.layout, p.data, p.palette, p.sections, [], long), part: { index: 2, total: 3 } }, { ...opts, sectionIds: PARTS[2] });
    const pp = parsePdf(rep.pdf);
    for (let i = 1; i <= pp.pages.length; i++) {
      const h = pp.pageStrings(i)[0];
      expect(h).toContain('Teil 3/3 (Abschnitte C1-C2)');
      expect(h).not.toContain(long.trim());
      expect(h.startsWith('MosaicPlan · Ein sehr langer')).toBe(true);
    }
  }, 120000);

  it('ohne Teil keine Teilangabe in der Kopfzeile', async () => {
    const pp = parsePdf((await generatePdfReport(input, { ...opts, sectionIds: PARTS[1], includeCoords: false })).pdf);
    for (let i = 1; i <= pp.pages.length; i++) expect(pp.pageStrings(i)[0]).not.toMatch(/Teil \d+\/\d+/);
  }, 120000);
});

// ================================================================ 6. Übersetzungen
describe('Übersetzungen w6-pdf-finish', () => {
  it('alle neuen Schlüssel in DE, EN und TR', () => {
    const keys = Object.keys(dictionaries.de).filter((k) => k.startsWith('w6pf.'));
    expect(keys.length).toBeGreaterThan(10);
    for (const lang of ['en', 'tr'] as const) for (const k of keys) expect(dictionaries[lang][k as keyof (typeof dictionaries)['de']], `${lang} ${k}`).toBeTruthy();
  });
});
