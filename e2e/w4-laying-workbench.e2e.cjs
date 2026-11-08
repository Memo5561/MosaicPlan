/* w4-laying-workbench: Werkbank „Verlegen“ in Schritt 9 im echten Browser (Chromium/Playwright).
 *
 *  - Abschnitt B2 gewählt, Verlegemodus: Antippen in A1 ändert nichts, fragt „Stein gehört zu Abschnitt A1 – wechseln?“
 *  - Karte „Nächster Stein“: erster Stein von B2, 3× „✓ verlegt & weiter“ + Rückgängig → 2 verlegt
 *  - Rechteck: genau die Steine des Bereichs (gegengeprüft mit dem gespeicherten Raster in IndexedDB)
 *  - Malen, „Abschnitt fertig“ auf teilweise verlegtem Abschnitt + Rückgängig (exakte Zahlen)
 *  - Farbchips (offen je Farbe), Farbfilter der Karte, Reihenfolge Reihe/Farbe, gemerkte Auswahl nach Neuladen
 *  - Stein suchen: ZZ9999 → Meldung mit gültigem Bereich; gefundener Stein wird im Verlegemodus nicht verlegt
 *  - „PDF B2“ → Schritt 10 mit Abschnitt B2; CSV-Fehler wird angezeigt
 *  - „Material & Einkauf“: volle Breite ohne Viewer, kein waagerechtes Scrollen bei 1440 px
 *  - Handy: Karte klebt unten, Malen bei zu kleinen Steinen verschiebt nur (kein versehentliches Markieren)
 *
 * Aufruf: node e2e/w4-laying-workbench.e2e.cjs <baseUrl> <outDir>
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w4-laying-workbench');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info !== '' ? ` – ${info}` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (s) => parseInt(String(s || '').replace(/\D/g, ''), 10);

/** Porträt-Beispiel: 40 × 50 cm, 5-mm-Steine, 1 mm Fuge → Zelle (r, c) beginnt bei (6c, 6r) mm */
const PITCH = 6;
const TILE = 5;

async function placed(page) {
  return digits(await page.textContent('[data-testid="placed-count"]'));
}
/** warten, bis die Zahl „Verlegt“ den Wert hat (oder Zeit abgelaufen) – liefert den letzten Wert */
async function placedBecomes(page, want, ms = 4000) {
  const t0 = Date.now();
  let v = await placed(page);
  while (v !== want && Date.now() - t0 < ms) {
    await wait(100);
    v = await placed(page);
  }
  return v;
}
async function cellPoint(page, row, col) {
  return page.$eval(
    '[data-testid="mosaic-canvas"]',
    (cv, [r, c, P, T]) => {
      const b = cv.getBoundingClientRect();
      const s = +cv.dataset.scale;
      return { x: b.left + +cv.dataset.ox + (c * P + T / 2) * s, y: b.top + +cv.dataset.oy + (r * P + T / 2) * s };
    },
    [row, col, PITCH, TILE],
  );
}
/** Mosaik ganz ins Bild scrollen (der Viewer ist am Desktop fast so hoch wie das Fenster) */
async function centerCanvas(page) {
  await page.$eval('[data-testid="mosaic-canvas"]', (c) => c.scrollIntoView({ block: 'center' }));
  await wait(150);
}
const projectId = (page) => (page.url().match(/#\/project\/([^/]+)/) || [])[1];

/** Gespeicherten Stand aus IndexedDB lesen: Teile und verlegte Teile im Bereich (unabhängig von der Oberfläche gezählt) */
async function storedCounts(page, rg) {
  const pid = projectId(page);
  return page.evaluate(
    ([pid, rg]) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('mosaicplan');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['mosaics', 'progress', 'projects'], 'readonly');
          const out = {};
          tx.objectStore('mosaics').get(pid).onsuccess = (e) => (out.m = e.target.result);
          tx.objectStore('progress').get(pid).onsuccess = (e) => (out.p = e.target.result);
          tx.objectStore('projects').get(pid).onsuccess = (e) => (out.r = e.target.result);
          tx.oncomplete = () => {
            const m = out.m;
            const prog = out.p;
            const sub = new Map();
            for (let i = 0; i < m.subIdx.length; i++) sub.set(m.subIdx[i], m.subLen[i]);
            const free = new Map(m.free.map(([k, v]) => [k, v.length]));
            const count = (idx) => {
              const k = m.kind[idx];
              if (k === 0) return 1;
              if (k === 4) return sub.get(idx) ?? 1;
              if (k === 5) return free.get(idx) ?? 0;
              return 2;
            };
            const r = rg || { r0: 0, r1: m.rows, c0: 0, c1: m.cols };
            let total = 0;
            let placed = 0;
            for (let row = r.r0; row < r.r1; row++)
              for (let col = r.c0; col < r.c1; col++) {
                const idx = row * m.cols + col;
                const n = count(idx);
                total += n;
                let v = prog[idx] & ((1 << n) - 1);
                for (; v; v &= v - 1) placed++;
              }
            resolve({ total, placed, pdfSections: out.r && out.r.pdfOptions ? out.r.pdfOptions.sectionIds : null });
          };
        };
      }),
    [pid, rg],
  );
}
/** warten, bis der gespeicherte Stand `fn` erfüllt (Speichern ist entprellt) */
async function storedUntil(page, rg, fn, ms = 6000) {
  const t0 = Date.now();
  let v = await storedCounts(page, rg);
  while (!fn(v) && Date.now() - t0 < ms) {
    await wait(200);
    v = await storedCounts(page, rg);
  }
  return v;
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
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    // ======================================================== Desktop 1440 × 900
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs++;
      d.accept();
    });
    await newPortrait(page);
    check('Ansicht wählbar: Verlegen | Material & Einkauf (Verlegen aktiv)', (await page.textContent('[data-testid="plan-view"] button[aria-checked="true"]')).trim() === 'Verlegen', await page.textContent('[data-testid="plan-view"]'));
    check('Verlegen-Ansicht ohne Materialberechnung', !(await page.$('[data-testid="material-calc"]')));

    // ---------- Abschnitt B2, Verlegemodus, Antippen in A1
    await page.click('.section-cell:has-text("B2")');
    await page.click('[data-testid="viewer-fit"]');
    await page.click('text=Verlegemodus');
    await wait(300);
    const p0 = await placed(page);
    await centerCanvas(page);
    const a1 = await cellPoint(page, 10, 10);
    await page.mouse.click(a1.x, a1.y);
    await wait(600);
    const pA1 = await placed(page);
    const ask = (await page.textContent('[data-testid="outside-ask"]').catch(() => '')) || '';
    check('B2 gewählt, Verlegemodus: Antippen in A1 ändert nichts', pA1 === p0, `${p0} → ${pA1}`);
    check('… und fragt „Stein gehört zu Abschnitt A1 – wechseln?“', /gehört zu Abschnitt A1/.test(ask) && /wechseln/.test(ask), ask.trim());
    await page.screenshot({ path: path.join(OUT, 'w4lw-01-outside.png') });
    await page.click('[data-testid="outside-ask"] button[aria-label="Schließen"]');

    // ---------- Farbchips für B2 (offen je Farbe, Summe = Abschnitt)
    const chipsB2 = await page.$$eval('[data-testid="color-chip"]', (els) => els.map((e) => ({ open: +e.dataset.open, total: +e.dataset.total })));
    const chipTotal = chipsB2.reduce((a, c) => a + c.total, 0);
    const b2 = await storedCounts(page, { r0: 42, r1: 84, c0: 34, c1: 67 });
    check('Farbchips B2: Summe der Steine = Steine im Abschnitt (gespeichertes Raster)', chipTotal === b2.total && chipsB2.length > 0, `${chipsB2.length} Farben, ${chipTotal} = ${b2.total}`);
    const sum0 = await page.textContent('[data-testid="chips-sum"]');

    // ---------- Karte „Nächster Stein“: 3× verlegt & weiter, dann Rückgängig
    await page.click('[data-testid="next-open"]');
    await page.waitForSelector('[data-testid="next-card"]');
    await wait(400);
    const id0 = (await page.textContent('[data-testid="next-id"]')).trim();
    const cut0 = (await page.textContent('[data-testid="next-cut"]')).trim();
    const size0 = (await page.textContent('[data-testid="next-size"]')).trim();
    check('Karte zeigt den ersten Stein von B2 (oben links, AQ035) mit Größe und Schnittanweisung', /^AQ035(-1)?/.test(id0) && cut0.length > 10 && /mm/.test(size0), `${id0} | ${size0} | ${cut0.slice(0, 60)}`);
    await page.screenshot({ path: path.join(OUT, 'w4lw-02-card.png') });
    const ids = [id0];
    for (let i = 0; i < 3; i++) {
      await page.click('[data-testid="next-lay"]');
      await wait(250);
      ids.push((await page.textContent('[data-testid="next-id"]')).trim());
    }
    const p3 = await placedBecomes(page, p0 + 3);
    check('3× „✓ verlegt & weiter“: 3 Steine verlegt, Karte geht jeweils weiter', p3 === p0 + 3 && new Set(ids).size === 4, `${p0} → ${p3} · ${ids.join(' → ')}`);
    await page.click('[data-testid="lay-undo"]');
    const pu = await placedBecomes(page, p0 + 2);
    const st = (await page.textContent('[data-testid="lay-status"]')).trim();
    check('Rückgängig: verlegt = 2', pu === p0 + 2, `${p3} → ${pu}`);
    check('Statuszeile nennt den Stein („Rückgängig gemacht: … als verlegt markiert“)', /Rückgängig gemacht: .+ als verlegt markiert/.test(st) && st.includes(ids[2].replace(/\s.*/, '')), st);
    const sum1 = await page.textContent('[data-testid="chips-sum"]');
    check('Farbchips zählen live mit (2 weniger offen)', digits(sum0.split('von')[0]) - digits(sum1.split('von')[0]) === 2, `${sum0} → ${sum1}`);
    const sb2 = await storedUntil(page, { r0: 42, r1: 84, c0: 34, c1: 67 }, (v) => v.placed === 2);
    check('Gespeichert: genau 2 verlegte Steine in B2', sb2.placed === 2, JSON.stringify(sb2));
    // zurück / überspringen
    const before = (await page.textContent('[data-testid="next-id"]')).trim();
    await page.click('[data-testid="next-skip"]');
    await wait(200);
    const skipped = (await page.textContent('[data-testid="next-id"]')).trim();
    await page.click('[data-testid="next-back"]');
    await wait(200);
    const backTo = (await page.textContent('[data-testid="next-id"]')).trim();
    check('überspringen / zurück', skipped !== before && backTo === before && (await placed(page)) === p0 + 2, `${before} → ${skipped} → ${backTo}`);
    // Reihenfolge „Farbe“ und Farbfilter
    await page.click('[data-testid="next-order"] button:has-text("Farbe")');
    await wait(300);
    const rowBtnGone = !(await page.$('[data-testid="next-row"]'));
    await page.click('[data-testid="color-chip"] >> nth=2');
    await wait(400);
    const chipCode = (await page.textContent('[data-testid="color-chip"][aria-pressed="true"] b')).trim();
    const posTxt = (await page.textContent('[data-testid="next-pos"]')).trim();
    const cardColor = (await page.textContent('[data-testid="next-card"] .w4lw-card-idbox .small b')).trim();
    check('Farbe hervorgehoben: Karte zeigt nur Steine dieser Farbe', cardColor === chipCode && posTxt.includes(`nur Farbe ${chipCode}`) && rowBtnGone, `Chip ${chipCode}, Karte ${cardColor} · ${posTxt}`);
    await page.screenshot({ path: path.join(OUT, 'w4lw-03-color-focus.png') });
    await page.click('[data-testid="chips-clear"]');
    await page.click('[data-testid="next-order"] button:has-text("Reihe")');
    await page.click('[data-testid="next-close"]');
    await page.click('[data-testid="viewer-fit"]');
    await wait(300);

    // ---------- Rechteck: genau die Steine des Bereichs
    await page.click('[data-testid="lay-tool"] button:has-text("Rechteck")');
    const rg = { r0: 60, r1: 63, c0: 40, c1: 45 };
    const sr0 = await storedCounts(page, rg);
    const pr0 = await placed(page);
    await centerCanvas(page);
    const ra = await cellPoint(page, rg.r0, rg.c0);
    const rb = await cellPoint(page, rg.r1 - 1, rg.c1 - 1);
    await page.mouse.move(ra.x, ra.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(ra.x + ((rb.x - ra.x) * i) / 8, ra.y + ((rb.y - ra.y) * i) / 8);
    await page.mouse.up();
    await page.waitForSelector('[data-testid="rect-confirm"]');
    const ask2 = (await page.textContent('[data-testid="rect-confirm"]')).trim();
    await page.screenshot({ path: path.join(OUT, 'w4lw-04-rect-confirm.png') });
    const pBeforeConfirm = await placed(page);
    check('Rechteck: Rückfrage mit Bereich und Steinzahl, noch nichts geändert', /^BI041 – BK045: \d+ Steine, davon \d+ schon verlegt/.test(ask2) && pBeforeConfirm === pr0 && digits(ask2.split(':')[1].split('Steine')[0]) === sr0.total, ask2.slice(0, 80));
    await page.click('[data-testid="rect-lay"]');
    const pr1 = await placedBecomes(page, pr0 + (sr0.total - sr0.placed));
    const sr1 = await storedUntil(page, rg, (v) => v.placed === v.total);
    check('Rechteck fügt genau die Steine des Bereichs hinzu (gegen gespeichertes Raster)', pr1 - pr0 === sr0.total - sr0.placed && sr1.placed === sr1.total && sr1.total === sr0.total, `+${pr1 - pr0} = ${sr0.total} − ${sr0.placed}; gespeichert ${sr1.placed}/${sr1.total}`);
    // Rechteck auf dieselben Steine: „wieder offen“ und Abbrechen
    await page.mouse.move(ra.x, ra.y);
    await page.mouse.down();
    await page.mouse.move(rb.x, rb.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForSelector('[data-testid="rect-confirm"]');
    await page.click('[data-testid="rect-cancel"]');
    await wait(200);
    check('Rechteck abbrechen ändert nichts', (await placed(page)) === pr1 && !(await page.$('[data-testid="rect-confirm"]')));

    // ---------- Malen: über eine Reihe ziehen, dann Rückgängig
    await page.click('[data-testid="lay-tool"] button:has-text("Malen")');
    const pm0 = await placed(page);
    await centerCanvas(page);
    const ma = await cellPoint(page, 70, 36);
    const mb = await cellPoint(page, 70, 52);
    await page.mouse.move(ma.x, ma.y);
    await page.mouse.down();
    await page.mouse.move(mb.x, mb.y, { steps: 20 });
    await page.mouse.up();
    await wait(400);
    const pm1 = await placed(page);
    const mst = (await page.textContent('[data-testid="lay-status"]')).trim();
    const mN = digits(mst);
    const sm = await storedUntil(page, { r0: 70, r1: 71, c0: 36, c1: 53 }, (v) => v.placed >= 10);
    check('Malen: Steine einer Reihe als verlegt markiert (Anzahl wie gemeldet)', pm1 - pm0 >= 10 && pm1 - pm0 === mN && sm.placed === pm1 - pm0, `+${pm1 - pm0} · „${mst}“ · gespeichert ${sm.placed}/${sm.total}`);
    await page.click('[data-testid="lay-undo"]');
    check('Malen rückgängig: exakt wie vorher', (await placedBecomes(page, pm0)) === pm0);
    await page.click('[data-testid="lay-tool"] button:has-text("Tippen")');

    // ---------- Abschnitt fertig auf teilweise verlegtem Abschnitt + Rückgängig
    const d0 = dialogs;
    const pf0 = await placed(page);
    await page.click('[data-testid="section-done"]');
    const pf1 = await placedBecomes(page, pf0 + (b2.total - (await storedCounts(page, { r0: 42, r1: 84, c0: 34, c1: 67 })).placed));
    const fst = (await page.textContent('[data-testid="lay-status"]')).trim();
    const sf = await storedUntil(page, { r0: 42, r1: 84, c0: 34, c1: 67 }, (v) => v.placed === v.total);
    check('„Abschnitt fertig“ (teilweise verlegt): ganzer Abschnitt verlegt, Meldung mit Zahlen, rückgängig machbar', sf.placed === sf.total && /B2: alle .* Steine verlegt – .* neu markiert/.test(fst) && dialogs === d0, `${pf0} → ${pf1} · ${fst}`);
    await page.click('[data-testid="lay-undo"]');
    const pf2 = await placedBecomes(page, pf0);
    const sf2 = await storedUntil(page, { r0: 42, r1: 84, c0: 34, c1: 67 }, (v) => v.placed < v.total);
    check('Rückgängig nach „Abschnitt fertig“: exakt der teilweise Stand vorher', pf2 === pf0 && sf2.placed === pf0 - (await storedCounts(page, { r0: 0, r1: 42, c0: 0, c1: 67 })).placed - (await storedCounts(page, { r0: 42, r1: 84, c0: 0, c1: 34 })).placed, `${pf1} → ${pf2}; B2 gespeichert ${sf2.placed}`);
    await page.screenshot({ path: path.join(OUT, 'w4lw-05-plan.png') });

    // ---------- Stein suchen
    await page.fill('[data-testid="find-stone"]', 'ZZ9999');
    await page.press('[data-testid="find-stone"]', 'Enter');
    const nf = ((await page.textContent('[data-testid="find-not-found"]').catch(() => '')) || '').trim();
    check('Suche „ZZ9999“: „Stein „ZZ9999“ nicht gefunden – gültig: A001 bis CF067“', /Stein „ZZ9999“ nicht gefunden – gültig: A001 bis CF067/.test(nf), nf);
    await page.fill('[data-testid="find-stone"]', 'AP034-5');
    await page.press('[data-testid="find-stone"]', 'Enter');
    const nf2 = ((await page.textContent('[data-testid="find-not-found"]').catch(() => '')) || '').trim();
    check('Suche nach nicht vorhandenem Teilstück: Meldung', /AP034 (ist ein ganzer Stein|hat nur \d+ Teilstücke)/.test(nf2), nf2);
    const pfind = await placed(page);
    await page.fill('[data-testid="find-stone"]', 'BA040');
    await page.press('[data-testid="find-stone"]', 'Enter');
    await wait(500);
    const fs1 = (await page.textContent('[data-testid="lay-status"]')).trim();
    const scaleAfterFind = await page.$eval('[data-testid="mosaic-canvas"]', (c) => +c.dataset.scale);
    check('Gefundener Stein wird zentriert/hervorgehoben, im Verlegemodus nicht verlegt', /BA040(-\d)? gefunden/.test(fs1) && (await placed(page)) === pfind && scaleAfterFind >= 7, `${fs1}, Maßstab ${scaleAfterFind}`);

    // außerhalb des Verlegemodus öffnet die Suche das Steindetail (wie Antippen)
    await page.click('text=Verlegemodus');
    await page.fill('[data-testid="find-stone"]', 'BA040');
    await page.press('[data-testid="find-stone"]', 'Enter');
    const dlgId = ((await page.waitForSelector('[data-testid="stone-id"]', { timeout: 5000 }).then((e) => e.textContent()).catch(() => '')) || '').trim();
    check('Suche ohne Verlegemodus öffnet das Steindetail', /^BA040/.test(dlgId) && (await placed(page)) === pfind, dlgId.slice(0, 30));
    await page.keyboard.press('Escape');
    await wait(200);
    await page.click('text=Verlegemodus');

    // ---------- CSV-Fehler sichtbar
    await page.evaluate(() => {
      window.__cou = URL.createObjectURL;
      URL.createObjectURL = () => {
        throw new Error('Testfehler beim Speichern');
      };
    });
    await page.click('[data-testid="csv-all"]');
    const ce = ((await page.waitForSelector('[data-testid="csv-error"]', { timeout: 30000 }).then((e) => e.textContent()).catch(() => '')) || '').trim();
    await page.evaluate(() => (URL.createObjectURL = window.__cou));
    check('CSV-Export: Fehler wird sichtbar gemeldet', /CSV-Export fehlgeschlagen: Testfehler beim Speichern/.test(ce), ce);

    // ---------- Bildschirm wach halten (Zustand wird angezeigt)
    const wake = await page.$eval('[data-testid="wake-note"]', (e) => e.dataset.state).catch(() => 'none');
    check('Verlegemodus: Hinweis zum Wachhalten des Bildschirms (an / nicht unterstützt / abgelehnt)', ['on', 'unsupported', 'denied'].includes(wake), wake);

    // ---------- Gemerkte Auswahl nach dem Neuladen
    await page.click('text=Verlegemodus');
    await page.reload();
    await page.waitForSelector('[data-testid="placed-count"]', { timeout: 60000 });
    await wait(1000);
    const act = ((await page.textContent('.section-cell.active').catch(() => '')) || '').trim();
    check('Nach dem Neuladen: Abschnitt B2 wieder gewählt, Rückgängig leer (nur Sitzung)', act.startsWith('B2') && (await page.isDisabled('[data-testid="lay-undo"]')), `${act}`);

    // ---------- PDF für den Abschnitt
    await page.click('[data-testid="section-pdf"]');
    await page.waitForSelector('[data-testid="pdf-btn"]');
    const pdfSel = await storedUntil(page, null, (v) => Array.isArray(v.pdfSections));
    const chips = await page.$$eval('.btn.chip.primary', (els) => els.map((e) => e.textContent.trim()));
    check('„PDF B2“ öffnet Schritt 10 mit Abschnitt B2', /\/pdf$/.test(page.url()) && JSON.stringify(pdfSel.pdfSections) === '["B2"]' && chips.includes('B2'), `${page.url().split('#')[1]} · ${JSON.stringify(pdfSel.pdfSections)}`);
    await page.click('[data-testid="step-plan"]');
    await page.waitForSelector('[data-testid="plan-view"]');

    // ---------- Material & Einkauf
    await page.click('[data-testid="plan-view"] button:has-text("Material & Einkauf")');
    await page.waitForSelector('[data-testid="material-calc"]');
    await wait(400);
    const ov = await overflow(page);
    const noViewer = !(await page.$('[data-testid="mosaic-canvas"]'));
    const mcW = await page.$eval('[data-testid="material-calc"]', (e) => e.getBoundingClientRect().width);
    check('Material & Einkauf: volle Breite ohne Viewer, kein waagerechtes Scrollen bei 1440 px', ov <= 0 && noViewer && mcW > 1000, `Überlauf ${ov} px, Breite ${Math.round(mcW)} px`);
    await page.screenshot({ path: path.join(OUT, 'w4lw-06-material.png'), fullPage: true });
    await ctx.close();

    // ======================================================== Handy 390 × 844 (Touch)
    const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const pp = await pctx.newPage();
    pp.on('pageerror', (e) => errors.push(String(e)));
    await newPortrait(pp);
    await pp.tap('text=Verlegemodus');
    await wait(300);
    // Malen in der Gesamtansicht (Steine zu klein): Wischen verschiebt nur, markiert nichts
    await pp.tap('[data-testid="lay-tool"] button:has-text("Malen")');
    await pp.$eval('[data-testid="mosaic-canvas"]', (c) => c.scrollIntoView({ block: 'center' }));
    await wait(300);
    const q0 = await placed(pp);
    const cdp = await pctx.newCDPSession(pp);
    const box = await (await pp.$('[data-testid="mosaic-canvas"]')).boundingBox();
    const sx = box.x + box.width / 2;
    const sy = box.y + box.height * 0.7;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy, id: 1 }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx, y: sy - i * 18, id: 1 }] });
      await wait(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait(600);
    check('Handy, Malen bei zu kleinen Steinen: Wischen markiert nichts', (await placed(pp)) === q0, `${q0} → ${await placed(pp)}`);
    await pp.tap('[data-testid="lay-tool"] button:has-text("Tippen")');
    await pp.tap('[data-testid="next-open"]');
    await pp.waitForSelector('[data-testid="next-card"]');
    await wait(600);
    const card = await pp.$eval('[data-testid="next-card"]', (e) => {
      const r = e.getBoundingClientRect();
      const nav = document.querySelector('[data-testid="step-nav"]').getBoundingClientRect();
      return { pos: getComputedStyle(e).position, bottom: Math.round(r.bottom), top: Math.round(r.top), h: Math.round(r.height), navTop: Math.round(nav.top) };
    });
    check('Handy: Karte „Nächster Stein“ klebt unten, direkt über der Schrittnavigation', card.pos === 'sticky' && Math.abs(card.bottom - card.navTop) <= 2 && card.h < 300, JSON.stringify(card));
    // Stein der Karte liegt im sichtbaren Teil des Mosaiks (nicht unter der Karte, nicht unter der Kopfzeile)
    const cid = (await pp.textContent('[data-testid="next-id"]')).trim().replace(/\s.*/, '');
    const m = /^([A-Z]+)(\d+)/.exec(cid);
    let rowIdx = 0;
    for (const ch of m[1]) rowIdx = rowIdx * 26 + (ch.charCodeAt(0) - 64);
    const sp = await cellPoint(pp, rowIdx - 1, parseInt(m[2], 10) - 1);
    const topbar = await pp.$eval('.topbar', (e) => e.getBoundingClientRect().bottom);
    check('Handy: Stein der Karte ist sichtbar (zwischen Kopfzeile und Karte)', sp.y > topbar + 10 && sp.y < card.top - 10 && sp.x > 20 && sp.x < 370, `${cid} bei y ${Math.round(sp.y)} (frei ${Math.round(topbar)}…${card.top})`);
    const q1 = await placed(pp);
    await pp.tap('[data-testid="next-lay"]');
    check('Handy: „✓ verlegt & weiter“ verlegt genau einen Stein', (await placedBecomes(pp, q1 + 1)) === q1 + 1);
    const ovp = await overflow(pp);
    check('Handy: kein waagerechtes Scrollen im Verlegeplan', ovp <= 1, `${ovp} px`);
    await pp.screenshot({ path: path.join(OUT, 'w4lw-07-phone-card.png') });
    await pp.tap('[data-testid="plan-view"] button:has-text("Material & Einkauf")');
    await pp.waitForSelector('[data-testid="material-calc"]');
    await wait(300);
    check('Handy: Material & Einkauf ohne waagerechtes Scrollen', (await overflow(pp)) <= 1, `${await overflow(pp)} px`);
    await pp.screenshot({ path: path.join(OUT, 'w4lw-08-phone-material.png'), fullPage: true });
    await pctx.close();
  } catch (e) {
    check('Ablauf ohne Ausnahme', false, String(e && e.stack ? e.stack : e));
  } finally {
    await browser.close();
  }
  const relevant = errors.filter((e) => !/favicon|Failed to load resource/.test(e));
  check('Keine Fehler in der Konsole', relevant.length === 0, relevant.slice(0, 3).join(' | '));
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} bestanden`);
  fs.writeFileSync(path.join(OUT, 'w4lw-results.json'), JSON.stringify(results, null, 2));
  process.exit(bad.length ? 1 : 0);
})();
