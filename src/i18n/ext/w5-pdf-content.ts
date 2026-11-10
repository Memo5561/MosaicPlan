/**
 * Texte für den PDF-Inhalt (Welle 5): Farblegende je Verlegeblatt, lesbare Schnittvorlagen mit Maßlinien, kompakte
 * vollständige Koordinatenliste und Gesamtübersicht großer Projekte (Kartenraster, Lagekarte je Abschnitt).
 * Überschreibt pdf.templatesHint (Maßlinien erklärt) und pdfui.coordHint (kompakte Liste ist vollständig).
 */
export const de: Record<string, string> = {
  'pdf.w5.sheetStones': 'Steine auf diesem Blatt: {n}, davon {k} zugeschnitten',
  'pdf.w5.sheetLegendFor': 'Legende zu Blatt {id}',
  'pdf.w5.sheetLegendShort': 'Legende {id}',
  'pdf.w5.sheetLegendRef': 'Farblegende dieses Blatts: S. {p}.',
  'pdf.w5.sheetLegendHint':
    'Je Farbe: Farbnummer wie im Stein, Anzahl Steine auf diesem Blatt, dahinter die Farbnummer des Materials (sonst der Farbname). Die Summe ist die Steinzahl des Blatts.',
  'pdf.w5.legendCont': '(Fortsetzung)',
  'pdf.w5.mapGridCaption': 'Abschnitt = Zeilenbuchstabe + Spaltennummer, z. B. {ex}.',
  'pdf.w5.selectedHint': 'Kräftig umrandet und hinterlegt: Abschnitte in diesem PDF.',
  'pdf.w5.locator': 'Lage im Mosaik',
  'pdf.cc.introTitle': 'Koordinaten',
  'pdf.cc.intro':
    'Kompakt und vollständig: Jeder Stein steht genau einmal. Ganzer Stein in Zeile R und Spalte C: linke obere Außenkante bei X = Spaltenbeginn, Y = Zeilenbeginn (mm ab Ursprung oben links an A001), Größe = Spaltenbreite × Zeilenhöhe; die Farbnummer steht in der Farbfolge seiner Zeile („Spalten → Farbnummer“). ◆ markiert Zellen mit Sonderteilen: Teilsteine (Dreiecke, Kantenschnitte, feinere Steine, Freiform), zugeschnittene Randsteine und Steine mit anderem Rohsteinmaß – sie stehen einzeln in der Liste „Sonderteile“ mit ihrem Begrenzungsrechteck (kein Eckpunkt des Steins; die genaue Kontur steht auf der Schnittvorlage). Alle Koordinaten einzeln: CSV-Export (Schritt 9).',
  'pdf.cc.example': 'Ablesebeispiel:',
  'pdf.cc.exampleRest': '= Spalte {col} (X {x}) · Zeile {row} (Y {y}) · {w} × {h} mm · Farbe {code}',
  'pdf.cc.cols': 'Spalten – Nummer: X von–bis (mm)',
  'pdf.cc.rows': 'Zeilen – Buchstabe: Y von–bis (mm)',
  'pdf.cc.trimCol': 'Randzuschnitt Spalte {n}: {w} mm breit (Raster {tile} mm) – ihre Steine stehen bei den Sonderteilen.',
  'pdf.cc.trimRow': 'Randzuschnitt Zeile {n}: {h} mm hoch (Raster {tile} mm) – ihre Steine stehen bei den Sonderteilen.',
  'pdf.cc.runs': 'Farbfolge je Zeile (Spalten → Farbnummer; ◆ = Sonderteile, siehe unten)',
  'pdf.cc.special': 'Sonderteile ({n}): X/Y = Begrenzungsrechteck des Steins (min–max, mm ab Ursprung oben links)',
  'pdf.cc.special.one': 'Sonderteil (1): X/Y = Begrenzungsrechteck des Steins (min–max, mm ab Ursprung oben links)',
  'pdf.cc.colX': 'X min–max',
  'pdf.cc.colY': 'Y min–max',
  'pdf.cc.cont': '(Fortsetzung)',
  'pdf.cc.control': 'Kontrolle: {whole} ganze Steine + {special} Sonderteile = {total} Steine – gleich der Steinzahl des Abschnitts.',
  'pdf.cc.controlFail':
    'FEHLER: Diese Liste ergibt {sum} Steine, der Abschnitt hat {total}. Bitte diese Koordinaten nicht verwenden, sondern den CSV-Export (Schritt 9) – und den Fehler melden.',
  'pdf.cc.noStones': 'keine Steine',
  'pdf.templatesHint':
    'Jede Vorlage ist geometrisch berechnet. Gestrichelt grau: Rohstein · Fläche: Stein · Maßlinien mit Zahl: Kantenlänge des Steins in mm (bei einer Hinweislinie gilt die Zahl für die verbundene Maßlinie) · Rot: durchgehende Schnitte (ritzen und brechen) · Orange gepunktet: Einschnitte bis zur Innenecke – nicht durchritzen, mit der Zange ausknabbern bzw. schleifen. Koordinaten in mm ab oberer linker Rohsteinecke.',
  'pdfui.coordHint':
    'Standard ist eine kompakte, vollständige Liste (Spalten- und Zeilentabellen, Farbfolge je Zeile, Sonderteile einzeln) – das Limit gilt nur für die ausführliche Liste je Stein. Alle Koordinaten einzeln: CSV im Verlegeplan.',
};

export const en: Record<string, string> = {
  'pdf.w5.sheetStones': 'Tiles on this sheet: {n}, of which {k} cut',
  'pdf.w5.sheetLegendFor': 'Legend for sheet {id}',
  'pdf.w5.sheetLegendShort': 'Legend {id}',
  'pdf.w5.sheetLegendRef': 'Colour legend of this sheet: p. {p}.',
  'pdf.w5.sheetLegendHint':
    'Per colour: colour number as printed in the tile, number of tiles on this sheet, then the material colour number (otherwise the colour name). The sum is the tile count of the sheet.',
  'pdf.w5.legendCont': '(continued)',
  'pdf.w5.mapGridCaption': 'Section = row letter + column number, e.g. {ex}.',
  'pdf.w5.selectedHint': 'Bold outline and shading: sections in this PDF.',
  'pdf.w5.locator': 'Position in the mosaic',
  'pdf.cc.introTitle': 'Coordinates',
  'pdf.cc.intro':
    'Compact and complete: every tile is listed exactly once. Whole tile in row R and column C: top-left outer edge at X = column start, Y = row start (mm from the origin at the top left of A001), size = column width × row height; its colour number is in the colour sequence of its row (“columns → colour number”). ◆ marks cells with special pieces: partial tiles (triangles, edge cuts, finer tiles, freeform), cut border tiles and tiles with a different raw size – they are listed one by one under “Special pieces” with their bounding box (not a corner of the tile; the exact outline is on the cut template). All coordinates one by one: CSV export (step 9).',
  'pdf.cc.example': 'Reading example:',
  'pdf.cc.exampleRest': '= column {col} (X {x}) · row {row} (Y {y}) · {w} × {h} mm · colour {code}',
  'pdf.cc.cols': 'Columns – number: X from–to (mm)',
  'pdf.cc.rows': 'Rows – letter: Y from–to (mm)',
  'pdf.cc.trimCol': 'Border cut column {n}: {w} mm wide (grid {tile} mm) – its tiles are listed as special pieces.',
  'pdf.cc.trimRow': 'Border cut row {n}: {h} mm high (grid {tile} mm) – its tiles are listed as special pieces.',
  'pdf.cc.runs': 'Colour sequence per row (columns → colour number; ◆ = special pieces, see below)',
  'pdf.cc.special': 'Special pieces ({n}): X/Y = bounding box of the tile (min–max, mm from the origin at the top left)',
  'pdf.cc.special.one': 'Special piece (1): X/Y = bounding box of the tile (min–max, mm from the origin at the top left)',
  'pdf.cc.colX': 'X min–max',
  'pdf.cc.colY': 'Y min–max',
  'pdf.cc.cont': '(continued)',
  'pdf.cc.control': 'Check: {whole} whole tiles + {special} special pieces = {total} tiles – equal to the tile count of the section.',
  'pdf.cc.controlFail':
    'ERROR: this list adds up to {sum} tiles, the section has {total}. Do not use these coordinates; use the CSV export (step 9) instead – and please report the error.',
  'pdf.cc.noStones': 'no tiles',
  'pdf.templatesHint':
    'Every template is computed geometrically. Dashed grey: raw tile · Fill: tile · Dimension lines with a number: edge length of the tile in mm (with a leader line the number belongs to the connected dimension line) · Red: through cuts (score and snap) · Dotted orange: notches up to the inner corner – do not score through, nibble out with nippers or grind. Coordinates in mm from the top-left corner of the raw tile.',
  'pdfui.coordHint':
    'By default a compact, complete list is printed (column and row tables, colour sequence per row, special pieces one by one) – the limit only applies to the detailed list per tile. All coordinates one by one: CSV in the laying plan.',
};

export const tr: Record<string, string> = {
  'pdf.w5.sheetStones': 'Bu paftadaki taşlar: {n}, bunlardan {k} kesilmiş',
  'pdf.w5.sheetLegendFor': 'Pafta {id} için lejant',
  'pdf.w5.sheetLegendShort': 'Lejant {id}',
  'pdf.w5.sheetLegendRef': 'Bu paftanın renk lejantı: s. {p}.',
  'pdf.w5.sheetLegendHint':
    'Her renk için: taşın içindeki renk numarası, bu paftadaki taş sayısı, ardından malzemenin renk numarası (yoksa renk adı). Toplam, paftadaki taş sayısıdır.',
  'pdf.w5.legendCont': '(devamı)',
  'pdf.w5.mapGridCaption': 'Bölüm = satır harfi + sütun numarası, örn. {ex}.',
  'pdf.w5.selectedHint': 'Kalın çerçeveli ve gölgeli: bu PDF’teki bölümler.',
  'pdf.w5.locator': 'Mozaikteki konum',
  'pdf.cc.introTitle': 'Koordinatlar',
  'pdf.cc.intro':
    'Kısa ve eksiksiz: her taş tam bir kez yer alır. R satırı ve C sütunundaki tam taş: sol üst dış kenarı X = sütun başı, Y = satır başı (A001’in sol üstündeki başlangıç noktasından mm), boyut = sütun genişliği × satır yüksekliği; renk numarası satırının renk dizisindedir (“sütunlar → renk numarası”). ◆ özel parçalı hücreleri gösterir: parça taşlar (üçgenler, kenar kesimleri, daha ince taşlar, serbest biçim), kesilmiş kenar taşları ve farklı ham taş ölçülü taşlar – bunlar “Özel parçalar” listesinde sınırlayıcı dikdörtgenleriyle tek tek yer alır (taşın köşesi değildir; tam kontur kesim şablonundadır). Tüm koordinatlar tek tek: CSV dışa aktarımı (adım 9).',
  'pdf.cc.example': 'Okuma örneği:',
  'pdf.cc.exampleRest': '= sütun {col} (X {x}) · satır {row} (Y {y}) · {w} × {h} mm · renk {code}',
  'pdf.cc.cols': 'Sütunlar – numara: X başlangıç–bitiş (mm)',
  'pdf.cc.rows': 'Satırlar – harf: Y başlangıç–bitiş (mm)',
  'pdf.cc.trimCol': 'Kenar kesimi sütun {n}: {w} mm genişlik (ızgara {tile} mm) – taşları özel parçalarda listelenir.',
  'pdf.cc.trimRow': 'Kenar kesimi satır {n}: {h} mm yükseklik (ızgara {tile} mm) – taşları özel parçalarda listelenir.',
  'pdf.cc.runs': 'Satır başına renk dizisi (sütunlar → renk numarası; ◆ = özel parçalar, aşağıya bakın)',
  'pdf.cc.special': 'Özel parçalar ({n}): X/Y = taşın sınırlayıcı dikdörtgeni (min–maks, sol üstteki başlangıç noktasından mm)',
  'pdf.cc.special.one': 'Özel parça (1): X/Y = taşın sınırlayıcı dikdörtgeni (min–maks, sol üstteki başlangıç noktasından mm)',
  'pdf.cc.colX': 'X min–maks',
  'pdf.cc.colY': 'Y min–maks',
  'pdf.cc.cont': '(devamı)',
  'pdf.cc.control': 'Kontrol: {whole} tam taş + {special} özel parça = {total} taş – bölümün taş sayısına eşit.',
  'pdf.cc.controlFail':
    'HATA: Bu liste {sum} taş veriyor, bölümde {total} taş var. Bu koordinatları kullanmayın, CSV dışa aktarımını (adım 9) kullanın – ve hatayı bildirin.',
  'pdf.cc.noStones': 'taş yok',
  'pdf.templatesHint':
    'Her şablon geometrik olarak hesaplanır. Kesikli gri: ham taş · Dolgu: taş · Sayılı ölçü çizgileri: taşın kenar uzunluğu (mm) (işaret çizgisi varsa sayı bağlı ölçü çizgisine aittir) · Kırmızı: boydan boya kesimler (çizip kırın) · Turuncu noktalı: iç köşeye kadar çentikler – boydan boya çizmeyin, pense ile kemirin veya taşlayın. Koordinatlar ham taşın sol üst köşesinden mm.',
  'pdfui.coordHint':
    'Varsayılan olarak kısa ve eksiksiz bir liste basılır (sütun ve satır tabloları, satır başına renk dizisi, özel parçalar tek tek) – sınır yalnızca taş başına ayrıntılı liste için geçerlidir. Tüm koordinatlar tek tek: yerleştirme planında CSV.',
};
