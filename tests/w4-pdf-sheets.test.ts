/**
 * Welle 4 – Blattstruktur des PDF-Verlegeplans:
 *  - gleichmäßige Blattaufteilung ohne schmale Reststreifen (gleiche Blattanzahl wie der gierige Schnitt),
 *  - ein gemeinsamer Seitenplan: planPdfPages(…).total = doc.getNumberOfPages() (4 Beispiele, A4/A3, Inhalte an/aus),
 *  - jeder zugeschnittene Stein genau einmal: Vorlagennummer im Stein oder Zuschnittliste seines Blatts, T# aus bySig,
 *    nie eine „nackte“ Vorlagennummer, deren Vorlage nicht im PDF steht,
 *  - Codeplan-Seiten für Steine ohne Farbnummer: genau eine Nummer je Stein, je Farbe = Statistik,
 *  - kompakte Abschnittsübersicht für einblättrige Abschnitte.
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { hexToLab, hexToRgb } from '../src/core/color';
import { cellId, computeLayout, computeSections, pieceId, sectionsFor, type Layout, type SectionGrid } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { collectTemplates, DEFAULT_PDF_OPTIONS, generatePdfReport, pdfLayoutFacts, scanSheet, sheetCutList, type PdfInput, type PdfOptions } from '../src/core/pdf';
import { printableArea, sheetPrintArea } from '../src/core/pdfOptions';
import {
  balancedSplit,
  codePlanZoom,
  CODE_MIN_CELL,
  layoutCutList,
  layoutTemplateBoxes,
  labelOk,
  makeSheetLocator,
  planCoordPages,
  planPdfPages,
  planSheets,
} from '../src/core/pdfPlan';
import { cellPieces } from '../src/core/pieces';
import { CutCache, computeStats, makeRawSizeFn, pieceCutInfo } from '../src/core/stats';
import { CellKind, createEmptyMosaic, DEFAULT_SETTINGS, DEFAULT_SHAPES, type MosaicData, type PaletteColor } from '../src/core/types';
import { dictionaries, makeT } from '../src/i18n';
import { fontBase64, loadPng, prepareFor } from './helpers';

// ---------------------------------------------------------------- kleiner PDF-Leser (jsPDF-Ausgabe)
const PT = 72 / 25.4;
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
/** Texte mit Position (mm, y von oben) */
function placements(content: string, PH: number) {
  return [...content.matchAll(/BT\n\/F\d+ ([\d.]+) Tf\n(?:(?!ET\n)[\s\S])*?\n(?:([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.]+) ([-\d.]+) Tm|([-\d.]+) ([-\d.]+) Td)\n\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => {
    const rot = m[2] !== undefined;
    return { size: Number(m[1]), x: Number(rot ? m[6] : m[8]) / PT, y: PH - Number(rot ? m[7] : m[9]) / PT, text: pdfString(m[10]) };
  });
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

const tDe = makeT('de');
const pc = (code: number, hex: string): PaletteColor => ({ code, hex, name: `Farbe ${code}`, lab: hexToLab(hex) });
const baseInput = (layout: Layout, data: MosaicData, palette: PaletteColor[], sections: SectionGrid): PdfInput => ({
  projectName: 'W4',
  dateStr: '08.11.2026',
  layout,
  data,
  palette,
  materials: [],
  settings: { ...DEFAULT_SETTINGS, reservePct: 10 },
  sections,
  t: tDe,
  locale: 'de',
});
const lean: PdfOptions = { ...DEFAULT_PDF_OPTIONS, includeImages: false, includeTemplates: false, includeCoords: false };

/** Beispielprojekt wie auf der Startseite (Breite, Steingröße, Fuge, Farben; Höhe aus dem Seitenverhältnis des Bildes) */
const SAMPLES = {
  portrait: { w: 400, tile: 5, joint: 1, colors: 32 },
  landscape: { w: 1200, tile: 8, joint: 1.5, colors: 24 },
  animal: { w: 500, tile: 6, joint: 1, colors: 24 },
  city: { w: 2000, tile: 10, joint: 2, colors: 16 },
} as const;
function sample(key: keyof typeof SAMPLES) {
  const s = SAMPLES[key];
  const img0 = loadPng(`public/samples/${key}.png`);
  const settings = { ...DEFAULT_SETTINGS, widthMm: s.w, heightMm: Math.round(s.w / (img0.width / img0.height)), tileW: s.tile, tileH: s.tile, joint: s.joint };
  const layout = computeLayout({ widthMm: settings.widthMm, heightMm: settings.heightMm, tileW: s.tile, tileH: s.tile, joint: s.joint, edgeMode: 'cut-end', minCutMm: 2 });
  const res = computeMosaic(prepareFor(img0, layout), { layout, shapes: DEFAULT_SHAPES, paletteMode: 'auto', colorCount: s.colors, dither: 0, deltaE: '2000', regions: [] });
  return { layout, data: res.data, palette: res.palette, sections: sectionsFor(layout, settings), settings };
}

/** Mosaik aus ganzen Steinen; jede 7. Zelle diagonal geteilt (zwei Dreiecke) */
function squares(widthMm: number, heightMm: number, tile: number, joint = 1, nColors = 3, diagEvery = 0) {
  const layout = computeLayout({ widthMm, heightMm, tileW: tile, tileH: tile, joint, edgeMode: 'whole', minCutMm: 2 });
  const data = createEmptyMosaic(layout.cols, layout.rows);
  for (let i = 0; i < data.c1.length; i++) {
    data.c1[i] = (i * 7 + Math.floor(i / layout.cols)) % nColors;
    if (diagEvery && i % diagEvery === 3) {
      data.kind[i] = CellKind.DIAG_A;
      data.c2[i] = (data.c1[i] + 1) % nColors;
    }
  }
  const hexes = ['#E0D0B0', '#304050', '#A04030', '#5A8A3C', '#C8A2C8', '#1E6F8F'];
  return { layout, data, palette: hexes.slice(0, nColors).map((h, i) => pc(i + 1, h)) };
}

/** gieriger Schnitt (bisheriges tilesOf) – nur zum Vergleich der Blattanzahl */
function greedyCount(pos: Float64Array, size: Float64Array, a: number, b: number, maxLen: number, s: number) {
  let n = 1;
  for (let i = a + 1, st = a; i < b; i++)
    if ((pos[i] + size[i] - pos[st]) * s > maxLen + 1e-6) {
      n++;
      st = i;
    }
  return n;
}

// ================================================================ Blattaufteilung
describe('Blattaufteilung: gleichmäßig auf Rasterlinien, keine schmalen Streifen', () => {
  it('balancedSplit: gleiche Anzahl wie gierig, alle Teile passen, lückenlos', () => {
    const n = 60;
    const pos = new Float64Array(n);
    const size = new Float64Array(n).fill(5);
    for (let i = 0; i < n; i++) pos[i] = i * 6;
    // 60 Spalten à 6 mm Raster, 178 mm Blatt: gierig 30 + 29 + 1 Spalte (Streifen) – gleichmäßig 20/20/20
    expect(greedyCount(pos, size, 0, n, 178, 1)).toBe(3);
    const r = balancedSplit(pos, size, 0, n, 178);
    expect(r).toEqual([
      [0, 20],
      [20, 40],
      [40, 60],
    ]);
    // Teilbereich und Maßstab 2:1
    const r2 = balancedSplit(pos, size, 10, 50, 178, 2);
    expect(r2.length).toBe(greedyCount(pos, size, 10, 50, 178, 2));
    expect(r2[0][0]).toBe(10);
    expect(r2[r2.length - 1][1]).toBe(50);
    for (let i = 1; i < r2.length; i++) expect(r2[i][0]).toBe(r2[i - 1][1]);
    for (const [a, b] of r2) expect((pos[b - 1] + size[b - 1] - pos[a]) * 2).toBeLessThanOrEqual(178 + 1e-6);
    // Zelle größer als das Blatt: eine Zelle je Blatt
    expect(balancedSplit(pos, size, 0, 3, 4)).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it('kein Blatt schmaler als 40 % der bedruckbaren Fläche (außer der Abschnitt selbst); Blattanzahl unverändert; Abschnitt vollständig abgedeckt', () => {
    let checked = 0;
    for (const [w, h] of [
      [400, 500],
      [600, 400],
      [1230, 870],
    ])
      for (const tile of [3, 5, 8, 12])
        for (const sec of [300, 450, 1000])
          for (const format of ['a4', 'a3'] as const)
            for (const orientation of ['portrait', 'landscape'] as const)
              for (const sheetScale of [1, 2]) {
                const layout = computeLayout({ widthMm: w, heightMm: h, tileW: tile, tileH: tile, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
                const grid = computeSections(layout, sec, sec);
                const opts = { ...lean, format, orientation, sheetScale };
                const plan = planSheets(layout, grid, opts);
                const { printW, printH } = printableArea(opts);
                expect(plan.printW).toBe(printW);
                for (const ss of plan.sections) {
                  const S = ss.section;
                  expect(ss.cx.length).toBe(greedyCount(layout.colX, layout.colW, S.c0, S.c1, printW, sheetScale));
                  expect(ss.ry.length).toBe(greedyCount(layout.rowY, layout.rowH, S.r0, S.r1, printH, sheetScale));
                  expect(ss.cx[0][0]).toBe(S.c0);
                  expect(ss.cx[ss.cx.length - 1][1]).toBe(S.c1);
                  expect(ss.ry[0][0]).toBe(S.r0);
                  expect(ss.ry[ss.ry.length - 1][1]).toBe(S.r1);
                  let area = 0;
                  for (const sh of ss.sheets) {
                    const sw = (layout.colX[sh.c1 - 1] + layout.colW[sh.c1 - 1] - layout.colX[sh.c0]) * sheetScale;
                    const shh = (layout.rowY[sh.r1 - 1] + layout.rowH[sh.r1 - 1] - layout.rowY[sh.r0]) * sheetScale;
                    expect(sw).toBeLessThanOrEqual(printW + 1e-6);
                    expect(shh).toBeLessThanOrEqual(printH + 1e-6);
                    if (S.w * sheetScale >= 0.4 * printW) expect(sw, `${w}x${h} ${tile} ${sec} ${format} ${orientation} ${sheetScale} ${sh.key}`).toBeGreaterThanOrEqual(0.4 * printW);
                    if (S.h * sheetScale >= 0.4 * printH) expect(shh).toBeGreaterThanOrEqual(0.4 * printH);
                    area += printW * printH;
                    expect(sh.key).toBe(`${S.id}-${sh.no}`);
                    checked++;
                  }
                  // Blätter × bedruckbare Fläche ≥ Abschnittsfläche auf dem Papier
                  expect(area).toBeGreaterThanOrEqual(S.w * S.h * sheetScale * sheetScale - 1e-6);
                }
              }
    expect(checked).toBeGreaterThan(500);
  });

  it('Blattzuordnung je Zelle (makeSheetLocator) = Zellbereich des Blatts', () => {
    const layout = computeLayout({ widthMm: 700, heightMm: 520, tileW: 6, tileH: 6, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
    const grid = computeSections(layout, 300, 300);
    const plan = planSheets(layout, grid, lean);
    const locate = makeSheetLocator(plan, grid, layout);
    for (const ss of plan.sections)
      for (const sh of ss.sheets)
        for (const [r, c] of [
          [sh.r0, sh.c0],
          [sh.r1 - 1, sh.c1 - 1],
          [(sh.r0 + sh.r1) >> 1, (sh.c0 + sh.c1) >> 1],
        ])
          expect(locate(r, c)?.key).toBe(sh.key);
  });
});

// ================================================================ Farbnummern und Codeplan-Zoom
describe('labelOk und Codeplan-Zoom', () => {
  it('Raster ≥ 2,2 mm und kleinste Seite ≥ 1,8 mm auf dem Papier', () => {
    expect(labelOk({ w: 5, h: 5, tile: 5 }, 1)).toBe(true);
    expect(labelOk({ w: 2, h: 2, tile: 2 }, 1)).toBe(false);
    expect(labelOk({ w: 2, h: 2, tile: 2 }, 2)).toBe(true);
    expect(labelOk({ w: 5, h: 1.7, tile: 5 }, 1)).toBe(false);
    expect(labelOk({ w: 5, h: 1.8, tile: 5 }, 1)).toBe(true);
    expect(labelOk({ w: 5, h: 5, tile: 5 }, 0.4)).toBe(false);
  });
  it('kleinster ganzzahliger Zoom ≥ 2', () => {
    expect(codePlanZoom(2, 2, 1)).toEqual({ k: 2, complete: true });
    expect(codePlanZoom(5, 5, 1 / 4)).toEqual({ k: 2, complete: true });
    expect(codePlanZoom(5, 5, 1 / 6)).toEqual({ k: 3, complete: true });
    expect(codePlanZoom(5, 0.5, 1)).toEqual({ k: 4, complete: true });
    expect(codePlanZoom(5, 0.1, 1).complete).toBe(false);
    expect(CODE_MIN_CELL).toBe(2.2);
  });
});

// ================================================================ Seitenplan = erzeugtes PDF
describe('Seitenplan: planPdfPages().total = Seiten des PDFs', () => {
  const variants: [string, Partial<PdfOptions>][] = [
    ['Koordinaten und Vorlagen an', { includeCoords: true, includeTemplates: true }],
    ['Koordinaten und Vorlagen aus', { includeCoords: false, includeTemplates: false }],
  ];
  for (const key of Object.keys(SAMPLES) as (keyof typeof SAMPLES)[]) {
    it(`${key}: A4 und A3, Inhalte an/aus`, async () => {
      const p = sample(key);
      for (const format of ['a4', 'a3'] as const)
        for (const [name, v] of variants) {
          const opts: PdfOptions = { ...DEFAULT_PDF_OPTIONS, includeImages: false, format, ...v };
          const input = baseInput(p.layout, p.data, p.palette, p.sections);
          const facts = pdfLayoutFacts(input, opts);
          const plan = planPdfPages(p.layout, p.sections, opts, facts.stones, facts.templateGroups, facts);
          const rep = await generatePdfReport(input, opts);
          const pages = parsePdf(rep.pdf).pages.length;
          const where = `${key} ${format} ${name}`;
          expect(rep.pages, where).toBe(pages);
          expect(plan.total, where).toBe(pages);
          expect(rep.planMatches, where).toBe(true);
          // jede Teilsumme stimmt
          expect({ front: plan.front, covers: plan.sectionCovers, sums: plan.sectionSummaries, sheets: plan.sheets, cut: plan.cutLists, code: plan.codePlans, tpl: plan.templates, coords: plan.coords }, where).toEqual({
            front: rep.breakdown.front,
            covers: rep.breakdown.sectionCovers,
            sums: rep.breakdown.sectionSummaries,
            sheets: rep.breakdown.sheets,
            cut: rep.breakdown.cutLists,
            code: rep.breakdown.codePlans,
            tpl: rep.breakdown.templates,
            coords: rep.breakdown.coords,
          });
          expect(plan.estimated, where).toEqual([]);
          // ohne Messwerte: Blätter, Vorlagen und Koordinaten bleiben exakt, der Rest heißt „geschätzt“
          const est = planPdfPages(
            p.layout,
            p.sections,
            opts,
            Object.fromEntries(Object.entries(facts.stones).map(([id, n]) => [id, { pieces: n }])),
            facts.templateGroups,
          );
          expect(est.sheets, where).toBe(plan.sheets);
          expect(est.templates, where).toBe(plan.templates);
          expect(est.coords, where).toBe(plan.coords);
          expect(est.estimated, where).toContain('front');
        }
    }, 300000);
  }

  it('eingebettete Schrift (Türkisch, Englisch), A4 quer, an Seite angepasst und 2:1: Plan = Seiten', async () => {
    const p = sample('animal');
    const fonts = { regular: fontBase64('public/fonts/DejaVuSans.ttf'), bold: fontBase64('public/fonts/DejaVuSans-Bold.ttf') };
    for (const [locale, orientation, sheetScale] of [
      ['tr', 'landscape', 0],
      ['en', 'portrait', 2],
    ] as const) {
      const input: PdfInput = { ...baseInput(p.layout, p.data, p.palette, p.sections), t: makeT(locale), locale, fonts };
      const opts: PdfOptions = { ...DEFAULT_PDF_OPTIONS, includeImages: false, orientation, sheetScale, coordLimit: 3000 };
      const facts = pdfLayoutFacts(input, opts);
      const plan = planPdfPages(p.layout, p.sections, opts, facts.stones, facts.templateGroups, facts);
      const rep = await generatePdfReport(input, opts);
      expect(parsePdf(rep.pdf).pages.length, `${locale} ${orientation} ${sheetScale}`).toBe(plan.total);
      expect(rep.planMatches).toBe(true);
    }
  }, 300000);

  it('Koordinatenseiten: 60 Zeilen auf der ersten, 62 auf jeder weiteren A4-Seite; Kürzungshinweis', () => {
    expect(planCoordPages([60], 1e6, 297).pages).toBe(1);
    expect(planCoordPages([61], 1e6, 297).pages).toBe(2);
    expect(planCoordPages([60 + 62], 1e6, 297).pages).toBe(2);
    expect(planCoordPages([60 + 62 + 1], 1e6, 297).pages).toBe(3);
    expect(planCoordPages([10, 10], 1e6, 297).pages).toBe(2);
    const tr = planCoordPages([100, 100], 150, 297);
    expect(tr).toMatchObject({ listed: 150, truncated: true });
  });

  it('Schnittvorlagen-Kästen: 3 × 3 je A4-Seite, Kürzungshinweis', () => {
    expect(layoutTemplateBoxes(9, false, 210, 297).pages).toBe(1);
    expect(layoutTemplateBoxes(10, false, 210, 297).pages).toBe(2);
    expect(layoutTemplateBoxes(0, true, 210, 297).pages).toBe(1);
  });

  it('Zuschnittliste: Kopfzeile nie allein am Spaltenende, Seiten je Blatt', () => {
    const cl = layoutCutList([10, 0, 300], 210, 297);
    expect(cl.cols).toBe(2);
    expect(cl.rowsPerCol).toBe(62);
    expect(cl.blocks[1]).toBeNull();
    expect(cl.blocks[0]).toEqual({ head: 0, first: 1, end: 11 });
    expect(cl.blocks[2]!.head).toBe(11);
    expect(cl.pages).toBe(Math.ceil(cl.blocks[2]!.end / cl.perPage));
    // eine Kopfzeile, die auf den letzten Platz einer Spalte fiele, rutscht in die nächste Spalte
    const cl2 = layoutCutList([60, 5], 210, 297);
    expect(cl2.blocks[1]!.head).toBe(62);
  });
});

// ================================================================ Vorlagennummern: im Stein oder in der Zuschnittliste
describe('Zuschnitt: jeder zugeschnittene Stein verweist genau einmal auf seine Vorlage', () => {
  const p = sample('portrait');
  const raw = makeRawSizeFn(p.layout, p.palette, []);

  /** alle zugeschnittenen Steine eines Bereichs mit ihrer Vorlage (unabhängig von scanSheet berechnet) */
  const cutPiecesOf = (tpl: ReturnType<typeof collectTemplates>, r: { r0: number; r1: number; c0: number; c1: number }, cache: CutCache) => {
    const out = new Map<string, number>();
    for (let row = r.r0; row < r.r1; row++)
      for (let col = r.c0; col < r.c1; col++) {
        const ps = cellPieces(p.layout, p.data, row, col);
        ps.forEach((q, i) => {
          const ci = pieceCutInfo(cache, p.layout, p.data, row, col, i, q.poly, raw(q.color));
          if (ci.invalid || !ci.needsCut) return;
          out.set(pieceId(p.layout, row, col, i, ps.length), tpl.bySig.get(ci.signature)!.no);
        });
      }
    return out;
  };

  for (const [name, opts] of [
    ['A4 1:1, Vorlagen bis T3 gedruckt', { ...DEFAULT_PDF_OPTIONS, includeImages: false, includeCoords: true, coordLimit: 1e6, includeTemplates: true, templateLimit: 3 }],
    ['A4 2:1 (Vorlagennummern im Stein)', { ...DEFAULT_PDF_OPTIONS, includeImages: false, includeCoords: false, includeTemplates: true, sheetScale: 2 }],
    ['A3, Vorlagen aus, nur Abschnitt B2', { ...DEFAULT_PDF_OPTIONS, format: 'a3', includeImages: false, includeCoords: true, coordLimit: 1e6, includeTemplates: false, sectionIds: ['B2'] }],
  ] as [string, PdfOptions][]) {
    it(name, async () => {
      const cache = new CutCache();
      const plan = planSheets(p.layout, p.sections, opts);
      const tpl = collectTemplates(p.layout, p.data, p.palette, [], cache, makeSheetLocator(plan, p.sections, p.layout));
      const printed = (no: number) => opts.includeTemplates && no <= opts.templateLimit;
      const input = baseInput(p.layout, p.data, p.palette, p.sections);
      const rep = await generatePdfReport(input, opts);
      const pdf = parsePdf(rep.pdf);
      // Seiten nach Blatt (Lesezeichen) und Text der Zuschnittlisten
      const sheetPage = new Map(pdf.outline.filter((o) => /^Blatt [A-Z]+\d+-\d+$/.test(o.title)).map((o) => [o.title.replace('Blatt ', ''), o.page]));
      const cutListText = pdf.pages
        .map((_, i) => i + 1)
        .filter((i) => pdf.pageText(i).startsWith('MosaicPlan') && /Zuschnittliste/.test(pdf.pageText(i).split('\n')[1] ?? ''))
        .map((i) => pdf.pageStrings(i));
      const listedIds = new Map<string, number>();
      for (const strs of cutListText) for (const s of strs) if (/^[A-Z]+\d{3}(-\d+)?$/.test(s)) listedIds.set(s, (listedIds.get(s) ?? 0) + 1);
      let onPieceTotal = 0;
      let entriesTotal = 0;
      let sectionsChecked = 0;
      for (const ss of plan.sections) {
        if (!ss.selected) continue;
        sectionsChecked++;
        const expected = cutPiecesOf(tpl, ss.section, cache);
        const seen = new Map<string, number>();
        for (const sh of ss.sheets) {
          const scan = scanSheet(p.layout, p.data, raw, tpl, cache, sh, plan.scale, { printed, codePlan: 'auto' });
          expect(sheetCutList(p.layout, p.data, raw, tpl, cache, sh, plan.scale, { printed, codePlan: 'auto' })).toEqual(scan.entries);
          for (const e of scan.entries) {
            expect(seen.has(e.id), e.id).toBe(false);
            seen.set(e.id, e.tNo!);
            expect(e.inPdf).toBe(printed(e.tNo!));
            // jede Zeile steht genau einmal auf den Zuschnittlisten-Seiten
            expect(listedIds.get(e.id), e.id).toBe(1);
          }
          for (const o of scan.onPiece) {
            expect(seen.has(o.id)).toBe(false);
            seen.set(o.id, o.tNo);
            expect(printed(o.tNo)).toBe(true);
          }
          // Vorlagennummern im Stein: genau diese „T#“ stehen auf der Blattseite
          const page = sheetPage.get(sh.key)!;
          const tOnSheet = pdf.pageStrings(page).filter((s) => /^T\d+$/.test(s));
          expect(tOnSheet.sort()).toEqual(scan.onPiece.map((o) => `T${o.tNo}`).sort());
          onPieceTotal += scan.onPiece.length;
          entriesTotal += scan.entries.length;
        }
        // genau die zugeschnittenen Steine des Abschnitts, je mit der Vorlage aus bySig
        expect(new Map([...seen].sort())).toEqual(new Map([...expected].sort()));
        expect(seen.size).toBe(computeStats(p.layout, p.data, p.palette, [], { reservePct: 0, groutDepthMm: 3 }, ss.section, cache).cutPieces);
      }
      expect(sectionsChecked).toBeGreaterThan(0);
      expect(entriesTotal + onPieceTotal).toBeGreaterThan(0);
      if (opts.sheetScale === 2) expect(onPieceTotal).toBeGreaterThan(0);
      // nie eine nackte Vorlagennummer, deren Vorlage nicht gedruckt ist
      const all = pdf.pages.map((_, i) => pdf.pageStrings(i + 1)).flat();
      // Positionen wie „T067“ (Zeile T) sind keine Vorlagennummern: Koordinatenseiten und Positionsspalte ausnehmen
      const notCoords = pdf.pages
        .map((_, i) => i + 1)
        .filter((i) => !(pdf.pageStrings(i)[1] ?? '').startsWith('Koordinaten'))
        .map((i) => pdf.pageStrings(i))
        .flat();
      for (const s of notCoords) {
        const bare = listedIds.has(s) ? null : /^T(\d+)$/.exec(s);
        if (bare) expect(printed(Number(bare[1])), s).toBe(true);
      }
      for (const s of all) {
        const coord = /\(T(\d+)\)$/.exec(s);
        if (coord) expect(printed(Number(coord[1])), s).toBe(true);
        for (const m of s.matchAll(/T(\d+) \(nicht im PDF\)/g)) expect(printed(Number(m[1]))).toBe(false);
      }
      if (!opts.includeTemplates || opts.templateLimit < tpl.groups.length) expect(all.some((s) => s.includes('(nicht im PDF)'))).toBe(true);
    }, 180000);
  }

  it('Schnittvorlagen nennen die Vorkommen je Blatt (Summe = Anzahl der Vorlage)', () => {
    const cache = new CutCache();
    const plan = planSheets(p.layout, p.sections, lean);
    const tpl = collectTemplates(p.layout, p.data, p.palette, [], cache, makeSheetLocator(plan, p.sections, p.layout));
    for (const g of tpl.groups) {
      let n = 0;
      for (const v of g.sheets.values()) n += v;
      expect(n).toBe(g.count);
      expect(g.sheets.has('')).toBe(false);
    }
  });
});

// ================================================================ Codeplan-Seiten
describe('Codeplan: Steine ohne Farbnummer auf den 1:1-Blättern', () => {
  /** Farbnummern (zweistellig) im Mosaikbereich einer Codeplan-Seite */
  const codesOn = (content: string) => placements(content, 297).filter((q) => /^\d{2}$/.test(q.text) && q.x >= 22 - 0.5 && q.y >= 29 - 0.5);

  it('2-mm-Steine bei 1:1 (auto): genau eine Nummer je Stein, je Farbe = Statistik; Blätter unverändert', async () => {
    const { layout, data, palette } = squares(150, 130, 2, 0.5, 4);
    const sections = computeSections(layout, 300, 300);
    const stats = computeStats(layout, data, palette, [], { reservePct: 0, groutDepthMm: 3 });
    const rep = await generatePdfReport(baseInput(layout, data, palette, sections), { ...lean, codePlan: 'auto' });
    const pdf = parsePdf(rep.pdf);
    expect(rep.breakdown.codePlans).toBeGreaterThan(0);
    expect(rep.planMatches).toBe(true);
    const codePages: number[] = [];
    const sheetPages: number[] = [];
    for (let i = 1; i <= pdf.pages.length; i++) {
      const txt = pdf.pageText(i);
      if (txt.includes('CODEPLAN')) codePages.push(i);
      if (txt.includes('Kontrollstrecke') && /Blatt [A-Z]+\d+-\d+ \(/.test(txt)) sheetPages.push(i);
    }
    expect(codePages.length).toBe(rep.breakdown.codePlans);
    // Codeplan-Seiten: nicht maßstäblich, ohne Kontrollstrecke und Passmarken-Hinweis, mit Titel „(2:1)“
    for (const i of codePages) {
      const txt = pdf.pageText(i);
      expect(txt).not.toContain('Kontrollstrecke');
      expect(txt).not.toContain('deckungsgleich');
      expect(txt).toMatch(/Codeplan zu Blatt A1-\d+ \(Teil \d+\/\d+\) – NICHT maßstäblich \(2:1\)/);
    }
    // je Farbe: Anzahl der Nummern auf den Codeplan-Seiten = Steine der Farbe
    const perCode = new Map<string, number>();
    let total = 0;
    for (const i of codePages)
      for (const q of codesOn(pdf.pageContent(i))) {
        perCode.set(q.text, (perCode.get(q.text) ?? 0) + 1);
        total++;
      }
    expect(total).toBe(stats.pieces);
    palette.forEach((pp, i) => expect(perCode.get(String(pp.code).padStart(2, '0')) ?? 0).toBe(stats.perColor[i].pieces));
    // 1:1-Blätter: keine Nummern im Mosaik, Flächen je Farbe = Statistik, Verweis auf den Codeplan
    const fills = new Map<string, number>();
    for (const i of sheetPages) {
      expect(codesOn(pdf.pageContent(i)).length).toBe(0);
      expect(pdf.pageText(i)).toMatch(/Farbnummern: Codeplan S\. \d+/);
      for (const [k, v] of countFills(pdf.pageContent(i))) fills.set(k, (fills.get(k) ?? 0) + v);
    }
    palette.forEach((pp, i) => expect(fills.get(fmtColor(pp.hex)) ?? 0).toBe(stats.perColor[i].pieces));
    // Lesezeichen: Codeplan unter dem Blatt
    expect(pdf.outline.some((o) => /^Codeplan A1-1 \(1\/\d+\)$/.test(o.title))).toBe(true);
  }, 120000);

  it('Teilstücke (Dreiecke) im Maßstab 1:4: Codeplan 1:2 beschriftet jedes Teil', async () => {
    const { layout, data, palette } = squares(120, 90, 5, 1, 3, 7);
    const sections = computeSections(layout, 300, 300);
    const stats = computeStats(layout, data, palette, [], { reservePct: 0, groutDepthMm: 3 });
    const rep = await generatePdfReport(baseInput(layout, data, palette, sections), { ...lean, sheetScale: 0.25, codePlan: 'auto' });
    const pdf = parsePdf(rep.pdf);
    const codePages = pdf.pages.map((_, i) => i + 1).filter((i) => pdf.pageText(i).includes('CODEPLAN'));
    expect(codePages.length).toBeGreaterThan(0);
    expect(pdf.pageText(codePages[0])).toContain('NICHT maßstäblich (1:2)');
    let total = 0;
    for (const i of codePages) total += codesOn(pdf.pageContent(i)).length;
    expect(total).toBe(stats.pieces);
    expect(stats.cutPieces).toBeGreaterThan(0);
  }, 120000);

  it('Codeplan aus: keine Codeplan-Seiten, Hinweis auf dem Blatt; „immer“: Codeplan auch bei 5-mm-Steinen', async () => {
    const small = squares(80, 60, 2, 0.5, 3);
    const off = parsePdf((await generatePdfReport(baseInput(small.layout, small.data, small.palette, computeSections(small.layout, 300, 300)), { ...lean, codePlan: 'off' })).pdf);
    const txt = off.pages.map((_, i) => off.pageText(i + 1)).join('\n');
    expect(txt).not.toContain('CODEPLAN');
    expect(txt.replace(/\s+/g, ' ')).toContain('Codeplan ausgeschaltet');
    const big = squares(80, 60, 5, 1, 3);
    const always = await generatePdfReport(baseInput(big.layout, big.data, big.palette, computeSections(big.layout, 300, 300)), { ...lean, codePlan: 'always' });
    expect(always.breakdown.codePlans).toBeGreaterThanOrEqual(always.breakdown.sheets);
    expect(always.planMatches).toBe(true);
    const auto = await generatePdfReport(baseInput(big.layout, big.data, big.palette, computeSections(big.layout, 300, 300)), { ...lean, codePlan: 'auto' });
    expect(auto.breakdown.codePlans).toBe(0);
  }, 120000);
});

// ================================================================ Abschnittsübersicht
describe('Abschnittsübersicht: einblättrige Abschnitte ohne eigenes Deckblatt', () => {
  it('„an Seite anpassen“: Blöcke mehrerer Abschnitte je Seite, Farbfelder = Steine des Abschnitts', async () => {
    const { layout, data, palette } = squares(600, 450, 6, 1, 5, 9);
    const sections = computeSections(layout, 150, 150);
    const rep = await generatePdfReport(baseInput(layout, data, palette, sections), { ...lean, sheetScale: 0 });
    const pdf = parsePdf(rep.pdf);
    expect(rep.breakdown.sectionCovers).toBe(0);
    expect(rep.breakdown.sheets).toBe(sections.sections.length);
    expect(rep.breakdown.sectionSummaries).toBeGreaterThan(0);
    expect(rep.breakdown.sectionSummaries).toBeLessThan(sections.sections.length);
    expect(rep.planMatches).toBe(true);
    const sumPages = pdf.pages.map((_, i) => i + 1).filter((i) => pdf.pageText(i).split('\n')[1]?.startsWith('Abschnittsübersicht'));
    expect(sumPages.length).toBe(rep.breakdown.sectionSummaries);
    const all = sumPages.map((i) => pdf.pageStrings(i)).flat();
    for (const sec of sections.sections) {
      expect(all).toContain(`Abschnitt ${sec.id}`);
      expect(pdf.pages.map((_, i) => pdf.pageText(i + 1)).join('\n')).not.toContain('Farblegende und Stückzahlen des Abschnitts');
    }
    // Farbfelder „01 ×123“ je Abschnitt: Summe = Steine des Abschnitts
    const cache = new CutCache();
    for (const i of sumPages) {
      const strs = pdf.pageStrings(i);
      let cur: string | null = null;
      const sums = new Map<string, number>();
      for (const s of strs) {
        const h = /^Abschnitt ([A-Z]+\d+)$/.exec(s);
        if (h) cur = h[1];
        const c = /^\d{2} ×([\d.]+)$/.exec(s);
        if (c && cur) sums.set(cur, (sums.get(cur) ?? 0) + Number(c[1].replace(/\./g, '')));
      }
      for (const [id, n] of sums) {
        const sec = sections.sections.find((s) => s.id === id)!;
        expect(n).toBe(computeStats(layout, data, palette, [], { reservePct: 0, groutDepthMm: 3 }, sec, cache).pieces);
      }
    }
  }, 120000);
});

describe('Übersetzungen der Blattstruktur', () => {
  it('alle neuen Schlüssel in DE, EN und TR mit denselben Platzhaltern', () => {
    const keys = Object.keys(dictionaries.de).filter((k) => k.startsWith('pdf.w4.'));
    expect(keys.length).toBeGreaterThan(20);
    for (const k of keys)
      for (const lang of ['en', 'tr'] as const) {
        const v = (dictionaries[lang] as Record<string, string>)[k];
        expect(v, `${lang}:${k}`).toBeTruthy();
        const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
        expect(ph(v), `${lang}:${k}`).toEqual(ph((dictionaries.de as Record<string, string>)[k]));
      }
    expect(makeT('de')('pdfui.codesTooSmall')).toContain('Codeplan');
    expect(sheetPrintArea(210, 297)).toEqual({ printW: 178, printH: 247 });
    expect(cellId({ cols: 50 }, 0, 0)).toBe('A001');
  });
});
