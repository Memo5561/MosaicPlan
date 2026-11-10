/**
 * Zusammenführung Welle 5: Prüfzähler der Statistik (w5-stats-engine) in der Ansicht „Material & Einkauf“
 * (w5-material-shopping). Die Zahlen kommen unverändert aus computeAllStats (thinPieces, thinFreePieces, overlapCells).
 */
export const de: Record<string, string> = {
  'w5int.thin':
    '{n} zugeschnittene Teile sind schmaler als die Mindestbreite eines Schnittteils ({min} mm) – schwer schneidbar. Im Steindetail sind sie markiert; neu berechnen oder die Form dieser Steine ändern.',
  'w5int.thin.one':
    '1 zugeschnittenes Teil ist schmaler als die Mindestbreite eines Schnittteils ({min} mm) – schwer schneidbar. Im Steindetail ist es markiert; neu berechnen oder die Form dieses Steins ändern.',
  'w5int.thinFree':
    '{n} Freiformteile sind schmaler als die Mindestbreite ({min} mm). Freiform ist von Hand gezeichnet und bleibt unverändert; bei eingebuchteten (nicht konvexen) Teilen ist diese Prüfung nur ein Richtwert.',
  'w5int.thinFree.one':
    '1 Freiformteil ist schmaler als die Mindestbreite ({min} mm). Freiform ist von Hand gezeichnet und bleibt unverändert; bei eingebuchteten (nicht konvexen) Teilen ist diese Prüfung nur ein Richtwert.',
  'w5int.overlap':
    'Bei {n} Steinen sind die Teile zusammen größer als ihre Rasterzelle (Freiformteile überlappen oder ragen über die Zelle hinaus). Steinfläche, Fugenfläche und Fugenmasse sind dadurch nicht exakt – Freiform im Steindetail korrigieren.',
  'w5int.overlap.one':
    'Bei 1 Stein sind die Teile zusammen größer als ihre Rasterzelle (Freiformteile überlappen oder ragen über die Zelle hinaus). Steinfläche, Fugenfläche und Fugenmasse sind dadurch nicht exakt – Freiform im Steindetail korrigieren.',
};

export const en: Record<string, string> = {
  'w5int.thin':
    '{n} cut pieces are narrower than the minimum width of a cut piece ({min} mm) – hard to cut. They are marked in the tile details; recompute or change the shape of these tiles.',
  'w5int.thin.one':
    '1 cut piece is narrower than the minimum width of a cut piece ({min} mm) – hard to cut. It is marked in the tile details; recompute or change the shape of this tile.',
  'w5int.thinFree':
    '{n} freeform pieces are narrower than the minimum width ({min} mm). Freeform is drawn by hand and is left unchanged; for indented (non-convex) pieces this check is only a guide value.',
  'w5int.thinFree.one':
    '1 freeform piece is narrower than the minimum width ({min} mm). Freeform is drawn by hand and is left unchanged; for indented (non-convex) pieces this check is only a guide value.',
  'w5int.overlap':
    'In {n} tiles the pieces together are larger than their grid cell (freeform pieces overlap or reach beyond the cell). Tile area, joint area and grout quantity are therefore not exact – correct the freeform in the tile details.',
  'w5int.overlap.one':
    'In 1 tile the pieces together are larger than their grid cell (freeform pieces overlap or reach beyond the cell). Tile area, joint area and grout quantity are therefore not exact – correct the freeform in the tile details.',
};

export const tr: Record<string, string> = {
  'w5int.thin':
    '{n} kesim parçası, kesim parçası için en küçük genişlikten ({min} mm) daha dar – kesmesi zor. Taş ayrıntısında işaretlidirler; yeniden hesaplayın veya bu taşların biçimini değiştirin.',
  'w5int.thin.one':
    '1 kesim parçası, kesim parçası için en küçük genişlikten ({min} mm) daha dar – kesmesi zor. Taş ayrıntısında işaretlidir; yeniden hesaplayın veya bu taşın biçimini değiştirin.',
  'w5int.thinFree':
    '{n} serbest biçimli parça en küçük genişlikten ({min} mm) daha dar. Serbest biçim elle çizilir ve değiştirilmez; girintili (dışbükey olmayan) parçalarda bu denetim yalnızca yaklaşık bir değerdir.',
  'w5int.thinFree.one':
    '1 serbest biçimli parça en küçük genişlikten ({min} mm) daha dar. Serbest biçim elle çizilir ve değiştirilmez; girintili (dışbükey olmayan) parçalarda bu denetim yalnızca yaklaşık bir değerdir.',
  'w5int.overlap':
    '{n} taşta parçalar birlikte ızgara hücresinden büyük (serbest biçimli parçalar üst üste biniyor veya hücrenin dışına taşıyor). Taş alanı, derz alanı ve derz dolgusu miktarı bu yüzden kesin değil – serbest biçimi taş ayrıntısında düzeltin.',
  'w5int.overlap.one':
    '1 taşta parçalar birlikte ızgara hücresinden büyük (serbest biçimli parçalar üst üste biniyor veya hücrenin dışına taşıyor). Taş alanı, derz alanı ve derz dolgusu miktarı bu yüzden kesin değil – serbest biçimi taş ayrıntısında düzeltin.',
};
