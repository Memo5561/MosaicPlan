/**
 * Pflichtfarben (ProjectSettings.pinnedColors) – reine Hilfsfunktionen für Schritt 5 und 7 (w4-cut-placement-accents).
 * Die Berechnung selbst liegt in src/core/mosaic.ts (normalizePinned, diagnostics.pinnedColors).
 */
import { isValidHex } from '../../core/color';
import type { ComputeDiagnostics, PinnedColorResult } from '../../core/mosaic';
import type { PaletteMode, ProjectSettings } from '../../core/types';

export type PinnedList = NonNullable<ProjectSettings['pinnedColors']>;

/** Modi, in denen Pflichtfarben wirken */
export function pinnedApplies(mode: PaletteMode): boolean {
  return mode === 'auto' || mode === 'auto-snap';
}

/** „#abc“, „aabbcc“, „ #AaBbCc “ → „#AABBCC“; ungültig → null. */
export function normalizeHexInput(v: string): string | null {
  const s = v.trim();
  if (!isValidHex(s)) return null;
  let h = s.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return `#${h.toUpperCase()}`;
}

export type PinAddResult = { ok: true; list: PinnedList; hex: string } | { ok: false; reason: 'invalid' | 'dup'; hex?: string };

/** Pflichtfarbe ergänzen (HEX normalisiert, keine Doppelten). Die Liste wird nie verändert, sondern neu gebildet. */
export function addPinned(list: PinnedList | undefined, hexIn: string, name?: string): PinAddResult {
  const hex = normalizeHexInput(hexIn);
  if (!hex) return { ok: false, reason: 'invalid' };
  const cur = list ?? [];
  if (cur.some((p) => p.hex.toUpperCase() === hex)) return { ok: false, reason: 'dup', hex };
  const note = name?.trim();
  return { ok: true, hex, list: [...cur, note ? { hex, name: note } : { hex }] };
}

/** Pflichtfarbe entfernen; leere Liste → undefined (der Berechnungsschlüssel bleibt dann wie ohne Pflichtfarben). */
export function removePinned(list: PinnedList | undefined, hex: string): PinnedList | undefined {
  const h = hex.toUpperCase();
  const next = (list ?? []).filter((p) => p.hex.toUpperCase() !== h);
  return next.length ? next : undefined;
}

/** Notiz einer Pflichtfarbe ändern (leer = keine Notiz). */
export function renamePinned(list: PinnedList | undefined, hex: string, name: string): PinnedList | undefined {
  const h = hex.toUpperCase();
  return (list ?? []).map((p) => {
    if (p.hex.toUpperCase() !== h) return p;
    const note = name.trim();
    return note ? { hex: p.hex, name } : { hex: p.hex };
  });
}

export function isPinned(list: PinnedList | undefined, hex: string): boolean {
  const h = hex.toUpperCase();
  return (list ?? []).some((p) => p.hex.toUpperCase() === h);
}

/**
 * Ergebnis der Berechnung für eine Pflichtfarbe – nur, wenn die angezeigte Berechnung genau mit dieser Pflichtfarbe
 * lief (sonst null: „wird bei der nächsten Berechnung verwendet“).
 */
export function pinnedResultFor(d: ComputeDiagnostics | undefined, hex: string, stale: boolean): PinnedColorResult | null {
  if (!d || stale || !d.pinnedColors) return null;
  const h = hex.toUpperCase();
  return d.pinnedColors.find((p) => p.hex.toUpperCase() === h) ?? null;
}
