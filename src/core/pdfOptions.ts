export type PaperFormat = 'a4' | 'a3' | 'a2' | 'a1' | 'a0' | 'custom';

export interface PdfOptions {
  format: PaperFormat;
  customW?: number;
  customH?: number;
  orientation: 'portrait' | 'landscape';
  /** Papier-mm je Mosaik-mm: 1 = 1:1, 2 = 2:1 (vergrößert), 0 = je Abschnitt an Seite anpassen */
  sheetScale: number;
  sectionIds: string[] | null;
  includeCoords: boolean;
  coordLimit: number;
  includeTemplates: boolean;
  templateLimit: number;
  includeImages: boolean;
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
};

