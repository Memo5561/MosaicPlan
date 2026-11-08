/* Browser-Test w2-design-system (Playwright/Chromium).
 * Prüft: Kontrast der wirksamen Farben, Startseite mit einer Hauptaktion, nicht lesbares Foto → Meldung ohne
 * Projekt und ohne JavaScript-Fehler, Ziehen & Ablegen, Hauptnavigation passt auf 360/390 px (de/en/tr),
 * fingergroße Bedienelemente auf dem Handy (alle Schritte, Steindialog), Dialog in sicheren Bereichen.
 * Voraussetzung: `npm run build` und `npx vite preview --port 4304` laufen.
 * Aufruf: node e2e/w2-design-system.e2e.cjs [baseUrl] [screenshotDir]
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4304/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w2-design-system');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

// 29 Bytes, die wie ein JPEG beginnen, aber kein Bild sind
const BAD_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33, 0x44]);

/** Anzahl gespeicherter Projekte direkt aus IndexedDB */
const projectCount = (page) =>
  page.evaluate(
    () =>
      new Promise((res, rej) => {
        const r = indexedDB.open('mosaicplan');
        r.onerror = () => rej(r.error);
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('projects')) return res(0);
          const c = db.transaction('projects').objectStore('projects').count();
          c.onsuccess = () => {
            res(c.result);
            db.close();
          };
          c.onerror = () => rej(c.error);
        };
      }),
  );

/** Bedienelemente, die auf Touch-Geräten zu klein sind (sichtbar, mit Größe) */
const tooSmall = (page) =>
  page.evaluate(() => {
    const rules = [
      ['.btn', 44, 0],
      ['.segmented button', 44, 0],
      ['.icon-btn', 44, 44],
      ['.viewer-tools button', 44, 44],
      ['.mainnav button', 44, 0],
      ['.step', 44, 0],
      ['.neighbor', 44, 0],
      ['.legend-item', 40, 0],
      ['.section-cell', 40, 0],
      ['.cp', 48, 44],
      ['input.text', 44, 0],
      ['select', 44, 0],
      ['.numin input', 44, 0],
    ];
    const bad = [];
    let n = 0;
    for (const [sel, minH, minW] of rules)
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
        n++;
        if (r.height < minH - 0.5 || r.width < minW - 0.5) bad.push(`${sel} "${(el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 18)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
    return { n, bad };
  });

const hOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  };

  // =============================================================== 1. Desktop: Kontrast, Startseite, Foto-Fehler
  const desk = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const page = await desk.newPage();
  watch(page);
  await page.goto(BASE);
  await page.waitForSelector('[data-testid="home-cta"]');

  // Kontrast der tatsächlich berechneten Farben (Testelemente auf der Seite)
  const contrast = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = `
      <p class="muted" id="c-muted">x</p>
      <div style="background:#fff"><p class="muted" id="c-muted-w">x</p></div>
      <button class="btn primary" id="c-primary">x</button>
      <span class="badge badge-ok" id="c-ok">x</span>
      <span class="badge badge-warn" id="c-warn">x</span>
      <span class="badge badge-error" id="c-err">x</span>
      <p class="warn" id="c-warntext">x</p>`;
    document.querySelector('.page').appendChild(host);
    const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => {
      const f = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el) => {
      for (let e = el; e; e = e.parentElement) {
        const c = getComputedStyle(e).backgroundColor;
        if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return rgb(c);
      }
      return rgb(getComputedStyle(document.body).backgroundColor);
    };
    const cr = (id) => {
      const el = document.getElementById(id);
      const a = lum(rgb(getComputedStyle(el).color));
      const b = lum(bgOf(el));
      return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
    };
    const out = Object.fromEntries(['c-muted', 'c-muted-w', 'c-primary', 'c-ok', 'c-warn', 'c-err', 'c-warntext'].map((id) => [id, cr(id)]));
    host.remove();
    return out;
  });
  check('Kontrast ≥ 4,5 : 1 (grau, Hauptknopf, Badges, Warnung)', Object.values(contrast).every((v) => v >= 4.5), JSON.stringify(contrast));

  const primaries = await page.$$eval('.page .btn.primary', (b) => b.filter((x) => x.getBoundingClientRect().width > 0).map((x) => x.textContent.trim()));
  check('Startseite: genau eine Hauptaktion „Foto auswählen und loslegen“', primaries.length === 1 && primaries[0] === 'Foto auswählen und loslegen', primaries.join(' | '));
  const privacy = await page.textContent('.hero-privacy');
  check('Datenschutzhinweis ohne „IndexedDB“', !/IndexedDB/.test(privacy), privacy.slice(0, 60));
  const samplesH = await page.textContent('#home-samples-title');
  const samplesHint = await page.textContent('.home-samples .muted.small');
  check('„Beispielprojekte“ mit Hinweis auf synthetische Testbilder', samplesH.trim() === 'Beispielprojekte' && /Synthetische Testbilder/.test(samplesHint), samplesH);
  const ids = ['new-project', 'home-photo', 'sample-portrait', 'sample-landscape', 'sample-animal', 'sample-city'];
  const present = await Promise.all(ids.map((id) => page.$(`[data-testid="${id}"]`).then(Boolean)));
  check('Alle bisherigen Test-IDs vorhanden; „Leeres Projekt“ sichtbar', present.every(Boolean) && (await page.isVisible('[data-testid="new-project"]')));
  check('Sprachwahl in der Kopfzeile auf dem Desktop sichtbar', await page.isVisible('select.lang'));
  await page.screenshot({ path: path.join(OUT, 'ds-01-home-desktop.png') });

  // Kaputtes JPEG
  const before = await projectCount(page);
  const errBefore = errors.length;
  await page.setInputFiles('[data-testid="home-photo"]', { name: 'kaputt.jpg', mimeType: 'image/jpeg', buffer: BAD_JPEG });
  await page.waitForSelector('[role="alert"][data-testid="photo-error"]', { timeout: 15000 }).catch(() => {});
  const alertTxt = ((await page.textContent('[data-testid="photo-error"]').catch(() => '')) || '').trim();
  await page.waitForTimeout(400);
  const after = await projectCount(page);
  const pageErrs = errors.slice(errBefore);
  await page.screenshot({ path: path.join(OUT, 'ds-02-home-bad-photo.png') });
  check(
    'Kaputtes JPEG: Meldung (role=alert) mit JPG/HEIC-Hinweis, kein Projekt, kein JavaScript-Fehler, bleibt auf Start',
    /kaputt\.jpg/.test(alertTxt) && /JPG/.test(alertTxt) && /HEIC/.test(alertTxt) && after === before && pageErrs.length === 0 && /#\/?$|\/$/.test(page.url()),
    `${alertTxt.slice(0, 70)}… | Projekte ${before}→${after} | Fehler ${pageErrs.length}`,
  );
  check('Hauptknopf nach dem Fehler wieder bedienbar', await page.isEnabled('[data-testid="home-cta"]'));

  // HEIC, das Chromium nicht dekodieren kann
  await page.setInputFiles('[data-testid="home-photo"]', { name: 'IMG_0815.HEIC', mimeType: 'image/heic', buffer: Buffer.from('....ftypheic........') });
  await page.waitForFunction(() => /IMG_0815/.test(document.querySelector('[data-testid="photo-error"]')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  const heicTxt = ((await page.textContent('[data-testid="photo-error"]').catch(() => '')) || '').trim();
  check('HEIC: eigene Meldung mit Ausweg (als JPG exportieren)', /HEIC\/HEIF/.test(heicTxt) && /JPG/.test(heicTxt) && (await projectCount(page)) === before, heicTxt.slice(0, 80));

  // Ziehen & Ablegen einer nicht lesbaren Datei auf die Startseite
  const dragState = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0xff, 0xd8, 0xff, 0, 1, 2, 3])], 'gezogen.jpg', { type: 'image/jpeg' }));
    const hero = document.querySelector('[data-testid="home-hero"]');
    hero.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true });
    hero.dispatchEvent(over);
    return { prevented: over.defaultPrevented, dt };
  });
  await page.waitForTimeout(100);
  const highlighted = await page.$eval('[data-testid="home-hero"]', (h) => h.classList.contains('drag'));
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0xff, 0xd8, 0xff, 0, 1, 2, 3])], 'gezogen.jpg', { type: 'image/jpeg' }));
    document.querySelector('[data-testid="home-hero"]').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => /gezogen\.jpg/.test(document.querySelector('[data-testid="photo-error"]')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  const dropTxt = ((await page.textContent('[data-testid="photo-error"]').catch(() => '')) || '').trim();
  const unhighlighted = await page.$eval('[data-testid="home-hero"]', (h) => !h.classList.contains('drag'));
  check('Ziehen & Ablegen: Ziel hervorgehoben, Ablegen liest die Datei (hier: Meldung)', dragState.prevented && highlighted && unhighlighted && /gezogen\.jpg/.test(dropTxt), dropTxt.slice(0, 50));

  // „Beispielprojekt ansehen“ scrollt zu den Beispielen
  await page.setViewportSize({ width: 1360, height: 560 });
  await page.click('[data-testid="home-see-samples"]');
  await page.waitForTimeout(900);
  const sampleTop = await page.$eval('[data-testid="sample-portrait"]', (e) => e.getBoundingClientRect().top);
  check('„Beispielprojekt ansehen“ führt zu den Beispielprojekten', sampleTop >= 0 && sampleTop < 560, `oben bei ${Math.round(sampleTop)} px`);
  await page.setViewportSize({ width: 1360, height: 900 });

  // Gültiges Foto: Projekt wird angelegt und geöffnet
  const png = await (await fetch(BASE + 'samples/animal.png')).arrayBuffer();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setInputFiles('[data-testid="home-photo"]', { name: 'Katze.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await page.waitForURL(/#\/project\/[^/]+\/photo/, { timeout: 20000 }).catch(() => {});
  const name = await page.inputValue('[data-testid="project-name"]').catch(() => '');
  check('Gültiges Foto: Projekt angelegt und Schritt Foto geöffnet', /#\/project\/[^/]+\/photo/.test(page.url()) && name === 'Katze' && (await projectCount(page)) === before + 1, `${page.url().split('#')[1]} | ${name}`);

  // Sicherer Bereich (Android randlos): Dialog bleibt zwischen Status- und Navigationsleiste
  const cdp = await desk.newCDPSession(page);
  let insetOk = true;
  try {
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 40, bottom: 48, left: 0, right: 0 } });
  } catch (e) {
    insetOk = false;
  }
  if (insetOk) {
    await page.setViewportSize({ width: 390, height: 640 });
    await page.goto(BASE + '#/materials');
    await page.waitForSelector('[data-testid="add-material"]');
    await page.click('[data-testid="add-material"]');
    await page.waitForSelector('.modal');
    const mb = await page.$eval('.modal', (m) => {
      const r = m.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight, pad: getComputedStyle(document.querySelector('main')).paddingBottom };
    });
    await page.screenshot({ path: path.join(OUT, 'ds-03-modal-safe-area.png') });
    check('Dialog innerhalb der sicheren Bereiche (oben 40, unten 48 px)', mb.top >= 40 && mb.bottom <= mb.h - 48, `${mb.top}–${mb.bottom} von ${mb.h}, main unten ${mb.pad}`);
    await page.keyboard.press('Escape');
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } }).catch(() => {});
  } else {
    check('Dialog innerhalb der sicheren Bereiche (CDP-Simulation nicht verfügbar – übersprungen)', true, 'übersprungen');
  }
  await desk.close();

  // =============================================================== 2. Hauptnavigation auf schmalen Bildschirmen
  for (const lang of ['de', 'en', 'tr']) {
    for (const w of [360, 390]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 760 }, isMobile: true, hasTouch: true });
      const p = await ctx.newPage();
      watch(p);
      await p.goto(BASE + '#/settings');
      await p.waitForSelector('[data-testid="lang-select"]');
      await p.tap(`[data-testid="lang-select"] >> text=${{ de: 'Deutsch', en: 'English', tr: 'Türkçe' }[lang]}`);
      await p.waitForTimeout(250);
      const m = await p.evaluate(() => {
        const nav = document.querySelector('.mainnav');
        const nr = nav.getBoundingClientRect();
        const items = [...nav.querySelectorAll('button')].map((b) => {
          const r = b.getBoundingClientRect();
          return { t: b.innerText.trim(), l: r.left, r: r.right, h: r.height, label: b.getAttribute('aria-label') || b.innerText.trim() };
        });
        return { cw: nav.clientWidth, sw: nav.scrollWidth, l: nr.left, r: nr.right, items, lang: getComputedStyle(document.querySelector('select.lang')).display, page: document.documentElement.scrollWidth - innerWidth };
      });
      const fits = m.items.length === 4 && m.sw <= m.cw && m.items.every((i) => i.l >= m.l - 0.5 && i.r <= m.r + 0.5 && i.h >= 44 - 0.5);
      check(`Navigation ${lang} ${w} px: alle vier Bereiche sichtbar, ohne Scrollen, ≥ 44 px hoch`, fits && m.lang === 'none' && m.page <= 1, `${m.items.map((i) => i.t).join(' · ')} (${m.cw}/${m.sw})`);
      if (w === 360) await p.screenshot({ path: path.join(OUT, `ds-04-nav-${lang}-360.png`), clip: { x: 0, y: 0, width: 360, height: 120 } });
      if (lang !== 'de') {
        // Langbezeichnung bleibt als zugänglicher Name erhalten
        const labels = m.items.map((i) => i.label).join(' | ');
        check(`Navigation ${lang} ${w} px: zugängliche Namen`, m.items.every((i) => i.label.length > 0), labels);
      }
      await ctx.close();
    }
  }

  // =============================================================== 3. Handy mit Finger: Größe der Bedienelemente in allen Schritten
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const pp = await phone.newPage();
  watch(pp);
  const shot = (n) => pp.screenshot({ path: path.join(OUT, `${n}.png`) });
  await pp.goto(BASE);
  await pp.waitForSelector('[data-testid="home-cta"]');
  let ts = await tooSmall(pp);
  await shot('ds-05-phone-home');
  check('Handy Start: alle Bedienelemente fingergroß', ts.bad.length === 0, `${ts.n} geprüft ${ts.bad.slice(0, 4).join('; ')}`);
  const ctaTop = await pp.$eval('[data-testid="home-cta"]', (e) => e.getBoundingClientRect().bottom);
  check('Handy Start: Hauptaktion ohne Scrollen sichtbar', ctaTop <= 844, `Unterkante ${Math.round(ctaTop)} px`);

  for (const route of ['settings', 'materials', 'projects']) {
    await pp.goto(BASE + '#/' + route);
    await pp.waitForTimeout(500);
    ts = await tooSmall(pp);
    const ov = await hOverflow(pp);
    check(`Handy ${route}: fingergroß, kein waagerechtes Scrollen`, ts.bad.length === 0 && ov <= 1, `${ts.n} geprüft, Überlauf ${ov} ${ts.bad.slice(0, 4).join('; ')}`);
    await shot(`ds-06-phone-${route}`);
  }

  await pp.goto(BASE);
  await pp.tap('[data-testid="sample-portrait"]');
  await pp.waitForSelector('[data-testid="compute-btn"]');
  // Nach dem Zusammenführen mit w2-workspace-shell: kompakter Kopf – „←“ (nur Symbol, aria-label) links,
  // Projektname daneben über fast die ganze Breite (statt eigener Zeile; spart Höhe über der Vorschau).
  const head = await pp.evaluate(() => {
    const ti = document.querySelector('.title-input').getBoundingClientRect();
    const wh = document.querySelector('.ws-head').getBoundingClientRect();
    const backEl = document.querySelector('.ws-head .btn');
    const back = backEl.getBoundingClientRect();
    return {
      tw: ti.width,
      hw: wh.width,
      backLeft: back.right <= ti.left + 1 && back.bottom > ti.top && back.top < ti.bottom,
      backLabel: !!backEl.getAttribute('aria-label'),
      backH: back.height,
    };
  });
  check(
    'Handy: Projektname breit neben „←“ (Zurück links, fingergroß, mit Beschriftung für Screenreader)',
    head.tw >= head.hw * 0.8 && head.backLeft && head.backLabel && head.backH >= 44,
    `${Math.round(head.tw)}/${Math.round(head.hw)} px, Zurück ${Math.round(head.backH)} px hoch`,
  );
  await pp.tap('[data-testid="compute-btn"]');
  await pp.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
  await pp.waitForTimeout(1200);

  const steps = ['photo', 'size', 'tiles', 'joint', 'colors', 'shapes', 'compute', 'preview', 'plan', 'pdf'];
  const stepBad = [];
  const stepOverflow = [];
  let checked = 0;
  for (const s of steps) {
    await pp.tap(`[data-testid="step-${s}"]`);
    await pp.waitForTimeout(s === 'preview' || s === 'plan' ? 900 : 400);
    const r = await tooSmall(pp);
    checked += r.n;
    stepBad.push(...r.bad.map((b) => `${s}: ${b}`));
    const ov = await hOverflow(pp);
    if (ov > 1) stepOverflow.push(`${s} ${ov}px`);
    await pp.evaluate(() => window.scrollTo(0, 0));
    await shot(`ds-07-phone-step-${s}`);
  }
  check('Handy: alle 10 Schritte – Knöpfe, Segmente, Felder, Legende, Abschnitte fingergroß', stepBad.length === 0, `${checked} Elemente geprüft ${stepBad.slice(0, 5).join('; ')}`);
  check('Handy: kein waagerechtes Scrollen in den Schritten', stepOverflow.length === 0, stepOverflow.join(', '));

  // Steindialog (Vorschau): Tippen zoomt hinein, zweites Tippen öffnet den Stein
  await pp.tap('[data-testid="step-preview"]');
  await pp.waitForTimeout(800);
  const cv = await pp.$('[data-testid="mosaic-canvas"]');
  await cv.scrollIntoViewIfNeeded();
  const cb = await cv.boundingBox();
  const tx = cb.x + cb.width * 0.5;
  const ty = cb.y + cb.height * 0.45;
  await pp.touchscreen.tap(tx, ty);
  await pp.waitForTimeout(500);
  if (!(await pp.$('[data-testid="stone-id"]'))) {
    await pp.touchscreen.tap(tx, ty);
    await pp.waitForTimeout(600);
  }
  const opened = !!(await pp.$('[data-testid="stone-id"]'));
  if (opened) {
    const r = await tooSmall(pp);
    const extra = await pp.evaluate(() => {
      const cbx = document.querySelector('[data-testid="stone-placed"]').getBoundingClientRect();
      const m = document.querySelector('.modal').getBoundingClientRect();
      return { cb: Math.round(cbx.width), modalFits: m.right <= innerWidth + 0.5 && m.left >= -0.5, ov: document.documentElement.scrollWidth - innerWidth };
    });
    await shot('ds-08-phone-stone-dialog');
    check('Steindialog: Farbwahl 44×48, Nachbarn/Knöpfe/Schließen ≥ 44 px, Häkchen 22 px', r.bad.length === 0 && extra.cb >= 22, `${r.n} geprüft, Häkchen ${extra.cb} px ${r.bad.slice(0, 4).join('; ')}`);
    check('Steindialog passt in die Handybreite', extra.modalFits && extra.ov <= 1);
    await pp.tap('[data-testid="modal-close"]');
  } else {
    check('Steindialog öffnet auf dem Handy', false, 'kein Dialog nach zwei Tipps');
  }

  // Tablet mit Finger: Navigation mit Kurzbezeichnungen passt ebenfalls
  const tab = await browser.newContext({ viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true });
  const tp = await tab.newPage();
  watch(tp);
  await tp.goto(BASE);
  await tp.waitForSelector('[data-testid="home-cta"]');
  const tnav = await tp.evaluate(() => {
    const nav = document.querySelector('.mainnav');
    return { fits: nav.scrollWidth <= nav.clientWidth, lang: getComputedStyle(document.querySelector('select.lang')).display !== 'none' };
  });
  ts = await tooSmall(tp);
  check('Tablet 768 px: Navigation passt, Sprachwahl sichtbar, Bedienelemente fingergroß', tnav.fits && tnav.lang && ts.bad.length === 0, ts.bad.slice(0, 3).join('; '));
  await tp.screenshot({ path: path.join(OUT, 'ds-09-tablet-home.png') });
  await tab.close();

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
