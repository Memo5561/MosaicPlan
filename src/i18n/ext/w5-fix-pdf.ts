/**
 * Texte der Nachbesserung „PDF“ nach der Gegenprüfung von Welle 5 (w5-fix-pdf): „Teil k von n“ im PDF selbst,
 * Schnittvorlagen je Teil, Einkaufslisten-Hinweis ohne Material/Kosten, Dateinamen in der Sprache der Oberfläche
 * und die Hauptaktion von Schritt 10 in der Leiste unten.
 */
export const de: Record<string, string> = {
  'w5fp.pdf.partCover': 'Teil {k} von {n}',
  'w5fp.pdf.partLabel': 'Export in Teilen',
  'w5fp.pdf.partValue': 'Teil {k} von {n} · Abschnitte {range}',
  'w5fp.pdf.allSections': 'alle',
  'w5fp.pdf.partShort': 'Teil {k}/{n}',
  'w5fp.pdf.tplWhole': 'ganzes Mosaik: {n}×',
  'w5fp.pdf.shopHintNoCost':
    'Je Material zusammengefasst (ein Material für mehrere Farben wird einmal gekauft). Kosten fehlen, weil kein zugeordnetes Material einen Preis hat. Zu kaufen = Bedarf − Bestand; Packungen in Klammern: für den Fehlbestand.',
  'w5fp.pdf.shopHintNoMaterial':
    'Keiner Farbe ist ein Material zugeordnet: Bedarf als Rohsteine im Rastermaß, ohne Packungen und ohne Kosten. Materialien lassen sich im Schritt „Farben“ zuordnen.',
  'w5fp.file.stem': 'verlegeplan',
  'w5fp.parts.total': 'In {n} Teilen zusammen ca. {pages} Seiten: Deckblatt, Gesamtübersicht, Legende und Materialliste stehen in jedem Teil, Schnittvorlagen nur für die Abschnitte des Teils.',
  'w5fp.action.generate': 'PDF erzeugen · ca. {n} S.',
  'w5fp.action.part': 'Teil {k}/{n} erzeugen · ca. {p} S.',
  'w5fp.action.busy': 'Wird erzeugt … {pct} %',
  'w5fp.action.allDone': 'Alle Teile erzeugt',
  'w5fp.action.blocked': 'Erst bestätigen oder neu berechnen',
  'w5fp.action.otherBusy': 'Anderer Export läuft',
};

export const en: Record<string, string> = {
  'w5fp.pdf.partCover': 'Part {k} of {n}',
  'w5fp.pdf.partLabel': 'Export in parts',
  'w5fp.pdf.partValue': 'Part {k} of {n} · sections {range}',
  'w5fp.pdf.allSections': 'all',
  'w5fp.pdf.partShort': 'Part {k}/{n}',
  'w5fp.pdf.tplWhole': 'whole mosaic: {n}×',
  'w5fp.pdf.shopHintNoCost':
    'Grouped per material (a material used for several colours is bought once). Costs are missing because no assigned material has a price. To buy = need − stock; packs in brackets: for the shortfall.',
  'w5fp.pdf.shopHintNoMaterial':
    'No colour has a material assigned: need given as raw tiles in grid size, without packs and without costs. Materials can be assigned in the “Colours” step.',
  'w5fp.file.stem': 'laying-plan',
  'w5fp.parts.total': 'In {n} parts approx. {pages} pages altogether: cover page, overall view, legend and material list are in every part, cutting templates only for the sections of the part.',
  'w5fp.action.generate': 'Create PDF · approx. {n} p.',
  'w5fp.action.part': 'Create part {k}/{n} · approx. {p} p.',
  'w5fp.action.busy': 'Creating … {pct} %',
  'w5fp.action.allDone': 'All parts created',
  'w5fp.action.blocked': 'Confirm or recompute first',
  'w5fp.action.otherBusy': 'Another export is running',
};

export const tr: Record<string, string> = {
  'w5fp.pdf.partCover': 'Kısım {k} / {n}',
  'w5fp.pdf.partLabel': 'Kısımlar hâlinde dışa aktarma',
  'w5fp.pdf.partValue': 'Kısım {k} / {n} · bölümler {range}',
  'w5fp.pdf.allSections': 'tümü',
  'w5fp.pdf.partShort': 'Kısım {k}/{n}',
  'w5fp.pdf.tplWhole': 'tüm mozaik: {n}×',
  'w5fp.pdf.shopHintNoCost':
    'Malzeme başına toplanır (birden fazla renk için kullanılan malzeme bir kez alınır). Atanan hiçbir malzemenin fiyatı olmadığı için maliyet yok. Alınacak = ihtiyaç − stok; parantez içindeki paketler: eksik için.',
  'w5fp.pdf.shopHintNoMaterial':
    'Hiçbir renge malzeme atanmamış: ihtiyaç, ızgara ölçüsünde ham taş olarak verilir; paket ve maliyet yok. Malzemeler “Renkler” adımında atanabilir.',
  'w5fp.file.stem': 'doseme-plani',
  'w5fp.parts.total': '{n} kısımda toplam yakl. {pages} sayfa: kapak sayfası, genel görünüm, renk açıklaması ve malzeme listesi her kısımda yer alır; kesim şablonları yalnızca o kısmın bölümleri için.',
  'w5fp.action.generate': 'PDF oluştur · yakl. {n} s.',
  'w5fp.action.part': 'Kısım {k}/{n} oluştur · yakl. {p} s.',
  'w5fp.action.busy': 'Oluşturuluyor … %{pct}',
  'w5fp.action.allDone': 'Tüm kısımlar oluşturuldu',
  'w5fp.action.blocked': 'Önce onaylayın veya yeniden hesaplayın',
  'w5fp.action.otherBusy': 'Başka bir dışa aktarma sürüyor',
};
