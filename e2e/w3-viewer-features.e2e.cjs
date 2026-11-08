/* Browser-Test w3-viewer-features (Playwright/Chromium).
 * Teil A – App (Vorschau, Schritt 8): Lineal mit „A“ und „1“, Hervorhebung von Zeile/Spalte, Statuszeile mit
 *   Stein-ID und mm (gleich wie Steindetail), Foto/Mosaik-Vergleich (Foto deckungsgleich, Pixel bei 25 % = Foto),
 *   „Foto zeigen“ gedrückt halten, Trennlinie ziehen, grauer Farbfokus, Suche mit Aufleuchten und „nicht gefunden“,
 *   Viewer-Höhe am Desktop und am Handy, ehrlicher Hinweis ohne Referenzfoto nach dem Neuladen.
 * Teil B – Prüfstand (echter Viewer, mit esbuild gebündelt): Tippen wie bisher, Bereichsfokus, Malen, Rechteck,
 *   Leertaste/Mitteltaste/zwei Finger verschieben, langes Drücken, Rechtsklick, Hervorhebung, Vergleich.
 * Voraussetzung: `npm run build` und `npx vite preview --port 4304` laufen.
 * Aufruf: node e2e/w3-viewer-features.e2e.cjs [baseUrl] [screenshotDir]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4304/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w3-viewer-features');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const fmt = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : String(v));

// ------------------------------------------------------------------ Hilfen im Browser
/** Ansicht des Viewers aus den data-Attributen des Canvas */
const viewOf = (page) =>
  page.$eval('[data-testid="mosaic-canvas"]', (c) => {
    const r = c.getBoundingClientRect();
    return {
      scale: parseFloat(c.dataset.scale),
      ox: parseFloat(c.dataset.ox),
      oy: parseFloat(c.dataset.oy),
      fw: parseFloat(c.dataset.fw),
      fh: parseFloat(c.dataset.fh),
      w: r.width,
      h: r.height,
      left: r.left,
      top: r.top,
      dpr: c.width / r.width,
      cols: (c.dataset.rulerCols || '').split(',').filter(Boolean),
      rows: (c.dataset.rulerRows || '').split(',').filter(Boolean),
    };
  });

/** Mittelwert eines 3 × 3-Felds im Mosaik-Canvas (CSS-px-Koordinaten) */
const canvasRgb = (page, pts, sel = '[data-testid="mosaic-canvas"]') =>
  page.$eval(
    sel,
    (c, pts) => {
      const r = c.getBoundingClientRect();
      const d = c.width / r.width;
      const ctx = c.getContext('2d');
      return pts.map(([x, y]) => {
        const px = Math.round(x * d);
        const py = Math.round(y * d);
        const a = ctx.getImageData(px - 1, py - 1, 3, 3).data;
        const o = [0, 0, 0, 0];
        for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 4; k++) o[k] += a[i + k] / 9;
        return o;
      });
    },
    pts,
  );

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  };

  // =====================================================================  Teil A: App am Desktop
  {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1, locale: 'de-DE' });
    const page = await ctx.newPage();
    watch(page);
    const wait = (ms) => page.waitForTimeout(ms);
    const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });
    await page.goto(BASE);
    await page.click('[data-testid="sample-portrait"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.click('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
    await wait(1500);
    await page.click('[data-testid="viewer-fit"]');
    await wait(300);
    await shot('01-preview-rulers');

    // ---- Viewer-Höhe am Desktop
    const vh = await page.$eval('.viewer', (e) => ({ h: e.getBoundingClientRect().height, ih: window.innerHeight }));
    const expH = Math.min(1100, Math.max(420, vh.ih - 220));
    check('Desktop (≥ 981 px): Viewer-Höhe = clamp(420 px, 100dvh − 220 px, 1100 px)', Math.abs(vh.h - expH) <= 1.5, `${fmt(vh.h)} px, erwartet ${expH} px`);

    // ---- Lineal: A und 1 in der Gesamtansicht
    let v = await viewOf(page);
    check('Lineal in der Gesamtansicht: Spalte „1“ und Zeile „A“ beschriftet', v.cols[0] === '1' && v.rows[0] === 'A', `Spalten ${v.cols.slice(0, 6).join(',')} … · Zeilen ${v.rows.slice(0, 6).join(',')} …`);
    const stepOk = (labels, isRow) => {
      if (labels.length < 3) return false;
      const idx = labels.map((l) => (isRow ? l.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) : parseInt(l, 10)));
      const step = idx[2] - idx[1];
      return [1, 5, 10, 50].includes(step) && idx.slice(1).every((i) => i % step === 0);
    };
    check('Lineal-Schritt wie im PDF (1/5/10/50, Vielfache des Schritts)', stepOk(v.cols, false) && stepOk(v.rows, true), `Raster ${fmt(v.scale * 6)} px`);
    // Pixel: dunkle Schrift im oberen und linken Band nahe dem Mosaikanfang
    const ink = await page.$eval(
      '[data-testid="mosaic-canvas"]',
      (c, v) => {
        const ctx = c.getContext('2d');
        // Schriftpixel deutlich dunkler als das helle Band (Teilstriche liegen außerhalb dieser Felder)
        const count = (x0, y0, w, h) => {
          const d = ctx.getImageData(Math.round(x0), Math.round(y0), Math.round(w), Math.round(h)).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) if (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2] < 170) n++;
          return n;
        };
        return { top: count(v.ox - 4, 2, 16, 10), left: count(1, v.oy - 3, 12, 16) };
      },
      v,
    );
    check('Lineal sichtbar gezeichnet („1“ oben und „A“ links am Mosaikanfang)', ink.top >= 4 && ink.left >= 4, `dunkle Pixel oben ${ink.top}, links ${ink.left}`);

    // ---- Statuszeile (Maus): Stein-ID und Lage wie im Steindetail
    const statusOf = () => page.textContent('[data-testid="viewer-status-main"]');
    let hoverPt = null;
    let hoverText = '';
    for (const [fx, fy] of [
      [0.42, 0.41],
      [0.43, 0.42],
      [0.45, 0.44],
      [0.47, 0.46],
    ]) {
      const x = v.left + v.ox + v.fw * v.scale * fx;
      const y = v.top + v.oy + v.fh * v.scale * fy;
      await page.mouse.move(x, y);
      await wait(120);
      hoverText = (await statusOf()).trim();
      if (/^[A-Z]+\d{3,}(-\d+)? · Stein bei X/.test(hoverText)) {
        hoverPt = { x, y };
        break;
      }
    }
    const hm = /^([A-Z]+\d{3,}(?:-\d+)?) · Stein bei X ([\d.,]+) mm, Y ([\d.,]+) mm$/.exec(hoverText);
    const cursorText = (await page.textContent('[data-testid="viewer-status-cursor"]')).trim();
    check('Statuszeile zeigt Stein-ID und Lage in mm', !!hm && /^Zeiger X [\d.,]+ mm, Y [\d.,]+ mm$/.test(cursorText), `${hoverText} | ${cursorText}`);
    await shot('02-hover-status');
    if (hm && hoverPt) {
      await page.mouse.click(hoverPt.x, hoverPt.y);
      await page.waitForSelector('[data-testid="stone-id"]');
      const sid = (await page.textContent('[data-testid="stone-id"]')).trim();
      const coords = (await page.textContent('[data-testid="stone-coords"]')).trim();
      check('Statuszeile = Steindetail (ID und X/Y gleich)', sid.startsWith(hm[1]) && coords.includes(`X ${hm[2]} mm`) && coords.includes(`Y ${hm[3]} mm`), `${sid.slice(0, 10)} | ${coords.slice(0, 32)}`);
      // Lineal hebt Zeile und Spalte des gewählten Steins hervor (Terrakotta im Band)
      await wait(300);
      const hl = await page.$eval(
        '[data-testid="mosaic-canvas"]',
        (c, p) => {
          const r = c.getBoundingClientRect();
          const ctx = c.getContext('2d');
          const isAccent = (x, y) => {
            const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
            return d[0] > 150 && d[1] < 110 && d[2] < 90;
          };
          let top = 0;
          let left = 0;
          for (let dx = -4; dx <= 4; dx++) if (isAccent(p.x - r.left + dx, 1)) top++;
          for (let dy = -4; dy <= 4; dy++) if (isAccent(1, p.y - r.top + dy)) left++;
          return { top, left };
        },
        hoverPt,
      );
      check('Lineal hebt Zeile und Spalte des gewählten Steins hervor', hl.top >= 7 && hl.left >= 7, `oben ${hl.top}/9, links ${hl.left}/9`);
      await shot('03-ruler-highlight');
      await page.keyboard.press('Escape');
      await wait(400);
    }
    // Zeiger weg vom Mosaik
    await page.mouse.move(5, 5);
    await wait(150);
    check('Statuszeile ohne Zeiger: Hinweistext', /Mauszeiger über einen Stein/.test(await statusOf()));

    // ---- Foto/Mosaik-Vergleich
    await page.click('[data-testid="viewer-fit"]');
    await page.locator('label:has([data-testid="compare-toggle"])').click();
    await page.waitForSelector('[data-testid="compare-slider"]');
    await page.$eval('[data-testid="mosaic-canvas"]', (c) => c.scrollIntoView({ block: 'center' }));
    await wait(400);
    v = await viewOf(page);
    const sliderVal = await page.$eval('[data-testid="compare-slider"]', (e) => e.value);
    /** Foto-Pixel (3 × 3-Mittel) an der Weltposition eines Canvas-Punkts */
    const photoAt = (pts) =>
      page.$eval(
        '[data-testid="reference-photo"]',
        (img, { pts, v }) => {
          const ctx = img.getContext('2d');
          return pts.map(([x, y]) => {
            const ix = Math.round(((x - v.ox) / (v.fw * v.scale)) * img.width);
            const iy = Math.round(((y - v.oy) / (v.fh * v.scale)) * img.height);
            const a = ctx.getImageData(ix - 1, iy - 1, 3, 3).data;
            const o = [0, 0, 0];
            for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) o[k] += a[i + k] / 9;
            return o;
          });
        },
        { pts, v },
      );
    const x0 = Math.max(0, v.ox);
    const x1 = Math.min(v.w, v.ox + v.fw * v.scale);
    const yv0 = Math.max(18, v.oy);
    const yv1 = Math.min(v.h, v.oy + v.fh * v.scale);
    const at = (fx, fy) => [x0 + fx * (x1 - x0), yv0 + fy * (yv1 - yv0)];
    const left25 = [at(0.25, 0.3), at(0.25, 0.5), at(0.25, 0.7), at(0.2, 0.6), at(0.3, 0.4)];
    const maxDiff = (a, b) => Math.max(...a.map((p, i) => Math.max(Math.abs(p[0] - b[i][0]), Math.abs(p[1] - b[i][1]), Math.abs(p[2] - b[i][2]))));
    const meanDiff = (a, b) => a.reduce((s, p, i) => s + (Math.abs(p[0] - b[i][0]) + Math.abs(p[1] - b[i][1]) + Math.abs(p[2] - b[i][2])) / 3, 0) / a.length;
    let cv = await canvasRgb(page, left25);
    let ph = await photoAt(left25);
    const d25 = maxDiff(cv, ph);
    check('Vergleich bei 50 %: Canvas bei 25 % der Mosaikbreite = Foto (≤ 10 RGB-Stufen)', sliderVal === '50' && d25 <= 10, `Regler ${sliderVal} %, max. Abweichung ${fmt(d25)}`);
    // wörtlich: Pixel bei 25 % der Canvas-Breite (liegt er links der Trennlinie auf dem Mosaik?)
    const lit = [[v.w * 0.25, yv0 + 0.5 * (yv1 - yv0)]];
    const split = x0 + 0.5 * (x1 - x0);
    if (lit[0][0] > x0 + 2 && lit[0][0] < split - 2) {
      const dl = maxDiff(await canvasRgb(page, lit), await photoAt(lit));
      check('Vergleich bei 50 %: Canvas-Pixel bei 25 % der Canvas-Breite = Foto (≤ 10)', dl <= 10, `Abweichung ${fmt(dl)}`);
    } else check('Vergleich: 25 % der Canvas-Breite liegt außerhalb des Fotobereichs – Prüfung über die Mosaikbreite', true, `x=${fmt(lit[0][0])}, Mosaik ${fmt(x0)}…${fmt(x1)}`);
    const right = Array.from({ length: 24 }, (_, i) => at(0.6 + (i % 6) * 0.06, 0.2 + Math.floor(i / 6) * 0.18));
    const dRight = meanDiff(await canvasRgb(page, right), await photoAt(right));
    check('Vergleich bei 50 %: rechte Hälfte zeigt das Mosaik (nicht das Foto)', dRight > 6, `mittlere Abweichung zum Foto ${fmt(dRight)}`);
    await shot('04-compare-50');

    // Regler auf 0 % → links wieder Mosaik
    await page.$eval('[data-testid="compare-slider"]', (e) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(e, '0');
      e.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(300);
    const leftMany = Array.from({ length: 24 }, (_, i) => at(0.05 + (i % 6) * 0.06, 0.2 + Math.floor(i / 6) * 0.18));
    const d0 = meanDiff(await canvasRgb(page, leftMany), await photoAt(leftMany));
    check('Regler 0 %: links Mosaik statt Foto', d0 > 6, `mittlere Abweichung ${fmt(d0)}, Anzeige ${(await page.textContent('[data-testid="compare-value"]')).trim()}`);
    // Trennlinie ziehen (Griff in der Mitte): von 0 % auf etwa 30 %
    await page.$eval('[data-testid="compare-slider"]', (e) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(e, '50');
      e.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await wait(250);
    const sy = v.top + (yv0 + yv1) / 2;
    await page.mouse.move(v.left + split, sy);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(v.left + split + ((x0 + 0.3 * (x1 - x0) - split) * i) / 6, sy);
    await page.mouse.up();
    await wait(250);
    const dragged = parseInt(await page.$eval('[data-testid="compare-slider"]', (e) => e.value), 10);
    check('Trennlinie ziehen verschiebt den Vergleich (≈ 30 %)', Math.abs(dragged - 30) <= 2, `Regler ${dragged} %`);
    await shot('05-compare-dragged');

    // ---- „Foto zeigen“ gedrückt halten (Vergleich aus)
    await page.locator('label:has([data-testid="compare-toggle"])').click();
    await wait(300);
    const right75 = Array.from({ length: 12 }, (_, i) => at(0.7 + (i % 4) * 0.06, 0.25 + Math.floor(i / 4) * 0.2));
    const hb = await page.$('[data-testid="compare-hold"]');
    const hbb = await hb.boundingBox();
    await page.mouse.move(hbb.x + hbb.width / 2, hbb.y + hbb.height / 2);
    await page.mouse.down();
    await wait(350);
    const dHold = maxDiff(await canvasRgb(page, right75.slice(0, 4)), await photoAt(right75.slice(0, 4)));
    const pressed = await hb.getAttribute('aria-pressed');
    await shot('06-hold-photo');
    await page.mouse.up();
    await wait(350);
    const dRel = meanDiff(await canvasRgb(page, right75), await photoAt(right75));
    check('„Foto zeigen“ gedrückt: ganzes Foto, losgelassen: wieder Mosaik', pressed === 'true' && dHold <= 10 && dRel > 6, `gedrückt max. ${fmt(dHold)}, losgelassen Ø ${fmt(dRel)}`);

    // ---- Farbfokus: abgeblendete Steine neutral grau; helle Fokusfarbe → dunkler Schleier
    await page.locator('label:has-text("Realistische Darstellung")').click();
    await page.locator('label:has-text("Farbnummern anzeigen")').click();
    await page.click('[data-testid="viewer-fit"]');
    const cvb = await page.$('[data-testid="mosaic-canvas"]');
    const bb = await cvb.boundingBox();
    await page.mouse.move(bb.x + bb.width * 0.55, bb.y + bb.height * 0.5);
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -300);
      await wait(60);
    }
    await page.mouse.move(2, 2);
    await wait(400);
    const grid = Array.from({ length: 100 }, (_, i) => [bb.width * (0.25 + (i % 10) * 0.05), bb.height * (0.2 + Math.floor(i / 10) * 0.06)]);
    // Farbstich = weder neutral grau noch eine Kantenmischung aus Grau und Fuge (#BDB8AE: R ≥ G ≥ B, R − B ≤ 15).
    // Die Fuge wird – wie in der Übersicht – nicht abgeblendet.
    const explained = (p) => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]) <= 3 || (p[0] >= p[1] - 2 && p[1] >= p[2] - 2 && p[0] - p[2] <= 17);
    const stats = (all) => {
      const cast = all.filter((p) => !explained(p)).length / all.length;
      const lum = all.reduce((s, p) => s + 0.3 * p[0] + 0.59 * p[1] + 0.11 * p[2], 0) / all.length;
      return { cast, lum };
    };
    const s0 = stats(await canvasRgb(page, grid));
    const legend = page.locator('[data-testid="legend-item"]');
    const nLegend = await legend.count();
    await legend.nth(nLegend - 1).click();
    await wait(400);
    const sDark = stats(await canvasRgb(page, grid));
    await shot('07-focus-dark-colour');
    await legend.nth(nLegend - 1).click();
    await legend.nth(0).click();
    await wait(400);
    const sLight = stats(await canvasRgb(page, grid));
    await shot('08-focus-light-colour');
    await legend.nth(0).click();
    check(
      'Farbfokus: abgeblendete Steine neutral grau (grauer Schleier, kein Farbstich)',
      s0.cast > 0.5 && sDark.cast <= 0.03 && sLight.cast <= 0.03,
      `Pixel mit Farbstich: ohne Fokus ${fmt(s0.cast * 100)} %, dunkle Fokusfarbe ${fmt(sDark.cast * 100)} %, helle ${fmt(sLight.cast * 100)} %`,
    );
    check('Farbfokus: dunkle Fokusfarbe → heller Schleier, helle Fokusfarbe → dunkler Schleier', sDark.lum > s0.lum + 20 && sLight.lum < s0.lum - 20, `Helligkeit ${fmt(s0.lum)} → ${fmt(sDark.lum)} / ${fmt(sLight.lum)}`);
    await page.locator('label:has-text("Realistische Darstellung")').click();
    await page.locator('label:has-text("Farbnummern anzeigen")').click();

    // ---- Suche: Stein zentriert, hervorgehoben, kurz aufleuchten; ungültige ID → Meldung
    await page.fill('[data-testid="find-stone"]', 'C010');
    await page.press('[data-testid="find-stone"]', 'Enter');
    await page.waitForSelector('[data-testid="stone-id"]');
    const foundId = (await page.textContent('[data-testid="stone-id"]')).trim();
    const flashPx = await page.$eval('canvas.w3vf-overlay', (c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++;
      return n;
    });
    await page.keyboard.press('Escape');
    await wait(900);
    const flashAfter = await page.$eval('canvas.w3vf-overlay', (c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++;
      return n;
    });
    check('Suche „C010“: Steindetail öffnet, Stein leuchtet kurz auf (≈ 0,6 s)', foundId.startsWith('C010') && flashPx > 20 && flashAfter === 0, `${foundId.slice(0, 6)} · Overlay-Pixel ${flashPx} → ${flashAfter}`);
    await page.fill('[data-testid="find-stone"]', 'ZZ999');
    await page.press('[data-testid="find-stone"]', 'Enter');
    const nf = await page.waitForSelector('[data-testid="find-not-found"]', { timeout: 3000 }).then((e) => e.textContent()).catch(() => '');
    check('Suche mit ungültiger ID: Meldung mit gültigem Bereich', /„ZZ999“ nicht gefunden – gültig sind A001 bis [A-Z]+\d{3}/.test(nf), nf);
    await page.fill('[data-testid="find-stone"]', 'A001-3');
    await page.press('[data-testid="find-stone"]', 'Enter');
    await wait(200);
    // A001 (Hintergrund in der Ecke) ist im Porträt ein ganzer Stein → Teilstück 3 gibt es nicht
    const nf2 = (await page.$('[data-testid="find-not-found"]')) !== null;
    check('Suche „A001-3“ (Teilstück gibt es nicht): Meldung statt falschem Stein', nf2);

    // ---- Handy-Breite im selben Projekt: 62vh
    await page.setViewportSize({ width: 390, height: 844 });
    await wait(500);
    const ph62 = await page.$eval('.viewer', (e) => e.getBoundingClientRect().height);
    check('Handy (≤ 980 px): Viewer-Höhe bleibt 62vh', Math.abs(ph62 - 0.62 * 844) <= 1.5, `${fmt(ph62)} px`);
    await page.setViewportSize({ width: 1360, height: 900 });
    await wait(300);

    // ---- Neuladen: Referenzfoto (nur im Speicher) fehlt → ehrlicher Hinweis, Vergleich gesperrt
    await page.reload();
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 60000 });
    await wait(800);
    const miss = await page.$('[data-testid="reference-missing"]');
    const missText = miss ? (await miss.textContent()).trim() : '';
    const toggleDisabled = await page.$eval('[data-testid="compare-toggle"]', (e) => e.disabled);
    const holdDisabled = await page.$eval('[data-testid="compare-hold"]', (e) => e.disabled);
    const oldText = await page.$('text=Wird nach der Berechnung angezeigt.');
    check(
      'Nach Neuladen: „Referenzfoto … nicht verfügbar“ als unvollständig markiert, Vergleich gesperrt',
      /nicht verfügbar/.test(missText) && /unvollständig/.test(missText) && toggleDisabled && holdDisabled && !oldText,
      missText.slice(0, 90),
    );
    await page.$eval('[data-testid="compare-box"]', (e) => e.scrollIntoView({ block: 'center' }));
    await shot('09-after-reload');
    await ctx.close();
  }

  // =====================================================================  Teil A2: App am Handy (Touch)
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'de-DE' });
    const page = await ctx.newPage();
    watch(page);
    const wait = (ms) => page.waitForTimeout(ms);
    await page.goto(BASE);
    await page.tap('[data-testid="sample-landscape"]');
    await page.waitForSelector('[data-testid="compute-btn"]');
    await page.tap('[data-testid="compute-btn"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
    await wait(1500);
    const v = await viewOf(page);
    const statusShown = await page.$eval('[data-testid="viewer-status"]', (e) => getComputedStyle(e).display !== 'none');
    check('Handy: Lineal mit „A“/„1“, keine Maus-Statuszeile', v.cols[0] === '1' && v.rows[0] === 'A' && !statusShown, `Spalten ${v.cols.slice(0, 4).join(',')} · Zeilen ${v.rows.slice(0, 4).join(',')}`);
    // „Foto zeigen“ mit dem Finger gedrückt halten
    const hb = await page.$('[data-testid="compare-hold"]');
    await hb.scrollIntoViewIfNeeded();
    const b = await hb.boundingBox();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 3 }] });
    await wait(300);
    const pressed = await hb.getAttribute('aria-pressed');
    await page.screenshot({ path: path.join(OUT, '10-phone-hold.png') });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait(200);
    const released = await hb.getAttribute('aria-pressed');
    check('Handy: „Foto zeigen“ mit dem Finger gedrückt halten', pressed === 'true' && released === 'false', `${pressed} → ${released}`);
    await page.$eval('[data-testid="mosaic-canvas"]', (c) => c.scrollIntoView({ block: 'start' }));
    await wait(300);
    await page.screenshot({ path: path.join(OUT, '11-phone-preview.png') });
    await ctx.close();
  }

  // =====================================================================  Teil B: Prüfstand mit dem echten Viewer
  let harness = null;
  try {
    const esbuild = require('esbuild');
    const root = path.resolve(__dirname, '..');
    const extDir = path.join(root, 'src', 'i18n', 'ext');
    // import.meta.glob (Vite) für die Übersetzungs-Erweiterungen durch feste Importe ersetzen
    const globPlugin = {
      name: 'w3vf-import-meta-glob',
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
      entryPoints: [path.join(__dirname, 'w3-viewer-features.harness.tsx')],
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
    harness = {
      js: res.outputFiles.find((f) => f.path.endsWith('.js')).text,
      css: (res.outputFiles.find((f) => f.path.endsWith('.css')) || { text: '' }).text,
    };
  } catch (e) {
    check('Prüfstand mit esbuild gebündelt', false, String(e).slice(0, 200));
  }

  if (harness) {
    const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${harness.css}</style><style>body{margin:0;padding:20px;background:#f4f1ec}</style></head><body><div id="root"></div><script>${harness.js.replace(/<\/script/g, '<\\/script')}</script></body></html>`;
    // ---------------------------------------------------------------- Maus
    {
      const ctx = await browser.newContext({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 1, locale: 'de-DE' });
      const page = await ctx.newPage();
      watch(page);
      const wait = (ms) => page.waitForTimeout(ms);
      await page.setContent(html);
      await page.waitForSelector('[data-testid="mosaic-canvas"]');
      await wait(400);
      const L = await page.evaluate(() => window.__h.layout);
      const calls = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__h.calls)));
      const clearCalls = () => page.evaluate(() => window.__h.calls.splice(0));
      const setProps = (p) => page.evaluate((p) => window.__h.setProps(p), p);
      /** Seitenkoordinaten der Mitte einer Zelle */
      const cellPt = async (row, col, fx = 0.5, fy = 0.5) => {
        const v = await viewOf(page);
        return { x: v.left + v.ox + (L.colX[col] + L.colW[col] * fx) * v.scale, y: v.top + v.oy + (L.rowY[row] + L.rowH[row] * fy) * v.scale };
      };
      const drag = async (a, b, steps = 12, button = 'left') => {
        await page.mouse.move(a.x, a.y);
        await page.mouse.down({ button });
        for (let i = 1; i <= steps; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
        await page.mouse.up({ button });
        await wait(120);
      };
      const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });

      // Tippen wie bisher
      let p = await cellPt(1, 2);
      await page.mouse.click(p.x, p.y);
      await wait(100);
      let c = await calls();
      check('Prüfstand: Modus „Tippen“ wählt den Stein (onPick) wie bisher', c.length === 1 && c[0][0] === 'pick' && c[0][1] === 1 && c[0][2] === 2, JSON.stringify(c));
      await clearCalls();
      const v0 = await viewOf(page);
      await drag(await cellPt(2, 2), await cellPt(3, 4));
      const v1 = await viewOf(page);
      c = await calls();
      check('Prüfstand: Ziehen verschiebt im Modus „Tippen“ (kein Auswählen)', c.length === 0 && Math.abs(v1.ox - v0.ox) > 20, `Δox ${fmt(v1.ox - v0.ox)}`);
      await page.click('[data-testid="viewer-fit"]');
      await wait(200);
      check('Prüfstand: Lineal „1…“ und „A…“', (await viewOf(page)).cols[0] === '1' && (await viewOf(page)).rows[0] === 'A', (await viewOf(page)).cols.join(','));

      // Bereichsfokus (Abschnitt A1)
      const A1 = await page.evaluate(() => window.__h.sections.find((s) => s.id === 'A1'));
      await setProps({ focusRange: { r0: A1.r0, r1: A1.r1, c0: A1.c0, c1: A1.c1 } });
      await wait(200);
      await clearCalls();
      p = await cellPt(L.rows - 2, L.cols - 1);
      const dimmed = (await canvasRgb(page, [[p.x - (await viewOf(page)).left, p.y - (await viewOf(page)).top]]))[0];
      await page.mouse.click(p.x, p.y);
      await wait(100);
      c = await calls();
      check('Prüfstand: Tippen außerhalb des Fokusbereichs wählt nichts, meldet den Abschnitt', c.length === 1 && c[0][0] === 'outside' && c[0][1].sectionId === 'B2', JSON.stringify(c));
      await clearCalls();
      p = await cellPt(0, 0);
      await page.mouse.click(p.x, p.y);
      await wait(100);
      c = await calls();
      check('Prüfstand: Tippen innerhalb des Fokusbereichs wählt wie bisher', c.length === 1 && c[0][0] === 'pick', JSON.stringify(c));
      await setProps({ focusRange: null });
      await wait(200);
      const undimmed = (await canvasRgb(page, [[(await cellPt(L.rows - 2, L.cols - 1)).x - (await viewOf(page)).left, (await cellPt(L.rows - 2, L.cols - 1)).y - (await viewOf(page)).top]]))[0];
      check('Prüfstand: außerhalb abgedunkelt', 0.3 * dimmed[0] + 0.59 * dimmed[1] + 0.11 * dimmed[2] < 0.3 * undimmed[0] + 0.59 * undimmed[1] + 0.11 * undimmed[2] - 30, `${dimmed.map(Math.round)} vs ${undimmed.map(Math.round)}`);
      await setProps({ focusRange: { r0: A1.r0, r1: A1.r1, c0: A1.c0, c1: A1.c1 } });
      await wait(200);
      await shot('20-harness-focus-range');

      // Malen: erster Stein bestimmt den Zielzustand; Bereich begrenzt
      await setProps({ mode: 'paint' });
      await wait(150);
      const cursor = await page.$eval('[data-testid="mosaic-canvas"]', (e) => getComputedStyle(e).cursor);
      await clearCalls();
      await drag(await cellPt(1, 0), await cellPt(1, L.cols - 1), 20);
      c = await calls();
      const inA1 = A1.c1 - A1.c0;
      const okPaint = c.length === 1 && c[0][0] === 'paint' && c[0][2] === true && c[0][1].length === inA1 && c[0][1].every((q, i) => q.idx === L.cols + i && q.piece === 0);
      const prog = await page.evaluate(() => window.__h.progress());
      check('Prüfstand: Malen = ein onPaint mit allen berührten Steinen im Bereich, Ziel „verlegt“', okPaint && cursor === 'crosshair', `${JSON.stringify(c).slice(0, 140)} · Cursor ${cursor}`);
      check('Prüfstand: nur Steine im Fokusbereich gemalt', prog.slice(L.cols, 2 * L.cols).filter((x) => x).length === inA1, prog.slice(L.cols, 2 * L.cols).join(''));
      await shot('21-harness-painted');
      await clearCalls();
      await drag(await cellPt(1, 1), await cellPt(1, 0), 6);
      await drag(await cellPt(1, 0), await cellPt(1, 2), 6);
      c = await calls();
      check(
        'Prüfstand: Start auf verlegtem Stein → „nicht verlegt“; zweimal überfahren macht nichts rückgängig',
        c.length === 2 && c[0][2] === false && c[0][1].length === 2 && c[1][2] === true && c[1][1].length === 2,
        JSON.stringify(c).slice(0, 160),
      );
      await setProps({ focusRange: null });
      await wait(150);
      // Leertaste verschiebt im Malmodus
      await clearCalls();
      let a = await cellPt(3, 3);
      await page.mouse.move(a.x, a.y);
      await page.keyboard.down('Space');
      const vs0 = await viewOf(page);
      await drag(a, await cellPt(4, 5), 8);
      await page.keyboard.up('Space');
      const vs1 = await viewOf(page);
      c = await calls();
      check('Prüfstand: Malen + Leertaste verschiebt statt zu malen', c.length === 0 && Math.abs(vs1.ox - vs0.ox) > 20, `Δox ${fmt(vs1.ox - vs0.ox)}, Aufrufe ${c.length}`);
      // mittlere Maustaste verschiebt
      const vm0 = await viewOf(page);
      await drag(await cellPt(3, 3), await cellPt(2, 1), 8, 'middle');
      const vm1 = await viewOf(page);
      c = await calls();
      check('Prüfstand: Malen + mittlere Maustaste verschiebt', c.length === 0 && Math.abs(vm1.ox - vm0.ox) > 20, `Δox ${fmt(vm1.ox - vm0.ox)}`);
      await page.click('[data-testid="viewer-fit"]');
      await wait(150);

      // Rechteck
      await setProps({ mode: 'rect' });
      await wait(150);
      await clearCalls();
      a = await cellPt(0, 1, 0.3, 0.3);
      const bpt = await cellPt(2, 4, 0.8, 0.7);
      await page.mouse.move(a.x, a.y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(a.x + ((bpt.x - a.x) * i) / 10, a.y + ((bpt.y - a.y) * i) / 10);
      await wait(150);
      await shot('22-harness-rect-drag');
      await page.mouse.up();
      await wait(120);
      c = await calls();
      check('Prüfstand: Rechteck rastet auf Zellen ein → onRect {r0:0,r1:3,c0:1,c1:5}', c.length === 1 && c[0][0] === 'rect' && JSON.stringify(c[0][1]) === JSON.stringify({ r0: 0, r1: 3, c0: 1, c1: 5 }), JSON.stringify(c));
      await clearCalls();
      await setProps({ focusRange: { r0: A1.r0, r1: A1.r1, c0: A1.c0, c1: A1.c1 } });
      await drag(await cellPt(1, 2), await cellPt(L.rows - 1, L.cols - 1), 10);
      c = await calls();
      check('Prüfstand: Rechteck auf den Fokusbereich beschnitten', c.length === 1 && c[0][0] === 'rect' && c[0][1].r1 === A1.r1 && c[0][1].c1 === A1.c1 && c[0][1].r0 === 1 && c[0][1].c0 === 2, JSON.stringify(c));
      await setProps({ focusRange: null });
      await clearCalls();
      p = await cellPt(2, 2);
      await page.mouse.click(p.x, p.y);
      await wait(150);
      const rh = await page.$('[data-testid="viewer-hint"]');
      c = await calls();
      check('Prüfstand: Klick ohne Ziehen im Rechteckmodus: Hinweis, keine Auswahl', c.length === 0 && !!rh && /Rechteck/.test(await rh.textContent()), rh ? await rh.textContent() : '');

      // langes Drücken und Rechtsklick (Modus Tippen)
      await setProps({ mode: 'tap' });
      await wait(150);
      await clearCalls();
      p = await cellPt(2, 3);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await wait(650);
      await page.mouse.up();
      await wait(100);
      c = await calls();
      check('Prüfstand: langes Drücken (500 ms) → onLongPick, kein onPick', c.length === 1 && c[0][0] === 'long' && c[0][1] === 2 && c[0][2] === 3, JSON.stringify(c));
      await clearCalls();
      await page.mouse.click(p.x, p.y, { button: 'right' });
      await wait(100);
      c = await calls();
      check('Prüfstand: Rechtsklick → onLongPick', c.length === 1 && c[0][0] === 'long', JSON.stringify(c));

      // Hervorhebung (flash)
      await page.mouse.move(2, 2);
      await wait(100);
      const overlayCount = () =>
        page.$eval('canvas.w3vf-overlay', (c) => {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 30) n++;
          return n;
        });
      const before = await overlayCount();
      await setProps({ flash: { idx: 2 * L.cols + 3, piece: 0 } });
      await wait(80);
      const during = await overlayCount();
      await shot('23-harness-flash');
      await wait(800);
      const after = await overlayCount();
      check('Prüfstand: flash leuchtet kurz und verschwindet nach ≈ 0,6 s', before === 0 && during > 100 && after === 0, `${before} → ${during} → ${after}`);

      // Vergleich: Foto exakt auf der Mosaikfläche
      await page.evaluate(() => {
        const L = window.__h.layout;
        const img = document.createElement('canvas');
        img.width = 240;
        img.height = Math.round((240 * L.finishedH) / L.finishedW);
        const g = img.getContext('2d');
        g.fillStyle = '#20a0c0';
        g.fillRect(0, 0, img.width, img.height);
        g.fillStyle = '#e04020';
        g.fillRect(0, 0, img.width / 2, img.height / 2);
        window.__img = img;
        window.__h.setProps({ compareImage: img, compareSplit: 0.5, onCompareSplit: (s) => window.__h.calls.push(['split', s]) });
      });
      await wait(250);
      const vv = await viewOf(page);
      const mx = (f) => vv.ox + vv.fw * vv.scale * f;
      const my = (f) => vv.oy + vv.fh * vv.scale * f;
      const pc = await canvasRgb(page, [
        [mx(0.2), my(0.25)],
        [mx(0.4), my(0.75)],
        [mx(0.75), my(0.75)],
      ]);
      const near = (p, hex) => {
        const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        return p.slice(0, 3).every((v, k) => Math.abs(v - rgb[k]) <= 10);
      };
      check('Prüfstand: Vergleich – links das Bild deckungsgleich (Viertel oben links rot), rechts Mosaik', near(pc[0], '#e04020') && near(pc[1], '#20a0c0') && !near(pc[2], '#20a0c0'), pc.map((x) => x.slice(0, 3).map(Math.round).join('/')).join(' · '));
      // Registrierung: die waagrechte Bildkante (halbe Bildhöhe) liegt auf der halben Mosaikhöhe (± 1,5 px)
      const ys = Array.from({ length: 33 }, (_, i) => my(0.5) - 8 + i * 0.5);
      const col = await canvasRgb(
        page,
        ys.map((y) => [mx(0.25), y]),
      );
      let cross = null;
      for (let i = 1; i < col.length; i++) {
        const a0 = col[i - 1][0];
        const a1 = col[i][0];
        if (a0 >= 128 && a1 < 128) cross = ys[i - 1] + ((a0 - 128) / (a0 - a1)) * (ys[i] - ys[i - 1]);
      }
      check('Prüfstand: Vergleich – Bildkante liegt auf der Mosaikmitte (Registrierung ± 1,5 px)', cross !== null && Math.abs(cross - my(0.5)) <= 1.5, `Kante bei ${fmt(cross)} px, Mosaikmitte ${fmt(my(0.5))} px`);
      await shot('24-harness-compare');
      await clearCalls();
      await drag({ x: vv.left + mx(0.5), y: vv.top + my(0.5) }, { x: vv.left + mx(0.8), y: vv.top + my(0.5) }, 8);
      c = await calls();
      const last = c.filter((x) => x[0] === 'split').pop();
      check('Prüfstand: Trennlinie ziehen → onCompareSplit ≈ 0,8, kein Auswählen', !!last && Math.abs(last[1] - 0.8) < 0.03 && !c.some((x) => x[0] === 'pick'), JSON.stringify(last));
      await setProps({ compareImage: null });
      await ctx.close();
    }
    // ---------------------------------------------------------------- Touch
    {
      const ctx = await browser.newContext({ viewport: { width: 900, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, locale: 'de-DE' });
      const page = await ctx.newPage();
      watch(page);
      const wait = (ms) => page.waitForTimeout(ms);
      await page.setContent(html);
      await page.waitForSelector('[data-testid="mosaic-canvas"]');
      await wait(400);
      const cdp = await ctx.newCDPSession(page);
      const L = await page.evaluate(() => window.__h.layout);
      const calls = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__h.calls)));
      const clearCalls = () => page.evaluate(() => window.__h.calls.splice(0));
      const setProps = (p) => page.evaluate((p) => window.__h.setProps(p), p);
      const cellPt = async (row, col) => {
        const v = await viewOf(page);
        return { x: v.left + v.ox + (L.colX[col] + L.colW[col] / 2) * v.scale, y: v.top + v.oy + (L.rowY[row] + L.rowH[row] / 2) * v.scale };
      };
      const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
      await setProps({ mode: 'paint' });
      await wait(150);
      // ein Finger malt
      await clearCalls();
      const a = await cellPt(3, 0);
      const b = await cellPt(3, 4);
      await touch('touchStart', [a]);
      for (let i = 1; i <= 10; i++) await touch('touchMove', [{ x: a.x + ((b.x - a.x) * i) / 10, y: a.y }]);
      await touch('touchEnd', []);
      await wait(150);
      let c = await calls();
      check('Prüfstand Touch: ein Finger malt (5 Steine, Ziel „verlegt“)', c.length === 1 && c[0][0] === 'paint' && c[0][1].length === 5 && c[0][2] === true, JSON.stringify(c).slice(0, 120));
      // zwei Finger verschieben und zoomen, malen nichts
      await clearCalls();
      const v0 = await viewOf(page);
      const p1 = await cellPt(2, 2);
      const p2 = await cellPt(2, 5);
      await touch('touchStart', [p1]);
      await touch('touchStart', [p1, p2]);
      for (let i = 1; i <= 8; i++) await touch('touchMove', [{ x: p1.x + i * 6, y: p1.y + i * 4 }, { x: p2.x + i * 6, y: p2.y + i * 4 }]);
      await touch('touchEnd', []);
      await wait(150);
      const v1 = await viewOf(page);
      c = await calls();
      check('Prüfstand Touch: zwei Finger verschieben, malen nichts', c.length === 0 && Math.abs(v1.ox - v0.ox - 48) < 6 && Math.abs(v1.oy - v0.oy - 32) < 6, `Δ ${fmt(v1.ox - v0.ox)}/${fmt(v1.oy - v0.oy)}, Aufrufe ${c.length}`);
      // zu kleine Steine: Tippen zoomt hinein, malt nicht
      // weit herauszoomen (Raster < 12 px)
      await page.evaluate(() => window.__h.viewer().zoomTo({ x: -400, y: -400, w: 1000, h: 1000 }));
      await wait(200);
      const vs = await viewOf(page);
      await clearCalls();
      const t = await cellPt(1, 1);
      await touch('touchStart', [t]);
      await touch('touchEnd', []);
      await wait(400);
      const vz = await viewOf(page);
      c = await calls();
      const hint = await page.$('[data-testid="viewer-hint"]');
      check('Prüfstand Touch: Steine zu klein zum Malen → Tippen zoomt hinein, malt nicht', vs.scale * 12 < 12 && c.length === 0 && vz.scale > vs.scale * 2 && !!hint, `Raster ${fmt(vs.scale * 12)} px → ${fmt(vz.scale * 12)} px`);
      // langes Drücken mit dem Finger (Modus Tippen)
      await setProps({ mode: 'tap' });
      await page.evaluate(() => window.__h.viewer().fit());
      await wait(150);
      await clearCalls();
      const lp = await cellPt(2, 3);
      await touch('touchStart', [lp]);
      await wait(650);
      await touch('touchEnd', []);
      await wait(150);
      c = await calls();
      check('Prüfstand Touch: langes Drücken → onLongPick (kein Antippen)', c.length === 1 && c[0][0] === 'long', JSON.stringify(c));
      await clearCalls();
      await touch('touchStart', [lp]);
      await touch('touchEnd', []);
      await wait(150);
      c = await calls();
      check('Prüfstand Touch: kurzes Tippen wählt wie bisher', c.length === 1 && c[0][0] === 'pick', JSON.stringify(c));
      await ctx.close();
    }
  }

  check('keine Fehler in der Konsole', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
