/**
 * Detailgrad und Gesichtsauflösung (w3-face-guidance) – reine Logik ohne DOM, getestet in
 * tests/w3-face-guidance.test.ts.
 *
 * Alle Zahlen (Spalten, Zeilen, Rasterpositionen, Fugenanteil, Steine über das Gesicht) kommen exakt aus
 * computeLayout bzw. regionCellSpan. Nur die Ampel-Schwellen sind ein Richtwert und werden so beschriftet.
 */
import { computeLayout, isLayoutError, jointShareOf, regionCellSpan, type LayoutError, type LayoutParams, type RegionSpan } from '../../core/layout';
import type { ProjectSettings, Region } from '../../core/types';

/** Richtwert: unter so vielen Steinen über die Gesichtsbreite gehen Gesichtszüge leicht verloren */
export const FACE_RED_BELOW = 16;
/** Richtwert: ab so vielen Steinen über die Gesichtsbreite bleiben Augen und Mund gut erhalten */
export const FACE_GREEN_FROM = 30;
/** Markierung in der Vergleichstabelle: Fugenanteil über 35 % … */
export const HIGH_JOINT_SHARE = 0.35;
/** … oder Steine unter 4 mm */
export const TINY_TILE_MM = 4;

export type FaceLight = 'red' | 'yellow' | 'green';

export function faceLight(across: number): FaceLight {
  return across < FACE_RED_BELOW ? 'red' : across < FACE_GREEN_FROM ? 'yellow' : 'green';
}

export function faceRegionsOf(regions: readonly Region[]): Region[] {
  return regions.filter((r) => r.type === 'face');
}

export interface FaceSpanInfo {
  span: RegionSpan;
  /** Index des Bereichs in rec.regions (für „Bereich n“) */
  index: number;
  /** Anzahl der Gesichtsbereiche insgesamt */
  count: number;
}

/**
 * Das Gesicht mit den wenigsten Steinen über die Breite (bei mehreren Gesichtern entscheidet das kleinste,
 * es verliert zuerst seine Züge). null ohne Gesichtsbereich.
 */
export function smallestFaceSpan(layout: Parameters<typeof regionCellSpan>[0], regions: readonly Region[]): FaceSpanInfo | null {
  let span: RegionSpan | null = null;
  let index = -1;
  let count = 0;
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    if (r.type !== 'face') continue;
    count++;
    const s = regionCellSpan(layout, r);
    if (!span || s.cols < span.cols || (s.cols === span.cols && s.rows < span.rows)) {
      span = s;
      index = i;
    }
  }
  return span ? { span, index, count } : null;
}

export type TradeoffKind = 'current' | 'tile' | 'width';

export interface TradeoffRow {
  key: string;
  kind: TradeoffKind;
  /** Steinmaß dieser Zeile (mm) */
  tileW: number;
  tileH: number;
  /** angefragte Mosaikgröße dieser Zeile (mm) */
  widthMm: number;
  heightMm: number;
  /** Faktor der Größe (nur 'width') */
  factor?: number;
  /** Änderung der Einstellungen beim Übernehmen (leer für die aktuelle Zeile) */
  patch: Partial<ProjectSettings>;
  /** entspricht den aktuellen Einstellungen */
  isCurrent: boolean;
  /** exakte Werte aus computeLayout – oder der Rasterfehler */
  result:
    | { ok: true; cols: number; rows: number; cells: number; jointShare: number; finishedW: number; finishedH: number; face: RegionSpan | null; light: FaceLight | null; highJoint: boolean; tiny: boolean }
    | { ok: false; error: LayoutError | Error };
}

/** Quadratische Steingrößen der Vergleichstabelle (bei der aktuellen Mosaikgröße) */
export const TRADEOFF_TILES = [4, 5, 6, 8, 10, 12] as const;
/** Größenfaktoren der Vergleichstabelle (beim aktuellen Steinmaß, Seitenverhältnis bleibt) */
export const TRADEOFF_FACTORS = [1.5, 2] as const;

/** Gleitkomma-Rauschen entfernen (z. B. 300,1 × 1,5 = 450,15000000000003) */
const clean = (v: number) => Math.round(v * 1e6) / 1e6;

function evaluate(p: LayoutParams, faces: readonly Region[]): TradeoffRow['result'] {
  try {
    const L = computeLayout(p);
    let face: RegionSpan | null = null;
    for (const r of faces) {
      const s = regionCellSpan(L, r);
      if (!face || s.cols < face.cols || (s.cols === face.cols && s.rows < face.rows)) face = s;
    }
    const jointShare = jointShareOf(L);
    return {
      ok: true,
      cols: L.cols,
      rows: L.rows,
      cells: L.cols * L.rows,
      jointShare,
      finishedW: L.finishedW,
      finishedH: L.finishedH,
      face,
      light: face ? faceLight(face.cols) : null,
      highJoint: jointShare > HIGH_JOINT_SHARE,
      tiny: Math.min(p.tileW, p.tileH) < TINY_TILE_MM,
    };
  } catch (e) {
    return { ok: false, error: isLayoutError(e) ? e : e instanceof Error ? e : new Error(String(e)) };
  }
}

/**
 * Vergleichstabelle: aktuelle Einstellung, Steine 4/5/6/8/10/12 mm bei der aktuellen Größe und das aktuelle
 * Steinmaß bei 1,5- und 2-facher Größe (Breite UND Höhe, damit Zuschnitt und Bereiche gleich bleiben).
 * Fuge, Randmodus und kleinste Randsteinbreite bleiben wie eingestellt. Jede Zahl exakt aus computeLayout.
 */
export function tradeoffRows(s: Pick<ProjectSettings, 'widthMm' | 'heightMm' | 'tileW' | 'tileH' | 'joint' | 'edgeMode' | 'minCutMm'>, regions: readonly Region[]): TradeoffRow[] {
  const faces = faceRegionsOf(regions);
  const base: LayoutParams = { widthMm: s.widthMm, heightMm: s.heightMm, tileW: s.tileW, tileH: s.tileH, joint: s.joint, edgeMode: s.edgeMode, minCutMm: s.minCutMm };
  const rows: TradeoffRow[] = [
    { key: 'current', kind: 'current', tileW: s.tileW, tileH: s.tileH, widthMm: s.widthMm, heightMm: s.heightMm, patch: {}, isCurrent: true, result: evaluate(base, faces) },
  ];
  for (const v of TRADEOFF_TILES) {
    if (v === s.tileW && v === s.tileH) continue; // steht schon als „aktuell“ oben
    rows.push({ key: `tile-${v}`, kind: 'tile', tileW: v, tileH: v, widthMm: s.widthMm, heightMm: s.heightMm, patch: { tileW: v, tileH: v }, isCurrent: false, result: evaluate({ ...base, tileW: v, tileH: v }, faces) });
  }
  for (const f of TRADEOFF_FACTORS) {
    const w = clean(s.widthMm * f);
    const h = clean(s.heightMm * f);
    rows.push({ key: `width-${f}`, kind: 'width', factor: f, tileW: s.tileW, tileH: s.tileH, widthMm: w, heightMm: h, patch: { widthMm: w, heightMm: h }, isCurrent: false, result: evaluate({ ...base, widthMm: w, heightMm: h }, faces) });
  }
  return rows;
}

/** Größe des Teilsteins bei k×k-Unterteilung einer ganzen Rasterzelle: (w − (k−1)·g) / k (wie in StepShapes). */
export function subStoneSize(tile: number, joint: number, k: number): number {
  return (tile - (k - 1) * joint) / k;
}

/** Mindestgröße eines gezeichneten Bereichs auf dem Bildschirm (CSS-Pixel je Seite). */
export const MIN_REGION_PX = 24;

/** Gezogener Bereich groß genug? (Breite und Höhe auf dem Bildschirm jeweils mindestens MIN_REGION_PX) */
export function regionLargeEnough(r: { w: number; h: number }, screenW: number, screenH: number): boolean {
  return r.w * screenW >= MIN_REGION_PX && r.h * screenH >= MIN_REGION_PX;
}

/**
 * Soll ein pointerdown einen neuen Bereich beginnen? Finger nur im Zeichenmodus (sonst scrollt die Seite),
 * Maus (nur linke Taste) und Stift immer. Nur der primäre Zeiger.
 */
export function startsDrawing(e: { pointerType: string; isPrimary: boolean; button: number }, drawMode: boolean): boolean {
  if (!e.isPrimary) return false;
  if (e.pointerType === 'mouse') return e.button === 0;
  if (e.pointerType === 'touch') return drawMode;
  return true;
}

/** Ausdehnung einer erkannten Gesichtsbox auf Stirn, Haare und Kinn (wie bisher), auf das Bild begrenzt. */
export function expandFaceBox(f: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } {
  const x = Math.max(0, f.x - f.w * 0.15);
  const y = Math.max(0, f.y - f.h * 0.25);
  return { x, y, w: Math.min(1 - x, f.w * 1.3), h: Math.min(1 - y, f.h * 1.45) };
}
