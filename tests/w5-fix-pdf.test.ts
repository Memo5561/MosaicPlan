/**
 * Nachbesserung „PDF“ nach der Gegenprüfung von Welle 5 (w5-fix-pdf):
 *  - Messwerte je Abschnitt: Steine UND zugeschnittene Steine → Schätzung der kompakten Koordinatenseiten je Teil
 *  - Teil-Export: Schnittvorlagen nur der exportierten Abschnitte, Stückzahlen für diese Abschnitte; Teil gemessen wie
 *    Einzeldatei derselben Abschnitte (gleiche Seitenzahl)
 *  - „Teil k von n“ im PDF (Deckblatt + jede Fußzeile)
 *  - einheitliche Rundung (Stückmaße 1 Nachkommastelle, Flächen 4 feste), Hinweis der Einkaufsliste ohne Material
 *  - Dateinamen: Wort in der Sprache der Oberfläche, nur ASCII
 *  - Zähler „manuelle Änderungen“ netto über Rückgängig/Wiederholen
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { setCellKind, setFreePieces } from '../src/core/edits';
import { computeLayout, computeSections, type Section } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { collectTemplates, DEFAULT_PDF_OPTIONS, generatePdfReport, pdfLayoutFacts, type PdfInput, type PdfOptions } from '../src/core/pdf';
import { exportFileName, planForSelection } from '../src/core/pdfExportPlan';
import { makeSheetLocator, planSheets } from '../src/core/pdfPlan';
import { cellRect, freePreset } from '../src/core/pieces';
import { computeStats } from '../src/core/stats';
import { CellKind, DEFAULT_SETTINGS, DEFAULT_SHAPES } from '../src/core/types';
import { dictionaries, makeT } from '../src/i18n';
import { nextManualEdits } from '../src/ui/project/useProject';
import { loadPng, prepareFor } from './helpers';

// ---------------------------------------------------------------- Hilfen
/** Text aller Inhaltsströme (Standardschrift, ohne eingebettete Schriften) – je Strom ein Eintrag */
function pdfStreams(buf: ArrayBuffer): string[] {
  const s = Buffer.from(buf).toString('latin1');
  const out: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    // Länge aus dem Wörterbuch (komprimierte Daten können „endstream“ enthalten)
    const len = Number(s.slice(Math.max(0, m.index - 200), m.index).match(/\/Length (\d+)(?![\s\S]*\/Length)/)?.[1]);
    const end = Number.isFinite(len) ? start + len : s.indexOf('endstream', start);
    if (end < 0) break;
    const raw = Buffer.from(s.slice(start, end), 'latin1');
    try {
      out.push(inflateSync(raw).toString('latin1').replace(/\u0000/g, ''));
    } catch {
      out.push(raw.toString('latin1').replace(/\u0000/g, ''));
    }
    re.lastIndex = end + 9;
  }
  return out;
}
/** sichtbare Texte (Tj / TJ) eines Stroms */
function texts(stream: string): string[] {
  const out: string[] = [];
  for (const m of stream.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(m[1].replace(/\\(.)/g, '$1'));
  return out;
}
const allText = (buf: ArrayBuffer) => pdfStreams(buf).flatMap(texts).join('\n');

// ---------------------------------------------------------------- Mosaik mit Zuschnitten (wie die Gegenprüfung)
const settings = { ...DEFAULT_SETTINGS, widthMm: 300, heightMm: 250, tileW: 5, tileH: 5, joint: 1, sectionWmm: 120, sectionHmm: 120, reservePct: 10 };
const layout = computeLayout({ widthMm: 300, heightMm: 250, tileW: 5, tileH: 5, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
const res = computeMosaic(prepareFor(loadPng('public/samples/portrait.png'), layout), { layout, shapes: DEFAULT_SHAPES, paletteMode: 'auto', colorCount: 16, dither: 0, deltaE: '2000', regions: [] });
{
  // Sonderformen: halbe Steine, Schnittlinien, Rauten, Trapeze – viele verschiedene Schnittvorlagen
  let k = 0;
  for (let row = 3; row < layout.rows; row += 7)
    for (let col = 2; col < layout.cols; col += 9) {
      const r = cellRect(layout, row, col);
      const m = k++ % 4;
      if (m === 0) setCellKind(layout, res.data, row, col, { kind: CellKind.SUB, k: 2 }, 1);
      else if (m === 1) setCellKind(layout, res.data, row, col, { kind: CellKind.LINE, angleDeg: 37, offsetMm: 0.7 }, 1);
      else {
        const polys = freePreset(m === 2 ? 'rhombus' : 'trapezoid', r.w, r.h, layout.joint)!;
        setFreePieces(layout, res.data, row, col, polys.map((poly, i) => ({ poly, color: (row + col + i) % res.palette.length })), 1);
      }
    }
}
const sections = computeSections(layout, settings.sectionWmm, settings.sectionHmm);
const statOpts = { reservePct: 10, groutDepthMm: 3 };
const base: PdfInput = { projectName: 'Teile', dateStr: '11.11.2026', layout, data: res.data, palette: res.palette, materials: [], settings, sections, t: makeT('de'), locale: 'de' };
const opts: PdfOptions = { ...DEFAULT_PDF_OPTIONS, includeImages: false };
const secStats = (s: Section) => computeStats(layout, res.data, res.palette, [], statOpts, s);
const stonesOf = (id: string) => {
  const s = sections.sections.find((x) => x.id === id);
  return s ? secStats(s).pieces : undefined;
};
const PARTS = [
  ['A1', 'A2', 'A3', 'B1'],
  ['B2', 'B3', 'C1'],
  ['C2', 'C3'],
];

describe('Messwerte je Abschnitt: Steine und zugeschnittene Steine', () => {
  const facts = pdfLayoutFacts(base, opts);
  it('facts.stones nennt je Abschnitt pieces und cutPieces (= computeStats)', () => {
    expect(Object.keys(facts.stones).length).toBe(sections.sections.length);
    for (const s of sections.sections) {
      const st = secStats(s);
      expect(facts.stones[s.id]).toEqual({ pieces: st.pieces, cutPieces: st.cutPieces });
    }
    expect(Object.values(facts.stones).some((c) => (c.cutPieces ?? 0) > 0)).toBe(true);
  });
  it('kompakte Koordinatenseiten eines Teils: Schätzung aus der Messung des Ganzen trifft (±1) statt viel zu wenig', async () => {
    for (const ids of PARTS) {
      const plan = planForSelection(layout, sections, opts, ids, stonesOf, facts, null);
      expect(plan.estimated).toContain('coords');
      const real = await generatePdfReport(base, { ...opts, sectionIds: ids });
      expect(Math.abs(plan.coords - real.breakdown.coords), ids.join(',')).toBeLessThanOrEqual(1);
    }
  });
});

describe('Export in Teilen: Vorlagen je Teil, Seitenzahl wie Einzeldatei, „Teil k von n“ im PDF', () => {
  const plan = planSheets(layout, sections, opts);
  const tpl = collectTemplates(layout, res.data, res.palette, [], undefined, makeSheetLocator(plan, sections, layout));
  const keysOf = (ids: string[]) => new Set(plan.sections.filter((s) => ids.includes(s.section.id)).flatMap((s) => s.sheets.map((sh) => sh.key)));

  it('Messung eines Teils = Seiten des Teil-PDFs = Seiten einer Einzeldatei derselben Abschnitte', async () => {
    for (const [i, ids] of PARTS.entries()) {
      const part = { index: i, total: PARTS.length };
      const facts = pdfLayoutFacts({ ...base, part }, { ...opts, sectionIds: ids });
      const est = planForSelection(layout, sections, opts, ids, stonesOf, facts, ids);
      expect(est.estimated).toEqual([]);
      const partPdf = await generatePdfReport({ ...base, part }, { ...opts, sectionIds: ids });
      const single = await generatePdfReport(base, { ...opts, sectionIds: ids });
      expect(partPdf.pages, ids.join(',')).toBe(est.total);
      expect(single.pages, ids.join(',')).toBe(est.total);
    }
  });

  it('nur Vorlagen, die in den exportierten Abschnitten vorkommen; Stückzahl für diese Abschnitte, ganzes Mosaik daneben', async () => {
    const ids = PARTS[2];
    const keys = keysOf(ids);
    const inSel = tpl.groups.filter((g) => [...g.sheets.keys()].some((k) => keys.has(k)));
    expect(inSel.length).toBeGreaterThan(0);
    expect(inSel.length).toBeLessThan(tpl.groups.length);
    const facts = pdfLayoutFacts(base, { ...opts, sectionIds: ids });
    expect(facts.templateGroups).toBe(inSel.length);
    const rep = await generatePdfReport(base, { ...opts, sectionIds: ids });
    const txt = allText(rep.pdf);
    const titles = new Set([...txt.matchAll(/Vorlage T(\d+)/g)].map((m) => Number(m[1])));
    expect([...titles].sort((a, b) => a - b)).toEqual(inSel.map((g) => g.no).sort((a, b) => a - b));
    // eine Vorlage, die auch anderswo vorkommt: Stückzahl dieser Abschnitte, „ganzes Mosaik“ ausdrücklich
    const g = inSel.find((x) => [...x.sheets.keys()].some((k) => !keys.has(k)))!;
    expect(g).toBeTruthy();
    let here = 0;
    for (const [k, v] of g.sheets) if (keys.has(k)) here += v;
    expect(here).toBeLessThan(g.count);
    expect(txt).toContain(`${here}× · ganzes Mosaik: ${g.count}×`);
  });

  it('ganzes Mosaik: alle Vorlagen mit Gesamtstückzahl, ohne Zusatz', async () => {
    const facts = pdfLayoutFacts(base, opts);
    expect(facts.templateGroups).toBe(tpl.groups.length);
    expect(facts.templateSections).toHaveLength(tpl.groups.length);
    const rep = await generatePdfReport(base, opts);
    expect(allText(rep.pdf)).not.toContain('ganzes Mosaik:');
  });

  it('Schätzung eines Teils aus der Messung des Ganzen zählt nur Vorlagen seiner Abschnitte', () => {
    const facts = pdfLayoutFacts(base, opts);
    const ids = PARTS[2];
    const keys = keysOf(ids);
    const n = tpl.groups.filter((g) => [...g.sheets.keys()].some((k) => keys.has(k))).length;
    const exact = planForSelection(layout, sections, opts, ids, stonesOf, pdfLayoutFacts(base, { ...opts, sectionIds: ids }), ids);
    const est = planForSelection(layout, sections, opts, ids, stonesOf, facts, null);
    expect(Math.abs(est.templates - exact.templates)).toBeLessThanOrEqual(1);
    expect(n).toBeLessThan(tpl.groups.length);
  });

  it('„Teil 2 von 3“ auf dem Deckblatt und „Teil 2/3“ in jeder Fußzeile; ohne Teil nichts davon', async () => {
    const rep = await generatePdfReport({ ...base, part: { index: 1, total: 3 } }, { ...opts, sectionIds: PARTS[1] });
    const txt = allText(rep.pdf);
    expect(txt).toContain('Teil 2 von 3');
    expect(txt).toContain('Teil 2 von 3 · Abschnitte B2-B3, C1');
    expect([...txt.matchAll(/Teil 2\/3 · /g)].length).toBe(rep.pages);
    const plain = allText((await generatePdfReport(base, { ...opts, sectionIds: PARTS[1] })).pdf);
    expect(plain).not.toMatch(/Teil \d+ von \d+|Teil \d+\/\d+/);
  });
});

describe('Rundung und Hinweise in den PDF-Listen', () => {
  it('Stückmaße in Zuschnitt- und Koordinatenlisten mit höchstens 1 Nachkommastelle', async () => {
    for (const coordMode of ['compact', 'perStone'] as const) {
      const rep = await generatePdfReport(base, { ...opts, includeTemplates: false, coordMode, coordLimit: 400, sectionIds: ['A1', 'A2'] });
      const coordStreams = pdfStreams(rep.pdf).filter((s) => /Koordinaten/.test(texts(s).join(' ')));
      expect(coordStreams.length).toBeGreaterThan(0);
      const sizes = coordStreams.flatMap(texts).filter((x) => /^\d+(,\d+)? × \d+(,\d+)?$/.test(x));
      expect(sizes.length, coordMode).toBeGreaterThan(0);
      expect(sizes.filter((x) => /,\d\d/.test(x)), coordMode).toEqual([]);
    }
  });
  it('Flächen der Materialliste einheitlich mit 4 Nachkommastellen, Anteile mit 1', async () => {
    const rep = await generatePdfReport(base, { ...opts, includeTemplates: false, coordMode: 'off', includeCoords: false });
    const txt = allText(rep.pdf);
    const areas = [...txt.matchAll(/(\d+,\d+) m²/g)].map((m) => m[1]);
    expect(areas.length).toBeGreaterThanOrEqual(4);
    for (const a of areas) expect(a).toMatch(/^\d+,\d{4}$/);
    const pcts = [...txt.matchAll(/\((\d+,\d+) %\)/g)].map((m) => m[1]);
    expect(pcts.length).toBeGreaterThanOrEqual(3);
    for (const p of pcts) expect(p).toMatch(/^\d+,\d$/);
  });
  it('ohne Material: kein „Summe der Kosten entspricht den Materialkosten“', async () => {
    const rep = await generatePdfReport(base, { ...opts, includeTemplates: false, includeCoords: false, coordMode: 'off' });
    const txt = allText(rep.pdf).replace(/\s+/g, ' ');
    expect(txt).not.toContain('entspricht den Materialkosten');
    expect(txt).toContain('Keiner Farbe ist ein Material zugeordnet');
  });
  it('Material mit Preis: Hinweis auf die Kostensumme bleibt', async () => {
    const mat = { id: 'm1', type: 'glass' as const, manufacturer: 'X', product: 'P', colorNumber: 'C1', colorName: 'c', hex: '#808080', lengthMm: 5, widthMm: 5, thicknessMm: 4, price: 3, packageSize: '', piecesPerPack: 100 };
    const palette = res.palette.map((p, i) => (i === 0 ? { ...p, materialId: 'm1' } : p));
    const rep = await generatePdfReport({ ...base, palette, materials: [mat] }, { ...opts, includeTemplates: false, includeCoords: false, coordMode: 'off' });
    expect(allText(rep.pdf).replace(/\s+/g, ' ')).toContain('entspricht den Materialkosten');
  });
});

describe('Dateinamen', () => {
  it('Wort „Verlegeplan“ in der Sprache der Oberfläche, nur ASCII', () => {
    for (const lang of ['de', 'en', 'tr'] as const) expect((dictionaries[lang] as Record<string, string>)['w5fp.file.stem']).toMatch(/^[a-z-]+$/);
    expect(exportFileName('Katze', { stem: 'laying-plan' })).toBe('Katze_laying-plan.pdf');
    expect(exportFileName('Katze', { stem: 'doseme-plani', range: 'A1-B2', part: { index: 0, total: 3, word: 'kisim', ofWord: 'toplam' } })).toBe('Katze_doseme-plani_kisim-1-toplam-3_A1-B2.pdf');
    // ohne Angabe wie bisher
    expect(exportFileName('Katze')).toBe('Katze_verlegeplan.pdf');
  });
});

describe('Zähler „manuelle Änderungen“ netto', () => {
  it('Bearbeiten +1, Rückgängig −1, Wiederholen +1, nie unter 0', () => {
    let n = nextManualEdits(undefined, 1);
    expect(n).toBe(1);
    n = nextManualEdits(n, 1);
    n = nextManualEdits(n, -1);
    n = nextManualEdits(n, -1);
    expect(n).toBe(0);
    n = nextManualEdits(n, 1); // Wiederholen
    expect(n).toBe(1);
    expect(nextManualEdits(0, -1)).toBe(0);
  });
});
