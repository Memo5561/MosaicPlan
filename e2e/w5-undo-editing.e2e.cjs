/* Browser-Test Paket w5-undo-editing (Chromium/Playwright):
 *  - Steindetail am Desktop als Seitenleiste neben dem Mosaik (kein Hintergrund, Legende ersetzt, Mosaik bedienbar, Esc)
 *  - Farbe 03 → 02, Strg+Z → 03, Strg+Umschalt+Z → 02, Strg+Y; nicht in Eingabefeldern; Zähler an den Knöpfen
 *  - Form + „verlegt“ zurücknehmen; geänderter Stein → Rückgängig verworfen (nie alten Stand überschreiben)
 *  - „Heller“ auf einem hellblauen Stein: gleiche Farbe heller oder gesperrt mit Hinweis; nach Ergänzen eines helleren
 *    Blaus in Schritt 5 wird genau dieses gewählt
 *  - Palette: Farbe entfernen → Rückgängig → gespeichertes Raster Byte für Byte wie vorher
 *  - Verlegen in Schritt 9: Strg+Z / Wiederholen, gemeinsamer Verlauf
 *  - Vergleich Foto/Mosaik nach Neuladen weiter da; ältere Projekte: „Referenz neu erzeugen“
 *  - Handy: Dialog von unten, Reihenfolge Kurzinfo → Farbe → Schnitt → Form → Position, Farbreihe in einer Zeile
 * Aufruf: node e2e/w5-undo-editing.e2e.cjs <baseUrl> <outDir>
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w5-undo-editing');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info !== '' ? ` – ${info}` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const projectId = (page) => (page.url().match(/#\/project\/([^/]+)/) || [])[1];
const txt = async (page, sel) => ((await page.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  let v = await fn();
  while (!v && Date.now() - t0 < ms) {
    await wait(150);
    v = await fn();
  }
  return v;
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) });

// ---------- sRGB → CIELAB (D65), wie core/color.ts
function hexToLab(hex) {
  const h = hex.replace('#', '');
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const X = (c[0] * 0.4124564 + c[1] * 0.3575761 + c[2] * 0.1804375) / 0.95047;
  const Y = c[0] * 0.2126729 + c[1] * 0.7151522 + c[2] * 0.072175;
  const Z = (c[0] * 0.0193339 + c[1] * 0.119192 + c[2] * 0.9503041) / 1.08883;
  const f = (v) => (v > 216 / 24389 ? Math.cbrt(v) : (24389 / 27 * v + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
function labToHex(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const inv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const X = inv(fx) * 0.95047;
  const Y = inv(fy);
  const Z = inv(fz) * 1.08883;
  const r = X * 3.2404542 - Y * 1.5371385 - Z * 0.4985314;
  const g = -X * 0.969266 + Y * 1.8760108 + Z * 0.041556;
  const bl = X * 0.0556434 - Y * 0.2040259 + Z * 1.0572252;
  const enc = (v) => {
    const x = Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
    return Math.round(x * 255).toString(16).padStart(2, '0');
  };
  return `#${enc(r)}${enc(g)}${enc(bl)}`.toUpperCase();
}
const rowLabel = (i) => {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/** Zustand aus IndexedDB (Projekt, Raster-Kennwerte, Vergleichsfoto) */
const dbState = (page, id) =>
  page.evaluate(
    (id) =>
      new Promise((res, rej) => {
        const r = indexedDB.open('mosaicplan');
        r.onsuccess = () => {
          const tx = r.result.transaction(['projects', 'mosaics', 'images', 'progress']);
          const out = {};
          tx.objectStore('projects').get(id).onsuccess = (e) => (out.rec = e.target.result);
          tx.objectStore('mosaics').get(id).onsuccess = (e) => (out.m = e.target.result);
          tx.objectStore('progress').get(id).onsuccess = (e) => (out.p = e.target.result);
          tx.objectStore('images').get(id).onsuccess = (e) => (out.img = e.target.result);
          tx.oncomplete = () => {
            r.result.close();
            const m = out.m;
            const hash = (a) => {
              if (!a) return 'null';
              let h = 2166136261;
              const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
              for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
              return `${u.length}:${h >>> 0}`;
            };
            const ref = out.img && out.img.reference;
            res({
              palette: out.rec ? out.rec.palette.map((p) => ({ code: p.code, hex: p.hex, lab: p.lab, name: p.name })) : [],
              mosaicRev: out.rec ? out.rec.mosaicRev : null,
              cols: m ? m.cols : 0,
              rows: m ? m.rows : 0,
              kind: m ? Array.from(m.kind) : [],
              c1: m ? Array.from(m.c1) : [],
              bytes: m ? ['kind', 'c1', 'c2', 'subIdx', 'subLen', 'subCol', 'lineIdx', 'lineVal'].map((k) => hash(m[k])).join('|') + '|' + JSON.stringify(m.free) + '|' + hash(out.p) : '',
              ref: ref ? { rev: ref.rev ?? null, w: ref.w, h: ref.h, origin: ref.origin, size: ref.jpeg ? ref.jpeg.size : 0, type: ref.jpeg ? ref.jpeg.type : '' } : null,
            });
          };
          tx.onerror = () => rej(tx.error);
        };
      }),
    id,
  );

/** Projekt-API aus den Props der Rückgängig-Knöpfe (nur für den Test ohne Verlauf) */
const withApi = (page, sel, fn, arg) =>
  page.evaluate(
    ([sel, src, arg]) => {
      const el = document.querySelector(sel);
      const key = el && Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
      let f = key ? el[key] : null;
      while (f && !(f.memoizedProps && f.memoizedProps.api && f.memoizedProps.api.editCell)) f = f.return;
      if (!f) return { error: 'no api' };
      // eslint-disable-next-line no-new-func
      return new Function('api', 'arg', src)(f.memoizedProps.api, arg);
    },
    [sel, fn, arg],
  );

async function findStone(page, id) {
  // Steindetail offen → zuerst schließen (die Suche steht in der Seitenleiste)
  if (await page.$('[data-testid="stone-panel"]')) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="find-stone"]');
  }
  await page.fill('[data-testid="find-stone"]', id);
  await page.press('[data-testid="find-stone"]', 'Enter');
  await page.waitForSelector('[data-testid="stone-id"]');
  await wait(250);
}
const activeCode = (page) => page.$eval('[data-testid="color-pick"] button.active small', (e) => e.textContent.trim()).catch(() => null);
const undoCount = async (page, sel = '[data-testid="history-undo"]') => parseInt(((await txt(page, sel)).match(/\((\d+)\)/) || [])[1] ?? '-1', 10);

async function clickCode(page, code) {
  let b = await page.$(`[data-testid="color-pick"] button[data-code="${code}"]`);
  if (!b) {
    await page.click('[data-testid="colors-all"]');
    b = await page.$(`[data-testid="color-pick"] button[data-code="${code}"]`);
  }
  if (!b) return false;
  await b.click();
  await wait(200);
  return true;
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  try {
    // =====================================================================  Desktop
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('dialog', (d) => d.accept());
    await page.goto(BASE);
    await page.click('[data-testid="sample-portrait"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
    await wait(1500);
    const pid = projectId(page);

    // ---------- Vergleichsfoto wurde mit der Berechnung gespeichert
    const st0 = await until(async () => {
      const s = await dbState(page, pid);
      return s.ref ? s : null;
    }, 10000);
    check(
      'Berechnung speichert das Vergleichsfoto (JPEG ≤ 2048 px, gleiche Revision wie das Raster)',
      !!st0 && st0.ref.rev === st0.mosaicRev && st0.ref.type === 'image/jpeg' && Math.max(st0.ref.w, st0.ref.h) <= 2048 && st0.ref.size > 1000 && st0.ref.origin === 'compute',
      st0 ? `${st0.ref.w}×${st0.ref.h}, ${Math.round(st0.ref.size / 1024)} KB` : 'keins',
    );

    // ---------- Steindetail als Seitenleiste
    await findStone(page, 'AI034');
    const layout = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="stone-panel"]');
      const cv = document.querySelector('[data-testid="mosaic-canvas"]').getBoundingClientRect();
      const r = panel ? panel.getBoundingClientRect() : null;
      return {
        panel: !!panel,
        role: panel && panel.getAttribute('role'),
        backdrop: !!document.querySelector('.modal-backdrop'),
        legend: !!document.querySelector('[data-testid="legend-item"]'),
        right: r ? r.left >= cv.right - 1 : false,
      };
    });
    check('Desktop: Steindetail neben dem Mosaik (Seitenleiste statt Legende, kein abdunkelnder Hintergrund)', layout.panel && layout.role === 'dialog' && !layout.backdrop && !layout.legend && layout.right, JSON.stringify(layout));
    await shot(page, 'w5ue-01-panel.png');
    const id0 = (await txt(page, '[data-testid="stone-id"]')).split(' ')[0];
    // Mosaik bleibt bedienbar: anderen Stein anklicken → Seitenleiste zeigt ihn
    const cvb = await page.$eval('[data-testid="mosaic-canvas"]', (c) => {
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await page.mouse.click(cvb.x + cvb.w * 0.3, cvb.y + cvb.h * 0.7);
    await wait(300);
    const id1 = (await txt(page, '[data-testid="stone-id"]')).split(' ')[0];
    check('Mosaik bleibt bedienbar: Klick auf einen anderen Stein zeigt ihn in der Seitenleiste', !!id1 && id1 !== id0 && !!(await page.$('[data-testid="stone-panel"]')), `${id0} → ${id1}`);
    await page.keyboard.press('Escape');
    await wait(200);
    check('Esc schließt die Seitenleiste, die Legende ist wieder da', !(await page.$('[data-testid="stone-panel"]')) && !!(await page.$('[data-testid="legend-item"]')));

    // ---------- 03 → 02, Strg+Z, Strg+Umschalt+Z, Strg+Y
    await findStone(page, 'AI034');
    const c0 = await activeCode(page);
    const from = c0;
    const to = from === '02' ? '03' : '02';
    await clickCode(page, to);
    const c1 = await activeCode(page);
    const n1 = await undoCount(page);
    await page.keyboard.press('Control+z');
    await wait(300);
    const c2 = await activeCode(page);
    await page.keyboard.press('Control+Shift+z');
    await wait(300);
    const c3 = await activeCode(page);
    check(`Farbe ${from} → ${to}, Strg+Z → ${from}, Strg+Umschalt+Z → ${to} (Zähler ${n1})`, from === '03' && c1 === to && c2 === from && c3 === to && n1 === 1, `${c0} → ${c1} → ${c2} → ${c3}`);
    const status = await txt(page, '[data-testid="history-status"]');
    check('Statuszeile nennt den Schritt („Wiederhergestellt: AI034: Farbe 03 → 02“)', /Wiederhergestellt: AI034: Farbe 03 → 02/.test(status), status);
    await page.keyboard.press('Control+z');
    await wait(250);
    await page.keyboard.press('Control+y');
    await wait(250);
    check('Strg+Y wiederholt ebenfalls', (await activeCode(page)) === to);
    const saved = await until(async () => {
      const s = await dbState(page, pid);
      const p = s.palette.findIndex((x) => String(x.code).padStart(2, '0') === to);
      return s.c1[34 * s.cols + 33] === p ? s : null;
    });
    check('Gespeichert: Stein AI034 hat die wiederhergestellte Farbe', !!saved);
    // nicht in Eingabefeldern
    await page.click('[data-testid="stone-panel"] .numin input >> nth=0');
    await page.keyboard.press('Control+z');
    await wait(250);
    check('Strg+Z in einem Eingabefeld gehört dem Feld (Stein unverändert)', (await activeCode(page)) === to);
    await page.click('[data-testid="stone-summary"]');
    // Knöpfe
    await page.click('[data-testid="history-undo"]');
    await wait(250);
    const cu = await activeCode(page);
    const redoTxt = await txt(page, '[data-testid="history-redo"]');
    await page.click('[data-testid="history-redo"]');
    await wait(250);
    check('Knöpfe ↶/↷ mit Zählern (Rückgängig (0) · Wiederholen (1) dazwischen)', cu === from && /\(1\)/.test(redoTxt) && (await activeCode(page)) === to, `${cu} | ${redoTxt}`);
    await shot(page, 'w5ue-02-color-undo.png');

    // ---------- Form + verlegt zurücknehmen
    if (!(await page.isChecked('[data-testid="stone-placed"]'))) await page.click('[data-testid="stone-placed"]');
    await wait(200);
    await page.click('[data-testid="kind-diagA"]');
    await wait(300);
    const split = await txt(page, '[data-testid="stone-id"]');
    const placedAfterShape = await page.isChecked('[data-testid="stone-placed"]');
    await page.keyboard.press('Control+z');
    await wait(300);
    const back = await txt(page, '[data-testid="stone-id"]');
    check(
      'Form ändern setzt „verlegt“ zurück – Strg+Z stellt ganzen Stein UND „verlegt“ wieder her',
      /-1/.test(split.split(' ')[0]) && !placedAfterShape && !/-\d/.test(back.split(' ')[0]) && (await page.isChecked('[data-testid="stone-placed"]')),
      `${split.slice(0, 10)} → ${back.slice(0, 10)}`,
    );
    await page.keyboard.press('Control+z'); // „verlegt“ wieder zurück
    await wait(250);
    check('… und noch einmal Strg+Z: „verlegt“ wieder offen', !(await page.isChecked('[data-testid="stone-placed"]')));

    // ---------- inzwischen anders geändert → nie alten Stand überschreiben
    await clickCode(page, from);
    const idxAI034 = await withApi(page, '[data-testid="history-undo"]', 'return api.computed.layout.cols * 34 + 33;');
    // ohne Verlauf ändern (wie ein anderer Weg): Farbe direkt im Raster
    const injected = await withApi(page, '[data-testid="history-undo"]', 'const d = api.computed.data; d.c1[arg] = (d.c1[arg] + 5) % api.rec.palette.length; api.touchProgress([arg]); return d.c1[arg];', idxAI034);
    await page.keyboard.press('Control+z');
    await wait(300);
    const after = await withApi(page, '[data-testid="history-undo"]', 'return api.computed.data.c1[arg];', idxAI034);
    const stale = await txt(page, '[data-testid="history-status"]');
    check('Stein inzwischen anders geändert: Rückgängig wird verworfen, die neuere Farbe bleibt, Meldung', after === injected && /Nicht rückgängig gemacht/.test(stale), `${injected} → ${after} | ${stale.slice(0, 80)}`);
    await withApi(page, '[data-testid="history-undo"]', 'const d = api.computed.data; d.c1[arg] = 0; return 0;', idxAI034);
    await page.keyboard.press('Escape');

    // ---------- Heller auf einem hellblauen Stein
    const sb = await dbState(page, pid);
    const blues = sb.palette.map((p, i) => ({ ...p, i })).filter((p) => p.lab[2] < -8 && Math.hypot(p.lab[1], p.lab[2]) > 8);
    blues.sort((a, b) => b.lab[0] - a.lab[0]);
    const pale = blues[0];
    let paleCell = -1;
    if (pale) for (let i = 0; i < sb.c1.length; i++) if (sb.kind[i] === 0 && sb.c1[i] === pale.i) {
      paleCell = i;
      break;
    }
    if (pale && paleCell >= 0) {
      const id = `${rowLabel(Math.floor(paleCell / sb.cols))}${String((paleCell % sb.cols) + 1).padStart(3, '0')}`;
      await findStone(page, id);
      const lighterDisabled = await page.isDisabled('[data-testid="shade-lighter"]');
      const hint = await txt(page, '[data-testid="shade-hint"]');
      let okA;
      if (lighterDisabled) okA = /Kein hellerer Farbton dieser Farbe in der Palette – im Schritt Farben ergänzen/.test(hint);
      else {
        const target = await page.getAttribute('[data-testid="shade-lighter"]', 'data-target');
        const tp = sb.palette.find((p) => String(p.code).padStart(2, '0') === target);
        const dL = tp.lab[0] - pale.lab[0];
        const dab = Math.hypot(tp.lab[1] - pale.lab[1], tp.lab[2] - pale.lab[2]);
        okA = dL >= 3 && dab <= 10;
      }
      check(`„Heller“ auf hellblauem Stein ${id} (${String(pale.code).padStart(2, '0')} ${pale.hex}): gleicher Farbton heller – oder gesperrt mit Hinweis`, okA, lighterDisabled ? hint : 'aktiv');
      await shot(page, 'w5ue-03-lighter-before.png');
      // helleres Blau gleichen Farbtons ergänzen (L* +6) → „Heller“ wählt genau dieses
      const newHex = labToHex(pale.lab[0] + 6, pale.lab[1] * 0.92, pale.lab[2] * 0.92);
      const nl = hexToLab(newHex);
      await page.keyboard.press('Escape');
      await page.click('[data-testid="step-colors"]');
      await page.waitForSelector('[data-testid="palette-table"]');
      const before = (await dbState(page, pid)).palette.length;
      await page.locator('input[aria-label="Neue Farbe"]').fill(newHex.toLowerCase()).catch(async () => {
        await page.$eval('.palette-editor .btn-row input[type="color"]', (el, v) => {
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          set.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }, newHex.toLowerCase());
      });
      await page.click('.palette-editor button:has-text("Hinzufügen")');
      await wait(400);
      const added = await until(async () => {
        const s = await dbState(page, pid);
        return s.palette.length === before + 1 ? s : null;
      });
      const pu = await undoCount(page, '[data-testid="palette-history-undo"]');
      // Palette: Rückgängig/Wiederholen auch hier (Strg+Z außerhalb von Eingabefeldern)
      await page.click('h3:has-text("Palette")').catch(() => {});
      await page.keyboard.press('Control+z');
      const removed = await until(async () => ((await dbState(page, pid)).palette.length === before ? true : null));
      await page.keyboard.press('Control+Shift+z');
      const re = await until(async () => ((await dbState(page, pid)).palette.length === before + 1 ? true : null));
      check('Schritt 5: Farbe ergänzt → Strg+Z entfernt sie wieder, Strg+Umschalt+Z ergänzt sie wieder', !!added && pu >= 1 && removed && re, `${before} → ${before + 1} (Verlauf ${pu})`);
      const newCode = added ? String(added.palette[added.palette.length - 1].code).padStart(2, '0') : '';
      await page.click('[data-testid="step-preview"]');
      await page.waitForSelector('[data-testid="find-stone"]');
      await findStone(page, id);
      const enabled = !(await page.isDisabled('[data-testid="shade-lighter"]'));
      const target = await page.getAttribute('[data-testid="shade-lighter"]', 'data-target');
      await shot(page, 'w5ue-04-lighter-after.png');
      if (enabled) await page.click('[data-testid="shade-lighter"]');
      await wait(300);
      const now = await activeCode(page);
      check(
        `Nach Ergänzen von ${newHex} (L* ${nl[0].toFixed(1)} statt ${pale.lab[0].toFixed(1)}): „Heller“ wählt genau Farbe ${newCode} – mit einem Klick`,
        enabled && target === newCode && now === newCode,
        `Ziel ${target}, jetzt ${now}`,
      );
      // ▲/▼-Markierung für Touch
      const marks = await page.$$eval('[data-testid="color-pick"] button[data-mark]', (bs) => bs.map((b) => b.dataset.mark));
      check('Farbreihe: ▲/▼ für heller/dunkler als die aktuelle Farbe', marks.includes('up') || marks.includes('down'), marks.join(','));
      const sel = await txt(page, '[data-testid="color-selected"]');
      check('Unter der gewählten Farbe: Name und ΔE zur Ausgangsfarbe', new RegExp(`${newCode} .+ΔE [\\d,]+ zur Ausgangsfarbe ${String(pale.code).padStart(2, '0')}`).test(sel), sel);
      await page.keyboard.press('Control+z');
      await wait(250);
      await page.keyboard.press('Escape');
    } else check('Hellblaue Farbe im Porträt gefunden', false, JSON.stringify(blues.map((b) => b.hex)));

    // ---------- Palette: häufigste Farbe entfernen und zurücknehmen → Raster Byte für Byte
    await page.click('[data-testid="step-colors"]');
    await page.waitForSelector('[data-testid="palette-table"]');
    await wait(800);
    const s1 = await dbState(page, pid);
    const counts = new Map();
    for (let i = 0; i < s1.c1.length; i++) if (s1.kind[i] === 0) counts.set(s1.c1[i], (counts.get(s1.c1[i]) || 0) + 1);
    const most = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const mostCode = String(s1.palette[most].code).padStart(2, '0');
    await page.click(`tr[data-code="${mostCode}"] [data-testid="palette-remove"]`);
    await page.waitForSelector('[data-testid="palette-remove-confirm"]');
    await page.click('[data-testid="palette-remove-confirm"]');
    const s2 = await until(async () => {
      const s = await dbState(page, pid);
      return s.palette.length === s1.palette.length - 1 && s.bytes !== s1.bytes ? s : null;
    });
    await shot(page, 'w5ue-05-palette-removed.png');
    await page.click('[data-testid="palette-history-undo"]');
    const s3 = await until(async () => {
      const s = await dbState(page, pid);
      return s.palette.length === s1.palette.length && s.bytes === s1.bytes ? s : null;
    }, 10000);
    check(`Häufigste Farbe ${mostCode} entfernt (${counts.get(most)} ganze Steine) und zurückgenommen: gespeichertes Raster und Fortschritt Byte für Byte gleich`, !!s2 && !!s3 && JSON.stringify(s3.palette.map((p) => p.hex)) === JSON.stringify(s1.palette.map((p) => p.hex)));
    await page.click('[data-testid="palette-history-redo"]');
    const s4 = await until(async () => {
      const s = await dbState(page, pid);
      return s2 && s.bytes === s2.bytes ? s : null;
    }, 10000);
    check('Wiederholen entfernt sie wieder (gleiches Raster wie nach dem Entfernen)', !!s4);
    await page.click('[data-testid="palette-history-undo"]');
    await until(async () => ((await dbState(page, pid)).bytes === s1.bytes ? true : null), 10000);

    // ---------- Schritt 9: Verlegen mit Strg+Z / Wiederholen (gemeinsamer Verlauf)
    await page.click('[data-testid="step-plan"]');
    await page.waitForSelector('[data-testid="lay-undo"]');
    await page.click('text=Verlegemodus');
    await wait(300);
    const placed = async () => parseInt(((await txt(page, '[data-testid="placed-count"]')) || '0').replace(/\D/g, ''), 10);
    const p0 = await placed();
    const cv = await page.$eval('[data-testid="mosaic-canvas"]', (c) => {
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(cv.x, cv.y);
    const p1 = await until(async () => ((await placed()) === p0 + 1 ? p0 + 1 : null));
    const lu = await txt(page, '[data-testid="lay-undo"]');
    await page.keyboard.press('Control+z');
    await wait(300);
    const st9 = await txt(page, '[data-testid="lay-status"]');
    const p2 = await until(async () => ((await placed()) === p0 ? p0 : null));
    await page.click('[data-testid="lay-redo"]');
    const p3 = await until(async () => ((await placed()) === p0 + 1 ? p0 + 1 : null));
    check('Schritt 9: Stein antippen → Strg+Z wieder offen → Wiederholen wieder verlegt', p1 === p0 + 1 && p2 === p0 && p3 === p0 + 1 && /Rückgängig gemacht: .+ als verlegt markiert/.test(st9), `${lu} | ${st9}`);
    await shot(page, 'w5ue-06-plan-undo.png');

    // ---------- Vergleich Foto/Mosaik nach dem Neuladen
    await page.click('[data-testid="step-preview"]');
    await page.waitForSelector('[data-testid="compare-toggle"]', { state: 'attached' });
    await page.reload();
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 60000 });
    await until(async () => !(await page.isDisabled('[data-testid="compare-toggle"]')), 8000);
    const togOk = !(await page.isDisabled('[data-testid="compare-toggle"]'));
    if (togOk) await page.locator('label:has([data-testid="compare-toggle"])').click();
    await wait(400);
    const slider = !!(await page.$('[data-testid="compare-slider"]'));
    const thumb = !!(await page.$('[data-testid="orig-thumb"] canvas'));
    // Bild: links vom Teiler das Foto (anders als das Mosaik an derselben Stelle)
    const px = async () =>
      page.$eval('[data-testid="mosaic-canvas"]', (c) => {
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(Math.round(c.width * 0.2), Math.round(c.height * 0.5), 40, 40).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] * 3 + d[i + 2] * 7;
        return s;
      });
    const withPhoto = await px();
    if (togOk) await page.locator('label:has([data-testid="compare-toggle"])').click();
    await wait(400);
    const withoutPhoto = await px();
    check('Nach Berechnen und Neuladen: Vergleich Foto/Mosaik weiter verfügbar (Regler, Foto links vom Teiler, Vorschaubild)', togOk && slider && thumb && withPhoto !== withoutPhoto && !(await page.$('[data-testid="reference-missing"]')), `${withPhoto} vs ${withoutPhoto}`);
    await shot(page, 'w5ue-07-reload-compare.png');

    // ---------- Älteres Projekt ohne gespeichertes Vergleichsfoto: „Referenz neu erzeugen“
    const refBefore = (await dbState(page, pid)).ref;
    await page.evaluate(
      (id) =>
        new Promise((res) => {
          const r = indexedDB.open('mosaicplan');
          r.onsuccess = () => {
            const tx = r.result.transaction('images', 'readwrite');
            const st = tx.objectStore('images');
            st.get(id).onsuccess = (e) => {
              const img = e.target.result;
              delete img.reference;
              st.put(img, id);
            };
            tx.oncomplete = () => {
              r.result.close();
              res();
            };
          };
        }),
      pid,
    );
    await page.reload();
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 60000 });
    await page.waitForSelector('[data-testid="reference-regenerate"]', { timeout: 8000 }).catch(() => null);
    const missTxt = await txt(page, '[data-testid="reference-missing"]');
    const missOk = /unvollständig/.test(missTxt) && /nicht gespeichert/.test(missTxt) && (await page.isDisabled('[data-testid="compare-toggle"]'));
    await shot(page, 'w5ue-08-reference-missing.png');
    const t0 = Date.now();
    await page.click('[data-testid="reference-regenerate"]').catch(() => {});
    await until(async () => !(await page.isDisabled('[data-testid="compare-toggle"]')), 30000);
    const regenMs = Date.now() - t0;
    const refAfter = await until(async () => (await dbState(page, pid)).ref, 8000);
    check(
      'Älteres Projekt: „unvollständig – nicht gespeichert“ + „Referenz neu erzeugen“ → Vergleich wieder da, gespeichert (gleiche Maße wie bei der Berechnung)',
      missOk && !(await page.isDisabled('[data-testid="compare-toggle"]')) && !!refAfter && refAfter.origin === 'regenerated' && refAfter.rev === refBefore.rev && refAfter.w === refBefore.w && refAfter.h === refBefore.h,
      `${missTxt.slice(0, 70)} | ${regenMs} ms | ${refAfter ? `${refAfter.w}×${refAfter.h} ${refAfter.origin}` : '–'}`,
    );
    check('Hinweis „nachträglich erzeugt“ am Vergleichsfoto', !!(await page.$('[data-testid="reference-regenerated"]')));
    await shot(page, 'w5ue-09-reference-regenerated.png');
    // Englisch/Türkisch: Steindetail-Texte vorhanden
    for (const [lang, word] of [
      ['en', 'Lighter'],
      ['tr', 'Daha açık'],
    ]) {
      await page.evaluate((l) => localStorage.setItem('mosaicplan.lang', l), lang).catch(() => {});
      await page.goto(BASE + '#/settings');
      const opt = lang === 'en' ? 'English' : 'Türkçe';
      await page.click(`[data-testid="lang-select"] >> text=${opt}`).catch(() => {});
      await page.goto(`${BASE}#/project/${pid}/preview`);
      await page.waitForSelector('[data-testid="find-stone"]', { timeout: 60000 });
      await findStone(page, 'AI034');
      const sh = await txt(page, '[data-testid="shade-lighter"]');
      check(`Sprache ${lang}: Steindetail übersetzt („${word}“)`, sh.includes(word), sh);
      await page.keyboard.press('Escape');
    }
    await page.goto(BASE + '#/settings');
    await page.click('[data-testid="lang-select"] >> text=Deutsch').catch(() => {});
    await ctx.close();

    // =====================================================================  Handy
    const ph = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'de-DE' });
    const pp = await ph.newPage();
    pp.on('pageerror', (e) => errors.push(String(e)));
    // eigener Speicher je Kontext: Beispielprojekt hier neu berechnen
    await pp.goto(BASE);
    await pp.tap('[data-testid="sample-portrait"]');
    await pp.waitForSelector('[data-testid="compute-btn"]');
    await pp.tap('[data-testid="compute-btn"]');
    await pp.waitForSelector('[data-testid="find-stone"]', { timeout: 180000 });
    await wait(1200);
    await pp.fill('[data-testid="find-stone"]', 'AI034');
    await pp.press('[data-testid="find-stone"]', 'Enter');
    await pp.waitForSelector('.modal [data-testid="stone-id"]');
    await wait(500);
    const order = await pp.evaluate(() => {
      const y = (sel) => {
        const e = document.querySelector(sel);
        return e ? e.getBoundingClientRect().top + document.querySelector('.modal-body').scrollTop : null;
      };
      const m = document.querySelector('.modal').getBoundingClientRect();
      const cps = [...document.querySelectorAll('[data-testid="color-pick"] .cp')].map((b) => Math.round(b.getBoundingClientRect().top));
      return {
        sheet: Math.abs(m.bottom - innerHeight) < 2 && m.left <= 1 && m.right >= innerWidth - 1,
        y: [y('[data-testid="stone-placed"]'), y('[data-testid="color-pick"]'), y('[data-testid="cut-instructions"]'), y('[data-testid="shape-buttons"]'), y('[data-testid="stone-coords"]')],
        oneRow: new Set(cps).size === 1,
        n: cps.length,
        laidH: document.querySelector('.w5ue-laid').getBoundingClientRect().height,
        colorVisible: document.querySelector('[data-testid="color-pick"]').getBoundingClientRect().top < innerHeight,
      };
    });
    const ys = order.y;
    check(
      'Handy: Steindetail als Blatt von unten; Reihenfolge Kurzinfo/verlegt → Farbe → Schnitt → Form → Position; Farbreihe in einer Zeile, ohne Blättern sichtbar',
      order.sheet && ys.every((v, i) => v !== null && (i === 0 || v > ys[i - 1])) && order.oneRow && order.n >= 12 && order.laidH >= 44 && order.colorVisible,
      JSON.stringify(order),
    );
    await pp.screenshot({ path: path.join(OUT, 'w5ue-10-phone-sheet.png') });
    // Farbe per Finger ändern, mit dem Knopf im Blatt zurücknehmen
    const pc0 = await activeCode(pp);
    await pp.tap('[data-testid="color-pick"] button:not(.active) >> nth=0');
    await wait(300);
    const pc1 = await activeCode(pp);
    await pp.tap('[data-testid="stone-history-undo"]');
    await wait(300);
    check('Handy: Farbe antippen, ↶ im Blatt nimmt sie zurück', pc1 !== pc0 && (await activeCode(pp)) === pc0, `${pc0} → ${pc1} → ${await activeCode(pp)}`);
    await ph.close();
  } catch (e) {
    check('Testlauf ohne Ausnahme', false, String(e && e.stack ? e.stack : e).slice(0, 400));
  }
  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n${ok}/${results.length} Prüfungen bestanden`);
  process.exit(ok === results.length ? 0 : 1);
})();
