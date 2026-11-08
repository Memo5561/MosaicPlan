/**
 * Korrekturen nach dem Review von Welle 4:
 *  1. Berechnungsschlüssel unabhängig von der Reihenfolge der optionalen Formfelder (bgCutFactor/contourContinuity):
 *     gleicher Stand ⇒ nicht „geändert“, „Änderungen verwerfen“ ⇒ wieder aktuell.
 *  2. Fehlende Akzentfarben: übersprungene Gruppen werden gezählt (nie „keine Gruppe weicht ab“, wenn doch).
 *  3. Codeplan: ganze Steine bekommen eine Nummer (Zoom nach der Rasterseite), sonst ausdrücklich unvollständig;
 *     nur zugeschnittene Steine werden in die Zuschnittliste verwiesen.
 *  4. Verlegeblatt: zugeschnittene Steine immer orange umrandet; „○“ nur in der Legende, wenn Ringe gezeichnet sind.
 *  5. Zuschnittliste: „Kapitel Schnittvorlagen“ nur, wenn die Vorlagen im PDF stehen; kein „0 weitere …“.
 *  6. Prozentanzeige: eine Regel (laidPercentAt) für Listen, Schritt 9 und Abschnittskacheln.
 *  7. Listen-Fortschritt: nur meta.progressSummary wird im gespeicherten Projekt geändert (withProgressSummary).
 *  8. Rückfrage beim Neuberechnen: Rasteränderung exakt erkannt (gridChangeReasons).
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { computeLayout, computeSections, type Layout, type SectionGrid } from '../src/core/layout';
import { computeMosaic, type FixedColor } from '../src/core/mosaic';
import { DEFAULT_PDF_OPTIONS, generatePdfReport, type PdfInput, type PdfOptions } from '../src/core/pdf';
import { codePlanZoom, CODE_PLAN_MAX_K, CODE_PLAN_WHOLE_MAX_K } from '../src/core/pdfPlan';
import { computeStats } from '../src/core/stats';
import { canonShapes, CellKind, createEmptyMosaic, DEFAULT_ADJUST, DEFAULT_SETTINGS, DEFAULT_SHAPES, withShapeOption, type MosaicData, type PaletteColor } from '../src/core/types';
import { dictionaries, makeT } from '../src/i18n';
import { laidPercent, laidPercentAt, withProgressSummary, type ProjectRecord } from '../src/storage/db';
import { gridChangeReasons } from '../src/ui/project/RecomputeGuard';
import { restoreComputedSettings, sameComputeKey, staleReasons } from '../src/ui/project/staleReasons';
import { computeKey, layoutParamsOf } from '../src/ui/project/useProject';
import { baseParams, materialFixed, MATERIALS12, sampleSetup } from './w1-mosaic-core.fixtures';

// ================================================================ 1. Berechnungsschlüssel
function rec(over: Partial<ProjectRecord['settings']> = {}): ProjectRecord {
  return {
    meta: { id: 'p', name: 'P', createdAt: 1, updatedAt: 1, computed: false },
    settings: { ...DEFAULT_SETTINGS, shapes: { ...DEFAULT_SHAPES }, ...over },
    adjust: { ...DEFAULT_ADJUST },
    regions: [],
    palette: [],
  } as ProjectRecord;
}
const withShapes = (r: ProjectRecord, patch: Parameters<typeof withShapeOption>[1]): ProjectRecord => ({ ...r, settings: { ...r.settings, shapes: withShapeOption(r.settings.shapes, patch) } });
const isStale = (r: ProjectRecord) => !sameComputeKey(r.computedWith, computeKey(r));

describe('Berechnungsschlüssel: Reihenfolge der optionalen Formfelder spielt keine Rolle', () => {
  it('×3 + Konturen berechnet, dann ×1 und wieder ×3: nicht geändert', () => {
    let r = withShapes(withShapes(rec(), { bgCutFactor: 3 }), { contourContinuity: true });
    r = { ...r, computedWith: computeKey(r) };
    const back = withShapes(withShapes(r, { bgCutFactor: 1 }), { bgCutFactor: 3 });
    // die Felder stehen jetzt in anderer Reihenfolge im Objekt …
    expect(Object.keys(back.settings.shapes).slice(-2)).toEqual(['contourContinuity', 'bgCutFactor']);
    // … der Schlüssel ist trotzdem derselbe
    expect(computeKey(back)).toBe(r.computedWith);
    expect(isStale(back)).toBe(false);
    expect(staleReasons(back.computedWith, computeKey(back))).toEqual([]);
  });

  it('„Zurücksetzen“ (×1), dann „Änderungen verwerfen“: wieder aktuell, Werte wie berechnet', () => {
    let r = withShapes(withShapes(rec(), { bgCutFactor: 3 }), { contourContinuity: true });
    r = { ...r, computedWith: computeKey(r) };
    const reset = withShapes(r, { bgCutFactor: 1 });
    expect(isStale(reset)).toBe(true);
    expect(staleReasons(reset.computedWith, computeKey(reset)).map((x) => x.group)).toEqual(['shapes']);
    const restored = restoreComputedSettings(reset)!;
    expect(restored.settings.shapes.bgCutFactor).toBe(3);
    expect(restored.settings.shapes.contourContinuity).toBe(true);
    expect(isStale(restored)).toBe(false);
    expect(staleReasons(restored.computedWith, computeKey(restored))).toEqual([]);
  });

  it('gespeicherter Schlüssel mit umgekehrter Reihenfolge (vor der Korrektur) gilt als gleich', () => {
    const r = withShapes(withShapes(rec(), { bgCutFactor: 3 }), { contourContinuity: true });
    const k = JSON.parse(computeKey(r)) as { sh: Record<string, unknown> };
    const { bgCutFactor, contourContinuity, ...restSh } = k.sh;
    const reversed = JSON.stringify({ ...k, sh: { ...restSh, contourContinuity, bgCutFactor } });
    expect(reversed).not.toBe(computeKey(r));
    expect(sameComputeKey(reversed, computeKey(r))).toBe(true);
    expect(staleReasons(reversed, computeKey(r))).toEqual([]);
    // ein echter Unterschied bleibt ein Unterschied
    expect(sameComputeKey(reversed, computeKey(withShapes(r, { bgCutFactor: 4 })))).toBe(false);
  });

  it('Schlüssel ohne die optionalen Felder bleiben Zeichen für Zeichen gleich', () => {
    const sh = { ...DEFAULT_SHAPES };
    expect(JSON.stringify(canonShapes(sh))).toBe(JSON.stringify(sh));
    const r = rec();
    expect(computeKey(r)).toContain(`"sh":${JSON.stringify(DEFAULT_SHAPES)}`);
  });
});

// ================================================================ 2. Fehlende Akzentfarben
describe('Fehlende Akzentfarben: übersprungene Gruppen werden gezählt', () => {
  // nur helle Materialien (Weiß, Haut hell/dunkel, Hellblau, Mittelblau): dunkle Bildpartien finden kein Material
  const light = MATERIALS12.filter((m) => ['m1', 'm3', 'm4', 'm7', 'm8'].includes(m.id));

  it('„Meine Steine – begrenzte Farbanzahl“ mit nur hellen Materialien: kein Vorschlag, aber Gruppen ohne Material gezählt', () => {
    expect(light.length).toBe(5);
    const su = sampleSetup('portrait');
    const fixed: FixedColor[] = materialFixed(light);
    const r = computeMosaic(su.img, { ...baseParams(su), paletteMode: 'auto-snap', colorCount: 8, fixedPalette: fixed });
    const d = r.diagnostics;
    expect(d.missingAccents).toEqual([]);
    expect(d.missingAccentsSkipped).toBeDefined();
    const sk = d.missingAccentsSkipped!;
    expect(sk.noMaterial?.groups ?? 0).toBeGreaterThan(0);
    // jede gezählte Gruppe hat mindestens 2 Steine
    expect(sk.noMaterial!.stones).toBeGreaterThanOrEqual(2 * sk.noMaterial!.groups);
    // die Steine über ΔE 10 existieren wirklich (Zuordnung der Palette)
    const over10 = r.palette.reduce((s, p) => s + (p.matchDeltaE?.over10 ?? 0), 0);
    expect(over10).toBeGreaterThanOrEqual(sk.noMaterial!.stones);
  });

  it('immer zusammen mit missingAccents gesetzt (leer = nichts übersprungen); „Nur eigene Materialien“: beides fehlt', () => {
    const su = sampleSetup('portrait');
    const a = computeMosaic(su.img, { ...baseParams(su), paletteMode: 'auto', colorCount: 12 });
    expect(a.diagnostics.missingAccents).toBeDefined();
    expect(a.diagnostics.missingAccentsSkipped).toBeDefined();
    const m = computeMosaic(su.img, { ...baseParams(su), paletteMode: 'materials', colorCount: 12, fixedPalette: materialFixed(MATERIALS12) });
    expect(m.diagnostics.missingAccents).toBeUndefined();
    expect(m.diagnostics.missingAccentsSkipped).toBeUndefined();
  });

  it('Texte in allen Sprachen, „keine“ nur ohne übersprungene Gruppen', () => {
    for (const lang of ['de', 'en', 'tr'] as const) {
      const d = dictionaries[lang] as Record<string, string>;
      for (const k of ['noMaterial', 'inPalette', 'nearPalette', 'ungrouped']) {
        expect(d[`w4fx.acc.skip.${k}`], `${lang}:${k}`).toBeTruthy();
        expect(d[`w4fx.acc.skip.${k}.one`], `${lang}:${k}.one`).toBeTruthy();
      }
    }
  });
});

// ================================================================ 3.–5. PDF
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
  /** Seitentext, Zeilenumbrüche des Umbruchs zu Leerzeichen */
  const pageText = (pageNo: number) => pageStrings(pageNo).join(' ').replace(/\s+/g, ' ');
  return { pages, pageContent, pageStrings, pageText };
}
/** Farbnummern (zweistellig) mit Position */
function codesOn(content: string, PH: number) {
  return [...content.matchAll(/BT\n\/F\d+ ([\d.]+) Tf\n(?:(?!ET\n)[\s\S])*?\n(?:([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.]+) ([-\d.]+) Tm|([-\d.]+) ([-\d.]+) Td)\n\(((?:\\.|[^\\)])*)\) Tj/g)]
    .map((m) => {
      const rot = m[2] !== undefined;
      return { x: Number(rot ? m[6] : m[8]) / PT, y: PH - Number(rot ? m[7] : m[9]) / PT, text: pdfString(m[10]) };
    })
    .filter((q) => /^\d{2}$/.test(q.text) && q.x >= 21.5 && q.y >= 28.5);
}
/** Zeichenoperatoren außerhalb von Text: 'B' (gefüllt + umrandet) und 'f' (nur gefüllt) */
function paintOps(stream: string): { B: number; f: number; orangeB: number } {
  let B = 0;
  let f = 0;
  let orangeB = 0;
  let stroke = '';
  let inText = false;
  for (const line of stream.split('\n')) {
    const l = line.trim();
    if (l === 'BT') inText = true;
    else if (l === 'ET') inText = false;
    else if (inText) continue;
    else if (/ RG$/.test(l)) stroke = l.replace(/ RG$/, '');
    else if (l === 'B') {
      B++;
      // #E65100 = 0.9 0.32 0.
      if (/^0\.9\d* 0\.31\d* 0\.?0*$|^0\.9\d* 0\.32\d* 0\.?0*$/.test(stroke)) orangeB++;
    } else if (l === 'f') f++;
  }
  return { B, f, orangeB };
}

const tDe = makeT('de');
const pc = (code: number, hex: string): PaletteColor => ({ code, hex, name: `Farbe ${code}`, lab: hexToLab(hex) });
const baseInput = (layout: Layout, data: MosaicData, palette: PaletteColor[], sections: SectionGrid): PdfInput => ({
  projectName: 'W4fx',
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

/** Mosaik aus ganzen Steinen; jede `diagEvery`-te Zelle diagonal geteilt */
function squares(widthMm: number, heightMm: number, tile: number, joint: number, diagEvery: number) {
  const layout = computeLayout({ widthMm, heightMm, tileW: tile, tileH: tile, joint, edgeMode: 'whole', minCutMm: 2 });
  const data = createEmptyMosaic(layout.cols, layout.rows);
  for (let i = 0; i < data.c1.length; i++) {
    data.c1[i] = (i * 7 + Math.floor(i / layout.cols)) % 3;
    if (diagEvery && i % diagEvery === 3) {
      data.kind[i] = CellKind.DIAG_A;
      data.c2[i] = (data.c1[i] + 1) % 3;
    }
  }
  return { layout, data, palette: ['#E0D0B0', '#304050', '#A04030'].map((h, i) => pc(i + 1, h)) };
}

describe('Codeplan-Zoom: ganze Steine zuerst', () => {
  it('Rasterseite zu klein für 8-fach: Zoom bis zur Rasterseite (höchstens CODE_PLAN_WHOLE_MAX_K)', () => {
    // 2-mm-Steine bei 1:8: ganze Steine brauchen k = 9
    const z = codePlanZoom(2, 1, 1 / 8);
    expect(z.k).toBe(9);
    expect(z.wholeComplete).toBe(true);
    // Kleinstteile allein: höchstens CODE_PLAN_MAX_K
    expect(codePlanZoom(5, 0.05, 1).k).toBe(CODE_PLAN_MAX_K);
    expect(codePlanZoom(5, 0.05, 1).complete).toBe(false);
    expect(codePlanZoom(5, 0.05, 1).wholeComplete).toBe(true);
    // winzige Steine bei sehr kleinem Maßstab: unvollständig – ausdrücklich
    const t = codePlanZoom(2, 2, 1 / 20);
    expect(t.k).toBe(CODE_PLAN_WHOLE_MAX_K);
    expect(t.wholeComplete).toBe(false);
    // feinere (nicht zugeschnittene) Steine kleiner als die Rasterseite zählen wie ganze Steine
    expect(codePlanZoom(6, Infinity, 1 / 4, 1.5).k).toBe(Math.ceil(1.8 / (1.5 / 4)));
  });

  it('PDF 1100 × 30 mm, 2-mm-Steine, „an Seite anpassen“: jeder ganze Stein hat im Codeplan eine Nummer, nur Zuschnitte stehen in der Liste', async () => {
    const { layout, data, palette } = squares(1100, 30, 2, 1, 97);
    const sections = computeSections(layout, 2000, 2000);
    const stats = computeStats(layout, data, palette, [], { reservePct: 0, groutDepthMm: 3 });
    const rep = await generatePdfReport(baseInput(layout, data, palette, sections), { ...lean, sheetScale: 0 });
    expect(rep.planMatches).toBe(true);
    const pdf = parsePdf(rep.pdf);
    const all = pdf.pages.map((_, i) => i + 1);
    const codePages = all.filter((i) => pdf.pageText(i).includes('CODEPLAN'));
    expect(codePages.length).toBeGreaterThan(0);
    let numbers = 0;
    for (const i of codePages) numbers += codesOn(pdf.pageContent(i), 297).length;
    // alle ganzen Steine nummeriert (Teile der Dreiecke ggf. nicht – die stehen in der Zuschnittliste)
    expect(numbers).toBeGreaterThanOrEqual(stats.pieces - stats.cutPieces);
    const txt = all.map((i) => pdf.pageText(i)).join('\n');
    expect(txt).not.toContain('nicht zugeschnittene Steine sind auch hier zu klein');
    expect(txt).not.toMatch(/Kleinteile sind auch hier zu klein[^\n]*\b(\d{3,})\b/);
    // Blatt: Verweis auf den vollständigen Codeplan
    expect(txt).toMatch(/Farbnummern: Codeplan S\. \d+/);
    expect(txt).not.toContain('unvollständig');
  }, 180000);

  it('PDF 3000 × 20 mm, 2-mm-Steine, „an Seite anpassen“ (1:20): Codeplan sagt ausdrücklich, dass ganze Steine ohne Nummer bleiben', async () => {
    const { layout, data, palette } = squares(3000, 20, 2, 1, 0);
    const sections = computeSections(layout, 4000, 4000);
    const rep = await generatePdfReport(baseInput(layout, data, palette, sections), { ...lean, sheetScale: 0 });
    expect(rep.planMatches).toBe(true);
    const pdf = parsePdf(rep.pdf);
    const txt = pdf.pages.map((_, i) => pdf.pageText(i + 1)).join('\n');
    expect(txt).toContain('nicht zugeschnittene Steine sind auch hier zu klein für eine Nummer und stehen in keiner Liste dieses PDFs');
    expect(txt).toMatch(/Farbnummern: Codeplan S\. [\d–]+ – unvollständig/);
    // keine ganzen Steine in die Zuschnittliste verwiesen
    expect(txt).not.toContain('Kleinteile sind auch hier zu klein');
  }, 180000);
});

describe('Verlegeblatt-Legende und Zuschnittliste sagen nur, was wirklich da ist', () => {
  it('kleiner Maßstab (Steine nur gefüllt): zugeschnittene Steine trotzdem orange umrandet; ohne Ringe kein „○“ in der Legende', async () => {
    // 8-mm-Steine, ein großer Abschnitt, „an Seite anpassen“ → Raster unter 1,5 mm auf dem Papier
    const { layout, data, palette } = squares(1200, 300, 8, 1, 11);
    const sections = computeSections(layout, 2000, 2000);
    const stats = computeStats(layout, data, palette, [], { reservePct: 0, groutDepthMm: 3 });
    const rep = await generatePdfReport(baseInput(layout, data, palette, sections), { ...lean, sheetScale: 0, codePlan: 'off' });
    const pdf = parsePdf(rep.pdf);
    const sheetPages = pdf.pages.map((_, i) => i + 1).filter((i) => pdf.pageText(i).includes('Kontrollstrecke'));
    expect(sheetPages.length).toBeGreaterThan(0);
    let orange = 0;
    let fills = 0;
    for (const i of sheetPages) {
      const o = paintOps(pdf.pageContent(i));
      orange += o.orangeB;
      fills += o.f;
    }
    // ganze Steine nur gefüllt (kleiner Maßstab), jeder zugeschnittene Stein orange umrandet
    expect(fills).toBeGreaterThan(0);
    expect(orange).toBe(stats.cutPieces);
    const txt = sheetPages.map((i) => pdf.pageText(i)).join('\n');
    expect(txt).toContain('Orange umrandet: zugeschnittener Stein');
    expect(txt).not.toContain('○');
    expect(txt).not.toContain('zu klein für die Farbnummer');
  }, 180000);

  it('Zuschnittliste ohne Schnittvorlagen: kein Verweis auf das Kapitel; ohne „T…“ im Stein kein „0 weitere“', async () => {
    const { layout, data, palette } = squares(150, 100, 5, 1, 7);
    const sections = computeSections(layout, 300, 300);
    const off = parsePdf((await generatePdfReport(baseInput(layout, data, palette, sections), { ...lean, includeTemplates: false })).pdf);
    const offTxt = off.pages.map((_, i) => off.pageText(i + 1)).join('\n');
    expect(offTxt).toContain('Zuschnittliste');
    expect(offTxt).not.toContain('Kapitel Schnittvorlagen');
    expect(offTxt).toContain('Schnittvorlagen sind in diesem PDF nicht enthalten');
    expect(offTxt).not.toMatch(/\b0 weitere tragen/);
    // 1:1 mit 5-mm-Steinen: kein Dreieck trägt „T…“ – Legende ohne „im Stein“
    expect(offTxt).toContain('Vorlage und Maße in der Zuschnittliste');
    expect(offTxt).not.toContain('Vorlagennummer „T…“ im Stein, sonst');
    const on = parsePdf((await generatePdfReport(baseInput(layout, data, palette, sections), { ...lean, includeTemplates: true })).pdf);
    const onTxt = on.pages.map((_, i) => on.pageText(i + 1)).join('\n');
    expect(onTxt).toContain('Die Vorlagen stehen im Kapitel Schnittvorlagen.');
    const lim = parsePdf((await generatePdfReport(baseInput(layout, data, palette, sections), { ...lean, includeTemplates: true, templateLimit: 1 })).pdf);
    const limTxt = lim.pages.map((_, i) => lim.pageText(i + 1)).join('\n');
    expect(limTxt).toContain('Vorlagen bis T1 stehen im Kapitel Schnittvorlagen; höhere Nummern sind nicht im PDF.');
  }, 180000);
});

// ================================================================ 6.–8. Fortschritt und Rückfrage
describe('Prozent, Listen-Fortschritt, Rasteränderung', () => {
  it('laidPercentAt: nie „0“ mit verlegten Steinen, „100“ nur fertig, abgerundet', () => {
    expect(laidPercentAt(2, 6011, 1)).toEqual({ value: 0, lessThan: true });
    expect(laidPercentAt(2, 6011, 0)).toEqual({ value: 0, lessThan: true });
    expect(laidPercentAt(6010, 6011, 1)).toEqual({ value: 99.9, lessThan: false });
    expect(laidPercentAt(6010, 6011, 0)).toEqual({ value: 99, lessThan: false });
    expect(laidPercentAt(6011, 6011, 1)).toEqual({ value: 100, lessThan: false });
    expect(laidPercentAt(1526, 5969, 1)).toEqual({ value: 25.5, lessThan: false });
    expect(laidPercentAt(0, 10, 1)).toEqual({ value: 0, lessThan: false });
    expect(laidPercent(2, 6011)).toEqual({ pct: 0, lessThanOne: true });
  });

  it('withProgressSummary: ändert nur meta.progressSummary (und den Zeitpunkt), nur bei passender Revision', () => {
    const stored: ProjectRecord = { ...rec(), meta: { id: 'p', name: 'Umbenannt in Tab B', createdAt: 1, updatedAt: 50, computed: true }, mosaicRev: 'r1', palette: [pc(1, '#123456')] };
    const next = withProgressSummary(stored, { value: { placed: 1, total: 5539, rev: 'r1' }, updatedAt: 100 })!;
    expect(next.meta.name).toBe('Umbenannt in Tab B');
    expect(next.meta.progressSummary).toEqual({ placed: 1, total: 5539, rev: 'r1' });
    expect(next.meta.updatedAt).toBe(100);
    expect(next.palette).toBe(stored.palette);
    expect(next.settings).toBe(stored.settings);
    // anderswo neu berechnet: nichts schreiben
    expect(withProgressSummary(stored, { value: { placed: 1, total: 5539, rev: 'r0' } })).toBeNull();
    // nachgetragen ohne Bearbeitung: Zeitpunkt bleibt
    expect(withProgressSummary(stored, { value: { placed: 2, total: 5539, rev: 'r1' } })!.meta.updatedAt).toBe(50);
  });

  it('gridChangeReasons: Fuge geändert → feststehend „Raster ändert sich“; gleiches Raster → null', () => {
    const a = layoutParamsOf(rec().settings);
    expect(gridChangeReasons(a, { ...a })).toBeNull();
    expect(gridChangeReasons(a, { ...a, joint: a.joint + 0.5 })).toEqual([{ group: 'joint', from: a.joint, to: a.joint + 0.5 }]);
    expect(gridChangeReasons(a, undefined)).toBeNull();
    // Reihenfolge der Felder egal
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(gridChangeReasons(a, reordered)).toBeNull();
  });
});
