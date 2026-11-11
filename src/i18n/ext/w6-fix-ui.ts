/**
 * Paket w6-fix-ui: Nachbesserungen der UX-Prüfung von Welle 6 – Abweichung im Steindetail, ΔE in Worten, Werkzeugkarte,
 * Bereichsbearbeitung am Handy (Hinweisleiste, Ergebnis ansehen), Form zurücksetzen nach Fotofarbe, große Sprünge bei
 * Heller/Dunkler abwählbar, Farbmessung am Handy und kompakte Live-Vorschau.
 */
export const de: Record<string, string> = {
  // ΔE in Worten (gleiche Grenzen wie die Legende der Abweichungskarte und compute.deHint)
  'w6fx.de.0': 'kaum sichtbar',
  'w6fx.de.1': 'erkennbar',
  'w6fx.de.2': 'deutlich',
  'w6fx.de.3': 'stark',
  'w6fx.deWord': '{word} (ΔE {v})',
  'w6fx.deShort': '{word} ({v})',

  // Werkzeugkarte der Vorschau
  'w6fx.tools.heading': 'Werkzeuge: Abweichung · Bereich bearbeiten · Bild',
  'w6fx.quickShort': 'Karte',

  // Liste „Größte Abweichungen“
  'w6fx.col.rank': 'Nr.',
  'w6fx.col.id': 'Stein-ID',
  'w6fx.col.photo': 'Foto',
  'w6fx.col.tile': 'Stein',
  'w6fx.col.de': 'Abweichung',

  // Steindetail
  'w6fx.stone.title': 'Abweichung zum Foto',
  'w6fx.stone.photo': 'Foto',
  'w6fx.stone.tile': 'Stein',
  'w6fx.stone.de': 'Abweichung: {word}',
  'w6fx.stone.nearest': 'Nächste Palettenfarbe: {code} {name} · {word}',
  'w6fx.stone.apply': 'Nächste Farbe {code} übernehmen',

  // Bereich bearbeiten
  'w6fx.rect.banner.coarse': 'Mit einem Finger ein Rechteck ziehen',
  'w6fx.rect.banner.fine': 'Im Mosaik ein Rechteck ziehen',
  'w6fx.rect.cancel': 'Abbrechen',
  'w6fx.rectHint.coarse': 'Mit einem Finger ein Rechteck ziehen (rastet auf ganze Zellen ein). Verschieben und Zoomen: zwei Finger.',
  'w6fx.rectHint.fine': 'Im Mosaik ein Rechteck ziehen (rastet auf ganze Zellen ein). Verschieben: Leertaste oder mittlere Maustaste.',
  'w6fx.sel.banner': 'Auswahl {range} · {cells}',
  'w6fx.sel.actions': 'Zu den Aktionen ↓',
  'w6fx.done.show': 'Im Mosaik ansehen',
  'w6fx.undoHint.coarse': 'Rückgängig: ↶ über dem Mosaik.',
  'w6fx.undoHint.fine': 'Rückgängig: ↶ oder Strg+Z.',
  'w6fx.shade.lighter': '{dl} Stufen heller · {de}',
  'w6fx.shade.darker': '{dl} Stufen dunkler · {de}',
  'w6fx.shade.scale': 'Stufen: Helligkeit auf der Skala von 0 (schwarz) bis 100 (weiß).',
  'w6fx.shade.big': 'großer Sprung',
  'w6fx.shade.bigHint': '„Großer Sprung“: Abweichung über {max} – die neue Farbe fällt deutlich auf. Haken entfernen, damit diese Farbe unverändert bleibt.',
  'w6fx.shade.use': 'Farbe {code} ändern',
  'w6fx.dry.shadeSkipped': '{n} Steine abgewählt – sie bleiben unverändert.',
  'w6fx.dry.shapePhoto': 'Farbe von {n} Zellen: die Palettenfarbe, die ihrer Fotofarbe (Mittel aller Teile nach Fläche) am nächsten liegt.',
  'w6fx.dry.shapeArea': 'Farbe von {n} Zellen: die Farbe mit der größten Fläche in der Zelle (keine Fotoreferenz).',

  // Farbe aus Foto messen
  'w6fx.measure.explain': 'Was bedeuten Lab und ΔE?',
  'w6fx.measure.explainText':
    'Lab beschreibt eine Farbe mit der Helligkeit L (0 = schwarz, 100 = weiß) und zwei Farbachsen: a (grün ↔ rot) und b (blau ↔ gelb). ΔE ist der Abstand zweier Farben (hier CIEDE2000): unter 2 kaum sichtbar, 2–5 erkennbar, 5–10 deutlich, über 10 stark.',
  'w6fx.measure.pinch': 'Mit zwei Fingern zoomen.',

  // Live-Vorschau
  'w6fx.lp.drawing': 'Ausgeblendet, solange ein Bereich gezeichnet wird.',
};

export const en: Record<string, string> = {
  'w6fx.de.0': 'barely visible',
  'w6fx.de.1': 'noticeable',
  'w6fx.de.2': 'clear',
  'w6fx.de.3': 'strong',
  'w6fx.deWord': '{word} (ΔE {v})',
  'w6fx.deShort': '{word} ({v})',

  'w6fx.tools.heading': 'Tools: deviation · edit an area · image',
  'w6fx.quickShort': 'Map',

  'w6fx.col.rank': 'No.',
  'w6fx.col.id': 'Tile ID',
  'w6fx.col.photo': 'Photo',
  'w6fx.col.tile': 'Tile',
  'w6fx.col.de': 'Deviation',

  'w6fx.stone.title': 'Deviation from the photo',
  'w6fx.stone.photo': 'Photo',
  'w6fx.stone.tile': 'Tile',
  'w6fx.stone.de': 'Deviation: {word}',
  'w6fx.stone.nearest': 'Nearest palette colour: {code} {name} · {word}',
  'w6fx.stone.apply': 'Use nearest colour {code}',

  'w6fx.rect.banner.coarse': 'Drag a rectangle with one finger',
  'w6fx.rect.banner.fine': 'Drag a rectangle on the mosaic',
  'w6fx.rect.cancel': 'Cancel',
  'w6fx.rectHint.coarse': 'Drag a rectangle with one finger (snaps to whole cells). Pan and zoom: two fingers.',
  'w6fx.rectHint.fine': 'Drag a rectangle on the mosaic (snaps to whole cells). Pan: space bar or middle mouse button.',
  'w6fx.sel.banner': 'Selection {range} · {cells}',
  'w6fx.sel.actions': 'To the actions ↓',
  'w6fx.done.show': 'Show on the mosaic',
  'w6fx.undoHint.coarse': 'Undo: ↶ above the mosaic.',
  'w6fx.undoHint.fine': 'Undo: ↶ or Ctrl+Z.',
  'w6fx.shade.lighter': '{dl} steps lighter · {de}',
  'w6fx.shade.darker': '{dl} steps darker · {de}',
  'w6fx.shade.scale': 'Steps: lightness on a scale from 0 (black) to 100 (white).',
  'w6fx.shade.big': 'big jump',
  'w6fx.shade.bigHint': '“Big jump”: deviation over {max} – the new colour stands out clearly. Untick to leave this colour unchanged.',
  'w6fx.shade.use': 'Change colour {code}',
  'w6fx.dry.shadeSkipped': '{n} tiles unticked – they stay unchanged.',
  'w6fx.dry.shapePhoto': 'Colour of {n} cells: the palette colour nearest to their photo colour (mean of all pieces by area).',
  'w6fx.dry.shapeArea': 'Colour of {n} cells: the colour with the largest area in the cell (no photo reference).',

  'w6fx.measure.explain': 'What do Lab and ΔE mean?',
  'w6fx.measure.explainText':
    'Lab describes a colour by its lightness L (0 = black, 100 = white) and two colour axes: a (green ↔ red) and b (blue ↔ yellow). ΔE is the distance between two colours (here CIEDE2000): below 2 barely visible, 2–5 noticeable, 5–10 clear, over 10 strong.',
  'w6fx.measure.pinch': 'Zoom with two fingers.',

  'w6fx.lp.drawing': 'Hidden while an area is being drawn.',
};

export const tr: Record<string, string> = {
  'w6fx.de.0': 'neredeyse görünmez',
  'w6fx.de.1': 'fark edilir',
  'w6fx.de.2': 'belirgin',
  'w6fx.de.3': 'güçlü',
  'w6fx.deWord': '{word} (ΔE {v})',
  'w6fx.deShort': '{word} ({v})',

  'w6fx.tools.heading': 'Araçlar: sapma · alanı düzenle · resim',
  'w6fx.quickShort': 'Harita',

  'w6fx.col.rank': 'No.',
  'w6fx.col.id': 'Taş kimliği',
  'w6fx.col.photo': 'Fotoğraf',
  'w6fx.col.tile': 'Taş',
  'w6fx.col.de': 'Sapma',

  'w6fx.stone.title': 'Fotoğraftan sapma',
  'w6fx.stone.photo': 'Fotoğraf',
  'w6fx.stone.tile': 'Taş',
  'w6fx.stone.de': 'Sapma: {word}',
  'w6fx.stone.nearest': 'En yakın palet rengi: {code} {name} · {word}',
  'w6fx.stone.apply': 'En yakın rengi ({code}) kullan',

  'w6fx.rect.banner.coarse': 'Tek parmakla bir dikdörtgen çizin',
  'w6fx.rect.banner.fine': 'Mozaikte bir dikdörtgen sürükleyin',
  'w6fx.rect.cancel': 'İptal',
  'w6fx.rectHint.coarse': 'Tek parmakla bir dikdörtgen çizin (tam hücrelere oturur). Kaydırma ve yakınlaştırma: iki parmak.',
  'w6fx.rectHint.fine': 'Mozaikte bir dikdörtgen sürükleyin (tam hücrelere oturur). Kaydırma: boşluk tuşu veya orta fare tuşu.',
  'w6fx.sel.banner': 'Seçim {range} · {cells}',
  'w6fx.sel.actions': 'İşlemlere git ↓',
  'w6fx.done.show': 'Mozaikte göster',
  'w6fx.undoHint.coarse': 'Geri al: mozaiğin üstündeki ↶.',
  'w6fx.undoHint.fine': 'Geri al: ↶ veya Ctrl+Z.',
  'w6fx.shade.lighter': '{dl} kademe daha açık · {de}',
  'w6fx.shade.darker': '{dl} kademe daha koyu · {de}',
  'w6fx.shade.scale': 'Kademe: 0 (siyah) ile 100 (beyaz) arasındaki açıklık ölçeği.',
  'w6fx.shade.big': 'büyük sıçrama',
  'w6fx.shade.bigHint': '“Büyük sıçrama”: sapma {max} üzerinde – yeni renk belirgin şekilde göze çarpar. Bu rengin değişmemesi için işareti kaldırın.',
  'w6fx.shade.use': '{code} rengini değiştir',
  'w6fx.dry.shadeSkipped': '{n} taşın işareti kaldırıldı – değişmeden kalırlar.',
  'w6fx.dry.shapePhoto': '{n} hücrenin rengi: fotoğraf rengine (tüm parçaların alana göre ortalaması) en yakın palet rengi.',
  'w6fx.dry.shapeArea': '{n} hücrenin rengi: hücrede en büyük alana sahip renk (fotoğraf referansı yok).',

  'w6fx.measure.explain': 'Lab ve ΔE ne anlama gelir?',
  'w6fx.measure.explainText':
    'Lab bir rengi açıklık L (0 = siyah, 100 = beyaz) ve iki renk ekseniyle tanımlar: a (yeşil ↔ kırmızı) ve b (mavi ↔ sarı). ΔE iki renk arasındaki uzaklıktır (burada CIEDE2000): 2’nin altı neredeyse görünmez, 2–5 fark edilir, 5–10 belirgin, 10’un üstü güçlü.',
  'w6fx.measure.pinch': 'İki parmakla yakınlaştırın.',

  'w6fx.lp.drawing': 'Bir alan çizilirken gizlenir.',
};
