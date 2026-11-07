/**
 * PDF-Verlegeplan (jsPDF, Einheit mm). Verlegeblätter werden maßstäblich
 * (Standard 1:1) gezeichnet; beim Druck „Tatsächliche Größe / 100 %“ wählen.
 */
import { jsPDF } from 'jspdf';
import { hexToRgb, textColorFor } from './color';
import { bbox, centroid, fmtMm, type Pt } from './geometry';
import { cellId, rowLabel, type Layout, type Section, type SectionGrid } from './layout';
import { cellPieces, type CutInfo } from './pieces';
import { CutCache, computeStats, makeRawSizeFn, pieceCutInfo } from './stats';
import { CellKind, type Material, type MosaicData, type PaletteColor, type ProjectSettings } from './types';

import { PAPER, type PdfOptions } from './pdfOptions';
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

export async function generatePdf(input: PdfInput, opts: PdfOptions, onProgress?: (f: number, label: string) => void): Promise<ArrayBuffer> {
  const { layout, data, palette, materials, settings, t } = input;
  const [pw0, ph0] = opts.format === 'custom' ? [opts.customW ?? 210, opts.customH ?? 297] : PAPER[opts.format];
  const portrait = opts.orientation === 'portrait';
  const PW = portrait ? Math.min(pw0, ph0) : Math.max(pw0, ph0);
  const PH = portrait ? Math.max(pw0, ph0) : Math.min(pw0, ph0);
  const doc = new jsPDF({ unit: 'mm', format: [PW, PH], orientation: portrait ? 'portrait' : 'landscape', compress: true });
  const M = 10;
  let FONT = 'helvetica';
  if (input.fonts) {
    doc.addFileToVFS('DejaVuSans.ttf', input.fonts.regular);
    doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
    doc.addFileToVFS('DejaVuSans-Bold.ttf', input.fonts.bold);
    doc.addFont('DejaVuSans-Bold.ttf', 'DejaVu', 'bold');
    FONT = 'DejaVu';
  }
  const loc = input.locale;
  const f1 = (v: number, d = 1) => fmtMm(v, d, loc);
  const num = (v: number) => Math.round(v).toLocaleString(loc === 'de' ? 'de-DE' : loc === 'tr' ? 'tr-TR' : 'en-GB');
  const font = (size: number, bold = false) => {
    doc.setFont(FONT, bold ? 'bold' : 'normal');
    doc.setFontSize(size);
  };
  const safe = (s: string) => (FONT === 'helvetica' ? s.replace(/[ğĞşŞıİ]/g, (c) => ({ ğ: 'g', Ğ: 'G', ş: 's', Ş: 'S', ı: 'i', İ: 'I' })[c] ?? c) : s);
  const text = (s: string, x: number, y: number, o: { align?: 'left' | 'center' | 'right'; baseline?: 'top' | 'middle' | 'bottom' | 'alphabetic'; angle?: number; maxWidth?: number } = {}) =>
    doc.text(safe(s), x, y, { align: o.align, baseline: o.baseline ?? 'alphabetic', angle: o.angle, maxWidth: o.maxWidth });
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
  let first = true;
  const newPage = (header: string) => {
    if (!first) doc.addPage([PW, PH], portrait ? 'portrait' : 'landscape');
    first = false;
    font(8);
    setText('#555555');
    text(`MosaicPlan · ${input.projectName}`, M, M - 3);
    text(header, PW - M, M - 3, { align: 'right' });
    setDraw('#BBBBBB');
    doc.setLineWidth(0.2);
    doc.line(M, M - 1.5, PW - M, M - 1.5);
    setText('#000000');
  };
  const cache = new CutCache();
  const stats = computeStats(layout, data, palette, materials, { reservePct: settings.reservePct, groutDepthMm: settings.groutDepthMm }, undefined, cache);
  const shapeName = (s: string) => t(`shape.${s}`);
  const matById = new Map(materials.map((m) => [m.id, m]));

  // ---------- Tabellen-Helfer
  const table = (
    title: string,
    header: string[],
    widths: number[],
    rows: (string | { swatch: string })[][],
    startY: number,
    headerTitle: string,
    rowH = 5,
  ): number => {
    let y = startY;
    const drawHeader = () => {
      font(8, true);
      setFill('#EEEAE3');
      doc.rect(M, y - 3.6, PW - 2 * M, rowH, 'F');
      let x = M + 1;
      header.forEach((h, i) => {
        text(h, x, y);
        x += widths[i];
      });
      y += rowH;
      font(8);
    };
    if (title) {
      font(12, true);
      text(title, M, y);
      y += 7;
    }
    drawHeader();
    for (const r of rows) {
      if (y > PH - M - 8) {
        newPage(headerTitle);
        y = M + 6;
        drawHeader();
      }
      let x = M + 1;
      r.forEach((c, i) => {
        if (typeof c === 'string') text(c, x, y, { maxWidth: widths[i] - 1 });
        else {
          setFill(c.swatch);
          setDraw('#666666');
          doc.setLineWidth(0.1);
          doc.rect(x, y - 3.2, widths[i] - 2, 3.8, 'FD');
        }
        x += widths[i];
      });
      setDraw('#E2DED6');
      doc.setLineWidth(0.1);
      doc.line(M, y + 1.4, PW - M, y + 1.4);
      y += rowH;
    }
    return y + 3;
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

  onProgress?.(0.02, 'cover');
  // ================= 1. Deckblatt
  newPage(t('pdf.cover'));
  font(26, true);
  setText('#1D2A3A');
  text('MosaicPlan', M, M + 18);
  font(14);
  setText('#444444');
  text(t('pdf.layingPlan'), M, M + 27);
  font(18, true);
  setText('#000000');
  text(input.projectName, M, M + 40, { maxWidth: PW - 2 * M });
  font(9);
  text(`${t('pdf.created')}: ${input.dateStr}`, M, M + 47);
  let y = M + 55;
  if (input.preview) {
    const box = addImageFit(input.preview, M, y, PW - 2 * M, PH * 0.38);
    y = box.y + box.h + 8;
  }
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
    [t('pdf.sheetScale'), opts.sheetScale > 0 ? `${opts.sheetScale}:1` : t('pdf.fitPage')],
  ];
  if (layout.restX > 1e-6 || layout.restY > 1e-6) kv.push([t('pdf.rest'), `${f1(layout.restX, 2)} × ${f1(layout.restY, 2)} mm`]);
  font(9);
  for (const [k, v] of kv) {
    if (y > PH - M - 30) break;
    font(9, true);
    text(k, M, y);
    font(9);
    text(v, M + 55, y, { maxWidth: PW - 2 * M - 55 });
    y += 5.5;
  }
  y += 3;
  font(8);
  setText('#7A2E10');
  text(t('pdf.printHint'), M, Math.min(y, PH - M - 20), { maxWidth: PW - 2 * M });
  setText('#000000');
  drawCalibration(M, PH - M - 10);

  // ================= 2./3. Originalfoto + Vorschau
  if (opts.includeImages && input.original) {
    newPage(t('pdf.original'));
    font(14, true);
    text(t('pdf.original'), M, M + 8);
    addImageFit(input.original, M, M + 14, PW - 2 * M, PH - 2 * M - 20);
  }
  if (opts.includeImages && input.preview) {
    newPage(t('pdf.preview'));
    font(14, true);
    text(t('pdf.preview'), M, M + 8);
    addImageFit(input.preview, M, M + 14, PW - 2 * M, PH - 2 * M - 20);
  }

  // ================= 4. Gesamtübersicht
  onProgress?.(0.08, 'overview');
  newPage(t('pdf.overview'));
  font(14, true);
  text(t('pdf.overview'), M, M + 8);
  {
    const availW = PW - 2 * M;
    const availH = Math.min(PH * 0.55, PH - 2 * M - 30);
    const s = Math.min(availW / layout.finishedW, availH / layout.finishedH);
    const x0 = M + (availW - layout.finishedW * s) / 2;
    const y0 = M + 14;
    if (input.preview) doc.addImage(input.preview.dataUrl, 'JPEG', x0, y0, layout.finishedW * s, layout.finishedH * s);
    else {
      setFill(settings.groutHex);
      doc.rect(x0, y0, layout.finishedW * s, layout.finishedH * s, 'F');
    }
    doc.setLineWidth(0.35);
    setDraw('#E0501E');
    font(Math.max(5, Math.min(14, (Math.min(...input.sections.sections.map((q) => Math.min(q.w, q.h))) * s) / 1.2)), true);
    for (const sec of input.sections.sections) {
      doc.rect(x0 + sec.x * s, y0 + sec.y * s, sec.w * s, sec.h * s, 'S');
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
    const secRows = input.sections.sections.map((sec) => {
      const p = sectionPieceCount(sec);
      return [sec.id, `${f1(sec.x)} / ${f1(sec.y)}`, `${f1(sec.w)} × ${f1(sec.h)}`, `${rowLabel(sec.r0)}–${rowLabel(sec.r1 - 1)}`, `${sec.c0 + 1}–${sec.c1}`, num(p)];
    });
    table('', [t('pdf.section'), 'X / Y (mm)', t('pdf.sizeMm'), t('pdf.rows'), t('pdf.cols'), t('pdf.stones')], [22, 38, 38, 28, 28, 30], secRows, y, t('pdf.overview'));
  }

  function sectionPieceCount(sec: Section): number {
    let n = 0;
    for (let r = sec.r0; r < sec.r1; r++)
      for (let c = sec.c0; c < sec.c1; c++) {
        const idx = r * layout.cols + c;
        const k = data.kind[idx];
        n += k === CellKind.FULL ? 1 : k === CellKind.SUB ? (data.sub.get(idx)?.length ?? 1) : k === CellKind.FREE ? (data.free.get(idx)?.length ?? 0) : 2;
      }
    return n;
  }

  // ================= 6. Farblegende
  onProgress?.(0.12, 'legend');
  newPage(t('pdf.legend'));
  y = table(
    t('pdf.legend'),
    [t('pdf.code'), '', t('pdf.name'), 'HEX', 'CIELAB', t('pdf.stones'), t('pdf.rawStones'), t('pdf.withReserve', { p: settings.reservePct }), t('pdf.material')],
    [12, 10, 30, 18, 34, 18, 18, 22, 28],
    palette.map((p, i) => {
      const cs = stats.perColor[i];
      const m = p.materialId ? matById.get(p.materialId) : undefined;
      return [
        String(p.code).padStart(2, '0'),
        { swatch: p.hex },
        p.name,
        p.hex,
        `${f1(p.lab[0])}; ${f1(p.lab[1])}; ${f1(p.lab[2])}`,
        num(cs.pieces),
        num(cs.raw),
        num(cs.rawWithReserve),
        m ? `${m.manufacturer} ${m.colorNumber}`.trim() : '–',
      ];
    }),
    M + 8,
    t('pdf.legend'),
  );

  // ================= 7. Materialliste
  newPage(t('pdf.materials'));
  y = M + 8;
  font(12, true);
  text(t('pdf.materials'), M, y);
  y += 7;
  font(9);
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
  if (stats.totalCost > 0) mk.push([t('pdf.cost'), `${f1(stats.totalCost, 2)} ${stats.costComplete ? '' : `(${t('pdf.incomplete')})`}`]);
  if (stats.notFitting > 0) mk.push([t('pdf.notFitting'), num(stats.notFitting)]);
  for (const [k, v] of mk) {
    font(9, true);
    text(k, M, y);
    font(9);
    text(v, M + 70, y);
    y += 5;
  }
  y += 4;
  const matRows = palette
    .map((p, i) => ({ p, cs: stats.perColor[i], m: p.materialId ? matById.get(p.materialId) : undefined }))
    .filter((r) => r.cs.pieces > 0)
    .map(({ p, cs, m }) => [
      String(p.code).padStart(2, '0'),
      { swatch: p.hex },
      m ? `${t(`mat.${m.type}`)} · ${m.manufacturer} ${m.product}`.trim() : t('pdf.noMaterial'),
      m?.colorNumber || '–',
      `${f1(cs.rawW)} × ${f1(cs.rawH)}`,
      num(cs.rawWithReserve),
      cs.packs !== undefined ? `${cs.packs} × ${m?.packageSize || m?.piecesPerPack}` : '–',
      cs.cost !== undefined ? f1(cs.cost, 2) : '–',
    ]);
  y = table(
    '',
    [t('pdf.code'), '', t('pdf.material'), t('pdf.colorNo'), t('pdf.rawSize'), t('pdf.needed'), t('pdf.packs'), t('pdf.price')],
    [12, 10, 52, 18, 24, 20, 30, 18],
    matRows,
    y,
    t('pdf.materials'),
  );
  if (y > PH - M - 50) {
    newPage(t('pdf.materials'));
    y = M + 8;
  }
  y = table(
    t('pdf.perShape'),
    [t('pdf.shape'), t('pdf.count')],
    [60, 30],
    Object.entries(stats.perShape)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => [shapeName(s), num(n)]),
    y + 4,
    t('pdf.materials'),
  );
  if (y > PH - M - 40) {
    newPage(t('pdf.materials'));
    y = M + 8;
  }
  table(
    t('pdf.perSize'),
    [t('pdf.shape'), t('pdf.sizeMm'), t('pdf.count')],
    [60, 40, 30],
    stats.perSize.slice(0, 300).map((s) => [shapeName(s.shape), `${f1(s.w)} × ${f1(s.h)}`, num(s.count)]),
    y + 4,
    t('pdf.materials'),
  );

  // ================= Schnittvorlagen sammeln (für Verweise in Koordinaten)
  onProgress?.(0.18, 'templates');
  const tpl = collectTemplates(layout, data, palette, materials, cache);

  // ================= 5. Verlegeblätter je Abschnitt
  const selected = input.sections.sections.filter((s) => !opts.sectionIds || opts.sectionIds.includes(s.id));
  const raw = makeRawSizeFn(layout, palette, materials);
  const g = layout.joint;
  const topReserve = 19; // Kopf + Spaltennummern + Lineal
  const leftReserve = 12;
  const bottomReserve = 14;
  const printW = PW - M - leftReserve - M;
  const printH = PH - M - topReserve - bottomReserve;

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
  for (const sec of selected) {
    const s = opts.sheetScale > 0 ? opts.sheetScale : Math.min(printW / sec.w, printH / sec.h);
    const { cx, ry } = tilesOf(sec, s);
    const nT = cx.length * ry.length;
    // --- Abschnitts-Deckblatt mit Legende und Stückzahlen
    const secStats = computeStats(
      layout,
      data,
      palette,
      materials,
      { reservePct: settings.reservePct, groutDepthMm: settings.groutDepthMm },
      { r0: sec.r0, r1: sec.r1, c0: sec.c0, c1: sec.c1 },
      cache,
    );
    newPage(`${t('pdf.section')} ${sec.id}`);
    font(16, true);
    text(`${t('pdf.section')} ${sec.id}`, M, M + 9);
    font(9);
    let yy = M + 16;
    const nb = (dr: number, dc: number) => neighborSec(sec, dr, dc)?.id ?? '–';
    const secKv: [string, string][] = [
      [t('pdf.position'), `X ${f1(sec.x, 2)} mm, Y ${f1(sec.y, 2)} mm (${t('pdf.fromOrigin')})`],
      [t('pdf.sizeMm'), `${f1(sec.w, 2)} × ${f1(sec.h, 2)} mm`],
      [t('pdf.cells'), `${t('pdf.rows')} ${rowLabel(sec.r0)}–${rowLabel(sec.r1 - 1)}, ${t('pdf.cols')} ${sec.c0 + 1}–${sec.c1} (${num((sec.r1 - sec.r0) * (sec.c1 - sec.c0))} ${t('pdf.positions')})`],
      [t('pdf.stones'), num(secStats.pieces)],
      [t('pdf.neighbors'), `${t('dir.N')}: ${nb(-1, 0)} · ${t('dir.E')}: ${nb(0, 1)} · ${t('dir.S')}: ${nb(1, 0)} · ${t('dir.W')}: ${nb(0, -1)}`],
      [t('pdf.jointToNeighbor'), `${f1(g, 2)} mm`],
      [t('pdf.sheets'), `${nT} (${cx.length} × ${ry.length}), ${t('pdf.scale')} ${opts.sheetScale > 0 ? `${s}:1` : `${f1(s, 3)}:1`}`],
    ];
    for (const [k, v] of secKv) {
      font(9, true);
      text(k, M, yy);
      font(9);
      text(v, M + 45, yy, { maxWidth: PW - 2 * M - 45 });
      yy += 5;
    }
    // Mini-Übersicht der Blätter
    {
      const boxW = Math.min(70, PW - 2 * M);
      const ms = Math.min(boxW / sec.w, 45 / sec.h);
      const bx = PW - M - sec.w * ms;
      const by = M + 14;
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
          if (w > 4 && h > 3) text(`${ti}`, x + w / 2, yv + h / 2, { align: 'center', baseline: 'middle' });
        }
    }
    yy = Math.max(yy, M + 64) + 2;
    yy = table(
      t('pdf.sectionLegend'),
      [t('pdf.code'), '', t('pdf.name'), 'HEX', t('pdf.stones'), t('pdf.uncut'), t('pdf.cut'), t('pdf.rawStones')],
      [14, 10, 40, 22, 22, 22, 22, 24],
      secStats.perColor
        .filter((c) => c.pieces > 0)
        .map((c) => [String(palette[c.color].code).padStart(2, '0'), { swatch: palette[c.color].hex }, palette[c.color].name, palette[c.color].hex, num(c.pieces), num(c.uncut), num(c.cut), num(c.raw)]),
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
    const X0 = layout.colX[c0];
    const Y0 = layout.rowY[r0];
    const X1 = layout.colX[c1 - 1] + layout.colW[c1 - 1];
    const Y1 = layout.rowY[r1 - 1] + layout.rowH[r1 - 1];
    const L = M + leftReserve;
    const T = M + topReserve;
    const px = (X: number) => L + (X - X0) * s;
    const py = (Y: number) => T + (Y - Y0) * s;
    font(10, true);
    text(`${t('pdf.section')} ${sec.id} – ${t('pdf.sheet')} ${sec.id}-${ti} (${ti}/${nT})`, M, M + 3.5);
    font(7);
    text(
      `X ${f1(X0, 2)}–${f1(X1, 2)} mm · Y ${f1(Y0, 2)}–${f1(Y1, 2)} mm · ${t('pdf.scale')} ${f1(s, 3)}:1 · ${t('pdf.originShort')}`,
      PW - M,
      M + 3.5,
      { align: 'right' },
    );
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
    doc.setFontSize(Math.max(4, Math.min(7, ((layout.tileW + g) * s * cs) / 0.3528 / 2.4)));
    for (let col = c0; col < c1; col++) {
      if ((col + 1) % cs !== 0 && col !== c0 && cs > 1) continue;
      doc.text(String(col + 1), px(layout.colX[col] + layout.colW[col] / 2), T - 9, { align: 'center', angle: cs === 1 && (layout.tileW + g) * s < 5 ? 90 : 0, baseline: 'middle' });
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
    doc.setFontSize(5);
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
    if (lr) {
      doc.line(px(rightE), py(topE) - 4, px(rightE), py(botE) + 4);
      doc.text(`${t('pdf.joinTo')} ${lr} →`, px(rightE) + 1.2, py((topE + botE) / 2), { angle: -90, align: 'center' });
    }
    if (ll) {
      doc.line(px(leftE), py(topE) - 4, px(leftE), py(botE) + 4);
    }
    if (lb) {
      doc.line(px(leftE) - 4, py(botE), px(rightE) + 4, py(botE));
      doc.text(`↓ ${t('pdf.joinTo')} ${lb}`, px((leftE + rightE) / 2), py(botE) + 3, { align: 'center' });
    }
    if (lt) doc.line(px(leftE) - 4, py(topE), px(rightE) + 4, py(topE));
    doc.setLineDashPattern([], 0);
    font(5.5);
    setText('#E0501E');
    const sideInfo = [ll && `← ${ll}`, lt && `↑ ${lt}`].filter(Boolean).join('   ');
    if (sideInfo) text(sideInfo, M, PH - M - 6.5);
    setText('#000000');
    font(6);
    text(`${t('pdf.markHint', { g: f1(g, 2) })}`, M, PH - M - 3.5, { maxWidth: PW - 2 * M - 60 });
    drawCalibration(PW - M - 52, PH - M - 7.5, 50);
  }

  function drawCalibration(x: number, yv: number, len = 100) {
    if (x + len > PW - M + 0.01) len = Math.floor((PW - M - x) / 10) * 10;
    if (len <= 0) return;
    setDraw('#000000');
    doc.setLineWidth(0.2);
    doc.line(x, yv, x + len, yv);
    for (let i = 0; i <= len; i += 10) doc.line(x + i, yv - (i % 50 === 0 ? 2 : 1), x + i, yv);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(5);
    setText('#000000');
    doc.text(safe(t('pdf.calibration', { n: len })), x + len / 2, yv + 2.5, { align: 'center' });
  }

  // ================= 8. Schnittvorlagen
  if (opts.includeTemplates && tpl.groups.length) {
    onProgress?.(0.78, 'templates');
    newPage(t('pdf.templates'));
    font(12, true);
    text(t('pdf.templates'), M, M + 7);
    font(7);
    text(t('pdf.templatesHint'), M, M + 12, { maxWidth: PW - 2 * M });
    const boxW = 60;
    const boxH = 68;
    const perRow = Math.max(1, Math.floor((PW - 2 * M) / boxW));
    let bx = 0;
    let by = M + 20;
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
      font(8);
      setText('#7A2E10');
      text(t('pdf.templatesTruncated', { n: tpl.groups.length - shown.length }), M, PH - M - 8);
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
    // Maßstab so wählen, dass der Rohstein ~32 mm groß ist
    const zoom = Math.max(1, Math.floor(32 / Math.max(ci.rawW, ci.rawH)));
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
    setDraw('#D0021B');
    doc.setLineWidth(0.3);
    for (const [a, b] of ci.cutLines) doc.line(ox + a.x * zoom, oy + a.y * zoom, ox + b.x * zoom, oy + b.y * zoom);
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
    let ty = oy + ci.rawH * zoom + 3.5;
    font(5.5);
    const lines = [
      `${t('pdf.raw')}: ${f1(ci.rawW)} × ${f1(ci.rawH)} mm · ${t('pdf.scale')} ${zoom}:1`,
      `${t('pdf.outer')}: ${f1(ci.w)} × ${f1(ci.h)} mm · ${t('pdf.area')}: ${f1(ci.area, 1)} mm²`,
      `${t('pdf.angles')}: ${ci.angles.map((a) => `${f1(a, 1)}°`).join(', ')}`,
      ...ci.cutLines.map((l, i) => `${t('pdf.cutLine')} ${i + 1}: (${f1(l[0].x)}; ${f1(l[0].y)}) → (${f1(l[1].x)}; ${f1(l[1].y)})`),
      `${t('pdf.colorsUsed')}: ${[...gr.colors].map((c) => String(palette[c]?.code ?? '?').padStart(2, '0')).join(', ')}`,
      `${gr.ids.join(', ')}${gr.count > gr.ids.length ? ' …' : ''}`,
    ];
    if (!ci.convex) lines.push(t('pdf.nonConvex'));
    if (!ci.fits) lines.push(t('pdf.notFitting'));
    for (const l of lines) {
      if (ty > yv + h - 1) break;
      text(l, x + 1.5, ty, { maxWidth: w - 3 });
      ty += 2.8;
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
    for (const sec of selected) {
      if (written >= opts.coordLimit) {
        truncated = true;
        break;
      }
      newPage(`${t('pdf.coords')} ${sec.id}`);
      const rows: string[][] = [];
      for (let row = sec.r0; row < sec.r1 && written < opts.coordLimit; row++) {
        for (let col = sec.c0; col < sec.c1 && written < opts.coordLimit; col++) {
          const ps = cellPieces(layout, data, row, col);
          ps.forEach((p, i) => {
            if (written >= opts.coordLimit) {
              truncated = true;
              return;
            }
            const ci = pieceCutInfo(cache, layout, data, row, col, i, p.poly, raw(p.color));
            const b = bbox(p.poly);
            const tg = ci.needsCut ? tpl.bySig.get(ci.signature) : undefined;
            rows.push([
              cellId(layout, row, col) + (ps.length > 1 ? `-${i + 1}` : ''),
              f1(b.minX, 2),
              f1(b.minY, 2),
              String(palette[p.color]?.code ?? '?').padStart(2, '0'),
              shapeName(ci.shape),
              `${f1(ci.w, 2)} × ${f1(ci.h, 2)}`,
              ci.needsCut ? `${t('pdf.yes')}${tg ? ` (T${tg.no})` : ''}` : t('pdf.no'),
            ]);
            written++;
          });
        }
      }
      table(
        `${t('pdf.coords')} – ${t('pdf.section')} ${sec.id}`,
        [t('pdf.position'), 'X (mm)', 'Y (mm)', t('pdf.code'), t('pdf.shape'), t('pdf.sizeMm'), t('pdf.cutQ')],
        [26, 22, 22, 16, 32, 34, 30],
        rows,
        M + 8,
        `${t('pdf.coords')} ${sec.id}`,
        4.2,
      );
    }
    if (truncated) {
      newPage(t('pdf.coords'));
      font(10);
      setText('#7A2E10');
      text(t('pdf.coordsTruncated', { n: opts.coordLimit }), M, M + 10, { maxWidth: PW - 2 * M });
      setText('#000000');
    }
  }

  // ================= 11. Seitenzahlen
  onProgress?.(0.95, 'pages');
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    font(7);
    setText('#555555');
    text(`${t('pdf.page')} ${i} / ${total}`, PW - M, PH - 3.5, { align: 'right' });
  }
  onProgress?.(1, 'done');
  return doc.output('arraybuffer');
}

