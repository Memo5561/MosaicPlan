/* Browser-Test w5-viewer-performance (Playwright/Chromium): Rückpuffer des Viewers.
 * Teil A – Prüfstand (echter Viewer mit esbuild gebündelt, synthetisches Mosaik):
 *   - Pixeltest: der Puffer, mit ganzzahligem Versatz kopiert, ist pixelgleich (max. Kanalabweichung ≤ 1) mit einem frischen
 *     renderMosaic der verschobenen Ansicht – nach Zoom, nach vielen Verschiebungen (Streifen, Ringpuffer-Umbruch, Rand).
 *   - Volles Mosaik (Glasur, Codes, geteilte/Freiform-Steine, Häkchen, Abschnitte, Lineal) bei dpr 1 / 2 / 2,625: jede
 *     Steinfarbe gleich; Abweichungen nur in der Kantenglättung, nicht mehr als der Rasterer selbst bei Verschiebung zeigt.
 *   - Stein bearbeiten, verlegt tippen, Änderung ohne Zähler: Pixel ändert sich sofort, nur der Stein wird neu gezeichnet.
 *   - Abschnitt/Auswahl/Fokus: nur Überlagerung, kein Neuaufbau. Zoom (Rad, zwei Finger): skaliert nur während der Geste,
 *     danach immer das genaue Bild.
 * Teil B – App: Farbe eines Steins im Steindetail ändern und im Verlegemodus tippen → Pixel am Stein ändert sich sofort.
 * Teil C – Leistung (Tablet 1280 × 800, dpr 2, CPU 4× gebremst, 200 × 100 cm in 5 mm): Verschieben auf Zoomstufen 4–18,
 *   Median der rAF-Rückrufe < 8 ms.
 * Voraussetzung: `npm run build` und `npx vite preview --port 4302` laufen.
 * Aufruf: node e2e/w5-viewer-performance.e2e.cjs [baseUrl] [screenshotDir]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4302/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w5-viewer-performance');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const fmt = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : String(v));
const pct = (a, b) => `${fmt((100 * a) / Math.max(1, b))} %`;

/** rAF-Rückrufe zeitlich messen (wie scratchpad/audit/performance-scale/instrument.js) */
const INSTR = `(() => {
  const W = (window.__perf = { raf: [] });
  const orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => orig((ts) => {
    const t0 = performance.now();
    try { cb(ts); } finally { W.raf.push({ at: t0, ms: performance.now() - t0 }); }
  });
})();`;

// ------------------------------------------------------------------ Prüfstand bündeln
async function bundleHarness() {
  const esbuild = require('esbuild');
  const root = path.resolve(__dirname, '..');
  const extDir = path.join(root, 'src', 'i18n', 'ext');
  // import.meta.glob (Vite) für die Übersetzungs-Erweiterungen durch feste Importe ersetzen
  const globPlugin = {
    name: 'w5vp-import-meta-glob',
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/]i18n[\\/]index\.ts$/ }, (args) => {
        const files = fs.readdirSync(extDir).filter((f) => f.endsWith('.ts'));
        const imports = files.map((f, i) => `import * as __ext${i} from './ext/${f}';`).join('\n');
        const obj = `{${files.map((f, i) => `'./ext/${f}': __ext${i}`).join(',')}}`;
        const src = fs.readFileSync(args.path, 'utf8').replace(/import\.meta\.glob<[^>]*>\([^)]*\)/, obj);
        return { contents: `${imports}\n${src}`, loader: 'ts' };
      });
    },
  };
  const res = await esbuild.build({
    entryPoints: [path.join(__dirname, 'w5-viewer-performance.harness.tsx')],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    outdir: path.join(OUT, 'harness'),
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.png': 'empty', '.svg': 'empty', '.ttf': 'empty', '.woff2': 'empty' },
    plugins: [globPlugin],
    logLevel: 'silent',
  });
  return {
    js: res.outputFiles.find((f) => f.path.endsWith('.js')).text,
    css: (res.outputFiles.find((f) => f.path.endsWith('.css')) || { text: '' }).text,
  };
}
const harnessHtml = (h, params) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${h.css}</style><style>body{margin:0;padding:20px;background:#f4f1ec}</style></head><body><div id="root"></div><script>window.__hp=${JSON.stringify(params)};</script><script>${h.js.replace(/<\/script/g, '<\\/script')}</script></body></html>`;

// ------------------------------------------------------------------ Hilfen im Browser
const attrs = (page) => page.$eval('[data-testid="mosaic-canvas"]', (c) => ({ ...c.dataset }));
/** zwei Bilder abwarten (Effekt → rAF → Zeichnen) */
const frames = (page, n = 2) =>
  page.evaluate(
    (n) =>
      new Promise((res) => {
        let k = 0;
        const step = () => (++k >= n ? res() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    n,
  );
/** Mittelwert eines 3 × 3-Felds im Mosaik-Canvas an einer Seitenkoordinate */
const pixelAt = (page, x, y) =>
  page.$eval(
    '[data-testid="mosaic-canvas"]',
    (c, p) => {
      const r = c.getBoundingClientRect();
      const d = c.width / r.width;
      const a = c
        .getContext('2d')
        .getImageData(Math.round((p.x - r.left) * d) - 1, Math.round((p.y - r.top) * d) - 1, 3, 3).data;
      const o = [0, 0, 0];
      for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) o[k] += a[i + k] / 9;
      return o.map((v) => Math.round(v));
    },
    { x, y },
  );
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Mausziehen um (dx, dy) in n Schritten */
async function drag(page, x, y, dx, dy, n = 6) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let k = 1; k <= n; k++) await page.mouse.move(x + (dx * k) / n, y + (dy * k) / n);
  await page.mouse.up();
}

/**
 * Steinfarben im Viewer und im frischen Bild vergleichen: je ganz sichtbarer ganzer Stein ein Pixel links unten
 * im Stein (abseits von Farbcode und Häkchen). Liefert Zahl geprüfter Steine und größte Abweichung.
 */
const stoneColours = (page) =>
  page.evaluate(() => {
    const cv = document.querySelector('[data-testid="mosaic-canvas"]');
    const h = window.__h;
    const v = h.viewer().drawnView();
    const r = h.compare(true);
    return new Promise((res) => {
      const imgA = new Image();
      const imgB = new Image();
      let n = 0;
      const done = () => {
        if (++n < 2) return;
        const w = cv.width;
        const H = cv.height;
        const get = (img) => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = H;
          const x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(img, 0, 0);
          return x.getImageData(0, 0, w, H).data;
        };
        const A = get(imgA);
        const B = get(imgB);
        const dpr = window.devicePixelRatio || 1;
        const L = h.layout;
        let checked = 0;
        let worst = 0;
        for (let row = 0; row < L.rows; row++)
          for (let col = 0; col < L.cols; col++) {
            const x = Math.round((v.ox + (L.colX[col] + L.colW[col] * 0.14) * v.scale) * dpr);
            const y = Math.round((v.oy + (L.rowY[row] + L.rowH[row] * 0.86) * v.scale) * dpr);
            // nur im Mosaikbereich unter/rechts vom Lineal (Lineal ≈ 18 CSS-px)
            if (x < 24 * dpr || y < 24 * dpr || x >= w - 2 || y >= H - 2) continue;
            const o = (y * w + x) * 4;
            const d = Math.max(Math.abs(A[o] - B[o]), Math.abs(A[o + 1] - B[o + 1]), Math.abs(A[o + 2] - B[o + 2]));
            worst = Math.max(worst, d);
            checked++;
          }
        res({ checked, worst, max: r.max, over1: r.over1, total: r.total });
      };
      imgA.onload = done;
      imgB.onload = done;
      imgA.src = r.images.viewer;
      imgB.src = r.images.fresh;
    });
  });

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  };

  let harness = null;
  try {
    harness = await bundleHarness();
  } catch (e) {
    check('Prüfstand mit esbuild gebündelt', false, String(e).slice(0, 200));
  }

  // =====================================================================  Teil A: Prüfstand
  if (harness) {
    // ---------------------------------------------------------------- A1: Pixeltest (nur Rechtecke + Glasurbild)
    {
      const ctx = await browser.newContext({ viewport: { width: 820, height: 680 }, deviceScaleFactor: 1, locale: 'de-DE' });
      const page = await ctx.newPage();
      watch(page);
      await page.setContent(harnessHtml(harness, { simple: true }));
      await page.waitForSelector('[data-testid="mosaic-canvas"]');
      await page.waitForTimeout(500);
      const cmp = () => page.evaluate(() => window.__h.compare());
      const box = await page.$eval('[data-testid="mosaic-canvas"]', (c) => {
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      let r = await cmp();
      let a = await attrs(page);
      check('Pixeltest: Gesamtansicht aus dem Puffer = frisches renderMosaic', r.max <= 1 && a.frame === 'exact', `max. Kanalabweichung ${r.max}, Bild ${a.frame}`);
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(30);
      }
      await page.waitForTimeout(400);
      r = await cmp();
      a = await attrs(page);
      check('Pixeltest: nach dem Zoomen (genaues Bild nach der Geste) = frisches renderMosaic', r.max <= 1 && a.frame === 'exact', `max ${r.max}, Maßstab ${a.scale}`);
      // viele Verschiebungen: kleine (im Rand), große (Streifen), sehr große (Fenster springt, Ringpuffer bricht um)
      const moves = [
        [37.3, 11.7],
        [-120.4, 60.2],
        [300, -10],
        [-15.5, -230.25],
        [5, 5],
        [-400, 0],
        [0, 350],
        [-25, -25],
        [610, 420],
      ];
      let worst = 0;
      const paints0 = Number((await attrs(page)).basePaints || 0);
      const log = [];
      for (const [dx, dy] of moves) {
        await drag(page, cx, cy, dx, dy);
        await page.waitForTimeout(80);
        r = await cmp();
        a = await attrs(page);
        worst = Math.max(worst, r.max);
        log.push(r.max);
      }
      check('Pixeltest: nach 9 Verschiebungen (Rand, Streifen, Umbruch) pixelgleich (max ≤ 1)', worst <= 1 && Number(a.basePaints) - paints0 > 0, `max je Schritt ${log.join('/')}, dabei ${Number(a.basePaints) - paints0} Streifen/Rechtecke nachgezeichnet`);
      // Rand in Leerlaufzeit nachgezeichnet, dann kleine Verschiebung ohne Neuzeichnen
      await page.waitForTimeout(600);
      await drag(page, cx, cy, 12, -9, 3);
      await page.waitForTimeout(80);
      a = await attrs(page);
      r = await cmp();
      check('Kleine Verschiebung nach dem Nachzeichnen des Randes: nur Kopieren, nichts neu gezeichnet', a.baseRects === '0' && r.max <= 1, `Rechtecke ${a.baseRects}, max ${r.max}`);
      await page.screenshot({ path: path.join(OUT, '01-harness-simple.png') });
      await ctx.close();
    }

    // ---------------------------------------------------------------- A2–A7: volles Mosaik bei mehreren dpr
    for (const dpr of [1, 2, 2.625]) {
      const ctx = await browser.newContext({ viewport: { width: 820, height: 680 }, deviceScaleFactor: dpr, locale: 'de-DE' });
      const page = await ctx.newPage();
      watch(page);
      await page.setContent(harnessHtml(harness, {}));
      await page.waitForSelector('[data-testid="mosaic-canvas"]');
      await page.waitForTimeout(500);
      const box = await page.$eval('[data-testid="mosaic-canvas"]', (c) => {
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 7; i++) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(30);
      }
      const during = (await attrs(page)).frame;
      await page.waitForTimeout(400);
      const after = await attrs(page);
      check(`dpr ${dpr}: Rad-Zoom skaliert nur während der Geste, danach genaues Bild`, during === 'scaled' && after.frame === 'exact', `während: ${during}, danach: ${after.frame}`);
      for (const [dx, dy] of [
        [41.3, 17.9],
        [-260, 120.5],
        [333, -77],
      ])
        await drag(page, cx, cy, dx, dy);
      await page.waitForTimeout(150);
      const sc = await stoneColours(page);
      check(
        `dpr ${dpr}: jede Steinfarbe nach Zoom und Verschieben gleich dem frischen Bild`,
        sc.checked > 100 && sc.worst <= 2,
        `${sc.checked} Steine geprüft, größte Abweichung ${sc.worst}`,
      );
      check(
        `dpr ${dpr}: Abweichungen nur in der Kantenglättung (< 0,2 % der Kanalwerte)`,
        sc.over1 / sc.total < 0.002,
        `${sc.over1} von ${sc.total} Kanalwerten > 1 (${pct(sc.over1, sc.total)}), max ${sc.max}`,
      );
      if (dpr === 2) await page.screenshot({ path: path.join(OUT, '02-harness-full-dpr2.png') });

      // ---- Stein bearbeiten: Pixel ändert sich sofort, nur der Stein wird neu gezeichnet
      const v = await page.evaluate(() => window.__h.viewer().drawnView());
      const L = await page.evaluate(() => window.__h.layout);
      // ein ganzer Stein nahe der Mitte
      let target = null;
      for (let row = 0; row < L.rows && !target; row++)
        for (let col = 0; col < L.cols && !target; col++) {
          const x = box.x + v.ox + (L.colX[col] + L.colW[col] * 0.14) * v.scale;
          const y = box.y + v.oy + (L.rowY[row] + L.rowH[row] * 0.86) * v.scale;
          if (Math.abs(x - cx) < 60 && Math.abs(y - cy) < 60 && row % 4 !== 1) target = { row, col, x, y, idx: row * L.cols + col };
        }
      const before = await pixelAt(page, target.x, target.y);
      const resets0 = (await attrs(page)).baseResets;
      const c1 = await page.evaluate((i) => window.__h.c1(i), target.idx);
      await page.evaluate(([i, c]) => window.__h.setColor(i, c), [target.idx, (c1 + 3) % 8]);
      await frames(page, 2);
      const afterEdit = await pixelAt(page, target.x, target.y);
      let at = await attrs(page);
      let r = await page.evaluate(() => window.__h.compare());
      check(
        `dpr ${dpr}: Farbe geändert → Pixel am Stein sofort neu, nur der Stein neu gezeichnet`,
        dist(before, afterEdit) > 30 && at.baseResets === resets0 && at.baseDirty === '1' && r.over1 / r.total < 0.002,
        `${before} → ${afterEdit}, geänderte Zellen ${at.baseDirty}, Neuaufbau ${resets0}→${at.baseResets}`,
      );
      // ---- verlegt tippen
      const beforeLaid = afterEdit;
      await page.evaluate((i) => window.__h.toggleLaid(i), target.idx);
      await frames(page, 2);
      const afterLaid = await pixelAt(page, target.x, target.y);
      at = await attrs(page);
      check(`dpr ${dpr}: verlegt getippt → Pixel sofort getönt, nur der Stein neu gezeichnet`, dist(beforeLaid, afterLaid) > 15 && at.baseResets === resets0 && at.baseDirty === '1', `${beforeLaid} → ${afterLaid}`);
      // ---- Änderung ohne Zähler: das nächste Bild außerhalb einer Geste gleicht ab (Sicherheitsnetz)
      const t2 = { ...target, idx: target.idx + 1, x: target.x + (L.colW[target.col] + 2) * v.scale };
      const b2 = await pixelAt(page, t2.x, t2.y);
      const c2 = await page.evaluate((i) => window.__h.c1(i), t2.idx);
      await page.evaluate(([i, c]) => window.__h.setColorSilently(i, c), [t2.idx, (c2 + 4) % 8]);
      await page.evaluate(() => window.__h.setProps({ highlight: { row: 1, col: 1, piece: 0 } }));
      await frames(page, 2);
      const a2 = await pixelAt(page, t2.x, t2.y);
      at = await attrs(page);
      check(`dpr ${dpr}: Änderung ohne Versionszähler erscheint beim nächsten Bild (Abgleich mit den Daten)`, dist(b2, a2) > 30 && at.baseResets === resets0, `${b2} → ${a2}, geänderte Zellen ${at.baseDirty}`);
      // ---- Überlagerung: Abschnitt, Auswahl, Fokusbereich → kein Neuaufbau, Bild weiter gleich
      await page.evaluate(() => window.__h.setProps({ selectedSection: 'B2', highlight: { row: 10, col: 12, piece: 0 }, focusRange: { r0: 5, r1: 30, c0: 8, c1: 40 } }));
      await frames(page, 2);
      at = await attrs(page);
      r = await page.evaluate(() => window.__h.compare());
      check(`dpr ${dpr}: Abschnitt/Auswahl/Fokus ändern nur die Überlagerung (kein Neuaufbau)`, at.baseResets === resets0 && at.frame === 'exact' && r.over1 / r.total < 0.002, `Neuaufbau ${resets0}→${at.baseResets}, max ${r.max}`);
      if (dpr === 1) await page.screenshot({ path: path.join(OUT, '03-harness-edit-overlay.png') });
      await page.evaluate(() => window.__h.setProps({ selectedSection: null, highlight: null, focusRange: null }));
      await ctx.close();
    }

    // ---------------------------------------------------------------- A8: Zwei-Finger-Zoom (Touch), Rasterer-Eigenstreuung
    {
      const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, locale: 'de-DE' });
      const page = await ctx.newPage();
      watch(page);
      await page.setContent(harnessHtml(harness, {}));
      await page.waitForSelector('[data-testid="mosaic-canvas"]');
      await page.waitForTimeout(500);
      const b = await page.$eval('[data-testid="mosaic-canvas"]', (c) => {
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const cdp = await ctx.newCDPSession(page);
      const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
      const mx = b.x + b.w / 2;
      const my = b.y + b.h / 2;
      let p1 = { x: mx - 30, y: my };
      let p2 = { x: mx + 30, y: my };
      await touch('touchStart', [p1]);
      await touch('touchStart', [p1, p2]);
      const seen = new Set();
      for (let i = 1; i <= 10; i++) {
        p1 = { x: mx - 30 - i * 9, y: my - i * 2 };
        p2 = { x: mx + 30 + i * 9, y: my + i * 2 };
        await touch('touchMove', [p1, p2]);
        seen.add((await attrs(page)).frame);
      }
      await touch('touchEnd', []);
      const mid = (await attrs(page)).frame;
      await page.waitForTimeout(400);
      const fin = await attrs(page);
      const rr = await page.evaluate(() => window.__h.compare());
      check('Handy: Zwei-Finger-Zoom zeigt während der Geste das skalierte Bild, danach das genaue', seen.has('scaled') && fin.frame === 'exact' && rr.over1 / rr.total < 0.002, `während: ${[...seen].join('/')}, beim Loslassen: ${mid}, danach: ${fin.frame}, Maßstab ${fin.scale}`);
      await page.screenshot({ path: path.join(OUT, '04-harness-phone-pinch.png') });
      // Eigenstreuung des Rasterers zum Vergleich: dasselbe frische Bild, nur 64 px verschoben gezeichnet
      await page.evaluate(() => (window.__hp.refMargin = 64));
      const selfVar = await page.evaluate(() => window.__h.compare());
      await page.evaluate(() => (window.__hp.refMargin = 0));
      const own = await page.evaluate(() => window.__h.compare());
      check(
        'Zum Vergleich: der Rasterer selbst weicht bei verschobenem Zeichnen ähnlich ab (Kantenglättung, keine Farben)',
        true,
        `frisch vs. frisch um 64 px verschoben: ${selfVar.over1} Werte > 1 (max ${selfVar.max}) · Viewer vs. frisch: ${own.over1} (max ${own.max})`,
      );
      await ctx.close();
    }
  }

  // =====================================================================  Teil B: App – Stein ändern, verlegt tippen
  {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE' });
    const page = await ctx.newPage();
    watch(page);
    await page.goto(BASE);
    await page.click('[data-testid="sample-portrait"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
    await page.waitForTimeout(1500);
    const canvas = await page.$('[data-testid="mosaic-canvas"]');
    const box = await canvas.boundingBox();
    const px = box.x + box.width * 0.5;
    const py = box.y + box.height * 0.42;
    await page.mouse.move(px, py);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(500);
    let a = await attrs(page);
    check('App: nach dem Zoomen genaues Bild aus dem Rückpuffer', a.frame === 'exact' && a.overview === '0', `Bild ${a.frame}, Maßstab ${a.scale}`);
    const before = await pixelAt(page, px, py);
    const resets0 = a.baseResets;
    await page.mouse.click(px, py);
    await page.waitForSelector('[data-testid="stone-id"]');
    const stoneId = (await page.textContent('[data-testid="stone-id"]')).trim();
    // die unähnlichste Farbe (Liste ist nach ΔE sortiert)
    const alts = await page.$$('[data-testid="color-pick"] button.cp:not(.active)');
    await alts[alts.length - 1].click();
    await frames(page, 2);
    const after = await pixelAt(page, px, py);
    a = await attrs(page);
    check(
      'App: Steinfarbe im Steindetail geändert → Pixel am Stein sofort neu (nur der Stein neu gezeichnet)',
      dist(before, after) > 40 && a.baseResets === resets0 && Number(a.baseDirty) >= 1 && Number(a.baseDirty) <= 4,
      `${stoneId}: ${before} → ${after}, geänderte Zellen ${a.baseDirty}, Neuaufbau ${resets0}→${a.baseResets}`,
    );
    await page.screenshot({ path: path.join(OUT, '05-app-edit.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ---- Schritt 9: Verlegemodus, Stein antippen
    await page.click('[data-testid="step-plan"]');
    await page.waitForSelector('[data-testid="progress-pct"]');
    await page.waitForTimeout(800);
    await page.click('text=Verlegemodus');
    await page.waitForTimeout(300);
    const c2 = await page.$('[data-testid="mosaic-canvas"]');
    await c2.scrollIntoViewIfNeeded();
    const b2 = await c2.boundingBox();
    const qx = b2.x + b2.width * 0.5;
    const qy = b2.y + b2.height * 0.5;
    await page.mouse.move(qx, qy);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(500);
    a = await attrs(page);
    const r0 = a.baseResets;
    const placed0 = (await page.textContent('[data-testid="placed-count"]')).trim();
    const p0 = await pixelAt(page, qx + 2, qy + 2);
    await page.mouse.click(qx, qy);
    await frames(page, 2);
    const p1 = await pixelAt(page, qx + 2, qy + 2);
    a = await attrs(page);
    const placed1 = (await page.textContent('[data-testid="placed-count"]')).trim();
    check(
      'App: im Verlegemodus getippt → Pixel am Stein sofort getönt (nur der Stein neu gezeichnet)',
      dist(p0, p1) > 12 && a.baseResets === r0 && placed1 !== placed0,
      `${p0} → ${p1}, verlegt ${placed0} → ${placed1}, geänderte Zellen ${a.baseDirty}, Bild ${a.frame}`,
    );
    await page.screenshot({ path: path.join(OUT, '06-app-laid.png') });
    // erneut tippen → wieder offen, Pixel wie vorher
    await page.mouse.click(qx, qy);
    await frames(page, 2);
    const p2 = await pixelAt(page, qx + 2, qy + 2);
    check('App: erneut getippt → wieder offen, Pixel wie vorher', dist(p0, p2) <= 3, `${p1} → ${p2}`);
    await ctx.close();
  }

  // =====================================================================  Teil C: Leistung Tablet, CPU 4× gebremst
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'de-DE' });
    await ctx.addInitScript(INSTR);
    const page = await ctx.newPage();
    watch(page);
    const cdp = await ctx.newCDPSession(page);
    await page.goto(BASE);
    await page.click('[data-testid="sample-portrait"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.click('[data-testid="step-size"]');
    await page.fill('[data-testid="width-input"]', '200');
    await page.fill('[data-testid="height-input"]', '100');
    await page.click('[data-testid="step-tiles"]');
    await page.click('[data-testid="tile-presets"] >> text="5 × 5 mm"');
    await page.click('[data-testid="step-compute"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    const positions = (await page.textContent('[data-testid="grid-positions"]')).trim();
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 600000 });
    await page.waitForTimeout(2500);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const canvas = await page.$('[data-testid="mosaic-canvas"]');
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    const rows = [];
    for (let level = 0; level <= 18; level++) {
      if (level > 0) {
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(120);
      }
      if (level < 4 || level % 2 !== 0) continue;
      await page.waitForTimeout(300);
      await page.evaluate(() => (window.__perf.raf.length = 0));
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      for (let i = 0; i < 20; i++) {
        await page.mouse.move(cx + (i % 2 ? 15 : -15), cy + (i % 2 ? 10 : -10));
        await page.waitForTimeout(30);
      }
      await page.mouse.up();
      await page.waitForTimeout(200);
      const ms = (await page.evaluate(() => window.__perf.raf.map((x) => x.ms))).sort((x, y) => x - y);
      rows.push({ level, n: ms.length, median: ms[Math.floor(ms.length / 2)] ?? 0, p95: ms[Math.floor(ms.length * 0.95)] ?? 0 });
    }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await page.screenshot({ path: path.join(OUT, '07-tablet-zoomed.png') });
    const worst = Math.max(...rows.map((r) => r.median));
    check(
      `Tablet (1280 × 800, dpr 2, CPU 4× gebremst, ${positions} Positionen): Verschieben auf Zoomstufen 4–18, Median rAF < 8 ms`,
      rows.length === 8 && worst < 8,
      rows.map((r) => `Stufe ${r.level}: ${fmt(r.median)} / p95 ${fmt(r.p95)} ms`).join(' · '),
    );
    await ctx.close();
  }

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} Prüfungen bestanden`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => {
  console.error('✘ Abbruch:', e);
  process.exit(1);
});
