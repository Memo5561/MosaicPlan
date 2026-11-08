import type { Lab } from './color';
import type { EdgeMode } from './layout';
import type { Pt } from './geometry';
import type { NameSuffix } from './colorNames';

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

/**
 * Abweichung der Steine einer Farbe vom Foto, gemessen bei der Berechnung: je Stein das (unvermischte)
 * Bild-Lab des Steins gegen die zugeordnete Palettenfarbe, mit der Formel der Projekteinstellung.
 * Gilt für den Stand der Berechnung; manuelle Änderungen (Farbe entfernen, HEX ändern) löschen den Wert.
 */
export interface MatchDeltaE {
  /** Anzahl Steine (Teilstücke) dieser Farbe bei der Berechnung */
  pieces: number;
  /** mittleres ΔE (auf 0,01 gerundet) */
  mean: number;
  /** größtes ΔE (auf 0,01 gerundet) */
  max: number;
  /** Steine mit ΔE > 5 */
  over5: number;
  /** Steine mit ΔE > 10 */
  over10: number;
}

export interface PaletteColor {
  /** eindeutige, stabile Farbnummer im Projekt (01, 02, …) */
  code: number;
  /** gespeicherter Name (bei automatischen Namen in der Sprache der letzten Benennung) */
  name: string;
  hex: string;
  lab: Lab;
  materialId?: string;
  /**
   * Nur bei automatisch erzeugten Namen: sprachneutraler Schlüssel (src/core/colorNames.ts). Der Name folgt
   * dann der UI-Sprache (paletteDisplayName) und wird bei einer HEX-Änderung neu gebildet. Fehlt bei
   * Material- und Benutzernamen – die werden nie verändert.
   */
  nameKey?: string;
  /** Zusatz eines automatischen Namens zur Unterscheidung gleichnamiger Farben: hell/mittel/dunkel oder Nummer */
  nameSuffix?: NameSuffix;
  /**
   * Name vom Benutzer eingetippt (oder bewusst übernommen, z. B. ein Materialname): wird nie automatisch erkannt,
   * übersetzt oder verändert – auch wenn er einem automatischen Namen gleicht. Fehlt bei automatischen Namen.
   */
  userNamed?: boolean;
  /** Abweichung der Steine dieser Farbe vom Foto bei der Berechnung (siehe MatchDeltaE) */
  matchDeltaE?: MatchDeltaE;
  /** Nur „Automatisch → eigene Materialien“: Anzahl der Bildfarben (K-Means), die auf dieses Material zusammengelegt wurden */
  mergedFrom?: number;
  /** @deprecated nie gesetzt – siehe matchDeltaE */
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
