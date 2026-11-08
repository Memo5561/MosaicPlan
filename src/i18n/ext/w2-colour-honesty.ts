/**
 * w2-colour-honesty: verständliche Farbquellen, „Erweitert“-Bereich, angefordert/verwendet,
 * Abweichung je Farbe vom Foto, fehlende Materialien, Legende mit Material.
 * Überschreibt einige Grundtexte (Farbquellen, Farbmischung) – keine andere Erweiterungsdatei überschreibt sie.
 */
export const de: Record<string, string> = {
  // ---- Farbquellen in Alltagssprache (Fachbegriffe nur im Hinweis)
  'colors.mode.auto': 'Automatisch aus dem Foto',
  'colors.mode.auto-snap': 'Meine Steine – begrenzte Farbanzahl',
  'colors.mode.materials': 'Meine Steine – alle Farben',
  'colors.mode.custom': 'Eigene Farbauswahl',
  'step.colors.intro': 'Wie viele Farben das Mosaik bekommt und aus welchen Steinen sie stammen.',
  'colors.afterCompute': 'Die Farbliste entsteht bei der Berechnung. Um die Farben selbst festzulegen, „Eigene Farbauswahl“ wählen.',
  'colors.mode.auto.hint': 'Die App sucht die typischsten Farben im Foto (Verfahren: K-Means im CIELAB-Farbraum).',
  'colors.mode.auto-snap.hint':
    'Erst werden so viele typische Fotofarben gesucht wie eingestellt, dann erhält jede die ähnlichste Farbe aus Ihrem Materialbestand (ΔE). Fallen mehrere Fotofarben auf dasselbe Material, werden sie zusammengelegt – dann entstehen weniger Farben als angefordert. Es werden nur vorhandene Materialien verwendet.',
  'colors.mode.materials.hint': 'Jeder Stein erhält direkt die ähnlichste Farbe aus den ausgewählten Materialien (ΔE). Materialien, die kein Stein braucht, erscheinen nicht in der Farbliste.',
  'colors.dither': 'Farbübergänge mischen',
  'colors.ditherHint':
    'Mischt benachbarte Steinfarben für feinere Übergänge (Floyd-Steinberg). Mehr Mischung bedeutet mehr Farbwechsel beim Legen und unruhigere Flächen; 0 % empfohlen für ruhige Flächen.',

  // ---- Erweitert
  'w2ch.advanced': 'Erweitert',
  'w2ch.advancedChanged': 'geändert',
  'w2ch.deltaEHint': 'CIEDE2000 entspricht dem Farbempfinden am besten (empfohlen). CIE76 ist der einfache Abstand im CIELAB-Farbraum.',

  // ---- angefordert / verwendet (Stand der Berechnung)
  'w2ch.count.auto': 'Bei der Berechnung: angefordert {req} – verwendet {used}.',
  'w2ch.count.snap': 'Bei der Berechnung: angefordert {req} – verwendet {used} ({merged} Bildfarben zusammengelegt, weil sie auf dasselbe Material fielen).',
  'w2ch.count.materials': 'Bei der Berechnung: {req} Materialfarben zur Auswahl – {used} verwendet.',
  'w2ch.count.custom': 'Bei der Berechnung: {req} Farben in der eigenen Auswahl – {used} verwendet.',
  'w2ch.count.fewerImage': 'Das Foto ergab nur {n} unterscheidbare Farben.',
  'w2ch.count.noStones': '{n} weitere Farben erhielten keinen Stein.',
  'w2ch.count.noStones.one': '1 weitere Farbe erhielt keinen Stein.',
  'w2ch.count.snapMore': 'Für mehr verschiedene Farben weitere Materialien im Bestand anlegen oder „Automatisch aus dem Foto“ wählen.',

  // ---- Abweichung vom Foto je Farbe
  'w2ch.match': 'Ø {de} {mean}',
  'w2ch.matchMax': 'max {max}',
  'w2ch.matchTitle': 'Abweichung der {n} Steine dieser Farbe vom Foto, gemessen bei der Berechnung ({de}): Ø {mean}, höchstens {max}; {over5} Steine über ΔE 5, {over10} über ΔE 10.',
  'w2ch.matchStale': 'ΔE –',
  'w2ch.matchStaleTitle': 'Abweichung vom Foto nicht mehr aktuell: Farbe oder Steine wurden seit der Berechnung geändert. Nach einer Neuberechnung wieder verfügbar.',
  'w2ch.matchHint': 'Ø ΔE unter der Steinzahl: wie stark die Steine dieser Farbe im Mittel vom Foto abweichen (gemessen bei der Berechnung, mit deren ΔE-Formel); „12× über ΔE 5“ = 12 Steine dieser Farbe weichen um mehr als ΔE 5 ab.',
  'w2ch.matchScale': 'Einstufung (CIEDE2000): < 2 kaum sichtbar, 2–5 erkennbar, > 5 deutlich. Rot markiert: Mittel über 5.',
  'w2ch.matchNoScale': 'Berechnet mit CIE76: Die Einstufung „kaum sichtbar / erkennbar / deutlich“ gilt nur für CIEDE2000 (CIE76-Werte sind meist größer) – daher hier keine Einstufung und keine Rotmarkierung.',
  'w2ch.over5': '{n}× über ΔE 5',

  // ---- Tabelle
  'w2ch.hexLab': 'HEX · L*a*b*',
  'w2ch.namePlaceholder': 'leer = automatischer Name',
  'w2ch.autoName': 'Automatischer Name – folgt der Sprache und ändert sich mit der Farbe',
  'w2ch.materialMissing': 'Material fehlt',
  'w2ch.materialMissingTitle': 'Das verknüpfte Material ist nicht (mehr) im Materialbestand – gelöscht oder nicht importiert.',
  'w2ch.materialDE': 'ΔE {de} zum Material',
  'w2ch.mergedFrom': 'aus {n} Bildfarben',
  'w2ch.mergedFromTitle': 'Auf dieses Material fielen bei der Berechnung {n} der aus dem Foto ermittelten Farben – sie wurden zusammengelegt.',

  // ---- Legende
  'w2ch.legendMaterialMissing': 'Material fehlt',
};

export const en: Record<string, string> = {
  'colors.mode.auto': 'Automatically from the photo',
  'colors.mode.auto-snap': 'My tiles – limited number of colours',
  'colors.mode.materials': 'My tiles – all colours',
  'colors.mode.custom': 'My own colour selection',
  'step.colors.intro': 'How many colours the mosaic gets and which tiles they come from.',
  'colors.afterCompute': 'The colour list is created during calculation. To define the colours yourself, choose “My own colour selection”.',
  'colors.mode.auto.hint': 'The app finds the most typical colours in the photo (method: k-means in the CIELAB colour space).',
  'colors.mode.auto-snap.hint':
    'First the set number of typical photo colours is found, then each one gets the most similar colour from your materials (ΔE). If several photo colours land on the same material they are merged – you then get fewer colours than requested. Only materials you own are used.',
  'colors.mode.materials.hint': 'Every tile directly gets the most similar colour from the selected materials (ΔE). Materials that no tile needs do not appear in the colour list.',
  'colors.dither': 'Blend colour transitions',
  'colors.ditherHint':
    'Mixes neighbouring tile colours for finer transitions (Floyd–Steinberg). More blending means more colour changes while laying and busier areas; 0 % is recommended for calm areas.',

  'w2ch.advanced': 'Advanced',
  'w2ch.advancedChanged': 'changed',
  'w2ch.deltaEHint': 'CIEDE2000 matches colour perception best (recommended). CIE76 is the plain distance in the CIELAB colour space.',

  'w2ch.count.auto': 'At computation: {req} requested – {used} used.',
  'w2ch.count.snap': 'At computation: {req} requested – {used} used ({merged} photo colours merged because they landed on the same material).',
  'w2ch.count.materials': 'At computation: {req} material colours available – {used} used.',
  'w2ch.count.custom': 'At computation: {req} colours in your own selection – {used} used.',
  'w2ch.count.fewerImage': 'The photo only yielded {n} distinguishable colours.',
  'w2ch.count.noStones': '{n} more colours received no tile.',
  'w2ch.count.noStones.one': '1 more colour received no tile.',
  'w2ch.count.snapMore': 'For more different colours, add further materials to your stock or choose “Automatically from the photo”.',

  'w2ch.match': 'avg {de} {mean}',
  'w2ch.matchMax': 'max {max}',
  'w2ch.matchTitle': 'Deviation of the {n} tiles of this colour from the photo, measured at computation ({de}): average {mean}, at most {max}; {over5} tiles above ΔE 5, {over10} above ΔE 10.',
  'w2ch.matchStale': 'ΔE –',
  'w2ch.matchStaleTitle': 'Deviation from the photo is no longer current: the colour or tiles were changed since the computation. Available again after recomputing.',
  'w2ch.matchHint': 'avg ΔE below the tile count: how much the tiles of this colour deviate from the photo on average (measured at computation, with its ΔE formula); “12× above ΔE 5” = 12 tiles of this colour deviate by more than ΔE 5.',
  'w2ch.matchScale': 'Rating (CIEDE2000): < 2 barely visible, 2–5 noticeable, > 5 clear. Marked red: average above 5.',
  'w2ch.matchNoScale': 'Computed with CIE76: the rating “barely visible / noticeable / clear” applies to CIEDE2000 only (CIE76 values are usually larger) – so there is no rating and no red marking here.',
  'w2ch.over5': '{n}× above ΔE 5',

  'w2ch.hexLab': 'HEX · L*a*b*',
  'w2ch.namePlaceholder': 'empty = automatic name',
  'w2ch.autoName': 'Automatic name – follows the language and changes with the colour',
  'w2ch.materialMissing': 'Material missing',
  'w2ch.materialMissingTitle': 'The linked material is no longer in your materials – deleted or not imported.',
  'w2ch.materialDE': 'ΔE {de} to material',
  'w2ch.mergedFrom': 'from {n} photo colours',
  'w2ch.mergedFromTitle': '{n} of the colours found in the photo landed on this material at computation – they were merged.',

  'w2ch.legendMaterialMissing': 'Material missing',
};

export const tr: Record<string, string> = {
  'colors.mode.auto': 'Fotoğraftan otomatik',
  'colors.mode.auto-snap': 'Taşlarım – sınırlı renk sayısı',
  'colors.mode.materials': 'Taşlarım – tüm renkler',
  'colors.mode.custom': 'Kendi renk seçimim',
  'step.colors.intro': 'Mozaiğin kaç renk alacağı ve bu renklerin hangi taşlardan geleceği.',
  'colors.afterCompute': 'Renk listesi hesaplama sırasında oluşturulur. Renkleri kendiniz belirlemek için “Kendi renk seçimim”i seçin.',
  'colors.mode.auto.hint': 'Uygulama fotoğraftaki en tipik renkleri bulur (yöntem: CIELAB renk uzayında K-Means).',
  'colors.mode.auto-snap.hint':
    'Önce ayarlanan sayıda tipik fotoğraf rengi bulunur, sonra her biri malzemelerinizdeki en benzer rengi alır (ΔE). Birden fazla fotoğraf rengi aynı malzemeye düşerse birleştirilir – bu durumda istenenden daha az renk çıkar. Yalnızca mevcut malzemeler kullanılır.',
  'colors.mode.materials.hint': 'Her taş doğrudan seçili malzemeler arasından en benzer rengi alır (ΔE). Hiçbir taşın ihtiyaç duymadığı malzemeler renk listesinde görünmez.',
  'colors.dither': 'Renk geçişlerini karıştır',
  'colors.ditherHint':
    'Daha ince geçişler için komşu taş renklerini karıştırır (Floyd-Steinberg). Daha fazla karıştırma, döşerken daha çok renk değişimi ve daha hareketli yüzeyler demektir; sakin yüzeyler için %0 önerilir.',

  'w2ch.advanced': 'Gelişmiş',
  'w2ch.advancedChanged': 'değiştirildi',
  'w2ch.deltaEHint': 'CIEDE2000 renk algısına en iyi uyar (önerilir). CIE76, CIELAB renk uzayındaki basit uzaklıktır.',

  'w2ch.count.auto': 'Hesaplamada: istenen {req} – kullanılan {used}.',
  'w2ch.count.snap': 'Hesaplamada: istenen {req} – kullanılan {used} (aynı malzemeye düştükleri için {merged} fotoğraf rengi birleştirildi).',
  'w2ch.count.materials': 'Hesaplamada: seçilebilecek {req} malzeme rengi – {used} kullanıldı.',
  'w2ch.count.custom': 'Hesaplamada: kendi seçiminizde {req} renk – {used} kullanıldı.',
  'w2ch.count.fewerImage': 'Fotoğraftan yalnızca {n} ayırt edilebilir renk çıktı.',
  'w2ch.count.noStones': '{n} renk daha hiç taş almadı.',
  'w2ch.count.noStones.one': '1 renk daha hiç taş almadı.',
  'w2ch.count.snapMore': 'Daha fazla farklı renk için stoğa başka malzemeler ekleyin veya “Fotoğraftan otomatik” seçin.',

  'w2ch.match': 'ort. {de} {mean}',
  'w2ch.matchMax': 'en çok {max}',
  'w2ch.matchTitle': 'Bu rengin {n} taşının fotoğraftan sapması, hesaplamada ölçüldü ({de}): ortalama {mean}, en çok {max}; ΔE 5 üzerinde {over5} taş, ΔE 10 üzerinde {over10}.',
  'w2ch.matchStale': 'ΔE –',
  'w2ch.matchStaleTitle': 'Fotoğraftan sapma artık güncel değil: renk veya taşlar hesaplamadan sonra değiştirildi. Yeniden hesaplamadan sonra tekrar görünür.',
  'w2ch.matchHint': 'Taş sayısının altındaki ort. ΔE: bu rengin taşlarının fotoğraftan ortalama ne kadar saptığı (hesaplamada, onun ΔE formülüyle ölçüldü); “ΔE 5 üzerinde 12” = bu rengin 12 taşı ΔE 5’ten fazla sapıyor.',
  'w2ch.matchScale': 'Derecelendirme (CIEDE2000): < 2 neredeyse görünmez, 2–5 fark edilir, > 5 belirgin. Kırmızı işaretli: ortalama 5’in üzerinde.',
  'w2ch.matchNoScale': 'CIE76 ile hesaplandı: “neredeyse görünmez / fark edilir / belirgin” derecelendirmesi yalnızca CIEDE2000 için geçerlidir (CIE76 değerleri genellikle daha büyüktür) – bu yüzden burada derecelendirme ve kırmızı işaret yok.',
  'w2ch.over5': 'ΔE 5 üzerinde {n}',

  'w2ch.hexLab': 'HEX · L*a*b*',
  'w2ch.namePlaceholder': 'boş = otomatik ad',
  'w2ch.autoName': 'Otomatik ad – dile uyar ve renkle birlikte değişir',
  'w2ch.materialMissing': 'Malzeme eksik',
  'w2ch.materialMissingTitle': 'Bağlı malzeme artık malzemelerinizde yok – silinmiş veya içe aktarılmamış.',
  'w2ch.materialDE': 'Malzemeye ΔE {de}',
  'w2ch.mergedFrom': '{n} fotoğraf renginden',
  'w2ch.mergedFromTitle': 'Hesaplamada fotoğraftan bulunan renklerden {n} tanesi bu malzemeye düştü – birleştirildi.',

  'w2ch.legendMaterialMissing': 'Malzeme eksik',
};
