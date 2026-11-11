/* Paket w6-plan-exports im echten Browser (Chromium/Playwright).
 * Voraussetzung: `npm run build` und `npx vite preview --port <port>` laufen.
 * Aufruf: node e2e/w6-plan-exports.e2e.cjs <baseUrl> <outDir>
 *   W6PE_ONLY=portrait | big | phone   – nur einen Teil ausführen
 *   W6PE_5M=1                          – zusätzlich Export mit ≈ 5 Mio. Steinen (dauert einige Minuten)
 *
 * Geprüft wird:
 *  1. Porträt: „Alle Koordinaten als CSV“ – Datei mit BOM, Kopfzeile, eine Zeile je Stein (= Steine der Statistik),
 *     Positionen eindeutig, Zuschnitt „ja (T#)“; Speicherergebnis (SaveResultNote) mit Zeilen und Größe;
 *     Abschnitts-CSV nur mit Zeilen dieses Abschnitts;
 *  2. Abschnitte passend zum Papier: Hinweis bei schlecht genutztem Papier (Standard 30 × 30 cm auf A4 hoch),
 *     Vorgaben „1 Blatt“ (17,8 × 24,7 cm) und „2×2 Blätter“ mit exakter Blattzahl; mit Verlegefortschritt fragt
 *     die Vorgabe nach (Abbrechen ändert nichts);
 *  3. Großprojekt ≈ 2 Mio. Steine: Fortschritt „Zeile x von y“, keine lange Aufgabe > 100 ms auf der Hauptseite
 *     während des Exports, Datei kommt vollständig an (Zeilen = Steine), Hinweis auf die Zeilengrenze von
 *     Excel/LibreOffice; Abbrechen beendet den Export ohne Datei;
 *  4. Handy (390 × 844, Touch): Schritt 9 ohne seitlichen Überlauf, Vorgaben ≥ 44 px, Bildschirmfotos.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w6-plan-exports');
fs.mkdirSync(OUT, { recursive: true });
const ONLY = process.env.W6PE_ONLY || '';
const run = (part) => !ONLY || ONLY === part;

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info !== '' ? ` – ${info}` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name, full = false) => page.screenshot({ path: path.join(OUT, name), fullPage: full }).catch(() => {});
const txt = async (page, sel) => ((await page.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const num = (s) => parseInt(String(s || '').replace(/\D/g, ''), 10);
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function poll(fn, timeoutMs, everyMs = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await wait(everyMs);
  }
}

async function newPortrait(page) {
  await page.goto(BASE);
  await page.waitForSelector('[data-testid="sample-portrait"]');
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
  await wait(800);
  await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="placed-count"]');
  await wait(800);
}

/** Zeilen einer (großen) Datei zählen, ohne sie als Text zu lesen; dazu erste Bytes und Positionen-Stichprobe */
function scanCsv(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  let lines = 0;
  let pos = 0;
  let head = null;
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, pos);
    if (n <= 0) break;
    if (!head) head = Buffer.from(buf.subarray(0, Math.min(n, 400)));
    for (let i = 0; i < n; i++) if (buf[i] === 10) lines++;
    pos += n;
  }
  fs.closeSync(fd);
  // letzte Zeile hat kein Zeilenende
  return { bytes: pos, rows: lines + (pos > 0 ? 1 : 0), head };
}

/** Synthetisches Großprojekt direkt in IndexedDB (ohne Berechnung): ganze Steine, jede `diagEvery`. Zelle diagonal */
async function createBigProject(page, cols, rows, diagEvery) {
  return page.evaluate(
    ([cols, rows, diagEvery]) =>
      new Promise((resolve, reject) => {
        const tile = 3.5;
        const joint = 0.5;
        const lp = { widthMm: cols * tile + (cols - 1) * joint, heightMm: rows * tile + (rows - 1) * joint, tileW: tile, tileH: tile, joint, edgeMode: 'whole', minCutMm: 2 };
        const hexes = ['#F2EDE4', '#D9C7A7', '#B88A5A', '#8C5A3C', '#5E3B2A', '#2E2A27', '#A7B8C9', '#5D7A99', '#2F4B6B', '#7FA36B', '#4F7A44', '#C94F3D'];
        const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
        const lab = (hex) => {
          const r = lin(parseInt(hex.slice(1, 3), 16) / 255);
          const g = lin(parseInt(hex.slice(3, 5), 16) / 255);
          const b = lin(parseInt(hex.slice(5, 7), 16) / 255);
          const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
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
        let pieces = n;
        for (let idx = 0; idx < n; idx++) {
          const row = Math.floor(idx / cols);
          const col = idx - row * cols;
          c1[idx] = (Math.floor(col / 37) + Math.floor(row / 29)) % hexes.length;
          if (idx % diagEvery === 3) {
            kind[idx] = 1;
            c2[idx] = (c1[idx] + 5) % hexes.length;
            pieces++;
          }
        }
        const id = `w6pe-big-${Date.now()}`;
        const rev = `w6pe-rev-${Date.now()}`;
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
        const rec = { meta: { id, name: `Großprojekt ${(pieces / 1e6).toFixed(1)} Mio (Test)`, createdAt: now, updatedAt: now, computed: true }, settings, adjust, regions: [], palette, computedWith, mosaicRev: rev };
        const mosaic = { v: 1, cols, rows, kind, c1, c2, subIdx: new Int32Array(0), subLen: new Uint8Array(0), subCol: new Uint16Array(0), lineIdx: new Int32Array(0), lineVal: new Float32Array(0), free: [], rec: new Uint8Array(n), rev };
        const r = indexedDB.open('mosaicplan');
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction(['projects', 'mosaics', 'progress'], 'readwrite');
          tx.objectStore('projects').put(rec, id);
          tx.objectStore('mosaics').put(mosaic, id);
          tx.objectStore('progress').put(new Uint16Array(n), id);
          tx.oncomplete = () => {
            db.close();
            resolve({ id, pieces });
          };
          tx.onerror = () => reject(tx.error);
        };
        r.onerror = () => reject(r.error);
      }),
    [cols, rows, diagEvery],
  );
}

/** Großprojekt exportieren: lange Aufgaben während des Exports, Datei, Zeilen */
async function bigExport(browser, label, cols, rows, diagEvery, { cancel = false, measureOnly = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE', acceptDownloads: true });
  await ctx.addInitScript(() => {
    const s = (window.__w6pe = { longTasks: [] });
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) s.longTasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      /* ohne Long-Task-API */
    }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(BASE);
  await page.waitForSelector('[data-testid="home-cta"]');
  const info = await createBigProject(page, cols, rows, diagEvery);
  await page.goto(BASE + `#/project/${info.id}/plan`);
  await page.waitForSelector('[data-testid="csv-all"]', { timeout: 180000 });
  // Statistik fertig (Zeilenhinweis kommt aus der Statistik)
  const before = await poll(() => page.$('[data-testid="csv-excel-before"]'), 180000, 500);
  await wait(1500);
  check(`${label}: Hinweis vor dem Export – mehr als 1.048.576 Zeilen`, !!before && /1\.048\.576/.test(await txt(page, '[data-testid="csv-excel-before"]')), await txt(page, '[data-testid="csv-excel-before"]'));

  if (cancel) {
    const dl = page.waitForEvent('download', { timeout: 8000 }).then(() => true).catch(() => false);
    await page.click('[data-testid="csv-all"]');
    const rowsPhase = await poll(() => page.$('[data-testid="csv-progress"][data-phase="rows"]'), 120000, 100);
    const ptxt = await txt(page, '[data-testid="csv-progress"]');
    await shot(page, `${label}-progress.png`);
    await page.click('[data-testid="csv-cancel"]');
    const cancelled = await poll(() => page.$('[data-testid="csv-cancelled"]'), 5000, 100);
    const got = await dl;
    check(`${label}: Fortschritt „CSV: Zeile x von y“ mit Abbrechen`, !!rowsPhase && /Zeile [\d.]+ von [\d.]+/.test(ptxt) && num(ptxt.split('von')[1]) === info.pieces, ptxt);
    check(`${label}: Abbrechen – Meldung „abgebrochen“, keine Datei, Schaltfläche wieder frei`, !!cancelled && !got && (await page.isEnabled('[data-testid="csv-all"]')), await txt(page, '[data-testid="csv-cancelled"]'));
    await ctx.close();
    return;
  }

  // Vergleich: lange Aufgaben in 6 s ohne Export (Statistik, Speichern usw. – nicht vom Export verursacht)
  const b0 = await page.evaluate(() => performance.now());
  await wait(6000);
  const idle = await page.evaluate((a) => window.__w6pe.longTasks.filter((x) => x.start >= a).map((x) => Math.round(x.dur)), b0);
  const t0 = await page.evaluate(() => performance.now());
  const dlP = page.waitForEvent('download', { timeout: 900000 });
  const started = Date.now();
  await page.click('[data-testid="csv-all"]');
  const prog = await poll(() => page.$('[data-testid="csv-progress"][data-phase="rows"]'), 120000, 100);
  const ptxt = await txt(page, '[data-testid="csv-progress"]');
  // kein Bildschirmfoto hier: es wäre selbst eine lange Aufgabe auf der Hauptseite (Foto im Abbruch-Lauf)
  check(`${label}: Fortschritt „CSV: Zeile x von y“ (y = Steine)`, !!prog && num(ptxt.split('von')[1]) === info.pieces, ptxt);
  const dl = await dlP;
  const secs = (Date.now() - started) / 1000;
  const file = path.join(OUT, `${label}.csv`);
  await dl.saveAs(file);
  const t1 = await page.evaluate(() => performance.now());
  await page.waitForSelector('[data-testid="csv-done"]', { timeout: 20000 });
  const lt = await page.evaluate(([a, b]) => window.__w6pe.longTasks.filter((x) => x.start >= a - 1 && x.start <= b), [t0, t1]);
  const maxLt = lt.reduce((m, x) => Math.max(m, x.dur), 0);
  const ltInfo = `${lt.length} lange Aufgaben, längste ${Math.round(maxLt)} ms, Export ${secs.toFixed(1)} s, ohne Export in 6 s: ${idle.length ? idle.join('/') + ' ms' : 'keine'}${lt.length ? ` [${lt.slice(0, 6).map((x) => `+${Math.round(x.start - t0)}:${Math.round(x.dur)}`).join(' ')}]` : ''}`;
  // ≈ 5 Mio.: nur Messwert (nicht Teil der Abnahme, die bei 2 Mio. misst)
  if (measureOnly) console.log(`ℹ ${label}: lange Aufgaben während des Exports (Messwert) – ${ltInfo}`);
  else check(`${label}: keine lange Aufgabe > 100 ms auf der Hauptseite während des Exports`, maxLt <= 100, ltInfo);
  const sc = scanCsv(file);
  const doneRows = Number(await page.getAttribute('[data-testid="csv-done"]', 'data-rows'));
  const doneBytes = Number(await page.getAttribute('[data-testid="csv-done"]', 'data-bytes'));
  const bom = sc.head[0] === 0xef && sc.head[1] === 0xbb && sc.head[2] === 0xbf;
  check(
    `${label}: Datei vollständig – Zeilen = Steine, Größe = angezeigte Größe, BOM + Kopfzeile`,
    sc.rows - 1 === info.pieces && doneRows === info.pieces && sc.bytes === doneBytes && bom && sc.head.subarray(3, 12).toString() === 'Position;',
    `${sc.rows - 1} Zeilen, ${info.pieces} Steine, ${(sc.bytes / 1048576).toFixed(1)} MB`,
  );
  const lim = await txt(page, '[data-testid="csv-excel-limit"]');
  check(`${label}: nach dem Export Hinweis auf die Zeilengrenze von Excel/LibreOffice`, /1\.048\.576/.test(lim) && /Excel/.test(lim), lim.slice(0, 90));
  const note = await txt(page, '[data-testid="csv-save-note"]');
  check(`${label}: Speicherergebnis angezeigt`, /Download gestartet/.test(note) && /_koordinaten\.csv/.test(note), note);
  await shot(page, `${label}-done.png`);
  check(`${label}: keine Konsolen- oder Seitenfehler`, errors.length === 0, errors.slice(0, 3).join(' | '));
  try {
    fs.unlinkSync(file);
  } catch {
    /* Datei war nur zum Zählen da */
  }
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    // ===================================================================== 1) + 2) Porträt
    if (run('portrait')) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE', acceptDownloads: true });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
      await newPortrait(page);

      // ---- Hinweis: Papier schlecht genutzt (Standard 30 × 30 cm, A4 hoch 1:1)
      const hint = await txt(page, '[data-testid="sec-fit-hint"]');
      check('Hinweis „Abschnitte passen schlecht zum Papier“ mit exakten Blattzahlen', /passen schlecht zum Papier: \d+ Verlegeblätter, im Mittel nur \d+ %/.test(hint) && /„1 Blatt“ wären es \d+ Blätter/.test(hint), hint);
      await shot(page, 'p1-step9-desktop.png');

      // ---- Alle Koordinaten als CSV
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('[data-testid="csv-all"]')]);
      const file = path.join(OUT, 'portrait.csv');
      await dl.saveAs(file);
      await page.waitForSelector('[data-testid="csv-done"]');
      const raw = fs.readFileSync(file);
      const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
      const lines = raw.toString('utf8').replace(/^﻿/, '').split('\r\n');
      const rows = lines.slice(1);
      const pos = new Set(rows.map((l) => l.split(';')[0]));
      const cut = rows.filter((l) => /;ja \(T\d+\);/.test(l)).length;
      const cutPlain = rows.filter((l) => l.split(';')[14] === 'ja').length;
      const doneRows = Number(await page.getAttribute('[data-testid="csv-done"]', 'data-rows'));
      // Steine laut Fortschrittsanzeige: verlegt + offen
      const total = num(await txt(page, '[data-testid="placed-count"]')) + num(await txt(page, '[data-testid="open-count"]'));
      check('CSV: BOM, Kopfzeile, Zeilen = Steine, Positionen eindeutig', bom && lines[0].startsWith('Position;Abschnitt;') && rows.length === total && doneRows === total && pos.size === rows.length, `${rows.length} Zeilen, ${total} Steine`);
      check('CSV: Zuschnitt mit Vorlagennummer „ja (T#)“ wie im PDF', cut > 0 && cutPlain === 0, `${cut} Zuschnitte mit T#`);
      const note = await txt(page, '[data-testid="csv-save-note"]');
      const done = await txt(page, '[data-testid="csv-done"]');
      check('CSV: Speicherergebnis (SaveResultNote) + Zeilen und Größe', /Download gestartet/.test(note) && /_koordinaten\.csv/.test(note) && /[\d.]+ Zeilen · [\d,]+ (kB|MB)/.test(done), done.slice(0, 120));
      check('kein Zeilengrenzen-Hinweis bei kleinem Projekt', !(await page.$('[data-testid="csv-excel-before"]')) && !(await page.$('[data-testid="csv-excel-limit"]')));
      await shot(page, 'p2-csv-done.png');

      // ---- Abschnitts-CSV
      const secId = await page.getAttribute('[data-testid="section-cell"] >> nth=1', 'data-section');
      await page.click(`[data-testid="section-cell"][data-section="${secId}"]`);
      await page.waitForSelector('[data-testid="section-csv"]');
      const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('[data-testid="section-csv"]')]);
      const f2 = path.join(OUT, 'section.csv');
      await dl2.saveAs(f2);
      const rows2 = fs.readFileSync(f2, 'utf8').replace(/^﻿/, '').split('\r\n').slice(1);
      const inAll = rows.filter((l) => l.split(';')[1] === secId);
      check('Abschnitts-CSV: nur Zeilen dieses Abschnitts, identisch zur Gesamtliste', dl2.suggestedFilename().includes(`_${secId}_`) && rows2.length > 0 && rows2.every((l) => l.split(';')[1] === secId) && rows2.join('\n') === inAll.join('\n'), `${secId}: ${rows2.length} Zeilen`);
      await page.click('[data-testid="section-clear"]');

      // ---- Vorgaben „1 Blatt“ / „2×2 Blätter“ (Korrekturen Welle 6: „2×2“ aus dem Raster – nie mehr als 2 × 2 Blätter
      // je Abschnitt; nur angeboten, wenn besser als „1 Blatt“; beste Vorgabe „empfohlen“; aktuelle nicht anwendbar)
      await page.click('.w4lw-secset > summary');
      await page.waitForSelector('[data-testid="sec-presets"]');
      const one = await txt(page, '[data-testid="sec-preset-one"]');
      const twoEl = await page.$('[data-testid="sec-preset-two"]');
      const two = twoEl ? await txt(page, '[data-testid="sec-preset-two"]') : '';
      const twoW = twoEl ? Number(await twoEl.getAttribute('data-w')) : 0;
      const twoH = twoEl ? Number(await twoEl.getAttribute('data-h')) : 0;
      check(
        'Vorgaben aus der bedruckbaren Fläche (A4 hoch, 1:1): „1 Blatt“ 17,8 × 24,7 cm empfohlen; „2×2“ höchstens 35,6 × 49,4 cm oder (nicht besser) ausgeblendet',
        /1 Blatt · empfohlen/.test(one) && /17,8 × 24,7 cm · \d+ Abschnitte · \d+ Blätter/.test(one) && (!twoEl || (twoW <= 356 && twoH <= 494 && /cm · \d+ Abschnitte · \d+ Blätter/.test(two))),
        `${one} | ${two || '„2×2“ nicht angeboten'}`,
      );
      const sheetsOne = Number(await page.getAttribute('[data-testid="sec-preset-one"]', 'data-sheets'));
      await shot(page, 'p3a-presets-before.png');

      // Fortschritt anlegen, dann Rückfrage
      await page.click('[data-testid="section-cell"] >> nth=0');
      await page.click('[data-testid="section-done"]');
      await wait(600);
      const dlgText = { v: '' };
      page.once('dialog', (d) => {
        dlgText.v = d.message();
        d.dismiss();
      });
      await page.click('[data-testid="sec-preset-one"]');
      await wait(600);
      const notYet = await page.getAttribute('[data-testid="sec-preset-one"]', 'aria-pressed');
      check('mit Verlegefortschritt: Rückfrage nennt Abschnitts-IDs; Abbrechen ändert nichts', /Abschnitts-IDs/.test(dlgText.v) && /verlegte Steine/.test(dlgText.v) && notYet === 'false', dlgText.v.slice(0, 100));
      page.once('dialog', (d) => d.accept());
      await page.click('[data-testid="sec-preset-one"]');
      await wait(600);
      const pressed = await page.getAttribute('[data-testid="sec-preset-one"]', 'aria-pressed');
      const disabled = await page.isDisabled('[data-testid="sec-preset-one"]');
      const secCount = await page.$$eval('[data-testid="section-cell"]', (els) => els.length);
      const noHint = !(await page.$('[data-testid="sec-fit-hint"]'));
      const oneNow = await txt(page, '[data-testid="sec-preset-one"]');
      check(
        'Rückfrage bestätigt: „1 Blatt“ übernommen – „aktuell“, nicht noch einmal anwendbar, je Abschnitt ein Blatt, Hinweis weg',
        pressed === 'true' && disabled && /aktuell/.test(oneNow) && secCount === sheetsOne && noHint,
        `${secCount} Abschnitte = ${sheetsOne} Blätter`,
      );
      await shot(page, 'p3-presets.png');
      check('Desktop: kein seitlicher Überlauf in Schritt 9', (await overflow(page)) <= 0);
      check('Porträt: keine Konsolen- oder Seitenfehler', errors.length === 0, errors.slice(0, 3).join(' | '));
      await ctx.close();
    }

    // ===================================================================== 3) Großprojekt ≈ 2 Mio. Steine
    if (run('big')) {
      await bigExport(browser, 'big2m', 1500, 1200, 9);
      await bigExport(browser, 'big2m-cancel', 1500, 1200, 9, { cancel: true });
    }
    if (process.env.W6PE_5M && (!ONLY || ONLY === 'big5m')) await bigExport(browser, 'big5m', 2500, 1820, 10, { measureOnly: true });

    // ===================================================================== 4) Handy
    if (run('phone')) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'de-DE', acceptDownloads: true });
      const page = await ctx.newPage();
      await newPortrait(page);
      check('Handy: Schritt 9 ohne seitlichen Überlauf', (await overflow(page)) <= 0, String(await overflow(page)));
      await page.locator('[data-testid="sec-fit-hint"]').scrollIntoViewIfNeeded();
      await shot(page, 'm1-step9-phone-hint.png');
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.tap('[data-testid="csv-all"]')]);
      await dl.path();
      await page.waitForSelector('[data-testid="csv-done"]');
      await page.locator('[data-testid="csv-done"]').scrollIntoViewIfNeeded();
      await shot(page, 'm2-phone-csv-done.png');
      await page.tap('.w4lw-secset > summary');
      await page.locator('[data-testid="sec-presets"]').scrollIntoViewIfNeeded();
      const hs = await page.$$eval('[data-testid^="sec-preset-"]', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      check('Handy: Vorgaben-Knöpfe ≥ 44 px', hs.length >= 1 && hs.every((h) => h >= 44), hs.join(', '));
      check('Handy: kein Überlauf mit geöffneten Abschnittseinstellungen', (await overflow(page)) <= 0);
      await shot(page, 'm3-phone-presets.png');
      // ohne Verlegefortschritt: Vorgabe ohne Rückfrage übernommen
      let dialogs = 0;
      page.on('dialog', (d) => {
        dialogs++;
        d.dismiss();
      });
      await page.tap('[data-testid="sec-preset-one"]');
      await wait(600);
      check(
        'Handy: „1 Blatt“ ohne Fortschritt ohne Rückfrage übernommen, Hinweis weg',
        dialogs === 0 && (await page.getAttribute('[data-testid="sec-preset-one"]', 'aria-pressed')) === 'true' && !(await page.$('[data-testid="sec-fit-hint"]')),
      );
      check('Handy: kein Überlauf nach der Vorgabe', (await overflow(page)) <= 0);
      await page.locator('[data-testid="sec-presets"]').scrollIntoViewIfNeeded();
      await shot(page, 'm4-phone-preset-applied.png');
      await ctx.close();
    }
  } catch (e) {
    check('Ablauf ohne Ausnahme', false, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})();
