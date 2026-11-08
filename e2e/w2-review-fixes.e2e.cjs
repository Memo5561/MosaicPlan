/* Nachbesserungen Welle 2 (Review) im echten Browser (Chromium/Playwright).
 * Voraussetzung: `npm run build` und `npx vite preview --port 4173` laufen.
 * Aufruf: node e2e/w2-review-fixes.e2e.cjs [baseUrl] [screenshotDir]
 *
 * Geprüft wird u. a.:
 *  - Während einer Berechnung ist das bisherige Mosaik gesperrt (Verlegemodus, „Abschnitt fertig“, Steindetail);
 *    wird trotzdem daran gearbeitet, wartet das Ergebnis auf eine Entscheidung (verwerfen / Sicherung + übernehmen)
 *  - Bearbeitete Palettenfarben zählen als Verlust beim Neuberechnen (Rückfrage), Schritt 7 behauptet nichts Falsches
 *  - „Änderungen verwerfen“ nach „Foto ersetzen“ bringt keine Bereiche des alten Fotos zurück
 *  - Fernwirkung: nach Fotowechsel keine Zahl des alten Mosaiks gegen das neue Foto
 *  - eingetippte Farbnamen bleiben; CSV aus dem Verlegeplan in der Sprache der Oberfläche
 *  - CIE76: keine CIEDE2000-Einstufung je Farbe
 *  - Verlassen bei Speicherfehler fragt nach; Sicherung als Datei: „Download gestartet“, nicht „gespeichert“
 *  - Handy 360 px: Rückfrage-Dialog, Fugen-Liste, Farbnamen, Startseite ohne Überlauf
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output', 'w2-review-fixes');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const shot = (page, name, full = false) => page.screenshot({ path: path.join(OUT, name), fullPage: full }).catch(() => {});
const idOf = (url) => (url.match(/#\/project\/([^/]+)/) || [])[1];
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

async function computeNow(page) {
  await page.click('[data-testid="step-compute"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="step-preview"].active', { timeout: 240000 });
  await page.waitForSelector('[data-testid="mosaic-canvas"]');
}

const saved = (page) => page.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 15000 }).catch(() => null);

/** Liest einen Datensatz direkt aus IndexedDB. */
const dbGet = (page, store, id) =>
  page.evaluate(
    ([store, id]) =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('mosaicplan');
        r.onsuccess = () => {
          const db = r.result;
          const q = db.transaction(store).objectStore(store).get(id);
          q.onsuccess = () => {
            const v = q.result;
            db.close();
            resolve(v instanceof Uint16Array ? Array.from(v) : v);
          };
          q.onerror = () => reject(q.error);
        };
        r.onerror = () => reject(r.error);
      }),
    [store, id],
  );

/**
 * Simuliert „während der Berechnung am bisherigen Mosaik gearbeitet“ über die echte Projekt-API
 * (api.touchProgress – derselbe Weg wie Antippen im Verlegemodus). Die Oberfläche ist während der
 * Berechnung gesperrt; geprüft wird hier das Sicherheitsnetz in useProject dahinter.
 */
const layViaApi = (page, count) =>
  page.evaluate((count) => {
    const el = document.querySelector('[data-testid="progress-pct"]');
    const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let f = key ? el[key] : null;
    while (f && !(f.memoizedProps && f.memoizedProps.api && f.memoizedProps.api.touchProgress)) f = f.return;
    if (!f) return -1;
    const api = f.memoizedProps.api;
    const p = api.computed.data.progress;
    let n = 0;
    for (let i = 0; i < p.length && n < count; i++)
      if (!p[i]) {
        p[i] = 1;
        n++;
      }
    api.touchProgress();
    return n;
  }, count);

async function placedNow(page) {
  if (!(await page.$('[data-testid="placed-count"]'))) await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="placed-count"]');
  await page.waitForTimeout(300);
  return digits(await page.textContent('[data-testid="placed-count"]'));
}

async function setLang(page, label) {
  await page.goto(BASE + '#/settings');
  await page.click(`[data-testid="lang-select"] >> text=${label}`);
  await page.waitForTimeout(200);
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  };

  // =====================================================================  Desktop
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1, locale: 'de-DE' });
  await context.addInitScript(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v, k) {
      if (window.__failWrites) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      return put.call(this, v, k);
    };
  });
  const page = await context.newPage();
  watch(page);

  // ---------- 1) Arbeiten am Mosaik während der Berechnung
  const portrait = await openSample(page, 'portrait');
  // größer, damit die Berechnung einige Sekunden dauert
  await page.click('[data-testid="step-size"]');
  await page.fill('[data-testid="width-input"]', '250');
  await page.locator('[data-testid="width-input"]').blur();
  await page.click('button:has-text("Höhe aus Foto")').catch(() => {});
  await computeNow(page);
  await saved(page);
  const rev0 = (await dbGet(page, 'projects', portrait)).mosaicRev;

  await page.click('[data-testid="step-compute"]');
  await page.click('[data-testid="compute-btn"]'); // nichts verlegt → ohne Rückfrage
  await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="progress-pct"]');
  const lockShown = await page.waitForSelector('[data-testid="edit-locked"]', { timeout: 5000 }).catch(() => null);
  const layDisabled = await page.isDisabled('[data-testid="lay-mode"]');
  await page.click('.section-cell >> nth=0');
  const doneDisabled = await page.isDisabled('[data-testid="section-done"]');
  const lockText = lockShown ? (await lockShown.textContent()).trim() : '';
  check('Während der Berechnung: Verlegemodus und „Abschnitt fertig“ gesperrt, mit Hinweis', !!lockShown && layDisabled && doneDisabled && /Während der Berechnung gesperrt/.test(lockText), lockText.slice(0, 90));
  // Steindetail: nur ansehen
  const cv = await page.$('[data-testid="mosaic-canvas"]');
  const box = await cv.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const stoneLocked = await page.waitForSelector('[data-testid="stone-locked"]', { timeout: 5000 }).catch(() => null);
  const placedBoxDisabled = stoneLocked ? await page.isDisabled('[data-testid="stone-placed"]') : false;
  const shapeDisabled = stoneLocked ? await page.isDisabled('[data-testid="kind-full"]') : false;
  check('Steindetail während der Berechnung: nur ansehen (verlegt/Form gesperrt)', !!stoneLocked && placedBoxDisabled && shapeDisabled);
  await shot(page, 'r01-stone-locked.png');
  if (stoneLocked) await page.click('[data-testid="modal-close"]');
  await page.waitForTimeout(300);
  // Sicherheitsnetz: trotzdem verlegt (über die Projekt-API) → Ergebnis wird nicht still übernommen
  const injected = await layViaApi(page, 40);
  const pendingDlg = await page.waitForSelector('[data-testid="recompute-guard"][data-mode="apply"]', { timeout: 240000 }).catch(() => null);
  const pendingText = pendingDlg ? ((await page.textContent('[data-testid="guard-loss"]')) || '').trim() : '';
  check('Während der Berechnung verlegt → Ergebnis wartet, Dialog nennt die verlegten Steine', injected === 40 && !!pendingDlg && pendingText.includes('40 als verlegt markierte Steine'), pendingText.slice(0, 150));
  await shot(page, 'r02-pending.png');
  // Schließen lässt das Ergebnis warten, der Hinweis im Kopf öffnet es wieder
  await page.click('[data-testid="modal-close"]');
  const badge = await page.waitForSelector('[data-testid="pending-badge"]', { timeout: 5000 }).catch(() => null);
  const placedWaiting = await placedNow(page);
  check('Schließen: Ergebnis wartet (Hinweis im Kopf), bisheriges Mosaik mit Fortschritt bleibt', !!badge && placedWaiting === 40, `${placedWaiting} verlegt`);
  await page.click('[data-testid="pending-badge"]');
  await page.waitForSelector('[data-testid="recompute-guard"][data-mode="apply"]');
  await page.click('[data-testid="guard-discard-result"]');
  await page.waitForSelector('[data-testid="recompute-guard"]', { state: 'detached' });
  await saved(page);
  const afterDiscard = await dbGet(page, 'projects', portrait);
  const prog = await dbGet(page, 'progress', portrait);
  const storedPlaced = prog.filter((v) => v).length;
  check('„Ergebnis verwerfen“: altes Mosaik (gleiche Revision) und Fortschritt bleiben gespeichert', afterDiscard.mosaicRev === rev0 && storedPlaced === 40 && (await placedNow(page)) === 40, `rev gleich=${afterDiscard.mosaicRev === rev0}, ${storedPlaced} gespeichert`);

  // zweiter Durchlauf: mit Sicherungskopie übernehmen
  await page.click('[data-testid="step-compute"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="recompute-guard"][data-mode="compute"]');
  await page.click('[data-testid="guard-nobackup"]');
  await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="edit-locked"]');
  await layViaApi(page, 10);
  await page.waitForSelector('[data-testid="recompute-guard"][data-mode="apply"]', { timeout: 240000 });
  const pendingText2 = ((await page.textContent('[data-testid="guard-loss"]')) || '').trim();
  await page.click('[data-testid="guard-backup"]');
  const notice = await page.waitForSelector('[data-testid="backup-notice"]', { timeout: 30000 }).catch(() => null);
  await page.waitForSelector('[data-testid="recompute-guard"]', { state: 'detached', timeout: 30000 }).catch(() => {});
  await saved(page);
  const afterApply = await dbGet(page, 'projects', portrait);
  const placedApplied = await placedNow(page);
  check(
    // seit w4-progress-engine: gleiche Einstellungen → nachweislich gleiche Steine bleiben verlegt (hier alle 50)
    'Sicherungskopie + übernehmen: Kopie angelegt, neues Ergebnis gespeichert, nachweislich gleiche Steine bleiben verlegt',
    /50 als verlegt markierte Steine/.test(pendingText2) && !!notice && /vor Übernahme/.test((await notice.textContent()) || '') && afterApply.mosaicRev !== rev0 && placedApplied === 50,
    pendingText2.slice(0, 90),
  );
  // die Kopie enthält alle 50 Steine
  await page.click('.mainnav >> text=Meine Projekte');
  await page.waitForSelector('[data-testid="project-row"]');
  const copyRow = page.locator('[data-testid="project-row"]', { hasText: 'vor Übernahme' });
  await copyRow.locator('button.link').click();
  await page.waitForSelector('.stepper .step.active');
  const copyPlaced = await placedNow(page);
  check('Sicherungskopie enthält auch die während der Berechnung verlegten Steine', copyPlaced === 50, `${copyPlaced}`);

  // ---------- 2) Palettenbearbeitungen zählen als Verlust (automatische Palette)
  const animal = await openSample(page, 'animal');
  await computeNow(page);
  await page.click('[data-testid="step-compute"]');
  const ow0 = ((await page.textContent('[data-testid="overwrite-warn"]')) || '').trim();
  check('Schritt 7 (automatisch, unbearbeitet): sagt, dass die Palette neu erstellt wird', /erstellt die Palette neu/.test(ow0) && /keine Palettenfarben bearbeitet/.test(ow0), ow0.slice(0, 140));
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="palette-table"]');
  const row1 = page.locator('[data-testid="palette-table"] tbody tr').nth(1).locator('[data-testid="palette-name"]');
  const auto1 = await row1.inputValue();
  await row1.fill('Fell Hauptton');
  await row1.blur();
  await page.locator('[data-testid="palette-table"] tbody tr').nth(0).locator('input[type="color"]').evaluate((el) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, '#123456');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  await page.click('[data-testid="step-compute"]');
  const ow1 = ((await page.textContent('[data-testid="overwrite-warn"]')) || '').trim();
  await page.click('[data-testid="compute-btn"]');
  const g = await page.waitForSelector('[data-testid="recompute-guard"][data-mode="compute"]', { timeout: 5000 }).catch(() => null);
  const gText = g ? ((await page.textContent('[data-testid="guard-loss"]')) || '').trim() : '';
  check('Name und HEX geändert → Schritt 7 und Rückfrage nennen „2 bearbeitete Palettenfarben“', /2 bearbeitete Palettenfarben/.test(ow1) && !!g && /2 bearbeitete Palettenfarben/.test(gText), `${auto1} → Fell Hauptton | ${gText.slice(0, 100)}`);
  if (g) await page.click('[data-testid="guard-cancel"]');

  // ---------- 3) Eingetippte Namen bleiben (auch wenn sie einem automatischen Namen gleichen)
  await page.click('[data-testid="step-colors"]');
  const row2 = page.locator('[data-testid="palette-table"] tbody tr').nth(2).locator('[data-testid="palette-name"]');
  const auto2 = await row2.inputValue();
  const base2 = auto2.replace(/ (\d+|\([^)]*\))$/, '');
  await row2.fill(base2);
  await row2.blur();
  await saved(page);
  await page.reload();
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="palette-table"]');
  const again = await page.locator('[data-testid="palette-table"] tbody tr').nth(2).locator('[data-testid="palette-name"]').inputValue();
  check('Eingetippter Name gleich dem automatischen Grundnamen bleibt nach Neuladen', again === base2, `${auto2} → ${base2} → ${again}`);

  // ---------- 4) CSV aus dem Verlegeplan in der Sprache der Oberfläche (ohne Vorschau/Farben zu öffnen)
  const cat = await openSample(page, 'animal');
  await computeNow(page);
  await saved(page);
  await setLang(page, 'English');
  await page.goto(`${BASE}#/project/${cat}/plan`);
  await page.reload();
  await page.waitForSelector('[data-testid="csv-all"]');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), page.click('[data-testid="csv-all"]')]);
  let csvNames = [];
  if (dl) {
    const p = path.join(OUT, 'plan-en.csv');
    await dl.saveAs(p);
    csvNames = [...new Set(fs.readFileSync(p, 'utf8').split(/\r\n/).slice(1).map((l) => l.split(';')[11]))].filter(Boolean);
  }
  const germanLeft = csvNames.filter((x) => /Hautton|Weiß|Karamell|dunkel|hell\b|Lachs|Grau/.test(x));
  check('CSV vom Verlegeplan nach Sprachwechsel: Farbnamen auf Englisch', csvNames.length > 0 && germanLeft.length === 0, csvNames.slice(0, 5).join(', '));
  await setLang(page, 'Deutsch');

  // ---------- 5) CIE76: keine CIEDE2000-Einstufung je Farbe
  await openSample(page, 'portrait');
  await page.click('[data-testid="step-colors"]');
  if (!(await page.isVisible('[data-testid="deltae-mode"]'))) await page.click('[data-testid="colors-advanced"] summary');
  await page.click('[data-testid="deltae-mode"] >> text=CIE76');
  await computeNow(page);
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="palette-match"]');
  const bad = await page.$$eval('[data-testid="palette-match"].bad', (e) => e.length);
  const label = (await page.textContent('[data-testid="palette-match"] >> nth=0')).trim();
  const hint = ((await page.textContent('[data-testid="palette-match-hint"]')) || '').trim();
  check('CIE76: Abweichung je Farbe als ΔE76, nicht rot eingestuft, Hinweis nennt den Grund', bad === 0 && /ΔE76/.test(label) && /CIE76/.test(hint) && !/Rot markiert/.test(hint), `${label} | ${hint.slice(0, 80)}`);
  const overTxt = await page.$$eval('[data-testid="palette-match"] .w2ch-over', (e) => e.map((x) => x.textContent.trim()));
  check('Ausreißer als „N× über ΔE 5“ (keine falsche Ungleichung „4 > 5“)', overTxt.length > 0 && overTxt.every((x) => /^· [\d.]+× über ΔE 5$/.test(x)), overTxt.slice(0, 3).join(' | '));

  // ---------- 6) Foto ersetzen → „Änderungen verwerfen“ und Fernwirkung
  const ph = await openSample(page, 'portrait');
  await computeNow(page);
  await page.click('[data-testid="step-joint"]');
  await page.waitForSelector('[data-testid="grout-basis"][data-basis="stones"]', { timeout: 30000 });
  await page.click('[data-testid="step-photo"]');
  await page.setInputFiles('[data-testid="photo-replace"]', path.join(__dirname, '..', 'public', 'samples', 'landscape.png'));
  await page.waitForSelector('[data-testid="replace-dialog"]', { timeout: 15000 });
  await page.click('[data-testid="replace-in-project"]');
  await page.waitForSelector('[data-testid="photo-stale"]', { timeout: 15000 }).catch(() => {});
  await saved(page);
  await page.click('[data-testid="step-compute"]');
  await page.waitForSelector('[data-testid="stale-reasons"]');
  const staleTxt = ((await page.textContent('[data-testid="stale-reasons"]')) || '').replace(/\s+/g, ' ');
  const discardBtn = await page.$('[data-testid="discard-changes"]');
  if (discardBtn) await discardBtn.click();
  await page.waitForTimeout(500);
  await saved(page);
  const recPh = await dbGet(page, 'projects', ph);
  check(
    'Nach „Foto ersetzen“: Bereiche des alten Fotos nicht wiederherstellbar, nie auf das neue Foto übertragen',
    /Nicht zurücksetzbar: .*Gesichts-\/Detailbereiche/.test(staleTxt) && recPh.regions.length === 0 && recPh.imageRev !== recPh.computedImageRev,
    staleTxt.slice(0, 160),
  );
  await page.click('[data-testid="step-joint"]');
  await page.waitForSelector('[data-testid="grout-basis"]', { timeout: 30000 });
  await page.waitForTimeout(600);
  const basisAfter = await page.getAttribute('[data-testid="grout-basis"]', 'data-basis');
  const otherPhoto = await page.isVisible('[data-testid="grout-other-photo"]');
  check('Fernwirkung nach Fotowechsel: keine Zahl des alten Mosaiks, Hinweis „anderes Foto“', basisAfter === 'ideal' && otherPhoto, `Grundlage ${basisAfter}`);
  await shot(page, 'r03-grout-other-photo.png');

  // ---------- 7) Verlassen bei Speicherfehler
  const leaveId = await openSample(page, 'city');
  await saved(page);
  await page.evaluate(() => (window.__failWrites = true));
  await page.fill('[data-testid="project-name"]', 'Speichertest');
  await page.waitForSelector('[data-testid="save-error"]', { timeout: 5000 });
  const advice = ((await page.textContent('[data-testid="save-error"]')) || '').replace(/\s+/g, ' ');
  check('Hinweis verspricht Wiederholen nur, solange das Projekt geöffnet ist', /Solange dieses Projekt geöffnet ist/.test(advice), advice.slice(0, 140));
  await page.click('.w2ws-back');
  const leave = await page.waitForSelector('[data-testid="leave-guard"]', { timeout: 8000 }).catch(() => null);
  await page.waitForSelector('[data-testid="leave-stay"]:not([disabled])', { timeout: 8000 }).catch(() => {});
  await shot(page, 'r04-leave-guard.png');
  await page.click('[data-testid="leave-stay"]');
  await page.waitForTimeout(400);
  const stillThere = idOf(page.url()) === leaveId && (await page.inputValue('[data-testid="project-name"]')) === 'Speichertest';
  check('„←“ bei Speicherfehler: Rückfrage; „Im Projekt bleiben“ behält den ungespeicherten Namen', !!leave && stillThere);
  // Zurück-Taste
  await page.goBack();
  const leave2 = await page.waitForSelector('[data-testid="leave-guard"]', { timeout: 8000 }).catch(() => null);
  await page.waitForSelector('[data-testid="leave-anyway"]:not([disabled])', { timeout: 8000 }).catch(() => {});
  const stillInProject = idOf(page.url()) === leaveId;
  // Sicherung als Datei aus der Rückfrage: ehrlich „Download gestartet“
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), page.click('[data-testid="leave-download"]')]);
  const noteTxt = ((await page.textContent('[data-testid="leave-download-note"]').catch(() => '')) || '').trim();
  check('Zurück-Taste bei Speicherfehler: Rückfrage, Projekt bleibt offen; Sicherung meldet „Download gestartet“', !!leave2 && stillInProject && !!dl2 && /Download gestartet/.test(noteTxt) && !/gespeichert/i.test(noteTxt), noteTxt.slice(0, 80));
  await page.click('[data-testid="leave-anyway"]');
  await poll(async () => !idOf(page.url()), 5000);
  check('„Trotzdem verlassen“ verlässt das Projekt', !idOf(page.url()), page.url().replace(BASE, ''));
  await page.evaluate(() => (window.__failWrites = false));

  // ---------- 8) Rückfrage: Sicherung fehlgeschlagen → „Stattdessen als Datei sichern“
  const gid = await openSample(page, 'portrait');
  await computeNow(page);
  await page.click('[data-testid="step-plan"]');
  await page.click('.section-cell >> nth=0');
  await page.click('[data-testid="section-done"]');
  await saved(page);
  await page.click('[data-testid="step-compute"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="recompute-guard"]');
  await page.evaluate(() => (window.__failWrites = true));
  await page.click('[data-testid="guard-backup"]');
  await page.waitForSelector('[data-testid="guard-error"]', { timeout: 15000 });
  const [dl3] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), page.click('[data-testid="guard-download"]')]);
  const gNote = ((await page.textContent('[data-testid="guard-download-note"]').catch(() => '')) || '').trim();
  check('Rückfrage: Datei-Sicherung meldet „Download gestartet“ statt „gespeichert“', !!dl3 && /Download gestartet/.test(gNote) && !/Datei gespeichert/.test(gNote), gNote.slice(0, 80));
  await page.click('[data-testid="guard-cancel"]');
  await page.evaluate(() => (window.__failWrites = false));
  if (await page.$('[data-testid="save-retry"]')) await page.click('[data-testid="save-retry"]');
  await saved(page);
  void gid;
  await context.close();

  // =====================================================================  Handy 360 px
  for (const lang of ['Deutsch', 'Türkçe']) {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'de-DE' });
    const p = await ctx.newPage();
    watch(p);
    await p.goto(BASE + '#/settings');
    await p.click(`[data-testid="lang-select"] >> text=${lang}`);
    await p.goto(BASE);
    await p.waitForSelector('[data-testid="home-materials"]');
    const homeOk = await p.$$eval('.home-links .btn', (bs) => bs.every((b) => b.scrollWidth <= b.clientWidth + 1));
    check(`[360 px ${lang}] Startseite: alle Schaltflächen ohne Textüberlauf`, homeOk);
    await p.click('[data-testid="sample-portrait"]');
    await p.waitForSelector('[data-testid="compute-btn"]');
    await p.click('[data-testid="compute-btn"]');
    await p.waitForSelector('[data-testid="step-preview"].active', { timeout: 240000 });
    // Farbnamen vollständig sichtbar
    await p.click('[data-testid="step-colors"]');
    await p.waitForSelector('[data-testid="palette-name"]');
    await p.waitForTimeout(300);
    const clipped = await p.$$eval('[data-testid="palette-name"]', (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 2).map((e) => e.value));
    check(`[360 px ${lang}] Farbnamen nicht abgeschnitten (Zusatz sichtbar)`, clipped.length === 0, clipped.slice(0, 4).join(', '));
    await shot(p, `r05-names-360-${lang}.png`);
    // Fugen-Liste: Seite nicht breiter als der Bildschirm
    await p.click('[data-testid="step-joint"]');
    await p.waitForSelector('[data-testid="grout-recommendation"]', { timeout: 30000 });
    await p.$eval('[data-testid="grout-table"]', (t) => (t.closest('details').open = true));
    await p.waitForTimeout(300);
    const sw = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    check(`[360 px ${lang}] „Alle geprüften Fugenfarben“ geöffnet: Seite nicht breiter als der Bildschirm`, sw.sw <= sw.iw, `${sw.sw} / ${sw.iw}`);
    await shot(p, `r06-grout-table-360-${lang}.png`);
    // Rückfrage-Dialog: Schaltflächen im Dialog
    await p.click('[data-testid="step-plan"]');
    await p.click('.section-cell >> nth=0');
    await p.click('[data-testid="section-done"]');
    await p.waitForTimeout(500);
    await p.click('[data-testid="step-compute"]');
    await p.click('[data-testid="compute-btn"]');
    await p.waitForSelector('[data-testid="recompute-guard"]');
    const inside = await p.evaluate(() => {
      const m = document.querySelector('.modal').getBoundingClientRect();
      return [...document.querySelectorAll('.w2ws-guard-foot .btn')].every((b) => {
        const r = b.getBoundingClientRect();
        return r.left >= m.left - 0.5 && r.right <= m.right + 0.5 && r.left >= 0 && r.right <= window.innerWidth && b.scrollWidth <= b.clientWidth + 1;
      });
    });
    check(`[360 px ${lang}] Rückfrage-Dialog: alle Schaltflächen vollständig im Dialog`, inside);
    await shot(p, `r07-guard-360-${lang}.png`);
    await p.click('[data-testid="guard-cancel"]');
    await ctx.close();
  }

  const relevant = errors.filter((e) => !/favicon|ResizeObserver|QuotaExceeded|quota has been exceeded|Speichern fehlgeschlagen/.test(e));
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
