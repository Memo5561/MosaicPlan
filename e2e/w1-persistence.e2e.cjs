/* Browser-Test „Zuverlässiges Speichern“ (Paket w1-persistence).
 * Voraussetzung: `npm run build` und `npx vite preview --port <port>` laufen.
 * Aufruf: node e2e/w1-persistence.e2e.cjs <baseUrl> <ausgabeOrdner>
 *
 * Geprüft wird direkt in IndexedDB (nicht nur in der Oberfläche):
 *  - Steinfarbe, verlegte Steine und Name überstehen ein Neuladen 50 ms nach der Änderung
 *  - Formänderung an einem verlegten Stein + sofortiges Verlassen → Stein ist danach nicht mehr „verlegt“
 *  - Bearbeitungen während einer Berechnung bleiben erhalten und machen den Stand „veraltet“
 *  - Verlassen + Wiederöffnen während einer Berechnung: Palette und Raster gehören danach zusammen
 *  - Löschen während einer Berechnung: Projekt kommt nicht zurück
 *  - QuotaExceededError beim Speichern: keine unbehandelte Ablehnung, nächste Änderung speichert alles nach
 *  - Laden verweigert ein Raster, das nicht zur Palette gehört; Fotowechsel macht die Berechnung veraltet
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output', 'w1-persistence');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) }).catch(() => {});
const idOf = (url) => (url.match(/#\/project\/([^/]+)/) || [])[1];
const projectUrl = (id, step) => `${BASE}#/project/${id}/${step}`;

/** Zusammenfassung des gespeicherten Stands eines Projekts, direkt aus IndexedDB gelesen. */
function summary(page, id) {
  return page.evaluate(async (id) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('mosaicplan');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const get = (store) =>
      new Promise((res, rej) => {
        const q = db.transaction(store).objectStore(store).get(id);
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      });
    const [rec, m, prog, img] = [await get('projects'), await get('mosaics'), await get('progress'), await get('images')];
    db.close();
    let maxIdx = -1;
    if (m) {
      for (let i = 0; i < m.kind.length; i++) {
        const k = m.kind[i];
        if (m.c1[i] > maxIdx) maxIdx = m.c1[i];
        if ((k === 1 || k === 2 || k === 3) && m.c2[i] > maxIdx) maxIdx = m.c2[i];
      }
      let o = 0;
      for (let j = 0; j < m.subIdx.length; j++) {
        if (m.kind[m.subIdx[j]] === 4) for (let q = o; q < o + m.subLen[j]; q++) if (m.subCol[q] > maxIdx) maxIdx = m.subCol[q];
        o += m.subLen[j];
      }
      for (const [idx, ps] of m.free) if (m.kind[idx] === 5) for (const p of ps) if (p.color > maxIdx) maxIdx = p.color;
    }
    let bits = 0;
    if (prog) for (let i = 0; i < prog.length; i++) for (let x = prog[i]; x; x >>= 1) bits += x & 1;
    return {
      exists: !!rec,
      name: rec ? rec.meta.name : null,
      joint: rec ? rec.settings.joint : null,
      paletteLen: rec ? rec.palette.length : null,
      mosaicRev: rec ? rec.mosaicRev ?? null : null,
      computedJoint: rec && rec.computedWith ? JSON.parse(rec.computedWith).l.joint : null,
      imageRev: rec ? rec.imageRev ?? null : null,
      computedImageRev: rec ? rec.computedImageRev ?? null : null,
      manualEdits: rec ? rec.meta.manualEdits ?? 0 : null,
      hasMosaic: !!m,
      mRev: m ? m.rev ?? null : null,
      maxIdx,
      progressBits: bits,
      hasProgress: !!prog,
      hasImage: !!img,
    };
  }, id);
}

/** Ändert den gespeicherten Datensatz direkt (zum Simulieren inkonsistenter Daten). */
function patchRecord(page, id, fnSrc) {
  return page.evaluate(
    async ([id, fnSrc]) => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('mosaicplan');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      await new Promise((res, rej) => {
        const t = db.transaction('projects', 'readwrite');
        const s = t.objectStore('projects');
        const q = s.get(id);
        q.onsuccess = () => {
          const rec = q.result;
          // eslint-disable-next-line no-new-func
          new Function('rec', fnSrc)(rec);
          s.put(rec, id);
        };
        t.oncomplete = res;
        t.onerror = () => rej(t.error);
      });
      db.close();
    },
    [id, fnSrc],
  );
}

async function poll(fn, timeoutMs, everyMs = 200) {
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

/** Großes Raster (ca. 500.000 Positionen), damit die Berechnung einige Sekunden dauert. */
async function makeBig(page) {
  await page.click('[data-testid="step-size"]');
  await page.fill('[data-testid="width-input"]', '600');
  await page.locator('[data-testid="width-input"]').blur();
  await page.fill('[data-testid="height-input"]', '300');
  await page.locator('[data-testid="height-input"]').blur();
  await page.click('[data-testid="step-tiles"]');
  await page.fill('[data-testid="tile-w"]', '4');
  await page.locator('[data-testid="tile-w"]').blur();
  await page.fill('[data-testid="tile-h"]', '4');
  await page.locator('[data-testid="tile-h"]').blur();
}

async function findStone(page, id) {
  if (!(await page.$('[data-testid="find-stone"]'))) await page.click('[data-testid="step-preview"]');
  await page.fill('[data-testid="find-stone"]', id);
  await page.click('form:has([data-testid="find-stone"]) button[type="submit"]');
  await page.waitForSelector('[data-testid="stone-id"]');
}
const activeColor = (page) => page.$eval('[data-testid="color-pick"] button.active small', (e) => e.textContent.trim());
const placedCount = async (page) => parseInt(((await page.textContent('[data-testid="placed-count"]')) || '').replace(/\D/g, ''), 10);

async function layTaps(page, n) {
  await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="progress-pct"]');
  if (!(await page.isChecked('label:has-text("Verlegemodus") input').catch(() => false))) await page.click('text=Verlegemodus');
  const cv = await page.$('[data-testid="mosaic-canvas"]');
  await cv.scrollIntoViewIfNeeded();
  const b = await cv.boundingBox();
  for (let i = 0; i < n; i++) await page.mouse.click(b.x + b.width / 2 + i * 14, b.y + b.height / 2);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  // Schreibfehler auf Wunsch simulieren (QuotaExceededError aus IDBObjectStore.put) und unbehandelte Ablehnungen zählen
  await context.addInitScript(() => {
    window.__unhandled = [];
    window.addEventListener('unhandledrejection', (e) => window.__unhandled.push(String(e.reason && (e.reason.stack || e.reason))));
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (v, k) {
      if (window.__failWrites) {
        window.__failCount = (window.__failCount || 0) + 1;
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      }
      return put.call(this, v, k);
    };
  });
  const page = await context.newPage();
  const errors = [];
  const warnings = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.type() === 'warning') warnings.push(m.text());
  });
  page.on('dialog', (d) => d.accept());

  // ===================== 1) Neuladen kurz nach Änderungen (Tier, kleines Raster)
  const animal = await openSample(page, 'animal');
  await computeNow(page);
  await page.waitForTimeout(1500);
  {
    // a) nur Steinfarbe, Neuladen nach 50 ms
    await findStone(page, 'J020');
    await page.click('[data-testid="color-pick"] button:not(.active) >> nth=3');
    const chosen = await activeColor(page);
    await page.waitForTimeout(50);
    await page.reload();
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 30000 });
    await findStone(page, 'J020');
    const after = await activeColor(page);
    check('Steinfarbe übersteht Neuladen nach 50 ms', after === chosen, `${chosen} → ${after}`);
    await page.keyboard.press('Escape');
  }
  {
    // b) Steinfarbe + 5 Steine verlegt + Umbenennen, dann Neuladen nach 50 ms
    await findStone(page, 'J020');
    await page.click('[data-testid="color-pick"] button:not(.active) >> nth=1');
    const chosen = await activeColor(page);
    await page.keyboard.press('Escape');
    await layTaps(page, 5);
    await page.waitForTimeout(80);
    const placedBefore = await placedCount(page);
    await page.fill('[data-testid="project-name"]', 'Neuladen nach 50 ms');
    await page.waitForTimeout(50);
    await page.reload();
    await page.waitForSelector('[data-testid="placed-count"]', { timeout: 30000 });
    await page.waitForTimeout(300);
    const placedAfter = await placedCount(page);
    const name = await page.inputValue('[data-testid="project-name"]');
    await findStone(page, 'J020');
    const colAfter = await activeColor(page);
    await page.keyboard.press('Escape');
    const s = await summary(page, animal);
    check(
      'Farbe, 5 verlegte Steine und Name überstehen Neuladen nach 50 ms',
      colAfter === chosen && placedBefore === 5 && placedAfter === placedBefore && name === 'Neuladen nach 50 ms' && s.name === name,
      `Farbe ${chosen}→${colAfter}, verlegt ${placedBefore}→${placedAfter}, Name „${name}“`,
    );
    check('Revision von Projekt und Raster gleich, Indizes in der Palette', s.mosaicRev !== null && s.mosaicRev === s.mRev && s.maxIdx < s.paletteLen, `rev ${String(s.mosaicRev).slice(0, 8)} / ${String(s.mRev).slice(0, 8)}, maxIdx ${s.maxIdx} < ${s.paletteLen}`);
    check('Manuelle Änderungen werden gezählt', s.manualEdits >= 2, `meta.manualEdits = ${s.manualEdits}`);
    await shot(page, 'w1p-01-after-reload.png');
  }

  // ===================== 2) Form eines verlegten Steins ändern und sofort verlassen
  for (const how of ['navigate', 'reload']) {
    await page.goto(projectUrl(animal, 'preview'));
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 30000 });
    await findStone(page, 'J020');
    await page.click('button:has-text("Dreiecke ╲")');
    await page.waitForTimeout(150);
    await page.click('button:has-text("ganze Zelle verlegt")');
    await page.waitForTimeout(1200);
    const placedBoth = await page.isChecked('[data-testid="stone-placed"]');
    await page.click('button:has-text("Ganzer Stein")');
    await page.waitForTimeout(60);
    const placedMem = await page.isChecked('[data-testid="stone-placed"]');
    await page.keyboard.press('Escape');
    if (how === 'navigate') {
      await page.click('text=Meine Projekte >> nth=0');
      await page.waitForSelector('[data-testid="project-row"]');
      await page.waitForTimeout(400);
      await page.goto(projectUrl(animal, 'preview'));
    } else {
      await page.reload();
    }
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 30000 });
    await findStone(page, 'J020');
    const id = (await page.textContent('[data-testid="stone-id"]')).trim();
    const placedAfter = await page.isChecked('[data-testid="stone-placed"]');
    check(
      `Formänderung an verlegtem Stein + sofort ${how === 'navigate' ? 'verlassen' : 'neu laden'} → nicht mehr verlegt`,
      placedBoth && !placedMem && !placedAfter && !/-\d/.test(id.split(/\s/)[0]),
      `vorher verlegt=${placedBoth}, im Speicher=${placedMem}, nach Öffnen=${placedAfter}, ${id.slice(0, 12)}`,
    );
    await page.keyboard.press('Escape');
  }

  // ===================== 3) Integrität beim Laden: fremde Revision / Index außerhalb der Palette
  {
    await page.goto(BASE + '#/projects');
    await page.waitForSelector('[data-testid="project-row"]');
    await page.waitForTimeout(300);
    const before = await summary(page, animal);
    await patchRecord(page, animal, "rec.__realRev = rec.mosaicRev; rec.mosaicRev = 'fremde-berechnung';");
    await page.goto(projectUrl(animal, 'compute'));
    await page.reload();
    await page.waitForSelector('[data-testid="compute-btn"]', { timeout: 30000 });
    await page.waitForTimeout(400);
    const txt = await page.textContent('.step-body');
    const badge = await page.isVisible('.ws-head .badge-ok');
    const previewDisabled = await page.$eval('[data-testid="step-preview"]', (e) => e.classList.contains('disabled'));
    check('Raster mit fremder Revision wird nicht angezeigt (Hinweis „neu berechnen“)', /passt nicht zur gespeicherten Farbpalette/.test(txt) && !badge && previewDisabled, `Badge „berechnet“=${badge}, Vorschau gesperrt=${previewDisabled}`);
    await shot(page, 'w1p-02-integrity.png');
    // Index außerhalb der Palette bei passender Revision
    await page.goto(BASE + '#/projects');
    await page.waitForSelector('[data-testid="project-row"]');
    await page.waitForTimeout(300);
    // Palette so kürzen, dass der höchste verwendete Index fehlt
    await patchRecord(page, animal, `rec.mosaicRev = rec.__realRev; rec.__palette = rec.palette; rec.palette = rec.palette.slice(0, ${before.maxIdx});`);
    await page.goto(projectUrl(animal, 'compute'));
    await page.reload();
    await page.waitForSelector('[data-testid="compute-btn"]', { timeout: 30000 });
    await page.waitForTimeout(400);
    const txt2 = await page.textContent('.step-body');
    check('Raster mit Farbindex außerhalb der Palette wird nicht angezeigt', /passt nicht zur gespeicherten Farbpalette/.test(txt2) && !(await page.isVisible('.ws-head .badge-ok')));
    // wiederherstellen → wird wieder angezeigt
    await page.goto(BASE + '#/projects');
    await page.waitForSelector('[data-testid="project-row"]');
    await page.waitForTimeout(300);
    await patchRecord(page, animal, 'rec.palette = rec.__palette; delete rec.__palette; delete rec.__realRev;');
    await page.goto(projectUrl(animal, 'preview'));
    await page.reload();
    const back = await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 30000 }).then(() => true, () => false);
    const after = await summary(page, animal);
    check('Zusammengehöriges Raster wird wieder geladen', back && after.mosaicRev === before.mosaicRev && after.paletteLen === before.paletteLen);
  }

  // ===================== 4) Fotowechsel → Berechnung veraltet
  {
    await page.goto(projectUrl(animal, 'photo'));
    await page.reload();
    await page.waitForSelector('.step-body input[type="file"]', { state: 'attached', timeout: 30000 });
    const staleBefore = await page.isVisible('.ws-head .badge-warn');
    const s0 = await summary(page, animal);
    await page.setInputFiles('.step-body input[type="file"]', path.join(__dirname, '..', 'public', 'samples', 'landscape.png'));
    await poll(async () => (await summary(page, animal)).imageRev !== s0.imageRev, 5000);
    await page.waitForTimeout(300);
    const s1 = await summary(page, animal);
    const staleAfter = await page.isVisible('.ws-head .badge-warn');
    check('Foto ersetzt → „Einstellungen geändert“ (veraltet)', !staleBefore && staleAfter && s1.imageRev && s1.imageRev !== s1.computedImageRev && s0.imageRev === s0.computedImageRev, `imageRev ${String(s0.imageRev).slice(0, 8)} → ${String(s1.imageRev).slice(0, 8)}, berechnet mit ${String(s1.computedImageRev).slice(0, 8)}`);
    await page.reload();
    await page.waitForSelector('.ws-head', { timeout: 30000 });
    await page.waitForTimeout(300);
    check('… auch nach Neuladen', await page.isVisible('.ws-head .badge-warn'));
  }

  // ===================== 5) Bearbeiten während der Berechnung (Stadt, ~500.000 Positionen)
  {
    const city = await openSample(page, 'city');
    await makeBig(page);
    await page.click('[data-testid="step-compute"]');
    const positions = await page.textContent('[data-testid="grid-positions"]');
    const t0 = Date.now();
    await page.click('[data-testid="compute-btn"]');
    await page.waitForTimeout(300);
    const running = await page.isVisible('button.btn.danger');
    await page.fill('[data-testid="project-name"]', 'Umbenannt während Berechnung');
    await page.click('[data-testid="step-joint"]');
    await page.fill('[data-testid="joint-input"]', '3');
    await page.locator('[data-testid="joint-input"]').blur();
    await page.waitForTimeout(500);
    const during = await summary(page, city);
    const done = await poll(async () => (await summary(page, city)).mosaicRev, 240000);
    const ms = Date.now() - t0;
    await page.waitForTimeout(600);
    const s = await summary(page, city);
    const stale = await page.isVisible('.ws-head .badge-warn');
    check(
      'Name und Fuge, geändert während der Berechnung, bleiben erhalten; Stand „veraltet“',
      running && during.mosaicRev === null && during.name === 'Umbenannt während Berechnung' && !!done && s.name === 'Umbenannt während Berechnung' && s.joint === 3 && s.computedJoint === 2 && stale && s.mosaicRev === s.mRev,
      `${positions} Positionen, ${ms} ms; während: Name gespeichert=${during.name === 'Umbenannt während Berechnung'}, noch ohne Ergebnis=${during.mosaicRev === null}; danach Fuge ${s.joint} (berechnet mit ${s.computedJoint}), Badge=${stale}`,
    );
    await shot(page, 'w1p-03-edit-during-compute.png');
    await page.reload();
    await page.waitForSelector('.ws-head', { timeout: 30000 });
    await page.waitForSelector('[data-testid="project-name"]');
    await page.waitForTimeout(500);
    check('… auch nach Neuladen', (await page.inputValue('[data-testid="project-name"]')) === 'Umbenannt während Berechnung' && (await page.isVisible('.ws-head .badge-warn')));
  }

  // ===================== 6) Verlassen und Wiederöffnen während einer Neuberechnung
  {
    const city = await openSample(page, 'city');
    await makeBig(page);
    await computeNow(page);
    await page.waitForTimeout(1200);
    const s1 = await summary(page, city);
    await page.click('[data-testid="step-colors"]');
    await page.click('[data-testid="color-counts"] >> text=/^8$/');
    await page.click('[data-testid="step-compute"]');
    await page.click('[data-testid="compute-btn"]');
    await page.waitForTimeout(300);
    await page.click('text=Meine Projekte >> nth=0');
    await page.waitForSelector('[data-testid="project-row"]');
    await page.goto(projectUrl(city, 'colors'));
    await page.waitForSelector('[data-testid="palette-table"]', { timeout: 30000 });
    const reopenedRev = (await summary(page, city)).mosaicRev;
    const rowsReopened = (await page.$$('[data-testid="palette-table"] tbody tr')).length;
    await page.fill('[data-testid="project-name"]', 'Wiedergeöffnet während Berechnung');
    const committed = await poll(async () => {
      const s = await summary(page, city);
      return s.mosaicRev !== s1.mosaicRev ? s : null;
    }, 240000);
    // Die wiedergeöffnete Ansicht übernimmt das Ergebnis ohne Neuladen
    const adopted = await poll(async () => (await page.$$('[data-testid="palette-table"] tbody tr')).length === 8, 5000);
    await page.fill('[data-testid="project-name"]', 'Umbenannt nach Berechnung');
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForSelector('[data-testid="palette-table"]', { timeout: 30000 });
    await page.waitForTimeout(800);
    const s = await summary(page, city);
    const rows = (await page.$$('[data-testid="palette-table"] tbody tr')).length;
    check(
      'Verlassen während Berechnung: Palette und Raster gehören zusammen',
      !!committed && s.paletteLen === s.maxIdx + 1 && s.mosaicRev === s.mRev && s.paletteLen === 8 && rows === 8 && s.name === 'Umbenannt nach Berechnung',
      `beim Öffnen noch alte Berechnung=${reopenedRev === s1.mosaicRev} (${rowsReopened} Farben), übernommen=${!!adopted}; gespeichert: Palette ${s.paletteLen}, maxIdx+1 ${s.maxIdx + 1}, rev gleich=${s.mosaicRev === s.mRev}, Name „${s.name}“`,
    );
    await page.click('[data-testid="step-preview"]');
    await page.waitForTimeout(1500);
    await shot(page, 'w1p-04-after-leave-during-compute.png');
  }

  // ===================== 7) Löschen während der Berechnung
  {
    const city = await openSample(page, 'city');
    const name = `Löschtest ${Date.now()}`;
    await page.fill('[data-testid="project-name"]', name);
    await makeBig(page);
    await page.click('[data-testid="step-compute"]');
    const t0 = Date.now();
    await page.click('[data-testid="compute-btn"]');
    await page.waitForTimeout(300);
    const running = await page.isVisible('button.btn.danger');
    await page.click('text=Meine Projekte >> nth=0');
    const row = page.locator('[data-testid="project-row"]', { hasText: name });
    await row.waitFor();
    await row.locator('button:has-text("Löschen")').click();
    await row.waitFor({ state: 'detached' });
    const goneEarly = !(await summary(page, city)).exists;
    // Berechnung im Hintergrund zu Ende laufen lassen (dauert hier einige Sekunden)
    await page.waitForTimeout(Math.max(6000, 3 * (Date.now() - t0)));
    await page.reload();
    await page.waitForSelector('h1');
    await page.waitForTimeout(500);
    const s = await summary(page, city);
    const listed = await page.locator('[data-testid="project-row"]', { hasText: name }).count();
    check('Löschen während Berechnung: Projekt kommt nicht zurück', running && goneEarly && !s.exists && !s.hasMosaic && !s.hasProgress && !s.hasImage && listed === 0, `lief=${running}, Datensatz=${s.exists}, Raster=${s.hasMosaic}, Fortschritt=${s.hasProgress}, Foto=${s.hasImage}, in Liste=${listed}`);
  }

  // ===================== 8) Speicherfehler (QuotaExceededError)
  {
    const land = await openSample(page, 'landscape');
    await computeNow(page);
    await page.waitForTimeout(1500);
    await layTaps(page, 0);
    const before = await summary(page, land);
    const warnsBefore = warnings.length;
    await page.evaluate(() => (window.__failWrites = true));
    await page.fill('[data-testid="project-name"]', 'Quota-Test');
    await page.waitForTimeout(900);
    const failing = await summary(page, land);
    const failCount = await page.evaluate(() => window.__failCount || 0);
    const unhandled = await page.evaluate(() => window.__unhandled.slice());
    const warned = warnings.slice(warnsBefore).some((w) => /Speichern fehlgeschlagen/.test(w));
    check('Speicherfehler: keine unbehandelte Ablehnung, kein Absturz', failCount > 0 && unhandled.length === 0 && failing.name === before.name && warned, `Fehlversuche ${failCount}, unbehandelt ${unhandled.length}, gespeicherter Name „${failing.name}“`);
    await page.evaluate(() => (window.__failWrites = false));
    await layTaps(page, 1);
    await page.waitForTimeout(450);
    const unhandledAfter = await page.evaluate(() => window.__unhandled.length);
    await page.reload();
    await page.waitForSelector('[data-testid="placed-count"]', { timeout: 30000 });
    await page.waitForTimeout(300);
    const s = await summary(page, land);
    const name = await page.inputValue('[data-testid="project-name"]');
    check('Nach dem Fehler speichert die nächste Änderung auch den nicht gespeicherten Namen', s.name === 'Quota-Test' && name === 'Quota-Test' && s.progressBits === before.progressBits + 1, `Name „${name}“, verlegte Teile ${before.progressBits}→${s.progressBits}`);
    check('Auch nach dem erneuten Speichern keine unbehandelte Ablehnung', unhandledAfter === 0);
  }

  // ===================== 9) Zwei Tabs: Neuberechnung im anderen Tab wird übernommen, Löschen dort wird respektiert
  {
    const id = await openSample(page, 'animal');
    await computeNow(page);
    await page.waitForTimeout(1200);
    await page.click('[data-testid="step-colors"]');
    await page.waitForSelector('[data-testid="palette-table"]');
    const rowsBefore = (await page.$$('[data-testid="palette-table"] tbody tr')).length;
    const tab2 = await context.newPage();
    tab2.on('pageerror', (e) => errors.push(String(e)));
    tab2.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    tab2.on('dialog', (d) => d.accept());
    await tab2.goto(projectUrl(id, 'colors'));
    await tab2.waitForSelector('[data-testid="palette-table"]');
    await tab2.click('[data-testid="color-counts"] >> text=/^8$/');
    await tab2.click('[data-testid="step-compute"]');
    await tab2.click('[data-testid="compute-btn"]');
    await tab2.waitForSelector('[data-testid="step-preview"].active', { timeout: 120000 });
    const adopted = await poll(async () => (await page.$$('[data-testid="palette-table"] tbody tr')).length === 8, 8000);
    const staleTab1 = await page.isVisible('.ws-head .badge-warn');
    await page.fill('[data-testid="project-name"]', 'Zwei Tabs');
    await page.waitForTimeout(700);
    const s = await summary(page, id);
    check(
      'Neuberechnung in anderem Tab: dieser Tab übernimmt Raster + Palette, Speichern bleibt konsistent',
      !!adopted && !staleTab1 && s.name === 'Zwei Tabs' && s.paletteLen === 8 && s.mosaicRev === s.mRev && s.maxIdx < s.paletteLen,
      `Farben ${rowsBefore} → ${adopted ? 8 : '?'}, veraltet-Badge=${staleTab1}, gespeichert: Palette ${s.paletteLen}, maxIdx ${s.maxIdx}, rev gleich=${s.mosaicRev === s.mRev}`,
    );
    await tab2.goto(BASE + '#/projects');
    const row = tab2.locator('[data-testid="project-row"]', { hasText: 'Zwei Tabs' });
    await row.waitFor();
    await row.locator('button:has-text("Löschen")').click();
    await row.waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
    await page.fill('[data-testid="project-name"]', 'Nach dem Löschen umbenannt');
    await page.waitForTimeout(800);
    const gone = !(await summary(page, id)).exists;
    await page.reload();
    await page.waitForSelector('.page', { timeout: 30000 });
    await page.waitForTimeout(800);
    const goneAfterReload = !(await summary(page, id)).exists;
    check('Im anderen Tab gelöscht: Bearbeiten/Neuladen legt das Projekt nicht wieder an', gone && goneAfterReload, `nach Umbenennen gelöscht=${gone}, nach Neuladen gelöscht=${goneAfterReload}`);
    await tab2.close();
  }

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
