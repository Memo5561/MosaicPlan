/* Browser-Test der Korrekturen nach dem Review von Welle 4 (Chromium/Playwright):
 *  - Schritt 6: ×3 + „Konturen durchgehend“ berechnet, Regler ×1 und wieder ×3 → nicht „geändert“; „Zurücksetzen“ und
 *    „Änderungen verwerfen“ → wieder aktuell; Hinweis nennt die Farbverschiebung bei automatischer Farbwahl
 *  - „Gesichter erkennen“ auf dem Beispielporträt: „Kein weiteres Gesicht … markierte Gesichtsbereiche bleiben“
 *  - Fehlende Akzentfarben: Steinbezeichnungen öffnen den Stein in Schritt 8; „Meine Steine – begrenzte Farbanzahl“ mit
 *    nur hellen Materialien: kein „keine“, sondern gezählte Gruppen ohne passendes Material
 *  - Schritt 9 ohne Verlegemodus: Hinweis beschreibt das Antippen richtig, kein „Nächster Stein“ in den Farbchips
 *  - 2 verlegte Steine: „< 0,1 %“ (Schritt 9), „< 1%“ (Abschnitt), „unter 1 % verlegt“ (Projektliste)
 *  - Rückgängig übersteht den Schrittwechsel; Rechteck oben → Rückfrage unten
 *  - Fuge geändert: Warnung und Rückfrage sagen fest „Raster ändert sich – alle verlegten Steine wieder offen“
 *  - zwei Tabs: Umbenennen in Tab B, Antippen in Tab A → Name bleibt
 *  - Handy: Malen mit zu kleinen Steinen meldet den Grund; Statuszeile zweizeilig ohne Abschneiden; „wechseln?“ unten
 * Aufruf: node e2e/w4-review-fixes.e2e.cjs <baseUrl> <outDir>
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w4-review-fixes');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info !== '' ? ` – ${info}` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (s) => parseInt(String(s || '').replace(/\D/g, ''), 10);
const projectId = (page) => (page.url().match(/#\/project\/([^/]+)/) || [])[1];
const txt = async (page, sel) => ((await page.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const dbGet = (page, store, id) =>
  page.evaluate(
    ([store, id]) =>
      new Promise((res, rej) => {
        const r = indexedDB.open('mosaicplan');
        r.onsuccess = () => {
          const q = r.result.transaction(store).objectStore(store).get(id);
          q.onsuccess = () => {
            r.result.close();
            res(q.result);
          };
          q.onerror = () => rej(q.error);
        };
      }),
    [store, id],
  );
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  let v = await fn();
  while (!v && Date.now() - t0 < ms) {
    await wait(150);
    v = await fn();
  }
  return v;
}
/** Porträt: 5-mm-Steine, 1 mm Fuge → Zelle (r, c) beginnt bei (6c, 6r) mm */
async function cellPoint(page, row, col) {
  return page.$eval(
    '[data-testid="mosaic-canvas"]',
    (cv, [r, c]) => {
      const b = cv.getBoundingClientRect();
      const s = +cv.dataset.scale;
      return { x: b.left + +cv.dataset.ox + (c * 6 + 2.5) * s, y: b.top + +cv.dataset.oy + (r * 6 + 2.5) * s, top: b.top, bottom: b.bottom, left: b.left, right: b.right };
    },
    [row, col],
  );
}
const placed = async (page) => digits(await page.textContent('[data-testid="placed-count"]'));
async function compute(page) {
  await page.click('[data-testid="step-compute"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="recompute-guard"], [data-testid="step-preview"].active', { timeout: 240000 });
  if (await page.isVisible('[data-testid="recompute-guard"]')) await page.click('[data-testid="guard-nobackup"]');
  await page.waitForSelector('[data-testid="step-preview"].active', { timeout: 240000 });
  await page.waitForSelector('[data-testid="mosaic-canvas"]');
  await wait(600);
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('dialog', (d) => d.accept());
  };
  try {
    // ======================================================== Desktop 1440 × 900
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-DE' });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(BASE);
    await page.waitForSelector('[data-testid="sample-portrait"]');
    await page.click('[data-testid="sample-portrait"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    const pid = projectId(page);

    // ---------- Schritt 6: Hinweis und Gesichtserkennung
    await page.click('[data-testid="step-shapes"]');
    await page.waitForSelector('[data-testid="cut-focus-preset"]');
    const bgHint = await txt(page, '[data-testid="cut-focus-hint"]');
    check(
      'Hinweis „Schnitte außerhalb …“: Formen/Schnitte in den Bereichen gleich, Farben können sich bei automatischer Farbwahl verschieben',
      /bleiben Steinformen und Schnitte gleich/.test(bgHint) && /Farbtöne auch in den Bereichen verschieben/.test(bgHint) && !/ändert sich nichts/.test(bgHint),
      bgHint.slice(-150),
    );
    await page.click('[data-testid="detect-faces"]');
    await page.waitForSelector('[data-testid="face-detect-status"]:not([data-status="running"])', { timeout: 30000 });
    const fd = await page.$eval('[data-testid="face-detect-status"]', (e) => ({ s: e.dataset.status, t: e.textContent.trim() }));
    check(
      'Beispielporträt (gezeichnet, Gesicht markiert): kein „Kein Gesicht gefunden.“, sondern „… markierten Gesichtsbereiche bleiben unverändert“',
      fd.s === 'none' && /Kein weiteres Gesicht automatisch erkannt/.test(fd.t) && /Gezeichnete oder gemalte Gesichter/.test(fd.t),
      fd.t,
    );
    await page.screenshot({ path: path.join(OUT, 'w4fx-01-face-none.png') });

    // ---------- Berechnungsschlüssel: ×3 + Konturen, berechnen, ×1 und wieder ×3
    await page.click('[data-testid="cut-focus-preset"]');
    await page.waitForSelector('[data-testid="cut-focus-active"]');
    await page.click('[data-testid="contour-continuity"] + .toggle-track');
    await compute(page);
    check('Nach dem Berechnen: nicht „geändert“', !(await page.$('[data-testid="stale-badge"]')));
    await page.click('[data-testid="step-shapes"]');
    const slider = page.locator('[data-testid="cut-focus"] input[type="range"]');
    await slider.focus();
    await page.keyboard.press('Home');
    await page.waitForSelector('[data-testid="cut-focus-preset"]');
    await page.click('[data-testid="cut-focus-preset"]');
    await page.waitForSelector('[data-testid="cut-focus-active"]');
    await wait(500);
    const order = await dbGet(page, 'projects', pid);
    const orderNow = Object.keys(order.settings.shapes).slice(-2).join(',');
    const staleSame = !!(await page.$('[data-testid="stale-badge"]'));
    check('×3 → ×1 → ×3 (gleiche Werte, andere Feldreihenfolge): nicht „geändert“', !staleSame, `Reihenfolge jetzt ${orderNow}`);
    await page.click('[data-testid="cut-focus-reset"]');
    await page.waitForSelector('[data-testid="stale-badge"]');
    await page.click('[data-testid="step-compute"]');
    await page.waitForSelector('[data-testid="discard-changes"]');
    const reasons = await txt(page, '[data-testid="stale-reasons"]');
    await page.click('[data-testid="discard-changes"]');
    await wait(700);
    const staleAfter = !!(await page.$('[data-testid="stale-badge"]'));
    const restored = (await dbGet(page, 'projects', pid)).settings.shapes;
    check('„Zurücksetzen“ → „geändert: Steinformen“; „Änderungen verwerfen“ → wieder aktuell (×3, Konturen an)', /Steinformen/.test(reasons) && !staleAfter && restored.bgCutFactor === 3 && restored.contourContinuity === true, `${reasons.slice(0, 70)} | danach geändert: ${staleAfter}`);

    // ---------- Fehlende Akzentfarben: Steine als Knöpfe → Schritt 8
    await page.click('[data-testid="step-colors"]');
    await page.waitForSelector('[data-testid="colors-accents"], [data-testid="colors-accents-none"], [data-testid="colors-accents-nosuggest"]', { timeout: 20000 });
    const btn = await page.$('[data-testid="colors-accents-open"]');
    const findHint = await txt(page, '[data-testid="colors-accents-findhint"]');
    if (btn) {
      const id = (await btn.getAttribute('data-id')) || '';
      await btn.click();
      await page.waitForSelector('[data-testid="step-preview"].active', { timeout: 10000 });
      const dlg = await until(async () => {
        const t = await txt(page, '.modal, [role="dialog"]');
        return t.includes(`Stein ${id}`) ? t : null;
      }, 6000);
      check('Akzent-Stein antippen: Schritt 8, Steindetail genau dieses Steins (auch Teilstück)', !!dlg && /#\/project\/[^/]+\/preview/.test(page.url()), `${id} | ${(dlg || '').slice(0, 60)}`);
      check('Hinweis: antippen öffnet den Stein (keine Positionssuche mehr nötig)', /antippen öffnet den Stein/.test(findHint), findHint);
      await page.keyboard.press('Escape');
      await wait(300);
    } else check('Akzent-Steine als Knöpfe vorhanden', false, 'keine Knöpfe gefunden');

    // ---------- Schritt 9 ohne Verlegemodus
    await page.click('[data-testid="step-plan"]');
    await page.waitForSelector('[data-testid="placed-count"]');
    await wait(500);
    const th = await page.$eval('[data-testid="tool-hint"]', (e) => ({ mode: e.dataset.mode, t: e.textContent.trim() }));
    const chipsHint = await txt(page, '[data-testid="chips-hint"]');
    check(
      'Ohne Verlegemodus: Hinweis sagt „Verlegemodus einschalten …, jetzt öffnet Antippen das Steindetail“, Farbchips ohne „Nächster Stein“',
      th.mode === 'off' && /^Verlegemodus einschalten/.test(th.t) && /öffnet Antippen das Steindetail/.test(th.t) && !/Nächster Stein/.test(chipsHint) && !(await page.$('[data-testid="next-open"]')),
      `${th.t.slice(0, 80)} | ${chipsHint}`,
    );

    // ---------- 2 Steine verlegen: „< 0,1 %“, Kachel „< 1%“
    await page.click('.section-cell:has-text("B2")');
    await page.click('text=Verlegemodus');
    await wait(300);
    await page.click('[data-testid="next-open"]');
    await page.waitForSelector('[data-testid="next-card"]');
    await wait(300);
    await page.click('[data-testid="next-lay"]');
    await wait(250);
    await page.click('[data-testid="next-lay"]');
    await until(async () => (await placed(page)) === 2);
    await wait(400);
    const pct = await txt(page, '[data-testid="progress-pct"]');
    const tile = await txt(page, '[data-testid="section-cell"][data-section="B2"] small');
    check('2 von ~6.000 verlegt: Schritt 9 „< 0,1 %“, Abschnitt B2 „< 1%“ (nie „0 %“)', pct === '< 0,1 %' && tile === '< 1%', `${pct} | ${tile}`);
    const undo2 = await txt(page, '[data-testid="lay-undo"]');

    // ---------- Rückgängig übersteht den Schrittwechsel
    await page.click('[data-testid="step-preview"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]');
    await wait(400);
    await page.click('[data-testid="step-plan"]');
    await page.waitForSelector('[data-testid="lay-undo"]');
    await wait(400);
    const undoBack = await page.$eval('[data-testid="lay-undo"]', (b) => ({ t: b.textContent.trim(), dis: b.disabled }));
    check('Rückgängig nach Schritt 8 und zurück: Verlauf noch da (2 Schritte)', /\(2\)/.test(undo2) && /\(2\)/.test(undoBack.t) && !undoBack.dis, `${undo2} → ${undoBack.t}`);
    await page.click('[data-testid="lay-undo"]');
    const pu = await until(async () => ((await placed(page)) === 1 ? 1 : null));
    check('… und macht den letzten Stein wieder offen', pu === 1, `verlegt ${await placed(page)}`);
    const undoNote = await page.$$eval('.w4lw-notes small', (els) => els.map((e) => e.textContent).join(' | '));
    check('Hinweis: Rückgängig gilt, solange das Projekt geöffnet ist – auch nach einem Schrittwechsel', /solange das Projekt geöffnet ist – auch nach einem Schrittwechsel/.test(undoNote));

    // ---------- Rechteck oben im Bild → Rückfrage unten
    // nach dem Schrittwechsel ist der Verlegemodus aus (der Rückgängig-Verlauf bleibt)
    if (!(await page.$('[data-testid="lay-tool"]'))) await page.click('text=Verlegemodus');
    await page.waitForSelector('[data-testid="lay-tool"]');
    await page.click('[data-testid="lay-tool"] button:has-text("Rechteck")');
    await page.click('.section-cell:has-text("B2")'); // B2 ins Bild (zoomt auf den Abschnitt)
    await wait(400);
    await page.$eval('[data-testid="mosaic-canvas"]', (c) => c.scrollIntoView({ block: 'center' }));
    await wait(300);
    /** Zeile, deren Mitte bei `frac` der Viewerhöhe liegt (innerhalb von B2: Zeilen 42–83) */
    const rowAt = (frac) =>
      page.$eval(
        '[data-testid="mosaic-canvas"]',
        (c, f) => {
          const b = c.getBoundingClientRect();
          const vis = Math.max(b.top, 0);
          const visB = Math.min(b.bottom, window.innerHeight);
          const y = vis + (visB - vis) * f;
          return Math.max(42, Math.min(83, Math.floor((y - b.top - +c.dataset.oy) / +c.dataset.scale / 6)));
        },
        frac,
      );
    const dragRect = async (r0, r1) => {
      const a = await cellPoint(page, r0, 36);
      const b = await cellPoint(page, r1, 42);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
      await page.mouse.move(b.x, b.y, { steps: 4 });
      await page.mouse.up();
      await page.waitForSelector('[data-testid="rect-confirm"]', { timeout: 5000 }).catch(() => null);
      const bar = await page.$eval('[data-testid="rect-confirm"]', (e) => {
        const r = e.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom };
      }).catch(() => null);
      const atBottom = await page.$eval('[data-testid="lay-overlays"]', (e) => e.classList.contains('at-bottom')).catch(() => false);
      return { a, b, bar, atBottom };
    };
    const vis = await page.$eval('[data-testid="mosaic-canvas"]', (c) => {
      const b = c.getBoundingClientRect();
      return { top: Math.max(b.top, 0), bottom: Math.min(b.bottom, window.innerHeight) };
    });
    const up = await dragRect(await rowAt(0.12), await rowAt(0.22));
    check(
      'Rechteck in der oberen Hälfte: Rückfrage unten (verdeckt das Rechteck nicht)',
      up.b.y < (vis.top + vis.bottom) / 2 && up.atBottom && up.bar && up.bar.top > Math.max(up.a.y, up.b.y),
      `Rechteck y ${Math.round(up.a.y)}–${Math.round(up.b.y)}, Leiste y ${up.bar ? `${Math.round(up.bar.top)}–${Math.round(up.bar.bottom)}` : '–'}`,
    );
    await page.screenshot({ path: path.join(OUT, 'w4fx-02-rect-bottom.png') });
    if (await page.$('[data-testid="rect-cancel"]')) await page.click('[data-testid="rect-cancel"]');
    const down = await dragRect(await rowAt(0.75), await rowAt(0.85));
    check(
      'Rechteck in der unteren Hälfte: Rückfrage oben',
      down.a.y > (vis.top + vis.bottom) / 2 && !down.atBottom && down.bar && down.bar.bottom < Math.min(down.a.y, down.b.y),
      `Rechteck y ${Math.round(down.a.y)}–${Math.round(down.b.y)}, Leiste y ${down.bar ? `${Math.round(down.bar.top)}–${Math.round(down.bar.bottom)}` : '–'}`,
    );
    if (await page.$('[data-testid="rect-cancel"]')) await page.click('[data-testid="rect-cancel"]');
    await page.click('[data-testid="lay-tool"] button:has-text("Tippen")');

    // ---------- Projektliste: „unter 1 % verlegt“ (1 Stein)
    await page.goto(BASE + '#/projects');
    await page.waitForSelector('[data-testid="project-progress"]', { timeout: 10000 }).catch(() => null);
    const lp = await txt(page, '[data-testid="project-progress"]');
    check('Projektliste: „unter 1 % verlegt“', /unter 1 % verlegt/.test(lp), lp);

    // ---------- Fuge geändert: feststehende Aussage statt „bei gleichem Raster …“
    await page.goto(BASE + `#/project/${pid}/joint`);
    await page.waitForSelector('[data-testid="joint-presets"]');
    await page.click('[data-testid="joint-presets"] button:has-text("1,5")');
    await wait(500);
    await page.click('[data-testid="step-compute"]');
    await page.waitForSelector('[data-testid="overwrite-warn"]');
    const ow = await page.$eval('[data-testid="overwrite-warn"]', (e) => ({ g: e.dataset.grid, t: e.textContent.trim() }));
    check('Schritt 7 nach Fugenänderung: „Das Raster ändert sich (Fuge …) – der verlegte Stein wird wieder offen“', ow.g === 'changed' && /Das Raster ändert sich \(Fuge/.test(ow.t) && /wieder offen/.test(ow.t), ow.t);
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="recompute-guard"]');
    const gd = await page.$eval('[data-testid="recompute-guard"]', (e) => ({ g: e.dataset.grid, t: e.querySelector('[data-testid="guard-loss"]').textContent.trim() }));
    check('Rückfrage: data-grid=changed, „Raster ändert sich … wieder offen“, keine bedingte Ausnahme', gd.g === 'changed' && /Das Raster ändert sich/.test(gd.t) && !/Ausnahme bei/.test(gd.t), gd.t);
    await page.screenshot({ path: path.join(OUT, 'w4fx-03-guard-grid.png') });
    await page.click('[data-testid="guard-cancel"]');
    // Fuge zurück (gleiches Raster): wieder die bedingte Aussage
    await page.click('[data-testid="step-joint"]');
    await page.click('[data-testid="joint-presets"] button:has-text("1 mm")');
    await wait(500);
    await page.click('[data-testid="step-compute"]');
    await page.waitForSelector('[data-testid="overwrite-warn"]');
    const ow2 = await page.$eval('[data-testid="overwrite-warn"]', (e) => ({ g: e.dataset.grid, t: e.textContent.trim() }));
    check('Gleiches Raster: bedingte Aussage („Bei gleichem Raster bleiben nur …“)', ow2.g === 'same' && /Bei gleichem Raster/.test(ow2.t), ow2.t.slice(0, 90));

    // ---------- Zwei Tabs: Umbenennen in B, Antippen in A → Name bleibt
    await page.click('[data-testid="step-plan"]');
    await page.waitForSelector('[data-testid="placed-count"]');
    await wait(500);
    if (!(await page.$('[data-testid="next-open"]'))) await page.click('text=Verlegemodus');
    await wait(300);
    const B = await ctx.newPage();
    watch(B);
    await B.goto(BASE + `#/project/${pid}/colors`);
    await B.waitForSelector('[data-testid="project-name"]');
    await B.fill('[data-testid="project-name"]', 'Umbenannt in Tab B');
    await B.locator('[data-testid="project-name"]').blur();
    await until(async () => (await dbGet(page, 'projects', pid)).meta.name === 'Umbenannt in Tab B', 8000);
    await page.bringToFront();
    const p0 = await placed(page);
    await page.$eval('[data-testid="mosaic-canvas"]', (c) => c.scrollIntoView({ block: 'center' }));
    await wait(200);
    const tp = await cellPoint(page, 60, 50);
    await page.mouse.click(tp.x, tp.y);
    await until(async () => (await placed(page)) === p0 + 1);
    await wait(1500);
    const recA = await dbGet(page, 'projects', pid);
    check(
      'Tab B benennt um, Tab A tippt einen Stein: gespeicherter Name bleibt „Umbenannt in Tab B“, Listen-Fortschritt aktualisiert',
      recA.meta.name === 'Umbenannt in Tab B' && recA.meta.progressSummary && recA.meta.progressSummary.placed === p0 + 1,
      `${recA.meta.name} | ${JSON.stringify(recA.meta.progressSummary)}`,
    );
    await B.close();
    await ctx.close();

    // ======================================================== Meine Steine – begrenzte Farbanzahl mit nur hellen Materialien
    const ctx2 = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'de-DE' });
    const p2 = await ctx2.newPage();
    watch(p2);
    await p2.goto(BASE);
    await p2.waitForSelector('[data-testid="new-project"]');
    const LIGHT = ['#F7F4EE', '#F0C8A8', '#D2946E', '#9BBDD3', '#5F7F99'].map((hex, i) => ({
      id: `e2e-w4fx-${i}`,
      type: 'glass',
      manufacturer: 'E2E',
      product: 'Hell',
      colorNumber: `H${i + 1}`,
      colorName: '',
      hex,
      lengthMm: 10,
      widthMm: 10,
      thicknessMm: 4,
      price: 0,
      packageSize: '',
      piecesPerPack: 0,
      notes: '',
    }));
    await p2.evaluate(
      (ms) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('mosaicplan');
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('materials', 'readwrite');
            for (const m of ms) tx.objectStore('materials').put(m, m.id);
            tx.oncomplete = () => {
              db.close();
              resolve(true);
            };
            tx.onerror = () => reject(tx.error);
          };
          req.onerror = () => reject(req.error);
        }),
      LIGHT,
    );
    await p2.reload();
    await p2.waitForSelector('[data-testid="sample-portrait"]');
    await p2.click('[data-testid="sample-portrait"]');
    await p2.waitForSelector('[data-testid="compute-btn"]');
    await p2.click('[data-testid="step-colors"]');
    await p2.click('[data-testid="palette-mode"] >> text=Meine Steine – begrenzte Farbanzahl');
    await p2.click('[data-testid="color-counts"] >> text=8');
    await compute(p2);
    await p2.click('[data-testid="step-colors"]');
    await p2.waitForSelector('[data-testid="colors-accents"], [data-testid="colors-accents-none"], [data-testid="colors-accents-nosuggest"]', { timeout: 20000 });
    const none = !!(await p2.$('[data-testid="colors-accents-none"]'));
    const skipped = await p2.$$eval('[data-testid="colors-accents-skipped-row"]', (els) => els.map((e) => ({ why: e.dataset.why, t: e.textContent.trim() })));
    const noMat = skipped.find((s) => s.why === 'noMaterial');
    check(
      'Nur helle Materialien: kein „Fehlende Akzentfarben: keine“, sondern „N Gruppen (M Steine) … kein Material näher als ΔE00 10,0 – siehe „Fehlende Farben““',
      !none && !!noMat && /^\d+ Gruppen \([\d.]+ Steine\) weichen um mehr als ΔE00 10,0 ab, aber keines der angebotenen Materialien/.test(noMat.t),
      noMat ? noMat.t.slice(0, 120) : JSON.stringify(skipped).slice(0, 120),
    );
    await p2.screenshot({ path: path.join(OUT, 'w4fx-04-accents-skipped.png'), fullPage: false });
    await ctx2.close();

    // ======================================================== Handy 390 × 844 (Touch)
    const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'de-DE' });
    const ph = await ctx3.newPage();
    watch(ph);
    await ph.goto(BASE);
    await ph.waitForSelector('[data-testid="sample-portrait"]');
    await ph.tap('[data-testid="sample-portrait"]');
    await ph.waitForSelector('[data-testid="compute-btn"]');
    await ph.tap('[data-testid="compute-btn"]');
    await ph.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 240000 });
    await wait(800);
    await ph.goto(ph.url().replace(/\/[a-z]+$/, '/plan'));
    await ph.waitForSelector('[data-testid="placed-count"]');
    await wait(800);
    await ph.tap('.section-cell:has-text("B2")');
    await wait(400);
    await ph.tap('label:has([data-testid="lay-mode"])');
    await wait(300);
    // Statuszeile: zwei Zeilen fest reserviert
    const stl = await ph.$eval('[data-testid="lay-status"]', (e) => {
      const cs = getComputedStyle(e);
      return { ws: cs.whiteSpace, h: e.clientHeight, lh: parseFloat(cs.lineHeight) };
    });
    check('Handy: Statuszeile reserviert zwei Zeilen (umbrechend, feste Höhe)', stl.ws === 'normal' && stl.h >= 2 * stl.lh - 1, JSON.stringify(stl));
    // Malen bei zu kleinen Steinen
    await ph.tap('[data-testid="lay-tool"] button:has-text("Malen")');
    await wait(300);
    await ph.$eval('[data-testid="mosaic-canvas"]', (c) => c.scrollIntoView({ block: 'center' }));
    await wait(300);
    const pc = await ph.$eval('[data-testid="mosaic-canvas"]', (c) => {
      const b = c.getBoundingClientRect();
      return { l: b.left, t: b.top, w: b.width, h: b.height, s: +c.dataset.scale };
    });
    const before = await placed(ph);
    const cdp = await ctx3.newCDPSession(ph);
    const x0 = pc.l + pc.w * 0.35;
    const x1 = pc.l + pc.w * 0.75;
    const y = pc.t + pc.h * 0.55;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / 12, y }] });
      await wait(16);
    }
    const hintDuring = await txt(ph, '[data-testid="viewer-hint"]');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait(500);
    const after = await placed(ph);
    check(
      `Handy, Malen, Steine ${(6 * pc.s).toFixed(1)} px: nichts markiert, Hinweis „Steine zu klein zum Malen – einmal antippen zoomt hinein“ schon beim Ziehen`,
      6 * pc.s < 12 && after === before && /Steine zu klein zum Malen/.test(hintDuring),
      hintDuring,
    );
    await ph.screenshot({ path: path.join(OUT, 'w4fx-05-phone-paint.png') });
    // Antippen außerhalb B2 → „wechseln?“ unten
    await ph.tap('[data-testid="lay-tool"] button:has-text("Tippen")');
    await wait(300);
    const out = await cellPoint(ph, 60, 33);
    if (out.x > out.left + 24 && out.x < out.right - 4) {
      await ph.touchscreen.tap(out.x, out.y);
      await ph.waitForSelector('[data-testid="outside-ask"]', { timeout: 4000 }).catch(() => null);
      const ob = await ph.$eval('[data-testid="lay-overlays"]', (e) => e.classList.contains('at-bottom')).catch(() => false);
      const oTop = await ph.$eval('[data-testid="outside-ask"]', (e) => e.getBoundingClientRect().top).catch(() => null);
      check('Handy: „Stein gehört zu Abschnitt … – wechseln?“ unten im Viewer (Abschnittsbezeichnung oben bleibt frei)', ob && oTop !== null && oTop > pc.t + pc.h / 2, `Leiste ab y ${Math.round(oTop ?? -1)}, Viewer ${Math.round(pc.t)}–${Math.round(pc.t + pc.h)}`);
      await ph.screenshot({ path: path.join(OUT, 'w4fx-06-phone-outside.png') });
      const close = await ph.$('[data-testid="outside-ask"] button[aria-label="Schließen"]');
      if (close) await close.tap();
    } else check('Handy: Stein außerhalb B2 sichtbar', false, JSON.stringify(out));
    // Tippen + Rückgängig: Meldung vollständig lesbar (nicht abgeschnitten)
    const inB2 = await cellPoint(ph, 60, 50);
    const pb = await placed(ph);
    await ph.touchscreen.tap(inB2.x, inB2.y);
    await until(async () => (await placed(ph)) !== pb);
    // ggf. erst hineingezoomt: noch einmal tippen
    if ((await placed(ph)) === pb) {
      const again = await cellPoint(ph, 60, 50);
      await ph.touchscreen.tap(again.x, again.y);
      await until(async () => (await placed(ph)) !== pb);
    }
    await wait(300);
    await ph.tap('[data-testid="lay-undo"]');
    await wait(400);
    const st = await ph.$eval('[data-testid="lay-status"]', (e) => ({ t: e.textContent.trim(), sh: e.scrollHeight, ch: e.clientHeight }));
    check('Handy: „Rückgängig gemacht: … wieder offen/als verlegt markiert“ passt ganz in die Statuszeile', /Rückgängig gemacht:/.test(st.t) && st.sh <= st.ch + 1, `${st.t} (${st.sh}/${st.ch})`);
    await ph.screenshot({ path: path.join(OUT, 'w4fx-07-phone-undo.png') });
    await ctx3.close();
  } catch (e) {
    console.error(e);
    check('Ablauf ohne Ausnahme', false, String(e).slice(0, 200));
  }
  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  fs.writeFileSync(path.join(OUT, 'w4-review-fixes-results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})();
