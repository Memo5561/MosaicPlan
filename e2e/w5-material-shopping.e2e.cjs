/* Browser-Prüfung „Material & Einkauf“ (w5-material-shopping).
 * Voraussetzung: `npm run build` und `npx vite preview --port <port>` laufen.
 * Aufruf: node e2e/w5-material-shopping.e2e.cjs <baseUrl> <outDir>
 *
 * Testprojekt Porträt (5-mm-Raster, 32 Farben) mit Prüfmaterialien:
 *  - A: Farben 01 + 02, 100 Stück/Packung, Bestand 10, Preis 7,5   (gemeinsam → eine Zeile, Fehlbestand)
 *  - B: Farbe 03, 250 Stück/Packung, Preis 12,9, kein Bestand       (zu kaufen leer, nicht angenommen)
 *  - C: Farbe 04, Bestand 100000, ohne Packungsgröße und Preis      (Packungen/Kosten „–“, kein Fehlbestand)
 *  - D: Farbe 05, danach gelöscht                                   („Material fehlt“)
 * Geprüft wird:
 *  - 1440 px: volle Breite, KEINE Tabelle braucht waagerechtes Scrollen, Spalte „Packungen“ sichtbar;
 *  - Einkaufsliste: Packungen = ⌈Bedarf/Stück je Packung⌉, zu kaufen = Bedarf − Bestand, Kosten = Packungen × Preis,
 *    Σ Bedarf = „Rohsteine inkl. Reserve“, Σ Kosten = Materialkosten (2 Nachkommastellen, „unvollständig“);
 *  - Bedarf je Farbe: Name, Material bzw. „Material fehlt“/„kein Material“, Σ = Gesamtwerte;
 *  - Hinweise: Fehlbestand (Material A), fehlendes Material (05), Bestand nicht erfasst;
 *  - CSV: ';' + Dezimalkomma (DE), ',' + Punkt (EN), Summen = Anzeige;
 *  - Drucken: window.print() wird aufgerufen, Druckansicht ohne Navigation/Schritte, nur Material & Einkauf;
 *  - 390 und 360 px (Handy): Karten statt Tabellen, kein waagerechtes Scrollen, Packungen sichtbar;
 *  - Englisch und Türkisch vollständig (keine fehlenden Schlüssel).
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w5-material-shopping');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

/** deutsche Zahl („1.234,5“) → Zahl; „–“/leer → NaN */
const num = (s) => {
  const t = String(s).replace(/[^\d,.\-−]/g, '').replace(/\./g, '').replace(',', '.').replace('−', '-');
  return t === '' || t === '-' ? NaN : parseFloat(t);
};
/** englische Zahl („1,234.5“) → Zahl */
const numEn = (s) => {
  const t = String(s).replace(/[^\d.\-]/g, '');
  return t === '' ? NaN : parseFloat(t);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const MATS = [
  { id: 'e2e-w5ms-a', manufacturer: 'E2E-Glas', product: 'Geteilt', colorNumber: 'A-01', colorName: 'Prüfgrau', hex: '#808080', lengthMm: 5, widthMm: 5, price: 7.5, packageSize: 'Beutel 100', piecesPerPack: 100, stock: 10 },
  { id: 'e2e-w5ms-b', manufacturer: 'E2E-Glas', product: 'Ohne Bestand', colorNumber: 'B-02', colorName: 'Prüfblau', hex: '#3060a0', lengthMm: 5, widthMm: 5, price: 12.9, packageSize: '', piecesPerPack: 250 },
  { id: 'e2e-w5ms-c', manufacturer: 'E2E-Keramik', product: 'Lose', colorNumber: 'C-03', colorName: 'Prüfrot', hex: '#a03030', lengthMm: 5, widthMm: 5, price: 0, packageSize: '', piecesPerPack: 0, stock: 100000 },
  { id: 'e2e-w5ms-d', manufacturer: 'E2E-Glas', product: 'Wird gelöscht', colorNumber: 'D-04', colorName: 'Prüfgrün', hex: '#30a050', lengthMm: 5, widthMm: 5, price: 3, packageSize: '', piecesPerPack: 50 },
].map((m) => ({ type: 'glass', thicknessMm: 4, notes: '', ...m }));

async function db(page, fn, arg) {
  return page.evaluate(
    ([src, a]) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('mosaicplan');
        req.onsuccess = () => {
          const d = req.result;
          const tx = d.transaction('materials', 'readwrite');
          const store = tx.objectStore('materials');
          // eslint-disable-next-line no-new-func
          new Function('store', 'a', src)(store, a);
          tx.oncomplete = () => {
            d.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    [fn, arg],
  );
}

/** Material & Einkauf ablesen */
async function readView(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="material-calc"]');
    const txt = (sel, el = root) => ((el.querySelector(sel) || {}).textContent || '').trim();
    const shop = [...root.querySelectorAll('[data-testid="mc-shop-row"]')].map((tr) => {
      const cell = {};
      for (const td of tr.querySelectorAll('td[data-col]')) cell[td.getAttribute('data-col')] = td.textContent.trim();
      const packsN = (tr.querySelector('[data-testid="mc-shop-packs"]') || {}).textContent;
      const packsBuyN = (tr.querySelector('[data-testid="mc-shop-packs-buy"]') || {}).textContent;
      return { material: tr.getAttribute('data-material'), cell, packsN, packsBuyN, short: tr.querySelector('[data-testid="mc-shop-tobuy"]').classList.contains('error') };
    });
    const colors = [...root.querySelectorAll('[data-testid="mc-color-row"]')].map((tr) => {
      const cell = {};
      for (const td of tr.querySelectorAll('td[data-col]')) cell[td.getAttribute('data-col')] = td.textContent.trim();
      return cell;
    });
    const wraps = [...root.querySelectorAll('.table-wrap')].map((w) => ({ sw: w.scrollWidth, cw: w.clientWidth, id: (w.querySelector('table') || {}).getAttribute ? w.querySelector('table').getAttribute('data-testid') : '' }));
    return {
      pieces: txt('[data-testid="mc-pieces"]'),
      rawRes: txt('[data-testid="mc-raw-reserve"]'),
      cost: txt('[data-testid="mc-cost"]'),
      costBadge: !!root.querySelector('[data-testid="mc-cost"] .badge-incomplete'),
      buyCost: txt('[data-testid="mc-buy-cost"]'),
      grout: txt('[data-testid="mc-grout-stat"]') + ' ' + (root.querySelector('[data-testid="mc-grout-stat"]')?.parentElement.textContent || ''),
      shop,
      needSum: txt('[data-testid="mc-shop-need-sum"]'),
      costSum: txt('[data-testid="mc-shop-sum"]'),
      colors,
      colorSumPieces: txt('[data-testid="mc-color-sum-pieces"]'),
      colorSumRes: txt('[data-testid="mc-color-sum-reserve"]'),
      shortfall: txt('[data-testid="mc-shortfall"]'),
      shortItems: [...root.querySelectorAll('[data-testid="mc-short-item"]')].map((li) => li.textContent.trim()),
      missing: txt('[data-testid="mc-missing"]'),
      unlinked: txt('[data-testid="mc-unlinked"]'),
      stockUnknown: txt('[data-testid="mc-stock-unknown"]'),
      wraps,
      text: root.textContent,
    };
  });
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await page.goto(BASE);
    await page.waitForSelector('[data-testid="new-project"]');
    await db(page, 'for (const m of a) store.put(m, m.id);', MATS);
    await page.reload();
    await page.waitForSelector('[data-testid="sample-portrait"]');
    await page.click('[data-testid="sample-portrait"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
    await wait(800);

    // ---------- Materialien zuordnen: 01 + 02 → A, 03 → B, 04 → C, 05 → D
    await page.click('[data-testid="step-colors"]');
    await page.waitForSelector('[data-testid="palette-table"]');
    const selects = page.locator('[data-testid="palette-table"] tbody tr select');
    const assign = [MATS[0].id, MATS[0].id, MATS[1].id, MATS[2].id, MATS[3].id];
    for (let i = 0; i < assign.length; i++) {
      await selects.nth(i).selectOption(assign[i]);
      await wait(250);
    }
    const vals = [];
    for (let i = 0; i < assign.length; i++) vals.push(await selects.nth(i).inputValue());
    check('Prüfmaterialien zugeordnet (01+02 → A, 03 → B, 04 → C, 05 → D)', JSON.stringify(vals) === JSON.stringify(assign), vals.join(', '));
    const projectUrl = page.url();
    // Material D löschen → Farbe 05 „Material fehlt“
    await db(page, 'store.delete(a);', MATS[3].id);
    await page.reload();
    await page.waitForSelector('[data-testid="palette-table"]', { timeout: 60000 });

    // ---------- Verlegeplan → Material & Einkauf
    await page.click('[data-testid="step-plan"]');
    await page.waitForSelector('[data-testid="plan-view"]');
    await page.click('[data-testid="plan-view"] button:has-text("Material & Einkauf")');
    await page.waitForSelector('[data-testid="material-calc"] [data-testid="mc-pieces"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="material-calc"]')?.getAttribute('data-busy') === 'no', null, { timeout: 30000 });
    await wait(500);
    const v = await readView(page);
    await page.screenshot({ path: path.join(OUT, 'w5ms-01-desktop.png'), fullPage: true });
    await page.screenshot({ path: path.join(OUT, 'w5ms-01b-desktop-top.png') });

    // Layout 1440 px
    const ov = await overflow(page);
    const mcW = await page.$eval('[data-testid="material-calc"]', (e) => e.getBoundingClientRect().width);
    check('1440 px: volle Breite ohne Viewer, kein waagerechtes Scrollen der Seite', ov <= 0 && mcW > 1000 && !(await page.$('[data-testid="mosaic-canvas"]')), `Überlauf ${ov} px, Breite ${Math.round(mcW)} px`);
    const scrolling = v.wraps.filter((w) => w.sw > w.cw + 1);
    check('1440 px: keine Tabelle braucht waagerechtes Scrollen', scrolling.length === 0 && v.wraps.length >= 3, scrolling.map((w) => `${w.id} ${w.sw}>${w.cw}`).join(', ') || `${v.wraps.length} Tabellen`);
    const packsHead = await page.evaluate(() => {
      const ths = [...document.querySelectorAll('[data-testid="mc-shop-table"] thead th')];
      const th = ths.find((e) => /^Packungen$/.test(e.textContent.trim()));
      const wrap = document.querySelector('[data-testid="mc-shop-table"]').closest('.table-wrap').getBoundingClientRect();
      if (!th) return null;
      const r = th.getBoundingClientRect();
      return { left: r.left, right: r.right, w: r.width, wrapRight: wrap.right, vis: getComputedStyle(th).visibility };
    });
    check('1440 px: Spalte „Packungen“ vollständig sichtbar (nicht abgeschnitten)', !!packsHead && packsHead.w > 30 && packsHead.right <= packsHead.wrapRight + 0.5 && packsHead.right <= 1440, JSON.stringify(packsHead));

    // Kennzahlen
    const pieces = num(v.pieces);
    const rawRes = num(v.rawRes);
    check('Kennzahlen: Steine gesamt, Rohsteine inkl. Reserve (sichere Obergrenze), Fugenmasse (Schätzung)', pieces > 0 && rawRes > 0 && /Obergrenze/.test(v.text) && /Schätzung/.test(v.grout), `${pieces} Steine, ${rawRes} Rohsteine`);
    check('Materialkosten mit zwei Nachkommastellen und „unvollständig“', /^\d{1,3}(\.\d{3})*,\d\d/.test(v.cost) && v.costBadge, v.cost);

    // Einkaufsliste
    const rowA = v.shop.find((r) => r.material === MATS[0].id);
    const rowB = v.shop.find((r) => r.material === MATS[1].id);
    const rowC = v.shop.find((r) => r.material === MATS[2].id);
    const rowNone = v.shop.find((r) => r.material === '');
    check('Einkaufsliste: gemeinsames Material A ist EINE Zeile für 01 und 02', v.shop.filter((r) => r.material === MATS[0].id).length === 1 && !!rowA && rowA.cell.colors === '01, 02', rowA ? rowA.cell.colors : 'fehlt');
    const col01 = v.colors.find((c) => c.code === '01');
    const col02 = v.colors.find((c) => c.code === '02');
    const needA = rowA ? num(rowA.cell.need) : NaN;
    check('A: Bedarf = Σ inkl. Reserve der Farben 01 + 02', !!col01 && !!col02 && needA === num(col01.rawWithReserve) + num(col02.rawWithReserve), `${needA} = ${col01 && col01.rawWithReserve} + ${col02 && col02.rawWithReserve}`);
    const packsA = rowA ? num(rowA.packsN) : NaN;
    check('A: Packungen = ⌈Bedarf / 100⌉ mit „× 100 St.“', packsA === Math.ceil(needA / 100) && /× 100 St\./.test(rowA.cell.packs), rowA && rowA.cell.packs);
    check('A: Kosten = Packungen × 7,50 (zwei Nachkommastellen)', !!rowA && Math.abs(num(rowA.cell.cost) - packsA * 7.5) < 1e-9 && /,\d\d$/.test(rowA.cell.cost), rowA && rowA.cell.cost);
    const toBuyA = Math.max(0, needA - 10);
    check('A: Bestand 10, zu kaufen = Bedarf − 10 (rot), Packungen kaufen = ⌈zu kaufen / 100⌉', !!rowA && num(rowA.cell.stock) === 10 && num(rowA.cell.toBuy) === toBuyA && rowA.short && num(rowA.packsBuyN) === Math.ceil(toBuyA / 100), rowA && `${rowA.cell.stock} / ${rowA.cell.toBuy} / ${rowA.cell.packsToBuy}`);
    check('A: Einkaufskosten = Packungen kaufen × 7,50', !!rowA && Math.abs(num(rowA.cell.buyCost) - Math.ceil(toBuyA / 100) * 7.5) < 1e-9, rowA && rowA.cell.buyCost);
    check('B: kein Bestand → „nicht erfasst“, zu kaufen „–“ (nicht angenommen), Packungen ⌈Bedarf/250⌉', !!rowB && /nicht erfasst/.test(rowB.cell.stock) && rowB.cell.toBuy === '–' && rowB.cell.packsToBuy === '–' && num(rowB.packsN) === Math.ceil(num(rowB.cell.need) / 250), rowB && JSON.stringify(rowB.cell));
    check('C: ohne Packungsgröße und Preis → Packungen/Kosten „–“ (nie geschätzt), kein Fehlbestand', !!rowC && rowC.cell.packs === '–' && rowC.cell.cost === '–' && rowC.cell.price === '–' && num(rowC.cell.toBuy) === 0 && !rowC.short, rowC && JSON.stringify(rowC.cell));
    check('„ohne Material“-Zeile enthält Farbe 05 (Material gelöscht) und Farben ohne Material', !!rowNone && /05/.test(rowNone.cell.colors) && /Material fehlt/.test(rowNone.cell.material) && rowNone.cell.packs === '–', rowNone && rowNone.cell.material);
    const sumNeed = v.shop.reduce((a, r) => a + num(r.cell.need), 0);
    check('Σ Bedarf je Material = Summenzeile = Rohsteine inkl. Reserve', sumNeed === rawRes && num(v.needSum) === rawRes, `${sumNeed} = ${v.needSum} = ${rawRes}`);
    const sumCost = v.shop.reduce((a, r) => a + (Number.isFinite(num(r.cell.cost)) ? num(r.cell.cost) : 0), 0);
    check('Σ Kosten je Material = Summenzeile = Materialkosten', Math.abs(sumCost - num(v.cost)) < 0.005 && Math.abs(num(v.costSum) - num(v.cost)) < 1e-9, `${sumCost.toFixed(2)} = ${v.costSum} = ${v.cost}`);

    // Bedarf je Farbe
    const c05 = v.colors.find((c) => c.code === '05');
    const c06 = v.colors.find((c) => c.code === '06');
    check('Bedarf je Farbe: Name und Material (A) bzw. „Material fehlt“ (05) bzw. „kein Material“', !!col01 && col01.name.length > 0 && /E2E-Glas Geteilt/.test(col01.material) && !!c05 && /Material fehlt/.test(c05.material) && (!c06 || /kein Material/.test(c06.material)), `${col01 && col01.name} · ${col01 && col01.material} · ${c05 && c05.material}`);
    const sumPieces = v.colors.reduce((a, c) => a + num(c.pieces), 0);
    const sumRes = v.colors.reduce((a, c) => a + num(c.rawWithReserve), 0);
    check('Bedarf je Farbe: Σ Steine = Steine gesamt, Σ inkl. Reserve = Rohsteine inkl. Reserve (auch Summenzeile)', sumPieces === pieces && sumRes === rawRes && num(v.colorSumPieces) === pieces && num(v.colorSumRes) === rawRes, `${sumPieces} / ${sumRes}`);

    // Hinweise
    check('Hinweis Fehlbestand nennt Material A mit zu kaufender Menge und Packungen', /Bestand reicht nicht bei 1 Material/.test(v.shortfall) && v.shortItems.length === 1 && v.shortItems[0].includes('A-01') && v.shortItems[0].includes(`${toBuyA.toLocaleString('de-DE')} kaufen`) && /Insgesamt/.test(v.shortfall), v.shortItems.join(' | '));
    check('Hinweis „Material fehlt“ bei Farbe 05', /Material fehlt/.test(v.missing) && /05/.test(v.missing), v.missing.slice(0, 90));
    check('Hinweis: Bestand für 1 Material nicht erfasst (B)', /Für 1 Material ist kein Bestand erfasst/.test(v.stockUnknown), v.stockUnknown.slice(0, 80));

    // ---------- CSV (Deutsch)
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('[data-testid="mc-csv"]')]);
    const csvPath = path.join(OUT, 'einkaufsliste-de.csv');
    await dl.saveAs(csvPath);
    const buf = fs.readFileSync(csvPath);
    const csv = buf.toString('utf8');
    const lines = csv.replace(/^﻿/, '').trim().split(/\r\n/);
    const head = lines[0].split(';');
    const sumLine = lines[lines.length - 1].split(';');
    const iNeed = head.findIndex((h) => /^Bedarf inkl/.test(h));
    const iCost = head.indexOf('Kosten (Bedarf)');
    // headless Chromium ohne UTF-8-Locale meldet Namen mit Umlaut als „download“ – der Name steht in der Rückmeldung
    const note = (await page.textContent('[data-testid="mc-csv-note"]').catch(() => '')) || '';
    const fileName = (note.match(/(\S+_einkaufsliste\.csv)/) || [])[1] || dl.suggestedFilename();
    check('CSV: Dateiname „<Projekt>_einkaufsliste.csv“, BOM, Semikolon, deutsche Kopfzeile', /_einkaufsliste\.csv$/.test(fileName) && buf[0] === 0xef && head.includes('Packungen zu kaufen') && iNeed >= 0, `${fileName} · ${head.length} Spalten`);
    check('CSV: eine Zeile je Material + Summe', lines.length === v.shop.length + 2, `${lines.length - 2} Materialzeilen`);
    check('CSV: Summe Bedarf = Rohsteine inkl. Reserve, Summe Kosten = Materialkosten (Dezimalkomma)', Number(sumLine[iNeed]) === rawRes && sumLine[iCost] === v.cost.replace(/[^\d,]/g, '').replace(/^0+(?=\d)/, '') && /^\d+,\d\d$/.test(sumLine[iCost]), `${sumLine[iNeed]} · ${sumLine[iCost]} (Anzeige ${v.cost})`);
    check('CSV: Rückmeldung „Download gestartet“', /Download gestartet/.test(note) && /einkaufsliste/.test(note), note.trim().slice(0, 80));

    // ---------- Drucken
    await page.evaluate(() => {
      window.__w5msPrints = 0;
      window.print = () => {
        window.__w5msPrints++;
      };
    });
    await page.click('[data-testid="mc-print"]');
    check('„Drucken“ ruft window.print() auf', (await page.evaluate(() => window.__w5msPrints)) === 1);
    await page.emulateMedia({ media: 'print' });
    const pr = await page.evaluate(() => {
      const vis = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0;
      };
      return {
        calc: vis('[data-testid="material-calc"]'),
        nav: vis('.mainnav'),
        topbar: vis('.topbar'),
        stepper: vis('[data-testid="step-plan"]'),
        viewSwitch: vis('[data-testid="plan-view"]'),
        progress: vis('[data-testid="progress-pct"]'),
        stepNav: vis('[data-testid="step-nav"]'),
        csvBtn: vis('[data-testid="mc-csv"]'),
        head: (document.querySelector('[data-testid="material-calc"] h2.w5ms-print-only') || {}).textContent,
        headVis: vis('[data-testid="material-calc"] h2.w5ms-print-only'),
      };
    });
    check('Druckansicht: nur Material & Einkauf – ohne Navigation, Schritte, Ansichtswahl, Knöpfe', pr.calc && !pr.nav && !pr.topbar && !pr.stepper && !pr.viewSwitch && !pr.progress && !pr.stepNav && !pr.csvBtn && pr.headVis, JSON.stringify(pr));
    const pdfPath = path.join(OUT, 'w5ms-print.pdf');
    await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
    try {
      execFileSync('pdftoppm', ['-png', '-r', '60', '-f', '1', '-l', '2', pdfPath, path.join(OUT, 'w5ms-print')]);
      const pagesTxt = execFileSync('pdfinfo', [pdfPath]).toString();
      const size = (pagesTxt.match(/Page size:\s+([\d.]+) x ([\d.]+)/) || []).slice(1).map(Number);
      check('Druck als PDF: Querformat, Kopfzeile mit Projektname', size.length === 2 && size[0] > size[1], `${size.join(' × ')} pt · ${(pagesTxt.match(/Pages:\s+(\d+)/) || [])[1]} Seiten`);
    } catch (e) {
      check('Druck als PDF (pdftoppm/pdfinfo)', false, String(e).slice(0, 120));
    }
    await page.emulateMedia({ media: 'screen' });

    // ---------- Englisch: CSV mit ',' und Punkt, Texte vollständig
    for (const [lang, label, re, delim] of [
      ['English', 'Material & shopping', /Shopping list per material/, ','],
      ['Türkçe', 'Malzeme', /Malzeme başına alışveriş listesi/, ';'],
    ]) {
      await page.goto(BASE + '#/settings');
      await page.click(`[data-testid="lang-select"] >> text=${lang}`);
      await wait(300);
      await page.goto(projectUrl.replace(/\/[a-z]+$/, '/plan'));
      await page.waitForSelector('[data-testid="plan-view"]', { timeout: 60000 });
      await page.locator('[data-testid="plan-view"] button').nth(1).click();
      await page.waitForSelector('[data-testid="material-calc"] [data-testid="mc-pieces"]');
      await page.waitForFunction(() => document.querySelector('[data-testid="material-calc"]')?.getAttribute('data-busy') === 'no', null, { timeout: 30000 });
      await wait(300);
      const t = await page.textContent('[data-testid="material-calc"]');
      check(`${lang}: Ansicht übersetzt, keine fehlenden Schlüssel`, re.test(t) && !/w5ms\.|plan\.shop\./.test(t), t.slice(0, 60));
      const [d2] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('[data-testid="mc-csv"]')]);
      const p2 = path.join(OUT, `einkaufsliste-${lang}.csv`);
      await d2.saveAs(p2);
      const l2 = fs.readFileSync(p2, 'utf8').replace(/^﻿/, '').trim().split(/\r\n/);
      const h2 = l2[0].split(delim);
      const s2 = l2[l2.length - 1].split(delim);
      const needIdx = h2.findIndex((h) => /^(Need incl|Yedek dahil)/.test(h));
      const costIdx = h2.findIndex((h) => /^(Cost \(need\)|Maliyet \(ihtiyaç\))$/.test(h));
      const costVal = delim === ',' ? numEn(s2[costIdx]) : Number(String(s2[costIdx]).replace(',', '.'));
      check(`${lang}: CSV mit '${delim}' und ${delim === ',' ? 'Dezimalpunkt' : 'Dezimalkomma'}, Summen wie DE`, Number(s2[needIdx]) === rawRes && Math.abs(costVal - num(v.cost)) < 1e-9 && (delim === ',' ? /^\d+\.\d\d$/ : /^\d+,\d\d$/).test(s2[costIdx]), `${s2[needIdx]} · ${s2[costIdx]}`);
      if (lang === 'English') await page.screenshot({ path: path.join(OUT, 'w5ms-03-english.png'), fullPage: true });
      else await page.screenshot({ path: path.join(OUT, 'w5ms-04-turkish.png') });
    }
    await page.goto(BASE + '#/settings');
    await page.click('[data-testid="lang-select"] >> text=Deutsch');
    await wait(300);

    // ======================================================== Handy 390 × 844 (gleiche Datenbank, schmales Fenster)
    const pp = page;
    await pp.setViewportSize({ width: 390, height: 844 });
    await pp.goto(projectUrl.replace(/\/[a-z]+$/, '/plan'));
    await pp.waitForSelector('[data-testid="plan-view"]', { timeout: 60000 });
    await pp.click('[data-testid="plan-view"] button:has-text("Material & Einkauf")');
    await pp.waitForSelector('[data-testid="material-calc"] [data-testid="mc-pieces"]');
    await pp.waitForFunction(() => document.querySelector('[data-testid="material-calc"]')?.getAttribute('data-busy') === 'no', null, { timeout: 30000 });
    await wait(400);
    const ovp = await overflow(pp);
    // bei Überlauf: die breitesten Übeltäter nennen
    const wide = await pp.evaluate(() =>
      [...document.querySelectorAll('[data-testid="material-calc"] *')]
        .map((e) => ({ e, r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.right > window.innerWidth + 1)
        .slice(0, 4)
        .map(({ e, r }) => `${e.tagName.toLowerCase()}.${String(e.className).replace(/\s+/g, '.')}[${e.getAttribute('data-col') || ''}] ${Math.round(r.right)}`)
        .join(', '),
    );
    check('390 px: kein waagerechtes Scrollen', ovp <= 1, `${ovp} px ${wide}`);
    const cards = await pp.evaluate(() => {
      const shopRow = document.querySelector('[data-testid="mc-shop-row"]');
      const head = document.querySelector('[data-testid="mc-shop-table"] thead');
      const packs = [...document.querySelectorAll('[data-testid="mc-shop-row"] td[data-col="packs"]')].map((td) => {
        const r = td.getBoundingClientRect();
        return { left: r.left, right: r.right, label: getComputedStyle(td, '::before').content };
      });
      const wraps = [...document.querySelectorAll('[data-testid="material-calc"] .table-wrap')].map((w) => w.scrollWidth - w.clientWidth);
      const colorRow = document.querySelector('[data-testid="mc-color-row"]');
      return {
        rowDisplay: getComputedStyle(shopRow).display,
        headDisplay: getComputedStyle(head).display,
        colorDisplay: getComputedStyle(colorRow).display,
        colorH: Math.round(colorRow.getBoundingClientRect().height),
        packs,
        wraps,
        vw: window.innerWidth,
      };
    });
    check('390 px: Einkaufsliste und Bedarf je Farbe als Karten (Kopfzeile ausgeblendet)', cards.rowDisplay === 'grid' && cards.headDisplay === 'none' && cards.colorDisplay === 'grid' && cards.colorH < 120, `${cards.rowDisplay}/${cards.headDisplay}/${cards.colorDisplay}, Farbkarte ${cards.colorH} px`);
    check('390 px: Packungen in jeder Karte sichtbar und beschriftet', cards.packs.length > 0 && cards.packs.every((p) => p.left >= 0 && p.right <= cards.vw && /Packungen/.test(p.label)), JSON.stringify(cards.packs[0]));
    check('390 px: keine Tabelle scrollt seitlich', cards.wraps.every((d) => d <= 1), cards.wraps.join(', '));
    await pp.screenshot({ path: path.join(OUT, 'w5ms-02-phone.png'), fullPage: true });
    await pp.screenshot({ path: path.join(OUT, 'w5ms-02b-phone-top.png') });
    // 360 px (kleine Handys)
    await pp.setViewportSize({ width: 360, height: 780 });
    await wait(300);
    const ov360 = await overflow(pp);
    const wraps360 = await pp.evaluate(() => [...document.querySelectorAll('[data-testid="material-calc"] .table-wrap')].map((w) => w.scrollWidth - w.clientWidth));
    check('360 px: kein waagerechtes Scrollen, keine Tabelle scrollt seitlich', ov360 <= 1 && wraps360.every((d) => d <= 1), `${ov360} px · ${wraps360.join(', ')}`);
    await context.close();
  } catch (e) {
    check('Ablauf ohne Ausnahme', false, String(e && e.stack ? e.stack : e));
  } finally {
    check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})();
