/**
 * Nachbesserungen nach dem Review von Welle 1:
 *  1. Eigene Palette während einer Berechnung geändert: nie still überschreiben (resolveComputedPalette).
 *  2. Mindestbreite: gemessene Werte (schmalste Stelle, Inkreismaß) statt falscher „schmaler als“-Texte.
 *  3. Empfehlungen nur für schneidbare Formen.
 *  4. Leere Teile zählen nicht als Steine.
 *  5. PDF: Einkaufsliste je Material (Summe = Materialkosten), Einschnitte in Schnittvorlagen.
 *  6. Einzahl/Mehrzahl in Texten mit Anzahl.
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { area, edgeLengths, rectPoly, type Pt } from '../src/core/geometry';
import { cellKindWidth, repairDegenerateCells, setFreePieces } from '../src/core/edits';
import { computeLayout, computeSections } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { DEFAULT_PDF_OPTIONS, generatePdf } from '../src/core/pdf';
import {
  analyzeCut,
  anyLineSplitCuttable,
  cellRect,
  cutLineItems,
  diagA,
  diagB,
  lineSplit,
  maxAllowedMinWidth,
  pieceCuttable,
  pieceWidthCheck,
  subdivisionCuttable,
} from '../src/core/pieces';
import { computeStats, progressOf } from '../src/core/stats';
import { CellKind, createEmptyMosaic, DEFAULT_SETTINGS, DEFAULT_SHAPES, Rec, type Material, type PaletteColor } from '../src/core/types';
import { dictionaries, makeT, numberFormatter, tCount } from '../src/i18n';
import { keepStoredComputeFields, mergeComputeFields, paletteExtends, PALETTE_CHANGED, resolveComputedPalette, type ComputeFields, type ProjectRecord } from '../src/storage/db';
import { widthFailText } from '../src/ui/project/StoneDialog';
import { loadPng, prepareFor } from './helpers';

const t = makeT('de');
const n = numberFormatter('de');

function pc(code: number, hex: string, name = `Farbe ${code}`): PaletteColor {
  return { code, hex, name, lab: hexToLab(hex) };
}

function rec(palette: PaletteColor[], mode: 'custom' | 'auto' = 'custom', computedWith?: string): ProjectRecord {
  return {
    meta: { id: 'p', name: 'P', createdAt: 0, updatedAt: 0, computed: true },
    settings: { ...DEFAULT_SETTINGS, paletteMode: mode, shapes: { ...DEFAULT_SHAPES } },
    adjust: { crop: null, rotation: 0, fineRotate: 0, flipH: false } as unknown as ProjectRecord['adjust'],
    regions: [],
    palette,
    ...(computedWith ? { computedWith } : {}),
  } as ProjectRecord;
}

// ================================================================ 1. Eigene Palette während der Berechnung
describe('Eigene Palette: Änderungen während der Berechnung gehen nicht verloren', () => {
  const input = [pc(1, '#FFFFFF'), pc(2, '#000000'), pc(4, '#FF0000')];
  const fields = (extra: Partial<ComputeFields> = {}): ComputeFields => ({
    palette: input.map((p) => ({ ...p })),
    computedWith: '{"pm":"custom"}',
    mosaicRev: 'r2',
    updatedAt: 1,
    customInput: input,
    ...extra,
  });

  it('unverändert: Ergebnispalette wird übernommen', () => {
    const r = resolveComputedPalette(input, fields());
    expect(r).toEqual({ palette: fields().palette, kept: false });
  });

  it('Farbe angehängt (z. B. „+ Farbe hinzufügen“ während der Berechnung): Palette des Benutzers bleibt', () => {
    const mine = [...input, pc(5, '#3366CC')];
    const r = resolveComputedPalette(mine, fields());
    expect(r?.kept).toBe(true);
    expect(r?.palette.map((p) => p.hex)).toEqual(['#FFFFFF', '#000000', '#FF0000', '#3366CC']);
    const merged = mergeComputeFields(rec(mine), fields());
    expect(merged.palette).toHaveLength(4);
    // berechnet wurde mit 3 Farben → der Schlüssel stammt aus der Momentaufnahme (→ „Einstellungen geändert“)
    expect(merged.computedWith).toBe('{"pm":"custom"}');
  });

  it('Farbe an Ort und Stelle umgefärbt/umbenannt: bleibt', () => {
    const mine = input.map((p, i) => (i === 1 ? { ...p, hex: '#222222', lab: hexToLab('#222222'), name: 'Anthrazit' } : p));
    expect(resolveComputedPalette(mine, fields())?.palette[1].hex).toBe('#222222');
  });

  it('Farbe entfernt oder umsortiert: Ergebnis wird abgelehnt (Indizes zeigten auf falsche Farben)', () => {
    expect(resolveComputedPalette([input[0], input[2]], fields())).toBeNull();
    expect(resolveComputedPalette([input[1], input[0], input[2]], fields())).toBeNull();
    expect(() => mergeComputeFields(rec([input[0], input[2]]), fields())).toThrow(PALETTE_CHANGED);
  });

  it('automatische Palette: Ergebnis ersetzt immer (die Berechnung bestimmt die Palette)', () => {
    const r = resolveComputedPalette([pc(1, '#123456')], fields({ customInput: undefined }));
    expect(r?.palette).toEqual(fields().palette);
  });

  it('anderswo neu berechnet: hier bearbeitete, passende eigene Palette bleibt; sonst die gespeicherte', () => {
    const stored = rec(input, 'custom', '{"pm":"custom"}');
    const mine = rec([...input, pc(5, '#3366CC')]);
    expect(keepStoredComputeFields(mine, stored, { paletteEdited: true }).palette).toHaveLength(4);
    // nicht bearbeitet → gespeicherte Palette (sonst würde eine ältere Palette eine neuere überschreiben)
    expect(keepStoredComputeFields(mine, stored).palette).toHaveLength(3);
    // gespeichertes Raster automatisch berechnet → Indizes gehören zu dessen Palette
    expect(keepStoredComputeFields(mine, rec(input, 'auto', '{"pm":"auto"}'), { paletteEdited: true }).palette).toHaveLength(3);
    // verkürzt → gespeicherte Palette
    expect(keepStoredComputeFields(rec([input[0]]), stored, { paletteEdited: true }).palette).toHaveLength(3);
    expect(paletteExtends([...input, pc(5, '#3366CC')], input)).toBe(true);
    expect(paletteExtends([input[0], input[2]], input)).toBe(false);
  });
});

// ================================================================ 2. Mindestbreite: ehrliche Werte
describe('Mindestbreite: gemessene Werte statt falscher „schmaler als“-Texte', () => {
  const tri = (w: number, g: number) => diagA({ x: 0, y: 0, w, h: w }, g)[0];

  it('5 × 5 mm, 1 mm Fuge: schmalste Stelle 3,04 mm, Inkreismaß 2,51 mm – bei 2,6 scheitert das Inkreismaß', () => {
    const w = pieceWidthCheck(tri(5, 1), 2.6);
    expect(w.caliper).toBeCloseTo(3.036, 2);
    expect(w.incircle).toBeCloseTo(2.515, 2);
    expect(w.ok).toBe(false);
    expect(w.failed).toBe('incircle');
    const txt = widthFailText(w, 2.6, t, n);
    expect(txt).toContain('2,51');
    expect(txt).toContain('3,04');
    expect(txt).toMatch(/^Inkreismaß/);
    expect(txt).not.toMatch(/schmaler/);
  });

  it('4 × 4 mm, 1 mm Fuge (Standard 2 mm): abgelehnt wegen Inkreismaß 1,93 mm, möglich bis 1,9 mm', () => {
    const w = pieceWidthCheck(tri(4, 1), 2);
    expect(w.failed).toBe('incircle');
    expect(w.caliper).toBeGreaterThan(2);
    const max = maxAllowedMinWidth([...diagA({ x: 0, y: 0, w: 4, h: 4 }, 1), ...diagB({ x: 0, y: 0, w: 4, h: 4 }, 1)]);
    expect(max).toBe(1.9);
    expect(pieceCuttable(tri(4, 1), 1.9)).toBe(true);
    expect(pieceCuttable(tri(4, 1), 2)).toBe(false);
  });

  it('schmaler Streifen: schmalste Stelle scheitert zuerst', () => {
    const w = pieceWidthCheck(rectPoly(0, 0, 1, 5), 1.5);
    expect(w.failed).toBe('caliper');
    expect(widthFailText(w, 1.5, t, n)).toMatch(/^schmalste Stelle 1 mm < 1,5 mm/);
  });

  it('pieceCuttable entscheidet genau wie bisher (beide Bedingungen, gleiche Toleranzen)', () => {
    const old = (poly: Pt[], min: number) => {
      if (poly.length < 3) return false;
      const A = area(poly);
      const P = edgeLengths(poly).reduce((s, v) => s + v, 0);
      if (P <= 0) return false;
      if (!((2 * A) / P >= min / 2 - 1e-9)) return false;
      return pieceWidthCheck(poly, 0).caliper >= min - 1e-6;
    };
    for (const w of [2, 3, 4, 5, 6, 8]) for (const g of [0, 0.5, 1, 1.5, 2]) for (const min of [1, 1.5, 2, 2.5, 3]) {
      for (const p of [...diagA({ x: 0, y: 0, w, h: w * 1.25 }, g), ...lineSplit({ x: 0, y: 0, w, h: w }, Math.cos(0.7), Math.sin(0.7), 0.5, g)])
        expect(pieceCuttable(p, min)).toBe(old(p, min));
    }
  });

  it('Kantenschnitte: bei 4 × 4 mm / 1 mm Fuge / 2 mm gibt es keinen zulässigen, bei 5 × 5 mm schon', () => {
    expect(anyLineSplitCuttable({ x: 0, y: 0, w: 4, h: 4 }, 1, 2)).toBe(false);
    expect(anyLineSplitCuttable({ x: 0, y: 0, w: 5, h: 5 }, 1, 2)).toBe(true);
  });

  it('Begründung im Steindetail nennt die Werte des schmalsten Teils', () => {
    const L = computeLayout({ widthMm: 20, heightMm: 20, tileW: 4, tileH: 4, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const w = cellKindWidth(L, 0, 0, { kind: CellKind.DIAG_A }, 2)!;
    expect(widthFailText(w, 2, t, n)).toBe('Inkreismaß 1,93 mm < 2 mm (schmalste Stelle 2,33 mm)');
    expect(cellKindWidth(L, 0, 0, { kind: CellKind.FULL }, 2)).toBeNull();
  });
});

// ================================================================ 3. Empfehlungen
describe('Empfehlungen („sinnvoll, aber deaktiviert“) nur für Formen, die auch zulässig wären', () => {
  const layout = computeLayout({ widthMm: 160, heightMm: 200, tileW: 4, tileH: 4, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
  const img = prepareFor(loadPng('public/samples/portrait.png'), layout);
  const run = (patch: Partial<typeof DEFAULT_SHAPES>) =>
    computeMosaic(img, { layout, shapes: { ...DEFAULT_SHAPES, minPieceMm: 2, ...patch }, paletteMode: 'auto', colorCount: 16, dither: 0, deltaE: '2000', regions: [], seed: 7 });

  it('4 × 4 mm, 1 mm Fuge, Mindestbreite 2 mm: keine Empfehlung „feinere Steine“ (Teilsteine 1,5 mm wären zu schmal)', () => {
    const res = run({ subdivide: true, autoDetail: false });
    let finer = 0;
    for (let i = 0; i < res.data.rec.length; i++) if (res.data.rec[i] & Rec.FINER) finer++;
    expect(finer).toBe(0);
    for (let r = 0; r < layout.rows; r++)
      for (let c = 0; c < layout.cols; c++) if (res.data.rec[r * layout.cols + c] & Rec.FINER) expect(subdivisionCuttable(cellRect(layout, r, c), 2, 1, 2)).toBe(true);
  });

  it('ohne Diagonale/Kantenschnitt: Kantenschnitt-Empfehlung nur, wo eine zulässige Teilung existiert', () => {
    const res = run({ diagonal: false, line: false, subdivide: false });
    for (let r = 0; r < layout.rows; r++)
      for (let c = 0; c < layout.cols; c++) {
        if (!(res.data.rec[r * layout.cols + c] & Rec.EDGE_CUT)) continue;
        const cr = cellRect(layout, r, c);
        const diagOk = [diagA(cr, 1), diagB(cr, 1)].some((ps) => ps.every((p) => pieceCuttable(p, 2)));
        expect(diagOk || anyLineSplitCuttable(cr, 1, 2)).toBe(true);
      }
    // Gegenprobe mit 1,5 mm: Empfehlungen gibt es (die Bedingung ist nicht einfach „nie empfehlen“)
    const loose = run({ diagonal: false, line: false, subdivide: false, minPieceMm: 1.5 });
    expect([...loose.data.rec].some((v) => v & Rec.EDGE_CUT)).toBe(true);
  });
});

// ================================================================ 4. Leere Teile
describe('Leere Teile (Fuge breiter als der Stein) sind keine Steine', () => {
  it('4 × 4 Raster aus 2-mm-Steinen mit 3 mm Fuge, eine alte Dreieckszelle: 15 Steine, 2 ungültige Teile', () => {
    const layout = computeLayout({ widthMm: 17, heightMm: 17, tileW: 2, tileH: 2, joint: 3, edgeMode: 'whole', minCutMm: 2 });
    expect(layout.cols * layout.rows).toBe(16);
    const d = createEmptyMosaic(layout.cols, layout.rows);
    d.kind[5] = CellKind.DIAG_A;
    const pal = [pc(1, '#FFFFFF')];
    const st = computeStats(layout, d, pal, [], { reservePct: 0, groutDepthMm: 3 });
    expect(st.invalidPieces).toBe(2);
    expect(st.pieces).toBe(15);
    expect(st.rawTotal).toBe(15);
    expect(st.notFitting).toBe(0);
    expect(st.perShape.custom).toBe(0);
    expect(st.perSize.some((s) => s.w === 0 && s.h === 0)).toBe(false);
    expect(st.perColor[0].pieces).toBe(15);
    // nach der Reparatur (beim Laden) stimmen auch Fortschritt und Zellteile überein
    expect(repairDegenerateCells(layout, d)).toBe(1);
    const st2 = computeStats(layout, d, pal, [], { reservePct: 0, groutDepthMm: 3 });
    expect(st2.invalidPieces).toBe(0);
    expect(st2.pieces).toBe(16);
    expect(progressOf(layout, d).total).toBe(16);
  });
});

// ================================================================ 5. PDF
function pdfText(buf: ArrayBuffer): string {
  const s = Buffer.from(buf).toString('latin1');
  const out: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) break;
    const raw = Buffer.from(s.slice(start, end).replace(/\r?\n$/, ''), 'latin1');
    try {
      out.push(inflateSync(raw).toString('latin1'));
    } catch {
      out.push(raw.toString('latin1'));
    }
    re.lastIndex = end + 9;
  }
  // Texte mit Zeichen außerhalb von WinAnsi (z. B. „→“) schreibt jsPDF als UTF-16 – Nullbytes entfernen
  return out.join('\n').replace(/\u0000/g, '');
}

describe('PDF: Einkaufsliste je Material und Einschnitte', () => {
  const settings = { ...DEFAULT_SETTINGS, sectionWmm: 200, sectionHmm: 200, reservePct: 0 };

  it('zwei Farben teilen ein Material: eine Einkaufszeile, Kosten-Summe = Materialkosten, keine Packungen je Farbe', async () => {
    const layout = computeLayout({ widthMm: 47, heightMm: 23, tileW: 5, tileH: 5, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const d = createEmptyMosaic(layout.cols, layout.rows);
    for (let i = 0; i < d.c1.length; i++) d.c1[i] = i % 2;
    const mat: Material = {
      id: 'm1',
      type: 'glass',
      manufacturer: 'Testglas',
      product: 'G',
      colorNumber: '17',
      colorName: '',
      hex: '#808080',
      lengthMm: 5,
      widthMm: 5,
      thicknessMm: 4,
      price: 10,
      packageSize: 'Beutel',
      piecesPerPack: 100,
      stock: 5,
    };
    const palette = [{ ...pc(1, '#FFFFFF'), materialId: 'm1' }, { ...pc(2, '#000000'), materialId: 'm1' }];
    const st = computeStats(layout, d, palette, [mat], { reservePct: 0, groutDepthMm: 3 });
    expect(st.perMaterial).toHaveLength(1);
    expect(st.perMaterial[0].need).toBe(layout.cols * layout.rows);
    expect(st.perMaterial[0].toBuy).toBe(layout.cols * layout.rows - 5);
    expect(st.totalCost).toBe(10);
    const pdf = await generatePdf(
      { projectName: 'T', dateStr: '08.11.2026', layout, data: d, palette, materials: [mat], settings, sections: computeSections(layout, 200, 200), t, locale: 'de' },
      { ...DEFAULT_PDF_OPTIONS, includeImages: false, includeCoords: false, includeTemplates: false },
    );
    const txt = pdfText(pdf);
    expect(txt).toContain('Einkaufsliste je Material');
    // genau eine Packungsangabe (je Material), nicht eine je Farbe
    expect(txt.match(/\(1 × Beutel/g) ?? []).toHaveLength(1);
    expect(txt).toContain('(01, 02)');
  }, 60000);

  it('L-förmiges Freiformteil: Einschnitte statt „Schnitt 3/4“, Warnung „nicht konvex“ wird gedruckt', async () => {
    const layout = computeLayout({ widthMm: 35, heightMm: 35, tileW: 8, tileH: 8, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const d = createEmptyMosaic(layout.cols, layout.rows);
    const L: Pt[] = [
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 3 },
      { x: 3, y: 3 },
      { x: 3, y: 8 },
      { x: 0, y: 8 },
    ];
    const v = setFreePieces(layout, d, 0, 0, [{ poly: L, color: 0 }], 1.5);
    expect(v.ok).toBe(true);
    const ci = analyzeCut(L, 8, 8);
    expect(cutLineItems(ci).map((x) => `${x.kind}${x.no}`)).toEqual(['notch1', 'notch2']);
    const palette = [pc(1, '#C04020')];
    const pdf = await generatePdf(
      { projectName: 'T', dateStr: '08.11.2026', layout, data: d, palette, materials: [], settings, sections: computeSections(layout, 200, 200), t, locale: 'de' },
      { ...DEFAULT_PDF_OPTIONS, includeImages: false, includeCoords: false, includeTemplates: true },
    );
    const txt = pdfText(pdf);
    expect(txt).toContain('Einschnitt 1');
    expect(txt).toContain('Einschnitt 2');
    expect(txt).not.toMatch(/Schnitt [34]:/);
    expect(txt).toMatch(/nicht konvex/);
    // orange gepunktete Linien (#EF6C00 = 0,94 0,42 0)
    expect(txt).toMatch(/0\.94 0\.42 0\.? RG/);
  }, 60000);
});

// ================================================================ 6. Einzahl/Mehrzahl
describe('Texte mit Anzahl: Einzahl für 1', () => {
  it('„1 Stein hat …“, „2 Steine haben …“; Türkisch hat dieselben Schlüssel', () => {
    expect(tCount(t, 'colors.rm.stones', 1, { n: 1 })).toBe('1 Stein hat diese Farbe. Er erhält die Ersatzfarbe:');
    expect(tCount(t, 'colors.rm.stones', 2, { n: 2 })).toBe('2 Steine haben diese Farbe. Sie erhalten die Ersatzfarbe:');
    expect(tCount(t, 'matcsv.help.import', 1, { n: 1 })).toBe('Importieren: 1 neues Material anlegen.');
    expect(tCount(t, 'matcsv.fileInfo', 1, { name: 'a.csv', delim: ';', enc: 'UTF-8', rows: 1 })).toMatch(/1 Datenzeile$/);
    expect(tCount(makeT('en'), 'colors.rm.stones', 1, { n: 1 })).toBe('1 tile has this colour. It will get the replacement colour:');
    for (const k of Object.keys(dictionaries.de).filter((x) => x.endsWith('.one'))) {
      expect((dictionaries.tr as Record<string, string>)[k], k).toBeTruthy();
      expect((dictionaries.de as Record<string, string>)[k.slice(0, -4)], `Grundschlüssel zu ${k}`).toBeTruthy();
    }
  });

  it('Text ohne Einzahl-Variante fällt auf den Grundschlüssel zurück', () => {
    expect(tCount(t, 'colors.usedOf', 1, { used: 1, total: 1 })).toBe('1 von 1 verwendet');
  });
});
