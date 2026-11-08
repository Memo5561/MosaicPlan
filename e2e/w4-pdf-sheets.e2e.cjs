/* E2E – Welle 4 „PDF-Blattstruktur“ im echten Browser (Chromium/Playwright), am PDF, das die App erzeugt
 * (Worker, eingebettete DejaVu-Schrift). Voraussetzung: `npm run build` und `npx vite preview` laufen;
 * pdftotext/pdftoppm (poppler) installiert.
 * Aufruf: node e2e/w4-pdf-sheets.e2e.cjs <baseUrl> <outDir>
 *
 * Geprüft:
 *  - A4 1:1 (Porträt): Blätter gleichmäßig verteilt (kein Blatt schmaler als 40 % der bedruckbaren Fläche, außer der
 *    Abschnitt selbst), Zuschnittliste nach den Blättern jedes Abschnitts, jeder Verweis „Zuschnittliste … S. n“ auf
 *    dem Blatt zeigt auf die Liste mit dem Block dieses Blatts, Einträge = Summe der Blockköpfe, keine Überlappungen
 *  - „An Seite anpassen“: Abschnittsübersicht statt Deckblättern, alle Abschnitte auf den Übersichtsseiten
 *  - 2:1: Vorlagennummern „T#“ in den Steinen, nur gedruckte Vorlagen
 *  - 2-mm-Steine bei 1:1: Hinweis in der Oberfläche nennt den Codeplan; Codeplan-Seiten (2:1, NICHT maßstäblich,
 *    ohne Kontrollstrecke), Anzahl der Farbnummern auf den Codeplan-Seiten = Steine gesamt
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://localhost:4173/';
const OUT = process.argv[3] || path.join(__dirname, 'output-w4-pdf-sheets');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? '✔' : '✘'} ${name}${info ? ` – ${info}` : ''}`);
}

const MM = 72 / 25.4;
function pdfPages(file) {
  const xml = execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return xml
    .split('<page ')
    .slice(1)
    .map((p) => {
      const [, w, h] = p.match(/width="([\d.]+)" height="([\d.]+)"/);
      const words = [...p.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)<\/word>/g)].map((m) => ({
        x0: +m[1],
        y0: +m[2],
        x1: +m[3],
        y1: +m[4],
        w: m[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
      }));
      return { w: +w, h: +h, words, text: words.map((x) => x.w).join(' ') };
    });
}
function overlapsOn(page) {
  const out = [];
  const ws = page.words;
  for (let i = 0; i < ws.length; i++)
    for (let j = i + 1; j < ws.length; j++) {
      const a = ws[i];
      const b = ws[j];
      if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.8 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 1.2) out.push(`„${a.w}“ × „${b.w}“`);
    }
  return out;
}
/** Kopfzeile rechts (Seitenart): Text nach „MosaicPlan · <Projekt>“ bis zum ersten Inhaltswort */
const header = (p) => p.words.filter((w) => w.y1 < 10 * MM).map((w) => w.w).join(' ');
const isSheet = (p) => / – Blatt [A-Z]+\d+-\d+ \(\d+\/\d+\)/.test(p.text) && p.text.includes('Kontrollstrecke');
const isCutList = (p) => /Zuschnittliste Bl/.test(header(p));
const isCodePlan = (p) => p.text.includes('CODEPLAN');
function render(file, pageNo, name) {
  try {
    execFileSync('pdftoppm', ['-r', '80', '-f', String(pageNo), '-l', String(pageNo), '-png', '-singlefile', file, path.join(OUT, name)]);
  } catch {
    /* nur Bild für die Sichtprüfung */
  }
}
function renderCrop(file, pageNo, name, x, y, w, h) {
  try {
    execFileSync('pdftoppm', ['-r', '220', '-f', String(pageNo), '-l', String(pageNo), '-x', String(x), '-y', String(y), '-W', String(w), '-H', String(h), '-png', '-singlefile', file, path.join(OUT, name)]);
  } catch {
    /* nur Bild */
  }
}

async function generate(page, name) {
  await page.waitForSelector('[data-testid="pdf-btn"]');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 240000 }), page.click('[data-testid="pdf-btn"]')]);
  const file = path.join(OUT, name);
  await download.saveAs(file);
  await page.waitForSelector('[data-testid="pdf-done"]', { timeout: 60000 });
  return file;
}
const scaleBtn = (label) => `.field:has(.field-label:text("Maßstab der Verlegeblätter")) button:text-is("${label}")`;
async function setToggle(page, label, on) {
  const lab = page.locator(`label.toggle:has-text("${label}")`).first();
  const box = lab.locator('input[type="checkbox"]');
  if ((await box.isChecked()) !== on) await lab.click();
  await page.waitForTimeout(200);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(BASE);
  await page.waitForSelector('[data-testid="sample-portrait"]');
  await page.click('[data-testid="sample-portrait"]');
  await page.waitForSelector('[data-testid="compute-btn"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 180000 });
  await page.waitForTimeout(800);

  // ================= A4 1:1, Koordinaten aus (schneller), Vorlagen an
  await page.click('[data-testid="step-pdf"]');
  await page.waitForSelector('[data-testid="pdf-btn"]');
  await setToggle(page, 'Koordinatenlisten', false);
  await page.screenshot({ path: path.join(OUT, 'w4pdf-01-step.png') });
  const f1 = await generate(page, 'w4pdf-a4.pdf');
  const p1 = pdfPages(f1);
  const sheets = p1.map((p, i) => ({ p, i })).filter(({ p }) => isSheet(p));
  check('A4 1:1: Verlegeblätter vorhanden', sheets.length > 0, `${sheets.length} Blätter, ${p1.length} Seiten`);
  // Blattmaße aus der Kopfzeile „X a–b mm · Y c–d mm“
  const num = (s) => Number(s.replace(/\./g, '').replace(',', '.'));
  const bySec = new Map();
  for (const { p } of sheets) {
    const m = p.text.match(/Blatt ([A-Z]+\d+)-(\d+) \(\d+\/\d+\)/);
    const x = p.text.match(/X ([\d.,]+)–([\d.,]+) mm · Y ([\d.,]+)–([\d.,]+) mm/);
    if (!m || !x) continue;
    const list = bySec.get(m[1]) || [];
    list.push({ key: `${m[1]}-${m[2]}`, x0: num(x[1]), x1: num(x[2]), y0: num(x[3]), y1: num(x[4]) });
    bySec.set(m[1], list);
  }
  const printW = 178;
  const printH = 247;
  const narrow = [];
  for (const [id, list] of bySec) {
    const secW = Math.max(...list.map((s) => s.x1)) - Math.min(...list.map((s) => s.x0));
    const secH = Math.max(...list.map((s) => s.y1)) - Math.min(...list.map((s) => s.y0));
    for (const s of list) {
      if (secW >= 0.4 * printW && s.x1 - s.x0 < 0.4 * printW) narrow.push(`${s.key} ${(s.x1 - s.x0).toFixed(1)} mm breit`);
      if (secH >= 0.4 * printH && s.y1 - s.y0 < 0.4 * printH) narrow.push(`${s.key} ${(s.y1 - s.y0).toFixed(1)} mm hoch`);
    }
    void id;
  }
  check('Kein Blatt schmaler als 40 % der bedruckbaren Fläche (gleichmäßige Aufteilung)', bySec.size > 0 && narrow.length === 0, narrow.length ? narrow.slice(0, 4).join('; ') : [...bySec.values()].flat().map((s) => `${s.key}: ${(s.x1 - s.x0).toFixed(0)}×${(s.y1 - s.y0).toFixed(0)}`).slice(0, 4).join(', '));
  // Verweise auf die Zuschnittliste
  const cutPages = p1.map((p, i) => ({ p, i })).filter(({ p }) => isCutList(p));
  check('Zuschnittlisten-Seiten nach den Blättern', cutPages.length > 0 && cutPages.every(({ i }) => i > sheets[0].i), `${cutPages.length} Seiten`);
  let refsOk = 0;
  const refsBad = [];
  for (const { p, i } of sheets) {
    const key = (p.text.match(/Blatt ([A-Z]+\d+-\d+) \(\d+\/\d+\)/) || [])[1];
    const ref = p.text.match(/Zuschnittliste \(S\. (\d+)(?:–(\d+))?\)/) || p.text.match(/Zuschnittliste: S\. (\d+)(?:–(\d+))?/);
    if (!ref) continue;
    const a = Number(ref[1]);
    const b = Number(ref[2] || ref[1]);
    const pages = p1.slice(a - 1, b);
    const ok = a > i + 1 && pages.every(isCutList) && pages.some((q) => q.text.includes(`Blatt ${key} –`));
    if (ok) refsOk++;
    else refsBad.push(`${key} → S. ${a}–${b}`);
  }
  check('Jeder Blattverweis „Zuschnittliste S. n“ zeigt auf den Block dieses Blatts', refsOk > 0 && refsBad.length === 0, refsBad.length ? refsBad.join('; ') : `${refsOk} Blätter mit Verweis`);
  let heads = 0;
  let ids = 0;
  for (const { p } of cutPages) {
    for (const m of p.text.matchAll(/Blatt [A-Z]+\d+-\d+ – ([\d.]+) Steine?/g)) heads += num(m[1]);
    ids += p.words.filter((w) => /^[A-Z]{1,2}\d{3}(-\d+)?$/.test(w.w) && w.y0 > 25 * MM).length;
  }
  check('Zuschnittliste: Einträge = Summe der Blattköpfe', heads > 0 && heads === ids, `${ids} Einträge, Köpfe ${heads}`);
  /** gedruckte Vorlagen: Nummern T1 … TN fortlaufend (nach Häufigkeit) → N = größte Kastennummer „Vorlage TN“.
   *  (Einzelne Kastentitel können in pdftotext mit einer Kantenbeschriftung verschmelzen; das Maximum bleibt richtig.) */
  const templateBoxes = (file) => {
    const raw = execFileSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    return Math.max(0, ...[...raw.matchAll(/Vorlage T(\d+)\b/g)].map((m) => Number(m[1])));
  };
  const tplCount = templateBoxes(f1);
  // Spalte „Vorlage“: 49,5 mm ab linker Kante jeder 92-mm-Spalte (Positionen wie „T067“ stehen bei 7,5 mm)
  const inTplCol = (w) => {
    const rel = (w.x0 / MM - 10) % 92;
    return rel > 47 && rel < 75;
  };
  const tRefs = cutPages.flatMap(({ p }) => p.words.filter((w) => /^T\d+$/.test(w.w) && inTplCol(w)).map((w) => Number(w.w.slice(1))));
  check('Zuschnittliste nennt nur gedruckte Vorlagen (T ≤ Anzahl Vorlagen)', tRefs.length > 0 && tRefs.every((n) => n >= 1 && n <= tplCount), `${tRefs.length} Verweise, ${tplCount} Vorlagen`);
  let ov1 = [];
  for (const { p, i } of [...sheets, ...cutPages]) for (const o of overlapsOn(p)) ov1.push(`S.${i + 1}: ${o}`);
  check('Keine überlappenden Wörter auf Blättern und Zuschnittlisten', ov1.length === 0, ov1.slice(0, 4).join('; ') || `${sheets.length + cutPages.length} Seiten`);
  const occ = p1.some((p) => /Blätter: [A-Z]+\d+-\d+: \d+×/.test(p.text));
  check('Schnittvorlagen nennen Vorkommen je Blatt', occ);
  render(f1, sheets[sheets.length - 1].i + 1, 'w4pdf-02-sheet-a4');
  if (cutPages.length) render(f1, cutPages[0].i + 1, 'w4pdf-03-cutlist');

  // ================= An Seite anpassen: Abschnittsübersicht
  await page.click(scaleBtn('An Seite anpassen'));
  await page.waitForTimeout(300);
  const f2 = await generate(page, 'w4pdf-fit.pdf');
  const p2 = pdfPages(f2);
  const sumIdx = p2.map((p, i) => ({ p, i })).filter(({ p }) => /^MosaicPlan .* Abschnittsübersicht/.test(header(p)));
  const sumText = sumIdx.map(({ p }) => p.text).join(' ');
  const secIds = [...new Set([...p2.map((p) => p.text).join(' ').matchAll(/Blatt ([A-Z]+\d+)-1 \(1\/1\)/g)].map((m) => m[1]))];
  check(
    'An Seite anpassen: Abschnittsübersicht statt Deckblättern',
    sumIdx.length > 0 && secIds.length > 0 && secIds.every((id) => sumText.includes(`Abschnitt ${id}`)) && !p2.some((p) => p.text.includes('Farblegende und Stückzahlen des Abschnitts')),
    `${sumIdx.length} Übersichtsseite(n) für ${secIds.length} Abschnitte`,
  );
  let ov2 = [];
  for (const { p, i } of sumIdx) for (const o of overlapsOn(p)) ov2.push(`S.${i + 1}: ${o}`);
  check('Abschnittsübersicht ohne überlappende Wörter', ov2.length === 0, ov2.slice(0, 4).join('; '));
  if (sumIdx.length) render(f2, sumIdx[0].i + 1, 'w4pdf-04-summary');

  // ================= 2:1: Vorlagennummern im Stein
  await page.click(scaleBtn('2:1'));
  await page.waitForTimeout(300);
  const f3 = await generate(page, 'w4pdf-2to1.pdf');
  const p3 = pdfPages(f3);
  const tpl3 = templateBoxes(f3);
  let onPiece = 0;
  let bad = 0;
  let firstWith = -1;
  p3.forEach((p, i) => {
    if (!isSheet(p)) return;
    const ts = p.words.filter((w) => /^T\d+$/.test(w.w) && w.y0 > 29 * MM);
    if (ts.length && firstWith < 0) firstWith = i;
    onPiece += ts.length;
    bad += ts.filter((w) => !(Number(w.w.slice(1)) >= 1 && Number(w.w.slice(1)) <= tpl3)).length;
  });
  check('2:1: Vorlagennummern „T#“ in den Steinen, nur gedruckte Vorlagen', onPiece > 0 && bad === 0, `${onPiece} im Stein, ${bad} ohne gedruckte Vorlage`);
  if (firstWith >= 0) {
    const w = p3[firstWith].words.find((q) => /^T\d+$/.test(q.w) && q.y0 > 29 * MM);
    const px = 220 / 72;
    renderCrop(f3, firstWith + 1, 'w4pdf-05-tno-crop', Math.max(0, Math.round((w.x0 - 60) * px)), Math.max(0, Math.round((w.y0 - 50) * px)), 700, 500);
  }

  // ================= 2-mm-Steine: Codeplan
  await page.click('[data-testid="step-tiles"]');
  await page.click('[data-testid="tile-presets"] button:has-text("2 × 2 mm")');
  await page.waitForTimeout(300);
  await page.click('[data-testid="step-compute"]');
  await page.click('[data-testid="compute-btn"]');
  await page.waitForSelector('[data-testid="recompute-guard"], [data-testid="mosaic-canvas"]', { timeout: 180000 });
  if (await page.isVisible('[data-testid="recompute-guard"]')) await page.click('[data-testid="guard-nobackup"]');
  await page.waitForFunction(() => /\/preview$/.test(location.hash), null, { timeout: 240000 });
  await page.waitForSelector('[data-testid="mosaic-canvas"]', { timeout: 60000 });
  await page.waitForTimeout(800);
  await page.click('[data-testid="step-pdf"]');
  await page.waitForSelector('[data-testid="pdf-btn"]');
  await page.click(scaleBtn('1:1'));
  await setToggle(page, 'Schnittvorlagen', false);
  await page.waitForTimeout(300);
  const warn = await page.locator('.badge-warn', { hasText: 'Farbnummern' }).first().textContent({ timeout: 5000 }).catch(() => '');
  check('Oberfläche: Hinweis „zu klein für Farbnummern“ nennt die Codeplan-Seiten', /Codeplan/.test(warn || ''), (warn || '').slice(0, 90));
  await page.screenshot({ path: path.join(OUT, 'w4pdf-06-step-2mm.png') });
  const f4 = await generate(page, 'w4pdf-2mm.pdf');
  const p4 = pdfPages(f4);
  const codeIdx = p4.map((p, i) => ({ p, i })).filter(({ p }) => isCodePlan(p));
  const titlesOk = codeIdx.every(({ p }) => /NICHT maßstäblich \(2:1\)/.test(p.text) && !p.text.includes('Kontrollstrecke'));
  check('2 mm bei 1:1: Codeplan-Seiten (2:1, NICHT maßstäblich, ohne Kontrollstrecke)', codeIdx.length > 0 && titlesOk, `${codeIdx.length} Codeplan-Seiten`);
  let codes = 0;
  for (const { p } of codeIdx) {
    const marker = p.words.find((w) => w.w.startsWith('CODEPLAN'));
    const limitY = marker ? marker.y0 : Infinity;
    codes += p.words.filter((w) => /^\d{2}$/.test(w.w) && w.x0 >= 21.5 * MM && w.y0 >= 28.5 * MM && w.y1 < limitY).length;
  }
  const total = num((p4[0].text.match(/Steine gesamt ([\d.]+)/) || [])[1] || '0');
  check('Codeplan: genau eine Farbnummer je Stein (Summe = Steine gesamt)', total > 0 && codes === total, `${codes} Nummern, ${total} Steine`);
  const sheets4 = p4.filter(isSheet);
  check('1:1-Blätter verweisen auf ihren Codeplan', sheets4.length > 0 && sheets4.every((p) => /Farbnummern: Codeplan S\. \d+/.test(p.text)), `${sheets4.length} Blätter`);
  let ov4 = [];
  codeIdx.slice(0, 4).forEach(({ p, i }) => overlapsOn(p).forEach((o) => ov4.push(`S.${i + 1}: ${o}`)));
  check('Codeplan-Seiten ohne überlappende Wörter', ov4.length === 0, ov4.slice(0, 3).join('; '));
  if (codeIdx.length) {
    render(f4, codeIdx[0].i, 'w4pdf-07-sheet-2mm');
    render(f4, codeIdx[0].i + 1, 'w4pdf-08-codeplan');
  }

  check('keine Seitenfehler', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
  fs.writeFileSync(path.join(OUT, 'w4-pdf-sheets-results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
