/**
 * w3-colour-quality: Farbmischung nur mit ähnlichen Tönen (neuer Standard 50 %), „Meine Steine – begrenzte
 * Farbanzahl“ wählt die Materialien direkt aus dem Bestand, „Fehlende Farben“ (Zielfarbtöne zum Nachkaufen).
 * Eigene Schlüssel (w3cq.*) statt Überschreibungen – colors.ditherHint und colors.mode.auto-snap.hint überschreibt
 * bereits w2-colour-honesty; StepColors verwendet nun die Schlüssel hier.
 */
export const de: Record<string, string> = {
  'w3cq.mode.autoSnapHint':
    'Wählt aus Ihrem Materialbestand bis zu so viele Farben wie eingestellt, die das Foto zusammen am besten wiedergeben (ΔE, Auswahl über die Farben aller Steine). Es werden nur vorhandene Materialien verwendet. Weniger Farben entstehen nur, wenn die Auswahl weniger Materialien hat oder weitere das Bild nicht verbessern würden. Bei fast gleicher Eignung (höchstens ΔE 0,5 schlechter) werden Materialien mit Bestand > 0 bevorzugt. Fotofarben, die kein Material gut trifft, erscheinen nach der Berechnung unter „Fehlende Farben“.',
  'w3cq.ditherHint':
    'Mischt benachbarte, ähnliche Farbtöne für weichere Verläufe (Haut, Himmel) – nur mit Farben, die der Fotofarbe des Steins fast so nahe kommen wie die beste (höchstens ΔE 3 mehr), daher keine fremden Farbtupfer. Geschnittene und feinere Steine erhalten immer die ähnlichste Farbe. Höher = weichere Verläufe, aber mehr Farbwechsel beim Legen (die Abweichung je Stein steigt leicht, aus Betrachtungsabstand wirkt das Bild genauer). 0 % = einfarbige Flächen. Standard für neue Projekte: 50 %.',

  // ---- angefordert / verwendet: Gründe für weniger Farben
  'w3cq.count.poolSmall': 'Ihre Materialauswahl hat nur {n} Farben.',
  'w3cq.count.poolSmall.one': 'Ihre Materialauswahl hat nur 1 Farbe.',
  'w3cq.count.noGain': 'Nur {n} Ihrer Materialien verbessern das Bild – weitere würden keine Steine erhalten.',
  'w3cq.count.noGain.one': 'Nur 1 Ihrer Materialien verbessert das Bild – weitere würden keine Steine erhalten.',
  'w3cq.count.stock': '{n} Materialien mit Bestand wurden bei fast gleicher Eignung bevorzugt.',
  'w3cq.count.stock.one': '1 Material mit Bestand wurde bei fast gleicher Eignung bevorzugt.',

  // ---- Fehlende Farben
  'w3cq.missing.title': 'Fehlende Farben – Farbton zum Nachkaufen (Zielwert)',
  'w3cq.missing.summary': '{n} Farbtöne · {stones} Steine{pct}',
  'w3cq.missing.summary.one': '1 Farbton · {stones} Steine{pct}',
  'w3cq.missing.pct': ' ({pct} % des Mosaiks)',
  'w3cq.missing.intro':
    'Diese Fotofarben trifft keines der angebotenen Materialien auf {de} ≤ {thr} (untersucht: {checked} typische Fotofarben). Die Werte sind Zielfarbtöne – Mittel der Fotofarben, ein Richtwert zum Vergleich mit Mustern beim Einkauf, kein bestimmtes Produkt.',
  'w3cq.missing.none': 'Fehlende Farben: keine – jede der {n} untersuchten typischen Fotofarben trifft eines Ihrer Materialien auf {de} ≤ {thr}.',
  'w3cq.missing.col.target': 'Zielfarbe',
  'w3cq.missing.col.stones': 'Steine',
  'w3cq.missing.col.nearest': 'Ähnlichstes eigenes Material',
  'w3cq.missing.col.got': 'Erhalten',
  'w3cq.missing.got': 'Ø {de} {v}',
  'w3cq.missing.stonesHint':
    '„Steine“: Steine, deren Fotofarbe diesem Ton am nächsten liegt (exakt gezählt, Stand der Berechnung). Sie haben stattdessen eine Farbe Ihres Bestands erhalten – „Erhalten“ nennt, wie weit diese im Mittel von ihrer Fotofarbe abweicht.',
  'w3cq.missing.stale': 'Stand der letzten Berechnung – die Einstellungen wurden seither geändert.',
  'w3cq.missing.materialGone': 'nicht mehr im Bestand',
};

export const en: Record<string, string> = {
  'w3cq.mode.autoSnapHint':
    'Chooses up to the set number of colours from your materials that together reproduce the photo best (ΔE, selection based on the colours of all tiles). Only materials you own are used. You only get fewer colours if your selection has fewer materials or further ones would not improve the picture. When suitability is almost equal (at most ΔE 0.5 worse), materials with stock > 0 are preferred. Photo colours that no material matches well appear under “Missing colours” after the computation.',
  'w3cq.ditherHint':
    'Blends neighbouring, similar shades for smoother transitions (skin, sky) – only with colours that come almost as close to the tile’s photo colour as the best one (at most ΔE 3 more), so no stray specks of foreign colour. Cut and finer tiles always get the most similar colour. Higher = smoother transitions, but more colour changes while laying (the deviation per tile rises slightly, from viewing distance the picture looks more accurate). 0 % = single-colour areas. Default for new projects: 50 %.',

  'w3cq.count.poolSmall': 'Your material selection has only {n} colours.',
  'w3cq.count.poolSmall.one': 'Your material selection has only 1 colour.',
  'w3cq.count.noGain': 'Only {n} of your materials improve the picture – further ones would receive no tiles.',
  'w3cq.count.noGain.one': 'Only 1 of your materials improves the picture – further ones would receive no tiles.',
  'w3cq.count.stock': '{n} materials with stock were preferred because they were almost equally suitable.',
  'w3cq.count.stock.one': '1 material with stock was preferred because it was almost equally suitable.',

  'w3cq.missing.title': 'Missing colours – shade to buy (target value)',
  'w3cq.missing.summary': '{n} shades · {stones} tiles{pct}',
  'w3cq.missing.summary.one': '1 shade · {stones} tiles{pct}',
  'w3cq.missing.pct': ' ({pct} % of the mosaic)',
  'w3cq.missing.intro':
    'None of the offered materials matches these photo colours within {de} ≤ {thr} (checked: {checked} typical photo colours). The values are target shades – averages of the photo colours, a guide value for comparing with samples when buying, not a specific product.',
  'w3cq.missing.none': 'Missing colours: none – each of the {n} checked typical photo colours is matched by one of your materials within {de} ≤ {thr}.',
  'w3cq.missing.col.target': 'Target colour',
  'w3cq.missing.col.stones': 'Tiles',
  'w3cq.missing.col.nearest': 'Most similar own material',
  'w3cq.missing.col.got': 'Received',
  'w3cq.missing.got': 'avg {de} {v}',
  'w3cq.missing.stonesHint':
    '“Tiles”: tiles whose photo colour is closest to this shade (counted exactly, as of the computation). They received a colour from your materials instead – “Received” shows how far it deviates from their photo colour on average.',
  'w3cq.missing.stale': 'As of the last computation – the settings have changed since.',
  'w3cq.missing.materialGone': 'no longer in your materials',
};

export const tr: Record<string, string> = {
  'w3cq.mode.autoSnapHint':
    'Malzemelerinizden, fotoğrafı birlikte en iyi yansıtan, ayarlanan sayıya kadar renk seçer (ΔE, tüm taşların renklerine göre seçim). Yalnızca sahip olduğunuz malzemeler kullanılır. Daha az renk yalnızca seçiminizde daha az malzeme varsa veya başka malzemeler görüntüyü iyileştirmeyecekse çıkar. Uygunluk neredeyse eşitse (en fazla ΔE 0,5 daha kötü) stoğu 0’dan fazla olan malzemeler tercih edilir. Hiçbir malzemenin iyi karşılamadığı fotoğraf renkleri hesaplamadan sonra “Eksik renkler” altında görünür.',
  'w3cq.ditherHint':
    'Daha yumuşak geçişler için (cilt, gökyüzü) komşu, benzer renk tonlarını karıştırır – yalnızca taşın fotoğraf rengine en iyisi kadar yakın olan renklerle (en fazla ΔE 3 fazla), bu yüzden yabancı renk lekeleri oluşmaz. Kesilmiş ve daha küçük taşlar her zaman en benzer rengi alır. Daha yüksek = daha yumuşak geçişler, ama döşerken daha çok renk değişimi (taş başına sapma biraz artar, uzaktan bakıldığında görüntü daha doğru görünür). %0 = tek renkli yüzeyler. Yeni projelerde varsayılan: %50.',

  'w3cq.count.poolSmall': 'Malzeme seçiminizde yalnızca {n} renk var.',
  'w3cq.count.poolSmall.one': 'Malzeme seçiminizde yalnızca 1 renk var.',
  'w3cq.count.noGain': 'Malzemelerinizden yalnızca {n} tanesi görüntüyü iyileştiriyor – diğerleri hiç taş almazdı.',
  'w3cq.count.noGain.one': 'Malzemelerinizden yalnızca 1 tanesi görüntüyü iyileştiriyor – diğerleri hiç taş almazdı.',
  'w3cq.count.stock': 'Uygunluk neredeyse eşit olduğu için stokta bulunan {n} malzeme tercih edildi.',
  'w3cq.count.stock.one': 'Uygunluk neredeyse eşit olduğu için stokta bulunan 1 malzeme tercih edildi.',

  'w3cq.missing.title': 'Eksik renkler – satın alınacak renk tonu (hedef değer)',
  'w3cq.missing.summary': '{n} renk tonu · {stones} taş{pct}',
  'w3cq.missing.summary.one': '1 renk tonu · {stones} taş{pct}',
  'w3cq.missing.pct': ' (mozaiğin %{pct}’i)',
  'w3cq.missing.intro':
    'Bu fotoğraf renklerini sunulan malzemelerin hiçbiri {de} ≤ {thr} ile karşılamıyor (incelenen: {checked} tipik fotoğraf rengi). Değerler hedef renk tonlarıdır – fotoğraf renklerinin ortalaması, satın alırken numunelerle karşılaştırmak için yaklaşık bir değer; belirli bir ürün değildir.',
  'w3cq.missing.none': 'Eksik renk yok – incelenen {n} tipik fotoğraf renginin her birini malzemelerinizden biri {de} ≤ {thr} ile karşılıyor.',
  'w3cq.missing.col.target': 'Hedef renk',
  'w3cq.missing.col.stones': 'Taşlar',
  'w3cq.missing.col.nearest': 'En benzer kendi malzemeniz',
  'w3cq.missing.col.got': 'Aldığı renk',
  'w3cq.missing.got': 'ort. {de} {v}',
  'w3cq.missing.stonesHint':
    '“Taşlar”: fotoğraf rengi bu tona en yakın olan taşlar (tam sayım, hesaplama anındaki durum). Bunun yerine malzemelerinizden bir renk aldılar – “Aldığı renk”, bu rengin fotoğraf renginden ortalama ne kadar saptığını gösterir.',
  'w3cq.missing.stale': 'Son hesaplamanın durumu – ayarlar o zamandan beri değişti.',
  'w3cq.missing.materialGone': 'artık malzemelerinizde yok',
};
