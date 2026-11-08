/* Browser-Test w2-grout-preview (Playwright/Chromium).
 * Prüft:
 *  - Handy 390 × 844, Testprojekt Landschaft: ein Zoomschritt über die Übersichtsgrenze ändert die mittlere Farbe
 *    (lineares Licht) eines Ausschnitts in der Bildmitte um ΔE76 < 3 (Übersicht zeigt jetzt die Fuge mit);
 *  - Fugenfarbe ändern ändert die Übersichtspixel;
 *  - Schritt „Fuge“: Empfehlung mit „Schätzung“, Übernehmen nur auf Klick (nie automatisch), HEX-Eingabe,
 *    Fernwirkung des berechneten Mosaiks;
 *  - Verlegemodus bei „Ganzes Mosaik“ (Übersicht): verlegte Steine sind sichtbar (einzelner Stein und Abschnitt);
 *  - Desktop, Porträt vor der Berechnung: Empfehlung einer dunkleren Fuge.
 * Voraussetzung: `npm run build` und `npx vite preview --port 4303` laufen.
 * Aufruf: node e2e/w2-grout-preview.e2e.cjs [baseUrl] [screenshotDir]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4303/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w2-grout');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

// ---------- Farbrechnung (Node)
const lin2lab = ([r, g, b]) => {
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};
const de76 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const fmt = (v) => v.toFixed(2);

/**
 * Mittlere Farbe (lineares Licht) eines Quadrats mit halber Kantenlänge rMm (Mosaik-mm) um die Viewer-Mitte –
 * oder, mit anchor {x, y} (Mosaik-mm), um diesen festen Mosaikpunkt. Gibt den Mosaikpunkt der Messmitte zurück.
 * Mit Lineal (w3-viewer-features) zoomen die Zoomknöpfe um die Mitte der Fläche innerhalb des Lineals, nicht um
 * die Canvas-Mitte: Ein Vergleich über einen Zoomschritt muss deshalb denselben Mosaikpunkt messen.
 */
async function centreMean(page, rMm, anchor = null) {
  return page.evaluate(([rMm, anchor]) => {
    const cv = document.querySelector('[data-testid="mosaic-canvas"]');
    const s = parseFloat(cv.dataset.scale);
    const ox = parseFloat(cv.dataset.ox);
    const oy = parseFloat(cv.dataset.oy);
    const cssW = cv.getBoundingClientRect().width;
    const dpr = cv.width / cssW;
    const cssH = cv.height / dpr;
    const at = anchor ?? { x: (cssW / 2 - ox) / s, y: (cssH / 2 - oy) / s };
    const half = Math.max(1, Math.round(rMm * s * dpr));
    const x0 = Math.round((ox + at.x * s) * dpr - half);
    const y0 = Math.round((oy + at.y * s) * dpr - half);
    const d = cv.getContext('2d').getImageData(x0, y0, 2 * half, 2 * half).data;
    const lin = (v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    let r = 0;
    let g = 0;
    let b = 0;
    const n = (2 * half) * (2 * half);
    for (let i = 0; i < n; i++) {
      r += lin(d[i * 4]);
      g += lin(d[i * 4 + 1]);
      b += lin(d[i * 4 + 2]);
    }
    return { lin: [r / n, g / n, b / n], overview: cv.dataset.overview ?? null, scale: s, px: 2 * half, at };
  }, [rMm, anchor]);
}
/** Ganzes Canvas als Bytes (für Pixelvergleiche). */
async function canvasPixels(page) {
  return page.evaluate(() => {
    const cv = document.querySelector('[data-testid="mosaic-canvas"]');
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    return { w: cv.width, h: cv.height, dpr: cv.width / cv.getBoundingClientRect().width, scale: parseFloat(cv.dataset.scale), data: Array.from(d) };
  });
}
function changedPixels(a, b, thr = 12) {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > thr) n++;
  return n;
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // =====================================================================  Handy, Landschaft
  for (const dpr of [1, 3]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr, locale: 'de-DE' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const wait = (ms) => page.waitForTimeout(ms);
    const shot = (n) => page.screenshot({ path: path.join(OUT, `dpr${dpr}-${n}.png`) });
    const tag = `[Handy dpr ${dpr}]`;

    await page.goto(BASE);
    await page.click('[data-testid="sample-landscape"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
    await wait(1200);
    await page.click('[data-testid="viewer-fit"]');
    await wait(400);
    await page.$eval('[data-testid="mosaic-canvas"]', (c) => c.scrollIntoView({ block: 'center' }));
    await wait(300);
    await shot('01-preview-fit');

    // ---- Zoomschritt über die Übersichtsgrenze
    const R = 110; // mm halbe Kantenlänge des Mess-Ausschnitts
    let prev = await centreMean(page, R);
    const anchor = prev.at; // derselbe Mosaikpunkt vor und nach jedem Zoomschritt
    const startOverview = prev.overview;
    let crossed = null;
    for (let i = 0; i < 8 && !crossed; i++) {
      await page.click('[data-testid="viewer-zoom-in"]');
      await wait(350);
      const cur = await centreMean(page, R, anchor);
      if (prev.overview === '1' && cur.overview === '0') crossed = { before: prev, after: cur };
      prev = cur;
    }
    if (crossed) {
      const d = de76(lin2lab(crossed.before.lin), lin2lab(crossed.after.lin));
      const pitchB = crossed.before.scale * 9.5;
      const pitchA = crossed.after.scale * 9.5;
      check(`${tag} Zoomschritt über die Übersichtsgrenze: mittlere Farbe ΔE76 < 3`, d < 3, `ΔE76 ${fmt(d)} (Raster ${fmt(pitchB)} → ${fmt(pitchA)} px, Ausschnitt ${crossed.before.px} → ${crossed.after.px} px)`);
      await shot('02-detail-after-threshold');
    } else check(`${tag} Zoomschritt über die Übersichtsgrenze gefunden`, false, `Start-Übersicht ${startOverview}`);

    await page.click('[data-testid="viewer-fit"]');
    await wait(400);
    const ovBefore = await centreMean(page, R);

    // ---- hervorgehobene Farbe (Legende) auch in der Übersicht: andere Farben abgeblendet
    // dunkelste Farbe (letzter Legendeneintrag): andere Farben werden heller abgeblendet (w3-viewer-features:
    // bei einer hellen Fokusfarbe dunkelt der graue Schleier ab, damit sie sich abhebt)
    const legend = (await page.$$('.legend-item')).pop();
    if (legend) {
      await legend.click();
      await wait(400);
      const focused = await centreMean(page, R);
      const l0 = lin2lab(ovBefore.lin)[0];
      const l1 = lin2lab(focused.lin)[0];
      check(`${tag} Farbe hervorheben: Übersicht blendet die anderen Farben ab`, focused.overview === '1' && l1 > l0 + 10, `L* ${fmt(l0)} → ${fmt(l1)}`);
      await page.$eval('[data-testid="mosaic-canvas"]', (c) => c.scrollIntoView({ block: 'center' }));
      await shot('01b-overview-focus');
      await legend.click();
      await wait(400);
    } else check(`${tag} Legende zum Hervorheben gefunden`, false);

    // ---- Schritt „Fuge“: Empfehlung, nie automatisch übernommen
    await page.click('[data-testid="step-joint"]');
    await page.waitForSelector('[data-testid="grout-recommendation"]', { timeout: 30000 });
    await wait(800);
    const hex0 = await page.inputValue('[data-testid="grout-hex"]');
    const recText = (await page.textContent('[data-testid="grout-recommendation"]')).trim();
    const best = await page.getAttribute('[data-testid="grout-recommendation"]', 'data-best');
    const switchIt = await page.getAttribute('[data-testid="grout-recommendation"]', 'data-switch');
    check(`${tag} Empfehlung sichtbar, als Schätzung gekennzeichnet`, /Empfehlung: .*Fernwirkung ΔE ≈ [\d,]+ \(aktuell [\d,]+\).*Schätzung/.test(recText) && switchIt === '1', recText.slice(0, 120));
    check(`${tag} Fugenfarbe nicht automatisch geändert`, hex0.toUpperCase() === '#BDB8AE', hex0);
    const lBest = parseInt(best.slice(1, 3), 16);
    check(`${tag} Landschaft: dunklere Fuge empfohlen`, lBest < 0xbd, best);
    // Empfehlung, Liste und Abdeckung beruhen nach dem Berechnen auf EINEM Modell: den berechneten Steinen
    const basis = await page.getAttribute('[data-testid="grout-basis"]', 'data-basis').catch(() => null);
    const basisText = ((await page.textContent('[data-testid="grout-basis"]').catch(() => '')) || '').trim();
    check(`${tag} Grundlage nach dem Berechnen: berechnete Steinfarben (Modell-Schätzung), keine zweite „aktuell“-Zahl`, basis === 'stones' && /berechnete Mosaik/.test(basisText) && !(await page.$('[data-testid="grout-mosaic"]')), basisText.slice(0, 110));
    const how = ((await page.textContent('[data-testid="grout-how"]').catch(() => '')) || '').replace(/\s+/g, ' ');
    check(`${tag} „Wie wird geschätzt?“ nennt die Abdeckung der berechneten Steine`, /berechneten Steine und Schnittteile bedecken hier im Mittel \d+ %/.test(how), how.slice(0, 160));
    const thumbs = await page.$$eval('[data-testid="grout-preview"] canvas', (cs) => cs.length);
    check(`${tag} Ansicht aus der Entfernung: Foto, aktuelle Fuge, Empfehlung`, thumbs === 3, `${thumbs} Bilder`);
    const hint = await page.isVisible('text=trocknet meist deutlich heller');
    check(`${tag} Hinweis: Fuge trocknet heller, HEX einer getrockneten Probe`, hint);
    await page.$eval('[data-testid="grout-advice"]', (e) => e.scrollIntoView({ block: 'start' }));
    await wait(200);
    await shot('03-joint-advice');
    await page.click('[data-testid="grout-apply"]');
    await wait(400);
    const hex1 = await page.inputValue('[data-testid="grout-hex"]');
    check(`${tag} „Übernehmen“ setzt die empfohlene Fugenfarbe`, hex1.toUpperCase() === best, `${hex0} → ${hex1}`);
    const after = (await page.textContent('[data-testid="grout-recommendation"]')).trim();
    check(`${tag} danach: aktuelle Farbe ist die beste`, /beste der geprüften Farben/.test(after), after.slice(0, 90));

    // ---- Übersicht nach Fugenwechsel
    await page.click('[data-testid="step-preview"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]');
    await wait(900);
    await page.click('[data-testid="viewer-fit"]');
    await wait(400);
    const ovAfter = await centreMean(page, R);
    const dG = de76(lin2lab(ovBefore.lin), lin2lab(ovAfter.lin));
    const darker = lin2lab(ovAfter.lin)[0] < lin2lab(ovBefore.lin)[0];
    check(`${tag} Fugenfarbe ändert die Übersichtspixel`, ovBefore.overview === '1' && ovAfter.overview === '1' && dG > 3 && darker, `ΔE76 ${fmt(dG)}, L* ${fmt(lin2lab(ovBefore.lin)[0])} → ${fmt(lin2lab(ovAfter.lin)[0])}`);
    await page.$eval('[data-testid="mosaic-canvas"]', (c) => c.scrollIntoView({ block: 'center' }));
    await shot('04-preview-dark-grout');

    // ---- Verlegemodus bei „Ganzes Mosaik“
    await page.click('[data-testid="step-plan"]');
    await page.waitForSelector('[data-testid="progress-pct"]');
    await page.click('text=Verlegemodus');
    await page.click('[data-testid="viewer-fit"]');
    await wait(500);
    const fitOv = await page.$eval('[data-testid="mosaic-canvas"]', (c) => c.dataset.overview);
    await page.$eval('[data-testid="mosaic-canvas"]', (c) => c.scrollIntoView({ block: 'center' }));
    await wait(300);
    const p0 = await canvasPixels(page);
    const cv = await page.$('[data-testid="mosaic-canvas"]');
    const box = await cv.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await wait(1300);
    const placed1 = parseInt((await page.textContent('[data-testid="placed-count"]')).replace(/\D/g, ''), 10);
    const p1 = await canvasPixels(page);
    const one = changedPixels(p0, p1);
    check(`${tag} Verlegemodus, Übersicht: einzelner verlegter Stein sichtbar`, fitOv === '1' && placed1 === 1 && one >= 2 * dpr * dpr, `Übersicht ${fitOv}, verlegt ${placed1}, ${one} Pixel geändert`);
    // Abschnitt A1 fertig: auswählen (zoomt), wieder ganzes Mosaik, dann markieren
    await page.click('.section-cell >> nth=0');
    await wait(300);
    await page.click('[data-testid="viewer-fit"]');
    await wait(500);
    await page.$eval('[data-testid="mosaic-canvas"]', (c) => c.scrollIntoView({ block: 'center' }));
    await wait(300);
    const q0 = await canvasPixels(page);
    await page.click('text=Abschnitt fertig');
    await wait(1500);
    await page.$eval('[data-testid="mosaic-canvas"]', (c) => c.scrollIntoView({ block: 'center' }));
    await wait(300);
    const q1 = await canvasPixels(page);
    const secPx = changedPixels(q0, q1);
    // Abschnitt A1 = höchstens 300 × 300 mm
    const expectPx = Math.pow(300 * q0.scale * q0.dpr, 2);
    check(`${tag} Verlegemodus, Übersicht: verlegter Abschnitt sichtbar`, secPx > 0.5 * expectPx, `${secPx} von ≈ ${Math.round(expectPx)} Pixeln geändert`);
    await shot('05-plan-laid-overview');
    // hineinzoomen: Häkchen/Tönung auch in der Steinansicht
    for (let i = 0; i < 3; i++) await page.click('[data-testid="viewer-zoom-in"]');
    await wait(500);
    await shot('06-plan-laid-zoom');
    await ctx.close();
  }

  // =====================================================================  Desktop, Porträt vor der Berechnung
  {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(BASE);
    await page.click('[data-testid="sample-portrait"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.click('[data-testid="step-joint"]');
    await page.waitForSelector('[data-testid="grout-recommendation"]', { timeout: 30000 });
    await page.waitForTimeout(500);
    const best = await page.getAttribute('[data-testid="grout-recommendation"]', 'data-best');
    const sw = await page.getAttribute('[data-testid="grout-recommendation"]', 'data-switch');
    const cap = (await page.textContent('[data-testid="grout-preview"] figcaption')).trim();
    check('[Desktop] Porträt vor der Berechnung: dunklere Fuge empfohlen (ideale Steine)', sw === '1' && parseInt(best.slice(1, 3), 16) < 0xbd && /vor der Berechnung/.test(cap), `${best} | ${cap.slice(0, 60)}`);
    check('[Desktop] ohne Berechnung: Grundlage ideale Steine in Fotofarbe', (await page.getAttribute('[data-testid="grout-basis"]', 'data-basis')) === 'ideal');
    await page.click('text=Alle geprüften Fugenfarben');
    await page.waitForTimeout(200);
    const rows = await page.$$eval('[data-testid="grout-table"] tbody tr', (r) => r.length);
    check('[Desktop] Tabelle aller geprüften Fugenfarben', rows === 7, `${rows} Zeilen`);
    await page.screenshot({ path: path.join(OUT, 'desktop-01-joint-portrait.png'), fullPage: true });
    // Fuge 0 mm: Fugenfarbe spielt keine Rolle – keine Empfehlung
    await page.click('[data-testid="joint-presets"] >> text=0 mm');
    await page.waitForFunction(() => /Ohne Fuge/.test(document.querySelector('[data-testid="grout-recommendation"]')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
    const noJoint = (await page.textContent('[data-testid="grout-recommendation"]')).trim();
    check('[Desktop] Fuge 0 mm: keine Fugenempfehlung, Hinweis statt Rangliste', /Ohne Fuge \(0 mm\)/.test(noJoint) && !(await page.$('[data-testid="grout-apply"]')), noJoint.slice(0, 70));
    await page.click('[data-testid="joint-presets"] >> text=1 mm');
    await page.waitForSelector('[data-testid="grout-table"]', { state: 'attached', timeout: 15000 });
    // HEX-Eingabe: ungültig → Hinweis, nichts übernommen; gültig → übernommen
    const hex = '[data-testid="grout-hex"]';
    await page.fill(hex, '#12');
    await page.waitForTimeout(200);
    const err = await page.isVisible('text=Ungültiger HEX-Wert');
    const picker0 = await page.inputValue('[data-testid="grout-color"]');
    await page.fill(hex, '#3a3a3a');
    await page.waitForTimeout(600);
    const picker1 = await page.inputValue('[data-testid="grout-color"]');
    check('[Desktop] HEX-Eingabe: ungültig wird nicht übernommen, gültig schon', err && picker0 === '#bdb8ae' && picker1 === '#3a3a3a', `${picker0} → ${picker1}`);
    // die Liste wurde beim Wechsel auf 0 mm neu aufgebaut und ist wieder zugeklappt
    if (!(await page.$eval('[data-testid="grout-table"]', (t) => t.closest('details').open))) await page.click('text=Alle geprüften Fugenfarben');
    await page.waitForTimeout(200);
    const cur = await page.$('[data-testid="grout-table"] tr.current');
    const curHex = cur ? await cur.getAttribute('data-hex') : null;
    check('[Desktop] eigene Fugenfarbe erscheint als „Ihre Farbe“ in der Rangliste', curHex === '#3A3A3A' && (await page.isVisible('text=Ihre Farbe')), String(curHex));
    // Englisch und Türkisch: Texte vorhanden
    for (const [lang, word] of [
      ['English', 'Grout colour for the distance effect'],
      ['Türkçe', 'Uzaktan görünüm için derz rengi'],
    ]) {
      const url = page.url();
      await page.goto(BASE + '#/settings');
      await page.click(`[data-testid="lang-select"] >> text=${lang}`);
      await page.goto(url);
      await page.waitForSelector('[data-testid="grout-recommendation"]', { timeout: 30000 });
      check(`[Desktop] Fugenempfehlung auf ${lang}`, await page.isVisible(`text=${word}`));
    }
    await page.screenshot({ path: path.join(OUT, 'desktop-02-joint-tr.png'), fullPage: true });
    await page.goto(BASE + '#/settings');
    await page.click('[data-testid="lang-select"] >> text=Deutsch');
    await ctx.close();
  }

  const relevant = errors.filter((e) => !/favicon|ResizeObserver/.test(e));
  check('keine Fehler in der Konsole', relevant.length === 0, relevant.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
