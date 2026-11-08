/**
 * Texte für die PDF-Grundlagen (Welle 3): gekürzte Koordinatenlisten ehrlich benennen, gemeinsamer
 * Anpassungsmaßstab, Seitenverweise, fehlende Materialien, Schutz vor ungültiger Farbzuordnung.
 * Türkisch: „Blatt“ heißt jetzt „Pafta“, damit Blatt-IDs und Seitenzahlen nicht beide „Sayfa“ heißen.
 */
export const de: Record<string, string> = {
  'pdf.err.integrity':
    'PDF nicht erzeugt: Die Farbzuordnung des Mosaiks ist ungültig – {n} Steine verweisen auf Farben, die es in der Palette nicht gibt (Palette: {count} Farben, größter verwendeter Index: {max}). Bitte in Schritt 7 neu berechnen.',
  'pdf.err.integrity.one':
    'PDF nicht erzeugt: Die Farbzuordnung des Mosaiks ist ungültig – {n} Stein verweist auf eine Farbe, die es in der Palette nicht gibt (Palette: {count} Farben, größter verwendeter Index: {max}). Bitte in Schritt 7 neu berechnen.',
  'pdf.coordsTitleFull': 'Koordinaten – Abschnitt {id} ({total} Steine, vollständig)',
  'pdf.coordsTitleFull.one': 'Koordinaten – Abschnitt {id} ({total} Stein, vollständig)',
  'pdf.coordsTitlePartial': 'Koordinaten – Abschnitt {id} (erste {n} von {total} Steinen – gekürzt, Rest siehe CSV)',
  'pdf.coordsNotice':
    'Koordinatenliste gekürzt (Limit {limit} Steine): aufgeführt sind {n} von {total} Steinen der exportierten Abschnitte. Erster nicht aufgeführter Stein: {first}. Die vollständige Liste gibt es als CSV-Export im Verlegeplan.',
  'pdf.coordsSkipped': 'Ohne Koordinatenliste (Limit erreicht): Abschnitt {ids}.',
  'pdf.pagesInPdf': 'Seiten in diesem PDF',
  'pdf.pageShort': 'S. {n}',
  'pdf.notExportedHint': '„–“ in der Spalte „Seite“: Abschnitt ist nicht in diesem PDF enthalten (einzeln exportiert).',
  'pdf.fitScale': '{scale} (an Seite angepasst – ein Maßstab für alle Abschnitte)',
  'pdf.notFullSize': 'Maßstab {scale} – nicht in Originalgröße: nicht als Auflegevorlage unter die Steine legen, Maße am mm-Lineal ablesen.',
  'pdf.notFullSizeShort': 'nicht Originalgröße',
  'pdf.materialMissing': 'Material fehlt in der Materialverwaltung',
  'pdf.missingMaterialsWarn':
    'Achtung: Farbe {codes} ist einem Material zugeordnet, das in der Materialverwaltung fehlt. Rohsteinmaß (Rastermaß angenommen), Packungen und Kosten dieser Farben sind unbekannt.',
  'pdf.gridAssumed': '* Rohsteinmaß unbekannt – Rastermaß angenommen (Richtwert).',
  'pdf.packsToBuy': '{n} kaufen',
  // bestehende Schlüssel, nur damit alle drei Sprachen dieselben Schlüssel haben (Türkisch geändert)
  'pdf.sheet': 'Blatt',
  'pdf.sheets': 'Verlegeblätter',
  'pdf.sheetScale': 'Maßstab Verlegeblätter',
  'pdf.markHint': 'Rote Passkreuze/Linien liegen in der Fugenmitte ({g} mm Fuge). Blätter an den Passkreuzen deckungsgleich auflegen.',
};

export const en: Record<string, string> = {
  'pdf.err.integrity':
    'PDF not created: the colour assignment of the mosaic is invalid – {n} tiles refer to colours that do not exist in the palette (palette: {count} colours, largest index used: {max}). Please recompute in step 7.',
  'pdf.err.integrity.one':
    'PDF not created: the colour assignment of the mosaic is invalid – {n} tile refers to a colour that does not exist in the palette (palette: {count} colours, largest index used: {max}). Please recompute in step 7.',
  'pdf.coordsTitleFull': 'Coordinates – section {id} ({total} tiles, complete)',
  'pdf.coordsTitleFull.one': 'Coordinates – section {id} ({total} tile, complete)',
  'pdf.coordsTitlePartial': 'Coordinates – section {id} (first {n} of {total} tiles – truncated, rest see CSV)',
  'pdf.coordsNotice':
    'Coordinate list truncated (limit {limit} tiles): {n} of {total} tiles of the exported sections are listed. First tile not listed: {first}. The complete list is available as CSV export in the laying plan.',
  'pdf.coordsSkipped': 'Without coordinate list (limit reached): section {ids}.',
  'pdf.pagesInPdf': 'Pages in this PDF',
  'pdf.pageShort': 'p. {n}',
  'pdf.notExportedHint': '“–” in the “Page” column: section is not included in this PDF (exported separately).',
  'pdf.fitScale': '{scale} (fitted to page – one scale for all sections)',
  'pdf.notFullSize': 'Scale {scale} – not actual size: do not use as a template under the tiles, read dimensions from the mm ruler.',
  'pdf.notFullSizeShort': 'not actual size',
  'pdf.materialMissing': 'Material missing from material management',
  'pdf.missingMaterialsWarn':
    'Warning: colour {codes} is assigned to a material that is missing in material management. Raw tile size (grid size assumed), packs and cost of these colours are unknown.',
  'pdf.gridAssumed': '* Raw tile size unknown – grid size assumed (guide value).',
  'pdf.packsToBuy': 'buy {n}',
  'pdf.sheet': 'Sheet',
  'pdf.sheets': 'Laying sheets',
  'pdf.sheetScale': 'Laying sheet scale',
  'pdf.markHint': 'Red registration crosses/lines lie on the joint centre ({g} mm joint). Align sheets exactly on the crosses.',
};

export const tr: Record<string, string> = {
  'pdf.err.integrity':
    'PDF oluşturulmadı: mozaiğin renk ataması geçersiz – {n} taş, palette olmayan renklere işaret ediyor (palet: {count} renk, kullanılan en büyük indeks: {max}). Lütfen 7. adımda yeniden hesaplayın.',
  'pdf.err.integrity.one':
    'PDF oluşturulmadı: mozaiğin renk ataması geçersiz – {n} taş, palette olmayan bir renge işaret ediyor (palet: {count} renk, kullanılan en büyük indeks: {max}). Lütfen 7. adımda yeniden hesaplayın.',
  'pdf.coordsTitleFull': 'Koordinatlar – bölüm {id} ({total} taş, eksiksiz)',
  'pdf.coordsTitleFull.one': 'Koordinatlar – bölüm {id} ({total} taş, eksiksiz)',
  'pdf.coordsTitlePartial': 'Koordinatlar – bölüm {id} ({total} taştan ilk {n} – kısaltıldı, kalanı CSV’de)',
  'pdf.coordsNotice':
    'Koordinat listesi kısaltıldı (sınır {limit} taş): dışa aktarılan bölümlerin {total} taşından {n} tanesi listelendi. Listelenmeyen ilk taş: {first}. Tam liste döşeme planında CSV dışa aktarımı olarak mevcuttur.',
  'pdf.coordsSkipped': 'Koordinat listesi olmayan (sınıra ulaşıldı): bölüm {ids}.',
  'pdf.pagesInPdf': 'Bu PDF’teki sayfalar',
  'pdf.pageShort': 's. {n}',
  'pdf.notExportedHint': '“Sayfa” sütununda “–”: bölüm bu PDF’te yok (ayrı dışa aktarıldı).',
  'pdf.fitScale': '{scale} (sayfaya sığdırıldı – tüm bölümler için tek ölçek)',
  'pdf.notFullSize': 'Ölçek {scale} – gerçek boyut değil: taşların altına şablon olarak koymayın, ölçüleri mm cetvelinden okuyun.',
  'pdf.notFullSizeShort': 'gerçek boyut değil',
  'pdf.materialMissing': 'Malzeme, malzeme yönetiminde bulunamadı',
  'pdf.missingMaterialsWarn':
    'Dikkat: {codes} rengi, malzeme yönetiminde bulunmayan bir malzemeye atanmış. Bu renklerin ham taş ölçüsü (ızgara ölçüsü varsayıldı), paketleri ve maliyeti bilinmiyor.',
  'pdf.gridAssumed': '* Ham taş ölçüsü bilinmiyor – ızgara ölçüsü varsayıldı (yaklaşık değer).',
  'pdf.packsToBuy': '{n} alınacak',
  'pdf.sheet': 'Pafta',
  'pdf.sheets': 'Döşeme paftaları',
  'pdf.sheetScale': 'Döşeme paftası ölçeği',
  'pdf.markHint': 'Kırmızı hizalama artıları/çizgileri derz ortasındadır ({g} mm derz). Paftaları artılar üst üste gelecek şekilde hizalayın.',
};
