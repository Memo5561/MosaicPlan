/* E2E – Welle 5 „PDF-Schritt“ (Paket w5-pdf-export-ui) im echten Browser (Chromium/Playwright).
 * Voraussetzung: `npm run build` und `npx vite preview` laufen; pdfinfo/pdftotext/pdftoppm (poppler) installiert.
 * Aufruf: node e2e/w5-pdf-export-ui.e2e.cjs <baseUrl> <outDir>
 *
 * Geprüft:
 *  - Seitenzahl vor dem Erzeugen („ca. N Seiten“, je Teil aufgeschlüsselt): folgt den Schaltern und ist die Seitenzahl
 *    des Seitenplans – und damit genau die des erzeugten PDFs (pdfinfo)
 *  - Inhalt folgt den Schaltern (Ausgeschaltetes durchgestrichen); „An Seite anpassen“ nennt den Maßstab; Codeplan
 *    automatisch / immer / aus; Koordinaten kompakt / je Stein
 *  - Abschnittsauswahl: „A1-B2“ wählt genau A1, A2, B1, B2; „Z99“ wird mit Meldung abgelehnt; Zeile/Spalte;
 *    „Nur offene Abschnitte“
 *  - kleine Speichergrenze: Export in Teilen, je Klick genau ein Download, jedes Teil-PDF enthält nur seine Abschnitte
 *  - Vermerk „Export läuft“ wird gesetzt und gelöscht; stehen gebliebener Vermerk → Hinweis und gesenkte Grenze
 *  - veraltete Berechnung: Bestätigung nötig; Foto ersetzt ohne Neuberechnung → PDF ohne Seite „Originalfoto“
 *  - Abbrechen; Handybreite ohne waagerechtes Scrollen; Englisch/Türkisch ohne fehlende Texte
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w5-pdf-export-ui');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const pdfPageCount = (file) => Number((execFileSync('pdfinfo', [file], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/) || [])[1]);
const pdfPageTexts = (file) => execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }).split('\f');
/** Blattnummern („A1-2“) der Verlegeblätter eines PDFs */
function sheetIdsOf(file) {
  const ids = new Set();
  for (const t of pdfPageTexts(file)) {
    if (!/Kontrollstrecke/.test(t)) continue;
    for (const m of t.matchAll(/Blatt ([A-Z]+\d+-\d+) \(\d+\/\d+\)/g)) ids.add(m[1]);
  }
  return ids;
}
function render(file, pageNo, name) {
  try {
    execFileSync('pdftoppm', ['-r', '60', '-f', String(pageNo), '-l', String(pageNo), '-png', '-singlefile', file, path.join(OUT, name)]);
  } catch {
    /* nur Bild für die Sichtprüfung */
  }
}

/** wartet, bis der Seitenplan gemessen ist, und liefert Gesamtzahl und Inhalt */
async function plan(page) {
  await page.waitForSelector('[data-testid="pdf-plan"][data-state="ready"]', { timeout: 120000 });
  const total = Number(await page.getAttribute('[data-testid="pdf-plan"]', 'data-total'));
  const items = await page.$$eval('[data-testid="pdf-contents"] li', (els) => els.map((e) => ({ part: e.dataset.part, off: e.dataset.off === 'yes', pages: e.dataset.pages === '' ? null : Number(e.dataset.pages), struck: getComputedStyle(e.querySelector('.w5pe-c-name')).textDecorationLine.includes('line-through') })));
  const by = Object.fromEntries(items.map((i) => [i.part, i]));
  const sum = items.reduce((a, i) => a + (i.off ? 0 : i.pages || 0), 0);
  const text = ((await page.textContent('[data-testid="pdf-total"]')) || '').trim();
  return { total, items, by, sum, text };
}
async function setToggle(page, label, on) {
  const lab = page.locator(`label.toggle:has-text("${label}")`).first();
  const box = lab.locator('input[type="checkbox"]');
  if ((await box.isChecked()) !== on) await lab.click();
  await wait(100);
}
/** erzeugt das PDF als eine Datei und speichert den Download */
async function generate(page, name) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), page.click('[data-testid="pdf-btn"]')]);
  const file = path.join(OUT, name);
  await download.saveAs(file);
  await page.waitForSelector('[data-testid="pdf-done"]', { timeout: 60000 });
  return file;
}
const selected = async (page) => (await page.getAttribute('[data-testid="section-picker"]', 'data-selected')) || '';
const primaryChips = async (page) => page.$$eval('[data-testid="sec-cell"].primary', (els) => els.map((e) => e.textContent.trim()));
async function openSample(page, key) {
  await page.goto(BASE);
  await page.waitForSelector(`[data-testid="sample-${key}"]`);
  await page.click(`[data-testid="sample-${key}"]`);
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 240000 });
  await wait(800);
}
async function goPdf(page) {
  await page.click('[data-testid="step-pdf"]');
  await page.waitForSelector('[data-testid="pdf-step"]');
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 950 }, acceptDownloads: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Schreibzugriffe auf den Vermerk „Export läuft“ mitschreiben
  await context.addInitScript(() => {
    window.__flagLog = [];
    const set = Storage.prototype.setItem;
    const rem = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === 'mp.pdfInFlight') window.__flagLog.push(['set', v]);
      return set.call(this, k, v);
    };
    Storage.prototype.removeItem = function (k) {
      if (k === 'mp.pdfInFlight') window.__flagLog.push(['remove']);
      return rem.call(this, k);
    };
  });

  // ================================================================ 1. Porträt: Seitenzahl, Schalter, Maßstab
  await openSample(page, 'portrait');
  await goPdf(page);
  let p = await plan(page);
  await page.screenshot({ path: path.join(OUT, 'w5pe-01-step.png'), fullPage: true });
  check('Vor dem Erzeugen: „ca. N Seiten“, je Teil aufgeschlüsselt (Summe der Teile = Gesamtzahl)', /^ca\. \d+ Seiten$/.test(p.text) && p.total > 10 && p.sum === p.total && p.by.sheets.pages > 0, `${p.text}; ${p.items.filter((i) => !i.off).map((i) => `${i.part} ${i.pages}`).join(', ')}`);
  const sheetsAttr = Number(await page.getAttribute('[data-testid="pdf-plan"]', 'data-sheets'));
  check('Verlegeblätter in der Liste = Blattaufteilung', sheetsAttr === p.by.sheets.pages, `${sheetsAttr}`);

  const file1 = await generate(page, 'w5pe-standard.pdf');
  const pages1 = pdfPageCount(file1);
  check('Schätzung = Seitenplan = Seiten des erzeugten PDFs (Standard)', pages1 === p.total, `geschätzt ${p.total}, PDF ${pages1}`);
  const done1 = await page.textContent('[data-testid="pdf-done"]');
  const name1 = await page.getAttribute('[data-testid="pdf-done"]', 'data-name');
  check('Nach dem Erzeugen: Größe, „Öffnen“, „Erneut herunterladen“ und Speicherhinweis', /PDF erstellt \([\d.,]+ (KB|MB)\)/.test(done1) && (await page.isVisible('[data-testid="pdf-open"]')) && (await page.isVisible('[data-testid="pdf-download"]')) && (await page.isVisible('[data-testid="pdf-save-note"]')) && /_verlegeplan\.pdf$/.test(name1), `${name1}`);
  const flag1 = await page.evaluate(() => ({ log: window.__flagLog.map((x) => x[0]), now: localStorage.getItem('mp.pdfInFlight'), first: window.__flagLog.find((x) => x[0] === 'set') }));
  const flagInfo = flag1.first ? JSON.parse(flag1.first[1]) : {};
  check('Vermerk „Export läuft“: vor dem Auftrag gesetzt, danach gelöscht', flag1.log.includes('set') && flag1.log[flag1.log.length - 1] === 'remove' && flag1.now === null && flagInfo.stones > 0 && flagInfo.bytes > 0 && flagInfo.budgetBytes > 0, `${flag1.log.join(',')}; ${flagInfo.stones} Steine, ${Math.round(flagInfo.bytes / 1024)} KB, Grenze ${Math.round(flagInfo.budgetBytes / 1048576)} MB`);
  const origPages1 = pdfPageTexts(file1).filter((t) => /Originalfoto/.test(t)).length;
  check('Standard-PDF enthält die Seite „Originalfoto“', origPages1 >= 1, `${origPages1} Seite(n)`);

  // Schnittvorlagen aus
  const before = p;
  await setToggle(page, 'Schnittvorlagen', false);
  p = await plan(page);
  // ohne gedruckte Vorlagen ändern sich auch andere Teile (z. B. nennt die Koordinatenliste die Vorlagen als „nicht im PDF“)
  // – deshalb zählt die gemessene Gesamtzahl, nicht „alte Zahl minus Vorlagenseiten“
  check(
    'Schnittvorlagen aus: Eintrag durchgestrichen, Schätzung neu gemessen und kleiner (Summe der Teile = Gesamtzahl)',
    p.by.templates.off && p.by.templates.struck && before.by.templates.pages > 0 && p.sum === p.total && p.total < before.total,
    `${before.total} → ${p.total}; ${p.items.filter((i) => !i.off).map((i) => `${i.part} ${i.pages}`).join(', ')}`,
  );
  check('Fertige Datei verschwindet, wenn sich die Optionen ändern (gehört zu den alten Angaben)', !(await page.isVisible('[data-testid="pdf-done"]')));
  // Bilder aus
  const b2 = p;
  await setToggle(page, 'Originalfoto und Mosaikvorschau', false);
  p = await plan(page);
  check('Bilder aus: 2 Seiten weniger, Originalfoto und Mosaikvorschau durchgestrichen', p.total === b2.total - 2 && p.by.original.off && p.by.preview.off && p.by.original.struck && p.by.preview.struck, `${b2.total} → ${p.total}`);
  // Koordinaten aus
  const b3 = p;
  await setToggle(page, 'Koordinatenlisten', false);
  p = await plan(page);
  check('Koordinaten aus: Schätzung sinkt um deren Seiten, Eintrag durchgestrichen', p.total === b3.total - b3.by.coords.pages && p.by.coords.off && b3.by.coords.pages > 0, `${b3.total} → ${p.total}`);
  await page.screenshot({ path: path.join(OUT, 'w5pe-02-toggles-off.png'), fullPage: true });
  const file2 = await generate(page, 'w5pe-lean.pdf');
  check('Schätzung = Seiten des PDFs (ohne Vorlagen, Bilder, Koordinaten)', pdfPageCount(file2) === p.total, `geschätzt ${p.total}, PDF ${pdfPageCount(file2)}`);

  // Koordinaten je Stein
  await setToggle(page, 'Koordinatenlisten', true);
  const compact = await plan(page);
  await page.click('[data-testid="pdf-coordmode"] button:has-text("Je Stein")');
  p = await plan(page);
  const limitVisible = await page.isVisible('.field:has(.field-label:text("Max. Steine in Koordinatenlisten")) input');
  check('Koordinaten „Je Stein“: viel mehr Seiten als kompakt; Höchstzahl nur hier einstellbar', p.by.coords.pages > compact.by.coords.pages * 3 && limitVisible, `kompakt ${compact.by.coords.pages} S., je Stein ${p.by.coords.pages} S.`);
  const file3 = await generate(page, 'w5pe-perstone.pdf');
  check('Schätzung = Seiten des PDFs (Koordinaten je Stein)', pdfPageCount(file3) === p.total, `geschätzt ${p.total}, PDF ${pdfPageCount(file3)}`);
  await page.click('[data-testid="pdf-coordmode"] button:has-text("Kompakt")');
  await plan(page);
  check('Zurück auf „Kompakt“: Höchstzahl-Feld ausgeblendet', !(await page.isVisible('.field:has(.field-label:text("Max. Steine in Koordinatenlisten")) input')));

  // Codeplan
  const auto = await plan(page);
  await page.click('[data-testid="pdf-codeplan"] button:has-text("Immer")');
  p = await plan(page);
  check('Codeplan „Immer“: Codeplan-Seiten kommen dazu', auto.by.codePlans.pages === 0 && p.by.codePlans.pages > 0 && p.total === auto.total + p.by.codePlans.pages, `+${p.by.codePlans.pages} S.`);
  await page.click('[data-testid="pdf-codeplan"] button:has-text("Aus")');
  p = await plan(page);
  check('Codeplan „Aus“: Eintrag durchgestrichen', p.by.codePlans.off && p.by.codePlans.struck);
  await page.click('[data-testid="pdf-codeplan"] button:has-text("Automatisch")');

  // An Seite anpassen
  const fitLabel = ((await page.textContent('[data-testid="pdf-fit-scale"]')) || '').trim();
  await page.click('.field:has(.field-label:text("Maßstab der Verlegeblätter")) button:text-is("An Seite anpassen")');
  p = await plan(page);
  const fitNote = (await page.textContent('[data-testid="pdf-fit-note"]')) || '';
  const scale = (fitLabel.match(/\(([\d:,]+)\)/) || [])[1];
  const file4 = await generate(page, 'w5pe-fit.pdf');
  const cover4 = pdfPageTexts(file4)[0];
  check('„An Seite anpassen“ nennt den Maßstab; derselbe steht auf dem Deckblatt; ein Blatt je Abschnitt', !!scale && fitNote.includes(scale) && cover4.includes(scale) && p.by.sheets.pages === 4 && pdfPageCount(file4) === p.total, `${fitLabel}; Blätter ${p.by.sheets.pages}; geschätzt ${p.total}, PDF ${pdfPageCount(file4)}`);
  await page.click('.field:has(.field-label:text("Maßstab der Verlegeblätter")) button:text-is("1:1")');
  await setToggle(page, 'Schnittvorlagen', true);
  await setToggle(page, 'Originalfoto und Mosaikvorschau', true);
  const base = await plan(page);

  // ================================================================ 2. Veraltete Berechnung: Bestätigung
  await page.click('[data-testid="step-shapes"]');
  await page.click('[data-testid="cut-focus-preset"]');
  await page.waitForSelector('[data-testid="stale-badge"]');
  await goPdf(page);
  await page.waitForSelector('[data-testid="pdf-stale"]');
  const staleText = (await page.textContent('[data-testid="pdf-stale"]')) || '';
  const disabledStale = await page.isDisabled('[data-testid="pdf-btn"]');
  check('Veraltete Berechnung: Warnung im Schritt, „PDF erzeugen“ gesperrt bis zur Bestätigung', disabledStale && /zuletzt berechnete Mosaik/.test(staleText) && (await page.isVisible('[data-testid="pdf-need-confirm"]')), staleText.slice(0, 110));
  await page.screenshot({ path: path.join(OUT, 'w5pe-03-stale.png'), fullPage: true });
  await page.click('[data-testid="pdf-stale-recompute"]');
  await wait(300);
  check('„Jetzt neu berechnen“ führt zu Schritt 7', /\/compute$/.test(page.url()), page.url().split('#')[1]);
  await goPdf(page);
  check('Bestätigung gilt nicht stillschweigend weiter (nach Schrittwechsel wieder gesperrt)', await page.isDisabled('[data-testid="pdf-btn"]'));
  await page.check('[data-testid="pdf-stale-confirm"]');
  check('„Mit alter Berechnung exportieren“ bestätigt: Export möglich', !(await page.isDisabled('[data-testid="pdf-btn"]')) && !(await page.isVisible('[data-testid="pdf-need-confirm"]')));
  p = await plan(page);
  const file5 = await generate(page, 'w5pe-stale.pdf');
  check('Export mit alter Berechnung erzeugt das zuletzt berechnete Mosaik (gleiche Seitenzahl wie vorher)', pdfPageCount(file5) === p.total && p.total === base.total, `geschätzt ${p.total}, PDF ${pdfPageCount(file5)}`);
  // Änderung verwerfen → wieder aktuell
  await page.click('[data-testid="step-compute"]');
  await page.waitForSelector('[data-testid="discard-changes"]');
  await page.click('[data-testid="discard-changes"]');
  await wait(600);
  await goPdf(page);
  check('Nach „Änderungen verwerfen“: keine Warnung, Export ohne Bestätigung', !(await page.isVisible('[data-testid="pdf-stale"]')) && !(await page.isDisabled('[data-testid="pdf-btn"]')));

  // ================================================================ 3. Foto ersetzt ohne Neuberechnung
  await page.click('[data-testid="step-photo"]');
  await page.waitForSelector('[data-testid="photo-replace"]', { state: 'attached' });
  await page.setInputFiles('[data-testid="photo-replace"]', { name: 'stadt.png', mimeType: 'image/png', buffer: fs.readFileSync(path.join(__dirname, '..', 'public', 'samples', 'city.png')) });
  await page.waitForSelector('[data-testid="replace-dialog"]', { timeout: 30000 });
  await page.click('[data-testid="replace-in-project"]');
  await page.waitForSelector('[data-testid="stale-badge"]', { timeout: 30000 });
  await wait(800);
  await goPdf(page);
  await page.waitForSelector('[data-testid="pdf-photo-replaced"]');
  p = await plan(page);
  const origNote = (await page.textContent('[data-testid="pdf-contents"] li[data-part="original"]')) || '';
  check('Foto ersetzt: Hinweis im Schritt; „Originalfoto“ durchgestrichen mit Grund; Schätzung eine Seite weniger', p.by.original.off && p.by.original.struck && /ersetzt/.test(origNote) && !p.by.preview.off && p.total === base.total - 1, `${origNote.trim().slice(0, 90)}; ${base.total} → ${p.total}`);
  await page.screenshot({ path: path.join(OUT, 'w5pe-04-photo-replaced.png'), fullPage: true });
  check('Auch hier: Export erst nach Bestätigung', await page.isDisabled('[data-testid="pdf-btn"]'));
  await page.check('[data-testid="pdf-stale-confirm"]');
  const file6 = await generate(page, 'w5pe-photo-replaced.pdf');
  const texts6 = pdfPageTexts(file6);
  const orig6 = texts6.filter((t) => /Originalfoto/.test(t)).length;
  check('PDF nach Fotowechsel ohne Neuberechnung: keine Seite „Originalfoto“, Mosaikvorschau bleibt', orig6 === 0 && texts6.some((t) => /Mosaikvorschau/.test(t)) && pdfPageCount(file6) === p.total, `„Originalfoto“ auf ${orig6} Seiten; geschätzt ${p.total}, PDF ${pdfPageCount(file6)}`);
  render(file6, 2, 'w5pe-photo-replaced-p2');

  // ================================================================ 4. Landschaft: Abschnittsauswahl
  await openSample(page, 'landscape');
  await goPdf(page);
  await plan(page);
  const nCols = await page.locator('[data-testid="sec-col"]').count();
  const nRows = await page.locator('[data-testid="sec-row"]').count();
  const nCells = await page.locator('[data-testid="sec-cell"]').count();
  check('Abschnittsraster wie im Mosaik (Zeilen = Buchstaben, Spalten = Nummern)', nCols >= 3 && nRows >= 3 && nCells === nCols * nRows && (await selected(page)) === 'all', `${nCols} × ${nRows} = ${nCells}`);

  await page.fill('[data-testid="sec-range"]', 'A1-B2');
  await page.press('[data-testid="sec-range"]', 'Enter');
  await wait(900);
  const selA = await selected(page);
  const chipsA = await primaryChips(page);
  const stored = await page.evaluate(
    () =>
      new Promise((res) => {
        const id = location.hash.split('/')[2];
        const rq = indexedDB.open('mosaicplan');
        rq.onsuccess = () => {
          const g = rq.result.transaction('projects').objectStore('projects').get(id);
          g.onsuccess = () => res(g.result && g.result.pdfOptions ? g.result.pdfOptions.sectionIds : undefined);
          g.onerror = () => res('error');
        };
        rq.onerror = () => res('error');
      }),
  );
  check('Bereich „A1-B2“ wählt genau A1, A2, B1 und B2 (auch gespeichert)', selA === 'A1,A2,B1,B2' && JSON.stringify(chipsA) === '["A1","A2","B1","B2"]' && JSON.stringify(stored) === '["A1","A2","B1","B2"]', `${selA}; gespeichert: ${JSON.stringify(stored)}`);
  const sumA = (await page.textContent('[data-testid="sec-summary"]')) || '';
  check('Zusammenfassung nennt Anzahl und Bereich', new RegExp(`4 von ${nCells} Abschnitten gewählt: A1-B2`).test(sumA), sumA.trim());
  p = await plan(page);
  check('Seitenzahl gilt für die Auswahl (4 Abschnitte)', (await page.textContent('[data-testid="pdf-plan"]')).includes('Abschnitte: 4'), `ca. ${p.total} Seiten`);

  await page.fill('[data-testid="sec-range"]', 'Z99');
  await page.click('[data-testid="sec-range-apply"]');
  await wait(200);
  const errZ = (await page.textContent('[data-testid="sec-range-error"]').catch(() => '')) || '';
  check('„Z99“ wird mit Meldung abgelehnt, Auswahl unverändert', /Abschnitt Z99 gibt es nicht/.test(errZ) && /nicht geändert/.test(errZ) && (await selected(page)) === 'A1,A2,B1,B2', errZ.trim());
  await page.screenshot({ path: path.join(OUT, 'w5pe-05-range-error.png'), fullPage: true });
  await page.fill('[data-testid="sec-range"]', 'A1, B2x');
  await page.press('[data-testid="sec-range"]', 'Enter');
  await wait(200);
  const errS = (await page.textContent('[data-testid="sec-range-error"]').catch(() => '')) || '';
  check('Unlesbarer Eintrag: Meldung, nichts wird still weggelassen', /B2X/.test(errS) && (await selected(page)) === 'A1,A2,B1,B2', errS.trim());
  await page.fill('[data-testid="sec-range"]', 'c1 – c2; a3');
  await page.press('[data-testid="sec-range"]', 'Enter');
  await wait(200);
  check('Schreibweisen (klein, Halbgeviertstrich, Semikolon) werden verstanden; Feld zeigt die übliche Schreibweise', (await selected(page)) === 'A3,C1,C2' && (await page.inputValue('[data-testid="sec-range"]')) === 'A3, C1-C2', `${await selected(page)} → „${await page.inputValue('[data-testid="sec-range"]')}“`);

  // Zeile, Spalte, einzelner Abschnitt, Alle
  await page.click('[data-testid="sec-all"]');
  await page.click('[data-testid="sec-row"][data-row="B"]');
  const rowB = await selected(page);
  check('Zeilenbuchstabe wählt die ganze Zeile', rowB === Array.from({ length: nCols }, (_, i) => `B${i + 1}`).join(','), rowB);
  await page.click('[data-testid="sec-col"][data-col="1"]');
  const withCol = (await selected(page)).split(',');
  check('Spaltennummer fügt die ganze Spalte hinzu', withCol.length === nCols + nRows - 1 && withCol.includes('A1') && withCol.includes('C1'), withCol.join(','));
  await page.click('[data-testid="sec-row"][data-row="B"]');
  check('Vollständig gewählte Zeile erneut antippen: Zeile abgewählt', !(await selected(page)).split(',').some((x) => x.startsWith('B')), await selected(page));
  await page.click('[data-testid="sec-cell"][data-section="A1"]');
  check('Abschnitt antippen wählt ab', !(await selected(page)).split(',').includes('A1'), await selected(page));
  await page.click('[data-testid="sec-all"]');
  check('„Alle“ setzt die Auswahl zurück', (await selected(page)) === 'all' && (await primaryChips(page)).length === 0);
  check('Ohne fertig verlegte Abschnitte kein „Nur offene Abschnitte“ (wäre dasselbe wie „Alle“)', !(await page.isVisible('[data-testid="sec-open"]')));

  // Nur offene Abschnitte: A1 im Verlegeplan fertig markieren
  await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="section-cell"]');
  await page.click('[data-testid="section-cell"][data-section="A1"]');
  await page.click('[data-testid="section-done"]');
  await wait(600);
  await goPdf(page);
  await page.waitForSelector('[data-testid="sec-open"]');
  const openLabel = ((await page.textContent('[data-testid="sec-open"]')) || '').trim();
  await page.click('[data-testid="sec-open"]');
  const openSel = (await selected(page)).split(',');
  check('„Nur offene Abschnitte“ wählt alle außer dem fertig verlegten A1', openSel.length === nCells - 1 && !openSel.includes('A1') && openLabel.includes(String(nCells - 1)), `${openLabel}; ${openSel.length} gewählt`);
  await page.screenshot({ path: path.join(OUT, 'w5pe-06-picker.png'), fullPage: true });

  // ================================================================ 5. Abbrechen
  await page.click('[data-testid="sec-all"]');
  await plan(page);
  let gotDownload = false;
  const onDl = () => (gotDownload = true);
  page.on('download', onDl);
  await page.click('[data-testid="pdf-btn"]');
  await page.waitForSelector('[data-testid="pdf-cancel"]');
  const lockedWhileBusy = await page.isDisabled('[data-testid="sec-all"]');
  await page.click('[data-testid="pdf-cancel"]');
  await page.waitForSelector('[data-testid="pdf-cancelled"]', { timeout: 30000 });
  await wait(1500);
  const flagAfterCancel = await page.evaluate(() => localStorage.getItem('mp.pdfInFlight'));
  check('Abbrechen: Auftrag beendet, keine Datei, kein Download, Vermerk gelöscht, Optionen waren gesperrt', !gotDownload && flagAfterCancel === null && lockedWhileBusy && !(await page.isVisible('[data-testid="pdf-done"]')) && !(await page.isVisible('[data-testid="pdf-busy"]')) && !(await page.isVisible('[data-testid="pdf-error"]')), ((await page.textContent('[data-testid="pdf-cancelled"]')) || '').trim().slice(0, 60));
  page.off('download', onDl);

  // ================================================================ 6. Kleine Speichergrenze: Export in Teilen
  await page.fill('[data-testid="sec-range"]', 'A1-B3');
  await page.press('[data-testid="sec-range"]', 'Enter');
  const single = await plan(page);
  const singleFile = await generate(page, 'w5pe-a1-b3-single.pdf');
  const singleIds = sheetIdsOf(singleFile);
  // Grenze so wählen, dass die 6 Abschnitte in 3 Teile zu je 2 Abschnitten fallen: Richtwert je Abschnitt aus dem Vermerk
  const lastFlag = await page.evaluate(() => JSON.parse(window.__flagLog.filter((x) => x[0] === 'set').pop()[1]));
  const perSection = lastFlag.bytes / 6;
  const budgetMb = Math.round(((perSection * 2.4) / 1048576) * 100) / 100;
  await page.evaluate((mb) => localStorage.setItem('mp.pdfBudgetMb', String(mb)), budgetMb);
  await page.reload();
  await page.waitForSelector('[data-testid="pdf-step"]');
  await page.waitForSelector('[data-testid="pdf-parts"]');
  await plan(page);
  const nParts = Number(await page.getAttribute('[data-testid="pdf-parts"]', 'data-parts'));
  const partDefs = await page.$$eval('[data-testid="pdf-part"]', (els) => els.map((e) => ({ no: Number(e.dataset.part), ids: e.dataset.sections.split(','), text: e.textContent })));
  const partsText = (await page.textContent('[data-testid="pdf-parts"]')) || '';
  check(
    'Kleine Speichergrenze: Export in Teilen statt „PDF erzeugen“ – aufeinanderfolgende Abschnitte, jeder genau einmal',
    nParts >= 2 && !(await page.isVisible('[data-testid="pdf-btn"]')) && partDefs.flatMap((x) => x.ids).join(',') === 'A1,A2,A3,B1,B2,B3' && /Richtwerte/.test(partsText) && /unvollständig/.test(partsText),
    `${nParts} Teile: ${partDefs.map((x) => x.ids.join('+')).join(' | ')}; Grenze ${budgetMb} MB`,
  );
  const partsTotal = Number(await page.getAttribute('[data-testid="pdf-parts-total"]', 'data-total'));
  check('Seitenzahl der Teile zusammen wird genannt (jeder Teil mit eigenem Vorspann)', partsTotal > single.total && partDefs.every((x) => /ca\. \d+ Seiten/.test(x.text)), `eine Datei ca. ${single.total}, ${nParts} Teile zusammen ca. ${partsTotal}`);
  await page.screenshot({ path: path.join(OUT, 'w5pe-07-parts.png'), fullPage: true });

  const partFiles = [];
  let downloads = 0;
  const countDl = () => downloads++;
  page.on('download', countDl);
  for (let i = 0; i < nParts; i++) {
    const nextLabel = ((await page.textContent('[data-testid="pdf-part-next"]')) || '').trim();
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), page.click('[data-testid="pdf-part-next"]')]);
    const file = path.join(OUT, `w5pe-part-${i + 1}.pdf`);
    await download.saveAs(file);
    await page.waitForSelector(`[data-testid="pdf-part"][data-part="${i + 1}"][data-done="yes"]`, { timeout: 60000 });
    const fname = await page.getAttribute(`[data-testid="pdf-part"][data-part="${i + 1}"] [data-testid="pdf-part-file"]`, 'data-name');
    partFiles.push({ file, fname, nextLabel });
    await wait(300);
  }
  page.off('download', countDl);
  check('Je Klick genau ein Download – nie mehrere auf einmal', downloads === nParts, `${downloads} Downloads für ${nParts} Teile`);
  check('Schaltfläche nennt den nächsten Teil; Dateiname nennt Teil und Abschnitte', partFiles.every((f, i) => f.nextLabel.includes(`Teil ${i + 1}/${nParts}`) && new RegExp(`_verlegeplan_Teil-${i + 1}-von-${nParts}_`).test(f.fname)), partFiles.map((f) => f.fname).join(' · '));
  const union = new Set();
  let onlyOwn = true;
  let overlap = false;
  const perPart = [];
  partFiles.forEach((f, i) => {
    const ids = sheetIdsOf(f.file);
    perPart.push(`${[...new Set([...ids].map((x) => x.split('-')[0]))].join('+')}`);
    for (const id of ids) {
      if (!partDefs[i].ids.includes(id.split('-')[0])) onlyOwn = false;
      if (union.has(id)) overlap = true;
      union.add(id);
    }
    if (ids.size === 0) onlyOwn = false;
  });
  check('Jedes Teil-PDF enthält nur die Verlegeblätter seiner Abschnitte', onlyOwn && !overlap, perPart.join(' | '));
  check('Alle Teile zusammen: genau die Blätter des Exports als eine Datei (gleiche Blattnummern)', union.size === singleIds.size && [...singleIds].every((x) => union.has(x)), `${union.size} Blätter in ${nParts} Teilen, ${singleIds.size} in einer Datei`);
  check('Nach dem letzten Teil: „Alle Teile sind erzeugt“; jede Datei bleibt zum erneuten Herunterladen', (await page.isVisible('[data-testid="pdf-parts-done"]')) && (await page.locator('[data-testid="pdf-part-file"] [data-testid="pdf-download"]').count()) === nParts);
  await page.screenshot({ path: path.join(OUT, 'w5pe-08-parts-done.png'), fullPage: true });
  render(partFiles[1].file, 1, 'w5pe-part-2-p1');

  // „Trotzdem als eine Datei“ und Grenze zurücksetzen
  await page.click('.w5pe-anyway summary');
  await page.click('[data-testid="pdf-single-anyway"]');
  check('„Trotzdem als eine Datei“: ausdrücklicher Schritt mit Warnung, danach „PDF erzeugen“', (await page.isVisible('[data-testid="pdf-single-warning"]')) && (await page.isVisible('[data-testid="pdf-btn"]')));
  await page.click('[data-testid="pdf-single-warning"] button');
  await page.waitForSelector('[data-testid="pdf-parts"]');
  const src = await page.getAttribute('[data-testid="pdf-budget"]', 'data-source');
  await page.click('[data-testid="pdf-budget-reset"]');
  await page.waitForSelector('[data-testid="pdf-btn"]');
  check('„Grenze zurücksetzen“: gespeicherte Grenze entfernt, wieder eine Datei', src === 'override' && (await page.evaluate(() => localStorage.getItem('mp.pdfBudgetMb'))) === null && !(await page.isVisible('[data-testid="pdf-parts"]')));

  // ================================================================ 7. Stehen gebliebener Vermerk (nicht beendeter Export)
  await page.evaluate(() => localStorage.setItem('mp.pdfInFlight', JSON.stringify({ projectId: 'weg', projectName: 'Großes Wandbild', sections: 40, stones: 180000, bytes: 360 * 1048576, budgetBytes: 1200 * 1048576, at: Date.now() - 60000 })));
  await page.reload();
  await page.waitForSelector('[data-testid="pdf-step"]');
  await page.waitForSelector('[data-testid="pdf-crash-note"]', { timeout: 15000 });
  const crashText = (await page.textContent('[data-testid="pdf-crash-note"]')) || '';
  const after = await page.evaluate(() => ({ flag: localStorage.getItem('mp.pdfInFlight'), mb: Number(localStorage.getItem('mp.pdfBudgetMb')) }));
  check(
    'Nicht beendeter Export: Hinweis „vermutlich zu groß … in Teilen exportieren“, Vermerk gelöscht, Speichergrenze auf die Hälfte seines Richtwerts gesenkt',
    /zu groß für dieses Gerät/.test(crashText) && /in Teilen exportieren/.test(crashText) && /Großes Wandbild/.test(crashText) && /180\.000/.test(crashText) && after.flag === null && after.mb === 180,
    `Grenze jetzt ${after.mb} MB; ${crashText.slice(0, 80)}`,
  );
  await page.screenshot({ path: path.join(OUT, 'w5pe-09-crash-note.png'), fullPage: true });
  await page.click('[data-testid="step-plan"]');
  await goPdf(page);
  check('Hinweis bleibt bis „Verstanden“ (auch nach Schrittwechsel)', await page.isVisible('[data-testid="pdf-crash-note"]'));
  await page.click('[data-testid="pdf-crash-dismiss"]');
  check('„Verstanden“ schließt den Hinweis', !(await page.isVisible('[data-testid="pdf-crash-note"]')));
  await page.evaluate(() => localStorage.removeItem('mp.pdfBudgetMb'));
  await page.reload();
  await page.waitForSelector('[data-testid="pdf-step"]');
  check('Ohne Vermerk: kein Hinweis', !(await page.isVisible('[data-testid="pdf-crash-note"]')));

  // ================================================================ 8. Sprachen
  for (const [lang, word] of [
    ['en', 'approx.'],
    ['tr', 'yakl.'],
  ]) {
    await page.selectOption('select.lang', lang);
    await wait(300);
    const pl = await plan(page);
    const body = (await page.textContent('[data-testid="pdf-step"]')) || '';
    check(`${lang.toUpperCase()}: Schritt vollständig übersetzt (keine Schlüssel), Seitenzahl mit „${word}“`, !/w5pe\.|pdfui\./.test(body) && pl.text.includes(word), pl.text);
    if (lang === 'tr') await page.screenshot({ path: path.join(OUT, 'w5pe-10-tr.png'), fullPage: true });
  }
  await page.selectOption('select.lang', 'de');
  await wait(300);

  // ================================================================ 9. Handy
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, acceptDownloads: true });
  const pp = await phone.newPage();
  pp.on('pageerror', (e) => errors.push(`phone: ${String(e)}`));
  await openSample(pp, 'portrait');
  await goPdf(pp);
  const ph = await plan(pp);
  const ov = await overflow(pp);
  check('Handy (390 px): kein waagerechtes Scrollen, Seitenzahl sichtbar', ov <= 0 && ph.total > 10, `Überlauf ${ov} px, ${ph.text}`);
  await pp.screenshot({ path: path.join(OUT, 'w5pe-11-phone.png'), fullPage: true });
  await pp.evaluate(() => localStorage.setItem('mp.pdfBudgetMb', '3'));
  await pp.reload();
  await pp.waitForSelector('[data-testid="pdf-parts"]');
  await plan(pp);
  const ov2 = await overflow(pp);
  check('Handy: Export in Teilen ohne waagerechtes Scrollen', ov2 <= 0, `Überlauf ${ov2} px`);
  await pp.screenshot({ path: path.join(OUT, 'w5pe-12-phone-parts.png'), fullPage: true });
  await pp.evaluate(() => localStorage.removeItem('mp.pdfBudgetMb'));
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
