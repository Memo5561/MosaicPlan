/**
 * Abschnittsgrößen passend zum Papier (Paket w6-plan-exports).
 *
 * Vorgabe „1 Blatt“: Abschnittsgröße = bedruckbare Fläche des Verlegeblatts / Maßstab (printableArea aus pdfOptions –
 * dieselbe Quelle wie PDF und Seitenplan), auf 0,1 mm abgerundet – jeder Abschnitt passt auf genau ein Blatt.
 *
 * Vorgabe „2×2 Blätter“: NICHT einfach 2 × Blattfläche. Blattgrenzen liegen auf Rasterlinien (balancedSplit), ein
 * Blatt nimmt also nur ganze Steine auf; ein Abschnitt von knapp 2 × Blattbreite kann deshalb 3 Blattspalten brauchen.
 * Mit bekanntem Raster wird die Größe aus dem Raster bestimmt (maxSpanForSheets): die größte Länge, bei der JEDER
 * mögliche Abschnitt (Start auf einer Rasterlinie) mit höchstens 2 Blättern je Richtung auskommt. Ohne Raster bleibt
 * 2 × Blattfläche als Obergrenze.
 *
 * sheetFit zählt mit dem Seitenplan des PDFs (planSheets) exakt, wie viele Verlegeblätter die Abschnitte brauchen
 * und wie gut das Papier genutzt wird – Grundlage für den Hinweis „Abschnitte passen schlecht zum Papier“.
 */
import { sectionsFor, type Layout, type SectionGrid } from './layout';
import { printableArea, type PdfOptions } from './pdfOptions';
import { PLAN_EPS, planSheets } from './pdfPlan';

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

/** Rasterlänge auf 0,1 mm abgerundet (Rechenrauschen wie 355.99999999 zählt als 356 – Rasterlängen sind exakt) */
const floor01 = (v: number) => Math.floor(v * 10 + 1e-6) / 10;

/**
 * Größte Abschnittslänge (mm, Mosaikmaß) entlang einer Achse, bei der jeder Abschnitt – gleich, auf welcher Rasterlinie
 * er beginnt – in höchstens `k` Blätter von `maxLen` Papier-mm (bei Maßstab `scale`) zerfällt, genau wie der Seitenplan
 * (balancedSplit: kleinste Blattzahl = gieriger Schnitt). Für jeden Start a: Ende nach k gierigen Blättern; liegt es
 * vor dem Rasterende, darf der Abschnitt höchstens bis dorthin reichen. Infinity: jeder Rest passt (Raster klein genug).
 */
export function maxSpanForSheets(pos: ArrayLike<number>, size: ArrayLike<number>, maxLen: number, scale: number, k: number): number {
  const n = pos.length;
  const span = (i: number, j: number) => pos[j - 1] + size[j - 1] - pos[i];
  // end[i]: Ende (exklusiv) des gierigen Blatts ab Spalte i – mindestens eine Spalte (zu breite Spalte = eigenes Blatt)
  const end = new Int32Array(n);
  for (let i = 0, j = 1; i < n; i++) {
    if (j < i + 1) j = i + 1;
    while (j < n && span(i, j + 1) * scale <= maxLen + PLAN_EPS) j++;
    end[i] = j;
  }
  let best = Infinity;
  for (let a = 0; a < n; a++) {
    let e = a;
    for (let s = 0; s < k && e < n; s++) e = end[e];
    if (e < n) best = Math.min(best, span(a, e));
  }
  return best;
}

export function paperPresets(opts: PdfOptions, layout?: Pick<Layout, 'colX' | 'colW' | 'rowY' | 'rowH'>): PaperPresets {
  const a = printableArea(opts);
  const fitMode = !(opts.sheetScale > 0);
  const scale = fitMode ? 1 : opts.sheetScale;
  // k × Blattfläche, auf 0,1 mm abgerundet (nie darüber)
  const size = (k: number): SectionPreset => ({ wMm: Math.floor((k * a.printW * 10) / scale) / 10, hMm: Math.floor((k * a.printH * 10) / scale) / 10 });
  const one = size(1);
  let two = size(2);
  if (layout) {
    // aus dem Raster: höchstens 2 Blattspalten und 2 Blattzeilen je Abschnitt; nie größer als 2 × Blattfläche
    const w = maxSpanForSheets(layout.colX, layout.colW, a.printW, scale, 2);
    const h = maxSpanForSheets(layout.rowY, layout.rowH, a.printH, scale, 2);
    two = { wMm: Math.max(one.wMm, Math.min(two.wMm, floor01(w))), hMm: Math.max(one.hMm, Math.min(two.hMm, floor01(h))) };
  }
  return { ...a, scale, fitMode, one, two };
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

/** Gleiche Einteilung (gleiche Abschnittsgrenzen)? */
export function sameSectionGrid(a: SectionGrid, b: SectionGrid): boolean {
  const eq = (x: readonly number[], y: readonly number[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  return eq(a.colStarts, b.colStarts) && eq(a.rowStarts, b.rowStarts);
}

export interface PresetChoice {
  key: 'one' | 'two';
  preset: SectionPreset;
  fit: SheetFit;
  /** ergibt genau die aktuelle Einteilung (dann nicht noch einmal anbieten) */
  current: boolean;
  /** anzeigen: „1 Blatt“ immer; „2×2“ nur, wenn es weniger Abschnitte als „1 Blatt“ und nicht mehr Blätter ergibt */
  offered: boolean;
  /** beste angebotene Vorgabe, die die aktuelle Einteilung verbessert (weniger Blätter; gleich viele: weniger Abschnitte) */
  recommended: boolean;
}

export interface PresetChoices {
  cur: SheetFit;
  one: PresetChoice;
  two: PresetChoice;
  /** aktuelle Einteilung = eine angebotene Vorgabe (dann kein Hinweis „passen schlecht zum Papier“) */
  presetActive: boolean;
}

/**
 * Vorgaben „1 Blatt“/„2×2 Blätter“ für die aktuelle Einteilung bewerten – exakt mit dem Seitenplan (sheetFit) bei
 * Maßstab `pr.scale`. Reine Funktion; Schritt 9 zeigt danach an, was angeboten bzw. empfohlen wird.
 */
export function presetChoices(layout: Layout, current: SectionGrid, pr: PaperPresets, opts: PdfOptions): PresetChoices {
  const gridOf = (p: SectionPreset) => sectionsFor(layout, { sectionMode: 'size', sectionWmm: p.wMm, sectionHmm: p.hMm });
  const cur = sheetFit(layout, current, opts, pr.scale);
  const gOne = gridOf(pr.one);
  const gTwo = gridOf(pr.two);
  const sameOneTwo = sameSectionGrid(gOne, gTwo);
  const fOne = sheetFit(layout, gOne, opts, pr.scale);
  const fTwo = sameOneTwo ? fOne : sheetFit(layout, gTwo, opts, pr.scale);
  const oneCur = sameSectionGrid(gOne, current);
  const twoCur = !sameOneTwo && sameSectionGrid(gTwo, current);
  const twoUseful = !sameOneTwo && fTwo.sections < fOne.sections && fTwo.sheets <= fOne.sheets;
  const one: PresetChoice = { key: 'one', preset: pr.one, fit: fOne, current: oneCur, offered: true, recommended: false };
  // „2×2“, das nicht besser ist als „1 Blatt“, wird nicht angeboten – auch nicht, wenn die aktuelle Einteilung zufällig
  // genau so aussieht (dann bleibt der Hinweis „passen schlecht zum Papier“ und „1 Blatt“ wird empfohlen)
  const two: PresetChoice = { key: 'two', preset: pr.two, fit: fTwo, current: twoCur, offered: twoUseful, recommended: false };
  const better = (a: SheetFit, b: SheetFit) => a.sheets < b.sheets || (a.sheets === b.sheets && a.sections < b.sections);
  let best: PresetChoice | null = null;
  for (const c of [one, two]) if (c.offered && !c.current && better(c.fit, cur) && (!best || better(c.fit, best.fit))) best = c;
  if (best) best.recommended = true;
  return { cur, one, two, presetActive: oneCur || (twoCur && twoUseful) };
}
