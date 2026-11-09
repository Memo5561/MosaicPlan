/* w5-stats-engine: Statistik aus einem Durchlauf im echten Browser (Chromium/Playwright).
 * Aufruf: node e2e/w5-stats-engine.e2e.cjs <baseUrl> <outDir>
 *
 * Prüft:
 *  - Die App bekommt ihre Gesamtstatistik weiterhin vom Worker (Materialansicht zeigt Zahlen, „Steine“ = verlegt + offen).
 *  - Der Statistik-Auftrag des gebauten Workers liefert mit `sections` in EINEM Durchlauf Gesamt + je Abschnitt
 *    (ids wie die Abschnitte der App), die Abschnitte summieren sich zur Gesamtzahl, die Prüfzähler sind gesetzt
 *    (keine dünnen Teile, keine Überlappung bei einem frisch berechneten Mosaik) und ohne `sections`/`minPieceMm`
 *    bleibt die Antwort wie bisher (nur Gesamt, Mindestbreite nicht geprüft).
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w5-stats-engine');
fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
function check(name, ok, info = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const num = (s) => parseInt(String(s).replace(/\D/g, ''), 10);

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  try {
    await page.goto(BASE);
    await page.waitForSelector('[data-testid="sample-portrait"]');
    await page.click('[data-testid="sample-portrait"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });

    // ---------- App: Gesamtstatistik aus dem Worker
    await page.click('[data-testid="step-plan"]');
    await page.waitForSelector('[data-testid="placed-count"]');
    // Abschnitt A1 als verlegt markieren, damit „verlegt“ in Gesamt und Abschnitten mitgezählt wird
    await page.click('[data-testid="section-cell"] >> nth=0');
    await page.click('[data-testid="section-done"]');
    await page.waitForFunction(() => parseInt((document.querySelector('[data-testid="placed-count"]')?.textContent || '0').replace(/\D/g, ''), 10) > 0);
    await page.waitForTimeout(2500); // Fortschritt gespeichert (IndexedDB), bevor der Worker-Test ihn liest
    await page.click('text=Material >> nth=-1');
    await page.waitForSelector('[data-testid="material-calc"][data-busy="no"]', { timeout: 60000 });
    await page.waitForSelector('[data-testid="mc-pieces"]');
    const mcPieces = num(await page.textContent('[data-testid="mc-pieces"]'));
    const placed = num(await page.textContent('[data-testid="placed-count"]'));
    const open = num(await page.textContent('[data-testid="open-count"]'));
    check('Materialansicht zeigt die Worker-Statistik', mcPieces > 0, `${mcPieces} Steine`);
    check('Steine (Statistik) = verlegt + offen (Fortschrittszähler)', mcPieces === placed + open, `${mcPieces} = ${placed} + ${open}`);
    await page.screenshot({ path: path.join(OUT, '01-material.png') });

    // ---------- Gebauter Worker direkt: Statistik-Auftrag mit und ohne Abschnitte
    const res = await page.evaluate(async () => {
      const idb = (name) =>
        new Promise((resolve, reject) => {
          const r = indexedDB.open(name);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      const all = (db, store) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(store, 'readonly');
          const s = tx.objectStore(store);
          const keys = s.getAllKeys();
          const vals = s.getAll();
          tx.oncomplete = () => resolve(keys.result.map((k, i) => [k, vals.result[i]]));
          tx.onerror = () => reject(tx.error);
        });
      const db = await idb('mosaicplan');
      const projects = await all(db, 'projects');
      const [id, rec] = projects[projects.length - 1];
      const mosaic = (await all(db, 'mosaics')).find(([k]) => k === id)[1];
      const progress = (await all(db, 'progress')).find(([k]) => k === id)?.[1];
      const materials = (await all(db, 'materials')).map(([, v]) => v);
      // Worker-Datei aus dem Haupt-Bundle (so wie die App ihn startet)
      const scripts = [...document.querySelectorAll('script[type="module"][src]')].map((s) => s.src);
      let workerUrl = null;
      for (const src of scripts) {
        const txt = await (await fetch(src)).text();
        const m = txt.match(/compute\.worker-[\w-]+\.js/);
        if (m) workerUrl = new URL(`assets/${m[0]}`, document.baseURI).href;
      }
      if (!workerUrl) return { error: 'Worker-Datei nicht gefunden' };
      const s = rec.settings;
      const layoutParams = { widthMm: s.widthMm, heightMm: s.heightMm, tileW: s.tileW, tileH: s.tileH, joint: s.joint, edgeMode: s.edgeMode, minCutMm: s.minCutMm };
      const sections = { sectionMode: s.sectionMode, sectionWmm: s.sectionWmm, sectionHmm: s.sectionHmm, sectionCols: s.sectionCols, sectionRows: s.sectionRows };
      const w = new Worker(workerUrl, { type: 'module' });
      const ask = (msg) =>
        new Promise((resolve, reject) => {
          const t0 = performance.now();
          w.onmessage = (ev) => (ev.data.type === 'error' ? reject(new Error(ev.data.message)) : ev.data.type === 'stats' && resolve({ ...ev.data, ms: performance.now() - t0 }));
          w.onerror = (e) => reject(new Error(e.message));
          w.postMessage(msg);
        });
      const base = { type: 'stats', layoutParams, mosaic: { ...mosaic, progress: progress ?? new Uint16Array(mosaic.kind.length) }, palette: rec.palette, materials, reservePct: s.reservePct, groutDepthMm: s.groutDepthMm };
      const plain = await ask({ ...base, id: 1 });
      const full = await ask({ ...base, id: 2, sections, minPieceMm: s.shapes.minPieceMm });
      w.terminate();
      const sum = (f) => full.perSection.reduce((a, x) => a + f(x.stats), 0);
      return {
        workerUrl,
        minPiece: s.shapes.minPieceMm,
        plain: { pieces: plain.total.pieces, perSection: plain.perSection.length, thin: plain.total.thinPieces, overlap: plain.total.overlapCells, ms: plain.ms, json: JSON.stringify(plain.total) },
        full: {
          pieces: full.total.pieces,
          ids: full.perSection.map((x) => x.id),
          sumPieces: sum((x) => x.pieces),
          sumPlaced: sum((x) => x.placed),
          placed: full.total.placed,
          sumGrid: sum((x) => x.gridPositions),
          grid: full.total.gridPositions,
          thin: full.total.thinPieces,
          thinFree: full.total.thinFreePieces,
          overlap: full.total.overlapCells,
          invalid: full.total.invalidPieces,
          ms: full.ms,
          totalSameAsPlain: (() => {
            const a = { ...full.total };
            delete a.thinPieces;
            delete a.thinFreePieces;
            return JSON.stringify(a) === JSON.stringify(plain.total);
          })(),
        },
      };
    });
    if (res.error) check('Worker-Datei gefunden', false, res.error);
    else {
      const f = res.full;
      check('Worker ohne Abschnitte: nur Gesamt (wie die App anfragt)', res.plain.perSection === 0 && res.plain.pieces === mcPieces, `${res.plain.pieces} Steine, ${Math.round(res.plain.ms)} ms`);
      check('ohne Mindestbreite: dünne Teile nicht geprüft (kein Wert), Überlappung geprüft', res.plain.thin === undefined && res.plain.overlap === 0, `thin=${res.plain.thin} overlap=${res.plain.overlap}`);
      check('Worker mit Abschnitten: ein Durchlauf liefert Gesamt + je Abschnitt', f.ids.length > 1 && f.ids[0] === 'A1', `${f.ids.length} Abschnitte (${f.ids.slice(0, 4).join(', ')} …), ${Math.round(f.ms)} ms`);
      check('Σ Abschnitte = Gesamt (Steine, verlegt, Rasterpositionen)', f.sumPieces === f.pieces && f.sumPlaced === f.placed && f.sumGrid === f.grid, `${f.sumPieces}/${f.pieces}, ${f.sumPlaced}/${f.placed}, ${f.sumGrid}/${f.grid}`);
      check('verlegt (Worker-Statistik) = verlegt (Fortschrittszähler der App)', f.placed === placed && placed > 0, `${f.placed} = ${placed}`);
      check('Gesamt mit Abschnitten = Gesamt ohne (bis auf die Mindestbreiten-Zähler)', f.totalSameAsPlain);
      check(`frisch berechnet: kein Teil unter ${res.minPiece} mm, keine Überlappung, keine Teile ohne Fläche`, f.thin === 0 && f.thinFree === 0 && f.overlap === 0 && f.invalid === 0, `thin=${f.thin} free=${f.thinFree} overlap=${f.overlap} invalid=${f.invalid}`);
    }

    // ---------- Telefon: Materialansicht weiterhin ohne Fehler
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, '02-material-phone.png') });

    check('keine Konsolen- oder Seitenfehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    check('Ablauf ohne Ausnahme', false, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e));
    await page.screenshot({ path: path.join(OUT, 'error.png') }).catch(() => {});
  } finally {
    await browser.close();
  }
  console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : 'alle Prüfungen bestanden');
  process.exit(failed ? 1 : 0);
})();
