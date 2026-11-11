/* End-to-End-Tests im echten Browser (Chromium/Playwright) – ein Einstiegspunkt für alle Browser-Prüfungen.
 *
 * Voraussetzung: `npm run build` und ein laufender Vorschau-Server, z. B. `npx vite preview --port 4173`.
 *
 * Aufruf:  node e2e/run-e2e.cjs [baseUrl] [ausgabeOrdner] [filter]
 *          (npm run e2e -- http://localhost:4173/ /tmp/e2e)
 *
 * Ablauf:
 *   1. Grundablauf (unten, 17 Prüfungen): Porträt berechnen, Steindetail, Farb-/Formänderung, Verlegemodus,
 *      Abschnitt fertig, Material, PDF, Neustart, Sprachen, Material anlegen, Offline-Start, Handy-Ansicht.
 *      Screenshots und PDF direkt im Ausgabeordner.
 *   2. Danach jedes Paket-Skript e2e/*.e2e.cjs (Aufruf je Skript: node <skript> <baseUrl> <ausgabeOrdner>/<name>),
 *      Protokoll je Skript in <ausgabeOrdner>/<name>.log, Zusammenfassung in <ausgabeOrdner>/summary.txt.
 *   Der Exit-Code ist 0 nur, wenn der Grundablauf und jedes ausgeführte Skript bestanden haben.
 *
 * Optionen (Umgebungsvariablen):
 *   E2E_JOBS=3          so viele Paket-Skripte gleichzeitig (Standard 3; 1 = nacheinander). Zeitkritische Prüfungen
 *                       (z. B. „Übernehmen < 300 ms“) sind unter Parallel-Last empfindlicher – im Zweifel einzeln wiederholen.
 *   E2E_FILTER=muster   nur Skripte, deren Name (ohne .e2e.cjs) das Muster enthält; mehrere mit Komma, z. B.
 *                       „w6-,w5-undo“. Gleichwertig: drittes Argument. Mit Filter läuft der Grundablauf nur, wenn
 *                       ein Muster „base“ lautet.
 *   E2E_BASE=0          Grundablauf überspringen (nur Paket-Skripte); E2E_BASE=1 erzwingt ihn auch mit Filter.
 *   E2E_PACKAGES=0      nur den Grundablauf ausführen (Verhalten von früher).
 *   E2E_TIMEOUT_MIN=25  Zeitlimit je Paket-Skript in Minuten; danach wird es beendet und zählt als fehlgeschlagen.
 *   E2E_RETRY=1         fehlgeschlagene Paket-Skripte am Ende einmal einzeln wiederholen (Standard 0: keine
 *                       Wiederholung). Ein Skript, das erst dabei besteht, steht als FLAKY in der Zusammenfassung und
 *                       zählt für den Exit-Code als bestanden; scheitert es auch einzeln, bleibt es FAIL.
 */
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = path.resolve(process.argv[3] || path.join(__dirname, 'output'));
fs.mkdirSync(OUT, { recursive: true });

const FILTER = String(process.argv[4] ?? process.env.E2E_FILTER ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const envInt = (name, def, min) => {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= min ? v : def;
};
const JOBS = envInt('E2E_JOBS', 3, 1);
const TIMEOUT_MS = envInt('E2E_TIMEOUT_MIN', 25, 1) * 60 * 1000;
const RETRY = process.env.E2E_RETRY === '1';
const RUN_BASE = process.env.E2E_BASE === '1' || (process.env.E2E_BASE !== '0' && (FILTER.length === 0 || FILTER.includes('base')));
const RUN_PACKAGES = process.env.E2E_PACKAGES !== '0';

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

async function baseFlow() {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    await page.goto(BASE);
    await page.waitForSelector('text=MosaicPlan');
    await page.screenshot({ path: path.join(OUT, '01-start.png') });
    check('Startseite lädt', await page.isVisible('[data-testid="new-project"]'));

    // ---------- Testprojekt Porträt
    await page.click('[data-testid="sample-portrait"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.screenshot({ path: path.join(OUT, '02-compute.png') });
    const positions = await page.textContent('[data-testid="grid-positions"]');
    check('Rasterpositionen angezeigt', /\d/.test(positions), positions);
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '03-preview.png') });
    check('Mosaik berechnet, Vorschau sichtbar', true);

    // Stein anklicken
    const canvas = await page.$('[data-testid="mosaic-canvas"]');
    const box = await canvas.boundingBox();
    // hineinzoomen
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.42);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, '04-zoom.png') });
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.42);
    await page.waitForSelector('[data-testid="stone-id"]');
    const stoneId = (await page.textContent('[data-testid="stone-id"]')).trim();
    const coords = (await page.textContent('[data-testid="stone-coords"]')).trim();
    const cutText = (await page.textContent('[data-testid="cut-instructions"]')).trim();
    check('Steindetail öffnet', /^[A-Z]+\d{3}/.test(stoneId), `${stoneId} | ${coords.slice(0, 40)} | ${cutText.slice(0, 60)}`);
    await page.screenshot({ path: path.join(OUT, '05-stone.png') });
    // Farbe ändern
    const firstAlt = await page.$('[data-testid="color-pick"] button:not(.active)');
    await firstAlt.click();
    await page.waitForTimeout(300);
    check('Farbe eines Steins geändert', await page.isVisible('[data-testid="color-pick"] button.active'));
    // Form ändern: Diagonalschnitt → berechnete Schnittvorlage
    await page.click('button:has-text("Dreiecke ╲")');
    await page.waitForTimeout(300);
    const cut2 = (await page.textContent('[data-testid="cut-instructions"]')).trim();
    const id2 = (await page.textContent('[data-testid="stone-id"]')).trim();
    check('Form geändert: Dreieck mit berechneter Schnittvorlage', /Dreieck schneiden/.test(cut2) && /Schnitt 1/.test(cut2) && /-1/.test(id2), `${id2.slice(0, 12)} | ${cut2.slice(0, 90)}`);
    await page.screenshot({ path: path.join(OUT, '05b-stone-triangle.png') });
    await page.keyboard.press('Escape');

    // ---------- Verlegeplan + Fortschritt
    await page.click('[data-testid="step-plan"]');
    await page.waitForSelector('[data-testid="progress-pct"]');
    await page.click('text=Verlegemodus');
    await page.evaluate(() => window.scrollTo(0, 0));
    const c2 = await page.$('[data-testid="mosaic-canvas"]');
    await c2.scrollIntoViewIfNeeded();
    const b2 = await c2.boundingBox();
    const cx = b2.x + b2.width / 2;
    const cy = b2.y + b2.height / 2;
    const placedNow = async () => {
      await page.waitForTimeout(1200);
      return parseInt((await page.textContent('[data-testid="placed-count"]')).replace(/\D/g, ''), 10);
    };
    await page.mouse.click(cx, cy);
    const p1 = await placedNow();
    await page.mouse.click(cx, cy);
    const p0 = await placedNow();
    await page.mouse.click(cx, cy);
    await page.mouse.click(cx + 60, cy + 40);
    const p2 = await placedNow();
    const pct = await page.textContent('[data-testid="progress-pct"]');
    check('Fortschritt (Verlegemodus: Antippen setzt/entfernt)', p1 === 1 && p0 === 0 && p2 === 2, `1→${p1}, 0→${p0}, 2→${p2}`);
    // Abschnitt A1 als fertig markieren
    await page.click('.section-cell >> nth=0');
    await page.click('text=Abschnitt fertig');
    await page.waitForTimeout(1500);
    const pct2 = await page.textContent('[data-testid="progress-pct"]');
    // „< 0,1 %“ (verlegt, aber unter der Anzeigegenauigkeit) zählt als 0,1
    const pctNum = (s) => parseFloat(String(s).replace(/[^\d,.]/g, '').replace(',', '.'));
    check('Abschnitt fertig markiert', pctNum(pct2) > pctNum(pct), `${pct} → ${pct2}`);
    await page.screenshot({ path: path.join(OUT, '06-plan.png') });
    await page.click('text=Material >> nth=-1');
    await page.waitForSelector('[data-testid="material-calc"]');
    const mcPieces = await page.textContent('[data-testid="mc-pieces"]');
    check('Materialberechnung', /\d/.test(mcPieces), mcPieces);
    await page.screenshot({ path: path.join(OUT, '07-material.png') });

    // ---------- PDF
    await page.click('[data-testid="step-pdf"]');
    await page.waitForSelector('[data-testid="pdf-btn"]');
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('[data-testid="pdf-btn"]')]);
    const pdfPath = path.join(OUT, 'verlegeplan.pdf');
    await download.saveAs(pdfPath);
    const head = fs.readFileSync(pdfPath).slice(0, 5).toString();
    check('PDF erzeugt', head === '%PDF-', `${Math.round(fs.statSync(pdfPath).size / 1024)} KB`);
    await page.screenshot({ path: path.join(OUT, '08-pdf.png') });

    // ---------- Neustart: Projekt + Fortschritt erhalten?
    const url = page.url();
    await page.waitForTimeout(1500);
    await page.goto(BASE + '#/projects');
    await page.reload();
    await page.waitForSelector('[data-testid="project-row"]');
    await page.goto(url.replace(/\/pdf$/, '/plan'));
    await page.reload();
    await page.waitForSelector('[data-testid="progress-pct"]', { timeout: 60000 });
    await page.waitForTimeout(2000);
    const pct3 = await page.textContent('[data-testid="progress-pct"]');
    check('Projekt und Fortschritt nach Neustart erhalten', pct3.trim() === pct2.trim(), `${pct2} → ${pct3}`);

    // ---------- Sprache
    await page.goto(BASE + '#/settings');
    await page.click('[data-testid="lang-select"] >> text=Türkçe');
    await page.waitForTimeout(300);
    check('Türkisch', await page.isVisible('text=Ayarlar'));
    await page.click('[data-testid="lang-select"] >> text=English');
    await page.waitForTimeout(300);
    check('Englisch', await page.isVisible('text=Language'));
    await page.click('[data-testid="lang-select"] >> text=Deutsch');

    // ---------- Material anlegen
    await page.goto(BASE + '#/materials');
    await page.click('[data-testid="add-material"]');
    await page.fill('[data-testid="mat-manufacturer"]', 'Testhersteller');
    await page.fill('[data-testid="mat-colornumber"]', 'G-101');
    await page.fill('[data-testid="mat-hex"]', '#3A6EA5');
    await page.click('[data-testid="save-material"]');
    await page.waitForTimeout(400);
    check('Material gespeichert', (await page.textContent('[data-testid="materials-table"]')).includes('G-101'));

    // ---------- Offline (Service Worker)
    await page.goto(BASE);
    await page.waitForTimeout(2500);
    await context.setOffline(true);
    await page.reload();
    await page.waitForSelector('[data-testid="new-project"]', { timeout: 15000 }).catch(() => {});
    check('App startet offline', await page.isVisible('[data-testid="new-project"]'));
    await context.setOffline(false);

    // ---------- Handy-Ansicht
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const pp = await phone.newPage();
    await pp.goto(BASE);
    await pp.waitForSelector('[data-testid="new-project"]');
    await pp.screenshot({ path: path.join(OUT, '09-phone.png') });
    check('Handy-Ansicht', true);

    check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- Paket-Skripte e2e/*.e2e.cjs

function packageScripts() {
  return fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.e2e.cjs'))
    .sort()
    .map((f) => ({ file: path.join(__dirname, f), name: f.replace(/\.e2e\.cjs$/, '') }))
    .filter((s) => FILTER.length === 0 || FILTER.some((m) => s.name.includes(m)));
}

/** Prüfungszahlen aus dem Protokoll (nur zur Anzeige – maßgeblich ist der Exit-Code des Skripts) */
function countChecks(log) {
  const ok = (log.match(/^\s*✔/gm) || []).length;
  const bad = (log.match(/^\s*✘/gm) || []).length;
  return { ok, bad };
}

const children = new Set();
function killTree(child) {
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL'); // ganze Prozessgruppe (Skript + Chromium)
  } catch {
    /* schon beendet */
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const c of children) killTree(c);
    process.exit(130);
  });
}

function runScript(s, attempt) {
  return new Promise((resolve) => {
    const suffix = attempt > 1 ? `.retry${attempt - 1}` : '';
    const outDir = path.join(OUT, s.name + suffix);
    const logPath = path.join(OUT, `${s.name}${suffix}.log`);
    fs.mkdirSync(outDir, { recursive: true });
    const log = fs.createWriteStream(logPath);
    const started = Date.now();
    const child = spawn(process.execPath, [s.file, BASE, outDir], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    children.add(child);
    let text = '';
    const onData = (d) => {
      log.write(d);
      text += d.toString();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, TIMEOUT_MS);
    let finished = false;
    const finish = (code, signal, spawnError) => {
      if (finished) return; // 'error' und 'close' können beide kommen
      finished = true;
      clearTimeout(timer);
      children.delete(child);
      const note = spawnError
        ? `\n[run-e2e] Start fehlgeschlagen: ${spawnError}\n`
        : timedOut
          ? `\n[run-e2e] Zeitlimit ${TIMEOUT_MS / 60000} min überschritten – abgebrochen\n`
          : '';
      log.end(note);
      const { ok, bad } = countChecks(text);
      resolve({
        name: s.name,
        pass: code === 0 && !timedOut && !spawnError,
        code,
        signal,
        timedOut,
        ok,
        bad,
        secs: Math.round((Date.now() - started) / 1000),
        log: logPath,
      });
    };
    child.on('error', (e) => finish(null, null, String(e)));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function describe(r) {
  const checks = r.ok + r.bad > 0 ? `${r.ok}/${r.ok + r.bad} Prüfungen` : 'keine Prüfzeilen';
  const why = r.pass ? '' : r.timedOut ? ', Zeitlimit' : r.signal ? `, Signal ${r.signal}` : `, Exit-Code ${r.code}`;
  return `${checks}, ${r.secs} s${why}`;
}

async function runPackages() {
  const scripts = packageScripts();
  if (scripts.length === 0) {
    console.log(`\nKeine Paket-Skripte${FILTER.length ? ` für Filter „${FILTER.join(',')}“` : ''}.`);
    return [];
  }
  const jobs = Math.min(JOBS, scripts.length);
  console.log(`\n── Paket-Skripte: ${scripts.length}, ${jobs} gleichzeitig, Protokolle in ${OUT}`);
  const done = [];
  let next = 0;
  const worker = async () => {
    while (next < scripts.length) {
      const s = scripts[next++];
      const r = await runScript(s, 1);
      done.push(r);
      console.log(`${r.pass ? '✔' : '✘'} ${r.name} – ${describe(r)}${r.pass ? '' : ` → ${r.log}`}`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  const order = new Map(scripts.map((s, i) => [s.name, i]));
  done.sort((a, b) => order.get(a.name) - order.get(b.name));

  if (RETRY) {
    for (const r of done.filter((x) => !x.pass)) {
      console.log(`↻ ${r.name}: einzelne Wiederholung …`);
      const again = await runScript(scripts[order.get(r.name)], 2);
      r.retry = again;
      console.log(`${again.pass ? '✔' : '✘'} ${r.name} (Wiederholung) – ${describe(again)}${again.pass ? '' : ` → ${again.log}`}`);
    }
  }
  return done;
}

// ---------------------------------------------------------------- Hauptablauf

(async () => {
  const t0 = Date.now();
  let base = null;
  if (RUN_BASE) {
    console.log(`── Grundablauf (${BASE})`);
    try {
      await baseFlow();
    } catch (e) {
      console.error(e);
      check('Grundablauf ohne Abbruch', false, String(e && e.message ? e.message : e).split('\n')[0]);
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
    base = { pass: failed.length === 0, ok: results.length - failed.length, total: results.length };
  }

  const pkgs = RUN_PACKAGES ? await runPackages() : [];

  // ---------- Zusammenfassung
  const lines = [];
  if (base) lines.push(`${base.pass ? 'PASS' : 'FAIL'} base (run-e2e.cjs Grundablauf) – ${base.ok}/${base.total} Prüfungen`);
  for (const r of pkgs) {
    if (r.pass) lines.push(`PASS ${r.name} – ${describe(r)}`);
    else if (r.retry && r.retry.pass) lines.push(`FLAKY ${r.name} – fehlgeschlagen (${describe(r)}), bestanden erst bei Wiederholung (${describe(r.retry)})`);
    else lines.push(`FAIL ${r.name} – ${describe(r)}${r.retry ? `; Wiederholung: ${describe(r.retry)}` : ''} → ${r.log}`);
  }
  const passedFirst = pkgs.filter((r) => r.pass).length;
  const flaky = pkgs.filter((r) => !r.pass && r.retry && r.retry.pass).length;
  const failedPkgs = pkgs.length - passedFirst - flaky;
  const checksOk = pkgs.reduce((a, r) => a + (r.retry && !r.pass ? r.retry.ok : r.ok), 0);
  const checksAll = pkgs.reduce((a, r) => a + (r.retry && !r.pass ? r.retry.ok + r.retry.bad : r.ok + r.bad), 0);
  const total =
    `Paket-Skripte: ${passedFirst}/${pkgs.length} bestanden` +
    (flaky ? `, ${flaky} erst bei Wiederholung` : '') +
    (failedPkgs ? `, ${failedPkgs} fehlgeschlagen` : '') +
    ` · ${checksOk}/${checksAll} Prüfzeilen` +
    (base ? ` · Grundablauf ${base.ok}/${base.total}` : '') +
    ` · ${Math.round((Date.now() - t0) / 1000)} s`;
  lines.push('', total);
  fs.writeFileSync(path.join(OUT, 'summary.txt'), lines.join('\n') + '\n');
  console.log(`\n══ Zusammenfassung (${path.join(OUT, 'summary.txt')})\n${lines.join('\n')}`);

  // Nichts ausgeführt (z. B. Filter ohne Treffer) ist kein Erfolg
  const nothingRan = !base && pkgs.length === 0;
  if (nothingRan) console.log('Es wurde keine Prüfung ausgeführt.');
  const anyFail = nothingRan || (base && !base.pass) || failedPkgs > 0;
  process.exit(anyFail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
