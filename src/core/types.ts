import type { Lab } from './color';
import type { EdgeMode } from './layout';
import type { Pt } from './geometry';

/** Zellarten im Raster. */
export const CellKind = {
  /** ein ganzer (ggf. am Rand gekürzter) Stein */
  FULL: 0,
  /** Diagonale „\“ – zwei Dreiecke: oben rechts (c1), unten links (c2) */
  DIAG_A: 1,
  /** Diagonale „/“ – zwei Dreiecke: oben links (c1), unten rechts (c2) */
  DIAG_B: 2,
  /** Kantenschnitt entlang einer berechneten Geraden – zwei Teile (c1, c2) */
  LINE: 3,
  /** Unterteilung in k×k kleinere Steine */
  SUB: 4,
  /** Freiform: vom Benutzer gezeichnete Konturen */
  FREE: 5,
} as const;
export type CellKindValue = (typeof CellKind)[keyof typeof CellKind];

export interface FreePiece {
  /** Polygon relativ zur oberen linken Ecke der Zelle, in mm */
  poly: Pt[];
  color: number;
}

/** Empfehlungs-Bits (reine Empfehlung, NICHT berechnet). */
export const Rec = {
  FINER: 1,
  EDGE_CUT: 2,
} as const;

export interface MosaicData {
  cols: number;
  rows: number;
  kind: Uint8Array;
  c1: Uint16Array;
  c2: Uint16Array;
  /** SUB: k·k Farben zeilenweise */
  sub: Map<number, Uint16Array>;
  /** LINE: [nx, ny, d] – Gerade n·(p − Zellmitte) = d */
  line: Map<number, Float32Array>;
  free: Map<number, FreePiece[]>;
  /** Bitmaske: Teilstück i verlegt */
  progress: Uint16Array;
  /** Empfehlungen (siehe Rec) */
  rec: Uint8Array;
}

export interface PaletteColor {
  /** eindeutige, stabile Farbnummer im Projekt (01, 02, …) */
  code: number;
  name: string;
  hex: string;
  lab: Lab;
  materialId?: string;
  /** ΔE zur Ursprungsfarbe des Bildes (bei Materialabgleich) */
  deltaE?: number;
}

export type PaletteMode = 'auto' | 'auto-snap' | 'materials' | 'custom';

export interface ShapeOptions {
  /** Diagonale Dreiecksschnitte erlauben */
  diagonal: boolean;
  /** Kantenschnitte entlang Bildkanten (Trapez/Dreieck/individuell) */
  line: boolean;
  /** Feinere Steine (k×k-Unterteilung) in Detailbereichen */
  subdivide: boolean;
  subdivK: 2 | 3;
  /** 0 = kaum Schnitte, 1 = sehr viele Schnitte */
  detailLevel: number;
  /** Detailbereiche automatisch erkennen (Kantendichte) */
  autoDetail: boolean;
  /** Hauttöne schützen/bevorzugen */
  skinProtect: boolean;
  /** Mindestbreite: schmalste Stelle eines geschnittenen Teils (Dreieck, Kantenschnitt, Teilstein) in mm */
  minPieceMm: number;
}

export interface Region {
  id: string;
  type: 'detail' | 'face';
  shape: 'rect' | 'ellipse';
  /** normiert (0..1) bezogen auf das zugeschnittene Bild */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageAdjust {
  rotation: 0 | 90 | 180 | 270;
  fineRotate: number;
  flipH: boolean;
  /** normiert (0..1) auf dem gedrehten Bild; null = automatisch zentriert */
  crop: { x: number; y: number; w: number; h: number } | null;
  brightness: number;
  contrast: number;
  saturation: number;
  sharpen: number;
  bgSimplify: number;
  detailBoost: number;
  autoLevels: boolean;
  whiteBalance: boolean;
}

export interface ProjectSettings {
  widthMm: number;
  heightMm: number;
  unit: 'cm' | 'm' | 'mm';
  tileW: number;
  tileH: number;
  joint: number;
  edgeMode: EdgeMode;
  minCutMm: number;
  paletteMode: PaletteMode;
  colorCount: number;
  dither: number;
  deltaE: '2000' | '76';
  /** IDs der Materialien, die für die Palette verwendet werden dürfen (leer = alle) */
  materialIds: string[];
  shapes: ShapeOptions;
  /** Abschnitte nach max. Größe oder nach Anzahl (Spalten × Zeilen) */
  sectionMode: 'size' | 'count';
  sectionWmm: number;
  sectionHmm: number;
  sectionCols: number;
  sectionRows: number;
  reservePct: number;
  groutHex: string;
  surface: 'glass' | 'ceramic';
  /** Fugentiefe in mm für die Fugenmassen-Schätzung */
  groutDepthMm: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  thumb?: string;
  computed: boolean;
}

export interface Material {
  id: string;
  type: 'glass' | 'ceramic' | 'smalti' | 'stone' | 'other';
  manufacturer: string;
  product: string;
  colorNumber: string;
  colorName: string;
  hex: string;
  lengthMm: number;
  widthMm: number;
  thicknessMm: number;
  price: number;
  packageSize: string;
  piecesPerPack: number;
  stock?: number;
  notes?: string;
}

export const DEFAULT_SHAPES: ShapeOptions = {
  diagonal: true,
  line: true,
  subdivide: true,
  subdivK: 2,
  detailLevel: 0.5,
  autoDetail: true,
  skinProtect: true,
  minPieceMm: 2,
};

export const DEFAULT_ADJUST: ImageAdjust = {
  rotation: 0,
  fineRotate: 0,
  flipH: false,
  crop: null,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  sharpen: 0,
  bgSimplify: 0,
  detailBoost: 0,
  autoLevels: false,
  whiteBalance: false,
};

export const DEFAULT_SETTINGS: ProjectSettings = {
  widthMm: 300,
  heightMm: 400,
  unit: 'cm',
  tileW: 8,
  tileH: 8,
  joint: 1,
  edgeMode: 'cut-end',
  minCutMm: 2,
  paletteMode: 'auto',
  colorCount: 24,
  dither: 0,
  deltaE: '2000',
  materialIds: [],
  shapes: { ...DEFAULT_SHAPES },
  sectionMode: 'size',
  sectionWmm: 300,
  sectionHmm: 300,
  sectionCols: 4,
  sectionRows: 3,
  reservePct: 10,
  groutHex: '#BDB8AE',
  surface: 'glass',
  groutDepthMm: 3,
};

export function createEmptyMosaic(cols: number, rows: number): MosaicData {
  const n = cols * rows;
  return {
    cols,
    rows,
    kind: new Uint8Array(n),
    c1: new Uint16Array(n),
    c2: new Uint16Array(n),
    sub: new Map(),
    line: new Map(),
    free: new Map(),
    progress: new Uint16Array(n),
    rec: new Uint8Array(n),
  };
}
