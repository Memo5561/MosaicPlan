/* Browser-Test w4-cut-placement-accents: Schnitte auf markierte Bereiche konzentrieren (Schritt 6), exakte Zählung
 * „davon in markierten Bereichen“ (Schritt 7), „Konturen durchgehend schneiden“, fehlende Akzentfarben mit
 * „Als Pflichtfarbe übernehmen“, Pflichtfarben-Liste (Schritt 5), Sprachen, Handy-Layout.
 * Aufruf: node e2e/w4-cut-placement-accents.e2e.cjs <baseUrl> <outDir>   (vorher: npm run build && npx vite preview)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output', 'w4-cut-placement-accents');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const num = (s) => parseInt(String(s).replace(/\./g, '').match(/\d+/)?.[0] ?? 'NaN', 10);

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  async function newPage(viewport) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('dialog', (d) => d.accept());
    return { context, page };
  }
  /** Berechnen (bzw. passende Vorschau übernehmen) und zurück zu Schritt 7 */
  const compute = async (page) => {
    await page.click('[data-testid="step-compute"]');
    await page.waitForSelector('[data-testid="compute-btn"]', { timeout: 60000 });
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="recompute-guard"], [data-testid="mosaic-canvas"]', { timeout: 120000 });
    if (await page.isVisible('[data-testid="recompute-guard"]')) await page.click('[data-testid="guard-nobackup"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
    await page.waitForTimeout(400);
    await page.click('[data-testid="step-compute"]');
    await page.waitForSelector('[data-testid="diagnostics"]', { timeout: 30000 });
  };
  const diag = async (page) =>
    page.evaluate(() => {
      const tx = (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() ?? null;
      return { split: tx('split-cells'), sub: tx('sub-cells'), region: tx('region-cells'), bg: tx('bg-factor'), contour: tx('contour') };
    });
  const inRegion = (s) => {
    const m = /\(davon ([\d.]+) in markierten Bereichen\)/.exec(s || '');
    return m ? parseInt(m[1].replace(/\./g, ''), 10) : NaN;
  };
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  // ================================================================ A: Porträt mit Gesichtsbereich
  const { context, page } = await newPage({ width: 1360, height: 900 });
  await page.goto(BASE);
  await page.waitForSelector('[data-testid="sample-portrait"]');
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"], [data-testid="step-shapes"]');
  const projUrl = page.url().replace(/\/[a-z]+$/, '');

  // ---------- Schritt 6: Schnitte verteilen
  await page.click('[data-testid="step-shapes"]');
  await page.waitForSelector('[data-testid="cut-focus"]');
  const box = await page.textContent('[data-testid="cut-focus"]');
  check('Schritt 6: „Schnitte verteilen“ mit Regler „Schnitte außerhalb markierter Bereiche“ (viele … wenige), da ein Gesichtsbereich existiert', /Schnitte außerhalb markierter Bereiche/.test(box) && /viele/.test(box) && /wenige/.test(box) && !!(await page.$('[data-testid="cut-focus"] input[type="range"]')), box.slice(0, 90));
  check('Voreinstellung „Schnitte auf Gesicht konzentrieren“ und Hinweis „Haare … als Detailbereich markieren“', !!(await page.$('[data-testid="cut-focus-preset"]')) && /Schnitte auf Gesicht konzentrieren/.test(box) && /Haare und wichtige Konturen als Detailbereich/.test(box));
  const ccEnabled = await page.$eval('[data-testid="contour-continuity"]', (el) => !el.disabled && !el.checked);
  check('Schalter „Konturen durchgehend schneiden“ vorhanden (aus, bedienbar)', ccEnabled);
  await page.locator('[data-testid="cut-focus"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'w4cpa-01-shapes.png') });

  // ---------- Schritt 7: Ausgangslage
  await compute(page);
  const d0 = await diag(page);
  const split0 = num(d0.split);
  const in0 = inRegion(d0.split);
  check('Schritt 7: „Zellen mit Schnitt … (davon N in markierten Bereichen)“ für Kanten- und Teilsteine', Number.isFinite(in0) && in0 > 0 && in0 < split0 && /in markierten Bereichen/.test(d0.sub || ''), `${d0.split} | ${d0.sub}`);
  check('Zeile „Zellen in markierten Bereichen“ und Anteil durchgehender Kantenschnitte', !!d0.region && /\d+ von \d+ \(\d+ %\)/.test(d0.contour || ''), `${d0.region} | ${d0.contour}`);
  // Welche Akzentfarben fehlen, hängt vom Ergebnis ab (die L* < 15-Pupillen prüft der Unit-Test auf dem Rechenkern);
  // hier: Form und Ehrlichkeit der Anzeige
  const accItems = (sel) => page.$$eval(sel, (els) => els.map((e) => ({ hex: e.getAttribute('data-hex'), l: parseFloat(e.getAttribute('data-l')), text: e.textContent })));
  const acc = await accItems('[data-testid="compute-accents-item"]');
  const accTxt = (await page.textContent('[data-testid="compute-accents"], [data-testid="compute-accents-none"]').catch(() => '')) || '';
  check(
    'Fehlende Akzentfarben: „N Steine ohne passende Farbe (Ø ΔE00 x) – Vorschlag #HEX“ mit mindestens 2 Steinen, höchstens 3 Vorschläge',
    acc.length >= 1 && acc.length <= 3 && acc.every((a) => /^\d+ Steine ohne passende Farbe \(Ø\sΔE00\s\d+,\d\) – Vorschlag\s#[0-9A-F]{6}/.test(a.text) && num(a.text) >= 2),
    acc.map((a) => a.text.slice(0, 60)).join(' | '),
  );
  check(
    'Vorschlag: gemessener Mittelwert (L*a*b*), Abstand zur nächsten Palettenfarbe > 5, Steinbezeichnungen; Erklärung ohne Behauptung über die Steine',
    acc.every((a) => /L \d+,\d a -?\d+,\d b -?\d+,\d/.test(a.text) && /Steine: [A-Z]+\d{3}(-\d)?/.test(a.text)) && /gemessene Mittelwert/.test(accTxt) && /mehr als ΔE00 10,0/.test(accTxt),
  );
  await page.locator('[data-testid="compute-accents"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'w4cpa-02-compute-accents.png') });

  // ---------- Schnitte konzentrieren (×3)
  await page.click('[data-testid="step-shapes"]');
  await page.click('[data-testid="cut-focus-preset"]');
  await page.waitForSelector('[data-testid="cut-focus-active"]');
  const sliderTxt = await page.textContent('[data-testid="cut-focus"] .slider-head');
  check('Voreinstellung setzt ×3 (Anzeige „weniger (×3)“)', /weniger \(×3\)/.test(sliderTxt), sliderTxt.trim());
  await page.waitForSelector('[data-testid="stale-badge"]');
  await page.click('[data-testid="step-compute"]');
  const stale = await page.textContent('[data-testid="stale-reasons"]').catch(() => '');
  check('Projekt gilt als geändert: „Steinformen“', /Steinformen/.test(stale), stale.slice(0, 80));
  await compute(page);
  const d1 = await diag(page);
  const split1 = num(d1.split);
  const in1 = inRegion(d1.split);
  check('Nach ×3: weniger Schnittzellen außerhalb, im Gesicht unverändert (exakt gezählt)', split1 - in1 < split0 - in0 && in1 === in0, `außen ${split0 - in0} → ${split1 - in1}, innen ${in0} → ${in1}`);
  check('Zeile „Schnitte außerhalb markierter Bereiche: Schnitt ×3 teurer“', /×3 teurer/.test(d1.bg || ''), d1.bg);

  // ---------- Konturen durchgehend
  await page.click('[data-testid="step-shapes"]');
  await page.click('[data-testid="contour-continuity"] + .toggle-track');
  await page.waitForTimeout(200);
  const ccOn = await page.$eval('[data-testid="contour-continuity"]', (el) => el.checked);
  check('„Konturen durchgehend schneiden“ eingeschaltet', ccOn);
  await compute(page);
  const d2 = await diag(page);
  const pct = (s) => parseInt(/\((\d+) %\)/.exec(s || '')?.[1] ?? 'NaN', 10);
  check('Ergebnis nennt „mit Konturen durchgehend“ und einen höheren Anteil durchgehender Kantenschnitte', /Konturen durchgehend/.test(d2.contour || '') && pct(d2.contour) > pct(d1.contour), `${d1.contour} → ${d2.contour}`);

  // ---------- Schritt 5: Akzentfarbe als Pflichtfarbe übernehmen
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="pinned-colors"]');
  check('Schritt 5: Pflichtfarben-Liste (leer) im Modus „Automatisch aus dem Foto“', !!(await page.$('[data-testid="pinned-empty"]')));
  await page.waitForSelector('[data-testid="colors-accents"]');
  const items = await accItems('[data-testid="colors-accents-item"]');
  await page.click('[data-testid="step-compute"]');
  await page.waitForSelector('[data-testid="compute-accents"]');
  const items7 = await accItems('[data-testid="compute-accents-item"]');
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="colors-accents"]');
  // bevorzugt ein dunkler Vorschlag (Pupillen), sonst der wichtigste
  const darkHex = (items.find((a) => a.l < 15) || items[0] || {}).hex;
  check('Schritt 5 und 7 zeigen dieselben fehlenden Akzentfarben', !!darkHex && items.map((a) => a.hex).join() === items7.map((a) => a.hex).join(), `${items.map((a) => `${a.hex}/L${Math.round(a.l)}`).join(', ')}`);
  await page.click(`[data-testid="colors-accents-item"][data-hex="${darkHex}"] [data-testid="colors-accents-pin"]`);
  await page.waitForSelector(`[data-testid="pinned-row"][data-hex="${darkHex}"]`);
  const notice = await page.textContent('[data-testid="colors-accents-notice"]');
  const pinnedLbl = await page.textContent(`[data-testid="colors-accents-item"][data-hex="${darkHex}"]`);
  check('„Als Pflichtfarbe übernehmen“: Farbe steht in der Liste, Hinweis „wirkt bei der nächsten Berechnung“', /wirkt bei der nächsten Berechnung/.test(notice) && /✓ Pflichtfarbe/.test(pinnedLbl), notice.trim());
  const status0 = await page.textContent(`[data-testid="pinned-row"][data-hex="${darkHex}"] [data-testid="pinned-status"]`);
  check('Status vor der Berechnung: „wird bei der nächsten Berechnung verwendet“', /wird bei der nächsten Berechnung verwendet/.test(status0), status0);
  await page.locator('[data-testid="pinned-colors"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'w4cpa-03-colors-pinned.png') });
  await page.click('[data-testid="step-compute"]');
  const stale2 = await page.textContent('[data-testid="stale-reasons"]').catch(() => '');
  check('Nur die Einstellungen geändert → „Pflichtfarben“ als Grund, Ergebnis bleibt bis zum Neuberechnen', /Pflichtfarben/.test(stale2), stale2.slice(0, 80));

  // ---------- Pflichtfarben-Liste bedienen
  await page.click('[data-testid="step-colors"]');
  await page.fill('[data-testid="pinned-hex"]', 'xyz');
  await page.click('[data-testid="pinned-add"]');
  const err1 = await page.textContent('[data-testid="pinned-error"]').catch(() => '');
  await page.fill('[data-testid="pinned-hex"]', darkHex.toLowerCase());
  await page.click('[data-testid="pinned-add"]');
  const err2 = await page.textContent('[data-testid="pinned-error"]').catch(() => '');
  check('Ungültiger HEX-Wert und doppelte Farbe werden abgelehnt (mit Meldung)', /Ungültiger HEX-Wert/.test(err1) && /schon Pflichtfarbe/.test(err2), `${err1} | ${err2}`);
  await page.fill('[data-testid="pinned-hex"]', '#fafafa');
  await page.click('[data-testid="pinned-add"]');
  await page.waitForSelector('[data-testid="pinned-row"][data-hex="#FAFAFA"]');
  const rows2 = await page.$$eval('[data-testid="pinned-row"]', (r) => r.length);
  await page.click('[data-testid="pinned-row"][data-hex="#FAFAFA"] [data-testid="pinned-remove"]');
  await page.waitForTimeout(150);
  const rows3 = await page.$$eval('[data-testid="pinned-row"]', (r) => r.length);
  check('Pflichtfarbe hinzufügen (normalisiert #FAFAFA) und wieder entfernen', rows2 === 2 && rows3 === 1, `${rows2} → ${rows3}`);

  // ---------- Neu berechnen: Status ehrlich (nur Werte der Berechnung)
  await compute(page);
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector(`[data-testid="pinned-row"][data-hex="${darkHex}"]`);
  const status1 = (await page.textContent(`[data-testid="pinned-row"][data-hex="${darkHex}"] [data-testid="pinned-status"]`)).trim();
  const inPalette = await page.$$eval('[data-testid="palette-table"] td[data-col="hexlab"]', (tds, hex) => tds.some((td) => td.textContent.startsWith(hex)), darkHex);
  if (inPalette) check('Nach dem Neuberechnen: Pflichtfarbe mit genau diesem HEX in der Palette, Status „in der Palette · N Steine“', /in der Palette · \d+ Steine?/.test(status1), status1);
  else
    check(
      'Nach dem Neuberechnen ohne Pflichtfarbe im Ergebnis: Status bleibt ehrlich „wird bei der nächsten Berechnung verwendet“ (Weitergabe an die Berechnung: w4-progress-engine)',
      /wird bei der nächsten Berechnung verwendet/.test(status1),
      status1,
    );

  // ---------- Sprachen
  for (const [label, reShapes, reColors] of [
    ['English', /Cuts outside marked areas/, /Required colours/],
    ['Türkçe', /İşaretli alanların dışındaki kesimler/, /Zorunlu renkler/],
  ]) {
    await page.goto(BASE + '#/settings');
    await page.click(`[data-testid="lang-select"] >> text=${label}`);
    await page.waitForTimeout(300);
    await page.goto(projUrl + '/shapes');
    await page.waitForSelector('[data-testid="cut-focus"]');
    const s = await page.textContent('[data-testid="cut-focus"]');
    const cc = await page.textContent('label.toggle:has([data-testid="contour-continuity"])');
    await page.goto(projUrl + '/colors');
    await page.waitForSelector('[data-testid="pinned-colors"]');
    const c = await page.textContent('[data-testid="pinned-colors"]');
    const a = (await page.textContent('[data-testid="colors-accents"], [data-testid="colors-accents-none"]').catch(() => '')) || '';
    check(`${label}: Schritt 6 und 5 übersetzt (keine Schlüssel)`, reShapes.test(s) && reColors.test(c) && !/w4cpa\./.test(s + cc + c + a), `${s.slice(0, 40)} | ${c.slice(0, 30)}`);
  }
  await page.goto(BASE + '#/settings');
  await page.click('[data-testid="lang-select"] >> text=Deutsch');
  await page.waitForTimeout(300);

  // ---------- Handy-Layout
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(projUrl + '/shapes');
  await page.waitForSelector('[data-testid="cut-focus"]');
  await page.locator('[data-testid="cut-focus"]').scrollIntoViewIfNeeded();
  const geoS = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="cut-focus"]').getBoundingClientRect();
    return { right: Math.round(r.right), w: window.innerWidth };
  });
  check('Handy (390 px): Schritt 6 ohne seitliches Scrollen, Kasten passt', (await noHScroll(page)) && geoS.right <= geoS.w, JSON.stringify(geoS));
  await page.screenshot({ path: path.join(OUT, 'w4cpa-04-phone-shapes.png') });
  await page.goto(projUrl + '/colors');
  await page.waitForSelector('[data-testid="pinned-colors"]');
  await page.locator('[data-testid="pinned-colors"]').scrollIntoViewIfNeeded();
  const geoC = await page.evaluate(() => {
    const out = {};
    for (const id of ['pinned-colors', 'colors-accents']) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (el) out[id] = Math.round(el.getBoundingClientRect().right);
    }
    out.w = window.innerWidth;
    return out;
  });
  check('Handy: Pflichtfarben und Akzentfarben ohne seitliches Scrollen', (await noHScroll(page)) && Object.entries(geoC).every(([k, v]) => k === 'w' || v <= geoC.w), JSON.stringify(geoC));
  await page.screenshot({ path: path.join(OUT, 'w4cpa-05-phone-colors.png') });
  if (await page.$('[data-testid="colors-accents"]')) {
    await page.locator('[data-testid="colors-accents"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, 'w4cpa-06-phone-accents.png') });
  }
  await page.setViewportSize({ width: 1360, height: 900 });

  // ---------- Eigene Palette: Vorschlag direkt zur Palette
  await page.goto(projUrl + '/colors');
  await page.waitForSelector('[data-testid="palette-mode"]');
  await page.click('[data-testid="palette-mode"] >> text=Eigene Farbauswahl');
  await page.waitForTimeout(200);
  const other = await page.textContent('[data-testid="pinned-other-mode"]').catch(() => '');
  check('Andere Farbquelle: Hinweis, dass gespeicherte Pflichtfarben nur in den Automatik-Modi wirken', /1 Pflichtfarbe gespeichert/.test(other), other);
  const addBtn = await page.$('[data-testid="colors-accents-addcustom"]');
  if (addBtn) {
    const before = await page.$$eval('[data-testid="palette-table"] tbody tr', (r) => r.length);
    await addBtn.click();
    await page.waitForTimeout(200);
    const after = await page.$$eval('[data-testid="palette-table"] tbody tr', (r) => r.length);
    const ok = await page.$('[data-testid="colors-accents-incustom"]');
    check('Eigene Palette: „Zur eigenen Palette hinzufügen“ ergänzt genau eine Farbe', after === before + 1 && !!ok, `${before} → ${after}`);
  } else check('Eigene Palette: Vorschlag lässt sich zur Palette hinzufügen (kein Vorschlag mehr offen)', !!(await page.$('[data-testid="colors-accents-none"], [data-testid="colors-accents-incustom"]')) || !(await page.$('[data-testid="colors-accents"]')));
  await context.close();

  // ================================================================ B: Projekt ohne Bereiche
  {
    const { context: c2, page: p2 } = await newPage({ width: 1360, height: 900 });
    await p2.goto(BASE);
    await p2.waitForSelector('[data-testid="sample-landscape"]');
    await p2.click('[data-testid="sample-landscape"]');
    await p2.waitForSelector('[data-testid="step-shapes"]');
    await p2.click('[data-testid="step-shapes"]');
    await p2.waitForSelector('[data-testid="cut-focus"]');
    const t = await p2.textContent('[data-testid="cut-focus"]');
    check('Ohne Bereiche: kein Regler, sondern „zuerst einen Gesichts- oder Detailbereich markieren“', !(await p2.$('[data-testid="cut-focus"] input[type="range"]')) && /zuerst einen Gesichts- oder Detailbereich markieren/.test(t), t.slice(0, 80));
    await c2.close();
  }

  check('Keine Fehler in der Konsole', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
