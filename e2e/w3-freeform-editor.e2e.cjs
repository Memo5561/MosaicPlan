/* Browser-Prüfung „Freiform-Editor“ (w3-freeform-editor).
 * Voraussetzung: `npm run build` und `npx vite preview` laufen.
 * Aufruf: node e2e/w3-freeform-editor.e2e.cjs <baseUrl> <outDir>
 *
 * Geprüft: Diagonalzelle öffnet fehlerfrei im Editor, Vorlagen, „Neu zeichnen“, Dreieck zeichnen, Eckpunkt ziehen
 * (Tabelle ändert sich, kein zusätzlicher Punkt), „+“ auf der Kante, Punkt löschen, Rückgängig, Überlappung
 * (übersetzter Fehler, rote Umrandung, Speichern gesperrt mit Grund), Berührung (Warnung, Speichern möglich),
 * Speichern → Steinzahl und Schnittvorlage passen zum neuen Teil, Neustart, Badge „Material fehlt“,
 * Englisch/Türkisch und am Handy: Tippen setzt Punkte, Ziehen mit dem Finger verschiebt ohne zu scrollen.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w3-freeform-editor');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

const nf = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const de1 = (v) => nf.format(v);
const num = (s) => parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
/** dieselbe Rasterregel wie snapFreePoint: Zellrand bis 0,2 mm, sonst 0,1 mm */
const snap = (v, max) => (v <= 0.2 ? 0 : max - v <= 0.2 ? max : Math.round(v * 10) / 10);

async function setupProject(page) {
  await page.goto(BASE);
  await page.waitForSelector('[data-testid="sample-portrait"]');
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
  await page.waitForTimeout(1200);
}

async function openStone(page, id) {
  await page.fill('[data-testid="find-stone"]', id);
  await page.press('[data-testid="find-stone"]', 'Enter');
  await page.waitForSelector('[data-testid="stone-id"]');
}

/** mm in der Zeichenfläche → Bildschirmkoordinaten */
async function toScreen(page, x, y) {
  return page.evaluate(
    ([mx, my]) => {
      const p = new DOMPoint(mx, my).matrixTransform(document.querySelector('[data-testid="free-svg"]').getScreenCTM());
      return { x: p.x, y: p.y };
    },
    [x, y],
  );
}

async function cellSize(page) {
  const vb = (await page.getAttribute('[data-testid="free-svg"]', 'viewBox')).split(' ').map(Number);
  // viewBox = −pad −pad W+2pad H+2pad (pad: Rand für die Kantenlängen, siehe FreeformEditor)
  const pad = -vb[0];
  return { W: vb[2] - 2 * pad, H: vb[3] - 2 * pad };
}

async function rows(page) {
  return page.$$eval('[data-testid="free-point-row"]', (rs) => rs.map((r) => [...r.querySelectorAll('input')].map((i) => i.value)));
}

async function legendTotal(page) {
  return page.$$eval('[data-testid="legend-item"]', (items) =>
    items.reduce((s, it) => {
      const spans = it.querySelectorAll(':scope > span.muted');
      const v = parseInt((spans[spans.length - 1]?.textContent || '').replace(/\D/g, ''), 10);
      return s + (Number.isFinite(v) ? v : NaN);
    }, 0),
  );
}

async function waitTotal(page, pred, ms = 10000) {
  const t0 = Date.now();
  let v = await legendTotal(page);
  while (Date.now() - t0 < ms) {
    if (pred(v)) return v;
    await page.waitForTimeout(200);
    v = await legendTotal(page);
  }
  return v;
}

/**
 * w5-undo-editing: am Desktop steht das Steindetail als Seitenleiste anstelle der Legende – zum Ablesen der
 * Steinzahlen kurz schließen (Esc) und danach denselben Stein wieder öffnen.
 */
async function withLegend(page, fn) {
  const open = await page.$('[data-testid="stone-panel"]');
  const id = open ? ((await page.textContent('[data-testid="stone-id"]')) || '').trim().split(/\s/)[0] : null;
  if (open) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="legend-item"]');
  }
  const v = await fn();
  if (id) await openStone(page, id);
  return v;
}

async function stableTotal(page) {
  let prev = await legendTotal(page);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(400);
    const v = await legendTotal(page);
    if (v === prev && Number.isFinite(v)) return v;
    prev = v;
  }
  return prev;
}

async function clickMm(page, x, y) {
  const p = await toScreen(page, x, y);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(60);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await setupProject(page);
  const projectUrl = page.url();
  const STONE = 'C005';

  // ---------- Diagonalzelle anlegen
  await openStone(page, STONE);
  await page.click('[data-testid="kind-diagA"]');
  await page.waitForTimeout(300);
  const idDiag = (await page.textContent('[data-testid="stone-id"]')).trim();
  check('Zelle als Diagonale ╲ (zwei Teile)', /-1/.test(idDiag) && /1\/2/.test(idDiag), idDiag.slice(0, 40));
  const totalDiag = await withLegend(page, () => stableTotal(page));
  const hint = (await page.textContent('.stone-grid')) || '';
  check('Kantenschnitt-Hinweis nennt die Richtungen', /0° = senkrecht/.test(hint) && /45° = ╱/.test(hint) && /135° = ╲/.test(hint));

  // ---------- Editor: Diagonale vorgeladen, exakt und fehlerfrei
  await page.click('[data-testid="kind-free"]');
  await page.waitForSelector('[data-testid="free-svg"]');
  await page.waitForTimeout(200);
  const { W, H } = await cellSize(page);
  const tabs0 = await page.$$eval('[data-testid="free-piece-tab"]', (b) => b.length);
  check('Diagonalzelle im Editor: 2 Teile vorgeladen, keine Fehler, keine Fugenwarnung', tabs0 === 2 && (await page.isVisible('[data-testid="free-ok"]')) && (await page.isEnabled('[data-testid="free-save"]')), `${tabs0} Teile, Zelle ${W} × ${H} mm`);
  const svgBox = await page.$eval('[data-testid="free-svg"]', (s) => s.getBoundingClientRect().width);
  check('Zeichenfläche groß (bis 560 px)', svgBox >= 400 && svgBox <= 561, `${Math.round(svgBox)} px`);
  await page.screenshot({ path: path.join(OUT, 'w3fe-01-diagonal-loaded.png') });

  // ---------- Vorlagen
  const presetTabs = {};
  for (const k of ['full', 'diagA', 'diagB', 'half', 'rhombus', 'trapezoid']) {
    await page.click(`[data-testid="free-preset-${k}"]`);
    await page.waitForTimeout(80);
    const nTabs = await page.$$eval('[data-testid="free-piece-tab"]', (b) => b.length);
    const errs = await page.$$eval('[data-testid="free-error"]', (e) => e.length);
    const gaps = await page.$$eval('[data-testid="free-warning"]', (e) => e.filter((x) => /Fuge zwischen|berühren sich/.test(x.textContent)).length);
    presetTabs[k] = `${nTabs}${errs || gaps ? '!' : ''}`;
  }
  check(
    'Vorlagen: Ganzer Stein 1, Diagonal ╲/╱ 2, Halbiert 2, Raute 1, Trapez 2 Teile – ohne Fehler und Fugenwarnung',
    JSON.stringify(presetTabs) === JSON.stringify({ full: '1', diagA: '2', diagB: '2', half: '2', rhombus: '1', trapezoid: '2' }),
    JSON.stringify(presetTabs),
  );
  await page.screenshot({ path: path.join(OUT, 'w3fe-02-preset-trapezoid.png') });

  // ---------- Neu zeichnen
  await page.click('[data-testid="free-clear"]');
  await page.waitForTimeout(100);
  const tabsClear = await page.$$eval('[data-testid="free-piece-tab"]', (b) => b.length);
  const errClear = (await page.textContent('[data-testid="free-issues"]')) || '';
  check(
    '„Neu zeichnen“: ein leeres Teil, Speichern gesperrt mit Grund',
    tabsClear === 1 && (await rows(page)).length === 0 && (await page.isDisabled('[data-testid="free-save"]')) && (await page.isVisible('[data-testid="free-save-blocked"]')) && /Teil 1: zu wenige Eckpunkte \(0 von mindestens 3\)/.test(errClear),
    errClear.slice(0, 90),
  );

  // ---------- Dreieck zeichnen
  const tri = [
    [0, 0],
    [W, 0],
    [0, H],
  ];
  for (const [x, y] of tri) await clickMm(page, x, y);
  const r3 = await rows(page);
  const closing = await page.$$eval('[data-testid="free-closing"]', (l) => l.length);
  const lens = await page.$$eval('[data-testid="free-edge-len"]', (t) => t.map((x) => x.textContent));
  check('Dreieck mit 3 Klicks: 3 Punkte, gestrichelte Schlusskante, Kantenlängen', r3.length === 3 && closing === 1 && lens.length === 3 && lens.includes(de1(Math.hypot(W, H))), `${JSON.stringify(r3)} | ${lens.join(' / ')}`);
  check('Dreieck gültig, Speichern möglich', (await page.isVisible('[data-testid="free-ok"]')) && (await page.isEnabled('[data-testid="free-save"]')));
  const measure = (await page.textContent('[data-testid="free-measure"]')) || '';
  check('Fläche und Außenmaß der gezeichneten Kontur', measure.includes(`Fläche ${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 }).format((W * H) / 2)} mm²`), measure.slice(0, 90));
  await page.screenshot({ path: path.join(OUT, 'w3fe-03-triangle.png') });

  // ---------- Eckpunkt 2 ziehen
  const tx = snap(W * 0.7, W);
  const ty = snap(H * 0.3, H);
  const from = await toScreen(page, W, 0);
  const to = await toScreen(page, tx, ty);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
  await page.mouse.up();
  await page.waitForTimeout(150);
  const rDrag = await rows(page);
  check(
    'Eckpunkt gezogen: Tabellenkoordinaten folgen (0,1-mm-Raster), kein zusätzlicher Punkt',
    rDrag.length === 3 && num(rDrag[1][0]) === tx && num(rDrag[1][1]) === ty && num(rDrag[0][0]) === 0 && num(rDrag[2][1]) === H,
    `${JSON.stringify(r3[1])} → ${JSON.stringify(rDrag[1])}`,
  );
  await page.screenshot({ path: path.join(OUT, 'w3fe-04-dragged.png') });

  // ---------- „+“ auf einer Kante, Punkt löschen, Rückgängig
  const mid = await page.$('[data-testid="free-mid"] circle');
  const mb = await mid.boundingBox();
  await page.mouse.click(mb.x + mb.width / 2, mb.y + mb.height / 2);
  await page.waitForTimeout(100);
  const rIns = await rows(page);
  check('„+“ auf der Kante fügt einen Punkt in der Kantenmitte ein', rIns.length === 4 && num(rIns[1][0]) === tx / 2 && num(rIns[1][1]) === ty / 2, JSON.stringify(rIns[1]));
  await page.click('[data-testid="free-del-point"] >> nth=1');
  await page.waitForTimeout(80);
  const rDel = await rows(page);
  await page.click('[data-testid="free-undo"]');
  await page.waitForTimeout(80);
  const rUndo1 = await rows(page);
  await page.click('[data-testid="free-undo"]');
  await page.waitForTimeout(80);
  const rUndo2 = await rows(page);
  check(
    'Punkt löschen (✕) und Rückgängig',
    rDel.length === 3 && JSON.stringify(rDel) === JSON.stringify(rDrag) && rUndo1.length === 4 && JSON.stringify(rUndo2) === JSON.stringify(rDrag),
    `${rDel.length} → ${rUndo1.length} → ${rUndo2.length}`,
  );

  // ---------- Überlappendes Teil
  await page.click('[data-testid="free-new-piece"]');
  for (const [x, y] of [
    [W * 0.2, H * 0.2],
    [W * 0.9, H * 0.6],
    [W * 0.2, H * 0.9],
  ])
    await clickMm(page, snap(x, W), snap(y, H));
  await page.waitForTimeout(100);
  const errOv = await page.$$eval('[data-testid="free-error"]', (e) => e.map((x) => x.textContent));
  const redPieces = await page.$$eval('[data-testid="free-piece-error"]', (e) => e.map((x) => x.getAttribute('data-piece')));
  check(
    'Überlappung: übersetzter Fehler „Teil 1 und Teil 2 überlappen sich“, beide Teile rot, Speichern gesperrt mit Grund',
    errOv.some((s) => /^Teil 1 und Teil 2 überlappen sich \([\d,]+ mm²\)/.test(s)) && redPieces.join() === '1,2' && (await page.isDisabled('[data-testid="free-save"]')) && /Speichern erst möglich/.test(await page.textContent('[data-testid="free-save-blocked"]')),
    `${errOv.join(' | ').slice(0, 120)} | rot: ${redPieces.join()}`,
  );
  const dot = await page.$$eval('[data-testid="free-piece-tab"] .w3fe-dot.err', (d) => d.length);
  check('Reiter der fehlerhaften Teile markiert', dot === 2);
  await page.screenshot({ path: path.join(OUT, 'w3fe-05-overlap.png') });
  await page.click('[data-testid="free-delete-piece"]');
  await page.waitForTimeout(80);
  check('Teil gelöscht → wieder gültig', (await page.isVisible('[data-testid="free-ok"]')) && (await rows(page)).length === 3);

  // ---------- Berührendes Teil (gemeinsame Kante): Warnung, kein Fehler
  await page.click('[data-testid="free-new-piece"]');
  for (const [x, y] of [
    [tx, ty],
    [W, H],
    [0, H],
  ])
    await clickMm(page, x, y);
  await page.waitForTimeout(100);
  const warnTouch = await page.$$eval('[data-testid="free-warning"]', (e) => e.map((x) => x.textContent));
  const errTouch = await page.$$eval('[data-testid="free-error"]', (e) => e.length);
  check(
    'Berührung ohne Fuge: Warnung (kein Fehler), Speichern bleibt möglich',
    errTouch === 0 && warnTouch.some((s) => /Teil 1 und Teil 2 berühren sich – keine Fuge dazwischen \(Projektfuge [\d,]+ mm\)/.test(s)) && (await page.isEnabled('[data-testid="free-save"]')),
    warnTouch.join(' | ').slice(0, 120),
  );
  await page.screenshot({ path: path.join(OUT, 'w3fe-06-touching.png') });
  await page.click('[data-testid="free-delete-piece"]');
  await page.waitForTimeout(80);

  // ---------- Speichern: Steinzahl und Schnittvorlage
  const final = (await rows(page)).map((r) => r.map(num));
  await page.click('[data-testid="free-save"]');
  await page.waitForTimeout(400);
  const editorGone = !(await page.isVisible('[data-testid="free-svg"]'));
  const idFree = (await page.textContent('[data-testid="stone-id"]')).trim();
  const cut = (await page.textContent('[data-testid="cut-instructions"]')).trim();
  const edges = final.map((p, i) => Math.hypot(final[(i + 1) % 3][0] - p[0], final[(i + 1) % 3][1] - p[1])).sort((a, b) => a - b);
  const expCut = `Dreieck schneiden: Kanten ${edges.map(de1).join(' / ')} mm.`;
  check('Gespeichert: ein Stein (keine Teilnummer), Form Dreieck', editorGone && !/-\d/.test(idFree.split('·')[0]) && (await page.textContent('.stone-grid')).includes('Dreieck'), idFree.slice(0, 30));
  check('Schnittanweisung aus der gezeichneten Kontur (analyzeCut)', cut.includes(expCut), `${cut.slice(0, 80)} | erwartet ${expCut}`);
  check('Schnittvorlage gezeichnet', await page.isVisible('[data-testid="cut-template"] svg'));
  const freeBtn = await page.getAttribute('[data-testid="kind-free"]', 'class');
  check('Formknopf „Freiform“ aktiv', /primary/.test(freeBtn || ''));
  await page.screenshot({ path: path.join(OUT, 'w3fe-07-saved-stone.png') });
  const totalFree = await withLegend(page, () => waitTotal(page, (v) => v === totalDiag - 1));
  check('Steinzahl: Diagonalzelle (2 Steine) → Freiform-Dreieck (1 Stein)', totalFree === totalDiag - 1, `${totalDiag} → ${totalFree}`);

  // ---------- Nach Neustart: Freiformteil exakt erhalten; Badge „Material fehlt“
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2500); // Speichern abwarten
  const projectId = (projectUrl.match(/project\/([^/]+)/) || [])[1];
  const patched = await page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('mosaicplan');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('projects', 'readwrite');
          const st = tx.objectStore('projects');
          const g = st.get(id);
          g.onsuccess = () => {
            const rec = g.result;
            if (!rec) return resolve(false);
            rec.palette = rec.palette.map((p) => ({ ...p, materialId: 'w3fe-geloeschtes-material' }));
            st.put(rec, id);
          };
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    projectId,
  );
  await page.reload();
  await page.waitForSelector('[data-testid="find-stone"]', { timeout: 60000 });
  await page.waitForTimeout(800);
  await openStone(page, STONE);
  await page.click('[data-testid="kind-free"]');
  await page.waitForSelector('[data-testid="free-svg"]');
  const reloaded = (await rows(page)).map((r) => r.map(num));
  check('Nach Neustart: Freiformteil unverändert im Editor', JSON.stringify(reloaded) === JSON.stringify(final), JSON.stringify(reloaded));
  // zweites Teil an der gemeinsamen Kante: mit Warnung gespeichert, das Steindetail nennt sie
  await page.click('[data-testid="free-new-piece"]');
  for (const [x, y] of [
    [reloaded[1][0], reloaded[1][1]],
    [W, H],
    [reloaded[2][0], reloaded[2][1]],
  ])
    await clickMm(page, x, y);
  await page.click('[data-testid="free-save"]');
  await page.waitForTimeout(400);
  const storedNote = (await page.isVisible('[data-testid="stone-free-issues"]')) ? await page.textContent('[data-testid="stone-free-issues"]') : '';
  const idTwo = (await page.textContent('[data-testid="stone-id"]')).trim();
  check('Gespeicherte Freiformzelle ohne Fuge: Steindetail nennt den Hinweis', /Hinweise zu dieser Freiform-Zelle/.test(storedNote) && /Teil 1 und Teil 2 berühren sich/.test(storedNote) && /1\/2/.test(idTwo), storedNote.slice(0, 100));
  const totalTwo = await withLegend(page, () => waitTotal(page, (v) => v === totalFree + 1));
  check('Steinzahl: zweites Freiformteil zählt als Stein', totalTwo === totalFree + 1, `${totalFree} → ${totalTwo}`);
  await page.screenshot({ path: path.join(OUT, 'w3fe-08a-stored-warning.png') });
  const missing = patched && (await page.isVisible('[data-testid="stone-material-missing"]')) ? await page.textContent('[data-testid="stone-material-missing"]') : '';
  check('Material gelöscht: Badge „Material fehlt (gelöscht oder nicht importiert)“ statt „?“', /Material fehlt \(gelöscht oder nicht importiert\)/.test(missing) && !/Material: \?/.test(await page.textContent('.stone-grid')), missing.trim());
  await page.screenshot({ path: path.join(OUT, 'w3fe-08-material-missing.png') });
  await page.keyboard.press('Escape');

  // ---------- Englisch und Türkisch
  for (const [lang, title, clear, lineRe] of [
    ['English', 'Draw free-form contour', 'Redraw', /0° = vertical/],
    ['Türkçe', 'Serbest biçim konturu çiz', 'Yeniden çiz', /0° = dikey/],
  ]) {
    await page.goto(BASE + '#/settings');
    await page.click(`[data-testid="lang-select"] >> text=${lang}`);
    await page.waitForTimeout(200);
    await page.goto(projectUrl);
    await page.waitForSelector('[data-testid="find-stone"]', { timeout: 60000 });
    await page.waitForTimeout(500);
    await openStone(page, STONE);
    const lh = await page.textContent('.stone-grid');
    await page.click('[data-testid="kind-free"]');
    await page.waitForSelector('[data-testid="free-svg"]');
    await page.click('[data-testid="free-new-piece"]');
    await page.waitForTimeout(80);
    const issue = (await page.textContent('[data-testid="free-issues"]')) || '';
    const ok =
      (await page.isVisible(`text=${title}`)) &&
      (await page.textContent('[data-testid="free-clear"]')).includes(clear) &&
      lineRe.test(lh) &&
      (lang === 'English'
        ? /Piece 3: too few corner points \(0 of at least 3\)/.test(issue) && /Pieces 1 and 2 touch – no joint between them/.test(issue)
        : /Parça 3: köşe noktası çok az \(0, en az 3 gerekli\)/.test(issue) && /Parça 1 ile parça 2 birbirine değiyor/.test(issue));
    check(`${lang}: Editor, Befunde und Kantenschnitt-Hinweis übersetzt`, ok, issue.slice(0, 80));
    if (lang === 'English') await page.screenshot({ path: path.join(OUT, 'w3fe-09-english.png') });
    await page.click('.modal-foot .btn:not(.primary)');
    await page.keyboard.press('Escape');
  }
  await page.goto(BASE + '#/settings');
  await page.click('[data-testid="lang-select"] >> text=Deutsch');
  await page.waitForTimeout(200);

  check('Keine Fehler in der Konsole (Desktop)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();

  // ================================================================ Handy: Tippen und Ziehen mit dem Finger
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  const perr = [];
  pp.on('pageerror', (e) => perr.push(String(e)));
  pp.on('console', (m) => m.type() === 'error' && perr.push(m.text()));
  await setupProject(pp);
  await openStone(pp, STONE);
  await pp.tap('[data-testid="kind-free"]');
  await pp.waitForSelector('[data-testid="free-svg"]');
  await pp.waitForTimeout(300);
  const overflow = await pp.evaluate(() => {
    const b = document.querySelectorAll('.modal-body');
    const body = b[b.length - 1];
    const svg = document.querySelector('[data-testid="free-svg"]').getBoundingClientRect();
    return { scroll: body.scrollWidth - body.clientWidth, svgW: svg.width, svgRight: svg.right, touch: getComputedStyle(document.querySelector('[data-testid="free-svg"]')).touchAction };
  });
  check('Handy: Zeichenfläche passt in die Breite, kein waagerechtes Scrollen, touch-action none', overflow.scroll <= 1 && overflow.svgRight <= 390 && overflow.svgW >= 250 && overflow.touch === 'none', JSON.stringify(overflow));
  await pp.tap('[data-testid="free-clear"]');
  await pp.$eval('[data-testid="free-svg"]', (el) => el.scrollIntoView({ block: 'center' }));
  await pp.waitForTimeout(200);
  const ps = await cellSize(pp);
  for (const [x, y] of [
    [0, 0],
    [ps.W, 0],
    [0, ps.H],
  ]) {
    const p = await toScreen(pp, x, y);
    await pp.touchscreen.tap(p.x, p.y);
    await pp.waitForTimeout(80);
  }
  const pr = await rows(pp);
  check('Handy: drei Fingertipps setzen drei Punkte', pr.length === 3, JSON.stringify(pr));
  const scrollBefore = await pp.evaluate(() => {
    const b = document.querySelectorAll('.modal-body');
    return [window.scrollY, b[b.length - 1].scrollTop];
  });
  const cdp = await phone.newCDPSession(pp);
  const a = await toScreen(pp, ps.W, 0);
  const tx2 = snap(ps.W * 0.6, ps.W);
  const ty2 = snap(ps.H * 0.4, ps.H);
  const b2 = await toScreen(pp, tx2, ty2);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] });
  for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + ((b2.x - a.x) * i) / 10, y: a.y + ((b2.y - a.y) * i) / 10 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pp.waitForTimeout(200);
  const pr2 = await rows(pp);
  const scrollAfter = await pp.evaluate(() => {
    const b = document.querySelectorAll('.modal-body');
    return [window.scrollY, b[b.length - 1].scrollTop];
  });
  check(
    'Handy: Eckpunkt mit dem Finger gezogen, Seite scrollt nicht, kein zusätzlicher Punkt',
    pr2.length === 3 && num(pr2[1][0]) === tx2 && num(pr2[1][1]) === ty2 && JSON.stringify(scrollBefore) === JSON.stringify(scrollAfter),
    `${JSON.stringify(pr2[1])} | scroll ${JSON.stringify(scrollBefore)} → ${JSON.stringify(scrollAfter)}`,
  );
  await pp.screenshot({ path: path.join(OUT, 'w3fe-10-phone-editor.png') });
  await pp.$eval('[data-testid="free-save"]', (el) => el.scrollIntoView({ block: 'center' }));
  await pp.tap('[data-testid="free-save"]');
  await pp.waitForTimeout(400);
  const pcut = (await pp.textContent('[data-testid="cut-instructions"]')) || '';
  check('Handy: Speichern per Fingertipp, Schnittanweisung Dreieck', !(await pp.isVisible('[data-testid="free-svg"]')) && /Dreieck schneiden/.test(pcut), pcut.slice(0, 60));
  await pp.screenshot({ path: path.join(OUT, 'w3fe-11-phone-saved.png') });
  check('Keine Fehler in der Konsole (Handy)', perr.length === 0, perr.slice(0, 3).join(' | '));
  await phone.close();
  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
