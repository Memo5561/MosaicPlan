/**
 * Gesichtsvorschläge (w4-face-detector) – reine Logik ohne DOM, getestet in tests/w4-face-detector.test.ts.
 *
 * Ein Vorschlag besteht aus der erkannten Box, der daraus abgeleiteten Gesichts-Ellipse (Stirn bis Kinn) und
 * einem Detailbereich über der Augenpartie. Die Augenpartie wird aus festen Anteilen der Box GESCHÄTZT
 * (es gibt keinen Augen-Detektor) – außer der Browser liefert Augenpunkte (FaceDetector-Landmarken).
 * Vorschläge werden nie gespeichert; erst „Übernehmen“ macht daraus Bereiche (suggestionRegions).
 */
import { faceConfidence, type FaceBox, type FaceConfidence } from '../../core/faceDetect';
import type { Region } from '../../core/types';
import { expandFaceBox } from './faceGuidance';

export type Rect = { x: number; y: number; w: number; h: number };

/** Woher ein Bereich stammt (zusätzliches, optionales Feld am gespeicherten Bereich; fehlt = von Hand gezeichnet). */
export type RegionOrigin = 'auto-face' | 'auto-eyes';
export type RegionWithOrigin = Region & { origin?: RegionOrigin };
export const regionOrigin = (r: Region): RegionOrigin | undefined => {
  const o = (r as RegionWithOrigin).origin;
  return o === 'auto-face' || o === 'auto-eyes' ? o : undefined;
};

/** 'native' = FaceDetector des Browsers, 'pico' = mitgelieferte Offline-Erkennung */
export type DetectSource = 'native' | 'pico';

export interface FaceSuggestion {
  id: string;
  source: DetectSource;
  /** Erkennungswert (nur pico), keine Wahrscheinlichkeit */
  score: number | null;
  /** Richtwert-Stufe aus dem Erkennungswert (nur pico) */
  confidence: FaceConfidence | null;
  /** erkannte Box (normiert auf das Editorbild) */
  box: Rect;
  /** vorgeschlagene Gesichts-Ellipse */
  face: Rect;
  /** vorgeschlagener Detailbereich Augenpartie */
  eyes: Rect;
  /** Augenpartie aus Augenpunkten des Browsers oder aus festen Anteilen geschätzt */
  eyesFrom: 'landmarks' | 'proportions';
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Rechteck auf das Bild begrenzen; null, wenn nichts übrig bleibt. */
export function clampRect(r: Rect): Rect | null {
  const x0 = clamp01(r.x);
  const y0 = clamp01(r.y);
  const x1 = clamp01(r.x + r.w);
  const y1 = clamp01(r.y + r.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * pico-Box (Quadrat in Pixeln) → Gesichts-Ellipse. Die facefinder-Box reicht etwa von der Stirn bis zu Mund
 * oder Kinn und von Wange zu Wange; die Ellipse (1,2 × 1,5 der Box, gleiche Mitte) nimmt Haaransatz, Ohren und
 * das Kinn sicher mit. In Bildanteilen: Breite und Höhe getrennt, weil das Bild nicht quadratisch sein muss.
 */
export function picoFaceEllipse(b: Rect): Rect {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const w = b.w * 1.2;
  const h = b.h * 1.5;
  return clampRect({ x: cx - w / 2, y: cy - h / 2, w, h }) ?? b;
}

/**
 * Augenpartie aus festen Anteilen der pico-Box: die Augen liegen bei etwa 42 % der Boxhöhe und 32 % / 68 % der
 * Breite (Augenposition der pico-Beispiele, r − 0,075·s, c ± 0,175·s). Band 12–88 % der Breite, 29–56 % der
 * Höhe – schließt Brauen und Augenwinkel ein. Bei geneigtem Kopf wird das Band höher, damit beide Augen darin
 * liegen. Eine Schätzung, kein Messergebnis.
 */
export function picoEyeBand(b: Rect, angleDeg = 0): Rect {
  const extra = Math.abs(Math.sin((angleDeg * Math.PI) / 180)) * 0.175; // halber Augenabstand × sin(Neigung) je Seite
  const y0 = b.y + b.h * (0.29 - extra);
  const y1 = b.y + b.h * (0.56 + extra);
  return clampRect({ x: b.x + b.w * 0.12, y: y0, w: b.w * 0.76, h: y1 - y0 }) ?? b;
}

/**
 * FaceDetector-Box → Augenpartie. Mit Augenpunkten (Landmarken) um diese herum, sonst aus festen Anteilen der
 * Box (Augen bei etwa 25–50 % der Höhe, 10–90 % der Breite).
 */
export function nativeEyeBand(b: Rect, eyes: { x: number; y: number }[] = []): { rect: Rect; from: 'landmarks' | 'proportions' } {
  if (eyes.length >= 2) {
    const xs = eyes.map((p) => p.x);
    const ys = eyes.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const span = Math.max(maxX - minX, b.w * 0.2);
    const midY = ys.reduce((a, v) => a + v, 0) / ys.length;
    const rect = clampRect({ x: minX - span * 0.45, y: Math.min(...ys) - span * 0.35, w: maxX - minX + span * 0.9, h: Math.max(...ys) - Math.min(...ys) + span * 0.6 });
    if (rect && midY > b.y && midY < b.y + b.h) return { rect, from: 'landmarks' };
  }
  return { rect: clampRect({ x: b.x + b.w * 0.1, y: b.y + b.h * 0.25, w: b.w * 0.8, h: b.h * 0.25 }) ?? b, from: 'proportions' };
}

/** Vorschlag aus einem pico-Treffer. */
export function picoSuggestion(f: FaceBox, id: string): FaceSuggestion {
  const box = { x: f.x, y: f.y, w: f.w, h: f.h };
  return { id, source: 'pico', score: f.score, confidence: faceConfidence(f.score), box, face: picoFaceEllipse(box), eyes: picoEyeBand(box, f.angle), eyesFrom: 'proportions' };
}

/** Vorschlag aus einem FaceDetector-Treffer (Box wie bisher erweitert, siehe expandFaceBox). */
export function nativeSuggestion(box: Rect, id: string, eyePoints: { x: number; y: number }[] = []): FaceSuggestion {
  const eyes = nativeEyeBand(box, eyePoints);
  return { id, source: 'native', score: null, confidence: null, box, face: expandFaceBox(box), eyes: eyes.rect, eyesFrom: eyes.from };
}

/** „Übernehmen“: Gesichts-Ellipse und Detailbereich Augenpartie als neue Bereiche (mit Herkunft). */
export function suggestionRegions(s: FaceSuggestion, newId: () => string): RegionWithOrigin[] {
  return [
    { id: newId(), type: 'face', shape: 'ellipse', ...s.face, origin: 'auto-face' },
    { id: newId(), type: 'detail', shape: 'ellipse', ...s.eyes, origin: 'auto-eyes' },
  ];
}

/** Ist ein Vorschlag schon durch einen vorhandenen Gesichtsbereich abgedeckt? (Mitte liegt darin) */
export function coveredByRegion(s: FaceSuggestion, regions: readonly Region[]): boolean {
  const cx = s.box.x + s.box.w / 2;
  const cy = s.box.y + s.box.h / 2;
  return regions.some((r) => r.type === 'face' && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
}

// ---------- Verschieben und Größe ändern

export type Handle = 'nw' | 'ne' | 'sw' | 'se';

/** Mindestgröße eines Bereichs beim Ziehen (Bildanteil; zusätzlich gilt beim Loslassen MIN_REGION_PX) */
export const MIN_EDIT_FRAC = 0.02;

/** Bereich um (dx, dy) verschieben, ganz im Bild. */
export function moveRect(r: Rect, dx: number, dy: number): Rect {
  return { x: Math.min(1 - r.w, Math.max(0, r.x + dx)), y: Math.min(1 - r.h, Math.max(0, r.y + dy)), w: r.w, h: r.h };
}

/**
 * Ecke `h` auf den Punkt (px, py) ziehen; die gegenüberliegende Ecke bleibt fest. Ganz im Bild, mindestens
 * minW × minH (Bildanteile).
 */
export function resizeRect(r: Rect, h: Handle, px: number, py: number, minW = MIN_EDIT_FRAC, minH = minW): Rect {
  const x = clamp01(px);
  const y = clamp01(py);
  let x0 = r.x;
  let y0 = r.y;
  let x1 = r.x + r.w;
  let y1 = r.y + r.h;
  if (h === 'nw' || h === 'sw') x0 = Math.min(x, x1 - minW);
  else x1 = Math.max(x, x0 + minW);
  if (h === 'nw' || h === 'ne') y0 = Math.min(y, y1 - minH);
  else y1 = Math.max(y, y0 + minH);
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(1, x1);
  y1 = Math.min(1, y1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Ecke eines Bereichs (Bildanteile) */
export function cornerOf(r: Rect, h: Handle): [number, number] {
  return [h === 'nw' || h === 'sw' ? r.x : r.x + r.w, h === 'nw' || h === 'ne' ? r.y : r.y + r.h];
}

/** Liegt der Punkt im Bereich (Ellipse oder Rechteck)? */
export function regionContains(r: Pick<Region, 'shape' | 'x' | 'y' | 'w' | 'h'>, x: number, y: number): boolean {
  if (r.shape === 'ellipse') {
    const dx = (x - (r.x + r.w / 2)) / (r.w / 2);
    const dy = (y - (r.y + r.h / 2)) / (r.h / 2);
    return dx * dx + dy * dy <= 1;
  }
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** Bereich unter dem Punkt; bei verschachtelten Bereichen der kleinste (z. B. Augenpartie im Gesicht). */
export function regionAt<T extends Pick<Region, 'shape' | 'x' | 'y' | 'w' | 'h'>>(regions: readonly T[], x: number, y: number): T | null {
  let best: T | null = null;
  for (const r of regions) if (regionContains(r, x, y) && (!best || r.w * r.h < best.w * best.h)) best = r;
  return best;
}

/** Tastatur: Pfeiltaste verschiebt (oder mit Umschalt: ändert die Größe) um `step` Bildanteile. */
export function nudgeRect(r: Rect, key: string, resize: boolean, step = 0.01): Rect | null {
  const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  const v = d[key];
  if (!v) return null;
  if (!resize) return moveRect(r, v[0], v[1]);
  const w = Math.min(1 - r.x, Math.max(MIN_EDIT_FRAC, r.w + v[0]));
  const h = Math.min(1 - r.y, Math.max(MIN_EDIT_FRAC, r.h + v[1]));
  return { x: r.x, y: r.y, w, h };
}
