/* w2-photo-intake: Foto laden (groß, EXIF, defekt), Zuschnitt mit dem Finger, Foto sicher ersetzen.
 * Voraussetzung: `npm run build` und `npx vite preview --port <port>` laufen.
 * Aufruf: node e2e/w2-photo-intake.e2e.cjs <baseUrl> <outDir>
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w2-photo-intake');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

/** Fügt einem JPEG ein minimales EXIF-Segment mit Ausrichtung `o` hinzu (direkt nach SOI). */
function withExifOrientation(buf, o) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(o, 18);
  tiff.writeUInt32BE(0, 22);
  const head = Buffer.alloc(10);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(2 + 6 + 26, 2);
  head.write('Exif\0\0', 4, 'latin1');
  return Buffer.concat([buf.subarray(0, 2), head, tiff, buf.subarray(2)]);
}

/** JPEG im Browser erzeugen: Verlauf, rote Marke oben links, gelbe Marke unten rechts. */
async function makeJpeg(page, w, h, quality = 0.85) {
  const b64 = await page.evaluate(
    async ([w, h, q]) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#2a5d9f');
      g.addColorStop(1, '#9fd0a8');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, Math.round(w * 0.2), Math.round(h * 0.2));
      ctx.fillStyle = '#ffff00';
      ctx.fillRect(Math.round(w * 0.8), Math.round(h * 0.8), w, h);
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, Math.min(w, h) / 6, 0, Math.PI * 2);
      ctx.fill();
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);
    },
    [w, h, quality],
  );
  return Buffer.from(b64, 'base64');
}

async function readProjects(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const rq = indexedDB.open('mosaicplan');
        rq.onerror = () => reject(rq.error);
        rq.onsuccess = () => {
          const db = rq.result;
          const tx = db.transaction(['projects'], 'readonly');
          const all = tx.objectStore('projects').getAll();
          all.onsuccess = () => {
            resolve(all.result.map((p) => ({ id: p.meta.id, name: p.meta.name, regions: p.regions.length, imageRev: p.imageRev, computedImageRev: p.computedImageRev, computedWith: !!p.computedWith, tileW: p.settings.tileW, widthMm: p.settings.widthMm, heightMm: p.settings.heightMm })));
            db.close();
          };
          all.onerror = () => reject(all.error);
        };
      }),
  );
}

const projectIdOf = (url) => (url.match(/#\/project\/([^/]+)/) || [])[1];

/** „Veraltet / neu berechnen“-Hinweis im Projektkopf sichtbar?
 *  Seit w2-workspace-shell lautet das Abzeichen „Einstellungen geändert“ (data-testid=stale-badge). */
const staleVisible = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.ws-head .badge-warn, .ws-head [data-testid*="stale"]')].some((e) => e.offsetParent !== null && (e.getAttribute('data-testid') === 'stale-badge' || /berechnen|recompute|hesapla|geändert|changed|değişti/i.test(e.textContent || ''))));

async function boxOf(page, sel) {
  const el = await page.$(sel);
  return el ? el.boundingBox() : null;
}

/** Fingerzug über CDP (echte Touch-Ereignisse) */
async function touchDrag(cdp, page, x0, y0, dx, dy, steps = 12) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (dx * i) / steps, y: y0 + (dy * i) / steps, id: 1 }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(250);
}

async function setRange(page, sel, v) {
  await page.$eval(
    sel,
    (el, v) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, String(v));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    v,
  );
  await page.waitForTimeout(250);
}

async function cropPixel(page, fx, fy) {
  return page.$eval(
    '[data-testid="crop-canvas"]',
    (c, [fx, fy]) => Array.from(c.getContext('2d').getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1).data).slice(0, 3),
    [fx, fy],
  );
}
const isRed = (p) => p[0] > 200 && p[1] < 70 && p[2] < 70;
const isYellow = (p) => p[0] > 200 && p[1] > 200 && p[2] < 90;

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  };

  // ================================================================ 1. Zuschnitt mit dem Finger (390 × 844, Touch)
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const pp = await phone.newPage();
  watch(pp);
  const cdp = await phone.newCDPSession(pp);
  await pp.goto(BASE);
  await pp.waitForSelector('[data-testid="sample-portrait"]');
  await pp.tap('[data-testid="sample-portrait"]');
  await pp.waitForSelector('[data-testid="compute-btn"]');
  await pp.tap('[data-testid="step-photo"]');
  await pp.waitForSelector('[data-testid="crop-box"]');
  await pp.waitForTimeout(500);
  await pp.$eval('[data-testid="crop-holder"]', (e) => e.scrollIntoView({ block: 'center' }));
  await pp.waitForTimeout(300);
  const aspect = parseFloat(await pp.getAttribute('[data-testid="crop-holder"]', 'data-aspect'));
  const hb = await boxOf(pp, '[data-testid="crop-holder"]');
  const b0 = await boxOf(pp, '[data-testid="crop-box"]');
  await pp.screenshot({ path: path.join(OUT, 'p01-crop-default.png') });
  const handles = await pp.$$eval('.crop-handle', (els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
  const allInside = handles.every((h) => h.x >= hb.x - 0.5 && h.y >= hb.y - 0.5 && h.x + h.w <= hb.x + hb.width + 0.5 && h.y + h.h <= hb.y + hb.height + 0.5);
  check('Vier Eckgriffe, 44 × 44 px, vollständig im Bild', handles.length === 4 && handles.every((h) => h.w >= 43.5 && h.h >= 43.5) && allInside, JSON.stringify(handles.map((h) => `${Math.round(h.w)}×${Math.round(h.h)}`)));
  const under = await pp.evaluate(([x, y]) => document.elementFromPoint(x, y)?.dataset.testid, [b0.x + b0.width - 15, b0.y + b0.height - 15]);
  check('15 px innerhalb der Ecke liegt der Griff (nicht der Rahmen)', under === 'crop-handle-se', String(under));

  await touchDrag(cdp, pp, b0.x + b0.width - 15, b0.y + b0.height - 15, -100, -100);
  const b1 = await boxOf(pp, '[data-testid="crop-box"]');
  const ar1 = Math.abs(b1.width / aspect - b1.height);
  check(
    'Finger an der Ecke unten rechts (−100/−100) verkleinert, Seitenverhältnis ±0,5 px',
    b1.width < b0.width - 40 && ar1 <= 0.5 && Math.abs(b1.x - b0.x) < 1 && Math.abs(b1.y - b0.y) < 1,
    `${b0.width.toFixed(1)}×${b0.height.toFixed(1)} → ${b1.width.toFixed(1)}×${b1.height.toFixed(1)} (Abw. ${ar1.toFixed(2)} px)`,
  );
  await pp.screenshot({ path: path.join(OUT, 'p02-crop-se.png') });

  // senkrechter Zug: Projektion auf die Diagonale ändert trotzdem die Größe
  await touchDrag(cdp, pp, b1.x + b1.width - 15, b1.y + b1.height - 15, 0, 60);
  const b1b = await boxOf(pp, '[data-testid="crop-box"]');
  check('Senkrechter Fingerzug an der Ecke ändert die Größe', b1b.width > b1.width + 10 && Math.abs(b1b.width / aspect - b1b.height) <= 0.5, `${b1.width.toFixed(1)} → ${b1b.width.toFixed(1)}`);

  // oben links: gegenüberliegende Ecke (unten rechts) bleibt fest
  const brX = b1b.x + b1b.width;
  const brY = b1b.y + b1b.height;
  await touchDrag(cdp, pp, b1b.x + 15, b1b.y + 15, 100, 100);
  const b2 = await boxOf(pp, '[data-testid="crop-box"]');
  const ar2 = Math.abs(b2.width / aspect - b2.height);
  check(
    'Finger an der Ecke oben links (+100/+100) verkleinert, Ecke unten rechts bleibt',
    b2.width < b1b.width - 40 && ar2 <= 0.5 && Math.abs(b2.x + b2.width - brX) < 1 && Math.abs(b2.y + b2.height - brY) < 1,
    `${b1b.width.toFixed(1)} → ${b2.width.toFixed(1)} (Abw. ${ar2.toFixed(2)} px)`,
  );

  // Mindestgröße ≈ 90 px (kürzere Seite)
  const b2h = await pp.$$eval('.crop-handle', (els) => els.map((e) => e.dataset.testid));
  await touchDrag(cdp, pp, b2.x + b2.width - 15, b2.y + b2.height - 15, -400, -400, 16);
  const b3 = await boxOf(pp, '[data-testid="crop-box"]');
  check('Mindestgröße ≈ 90 px, Verschieben bleibt möglich', Math.min(b3.width, b3.height) >= 89 && Math.min(b3.width, b3.height) <= 92, `${b3.width.toFixed(1)}×${b3.height.toFixed(1)}, Griffe vorher: ${b2h.join(',')}`);
  // verschieben (Mitte des Rahmens, außerhalb des Griffs)
  await touchDrag(cdp, pp, b3.x + 20, b3.y + 20, 30, 40);
  const b4 = await boxOf(pp, '[data-testid="crop-box"]');
  check('Rahmen mit dem Finger verschieben', Math.abs(b4.x - b3.x - 30) < 2 && Math.abs(b4.y - b3.y - 40) < 2 && Math.abs(b4.width - b3.width) < 0.5, `(${(b4.x - b3.x).toFixed(1)}|${(b4.y - b3.y).toFixed(1)})`);
  await pp.screenshot({ path: path.join(OUT, 'p03-crop-small.png') });

  // Regler „Ausschnittgröße“: 50 % um die Mitte
  await setRange(pp, '[data-testid="crop-zoom"] input', 100);
  const bFull = await boxOf(pp, '[data-testid="crop-box"]');
  await setRange(pp, '[data-testid="crop-zoom"] input', 50);
  const bHalf = await boxOf(pp, '[data-testid="crop-box"]');
  const cx0 = bFull.x + bFull.width / 2;
  const cxh = bHalf.x + bHalf.width / 2;
  check('Regler 100 % → 50 %: halbe Breite, gleiche Mitte, Seitenverhältnis', Math.abs(bHalf.width - bFull.width / 2) < 1 && Math.abs(cxh - cx0) < 1 && Math.abs(bHalf.width / aspect - bHalf.height) <= 0.5, `${bFull.width.toFixed(1)} → ${bHalf.width.toFixed(1)}`);

  // Zwei-Finger-Zoom am Rahmen
  const pc = { x: bHalf.x + bHalf.width / 2, y: bHalf.y + bHalf.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pc.x - 20, y: pc.y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pc.x - 20, y: pc.y, id: 1 }, { x: pc.x + 20, y: pc.y, id: 2 }] });
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pc.x - 20 - i * 3, y: pc.y, id: 1 }, { x: pc.x + 20 + i * 3, y: pc.y, id: 2 }] });
    await pp.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pp.waitForTimeout(250);
  const bPinch = await boxOf(pp, '[data-testid="crop-box"]');
  check('Zwei Finger auseinander vergrößern den Rahmen (Seitenverhältnis bleibt)', bPinch.width > bHalf.width * 1.3 && Math.abs(bPinch.width / aspect - bPinch.height) <= 0.5, `${bHalf.width.toFixed(1)} → ${bPinch.width.toFixed(1)}`);

  const readout = (await pp.textContent('[data-testid="crop-readout"]')).trim();
  check('Anzeige „Ausschnitt W × H px · ≈ N px pro Stein“', /^Ausschnitt [\d.]+ × [\d.]+ px · ≈ [\d,]+ × [\d,]+ px pro Stein$/.test(readout), readout);
  const replaceCls = await pp.getAttribute('[data-testid="photo-replace-btn"]', 'class');
  check('„Anderes Foto“ ist sekundär (nur „Weiter“ ist primär)', !/primary/.test(replaceCls), replaceCls);
  await pp.$eval('[data-testid="crop-holder"]', (e) => e.scrollIntoView({ block: 'start' }));
  await pp.screenshot({ path: path.join(OUT, 'p04-crop-phone.png'), fullPage: false });
  await phone.close();

  // ================================================================ 2. Große, gedrehte und defekte Fotos (Desktop)
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  // createImageBitmap beobachten (nur Optionen protokollieren): volle Dekodierung = ohne resizeWidth
  await ctx.addInitScript(() => {
    window.__cib = [];
    const orig = window.createImageBitmap.bind(window);
    window.createImageBitmap = (src, ...rest) => {
      const o = rest.length === 1 || rest.length === 5 ? rest[rest.length - 1] : undefined;
      window.__cib.push({ resizeWidth: o && o.resizeWidth ? o.resizeWidth : null });
      return orig(src, ...rest);
    };
  });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(BASE);
  await page.waitForSelector('[data-testid="home-photo"]', { state: 'attached' });
  const big = await makeJpeg(page, 8000, 6000, 0.8);
  fs.writeFileSync(path.join(OUT, 'big-8000x6000.jpg'), big);
  await page.setInputFiles('[data-testid="home-photo"]', { name: 'gross-48mp.jpg', mimeType: 'image/jpeg', buffer: big });
  await page.waitForSelector('[data-testid="photo-size"]', { timeout: 60000 });
  await page.waitForTimeout(400);
  const ps = await page.$eval('[data-testid="photo-size"]', (e) => ({ ...e.dataset, text: e.textContent }));
  const workPx = Number(ps.workW) * Number(ps.workH);
  check('8000 × 6000 JPEG: Originalgröße angezeigt, Arbeitskopie ≤ 16 MP', ps.srcW === '8000' && ps.srcH === '6000' && ps.reduced === '1' && workPx <= 16e6 && Math.abs(Number(ps.workW) / Number(ps.workH) - 4 / 3) < 0.005, `${ps.text.trim()} (${(workPx / 1e6).toFixed(2)} MP)`);
  await page.screenshot({ path: path.join(OUT, 'd01-big-photo.png') });
  // Großes Format (200 × 150 cm, 5-mm-Steine) + kleiner Ausschnitt: die Arbeitskopie hat im Ausschnitt
  // weniger Pixel als die Arbeitsauflösung → die Berechnung muss das Original voll lesen.
  await page.click('[data-testid="step-size"]');
  await page.fill('[data-testid="width-input"]', '200');
  await page.keyboard.press('Tab');
  await page.fill('[data-testid="height-input"]', '150');
  await page.keyboard.press('Tab');
  await page.click('[data-testid="step-tiles"]');
  await page.waitForSelector('[data-testid="tile-w"]');
  await page.fill('[data-testid="tile-w"]', '5');
  await page.keyboard.press('Tab');
  await page.fill('[data-testid="tile-h"]', '5');
  await page.keyboard.press('Tab');
  await page.click('[data-testid="step-photo"]');
  await page.waitForSelector('[data-testid="crop-zoom"]');
  await setRange(page, '[data-testid="crop-zoom"] input', 30);
  const readoutBig = (await page.textContent('[data-testid="crop-readout"]')).trim();
  await page.click('[data-testid="step-compute"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  const positions = (await page.textContent('[data-testid="grid-positions"]')).trim();
  await page.evaluate(() => (window.__cib.length = 0));
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
  await page.waitForTimeout(800);
  const cibCalls = await page.evaluate(() => window.__cib.slice());
  check(
    'Berechnung mit 48-MP-Foto und kleinem Ausschnitt liest das Original voll und gelingt',
    (await page.isVisible('[data-testid="mosaic-canvas"]')) && cibCalls.some((o) => !o.resizeWidth),
    `${positions} Positionen · ${readoutBig} · Dekodierungen ${JSON.stringify(cibCalls)}`,
  );
  await page.screenshot({ path: path.join(OUT, 'd02-big-computed.png') });

  // Defekte Datei im Foto-Schritt: Meldung, bisheriges Foto bleibt
  await page.click('[data-testid="step-photo"]');
  await page.waitForSelector('[data-testid="photo-size"]');
  const before = await page.$eval('[data-testid="photo-size"]', (e) => e.dataset.srcW + 'x' + e.dataset.srcH);
  const bad = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xdb, 0, 0x43, 0, 1, 2, 3, 4]);
  const errBefore = errors.length;
  await page.setInputFiles('[data-testid="photo-replace"]', { name: 'kaputt.jpg', mimeType: 'image/jpeg', buffer: bad });
  await page.waitForSelector('[data-testid="photo-error"]', { timeout: 15000 }).catch(() => {});
  const errText = (await page.textContent('[data-testid="photo-error"]').catch(() => '')) || '';
  const role = await page.getAttribute('[data-testid="photo-error"]', 'role').catch(() => null);
  const after = await page.$eval('[data-testid="photo-size"]', (e) => e.dataset.srcW + 'x' + e.dataset.srcH);
  const dialogOpen = await page.isVisible('[data-testid="replace-dialog"]');
  check('Defekte Datei: Meldung (role=alert), bisheriges Foto bleibt, kein Dialog', role === 'alert' && /nicht gelesen/.test(errText) && before === after && !dialogOpen && errors.length === errBefore, `${errText.slice(0, 60)} | ${before} → ${after}`);
  await page.screenshot({ path: path.join(OUT, 'd03-corrupt.png') });
  await page.setInputFiles('[data-testid="photo-replace"]', { name: 'IMG_0001.HEIC', mimeType: 'image/heic', buffer: bad });
  await page.waitForTimeout(800);
  const heicText = (await page.textContent('[data-testid="photo-error"]')) || '';
  check('HEIC-Datei: eigene Meldung mit JPG-Hinweis', /HEIC/.test(heicText) && /JPG/.test(heicText), heicText.slice(0, 70));

  // EXIF-Ausrichtung 6 (um 90° im Uhrzeigersinn): klein (volle Dekodierung) und groß (verkleinerte Arbeitskopie)
  for (const [w, h, label] of [
    [600, 400, 'klein'],
    [6000, 4000, 'groß, verkleinert'],
  ]) {
    await page.goto(BASE);
    await page.waitForSelector('[data-testid="home-photo"]', { state: 'attached' });
    const jpg = withExifOrientation(await makeJpeg(page, w, h, 0.85), 6);
    fs.writeFileSync(path.join(OUT, `exif6-${w}x${h}.jpg`), jpg);
    await page.setInputFiles('[data-testid="home-photo"]', { name: `exif6-${w}.jpg`, mimeType: 'image/jpeg', buffer: jpg });
    await page.waitForSelector('[data-testid="photo-size"]', { timeout: 60000 });
    await page.waitForTimeout(500);
    const d = await page.$eval('[data-testid="photo-size"]', (e) => ({ ...e.dataset }));
    // Ausrichtung 6: oben links (rot) wandert nach oben rechts, unten rechts (gelb) nach unten links
    const tr = await cropPixel(page, 0.95, 0.05);
    const tl = await cropPixel(page, 0.05, 0.05);
    const bl = await cropPixel(page, 0.05, 0.95);
    const portrait = Number(d.srcW) === h && Number(d.srcH) === w && Number(d.workW) < Number(d.workH);
    check(`EXIF 6 (${label}): bleibt hochkant, richtige Ecke oben`, portrait && isRed(tr) && !isRed(tl) && isYellow(bl) && (w * h > 16e6 ? d.reduced === '1' : d.reduced === '0'), `${d.srcW}×${d.srcH}, Arbeit ${d.workW}×${d.workH}, oben rechts ${tr}`);
  }
  await page.screenshot({ path: path.join(OUT, 'd04-exif6.png') });

  // Leeres Projekt: defekte Datei im Ablagefeld
  await page.goto(BASE);
  await page.waitForSelector('[data-testid="new-project"]');
  await page.click('[data-testid="new-project"]');
  await page.waitForSelector('[data-testid="photo-input"]', { state: 'attached' });
  await page.setInputFiles('[data-testid="photo-input"]', { name: 'kaputt.png', mimeType: 'image/png', buffer: bad });
  await page.waitForSelector('[data-testid="photo-error"]', { timeout: 15000 }).catch(() => {});
  check('Ablagefeld: defekte Datei zeigt Meldung, Ablagefeld bleibt', (await page.isVisible('[data-testid="photo-error"]')) && (await page.isVisible('.dropzone')));
  // gespeichertes Foto unlesbar → Hinweis statt stillem Fehler
  const emptyId = projectIdOf(page.url());
  await page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const rq = indexedDB.open('mosaicplan');
        rq.onsuccess = () => {
          const db = rq.result;
          const tx = db.transaction(['images'], 'readwrite');
          tx.objectStore('images').put({ original: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }), name: 'weg.jpg' }, id);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    emptyId,
  );
  await page.reload();
  await page.waitForSelector('[data-testid="photo-unreadable"]', { timeout: 15000 }).catch(() => {});
  check('Gespeichertes Foto unlesbar: Hinweis „bitte neu auswählen“', await page.isVisible('[data-testid="photo-unreadable"]'));
  await ctx.close();

  // ================================================================ 3. Foto ersetzen nach der Berechnung
  const c3 = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const p3 = await c3.newPage();
  watch(p3);
  await p3.goto(BASE);
  await p3.click('[data-testid="sample-portrait"]');
  await p3.waitForSelector('[data-testid="compute-btn"]');
  await p3.click('[data-testid="compute-btn"]');
  await p3.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
  await p3.waitForTimeout(800);
  const oldId = projectIdOf(p3.url());
  await p3.click('[data-testid="step-photo"]');
  await p3.waitForSelector('[data-testid="photo-size"]');
  const tipVisible = await p3.isVisible('[data-testid="portrait-tip"]');
  const other = await makeJpeg(p3, 1200, 900, 0.85);

  // Abbrechen: nichts ändert sich
  await p3.setInputFiles('[data-testid="photo-replace"]', { name: 'stadt.jpg', mimeType: 'image/jpeg', buffer: other });
  await p3.waitForSelector('[data-testid="replace-dialog"]', { timeout: 15000 });
  await p3.screenshot({ path: path.join(OUT, 'r01-dialog.png') });
  const facts = (await p3.textContent('[data-testid="replace-dialog"]')) || '';
  check('Ersetzen nach Berechnung öffnet den Dialog (mit Fakten)', /berechnetes Mosaik/.test(facts) && /Gesichts-\/Detailbereich/.test(facts) && /1\.?200 × 900 px/.test(facts), facts.slice(0, 120));
  await p3.click('[data-testid="replace-cancel"]');
  await p3.waitForTimeout(500);
  const afterCancel = (await readProjects(p3)).find((p) => p.id === oldId);
  check('Abbrechen: Dialog zu, Foto/Bereiche unverändert, nicht veraltet', !(await p3.isVisible('[data-testid="replace-dialog"]')) && afterCancel.regions === 1 && !(await staleVisible(p3)), JSON.stringify(afterCancel));

  // Ersetzen: Bereiche werden gelöscht, Projekt gilt als veraltet
  await p3.setInputFiles('[data-testid="photo-replace"]', { name: 'stadt.jpg', mimeType: 'image/jpeg', buffer: other });
  await p3.waitForSelector('[data-testid="replace-dialog"]');
  const keepChecked = await p3.isChecked('[data-testid="replace-keep-regions"]');
  await p3.click('[data-testid="replace-in-project"]');
  await p3.waitForSelector('[data-testid="photo-stale"]', { timeout: 15000 }).catch(() => {});
  await p3.waitForTimeout(800);
  const replaced = (await readProjects(p3)).find((p) => p.id === oldId);
  const staleBadge = await staleVisible(p3);
  const size3 = await p3.$eval('[data-testid="photo-size"]', (e) => e.dataset.srcW + 'x' + e.dataset.srcH);
  check(
    '„Ersetzen“: Bereiche gelöscht (Standard), Veraltet-Hinweis, neues Foto',
    !keepChecked && replaced.regions === 0 && replaced.imageRev !== replaced.computedImageRev && staleBadge && (await p3.isVisible('[data-testid="photo-stale"]')) && size3 === '1200x900',
    `Bereiche ${replaced.regions}, Badge ${staleBadge}, ${size3}`,
  );
  check('Porträt-Hinweis erscheint ohne Gesichtsbereich', !tipVisible && (await p3.isVisible('[data-testid="portrait-tip"]')), `vorher ${tipVisible}`);
  await p3.screenshot({ path: path.join(OUT, 'r02-replaced.png') });
  await p3.click('[data-testid="portrait-tip-dismiss"]');
  await p3.reload();
  await p3.waitForSelector('[data-testid="photo-size"]', { timeout: 30000 });
  await p3.waitForTimeout(300);
  check('Porträt-Hinweis bleibt nach dem Ausblenden weg (auch nach Neuladen)', !(await p3.isVisible('[data-testid="portrait-tip"]')));

  // Neues Projekt mit diesem Foto: altes Projekt bleibt unverändert
  await p3.goto(BASE);
  await p3.click('[data-testid="sample-portrait"]');
  await p3.waitForSelector('[data-testid="compute-btn"]');
  await p3.click('[data-testid="compute-btn"]');
  await p3.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
  await p3.waitForTimeout(800);
  const srcId = projectIdOf(p3.url());
  const srcBefore = (await readProjects(p3)).find((p) => p.id === srcId);
  await p3.click('[data-testid="step-photo"]');
  await p3.waitForSelector('[data-testid="photo-size"]');
  await p3.setInputFiles('[data-testid="photo-replace"]', { name: 'katze.jpg', mimeType: 'image/jpeg', buffer: other });
  await p3.waitForSelector('[data-testid="replace-dialog"]');
  await p3.click('[data-testid="replace-new-project"]');
  await p3.waitForFunction((old) => !location.hash.includes(old), srcId, { timeout: 15000 }).catch(() => {});
  await p3.waitForSelector('[data-testid="photo-size"]', { timeout: 30000 });
  await p3.waitForTimeout(600);
  const newId = projectIdOf(p3.url());
  const all = await readProjects(p3);
  const np = all.find((p) => p.id === newId);
  const sp = all.find((p) => p.id === srcId);
  check(
    '„Neues Projekt“: neues Projekt mit Foto und gleichen Steinen, altes unverändert',
    newId && newId !== srcId && np && np.name === 'katze' && !np.computedWith && np.regions === 0 && np.tileW === srcBefore.tileW && np.widthMm === srcBefore.widthMm && Math.abs(np.heightMm - (np.widthMm * 900) / 1200) < 0.11 && sp.computedWith && sp.imageRev === srcBefore.imageRev && sp.regions === srcBefore.regions,
    `neu ${JSON.stringify(np)} | alt ${JSON.stringify(sp)}`,
  );
  check('Neues Projekt: kein Dialog mehr offen, Foto-Schritt aktiv', !(await p3.isVisible('[data-testid="replace-dialog"]')) && /\/photo$/.test(p3.url()));
  await p3.screenshot({ path: path.join(OUT, 'r03-new-project.png') });
  // Zurück führt zum alten Projekt
  await p3.goBack();
  await p3.waitForTimeout(1200);
  check('Zurück führt zum bisherigen Projekt', projectIdOf(p3.url()) === srcId, p3.url());

  // Bereiche behalten (Häkchen)
  await p3.goto(`${BASE}#/project/${srcId}/photo`);
  await p3.reload();
  await p3.waitForSelector('[data-testid="photo-size"]', { timeout: 30000 });
  await p3.setInputFiles('[data-testid="photo-replace"]', { name: 'nochmal.jpg', mimeType: 'image/jpeg', buffer: other });
  await p3.waitForSelector('[data-testid="replace-dialog"]');
  await p3.check('[data-testid="replace-keep-regions"]');
  await p3.click('[data-testid="replace-in-project"]');
  await p3.waitForSelector('[data-testid="photo-regions-kept"]', { timeout: 15000 }).catch(() => {});
  await p3.waitForTimeout(600);
  const kept = (await readProjects(p3)).find((p) => p.id === srcId);
  check('„Bereiche behalten“: Bereiche bleiben, Hinweis zum Prüfen', kept.regions === 1 && (await p3.isVisible('[data-testid="photo-regions-kept"]')), `Bereiche ${kept.regions}`);
  await p3.screenshot({ path: path.join(OUT, 'r04-kept.png') });

  // Englisch und Türkisch: Dialogtexte vorhanden
  for (const [lang, re] of [
    ['en', /Create a new project with this photo/],
    ['tr', /Bu fotoğrafla yeni proje oluştur/],
  ]) {
    await p3.selectOption('select.lang', lang);
    await p3.waitForTimeout(200);
    await p3.setInputFiles('[data-testid="photo-replace"]', { name: 'x.jpg', mimeType: 'image/jpeg', buffer: other });
    await p3.waitForSelector('[data-testid="replace-dialog"]');
    check(`Dialog übersetzt (${lang})`, re.test((await p3.textContent('[data-testid="replace-dialog"]')) || ''));
    await p3.click('[data-testid="replace-cancel"]');
    await p3.waitForTimeout(400);
  }
  await p3.selectOption('select.lang', 'de');
  await c3.close();

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
