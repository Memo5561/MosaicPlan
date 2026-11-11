/**
 * Abschnittsgrößen passend zum Papier (Paket w6-plan-exports).
 *
 * Vorgaben „1 Blatt“ und „2×2 Blätter“: Abschnittsgröße = k × bedruckbare Fläche des Verlegeblatts / Maßstab
 * (printableArea aus pdfOptions – dieselbe Quelle wie PDF und Seitenplan). Auf 0,1 mm abgerundet, damit jeder
 * Abschnitt sicher auf k × k Blätter passt.
 *
 * sheetFit zählt mit dem Seitenplan des PDFs (planSheets) exakt, wie viele Verlegeblätter die Abschnitte brauchen
 * und wie gut das Papier genutzt wird – Grundlage für den Hinweis „Abschnitte passen schlecht zum Papier“.
 */
import type { Layout, SectionGrid } from './layout';
import { printableArea, type PdfOptions } from './pdfOptions';
import { planSheets } from './pdfPlan';

export interface SectionPreset {
  /** Abschnittsbreite und -höhe im Mosaik (mm) */
  wMm: number;
  hMm: number;
}

export interface PaperPresets {
  PW: number;
  PH: number;
  printW: number;
  printH: number;
  /** Maßstab der Vorgaben: der feste Blattmaßstab, bei „an Seite anpassen“ 1:1 */
  scale: number;
  /** PDF-Maßstab „an Seite anpassen“: dort passt jeder Abschnitt ohnehin auf ein Blatt */
  fitMode: boolean;
  one: SectionPreset;
  two: SectionPreset;
}

export function paperPresets(opts: PdfOptions): PaperPresets {
  const a = printableArea(opts);
  const fitMode = !(opts.sheetScale > 0);
  const scale = fitMode ? 1 : opts.sheetScale;
  // auf 0,1 mm abgerundet
  const size = (k: number): SectionPreset => ({ wMm: Math.floor((k * a.printW * 10) / scale) / 10, hMm: Math.floor((k * a.printH * 10) / scale) / 10 });
  return { ...a, scale, fitMode, one: size(1), two: size(2) };
}

export interface SheetFit {
  sections: number;
  /** Verlegeblätter aller Abschnitte (wie im PDF) */
  sheets: number;
  /** meiste Blätter eines Abschnitts */
  maxPerSection: number;
  /** Füllgrad: Mosaikfläche aller Blätter auf dem Papier / (Blätter × bedruckbare Fläche), 0 … 1 */
  fill: number;
  /** Blätter, die weniger als halb gefüllt sind */
  thin: number;
}

/**
 * Blattaufteilung der Abschnitte bei Maßstab `scale` (Standard: der PDF-Maßstab, bei „an Seite anpassen“ dessen
 * gemeinsamer Anpassungsmaßstab) – exakt der Seitenplan des PDFs.
 */
export function sheetFit(layout: Layout, grid: SectionGrid, opts: PdfOptions, scale?: number): SheetFit {
  const plan = planSheets(layout, grid, { ...opts, sectionIds: null, ...(scale ? { sheetScale: scale } : {}) });
  const s = plan.scale;
  const cap = plan.printW * plan.printH;
  let sheets = 0;
  let maxPer = 0;
  let used = 0;
  let thin = 0;
  for (const ss of plan.sections) {
    sheets += ss.sheets.length;
    if (ss.sheets.length > maxPer) maxPer = ss.sheets.length;
    for (const sh of ss.sheets) {
      const w = (layout.colX[sh.c1 - 1] + layout.colW[sh.c1 - 1] - layout.colX[sh.c0]) * s;
      const h = (layout.rowY[sh.r1 - 1] + layout.rowH[sh.r1 - 1] - layout.rowY[sh.r0]) * s;
      used += w * h;
      if (w * h < 0.5 * cap) thin++;
    }
  }
  return { sections: grid.sections.length, sheets, maxPerSection: maxPer, fill: sheets ? used / (sheets * cap) : 0, thin };
}
