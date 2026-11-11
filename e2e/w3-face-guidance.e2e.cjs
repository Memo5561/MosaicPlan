/* w3-face-guidance: Steine über das Gesicht (Detailgrad), Vergleichstabelle mit „Übernehmen“, übersetzte
 * Rasterfehler, ehrlicher Hinweis zu gemischten Steingrößen und sicheres Zeichnen von Bereichen am Handy.
 * Voraussetzung: `npm run build` und `npx vite preview --port <port>` laufen.
 * Aufruf: node e2e/w3-face-guidance.e2e.cjs <baseUrl> <outDir>
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w3-face-guidance');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

const digits = (s) => Number(String(s || '').replace(/[^\d]/g, ''));

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
            resolve(p ? { regions: p.regions, settings: p.settings, computedWith: !!p.computedWith } : null);
            db.close();
          };
          g.onerror = () => reject(g.error);
        };
      }),
  );
}

async function gotoStep(page, step) {
  await page.click(`[data-testid="step-${step}"]`);
  await page.waitForTimeout(300);
}

async function openSample(page, key) {
  await page.goto(BASE);
  await page.waitForSelector(`[data-testid="sample-${key}"]`);
  await page.click(`[data-testid="sample-${key}"]`);
  await page.waitForSelector('[data-testid="compute-btn"]', { timeout: 30000 });
  await page.waitForTimeout(400);
}

/** Fingerzug über CDP (echte Touch-Ereignisse → Pointer Events mit pointerType 'touch') */
async function touchDrag(cdp, page, x0, y0, dx, dy, steps = 12, end = 'touchEnd') {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * i) / steps, y: y0 + (dy * i) / steps, id: 1 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: end, touchPoints: [] });
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // ================================================================ Desktop
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // ---------- Porträt (Beispiel mit Gesichtsbereich x 0,27 / w 0,46 bei 400 mm, 5-mm-Steinen)
  await openSample(page, 'portrait');
  await gotoStep(page, 'size');
  await page.waitForSelector('[data-testid="detail-meter"]');
  const meter = await page.$eval('[data-testid="detail-meter"]', (e) => ({ light: e.getAttribute('data-light'), text: e.textContent }));
  const faceCols = Number(await page.getAttribute('[data-testid="face-span"]', 'data-cols'));
  check('Detailgrad: Gesicht ≈ 31 Steine quer bei 40 cm / 5 mm (exakt aus dem Raster), Ampel grün, als Richtwert beschriftet', faceCols === 31 && meter.light === 'green' && /Richtwert/.test(meter.text), `${faceCols} · ${meter.light} · ${meter.text.slice(0, 90)}`);
  await page.screenshot({ path: path.join(OUT, '01-size-detail-tradeoff.png'), fullPage: true });

  // Vergleichstabelle: Zeilen und exakte Werte
  const rows = await page.$$eval('[data-testid="tradeoff"] tbody tr', (trs) => trs.map((tr) => ({ id: tr.getAttribute('data-testid'), cells: tr.getAttribute('data-cells'), text: tr.textContent })));
  check(
    'Vergleichstabelle: aktuell, 4/6/8/10/12 mm und Größe × 1,5 / × 2',
    ['to-current', 'to-tile-4', 'to-tile-6', 'to-tile-8', 'to-tile-10', 'to-tile-12', 'to-width-1.5', 'to-width-2'].every((k) => rows.some((r) => r.id === k)) && !rows.some((r) => r.id === 'to-tile-5'),
    rows.map((r) => `${r.id}:${r.cells}`).join(' '),
  );
  const curPositions = digits(await page.textContent('[data-testid="grid-positions"]'));
  check('Zeile „aktuell“ = angezeigte Rasterpositionen', digits(rows.find((r) => r.id === 'to-current').cells) === curPositions, `${curPositions}`);
  const flagged4 = rows.find((r) => r.id === 'to-tile-4').text;
  check('Rote Ampel für 12-mm-Steine (Gesicht < 16 Steine)', (await page.getAttribute('[data-testid="to-tile-12"] .w3fg-face-cell', 'data-light')) === 'red', flagged4.slice(0, 60));

  // „Übernehmen“ ohne berechnetes Mosaik: sofort, keine Rückfrage
  const want6 = digits(await page.getAttribute('[data-testid="to-tile-6"]', 'data-cells'));
  await page.click('[data-testid="to-apply-tile-6"]');
  await page.waitForTimeout(400);
  const got6 = digits(await page.textContent('[data-testid="grid-positions"]'));
  const p6 = await readProject(page);
  check('„Übernehmen“ 6 mm: Rasterpositionen = computeLayout-Wert der Zeile, Einstellung gespeichert', got6 === want6 && p6.settings.tileW === 6 && p6.settings.tileH === 6, `${want6} → ${got6}, tile ${p6.settings.tileW}`);
  check('Kein Bestätigungsdialog ohne berechnetes Mosaik', !(await page.$('[data-testid="to-confirm"]')));
  const w0 = (await readProject(page)).settings;
  const want2 = digits(await page.getAttribute('[data-testid="to-width-2"]', 'data-cells'));
  await page.click('[data-testid="to-apply-width-2"]');
  await page.waitForTimeout(400);
  const w1 = (await readProject(page)).settings;
  const got2 = digits(await page.textContent('[data-testid="grid-positions"]'));
  check('„Übernehmen“ Größe × 2: Breite UND Höhe verdoppelt (Seitenverhältnis bleibt), Positionen wie angekündigt', Math.abs(w1.widthMm - 2 * w0.widthMm) < 1e-6 && Math.abs(w1.heightMm - 2 * w0.heightMm) < 1e-6 && got2 === want2, `${w0.widthMm}×${w0.heightMm} → ${w1.widthMm}×${w1.heightMm}, ${got2}`);
  const wInput = await page.inputValue('[data-testid="width-input"]');
  check('Breitenfeld zeigt die neue Breite', Math.abs(parseFloat(wInput.replace(',', '.')) * 10 - w1.widthMm) < 0.01, wInput);
  // zurück auf die Ausgangsgröße (über die Eingabefelder) und 5 mm
  await page.fill('[data-testid="width-input"]', String(w0.widthMm / 10).replace('.', ','));
  await page.locator('[data-testid="width-input"]').blur();
  await page.fill('[data-testid="height-input"]', String(w0.heightMm / 10).replace('.', ','));
  await page.locator('[data-testid="height-input"]').blur();
  await page.waitForTimeout(200);

  // ---------- Steingröße: ehrlicher Hinweis zu gemischten Steingrößen
  await gotoStep(page, 'tiles');
  await page.click('[data-testid="tile-presets"] >> text=5 × 5 mm');
  await page.waitForTimeout(300);
  const mixed = await page.textContent('[data-testid="mixed-sizes"]');
  check('Gemischte Steingrößen: Abzeichen „unvollständig“ + „Zonen mit eigenem Raster fehlen noch“', (await page.$('[data-testid="mixed-sizes"] .badge-incomplete')) && /Zonen mit eigenem Raster fehlen noch/.test(mixed), mixed.slice(0, 80));
  const sub = await page.textContent('[data-testid="sub-sizes"]');
  check('Teilsteingröße berechnet angezeigt (5 mm, 1 mm Fuge: 2×2 → 2 mm, 3×3 → 1 mm)', /2×2 → 2 × 2 mm/.test(sub) && /3×3 → 1 × 1 mm/.test(sub), sub);
  check('Vergleichstabelle auch im Schritt Steingröße', await page.isVisible('[data-testid="tradeoff"]'));
  await page.screenshot({ path: path.join(OUT, '02-tiles.png'), fullPage: true });

  // ---------- Berechnen, dann „Übernehmen“ nur nach Rückfrage
  await gotoStep(page, 'compute');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
  await page.waitForTimeout(800);
  await gotoStep(page, 'size');
  await page.click('[data-testid="to-apply-tile-8"]');
  await page.waitForSelector('[data-testid="to-confirm"]');
  const dlg = await page.textContent('.modal');
  check('Nach dem Berechnen: Rückfrage vor dem Übernehmen (nennt Neuberechnung, Mosaik bleibt bis dahin)', /neu berechnet/.test(dlg) && /unverändert/.test(dlg), dlg.slice(0, 160));
  await page.screenshot({ path: path.join(OUT, '03-confirm.png') });
  await page.click('[data-testid="to-confirm-cancel"]');
  await page.waitForTimeout(400);
  check('Abbrechen ändert nichts', (await readProject(page)).settings.tileW === 5 && !(await page.$('.modal')));
  await page.click('[data-testid="to-apply-tile-8"]');
  await page.waitForSelector('[data-testid="to-confirm"]');
  await page.click('[data-testid="to-confirm"]');
  await page.waitForTimeout(500);
  check('Bestätigen übernimmt die Einstellung (Mosaik gilt als geändert)', (await readProject(page)).settings.tileW === 8 && (await page.$('[data-testid="stale-badge"]')) !== null);
  // zurück auf 5 mm (Rückfrage erneut bestätigen)
  await page.click('[data-testid="to-apply-tile-5"]');
  await page.waitForSelector('[data-testid="to-confirm"]');
  await page.click('[data-testid="to-confirm"]');
  await page.waitForTimeout(300);

  // ---------- Steinformen am Desktop: Maus zeichnet direkt; Hinweis „Bereiche geändert“
  await gotoStep(page, 'shapes');
  await page.waitForSelector('[data-testid="region-holder"] canvas');
  // seit w4-face-detector gibt es die Offline-Erkennung immer; mit vorhandenem Gesichtsbereich sucht sie nicht von selbst
  check('„Gesichter erkennen“ vorhanden (Offline-Erkennung), mit Gesichtsbereich kein automatischer Vorschlag', (await page.$('[data-testid="detect-faces"]')) !== null && (await page.$('[data-testid="face-suggestion-card"]')) === null);
  check('Mit Gesichtsbereich: keine Karte „Gesicht von Hand markieren“', (await page.$('[data-testid="face-manual-card"]')) === null);
  const spanList = Number(await page.getAttribute('[data-testid="region-face-span"]', 'data-cols'));
  check('Liste: Gesicht 1 zeigt dieselbe Steinzahl wie der Detailgrad', spanList === 31, String(spanList));
  const labels = await page.$$eval('[data-testid="region-overlay"] .w3fg-num', (l) => l.map((e) => e.textContent));
  check('Bereich trägt seine Nummer auf dem Bild', labels.join(',') === '1', labels.join(','));
  const delBox = await (await page.$('.w3fg-del')).boundingBox();
  check('Löschen-Knopf mindestens 44 × 44 px', delBox.width >= 44 && delBox.height >= 44, `${delBox.width}×${delBox.height}`);
  const holderBox = async () => {
    // mittig, damit die (am Desktop klebende) Schrittleiste die Zeichenfläche nicht verdeckt
    await page.evaluate(() => document.querySelector('[data-testid="region-holder"]').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(150);
    return (await page.$('[data-testid="region-holder"]')).boundingBox();
  };
  const msgText = async () => {
    const el = await page.$('[data-testid="region-msg"]');
    return el ? (await el.textContent()) || '' : '';
  };
  let hb = await holderBox();
  const midY = Math.max(hb.y, 0) + Math.min(hb.height, 900) / 2;
  await page.mouse.move(hb.x + hb.width * 0.05, midY - 60);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width * 0.2, midY + 40, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  let pr = await readProject(page);
  check('Maus: ein Zug legt genau einen Bereich an (ohne Zeichenmodus)', pr.regions.length === 2 && (await page.getAttribute('[data-testid="region-draw-toggle"]', 'aria-pressed')) === 'false', `${pr.regions.length}`);
  // winziger Zug (< 24 px) wird verworfen
  hb = await holderBox();
  const midY2 = Math.max(hb.y, 0) + Math.min(hb.height, 900) / 2;
  await page.mouse.move(hb.x + hb.width * 0.85, midY2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width * 0.85 + 10, midY2 + 10, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  pr = await readProject(page);
  const tiny = await msgText();
  check('Bereich unter 24 px wird nicht gespeichert (mit Hinweis)', pr.regions.length === 2 && /24 px/.test(tiny), tiny);
  check('Nach dem Berechnen: „Bereiche geändert – bitte neu berechnen“', await page.isVisible('[data-testid="regions-changed"]'));
  await page.screenshot({ path: path.join(OUT, '04-shapes-desktop.png'), fullPage: true });
  await page.click('[data-testid="region-remove-last"]');
  await page.waitForTimeout(300);
  pr = await readProject(page);
  check('„Letzten Bereich entfernen“ entfernt genau den zuletzt gezeichneten', pr.regions.length === 1 && pr.regions[0].id === 'face', pr.regions.map((r) => r.id).join(','));
  check('Hinweis verschwindet, wenn die Bereiche wieder der Berechnung entsprechen', (await page.$('[data-testid="regions-changed"]')) === null);

  // ---------- Landschaft (ohne Gesicht): Karte zum Markieren von Hand, neutraler Detailgrad-Hinweis
  await openSample(page, 'landscape');
  await gotoStep(page, 'size');
  check('Ohne Gesichtsbereich: neutraler Hinweis auf Schritt 6, keine Ampel', (await page.$('[data-testid="detail-noface"]')) !== null && (await page.getAttribute('[data-testid="detail-meter"]', 'data-light')) === 'none');
  check('Ohne Gesichtsbereich: keine Gesichts-Spalte in der Vergleichstabelle', (await page.$$eval('[data-testid="tradeoff"] thead th', (l) => l.length)) === 4);
  await page.click('[data-testid="detail-go-shapes"]');
  await page.waitForSelector('[data-testid="region-holder"] canvas');
  check('„Gesicht markieren (Schritt 6)“ öffnet Steinformen', /\/shapes$/.test(page.url()), page.url());
  check('„Gesichter erkennen“ vorhanden (Offline-Erkennung), Karte zum Markieren von Hand ist sichtbar', (await page.$('[data-testid="detect-faces"]')) !== null && (await page.isVisible('[data-testid="face-manual-card"]')));
  await page.screenshot({ path: path.join(OUT, '05-shapes-manual-card.png'), fullPage: true });
  await page.click('[data-testid="face-manual-start"]');
  check('Karte schaltet Zeichenmodus ein (aria-pressed)', (await page.getAttribute('[data-testid="region-draw-toggle"]', 'aria-pressed')) === 'true');
  const hb2 = await (await page.$('[data-testid="region-holder"]')).boundingBox();
  await page.mouse.move(hb2.x + hb2.width * 0.3, hb2.y + hb2.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(hb2.x + hb2.width * 0.6, hb2.y + hb2.height * 0.6, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const pl = await readProject(page);
  check('Gezeichnetes Gesicht: Ellipse vom Typ Gesicht, Karte verschwindet, Steinzahl in der Liste', pl.regions.length === 1 && pl.regions[0].type === 'face' && pl.regions[0].shape === 'ellipse' && !(await page.$('[data-testid="face-manual-card"]')) && (await page.isVisible('[data-testid="region-face-span"]')));
  await page.click('[data-testid="region-remove-last"]');

  // ---------- Englische Oberfläche: Rasterfehler übersetzt
  await gotoStep(page, 'size');
  await page.selectOption('select.lang', 'en');
  await page.waitForTimeout(300);
  await page.fill('[data-testid="width-input"]', '0.1');
  await page.locator('[data-testid="width-input"]').blur();
  await page.waitForSelector('[data-testid="layout-error"]');
  const errEn = await page.textContent('[data-testid="layout-error"]');
  check('EN: Breite 0,1 cm zeigt den englischen Rasterfehler mit Handlungshinweis', /The width \(1 mm\) is smaller than a tile/.test(errEn) && /minimum edge tile width/.test(errEn) && !/ist kleiner/.test(errEn), errEn);
  await page.screenshot({ path: path.join(OUT, '06-layout-error-en.png') });
  await page.selectOption('select.lang', 'tr');
  await page.waitForTimeout(300);
  const errTr = await page.textContent('[data-testid="layout-error"]');
  check('TR: derselbe Fehler auf Türkisch', /Genişlik \(1 mm\)/.test(errTr), errTr);
  await page.selectOption('select.lang', 'de');
  await page.waitForTimeout(300);
  const errDe = await page.textContent('[data-testid="layout-error"]');
  check('DE: derselbe Fehler auf Deutsch (Zahlen im deutschen Format)', /Die Breite \(1 mm\) ist kleiner als ein Stein/.test(errDe), errDe);
  // zu viele Rasterpositionen
  await page.fill('[data-testid="width-input"]', '1000000');
  await page.locator('[data-testid="width-input"]').blur();
  await page.waitForTimeout(300);
  const errMany = await page.textContent('[data-testid="layout-error"]');
  check('Zu viele Rasterpositionen: Anzahl im deutschen Format + Hinweis „Größere Steine“', /höchstens 40\.000\.000/.test(errMany) && /Größere Steine/.test(errMany), errMany.slice(0, 140));
  check('Vergleichstabelle bleibt nutzbar (größere Steine als Ausweg)', (await page.$$('[data-testid="tradeoff"] tbody tr')).length > 3);
  await page.screenshot({ path: path.join(OUT, '07-too-many.png'), fullPage: true });
  await ctx.close();

  // ================================================================ Handy 390 × 844, Touch
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const mp = await mctx.newPage();
  mp.on('pageerror', (e) => errors.push(String(e)));
  mp.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const cdp = await mctx.newCDPSession(mp);
  await mp.goto(BASE);
  await mp.waitForSelector('[data-testid="sample-portrait"]');
  await mp.tap('[data-testid="sample-portrait"]');
  await mp.waitForSelector('[data-testid="compute-btn"]', { timeout: 30000 });
  await mp.tap('[data-testid="step-shapes"]');
  await mp.waitForSelector('[data-testid="region-holder"] canvas');
  await mp.waitForTimeout(500);
  const ta = await mp.$eval('[data-testid="region-holder"]', (e) => getComputedStyle(e).touchAction);
  check('Handy: Bereichsbild ist standardmäßig wischbar (touch-action pan-y pinch-zoom)', /pan-y/.test(ta) && /pinch-zoom/.test(ta), ta);
  await mp.evaluate(() => {
    const r = document.querySelector('[data-testid="region-holder"]').getBoundingClientRect();
    window.scrollBy(0, r.top - 200);
  });
  await mp.waitForTimeout(300);
  let hbm = await (await mp.$('[data-testid="region-holder"]')).boundingBox();
  const sy0 = await mp.evaluate(() => window.scrollY);
  const n0 = (await readProject(mp)).regions.length;
  await touchDrag(cdp, mp, hbm.x + hbm.width * 0.3, hbm.y + Math.min(hbm.height * 0.8, 600), 20, -250, 10);
  const sy1 = await mp.evaluate(() => window.scrollY);
  const n1 = (await readProject(mp)).regions.length;
  const draftLeft = await mp.$('[data-testid="region-draft"]');
  check('Handy: senkrechtes Wischen auf dem Bild (Zeichnen aus) scrollt die Seite, kein neuer Bereich', sy1 > sy0 + 50 && n1 === n0 && !draftLeft, `scrollY ${sy0} → ${sy1}; Bereiche ${n0} → ${n1}`);
  await mp.screenshot({ path: path.join(OUT, '08-mobile-after-swipe.png') });

  // Zeichenmodus an: ein Zug = genau ein Bereich, danach Zeichenmodus aus
  await mp.evaluate(() => {
    const r = document.querySelector('[data-testid="region-draw-toggle"]').getBoundingClientRect();
    window.scrollBy(0, r.top - 120);
  });
  await mp.waitForTimeout(300);
  await mp.tap('[data-testid="region-draw-toggle"]');
  await mp.waitForTimeout(200);
  const pressed = await mp.getAttribute('[data-testid="region-draw-toggle"]', 'aria-pressed');
  const ta2 = await mp.$eval('[data-testid="region-holder"]', (e) => getComputedStyle(e).touchAction);
  check('„Bereich zeichnen“: aria-pressed=true, touch-action none', pressed === 'true' && ta2 === 'none', `${pressed} · ${ta2}`);
  await mp.screenshot({ path: path.join(OUT, '09-mobile-draw-on.png') });
  hbm = await (await mp.$('[data-testid="region-holder"]')).boundingBox();
  const sy2 = await mp.evaluate(() => window.scrollY);
  // Höhe der klebenden Live-Vorschau: am Handy blendet sie sich nach dem Zug wieder ein (Paket w6-fix-ui);
  // der Browser gleicht das per Scroll-Verankerung aus – diese Verschiebung ist kein Seiten-Scrollen durch den Zug.
  const lpH = () => mp.evaluate(() => document.querySelector('.w3lp')?.getBoundingClientRect().height ?? 0);
  const lp2 = await lpH();
  await touchDrag(cdp, mp, hbm.x + hbm.width * 0.1, hbm.y + 40, hbm.width * 0.3, 90, 12);
  await mp.waitForTimeout(300);
  const sy3 = await mp.evaluate(() => window.scrollY);
  const lp3 = await lpH();
  const n2 = (await readProject(mp)).regions.length;
  const pressed2 = await mp.getAttribute('[data-testid="region-draw-toggle"]', 'aria-pressed');
  check('Handy: mit Zeichenmodus legt ein Zug genau einen Bereich an und der Modus schaltet ab', n2 === n1 + 1 && pressed2 === 'false' && Math.abs(sy3 - sy2 - (lp3 - lp2)) < 3, `Bereiche ${n1} → ${n2}, aria-pressed ${pressed2}, scroll ${sy2}→${sy3}, Vorschau ${Math.round(lp2)}→${Math.round(lp3)} px`);
  await mp.screenshot({ path: path.join(OUT, '10-mobile-drawn.png') });

  // abgebrochene Geste (pointercancel): nichts gespeichert, kein Entwurf bleibt stehen
  await mp.tap('[data-testid="region-draw-toggle"]');
  await mp.waitForTimeout(200);
  hbm = await (await mp.$('[data-testid="region-holder"]')).boundingBox();
  await touchDrag(cdp, mp, hbm.x + hbm.width * 0.5, hbm.y + 60, hbm.width * 0.3, 80, 8, 'touchCancel');
  const n3 = (await readProject(mp)).regions.length;
  const overlays = await mp.$$eval('[data-testid="region-holder"] .region', (l) => l.length);
  check('Handy: abgebrochene Geste speichert nichts und hinterlässt keinen Entwurf', n3 === n2 && overlays === n2 && !(await mp.$('[data-testid="region-draft"]')), `Bereiche ${n3}, Overlays ${overlays}`);
  await mp.tap('[data-testid="region-draw-toggle"]').catch(() => {});
  const del = await (await mp.$('.w3fg-del')).boundingBox();
  check('Handy: Löschen-Knöpfe ≥ 44 × 44 px', del.width >= 44 && del.height >= 44, `${del.width}×${del.height}`);
  const hScroll = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('Handy: keine waagerechte Seitenscrollbar im Schritt Steinformen', hScroll <= 1, String(hScroll));
  await mp.screenshot({ path: path.join(OUT, '11-mobile-list.png') });

  // Handy: Schritt Bildgröße mit Detailgrad und Vergleichstabelle
  await mp.evaluate(() => window.scrollTo(0, 0));
  await mp.tap('[data-testid="step-size"]');
  await mp.waitForSelector('[data-testid="tradeoff"]');
  const hScroll2 = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('Handy: Bildgröße ohne waagerechte Seitenscrollbar (Tabelle passt)', hScroll2 <= 1, String(hScroll2));
  await mp.evaluate(() => document.querySelector('[data-testid="detail-meter"]').scrollIntoView({ block: 'start' }));
  await mp.waitForTimeout(200);
  await mp.screenshot({ path: path.join(OUT, '12-mobile-size.png') });
  await mp.evaluate(() => document.querySelector('[data-testid="tradeoff"]').scrollIntoView({ block: 'start' }));
  await mp.waitForTimeout(200);
  await mp.screenshot({ path: path.join(OUT, '13-mobile-tradeoff.png') });
  await mctx.close();

  check('Keine Fehler in der Konsole', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
