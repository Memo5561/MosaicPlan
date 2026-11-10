/* Zusammenführung Welle 5 im echten Browser (Chromium/Playwright).
 * Aufruf: node e2e/w5-integration.e2e.cjs <baseUrl> <outDir>
 *
 * Prüft das Zusammenspiel der Pakete:
 *  - Statistik (w5-stats-engine) + Projekt (w5-undo-editing) + Material & Einkauf (w5-material-shopping):
 *    Die App fragt die Statistik mit der eingestellten Mindestbreite an. Frisch berechnet: geprüft und kein Hinweis.
 *    Mindestbreite nachträglich erhöht (ohne Neuberechnung): Hinweis „… Teile schmaler als die Mindestbreite“ mit
 *    einer Zahl, die zur Formentabelle passt, und derselben Markierung im Steindetail; zurückgestellt: Hinweis weg.
 *  - Rückgängig (w5-undo-editing) + Rückpuffer des Viewers (w5-viewer-performance): Farbe im seitlichen Steindetail
 *    ändern, Strg+Z, Strg+Y – das Pixel des Steins folgt jedes Mal sofort, ohne den Puffer neu aufzubauen.
 *  - PDF (w5-pdf-content) mit der neuen Statistik: Der Export aus der App enthält die Legende je Blatt und die
 *    kompakte, vollständige Koordinatenliste; die Steinzahl im PDF ist die der Materialansicht.
 *  - PDF-Schritt (w5-pdf-export-ui) + PDF-Inhalt (w5-pdf-content): Die Seitenzahl vor dem Erzeugen („ca. N Seiten“)
 *    ist die Seitenzahl des erzeugten PDFs – auch nach einer Bearbeitung.
 *  - Fotofarben je Stein (w5-target-colours) + Statistik, PDF-Schritt und CSV: Die Berechnung speichert die Fotofarbe
 *    jedes Steins. Statistik, Seitenplan, PDF und CSV bekommen das Raster ohne die Fotofarben in den Worker (keine
 *    unnötige Kopie) – im gespeicherten Raster bleiben sie über Bearbeitung, Rückgängig/Wiederholen, PDF- und
 *    CSV-Export Byte für Byte erhalten.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w5-integration');
fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
function check(name, ok, info = '') {
  if (!ok) failed++;
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const num = (s) => parseInt(String(s).replace(/\D/g, ''), 10);

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // Aufträge an die Worker mitschreiben: Art des Auftrags und wie viele Felder der Fotofarben das Raster mitführt
  const TARGET_FIELDS = ['tKind', 'tLab1', 'tLab2', 'tLine', 'tSubLen', 'tSubLab'];
  const posts = [];
  await context.exposeBinding('__w5intPost', (_source, rec) => {
    posts.push(rec);
  });
  await context.addInitScript((fields) => {
    const orig = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg, ...rest) {
      try {
        if (msg && typeof msg.type === 'string' && msg.mosaic) window.__w5intPost({ type: msg.type, targets: fields.filter((f) => f in msg.mosaic).length });
      } catch {
        /* nur Mitschrift */
      }
      return orig.call(this, msg, ...rest);
    };
  }, TARGET_FIELDS);
  const projectId = () => (page.url().match(/#\/project\/([^/]+)/) || [])[1];
  /** Fotofarben im gespeicherten Raster (IndexedDB): vorhandene Felder, Längen und Prüfsumme über alle Bytes */
  const storedTargets = (pid) =>
    page.evaluate(
      ([id, fields]) =>
        new Promise((res, rej) => {
          const r = indexedDB.open('mosaicplan');
          r.onerror = () => rej(r.error);
          r.onsuccess = () => {
            const tx = r.result.transaction(['mosaics']);
            let m;
            tx.objectStore('mosaics').get(id).onsuccess = (e) => (m = e.target.result);
            tx.onerror = () => rej(tx.error);
            tx.oncomplete = () => {
              r.result.close();
              if (!m) return res(null);
              const have = fields.filter((f) => m[f] instanceof Uint8Array);
              let h = 2166136261;
              let bytes = 0;
              for (const f of have) {
                const u = m[f];
                for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
                h = Math.imul(h ^ (u.length & 255), 16777619);
                bytes += u.length;
              }
              res({ cells: m.cols * m.rows, fields: have.length, kindLen: m.tKind ? m.tKind.length : 0, lab1Len: m.tLab1 ? m.tLab1.length : 0, bytes, hash: `${bytes}:${h >>> 0}` });
            };
          };
        }),
      [pid, TARGET_FIELDS],
    );
  /** wartet, bis alles gespeichert ist (Anzeige „gespeichert“, danach kurz Ruhe für die IndexedDB-Transaktion) */
  const saved = async () => {
    await page.waitForTimeout(450); // Entprellzeit des Speicherns
    await page.waitForSelector('[data-testid="save-status"][data-state="saved"]', { timeout: 30000 });
    await page.waitForTimeout(250);
  };

  const minField = () =>
    page.evaluateHandle(() =>
      [...document.querySelectorAll('.field')].find((el) => (el.querySelector('.field-label')?.textContent ?? '').startsWith('Mindestbreite eines Schnittteils')).querySelector('input'),
    );
  const openMaterial = async () => {
    await page.click('[data-testid="step-plan"]');
    await page.waitForSelector('[data-testid="placed-count"]');
    await page.locator('[data-testid="plan-view"] button').nth(1).click();
    await page.waitForSelector('[data-testid="material-calc"][data-busy="no"]', { timeout: 60000 });
  };
  const pixelAt = (x, y) =>
    page.evaluate(
      ([px, py]) => {
        const c = document.querySelector('[data-testid="mosaic-canvas"]');
        const r = c.getBoundingClientRect();
        const sx = c.width / r.width;
        const d = c.getContext('2d').getImageData(Math.round((px - r.left) * sx), Math.round((py - r.top) * sx), 1, 1).data;
        return `${d[0]},${d[1]},${d[2]}`;
      },
      [x, y],
    );

  try {
    await page.goto(BASE);
    await page.waitForSelector('[data-testid="sample-portrait"]');
    await page.click('[data-testid="sample-portrait"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
    await page.waitForTimeout(800);

    // ================= 0. Fotofarben: Die Berechnung speichert die Fotofarbe jedes Steins im Raster
    const pid = projectId();
    await saved();
    const targets0 = await storedTargets(pid);
    check(
      'Berechnung speichert die Fotofarbe jedes Steins im Raster (IndexedDB)',
      !!targets0 && targets0.fields === TARGET_FIELDS.length && targets0.kindLen === targets0.cells && targets0.lab1Len === targets0.cells * 3,
      targets0 ? `${targets0.cells} Zellen, ${targets0.bytes} Byte Fotofarben (${(targets0.bytes / targets0.cells).toFixed(2)} je Zelle)` : 'kein Raster gespeichert',
    );

    // ================= 1. Rückgängig + Rückpuffer: Pixel folgt Bearbeitung, Strg+Z und Strg+Y
    const canvas = await page.$('[data-testid="mosaic-canvas"]');
    const box = await canvas.boundingBox();
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.42;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(600); // exaktes Bild nach der Zoomgeste
    await page.mouse.click(cx, cy);
    await page.waitForSelector('[data-testid="stone-id"]');
    const stoneId = (await page.textContent('[data-testid="stone-id"]')).trim();
    const panel = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return d ? d.getAttribute('aria-modal') : null;
    });
    check('Steindetail als Seitenleiste neben dem Mosaik (1360 px)', panel === 'false', `${stoneId}, aria-modal=${panel}`);
    // Zoom und Lage des Steins bleiben beim Öffnen der Seitenleiste; das Pixel in Steinmitte beobachten
    const frame0 = await page.getAttribute('[data-testid="mosaic-canvas"]', 'data-frame');
    const resets0 = await page.getAttribute('[data-testid="mosaic-canvas"]', 'data-base-resets');
    const before = await pixelAt(cx, cy);
    const sw = page.locator('[data-testid="color-pick"] button.cp');
    let changed = false;
    const count = await sw.count();
    for (let i = 0; i < count && !changed; i++) {
      const b = sw.nth(i);
      if ((await b.getAttribute('aria-pressed')) === 'true' || (await b.isDisabled())) continue;
      await b.click();
      await page.waitForTimeout(250);
      changed = (await pixelAt(cx, cy)) !== before;
    }
    const after = await pixelAt(cx, cy);
    check('Farbe im Steindetail geändert: Pixel des Steins ändert sich sofort', changed && after !== before, `${before} → ${after} (Bild „${frame0}“)`);
    await page.keyboard.press('Escape'); // Seitenleiste schließen, damit kein Feld den Tastaturbefehl abfängt
    await page.waitForTimeout(200);
    const afterClose = await pixelAt(cx, cy);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(350);
    const undone = await pixelAt(cx, cy);
    await page.keyboard.press('Control+y');
    await page.waitForTimeout(350);
    const redone = await pixelAt(cx, cy);
    const resets1 = await page.getAttribute('[data-testid="mosaic-canvas"]', 'data-base-resets');
    check('Strg+Z stellt die alte Farbe im Bild wieder her, Strg+Y die neue', undone !== afterClose && redone === afterClose, `${afterClose} → ${undone} → ${redone}`);
    check('Rückgängig/Wiederholen zeichnet nur den Stein neu (Puffer nicht neu aufgebaut)', resets0 !== null && resets0 === resets1, `Neuaufbauten ${resets0} → ${resets1}`);
    await page.screenshot({ path: path.join(OUT, '01-undo-buffer.png') });

    // ================= 2. Mindestbreite in der Statistik: frisch berechnet → geprüft, kein Hinweis
    await openMaterial();
    const pieces0 = num(await page.textContent('[data-testid="mc-pieces"]'));
    check(
      'Material & Einkauf: Mindestbreite geprüft, frisch berechnet ohne Hinweise',
      (await page.getAttribute('[data-testid="material-calc"]', 'data-min-checked')) === 'yes' &&
        (await page.$('[data-testid="mc-thin"]')) === null &&
        (await page.$('[data-testid="mc-thin-free"]')) === null &&
        (await page.$('[data-testid="mc-overlap"]')) === null,
      `${pieces0} Steine`,
    );
    await page.screenshot({ path: path.join(OUT, '02-material-fresh.png'), fullPage: true });

    // Mindestbreite nachträglich auf 4 mm (ohne Neuberechnung): Dreiecke eines 5-mm-Steins (Inkreis 2,5 mm) sind zu schmal
    await page.click('[data-testid="step-shapes"]');
    await page.waitForSelector('text=Mindestbreite eines Schnittteils (mm)');
    const inp = await minField();
    const oldMin = await inp.inputValue();
    await inp.fill('4');
    await inp.evaluate((el) => el.blur());
    await page.waitForTimeout(300);
    await openMaterial();
    await page.waitForSelector('[data-testid="mc-thin"]', { timeout: 30000 });
    const thinText = (await page.textContent('[data-testid="mc-thin"]')).trim();
    const thin = Number(await page.getAttribute('[data-testid="mc-thin"]', 'data-count'));
    const pieces1 = num(await page.textContent('[data-testid="mc-pieces"]'));
    // Formentabelle: Dreiecke (alle aus Diagonalteilung, bei 4 mm alle zu schmal) als untere Schranke; zugeschnittene Teile als obere
    const shapeRows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="material-calc"] table tr')].map((tr) => [...tr.children].map((c) => c.textContent.trim())).filter((r) => r.length >= 2),
    );
    const tri = shapeRows.find((r) => /^Dreieck/.test(r[0]));
    const triangles = tri ? num(tri[1]) : NaN;
    // „841 zugeschnitten · 5.170 ganz“ unter der Kennzahl „Steine gesamt“
    const cutSub = await page.evaluate(() => document.querySelector('[data-testid="mc-pieces"]')?.parentElement?.querySelector('.w5ms-stat-sub')?.textContent ?? '');
    const cut = num((cutSub.match(/([\d.]+)\s*zugeschnitten/) || [])[1] || '');
    check('Mindestbreite 4 mm ohne Neuberechnung: Hinweis mit Anzahl und Mindestbreite', thin > 0 && thinText.includes('4 mm') && /Mindestbreite/.test(thinText), thinText.slice(0, 110));
    check('Anzahl passt zur Statistik: Dreiecke ≤ schmale Teile ≤ zugeschnittene Teile; Steinzahl unverändert', triangles > 0 && thin >= triangles && thin <= cut && pieces1 === pieces0, `${triangles} ≤ ${thin} ≤ ${cut}; ${pieces1} Steine`);
    await page.screenshot({ path: path.join(OUT, '03-material-thin.png'), fullPage: true });

    // Englisch und Türkisch: Hinweis übersetzt (kein roher Schlüssel)
    const planUrl = page.url();
    const setLang = async (label) => {
      await page.goto(BASE + '#/settings');
      await page.click(`[data-testid="lang-select"] >> text=${label}`);
      await page.waitForTimeout(300);
      await page.goto(planUrl);
      await page.waitForSelector('[data-testid="plan-view"]', { timeout: 60000 });
    };
    for (const [label, word] of [
      ['English', 'minimum width'],
      ['Türkçe', 'en küçük genişlik'],
    ]) {
      await setLang(label);
      await page.locator('[data-testid="plan-view"] button').nth(1).click();
      await page.waitForSelector('[data-testid="material-calc"][data-busy="no"]', { timeout: 60000 });
      await page.waitForSelector('[data-testid="mc-thin"]', { timeout: 30000 });
      const txt = ((await page.textContent('[data-testid="mc-thin"]').catch(() => '')) || '').trim();
      const same = Number(await page.getAttribute('[data-testid="mc-thin"]', 'data-count')) === thin;
      check(`Hinweis übersetzt (${label}), gleiche Anzahl`, txt.includes(word) && !txt.includes('w5int.') && same, txt.slice(0, 90));
    }
    await setLang('Deutsch');

    // dasselbe Urteil im Steindetail: ein Dreieck öffnen → Markierung „Erfüllt die Mindestbreite … nicht“
    await page.locator('[data-testid="plan-view"] button').nth(0).click();
    await page.waitForSelector('[data-testid="mosaic-canvas"]');
    const tri1 = await page.evaluate(async () => {
      const open = (name) => new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const db = await open('mosaicplan');
      const all = (store) => new Promise((res, rej) => { const tx = db.transaction(store, 'readonly'); const s = tx.objectStore(store); const k = s.getAllKeys(); const v = s.getAll(); tx.oncomplete = () => res(k.result.map((x, i) => [x, v.result[i]])); tx.onerror = () => rej(tx.error); });
      const projects = await all('projects');
      const [id] = projects[projects.length - 1];
      const m = (await all('mosaics')).find(([k]) => k === id)[1];
      const kind = m.kind;
      for (let i = 0; i < kind.length; i++) if (kind[i] === 1 || kind[i] === 2) return { idx: i, cols: m.cols };
      return null;
    });
    if (!tri1) check('ein diagonal geteilter Stein vorhanden', false);
    else {
      const row = Math.floor(tri1.idx / tri1.cols);
      const col = tri1.idx - row * tri1.cols;
      const letters = (n) => { let s = ''; n++; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
      const id = `${letters(row)}${String(col + 1).padStart(3, '0')}`;
      await page.fill('[data-testid="find-stone"]', id);
      await page.click('[data-testid="find-stone-go"]');
      await page.waitForSelector('[data-testid="stone-id"]', { timeout: 8000 }).catch(() => {});
      const shown = ((await page.textContent('[data-testid="stone-id"]').catch(() => '')) || '').trim();
      const badge = ((await page.textContent('[data-testid="stone-below-min"]').catch(() => '')) || '').trim();
      check('Steindetail eines Dreiecks trägt dieselbe Markierung (gleiche Regel)', shown.startsWith(id) && /Mindestbreite/.test(badge) && badge.includes('4 mm'), `${shown}: ${badge.slice(0, 90)}`);
      await page.screenshot({ path: path.join(OUT, '04-stone-below-min.png') });
      await page.keyboard.press('Escape');
    }

    // zurück auf den alten Wert: Hinweis verschwindet (Statistik läuft bei geänderter Mindestbreite neu)
    await page.click('[data-testid="step-shapes"]');
    await page.waitForSelector('text=Mindestbreite eines Schnittteils (mm)');
    const inp2 = await minField();
    await inp2.fill(oldMin);
    await inp2.evaluate((el) => el.blur());
    await page.waitForTimeout(300);
    await openMaterial();
    await page.waitForFunction(() => !document.querySelector('[data-testid="mc-thin"]'), null, { timeout: 30000 }).catch(() => {});
    check(`Mindestbreite zurück auf ${oldMin} mm: Hinweis verschwindet`, (await page.$('[data-testid="mc-thin"]')) === null && (await page.getAttribute('[data-testid="material-calc"]', 'data-min-checked')) === 'yes');

    // ================= 3. PDF aus der App: Legende je Blatt + kompakte Koordinaten, Steinzahl wie Materialansicht
    await page.click('[data-testid="step-pdf"]');
    await page.waitForSelector('[data-testid="pdf-btn"]');
    // Seitenzahl vor dem Erzeugen: gemessener Seitenplan (Trockenlauf des Generators im Worker)
    await page.waitForSelector('[data-testid="pdf-plan"][data-state="ready"]', { timeout: 60000 });
    const planned = Number(await page.getAttribute('[data-testid="pdf-plan"]', 'data-total'));
    const plannedText = ((await page.textContent('[data-testid="pdf-total"]').catch(() => '')) || '').trim();
    await page.screenshot({ path: path.join(OUT, '05-pdf-step.png'), fullPage: true });
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 180000 }), page.click('[data-testid="pdf-btn"]')]);
    const pdfPath = path.join(OUT, 'plan.pdf');
    await download.saveAs(pdfPath);
    let pdfPages = NaN;
    try {
      pdfPages = Number((execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/) || [])[1]);
    } catch (e) {
      check('pdfinfo verfügbar', false, String(e).slice(0, 120));
    }
    check('PDF-Schritt: Seitenzahl vor dem Erzeugen („ca.“) = Seiten des erzeugten PDFs (nach Bearbeitung)', planned > 0 && planned === pdfPages && /ca\./.test(plannedText), `„${plannedText}“ → PDF ${pdfPages} Seiten`);
    let text = '';
    try {
      text = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
    } catch (e) {
      check('pdftotext verfügbar', false, String(e).slice(0, 120));
    }
    if (text) {
      const heads = [...text.matchAll(/Steine auf diesem Blatt:\s*([\d.]+)/g)].map((m) => num(m[1]));
      const sheetSum = heads.reduce((a, b) => a + b, 0);
      const control = /Kontrolle/.test(text);
      const truncated = /gekürzt/.test(text);
      check('PDF: Farblegende auf jedem Verlegeblatt, Σ Steine der Blätter = Steine der Materialansicht', heads.length > 0 && sheetSum === pieces0, `${heads.length} Blätter, Σ ${sheetSum} = ${pieces0}`);
      const flat = text.replace(/\s+/g, ' ');
      const ctl = [...flat.matchAll(/Kontrolle: ([\d.]+) ganze Steine \+ ([\d.]+) Sonderteile = ([\d.]+) Steine/g)].map((m) => [num(m[1]), num(m[2]), num(m[3])]);
      const ctlSum = ctl.reduce((a, c) => a + c[2], 0);
      check(
        'PDF: kompakte Koordinaten vollständig (nichts gekürzt), Σ Kontrollzeilen = Steine der Materialansicht',
        control && !truncated && ctl.length > 0 && ctl.every((c) => c[0] + c[1] === c[2]) && ctlSum === pieces0,
        `${ctl.length} Abschnitte, Σ ${ctlSum} = ${pieces0}`,
      );
    }

    // ================= 4. Fotofarben + Worker-Aufträge: ohne Fotofarben in den Worker, gespeichert bleiben sie erhalten
    await page.click('[data-testid="step-plan"]');
    await page.waitForSelector('[data-testid="placed-count"]');
    await page.locator('[data-testid="plan-view"] button').nth(0).click();
    await page.waitForSelector('[data-testid="csv-all"]');
    const [csvDownload] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('[data-testid="csv-all"]')]);
    const csvPath = path.join(OUT, 'plan.csv');
    await csvDownload.saveAs(csvPath);
    const csvLines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').length;
    await page.waitForTimeout(200); // Mitschrift der Aufträge (läuft über die Brücke zur Testumgebung) ankommen lassen
    const lean = ['stats', 'pdfPlan', 'pdf', 'csv'].map((type) => {
      const mine = posts.filter((p) => p.type === type);
      return { type, n: mine.length, withTargets: mine.filter((p) => p.targets > 0).length };
    });
    check(
      'Statistik, Seitenplan, PDF und CSV: Raster ohne Fotofarben an den Worker (keine unnötige Kopie)',
      lean.every((l) => l.n > 0 && l.withTargets === 0),
      lean.map((l) => `${l.type} ${l.n}× (${l.withTargets} mit Fotofarben)`).join(', '),
    );
    check('CSV aus dem schlanken Raster: genau eine Zeile je Stein (= Steine der Materialansicht)', csvLines === pieces0 + 1, `${csvLines - 1} Zeilen, ${pieces0} Steine`);
    await saved();
    const targets1 = await storedTargets(pid);
    check(
      'Fotofarben im gespeicherten Raster nach Bearbeitung, Rückgängig/Wiederholen, PDF und CSV Byte für Byte unverändert',
      !!targets0 && !!targets1 && targets1.fields === TARGET_FIELDS.length && targets1.hash === targets0.hash,
      targets0 && targets1 ? `${targets0.hash} → ${targets1.hash}` : 'kein Raster gespeichert',
    );

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
