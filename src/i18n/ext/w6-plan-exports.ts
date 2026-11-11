/**
 * Texte des Pakets w6-plan-exports (Schritt 9, Verlegeplan):
 *  - Koordinaten-CSV gestreamt: Fortschritt, Abbrechen, Ergebnis, Hinweis zur Zeilengrenze von Excel/LibreOffice;
 *  - Abschnittsgrößen passend zum Papier: Vorgaben „1 Blatt“ / „2×2 Blätter“, Hinweis bei schlecht genutztem Papier.
 */
export const de: Record<string, string> = {
  // ---- CSV
  'w6pe.csv.prepare': 'CSV wird vorbereitet … {pct} %',
  'w6pe.csv.rows': 'CSV: Zeile {done} von {total}',
  'w6pe.csv.cancel': 'Abbrechen',
  'w6pe.csv.cancelled': 'CSV-Export abgebrochen – es wurde keine Datei gespeichert.',
  'w6pe.csv.done': '{rows} Zeilen · {size}',
  'w6pe.csv.excelLimit':
    'Mehr als 1.048.576 Zeilen ({rows} mit Kopfzeile) – Excel und LibreOffice Calc können diese Datei nicht vollständig öffnen. Die CSV selbst ist vollständig; zum Ansehen in einer Tabellenkalkulation abschnittsweise exportieren.',
  'w6pe.csv.excelLimitBefore': 'Mehr als 1.048.576 Zeilen – Excel und LibreOffice Calc können diese CSV nicht vollständig öffnen (abschnittsweise exportieren).',
  'w6pe.csv.paletteError': 'Farbzuordnung ungültig (Farbindex {max}, die Palette hat {n} Farben) – bitte neu berechnen. Es wurde keine CSV erzeugt.',
  'w6pe.csv.title': 'Eine Zeile je Stein: Position, Lage und Maße in mm, Farbe, Form, Zuschnitt mit Vorlagennummer T# wie im PDF, verlegt.',
  // ---- Abschnitte passend zum Papier
  'w6pe.sec.presets': 'Passend zum Papier',
  'w6pe.sec.paper': '{format} {orient}, Maßstab {scale}: bedruckbar {w} × {h} cm je Blatt (aus Schritt 10).',
  'w6pe.sec.paperFit':
    'Im PDF ist „an Seite anpassen“ gewählt – dort kommt jeder Abschnitt auf ein Blatt. Die Vorgaben gelten für Maßstab 1:1 ({format} {orient}: {w} × {h} cm je Blatt).',
  'w6pe.sec.oneSheet': '1 Blatt',
  'w6pe.sec.twoSheets': '2×2 Blätter',
  'w6pe.sec.presetTitle': 'Abschnitt {w} × {h} cm → {sections} Abschnitte, {sheets} Verlegeblätter',
  'w6pe.sec.presetSheets': '{sheets} Blätter',
  'w6pe.sec.portrait': 'hoch',
  'w6pe.sec.landscape': 'quer',
  'w6pe.sec.custom': 'Eigenes Format',
  'w6pe.sec.poorFit':
    'Die Abschnitte passen schlecht zum Papier: {sheets} Verlegeblätter, im Mittel nur {fill} % der bedruckbaren Fläche genutzt ({thin} Blätter weniger als halb voll). Mit „1 Blatt“ wären es {one} Blätter.',
  'w6pe.sec.confirm':
    'Abschnittsgröße auf {w} × {h} cm ändern? Abschnitte und Abschnitts-IDs (A1, B2 …) ändern sich – schon gedruckte Pläne passen dann nicht mehr. Der Verlegefortschritt ({n} verlegte Steine) bleibt erhalten, er gehört zu den Steinen.',
  'w6pe.sec.applied': 'Abschnittsgröße {w} × {h} cm: {sections} Abschnitte, {sheets} Verlegeblätter.',
};

export const en: Record<string, string> = {
  'w6pe.csv.prepare': 'Preparing CSV … {pct} %',
  'w6pe.csv.rows': 'CSV: row {done} of {total}',
  'w6pe.csv.cancel': 'Cancel',
  'w6pe.csv.cancelled': 'CSV export cancelled – no file was saved.',
  'w6pe.csv.done': '{rows} rows · {size}',
  'w6pe.csv.excelLimit':
    'More than 1,048,576 rows ({rows} including the header) – Excel and LibreOffice Calc cannot open this file completely. The CSV itself is complete; export section by section to view it in a spreadsheet.',
  'w6pe.csv.excelLimitBefore': 'More than 1,048,576 rows – Excel and LibreOffice Calc cannot open this CSV completely (export section by section).',
  'w6pe.csv.paletteError': 'Invalid colour mapping (colour index {max}, the palette has {n} colours) – please recompute. No CSV was created.',
  'w6pe.csv.title': 'One row per stone: position, location and size in mm, colour, shape, cut with template number T# as in the PDF, laid.',
  'w6pe.sec.presets': 'Match the paper',
  'w6pe.sec.paper': '{format} {orient}, scale {scale}: printable {w} × {h} cm per sheet (from step 10).',
  'w6pe.sec.paperFit':
    'The PDF uses "fit to page" – there each section goes on one sheet. The presets are for scale 1:1 ({format} {orient}: {w} × {h} cm per sheet).',
  'w6pe.sec.oneSheet': '1 sheet',
  'w6pe.sec.twoSheets': '2×2 sheets',
  'w6pe.sec.presetTitle': 'Section {w} × {h} cm → {sections} sections, {sheets} laying sheets',
  'w6pe.sec.presetSheets': '{sheets} sheets',
  'w6pe.sec.portrait': 'portrait',
  'w6pe.sec.landscape': 'landscape',
  'w6pe.sec.custom': 'Custom format',
  'w6pe.sec.poorFit':
    'The sections fit the paper poorly: {sheets} laying sheets, on average only {fill} % of the printable area used ({thin} sheets less than half full). With "1 sheet" it would be {one} sheets.',
  'w6pe.sec.confirm':
    'Change the section size to {w} × {h} cm? Sections and section IDs (A1, B2 …) will change – plans you already printed will no longer match. Laying progress ({n} stones laid) is kept; it belongs to the stones.',
  'w6pe.sec.applied': 'Section size {w} × {h} cm: {sections} sections, {sheets} laying sheets.',
};

export const tr: Record<string, string> = {
  'w6pe.csv.prepare': 'CSV hazırlanıyor … %{pct}',
  'w6pe.csv.rows': 'CSV: satır {done} / {total}',
  'w6pe.csv.cancel': 'İptal',
  'w6pe.csv.cancelled': 'CSV dışa aktarımı iptal edildi – dosya kaydedilmedi.',
  'w6pe.csv.done': '{rows} satır · {size}',
  'w6pe.csv.excelLimit':
    '1.048.576 satırdan fazla (başlık dahil {rows}) – Excel ve LibreOffice Calc bu dosyayı tamamen açamaz. CSV’nin kendisi eksiksizdir; tablo programında görmek için bölüm bölüm dışa aktarın.',
  'w6pe.csv.excelLimitBefore': '1.048.576 satırdan fazla – Excel ve LibreOffice Calc bu CSV’yi tamamen açamaz (bölüm bölüm dışa aktarın).',
  'w6pe.csv.paletteError': 'Renk eşlemesi geçersiz (renk dizini {max}, palette {n} renk var) – lütfen yeniden hesaplayın. CSV oluşturulmadı.',
  'w6pe.csv.title': 'Her taş için bir satır: konum, mm cinsinden yer ve ölçü, renk, şekil, PDF’deki gibi şablon numarası T# ile kesim, döşendi.',
  'w6pe.sec.presets': 'Kâğıda uydur',
  'w6pe.sec.paper': '{format} {orient}, ölçek {scale}: sayfa başına basılabilir {w} × {h} cm (10. adımdan).',
  'w6pe.sec.paperFit':
    'PDF’de “sayfaya sığdır” seçili – orada her bölüm tek sayfaya gelir. Hazır ayarlar 1:1 ölçek içindir ({format} {orient}: sayfa başına {w} × {h} cm).',
  'w6pe.sec.oneSheet': '1 sayfa',
  'w6pe.sec.twoSheets': '2×2 sayfa',
  'w6pe.sec.presetTitle': 'Bölüm {w} × {h} cm → {sections} bölüm, {sheets} döşeme sayfası',
  'w6pe.sec.presetSheets': '{sheets} sayfa',
  'w6pe.sec.portrait': 'dikey',
  'w6pe.sec.landscape': 'yatay',
  'w6pe.sec.custom': 'Özel format',
  'w6pe.sec.poorFit':
    'Bölümler kâğıda kötü uyuyor: {sheets} döşeme sayfası, basılabilir alanın ortalama yalnızca %{fill} kadarı kullanılıyor ({thin} sayfa yarıdan az dolu). “1 sayfa” ile {one} sayfa olurdu.',
  'w6pe.sec.confirm':
    'Bölüm boyutu {w} × {h} cm olarak değiştirilsin mi? Bölümler ve bölüm kimlikleri (A1, B2 …) değişir – önceden basılmış planlar artık uymaz. Döşeme ilerlemesi ({n} döşenmiş taş) korunur; taşlara aittir.',
  'w6pe.sec.applied': 'Bölüm boyutu {w} × {h} cm: {sections} bölüm, {sheets} döşeme sayfası.',
};
