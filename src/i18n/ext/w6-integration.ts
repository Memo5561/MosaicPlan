/**
 * Integration Welle 6: Feinsteine (w6-fine-tiles) auch in PDF-Tabellen und der Materialansicht.
 * Neue Schlüssel w6int.* – keine Überschreibungen.
 */
export const de: Record<string, string> = {
  // PDF: Rohsteine einer Farbe mit Feinsteinen (Farblegende, Abschnittslegende)
  'w6int.pdf.rawPlusFine': '{base} + {fine} Fein',
  // PDF „Bedarf je Farbe“: eigene Zeile für die Feinsteine einer Farbe
  'w6int.pdf.fineName': '{name} – Feinsteine',
  // Materialansicht „Bedarf je Farbe“
  'w6int.mc.fineMat': '+ Feinstein: {mat} · {w} × {h} mm',
  'w6int.mc.fineRaw': '+ {n} Fein',
  'w6int.mc.fineRawTitle': '{n} Feinsteine {w} × {h} mm ohne Reserve (ganze, ungeschnittene Steine des Feinstein-Materials)',
};

export const en: Record<string, string> = {
  'w6int.pdf.rawPlusFine': '{base} + {fine} fine',
  'w6int.pdf.fineName': '{name} – fine tiles',
  'w6int.mc.fineMat': '+ fine tile: {mat} · {w} × {h} mm',
  'w6int.mc.fineRaw': '+ {n} fine',
  'w6int.mc.fineRawTitle': '{n} fine tiles {w} × {h} mm without reserve (whole, uncut tiles of the fine-tile material)',
};

export const tr: Record<string, string> = {
  'w6int.pdf.rawPlusFine': '{base} + {fine} ince',
  'w6int.pdf.fineName': '{name} – ince taşlar',
  'w6int.mc.fineMat': '+ ince taş: {mat} · {w} × {h} mm',
  'w6int.mc.fineRaw': '+ {n} ince',
  'w6int.mc.fineRawTitle': '{n} ince taş {w} × {h} mm, yedeksiz (ince taş malzemesinin bütün, kesilmemiş taşları)',
};
