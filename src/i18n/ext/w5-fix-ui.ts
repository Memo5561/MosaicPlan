/**
 * Texte der Korrekturen nach der Gegenprüfung von Welle 5 (w5-fix-ui):
 *  - Fehlbestand: Summe „zu kaufen“ ausdrücklich nur für Materialien mit erfasstem Bestand;
 *  - Heller/Dunkler: Ersatzvorschlag mit „etwas anderer Farbton“, Hinweise ohne Widerspruch zu ▲/▼;
 *  - Bedienhinweise je Gerät: „anklicken“ (Maus) bzw. „antippen“ (Finger) – Vorschau, Schritt 9, Abschnittsauswahl.
 */
export const de: Record<string, string> = {
  // ---- Material & Einkauf: Fehlbestand
  'w5fu.short.totalPartial': 'Zu kaufen bei Materialien mit erfasstem Bestand: {n} Rohsteine',
  'w5fu.short.partialNote':
    'Nicht enthalten: Materialien ohne erfassten Bestand und Farben ohne Material – dort ist offen, wie viel zu kaufen ist.',

  // ---- Steindetail: Heller / Dunkler
  'w5fu.shade.otherHue': 'etwas anderer Farbton',
  'w5fu.shade.titleOther': '{code} {name} · L* {dl} · ΔE {de} · etwas anderer Farbton',
  'w5fu.shade.rule':
    'Zuerst die nächste Palettenfarbe gleichen Farbtons (3 bis 20 L* heller bzw. dunkler, Farbort höchstens 10 Δa*b*, Farbton höchstens 8 ΔH). Gibt es keine, die ähnlichste hellere bzw. dunklere Palettenfarbe (wie ▲/▼ in der Farbreihe), markiert als „etwas anderer Farbton“. Es wird nie eine Farbe erfunden.',
  'w5fu.shade.noLighter': 'Keine hellere Farbe in der Palette – {src}.',
  'w5fu.shade.noDarker': 'Keine dunklere Farbe in der Palette – {src}.',
  'w5fu.shade.noneBoth': 'Keine hellere oder dunklere Farbe in der Palette – {src}.',
  'w5fu.shade.otherLighter': '▲ Heller: kein hellerer Ton genau dieses Farbtons in der Palette – vorgeschlagen ist die ähnlichste hellere Farbe.',
  'w5fu.shade.otherDarker': '▼ Dunkler: kein dunklerer Ton genau dieses Farbtons in der Palette – vorgeschlagen ist die ähnlichste dunklere Farbe.',
  'w5fu.shade.otherBoth': 'Kein hellerer oder dunklerer Ton genau dieses Farbtons in der Palette – vorgeschlagen sind die ähnlichsten helleren bzw. dunkleren Farben.',

  // ---- Bedienhinweise je Gerät (Maus: anklicken, Finger: antippen)
  'w5fu.hoverIdle.touch': 'Stein-ID und Lage in mm (ab der oberen linken Ecke von A001) zeigt das Steindetail.',
  'w5fu.previewHint.fine': 'Ziehen zum Verschieben, Mausrad zum Zoomen, Stein anklicken für Details.',
  'w5fu.previewHint.coarse':
    'Ziehen zum Verschieben, mit zwei Fingern zoomen, Stein antippen für Details. Kleine Steine: erstes Antippen vergrößert, zweites öffnet das Steindetail.',
  'w5fu.toolHint.off.fine': 'Anklicken öffnet das Steindetail. Verlegemodus einschalten, dann markiert Anklicken Steine als verlegt.',
  'w5fu.toolHint.off.coarse':
    'Antippen öffnet das Steindetail. Verlegemodus einschalten, dann markiert Antippen Steine als verlegt. Kleine Steine: erstes Antippen vergrößert, zweites öffnet das Steindetail.',
  'w5fu.toolHint.tap.fine': 'Anklicken markiert Steine als verlegt (statt das Steindetail zu öffnen); erneutes Anklicken macht sie wieder offen.',
  'w5fu.toolHint.tap.coarse':
    'Antippen markiert Steine als verlegt (statt das Steindetail zu öffnen). Kleine Steine: erstes Antippen vergrößert, zweites markiert. Langes Drücken zählt nicht.',
  'w5fu.idle.view.fine': 'Anklicken öffnet das Steindetail mit Farbe, Größe und Schnittanweisung.',
  'w5fu.idle.view.coarse': 'Antippen öffnet das Steindetail mit Farbe, Größe und Schnittanweisung.',
  'w5fu.idle.tap.fine': 'Klicken: Stein als verlegt markieren – erneutes Klicken macht ihn wieder offen.',
  'w5fu.idle.tap.coarse': 'Antippen: Stein als verlegt markieren – erneutes Antippen macht ihn wieder offen.',
  'w5fu.pick.hint.fine':
    'Abschnitt anklicken: an- oder abwählen (sind alle gewählt, wird nur dieser gewählt). Buchstabe oder Nummer am Rand: ganze Zeile bzw. Spalte.',
  'w5fu.pick.hint.coarse':
    'Abschnitt antippen: an- oder abwählen (sind alle gewählt, wird nur dieser gewählt). Buchstabe oder Nummer am Rand: ganze Zeile bzw. Spalte.',
  'w5fu.chips.hint.fine': 'Anklicken hebt eine Farbe hervor; „Nächster Stein“ zeigt dann nur Steine dieser Farbe.',
  'w5fu.chips.hint.coarse': 'Antippen hebt eine Farbe hervor; „Nächster Stein“ zeigt dann nur Steine dieser Farbe.',
  'w5fu.chips.hintView.fine': 'Anklicken hebt eine Farbe hervor.',
  'w5fu.chips.hintView.coarse': 'Antippen hebt eine Farbe hervor.',
};

export const en: Record<string, string> = {
  'w5fu.short.totalPartial': 'To buy for materials with recorded stock: {n} raw tiles',
  'w5fu.short.partialNote': 'Not included: materials without recorded stock and colours without material – how much to buy there is unknown.',

  'w5fu.shade.otherHue': 'slightly different hue',
  'w5fu.shade.titleOther': '{code} {name} · L* {dl} · ΔE {de} · slightly different hue',
  'w5fu.shade.rule':
    'First the next palette colour of the same hue (3 to 20 L* lighter or darker, colour position at most 10 Δa*b*, hue at most 8 ΔH). If there is none, the most similar lighter or darker palette colour (like ▲/▼ in the colour row), marked “slightly different hue”. No colour is ever invented.',
  'w5fu.shade.noLighter': 'No lighter colour in the palette – {src}.',
  'w5fu.shade.noDarker': 'No darker colour in the palette – {src}.',
  'w5fu.shade.noneBoth': 'No lighter or darker colour in the palette – {src}.',
  'w5fu.shade.otherLighter': '▲ Lighter: no lighter shade of exactly this hue in the palette – the most similar lighter colour is suggested.',
  'w5fu.shade.otherDarker': '▼ Darker: no darker shade of exactly this hue in the palette – the most similar darker colour is suggested.',
  'w5fu.shade.otherBoth': 'No lighter or darker shade of exactly this hue in the palette – the most similar lighter and darker colours are suggested.',

  'w5fu.hoverIdle.touch': 'The tile details show the tile ID and position in mm (from the top-left corner of A001).',
  'w5fu.previewHint.fine': 'Drag to pan, mouse wheel to zoom, click a tile for details.',
  'w5fu.previewHint.coarse': 'Drag to pan, two fingers to zoom, tap a tile for details. Small tiles: the first tap zooms in, the second opens the tile details.',
  'w5fu.toolHint.off.fine': 'Clicking opens the tile details. Turn on laying mode, then clicking marks tiles as laid.',
  'w5fu.toolHint.off.coarse':
    'Tapping opens the tile details. Turn on laying mode, then tapping marks tiles as laid. Small tiles: the first tap zooms in, the second opens the tile details.',
  'w5fu.toolHint.tap.fine': 'Clicking marks tiles as laid (instead of opening the tile details); clicking again makes them open again.',
  'w5fu.toolHint.tap.coarse': 'Tapping marks tiles as laid (instead of opening the tile details). Small tiles: the first tap zooms in, the second marks. Long presses do not count.',
  'w5fu.idle.view.fine': 'Click a tile to open its details with colour, size and cutting instructions.',
  'w5fu.idle.view.coarse': 'Tap a tile to open its details with colour, size and cutting instructions.',
  'w5fu.idle.tap.fine': 'Click: mark a tile as laid – click again to make it open again.',
  'w5fu.idle.tap.coarse': 'Tap: mark a tile as laid – tap again to make it open again.',
  'w5fu.pick.hint.fine': 'Click a section to select or deselect it (if all are selected, only this one is selected). Letter or number at the edge: whole row or column.',
  'w5fu.pick.hint.coarse': 'Tap a section to select or deselect it (if all are selected, only this one is selected). Letter or number at the edge: whole row or column.',
  'w5fu.chips.hint.fine': 'Click to highlight a colour; “Next tile” then only shows tiles of that colour.',
  'w5fu.chips.hint.coarse': 'Tap to highlight a colour; “Next tile” then only shows tiles of that colour.',
  'w5fu.chips.hintView.fine': 'Click to highlight a colour.',
  'w5fu.chips.hintView.coarse': 'Tap to highlight a colour.',
};

export const tr: Record<string, string> = {
  'w5fu.short.totalPartial': 'Stoku kayıtlı malzemeler için alınacak: {n} ham taş',
  'w5fu.short.partialNote': 'Dahil değil: stoku kayıtlı olmayan malzemeler ve malzemesiz renkler – orada ne kadar alınacağı belirsiz.',

  'w5fu.shade.otherHue': 'biraz farklı ton',
  'w5fu.shade.titleOther': '{code} {name} · L* {dl} · ΔE {de} · biraz farklı ton',
  'w5fu.shade.rule':
    'Önce aynı tondaki bir sonraki palet rengi (3 ile 20 L* arası daha açık veya daha koyu, renk konumu en fazla 10 Δa*b*, ton en fazla 8 ΔH). Yoksa en benzer daha açık veya daha koyu palet rengi (renk dizisindeki ▲/▼ gibi), “biraz farklı ton” olarak işaretlenir. Hiçbir zaman renk uydurulmaz.',
  'w5fu.shade.noLighter': 'Palette daha açık bir renk yok – {src}.',
  'w5fu.shade.noDarker': 'Palette daha koyu bir renk yok – {src}.',
  'w5fu.shade.noneBoth': 'Palette daha açık veya daha koyu bir renk yok – {src}.',
  'w5fu.shade.otherLighter': '▲ Daha açık: palette tam bu tonun daha açığı yok – en benzer daha açık renk öneriliyor.',
  'w5fu.shade.otherDarker': '▼ Daha koyu: palette tam bu tonun daha koyusu yok – en benzer daha koyu renk öneriliyor.',
  'w5fu.shade.otherBoth': 'Palette tam bu tonun daha açığı veya daha koyusu yok – en benzer daha açık ve daha koyu renkler öneriliyor.',

  'w5fu.hoverIdle.touch': 'Taş kimliğini ve mm cinsinden konumu (A001’in sol üst köşesinden) taş ayrıntısı gösterir.',
  'w5fu.previewHint.fine': 'Kaydırmak için sürükleyin, yakınlaştırmak için fare tekerleği, ayrıntı için taşa tıklayın.',
  'w5fu.previewHint.coarse':
    'Kaydırmak için sürükleyin, iki parmakla yakınlaştırın, ayrıntı için taşa dokunun. Küçük taşlar: ilk dokunuş yakınlaştırır, ikincisi taş ayrıntısını açar.',
  'w5fu.toolHint.off.fine': 'Tıklamak taş ayrıntısını açar. Döşeme modunu açın, sonra tıklamak taşları döşendi olarak işaretler.',
  'w5fu.toolHint.off.coarse':
    'Dokunmak taş ayrıntısını açar. Döşeme modunu açın, sonra dokunmak taşları döşendi olarak işaretler. Küçük taşlar: ilk dokunuş yakınlaştırır, ikincisi taş ayrıntısını açar.',
  'w5fu.toolHint.tap.fine': 'Tıklamak taşları döşendi olarak işaretler (taş ayrıntısını açmak yerine); yeniden tıklamak onları tekrar açık yapar.',
  'w5fu.toolHint.tap.coarse':
    'Dokunmak taşları döşendi olarak işaretler (taş ayrıntısını açmak yerine). Küçük taşlar: ilk dokunuş yakınlaştırır, ikincisi işaretler. Uzun basmak sayılmaz.',
  'w5fu.idle.view.fine': 'Bir taşa tıklamak renk, boyut ve kesim talimatıyla ayrıntılarını açar.',
  'w5fu.idle.view.coarse': 'Bir taşa dokunmak renk, boyut ve kesim talimatıyla ayrıntılarını açar.',
  'w5fu.idle.tap.fine': 'Tıkla: taşı döşendi olarak işaretle – yeniden tıklamak onu tekrar açık yapar.',
  'w5fu.idle.tap.coarse': 'Dokun: taşı döşendi olarak işaretle – yeniden dokunmak onu tekrar açık yapar.',
  'w5fu.pick.hint.fine': 'Bölüme tıklayın: seçin veya seçimi kaldırın (hepsi seçiliyse yalnızca bu seçilir). Kenardaki harf veya numara: tüm satır veya sütun.',
  'w5fu.pick.hint.coarse': 'Bölüme dokunun: seçin veya seçimi kaldırın (hepsi seçiliyse yalnızca bu seçilir). Kenardaki harf veya numara: tüm satır veya sütun.',
  'w5fu.chips.hint.fine': 'Bir rengi vurgulamak için tıklayın; “Sonraki taş” bu durumda yalnızca o rengin taşlarını gösterir.',
  'w5fu.chips.hint.coarse': 'Bir rengi vurgulamak için dokunun; “Sonraki taş” bu durumda yalnızca o rengin taşlarını gösterir.',
  'w5fu.chips.hintView.fine': 'Bir rengi vurgulamak için tıklayın.',
  'w5fu.chips.hintView.coarse': 'Bir rengi vurgulamak için dokunun.',
};
