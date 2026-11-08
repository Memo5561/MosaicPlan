/* Browser-Test w1-touch-input-safety (Playwright/Chromium, Handy 390 × 844 mit Touch).
 * Prüft: keine Geister-Klicks nach dem Antippen eines Steins, Antipp-Zoom bei zu kleinen Steinen,
 * Verlegemodus (Tippen = genau ein Stein, langes Drücken = nichts), Zurück schließt zuerst den Dialog,
 * deutsche Zahleneingabe („1.000“ = 1000).
 * Voraussetzung: `npm run build` und `npx vite preview --port 4304` laufen.
 * Aufruf: node e2e/w1-touch-input-safety.e2e.cjs [baseUrl] [screenshotDir]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4304/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w1-touch');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'de-DE' });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });
  const wait = (ms) => page.waitForTimeout(ms);

  await page.goto(BASE);
  await page.tap('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.tap('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
  await wait(1500);

  // Geister-Ereignisse protokollieren: Maus-/Klickereignisse im Dialog kurz nach einem Finger-Tippen auf die Fläche
  await page.evaluate(() => {
    window.__ghost = [];
    let lastTouchUp = -1e9;
    document.addEventListener('pointerup', (e) => {
      if (e.target.tagName === 'CANVAS' && e.pointerType === 'touch') lastTouchUp = performance.now();
    }, true);
    for (const t of ['mousedown', 'mouseup', 'click'])
      document.addEventListener(t, (e) => {
        if (performance.now() - lastTouchUp < 600 && e.target.closest && e.target.closest('.modal-backdrop')) {
          const tg = e.target;
          window.__ghost.push(`${t}->${tg.tagName.toLowerCase()} "${(tg.innerText || '').trim().slice(0, 20)}"`);
        }
      }, true);
  });
  const ghosts = () => page.evaluate(() => window.__ghost.slice());
  const scale = () => page.$eval('[data-testid="mosaic-canvas"]', (c) => parseFloat(c.dataset.scale || '0'));
  const depth = () => page.evaluate(() => (history.state && history.state.mpModalDepth) || 0);
  const dialogOpen = async () => !!(await page.$('[data-testid="stone-id"]'));
  const stoneId = async () => (await page.textContent('[data-testid="stone-id"]')).trim().split(/\s/)[0];
  const placedChecked = () => page.$eval('[data-testid="stone-placed"]', (e) => e.checked);
  const waitClosed = () => page.waitForSelector('[data-testid="stone-id"]', { state: 'detached', timeout: 5000 });
  const fitView = async () => {
    await page.tap('[data-testid="viewer-fit"]');
    await wait(150);
  };
  const box = async () => {
    const cv = await page.$('[data-testid="mosaic-canvas"]');
    await cv.scrollIntoViewIfNeeded();
    return cv.boundingBox();
  };

  // ---------- 1. Vorschau in der Gesamtansicht: 15 Tipps öffnen keinen Dialog, sondern zoomen hinein
  let b = await box();
  let noDialog = 0;
  let zoomed = 0;
  let hintSeen = false;
  const fitScales = [];
  for (const fy of [0.15, 0.32, 0.5, 0.68, 0.85])
    for (const fx of [0.25, 0.5, 0.75]) {
      await fitView();
      const s0 = await scale();
      fitScales.push(s0);
      await page.touchscreen.tap(b.x + b.width * fx, b.y + b.height * fy);
      await wait(120);
      if (!hintSeen && (await page.isVisible('[data-testid="viewer-hint"]'))) {
        hintSeen = true;
        await wait(200);
        await shot('w1-01-fit-tap-zoom-hint');
      }
      await wait(300);
      if (!(await dialogOpen())) noDialog++;
      else await page.tap('[data-testid="modal-close"]').then(waitClosed);
      if ((await scale()) > s0 * 3) zoomed++;
    }
  check('Gesamtansicht: 15 Tipps öffnen keinen Dialog', noDialog === 15, `${noDialog}/15 ohne Dialog, Fit-Maßstab ${fitScales[0].toFixed(2)} px/mm`);
  check('Gesamtansicht: jedes Tippen zoomt um den Tippunkt hinein', zoomed === 15, `${zoomed}/15`);
  const hintText = hintSeen ? 'gesehen' : 'nicht gesehen';
  check('Hinweis „Zum Antippen hineingezoomt“ erscheint', hintSeen, hintText);
  await wait(1600);
  check('Hinweis verschwindet nach kurzer Zeit', !(await page.isVisible('[data-testid="viewer-hint"]')));

  // ---------- 2. Nach dem Hineinzoomen: ein Tippen öffnet genau den Stein unter dem Finger, ohne Geister-Klick
  const cx = 140;
  const rows = [];
  for (const y of [360, 420, 470, 519, 544]) {
    await fitView();
    await page.touchscreen.tap(cx, y); // zoomt hinein (Stein ≈ 40 px)
    await wait(450);
    const sZoom = await scale();
    await page.evaluate(() => (window.__ghost = []));
    await page.touchscreen.tap(cx, y); // wählt aus
    await page.waitForSelector('[data-testid="stone-id"]', { timeout: 5000 }).catch(() => {});
    await wait(350);
    const opened = await dialogOpen();
    const touchId = opened ? await stoneId() : null;
    const placed = opened ? await placedChecked() : null;
    const g = await ghosts();
    if (y === 519) await shot('w1-02-dialog-after-touch-tap');
    if (opened) {
      await page.tap('[data-testid="modal-close"]');
      await waitClosed();
    }
    // Referenz: Mausklick an derselben Stelle (keine Kompatibilitätsereignisse)
    await page.mouse.click(cx, y);
    await page.waitForSelector('[data-testid="stone-id"]', { timeout: 5000 }).catch(() => {});
    const refId = (await dialogOpen()) ? await stoneId() : null;
    if (refId) {
      await page.click('[data-testid="modal-close"]');
      await waitClosed();
    }
    rows.push({ y, sZoom: +sZoom.toFixed(2), opened, touchId, refId, placed, ghosts: g.length });
  }
  console.log('   ', JSON.stringify(rows));
  check('Gezoomt: Tippen öffnet den Steindialog', rows.every((r) => r.opened), rows.map((r) => r.touchId).join(', '));
  check('Gezoomt: Dialog zeigt genau den angetippten Stein (= Mausreferenz)', rows.every((r) => r.touchId && r.touchId === r.refId), rows.map((r) => `${r.touchId}=${r.refId}`).join(' '));
  check('Gezoomt: „verlegt“ bleibt nach dem Tippen leer', rows.every((r) => r.placed === false));
  check('Keine Geister-Klicks im neu geöffneten Dialog', rows.every((r) => r.ghosts === 0), `${rows.reduce((s, r) => s + r.ghosts, 0)} Ereignisse`);
  check('Dialog-Verlaufseinträge aufgeräumt', (await depth()) === 0);

  // ---------- 3. Zurück-Geste schließt zuerst den Dialog (Vorschau bleibt)
  await page.touchscreen.tap(cx, 420);
  await page.waitForSelector('[data-testid="stone-id"]', { timeout: 5000 });
  const urlBefore = page.url();
  await page.goBack();
  await wait(400);
  check('Zurück schließt nur den Steindialog', !(await dialogOpen()) && page.url() === urlBefore && /\/preview$/.test(page.url()) && (await page.isVisible('[data-testid="mosaic-canvas"]')), page.url().replace(/^.*#/, '#'));
  // verschachtelt: Freiform-Editor im Steindialog
  await page.touchscreen.tap(cx, 420);
  await page.waitForSelector('[data-testid="stone-id"]', { timeout: 5000 });
  await page.tap('button:has-text("Freiform …")');
  await page.waitForSelector('text=Freiform-Kontur zeichnen');
  const d2 = await depth();
  await page.goBack();
  await wait(400);
  const innerClosed = !(await page.isVisible('text=Freiform-Kontur zeichnen')) && (await dialogOpen());
  await page.goBack();
  await wait(400);
  check('Verschachtelt: Zurück schließt erst den Freiform-Editor, dann den Steindialog', d2 === 2 && innerClosed && !(await dialogOpen()) && page.url() === urlBefore, `Tiefe ${d2}`);
  // Esc wirkt nur auf den obersten Dialog
  await page.touchscreen.tap(cx, 420);
  await page.waitForSelector('[data-testid="stone-id"]', { timeout: 5000 });
  await page.tap('button:has-text("Freiform …")');
  await page.waitForSelector('text=Freiform-Kontur zeichnen');
  await page.keyboard.press('Escape');
  await wait(400);
  const escInner = !(await page.isVisible('text=Freiform-Kontur zeichnen')) && (await dialogOpen());
  // Abbrechen (programmatisch) im Freiform-Editor entfernt nur dessen Eintrag
  await page.tap('button:has-text("Freiform …")');
  await page.waitForSelector('text=Freiform-Kontur zeichnen');
  await page.tap('.modal-foot button:has-text("Abbrechen")');
  await wait(400);
  const cancelOk = !(await page.isVisible('text=Freiform-Kontur zeichnen')) && (await dialogOpen()) && (await depth()) === 1;
  await page.keyboard.press('Escape');
  await wait(400);
  check('Esc schließt nur den obersten Dialog', escInner && !(await dialogOpen()));
  check('Abbrechen im inneren Dialog lässt den Steindialog offen, Verlauf stimmt', cancelOk && (await depth()) === 0);
  // Tippen auf den abgedunkelten Hintergrund schließt (Drücken und Loslassen auf dem Hintergrund)
  await page.touchscreen.tap(cx, 420);
  await page.waitForSelector('[data-testid="stone-id"]', { timeout: 5000 });
  await page.touchscreen.tap(195, 6);
  await wait(400);
  check('Tippen auf den Hintergrund schließt den Dialog', !(await dialogOpen()) && (await depth()) === 0 && page.url() === urlBefore);

  // ---------- 4. Verlegeplan: nur ansehen hat nichts verlegt
  await page.tap('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="placed-count"]');
  const placedNow = async () => {
    await wait(1300);
    return parseInt((await page.textContent('[data-testid="placed-count"]')).replace(/\D/g, ''), 10);
  };
  const p0 = await placedNow();
  check('Nach dem Ansehen von Steinen ist nichts verlegt', p0 === 0, `placed-count ${p0}`);

  // ---------- 5. Verlegemodus mit dem Finger
  await page.tap('text=Verlegemodus');
  await wait(200);
  b = await box();
  const px = b.x + b.width * 0.5;
  const py = b.y + b.height * 0.5;
  const s0 = await scale();
  await page.touchscreen.tap(px, py);
  const pa = await placedNow();
  const s1 = await scale();
  check('Verlegemodus Gesamtansicht: Tippen verlegt nichts, sondern zoomt hinein', pa === p0 && s1 > s0 * 3, `${p0}→${pa}, Maßstab ${s0.toFixed(2)}→${s1.toFixed(2)}`);
  await page.touchscreen.tap(px, py);
  const pb = await placedNow();
  check('Verlegemodus gezoomt: ein Tippen verlegt genau einen Stein', pb === pa + 1, `${pa}→${pb}`);
  await shot('w1-03-laymode-zoomed');
  // langes Drücken (1,2 s) an derselben Stelle: keine Änderung
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: px, y: py, id: 7 }] });
  await wait(1200);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const pc = await placedNow();
  check('Langes Drücken (1,2 s) ändert nichts', pc === pb, `${pb}→${pc}`);
  // Verschieben mit dem Finger: keine Änderung
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: px, y: py, id: 8 }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: px - i * 10, y: py - i * 6, id: 8 }] });
    await wait(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const pd = await placedNow();
  // Pinch (auseinander): zoomt, verlegt nichts
  const sBefore = await scale();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: px - 20, y: py, id: 1 }, { x: px + 20, y: py, id: 2 }] });
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: px - 20 - i * 8, y: py, id: 1 }, { x: px + 20 + i * 8, y: py, id: 2 }] });
    await wait(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const pe = await placedNow();
  const sAfter = await scale();
  check('Verschieben und Pinch-Zoom funktionieren und verlegen nichts', pd === pc && pe === pc && sAfter > sBefore * 1.5, `Maßstab ${sBefore.toFixed(2)}→${sAfter.toFixed(2)}, verlegt ${pe}`);
  await page.touchscreen.tap(px, py);
  const pf = await placedNow();
  check('Danach verlegt ein Tippen wieder genau einen Stein', pf === pe + 1, `${pe}→${pf}`);

  // ---------- 6. Deutsche Zahleneingabe
  await page.goto(BASE);
  await page.tap('[data-testid="new-project"]');
  await wait(800);
  await page.tap('[data-testid="step-size"]');
  await page.waitForSelector('[data-testid="width-input"]');
  await page.tap('button[role="radio"]:has-text("cm")');
  const typeWidth = async (txt) => {
    await page.fill('[data-testid="width-input"]', '');
    await page.type('[data-testid="width-input"]', txt);
    await wait(150);
    const invalid = await page.$eval('[data-testid="width-input"]', (e) => e.parentElement.classList.contains('invalid'));
    const hint = (await page.$('[data-testid="width-input-hint"]')) ? (await page.textContent('[data-testid="width-input-hint"]')).trim() : '';
    return { invalid, hint };
  };
  const blurValue = async () => {
    await page.tap('h2');
    await wait(250);
    return page.$eval('[data-testid="width-input"]', (e) => e.value);
  };
  const a = await typeWidth('1.000');
  await shot('w1-04-number-hint');
  const av = await blurValue();
  check('„1.000“ (de, cm) wird als 1000 verstanden', av === '1000' && !a.invalid && a.hint === '→ 1000 cm', `Hinweis „${a.hint}“, nach Verlassen „${av}“`);
  const bq = await typeWidth('1.000,5');
  const bv = await blurValue();
  check('„1.000,5“ → 1000,5', bv === '1000,5' && bq.hint === '→ 1000,5 cm', `${bq.hint} | ${bv}`);
  const c1 = await typeWidth('1 000');
  const c1v = await blurValue();
  check('„1 000“ → 1000', c1v === '1000' && c1.hint === '→ 1000 cm', `${c1.hint} | ${c1v}`);
  const d = await typeWidth('12,5');
  const dv = await blurValue();
  check('„12,5“ → 12,5 ohne Hinweis', dv === '12,5' && !d.invalid && d.hint === '', dv);
  // in einem Schritt eingefügt (beim Tippen wäre das gültige Zwischenergebnis „1,2“ schon übernommen)
  await page.fill('[data-testid="width-input"]', '1,2,3');
  await wait(150);
  const eInvalid = await page.$eval('[data-testid="width-input"]', (el) => el.parentElement.classList.contains('invalid'));
  const ev = await blurValue();
  check('„1,2,3“ ist ungültig und wird nicht übernommen', eInvalid && ev === '12,5', `ungültig: ${eInvalid}, danach „${ev}“`);
  // Englisch: Tausenderkomma
  await page.selectOption('select.lang', 'en');
  await wait(300);
  const f = await typeWidth('1,000');
  const fv = await blurValue();
  const g = await typeWidth('1.000');
  const gv = await blurValue();
  check('EN: „1,000“ → 1000, „1.000“ → 1', fv === '1000' && f.hint === '→ 1000 cm' && gv === '1', `${fv} | ${gv}`);
  await page.selectOption('select.lang', 'de');
  await wait(300);

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
