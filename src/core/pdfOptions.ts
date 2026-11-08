export type PaperFormat = 'a4' | 'a3' | 'a2' | 'a1' | 'a0' | 'custom';

/**
 * Codeplan-Seiten (vergrößerte Seiten nur zum Nachschlagen der Farbnummern, gleicher Rasterbereich wie das Blatt):
 * 'auto' = nur für Blätter, auf denen Steine ohne Farbnummer bleiben würden (zu klein für den Maßstab);
 * 'always' = für jedes Blatt; 'off' = nie (das Blatt nennt dann die fehlenden Nummern).
 */
export type CodePlanMode = 'auto' | 'always' | 'off';

export interface PdfOptions {
  format: PaperFormat;
  customW?: number;
  customH?: number;
  orientation: 'portrait' | 'landscape';
  /**
   * Papier-mm je Mosaik-mm: 1 = 1:1, 2 = 2:1 (vergrößert), 0 = an Seite anpassen – dann gilt EIN
   * Normmaßstab für alle Abschnitte des Projekts (fitSheetScale), damit Passkreuze benachbarter Blätter passen.
   */
  sheetScale: number;
  sectionIds: string[] | null;
  includeCoords: boolean;
  coordLimit: number;
  includeTemplates: boolean;
  templateLimit: number;
  includeImages: boolean;
  /** Codeplan-Seiten (Standard 'auto'); fehlt der Wert in älteren gespeicherten Optionen, gilt 'auto'. */
  codePlan: CodePlanMode;
}

export const PAPER: Record<Exclude<PaperFormat, 'custom'>, [number, number]> = {
  a4: [210, 297],
  a3: [297, 420],
  a2: [420, 594],
  a1: [594, 841],
  a0: [841, 1189],
};

export const DEFAULT_PDF_OPTIONS: PdfOptions = {
  format: 'a4',
  orientation: 'portrait',
  sheetScale: 1,
  sectionIds: null,
  includeCoords: true,
  coordLimit: 20000,
  includeTemplates: true,
  templateLimit: 400,
  includeImages: true,
  codePlan: 'auto',
};

/** Seitengröße (Breite, Höhe) in mm für Format und Ausrichtung */
export function pageSize(opts: Pick<PdfOptions, 'format' | 'customW' | 'customH' | 'orientation'>): { PW: number; PH: number } {
  const [pw0, ph0] = opts.format === 'custom' ? [opts.customW ?? 210, opts.customH ?? 297] : PAPER[opts.format];
  const portrait = opts.orientation === 'portrait';
  return { PW: portrait ? Math.min(pw0, ph0) : Math.max(pw0, ph0), PH: portrait ? Math.max(pw0, ph0) : Math.min(pw0, ph0) };
}

/**
 * Ränder eines Verlegeblatts in mm – EINE Quelle für PDF-Generator, Seitenplan und Seitenschätzung:
 * M = Seitenrand (Kopf-/Fußzeile, Kontrollstrecke außerhalb des nicht bedruckbaren Druckerrands),
 * top = Titel + Spaltennummern + Lineal, left = Zeilenbeschriftung + Lineal, bottom = Anschlussangaben,
 * Passmarken-Hinweis, Kontrollstrecke und Seitenzahl. Rechts bleibt nur der Seitenrand (Anschlussbeschriftung).
 */
export const SHEET_RESERVES = { M: 10, top: 19, left: 12, bottom: 21 } as const;
export const SHEET_MARGIN = SHEET_RESERVES.M;
export const SHEET_TOP_RESERVE = SHEET_RESERVES.top;
export const SHEET_LEFT_RESERVE = SHEET_RESERVES.left;
export const SHEET_BOTTOM_RESERVE = SHEET_RESERVES.bottom;

/** Bedruckbare Fläche eines Verlegeblatts (Mosaikbereich) in mm – von PDF und Seitenschätzung gemeinsam genutzt. */
export function sheetPrintArea(PW: number, PH: number): { printW: number; printH: number } {
  const R = SHEET_RESERVES;
  return {
    printW: PW - R.M - R.left - R.M,
    printH: PH - R.M - R.top - R.bottom,
  };
}

/**
 * Seitengröße und bedruckbarer Mosaikbereich eines Verlegeblatts für die gewählten PDF-Optionen (mm).
 * A4 hoch: 210 × 297 → 178 × 247 mm. Bei Maßstab s passt ein Mosaikbereich von printW/s × printH/s mm auf ein Blatt.
 */
export function printableArea(opts: Pick<PdfOptions, 'format' | 'customW' | 'customH' | 'orientation'>): { PW: number; PH: number; printW: number; printH: number } {
  const { PW, PH } = pageSize(opts);
  return { PW, PH, ...sheetPrintArea(PW, PH) };
}

/**
 * Normmaßstäbe für „an Seite anpassen“ (Papier-mm je Mosaik-mm), absteigend:
 * 4:1, 3:1, 2:1, 1:1, 1:1,25, 1:1,5, 1:2, 1:2,5, 1:3, 1:4, 1:5 … 1:100.
 */
export const FIT_SCALE_DENOMINATORS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12.5, 15, 20, 25, 30, 40, 50, 60, 75, 100];
export const STANDARD_SCALES: number[] = [4, 3, 2, ...FIT_SCALE_DENOMINATORS.map((d) => 1 / d)];

/**
 * Ein gemeinsamer Maßstab für „an Seite anpassen“: das Minimum über ALLE Abschnitte des Projekts von
 * min(printW / w, printH / h), abgerundet auf den nächstkleineren Normmaßstab. Damit hat jedes Blatt –
 * auch bei getrennt exportierten Abschnitten – denselben Maßstab, jeder Abschnitt passt auf genau ein Blatt
 * und die Passkreuze benachbarter Blätter liegen deckungsgleich. Unterhalb von 1:100: 1:⌈1/raw⌉.
 */
export function fitSheetScale(sections: readonly { w: number; h: number }[], printW: number, printH: number): number {
  let raw = Infinity;
  for (const s of sections) {
    if (!(s.w > 0) || !(s.h > 0)) continue;
    const v = Math.min(printW / s.w, printH / s.h);
    if (v < raw) raw = v;
  }
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  for (const s of STANDARD_SCALES) if (s <= raw + 1e-9) return s;
  return 1 / Math.ceil(1 / raw - 1e-9);
}

/** Wirksamer Maßstab der Verlegeblätter: fester Maßstab oder gemeinsamer Anpassungsmaßstab. */
export function effectiveSheetScale(opts: Pick<PdfOptions, 'sheetScale'>, sections: readonly { w: number; h: number }[], printW: number, printH: number): number {
  return opts.sheetScale > 0 ? opts.sheetScale : fitSheetScale(sections, printW, printH);
}

/** Maßstab in üblicher Schreibweise: 2:1, 1:1, 1:1,5 (Dezimalkomma außer Englisch). */
export function fmtScale(s: number, locale: 'de' | 'en' | 'tr' = 'de'): string {
  const f = (v: number) => {
    const r = Math.round(v * 100) / 100;
    const str = String(r);
    return locale === 'en' ? str : str.replace('.', ',');
  };
  if (!(s > 0)) return '–';
  return s >= 1 - 1e-9 ? `${f(s)}:1` : `1:${f(1 / s)}`;
}
