/**
 * Paket w5-pdf-export-ui – reine Logik des PDF-Exports (core/pdfExportPlan.ts):
 *  - Abschnittsauswahl als Text: exakt gelesen („A1-B2“ = A1, A2, B1, B2; „Z99“ abgelehnt), Rundreise mit formatSectionRange
 *  - Auswahl ändern: Abschnitt, ganze Zeile/Spalte, nur offene Abschnitte
 *  - Speicherbedarf (Richtwert), Speichergrenze, Aufteilung in Teile (jeder Abschnitt genau einmal, Reihenfolge, Grenze)
 *  - Seitenplan aus der Vorabmessung = Seitenzahl des erzeugten PDFs (mit Bildern, verschiedene Optionen und Auswahlen)
 *  - Teile: jedes Teil-PDF enthält nur seine Abschnitte; Steine je Farbe über alle Teile = Statistik; Blattnummern wie
 *    im Export als eine Datei
 *  - Vermerk „PDF-Export läuft“ und gespeicherte Speichergrenze
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { hexToRgb } from '../src/core/color';
import { computeLayout, computeSections, computeSectionsByCount, type SectionGrid } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { DEFAULT_PDF_OPTIONS, generatePdfReport, pdfLayoutFacts, type PdfInput, type PdfOptions } from '../src/core/pdf';
import {
  clearInFlight,
  exportFileName,
  formatSectionRange,
  loweredBudgetAfterCrash,
  markInFlight,
  memoryBudget,
  normalizeSelection,
  openSections,
  parseSectionRange,
  PDF_BUDGET,
  PDF_BUDGET_KEY,
  PDF_INFLIGHT_KEY,
  PDF_MEMORY,
  planExportParts,
  planForSelection,
  readBudgetOverride,
  readInFlight,
  sameSelection,
  sectionCosts,
  toggleLine,
  toggleSection,
  writeBudgetOverride,
  type InFlightInfo,
  type KeyStore,
  type SectionCost,
} from '../src/core/pdfExportPlan';
import { CODE_MIN_CELL, planSheets } from '../src/core/pdfPlan';
import { computeStats } from '../src/core/stats';
import { DEFAULT_SETTINGS, DEFAULT_SHAPES } from '../src/core/types';
import { makeT } from '../src/i18n';
import { loadPng, prepareFor } from './helpers';

// ---------------------------------------------------------------- Hilfen
const grid = (srows: number, scols: number) => ({ srows, scols });

/** Abschnittsraster n × m über einem einfachen Layout */
function sectionGrid(scols: number, srows: number, tile = 10): { layout: ReturnType<typeof computeLayout>; G: SectionGrid } {
  const layout = computeLayout({ widthMm: scols * 60, heightMm: srows * 60, tileW: tile, tileH: tile, joint: 2, edgeMode: 'whole', minCutMm: 2 });
  return { layout, G: computeSectionsByCount(layout, scols, srows) };
}

function pdfStreams(buf: ArrayBuffer): string[] {
  const s = Buffer.from(buf).toString('latin1');
  const out: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const len = Number(s.slice(Math.max(0, m.index - 200), m.index).match(/\/Length (\d+)(?![\s\S]*\/Length)/)?.[1]);
    const end = Number.isFinite(len) ? start + len : s.indexOf('endstream', start);
    if (end < 0) break;
    const raw = Buffer.from(s.slice(start, end), 'latin1');
    try {
      out.push(inflateSync(raw).toString('latin1'));
    } catch {
      out.push(raw.toString('latin1'));
    }
    re.lastIndex = end + 9;
  }
  return out;
}
/** gefüllte+umrandete Flächen („B“ = Steine) je Füllfarbe außerhalb von Textblöcken */
function countFills(stream: string): Map<string, number> {
  const res = new Map<string, number>();
  let fill = '';
  let inText = false;
  for (const line of stream.split('\n')) {
    const l = line.trim();
    if (l === 'BT') inText = true;
    else if (l === 'ET') inText = false;
    else if (!inText && / rg$/.test(l)) fill = l.replace(/ rg$/, '');
    else if (!inText && / g$/.test(l)) {
      const v = l.replace(/ g$/, '');
      fill = `${v} ${v} ${v}`;
    } else if (l === 'B') res.set(fill, (res.get(fill) ?? 0) + 1);
  }
  return res;
}
function fmtColor(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const f = (v: number) => (v / 255).toFixed(2).replace(/\.?0+$/, '') || '0';
  return `${f(r)} ${f(g)} ${f(b)}`;
}
/** Verlegeblätter eines PDFs: Inhaltsströme mit „Blatt“ und Kontrollstrecke (Codeplan- und Legendenseiten haben keine) */
const sheetStreams = (pdf: ArrayBuffer) => pdfStreams(pdf).filter((s) => s.includes('Blatt') && s.includes('Kontrollstrecke'));
const sheetIds = (streams: string[]) => {
  const ids = new Set<string>();
  // Kopfzeile „Abschnitt A1  Blatt A1-1 (1/4)“ – Klammern stehen im Inhaltsstrom mit Rückstrich
  for (const s of streams) for (const m of s.matchAll(/Blatt ([A-Z]+\d+-\d+) \\\(\d+\/\d+\\\)/g)) ids.add(m[1]);
  return ids;
};

class FakeStore implements KeyStore {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

// ================================================================ Abschnittsauswahl als Text
describe('parseSectionRange: Abschnittsauswahl exakt lesen', () => {
  const g = grid(4, 5); // A–D × 1–5

  it('„A1-B2“ wählt genau A1, A2, B1 und B2', () => {
    expect(parseSectionRange('A1-B2', g)).toEqual({ ids: ['A1', 'A2', 'B1', 'B2'], issues: [] });
  });
  it('„Z99“ wird abgelehnt – nichts wird ausgewählt', () => {
    const r = parseSectionRange('Z99', g);
    expect(r.ids).toEqual([]);
    expect(r.issues).toEqual([{ kind: 'unknown', token: 'Z99', id: 'Z99' }]);
  });
  it('einzelne Abschnitte und Bereiche gemischt, Reihenfolge = Rasterreihenfolge, keine Doppelten', () => {
    expect(parseSectionRange('D5, A1-A3; b2 A2', g).ids).toEqual(['A1', 'A2', 'A3', 'B2', 'D5']);
    expect(parseSectionRange('C2-B1', g).ids).toEqual(['B1', 'B2', 'C1', 'C2']);
  });
  it('Schreibweisen: Halbgeviertstrich, Leerzeichen um den Strich, „:“, „bis“, Kleinbuchstaben', () => {
    for (const s of ['A1–B2', 'a1 - b2', 'A1:B2', 'A1 bis B2', 'a1 to b2', '  A1-B2  ', 'A1-B2,']) expect(parseSectionRange(s, g).ids, s).toEqual(['A1', 'A2', 'B1', 'B2']);
  });
  it('ein unbekannter Abschnitt macht die ganze Eingabe ungültig (nie still weggelassen)', () => {
    const r = parseSectionRange('A1-B2, E1, A6', g);
    expect(r.ids).toEqual([]);
    expect(r.issues).toEqual([
      { kind: 'unknown', token: 'E1', id: 'E1' },
      { kind: 'unknown', token: 'A6', id: 'A6' },
    ]);
    // Bereichsende außerhalb
    expect(parseSectionRange('A1-D9', g).issues).toEqual([{ kind: 'unknown', token: 'A1-D9', id: 'D9' }]);
  });
  it('unlesbare Einträge: Schreibfehler, Zellbezeichnung mit führender Null, leere Bereichsenden', () => {
    for (const s of ['A', '7', 'A1-', '-B2', 'A1-B2-C3', 'A01', 'A0', '1A', 'A1.5', 'Ä1', 'A1/B2']) {
      const r = parseSectionRange(s, g);
      expect(r.ids, s).toEqual([]);
      expect(r.issues.length, s).toBeGreaterThan(0);
      expect(r.issues.every((i) => i.kind === 'syntax'), s).toBe(true);
    }
  });
  it('leere Eingabe: eigener Hinweis', () => {
    expect(parseSectionRange('', g)).toEqual({ ids: [], issues: [{ kind: 'empty' }] });
    expect(parseSectionRange(' , ; ', g).issues).toEqual([{ kind: 'empty' }]);
  });
  it('Zeilen über Z hinaus (AA, AB …)', () => {
    const big = grid(30, 3);
    expect(parseSectionRange('Z3-AB1', big).ids).toEqual(['Z1', 'Z2', 'Z3', 'AA1', 'AA2', 'AA3', 'AB1', 'AB2', 'AB3']);
    expect(parseSectionRange('AE1', big).issues[0]).toEqual({ kind: 'unknown', token: 'AE1', id: 'AE1' });
  });
});

describe('formatSectionRange: kürzeste Schreibweise, Rundreise', () => {
  it('Rechtecke werden zusammengefasst', () => {
    const g = grid(4, 5);
    expect(formatSectionRange(['A1', 'A2', 'B1', 'B2'], g)).toBe('A1-B2');
    expect(formatSectionRange(['A1', 'A2', 'B1', 'B2', 'D5'], g)).toBe('A1-B2, D5');
    expect(formatSectionRange(['B2'], g)).toBe('B2');
    expect(formatSectionRange(['A1', 'A2', 'A3', 'A4', 'A5'], g)).toBe('A1-A5');
    expect(formatSectionRange(['A1', 'B2'], g)).toBe('A1, B2');
    expect(formatSectionRange([], g)).toBe('');
    expect(formatSectionRange(['Z9', 'kaputt'], g)).toBe('');
  });
  it('parse(format(Auswahl)) ergibt wieder genau die Auswahl – 300 zufällige Auswahlen', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let it = 0; it < 300; it++) {
      const { G } = sectionGrid(1 + Math.floor(rnd() * 7), 1 + Math.floor(rnd() * 7));
      const p = rnd();
      const ids = G.sections.filter(() => rnd() < p).map((s) => s.id);
      const text = formatSectionRange(ids, G);
      if (!ids.length) {
        expect(text).toBe('');
        continue;
      }
      const back = parseSectionRange(text, G);
      expect(back.issues, text).toEqual([]);
      expect(back.ids, text).toEqual(ids);
    }
  });
});

// ================================================================ Auswahl ändern
describe('Auswahl ändern', () => {
  const { G } = sectionGrid(3, 2); // A1 A2 A3 / B1 B2 B3

  it('normalizeSelection: Rasterreihenfolge, ohne Doppelte und Unbekannte; leer oder alle = null', () => {
    expect(normalizeSelection(['B2', 'A1', 'B2', 'Z9'], G)).toEqual(['A1', 'B2']);
    expect(normalizeSelection([], G)).toBeNull();
    expect(normalizeSelection(['Z9'], G)).toBeNull();
    expect(normalizeSelection(null, G)).toBeNull();
    expect(normalizeSelection(G.sections.map((s) => s.id).reverse(), G)).toBeNull();
  });
  it('toggleSection: bei „alle“ nur dieser Abschnitt; sonst an/ab; letzter abgewählt = alle', () => {
    expect(toggleSection(null, 'B2', G)).toEqual(['B2']);
    expect(toggleSection(['B2'], 'A1', G)).toEqual(['A1', 'B2']);
    expect(toggleSection(['A1', 'B2'], 'A1', G)).toEqual(['B2']);
    expect(toggleSection(['B2'], 'B2', G)).toBeNull();
  });
  it('toggleLine: ganze Zeile bzw. Spalte an- oder abwählen', () => {
    expect(toggleLine(null, G, 'row', 1)).toEqual(['B1', 'B2', 'B3']);
    expect(toggleLine(null, G, 'col', 2)).toEqual(['A3', 'B3']);
    // teilweise gewählt → alle der Zeile dazu
    expect(toggleLine(['A1', 'B2'], G, 'row', 0)).toEqual(['A1', 'A2', 'A3', 'B2']);
    // vollständig gewählt → abwählen
    expect(toggleLine(['A1', 'A2', 'A3', 'B2'], G, 'row', 0)).toEqual(['B2']);
    expect(toggleLine(['A2', 'B2'], G, 'col', 1)).toBeNull();
    // Zeile, die es nicht gibt: Auswahl unverändert
    expect(toggleLine(['A1'], G, 'row', 7)).toEqual(['A1']);
  });
  it('openSections: Abschnitte mit verlegt < Steine; ohne Zahlen null', () => {
    const pr = new Map([
      ['A1', { placed: 10, total: 10 }],
      ['A2', { placed: 3, total: 10 }],
      ['A3', { placed: 0, total: 10 }],
      ['B1', { placed: 10, total: 10 }],
      ['B2', { placed: 9, total: 10 }],
    ]);
    expect(openSections(G, pr)).toEqual(['A2', 'A3', 'B2', 'B3']);
    expect(openSections(G, null)).toBeNull();
  });
  it('sameSelection: null = alle', () => {
    expect(sameSelection(null, G.sections.map((s) => s.id), G)).toBe(true);
    expect(sameSelection(['A1', 'B2'], ['B2', 'A1'], G)).toBe(true);
    expect(sameSelection(['A1'], ['A2'], G)).toBe(false);
    expect(sameSelection(['A1'], null, G)).toBe(false);
  });
});

// ================================================================ Speicherbedarf, Grenze, Teile
describe('Speicherbedarf (Richtwert)', () => {
  const M = PDF_MEMORY;
  const noCoords: PdfOptions = { ...DEFAULT_PDF_OPTIONS, includeCoords: false };

  it('Steine mit Farbnummer: 1 KB je Stein, mal 2', () => {
    const { layout, G } = sectionGrid(3, 2); // 10-mm-Steine bei 1:1 → Farbnummern
    const costs = sectionCosts(layout, G, noCoords, () => 100);
    expect(costs.map((c) => c.id)).toEqual(G.sections.map((s) => s.id));
    for (const c of costs) expect(c).toMatchObject({ stones: 100, coded: 100, plain: 0, coordRows: 0, bytes: 2 * 100 * M.codedStone });
  });
  it('ohne Steinzahlen zählen die Rasterzellen; nur gewählte Abschnitte', () => {
    const { layout, G } = sectionGrid(3, 2);
    const costs = sectionCosts(layout, G, { ...noCoords, sectionIds: ['B2', 'A1'] });
    expect(costs.map((c) => c.id)).toEqual(['A1', 'B2']);
    const a1 = G.sections[0];
    expect(costs[0].stones).toBe((a1.c1 - a1.c0) * (a1.r1 - a1.r0));
  });
  it('Steine zu klein für Nummern: 0,1 KB auf dem Blatt, dazu Codeplan (mit Nummer) – außer Codeplan aus', () => {
    const { layout, G } = sectionGrid(2, 2, 2); // 2-mm-Steine bei 1:1 < 2,2 mm
    expect(Math.min(layout.tileW, layout.tileH)).toBeLessThan(CODE_MIN_CELL);
    const auto = sectionCosts(layout, G, { ...noCoords, codePlan: 'auto' }, () => 1000)[0];
    expect(auto).toMatchObject({ plain: 1000, coded: 1000 });
    expect(auto.bytes).toBe(2 * (1000 * M.codedStone + 1000 * M.plainStone));
    const off = sectionCosts(layout, G, { ...noCoords, codePlan: 'off' }, () => 1000)[0];
    expect(off).toMatchObject({ plain: 1000, coded: 0, bytes: 2 * 1000 * M.plainStone });
    // gemessener Seitenplan (je Blatt): nur das erste Blatt von A1 bekommt einen Codeplan
    const sheets: Record<string, { cutEntries: number; codeK: number }> = {};
    for (const sec of planSheets(layout, G, noCoords).sections) for (const sh of sec.sheets) sheets[sh.key] = { cutEntries: 0, codeK: sh.key === 'A1-1' ? 2 : 0 };
    const plan = sectionCosts(layout, G, { ...noCoords, codePlan: 'auto' }, () => 1000, { sheets });
    expect(plan[0].coded).toBeGreaterThan(0);
    expect(plan[0].coded).toBeLessThanOrEqual(1000);
    expect(plan[1].coded).toBe(0);
  });
  it('Codeplan „immer“: jeder Stein zweimal mit Nummer', () => {
    const { layout, G } = sectionGrid(2, 1);
    const c = sectionCosts(layout, G, { ...noCoords, codePlan: 'always' }, () => 50)[0];
    expect(c).toMatchObject({ coded: 100, plain: 0 });
  });
  it('Koordinaten: je Stein 5 KB je Zeile (höchstens Limit), kompakt nur je Rasterzeile', () => {
    const { layout, G } = sectionGrid(2, 1);
    const per = sectionCosts(layout, G, { ...DEFAULT_PDF_OPTIONS, coordMode: 'perStone', coordLimit: 30 }, () => 50)[0];
    expect(per.coordRows).toBe(30);
    expect(per.bytes).toBe(2 * (50 * M.codedStone + 30 * M.coordRow));
    const sec = G.sections[0];
    const compact = sectionCosts(layout, G, { ...DEFAULT_PDF_OPTIONS, coordMode: 'compact' }, () => 50)[0];
    expect(compact.coordRows).toBe(0);
    expect(compact.bytes).toBe(2 * (50 * M.codedStone + (sec.r1 - sec.r0) * M.compactRow));
    const none = sectionCosts(layout, G, { ...DEFAULT_PDF_OPTIONS, includeCoords: false, coordMode: 'perStone' }, () => 50)[0];
    expect(none.bytes).toBe(2 * 50 * M.codedStone);
  });
});

describe('Speichergrenze', () => {
  it('35 % der Heap-Grenze, sonst 150 MB, gespeicherter Wert hat Vorrang', () => {
    expect(memoryBudget({ jsHeapSizeLimit: 4_000_000_000 })).toEqual({ bytes: 1_400_000_000, source: 'heap' });
    expect(memoryBudget({})).toEqual({ bytes: 150 * 1024 * 1024, source: 'fallback' });
    expect(memoryBudget({ jsHeapSizeLimit: 0 }).source).toBe('fallback');
    expect(memoryBudget({ jsHeapSizeLimit: NaN }).source).toBe('fallback');
    expect(memoryBudget({ jsHeapSizeLimit: 4e9, overrideMb: 64 })).toEqual({ bytes: 64 * 1024 * 1024, source: 'override' });
    expect(memoryBudget({ jsHeapSizeLimit: 4e9, overrideMb: 0 }).source).toBe('heap');
    expect(memoryBudget({ overrideMb: null }).source).toBe('fallback');
    expect(PDF_BUDGET.heapShare).toBeCloseTo(0.35);
  });
  it('nach einem nicht beendeten Export: halber Richtwert – nur wenn er unter der Grenze lag', () => {
    const MB = 1024 * 1024;
    expect(loweredBudgetAfterCrash(200 * MB, 500 * MB)).toBe(100 * MB);
    // bewusst über der Grenze exportiert: keine Aussage über die Grenze
    expect(loweredBudgetAfterCrash(900 * MB, 500 * MB)).toBeNull();
    // nie unter die Mindestgrenze
    expect(loweredBudgetAfterCrash(10 * MB, 500 * MB)).toBe(PDF_BUDGET.minBytes);
    expect(loweredBudgetAfterCrash(10 * MB, PDF_BUDGET.minBytes)).toBeNull();
    expect(loweredBudgetAfterCrash(0, 500 * MB)).toBeNull();
  });
});

describe('planExportParts: Aufteilung in Teile', () => {
  const cost = (id: string, bytes: number): SectionCost => ({ id, stones: bytes / 10, coded: 0, plain: 0, coordRows: 0, bytes });

  it('passt als eine Datei: ein Teil', () => {
    const p = planExportParts([cost('A1', 10), cost('A2', 20)], 100);
    expect(p).toMatchObject({ fitsSingle: true, totalBytes: 30, tooBig: [] });
    expect(p.parts).toEqual([{ index: 0, ids: ['A1', 'A2'], stones: 3, bytes: 30 }]);
  });
  it('kleinste Anzahl Teile, gleichmäßig verteilt, aufeinanderfolgend', () => {
    // gierig: 40+40 | 40+40 | 40 → 3 Teile; gleichmäßig: 80 | 80 | 40 bzw. kleinster größter Teil
    const costs = ['A1', 'A2', 'A3', 'B1', 'B2'].map((id) => cost(id, 40));
    const p = planExportParts(costs, 100);
    expect(p.fitsSingle).toBe(false);
    expect(p.parts.length).toBe(3);
    expect(p.parts.flatMap((x) => x.ids)).toEqual(['A1', 'A2', 'A3', 'B1', 'B2']);
    expect(Math.max(...p.parts.map((x) => x.bytes))).toBeLessThanOrEqual(100);
    // 6 × 30 bei Grenze 100: gierig 3+3 → gleichmäßig 90 | 90
    const q = planExportParts(['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map((id) => cost(id, 30)), 100);
    expect(q.parts.map((x) => x.bytes)).toEqual([90, 90]);
    // 7 × 30: gierig 3+3+1 (90, 90, 30) → gleichmäßig 60 | 90 | 60, kein winziger Rest neben vollen Teilen
    const r = planExportParts(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'].map((id) => cost(id, 30)), 100);
    expect(r.parts.map((x) => x.bytes)).toEqual([60, 90, 60]);
    // ungleiche Abschnitte, bei denen die gleichmäßigen Schnitte über die Grenze kämen: trotzdem k Teile ≤ Grenze
    const u = planExportParts([cost('A1', 10), cost('A2', 95), cost('A3', 95), cost('A4', 10)], 100);
    expect(u.parts.length).toBe(4);
    expect(u.parts.every((x) => x.bytes <= 100)).toBe(true);
  });
  it('ein Abschnitt über der Grenze: eigener Teil, in tooBig genannt', () => {
    const p = planExportParts([cost('A1', 10), cost('A2', 500), cost('A3', 10)], 100);
    expect(p.tooBig).toEqual(['A2']);
    expect(p.parts.map((x) => x.ids)).toEqual([['A1'], ['A2'], ['A3']]);
    const single = planExportParts([cost('A1', 500)], 100);
    expect(single).toMatchObject({ fitsSingle: false, tooBig: ['A1'] });
    expect(single.parts.length).toBe(1);
  });
  it('Eigenschaften bei 500 zufälligen Fällen: jeder Abschnitt genau einmal, Reihenfolge, Grenze, nie mehr Teile als gierig', () => {
    let seed = 987;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let it = 0; it < 500; it++) {
      const n = 1 + Math.floor(rnd() * 40);
      const costs = Array.from({ length: n }, (_, i) => cost(`S${i}`, 1 + Math.floor(rnd() * 1000)));
      const budget = 200 + Math.floor(rnd() * 3000);
      const p = planExportParts(costs, budget);
      expect(p.parts.flatMap((x) => x.ids)).toEqual(costs.map((c) => c.id));
      expect(p.totalBytes).toBe(costs.reduce((a, c) => a + c.bytes, 0));
      expect(p.parts.reduce((a, x) => a + x.bytes, 0)).toBe(p.totalBytes);
      p.parts.forEach((x, i) => {
        expect(x.index).toBe(i);
        expect(x.ids.length).toBeGreaterThan(0);
        // über der Grenze nur, wenn der Teil aus genau einem zu großen Abschnitt besteht
        if (x.bytes > budget) {
          expect(x.ids.length).toBe(1);
          expect(p.tooBig).toContain(x.ids[0]);
        }
      });
      // gierige Mindestanzahl
      let greedy = 0;
      let sum = 0;
      let open = false;
      for (const c of costs) {
        if (open && sum + c.bytes > budget) {
          greedy++;
          sum = 0;
          open = false;
        }
        sum += c.bytes;
        open = true;
      }
      if (open) greedy++;
      expect(p.parts.length).toBe(greedy);
      expect(p.fitsSingle).toBe(p.totalBytes <= budget);
    }
  });
});

// ================================================================ Seitenplan und Teile am echten PDF
const JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAAEAAYDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJACY5//2Q==';

describe('Seitenplan aus der Vorabmessung und Export in Teilen (echtes PDF)', () => {
  // Porträt 240 × 300 mm, 5-mm-Steine, Abschnitte 90 mm → 3 × 4 = 12 Abschnitte
  const settings = { ...DEFAULT_SETTINGS, widthMm: 240, heightMm: 300, tileW: 5, tileH: 5, joint: 1, sectionWmm: 90, sectionHmm: 90, reservePct: 10 };
  const layout = computeLayout({ widthMm: 240, heightMm: 300, tileW: 5, tileH: 5, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
  const res = computeMosaic(prepareFor(loadPng('public/samples/portrait.png'), layout), { layout, shapes: DEFAULT_SHAPES, paletteMode: 'auto', colorCount: 16, dither: 0, deltaE: '2000', regions: [] });
  const sections = computeSections(layout, settings.sectionWmm, settings.sectionHmm);
  const stats = computeStats(layout, res.data, res.palette, [], { reservePct: 10, groutDepthMm: 3 });
  // Bildmaße wie in der App: Vorschau 2400 px lange Seite, Foto 1800 px
  const preview = { w: 1920, h: 2400 };
  const original = { w: 1200, h: 1800 };
  const base: Omit<PdfInput, 'preview' | 'original'> = { projectName: 'Teile', dateStr: '10.11.2026', layout, data: res.data, palette: res.palette, materials: [], settings, sections, t: makeT('de'), locale: 'de' };
  const real: PdfInput = { ...base, preview: { dataUrl: JPEG, ...preview }, original: { dataUrl: JPEG, ...original } };
  /** wie der Worker-Auftrag 'pdfPlan': von den Bildern nur die Maße */
  const dry = (withOriginal = true): PdfInput => ({ ...base, preview: { dataUrl: '', ...preview }, original: withOriginal ? { dataUrl: '', ...original } : undefined });
  const stonesOf = (id: string) => {
    const s = sections.sections.find((x) => x.id === id);
    return s ? computeStats(layout, res.data, res.palette, [], { reservePct: 10, groutDepthMm: 3 }, s).pieces : undefined;
  };

  it('Projekt hat mindestens 6 Abschnitte', () => {
    expect(sections.sections.length).toBeGreaterThanOrEqual(6);
  });

  it('Seitenplan aus der Messung (nur Bildmaße) = Seiten des erzeugten PDFs – Optionen an/aus, Auswahl, ohne Foto', async () => {
    const cases: { name: string; opts: Partial<PdfOptions>; noOriginal?: boolean }[] = [
      { name: 'Standard', opts: {} },
      { name: 'ohne Bilder', opts: { includeImages: false } },
      { name: 'ohne Vorlagen', opts: { includeTemplates: false } },
      { name: 'ohne Koordinaten', opts: { includeCoords: false } },
      { name: 'Koordinaten je Stein', opts: { coordMode: 'perStone', coordLimit: 500 } },
      { name: 'Codeplan immer', opts: { codePlan: 'always', includeCoords: false, includeTemplates: false } },
      { name: 'an Seite anpassen', opts: { sheetScale: 0 } },
      { name: 'A3 quer, 2:1', opts: { format: 'a3', orientation: 'landscape', sheetScale: 2, includeCoords: false } },
      { name: 'Auswahl A1-B2', opts: { sectionIds: ['A1', 'A2', 'B1', 'B2'] } },
      { name: 'Foto ersetzt (kein Originalfoto)', opts: {}, noOriginal: true },
    ];
    for (const c of cases) {
      const opts: PdfOptions = { ...DEFAULT_PDF_OPTIONS, ...c.opts };
      const facts = pdfLayoutFacts(dry(!c.noOriginal), opts);
      const plan = planForSelection(layout, sections, opts, opts.sectionIds, stonesOf, facts, opts.sectionIds);
      const report = await generatePdfReport(c.noOriginal ? { ...real, original: undefined } : real, opts);
      expect(plan.estimated, c.name).toEqual([]);
      expect(plan.total, c.name).toBe(report.pages);
      const b = report.breakdown;
      expect(
        { front: plan.front, sectionPages: plan.sectionPages, sheets: plan.sheets, sheetLegends: plan.sheetLegends, cutLists: plan.cutLists, codePlans: plan.codePlans, templates: plan.templates, coords: plan.coords },
        c.name,
      ).toEqual({ front: b.front, sectionPages: b.sectionCovers + b.sectionSummaries, sheets: b.sheets, sheetLegends: b.sheetLegends, cutLists: b.cutLists, codePlans: b.codePlans, templates: b.templates, coords: b.coords });
    }
  }, 240000);

  it('ohne Messung: Schätzung, deren unsichere Teile genannt sind; Verlegeblätter immer exakt', async () => {
    const opts = DEFAULT_PDF_OPTIONS;
    const rough = planForSelection(layout, sections, opts, null, stonesOf, null);
    const report = await generatePdfReport(real, opts);
    expect(rough.sheets).toBe(report.breakdown.sheets);
    expect(rough.estimated).toContain('templates');
    expect(rough.estimated).toContain('cutLists');
    expect(rough.estimated).not.toContain('sheets' as never);
  }, 120000);

  it('Export in Teilen: nur eigene Abschnitte, Steine je Farbe über alle Teile = Statistik, Blattnummern wie in einer Datei', async () => {
    const opts: PdfOptions = { ...DEFAULT_PDF_OPTIONS, includeImages: false };
    const facts = pdfLayoutFacts(dry(), opts);
    const costs = sectionCosts(layout, sections, opts, stonesOf, facts);
    expect(costs.map((c) => c.id)).toEqual(sections.sections.map((s) => s.id));
    expect(costs.reduce((a, c) => a + c.stones, 0)).toBe(stats.pieces);
    // Grenze so, dass etwa 4 Teile entstehen
    const total = costs.reduce((a, c) => a + c.bytes, 0);
    const parts = planExportParts(costs, Math.ceil(total / 3.5));
    expect(parts.parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.tooBig).toEqual([]);
    expect(parts.parts.flatMap((p) => p.ids)).toEqual(sections.sections.map((s) => s.id));

    const single = await generatePdfReport(real, opts);
    const singleIds = sheetIds(sheetStreams(single.pdf));
    const fills = new Map<string, number>();
    const seen = new Set<string>();
    for (const part of parts.parts) {
      const o: PdfOptions = { ...opts, sectionIds: part.ids };
      const rep = await generatePdfReport(real, o);
      const streams = sheetStreams(rep.pdf);
      const ids = sheetIds(streams);
      expect(ids.size).toBeGreaterThan(0);
      // nur Blätter der eigenen Abschnitte
      for (const id of ids) {
        expect(part.ids).toContain(id.split('-')[0]);
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
      for (const s of streams) for (const [k, v] of countFills(s)) fills.set(k, (fills.get(k) ?? 0) + v);
      // Seitenplan des Teils aus der EINEN Messung: Abschnitts- und Blattseiten exakt, Rest als Schätzung genannt
      const plan = planForSelection(layout, sections, o, part.ids, stonesOf, facts, null);
      const b = rep.breakdown;
      expect({ sectionPages: plan.sectionPages, sheets: plan.sheets, sheetLegends: plan.sheetLegends, cutLists: plan.cutLists, codePlans: plan.codePlans }).toEqual({
        sectionPages: b.sectionCovers + b.sectionSummaries,
        sheets: b.sheets,
        sheetLegends: b.sheetLegends,
        cutLists: b.cutLists,
        codePlans: b.codePlans,
      });
      expect(plan.estimated).toEqual(expect.arrayContaining(['front', 'templates', 'coords']));
      // die geschätzten Teile liegen nah am echten PDF (alles „ca.“)
      expect(Math.abs(plan.total - rep.pages)).toBeLessThanOrEqual(Math.max(3, Math.round(rep.pages * 0.15)));
    }
    // Blattnummern: zusammen genau die des Exports als eine Datei
    expect([...seen].sort()).toEqual([...singleIds].sort());
    // Steine je Farbe über alle Teile = Statistik
    const expected = new Map<string, number>();
    res.palette.forEach((p, i) => {
      const k = fmtColor(p.hex);
      expected.set(k, (expected.get(k) ?? 0) + stats.perColor[i].pieces);
    });
    let sum = 0;
    for (const v of fills.values()) sum += v;
    expect(sum).toBe(stats.pieces);
    for (const [k, v] of expected) expect(fills.get(k) ?? 0, k).toBe(v);
  }, 240000);
});

// ================================================================ Dateinamen
describe('exportFileName', () => {
  it('ganzes Projekt, Auswahl, Teile', () => {
    expect(exportFileName('Mein_Mosaik')).toBe('Mein_Mosaik_verlegeplan.pdf');
    expect(exportFileName('M', { range: null })).toBe('M_verlegeplan.pdf');
    expect(exportFileName('M', { range: 'B2' })).toBe('M_verlegeplan_B2.pdf');
    expect(exportFileName('M', { range: 'A1-B2, D7' })).toBe('M_verlegeplan_A1-B2_D7.pdf');
    expect(exportFileName('M', { range: 'A1-B4', part: { index: 1, total: 12, word: 'Teil', ofWord: 'von' } })).toBe('M_verlegeplan_Teil-02-von-12_A1-B4.pdf');
    expect(exportFileName('M', { range: 'A1-B4', part: { index: 0, total: 3, word: 'part', ofWord: 'of' } })).toBe('M_verlegeplan_part-1-of-3_A1-B4.pdf');
  });
  it('lange Auswahlen als Anzahl', () => {
    const long = Array.from({ length: 12 }, (_, i) => `A${i * 2 + 1}`).join(', ');
    expect(exportFileName('M', { range: long, count: 12 })).toBe('M_verlegeplan_12x.pdf');
  });
});

// ================================================================ Vermerk „Export läuft“, gespeicherte Grenze
describe('Vermerk „PDF-Export läuft“', () => {
  const info: InFlightInfo = { projectId: 'p1', projectName: 'Porträt', sections: 4, stones: 5600, bytes: 11_000_000, budgetBytes: 150_000_000, part: { index: 1, total: 3 }, at: 1_700_000_000_000 };

  it('setzen, lesen, löschen', () => {
    const st = new FakeStore();
    expect(readInFlight(st)).toBeNull();
    markInFlight(st, info);
    expect(st.getItem(PDF_INFLIGHT_KEY)).toBeTruthy();
    expect(readInFlight(st)).toEqual(info);
    clearInFlight(st);
    expect(st.getItem(PDF_INFLIGHT_KEY)).toBeNull();
    expect(readInFlight(st)).toBeNull();
  });
  it('unlesbarer oder unvollständiger Vermerk: null und entfernt', () => {
    const st = new FakeStore();
    for (const raw of ['{kaputt', '"text"', 'null', '{}', JSON.stringify({ projectId: 5, bytes: 1, budgetBytes: 1, at: 1 }), JSON.stringify({ projectId: 'p', bytes: -1, budgetBytes: 1, at: 1 })]) {
      st.setItem(PDF_INFLIGHT_KEY, raw);
      expect(readInFlight(st), raw).toBeNull();
    }
    st.setItem(PDF_INFLIGHT_KEY, '{}');
    readInFlight(st);
    expect(st.getItem(PDF_INFLIGHT_KEY)).toBeNull();
    // fehlende Zusatzangaben werden ergänzt
    st.setItem(PDF_INFLIGHT_KEY, JSON.stringify({ projectId: 'p', bytes: 5, budgetBytes: 9, at: 1 }));
    expect(readInFlight(st)).toEqual({ projectId: 'p', projectName: '', sections: 0, stones: 0, bytes: 5, budgetBytes: 9, part: undefined, at: 1 });
  });
  it('gesperrter Speicher: keine Ausnahme (nur Komfort)', () => {
    const broken: KeyStore = {
      getItem() {
        throw new Error('gesperrt');
      },
      setItem() {
        throw new Error('voll');
      },
      removeItem() {
        throw new Error('gesperrt');
      },
    };
    expect(() => markInFlight(broken, info)).not.toThrow();
    expect(() => clearInFlight(broken)).not.toThrow();
    expect(readInFlight(broken)).toBeNull();
    expect(readBudgetOverride(broken)).toBeNull();
    expect(() => writeBudgetOverride(broken, 5)).not.toThrow();
    expect(() => markInFlight(null, info)).not.toThrow();
    expect(readInFlight(undefined)).toBeNull();
  });
  it('gespeicherte Speichergrenze: schreiben, lesen, zurücksetzen; ungültige Werte zählen nicht', () => {
    const st = new FakeStore();
    expect(readBudgetOverride(st)).toBeNull();
    writeBudgetOverride(st, 42.129);
    expect(st.getItem(PDF_BUDGET_KEY)).toBe('42.13');
    expect(readBudgetOverride(st)).toBe(42.13);
    writeBudgetOverride(st, null);
    expect(readBudgetOverride(st)).toBeNull();
    for (const raw of ['', 'abc', '0', '-3']) {
      st.setItem(PDF_BUDGET_KEY, raw);
      expect(readBudgetOverride(st), raw).toBeNull();
    }
  });
});

describe('Abschnitt ohne Steine', () => {
  it('kostet ohne Koordinaten nichts', () => {
    const { layout, G } = sectionGrid(1, 1);
    const c = sectionCosts(layout, G, { ...DEFAULT_PDF_OPTIONS, includeCoords: false }, () => 0)[0];
    expect(c).toMatchObject({ stones: 0, bytes: 0 });
  });
});
