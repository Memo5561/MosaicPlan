/* E2E – Paket w6-pdf-finish im echten Browser (Chromium/Playwright).
 * Voraussetzung: `npm run build` und `npx vite preview` laufen; pdfinfo/pdftotext (poppler) installiert.
 * Aufruf: node e2e/w6-pdf-finish.e2e.cjs <baseUrl> <outDir>
 *
 * Geprüft:
 *  - Koordinatenart: „Kompakt“ und „Je Stein“ nennen vorab ihre Seiten (ca.); die Auswahl ändert die Gesamtzahl genau
 *    um den Unterschied; ausgeschaltet nennt der Schalter die Seiten beider Arten
 *  - nach dem Erzeugen: „PDF erstellt (… MB): N Seiten (wie vorab geschätzt)“ mit Aufteilung je Teil; N = Seiten der
 *    heruntergeladenen Datei (pdfinfo) = Schätzung vorab; Summe der Aufteilung = N (kompakt und je Stein)
 *  - Export in Teilen: „Teil k/n (Abschnitte …)“ in JEDER Kopfzeile des Teil-PDFs, Seitenzahl = Messung
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w6-pdf-finish');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pdfPageCount = (file) => Number((execFileSync('pdfinfo', [file], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/) || [])[1]);
const pdfPageTexts = (file) => execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }).split('\f').filter((t, i, a) => i < a.length - 1 || t.trim());
const num = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'));

async function openSample(page, key) {
  await page.goto(BASE);
  await page.waitForSelector(`[data-testid="sample-${key}"]`);
  await page.click(`[data-testid="sample-${key}"]`);
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 240000 });
  await wait(800);
}
async function planReady(page) {
  await page.waitForSelector('[data-testid="pdf-plan"][data-state="ready"]', { timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="pdf-plan"]')?.dataset.total, null, { timeout: 120000 });
  return Number(await page.getAttribute('[data-testid="pdf-plan"]', 'data-total'));
}
/** wartet, bis die Messung zu den aktuellen Optionen fertig ist (Gesamtzahl stabil) */
async function settledTotal(page) {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    const v = await planReady(page);
    if (v === last) return v;
    last = v;
  }
  return last;
}
const coordsPages = (page) => page.getAttribute('[data-testid="pdf-contents"] li[data-part="coords"]', 'data-pages').then(Number);
async function setToggle(page, label, on) {
  const lab = page.locator(`label.toggle:has-text("${label}")`).first();
  const box = lab.locator('input[type="checkbox"]');
  if ((await box.isChecked()) !== on) await lab.click();
  await wait(150);
}
async function generateSingle(page, name) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), page.click('[data-testid="pdf-btn"]')]);
  const file = path.join(OUT, name);
  await dl.saveAs(file);
  await page.waitForSelector('[data-testid="pdf-done"][data-pages]:not([data-pages=""])', { timeout: 60000 });
  return file;
}
async function doneInfo(page, sel = '[data-testid="pdf-done"]') {
  return page.$eval(sel, (el) => ({
    text: el.querySelector('p')?.textContent?.trim() ?? '',
    bd: el.querySelector('[data-testid="pdf-done-breakdown"]')?.textContent?.trim() ?? '',
    pages: Number(el.dataset.pages),
    estimate: el.dataset.estimate === '' ? null : Number(el.dataset.estimate),
    matches: el.dataset.planMatches,
  }));
}
const bdSum = (bd) => [...bd.matchAll(/: ([\d.]+)/g)].reduce((a, m) => a + Number(m[1].replace(/\./g, '')), 0);

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await openSample(page, 'portrait');
  await page.click('[data-testid="step-pdf"]');
  await page.waitForSelector('[data-testid="pdf-step"]');
  const total0 = await settledTotal(page);

  // ================================================================ 1. Koordinatenart mit Seiten je Art
  await page.waitForSelector('[data-testid="pdf-coord-pages-compact"]', { timeout: 60000 });
  const modes = await page.$eval('[data-testid="pdf-coord-modes"]', (el) => ({ compact: Number(el.dataset.compact), perStone: Number(el.dataset.perStone), text: el.textContent }));
  const cp0 = await coordsPages(page);
  await page.locator('[data-testid="pdf-coord-modes"]').screenshot({ path: path.join(OUT, 'w6pf-01-coordmodes.png') });
  check(
    'Koordinatenart: „Kompakt (vollständig) · ca. N S.“ und „Je Stein … · ca. M S.“ vorab sichtbar; kompakt = Eintrag im Inhalt',
    modes.compact > 0 && modes.perStone > modes.compact && modes.compact === cp0 && /Kompakt \(vollständig\)\s*· ca\. \d+ S\./.test(modes.text) && /Je Stein[^·]*· ca\. [\d.]+ S\./.test(modes.text),
    `${modes.text.replace(/\s+/g, ' ')}`,
  );
  await page.click('[data-testid="pdf-coordmode"] button:has-text("Je Stein")');
  const total1 = await settledTotal(page);
  const cp1 = await coordsPages(page);
  check('„Je Stein“ gewählt: Gesamtzahl ändert sich genau um den Unterschied der beiden Arten', total1 === total0 - modes.compact + modes.perStone && cp1 === modes.perStone, `${total0} → ${total1} (kompakt ${modes.compact}, je Stein ${modes.perStone})`);
  // je Stein erzeugen: echte Seitenzahl = Schätzung
  const fileP = await generateSingle(page, 'w6pf-perstone.pdf');
  const dP = await doneInfo(page);
  const pagesP = pdfPageCount(fileP);
  check('Je Stein erzeugt: „PDF erstellt (…): N Seiten (wie vorab geschätzt)“, N = Datei = Schätzung, Aufteilung summiert sich zu N', dP.pages === pagesP && pagesP === total1 && dP.estimate === total1 && /wie vorab geschätzt/.test(dP.text) && bdSum(dP.bd) === pagesP && /Koordinaten: /.test(dP.bd), `${dP.text} | ${dP.bd} | pdfinfo ${pagesP}`);
  await page.click('[data-testid="pdf-coordmode"] button:has-text("Kompakt")');
  const total2 = await settledTotal(page);
  check('Zurück auf „Kompakt“: wieder die erste Gesamtzahl', total2 === total0, `${total2}`);

  await setToggle(page, 'Koordinatenlisten', false);
  const totalOff = await settledTotal(page);
  await wait(300);
  const hint = await page.locator('label.toggle:has-text("Koordinatenlisten")').first().textContent();
  check('Koordinaten aus: Gesamtzahl ohne Koordinatenseiten, der Schalter nennt die Seiten beider Arten', totalOff === total0 - modes.compact && /Eingeschaltet: kompakt ca\. \d+ S\., je Stein ca\. [\d.]+ S\./.test(hint), `${totalOff}; ${hint.replace(/\s+/g, ' ')}`);
  await setToggle(page, 'Koordinatenlisten', true);
  await settledTotal(page);

  // ================================================================ 2. Standard-PDF: echte Seitenzahl nach dem Erzeugen
  const file1 = await generateSingle(page, 'w6pf-standard.pdf');
  const d1 = await doneInfo(page);
  const pages1 = pdfPageCount(file1);
  await page.locator('[data-testid="pdf-done"]').screenshot({ path: path.join(OUT, 'w6pf-02-done.png') });
  check('Standard: „PDF erstellt (… MB): N Seiten (wie vorab geschätzt)“; N = pdfinfo = Schätzung vorab', d1.pages === pages1 && pages1 === total0 && d1.estimate === total0 && /^✓ PDF erstellt \([\d.,]+ (KB|MB)\): [\d.]+ Seiten/.test(d1.text) && d1.matches === 'yes', `${d1.text} | pdfinfo ${pages1}`);
  check('Aufteilung je Teil: Verlegeblätter, Schnittvorlagen, Koordinaten …; Summe = Seitenzahl', bdSum(d1.bd) === pages1 && /Verlegeblätter: \d+/.test(d1.bd) && /Schnittvorlagen: \d+/.test(d1.bd) && /Koordinaten: \d+/.test(d1.bd), d1.bd);
  const sheetsAttr = Number(await page.getAttribute('[data-testid="pdf-plan"]', 'data-sheets'));
  const bdSheets = Number((d1.bd.match(/Verlegeblätter: (\d+)/) || [])[1]);
  check('Verlegeblätter in der Aufteilung = Blattzahl vorab', bdSheets === sheetsAttr, `${bdSheets} / ${sheetsAttr}`);
  const texts1 = pdfPageTexts(file1);
  check('Ohne Teile: keine Teilangabe in den Kopfzeilen', texts1.every((t) => !/Teil \d+\/\d+/.test(t.split('\n')[0] || '')));
  try {
    execFileSync('pdftoppm', ['-png', '-r', '60', '-f', '1', '-l', '1', file1, path.join(OUT, 'w6pf-standard-p')]);
  } catch {
    /* nur zur Ansicht */
  }

  // ================================================================ 3. Export in Teilen: Kopfzeilen
  await page.evaluate(() => localStorage.setItem('mp.pdfBudgetMb', '0.01'));
  await page.reload();
  await page.waitForSelector('[data-testid="pdf-parts"]');
  const perSecMb = await page.$$eval('[data-testid="pdf-part"]', (els) =>
    els.map((e) => {
      const m = e.textContent.match(/Speicher ca\. ([\d.,]+) (KB|MB)/);
      return m ? Number(m[1].replace(/\./g, '').replace(',', '.')) / (m[2] === 'KB' ? 1024 : 1) : 0;
    }),
  );
  const budgetMb = Math.round(Math.max(...perSecMb) * 2.4 * 100) / 100;
  await page.evaluate((mb) => localStorage.setItem('mp.pdfBudgetMb', String(mb)), budgetMb);
  await page.reload();
  await page.waitForSelector('[data-testid="pdf-parts"]');
  await planReady(page);
  const nParts = Number(await page.getAttribute('[data-testid="pdf-parts"]', 'data-parts'));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="pdf-part"]')].every((e) => e.dataset.measured === 'yes'), null, { timeout: 120000 });
  const parts = await page.$$eval('[data-testid="pdf-part"]', (els) => els.map((e) => ({ no: Number(e.dataset.part), ids: e.dataset.sections.split(','), pages: Number(e.dataset.pages) })));
  check('Teile vorhanden und gemessen', nParts >= 2 && parts.every((p) => p.pages > 0), parts.map((p) => `${p.ids.join('+')}: ${p.pages}`).join(' | '));
  const k = Math.min(2, nParts);
  const part = parts[k - 1];
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), page.click(`[data-testid="pdf-part"][data-part="${k}"] [data-testid="pdf-part-btn"]`)]);
  const fileK = path.join(OUT, `w6pf-part-${k}.pdf`);
  await dl.saveAs(fileK);
  await page.waitForSelector(`[data-testid="pdf-part"][data-part="${k}"] [data-testid="pdf-part-file"][data-pages]:not([data-pages=""])`, { timeout: 60000 });
  const dK = await doneInfo(page, `[data-testid="pdf-part"][data-part="${k}"] [data-testid="pdf-part-file"]`);
  const textsK = pdfPageTexts(fileK);
  const pagesK = pdfPageCount(fileK);
  const heads = textsK.map((t) => (t.split('\n').find((l) => l.trim()) || '').trim());
  const headOk = heads.filter((h) => new RegExp(`Teil ${k}/${nParts} \\(Abschnitte [A-Z]+\\d+`).test(h)).length;
  await page.locator(`[data-testid="pdf-part"][data-part="${k}"]`).screenshot({ path: path.join(OUT, 'w6pf-03-part-done.png') });
  check(`Teil ${k}/${nParts}: „Teil ${k}/${nParts} (Abschnitte …)“ in jeder Kopfzeile`, headOk === pagesK, `${headOk}/${pagesK}; z. B. „${heads[0]}“`);
  check(`Teil ${k}: Seitenzahl im Schritt = Datei = Messung des Teils (wie vorab geschätzt)`, dK.pages === pagesK && pagesK === part.pages && dK.estimate === part.pages && /wie vorab geschätzt/.test(dK.text) && bdSum(dK.bd) === pagesK, `${dK.text} | pdfinfo ${pagesK}`);
  try {
    execFileSync('pdftoppm', ['-png', '-r', '60', '-f', '1', '-l', '2', fileK, path.join(OUT, 'w6pf-part-p')]);
  } catch {
    /* nur zur Ansicht */
  }
  await page.evaluate(() => localStorage.removeItem('mp.pdfBudgetMb'));

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
