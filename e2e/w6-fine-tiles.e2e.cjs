/* Browser-Test w6-fine-tiles: Feinstein-Größe (Schritt 6), Feinbereich über den Augen zeichnen und berechnen (≥ 50 %
 * Feinsteine, exakt gezählt), Feinstein-Material je Farbe automatisch zuordnen (Schritt 5), Gesamtzahl unverändert,
 * eigene Einkaufszeilen (Schritt 9), Zuordnung bleibt über eine Neuberechnung, Sprachen, Handy-Layout.
 * Aufruf: node e2e/w6-fine-tiles.e2e.cjs <baseUrl> <outDir>   (vorher: npm run build && npx vite preview)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output', 'w6-fine-tiles');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const num = (s) => parseInt(String(s ?? '').replace(/\./g, '').match(/\d+/)?.[0] ?? 'NaN', 10);

/** Projekt aus IndexedDB (Palette, Bereiche, Einstellungen) */
async function readProject(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const id = (location.hash.match(/#\/project\/([^/]+)/) || [])[1];
        const rq = indexedDB.open('mosaicplan');
        rq.onerror = () => reject(rq.error);
        rq.onsuccess = () => {
          const db = rq.result;
          const g = db.transaction(['projects'], 'readonly').objectStore('projects').get(id);
          g.onsuccess = () => {
            const p = g.result;
            resolve(p ? { regions: p.regions, settings: p.settings, palette: p.palette } : null);
            db.close();
          };
          g.onerror = () => reject(g.error);
        };
      }),
  );
}

/** Materialien direkt in die lokale Datenbank legen */
async function putMaterials(page, list) {
  await page.evaluate(
    (mats) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('mosaicplan');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('materials', 'readwrite');
          for (const m of mats) tx.objectStore('materials').put(m, m.id);
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    list,
  );
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());

  /** Berechnen (bzw. passende Vorschau übernehmen) */
  const compute = async () => {
    await page.click('[data-testid="step-compute"]');
    await page.waitForSelector('[data-testid="compute-btn"]', { timeout: 60000 });
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="recompute-guard"], [data-testid="mosaic-canvas"]', { timeout: 120000 });
    if (await page.isVisible('[data-testid="recompute-guard"]')) await page.click('[data-testid="guard-nobackup"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
    await page.waitForTimeout(600);
  };
  const noHScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  await page.goto(BASE);
  await page.waitForSelector('[data-testid="sample-portrait"]');
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"], [data-testid="step-shapes"]');
  const projUrl = page.url().replace(/\/[a-z]+$/, '');

  // ================================================================ Schritt 6: Feinstein-Größe (ohne Materialien)
  await page.click('[data-testid="step-shapes"]');
  await page.waitForSelector('[data-testid="fine-size"]');
  await page.waitForTimeout(300);
  const k2 = await page.textContent('[data-testid="fine-size-k2"]');
  const k3 = await page.textContent('[data-testid="fine-size-k3"]');
  check('Feinstein-Größe statt k: 2 × 2 → 2 × 2 mm, exakte Größe, ohne Material „aus dem Grundstein geschnitten“', /2 × 2 mm/.test(k2) && /exakte Größe · kein Material in dieser Größe/.test(k2) && /aus dem Grundstein geschnitten/.test(k2), k2);
  check('3 × 3 → 1 × 1 mm: schmaler als die Mindestbreite (ehrlich, keine Teilung)', /1 × 1 mm/.test(k3) && /schmaler als die Mindestbreite/.test(k3), k3);
  check('Auswahl als Optionsgruppe (role=radio, aria-checked)', (await page.getAttribute('[data-testid="fine-size-k2"]', 'aria-checked')) === 'true' && (await page.getAttribute('[data-testid="fine-size-k3"]', 'aria-checked')) === 'false');
  check('Schalter „Feinere Steine in Gesichts- und Detailbereichen bevorzugen“ (aus)', !(await page.$eval('[data-testid="prefer-sub"]', (e) => e.checked)));
  check('Feinbereiche: Erklärung mit Teilsteinmaß und „Noch kein Feinbereich markiert.“', /2 × 2-Feinsteine \(2 × 2 mm\)/.test(await page.textContent('[data-testid="fine-regions"]')) && /Noch kein Feinbereich/.test(await page.textContent('[data-testid="fine-regions-count"]')));
  // k = 2 bewusst wählen: speichert die exakte Feinsteingröße
  await page.click('[data-testid="fine-size-k2"]');
  await page.waitForTimeout(400);
  let pr = await readProject(page);
  check('Gewählte Feinsteingröße gespeichert (fineTileMm = 2, subdivK = 2)', pr.settings.shapes.fineTileMm === 2 && pr.settings.shapes.subdivK === 2, JSON.stringify({ f: pr.settings.shapes.fineTileMm, k: pr.settings.shapes.subdivK }));

  // ================================================================ Feinbereich über den Augen zeichnen
  const types = await page.$$eval('[data-testid="region-type"] button', (b) => b.map((x) => x.textContent.trim()));
  check('Bereichswerkzeug bietet „Feinbereich“ neben Gesicht/Detail', types.join('|') === 'Gesicht|Detail|Feinbereich', types.join('|'));
  await page.click('[data-testid="region-type"] button:has-text("Feinbereich")');
  await page.click('[data-testid="region-shape"] button:nth-child(2)'); // Rechteck
  await page.evaluate(() => document.querySelector('[data-testid="region-holder"]').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  const hb = await (await page.$('[data-testid="region-holder"]')).boundingBox();
  // Augenpartie des Porträts: x 33–67 %, y 38–48 %
  await page.mouse.move(hb.x + hb.width * 0.33, hb.y + hb.height * 0.38);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width * 0.67, hb.y + hb.height * 0.48, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  pr = await readProject(page);
  const fineReg = pr.regions.filter((r) => r.type === 'fine');
  check('Feinbereich angelegt (Region type „fine“, Rechteck)', fineReg.length === 1 && fineReg[0].shape === 'rect', JSON.stringify(fineReg[0] || {}));
  check('Feinbereich auf dem Bild in eigener Farbe (region-fine) und in der Liste „Feinbereich“', (await page.$$('[data-testid="region-overlay"].region-fine')).length === 1 && /Feinbereich/.test(await page.textContent('[data-testid="region-list"]')));
  check('Zähler „1 Feinbereich markiert.“', /1 Feinbereich markiert/.test(await page.textContent('[data-testid="fine-regions-count"]')));
  await page.locator('[data-testid="fine-size"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'w6ft-01-shapes-desktop.png') });
  await page.locator('[data-testid="region-holder"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'w6ft-02-region-desktop.png') });

  // ================================================================ Berechnen: Feinsteine im Feinbereich
  await compute();
  await page.click('[data-testid="step-shapes"]');
  await page.waitForSelector('[data-testid="fine-regions-result"]', { timeout: 30000 });
  const res = await page.$eval('[data-testid="fine-regions-result"]', (e) => ({ cells: +e.dataset.cells, sub: +e.dataset.sub, tooSmall: +e.dataset.toosmall, notFine: +(e.dataset.notfine || 0), text: e.textContent }));
  // Korrekturen Welle 6: gekürzte Randsteine im Feinbereich werden nicht als Feinsteine erzwungen/gezählt (notFine)
  check(
    'Ergebnis: ≥ 50 % der Zellen im Feinbereich sind 2 × 2-Feinsteine (exakt gezählt; gekürzte Randsteine eigens)',
    res.cells > 10 && res.sub / res.cells >= 0.5 && res.sub + res.tooSmall + res.notFine === res.cells && (res.notFine === 0 || /gekürzte/.test(res.text)),
    `${res.sub} von ${res.cells}, ${res.notFine} gekürzt – ${res.text.trim()}`,
  );
  await page.locator('[data-testid="fine-regions-result"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'w6ft-03-result.png') });

  // Gesamtzahl der Steine vor der Feinstein-Zuordnung (Schritt 9 · Material & Einkauf)
  const readPieces = async () => {
    await page.click('[data-testid="step-plan"]');
    await page.waitForSelector('[data-testid="progress-pct"]');
    await page.click('text=Material >> nth=-1');
    await page.waitForSelector('[data-testid="material-calc"]');
    await page.waitForTimeout(2000);
    return num(await page.textContent('[data-testid="mc-pieces"]'));
  };
  const pieces0 = await readPieces();

  // ================================================================ Feinstein-Materialien 2 × 2 mm in den Palettenfarben
  pr = await readProject(page);
  const fineMats = pr.palette.map((p, i) => ({
    id: `w6ft-${i}`,
    type: 'glass',
    manufacturer: 'Fein',
    product: 'Mini',
    colorNumber: `F${i + 1}`,
    colorName: `Fein ${p.hex}`,
    hex: p.hex,
    lengthMm: 2,
    widthMm: 2,
    thicknessMm: 3,
    price: 4,
    packageSize: 'Beutel',
    piecesPerPack: 500,
    notes: '',
  }));
  await putMaterials(page, fineMats);
  await page.reload();
  await page.goto(projUrl + '/shapes');
  await page.waitForSelector('[data-testid="fine-size-k2"]');
  await page.waitForTimeout(500);
  const k2b = await page.textContent('[data-testid="fine-size-k2"]');
  check(`Schritt 6 zählt die Materialien in Feinsteingröße („${fineMats.length} Materialien in dieser Größe“)`, new RegExp(`exakte Größe · ${fineMats.length} Materialien in dieser Größe`).test(k2b), k2b);

  // ================================================================ Schritt 5: Feinstein-Material automatisch zuordnen
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="fine-box"]');
  const boxTxt = await page.textContent('[data-testid="fine-box"]');
  check('Schritt 5: Kasten „Feinsteine 2 × 2 mm (2 × 2 je Rasterstein)“ mit Erklärung', /Feinsteine 2 × 2 mm \(2 × 2 je Rasterstein\)/.test(boxTxt) && /nicht geschnitten/.test(boxTxt), boxTxt.slice(0, 80));
  await page.waitForSelector('[data-testid="fine-stats"][data-busy="0"]', { timeout: 30000 });
  const st0 = await page.$eval('[data-testid="fine-stats"]', (e) => ({ sub: +e.dataset.sub, fine: e.dataset.fine === '' ? NaN : +e.dataset.fine, text: e.textContent }));
  check('Vor der Zuordnung: alle Teilsteine aus dem Grundstein-Material (0 Feinsteine)', st0.sub > 0 && st0.fine === 0, st0.text);
  const nFineSel = await page.locator('[data-testid="palette-fine-material"]').count();
  check('Je Farbe eine zweite Auswahl „Feinstein“ (nur Materialien in 2 × 2 mm)', nFineSel === pr.palette.length, `${nFineSel} von ${pr.palette.length}`);
  const opts = await page.locator('[data-testid="palette-fine-material"]').first().locator('option').count();
  check('Feinstein-Auswahl: „– aus Grundstein –“ + nur die Feinstein-Materialien', opts === fineMats.length + 1, String(opts));
  await page.click('[data-testid="fine-auto"]');
  await page.waitForTimeout(600);
  const notice = await page.textContent('[data-testid="palette-notice"]');
  check('„Feinstein-Material automatisch zuordnen“ ordnet jeder Farbe ihr Material zu (ΔE00 0)', new RegExp(`${pr.palette.length} Farben ein Feinstein-Material zugeordnet`).test(notice), notice);
  pr = await readProject(page);
  check('Palette gespeichert mit fineMaterialId je Farbe', pr.palette.every((p, i) => p.fineMaterialId === `w6ft-${i}`));
  await page.waitForSelector('[data-testid="fine-stats"][data-busy="0"]', { timeout: 30000 });
  await page.waitForFunction(() => +document.querySelector('[data-testid="fine-stats"]').dataset.fine > 0, null, { timeout: 30000 });
  const st1 = await page.$eval('[data-testid="fine-stats"]', (e) => ({ sub: +e.dataset.sub, fine: +e.dataset.fine, text: e.textContent }));
  check('Danach: ganze Feinsteine (ungeschnitten) gezählt, Rest aus dem Grundstein-Material; Teilsteine gleich viele', st1.sub === st0.sub && st1.fine > 0 && st1.fine <= st1.sub && /ganze Feinsteine \(ungeschnitten\)/.test(st1.text), st1.text);
  const needs = await page.locator('[data-testid="palette-fine-need"]').count();
  check('Bedarfsspalte zeigt „+ N Fein“ bei Farben mit Feinsteinen', needs > 0, String(needs));
  await page.locator('[data-testid="fine-box"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'w6ft-04-colors-desktop.png') });
  await page.locator('[data-testid="palette-fine-need"]').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'w6ft-05-colors-table.png') });

  // ================================================================ Schritt 9: Gesamtzahl unverändert, eigene Einkaufszeilen
  const pieces1 = await readPieces();
  check('Gesamtzahl der Steine unverändert durch die Feinstein-Zuordnung', pieces0 > 0 && pieces1 === pieces0, `${pieces0} → ${pieces1}`);
  const shopFine = await page.$$eval('[data-testid="mc-shop-row"]', (rows) => rows.filter((r) => (r.getAttribute('data-material') || '').startsWith('w6ft-')).map((r) => r.textContent));
  check('Einkaufsliste: eigene Zeilen für Feinstein-Materialien (2 × 2 mm, ohne „Rastermaß angenommen“-Stern)', shopFine.length > 0 && shopFine.every((t) => /2(,0)? × 2(,0)? mm(?! \*)/.test(t)), `${shopFine.length} Zeilen – ${(shopFine[0] || '').slice(0, 120)}`);
  await page.locator('[data-testid="mc-shop-row"][data-material^="w6ft-"]').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'w6ft-06-shopping.png') });

  // ================================================================ Neuberechnung: Zuordnung bleibt (gleiche Farben)
  await page.click('[data-testid="step-shapes"]');
  await page.waitForSelector('[data-testid="prefer-sub"]', { state: 'attached' });
  await page.click('label.toggle:has([data-testid="prefer-sub"]) .toggle-track');
  await page.waitForTimeout(300);
  pr = await readProject(page);
  check('„Feinere Steine … bevorzugen“ eingeschaltet und gespeichert', pr.settings.shapes.preferSubInRegions === true);
  await compute();
  await page.waitForTimeout(800);
  pr = await readProject(page);
  const kept = pr.palette.filter((p) => p.fineMaterialId).length;
  const sameHex = pr.palette.filter((p) => fineMats.some((m) => m.hex.toUpperCase() === p.hex.toUpperCase())).length;
  check('Nach der Neuberechnung: Feinstein-Material bleibt bei gleicher Farbe erhalten', sameHex > 0 && kept === sameHex, `${kept} zugeordnet, ${sameHex} gleiche Farben`);

  // ================================================================ Sprachen
  for (const [label, reSize, reFine] of [
    ['English', /Fine-tile size/, /Fine tiles 2 × 2 mm/],
    ['Türkçe', /İnce taş boyutu/, /İnce taşlar 2 × 2 mm/],
  ]) {
    await page.goto(BASE + '#/settings');
    await page.click(`[data-testid="lang-select"] >> text=${label}`);
    await page.waitForTimeout(300);
    await page.goto(projUrl + '/shapes');
    await page.waitForSelector('[data-testid="fine-size"]');
    const s = await page.textContent('.w6ft-field');
    const r = await page.textContent('[data-testid="fine-regions"]');
    await page.goto(projUrl + '/colors');
    await page.waitForSelector('[data-testid="fine-box"]');
    const c = await page.textContent('[data-testid="fine-box"]');
    check(`${label}: Feinstein-Texte übersetzt (keine Schlüssel)`, reSize.test(s) && reFine.test(c) && !/w6ft\./.test(s + r + c), `${s.slice(0, 40)} | ${c.slice(0, 40)}`);
    await page.screenshot({ path: path.join(OUT, `w6ft-07-colors-${label === 'English' ? 'en' : 'tr'}.png`) });
  }
  await page.goto(BASE + '#/settings');
  await page.click('[data-testid="lang-select"] >> text=Deutsch');
  await page.waitForTimeout(300);
  await context.close();

  // ================================================================ Handy 390 × 844
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  // dieselbe Datenbank gibt es im neuen Kontext nicht – Projekt neu anlegen
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => errors.push(String(e)));
  await pp.goto(BASE);
  await pp.waitForSelector('[data-testid="sample-portrait"]');
  await putMaterials(pp, fineMats.slice(0, 6));
  await pp.reload();
  await pp.waitForSelector('[data-testid="sample-portrait"]');
  await pp.click('[data-testid="sample-portrait"]');
  await pp.waitForSelector('[data-testid="step-shapes"], [data-testid="compute-btn"]');
  const purl = pp.url().replace(/\/[a-z]+$/, '');
  await pp.goto(purl + '/shapes');
  await pp.waitForSelector('[data-testid="fine-size"]');
  await pp.locator('[data-testid="fine-size"]').scrollIntoViewIfNeeded();
  await pp.waitForTimeout(300);
  const sizeBox = await (await pp.$('[data-testid="fine-size-k2"]')).boundingBox();
  check('Handy: Feinstein-Größe ohne horizontales Scrollen, Optionen ≥ 44 px hoch', (await noHScroll(pp)) && sizeBox.height >= 44, `${Math.round(sizeBox.height)} px`);
  await pp.screenshot({ path: path.join(OUT, 'w6ft-08-shapes-phone.png') });
  await pp.locator('[data-testid="fine-regions"]').scrollIntoViewIfNeeded();
  await pp.screenshot({ path: path.join(OUT, 'w6ft-09-regions-phone.png') });
  await pp.click('[data-testid="step-compute"]');
  await pp.waitForSelector('[data-testid="compute-btn"]', { timeout: 60000 });
  await pp.click('[data-testid="compute-btn"]');
  await pp.waitForSelector('[data-testid="recompute-guard"], [data-testid="mosaic-canvas"]', { timeout: 120000 });
  if (await pp.isVisible('[data-testid="recompute-guard"]')) await pp.click('[data-testid="guard-nobackup"]');
  await pp.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
  await pp.goto(purl + '/colors');
  await pp.waitForSelector('[data-testid="fine-box"]');
  await pp.locator('[data-testid="fine-box"]').scrollIntoViewIfNeeded();
  await pp.waitForTimeout(300);
  check('Handy: Schritt 5 Feinstein-Kasten ohne horizontales Scrollen', await noHScroll(pp));
  await pp.screenshot({ path: path.join(OUT, 'w6ft-10-colors-phone.png') });
  await pp.click('[data-testid="fine-auto"]');
  await pp.waitForTimeout(500);
  await pp.locator('[data-testid="palette-fine-material"]').first().scrollIntoViewIfNeeded();
  await pp.screenshot({ path: path.join(OUT, 'w6ft-11-colors-table-phone.png') });
  await phone.close();

  const relevant = errors.filter((e) => !/favicon|ResizeObserver/.test(e));
  check('keine Seitenfehler', relevant.length === 0, relevant.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
