/* Browser-Test w1-mosaic-core: eigene Palette bleibt über „Berechnen“ stabil, Farbe entfernen mit
 * Bestätigung und wählbarer Ersatzfarbe, „Palette aus Materialien“ führt zusammen statt zu verwürfeln.
 * Aufruf: node e2e/w1-mosaic-core.e2e.cjs <baseUrl> <outDir>   (vorher: npm run build && npx vite preview)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output', 'w1-mosaic-core');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

// eigene Palette (Porträt): Gelb verwendet kein Stein
const CUSTOM = [
  ['#F4F1EA', 'Weiß'],
  ['#1E1A18', 'Schwarz'],
  ['#E8B494', 'Haut'],
  ['#4E2C1C', 'Braun'],
  ['#7FA0BA', 'Blaugrau'],
  ['#A02432', 'Rot'],
  ['#2E4A62', 'Dunkelblau'],
  ['#FFFF00', 'Gelb'],
];
// Materialien: vier mit exakt gleicher Farbe wie Palettenfarben, zwei neue
const MATERIALS = [
  ['W-01', '#F4F1EA'],
  ['BR-04', '#4E2C1C'],
  ['HA-03', '#E8B494'],
  ['BG-05', '#7FA0BA'],
  ['DR-11', '#6A1420'],
  ['HB-12', '#9BBDD3'],
];

const digits = (s) => parseInt(String(s).replace(/\D/g, ''), 10);

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  /** Zeilen der Farblegende: Nummer, HEX, Steine (null = noch keine Statistik), unbenutzt-Markierung */
  const rows = () =>
    page.$$eval('[data-testid="palette-table"] tbody tr', (trs) =>
      trs.map((tr) => {
        const td = tr.querySelectorAll('td');
        const stones = td[5].childNodes[0] ? td[5].childNodes[0].textContent.trim() : '';
        return {
          code: td[0].textContent.trim(),
          hex: td[3].textContent.trim(),
          stones: /\d/.test(stones) ? parseInt(stones.replace(/\D/g, ''), 10) : null,
          unused: tr.getAttribute('data-unused') === 'true',
          tag: (tr.querySelector('.w1mc-tag') || { textContent: '' }).textContent.trim(),
        };
      }),
    );
  const sum = (rs) => rs.reduce((s, r) => s + (r.stones || 0), 0);
  /** wartet, bis die Statistik zur Palette passt (alle Zeilen mit Zahl) und optional eine Bedingung erfüllt ist */
  const waitRows = async (cond = () => true, ms = 30000) => {
    const t0 = Date.now();
    let rs = [];
    while (Date.now() - t0 < ms) {
      rs = await rows();
      if (rs.length && rs.every((r) => r.stones !== null) && cond(rs)) return rs;
      await page.waitForTimeout(250);
    }
    return rs;
  };
  const compute = async () => {
    await page.click('[data-testid="step-compute"]');
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
    await page.click('[data-testid="step-colors"]');
    await page.waitForSelector('[data-testid="palette-table"]');
  };

  // ---------- Materialien anlegen
  await page.goto(BASE + '#/materials');
  for (const [no, hex] of MATERIALS) {
    await page.click('[data-testid="add-material"]');
    await page.fill('[data-testid="mat-manufacturer"]', 'E2E');
    await page.fill('[data-testid="mat-colornumber"]', no);
    await page.fill('[data-testid="mat-hex"]', hex);
    await page.click('[data-testid="save-material"]');
    await page.waitForTimeout(250);
  }
  const matText = await page.textContent('[data-testid="materials-table"]');
  check('6 Materialien angelegt', MATERIALS.every(([no]) => matText.includes(no)));

  // ---------- Porträt mit eigener Palette (8 Farben, Gelb unbenutzt)
  await page.goto(BASE);
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="step-colors"]');
  await page.click('[data-testid="palette-mode"] >> text=Eigene Palette');
  for (const [hex] of CUSTOM) {
    await page.fill('input[aria-label="Neue Farbe"]', hex.toLowerCase());
    await page.click('button:has-text("Farbe hinzufügen")');
  }
  const before = await rows();
  check(
    'Eigene Palette mit 8 Farben angelegt',
    before.length === 8 && before.map((r) => r.hex).join() === CUSTOM.map((c) => c[0]).join(),
    before.map((r) => `${r.code}=${r.hex}`).join(' '),
  );

  await compute();
  const after1 = await waitRows((rs) => rs.some((r) => r.unused));
  await page.screenshot({ path: path.join(OUT, 'w1mc-01-custom-after-compute.png'), fullPage: true });
  check(
    'Nach Berechnen: alle 8 Farben in Eingabereihenfolge mit Nummern 01–08',
    after1.length === 8 && after1.map((r) => r.hex).join() === CUSTOM.map((c) => c[0]).join() && after1.map((r) => r.code).join() === '01,02,03,04,05,06,07,08',
    after1.map((r) => `${r.code}=${r.hex}:${r.stones}`).join(' '),
  );
  const yellow = after1.find((r) => r.hex === '#FFFF00');
  check('Gelb bleibt mit 0 Steinen erhalten und ist als „nicht verwendet“ markiert', yellow && yellow.stones === 0 && yellow.unused && yellow.tag === 'nicht verwendet', JSON.stringify(yellow));
  const usedTxt = (await page.textContent('[data-testid="palette-used-count"]').catch(() => '')) || '';
  check('Kopfzeile zeigt „7 von 8 verwendet“', usedTxt.includes('7 von 8 verwendet'), usedTxt);
  const total = sum(after1);

  await compute();
  const after2 = await waitRows((rs) => sum(rs) === total);
  check(
    'Zweites Berechnen: identische Palette und Stückzahlen',
    after2.map((r) => `${r.code}${r.hex}${r.stones}`).join() === after1.map((r) => `${r.code}${r.hex}${r.stones}`).join(),
    `Summe ${sum(after2)} = ${total}`,
  );

  // ---------- Farbe 06 (Rot) entfernen, Ersatzfarbe bewusst „08 Gelb“ wählen
  const red = after2[5];
  await page.click('[data-testid="palette-remove"] >> nth=5');
  await page.waitForSelector('[data-testid="palette-remove-dialog"]');
  const stonesTxt = await page.textContent('[data-testid="palette-remove-stones"]');
  check('Entfernen fragt nach und nennt die betroffenen Steine', digits(stonesTxt) === red.stones, `${stonesTxt.trim()} (Tabelle: ${red.stones})`);
  const firstOpt = await page.$eval('[data-testid="palette-remove-target"] option', (o) => o.textContent);
  check('Ersatzfarbe: Vorschlag ist die nächste Farbe nach ΔE', /\(nächste\)/.test(firstOpt), firstOpt);
  const yellowValue = await page.$eval('[data-testid="palette-remove-target"]', (s) => [...s.options].find((o) => o.textContent.startsWith('08 ')).value);
  await page.selectOption('[data-testid="palette-remove-target"]', yellowValue);
  const swap = await page.textContent('[data-testid="palette-remove-swap"]');
  check('Gewählte Ersatzfarbe wird angezeigt', swap.includes('06') && swap.includes('08'), swap.replace(/\s+/g, ' '));
  const rmNote = await page.textContent('[data-testid="palette-remove-note"]');
  check('Eigene Palette: Hinweis „Nummern bleiben – auch beim Neuberechnen“', /auch beim Neuberechnen/.test(rmNote), rmNote.trim());
  await page.screenshot({ path: path.join(OUT, 'w1mc-02-remove-dialog.png') });
  await page.click('[data-testid="palette-remove-confirm"]');
  const after3 = await waitRows((rs) => rs.length === 7 && (rs.find((r) => r.code === '08') || {}).stones === red.stones);
  const notice = await page.textContent('[data-testid="palette-notice"]');
  check('Farbe entfernt, Steine auf die gewählte Farbe 08 umgestellt', after3.length === 7 && (after3.find((r) => r.code === '08') || {}).stones === red.stones, notice.trim());
  check('Gesamtzahl der Steine unverändert', sum(after3) === total, `${sum(after3)} = ${total}`);
  check('Nummern der übrigen Farben unverändert', after3.map((r) => r.code).join() === '01,02,03,04,05,07,08', after3.map((r) => r.code).join());

  // Abbrechen ändert nichts
  await page.click('[data-testid="palette-remove"] >> nth=0');
  await page.waitForSelector('[data-testid="palette-remove-dialog"]');
  await page.click('.modal-foot >> text=Abbrechen');
  check('Abbrechen lässt die Palette unverändert', (await rows()).length === 7);

  // ---------- Neu berechnen nach dem Entfernen: eigene Palette behält Nummern (Lücke bei 06 bleibt)
  await compute();
  // warten, bis die Statistik zum neuen Raster gehört (08 hatte nach dem Entfernen alle Steine der 06)
  const yellowAfterRemove = (after3.find((r) => r.code === '08') || {}).stones;
  const after3b = await waitRows((rs) => rs.length === 7 && sum(rs) === total && (rs.find((r) => r.code === '08') || {}).stones !== yellowAfterRemove);
  check(
    'Neu berechnen nach dem Entfernen: Nummern und Farben bleiben (01–05, 07, 08)',
    after3b.map((r) => `${r.code}=${r.hex}`).join() === after3.map((r) => `${r.code}=${r.hex}`).join(),
    after3b.map((r) => `${r.code}=${r.hex}`).join(' '),
  );

  // ---------- Palette aus Materialien: zusammenführen
  const gone = after3b.filter((r) => ['#1E1A18', '#2E4A62', '#FFFF00'].includes(r.hex));
  const expectedMoved = gone.reduce((s, r) => s + r.stones, 0);
  await page.click('[data-testid="palette-from-materials"]');
  await page.waitForSelector('[data-testid="palette-merge-dialog"]');
  const summary = await page.textContent('[data-testid="palette-merge-summary"]');
  const removedList = await page.textContent('[data-testid="palette-merge-removed"]');
  await page.screenshot({ path: path.join(OUT, 'w1mc-03-merge-dialog.png') });
  check('Zusammenführen fragt nach: Anzahl umzustellender Steine und max. ΔE', digits(summary.split('(')[0]) === expectedMoved && /ΔE/.test(summary), `${summary.trim()} (erwartet ${expectedMoved})`);
  check('Liste der entfernten Farben (02, 07, 08)', /02/.test(removedList) && /07/.test(removedList) && /08/.test(removedList));
  await page.click('[data-testid="palette-merge-apply"]');
  const after4 = await waitRows((rs) => rs.length === 6 && sum(rs) === total);
  await page.screenshot({ path: path.join(OUT, 'w1mc-04-after-merge.png'), fullPage: true });
  check('Nach Zusammenführen: vorhandene Nummern bleiben, neue Farben 09/10 angehängt', after4.map((r) => r.code).join() === '01,03,04,05,09,10', after4.map((r) => `${r.code}=${r.hex}`).join(' '));
  check('Gesamtzahl der Steine nach Zusammenführen unverändert', sum(after4) === total, `${sum(after4)} = ${total}`);
  const keptSame = ['#F4F1EA', '#E8B494', '#4E2C1C', '#7FA0BA'].every((h) => after4.some((r) => r.hex === h));
  check('Verknüpfte Farben behalten ihre Farbe', keptSame);
  const notice2 = await page.textContent('[data-testid="palette-notice"]');
  check('Hinweis nach dem Zusammenführen nennt die umgestellten Steine', notice2.includes(expectedMoved.toLocaleString('de-DE')), notice2.trim());

  // ---------- Neu berechnen nach dem Zusammenführen: Nummern bleiben (01, 03, 04, 05, 09, 10)
  await compute();
  const after5 = await waitRows((rs) => rs.length === 6 && sum(rs) === total);
  check(
    'Neu berechnen nach dem Zusammenführen: Nummern und Farben bleiben',
    after5.map((r) => `${r.code}=${r.hex}`).join() === after4.map((r) => `${r.code}=${r.hex}`).join(),
    after5.map((r) => `${r.code}=${r.hex}`).join(' '),
  );

  // ---------- Andere Farbquelle: Entfernen gilt nur bis zum Neuberechnen – der Dialog sagt das
  await page.click('[data-testid="palette-mode"] >> text=Automatisch (K-Means)');
  await page.click('[data-testid="palette-remove"] >> nth=0');
  await page.waitForSelector('[data-testid="palette-remove-dialog"]');
  const autoNote = await page.textContent('[data-testid="palette-remove-note"]');
  check('Automatisch: Dialog empfiehlt kein Neuberechnen, sondern warnt, dass die Farbe zurückkehren kann', /zurückkehren/.test(autoNote) && !/optimale Farbzuordnung/.test(autoNote), autoNote.trim());
  await page.click('.modal-foot >> text=Abbrechen');
  const caveat = await page.textContent('[data-testid="palette-recompute-caveat"]').catch(() => '');
  check('Automatisch: Hinweis unter der Palette, dass Neu berechnen die Palette neu erstellt', /zurückkehren/.test(caveat || ''), (caveat || '').trim());
  await page.click('[data-testid="palette-mode"] >> text=Eigene Palette');

  // ---------- Handy-Breite: Dialog passt
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('[data-testid="palette-remove"] >> nth=1');
  await page.waitForSelector('[data-testid="palette-remove-dialog"]');
  const fits = await page.$eval('.modal', (m) => m.getBoundingClientRect().right <= window.innerWidth + 0.5 && document.documentElement.scrollWidth <= window.innerWidth + 0.5);
  await page.screenshot({ path: path.join(OUT, 'w1mc-05-phone-dialog.png') });
  check('Dialog auf Handy-Breite ohne waagerechtes Scrollen', fits);
  await page.click('.modal-foot >> text=Abbrechen');

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
