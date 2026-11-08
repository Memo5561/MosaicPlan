/**
 * Texte für schneidbare Teile und ehrliche Schnittanweisungen (Arbeitspaket w1-cut-correctness):
 * Mindestbreite als schmalste Stelle, Einschnitte bei nicht-konvexen Steinen, leere Teile.
 * Überschreibt einige bestehende Schlüssel, deren Bedeutung sich geändert hat.
 */
export const de: Record<string, string> = {
  // Schritt Steinformen
  'shapes.minPiece': 'Mindestbreite eines Schnittteils (mm)',
  'shapes.minPieceHint':
    'Jedes geschnittene Teil (Dreieck, Kantenschnitt, Teilstein) ist an seiner schmalsten Stelle mindestens so breit. Zusätzlich muss sein Inkreismaß (4 × Fläche ÷ Umfang; bei Dreiecken der Durchmesser des größten Kreises, der hineinpasst) diesen Wert erreichen – bei Dreiecken ist das die strengere Bedingung. Größerer Wert = leichter schneidbar, aber weniger feine Konturen. Richtwert für 4 mm dickes Glas: 2–3 mm.',
  'shapes.subTooSmallW': 'Teilsteine {w} × {h} mm sind schmaler als die Mindestbreite ({min} mm) – es wird nicht unterteilt.',
  'shapes.diagTooSmall': 'Dreiecke aus {w} × {h} mm Steinen mit {g} mm Fuge erfüllen die Mindestbreite ({min} mm) nicht – {why}. Ganze Steine werden nicht diagonal geteilt.',
  'shapes.diagMaxMin': 'Dreiecke wären bis zu einer Mindestbreite von {max} mm möglich.',
  'shapes.lineTooSmall':
    'Kantenschnitte: Bei {w} × {h} mm Steinen mit {g} mm Fuge erfüllt kein möglicher Kantenschnitt (Winkel in 15°-Schritten, Versatz im 0,5-mm-Raster) die Mindestbreite ({min} mm) – ganze Steine werden nicht kantengeschnitten.',
  'width.failCaliper': 'schmalste Stelle {cal} mm < {min} mm (Inkreismaß {inc} mm)',
  'width.failIncircle': 'Inkreismaß {inc} mm < {min} mm (schmalste Stelle {cal} mm)',
  'width.degenerate': 'ein Teil hätte keine Fläche',
  // Formänderung im Steindetail
  'edit.err.diag-empty': 'Die Fuge ist breiter als der Stein – eine Dreiecksteilung ist hier nicht möglich.',
  'edit.err.too-small': 'Ein entstehendes Teil erfüllt die Mindestbreite eines Schnittteils (Schritt Steinformen) nicht:',
  'edit.notPossible': 'Nicht möglich:',
  'edit.diag': 'Dreiecke',
  // Schnittanweisung
  'cut.invalid': 'Ungültiges Teil: keine Fläche (die Fuge ist breiter als der Stein). Es gibt keine Schnittmaße – Zelle auf „Ganzer Stein“ zurücksetzen.',
  'cut.notch': 'Einschnitt {i}: von ({x1} | {y1}) bis Innenecke ({x2} | {y2}) mm – nicht durchritzen, mit der Zange ausknabbern bzw. schleifen.',
  'cut.notchEdge': 'Einschnitt {i}: von ({x1} | {y1}) bis zur Steinkante ({x2} | {y2}) mm – nicht durchritzen, mit der Zange ausknabbern bzw. schleifen.',
  'cut.nonConvex': 'Nicht konvex: Zuerst die durchgehenden Schnitte, dann die Einschnitte (orange gepunktet). Sie enden an einer Innenecke – dort nicht brechen, sondern ausknabbern bzw. schleifen.',
  'cut.nonConvexNotchOnly': 'Nicht konvex: Die Einschnitte (orange gepunktet) enden an einer Innenecke – dort nicht brechen, sondern ausknabbern bzw. schleifen.',
  'cut.nonConvexPlain': 'Nicht konvex: nur mit Nachschleifen bzw. Feinzange exakt herstellbar.',
  'cut.difficult': 'Schwierig zu schneiden: spitzester Winkel {a}° (Richtwert: unter 25° bricht die Spitze leicht ab)',
  'pdf.nonConvex': 'nicht konvex – Schnitte, die an einer Innenecke enden, nicht brechen: ausknabbern/schleifen',
  'stone.templateLegend':
    'Gestrichelt: Rohstein · Fläche: Steinkontur · Rot: durchgehende Schnitte · Orange gepunktet: Einschnitte bis zur Innenecke. Maße in mm, gemessen von der oberen linken Rohsteinecke.',
  'stone.invalid': 'Ungültiges Teil',
  'stone.minWidth': 'schmalste Stelle {w} mm · Inkreismaß {inc} mm',
  'stone.belowMin': 'Erfüllt die Mindestbreite eines Schnittteils ({min} mm) nicht: {why} – schwer schneidbar. Neu berechnen oder Form ändern.',
  'free.thin': 'Achtung: Ein Teil erfüllt die Mindestbreite eines Schnittteils ({min} mm) nicht (schmalste Stelle oder Inkreismaß). Bei nicht-konvexen Teilen wird nur näherungsweise geprüft.',
};

export const en: Record<string, string> = {
  'shapes.minPiece': 'Minimum width of a cut piece (mm)',
  'shapes.minPieceHint':
    'Every cut piece (triangle, edge cut, sub-tile) is at least this wide at its narrowest point. In addition its incircle measure (4 × area ÷ perimeter; for triangles the diameter of the largest circle that fits inside) must reach this value – for triangles this is the stricter condition. Larger value = easier to cut, but less fine contours. Guide value for 4 mm thick glass: 2–3 mm.',
  'shapes.subTooSmallW': 'Sub-tiles of {w} × {h} mm are narrower than the minimum width ({min} mm) – no subdivision will happen.',
  'shapes.diagTooSmall': 'Triangles from {w} × {h} mm tiles with a {g} mm joint do not meet the minimum width ({min} mm) – {why}. Whole tiles will not be split diagonally.',
  'shapes.diagMaxMin': 'Triangles would be possible up to a minimum width of {max} mm.',
  'shapes.lineTooSmall':
    'Edge cuts: with {w} × {h} mm tiles and a {g} mm joint no possible edge cut (angles in 15° steps, offset on a 0.5 mm grid) meets the minimum width ({min} mm) – whole tiles will not be edge-cut.',
  'width.failCaliper': 'narrowest point {cal} mm < {min} mm (incircle measure {inc} mm)',
  'width.failIncircle': 'incircle measure {inc} mm < {min} mm (narrowest point {cal} mm)',
  'width.degenerate': 'a piece would have no area',
  'edit.err.diag-empty': 'The joint is wider than the tile – a triangle split is not possible here.',
  'edit.err.too-small': 'A resulting piece does not meet the minimum width of a cut piece (step Tile shapes):',
  'edit.notPossible': 'Not possible:',
  'edit.diag': 'Triangles',
  'cut.invalid': 'Invalid piece: no area (the joint is wider than the tile). There are no cut dimensions – reset the cell to “Whole tile”.',
  'cut.notch': 'Notch {i}: from ({x1} | {y1}) to inner corner ({x2} | {y2}) mm – do not score through, nibble out with nippers or grind.',
  'cut.notchEdge': 'Notch {i}: from ({x1} | {y1}) to the tile edge ({x2} | {y2}) mm – do not score through, nibble out with nippers or grind.',
  'cut.nonConvex': 'Not convex: make the straight through cuts first, then the notches (dotted orange). They end at an inner corner – do not snap there, nibble out or grind instead.',
  'cut.nonConvexNotchOnly': 'Not convex: the notches (dotted orange) end at an inner corner – do not snap there, nibble out or grind instead.',
  'cut.nonConvexPlain': 'Not convex: can only be made exactly with grinding or fine nippers.',
  'cut.difficult': 'Difficult to cut: sharpest angle {a}° (guide value: below 25° the tip breaks off easily)',
  'pdf.nonConvex': 'not convex – do not snap cuts that end at an inner corner: nibble/grind',
  'stone.templateLegend':
    'Dashed: raw tile · Fill: tile contour · Red: through cuts · Dotted orange: notches up to the inner corner. Dimensions in mm, measured from the top-left corner of the raw tile.',
  'stone.invalid': 'Invalid piece',
  'stone.minWidth': 'narrowest point {w} mm · incircle measure {inc} mm',
  'stone.belowMin': 'Does not meet the minimum width of a cut piece ({min} mm): {why} – hard to cut. Recompute or change the shape.',
  'free.thin': 'Warning: a piece does not meet the minimum width of a cut piece ({min} mm) (narrowest point or incircle measure). For non-convex pieces this is only checked approximately.',
};

export const tr: Record<string, string> = {
  'shapes.minPiece': 'Kesim parçasının en küçük genişliği (mm)',
  'shapes.minPieceHint':
    'Her kesilmiş parça (üçgen, kenar kesimi, alt taş) en dar yerinde en az bu kadar geniştir. Ayrıca iç daire ölçüsü (4 × alan ÷ çevre; üçgenlerde içine sığan en büyük dairenin çapı) bu değere ulaşmalıdır – üçgenlerde bu daha sıkı koşuldur. Büyük değer = kesmesi kolay, ancak daha az ince kontur. 4 mm kalınlığında cam için yol gösterici değer: 2–3 mm.',
  'shapes.subTooSmallW': '{w} × {h} mm alt taşlar en küçük genişlikten ({min} mm) dar – bölme yapılmaz.',
  'shapes.diagTooSmall': '{g} mm derzli {w} × {h} mm taşlardan çıkan üçgenler en küçük genişliği ({min} mm) karşılamıyor – {why}. Tam taşlar çapraz bölünmez.',
  'shapes.diagMaxMin': 'Üçgenler en fazla {max} mm en küçük genişliğe kadar mümkün olurdu.',
  'shapes.lineTooSmall':
    'Kenar kesimleri: {g} mm derzli {w} × {h} mm taşlarda hiçbir olası kenar kesimi (15° adımlarla açı, 0,5 mm ızgarada kaydırma) en küçük genişliği ({min} mm) karşılamıyor – tam taşlara kenar kesimi yapılmaz.',
  'width.failCaliper': 'en dar yer {cal} mm < {min} mm (iç daire ölçüsü {inc} mm)',
  'width.failIncircle': 'iç daire ölçüsü {inc} mm < {min} mm (en dar yer {cal} mm)',
  'width.degenerate': 'bir parçanın alanı olmazdı',
  'edit.err.diag-empty': 'Derz taştan geniş – burada üçgen bölme yapılamaz.',
  'edit.err.too-small': 'Oluşacak bir parça, kesim parçası için en küçük genişliği (Taş biçimleri adımı) karşılamıyor:',
  'edit.notPossible': 'Mümkün değil:',
  'edit.diag': 'Üçgenler',
  'cut.invalid': 'Geçersiz parça: alanı yok (derz taştan geniş). Kesim ölçüsü yok – hücreyi “Tam taş” olarak sıfırlayın.',
  'cut.notch': 'Çentik {i}: ({x1} | {y1}) noktasından iç köşeye ({x2} | {y2}) mm – boydan boya çizmeyin, pense ile kemirerek çıkarın veya taşlayın.',
  'cut.notchEdge': 'Çentik {i}: ({x1} | {y1}) noktasından taş kenarına ({x2} | {y2}) mm – boydan boya çizmeyin, pense ile kemirerek çıkarın veya taşlayın.',
  'cut.nonConvex': 'Dışbükey değil: önce boydan boya düz kesimler, sonra çentikler (turuncu noktalı). Çentikler bir iç köşede biter – orada kırmayın, kemirerek çıkarın veya taşlayın.',
  'cut.nonConvexNotchOnly': 'Dışbükey değil: çentikler (turuncu noktalı) bir iç köşede biter – orada kırmayın, kemirerek çıkarın veya taşlayın.',
  'cut.nonConvexPlain': 'Dışbükey değil: ancak taşlama veya ince pense ile tam olarak yapılabilir.',
  'cut.difficult': 'Kesmesi zor: en sivri açı {a}° (yol gösterici değer: 25° altında uç kolayca kırılır)',
  'pdf.nonConvex': 'dışbükey değil – iç köşede biten kesimleri kırmayın: kemirin/taşlayın',
  'stone.templateLegend':
    'Kesikli: ham taş · Dolgu: taş konturu · Kırmızı: boydan boya kesimler · Turuncu noktalı: iç köşeye kadar çentikler. Ölçüler mm, ham taşın sol üst köşesinden ölçülür.',
  'stone.invalid': 'Geçersiz parça',
  'stone.minWidth': 'en dar yer {w} mm · iç daire ölçüsü {inc} mm',
  'stone.belowMin': 'Kesim parçası için en küçük genişliği ({min} mm) karşılamıyor: {why} – kesmesi zor. Yeniden hesaplayın veya biçimi değiştirin.',
  'free.thin': 'Dikkat: Bir parça, kesim parçası için en küçük genişliği ({min} mm) karşılamıyor (en dar yer veya iç daire ölçüsü). Dışbükey olmayan parçalarda yalnızca yaklaşık olarak denetlenir.',
};
