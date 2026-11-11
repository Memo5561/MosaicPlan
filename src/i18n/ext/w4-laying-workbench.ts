/**
 * Texte für w4-laying-workbench: Werkbank „Verlegen“ in Schritt 9 (Abschnittsfokus, offene Steine je Farbe,
 * Tippen/Malen/Rechteck, Rückgängig, Karte „Nächster Stein“, Bildschirm wach halten, Stein suchen) und die
 * eigene Ansicht „Material & Einkauf“. Überschreibt keine bestehenden Schlüssel.
 */
export const de: Record<string, string> = {
  'w4lw.view.aria': 'Ansicht des Verlegeplans',
  'w4lw.view.lay': 'Verlegen',
  'w4lw.view.material': 'Material & Einkauf',

  'w4lw.tool.aria': 'Markieren durch',
  'w4lw.tool.tap': 'Tippen',
  'w4lw.tool.paint': 'Malen',
  'w4lw.tool.rect': 'Rechteck',
  'w4lw.toolHint.paint':
    'Malen: mit einem Finger oder der Maus über die Steine ziehen – alle berührten werden als verlegt markiert (war der erste schon verlegt: wieder offen). Verschieben: zwei Finger, Leertaste oder mittlere Maustaste. Am Handy bei kleinen Steinen erst hineinzoomen (einmal antippen).',
  'w4lw.toolHint.rect': 'Rechteck: über die Steine ziehen, danach bestätigen. Verschieben: zwei Finger, Leertaste oder mittlere Maustaste.',

  'w4lw.idle.view': 'Antippen öffnet das Steindetail mit Farbe, Größe und Schnittanweisung.',
  'w4lw.idle.tap': 'Tippen: Stein als verlegt markieren – erneutes Tippen macht ihn wieder offen.',
  'w4lw.idle.paint': 'Malen: mit einem Finger oder der Maus über die Steine ziehen (kleine Steine: erst antippen = hineinzoomen).',
  'w4lw.idle.rect': 'Rechteck: über die Steine ziehen, danach bestätigen.',

  'w4lw.undo': 'Rückgängig ({n})',
  'w4lw.undoLabel': 'Rückgängig',
  // 'w4lw.undoTitle': Text steht in w5-undo-editing.ts (gilt dort zur Laufzeit; keine Doppeldefinition)
  // 'w4lw.undoNote': Text steht in w5-undo-editing.ts (gilt dort zur Laufzeit; keine Doppeldefinition)
  'w4lw.undone': 'Rückgängig gemacht: {what}',

  'w4lw.st.laidOne': '{id} als verlegt markiert',
  'w4lw.st.openOne': '{id} wieder offen',
  'w4lw.st.laidN': '{n} Steine als verlegt markiert',
  'w4lw.st.laidN.one': '{n} Stein als verlegt markiert',
  'w4lw.st.openN': '{n} Steine wieder offen',
  'w4lw.st.openN.one': '{n} Stein wieder offen',
  'w4lw.st.nothing': 'Keine Änderung – diese Steine hatten schon diesen Zustand.',
  'w4lw.st.sectionDone': '{sec}: alle {total} Steine verlegt – {n} davon neu markiert',
  'w4lw.st.sectionReset': '{sec} zurückgesetzt – {n} Steine wieder offen',
  'w4lw.st.range': '{from} – {to}: {what}',
  'w4lw.st.row': 'Reihe {row} {scope}: {what}',
  'w4lw.st.found': '{id} gefunden',

  'w4lw.rect.ask': '{from} – {to}: {total} Steine, davon {placed} schon verlegt.',
  'w4lw.rect.lay': '{n} als verlegt markieren',
  'w4lw.rect.open': '{n} wieder offen setzen',

  'w4lw.outside.ask': 'Stein {id} gehört zu Abschnitt {sec} – wechseln?',
  'w4lw.outside.switch': 'Zu {sec} wechseln',

  'w4lw.scope.sec': 'in {sec}',
  'w4lw.scope.all': 'im ganzen Mosaik',
  'w4lw.focusNote': 'Nur Abschnitt {sec} ist aktiv – Antippen, Malen und Rechtecke ändern keine Steine außerhalb.',

  'w4lw.next.open': 'Nächster Stein',
  'w4lw.next.openTitle': 'Karte mit dem nächsten offenen Stein, seiner Farbe, Größe und Schnittanweisung',
  'w4lw.next.title': 'Nächster Stein',
  'w4lw.next.pos': 'Nr. {pos} von {total} · {open} offen {scope}',
  'w4lw.next.onlyColor': 'nur Farbe {code}',
  'w4lw.next.layNext': '✓ verlegt & weiter',
  'w4lw.next.back': 'zurück',
  'w4lw.next.skip': 'überspringen',
  'w4lw.next.rowDone': 'Reihe fertig',
  'w4lw.next.rowDoneTitle': 'Alle Steine dieser Zeile {scope} als verlegt markieren (bei hervorgehobener Farbe nur diese Farbe)',
  'w4lw.next.details': 'Details',
  'w4lw.next.close': 'Karte schließen',
  'w4lw.next.order': 'Reihenfolge',
  'w4lw.next.orderRow': 'Reihe',
  'w4lw.next.orderColor': 'Farbe',
  'w4lw.next.orderHint': 'Reihe: Zeile für Zeile in Schlangenlinie. Farbe: Farbe für Farbe nach Farbnummer, darin Zeile für Zeile.',
  'w4lw.next.allDone': 'Alle Steine {scope} sind verlegt.',
  'w4lw.next.allDoneColor': 'Alle Steine der Farbe {code} {scope} sind verlegt.',
  'w4lw.next.laid': 'verlegt',
  'w4lw.next.where': 'Zeile {row} · Spalte {col}',
  'w4lw.next.size': '{w} × {h} mm',

  'w4lw.chips.title': 'Farben {scope}',
  'w4lw.chips.open': '{open}/{total} offen',
  'w4lw.chips.done': '✓ fertig',
  'w4lw.chips.sum': 'Σ {open} von {total} Steinen offen',
  'w4lw.chips.hint': 'Antippen hebt eine Farbe hervor; „Nächster Stein“ zeigt dann nur Steine dieser Farbe.',
  'w4lw.chips.clear': 'Hervorhebung aufheben',

  'w4lw.sec.all': 'Ganzes Mosaik',
  'w4lw.sec.allTitle': 'Abschnitt abwählen und das ganze Mosaik zeigen',
  'w4lw.sec.settings': 'Abschnitte einteilen',
  'w4lw.sec.pdf': 'PDF {sec}',
  'w4lw.sec.pdfTitle': 'Verlegeplan-PDF nur für Abschnitt {sec} vorbereiten (Auswahl in Schritt 10 änderbar)',

  'w4lw.csvError': 'CSV-Export fehlgeschlagen: {msg}. Bitte abschnittsweise exportieren.',

  'w4lw.wake.on': 'Bildschirm bleibt an, solange der Verlegemodus aktiv ist.',
  'w4lw.wake.unsupported': 'Bildschirm wach halten: von diesem Browser bzw. dieser App nicht unterstützt – bitte die automatische Bildschirmsperre selbst verlängern.',
  'w4lw.wake.denied': 'Bildschirm wach halten wurde abgelehnt (z. B. im Energiesparmodus).',

  'w4lw.find.notFound': 'Stein „{id}“ nicht gefunden – gültig: {first} bis {last} (geteilte Steine mit -1, -2 …)',
  'w4lw.find.pieceNotFound': '{cell} hat nur {n} Teilstücke ({cell}-1 bis {cell}-{n}).',
  'w4lw.find.pieceNotFound.one': '{cell} ist ein ganzer Stein – bitte ohne „-…“ eingeben.',
  'w4lw.find.noPieces': '{cell} enthält keine Steine.',
};

export const en: Record<string, string> = {
  'w4lw.view.aria': 'Laying plan view',
  'w4lw.view.lay': 'Laying',
  'w4lw.view.material': 'Materials & shopping',

  'w4lw.tool.aria': 'Mark by',
  'w4lw.tool.tap': 'Tap',
  'w4lw.tool.paint': 'Paint',
  'w4lw.tool.rect': 'Rectangle',
  'w4lw.toolHint.paint':
    'Paint: drag one finger or the mouse across the tiles – every tile touched is marked as laid (if the first one was already laid: open again). Pan: two fingers, space bar or middle mouse button. On a phone, zoom in first if the tiles are small (tap once).',
  'w4lw.toolHint.rect': 'Rectangle: drag across the tiles, then confirm. Pan: two fingers, space bar or middle mouse button.',

  'w4lw.idle.view': 'Tap a tile to open its details with colour, size and cutting instructions.',
  'w4lw.idle.tap': 'Tap: mark a tile as laid – tap again to make it open again.',
  'w4lw.idle.paint': 'Paint: drag one finger or the mouse across the tiles (small tiles: tap first to zoom in).',
  'w4lw.idle.rect': 'Rectangle: drag across the tiles, then confirm.',

  'w4lw.undo': 'Undo ({n})',
  'w4lw.undoLabel': 'Undo',
  // 'w4lw.undoTitle': Text steht in w5-undo-editing.ts (gilt dort zur Laufzeit; keine Doppeldefinition)
  // 'w4lw.undoNote': Text steht in w5-undo-editing.ts (gilt dort zur Laufzeit; keine Doppeldefinition)
  'w4lw.undone': 'Undone: {what}',

  'w4lw.st.laidOne': '{id} marked as laid',
  'w4lw.st.openOne': '{id} open again',
  'w4lw.st.laidN': '{n} tiles marked as laid',
  'w4lw.st.laidN.one': '{n} tile marked as laid',
  'w4lw.st.openN': '{n} tiles open again',
  'w4lw.st.openN.one': '{n} tile open again',
  'w4lw.st.nothing': 'No change – these tiles already had this state.',
  'w4lw.st.sectionDone': '{sec}: all {total} tiles laid – {n} newly marked',
  'w4lw.st.sectionReset': '{sec} reset – {n} tiles open again',
  'w4lw.st.range': '{from} – {to}: {what}',
  'w4lw.st.row': 'Row {row} {scope}: {what}',
  'w4lw.st.found': '{id} found',

  'w4lw.rect.ask': '{from} – {to}: {total} tiles, {placed} of them already laid.',
  'w4lw.rect.lay': 'Mark {n} as laid',
  'w4lw.rect.open': 'Set {n} back to open',

  'w4lw.outside.ask': 'Tile {id} belongs to section {sec} – switch?',
  'w4lw.outside.switch': 'Switch to {sec}',

  'w4lw.scope.sec': 'in {sec}',
  'w4lw.scope.all': 'in the whole mosaic',
  'w4lw.focusNote': 'Only section {sec} is active – tapping, painting and rectangles do not change tiles outside it.',

  'w4lw.next.open': 'Next tile',
  'w4lw.next.openTitle': 'Card with the next open tile, its colour, size and cutting instructions',
  'w4lw.next.title': 'Next tile',
  'w4lw.next.pos': 'No. {pos} of {total} · {open} open {scope}',
  'w4lw.next.onlyColor': 'colour {code} only',
  'w4lw.next.layNext': '✓ laid & next',
  'w4lw.next.back': 'back',
  'w4lw.next.skip': 'skip',
  'w4lw.next.rowDone': 'Row done',
  'w4lw.next.rowDoneTitle': 'Mark all tiles of this row {scope} as laid (with a highlighted colour: only that colour)',
  'w4lw.next.details': 'Details',
  'w4lw.next.close': 'Close card',
  'w4lw.next.order': 'Order',
  'w4lw.next.orderRow': 'Row',
  'w4lw.next.orderColor': 'Colour',
  'w4lw.next.orderHint': 'Row: row by row in a serpentine. Colour: colour by colour by colour number, row by row within each colour.',
  'w4lw.next.allDone': 'All tiles {scope} are laid.',
  'w4lw.next.allDoneColor': 'All tiles of colour {code} {scope} are laid.',
  'w4lw.next.laid': 'laid',
  'w4lw.next.where': 'Row {row} · column {col}',
  'w4lw.next.size': '{w} × {h} mm',

  'w4lw.chips.title': 'Colours {scope}',
  'w4lw.chips.open': '{open}/{total} open',
  'w4lw.chips.done': '✓ done',
  'w4lw.chips.sum': 'Σ {open} of {total} tiles open',
  'w4lw.chips.hint': 'Tap to highlight a colour; “Next tile” then only shows tiles of that colour.',
  'w4lw.chips.clear': 'Clear highlight',

  'w4lw.sec.all': 'Whole mosaic',
  'w4lw.sec.allTitle': 'Deselect the section and show the whole mosaic',
  'w4lw.sec.settings': 'Divide into sections',
  'w4lw.sec.pdf': 'PDF {sec}',
  'w4lw.sec.pdfTitle': 'Prepare the laying plan PDF for section {sec} only (selection can be changed in step 10)',

  'w4lw.csvError': 'CSV export failed: {msg}. Please export section by section.',

  'w4lw.wake.on': 'The screen stays on while laying mode is active.',
  'w4lw.wake.unsupported': 'Keep screen on: not supported by this browser or app – please extend the automatic screen lock yourself.',
  'w4lw.wake.denied': 'Keeping the screen on was refused (e.g. in battery saver mode).',

  'w4lw.find.notFound': 'Tile “{id}” not found – valid: {first} to {last} (split tiles with -1, -2 …)',
  'w4lw.find.pieceNotFound': '{cell} only has {n} pieces ({cell}-1 to {cell}-{n}).',
  'w4lw.find.pieceNotFound.one': '{cell} is a whole tile – please enter it without “-…”.',
  'w4lw.find.noPieces': '{cell} contains no tiles.',
};

export const tr: Record<string, string> = {
  'w4lw.view.aria': 'Döşeme planı görünümü',
  'w4lw.view.lay': 'Döşeme',
  'w4lw.view.material': 'Malzeme ve alışveriş',

  'w4lw.tool.aria': 'İşaretleme yöntemi',
  'w4lw.tool.tap': 'Dokun',
  'w4lw.tool.paint': 'Boya',
  'w4lw.tool.rect': 'Dikdörtgen',
  'w4lw.toolHint.paint':
    'Boya: tek parmakla veya fareyle taşların üzerinde sürükleyin – dokunulan her taş döşendi olarak işaretlenir (ilk taş zaten döşenmişse: yeniden açık). Kaydırma: iki parmak, boşluk tuşu veya farenin orta tuşu. Telefonda taşlar küçükse önce yakınlaştırın (bir kez dokunun).',
  'w4lw.toolHint.rect': 'Dikdörtgen: taşların üzerinde sürükleyin, ardından onaylayın. Kaydırma: iki parmak, boşluk tuşu veya farenin orta tuşu.',

  'w4lw.idle.view': 'Bir taşa dokunmak renk, boyut ve kesim talimatıyla ayrıntılarını açar.',
  'w4lw.idle.tap': 'Dokun: taşı döşendi olarak işaretle – yeniden dokunmak onu tekrar açık yapar.',
  'w4lw.idle.paint': 'Boya: tek parmakla veya fareyle taşların üzerinde sürükleyin (küçük taşlar: önce dokunarak yakınlaştırın).',
  'w4lw.idle.rect': 'Dikdörtgen: taşların üzerinde sürükleyin, ardından onaylayın.',

  'w4lw.undo': 'Geri al ({n})',
  'w4lw.undoLabel': 'Geri al',
  // 'w4lw.undoTitle': Text steht in w5-undo-editing.ts (gilt dort zur Laufzeit; keine Doppeldefinition)
  // 'w4lw.undoNote': Text steht in w5-undo-editing.ts (gilt dort zur Laufzeit; keine Doppeldefinition)
  'w4lw.undone': 'Geri alındı: {what}',

  'w4lw.st.laidOne': '{id} döşendi olarak işaretlendi',
  'w4lw.st.openOne': '{id} yeniden açık',
  'w4lw.st.laidN': '{n} taş döşendi olarak işaretlendi',
  'w4lw.st.laidN.one': '{n} taş döşendi olarak işaretlendi',
  'w4lw.st.openN': '{n} taş yeniden açık',
  'w4lw.st.openN.one': '{n} taş yeniden açık',
  'w4lw.st.nothing': 'Değişiklik yok – bu taşlar zaten bu durumdaydı.',
  'w4lw.st.sectionDone': '{sec}: {total} taşın tümü döşendi – {n} tanesi yeni işaretlendi',
  'w4lw.st.sectionReset': '{sec} sıfırlandı – {n} taş yeniden açık',
  'w4lw.st.range': '{from} – {to}: {what}',
  'w4lw.st.row': 'Satır {row} {scope}: {what}',
  'w4lw.st.found': '{id} bulundu',

  'w4lw.rect.ask': '{from} – {to}: {total} taş, bunların {placed} tanesi zaten döşendi.',
  'w4lw.rect.lay': '{n} taşı döşendi olarak işaretle',
  'w4lw.rect.open': '{n} taşı yeniden açık yap',

  'w4lw.outside.ask': '{id} taşı {sec} bölümüne ait – geçilsin mi?',
  'w4lw.outside.switch': '{sec} bölümüne geç',

  'w4lw.scope.sec': '{sec} içinde',
  'w4lw.scope.all': 'tüm mozaikte',
  'w4lw.focusNote': 'Yalnızca {sec} bölümü etkin – dokunma, boyama ve dikdörtgenler dışarıdaki taşları değiştirmez.',

  'w4lw.next.open': 'Sonraki taş',
  'w4lw.next.openTitle': 'Sonraki açık taşı, rengini, boyutunu ve kesim talimatını gösteren kart',
  'w4lw.next.title': 'Sonraki taş',
  'w4lw.next.pos': '{total} içinde {pos}. · {scope} {open} açık',
  'w4lw.next.onlyColor': 'yalnızca {code} rengi',
  'w4lw.next.layNext': '✓ döşendi ve devam',
  'w4lw.next.back': 'geri',
  'w4lw.next.skip': 'atla',
  'w4lw.next.rowDone': 'Satır bitti',
  'w4lw.next.rowDoneTitle': 'Bu satırdaki tüm taşları ({scope}) döşendi olarak işaretle (vurgulanan renk varsa yalnızca o renk)',
  'w4lw.next.details': 'Ayrıntılar',
  'w4lw.next.close': 'Kartı kapat',
  'w4lw.next.order': 'Sıra',
  'w4lw.next.orderRow': 'Satır',
  'w4lw.next.orderColor': 'Renk',
  'w4lw.next.orderHint': 'Satır: yılan biçiminde satır satır. Renk: renk numarasına göre renk renk, her rengin içinde satır satır.',
  'w4lw.next.allDone': '{scope} tüm taşlar döşendi.',
  'w4lw.next.allDoneColor': '{scope} {code} rengindeki tüm taşlar döşendi.',
  'w4lw.next.laid': 'döşendi',
  'w4lw.next.where': 'Satır {row} · sütun {col}',
  'w4lw.next.size': '{w} × {h} mm',

  'w4lw.chips.title': 'Renkler ({scope})',
  'w4lw.chips.open': '{open}/{total} açık',
  'w4lw.chips.done': '✓ bitti',
  'w4lw.chips.sum': 'Σ {total} taştan {open} açık',
  'w4lw.chips.hint': 'Bir rengi vurgulamak için dokunun; “Sonraki taş” bu durumda yalnızca o rengin taşlarını gösterir.',
  'w4lw.chips.clear': 'Vurguyu kaldır',

  'w4lw.sec.all': 'Tüm mozaik',
  'w4lw.sec.allTitle': 'Bölüm seçimini kaldır ve tüm mozaiği göster',
  'w4lw.sec.settings': 'Bölümlere ayır',
  'w4lw.sec.pdf': 'PDF {sec}',
  'w4lw.sec.pdfTitle': 'Döşeme planı PDF’ini yalnızca {sec} bölümü için hazırla (seçim 10. adımda değiştirilebilir)',

  'w4lw.csvError': 'CSV dışa aktarımı başarısız: {msg}. Lütfen bölüm bölüm dışa aktarın.',

  'w4lw.wake.on': 'Döşeme modu etkin olduğu sürece ekran açık kalır.',
  'w4lw.wake.unsupported': 'Ekranı açık tutma: bu tarayıcı veya uygulama desteklemiyor – lütfen otomatik ekran kilidini kendiniz uzatın.',
  'w4lw.wake.denied': 'Ekranı açık tutma reddedildi (ör. pil tasarrufu modunda).',

  'w4lw.find.notFound': '“{id}” taşı bulunamadı – geçerli: {first} ile {last} arası (bölünmüş taşlarda -1, -2 …)',
  'w4lw.find.pieceNotFound': '{cell} yalnızca {n} parçadan oluşuyor ({cell}-1 ile {cell}-{n} arası).',
  'w4lw.find.pieceNotFound.one': '{cell} bütün bir taş – lütfen “-…” olmadan girin.',
  'w4lw.find.noPieces': '{cell} hiç taş içermiyor.',
};
