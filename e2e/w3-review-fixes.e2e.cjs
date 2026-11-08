/* Browser-Test der Korrekturen nach dem Review von Welle 3:
 *  - Schritt 7 mit passender Vorschau: Kopftext ohne „kann einige Minuten dauern“, Schritt 8 „noch nicht gespeichert“
 *  - „Foto zeigen (gedrückt halten)“: Schrift bleibt beim Halten mit der Maus lesbar
 *  - Schritt 7 nach einer Änderung: gespeichertes Ergebnis grau als „Letzte Berechnung …“, beide Tabellen gleiche Zeilen
 *  - Live-Vorschau: Hinweis passend zum Stand (nie „aktuelle Einstellungen“ bei veraltetem Bild), abgedunkelt auch
 *    bei ungültigen Eingaben
 *  - Materialien nach der Berechnung geändert: kein „entspricht den aktuellen Einstellungen“, Vorschau rechnet
 *  - Freiformstein mit überlappenden Teilen (älteres Projekt): Hinweis mit Stein, Flächen „nicht berechenbar“, PDF verweigert
 *  - „Abbrechen“ in einem anderen Projekt während des Speicherns gesperrt (nicht „abgebrochen“ und doch gespeichert)
 *  - Handy (360 px): Ampel der Gesichtsbreite nicht allein in einer Zeile; Kantenlängen im Freiform-Editor nicht abgeschnitten
 * Aufruf: node e2e/w3-review-fixes.e2e.cjs <baseUrl> <outDir>
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'out-w3-review-fixes');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

const projectId = (page) => page.evaluate(() => location.hash.split('/')[2]);
const goHash = (page, h) => page.evaluate((x) => (location.hash = x), h);
const lpInfo = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="live-preview"]');
    if (!el) return null;
    const note = el.querySelector('[data-testid="live-preview-note"]');
    const stage = el.querySelector('[data-testid="live-preview-stage"]');
    return {
      state: el.dataset.state,
      kind: el.dataset.kind,
      current: el.dataset.current,
      noteKind: note && note.dataset.kind,
      note: note ? note.textContent : '',
      dim: !!stage && stage.classList.contains('w3lp-dim'),
      outdated: (el.querySelector('[data-testid="live-preview-outdated"]') || {}).textContent || '',
      badge: (el.querySelector('[data-testid="live-preview-badge"]') || {}).textContent || '',
    };
  });

function idbTx(page, fn, arg) {
  return page.evaluate(
    ([src, arg]) =>
      new Promise((res, rej) => {
        const r = indexedDB.open('mosaicplan');
        r.onsuccess = () => {
          const db = r.result;
          // eslint-disable-next-line no-new-func
          const f = new Function('db', 'arg', 'done', 'fail', src);
          f(db, arg, (v) => {
            db.close();
            res(v);
          }, (e) => {
            db.close();
            rej(e);
          });
        };
        r.onerror = () => rej(r.error);
      }),
    [fn, arg],
  );
}

async function computeAndWait(page) {
  await page.click('[data-testid="compute-btn"]');
  const g = await page.waitForSelector('[data-testid="guard-nobackup"]', { timeout: 1500 }).catch(() => null);
  if (g) await g.click();
  await page.waitForFunction(() => location.hash.endsWith('/preview'), null, { timeout: 180000 });
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 60000 });
  await page.waitForTimeout(800);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    const orig = Worker.prototype.postMessage;
    window.__computeMsgs = 0;
    Worker.prototype.postMessage = function (msg, ...rest) {
      if (msg && msg.type === 'compute') window.__computeMsgs++;
      return orig.call(this, msg, ...rest);
    };
    // Miniatur-Kodierung auf Wunsch verzögern (hält die Phase „Ergebnis speichern“ offen)
    const tb = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, ...rest) {
      const d = window.__slowBlob || 0;
      return tb.call(this, (b) => setTimeout(() => cb(b), d), ...rest);
    };
    if (window.OffscreenCanvas) {
      const oc = OffscreenCanvas.prototype.convertToBlob;
      OffscreenCanvas.prototype.convertToBlob = function (...a) {
        const d = window.__slowBlob || 0;
        return oc.apply(this, a).then((b) => new Promise((r) => setTimeout(() => r(b), d)));
      };
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const computeMsgs = () => page.evaluate(() => window.__computeMsgs);

  // Materialien anlegen (für „Meine Steine – alle Farben“)
  await page.goto(BASE);
  await page.waitForSelector('[data-testid="sample-portrait"]');
  await idbTx(
    page,
    `const tx = db.transaction('materials', 'readwrite'); const st = tx.objectStore('materials');
     const hexes = ['#202020','#505050','#808080','#B0B0B0','#E8E8E8','#8B4513','#D2A679','#F1C9A5','#E0AC8A','#C68642','#7A3E1D','#3B5998','#6FA8DC','#A9C6E8','#2E7D32','#9CCC65','#C62828','#EF9A9A','#FDD835','#FFF59D'];
     hexes.forEach((h, i) => st.put({ id: 'rf' + i, type: 'glass', manufacturer: 'Test', product: 'Glas', colorNumber: String(100 + i), colorName: 'Farbe ' + i, hex: h, lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 5, packageSize: '', piecesPerPack: 100, stock: 0 }, 'rf' + i));
     tx.oncomplete = () => done(); tx.onerror = () => fail(tx.error);`,
  );
  await page.reload();
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  const pid = await projectId(page);

  // ---------- 1. Schritt 7 mit passender Vorschau, Schritt 8 „noch nicht gespeichert“
  await goHash(page, `#/project/${pid}/compute`);
  await page.waitForSelector('[data-testid="live-preview"][data-state="ready"][data-current="1"]', { timeout: 90000 });
  await page.waitForSelector('[data-testid="compute-btn"][data-mode="commit"]', { timeout: 10000 });
  const intro = await page.textContent('[data-testid="step-intro"]');
  check('Schritt 7 mit passender Vorschau: Kopftext „speichert sie sofort“ statt „kann einige Minuten dauern“', /sofort/.test(intro) && !/Minuten/.test(intro), intro.trim().slice(0, 100));
  const s8 = await page.$eval('[data-testid="step-preview"]', (b) => ({ title: b.title, unc: b.dataset.uncommitted, sr: (b.querySelector('.w2ws-sr') || {}).textContent || '' }));
  check('Schritt 8 vor dem Speichern: „Noch nicht gespeichert – Vorschau in Schritt 7 übernehmen“ (nicht „noch nicht berechnet“)', s8.unc === '1' && /Noch nicht gespeichert/.test(s8.title) && !/berechnet/.test(s8.title) && /Noch nicht gespeichert/.test(s8.sr), s8.title);
  const n1 = await lpInfo(page);
  check('Aktuelle Vorschau: Hinweis „exakte Berechnung … aktuellen Einstellungen“, gespeichert erst mit Übernehmen oder Schritt 8', n1.noteKind === 'current' && /Schritt 8/.test(n1.note), n1.note);
  await page.screenshot({ path: path.join(OUT, '01-compute-commit.png') });
  await computeAndWait(page);

  // ---------- 2. „Foto zeigen (gedrückt halten)“ mit der Maus: Schrift lesbar
  const hold = page.locator('[data-testid="compare-hold"]');
  await hold.scrollIntoViewIfNeeded();
  const hb = await hold.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(400);
  const held = await hold.evaluate((el) => {
    const s = getComputedStyle(el);
    return { pressed: el.getAttribute('aria-pressed'), hover: el.matches(':hover'), bg: s.backgroundColor, color: s.color };
  });
  await page.screenshot({ path: path.join(OUT, '02-hold-mouse.png'), clip: { x: hb.x - 10, y: hb.y - 10, width: hb.width + 20, height: hb.height + 20 } });
  await page.mouse.up();
  check('„Foto zeigen“ mit der Maus gehalten: Hintergrund ≠ Schriftfarbe (Akzentfarbe, nicht Hover-Weiß)', held.pressed === 'true' && held.hover && held.bg !== held.color && held.bg !== 'rgb(250, 248, 244)', JSON.stringify(held));

  // ---------- 3. Schritt 7 nach einer Änderung: zwei vergleichbare Ergebnisse, gespeichertes als „Letzte Berechnung“
  await page.click('[data-testid="step-tiles"]');
  await page.click('[data-testid="tile-presets"] button:has-text("8 × 8 mm")');
  await page.waitForTimeout(500);
  await page.click('[data-testid="step-compute"]');
  await page.waitForSelector('[data-testid="preview-diagnostics"]', { timeout: 90000 });
  const tables = await page.evaluate(() => {
    const rows = (sel) => [...document.querySelectorAll(`${sel} tr`)].map((r) => r.querySelector('th').textContent);
    const b = document.querySelector('[data-testid="saved-result-badge"]');
    return { saved: rows('[data-testid="diagnostics"]'), pv: rows('[data-testid="preview-diagnostics"]'), kind: b && b.dataset.kind, cls: b && b.className, text: b && b.textContent };
  });
  check('Gespeichertes, veraltetes Ergebnis: graues Kennzeichen „Letzte Berechnung – Einstellungen seitdem geändert“', tables.kind === 'committed-old' && /w3lp-badge-old/.test(tables.cls) && /Letzte Berechnung/.test(tables.text), `${tables.kind} · ${tables.text}`);
  check('Ergebnis gespeichert/Vorschau: gleiche Zeilen (inkl. 95 % und Formempfehlung)', tables.saved.length >= 6 && JSON.stringify(tables.saved) === JSON.stringify(tables.pv), tables.pv.join(' | '));
  const pvRating = await page.textContent('[data-testid="preview-mean-de"]');
  check('Vorschau-Tabelle: Bewertung der Farbabweichung (CIEDE2000) wie beim gespeicherten Ergebnis', /–/.test(pvRating), pvRating.trim());
  await page.screenshot({ path: path.join(OUT, '03-compute-two-results.png'), fullPage: true });

  // ---------- 4. Großes Mosaik (nur auf Knopfdruck): Hinweis nennt keine „aktuellen Einstellungen“
  await page.click('[data-testid="step-tiles"]');
  await page.fill('[data-testid="tile-w"]', '1');
  await page.fill('[data-testid="tile-h"]', '1');
  await page.locator('[data-testid="tile-h"]').blur();
  await page.waitForSelector('[data-testid="live-preview"][data-state="manual"]', { timeout: 20000 });
  const m4 = await lpInfo(page);
  check('Veraltetes Bild (große Mosaike, manuell): Hinweis ohne „aktuellen Einstellungen“, Bild abgedunkelt', m4.current === '0' && m4.dim && (m4.noteKind === 'outdated' || m4.noteKind === 'committedOld') && !/aktuellen Einstellungen/.test(m4.note), `${m4.kind}/${m4.noteKind}: ${m4.note}`);
  await page.screenshot({ path: path.join(OUT, '04-manual-outdated.png') });
  await page.click('[data-testid="tile-presets"] button:has-text("5 × 5 mm")');
  await page.waitForTimeout(600);

  // ---------- 5. Ungültige Eingabe: altes Bild abgedunkelt, „Keine gültige Vorschau“
  await page.click('[data-testid="step-size"]');
  await page.waitForTimeout(600);
  const widthInput = page.locator('.w3lp-main input[type="text"], .w3lp-main input[inputmode], .w3lp-main input[type="number"]').first();
  const oldWidth = await widthInput.inputValue();
  await widthInput.click({ clickCount: 3 });
  await widthInput.type('0,1');
  await widthInput.press('Tab');
  await page.waitForSelector('[data-testid="live-preview"][data-state="input"]', { timeout: 10000 });
  const m5 = await lpInfo(page);
  check('Ungültige Maße: Bild abgedunkelt, „Keine gültige Vorschau“, kein „aktuelle Einstellungen“', m5.current === '0' && m5.dim && /Keine gültige Vorschau/.test(m5.outdated) && !/aktuellen Einstellungen/.test(m5.note), `${m5.outdated} · ${m5.note}`);
  await page.screenshot({ path: path.join(OUT, '05-input-error-dim.png') });
  await widthInput.click({ clickCount: 3 });
  await widthInput.type(oldWidth);
  await widthInput.press('Tab');
  await page.waitForTimeout(800);

  // ---------- 6. Materialien nach der Berechnung geändert
  await goHash(page, `#/project/${pid}/colors`);
  await page.waitForSelector('[data-testid="palette-mode"]');
  await page.click('[data-testid="palette-mode"] >> text=Meine Steine – alle Farben');
  await page.waitForTimeout(500);
  await goHash(page, `#/project/${pid}/compute`);
  await page.waitForSelector('[data-testid="compute-btn"]');
  await computeAndWait(page);
  const pal = await idbTx(page, `const g = db.transaction('projects').objectStore('projects').get(arg); g.onsuccess = () => done(g.result.palette.map((p) => p.materialId));`, pid);
  await idbTx(
    page,
    `const tx = db.transaction('materials', 'readwrite'); const st = tx.objectStore('materials'); const g = st.get(arg);
     g.onsuccess = () => { const m = g.result; m.hex = '#00FF00'; st.put(m, arg); }; tx.oncomplete = () => done();`,
    pal[0],
  );
  await page.reload();
  await page.waitForSelector('[data-testid="materials-changed-badge"]', { timeout: 20000 });
  const before6 = await computeMsgs();
  await goHash(page, `#/project/${pid}/colors`);
  await page.waitForSelector('[data-testid="live-preview"]');
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="live-preview"]');
    return el && el.dataset.kind === 'preview' && el.dataset.current === '1';
  }, null, { timeout: 90000 });
  const m6 = await lpInfo(page);
  const after6 = await computeMsgs();
  check('Material umgefärbt: Vorschau rechnet die neue Auswahl, kein „Übernommenes Mosaik … entspricht …“', after6 > before6 && m6.kind === 'preview' && !/Übernommenes Mosaik/.test(m6.badge), `${before6}→${after6} ${m6.kind} ${m6.badge}`);
  await goHash(page, `#/project/${pid}/compute`);
  await page.waitForSelector('[data-testid="materials-changed"]');
  const mc = await page.textContent('[data-testid="materials-changed"]');
  const mode6 = await page.getAttribute('[data-testid="compute-btn"]', 'data-mode');
  check('Schritt 7: Hinweis „Materialien … geändert“ und „Vorschau übernehmen“ möglich', /Materialien wurden seit der Berechnung geändert/.test(mc) && mode6 === 'commit', mode6);
  await page.screenshot({ path: path.join(OUT, '06-materials-changed.png'), fullPage: true });
  await computeAndWait(page);
  check('Nach dem Übernehmen: kein Hinweis „Materialien geändert“ mehr', !(await page.$('[data-testid="materials-changed-badge"]')));

  // ---------- 7. Freiformstein mit überlappenden Teilen (wie in älteren Projekten gespeichert)
  await idbTx(
    page,
    `const tx = db.transaction('mosaics', 'readwrite'); const st = tx.objectStore('mosaics'); const g = st.get(arg);
     g.onsuccess = () => { const m = g.result; m.kind[0] = 5; m.free = (m.free || []).filter((e) => e[0] !== 0);
       m.free.push([0, [{ poly: [[0, 0], [5, 0], [5, 3], [0, 3]], color: 0 }, { poly: [[0, 2], [5, 2], [5, 5], [0, 5]], color: 1 }]]);
       m.progress = m.progress; st.put(m, arg); };
     tx.oncomplete = () => done(); tx.onerror = () => fail(tx.error);`,
    pid,
  );
  await page.reload();
  await page.waitForSelector('[data-testid="free-invalid-banner"]', { timeout: 20000 });
  const banner = await page.textContent('[data-testid="free-invalid-banner"]');
  check('Älteres Projekt mit überlappendem Freiformstein: Hinweis im Projektkopf mit Stein A001', /Ein Freiform-Stein hat ungültige Teile/.test(banner) && /A001/.test(banner), banner.slice(0, 120));
  await page.click('[data-testid="free-invalid-open"]');
  await page.waitForSelector('[data-testid="stone-id"]', { timeout: 15000 });
  const sid = await page.textContent('[data-testid="stone-id"]');
  check('Klick auf A001 öffnet das Steindetail in Schritt 8', /A001/.test(sid), sid.trim().slice(0, 30));
  await page.screenshot({ path: path.join(OUT, '07-free-invalid-stone.png') });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await goHash(page, `#/project/${pid}/plan`);
  await page.waitForSelector('text=Material >> nth=-1');
  await page.click('text=Material >> nth=-1');
  await page.waitForSelector('[data-testid="mc-area-joints"]', { timeout: 30000 });
  await page.waitForFunction(() => /nicht berechenbar/.test(document.querySelector('[data-testid="mc-area-joints"]')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
  const area = { j: await page.textContent('[data-testid="mc-area-joints"]'), g: await page.textContent('[data-testid="mc-grout"]') };
  check('Materialberechnung: Fugenfläche und Fugenmasse „nicht berechenbar“ statt negativer Zahl', /nicht berechenbar/.test(area.j) && /nicht berechenbar/.test(area.g) && !/-\d/.test(area.j + area.g), `${area.j} · ${area.g}`);
  await goHash(page, `#/project/${pid}/pdf`);
  await page.waitForSelector('[data-testid="pdf-btn"]');
  await page.click('[data-testid="pdf-btn"]');
  await page.waitForSelector('.error:has-text("PDF nicht erstellt")', { timeout: 60000 });
  const pdfErr = await page.textContent('.error:has-text("PDF nicht erstellt")');
  check('PDF wird verweigert und nennt den Stein', /Ein Freiform-Stein hat ungültige/.test(pdfErr) && /A001/.test(pdfErr), pdfErr.slice(0, 140));

  // ---------- 8. „Abbrechen“ in einem anderen Projekt während des Speicherns gesperrt
  await goHash(page, '#/');
  await page.waitForSelector('[data-testid="sample-city"]');
  await page.click('[data-testid="sample-city"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  const cid = await projectId(page);
  await page.evaluate(() => (window.__slowBlob = 6000));
  await page.click('[data-testid="compute-btn"]');
  await page.waitForFunction(() => /Ergebnis speichern/.test(document.querySelector('[data-testid="compute-progress"]')?.textContent || ''), null, { timeout: 180000, polling: 50 });
  await goHash(page, `#/project/${pid}/compute`);
  await page.waitForSelector('[data-testid="other-job"][data-phase="commit"]', { timeout: 10000 });
  const other = await page.textContent('[data-testid="other-job"]');
  const cancelEnabled = await page.isEnabled('[data-testid="other-job-cancel"]');
  check('Anderes Projekt speichert gerade: „wird gerade gespeichert“, Abbrechen gesperrt', !cancelEnabled && /wird gerade gespeichert/.test(other), other.slice(0, 100));
  await page.screenshot({ path: path.join(OUT, '08-other-saving.png') });
  await page.waitForSelector('[data-testid="other-job"]', { state: 'detached', timeout: 60000 });
  await page.evaluate(() => (window.__slowBlob = 0));
  const cityRec = await idbTx(page, `const g = db.transaction('projects').objectStore('projects').get(arg); g.onsuccess = () => done({ computed: g.result.meta.computed, rev: g.result.mosaicRev || null });`, cid);
  check('…und das Ergebnis ist gespeichert (wie angekündigt)', cityRec.computed === true && !!cityRec.rev);

  check('Keine Fehler in der Konsole (Desktop)', errors.length === 0, errors.slice(0, 3).join(' | '));

  // ---------- 9. Handy 360 px: Ampel und Freiform-Beschriftungen
  const phone = await browser.newContext({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  const perr = [];
  pp.on('pageerror', (e) => perr.push(String(e)));
  await pp.goto(BASE);
  await pp.waitForSelector('[data-testid="sample-portrait"]');
  await pp.click('[data-testid="sample-portrait"]');
  await pp.waitForSelector('[data-testid="compute-btn"]');
  const ppid = await projectId(pp);
  await goHash(pp, `#/project/${ppid}/shapes`);
  await pp.waitForSelector('[data-testid="region-face-span"]', { timeout: 20000 });
  const span = await pp.$eval('[data-testid="region-face-span"]', (el) => {
    const dot = el.querySelector('.w3fg-dot').getBoundingClientRect();
    const text = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    const r = document.createRange();
    r.setStart(text, 0);
    r.setEnd(text, 1);
    const first = r.getBoundingClientRect();
    return { dotTop: dot.top, dotBottom: dot.bottom, textTop: first.top, textBottom: first.bottom, textLeft: first.left, dotRight: dot.right };
  });
  const sameLine = span.textTop < span.dotBottom && span.textBottom > span.dotTop && span.textLeft >= span.dotRight;
  check('Handy: Ampel der Gesichtsbreite steht in derselben Zeile wie ihr Text', sameLine, JSON.stringify(span));
  await pp.locator('[data-testid="region-face-span"]').scrollIntoViewIfNeeded();
  await pp.screenshot({ path: path.join(OUT, '09-phone-face-span.png') });
  await goHash(pp, `#/project/${ppid}/compute`);
  await pp.waitForSelector('[data-testid="compute-btn"]');
  await computeAndWait(pp);
  await pp.fill('[data-testid="find-stone"]', 'C005');
  await pp.press('[data-testid="find-stone"]', 'Enter');
  await pp.waitForSelector('[data-testid="stone-id"]');
  await pp.click('[data-testid="kind-diagA"]');
  await pp.waitForTimeout(300);
  await pp.click('[data-testid="kind-free"]');
  await pp.waitForSelector('[data-testid="free-svg"]');
  await pp.waitForTimeout(500);
  const labels = await pp.evaluate(() => {
    const svg = document.querySelector('[data-testid="free-svg"]').getBoundingClientRect();
    return [...document.querySelectorAll('[data-testid="free-edge-len"]')].map((t) => {
      const b = t.getBoundingClientRect();
      return { text: t.textContent, inside: b.left >= svg.left - 0.5 && b.right <= svg.right + 0.5 && b.top >= svg.top - 0.5 && b.bottom <= svg.bottom + 0.5, b: [Math.round(b.left), Math.round(b.right)], svg: [Math.round(svg.left), Math.round(svg.right)] };
    });
  });
  check('Handy 360 px: alle Kantenlängen im Freiform-Editor vollständig sichtbar', labels.length >= 3 && labels.every((l) => l.inside), JSON.stringify(labels.filter((l) => !l.inside).slice(0, 3)) || '');
  await pp.screenshot({ path: path.join(OUT, '10-phone-freeform-labels.png') });
  check('Keine Fehler in der Konsole (Handy)', perr.length === 0, perr.slice(0, 3).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('FEHLER', e);
  process.exit(1);
});
