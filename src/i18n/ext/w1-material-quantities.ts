/**
 * Texte zum Rohstein-, Packungs- und Kostenbedarf (w1-material-quantities).
 * Überschreibt den Hinweis unter der Materialberechnung, weil sich die Zählweise geändert hat:
 * Rohsteine je Farbe und gleicher Schnittform (sichere Obergrenze), Kosten je Material.
 */
export const de: Record<string, string> = {
  'plan.yieldHint':
    'Rohsteinbedarf (Richtwert, sicher aufgerundet): je Farbe und gleicher Schnittform (gedreht ja, gespiegelt nein) aus der Ausbeute je Rohstein – ganze Steine 1, Diagonal-Dreiecke 2, Rechtecke so viele wie hineinpassen, sonstige Formen 1. Verschiedene Schnittformen und Reststücke teilen sich keinen Rohstein; Bruch deckt die Reserve, der Verschnitt bezieht sich auf diese Zahl. Kosten je Material (für mehrere Farben einmal gezählt); „Pack.“ zeigt jede Farbe für sich.',
};

export const en: Record<string, string> = {
  'plan.yieldHint':
    'Raw tile need (guide value, safely rounded up): per colour and identical cut shape (rotated yes, mirrored no) from the yield per raw tile – whole tiles 1, diagonal triangles 2, rectangles as many as fit, other shapes 1. Different cut shapes and offcuts never share a raw tile; the reserve covers breakage, cutting waste refers to this count. Cost per material (counted once for several colours); "packs" shows each colour on its own.',
};

export const tr: Record<string, string> = {
  'plan.yieldHint':
    'Ham taş ihtiyacı (yaklaşık değer, güvenli şekilde yukarı yuvarlanmış): her renk ve aynı kesim biçimi için (döndürme evet, aynalama hayır) ham taş başına verimden – tam taş 1, çapraz üçgen 2, dikdörtgenler sığdığı kadar, diğer biçimler 1. Farklı kesim biçimleri ve artık parçalar aynı ham taşı paylaşmaz; kırılmaları yedek karşılar, fire bu sayıya göredir. Maliyet malzeme başına (birden fazla renk için bir kez sayılır); "paket" her rengi tek başına gösterir.',
};
