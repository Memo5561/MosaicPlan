/**
 * PDF-Verlegeplan (jsPDF, Einheit mm). Verlegeblätter werden maßstäblich
 * (Standard 1:1) gezeichnet; beim Druck „Tatsächliche Größe / 100 %“ wählen.
 *
 * Tabellen werden mit pdfTable.ts gesetzt (gemessene Spalten, Umbruch statt Überlappung, nie gekürzt).
 * Das PDF trägt Lesezeichen (Kapitel → Abschnitte → Blätter), einen Dokumenttitel, PrintScaling=None
 * (nur ein Hinweis an den Betrachter – der gedruckte Hinweis und die Kontrollstrecke bleiben) und
 * Seitenverweise mit Links in der Gesamtübersicht und den Abschnitts-Miniaturen.
 *
 * Seitenaufbau (Welle 4, gemeinsamer Seitenplan pdfPlan.ts): Blätter gleichmäßig auf Rasterlinien verteilt (keine
 * schmalen Reststreifen); einblättrige Abschnitte als kompakte Blöcke auf „Abschnittsübersicht“-Seiten; nach jedem
 * Blatt ggf. Codeplan-Seiten (vergrößert, nicht maßstäblich, nur Farbnummern) und eine Zuschnittliste, die jeden
 * zugeschnittenen Stein ohne Vorlagennummer im Stein mit seiner Vorlage T# nennt.
 */
import { jsPDF } from 'jspdf';
import { hexToRgb, textColorFor } from './color';
import { paletteDisplayName } from './colorNames';
import { bbox, centroid, fmtMm, type Pt, type ShapeType } from './geometry';
import { invalidFreeCells } from './edits';
import { maxColorIndex } from './integrity';
import { cellId, pieceId, rowLabel, type Layout, type Section, type SectionGrid } from './layout';
import { fitSheetScale, fmtScale, pageSize, sheetPrintArea, SHEET_LEFT_RESERVE, SHEET_TOP_RESERVE, type CodePlanMode, type PdfOptions } from './pdfOptions';
import {
  codePlanParts,
  codePlanZoom,
  CODE_MIN_CELL,
  COORD_NOTICE_RESERVE,
  CUT_LIST,
  cutListPagesOf,
  layoutCutList,
  labelOk,
  layoutTemplateBoxes,
  makeSheetLocator,
  packSummaries,
  planPdfPages,
  planSheets,
  sectionItems,
  SUMMARY,
  summaryBlockHeight,
  summaryChipsPerRow,
  TEMPLATE_BOX,
  TNO_MIN,
  type CutListLayout,
  type LabelDims,
  type PdfLayoutFacts,
  type PdfPagePlan,
  type SectionSheets,
  type SheetRange,
} from './pdfPlan';
import { drawTable, headerAdvance, layoutRow, layoutTable, LINE_FACTOR, PAD_R, PT_MM, wrapWords, type ColSpec, type Measure, type TableCanvas, type TableCell, type TableLayout } from './pdfTable';
import { cellPieces, cutLineItems, type CutInfo } from './pieces';
import { CutCache, computeStats, jointAreaValid, makeRawSizeFn, pieceCutInfo, type Range, type RawSizeFn, type Stats } from './stats';
import { CellKind, type Material, type MosaicData, type PaletteColor, type ProjectSettings } from './types';

export { DEFAULT_PDF_OPTIONS, PAPER, type CodePlanMode, type PaperFormat, type PdfOptions } from './pdfOptions';
export { labelOk, planPdfPages, planSheets, type PdfLayoutFacts, type PdfPagePlan } from './pdfPlan';

export type TFn = (key: string, params?: Record<string, string | number>) => string;

export interface PdfImage {
  dataUrl: string;
  w: number;
  h: number;
}

export interface PdfInput {
  projectName: string;
  dateStr: string;
  layout: Layout;
  data: MosaicData;
  palette: PaletteColor[];
  materials: Material[];
  settings: ProjectSettings;
  sections: SectionGrid;
  original?: PdfImage;
  preview?: PdfImage;
  t: TFn;
  locale: 'de' | 'en' | 'tr';
  fonts?: { regular: string; bold: string };
}

export interface TemplateGroup {
  no: number;
  info: CutInfo;
  count: number;
  color: number;
  ids: string[];
  colors: Set<number>;
  /** Vorkommen je Blatt (Blatt-ID → Anzahl), wenn beim Sammeln eine Blattzuordnung übergeben wurde */
  sheets: Map<string, number>;
}

/**
 * Sammelt alle zuzuschneidenden Steine, gruppiert nach identischer Schnittgeometrie (globale Nummern T1 … nach
 * Häufigkeit – gleich für ganze und abschnittsweise Exporte). Mit `locate` werden die Vorkommen je Blatt gezählt.
 */
export function collectTemplates(
  layout: Layout,
  data: MosaicData,
  palette: PaletteColor[],
  materials: Material[],
  cache = new CutCache(),
  locate?: (row: number, col: number) => { key: string } | null,
): {
  groups: TemplateGroup[];
  bySig: Map<string, TemplateGroup>;
} {
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
          g = { no: 0, info: ci, count: 0, color: p.color, ids: [], colors: new Set(), sheets: new Map() };
          bySig.set(ci.signature, g);
        }
        g.count++;
        g.colors.add(p.color);
        if (g.ids.length < 12) g.ids.push(cellId(layout, row, col) + (ps.length > 1 ? `-${i + 1}` : ''));
        if (locate) {
          const key = locate(row, col)?.key ?? '';
          g.sheets.set(key, (g.sheets.get(key) ?? 0) + 1);
        }
      });
    }
  const groups = [...bySig.values()].sort((a, b) => b.count - a.count);
  groups.forEach((g, i) => (g.no = i + 1));
  return { groups, bySig };
}

/**
 * Anzahl der Steine eines Rasterbereichs – genau die Zählung von computeStats().pieces und der
 * Koordinatenliste: alle Teilstücke aus cellPieces, ohne Teile ohne Fläche (analyzeCut: invalid).
 */
export function countStones(layout: Layout, data: MosaicData, raw: RawSizeFn, range: Range, cache = new CutCache()): number {
  let n = 0;
  for (let row = range.r0; row < range.r1; row++)
    for (let col = range.c0; col < range.c1; col++) {
      if (data.kind[row * layout.cols + col] === CellKind.FULL) {
        n++;
        continue;
      }
      const ps = cellPieces(layout, data, row, col);
      for (let i = 0; i < ps.length; i++) if (!pieceCutInfo(cache, layout, data, row, col, i, ps[i].poly, raw(ps[i].color)).invalid) n++;
    }
  return n;
}

/** Steine, deren Farbindex nicht in der Palette existiert (inkl. Teile ohne Fläche) – nur für die Fehlermeldung. */
function countInvalidColorRefs(layout: Layout, data: MosaicData, paletteLength: number): number {
  let n = 0;
  for (let row = 0; row < layout.rows; row++)
    for (let col = 0; col < layout.cols; col++) for (const p of cellPieces(layout, data, row, col)) if (!(p.color >= 0 && p.color < paletteLength)) n++;
  return n;
}

// ---------------------------------------------------------------- Steine eines Blatts (gemeinsam für Zeichnen und Listen)

/** Ein Stein im Rasterbereich: ganze Zellen ohne Polygon (Rechteck aus Spalte/Zeile), Teilstücke mit Polygon. */
interface StoneVisit {
  row: number;
  col: number;
  /** Teilstück-Index und Anzahl der Teilstücke der Zelle */
  i: number;
  n: number;
  color: number;
  /** null = ganze Zelle (Rechteck colW × rowH) */
  poly: Pt[] | null;
  ci: CutInfo;
  dims: LabelDims;
}

/** Zwischenspeicher für ganze Zellen: Schnittanalyse je (Spaltenbreite, Zeilenhöhe, Rohsteinmaß). */
type FullMemo = Map<string, CutInfo>;

/** Besucht alle Steine (ohne Teile ohne Fläche) eines Rasterbereichs zeilenweise, dann spaltenweise. */
function forEachStone(layout: Layout, data: MosaicData, raw: RawSizeFn, cache: CutCache, memo: FullMemo, r: Range, fn: (v: StoneVisit) => void): void {
  const tile = Math.min(layout.tileW, layout.tileH);
  for (let row = r.r0; row < r.r1; row++) {
    for (let col = r.c0; col < r.c1; col++) {
      const idx = row * layout.cols + col;
      if (data.kind[idx] === CellKind.FULL) {
        const color = data.c1[idx];
        const rs = raw(color);
        const key = `${layout.colW[col]}|${layout.rowH[row]}|${rs.w}x${rs.h}`;
        let ci = memo.get(key);
        if (!ci) {
          const p = cellPieces(layout, data, row, col)[0];
          ci = pieceCutInfo(cache, layout, data, row, col, 0, p.poly, rs);
          memo.set(key, ci);
        }
        if (ci.invalid) continue;
        fn({ row, col, i: 0, n: 1, color, poly: null, ci, dims: { w: layout.colW[col], h: layout.rowH[row], tile } });
        continue;
      }
      const ps = cellPieces(layout, data, row, col);
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        const ci = pieceCutInfo(cache, layout, data, row, col, i, p.poly, raw(p.color));
        if (ci.invalid) continue; // kein Stein (keine Fläche)
        const b = bbox(p.poly);
        fn({ row, col, i, n: ps.length, color: p.color, poly: p.poly, ci, dims: { w: b.w, h: b.h, tile } });
      }
    }
  }
}

/** Darstellung eines Steins auf dem Verlegeblatt bei Maßstab s – EINE Regel für Zeichnen und Zuschnittliste. */
export interface PieceMark {
  /** Farbnummer steht im Stein (labelOk) */
  labelled: boolean;
  /** Stein muss zugeschnitten werden */
  cut: boolean;
  /** Vorlagennummer „T12“ steht als zweite Zeile im Stein (nur gedruckte Vorlagen, Inkreismaß ≥ TNO_MIN) */
  onPieceT: boolean;
  /** Stein steht in der Zuschnittliste des Blatts (zugeschnitten, ohne Vorlagennummer im Stein) */
  listed: boolean;
}

/** Inkreismaß 4 · Fläche ÷ Umfang (mm im Mosaik) */
export function inscribedSize(ci: CutInfo): number {
  let per = 0;
  for (const e of ci.edges) per += e;
  return per > 0 ? (4 * ci.area) / per : 0;
}

export function pieceMark(ci: CutInfo, dims: LabelDims, s: number, tNo: number | null, printed: boolean): PieceMark {
  const labelled = labelOk(dims, s);
  const cut = ci.needsCut;
  const onPieceT = cut && labelled && tNo !== null && printed && inscribedSize(ci) * s >= TNO_MIN - 1e-9;
  return { labelled, cut, onPieceT, listed: cut && !onPieceT };
}

/** Eintrag der Zuschnittliste eines Blatts. */
export interface CutListEntry {
  /** laufende Nummer auf dem Blatt (1 …), Reihenfolge Zeile → Spalte → Teilstück */
  no: number;
  /** Position, z. B. „C014-2“ */
  id: string;
  row: number;
  col: number;
  piece: number;
  color: number;
  shape: ShapeType;
  /** globale Vorlagennummer (collectTemplates) */
  tNo: number | null;
  /** Vorlage ist in diesem PDF gedruckt (sonst „T512 (nicht im PDF)“) */
  inPdf: boolean;
  /** Außenmaß (mm) */
  w: number;
  h: number;
  /** Farbnummer steht auch im Stein */
  labelled: boolean;
}

export interface SheetScan {
  entries: CutListEntry[];
  /** zugeschnittene Steine mit Vorlagennummer im Stein */
  onPiece: { id: string; tNo: number }[];
  /** Steine des Blatts */
  stones: number;
  /** Steine ohne Farbnummer im Stein */
  unlabelled: number;
  /** davon nicht zugeschnitten – stehen in keiner Liste (→ Codeplan) */
  unlabelledUncut: number;
  /** Codeplan-Zoom k (Maßstab der Codeplan-Seiten = Blattmaßstab · k); 0 = kein Codeplan */
  codeK: number;
  /** false: auch beim größten Zoom bleiben Kleinstteile ohne Nummer (sie stehen in der Zuschnittliste) */
  codeComplete: boolean;
  /**
   * false: auch im Codeplan bleiben nicht zugeschnittene Steine ohne Nummer (winzige Steine bei sehr kleinem Maßstab) –
   * sie stehen in keiner Zuschnittliste; Blatt und Codeplan sagen das ausdrücklich.
   */
  codeWholeComplete: boolean;
}

export interface SheetScanOptions {
  /** ist Vorlage Nr. no in diesem PDF gedruckt? */
  printed: (no: number) => boolean;
  codePlan: CodePlanMode;
  /** Zwischenspeicher ganzer Zellen (optional, für mehrere Blätter) */
  memo?: FullMemo;
}

/**
 * Prüft ein Blatt (Rasterbereich bei Maßstab s): Zuschnittliste (jeder zugeschnittene Stein ohne Vorlagennummer
 * im Stein, mit Vorlage aus tpl.bySig), Steine mit „T#“ im Stein, Steine ohne Farbnummer und Codeplan-Zoom.
 * Keine neue Geometrie: alle Werte aus cellPieces/pieceCutInfo (analyzeCut auf den echten Polygonen).
 */
export function scanSheet(
  layout: Layout,
  data: MosaicData,
  raw: RawSizeFn,
  tpl: { bySig: Map<string, TemplateGroup> },
  cache: CutCache,
  range: Range,
  s: number,
  o: SheetScanOptions,
): SheetScan {
  const entries: CutListEntry[] = [];
  const onPiece: { id: string; tNo: number }[] = [];
  let stones = 0;
  let unlabelled = 0;
  let unlabelledUncut = 0;
  // kleinste Seite getrennt nach zugeschnittenen und nicht zugeschnittenen Steinen (siehe codePlanZoom)
  let minSideCut = Infinity;
  let minSideWhole = Infinity;
  forEachStone(layout, data, raw, cache, o.memo ?? new Map(), range, (v) => {
    stones++;
    const tg = v.ci.needsCut ? tpl.bySig.get(v.ci.signature) : undefined;
    const tNo = tg ? tg.no : null;
    const inPdf = tNo !== null && o.printed(tNo);
    const m = pieceMark(v.ci, v.dims, s, tNo, inPdf);
    const side = Math.min(v.dims.w, v.dims.h);
    if (m.cut) {
      if (side < minSideCut) minSideCut = side;
    } else if (side < minSideWhole) minSideWhole = side;
    if (!m.labelled) {
      unlabelled++;
      if (!m.cut) unlabelledUncut++;
    }
    const id = pieceId(layout, v.row, v.col, v.i, v.n);
    if (m.onPieceT && tNo !== null) onPiece.push({ id, tNo });
    else if (m.listed)
      entries.push({ no: entries.length + 1, id, row: v.row, col: v.col, piece: v.i, color: v.color, shape: v.ci.shape, tNo, inPdf, w: v.ci.w, h: v.ci.h, labelled: m.labelled });
  });
  const tile = Math.min(layout.tileW, layout.tileH);
  const codeless = tile * s < CODE_MIN_CELL - 1e-9;
  const need = stones > 0 && (o.codePlan === 'always' || (o.codePlan === 'auto' && (unlabelledUncut > 0 || codeless)));
  const z = need ? codePlanZoom(tile, minSideCut, s, minSideWhole) : { k: 0, complete: true, wholeComplete: true };
  return { entries, onPiece, stones, unlabelled, unlabelledUncut, codeK: z.k, codeComplete: z.complete, codeWholeComplete: z.wholeComplete };
}

/** Zuschnittliste eines Blatts (siehe scanSheet). */
export function sheetCutList(
  layout: Layout,
  data: MosaicData,
  raw: RawSizeFn,
  tpl: { bySig: Map<string, TemplateGroup> },
  cache: CutCache,
  range: Range,
  s: number,
  o: SheetScanOptions,
): CutListEntry[] {
  return scanSheet(layout, data, raw, tpl, cache, range, s, o).entries;
}

/** Seiten je Teil des PDFs (gezählt beim Erzeugen). */
export interface PdfBreakdown {
  front: number;
  sectionCovers: number;
  sectionSummaries: number;
  sheets: number;
  cutLists: number;
  codePlans: number;
  templates: number;
  coords: number;
}

export interface PdfReport {
  pdf: ArrayBuffer;
  /** doc.getNumberOfPages() */
  pages: number;
  breakdown: PdfBreakdown;
  /** Seitenplan mit den Messwerten dieses PDFs */
  plan: PdfPagePlan;
  /** plan.total === pages (Generator und Seitenplan stimmen überein) */
  planMatches: boolean;
}

interface BuildResult {
  doc: jsPDF;
  facts: PdfLayoutFacts;
  breakdown: PdfBreakdown;
  plan: ReturnType<typeof planSheets>;
}

/** Erzeugt das PDF und meldet Seitenzahl, Aufteilung je Teil und den passenden Seitenplan. */
export async function generatePdfReport(input: PdfInput, opts: PdfOptions, onProgress?: (f: number, label: string) => void): Promise<PdfReport> {
  const r = buildPdf(input, opts, onProgress, false);
  const pages = r.doc.getNumberOfPages();
  const plan = planPdfPages(input.layout, input.sections, opts, r.facts.stones, r.facts.templateGroups, r.facts);
  const planMatches = plan.total === pages;
  if (!planMatches) console.warn(`PDF-Seitenplan weicht ab: geplant ${plan.total}, erzeugt ${pages}`, r.breakdown, plan);
  return { pdf: r.doc.output('arraybuffer'), pages, breakdown: r.breakdown, plan, planMatches };
}

export async function generatePdf(input: PdfInput, opts: PdfOptions, onProgress?: (f: number, label: string) => void): Promise<ArrayBuffer> {
  return (await generatePdfReport(input, opts, onProgress)).pdf;
}

/**
 * Misst die textabhängigen Teile des Seitenplans mit dem Code des Generators (Vorspann und Abschnittsdeckblätter
 * auf einem Entwurfsdokument ohne Bilder und Blätter) und zählt je Blatt Zuschnitt-Einträge und Codeplan-Zoom.
 * Mit diesen Werten ist planPdfPages() exakt.
 */
export function pdfLayoutFacts(input: PdfInput, opts: PdfOptions): PdfLayoutFacts {
  return buildPdf(input, opts, undefined, true).facts;
}

function buildPdf(input: PdfInput, opts: PdfOptions, onProgress: ((f: number, label: string) => void) | undefined, dry: boolean): BuildResult {
  const { layout, data, materials, settings, t } = input;
  const loc = input.locale;
  const num = (v: number) => Math.round(v).toLocaleString(loc === 'de' ? 'de-DE' : loc === 'tr' ? 'tr-TR' : 'en-GB');

  // ---------- Schutz: eine beschädigte Farbzuordnung darf nie gedruckt werden (falsche Farben/Summen)
  const maxIdx = maxColorIndex(data);
  // Farbnamen in der Sprache des PDFs: automatische Namen (nameKey) übersetzt, Material- und Benutzernamen wörtlich
  const palette = input.palette.map((p) => (p.nameKey ? { ...p, name: paletteDisplayName(p, input.locale) } : p));
  const cache = new CutCache();
  const statOpts = { reservePct: settings.reservePct, groutDepthMm: settings.groutDepthMm };
  const stats = computeStats(layout, data, palette, materials, statOpts, undefined, cache);
  if (maxIdx >= palette.length || stats.invalidColorPieces > 0) {
    const bad = countInvalidColorRefs(layout, data, palette.length);
    const params = { n: num(bad), count: palette.length, max: maxIdx };
    const one = bad === 1 ? t('pdf.err.integrity.one', params) : '';
    throw new Error(one && one !== 'pdf.err.integrity.one' ? one : t('pdf.err.integrity', params));
  }
  // ---------- Schutz: Flächen müssen der Geometrie entsprechen (überlappende Freiformteile älterer/importierter
  // Projekte zählten doppelt – Steinfläche > Gesamtfläche, negative Fugenfläche und Fugenmasse)
  if (!jointAreaValid(stats)) {
    const bad = invalidFreeCells(layout, data);
    if (bad.length) {
      const ids = bad.slice(0, 20).map((b) => cellId(layout, b.row, b.col)).join(', ') + (bad.length > 20 ? ' …' : '');
      const one = bad.length === 1 ? t('pdf.err.freeInvalid.one', { ids }) : '';
      throw new Error(one && one !== 'pdf.err.freeInvalid.one' ? one : t('pdf.err.freeInvalid', { n: num(bad.length), ids }));
    }
    const area = (v: number) => fmtMm(v / 1e6, 4, loc);
    throw new Error(t('pdf.err.areaInvalid', { stones: area(stats.stoneArea), total: area(stats.finishedArea) }));
  }

  const { PW, PH } = pageSize(opts);
  const portrait = opts.orientation === 'portrait';
  const doc = new jsPDF({ unit: 'mm', format: [PW, PH], orientation: portrait ? 'portrait' : 'landscape', compress: true });
  // Rohe Unicode-Titel: jsPDF schreibt Info und Lesezeichen als UTF-16 (auch Türkisch korrekt)
  doc.setProperties({ title: `MosaicPlan – ${input.projectName}`, subject: t('pdf.layingPlan'), creator: 'MosaicPlan' });
  doc.viewerPreferences({ PrintScaling: 'None', DisplayDocTitle: true });
  const M = 10;
  const AW = PW - 2 * M;
  let FONT = 'helvetica';
  if (input.fonts) {
    doc.addFileToVFS('DejaVuSans.ttf', input.fonts.regular);
    doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
    doc.addFileToVFS('DejaVuSans-Bold.ttf', input.fonts.bold);
    doc.addFont('DejaVuSans-Bold.ttf', 'DejaVu', 'bold');
    FONT = 'DejaVu';
  }
  const f1 = (v: number, d = 1) => fmtMm(v, d, loc);
  const font = (size: number, bold = false) => {
    doc.setFont(FONT, bold ? 'bold' : 'normal');
    doc.setFontSize(size);
  };
  // Ohne eingebettete Schrift (Helvetica, WinAnsi): türkische Buchstaben und Pfeile/Kreise lesbar ersetzen
  const HELV: Record<string, string> = { ğ: 'g', Ğ: 'G', ş: 's', Ş: 'S', ı: 'i', İ: 'I', '→': '->', '←': '<-', '↑': '^', '↓': 'v', '○': 'o' };
  const safe = (s: string) => (FONT === 'helvetica' ? s.replace(/[ğĞşŞıİ→←↑↓○]/g, (c) => HELV[c] ?? c) : s);
  /** Text ohne Drehung (gedrehter Text nur über rotText – jsPDF verschiebt sonst align/baseline vor der Drehung) */
  const text = (s: string, x: number, y: number, o: { align?: 'left' | 'center' | 'right'; baseline?: 'top' | 'middle' | 'bottom' | 'alphabetic' } = {}) =>
    doc.text(safe(s), x, y, { align: o.align, baseline: o.baseline ?? 'alphabetic' });
  /**
   * Gedrehter Text, um (cx, cy) zentriert – ohne align/baseline (die jsPDF vor der Drehung anwendet).
   * −90°: läuft nach unten, die Zeichen liegen rechts von cx + gap. +90°: läuft nach oben, Zeichen links davon.
   */
  const rotText = (s: string, cx: number, cy: number, angle: 90 | -90, gap = 0) => {
    const str = safe(s);
    const w = doc.getTextWidth(str);
    if (angle === -90) doc.text(str, cx + gap, cy - w / 2, { angle: -90 });
    else doc.text(str, cx + gap, cy + w / 2, { angle: 90 });
  };
  const setFill = (hex: string) => {
    const [r, g, b] = hexToRgb(hex);
    doc.setFillColor(r, g, b);
  };
  const setDraw = (hex: string) => {
    const [r, g, b] = hexToRgb(hex);
    doc.setDrawColor(r, g, b);
  };
  const setText = (hex: string) => {
    const [r, g, b] = hexToRgb(hex);
    doc.setTextColor(r, g, b);
  };
  const poly = (pts: Pt[], x0: number, y0: number, s: number, style: 'F' | 'S' | 'FD') => {
    if (pts.length < 3) return;
    const lines: [number, number][] = [];
    for (let i = 1; i < pts.length; i++) lines.push([(pts[i].x - pts[i - 1].x) * s, (pts[i].y - pts[i - 1].y) * s]);
    doc.lines(lines, x0 + pts[0].x * s, y0 + pts[0].y * s, [1, 1], style, true);
  };

  // ---------- Textmessung (mm bei 1 pt) ohne Fontwechsel, mit Cache
  const internalFont = (style: 'normal' | 'bold') => (doc.internal as unknown as { getFont: (name: string, style: string) => unknown }).getFont(FONT, style);
  const fontObj = { normal: internalFont('normal'), bold: internalFont('bold') };
  const mCache = [new Map<string, number>(), new Map<string, number>()];
  const measure: Measure = (s, bold) => {
    const c = mCache[bold ? 1 : 0];
    let v = c.get(s);
    if (v === undefined) {
      v = s ? doc.getStringUnitWidth(safe(s), { font: bold ? fontObj.bold : fontObj.normal, fontSize: 10 }) * PT_MM : 0;
      if (c.size > 100_000) c.clear();
      c.set(s, v);
    }
    return v;
  };
  /** Absatz umbrechen und zeichnen; liefert die Grundlinie der nächsten Zeile */
  const para = (s: string, x: number, y: number, w: number, size: number, o: { bold?: boolean; lh?: number } = {}) => {
    const lh = o.lh ?? size * LINE_FACTOR * PT_MM;
    const lines = wrapWords(s, w, size, !!o.bold, measure);
    font(size, !!o.bold);
    doc.text(lines.map(safe), x, y, { lineHeightFactor: lh / (size * PT_MM) });
    return y + lines.length * lh;
  };

  // ---------- Seitenverwaltung (Seitenzahlen für Lesezeichen, Verweise und Fußzeilen)
  const pg = () => doc.getNumberOfPages();
  let first = true;
  const newPage = (header: string) => {
    if (!first) doc.addPage([PW, PH], portrait ? 'portrait' : 'landscape');
    first = false;
    // Kopfzeile ≥ 6 mm vom Rand (übliche nicht bedruckbare Ränder 4–5 mm)
    font(7);
    setText('#555555');
    const right = safe(header);
    const rw = doc.getTextWidth(right);
    let left = `MosaicPlan · ${input.projectName}`;
    // nur der dekorative Projektname wird bei Platzmangel gekürzt – nie die Seitenangabe rechts
    while (left.length > 12 && doc.getTextWidth(safe(left)) + rw + 4 > AW) left = `${left.slice(0, -2).trimEnd()}…`;
    text(left, M, M - 2);
    doc.text(right, PW - M, M - 2, { align: 'right' });
    setDraw('#BBBBBB');
    doc.setLineWidth(0.2);
    doc.line(M, M - 0.8, PW - M, M - 0.8);
    setText('#000000');
  };
  type Chapter = 'cover' | 'original' | 'preview' | 'overview' | 'legend' | 'materials' | 'sheets' | 'templates' | 'coords';
  const chapterPage = new Map<Chapter, number>();
  const secPage = new Map<string, number>();
  const sheetPages = new Map<string, number[]>();
  const coordPage = new Map<string, number>();
  /** Nacharbeiten mit bekannten Seitenzahlen (Seitenspalte, Links), nach dem Erzeugen aller Seiten */
  const postFills: (() => void)[] = [];

  const shapeName = (s: string) => t(`shape.${s}`);
  const matById = new Map(materials.map((m) => [m.id, m]));
  const code2 = (i: number) => String(palette[i]?.code ?? '?').padStart(2, '0');
  const tc = (key: string, n: number, params: Record<string, string | number>) => {
    if (n === 1) {
      const one = t(`${key}.one`, params);
      if (one !== `${key}.one`) return one;
    }
    return t(key, params);
  };

  // ---------- Tabellen
  let tableHeaderTitle = '';
  const canvas: TableCanvas = {
    measure,
    text: (lines, x, y, o) => {
      font(o.size, o.bold);
      doc.text(lines.map(safe), x, y, { align: o.align === 'right' ? 'right' : undefined, lineHeightFactor: LINE_FACTOR });
    },
    band: (x, y, w, h) => {
      setFill('#EEEAE3');
      doc.rect(x, y, w, h, 'F');
    },
    swatch: (hex, x, y, w, h) => {
      setFill(hex);
      setDraw('#666666');
      doc.setLineWidth(0.1);
      doc.rect(x, y, w, h, 'FD');
    },
    rule: (x1, x2, y) => {
      setDraw('#E2DED6');
      doc.setLineWidth(0.1);
      doc.line(x1, y, x2, y);
    },
    newPage: () => {
      newPage(tableHeaderTitle);
      return M + 6;
    },
  };
  const TABLE_BOTTOM = PH - M - 8;
  const table = (
    title: string,
    cols: ColSpec[],
    header: string[],
    rows: TableCell[][],
    startY: number,
    headerTitle: string,
    o: { rowH?: number; onRow?: (i: number, r: { baseline: number; top: number; h: number }) => void } = {},
  ): { y: number; tl: TableLayout } => {
    const rowH = o.rowH ?? 5;
    const tl = layoutTable(cols, header, rows, measure, AW);
    tableHeaderTitle = headerTitle;
    let y = startY;
    if (title) {
      const tLines = wrapWords(title, AW, 12, true, measure);
      const titleH = 7 + (tLines.length - 1) * 5;
      const firstN = rows.length ? layoutRow(tl, cols, rows[0], measure).n : 1;
      if (y + titleH + headerAdvance(tl, rowH) + (firstN - 1) * tl.lineH > TABLE_BOTTOM) {
        newPage(headerTitle);
        y = M + 8;
      }
      font(12, true);
      doc.text(tLines.map(safe), M, y, { lineHeightFactor: 5 / (12 * PT_MM) });
      y += titleH;
    }
    y = drawTable(canvas, cols, rows, tl, { x: M, y, bottom: TABLE_BOTTOM, rowH, onRow: o.onRow });
    return { y, tl };
  };

  /**
   * Schlüssel/Wert-Block: Beschriftungsbreite = längste gemessene Beschriftung + 3 mm (höchstens 45 %),
   * Beschriftungen und Werte umbrochen, Vorschub nach der längeren Seite.
   */
  const kvLabelW = (items: [string, string][], w: number, size = 9) => {
    let lw = 0;
    for (const [k] of items) lw = Math.max(lw, measure(k, true) * size);
    return Math.min(lw + 3, Math.max(20, 0.45 * w));
  };
  const kvBlock = (
    items: [string, string][],
    x: number,
    y: number,
    w: number,
    o: { size?: number; lh?: number; gap?: number; bottom?: number; onBreak?: () => number; onValue?: (i: number, vx: number, vy: number) => void; dry?: boolean } = {},
  ): number => {
    const size = o.size ?? 9;
    const lh = o.lh ?? 4.2;
    const gap = o.gap ?? 1;
    const labelW = kvLabelW(items, w, size);
    const valueW = Math.max(10, w - labelW);
    const lhf = lh / (size * PT_MM);
    items.forEach(([k, v], i) => {
      const kl = wrapWords(k, labelW - 2, size, true, measure);
      const vl = v ? wrapWords(v, valueW, size, false, measure) : [''];
      const n = Math.max(kl.length, vl.length);
      if (!o.dry && o.bottom !== undefined && o.onBreak && y + (n - 1) * lh > o.bottom) y = o.onBreak();
      if (!o.dry) {
        font(size, true);
        doc.text(kl.map(safe), x, y, { lineHeightFactor: lhf });
        font(size);
        if (v) doc.text(vl.map(safe), x + labelW, y, { lineHeightFactor: lhf });
        o.onValue?.(i, x + labelW, y);
      }
      y += n * lh + gap;
    });
    return y;
  };

  const addImageFit = (img: PdfImage, x: number, y: number, w: number, h: number) => {
    const s = Math.min(w / img.w, h / img.h);
    const iw = img.w * s;
    const ih = img.h * s;
    const ix = x + (w - iw) / 2;
    const iy = y + (h - ih) / 2;
    if (!dry) doc.addImage(img.dataUrl, 'JPEG', ix, iy, iw, ih);
    return { x: ix, y: iy, w: iw, h: ih };
  };

  // ---------- Maßstab der Verlegeblätter: fest oder EIN Normmaßstab für alle Abschnitte des Projekts
  const { printW, printH } = sheetPrintArea(PW, PH);
  const sheetScale = opts.sheetScale > 0 ? opts.sheetScale : fitSheetScale(input.sections.sections, printW, printH);
  const scaleStr = fmtScale(sheetScale, loc);
  const raw = makeRawSizeFn(layout, palette, materials);
  const stonesOf = (sec: Section) => countStones(layout, data, raw, sec, cache);

  onProgress?.(0.02, 'cover');
  // ================= 1. Deckblatt
  newPage(t('pdf.cover'));
  chapterPage.set('cover', pg());
  const coverPage = pg();
  drawCalibration(M, PH - M - 10);
  font(26, true);
  setText('#1D2A3A');
  text('MosaicPlan', M, M + 18);
  font(14);
  setText('#444444');
  text(t('pdf.layingPlan'), M, M + 27);
  setText('#000000');
  let y = para(input.projectName, M, M + 40, AW, 18, { bold: true, lh: 7.3 }) - 7.3;
  font(9);
  text(`${t('pdf.created')}: ${input.dateStr}`, M, y + 7);
  y += 15;
  const kv: [string, string][] = [
    [t('pdf.requestedSize'), `${f1(layout.requestedW / 10, 2)} × ${f1(layout.requestedH / 10, 2)} cm`],
    [t('pdf.finishedSize'), `${f1(layout.finishedW, 2)} × ${f1(layout.finishedH, 2)} mm`],
    [t('pdf.tileSize'), `${f1(layout.tileW, 2)} × ${f1(layout.tileH, 2)} mm`],
    [t('pdf.joint'), `${f1(layout.joint, 2)} mm`],
    [t('pdf.grid'), `${num(layout.cols)} × ${num(layout.rows)} = ${num(layout.cols * layout.rows)} ${t('pdf.positions')}`],
    [t('pdf.stonesTotal'), num(stats.pieces)],
    [t('pdf.colors'), String(palette.length)],
    [t('pdf.sectionsCount'), `${input.sections.scols} × ${input.sections.srows} = ${input.sections.sections.length}`],
    [t('pdf.origin'), t('pdf.originText')],
    [t('pdf.sheetScale'), opts.sheetScale > 0 ? scaleStr : t('pdf.fitScale', { scale: scaleStr })],
  ];
  if (layout.restX > 1e-6 || layout.restY > 1e-6) kv.push([t('pdf.rest'), `${f1(layout.restX, 2)} × ${f1(layout.restY, 2)} mm`]);
  {
    // Platz für alle Angaben + Druckhinweis über der Kontrollstrecke; das Vorschaubild bekommt den Rest
    // (früher wurden Angaben bei Platzmangel stillschweigend weggelassen)
    const contentBottom = PH - M - 14;
    const kvH = kvBlock(kv, M, 0, AW, { gap: 1.3, dry: true });
    const hintH = wrapWords(t('pdf.printHint'), AW, 8, false, measure).length * 3.4;
    if (input.preview) {
      const room = contentBottom - y - kvH - 3 - hintH - 8;
      const h = Math.min(PH * 0.38, room);
      if (h >= 25) {
        const box = addImageFit(input.preview, M, y, AW, h);
        y = box.y + box.h + 8;
      }
    }
    const coverBreak = () => {
      newPage(t('pdf.cover'));
      return M + 8;
    };
    y = kvBlock(kv, M, y, AW, { gap: 1.3, bottom: contentBottom - hintH - 3, onBreak: coverBreak });
    y += 3;
    const hintBottom = pg() === coverPage ? contentBottom : TABLE_BOTTOM;
    if (y + hintH - 3.4 > hintBottom) y = coverBreak();
    setText('#7A2E10');
    para(t('pdf.printHint'), M, y, AW, 8, { lh: 3.4 });
    setText('#000000');
  }

  // ================= 2./3. Originalfoto + Vorschau
  if (opts.includeImages && input.original) {
    newPage(t('pdf.original'));
    chapterPage.set('original', pg());
    font(14, true);
    text(t('pdf.original'), M, M + 8);
    addImageFit(input.original, M, M + 14, AW, PH - 2 * M - 20);
  }
  if (opts.includeImages && input.preview) {
    newPage(t('pdf.preview'));
    chapterPage.set('preview', pg());
    font(14, true);
    text(t('pdf.preview'), M, M + 8);
    addImageFit(input.preview, M, M + 14, AW, PH - 2 * M - 20);
  }

  // ================= 4. Gesamtübersicht
  onProgress?.(0.08, 'overview');
  newPage(t('pdf.overview'));
  chapterPage.set('overview', pg());
  const overviewPage = pg();
  font(14, true);
  text(t('pdf.overview'), M, M + 8);
  {
    const availH = Math.min(PH * 0.55, PH - 2 * M - 30);
    const s = Math.min(AW / layout.finishedW, availH / layout.finishedH);
    const x0 = M + (AW - layout.finishedW * s) / 2;
    const y0 = M + 14;
    if (input.preview) {
      if (!dry) doc.addImage(input.preview.dataUrl, 'JPEG', x0, y0, layout.finishedW * s, layout.finishedH * s);
    }
    else {
      setFill(settings.groutHex);
      doc.rect(x0, y0, layout.finishedW * s, layout.finishedH * s, 'F');
    }
    doc.setLineWidth(0.35);
    setDraw('#E0501E');
    let minSide = Infinity;
    for (const q of input.sections.sections) minSide = Math.min(minSide, q.w, q.h);
    font(Math.max(5, Math.min(14, (minSide * s) / 1.2)), true);
    const ovRects: { id: string; x: number; y: number; w: number; h: number }[] = [];
    for (const sec of input.sections.sections) {
      const rx = x0 + sec.x * s;
      const ry = y0 + sec.y * s;
      doc.rect(rx, ry, sec.w * s, sec.h * s, 'S');
      ovRects.push({ id: sec.id, x: rx, y: ry, w: sec.w * s, h: sec.h * s });
      setText('#FFFFFF');
      const cx = x0 + (sec.x + sec.w / 2) * s;
      const cy = y0 + (sec.y + sec.h / 2) * s;
      setFill('#E0501E');
      const tw = doc.getTextWidth(sec.id) + 2;
      doc.rect(cx - tw / 2, cy - 2.5, tw, 5, 'F');
      text(sec.id, cx, cy, { align: 'center', baseline: 'middle' });
    }
    setText('#000000');
    y = y0 + layout.finishedH * s + 8;
    const ovRows: { id: string; page: number; baseline: number; top: number; h: number }[] = [];
    const sections = input.sections.sections;
    const secRows: TableCell[][] = sections.map((sec) => [
      sec.id,
      `${f1(sec.x)} / ${f1(sec.y)}`,
      `${f1(sec.w)} × ${f1(sec.h)}`,
      `${rowLabel(sec.r0)}–${rowLabel(sec.r1 - 1)}`,
      `${sec.c0 + 1}–${sec.c1}`,
      num(stonesOf(sec)),
      '',
    ]);
    const pageColMin = measure('00000', false) * 8 + 2;
    const ov = table(
      '',
      [{}, { kind: 'tokens' }, { kind: 'tokens' }, {}, {}, { align: 'right' }, { align: 'right', min: pageColMin }],
      [t('pdf.section'), 'X / Y (mm)', t('pdf.sizeMm'), t('pdf.rows'), t('pdf.cols'), t('pdf.stones'), t('pdf.page')],
      secRows,
      y,
      t('pdf.overview'),
      { onRow: (i, r) => ovRows.push({ id: sections[i].id, page: pg(), ...r }) },
    );
    y = ov.y;
    if (opts.sectionIds) {
      setText('#555555');
      y = para(t('pdf.notExportedHint'), M, y, AW, 7);
      setText('#000000');
    }
    postFills.push(() => {
      const tl = ov.tl;
      const last = 6;
      for (const r of ovRows) {
        const p = secPage.get(r.id);
        doc.setPage(r.page);
        font(tl.fontSize);
        doc.text(p ? String(p) : '–', M + tl.xs[last] + tl.widths[last] - PAD_R, r.baseline, { align: 'right' });
        if (p) doc.link(M, r.top, tl.totalW, r.h, { pageNumber: p });
      }
      doc.setPage(overviewPage);
      for (const r of ovRects) {
        const p = secPage.get(r.id);
        if (p) doc.link(r.x, r.y, r.w, r.h, { pageNumber: p });
      }
    });
  }

  // ================= 6. Farblegende
  onProgress?.(0.12, 'legend');
  newPage(t('pdf.legend'));
  chapterPage.set('legend', pg());
  const matLabel = (m: Material | undefined, missing: boolean, none: string, withType = false) =>
    m ? `${withType ? `${t(`mat.${m.type}`)} · ` : ''}${m.manufacturer} ${m.product}`.replace(/\s+/g, ' ').trim() || t(`mat.${m.type}`) : missing ? t('pdf.materialMissing') : none;
  y = table(
    t('pdf.legend'),
    [
      {},
      { kind: 'swatch' },
      { kind: 'text', max: 50 },
      { foldInto: 2, foldOrder: 3 },
      { kind: 'tokens', foldInto: 2, foldOrder: 1 },
      { align: 'right' },
      { align: 'right' },
      { align: 'right' },
      { kind: 'text', max: 60 },
      { foldInto: 8, foldOrder: 2 },
    ],
    [t('pdf.code'), '', t('pdf.name'), 'HEX', 'CIELAB', t('pdf.stones'), t('pdf.rawStones'), t('pdf.withReserve', { p: settings.reservePct }), t('pdf.material'), t('pdf.colorNo')],
    palette.map((p, i) => {
      const cs = stats.perColor[i];
      const m = p.materialId ? matById.get(p.materialId) : undefined;
      return [
        code2(i),
        { swatch: p.hex },
        p.name,
        p.hex,
        `${f1(p.lab[0])}; ${f1(p.lab[1])}; ${f1(p.lab[2])}`,
        num(cs.pieces),
        num(cs.raw),
        num(cs.rawWithReserve),
        matLabel(m, cs.materialMissing, '–'),
        m?.colorNumber || '–',
      ];
    }),
    M + 8,
    t('pdf.legend'),
  ).y;

  // ================= 7. Materialliste
  newPage(t('pdf.materials'));
  chapterPage.set('materials', pg());
  const matBreak = () => {
    newPage(t('pdf.materials'));
    return M + 8;
  };
  y = para(t('pdf.materials'), M, M + 8, AW, 12, { bold: true, lh: 5 }) + 2;
  const mk: [string, string][] = [
    [t('pdf.gridPositions'), num(stats.gridPositions)],
    [t('pdf.stonesTotal'), num(stats.pieces)],
    [t('pdf.uncut'), num(stats.uncutPieces)],
    [t('pdf.cut'), num(stats.cutPieces)],
    [t('pdf.areaTotal'), `${f1(stats.finishedArea / 1e6, 4)} m²`],
    [t('pdf.areaStones'), `${f1(stats.stoneArea / 1e6, 4)} m² (${f1((stats.stoneArea / stats.finishedArea) * 100, 1)} %)`],
    [t('pdf.areaJoints'), `${f1(stats.jointArea / 1e6, 4)} m² (${f1((stats.jointArea / stats.finishedArea) * 100, 1)} %)`],
    [t('pdf.rawTotal'), num(stats.rawTotal)],
    [t('pdf.waste'), `${f1(stats.wasteArea / 1e6, 4)} m² (${f1(stats.wastePct, 1)} %)`],
    [t('pdf.reserve'), `${settings.reservePct} % → ${num(stats.rawWithReserveTotal)} ${t('pdf.rawStones')}`],
    [t('pdf.grout'), `≈ ${f1(stats.groutKg, 2)} kg (${t('pdf.estimate')}, ${t('pdf.depth')} ${f1(settings.groutDepthMm)} mm)`],
  ];
  if (stats.totalCost > 0) mk.push([t('pdf.cost'), `${f1(stats.totalCost, 2)}${stats.costComplete ? '' : ` (${t('pdf.incomplete')})`}`]);
  if (stats.notFitting > 0) mk.push([t('pdf.notFitting'), num(stats.notFitting)]);
  if (stats.invalidPieces > 0) mk.push([t('plan.invalidPieces'), num(stats.invalidPieces)]);
  y = kvBlock(mk, M, y, AW, { gap: 0.8, bottom: TABLE_BOTTOM, onBreak: matBreak });
  y += 2;
  if (stats.missingMaterials.length) {
    setText('#B3261E');
    y = para(t('pdf.missingMaterialsWarn', { codes: stats.missingMaterials.map(code2).join(', ') }), M, y, AW, 8) + 1.5;
    setText('#000000');
  }
  // Bedarf je Farbe: nur Rohsteine (diese Werte addieren sich zur Gesamtzahl). Packungen und Kosten
  // gibt es nur je Material – ein Material für mehrere Farben wird einmal gekauft (stats.perMaterial).
  setText('#555555');
  y = para(t('pdf.perColorHint'), M, y, AW, 7) + 2.5;
  setText('#000000');
  const usedColors = palette.map((p, i) => ({ p, i, cs: stats.perColor[i], m: p.materialId ? matById.get(p.materialId) : undefined })).filter((r) => r.cs.pieces > 0);
  const anyGrid = usedColors.some((r) => r.cs.rawAssumedGrid);
  y = table(
    '',
    [{}, { kind: 'swatch' }, { kind: 'text', max: 45 }, { kind: 'text', max: 70 }, { foldInto: 3, foldOrder: 1 }, { kind: 'tokens' }, { align: 'right' }],
    [t('pdf.code'), '', t('pdf.name'), t('pdf.material'), t('pdf.colorNo'), t('pdf.rawSize'), t('pdf.needed')],
    usedColors.map(({ p, i, cs, m }) => [
      code2(i),
      { swatch: p.hex },
      p.name,
      matLabel(m, cs.materialMissing, t('pdf.noMaterial'), true),
      m?.colorNumber || '–',
      `${f1(cs.rawW)} × ${f1(cs.rawH)}${cs.rawAssumedGrid ? ' *' : ''}`,
      num(cs.rawWithReserve),
    ]),
    y,
    t('pdf.materials'),
  ).y;
  if (anyGrid) {
    setText('#555555');
    y = para(t('pdf.gridAssumed'), M, y - 1, AW, 7) + 1;
    setText('#000000');
  }

  // Einkaufsliste je Material: Summe der Kosten = Materialkosten oben (stats.totalCost)
  if (stats.perMaterial.length) {
    const shopRows: TableCell[][] = stats.perMaterial.map((ms) => {
      const m = ms.material;
      const grid = ms.colors.some((c) => stats.perColor[c]?.rawAssumedGrid);
      return [
        m ? matLabel(m, false, '') : t('pdf.noMaterial'),
        m?.colorNumber || '–',
        ms.colors.map(code2).join(', '),
        `${f1(ms.rawW)} × ${f1(ms.rawH)}${grid ? ' *' : ''}`,
        num(ms.need),
        ms.stock !== undefined ? num(ms.stock) : '–',
        ms.toBuy !== undefined ? num(ms.toBuy) : '–',
        ms.packs !== undefined ? `${ms.packs} × ${m?.packageSize || m?.piecesPerPack}${ms.packsToBuy !== undefined ? ` (${ms.packsToBuy})` : ''}` : '–',
        ms.cost !== undefined ? f1(ms.cost, 2) : '–',
      ];
    });
    shopRows.push(['Σ', '', '', '', num(stats.perMaterial.reduce((a, ms) => a + ms.need, 0)), '', '', '', stats.totalCost > 0 ? f1(stats.totalCost, 2) : '–']);
    y = table(
      t('pdf.shopTitle'),
      // schmales Papier: Farbnr., Farben und Rohsteinmaß als weitere Zeilen unter das Material,
      // Bestand und „zu kaufen“ unter den Bedarf (Überschriften stehen in derselben Reihenfolge)
      [
        { kind: 'text', max: 60 },
        { foldInto: 0, foldOrder: 1 },
        { kind: 'text', max: 40, foldInto: 0, foldOrder: 2 },
        { kind: 'tokens', foldInto: 0, foldOrder: 3 },
        { align: 'right' },
        { align: 'right', foldInto: 4, foldOrder: 4 },
        { align: 'right', foldInto: 4, foldOrder: 5 },
        { kind: 'tokens' },
        { align: 'right' },
      ],
      [t('pdf.material'), t('pdf.colorNo'), t('pdf.shopColors'), t('pdf.rawSize'), t('pdf.needed'), t('pdf.stock'), t('pdf.toBuy'), t('pdf.packs'), t('pdf.costCol')],
      shopRows,
      y + 4,
      t('pdf.materials'),
    ).y;
    setText('#555555');
    y = para(t('pdf.shopHint'), M, y - 1, AW, 7) + 3;
    setText('#000000');
  }
  y = table(
    t('pdf.perShape'),
    [{ kind: 'text', max: 60 }, { align: 'right' }],
    [t('pdf.shape'), t('pdf.count')],
    Object.entries(stats.perShape)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => [shapeName(s), num(n)]),
    y + 4,
    t('pdf.materials'),
  ).y;
  table(
    t('pdf.perSize'),
    [{ kind: 'text', max: 60 }, { kind: 'tokens' }, { align: 'right' }],
    [t('pdf.shape'), t('pdf.sizeMm'), t('pdf.count')],
    stats.perSize.slice(0, 300).map((s) => [shapeName(s.shape), `${f1(s.w)} × ${f1(s.h)}`, num(s.count)]),
    y + 4,
    t('pdf.materials'),
  );

  // ================= Seitenplan: Blattaufteilung (gleichmäßig, gemeinsam mit der Seitenschätzung) und
  // Schnittvorlagen (für Vorlagennummern auf den Blättern, Zuschnittlisten und Koordinaten)
  onProgress?.(0.18, 'templates');
  const facts: PdfLayoutFacts = { front: pg(), coverPages: {}, summaryInfoLines: {}, colorsPerSection: {}, sheets: {}, templateGroups: 0, stones: {} };
  const bd: PdfBreakdown = { front: pg(), sectionCovers: 0, sectionSummaries: 0, sheets: 0, cutLists: 0, codePlans: 0, templates: 0, coords: 0 };
  const plan = planSheets(layout, input.sections, opts);
  const locate = makeSheetLocator(plan, input.sections, layout);
  const tpl = collectTemplates(layout, data, palette, materials, cache, locate);
  facts.templateGroups = tpl.groups.length;
  /** Vorlage im PDF gedruckt? (Vorlagen eingeschaltet und innerhalb des Limits) */
  const tplPrinted = (no: number) => opts.includeTemplates && no <= opts.templateLimit;
  const codeMode: CodePlanMode = opts.codePlan ?? 'auto';
  const fullMemo: FullMemo = new Map();
  const scanOpts: SheetScanOptions = { printed: tplPrinted, codePlan: codeMode, memo: fullMemo };
  const g = layout.joint;
  const topReserve = SHEET_TOP_RESERVE; // Kopf + Spaltennummern + Lineal
  const leftReserve = SHEET_LEFT_RESERVE;
  const secStatsCache = new Map<string, Stats>();
  const secStatsOf = (sec: Section) => {
    let v = secStatsCache.get(sec.id);
    if (!v) {
      v = computeStats(layout, data, palette, materials, statOpts, { r0: sec.r0, r1: sec.r1, c0: sec.c0, c1: sec.c1 }, cache);
      secStatsCache.set(sec.id, v);
    }
    return v;
  };
  const neighborSec = (sec: Section, dr: number, dc: number) => {
    const sr = sec.sr + dr;
    const sc = sec.sc + dc;
    if (sr < 0 || sc < 0 || sr >= input.sections.srows || sc >= input.sections.scols) return null;
    return input.sections.sections[sr * input.sections.scols + sc];
  };
  /** Seiten je Blatt: Codeplan-Seiten und Zuschnittlisten-Seite (für Verweise und Lesezeichen) */
  const sheetExtras = new Map<string, { codePages: number[]; cutPages: number[] }>();
  const sectionLast = new Map<string, number>();
  /** Fußzeile je Seite (statt nur Blatt-IDs): „Blatt A1-1“, „Codeplan A1-1 (1/4)“, „Zuschnittliste A1-1“ */
  const footLabel = new Map<number, string>();
  /** Reihenfolge aller Blätter (für die Vorkommen je Blatt auf den Schnittvorlagen) */
  const sheetOrder = new Map<string, number>();
  plan.sections.forEach((ss) => ss.sheets.forEach((sh) => sheetOrder.set(sh.key, sheetOrder.size)));
  const selectedSheets = new Set<string>();
  for (const ss of plan.sections) if (ss.selected) for (const sh of ss.sheets) selectedSheets.add(sh.key);
  const nSelected = plan.sections.filter((ss) => ss.selected).length;
  let secDone = 0;
  const sectionDone = () => {
    secDone++;
    onProgress?.(0.2 + (0.55 * secDone) / Math.max(1, nSelected), `section ${secDone}`);
  };

  /** Text in einer Breite: Schrift bis `min` pt verkleinern, nie kürzen (liefert die Schriftgröße) */
  const fitSize = (str: string, w: number, size: number, bold = false, min = 4) => {
    const mw = measure(str, bold);
    return mw * size <= w || mw <= 0 ? size : Math.max(min, w / mw);
  };
  const fitText = (str: string, x: number, yv: number, w: number, size: number, o: { bold?: boolean; align?: 'left' | 'right' | 'center'; min?: number } = {}) => {
    font(fitSize(str, w, size, !!o.bold, o.min ?? 4), !!o.bold);
    text(str, x, yv, { align: o.align });
  };
  const tint = (hex: string, f: number) => {
    const [r, gg, b] = hexToRgb(hex);
    const m = (v: number) => Math.round(v + (255 - v) * f);
    return `#${[m(r), m(gg), m(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  };

  // ---------- Abschnittsdeckblatt (mehrere Blätter): Angaben, Mini-Übersicht der Blätter, Farblegende
  function drawSectionCover(ss: SectionSheets) {
    const sec = ss.section;
    const { cx, ry } = ss;
    const nT = ss.sheets.length;
    const secStats = secStatsOf(sec);
    facts.stones[sec.id] = secStats.pieces;
    facts.colorsPerSection[sec.id] = secStats.perColor.filter((c) => c.pieces > 0).length;
    newPage(`${t('pdf.section')} ${sec.id}`);
    if (!chapterPage.has('sheets')) chapterPage.set('sheets', pg());
    const coverPg = pg();
    secPage.set(sec.id, coverPg);
    sheetPages.set(sec.id, []);
    font(16, true);
    text(`${t('pdf.section')} ${sec.id}`, M, M + 9);
    const nb = (dr: number, dc: number) => neighborSec(sec, dr, dc)?.id ?? '–';
    const secKv: [string, string][] = [
      [t('pdf.position'), `X ${f1(sec.x, 2)} mm, Y ${f1(sec.y, 2)} mm (${t('pdf.fromOrigin')})`],
      [t('pdf.sizeMm'), `${f1(sec.w, 2)} × ${f1(sec.h, 2)} mm`],
      [t('pdf.cells'), `${t('pdf.rows')} ${rowLabel(sec.r0)}–${rowLabel(sec.r1 - 1)}, ${t('pdf.cols')} ${sec.c0 + 1}–${sec.c1} (${num((sec.r1 - sec.r0) * (sec.c1 - sec.c0))} ${t('pdf.positions')})`],
      [t('pdf.stones'), num(secStats.pieces)],
      [t('pdf.neighbors'), `${t('dir.N')}: ${nb(-1, 0)} · ${t('dir.E')}: ${nb(0, 1)} · ${t('dir.S')}: ${nb(1, 0)} · ${t('dir.W')}: ${nb(0, -1)}`],
      [t('pdf.jointToNeighbor'), `${f1(g, 2)} mm`],
      [t('pdf.sheets'), `${nT} (${cx.length} × ${ry.length}), ${t('pdf.scale')} ${scaleStr}`],
      [t('pdf.pagesInPdf'), ''],
    ];
    // Mini-Übersicht rechts neben den Angaben – nur wenn dort für die Werte noch ≥ 60 mm bleiben
    // (Breite für Beschriftung + Werte ≥ 140 mm), sonst darunter (schmales Papier: keine negative Breite)
    const ms = Math.min(Math.min(70, AW) / sec.w, 45 / sec.h);
    const mapReserve = sec.w * ms + 6;
    const mapRight = AW - mapReserve - kvLabelW(secKv, AW - mapReserve) >= 60;
    const pagesAt = { x: 0, y: 0, set: false };
    let yy = kvBlock(secKv, M, M + 16, mapRight ? AW - mapReserve : AW, {
      gap: 0.8,
      onValue: (i, vx, vy) => {
        if (i === secKv.length - 1) Object.assign(pagesAt, { x: vx, y: vy, set: true });
      },
    });
    const boxes: { x: number; y: number; w: number; h: number; ti: number; withPage: boolean }[] = [];
    {
      const bx = mapRight ? PW - M - sec.w * ms : M;
      const by = mapRight ? M + 14 : yy + 1;
      doc.setLineWidth(0.2);
      setDraw('#333333');
      font(6);
      let ti = 0;
      for (const [r0, r1] of ry)
        for (const [c0, c1] of cx) {
          ti++;
          const x = bx + (layout.colX[c0] - sec.x) * ms;
          const yv = by + (layout.rowY[r0] - sec.y) * ms;
          const w = (layout.colX[c1 - 1] + layout.colW[c1 - 1] - layout.colX[c0]) * ms;
          const h = (layout.rowY[r1 - 1] + layout.rowH[r1 - 1] - layout.rowY[r0]) * ms;
          doc.rect(x, yv, w, h, 'S');
          const withPage = w > 9 && h > 7;
          if (w > 4 && h > 3) text(`${ti}`, x + w / 2, yv + h / 2 - (withPage ? 1.2 : 0), { align: 'center', baseline: 'middle' });
          boxes.push({ x, y: yv, w, h, ti, withPage });
        }
      yy = mapRight ? Math.max(yy, M + 64) + 2 : by + sec.h * ms + 5;
    }
    postFills.push(() => {
      const pages = sheetPages.get(sec.id) ?? [];
      doc.setPage(coverPg);
      if (pagesAt.set) {
        // Seitenbereich des Abschnitts; Codeplan- und Zuschnittlisten-Seiten darin ausdrücklich genannt
        const range = `${coverPg}–${sectionLast.get(sec.id) ?? coverPg}`;
        let code = 0;
        const cut = new Set<number>();
        for (const sh of ss.sheets) {
          const ex = sheetExtras.get(sh.key);
          code += ex?.codePages.length ?? 0;
          for (const q of ex?.cutPages ?? []) cut.add(q);
        }
        const parts = [code ? t('pdf.w4.coverCode', { n: code }) : '', cut.size ? t('pdf.w4.coverCut', { n: cut.size }) : ''].filter(Boolean);
        const str = parts.length ? t('pdf.w4.coverPages', { range, parts: parts.join(', ') }) : range;
        const kvW = mapRight ? AW - mapReserve : AW;
        fitText(str, pagesAt.x, pagesAt.y, kvW - kvLabelW(secKv, kvW), 9, { min: 6 });
      }
      font(5);
      setText('#555555');
      for (const b of boxes) {
        const p = pages[b.ti - 1];
        if (!p) continue;
        if (b.withPage) text(t('pdf.pageShort', { n: p }), b.x + b.w / 2, b.y + b.h / 2 + 1.8, { align: 'center', baseline: 'middle' });
        doc.link(b.x, b.y, b.w, b.h, { pageNumber: p });
      }
      setText('#000000');
    });
    table(
      t('pdf.sectionLegend'),
      [{}, { kind: 'swatch' }, { kind: 'text', max: 50 }, { foldInto: 2, foldOrder: 1 }, { align: 'right' }, { align: 'right' }, { align: 'right' }, { align: 'right' }],
      [t('pdf.code'), '', t('pdf.name'), 'HEX', t('pdf.stones'), t('pdf.uncut'), t('pdf.cut'), t('pdf.rawStones')],
      secStats.perColor
        .filter((c) => c.pieces > 0)
        .map((c) => [code2(c.color), { swatch: palette[c.color].hex }, palette[c.color].name, palette[c.color].hex, num(c.pieces), num(c.uncut), num(c.cut), num(c.raw)]),
      yy,
      `${t('pdf.section')} ${sec.id}`,
    );
  }

  // ---------- Abschnittsübersicht: kompakter Block je einblättrigem Abschnitt (mehrere je Seite)
  interface SummaryBlock {
    ss: SectionSheets;
    stats: Stats;
    lines: { str: string; size: number }[];
    height: number;
  }
  function summaryBlock(ss: SectionSheets): SummaryBlock {
    const sec = ss.section;
    const st = secStatsOf(sec);
    facts.stones[sec.id] = st.pieces;
    const colors = st.perColor.filter((c) => c.pieces > 0).length;
    facts.colorsPerSection[sec.id] = colors;
    const nb = (dr: number, dc: number) => neighborSec(sec, dr, dc)?.id ?? '–';
    const info = [
      `${t('pdf.position')}: X ${f1(sec.x, 2)} mm, Y ${f1(sec.y, 2)} mm (${t('pdf.fromOrigin')}) · ${t('pdf.sizeMm')}: ${f1(sec.w, 2)} × ${f1(sec.h, 2)} · ${t('pdf.cells')}: ${t('pdf.rows')} ${rowLabel(sec.r0)}–${rowLabel(sec.r1 - 1)}, ${t('pdf.cols')} ${sec.c0 + 1}–${sec.c1} (${num((sec.r1 - sec.r0) * (sec.c1 - sec.c0))} ${t('pdf.positions')})`,
      `${t('pdf.stones')}: ${num(st.pieces)} (${t('pdf.uncut')} ${num(st.uncutPieces)}, ${t('pdf.cut')} ${num(st.cutPieces)}) · ${t('pdf.sheet')} ${ss.sheets[0].key}, ${t('pdf.scale')} ${scaleStr}`,
      `${t('pdf.neighbors')}: ${t('dir.N')}: ${nb(-1, 0)} · ${t('dir.E')}: ${nb(0, 1)} · ${t('dir.S')}: ${nb(1, 0)} · ${t('dir.W')}: ${nb(0, -1)} · ${t('pdf.jointToNeighbor')}: ${f1(g, 2)} mm`,
    ];
    // jede Angabe eine Zeile (Schrift bis 5 pt verkleinert); passt sie auch dann nicht, wird umbrochen
    const w = AW - 4;
    const lines: { str: string; size: number }[] = [];
    for (const l of info) {
      const size = fitSize(l, w, 7, false, 5);
      if (measure(l, false) * size <= w + 1e-6) lines.push({ str: l, size });
      else for (const wl of wrapWords(l, w, 5, false, measure)) lines.push({ str: wl, size: 5 });
    }
    facts.summaryInfoLines[sec.id] = lines.length;
    return { ss, stats: st, lines, height: summaryBlockHeight(lines.length, colors, PW) };
  }
  function drawSummaryPage(p: { blocks: number[]; tops: number[] }, run: SectionSheets[], blocks: SummaryBlock[]) {
    const ids = p.blocks.map((i) => run[i].section.id);
    const head = `${t('pdf.w4.summaryTitle')} ${ids[0]}${ids.length > 1 ? `–${ids[ids.length - 1]}` : ''}`;
    newPage(head);
    if (!chapterPage.has('sheets')) chapterPage.set('sheets', pg());
    const page = pg();
    fitText(head, M, M + SUMMARY.titleY, AW, 12, { bold: true, min: 8 });
    setText('#555555');
    fitText(t('pdf.w4.summaryHint'), M, M + SUMMARY.hintY, AW, 7, { min: 4.5 });
    setText('#000000');
    const perRow = summaryChipsPerRow(PW);
    p.blocks.forEach((bi, k) => {
      const b = blocks[bi];
      const sec = b.ss.section;
      const sh = b.ss.sheets[0];
      secPage.set(sec.id, page);
      sheetPages.set(sec.id, []);
      const top = p.tops[k];
      setDraw('#B8B2A7');
      doc.setLineWidth(0.25);
      doc.rect(M, top, AW, b.height, 'S');
      setFill('#EEEAE3');
      doc.rect(M, top, AW, SUMMARY.titleH - 1, 'F');
      font(9.5, true);
      text(`${t('pdf.section')} ${sec.id}`, M + 2, top + 4.3);
      // „Blatt A1-1 → S. 14“ mit Link, sobald die Seite bekannt ist
      postFills.push(() => {
        const sp = sheetPages.get(sec.id)?.[0];
        if (!sp) return;
        doc.setPage(page);
        const ref = t('pdf.w4.blockSheet', { id: sh.key, p: sp });
        fitText(ref, PW - M - 2, top + 4.3, AW / 2, 7.5, { align: 'right', min: 5 });
        doc.link(M, top, AW, b.height, { pageNumber: sp });
      });
      let ly = top + SUMMARY.titleH + SUMMARY.infoLineH - 0.9;
      for (const l of b.lines) {
        font(l.size);
        text(l.str, M + 2, ly);
        ly += SUMMARY.infoLineH;
      }
      // Farbfelder „07 ×123“ (Steine des Abschnitts je Farbe; Summe = Steine des Abschnitts)
      const used = b.stats.perColor.filter((c) => c.pieces > 0);
      const cy0 = top + SUMMARY.titleH + b.lines.length * SUMMARY.infoLineH + SUMMARY.infoGap;
      used.forEach((c, i) => {
        const x = M + 2 + (i % perRow) * SUMMARY.chipW;
        const yc = cy0 + Math.floor(i / perRow) * SUMMARY.chipH;
        setFill(palette[c.color].hex);
        setDraw('#666666');
        doc.setLineWidth(0.1);
        doc.rect(x, yc + 0.5, 3.2, 3.2, 'FD');
        fitText(`${code2(c.color)} ×${num(c.pieces)}`, x + 4.2, yc + 3.3, SUMMARY.chipW - 5.5, 6.5, { min: 4.5 });
      });
    });
  }

  // ---------- Blattgruppe: je Blatt Verlegeblatt + Codeplan-Seiten, danach die gemeinsame Zuschnittliste
  function emitGroup(group: { ss: SectionSheets; sh: SheetRange }[]) {
    const scans = group.map(({ sh }) => scanSheet(layout, data, raw, tpl, cache, sh, sheetScale, scanOpts));
    const parts = group.map(({ sh }, i) => (scans[i].codeK > 0 ? codePlanParts(layout, sh, sheetScale * scans[i].codeK, printW, printH) : []));
    group.forEach(({ sh }, i) => (facts.sheets[sh.key] = { cutEntries: scans[i].entries.length, codeK: scans[i].codeK }));
    const cl = layoutCutList(
      scans.map((sc) => sc.entries.length),
      PW,
      PH,
    );
    if (dry) return;
    // alle Seitenzahlen der Gruppe vorab (für Verweise auf den Blättern)
    let p = pg();
    const sheetPg: number[] = [];
    const codePgs: number[][] = [];
    group.forEach((_, i) => {
      sheetPg.push(++p);
      codePgs.push(parts[i].map(() => ++p));
    });
    const listStart = p + 1;
    const cutPgs = cl.blocks.map((b) => (b ? cutListPagesOf(cl, b.head, b.end).map((q) => listStart + q) : []));
    group.forEach(({ ss, sh }, i) => {
      sheetExtras.set(sh.key, { codePages: codePgs[i], cutPages: cutPgs[i] });
      drawSheet(ss, sh, scans[i], codePgs[i], cutPgs[i]);
      bd.sheets++;
      parts[i].forEach((part, k) => drawCodePlan(ss, sh, part, k, parts[i].length, scans[i], cutPgs[i]));
      bd.codePlans += parts[i].length;
    });
    if (cl.pages) drawCutList(group, scans, cl);
    bd.cutLists += cl.pages;
  }

  /**
   * Mosaikbereich zeichnen: Fugenfläche, Steine (Farbe oder Codeplan-Tönung), Nummern, Markierungen. Ergebnis: Steine
   * ohne Farbnummer (davon nicht zugeschnitten) und gezeichnete Ringe „○“ – Legende und Hinweise nennen nur, was
   * wirklich gezeichnet wurde.
   */
  function drawStones(range: Range, s: number, L: number, T: number, variant: 'lay' | 'codes'): { unlabelled: number; unlabelledUncut: number; rings: number } {
    const X0 = layout.colX[range.c0];
    const Y0 = layout.rowY[range.r0];
    const X1 = layout.colX[range.c1 - 1] + layout.colW[range.c1 - 1];
    const Y1 = layout.rowY[range.r1 - 1] + layout.rowH[range.r1 - 1];
    const px = (X: number) => L + (X - X0) * s;
    const py = (Y: number) => T + (Y - Y0) * s;
    setFill(variant === 'codes' ? '#FFFFFF' : settings.groutHex);
    doc.rect(px(X0), py(Y0), (X1 - X0) * s, (Y1 - Y0) * s, 'F');
    const minCell = Math.min(layout.tileW, layout.tileH) * s;
    const stroke = minCell >= 1.5 ? 'FD' : 'F';
    const codeSize = Math.max(3.5, Math.min(9, (minCell * 0.42) / 0.3528));
    // Breite von „00“ je pt (Helvetica-Ziffern sind gleich breit)
    const digitW = measureHelvetica00();
    const baseLW = Math.min(0.15, 0.05 * s);
    const cutLW = Math.max(0.12, Math.min(0.25, 0.06 * s));
    let unlabelled = 0;
    let unlabelledUncut = 0;
    let strokeKind = -1;
    const lists: { x: number; y: number; r: number }[] = [];
    const labels: { str: string; x: number; y: number; size: number; color: string; t?: { str: string; y: number; size: number } }[] = [];
    forEachStone(layout, data, raw, cache, fullMemo, range, (v) => {
      const pc = palette[v.color];
      const tg = v.ci.needsCut ? tpl.bySig.get(v.ci.signature) : undefined;
      const tNo = tg ? tg.no : null;
      const m = pieceMark(v.ci, v.dims, s, tNo, tNo !== null && tplPrinted(tNo));
      const hex = pc?.hex ?? '#FF00FF';
      setFill(variant === 'codes' ? tint(hex, 0.6) : hex);
      // Umriss: zugeschnittene Steine orange (nur bei Änderung setzen – kleinerer Inhaltsstrom)
      const sk = variant === 'lay' && m.cut ? 1 : 0;
      if (sk !== strokeKind) {
        strokeKind = sk;
        if (sk) {
          setDraw('#E65100');
          doc.setLineWidth(cutLW);
        } else {
          setDraw(variant === 'codes' ? '#9A9A9A' : '#3A3A3A');
          doc.setLineWidth(variant === 'codes' ? 0.1 : baseLW);
        }
      }
      let cx: number;
      let cy: number;
      // zugeschnittene Steine auf Verlegeblättern IMMER orange umranden (auch bei kleinem Maßstab, wo ganze Steine nur
      // gefüllt werden) – Legende und Zuschnittliste verweisen auf diese Markierung
      const op = sk ? 'FD' : stroke;
      if (v.poly === null) {
        const x = px(layout.colX[v.col]);
        const yv = py(layout.rowY[v.row]);
        doc.rect(x, yv, v.dims.w * s, v.dims.h * s, op);
        cx = x + (v.dims.w * s) / 2;
        cy = yv + (v.dims.h * s) / 2;
      } else {
        poly(v.poly, L - X0 * s, T - Y0 * s, s, op);
        const c = centroid(v.poly);
        cx = px(c.x);
        cy = py(c.y);
      }
      if (!m.labelled || !pc) {
        unlabelled++;
        if (!m.cut) unlabelledUncut++;
        // zugeschnitten, aber zu klein für die Nummer: kleiner Ring („siehe Zuschnittliste“) – nur auf Blättern mit Nummern
        if (variant === 'lay' && m.cut && minCell >= CODE_MIN_CELL - 1e-9) lists.push({ x: cx, y: cy, r: Math.max(0.2, Math.min(0.45, 0.3 * Math.min(v.dims.w, v.dims.h) * s)) });
        return;
      }
      const full = v.poly === null;
      const base = full ? codeSize : Math.max(3, codeSize * 0.75);
      const size = Math.min(base, (Math.min(v.dims.w, v.dims.h) * s * 0.9) / digitW);
      const color = variant === 'codes' ? '#000000' : textColorFor(hex);
      const str = String(pc.code).padStart(2, '0');
      if (variant === 'lay' && m.onPieceT && tNo !== null) {
        const ts = Math.max(3, Math.min(5, size * 0.72));
        const hC = size * PT_MM * 0.72;
        const hT = ts * PT_MM * 0.72;
        const gap = 0.5 * hT + 0.3;
        labels.push({ str, x: cx, y: cy - (hT + gap) / 2, size, color, t: { str: `T${tNo}`, y: cy + (hC + gap) / 2, size: ts } });
      } else labels.push({ str, x: cx, y: cy, size, color });
    });
    // Hilfslinien alle 10 Steine auf der Fugenmitte (wie in Kreuzstichvorlagen) – erleichtern das Abzählen
    setDraw('#2B4C7E');
    doc.setLineWidth(0.12);
    for (let c = range.c0; c < range.c1 - 1; c++) {
      if ((c + 1) % 10 !== 0) continue;
      const x = px((layout.colX[c] + layout.colW[c] + layout.colX[c + 1]) / 2);
      doc.line(x, py(Y0), x, py(Y1));
    }
    for (let r = range.r0; r < range.r1 - 1; r++) {
      if ((r + 1) % 10 !== 0) continue;
      const yv = py((layout.rowY[r] + layout.rowH[r] + layout.rowY[r + 1]) / 2);
      doc.line(px(X0), yv, px(X1), yv);
    }
    // Nummern zuletzt (über den Hilfslinien), Ringe für Kleinteile
    doc.setFont('helvetica', 'normal');
    for (const l of labels) {
      setText(l.color);
      doc.setFontSize(l.size);
      doc.text(l.str, l.x, l.y, { align: 'center', baseline: 'middle' });
      if (l.t) {
        doc.setFontSize(l.t.size);
        doc.text(l.t.str, l.x, l.t.y, { align: 'center', baseline: 'middle' });
      }
    }
    if (lists.length) {
      setDraw('#000000');
      doc.setLineWidth(0.1);
      for (const d of lists) doc.circle(d.x, d.y, d.r, 'S');
    }
    setText('#000000');
    return { unlabelled, unlabelledUncut, rings: lists.length };
  }

  /** Zeilen-/Spaltenbeschriftung und mm-Lineal am Rand des Mosaikbereichs */
  function drawMargins(range: Range, s: number, L: number, T: number) {
    const { c0, c1, r0, r1 } = range;
    const X0 = layout.colX[c0];
    const Y0 = layout.rowY[r0];
    const X1 = layout.colX[c1 - 1] + layout.colW[c1 - 1];
    const Y1 = layout.rowY[r1 - 1] + layout.rowH[r1 - 1];
    const px = (X: number) => L + (X - X0) * s;
    const py = (Y: number) => T + (Y - Y0) * s;
    const labelStep = (pitchPaper: number) => (pitchPaper >= 3 ? 1 : pitchPaper >= 1.2 ? 5 : pitchPaper >= 0.5 ? 10 : 50);
    const cs = labelStep((layout.tileW + g) * s);
    const rs = labelStep((layout.tileH + g) * s);
    setText('#000000');
    doc.setFont('helvetica', 'normal');
    const colFs = Math.max(4, Math.min(7, ((layout.tileW + g) * s * cs) / 0.3528 / 2.4));
    doc.setFontSize(colFs);
    const rotCols = cs === 1 && (layout.tileW + g) * s < 5;
    const capH = colFs * PT_MM * 0.72;
    for (let col = c0; col < c1; col++) {
      if ((col + 1) % cs !== 0 && col !== c0 && cs > 1) continue;
      const xc = px(layout.colX[col] + layout.colW[col] / 2);
      // gedreht: Zeichenkörper mittig auf der Spalte (nicht um ½ Textlänge verschoben)
      if (rotCols) rotText(String(col + 1), xc, T - 9, 90, capH / 2);
      else doc.text(String(col + 1), xc, T - 9, { align: 'center', baseline: 'middle' });
    }
    doc.setFontSize(Math.max(4, Math.min(7, ((layout.tileH + g) * s * rs) / 0.3528 / 1.6)));
    for (let row = r0; row < r1; row++) {
      if ((row + 1) % rs !== 0 && row !== r0 && rs > 1) continue;
      doc.text(rowLabel(row), L - 1.5, py(layout.rowY[row] + layout.rowH[row] / 2), { align: 'right', baseline: 'middle' });
    }
    // Lineal (absolute mm-Koordinaten)
    const tick = s >= 2 ? 1 : s >= 0.8 ? 5 : s >= 0.3 ? 10 : 50;
    const major = tick * 10;
    doc.setLineWidth(0.1);
    setDraw('#000000');
    const rulerY = T - 2;
    doc.line(px(X0), rulerY, px(X1), rulerY);
    doc.setFontSize(4.5);
    for (let v = Math.ceil(X0 / tick) * tick; v <= X1 + 1e-9; v += tick) {
      const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-9;
      doc.line(px(v), rulerY, px(v), rulerY - (isMajor ? 2 : 1));
      if (isMajor) doc.text(`${num(v)}`, px(v), rulerY - 2.6, { align: 'center' });
    }
    const rulerX = L - 9.5;
    doc.line(rulerX, py(Y0), rulerX, py(Y1));
    for (let v = Math.ceil(Y0 / tick) * tick; v <= Y1 + 1e-9; v += tick) {
      const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-9;
      doc.line(rulerX, py(v), rulerX + (isMajor ? 2 : 1), py(v));
      if (isMajor) doc.text(`${num(v)}`, rulerX - 0.6, py(v), { align: 'right', baseline: 'middle' });
    }
  }

  /** Kopfzeile eines Blatts: Titel links, Angaben rechts (oder darunter auf schmalem Papier) */
  function sheetTitle(title: string, parts: string[], titleColor = '#000000') {
    const info = parts.join(' · ');
    setText(titleColor);
    const tsize = fitSize(title, AW, 10, true, 6.5);
    font(tsize, true);
    text(title, M, M + 3.5);
    setText('#000000');
    const tw = measure(title, true) * tsize;
    if (tw + measure(info, false) * 7 + 4 <= AW) {
      font(7);
      text(info, PW - M, M + 3.5, { align: 'right' });
    } else {
      // schmales Papier: Angaben unter den Titel (nie über den Titel drucken), Umbruch zwischen den Angaben;
      // die Zeilen enden über den Spaltennummern (Grundlinie ≤ M + 8,5)
      const size = 6;
      const lines: string[] = [];
      for (const p of parts) {
        const cand = lines.length ? `${lines[lines.length - 1]} · ${p}` : p;
        if (lines.length && measure(cand, false) * size <= AW) lines[lines.length - 1] = cand;
        else lines.push(...wrapWords(p, AW, size, false, measure));
      }
      const fs = lines.length > 2 ? 4.5 : size;
      const lh = fs * 1.2 * PT_MM;
      font(fs);
      doc.text(lines.map(safe), M, M + 8.5 - (lines.length - 1) * lh, { lineHeightFactor: 1.2 });
    }
  }

  const pagesStr = (ps: number[]) => (ps.length > 1 ? `${ps[0]}–${ps[ps.length - 1]}` : String(ps[0]));

  function drawSheet(ss: SectionSheets, sh: SheetRange, scan: SheetScan, codePages: number[], cutPages: number[]) {
    const sec = ss.section;
    const s = sheetScale;
    const { no: ti, count: nT, c0, c1, r0, r1, tx, ty, ntx, nty } = sh;
    newPage(`${t('pdf.section')} ${sec.id} · ${t('pdf.sheet')} ${ti}/${nT}`);
    sheetPages.get(sec.id)?.push(pg());
    footLabel.set(pg(), `${t('pdf.sheet')} ${sh.key}`);
    const X0 = layout.colX[c0];
    const Y0 = layout.rowY[r0];
    const X1 = layout.colX[c1 - 1] + layout.colW[c1 - 1];
    const Y1 = layout.rowY[r1 - 1] + layout.rowH[r1 - 1];
    const L = M + leftReserve;
    const T = M + topReserve;
    const px = (X: number) => L + (X - X0) * s;
    const py = (Y: number) => T + (Y - Y0) * s;
    const notFull = Math.abs(s - 1) > 1e-9;
    sheetTitle(`${t('pdf.section')} ${sec.id} – ${t('pdf.sheet')} ${sh.key} (${ti}/${nT})`, [
      `X ${f1(X0, 2)}–${f1(X1, 2)} mm`,
      `Y ${f1(Y0, 2)}–${f1(Y1, 2)} mm`,
      `${t('pdf.scale')} ${fmtScale(s, loc)}${notFull ? ` (${t('pdf.notFullSizeShort')})` : ''}`,
      t('pdf.originShort'),
    ]);
    const drawn = drawStones(sh, s, L, T, 'lay');
    drawMargins(sh, s, L, T);

    // Anschluss-/Passmarken auf Fugenmitte (bzw. Außenkante am Projektrand)
    const leftE = c0 === 0 ? 0 : X0 - g / 2;
    const rightE = c1 === layout.cols ? X1 : X1 + g / 2;
    const topE = r0 === 0 ? 0 : Y0 - g / 2;
    const botE = r1 === layout.rows ? Y1 : Y1 + g / 2;
    setDraw('#E0501E');
    doc.setLineWidth(0.2);
    const cross = (X: number, Y: number) => {
      const x = px(X);
      const yv = py(Y);
      doc.line(x - 3, yv, x + 3, yv);
      doc.line(x, yv - 3, x, yv + 3);
      doc.circle(x, yv, 1.2, 'S');
    };
    cross(leftE, topE);
    cross(rightE, topE);
    cross(leftE, botE);
    cross(rightE, botE);
    setText('#E0501E');
    const label = (dx: number, dy: number) => {
      const ntx2 = tx + dx;
      const nty2 = ty + dy;
      if (ntx2 >= 0 && ntx2 < ntx && nty2 >= 0 && nty2 < nty) return `${t('pdf.sheet')} ${sec.id}-${nty2 * ntx + ntx2 + 1}`;
      const ns = neighborSec(sec, dy, dx);
      return ns ? `${t('pdf.section')} ${ns.id}` : '';
    };
    doc.setLineDashPattern([1, 0.8], 0);
    const lr = label(1, 0);
    const ll = label(-1, 0);
    const lt = label(0, -1);
    const lb = label(0, 1);
    let rightInFooter = false;
    font(5);
    if (lr) {
      doc.line(px(rightE), py(topE) - 4, px(rightE), py(botE) + 4);
      // im rechten Rand, senkrecht mittig; zu lang für kurze Blätter → in die Fußzeile (→ …)
      const lbl = `${t('pdf.joinTo')} ${lr}`;
      if (doc.getTextWidth(safe(lbl)) <= py(botE) - py(topE) - 8) rotText(lbl, px(rightE), py((topE + botE) / 2), -90, 1.5);
      else rightInFooter = true;
    }
    if (ll) {
      doc.line(px(leftE), py(topE) - 4, px(leftE), py(botE) + 4);
    }
    if (lt) doc.line(px(leftE) - 4, py(topE), px(rightE) + 4, py(topE));
    if (lb) doc.line(px(leftE) - 4, py(botE), px(rightE) + 4, py(botE));
    doc.setLineDashPattern([], 0);
    font(5.5);
    const sideInfo = [ll && `← ${ll}`, lt && `↑ ${lt}`, rightInFooter && `→ ${lr}`].filter(Boolean).join('   ');
    const sideW = sideInfo ? doc.getTextWidth(safe(sideInfo)) : 0;
    if (sideInfo) text(sideInfo, M, PH - M - 9);
    if (lb) {
      font(5);
      const lbl = `↓ ${t('pdf.joinTo')} ${lb}`;
      const w = doc.getTextWidth(safe(lbl));
      const yb = py(botE) + 3.4;
      let xl = px((leftE + rightE) / 2) - w / 2;
      // nicht über die Seitenangaben links (← / ↑) drucken
      if (sideInfo && Math.abs(yb - (PH - M - 9)) < 2.5 && xl < M + sideW + 3) xl = M + sideW + 3;
      text(lbl, Math.min(xl, PW - M - w), yb);
    }
    setText('#000000');
    // Fußzeile: Passmarken-Hinweis, Verweise (Zuschnitt/Codeplan, Hilfslinien) und (nicht 1:1) Warnung links,
    // Kontrollstrecke rechts, alles über der Seitenzahl (PH − 7). Platz: höchstens 4 Zeilen unter Anschlussangaben,
    // sonst 5. Reicht er nicht: kürzere Kontrollstrecke, kleinere Schrift, dann ohne den ganzen Satz
    // „nicht Originalgröße“ (steht immer in der Kopfzeile), zuletzt nur die Seitenverweise ohne Erklärung.
    {
      const maxLines = sideInfo || lb ? 4 : 5;
      const mark = t('pdf.markHint', { g: f1(g, 2) });
      const refsFull: string[] = [];
      const refsShort: string[] = [];
      const hasCut = scan.entries.length > 0 || scan.onPiece.length > 0;
      if (hasCut) {
        // Legende nur für das, was auf diesem Blatt wirklich steht: „T…“ im Stein nur, wenn es solche Steine gibt,
        // „○“ nur, wenn Ringe gezeichnet wurden (zugeschnittene Steine sind immer orange umrandet, siehe drawStones)
        const legend = !cutPages.length ? t('pdf.w4.legendCutAll') : scan.onPiece.length > 0 ? t('pdf.w4.legendCut', { p: pagesStr(cutPages) }) : t('pdf.w4.legendCutList', { p: pagesStr(cutPages) });
        refsFull.push(drawn.rings > 0 ? `${legend} ${t('pdf.w4.legendRing')}` : legend);
        if (cutPages.length) refsShort.push(t('pdf.w4.refCut', { p: pagesStr(cutPages) }));
      }
      if (codePages.length) {
        // Codeplan unvollständig (winzige ganze Steine bei sehr kleinem Maßstab): ausdrücklich sagen
        const r = t(scan.codeWholeComplete ? 'pdf.w4.refCodePlan' : 'pdf.w4.refCodePlanPartial', { p: pagesStr(codePages) });
        refsFull.push(r);
        refsShort.push(r);
      } else if (scan.unlabelledUncut > 0) {
        const r = t('pdf.w4.codesOffWarn');
        refsFull.push(r);
        refsShort.push(r);
      }
      refsFull.push(t('pdf.w4.legendGuides'));
      const warn = notFull ? t('pdf.notFullSize', { scale: fmtScale(s, loc) }) : '';
      type Opt = { calLen: number; size: number; refs: string; warn: boolean };
      const tries: Opt[] = [];
      for (const refs of [refsFull.join(' '), refsShort.join(' ')])
        for (const w of warn ? [true, false] : [false])
          for (const [calLen, size] of [
            [50, 6],
            [30, 6],
            [30, 5],
          ] as [number, number][])
            tries.push({ calLen, size, refs, warn: w });
      let chosen: { calLen: number; size: number; a: string[]; r: string[]; b: string[] } | null = null;
      for (const o of tries) {
        const w = AW - o.calLen - 10;
        const a = wrapWords(mark, w, o.size, false, measure);
        const r = o.refs ? wrapWords(o.refs, w, o.size, false, measure) : [];
        const b = o.warn ? wrapWords(warn, w, o.size, false, measure) : [];
        if (a.length + r.length + b.length <= maxLines) {
          chosen = { calLen: o.calLen, size: o.size, a, r, b };
          break;
        }
      }
      if (!chosen) {
        const w = AW - 40;
        chosen = { calLen: 30, size: 5, a: wrapWords(mark, w, 5, false, measure), r: refsShort.length ? wrapWords(refsShort.join(' '), w, 5, false, measure) : [], b: [] };
      }
      const { size, a, r, b, calLen } = chosen;
      const lines = a.length + r.length + b.length;
      const lh = size * 1.13 * PT_MM + 0.05;
      const lhf = lh / (size * PT_MM);
      const start = Math.min(PH - M - 4.5, PH - 7.6 - (lines - 1) * lh);
      font(size);
      doc.text(a.map(safe), M, start, { lineHeightFactor: lhf });
      if (r.length) {
        setText('#8A3B00');
        doc.text(r.map(safe), M, start + a.length * lh, { lineHeightFactor: lhf });
      }
      if (b.length) {
        setText('#7A2E10');
        doc.text(b.map(safe), M, start + (a.length + r.length) * lh, { lineHeightFactor: lhf });
      }
      setText('#000000');
      drawCalibration(PW - M - calLen - 2, PH - M - 6, calLen);
    }
  }

  /** Codeplan-Seite: derselbe Rasterbereich vergrößert, Steine hell getönt mit großen Farbnummern – nicht zum Auflegen */
  function drawCodePlan(ss: SectionSheets, sh: SheetRange, part: Range, i: number, n: number, scan: SheetScan, cutPages: number[]) {
    const sec = ss.section;
    const s = sheetScale * scan.codeK;
    const scale = fmtScale(s, loc);
    newPage(`${t('pdf.section')} ${sec.id} · ${t('pdf.w4.codePlanShort', { id: sh.key, i: i + 1, n })}`);
    footLabel.set(pg(), t('pdf.w4.codePlanShort', { id: sh.key, i: i + 1, n }));
    const X0 = layout.colX[part.c0];
    const Y0 = layout.rowY[part.r0];
    const X1 = layout.colX[part.c1 - 1] + layout.colW[part.c1 - 1];
    const Y1 = layout.rowY[part.r1 - 1] + layout.rowH[part.r1 - 1];
    const L = M + leftReserve;
    const T = M + topReserve;
    sheetTitle(t('pdf.w4.codePlanTitle', { id: sh.key, i: i + 1, n, scale }), [`X ${f1(X0, 2)}–${f1(X1, 2)} mm`, `Y ${f1(Y0, 2)}–${f1(Y1, 2)} mm`, `${t('pdf.rows')} ${rowLabel(part.r0)}–${rowLabel(part.r1 - 1)}`, `${t('pdf.cols')} ${part.c0 + 1}–${part.c1}`], '#8A1C00');
    const { unlabelled, unlabelledUncut } = drawStones(part, s, L, T, 'codes');
    drawMargins(part, s, L, T);
    // deutliche Kennzeichnung: rot gestrichelter Rahmen um den Mosaikbereich und Hinweis in der Fußzeile
    setDraw('#B3261E');
    doc.setLineWidth(0.4);
    doc.setLineDashPattern([2.5, 1.5], 0);
    doc.rect(L - 1.2, T - 1.2, (X1 - X0) * s + 2.4, (Y1 - Y0) * s + 2.4, 'S');
    doc.setLineDashPattern([], 0);
    const lines = [t('pdf.w4.codePlanMarker')];
    // Ohne Nummer: zugeschnittene Steine stehen (mit Farbnummer) in der Zuschnittliste des Blatts – jeder zugeschnittene
    // Stein ohne Nummer ist dort gelistet (pieceMark: listed). Nicht zugeschnittene Steine stehen in KEINER Liste.
    const unlabelledCut = unlabelled - unlabelledUncut;
    if (unlabelledCut > 0)
      lines.push(cutPages.length ? tc('pdf.w4.codePlanSmall', unlabelledCut, { n: num(unlabelledCut), id: sh.key, p: pagesStr(cutPages) }) : tc('pdf.w4.codePlanSmallNoList', unlabelledCut, { n: num(unlabelledCut) }));
    if (unlabelledUncut > 0) lines.push(tc(opts.includeCoords ? 'pdf.w4.codePlanWholeCoords' : 'pdf.w4.codePlanWhole', unlabelledUncut, { n: num(unlabelledUncut) }));
    let yv = Math.min(T + (Y1 - Y0) * s + 6, PH - M - 9);
    setText('#8A1C00');
    for (const [k, l] of lines.entries()) {
      for (const wl of wrapWords(l, AW, k === 0 ? 8 : 6.5, k === 0, measure)) {
        font(k === 0 ? 8 : 6.5, k === 0);
        text(wl, M, yv);
        yv += k === 0 ? 3.6 : 3;
      }
    }
    setText('#000000');
  }

  /**
   * Zuschnittliste einer Blattgruppe: je Blatt eine Kopfzeile und jeder zugeschnittene Stein ohne Vorlagennummer
   * im Stein (Position, Farbe, Form, Vorlage, Außenmaß), sortiert nach Position. Feste Zeilenhöhe; Texte werden
   * verkleinert, nie gekürzt oder umbrochen (Seitenplan = layoutCutList).
   */
  function drawCutList(group: { ss: SectionSheets; sh: SheetRange }[], scans: SheetScan[], cl: CutListLayout) {
    const C = CUT_LIST;
    const colW = Math.min(C.colW, AW);
    const head = [t('pdf.w4.col.no'), t('pdf.position'), t('pdf.w4.col.code'), t('pdf.shape'), t('pdf.w4.col.tpl'), t('pdf.w4.col.size')];
    // Feldgrenzen innerhalb einer Spalte (mm ab linker Spaltenkante)
    const f = colW / C.colW;
    const X = { noR: 6 * f, id: 7.5 * f, sw: 21 * f, code: 25 * f, shape: 31 * f, tpl: 49.5 * f, sizeR: colW };
    const W = { no: 6 * f, id: 13 * f, code: 5 * f, shape: 17.5 * f, tpl: 24 * f, size: 14 * f };
    const withEntries = group.filter((_, i) => scans[i].entries.length > 0).map((g) => g.sh.key);
    const name = withEntries.length > 1 ? `${withEntries[0]} – ${withEntries[withEntries.length - 1]}` : withEntries[0];
    const title0 = withEntries.length > 1 ? t('pdf.w4.cutListTitleMany', { from: withEntries[0], to: withEntries[withEntries.length - 1] }) : t('pdf.w4.cutListTitle', { id: name });
    const nEntries = scans.reduce((a, sc) => a + sc.entries.length, 0);
    const nOnPiece = scans.reduce((a, sc) => a + sc.onPiece.length, 0);
    // Hinweis aus dem Stand: „weitere tragen T… im Stein“ nur, wenn es solche gibt; Kapitel Schnittvorlagen nur, wenn die
    // Vorlagen der Liste wirklich im PDF stehen (sonst: nicht enthalten bzw. nur bis zum Limit)
    const withT = scans.flatMap((sc) => sc.entries.filter((e) => e.tNo !== null));
    const tail = !withT.length
      ? ''
      : withT.every((e) => e.inPdf)
        ? t('pdf.w4.cutListHintTpl')
        : !opts.includeTemplates
          ? t('pdf.w4.cutListHintNoTpl')
          : t('pdf.w4.cutListHintLimit', { limit: num(opts.templateLimit) });
    const hint = [tc('pdf.w4.cutListHint', nEntries, { n: num(nEntries) }), nOnPiece > 0 ? tc('pdf.w4.cutListHintOnPiece', nOnPiece, { onPiece: num(nOnPiece) }) : '', tail].filter(Boolean).join(' ');
    const at = (slot: number) => {
      const inPage = slot % cl.perPage;
      return { page: Math.floor(slot / cl.perPage), x0: M + Math.floor(inPage / cl.rowsPerCol) * (colW + C.gap), y: M + C.firstRowY + (inPage % cl.rowsPerCol) * C.rowH, row: inPage % cl.rowsPerCol };
    };
    const first = pg() + 1;
    for (let pi = 0; pi < cl.pages; pi++) {
      const title = title0 + (cl.pages > 1 ? ` (${pi + 1}/${cl.pages})` : '');
      newPage(title);
      footLabel.set(pg(), t('pdf.w4.cutListShort', { id: name }));
      fitText(title, M, M + C.titleY, AW, 11, { bold: true, min: 7 });
      setText('#555555');
      // Hinweis: höchstens zwei Zeilen (Kopfbereich fest), sonst kleiner
      let size = 6.5;
      let ls = wrapWords(hint, AW, size, false, measure);
      while (ls.length > 2 && size > 4.5) {
        size -= 0.5;
        ls = wrapWords(hint, AW, size, false, measure);
      }
      font(size);
      doc.text(ls.slice(0, 2).map(safe), M, M + C.hintY - (ls.length > 1 ? 1.3 : 0), { lineHeightFactor: 1.15 });
      setText('#000000');
      const used = Math.min(cl.perPage, Math.max(0, (cl.blocks.reduce((a, b) => Math.max(a, b?.end ?? 0), 0)) - pi * cl.perPage));
      const colsHere = Math.max(1, Math.ceil(used / cl.rowsPerCol));
      for (let ci = 0; ci < Math.min(cl.cols, colsHere); ci++) {
        const x0 = M + ci * (colW + C.gap);
        setFill('#EEEAE3');
        doc.rect(x0, M + C.headY - 3, colW, 4.2, 'F');
        const hy = M + C.headY;
        fitText(head[0], x0 + X.noR, hy, W.no, 6, { bold: true, align: 'right', min: 4 });
        fitText(head[1], x0 + X.id, hy, W.id, 6, { bold: true, min: 4 });
        fitText(head[2], x0 + X.sw, hy, W.code + 4, 6, { bold: true, min: 4 });
        fitText(head[3], x0 + X.shape, hy, W.shape, 6, { bold: true, min: 4 });
        fitText(head[4], x0 + X.tpl, hy, W.tpl, 6, { bold: true, min: 4 });
        fitText(head[5], x0 + X.sizeR, hy, W.size, 6, { bold: true, align: 'right', min: 4 });
      }
    }
    group.forEach(({ sh }, gi) => {
      const b = cl.blocks[gi];
      if (!b) return;
      const sc = scans[gi];
      const hp = at(b.head);
      doc.setPage(first + hp.page);
      setFill('#E3DED4');
      doc.rect(hp.x0, hp.y - 2.9, colW, C.rowH, 'F');
      setText('#000000');
      fitText(tc('pdf.w4.cutListSheet', sc.entries.length, { id: sh.key, n: num(sc.entries.length) }), hp.x0 + 1, hp.y, colW - 2, C.fontSize, { bold: true });
      sc.entries.forEach((e, k) => {
        const a = at(b.first + k);
        doc.setPage(first + a.page);
        const x0 = a.x0;
        const yv = a.y;
        if (k % 2 === 1) {
          setFill('#F5F3EF');
          doc.rect(x0, yv - 2.9, colW, C.rowH, 'F');
        }
        setText('#000000');
        fitText(String(e.no), x0 + X.noR, yv, W.no, C.fontSize, { align: 'right' });
        fitText(e.id, x0 + X.id, yv, W.id, C.fontSize, { bold: true });
        setFill(palette[e.color]?.hex ?? '#FF00FF');
        setDraw('#666666');
        doc.setLineWidth(0.1);
        doc.rect(x0 + X.sw, yv - 2.4, 3, 2.8, 'FD');
        fitText(code2(e.color), x0 + X.code, yv, W.code, C.fontSize);
        fitText(shapeName(e.shape), x0 + X.shape, yv, W.shape, C.fontSize);
        if (e.tNo === null) fitText('–', x0 + X.tpl, yv, W.tpl, C.fontSize);
        else if (e.inPdf) fitText(`T${e.tNo}`, x0 + X.tpl, yv, W.tpl, C.fontSize, { bold: true });
        else {
          setText('#7A2E10');
          fitText(t('pdf.w4.tNotInPdf', { no: e.tNo }), x0 + X.tpl, yv, W.tpl, C.fontSize);
          setText('#000000');
        }
        fitText(`${f1(e.w)} × ${f1(e.h)}`, x0 + X.sizeR, yv, W.size, C.fontSize, { align: 'right' });
      });
    });
    doc.setPage(first + cl.pages - 1);
  }

  function drawCalibration(x: number, yv: number, len = 100) {
    if (x + len > PW - M + 0.01) len = Math.floor((PW - M - x) / 10) * 10;
    if (len <= 0) return;
    setDraw('#000000');
    doc.setLineWidth(0.2);
    doc.line(x, yv, x + len, yv);
    for (let i = 0; i <= len; i += 10) doc.line(x + i, yv - (i % 50 === 0 ? 2 : 1), x + i, yv);
    font(5);
    setText('#000000');
    text(t('pdf.calibration', { n: len }), x + len / 2, yv + 2.5, { align: 'center' });
  }

  // ================= 5. Abschnitte: Deckblatt (mehrere Blätter) bzw. Abschnittsübersicht (ein Blatt) + Blätter;
  // nach jeder Blattgruppe (Abschnitt bzw. Übersichtsseite) die gemeinsame Zuschnittliste
  for (const item of sectionItems(plan)) {
    if (item.kind === 'cover') {
      const ss = item.s;
      const p0 = pg();
      drawSectionCover(ss);
      facts.coverPages[ss.section.id] = pg() - p0;
      bd.sectionCovers += pg() - p0;
      emitGroup(ss.sheets.map((sh) => ({ ss, sh })));
      sectionLast.set(ss.section.id, pg());
      sectionDone();
    } else {
      const blocks = item.run.map((ss) => summaryBlock(ss));
      const pages = packSummaries(
        blocks.map((b) => b.height),
        PH,
      );
      for (const p of pages) {
        if (!dry) drawSummaryPage(p, item.run, blocks);
        bd.sectionSummaries++;
        emitGroup(p.blocks.map((i) => ({ ss: item.run[i], sh: item.run[i].sheets[0] })));
        for (const i of p.blocks) {
          sectionLast.set(item.run[i].section.id, pg());
          sectionDone();
        }
      }
    }
  }
  if (dry) return { doc, facts, breakdown: bd, plan };

  // ================= 8. Schnittvorlagen
  const p8 = pg();
  if (opts.includeTemplates && tpl.groups.length) {
    onProgress?.(0.78, 'templates');
    const shown = tpl.groups.slice(0, Math.max(0, opts.templateLimit));
    const lay = layoutTemplateBoxes(shown.length, tpl.groups.length > shown.length, PW, PH);
    newPage(t('pdf.templates'));
    chapterPage.set('templates', pg());
    const first = pg();
    font(12, true);
    text(t('pdf.templates'), M, M + 7);
    // Hinweis höchstens 3 Zeilen (Kästen beginnen fest bei M + 22,5)
    {
      let size = 7;
      let ls = wrapWords(t('pdf.templatesHint'), AW, size, false, measure);
      while (ls.length > 3 && size > 4.5) {
        size -= 0.5;
        ls = wrapWords(t('pdf.templatesHint'), AW, size, false, measure);
      }
      font(size);
      doc.text(ls.slice(0, 3).map(safe), M, M + 12, { lineHeightFactor: 1.15 });
    }
    shown.forEach((gr, i) => {
      const b = lay.boxes[i];
      while (pg() < first + b.page) newPage(t('pdf.templates'));
      drawTemplate(gr, b.x, b.y, TEMPLATE_BOX.w - 3, TEMPLATE_BOX.h - 3);
    });
    if (lay.notice) {
      while (pg() < first + lay.notice.page) newPage(t('pdf.templates'));
      setText('#7A2E10');
      para(t('pdf.templatesTruncated', { n: tpl.groups.length - shown.length }), M, lay.notice.y, AW, 8);
      setText('#000000');
    }
  }
  bd.templates = pg() - p8;

  /** Vorkommen einer Vorlage je Blatt („A1-1: 14×, A1-2: 3×“) in Blattreihenfolge; nicht exportierte Abschnitte zusammengefasst. */
  function occurrenceItems(gr: TemplateGroup): { items: string[]; other: number } {
    const keys = [...gr.sheets.keys()].filter((k) => selectedSheets.has(k)).sort((a, b) => (sheetOrder.get(a) ?? 0) - (sheetOrder.get(b) ?? 0));
    let other = 0;
    for (const [k, v] of gr.sheets) if (!selectedSheets.has(k)) other += v;
    return { items: keys.map((k) => `${k}: ${gr.sheets.get(k)}×`), other };
  }

  function drawTemplate(gr: TemplateGroup, x: number, yv: number, w: number, h: number) {
    const ci = gr.info;
    setDraw('#999999');
    doc.setLineWidth(0.15);
    doc.rect(x, yv, w, h, 'S');
    font(8, true);
    text(`${t('pdf.template')} T${gr.no}`, x + 1.5, yv + 4);
    font(6.5);
    text(`${shapeName(ci.shape)} · ${gr.count}×`, x + w - 1.5, yv + 4, { align: 'right' });

    // ---- Texte: Warnungen stehen vor den Schnitten und werden nie weggelassen; Schnitte und
    // Einschnitte getrennt nummeriert wie im Steindetail (cutLineItems).
    const items = cutLineItems(ci);
    const cutTexts = items.map((it) => {
      const pts = { x1: f1(it.a.x), y1: f1(it.a.y), x2: f1(it.b.x), y2: f1(it.b.y) };
      return it.kind === 'through'
        ? `${t('pdf.cutLine')} ${it.no}: (${pts.x1}; ${pts.y1}) → (${pts.x2}; ${pts.y2})`
        : t(it.kind === 'notch' ? 'pdf.notchLine' : 'pdf.notchEdgeLine', { i: it.no, ...pts });
    });
    const warnTexts: string[] = [];
    if (!ci.convex) warnTexts.push(t('pdf.nonConvex'));
    if (!ci.fits) warnTexts.push(t('pdf.notFitting'));
    const headTexts = (zoom: number) => [
      `${t('pdf.raw')}: ${f1(ci.rawW)} × ${f1(ci.rawH)} mm · ${t('pdf.scale')} ${zoom}:1`,
      `${t('pdf.outer')}: ${f1(ci.w)} × ${f1(ci.h)} mm · ${t('pdf.area')}: ${f1(ci.area, 1)} mm²`,
      `${t('pdf.angles')}: ${ci.angles.map((a) => `${f1(a, 1)}°`).join(', ')}`,
    ];
    const colorsText = `${t('pdf.colorsUsed')}: ${[...gr.colors].map((c) => String(palette[c]?.code ?? '?').padStart(2, '0')).join(', ')}`;
    const occ = occurrenceItems(gr);
    const wrap = (l: string) => doc.splitTextToSize(safe(l), w - 3) as string[];
    /** Vorkommen je Blatt in höchstens `max` Zeilen; was nicht passt, ehrlich als „+ n weitere Blätter“ */
    const occLines = (max: number): string[] => {
      if (max <= 0) return [];
      const tail = (shownN: number) => {
        const more = occ.items.length - shownN;
        return [more > 0 ? t('pdf.w4.tplMore', { n: more }) : '', occ.other > 0 ? t('pdf.w4.tplOther', { n: occ.other }) : ''].filter(Boolean).join(' ');
      };
      // höchstens 4 Zeilen à ~60 Zeichen: mehr als 40 Einträge passen nie
      for (let k = Math.min(occ.items.length, 40); k >= 0; k--) {
        const body = `${t('pdf.w4.tplSheets')}: ${occ.items.slice(0, k).join(', ')}${k === 0 && occ.items.length ? '…' : ''}`;
        const str = [k > 0 || occ.items.length ? body : '', tail(k)].filter(Boolean).join(' ');
        const ls = wrap(str);
        if (ls.length <= max) return ls;
      }
      return wrap(tail(0)).slice(0, max);
    };
    // Maßstab und Schriftgröße so wählen, dass alles Platz hat: zuerst kleinere Zeichnung, dann kleinere
    // Schrift, erst zuletzt ohne Farben/Blätter (die stehen auch in Zuschnittlisten und Koordinatenliste).
    const maxZoom = Math.max(1, Math.floor(32 / Math.max(ci.rawW, ci.rawH)));
    const textTop = (zoom: number) => yv + 9 + ci.rawH * zoom + 3.5;
    const bottom = yv + h - 1;
    let layoutChoice: { zoom: number; size: number; lines: string[] } | null = null;
    for (const withTail of [true, false]) {
      for (const size of [5.5, 5, 4.5]) {
        font(size);
        const lh = size * 0.51;
        for (let zoom = maxZoom; zoom >= 1 && !layoutChoice; zoom--) {
          const base = [...headTexts(zoom), ...warnTexts, ...cutTexts].flatMap(wrap);
          const avail = Math.floor((bottom - textTop(zoom)) / lh + 1e-9) + 1;
          if (base.length > avail) continue;
          if (!withTail) {
            layoutChoice = { zoom, size, lines: base };
            break;
          }
          const col = wrap(colorsText);
          const rest = avail - base.length - col.length;
          if (rest < 1) continue;
          layoutChoice = { zoom, size, lines: [...base, ...col, ...occLines(Math.min(rest, 4))] };
        }
        if (layoutChoice) break;
      }
      if (layoutChoice) break;
    }
    if (!layoutChoice) {
      font(4.5);
      layoutChoice = { zoom: 1, size: 4.5, lines: [...headTexts(1), ...warnTexts, ...cutTexts].flatMap(wrap) };
    }
    const { zoom, size } = layoutChoice;

    const ox = x + (w - ci.rawW * zoom) / 2;
    const oy = yv + 9;
    doc.setLineDashPattern([0.8, 0.6], 0);
    setDraw('#555555');
    doc.rect(ox, oy, ci.rawW * zoom, ci.rawH * zoom, 'S');
    doc.setLineDashPattern([], 0);
    setFill(palette[gr.color]?.hex ?? '#DDDDDD');
    setDraw('#000000');
    doc.setLineWidth(0.25);
    poly(ci.polyInRaw, ox, oy, zoom, 'FD');
    // Durchgehende Schnitte: rot, durchgezogen
    setDraw('#D0021B');
    doc.setLineWidth(0.3);
    for (const it of items) if (it.kind === 'through') doc.line(ox + it.a.x * zoom, oy + it.a.y * zoom, ox + it.b.x * zoom, oy + it.b.y * zoom);
    // Einschnitte bis zur Innenecke: orange gepunktet, Kreis an der Innenecke (wie in der App)
    if (items.some((it) => it.kind !== 'through')) {
      setDraw('#EF6C00');
      doc.setLineWidth(0.45);
      doc.setLineCap('round');
      doc.setLineDashPattern([0.05, 0.85], 0);
      for (const it of items) if (it.kind !== 'through') doc.line(ox + it.a.x * zoom, oy + it.a.y * zoom, ox + it.b.x * zoom, oy + it.b.y * zoom);
      doc.setLineDashPattern([], 0);
      doc.setLineCap('butt');
      doc.setLineWidth(0.25);
      setFill('#FFFFFF');
      for (const it of items) if (it.kind === 'notch') doc.circle(ox + it.b.x * zoom, oy + it.b.y * zoom, 0.7, 'FD');
    }
    // Kantenlängen
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5);
    setText('#000000');
    const n = ci.polyInRaw.length;
    const ctr = centroid(ci.polyInRaw);
    for (let i = 0; i < n; i++) {
      const a = ci.polyInRaw[i];
      const b = ci.polyInRaw[(i + 1) % n];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = mx - ctr.x;
      const dy = my - ctr.y;
      const dl = Math.hypot(dx, dy) || 1;
      doc.text(f1(ci.edges[i]), ox + (mx + (dx / dl) * 0.9) * zoom, oy + (my + (dy / dl) * 0.9) * zoom, { align: 'center', baseline: 'middle' });
    }
    font(size);
    const lh = size * 0.51;
    let ty = textTop(zoom);
    const warnFirst = new Set(warnTexts.flatMap(wrap));
    for (const l of layoutChoice.lines) {
      if (ty > bottom) {
        // nur im Notfall (sehr viele Kanten): ehrlich auf das Steindetail verweisen
        text(t('pdf.templateMore'), x + 1.5, bottom);
        break;
      }
      if (warnFirst.has(l)) setText('#B3261E');
      doc.text(l, x + 1.5, ty);
      setText('#000000');
      ty += lh;
    }
    // 1:1-Kontur, wenn Platz
    if (zoom > 1) {
      setDraw('#000000');
      doc.setLineWidth(0.15);
      setFill('#FFFFFF');
      const sb = bbox(ci.polyInRaw);
      poly(ci.polyInRaw, x + w - 2 - sb.maxX, oy, 1, 'S');
      doc.setFontSize(4);
      doc.text('1:1', x + w - 2 - sb.maxX / 2, oy + sb.maxY + 2, { align: 'center' });
    }
  }

  // ================= 9./10. Koordinaten
  const p9 = pg();
  if (opts.includeCoords) {
    onProgress?.(0.85, 'coords');
    let written = 0;
    let truncated = false;
    let firstOmitted: string | null = null;
    let totalSelected = 0;
    const skipped: string[] = [];
    let lastY: number | null = null;
    for (const ss of plan.sections) {
      if (!ss.selected) continue;
      const sec = ss.section;
      // dieselbe Zählung wie die Liste (cellPieces ohne Teile ohne Fläche) = Steine des Abschnitts
      const secTotal = secStatsOf(sec).pieces;
      totalSelected += secTotal;
      if (written >= opts.coordLimit && secTotal > 0) {
        // Limit schon erreicht: Abschnitt bekommt keine Liste – das wird unten ausdrücklich genannt
        truncated = true;
        skipped.push(sec.id);
        if (firstOmitted === null) firstOmitted = firstStoneId(sec);
        continue;
      }
      const rows: TableCell[][] = [];
      let secTruncated = false;
      outer: for (let row = sec.r0; row < sec.r1; row++) {
        for (let col = sec.c0; col < sec.c1; col++) {
          const ps = cellPieces(layout, data, row, col);
          for (let i = 0; i < ps.length; i++) {
            const p = ps[i];
            const ci = pieceCutInfo(cache, layout, data, row, col, i, p.poly, raw(p.color));
            if (ci.invalid) continue; // kein Stein (keine Fläche)
            if (written >= opts.coordLimit) {
              // genau hier wird ein Stein ausgelassen
              truncated = true;
              secTruncated = true;
              if (firstOmitted === null) firstOmitted = pieceId(layout, row, col, i, ps.length);
              break outer;
            }
            const b = bbox(p.poly);
            const tg = ci.needsCut ? tpl.bySig.get(ci.signature) : undefined;
            // Vorlagennummer nur „nackt“, wenn die Vorlage in diesem PDF gedruckt ist
            const cutCell = !ci.needsCut ? t('pdf.no') : !tg ? t('pdf.yes') : tplPrinted(tg.no) ? `${t('pdf.yes')} (T${tg.no})` : t('pdf.w4.coordCutMissing', { yes: t('pdf.yes'), no: tg.no });
            rows.push([pieceId(layout, row, col, i, ps.length), f1(b.minX, 2), f1(b.minY, 2), code2(p.color), shapeName(ci.shape), `${f1(ci.w, 2)} × ${f1(ci.h, 2)}`, cutCell]);
            written++;
          }
        }
      }
      newPage(`${t('pdf.coords')} ${sec.id}`);
      if (!chapterPage.has('coords')) chapterPage.set('coords', pg());
      coordPage.set(sec.id, pg());
      const title = secTruncated
        ? t('pdf.coordsTitlePartial', { id: sec.id, n: num(rows.length), total: num(secTotal) })
        : tc('pdf.coordsTitleFull', secTotal, { id: sec.id, total: num(secTotal) });
      lastY = table(
        title,
        [{}, { align: 'right' }, { align: 'right' }, {}, { kind: 'text', max: 45 }, { kind: 'tokens' }, { kind: 'tokens', foldInto: 4, foldOrder: 1 }],
        [t('pdf.position'), 'X (mm)', 'Y (mm)', t('pdf.code'), t('pdf.shape'), t('pdf.sizeMm'), t('pdf.cutQ')],
        rows,
        M + 8,
        `${t('pdf.coords')} ${sec.id}`,
        { rowH: 4.2 },
      ).y;
    }
    if (truncated) {
      // Hinweis direkt unter der letzten Tabelle (neue Seite nur, wenn dort weniger als 4 Zeilen Platz sind)
      const notice = [
        t('pdf.coordsNotice', { limit: num(opts.coordLimit), n: num(written), total: num(totalSelected), first: firstOmitted ?? '–' }),
        ...(skipped.length ? [t('pdf.coordsSkipped', { ids: skipped.join(', ') })] : []),
      ].join(' ');
      let ny = lastY !== null ? lastY + 2 : null;
      if (ny === null || ny + COORD_NOTICE_RESERVE > TABLE_BOTTOM) {
        newPage(t('pdf.coords'));
        if (!chapterPage.has('coords')) chapterPage.set('coords', pg());
        ny = M + 10;
      }
      setText('#7A2E10');
      para(notice, M, ny, AW, 9, { lh: 4 });
      setText('#000000');
    }
  }
  bd.coords = pg() - p9;

  function firstStoneId(sec: Section): string | null {
    for (let row = sec.r0; row < sec.r1; row++)
      for (let col = sec.c0; col < sec.c1; col++) {
        const ps = cellPieces(layout, data, row, col);
        for (let i = 0; i < ps.length; i++) {
          if (pieceCutInfo(cache, layout, data, row, col, i, ps[i].poly, raw(ps[i].color)).invalid) continue;
          return pieceId(layout, row, col, i, ps.length);
        }
      }
    return null;
  }

  // ================= 11. Seitenverweise, Seitenzahlen, Lesezeichen
  onProgress?.(0.95, 'pages');
  for (const f of postFills) f();
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    font(7);
    setText('#555555');
    // Grundlinie 7 mm über dem Rand: auch die Unterlänge bleibt ≥ 6 mm vom Rand, außerhalb des nicht
    // bedruckbaren Randes üblicher Drucker (4–5 mm)
    const sl = footLabel.get(i);
    text(`${sl ? `${sl} · ` : ''}${t('pdf.page')} ${i} / ${total}`, PW - M, PH - 7, { align: 'right' });
  }
  setText('#000000');
  // Lesezeichen in Dokumentreihenfolge: Kapitel → Abschnitte → Blätter → Codeplan/Zuschnittliste
  const outline = doc.outline;
  const chap = (k: Chapter, title: string) => {
    const p = chapterPage.get(k);
    return p ? outline.add(null, title, { pageNumber: p }) : null;
  };
  chap('cover', t('pdf.cover'));
  chap('original', t('pdf.original'));
  chap('preview', t('pdf.preview'));
  chap('overview', t('pdf.overview'));
  chap('legend', t('pdf.legend'));
  chap('materials', t('pdf.materials'));
  const sheetsNode = chap('sheets', t('pdf.sheets'));
  if (sheetsNode)
    for (const ss of plan.sections) {
      if (!ss.selected) continue;
      const sec = ss.section;
      const p = secPage.get(sec.id);
      if (!p) continue;
      const sn = outline.add(sheetsNode, `${t('pdf.section')} ${sec.id}`, { pageNumber: p });
      (sheetPages.get(sec.id) ?? []).forEach((sp, i) => {
        const key = `${sec.id}-${i + 1}`;
        const node = outline.add(sn, `${t('pdf.sheet')} ${key}`, { pageNumber: sp });
        const ex = sheetExtras.get(key);
        if (ex?.codePages.length) outline.add(node, t('pdf.w4.codePlanShort', { id: key, i: 1, n: ex.codePages.length }), { pageNumber: ex.codePages[0] });
        if (ex?.cutPages.length) outline.add(node, t('pdf.w4.cutListShort', { id: key }), { pageNumber: ex.cutPages[0] });
      });
    }
  chap('templates', t('pdf.templates'));
  const coordsNode = chap('coords', t('pdf.coords'));
  if (coordsNode)
    for (const ss of plan.sections) {
      if (!ss.selected) continue;
      const p = coordPage.get(ss.section.id);
      if (p) outline.add(coordsNode, `${t('pdf.section')} ${ss.section.id}`, { pageNumber: p });
    }
  onProgress?.(1, 'done');
  return { doc, facts, breakdown: bd, plan };
}

/** Breite von „00“ in Helvetica je pt (mm) – Ziffern sind 0,556 em breit. */
function measureHelvetica00(): number {
  return 2 * 0.556 * PT_MM;
}
