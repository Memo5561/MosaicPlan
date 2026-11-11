import { useEffect, useState } from 'react';

/**
 * Gerätebezogene Abfragen für Bedienhinweise (w5-fix-ui): Mit dem Finger heißt es „antippen“, mit der Maus
 * „anklicken“. Maßgeblich ist das HAUPT-Zeigegerät ('(pointer: coarse)' = Finger), wie bei den fingergroßen
 * Bedienelementen in styles.css.
 */
export const COARSE_QUERY = '(pointer: coarse)';

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/** Hauptzeigegerät ist ein Finger (Handy, Tablet) – jetzt, ohne React (z. B. in Ereignissen des Viewers) */
export function isCoarsePointer(): boolean {
  return matches(COARSE_QUERY);
}

/** CSS-Media-Query als Zustand (folgt Änderungen, z. B. Drehen oder angeschlossene Maus) */
export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => matches(query));
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return m;
}

export const useCoarsePointer = () => useMedia(COARSE_QUERY);

/** Schlüssel mit Gerätezusatz: `${base}.coarse` (Finger) bzw. `${base}.fine` (Maus) */
export const deviceKey = (base: string, coarse: boolean) => `${base}.${coarse ? 'coarse' : 'fine'}`;
