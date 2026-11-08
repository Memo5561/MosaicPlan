/* Browser-Test w3-live-preview: Live-Vorschau in den Schritten 2–7 (nie gespeichert), „Vorschau übernehmen“
 * ohne zweite Berechnung, Fortschritt bleibt beim Durchsehen der Schritte, Berechnung übersteht Verlassen/
 * erneutes Öffnen, „Berechnung für „X“ läuft noch“ in anderen Projekten, nach Neuladen kein Phantom-Auftrag.
 * Aufruf: node e2e/w3-live-preview.e2e.cjs <baseUrl> <outDir>
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'out-w3-live-preview');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

async function idbGet(page, store, key) {
  return page.evaluate(
    ([store, key]) =>
      new Promise((res, rej) => {
        const r = indexedDB.open('mosaicplan');
        r.onsuccess = () => {
          const db = r.result;
          const g = db.transaction(store, 'readonly').objectStore(store).get(key);
          g.onsuccess = () => {
            const v = g.result;
            db.close();
            res(v === undefined ? null : JSON.parse(JSON.stringify(v, (k, x) => (ArrayBuffer.isView(x) ? { len: x.length, sum: Array.prototype.reduce.call(x, (a, b) => (a + b) % 1000000007, 0) } : x))));
          };
          g.onerror = () => rej(g.error);
        };
        r.onerror = () => rej(r.error);
      }),
    [store, key],
  );
}

const projectId = (page) => page.evaluate(() => location.hash.split('/')[2]);
const canvasSig = (page) =>
  page.evaluate(() => {
    const c = document.querySelector('[data-testid="live-preview-canvas"]');
    if (!c) return null;
    const d = c.toDataURL();
    let h = 0;
    for (let i = 0; i < d.length; i += 7) h = (h * 31 + d.charCodeAt(i)) | 0;
    return `${c.width}x${c.height}:${h}`;
  });
const previewAttr = (page, a) => page.getAttribute('[data-testid="live-preview"]', a);
async function waitPreviewReady(page, timeout = 60000) {
  await page.waitForSelector('[data-testid="live-preview"][data-state="ready"][data-current="1"]', { timeout });
}
async function goHash(page, hash) {
  await page.evaluate((h) => (location.hash = h), hash);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  // Zählt Rechenaufträge an Worker (type 'compute': Vorschau und Berechnung)
  await context.addInitScript(() => {
    const orig = Worker.prototype.postMessage;
    window.__computeMsgs = 0;
    Worker.prototype.postMessage = function (msg, ...rest) {
      if (msg && msg.type === 'compute') window.__computeMsgs++;
      return orig.call(this, msg, ...rest);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const computeMsgs = () => page.evaluate(() => window.__computeMsgs);

  await page.goto(BASE);
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  const portraitId = await projectId(page);
  const portraitName = await page.inputValue('[data-testid="project-name"]');

  // ---------- 1. Steingröße: Vorschau erscheint und ändert sich bei 5 → 8 mm, nichts wird gespeichert
  await page.click('[data-testid="step-tiles"]');
  await page.waitForSelector('[data-testid="live-preview-canvas"]', { timeout: 60000 });
  await waitPreviewReady(page);
  const key5 = await previewAttr(page, 'data-key');
  await page.click('[data-testid="tile-presets"] button:has-text("4 × 4 mm")');
  await page.waitForFunction((k) => {
    const el = document.querySelector('[data-testid="live-preview"]');
    return el && el.getAttribute('data-key') !== k && el.getAttribute('data-state') === 'ready' && el.getAttribute('data-current') === '1';
  }, key5, { timeout: 60000 });
  await page.waitForTimeout(600); // Speichern der Einstellung abwarten
  const recBefore = await idbGet(page, 'projects', portraitId);
  const key1 = await previewAttr(page, 'data-key');
  const sig1 = await canvasSig(page);
  check('Schritt Steingröße: Vorschau-Bild erscheint', !!sig1 && (await previewAttr(page, 'data-kind')) === 'preview', `${sig1} ${key1}`);
  check('Kennzeichen „Vorschau – noch nicht übernommen“', /noch nicht übernommen/.test(await page.textContent('[data-testid="live-preview-badge"]')));
  await page.screenshot({ path: path.join(OUT, '01-tiles-4mm.png') });
  await page.click('[data-testid="tile-presets"] button:has-text("8 × 8 mm")');
  await page.waitForTimeout(150);
  const dimmed = await page.evaluate(() => !!document.querySelector('[data-testid="live-preview"] .w3lp-dim'));
  check('Während des Neurechnens ist das alte Bild abgedunkelt', dimmed);
  await page.screenshot({ path: path.join(OUT, '02-tiles-updating.png') });
  await page.waitForFunction((k) => {
    const el = document.querySelector('[data-testid="live-preview"]');
    return el && el.getAttribute('data-key') !== k && el.getAttribute('data-state') === 'ready' && el.getAttribute('data-current') === '1';
  }, key1, { timeout: 60000 });
  const sig2 = await canvasSig(page);
  check('4 → 8 mm: Vorschau-Bild ändert sich', sig2 !== sig1, `${sig1} → ${sig2}`);
  await page.screenshot({ path: path.join(OUT, '03-tiles-8mm.png') });
  await page.waitForTimeout(600); // Speichern der Einstellung abwarten
  const recAfter = await idbGet(page, 'projects', portraitId);
  check(
    'computedWith im Gerätespeicher unverändert bis „Übernehmen“ (Vorschau speichert nichts)',
    recBefore.computedWith === recAfter.computedWith && recAfter.computedWith === undefined && !recAfter.meta.computed && recAfter.settings.tileW === 8,
    `computedWith=${recAfter.computedWith} computed=${recAfter.meta.computed} tileW=${recAfter.settings.tileW}`,
  );
  check('Kein Raster gespeichert', (await idbGet(page, 'mosaics', portraitId)) === null);

  // Foto/Mosaik-Umschalter
  await page.click('[data-testid="live-preview-view"] button:has-text("Foto")');
  await page.waitForTimeout(300);
  const sigPhoto = await canvasSig(page);
  check('Umschalter Foto zeigt das Foto', sigPhoto !== sig2 && (await page.getAttribute('[data-testid="live-preview-canvas"]', 'data-view')) === 'photo');
  await page.click('[data-testid="live-preview-view"] button:has-text("Mosaik")');

  // ---------- 2. Farben: Farbfelder der Vorschau (nur Ansicht), Fuge/Bildgröße ebenfalls mit Vorschau
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="live-preview-swatches"]');
  const sw = await page.getAttribute('[data-testid="live-preview-swatches"]', 'data-count');
  check('Schritt Farben: Farbfelder der Vorschau sichtbar', parseInt(sw, 10) > 0, `${sw} Farben`);
  await page.screenshot({ path: path.join(OUT, '04-colors.png') });
  let allSteps = true;
  for (const s of ['size', 'joint', 'shapes', 'compute']) {
    await page.click(`[data-testid="step-${s}"]`);
    allSteps = allSteps && (await page.isVisible('[data-testid="live-preview"]'));
  }
  check('Vorschau in den Schritten 2–7 vorhanden', allSteps);
  await page.click('[data-testid="step-photo"]');
  check('Kein Vorschau-Rahmen im Schritt Foto', !(await page.isVisible('[data-testid="live-preview"]')));

  // Schritt 6: Vorschau ausblenden (Bereichs-Editor bekommt Platz), Zustand bleibt beim Wiederkommen
  await page.click('[data-testid="step-shapes"]');
  await page.click('[data-testid="live-preview-toggle"]');
  await page.waitForTimeout(200);
  const hidden = !(await page.isVisible('[data-testid="live-preview-canvas"]'));
  await page.screenshot({ path: path.join(OUT, '05-shapes-collapsed.png') });
  await page.click('[data-testid="step-colors"]');
  const otherStepVisible = await page.isVisible('[data-testid="live-preview-canvas"]');
  await page.click('[data-testid="step-shapes"]');
  const stillHidden = !(await page.isVisible('[data-testid="live-preview-canvas"]'));
  await page.click('[data-testid="live-preview-toggle"]');
  await page.waitForSelector('[data-testid="live-preview-canvas"]');
  check('Schritt 6: Vorschau ausblendbar (gemerkt), andere Schritte unberührt', hidden && otherStepVisible && stillHidden);

  // ---------- 3. Übernehmen: sofort, ohne zweiten Rechenauftrag
  await page.click('[data-testid="step-compute"]');
  await page.waitForSelector('[data-testid="compute-btn"][data-mode="commit"]', { timeout: 60000 });
  check('Schritt 7 bietet „Vorschau übernehmen“', /übernehmen/i.test(await page.textContent('[data-testid="compute-btn"]')));
  await page.screenshot({ path: path.join(OUT, '06-compute-commit.png') });
  const msgsBefore = await computeMsgs();
  const commitMs = await page.evaluate(
    () =>
      new Promise((res) => {
        const t0 = performance.now();
        const done = () => (location.hash.endsWith('/preview') ? res(performance.now() - t0) : requestAnimationFrame(done));
        document.querySelector('[data-testid="compute-btn"]').click();
        requestAnimationFrame(done);
      }),
  );
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 60000 });
  await page.waitForTimeout(800);
  const msgsAfter = await computeMsgs();
  check('„Übernehmen“ dauert unter 300 ms', commitMs < 300, `${Math.round(commitMs)} ms`);
  check('„Übernehmen“ startet keinen zweiten Rechenauftrag', msgsAfter === msgsBefore, `${msgsBefore} → ${msgsAfter} compute-Nachrichten`);
  const recC = await idbGet(page, 'projects', portraitId);
  const mosC = await idbGet(page, 'mosaics', portraitId);
  check('Übernommen: Projekt, Raster und Revision gespeichert', !!recC.computedWith && recC.meta.computed === true && !!mosC && mosC.rev === recC.mosaicRev, `rev ${recC.mosaicRev}`);
  await page.screenshot({ path: path.join(OUT, '07-after-commit.png') });

  // ---------- 4. Verlegte Steine: Durchsehen (und Ändern) der Schritte 2–6 lässt den Fortschritt unverändert
  await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="progress-pct"]');
  await page.click('.section-cell >> nth=0');
  await page.click('text=Abschnitt fertig');
  await page.waitForTimeout(1500);
  const pct0 = (await page.textContent('[data-testid="progress-pct"]')).trim();
  const prog0 = await idbGet(page, 'progress', portraitId);
  await page.click('[data-testid="step-size"]');
  await page.waitForTimeout(400);
  await page.click('[data-testid="step-tiles"]');
  const kindCommitted = await previewAttr(page, 'data-kind');
  await page.click('[data-testid="tile-presets"] button:has-text("6 × 6 mm")');
  await waitPreviewReady(page);
  await page.click('[data-testid="step-joint"]');
  await page.waitForTimeout(400);
  await page.click('[data-testid="step-colors"]');
  await page.waitForTimeout(400);
  await page.click('[data-testid="step-shapes"]');
  await page.waitForTimeout(400);
  await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="progress-pct"]');
  await page.waitForTimeout(800);
  const pct1 = (await page.textContent('[data-testid="progress-pct"]')).trim();
  const prog1 = await idbGet(page, 'progress', portraitId);
  const recP = await idbGet(page, 'projects', portraitId);
  check('Gespeichertes Mosaik wird in den Schritten gezeigt (passende Einstellungen)', kindCommitted === 'committed', kindCommitted);
  check('Fortschritt nach Schritten 2–6 (mit Vorschau) unverändert', pct0 === pct1 && parseFloat(pct0.replace(',', '.')) > 0, `${pct0} → ${pct1}`);
  check('Gespeicherter Fortschritt und Raster unverändert', JSON.stringify(prog0) === JSON.stringify(prog1) && recP.mosaicRev === recC.mosaicRev && recP.computedWith === recC.computedWith);
  check('Geänderte Einstellung ist nur „Einstellungen geändert“ (nicht still übernommen)', await page.isVisible('[data-testid="stale-badge"]'));
  // zurück auf 8 mm: gespeichertes Mosaik passt wieder
  await page.click('[data-testid="step-tiles"]');
  await page.click('[data-testid="tile-presets"] button:has-text("8 × 8 mm")');
  await page.waitForSelector('[data-testid="live-preview"][data-kind="committed"]');

  // ---------- 4b. Schritt 8 ohne gespeichertes Mosaik: passende Vorschau wird von selbst übernommen
  await goHash(page, '#/');
  await page.waitForSelector('[data-testid="sample-animal"]');
  await page.click('[data-testid="sample-animal"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  const animalId = await projectId(page);
  await page.click('[data-testid="step-joint"]');
  await waitPreviewReady(page);
  const mA = await computeMsgs();
  await page.click('[data-testid="step-preview"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 30000 });
  await page.waitForTimeout(600);
  const recA = await idbGet(page, 'projects', animalId);
  check('Schritt 8 ohne Mosaik: passende Vorschau wird übernommen (ohne neue Berechnung)', recA.meta.computed === true && (await computeMsgs()) === mA, `${mA} → ${await computeMsgs()}`);

  // ---------- 4c. „Berechnen“, während die Vorschau genau diese Einstellungen rechnet: wird weiterverwendet
  await goHash(page, '#/');
  await page.waitForSelector('[data-testid="sample-landscape"]');
  await page.click('[data-testid="sample-landscape"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  const landId = await projectId(page);
  await page.click('[data-testid="step-tiles"]');
  await waitPreviewReady(page);
  await page.click('[data-testid="tile-presets"] button:has-text("6 × 6 mm")');
  await page.click('[data-testid="step-compute"]');
  const reuseSeen = await page
    .waitForSelector('[data-testid="reuse-hint"]', { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  const mL = await computeMsgs();
  await page.click('[data-testid="compute-btn"]');
  await page.waitForFunction(() => location.hash.endsWith('/preview'), null, { timeout: 60000 });
  await page.waitForTimeout(600);
  const recL = await idbGet(page, 'projects', landId);
  if (reuseSeen) check('„Berechnen“ während die passende Vorschau rechnet: kein zweiter Auftrag', recL.meta.computed === true && (await computeMsgs()) === mL, `${mL} → ${await computeMsgs()}`);
  else check('(Vorschau war schon fertig) Übernehmen ohne zweiten Auftrag', recL.meta.computed === true && (await computeMsgs()) === mL);

  // ---------- 5. Lange Berechnung: Verlassen, erneut öffnen, anderes Projekt, Abbrechen, Neuladen
  await goHash(page, '#/');
  await page.waitForSelector('[data-testid="sample-city"]');
  await page.click('[data-testid="sample-city"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  const cityId = await projectId(page);
  const cityName = await page.inputValue('[data-testid="project-name"]');
  await page.click('[data-testid="step-tiles"]');
  await page.fill('[data-testid="tile-w"]', '1');
  await page.fill('[data-testid="tile-h"]', '1');
  await page.click('[data-testid="step-joint"]');
  await page.fill('[data-testid="joint-input"]', '0,5');
  await page.click('[data-testid="step-colors"]');
  await page.click('[data-testid="color-counts"] button:has-text("200")');
  await page.click('[data-testid="colors-advanced"] summary');
  await page.fill('[data-testid="colors-advanced"] input[type=range]', '100');
  await page.click('[data-testid="step-compute"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  const bigCells = await page.textContent('[data-testid="grid-positions"]');
  const manualState = await previewAttr(page, 'data-state');
  check('Großes Mosaik: Vorschau nur auf Knopfdruck mit Richtwert', manualState === 'manual' && (await page.isVisible('[data-testid="live-preview-refresh"]')) && /Richtwert/.test(await page.textContent('[data-testid="live-preview-estimate"]')), `${bigCells} Positionen`);
  await page.screenshot({ path: path.join(OUT, '08-big-manual.png') });
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="compute-progress"]');
  await page.waitForTimeout(500);
  // Projekt verlassen (Meine Projekte) und wieder öffnen
  await page.click('.w2ws-back');
  await page.waitForSelector('[data-testid="project-row"]');
  await goHash(page, `#/project/${cityId}`);
  await page.waitForSelector('[data-testid="step-compute"]');
  const reopenedProgress = await page
    .waitForSelector('[data-testid="compute-progress"], [data-testid="computing-badge"]', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!(await page.isVisible('[data-testid="compute-progress"]'))) await page.click('[data-testid="step-compute"]');
  const cancelVisible = await page.isVisible('[data-testid="compute-cancel"]');
  check('Erneut geöffnet: Fortschritt und „Abbrechen“ der laufenden Berechnung sichtbar', reopenedProgress && cancelVisible);
  await page.screenshot({ path: path.join(OUT, '09-reopened-progress.png') });
  // Anderes Projekt: „Berechnung für „X“ läuft noch“
  await goHash(page, `#/project/${portraitId}/compute`);
  await page.waitForSelector('[data-testid="other-job"]', { timeout: 10000 });
  const otherText = await page.textContent('[data-testid="other-job"]');
  check('Anderes Projekt: „Berechnung für „X“ läuft noch“ mit Abbrechen', otherText.includes(cityName) && /läuft noch/.test(otherText) && (await page.isVisible('[data-testid="other-job-cancel"]')), otherText.slice(0, 90));
  check('Anderes Projekt: „Berechnen“ unten gesperrt', !(await page.isVisible('[data-testid="compute-btn"]')));
  await page.screenshot({ path: path.join(OUT, '10-other-project.png') });
  // zurück: Ergebnis wird von der neuen Ansicht übernommen
  await goHash(page, `#/project/${cityId}/compute`);
  await page.waitForFunction(() => location.hash.endsWith('/preview'), null, { timeout: 300000 });
  await page.waitForTimeout(800);
  const recCity = await idbGet(page, 'projects', cityId);
  const mosCity = await idbGet(page, 'mosaics', cityId);
  check(
    'Berechnung lief nach dem Verlassen weiter; erneut geöffnete Ansicht übernimmt das Ergebnis',
    recCity.meta.computed === true && !!mosCity && mosCity.rev === recCity.mosaicRev && (await page.isVisible('[data-testid="mosaic-canvas"]')),
    `${mosCity && mosCity.cols}×${mosCity && mosCity.rows}`,
  );
  // Abbrechen aus einem anderen Projekt
  await goHash(page, `#/project/${cityId}/compute`);
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="compute-btn"]');
  const g1 = await page.waitForSelector('[data-testid="guard-nobackup"]', { timeout: 800 }).catch(() => null);
  if (g1) await g1.click();
  await page.waitForSelector('[data-testid="compute-progress"]');
  await goHash(page, `#/project/${portraitId}/compute`);
  await page.waitForSelector('[data-testid="other-job"]');
  await page.click('[data-testid="other-job-cancel"]');
  const freed = await page
    .waitForSelector('[data-testid="compute-btn"]', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check('Abbrechen aus dem anderen Projekt beendet die Berechnung', freed && !(await page.isVisible('[data-testid="other-job"]')));
  await goHash(page, `#/project/${cityId}/compute`);
  await page.waitForSelector('[data-testid="compute-btn"]');
  check('Abgebrochenes Projekt zeigt keinen Fortschritt mehr', !(await page.isVisible('[data-testid="compute-progress"]')));
  // Neuladen während einer Berechnung: kein „läuft noch“, Register arbeitet weiter
  await page.click('[data-testid="compute-btn"]');
  const g2 = await page.waitForSelector('[data-testid="guard-nobackup"]', { timeout: 800 }).catch(() => null);
  if (g2) await g2.click();
  await page.waitForSelector('[data-testid="compute-progress"]');
  await page.reload();
  await page.waitForSelector('[data-testid="step-compute"]', { timeout: 30000 });
  if (!(await page.evaluate(() => location.hash.endsWith('/compute')))) await page.click('[data-testid="step-compute"]');
  await page.waitForSelector('[data-testid="compute-btn"]', { timeout: 30000 });
  const phantom = (await page.isVisible('[data-testid="compute-progress"]')) || (await page.isVisible('[data-testid="computing-badge"]'));
  await page.click('[data-testid="compute-btn"]');
  const g3 = await page.waitForSelector('[data-testid="guard-nobackup"]', { timeout: 800 }).catch(() => null);
  if (g3) await g3.click();
  const restarted = await page
    .waitForSelector('[data-testid="compute-progress"]', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  await page.click('[data-testid="compute-cancel"]');
  const cancelled = await page
    .waitForSelector('[data-testid="compute-btn"]', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check('Nach Neuladen: kein Phantom-Fortschritt; Berechnen startet und lässt sich abbrechen', !phantom && restarted && cancelled);
  const recAfterCancel = await idbGet(page, 'projects', cityId);
  check('Abgebrochene Berechnung ändert das gespeicherte Ergebnis nicht', recAfterCancel.mosaicRev === recCity.mosaicRev);

  // ---------- 6. Handy: Vorschau klebt kompakt über den Einstellungen
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => errors.push(String(e)));
  pp.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await pp.goto(BASE);
  await pp.tap('[data-testid="sample-landscape"]');
  await pp.waitForSelector('[data-testid="compute-btn"]');
  await pp.tap('[data-testid="step-tiles"]');
  await waitPreviewReady(pp);
  await pp.screenshot({ path: path.join(OUT, '11-phone-tiles.png') });
  await pp.evaluate(() => window.scrollTo(0, 600));
  await pp.waitForTimeout(300);
  const box = await (await pp.$('[data-testid="live-preview"]')).boundingBox();
  const topbar = await (await pp.$('.topbar')).boundingBox();
  check('Handy: Vorschau klebt unter der Kopfzeile', Math.abs(box.y - topbar.height) <= 4, `y=${Math.round(box.y)} Kopfzeile=${Math.round(topbar.height)}`);
  check('Handy: Vorschau ≤ 40 % der Höhe', box.height <= 0.4 * 844, `${Math.round(box.height)} px`);
  await pp.screenshot({ path: path.join(OUT, '12-phone-scrolled.png') });
  await pp.tap('[data-testid="tile-presets"] button:has-text("10 × 10 mm")');
  await pp.waitForTimeout(150);
  const phoneBusy = await pp.evaluate(() => !!document.querySelector('[data-testid="live-preview"] .w3lp-dim'));
  await waitPreviewReady(pp);
  check('Handy: Antippen einer Steingröße aktualisiert die sichtbare Vorschau', phoneBusy);
  await pp.tap('[data-testid="step-shapes"]');
  await pp.waitForSelector('[data-testid="live-preview-toggle"]');
  await pp.tap('[data-testid="live-preview-toggle"]');
  await pp.waitForTimeout(200);
  const ph = await (await pp.$('[data-testid="live-preview"]')).boundingBox();
  check('Handy, Schritt 6: Vorschau einklappbar (Bereichs-Editor frei)', ph.height < 80 && !(await pp.isVisible('[data-testid="live-preview-canvas"]')), `${Math.round(ph.height)} px`);
  await pp.screenshot({ path: path.join(OUT, '13-phone-shapes-collapsed.png') });

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
