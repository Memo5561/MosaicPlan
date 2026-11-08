/* Paket w4-progress-engine im echten Browser (Chromium/Playwright).
 * Voraussetzung: `npm run build` und `npx vite preview --port 4302` laufen.
 * Aufruf: node e2e/w4-progress-engine.e2e.cjs [baseUrl] [screenshotDir]
 *
 * Geprüft wird:
 *  - „Meine Projekte“ und die Startseite zeigen „NN % verlegt“ mit Balken – exakt aus dem gespeicherten Fortschritt
 *  - Neu berechnen mit gleichen Einstellungen übernimmt 100 % der verlegten Steine (Hinweis, Zahlen, Speicher)
 *  - geänderte Palettenfarbe: genau die Steine dieser Farbe sind wieder offen und werden mit Position gemeldet;
 *    „anzeigen“ öffnet den Stein im Steindetail
 *  - andere Fuge: „Raster geändert – Fortschritt nicht übertragbar“, nichts verlegt, Liste zeigt 0 %
 *  - großes Projekt (≈ 1,4 Mio. Steine): 12 Antipp-Vorgänge im Abstand von 2 s lösen höchstens 2 Statistik-Aufträge
 *    aus (gezählt am Worker) und keine lange Aufgabe über 50 ms; die Zähler stimmen mit dem Speicher überein
 *  - Handy-Ansicht „Meine Projekte“ ohne seitlichen Überlauf
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4302/';
/** Nur einen Teil ausführen (Entwicklung): W4PE_ONLY=list | big | phone */
const ONLY = process.env.W4PE_ONLY || '';
const run = (part) => !ONLY || ONLY === part;
const OUT = process.argv[3] || path.join(__dirname, 'output', 'w4-progress-engine');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const shot = (page, name, full = false) => page.screenshot({ path: path.join(OUT, name), fullPage: full }).catch(() => {});
const idOf = (url) => (url.match(/#\/project\/([^/]+)/) || [])[1];
const digits = (s) => parseInt(String(s || '').replace(/\D/g, ''), 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, timeoutMs, everyMs = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(everyMs);
  }
}

const saved = (page) => page.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 20000 }).catch(() => null);

/** Liest einen Datensatz direkt aus IndexedDB (typisierte Arrays als normale Arrays). */
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
 * Verlegte Steine im Speicher – gesamt und je Farbindex (Teile in derselben Reihenfolge wie cellPieces:
 * ganzer Stein c1; Dreiecke/Kantenschnitt c1, c2; k×k sub[i]; Freiform free[i].color). Nur Bits vorhandener Teile.
 */
const storedLaid = (page, id) =>
  page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('mosaicplan');
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction(['mosaics', 'progress']);
          const out = {};
          tx.objectStore('mosaics').get(id).onsuccess = (e) => (out.m = e.target.result);
          tx.objectStore('progress').get(id).onsuccess = (e) => (out.p = e.target.result);
          tx.oncomplete = () => {
            db.close();
            const { m, p } = out;
            const sub = new Map();
            let o = 0;
            for (let i = 0; i < m.subIdx.length; i++) {
              sub.set(m.subIdx[i], m.subCol.slice(o, o + m.subLen[i]));
              o += m.subLen[i];
            }
            const free = new Map(m.free.map(([k, v]) => [k, v]));
            let placed = 0;
            let total = 0;
            const byColor = {};
            for (let idx = 0; idx < m.kind.length; idx++) {
              const k = m.kind[idx];
              const cols = k === 0 ? [m.c1[idx]] : k === 4 ? Array.from(sub.get(idx) || [m.c1[idx]]) : k === 5 ? (free.get(idx) || []).map((f) => f.color) : [m.c1[idx], m.c2[idx]];
              total += cols.length;
              for (let i = 0; i < cols.length; i++) {
                if ((p[idx] >> i) & 1) {
                  placed++;
                  byColor[cols[i]] = (byColor[cols[i]] || 0) + 1;
                }
              }
            }
            resolve({ placed, total, byColor, rev: m.rev });
          };
          tx.onerror = () => reject(tx.error);
        };
        r.onerror = () => reject(r.error);
      }),
    id,
  );

async function placedNow(page) {
  if (!(await page.$('[data-testid="placed-count"]'))) await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="placed-count"]');
  await page.waitForTimeout(250);
  return digits(await page.textContent('[data-testid="placed-count"]'));
}

/** Neu berechnen über Schritt 7 (mit Rückfrage „ohne Sicherung“, falls sie erscheint). */
async function recompute(page) {
  await page.click('[data-testid="step-compute"]');
  await page.click('[data-testid="compute-btn"]');
  const guard = await page.waitForSelector('[data-testid="recompute-guard"]', { timeout: 4000 }).catch(() => null);
  let lossText = '';
  if (guard) {
    lossText = ((await page.textContent('[data-testid="guard-loss"]')) || '').trim();
    await page.click('[data-testid="guard-nobackup"]');
  }
  await page.waitForSelector('[data-testid="step-preview"].active', { timeout: 240000 });
  await page.waitForSelector('[data-testid="carry-notice"], [data-testid="mosaic-canvas"]', { timeout: 30000 });
  return lossText;
}

async function projectRowProgress(page, id) {
  await page.goto(BASE + '#/projects');
  await page.waitForSelector(`[data-testid="project-row"][data-project="${id}"]`);
  const el = await page.$(`[data-testid="project-row"][data-project="${id}"] [data-testid="project-progress"]`);
  if (!el) return null;
  return {
    text: ((await el.textContent()) || '').trim(),
    placed: Number(await el.getAttribute('data-placed')),
    total: Number(await el.getAttribute('data-total')),
    title: await el.getAttribute('title'),
  };
}

/** Steine je Zelle eines synthetischen Großprojekts als IndexedDB-Datensätze (ohne Berechnung). */
async function createBigProject(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        // Raster: 1200 × 1000 Zellen (3,5-mm-Steine, 0,5-mm-Fuge, nur ganze Steine → exakt so viele Positionen)
        const cols = 1200;
        const rows = 1000;
        const tile = 3.5;
        const joint = 0.5;
        const lp = { widthMm: cols * tile + (cols - 1) * joint, heightMm: rows * tile + (rows - 1) * joint, tileW: tile, tileH: tile, joint, edgeMode: 'whole', minCutMm: 2 };
        const hexes = ['#F2EDE4', '#D9C7A7', '#B88A5A', '#8C5A3C', '#5E3B2A', '#2E2A27', '#A7B8C9', '#5D7A99', '#2F4B6B', '#7FA36B', '#4F7A44', '#C94F3D'];
        const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
        const lab = (hex) => {
          const r = lin(parseInt(hex.slice(1, 3), 16) / 255);
          const g = lin(parseInt(hex.slice(3, 5), 16) / 255);
          const b = lin(parseInt(hex.slice(5, 7), 16) / 255);
          const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
          const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
          const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
          return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
        };
        const palette = hexes.map((hex, i) => ({ code: i + 1, name: `Farbe ${i + 1}`, hex, lab: lab(hex), userNamed: true }));
        const n = cols * rows;
        const kind = new Uint8Array(n);
        const c1 = new Uint16Array(n);
        const c2 = new Uint16Array(n);
        for (let idx = 0; idx < n; idx++) {
          const row = Math.floor(idx / cols);
          const col = idx - row * cols;
          c1[idx] = (Math.floor(col / 37) + Math.floor(row / 29)) % hexes.length;
          // jede 6. Zelle als Diagonale (zwei Steine) → ≈ 1,4 Mio. Steine
          if (idx % 6 === 3) {
            kind[idx] = 1;
            c2[idx] = (c1[idx] + 5) % hexes.length;
          }
        }
        const id = `w4pe-big-${Date.now()}`;
        const rev = `w4pe-rev-${Date.now()}`;
        const shapes = { diagonal: true, line: true, subdivide: true, subdivK: 2, detailLevel: 0.5, autoDetail: true, skinProtect: true, minPieceMm: 2 };
        const adjust = { rotation: 0, fineRotate: 0, flipH: false, crop: null, brightness: 0, contrast: 0, saturation: 0, sharpen: 0, bgSimplify: 0, detailBoost: 0, autoLevels: false, whiteBalance: false };
        const settings = {
          ...lp,
          unit: 'cm',
          paletteMode: 'auto',
          colorCount: hexes.length,
          dither: 0,
          deltaE: '2000',
          materialIds: [],
          shapes,
          sectionMode: 'size',
          sectionWmm: 300,
          sectionHmm: 300,
          sectionCols: 4,
          sectionRows: 3,
          reservePct: 10,
          groutHex: '#BDB8AE',
          surface: 'glass',
          groutDepthMm: 3,
        };
        const layoutParams = { widthMm: lp.widthMm, heightMm: lp.heightMm, tileW: tile, tileH: tile, joint, edgeMode: 'whole', minCutMm: 2 };
        const computedWith = JSON.stringify({ l: layoutParams, sh: shapes, pm: 'auto', cc: hexes.length, di: 0, de: '2000', mi: [], cp: [], a: adjust, rg: [] });
        const now = Date.now();
        const rec = {
          meta: { id, name: 'Großprojekt 1,4 Mio. (Test)', createdAt: now, updatedAt: now, computed: true },
          settings,
          adjust,
          regions: [],
          palette,
          computedWith,
          mosaicRev: rev,
        };
        const mosaic = {
          v: 1,
          cols,
          rows,
          kind,
          c1,
          c2,
          subIdx: new Int32Array(0),
          subLen: new Uint8Array(0),
          subCol: new Uint16Array(0),
          lineIdx: new Int32Array(0),
          lineVal: new Float32Array(0),
          free: [],
          rec: new Uint8Array(n),
          rev,
        };
        const r = indexedDB.open('mosaicplan');
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction(['projects', 'mosaics', 'progress'], 'readwrite');
          tx.objectStore('projects').put(rec, id);
          tx.objectStore('mosaics').put(mosaic, id);
          tx.objectStore('progress').put(new Uint16Array(n), id);
          tx.oncomplete = () => {
            db.close();
            resolve({ id, pieces: n + Math.floor((n - 3 + 5) / 6) });
          };
          tx.onerror = () => reject(tx.error);
        };
        r.onerror = () => reject(r.error);
      }),
  );
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  };

  // =====================================================================  1) Porträt: Liste, Übernahme
  if (run('list')) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE' });
  const page = await context.newPage();
  watch(page);
  await page.goto(BASE);
  await page.waitForSelector('[data-testid="sample-portrait"]');
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  const id = idOf(page.url());
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="step-preview"].active', { timeout: 240000 });
  await page.waitForSelector('[data-testid="mosaic-canvas"]');
  await saved(page);
  const fresh = await dbGet(page, 'projects', id);
  const ps0 = fresh.meta.progressSummary;
  check('Nach dem Berechnen: Fortschritt für die Liste gespeichert (0 verlegt, Revision des Rasters)', ps0 && ps0.placed === 0 && ps0.total > 5000 && ps0.rev === fresh.mosaicRev, JSON.stringify(ps0));
  check('Erste Berechnung: kein Übernahme-Hinweis (nichts verlegt)', !(await page.$('[data-testid="carry-notice"]')));

  // Abschnitt A1 fertig
  await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="placed-count"]');
  await page.click('.section-cell >> nth=0');
  await page.click('[data-testid="section-done"]');
  const placed = await poll(async () => {
    const v = digits(await page.textContent('[data-testid="placed-count"]'));
    return v > 0 ? v : null;
  }, 5000);
  await saved(page);
  const st1 = await storedLaid(page, id);
  const rec1 = await dbGet(page, 'projects', id);
  check('„Abschnitt fertig“: gespeicherter Fortschritt und Listenwert stimmen mit der Anzeige überein', placed > 0 && st1.placed === placed && rec1.meta.progressSummary.placed === placed && rec1.meta.progressSummary.total === st1.total, `${placed} verlegt von ${st1.total}`);
  await shot(page, 'pe01-plan-section-done.png');

  // „Meine Projekte“
  const row = await projectRowProgress(page, id);
  const pct = Math.floor((placed * 100) / st1.total);
  check('„Meine Projekte“ zeigt „NN % verlegt“ (abgerundet, exakte Zahlen im Tooltip)', !!row && row.text === `${pct} % verlegt` && row.placed === placed && row.total === st1.total && row.title.includes(placed.toLocaleString('de-DE')), row ? `${row.text} · ${row.title}` : 'fehlt');
  const barW = await page.$eval(`[data-testid="project-row"][data-project="${id}"] .w4pe-bar-fill`, (e) => e.style.width).catch(() => '');
  check('Mini-Balken entspricht dem Anteil', Math.abs(parseFloat(barW) - (placed / st1.total) * 100) < 0.01, barW);
  await shot(page, 'pe02-projects.png');
  // Startseite: zuletzt bearbeitete Projekte
  await page.goto(BASE);
  const card = await page.waitForSelector(`[data-testid="recent-card"][data-project="${id}"] [data-testid="project-progress"]`, { timeout: 5000 }).catch(() => null);
  check('Startseite: Karte zeigt den Fortschritt', !!card && ((await card.textContent()) || '').includes(`${pct} % verlegt`));
  await page.locator('[data-testid="recent-card"]').first().scrollIntoViewIfNeeded();
  await shot(page, 'pe03-home.png');
  // Projekte ohne Wert (nicht berechnet) zeigen nichts
  await page.click('[data-testid="sample-animal"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  const animalId = idOf(page.url());
  const animalRow = await projectRowProgress(page, animalId);
  check('Nicht berechnetes Projekt: keine Prozentangabe (nichts geschätzt)', animalRow === null);

  // ---------- Neu berechnen, gleiche Einstellungen → 100 % übernommen
  await page.goto(BASE + `#/project/${id}/compute`);
  await page.waitForSelector('[data-testid="compute-btn"]');
  const loss1 = await recompute(page);
  const notice1 = await page.waitForSelector('[data-testid="carry-notice"]', { timeout: 20000 }).catch(() => null);
  const n1 = notice1 ? { status: await notice1.getAttribute('data-status'), kept: Number(await notice1.getAttribute('data-kept')), reset: Number(await notice1.getAttribute('data-reset')), text: ((await notice1.textContent()) || '').trim() } : null;
  check('Rückfrage nennt die Ausnahme für unverändert berechnete Steine', /verlegt markierte Steine/.test(loss1) && /bleiben Steine markiert/.test(loss1), loss1.slice(0, 120));
  check('Gleiche Einstellungen: alle verlegten Steine übernommen (Hinweis)', !!n1 && n1.status === 'kept' && n1.kept === placed && n1.reset === 0 && /übernommen – alle unverändert/.test(n1.text), n1 ? n1.text.slice(0, 120) : 'kein Hinweis');
  await shot(page, 'pe04-carry-all.png');
  await saved(page);
  const rec2 = await dbGet(page, 'projects', id);
  const st2 = await storedLaid(page, id);
  check('… gespeichert: neue Revision, gleiche Zahl verlegter Steine, Listenwert aktuell', rec2.mosaicRev !== rec1.mosaicRev && st2.placed === placed && st2.rev === rec2.mosaicRev && rec2.meta.progressSummary.placed === placed && rec2.meta.progressSummary.rev === rec2.mosaicRev && (await placedNow(page)) === placed);

  // ---------- Palettenfarbe geändert → genau deren Steine wieder offen, mit Positionen
  const colorIdx = Number(Object.entries(st2.byColor).sort((a, b) => b[1] - a[1])[0][0]);
  const expectReset = st2.byColor[colorIdx];
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="palette-table"]');
  const colorInput = page.locator('[data-testid="palette-table"] tbody tr').nth(colorIdx).locator('input[type="color"]');
  await colorInput.fill('#ff00ff');
  await page.waitForTimeout(400);
  await saved(page);
  await recompute(page);
  const notice2 = await page.waitForSelector('[data-testid="carry-notice"][data-reset]:not([data-reset="0"])', { timeout: 20000 }).catch(() => null);
  const n2 = notice2 ? { kept: Number(await notice2.getAttribute('data-kept')), reset: Number(await notice2.getAttribute('data-reset')), text: ((await notice2.textContent()) || '').trim() } : null;
  check('Geänderte Palettenfarbe: genau deren verlegte Steine wieder offen, alle anderen übernommen', !!n2 && n2.reset === expectReset && n2.kept === placed - expectReset && /haben sich geändert/.test(n2.text), n2 ? `${n2.kept} übernommen, ${n2.reset} offen (erwartet ${expectReset})` : 'kein Hinweis');
  await page.click('[data-testid="carry-show"]');
  const cellBtns = await page.$$('[data-testid="carry-cell"]');
  const firstId = cellBtns.length ? ((await cellBtns[0].textContent()) || '').trim() : '';
  await shot(page, 'pe05-carry-changed.png');
  check('„anzeigen“ listet die Positionen', cellBtns.length > 0 && /^[A-Z]+\d{3}$/.test(firstId), `${cellBtns.length} Knöpfe, z. B. ${firstId}`);
  if (cellBtns.length) {
    await cellBtns[0].click();
    const sid = await page.waitForSelector('[data-testid="stone-id"]', { timeout: 8000 }).catch(() => null);
    const sidText = sid ? ((await sid.textContent()) || '').trim() : '';
    check('Klick öffnet den Stein im Steindetail', sidText.startsWith(firstId), sidText.slice(0, 30));
    await shot(page, 'pe06-carry-stone.png');
    if (sid) await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  const placed2 = await placedNow(page);
  check('Verlegt nach dem Neuberechnen = übernommene Steine', placed2 === placed - expectReset, `${placed2}`);

  // ---------- andere Fuge → nicht übertragbar
  await page.click('[data-testid="step-joint"]');
  await page.click('[data-testid="joint-presets"] button:has-text("1,5 mm")');
  await page.waitForTimeout(300);
  await recompute(page);
  check('Nach dem nächsten Berechnen öffnet Schritt 8 den zuvor angezeigten Stein nicht erneut', !(await page.$('[data-testid="stone-id"]')));
  const notice3 = await page.waitForSelector('[data-testid="carry-notice"][data-status="layout"]', { timeout: 20000 }).catch(() => null);
  const n3 = notice3 ? { reset: Number(await notice3.getAttribute('data-reset')), text: ((await notice3.textContent()) || '').trim() } : null;
  check('Andere Fuge: „Raster geändert – Fortschritt nicht übertragbar“, alle wieder offen', !!n3 && n3.reset === placed2 && /Raster geändert – Fortschritt nicht übertragbar/.test(n3.text) && (await placedNow(page)) === 0, n3 ? n3.text.slice(0, 110) : 'kein Hinweis');
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'pe07-carry-layout.png');
  await saved(page);
  const row3 = await projectRowProgress(page, id);
  check('Liste nach dem Neuberechnen mit anderem Raster: 0 % verlegt', !!row3 && row3.text === '0 % verlegt' && row3.placed === 0);
  // Hinweis schließen: bleibt geschlossen (auch nach dem Neuladen)
  await page.goto(BASE + `#/project/${id}/plan`);
  await page.waitForSelector('[data-testid="carry-dismiss"]');
  await page.click('[data-testid="carry-dismiss"]');
  await saved(page);
  await page.reload();
  await page.waitForSelector('[data-testid="placed-count"]');
  await page.waitForTimeout(500);
  check('Hinweis geschlossen bleibt geschlossen (gespeichert)', !(await page.$('[data-testid="carry-notice"]')));

  // Englisch / Türkisch: Listenwert übersetzt
  const setLang = async (label) => {
    await page.goto(BASE + '#/settings');
    await page.click(`[data-testid="lang-select"] >> text=${label}`);
    await page.waitForTimeout(200);
  };
  await setLang('English');
  const rowEn = await projectRowProgress(page, id);
  await setLang('Türkçe');
  const rowTr = await projectRowProgress(page, id);
  check('Listenwert auf Englisch und Türkisch', !!rowEn && rowEn.text === '0 % laid' && !!rowTr && rowTr.text === '%0 döşendi', `${rowEn && rowEn.text} | ${rowTr && rowTr.text}`);
  await setLang('Deutsch');
  await context.close();
  }

  // =====================================================================  2) Großprojekt: Antippen ohne Statistik-Stau
  if (run('big')) {
  const big = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE' });
  await big.addInitScript(() => {
    const W = window.Worker;
    const s = (window.__w4pe = { statsSent: 0, statsDone: 0, sentAt: [], doneAt: [], longTasks: [] });
    window.Worker = class extends W {
      constructor(...a) {
        super(...a);
        this.addEventListener('message', (ev) => {
          if (ev.data && ev.data.type === 'stats') {
            s.statsDone++;
            s.doneAt.push(performance.now());
          }
        });
      }
      postMessage(m, t) {
        if (m && m.type === 'stats') {
          s.statsSent++;
          s.sentAt.push(performance.now());
        }
        return super.postMessage(m, t);
      }
    };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) s.longTasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      /* ohne Long-Task-API */
    }
  });
  const bp = await big.newPage();
  watch(bp);
  await bp.goto(BASE);
  await bp.waitForSelector('[data-testid="home-cta"]');
  const bigInfo = await createBigProject(bp);
  await bp.goto(BASE + `#/project/${bigInfo.id}/plan`);
  await bp.waitForSelector('[data-testid="placed-count"]', { timeout: 120000 });
  const statsReady = await poll(() => bp.evaluate(() => window.__w4pe.statsDone >= 1), 180000, 300);
  await bp.waitForTimeout(800);
  const bigRec0 = await dbGet(bp, 'projects', bigInfo.id);
  check(
    'Großprojekt geöffnet, erste Statistik fertig; älteres Projekt ohne Listenwert bekommt ihn beim Öffnen',
    !!statsReady && !!bigRec0.meta.progressSummary && bigRec0.meta.progressSummary.total === bigInfo.pieces && bigRec0.meta.progressSummary.placed === 0,
    `${bigInfo.pieces.toLocaleString('de-DE')} Steine`,
  );
  // hineinzoomen: echte Steine statt Übersicht
  for (let i = 0; i < 7; i++) {
    await bp.click('[data-testid="viewer-zoom-in"]');
    await bp.waitForTimeout(120);
  }
  const layBox = await bp.$('[data-testid="lay-mode"]');
  if (layBox && !(await layBox.isChecked())) await bp.locator('label.toggle:has([data-testid="lay-mode"])').click();
  await bp.waitForTimeout(600);
  const view = await bp.$eval('[data-testid="mosaic-canvas"]', (c) => {
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height, ox: parseFloat(c.dataset.ox), oy: parseFloat(c.dataset.oy), scale: parseFloat(c.dataset.scale), overview: c.dataset.overview };
  });
  const s0 = await bp.evaluate(() => ({ sent: window.__w4pe.statsSent, done: window.__w4pe.statsDone }));
  const pitch = 4; // 3,5 mm Stein + 0,5 mm Fuge
  const tapInfo = [];
  let placedBig = await placedNow(bp);
  for (let i = 0; i < 12; i++) {
    // Steinmitte nahe der Bildmitte (exakte Geometrie: Spalte·4 mm + 1,75 mm)
    const cx = (view.w / 2 - view.ox) / view.scale;
    const cy = (view.h / 2 - view.oy) / view.scale;
    const col = Math.floor(cx / pitch) + (i % 4) * 2;
    const row = Math.floor(cy / pitch) + Math.floor(i / 4) * 2;
    // jede 6. Zelle ist eine Diagonale: dort den oberen rechten Teil treffen
    const isDiag = (row * 1200 + col) % 6 === 3;
    const mx = col * pitch + (isDiag ? 2.6 : 1.75);
    const my = row * pitch + (isDiag ? 0.9 : 1.75);
    const t0 = await bp.evaluate(() => performance.now());
    await bp.mouse.click(view.left + view.ox + mx * view.scale, view.top + view.oy + my * view.scale);
    await bp.waitForTimeout(2000);
    const lt = await bp.evaluate((t0) => window.__w4pe.longTasks.filter((x) => x.start >= t0 - 5), t0);
    const now = digits(await bp.textContent('[data-testid="placed-count"]'));
    tapInfo.push({ delta: now - placedBig, maxLong: lt.reduce((m, x) => Math.max(m, x.dur), 0) });
    placedBig = now;
  }
  const s1 = await bp.evaluate(() => ({ sent: window.__w4pe.statsSent, done: window.__w4pe.statsDone }));
  const statsMsgs = s1.sent - s0.sent;
  // Messung funktioniert: das Öffnen des Großprojekts selbst erzeugt lange Aufgaben
  const loadLong = await bp.evaluate(() => window.__w4pe.longTasks.length);
  const maxLong = Math.max(...tapInfo.map((x) => x.maxLong));
  check('12 Antipp-Vorgänge setzen je genau einen Stein', tapInfo.every((x) => x.delta === 1), tapInfo.map((x) => x.delta).join(','));
  check('Höchstens 2 Statistik-Aufträge an den Worker während der 12 Antipp-Vorgänge', statsMsgs <= 2, `${statsMsgs} Aufträge`);
  check('Keine lange Aufgabe über 50 ms je Antippen (Desktop)', maxLong <= 50 && loadLong > 0, `max ${Math.round(maxLong)} ms · je Tippen: ${tapInfo.map((x) => Math.round(x.maxLong)).join('/')} · Ansicht ${view.overview === '1' ? 'Übersicht' : 'Steine'} · Messung aktiv (${loadLong} lange Aufgaben insgesamt, v. a. beim Öffnen)`);
  await shot(bp, 'pe08-big-taps.png');
  await saved(bp);
  const bigStored = await storedLaid(bp, bigInfo.id);
  const bigRec = await dbGet(bp, 'projects', bigInfo.id);
  check('Großprojekt: Zähler = Speicher (verlegt und gesamt), Listenwert nachgetragen', bigStored.placed === placedBig && bigStored.placed === 12 && bigRec.meta.progressSummary.placed === 12 && bigRec.meta.progressSummary.total === bigStored.total && bigStored.total === bigInfo.pieces, `${bigStored.placed} / ${bigStored.total}`);
  // Abschnitt fertig im Großprojekt (Bereich, ein Antippen) – weiterhin ohne Statistik-Auftrag
  await bp.click('.section-cell >> nth=1');
  const sBefore = await bp.evaluate(() => window.__w4pe.statsSent);
  const tSec = await bp.evaluate(() => performance.now());
  await bp.click('[data-testid="section-done"]');
  await bp.waitForTimeout(1500);
  const secLong = await bp.evaluate((t0) => window.__w4pe.longTasks.filter((x) => x.start >= t0 - 5).reduce((m, x) => Math.max(m, x.dur), 0), tSec);
  const sAfter = await bp.evaluate(() => window.__w4pe.statsSent);
  const placedSec = await placedNow(bp);
  check('„Abschnitt fertig“ im Großprojekt: kein Statistik-Auftrag, Zähler sofort aktuell', sAfter === sBefore && placedSec > 12, `${placedSec} verlegt · längste Aufgabe ${Math.round(secLong)} ms`);
  // Mehrere echte Änderungen kurz hintereinander (Steinfarbe, wie im Steindetail): Ein veralteter Statistik-Lauf wird
  // abgebrochen, statt sich im Worker zu stauen – das Ergebnis kommt etwa eine Laufzeit nach der letzten Änderung
  const single = await bp.evaluate(() => {
    const s = window.__w4pe;
    return s.doneAt.length && s.sentAt.length ? s.doneAt[0] - s.sentAt[0] : null;
  });
  const storm = await bp.evaluate(async () => {
    const el = document.querySelector('[data-testid="placed-count"]');
    const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
    let f = key ? el[key] : null;
    while (f && !(f.memoizedProps && f.memoizedProps.api && f.memoizedProps.api.touchMosaic)) f = f.return;
    if (!f) return null;
    const s = window.__w4pe;
    const done0 = s.statsDone;
    let lastEdit = 0;
    for (let i = 0; i < 4; i++) {
      const api = f.memoizedProps.api;
      const d = api.computed.data;
      const idx = 5000 + i * 7;
      d.c1[idx] = (d.c1[idx] + 1) % api.rec.palette.length;
      api.touchMosaic([idx]);
      lastEdit = performance.now();
      await new Promise((r) => setTimeout(r, 700));
    }
    const t0 = performance.now();
    while (s.statsDone === done0 && performance.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 100));
    return { results: s.statsDone - done0, doneEnd: s.statsDone, wait: s.doneAt[s.doneAt.length - 1] - lastEdit };
  });
  await bp.waitForTimeout(2500);
  const lateResults = storm ? (await bp.evaluate(() => window.__w4pe.statsDone)) - storm.doneEnd : -1;
  // läuft ein Durchgang kürzer als der Abstand der Änderungen, darf er zwischendurch fertig werden
  const maxResults = single !== null && single > 900 ? 1 : 4;
  check(
    'Vier Änderungen kurz hintereinander: veraltete Statistik-Läufe abgebrochen, ein Ergebnis, ohne Stau',
    !!storm && single !== null && storm.results >= 1 && storm.results <= maxResults && lateResults === 0 && storm.wait < single * 1.6 + 1500,
    storm ? `ein Lauf ≈ ${Math.round(single)} ms · Ergebnis ${Math.round(storm.wait)} ms nach der letzten Änderung · ${storm.results} Ergebnis(se), danach ${lateResults}` : 'API nicht gefunden',
  );
  await big.close();
  }

  // =====================================================================  3) Handy: Meine Projekte
  if (run('phone')) {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'de-DE' });
  const pp = await phone.newPage();
  watch(pp);
  await pp.goto(BASE);
  await pp.waitForSelector('[data-testid="sample-portrait"]');
  await pp.click('[data-testid="sample-portrait"]');
  await pp.waitForSelector('[data-testid="compute-btn"]');
  const pid = idOf(pp.url());
  await pp.click('[data-testid="compute-btn"]');
  await pp.waitForSelector('[data-testid="step-preview"].active', { timeout: 240000 });
  await pp.click('[data-testid="step-plan"]');
  await pp.waitForSelector('[data-testid="placed-count"]');
  await pp.click('.section-cell >> nth=1');
  await pp.click('[data-testid="section-done"]');
  await pp.waitForTimeout(400);
  await saved(pp);
  await pp.goto(BASE + '#/projects');
  await pp.waitForSelector(`[data-testid="project-row"][data-project="${pid}"] [data-testid="project-progress"]`);
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const pr = await pp.$eval(`[data-testid="project-row"][data-project="${pid}"] [data-testid="project-progress"]`, (e) => {
    const r = e.getBoundingClientRect();
    return { w: r.width, right: r.right, text: e.textContent };
  });
  check('Handy: Fortschritt in „Meine Projekte“ sichtbar, kein seitlicher Überlauf', overflow <= 0 && pr.right <= 390 && /% verlegt/.test(pr.text), `${pr.text} · Breite ${Math.round(pr.w)} px · Überlauf ${overflow}`);
  await shot(pp, 'pe09-phone-projects.png');
  await pp.goto(BASE);
  await pp.waitForSelector(`[data-testid="recent-card"][data-project="${pid}"]`);
  await pp.locator(`[data-testid="recent-card"][data-project="${pid}"]`).scrollIntoViewIfNeeded();
  await shot(pp, 'pe10-phone-home.png');
  await phone.close();
  }

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} Prüfungen bestanden`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
