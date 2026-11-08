/* Browser-Test w2-colour-honesty: verständliche Farbquellen, „Erweitert“-Bereich, eindeutige und korrekte
 * automatische Farbnamen (folgen der Sprache, HEX-Änderung benennt um, Benutzernamen bleiben), Abweichung je
 * Farbe vom Foto, „angefordert – verwendet (… zusammengelegt)“, fehlendes Material, Legende mit Material,
 * Handy-Layout der Farbtabelle.
 * Aufruf: node e2e/w2-colour-honesty.e2e.cjs <baseUrl> <outDir>   (vorher: npm run build && npx vite preview)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output', 'w2-colour-honesty');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}
const digits = (s) => parseInt(String(s).replace(/\D/g, ''), 10);

// Materialien für „Meine Steine – begrenzte Farbanzahl“ (wenige, damit Bildfarben zusammengelegt werden)
const MATERIALS = [
  ['W-01', '#F4F1EA'],
  ['SW-02', '#1E1A18'],
  ['HA-03', '#E8B494'],
  ['BR-04', '#4E2C1C'],
  ['BG-05', '#7FA0BA'],
  ['RT-06', '#A02432'],
];

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => d.accept());

  /** Zeilen der Farbtabelle */
  const rows = () =>
    page.$$eval('[data-testid="palette-table"] tbody tr', (trs) =>
      trs.map((tr) => {
        const q = (c) => tr.querySelector(`td[data-col="${c}"]`);
        const stonesTxt = q('stones') && q('stones').childNodes[0] ? q('stones').childNodes[0].textContent.trim() : '';
        const nameInput = tr.querySelector('[data-testid="palette-name"]');
        const match = tr.querySelector('[data-testid="palette-match"]');
        return {
          code: tr.getAttribute('data-code'),
          name: nameInput ? nameInput.value : '',
          auto: nameInput ? nameInput.getAttribute('data-auto') === 'true' : false,
          stones: /\d/.test(stonesTxt) ? parseInt(stonesTxt.replace(/\D/g, ''), 10) : null,
          match: match ? match.textContent.trim() : null,
          matchTitle: match ? match.getAttribute('title') : null,
          hexlab: q('hexlab') ? q('hexlab').textContent.trim() : '',
          merged: tr.querySelector('[data-testid="palette-merged"]') ? tr.querySelector('[data-testid="palette-merged"]').textContent.trim() : null,
          missing: !!tr.querySelector('[data-testid="palette-material-missing"]'),
        };
      }),
    );
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
    // Bearbeitete Palettenfarben gehen beim Neuberechnen verloren (Palette wird neu erstellt) → Rückfrage
    await page.waitForSelector('[data-testid="recompute-guard"], [data-testid="mosaic-canvas"]', { timeout: 120000 });
    if (await page.isVisible('[data-testid="recompute-guard"]')) await page.click('[data-testid="guard-nobackup"]');
    await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 120000 });
    await page.click('[data-testid="step-colors"]');
    await page.waitForSelector('[data-testid="palette-table"]');
  };
  const setLang = async (label) => {
    const back = page.url();
    await page.goto(BASE + '#/settings');
    await page.click(`[data-testid="lang-select"] >> text=${label}`);
    await page.waitForTimeout(300);
    await page.goto(back);
  };

  // ---------- Materialien anlegen (für Material-Verknüpfung und „begrenzte Farbanzahl“)
  await page.goto(BASE + '#/materials');
  for (const [no, hex] of MATERIALS) {
    await page.click('[data-testid="add-material"]');
    await page.fill('[data-testid="mat-manufacturer"]', 'E2E');
    await page.fill('[data-testid="mat-colornumber"]', no);
    await page.fill('[data-testid="mat-hex"]', hex);
    await page.click('[data-testid="save-material"]');
    await page.waitForTimeout(200);
  }
  const matText = await page.textContent('[data-testid="materials-table"]');
  check('6 Materialien angelegt', MATERIALS.every(([no]) => matText.includes(no)));

  // ---------- Porträt: Farbquellen in Alltagssprache, „Erweitert“ zu
  await page.goto(BASE);
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="step-colors"]');
  const modes = await page.$$eval('[data-testid="palette-mode"] button', (bs) => bs.map((b) => b.textContent.trim()));
  check(
    'Farbquellen ohne Fachjargon',
    modes.join('|') === 'Automatisch aus dem Foto|Meine Steine – begrenzte Farbanzahl|Meine Steine – alle Farben|Eigene Farbauswahl',
    modes.join(' | '),
  );
  const adv = await page.$eval('[data-testid="colors-advanced"]', (d) => ({ open: d.open, summary: d.querySelector('summary').textContent }));
  check('„Erweitert“ (Farbabstand, Farbübergänge) bei Standardwerten zu, Werte in der Zusammenfassung', !adv.open && /CIEDE2000/.test(adv.summary) && /0 %/.test(adv.summary), adv.summary.trim());
  await page.screenshot({ path: path.join(OUT, 'w2ch-01-colors-before.png'), fullPage: true });

  // ---------- Berechnen (automatisch, 32 Farben)
  await compute();
  let rs = await waitRows();
  await page.screenshot({ path: path.join(OUT, 'w2ch-02-colors-after.png'), fullPage: true });
  const heads = await page.$$eval('[data-testid="palette-table"] thead th', (ths) => ths.map((th) => th.textContent.trim()));
  check('Spaltenreihenfolge Nr. · Name · Steine · Bedarf · Material · HEX·L*a*b*', heads.slice(0, 6).join('|') === 'Nr.|Name|Steine|Bedarf|Material|HEX · L*a*b*', heads.join('|'));
  const names = rs.map((r) => r.name);
  check('Automatische Namen eindeutig (32 Farben)', rs.length === 32 && new Set(names).size === names.length && rs.every((r) => r.auto), `${new Set(names).size}/${names.length}: ${names.slice(0, 8).join(', ')} …`);
  const counts = (await page.textContent('[data-testid="palette-counts"]').catch(() => '')) || '';
  check('Hinweis „angefordert 32 – verwendet …“', /angefordert 32 – verwendet \d+/.test(counts), counts.trim());
  const withMatch = rs.filter((r) => r.stones > 0);
  check('Jede Farbe mit Steinen zeigt die Abweichung vom Foto (Ø/max ΔE)', withMatch.length > 0 && withMatch.every((r) => r.match && /Ø ΔE00 [\d,]+ · max \d+/.test(r.match)), withMatch.slice(0, 3).map((r) => `${r.code}: ${r.match}`).join(' | '));
  check('Tooltip nennt Steine über ΔE 5 und 10', /über ΔE 5/.test(withMatch[0]?.matchTitle || '') && /über ΔE 10/.test(withMatch[0]?.matchTitle || ''), withMatch[0]?.matchTitle);
  check('HEX und L*a*b* in einer Zelle', /^#[0-9A-F]{6} · L [\d,]+ a -?[\d,]+ b -?[\d,]+$/.test(rs[0].hexlab), rs[0].hexlab);
  const total = rs.reduce((s, r) => s + r.stones, 0);

  // Σ Steine in der Farbtabelle = Steine im Materialbedarf (Verlegeplan)
  await page.click('[data-testid="step-plan"]');
  await page.waitForSelector('[data-testid="progress-pct"]');
  await page.click('text=Material >> nth=-1');
  await page.waitForSelector('[data-testid="material-calc"]');
  const mcPieces = digits(await page.textContent('[data-testid="mc-pieces"]'));
  check('Summe der Steine je Farbe = Steine gesamt', total === mcPieces, `${total} = ${mcPieces}`);
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="palette-table"]');

  // ---------- HEX-Änderung benennt automatische Farbe um, Benutzername bleibt
  const firstColor = page.locator('[data-testid="palette-table"] tbody tr').nth(0).locator('input[type="color"]');
  await firstColor.fill('#ff0000');
  await page.waitForTimeout(400);
  rs = await rows();
  check('HEX → #FF0000 benennt die automatische Farbe 01 in „Rot“ um', /^Rot( \(.+\)| \d+)?$/.test(rs[0].name) && rs[0].auto, rs[0].name);
  check('nach HEX-Änderung keine veraltete Abweichung (ΔE –)', (await page.locator('[data-testid="palette-table"] tbody tr').nth(0).locator('[data-testid="palette-match-stale"]').count()) === 1);
  const secondName = page.locator('[data-testid="palette-table"] tbody tr').nth(1).locator('[data-testid="palette-name"]');
  await secondName.fill('Mein Hintergrund');
  await page.locator('[data-testid="palette-table"] tbody tr').nth(1).locator('input[type="color"]').fill('#00ff00');
  await page.waitForTimeout(400);
  rs = await rows();
  check('HEX-Änderung lässt einen eingegebenen Namen unverändert', rs[1].name === 'Mein Hintergrund' && !rs[1].auto, rs[1].name);
  // Name leeren → automatischer Name kommt zurück
  const thirdName = page.locator('[data-testid="palette-table"] tbody tr').nth(2).locator('[data-testid="palette-name"]');
  const thirdBefore = rs[2].name;
  await thirdName.fill('');
  await thirdName.blur();
  await page.waitForTimeout(300);
  rs = await rows();
  // derselbe Grundname; der Zusatz (Nummer/hell…dunkel) kann sich ändern, weil die Gruppe jetzt kleiner ist
  const base = (s) => s.replace(/ (\(.+\)|\d+)$/, '');
  check('Leeres Namensfeld → wieder automatischer Name', rs[2].auto && base(rs[2].name) === base(thirdBefore), `${thirdBefore} → ${rs[2].name}`);
  check('Namen nach den Änderungen weiter eindeutig', new Set(rs.map((r) => r.name)).size === rs.length);

  // ---------- Sprache: automatische Namen folgen, Benutzername bleibt
  await setLang('English');
  await page.waitForSelector('[data-testid="palette-table"]');
  await page.waitForTimeout(500);
  const rsEn = await rows();
  const modesEn = await page.$$eval('[data-testid="palette-mode"] button', (bs) => bs.map((b) => b.textContent.trim()));
  check('Englisch: automatische Namen übersetzt, Benutzername unverändert', /^Red( \(.+\)| \d+)?$/.test(rsEn[0].name) && rsEn[1].name === 'Mein Hintergrund' && new Set(rsEn.map((r) => r.name)).size === rsEn.length, `${rsEn[0].name} | ${rsEn[1].name} | ${rsEn[3].name}`);
  check('Englisch: Farbquellen übersetzt', modesEn[0] === 'Automatically from the photo', modesEn.join(' | '));
  await setLang('Türkçe');
  await page.waitForSelector('[data-testid="palette-table"]');
  await page.waitForTimeout(500);
  const rsTr = await rows();
  check('Türkisch: automatische Namen übersetzt', /^Kırmızı( \(.+\)| \d+)?$/.test(rsTr[0].name) && new Set(rsTr.map((r) => r.name)).size === rsTr.length, `${rsTr[0].name} | ${rsTr[3].name}`);
  await page.screenshot({ path: path.join(OUT, 'w2ch-03-colors-tr.png'), fullPage: false });
  await setLang('Deutsch');
  await page.waitForSelector('[data-testid="palette-table"]');
  await page.waitForTimeout(500);
  rs = await rows();
  check('Zurück auf Deutsch: wieder deutsche Namen', /^Rot/.test(rs[0].name) && rs[1].name === 'Mein Hintergrund', `${rs[0].name} | ${rs[3].name}`);

  // ---------- Material verknüpfen → Legende zeigt Hersteller und Farbnummer
  const sel = page.locator('[data-testid="palette-table"] tbody tr').nth(3).locator('td[data-col="material"] select');
  const optVal = await sel.locator('option', { hasText: 'BG-05' }).getAttribute('value');
  await sel.selectOption(optVal);
  await page.waitForTimeout(300);
  await page.click('[data-testid="step-preview"]');
  await page.waitForSelector('[data-testid="legend-item"]');
  const legend = await page.$$eval('[data-testid="legend-item"]', (items) =>
    items.map((it) => ({ name: it.querySelector('[data-testid="legend-name"]').textContent.trim(), mat: (it.querySelector('[data-testid="legend-material"]') || { textContent: '' }).textContent.trim() })),
  );
  check('Legende: gleiche Namen wie die Farbtabelle', legend.length === rs.length && legend.every((l, i) => l.name === rs[i].name), legend.slice(0, 4).map((l) => l.name).join(', '));
  check('Legende: verknüpftes Material als Zweitzeile (Hersteller + Farbnummer)', legend[3].mat === 'E2E BG-05', legend[3].mat);
  await page.locator('[data-testid="legend-item"]').nth(3).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'w2ch-04-preview-legend.png') });

  // ---------- Material löschen → „Material fehlt“ statt stillem „–“
  const url = page.url();
  await page.goto(BASE + '#/materials');
  await page.waitForSelector('[data-testid="materials-table"]');
  const rowBG = page.locator('[data-testid="materials-table"] tbody tr', { hasText: 'BG-05' });
  await rowBG.locator('[data-testid="delete-material"]').click();
  await page.waitForTimeout(600);
  await page.goto(url.replace(/\/preview$/, '/colors'));
  await page.waitForSelector('[data-testid="palette-table"]');
  await page.waitForTimeout(500);
  rs = await rows();
  const selTxt = await page.locator('[data-testid="palette-table"] tbody tr').nth(3).locator('td[data-col="material"] select').evaluate((s) => s.options[s.selectedIndex].textContent.trim());
  check('Gelöschtes Material: Hinweis „Material fehlt“ in der Farbtabelle', rs[3].missing && selTxt === 'Material fehlt', selTxt);
  await page.click('[data-testid="step-preview"]');
  await page.waitForSelector('[data-testid="legend-item"]');
  const missLegend = await page.locator('[data-testid="legend-item"]').nth(3).locator('[data-testid="legend-material-missing"]').count();
  check('Gelöschtes Material: Legende zeigt „Material fehlt“', missLegend === 1);
  await page.click('[data-testid="step-colors"]');
  await page.waitForSelector('[data-testid="palette-table"]');

  // ---------- „Erweitert“ öffnet sich bei abweichenden Werten
  await page.click('[data-testid="colors-advanced"] summary');
  await page.click('[data-testid="deltae-mode"] >> text=CIE76');
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForSelector('[data-testid="colors-advanced"]');
  const adv2 = await page.$eval('[data-testid="colors-advanced"]', (d) => ({ open: d.open, summary: d.querySelector('summary').textContent }));
  check('„Erweitert“ offen, wenn ein Wert vom Standard abweicht (Zusammenfassung + „geändert“)', adv2.open && /CIE76/.test(adv2.summary) && /geändert/.test(adv2.summary), adv2.summary.trim());
  await page.screenshot({ path: path.join(OUT, 'w2ch-05-advanced-open.png') });
  await page.click('[data-testid="deltae-mode"] >> text=CIEDE2000');
  await page.waitForTimeout(300);

  // ---------- Meine Steine – begrenzte Farbanzahl: zusammengelegte Bildfarben werden genannt
  await page.click('[data-testid="palette-mode"] >> text=Meine Steine – begrenzte Farbanzahl');
  await page.click('[data-testid="color-counts"] >> text=16');
  await compute();
  rs = await waitRows();
  const snapCounts = (await page.textContent('[data-testid="palette-counts"]').catch(() => '')) || '';
  const m = /angefordert (\d+) – verwendet (\d+) \((\d+) Bildfarben zusammengelegt/.exec(snapCounts);
  check('Begrenzte Farbanzahl: „angefordert 16 – verwendet M (K Bildfarben zusammengelegt)“', m && +m[1] === 16 && +m[2] === rs.length && +m[2] < 16 && +m[3] > 0, snapCounts.trim());
  check('Begrenzte Farbanzahl: zusammengelegte Materialfarben gekennzeichnet („aus n Bildfarben“)', rs.some((r) => r.merged && /aus \d+ Bildfarben/.test(r.merged)), rs.map((r) => r.merged).filter(Boolean).join(' | '));
  check('Begrenzte Farbanzahl: Abweichung vom Foto statt „ΔE 0 zum Material“', rs.filter((r) => r.stones > 0).every((r) => r.match && /Ø ΔE/.test(r.match)), rs.slice(0, 3).map((r) => r.match).join(' | '));
  check('Begrenzte Farbanzahl: Materialnamen unverändert', rs.every((r) => !r.auto), rs.map((r) => r.name).join(', '));
  await page.screenshot({ path: path.join(OUT, 'w2ch-06-snap.png'), fullPage: true });

  // ---------- Handy: Steine und Bedarf in der ersten Bildschirmbreite
  const projUrl = page.url();
  await page.click('[data-testid="palette-mode"] >> text=Automatisch aus dem Foto');
  await compute();
  await waitRows();
  await page.waitForTimeout(1500);
  // gleiches Projekt (gleicher Browser-Speicher), Fenster auf Handy-Breite
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(projUrl);
  await page.reload();
  await page.waitForSelector('[data-testid="palette-table"] tbody tr td[data-col="stones"]', { timeout: 60000 });
  await waitRows();
  const geo = await page.evaluate(() => {
    const tr = document.querySelector('[data-testid="palette-table"] tbody tr');
    const r = (c) => tr.querySelector(`td[data-col="${c}"]`).getBoundingClientRect();
    return { w: window.innerWidth, stones: Math.round(r('stones').right), need: Math.round(r('need').right), page: document.documentElement.scrollWidth };
  });
  check('Handy (390 px): Steine und Bedarf ohne seitliches Blättern sichtbar', geo.stones <= geo.w && geo.need <= geo.w + 1, JSON.stringify(geo));
  check('Handy: keine waagerechte Seiten-Scrollleiste', geo.page <= geo.w + 1, `${geo.page} px`);
  await page.locator('[data-testid="palette-table"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'w2ch-07-phone-table.png') });
  await page.locator('[data-testid="colors-advanced"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, 'w2ch-08-phone-top.png') });

  check('Keine JavaScript-Fehler', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
