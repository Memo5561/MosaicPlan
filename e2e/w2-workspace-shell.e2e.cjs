/* Browser-Test „Arbeitsbereich: sicheres Neuberechnen, Speicherstatus, Schrittnavigation, leere Zustände“
 * (Paket w2-workspace-shell).
 * Voraussetzung: `npm run build` und `npx vite preview --port <port>` laufen.
 * Aufruf: node e2e/w2-workspace-shell.e2e.cjs <baseUrl> <ausgabeOrdner>
 *
 * Geprüft wird:
 *  - Neuberechnen mit verlegten Steinen fragt nach (exakte Anzahl), Abbrechen ändert nichts,
 *    Sicherungskopie enthält den Fortschritt und steht unter „Meine Projekte“
 *  - Zurück/Vorwärts wechselt zwischen Schritten; aktiver Schritt = Adresse
 *  - Öffnen aus „Meine Projekte“: Vorschau bzw. Verlegeplan, wenn schon Steine verlegt sind
 *  - Berechnung endet, während ein anderer Schritt offen ist: Schritt bleibt, Hinweis „Berechnung fertig“
 *  - „Einstellungen geändert“ nennt die Änderung; „Änderungen verwerfen“ stellt sie zurück
 *  - Schritte 8–10 ohne Ergebnis: Schaltfläche zu Schritt 7 (ohne Foto: zu Schritt 1)
 *  - Speicherfehler: Warnung mit „Erneut versuchen“ und „Sicherung herunterladen“
 *  - Handy 390 × 844: nach jedem „Weiter“ ist die Überschrift sichtbar und der aktive Schritt in der Leiste
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output', 'w2-workspace-shell');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const shot = (page, name, full = false) => page.screenshot({ path: path.join(OUT, name), fullPage: full }).catch(() => {});
const idOf = (url) => (url.match(/#\/project\/([^/]+)/) || [])[1];
const hashStep = (page) => (page.url().match(/#\/project\/[^/]+\/([a-z]+)/) || [])[1] || null;
const activeStep = (page) => page.$eval('.stepper .step.active', (e) => e.getAttribute('data-testid').replace('step-', '')).catch(() => null);
const digits = (s) => parseInt(String(s || '').replace(/\D/g, ''), 10);
const de = (v) => v.toLocaleString('de-DE');

async function poll(fn, timeoutMs, everyMs = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function openSample(page, key) {
  await page.goto(BASE);
  await page.waitForSelector(`[data-testid="sample-${key}"]`);
  await page.click(`[data-testid="sample-${key}"]`);
  await page.waitForSelector('[data-testid="compute-btn"]');
  return idOf(page.url());
}

async function setNum(page, testId, value) {
  await page.fill(`[data-testid="${testId}"]`, value);
  await page.locator(`[data-testid="${testId}"]`).blur();
}

/** Ändert einen gespeicherten Datensatz direkt in IndexedDB (zum Simulieren inkonsistenter Daten). */
const dbPatch = (page, store, id, fnSrc) =>
  page.evaluate(
    ([store, id, fnSrc]) =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('mosaicplan');
        r.onsuccess = () => {
          const db = r.result;
          const t = db.transaction(store, 'readwrite');
          const s = t.objectStore(store);
          const q = s.get(id);
          q.onsuccess = () => {
            const rec = q.result;
            new Function('rec', fnSrc)(rec);
            s.put(rec, id);
          };
          t.oncomplete = () => {
            db.close();
            resolve(true);
          };
          t.onerror = () => reject(t.error);
        };
        r.onerror = () => reject(r.error);
      }),
    [store, id, fnSrc],
  );

async function placedCount(page) {
  if (!(await page.$('[data-testid="placed-count"]'))) await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="placed-count"]');
  return poll(async () => {
    const v = digits(await page.textContent('[data-testid="placed-count"]'));
    return Number.isFinite(v) ? { v } : null;
  }, 5000).then((x) => (x ? x.v : NaN));
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1 });
  // Schreibfehler auf Wunsch simulieren (QuotaExceededError aus IDBObjectStore.put)
  await context.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v, k) {
      if (window.__failWrites) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return put.call(this, v, k);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // ===================== 1) Porträt: berechnen, Schritte im Verlauf
  const portrait = await openSample(page, 'portrait');
  check('Testprojekt öffnet auf Schritt 7 (Adresse und Schrittleiste)', hashStep(page) === 'compute' && (await activeStep(page)) === 'compute');
  const navCompute = await page.getAttribute('[data-testid="next-step"]', 'data-action');
  const navText = (await page.textContent('[data-testid="next-step"]')).trim();
  check('Schritt 7 ohne Ergebnis: Hauptschaltfläche unten heißt „Berechnen“', navCompute === 'compute' && navText === 'Berechnen', navText);
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="step-preview"].active', { timeout: 240000 });
  await page.waitForSelector('[data-testid="mosaic-canvas"]');
  check('Nach dem Berechnen: Vorschau, Adresse …/preview', hashStep(page) === 'preview');
  const status = await page.$$eval('.stepper .step', (bs) => Object.fromEntries(bs.map((b) => [b.getAttribute('data-testid').replace('step-', ''), b.getAttribute('data-status')])));
  const current = await page.getAttribute('[data-testid="step-preview"]', 'aria-current');
  check(
    'Schrittstatus: ✓ für Foto, Berechnen, Vorschau, Verlegeplan; aria-current am aktiven Schritt',
    status.photo === 'done' && status.compute === 'done' && status.preview === 'done' && status.plan === 'done' && status.size === 'open' && status.pdf === 'open' && current === 'step',
    JSON.stringify(status),
  );
  await shot(page, 'w2ws-01-preview.png');

  // Ergebnis-Wortlaut in Schritt 7
  await page.click('[data-testid="step-compute"]');
  await page.waitForSelector('[data-testid="diagnostics"]');
  const diag = (await page.textContent('[data-testid="diagnostics"]')).replace(/\s+/g, ' ');
  const meanDE = (await page.textContent('[data-testid="mean-de"]')).trim();
  check('Diagnose: „Ø Farbabweichung je Stein (ΔE)“ mit Einstufung', /Ø Farbabweichung je Stein \(ΔE\)/.test(diag) && /– (kaum sichtbar|erkennbar|deutlich)$/.test(meanDE), meanDE);
  const hint = (await page.textContent('.step-body')).replace(/\s+/g, ' ');
  check('Hinweis: Detailverlust durch die Steingröße wird nicht gemessen', /nicht der Detailverlust durch die Steingröße/.test(hint));
  const ow0 = (await page.textContent('[data-testid="overwrite-warn"]')).trim();
  check('Noch nichts verlegt: Hinweis ohne Rückfrage-Ankündigung', /keine Steine als verlegt markiert/.test(ow0), ow0);

  // Zurück/Vorwärts zwischen Schritten
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="palette-table"]');
  await page.click('[data-testid="step-preview"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]');
  await page.goBack();
  await poll(async () => (await activeStep(page)) === 'colors', 5000);
  const h2back = (await page.textContent('.step-body h2')).trim();
  check('Zurück: Schritt „Farben“, Schrittleiste = Adresse', (await activeStep(page)) === 'colors' && hashStep(page) === 'colors' && /Farben/.test(h2back), `${hashStep(page)} | ${h2back}`);
  await page.goForward();
  await poll(async () => (await activeStep(page)) === 'preview', 5000);
  check('Vorwärts: wieder Vorschau', (await activeStep(page)) === 'preview' && hashStep(page) === 'preview');

  // ===================== 2) Rückfrage vor dem Neuberechnen
  await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="progress-pct"]');
  await page.click('.section-cell >> nth=0');
  await page.click('text=Abschnitt fertig');
  const placed = await poll(async () => {
    const v = digits(await page.textContent('[data-testid="placed-count"]'));
    return v > 0 ? v : null;
  }, 10000);
  check('Abschnitt A1 fertig markiert', placed > 0, `${de(placed || 0)} verlegt`);
  await page.waitForTimeout(800);

  await page.click('[data-testid="step-compute"]');
  await page.waitForSelector('[data-testid="overwrite-warn"]');
  const ow = (await page.textContent('[data-testid="overwrite-warn"]')).trim();
  const owClass = await page.getAttribute('[data-testid="overwrite-warn"]', 'class');
  check('Schritt 7 warnt deutlich mit der aktuellen Zahl verlegter Steine', /warn/.test(owClass) && ow.includes(de(placed)), ow.slice(0, 110));
  await page.click('[data-testid="compute-btn"]');
  const guard = await page.waitForSelector('[data-testid="recompute-guard"]', { timeout: 5000 }).catch(() => null);
  const lossText = guard ? (await page.textContent('[data-testid="guard-loss"]')).trim() : '';
  check('Neu berechnen fragt nach und nennt die verlegten Steine', !!guard && lossText.includes(`${de(placed)} als verlegt markierte Steine`), lossText.slice(0, 140));
  await shot(page, 'w2ws-02-guard.png');
  await page.click('[data-testid="guard-cancel"]');
  await page.waitForSelector('[data-testid="recompute-guard"]', { state: 'detached' });
  await page.waitForTimeout(400);
  const computingAfterCancel = await page.isVisible('button.btn.danger');
  const placedAfterCancel = await placedCount(page);
  check('Abbrechen: keine Berechnung, Fortschritt unverändert', !computingAfterCancel && placedAfterCancel === placed, `${de(placedAfterCancel)} verlegt`);

  await page.click('[data-testid="step-compute"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="recompute-guard"]');
  await page.click('[data-testid="guard-backup"]');
  await page.waitForSelector('[data-testid="backup-notice"]', { timeout: 30000 });
  const notice = (await page.textContent('[data-testid="backup-notice"]')).trim();
  await page.waitForSelector('[data-testid="step-preview"].active', { timeout: 240000 });
  check('Sicherungskopie angelegt, danach berechnet und Vorschau geöffnet', /vor Neuberechnung/.test(notice) && hashStep(page) === 'preview', notice.slice(0, 120));
  await shot(page, 'w2ws-03-after-backup.png');
  const placedNew = await placedCount(page);
  check('Neu berechnetes Projekt: Fortschritt zurückgesetzt (wie angekündigt)', placedNew === 0, `${placedNew}`);

  // Kopie in „Meine Projekte“ – Öffnen landet im Verlegeplan mit dem alten Fortschritt
  await page.click('.mainnav >> text=Meine Projekte');
  await page.waitForSelector('[data-testid="project-row"]');
  const backupRow = page.locator('[data-testid="project-row"]', { hasText: 'vor Neuberechnung' });
  check('Kopie steht unter „Meine Projekte“', (await backupRow.count()) === 1);
  await backupRow.locator('button.link').click();
  await page.waitForSelector('[data-testid="placed-count"]', { timeout: 30000 });
  await poll(async () => (await activeStep(page)) === 'plan', 5000);
  const copyPlaced = await placedCount(page);
  check('Kopie öffnet im Verlegeplan (Steine verlegt) mit demselben Fortschritt', (await activeStep(page)) === 'plan' && hashStep(page) === 'plan' && copyPlaced === placed, `${de(copyPlaced)} = ${de(placed)}`);
  await shot(page, 'w2ws-04-copy-plan.png');
  const copyId = idOf(page.url());
  await page.goBack();
  await page.waitForSelector('[data-testid="project-row"]', { timeout: 10000 }).catch(() => null);
  check('Zurück nach automatischer Weiterleitung führt direkt zur Projektliste', page.url().endsWith('#/projects'), page.url().replace(BASE, ''));
  const origRow = page.locator('[data-testid="project-row"]', { hasNotText: 'vor Neuberechnung' }).filter({ hasText: 'Menschenporträt' });
  await origRow.locator('button.link').click();
  await page.waitForSelector('.stepper .step.active');
  await poll(async () => (await activeStep(page)) === 'preview', 5000);
  check('Berechnetes Projekt ohne verlegte Steine öffnet in der Vorschau', (await activeStep(page)) === 'preview' && hashStep(page) === 'preview');

  // Gespeichertes, nicht anzeigbares Mosaik (Integritätsfehler) mit Fortschritt: auch hier wird nachgefragt
  await page.waitForTimeout(600);
  await dbPatch(page, 'projects', copyId, `delete rec.mosaicRev; rec.settings.paletteMode = 'custom'; rec.palette = rec.palette.slice(0, 3);`);
  await dbPatch(page, 'mosaics', copyId, `delete rec.rev;`);
  await page.goto(`${BASE}#/project/${copyId}/preview`);
  await page.reload();
  await page.waitForSelector('[data-testid="empty-state"]');
  const integTitle = (await page.textContent('[data-testid="empty-state"] h3')).trim();
  await page.click('[data-testid="empty-go-compute"]');
  await page.click('[data-testid="compute-btn"]');
  const storedGuard = await page.waitForSelector('[data-testid="recompute-guard"]', { timeout: 5000 }).catch(() => null);
  const storedLoss = storedGuard ? (await page.textContent('[data-testid="guard-loss"]')).trim() : '';
  check(
    'Nicht anzeigbares gespeichertes Mosaik: Hinweis mit Weg zu Schritt 7, Rückfrage nennt dessen verlegte Steine',
    /passt nicht zur Palette/.test(integTitle) && !!storedGuard && /gespeicherte Mosaik/.test(storedLoss) && storedLoss.includes(de(placed)),
    storedLoss.slice(0, 140),
  );
  await page.click('[data-testid="guard-cancel"]');
  await page.waitForSelector('[data-testid="recompute-guard"]', { state: 'detached' });

  // Ausdrücklicher Schritt in der Adresse gewinnt
  await page.goto(`${BASE}#/project/${portrait}/photo`);
  await page.reload();
  await page.waitForSelector('.stepper .step.active');
  await page.waitForTimeout(500);
  check('Link mit Schritt (…/photo) öffnet genau diesen Schritt', (await activeStep(page)) === 'photo' && hashStep(page) === 'photo');

  // ===================== 3) Berechnung endet auf einem anderen Schritt
  const city = await openSample(page, 'city');
  await page.click('[data-testid="step-tiles"]');
  await setNum(page, 'tile-w', '4');
  await setNum(page, 'tile-h', '4');
  await page.click('[data-testid="step-compute"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForTimeout(150);
  await page.click('[data-testid="step-joint"]');
  const runningBadge = await page.isVisible('[data-testid="computing-badge"]');
  const doneBadge = await page.waitForSelector('[data-testid="compute-done"]', { timeout: 240000 }).catch(() => null);
  await page.waitForTimeout(300);
  check('Berechnung fertig, während „Fuge“ offen ist: Schritt bleibt, Hinweis erscheint', !!doneBadge && (await activeStep(page)) === 'joint' && hashStep(page) === 'joint', `läuft-Hinweis=${runningBadge}`);
  await shot(page, 'w2ws-05-done-badge.png');
  await page.click('[data-testid="compute-done"]');
  await page.waitForSelector('[data-testid="step-preview"].active');
  check('Hinweis öffnet die Vorschau', hashStep(page) === 'preview' && !(await page.isVisible('[data-testid="compute-done"]')));

  // ===================== 4) Was hat sich geändert? Änderungen verwerfen
  await page.click('[data-testid="step-joint"]');
  await setNum(page, 'joint-input', '3');
  await page.waitForSelector('[data-testid="stale-badge"]');
  const badge = (await page.textContent('[data-testid="stale-badge"]')).trim();
  await page.click('[data-testid="stale-badge"]');
  await page.waitForSelector('[data-testid="stale-reasons"]');
  const why = (await page.textContent('[data-testid="stale-reasons"]')).replace(/\s+/g, ' ');
  const navStale = (await page.textContent('[data-testid="next-step"]')).trim();
  check('„Einstellungen geändert“ führt zu Schritt 7 und nennt die Änderung', badge === 'Einstellungen geändert' && /Geändert seit letzter Berechnung: Fuge 2 → 3 mm/.test(why) && navStale === 'Neu berechnen', `${badge} | ${why.slice(0, 90)} | ${navStale}`);
  const staleStatus = await page.getAttribute('[data-testid="step-preview"]', 'data-status');
  check('Schrittleiste markiert Ergebnis-Schritte als veraltet', staleStatus === 'stale');
  await shot(page, 'w2ws-06-stale.png');
  await page.click('[data-testid="discard-changes"]');
  await page.waitForSelector('[data-testid="stale-badge"]', { state: 'detached', timeout: 5000 }).catch(() => null);
  const staleGone = !(await page.isVisible('[data-testid="stale-badge"]'));
  await page.click('[data-testid="step-joint"]');
  const jointBack = await page.inputValue('[data-testid="joint-input"]');
  check('„Änderungen verwerfen“: Fuge wieder 2 mm, Stand aktuell', staleGone && jointBack === '2', `Fuge ${jointBack}`);

  // ===================== 5) Leere Zustände
  await openSample(page, 'landscape');
  let emptyOk = true;
  for (const s of ['preview', 'plan', 'pdf']) {
    await page.click(`[data-testid="step-${s}"]`);
    const status = await page.getAttribute(`[data-testid="step-${s}"]`, 'data-status');
    const btn = await page.waitForSelector('[data-testid="empty-go-compute"]', { timeout: 3000 }).catch(() => null);
    if (s === 'preview') await shot(page, 'w2ws-07-empty-preview.png');
    if (!btn || status !== 'unavailable') {
      emptyOk = false;
      continue;
    }
    await btn.click();
    await poll(async () => (await activeStep(page)) === 'compute', 3000);
    if ((await activeStep(page)) !== 'compute') emptyOk = false;
  }
  check('Schritte 8–10 ohne Ergebnis: als „noch nicht berechnet“ markiert, anklickbar, Schaltfläche führt zu Schritt 7', emptyOk);

  await page.goto(BASE);
  await page.click('[data-testid="new-project"]');
  await page.waitForSelector('[data-testid="step-photo"].active');
  const nextEnabled = await page.isEnabled('[data-testid="next-step"]');
  const later = await page.isVisible('[data-testid="photo-later"]');
  check('Schritt 1 ohne Foto: „Weiter“ aktiv mit Hinweis „Foto kann auch später gewählt werden“', nextEnabled && later);
  await page.click('[data-testid="step-pdf"]');
  await page.click('[data-testid="empty-go-photo"]');
  await poll(async () => (await activeStep(page)) === 'photo', 3000);
  check('Ohne Foto: Schaltfläche in Schritt 10 führt zu Schritt 1', (await activeStep(page)) === 'photo');
  await page.click('[data-testid="step-shapes"]');
  const shapesNote = await page.isVisible('[data-testid="shapes-no-photo"]');
  const shapesUsable = await page.isVisible('text=Dreiecke');
  await page.click('[data-testid="step-compute"]');
  const computeNote = await page.isVisible('[data-testid="compute-no-photo"]');
  await shot(page, 'w2ws-08-compute-no-photo.png');
  check('Ohne Foto: Hinweis in Steinformen (Formen weiter einstellbar) und in Schritt 7', shapesNote && shapesUsable && computeNote && !(await page.isVisible('[data-testid="compute-btn"]')));

  // ===================== 6) Speicherfehler sichtbar, Erneut versuchen, Sicherung
  await page.goto(`${BASE}#/project/${city}/preview`);
  await page.reload();
  await page.waitForSelector('[data-testid="save-status"]');
  check('Speicherstatus „Gespeichert ✓“', (await page.textContent('[data-testid="save-status"]')).trim() === 'Gespeichert ✓');
  await page.evaluate(() => (window.__failWrites = true));
  await page.fill('[data-testid="project-name"]', 'Speichertest');
  const banner = await page.waitForSelector('[data-testid="save-error"]', { timeout: 5000 }).catch(() => null);
  const bannerText = banner ? (await banner.textContent()).replace(/\s+/g, ' ') : '';
  const role = banner ? await banner.getAttribute('role') : null;
  const st = (await page.textContent('[data-testid="save-status"]')).trim();
  check('Speichern schlägt fehl: Warnung (role=alert) und „Nicht gespeichert“', !!banner && role === 'alert' && /Gerätespeicher ist voll/.test(bannerText) && st === 'Nicht gespeichert', bannerText.slice(0, 100));
  await shot(page, 'w2ws-09-save-error.png');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), page.click('[data-testid="save-download"]')]);
  let backupHasName = false;
  if (download) {
    const p = path.join(OUT, 'sicherung.mosaicplan.json');
    await download.saveAs(p);
    backupHasName = fs.readFileSync(p, 'utf8').includes('Speichertest');
  }
  check('„Sicherung herunterladen“ enthält den ungespeicherten Stand', backupHasName);
  await page.evaluate(() => (window.__failWrites = false));
  await page.click('[data-testid="save-retry"]');
  const cleared = await page.waitForSelector('[data-testid="save-error"]', { state: 'detached', timeout: 5000 }).then(
    () => true,
    () => false,
  );
  const st2 = (await page.textContent('[data-testid="save-status"]')).trim();
  await page.reload();
  await page.waitForSelector('[data-testid="project-name"]');
  await page.waitForTimeout(300);
  const nameAfter = await page.inputValue('[data-testid="project-name"]');
  check('„Erneut versuchen“ speichert; Name übersteht das Neuladen', cleared && st2 === 'Gespeichert ✓' && nameAfter === 'Speichertest', `${st2} | ${nameAfter}`);

  // Sprachen: neue Texte auch in Englisch und Türkisch
  const langTexts = {};
  for (const [label, key] of [
    ['English', 'en'],
    ['Türkçe', 'tr'],
    ['Deutsch', 'de'],
  ]) {
    await page.goto(BASE + '#/settings');
    await page.click(`[data-testid="lang-select"] >> text=${label}`);
    await page.goto(`${BASE}#/project/${city}/compute`);
    await page.waitForSelector('[data-testid="step-counter"]');
    await page.waitForTimeout(300);
    langTexts[key] = `${(await page.textContent('[data-testid="step-counter"]')).trim()} | ${(await page.textContent('[data-testid="save-status"]')).trim()} | ${(await page.textContent('[data-testid="overwrite-warn"]')).trim().slice(0, 40)}`;
    if (key === 'tr') await shot(page, 'w2ws-09b-compute-tr.png');
  }
  check('Neue Texte auf Englisch und Türkisch', /^Step 7\/10 \| Saved ✓ \| Recomputing/.test(langTexts.en) && /^Adım 7\/10 \| Kaydedildi ✓ \| Yeniden/.test(langTexts.tr) && /^Schritt 7\/10/.test(langTexts.de), JSON.stringify(langTexts));

  check('Keine JavaScript-Fehler (Desktop)', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ===================== 7) Handy 390 × 844
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const pp = await phone.newPage();
  const perrors = [];
  pp.on('pageerror', (e) => perrors.push(String(e)));
  pp.on('console', (m) => m.type() === 'error' && perrors.push(m.text()));
  await openSample(pp, 'portrait');
  await pp.click('[data-testid="step-photo"]');
  await pp.waitForSelector('[data-testid="step-photo"].active');
  const bad = [];
  for (let i = 0; i < 6; i++) {
    // ans Ende scrollen, wie beim Bearbeiten eines langen Schritts
    await pp.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await pp.waitForTimeout(150);
    const nb = await pp.$eval('[data-testid="next-step"]', (b) => {
      const r = b.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
    });
    if (nb.top < 0 || nb.bottom > nb.vh + 1) bad.push(`Weiter nicht sichtbar (${Math.round(nb.top)})`);
    await pp.tap('[data-testid="next-step"]');
    await pp.waitForTimeout(350);
    const m = await pp.evaluate(() => {
      const h = document.querySelector('.step-body h2').getBoundingClientRect();
      const bar = document.querySelector('.stepper').getBoundingClientRect();
      const chip = document.querySelector('.stepper .step.active').getBoundingClientRect();
      const nav = document.querySelector('[data-testid="step-nav"]').getBoundingClientRect();
      return { step: document.querySelector('.stepper .step.active').getAttribute('data-testid'), hTop: h.top, hBottom: h.bottom, navTop: nav.top, vh: window.innerHeight, chipL: chip.left, chipR: chip.right, barL: bar.left, barR: bar.right, overflow: document.documentElement.scrollWidth - window.innerWidth };
    });
    if (m.hTop < 0 || m.hBottom > Math.min(m.vh, m.navTop)) bad.push(`${m.step}: Überschrift bei ${Math.round(m.hTop)}`);
    if (m.chipL < m.barL - 1 || m.chipR > m.barR + 1) bad.push(`${m.step}: aktiver Schritt außerhalb der Leiste (${Math.round(m.chipL)}–${Math.round(m.chipR)} / ${Math.round(m.barL)}–${Math.round(m.barR)})`);
    if (m.overflow > 1) bad.push(`${m.step}: waagerechtes Scrollen ${m.overflow}px`);
    if (i === 4) await shot(pp, 'w2ws-10-phone-colors.png');
  }
  check('Handy: nach jedem „Weiter“ Überschrift sichtbar, aktiver Schritt in der Leiste, „Weiter“ immer erreichbar', bad.length === 0 && (await activeStep(pp)) === 'compute', bad.slice(0, 3).join(' | ') || 'Schritte 1→7');
  const counter = (await pp.textContent('[data-testid="step-counter"]')).trim();
  check('Handy: Zähler „Schritt 7/10“ in der Leiste unten', counter === 'Schritt 7/10', counter);
  await shot(pp, 'w2ws-11-phone-compute.png');
  check('Keine JavaScript-Fehler (Handy)', perrors.length === 0, perrors.slice(0, 3).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
