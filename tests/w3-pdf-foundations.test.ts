/**
 * Welle 3 – PDF-Grundlagen: reines Tabellenlayout (pdfTable.ts) und Maßstabs-Helfer (pdfOptions.ts).
 *
 * Kern der Abnahme: In Legende, Materialliste, Einkaufsliste, Abschnittslegende und Koordinatenliste
 * überlappt kein Text einen anderen, alles liegt innerhalb der Seitenränder (A4 und 120 × 297 mm, Deutsch
 * und Türkisch, 40 Zeichen lange Materialnamen) und jede Farbnummer bleibt ein ungeteiltes Wort.
 */
import { jsPDF } from 'jspdf';
import { describe, expect, it } from 'vitest';
import { effectiveSheetScale, fitSheetScale, fmtScale, pageSize, sheetPrintArea, STANDARD_SCALES } from '../src/core/pdfOptions';
import { drawTable, layoutRow, layoutTable, PT_MM, wrapCell, wrapWords, type ColSpec, type Measure, type TableCanvas, type TableCell } from '../src/core/pdfTable';
import { dictionaries, makeT } from '../src/i18n';
import { fontBase64 } from './helpers';

// ---------- Messung wie im PDF: DejaVu Sans (in der App immer eingebettet)
const doc = new jsPDF({ unit: 'mm', format: [210, 297] });
doc.addFileToVFS('DejaVuSans.ttf', fontBase64('public/fonts/DejaVuSans.ttf'));
doc.addFont('DejaVuSans.ttf', 'DejaVu', 'normal');
doc.addFileToVFS('DejaVuSans-Bold.ttf', fontBase64('public/fonts/DejaVuSans-Bold.ttf'));
doc.addFont('DejaVuSans-Bold.ttf', 'DejaVu', 'bold');
const internalFont = (style: string) => (doc.internal as unknown as { getFont: (n: string, s: string) => unknown }).getFont('DejaVu', style);
const fonts = { normal: internalFont('normal'), bold: internalFont('bold') };
const measure: Measure = (s, bold) => (s ? doc.getStringUnitWidth(s, { font: bold ? fonts.bold : fonts.normal, fontSize: 10 }) * PT_MM : 0);
/** einfache Messung: jedes Zeichen 0,5 em */
const mono: Measure = (s) => s.length * 0.5 * PT_MM;

interface Box {
  page: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  text: string;
}

/** Zeichnet eine Tabelle in eine Aufzeichnung: Textboxen (Ober-/Unterlänge nach Schriftgröße) je Seite */
function record(cols: ColSpec[], header: string[], rows: TableCell[][], M: number, PW: number, PH: number, rowH = 5) {
  const boxes: Box[] = [];
  let page = 1;
  const cv: TableCanvas = {
    measure,
    text: (lines, x, y, o) => {
      lines.forEach((l, i) => {
        if (!l) return;
        const w = measure(l, o.bold) * o.size;
        const x0 = o.align === 'right' ? x - w : x;
        const base = y + i * o.lineH;
        boxes.push({ page, x0, x1: x0 + w, y0: base - 0.76 * o.size * PT_MM, y1: base + 0.24 * o.size * PT_MM, text: l });
      });
    },
    band: () => {},
    swatch: () => {},
    rule: () => {},
    newPage: () => {
      page++;
      return M + 6;
    },
  };
  const tl = layoutTable(cols, header, rows, measure, PW - 2 * M);
  const endY = drawTable(cv, cols, rows, tl, { x: M, y: M + 15, bottom: PH - M - 8, rowH });
  return { boxes, tl, pages: page, endY };
}

function overlaps(boxes: Box[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.page !== b.page) continue;
      if (Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.05 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.05) out.push(`p${a.page}: „${a.text}“ × „${b.text}“`);
    }
  return out;
}

const longNames = ['Sicis Vetrite Collezione Grande Iridium', 'Bisazza Mosaico Smalto 20 Opus Romano', 'Mosaico Digitale Vetro Lucido Profondo', 'Trend Vitreo Superiore Cristallo Natura'];
const colorNo = (i: number) => `VT-${1000 + i}-GLOSS`;

function tables(lang: 'de' | 'tr') {
  const t = makeT(lang);
  const names = lang === 'tr' ? ['Çelik mavisi 3', 'Koyu yeşil (koyu)', 'Açık gri', 'Hautton orta 2', 'Fıstık yeşili'] : ['Stahlblau 3', 'Dunkelgrün (dunkel)', 'Hellgrau', 'Hautton mittel 2', 'Gelbgrün'];
  const n = 24;
  const legendRows: TableCell[][] = Array.from({ length: n }, (_, i) => [
    String(i + 1).padStart(2, '0'),
    { swatch: '#808080' },
    names[i % names.length],
    '#4879AF',
    `${49.6 + i}; -12,3; -33,8`.replace('.', ','),
    String(1000 + i * 37),
    String(900 + i * 31),
    String(990 + i * 34),
    longNames[i % longNames.length],
    colorNo(i),
  ]);
  const legend = {
    cols: [{}, { kind: 'swatch' }, { kind: 'text', max: 50 }, { foldInto: 2, foldOrder: 3 }, { kind: 'tokens', foldInto: 2, foldOrder: 1 }, { align: 'right' }, { align: 'right' }, { align: 'right' }, { kind: 'text', max: 60 }, { foldInto: 8, foldOrder: 2 }] as ColSpec[],
    header: [t('pdf.code'), '', t('pdf.name'), 'HEX', 'CIELAB', t('pdf.stones'), t('pdf.rawStones'), t('pdf.withReserve', { p: 10 }), t('pdf.material'), t('pdf.colorNo')],
    rows: legendRows,
  };
  const perColor = {
    cols: [{}, { kind: 'swatch' }, { kind: 'text', max: 45 }, { kind: 'text', max: 70 }, { foldInto: 3, foldOrder: 1 }, { kind: 'tokens' }, { align: 'right' }] as ColSpec[],
    header: [t('pdf.code'), '', t('pdf.name'), t('pdf.material'), t('pdf.colorNo'), t('pdf.rawSize'), t('pdf.needed')],
    rows: legendRows.map((r, i) => [r[0], r[1], r[2], `${t('mat.glass')} · ${longNames[i % longNames.length]}`, colorNo(i), '20 × 20 *', '1.271']),
  };
  const shop = {
    cols: [
      { kind: 'text', max: 60 },
      { foldInto: 0, foldOrder: 1 },
      { kind: 'text', max: 40, foldInto: 0, foldOrder: 2 },
      { kind: 'tokens', foldInto: 0, foldOrder: 3 },
      { align: 'right' },
      { align: 'right', foldInto: 4, foldOrder: 4 },
      { align: 'right', foldInto: 4, foldOrder: 5 },
      { kind: 'tokens' },
      { align: 'right' },
    ] as ColSpec[],
    header: [t('pdf.material'), t('pdf.colorNo'), t('pdf.shopColors'), t('pdf.rawSize'), t('pdf.needed'), t('pdf.stock'), t('pdf.toBuy'), t('pdf.packs'), t('pdf.costCol')],
    rows: Array.from({ length: 12 }, (_, i) => [longNames[i % 4], colorNo(i), '03, 04, 11, 17, 22', '20 × 20', '1.271', '200', '1.071', '2 × 1 kg (2)', '27,5']),
  };
  const sectionLegend = {
    cols: [{}, { kind: 'swatch' }, { kind: 'text', max: 50 }, { foldInto: 2, foldOrder: 1 }, { align: 'right' }, { align: 'right' }, { align: 'right' }, { align: 'right' }] as ColSpec[],
    header: [t('pdf.code'), '', t('pdf.name'), 'HEX', t('pdf.stones'), t('pdf.uncut'), t('pdf.cut'), t('pdf.rawStones')],
    rows: legendRows.map((r) => [r[0], r[1], r[2], r[3], '1.234', '1.000', '234', '1.120']),
  };
  const coords = {
    cols: [{}, { align: 'right' }, { align: 'right' }, {}, { kind: 'text', max: 45 }, { kind: 'tokens' }, { kind: 'tokens', foldInto: 4, foldOrder: 1 }] as ColSpec[],
    header: [t('pdf.position'), 'X (mm)', 'Y (mm)', t('pdf.code'), t('pdf.shape'), t('pdf.sizeMm'), t('pdf.cutQ')],
    rows: Array.from({ length: 140 }, (_, i) => [`AB${String(i + 1).padStart(3, '0')}-2`, '1.234,56', '2.345,67', '07', t('shape.custom'), '12,25 × 12,25', `${t('pdf.yes')} (T123)`]),
  };
  return { legend, perColor, shop, sectionLegend, coords };
}

describe('Tabellenlayout: keine Überlappung, innerhalb der Ränder, Farbnummern ungeteilt', () => {
  const M = 10;
  for (const lang of ['de', 'tr'] as const)
    for (const [PW, PH] of [
      [210, 297],
      [120, 297],
    ])
      it(`${lang}, ${PW} × ${PH} mm`, () => {
        for (const [name, tb] of Object.entries(tables(lang))) {
          const { boxes, tl, pages } = record(tb.cols, tb.header, tb.rows, M, PW, PH, name === 'coords' ? 4.2 : 5);
          expect(overlaps(boxes), `${name}: ${overlaps(boxes).slice(0, 3).join('; ')}`).toEqual([]);
          for (const b of boxes) {
            expect(b.x0, `${name}: ${b.text}`).toBeGreaterThanOrEqual(M - 1e-6);
            expect(b.x1, `${name}: ${b.text}`).toBeLessThanOrEqual(PW - M + 1e-6);
            expect(b.y0).toBeGreaterThanOrEqual(M);
            expect(b.y1).toBeLessThanOrEqual(PH - M);
          }
          expect(tl.totalW).toBeLessThanOrEqual(PW - 2 * M + 1e-6);
          expect(tl.overflow).toBe(false);
          // letzter Ausweg (Wörter trennen) wird für diese Tabellen nie gebraucht
          expect(tl.breakWords, name).toBe(false);
          // Farbnummern: jede steht ungeteilt in genau einer Zeile, kein Bruchstück „VT-“ ohne „-GLOSS“
          const texts = boxes.map((b) => b.text);
          for (const r of tb.rows) for (const c of r) if (typeof c === 'string' && /^VT-\d+-GLOSS$/.test(c)) expect(texts.some((x) => x === c || x.split(' ').includes(c)), `${name}: ${c}`).toBe(true);
          for (const x of texts) if (x.includes('VT-')) expect(x).toMatch(/VT-\d+-GLOSS/);
          // jede Zeile hat Platz: Kopfzeile auf jeder Seite wiederholt, keine Zeile verloren
          expect(pages).toBeGreaterThanOrEqual(1);
          const firstCol = tb.rows.map((r) => r[0]).filter((c): c is string => typeof c === 'string');
          for (const c of firstCol) expect(texts.some((x) => x.startsWith(c) || c.startsWith(x)), `${name}: ${c}`).toBe(true);
        }
      });

  it('A4: Legende ohne Unterlegen in 8 pt, auf 120 mm Papier mit untergelegten Spalten statt Wortsalat', () => {
    const tb = tables('de').legend;
    const a4 = layoutTable(tb.cols, tb.header, tb.rows, measure, 190);
    expect(a4.fontSize).toBe(8);
    expect(a4.foldedInto.every((f) => f === null)).toBe(true);
    const narrow = layoutTable(tb.cols, tb.header, tb.rows, measure, 100);
    expect(narrow.fontSize).toBe(6.5);
    expect(narrow.foldedInto[9]).toBe(8); // Farbnr. unter Material
    expect(narrow.headerLines[8]).toEqual(expect.arrayContaining(['Material', 'Farbnr.']));
    const row = layoutRow(narrow, tb.cols, tb.rows[0], measure);
    expect(row.lines[8]).toContain('VT-1000-GLOSS');
  });

  it('Breiten werden nie auf Seitenbreite gestreckt (A2 = A4-Breite der Tabelle)', () => {
    const tb = tables('de').sectionLegend;
    const a4 = layoutTable(tb.cols, tb.header, tb.rows, measure, 190);
    const a2 = layoutTable(tb.cols, tb.header, tb.rows, measure, 400);
    expect(a2.totalW).toBeCloseTo(a4.totalW, 6);
    expect(a2.totalW).toBeLessThan(190);
  });

  it('Schrift wird erst 7, dann 6,5 pt, bevor Bezeichner umbrochen werden', () => {
    const cols: ColSpec[] = [{}, {}, {}];
    const rows = [['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ1234']];
    const nat = (fs: number) => rows[0].reduce((a, c) => a + mono(c, false) * fs + 2.4, 0);
    expect(layoutTable(cols, ['', '', ''], rows, mono, nat(8)).fontSize).toBe(8);
    expect(layoutTable(cols, ['', '', ''], rows, mono, nat(8) - 1).fontSize).toBe(7);
    expect(layoutTable(cols, ['', '', ''], rows, mono, nat(7) - 1).fontSize).toBe(6.5);
    // passt gar nicht: Überlauf gemeldet, aber nichts getrennt oder gekürzt
    const tl = layoutTable(cols, ['', '', ''], rows, mono, 20);
    expect(tl.overflow).toBe(true);
    expect(layoutRow(tl, cols, rows[0], mono).lines).toEqual([['ABCDEFGHIJ'], ['KLMNOPQRST'], ['UVWXYZ1234']]);
  });

  it('mehrzeilige Zeilen haben ihre eigene Höhe, der Seitenumbruch rechnet damit', () => {
    const cols: ColSpec[] = [{ kind: 'text', max: 20 }, { align: 'right' }];
    const long = 'eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf';
    const rows: TableCell[][] = Array.from({ length: 30 }, (_, i) => [long, String(i)]);
    const { boxes, pages } = record(cols, ['Text', 'Nr.'], rows, 10, 60, 120);
    expect(overlaps(boxes)).toEqual([]);
    expect(pages).toBeGreaterThan(1);
    for (const b of boxes) expect(b.y1).toBeLessThanOrEqual(120 - 10);
    // Kopfzeile wird auf jeder Seite wiederholt
    expect(boxes.filter((b) => b.text === 'Nr.').length).toBe(pages);
  });
});

describe('Umbruchregeln', () => {
  const W = (s: string) => mono(s, false) * 8;
  it('fixed: nie umbrochen; tokens: nur an Leerzeichen und nur wenn erlaubt; text: an Leerzeichen und nach Bindestrich', () => {
    expect(wrapCell('VT-1000-GLOSS', 5, 'fixed', 8, false, mono)).toEqual(['VT-1000-GLOSS']);
    expect(wrapCell('53,2; -12,3; 45,6', W('-12,3;'), 'tokens', 8, false, mono)).toEqual(['53,2; -12,3; 45,6']);
    expect(wrapCell('53,2; -12,3; 45,6', W('-12,3;'), 'tokens', 8, false, mono, { tokensWrap: true })).toEqual(['53,2;', '-12,3;', '45,6']);
    expect(wrapCell('Glas-Mosaik Hellblau', W('Mosaik'), 'text', 8, false, mono)).toEqual(['Glas-', 'Mosaik', 'Hellblau']);
    // überlange Wörter nur im letzten Ausweg zeichenweise
    expect(wrapCell('Donaudampfschiff', W('Donau'), 'text', 8, false, mono)).toEqual(['Donaudampfschiff']);
    expect(wrapCell('Donaudampfschiff', W('Donau'), 'text', 8, false, mono, { breakWords: true }).join('')).toBe('Donaudampfschiff');
    // explizite Zeilen bleiben
    expect(wrapCell('1 × Beutel\n(1)', 100, 'fixed', 8, false, mono)).toEqual(['1 × Beutel', '(1)']);
    expect(wrapWords('a b c', 100, 8, false, mono)).toEqual(['a b c']);
  });
});

describe('Maßstab: ein Normmaßstab für „an Seite anpassen“', () => {
  const sec = (w: number, h: number) => ({ w, h });
  it('rastet auf die Normreihe ab (nie größer als passend)', () => {
    const { printW, printH } = sheetPrintArea(210, 297);
    expect(printW).toBe(178);
    expect(printH).toBe(247);
    expect(fitSheetScale([sec(300, 300)], printW, printH)).toBe(0.5); // roh 0,593
    expect(fitSheetScale([sec(150, 200)], printW, printH)).toBe(1); // roh 1,187
    expect(fitSheetScale([sec(80, 100)], printW, printH)).toBe(2); // roh 2,225
    expect(fitSheetScale([sec(10, 10)], printW, printH)).toBe(4); // höchstens 4:1
    expect(fitSheetScale([sec(200, 270)], printW, printH)).toBeCloseTo(1 / 1.25, 12); // roh 0,89
    expect(fitSheetScale([sec(20000, 20000)], printW, printH)).toBeCloseTo(1 / 113, 12); // unter 1:100 → 1:⌈1/roh⌉
    // Minimum über ALLE Abschnitte – ein kleiner Randabschnitt ändert nichts, ein großer schon
    expect(fitSheetScale([sec(150, 200), sec(20, 200)], printW, printH)).toBe(1);
    expect(fitSheetScale([sec(150, 200), sec(300, 200)], printW, printH)).toBe(0.5);
    for (const s of STANDARD_SCALES) expect(fitSheetScale([sec(printW / s, printH / s)], printW, printH)).toBeCloseTo(s, 12);
  });

  it('effektiver Maßstab: fester Maßstab bleibt, 0 = gemeinsamer Anpassungsmaßstab', () => {
    expect(effectiveSheetScale({ sheetScale: 2 }, [sec(300, 300)], 178, 247)).toBe(2);
    expect(effectiveSheetScale({ sheetScale: 0 }, [sec(300, 300)], 178, 247)).toBe(0.5);
  });

  it('Schreibweise 2:1, 1:1, 1:1,5 (Dezimalkomma außer Englisch)', () => {
    expect(fmtScale(2, 'de')).toBe('2:1');
    expect(fmtScale(1, 'de')).toBe('1:1');
    expect(fmtScale(1 / 1.5, 'de')).toBe('1:1,5');
    expect(fmtScale(1 / 1.5, 'en')).toBe('1:1.5');
    expect(fmtScale(1 / 1.25, 'tr')).toBe('1:1,25');
    expect(fmtScale(0.5, 'de')).toBe('1:2');
  });

  it('Seitengröße aus Format und Ausrichtung', () => {
    expect(pageSize({ format: 'a3', orientation: 'landscape' })).toEqual({ PW: 420, PH: 297 });
    expect(pageSize({ format: 'custom', customW: 297, customH: 120, orientation: 'portrait' })).toEqual({ PW: 120, PH: 297 });
  });
});

describe('Übersetzungen', () => {
  it('Türkisch: „Pafta“ für Verlegeblätter, „Sayfa“ nur für Seiten', () => {
    const tr = dictionaries.tr as Record<string, string>;
    expect(tr['pdf.sheet']).toBe('Pafta');
    expect(tr['pdf.page']).toBe('Sayfa');
    expect(tr['pdf.markHint']).toContain('Paftaları');
  });
  it('alle neuen Texte in DE, EN und TR mit denselben Platzhaltern', () => {
    for (const k of ['pdf.coordsNotice', 'pdf.coordsTitlePartial', 'pdf.err.integrity', 'pdf.fitScale', 'pdf.notFullSize']) {
      const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
      const de = (dictionaries.de as Record<string, string>)[k];
      expect(de).toBeTruthy();
      expect(ph((dictionaries.en as Record<string, string>)[k])).toBe(ph(de));
      expect(ph((dictionaries.tr as Record<string, string>)[k])).toBe(ph(de));
    }
  });
});
