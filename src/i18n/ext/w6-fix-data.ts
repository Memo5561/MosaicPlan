/**
 * Korrekturen Welle 6 (Daten): Hinweis beim Material-CSV-Import, wenn ein neuer HEX-Wert die gemessene Herkunft
 * ungültig macht; Vorgaben „passend zum Papier“ in Schritt 9 (aktuell/empfohlen, Abschnitte und Blätter).
 */
export const de: Record<string, string> = {
  'matcsv.warn.source-stale':
    'Neuer HEX-Wert {value}, die Angaben zur Farbherkunft (z. B. Fotomessung) sind aber unverändert – sie gehören zum alten Wert. Gespeichert als „eingegeben“.',
  'w6fd.sec.current': 'aktuell',
  'w6fd.sec.recommended': 'empfohlen',
  'w6fd.sec.presetCounts': '{sections} Abschnitte · {sheets} Blätter',
};

export const en: Record<string, string> = {
  'matcsv.warn.source-stale':
    'New HEX value {value}, but the colour source columns (e.g. photo measurement) are unchanged – they belong to the old value. Saved as "entered".',
  'w6fd.sec.current': 'current',
  'w6fd.sec.recommended': 'recommended',
  'w6fd.sec.presetCounts': '{sections} sections · {sheets} sheets',
};

export const tr: Record<string, string> = {
  'matcsv.warn.source-stale':
    'Yeni HEX değeri {value}, ancak renk kaynağı sütunları (ör. fotoğraf ölçümü) değişmemiş – bunlar eski değere ait. “girildi” olarak kaydedildi.',
  'w6fd.sec.current': 'geçerli',
  'w6fd.sec.recommended': 'önerilen',
  'w6fd.sec.presetCounts': '{sections} bölüm · {sheets} sayfa',
};
