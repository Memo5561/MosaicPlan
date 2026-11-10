/* E2E – Welle 5 „PDF-Inhalt“ im echten Browser (Chromium/Playwright), am PDF, das die App erzeugt (Worker, eingebettete
 * DejaVu-Schrift). Voraussetzung: `npm run build` und `npx vite preview` laufen; pdftotext/pdftoppm (poppler) installiert.
 * Aufruf: node e2e/w5-pdf-content.e2e.cjs <baseUrl> <outDir>
 *
 * Geprüft (Porträt-Beispiel, Standardoptionen):
 *  - jedes Verlegeblatt hat seine Farblegende („Steine auf diesem Blatt: N, davon K zugeschnitten“, Felder „07 ×123“
 *    mit Summe N) – auf dem Blatt oder auf der direkt folgenden Seite „Legende zu Blatt …“
 *  - Schnittvorlagen: Maßzahlen überdecken keinen Text (keine überlappenden Wörter auf Vorlagenseiten und im ganzen PDF)
 *  - Koordinaten kompakt und vollständig: je Abschnitt Kontrollzeile, kein Kürzungshinweis, wenige Seiten
 *  - Abschnittsdeckblatt mit Lagekarte; Gesamtübersicht vorhanden
 *  - Oberfläche: Hinweis zur kompakten Koordinatenliste; Türkisch: Legende und Koordinaten übersetzt, ohne Überlappungen
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w5-pdf-content');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

const MM = 72 / 25.4;
function pdfPages(file) {
  const xml = execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return xml
    .split('<page ')
    .slice(1)
    .map((p) => {
      const [, w, h] = p.match(/width="([\d.]+)" height="([\d.]+)"/);
      const words = [...p.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/g)].map((m) => ({
        x0: +m[1],
        y0: +m[2],
        x1: +m[3],
        y1: +m[4],
        w: m[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
      }));
      return { w: +w, h: +h, words, text: words.map((x) => x.w).join(' ') };
    });
}
/** überlappende Wörter (gedrehte Wörter – senkrecht schmal – ausgenommen) */
function overlapsOn(page) {
  const out = [];
  const ws = page.words.filter((w) => !(w.x1 - w.x0 < (w.y1 - w.y0) * 0.6 && w.w.length > 2));
  for (let i = 0; i < ws.length; i++)
    for (let j = i + 1; j < ws.length; j++) {
      const a = ws[i];
      const b = ws[j];
      if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.8 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1.2) out.push(`„${a.w}“ × „${b.w}“`);
    }
  return out;
}
const header = (p) => p.words.filter((w) => w.y1 < 10 * MM).map((w) => w.w).join(' ');
const isSheet = (p) => / – (Blatt|Sheet|Pafta) [A-Z]+\d+-\d+ \(\d+\/\d+\)/.test(p.text) && /Kontrollstrecke|Calibration|Kontrol/.test(p.text);
const isTemplatePage = (p) => /(Vorlage|Template|Şablon) T\d+/.test(p.text);
const num = (s) => Number(String(s).replace(/[.,]/g, ''));
function render(file, pageNo, name) {
  try {
    execFileSync('pdftoppm', ['-r', '80', '-f', String(pageNo), '-l', String(pageNo), '-png', '-singlefile', file, path.join(OUT, name)]);
  } catch {
    /* nur Bild für die Sichtprüfung */
  }
}

async function generate(page, name) {
  await page.waitForSelector('[data-testid="pdf-btn"]');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), page.click('[data-testid="pdf-btn"]')]);
  const file = path.join(OUT, name);
  await download.saveAs(file);
  await page.waitForSelector('[data-testid="pdf-done"]', { timeout: 60000 });
  return file;
}

/** Farblegende eines Blatts (Seite i oder i+1) prüfen: Summe der Felder = N der Kopfzeile */
function sheetLegend(pages, i, headRe, legendRe) {
  let src = pages[i];
  let where = 'Blatt';
  if (!headRe.test(src.text)) {
    src = pages[i + 1];
    where = 'Folgeseite';
    if (!src || !legendRe.test(src.text) || !headRe.test(src.text)) return { ok: false, where: 'fehlt' };
  }
  const n = num(headRe.exec(src.text)[1]);
  let sum = 0;
  let chips = 0;
  for (let k = 0; k + 1 < src.words.length; k++) {
    const a = src.words[k];
    const b = src.words[k + 1];
    if (/^\d{2}$/.test(a.w) && /^×[\d.,]+$/.test(b.w) && Math.abs(a.y0 - b.y0) < 1) {
      sum += num(b.w.slice(1));
      chips++;
    }
  }
  return { ok: sum === n && chips > 0, n, sum, chips, where };
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE);
  await page.waitForSelector('[data-testid="sample-portrait"]');
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
  await page.waitForTimeout(800);

  // ---------- Oberfläche: Hinweis zur kompakten Koordinatenliste
  await page.click('[data-testid="step-pdf"]');
  await page.waitForSelector('[data-testid="pdf-btn"]');
  const body = await page.locator('body').innerText();
  check('Oberfläche: Hinweis „kompakte, vollständige Liste“ bei den Koordinaten', /kompakte, vollständige Liste/.test(body));
  await page.screenshot({ path: path.join(OUT, 'w5pc-01-step.png') });

  // ---------- PDF mit Standardoptionen (Koordinaten kompakt, Vorlagen an)
  const file = await generate(page, 'w5pc-default.pdf');
  const pages = pdfPages(file);
  check('PDF erzeugt', pages.length > 5, `${pages.length} Seiten`);
  const sheetIdx = pages.map((p, i) => (isSheet(p) ? i : -1)).filter((i) => i >= 0);
  const legends = sheetIdx.map((i) => ({ i, ...sheetLegend(pages, i, /Steine auf diesem Blatt: ([\d.]+)/, /Legende zu Blatt/) }));
  const badLegend = legends.filter((l) => !l.ok);
  check(
    'Jedes Verlegeblatt hat seine Farblegende; Summe der Felder = Steine des Blatts',
    sheetIdx.length > 0 && badLegend.length === 0,
    badLegend.length ? badLegend.map((l) => `S.${l.i + 1}: ${l.where} ${l.sum}/${l.n}`).join('; ') : `${sheetIdx.length} Blätter (${legends.filter((l) => l.where !== 'Blatt').length} mit Legendenseite)`,
  );
  const legendPages = pages.map((p, i) => (/Legende zu Blatt/.test(p.text) ? i : -1)).filter((i) => i >= 0);
  check('Legendenseiten ohne Kontrollstrecke', legendPages.every((i) => !pages[i].text.includes('Kontrollstrecke')), `${legendPages.length} Legendenseiten`);
  const tplPages = pages.map((p, i) => (isTemplatePage(p) ? i : -1)).filter((i) => i >= 0);
  const tplOv = tplPages.flatMap((i) => overlapsOn(pages[i]).map((o) => `S.${i + 1}: ${o}`));
  check('Schnittvorlagen: keine überlappenden Wörter (Maßzahlen frei von Titel und Text)', tplPages.length > 0 && tplOv.length === 0, tplOv.slice(0, 4).join('; ') || `${tplPages.length} Vorlagenseiten`);
  const allOv = pages.flatMap((p, i) => overlapsOn(p).map((o) => `S.${i + 1}: ${o}`));
  check('Ganzes PDF: keine überlappenden Wörter', allOv.length === 0, allOv.slice(0, 4).join('; ') || `${pages.length} Seiten`);
  const coordPages = pages.map((p, i) => (/Koordinaten/.test(header(p)) ? i : -1)).filter((i) => i >= 0);
  const coordText = coordPages.map((i) => pages[i].text).join(' ');
  const controls = [...coordText.matchAll(/Kontrolle: ([\d.]+) ganze Steine \+ ([\d.]+) Sonderteile? = ([\d.]+) Steine/g)];
  const okSums = controls.every((m) => num(m[1]) + num(m[2]) === num(m[3]));
  const sections = [...new Set([...pages.map((p) => p.text).join(' ').matchAll(/Koordinaten – Abschnitt ([A-Z]+\d+)/g)].map((m) => m[1]))];
  check(
    'Koordinaten kompakt und vollständig: Kontrollzeile je Abschnitt, kein Kürzungshinweis',
    coordPages.length > 0 && controls.length === sections.length && okSums && !/gekürzt/.test(coordText),
    `${coordPages.length} Seiten, ${controls.length} Abschnitte`,
  );
  check('Koordinaten: Spalten-/Zeilentabelle, Farbfolge und Sonderteile', /Spalten – Nummer/.test(coordText) && /Farbfolge je Zeile/.test(coordText) && /Sonderteil/.test(coordText));
  const coverIdx = pages.findIndex((p) => /Seiten in diesem PDF/.test(p.text));
  check('Abschnittsdeckblatt mit Lagekarte und Farbnr.-Spalte', coverIdx >= 0 && /Lage im Mosaik/.test(pages[coverIdx].text) && /Farbnr\./.test(pages[coverIdx].text));
  const ovIdx = pages.findIndex((p) => /Gesamtübersicht/.test(header(p)));
  check('Gesamtübersicht vorhanden', ovIdx >= 0);
  if (sheetIdx.length) render(file, sheetIdx[0] + 1, 'w5pc-02-sheet');
  if (legendPages.length) render(file, legendPages[0] + 1, 'w5pc-03-legend-page');
  if (tplPages.length) render(file, tplPages[0] + 1, 'w5pc-04-templates');
  if (coordPages.length) render(file, coordPages[0] + 1, 'w5pc-05-coords');
  if (coordPages.length > 1) render(file, coordPages[1] + 1, 'w5pc-06-coords-2');
  if (coverIdx >= 0) render(file, coverIdx + 1, 'w5pc-07-section-cover');
  if (ovIdx >= 0) render(file, ovIdx + 1, 'w5pc-08-overview');

  // ---------- Türkisch
  await page.selectOption('select.lang', 'tr');
  await page.waitForTimeout(400);
  const fileTr = await generate(page, 'w5pc-tr.pdf');
  const pagesTr = pdfPages(fileTr);
  const allTr = pagesTr.map((p) => p.text).join(' ');
  const ovTr = pagesTr.flatMap((p, i) => overlapsOn(p).map((o) => `S.${i + 1}: ${o}`));
  check('Türkisch: Blattlegende „Bu paftadaki taşlar“, Koordinaten „Kontrol“, keine Überlappungen', /Bu paftadaki taşlar/.test(allTr) && /Kontrol: /.test(allTr) && ovTr.length === 0, ovTr.slice(0, 3).join('; ') || `${pagesTr.length} Seiten`);
  const tplTr = pagesTr.findIndex((p) => isTemplatePage(p));
  if (tplTr >= 0) render(fileTr, tplTr + 1, 'w5pc-09-tr-templates');
  await page.selectOption('select.lang', 'de');

  check('keine Seitenfehler', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
