/* Paket w6-compare-batch im echten Browser (Chromium/Playwright).
 * Aufruf: node e2e/w6-compare-batch.e2e.cjs <baseUrl> <outDir>
 *
 * Prüft in Schritt 8 (Vorschau):
 *  - Abweichungskarte Foto ↔ Stein: Ebene über dem Mosaik deckungsgleich (Pixel einer Zelle = Farbe ihrer Legendenklasse,
 *    auch nach Zoom), Legende zählt alle Steine; schraffiert („keine Fotoreferenz“) nur Freiform – und nur genau diese Zelle.
 *  - „Größte Abweichungen“: 50 Steine absteigend, Sprung öffnet das Steindetail; Umfärben weg von der Fotofarbe erhöht,
 *    „Auf nächste Farbe ändern“ senkt das gelistete ΔE; Strg+Z stellt es wieder her.
 *  - Bereich bearbeiten: Rechteck aufziehen, „Farbe A → B“ ändert genau die Zahl des Probelaufs, die Gesamtzahl der
 *    Steine bleibt, Strg+Z stellt alles wieder her (ein Verlaufseintrag). Heller/Dunkler: Zuordnung, Zahlen, Rückgängig.
 *  - Vorschau als PNG: Download mit Maßen innerhalb der Grenze (Desktop 40 MP, lange Seite wie gewählt), Textfeld
 *    „Vorschau – kein maßstäblicher Plan“; Abschnitt als PNG; am Handy höchstens 16 MP, kein 8000-px-Knopf.
 *  - Handy 390 × 844: Werkzeuge ohne waagrechtes Scrollen bedienbar.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w6-compare-batch');
fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
let passed = 0;
function check(name, ok, info = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  let v = await fn();
  while (!v && Date.now() - t0 < ms) {
    await wait(120);
    v = await fn();
  }
  return v;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

/** ProjectApi aus den React-Props eines Elements (nur lesen) */
const withApi = (page, sel, src) =>
  page.evaluate(
    ([sel, src]) => {
      const el = document.querySelector(sel);
      const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      let f = key ? el[key] : null;
      while (f && !(f.memoizedProps && f.memoizedProps.api && f.memoizedProps.api.editCell)) f = f.return;
      if (!f) return { error: 'no api' };
      // eslint-disable-next-line no-new-func
      return new Function('api', src)(f.memoizedProps.api);
    },
    [sel, src],
  );
const statsOf = (page) =>
  withApi(
    page,
    '[data-testid="preview-tools"]',
    'const s = api.stats; if (!s || api.statsBusy) return null; if (!s.__w6id) Object.defineProperty(s, "__w6id", { value: Math.random(), enumerable: false }); return { pieces: s.pieces, per: s.perColor.map((c) => c.pieces), v: s.__w6id, area: s.stoneArea };',
  );

const blurAndKey = async (page, key) => {
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await page.keyboard.press(key);
  await wait(250);
};

/** PNG-Datei: Maße aus IHDR und iTXt-Textfelder */
function readPng(file) {
  const b = fs.readFileSync(file);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v);
  const out = { sig, width: b.readUInt32BE(16), height: b.readUInt32BE(20), texts: {} };
  let o = 8;
  while (o + 12 <= b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString('latin1', o + 4, o + 8);
    if (type === 'iTXt') {
      const body = b.subarray(o + 8, o + 8 + len);
      const z = body.indexOf(0);
      let p = z + 3;
      p = body.indexOf(0, p) + 1;
      p = body.indexOf(0, p) + 1;
      out.texts[body.toString('latin1', 0, z)] = body.subarray(p).toString('utf8');
    }
    if (type === 'IEND') break;
    o += 12 + len;
  }
  return out;
}

/** Overlay-Pixel (RGBA) an CSS-Punkt x,y im Viewer */
const overlayPixel = (page, x, y) =>
  page.evaluate(
    ([x, y]) => {
      const c = document.querySelector('[data-testid="deviation-overlay"]');
      const r = c.getBoundingClientRect();
      const sx = c.width / r.width;
      const d = c.getContext('2d').getImageData(Math.round((x - r.left) * sx), Math.round((y - r.top) * sx), 1, 1).data;
      return [...d];
    },
    [x, y],
  );

/** Bildschirmmitte (CSS-px, Seite) einer Zelle nach der Ansicht des Viewers (data-scale/ox/oy am Canvas) */
const cellCenter = (page, row, col) =>
  withApi(
    page,
    '[data-testid="preview-tools"]',
    `const L = api.computed.layout; const cv = document.querySelector('[data-testid="mosaic-canvas"]'); const r = cv.getBoundingClientRect();
     const s = +cv.dataset.scale, ox = +cv.dataset.ox, oy = +cv.dataset.oy;
     return { x: r.left + ox + (L.colX[${col}] + L.colW[${col}] / 2) * s, y: r.top + oy + (L.rowY[${row}] + L.rowH[${row}] / 2) * s, cell: Math.min(L.colW[${col}], L.rowH[${row}]) * s };`,
  );

const BIN_RGB = [
  [30, 140, 80],
  [242, 190, 30],
  [236, 104, 22],
  [196, 18, 58],
];
const binOf = (d) => (d < 2 ? 0 : d <= 5 ? 1 : d <= 10 ? 2 : 3);

async function desktop(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true, locale: 'de-DE' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(BASE);
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
  await page.waitForSelector('[data-testid="preview-tools"]');
  await wait(1200);
  const s0 = await until(() => statsOf(page), 20000);

  // ================= 1. Abweichungskarte
  await page.click('[data-testid="deviation-quick"]');
  await page.waitForSelector('[data-testid="deviation-legend"]');
  await until(() => page.$eval('[data-testid="deviation-overlay"]', (c) => c.dataset.map === '1'));
  const legend = await page.$$eval('[data-testid="deviation-bin"]', (els) => els.map((e) => parseInt((e.textContent.match(/\(([\d.]+)\)/) || [])[1]?.replace(/\./g, '') ?? '-1', 10)));
  const binSum = legend.slice(0, 4).reduce((a, b) => a + b, 0);
  check(
    'Karte an: Legende zählt jeden Stein genau einmal (4 Klassen + keine Fotoreferenz = Steine gesamt)',
    binSum + legend[4] === s0.pieces && legend[4] === 0,
    `${legend.join(' / ')} · ${s0.pieces} Steine`,
  );
  await shot(page, 'd1-overlay-fit');

  // ================= 2. Größte Abweichungen
  await page.click('[data-testid="tool-deviation"]');
  await page.waitForSelector('[data-testid="deviation-item"]');
  const items = await page.$$eval('[data-testid="deviation-item"]', (els) => els.map((e) => ({ id: e.dataset.id, de: +e.dataset.de })));
  check(
    '„Größte Abweichungen“: 50 Steine, absteigend nach ΔE',
    items.length === 50 && items.every((x, i) => i === 0 || items[i - 1].de >= x.de),
    `${items[0].id} ΔE ${items[0].de.toFixed(2)} … ${items[49].id} ΔE ${items[49].de.toFixed(2)}`,
  );
  await page.click('[data-testid="deviation-item"] >> nth=0');
  await page.waitForSelector('[data-testid="stone-id"]');
  await wait(300);
  const openedId = (await page.textContent('[data-testid="stone-id"]')).trim().split(/\s/)[0];
  const devStone = await page.$eval('[data-testid="deviation-stone"]', (e) => ({ id: e.dataset.id, de: +e.dataset.de }));
  check(
    'Sprung aus der Liste öffnet das Steindetail dieses Steins',
    openedId === items[0].id && devStone.id === items[0].id && Math.abs(devStone.de - items[0].de) < 1e-9,
    `${openedId}, ΔE ${devStone.de.toFixed(2)}`,
  );

  // Registrierung: Overlay-Pixel in der Steinmitte = Farbe der Legendenklasse (nach dem Zoom auf den Stein)
  const rc = items[0].id.match(/^([A-Z]+)(\d+)/);
  const rowOf = (s) => [...s].reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  const row0 = rowOf(rc[1]);
  const col0 = parseInt(rc[2], 10) - 1;
  await wait(200);
  const cc = await cellCenter(page, row0, col0);
  const px = await overlayPixel(page, cc.x, cc.y);
  const want = BIN_RGB[binOf(items[0].de)];
  check(
    'Overlay deckungsgleich: Pixel in der Mitte des Steins hat die Farbe seiner ΔE-Klasse (nach Zoom)',
    px[3] > 100 && Math.abs(px[0] - want[0]) <= 3 && Math.abs(px[1] - want[1]) <= 3 && Math.abs(px[2] - want[2]) <= 3,
    `Pixel ${px.join(',')} · Klasse ${binOf(items[0].de)} · Zelle ${cc.cell.toFixed(0)} px`,
  );
  await shot(page, 'd2-deviation-list-stone');

  // ================= 3. Umfärben weg von / hin zur Fotofarbe
  const titles = await (async () => {
    if (await page.$('[data-testid="colors-all"]')) await page.click('[data-testid="colors-all"]');
    return page.$$eval('[data-testid="color-pick"] button.cp', (bs) =>
      bs.map((b) => ({ code: b.dataset.code, de: parseFloat((b.title.match(/ΔE ([\d,]+)/) || [])[1]?.replace(',', '.') ?? '0'), active: b.classList.contains('active') })),
    );
  })();
  const far = titles.filter((x) => !x.active).sort((a, b) => b.de - a.de)[0];
  await page.click(`[data-testid="color-pick"] button.cp[data-code="${far.code}"]`);
  const deFar = await until(async () => {
    const v = await page.$eval('[data-testid="deviation-stone"]', (e) => +e.dataset.de);
    return v !== devStone.de ? v : null;
  });
  const listFar = await page.$$eval('[data-testid="deviation-item"]', (els, id) => (els.find((e) => e.dataset.id === id) || {}).dataset?.de, items[0].id);
  check(
    'Umfärben WEG von der Fotofarbe erhöht das ΔE des Steins (Liste folgt)',
    deFar > devStone.de && Math.abs(+listFar - deFar) < 1e-9,
    `${devStone.de.toFixed(2)} → ${deFar?.toFixed(2)} (Farbe ${far.code})`,
  );
  const hasApply = !!(await page.$('[data-testid="deviation-stone-apply"]'));
  await page.click('[data-testid="deviation-stone-apply"]');
  const deNear = await until(async () => {
    const v = await page.$eval('[data-testid="deviation-stone"]', (e) => +e.dataset.de);
    return v < deFar ? v : null;
  });
  const listNear = await page.$$eval('[data-testid="deviation-item"]', (els, id) => (els.find((e) => e.dataset.id === id) || null)?.dataset.de ?? null, items[0].id);
  check(
    'Umfärben ZUR Fotofarbe („Auf nächste Farbe ändern“) senkt das gelistete ΔE',
    hasApply && deNear !== null && deNear < deFar && deNear <= devStone.de + 1e-9 && (listNear === null || +listNear === deNear),
    `${deFar.toFixed(2)} → ${deNear?.toFixed(2)} · Liste: ${listNear === null ? 'nicht mehr unter den Top 50' : (+listNear).toFixed(2)}`,
  );
  await blurAndKey(page, 'Control+z');
  const deUndo = await until(async () => {
    const v = await page.$eval('[data-testid="deviation-stone"]', (e) => +e.dataset.de);
    return v === deFar ? v : null;
  });
  await blurAndKey(page, 'Control+z');
  const deUndo2 = await until(async () => {
    const v = await page.$eval('[data-testid="deviation-stone"]', (e) => +e.dataset.de);
    return v === devStone.de ? v : null;
  });
  check('Strg+Z stellt Farbe und ΔE Schritt für Schritt wieder her', deUndo === deFar && deUndo2 === devStone.de, `${deUndo} → ${deUndo2}`);

  // ================= 4. Schraffur nur für Freiform
  const hatchedBefore = await page.$eval('[data-testid="deviation-overlay"]', (c) => +c.dataset.hatched);
  await page.click('[data-testid="kind-free"]');
  await page.waitForSelector('[data-testid="free-save"]');
  await page.click('[data-testid="free-save"]');
  await until(async () => (await page.$eval('[data-testid="deviation-overlay"]', (c) => +c.dataset.hatched)) === 1);
  const hatchedAfter = await page.$eval('[data-testid="deviation-overlay"]', (c) => +c.dataset.hatched);
  const legendFree = await page.$$eval('[data-testid="deviation-bin"]', (els) => els.map((e) => parseInt((e.textContent.match(/\(([\d.]+)\)/) || [])[1]?.replace(/\./g, '') ?? '-1', 10)));
  const stoneNone = await page.$eval('[data-testid="deviation-stone-none"]', (e) => e.textContent).catch(() => '');
  const ccF = await cellCenter(page, row0, col0);
  const pxF = await overlayPixel(page, ccF.x - ccF.cell * 0.22, ccF.y);
  const pxF2 = await overlayPixel(page, ccF.x + ccF.cell * 0.17, ccF.y + ccF.cell * 0.11);
  const isHatchOrGrey = (p) => p[3] > 100 && (Math.abs(p[0] - p[2]) < 40 || (p[0] > 200 && p[1] > 200 && p[2] > 200));
  const freePieces = await withApi(page, '[data-testid="preview-tools"]', `const d = api.computed.data; const i = ${row0} * d.cols + ${col0}; return d.kind[i] === 5 ? d.free.get(i).length : -1;`);
  check(
    'Schraffiert („keine Fotoreferenz“) wird nur die Freiformzelle: vorher 0, danach genau 1 Zelle, Legende = ihre Teile',
    hatchedBefore === 0 && hatchedAfter === 1 && freePieces > 0 && legendFree[4] === freePieces && /Freiform/.test(stoneNone) && isHatchOrGrey(pxF) && isHatchOrGrey(pxF2),
    `vorher ${hatchedBefore}, danach ${hatchedAfter}; ${freePieces} Freiformteile; Legende ${legendFree.join(' / ')}; Pixel ${pxF.join(',')} / ${pxF2.join(',')}`,
  );
  await shot(page, 'd3-freeform-hatched');
  await blurAndKey(page, 'Control+z');
  const hatchedUndo = await until(async () => (await page.$eval('[data-testid="deviation-overlay"]', (c) => +c.dataset.hatched)) === 0);
  check('Rückgängig der Freiform: wieder keine Schraffur', !!hatchedUndo);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="legend-item"]');

  // ================= 5. Bereich bearbeiten: Farbe A → B im Rechteck
  await page.click('[data-testid="deviation-quick"]'); // Karte aus (Bild ruhiger)
  await page.click('[data-testid="tool-batch"]');
  await page.waitForSelector('[data-testid="batch-panel"]');
  await page.click('[data-testid="viewer-fit"]');
  await wait(300);
  const noScope = !!(await page.$('[data-testid="batch-noscope"]'));
  await page.click('[data-testid="batch-rect-mode"]');
  await wait(700); // Mosaik wird ins Bild geholt
  const vmode = await page.$eval('.viewer', (v) => v.dataset.mode);
  const box = await page.$eval('[data-testid="mosaic-canvas"]', (c) => {
    const r = c.getBoundingClientRect();
    const s = +c.dataset.scale;
    return { x: r.left + +c.dataset.ox, y: r.top + +c.dataset.oy, w: +c.dataset.fw * s, h: +c.dataset.fh * s };
  });
  await page.mouse.move(box.x + box.w * 0.3, box.y + box.h * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.45, { steps: 6 });
  await page.mouse.move(box.x + box.w * 0.62, box.y + box.h * 0.58, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('[data-testid="batch-selection"]');
  const range = await page.$eval('[data-testid="batch-selection"]', (e) => e.dataset.range);
  const modeAfter = await page.$eval('.viewer', (v) => v.dataset.mode);
  check('Modus „Bereich aufziehen“: Rechteck im Mosaik wählt einen Zellbereich, danach wieder Antippen', noScope && vmode === 'rect' && !!range && modeAfter === 'tap', `Bereich ${range}`);
  const selDrawn = await page.$eval('[data-testid="deviation-overlay"]', (c) => c.dataset.drawn === '1' && c.dataset.map === '0');
  check('Gewählter Bereich bleibt als Umriss sichtbar', selDrawn);

  const fromVal = await page.$eval('[data-testid="batch-from"]', (s) => s.value);
  const toOptions = await page.$$eval('[data-testid="batch-to"] option', (os) => os.map((o) => o.value));
  const toVal = toOptions.find((v) => v !== fromVal);
  await page.selectOption('[data-testid="batch-to"]', toVal);
  const dry = await page.$eval('[data-testid="batch-dryrun"]', (e) => +e.dataset.count);
  const sBefore = await until(() => statsOf(page), 10000);
  await shot(page, 'd4-batch-dryrun');
  await page.click('[data-testid="batch-apply"]');
  await page.waitForSelector('[data-testid="batch-status"]');
  const applied = await page.$eval('[data-testid="batch-status"]', (e) => +e.dataset.count);
  const sAfter = await until(async () => {
    const s = await statsOf(page);
    return s && s.v !== sBefore.v ? s : null;
  }, 15000);
  const f = +fromVal;
  const tt = +toVal;
  check(
    '„Farbe A → B“ im Rechteck ändert genau die Zahl des Probelaufs; Steine gesamt und Steinfläche unverändert',
    dry > 0 && applied === dry && sAfter && sAfter.pieces === sBefore.pieces && sAfter.area === sBefore.area && sAfter.per[f] === sBefore.per[f] - dry && sAfter.per[tt] === sBefore.per[tt] + dry,
    `Probelauf ${dry}, angewendet ${applied}; Farbe ${f}: ${sBefore.per[f]} → ${sAfter?.per[f]}, Farbe ${tt}: ${sBefore.per[tt]} → ${sAfter?.per[tt]}; gesamt ${sBefore.pieces} → ${sAfter?.pieces}`,
  );
  const undoLabel = await page.$eval('[data-testid="history-undo"]', (b) => b.title || b.textContent);
  await shot(page, 'd5-batch-applied');
  await blurAndKey(page, 'Control+z');
  const sUndo = await until(async () => {
    const s = await statsOf(page);
    return s && s.v !== sAfter.v ? s : null;
  }, 15000);
  const dryAgain = await until(async () => {
    const v = await page.$eval('[data-testid="batch-dryrun"]', (e) => +e.dataset.count).catch(() => -1);
    return v === dry ? v : null;
  });
  check(
    'Strg+Z macht die ganze Bereichsänderung in einem Schritt rückgängig (Zahlen wie vorher)',
    !!sUndo && JSON.stringify(sUndo.per) === JSON.stringify(sBefore.per) && sUndo.pieces === sBefore.pieces && dryAgain === dry,
    `Verlauf: ${String(undoLabel).replace(/\s+/g, ' ').slice(0, 90)}`,
  );

  // ================= 6. Heller/Dunkler im Abschnitt
  await page.click('[data-testid="batch-scope"] button >> nth=1');
  const secOpts = await page.$$eval('[data-testid="batch-section"] option', (os) => os.map((o) => o.value).filter(Boolean));
  await page.selectOption('[data-testid="batch-section"]', secOpts[Math.min(1, secOpts.length - 1)]);
  await page.click('[data-testid="batch-action"] button >> nth=1');
  await page.waitForSelector('[data-testid="batch-map"]');
  const shade = await page.$eval('[data-testid="batch-dryrun"]', (e) => ({ n: +e.dataset.count, kept: +e.dataset.kept }));
  const mapRows = await page.$$eval('[data-testid="batch-map"] tr', (rs) => rs.map((r) => [r.dataset.from, r.dataset.to]));
  const secPieces = await withApi(
    page,
    '[data-testid="batch-panel"]',
    `const g = api.sections; const s = g.sections.find((x) => x.id === ${JSON.stringify(secOpts[Math.min(1, secOpts.length - 1)])}); let n = 0; const d = api.computed.data; for (let r = s.r0; r < s.r1; r++) for (let c = s.c0; c < s.c1; c++) { const i = r * d.cols + c; const k = d.kind[i]; n += k === 0 ? 1 : k === 4 ? (d.sub.get(i)?.length ?? 1) : k === 5 ? (d.free.get(i)?.length ?? 0) : 2; } return n;`,
  );
  check(
    'Heller (Abschnitt): Zuordnung je Farbe; geändert + unverändert = Steine im Abschnitt',
    shade.n + shade.kept === secPieces && mapRows.length > 0,
    `${shade.n} geändert, ${shade.kept} bleiben, ${secPieces} Steine; ${mapRows.map((r) => `${r[0]}→${r[1] || '–'}`).join(' ')}`,
  );
  await shot(page, 'd6-batch-shade');
  if (shade.n > 0) {
    const sB = await until(() => statsOf(page), 10000);
    await page.click('[data-testid="batch-apply"]');
    await page.waitForSelector('[data-testid="batch-status"]');
    const cnt = await page.$eval('[data-testid="batch-status"]', (e) => +e.dataset.count);
    const sA = await until(async () => {
      const s = await statsOf(page);
      return s && s.v !== sB.v ? s : null;
    }, 15000);
    await blurAndKey(page, 'Control+z');
    const sU = await until(async () => {
      const s = await statsOf(page);
      return s && s.v !== sA.v ? s : null;
    }, 15000);
    check(
      'Heller angewendet: Zahl wie Probelauf, Steine gesamt gleich; Strg+Z zurück',
      cnt === shade.n && sA.pieces === sB.pieces && JSON.stringify(sU.per) === JSON.stringify(sB.per),
      `${cnt} Steine`,
    );
  }

  // ================= 7. Vorschau als PNG
  await page.click('[data-testid="tool-png"]');
  await page.waitForSelector('[data-testid="png-panel"]');
  const sizes = await page.$$eval('[data-testid="png-size"] button', (bs) => bs.map((b) => b.textContent));
  const label = await page.textContent('[data-testid="png-panel"]');
  check(
    'PNG: Desktop bietet 2000/4000/8000 px; beschriftet „Vorschau – kein maßstäblicher Plan“',
    sizes.length === 3 && /8\.000/.test(sizes[2]) && /Vorschau – kein maßstäblicher Plan/.test(label),
    sizes.join(' / '),
  );
  await shot(page, 'd7-png-panel');
  const download = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('[data-testid="png-save"]')]);
    const file = path.join(OUT, dl.suggestedFilename());
    await dl.saveAs(file);
    await page.waitForSelector('[data-testid="png-result"]');
    return { file, name: dl.suggestedFilename(), png: readPng(file) };
  };
  for (const [i, label] of [
    [0, '2000'],
    [2, '8000'],
  ]) {
    await page.click(`[data-testid="png-size"] button >> nth=${i}`);
    const shown = await page.$eval('[data-testid="png-dims"]', (e) => ({ w: +e.dataset.w, h: +e.dataset.h, cap: +e.dataset.cap }));
    const r = await download();
    const long = Math.max(r.png.width, r.png.height);
    check(
      `PNG ${label} px: Download mit Maßen innerhalb der Grenze (lange Seite ≤ ${label}, ≤ ${shown.cap} MP), wie angezeigt, mit Textfeld`,
      r.png.sig &&
        long <= +label &&
        r.png.width * r.png.height <= shown.cap * 1e6 &&
        r.png.width === shown.w &&
        r.png.height === shown.h &&
        r.png.texts.Description === 'Vorschau – kein maßstäblicher Plan' &&
        /_vorschau\.png$/.test(r.name),
      `${r.name}: ${r.png.width} × ${r.png.height} = ${((r.png.width * r.png.height) / 1e6).toFixed(1)} MP`,
    );
  }
  // Abschnitt
  await page.click('[data-testid="png-target"] button >> nth=1');
  await page.click('[data-testid="png-size"] button >> nth=0');
  const secShown = await page.$eval('[data-testid="png-dims"]', (e) => ({ w: +e.dataset.w, h: +e.dataset.h }));
  const rs = await download();
  check(
    'PNG eines Abschnitts: eigene Datei, Maße wie angezeigt',
    rs.png.width === secShown.w && rs.png.height === secShown.h && /_[A-Z]+\d+_vorschau\.png$/.test(rs.name),
    `${rs.name}: ${rs.png.width} × ${rs.png.height}`,
  );

  check('Desktop: keine Fehler in der Konsole', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

async function phone(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true, locale: 'de-DE' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.tap('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.tap('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
  await page.waitForSelector('[data-testid="preview-tools"]');
  await wait(1200);
  const toolbarRows = await page.$eval('.w5ue-toolbar', (e) => Math.round(e.getBoundingClientRect().height));
  const quickHidden = await page.$eval('[data-testid="deviation-quick"]', (b) => getComputedStyle(b).display === 'none');
  check('Handy: Werkzeugleiste über dem Mosaik bleibt einzeilig (ΔE-Schnellschalter nur im Reiter)', quickHidden, `Leiste ${toolbarRows} px hoch`);
  await page.$eval('[data-testid="preview-tools"]', (e) => e.scrollIntoView({ block: 'start' }));
  await page.tap('[data-testid="tool-deviation"]');
  await page.waitForSelector('[data-testid="deviation-item"]');
  await page.tap('[data-testid="deviation-panel"] .toggle');
  await page.waitForSelector('[data-testid="deviation-legend"]');
  await wait(300);
  await page.$eval('[data-testid="preview-tools"]', (e) => e.scrollIntoView({ block: 'start' }));
  await wait(200);
  await shot(page, 'p2-deviation');
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const ov1 = await overflow();
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(200);
  await shot(page, 'p1-overlay');
  // Sprung aus der Liste: Mosaik ins Bild, Steindetail als Blatt
  await page.$eval('[data-testid="preview-tools"]', (e) => e.scrollIntoView({ block: 'start' }));
  await page.tap('[data-testid="deviation-item"] >> nth=0');
  await page.waitForSelector('[data-testid="stone-id"]');
  await wait(700);
  await shot(page, 'p2b-jump');
  await page.tap('[data-testid="modal-close"]');
  await wait(300);
  await page.tap('[data-testid="tool-batch"]');
  await page.waitForSelector('[data-testid="batch-panel"]');
  await page.tap('[data-testid="batch-scope"] button >> nth=2');
  await wait(200);
  await page.$eval('[data-testid="preview-tools"]', (e) => e.scrollIntoView({ block: 'start' }));
  await shot(page, 'p3-batch');
  const ov2 = await overflow();
  await page.tap('[data-testid="tool-png"]');
  await page.waitForSelector('[data-testid="png-panel"]');
  await page.$eval('[data-testid="preview-tools"]', (e) => e.scrollIntoView({ block: 'start' }));
  await shot(page, 'p4-png');
  const sizes = await page.$$eval('[data-testid="png-size"] button', (bs) => bs.length);
  const cap = await page.$eval('[data-testid="png-dims"]', (e) => +e.dataset.cap);
  const ov3 = await overflow();
  const tabs = await page.$$eval('[data-testid^="tool-"]', (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().height)));
  check(
    'Handy: kein waagrechtes Scrollen, Reiter ≥ 40 px hoch, PNG ohne 8000 px und höchstens 16 MP',
    ov1 <= 0 && ov2 <= 0 && ov3 <= 0 && tabs.every((h) => h >= 40) && sizes === 2 && cap === 16,
    `Überstand ${ov1}/${ov2}/${ov3}, Reiter ${tabs.join('/')} px, ${sizes} Größen, ${cap} MP`,
  );
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.tap('[data-testid="png-save"]')]);
  const file = path.join(OUT, `phone-${dl.suggestedFilename()}`);
  await dl.saveAs(file);
  const png = readPng(file);
  check('Handy: PNG-Download innerhalb von 16 MP', png.sig && png.width * png.height <= 16e6 && Math.max(png.width, png.height) <= 4000, `${png.width} × ${png.height}`);
  check('Handy: keine Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await desktop(browser);
    await phone(browser);
  } catch (e) {
    failed++;
    console.log(`✘ Abbruch: ${e && e.stack ? e.stack : e}`);
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
  process.exit(failed ? 1 : 0);
})();
