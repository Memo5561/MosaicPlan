/**
 * Texte für w1-touch-input-safety: Antipp-Zoom im Viewer, Hinweis „verstanden als“ bei Zahleneingaben.
 * Überschreibt außerdem preview.hint und plan.layModeHint, weil sich das Antippen mit dem Finger geändert hat
 * (zu kleine Steine: erstes Tippen zoomt nur hinein; langes Drücken zählt nicht).
 */
export const de: Record<string, string> = {
  'viewer.tapZoomHint': 'Zum Antippen hineingezoomt – jetzt den Stein antippen',
  'num.readAs': 'Verstanden als {v}',
  'preview.hint': 'Ziehen zum Verschieben, Mausrad/2 Finger zum Zoomen, Stein antippen für Details. Sind die Steine zum Antippen zu klein, zoomt das erste Tippen nur hinein.',
  'plan.layModeHint': 'Antippen markiert Steine als verlegt (statt Details zu öffnen). Mit dem Finger zoomt ein Tippen auf zu kleine Steine nur hinein; langes Drücken zählt nicht.',
};

export const en: Record<string, string> = {
  'viewer.tapZoomHint': 'Zoomed in so you can tap a single stone – tap it now',
  'num.readAs': 'Read as {v}',
  'preview.hint': 'Drag to pan, mouse wheel/two fingers to zoom, tap a tile for details. If the tiles are too small to tap, the first tap only zooms in.',
  'plan.layModeHint': 'Tapping marks tiles as laid (instead of opening details). With a finger, a tap on tiles that are too small only zooms in; long presses do not count.',
};

export const tr: Record<string, string> = {
  'viewer.tapZoomHint': 'Tek bir taşa dokunabilmeniz için yakınlaştırıldı – şimdi taşa dokunun',
  'num.readAs': '{v} olarak algılandı',
  'preview.hint': 'Kaydırmak için sürükleyin, yakınlaştırmak için fare tekerleği/iki parmak, ayrıntı için taşa dokunun. Taşlar dokunmak için çok küçükse ilk dokunuş yalnızca yakınlaştırır.',
  'plan.layModeHint': 'Dokunmak taşları döşendi olarak işaretler (ayrıntı açmak yerine). Parmakla çok küçük taşlara dokunmak yalnızca yakınlaştırır; uzun basmak sayılmaz.',
};
