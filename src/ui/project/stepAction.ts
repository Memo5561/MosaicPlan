/**
 * Hauptaktion eines Schritts in der Leiste unten (w5-fix-pdf): Schritt 10 hat keinen „Weiter“-Schritt mehr – dort
 * steht stattdessen seine Hauptaktion („PDF erzeugen · ca. N S.“), damit sie ohne Scrollen erreichbar ist.
 *
 * Der Schritt meldet nur die angezeigten Werte (Text, gesperrt, Hinweis); gemeldet wird nur bei einer Änderung, damit
 * das Neuzeichnen der Leiste nicht wieder den Schritt neu zeichnet. Ausgeführt wird über eine feste Funktion, die
 * immer den aktuellen Stand des Schritts nimmt.
 */
import { useSyncExternalStore } from 'react';

export interface StepAction {
  /** Schritt, zu dem die Aktion gehört (die Leiste zeigt sie nur dort) */
  step: string;
  label: string;
  disabled: boolean;
  title?: string;
  /** Art der Aktion für Tests/Stil, z. B. 'single', 'part', 'busy', 'done' */
  kind: string;
  run: () => void;
}

let current: StepAction | null = null;
const listeners = new Set<() => void>();

function same(a: StepAction | null, b: StepAction | null): boolean {
  if (!a || !b) return a === b;
  return a.step === b.step && a.label === b.label && a.disabled === b.disabled && a.title === b.title && a.kind === b.kind && a.run === b.run;
}

/** Aktion setzen (null: keine). Unverändert: keine Meldung. */
export function setStepAction(a: StepAction | null): void {
  if (same(current, a)) return;
  current = a;
  for (const fn of [...listeners]) fn();
}

/** Aktion entfernen, falls sie noch zu diesem Schritt gehört. */
export function clearStepAction(step: string): void {
  if (current && current.step === step) setStepAction(null);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useStepAction(step: string): StepAction | null {
  const a = useSyncExternalStore(subscribe, () => current);
  return a && a.step === step ? a : null;
}
