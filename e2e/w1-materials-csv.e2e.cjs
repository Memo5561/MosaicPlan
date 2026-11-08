/* E2E: Material-CSV-Import/-Export (deutsches Excel, Rundreise, Aktualisieren, Vorlage, Lösch-Rückfrage, Pipetten-Hinweis).
 * Voraussetzung: `npm run build` und `npx vite preview` laufen.
 * Aufruf: node e2e/w1-materials-csv.e2e.cjs [baseUrl] [screenshotDir]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w1-materials-csv');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

// Deutsches Excel „CSV (Trennzeichen-getrennt)“: Semikolon, Dezimalkomma, ANSI (Windows-1252), kein BOM
const GERMAN_EXCEL =
  'Materialart;Hersteller;Produkt;Farbnummer;Farbe;HEX;Länge;Breite;Dicke;Preis;Packungsgröße;Stück/Packung;Bestand;Notiz\r\n' +
  'Glas;Sicis;Vetricolor;09;Blau;#3A6EA5;9,5;9,5;4;12,50;Matte 30x30;900;250;Rest, Bad\r\n' +
  'Glas;Sicis;Vetricolor;10;Rot;#GG0000;10;10;4;1;x;1;1;\r\n' +
  'Keramik;Bisazza;Le Gemme;GM20;Grün;#33AA66;10;10;4;3,75;Beutel;1.250;;"Bad; Küche"\r\n';

const TURKISH_TAB = 'Üretici\tRenk numarası\tRenk adı\tHEX\tUzunluk\tGenişlik\tFiyat\tStok\r\nOrsoni\t12\tAltın\t#D4AF37\t15\t15\t3,75\t40\r\n';

function idb(page, op, store, key, value) {
  return page.evaluate(
    ([op, store, key, value]) =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('mosaicplan');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction(store, op === 'all' ? 'readonly' : 'readwrite');
          const s = tx.objectStore(store);
          const q = op === 'all' ? s.getAll() : s.put(value, key);
          let out;
          q.onsuccess = () => (out = q.result);
          tx.oncomplete = () => {
            db.close();
            resolve(out);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    [op, store, key, value],
  );
}

async function upload(page, name, buffer) {
  await page.setInputFiles('[data-testid="import-input"]', { name, mimeType: 'text/csv', buffer });
}

async function waitPreview(page) {
  await page.waitForSelector('[data-testid="import-preview"]', { timeout: 10000 });
  return (await page.textContent('[data-testid="import-summary"]')).replace(/\s+/g, ' ').trim();
}

async function download(page, testid, file) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click(`[data-testid="${testid}"]`)]);
  const p = path.join(OUT, file);
  await dl.saveAs(p);
  return { path: p, name: dl.suggestedFilename(), bytes: fs.readFileSync(p) };
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(BASE + '#/materials');
  await page.waitForSelector('[data-testid="add-material"]');

  // ---------- 1. Deutsches Excel (ANSI) → Vorschau, nichts geschrieben bis zur Bestätigung
  await upload(page, 'excel_de.csv', Buffer.from(GERMAN_EXCEL, 'latin1'));
  const sum1 = await waitPreview(page);
  check('Vorschau: 2 neu · 1 fehlerhaft (Zeile 3: HEX ungültig)', /2 neu/.test(sum1) && /1 fehlerhaft/.test(sum1) && /Zeile 3: HEX-Wert ungültig/.test(sum1), sum1);
  const info1 = await page.textContent('[data-testid="import-preview"] p.muted');
  check('Vorschau: Semikolon und Windows-1252 erkannt', /Semikolon/.test(info1) && /Windows-1252/.test(info1), info1.trim());
  const warn1 = await page.textContent('[data-testid="import-warning-list"]');
  check("Hinweis: '1.250' in Stück/Packung (Zeile 4) nicht geraten", /Zeile 4/.test(warn1) && /Stück\/Packung/.test(warn1) && /1\.250/.test(warn1), warn1.trim().slice(0, 120));
  await page.screenshot({ path: path.join(OUT, 'mc-01-preview-de.png') });
  check('Vor Bestätigung nichts gespeichert', (await idb(page, 'all', 'materials')).length === 0);
  await page.click('[data-testid="import-apply"]');
  await page.waitForSelector('[data-testid="mats-msg"]');
  const msg1 = await page.textContent('[data-testid="mats-msg"]');
  check('Import abgeschlossen: 2 neu, 1 nicht importiert', /2 neu angelegt/.test(msg1) && /1 nicht importiert/.test(msg1), msg1);
  check('Bericht mit fehlerhafter Zeile bleibt sichtbar', /Zeile 3/.test(await page.textContent('[data-testid="import-report"]')));
  const mats1 = await idb(page, 'all', 'materials');
  const sicis = mats1.find((m) => m.manufacturer === 'Sicis');
  const bis = mats1.find((m) => m.manufacturer === 'Bisazza');
  check(
    "'12,50' → 12,5 € und '9,5' → 9,5 mm; Text mit Komma/Semikolon erhalten",
    sicis && sicis.price === 12.5 && sicis.lengthMm === 9.5 && sicis.widthMm === 9.5 && sicis.piecesPerPack === 900 && sicis.stock === 250 && sicis.notes === 'Rest, Bad' && bis.notes === 'Bad; Küche',
    sicis ? `${sicis.price} | ${sicis.lengthMm}×${sicis.widthMm} | ${sicis.notes} | ${bis.notes}` : 'fehlt',
  );
  check("'1.250' nicht als 1 oder 1250 übernommen", bis && bis.piecesPerPack === 0, String(bis && bis.piecesPerPack));
  const table1 = await page.textContent('[data-testid="materials-table"]');
  check('Tabelle zeigt 12,5 und 9,5 × 9,5', /12,5/.test(table1) && /9,5 × 9,5/.test(table1));
  await page.screenshot({ path: path.join(OUT, 'mc-02-imported.png') });

  // ---------- 2. Eigener Export (de) → erneuter Import: 0 neu, 2 identisch
  const exp = await download(page, 'export-csv', 'export_de.csv');
  const expText = exp.bytes.toString('utf8');
  check(
    'Export de: BOM, ID-Spalte, deutsche Kopfzeile, Dezimalkomma, Quoting',
    exp.bytes[0] === 0xef && exp.bytes[1] === 0xbb && exp.bytes[2] === 0xbf && expText.includes('ID;Materialart;Hersteller;') && expText.includes(';12,5;') && expText.includes('"Bad; Küche"'),
    exp.name,
  );
  await upload(page, 'export_de.csv', exp.bytes);
  const sum2 = await waitPreview(page);
  check('Re-Import eigener Export: 0 neu · 2 identisch', /0 neu/.test(sum2) && /2 identisch/.test(sum2) && /0 fehlerhaft/.test(sum2), sum2);
  check('Nichts zu importieren → Übernehmen deaktiviert', await page.isDisabled('[data-testid="import-apply"]'));
  await page.screenshot({ path: path.join(OUT, 'mc-03-reimport.png') });
  await page.click('[data-testid="import-cancel"]');
  check('Keine Duplikate nach Re-Import', (await idb(page, 'all', 'materials')).length === 2);

  // ---------- 3. Geänderter Export → Aktualisieren behält die ID
  const changed = expText.replace(';12,5;', ';13,90;');
  await upload(page, 'export_geaendert.csv', Buffer.from(changed, 'utf8'));
  const sum3 = await waitPreview(page);
  const upd3 = await page.textContent('[data-testid="import-update-list"]');
  check('Vorschau: 1 aktualisiert mit Preisänderung 12,5 → 13,9', /1 aktualisiert/.test(sum3) && /12,5 → 13,9/.test(upd3), `${sum3} | ${upd3.trim()}`);
  check('Schaltfläche „Aktualisieren“ und „Als neu hinzufügen“', /Aktualisieren/.test(await page.textContent('[data-testid="import-apply"]')) && (await page.isVisible('[data-testid="import-as-new"]')));
  await page.screenshot({ path: path.join(OUT, 'mc-04-update.png') });
  await page.click('[data-testid="import-apply"]');
  await page.waitForTimeout(300);
  const mats3 = await idb(page, 'all', 'materials');
  const sicis3 = mats3.find((m) => m.manufacturer === 'Sicis');
  check('Aktualisierung behält die Material-ID, keine Duplikate', mats3.length === 2 && sicis3.id === sicis.id && sicis3.price === 13.9, `${sicis3.id === sicis.id} | ${sicis3.price}`);

  // ---------- 4. Türkische Kopfzeile, tabulatorgetrennt
  await upload(page, 'tr_tab.txt', Buffer.from(TURKISH_TAB, 'utf8'));
  const sum4 = await waitPreview(page);
  const info4 = await page.textContent('[data-testid="import-preview"] p.muted');
  check('Tab-getrennte Datei mit türkischer Kopfzeile: 1 neu', /1 neu/.test(sum4) && /Tabulator/.test(info4), sum4);
  await page.click('[data-testid="import-apply"]');
  await page.waitForTimeout(300);
  const orsoni = (await idb(page, 'all', 'materials')).find((m) => m.manufacturer === 'Orsoni');
  check('Türkischer Import: Werte korrekt', orsoni && orsoni.colorName === 'Altın' && orsoni.price === 3.75 && orsoni.stock === 40 && orsoni.lengthMm === 15);

  // ---------- 5. Datei ohne HEX-Spalte → klarer Fehler
  await upload(page, 'ohne_hex.csv', Buffer.from('Hersteller;Farbnummer\nSicis;09\n', 'utf8'));
  await page.waitForTimeout(300);
  const msg5 = await page.textContent('[data-testid="mats-msg"]');
  check('Ohne HEX-Spalte: „Spalte HEX fehlt“ statt „0 importiert“', /Spalte „HEX“ fehlt/.test(msg5) && !(await page.isVisible('[data-testid="import-preview"]')), msg5);

  // ---------- 6. Vorlage herunterladen
  const tpl = await download(page, 'template-csv', 'vorlage.csv');
  const tplText = tpl.bytes.toString('utf8').replace(/^﻿/, '');
  const tplLines = tplText.trim().split(/\r?\n/);
  check('Vorlage: Kopfzeile + Beispielzeile im Exportformat', tplLines.length === 2 && tplLines[0].startsWith('ID;Materialart;Hersteller') && /;12,5;/.test(tplLines[1]) && /Beispielzeile/.test(tplLines[1]), tpl.name);

  // ---------- 7. Löschen eines verwendeten Materials nennt die Projekte
  await page.goto(BASE);
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]', { timeout: 30000 });
  const projects = await idb(page, 'all', 'projects');
  const proj = projects[0];
  proj.palette = [
    { code: 1, name: 'Blau', hex: '#3A6EA5', lab: [45, -2, -35], materialId: sicis.id },
    { code: 2, name: 'Blau 2', hex: '#3A6EA5', lab: [45, -2, -35], materialId: sicis.id },
  ];
  await idb(page, 'put', 'projects', proj.meta.id, proj);
  const proj2 = JSON.parse(JSON.stringify(proj));
  proj2.meta.id = 'e2e-mc-kueche';
  proj2.meta.name = 'Küche Auswahl';
  proj2.palette = [];
  proj2.settings.materialIds = [sicis.id];
  await idb(page, 'put', 'projects', proj2.meta.id, proj2);
  await page.goto(BASE + '#/materials');
  await page.waitForSelector('[data-testid="materials-table"]');
  let dialogText = '';
  page.once('dialog', async (d) => {
    dialogText = d.message();
    await d.dismiss();
  });
  await page.click('tr:has-text("Sicis") [data-testid="delete-material"]');
  await page.waitForTimeout(500);
  check(
    'Lösch-Rückfrage nennt beide Projekte mit Farbanzahl bzw. Auswahl',
    dialogText.includes(`„${proj.meta.name}“ (2 Farben)`) && dialogText.includes('„Küche Auswahl“ (Materialauswahl)') && /in 2 Projekten verwendet/.test(dialogText) && /Rastermaß/.test(dialogText),
    dialogText.replace(/\s+/g, ' ').slice(0, 220),
  );
  check('Abbrechen löscht nicht', (await idb(page, 'all', 'materials')).some((m) => m.id === sicis.id));
  let dialog2 = '';
  page.once('dialog', async (d) => {
    dialog2 = d.message();
    await d.accept();
  });
  await page.click('tr:has-text("Orsoni") [data-testid="delete-material"]');
  await page.waitForTimeout(500);
  check('Unbenutztes Material: einfache Rückfrage, wird gelöscht', !/verwendet/.test(dialog2) && /Orsoni/.test(dialog2) && !(await idb(page, 'all', 'materials')).some((m) => m.manufacturer === 'Orsoni'), dialog2.replace(/\s+/g, ' '));

  // ---------- 8. Englisch: Export mit Komma/Dezimalpunkt, Rundreise
  await page.goto(BASE + '#/settings');
  await page.click('[data-testid="lang-select"] >> text=English');
  await page.waitForTimeout(300);
  await page.goto(BASE + '#/materials');
  await page.waitForSelector('[data-testid="materials-table"]');
  const expEn = await download(page, 'export-csv', 'export_en.csv');
  const enText = expEn.bytes.toString('utf8');
  check('Export en: Komma, Dezimalpunkt, englische Kopfzeile', enText.includes('ID,Type,Manufacturer,') && enText.includes(',13.9,') && enText.includes('"Bad; Küche"') === false && enText.includes('Bad; Küche'), expEn.name);
  await upload(page, 'export_en.csv', expEn.bytes);
  const sum8 = await waitPreview(page);
  check('Re-Import (en): 0 new · 2 identical', /0 new/.test(sum8) && /2 identical/.test(sum8), sum8);
  await page.click('[data-testid="import-cancel"]');
  await page.goto(BASE + '#/settings');
  await page.click('[data-testid="lang-select"] >> text=Deutsch');
  await page.waitForTimeout(300);

  // ---------- 9. Pipetten-Hinweis nur mit EyeDropper
  for (const [label, init, re] of [
    ['ohne EyeDropper → HEX-Hinweis', 'delete window.EyeDropper;', /HEX-Wert eingeben/],
    ['mit EyeDropper → Pipetten-Hinweis', "window.EyeDropper = class { async open() { return { sRGBHex: '#123456' }; } };", /Pipette/],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await ctx.addInitScript(init);
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errors.push(String(e)));
    await pg.goto(BASE + '#/materials');
    await pg.click('[data-testid="add-material"]');
    const hint = await pg.textContent('[data-testid="mat-color-hint"]');
    const btn = await pg.isVisible('button:has-text("Pipette")');
    check(`Farbhinweis ${label}`, re.test(hint) && btn === /Pipette/.test(String(re)), hint);
    if (!btn) await pg.screenshot({ path: path.join(OUT, 'mc-05-form-no-eyedropper.png') });
    await ctx.close();
  }

  // ---------- 10. Handy-Ansicht der Vorschau
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => errors.push(String(e)));
  await pp.goto(BASE + '#/materials');
  await pp.waitForSelector('[data-testid="add-material"]');
  await pp.screenshot({ path: path.join(OUT, 'mc-06-phone-page.png') });
  await upload(pp, 'excel_de.csv', Buffer.from(GERMAN_EXCEL, 'latin1'));
  await waitPreview(pp);
  const overflow = await pp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  await pp.screenshot({ path: path.join(OUT, 'mc-07-phone-preview.png') });
  check('Handy: Vorschau ohne horizontales Scrollen', !overflow);
  await phone.close();

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
