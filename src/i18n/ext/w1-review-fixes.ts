/**
 * Texte der Nachbesserungen nach dem Review von Welle 1: Fehlergrenze, Palettenkonflikt bei der
 * Berechnung, nicht angezeigtes gespeichertes Mosaik (verlegte Steine), reparierte Zellen,
 * Einkaufsliste je Material (Verlegeplan und PDF), Einschnitte im PDF.
 */
export const de: Record<string, string> = {
  'crash.title': 'Diese Ansicht konnte nicht angezeigt werden',
  'crash.text':
    'Beim Anzeigen ist ein unerwarteter Fehler aufgetreten. Ihre Projekte und Materialien liegen im Gerätespeicher; was bis eben gespeichert war, bleibt erhalten. Laden Sie die Seite neu oder gehen Sie zur Startseite.',
  'crash.reload': 'Neu laden',
  'crash.home': 'Zur Startseite',
  'crash.details': 'Technische Angaben',

  'compute.err.palette-changed':
    'Die eigene Palette wurde während der Berechnung verkürzt oder umsortiert (z. B. in einem anderen Tab). Das Ergebnis passt nicht mehr dazu und wurde verworfen – Palette und bisheriges Mosaik bleiben unverändert. Bitte neu berechnen.',

  'integrity.goCompute': 'Zu Schritt 7 (Berechnen)',
  'integrity.placedLoss':
    'Das gespeicherte Mosaik enthält {n} als verlegt markierte Steine. Beim Neuberechnen geht dieser Verlegefortschritt verloren. Sichern Sie das Projekt vorher, wenn Sie den Stand behalten möchten.',
  'integrity.placedLoss.one':
    'Das gespeicherte Mosaik enthält {n} als verlegt markierten Stein. Beim Neuberechnen geht dieser Verlegefortschritt verloren. Sichern Sie das Projekt vorher, wenn Sie den Stand behalten möchten.',
  'integrity.download': 'Sicherung herunterladen',
  'integrity.copy': 'Als Kopie sichern',
  'integrity.copied': 'Kopie „{name}“ angelegt (unter „Meine Projekte“).',
  'integrity.failed': 'Sicherung fehlgeschlagen: {msg}',

  'repair.notice':
    '{n} Zellen aus einer älteren Version hatten leere Teile (Fuge breiter als der Stein). Sie wurden in ganze Steine umgewandelt, ihr Verlegestatus wurde zurückgesetzt.',
  'repair.notice.one':
    '{n} Zelle aus einer älteren Version hatte leere Teile (Fuge breiter als der Stein). Sie wurde in einen ganzen Stein umgewandelt, ihr Verlegestatus wurde zurückgesetzt.',

  'plan.invalidPieces': 'Ungültige Teile ohne Fläche (nicht gezählt) – Zelle im Steindetail auf „Ganzer Stein“ setzen',

  'plan.shop.title': 'Einkaufsliste je Material',
  'plan.shop.material': 'Material',
  'plan.shop.colors': 'Farben',
  'plan.shop.need': 'Bedarf',
  'plan.shop.stock': 'Bestand',
  'plan.shop.toBuy': 'kaufen',
  'plan.shop.packs': 'Pack.',
  'plan.shop.cost': 'Kosten',
  'plan.shop.noMaterial': 'ohne Material',
  'plan.shop.sum': 'Summe',
  'plan.shop.hint':
    'Je Material zusammengefasst: Ein Material, das mehreren Farben zugeordnet ist, wird nur einmal gekauft. „kaufen“ = Bedarf − erfasster Bestand (Bestand 0 zählt als erfasst; rot, wenn etwas fehlt). Pack. = Packungen für den ganzen Bedarf, in Klammern für den Fehlbestand. Kosten = Packungen × Preis.',
  'plan.shop.incomplete': 'Kosten unvollständig: Nicht jedes Material hat Packungsgröße und Preis, oder Farben haben kein Material.',

  'pdf.shopTitle': 'Einkaufsliste je Material',
  'pdf.shopColors': 'Farben',
  'pdf.stock': 'Bestand',
  'pdf.toBuy': 'Zu kaufen',
  'pdf.costCol': 'Kosten',
  'pdf.shopHint':
    'Je Material zusammengefasst (ein Material für mehrere Farben wird einmal gekauft). Die Summe der Kosten entspricht den Materialkosten oben. Zu kaufen = Bedarf − Bestand; Packungen in Klammern: für den Fehlbestand.',
  'pdf.perColorHint': 'Bedarf je Farbe (Rohsteine mit Reserve). Packungen und Kosten stehen in der Einkaufsliste je Material.',
  'pdf.notchLine': 'Einschnitt {i}: ({x1}; {y1}) → Innenecke ({x2}; {y2}) – nicht durchritzen',
  'pdf.notchEdgeLine': 'Einschnitt {i}: ({x1}; {y1}) → Steinkante ({x2}; {y2}) – nicht durchritzen',
  // 'pdf.templatesHint': Text steht in w5-pdf-content.ts (gilt dort zur Laufzeit; keine Doppeldefinition)
  'pdf.templateMore': '… weitere Angaben im Steindetail der App',
};

export const en: Record<string, string> = {
  'crash.title': 'This view could not be displayed',
  'crash.text':
    'An unexpected error occurred while displaying it. Your projects and materials are stored on this device; everything saved up to now is kept. Reload the page or go to the home page.',
  'crash.reload': 'Reload',
  'crash.home': 'Home page',
  'crash.details': 'Technical details',

  'compute.err.palette-changed':
    'The custom palette was shortened or reordered during the calculation (e.g. in another tab). The result no longer matches it and was discarded – the palette and the previous mosaic stay unchanged. Please compute again.',

  'integrity.goCompute': 'Go to step 7 (Compute)',
  'integrity.placedLoss':
    'The saved mosaic contains {n} tiles marked as laid. Recomputing loses this laying progress. Back up the project first if you want to keep it.',
  'integrity.placedLoss.one':
    'The saved mosaic contains {n} tile marked as laid. Recomputing loses this laying progress. Back up the project first if you want to keep it.',
  'integrity.download': 'Download backup',
  'integrity.copy': 'Save as copy',
  'integrity.copied': 'Copy “{name}” created (under “My projects”).',
  'integrity.failed': 'Backup failed: {msg}',

  'repair.notice':
    '{n} cells from an older version had empty pieces (joint wider than the tile). They were turned into whole tiles and their laid status was reset.',
  'repair.notice.one':
    '{n} cell from an older version had empty pieces (joint wider than the tile). It was turned into a whole tile and its laid status was reset.',

  'plan.invalidPieces': 'Invalid pieces without area (not counted) – set the cell to “Whole tile” in the tile details',

  'plan.shop.title': 'Shopping list per material',
  'plan.shop.material': 'Material',
  'plan.shop.colors': 'Colours',
  'plan.shop.need': 'Need',
  'plan.shop.stock': 'Stock',
  'plan.shop.toBuy': 'buy',
  'plan.shop.packs': 'Packs',
  'plan.shop.cost': 'Cost',
  'plan.shop.noMaterial': 'no material',
  'plan.shop.sum': 'Total',
  'plan.shop.hint':
    'Grouped per material: a material linked to several colours is bought only once. “buy” = need − recorded stock (stock 0 counts as recorded; red when something is missing). Packs = packs for the whole need, in brackets for the shortfall. Cost = packs × price.',
  'plan.shop.incomplete': 'Cost incomplete: not every material has a pack size and price, or colours have no material.',

  'pdf.shopTitle': 'Shopping list per material',
  'pdf.shopColors': 'Colours',
  'pdf.stock': 'Stock',
  'pdf.toBuy': 'To buy',
  'pdf.costCol': 'Cost',
  'pdf.shopHint':
    'Grouped per material (a material used for several colours is bought once). The sum of the costs equals the material cost above. To buy = need − stock; packs in brackets: for the shortfall.',
  'pdf.perColorHint': 'Need per colour (raw tiles incl. reserve). Packs and cost are in the shopping list per material.',
  'pdf.notchLine': 'Notch {i}: ({x1}; {y1}) → inner corner ({x2}; {y2}) – do not score through',
  'pdf.notchEdgeLine': 'Notch {i}: ({x1}; {y1}) → tile edge ({x2}; {y2}) – do not score through',
  // 'pdf.templatesHint': Text steht in w5-pdf-content.ts (gilt dort zur Laufzeit; keine Doppeldefinition)
  'pdf.templateMore': '… more details in the tile details of the app',
};

export const tr: Record<string, string> = {
  'crash.title': 'Bu görünüm gösterilemedi',
  'crash.text':
    'Gösterilirken beklenmeyen bir hata oluştu. Projeleriniz ve malzemeleriniz cihazda kayıtlıdır; şimdiye kadar kaydedilenler korunur. Sayfayı yeniden yükleyin veya ana sayfaya gidin.',
  'crash.reload': 'Yeniden yükle',
  'crash.home': 'Ana sayfa',
  'crash.details': 'Teknik ayrıntılar',

  'compute.err.palette-changed':
    'Özel palet hesaplama sırasında kısaltıldı veya yeniden sıralandı (ör. başka bir sekmede). Sonuç artık uyuşmadığı için atıldı – palet ve önceki mozaik değişmeden kalır. Lütfen yeniden hesaplayın.',

  'integrity.goCompute': '7. adıma git (Hesapla)',
  'integrity.placedLoss':
    'Kayıtlı mozaikte döşendi olarak işaretlenmiş {n} taş var. Yeniden hesaplamada bu döşeme ilerlemesi kaybolur. Korumak istiyorsanız projeyi önce yedekleyin.',
  'integrity.placedLoss.one':
    'Kayıtlı mozaikte döşendi olarak işaretlenmiş {n} taş var. Yeniden hesaplamada bu döşeme ilerlemesi kaybolur. Korumak istiyorsanız projeyi önce yedekleyin.',
  'integrity.download': 'Yedeği indir',
  'integrity.copy': 'Kopya olarak kaydet',
  'integrity.copied': '“{name}” kopyası oluşturuldu (“Projelerim” altında).',
  'integrity.failed': 'Yedekleme başarısız: {msg}',

  'repair.notice':
    'Eski bir sürümden gelen {n} hücrede boş parçalar vardı (derz taştan geniş). Tam taşa dönüştürüldüler, döşeme durumları sıfırlandı.',
  'repair.notice.one':
    'Eski bir sürümden gelen {n} hücrede boş parçalar vardı (derz taştan geniş). Tam taşa dönüştürüldü, döşeme durumu sıfırlandı.',

  'plan.invalidPieces': 'Alanı olmayan geçersiz parçalar (sayılmadı) – taş ayrıntısında hücreyi “Tam taş” yapın',

  'plan.shop.title': 'Malzeme başına alışveriş listesi',
  'plan.shop.material': 'Malzeme',
  'plan.shop.colors': 'Renkler',
  'plan.shop.need': 'İhtiyaç',
  'plan.shop.stock': 'Stok',
  'plan.shop.toBuy': 'alınacak',
  'plan.shop.packs': 'Paket',
  'plan.shop.cost': 'Maliyet',
  'plan.shop.noMaterial': 'malzemesiz',
  'plan.shop.sum': 'Toplam',
  'plan.shop.hint':
    'Malzeme başına toplanır: birden fazla renge atanmış bir malzeme yalnızca bir kez alınır. “alınacak” = ihtiyaç − kayıtlı stok (stok 0 kayıtlı sayılır; eksik varsa kırmızı). Paket = tüm ihtiyaç için paket, parantez içinde eksik için. Maliyet = paket × fiyat.',
  'plan.shop.incomplete': 'Maliyet eksik: her malzemenin paket boyutu ve fiyatı yok veya bazı renklerin malzemesi yok.',

  'pdf.shopTitle': 'Malzeme başına alışveriş listesi',
  'pdf.shopColors': 'Renkler',
  'pdf.stock': 'Stok',
  'pdf.toBuy': 'Alınacak',
  'pdf.costCol': 'Maliyet',
  'pdf.shopHint':
    'Malzeme başına toplanır (birden fazla renk için kullanılan malzeme bir kez alınır). Maliyetlerin toplamı yukarıdaki malzeme maliyetine eşittir. Alınacak = ihtiyaç − stok; parantez içindeki paketler: eksik için.',
  'pdf.perColorHint': 'Renk başına ihtiyaç (yedekli ham taş). Paketler ve maliyet malzeme başına alışveriş listesindedir.',
  'pdf.notchLine': 'Çentik {i}: ({x1}; {y1}) → iç köşe ({x2}; {y2}) – boydan boya çizmeyin',
  'pdf.notchEdgeLine': 'Çentik {i}: ({x1}; {y1}) → taş kenarı ({x2}; {y2}) – boydan boya çizmeyin',
  // 'pdf.templatesHint': Text steht in w5-pdf-content.ts (gilt dort zur Laufzeit; keine Doppeldefinition)
  'pdf.templateMore': '… diğer ayrıntılar uygulamadaki taş ayrıntısında',
};
