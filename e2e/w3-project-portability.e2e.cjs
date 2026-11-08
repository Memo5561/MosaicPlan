/* Browser-Prüfung „Projekt zwischen Geräten übertragen – mit Materialien“ (w3-project-portability).
 * Voraussetzung: `npm run build` und `npx vite preview --port <port>` laufen.
 * Aufruf: node e2e/w3-project-portability.e2e.cjs <baseUrl> <ausgabeOrdner>
 *
 * Gerät A (eigener Browser-Kontext): fünf Materialien, Testprojekt Porträt mit „Nur eigene Materialien“,
 * berechnet. Steindetail und Materialberechnung werden abgelesen, das Projekt exportiert.
 * Gerät B (frischer Kontext, leere Datenbank): Import → Rückmeldung „X neu angelegt, 0 zugeordnet, 0 abweichend“,
 * Steindetail zeigt dasselbe Material (nicht „?“ / „Material fehlt“), „Rohsteine inkl. Reserve“ und Kosten wie
 * auf Gerät A, Projekt nicht „Einstellungen geändert“. Zweiter Import: Name mit „(Import)“, alles zugeordnet, keine
 * doppelten Materialien. Dritter Import nach geändertem Preis: „1 mit abweichenden Daten“, Material bleibt.
 * Gerät C: Datei im alten Format (Version 1) → Warnung „Datei enthält keine Materialien – N Farben …“;
 * Englisch und Türkisch vollständig; fremde Datei → verständliche Fehlermeldung; Handy-Ansicht ohne Überlauf.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output', 'w3-project-portability');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const shot = (page, name, full = false) => page.screenshot({ path: path.join(OUT, name), fullPage: full }).catch(() => {});

const MATS = [
  ['01', '#2A1D18', 'Espresso'],
  ['02', '#6E4632', 'Kastanie'],
  ['03', '#B98266', 'Terrakotta hell'],
  ['04', '#E6CFBC', 'Elfenbein'],
  ['05', '#56688A', 'Taubenblau'],
].map(([no, hex, name], i) => ({
  id: `e2e-w3pp-${no}`,
  type: 'glass',
  manufacturer: 'E2E-Glas',
  product: 'Portabel',
  colorNumber: `W3PP-${no}`,
  colorName: name,
  hex,
  lengthMm: 20,
  widthMm: 10,
  thicknessMm: 4,
  price: 3.5 + i,
  packageSize: 'Beutel',
  piecesPerPack: 150,
  notes: '',
}));

/** Schreibt Materialien direkt in die lokale Datenbank (wie eine frühere Erfassung). */
async function putMaterials(page, mats) {
  await page.evaluate(
    (list) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('mosaicplan');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('materials', 'readwrite');
          for (const m of list) tx.objectStore('materials').put(m, m.id);
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    mats,
  );
}

async function getMaterials(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('mosaicplan');
        req.onsuccess = () => {
          const db = req.result;
          const r = db.transaction('materials', 'readonly').objectStore('materials').getAll();
          r.onsuccess = () => {
            db.close();
            resolve(r.result);
          };
          r.onerror = () => reject(r.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
}

/** Steindetail an fester Stelle öffnen und ablesen (gleiche Stelle ⇒ gleicher Stein auf beiden Geräten). */
async function readStone(page, name) {
  const canvas = await page.$('[data-testid="mosaic-canvas"]');
  const box = await canvas.boundingBox();
  const x = box.x + box.width * 0.5;
  const y = box.y + box.height * 0.42;
  await page.mouse.move(x, y);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(400);
  await page.mouse.click(x, y);
  await page.waitForSelector('[data-testid="stone-id"]');
  await page.waitForTimeout(200);
  const info = await page.evaluate(() => {
    const modal = document.querySelector('[data-testid="stone-id"]').closest('.modal') || document.body;
    const text = modal.textContent.replace(/\s+/g, ' ');
    const m = text.match(/Material: (E2E-Glas Portabel W3PP-\d\d)/);
    return { id: document.querySelector('[data-testid="stone-id"]').textContent.trim(), material: m ? m[1] : null, text };
  });
  await shot(page, name);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  return info;
}

/** Materialberechnung (Verlegeplan → Material) ablesen. */
async function readCalc(page, name) {
  await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="progress-pct"]');
  // w4-laying-workbench: „Material & Einkauf“ ist eine eigene Ansicht über dem Viewer (nicht mehr in der Seitenleiste)
  await page.locator('[data-testid="plan-view"] button', { hasText: /^Material/ }).click();
  await page.waitForSelector('[data-testid="material-calc"] [data-testid="mc-pieces"]', { timeout: 30000 });
  await page.waitForTimeout(1500); // Statistik-Worker
  const calc = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="material-calc"]');
    const kv = {};
    for (const tr of root.querySelectorAll('table.kv tr')) {
      const th = tr.querySelector('th');
      const td = tr.querySelector('td');
      if (th && td) kv[th.textContent.trim()] = td.textContent.trim();
    }
    const shop = [...root.querySelectorAll('[data-testid="mc-shop-row"]')].map((tr) => tr.getAttribute('data-material'));
    return { kv, shop, text: root.textContent };
  });
  const mc = await page.$('[data-testid="material-calc"]');
  if (mc) await mc.screenshot({ path: path.join(OUT, name) }).catch(() => {});
  return calc;
}

async function importFile(page, file) {
  await page.setInputFiles('[data-testid="project-import-input"]', file);
  await page.waitForSelector('[data-testid="project-import-summary"], [data-testid="projects-error"]', { timeout: 30000 });
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const s = document.querySelector('[data-testid="project-import-summary"]');
    const err = document.querySelector('[data-testid="projects-error"]');
    if (!s) return { error: err ? err.textContent : 'nichts' };
    const mats = s.querySelector('[data-testid="project-import-materials"]');
    return {
      text: s.textContent,
      materials: mats ? { text: mats.textContent, x: +mats.dataset.inserted, y: +mats.dataset.linked, z: +mats.dataset.differing } : null,
      renamed: (s.querySelector('[data-testid="project-import-renamed"]') || {}).textContent || '',
      missing: (s.querySelector('[data-testid="project-import-missing"]') || {}).textContent || '',
      pool: (s.querySelector('[data-testid="project-import-pool"]') || {}).textContent || '',
      notes: [...s.querySelectorAll('[data-testid="project-import-notes"] li')].map((li) => ({ kind: li.dataset.kind, text: li.textContent })),
      attention: s.dataset.attention,
      fits: document.documentElement.scrollWidth <= window.innerWidth + 1,
    };
  });
}

function collectErrors(page, list) {
  page.on('pageerror', (e) => list.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && list.push(m.text()));
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const VIEW = { viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE' };

  // ===================== Gerät A
  const ctxA = await browser.newContext(VIEW);
  const a = await ctxA.newPage();
  collectErrors(a, errors);
  await a.goto(BASE);
  await a.waitForSelector('[data-testid="new-project"]');
  await putMaterials(a, MATS);
  await a.reload();
  await a.waitForSelector('[data-testid="sample-portrait"]');
  await a.click('[data-testid="sample-portrait"]');
  await a.waitForSelector('[data-testid="compute-btn"]');
  await a.click('[data-testid="step-colors"]');
  await a.waitForSelector('[data-testid="palette-mode"]');
  await a.locator('[data-testid="palette-mode"] button').nth(2).click(); // „Nur eigene Materialien“
  await a.waitForTimeout(300);
  await a.click('[data-testid="step-compute"]');
  await a.waitForSelector('[data-testid="compute-btn"]');
  await a.click('[data-testid="compute-btn"]');
  await a.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
  await a.waitForTimeout(1500);
  const stoneA = await readStone(a, 'w3pp-01-deviceA-stone.png');
  check('Gerät A: Steindetail nennt das Material', !!stoneA.material, `${stoneA.id} · ${stoneA.material}`);
  const calcA = await readCalc(a, 'w3pp-02-deviceA-matcalc.png');
  const rawA = calcA.kv['Rohsteine inkl. Reserve'];
  const costA = calcA.kv['Kosten'] || '';
  check('Gerät A: Materialberechnung mit Rohsteinen und Kosten', /\d/.test(rawA || '') && /\d/.test(costA) && !/unvollständig/.test(costA), `Rohsteine inkl. Reserve ${rawA} · Kosten ${costA}`);
  await a.waitForTimeout(800); // Speichern abwarten

  await a.goto(`${BASE}#/projects`);
  await a.waitForSelector('[data-testid="project-export"]');
  const [dl] = await Promise.all([a.waitForEvent('download', { timeout: 30000 }), a.click('[data-testid="project-export"] >> nth=0')]);
  const file = path.join(OUT, 'w3pp-export.mosaicplan.json');
  await dl.saveAs(file);
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const palIds = [...new Set(payload.record.palette.map((p) => p.materialId).filter(Boolean))];
  const fileIds = (payload.materials || []).map((m) => m.id);
  check(
    'Export: Version 2 mit genau den verknüpften Materialien (nicht dem ganzen Katalog)',
    payload.version === 2 && palIds.length > 0 && palIds.length === payload.record.palette.length && fileIds.length === palIds.length && palIds.every((id) => fileIds.includes(id)),
    `${payload.record.palette.length} Farben, ${fileIds.length} Materialien in der Datei, Katalog ${MATS.length}`,
  );
  check('Export: Auswahl „alle Materialien“ – Größe des Quellkatalogs vermerkt', payload.materialPool && payload.materialPool.count === MATS.length, JSON.stringify(payload.materialPool));
  await ctxA.close();

  // ===================== Gerät B (leere Datenbank)
  const ctxB = await browser.newContext(VIEW);
  const b = await ctxB.newPage();
  collectErrors(b, errors);
  await b.goto(`${BASE}#/projects`);
  await b.waitForSelector('[data-testid="project-import"]');
  check('Gerät B: noch keine Materialien', (await getMaterials(b)).length === 0);
  const imp1 = await importFile(b, file);
  await shot(b, 'w3pp-03-deviceB-import.png');
  check(
    'Gerät B: Rückmeldung „X neu angelegt, 0 vorhandenen zugeordnet, 0 mit abweichenden Daten“',
    imp1.materials && imp1.materials.x === fileIds.length && imp1.materials.y === 0 && imp1.materials.z === 0 && /Materialien: \d+ neu angelegt, 0 vorhandenen zugeordnet, 0 mit abweichenden Daten/.test(imp1.materials.text),
    imp1.materials ? imp1.materials.text : imp1.error,
  );
  const NAME = payload.record.meta.name;
  check('Gerät B: Name ohne Zusatz, keine fehlenden Materialien', !imp1.renamed && !imp1.missing && imp1.text.includes(`„${NAME}“ wurde importiert`), imp1.text.slice(0, 80));
  const poolShown = fileIds.length !== MATS.length;
  check('Gerät B: Hinweis zur Auswahl „alle Materialien“ nur bei abweichender Anzahl', poolShown ? imp1.pool.includes(`Quellgerät ${MATS.length}`) && imp1.pool.includes(`diesem Gerät ${fileIds.length}`) : !imp1.pool, imp1.pool || '(kein Hinweis)');
  const matsB = await getMaterials(b);
  check(
    'Gerät B: Materialien mit ursprünglicher ID und unveränderten Daten angelegt',
    matsB.length === fileIds.length && matsB.every((m) => JSON.stringify(m) === JSON.stringify(MATS.find((x) => x.id === m.id))),
    matsB.map((m) => m.id).join(', '),
  );

  // Projekt öffnen
  await b.click('[data-testid="project-import-open"]');
  await b.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 60000 });
  await b.waitForTimeout(1500);
  check('Gerät B: importiertes Projekt gilt nicht als „Einstellungen geändert“', !(await b.isVisible('[data-testid="stale-badge"]')));
  const stoneB = await readStone(b, 'w3pp-04-deviceB-stone.png');
  check(
    'Gerät B: Steindetail zeigt den Materialnamen (nicht „?“ / „Material fehlt“) – wie auf Gerät A',
    stoneB.id === stoneA.id && stoneB.material === stoneA.material && !/Material fehlt/.test(stoneB.text) && !/Material: \?/.test(stoneB.text),
    `${stoneB.id} · ${stoneB.material}`,
  );
  const calcB = await readCalc(b, 'w3pp-05-deviceB-matcalc.png');
  check('Gerät B: „Rohsteine inkl. Reserve“ wie auf Gerät A', calcB.kv['Rohsteine inkl. Reserve'] === rawA, `${calcB.kv['Rohsteine inkl. Reserve']} = ${rawA}`);
  check('Gerät B: Kosten wie auf Gerät A, vollständig', (calcB.kv['Kosten'] || '') === costA, `${calcB.kv['Kosten']} = ${costA}`);
  check('Gerät B: Einkaufsliste mit denselben Materialien', JSON.stringify([...calcB.shop].sort()) === JSON.stringify([...calcA.shop].sort()), calcB.shop.join(', '));
  await b.waitForTimeout(500);

  // Zweiter Import derselben Datei: alles zugeordnet, Name mit Zusatz, keine doppelten Materialien
  await b.goto(`${BASE}#/projects`);
  await b.waitForSelector('[data-testid="project-import"]');
  const imp2 = await importFile(b, file);
  check(
    'Zweiter Import: 0 neu angelegt, alle vorhandenen zugeordnet, 0 abweichend',
    imp2.materials && imp2.materials.x === 0 && imp2.materials.y === fileIds.length && imp2.materials.z === 0,
    imp2.materials ? imp2.materials.text : imp2.error,
  );
  check('Zweiter Import: Name „… (Import)“', imp2.renamed.includes(`„${NAME} (Import)“`), imp2.renamed);
  check('Zweiter Import: keine doppelten Materialien', (await getMaterials(b)).length === fileIds.length);

  // Dritter Import, nachdem auf Gerät B ein Preis geändert wurde: Material bleibt, Abweichung gemeldet
  const changed = { ...matsB[0], price: 9.99 };
  await putMaterials(b, [changed]);
  await b.reload();
  await b.waitForSelector('[data-testid="project-import"]');
  const imp3 = await importFile(b, file);
  await shot(b, 'w3pp-06-deviceB-differs.png');
  const after = (await getMaterials(b)).find((m) => m.id === changed.id);
  check(
    'Dritter Import: „1 mit abweichenden Daten“, Hinweis nennt den Preis, vorhandenes Material unverändert',
    imp3.materials && imp3.materials.z === 1 && imp3.notes.length === 1 && imp3.notes[0].kind === 'differs' && /Preis/.test(imp3.notes[0].text) && /9,99/.test(imp3.notes[0].text) && after.price === 9.99,
    imp3.notes.map((n) => n.text).join(' | '),
  );
  check('Dritter Import: Name „… (Import 2)“, Rückmeldung als Hinweis markiert', imp3.renamed.includes(`„${NAME} (Import 2)“`) && imp3.attention === '1', imp3.renamed);
  // Handy-Ansicht der Rückmeldung
  await b.setViewportSize({ width: 360, height: 780 });
  await b.waitForTimeout(300);
  const phoneFits = await b.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  await shot(b, 'w3pp-07-phone-summary.png', true);
  check('Handy 360 px: Rückmeldung ohne waagrechten Überlauf', phoneFits);
  await ctxB.close();

  // ===================== Gerät C: Datei im alten Format (Version 1, ohne Materialien)
  const v1 = { ...payload, version: 1 };
  delete v1.materials;
  delete v1.materialPool;
  const fileV1 = path.join(OUT, 'w3pp-export-v1.mosaicplan.json');
  fs.writeFileSync(fileV1, JSON.stringify(v1));
  const ctxC = await browser.newContext(VIEW);
  const c = await ctxC.newPage();
  collectErrors(c, errors);
  await c.goto(`${BASE}#/projects`);
  await c.waitForSelector('[data-testid="project-import"]');
  const imp4 = await importFile(c, fileV1);
  await shot(c, 'w3pp-08-v1-warning.png');
  const nCol = payload.record.palette.length;
  check(
    'Version-1-Datei: „Datei enthält keine Materialien – N Farben ohne gültiges Material“',
    imp4.missing.includes(`Datei enthält keine Materialien – ${nCol} Farben ohne gültiges Material`) && /Rastermaß/.test(imp4.missing) && !imp4.materials,
    imp4.missing.slice(0, 120) || imp4.error,
  );
  check('Version-1-Datei: Projekt trotzdem importiert', (await c.$$('[data-testid="project-row"]')).length === 1);

  // Sprachen: Rückmeldung wird in EN/TR vollständig übersetzt
  await c.selectOption('select.lang', 'en');
  await c.waitForTimeout(200);
  const en = await c.textContent('[data-testid="project-import-summary"]');
  check('Englisch: Rückmeldung übersetzt', en.includes(`The file contains no materials – ${nCol} colours without a valid material`) && /has been imported/.test(en) && !/projimp\./.test(en), en.slice(0, 120));
  await c.selectOption('select.lang', 'tr');
  await c.waitForTimeout(200);
  const trText = await c.textContent('[data-testid="project-import-summary"]');
  check('Türkisch: Rückmeldung übersetzt', trText.includes(`Dosyada malzeme yok – geçerli malzemesi olmayan ${nCol} renk`) && /içe aktarıldı/.test(trText) && !/projimp\./.test(trText), trText.slice(0, 120));
  await c.selectOption('select.lang', 'de');
  await c.waitForTimeout(200);

  // Fremde Datei: verständliche Fehlermeldung, nichts importiert
  const bad = path.join(OUT, 'w3pp-not-a-project.json');
  fs.writeFileSync(bad, JSON.stringify({ hello: 'world' }));
  const imp5 = await importFile(c, bad);
  check('Fremde Datei: Fehlermeldung „keine MosaicPlan-Projektdatei“, nichts importiert', /keine MosaicPlan-Projektdatei/.test(imp5.error || '') && (await c.$$('[data-testid="project-row"]')).length === 1, imp5.error);
  await ctxC.close();

  check('Keine Konsolen- oder Seitenfehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
