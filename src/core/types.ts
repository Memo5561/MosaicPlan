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
  /**
   * Fotofarbe jedes Steins aus der Berechnung (siehe PhotoTargets) – Grundlage der Abweichung Foto ↔ Stein
   * (src/core/deviation.ts). Fehlt bei Rastern, die vor dieser Funktion berechnet wurden; dann ist keine Abweichung je
   * Stein bekannt (nie geschätzt) – eine neue Berechnung ergänzt sie.
   */
  targets?: PhotoTargets;
}

/**
 * Fotofarben (Zielfarben) der Steine, gemessen bei der Berechnung: je Stein der Mittelwert der Fotopixel unter dem
 * Stein, auf den die Farbzuordnung zielt (die eigene, unvermischte Farbe – vor einer Farbmischung). Damit lässt sich
 * die Abweichung jederzeit neu rechnen, und zwar gegen die AKTUELLE Farbe des Steins: auch nach manuellen Änderungen
 * oder geänderten Palettenfarben (src/core/deviation.ts).
 *
 * Es sind genau die Werte, gegen die die Berechnung selbst gemessen hat – für ein unverändertes Raster ergibt die
 * Abweichung deshalb exakt die Zahlen der Berechnung (ComputeDiagnostics.meanDeltaE/maxDeltaE, MatchDeltaE je Farbe):
 *  - ganze Steine und Zweiteiler: L*a*b* auf dem Speicherraster der Berechnung, 3 Byte je Farbe
 *    (L*·2,55 · a*+128 · b*+128, gerundet) – mit diesen gerundeten Werten ordnet die Berechnung die Farben zu;
 *  - k×k-Teilsteine: L*a*b* als Float32 (ungerundet), wie die Berechnung sie verwendet.
 *
 * Unveränderlich: Nach der Berechnung wird nichts davon geändert (Kopien dürfen die Felder gemeinsam benutzen).
 * Eine Fotofarbe gilt nur für die Form, für die sie gemessen wurde. Wurde die Form einer Zelle seitdem geändert
 * (andere Zellart, andere Schnittgerade, andere k×k-Teilung, Freiform), haben ihre Steine keine Fotoreferenz mehr –
 * `kind`, `line` und `subLen` halten dafür die Form der Berechnung fest. Wird die Form wiederhergestellt
 * (Rückgängig oder dieselbe Form erneut gewählt), gilt die Fotofarbe wieder.
 *
 * Speicherbedarf: 4 Byte je Zelle + 15 Byte je Zweiteiler + (1 + 12·k²) Byte je k×k-Zelle.
 */
export interface PhotoTargets {
  /** Zellart bei der Berechnung (FULL, DIAG_A, DIAG_B, LINE oder SUB – nie FREE), 1 Byte je Zelle */
  kind: Uint8Array;
  /** Fotofarbe des ganzen Steins bzw. von Teil 1 eines Zweiteilers, 3 Byte je Zelle (bei k×k-Zellen unbenutzt) */
  lab1: Uint8Array;
  /** Fotofarbe von Teil 2 der Zweiteiler (kind DIAG_A/DIAG_B/LINE), in Zellreihenfolge, 3 Byte je Zweiteiler */
  lab2: Uint8Array;
  /** Schnittgerade [nx, ny, d] je Zweiteiler bei der Berechnung, in Zellreihenfolge (Diagonalen: 0, 0, 0) */
  line: Float32Array;
  /** Anzahl Teilsteine (k²) je k×k-Zelle (kind SUB), in Zellreihenfolge */
  subLen: Uint8Array;
  /** Fotofarben der Teilsteine aller k×k-Zellen hintereinander (Zellreihenfolge, je Zelle zeilenweise): L*, a*, b* je Teilstein */
  subLab: Float32Array;
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
  /**
   * Nur „Automatisch → eigene Materialien“ beim Verfahren Bildfarbe → nächstes Material ('nearest' oder Schutz der
   * Auswahl gegriffen): Anzahl der Bildfarben (K-Means), die auf dieses Material zusammengelegt wurden. Bei der direkten
   * Auswahl aus dem Bestand nicht gesetzt – dort wird nichts zusammengelegt.
   */
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
  /**
   * Schnitte außerhalb markierter Bereiche (1 = viele … 6 = wenige): Gibt es mindestens einen Gesichts- oder
   * Detailbereich, wird der Schnittaufwand λ jeder Zelle außerhalb ALLER Bereiche mit diesem Faktor multipliziert;
   * über 1 gibt es dort außerdem keine feineren Steine (k×k) mehr. Ohne Bereiche ohne Wirkung. Fehlt = 1 – ältere
   * Projekte und ihr Berechnungsschlüssel bleiben unverändert (Feld nur setzen, wenn ≠ 1).
   */
  bgCutFactor?: number;
  /**
   * Konturen durchgehend schneiden: Kantenschnitte, deren Linie über die Fuge in den bereits gewählten Kantenschnitt
   * des linken/oberen Nachbarn weiterläuft, werden bevorzugt (gleiche 15°-Winkel, gleiches 0,5-mm-Versatzraster).
   * Fehlt/false = aus (Feld nur setzen, wenn true).
   */
  contourContinuity?: boolean;
}

/**
 * Formoptionen, die nur gesetzt werden, wenn sie vom Standard abweichen (fehlt = Standard). „Änderungen verwerfen“
 * entfernt sie, wenn der Berechnungsschlüssel sie nicht enthält.
 */
export const OPTIONAL_SHAPE_FIELDS = ['bgCutFactor', 'contourContinuity'] as const;

/**
 * Formoptionen in fester Reihenfolge (für den Berechnungsschlüssel): alle übrigen Felder in ihrer bisherigen
 * Reihenfolge, danach die nur bei Abweichung gesetzten Felder in der Reihenfolge von OPTIONAL_SHAPE_FIELDS.
 * Entfernen und erneutes Setzen eines dieser Felder (Schieberegler auf ×1 und zurück, „Zurücksetzen“) hängt es
 * hinten an – ohne feste Reihenfolge wäre derselbe Stand dann ein anderer Schlüssel („geändert“). Schlüssel ohne
 * die neuen Felder bleiben Zeichen für Zeichen gleich.
 */
export function canonShapes<T extends object>(sh: T): T {
  const src = sh as Record<string, unknown>;
  const opt = OPTIONAL_SHAPE_FIELDS as readonly string[];
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) if (!opt.includes(k)) out[k] = src[k];
  for (const k of opt) if (k in src) out[k] = src[k];
  return out as T;
}

/**
 * Formoptionen ändern. Die nur bei Abweichung gespeicherten Felder (bgCutFactor > 1, contourContinuity = true) werden
 * beim Standardwert entfernt – so bleibt der Berechnungsschlüssel älterer Projekte Zeichen für Zeichen gleich.
 */
export function withShapeOption(sh: ShapeOptions, patch: Partial<ShapeOptions>): ShapeOptions {
  const next: ShapeOptions = { ...sh, ...patch };
  if (!(typeof next.bgCutFactor === 'number' && Number.isFinite(next.bgCutFactor) && next.bgCutFactor > 1)) delete next.bgCutFactor;
  if (next.contourContinuity !== true) delete next.contourContinuity;
  return next;
}

/** Größter Wert für ShapeOptions.bgCutFactor („wenige Schnitte“) */
export const BG_CUT_FACTOR_MAX = 6;
/** Voreinstellung „Schnitte auf Gesicht konzentrieren“ */
export const BG_CUT_FACTOR_FOCUS = 3;

/** Wirksamer Faktor für Schnitte außerhalb markierter Bereiche (1 … BG_CUT_FACTOR_MAX; fehlt/ungültig = 1). */
export function bgCutFactorOf(shapes: Pick<ShapeOptions, 'bgCutFactor'>): number {
  const f = shapes.bgCutFactor;
  if (typeof f !== 'number' || !Number.isFinite(f)) return 1;
  return Math.max(1, Math.min(BG_CUT_FACTOR_MAX, f));
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
  /**
   * Pflichtfarben (vom Benutzer bestätigte Akzentfarben, z. B. Schwarz für Pupillen): In den Modi „Automatisch aus dem
   * Foto“ und „Meine Steine – begrenzte Farbanzahl“ kommen sie unverändert in die Palette (K-Means bestimmt nur die
   * übrigen Farben; bei Materialien das nächste Material). Bekommt eine Pflichtfarbe keinen Stein, fällt sie weg.
   * `name` ist nur eine Notiz für die Liste. Fehlt/leer = keine (Berechnungsschlüssel älterer Projekte unverändert).
   */
  pinnedColors?: { hex: string; name?: string }[];
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
  /**
   * Herkunft des Farbwerts `hex` (Vertrag für Welle 6, „Farbe messen“): 'manual' = eingetippt, 'eyedropper' = Pipette,
   * 'photo' = aus einem Kamerafoto gemessen – eine Näherung, nie kalibriert. `measuredAt` (ISO-Datum), `reference`
   * (Weiß-/Graureferenz bei der Messung) und `spreadDE` (Streuung der Messfläche in ΔE) nur bei Messungen.
   * Fehlt = unbekannt (ältere Materialien).
   */
  colorSource?: { kind: 'manual' | 'eyedropper' | 'photo'; measuredAt?: string; reference?: 'none' | 'white' | 'grey'; spreadDE?: number };
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
  // Farbübergänge mischen: nur ähnliche Farbtöne (siehe DITHER_TOLERANCE in color.ts) – weichere Verläufe ohne
  // fremde Farbtupfer, dafür mehr Farbwechsel beim Legen. Gilt nur für neue Projekte (gespeicherte behalten ihren Wert).
  dither: 0.5,
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
