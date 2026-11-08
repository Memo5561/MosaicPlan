/**
 * Regeln für das Antippen im Mosaik-Viewer (ohne DOM, getestet in tests/w1-touch-input-safety.test.ts).
 *
 * Auf dem Handy ist ein 5-mm-Stein in der Gesamtansicht nur etwa 6 CSS-px groß; eine Fingerkuppe deckt
 * Dutzende Steine ab. Ein Finger-/Stift-Tippen wählt deshalb nur dann einen Stein (bzw. verlegt ihn),
 * wenn er auf dem Bildschirm groß genug ist. Sonst wird erst um den Tippunkt herangezoomt.
 * Die Maus ist präzise und bleibt unverändert.
 */
import type { Pt } from '../../core/geometry';

/** Antippen: maximale Bewegung (CSS-px), bis aus dem Tippen ein Verschieben wird */
export const TAP_SLOP_MOUSE_PX = 5;
export const TAP_SLOP_TOUCH_PX = 10;
/** Finger/Stift länger gedrückt → kein Antippen (verhindert versehentliches Verlegen beim Ablegen des Fingers) */
export const LONG_PRESS_MS = 500;
/** Finger/Stift: Steine, die auf dem Bildschirm kleiner sind, werden nicht angetippt, sondern erst herangezoomt */
export const MIN_TOUCH_TARGET_PX = 28;
/** Zielgröße des angetippten Steins nach dem automatischen Hineinzoomen */
export const TOUCH_ZOOM_TARGET_PX = 40;
/** größter Maßstab des Viewers (CSS-px je mm) */
export const MAX_SCALE = 120;

/** Kleinere Seite des umschließenden Rechtecks eines Teilstücks in mm */
export function pieceMinSideMm(poly: Pt[]): number {
  if (!poly.length) return 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.min(maxX - minX, maxY - minY);
}

export type TapDecision = { pick: true } | { pick: false; zoom: number };

/**
 * Entscheidung für ein erkanntes Antippen (ohne Bewegung, nicht zu lang).
 * Maus: immer auswählen. Finger/Stift: auswählen, wenn der Stein auf dem Bildschirm mindestens
 * MIN_TOUCH_TARGET_PX groß ist oder nicht weiter gezoomt werden kann; sonst den Zoomfaktor liefern,
 * mit dem der Stein etwa TOUCH_ZOOM_TARGET_PX groß wird (begrenzt auf maxScale).
 */
export function tapDecision(pointerType: string, pieceMinMm: number, scale: number, maxScale = MAX_SCALE): TapDecision {
  if (pointerType === 'mouse') return { pick: true };
  const px = pieceMinMm * scale;
  if (!(px > 0) || px >= MIN_TOUCH_TARGET_PX || scale >= maxScale * 0.999) return { pick: true };
  return { pick: false, zoom: Math.min(TOUCH_ZOOM_TARGET_PX / px, maxScale / scale) };
}

/** Tippen oder schon Verschieben? */
export function exceedsTapSlop(pointerType: string, dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > (pointerType === 'mouse' ? TAP_SLOP_MOUSE_PX : TAP_SLOP_TOUCH_PX);
}

/** Zählt ein Loslassen nach `heldMs` noch als Antippen? (lange Finger-/Stiftdrücke nicht; Maus immer) */
export function isTapDuration(pointerType: string, heldMs: number): boolean {
  return pointerType === 'mouse' || heldMs <= LONG_PRESS_MS;
}
