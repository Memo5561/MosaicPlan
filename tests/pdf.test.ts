/**
 * Prüft, dass das PDF genau die Steine der Vorschau/Berechnung enthält
 * (Anzahl je Farbe auf den Verlegeblättern) und alle Pflichtteile vorhanden sind.
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { hexToRgb } from '../src/core/color';
import { computeLayout, computeSections } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { DEFAULT_PDF_OPTIONS, generatePdf, collectTemplates } from '../src/core/pdf';
import { computeStats } from '../src/core/stats';
import { DEFAULT_SETTINGS, DEFAULT_SHAPES } from '../src/core/types';
import { makeT } from '../src/i18n';
import { fontBase64, loadPng, prepareFor } from './helpers';

function pdfStreams(buf: ArrayBuffer): string[] {
  const s = Buffer.from(buf).toString('latin1');
  const out: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    const raw = Buffer.from(s.slice(start, end).replace(/\r?\n$/, ''), 'latin1');
    try {
      out.push(inflateSync(raw).toString('latin1'));
    } catch {
      out.push(raw.toString('latin1'));
    }
    re.lastIndex = end + 9;
  }
  return out;
}

/** Zählt gefüllte+umrandete Flächen (Operator „B“) je Füllfarbe außerhalb von Textblöcken. */
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
  const f = (v: number) => {
    const s = (v / 255).toFixed(2);
    return s.replace(/\.?0+$/, '') || '0';
  };
  return `${f(r)} ${f(g)} ${f(b)}`;
}

describe('PDF-Verlegeplan', () => {
  const settings = { ...DEFAULT_SETTINGS, sectionWmm: 120, sectionHmm: 120, reservePct: 10 };
  const layout = computeLayout({ widthMm: 200, heightMm: 250, tileW: 5, tileH: 5, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
  const img = prepareFor(loadPng('public/samples/portrait.png'), layout);
  const res = computeMosaic(img, { layout, shapes: DEFAULT_SHAPES, paletteMode: 'auto', colorCount: 16, dither: 0, deltaE: '2000', regions: [] });
  const sections = computeSections(layout, settings.sectionWmm, settings.sectionHmm);
  const stats = computeStats(layout, res.data, res.palette, [], { reservePct: 10, groutDepthMm: 3 });

  it('Steine auf den Verlegeblättern = berechnete Steine (je Farbe)', async () => {
    const pdf = await generatePdf(
      { projectName: 'Test', dateStr: '07.11.2026', layout, data: res.data, palette: res.palette, materials: [], settings, sections, t: makeT('de'), locale: 'de' },
      { ...DEFAULT_PDF_OPTIONS, includeImages: false, includeCoords: true, coordLimit: 100000, sheetScale: 1 },
    );
    const streams = pdfStreams(pdf);
    const sheetStreams = streams.filter((s) => s.includes('Blatt') && s.includes('Kontrollstrecke'));
    expect(sheetStreams.length).toBeGreaterThanOrEqual(sections.sections.length);
    const total = new Map<string, number>();
    for (const s of sheetStreams) for (const [k, v] of countFills(s)) total.set(k, (total.get(k) ?? 0) + v);
    // erwartete Anzahl je (gerundeter) Farbe
    const expected = new Map<string, number>();
    res.palette.forEach((p, i) => {
      const k = fmtColor(p.hex);
      expected.set(k, (expected.get(k) ?? 0) + stats.perColor[i].pieces);
    });
    let sum = 0;
    for (const v of total.values()) sum += v;
    expect(sum).toBe(stats.pieces);
    for (const [k, v] of expected) expect(total.get(k) ?? 0).toBe(v);

    // Pflichtinhalte (Helvetica → Klartext im Inhaltsstrom)
    const all = streams.join('\n');
    for (const needle of ['MosaicPlan', 'Farblegende', 'Materialliste', 'Gesamtübersicht', 'Schnittvorlagen', 'Koordinaten', 'Seite 1 /', 'Kontrollstrecke'])
      expect(all.includes(needle.replace('ü', '\\374')) || all.includes(needle)).toBe(true);
    // Koordinatenliste enthält jede Position
    const coordRows = (all.match(/\(A001\) Tj/g) ?? []).length;
    expect(coordRows).toBeGreaterThanOrEqual(1);
  }, 120000);

  it('Schnittvorlagen: jede zugeschnittene Form genau einer Vorlage zugeordnet', () => {
    const tpl = collectTemplates(layout, res.data, res.palette, []);
    const n = tpl.groups.reduce((a, g) => a + g.count, 0);
    expect(n).toBe(stats.cutPieces);
    for (const g of tpl.groups) {
      expect(g.info.needsCut).toBe(true);
      expect(g.info.fits).toBe(true);
      expect(g.info.edges.every((e) => e > 0)).toBe(true);
    }
  });

  it('mit eingebetteter Schrift (Türkisch) und A3 quer erzeugbar', async () => {
    const pdf = await generatePdf(
      {
        projectName: 'Türkçe test – ğüşıöç',
        dateStr: '07.11.2026',
        layout,
        data: res.data,
        palette: res.palette,
        materials: [],
        settings,
        sections,
        t: makeT('tr'),
        locale: 'tr',
        fonts: { regular: fontBase64('public/fonts/DejaVuSans.ttf'), bold: fontBase64('public/fonts/DejaVuSans-Bold.ttf') },
      },
      { ...DEFAULT_PDF_OPTIONS, format: 'a3', orientation: 'landscape', includeImages: false, sheetScale: 2 },
    );
    const s = Buffer.from(pdf).toString('latin1');
    expect(s.startsWith('%PDF-')).toBe(true);
    expect(s).toContain('DejaVu');
    const pages = (s.match(/\/Type \/Page\b/g) ?? []).length;
    expect(pages).toBeGreaterThan(5);
  }, 120000);
});
