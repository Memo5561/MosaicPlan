/* End-to-End-Test im echten Browser (Chromium/Playwright).
 * Voraussetzung: `npm run build` und `npx vite preview --port 4173` laufen.
 * Aufruf: node e2e/run-e2e.cjs [baseUrl] [screenshotDir]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(BASE);
  await page.waitForSelector('text=MosaicPlan');
  await page.screenshot({ path: path.join(OUT, '01-start.png') });
  check('Startseite lädt', await page.isVisible('[data-testid="new-project"]'));

  // ---------- Testprojekt Porträt
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.screenshot({ path: path.join(OUT, '02-compute.png') });
  const positions = await page.textContent('[data-testid="grid-positions"]');
  check('Rasterpositionen angezeigt', /\d/.test(positions), positions);
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, '03-preview.png') });
  check('Mosaik berechnet, Vorschau sichtbar', true);

  // Stein anklicken
  const canvas = await page.$('[data-testid="mosaic-canvas"]');
  const box = await canvas.boundingBox();
  // hineinzoomen
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.42);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '04-zoom.png') });
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.42);
  await page.waitForSelector('[data-testid="stone-id"]');
  const stoneId = (await page.textContent('[data-testid="stone-id"]')).trim();
  const coords = (await page.textContent('[data-testid="stone-coords"]')).trim();
  const cutText = (await page.textContent('[data-testid="cut-instructions"]')).trim();
  check('Steindetail öffnet', /^[A-Z]+\d{3}/.test(stoneId), `${stoneId} | ${coords.slice(0, 40)} | ${cutText.slice(0, 60)}`);
  await page.screenshot({ path: path.join(OUT, '05-stone.png') });
  // Farbe ändern
  const firstAlt = await page.$('[data-testid="color-pick"] button:not(.active)');
  await firstAlt.click();
  await page.waitForTimeout(300);
  check('Farbe eines Steins geändert', await page.isVisible('[data-testid="color-pick"] button.active'));
  // Form ändern: Diagonalschnitt → berechnete Schnittvorlage
  await page.click('button:has-text("Dreiecke ╲")');
  await page.waitForTimeout(300);
  const cut2 = (await page.textContent('[data-testid="cut-instructions"]')).trim();
  const id2 = (await page.textContent('[data-testid="stone-id"]')).trim();
  check('Form geändert: Dreieck mit berechneter Schnittvorlage', /Dreieck schneiden/.test(cut2) && /Schnitt 1/.test(cut2) && /-1/.test(id2), `${id2.slice(0, 12)} | ${cut2.slice(0, 90)}`);
  await page.screenshot({ path: path.join(OUT, '05b-stone-triangle.png') });
  await page.keyboard.press('Escape');

  // ---------- Verlegeplan + Fortschritt
  await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="progress-pct"]');
  await page.click('text=Verlegemodus');
  await page.evaluate(() => window.scrollTo(0, 0));
  const c2 = await page.$('[data-testid="mosaic-canvas"]');
  await c2.scrollIntoViewIfNeeded();
  const b2 = await c2.boundingBox();
  const cx = b2.x + b2.width / 2;
  const cy = b2.y + b2.height / 2;
  const placedNow = async () => {
    await page.waitForTimeout(1200);
    return parseInt((await page.textContent('[data-testid="placed-count"]')).replace(/\D/g, ''), 10);
  };
  await page.mouse.click(cx, cy);
  const p1 = await placedNow();
  await page.mouse.click(cx, cy);
  const p0 = await placedNow();
  await page.mouse.click(cx, cy);
  await page.mouse.click(cx + 60, cy + 40);
  const p2 = await placedNow();
  const pct = await page.textContent('[data-testid="progress-pct"]');
  check('Fortschritt (Verlegemodus: Antippen setzt/entfernt)', p1 === 1 && p0 === 0 && p2 === 2, `1→${p1}, 0→${p0}, 2→${p2}`);
  // Abschnitt A1 als fertig markieren
  await page.click('.section-cell >> nth=0');
  await page.click('text=Abschnitt fertig');
  await page.waitForTimeout(1500);
  const pct2 = await page.textContent('[data-testid="progress-pct"]');
  // „< 0,1 %“ (verlegt, aber unter der Anzeigegenauigkeit) zählt als 0,1
  const pctNum = (s) => parseFloat(String(s).replace(/[^\d,.]/g, '').replace(',', '.'));
  check('Abschnitt fertig markiert', pctNum(pct2) > pctNum(pct), `${pct} → ${pct2}`);
  await page.screenshot({ path: path.join(OUT, '06-plan.png') });
  await page.click('text=Material >> nth=-1');
  await page.waitForSelector('[data-testid="material-calc"]');
  const mcPieces = await page.textContent('[data-testid="mc-pieces"]');
  check('Materialberechnung', /\d/.test(mcPieces), mcPieces);
  await page.screenshot({ path: path.join(OUT, '07-material.png') });

  // ---------- PDF
  await page.click('[data-testid="step-pdf"]');
  await page.waitForSelector('[data-testid="pdf-btn"]');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('[data-testid="pdf-btn"]')]);
  const pdfPath = path.join(OUT, 'verlegeplan.pdf');
  await download.saveAs(pdfPath);
  const head = fs.readFileSync(pdfPath).slice(0, 5).toString();
  check('PDF erzeugt', head === '%PDF-', `${Math.round(fs.statSync(pdfPath).size / 1024)} KB`);
  await page.screenshot({ path: path.join(OUT, '08-pdf.png') });

  // ---------- Neustart: Projekt + Fortschritt erhalten?
  const url = page.url();
  await page.waitForTimeout(1500);
  await page.goto(BASE + '#/projects');
  await page.reload();
  await page.waitForSelector('[data-testid="project-row"]');
  await page.goto(url.replace(/\/pdf$/, '/plan'));
  await page.reload();
  await page.waitForSelector('[data-testid="progress-pct"]', { timeout: 60000 });
  await page.waitForTimeout(2000);
  const pct3 = await page.textContent('[data-testid="progress-pct"]');
  check('Projekt und Fortschritt nach Neustart erhalten', pct3.trim() === pct2.trim(), `${pct2} → ${pct3}`);

  // ---------- Sprache
  await page.goto(BASE + '#/settings');
  await page.click('[data-testid="lang-select"] >> text=Türkçe');
  await page.waitForTimeout(300);
  check('Türkisch', await page.isVisible('text=Ayarlar'));
  await page.click('[data-testid="lang-select"] >> text=English');
  await page.waitForTimeout(300);
  check('Englisch', await page.isVisible('text=Language'));
  await page.click('[data-testid="lang-select"] >> text=Deutsch');

  // ---------- Material anlegen
  await page.goto(BASE + '#/materials');
  await page.click('[data-testid="add-material"]');
  await page.fill('[data-testid="mat-manufacturer"]', 'Testhersteller');
  await page.fill('[data-testid="mat-colornumber"]', 'G-101');
  await page.fill('[data-testid="mat-hex"]', '#3A6EA5');
  await page.click('[data-testid="save-material"]');
  await page.waitForTimeout(400);
  check('Material gespeichert', (await page.textContent('[data-testid="materials-table"]')).includes('G-101'));

  // ---------- Offline (Service Worker)
  await page.goto(BASE);
  await page.waitForTimeout(2500);
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('[data-testid="new-project"]', { timeout: 15000 }).catch(() => {});
  check('App startet offline', await page.isVisible('[data-testid="new-project"]'));
  await context.setOffline(false);

  // ---------- Handy-Ansicht
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  await pp.goto(BASE);
  await pp.waitForSelector('[data-testid="new-project"]');
  await pp.screenshot({ path: path.join(OUT, '09-phone.png') });
  check('Handy-Ansicht', true);

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
