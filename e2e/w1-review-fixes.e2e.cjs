/* Browser-Test der Nachbesserungen nach dem Review von Welle 1.
 * Aufruf: node e2e/w1-review-fixes.e2e.cjs <baseUrl> <outDir>   (vorher: npm run build && npx vite preview)
 *
 *  1. Eigene Palette während einer Berechnung: Palette gesperrt (auch in einer neu geöffneten Ansicht);
 *     eine anderswo gespeicherte Ergänzung bleibt erhalten und das Projekt gilt als geändert; eine
 *     anderswo verkürzte Palette führt zu einer klaren Meldung statt zu falschen Farben.
 *  2. „Farbe entfernen“-Dialog: Palette schrumpft durch eine Berechnung in einem anderen Tab → kein weißer
 *     Bildschirm, Dialog schließt mit Hinweis.
 *  3. Altes Projekt mit Raster, das nicht zur Palette passt: Hinweis auf jedem Schritt, Warnung vor dem
 *     Verlust des Verlegefortschritts mit Sicherung als Kopie.
 *  4. Material-Import ohne Maße: „unbekannt – Rastermaß“ statt „0 × 0 × 0 mm“, Einzahl bei einer Zeile.
 *  5. 4-mm-Steine mit 1 mm Fuge: ehrliche Begründung (Inkreismaß), bis wohin Dreiecke möglich wären.
 *  6. Darstellungsfehler (beschädigte Daten): Fehlergrenze statt weißem Bildschirm.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output', 'w1-review-fixes');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const idOf = (url) => (url.match(/#\/project\/([^/]+)/) || [])[1];

/** Liest einen Eintrag direkt aus IndexedDB. */
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
            resolve(v === undefined ? null : JSON.parse(JSON.stringify(v, (k, x) => (ArrayBuffer.isView(x) ? { len: x.length } : x))));
          };
          q.onerror = () => reject(q.error);
        };
        r.onerror = () => reject(r.error);
      }),
    [store, id],
  );

/** Ändert einen Eintrag direkt in IndexedDB (wie es eine andere Ansicht / ein anderer Tab beim Speichern täte). */
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

const setNum = async (page, testId, value) => {
  await page.fill(`[data-testid="${testId}"]`, value);
  await page.locator(`[data-testid="${testId}"]`).blur();
};

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // =============================================================== 1. Eigene Palette während der Berechnung
  await page.goto(BASE);
  await page.click('[data-testid="sample-animal"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  const id = idOf(page.url());
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
  await page.click('[data-testid="step-colors"]');
  await page.click('[data-testid="palette-mode"] >> text=Eigene Palette');
  // größer rechnen, damit die Berechnung lange genug läuft
  await page.click('[data-testid="step-size"]');
  await setNum(page, 'width-input', '600');
  await setNum(page, 'height-input', '300');
  await page.click('[data-testid="step-tiles"]');
  await setNum(page, 'tile-w', '4');
  await setNum(page, 'tile-h', '4');
  await page.waitForTimeout(800);
  const pal0 = (await dbGet(page, 'projects', id)).palette;

  // 1a: Sperre in derselben Ansicht
  await page.click('[data-testid="step-compute"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForTimeout(300);
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="palette-locked"]', { timeout: 5000 }).catch(() => {});
  const lockedSame = await page.isVisible('[data-testid="palette-locked"]');
  const addDisabled = await page.isDisabled('button:has-text("Farbe hinzufügen")');
  await page.screenshot({ path: path.join(OUT, 'fx-01-locked.png') });
  check('Während der Berechnung: Palette gesperrt (Hinweis, „Farbe hinzufügen“ deaktiviert)', lockedSame && addDisabled);

  // 1b: anderswo gespeicherte Ergänzung (z. B. andere Ansicht) – bleibt erhalten, Projekt gilt als geändert
  await dbPatch(
    page,
    'projects',
    id,
    `const max = rec.palette.reduce((m, p) => Math.max(m, p.code), 0);
     rec.palette.push({ code: max + 1, hex: '#3366CC', name: 'E2E-Blau', lab: [43.2, 9.6, -51.7] });`,
  );
  check('(Voraussetzung) Ergänzung gespeichert, während die Berechnung noch läuft', await page.isVisible('[data-testid="palette-locked"]'));
  await page.waitForSelector('[data-testid="palette-locked"]', { state: 'detached', timeout: 600000 });
  await page.waitForTimeout(1500);
  // nach der Berechnung springt die Ansicht zur Vorschau – zurück zu den Farben
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('.palette-editor h3');
  const recA = await dbGet(page, 'projects', id);
  const stale = await page.isVisible('button.badge-warn:has-text("Einstellungen geändert")');
  const headerA = await page.textContent('.palette-editor h3');
  check(
    'Ergänzte Farbe bleibt nach der Berechnung erhalten (Gerätespeicher und Anzeige)',
    recA.palette.length === pal0.length + 1 && recA.palette[recA.palette.length - 1].hex === '#3366CC' && headerA.includes(`(${pal0.length + 1})`),
    `${pal0.length} → ${recA.palette.length}, ${headerA.trim().slice(0, 30)}`,
  );
  check('… und das Projekt zeigt „Einstellungen geändert“ (berechnet wurde ohne die neue Farbe)', stale);

  // 1c: anderswo verkürzte Palette – Ergebnis wird verworfen, Palette und Raster bleiben, klare Meldung
  const revBefore = recA.mosaicRev;
  await page.click('[data-testid="step-compute"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForTimeout(300);
  await dbPatch(page, 'projects', id, `rec.palette = rec.palette.slice(1);`);
  check('(Voraussetzung) Verkürzung gespeichert, während die Berechnung noch läuft', !(await page.isVisible('[data-testid="compute-btn"]')));
  await page.waitForSelector('[data-testid="compute-btn"]', { timeout: 600000 });
  await page.waitForTimeout(800);
  const recB = await dbGet(page, 'projects', id);
  const errTxt = (await page.textContent('.step-body p.error').catch(() => '')) || '';
  check(
    'Palette während der Berechnung verkürzt: Ergebnis verworfen, Meldung, Palette und Raster unverändert',
    /verkürzt oder umsortiert/.test(errTxt) && recB.mosaicRev === revBefore && recB.palette.length === recA.palette.length - 1,
    `${errTxt.slice(0, 80)} · Rev gleich: ${recB.mosaicRev === revBefore}`,
  );

  // 1d: Sperre auch in einer neu geöffneten Ansicht (Berechnung läuft im Hintergrund weiter)
  await page.goto(BASE + `#/project/${id}/compute`);
  await page.reload();
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForTimeout(300);
  await page.click('text=Meine Projekte >> nth=0');
  await page.waitForTimeout(300);
  await page.goto(BASE + `#/project/${id}/colors`);
  await page.waitForSelector('.palette-editor');
  const lockedReopen = await page.isVisible('[data-testid="palette-locked"]');
  check('Neu geöffnete Ansicht während der Hintergrundberechnung: Palette gesperrt', lockedReopen);
  await page.waitForSelector('[data-testid="palette-locked"]', { state: 'detached', timeout: 600000 });
  check('Nach dem Ende der Berechnung: Sperre aufgehoben', !(await page.isVisible('[data-testid="palette-locked"]')));

  // =============================================================== 2. Dialog bei schrumpfender Palette
  await page.goto(BASE);
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  const id2 = idOf(page.url());
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="palette-table"]');
  const nRows = await page.$$eval('[data-testid="palette-table"] tbody tr', (r) => r.length);
  await page.click(`[data-testid="palette-remove"] >> nth=${nRows - 2}`);
  await page.waitForSelector('[data-testid="palette-remove-dialog"]');
  // anderer Tab speichert eine Berechnung mit nur 8 Farben und meldet sie (wie commitComputed)
  const tab2 = await context.newPage();
  await tab2.goto(BASE + '#/projects');
  await dbPatch(tab2, 'projects', id2, `rec.palette = rec.palette.slice(0, 8); rec.mosaicRev = 'e2e-fremd';`);
  await tab2.evaluate((pid) => new BroadcastChannel('mosaicplan').postMessage({ type: 'computed', id: pid, mosaicRev: 'e2e-fremd', source: 'e2e' }), id2);
  await page.waitForTimeout(1500);
  const rootKids = await page.$eval('#root', (r) => r.childElementCount);
  const dialogOpen = await page.isVisible('[data-testid="palette-remove-dialog"]');
  const notice = ((await page.textContent('[data-testid="palette-notice"]').catch(() => '')) || '').trim();
  await page.screenshot({ path: path.join(OUT, 'fx-02-dialog-closed.png') });
  check('Palette schrumpft bei offenem Dialog: kein weißer Bildschirm, Dialog zu, Hinweis', rootKids > 0 && !dialogOpen && /inzwischen geändert/.test(notice), notice);
  await tab2.close();

  // =============================================================== 3. Altes Projekt: Raster passt nicht zur Palette
  await page.goto(BASE);
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  const id3 = idOf(page.url());
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
  await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="progress-pct"]');
  await page.click('.section-cell >> nth=0');
  await page.click('text=Abschnitt fertig');
  await page.waitForTimeout(2000);
  await page.goto(BASE + '#/projects');
  await page.waitForSelector('[data-testid="project-row"]');
  const before = await page.$$eval('[data-testid="project-row"]', (r) => r.length);
  const prog = await page.evaluate(
    (pid) =>
      new Promise((resolve) => {
        const r = indexedDB.open('mosaicplan');
        r.onsuccess = () => {
          const q = r.result.transaction('progress').objectStore('progress').get(pid);
          q.onsuccess = () => {
            let n = 0;
            for (const v of q.result || []) for (let x = v; x; x >>= 1) n += x & 1;
            r.result.close();
            resolve(n);
          };
        };
      }),
    id3,
  );
  // Zustand einer älteren Version: keine Revisionen, eigene Palette durch weniger Farben ersetzt
  await dbPatch(page, 'projects', id3, `delete rec.mosaicRev; rec.settings.paletteMode = 'custom'; rec.palette = rec.palette.slice(0, 3);`);
  await dbPatch(page, 'mosaics', id3, `delete rec.rev;`);
  await page.goto(BASE + `#/project/${id3}`);
  await page.reload();
  await page.waitForSelector('.step-body');
  await page.waitForTimeout(600);
  const banner = ((await page.textContent('[data-testid="integrity-banner"]').catch(() => '')) || '').trim();
  check('Hinweis „passt nicht zur Farbpalette“ schon auf Schritt 1 (nicht nur in Schritt 7)', /passt nicht zur gespeicherten Farbpalette/.test(banner), banner.slice(0, 80));
  await page.click('[data-testid="step-preview"]');
  await page.waitForTimeout(300);
  const prevTxt = await page.textContent('.step-body');
  check('Vorschau nennt den Grund statt „Bitte zuerst berechnen“', /passt nicht zur gespeicherten Farbpalette/.test(prevTxt) && !/Bitte zuerst das Mosaik berechnen/.test(prevTxt));
  await page.click('[data-testid="integrity-banner"] >> text=Zu Schritt 7');
  await page.waitForSelector('[data-testid="placed-loss"]');
  const loss = (await page.textContent('[data-testid="placed-loss"]')).replace(/\s+/g, ' ');
  await page.screenshot({ path: path.join(OUT, 'fx-03-placed-loss.png'), fullPage: true });
  check('Schritt 7: Warnung mit Anzahl verlegter Steine, die beim Neuberechnen verloren gehen', prog > 0 && loss.includes(prog.toLocaleString('de-DE')) && /verloren/.test(loss), `${prog} verlegt · ${loss.slice(0, 90)}`);
  await page.click('[data-testid="placed-loss-copy"]');
  await page.waitForSelector('[data-testid="placed-loss-msg"]');
  const copyMsg = (await page.textContent('[data-testid="placed-loss-msg"]')).trim();
  await page.goto(BASE + '#/projects');
  await page.waitForSelector('[data-testid="project-row"]');
  const after = await page.$$eval('[data-testid="project-row"]', (r) => r.length);
  check('„Als Kopie sichern“ legt eine vollständige Kopie an', /Kopie/.test(copyMsg) && after >= before + 1, copyMsg);

  // =============================================================== 4. Material-Import ohne Maße
  await page.goto(BASE + '#/materials');
  await page.waitForSelector('[data-testid="import-input"]', { state: 'attached' });
  await page.setInputFiles('[data-testid="import-input"]', { name: 'eine.csv', mimeType: 'text/csv', buffer: Buffer.from('Hersteller;Farbnummer;HEX\nSicis;E2E-09;#3A6EA5\n', 'utf8') });
  await page.waitForSelector('[data-testid="import-preview"]');
  const prev = (await page.textContent('[data-testid="import-preview"]')).replace(/\s+/g, ' ');
  check('Vorschau: „1 Datenzeile“ und „1 neues Material anlegen“ (Einzahl)', /1 Datenzeile(?!n)/.test(prev) && /1 neues Material anlegen/.test(prev) && !/1 Datenzeilen/.test(prev), prev.match(/Importieren:[^.]*\./)?.[0] ?? '');
  await page.click('[data-testid="import-apply"]');
  await page.waitForTimeout(800);
  const dims = await page.$$eval('[data-testid="materials-table"] tbody tr', (trs) =>
    trs.filter((tr) => tr.textContent.includes('E2E-09')).map((tr) => tr.querySelector('[data-testid="material-dims"]').textContent.trim()),
  );
  check('Material ohne Maße: „unbekannt – Rastermaß“ statt „0 × 0 × 0 mm“', dims.length === 1 && /unbekannt – Rastermaß/.test(dims[0]) && !/0 × 0/.test(dims[0]), dims.join(' | '));

  // =============================================================== 5. 4-mm-Steine: ehrliche Begründung
  await page.goto(BASE);
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="step-tiles"]');
  await setNum(page, 'tile-w', '4');
  await setNum(page, 'tile-h', '4');
  await page.click('[data-testid="step-shapes"]');
  await page.waitForSelector('[data-testid="diag-too-small"]');
  const diag4 = (await page.textContent('[data-testid="diag-too-small"]')).trim();
  const line4 = ((await page.textContent('[data-testid="line-too-small"]').catch(() => '')) || '').trim();
  await page.screenshot({ path: path.join(OUT, 'fx-05-shapes-4mm.png'), fullPage: true });
  check('4 × 4 mm / 1 mm Fuge / 2 mm: Grund Inkreismaß 1,93 mm, schmalste Stelle 2,33 mm, möglich bis 1,9 mm', /Inkreismaß 1,93 mm < 2 mm \(schmalste Stelle 2,33 mm\)/.test(diag4) && /bis zu einer Mindestbreite von 1,9 mm/.test(diag4), diag4);
  check('… und Hinweis, dass kein Kantenschnitt die Mindestbreite erfüllt', /kein möglicher Kantenschnitt/.test(line4), line4.slice(0, 90));

  // =============================================================== Handy: Einkaufsliste/Hinweise ohne waagerechtes Scrollen
  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('Handy-Breite: kein waagerechtes Scrollen in Schritt Steinformen', overflow <= 1, `Überlauf ${overflow}px`);

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));

  // =============================================================== 6. Fehlergrenze: kein weißer Bildschirm
  // (absichtlich beschädigte Projektdaten → Darstellungsfehler; danach sind Fehlermeldungen in der Konsole erwartet)
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto(BASE);
  await page.click('[data-testid="sample-animal"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  const id6 = idOf(page.url());
  await page.goto(BASE + '#/projects');
  await page.waitForSelector('[data-testid="project-row"]');
  await dbPatch(page, 'projects', id6, `rec.settings.shapes = null;`);
  await page.goto(BASE + `#/project/${id6}/shapes`);
  await page.reload();
  await page.waitForSelector('[data-testid="app-crash"]', { timeout: 10000 }).catch(() => {});
  const crashTxt = ((await page.textContent('[data-testid="app-crash"]').catch(() => '')) || '').trim();
  const navOk = await page.isVisible('.mainnav');
  await page.screenshot({ path: path.join(OUT, 'fx-06-error-boundary.png') });
  check('Darstellungsfehler: Hinweis mit „Neu laden“/„Zur Startseite“ statt weißem Bildschirm, Navigation bleibt', /konnte nicht angezeigt werden/.test(crashTxt) && navOk, crashTxt.slice(0, 60));
  await page.click('[data-testid="app-crash"] button:has-text("Zur Startseite")');
  await page.waitForSelector('[data-testid="sample-portrait"]');
  check('„Zur Startseite“ führt aus dem Fehler heraus', await page.isVisible('[data-testid="sample-portrait"]'));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
