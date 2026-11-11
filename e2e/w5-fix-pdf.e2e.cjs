/* E2E – Nachbesserung „PDF“ nach der Gegenprüfung von Welle 5 (w5-fix-pdf) im echten Browser (Chromium/Playwright).
 * Voraussetzung: `npm run build` und `npx vite preview` laufen; pdfinfo/pdftotext (poppler) installiert.
 * Aufruf: node e2e/w5-fix-pdf.e2e.cjs <baseUrl> <outDir>
 *
 * Geprüft:
 *  - Schritt 10: Hauptaktion „PDF erzeugen · ca. N S.“ sofort sichtbar in der Leiste unten (Desktop und Handy) statt
 *    eines gesperrten „Weiter“; „Öffnen“ / „Erneut herunterladen“ als Schaltflächen
 *  - fertiges PDF wird nach Palettenänderung oder Umbenennen nicht mehr als fertig angeboten
 *  - Rückgängig bis zum berechneten Stand: ΔE je Farbe wieder sichtbar, „manuell geändert“ nicht mehr gemeldet
 *  - zweiter Tab während eines Exports: kein „nicht beendeter Export“, Vermerk und Speichergrenze bleiben
 *  - Export in Teilen: jeder Teil gemessen (Seitenzahl = Seiten des Teil-PDFs = Einzeldatei derselben Abschnitte),
 *    „Teil k von n“ auf dem Deckblatt und in jeder Fußzeile, kein Hinweis „unvollständig“, Vorlagen nur der Abschnitte
 *  - Dateinamen nur ASCII, Wort in der Sprache der Oberfläche (verlegeplan / laying-plan)
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w5-fix-pdf');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pdfPageCount = (file) => Number((execFileSync('pdfinfo', [file], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/) || [])[1]);
const pdfPageTexts = (file) => execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }).split('\f').filter((t, i, a) => i < a.length - 1 || t.trim());

async function openSample(page, key) {
  await page.goto(BASE);
  await page.waitForSelector(`[data-testid="sample-${key}"]`);
  await page.click(`[data-testid="sample-${key}"]`);
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 240000 });
  await wait(800);
}
async function goPdf(page) {
  await page.click('[data-testid="step-pdf"]');
  await page.waitForSelector('[data-testid="pdf-step"]');
}
async function planReady(page) {
  await page.waitForSelector('[data-testid="pdf-plan"][data-state="ready"]', { timeout: 120000 });
  return Number(await page.getAttribute('[data-testid="pdf-plan"]', 'data-total'));
}
/** Hauptaktion (unten in der Leiste bzw. oben im Schritt): sichtbar ohne Scrollen? */
async function navAction(page, testId = 'pdf-nav-action') {
  const el = await page.$(`[data-testid="${testId}"]`);
  if (!el) return null;
  const box = await el.evaluate((b) => {
    const r = b.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, vh: window.innerHeight, scrollY: window.scrollY, disabled: b.disabled, kind: b.dataset.kind, text: b.textContent.trim() };
  });
  return { ...box, inView: box.top >= 0 && box.bottom <= box.vh + 1 };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // ================================================================ 1. Hauptaktion in der Leiste unten (Desktop)
  await openSample(page, 'portrait');
  await goPdf(page);
  const total = await planReady(page);
  await wait(300);
  let act = await navAction(page);
  const top = await navAction(page, 'pdf-top-action');
  await page.screenshot({ path: path.join(OUT, 'w5fp-01-step10-desktop.png') });
  check('Desktop: „PDF erzeugen · ca. N S.“ oben im Schritt ohne Scrollen sichtbar', top && top.inView && !top.disabled && top.scrollY === 0 && top.text === `PDF erzeugen · ca. ${total} S.`, top && `${top.text}; oben ${Math.round(top.top)} px von ${top.vh}`);
  check('Leiste unten: statt gesperrtem „Weiter“ dieselbe Hauptaktion', act && !act.disabled && act.text === top.text && !(await page.$('[data-testid="next-step"]')), act && act.text);

  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), page.click('[data-testid="pdf-top-action"]')]);
  const file1 = path.join(OUT, 'w5fp-single.pdf');
  await dl.saveAs(file1);
  await page.waitForSelector('[data-testid="pdf-done"]', { timeout: 60000 });
  const name1 = await page.getAttribute('[data-testid="pdf-done"]', 'data-name');
  check('Klick oben erzeugt das PDF (Seitenzahl wie angekündigt)', pdfPageCount(file1) === total, `${pdfPageCount(file1)} Seiten, angekündigt ca. ${total}`);
  check('Dateiname nur ASCII (Menschenporträt → Menschenportraet), Wort „verlegeplan“', /^[A-Za-z0-9_.-]+$/.test(name1) && /Menschenportraet_verlegeplan\.pdf$/.test(name1) && dl.suggestedFilename() === name1, name1);
  const btnCls = await page.$$eval('[data-testid="pdf-done"] [data-testid="pdf-open"], [data-testid="pdf-done"] [data-testid="pdf-download"]', (els) => els.map((e) => `${e.tagName}.${e.className}:${getComputedStyle(e).borderTopStyle}`));
  check('„Öffnen“ und „Erneut herunterladen“ als Schaltflächen', btnCls.length === 2 && btnCls.every((c) => /btn/.test(c) && /solid/.test(c)), btnCls.join(' · '));
  await page.screenshot({ path: path.join(OUT, 'w5fp-02-done-desktop.png'), fullPage: true });

  // ================================================================ 2. fertiges PDF veraltet: Palette, Umbenennen
  await page.click('[data-testid="step-colors"]');
  const inp = page.locator('.palette-editor input[type="color"]').first();
  await inp.waitFor();
  await inp.fill('#ff00ff');
  await wait(600);
  await goPdf(page);
  await wait(800);
  check('Nach Palettenänderung: altes PDF nicht mehr als fertig angeboten', !(await page.$('[data-testid="pdf-done"]')));
  // neu erzeugen, dann umbenennen
  await planReady(page);
  await Promise.all([page.waitForEvent('download', { timeout: 240000 }), page.click('[data-testid="pdf-btn"]')]);
  await page.waitForSelector('[data-testid="pdf-done"]', { timeout: 60000 });
  await page.fill('[data-testid="project-name"]', 'Größe Çiçek');
  await wait(600);
  check('Nach Umbenennen: altes PDF nicht mehr als fertig angeboten', !(await page.$('[data-testid="pdf-done"]')));
  await planReady(page);
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), page.click('[data-testid="pdf-nav-action"]')]);
  check('Dateiname mit Umlaut und türkischen Buchstaben: ASCII', dl2.suggestedFilename() === 'Groesse_Cicek_verlegeplan.pdf', dl2.suggestedFilename());
  await page.waitForSelector('[data-testid="pdf-done"]', { timeout: 60000 });

  // Englisch: Wort im Dateinamen
  await page.selectOption('select.lang', 'en');
  await planReady(page);
  await wait(300);
  act = await navAction(page);
  const [dl3] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), page.click('[data-testid="pdf-nav-action"]')]);
  check('Englisch: „Create PDF · approx. N p.“, Dateiname …_laying-plan.pdf', act && /^Create PDF · approx\. \d+ p\.$/.test(act.text) && dl3.suggestedFilename() === 'Groesse_Cicek_laying-plan.pdf', `${act && act.text} · ${dl3.suggestedFilename()}`);
  await page.waitForSelector('[data-testid="pdf-done"]', { timeout: 60000 });
  await page.selectOption('select.lang', 'de');
  await wait(300);

  // ================================================================ 3. Rückgängig bis zum berechneten Stand
  await openSample(page, 'portrait');
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="palette-table"]');
  await wait(500);
  const matchFresh = await page.locator('[data-testid="palette-match"]').count();
  await page.locator('[data-testid="palette-remove"]').nth(2).click();
  await page.click('[data-testid="palette-remove-confirm"]');
  await wait(400);
  const matchEdited = await page.locator('[data-testid="palette-match"]').count();
  await page.click('[data-testid="palette-table"] thead');
  await page.keyboard.press('Control+z');
  await wait(1500);
  const matchUndone = await page.locator('[data-testid="palette-match"]').count();
  await page.click('[data-testid="step-compute"]');
  await wait(500);
  const mainText = (await page.textContent('main')) || '';
  check('Farbe entfernt und rückgängig: ΔE je Farbe wieder wie frisch berechnet', matchFresh > 0 && matchEdited < matchFresh && matchUndone === matchFresh, `frisch ${matchFresh}, bearbeitet ${matchEdited}, rückgängig ${matchUndone}`);
  check('Schritt Berechnen meldet danach keine manuell geänderten Steine', /keine Steine manuell geändert/.test(mainText) || !/manuell geändert/.test(mainText), (mainText.match(/[^.]*manuell[^.]*\./) || [''])[0].slice(0, 120));

  // ================================================================ 4. zweiter Tab während eines Exports
  await goPdf(page);
  // längerer Export (Koordinaten je Stein), damit der zweite Tab sicher währenddessen prüft
  if (!(await page.isChecked('label.toggle:has-text("Koordinaten") input'))) await page.click('label.toggle:has-text("Koordinaten")');
  await page.click('[data-testid="pdf-coordmode"] button:has-text("Je Stein")');
  await planReady(page);
  const tabB = await context.newPage();
  tabB.on('pageerror', (e) => errors.push(`B: ${String(e)}`));
  await tabB.goto(page.url());
  await tabB.waitForSelector('[data-testid="pdf-step"]', { timeout: 60000 });
  await tabB.click('[data-testid="step-preview"]');
  await page.click('[data-testid="pdf-nav-action"]');
  await page.waitForSelector('[data-testid="pdf-busy"]', { timeout: 10000 });
  const markA = await page.evaluate(() => JSON.parse(localStorage.getItem('mp.pdfInFlight') || 'null'));
  await tabB.click('[data-testid="step-pdf"]');
  await tabB.waitForSelector('[data-testid="pdf-step"]');
  await wait(600);
  const stillBusy = await page.isVisible('[data-testid="pdf-busy"]');
  const bState = await tabB.evaluate(() => ({ flag: localStorage.getItem('mp.pdfInFlight'), budget: localStorage.getItem('mp.pdfBudgetMb') }));
  const bNote = await tabB.isVisible('[data-testid="pdf-crash-note"]');
  check('Zweiter Tab: laufender Export ist kein Absturz – kein Hinweis, Vermerk bleibt, Grenze unverändert', markA && markA.owner && markA.beat && !bNote && stillBusy && bState.flag !== null && bState.budget === null, `Vermerk von ${markA && markA.owner}; B: Hinweis ${bNote}, Vermerk ${bState.flag ? 'da' : 'weg'}, Grenze ${bState.budget}, A läuft noch ${stillBusy}`);
  await page.waitForSelector('[data-testid="pdf-done"]', { timeout: 240000 });
  await tabB.reload();
  await tabB.waitForSelector('[data-testid="pdf-step"]');
  await wait(1500);
  check('Nach dem Export: Vermerk gelöscht, im zweiten Tab weder Hinweis noch gesenkte Grenze', (await tabB.evaluate(() => localStorage.getItem('mp.pdfInFlight'))) === null && !(await tabB.isVisible('[data-testid="pdf-crash-note"]')) && (await tabB.evaluate(() => localStorage.getItem('mp.pdfBudgetMb'))) === null);
  await tabB.close();
  await page.click('[data-testid="pdf-coordmode"] button:has-text("Kompakt")');

  // ================================================================ 5. Export in Teilen
  // Grenze so, dass je Teil etwa zwei Abschnitte passen: erst winzige Grenze (jeder Abschnitt ein Teil, Richtwert je
  // Abschnitt steht dabei), dann das 2,4-Fache des größten Abschnitts
  const nSec = await page.$$eval('[data-testid="sec-cell"]', (els) => els.length);
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
  // jeder Teil wird gemessen
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="pdf-part"]')].every((e) => e.dataset.measured === 'yes'), null, { timeout: 120000 });
  const parts = await page.$$eval('[data-testid="pdf-part"]', (els) => els.map((e) => ({ no: Number(e.dataset.part), ids: e.dataset.sections.split(','), pages: Number(e.dataset.pages) })));
  const partsText = (await page.textContent('[data-testid="pdf-parts"]')) || '';
  check('Teile: kein Hinweis „unvollständig“ mehr; jeder Teil gemessen', nParts >= 2 && !/unvollständig/.test(partsText) && !/Teilnummer steht bisher nur im Dateinamen/.test(partsText) && parts.every((p) => p.pages > 0), parts.map((p) => `${p.ids.join('+')}: ${p.pages}`).join(' | '));
  act = await navAction(page);
  check('Oben und in der Leiste unten: „Teil 1/n erzeugen · ca. N S.“', act && (await navAction(page, 'pdf-top-action')).text === act.text && act.kind === 'part' && act.text === `Teil 1/${nParts} erzeugen · ca. ${parts[0].pages} S.`, act && act.text);
  await page.screenshot({ path: path.join(OUT, 'w5fp-03-parts.png'), fullPage: true });
  const partFiles = [];
  check('Kein Teil schon allein zu groß (Grenze passend gewählt)', !(await page.isVisible('[data-testid="pdf-too-big"]')), `Grenze ${budgetMb} MB, ${nSec} Abschnitte`);
  for (let i = 0; i < Math.min(nParts, 2); i++) {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), page.click('[data-testid="pdf-nav-action"]')]);
    const f = path.join(OUT, `w5fp-part-${i + 1}.pdf`);
    await d.saveAs(f);
    await page.waitForSelector(`[data-testid="pdf-part"][data-part="${i + 1}"][data-done="yes"]`, { timeout: 60000 });
    partFiles.push({ f, name: d.suggestedFilename() });
    await wait(300);
  }
  partFiles.forEach((pf, i) => {
    const texts = pdfPageTexts(pf.f);
    const pages = pdfPageCount(pf.f);
    const footers = texts.filter((t) => new RegExp(`Teil ${i + 1}/${nParts} · `).test(t)).length;
    check(`Teil ${i + 1}: Seitenzahl = Messung, „Teil ${i + 1} von ${nParts}“ auf dem Deckblatt, „Teil ${i + 1}/${nParts}“ in jeder Fußzeile`, pages === parts[i].pages && new RegExp(`Teil ${i + 1} von ${nParts}`).test(texts[0]) && footers === pages, `${pages} Seiten (gemessen ${parts[i].pages}), Fußzeilen ${footers}`);
    check(`Teil ${i + 1}: Dateiname ASCII mit Teilnummer`, /^[A-Za-z0-9_.-]+$/.test(pf.name) && new RegExp(`_verlegeplan_Teil-${i + 1}-von-${nParts}_`).test(pf.name), pf.name);
    const tplTexts = texts.filter((t) => /Schnittvorlagen/.test(t)).join('\n');
    const occ = [...tplTexts.matchAll(/Blätter: ([^\n]*)/g)].map((m) => m[1]);
    const own = parts[i].ids;
    check(`Teil ${i + 1}: Schnittvorlagen nennen nur Blätter seiner Abschnitte`, occ.every((o) => [...o.matchAll(/([A-Z]+\d+)-\d+:/g)].every((m) => own.includes(m[1]))), `${occ.length} Vorlagen`);
  });
  // gleiche Abschnitte als Einzeldatei: dieselbe Seitenzahl
  await page.click('.w5pe-anyway summary');
  await page.evaluate(() => localStorage.removeItem('mp.pdfBudgetMb'));
  await page.click('[data-testid="pdf-budget-reset"]');
  await page.waitForSelector('[data-testid="pdf-btn"]');
  await page.fill('[data-testid="sec-range"]', parts[0].ids.join(', '));
  await page.press('[data-testid="sec-range"]', 'Enter');
  const singleSame = await planReady(page);
  check('Einzeldatei derselben Abschnitte: gleiche Seitenzahl wie der Teil', singleSame === parts[0].pages, `Teil 1 ca. ${parts[0].pages}, Einzeldatei ca. ${singleSame}`);

  // ================================================================ 6. Handy
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => errors.push(`Handy: ${String(e)}`));
  await openSample(pp, 'portrait');
  await goPdf(pp);
  const ptotal = await planReady(pp);
  await wait(300);
  const pact = await navAction(pp);
  await pp.screenshot({ path: path.join(OUT, 'w5fp-04-step10-phone.png') });
  check('Handy: Hauptaktion ohne Scrollen sichtbar, kein waagerechtes Scrollen', pact && pact.inView && !pact.disabled && pact.text === `PDF erzeugen · ca. ${ptotal} S.` && (await overflow(pp)) <= 0, pact && `${pact.text}; ${Math.round(pact.top)}–${Math.round(pact.bottom)} von ${pact.vh}`);
  await pp.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await wait(200);
  const pact2 = await navAction(pp);
  check('Handy: auch ganz unten bleibt sie sichtbar', pact2 && pact2.inView);
  await Promise.all([pp.waitForEvent('download', { timeout: 240000 }), pp.tap('[data-testid="pdf-nav-action"]')]);
  await pp.waitForSelector('[data-testid="pdf-done"]', { timeout: 60000 });
  await pp.screenshot({ path: path.join(OUT, 'w5fp-05-done-phone.png'), fullPage: true });
  check('Handy: nach dem Erzeugen kein waagerechtes Scrollen', (await overflow(pp)) <= 0);
  await phone.close();

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
