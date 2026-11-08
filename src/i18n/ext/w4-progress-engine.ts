/**
 * Texte des Pakets w4-progress-engine: Verlegefortschritt in „Meine Projekte“ und auf der Startseite, Hinweis zur
 * Übernahme des Fortschritts beim Neuberechnen. Dazu angepasste Rückfragen vor dem Neuberechnen (w2ws.guard.lead,
 * w2ws.overwriteCounts, w2ws.pending.lead): Bei gleichem Raster bleiben nachweislich gleiche Steine verlegt.
 */
export const de: Record<string, string> = {
  'w4pe.laid': '{pct} % verlegt',
  'w4pe.laidLess': 'unter 1 % verlegt',
  'w4pe.laidTitle': '{placed} von {total} Steinen als verlegt markiert',
  'w4pe.carry.lead': 'Neu berechnet mit gleichem Raster:',
  'w4pe.carry.kept': '{n} verlegte Steine übernommen',
  'w4pe.carry.kept.one': '{n} verlegter Stein übernommen',
  'w4pe.carry.allSame': '– alle unverändert.',
  'w4pe.carry.changed': '{n} haben sich geändert (Form, Farbe oder Material) und sind wieder offen.',
  'w4pe.carry.changed.one': '{n} hat sich geändert (Form, Farbe oder Material) und ist wieder offen.',
  'w4pe.carry.layout': 'Raster geändert – Fortschritt nicht übertragbar: {n} als verlegt markierte Steine sind wieder offen.',
  'w4pe.carry.layout.one': 'Raster geändert – Fortschritt nicht übertragbar: {n} als verlegt markierter Stein ist wieder offen.',
  'w4pe.carry.layoutHint':
    'Ein anderes Raster (Größe, Steinmaß, Fuge, Randmodus, Mindestschnitt) hat andere Positionen. Den alten Stand enthält die Sicherungskopie, falls vor dem Neuberechnen eine angelegt wurde.',
  'w4pe.carry.how':
    'Übernommen wird nur, was nachweislich derselbe Stein ist: gleiches Raster, gleiche Zellform und Schnittgeometrie und je Stein gleiche Farbe (HEX) und gleiches Material. Alles andere ist wieder offen.',
  'w4pe.carry.show': 'anzeigen',
  'w4pe.carry.hide': 'ausblenden',
  'w4pe.carry.where': 'Positionen mit wieder offenen Steinen (öffnet das Steindetail):',
  'w4pe.carry.openStone': 'Stein {id} in der Vorschau öffnen',
  'w4pe.carry.more': '+{n} weitere',
  'w4pe.carry.dismiss': 'Hinweis schließen',
  'w2ws.guard.lead':
    'Neu berechnen ersetzt das aktuelle Mosaik und verwirft dabei: {list}. Ausnahme bei „verlegt“: Bleibt das Raster gleich, bleiben Steine markiert, die genau gleich neu berechnet werden (gleiche Form, Farbe und gleiches Material) – wie viele, zeigt ein Hinweis nach der Berechnung.',
  'w2ws.overwriteCounts':
    'Achtung: Neu berechnen verwirft {list}. Vorher wird nachgefragt; eine Sicherungskopie ist möglich. Bei gleichem Raster bleiben nur Steine verlegt, die genau gleich neu berechnet werden.',
  'w2ws.pending.lead':
    'Die Berechnung ist fertig. Während sie lief, wurde am bisherigen Mosaik weitergearbeitet. Das neue Ergebnis zu übernehmen verwirft: {list}. Ausnahme bei „verlegt“: Bei gleichem Raster bleiben Steine markiert, die genau gleich berechnet wurden (gleiche Form, Farbe und gleiches Material).',
};

export const en: Record<string, string> = {
  'w4pe.laid': '{pct} % laid',
  'w4pe.laidLess': 'under 1 % laid',
  'w4pe.laidTitle': '{placed} of {total} stones marked as laid',
  'w4pe.carry.lead': 'Recomputed with the same grid:',
  'w4pe.carry.kept': '{n} laid stones kept',
  'w4pe.carry.kept.one': '{n} laid stone kept',
  'w4pe.carry.allSame': '– all unchanged.',
  'w4pe.carry.changed': '{n} have changed (shape, colour or material) and are open again.',
  'w4pe.carry.changed.one': '{n} has changed (shape, colour or material) and is open again.',
  'w4pe.carry.layout': 'Grid changed – progress cannot be transferred: {n} stones marked as laid are open again.',
  'w4pe.carry.layout.one': 'Grid changed – progress cannot be transferred: {n} stone marked as laid is open again.',
  'w4pe.carry.layoutHint':
    'A different grid (size, tile size, joint, edge mode, minimum cut) has different positions. The old state is in the backup copy, if one was created before recomputing.',
  'w4pe.carry.how':
    'Only stones that are provably the same are kept: same grid, same cell shape and cut geometry, and for each stone the same colour (HEX) and the same material. Everything else is open again.',
  'w4pe.carry.show': 'show',
  'w4pe.carry.hide': 'hide',
  'w4pe.carry.where': 'Positions with stones open again (opens the stone details):',
  'w4pe.carry.openStone': 'Open stone {id} in the preview',
  'w4pe.carry.more': '+{n} more',
  'w4pe.carry.dismiss': 'Close notice',
  'w2ws.guard.lead':
    'Recomputing replaces the current mosaic and discards: {list}. Exception for “laid”: if the grid stays the same, stones that are recomputed exactly the same (same shape, colour and material) stay marked – a notice after the computation shows how many.',
  'w2ws.overwriteCounts':
    'Note: recomputing discards {list}. You will be asked first; a backup copy is possible. With the same grid, only stones that are recomputed exactly the same stay laid.',
  'w2ws.pending.lead':
    'The computation has finished. While it was running, work continued on the previous mosaic. Applying the new result discards: {list}. Exception for “laid”: with the same grid, stones computed exactly the same (same shape, colour and material) stay marked.',
};

export const tr: Record<string, string> = {
  'w4pe.laid': '%{pct} döşendi',
  'w4pe.laidLess': '%1’in altında döşendi',
  'w4pe.laidTitle': '{total} taştan {placed} tanesi döşendi olarak işaretli',
  'w4pe.carry.lead': 'Aynı ızgarayla yeniden hesaplandı:',
  'w4pe.carry.kept': '{n} döşenmiş taş aktarıldı',
  'w4pe.carry.kept.one': '{n} döşenmiş taş aktarıldı',
  'w4pe.carry.allSame': '– hepsi değişmedi.',
  'w4pe.carry.changed': '{n} taş değişti (biçim, renk veya malzeme) ve yeniden açık.',
  'w4pe.carry.changed.one': '{n} taş değişti (biçim, renk veya malzeme) ve yeniden açık.',
  'w4pe.carry.layout': 'Izgara değişti – ilerleme aktarılamaz: döşendi olarak işaretli {n} taş yeniden açık.',
  'w4pe.carry.layout.one': 'Izgara değişti – ilerleme aktarılamaz: döşendi olarak işaretli {n} taş yeniden açık.',
  'w4pe.carry.layoutHint':
    'Farklı bir ızgaranın (boyut, taş ölçüsü, derz, kenar modu, en küçük kesim) konumları farklıdır. Yeniden hesaplamadan önce yedek kopya oluşturulduysa eski durum onda bulunur.',
  'w4pe.carry.how':
    'Yalnızca kanıtlanabilir şekilde aynı olan taşlar aktarılır: aynı ızgara, aynı hücre biçimi ve kesim geometrisi ve her taş için aynı renk (HEX) ve aynı malzeme. Diğer her şey yeniden açıktır.',
  'w4pe.carry.show': 'göster',
  'w4pe.carry.hide': 'gizle',
  'w4pe.carry.where': 'Yeniden açık taşların konumları (taş ayrıntısını açar):',
  'w4pe.carry.openStone': '{id} taşını önizlemede aç',
  'w4pe.carry.more': '+{n} tane daha',
  'w4pe.carry.dismiss': 'Bildirimi kapat',
  'w2ws.guard.lead':
    'Yeniden hesaplama mevcut mozaiğin yerini alır ve şunları siler: {list}. “Döşendi” için istisna: ızgara aynı kalırsa, tamamen aynı hesaplanan taşlar (aynı biçim, renk ve malzeme) işaretli kalır – kaç tane olduğunu hesaplamadan sonra bir bildirim gösterir.',
  'w2ws.overwriteCounts':
    'Dikkat: Yeniden hesaplama şunları siler: {list}. Önce sorulur; yedek kopya oluşturulabilir. Izgara aynıysa yalnızca tamamen aynı hesaplanan taşlar döşenmiş kalır.',
  'w2ws.pending.lead':
    'Hesaplama tamamlandı. Hesaplama sürerken önceki mozaik üzerinde çalışıldı. Yeni sonucu uygulamak şunları siler: {list}. “Döşendi” için istisna: ızgara aynıysa, tamamen aynı hesaplanan taşlar (aynı biçim, renk ve malzeme) işaretli kalır.',
};
