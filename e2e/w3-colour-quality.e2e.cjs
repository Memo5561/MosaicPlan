/* Browser-Test w3-colour-quality: Farbmischung (Standard 50 %, ehrlicher Hinweis), „Meine Steine – begrenzte
 * Farbanzahl“ wählt die angeforderte Anzahl direkt aus dem Bestand, Gründe für weniger Farben, „Fehlende Farben –
 * Farbton zum Nachkaufen (Zielwert)“ (auch für „Meine Steine – alle Farben“), Sprachen, Handy-Layout.
 * Aufruf: node e2e/w3-colour-quality.e2e.cjs <baseUrl> <outDir>   (vorher: npm run build && npx vite preview)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output', 'w3-colour-quality');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const digits = (s) => parseInt(String(s).replace(/\D/g, ''), 10);

function mat(i, hex, extra = {}) {
  return {
    id: `e2e-w3cq-${i}`,
    type: 'glass',
    manufacturer: 'E2E',
    product: 'Katalog',
    colorNumber: `K${String(i).padStart(3, '0')}`,
    colorName: '',
    hex,
    lengthMm: 10,
    widthMm: 10,
    thicknessMm: 4,
    price: 0,
    packageSize: '',
    piecesPerPack: 0,
    notes: '',
    ...extra,
  };
}
const hx = (v) => v.toString(16).padStart(2, '0').toUpperCase();
/** Katalog: 7 Stufen je sRGB-Kanal, die ersten 336 Farben (wie tests/w3-colour-quality.test.ts) */
function catalogue() {
  const steps = [0, 42, 85, 128, 170, 213, 255];
  const out = [];
  for (const r of steps) for (const g of steps) for (const b of steps) out.push(mat(out.length + 1, `#${hx(r)}${hx(g)}${hx(b)}`));
  return out.slice(0, 336);
}
const SIX = ['#F4F1EA', '#1E1A18', '#E8B494', '#4E2C1C', '#7FA0BA', '#A02432'].map((h, i) => mat(900 + i, h));

async function putMaterials(page, list) {
  await page.evaluate(
    (ms) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('mosaicplan');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('materials', 'readwrite');
          for (const m of ms) tx.objectStore('materials').put(m, m.id);
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    list,
  );
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  async function newPage(viewport) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('dialog', (d) => d.accept());
    return { context, page };
  }
  const compute = async (page) => {
    await page.click('[data-testid="step-compute"]');
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="recompute-guard"], [data-testid="mosaic-canvas"]', { timeout: 120000 });
    if (await page.isVisible('[data-testid="recompute-guard"]')) await page.click('[data-testid="guard-nobackup"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
    await page.waitForTimeout(500);
    await page.click('[data-testid="step-colors"]');
    await page.waitForSelector('[data-testid="palette-table"]');
    await page.waitForSelector('[data-testid="palette-counts"]', { timeout: 30000 });
  };
  const paletteRows = (page) => page.$$eval('[data-testid="palette-table"] tbody tr', (trs) => trs.length);
  const missingRows = (page) =>
    page.$$eval('[data-testid="missing-row"]', (trs) =>
      trs.map((tr) => ({
        target: tr.querySelector('td[data-col="target"]').textContent.trim(),
        stones: parseInt(tr.querySelector('td[data-col="stones"]').textContent.replace(/\D/g, ''), 10),
        nearest: tr.querySelector('td[data-col="nearest"]').textContent.trim(),
        got: tr.querySelector('td[data-col="got"]').textContent.trim(),
      })),
    );

  // ================================================================ A: 336 Katalogfarben
  {
    const { context, page } = await newPage({ width: 1360, height: 900 });
    await page.goto(BASE);
    await page.waitForSelector('[data-testid="new-project"]');
    await putMaterials(page, catalogue());
    await page.reload();
    await page.waitForSelector('[data-testid="sample-portrait"]');
    await page.click('[data-testid="sample-portrait"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.click('[data-testid="step-colors"]');

    // ---------- Farbmischung: Standard 50 % für neue Projekte, Bereich zu, ehrlicher Hinweis
    const adv = await page.$eval('[data-testid="colors-advanced"]', (d) => ({ open: d.open, summary: d.querySelector('summary').textContent }));
    check('Neues Projekt: Farbübergänge mischen 50 % (Standard, „Erweitert“ zu, kein „geändert“)', !adv.open && /50 %/.test(adv.summary) && !/geändert/.test(adv.summary), adv.summary.trim());
    await page.click('[data-testid="colors-advanced"] summary');
    const hint = await page.textContent('[data-testid="dither-hint"]');
    check('Hinweis nennt den Abtausch (weichere Verläufe, mehr Farbwechsel, 0 % = einfarbig, nur ähnliche Töne)', /weichere Verläufe/.test(hint) && /Farbwechsel beim Legen/.test(hint) && /0 % = einfarbige Flächen/.test(hint) && /ΔE 3/.test(hint), hint.slice(0, 90) + ' …');
    await page.screenshot({ path: path.join(OUT, 'w3cq-01-dither-hint.png') });
    await page.click('[data-testid="colors-advanced"] summary');

    // ---------- Meine Steine – begrenzte Farbanzahl: 24 angefordert → 24 verwendet
    await page.click('[data-testid="palette-mode"] >> text=Meine Steine – begrenzte Farbanzahl');
    const modeHint = await page.locator('.field', { has: page.locator('[data-testid="palette-mode"]') }).textContent();
    check('Hinweis der Farbquelle verspricht keinen 1:1-Ersatz mehr und nennt „Fehlende Farben“', /am besten wiedergeben/.test(modeHint) && /Fehlende Farben/.test(modeHint) && !/zusammengelegt/.test(modeHint), modeHint.slice(0, 120) + ' …');
    await page.click('[data-testid="color-counts"] >> text=24');
    await compute(page);
    const counts = (await page.textContent('[data-testid="palette-counts"]')).trim();
    const rows = await paletteRows(page);
    const warn = await page.$eval('[data-testid="palette-counts"]', (p) => p.classList.contains('warn-box'));
    check('336 Materialien, 24 angefordert: „angefordert 24 – verwendet 24“ (keine Warnung)', /angefordert 24 – verwendet 24\./.test(counts) && rows === 24 && !warn, `${counts} | Zeilen ${rows}`);
    const mats = await page.$$eval('[data-testid="palette-table"] tbody tr td[data-col="material"] select', (ss) => ss.map((s) => s.options[s.selectedIndex].textContent.trim()));
    check('Jede Farbe ist ein Material aus dem Bestand', mats.length === 24 && mats.every((m) => /^E2E K\d{3}/.test(m)), mats.slice(0, 3).join(' | '));

    // ---------- Fehlende Farben
    const det = await page.$('[data-testid="missing-colors"]');
    check('„Fehlende Farben – Farbton zum Nachkaufen (Zielwert)“ vorhanden (grober Katalog)', !!det);
    const summary = det ? (await page.textContent('[data-testid="missing-summary"]')).trim() : '';
    const title = det ? (await page.textContent('[data-testid="missing-colors"] summary')).trim() : '';
    check('Zusammenfassung nennt Farbtöne, Steine und Anteil', /Fehlende Farben – Farbton zum Nachkaufen \(Zielwert\)/.test(title) && /\d+ Farbt(on|öne) · [\d.]+ Steine \([\d,<\s]+ % des Mosaiks\)/.test(summary), summary);
    if (det) await page.click('[data-testid="missing-colors"] summary');
    const mr = await missingRows(page);
    const sumStones = mr.reduce((s, r) => s + r.stones, 0);
    check('Liste: Zielfarbe als HEX und L*a*b*, Steine, ähnlichstes eigenes Material mit ΔE, erhaltene Abweichung', mr.length > 0 && mr.every((r) => /#[0-9A-F]{6}\s*L -?\d/.test(r.target) && r.stones > 0 && /E2E K\d{3}/.test(r.nearest) && /ΔE00 \d/.test(r.nearest) && /Ø ΔE00 \d/.test(r.got)), `${mr.length} Zeilen, z. B. ${mr[0] ? `${mr[0].target} | ${mr[0].nearest}` : '–'}`);
    check('Liste nach Steinen absteigend, Summe = Zusammenfassung', mr.every((r, i) => i === 0 || mr[i - 1].stones >= r.stones) && summary.includes(sumStones.toLocaleString('de-DE')), `${sumStones} Steine`);
    const mDE = mr.map((r) => parseFloat(/ΔE00 (\d+(?:,\d+)?)/.exec(r.nearest)[1].replace(',', '.')));
    check('Nur Fotofarben, die kein Material auf ΔE ≤ 5 trifft', mDE.every((v) => v > 5), mDE.slice(0, 5).join(', '));
    const intro = await page.textContent('[data-testid="missing-colors"]');
    check('Ehrlich beschriftet: Zielfarbtöne/Richtwert, kein Produkt', /Zielfarbtöne/.test(intro) && /Richtwert/.test(intro) && /kein bestimmtes Produkt/.test(intro));
    await page.locator('[data-testid="missing-colors"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, 'w3cq-02-missing-desktop.png') });

    // ---------- Sprachen
    const projUrl = page.url();
    for (const [label, re] of [
      ['English', /Missing colours – shade to buy \(target value\)/],
      ['Türkçe', /Eksik renkler – satın alınacak renk tonu \(hedef değer\)/],
    ]) {
      await page.goto(BASE + '#/settings');
      await page.click(`[data-testid="lang-select"] >> text=${label}`);
      await page.waitForTimeout(300);
      await page.goto(projUrl);
      await page.waitForSelector('[data-testid="missing-colors"]', { timeout: 30000 });
      const txt = await page.textContent('[data-testid="missing-colors"]');
      const cnt = await page.textContent('[data-testid="palette-counts"]');
      check(`${label}: Liste und Meldung übersetzt (keine Schlüssel)`, re.test(txt) && !/w3cq\.|w2ch\./.test(txt + cnt), txt.slice(0, 70));
    }
    await page.goto(BASE + '#/settings');
    await page.click('[data-testid="lang-select"] >> text=Deutsch');
    await page.waitForTimeout(300);
    await page.goto(projUrl);
    await page.waitForSelector('[data-testid="palette-table"]');

    // ---------- Meine Steine – alle Farben: auch hier Fehlende Farben (32 untersuchte Fotofarben)
    await page.click('[data-testid="palette-mode"] >> text=Meine Steine – alle Farben');
    await compute(page);
    await page.waitForSelector('[data-testid="missing-colors"], [data-testid="missing-none"]', { timeout: 30000 });
    const allTxt = await page.textContent('[data-testid="missing-colors"], [data-testid="missing-none"]');
    check('„Meine Steine – alle Farben“: Fehlende Farben mit 32 untersuchten Fotofarben', /untersucht: 32 typische Fotofarben|32 untersuchten/.test(allTxt), allTxt.slice(0, 90));

    // ---------- Automatisch: keine Liste
    await page.click('[data-testid="palette-mode"] >> text=Automatisch aus dem Foto');
    await compute(page);
    const none = (await page.$('[data-testid="missing-colors"]')) || (await page.$('[data-testid="missing-none"]'));
    check('„Automatisch aus dem Foto“: keine Fehlende-Farben-Liste', !none);

    // ---------- Handy-Layout der Liste
    await page.click('[data-testid="palette-mode"] >> text=Meine Steine – begrenzte Farbanzahl');
    await compute(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.waitForSelector('[data-testid="missing-colors"]', { timeout: 60000 });
    await page.click('[data-testid="missing-colors"] summary');
    await page.locator('[data-testid="missing-colors"]').scrollIntoViewIfNeeded();
    const geo = await page.evaluate(() => {
      const d = document.querySelector('[data-testid="missing-colors"]').getBoundingClientRect();
      const tr = document.querySelector('[data-testid="missing-row"]');
      const stones = tr.querySelector('td[data-col="stones"]').getBoundingClientRect();
      const wrap = document.querySelector('[data-testid="missing-table"]').parentElement;
      const near = tr.querySelector('td[data-col="nearest"]').getBoundingClientRect();
      return {
        w: window.innerWidth,
        page: document.documentElement.scrollWidth,
        panelRight: Math.round(d.right),
        stonesRight: Math.round(stones.right),
        nearRight: Math.round(near.right),
        tableScroll: wrap.scrollWidth - wrap.clientWidth,
        gotInline: getComputedStyle(tr.querySelector('.w3cq-got-inline')).display,
      };
    });
    check('Handy (390 px): Liste ohne seitliche Seiten-Scrollleiste, Steine in der ersten Breite sichtbar', geo.page <= geo.w + 1 && geo.panelRight <= geo.w && geo.stonesRight <= geo.w, JSON.stringify(geo));
    check('Handy: ganze Tabelle passt (Material und „Erhalten“ ohne Blättern sichtbar)', geo.tableScroll <= 1 && geo.nearRight <= geo.panelRight && geo.gotInline === 'block', `überstehend ${geo.tableScroll} px`);
    await page.screenshot({ path: path.join(OUT, 'w3cq-03-missing-phone.png') });
    await context.close();
  }

  // ================================================================ B: nur 6 Materialien
  {
    const { context, page } = await newPage({ width: 1360, height: 900 });
    await page.goto(BASE);
    await page.waitForSelector('[data-testid="new-project"]');
    await putMaterials(page, SIX);
    await page.reload();
    await page.waitForSelector('[data-testid="sample-portrait"]');
    await page.click('[data-testid="sample-portrait"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.click('[data-testid="step-colors"]');
    await page.click('[data-testid="palette-mode"] >> text=Meine Steine – begrenzte Farbanzahl');
    await page.click('[data-testid="color-counts"] >> text=16');
    await compute(page);
    const counts = (await page.textContent('[data-testid="palette-counts"]')).trim();
    const rows = await paletteRows(page);
    const warn = await page.$eval('[data-testid="palette-counts"]', (p) => p.classList.contains('warn-box'));
    const m = /angefordert 16 – verwendet (\d+)/.exec(counts);
    check('6 Materialien, 16 angefordert: Grund genannt („Ihre Materialauswahl hat nur 6 Farben.“), Warnung', m && +m[1] === rows && rows <= 6 && /Ihre Materialauswahl hat nur 6 Farben\./.test(counts) && warn, counts);
    await page.screenshot({ path: path.join(OUT, 'w3cq-04-six-materials.png'), fullPage: false });
    await context.close();
  }

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
