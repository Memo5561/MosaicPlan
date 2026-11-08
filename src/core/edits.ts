/**
 * Manuelle Änderungen am Mosaik (einzelne Steine, Formen, Palette, Fortschritt).
 */
import { deltaE, hexToLab, type ColorNameLang, type DeltaEFormula, type Lab } from './color';
import { autoColorName, legacyDescribeColor, nameKeyFor, uniqueAutoNames } from './colorNames';
import { area, bbox, cleanPoly, isConvex, isSimple, polygonDistance, triangulate, trianglesIntersectionArea, type Pt } from './geometry';
import type { Layout } from './layout';
import type { Range } from './stats';
import {
  cellPieceCount,
  cellPieces,
  cellRect,
  diagA,
  diagB,
  isDegeneratePiece,
  lineSplit,
  MIN_FREE_AREA_MM2,
  pieceCuttable,
  pieceWidthCheck,
  subdivisionCuttable,
  subRects,
  worstWidth,
  type WidthCheck,
} from './pieces';
import { CellKind, type CellKindValue, type FreePiece, type MatchDeltaE, type MosaicData, type PaletteColor } from './types';

export function setPieceColor(data: MosaicData, idx: number, piece: number, color: number): void {
  const kind = data.kind[idx];
  if (kind === CellKind.FULL) data.c1[idx] = color;
  else if (kind === CellKind.SUB) {
    const s = data.sub.get(idx);
    if (s && piece < s.length) s[piece] = color;
    if (piece === 0) data.c1[idx] = color;
  } else if (kind === CellKind.FREE) {
    const f = data.free.get(idx);
    if (f && f[piece]) f[piece].color = color;
  } else if (piece === 0) data.c1[idx] = color;
  else data.c2[idx] = color;
}

export interface KindChange {
  kind: CellKindValue;
  /** SUB */
  k?: 2 | 3;
  /** LINE: Winkel der Schnittlinien-Normalen in Grad und Abstand zur Zellmitte in mm */
  angleDeg?: number;
  offsetMm?: number;
}

/**
 * Fehlercodes von checkCellKind/setCellKind (Übersetzung unter `edit.err.<code>`):
 * - line-outside: die Schnittlinie trifft den Stein nicht (ein Teil wäre leer)
 * - diag-empty: die Fuge ist breiter als der Stein, ein Dreieck wäre leer
 * - too-small: ein Teil wäre schmaler als die Mindestbreite eines Schnittteils
 * - use-setFreePieces: Freiform nur über setFreePieces
 */
export type CellKindError = 'line-outside' | 'diag-empty' | 'too-small' | 'use-setFreePieces';

/** Parameter eines Kantenschnitts so, wie sie gespeichert werden (Float32), damit Prüfung = gespeicherte Geometrie. */
function lineParams(ch: KindChange): [number, number, number] {
  const a = ((ch.angleDeg ?? 0) * Math.PI) / 180;
  return [Math.fround(Math.cos(a)), Math.fround(Math.sin(a)), Math.fround(ch.offsetMm ?? 0)];
}

/**
 * Prüft eine Formänderung, ohne etwas zu verändern. Es gelten dieselben Regeln wie in der
 * automatischen Berechnung (pieceCuttable auf den exakten Teilpolygonen).
 */
export function checkCellKind(layout: Layout, row: number, col: number, ch: KindChange, minPieceMm: number): CellKindError | null {
  const r = cellRect(layout, row, col);
  switch (ch.kind) {
    case CellKind.FULL:
      return null;
    case CellKind.DIAG_A:
    case CellKind.DIAG_B: {
      const [p, q] = (ch.kind === CellKind.DIAG_A ? diagA : diagB)(r, layout.joint);
      if (cleanPoly(p).length < 3 || cleanPoly(q).length < 3) return 'diag-empty';
      if (!pieceCuttable(p, minPieceMm) || !pieceCuttable(q, minPieceMm)) return 'too-small';
      return null;
    }
    case CellKind.LINE: {
      const [nx, ny, d] = lineParams(ch);
      const [p, q] = lineSplit(r, nx, ny, d, layout.joint);
      if (p.length < 3 || q.length < 3) return 'line-outside';
      if (!pieceCuttable(p, minPieceMm) || !pieceCuttable(q, minPieceMm)) return 'too-small';
      return null;
    }
    case CellKind.SUB:
      return subdivisionCuttable(r, ch.k ?? 2, layout.joint, minPieceMm) ? null : 'too-small';
    case CellKind.FREE:
      return 'use-setFreePieces';
  }
  return null;
}

/**
 * Gemessene Breiten des schmalsten Teils, das eine Formänderung erzeugen würde (für ehrliche
 * Begründungen wie „Inkreismaß 1,93 mm < 2 mm“). null für ganze Steine und Freiform.
 */
export function cellKindWidth(layout: Layout, row: number, col: number, ch: KindChange, minPieceMm: number): WidthCheck | null {
  const r = cellRect(layout, row, col);
  switch (ch.kind) {
    case CellKind.DIAG_A:
    case CellKind.DIAG_B:
      return worstWidth((ch.kind === CellKind.DIAG_A ? diagA : diagB)(r, layout.joint), minPieceMm);
    case CellKind.LINE: {
      const [nx, ny, d] = lineParams(ch);
      return worstWidth(lineSplit(r, nx, ny, d, layout.joint), minPieceMm);
    }
    case CellKind.SUB:
      return worstWidth(subRects(r, ch.k ?? 2, layout.joint), minPieceMm);
    default:
      return null;
  }
}

/** Entspricht die Zelle bereits genau dieser Zellart mit denselben Parametern? */
export function sameCellKind(layout: Layout, data: MosaicData, row: number, col: number, ch: KindChange): boolean {
  const idx = row * layout.cols + col;
  if (data.kind[idx] !== ch.kind) return false;
  switch (ch.kind) {
    case CellKind.FULL:
    case CellKind.DIAG_A:
    case CellKind.DIAG_B:
      return true;
    case CellKind.SUB: {
      const s = data.sub.get(idx);
      return !!s && s.length === (ch.k ?? 2) ** 2;
    }
    case CellKind.LINE: {
      const prm = data.line.get(idx);
      if (!prm) return false;
      const [nx, ny, d] = lineParams(ch);
      return Math.abs(prm[0] - nx) < 1e-6 && Math.abs(prm[1] - ny) < 1e-6 && Math.abs(prm[2] - d) < 1e-6;
    }
    default:
      return false;
  }
}

/** Ergebnis von allowedCellKinds: null = möglich, sonst der Fehlercode (Grund). */
export interface AllowedCellKinds {
  full: null;
  diagA: CellKindError | null;
  diagB: CellKindError | null;
  sub2: CellKindError | null;
  sub3: CellKindError | null;
}

/**
 * Trockenlauf von setCellKind für die Formknöpfe im Steindetail (gleiche Prüfungen).
 * Die aktuelle Zellart wird dabei nicht bevorzugt: Ist z. B. eine gespeicherte Diagonale nach
 * heutiger Regel zu schmal, steht hier der Grund – ein erneuter Klick ändert sie aber nicht.
 */
export function allowedCellKinds(layout: Layout, _data: MosaicData, row: number, col: number, minPieceMm: number): AllowedCellKinds {
  return {
    full: null,
    diagA: checkCellKind(layout, row, col, { kind: CellKind.DIAG_A }, minPieceMm),
    diagB: checkCellKind(layout, row, col, { kind: CellKind.DIAG_B }, minPieceMm),
    sub2: checkCellKind(layout, row, col, { kind: CellKind.SUB, k: 2 }, minPieceMm),
    sub3: checkCellKind(layout, row, col, { kind: CellKind.SUB, k: 3 }, minPieceMm),
  };
}

/**
 * Ändert die Zellart; Farben werden sinnvoll übernommen. Liefert Fehlercode oder null.
 * Ist die Zelle bereits genau so geformt, bleibt alles unverändert – auch der Verlegestatus.
 */
export function setCellKind(layout: Layout, data: MosaicData, row: number, col: number, ch: KindChange, minPieceMm: number): CellKindError | null {
  const idx = row * layout.cols + col;
  if (sameCellKind(layout, data, row, col, ch)) return null;
  const err = checkCellKind(layout, row, col, ch, minPieceMm);
  if (err) return err;
  const before = cellPieces(layout, data, row, col);
  const colA = before[0]?.color ?? data.c1[idx];
  const colB = before[1]?.color ?? colA;
  if (ch.kind === CellKind.LINE) data.line.set(idx, new Float32Array(lineParams(ch)));
  if (ch.kind === CellKind.SUB) {
    const k = ch.k ?? 2;
    const arr = new Uint16Array(k * k);
    for (let i = 0; i < arr.length; i++) arr[i] = before[i]?.color ?? colA;
    data.sub.set(idx, arr);
  }
  if (ch.kind !== CellKind.LINE) data.line.delete(idx);
  if (ch.kind !== CellKind.SUB) data.sub.delete(idx);
  data.free.delete(idx);
  data.kind[idx] = ch.kind;
  data.c1[idx] = colA;
  data.c2[idx] = colB;
  data.progress[idx] = 0;
  return null;
}

/**
 * Repariert Zellen mit leeren Teilen (z. B. aus älteren Projekten, in denen eine Dreiecksteilung
 * trotz zu breiter Fuge gespeichert wurde): Diagonal-, Kantenschnitt- und Unterteilungszellen, von
 * denen ein Teil keine Fläche hat (oder deren Parameter fehlen), werden zu ganzen Steinen in der
 * Farbe des ersten Teils (c1); ihr Verlegestatus wird zurückgesetzt. Zellen, die nur schmaler als die Mindestbreite
 * sind, bleiben unverändert (die Mindestbreite ist eine Einstellung des Benutzers).
 * Liefert die Anzahl reparierter Zellen.
 */
export function repairDegenerateCells(layout: Layout, data: MosaicData): number {
  let n = 0;
  for (let row = 0; row < layout.rows; row++)
    for (let col = 0; col < layout.cols; col++) {
      const idx = row * layout.cols + col;
      const kind = data.kind[idx];
      if (kind !== CellKind.DIAG_A && kind !== CellKind.DIAG_B && kind !== CellKind.LINE && kind !== CellKind.SUB) continue;
      const missing = (kind === CellKind.LINE && !data.line.has(idx)) || (kind === CellKind.SUB && !data.sub.has(idx));
      const ps = cellPieces(layout, data, row, col);
      if (!missing && !ps.some((p) => isDegeneratePiece(p.poly))) continue;
      // Farbe des ersten Teils (bei Diagonale/Kantenschnitt = c1, bei Unterteilung = erster Teilstein)
      if (kind === CellKind.SUB && ps[0]) data.c1[idx] = ps[0].color;
      data.kind[idx] = CellKind.FULL;
      data.line.delete(idx);
      data.sub.delete(idx);
      data.progress[idx] = 0;
      n++;
    }
  return n;
}

/** Höchstzahl der Teile einer Freiformzelle (der Verlegestatus einer Zelle ist eine 16-Bit-Maske). */
export const MAX_FREE_PIECES = 16;
/** Kleinste zulässige Fläche eines Freiformteils in mm² (definiert in pieces.ts, dort auch für die Vorlagen). */
export { MIN_FREE_AREA_MM2 };
/** Schnittflächen bis zu dieser Größe (mm²) gelten als Berührung bzw. Rechenrauschen, nicht als Überlappung. */
export const FREE_OVERLAP_TOL_MM2 = 0.01;
/** Toleranz der Fugenprüfung in mm: eine Fuge gilt als zu schmal, wenn sie kleiner als Projektfuge − 0,01 mm ist. */
export const FREE_GAP_TOL_MM = 0.01;
/** Abstand zum Zellrand (mm), innerhalb dessen ein im Editor gesetzter Punkt auf den Rand einrastet. */
export const FREE_SNAP_EDGE_MM = 0.2;

/**
 * Ein Befund der Freiform-Prüfung. Teilnummern (`piece`, `a`, `b`) zählen ab 1 – wie „Teil 1“ in der
 * Oberfläche und wie die Steinkennungen A001-1, A001-2. Übersetzt unter `free.err.<code>` bzw. `free.warn.<code>`.
 */
export type FreeIssue =
  | { code: 'noPieces' }
  | { code: 'tooMany'; max: number; count: number }
  | { code: 'tooFewPoints'; piece: number; count: number }
  | { code: 'selfIntersect'; piece: number }
  | { code: 'outside'; piece: number }
  | { code: 'areaTooSmall'; piece: number; areaMm2: number; minMm2: number }
  /** exakte Schnittfläche zweier Teile (mm², > FREE_OVERLAP_TOL_MM2) */
  | { code: 'overlap'; a: number; b: number; areaMm2: number }
  /** Warnung: Teil erfüllt die Mindestbreite eines Schnittteils nicht (gemessene Werte, siehe pieceWidthCheck) */
  | { code: 'thin'; piece: number; minMm: number; caliperMm: number; incircleMm: number; convex: boolean }
  /** Warnung: kleinster Abstand zweier Teile (mm) ist kleiner als die Projektfuge; 0 = die Teile berühren sich */
  | { code: 'gap'; a: number; b: number; gapMm: number; jointMm: number };

export type FreeIssueCode = FreeIssue['code'];

export interface FreeValidation {
  /** true, wenn es keine Fehler gibt – Warnungen (thin, gap) verhindern das Speichern nicht */
  ok: boolean;
  errors: FreeIssue[];
  warnings: FreeIssue[];
}

/** Betroffene Teile eines Befunds als Index ab 0 (für die Hervorhebung im Editor). */
export function freeIssuePieces(issue: FreeIssue): number[] {
  if ('piece' in issue) return [issue.piece - 1];
  if ('a' in issue) return [issue.a - 1, issue.b - 1];
  return [];
}

/**
 * Prüft die Teile einer Freiformzelle (Polygone relativ zur oberen linken Zellecke, mm).
 *
 * Fehler (Speichern nicht möglich): kein Teil, mehr als 16 Teile, weniger als 3 Ecken, Selbstkreuzung oder
 * Selbstberührung, Ecke außerhalb der Zelle, Fläche < 0,25 mm², und zwei Teile, deren exakte Schnittfläche
 * (polygonIntersectionArea, auch für nicht-konvexe Teile) größer als 0,01 mm² ist.
 *
 * Warnungen: Teil schmaler als die Mindestbreite eines Schnittteils (pieceCuttable – bei nicht-konvexen Teilen
 * nur näherungsweise) und – bei `joint` > 0 – zwei Teile, deren kleinster Abstand (polygonDistance) kleiner als
 * `joint` − 0,01 mm ist (0 = sie berühren sich). Die Fuge ist bewusst nur eine Warnung: in Detailbereichen
 * darf man schmaler verfugen, und ältere gespeicherte Projekte lassen sich weiter öffnen und bearbeiten.
 * Teilpaare mit einem Fehler am Einzelteil (zu wenige Ecken, Selbstkreuzung) werden nicht verglichen.
 */
export function validateFreePieces(cellW: number, cellH: number, pieces: FreePiece[], minPieceMm: number, joint = 0): FreeValidation {
  const errors: FreeIssue[] = [];
  const warnings: FreeIssue[] = [];
  if (pieces.length === 0) errors.push({ code: 'noPieces' });
  if (pieces.length > MAX_FREE_PIECES) errors.push({ code: 'tooMany', max: MAX_FREE_PIECES, count: pieces.length });
  const polys = pieces.map((p) => cleanPoly(p.poly));
  const comparable = polys.map(() => false);
  polys.forEach((p, i) => {
    const piece = i + 1;
    if (p.length < 3) {
      errors.push({ code: 'tooFewPoints', piece, count: p.length });
      return;
    }
    const simple = isSimple(p);
    if (!simple) errors.push({ code: 'selfIntersect', piece });
    if (p.some((q) => q.x < -1e-6 || q.y < -1e-6 || q.x > cellW + 1e-6 || q.y > cellH + 1e-6)) errors.push({ code: 'outside', piece });
    comparable[i] = simple;
    // Fläche und Breite sind nur für einfache Polygone sinnvoll (eine Schleife hätte z. B. Fläche 0)
    if (!simple) return;
    const A = area(p);
    if (A < MIN_FREE_AREA_MM2) errors.push({ code: 'areaTooSmall', piece, areaMm2: A, minMm2: MIN_FREE_AREA_MM2 });
    else {
      const w = pieceWidthCheck(p, minPieceMm);
      if (!w.ok) warnings.push({ code: 'thin', piece, minMm: minPieceMm, caliperMm: w.caliper, incircleMm: w.incircle, convex: isConvex(p) });
    }
  });
  const gapLimit = joint - FREE_GAP_TOL_MM;
  // jedes Teil nur einmal in Dreiecke zerlegen (der Editor prüft bei jeder Zeigerbewegung)
  const tris = polys.map((p, i) => (comparable[i] ? triangulate(p) : []));
  const boxes = polys.map((p) => (p.length ? bbox(p) : null));
  for (let i = 0; i < polys.length; i++)
    for (let j = i + 1; j < polys.length; j++) {
      if (!comparable[i] || !comparable[j]) continue;
      const A = boxes[i]!;
      const B = boxes[j]!;
      const apart = A.maxX <= B.minX || B.maxX <= A.minX || A.maxY <= B.minY || B.maxY <= A.minY;
      const ov = apart ? 0 : trianglesIntersectionArea(tris[i], tris[j]);
      if (ov > FREE_OVERLAP_TOL_MM2) {
        errors.push({ code: 'overlap', a: i + 1, b: j + 1, areaMm2: ov });
        continue;
      }
      if (joint > 0) {
        const d = polygonDistance(polys[i], polys[j]);
        if (d < gapLimit) warnings.push({ code: 'gap', a: i + 1, b: j + 1, gapMm: d, jointMm: joint });
      }
    }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Rastet einen im Freiform-Editor gesetzten oder gezogenen Punkt (mm, relativ zur Zelle) ein: auf die Zelle
 * begrenzt, innerhalb von 0,2 mm genau auf den Zellrand, sonst auf 0,1 mm gerundet. Nur angeklickte und
 * gezogene Punkte werden so gerundet – vorgeladene oder als Vorlage erzeugte Teile behalten ihre exakten
 * Koordinaten (sonst würde z. B. die Fuge einer Diagonale schmaler).
 */
export function snapFreePoint(p: Pt, cellW: number, cellH: number): Pt {
  const ax = (v: number, max: number) => {
    const c = Math.min(max, Math.max(0, Number.isFinite(v) ? v : 0));
    if (c <= FREE_SNAP_EDGE_MM) return 0;
    if (max - c <= FREE_SNAP_EDGE_MM) return max;
    return Math.min(max, Math.max(0, Math.round(c * 10) / 10));
  };
  return { x: ax(p.x, cellW), y: ax(p.y, cellH) };
}

/** Koordinate relativ zur Zelle ohne Rechenrauschen der Subtraktion (0 und Zellmaß bleiben exakt). */
function relCoord(v: number, max: number): number {
  if (Math.abs(v) < 1e-9) return 0;
  if (Math.abs(v - max) < 1e-9) return max;
  return v;
}

/**
 * Teile einer Zelle für den Freiform-Editor, relativ zur oberen linken Zellecke und exakt (nicht gerundet):
 * gespeicherte Freiformteile unverändert, alle anderen Zellarten aus ihrer exakten Geometrie (cellPieces,
 * inkl. Fuge). Unverändert gespeichert ergeben sie dieselben Steine.
 */
export function freeEditorPieces(layout: Layout, data: MosaicData, row: number, col: number): FreePiece[] {
  const idx = row * layout.cols + col;
  const r = cellRect(layout, row, col);
  if (data.kind[idx] === CellKind.FREE) return (data.free.get(idx) ?? []).map((f) => ({ poly: f.poly.map((q) => ({ x: q.x, y: q.y })), color: f.color }));
  return cellPieces(layout, data, row, col).map((q) => ({
    poly: q.poly.map((pt) => ({ x: relCoord(pt.x - r.x, r.w), y: relCoord(pt.y - r.y, r.h) })),
    color: q.color,
  }));
}

/** Speichert Freiform-Teile in einer Zelle, wenn validateFreePieces (mit der Projektfuge) keinen Fehler findet. */
export function setFreePieces(layout: Layout, data: MosaicData, row: number, col: number, pieces: FreePiece[], minPieceMm: number): FreeValidation {
  const r = cellRect(layout, row, col);
  const v = validateFreePieces(r.w, r.h, pieces, minPieceMm, layout.joint);
  if (!v.ok) return v;
  const idx = row * layout.cols + col;
  data.kind[idx] = CellKind.FREE;
  data.free.set(
    idx,
    pieces.map((p) => ({ poly: cleanPoly(p.poly).map((q: Pt) => ({ x: q.x, y: q.y })), color: p.color })),
  );
  data.sub.delete(idx);
  data.line.delete(idx);
  data.c1[idx] = pieces[0].color;
  data.progress[idx] = 0;
  return v;
}

// ---------------- Fortschritt
export function togglePiecePlaced(data: MosaicData, idx: number, piece: number): boolean {
  data.progress[idx] ^= 1 << piece;
  return ((data.progress[idx] >> piece) & 1) === 1;
}

export function setCellPlaced(data: MosaicData, idx: number, placed: boolean): void {
  const n = cellPieceCount(data, idx);
  data.progress[idx] = placed ? (1 << n) - 1 : 0;
}

export function setRangePlaced(layout: Layout, data: MosaicData, rg: Range, placed: boolean): void {
  for (let r = rg.r0; r < rg.r1; r++) for (let c = rg.c0; c < rg.c1; c++) setCellPlaced(data, r * layout.cols + c, placed);
}

// ---------------- Palette
export function nextCode(palette: PaletteColor[]): number {
  return palette.reduce((m, p) => Math.max(m, p.code), 0) + 1;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
/** Lab wie in der Palette gespeichert (auf 0,01 gerundet) – Namen werden immer aus diesem Wert gebildet. */
const storedLab = (hex: string): Lab => {
  const l = hexToLab(hex);
  return [r2(l[0]), r2(l[1]), r2(l[2])];
};
const upperHex = (hex: string) => (hex.toUpperCase().startsWith('#') ? hex.toUpperCase() : `#${hex.toUpperCase()}`);

/**
 * Palette eines Projekts von vor Welle 2: kein Eintrag trägt einen Namensschlüssel (nameKey) oder die
 * Markierung „vom Benutzer benannt“ (userNamed). Nur in solchen Paletten werden automatische Namen am Text
 * erkannt – in neueren Paletten ist ein Name ohne Schlüssel immer ein Benutzer- oder Materialname.
 */
export function isLegacyPalette(palette: readonly PaletteColor[]): boolean {
  return !palette.some((p) => p.nameKey || p.userNamed);
}

/**
 * Schlüssel eines automatisch erzeugten Namens aus einem Projekt von vor Welle 2: nur, wenn der Name genau der
 * damaligen Benennung (legacyDescribeColor) dieser Farbe in DE, EN oder TR entspricht – das war das einzige
 * Schema, das ältere Projekte enthalten können. Nie für Material- oder Benutzernamen.
 */
export function legacyAutoKey(p: PaletteColor): string | null {
  if (p.nameKey || p.materialId || p.userNamed) return null;
  for (const lang of ['de', 'en', 'tr'] as const) if (p.name === legacyDescribeColor(p.lab, lang)) return nameKeyFor(p.lab);
  return null;
}

/**
 * Ist der Name dieser Palettenfarbe automatisch erzeugt (und darf daher neu gebildet/übersetzt werden)?
 * Ja bei gesetztem nameKey. Ohne nameKey nur in einer Palette von vor Welle 2 (`palette`, siehe
 * isLegacyPalette), wenn der Name genau der damaligen automatischen Benennung entspricht (legacyAutoKey).
 * Material- und Benutzernamen (userNamed) gelten nie als automatisch.
 */
export function isAutoNamed(p: PaletteColor, palette?: readonly PaletteColor[]): boolean {
  if (p.nameKey) return true;
  if (p.materialId || p.userNamed) return false;
  if (palette && !isLegacyPalette(palette)) return false;
  return legacyAutoKey(p) !== null;
}

/**
 * Fügt eine Farbe an (neue, noch nie vergebene Nummer). Ohne `name` wird der Name automatisch erzeugt
 * (nameKey) und mit den übrigen automatischen Namen eindeutig gemacht – dabei können gleichnamige
 * automatische Farben einen Zusatz (hell/dunkel, Nummer) erhalten. Ein übergebener Name bleibt genau so.
 */
export function addPaletteColor(palette: PaletteColor[], hex: string, name?: string, lang: ColorNameLang = 'de', materialId?: string): PaletteColor[] {
  const lab = storedLab(hex);
  const entry: PaletteColor = { code: nextCode(palette), hex: upperHex(hex), lab, name: name || '', materialId };
  // ein übergebener Name (Material- oder Benutzername) bleibt wörtlich – nie automatisch erkannt oder übersetzt
  if (name) return [...palette, { ...entry, userNamed: true }];
  entry.nameKey = nameKeyFor(lab);
  entry.name = autoColorName(lab, lang);
  return uniqueAutoNames([...palette, entry], lang);
}

function remapAll(data: MosaicData, map: (c: number) => number): void {
  for (let i = 0; i < data.c1.length; i++) {
    data.c1[i] = map(data.c1[i]);
    data.c2[i] = map(data.c2[i]);
  }
  for (const v of data.sub.values()) for (let q = 0; q < v.length; q++) v[q] = map(v[q]);
  for (const v of data.free.values()) for (const f of v) f.color = map(f.color);
}

/**
 * Exakt nächste verbleibende Farbe zu palette[index] (ΔE mit der Formel des Projekts, Vergleich mit jeder
 * Farbe; bei Gleichstand die niedrigere Position). -1, wenn es keine andere Farbe gibt.
 */
export function nearestOtherColor(palette: PaletteColor[], index: number, formula: DeltaEFormula = '2000'): number {
  const l = palette[index].lab;
  let best = -1;
  let bd = Infinity;
  for (let j = 0; j < palette.length; j++) {
    if (j === index) continue;
    const d = deltaE(formula, l, palette[j].lab);
    if (d < bd) {
      bd = d;
      best = j;
    }
  }
  return best;
}

/**
 * Entfernt eine Palettenfarbe. Alle Steine dieser Farbe erhalten `replacement`
 * oder – wenn nicht angegeben – die exakt nächstgelegene verbleibende Farbe (ΔE, siehe nearestOtherColor).
 * Die Palette selbst bleibt sonst unverändert (auch matchDeltaE: der Wert beschreibt die Berechnung; die
 * Anzeige prüft mit matchDeltaEValid, ob er noch zu den aktuellen Steinen passt).
 */
export function removePaletteColor(palette: PaletteColor[], data: MosaicData, index: number, replacement?: number, formula: DeltaEFormula = '2000'): PaletteColor[] {
  if (palette.length <= 1) throw new Error('Die letzte Farbe kann nicht entfernt werden.');
  let target = replacement;
  if (target === undefined || target === index) target = nearestOtherColor(palette, index, formula);
  const t = target;
  remapAll(data, (c) => {
    const v = c === index ? t : c;
    return v > index ? v - 1 : v;
  });
  return palette.filter((_, i) => i !== index);
}

/**
 * Ändert HEX, Name oder Material einer Farbe.
 *  - Ein übergebener Name ist ein Benutzername: nameKey/nameSuffix entfallen, die Farbe wird als „vom Benutzer
 *    benannt“ markiert (userNamed) und ihr Name wird nie mehr automatisch erkannt, übersetzt oder geändert –
 *    auch nicht, wenn er zufällig einem automatischen Namen gleicht (z. B. zweimal „Rot“).
 *  - Eine HEX-Änderung bildet den Namen einer automatisch benannten Farbe (isAutoNamed) neu und macht die
 *    automatischen Namen wieder eindeutig (Sprache `lang`); Benutzer- und Materialnamen bleiben.
 *    matchDeltaE (Abweichung vom Foto bei der Berechnung) passt danach nicht mehr und wird gelöscht.
 *  - Eine Material-Änderung lässt Name und Farbe unverändert. Wird die Verknüpfung einer Farbe mit
 *    Materialnamen gelöst, bleibt deren Name wörtlich (userNamed).
 */
export function updatePaletteColor(
  palette: PaletteColor[],
  index: number,
  patch: Partial<Pick<PaletteColor, 'hex' | 'name' | 'materialId'>>,
  lang: ColorNameLang = 'de',
): PaletteColor[] {
  let renamed = false;
  const out = palette.map((p, i) => {
    if (i !== index) return p;
    const { name, hex, ...rest } = patch;
    const next: PaletteColor = { ...p, ...rest };
    if (name !== undefined) {
      next.name = name;
      next.userNamed = true;
      delete next.nameKey;
      delete next.nameSuffix;
    } else if ('materialId' in patch && !patch.materialId && p.materialId && !p.nameKey) next.userNamed = true;
    if (hex) {
      const lab = storedLab(hex);
      next.hex = hex.toUpperCase();
      next.lab = lab;
      if (next.hex !== p.hex.toUpperCase() || lab.some((v, k) => v !== p.lab[k])) delete next.matchDeltaE;
      if (name === undefined && isAutoNamed(p, palette)) {
        next.nameKey = nameKeyFor(lab);
        delete next.nameSuffix;
        delete next.userNamed;
        next.name = autoColorName(lab, lang);
        renamed = true;
      }
    }
    return next;
  });
  return renamed ? uniqueAutoNames(out, lang) : out;
}

/** Setzt den Namen einer Farbe wieder auf den automatischen Namen (z. B. nach Leeren des Namensfelds). */
export function resetAutoName(palette: PaletteColor[], index: number, lang: ColorNameLang = 'de'): PaletteColor[] {
  const out = palette.map((p, i) => {
    if (i !== index) return p;
    const next: PaletteColor = { ...p, nameKey: nameKeyFor(p.lab), name: autoColorName(p.lab, lang) };
    delete next.nameSuffix;
    delete next.userNamed;
    return next;
  });
  return uniqueAutoNames(out, lang);
}

/**
 * Abweichung vom Foto (matchDeltaE) einer Farbe – nur, wenn sie noch zu den aktuellen Steinen passt:
 * seit der Berechnung keine manuelle Änderung an Steinen (manualEdits = 0) und dieselbe Stückzahl wie heute.
 * Sonst null (die Anzeige sagt dann „nicht mehr aktuell“ statt eine veraltete Zahl zu zeigen).
 */
export function matchDeltaEValid(p: PaletteColor, currentPieces: number | undefined, manualEdits: number): MatchDeltaE | null {
  const m = p.matchDeltaE;
  if (!m || manualEdits > 0 || currentPieces === undefined || m.pieces !== currentPieces) return null;
  return m;
}

/**
 * Bringt die automatischen Namen einer Palette auf den aktuellen Stand der Sprache `lang`:
 *  1. Nur bei Paletten von vor Welle 2 (isLegacyPalette, einmalige Übernahme): Farben ohne Material, deren Name
 *     genau der damaligen automatischen Benennung entspricht (legacyAutoKey), erhalten ihren Schlüssel und so
 *     den korrekten Namen (z. B. „Rot“ statt „Orange“); alle übrigen Farben ohne Material werden als
 *     „vom Benutzer benannt“ markiert. Danach ist die Palette keine ältere mehr – es wird nie wieder geraten.
 *  2. Alle automatischen Namen werden eindeutig gemacht und in `lang` gesetzt (uniqueAutoNames).
 * Benutzer- und Materialnamen bleiben unverändert. Liefert dasselbe Array, wenn sich nichts ändert.
 */
export function normalizePaletteNames(palette: PaletteColor[], lang: ColorNameLang): PaletteColor[] {
  let base = palette;
  if (isLegacyPalette(palette) && palette.some((p) => !p.materialId)) {
    base = palette.map((p) => {
      if (p.materialId) return p;
      const key = legacyAutoKey(p);
      if (!key) return { ...p, userNamed: true };
      const next: PaletteColor = { ...p, nameKey: key };
      delete next.nameSuffix;
      return next;
    });
  }
  return uniqueAutoNames(base, lang);
}

/** Ersetzt in einem Bereich (oder überall) Farbe a durch b. Gibt die Anzahl geänderter Steine zurück. */
export function replaceColor(layout: Layout, data: MosaicData, from: number, to: number, rg?: Range): number {
  const r = rg ?? { r0: 0, r1: layout.rows, c0: 0, c1: layout.cols };
  let n = 0;
  for (let row = r.r0; row < r.r1; row++)
    for (let col = r.c0; col < r.c1; col++) {
      const idx = row * layout.cols + col;
      const ps = cellPieces(layout, data, row, col);
      ps.forEach((p, i) => {
        if (p.color === from) {
          setPieceColor(data, idx, i, to);
          n++;
        }
      });
    }
  return n;
}

/** Benachbarte Zellen (oben, rechts, unten, links). */
export function neighbors(layout: Layout, row: number, col: number): { dir: 'N' | 'E' | 'S' | 'W'; row: number; col: number }[] {
  const res: { dir: 'N' | 'E' | 'S' | 'W'; row: number; col: number }[] = [];
  if (row > 0) res.push({ dir: 'N', row: row - 1, col });
  if (col < layout.cols - 1) res.push({ dir: 'E', row, col: col + 1 });
  if (row < layout.rows - 1) res.push({ dir: 'S', row: row + 1, col });
  if (col > 0) res.push({ dir: 'W', row, col: col - 1 });
  return res;
}
