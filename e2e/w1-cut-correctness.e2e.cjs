/* Browser-Prüfung für w1-cut-correctness (schneidbare Teile, Einschnitte, Formknöpfe).
 * Voraussetzung: `npm run build` und `npx vite preview` laufen.
 * Aufruf: node e2e/w1-cut-correctness.e2e.cjs <baseUrl> <outDir>
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w1-cut-correctness');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

/** Punkt echt im Polygon (nicht auf dem Rand)? */
function strictlyInside(p, poly, eps) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  if (!inside) return false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = dx * dx + dy * dy;
    let t = l ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l : 0;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) <= eps) return false;
  }
  return true;
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(BASE);
  await page.waitForSelector('[data-testid="sample-portrait"]');
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');

  // ---------- Schritt Steinformen: Mindestbreite und Hinweise
  await page.click('[data-testid="step-shapes"]');
  await page.waitForSelector('text=Mindestbreite eines Schnittteils (mm)');
  const shapesUrl = page.url();
  const minVal = await page.evaluate(() => {
    const f = [...document.querySelectorAll('.field')].find((el) => (el.querySelector('.field-label')?.textContent ?? '').startsWith('Mindestbreite eines Schnittteils'));
    const inp = f && f.querySelector('input');
    return inp ? inp.value : null;
  });
  check('Steinformen: Feld „Mindestbreite eines Schnittteils (mm)“, Standard 2', minVal === '2', `Wert ${minVal}`);
  check('Steinformen: Erklärung zur Mindestbreite (schmalste Stelle und Inkreismaß)', (await page.isVisible('text=Jedes geschnittene Teil')) && (await page.isVisible('text=Inkreismaß')));
  check('2 × 2 bei 5-mm-Stein / 1 mm Fuge zulässig (kein Hinweis)', (await page.$('[data-testid="sub-too-small"]')) === null);
  await page.click('text=3 × 3');
  await page.waitForTimeout(250);
  const subNote = (await page.textContent('[data-testid="sub-too-small"]').catch(() => '')) || '';
  check('3 × 3: Hinweis „es wird nicht unterteilt“ mit Teilsteinmaß', /1 × 1 mm/.test(subNote) && /nicht unterteilt/.test(subNote), subNote.trim());
  await page.screenshot({ path: path.join(OUT, 'w1cut-01-shapes.png'), fullPage: true });
  await page.click('text=2 × 2');
  await page.waitForTimeout(250);
  check('zurück auf 2 × 2: Hinweis verschwindet', (await page.$('[data-testid="sub-too-small"]')) === null);
  // Mindestbreite 3,5 mm: Dreiecke eines 5-mm-Steins (Inkreis 2,5 mm) und 2 × 2 (2 mm) zu schmal
  const minInput = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.field')].find((el) => (el.querySelector('.field-label')?.textContent ?? '').startsWith('Mindestbreite eines Schnittteils')).querySelector('input'),
  );
  await minInput.fill('3,5');
  await page.waitForTimeout(300);
  const diagNote = (await page.textContent('[data-testid="diag-too-small"]').catch(() => '')) || '';
  check('Mindestbreite 3,5 mm: Hinweis „keine Dreiecke“ und „keine Unterteilung“', /5 × 5 mm Steinen mit 1 mm Fuge/.test(diagNote) && (await page.isVisible('[data-testid="sub-too-small"]')), diagNote.trim());
  check('Dreiecke: Hinweis nennt die gemessenen Werte und bis wohin Dreiecke möglich wären', /schmalste Stelle 3,04 mm < 3,5 mm/.test(diagNote) && /Inkreismaß 2,51 mm/.test(diagNote) && /bis zu einer Mindestbreite von 2,5 mm/.test(diagNote), diagNote.trim());
  // 2,6 mm: schmalste Stelle (3,04) reicht, das Inkreismaß (2,51) nicht – der Text darf nicht „schmaler“ behaupten
  await minInput.fill('2,6');
  await page.waitForTimeout(300);
  const diagNote26 = (await page.textContent('[data-testid="diag-too-small"]').catch(() => '')) || '';
  check('Mindestbreite 2,6 mm: Grund ist das Inkreismaß, nicht die schmalste Stelle', /Inkreismaß 2,51 mm < 2,6 mm \(schmalste Stelle 3,04 mm\)/.test(diagNote26) && !/schmaler/.test(diagNote26), diagNote26.trim());
  await page.screenshot({ path: path.join(OUT, 'w1cut-01b-shapes-min35.png') });
  await minInput.fill('2');
  await page.waitForTimeout(300);
  check('Mindestbreite 2 mm: beide Hinweise verschwinden', (await page.$('[data-testid="diag-too-small"]')) === null && (await page.$('[data-testid="sub-too-small"]')) === null);

  // ---------- Berechnen
  await page.click('[data-testid="step-compute"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
  await page.waitForTimeout(1500);
  const canvas = await page.$('[data-testid="mosaic-canvas"]');
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.42);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(400);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.42);
  await page.waitForSelector('[data-testid="stone-id"]');

  // ---------- Formknöpfe: 3×3 gesperrt mit Grund, 2×2 und Dreiecke möglich
  const sub3 = await page.$('[data-testid="kind-sub3"]');
  const sub3Disabled = await sub3.isDisabled();
  const sub3Title = (await sub3.getAttribute('title')) || '';
  check('3×3-Knopf gesperrt, Grund als Tooltip', sub3Disabled && /Mindestbreite/.test(sub3Title), sub3Title);
  const reasons = (await page.textContent('[data-testid="kind-reasons"]').catch(() => '')) || '';
  check('Grund auch sichtbar (ohne Hover, für Touch)', /3×3/.test(reasons) && /Nicht möglich/.test(reasons), reasons.trim().slice(0, 100));
  check('2×2 und Dreiecke möglich', !(await page.isDisabled('[data-testid="kind-sub2"]')) && !(await page.isDisabled('[data-testid="kind-diagA"]')) && !(await page.isDisabled('[data-testid="kind-diagB"]')));

  // ---------- Verlegestatus bleibt bei unveränderter Form erhalten
  await page.click('[data-testid="kind-full"]');
  await page.waitForTimeout(200);
  if (!(await page.isChecked('[data-testid="stone-placed"]'))) await page.click('[data-testid="stone-placed"]');
  await page.waitForTimeout(200);
  await page.click('[data-testid="kind-full"]');
  await page.waitForTimeout(300);
  check('„Ganzer Stein“ auf verlegtem ganzen Stein: bleibt verlegt', await page.isChecked('[data-testid="stone-placed"]'));
  await page.click('[data-testid="kind-diagA"]');
  await page.waitForTimeout(300);
  const diagReset = !(await page.isChecked('[data-testid="stone-placed"]'));
  await page.click('[data-testid="stone-placed"]');
  await page.waitForTimeout(200);
  await page.click('[data-testid="kind-diagA"]');
  await page.waitForTimeout(300);
  check('echte Formänderung setzt zurück, erneuter Klick auf „Dreiecke ╲“ nicht', diagReset && (await page.isChecked('[data-testid="stone-placed"]')));
  const cutTri = (await page.textContent('[data-testid="cut-instructions"]')).trim();
  const minW = ((await page.textContent('[data-testid="stone-min-width"]').catch(() => '')) || '').trim();
  check('Dreieck: durchgehender Schnitt, schmalste Stelle angezeigt', /Schnitt 1: von/.test(cutTri) && /schmalste Stelle 3,04 mm/.test(minW), `${minW}`);
  const throughLines = await page.$$('[data-testid="cut-template"] [data-cut-kind="through"]');
  check('Vorlage: durchgehender Schnitt rot', throughLines.length === 1);
  await page.screenshot({ path: path.join(OUT, 'w1cut-02-triangle.png') });

  // ---------- Freiform-L: Einschnitte statt Schnitten durch den Stein
  await page.click('[data-testid="kind-full"]');
  await page.waitForTimeout(200);
  const sizeText = (await page.textContent('[data-testid="stone-size"]')).replace(/\s+/g, ' ');
  const m = sizeText.match(/([\d,]+) × ([\d,]+) mm/);
  const cw = parseFloat(m[1].replace(',', '.'));
  const ch = parseFloat(m[2].replace(',', '.'));
  await page.click('[data-testid="kind-free"]');
  await page.waitForSelector('.free-svg');
  for (let i = 0; i < 4; i++) await page.click('text=Letzten Punkt entfernen');
  const hx = Math.round((cw / 2) * 10) / 10;
  const hy = Math.round((ch / 2) * 10) / 10;
  const L = [
    [0, 0],
    [hx, 0],
    [hx, hy],
    [cw, hy],
    [cw, ch],
    [0, ch],
  ];
  for (const [x, y] of L) {
    // Zeichenfläche in mm (viewBox, w3-freeform-editor): mm → Bildschirm über getScreenCTM, vor jedem Klick neu
    const sp = await page.evaluate(([mx, my]) => {
      const p = new DOMPoint(mx, my).matrixTransform(document.querySelector('.free-svg').getScreenCTM());
      return { x: p.x, y: p.y };
    }, [x, y]);
    await page.mouse.click(sp.x, sp.y);
    await page.waitForTimeout(80);
  }
  const nPts = await page.$$eval('table.mini tbody tr', (r) => r.length);
  check('Freiform: L-Kontur mit 6 Ecken gezeichnet', nPts === 6, `${nPts} Ecken`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'w1cut-03-freeform.png') });
  await page.click('.modal-foot >> text=Speichern');
  await page.waitForTimeout(500);
  const cutL = (await page.textContent('[data-testid="cut-instructions"]')).trim();
  check('L-Stein: Einschnitte bis zur Innenecke, kein durchgehender Schnitt', /Einschnitt 1: von/.test(cutL) && /Innenecke/.test(cutL) && !/(^|[^n])Schnitt \d: von/.test(cutL), cutL.slice(0, 140));
  // Das L füllt den ganzen Stein: nur Einschnitte – kein Verweis auf durchgehende Schnitte, die es nicht gibt
  check('L-Stein: Hinweis „nicht konvex“ passend zu den vorhandenen Schnitten', /Nicht konvex: Die Einschnitte/.test(cutL) && !/durchgehenden Schnitte/.test(cutL), cutL.slice(-160));
  const geo = await page.evaluate(() => {
    const svgEl = document.querySelector('[data-testid="cut-template"] svg');
    const poly = svgEl.querySelector('polygon').getAttribute('points').trim().split(/\s+/).map((s) => s.split(',').map(Number)).map(([x, y]) => ({ x, y }));
    const lines = [...svgEl.querySelectorAll('[data-cut-kind] line, line[data-cut-kind]')].map((l) => ({
      kind: l.closest('[data-cut-kind]').getAttribute('data-cut-kind'),
      a: { x: +l.getAttribute('x1'), y: +l.getAttribute('y1') },
      b: { x: +l.getAttribute('x2'), y: +l.getAttribute('y2') },
    }));
    return { poly, lines };
  });
  const notchLines = geo.lines.filter((l) => l.kind === 'notch');
  let inside = 0;
  for (const l of geo.lines)
    for (let k = 0; k <= 200; k++) {
      const t = k / 200;
      if (strictlyInside({ x: l.a.x + t * (l.b.x - l.a.x), y: l.a.y + t * (l.b.y - l.a.y) }, geo.poly, 0.5)) inside++;
    }
  check('Vorlage: Einschnitte orange gepunktet, keine Linie durch den Stein', notchLines.length >= 2 && inside === 0, `${notchLines.length} Einschnitte, ${inside} Punkte im Stein`);
  await page.screenshot({ path: path.join(OUT, 'w1cut-04-notch.png') });
  await page.keyboard.press('Escape');

  // ---------- Sprachen: Feldbezeichnung in EN und TR
  await page.goto(BASE + '#/settings');
  await page.click('[data-testid="lang-select"] >> text=English');
  await page.goto(shapesUrl);
  await page.waitForTimeout(600);
  check('Englisch: „Minimum width of a cut piece (mm)“', await page.isVisible('text=Minimum width of a cut piece (mm)'));
  await page.goto(BASE + '#/settings');
  await page.click('[data-testid="lang-select"] >> text=Türkçe');
  await page.goto(shapesUrl);
  await page.waitForTimeout(600);
  check('Türkisch: „Kesim parçasının en küçük genişliği (mm)“', await page.isVisible('text=Kesim parçasının en küçük genişliği (mm)'));
  await page.goto(BASE + '#/settings');
  await page.click('[data-testid="lang-select"] >> text=Deutsch');

  // ---------- Handy: Steinformen ohne horizontales Scrollen
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  await pp.goto(BASE);
  await pp.waitForSelector('[data-testid="sample-portrait"]');
  await pp.click('[data-testid="sample-portrait"]');
  await pp.waitForSelector('[data-testid="compute-btn"]');
  await pp.click('[data-testid="step-shapes"]');
  await pp.waitForTimeout(300);
  await pp.click('text=3 × 3');
  await pp.waitForTimeout(250);
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  await pp.screenshot({ path: path.join(OUT, 'w1cut-05-phone-shapes.png'), fullPage: true });
  check('Handy: Hinweis sichtbar, kein horizontales Scrollen', (await pp.isVisible('[data-testid="sub-too-small"]')) && overflow <= 1, `Überlauf ${overflow}px`);

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
