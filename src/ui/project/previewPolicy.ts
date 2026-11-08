/**
 * Wann die Live-Vorschau (Schritte 2–7) von selbst rechnet und wie lange sie voraussichtlich braucht
 * (Paket w3-live-preview). Reine Logik, ohne DOM testbar.
 *
 * Die Vorschau ist eine vollständige, exakte Berechnung des ganzen Mosaiks (gleiche Eingaben, gleiche
 * Rechnung wie „Berechnen“) – deshalb kann „Übernehmen“ sie ohne zweite Berechnung speichern. Damit das
 * Bedienen flüssig bleibt, rechnet sie nur bei kleinen Mosaiken und schnellen Durchläufen von selbst;
 * sonst bietet sie „Vorschau aktualisieren“ mit einer geschätzten Dauer (Richtwert) an.
 */

/** Selbsttätig nur bis zu so vielen Rasterpositionen … */
export const PREVIEW_AUTO_CELLS = 60_000;
/** … auf langsamen Geräten (≤ 4 Kerne oder Touch-Bedienung) bis zu so vielen */
export const PREVIEW_AUTO_CELLS_SLOW = 30_000;
/** … und nur, solange die letzte Vorschau schneller war als (ms) */
export const PREVIEW_AUTO_MAX_MS = 1500;
/** Wartezeit nach der letzten Änderung (ms): Schaltflächen/Regler bzw. Eintippen von Zahlen */
export const PREVIEW_DEBOUNCE_MS = 500;
export const PREVIEW_DEBOUNCE_TYPING_MS = 800;

export type PreviewManualReason = 'cells' | 'slow';

export interface PreviewPolicy {
  /** true: rechnet nach jeder Änderung von selbst */
  auto: boolean;
  /** Grund, warum nur auf Knopfdruck gerechnet wird */
  reason: PreviewManualReason | null;
  /** geltende Grenze der Rasterpositionen */
  limit: number;
}

/** Langsames Gerät: höchstens 4 Kerne oder grobe Zeigereingabe (Touch). */
export function isSlowDevice(cores: number | undefined, coarsePointer: boolean): boolean {
  return coarsePointer || (typeof cores === 'number' && cores > 0 && cores <= 4);
}

export function previewPolicy(o: { cells: number; slow: boolean; lastMs: number | null }): PreviewPolicy {
  const limit = o.slow ? PREVIEW_AUTO_CELLS_SLOW : PREVIEW_AUTO_CELLS;
  if (o.cells > limit) return { auto: false, reason: 'cells', limit };
  if (o.lastMs !== null && o.lastMs >= PREVIEW_AUTO_MAX_MS) return { auto: false, reason: 'slow', limit };
  return { auto: true, reason: null, limit };
}

/**
 * Geschätzte Dauer einer Vorschau bzw. Berechnung in ms (Richtwert): aus der letzten gemessenen Rechnung
 * linear nach Rasterpositionen hochgerechnet, sonst aus Messungen am Desktop (≈ 0,25 s + 3 µs je Position,
 * Farbübergänge mischen bis dreifach), auf langsamen Geräten doppelt.
 */
export function estimatePreviewMs(cells: number, last: { ms: number; cells: number } | null, slow: boolean, dither = 0): number {
  if (last && last.cells > 0 && last.ms > 0) return Math.max(200, Math.round((last.ms * cells) / last.cells));
  const base = 250 + cells * 0.003 * (1 + 2 * Math.max(0, Math.min(1, dither)));
  return Math.round(slow ? base * 2 : base);
}

/** Wartezeit nach einer Änderung: länger, solange in ein Zahlenfeld getippt wird. */
export function previewDebounceMs(typing: boolean): number {
  return typing ? PREVIEW_DEBOUNCE_TYPING_MS : PREVIEW_DEBOUNCE_MS;
}

/** Phasen einer Berechnung; 'commit' = Ergebnis speichern (beim Übernehmen einer Vorschau die einzige Phase) */
export const COMPUTE_PHASES = ['prepare', 'adjust', 'lab', 'analyze', 'palette', 'assign', 'commit'] as const;

/** Gesamtfortschritt 0…1 einer Berechnung aus Phase und Anteil der Phase. */
export function computeOverall(p: { phase: string; fraction: number } | null): number {
  if (!p) return 0;
  const i = (COMPUTE_PHASES as readonly string[]).indexOf(p.phase);
  return Math.min(1, (Math.max(0, i) + Math.max(0, Math.min(1, p.fraction))) / COMPUTE_PHASES.length);
}

/** Ist dieses Element ein Eingabefeld, in das gerade getippt wird (nicht Regler/Schalter)? */
export function isTypingTarget(el: { tagName?: string; type?: string } | null | undefined): boolean {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const type = (el.type ?? 'text').toLowerCase();
  return !['range', 'checkbox', 'radio', 'button', 'submit', 'color', 'file'].includes(type);
}
