/* Browser-Test Paket w5-target-colours (Chromium/Playwright): Fotofarbe je Stein in der echten App.
 *
 * Das Paket hat (noch) keine eigene Anzeige – die Abweichungskarte kommt mit Welle 6. Geprüft wird deshalb, was die App
 * wirklich speichert (IndexedDB, Projektdatei), und darauf wird mit dem Rechenkern der Abweichung gerechnet
 * (src/core/deviation.ts, als Prüfstand in die Seite geladen):
 *  - Berechnung (Worker → Seite → IndexedDB) speichert die Fotofarbe jedes Steins; die Abweichung aus dem gespeicherten
 *    Raster ist exakt die der Berechnung (mean/max/p95, je Farbe) und passt zur Anzeige in Schritt 7.
 *  - Stein im Steindetail umfärben: seine Abweichung ist genau die vorher errechnete; zur nächsten Farbe sinkt sie auf
 *    das Minimum; die Fotofarben selbst bleiben Byte für Byte gleich.
 *  - Form ändern: keine Fotoreferenz, Strg+Z stellt sie wieder her. Freiform: keine Fotoreferenz.
 *  - Neuladen, Projektdatei (Export → Import) und Duplizieren erhalten die Fotofarben Byte für Byte.
 *  - Projekt ohne Fotofarben (vor dieser Version berechnet): öffnet und lässt sich bearbeiten, nichts wird erfunden;
 *    eine neue Berechnung ergänzt sie.
 *  - GROSS=1: zusätzlich ein Raster mit rund 2 Mio. Positionen – Größe in IndexedDB und Dauer des Speicherns.
 * Aufruf: node e2e/w5-target-colours.e2e.cjs <baseUrl> <outDir>
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w5-target-colours');
const BIG = process.env.GROSS === '1';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info !== '' ? ` – ${info}` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const projectId = (page) => (page.url().match(/#\/project\/([^/]+)/) || [])[1];
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });
const TARGET_FIELDS = ['tKind', 'tLab1', 'tLab2', 'tLine', 'tSubLen', 'tSubLab'];
const fmt = (v, d = 2) => (typeof v === 'number' ? v.toFixed(d) : String(v));

// ------------------------------------------------------------------ Prüfstand (Rechenkern) bündeln
async function bundleHarness() {
  const esbuild = require('esbuild');
  const res = await esbuild.build({
    entryPoints: [path.join(__dirname, 'w5-target-colours.harness.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    logLevel: 'silent',
  });
  return res.outputFiles[0].text;
}

/** In der Seite: liest Projekt, Raster und Fortschritt aus IndexedDB und rechnet die Abweichung auf dem gespeicherten Stand. */
function installReport() {
  const K = window.__w5tc;
  const FIELDS = ['tKind', 'tLab1', 'tLab2', 'tLine', 'tSubLen', 'tSubLab'];
  const read = (pid) =>
    new Promise((res, rej) => {
      const r = indexedDB.open('mosaicplan');
      r.onerror = () => rej(r.error);
      r.onsuccess = () => {
        const tx = r.result.transaction(['projects', 'mosaics', 'progress']);
        const out = {};
        tx.objectStore('projects').get(pid).onsuccess = (e) => (out.rec = e.target.result);
        tx.objectStore('mosaics').get(pid).onsuccess = (e) => (out.m = e.target.result);
        tx.objectStore('progress').get(pid).onsuccess = (e) => (out.p = e.target.result);
        tx.oncomplete = () => {
          r.result.close();
          res(out);
        };
        tx.onerror = () => rej(tx.error);
      };
    });
  const fnv = (parts) => {
    let h = 2166136261;
    let n = 0;
    for (const a of parts) {
      const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
      h = Math.imul(h ^ (u.length & 255), 16777619);
      n += u.length;
    }
    return `${n}:${h >>> 0}`;
  };
  const code = (p) => String(p ? p.code : '?').padStart(2, '0');

  window.__w5tcReport = async (pid, opts = {}) => {
    const { rec, m, p } = await read(pid);
    if (!rec || !m) return { found: false };
    const cells = m.cols * m.rows;
    const key = rec.computedWith ? JSON.parse(rec.computedWith) : null;
    const formula = key && key.de === '76' ? '76' : '2000';
    const layout = K.computeLayout(key.l);
    const data = K.unpackMosaic({ ...m, progress: p && p.length === cells ? p : new Uint16Array(cells) });
    const palette = rec.palette;
    const fields = {};
    let targetBytes = 0;
    for (const f of FIELDS) {
      const v = m[f];
      fields[f] = v === undefined ? null : { u8: v instanceof Uint8Array, len: v.length };
      if (v && v.byteLength) targetBytes += v.byteLength;
    }
    let mosaicBytes = 0;
    for (const v of Object.values(m)) if (ArrayBuffer.isView(v)) mosaicBytes += v.byteLength;
    const has = K.hasPhotoTargets(data);
    const sum = K.deviationSummary(data, palette, formula);
    const byColor = K.deviationByColor(data, palette, formula);
    const out = {
      found: true,
      name: rec.meta.name,
      cols: m.cols,
      rows: m.rows,
      cells,
      fields,
      targetBytes,
      mosaicBytes,
      progressBytes: p ? p.byteLength : 0,
      has,
      hash: FIELDS.every((f) => m[f] instanceof Uint8Array) ? fnv(FIELDS.map((f) => m[f])) : null,
      formula,
      dither: key ? key.di : null,
      diag: rec.diagnostics ? { mean: rec.diagnostics.meanDeltaE, max: rec.diagnostics.maxDeltaE, p95: rec.diagnostics.p95DeltaE, split: rec.diagnostics.splitCells, sub: rec.diagnostics.subCells } : null,
      sum,
      byColorEq: JSON.stringify(byColor) === JSON.stringify(palette.map((q) => q.matchDeltaE)),
      byColorPieces: byColor.map((c) => c.pieces),
      top: K.topDeviations(layout, data, palette, formula, 5).map((t) => ({ id: t.id, d: t.deltaE, code: code(palette[t.color]) })),
      codes: palette.map(code),
    };
    if (opts.map) out.map = Array.from(K.deviationMap(layout, data, palette, formula), (v) => (Number.isNaN(v) ? null : v));
    const stoneInfo = (id) => {
      const pos = K.parseCellId(layout, id);
      if (!pos) return null;
      const idx = pos.row * m.cols + pos.col;
      const q = pos.piece;
      const n = K.cellPieceCount(data, idx);
      const kind = data.kind[idx];
      // aktuelle Farbe des Teilstücks (wie die App: ganzer Stein c1; Zweiteiler c1/c2; k×k sub[q]; Freiform free[q])
      const color = kind === 4 ? data.sub.get(idx)[q] : kind === 5 ? (data.free.get(idx)[q] || {}).color : q === 0 ? data.c1[idx] : data.c2[idx];
      const target = K.pieceTarget(data, idx, q);
      const pieces = Array.from({ length: n }, (_, k) => K.deviationForPiece(data, palette, idx, k, formula));
      return {
        id,
        idx,
        piece: q,
        kind,
        state: K.targetState(data, idx),
        pieces,
        d: pieces[q] === undefined ? null : pieces[q],
        cell: K.deviationForCell(data, palette, idx, formula),
        code: code(palette[color]),
        target,
        // ΔE der Fotofarbe zu jeder Palettenfarbe – Vorhersage für jede mögliche Umfärbung
        perColor: target ? palette.map((c) => K.deltaE(formula, target, c.lab)) : null,
        nearest: K.nearestColorForPiece(data, palette, idx, q, formula),
      };
    };
    if (opts.stone) out.stone = stoneInfo(opts.stone);
    if (opts.pick) {
      // ein ganzer Stein abseits des Rands, für den es eine besser passende Farbe gibt (Farbmischung) – sonst der
      // ganze Stein mit der größten Abweichung
      let best = null;
      let fallback = null;
      for (let row = 4; row < m.rows - 4 && !best; row++)
        for (let col = 4; col < m.cols - 4; col++) {
          const idx = row * m.cols + col;
          if (data.kind[idx] !== 0 || K.targetState(data, idx) !== 'ok') continue;
          const nc = K.nearestColorForPiece(data, palette, idx, 0, formula);
          if (!nc) continue;
          if (nc.better && nc.current - nc.deltaE > 0.5) {
            best = K.pieceId(layout, row, col, 0, 1);
            break;
          }
          if (!fallback || nc.current > fallback.d) fallback = { id: K.pieceId(layout, row, col, 0, 1), d: nc.current };
        }
      out.pick = stoneInfo(best || fallback.id);
      out.pickBetter = !!best;
    }
    return out;
  };

  /** Entfernt die Fotofarben aus dem gespeicherten Raster (Stand eines vor dieser Version berechneten Projekts). */
  window.__w5tcStrip = (pid) =>
    new Promise((res, rej) => {
      const r = indexedDB.open('mosaicplan');
      r.onerror = () => rej(r.error);
      r.onsuccess = () => {
        const tx = r.result.transaction(['mosaics'], 'readwrite');
        const st = tx.objectStore('mosaics');
        let removed = 0;
        st.get(pid).onsuccess = (e) => {
          const m = e.target.result;
          for (const f of FIELDS)
            if (f in m) {
              delete m[f];
              removed++;
            }
          st.put(m, pid);
        };
        tx.oncomplete = () => {
          r.result.close();
          res(removed);
        };
        tx.onerror = () => rej(tx.error);
      };
    });
}

let HARNESS = '';
async function report(page, pid, opts = {}) {
  if (!(await page.evaluate(() => !!window.__w5tcReport))) {
    await page.addScriptTag({ content: HARNESS });
    await page.evaluate(installReport);
  }
  return page.evaluate(([pid, opts]) => window.__w5tcReport(pid, opts), [pid, opts]);
}

/** Wartet, bis alles gespeichert ist (Anzeige „gespeichert“ und danach kurz Ruhe für die IndexedDB-Transaktion). */
async function saved(page) {
  await wait(450); // Entprellzeit des Speicherns (Raster 300 ms)
  await page.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 30000 });
  await wait(250);
}
async function findStone(page, id) {
  if (await page.$('[data-testid="stone-panel"]')) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="find-stone"]');
  }
  await page.fill('[data-testid="find-stone"]', id);
  await page.press('[data-testid="find-stone"]', 'Enter');
  await page.waitForSelector('[data-testid="stone-id"]');
  await wait(250);
}
const activeCode = (page) => page.$eval('[data-testid="color-pick"] button.active small', (e) => e.textContent.trim()).catch(() => null);
async function clickCode(page, code) {
  let b = await page.$(`[data-testid="color-pick"] button[data-code="${code}"]`);
  if (!b) {
    await page.click('[data-testid="colors-all"]');
    b = await page.$(`[data-testid="color-pick"] button[data-code="${code}"]`);
  }
  if (!b) return false;
  await b.click();
  await wait(200);
  return true;
}
/** Berechnen (ggf. Rückfrage „ohne Sicherung“ bestätigen) und auf die Vorschau warten. Liefert, ob die Live-Vorschau übernommen wurde. */
async function compute(page, timeout = 180000) {
  await page.waitForSelector('[data-testid="compute-btn"]');
  // data-mode="commit": die fertige Live-Vorschau wird übernommen (keine zweite Berechnung), sonst rechnet der Worker neu
  const reuse = (await page.getAttribute('[data-testid="compute-btn"]', 'data-mode')) === 'commit';
  await page.click('[data-testid="compute-btn"]');
  const guard = await page
    .waitForSelector('[data-testid="recompute-guard"]', { timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  if (guard) await page.click('[data-testid="guard-nobackup"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout });
  await wait(800);
  return reuse;
}
const sameSum = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    HARNESS = await bundleHarness();
    check('Prüfstand (Rechenkern der Abweichung) mit esbuild gebündelt', HARNESS.length > 1000, `${Math.round(HARNESS.length / 1024)} KB`);

    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE', acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('dialog', (d) => d.accept());

    // ===================================================================== A. Berechnung speichert die Fotofarben
    await page.goto(BASE);
    await page.click('[data-testid="sample-portrait"]');
    // Live-Vorschau abwarten: „Berechnen“ übernimmt sie dann ohne zweite Berechnung (derselbe Speicherweg)
    await page.waitForSelector('[data-testid="live-preview"][data-state="ready"][data-current="1"]', { timeout: 90000 }).catch(() => {});
    const reuse1 = await compute(page);
    await saved(page);
    const pid = projectId(page);
    const r0 = await report(page, pid, { map: true, pick: true });
    const f = r0.fields;
    const pieces0 = r0.sum.pieces;
    check(
      'Berechnung speichert die Fotofarbe jedes Steins im Raster (IndexedDB: tKind, tLab1, tLab2, tLine, tSubLen, tSubLab als Uint8Array)',
      r0.found && TARGET_FIELDS.every((k) => f[k] && f[k].u8) && f.tKind.len === r0.cells && f.tLab1.len === r0.cells * 3 && f.tLab2.len === r0.diag.split * 3 && f.tLine.len === r0.diag.split * 12 && f.tSubLen.len === r0.diag.sub && r0.has,
      `${r0.cells} Zellen, ${r0.diag.split} Zweiteiler, ${r0.diag.sub} k×k · ${r0.targetBytes} Byte = ${fmt(r0.targetBytes / r0.cells)} Byte/Zelle (Raster gesamt ${r0.mosaicBytes} Byte) · ${reuse1 ? 'Live-Vorschau übernommen' : 'neu berechnet'}`,
    );
    check(
      'Abweichung aus dem gespeicherten Raster = Kennzahlen der Berechnung (mittleres, größtes und 95-%-ΔE exakt)',
      r0.sum.mean === r0.diag.mean && r0.sum.max === r0.diag.max && r0.sum.p95 === r0.diag.p95,
      `ΔE mittel ${r0.sum.mean} / ${r0.diag.mean}, max ${r0.sum.max} / ${r0.diag.max}, p95 ${r0.sum.p95} / ${r0.diag.p95} (Formel ${r0.formula}, Farbmischung ${r0.dither})`,
    );
    check('Abweichung je Farbe = Werte der Berechnung in der Palette (Stückzahl, Mittel, Maximum, über 5, über 10)', r0.byColorEq, `${r0.codes.length} Farben`);
    check(
      'Jeder Stein hat eine Fotoreferenz (gemessen = alle Steine, nichts fehlt)',
      r0.sum.measured === pieces0 && pieces0 >= r0.cells && Object.values(r0.sum.missing).every((v) => v === 0) && r0.map.every((v) => v !== null),
      `${r0.sum.measured} von ${pieces0} Steinen · Klassen <2/2–5/5–10/>10: ${r0.sum.bins.join(' / ')}`,
    );
    // Anzeige in Schritt 7 (aus der Berechnung) passt zur Abweichung aus den gespeicherten Fotofarben
    await page.click('[data-testid="step-compute"]');
    await page.waitForSelector('[data-testid="mean-de"]');
    const uiMean = parseFloat((await page.textContent('[data-testid="mean-de"]')).replace(',', '.'));
    const uiP95 = parseFloat((await page.textContent('[data-testid="p95-de"]')).replace(/[^\d,.]/g, '').replace(',', '.'));
    check('Schritt 7 zeigt dieselben Werte (ΔE im Mittel, 95 % der Steine)', Math.abs(uiMean - r0.sum.mean) <= 0.005 + 1e-9 && uiP95 === r0.sum.p95, `Anzeige ${uiMean} / ≤ ${uiP95}`);
    await shot(page, 'w5tc-01-schritt7.png');
    await page.click('[data-testid="step-preview"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]');

    // ===================================================================== B. Stein umfärben
    const st = r0.pick;
    const cur = st.perColor.findIndex((_, i) => r0.codes[i] === st.code);
    let far = 0;
    st.perColor.forEach((d, i) => {
      if (d > st.perColor[far]) far = i;
    });
    const near = st.nearest.index;
    check(
      'Teststein gewählt: ganzer Stein mit Fotoreferenz; Abweichung = ΔE(Fotofarbe, aktuelle Farbe)',
      st.state === 'ok' && st.pieces.length === 1 && st.pieces[0] === st.perColor[cur] && st.cell === st.pieces[0] && st.nearest.deltaE === Math.min(...st.perColor),
      `${st.id}: Farbe ${st.code}, ΔE ${fmt(st.pieces[0])}; nächste Farbe ${r0.codes[near]} (ΔE ${fmt(st.nearest.deltaE)})${r0.pickBetter ? ' – passt besser (Farbmischung)' : ''}; fernste ${r0.codes[far]} (ΔE ${fmt(st.perColor[far])})`,
    );
    await findStone(page, st.id);
    const uiCode0 = await activeCode(page);
    await clickCode(page, r0.codes[far]);
    await saved(page);
    const r1 = await report(page, pid, { map: true, stone: st.id });
    const changed1 = r1.map.reduce((n, v, i) => n + (v !== r0.map[i] ? 1 : 0), 0);
    check(
      `Stein ${st.id} im Steindetail umgefärbt (${uiCode0} → ${r0.codes[far]}): seine Abweichung ist genau die vorhergesagte, alle anderen Steine unverändert`,
      uiCode0 === st.code && r1.stone.code === r0.codes[far] && r1.stone.pieces[0] === st.perColor[far] && changed1 === 1 && r1.map[st.idx] === Math.fround(st.perColor[far]) && r1.sum.measured === r0.sum.measured,
      `ΔE ${fmt(st.pieces[0])} → ${fmt(r1.stone.pieces[0])}; geänderte Zellen der Karte: ${changed1}; ΔE im Mittel ${fmt(r0.sum.mean, 4)} → ${fmt(r1.sum.mean, 4)}`,
    );
    check(
      'Mittelwert folgt der Änderung (+ Differenz ÷ Steine), größte Abweichungen führen den Stein',
      Math.abs(r1.sum.mean - (r0.sum.mean + (st.perColor[far] - st.pieces[0]) / r0.sum.measured)) < 1e-9 && r1.top.some((t) => t.id === st.id) && r1.top[0].d === r1.sum.max,
      `größte: ${r1.top.map((t) => `${t.id} ${fmt(t.d, 1)}`).join(', ')}`,
    );
    check('Die Fotofarben selbst bleiben beim Bearbeiten Byte für Byte gleich', r1.hash === r0.hash && r1.hash !== null, r1.hash);
    await shot(page, 'w5tc-02-umgefaerbt.png');

    await clickCode(page, r0.codes[near]);
    await saved(page);
    const r2 = await report(page, pid, { map: true, stone: st.id });
    check(
      `Zur nächstliegenden Farbe umgefärbt (${r0.codes[near]}): Abweichung sinkt auf das Minimum über die Palette`,
      r2.stone.pieces[0] === st.nearest.deltaE && r2.stone.pieces[0] < r1.stone.pieces[0] && r2.stone.pieces[0] <= st.pieces[0] && r2.stone.nearest.better === false && r2.hash === r0.hash,
      `ΔE ${fmt(r1.stone.pieces[0])} → ${fmt(r2.stone.pieces[0])} (vor der Bearbeitung ${fmt(st.pieces[0])})`,
    );

    // ===================================================================== C. Form ändern → keine Fotoreferenz, Strg+Z
    await page.click('[data-testid="kind-diagA"]');
    await saved(page);
    const r3 = await report(page, pid, { map: true, stone: st.id });
    check(
      'Form geändert (ganzer Stein → Dreiecke): keine Fotoreferenz für diese Zelle – kein geschätzter Wert',
      r3.stone.state === 'shape' && r3.stone.pieces.length === 2 && r3.stone.pieces.every((d) => d === null) && r3.map[st.idx] === null && r3.sum.missing.shape === 2 && r3.sum.measured === r2.sum.measured - 1 && r3.sum.pieces === r2.sum.pieces + 1 && r3.hash === r0.hash,
      `Zustand ${r3.stone.state}; ohne Fotoreferenz: ${JSON.stringify(r3.sum.missing)}`,
    );
    await page.keyboard.press('Control+z');
    await saved(page);
    const r4 = await report(page, pid, { stone: st.id });
    check('Strg+Z (Form zurück): die Fotoreferenz gilt wieder, Abweichung wie vorher', r4.stone.state === 'ok' && r4.stone.pieces[0] === r2.stone.pieces[0] && sameSum(r4.sum, r2.sum), `ΔE ${fmt(r4.stone.pieces[0])}`);

    // ===================================================================== D. Freiform → keine Fotoreferenz
    await page.click('[data-testid="kind-free"]');
    await page.waitForSelector('[data-testid="free-svg"]');
    await page.click('[data-testid="free-preset-rhombus"]');
    await page.waitForSelector('[data-testid="free-save"]:not([disabled])');
    await page.click('[data-testid="free-save"]');
    await saved(page);
    const r5 = await report(page, pid, { map: true, stone: st.id });
    check(
      'Freiformstein: keine Fotoreferenz (Grund „Freiform“), übrige Steine unverändert',
      r5.stone.state === 'free' && r5.stone.pieces.every((d) => d === null) && r5.map[st.idx] === null && r5.sum.missing.free === r5.stone.pieces.length && r5.sum.missing.shape === 0 && r5.sum.measured === r2.sum.measured - 1 && r5.hash === r0.hash,
      `${r5.stone.pieces.length} Freiformteil(e); ohne Fotoreferenz: ${JSON.stringify(r5.sum.missing)}`,
    );
    await shot(page, 'w5tc-03-freiform.png');
    await page.keyboard.press('Escape');

    // ===================================================================== E. Neuladen
    await page.reload();
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 60000 });
    await wait(800);
    const r6 = await report(page, pid, { stone: st.id });
    check('Nach dem Neuladen: Fotofarben Byte für Byte erhalten, Abweichung identisch', r6.hash === r0.hash && sameSum(r6.sum, r5.sum) && r6.stone.state === 'free' && r6.has, `ΔE im Mittel ${fmt(r6.sum.mean, 4)}, gemessen ${r6.sum.measured}`);
    // weiter bearbeiten nach dem Neuladen: der Stein mit der größten Abweichung (im Porträt ein Teilstein einer k×k-Zelle)
    const st2 = r6.top.find((t) => !t.id.startsWith(st.id)) || r6.top[0];
    await findStone(page, st2.id);
    const before2 = await report(page, pid, { stone: st2.id });
    const farIdx2 = before2.stone.perColor.indexOf(Math.max(...before2.stone.perColor));
    const others2 = before2.stone.pieces.filter((_, k) => k !== before2.stone.piece);
    const ui2 = await activeCode(page);
    await clickCode(page, r0.codes[farIdx2]);
    await saved(page);
    const r7 = await report(page, pid, { stone: st2.id });
    check(
      `Nach dem Neuladen weiterbearbeitet (${st2.id}: ${ui2} → ${r0.codes[farIdx2]}): Abweichung dieses Teilstücks neu gerechnet, die übrigen Teile der Zelle und die Fotofarben unverändert`,
      before2.stone.d === st2.d &&
        ui2 === before2.stone.code &&
        r7.stone.code === r0.codes[farIdx2] &&
        r7.stone.d === before2.stone.perColor[farIdx2] &&
        JSON.stringify(r7.stone.pieces.filter((_, k) => k !== r7.stone.piece)) === JSON.stringify(others2) &&
        r7.stone.cell === Math.max(...r7.stone.pieces) &&
        r7.hash === r0.hash,
      `Teil ${before2.stone.piece + 1} von ${before2.stone.pieces.length} (Zellart ${before2.stone.kind}): ΔE ${fmt(before2.stone.d)} → ${fmt(r7.stone.d)}`,
    );
    await page.keyboard.press('Control+z');
    await saved(page);
    const r8 = await report(page, pid, { map: true });
    check('Rückgängig: wieder der Stand von vor der Änderung', sameSum(r8.sum, r6.sum));
    await page.keyboard.press('Escape');

    // ===================================================================== F. Projektdatei: Export → Import
    await page.goto(`${BASE}#/projects`);
    await page.waitForSelector('[data-testid="project-export"]');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click(`[data-project="${pid}"] [data-testid="project-export"]`)]);
    const file = path.join(OUT, 'w5tc-export.mosaicplan.json');
    await dl.saveAs(file);
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const b64len = (k) => (payload.mosaic[k] && typeof payload.mosaic[k].$b64 === 'string' ? Buffer.from(payload.mosaic[k].$b64, 'base64').length : -1);
    check(
      'Projektdatei enthält die Fotofarben (Base64, gleiche Längen wie gespeichert)',
      TARGET_FIELDS.every((k) => b64len(k) === f[k].len),
      TARGET_FIELDS.map((k) => `${k} ${b64len(k)}`).join(', '),
    );
    await page.setInputFiles('[data-testid="project-import-input"]', file);
    await page.waitForSelector('[data-testid="project-import-summary"]', { timeout: 30000 });
    const rows = await page.$$eval('[data-testid="project-row"]', (rs) => rs.map((r) => r.dataset.project));
    const impId = rows.find((id) => id !== pid);
    const r9 = await report(page, impId, { map: true, stone: st.id });
    check(
      'Importiertes Projekt: Fotofarben Byte für Byte, Abweichung (Karte, Zusammenfassung, Freiformstein) identisch zum Original',
      !!impId && r9.found && r9.hash === r0.hash && sameSum(r9.sum, r8.sum) && JSON.stringify(r9.map) === JSON.stringify(r8.map) && r9.stone.state === 'free',
      `„${r9.name}“: ${r9.sum.measured} gemessen, ΔE im Mittel ${fmt(r9.sum.mean, 4)}`,
    );
    await shot(page, 'w5tc-04-import.png');

    // ===================================================================== G. Duplizieren
    await page.click(`[data-project="${pid}"] button:has-text("Duplizieren")`);
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="project-row"]').length === n, rows.length + 1, { timeout: 30000 });
    const rows2 = await page.$$eval('[data-testid="project-row"]', (rs) => rs.map((r) => r.dataset.project));
    const dupId = rows2.find((id) => !rows.includes(id));
    const r10 = await report(page, dupId, {});
    check('Dupliziertes Projekt: Fotofarben mitkopiert, Abweichung identisch', !!dupId && r10.hash === r0.hash && sameSum(r10.sum, r8.sum), `„${r10.name}“`);

    // ===================================================================== H. Projekt ohne Fotofarben (ältere Version)
    const removed = await page.evaluate((id) => window.__w5tcStrip(id), impId);
    await page.goto(`${BASE}#/project/${impId}/preview`);
    await page.reload();
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 60000 });
    await wait(800);
    const r11 = await report(page, impId, { map: true, stone: st2.id });
    check(
      'Projekt ohne Fotofarben (vor dieser Version berechnet) öffnet normal; keine Abweichung je Stein – nichts geschätzt',
      removed === 6 && r11.found && !r11.has && r11.hash === null && r11.sum.measured === 0 && r11.sum.missing.legacy === r11.sum.pieces && r11.sum.pieces === r8.sum.pieces && r11.map.every((v) => v === null) && r11.stone.state === 'legacy' && r11.top.length === 0,
      `${r11.sum.pieces} Steine ohne Fotoreferenz (Grund: ältere Berechnung)`,
    );
    await findStone(page, st2.id);
    const codeNow = await activeCode(page);
    await clickCode(page, codeNow === r0.codes[0] ? r0.codes[1] : r0.codes[0]);
    await saved(page);
    const r12 = await report(page, impId, { stone: st2.id });
    check(
      'Bearbeiten eines solchen Projekts speichert weiterhin ohne Fotofarben (nichts wird erfunden)',
      TARGET_FIELDS.every((k) => r12.fields[k] === null) && !r12.has && r12.stone.code !== codeNow,
      `${st2.id}: ${codeNow} → ${r12.stone.code}`,
    );
    await shot(page, 'w5tc-05-ohne-fotofarben.png');
    await page.keyboard.press('Escape');
    // neu berechnen ergänzt die Fotofarben (Live-Vorschau zugeklappt → echte Berechnung im Worker)
    await page.click('[data-testid="step-compute"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    const toggle = await page.$('[data-testid="live-preview-toggle"][aria-expanded="true"]');
    if (toggle) await toggle.click();
    await wait(300);
    const reuse2 = await compute(page);
    await saved(page);
    const r13 = await report(page, impId, { map: true });
    check(
      'Neu berechnen ergänzt die Fotofarben: wieder jeder Stein gemessen, exakt die Kennzahlen der Berechnung',
      r13.has && r13.hash !== null && r13.sum.measured === r13.sum.pieces && r13.sum.mean === r13.diag.mean && r13.sum.max === r13.diag.max && r13.sum.p95 === r13.diag.p95 && r13.byColorEq && r13.map.every((v) => v !== null),
      `${r13.sum.measured} Steine, ΔE im Mittel ${fmt(r13.sum.mean, 4)} · ${reuse2 ? 'Live-Vorschau übernommen' : 'neu berechnet (Worker)'}${r13.hash === r0.hash ? ' · Fotofarben wie beim ersten Mal' : ''}`,
    );
    check('Beide Speicherwege geprüft: übernommene Live-Vorschau und Berechnung im Worker', reuse1 !== reuse2, `erste Berechnung: ${reuse1 ? 'Vorschau übernommen' : 'Worker'}, zweite: ${reuse2 ? 'Vorschau übernommen' : 'Worker'}`);
    await ctx.close();

    // ===================================================================== I. Großes Raster (nur mit GROSS=1)
    if (BIG) {
      const ctxB = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE' });
      const big = await ctxB.newPage();
      big.on('pageerror', (e) => errors.push(String(e)));
      big.on('dialog', (d) => d.accept());
      await big.goto(BASE);
      await big.click('[data-testid="sample-portrait"]');
      await big.waitForSelector('[data-testid="compute-btn"]');
      const bid = projectId(big);
      // Maße direkt im gespeicherten Projekt setzen: 380 × 475 cm mit 2-mm-Steinen und 1 mm Fuge ≈ 2 Mio. Positionen
      await big.evaluate(
        (id) =>
          new Promise((res, rej) => {
            const r = indexedDB.open('mosaicplan');
            r.onsuccess = () => {
              const tx = r.result.transaction(['projects'], 'readwrite');
              const stp = tx.objectStore('projects');
              stp.get(id).onsuccess = (e) => {
                const rec = e.target.result;
                Object.assign(rec.settings, { widthMm: 3800, heightMm: 4750, tileW: 2, tileH: 2, joint: 1, unit: 'cm' });
                stp.put(rec, id);
              };
              tx.oncomplete = () => {
                r.result.close();
                res();
              };
              tx.onerror = () => rej(tx.error);
            };
          }),
        bid,
      );
      await big.reload();
      await big.click('[data-testid="step-compute"]').catch(() => {});
      await big.waitForSelector('[data-testid="compute-btn"]');
      const est0 = await big.evaluate(() => navigator.storage.estimate().then((e) => e.usage || 0));
      const t0 = Date.now();
      await compute(big, 600000);
      await big.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 120000 });
      const tCompute = Date.now() - t0;
      await wait(1500);
      const est1 = await big.evaluate(() => navigator.storage.estimate().then((e) => e.usage || 0));
      const rb = await report(big, bid, {});
      check(
        'Großes Raster (≈ 2 Mio. Positionen): Fotofarben gespeichert, Abweichung exakt wie berechnet',
        rb.cells > 1900000 && rb.has && rb.sum.mean === rb.diag.mean && rb.sum.max === rb.diag.max && rb.sum.measured === rb.sum.pieces,
        `${rb.cells} Zellen · Raster in IndexedDB ${fmt(rb.mosaicBytes / 1048576, 1)} MB, davon Fotofarben ${fmt(rb.targetBytes / 1048576, 1)} MB (${fmt(rb.targetBytes / rb.cells)} Byte/Zelle), Fortschritt ${fmt(rb.progressBytes / 1048576, 1)} MB · Speicherbelegung laut Browser +${fmt((est1 - est0) / 1048576, 1)} MB · Berechnen bis gespeichert ${fmt(tCompute / 1000, 1)} s`,
      );
      // Zeit für die Abweichungskarte im Browser und für ein Speichern nach einer Änderung
      const tMap = await big.evaluate(async (id) => {
        const t = performance.now();
        await window.__w5tcReport(id, { map: true });
        return performance.now() - t;
      }, bid);
      await big.click('[data-testid="step-preview"]');
      await big.waitForSelector('[data-testid="find-stone"]');
      await findStone(big, 'B0002');
      const c0 = await activeCode(big);
      const tSave0 = Date.now();
      await clickCode(big, c0 === '01' ? '02' : '01');
      await big.waitForSelector('[data-testid="save-status"][data-state="saving"]', { timeout: 5000 }).catch(() => {});
      await big.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 120000 });
      const tSave = Date.now() - tSave0;
      await wait(500);
      const rb2 = await report(big, bid, {});
      check(
        'Großes Raster: nach einer Änderung gespeichert – Fotofarben unverändert',
        rb2.hash === rb.hash && rb2.sum.measured === rb.sum.measured,
        `Speichern nach Umfärben ${fmt(tSave / 1000, 1)} s · Lesen + Abweichung (Zusammenfassung, je Farbe, Karte) im Browser ${fmt(tMap / 1000, 2)} s`,
      );
      await shot(big, 'w5tc-06-gross.png');
      await ctxB.close();
    }

    const real = errors.filter((e) => !/favicon|ResizeObserver/.test(e));
    check('Keine Fehler in der Browser-Konsole', real.length === 0, real.slice(0, 3).join(' | '));
  } catch (e) {
    check('Testlauf ohne Ausnahme', false, String(e && e.stack ? e.stack : e).slice(0, 600));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})();
