/**
 * Texte für schneidbare Teile und ehrliche Schnittanweisungen (Arbeitspaket w1-cut-correctness):
 * Mindestbreite als schmalste Stelle, Einschnitte bei nicht-konvexen Steinen, leere Teile.
 * Überschreibt einige bestehende Schlüssel, deren Bedeutung sich geändert hat.
 */
export const de: Record<string, string> = {
  // Schritt Steinformen
  'shapes.minPiece': 'Schmalste Stelle eines Schnittteils (mm)',
  'shapes.minPieceHint':
    'Kein geschnittenes Teil (Dreieck, Kantenschnitt, Teilstein) wird an seiner schmalsten Stelle schmaler als dieser Wert. Größerer Wert = leichter schneidbar, aber weniger feine Konturen. Richtwert für 4 mm dickes Glas: 2–3 mm.',
  'shapes.subTooSmallW': 'Teilsteine {w} × {h} mm sind schmaler als die Mindestbreite ({min} mm) – es wird nicht unterteilt.',
  'shapes.diagTooSmall': 'Dreiecke aus {w} × {h} mm Steinen mit {g} mm Fuge sind schmaler als die Mindestbreite ({min} mm) – ganze Steine werden nicht diagonal geteilt.',
  // Formänderung im Steindetail
  'edit.err.diag-empty': 'Die Fuge ist breiter als der Stein – eine Dreiecksteilung ist hier nicht möglich.',
  'edit.err.too-small': 'Ein entstehendes Teil wäre schmaler als die Mindestbreite eines Schnittteils (Schritt Steinformen).',
  'edit.notPossible': 'Nicht möglich:',
  'edit.diag': 'Dreiecke',
  // Schnittanweisung
  'cut.invalid': 'Ungültiges Teil: keine Fläche (die Fuge ist breiter als der Stein). Es gibt keine Schnittmaße – Zelle auf „Ganzer Stein“ zurücksetzen.',
  'cut.notch': 'Einschnitt {i}: von ({x1} | {y1}) bis Innenecke ({x2} | {y2}) mm – nicht durchritzen, mit der Zange ausknabbern bzw. schleifen.',
  'cut.notchEdge': 'Einschnitt {i}: von ({x1} | {y1}) bis zur Steinkante ({x2} | {y2}) mm – nicht durchritzen, mit der Zange ausknabbern bzw. schleifen.',
  'cut.nonConvex': 'Nicht konvex: Zuerst die durchgehenden Schnitte, dann die Einschnitte (orange gepunktet). Sie enden an einer Innenecke – dort nicht brechen, sondern ausknabbern bzw. schleifen.',
  'cut.difficult': 'Schwierig zu schneiden: spitzester Winkel {a}° (Richtwert: unter 25° bricht die Spitze leicht ab)',
  'pdf.nonConvex': 'nicht konvex – Schnitte, die an einer Innenecke enden, nicht brechen: ausknabbern/schleifen',
  'stone.templateLegend':
    'Gestrichelt: Rohstein · Fläche: Steinkontur · Rot: durchgehende Schnitte · Orange gepunktet: Einschnitte bis zur Innenecke. Maße in mm, gemessen von der oberen linken Rohsteinecke.',
  'stone.invalid': 'Ungültiges Teil',
  'stone.minWidth': 'schmalste Stelle {w} mm',
  'stone.belowMin': 'Unter der Mindestbreite eines Schnittteils ({min} mm) – schwer schneidbar. Neu berechnen oder Form ändern.',
  'free.thin': 'Achtung: Ein Teil ist schmaler als die Mindestbreite eines Schnittteils ({min} mm). Bei nicht-konvexen Teilen wird nur näherungsweise geprüft.',
};

export const en: Record<string, string> = {
  'shapes.minPiece': 'Narrowest point of a cut piece (mm)',
  'shapes.minPieceHint':
    'No cut piece (triangle, edge cut, sub-tile) will be narrower than this value at its narrowest point. Larger value = easier to cut, but less fine contours. Guide value for 4 mm thick glass: 2–3 mm.',
  'shapes.subTooSmallW': 'Sub-tiles of {w} × {h} mm are narrower than the minimum width ({min} mm) – no subdivision will happen.',
  'shapes.diagTooSmall': 'Triangles from {w} × {h} mm tiles with a {g} mm joint are narrower than the minimum width ({min} mm) – whole tiles will not be split diagonally.',
  'edit.err.diag-empty': 'The joint is wider than the tile – a triangle split is not possible here.',
  'edit.err.too-small': 'A resulting piece would be narrower than the minimum width of a cut piece (step Tile shapes).',
  'edit.notPossible': 'Not possible:',
  'edit.diag': 'Triangles',
  'cut.invalid': 'Invalid piece: no area (the joint is wider than the tile). There are no cut dimensions – reset the cell to “Whole tile”.',
  'cut.notch': 'Notch {i}: from ({x1} | {y1}) to inner corner ({x2} | {y2}) mm – do not score through, nibble out with nippers or grind.',
  'cut.notchEdge': 'Notch {i}: from ({x1} | {y1}) to the tile edge ({x2} | {y2}) mm – do not score through, nibble out with nippers or grind.',
  'cut.nonConvex': 'Not convex: make the straight through cuts first, then the notches (dotted orange). They end at an inner corner – do not snap there, nibble out or grind instead.',
  'cut.difficult': 'Difficult to cut: sharpest angle {a}° (guide value: below 25° the tip breaks off easily)',
  'pdf.nonConvex': 'not convex – do not snap cuts that end at an inner corner: nibble/grind',
  'stone.templateLegend':
    'Dashed: raw tile · Fill: tile contour · Red: through cuts · Dotted orange: notches up to the inner corner. Dimensions in mm, measured from the top-left corner of the raw tile.',
  'stone.invalid': 'Invalid piece',
  'stone.minWidth': 'narrowest point {w} mm',
  'stone.belowMin': 'Below the minimum width of a cut piece ({min} mm) – hard to cut. Recompute or change the shape.',
  'free.thin': 'Warning: a piece is narrower than the minimum width of a cut piece ({min} mm). For non-convex pieces this is only checked approximately.',
};

export const tr: Record<string, string> = {
  'shapes.minPiece': 'Kesim parçasının en dar yeri (mm)',
  'shapes.minPieceHint':
    'Hiçbir kesilmiş parça (üçgen, kenar kesimi, alt taş) en dar yerinde bu değerden ince olmaz. Büyük değer = kesmesi kolay, ancak daha az ince kontur. 4 mm kalınlığında cam için yol gösterici değer: 2–3 mm.',
  'shapes.subTooSmallW': '{w} × {h} mm alt taşlar en küçük genişlikten ({min} mm) dar – bölme yapılmaz.',
  'shapes.diagTooSmall': '{g} mm derzli {w} × {h} mm taşlardan çıkan üçgenler en küçük genişlikten ({min} mm) dar – tam taşlar çapraz bölünmez.',
  'edit.err.diag-empty': 'Derz taştan geniş – burada üçgen bölme yapılamaz.',
  'edit.err.too-small': 'Oluşacak bir parça, kesim parçası için en küçük genişlikten dar olur (Taş biçimleri adımı).',
  'edit.notPossible': 'Mümkün değil:',
  'edit.diag': 'Üçgenler',
  'cut.invalid': 'Geçersiz parça: alanı yok (derz taştan geniş). Kesim ölçüsü yok – hücreyi “Tam taş” olarak sıfırlayın.',
  'cut.notch': 'Çentik {i}: ({x1} | {y1}) noktasından iç köşeye ({x2} | {y2}) mm – boydan boya çizmeyin, pense ile kemirerek çıkarın veya taşlayın.',
  'cut.notchEdge': 'Çentik {i}: ({x1} | {y1}) noktasından taş kenarına ({x2} | {y2}) mm – boydan boya çizmeyin, pense ile kemirerek çıkarın veya taşlayın.',
  'cut.nonConvex': 'Dışbükey değil: önce boydan boya düz kesimler, sonra çentikler (turuncu noktalı). Çentikler bir iç köşede biter – orada kırmayın, kemirerek çıkarın veya taşlayın.',
  'cut.difficult': 'Kesmesi zor: en sivri açı {a}° (yol gösterici değer: 25° altında uç kolayca kırılır)',
  'pdf.nonConvex': 'dışbükey değil – iç köşede biten kesimleri kırmayın: kemirin/taşlayın',
  'stone.templateLegend':
    'Kesikli: ham taş · Dolgu: taş konturu · Kırmızı: boydan boya kesimler · Turuncu noktalı: iç köşeye kadar çentikler. Ölçüler mm, ham taşın sol üst köşesinden ölçülür.',
  'stone.invalid': 'Geçersiz parça',
  'stone.minWidth': 'en dar yer {w} mm',
  'stone.belowMin': 'Kesim parçası için en küçük genişliğin ({min} mm) altında – kesmesi zor. Yeniden hesaplayın veya biçimi değiştirin.',
  'free.thin': 'Dikkat: Bir parça, kesim parçası için en küçük genişlikten ({min} mm) dar. Dışbükey olmayan parçalarda yalnızca yaklaşık olarak denetlenir.',
};
