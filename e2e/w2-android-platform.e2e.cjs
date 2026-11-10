/* Browser-Test „Android-Plattform“ (Paket w2-android-platform).
 * Voraussetzung: `npm run build` und `npx vite preview --port <port>` laufen.
 * Aufruf: node e2e/w2-android-platform.e2e.cjs <baseUrl> <ausgabeOrdner>
 *
 * Geprüft wird:
 *  - Zu alter Browser (structuredClone fehlt): Erklärung statt leerer Seite, App startet nicht (DE/EN/TR)
 *  - APK mit zu alter WebView: index.html leitet auf webview-update.html (Play-Store-Links);
 *    die Hinweisseite unterscheidet „WebView zu alt“ (Chrome/100) und „Ladefehler“ (Chrome/130)
 *  - Simuliertes APK (nachgebaute Capacitor-Brücke im Browser, ein echtes Gerät ersetzt das NICHT):
 *    Sicherung in Meine Projekte → „Gespeichert: Documents/MosaicPlan/…“ mit echter Datei im simulierten
 *    Dateisystem; abgelehnter Documents-Zugriff → Warnung + Teilen statt Pfad; Material-CSV und PDF
 *    melden den Speicherort app-weit; Zurück-Taste: Dialog → vorige Ansicht → minimieren; Systemleisten-
 *    Stile mit simulierten Safe-Area-Abständen; Hinweis nach Neustart der Anzeige
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output', 'w2-android-platform');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name) }).catch(() => {});
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

/** Nachgebaute Capacitor-Android-Brücke (läuft im Browser vor allen Skripten). */
function fakeAndroid() {
  const fake = (window.__fake = { calls: [], files: {}, dirs: {}, failDocs: false, share: 'cancel', listeners: {} });
  const b64 = (s) => {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  };
  const k = (d, p) => `${d}:${p}`;
  const err = (message, code) => Object.assign(new Error(message), { code });
  const parent = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const impl = {
    Filesystem: {
      writeFile(o) {
        fake.files[k(o.directory, o.path)] = b64(o.data);
        if (o.recursive) fake.dirs[k(o.directory, parent(o.path))] = true;
        return { uri: `file:///data/user/0/de.mosaicplan.app/cache/${o.path}` };
      },
      appendFile(o) {
        const a = fake.files[k(o.directory, o.path)] || new Uint8Array(0);
        const b = b64(o.data);
        const c = new Uint8Array(a.length + b.length);
        c.set(a);
        c.set(b, a.length);
        fake.files[k(o.directory, o.path)] = c;
      },
      stat(o) {
        const f = fake.files[k(o.directory, o.path)];
        if (!f) throw err('does not exist', 'OS-PLUG-FILE-0008');
        return { size: f.length, type: 'file', name: o.path, uri: `file:///x/${o.path}`, mtime: 0 };
      },
      mkdir(o) {
        if (fake.dirs[k(o.directory, o.path)]) throw err('Directory already exists', 'OS-PLUG-FILE-0010');
        fake.dirs[k(o.directory, o.path)] = true;
      },
      copy(o) {
        if (fake.failDocs && o.toDirectory === 'DOCUMENTS') throw err('Unable to do file operation, user denied permission request.', 'OS-PLUG-FILE-0007');
        const src = fake.files[k(o.directory, o.from)];
        if (!src) throw err('does not exist', 'OS-PLUG-FILE-0008');
        if (!fake.dirs[k(o.toDirectory, parent(o.to))]) throw err('Missing parent directory', 'OS-PLUG-FILE-0011');
        fake.files[k(o.toDirectory, o.to)] = src.slice();
        return { uri: `file:///storage/emulated/0/Documents/${o.to}` };
      },
    },
    Share: {
      share() {
        if (fake.share === 'cancel') throw new Error('Share canceled');
        return { activityType: 'com.google.android.apps.docs' };
      },
    },
    App: { minimizeApp() {}, removeListener() {}, removeAllListeners() {} },
    SystemBars: { setStyle() {}, show() {}, hide() {} },
  };
  const headers = Object.keys(impl).map((name) => ({
    name,
    methods: [...Object.keys(impl[name]).map((m) => ({ name: m, rtype: 'promise' })), { name: 'addListener', rtype: 'callback' }],
  }));
  window.androidBridge = { postMessage() {} };
  window.Capacitor = {
    PluginHeaders: headers,
    nativePromise(plugin, method, options) {
      fake.calls.push({ plugin, method, options: JSON.parse(JSON.stringify(options || {}, (key, v) => (key === 'data' ? `<${v.length}>` : v))) });
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          try {
            resolve(impl[plugin][method](options || {}));
          } catch (e) {
            reject(e);
          }
        }, 5),
      );
    },
    nativeCallback(plugin, method, options, cb) {
      fake.calls.push({ plugin, method, options });
      if (method === 'addListener') (fake.listeners[`${plugin}:${options.eventName}`] ||= []).push(cb);
      return `cb${fake.calls.length}`;
    },
  };
  fake.back = (canGoBack) => (fake.listeners['App:backButton'] || []).forEach((cb) => cb({ canGoBack }));
  fake.count = (plugin, method) => fake.calls.filter((c) => c.plugin === plugin && c.method === method).length;
  fake.docFile = (name) => {
    const f = fake.files[`DOCUMENTS:MosaicPlan/${name}`];
    return f ? { size: f.length, head: String.fromCharCode(...f.slice(0, 64)) } : null;
  };
}

function collectErrors(page, errors) {
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // ===================== 1) Zu alter Browser: structuredClone fehlt
  for (const [locale, title] of [
    ['de-DE', 'Dieser Browser ist zu alt für MosaicPlan'],
    ['en-US', 'This browser is too old for MosaicPlan'],
    ['tr-TR', 'Bu tarayıcı MosaicPlan için çok eski'],
  ]) {
    const ctx = await browser.newContext({ ...PHONE, locale });
    await ctx.addInitScript(() => {
      delete window.structuredClone;
    });
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.waitForSelector('[data-testid="unsupported-browser"]', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800); // App-Bundle hatte Zeit zu starten – darf die Meldung nicht ersetzen
    const st = await page.evaluate(() => ({
      msg: document.querySelector('[data-testid="unsupported-browser"]')?.textContent || '',
      rootText: (document.getElementById('root')?.innerText || '').trim().length,
      app: !!document.querySelector('.topbar'),
      flag: window.__mpUnsupported || '',
    }));
    check(`Alter Browser (${locale}): Erklärung statt leerer Seite, App startet nicht`, st.msg.includes(title) && st.rootText > 80 && !st.app && st.flag === 'structuredClone', `Text ${st.rootText} Zeichen, App=${st.app}, Grund=${st.flag}`);
    if (locale === 'de-DE') await shot(page, 'w2ap-01-unsupported-browser.png');
    await ctx.close();
  }

  // ===================== 2) APK mit zu alter WebView / Ladefehler
  {
    const ctx = await browser.newContext({ ...PHONE, locale: 'de-DE' });
    await ctx.addInitScript(fakeAndroid);
    await ctx.addInitScript(() => {
      delete window.structuredClone;
    });
    const page = await ctx.newPage();
    collectErrors(page, []);
    await page.goto(BASE);
    await page.waitForURL(/webview-update\.html\?reason=structuredClone/, { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('[data-testid="webview-update"][data-kind="update"]', { timeout: 10000 }).catch(() => {});
    const links = await page.$$eval('[data-testid^="market-"], [data-testid="play-web"]', (as) => as.map((a) => a.getAttribute('href')));
    check(
      'APK: Funktionstest scheitert → Hinweisseite mit Play-Store-Links',
      /webview-update\.html\?reason=structuredClone/.test(page.url()) && links.includes('market://details?id=com.google.android.webview') && links.includes('market://details?id=com.android.chrome') && links.some((l) => l.startsWith('https://play.google.com/')),
      `${page.url().replace(BASE, '')} · ${links.length} Links`,
    );
    await shot(page, 'w2ap-02-webview-features.png');
    await ctx.close();
  }
  for (const [ver, locale, kind, needle] of [
    [100, 'de-DE', 'update', 'Version 100'],
    [100, 'tr-TR', 'update', 'Android System WebView çok eski'],
    [130, 'de-DE', 'error', 'MosaicPlan konnte nicht geladen werden'],
    [130, 'en-US', 'error', 'MosaicPlan could not be loaded'],
  ]) {
    const ua = `Mozilla/5.0 (Linux; Android 9; Pixel 3 Build/PQ3A.190801.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${ver}.0.4896.127 Mobile Safari/537.36`;
    const ctx = await browser.newContext({ ...PHONE, locale, userAgent: ua });
    const page = await ctx.newPage();
    const errs = [];
    collectErrors(page, errs);
    await page.goto(`${BASE}webview-update.html`);
    await page.waitForSelector(`[data-testid="webview-update"][data-kind="${kind}"]`, { timeout: 10000 }).catch(() => {});
    const text = (await page.textContent('[data-testid="webview-update"]').catch(() => '')) || '';
    const retry = await page.isVisible('[data-testid="retry"]');
    check(`Hinweisseite Chrome/${ver} (${locale}): ${kind === 'update' ? 'Aktualisieren-Anleitung' : 'Ladefehler mit „Erneut versuchen“'}`, text.includes(needle) && (kind === 'error') === retry && errs.length === 0, needle);
    if (ver === 100 && locale === 'de-DE') await shot(page, 'w2ap-03-webview-old.png');
    if (ver === 130 && locale === 'de-DE') await shot(page, 'w2ap-04-load-error.png');
    await ctx.close();
  }

  // ===================== 3) Normaler Browser: kein Fehlalarm des Funktionstests
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errs = [];
    collectErrors(page, errs);
    await page.goto(BASE);
    await page.waitForSelector('[data-testid="new-project"]', { timeout: 15000 });
    const flag = await page.evaluate(() => window.__mpUnsupported || '');
    check('Aktueller Browser: App startet, kein Hinweis, keine Konsolenfehler', !flag && !(await page.isVisible('[data-testid="unsupported-browser"]')) && errs.length === 0, errs.slice(0, 2).join(' | '));
    // Sicherung im Browser: Download mit Datum im Namen, Rückmeldung ohne erfundenen Ordner
    await page.click('[data-testid="sample-city"]');
    await page.waitForSelector('[data-testid="compute-btn"]', { timeout: 30000 });
    await page.goto(`${BASE}#/projects`);
    await page.waitForSelector('[data-testid="project-export"]');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('[data-testid="project-export"] >> nth=0')]);
    await page.waitForSelector('[data-testid="project-save-note"]');
    const note = await page.evaluate(() => {
      const n = document.querySelector('[data-testid="project-save-note"]');
      return { state: n.getAttribute('data-state'), text: n.textContent };
    });
    const name = dl.suggestedFilename();
    check(
      'Browser: Sicherung als Download mit Datum im Namen, Rückmeldung nennt die Datei',
      /_\d{4}-\d{2}-\d{2}_\d{4}\.mosaicplan\.json$/.test(name) && note.state === 'download' && note.text.includes(name) && !note.text.includes('Documents') && !(await page.isVisible('[data-testid="save-toasts"]')),
      name,
    );
    await shot(page, 'w2ap-00-browser-export.png');
    await ctx.close();
  }

  // ===================== 4) Simuliertes APK
  const ctx = await browser.newContext({ ...PHONE, locale: 'de-DE' });
  await ctx.addInitScript(fakeAndroid);
  const page = await ctx.newPage();
  collectErrors(page, errors);
  page.on('dialog', (d) => d.accept());
  await page.goto(BASE);
  await page.waitForSelector('[data-testid="new-project"]', { timeout: 20000 });
  await page.waitForTimeout(400);
  const native = await page.evaluate(() => window.Capacitor.isNativePlatform());
  const bars0 = await page.evaluate(() => window.__fake.calls.filter((c) => c.plugin === 'SystemBars').map((c) => `${c.options.bar}=${c.options.style}`));
  check('APK-Simulation aktiv; ohne Safe-Area-Abstand bleiben die Systemleisten auf DEFAULT', native && bars0.includes('StatusBar=DEFAULT') && bars0.includes('NavigationBar=DEFAULT'), bars0.join(', '));
  const backListener = await page.evaluate(() => (window.__fake.listeners['App:backButton'] || []).length);
  check('Zurück-Taste-Listener registriert (einmal)', backListener === 1, `${backListener}`);

  // ---------- Systemleisten mit simulierter Edge-to-Edge-Anzeige (Statusleiste 40 px, Navigationsleiste 48 px)
  const cdp = await ctx.newCDPSession(page);
  let insets = true;
  try {
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 40, topMax: 40, bottom: 48, bottomMax: 48, left: 0, leftMax: 0, right: 0, rightMax: 0 } });
  } catch (e) {
    insets = false;
    console.log(`• übersprungen: Safe-Area-Simulation nicht verfügbar (${e.message})`);
  }
  if (insets) {
    await page.waitForTimeout(500);
    const bars1 = await page.evaluate(() => window.__fake.calls.filter((c) => c.plugin === 'SystemBars').map((c) => `${c.options.bar}=${c.options.style}`));
    check('Unter der Statusleiste: helle Statussymbole (DARK), dunkle Navigationssymbole (LIGHT)', bars1.slice(-2).sort().join(',') === 'NavigationBar=LIGHT,StatusBar=DARK', bars1.slice(-2).join(', '));
  }

  // ---------- Zurück-Taste
  await page.evaluate(() => (location.hash = '#/materials')); // wie ein Klick in der Navigation: neuer Verlaufseintrag
  await page.waitForSelector('[data-testid="add-material"]');
  await page.click('[data-testid="add-material"]');
  await page.waitForSelector('.modal');
  await page.evaluate(() => window.__fake.back(true));
  await page.waitForTimeout(400);
  const afterBack1 = { modal: await page.isVisible('.modal'), hash: await page.evaluate(() => location.hash) };
  check('Zurück schließt zuerst den Dialog (Ansicht bleibt)', !afterBack1.modal && afterBack1.hash === '#/materials', JSON.stringify(afterBack1));
  await page.evaluate(() => window.__fake.back(true));
  await page.waitForTimeout(400);
  const afterBack2 = await page.evaluate(() => location.hash);
  const home2 = await page.isVisible('[data-testid="new-project"]');
  check('Zurück führt dann zur vorigen Ansicht (Startseite)', home2 && (afterBack2 === '' || afterBack2 === '#/'), `Hash „${afterBack2}“`);
  const min0 = await page.evaluate(() => window.__fake.count('App', 'minimizeApp'));
  await page.evaluate(() => window.__fake.back(true));
  await page.waitForTimeout(300);
  const min1 = await page.evaluate(() => window.__fake.count('App', 'minimizeApp'));
  check('Zurück auf der Startseite minimiert die App (nicht beenden, kein Verlaufsschritt)', min1 === min0 + 1 && (await page.isVisible('[data-testid="new-project"]')), `minimizeApp ${min0} → ${min1}`);
  await page.evaluate(() => (location.hash = '#/settings'));
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__fake.back(false));
  await page.waitForTimeout(300);
  check('Ohne Verlauf führt Zurück aus einer Unterseite zur Startseite', (await page.evaluate(() => location.hash)) === '#/');

  // ---------- Projekt sichern: gespeichert
  await page.click('[data-testid="sample-animal"]');
  await page.waitForSelector('[data-testid="compute-btn"]', { timeout: 30000 });
  const projectUrl = page.url();
  // Integration mit w2-workspace-shell (Schritte im Verlauf): Zurück führt zum vorigen Schritt im Projekt
  await page.click('[data-testid="step-size"]');
  await page.waitForTimeout(250);
  await page.click('[data-testid="step-tiles"]');
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__fake.back(true));
  await page.waitForTimeout(400);
  const stepBack = await page.evaluate(() => ({ hash: location.hash, cur: document.querySelector('[data-testid="step-size"]')?.getAttribute('aria-current') || '' }));
  check('Zurück im Projekt führt zum vorigen Schritt (Steine → Bildgröße)', /\/size$/.test(stepBack.hash) && stepBack.cur === 'step', JSON.stringify(stepBack));
  await page.goto(`${BASE}#/projects`);
  await page.waitForSelector('[data-testid="project-export"]');
  await page.click('[data-testid="project-export"] >> nth=0');
  await page.waitForSelector('[data-testid="project-save-note"]', { timeout: 20000 });
  const note1 = await page.evaluate(() => {
    const n = document.querySelector('[data-testid="project-save-note"]');
    return { state: n.getAttribute('data-state'), path: n.querySelector('[data-testid="save-note-path"]')?.textContent || '', text: n.textContent };
  });
  const fname = note1.path.replace('Documents/MosaicPlan/', '');
  const file1 = await page.evaluate((n) => window.__fake.docFile(n), fname);
  const cacheWrites = await page.evaluate(() => window.__fake.calls.filter((c) => c.plugin === 'Filesystem' && (c.method === 'writeFile' || c.method === 'appendFile')).map((c) => c.options.directory));
  check(
    'Sicherung im APK: „Gespeichert: Documents/MosaicPlan/<Name mit Datum>“ und die Datei liegt dort wirklich',
    note1.state === 'saved' && /^Documents\/MosaicPlan\/.+_\d{4}-\d{2}-\d{2}_\d{4}\.mosaicplan\.json$/.test(note1.path) && file1 && file1.size > 1000 && file1.head.includes('mosaicplan-project') && cacheWrites.every((d) => d === 'CACHE'),
    `${note1.path} · ${file1 ? file1.size : 0} B`,
  );
  const shares0 = await page.evaluate(() => window.__fake.count('Share', 'share'));
  check('Nach erfolgreichem Speichern kein ungefragtes Teilen-Menü', shares0 === 0, `${shares0}`);
  await page.evaluate(() => (window.__fake.share = 'ok'));
  await page.click('[data-testid="project-save-note"] [data-testid="save-note-share"]');
  await page.waitForTimeout(300);
  const shareCall = await page.evaluate(() => window.__fake.calls.filter((c) => c.plugin === 'Share').pop());
  const sharedText = await page.textContent('[data-testid="project-save-note"]');
  check('„Teilen …“ teilt die Datei aus dem App-Cache erneut', shareCall && shareCall.options.files[0].startsWith('file:///data/user/0/de.mosaicplan.app/cache/MosaicPlan/') && sharedText.includes('Über „Teilen“ weitergegeben'), shareCall ? shareCall.options.files[0] : '');
  await shot(page, 'w2ap-05-project-saved.png');

  // ---------- Projekt sichern: Documents verweigert → Warnung + Teilen, kein Pfad
  await page.click('[data-testid="project-save-note"] [data-testid="save-note-dismiss"]');
  await page.evaluate(() => {
    window.__fake.failDocs = true;
    window.__fake.share = 'cancel';
  });
  const sharesBefore = await page.evaluate(() => window.__fake.count('Share', 'share'));
  await page.click('[data-testid="project-export"] >> nth=0');
  await page.waitForSelector('[data-testid="project-save-note"]', { timeout: 20000 });
  await page.waitForTimeout(200);
  const note2 = await page.evaluate(() => {
    const n = document.querySelector('[data-testid="project-save-note"]');
    return { state: n.getAttribute('data-state'), text: n.textContent, path: !!n.querySelector('[data-testid="save-note-path"]'), share: !!n.querySelector('[data-testid="save-note-share"]') };
  });
  const sharesAfter = await page.evaluate(() => window.__fake.count('Share', 'share'));
  check(
    'Documents verweigert: Warnung mit Grund und „Teilen …“, kein erfundener Pfad, Teilen-Menü automatisch angeboten',
    note2.state === 'not-saved' && !note2.path && note2.share && !note2.text.includes('Documents/MosaicPlan/') && note2.text.includes('Speicherzugriff wurde nicht erlaubt') && sharesAfter === sharesBefore + 1,
    note2.text.slice(0, 120),
  );
  const errLine = await page.isVisible('[data-testid="projects-error"]');
  check('Abgebrochenes Teilen ist kein Fehler', !errLine && !note2.text.includes('Teilen fehlgeschlagen'));
  await shot(page, 'w2ap-06-project-not-saved.png');
  await page.evaluate(() => (window.__fake.failDocs = false));

  // ---------- Material-CSV: app-weite Meldung (Materials.tsx zeigt selbst keinen Speicherort)
  await page.goto(`${BASE}#/materials`);
  await page.click('[data-testid="add-material"]');
  await page.fill('[data-testid="mat-colornumber"]', 'G-7');
  await page.fill('[data-testid="mat-hex"]', '#3A6EA5');
  await page.click('[data-testid="save-material"]');
  await page.waitForTimeout(400);
  await page.click('[data-testid="export-csv"]');
  await page.waitForSelector('[data-testid="save-toast"]', { timeout: 15000 });
  const toast = await page.evaluate(() => {
    const n = document.querySelector('[data-testid="save-toast"]');
    const r = n.getBoundingClientRect();
    return { state: n.getAttribute('data-state'), path: n.querySelector('[data-testid="save-note-path"]')?.textContent || '', bottom: r.bottom, top: r.top };
  });
  const csv = await page.evaluate((n) => window.__fake.docFile(n), toast.path.replace('Documents/MosaicPlan/', ''));
  check('Material-CSV im APK: Meldungsleiste nennt den echten Speicherort', toast.state === 'saved' && /\.csv$/.test(toast.path) && csv && csv.size > 10, `${toast.path} · ${csv ? csv.size : 0} B`);
  if (insets) check('Meldungsleiste liegt über der (simulierten) Navigationsleiste', toast.bottom <= 844 - 48 + 0.5, `unten ${Math.round(toast.bottom)} px, Navigationsleiste ab 796 px`);
  await shot(page, 'w2ap-07-toast-csv.png');
  await page.click('[data-testid="save-toast"] [data-testid="save-note-dismiss"]');
  await page.waitForTimeout(200);
  check('Meldung lässt sich schließen', !(await page.isVisible('[data-testid="save-toast"]')));

  // ---------- Hinweis nach Neustart der Anzeige (MainActivity sendet dieses Ereignis)
  await page.evaluate(() => window.dispatchEvent(new Event('mp-renderer-recovered')));
  await page.waitForTimeout(200);
  const recText = (await page.textContent('[data-testid="notice-toast"]').catch(() => '')) || '';
  check('Nach Neustart der Anzeige: ehrlicher Hinweis', recText.includes('neu gestartet') && recText.includes('Gespeicherte Projekte sind erhalten'));
  await page.click('[data-testid="notice-toast"] [data-testid="save-note-dismiss"]');

  // ---------- PDF im APK: Meldung nennt den Pfad, Datei ist ein PDF
  await page.goto(projectUrl);
  await page.waitForSelector('[data-testid="compute-btn"]', { timeout: 30000 });
  await page.click('[data-testid="step-compute"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="step-preview"].active', { timeout: 240000 });
  await page.click('[data-testid="step-pdf"]');
  await page.waitForSelector('[data-testid="pdf-btn"]');
  await page.click('[data-testid="pdf-btn"]');
  // Welle 5 (w5-pdf-export-ui): Schritt 10 zeigt das Speicherergebnis selbst (bleibt stehen, mit „Teilen …“) statt in der Meldungsleiste
  await page.waitForSelector('[data-testid="pdf-save-note"]', { timeout: 240000 });
  const pdfToast = await page.evaluate(() => document.querySelector('[data-testid="pdf-save-note"] [data-testid="save-note-path"]')?.textContent || '');
  const pdf = await page.evaluate((n) => window.__fake.docFile(n), pdfToast.replace('Documents/MosaicPlan/', ''));
  check('PDF im APK: „Gespeichert: Documents/MosaicPlan/…_verlegeplan.pdf“, Datei beginnt mit %PDF-', /_verlegeplan\.pdf$/.test(pdfToast) && pdf && pdf.head.startsWith('%PDF-'), `${pdfToast} · ${pdf ? Math.round(pdf.size / 1024) : 0} KB`);
  await shot(page, 'w2ap-08-toast-pdf.png');

  check('Keine JavaScript-Fehler (APK-Simulation)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
