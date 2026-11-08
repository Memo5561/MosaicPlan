/* Browser-Prüfung „Rohstein-, Packungs- und Kostenbedarf“ (w1-material-quantities).
 * Voraussetzung: `npm run build` und `npx vite preview --port <port>` laufen.
 * Aufruf: node e2e/w1-material-quantities.e2e.cjs <baseUrl> <outDir>
 *
 * Geprüft wird in der Materialberechnung des Verlegeplans (Testprojekt Porträt, 5-mm-Raster):
 *  - Σ Rohsteine / Σ +Reserve der Farbtabelle = angezeigte Summen
 *  - Verschnitt (m² und %) passt zur angezeigten, gerundeten Rohsteinzahl
 *  - ein Material, das zwei Farben zugeordnet ist, wird einmal gekauft: Kosten = Packungen je Material × Preis
 *  - Kosten mit Hinweis „unvollständig“, solange Farben ohne Material sind
 *  - Hinweistext nennt den Rohsteinbedarf „Richtwert“ (DE) / „guide value“ (EN) / „yaklaşık değer“ (TR)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w1-material-quantities');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

/** deutsche Zahl („1.234,5“) → Zahl */
const num = (s) => parseFloat(String(s).replace(/[^\d,.\-−]/g, '').replace(/\./g, '').replace(',', '.').replace('−', '-'));

const MAT = {
  id: 'e2e-w1mq-shared',
  type: 'glass',
  manufacturer: 'E2E-Glas',
  product: 'Geteilt',
  colorNumber: 'W1-01',
  colorName: 'Prüfmaterial',
  hex: '#808080',
  lengthMm: 5,
  widthMm: 5,
  thicknessMm: 4,
  price: 7.5,
  packageSize: 'Beutel',
  // so groß, dass jede Farbe für sich 1 Packung bräuchte – gemeinsam aber auch nur 1
  piecesPerPack: 100000,
  stock: 0,
  notes: '',
};

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(BASE);
  await page.waitForSelector('[data-testid="new-project"]');
  // Material direkt in die lokale Datenbank legen (die App hat sie beim ersten Start angelegt)
  await page.evaluate(
    (m) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('mosaicplan');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('materials', 'readwrite');
          tx.objectStore('materials').put(m, m.id);
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    MAT,
  );
  await page.reload();
  await page.waitForSelector('[data-testid="sample-portrait"]');

  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
  await page.waitForTimeout(800);

  // ---------- Farben 01 und 02 demselben Material zuordnen
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="palette-table"]');
  const selects = page.locator('[data-testid="palette-table"] tbody tr select');
  const nSel = await selects.count();
  check('Farbtabelle mit Materialauswahl', nSel >= 3, `${nSel} Farben`);
  await selects.nth(0).selectOption(MAT.id);
  await page.waitForTimeout(300);
  await selects.nth(1).selectOption(MAT.id);
  await page.waitForTimeout(300);
  const v0 = await selects.nth(0).inputValue();
  const v1 = await selects.nth(1).inputValue();
  check('zwei Farben teilen ein Material', v0 === MAT.id && v1 === MAT.id, `${v0} / ${v1}`);

  // ---------- Materialberechnung
  await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="progress-pct"]');
  await page.click('text=Material >> nth=-1');
  await page.waitForSelector('[data-testid="material-calc"]');
  await page.waitForTimeout(1500); // Statistik-Worker

  const readCalc = () =>
    page.evaluate(() => {
      const root = document.querySelector('[data-testid="material-calc"]');
      const kv = {};
      for (const tr of root.querySelectorAll('table.kv tr')) {
        const th = tr.querySelector('th');
        const td = tr.querySelector('td');
        if (th && td) kv[th.textContent.trim()] = td.textContent.trim();
      }
      const tables = [...root.querySelectorAll('table.data')];
      const colorTable = tables.find((t) => t.querySelectorAll('thead th').length >= 7);
      const rows = colorTable
        ? [...colorTable.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()))
        : [];
      const hints = [...root.querySelectorAll('p')].map((p) => p.textContent.trim());
      const badge = !!root.querySelector('table.kv .badge-incomplete');
      return { kv, rows, hints, badge };
    });
  const calc = await readCalc();
  await page.screenshot({ path: path.join(OUT, 'w1mq-01-material.png'), fullPage: true });
  const mc = await page.$('[data-testid="material-calc"]');
  await mc.screenshot({ path: path.join(OUT, 'w1mq-02-material-calc.png') });

  const rawTotal = num(calc.kv['Rohsteine']);
  const withRes = num(calc.kv['Rohsteine inkl. Reserve']);
  const stoneM2 = num(calc.kv['Steinfläche'].split('m²')[0]);
  const wasteTxt = calc.kv['Verschnitt'] || '';
  const wasteM2 = num(wasteTxt.split('m²')[0]);
  const wastePct = num((wasteTxt.match(/\(([^)]*)%\)/) || [])[1]);
  check('Materialberechnung zeigt Summen', Number.isFinite(rawTotal) && Number.isFinite(withRes) && rawTotal > 0, `Rohsteine ${rawTotal}, inkl. Reserve ${withRes}`);

  // Spalten: Nr | Farbe | Steine | geschn. | Rohsteine | +Reserve | Pack.
  const sumRaw = calc.rows.reduce((a, r) => a + num(r[4]), 0);
  const sumRes = calc.rows.reduce((a, r) => a + num(r[5]), 0);
  check('Σ Rohsteine je Farbe = Rohsteine gesamt', sumRaw === rawTotal, `${sumRaw} = ${rawTotal}`);
  check('Σ +Reserve je Farbe = Rohsteine inkl. Reserve', sumRes === withRes, `${sumRes} = ${withRes}`);
  const bad = calc.rows.filter((r) => num(r[4]) > num(r[2]) || num(r[5]) < num(r[4]));
  check('je Farbe: Rohsteine ≤ Steine, +Reserve ≥ Rohsteine', bad.length === 0 && calc.rows.length > 0, `${calc.rows.length} Farben`);

  // Verschnitt aus der angezeigten Rohsteinzahl (alle Rohsteine 5 × 5 mm: Rastermaß bzw. Prüfmaterial)
  const rawM2 = (rawTotal * 25) / 1e6;
  const expWaste = rawM2 - stoneM2;
  check('Verschnitt (m²) passt zur angezeigten Rohsteinzahl', Math.abs(wasteM2 - expWaste) <= 0.00015, `${wasteM2} m² ≈ ${rawTotal}·25 mm² − ${stoneM2} m² = ${expWaste.toFixed(5)} m²`);
  const expPct = (wasteM2 / rawM2) * 100;
  check('Verschnitt (%) passt zur angezeigten Rohsteinzahl', Math.abs(wastePct - expPct) <= 0.1, `${wastePct} % ≈ ${expPct.toFixed(2)} %`);

  // Kosten: ein Material für zwei Farben → 1 Packung × 7,50 (nicht 2 × 7,50)
  const row01 = calc.rows.find((r) => r[0] === '01');
  const row02 = calc.rows.find((r) => r[0] === '02');
  const costTxt = calc.kv['Kosten'] || '';
  const cost = num(costTxt.replace(/unvollständig/, ''));
  check('Farben 01/02 je für sich 1 Packung (Ansicht je Farbe)', !!row01 && !!row02 && num(row01[6]) === 1 && num(row02[6]) === 1, `${row01 && row01[6]} / ${row02 && row02[6]}`);
  check('Kosten je Material: gemeinsames Material einmal gekauft (7,5 statt 15)', Math.abs(cost - 7.5) < 1e-9, costTxt);
  check('Kosten als unvollständig markiert (Farben ohne Material)', calc.badge && /unvollständig/.test(costTxt), costTxt);

  const hintDe = calc.hints.find((h) => /Rohsteinbedarf/.test(h)) || '';
  check('Hinweis DE: Rohsteinbedarf als Richtwert, je Schnittform, Kosten je Material', /Richtwert/.test(hintDe) && /gespiegelt/.test(hintDe) && /je Material/.test(hintDe), hintDe.slice(0, 90));

  // ---------- Englisch und Türkisch: Hinweis übersetzt
  const planUrl = page.url();
  for (const [lang, label, re] of [
    ['English', 'Material', /guide value/],
    ['Türkçe', 'Malzeme', /yaklaşık değer/],
  ]) {
    await page.goto(BASE + '#/settings');
    await page.click(`[data-testid="lang-select"] >> text=${lang}`);
    await page.waitForTimeout(300);
    await page.goto(planUrl);
    await page.waitForSelector('[data-testid="progress-pct"]', { timeout: 60000 });
    await page.click(`text=${label} >> nth=-1`);
    await page.waitForSelector('[data-testid="material-calc"]');
    await page.waitForTimeout(800);
    const hint = await page.evaluate(() => [...document.querySelectorAll('[data-testid="material-calc"] p')].map((p) => p.textContent).join(' | '));
    check(`Hinweis ${lang} übersetzt`, re.test(hint), hint.slice(0, 90));
    if (lang === 'English') await page.screenshot({ path: path.join(OUT, 'w1mq-03-material-en.png'), fullPage: false });
  }
  await page.goto(BASE + '#/settings');
  await page.click('[data-testid="lang-select"] >> text=Deutsch');

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
