/**
 * Tabellen im PDF-Verlegeplan: reine Layout-Berechnung (ohne jsPDF) und ein schmaler Zeichen-Wrapper,
 * der über eine kleine Zeichenschnittstelle (TableCanvas) zeichnet – dadurch auch ohne PDF testbar.
 *
 * Regeln (Einkaufs-, Legenden- und Koordinatentabellen müssen vollständig lesbar bleiben):
 *  - 'fixed'-Spalten (Codes, HEX, Farbnummern, Zahlen, Ja/Nein) werden nie umbrochen und nie gekürzt:
 *    Breite = breiteste Zelle (bzw. breitestes Wort der Überschrift, die an Leerzeichen umbrechen darf).
 *  - 'text'-Spalten (Namen, Material, Form) teilen sich den Rest (je höchstens `max` mm, Standard 80)
 *    und brechen nur an Leerzeichen oder nach Bindestrichen um.
 *  - 'tokens'-Spalten (Maße „12,5 × 12,5“, CIELAB, Packungen) bleiben einzeilig, solange es geht; erst
 *    wenn die Tabelle sonst nicht passt, brechen sie an Leerzeichen um – nie innerhalb einer Zahl.
 *  - Breiten werden nur verkleinert, nie auf Seitenbreite gestreckt (Platz bleibt frei).
 *  - Reicht die Breite nicht: Schrift 8 → 7 → 6,5 pt, dann 'tokens' umbrechen, dann ausgewählte Spalten
 *    als weitere Zeile unter eine Nachbarspalte legen (`foldInto`, Überschrift ebenfalls darunter).
 *    Erst als allerletzter Ausweg werden überlange Wörter in 'text'-Spalten getrennt; Bezeichner in
 *    'fixed'-Spalten nie. Nichts wird mit „…“ abgekürzt.
 *  - Mehrzeilige Zeilen haben ihre eigene Höhe; der Seitenumbruch rechnet mit genau dieser Höhe, und die
 *    Kopfzeile (ebenfalls umbrechbar) wird auf jeder Folgeseite wiederholt.
 */

export type ColKind = 'fixed' | 'tokens' | 'text' | 'swatch';

export interface ColSpec {
  /** Standard 'fixed' */
  kind?: ColKind;
  /** Mindestbreite in mm (inkl. Innenabstand) */
  min?: number;
  /** Höchstbreite einer 'text'-Spalte in mm (Standard 80) */
  max?: number;
  align?: 'left' | 'right';
  /** Bei Platzmangel als weitere Zeile unter diese Spalte legen (Index der Zielspalte) */
  foldInto?: number;
  /** Reihenfolge beim Unterlegen (kleiner zuerst) */
  foldOrder?: number;
}

export type TableCell = string | { swatch: string };

/** Textbreite in mm bei Schriftgröße 1 pt (Breite bei n pt = n · measure) */
export type Measure = (s: string, bold: boolean) => number;

/** mm je Punkt */
export const PT_MM = 25.4 / 72;
/** Zeilenabstand mehrzeiliger Zellen = Schriftgröße · 1,15 */
export const LINE_FACTOR = 1.15;
export const PAD_L = 1.4;
export const PAD_R = 1;
export const DEFAULT_FONT_SIZES = [8, 7, 6.5];
const TEXT_MAX = 80;
const SWATCH_W = 6;
const SWATCH_MIN = 4;
/** kleinste Inhaltsbreite einer Textspalte im letzten Ausweg (Wörter werden dann getrennt) */
const BREAK_MIN = 6;
const EPS = 1e-6;

export const lineHeight = (fs: number) => fs * LINE_FACTOR * PT_MM;

export interface TableLayout {
  fontSize: number;
  lineH: number;
  /** Breite je Spalte in mm (0 für untergelegte Spalten) */
  widths: number[];
  /** linke Kante je Spalte, relativ zur linken Tabellenkante */
  xs: number[];
  totalW: number;
  /** foldedInto[j] = Zielspalte, unter der Spalte j steht (sonst null) */
  foldedInto: (number | null)[];
  /** je Zielspalte die darunter gelegten Spalten in Reihenfolge */
  foldsOf: number[][];
  tokensWrap: boolean;
  breakWords: boolean;
  /** umbrochene Überschrift je Spalte ([] bei untergelegten Spalten) */
  headerLines: string[][];
  /** Zeilen der Kopfzeile (≥ 1) */
  headerN: number;
  /** true: Selbst im letzten Ausweg breiter als verfügbar (nur bei absurd schmalem Papier) */
  overflow: boolean;
}

interface ColStat {
  /** breiteste Zelle (je Absatz) */
  full: number;
  /** breitestes Wort (an Leerzeichen getrennt) */
  word: number;
  /** breitestes Wortstück (zusätzlich nach Bindestrichen getrennt) */
  seg: number;
  hFull: number;
  hWord: number;
}

const words = (p: string) => p.split(' ').filter((w) => w.length > 0);
const hyphenSegs = (w: string) => w.split(/(?<=-)/).filter((s) => s.length > 0);

function statOf(cells: Iterable<string>, kind: ColKind, measure: Measure, bold: boolean): { full: number; word: number; seg: number } {
  let full = 0;
  let word = 0;
  let seg = 0;
  for (const c of cells) {
    if (!c) continue;
    for (const para of c.split('\n')) {
      const fw = measure(para, bold);
      if (fw > full) full = fw;
      if (kind === 'fixed') continue;
      for (const w of words(para)) {
        const ww = measure(w, bold);
        if (ww > word) word = ww;
        if (kind === 'text') {
          if (w.includes('-')) {
            for (const s of hyphenSegs(w)) {
              const sw = measure(s, bold);
              if (sw > seg) seg = sw;
            }
          } else if (ww > seg) seg = ww;
        }
      }
    }
  }
  return { full, word, seg };
}

/**
 * Bricht einen Zellentext auf die Inhaltsbreite `maxW` (mm) um. Explizite Zeilenumbrüche (\n) bleiben.
 *  - 'fixed' und (ohne tokensWrap) 'tokens': nie umbrochen.
 *  - 'tokens': nur an Leerzeichen.
 *  - 'text': an Leerzeichen, überlange Wörter nach Bindestrichen; mit breakWords zuletzt zeichenweise.
 */
export function wrapCell(
  s: string,
  maxW: number,
  kind: ColKind,
  fs: number,
  bold: boolean,
  measure: Measure,
  opt: { tokensWrap?: boolean; breakWords?: boolean } = {},
): string[] {
  const out: string[] = [];
  const W = (x: string) => measure(x, bold) * fs;
  for (const para of s.split('\n')) {
    if (kind === 'fixed' || kind === 'swatch' || (kind === 'tokens' && !opt.tokensWrap) || W(para) <= maxW + EPS) {
      out.push(para);
      continue;
    }
    const ws = words(para);
    if (!ws.length) {
      out.push('');
      continue;
    }
    let line = '';
    const push = (piece: string, sep: string) => {
      if (!line) {
        line = piece;
        return;
      }
      const cand = line + sep + piece;
      if (W(cand) <= maxW + EPS) line = cand;
      else {
        out.push(line);
        line = piece;
      }
    };
    for (const w of ws) {
      if (W(w) <= maxW + EPS || kind === 'tokens') {
        push(w, ' ');
        continue;
      }
      // 'text': nach Bindestrichen trennen, dann (nur im letzten Ausweg) zeichenweise
      let pieces = hyphenSegs(w);
      if (opt.breakWords) pieces = pieces.flatMap((p) => (W(p) <= maxW + EPS ? [p] : charChunks(p, maxW, W)));
      pieces.forEach((p, i) => push(p, i === 0 ? ' ' : ''));
    }
    if (line) out.push(line);
  }
  return out;
}

function charChunks(s: string, maxW: number, W: (x: string) => number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (cur && W(cur + ch) > maxW + EPS) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Fließtext (Titel, Hinweise, Schlüssel/Wert-Blöcke) an Leerzeichen umbrechen; überlange Wörter notfalls trennen. */
export function wrapWords(s: string, maxW: number, fs: number, bold: boolean, measure: Measure): string[] {
  return wrapCell(s, Math.max(1, maxW), 'text', fs, bold, measure, { breakWords: true });
}

interface Attempt {
  fs: number;
  folds: number;
  tokensWrap: boolean;
  breakWords: boolean;
  /** Textspalten dürfen bis auf ihr längstes Wort schrumpfen (sonst mindestens TEXT_SOFT_MIN, damit Namen nicht Wort für Wort umbrechen) */
  squeeze: boolean;
}

/** Wunschbreite einer Textspalte (Inhalt), bevor Schrift verkleinert oder Spalten untergelegt werden */
const TEXT_SOFT_MIN = 24;

/**
 * Berechnet Schriftgröße, Spaltenbreiten, untergelegte Spalten und die umbrochene Kopfzeile.
 * `avail` = verfügbare Breite in mm.
 */
export function layoutTable(
  cols: ColSpec[],
  header: string[],
  rows: TableCell[][],
  measure: Measure,
  avail: number,
  opts: { fontSizes?: number[] } = {},
): TableLayout {
  const n = cols.length;
  const kinds = cols.map((c) => c.kind ?? 'fixed');
  const stats: ColStat[] = cols.map((_, j) => {
    const cellsOf = function* () {
      for (const r of rows) {
        const c = r[j];
        if (typeof c === 'string') yield c;
      }
    };
    const s = kinds[j] === 'swatch' ? { full: 0, word: 0, seg: 0 } : statOf(cellsOf(), kinds[j], measure, false);
    const h = header[j] ?? '';
    const hs = statOf([h], 'tokens', measure, true);
    return { ...s, hFull: hs.full, hWord: hs.word };
  });
  const sizes = opts.fontSizes?.length ? opts.fontSizes : DEFAULT_FONT_SIZES;
  const fsMin = sizes[sizes.length - 1];
  const foldable = cols
    .map((c, i) => ({ c, i }))
    .filter(({ c, i }) => c.foldInto !== undefined && c.foldInto !== i && c.foldInto >= 0 && c.foldInto < n && kinds[i] !== 'swatch')
    .sort((a, b) => (a.c.foldOrder ?? 0) - (b.c.foldOrder ?? 0) || a.i - b.i)
    .map(({ i }) => i);

  // Reihenfolge der Auswege: kleinere Schrift → 'tokens' umbrechen → Spalten unterlegen → Textspalten bis aufs
  // längste Wort schmaler → (letzter Ausweg) überlange Wörter in Textspalten trennen
  const attempts: Attempt[] = sizes.map((fs) => ({ fs, folds: 0, tokensWrap: false, breakWords: false, squeeze: false }));
  attempts.push({ fs: fsMin, folds: 0, tokensWrap: true, breakWords: false, squeeze: false });
  for (let k = 1; k <= foldable.length; k++) attempts.push({ fs: fsMin, folds: k, tokensWrap: true, breakWords: false, squeeze: false });
  attempts.push({ fs: fsMin, folds: foldable.length, tokensWrap: true, breakWords: false, squeeze: true });
  attempts.push({ fs: fsMin, folds: foldable.length, tokensWrap: true, breakWords: true, squeeze: true });

  const foldMap = (k: number) => {
    const into: (number | null)[] = new Array(n).fill(null);
    for (const j of foldable.slice(0, k)) {
      let tgt = cols[j].foldInto as number;
      while (into[tgt] !== null) tgt = into[tgt] as number;
      if (tgt !== j) into[j] = tgt;
    }
    // Ziele, die selbst untergelegt wurden, auf ihr endgültiges Ziel umhängen
    for (let j = 0; j < n; j++) {
      let tgt = into[j];
      while (tgt !== null && into[tgt] !== null) tgt = into[tgt];
      into[j] = tgt;
    }
    const of: number[][] = Array.from({ length: n }, () => []);
    for (const j of foldable) if (into[j] !== null) of[into[j] as number].push(j);
    return { into, of };
  };

  const pad = PAD_L + PAD_R;
  const sizesFor = (a: Attempt, into: (number | null)[], of: number[][]) => {
    const min = new Array(n).fill(0);
    const natC = new Array(n).fill(0);
    const natH = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (into[i] !== null) continue;
      let cMin = 0;
      let cNat = 0;
      let hMin = 0;
      let hNat = 0;
      for (const j of [i, ...of[i]]) {
        const s = stats[j];
        const k = kinds[j];
        let cm: number;
        let cn: number;
        if (k === 'swatch') {
          cm = SWATCH_MIN;
          cn = SWATCH_W;
        } else if (k === 'fixed') {
          cm = cn = s.full * a.fs;
        } else if (k === 'tokens') {
          cm = (a.tokensWrap ? s.word : s.full) * a.fs;
          cn = s.full * a.fs;
        } else {
          cm = a.breakWords ? Math.min(s.seg * a.fs, BREAK_MIN) : s.seg * a.fs;
          cn = Math.max(cm, Math.min(s.full * a.fs, (cols[j].max ?? TEXT_MAX) - pad));
          if (!a.squeeze) cm = Math.max(cm, Math.min(cn, TEXT_SOFT_MIN));
        }
        const hm = a.breakWords ? Math.min(s.hWord * a.fs, BREAK_MIN) : s.hWord * a.fs;
        cMin = Math.max(cMin, cm);
        cNat = Math.max(cNat, cn);
        hMin = Math.max(hMin, hm);
        hNat = Math.max(hNat, s.hFull * a.fs);
      }
      min[i] = Math.max(cols[i].min ?? 0, cMin + pad, hMin + pad);
      natC[i] = Math.max(min[i], cNat + pad);
      natH[i] = Math.max(natC[i], hNat + pad);
    }
    return { min, natC, natH };
  };

  let chosen: { a: Attempt; into: (number | null)[]; of: number[][]; min: number[]; natC: number[]; natH: number[] } | null = null;
  for (const a of attempts) {
    const { into, of } = foldMap(a.folds);
    const sz = sizesFor(a, into, of);
    const sum = sz.min.reduce((x, y) => x + y, 0);
    if (sum <= avail + EPS) {
      chosen = { a, into, of, ...sz };
      break;
    }
  }
  let overflow = false;
  if (!chosen) {
    const a = attempts[attempts.length - 1];
    const { into, of } = foldMap(a.folds);
    chosen = { a, into, of, ...sizesFor(a, into, of) };
    overflow = true;
  }
  const { a, into, of, min, natC, natH } = chosen;

  // Breiten verteilen: erst einzeilige Spalten (fixed/tokens) auf ihre natürliche Breite, dann Textspalten,
  // zuletzt einzeilige Überschriften. Nie breiter als natürlich (keine Streckung auf Seitenbreite).
  const widths = min.slice();
  let extra = Math.max(0, avail - widths.reduce((x, y) => x + y, 0));
  const allot = (idx: number[], target: number[]) => {
    const def = idx.map((i) => Math.max(0, target[i] - widths[i]));
    const sum = def.reduce((x, y) => x + y, 0);
    if (sum <= EPS || extra <= EPS) return;
    if (sum <= extra) {
      idx.forEach((i, q) => (widths[i] += def[q]));
      extra -= sum;
    } else {
      const f = extra / sum;
      idx.forEach((i, q) => (widths[i] += def[q] * f));
      extra = 0;
    }
  };
  const visible = widths.map((_, i) => i).filter((i) => into[i] === null);
  const isText = (i: number) => [i, ...of[i]].some((j) => kinds[j] === 'text');
  allot(
    visible.filter((i) => !isText(i)),
    natC,
  );
  allot(visible.filter(isText), natC);
  allot(visible, natH);
  for (let i = 0; i < n; i++) if (into[i] !== null) widths[i] = 0;

  const xs: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    xs.push(acc);
    acc += widths[i];
  }
  const headerLines = cols.map((_, i) => {
    if (into[i] !== null) return [];
    const w = widths[i] - pad;
    const lines: string[] = [];
    for (const j of [i, ...of[i]]) {
      const h = header[j] ?? '';
      if (!h) continue;
      lines.push(...wrapCell(h, w, 'tokens', a.fs, true, measure, { tokensWrap: true }).flatMap((l) => (a.breakWords && measure(l, true) * a.fs > w + EPS ? charChunks(l, w, (x) => measure(x, true) * a.fs) : [l])));
    }
    return lines;
  });
  return {
    fontSize: a.fs,
    lineH: lineHeight(a.fs),
    widths,
    xs,
    totalW: acc,
    foldedInto: into,
    foldsOf: of,
    tokensWrap: a.tokensWrap,
    breakWords: a.breakWords,
    headerLines,
    headerN: Math.max(1, ...headerLines.map((l) => l.length)),
    overflow,
  };
}

export interface RowLayout {
  /** Zeilen je Spalte; null = Farbfeld; [] = untergelegte Spalte */
  lines: (string[] | null)[];
  /** Anzahl Textzeilen der Zeile (≥ 1) */
  n: number;
}

/** Umbruch einer Datenzeile gemäß Tabellenlayout (untergelegte Spalten als weitere Zeilen der Zielspalte). */
export function layoutRow(tl: TableLayout, cols: ColSpec[], row: TableCell[], measure: Measure): RowLayout {
  const lines: (string[] | null)[] = [];
  let n = 1;
  const w = (i: number) => tl.widths[i] - PAD_L - PAD_R;
  const wrapOf = (j: number, width: number): string[] => {
    const c = row[j];
    if (typeof c !== 'string') return [];
    return wrapCell(c, width, cols[j].kind ?? 'fixed', tl.fontSize, false, measure, { tokensWrap: tl.tokensWrap, breakWords: tl.breakWords });
  };
  for (let i = 0; i < cols.length; i++) {
    if (tl.foldedInto[i] !== null) {
      lines.push([]);
      continue;
    }
    if ((cols[i].kind ?? 'fixed') === 'swatch') {
      lines.push(null);
      continue;
    }
    const l = wrapOf(i, w(i));
    if (!l.length) l.push('');
    for (const j of tl.foldsOf[i]) {
      const c = row[j];
      if (typeof c === 'string' && c) l.push(...wrapOf(j, w(i)));
    }
    lines.push(l);
    if (l.length > n) n = l.length;
  }
  return { lines, n };
}

/** Zeichenschnittstelle (im PDF: jsPDF; in Tests: Aufzeichnung der Textboxen). */
export interface TableCanvas {
  measure: Measure;
  /** `x` = linke Kante (align left) bzw. rechte Kante (align right); `y` = Grundlinie der ersten Zeile */
  text(lines: string[], x: number, y: number, o: { size: number; bold: boolean; align: 'left' | 'right'; lineH: number }): void;
  band(x: number, y: number, w: number, h: number): void;
  swatch(hex: string, x: number, y: number, w: number, h: number): void;
  rule(x1: number, x2: number, y: number): void;
  /** neue Seite beginnen; liefert die Grundlinie der (wiederholten) Kopfzeile */
  newPage(): number;
}

export interface DrawTableOptions {
  /** linke Tabellenkante (mm) */
  x: number;
  /** Grundlinie der Kopfzeile */
  y: number;
  /** größte erlaubte Grundlinie der letzten Textzeile einer Datenzeile */
  bottom: number;
  /** Höhe einer einzeiligen Zeile (Standard 5 mm) */
  rowH?: number;
  /** wird vor dem Zeichnen jeder Zeile aufgerufen (nach einem eventuellen Seitenumbruch) */
  onRow?: (i: number, r: { baseline: number; top: number; h: number }) => void;
}

/** Abstand Grundlinie → Oberkante des Zeilenbandes */
export const BAND_TOP = 3.6;

/** Vorschub der Kopfzeile in mm */
export function headerAdvance(tl: TableLayout, rowH = 5): number {
  return rowH + (tl.headerN - 1) * tl.lineH;
}

/** Zeichnet die Tabelle (Kopfzeile auf jeder Seite, Zeilenhöhe je Inhalt) und liefert die y-Position danach. */
export function drawTable(cv: TableCanvas, cols: ColSpec[], rows: TableCell[][], tl: TableLayout, o: DrawTableOptions): number {
  const rowH = o.rowH ?? 5;
  const fs = tl.fontSize;
  const k = fs / 8;
  let y = o.y;
  const xAt = (i: number, align: 'left' | 'right') => (align === 'right' ? o.x + tl.xs[i] + tl.widths[i] - PAD_R : o.x + tl.xs[i] + PAD_L);
  const drawHeader = () => {
    const hh = headerAdvance(tl, rowH);
    cv.band(o.x, y - BAND_TOP, tl.totalW, hh);
    tl.headerLines.forEach((l, i) => {
      if (!l.length) return;
      const align = cols[i].align ?? 'left';
      cv.text(l, xAt(i, align), y, { size: fs, bold: true, align, lineH: tl.lineH });
    });
    y += hh;
  };
  let fresh = false;
  if (rows.length) {
    const r0 = layoutRow(tl, cols, rows[0], cv.measure);
    if (y + headerAdvance(tl, rowH) + (r0.n - 1) * tl.lineH > o.bottom) {
      y = cv.newPage();
      fresh = true;
    }
  }
  drawHeader();
  rows.forEach((row, ri) => {
    const rl = layoutRow(tl, cols, row, cv.measure);
    const extra = (rl.n - 1) * tl.lineH;
    if (y + extra > o.bottom && !fresh) {
      y = cv.newPage();
      drawHeader();
    }
    fresh = false;
    o.onRow?.(ri, { baseline: y, top: y - BAND_TOP, h: rowH + extra });
    rl.lines.forEach((l, i) => {
      if (l === null) {
        const c = row[i];
        if (c && typeof c !== 'string') cv.swatch(c.swatch, o.x + tl.xs[i] + PAD_L, y - 3.2 * k, Math.max(1, tl.widths[i] - PAD_L - PAD_R), 3.8 * k);
        return;
      }
      if (!l.length || (l.length === 1 && !l[0])) return;
      const align = cols[i].align ?? 'left';
      cv.text(l, xAt(i, align), y, { size: fs, bold: false, align, lineH: tl.lineH });
    });
    cv.rule(o.x, o.x + tl.totalW, y + extra + 1.4);
    y += rowH + extra;
  });
  return y + 3;
}
