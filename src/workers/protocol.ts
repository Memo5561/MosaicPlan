import type { ComputeDiagnostics, ComputeParams } from '../core/mosaic';
import type { LayoutParams, SectionSettings } from '../core/layout';
import type { PdfImage } from '../core/pdf';
import type { PdfOptions } from '../core/pdfOptions';
import type { StoredMosaic } from '../core/serialize';
import type { Stats, Range } from '../core/stats';
import type { ImageAdjust, Material, PaletteColor, ProjectSettings, Region } from '../core/types';

export interface RawImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type WorkerRequest =
  | {
      type: 'compute';
      id: number;
      image: RawImage;
      adjust: ImageAdjust;
      regions: Region[];
      layoutParams: LayoutParams;
      params: Omit<ComputeParams, 'layout'>;
    }
  | {
      type: 'stats';
      id: number;
      layoutParams: LayoutParams;
      mosaic: StoredMosaic;
      palette: PaletteColor[];
      materials: Material[];
      reservePct: number;
      groutDepthMm: number;
      /** zusätzliche Teilbereiche (optional; die App fragt nur die Gesamtstatistik ab) */
      ranges?: { key: string; range: Range }[];
    }
  | {
      type: 'pdf';
      id: number;
      layoutParams: LayoutParams;
      mosaic: StoredMosaic;
      palette: PaletteColor[];
      materials: Material[];
      settings: ProjectSettings;
      projectName: string;
      dateStr: string;
      original?: PdfImage;
      preview?: PdfImage;
      dict: Record<string, string>;
      locale: 'de' | 'en' | 'tr';
      fontsBase: string;
      options: PdfOptions;
    }
  | {
      type: 'csv';
      id: number;
      layoutParams: LayoutParams;
      mosaic: StoredMosaic;
      palette: PaletteColor[];
      materials: Material[];
      sections: SectionSettings;
      sectionIds: string[] | null;
      decimalComma: boolean;
      /** Sprache der automatischen Farbnamen */
      lang?: 'de' | 'en' | 'tr';
    };

export type WorkerResponse =
  | { type: 'progress'; id: number; phase: string; fraction: number }
  | { type: 'error'; id: number; message: string }
  | { type: 'compute'; id: number; mosaic: StoredMosaic; palette: PaletteColor[]; diagnostics: ComputeDiagnostics; processed: RawImage }
  | { type: 'stats'; id: number; total: Stats; ranges: { key: string; stats: Stats }[] }
  | { type: 'pdf'; id: number; pdf: ArrayBuffer }
  | { type: 'csv'; id: number; csv: string };
