/**
 * Texte für w1-mosaic-core: stabile eigene Palette, Farbe entfernen mit Ersatzfarbe,
 * „Palette aus Materialien“ zusammenführen (src/ui/project/StepColors.tsx).
 */
export const de: Record<string, string> = {
  // geänderte Texte (überschreiben de.ts)
  'colors.mode.custom.hint':
    'Sie legen die Palette selbst fest (Farben unten hinzufügen/entfernen). Bei der Berechnung bleiben alle Farben in ihrer Reihenfolge erhalten – auch nicht verwendete (0 Steine).',
  'colors.removeHint':
    'Vor dem Entfernen einer Farbe sehen Sie, wie viele Steine betroffen sind, und wählen die Ersatzfarbe (Vorschlag: nächstgelegene Farbe nach ΔE). Die Nummern der übrigen Farben bleiben unverändert.',

  'colors.unused': 'nicht verwendet',
  'colors.usedOf': '{used} von {total} verwendet',

  'colors.rm.title': 'Farbe {code} „{name}“ entfernen',
  'colors.rm.stones': '{n} Steine haben diese Farbe. Sie erhalten die Ersatzfarbe:',
  'colors.rm.stones.one': '{n} Stein hat diese Farbe. Er erhält die Ersatzfarbe:',
  'colors.rm.replacement': 'Ersatzfarbe',
  'colors.rm.nearest': 'nächste',
  'colors.rm.noStones': 'Kein Stein verwendet diese Farbe – es wird nichts umgestellt.',
  'colors.rm.notComputed': 'Noch nicht berechnet – die Farbe wird nur aus der Palette entfernt.',
  'colors.rm.note': 'Die Nummern der übrigen Farben bleiben unverändert – auch beim Neuberechnen. Für eine optimale Farbzuordnung können Sie anschließend neu berechnen.',
  'colors.rm.noteAuto':
    'Die Entfernung gilt nur für das aktuelle Ergebnis: „Neu berechnen“ erstellt die Palette wieder automatisch – Farbe {code} kann dann zurückkehren, die Nummern werden neu vergeben. Für dauerhafte Änderungen „Eigene Palette“ wählen.',
  'colors.rm.noteMaterials':
    'Die Entfernung gilt nur für das aktuelle Ergebnis: „Neu berechnen“ wählt wieder aus allen ausgewählten Materialien – Farbe {code} kann dann zurückkehren. Damit sie wegbleibt, das Material oben in der Materialauswahl abwählen (oder „Eigene Palette“ wählen).',
  'colors.removeHintAuto':
    'Bei dieser Farbquelle erstellt „Neu berechnen“ die Palette neu: Entfernte Farben können zurückkehren, die Nummern werden neu vergeben. Für dauerhafte Änderungen „Eigene Palette“ wählen.',
  'colors.removeHintMaterials':
    'Bei dieser Farbquelle wählt „Neu berechnen“ wieder aus allen ausgewählten Materialien: Entfernte Farben können zurückkehren. Dauerhaft: das Material in der Materialauswahl abwählen oder „Eigene Palette“ wählen.',
  'colors.locked':
    'Eine Berechnung dieses Projekts läuft (hier, in einer zuvor geöffneten Ansicht oder in einem anderen Tab). Farbquelle und Palette sind bis zum Ende gesperrt, damit das Ergebnis zur Palette passt.',
  'colors.rm.confirm': 'Farbe entfernen',
  'colors.rm.done': 'Farbe {code} entfernt – {n} Steine auf {target} umgestellt.',
  'colors.rm.done.one': 'Farbe {code} entfernt – {n} Stein auf {target} umgestellt.',
  'colors.rm.doneNoStones': 'Farbe {code} entfernt – keine Steine betroffen.',
  'colors.rm.changed': 'Die Palette wurde inzwischen geändert – bitte erneut versuchen.',

  'colors.merge.title': 'Palette aus Materialien',
  'colors.merge.intro': 'Die Palette wird mit Ihren Materialien abgeglichen. Vorhandene Farben behalten ihre Nummer, es wird nichts umsortiert.',
  'colors.merge.added': '{n} Materialfarben werden ergänzt (neue Nummern).',
  'colors.merge.added.one': '{n} Materialfarbe wird ergänzt (neue Nummer).',
  'colors.merge.removed': '{n} Farben ohne passendes Material werden entfernt:',
  'colors.merge.removed.one': '{n} Farbe ohne passendes Material wird entfernt:',
  'colors.merge.moved': '{n} Steine werden auf die nächstgelegene verbleibende Farbe umgestellt (max. ΔE {de}).',
  'colors.merge.moved.one': '{n} Stein wird auf die nächstgelegene verbleibende Farbe umgestellt (max. ΔE {de}).',
  'colors.merge.movedNone': 'Kein Stein wird umgestellt.',
  'colors.merge.linked': '{n} Farben werden mit einem Material exakt gleicher Farbe verknüpft.',
  'colors.merge.linked.one': '{n} Farbe wird mit einem Material exakt gleicher Farbe verknüpft.',
  'colors.merge.recolored': '{n} Farben übernehmen die geänderte Materialfarbe (Steine: {stones}, max. ΔE {de}).',
  'colors.merge.recolored.one': '{n} Farbe übernimmt die geänderte Materialfarbe (Steine: {stones}, max. ΔE {de}).',
  'colors.merge.unchanged': 'Die Palette entspricht bereits Ihren Materialien – nichts zu tun.',
  'colors.merge.noValid': 'Keine Materialfarbe mit gültigem HEX-Wert vorhanden.',
  'colors.merge.recompute': 'Empfehlung: anschließend neu berechnen, damit auch neu ergänzte Farben genutzt werden.',
  'colors.merge.apply': 'Übernehmen',
  'colors.merge.done': 'Palette übernommen: Farben +{added} / −{removed}, umgestellte Steine: {n} (max. ΔE {de}).',
  'colors.merge.replaceInfo': 'Noch nicht berechnet: Die Palette wird durch die Materialfarben ersetzt (Anzahl: {n}, Nummern 01–{last}). Die bisherige Palette (Anzahl Farben: {old}) wird verworfen.',
  'colors.merge.replaced': 'Palette aus {n} Materialfarben erstellt.',
  'colors.merge.replaced.one': 'Palette aus {n} Materialfarbe erstellt.',
  'colors.merge.colTarget': 'Ersatzfarbe',
};

export const en: Record<string, string> = {
  'colors.mode.custom.hint':
    'You define the palette yourself (add/remove colours below). Calculation keeps every colour in its order – including unused ones (0 tiles).',
  'colors.removeHint':
    'Before a colour is removed you see how many tiles are affected and choose the replacement colour (suggested: nearest colour by ΔE). The numbers of the other colours stay unchanged.',

  'colors.unused': 'not used',
  'colors.usedOf': '{used} of {total} used',

  'colors.rm.title': 'Remove colour {code} “{name}”',
  'colors.rm.stones': '{n} tiles have this colour. They will get the replacement colour:',
  'colors.rm.stones.one': '{n} tile has this colour. It will get the replacement colour:',
  'colors.rm.replacement': 'Replacement colour',
  'colors.rm.nearest': 'nearest',
  'colors.rm.noStones': 'No tile uses this colour – nothing will be changed.',
  'colors.rm.notComputed': 'Not calculated yet – the colour is only removed from the palette.',
  'colors.rm.note': 'The numbers of the other colours stay unchanged – also when recalculating. For an optimal colour assignment you can recalculate afterwards.',
  'colors.rm.noteAuto':
    'The removal only applies to the current result: “Recompute” builds the palette automatically again – colour {code} may come back and the numbers are assigned anew. For permanent changes choose “Custom palette”.',
  'colors.rm.noteMaterials':
    'The removal only applies to the current result: “Recompute” picks from all selected materials again – colour {code} may come back. To keep it out, deselect the material in the material selection above (or choose “Custom palette”).',
  'colors.removeHintAuto':
    'With this colour source “Recompute” builds the palette anew: removed colours may come back and the numbers are assigned anew. For permanent changes choose “Custom palette”.',
  'colors.removeHintMaterials':
    'With this colour source “Recompute” picks from all selected materials again: removed colours may come back. Permanently: deselect the material in the material selection or choose “Custom palette”.',
  'colors.locked':
    'A calculation of this project is running (here, in a previously opened view or in another tab). Colour source and palette are locked until it ends, so that the result matches the palette.',
  'colors.rm.confirm': 'Remove colour',
  'colors.rm.done': 'Colour {code} removed – {n} tiles changed to {target}.',
  'colors.rm.done.one': 'Colour {code} removed – {n} tile changed to {target}.',
  'colors.rm.doneNoStones': 'Colour {code} removed – no tiles affected.',
  'colors.rm.changed': 'The palette has changed in the meantime – please try again.',

  'colors.merge.title': 'Palette from materials',
  'colors.merge.intro': 'The palette is matched against your materials. Existing colours keep their number; nothing is re-sorted.',
  'colors.merge.added': '{n} material colours will be added (new numbers).',
  'colors.merge.added.one': '{n} material colour will be added (new number).',
  'colors.merge.removed': '{n} colours without a matching material will be removed:',
  'colors.merge.removed.one': '{n} colour without a matching material will be removed:',
  'colors.merge.moved': '{n} tiles will be changed to the nearest remaining colour (max. ΔE {de}).',
  'colors.merge.moved.one': '{n} tile will be changed to the nearest remaining colour (max. ΔE {de}).',
  'colors.merge.movedNone': 'No tile will be changed.',
  'colors.merge.linked': '{n} colours will be linked to a material of exactly the same colour.',
  'colors.merge.linked.one': '{n} colour will be linked to a material of exactly the same colour.',
  'colors.merge.recolored': '{n} colours take over the changed material colour (tiles: {stones}, max. ΔE {de}).',
  'colors.merge.recolored.one': '{n} colour takes over the changed material colour (tiles: {stones}, max. ΔE {de}).',
  'colors.merge.unchanged': 'The palette already matches your materials – nothing to do.',
  'colors.merge.noValid': 'No material colour with a valid HEX value.',
  'colors.merge.recompute': 'Recommendation: recalculate afterwards so that newly added colours are used too.',
  'colors.merge.apply': 'Apply',
  'colors.merge.done': 'Palette applied: colours +{added} / −{removed}, tiles changed: {n} (max. ΔE {de}).',
  'colors.merge.replaceInfo': 'Not calculated yet: the palette will be replaced by the material colours (count: {n}, numbers 01–{last}). The current palette (colours: {old}) will be discarded.',
  'colors.merge.replaced': 'Palette created from {n} material colours.',
  'colors.merge.replaced.one': 'Palette created from {n} material colour.',
  'colors.merge.colTarget': 'Replacement',
};

export const tr: Record<string, string> = {
  'colors.mode.custom.hint':
    'Paleti kendiniz belirlersiniz (aşağıdan renk ekleyin/kaldırın). Hesaplamada tüm renkler sıralarıyla korunur – kullanılmayanlar da (0 taş).',
  'colors.removeHint':
    'Bir renk kaldırılmadan önce kaç taşın etkileneceğini görür ve yedek rengi seçersiniz (öneri: ΔE’ye göre en yakın renk). Diğer renklerin numaraları değişmez.',

  'colors.unused': 'kullanılmıyor',
  'colors.usedOf': '{total} renkten {used} tanesi kullanılıyor',

  'colors.rm.title': '{code} “{name}” rengini kaldır',
  'colors.rm.stones': 'Bu renkte {n} taş var. Şu yedek rengi alacaklar:',
  'colors.rm.stones.one': 'Bu renkte {n} taş var. Şu yedek rengi alacak:',
  'colors.rm.replacement': 'Yedek renk',
  'colors.rm.nearest': 'en yakın',
  'colors.rm.noStones': 'Bu rengi hiçbir taş kullanmıyor – hiçbir şey değişmeyecek.',
  'colors.rm.notComputed': 'Henüz hesaplanmadı – renk yalnızca paletten kaldırılır.',
  'colors.rm.note': 'Diğer renklerin numaraları değişmez – yeniden hesaplamada da. En iyi renk eşleşmesi için ardından yeniden hesaplayabilirsiniz.',
  'colors.rm.noteAuto':
    'Kaldırma yalnızca mevcut sonuç için geçerlidir: “Yeniden hesapla” paleti yeniden otomatik oluşturur – {code} rengi geri gelebilir, numaralar yeniden verilir. Kalıcı değişiklikler için “Özel palet” seçin.',
  'colors.rm.noteMaterials':
    'Kaldırma yalnızca mevcut sonuç için geçerlidir: “Yeniden hesapla” yine seçili tüm malzemeler arasından seçer – {code} rengi geri gelebilir. Dışarıda kalması için malzemeyi yukarıdaki malzeme seçiminden kaldırın (veya “Özel palet” seçin).',
  'colors.removeHintAuto':
    'Bu renk kaynağında “Yeniden hesapla” paleti yeniden oluşturur: kaldırılan renkler geri gelebilir, numaralar yeniden verilir. Kalıcı değişiklikler için “Özel palet” seçin.',
  'colors.removeHintMaterials':
    'Bu renk kaynağında “Yeniden hesapla” yine seçili tüm malzemeler arasından seçer: kaldırılan renkler geri gelebilir. Kalıcı olarak: malzemeyi malzeme seçiminden kaldırın veya “Özel palet” seçin.',
  'colors.locked':
    'Bu projenin bir hesaplaması sürüyor (burada, daha önce açılmış bir görünümde veya başka bir sekmede). Sonucun paletle uyuşması için renk kaynağı ve palet bitene kadar kilitlidir.',
  'colors.rm.confirm': 'Rengi kaldır',
  'colors.rm.done': '{code} rengi kaldırıldı – {n} taş {target} rengine geçirildi.',
  'colors.rm.done.one': '{code} rengi kaldırıldı – {n} taş {target} rengine geçirildi.',
  'colors.rm.doneNoStones': '{code} rengi kaldırıldı – hiçbir taş etkilenmedi.',
  'colors.rm.changed': 'Palet bu arada değişti – lütfen tekrar deneyin.',

  'colors.merge.title': 'Malzemelerden palet',
  'colors.merge.intro': 'Palet malzemelerinizle karşılaştırılır. Mevcut renkler numaralarını korur; yeniden sıralama yapılmaz.',
  'colors.merge.added': '{n} malzeme rengi eklenecek (yeni numaralarla).',
  'colors.merge.added.one': '{n} malzeme rengi eklenecek (yeni numarayla).',
  'colors.merge.removed': 'Uygun malzemesi olmayan {n} renk kaldırılacak:',
  'colors.merge.removed.one': 'Uygun malzemesi olmayan {n} renk kaldırılacak:',
  'colors.merge.moved': '{n} taş kalan en yakın renge geçirilecek (maks. ΔE {de}).',
  'colors.merge.moved.one': '{n} taş kalan en yakın renge geçirilecek (maks. ΔE {de}).',
  'colors.merge.movedNone': 'Hiçbir taş değişmeyecek.',
  'colors.merge.linked': '{n} renk, tam olarak aynı renkteki bir malzemeyle ilişkilendirilecek.',
  'colors.merge.linked.one': '{n} renk, tam olarak aynı renkteki bir malzemeyle ilişkilendirilecek.',
  'colors.merge.recolored': '{n} renk değişen malzeme rengini alacak (taş: {stones}, maks. ΔE {de}).',
  'colors.merge.recolored.one': '{n} renk değişen malzeme rengini alacak (taş: {stones}, maks. ΔE {de}).',
  'colors.merge.unchanged': 'Palet zaten malzemelerinize uygun – yapılacak bir şey yok.',
  'colors.merge.noValid': 'Geçerli HEX değerine sahip malzeme rengi yok.',
  'colors.merge.recompute': 'Öneri: Yeni eklenen renklerin de kullanılması için ardından yeniden hesaplayın.',
  'colors.merge.apply': 'Uygula',
  'colors.merge.done': 'Palet uygulandı: renkler +{added} / −{removed}, değiştirilen taş: {n} (maks. ΔE {de}).',
  'colors.merge.replaceInfo': 'Henüz hesaplanmadı: Palet malzeme renkleriyle değiştirilecek (adet: {n}, numaralar 01–{last}). Mevcut palet (renk sayısı: {old}) atılacak.',
  'colors.merge.replaced': '{n} malzeme renginden palet oluşturuldu.',
  'colors.merge.replaced.one': '{n} malzeme renginden palet oluşturuldu.',
  'colors.merge.colTarget': 'Yedek renk',
};
