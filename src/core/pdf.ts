/**
 * PDF-Verlegeplan (jsPDF, Einheit mm). Verlegeblätter werden maßstäblich
 * (Standard 1:1) gezeichnet; beim Druck „Tatsächliche Größe / 100 %“ wählen.
 *
 * Tabellen werden mit pdfTable.ts gesetzt (gemessene Spalten, Umbruch statt Überlappung, nie gekürzt).
 * Das PDF trägt Lesezeichen (Kapitel → Abschnitte → Blätter), einen Dokumenttitel, PrintScaling=None
 * (nur ein Hinweis an den Betrachter – der gedruckte Hinweis und die Kontrollstrecke bleiben) und
 * Seitenverweise mit Links in der Gesamtübersicht und den Abschnitts-Miniaturen.
 */
import { jsPDF } from 'jspdf';
import { hexToRgb, textColorFor } from './color';
import { paletteDisplayName } from './colorNames';
import { bbox, centroid, fmtMm, type Pt } from './geometry';
import { invalidFreeCells } from './edits';
import { maxColorIndex } from './integrity';
import { cellId, rowLabel, type Layout, type Section, type SectionGrid } from './layout';
import { fitSheetScale, fmtScale, pageSize, sheetPrintArea, SHEET_LEFT_RESERVE, SHEET_TOP_RESERVE, type PdfOptions } from './pdfOptions';
import { drawTable, headerAdvance, layoutRow, layoutTable, LINE_FACTOR, PAD_R, PT_MM, wrapWords, type ColSpec, type Measure, type TableCanvas, type TableCell, type TableLayout } from './pdfTable';
import { cellPieces, cutLineItems, type CutInfo } from './pieces';
import { CutCache, computeStats, jointAreaValid, makeRawSizeFn, pieceCutInfo, type Range, type RawSizeFn } from './stats';
import { CellKind, type Material, type MosaicData, type PaletteColor, type ProjectSettings } from './types';

export { DEFAULT_PDF_OPTIONS, PAPER, type PaperFormat, type PdfOptions } from './pdfOptions';

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
}

/** Sammelt alle zuzuschneidenden Steine, gruppiert nach identischer Schnittgeometrie. */
export function collectTemplates(layout: Layout, data: MosaicData, palette: PaletteColor[], materials: Material[], cache = new CutCache()): {
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
          g = { no: 0, info: ci, count: 0, color: p.color, ids: [], colors: new Set() };
          bySig.set(ci.signature, g);
        }
        g.count++;
        g.colors.add(p.color);
        if (g.ids.length < 12) g.ids.push(cellId(layout, row, col) + (ps.length > 1 ? `-${i + 1}` : ''));
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

export async function generatePdf(input: PdfInput, opts: PdfOptions, onProgress?: (f: number, label: string) => void): Promise<ArrayBuffer> {
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
  const safe = (s: string) => (FONT === 'helvetica' ? s.replace(/[ğĞşŞıİ]/g, (c) => ({ ğ: 'g', Ğ: 'G', ş: 's', Ş: 'S', ı: 'i', İ: 'I' })[c] ?? c) : s);
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
  /** Seite → Blatt-ID (Fußzeile „Blatt A1-1 · Seite 9 / 74“) */
  const sheetLabel = new Map<number, string>();
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
    doc.addImage(img.dataUrl, 'JPEG', ix, iy, iw, ih);
    return { x: ix, y: iy, w: iw, h: ih };
  };

  // ---------- Maßstab der Verlegeblätter: fest oder EIN Normmaßstab für alle Abschnitte des Projekts
  const { printW, printH } = sheetPrintArea(PW, PH);
  const sheetScale = opts.sheetScale > 0 ? opts.sheetScale : fitSheetScale(input.sections.sections, printW, printH);
  const scaleStr = fmtScale(sheetScale, loc);
  const raw = makeRawSizeFn(layout, palette, materials);
  const selected = input.sections.sections.filter((s) => !opts.sectionIds || opts.sectionIds.includes(s.id));
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
    if (input.preview) doc.addImage(input.preview.dataUrl, 'JPEG', x0, y0, layout.finishedW * s, layout.finishedH * s);
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

  // ================= Schnittvorlagen sammeln (für Verweise in Koordinaten)
  onProgress?.(0.18, 'templates');
  const tpl = collectTemplates(layout, data, palette, materials, cache);

  // ================= 5. Verlegeblätter je Abschnitt
  const g = layout.joint;
  const topReserve = SHEET_TOP_RESERVE; // Kopf + Spaltennummern + Lineal
  const leftReserve = SHEET_LEFT_RESERVE;

  const tilesOf = (sec: Section, s: number) => {
    const split = (pos: Float64Array, size: Float64Array, a: number, b: number, maxLen: number) => {
      const starts = [a];
      let st = a;
      for (let i = a + 1; i < b; i++) {
        if ((pos[i] + size[i] - pos[st]) * s > maxLen + 1e-6) {
          starts.push(i);
          st = i;
        }
      }
      return starts.map((v, i) => [v, i + 1 < starts.length ? starts[i + 1] : b] as [number, number]);
    };
    return { cx: split(layout.colX, layout.colW, sec.c0, sec.c1, printW), ry: split(layout.rowY, layout.rowH, sec.r0, sec.r1, printH) };
  };

  const neighborSec = (sec: Section, dr: number, dc: number) => {
    const sr = sec.sr + dr;
    const sc = sec.sc + dc;
    if (sr < 0 || sc < 0 || sr >= input.sections.srows || sc >= input.sections.scols) return null;
    return input.sections.sections[sr * input.sections.scols + sc];
  };

  let secDone = 0;
  const sectionStones = new Map<string, number>();
  for (const sec of selected) {
    const s = sheetScale;
    const { cx, ry } = tilesOf(sec, s);
    const nT = cx.length * ry.length;
    // --- Abschnitts-Deckblatt mit Legende und Stückzahlen
    const secStats = computeStats(layout, data, palette, materials, statOpts, { r0: sec.r0, r1: sec.r1, c0: sec.c0, c1: sec.c1 }, cache);
    sectionStones.set(sec.id, secStats.pieces);
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
        font(9);
        text(`${coverPg}–${pages.length ? pages[pages.length - 1] : coverPg}`, pagesAt.x, pagesAt.y);
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

    // --- Blätter
    let ti = 0;
    for (let tj = 0; tj < ry.length; tj++) {
      for (let tii = 0; tii < cx.length; tii++) {
        ti++;
        const [c0, c1] = cx[tii];
        const [r0, r1] = ry[tj];
        drawSheet(sec, ti, nT, c0, c1, r0, r1, s, tii, tj, cx.length, ry.length);
      }
    }
    secDone++;
    onProgress?.(0.2 + (0.55 * secDone) / Math.max(1, selected.length), `section ${sec.id}`);
  }

  function drawSheet(sec: Section, ti: number, nT: number, c0: number, c1: number, r0: number, r1: number, s: number, tx: number, ty: number, ntx: number, nty: number) {
    newPage(`${t('pdf.section')} ${sec.id} · ${t('pdf.sheet')} ${ti}/${nT}`);
    sheetPages.get(sec.id)?.push(pg());
    sheetLabel.set(pg(), `${sec.id}-${ti}`);
    const X0 = layout.colX[c0];
    const Y0 = layout.rowY[r0];
    const X1 = layout.colX[c1 - 1] + layout.colW[c1 - 1];
    const Y1 = layout.rowY[r1 - 1] + layout.rowH[r1 - 1];
    const L = M + leftReserve;
    const T = M + topReserve;
    const px = (X: number) => L + (X - X0) * s;
    const py = (Y: number) => T + (Y - Y0) * s;
    const notFull = Math.abs(s - 1) > 1e-9;
    {
      const title = `${t('pdf.section')} ${sec.id} – ${t('pdf.sheet')} ${sec.id}-${ti} (${ti}/${nT})`;
      const parts = [
        `X ${f1(X0, 2)}–${f1(X1, 2)} mm`,
        `Y ${f1(Y0, 2)}–${f1(Y1, 2)} mm`,
        `${t('pdf.scale')} ${fmtScale(s, loc)}${notFull ? ` (${t('pdf.notFullSizeShort')})` : ''}`,
        t('pdf.originShort'),
      ];
      const info = parts.join(' · ');
      font(10, true);
      text(title, M, M + 3.5);
      const tw = measure(title, true) * 10;
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
    // Fugenfläche
    setFill(settings.groutHex);
    doc.rect(px(X0), py(Y0), (X1 - X0) * s, (Y1 - Y0) * s, 'F');
    doc.setLineWidth(Math.min(0.15, 0.05 * s));
    setDraw('#3A3A3A');
    const minCell = Math.min(layout.tileW, layout.tileH) * s;
    const showCodes = minCell >= 2.2;
    const codeSize = Math.max(3.5, Math.min(9, (minCell * 0.42) / 0.3528));
    for (let row = r0; row < r1; row++) {
      for (let col = c0; col < c1; col++) {
        const idx = row * layout.cols + col;
        const kind = data.kind[idx];
        if (kind === CellKind.FULL) {
          const pc = palette[data.c1[idx]];
          setFill(pc?.hex ?? '#FF00FF');
          const x = px(layout.colX[col]);
          const yv = py(layout.rowY[row]);
          const w = layout.colW[col] * s;
          const h = layout.rowH[row] * s;
          doc.rect(x, yv, w, h, minCell >= 1.5 ? 'FD' : 'F');
          if (showCodes && pc) {
            setText(textColorFor(pc.hex));
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(codeSize);
            doc.text(String(pc.code).padStart(2, '0'), x + w / 2, yv + h / 2, { align: 'center', baseline: 'middle' });
          }
        } else {
          const ps = cellPieces(layout, data, row, col);
          for (const p of ps) {
            const pc = palette[p.color];
            setFill(pc?.hex ?? '#FF00FF');
            poly(p.poly, L - X0 * s, T - Y0 * s, s, minCell >= 1.5 ? 'FD' : 'F');
            const b = bbox(p.poly);
            if (showCodes && pc && Math.min(b.w, b.h) * s >= 1.8) {
              const c = centroid(p.poly);
              setText(textColorFor(pc.hex));
              doc.setFont('helvetica', 'normal');
              doc.setFontSize(Math.max(3, codeSize * 0.75));
              doc.text(String(pc.code).padStart(2, '0'), px(c.x), py(c.y), { align: 'center', baseline: 'middle' });
            }
          }
        }
      }
    }
    setText('#000000');
    // Zeilen-/Spaltenbeschriftung
    const labelStep = (pitchPaper: number) => (pitchPaper >= 3 ? 1 : pitchPaper >= 1.2 ? 5 : pitchPaper >= 0.5 ? 10 : 50);
    const cs = labelStep((layout.tileW + g) * s);
    const rs = labelStep((layout.tileH + g) * s);
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
    // Fußzeile: Passmarken-Hinweis und (nicht 1:1) Warnung links, Kontrollstrecke rechts, beides über der
    // Seitenzahl (PH − 6,5). Platz: höchstens 4 Zeilen unter Anschlussangaben, sonst 5. Auf schmalem Papier
    // wird die Kontrollstrecke kürzer; reicht es dann noch nicht, steht „nicht Originalgröße“ nur in der
    // Kopfzeile des Blatts (dort immer) und nicht zusätzlich als ganzer Satz.
    {
      const maxLines = sideInfo || lb ? 4 : 5;
      const mark = t('pdf.markHint', { g: f1(g, 2) });
      const warn = notFull ? t('pdf.notFullSize', { scale: fmtScale(s, loc) }) : '';
      let size = 6;
      let calLen = 50;
      const linesFor = (w: number, sz: number) => {
        const a = wrapWords(mark, w, sz, false, measure);
        const b = warn ? wrapWords(warn, w, sz, false, measure) : [];
        return a.length + b.length <= maxLines ? { a, b } : { a, b: [] as string[] };
      };
      let L = linesFor(AW - calLen - 10, size);
      if (L.a.length + L.b.length > maxLines || (warn && !L.b.length)) {
        calLen = 30;
        L = linesFor(AW - calLen - 10, size);
      }
      if (L.a.length > maxLines) {
        size = 5;
        L = linesFor(AW - calLen - 10, size);
      }
      const lines = [...L.a, ...L.b];
      const lh = size * 1.13 * PT_MM + 0.05;
      const start = Math.min(PH - M - 4.5, PH - 7.6 - (lines.length - 1) * lh);
      font(size);
      doc.text(L.a.map(safe), M, start, { lineHeightFactor: lh / (size * PT_MM) });
      if (L.b.length) {
        setText('#7A2E10');
        doc.text(L.b.map(safe), M, start + L.a.length * lh, { lineHeightFactor: lh / (size * PT_MM) });
      }
      setText('#000000');
      drawCalibration(PW - M - calLen - 2, PH - M - 6, calLen);
    }
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

  // ================= 8. Schnittvorlagen
  if (opts.includeTemplates && tpl.groups.length) {
    onProgress?.(0.78, 'templates');
    newPage(t('pdf.templates'));
    chapterPage.set('templates', pg());
    font(12, true);
    text(t('pdf.templates'), M, M + 7);
    const hintEnd = para(t('pdf.templatesHint'), M, M + 12, AW, 7);
    const boxW = 60;
    const boxH = 68;
    const perRow = Math.max(1, Math.floor(AW / boxW));
    let bx = 0;
    let by = Math.max(M + 20, hintEnd + 1);
    const shown = tpl.groups.slice(0, opts.templateLimit);
    for (const gr of shown) {
      if (by + boxH > PH - M - 6) {
        newPage(t('pdf.templates'));
        by = M + 4;
        bx = 0;
      }
      drawTemplate(gr, M + bx * boxW, by, boxW - 3, boxH - 3);
      bx++;
      if (bx >= perRow) {
        bx = 0;
        by += boxH;
      }
    }
    if (tpl.groups.length > shown.length) {
      if (by + 10 > PH - M) newPage(t('pdf.templates'));
      setText('#7A2E10');
      para(t('pdf.templatesTruncated', { n: tpl.groups.length - shown.length }), M, PH - M - 8, AW, 8);
      setText('#000000');
    }
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
    const tailTexts = [
      `${t('pdf.colorsUsed')}: ${[...gr.colors].map((c) => String(palette[c]?.code ?? '?').padStart(2, '0')).join(', ')}`,
      `${gr.ids.join(', ')}${gr.count > gr.ids.length ? ' …' : ''}`,
    ];
    const wrap = (l: string) => doc.splitTextToSize(safe(l), w - 3) as string[];
    // Maßstab und Schriftgröße so wählen, dass alles Platz hat: zuerst kleinere Zeichnung, dann kleinere
    // Schrift, erst zuletzt ohne Farben/Positionen (die stehen auch in der Koordinatenliste).
    const maxZoom = Math.max(1, Math.floor(32 / Math.max(ci.rawW, ci.rawH)));
    const textTop = (zoom: number) => yv + 9 + ci.rawH * zoom + 3.5;
    const bottom = yv + h - 1;
    let layoutChoice: { zoom: number; size: number; lines: string[] } | null = null;
    for (const withTail of [true, false]) {
      for (const size of [5.5, 5, 4.5]) {
        font(size);
        const lh = size * 0.51;
        for (let zoom = maxZoom; zoom >= 1 && !layoutChoice; zoom--) {
          const lines = [...headTexts(zoom), ...warnTexts, ...cutTexts, ...(withTail ? tailTexts : [])].flatMap(wrap);
          if (textTop(zoom) + (lines.length - 1) * lh <= bottom) layoutChoice = { zoom, size, lines };
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
  if (opts.includeCoords) {
    onProgress?.(0.85, 'coords');
    let written = 0;
    let truncated = false;
    let firstOmitted: string | null = null;
    let totalSelected = 0;
    const skipped: string[] = [];
    let lastY: number | null = null;
    const pieceId = (row: number, col: number, i: number, n: number) => cellId(layout, row, col) + (n > 1 ? `-${i + 1}` : '');
    for (const sec of selected) {
      // dieselbe Zählung wie die Liste (cellPieces ohne Teile ohne Fläche) = Steine des Abschnitts
      const secTotal = sectionStones.get(sec.id) ?? stonesOf(sec);
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
              if (firstOmitted === null) firstOmitted = pieceId(row, col, i, ps.length);
              break outer;
            }
            const b = bbox(p.poly);
            const tg = ci.needsCut ? tpl.bySig.get(ci.signature) : undefined;
            rows.push([
              pieceId(row, col, i, ps.length),
              f1(b.minX, 2),
              f1(b.minY, 2),
              code2(p.color),
              shapeName(ci.shape),
              `${f1(ci.w, 2)} × ${f1(ci.h, 2)}`,
              ci.needsCut ? `${t('pdf.yes')}${tg ? ` (T${tg.no})` : ''}` : t('pdf.no'),
            ]);
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
      // Hinweis direkt unter der letzten Tabelle (neue Seite nur, wenn er dort nicht mehr passt)
      const notice = [
        t('pdf.coordsNotice', { limit: num(opts.coordLimit), n: num(written), total: num(totalSelected), first: firstOmitted ?? '–' }),
        ...(skipped.length ? [t('pdf.coordsSkipped', { ids: skipped.join(', ') })] : []),
      ].join(' ');
      const lines = wrapWords(notice, AW, 9, false, measure);
      const h = lines.length * 4;
      let ny = lastY !== null ? lastY + 2 : null;
      if (ny === null || ny + h > TABLE_BOTTOM) {
        newPage(t('pdf.coords'));
        if (!chapterPage.has('coords')) chapterPage.set('coords', pg());
        ny = M + 10;
      }
      setText('#7A2E10');
      para(notice, M, ny, AW, 9, { lh: 4 });
      setText('#000000');
    }
  }

  function firstStoneId(sec: Section): string | null {
    for (let row = sec.r0; row < sec.r1; row++)
      for (let col = sec.c0; col < sec.c1; col++) {
        const ps = cellPieces(layout, data, row, col);
        for (let i = 0; i < ps.length; i++) {
          if (pieceCutInfo(cache, layout, data, row, col, i, ps[i].poly, raw(ps[i].color)).invalid) continue;
          return cellId(layout, row, col) + (ps.length > 1 ? `-${i + 1}` : '');
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
    const sl = sheetLabel.get(i);
    text(`${sl ? `${t('pdf.sheet')} ${sl} · ` : ''}${t('pdf.page')} ${i} / ${total}`, PW - M, PH - 7, { align: 'right' });
  }
  setText('#000000');
  // Lesezeichen in Dokumentreihenfolge: Kapitel → Abschnitte → Blätter
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
    for (const sec of selected) {
      const p = secPage.get(sec.id);
      if (!p) continue;
      const sn = outline.add(sheetsNode, `${t('pdf.section')} ${sec.id}`, { pageNumber: p });
      (sheetPages.get(sec.id) ?? []).forEach((sp, i) => outline.add(sn, `${t('pdf.sheet')} ${sec.id}-${i + 1}`, { pageNumber: sp }));
    }
  chap('templates', t('pdf.templates'));
  const coordsNode = chap('coords', t('pdf.coords'));
  if (coordsNode)
    for (const sec of selected) {
      const p = coordPage.get(sec.id);
      if (p) outline.add(coordsNode, `${t('pdf.section')} ${sec.id}`, { pageNumber: p });
    }
  onProgress?.(1, 'done');
  return doc.output('arraybuffer');
}
