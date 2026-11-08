/**
 * Texte der Korrekturen nach dem Review von Welle 4 (w4fx.*): übersprungene Akzentgruppen statt „keine“, Steine der
 * Akzentliste als Knöpfe, Codeplan unvollständig, Farbverschiebung bei weniger Hintergrundschnitten, Malen mit zu
 * kleinen Steinen, Hinweise ohne Verlegemodus, Rückfrage beim Neuberechnen mit geändertem Raster, Statistik läuft.
 */
export const de: Record<string, string> = {
  // ---- Fehlende Akzentfarben
  'w4fx.acc.noneShown': 'Fehlende Akzentfarben: kein Vorschlag.',
  'w4fx.acc.noneUnknown':
    'Fehlende Akzentfarben: kein Vorschlag. Diese Berechnung stammt aus einer älteren Version – ob Gruppen ohne passendes Material übersprungen wurden, ist nicht gespeichert; neu berechnen zeigt es genau.',
  'w4fx.acc.skip.noMaterial':
    '{groups} Gruppen ({stones} Steine) weichen um mehr als {de} {thr} ab, aber keines der angebotenen Materialien liegt näher als {de} {thr} an ihrem Farbton – kein Vorschlag möglich; siehe „Fehlende Farben“.',
  'w4fx.acc.skip.noMaterial.one':
    'Eine Gruppe ({stones} Steine) weicht um mehr als {de} {thr} ab, aber keines der angebotenen Materialien liegt näher als {de} {thr} an ihrem Farbton – kein Vorschlag möglich; siehe „Fehlende Farben“.',
  'w4fx.acc.skip.inPalette':
    '{groups} Gruppen ({stones} Steine) weichen um mehr als {de} {thr} ab; das passendste Material ist aber schon in der Palette – eine Pflichtfarbe brächte keine neue Farbe.',
  'w4fx.acc.skip.inPalette.one':
    'Eine Gruppe ({stones} Steine) weicht um mehr als {de} {thr} ab; das passendste Material ist aber schon in der Palette – eine Pflichtfarbe brächte keine neue Farbe.',
  'w4fx.acc.skip.nearPalette':
    '{groups} Gruppen ({stones} Steine) weichen um mehr als {de} {thr} von ihrer erhaltenen Farbe ab, liegen im Mittel aber höchstens {de} {half} von einer Palettenfarbe entfernt – ein Vorschlag in diesem Ton brächte keine neue Farbe.',
  'w4fx.acc.skip.nearPalette.one':
    'Eine Gruppe ({stones} Steine) weicht um mehr als {de} {thr} von ihrer erhaltenen Farbe ab, liegt im Mittel aber höchstens {de} {half} von einer Palettenfarbe entfernt – ein Vorschlag in diesem Ton brächte keine neue Farbe.',
  'w4fx.acc.skip.ungrouped': 'Weitere {stones} Steine über {de} {thr} wurden nicht mehr zu Gruppen zusammengefasst (geprüft werden höchstens {max} Gruppen).',
  'w4fx.acc.skip.ungrouped.one': 'Ein weiterer Stein über {de} {thr} wurde nicht mehr zu einer Gruppe zusammengefasst (geprüft werden höchstens {max} Gruppen).',
  'w4fx.acc.idsLabel': 'Steine (antippen zum Ansehen):',
  'w4fx.acc.openStone': 'Stein {id} in Schritt 8 (Vorschau) öffnen',
  'w4fx.acc.openHint': 'Eine Steinbezeichnung antippen öffnet den Stein in Schritt 8 (Vorschau).',
  'w4fx.acc.previewIdsHint': 'Diese Steine gehören zur Vorschau – nach „Vorschau übernehmen“ lassen sie sich in Schritt 8 öffnen.',

  // ---- PDF (Schritt 10)
  'w4fx.pdf.codesIncomplete':
    'Auch im Codeplan (bis {k}-fach vergrößert) sind die Steine bei diesem Maßstab zu klein für Farbnummern – der Codeplan bleibt unvollständig. Größeren Maßstab oder kleinere Abschnitte wählen; die Farbe jeder Position enthält der CSV-Export.',

  // ---- Schritt 6: Schnitte verteilen
  'w4fx.bg.paletteNote':
    'Bei automatischer Farbwahl wird die Palette aus allen Steinen neu berechnet – dadurch können sich Farbtöne auch in den Bereichen verschieben, einzelne Steine erhalten eine andere Farbe.',

  // ---- Schritt 9: Verlegen
  'w4fx.paintTooSmall': 'Steine zu klein zum Malen – einmal antippen zoomt hinein (oder mit zwei Fingern zoomen); bis dahin verschiebt Ziehen nur das Bild.',
  'w4fx.toolHint.off':
    'Verlegemodus einschalten, dann markiert Antippen Steine als verlegt. Jetzt öffnet Antippen das Steindetail; mit dem Finger zoomt ein Tippen auf zu kleine Steine nur hinein.',
  'w4fx.chips.hintView': 'Antippen hebt eine Farbe hervor.',
  'w4fx.stats.updating': 'Zahlen werden aktualisiert …',

  // ---- Neu berechnen mit geändertem Raster: kein „bei gleichem Raster …“, sondern das feststehende Ergebnis
  'w4fx.guard.leadLayout':
    'Neu berechnen ersetzt das aktuelle Mosaik und verwirft dabei: {list}. Das Raster ändert sich ({reasons}) – deshalb werden alle {n} verlegten Steine wieder offen; keiner wird übernommen.',
  'w4fx.guard.leadLayout.one':
    'Neu berechnen ersetzt das aktuelle Mosaik und verwirft dabei: {list}. Das Raster ändert sich ({reasons}) – deshalb wird der verlegte Stein wieder offen; er wird nicht übernommen.',
  'w4fx.pending.leadLayout':
    'Die Berechnung ist fertig. Während sie lief, wurde am bisherigen Mosaik weitergearbeitet. Das neue Ergebnis zu übernehmen verwirft: {list}. Das Raster hat sich geändert ({reasons}) – alle {n} verlegten Steine werden wieder offen.',
  'w4fx.pending.leadLayout.one':
    'Die Berechnung ist fertig. Während sie lief, wurde am bisherigen Mosaik weitergearbeitet. Das neue Ergebnis zu übernehmen verwirft: {list}. Das Raster hat sich geändert ({reasons}) – der verlegte Stein wird wieder offen.',
  'w4fx.overwriteLayout':
    'Achtung: Neu berechnen verwirft {list}. Vorher wird nachgefragt; eine Sicherungskopie ist möglich. Das Raster ändert sich ({reasons}) – alle {n} verlegten Steine werden wieder offen.',
  'w4fx.overwriteLayout.one':
    'Achtung: Neu berechnen verwirft {list}. Vorher wird nachgefragt; eine Sicherungskopie ist möglich. Das Raster ändert sich ({reasons}) – der verlegte Stein wird wieder offen.',
};

export const en: Record<string, string> = {
  'w4fx.acc.noneShown': 'Missing accent colours: no suggestion.',
  'w4fx.acc.noneUnknown':
    'Missing accent colours: no suggestion. This computation comes from an older version – whether groups without a matching material were skipped is not stored; recomputing shows it exactly.',
  'w4fx.acc.skip.noMaterial':
    '{groups} groups ({stones} tiles) deviate by more than {de} {thr}, but none of the offered materials is closer than {de} {thr} to their colour – no suggestion possible; see “Missing colours”.',
  'w4fx.acc.skip.noMaterial.one':
    'One group ({stones} tiles) deviates by more than {de} {thr}, but none of the offered materials is closer than {de} {thr} to its colour – no suggestion possible; see “Missing colours”.',
  'w4fx.acc.skip.inPalette':
    '{groups} groups ({stones} tiles) deviate by more than {de} {thr}; the closest material is already in the palette – a required colour would not add a new colour.',
  'w4fx.acc.skip.inPalette.one':
    'One group ({stones} tiles) deviates by more than {de} {thr}; the closest material is already in the palette – a required colour would not add a new colour.',
  'w4fx.acc.skip.nearPalette':
    '{groups} groups ({stones} tiles) deviate by more than {de} {thr} from the colour they received, but on average lie at most {de} {half} from a palette colour – a suggestion in that shade would not add a new colour.',
  'w4fx.acc.skip.nearPalette.one':
    'One group ({stones} tiles) deviates by more than {de} {thr} from the colour it received, but on average lies at most {de} {half} from a palette colour – a suggestion in that shade would not add a new colour.',
  'w4fx.acc.skip.ungrouped': '{stones} more tiles above {de} {thr} were not combined into groups (at most {max} groups are checked).',
  'w4fx.acc.skip.ungrouped.one': 'One more tile above {de} {thr} was not combined into a group (at most {max} groups are checked).',
  'w4fx.acc.idsLabel': 'Tiles (tap to view):',
  'w4fx.acc.openStone': 'Open tile {id} in step 8 (preview)',
  'w4fx.acc.openHint': 'Tapping a tile ID opens the tile in step 8 (preview).',
  'w4fx.acc.previewIdsHint': 'These tiles belong to the preview – after “Apply preview” they can be opened in step 8.',

  'w4fx.pdf.codesIncomplete':
    'Even in the code plan (enlarged up to {k}×) the tiles are too small for colour numbers at this scale – the code plan stays incomplete. Choose a larger scale or smaller sections; the CSV export contains the colour of every position.',

  'w4fx.bg.paletteNote':
    'With automatic colour choice the palette is recomputed from all tiles – so colours inside the areas can shift too, and single tiles may get a different colour.',

  'w4fx.paintTooSmall': 'Tiles too small to paint – tap once to zoom in (or pinch); until then dragging only moves the view.',
  'w4fx.toolHint.off':
    'Switch on laying mode, then tapping marks tiles as laid. Right now tapping opens the tile details; with a finger, a tap on tiles that are too small only zooms in.',
  'w4fx.chips.hintView': 'Tap to highlight a colour.',
  'w4fx.stats.updating': 'Updating figures …',

  'w4fx.guard.leadLayout':
    'Recomputing replaces the current mosaic and discards: {list}. The grid changes ({reasons}) – so all {n} laid tiles become open again; none is carried over.',
  'w4fx.guard.leadLayout.one':
    'Recomputing replaces the current mosaic and discards: {list}. The grid changes ({reasons}) – so the laid tile becomes open again; it is not carried over.',
  'w4fx.pending.leadLayout':
    'The computation has finished. While it was running, the previous mosaic was edited. Applying the new result discards: {list}. The grid has changed ({reasons}) – all {n} laid tiles become open again.',
  'w4fx.pending.leadLayout.one':
    'The computation has finished. While it was running, the previous mosaic was edited. Applying the new result discards: {list}. The grid has changed ({reasons}) – the laid tile becomes open again.',
  'w4fx.overwriteLayout':
    'Caution: recomputing discards {list}. You will be asked first; a backup copy is possible. The grid changes ({reasons}) – all {n} laid tiles become open again.',
  'w4fx.overwriteLayout.one':
    'Caution: recomputing discards {list}. You will be asked first; a backup copy is possible. The grid changes ({reasons}) – the laid tile becomes open again.',
};

export const tr: Record<string, string> = {
  'w4fx.acc.noneShown': 'Eksik vurgu renkleri: öneri yok.',
  'w4fx.acc.noneUnknown':
    'Eksik vurgu renkleri: öneri yok. Bu hesaplama eski bir sürümden – uygun malzemesi olmayan grupların atlanıp atlanmadığı kayıtlı değil; yeniden hesaplamak bunu tam olarak gösterir.',
  'w4fx.acc.skip.noMaterial':
    '{groups} grup ({stones} taş) {de} {thr} değerinden fazla sapıyor, ancak sunulan malzemelerin hiçbiri renk tonuna {de} {thr} değerinden daha yakın değil – öneri mümkün değil; bkz. “Eksik renkler”.',
  'w4fx.acc.skip.noMaterial.one':
    '1 grup ({stones} taş) {de} {thr} değerinden fazla sapıyor, ancak sunulan malzemelerin hiçbiri renk tonuna {de} {thr} değerinden daha yakın değil – öneri mümkün değil; bkz. “Eksik renkler”.',
  'w4fx.acc.skip.inPalette':
    '{groups} grup ({stones} taş) {de} {thr} değerinden fazla sapıyor; en uygun malzeme zaten palette – zorunlu renk yeni bir renk eklemez.',
  'w4fx.acc.skip.inPalette.one':
    '1 grup ({stones} taş) {de} {thr} değerinden fazla sapıyor; en uygun malzeme zaten palette – zorunlu renk yeni bir renk eklemez.',
  'w4fx.acc.skip.nearPalette':
    '{groups} grup ({stones} taş) aldığı renkten {de} {thr} değerinden fazla sapıyor, ancak ortalamada bir palet rengine en fazla {de} {half} uzaklıkta – bu tonda bir öneri yeni bir renk eklemez.',
  'w4fx.acc.skip.nearPalette.one':
    '1 grup ({stones} taş) aldığı renkten {de} {thr} değerinden fazla sapıyor, ancak ortalamada bir palet rengine en fazla {de} {half} uzaklıkta – bu tonda bir öneri yeni bir renk eklemez.',
  'w4fx.acc.skip.ungrouped': '{de} {thr} üzerindeki {stones} taş daha gruplara ayrılmadı (en fazla {max} grup incelenir).',
  'w4fx.acc.skip.ungrouped.one': '{de} {thr} üzerindeki 1 taş daha bir gruba ayrılmadı (en fazla {max} grup incelenir).',
  'w4fx.acc.idsLabel': 'Taşlar (görmek için dokunun):',
  'w4fx.acc.openStone': '{id} taşını 8. adımda (önizleme) aç',
  'w4fx.acc.openHint': 'Bir taş adına dokunmak taşı 8. adımda (önizleme) açar.',
  'w4fx.acc.previewIdsHint': 'Bu taşlar önizlemeye ait – “Önizlemeyi al” sonrasında 8. adımda açılabilir.',

  'w4fx.pdf.codesIncomplete':
    'Kod planında bile ({k} kata kadar büyütülmüş) taşlar bu ölçekte renk numarası için çok küçük – kod planı eksik kalır. Daha büyük bir ölçek veya daha küçük bölümler seçin; her konumun rengi CSV dışa aktarımında bulunur.',

  'w4fx.bg.paletteNote':
    'Otomatik renk seçiminde palet tüm taşlardan yeniden hesaplanır – bu nedenle alanların içindeki renk tonları da kayabilir, tek tek taşlar başka bir renk alabilir.',

  'w4fx.paintTooSmall': 'Taşlar boyamak için çok küçük – yakınlaştırmak için bir kez dokunun (veya iki parmakla yakınlaştırın); o zamana kadar sürüklemek yalnızca görüntüyü kaydırır.',
  'w4fx.toolHint.off':
    'Döşeme modunu açın, sonra dokunmak taşları döşendi olarak işaretler. Şu anda dokunmak taş ayrıntısını açar; parmakla çok küçük taşlara dokunmak yalnızca yakınlaştırır.',
  'w4fx.chips.hintView': 'Bir rengi vurgulamak için dokunun.',
  'w4fx.stats.updating': 'Sayılar güncelleniyor …',

  'w4fx.guard.leadLayout':
    'Yeniden hesaplama mevcut mozaiğin yerini alır ve şunları siler: {list}. Izgara değişiyor ({reasons}) – bu nedenle döşenmiş {n} taşın tümü yeniden açık olur; hiçbiri aktarılmaz.',
  'w4fx.guard.leadLayout.one':
    'Yeniden hesaplama mevcut mozaiğin yerini alır ve şunları siler: {list}. Izgara değişiyor ({reasons}) – bu nedenle döşenmiş taş yeniden açık olur; aktarılmaz.',
  'w4fx.pending.leadLayout':
    'Hesaplama tamamlandı. Hesaplama sürerken önceki mozaik üzerinde çalışıldı. Yeni sonucu almak şunları siler: {list}. Izgara değişti ({reasons}) – döşenmiş {n} taşın tümü yeniden açık olur.',
  'w4fx.pending.leadLayout.one':
    'Hesaplama tamamlandı. Hesaplama sürerken önceki mozaik üzerinde çalışıldı. Yeni sonucu almak şunları siler: {list}. Izgara değişti ({reasons}) – döşenmiş taş yeniden açık olur.',
  'w4fx.overwriteLayout':
    'Dikkat: yeniden hesaplama {list} siler. Önce sorulur; yedek kopya mümkündür. Izgara değişiyor ({reasons}) – döşenmiş {n} taşın tümü yeniden açık olur.',
  'w4fx.overwriteLayout.one':
    'Dikkat: yeniden hesaplama {list} siler. Önce sorulur; yedek kopya mümkündür. Izgara değişiyor ({reasons}) – döşenmiş taş yeniden açık olur.',
};
