/* Browser-Prüfung der Korrekturen nach der Gegenprüfung von Welle 5 (w5-fix-ui).
 * Voraussetzung: `npm run build` und `npx vite preview --port <port>` laufen.
 * Aufruf: node e2e/w5-fix-ui.e2e.cjs <baseUrl> <outDir>
 *
 * Geprüft wird:
 *  1. Fehlbestand mit Material ohne Bestand: Banner als Teilsumme („nur Materialien mit erfasstem Bestand“) mit
 *     „unvollständig“; CSV-Summenzeile mit Hinweis „Zu kaufen unvollständig“ (DE/EN/TR);
 *  2. Druck „Bedarf je Farbe“: die Summenzeile liegt NICHT über der letzten Farbe (position: static, PDF-Text);
 *  3. Heller/Dunkler: ohne helleren Ton gleichen Farbtons wird die ähnlichste hellere Farbe angeboten (▲, „etwas
 *     anderer Farbton“), Hinweis widerspricht ▲ nicht; Strg+Z nimmt es zurück; „keine hellere Farbe“ nur ohne ▲;
 *  4. Handy: Material & Einkauf kompakt (Bedarf je Farbe/Berechnung zugeklappt, eine Zeile je Farbe), Reserve-
 *     Knöpfe und Ansichtswahl ≥ 44 px, Ansichtswahl unter der Fortschrittskarte;
 *  5. Hinweise je Gerät: Maus „anklicken“/„Mauszeiger“, Finger „antippen“ (DE/EN/TR);
 *  6. Steindetail als Blatt: ↶/↷ beschriftet und ≥ 44 px, Meldung „Rückgängig gemacht“ als Hinweis über dem Blatt;
 *     am Desktop keine doppelten Mini-Knöpfe im Kopf der Seitenleiste.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w5-fix-ui');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info !== '' ? ` – ${info}` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = async (page, sel) => ((await page.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const projectId = (page) => (page.url().match(/#\/project\/([^/]+)/) || [])[1];
const num = (s) => {
  const t = String(s).replace(/[^\d,.\-]/g, '').replace(/\./g, '').replace(',', '.');
  return t === '' || t === '-' ? NaN : parseFloat(t);
};

const MATS = [
  { id: 'e2e-w5fu-a', manufacturer: 'E2E-Glas', product: 'Mit Bestand', colorNumber: 'A-01', colorName: 'Prüfgrau', hex: '#808080', lengthMm: 5, widthMm: 5, price: 7.5, packageSize: 'Beutel 100', piecesPerPack: 100, stock: 10 },
  { id: 'e2e-w5fu-b', manufacturer: 'E2E-Glas', product: 'Ohne Bestand', colorNumber: 'B-02', colorName: 'Prüfblau', hex: '#3060a0', lengthMm: 5, widthMm: 5, price: 12.9, packageSize: '', piecesPerPack: 250 },
].map((m) => ({ type: 'glass', thicknessMm: 4, notes: '', ...m }));

async function putMaterials(page) {
  await page.evaluate(
    (mats) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('mosaicplan');
        req.onsuccess = () => {
          const tx = req.result.transaction('materials', 'readwrite');
          for (const m of mats) tx.objectStore('materials').put(m, m.id);
          tx.oncomplete = () => {
            req.result.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    MATS,
  );
}

/** Palette und Raster aus IndexedDB */
const dbState = (page, id) =>
  page.evaluate(
    (id) =>
      new Promise((res) => {
        const r = indexedDB.open('mosaicplan');
        r.onsuccess = () => {
          const tx = r.result.transaction(['projects', 'mosaics']);
          const out = {};
          tx.objectStore('projects').get(id).onsuccess = (e) => (out.rec = e.target.result);
          tx.objectStore('mosaics').get(id).onsuccess = (e) => (out.m = e.target.result);
          tx.oncomplete = () => {
            r.result.close();
            res({
              palette: out.rec.palette.map((p) => ({ code: p.code, hex: p.hex, lab: p.lab })),
              cols: out.m.cols,
              kind: Array.from(out.m.kind),
              c1: Array.from(out.m.c1),
            });
          };
        };
      }),
    id,
  );

const rowLabel = (i) => {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};
const code2 = (c) => String(c).padStart(2, '0');
const cellIdOf = (st, idx) => `${rowLabel(Math.floor(idx / st.cols))}${String((idx % st.cols) + 1).padStart(3, '0')}`;

/** shadeStep aus core/edits.ts (gleicher Farbton: ΔL* 3…20, Δa*b* ≤ 10, ΔH ≤ 8) */
function strictShade(pal, from, dir) {
  const p = pal[from].lab;
  return pal.some((q, i) => {
    if (i === from) return false;
    const dL = q.lab[0] - p[0];
    const da = q.lab[1] - p[1];
    const db = q.lab[2] - p[2];
    const dC = Math.hypot(q.lab[1], q.lab[2]) - Math.hypot(p[1], p[2]);
    const dab = Math.hypot(da, db);
    const dH = Math.sqrt(Math.max(0, dab * dab - dC * dC));
    if (dir === 'lighter' ? dL < 3 : dL > -3) return false;
    return Math.abs(dL) <= 20 && dab <= 10 && dH <= 8;
  });
}

async function findStone(page, id) {
  if (await page.$('[data-testid="stone-panel"]')) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="find-stone"]');
  }
  await page.fill('[data-testid="find-stone"]', id);
  await page.press('[data-testid="find-stone"]', 'Enter');
  await page.waitForSelector('[data-testid="stone-id"]');
  await wait(300);
}
const activeCode = (page) => page.$eval('[data-testid="color-pick"] button.active small', (e) => e.textContent.trim()).catch(() => null);

async function setLang(page, lang) {
  const opt = lang === 'en' ? 'English' : lang === 'tr' ? 'Türkçe' : 'Deutsch';
  await page.goto(BASE + '#/settings');
  await page.waitForSelector('[data-testid="lang-select"]');
  await page.click(`[data-testid="lang-select"] >> text=${opt}`);
  await wait(300);
}

async function openMaterial(page, pid) {
  await page.goto(`${BASE}#/project/${pid}/plan`);
  await page.waitForSelector('[data-testid="plan-view"]', { timeout: 60000 });
  await page.locator('[data-testid="plan-view"] button').nth(1).click();
  await page.waitForSelector('[data-testid="material-calc"] [data-testid="mc-pieces"]');
  await page.waitForFunction(() => document.querySelector('[data-testid="material-calc"]')?.getAttribute('data-busy') === 'no', null, { timeout: 30000 });
  await wait(400);
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('dialog', (d) => d.accept());
  };
  try {
    // ===================================================================== Desktop 1440 × 900
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE', acceptDownloads: true });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(BASE);
    await page.waitForSelector('[data-testid="sample-portrait"]');
    await putMaterials(page);
    await page.reload();
    await page.click('[data-testid="sample-portrait"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
    await wait(1000);
    const pid = projectId(page);

    // ---------- 5. Hinweise mit der Maus
    const hint = await txt(page, '[data-testid="preview-hint"]');
    const idle = await txt(page, '[data-testid="viewer-status-main"]');
    check('Desktop (Maus): Vorschau-Hinweis sagt „anklicken“, nicht „antippen“', /anklicken/.test(hint) && !/antippen|Antippen|Finger/.test(hint), hint);
    check('Desktop (Maus): Statuszeile „Mauszeiger über einen Stein bewegen“', /Mauszeiger über einen Stein/.test(idle), idle);

    // ---------- 3. Heller/Dunkler
    const st = await dbState(page, pid);
    const pal = st.palette;
    const used = new Set();
    for (let i = 0; i < st.c1.length; i++) if (st.kind[i] === 0) used.add(st.c1[i]);
    const firstFull = (c) => st.c1.findIndex((v, i) => v === c && st.kind[i] === 0);
    // Farbe ohne helleren Ton gleichen Farbtons, aber mit hellerer Farbe (▲) in der Palette
    const fallback = [...used].find((c) => !strictShade(pal, c, 'lighter') && pal.some((q, i) => i !== c && q.lab[0] - pal[c].lab[0] >= 1));
    if (fallback !== undefined) {
      const id = cellIdOf(st, firstFull(fallback));
      await findStone(page, id);
      const b = await page.$eval('[data-testid="shade-lighter"]', (e) => ({ dis: e.disabled, same: e.dataset.sameHue, target: e.dataset.target, text: e.textContent.replace(/\s+/g, ' ').trim() }));
      const shadeHint = await txt(page, '[data-testid="shade-hint"]');
      const tp = pal.find((p) => code2(p.code) === b.target);
      const dL = tp ? tp.lab[0] - pal[fallback].lab[0] : NaN;
      check(
        `Heller auf ${id} (Farbe ${code2(pal[fallback].code)}, kein hellerer Ton gleichen Farbtons): ähnlichste hellere Farbe angeboten, „etwas anderer Farbton“`,
        !b.dis && b.same === 'no' && /etwas anderer Farbton/.test(b.text) && dL >= 1,
        `${b.target} ΔL* ${dL.toFixed(1)} · ${b.text}`,
      );
      check('Hinweis widerspricht ▲ nicht (kein „keine hellere Farbe“, sondern „vorgeschlagen ist die ähnlichste hellere Farbe“)', !/Keine hellere Farbe|Kein hellerer Farbton dieser Farbe/.test(shadeHint) && /ähnlichste hellere Farbe/.test(shadeHint), shadeHint);
      await page.screenshot({ path: path.join(OUT, 'w5fu-03-shade-other-hue.png') });
      const before = await activeCode(page);
      await page.click('[data-testid="shade-lighter"]');
      await wait(300);
      const after = await activeCode(page);
      await page.click('[data-testid="stone-summary"]');
      await page.keyboard.press('Control+z');
      await wait(400);
      const undone = await activeCode(page);
      const status = await txt(page, '[data-testid="history-status"]');
      check('Klick wählt genau diese Farbe, Strg+Z nimmt es zurück (Statuszeile)', after === b.target && undone === before && /Rückgängig gemacht/.test(status), `${before} → ${after} → ${undone} · ${status}`);
    } else check('Testfarbe ohne helleren Ton gleichen Farbtons gefunden', false, 'keine');
    // hellste Farbe: keine hellere → gesperrt, und KEINE Farbe trägt ▲
    const lightest = [...used].sort((a, b) => pal[b].lab[0] - pal[a].lab[0])[0];
    const noneUp = !pal.some((q, i) => i !== lightest && q.lab[0] - pal[lightest].lab[0] >= 1);
    if (noneUp) {
      await findStone(page, cellIdOf(st, firstFull(lightest)));
      if (await page.$('[data-testid="colors-all"]')) await page.click('[data-testid="colors-all"]');
      await wait(200);
      const marks = await page.$$eval('[data-testid="color-pick"] button[data-mark]', (bs) => bs.map((x) => x.dataset.mark));
      const dis = await page.isDisabled('[data-testid="shade-lighter"]');
      const h2 = await txt(page, '[data-testid="shade-hint"]');
      check('Hellste Farbe: „Heller“ gesperrt, „Keine hellere Farbe in der Palette“ – und keine Farbe trägt ▲', dis && /Keine hellere Farbe in der Palette/.test(h2) && !marks.includes('up'), `${h2} · ▲ ${marks.filter((m) => m === 'up').length}`);
    }
    // ---------- 6. Desktop: keine Mini-Knöpfe im Kopf der Seitenleiste
    const panelHist = await page.$('[data-testid="stone-panel"] .w5ue-panel-head [data-testid^="stone-history"]');
    check('Desktop: Seitenleiste ohne doppelte ↶/↷ im Kopf; beschriftete Knöpfe über dem Mosaik', !panelHist && /Rückgängig/.test(await txt(page, '[data-testid="history-undo"]')));
    await page.screenshot({ path: path.join(OUT, 'w5fu-04-desktop-panel.png') });
    await page.keyboard.press('Escape');

    // ---------- Farben zuordnen: 01 → A (Bestand 10), 02 → B (kein Bestand)
    await page.click('[data-testid="step-colors"]');
    await page.waitForSelector('[data-testid="palette-table"]');
    const selects = page.locator('[data-testid="palette-table"] tbody tr select');
    await selects.nth(0).selectOption(MATS[0].id);
    await wait(250);
    await selects.nth(1).selectOption(MATS[1].id);
    await wait(400);

    // ---------- 5. Schritt 9 mit der Maus
    await page.click('[data-testid="step-plan"]');
    await page.waitForSelector('[data-testid="tool-hint"]');
    const th = await page.$eval('[data-testid="tool-hint"]', (e) => ({ t: e.textContent.trim(), p: e.dataset.pointer }));
    const chips = await txt(page, '[data-testid="chips-hint"]');
    check('Desktop: Schritt 9 Hinweise „Anklicken öffnet das Steindetail“, „Anklicken hebt eine Farbe hervor“, ohne „Antippen“/„Finger“', th.p === 'fine' && /^Anklicken öffnet das Steindetail/.test(th.t) && !/Antippen|antippen|Finger/.test(th.t) && /^Anklicken hebt eine Farbe hervor/.test(chips), `${th.t} | ${chips}`);
    const lay = await page.evaluate(() => {
      const sb = document.querySelector('.w4lw .summary-box').getBoundingClientRect();
      const vb = document.querySelector('[data-testid="plan-view"]').getBoundingClientRect();
      return { sbBottom: sb.bottom, vbTop: vb.top, inside: !!document.querySelector('.summary-box [data-testid="plan-view"]') };
    });
    check('Ansichtswahl Verlegen/Material unter der Fortschrittskarte (nicht zwischen Zahlen und Balken)', !lay.inside && lay.vbTop >= lay.sbBottom - 0.5, JSON.stringify(lay));

    // ---------- 1. Fehlbestand (DE)
    await openMaterial(page, pid);
    const sh = await page.evaluate(() => {
      const p = document.querySelector('[data-testid="mc-short-total"]');
      const rowA = document.querySelector('[data-testid="mc-shop-row"][data-material="e2e-w5fu-a"] [data-testid="mc-shop-tobuy"]');
      return {
        text: p ? p.textContent.replace(/\s+/g, ' ').trim() : '',
        complete: p && p.dataset.complete,
        badge: !!(p && p.querySelector('.badge')),
        partial: (document.querySelector('[data-testid="mc-short-partial"]') || {}).textContent || '',
        toBuyA: rowA ? rowA.textContent.trim() : '',
      };
    });
    check(
      'Fehlbestand-Banner: Teilsumme „Zu kaufen bei Materialien mit erfasstem Bestand“ + „unvollständig“ + Hinweis',
      sh.complete === 'no' && /^Zu kaufen bei Materialien mit erfasstem Bestand: [\d.]+ Rohsteine/.test(sh.text) && sh.badge && /unvollständig/.test(sh.text) && /Nicht enthalten: Materialien ohne erfassten Bestand/.test(sh.partial) && !/Insgesamt/.test(sh.text),
      sh.text,
    );
    const partN = (sh.text.match(/: ([\d.]+) Rohsteine/) || [])[1];
    check('Teilsumme = zu kaufen bei Material A (B ohne Bestand nicht mitgezählt)', num(partN) === num(sh.toBuyA) && num(partN) > 0, `${partN} = ${sh.toBuyA}`);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('[data-testid="mc-csv"]')]);
    const csvPath = path.join(OUT, 'einkaufsliste-de.csv');
    await dl.saveAs(csvPath);
    const lines = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '').trim().split(/\r\n/);
    const head = lines[0].split(';');
    const sum = lines[lines.length - 1].split(';');
    const note = sum[head.indexOf('Hinweis')] || '';
    check('CSV-Summenzeile: „Zu kaufen unvollständig – Bestand nicht für alle Materialien erfasst“', /Zu kaufen unvollständig – Bestand nicht für alle Materialien erfasst/.test(note) && num(sum[head.indexOf('Zu kaufen')]) === num(sh.toBuyA), note);
    await page.screenshot({ path: path.join(OUT, 'w5fu-01-desktop-material-de.png'), fullPage: true });

    // ---------- 2. Druck: Summenzeile „Bedarf je Farbe“ nicht über der letzten Farbe
    await page.emulateMedia({ media: 'print' });
    await wait(200);
    const pr = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="mc-per-color"]');
      const rows = t.querySelectorAll('tbody tr');
      const last = rows[rows.length - 1];
      const th = t.querySelector('tfoot th');
      const thead = t.querySelector('thead th');
      return {
        lastBottom: last.getBoundingClientRect().bottom,
        sumTop: th.getBoundingClientRect().top,
        pos: getComputedStyle(th).position,
        headPos: getComputedStyle(thead).position,
        lastCode: last.querySelector('[data-col="code"]').textContent.trim(),
      };
    });
    check('Druck: Kopf- und Summenzellen nicht klebend, „Summe“ unter der letzten Farbe', pr.pos === 'static' && pr.headPos === 'static' && pr.sumTop >= pr.lastBottom - 0.5, JSON.stringify(pr));
    const pdfPath = path.join(OUT, 'w5fu-print.pdf');
    await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
    try {
      const text = execFileSync('pdftotext', ['-layout', pdfPath, '-']).toString();
      const tl = text.split('\n');
      const iHead = tl.findIndex((l) => /Bedarf je Farbe/.test(l));
      const after = tl.slice(iHead + 1);
      const iSum = after.findIndex((l) => /^\s*Summe\b/.test(l));
      const lastLine = after.slice(0, iSum).reverse().find((l) => l.trim());
      const iLast = after.findIndex((l) => new RegExp(`^\\s*${pr.lastCode}\\s`).test(l));
      check('Druck-PDF: Zeile der letzten Farbe vollständig, „Summe“ in eigener Zeile darunter', iHead >= 0 && iSum > 0 && iLast >= 0 && iLast < iSum && !/Summe/.test(after[iLast]), `${(lastLine || '').trim().slice(0, 70)} | ${(after[iSum] || '').trim().slice(0, 60)}`);
      execFileSync('pdftoppm', ['-png', '-r', '60', pdfPath, path.join(OUT, 'w5fu-print')]);
    } catch (e) {
      check('Druck-PDF lesbar (pdftotext)', false, String(e).slice(0, 160));
    }
    await page.emulateMedia({ media: 'screen' });

    // ---------- 7. Abschnittsauswahl (PDF): Verb je Gerät, Verhalten bei „Alle“ erklärt
    await page.goto(`${BASE}#/project/${pid}/pdf`);
    await page.waitForSelector('[data-testid="sec-hint"]', { timeout: 60000 });
    const secHint = await txt(page, '[data-testid="sec-hint"]');
    check('Desktop: Abschnittsauswahl „Abschnitt anklicken … (sind alle gewählt, wird nur dieser gewählt)“', /^Abschnitt anklicken: an- oder abwählen \(sind alle gewählt, wird nur dieser gewählt\)/.test(secHint) && !/antippen/.test(secHint), secHint);

    // ---------- EN / TR: Banner und CSV-Hinweis
    for (const [lang, re, csvRe, D] of [
      ['en', /^To buy for materials with recorded stock: [\d,]+ raw tiles/, /to buy incomplete – stock not recorded for every material/, ','],
      ['tr', /^Stoku kayıtlı malzemeler için alınacak: [\d.]+ ham taş/, /alınacak eksik – stok her malzeme için kayıtlı değil/, ';'],
    ]) {
      await setLang(page, lang);
      await openMaterial(page, pid);
      const t2 = await txt(page, '[data-testid="mc-short-total"]');
      const body = await page.evaluate(() => document.body.innerText);
      const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('[data-testid="mc-csv"]')]);
      const p2 = path.join(OUT, `einkaufsliste-${lang}.csv`);
      await dl2.saveAs(p2);
      const ls = fs.readFileSync(p2, 'utf8').trim().split(/\r\n/);
      const lastNote = ls[ls.length - 1];
      check(`${lang.toUpperCase()}: Teilsumme im Banner, CSV-Hinweis, keine fehlenden Schlüssel`, re.test(t2) && csvRe.test(lastNote) && !/w5fu\.|w5ms\./.test(body) && lastNote.split(D).length >= 21, t2.slice(0, 80));
      await page.screenshot({ path: path.join(OUT, `w5fu-01-desktop-material-${lang}.png`) });
      await page.click('[data-testid="plan-view"] button >> nth=0');
      await page.waitForSelector('[data-testid="tool-hint"]');
      const th2 = await txt(page, '[data-testid="tool-hint"]');
      check(`${lang.toUpperCase()}: Schritt 9 Hinweis mit der Maus („click“/„tıkla“)`, lang === 'en' ? /^Clicking opens the tile details/.test(th2) && !/[Tt]ap/.test(th2) : /^Tıklamak taş ayrıntısını açar/.test(th2) && !/dokun/i.test(th2), th2);
      await page.goto(`${BASE}#/project/${pid}/preview`);
      await page.waitForSelector('[data-testid="find-stone"]');
      await findStone(page, 'AI034');
      await page.screenshot({ path: path.join(OUT, `w5fu-04-desktop-panel-${lang}.png`) });
      await page.keyboard.press('Escape');
    }
    await setLang(page, 'de');
    await ctx.close();

    // ===================================================================== Handy 390 × 844 (Finger)
    for (const lang of ['de', 'en', 'tr']) {
      const pc = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'de-DE' });
      const pp = await pc.newPage();
      watch(pp);
      await pp.goto(BASE);
      if (lang !== 'de') {
        await pp.evaluate((l) => localStorage.setItem('mosaicplan.lang', l), lang).catch(() => {});
        await setLang(pp, lang);
        await pp.goto(BASE);
      }
      await pp.waitForSelector('[data-testid="sample-portrait"]');
      await pp.tap('[data-testid="sample-portrait"]');
      await pp.waitForSelector('[data-testid="compute-btn"]');
      await pp.tap('[data-testid="compute-btn"]');
      await pp.waitForSelector('[data-testid="find-stone"]', { timeout: 180000 });
      await wait(1200);
      const ppid = projectId(pp);
      const L = lang.toUpperCase();
      const ph = await txt(pp, '[data-testid="preview-hint"]');
      const pidle = await pp.$eval('[data-testid="viewer-status-main"]', (e) => e.textContent.trim()).catch(() => '');
      const re =
        lang === 'de'
          ? [/Kleine Steine: erstes Antippen vergrößert, zweites öffnet das Steindetail/, /Mauszeiger|anklicken|Mausrad/]
          : lang === 'en'
            ? [/Small tiles: the first tap zooms in, the second opens the tile details/, /pointer|click|mouse/i]
            : [/Küçük taşlar: ilk dokunuş yakınlaştırır/, /İşaretçi|tıkla|fare/i];
      check(`Handy ${L}: Vorschau-Hinweis „antippen“, kein Maus-Text (auch nicht in der verborgenen Statuszeile)`, re[0].test(ph) && !re[1].test(ph) && !re[1].test(pidle), `${ph} | ${pidle}`);

      // ---------- 6. Blatt: ↶/↷ beschriftet, Meldung über dem Blatt
      await pp.fill('[data-testid="find-stone"]', 'AI034');
      await pp.press('[data-testid="find-stone"]', 'Enter');
      await pp.waitForSelector('.modal [data-testid="stone-id"]');
      await wait(400);
      const c0 = await activeCode(pp);
      await pp.tap('[data-testid="color-pick"] button:not(.active) >> nth=0');
      await wait(300);
      const c1 = await activeCode(pp);
      await pp.tap('[data-testid="stone-history-undo"]');
      await wait(350);
      const c2 = await activeCode(pp);
      const sheet = await pp.evaluate(() => {
        const b = (id) => {
          const e = document.querySelector(`[data-testid="${id}"]`);
          const r = e.getBoundingClientRect();
          const lbl = e.querySelector('.w5ue-btxt');
          const lr = lbl.getBoundingClientRect();
          return { h: Math.round(r.height), w: Math.round(r.width), label: lbl.textContent.trim(), labelVisible: lr.width > 10 && lr.height > 5 && getComputedStyle(lbl).clip === 'auto', inside: r.right <= innerWidth && r.left >= 0 };
        };
        const toast = document.querySelector('[data-testid="stone-history-status"]');
        const tr = toast.getBoundingClientRect();
        const cs = getComputedStyle(toast);
        const modal = document.querySelector('.modal');
        return {
          undo: b('stone-history-undo'),
          redo: b('stone-history-redo'),
          toast: { text: toast.textContent.trim(), visible: cs.visibility === 'visible' && cs.opacity === '1' && tr.height > 10, inModal: modal.contains(toast), top: Math.round(tr.top), bottom: Math.round(tr.bottom), vh: innerHeight, modalTop: Math.round(modal.getBoundingClientRect().top) },
        };
      });
      const undoWord = lang === 'de' ? 'Rückgängig' : lang === 'en' ? 'Undo' : 'Geri al';
      const redoWord = lang === 'de' ? 'Wiederholen' : lang === 'en' ? 'Redo' : 'Yinele';
      check(
        `Handy ${L}: ↶/↷ im Blatt mit sichtbarer Beschriftung („${undoWord}“/„${redoWord}“), ≥ 44 px hoch`,
        sheet.undo.label === undoWord && sheet.redo.label === redoWord && sheet.undo.labelVisible && sheet.redo.labelVisible && sheet.undo.h >= 44 && sheet.redo.h >= 44 && sheet.undo.inside && sheet.redo.inside,
        JSON.stringify([sheet.undo, sheet.redo]),
      );
      const undoneRe = lang === 'de' ? /^Rückgängig gemacht: AI034/ : lang === 'en' ? /^Undone: AI034/ : /^Geri alındı: AI034/;
      check(`Handy ${L}: Farbe antippen → ↶ nimmt zurück; Meldung sichtbar als Hinweis über dem Blatt (nicht hinter dem Hintergrund)`, c1 !== c0 && c2 === c0 && undoneRe.test(sheet.toast.text) && sheet.toast.visible && sheet.toast.inModal && sheet.toast.top >= 0 && sheet.toast.bottom <= sheet.toast.modalTop + 1, `${c0} → ${c1} → ${c2} · ${JSON.stringify(sheet.toast)}`);
      await pp.screenshot({ path: path.join(OUT, `w5fu-06-phone-sheet-undo-${lang}.png`) });
      await pp.tap('[data-testid="modal-close"]');
      await wait(300);

      // ---------- Schritt 9 mit dem Finger
      await pp.goto(`${BASE}#/project/${ppid}/plan`);
      await pp.waitForSelector('[data-testid="tool-hint"]', { timeout: 60000 });
      await wait(300);
      const th3 = await pp.$eval('[data-testid="tool-hint"]', (e) => ({ t: e.textContent.trim(), p: e.dataset.pointer }));
      const thRe = lang === 'de' ? /^Antippen öffnet das Steindetail\..*Kleine Steine: erstes Antippen vergrößert, zweites öffnet das Steindetail\.$/ : lang === 'en' ? /^Tapping opens the tile details\..*Small tiles: the first tap zooms in/ : /^Dokunmak taş ayrıntısını açar\..*Küçük taşlar: ilk dokunuş yakınlaştırır/;
      check(`Handy ${L}: Schritt 9 Hinweis „antippen“, kurz („Kleine Steine: erstes Antippen vergrößert …“)`, th3.p === 'coarse' && thRe.test(th3.t) && !/Jetzt öffnet|mit dem Finger zoomt/.test(th3.t), th3.t);
      if (lang === 'de') check('Handy: Farbchips „Antippen hebt eine Farbe hervor“', /^Antippen hebt eine Farbe hervor/.test(await txt(pp, '[data-testid="chips-hint"]')));
      const vb = await pp.evaluate(() => {
        const sb = document.querySelector('.w4lw .summary-box').getBoundingClientRect();
        const btns = [...document.querySelectorAll('[data-testid="plan-view"] button')].map((b) => Math.round(b.getBoundingClientRect().height));
        const v = document.querySelector('[data-testid="plan-view"]').getBoundingClientRect();
        return { below: v.top >= sb.bottom - 0.5, btns, full: Math.round(v.width) };
      });
      check(`Handy ${L}: Ansichtswahl unter der Fortschrittskarte, Knöpfe ≥ 44 px`, vb.below && vb.btns.every((h) => h >= 44), JSON.stringify(vb));
      await pp.screenshot({ path: path.join(OUT, `w5fu-05-phone-plan-${lang}.png`) });

      // Abschnittsauswahl (PDF) – vor dem ersten Ganzseiten-Bildschirmfoto: Playwright setzt dabei die
      // Touch-Emulation zurück, danach meldet '(pointer: coarse)' false
      if (lang === 'de') {
        await pp.goto(`${BASE}#/project/${ppid}/pdf`);
        await pp.waitForSelector('[data-testid="sec-hint"]', { timeout: 60000 });
        const sh2 = await txt(pp, '[data-testid="sec-hint"]');
        check('Handy: Abschnittsauswahl „Abschnitt antippen …“', /^Abschnitt antippen: an- oder abwählen/.test(sh2) && !/anklicken/.test(sh2), sh2);
        await pp.goto(`${BASE}#/project/${ppid}/plan`);
        await pp.waitForSelector('[data-testid="plan-view"]', { timeout: 60000 });
      }

      // ---------- 4. Material & Einkauf kompakt
      await pp.locator('[data-testid="plan-view"] button').nth(1).tap();
      await pp.waitForSelector('[data-testid="material-calc"] [data-testid="mc-pieces"]');
      await pp.waitForFunction(() => document.querySelector('[data-testid="material-calc"]')?.getAttribute('data-busy') === 'no', null, { timeout: 30000 });
      await wait(400);
      const m0 = await pp.evaluate(() => ({
        h: document.documentElement.scrollHeight,
        colorsOpen: document.querySelector('[data-testid="mc-per-color-sec"]').open,
        detailsOpen: document.querySelector('[data-testid="mc-details-sec"]').open,
        chips: [...document.querySelectorAll('.w5ms-reserve .btn.chip')].map((b) => Math.round(b.getBoundingClientRect().height)),
        over: document.documentElement.scrollWidth - innerWidth,
      }));
      check(`Handy ${L}: „Bedarf je Farbe“ und „Berechnung im Detail“ anfangs zugeklappt, Seite kurz, Reserve-Knöpfe ≥ 44 px`, !m0.colorsOpen && !m0.detailsOpen && m0.h < 5000 && m0.chips.length === 4 && m0.chips.every((h) => h >= 44) && m0.over <= 1, JSON.stringify(m0));
      await pp.screenshot({ path: path.join(OUT, `w5fu-02-phone-material-${lang}.png`), fullPage: true });
      await pp.tap('[data-testid="mc-per-color-sec"] > summary');
      await wait(300);
      const m1 = await pp.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid="mc-color-row"]')];
        const hs = rows.map((r) => r.getBoundingClientRect().height);
        const r0 = rows[0];
        const cell = (c) => r0.querySelector(`[data-col="${c}"]`).getBoundingClientRect();
        return {
          n: rows.length,
          maxH: Math.round(Math.max(...hs)),
          total: Math.round(hs.reduce((a, b) => a + b, 0)),
          oneLine: Math.abs(cell('code').top - cell('name').top) < 4 && Math.abs(cell('name').top - cell('rawWithReserve').top) < 4,
          sum: (document.querySelector('[data-testid="mc-color-sum-reserve"]') || {}).textContent,
          over: document.documentElement.scrollWidth - innerWidth,
          h: document.documentElement.scrollHeight,
        };
      });
      check(`Handy ${L}: aufgeklappt eine kompakte Zeile je Farbe (Nr., Name, Bedarf nebeneinander, darunter die Zahlen, ≤ 64 px statt ~118 px)`, m1.n > 10 && m1.maxH <= 64 && m1.oneLine && m1.over <= 1 && !!m1.sum, JSON.stringify(m1));
      await pp.locator('[data-testid="mc-per-color-sec"]').scrollIntoViewIfNeeded();
      await pp.screenshot({ path: path.join(OUT, `w5fu-02b-phone-colors-${lang}.png`) });

      await pc.close();
    }
  } catch (e) {
    check('Ablauf ohne Ausnahme', false, String(e && e.stack ? e.stack : e).slice(0, 600));
  } finally {
    check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})();
