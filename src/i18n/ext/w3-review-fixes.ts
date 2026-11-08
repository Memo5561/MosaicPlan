/**
 * Texte der Korrekturen nach dem Review von Welle 3: gespeicherte Freiformzellen mit ungültigen (z. B.
 * überlappenden) Teilen aus älteren oder importierten Projekten, und der Hinweis „nicht in Ihren Materialien“
 * bei fehlenden Farben.
 */
export const de: Record<string, string> = {
  'w3fx.free.notice':
    '{n} Freiform-Steine haben ungültige Teile (z. B. überlappend – aus einem älteren oder importierten Projekt). Stein- und Fugenfläche sowie Fugenmasse sind damit nicht exakt berechenbar; der PDF-Plan ist gesperrt, bis sie im Freiform-Editor korrigiert sind.',
  'w3fx.free.notice.one':
    'Ein Freiform-Stein hat ungültige Teile (z. B. überlappend – aus einem älteren oder importierten Projekt). Stein- und Fugenfläche sowie Fugenmasse sind damit nicht exakt berechenbar; der PDF-Plan ist gesperrt, bis er im Freiform-Editor korrigiert ist.',
  'w3fx.free.open': 'Stein öffnen:',
  'w3fx.free.openStone': 'Stein {id} in der Vorschau öffnen (Freiform-Editor im Steindetail)',
  'w3fx.free.more': '+{n} weitere',
  'w3fx.area.invalid': 'nicht berechenbar – {n} Freiform-Steine mit ungültigen Teilen',
  'w3fx.area.invalid.one': 'nicht berechenbar – ein Freiform-Stein mit ungültigen Teilen',
  'w3fx.area.inconsistent': 'nicht berechenbar – Steinfläche größer als die Gesamtfläche',
  'pdf.err.freeInvalid':
    'PDF nicht erstellt: {n} Freiform-Steine haben ungültige (z. B. überlappende) Teile – Flächen und Fugenmasse wären falsch. Bitte im Steindetail mit dem Freiform-Editor korrigieren: {ids}',
  'pdf.err.freeInvalid.one':
    'PDF nicht erstellt: Ein Freiform-Stein hat ungültige (z. B. überlappende) Teile – Flächen und Fugenmasse wären falsch. Bitte im Steindetail mit dem Freiform-Editor korrigieren: {ids}',
  'pdf.err.areaInvalid': 'PDF nicht erstellt: Die Steinfläche ({stones} m²) ist größer als die Gesamtfläche ({total} m²) – die Flächen wären falsch.',
  'projimp.freeInvalid':
    '{n} Freiform-Steine in dieser Datei haben ungültige (z. B. überlappende) Teile: {ids}. Das Projekt zeigt sie an; vor dem PDF-Plan im Freiform-Editor korrigieren.',
  'projimp.freeInvalid.one':
    'Ein Freiform-Stein in dieser Datei hat ungültige (z. B. überlappende) Teile: {ids}. Das Projekt zeigt ihn an; vor dem PDF-Plan im Freiform-Editor korrigieren.',
  'w3fx.missing.notHere': 'nicht in Ihren Materialien',
};

export const en: Record<string, string> = {
  'w3fx.free.notice':
    '{n} freeform stones have invalid pieces (e.g. overlapping – from an older or imported project). Stone and joint area and grout cannot be computed exactly; the PDF plan is blocked until they are corrected in the freeform editor.',
  'w3fx.free.notice.one':
    'One freeform stone has invalid pieces (e.g. overlapping – from an older or imported project). Stone and joint area and grout cannot be computed exactly; the PDF plan is blocked until it is corrected in the freeform editor.',
  'w3fx.free.open': 'Open stone:',
  'w3fx.free.openStone': 'Open stone {id} in the preview (freeform editor in the stone details)',
  'w3fx.free.more': '+{n} more',
  'w3fx.area.invalid': 'cannot be computed – {n} freeform stones with invalid pieces',
  'w3fx.area.invalid.one': 'cannot be computed – one freeform stone with invalid pieces',
  'w3fx.area.inconsistent': 'cannot be computed – stone area larger than the total area',
  'pdf.err.freeInvalid':
    'PDF not created: {n} freeform stones have invalid (e.g. overlapping) pieces – areas and grout would be wrong. Please correct them with the freeform editor in the stone details: {ids}',
  'pdf.err.freeInvalid.one':
    'PDF not created: one freeform stone has invalid (e.g. overlapping) pieces – areas and grout would be wrong. Please correct it with the freeform editor in the stone details: {ids}',
  'pdf.err.areaInvalid': 'PDF not created: the stone area ({stones} m²) is larger than the total area ({total} m²) – the areas would be wrong.',
  'projimp.freeInvalid':
    '{n} freeform stones in this file have invalid (e.g. overlapping) pieces: {ids}. The project shows them; correct them in the freeform editor before creating the PDF plan.',
  'projimp.freeInvalid.one':
    'One freeform stone in this file has invalid (e.g. overlapping) pieces: {ids}. The project shows it; correct it in the freeform editor before creating the PDF plan.',
  'w3fx.missing.notHere': 'not in your materials',
};

export const tr: Record<string, string> = {
  'w3fx.free.notice':
    '{n} serbest biçimli taşın geçersiz parçaları var (ör. üst üste binen – eski veya içe aktarılmış bir projeden). Taş ve derz alanı ile derz dolgusu bu nedenle tam hesaplanamaz; serbest biçim düzenleyicisinde düzeltilene kadar PDF planı kilitlidir.',
  'w3fx.free.notice.one':
    'Bir serbest biçimli taşın geçersiz parçaları var (ör. üst üste binen – eski veya içe aktarılmış bir projeden). Taş ve derz alanı ile derz dolgusu bu nedenle tam hesaplanamaz; serbest biçim düzenleyicisinde düzeltilene kadar PDF planı kilitlidir.',
  'w3fx.free.open': 'Taşı aç:',
  'w3fx.free.openStone': '{id} taşını önizlemede aç (taş ayrıntılarında serbest biçim düzenleyicisi)',
  'w3fx.free.more': '+{n} tane daha',
  'w3fx.area.invalid': 'hesaplanamıyor – geçersiz parçalı {n} serbest biçimli taş',
  'w3fx.area.invalid.one': 'hesaplanamıyor – geçersiz parçalı bir serbest biçimli taş',
  'w3fx.area.inconsistent': 'hesaplanamıyor – taş alanı toplam alandan büyük',
  'pdf.err.freeInvalid':
    'PDF oluşturulmadı: {n} serbest biçimli taşın geçersiz (ör. üst üste binen) parçaları var – alanlar ve derz dolgusu yanlış olurdu. Lütfen taş ayrıntılarında serbest biçim düzenleyicisiyle düzeltin: {ids}',
  'pdf.err.freeInvalid.one':
    'PDF oluşturulmadı: bir serbest biçimli taşın geçersiz (ör. üst üste binen) parçaları var – alanlar ve derz dolgusu yanlış olurdu. Lütfen taş ayrıntılarında serbest biçim düzenleyicisiyle düzeltin: {ids}',
  'pdf.err.areaInvalid': 'PDF oluşturulmadı: taş alanı ({stones} m²) toplam alandan ({total} m²) büyük – alanlar yanlış olurdu.',
  'projimp.freeInvalid':
    'Bu dosyadaki {n} serbest biçimli taşın geçersiz (ör. üst üste binen) parçaları var: {ids}. Proje bunları gösterir; PDF planından önce serbest biçim düzenleyicisinde düzeltin.',
  'projimp.freeInvalid.one':
    'Bu dosyadaki bir serbest biçimli taşın geçersiz (ör. üst üste binen) parçaları var: {ids}. Proje bunu gösterir; PDF planından önce serbest biçim düzenleyicisinde düzeltin.',
  'w3fx.missing.notHere': 'malzemelerinizde yok',
};
