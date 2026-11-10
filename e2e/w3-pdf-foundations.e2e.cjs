/* E2E – Welle 3 „PDF-Grundlagen“ im echten Browser (Chromium/Playwright).
 * Voraussetzung: `npm run build` und `npx vite preview` laufen; pdftotext/pdftoppm (poppler) installiert,
 * python3 mit pypdf optional (Lesezeichen → Seite).
 * Aufruf: node e2e/w3-pdf-foundations.e2e.cjs <baseUrl> <outDir>
 *
 * Geprüft am PDF, das die App (Worker, eingebettete DejaVu-Schrift) erzeugt:
 *  - Lesezeichen, Dokumenttitel, /PrintScaling /None; Abschnitts-Lesezeichen zeigen auf die Abschnittsseite
 *  - Koordinatenliste mit kleinem Limit: Titel „erste … von … – gekürzt“ und Hinweis „Koordinatenliste gekürzt“
 *  - Blatt-Fußzeile „Blatt A1-1 · Seite n / N“, Seitenzahl ≥ 6 mm vom unteren Rand
 *  - keine überlappenden Wörter auf Deckblatt, Übersicht, Legende, Materialliste, Abschnittsseiten, Blättern
 *    und Koordinaten (Schnittvorlagen ausgenommen – eigenes Paket)
 *  - „An Seite anpassen“: ein einziger Maßstab auf allen Blättern, Deckblatt nennt ihn
 *  - Türkisch: „Pafta A1-1 · Sayfa …“
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w3-pdf');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

const MM = 72 / 25.4;
function pdfPages(file) {
  const xml = execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
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
function overlapsOn(page) {
  const out = [];
  const ws = page.words;
  for (let i = 0; i < ws.length; i++)
    for (let j = i + 1; j < ws.length; j++) {
      const a = ws[i];
      const b = ws[j];
      if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.8 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1.2) out.push(`„${a.w}“ × „${b.w}“`);
    }
  return out;
}
const isTemplatePage = (p) => /(Vorlage|Template|Şablon) T\d+/.test(p.text);
function outlineViaPython(file) {
  try {
    const py = `
import sys, json
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
out = []
def walk(o, d):
    for x in o:
        if isinstance(x, list): walk(x, d + 1)
        else: out.append([d, x.title, r.get_destination_page_number(x) + 1])
walk(r.outline, 0)
print(json.dumps(out))`;
    return JSON.parse(execFileSync('python3', ['-c', py, file], { encoding: 'utf8' }));
  } catch {
    return null;
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
function render(file, pageNo, name) {
  try {
    execFileSync('pdftoppm', ['-r', '70', '-f', String(pageNo), '-l', String(pageNo), '-png', '-singlefile', file, path.join(OUT, name)]);
  } catch {
    /* nur Bild für die Sichtprüfung */
  }
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

  // ---------- PDF mit kleinem Koordinaten-Limit
  await page.click('[data-testid="step-pdf"]');
  await page.waitForSelector('[data-testid="pdf-btn"]');
  const limitInput = page.locator('.field:has(.field-label:text("Max. Steine in Koordinatenlisten")) input');
  // Welle 5 (w5-pdf-export-ui): das Feld gibt es nur noch bei der Liste „Je Stein“ (für die kompakte Liste gilt kein Limit)
  if (await limitInput.count()) {
    await limitInput.fill('150');
    await limitInput.press('Tab');
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'w3pdf-01-step.png') });
  const file1 = await generate(page, 'w3pdf-limit.pdf');
  const raw1 = fs.readFileSync(file1).toString('latin1');
  check('PDF hat Lesezeichen, Dokumenttitel und PrintScaling=None', raw1.includes('/Outlines') && raw1.includes('/PrintScaling /None') && raw1.includes('/DisplayDocTitle true') && /\/Title \(/.test(raw1));
  const pages1 = pdfPages(file1);
  const all1 = pages1.map((p) => p.text).join('\n');
  // Welle 5 (w5-pdf-content): Standard ist die kompakte, vollständige Koordinatenliste; das Limit gilt nur für die
  // Liste „je Stein“ (coordMode 'perStone', Auswahl in der Oberfläche ab Welle 6) – hier also keine Kürzung mehr.
  check('Koordinatenliste kompakt und vollständig (Limit gilt nur „je Stein“): Kontrollzeilen, kein Kürzungshinweis', /Kontrolle: [\d.]+ ganze Steine/.test(all1) && !/gekürzt/.test(all1), (all1.match(/Kontrolle: [^–]+/) || [''])[0]);
  const noticeIdx = pages1.findIndex((p) => /Kontrolle: [\d.]+ ganze Steine/.test(p.text));
  check('Kontrollzeile direkt unter der Liste (keine leere Hinweisseite)', noticeIdx >= 0 && /[A-Z]{1,2}\d{3}/.test(pages1[noticeIdx].text), noticeIdx >= 0 ? `Seite ${noticeIdx + 1} von ${pages1.length}` : 'fehlt');
  const sheetIdx = pages1.findIndex((p) => /Blatt A1-1 · Seite \d+ \/ \d+/.test(p.text));
  check('Blatt-Fußzeile „Blatt A1-1 · Seite n / N“', sheetIdx >= 0, sheetIdx >= 0 ? `Seite ${sheetIdx + 1}` : '');
  let minBottom = Infinity;
  for (const p of pages1) {
    const seite = p.words.filter((w) => w.w === 'Seite');
    for (const w of seite) minBottom = Math.min(minBottom, (p.h - w.y1) / MM);
  }
  check('Seitenzahl ≥ 6 mm über dem unteren Rand (druckbarer Bereich)', minBottom >= 6, `${minBottom.toFixed(1)} mm`);
  let ov = [];
  pages1.forEach((p, i) => {
    if (isTemplatePage(p)) return;
    for (const o of overlapsOn(p)) ov.push(`S.${i + 1}: ${o}`);
  });
  check('Keine überlappenden Wörter (Deckblatt, Übersicht, Legende, Material, Abschnitte, Blätter, Koordinaten)', ov.length === 0, ov.length ? ov.slice(0, 5).join('; ') : `${pages1.length} Seiten geprüft`);
  const outline = outlineViaPython(file1);
  if (outline) {
    const secs = outline.filter((o) => o[0] === 1 && /^Abschnitt [A-Z]+\d+$/.test(o[1]));
    const bad = secs.filter((o) => !pages1[o[2] - 1].text.includes(o[1]));
    const top = outline.filter((o) => o[0] === 0).map((o) => o[1]);
    check('Lesezeichen: Kapitel und Abschnitte zeigen auf die richtige Seite', secs.length > 0 && bad.length === 0 && top.includes('Verlegeblätter') && top.includes('Materialliste'), `${top.join(' · ')} | ${secs.length} Abschnittseinträge`);
  } else check('Lesezeichen (pypdf nicht verfügbar – nur Rohprüfung)', raw1.includes('/Outlines'));
  const ovIdx = pages1.findIndex((p) => p.text.includes('Gesamtübersicht') && p.text.includes('Seite Seite') === false && /Abschnitt X \/ Y/.test(p.text));
  const sec1 = outline ? outline.find((o) => o[1] === 'Abschnitt A1') : null;
  check('Gesamtübersicht hat eine Spalte „Seite“ mit der Abschnittsseite', ovIdx >= 0 && (!sec1 || pages1[ovIdx].words.some((w) => w.w === String(sec1[2]))), ovIdx >= 0 ? `Übersicht S.${ovIdx + 1}${sec1 ? `, A1 → S.${sec1[2]}` : ''}` : 'fehlt');
  const secCover = pages1.findIndex((p) => p.text.includes('Seiten in diesem PDF'));
  check('Abschnittsdeckblatt nennt seine Seiten', secCover >= 0, secCover >= 0 ? (pages1[secCover].text.match(/Seiten in diesem PDF \S+/) || [''])[0] : '');
  const matIdx = pages1.findIndex((p) => p.text.includes('Einkaufsliste je Material'));
  const legIdx = pages1.findIndex((p) => /^MosaicPlan .* Farblegende Farblegende/.test(p.text));
  render(file1, 1, 'w3pdf-02-cover');
  if (ovIdx >= 0) render(file1, ovIdx + 1, 'w3pdf-03-overview');
  if (legIdx >= 0) render(file1, legIdx + 1, 'w3pdf-04-legend');
  if (matIdx >= 0) render(file1, matIdx + 1, 'w3pdf-05-materials');
  if (secCover >= 0) render(file1, secCover + 1, 'w3pdf-06-section');
  if (sheetIdx >= 0) render(file1, sheetIdx + 1, 'w3pdf-07-sheet');
  if (noticeIdx >= 0) render(file1, noticeIdx + 1, 'w3pdf-08-coords-notice');

  // ---------- An Seite anpassen: ein Maßstab für alle Blätter
  await page.click('.field:has(.field-label:text("Maßstab der Verlegeblätter")) button:has-text("An Seite anpassen")');
  await page.waitForTimeout(300);
  const file2 = await generate(page, 'w3pdf-fit.pdf');
  const pages2 = pdfPages(file2);
  const scales = new Set();
  pages2.forEach((p) => {
    if (!/Blatt [A-Z]+\d+-\d+ \(/.test(p.text) || !p.text.includes('Kontrollstrecke')) return;
    for (const m of p.text.matchAll(/Maßstab (\d+(?:,\d+)?:\d+(?:,\d+)?)/g)) scales.add(m[1]);
  });
  const coverScale = (pages2[0].text.match(/Maßstab Verlegeblätter (\S+) \(an Seite angepasst – ein Maßstab für alle Abschnitte\)/) || [])[1];
  check('An Seite anpassen: ein einziger Normmaßstab auf allen Blättern, Deckblatt nennt ihn', scales.size === 1 && coverScale === [...scales][0], `${[...scales].join(', ')} | Deckblatt ${coverScale}`);
  const fitSheet = pages2.findIndex((p) => /Blatt A1-1 \(/.test(p.text));
  if (fitSheet >= 0) render(file2, fitSheet + 1, 'w3pdf-09-fit-sheet');

  // ---------- Türkisch: „Pafta“ statt zweimal „Sayfa“
  await page.selectOption('select.lang', 'tr');
  await page.waitForTimeout(400);
  const file3 = await generate(page, 'w3pdf-tr.pdf');
  const pages3 = pdfPages(file3);
  const all3 = pages3.map((p) => p.text).join('\n');
  check('Türkisch: Blatt-Fußzeile „Pafta A1-1 · Sayfa n / N“, Koordinaten-Kontrolle „Kontrol“', /Pafta A1-1 · Sayfa \d+ \/ \d+/.test(all3) && /Kontrol: /.test(all3));
  let ov3 = 0;
  pages3.forEach((p) => {
    if (!isTemplatePage(p)) ov3 += overlapsOn(p).length;
  });
  check('Türkisch: keine überlappenden Wörter', ov3 === 0, `${pages3.length} Seiten`);
  const matTr = pages3.findIndex((p) => p.text.includes('Malzeme başına alışveriş listesi'));
  if (matTr >= 0) render(file3, matTr + 1, 'w3pdf-10-tr-materials');
  await page.selectOption('select.lang', 'de');
  await page.screenshot({ path: path.join(OUT, 'w3pdf-11-done.png') });

  check('keine Seitenfehler', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
