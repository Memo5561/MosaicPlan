/**
 * Prüft, dass das PDF genau die Steine der Vorschau/Berechnung enthält
 * (Anzahl je Farbe auf den Verlegeblättern) und alle Pflichtteile vorhanden sind.
 * Dazu (Welle 3): ehrliche Kürzung der Koordinatenliste, Lesezeichen/Titel/PrintScaling, ein gemeinsamer
 * Anpassungsmaßstab, Seitenzahlen im druckbaren Bereich, Anschlussbeschriftung neben dem Mosaik und
 * Schutz vor einer beschädigten Farbzuordnung.
 */
import { inflateSync } from 'node:zlib';
import { jsPDF } from 'jspdf';
import { describe, expect, it } from 'vitest';
import { hexToLab, hexToRgb } from '../src/core/color';
import { cellId, computeLayout, computeSections, computeSectionsByCount, type Layout, type SectionGrid } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { collectTemplates, countStones, DEFAULT_PDF_OPTIONS, generatePdf, type PdfOptions } from '../src/core/pdf';
import { fitSheetScale, fmtScale, sheetPrintArea } from '../src/core/pdfOptions';
import { planSheets } from '../src/core/pdfPlan';
import { CutCache, computeStats, makeRawSizeFn } from '../src/core/stats';
import { createEmptyMosaic, DEFAULT_SETTINGS, DEFAULT_SHAPES, type Material, type MosaicData, type PaletteColor } from '../src/core/types';
import { makeT } from '../src/i18n';
import { fontBase64, loadPng, prepareFor } from './helpers';

function pdfStreams(buf: ArrayBuffer): string[] {
  const s = Buffer.from(buf).toString('latin1');
  const out: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    // Länge aus dem Stream-Wörterbuch (das letzte Datenbyte kann selbst \r oder \n sein)
    const len = Number(s.slice(Math.max(0, m.index - 200), m.index).match(/\/Length (\d+)(?![\s\S]*\/Length)/)?.[1]);
    const end = Number.isFinite(len) ? start + len : s.indexOf('endstream', start);
    if (end < 0) break;
    const raw = Buffer.from(Number.isFinite(len) ? s.slice(start, end) : s.slice(start, end).replace(/\r?\n$/, ''), 'latin1');
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

// ---------- kleiner PDF-Leser für die jsPDF-Ausgabe (Objekte, Seiten, Lesezeichen, Texte)
const PT = 72 / 25.4;

/** PDF-Zeichenkette (Inhalt zwischen Klammern) dekodieren: Escapes, oktal, UTF-16BE mit BOM */
function pdfString(raw: string): string {
  const s = raw.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) =>
    /^[0-7]/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[e] ?? e,
  );
  if (s.startsWith('þÿ')) {
    let out = '';
    for (let i = 2; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return out;
  }
  // WinAnsi (Helvetica): 0x80–0x9F weichen von Latin-1 ab
  const win: Record<number, string> = { 0x80: '€', 0x84: '„', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—' };
  return s.replace(/[\u0080-\u009f]/g, (c) => win[c.charCodeAt(0)] ?? c);
}

interface ParsedPdf {
  raw: string;
  objs: Map<number, string>;
  /** Objektnummern der Seiten in Reihenfolge */
  pages: number[];
  pageText: (pageNo: number) => string;
  pageContent: (pageNo: number) => string;
  outline: { title: string; page: number; parent: number | null; id: number }[];
}

function parsePdf(buf: ArrayBuffer): ParsedPdf {
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
  const pageText = (pageNo: number) =>
    [...pageContent(pageNo).matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
      .map((m) => pdfString(m[1]))
      .join('\n')
      .replace(/\u0000/g, '');
  const outline: ParsedPdf['outline'] = [];
  for (const [id, o] of objs) {
    const dest = o.match(/\/Dest \[(\d+) 0 R/);
    const title = o.match(/\/Title \(((?:\\.|[^\\)])*)\)/);
    if (!dest || !title) continue;
    const parent = o.match(/\/Parent (\d+) 0 R/);
    outline.push({ id, title: pdfString(title[1]), page: pages.indexOf(Number(dest[1])) + 1, parent: parent ? Number(parent[1]) : null });
  }
  return { raw, objs, pages, pageText, pageContent, outline };
}

/** Linkziele (Seitenzahlen) der Link-Anmerkungen einer Seite */
function linkTargets(p: ParsedPdf, pageNo: number): number[] {
  // jsPDF schreibt die Link-Anmerkungen direkt in das Seitenobjekt (/Annots [<< … /Dest [n 0 R …] >>])
  const po = p.objs.get(p.pages[pageNo - 1]) ?? '';
  return [...po.matchAll(/\/Dest \[(\d+) 0 R/g)].map((m) => p.pages.indexOf(Number(m[1])) + 1);
}

const tDe = makeT('de');
/** Text ohne Zeilenumbrüche (umbrochene Sätze vergleichbar machen) */
const flat = (s: string) => s.replace(/\s+/g, ' ');
const pc = (code: number, hex: string): PaletteColor => ({ code, hex, name: `Farbe ${code}`, lab: hexToLab(hex) });
const baseInput = (layout: Layout, data: MosaicData, palette: PaletteColor[], sections: SectionGrid, materials: Material[] = []) => ({
  projectName: 'Test',
  dateStr: '08.11.2026',
  layout,
  data,
  palette,
  materials,
  settings: { ...DEFAULT_SETTINGS, reservePct: 10 },
  sections,
  t: tDe,
  locale: 'de' as const,
});
const lean: PdfOptions = { ...DEFAULT_PDF_OPTIONS, includeImages: false, includeTemplates: false, includeCoords: false };

/** Mosaik nur aus ganzen Steinen (Schachbrett aus zwei Farben) */
function squaresProject(widthMm: number, heightMm: number, tile = 5) {
  const layout = computeLayout({ widthMm, heightMm, tileW: tile, tileH: tile, joint: 1, edgeMode: 'whole', minCutMm: 2 });
  const data = createEmptyMosaic(layout.cols, layout.rows);
  for (let i = 0; i < data.c1.length; i++) data.c1[i] = i % 2;
  return { layout, data, palette: [pc(1, '#E0D0B0'), pc(2, '#304050')] };
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
    // vollständige Liste: kein Kürzungshinweis
    expect(all).not.toMatch(/gek(ü|\\374)rzt/);
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

  it('countStones je Abschnitt = Steine der Statistik (eine Zählung für Übersicht, Abschnitt und Koordinaten)', () => {
    const raw = makeRawSizeFn(layout, res.palette, []);
    const cache = new CutCache();
    let sum = 0;
    for (const sec of sections.sections) {
      const n = countStones(layout, res.data, raw, sec, cache);
      expect(n).toBe(computeStats(layout, res.data, res.palette, [], { reservePct: 10, groutDepthMm: 3 }, sec, cache).pieces);
      sum += n;
    }
    expect(sum).toBe(stats.pieces);
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
    // Titel und Lesezeichen als Unicode (nicht über safe() vereinfacht)
    const p = parsePdf(pdf);
    expect(p.outline.some((o) => o.title === 'Bölüm A1')).toBe(true);
    const info = [...p.objs.values()].find((o) => /\/Producer/.test(o)) ?? '';
    expect(pdfString(info.match(/\/Title \(((?:\\.|[^\\)])*)\)/)?.[1] ?? '')).toBe('MosaicPlan – Türkçe test – ğüşıöç');
  }, 120000);

  it('Lesezeichen, Dokumenttitel, PrintScaling=None; Abschnitts-Lesezeichen und Übersichts-Links zeigen auf die Abschnittsseite', async () => {
    // 120 × 120 mm passen auf ein A4-Blatt: kompakte Blöcke auf „Abschnittsübersicht“-Seiten statt je eines Deckblatts
    const pdf = await generatePdf(
      { projectName: 'Lesezeichen', dateStr: '08.11.2026', layout, data: res.data, palette: res.palette, materials: [], settings, sections, t: tDe, locale: 'de' },
      { ...DEFAULT_PDF_OPTIONS, includeImages: false, includeTemplates: true, includeCoords: true, coordLimit: 400 },
    );
    const p = parsePdf(pdf);
    expect(p.raw).toContain('/Outlines');
    expect(p.raw).toContain('/PrintScaling /None');
    expect(p.raw).toContain('/DisplayDocTitle true');
    expect(p.raw).toMatch(/\/Title \(MosaicPlan . Lesezeichen\)|\/Title \(þÿ/);
    const top = p.outline.filter((o) => !p.outline.some((q) => q.id === o.parent));
    expect(top.map((o) => o.title)).toEqual(['Deckblatt', 'Gesamtübersicht', 'Farblegende', 'Materialliste', 'Verlegeblätter', 'Schnittvorlagen', 'Koordinaten']);
    const sheetsNode = top.find((o) => o.title === 'Verlegeblätter')!;
    const secNodes = p.outline.filter((o) => o.parent === sheetsNode.id);
    expect(secNodes.map((o) => o.title)).toEqual(sections.sections.map((s) => `Abschnitt ${s.id}`));
    for (const sn of secNodes) {
      const id = sn.title.replace('Abschnitt ', '');
      // Abschnittsseite: Übersichtsseite mit dem Block des Abschnitts (kein eigenes Deckblatt)
      expect(p.pageText(sn.page)).toContain(`Abschnitt ${id}`);
      expect(p.pageText(sn.page)).toContain('Abschnittsübersicht');
      expect(p.pageText(sn.page)).not.toContain('Farblegende und Stückzahlen des Abschnitts');
      const sheetNodes = p.outline.filter((o) => o.parent === sn.id);
      expect(sheetNodes.length).toBe(1);
      sheetNodes.forEach((s, i) => {
        expect(s.title).toBe(`Blatt ${id}-${i + 1}`);
        expect(p.pageText(s.page)).toContain(`Abschnitt ${id} – Blatt ${id}-${i + 1}`);
        // Fußzeile der Blätter: „Blatt A1-1 · Seite 9 / 74“
        expect(p.pageText(s.page)).toContain(`Blatt ${id}-${i + 1} · Seite ${s.page} / ${p.pages.length}`);
      });
    }
    // Übersicht: Zeilen und Kartenrechtecke verlinken genau auf die Abschnittsseiten
    const ovPage = top.find((o) => o.title === 'Gesamtübersicht')!.page;
    const targets = new Set(linkTargets(p, ovPage));
    expect([...targets].sort((a, b) => a - b)).toEqual([...new Set(secNodes.map((s) => s.page))].sort((a, b) => a - b));
    expect(linkTargets(p, ovPage).length).toBe(2 * sections.sections.length);
    // Seitenspalte: die Seitenzahl jedes Abschnitts steht auf der Übersichtsseite
    const ovText = p.pageText(ovPage).split('\n');
    for (const sn of secNodes) expect(ovText).toContain(String(sn.page));
    // jeder Block verlinkt auf sein Blatt und nennt dessen Seite
    const first = secNodes[0];
    const onPage = secNodes.filter((s) => s.page === first.page);
    const sheetsOnPage = onPage.map((s) => p.outline.find((o) => o.parent === s.id)!.page);
    expect(linkTargets(p, first.page).sort((a, b) => a - b)).toEqual(sheetsOnPage.sort((a, b) => a - b));
    for (const s of onPage) {
      const id = s.title.replace('Abschnitt ', '');
      const sp = p.outline.find((o) => o.parent === s.id)!.page;
      // Helvetica (ohne eingebettete Schrift): „→“ wird als „->“ gesetzt
      expect(flat(p.pageText(first.page))).toMatch(new RegExp(`Blatt ${id}-1 (→|->) S\\. ${sp}\\b`));
    }
  }, 120000);

  it('mehrblättriger Abschnitt: Deckblatt mit Farblegende, Mini-Übersicht verlinkt auf die Blätter', async () => {
    const big = computeSections(layout, 300, 300);
    expect(big.sections.length).toBe(1);
    const p = parsePdf(
      await generatePdf(
        { projectName: 'Deckblatt', dateStr: '08.11.2026', layout, data: res.data, palette: res.palette, materials: [], settings, sections: big, t: tDe, locale: 'de' },
        { ...lean, includeTemplates: true },
      ),
    );
    const sn = p.outline.find((o) => o.title === 'Abschnitt A1')!;
    expect(p.pageText(sn.page)).toContain('Farblegende und Stückzahlen des Abschnitts');
    const sheetNodes = p.outline.filter((o) => o.parent === sn.id);
    expect(sheetNodes.length).toBe(4);
    expect(linkTargets(p, sn.page).sort((a, b) => a - b)).toEqual(sheetNodes.map((o) => o.page));
    // „Seiten in diesem PDF“: vom Deckblatt bis zur letzten Seite des Abschnitts (inkl. Zuschnittliste) –
    // einziger Abschnitt, also bis vor die Schnittvorlagen
    const last = p.outline.find((o) => o.title === 'Schnittvorlagen')!.page - 1;
    expect(p.pageText(last)).toContain('Zuschnittliste');
    expect(flat(p.pageText(sn.page))).toContain(`${sn.page}–${last}`);
  }, 120000);

  it('nur ein Abschnitt exportiert: andere Abschnitte in der Seitenspalte „–“, Hinweis gedruckt', async () => {
    const pdf = await generatePdf(
      { projectName: 'Teil', dateStr: '08.11.2026', layout, data: res.data, palette: res.palette, materials: [], settings, sections, t: tDe, locale: 'de' },
      { ...lean, sectionIds: ['B1'] },
    );
    const p = parsePdf(pdf);
    const sheetsNode = p.outline.find((o) => o.title === 'Verlegeblätter')!;
    expect(p.outline.filter((o) => o.parent === sheetsNode.id).map((o) => o.title)).toEqual(['Abschnitt B1']);
    const ovPage = p.outline.find((o) => o.title === 'Gesamtübersicht')!.page;
    const ov = p.pageText(ovPage);
    expect(ov.split('\n').filter((l) => l === '–').length).toBe(sections.sections.length - 1);
    expect(ov).toContain('nicht in diesem PDF enthalten');
  }, 120000);
});

describe('Koordinatenliste je Stein (coordMode perStone): Kürzung wird genau dort gemeldet, wo ein Stein fehlt', () => {
  const coordRows = (p: ParsedPdf) => {
    let n = 0;
    for (let i = 1; i <= p.pages.length; i++) n += (p.pageText(i).match(/^[A-Z]{1,2}\d{3}(-\d)?$/gm) ?? []).length;
    return n;
  };
  const allText = (p: ParsedPdf) => flat(Array.from({ length: p.pages.length }, (_, i) => p.pageText(i + 1)).join('\n'));
  const layout0 = () => squaresProject(100, 100).layout;
  const data0 = () => squaresProject(100, 100).data;
  const palette0 = () => squaresProject(100, 100).palette;
  const run = async (widthMm: number, secMm: number, limit: (pieces: number, sec: SectionGrid, stoneOf: (i: number) => number) => number) => {
    const { layout, data, palette } = squaresProject(widthMm, widthMm);
    const sections = computeSections(layout, secMm, secMm);
    const pieces = computeStats(layout, data, palette, [], { reservePct: 0, groutDepthMm: 3 }).pieces;
    const raw = makeRawSizeFn(layout, palette, []);
    const coordLimit = limit(pieces, sections, (i) => countStones(layout, data, raw, sections.sections[i]));
    const pdf = await generatePdf(baseInput(layout, data, palette, sections), { ...lean, includeCoords: true, coordMode: 'perStone', coordLimit });
    return { p: parsePdf(pdf), pieces, sections, coordLimit };
  };

  it('ein Abschnitt, Limit = Steine − 1 (Grenze fällt auf eine Zellgrenze): Hinweis und Titel „erste … von …“', async () => {
    const { p, pieces, coordLimit } = await run(100, 300, (n) => n - 1);
    const txt = allText(p);
    expect(coordRows(p)).toBe(coordLimit);
    expect(txt).toContain(`erste ${coordLimit} von ${pieces} Steinen – gekürzt, Rest siehe CSV`);
    expect(txt).toContain('Koordinatenliste gekürzt (Limit 255 Steine): aufgeführt sind 255 von 256 Steinen');
    // erster ausgelassener Stein = letzte Position
    expect(txt).toContain('Erster nicht aufgeführter Stein: P016');
  }, 60000);

  it('mehrere Abschnitte, Limit im letzten Abschnitt: Hinweis direkt unter der letzten Tabelle, frühere Abschnitte vollständig', async () => {
    // 40 Steine vor dem Ende: die letzte (gekürzte) Tabelle ist kurz, der Hinweis passt darunter
    const { p, pieces, sections, coordLimit } = await run(100, 50, (n) => n - 40);
    expect(sections.sections.length).toBeGreaterThan(1);
    expect(coordRows(p)).toBe(coordLimit);
    const coordsNode = p.outline.find((o) => o.title === 'Koordinaten')!;
    const secNodes = p.outline.filter((o) => o.parent === coordsNode.id);
    expect(secNodes.length).toBe(sections.sections.length);
    const lastSec = sections.sections[sections.sections.length - 1];
    const lastSecTotal = countStones(layout0(), data0(), makeRawSizeFn(layout0(), palette0(), []), lastSec);
    expect(flat(p.pageText(secNodes[secNodes.length - 1].page))).toContain(`Abschnitt ${lastSec.id} (erste ${lastSecTotal - 40} von ${lastSecTotal} Steinen – gekürzt, Rest siehe CSV)`);
    // Hinweis auf der Seite der letzten Tabelle, direkt darunter (keine eigene Hinweisseite)
    expect(p.pages.length).toBe(secNodes[secNodes.length - 1].page);
    const last = p.pageText(p.pages.length);
    expect(flat(last)).toContain('Koordinatenliste gekürzt');
    expect(last.indexOf('Koordinatenliste gekürzt')).toBeGreaterThan(last.lastIndexOf('Quadrat'));
    for (const sn of secNodes.slice(0, -1)) expect(flat(p.pageText(sn.page))).toMatch(/Steine, vollständig\)/);
    expect(allText(p)).toContain(`aufgeführt sind ${coordLimit} von ${pieces} Steinen`);
  }, 60000);

  it('Limit endet genau an einer Abschnittsgrenze: übrige Abschnitte werden als „ohne Koordinatenliste“ genannt', async () => {
    const { p, sections, coordLimit } = await run(100, 50, (_n, _sec, stoneOf) => stoneOf(0) + stoneOf(1));
    expect(coordRows(p)).toBe(coordLimit);
    const txt = allText(p);
    const rest = sections.sections.slice(2).map((s) => s.id);
    expect(txt).toContain(`Ohne Koordinatenliste (Limit erreicht): Abschnitt ${rest.join(', ')}.`);
    const s2 = sections.sections[2];
    expect(txt).toContain(`Erster nicht aufgeführter Stein: ${cellId(layout0(), s2.r0, s2.c0)}.`);
    // die beiden ausgegebenen Abschnitte sind vollständig
    expect((txt.match(/Steine, vollständig\)/g) ?? []).length).toBe(2);
  }, 60000);

  it('Limit ≥ Steine: kein Kürzungshinweis, alle Titel „vollständig“', async () => {
    for (const lim of [0, 5]) {
      const { p, pieces, sections } = await run(100, 50, (n) => n + lim);
      expect(coordRows(p)).toBe(pieces);
      const txt = allText(p);
      expect(txt).not.toContain('gekürzt');
      expect((txt.match(/Steine, vollständig\)/g) ?? []).length).toBe(sections.sections.length);
    }
  }, 60000);
});

describe('Maßstab „an Seite anpassen“: ein Normmaßstab für alle Blätter', () => {
  const scalesOnSheets = (p: ParsedPdf) => {
    const out = new Set<string>();
    for (let i = 1; i <= p.pages.length; i++) {
      const txt = p.pageText(i);
      if (!/Blatt [A-Z]+\d+-\d+ \(/.test(txt) || !txt.includes('Kontrollstrecke')) continue;
      for (const m of txt.matchAll(/Maßstab (\d+(?:,\d+)?:\d+(?:,\d+)?)/g)) out.add(m[1]);
    }
    return out;
  };

  it('600 × 800 mm auf A4: alle Blätter zeigen denselben Maßstab; auch ein einzeln exportierter Abschnitt', async () => {
    const { layout, data, palette } = squaresProject(600, 800, 8);
    const sections = computeSections(layout, 300, 300);
    const { printW, printH } = sheetPrintArea(210, 297);
    const s = fitSheetScale(sections.sections, printW, printH);
    const all = parsePdf(await generatePdf(baseInput(layout, data, palette, sections), { ...lean, sheetScale: 0 }));
    const one = parsePdf(await generatePdf(baseInput(layout, data, palette, sections), { ...lean, sheetScale: 0, sectionIds: [sections.sections[sections.sections.length - 1].id] }));
    expect([...scalesOnSheets(all)]).toEqual([fmtScale(s, 'de')]);
    expect([...scalesOnSheets(one)]).toEqual([fmtScale(s, 'de')]);
    // jeder Abschnitt passt auf genau ein Blatt
    const sheetsNode = all.outline.find((o) => o.title === 'Verlegeblätter')!;
    for (const sn of all.outline.filter((o) => o.parent === sheetsNode.id)) expect(all.outline.filter((o) => o.parent === sn.id).length).toBe(1);
    // Deckblatt nennt den Maßstab
    expect(all.pageText(1)).toContain(`${fmtScale(s, 'de')} (an Seite angepasst – ein Maßstab für alle Abschnitte)`);
    // nicht 1:1 → Warnung auf den Blättern
    expect(s).toBeLessThan(1);
    expect(all.pageText(all.outline.filter((o) => o.parent === all.outline.find((q) => q.title === 'Abschnitt A1')!.id)[0].page)).toContain('nicht Originalgröße');
  }, 120000);

  it('500 × 700 mm auf A3 quer (2 × 3 Abschnitte) rastet auf 1:1 ein', async () => {
    const { layout, data, palette } = squaresProject(500, 700, 8);
    const sections = computeSectionsByCount(layout, 2, 3);
    const { printW, printH } = sheetPrintArea(420, 297);
    expect(fitSheetScale(sections.sections, printW, printH)).toBe(1);
    const p = parsePdf(await generatePdf(baseInput(layout, data, palette, sections), { ...lean, format: 'a3', orientation: 'landscape', sheetScale: 0 }));
    expect([...scalesOnSheets(p)]).toEqual(['1:1']);
    expect(p.pageText(1)).not.toContain('nicht Originalgröße');
  }, 120000);
});

describe('Druckränder, Anschlussbeschriftung, Spaltennummern', () => {
  /** Text-Positionen (mm, y von oben) mit Drehung aus dem Inhaltsstrom */
  const placements = (content: string, PH: number) =>
    [...content.matchAll(/BT\n\/F\d+ ([\d.]+) Tf\n(?:(?!ET\n)[\s\S])*?\n(?:([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.]+) ([-\d.]+) Tm|([-\d.]+) ([-\d.]+) Td)\n\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => {
      const rot = m[2] !== undefined;
      const x = Number(rot ? m[6] : m[8]) / PT;
      const y = PH - Number(rot ? m[7] : m[9]) / PT;
      return { size: Number(m[1]), rot: rot ? Math.round(Math.atan2(Number(m[3]), Number(m[2])) * (180 / Math.PI)) : 0, x, y, text: pdfString(m[10]) };
    });

  it('Seitenzahl mindestens 6 mm über dem unteren Rand, Kopfzeile mindestens 6 mm unter dem oberen', async () => {
    const { layout, data, palette } = squaresProject(300, 200);
    const sections = computeSections(layout, 300, 300);
    const p = parsePdf(await generatePdf(baseInput(layout, data, palette, sections), lean));
    for (let i = 1; i <= p.pages.length; i++) {
      const pl = placements(p.pageContent(i), 297);
      const pageNo = pl.find((q) => /Seite \d+ \/ \d+$/.test(q.text));
      expect(pageNo, `Seite ${i}`).toBeTruthy();
      // Grundlinie ≥ 6 mm über dem Rand (Unterlängen bei 7 pt ≈ 0,5 mm)
      expect(297 - pageNo!.y - 7 * 0.3528 * 0.24).toBeGreaterThanOrEqual(6);
      const head = pl.find((q) => q.text.startsWith('MosaicPlan · '))!;
      // Oberkante der Großbuchstaben bei 7 pt ≈ 1,8 mm über der Grundlinie
      expect(head.y - 7 * 0.3528 * 0.75).toBeGreaterThanOrEqual(6);
    }
  }, 60000);

  it('Anschluss nach rechts: Beschriftung im rechten Rand neben dem Mosaik, senkrecht mittig, ohne align', async () => {
    const { layout, data, palette } = squaresProject(300, 200);
    const sections = computeSections(layout, 300, 300);
    const p = parsePdf(await generatePdf(baseInput(layout, data, palette, sections), lean));
    // rechte Kante von Blatt A1-1 aus dem gemeinsamen Seitenplan (gleichmäßig verteilte Blätter)
    const sh = planSheets(layout, sections, lean).sections[0].sheets[0];
    const X1 = layout.colX[sh.c1 - 1] + layout.colW[sh.c1 - 1];
    const L = 22;
    const sheet = p.outline.find((o) => o.title === 'Blatt A1-1')!;
    const pl = placements(p.pageContent(sheet.page), 297);
    const join = pl.find((q) => q.text === 'Anschluss Blatt A1-2')!;
    expect(join).toBeTruthy();
    expect(join.rot).toBe(-90);
    // Zeichen liegen rechts von x: x ≥ rechte Mosaikkante, nicht auf den Steinen der letzten Spalte
    expect(join.x).toBeGreaterThanOrEqual(L + X1 + 0.5);
    expect(join.x + 2).toBeLessThanOrEqual(210 - 6);
    // senkrecht mittig: Mitte der Textlänge = Mitte des Blattes (Projektrand oben und unten)
    const T = 29;
    const Y1 = layout.rowY[layout.rows - 1] + layout.rowH[layout.rows - 1];
    const m = new jsPDF({ unit: 'mm' });
    m.setFontSize(join.size);
    const w = m.getTextWidth(join.text);
    expect(Math.abs(join.y + w / 2 - (T + Y1 / 2))).toBeLessThan(0.05);
  }, 60000);

  it('gedrehte Spaltennummern stehen mittig über ihrer Spalte', async () => {
    const { layout, data, palette } = squaresProject(120, 60, 3);
    const sections = computeSections(layout, 300, 300);
    const p = parsePdf(await generatePdf(baseInput(layout, data, palette, sections), lean));
    const sheet = p.outline.find((o) => o.title === 'Blatt A1-1')!;
    const pl = placements(p.pageContent(sheet.page), 297).filter((q) => q.rot === 90 && /^\d+$/.test(q.text));
    expect(pl.length).toBeGreaterThan(10);
    for (const q of pl) {
      const col = Number(q.text) - 1;
      const capH = q.size * 0.3528 * 0.72;
      const centre = 22 + layout.colX[col] + layout.colW[col] / 2;
      // Glyphen liegen links von x (Drehung +90°): Mitte des Zeichenkörpers = x − capH/2
      expect(Math.abs(q.x - capH / 2 - centre)).toBeLessThan(0.15);
    }
  }, 60000);
});

describe('Einkaufsliste und Schutz vor beschädigter Farbzuordnung', () => {
  it('fehlendes Material wird markiert, Farbnummern bleiben ein Wort, gemeinsames Material einmal gekauft', async () => {
    const { layout, data } = squaresProject(60, 40);
    for (let i = 0; i < data.c1.length; i++) data.c1[i] = i % 3;
    const mat: Material = {
      id: 'm1',
      type: 'glass',
      manufacturer: 'Sicis Vetrite Collezione Grande',
      product: 'Iridium Superiore',
      colorNumber: 'VT-1000-GLOSS',
      colorName: '',
      hex: '#808080',
      lengthMm: 20,
      widthMm: 20,
      thicknessMm: 4,
      price: 12,
      packageSize: 'Beutel',
      piecesPerPack: 1000,
    };
    const palette = [{ ...pc(1, '#E0D0B0'), materialId: 'm1' }, { ...pc(2, '#304050'), materialId: 'm1' }, { ...pc(3, '#A04030'), materialId: 'gelöscht' }];
    const sections = computeSections(layout, 300, 300);
    const p = parsePdf(await generatePdf(baseInput(layout, data, palette, sections, [mat]), lean));
    const matPage = p.outline.find((o) => o.title === 'Materialliste')!.page;
    const txt = [p.pageText(matPage), p.pageText(matPage + 1)].join('\n');
    expect(flat(txt)).toContain('Material fehlt in der Materialverwaltung');
    expect(flat(txt)).toContain('Achtung: Farbe 03 ist einem Material zugeordnet, das in der Materialverwaltung fehlt.');
    expect(txt.split('\n')).toContain('VT-1000-GLOSS');
    expect(txt.match(/^1 × Beutel$/gm) ?? []).toHaveLength(1);
    expect(txt.split('\n')).toContain('01, 02');
    const legend = p.pageText(p.outline.find((o) => o.title === 'Farblegende')!.page).split('\n');
    expect(legend).toContain('VT-1000-GLOSS');
  }, 60000);

  it('ungültiger Farbindex: generatePdf bricht mit übersetzter Meldung ab, statt falsche Farben zu drucken', async () => {
    const { layout, data, palette } = squaresProject(40, 40);
    const sections = computeSections(layout, 300, 300);
    data.c1[5] = 7; // Palette hat nur 2 Farben
    await expect(generatePdf(baseInput(layout, data, palette, sections), lean)).rejects.toThrow(/Farbzuordnung des Mosaiks ist ungültig – 1 Stein verweist auf eine Farbe.*Palette: 2 Farben, größter verwendeter Index: 7/);
    data.c1[6] = 9;
    await expect(generatePdf(baseInput(layout, data, palette, sections), lean)).rejects.toThrow(/– 2 Steine verweisen auf Farben.*größter verwendeter Index: 9/);
    const tr = { ...baseInput(layout, data, palette, sections), t: makeT('tr'), locale: 'tr' as const };
    await expect(generatePdf(tr, lean)).rejects.toThrow(/renk ataması geçersiz/);
  });
});
