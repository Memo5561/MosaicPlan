/**
 * Texte zum Rohstein-, Packungs- und Kostenbedarf (w1-material-quantities).
 * Überschreibt den Hinweis unter der Materialberechnung, weil sich die Zählweise geändert hat:
 * Rohsteine je Farbe und gleicher Schnittform (sichere Obergrenze), Kosten je Material.
 * Kurz sichtbar, die Einzelheiten aufklappbar („Wie wird gerechnet?“).
 */
export const de: Record<string, string> = {
  'plan.yieldHint': 'Rohsteine: Richtwert, je Farbe und Schnittform sicher aufgerundet; die Reserve deckt Bruch.',
  'plan.yieldHow': 'Wie wird gerechnet?',
  'plan.yieldDetails':
    'Je Farbe werden gleiche Schnittformen zusammengefasst (gedreht ja, gespiegelt nein) und aus der Ausbeute je Rohstein aufgerundet: ganze Steine 1, Diagonal-Dreiecke 2, Rechtecke so viele wie hineinpassen, sonstige Formen 1. Verschiedene Schnittformen und Reststücke teilen sich keinen Rohstein – so ist die Zahl nie zu niedrig. Der Verschnitt bezieht sich auf diese Zahl. Packungen, Bestand und Kosten werden je Material gezählt (Einkaufsliste); ein Material für mehrere Farben wird einmal gekauft.',
  'plan.stockHint': 'Fehlbestand je Material: Bedarf minus erfasster Bestand (Bestand 0 zählt als erfasst) – siehe Einkaufsliste.',
};

export const en: Record<string, string> = {
  'plan.yieldHint': 'Raw tiles: guide value, safely rounded up per colour and cut shape; the reserve covers breakage.',
  'plan.yieldHow': 'How is this calculated?',
  'plan.yieldDetails':
    'Per colour, identical cut shapes are grouped (rotated yes, mirrored no) and rounded up from the yield per raw tile: whole tiles 1, diagonal triangles 2, rectangles as many as fit, other shapes 1. Different cut shapes and offcuts never share a raw tile – so the count is never too low. Cutting waste refers to this count. Packs, stock and cost are counted per material (shopping list); a material used for several colours is bought once.',
  'plan.stockHint': 'Shortfall per material: need minus recorded stock (stock 0 counts as recorded) – see shopping list.',
};

export const tr: Record<string, string> = {
  'plan.yieldHint': 'Ham taş: yaklaşık değer, renk ve kesim biçimi başına güvenli şekilde yukarı yuvarlanır; kırılmaları yedek karşılar.',
  'plan.yieldHow': 'Nasıl hesaplanıyor?',
  'plan.yieldDetails':
    'Her renk için aynı kesim biçimleri toplanır (döndürme evet, aynalama hayır) ve ham taş başına verimden yukarı yuvarlanır: tam taş 1, çapraz üçgen 2, dikdörtgenler sığdığı kadar, diğer biçimler 1. Farklı kesim biçimleri ve artık parçalar aynı ham taşı paylaşmaz – böylece sayı hiçbir zaman düşük olmaz. Fire bu sayıya göredir. Paket, stok ve maliyet malzeme başına sayılır (alışveriş listesi); birden fazla renk için kullanılan malzeme bir kez alınır.',
  'plan.stockHint': 'Malzeme başına eksik: ihtiyaç eksi kayıtlı stok (stok 0 kayıtlı sayılır) – alışveriş listesine bakın.',
};
