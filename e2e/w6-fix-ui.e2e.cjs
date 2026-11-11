/* Paket w6-fix-ui im echten Browser (Chromium/Playwright).
 * Aufruf: node e2e/w6-fix-ui.e2e.cjs <baseUrl> <outDir>
 *
 * Nachbesserungen der UX-Prüfung von Welle 6, vor allem am Handy (390 × 844, Touch):
 *  - Steindetail aus der Liste „Größte Abweichungen“: Fotofarbe, Abweichung in Worten und „Nächste Farbe übernehmen“
 *    stehen IM Blatt; der Stein liegt sichtbar über dem Blatt (nicht verdeckt).
 *  - Abweichungskarte: Schnellschalter auch am Handy (kurz „Karte“), Legende in Worten, Mosaik wird ins Bild geholt.
 *  - Werkzeugkarte mit Überschrift, Spaltenköpfe „Foto ↔ Stein“ über der Liste.
 *  - Rechteck aufziehen: Hinweisleiste über dem Mosaik mit „Abbrechen“; danach bleibt die Auswahl sichtbar, „Zu den
 *    Aktionen“; nach „Anwenden“: Umriss + „Im Mosaik ansehen“; kein „Strg+Z“ am Handy.
 *  - Heller/Dunkler: große Sprünge gekennzeichnet, Zeile abwählen → Probelauf und Ergebnis folgen den Haken.
 *  - Form zurücksetzen: Probelauf nennt die Farbregel (Fotofarbe bzw. größte Fläche).
 *  - Farbe messen: Zoom-Knöpfe unter dem Foto, Zwei-Finger-Zoom, kein „Bisher“ beim neuen Material.
 *  - Live-Vorschau am Handy: kleines Vorschaubild, ausgeblendet während „Bereich zeichnen“.
 *  - Desktop: „Abweichungskarte“ ausgeschrieben, Hinweis mit Strg+Z; EN/TR ohne fehlende Texte.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w6-fix-ui');
fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
let passed = 0;
function check(name, ok, info = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  let v = await fn();
  while (!v && Date.now() - t0 < ms) {
    await wait(120);
    v = await fn();
  }
  return v;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const rect = (page, sel) => page.$eval(sel, (e) => (({ top, bottom, left, right, height, width }) => ({ top, bottom, left, right, height, width }))(e.getBoundingClientRect()));

const withApi = (page, sel, src) =>
  page.evaluate(
    ([sel, src]) => {
      const el = document.querySelector(sel);
      const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      let f = key ? el[key] : null;
      while (f && !(f.memoizedProps && f.memoizedProps.api && f.memoizedProps.api.editCell)) f = f.return;
      if (!f) return { error: 'no api' };
      // eslint-disable-next-line no-new-func
      return new Function('api', src)(f.memoizedProps.api);
    },
    [sel, src],
  );
/** Bildschirmmitte einer Zelle nach der Ansicht des Viewers */
const cellCenter = (page, row, col) =>
  withApi(
    page,
    '[data-testid="preview-tools"]',
    `const L = api.computed.layout; const cv = document.querySelector('[data-testid="mosaic-canvas"]'); const r = cv.getBoundingClientRect();
     const s = +cv.dataset.scale, ox = +cv.dataset.ox, oy = +cv.dataset.oy;
     return { x: r.left + ox + (L.colX[${col}] + L.colW[${col}] / 2) * s, y: r.top + oy + (L.rowY[${row}] + L.rowH[${row}] / 2) * s, cell: Math.min(L.colW[${col}], L.rowH[${row}]) * s };`,
  );
const rowOf = (s) => [...s].reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

/** Eine Fingerbewegung über CDP (Touch-Ereignisse wie am Gerät) */
async function touchDrag(cdp, pts) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0].x, y: pts[0].y, id: 1 }] });
  for (const p of pts.slice(1)) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y, id: 1 }] });
    await wait(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
/** Zwei Finger auseinander (Zoomen) um cx/cy */
async function pinch(cdp, cx, cy, d0, d1, steps = 8) {
  const at = (d) => [
    { x: cx - d / 2, y: cy, id: 1 },
    { x: cx + d / 2, y: cy, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(d0) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(d0 + ((d1 - d0) * i) / steps) });
    await wait(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function computed(page, tap) {
  await page.goto(BASE);
  await (tap ? page.tap('[data-testid="sample-portrait"]') : page.click('[data-testid="sample-portrait"]'));
  await page.waitForSelector('[data-testid="compute-btn"]');
  await (tap ? page.tap('[data-testid="compute-btn"]') : page.click('[data-testid="compute-btn"]'));
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
  await page.waitForSelector('[data-testid="preview-tools"]');
  await wait(1200);
}

async function phone(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'de-DE' });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await computed(page, true);

  // ---------- Schnellschalter in der Werkzeugleiste (Finding 3)
  const quick = await page.$eval('[data-testid="deviation-quick"]', (b) => {
    const r = b.getBoundingClientRect();
    const h = document.querySelector('.w5ue-toolbar .w5ue-history').getBoundingClientRect();
    return { shown: getComputedStyle(b).display !== 'none', text: b.innerText.trim(), label: b.getAttribute('aria-label'), sameRow: Math.abs(r.top + r.height / 2 - (h.top + h.height / 2)) < 4 && h.height < 56, h: Math.round(r.height), right: Math.round(r.right) };
  });
  check('Handy: Abweichungskarte als kompakter Schalter über dem Mosaik, in einer Zeile mit Rückgängig/Wiederholen', quick.shown && quick.text === 'Karte' && quick.label === 'Abweichungskarte' && quick.sameRow && quick.h >= 40 && quick.right <= 390, JSON.stringify(quick));
  // weit nach unten blättern, dann Karte über den Reiter einschalten: Mosaik kommt ins Bild
  await page.$eval('[data-testid="preview-tools"]', (e) => e.scrollIntoView({ block: 'start' }));
  await page.tap('[data-testid="tool-deviation"]');
  await page.waitForSelector('[data-testid="deviation-item"]');
  const heading = await page.textContent('.w6fx-tools-h');
  check('Werkzeugkarte mit Überschrift', heading.trim() === 'Werkzeuge: Abweichung · Bereich bearbeiten · Bild', heading);
  const head = await page.$eval('.w6fx-top-head', (e) => ({ text: e.innerText.replace(/\s+/g, ' '), shown: e.getBoundingClientRect().height > 0 }));
  check('Liste „Größte Abweichungen“: sichtbare Spaltenköpfe Foto ↔ Stein', head.shown && /Foto ↔ Stein/.test(head.text), head.text);
  const itemText = await page.textContent('[data-testid="deviation-item"] .w6cb-de');
  check('ΔE in der Liste in Worten', /^(kaum sichtbar|erkennbar|deutlich|stark) \(\d+,\d\)$/.test(itemText.trim()), itemText);
  await page.$eval('[data-testid="deviation-toggle"]', (e) => e.scrollIntoView({ block: 'center' }));
  await page.tap('[data-testid="deviation-panel"] .toggle');
  await page.waitForSelector('[data-testid="deviation-legend"]');
  await wait(900);
  const leg = await rect(page, '[data-testid="deviation-legend"]');
  const legText = (await page.textContent('[data-testid="deviation-legend"]')).replace(/\s+/g, ' ');
  check('Karte an: Legende und Mosaik ins Bild geholt', leg.top >= 0 && leg.top < 200, `Legende oben bei ${Math.round(leg.top)} px`);
  check(
    'Legende in Worten: kaum sichtbar (< 2) · erkennbar (2–5) · deutlich (5–10) · stark (> 10)',
    /kaum sichtbar \(< 2\)/.test(legText) && /erkennbar \(2–5\)/.test(legText) && /deutlich \(5–10\)/.test(legText) && /stark \(> 10\)/.test(legText),
    legText.slice(0, 160),
  );
  await shot(page, 'p1-karte');

  // ---------- Sprung aus der Liste: Abweichung im Blatt, Stein über dem Blatt sichtbar (Finding 1)
  await page.$eval('[data-testid="deviation-item"]', (e) => e.scrollIntoView({ block: 'center' }));
  const first = await page.$eval('[data-testid="deviation-item"]', (e) => ({ id: e.dataset.id, de: +e.dataset.de }));
  await page.tap('[data-testid="deviation-item"] >> nth=0');
  await page.waitForSelector('[data-testid="stone-id"]');
  await wait(900);
  const inSheet = await page.$eval('[data-testid="deviation-stone"]', (e) => !!e.closest('.modal'));
  const devTxt = (await page.textContent('[data-testid="deviation-stone"]')).replace(/\s+/g, ' ');
  const sheet = await rect(page, '.modal');
  const bar = await rect(page, '.topbar');
  const m = first.id.match(/^([A-Z]+)(\d+)/);
  const cc = await cellCenter(page, rowOf(m[1]), parseInt(m[2], 10) - 1);
  const stg = await rect(page, '.w6cb-stage');
  check('Steindetail (Blatt) enthält Fotofarbe und Abweichung in Worten', inSheet && /Foto/.test(devTxt) && /Abweichung: (kaum sichtbar|erkennbar|deutlich|stark) \(ΔE/.test(devTxt), devTxt.slice(0, 140));
  check(
    'Der gewählte Stein liegt sichtbar über dem Blatt',
    cc.y > bar.bottom + 4 && cc.y < sheet.top - 4 && cc.y > stg.top && cc.x > stg.left && cc.x < stg.right && sheet.height <= 0.6 * 844 + 2,
    `Stein bei y=${Math.round(cc.y)}, Kopfzeile bis ${Math.round(bar.bottom)}, Blatt ab ${Math.round(sheet.top)} (${Math.round(sheet.height)} px hoch)`,
  );
  await shot(page, 'p2-stein-ueber-blatt');
  // erst weg von der Fotofarbe umfärben (die Farbe des Spitzenreiters ist oft schon die nächste), dann „übernehmen“
  if (await page.$('[data-testid="colors-all"]')) await page.tap('[data-testid="colors-all"]');
  const far = await page.$$eval('[data-testid="color-pick"] button.cp', (bs) =>
    bs
      .map((b) => ({ code: b.dataset.code, de: parseFloat((b.title.match(/ΔE ([\d,]+)/) || [])[1]?.replace(',', '.') ?? '0'), active: b.classList.contains('active') }))
      .filter((x) => !x.active)
      .sort((a, b) => b.de - a.de)[0],
  );
  await page.$eval(`[data-testid="color-pick"] button.cp[data-code="${far.code}"]`, (e) => e.scrollIntoView({ block: 'center' }));
  await page.tap(`[data-testid="color-pick"] button.cp[data-code="${far.code}"]`);
  await wait(400);
  const devStone = await page.$eval('[data-testid="deviation-stone"]', (e) => +e.dataset.de);
  check('Umfärben weg von der Fotofarbe: Abweichung im Blatt steigt', devStone > first.de, `${first.de.toFixed(2)} → ${devStone.toFixed(2)}`);
  await page.$eval('[data-testid="deviation-stone-apply"]', (e) => e.scrollIntoView({ block: 'center' }));
  await page.tap('[data-testid="deviation-stone-apply"]');
  const deAfter = await until(async () => {
    const v = await page.$eval('[data-testid="deviation-stone"]', (e) => +e.dataset.de);
    return v < devStone ? v : null;
  });
  const applyTxt = await page.textContent('[data-testid="deviation-stone"]').catch(() => '');
  check('„→ Nächste Farbe … übernehmen“ im Blatt senkt die Abweichung des Steins', deAfter !== null && deAfter < devStone, `${devStone.toFixed(2)} → ${deAfter?.toFixed(2)}`);
  check('nach dem Übernehmen: „bereits die nächste Palettenfarbe“', /bereits die nächste Palettenfarbe/.test(applyTxt));
  await page.tap('[data-testid="modal-close"]');
  await wait(300);
  // Karte wieder aus (ruhigeres Bild für den Bereich)
  await page.tap('[data-testid="deviation-quick"]');
  await wait(200);

  // ---------- Rechteck aufziehen am Handy (Finding 5)
  await page.$eval('[data-testid="preview-tools"]', (e) => e.scrollIntoView({ block: 'start' }));
  await page.tap('[data-testid="tool-batch"]');
  await page.waitForSelector('[data-testid="batch-panel"]');
  await page.tap('[data-testid="viewer-fit"]').catch(() => {});
  await page.$eval('[data-testid="batch-rect-mode"]', (e) => e.scrollIntoView({ block: 'center' }));
  await page.tap('[data-testid="batch-rect-mode"]');
  await wait(800);
  const banner = await page.$('[data-testid="rect-banner"]');
  const bannerTxt = banner ? (await banner.innerText()).replace(/\s+/g, ' ') : '';
  const bRect = banner ? await rect(page, '[data-testid="rect-banner"]') : null;
  const hint = await page.textContent('[data-testid="batch-panel"]');
  check(
    'Rechteck-Modus: Hinweisleiste über dem Mosaik („Mit einem Finger …“ · Abbrechen), sichtbar im Fenster',
    !!banner && /Mit einem Finger ein Rechteck ziehen/.test(bannerTxt) && /Abbrechen/.test(bannerTxt) && bRect.top >= 0 && bRect.bottom <= 844,
    bannerTxt,
  );
  check('Handy: Hinweis ohne Leertaste/Maustaste', !/Leertaste|Maustaste/.test(hint) && /zwei Finger/.test(hint));
  await shot(page, 'p3-rechteck-modus');
  const box = await page.$eval('[data-testid="mosaic-canvas"]', (c) => {
    const r = c.getBoundingClientRect();
    const s = +c.dataset.scale;
    return { x: r.left + +c.dataset.ox, y: r.top + +c.dataset.oy, w: +c.dataset.fw * s, h: +c.dataset.fh * s, top: r.top, bottom: r.bottom };
  });
  const y0 = Math.max(box.top + 10, box.y + box.h * 0.35);
  const y1 = Math.min(box.bottom - 10, box.y + box.h * 0.6);
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push({ x: box.x + box.w * (0.3 + 0.3 * (i / 10)), y: y0 + (y1 - y0) * (i / 10) });
  await touchDrag(cdp, pts);
  await page.waitForSelector('[data-testid="batch-selection"]', { timeout: 5000 }).catch(() => {});
  await wait(500);
  const sel = await page.$('[data-testid="batch-selection"]');
  const selBanner = await page.$('[data-testid="selection-banner"]');
  const stage2 = await rect(page, '.w6cb-stage');
  const drawn = await page.$eval('[data-testid="deviation-overlay"]', (c) => c.dataset.drawn === '1').catch(() => false);
  check('Nach dem Aufziehen: Auswahl bleibt sichtbar (Umriss im Mosaik, Leiste mit „Zu den Aktionen“)', !!sel && !!selBanner && drawn && stage2.top < 844 && stage2.bottom > 0, `Mosaik ${Math.round(stage2.top)}–${Math.round(stage2.bottom)} px`);
  await shot(page, 'p4-auswahl');
  if (selBanner) await page.tap('[data-testid="selection-banner-actions"]');
  await wait(700);
  const panel = await rect(page, '[data-testid="batch-apply"]');
  check('„Zu den Aktionen“ holt „Anwenden“ ins Bild', panel.top >= 0 && panel.bottom <= 844, `${Math.round(panel.top)} px`);
  const scaleBefore = await page.$eval('[data-testid="mosaic-canvas"]', (c) => +c.dataset.scale);
  await page.tap('[data-testid="batch-apply"]');
  await page.waitForSelector('[data-testid="batch-status"]');
  const status = await page.textContent('[data-testid="batch-status"]');
  check('Handy: Ergebnis mit „Im Mosaik ansehen“, Hinweis ohne Strg+Z', /Im Mosaik ansehen/.test(status) && /↶ über dem Mosaik/.test(status) && !/Strg/.test(status), status.replace(/\s+/g, ' '));
  await page.$eval('[data-testid="viewer-fit"]', (b) => b.click());
  await page.tap('[data-testid="batch-show"]');
  await wait(900);
  const stage3 = await rect(page, '.w6cb-stage');
  const scaleAfter = await page.$eval('[data-testid="mosaic-canvas"]', (c) => +c.dataset.scale);
  const drawn2 = await page.$eval('[data-testid="deviation-overlay"]', (c) => c.dataset.drawn === '1');
  check('„Im Mosaik ansehen“: Mosaik im Bild, auf den Bereich gezoomt, Umriss sichtbar', stage3.top >= 0 && stage3.top < 300 && scaleAfter > scaleBefore && drawn2, `Mosaik oben ${Math.round(stage3.top)} px, Maßstab ${scaleBefore.toFixed(2)} → ${scaleAfter.toFixed(2)}`);
  await shot(page, 'p5-ergebnis');

  // ---------- Heller/Dunkler: großer Sprung, Zeilen abwählen (Finding 9)
  await page.$eval('[data-testid="batch-scope"]', (e) => e.scrollIntoView({ block: 'center' }));
  await page.tap('[data-testid="batch-scope"] button >> nth=2');
  await page.tap('[data-testid="batch-action"] button >> nth=1');
  await page.waitForSelector('[data-testid="batch-map"]');
  let best = null;
  for (const dir of [0, 1]) {
    await page.tap(`[data-testid="batch-dir"] button >> nth=${dir}`);
    await wait(300);
    const rows = await page.$$eval('[data-testid="batch-map"] tr', (rs) => rs.map((r) => ({ big: r.dataset.big === '1', to: !!r.dataset.to, n: +r.querySelector('td.num').textContent.replace(/\D/g, '') })));
    const bigN = rows.filter((r) => r.big).length;
    if (!best || bigN > best.bigN) best = { dir, rows, bigN };
  }
  await page.tap(`[data-testid="batch-dir"] button >> nth=${best.dir}`);
  await wait(300);
  const dry0 = await page.$eval('[data-testid="batch-dryrun"]', (e) => ({ n: +e.dataset.count, kept: +e.dataset.kept, skipped: +e.dataset.skipped }));
  const bigBadges = await page.$$eval('[data-testid="batch-shade-big"]', (b) => b.length);
  const bigRowsWithDe = await page.$$eval('[data-testid="batch-map"] tr[data-big="1"]', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')));
  check('Große Sprünge gekennzeichnet (Abweichung > 8, „großer Sprung“), Stufen in Worten', bigBadges === best.bigN && bigRowsWithDe.every((t) => /großer Sprung/.test(t) && /Stufen (heller|dunkler)/.test(t)), `${best.bigN} von ${best.rows.length} Zeilen: ${bigRowsWithDe.slice(0, 2).join(' | ')}`);
  const idx = best.rows.findIndex((r) => r.big) >= 0 ? best.rows.findIndex((r) => r.big) : best.rows.findIndex((r) => r.to);
  const rowPieces = best.rows[idx].n;
  const useIdx = best.rows.slice(0, idx).filter((r) => r.to).length;
  await page.$eval(`[data-testid="batch-map"] tr:nth-child(${idx + 1})`, (e) => e.scrollIntoView({ block: 'center' }));
  await page.tap(`[data-testid="batch-shade-use"] >> nth=${useIdx}`);
  await wait(300);
  const dry1 = await page.$eval('[data-testid="batch-dryrun"]', (e) => ({ n: +e.dataset.count, kept: +e.dataset.kept, skipped: +e.dataset.skipped, text: e.textContent }));
  check('Zeile abgewählt: Probelauf zählt nur die angehakten Zeilen', dry1.n === dry0.n - rowPieces && dry1.skipped === rowPieces && dry1.kept === dry0.kept && /abgewählt/.test(dry1.text), `${dry0.n} → ${dry1.n} (abgewählt ${dry1.skipped})`);
  await page.$eval('[data-testid="batch-apply"]', (e) => e.scrollIntoView({ block: 'center' }));
  await page.tap('[data-testid="batch-apply"]');
  await page.waitForSelector('[data-testid="batch-status"]');
  const applied = await page.$eval('[data-testid="batch-status"]', (e) => +e.dataset.count);
  check('Angewendet: genau die Zahl des Probelaufs (ohne abgewählte Zeile)', applied === dry1.n, `${applied} Steine`);
  await shot(page, 'p6-heller-dunkler');

  // ---------- Form zurücksetzen: Farbregel im Probelauf (Finding 8)
  await page.tap('[data-testid="batch-action"] button >> nth=2');
  await wait(300);
  const rule = await page.$('[data-testid="batch-shape-rule"]');
  const ruleTxt = rule ? await rule.innerText() : '';
  const shapeDry = await page.textContent('[data-testid="batch-dryrun"]');
  check('Form zurücksetzen: Probelauf nennt die Farbregel (Fotofarbe / größte Fläche), nicht „erstes Teil“', !!rule && /Fotofarbe|größten Fläche/.test(ruleTxt) && !/ersten Teils/.test(shapeDry), ruleTxt.replace(/\s+/g, ' ').slice(0, 140));
  check('Handy: kein waagrechtes Scrollen', (await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0);

  // ---------- Live-Vorschau am Handy (Finding 4)
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.tap('[data-testid="step-shapes"]');
  await page.waitForSelector('[data-testid="live-preview"]');
  await wait(800);
  const lpOpen = await page.$eval('[data-testid="live-preview"]', (e) => e.classList.contains('w3lp-collapsed'));
  if (lpOpen) await page.tap('[data-testid="live-preview-toggle"]');
  await wait(600);
  await page.evaluate(() => window.scrollTo(0, 500));
  await wait(300);
  const lp = await rect(page, '[data-testid="live-preview"]');
  check('Live-Vorschau am Handy: kleines Vorschaubild (≤ 25 % der Höhe), klebt unter der Kopfzeile', lp.height <= 0.25 * 844 && lp.top <= bar.bottom + 4, `${Math.round(lp.height)} px hoch, oben ${Math.round(lp.top)} px`);
  await shot(page, 'p7-live-vorschau');
  const drawBtn = await page.$('[data-testid="region-draw-toggle"]');
  if (drawBtn) {
    await page.$eval('[data-testid="region-draw-toggle"]', (e) => e.scrollIntoView({ block: 'center' }));
    await page.tap('[data-testid="region-draw-toggle"]');
    await wait(500);
    const st = await page.$eval('[data-testid="live-preview"]', (e) => ({ auto: e.dataset.autoHidden, canvas: !!e.querySelector('[data-testid="live-preview-canvas"]'), h: e.getBoundingClientRect().height }));
    check('„Bereich zeichnen“ aktiv: Live-Vorschau eingeklappt (mit Hinweis)', st.auto === '1' && !st.canvas && st.h < 90, JSON.stringify(st));
    await shot(page, 'p8-bereich-zeichnen');
    await page.tap('[data-testid="region-draw-toggle"]');
    await wait(500);
    const back = await page.$eval('[data-testid="live-preview"]', (e) => e.dataset.autoHidden);
    check('Zeichnen beendet: Vorschau wieder sichtbar', back === '0');
  } else check('Schritt 6 hat „Bereich zeichnen“', false);

  // ---------- Farbe messen am Handy (Finding 6)
  await page.goto(BASE + '#/materials');
  await page.waitForSelector('[data-testid="add-material"]');
  await page.tap('[data-testid="add-material"]');
  await page.tap('[data-testid="measure-open"]');
  await page.waitForSelector('[data-testid="measure-dialog"]');
  check('Neues Material (Platzhalter #808080): kein „Bisher“ vor dem Foto', !(await page.$('[data-testid="measure-current-hex"]')));
  const png = await page.evaluate(async () => {
    const cv = document.createElement('canvas');
    cv.width = 1200;
    cv.height = 800;
    const g = cv.getContext('2d');
    g.fillStyle = '#2b2a28';
    g.fillRect(0, 0, 1200, 800);
    g.fillStyle = '#e8e4dc';
    g.fillRect(60, 150, 400, 500);
    g.fillStyle = '#3a6ea5';
    g.fillRect(760, 200, 340, 400);
    const b = await new Promise((r) => cv.toBlob(r, 'image/png'));
    const u = new Uint8Array(await b.arrayBuffer());
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  });
  await page.setInputFiles('[data-testid="measure-file"]', { name: 'stein.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForSelector('[data-testid="measure-canvas"]');
  await wait(400);
  const stageR = await rect(page, '.w6cm-stage');
  const zoomR = await rect(page, '[data-testid="measure-zoom"]');
  check('Zoom-Knöpfe unter dem Foto (verdecken es nicht)', zoomR.top >= stageR.bottom - 1, `Foto bis ${Math.round(stageR.bottom)}, Knöpfe ab ${Math.round(zoomR.top)}`);
  const cvb = await page.locator('[data-testid="measure-canvas"]').boundingBox();
  await page.locator('[data-testid="measure-canvas"]').tap({ position: { x: (260 / 1200) * cvb.width, y: (400 / 800) * cvb.height } });
  await wait(200);
  await page.locator('[data-testid="measure-canvas"]').tap({ position: { x: (930 / 1200) * cvb.width, y: (400 / 800) * cvb.height } });
  await wait(300);
  const res = (await page.textContent('[data-testid="measure-result"]')).replace(/\s+/g, ' ');
  check('Neues Material: weder „Bisher“ noch Abweichung zum bisherigen Wert', !(await page.$('[data-testid="measure-current"]')) && !(await page.$('[data-testid="measure-de"]')) && !/bisherigen/.test(res), res.slice(0, 120));
  check('Lab und ΔE erklärt (aufklappbar)', !!(await page.$('[data-testid="measure-explain"]')) && /Was bedeuten Lab und ΔE/.test(res));
  const z0 = await page.$eval('[data-testid="measure-zoom"]', (e) => +e.dataset.zoom);
  const st = await rect(page, '.w6cm-stage');
  await pinch(cdp, st.left + st.width / 2, st.top + st.height / 2, 60, 200);
  await wait(400);
  const z1 = await page.$eval('[data-testid="measure-zoom"]', (e) => +e.dataset.zoom);
  const hexAfterPinch = (await page.textContent('[data-testid="measure-hex"]')).trim();
  check('Zwei-Finger-Zoom vergrößert das Foto (ohne zu messen)', z0 === 1 && z1 > 2 && /^#[0-9A-F]{6}$/.test(hexAfterPinch), `Zoom ${z0} → ${z1.toFixed(2)}`);
  await shot(page, 'p9-messen');
  // vorhandene Farbe: Abweichung in Worten
  await page.tap('[data-testid="measure-apply"]');
  await page.waitForSelector('[data-testid="measure-dialog"]', { state: 'detached' });
  await page.fill('[data-testid="mat-hex"]', '#C0392B');
  await page.tap('[data-testid="measure-open"]');
  await page.setInputFiles('[data-testid="measure-file"]', { name: 'stein.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForSelector('[data-testid="measure-canvas"]');
  await wait(300);
  const cvb2 = await page.locator('[data-testid="measure-canvas"]').boundingBox();
  await page.locator('[data-testid="measure-canvas"]').tap({ position: { x: (260 / 1200) * cvb2.width, y: (400 / 800) * cvb2.height } });
  await wait(200);
  await page.locator('[data-testid="measure-canvas"]').tap({ position: { x: (930 / 1200) * cvb2.width, y: (400 / 800) * cvb2.height } });
  await wait(300);
  const de = await page.textContent('[data-testid="measure-de"]').catch(() => '');
  check('Mit echter Farbe: „Abweichung zum bisherigen Wert: stark (…)“ statt „ΔE00“', /^Abweichung zum bisherigen Wert: (kaum sichtbar|erkennbar|deutlich|stark) \(\d+,\d\)$/.test(de.trim()) && !!(await page.$('[data-testid="measure-current"]')), de);
  await page.tap('[data-testid="measure-cancel"]');

  check('Handy: keine Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

async function desktop(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await computed(page, false);
  const q = await page.$eval('[data-testid="deviation-quick"]', (b) => b.innerText.trim());
  check('Desktop: Schalter heißt „Abweichungskarte“', q === 'Abweichungskarte', q);
  await page.click('[data-testid="tool-deviation"]');
  await page.waitForSelector('[data-testid="deviation-item"]');
  await page.click('[data-testid="deviation-item"] >> nth=0');
  await page.waitForSelector('[data-testid="stone-panel"]');
  const inPanel = await page.$eval('[data-testid="deviation-stone"]', (e) => !!e.closest('[data-testid="stone-panel"]'));
  check('Desktop: Abweichung im Steindetail neben dem Mosaik', inPanel);
  await page.click('[data-testid="tool-batch"]');
  await page.click('[data-testid="batch-scope"] button >> nth=2');
  await page.click('[data-testid="batch-apply"]');
  await page.waitForSelector('[data-testid="batch-status"]');
  const st = await page.textContent('[data-testid="batch-status"]');
  check('Desktop: Hinweis nennt Strg+Z', /Strg\+Z/.test(st), st.replace(/\s+/g, ' '));
  await page.click('[data-testid="batch-action"] button >> nth=1');
  await page.waitForSelector('[data-testid="batch-map"]');
  await shot(page, 'd1-heller-dunkler');

  // Sprachen: keine fehlenden Texte, keine Großbuchstaben-„PALETTE“
  for (const [lang, label] of [
    ['en', 'English'],
    ['tr', 'Türkçe'],
  ]) {
    await page.goto(BASE + '#/settings');
    await page.click(`[data-testid="lang-select"] >> text=${label}`);
    await page.waitForTimeout(200);
    await page.goBack();
    await page.goto(BASE);
    await page.click('[data-testid="sample-portrait"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="preview-tools"]', { timeout: 180000 });
    await wait(800);
    await page.click('[data-testid="deviation-quick"]');
    await page.click('[data-testid="tool-batch"]');
    await page.click('[data-testid="batch-scope"] button >> nth=2');
    await page.click('[data-testid="batch-action"] button >> nth=1');
    await page.waitForSelector('[data-testid="batch-map"]');
    const txt = await page.evaluate(() => document.body.innerText);
    check(`${lang.toUpperCase()}: keine Schlüssel sichtbar, kein „PALETTE“ in Großbuchstaben`, !/w6fx\.|w6cb\./.test(txt) && !/PALETTE|PALET\b/.test(txt), (txt.match(/w6fx\.[\w.]+/) || [''])[0]);
    await shot(page, `d2-${lang}`);
  }
  await page.goto(BASE + '#/settings');
  await page.click('[data-testid="lang-select"] >> text=Deutsch');
  check('Desktop: keine Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await phone(browser);
    await desktop(browser);
  } catch (e) {
    failed++;
    console.log(`✘ Abbruch: ${e && e.stack ? e.stack : e}`);
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
  process.exit(failed ? 1 : 0);
})();
