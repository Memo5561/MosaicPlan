/**
 * Vollständige Stein-Koordinatenliste als CSV (Semikolon-getrennt, für Excel/LibreOffice).
 *
 * Paket w6-plan-exports – gestreamt statt als ein einziger Text:
 *  - buildCsvChunks() liefert die Kopfzeile und danach Bänder von etwa CSV_BAND_ROWS Zeilen. Zusammengefügt ergeben
 *    sie genau buildCsv(); so entsteht nie ein Text über der Höchstlänge von JavaScript-Zeichenketten (bei etwa
 *    5 Mio. Steinen brach der Export früher mit „Invalid string length“ ab). Der Worker (csv.worker.ts) faltet die
 *    Bänder fortlaufend in einen Blob.
 *  - Zuschnitt „ja (T12)“: dieselbe globale Vorlagennummer wie die Schnittvorlagen im PDF (collectTemplates in
 *    pdf.ts – nach Häufigkeit, bei Gleichstand in Leserichtung des ersten Vorkommens). Die Nummerierung zählt immer
 *    das ganze Mosaik, auch beim Export eines einzelnen Abschnitts.
 *  - Abschnittsexporte laufen nur über die Zellen der gewählten Abschnitte (in derselben Reihenfolge wie bisher:
 *    zeilenweise über das ganze Mosaik).
 *  - Ein Farbindex außerhalb der Palette bricht mit CsvPaletteError ab, statt Steine mit falscher oder leerer
 *    Farbe auszugeben.
 *  - Teile ohne Fläche (analyzeCut: invalid) sind keine Steine und erscheinen nicht – wie in Statistik und PDF;
 *    die Zahl der Datenzeilen ist damit genau computeStats(...).pieces des exportierten Bereichs.
 */
import type { ColorNameLang } from './color';
import { paletteDisplayName } from './colorNames';
import { bbox, type Pt } from './geometry';
import { maxColorIndex } from './integrity';
import { colDigits, rowLabel, type Layout, type Section, type SectionGrid } from './layout';
import { cellPieces, type CutInfo } from './pieces';
import { CutCache, makeRawSizeFn, pieceCutInfo } from './stats';
import { CellKind, type Material, type MosaicData, type PaletteColor } from './types';

export const CSV_HEADER =
  'Position;Abschnitt;Zeile;Spalte;Teil;X_mm;Y_mm;Breite_mm;Hoehe_mm;Flaeche_mm2;Farbcode;Farbname;HEX;Form;Zuschnitt;Rohstein_mm;Verlegt;Kontur_mm';
/** Zeilen je Band von buildCsvChunks (je Band ein Text von wenigen MB) */
export const CSV_BAND_ROWS = 20_000;
/** Excel und LibreOffice Calc: höchstens so viele Zeilen je Tabellenblatt – einschließlich der Kopfzeile. */
export const SPREADSHEET_MAX_ROWS = 1_048_576;

/** Farbindex des Rasters außerhalb der Palette: Raster und Palette passen nicht zusammen – nichts exportieren. */
export class CsvPaletteError extends Error {
  readonly code = 'csv-palette-index';
  constructor(
    readonly maxIndex: number,
    readonly paletteSize: number,
  ) {
    super(`Farbindex ${maxIndex} außerhalb der Palette (${paletteSize} Farben)`);
    this.name = 'CsvPaletteError';
  }
}

/** Vorbereitung (erster Durchlauf): Vorlagennummern des ganzen Mosaiks und exakte Zeilenzahl des Exports. */
export interface CsvPrep {
  /** Datenzeilen (Steine) im Export, ohne Kopfzeile */
  rows: number;
  /** Schnittsignatur → globale Vorlagennummer (wie collectTemplates: T1 = häufigste Form) */
  tplNo: Map<string, number>;
  cache: CutCache;
  /** Schnittanalyse ganzer Steine (Zeile, Spalte, Farbe) – dieselben Objekte wie pieceCutInfo */
  fullCut: (row: number, col: number, color: number) => CutInfo;
}

export interface CsvChunkOptions {
  /** Zeilen je Band (Standard CSV_BAND_ROWS) */
  bandRows?: number;
  /** schon berechnete Vorbereitung (prepareCsv) wiederverwenden */
  prep?: CsvPrep;
  /** nach jedem Band: geschriebene Datenzeilen */
  onRows?: (done: number) => void;
}

/** Klasse je Wert (gleiche Spaltenbreite bzw. Zeilenhöhe → gleiche Klasse) */
function classesOf(v: ArrayLike<number>): { cls: Int32Array; n: number } {
  const m = new Map<number, number>();
  const cls = new Int32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    let k = m.get(v[i]);
    if (k === undefined) m.set(v[i], (k = m.size));
    cls[i] = k;
  }
  return { cls, n: m.size };
}

/**
 * Schnittanalyse ganzer Steine (CellKind.FULL) ohne Polygon und Schlüsseltext je Zelle: je (Spaltenbreite,
 * Zeilenhöhe, Farbe) einmal über pieceCutInfo – also genau das CutInfo-Objekt, das pieceCutInfo liefert.
 */
function makeFullCut(layout: Layout, data: MosaicData, cache: CutCache, raw: (c: number) => { w: number; h: number }, colors: number) {
  const cw = classesOf(layout.colW);
  const rh = classesOf(layout.rowH);
  const nc = Math.max(1, colors);
  const memo = cw.n * rh.n * nc <= 4_000_000 ? new Array<CutInfo | undefined>(cw.n * rh.n * nc) : null;
  return (row: number, col: number, color: number): CutInfo => {
    const k = (rh.cls[row] * cw.n + cw.cls[col]) * nc + color;
    let ci = memo ? memo[k] : undefined;
    if (!ci) {
      ci = pieceCutInfo(cache, layout, data, row, col, 0, cellPieces(layout, data, row, col)[0].poly, raw(color));
      if (memo) memo[k] = ci;
    }
    return ci;
  };
}

/** Gewählte Abschnitte je Abschnittszeile, nach Spalte sortiert (null = alle). */
function selectedBySectionRow(sections: SectionGrid, sectionIds: string[] | null): Section[][] {
  const sel = sectionIds ? new Set(sectionIds) : null;
  const out: Section[][] = Array.from({ length: sections.srows }, () => []);
  for (const s of sections.sections) if (!sel || sel.has(s.id)) out[s.sr].push(s);
  for (const r of out) r.sort((a, b) => a.sc - b.sc);
  return out;
}

/**
 * Erster Durchlauf: prüft die Farbindizes, nummeriert die Schnittvorlagen über das GANZE Mosaik (genau wie
 * collectTemplates in pdf.ts) und zählt die Steine im Export. `onRow(row)` meldet den Fortschritt je Rasterzeile.
 */
export function prepareCsv(
  layout: Layout,
  data: MosaicData,
  palette: PaletteColor[],
  materials: Material[],
  sections: SectionGrid,
  sectionIds: string[] | null,
  onRow?: (row: number) => void,
): CsvPrep {
  const max = maxColorIndex(data);
  if (max >= palette.length) throw new CsvPaletteError(max, palette.length);
  const raw = makeRawSizeFn(layout, palette, materials);
  const cache = new CutCache();
  // gewählte Zellen: Abschnittszeile je Rasterzeile, Abschnittsspalte je Rasterspalte
  const selRows = selectedBySectionRow(sections, sectionIds);
  const selMask = new Uint8Array(sections.srows * sections.scols);
  selRows.forEach((r) => r.forEach((s) => (selMask[s.sr * sections.scols + s.sc] = 1)));
  const rowSr = new Int32Array(layout.rows);
  const colSc = new Int32Array(layout.cols);
  for (const s of sections.sections) {
    if (s.sc === 0) for (let r = s.r0; r < s.r1; r++) rowSr[r] = s.sr;
    if (s.sr === 0) for (let c = s.c0; c < s.c1; c++) colSc[c] = s.sc;
  }
  const fullCut = makeFullCut(layout, data, cache, raw, palette.length);
  const count = new Map<string, number>();
  let rows = 0;
  for (let row = 0; row < layout.rows; row++) {
    const base = rowSr[row] * sections.scols;
    for (let col = 0; col < layout.cols; col++) {
      const inSel = selMask[base + colSc[col]] === 1;
      const idx = row * layout.cols + col;
      if (data.kind[idx] === CellKind.FULL) {
        const ci = fullCut(row, col, data.c1[idx]);
        if (inSel && !ci.invalid) rows++;
        if (ci.needsCut) count.set(ci.signature, (count.get(ci.signature) ?? 0) + 1);
        continue;
      }
      const ps = cellPieces(layout, data, row, col);
      for (let i = 0; i < ps.length; i++) {
        const ci = pieceCutInfo(cache, layout, data, row, col, i, ps[i].poly, raw(ps[i].color));
        if (inSel && !ci.invalid) rows++;
        if (ci.needsCut) count.set(ci.signature, (count.get(ci.signature) ?? 0) + 1);
      }
    }
    onRow?.(row);
  }
  // T1 … nach Häufigkeit; stabile Sortierung → bei Gleichstand das zuerst (in Leserichtung) gefundene zuerst
  const order = [...count.entries()].sort((a, b) => b[1] - a[1]);
  const tplNo = new Map<string, number>();
  order.forEach(([sig], i) => tplNo.set(sig, i + 1));
  return { rows, tplNo, cache, fullCut };
}

/**
 * CSV in Bändern: zuerst die Kopfzeile, dann je etwa `bandRows` Datenzeilen ein Text (jede Zeile beginnt mit
 * „\r\n“). Zusammengefügt ist das Ergebnis Zeichen für Zeichen buildCsv(). Rückgabewert: Anzahl der Datenzeilen.
 */
export function* buildCsvChunks(
  layout: Layout,
  data: MosaicData,
  palette: PaletteColor[],
  materials: Material[],
  sections: SectionGrid,
  sectionIds: string[] | null,
  decimalComma = true,
  /** Sprache der Farbnamen: automatische Namen (nameKey) folgen ihr, Material- und Benutzernamen bleiben wörtlich */
  lang?: ColorNameLang,
  opts: CsvChunkOptions = {},
): Generator<string, number, void> {
  const prep = opts.prep ?? prepareCsv(layout, data, palette, materials, sections, sectionIds);
  const band = Math.max(1, opts.bandRows ?? CSV_BAND_ROWS);
  const { cache, tplNo, fullCut } = prep;
  const raw = makeRawSizeFn(layout, palette, materials);
  const f = (v: number) => {
    const s = (Math.round(v * 100) / 100).toFixed(2);
    return decimalComma ? s.replace('.', ',') : s;
  };
  const polyStr = (p: Pt[]) => p.map((q) => `${f(q.x)} ${f(q.y)}`).join(' | ');
  // je Farbe gleich: Code, Name (in Anführungszeichen), HEX, Rohsteinmaß
  const colorCols = palette.map((pc) => {
    const name = lang ? paletteDisplayName(pc, lang) : pc.name;
    return `${String(pc.code ?? '').padStart(2, '0')};"${name.replace(/"/g, '""')}";${pc.hex ?? ''}`;
  });
  const rawStr = palette.map((_, c) => {
    const r = raw(c);
    return `${f(r.w)}x${f(r.h)}`;
  });
  // ganze Steine: Koordinaten je Spalte bzw. Zeile nur einmal formatieren (gleiche Rechnung wie rectPoly/bbox)
  const colA = Array.from({ length: layout.cols }, (_, c) => f(layout.colX[c]));
  const colB = Array.from({ length: layout.cols }, (_, c) => f(layout.colX[c] + layout.colW[c]));
  const rowA = Array.from({ length: layout.rows }, (_, r) => f(layout.rowY[r]));
  const rowB = Array.from({ length: layout.rows }, (_, r) => f(layout.rowY[r] + layout.rowH[r]));
  // Positionsbezeichnung wie cellId: Zeilenbuchstaben + Spaltennummer mit führenden Nullen
  const digits = colDigits(layout.cols);
  const colLbl = Array.from({ length: layout.cols }, (_, c) => String(c + 1).padStart(digits, '0'));
  const colNo = Array.from({ length: layout.cols }, (_, c) => String(c + 1));
  const cutStr = (needsCut: boolean, sig: string) => {
    if (!needsCut) return 'nein';
    const no = tplNo.get(sig);
    return no ? `ja (T${no})` : 'ja';
  };
  /** ganze Steine teilen sich wenige CutInfo-Objekte: deren Spalten nur einmal formatieren */
  const fullMemo = new Map<CutInfo, [string, string]>();

  yield CSV_HEADER;
  let out: string[] = [];
  let done = 0;
  const selRows = selectedBySectionRow(sections, sectionIds);
  for (let sr = 0; sr < selRows.length; sr++) {
    const secs = selRows[sr];
    if (!secs.length) continue;
    const { r0, r1 } = secs[0];
    for (let row = r0; row < r1; row++) {
      const rowNo = row + 1;
      const rowLbl = rowLabel(row);
      for (const sec of secs) {
        for (let col = sec.c0; col < sec.c1; col++) {
          const idx = row * layout.cols + col;
          if (data.kind[idx] === CellKind.FULL) {
            // schneller Weg, Ergebnis identisch zu cellPieces + bbox + polyStr
            const c = data.c1[idx];
            const ci = fullCut(row, col, c);
            if (ci.invalid) continue;
            let m = fullMemo.get(ci);
            if (!m) fullMemo.set(ci, (m = [`${f(ci.w)};${f(ci.h)};${f(ci.area)}`, `${ci.shape};${cutStr(ci.needsCut, ci.signature)}`]));
            const x0 = colA[col];
            const x1 = colB[col];
            const y0 = rowA[row];
            const y1 = rowB[row];
            out.push(
              `${rowLbl}${colLbl[col]};${sec.id};${rowNo};${colNo[col]};1;${x0};${y0};${m[0]};${colorCols[c]};${m[1]};${rawStr[c]};${data.progress[idx] & 1 ? 'ja' : 'nein'};${x0} ${y0} | ${x1} ${y0} | ${x1} ${y1} | ${x0} ${y1}`,
            );
          } else {
            const ps = cellPieces(layout, data, row, col);
            const id0 = rowLbl + colLbl[col];
            for (let i = 0; i < ps.length; i++) {
              const p = ps[i];
              const r = raw(p.color);
              const ci = pieceCutInfo(cache, layout, data, row, col, i, p.poly, r);
              if (ci.invalid) continue;
              const b = bbox(p.poly);
              out.push(
                [
                  id0 + (ps.length > 1 ? `-${i + 1}` : ''),
                  sec.id,
                  rowNo,
                  col + 1,
                  i + 1,
                  f(b.minX),
                  f(b.minY),
                  f(ci.w),
                  f(ci.h),
                  f(ci.area),
                  colorCols[p.color],
                  ci.shape,
                  cutStr(ci.needsCut, ci.signature),
                  rawStr[p.color],
                  (data.progress[idx] >> i) & 1 ? 'ja' : 'nein',
                  polyStr(p.poly),
                ].join(';'),
              );
            }
          }
          if (out.length >= band) {
            done += out.length;
            yield '\r\n' + out.join('\r\n');
            out = [];
            opts.onRows?.(done);
          }
        }
      }
    }
  }
  if (out.length) {
    done += out.length;
    yield '\r\n' + out.join('\r\n');
    opts.onRows?.(done);
  }
  return done;
}

/** Ganze CSV als ein Text (Tests, kleine Projekte) – Zusammenfügung von buildCsvChunks(). */
export function buildCsv(
  layout: Layout,
  data: MosaicData,
  palette: PaletteColor[],
  materials: Material[],
  sections: SectionGrid,
  sectionIds: string[] | null,
  decimalComma = true,
  lang?: ColorNameLang,
): string {
  return [...buildCsvChunks(layout, data, palette, materials, sections, sectionIds, decimalComma, lang)].join('');
}
