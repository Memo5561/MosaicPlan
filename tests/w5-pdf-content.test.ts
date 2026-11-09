/**
 * Welle 5 – PDF-Inhalt:
 *  - Farblegende je Verlegeblatt: Zahlen = computeStats über den Blattbereich; Summe der Blätter = Abschnitt; die gedruckten
 *    Felder „07 ×123“ eines Blatts = gezeichnete Steine je Farbe auf diesem Blatt; eigene Legendenseite, wenn kein Platz ist.
 *  - Schnittvorlagen: Maßzahlen = f1(ci.edges[i]); keine Zahl überdeckt Titel, Text, 1:1-Kontur, Stein, Schnittlinien oder
 *    eine andere Zahl; keine Textzeile fällt weg; Kastenhöhe folgt dem Inhalt.
 *  - Kompakte Koordinaten: jeder Stein (Position, X/Y, Farbe) ist aus Spalten-/Zeilentabelle + Farbfolge bzw. Sonderteilen
 *    ablesbar und stimmt mit cellPieces überein; Summe = Steine; 200 × 100 cm in höchstens 70 Seiten.
 *  - Gesamtübersicht großer Projekte im Kartenraster; Seitenplan = PDF auch mit Legendenseiten.
 */
import { inflateSync } from 'node:zlib';
import { jsPDF } from 'jspdf';
import { describe, expect, it } from 'vitest';
import { hexToLab, hexToRgb } from '../src/core/color';
import { buildCompactCoords, CoordFlow, readCompactCoords, runToken } from '../src/core/coords';
import { bbox, fmtMm } from '../src/core/geometry';
import { computeLayout, computeSections, pieceId, sectionsFor, type Layout, type SectionGrid } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { collectTemplates, coordModeOf, DEFAULT_PDF_OPTIONS, generatePdfReport, overviewLayout, pdfLayoutFacts, type PdfInput, type PdfOptions } from '../src/core/pdf';
import { layoutTemplateBoxes, legendHeight, placeSheetLegend, planPdfPages, planSheets, sheetLegendGeometry, SHEET_LEGEND } from '../src/core/pdfPlan';
import { PT_MM, type Measure } from '../src/core/pdfTable';
import { analyzeCut, cellPieces, cutLineItems, type CutInfo } from '../src/core/pieces';
import { CutCache, computeStats, makeRawSizeFn, pieceCutInfo } from '../src/core/stats';
import { layoutTemplate, polysIntersect, segmentHitsPoly, TPL, type TemplateLayout } from '../src/core/templateLayout';
import { CellKind, createEmptyMosaic, DEFAULT_SETTINGS, DEFAULT_SHAPES, type Material, type MosaicData, type PaletteColor } from '../src/core/types';
import { makeT } from '../src/i18n';
import { loadPng, prepareFor } from './helpers';

// ---------------------------------------------------------------- kleiner PDF-Leser (jsPDF-Ausgabe)
function pdfString(raw: string): string {
  const s = raw.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) =>
    /^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e,
  );
  const win: Record<number, string> = { 0x80: '€', 0x84: '„', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—' };
  return s.replace(/[\u0080-\u009f]/g, (c) => win[c.charCodeAt(0)] ?? c);
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
  const pageText = (pageNo: number) => pageStrings(pageNo).join('\n');
  const outline: { title: string; page: number; parent: number | null; id: number }[] = [];
  for (const [id, o] of objs) {
    const dest = o.match(/\/Dest \[(\d+) 0 R/);
    const title = o.match(/\/Title \(((?:\\.|[^\\)])*)\)/);
    if (!dest || !title) continue;
    const parent = o.match(/\/Parent (\d+) 0 R/);
    outline.push({ id, title: pdfString(title[1]), page: pages.indexOf(Number(dest[1])) + 1, parent: parent ? Number(parent[1]) : null });
  }
  return { raw, pages, pageContent, pageStrings, pageText, outline };
}
/** gefüllte+umrandete Flächen („B“) je Füllfarbe außerhalb von Textblöcken */
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
const f1 = (v: number, d = 1) => fmtMm(v, d, 'de');

// ---------------------------------------------------------------- Textmessung wie im PDF (Helvetica, mm je pt)
const mdoc = new jsPDF({ unit: 'mm' });
const fonts = { normal: (mdoc.internal as unknown as { getFont: (n: string, s: string) => unknown }).getFont('helvetica', 'normal'), bold: (mdoc.internal as unknown as { getFont: (n: string, s: string) => unknown }).getFont('helvetica', 'bold') };
const measure: Measure = (s, bold) => (s ? mdoc.getStringUnitWidth(s, { font: bold ? fonts.bold : fonts.normal, fontSize: 10 } as never) * PT_MM : 0);

const tDe = makeT('de');
const pc = (code: number, hex: string, materialId?: string): PaletteColor => ({ code, hex, name: `Farbe ${code}`, lab: hexToLab(hex), materialId });
const baseInput = (layout: Layout, data: MosaicData, palette: PaletteColor[], sections: SectionGrid, materials: Material[] = []): PdfInput => ({
  projectName: 'W5',
  dateStr: '09.11.2026',
  layout,
  data,
  palette,
  materials,
  settings: { ...DEFAULT_SETTINGS, reservePct: 10 },
  sections,
  t: tDe,
  locale: 'de',
});
const lean: PdfOptions = { ...DEFAULT_PDF_OPTIONS, includeImages: false, includeTemplates: false, includeCoords: false };

function sample(key: 'portrait' | 'landscape' | 'animal' | 'city', w: number, tile: number, colors = 24, edgeMode: 'whole' | 'cut-end' | 'cut-both' = 'cut-end') {
  const img0 = loadPng(`public/samples/${key}.png`);
  const h = Math.round(w / (img0.width / img0.height));
  const layout = computeLayout({ widthMm: w, heightMm: h, tileW: tile, tileH: tile, joint: tile >= 8 ? 1.5 : 1, edgeMode, minCutMm: tile <= 2 ? 0.8 : 2 });
  const res = computeMosaic(prepareFor(img0, layout), { layout, shapes: DEFAULT_SHAPES, paletteMode: 'auto', colorCount: colors, dither: 0, deltaE: '2000', regions: [] });
  const settings = { ...DEFAULT_SETTINGS, widthMm: w, heightMm: h, tileW: tile, tileH: tile };
  return { layout, data: res.data, palette: res.palette, sections: sectionsFor(layout, settings) };
}

/** Mosaik aus ganzen Steinen, n Farben, jede `diagEvery`-te Zelle diagonal geteilt */
function squares(widthMm: number, heightMm: number, tile: number, nColors: number, diagEvery = 0, joint = 1) {
  const layout = computeLayout({ widthMm, heightMm, tileW: tile, tileH: tile, joint, edgeMode: 'whole', minCutMm: 2 });
  const data = createEmptyMosaic(layout.cols, layout.rows);
  for (let i = 0; i < data.c1.length; i++) {
    data.c1[i] = (i * 7 + Math.floor(i / layout.cols) * 3) % nColors;
    if (diagEvery && i % diagEvery === 3) {
      data.kind[i] = CellKind.DIAG_A;
      data.c2[i] = (data.c1[i] + 1) % nColors;
    }
  }
  const palette = Array.from({ length: nColors }, (_, i) => {
    const v = (i * 97) % 256;
    const hex = `#${[v, (v * 3 + 40) % 256, (255 - v) % 256].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    return pc(i + 1, hex);
  });
  return { layout, data, palette };
}

// ================================================================ Farblegende je Verlegeblatt
describe('Farblegende je Verlegeblatt', () => {
  it('Summe der Blattlegenden = Abschnittslegende = Statistik (4 Beispielprojekte)', () => {
    for (const [key, w, tile] of [
      ['portrait', 400, 5],
      ['landscape', 900, 8],
      ['animal', 500, 6],
      ['city', 1200, 10],
    ] as const) {
      const p = sample(key, w, tile);
      const cache = new CutCache();
      const opts = { reservePct: 10, groutDepthMm: 3 };
      const total = computeStats(p.layout, p.data, p.palette, [], opts, undefined, cache);
      const plan = planSheets(p.layout, p.sections, DEFAULT_PDF_OPTIONS);
      let all = 0;
      for (const ss of plan.sections) {
        const sec = computeStats(p.layout, p.data, p.palette, [], opts, ss.section, cache);
        const sum = new Array(p.palette.length).fill(0);
        let cut = 0;
        for (const sh of ss.sheets) {
          const st = computeStats(p.layout, p.data, p.palette, [], opts, sh, cache);
          st.perColor.forEach((c, i) => (sum[i] += c.pieces));
          cut += st.cutPieces;
          all += st.pieces;
        }
        expect(sum, `${key} ${ss.section.id}`).toEqual(sec.perColor.map((c) => c.pieces));
        expect(cut).toBe(sec.cutPieces);
      }
      expect(all).toBe(total.pieces);
    }
  }, 120000);

  it('PDF: Felder „07 ×123“ eines Blatts = gezeichnete Steine je Farbe auf diesem Blatt; Farbfelder ohne „B“', async () => {
    const p = sample('portrait', 300, 5, 24);
    const rep = await generatePdfReport(baseInput(p.layout, p.data, p.palette, p.sections), lean);
    expect(rep.planMatches).toBe(true);
    const pdf = parsePdf(rep.pdf);
    const byCode = new Map(p.palette.map((q) => [String(q.code).padStart(2, '0'), fmtColor(q.hex)]));
    const stats = computeStats(p.layout, p.data, p.palette, [], { reservePct: 10, groutDepthMm: 3 });
    let sheets = 0;
    let legendSum = 0;
    for (let i = 1; i <= pdf.pages.length; i++) {
      const txt = pdf.pageText(i);
      if (!(txt.includes('Kontrollstrecke') && /Blatt [A-Z]+\d+-\d+ \(/.test(txt))) continue;
      sheets++;
      // Legende auf dem Blatt oder auf der folgenden Seite „Legende zu Blatt …“
      let strs = pdf.pageStrings(i);
      if (!strs.some((s) => s.startsWith('Steine auf diesem Blatt'))) {
        expect(pdf.pageText(i + 1)).toContain('Legende zu Blatt');
        strs = pdf.pageStrings(i + 1);
      }
      const head = strs.find((s) => s.startsWith('Steine auf diesem Blatt'))!;
      const n = Number(/Blatt: ([\d.]+)/.exec(head)![1].replace(/\./g, ''));
      const chips = new Map<string, number>();
      for (const s of strs) {
        const m = /^(\d{2}) ×([\d.]+)$/.exec(s);
        if (m) chips.set(byCode.get(m[1])!, Number(m[2].replace(/\./g, '')));
      }
      const fills = countFills(pdf.pageContent(i));
      let sum = 0;
      for (const [k, v] of chips) {
        expect(fills.get(k) ?? 0, `Seite ${i} Farbe ${k}`).toBe(v);
        sum += v;
      }
      for (const [k, v] of fills) expect(chips.get(k) ?? 0, `Seite ${i} Fläche ${k}`).toBe(v);
      expect(sum).toBe(n);
      legendSum += sum;
    }
    expect(sheets).toBe(rep.breakdown.sheets);
    expect(legendSum).toBe(stats.pieces);
  }, 120000);

  it('kein Platz auf dem Blatt: eigene Seite „Legende zu Blatt …“ direkt danach, ohne Kontrollstrecke; Verweis und Seitenplan stimmen', async () => {
    // Mosaik füllt das A4-Blatt (178 × 247 mm bei 1:1) und hat viele Farben → weder Band noch rechte Spalte
    const { layout, data, palette } = squares(178, 245, 5, 64, 0, 1);
    const sections = computeSections(layout, 400, 400);
    const input = baseInput(layout, data, palette, sections);
    const plan = planSheets(layout, sections, lean);
    expect(plan.sections[0].sheets.length).toBe(1);
    const g = sheetLegendGeometry(layout, plan.sections[0].sheets[0], sections.sections[0], sections, 1, 210, 297);
    expect(placeSheetLegend(64, g, 210, 297).kind).toBe('page');
    const rep = await generatePdfReport(input, lean);
    expect(rep.breakdown.sheetLegends).toBe(1);
    expect(rep.planMatches).toBe(true);
    const facts = pdfLayoutFacts(input, lean);
    expect(Object.values(facts.sheets).map((s) => s.legendPages)).toEqual([1]);
    expect(planPdfPages(layout, sections, lean, facts.stones, facts.templateGroups, facts).total).toBe(rep.pages);
    // ohne Messwerte geschätzt (Farben unbekannt) – und so gekennzeichnet
    const est = planPdfPages(layout, sections, lean, { A1: { pieces: 1, colors: 64 } });
    expect(est.sheetLegends).toBe(1);
    expect(est.estimated).toContain('sheetLegends');
    const pdf = parsePdf(rep.pdf);
    const sheetNode = pdf.outline.find((o) => o.title === 'Blatt A1-1')!;
    const legendNode = pdf.outline.find((o) => o.title === 'Legende A1-1')!;
    expect(legendNode.parent).toBe(sheetNode.id);
    expect(legendNode.page).toBe(sheetNode.page + 1);
    const lp = pdf.pageText(legendNode.page);
    expect(lp).toContain('Legende zu Blatt A1-1');
    expect(lp).not.toContain('Kontrollstrecke');
    expect(pdf.pageText(sheetNode.page).replace(/\s+/g, ' ')).toContain(`Farblegende dieses Blatts: S. ${legendNode.page}.`);
    let sum = 0;
    let chips = 0;
    for (const s of pdf.pageStrings(legendNode.page)) {
      const m = /^(\d{2}) ×([\d.]+)$/.exec(s);
      if (m) {
        chips++;
        sum += Number(m[2].replace(/\./g, ''));
      }
    }
    expect(chips).toBe(64);
    expect(sum).toBe(computeStats(layout, data, palette, [], { reservePct: 0, groutDepthMm: 3 }).pieces);
    // Legendenseite: Farbfelder nur mit 'f'/'S' – keine „B“-Flächen außerhalb der Blätter
    expect(countFills(pdf.pageContent(legendNode.page)).size).toBe(0);
  }, 120000);

  it('Platzwahl: Band unter dem Mosaik, sonst rechte Spalte, sonst schmale Felder, sonst eigene Seite', () => {
    const L = SHEET_LEGEND;
    const area = (w: number, h: number) => ({ x: 0, y: 0, w, h });
    expect(placeSheetLegend(8, { band: area(190, 40), right: area(10, 200) }, 210, 297)).toMatchObject({ kind: 'band', chipW: L.chipW });
    expect(placeSheetLegend(8, { band: area(190, 5), right: area(50, 200) }, 210, 297)).toMatchObject({ kind: 'right', chipW: L.chipW });
    expect(placeSheetLegend(14, { band: area(190, 20), right: area(10, 200) }, 210, 297)).toMatchObject({ kind: 'band', chipW: L.narrowW });
    expect(placeSheetLegend(30, { band: area(190, 2), right: area(28, 240) }, 210, 297)).toMatchObject({ kind: 'right', chipW: L.narrowW });
    expect(placeSheetLegend(30, { band: area(190, 2), right: area(10, 240) }, 210, 297)).toMatchObject({ kind: 'page', pages: 1 });
    expect(legendHeight(8, 190)).toBe(L.headH + 2 * L.chipH);
  });
});

// ================================================================ Schnittvorlagen
function texts(ci: CutInfo, no: number, count: number) {
  const cuts = cutLineItems(ci).map((it) => `${it.kind === 'through' ? 'Schnitt' : 'Einschnitt'} ${it.no}: (${f1(it.a.x)}; ${f1(it.a.y)}) → (${f1(it.b.x)}; ${f1(it.b.y)})`);
  const warnings: string[] = [];
  if (!ci.convex) warnings.push('nicht konvex – Schnitte, die an einer Innenecke enden, nicht brechen: ausknabbern/schleifen');
  if (!ci.fits) warnings.push('Achtung: Teil größer als Rohstein');
  return {
    title: `Vorlage T${no}`,
    subtitle: `Individuell zugeschnitten · ${count}×`,
    warnings,
    head: (zoom: number) => [
      `Rohstein: ${f1(ci.rawW)} × ${f1(ci.rawH)} mm · Maßstab ${f1(zoom)}:1`,
      `Außenmaß: ${f1(ci.w)} × ${f1(ci.h)} mm · Fläche: ${f1(ci.area)} mm²`,
      `Winkel: ${ci.angles.map((a) => `${f1(a)}°`).join(', ')}`,
    ],
    cuts,
    tail: ['Farben: 01, 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 15, 16, 17'],
    occ: (max: number, wrap: (s: string) => string[]) => wrap('Blätter: A1-1: 3×, A1-2: 5×, A1-3: 1×, B1-1: 2×, B1-2: 4×, B1-3: 9×, C1-1: 1×').slice(0, max),
    edgeLabel: (i: number) => f1(ci.edges[i]),
  };
}

function checkTemplate(L: TemplateLayout, ci: CutInfo, where: string) {
  const rect = (r: { x: number; y: number; w: number; h: number }) => [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  expect(L.labels.length, where).toBe(ci.polyInRaw.length);
  const title = rect(L.titleRect);
  const textR = rect({ ...L.text.rect, y: L.text.rect.y - 0.2 });
  for (let i = 0; i < L.labels.length; i++) {
    const lb = L.labels[i];
    expect(lb.edge, where).toBe(i);
    expect(lb.text, where).toBe(f1(ci.edges[i]));
    expect(polysIntersect(lb.poly, title), `${where}: Zahl ${i} im Titel`).toBe(false);
    expect(polysIntersect(lb.poly, textR), `${where}: Zahl ${i} im Text`).toBe(false);
    if (L.contour) expect(polysIntersect(lb.poly, rect(L.contour.rect)), `${where}: Zahl ${i} auf 1:1-Kontur`).toBe(false);
    expect(polysIntersect(lb.poly, L.piece), `${where}: Zahl ${i} auf dem Stein`).toBe(false);
    for (const c of L.cuts) expect(segmentHitsPoly(c.pa, c.pb, lb.poly), `${where}: Zahl ${i} auf Schnitt`).toBe(false);
    for (let j = 0; j < i; j++) expect(polysIntersect(lb.poly, L.labels[j].poly), `${where}: Zahl ${i} auf Zahl ${j}`).toBe(false);
    for (const p of lb.poly) {
      expect(p.x >= 0 && p.x <= L.w, `${where}: Zahl ${i} im Kasten (x)`).toBe(true);
      expect(p.y >= L.titleRect.h - 1e-9 && p.y <= L.text.rect.y, `${where}: Zahl ${i} über dem Text`).toBe(true);
    }
  }
  // Text: Zeilen im Abstand 2,4 mm, letzte Zeile im Kasten
  L.text.lines.forEach((l, i) => i > 0 && expect(l.y - L.text.lines[i - 1].y).toBeCloseTo(TPL.lineH, 9));
  expect(L.text.rect.y + L.text.lines.length * TPL.lineH).toBeLessThanOrEqual(L.h + 1e-9);
  if (L.contour) expect(polysIntersect(rect(L.contour.rect), rect(L.titleRect))).toBe(false);
}

describe('Schnittvorlagen: Maßlinien ohne Überdeckung, kein Text fällt weg', () => {
  const configs: [string, ReturnType<typeof sample>][] = [];
  for (const [key, w, tile] of [
    ['portrait', 302, 3],
    ['landscape', 500, 5],
    ['animal', 500, 10],
    ['city', 800, 12],
  ] as const)
    configs.push([`${key} ${tile} mm`, sample(key, w, tile, 24)]);

  for (const [name, p] of configs)
    it(name, () => {
      const tpl = collectTemplates(p.layout, p.data, p.palette, []);
      expect(tpl.groups.length, name).toBeGreaterThan(0);
      for (const g of tpl.groups) {
        const tx = texts(g.info, g.no, g.count);
        const L = layoutTemplate(g.info, tx, measure, { maxSpan: 3 });
        checkTemplate(L, g.info, `${name} T${g.no}`);
        // jede gebaute Zeile steht im Kasten (umbrochen, nichts weggelassen)
        const built = [...tx.warnings, ...tx.head(L.zoom), ...tx.cuts, ...tx.tail].join(' ').replace(/\s+/g, ' ');
        const printed = L.text.lines.map((l) => l.s).join(' ').replace(/\s+/g, ' ');
        expect(printed.startsWith(built), `${name} T${g.no}`).toBe(true);
        expect(TPL.zooms).toContain(L.zoom);
      }
    });

  it('Material mit 20-mm-Rohstein (10-mm-Raster): Maßstab 1,5:1 statt 1:1, Zahlen frei', () => {
    const p = sample('portrait', 400, 10, 12);
    const mat: Material = { id: 'm20', type: 'glass', manufacturer: 'Test', product: 'Groß', colorNumber: 'G-20', colorName: '', hex: '#808080', lengthMm: 20, widthMm: 20, thicknessMm: 4, price: 0, packageSize: '', piecesPerPack: 0 };
    const palette = p.palette.map((q) => ({ ...q, materialId: 'm20' }));
    const tpl = collectTemplates(p.layout, p.data, palette, [mat]);
    expect(tpl.groups.length).toBeGreaterThan(0);
    const zooms = new Set<number>();
    for (const g of tpl.groups) {
      expect(g.info.rawW).toBe(20);
      const L = layoutTemplate(g.info, texts(g.info, g.no, g.count), measure, { maxSpan: 3 });
      checkTemplate(L, g.info, `20mm T${g.no}`);
      zooms.add(L.zoom);
    }
    expect([...zooms].every((z) => z >= 1.5)).toBe(true);
  });

  it('Freiform: nicht konvexes L-Teil mit Einschnitt, Achteck mit kurzen Kanten, winziges Teil – Zahlen frei, Warnung zuerst', () => {
    const shapes: [string, { x: number; y: number }[], number][] = [
      ['L', [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 8 }, { x: 0, y: 8 }], 10],
      ['Achteck', [{ x: 1, y: 0 }, { x: 4, y: 0 }, { x: 5, y: 1 }, { x: 5, y: 4 }, { x: 4, y: 5 }, { x: 1, y: 5 }, { x: 0, y: 4 }, { x: 0, y: 1 }], 5],
      ['klein', [{ x: 0, y: 0 }, { x: 1.2, y: 0 }, { x: 0, y: 1.6 }], 2],
    ];
    for (const [name, poly, rawSize] of shapes) {
      const ci = analyzeCut(poly, rawSize, rawSize);
      const tx = texts(ci, 1, 1);
      const L = layoutTemplate(ci, tx, measure, { maxSpan: 3 });
      checkTemplate(L, ci, name);
      if (!ci.convex) expect(L.text.lines[0].warn, name).toBe(true);
    }
  });

  it('Kastenreihen: Höhe = größter Kasten der Reihe, Seitenumbruch nach Höhe; Anzahl allein = feste Kästen (Schätzung)', () => {
    const lay = layoutTemplateBoxes(
      [
        { h: 50, span: 1 },
        { h: 70, span: 1 },
        { h: 40, span: 1 },
        { h: 60, span: 2 },
        { h: 45, span: 1 },
      ],
      false,
      210,
      297,
    );
    expect(lay.boxes.slice(0, 3).map((b) => b.h)).toEqual([70, 70, 70]);
    expect(lay.boxes[3]).toMatchObject({ w: 120, h: 60, y: lay.boxes[0].y + 70 });
    expect(lay.boxes[4]).toMatchObject({ x: 10 + 120, y: lay.boxes[3].y });
    expect(layoutTemplateBoxes(9, false, 210, 297).pages).toBe(1);
    expect(layoutTemplateBoxes(10, false, 210, 297).pages).toBe(2);
  });

  it('PDF: Vorlagen-Seiten gleich dem Seitenplan; ohne Messwerte als geschätzt gekennzeichnet', async () => {
    const p = sample('animal', 400, 6, 24);
    const input = baseInput(p.layout, p.data, p.palette, p.sections);
    const opts = { ...lean, includeTemplates: true };
    const rep = await generatePdfReport(input, opts);
    const facts = pdfLayoutFacts(input, opts);
    expect(facts.templateBoxes!.length).toBe(Math.min(facts.templateGroups, opts.templateLimit));
    const plan = planPdfPages(p.layout, p.sections, opts, facts.stones, facts.templateGroups, facts);
    expect(plan.templates).toBe(rep.breakdown.templates);
    expect(plan.total).toBe(rep.pages);
    expect(planPdfPages(p.layout, p.sections, opts, facts.stones, facts.templateGroups).estimated).toContain('templates');
  }, 120000);
});

// ================================================================ Kompakte Koordinaten
describe('Kompakte Koordinaten: vollständig und exakt', () => {
  const check = (layout: Layout, data: MosaicData, palette: PaletteColor[], sections: SectionGrid, materials: Material[] = [], where = '') => {
    const raw = makeRawSizeFn(layout, palette, materials);
    const cache = new CutCache();
    let totalAll = 0;
    let specialAll = 0;
    for (const sec of sections.sections) {
      const cc = buildCompactCoords(layout, data, raw, sec, cache);
      const read = readCompactCoords(cc, layout);
      const byId = new Map(read.map((s) => [s.id, s]));
      expect(byId.size, `${where} ${sec.id}: jede Position einmal`).toBe(read.length);
      let n = 0;
      for (let row = sec.r0; row < sec.r1; row++)
        for (let col = sec.c0; col < sec.c1; col++) {
          const ps = cellPieces(layout, data, row, col);
          ps.forEach((p, i) => {
            const ci = pieceCutInfo(cache, layout, data, row, col, i, p.poly, raw(p.color));
            if (ci.invalid) return;
            n++;
            const id = pieceId(layout, row, col, i, ps.length);
            const s = byId.get(id);
            expect(s, `${where} ${id}`).toBeTruthy();
            const b = bbox(p.poly);
            expect(s!.x, id).toBe(b.minX);
            expect(s!.y, id).toBe(b.minY);
            expect(s!.color, id).toBe(p.color);
            if (!s!.special) {
              expect(data.kind[row * layout.cols + col]).toBe(CellKind.FULL);
              expect(ci.needsCut).toBe(false);
              expect(s!.w).toBe(layout.colW[col]);
              expect(s!.h).toBe(layout.rowH[row]);
            }
          });
        }
      const st = computeStats(layout, data, palette, materials, { reservePct: 0, groutDepthMm: 3 }, sec, cache);
      expect(read.length, `${where} ${sec.id}`).toBe(n);
      expect(cc.total).toBe(st.pieces);
      expect(cc.whole + cc.specials.length).toBe(st.pieces);
      // jeder zugeschnittene Stein steht einzeln (mit Vorlage) – nie still in der Farbfolge
      expect(cc.specials.filter((x) => x.needsCut).length).toBe(st.cutPieces);
      totalAll += cc.total;
      specialAll += cc.specials.length;
    }
    expect(totalAll).toBe(computeStats(layout, data, palette, materials, { reservePct: 0, groutDepthMm: 3 }).pieces);
    return { totalAll, specialAll };
  };

  it('vier Beispielprojekte (Randzuschnitt rechts/unten): jeder Stein aus den Tabellen ablesbar = cellPieces', () => {
    for (const [key, w, tile] of [
      ['portrait', 300, 5],
      ['landscape', 600, 8],
      ['animal', 400, 6],
      ['city', 900, 10],
    ] as const) {
      const p = sample(key, w, tile);
      check(p.layout, p.data, p.palette, p.sections, [], key);
    }
  }, 120000);

  it('2-mm-Steine, symmetrischer Randzuschnitt und anderes Rohsteinmaß', () => {
    const a = sample('animal', 150, 2, 16);
    check(a.layout, a.data, a.palette, a.sections, [], '2 mm');
    const b = sample('portrait', 303, 5, 16, 'cut-both');
    const r = check(b.layout, b.data, b.palette, b.sections, [], 'cut-both');
    expect(r.specialAll).toBeGreaterThan(0);
    // Material 10 × 10 mm auf 5-mm-Raster: jeder Stein wird zugeschnitten → alle als Sonderteile
    const mat: Material = { id: 'm', type: 'glass', manufacturer: 'X', product: 'Y', colorNumber: 'Z', colorName: '', hex: '#808080', lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 0, packageSize: '', piecesPerPack: 0 };
    const pal = b.palette.map((q, i) => (i === 0 ? { ...q, materialId: 'm' } : q));
    check(b.layout, b.data, pal, b.sections, [mat], 'Material');
  }, 120000);

  it('Farbfolge: Läufe „1–6 → 09“, Sonderzellen „7 ◆“', () => {
    expect(runToken({ kind: 'color', c0: 0, c1: 6, color: 8 }, (c) => String(c + 1).padStart(2, '0'))).toBe('1–6 → 09');
    expect(runToken({ kind: 'color', c0: 6, c1: 7, color: 0 }, () => '01')).toBe('7 → 01');
    expect(runToken({ kind: 'special', c0: 6, c1: 9 }, () => '')).toBe('7–9 ◆');
    const { layout, data, palette } = squares(60, 30, 5, 2, 5);
    const sections = computeSections(layout, 300, 300);
    const cc = buildCompactCoords(layout, data, makeRawSizeFn(layout, palette, []), sections.sections[0], new CutCache());
    for (const rr of cc.runs) {
      // Läufe decken die Zeile lückenlos ab
      let c = 0;
      for (const it of rr.items) {
        expect(it.c0).toBe(c);
        c = it.c1;
      }
      expect(c).toBe(layout.cols);
    }
  });

  it('Seitenlayout: Seiten gezählt (Seitenplan) = gezeichnet', () => {
    const p = sample('portrait', 300, 5, 24);
    const raw = makeRawSizeFn(p.layout, p.palette, []);
    const cache = new CutCache();
    const flows = [new CoordFlow({ M: 10, AW: 190, top: 14, bottom: 279 }, measure, true), new CoordFlow({ M: 10, AW: 190, top: 14, bottom: 279 }, measure, false)];
    for (const f of flows) {
      f.intro('Koordinaten', 'Einleitung '.repeat(40));
      for (const sec of p.sections.sections) {
        const cc = buildCompactCoords(p.layout, p.data, raw, sec, cache);
        f.section({
          id: sec.id,
          title: `Koordinaten – Abschnitt ${sec.id}`,
          example: null,
          colsHead: 'Spalten',
          colEntries: cc.cols.map((c) => `${c.label}: ${f1(c.start, 2)}–${f1(c.end, 2)}`),
          rowsHead: 'Zeilen',
          rowEntries: cc.rows.map((c) => `${c.label}: ${f1(c.start, 2)}–${f1(c.end, 2)}`),
          trimNotes: [],
          runsHead: 'Farbfolge',
          runRows: cc.runs.map((r) => ({ label: r.label, tokens: r.items.map((it) => runToken(it, (c) => String(c).padStart(2, '0'))) })),
          specialHead: 'Sonderteile',
          specialHeader: ['Position', 'Nr.', 'Form', 'Größe', 'X', 'Y', 'Zuschnitt'],
          specialAlign: ['left', 'left', 'left', 'left', 'left', 'left', 'left'],
          specialRows: cc.specials.map((s) => [s.id, '01', s.shape, `${f1(s.w)} × ${f1(s.h)}`, `${f1(s.minX)}–${f1(s.maxX)}`, `${f1(s.minY)}–${f1(s.maxY)}`, 'ja']),
          cont: '(Forts.)',
          control: 'Kontrolle',
          controlOk: true,
        });
      }
    }
    expect(flows[1].pages.length).toBe(flows[0].pages.length);
    // nichts unter dem Seitenende
    for (const pg of flows[0].pages) for (const o of pg.ops) expect(o.y).toBeLessThanOrEqual(279 + 1e-6);
  });

  it('PDF: Kapitel kompakt, jede Position-Zeile/Spalte genannt, Kontrollsumme = Steine; kein Kürzungshinweis', async () => {
    const p = sample('portrait', 300, 5, 24);
    const input = baseInput(p.layout, p.data, p.palette, p.sections);
    const opts: PdfOptions = { ...lean, includeCoords: true, coordLimit: 10 };
    expect(coordModeOf(opts)).toBe('compact');
    const rep = await generatePdfReport(input, opts);
    expect(rep.planMatches).toBe(true);
    const pdf = parsePdf(rep.pdf);
    const coordsNode = pdf.outline.find((o) => o.title === 'Koordinaten')!;
    const secNodes = pdf.outline.filter((o) => o.parent === coordsNode.id);
    expect(secNodes.map((o) => o.title)).toEqual(p.sections.sections.map((s) => `Abschnitt ${s.id}`));
    const txt = Array.from({ length: pdf.pages.length }, (_, i) => pdf.pageText(i + 1))
      .join('\n')
      .replace(/[ \t]+/g, ' ');
    expect(txt).not.toMatch(/gekürzt/);
    const cache = new CutCache();
    for (const sec of p.sections.sections) {
      const st = computeStats(p.layout, p.data, p.palette, [], { reservePct: 10, groutDepthMm: 3 }, sec, cache);
      expect(txt).toContain(`Koordinaten – Abschnitt ${sec.id} (${st.pieces.toLocaleString('de-DE')} Steine, vollständig)`);
      expect(txt).toMatch(new RegExp(`Kontrolle: [\\d.]+ ganze Steine \\+ [\\d.]+ Sonderteile? = ${st.pieces.toLocaleString('de-DE').replace('.', '\\.')} Steine`));
    }
    // jede Spalte und jede Zeile steht in den Tabellen
    for (let c = 0; c < p.layout.cols; c++) expect(txt).toMatch(new RegExp(`(^|\\n)${c + 1}: [\\d,]+–[\\d,]+`));
    // Summe der gedruckten Läufe = ganze Steine der Kontrollzeilen; ganze Steine + Sonderteile = Steine
    let whole = 0;
    for (const m of txt.matchAll(/(\d+)(?:–(\d+))? (?:→|->) \d{2}/g)) whole += m[2] ? Number(m[2]) - Number(m[1]) + 1 : 1;
    const stats = computeStats(p.layout, p.data, p.palette, [], { reservePct: 10, groutDepthMm: 3 });
    const ctl = [...txt.matchAll(/Kontrolle: ([\d.]+) ganze Steine \+ ([\d.]+) Sonderteile?/g)].map((m) => [Number(m[1].replace(/\./g, '')), Number(m[2].replace(/\./g, ''))]);
    expect(ctl.length).toBe(p.sections.sections.length);
    expect(whole).toBe(ctl.reduce((a, c) => a + c[0], 0));
    expect(whole + ctl.reduce((a, c) => a + c[1], 0)).toBe(stats.pieces);
    // jede Sonderteil-Zeile steht einmal in der Liste (Position als eigener Text)
    const specialIds = new Set<string>();
    for (let i = 1; i <= pdf.pages.length; i++) {
      if (!(pdf.pageStrings(i)[1] ?? '').startsWith('Koordinaten')) continue;
      for (const s of pdf.pageStrings(i)) if (/^[A-Z]+\d{3}(-\d+)?$/.test(s)) specialIds.add(s);
    }
    // Ablesebeispiele (je Abschnitt eine ganze Position) zusätzlich zu den Sonderteilen
    expect(specialIds.size).toBe(ctl.reduce((a, c) => a + c[1], 0) + p.sections.sections.length);
    // „je Stein“ bleibt verfügbar (mit Limit und Kürzungshinweis)
    const per = await generatePdfReport(input, { ...opts, coordMode: 'perStone' });
    expect(Array.from({ length: parsePdf(per.pdf).pages.length }, (_, i) => parsePdf(per.pdf).pageText(i + 1)).join('\n')).toMatch(/gek(ü|\\374)rzt/);
    expect(per.planMatches).toBe(true);
    // aus
    expect(coordModeOf({ includeCoords: false, coordMode: 'compact' })).toBe('off');
    expect((await generatePdfReport(input, { ...opts, coordMode: 'off' })).breakdown.coords).toBe(0);
  }, 120000);

  it('200 × 100 cm, 5-mm-Steine, A4 1:1: vollständige Koordinaten in höchstens 70 Seiten', async () => {
    const p = sample('portrait', 2000, 5, 48);
    expect(p.layout.cols * p.layout.rows).toBeGreaterThan(55000);
    const input = baseInput(p.layout, p.data, p.palette, p.sections);
    const rep = await generatePdfReport(input, { ...lean, includeCoords: true });
    expect(rep.planMatches).toBe(true);
    expect(rep.breakdown.coords).toBeGreaterThan(0);
    expect(rep.breakdown.coords).toBeLessThanOrEqual(70);
  }, 240000);
});

// ================================================================ Gesamtübersicht
describe('Gesamtübersicht: Kartenraster bei vielen kleinen Abschnitten', () => {
  it('10000 × 5000 mm, 300-mm-Abschnitte: Kartenraster mit Spaltennummern 1…34 und Zeilen A…Q, keine Beschriftung je Abschnitt', async () => {
    const layout = computeLayout({ widthMm: 10000, heightMm: 5000, tileW: 10, tileH: 10, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const sections = computeSections(layout, 300, 300);
    expect(sections.scols).toBe(34);
    expect(sections.srows).toBe(17);
    const ov = overviewLayout(layout, sections, 24, 190, Math.min(297 * 0.55, 297 - 50), measure);
    expect(ov.mapGrid).toBe(true);
    expect(ov.colLabels[0].text).toBe('1');
    expect(ov.colLabels[ov.colLabels.length - 1].text).toBe('34');
    expect(ov.rowLabels[0].text).toBe('A');
    expect(ov.rowLabels[ov.rowLabels.length - 1].text).toBe('Q');
    // Beschriftungen überlappen nicht
    for (let i = 1; i < ov.colLabels.length; i++) expect(ov.colLabels[i].x - ov.colLabels[i - 1].x).toBeGreaterThan(measure('34', true) * ov.colFont);
    const data = createEmptyMosaic(layout.cols, layout.rows);
    const palette = [pc(1, '#3366AA'), pc(2, '#AA6633')];
    for (let i = 0; i < data.c1.length; i += 3) data.c1[i] = 1;
    const rep = await generatePdfReport(baseInput(layout, data, palette, sections), { ...lean, sectionIds: ['A1', 'B2'] });
    expect(rep.planMatches).toBe(true);
    const pdf = parsePdf(rep.pdf);
    const page = pdf.outline.find((o) => o.title === 'Gesamtübersicht')!.page;
    const strs = pdf.pageStrings(page);
    for (const s of ['1', '34', 'A', 'Q']) expect(strs).toContain(s);
    expect(strs).not.toContain('Q34');
    const txt = strs.join(' ').replace(/\s+/g, ' ');
    expect(txt).toContain('Abschnitt = Zeilenbuchstabe + Spaltennummer, z. B. C7.');
    expect(txt).toContain('Kräftig umrandet und hinterlegt: Abschnitte in diesem PDF.');
  }, 120000);

  it('wenige große Abschnitte: Beschriftung je Abschnitt in der Ecke, Kastenhöhe aus der Schrift', () => {
    const layout = computeLayout({ widthMm: 600, heightMm: 450, tileW: 6, tileH: 6, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const sections = computeSections(layout, 150, 150);
    const ov = overviewLayout(layout, sections, 24, 190, 160, measure);
    expect(ov.mapGrid).toBe(false);
    expect(ov.labelFont).toBeGreaterThanOrEqual(5);
    expect(ov.labelFont).toBeLessThanOrEqual(10);
    expect(ov.labelFont * PT_MM * 1.35).toBeLessThan(0.5 * (150 * ov.s));
  });

  it('Abschnittsdeckblatt: Lagekarte bei mehreren Abschnitten (Vorschaubild nur einmal eingebettet)', async () => {
    const { layout, data, palette } = squares(600, 400, 8, 6, 9);
    const sections = computeSections(layout, 300, 300);
    // 6 × 4 px JPEG als Vorschau
    const jpg =
      'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAEAAYDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJACY5//2Q==';
    const input = { ...baseInput(layout, data, palette, sections), preview: { dataUrl: jpg, w: 6, h: 4 } };
    const rep = await generatePdfReport(input, { ...lean, includeImages: true });
    expect(rep.planMatches).toBe(true);
    const pdf = parsePdf(rep.pdf);
    const images = (pdf.raw.match(/\/Subtype \/Image/g) ?? []).length;
    expect(images).toBe(1);
    const sn = pdf.outline.find((o) => o.title === 'Abschnitt A1')!;
    expect(pdf.pageText(sn.page)).toContain('Lage im Mosaik');
  }, 120000);
});
