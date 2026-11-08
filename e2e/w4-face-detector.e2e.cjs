/* w4-face-detector: Offline-Gesichtsvorschläge (pico.js im Worker, Kaskade vom Service Worker vorab gespeichert),
 * Übernehmen/Verwerfen (nichts wird ohne Bestätigung gespeichert), geschätzte Augenpartie, Verschieben und
 * Größe ändern von Bereichen (Maus, Tastatur, Finger), FaceDetector des Browsers als erste Wahl.
 * Voraussetzung: `npm run build` und `npx vite preview --port <port>` laufen.
 * Aufruf: node e2e/w4-face-detector.e2e.cjs <baseUrl> <outDir>
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w4-face-detector');
fs.mkdirSync(OUT, { recursive: true });
const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'face-pd-portrait.png'));
// von Hand markiertes Gesicht und Augen im Testbild (tests/fixtures/face-pd-portrait.txt), normiert
const FACE = { x: 0.35, y: 0.15, w: 0.19, h: 0.21 };
const EYES = [
  [0.395, 0.197],
  [0.488, 0.197],
];

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

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
            resolve(p ? { regions: p.regions, adjust: p.adjust } : null);
            db.close();
          };
          g.onerror = () => reject(g.error);
        };
      }),
  );
}

/** Foto über die Startseite hochladen → neues Projekt → Schritt Steinformen */
async function newPortraitProject(page, name = 'Astronautin.png') {
  await page.goto(BASE);
  await page.waitForSelector('[data-testid="home-photo"]', { state: 'attached' });
  await page.setInputFiles('[data-testid="home-photo"]', { name, mimeType: 'image/png', buffer: FIXTURE });
  await page.waitForURL(/#\/project\/[^/]+\/photo/, { timeout: 30000 });
  await page.waitForTimeout(400);
  await page.click('[data-testid="step-shapes"]');
  await page.waitForSelector('[data-testid="region-holder"] canvas', { timeout: 20000 });
}

const styleRect = (s) => {
  const g = (k) => parseFloat((s.match(new RegExp(`${k}:\\s*([\\d.]+)%`)) || [])[1]) / 100;
  return { x: g('left'), y: g('top'), w: g('width'), h: g('height') };
};
const inEllipse = (r, x, y) => ((x - (r.x + r.w / 2)) / (r.w / 2)) ** 2 + ((y - (r.y + r.h / 2)) / (r.h / 2)) ** 2 <= 1;

/** Bildschirmfoto eines Bereichs – unterhalb der klebenden Kopf- und Schrittleiste ausgerichtet */
async function shot(page, sel, file) {
  const top = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const sticky = [...document.querySelectorAll('*')].filter((e) => ['sticky', 'fixed'].includes(getComputedStyle(e).position) && e.getBoundingClientRect().top < 160 && e.getBoundingClientRect().bottom > 0 && e.getBoundingClientRect().height < 260);
    const offset = Math.max(0, ...sticky.map((e) => e.getBoundingClientRect().bottom)) + 8;
    window.scrollBy(0, el.getBoundingClientRect().top - offset);
    return el.getBoundingClientRect().top;
  }, sel);
  if (top === null) return;
  await page.waitForTimeout(150);
  const box = await (await page.$(sel)).boundingBox();
  const vp = page.viewportSize();
  await page.screenshot({ path: path.join(OUT, file), clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(vp.width, box.width + 16), height: Math.min(vp.height - Math.max(0, box.y - 8), box.height + 16) } });
}

/** Fingerzug über CDP (echte Touch-Ereignisse → Pointer Events mit pointerType 'touch') */
async function touchDrag(cdp, page, x0, y0, dx, dy, steps = 10) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * i) / steps, y: y0 + (dy * i) / steps, id: 1 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  };

  // ================================================================ Desktop
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1300 } });
  const page = await ctx.newPage();
  watch(page);
  check('Chromium ohne FaceDetector-API (Offline-Erkennung wird gebraucht)', !(await page.evaluate(() => 'FaceDetector' in window)));
  await newPortraitProject(page);
  await page.waitForSelector('[data-testid="face-suggestion-card"]', { timeout: 20000 }).catch(() => {});
  const cards = await page.$$eval('[data-testid="face-suggestion-card"]', (l) => l.map((e) => ({ ...e.dataset, text: e.textContent })));
  check('Schritt Steinformen ohne Bereiche: automatisch genau ein Vorschlag (pico, offline-fähig)', cards.length === 1 && cards[0].source === 'pico', JSON.stringify(cards.map((c) => [c.source, Math.round(c.score), c.confidence])));
  check('Vorschlag beschriftet: „automatisch erkannt – bitte prüfen“, Sicherheit als Richtwert, Augenpartie „geschätzt“', cards[0] && /automatisch erkannt – bitte prüfen/.test(cards[0].text) && /Sicherheit: (gering|mittel|hoch)/.test(cards[0].text) && /Richtwert/.test(cards[0].text) && /geschätzt/.test(cards[0].text), cards[0] && cards[0].text.slice(0, 160));
  const status = await page.textContent('[data-testid="face-detect-status"]');
  check('Statuszeile: „1 Gesicht vorgeschlagen – bitte prüfen …“', /^1 Gesicht vorgeschlagen/.test(status), status);
  check('Hinweis: nur frontale menschliche Gesichter', /nur frontale menschliche Gesichter/.test(await page.textContent('[data-testid="face-detect-scope"]')));
  const sFace = styleRect(await page.getAttribute('[data-testid="face-suggestion"]', 'style'));
  const sEyes = styleRect(await page.getAttribute('[data-testid="face-suggestion-eyes"]', 'style'));
  const fc = [FACE.x + FACE.w / 2, FACE.y + FACE.h / 2];
  check('Vorschlag liegt auf dem Gesicht (Ellipse enthält die Mitte des markierten Gesichts), Augenpartie enthält beide Augen', inEllipse(sFace, fc[0], fc[1]) && EYES.every(([x, y]) => inEllipse(sEyes, x, y)), `Gesicht ${JSON.stringify(sFace)} Augen ${JSON.stringify(sEyes)}`);
  const dash = await page.$eval('[data-testid="face-suggestion"]', (e) => getComputedStyle(e).borderTopStyle);
  check('Vorschlag gestrichelt gezeichnet', dash === 'dashed', dash);
  await page.waitForTimeout(1500);
  let pr = await readProject(page);
  check('Ohne „Übernehmen“ wird nichts gespeichert (0 Bereiche, auch nach 1,5 s)', pr.regions.length === 0, String(pr.regions.length));
  check('Bereichsliste leer, Karte „Gesicht von Hand“ ausgeblendet während ein Vorschlag offen ist', (await page.$$('[data-testid="region-item"]')).length === 0 && !(await page.$('[data-testid="face-manual-card"]')));
  await page.evaluate(() => document.querySelector('[data-testid="face-suggestions"]').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(150);
  await shot(page, '.w4fd-regions', '01-desktop-suggestion.png');

  // Verwerfen: nichts gespeichert, Karte zum Markieren von Hand zurück
  await page.click('[data-testid="face-suggestion-discard"]');
  await page.waitForTimeout(300);
  pr = await readProject(page);
  check('„Verwerfen“: Vorschlag weg, keine Bereiche, Karte „Gesicht markieren“ wieder da', pr.regions.length === 0 && !(await page.$('[data-testid="face-suggestion"]')) && (await page.isVisible('[data-testid="face-manual-card"]')), (await page.textContent('[data-testid="region-msg"]')) || '');
  // Schritt verlassen und wieder öffnen: der verworfene Vorschlag kommt nicht von selbst zurück
  await page.click('[data-testid="step-colors"]');
  await page.waitForTimeout(300);
  await page.click('[data-testid="step-shapes"]');
  await page.waitForSelector('[data-testid="region-holder"] canvas');
  await page.waitForTimeout(1200);
  check('Wieder geöffnet: verworfener Vorschlag kommt nicht von selbst zurück (Suche läuft je Bild einmal)', !(await page.$('[data-testid="face-suggestion-card"]')));

  // „Gesichter erkennen“ von Hand → Übernehmen
  await page.click('[data-testid="detect-faces"]');
  await page.waitForSelector('[data-testid="face-suggestion-card"]', { timeout: 20000 });
  check('„Gesichter erkennen“ von Hand: Vorschlag erneut', (await page.$$('[data-testid="face-suggestion-card"]')).length === 1);
  await page.click('[data-testid="face-suggestion-accept"]');
  await page.waitForTimeout(500);
  pr = await readProject(page);
  const [rf, re] = pr.regions;
  check(
    '„Übernehmen“: genau 2 Bereiche – Gesicht (Ellipse, automatisch) + Detail Augenpartie (geschätzt)',
    pr.regions.length === 2 && rf.type === 'face' && rf.shape === 'ellipse' && rf.origin === 'auto-face' && re.type === 'detail' && re.origin === 'auto-eyes',
    JSON.stringify(pr.regions.map((r) => [r.type, r.shape, r.origin])),
  );
  check('Gespeicherte Bereiche = angezeigter Vorschlag', Math.abs(rf.x - sFace.x) < 1e-3 && Math.abs(rf.w - sFace.w) < 1e-3 && Math.abs(re.y - sEyes.y) < 1e-3 && Math.abs(re.h - sEyes.h) < 1e-3);
  const items = await page.$$eval('[data-testid="region-item"]', (l) => l.map((e) => ({ origin: e.dataset.origin, text: e.textContent })));
  check('Liste: Gesicht „automatisch erkannt, von Ihnen übernommen“, Augenpartie mit Abzeichen „geschätzt“', /automatisch erkannt, von Ihnen übernommen/.test(items[0].text) && /Augenpartie/.test(items[1].text) && (await page.$('[data-testid="region-estimated"]')) !== null, items.map((i) => i.text.slice(0, 60)).join(' | '));
  check('Gesicht zeigt Steine über das Gesicht (Richtwert)', await page.isVisible('[data-testid="region-face-span"]'));
  check('Nach dem Übernehmen keine offenen Vorschläge, keine Karte „von Hand“', !(await page.$('[data-testid="face-suggestion-card"]')) && !(await page.$('[data-testid="face-manual-card"]')));

  // ---------- Auswählen, verschieben, Größe ändern (Maus)
  await page.evaluate(() => document.querySelector('[data-testid="region-holder"]').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  let hb = await (await page.$('[data-testid="region-holder"]')).boundingBox();
  // Klick ins Gesicht unterhalb der Augenpartie
  await page.mouse.click(hb.x + hb.width * (rf.x + rf.w / 2), hb.y + hb.height * (rf.y + rf.h * 0.8));
  await page.waitForTimeout(250);
  let sel = await page.$$eval('[data-testid="region-overlay"]', (l) => l.map((e) => e.dataset.selected));
  check('Klick auf einen Bereich wählt ihn aus (kein neuer Bereich, keine Meldung „zu klein“)', sel[0] === '1' && sel[1] === '0' && (await readProject(page)).regions.length === 2 && !/24 px/.test((await page.textContent('[data-testid="region-msg"]').catch(() => '')) || ''), sel.join(','));
  const handles = await page.$$eval('.w4fd-h', (l) => l.map((e) => e.getBoundingClientRect()).map((r) => [Math.round(r.width), Math.round(r.height)]));
  check('Ausgewählt: 4 Eckgriffe mit je 44 × 44 px Trefferfläche', handles.length === 4 && handles.every(([w, h]) => w >= 44 && h >= 44), JSON.stringify(handles));
  check('Auswahlleiste mit Erklärung und „Fertig“', /Bereich 1 ausgewählt/.test(await page.textContent('[data-testid="region-selbar"]')));
  await shot(page, '.w4fd-regions', '02-desktop-selected.png');
  // verschieben (Lage des Bildes neu messen)
  hb = await (await page.$('[data-testid="region-holder"]')).boundingBox();
  const before = (await readProject(page)).regions[0];
  const cx = hb.x + hb.width * (before.x + before.w / 2);
  const cy = hb.y + hb.height * (before.y + before.h * 0.8);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 20, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  let after = (await readProject(page)).regions[0];
  const dxN = 40 / hb.width;
  const dyN = 20 / hb.height;
  check('Ziehen verschiebt den Bereich (Größe gleich), Herkunft „automatisch“ entfällt nach Anpassung', Math.abs(after.x - before.x - dxN) < 0.004 && Math.abs(after.y - before.y - dyN) < 0.004 && Math.abs(after.w - before.w) < 1e-9 && after.origin === undefined && (await readProject(page)).regions.length === 2, `x ${before.x.toFixed(3)}→${after.x.toFixed(3)} (+${dxN.toFixed(3)}), y ${before.y.toFixed(3)}→${after.y.toFixed(3)}`);
  // Größe an der Ecke unten rechts
  const se = await (await page.$('[data-testid="region-handle-se"]')).boundingBox();
  await page.mouse.move(se.x + se.width / 2, se.y + se.height / 2);
  await page.mouse.down();
  await page.mouse.move(se.x + se.width / 2 + 30, se.y + se.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const big = (await readProject(page)).regions[0];
  check('Eckgriff unten rechts: größer, obere linke Ecke bleibt fest', Math.abs(big.x - after.x) < 1e-9 && Math.abs(big.y - after.y) < 1e-9 && Math.abs(big.w - after.w - 30 / hb.width) < 0.004 && Math.abs(big.h - after.h - 30 / hb.height) < 0.004, `w ${after.w.toFixed(3)}→${big.w.toFixed(3)}, h ${after.h.toFixed(3)}→${big.h.toFixed(3)}`);
  // Tastatur
  await page.focus('[data-testid="region-overlay"][data-selected="1"]');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Shift+ArrowUp');
  await page.waitForTimeout(300);
  const kb = (await readProject(page)).regions[0];
  check('Tastatur: Pfeil links verschiebt um 1 %, Umschalt + Pfeil hoch verkleinert die Höhe um 1 %', Math.abs(kb.x - (big.x - 0.01)) < 1e-6 && Math.abs(kb.h - (big.h - 0.01)) < 1e-6 && Math.abs(kb.w - big.w) < 1e-9, `x ${big.x.toFixed(3)}→${kb.x.toFixed(3)}, h ${big.h.toFixed(3)}→${kb.h.toFixed(3)}`);
  // Klick in die Augenpartie (liegt im ausgewählten Gesicht) wählt die kleinere Augenpartie
  const eyesR = (await readProject(page)).regions[1];
  hb = await (await page.$('[data-testid="region-holder"]')).boundingBox();
  await page.mouse.click(hb.x + hb.width * (eyesR.x + eyesR.w / 2), hb.y + hb.height * (eyesR.y + eyesR.h / 2));
  await page.waitForTimeout(250);
  sel = await page.$$eval('[data-testid="region-overlay"]', (l) => l.map((e) => e.dataset.selected));
  check('Klick in die Augenpartie wählt die Augenpartie (kleinster Bereich an der Stelle)', sel[0] === '0' && sel[1] === '1', sel.join(','));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc hebt die Auswahl auf', (await page.$$eval('[data-testid="region-overlay"]', (l) => l.filter((e) => e.dataset.selected === '1').length)) === 0);
  // „Anpassen“ in der Liste wählt aus, „Fertig“ hebt auf
  await page.click('[data-testid="region-item"]:nth-child(2) [data-testid="region-edit"]');
  await page.waitForTimeout(200);
  check('„Anpassen“ in der Liste wählt den Bereich aus (aria-pressed)', (await page.getAttribute('[data-testid="region-item"]:nth-child(2) [data-testid="region-edit"]', 'aria-pressed')) === 'true' && /Bereich 2 ausgewählt/.test(await page.textContent('[data-testid="region-selbar"]')));
  await page.click('[data-testid="region-sel-done"]');
  await page.waitForTimeout(200);
  check('„Fertig“ hebt die Auswahl auf', !(await page.$('[data-testid="region-selbar"]')));
  // Zeichnen mit der Maus auf freier Fläche funktioniert weiter
  hb = await (await page.$('[data-testid="region-holder"]')).boundingBox();
  await page.mouse.move(hb.x + hb.width * 0.05, hb.y + hb.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width * 0.2, hb.y + hb.height * 0.85, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  pr = await readProject(page);
  check('Maus zeichnet auf freier Fläche weiterhin einen neuen Bereich (ohne Herkunft)', pr.regions.length === 3 && pr.regions[2].origin === undefined, String(pr.regions.length));
  check('Kein automatischer Vorschlag mehr, sobald das Gesicht markiert ist', !(await page.$('[data-testid="face-suggestion-card"]')));
  await page.click('[data-testid="detect-faces"]');
  await page.waitForSelector('[data-testid="face-detect-status"]:not([data-status="running"])', { timeout: 20000 });
  check('Erneut „Gesichter erkennen“: bereits markiertes Gesicht wird nicht noch einmal vorgeschlagen', (await page.getAttribute('[data-testid="face-detect-status"]', 'data-status')) === 'covered' && !(await page.$('[data-testid="face-suggestion-card"]')), await page.textContent('[data-testid="face-detect-status"]'));
  await shot(page, '.w4fd-regions', '03-desktop-edited.png');

  // Englisch und Türkisch
  await page.click('[data-testid="region-remove-last"]');
  await page.click('[data-testid="region-remove-last"]');
  await page.click('[data-testid="region-remove-last"]');
  await page.waitForTimeout(300);
  await page.selectOption('select.lang', 'en');
  await page.click('[data-testid="detect-faces"]');
  await page.waitForSelector('[data-testid="face-suggestion-card"]', { timeout: 20000 });
  const en = await page.textContent('[data-testid="face-suggestion-card"]');
  check('EN: Vorschlag auf Englisch', /detected automatically – please check/.test(en) && /Confidence: (low|medium|high)/.test(en) && /Apply/.test(en) && /estimated/.test(en), en.slice(0, 120));
  await page.selectOption('select.lang', 'tr');
  await page.waitForTimeout(200);
  const trt = await page.textContent('[data-testid="face-suggestion-card"]');
  check('TR: Vorschlag auf Türkisch', /otomatik algılandı/.test(trt) && /Uygula/.test(trt) && /tahmini/.test(trt), trt.slice(0, 120));
  await shot(page, '.w4fd-regions', '04-desktop-tr.png');
  await page.selectOption('select.lang', 'de');
  await page.waitForTimeout(200);

  // Landschaft: kein Gesicht
  await page.goto(BASE);
  await page.waitForSelector('[data-testid="sample-landscape"]');
  await page.click('[data-testid="sample-landscape"]');
  await page.waitForSelector('[data-testid="compute-btn"]', { timeout: 30000 });
  await page.click('[data-testid="step-shapes"]');
  await page.waitForSelector('[data-testid="face-detect-status"][data-status="none"]', { timeout: 20000 }).catch(() => {});
  const none = await page.textContent('[data-testid="face-detect-status"]').catch(() => '');
  check('Landschaft: „Kein Gesicht gefunden.“, keine Bereiche, Karte zum Markieren von Hand', /^Kein Gesicht gefunden\./.test(none) && (await readProject(page)).regions.length === 0 && (await page.isVisible('[data-testid="face-manual-card"]')), none);
  await shot(page, '.w4fd-regions', '05-landscape-none.png');
  await ctx.close();

  // ================================================================ FaceDetector des Browsers zuerst
  const nctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await nctx.addInitScript(() => {
    window.__fdCalls = 0;
    window.FaceDetector = class {
      async detect(src) {
        window.__fdCalls++;
        const w = src.width;
        const h = src.height;
        return [{ boundingBox: new DOMRectReadOnly(w * 0.35, h * 0.14, w * 0.19, h * 0.2), landmarks: [{ type: 'eye', locations: [{ x: w * 0.395, y: h * 0.197 }] }, { type: 'eye', locations: [{ x: w * 0.488, y: h * 0.197 }] }] }];
      }
    };
  });
  const np = await nctx.newPage();
  watch(np);
  await newPortraitProject(np, 'nativ.png');
  await np.waitForSelector('[data-testid="face-suggestion-card"]', { timeout: 20000 }).catch(() => {});
  const nc = await np.$$eval('[data-testid="face-suggestion-card"]', (l) => l.map((e) => ({ ...e.dataset, text: e.textContent })));
  check('FaceDetector vorhanden: wird zuerst benutzt (Quelle „native“, ohne Sicherheitswert, Augenpartie um die Augenpunkte)', nc.length === 1 && nc[0].source === 'native' && /ohne Sicherheitswert/.test(nc[0].text) && /Augenpunkte/.test(nc[0].text) && (await np.evaluate(() => window.__fdCalls)) >= 1, nc.map((c) => c.source).join(','));
  check('Auch hier nichts gespeichert ohne „Übernehmen“', (await readProject(np)).regions.length === 0);
  await nctx.close();

  const ectx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await ectx.addInitScript(() => {
    window.FaceDetector = class {
      async detect() {
        return [];
      }
    };
  });
  const ep = await ectx.newPage();
  watch(ep);
  await newPortraitProject(ep, 'leer.png');
  await ep.waitForSelector('[data-testid="face-suggestion-card"]', { timeout: 20000 }).catch(() => {});
  check('FaceDetector findet nichts: Offline-Erkennung springt ein (Quelle „pico“)', (await ep.getAttribute('[data-testid="face-suggestion-card"]', 'data-source').catch(() => null)) === 'pico');
  await ectx.close();

  // ================================================================ Offline (Service Worker) – auch auf dem Handy
  const octx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const op = await octx.newPage();
  watch(op);
  await op.goto(BASE);
  await op.waitForSelector('[data-testid="home-photo"]', { state: 'attached' });
  // warten, bis der Service Worker installiert ist und die Kaskade im Vorrat liegt
  let cached = false;
  for (let i = 0; i < 60 && !cached; i++) {
    cached = await op.evaluate(async () => {
      if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg || !reg.active) return false;
      }
      for (const k of await caches.keys()) {
        const reqs = await (await caches.open(k)).keys();
        if (reqs.some((r) => /facefinder-[^/]*\.bin/.test(r.url)) && reqs.some((r) => /face\.worker-[^/]*\.js/.test(r.url))) return true;
      }
      return false;
    });
    if (!cached) await op.waitForTimeout(500);
  }
  check('Service Worker hat Kaskade (*.bin) und Face-Worker vorab gespeichert', cached);
  await op.reload();
  await op.waitForSelector('[data-testid="home-photo"]', { state: 'attached' });
  const controlled = await op.evaluate(() => !!navigator.serviceWorker.controller);
  await octx.setOffline(true);
  const netReqs = [];
  op.on('requestfailed', (r) => netReqs.push(r.url()));
  await op.reload();
  await op.waitForSelector('[data-testid="home-photo"]', { state: 'attached', timeout: 20000 });
  check('Offline: App startet aus dem Service Worker', controlled && (await op.isVisible('[data-testid="new-project"]')));
  await op.setInputFiles('[data-testid="home-photo"]', { name: 'offline.png', mimeType: 'image/png', buffer: FIXTURE });
  await op.waitForURL(/#\/project\/[^/]+\/photo/, { timeout: 30000 });
  await op.waitForTimeout(400);
  await op.evaluate(() => window.scrollTo(0, 0));
  await op.tap('[data-testid="step-shapes"]');
  await op.waitForSelector('[data-testid="region-holder"] canvas', { timeout: 20000 });
  await op.waitForSelector('[data-testid="face-suggestion-card"]', { timeout: 20000 }).catch(() => {});
  const oc = await op.$$eval('[data-testid="face-suggestion-card"]', (l) => l.map((e) => e.dataset.source));
  check('Offline (Handy): Vorschlag erscheint im Schritt Steinformen (pico + Kaskade aus dem Vorrat)', oc.length === 1 && oc[0] === 'pico', `${oc.join(',')} · fehlgeschlagene Anfragen: ${netReqs.filter((u) => /facefinder|face\.worker/.test(u)).join(',') || 'keine'}`);
  await op.waitForTimeout(1000);
  check('Offline: vor „Übernehmen“ keine Bereiche gespeichert', (await readProject(op)).regions.length === 0);
  // Die Live-Vorschau klebt am Handy oben – für Bildschirmfotos und Fingergesten einklappen
  if (await op.isVisible('[data-testid="live-preview-stage"]')) {
    await op.evaluate(() => window.scrollTo(0, 0));
    await op.tap('[data-testid="live-preview-toggle"]');
    await op.waitForTimeout(300);
  }
  await shot(op, '.w4fd-regions', '06-phone-offline-suggestion.png');
  const hs = await op.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('Handy: keine waagerechte Seitenscrollbar mit Vorschlag', hs <= 1, String(hs));
  const acc = await (await op.$('[data-testid="face-suggestion-accept"]')).boundingBox();
  check('Handy: „Übernehmen“ mindestens 44 px hoch', acc.height >= 44, `${acc.width}×${acc.height}`);
  await op.tap('[data-testid="face-suggestion-accept"]');
  await op.waitForTimeout(500);
  let opr = await readProject(op);
  check('Offline: „Übernehmen“ speichert Gesicht + Augenpartie', opr.regions.length === 2 && opr.regions[1].origin === 'auto-eyes');

  // Finger: Antippen wählt aus, Griff ziehen ändert die Größe, ohne dass die Seite scrollt (Bild unter die
  // eingeklappte, klebende Live-Vorschau schieben)
  const cdp = await octx.newCDPSession(op);
  await op.evaluate(() => {
    const lp = document.querySelector('[data-testid="live-preview"]');
    const top = lp ? Math.max(0, lp.getBoundingClientRect().bottom) + 24 : 160;
    const r = document.querySelector('[data-testid="region-holder"]').getBoundingClientRect();
    window.scrollBy(0, r.top - top);
  });
  await op.waitForTimeout(300);
  let hbm = await (await op.$('[data-testid="region-holder"]')).boundingBox();
  const f0 = opr.regions[0];
  await op.touchscreen.tap(hbm.x + hbm.width * (f0.x + f0.w / 2), hbm.y + hbm.height * (f0.y + f0.h * 0.82));
  await op.waitForTimeout(300);
  const selM = await op.$$eval('[data-testid="region-overlay"]', (l) => l.map((e) => e.dataset.selected));
  check('Handy: Antippen wählt den Bereich aus', selM[0] === '1', selM.join(','));
  const hsz = await op.$$eval('.w4fd-h', (l) => l.map((e) => e.getBoundingClientRect()).map((r) => [Math.round(r.width), Math.round(r.height)]));
  check('Handy: Griffe 44 × 44 px', hsz.length === 4 && hsz.every(([w, h]) => w >= 44 && h >= 44), JSON.stringify(hsz));
  const sw = await (await op.$('[data-testid="region-handle-sw"]')).boundingBox();
  const sy0 = await op.evaluate(() => window.scrollY);
  await touchDrag(cdp, op, sw.x + sw.width / 2, sw.y + sw.height / 2, -20, 40, 10);
  const sy1 = await op.evaluate(() => window.scrollY);
  const f1 = (await readProject(op)).regions[0];
  hbm = await (await op.$('[data-testid="region-holder"]')).boundingBox();
  check(
    'Handy: Griff unten links ziehen → breiter und höher, rechte obere Ecke fest, Seite scrollt nicht',
    f1.w > f0.w + 10 / hbm.width && f1.h > f0.h + 20 / hbm.height && Math.abs(f1.x + f1.w - (f0.x + f0.w)) < 1e-6 && Math.abs(f1.y - f0.y) < 1e-6 && Math.abs(sy1 - sy0) < 2,
    `w ${f0.w.toFixed(3)}→${f1.w.toFixed(3)}, h ${f0.h.toFixed(3)}→${f1.h.toFixed(3)}, scroll ${sy0}→${sy1}`,
  );
  await shot(op, '.w4fd-regions .region-holder', '07-phone-selected.png');
  // Wischen außerhalb eines Bereichs scrollt weiterhin
  await op.tap('[data-testid="region-sel-done"]');
  await op.waitForTimeout(200);
  await op.evaluate(() => {
    const r = document.querySelector('[data-testid="region-holder"]').getBoundingClientRect();
    window.scrollBy(0, r.top - 420);
  });
  await op.waitForTimeout(300);
  hbm = await (await op.$('[data-testid="region-holder"]')).boundingBox();
  const n0 = (await readProject(op)).regions.length;
  const sy2 = await op.evaluate(() => window.scrollY);
  // Finger nach unten über den Himmel rechts oben im Bild (kein Bereich) → Seite scrollt nach oben
  await touchDrag(cdp, op, hbm.x + hbm.width * 0.85, hbm.y + 30, 0, 220, 10);
  const sy3 = await op.evaluate(() => window.scrollY);
  check('Handy: Wischen über das Bild (nichts ausgewählt) scrollt die Seite, kein neuer Bereich', sy3 < sy2 - 50 && (await readProject(op)).regions.length === n0, `scroll ${sy2}→${sy3}`);
  await octx.setOffline(false);
  await octx.close();

  check('Keine Fehler in der Konsole', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
