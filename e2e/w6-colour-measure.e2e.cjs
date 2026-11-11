/* E2E: Farbe aus Foto messen (Paket w6-colour-measure).
 * Voraussetzung: `npm run build` und `npx vite preview --port <port>` laufen.
 * Aufruf: node e2e/w6-colour-measure.e2e.cjs <baseUrl> <ausgabeOrdner>
 *
 * Ein synthetisches „Kamerafoto“ (PNG, im Browser erzeugt) zeigt unter warmem Kunstlicht: weißes Papier, eine
 * ausgefressene Stelle, eine Graukarte 18 % und einen blauen Glasstein (#3A6EA5) mit Glanzlichtern und Rauschen.
 * Geprüft: Schaltfläche ohne Pipette sichtbar; überbelichtete Referenz abgelehnt („Referenz überbelichtet“);
 * Papierreferenz angenommen; Messwert füllt den HEX-Wert erst nach „Übernehmen“; Kennzeichnung
 * „gemessen (Näherung, Referenz: Papier, ±x ΔE)“ im Formular und in der Liste; Herkunft gespeichert; Abbrechen
 * ändert nichts; Graukarte korrigiert Farbstich und Belichtung; Eintippen setzt „eingegeben“; CSV-Export; Handy.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output', 'w6-colour-measure');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const shot = (page, name, full = false) => page.screenshot({ path: path.join(OUT, name), fullPage: full }).catch(() => {});

const W = 1200;
const H = 800;
const TILE_HEX = '#3A6EA5';
const SPOTS = { clipped: [580, 160], paper: [260, 400], grey: [610, 500], tile: [930, 400] };

/** Synthetisches Foto als PNG (im Browser gezeichnet, verlustfrei). */
async function makePhoto(page) {
  const b64 = await page.evaluate(
    async ({ W, H, tile }) => {
      const toLin = (v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      const toS = (c) => {
        const x = Math.max(0, Math.min(1, c));
        return Math.round((x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255);
      };
      const cast = [1.2, 1.0, 0.72];
      const exposure = 0.9;
      const shoot = (lin) => lin.map((c, i) => toS(c * cast[i] * exposure));
      const tileLin = [1, 3, 5].map((i) => toLin(parseInt(tile.slice(i, i + 2), 16)));
      let seed = 12345;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const img = new ImageData(W, H);
      const inR = (x, y, x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          let px;
          if (inR(x, y, 520, 100, 640, 220)) px = [255, 255, 255];
          else if (inR(x, y, 60, 150, 460, 650)) px = shoot([0.8, 0.8, 0.8]).map((v) => v + Math.round((rnd() - 0.5) * 4));
          else if (inR(x, y, 520, 300, 700, 700)) px = shoot([0.18, 0.18, 0.18]).map((v) => v + Math.round((rnd() - 0.5) * 4));
          else if (inR(x, y, 760, 200, 1100, 600)) {
            const u = rnd();
            if (u < 0.06) px = [255, 255, 255];
            else if (u < 0.09) px = [245, 238, 230];
            else px = shoot(tileLin).map((v) => v + Math.round((rnd() - 0.5) * 8));
          } else px = shoot([0.12, 0.115, 0.11]);
          const i = (y * W + x) * 4;
          img.data[i] = px[0];
          img.data[i + 1] = px[1];
          img.data[i + 2] = px[2];
          img.data[i + 3] = 255;
        }
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      cv.getContext('2d').putImageData(img, 0, 0);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { W, H, tile: TILE_HEX },
  );
  return Buffer.from(b64, 'base64');
}

function idbAll(page, store) {
  return page.evaluate(
    (store) =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('mosaicplan');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const q = db.transaction(store, 'readonly').objectStore(store).getAll();
          q.onsuccess = () => {
            db.close();
            resolve(q.result);
          };
          q.onerror = () => reject(q.error);
        };
      }),
    store,
  );
}

/** Antippen eines Bildpunkts (Bildkoordinaten des Fotos) auf der Messansicht. */
async function tapAt(page, [x, y], touch = false) {
  const cv = page.locator('[data-testid="measure-canvas"]');
  await cv.scrollIntoViewIfNeeded();
  const box = await cv.boundingBox();
  const position = { x: (x / W) * box.width, y: (y / H) * box.height };
  if (touch) await cv.tap({ position });
  else await cv.click({ position });
  await page.waitForTimeout(150);
}

async function loadPhoto(page, png) {
  await page.setInputFiles('[data-testid="measure-file"]', { name: 'kacheln.png', mimeType: 'image/png', buffer: png });
  await page.waitForSelector('[data-testid="measure-canvas"]', { timeout: 15000 });
  await page.waitForTimeout(300);
}

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await ctx.addInitScript('delete window.EyeDropper;');
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(BASE + '#/materials');
    await page.waitForSelector('[data-testid="add-material"]');
    const png = await makePhoto(page);
    fs.writeFileSync(path.join(OUT, 'testfoto.png'), png);

    // ---------- 1. Formular: Schaltfläche immer sichtbar (hier ohne EyeDropper)
    await page.click('[data-testid="add-material"]');
    await page.fill('[data-testid="mat-manufacturer"]', 'E2E-Glas');
    await page.fill('[data-testid="mat-colornumber"]', 'W6CM-1');
    const hint = await page.textContent('[data-testid="mat-color-hint"]');
    check('„Farbe aus Foto messen“ sichtbar ohne Pipette', (await page.isVisible('[data-testid="measure-open"]')) && !(await page.isVisible('button:has-text("Pipette")')), hint);
    check('Hinweis nennt die Fotomessung statt der Pipette', /Farbe aus Foto messen/.test(hint) && /HEX-Wert eingeben/.test(hint));
    const hexBefore = await page.inputValue('[data-testid="mat-hex"]');

    // ---------- 2. Dialog: Foto laden
    await page.click('[data-testid="measure-open"]');
    await page.waitForSelector('[data-testid="measure-dialog"]');
    const cam = page.locator('[data-testid="measure-file-camera"]');
    check('Kamera-Eingabe mit capture=environment und accept=image/*', (await cam.getAttribute('capture')) === 'environment' && (await cam.getAttribute('accept')) === 'image/*');
    check('Übernehmen ohne Messung deaktiviert', await page.isDisabled('[data-testid="measure-apply"]'));
    await loadPhoto(page, png);
    check('Foto geladen, Schritt „Referenz antippen“', /Referenz/.test(await page.textContent('[data-testid="measure-step"]')));

    // ---------- 3. Überbelichtete Referenz wird abgelehnt
    await tapAt(page, SPOTS.clipped);
    const st1 = await page.textContent('[data-testid="measure-ref-status"]');
    check('Überbelichtete Referenz abgelehnt', /Referenz überbelichtet/.test(st1) && /nicht korrigiert/.test(st1), st1);
    check('Nach abgelehnter Referenz weiter im Schritt Referenz', /Referenz \(weißes Papier/.test(await page.textContent('[data-testid="measure-step"]')));
    await shot(page, 'w6cm-01-referenz-ueberbelichtet.png');

    // ---------- 4. Papierreferenz, dann Stein
    await tapAt(page, SPOTS.paper);
    const st2 = await page.textContent('[data-testid="measure-ref-status"]');
    check('Papierreferenz angenommen, Korrektur aktiv', /Referenz gemessen/.test(st2), st2);
    check('Automatisch weiter zum Stein', /Stein/.test(await page.textContent('[data-testid="measure-step"]')));
    await tapAt(page, SPOTS.tile);
    const measured = (await page.textContent('[data-testid="measure-hex"]')).trim();
    const resultText = (await page.textContent('[data-testid="measure-result"]')).replace(/\s+/g, ' ');
    // w6-fix-ui: neues Material (Platzhalter #808080) hat noch keine echte Farbe – kein „Bisher“, keine Abweichung dazu
    check(
      'Messwert mit HEX, Lab (aufklappbar erklärt) und Streuung; neues Material ohne „Abweichung zum bisherigen Wert“',
      /^#[0-9A-F]{6}$/.test(measured) && /Lab/.test(resultText) && /Was bedeuten Lab und ΔE/.test(resultText) && !/bisherigen Wert/.test(resultText) && /Streuung der Fläche: ±/.test(resultText),
      `${measured} | ${resultText.slice(0, 200)}`,
    );
    check('Glanzlichter verworfen und angezeigt', /% übersteuert verworfen/.test(resultText));
    check('Ehrlichkeitshinweis „Richtwert … keine kalibrierte Farbmessung“', /Richtwert/.test(resultText) && /keine kalibrierte Farbmessung/.test(resultText));
    const hexWhileOpen = await page.inputValue('[data-testid="mat-hex"]');
    check('HEX im Formular vor „Übernehmen“ unverändert', hexWhileOpen === hexBefore, `${hexBefore} → ${hexWhileOpen}`);
    // Papier korrigiert den Stich: Blau bleibt blau, das Rot des Kunstlichts ist weg (R < G < B)
    const [r, g, b] = hexRgb(measured);
    check('Papierreferenz entfernt den Farbstich (Kanalfolge wie der Stein)', r < g && g < b && b - r > 80, `${measured}`);
    await shot(page, 'w6cm-02-messung-desktop.png');

    // Messfläche ändern → Messwert wird neu berechnet (kein Absturz, weiterhin gültig)
    await page.locator('[data-testid="measure-size"]').fill('40');
    await page.waitForTimeout(200);
    check('Größere Messfläche: neu gemessen', /^#[0-9A-F]{6}$/.test((await page.textContent('[data-testid="measure-hex"]')).trim()));
    await page.locator('[data-testid="measure-size"]').fill('18');
    await page.waitForTimeout(200);
    const measured2 = (await page.textContent('[data-testid="measure-hex"]')).trim();

    // ---------- 5. Übernehmen → HEX und Kennzeichnung im Formular
    await page.click('[data-testid="measure-apply"]');
    await page.waitForSelector('[data-testid="measure-dialog"]', { state: 'detached' });
    const hexAfter = await page.inputValue('[data-testid="mat-hex"]');
    const formTag = await page.textContent('[data-testid="mat-source-tag"]');
    check('Nach „Übernehmen“: HEX im Formular = Messwert', hexAfter === measured2, `${hexAfter} / ${measured2}`);
    check('Formular zeigt „gemessen (Näherung, Referenz: Papier, ±x ΔE)“', /^gemessen \(Näherung, Referenz: Papier, ±\d+(,\d)? ΔE\)$/.test(formTag.trim()), formTag);
    await shot(page, 'w6cm-03-formular.png');
    check('Noch nicht gespeichert, solange nicht „Speichern“', !(await idbAll(page, 'materials')).some((m) => m.colorNumber === 'W6CM-1'));
    await page.click('[data-testid="save-material"]');
    await page.waitForSelector('[data-testid="materials-table"]');
    const row = page.locator('[data-testid="materials-table"] tbody tr', { hasText: 'W6CM-1' });
    const listTag = (await row.locator('[data-testid="material-source-tag"]').textContent()).trim();
    check('Liste zeigt die Kennzeichnung', /^gemessen \(Näherung, Referenz: Papier, ±\d+(,\d)? ΔE\)$/.test(listTag), listTag);
    check('Tooltip der Kennzeichnung: Richtwert, nicht kalibriert', /keine kalibrierte Farbmessung/.test((await row.locator('[data-testid="material-source-tag"]').getAttribute('title')) || ''));
    const saved = (await idbAll(page, 'materials')).find((m) => m.colorNumber === 'W6CM-1');
    check(
      'Gespeichert: colorSource photo / white / Datum / Streuung',
      saved && saved.hex === measured2 && saved.colorSource && saved.colorSource.kind === 'photo' && saved.colorSource.reference === 'white' && !Number.isNaN(Date.parse(saved.colorSource.measuredAt)) && typeof saved.colorSource.spreadDE === 'number',
      JSON.stringify(saved && saved.colorSource),
    );
    await shot(page, 'w6cm-04-liste.png');

    // ---------- 6. Abbrechen ändert nichts; Graukarte korrigiert Stich und Belichtung
    await row.locator('button[aria-label="Bearbeiten"]').click();
    await page.click('[data-testid="measure-open"]');
    await loadPhoto(page, png);
    await page.selectOption('[data-testid="measure-ref-type"]', 'grey18');
    await tapAt(page, SPOTS.grey);
    check('Graukarte angenommen', /Referenz gemessen/.test(await page.textContent('[data-testid="measure-ref-status"]')));
    await tapAt(page, SPOTS.tile);
    const greyHex = (await page.textContent('[data-testid="measure-hex"]')).trim();
    const diff = hexRgb(greyHex).map((v, i) => Math.abs(v - hexRgb(TILE_HEX)[i]));
    check('Graukarte: gemessener Wert ≈ wahre Steinfarbe (je Kanal ≤ 4)', Math.max(...diff) <= 4, `${greyHex} vs ${TILE_HEX}`);
    await page.click('[data-testid="measure-cancel"]');
    await page.waitForSelector('[data-testid="measure-dialog"]', { state: 'detached' });
    check('Abbrechen: HEX und Kennzeichnung unverändert', (await page.inputValue('[data-testid="mat-hex"]')) === measured2 && /Referenz: Papier/.test(await page.textContent('[data-testid="mat-source-tag"]')));

    // ---------- 7. Eintippen setzt „eingegeben“ (Kennzeichnung verschwindet)
    await page.fill('[data-testid="mat-hex"]', '#3A6EA5');
    check('Eingetippter HEX: keine Messkennzeichnung mehr', (await page.locator('[data-testid="mat-source-tag"]').count()) === 0);
    await page.click('[data-testid="save-material"]');
    await page.waitForTimeout(300);
    const saved2 = (await idbAll(page, 'materials')).find((m) => m.colorNumber === 'W6CM-1');
    check('Gespeichert als „manual“', saved2 && saved2.colorSource && saved2.colorSource.kind === 'manual', JSON.stringify(saved2 && saved2.colorSource));

    // ---------- 8. CSV-Export enthält die Herkunftsspalten
    await row.locator('button[aria-label="Bearbeiten"]').click();
    await page.click('[data-testid="measure-open"]');
    await loadPhoto(page, png);
    await page.selectOption('[data-testid="measure-ref-type"]', 'none');
    await tapAt(page, SPOTS.tile);
    const warnNoRef = await page.textContent('[data-testid="measure-warnings"]');
    check('Ohne Referenz: Warnung „nicht korrigiert“', /Ohne Referenz/.test(warnNoRef), warnNoRef);
    await page.click('[data-testid="measure-apply"]');
    await page.click('[data-testid="save-material"]');
    await page.waitForTimeout(300);
    const tagNone = (await row.locator('[data-testid="material-source-tag"]').textContent()).trim();
    check('Liste: „gemessen (Näherung, ohne Referenz, ±x ΔE)“', /^gemessen \(Näherung, ohne Referenz, ±/.test(tagNone), tagNone);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click('[data-testid="export-csv"]')]);
    const csvPath = path.join(OUT, 'export.csv');
    await dl.saveAs(csvPath);
    const csv = fs.readFileSync(csvPath, 'utf8');
    check('CSV: Herkunftsspalten und „Foto-Messung (Näherung)“', /;Farbherkunft;Gemessen am;Messreferenz;Messstreuung \(ΔE\)/.test(csv) && /;Foto-Messung \(Näherung\);\d{4}-\d\d-\d\dT[^;]+;keine;\d+(,\d)?/.test(csv));

    // ---------- 9. Englisch und Türkisch: Dialog übersetzt
    for (const [lang, label, re] of [
      ['en', 'English', /Measure colour from photo/],
      ['tr', 'Türkçe', /Fotoğraftan renk ölç/],
    ]) {
      await page.goto(BASE + '#/settings');
      await page.click(`[data-testid="lang-select"] >> text=${label}`);
      await page.waitForTimeout(200);
      await page.goto(BASE + '#/materials');
      await page.waitForSelector('[data-testid="materials-table"]');
      await page.click('[data-testid="add-material"]');
      await page.click('[data-testid="measure-open"]');
      const txt = await page.textContent('[data-testid="measure-dialog"]');
      const title = await page.locator('.modal .modal-head h3').last().textContent();
      check(`Dialog auf ${lang}`, re.test(title) && !/w6cm\./.test(txt), title);
      await page.click('[data-testid="measure-cancel"]');
      await page.keyboard.press('Escape');
    }
    await page.goto(BASE + '#/settings');
    await page.click('[data-testid="lang-select"] >> text=Deutsch');
    await ctx.close();

    // ---------- 10. Handy (390 × 844, Touch)
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const pp = await phone.newPage();
    pp.on('pageerror', (e) => errors.push(String(e)));
    await pp.goto(BASE + '#/materials');
    await pp.waitForSelector('[data-testid="add-material"]');
    await pp.click('[data-testid="add-material"]');
    await shot(pp, 'w6cm-05-handy-formular.png');
    await pp.tap('[data-testid="measure-open"]');
    await loadPhoto(pp, png);
    await shot(pp, 'w6cm-06-handy-foto.png');
    await tapAt(pp, SPOTS.paper, true);
    await pp.tap('[data-testid="measure-zoom-in"]');
    await pp.waitForTimeout(200);
    await tapAt(pp, SPOTS.tile, true);
    const phoneHex = (await pp.textContent('[data-testid="measure-hex"]').catch(() => '')).trim();
    check('Handy: Antippen misst (Referenz + Stein)', /^#[0-9A-F]{6}$/.test(phoneHex), phoneHex);
    const overflow = await pp.evaluate(() => {
      const m = [...document.querySelectorAll('.modal')].pop();
      return { doc: document.documentElement.scrollWidth - window.innerWidth, modal: m ? m.getBoundingClientRect().right - window.innerWidth : 0 };
    });
    check('Handy: kein waagrechter Überlauf', overflow.doc <= 1 && overflow.modal <= 1, JSON.stringify(overflow));
    await pp.locator('[data-testid="measure-result"]').scrollIntoViewIfNeeded();
    await shot(pp, 'w6cm-07-handy-ergebnis.png');
    await pp.locator('[data-testid="measure-apply"]').scrollIntoViewIfNeeded();
    await shot(pp, 'w6cm-08-handy-fuss.png');
    await pp.tap('[data-testid="measure-apply"]');
    await pp.waitForSelector('[data-testid="measure-dialog"]', { state: 'detached' });
    check('Handy: Übernehmen setzt HEX', (await pp.inputValue('[data-testid="mat-hex"]')) === phoneHex);
    await phone.close();

    check('Keine Seitenfehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    check('Ablauf ohne Ausnahme', false, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} bestanden`);
  process.exit(failed.length ? 1 : 0);
})();
