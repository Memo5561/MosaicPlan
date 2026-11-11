/**
 * Seitenplan des PDF-Verlegeplans – rein (ohne jsPDF), EINE Quelle für den Generator (pdf.ts) und die
 * Seitenschätzung der Oberfläche:
 *  - Blattaufteilung je Abschnitt (balancedSplit): erst die kleinste Blattanzahl (gierig), dann die Schnitte
 *    gleichmäßig auf Rasterlinien verteilt – keine schmalen Reststreifen, gleiche Blattanzahl wie bisher.
 *  - Abschnitte, die auf ein Blatt passen, bekommen statt eines eigenen Deckblatts einen kompakten Block auf
 *    einer gemeinsamen „Abschnittsübersicht“ (mehrere je Seite); mehrblättrige Abschnitte behalten ihr Deckblatt.
 *  - Zuschnittlisten je Blatt, Codeplan-Seiten (vergrößert, gleicher Rasterbereich), Schnittvorlagen- und
 *    Koordinatenseiten mit genau den Zeilen-/Kastenregeln des Generators.
 *
 * Welle 5: Farblegende je Verlegeblatt (im freien Band unter dem Mosaik, in einer freien rechten Spalte oder auf einer
 * eigenen Seite „Legende zu Blatt …“ direkt danach), Schnittvorlagen mit inhaltsabhängiger Kastenhöhe und die kompakte,
 * vollständige Koordinatenliste (Seiten gemessen von pdf.ts, sonst geschätzt).
 *
 * planPdfPages() ist exakt, wenn die gemessenen Teile (Vorspann, Deckblätter, Blockhöhen, Zuschnitt-Einträge
 * und Codeplan-Zoom je Blatt) als `facts` übergeben werden (pdfLayoutFacts() in pdf.ts misst sie mit dem Code
 * des Generators). Fehlen sie, werden diese Teile geschätzt und in `estimated` genannt (Oberfläche: „ca.“).
 */
import type { Layout, Section, SectionGrid } from './layout';
import { coordModeOf, effectiveSheetScale, printableArea, SHEET_RESERVES, type PdfOptions } from './pdfOptions';

const EPS = 1e-6;

// ---------------------------------------------------------------- Blattaufteilung

/**
 * Teilt die Rasterspalten (bzw. -zeilen) [a, b) in Blätter von höchstens `maxLen` Papier-mm (bei Maßstab
 * `scale`): zuerst die gierig ermittelte kleinste Anzahl k, dann die Schnitte gleichmäßig auf Rasterlinien
 * verteilt (Rundung je Zellenanzahl). Liefert [start, ende) je Blatt. Gleiche Blattanzahl wie der gierige
 * Schnitt, aber kein schmaler Reststreifen.
 */
export function balancedSplit(pos: ArrayLike<number>, size: ArrayLike<number>, a: number, b: number, maxLen: number, scale = 1): [number, number][] {
  if (b <= a) return [];
  const too = (i: number, j: number) => (pos[j - 1] + size[j - 1] - pos[i]) * scale > maxLen + EPS;
  let k = 1;
  for (let i = a + 1, st = a; i < b; i++) {
    if (too(st, i + 1)) {
      k++;
      st = i;
    }
  }
  const n = b - a;
  // 1. gleich viele Zellen je Blatt (bei gleichmäßigem Raster immer möglich)
  const starts: number[] = [];
  for (let i = 0; i < k; i++) {
    const v = a + Math.round((i * n) / k);
    if (starts[starts.length - 1] !== v) starts.push(v);
  }
  const even = starts.map((v, i) => [v, i + 1 < starts.length ? starts[i + 1] : b] as [number, number]);
  if (even.length === k && even.every(([x, y]) => y - x === 1 || !too(x, y))) return even;
  // 2. sonst (z. B. schmale Randspalte): kleinste größte Blattlänge mit genau k Blättern (Bisektion über die
  //    Länge, gieriger Schnitt) – nie mehr Blätter als gierig
  const span = (i: number, j: number) => (pos[j - 1] + size[j - 1] - pos[i]) * scale;
  const cut = (len: number) => {
    const out: [number, number][] = [];
    let st = a;
    for (let i = a + 1; i < b; i++)
      if (span(st, i + 1) > len + EPS) {
        out.push([st, i]);
        st = i;
      }
    out.push([st, b]);
    return out;
  };
  let lo = 0;
  for (let i = a; i < b; i++) lo = Math.max(lo, span(i, i + 1));
  let hi = maxLen;
  if (cut(lo).length <= k) return cut(lo);
  for (let it = 0; it < 60 && hi - lo > 1e-4; it++) {
    const mid = (lo + hi) / 2;
    if (cut(mid).length <= k) hi = mid;
    else lo = mid;
  }
  return cut(hi);
}

export interface SheetRange {
  /** Blatt-ID, z. B. „A1-3“ */
  key: string;
  secId: string;
  /** Blattnummer im Abschnitt (1 …) */
  no: number;
  /** Blätter im Abschnitt */
  count: number;
  tx: number;
  ty: number;
  ntx: number;
  nty: number;
  c0: number;
  c1: number;
  r0: number;
  r1: number;
}

export interface SectionSheets {
  section: Section;
  /** im PDF enthalten (opts.sectionIds) */
  selected: boolean;
  cx: [number, number][];
  ry: [number, number][];
  sheets: SheetRange[];
}

export interface SheetPlan {
  PW: number;
  PH: number;
  printW: number;
  printH: number;
  /** wirksamer Maßstab aller Blätter (Papier-mm je Mosaik-mm) */
  scale: number;
  sections: SectionSheets[];
}

/** Blattaufteilung aller Abschnitte (exakte Zellbereiche je Blatt); `selected` markiert die exportierten. */
export function planSheets(layout: Layout, grid: SectionGrid, opts: PdfOptions): SheetPlan {
  const { PW, PH, printW, printH } = printableArea(opts);
  const scale = effectiveSheetScale(opts, grid.sections, printW, printH);
  const sections = grid.sections.map((sec) => {
    const cx = balancedSplit(layout.colX, layout.colW, sec.c0, sec.c1, printW, scale);
    const ry = balancedSplit(layout.rowY, layout.rowH, sec.r0, sec.r1, printH, scale);
    const sheets: SheetRange[] = [];
    const count = cx.length * ry.length;
    ry.forEach(([r0, r1], ty) =>
      cx.forEach(([c0, c1], tx) => {
        const no = ty * cx.length + tx + 1;
        sheets.push({ key: `${sec.id}-${no}`, secId: sec.id, no, count, tx, ty, ntx: cx.length, nty: ry.length, c0, c1, r0, r1 });
      }),
    );
    return { section: sec, selected: !opts.sectionIds || opts.sectionIds.includes(sec.id), cx, ry, sheets };
  });
  return { PW, PH, printW, printH, scale, sections };
}

/** Rasterzelle → Blatt (O(1) je Zelle; Blattgrenzen sind je Abschnittsspalte bzw. -zeile gleich). */
export function makeSheetLocator(plan: SheetPlan, grid: SectionGrid, layout: { cols: number; rows: number }): (row: number, col: number) => SheetRange | null {
  const colSc = new Int32Array(layout.cols).fill(-1);
  const colTx = new Int32Array(layout.cols).fill(-1);
  const rowSr = new Int32Array(layout.rows).fill(-1);
  const rowTy = new Int32Array(layout.rows).fill(-1);
  for (const s of plan.sections) {
    const sec = s.section;
    if (sec.sr === 0) s.cx.forEach(([c0, c1], tx) => {
      for (let c = c0; c < c1; c++) {
        colSc[c] = sec.sc;
        colTx[c] = tx;
      }
    });
    if (sec.sc === 0) s.ry.forEach(([r0, r1], ty) => {
      for (let r = r0; r < r1; r++) {
        rowSr[r] = sec.sr;
        rowTy[r] = ty;
      }
    });
  }
  return (row, col) => {
    const sc = colSc[col];
    const sr = rowSr[row];
    if (sc < 0 || sr < 0) return null;
    const s = plan.sections[sr * grid.scols + sc];
    return s ? s.sheets[rowTy[row] * s.cx.length + colTx[col]] ?? null : null;
  };
}

// ---------------------------------------------------------------- Farbnummern auf den Blättern

/** Kleinste Rasterzelle (Papier-mm), die Farbnummern trägt. */
export const CODE_MIN_CELL = 2.2;
/** Kleinste Teilseite (Begrenzungsrechteck, Papier-mm), die eine Farbnummer trägt. */
export const CODE_MIN_PIECE = 1.8;
/** Kleinstes Inkreismaß (4 · Fläche ÷ Umfang, Papier-mm), bei dem die Vorlagennummer „T12“ als zweite Zeile in den Stein passt. */
export const TNO_MIN = 4.5;
/** Größter Codeplan-Zoom für zugeschnittene Kleinstteile; noch kleinere stehen mit Farbnummer in der Zuschnittliste. */
export const CODE_PLAN_MAX_K = 8;
/**
 * Größter Codeplan-Zoom für nicht zugeschnittene Steine (ganze Steine, feinere Steine): bis zu diesem Faktor wird
 * vergrößert, damit jeder solche Stein eine Nummer bekommt – sie stehen in keiner Zuschnittliste. Darüber (winzige
 * Steine bei sehr kleinem Maßstab) bleibt der Codeplan unvollständig und sagt das ausdrücklich.
 */
export const CODE_PLAN_WHOLE_MAX_K = 12;

/** Maße eines Steins für die Beschriftung: Begrenzungsrechteck w × h und kleinste Rasterseite (mm im Mosaik). */
export interface LabelDims {
  w: number;
  h: number;
  /** min(Steinbreite, Steinhöhe) des Rasters */
  tile: number;
}

/**
 * Bekommt der Stein bei Maßstab s eine Farbnummer? Raster ≥ 2,2 mm und kleinste Seite ≥ 1,8 mm auf dem Papier.
 * Gemeinsame Regel für Zeichnen, Zuschnittliste und Codeplan-Entscheidung.
 */
export function labelOk(p: LabelDims, s: number): boolean {
  return p.tile * s >= CODE_MIN_CELL - EPS && Math.min(p.w, p.h) * s >= CODE_MIN_PIECE - EPS;
}

/**
 * Codeplan-Zoom k ≥ 2 (Maßstab s·k). Kleinste Rasterseite `tile`, kleinste Seite der zugeschnittenen Steine `minSide`,
 * kleinste Seite der NICHT zugeschnittenen Steine `minSideWhole` (Standard: Rasterseite).
 *  - Nicht zugeschnittene Steine stehen in keiner Zuschnittliste: für sie wird bis CODE_PLAN_WHOLE_MAX_K vergrößert.
 *  - Zugeschnittene Kleinstteile stehen mit Farbnummer in der Zuschnittliste: für sie höchstens CODE_PLAN_MAX_K
 *    (bzw. so weit, wie die ganzen Steine ohnehin brauchen).
 * complete: alle Steine bekommen eine Nummer; wholeComplete: alle nicht zugeschnittenen Steine bekommen eine Nummer
 * (false nur bei winzigen Steinen auf sehr kleinem Maßstab – der Codeplan sagt das dann ausdrücklich).
 */
export function codePlanZoom(tile: number, minSide: number, s: number, minSideWhole = tile): { k: number; complete: boolean; wholeComplete: boolean } {
  const need = (v: number, min: number) => (v > 0 && Number.isFinite(v) ? Math.ceil(min / (v * s) - EPS) : v > 0 ? 0 : Infinity);
  const kWhole = Math.max(need(tile, CODE_MIN_CELL), need(minSideWhole, CODE_MIN_PIECE));
  const kAll = Math.max(kWhole, need(minSide, CODE_MIN_PIECE));
  const kW = Math.min(kWhole, CODE_PLAN_WHOLE_MAX_K);
  const k = Math.max(2, kW, Math.min(kAll, Math.max(CODE_PLAN_MAX_K, kW)));
  return { k, complete: k >= kAll, wholeComplete: k >= kWhole };
}

/** Teile eines Codeplans: derselbe Zellbereich wie das Blatt, bei Maßstab s·k gleichmäßig auf Seiten verteilt. */
export function codePlanParts(layout: Layout, r: { c0: number; c1: number; r0: number; r1: number }, scale: number, printW: number, printH: number): { c0: number; c1: number; r0: number; r1: number }[] {
  const cx = balancedSplit(layout.colX, layout.colW, r.c0, r.c1, printW, scale);
  const ry = balancedSplit(layout.rowY, layout.rowH, r.r0, r.r1, printH, scale);
  const out: { c0: number; c1: number; r0: number; r1: number }[] = [];
  for (const [r0, r1] of ry) for (const [c0, c1] of cx) out.push({ c0, c1, r0, r1 });
  return out;
}

// ---------------------------------------------------------------- Zuschnittliste je Blatt

/** Geometrie der Zuschnittlisten-Seiten (mm). Einträge haben feste Höhe; Texte werden nie umbrochen, nur verkleinert. */
export const CUT_LIST = {
  titleY: 7,
  hintY: 11.5,
  headY: 19,
  firstRowY: 23.5,
  rowH: 4,
  colW: 88,
  gap: 4,
  fontSize: 6.5,
  bottom: 8,
} as const;

export interface CutListLayout {
  cols: number;
  rowsPerCol: number;
  /** Zeilenplätze je Seite (cols · rowsPerCol) */
  perPage: number;
  pages: number;
  /**
   * je Blatt der Gruppe (Reihenfolge wie übergeben): Platz der Kopfzeile „Blatt A1-2 – n Steine“ und der Einträge
   * (laufende Platznummer über Spalten und Seiten); null = Blatt ohne Einträge
   */
  blocks: ({ head: number; first: number; end: number } | null)[];
}

/**
 * Zuschnittliste einer Blattgruppe (Blätter eines Abschnitts bzw. einer Übersichtsseite), direkt nach diesen Blättern:
 * je Blatt eine Kopfzeile und seine Einträge, fortlaufend in Spalten und Seiten. Eine Kopfzeile steht nie allein am
 * Spaltenende. `counts` = Einträge je Blatt.
 */
export function layoutCutList(counts: number[], PW: number, PH: number): CutListLayout {
  const M = SHEET_RESERVES.M;
  const AW = PW - 2 * M;
  const cols = Math.max(1, Math.floor((AW + CUT_LIST.gap + EPS) / (Math.min(CUT_LIST.colW, AW) + CUT_LIST.gap)));
  const rowsPerCol = Math.max(2, Math.floor((PH - M - CUT_LIST.bottom - (M + CUT_LIST.firstRowY)) / CUT_LIST.rowH + EPS) + 1);
  const perPage = cols * rowsPerCol;
  let pos = 0;
  const blocks = counts.map((n) => {
    if (n <= 0) return null;
    if (pos % rowsPerCol === rowsPerCol - 1) pos++;
    const head = pos;
    const first = pos + 1;
    pos = first + n;
    return { head, first, end: pos };
  });
  return { cols, rowsPerCol, perPage, pages: pos > 0 ? Math.ceil(pos / perPage) : 0, blocks };
}

/** Seiten (relativ zur ersten Listenseite, ab 0) eines Platzbereichs [a, b) */
export function cutListPagesOf(cl: CutListLayout, a: number, b: number): number[] {
  const out: number[] = [];
  for (let p = Math.floor(a / cl.perPage); p <= Math.floor((b - 1) / cl.perPage); p++) out.push(p);
  return out;
}

// ---------------------------------------------------------------- Farblegende je Verlegeblatt

/**
 * Farblegende eines Verlegeblatts: Kopfzeile „Steine auf diesem Blatt: N, davon K zugeschnitten“ und je Farbe ein
 * Feld (Farbfeld, „07 ×123“, Farbnummer des Materials bzw. kurzer Name). Maße in mm.
 */
export const SHEET_LEGEND = {
  /** volles Feld (mit Farbnummer des Materials bzw. Farbname) und schmales Feld (nur Farbfeld, Nummer und Anzahl) */
  chipW: 45,
  narrowW: 24,
  chipH: 4.5,
  gap: 2,
  headH: 4,
  /** Kopfzeile in einer schmalen Spalte (umbrochen, höchstens 3 Zeilen) */
  narrowHeadH: 9,
  /** Unterkante des freien Bands: so weit über dem Seitenrand (über Anschlussangaben, Fußzeile, Kontrollstrecke) */
  bottomClear: 12,
  /** Abstand unter dem Mosaik (mit bzw. ohne Anschlussbeschriftung „↓ …“ darunter) */
  topGap: 4.2,
  topGapJoin: 5.2,
  /** Abstand rechts neben dem Mosaik (mit bzw. ohne gedrehte Anschlussbeschriftung) */
  rightGap: 4.5,
  rightGapJoin: 6.8,
  /** Legendenseite: Oberkante der Felder */
  pageTop: 21,
  pageBottom: 10,
} as const;

/** Felder je Reihe bei verfügbarer Breite w */
export function legendChipsPerRow(w: number, chipW: number = SHEET_LEGEND.chipW): number {
  const L = SHEET_LEGEND;
  return Math.max(1, Math.floor((w + L.gap + 1e-9) / (chipW + L.gap)));
}

/** Höhe der Legende (Kopfzeile + Reihen) für n Farben bei Breite w */
export function legendHeight(n: number, w: number, chipW: number = SHEET_LEGEND.chipW, headH: number = SHEET_LEGEND.headH): number {
  return headH + Math.ceil(n / legendChipsPerRow(w, chipW)) * SHEET_LEGEND.chipH;
}

export interface LegendArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetLegendGeometry {
  /** freies Band unter dem Mosaik (volle Breite) */
  band: LegendArea;
  /** freie Spalte rechts neben dem Mosaik */
  right: LegendArea;
}

/**
 * Freie Flächen eines Verlegeblatts für die Legende – dieselbe Geometrie wie drawSheet (Mosaik bei M + Rand links/oben,
 * Anschlusslinien auf Fugenmitte, „↓ Anschluss …“ unter dem Mosaik, gedrehte Beschriftung rechts daneben).
 */
export function sheetLegendGeometry(layout: Layout, sh: SheetRange, section: Section, grid: { srows: number; scols: number }, scale: number, PW: number, PH: number): SheetLegendGeometry {
  const R = SHEET_RESERVES;
  const L = SHEET_LEGEND;
  const M = R.M;
  const g = layout.joint;
  const X0 = layout.colX[sh.c0];
  const Y0 = layout.rowY[sh.r0];
  const X1 = layout.colX[sh.c1 - 1] + layout.colW[sh.c1 - 1];
  const Y1 = layout.rowY[sh.r1 - 1] + layout.rowH[sh.r1 - 1];
  const rightE = sh.c1 === layout.cols ? X1 : X1 + g / 2;
  const botE = sh.r1 === layout.rows ? Y1 : Y1 + g / 2;
  const below = sh.ty + 1 < sh.nty || section.sr + 1 < grid.srows;
  const right = sh.tx + 1 < sh.ntx || section.sc + 1 < grid.scols;
  const left0 = M + R.left;
  const top0 = M + R.top;
  const bandTop = top0 + (botE - Y0) * scale + (below ? L.topGapJoin : L.topGap);
  const bottom = PH - M - L.bottomClear;
  const rx = left0 + (rightE - X0) * scale + (right ? L.rightGapJoin : L.rightGap);
  return {
    band: { x: M, y: bandTop, w: PW - 2 * M, h: bottom - bandTop },
    right: { x: rx, y: top0, w: PW - M - rx, h: bottom - top0 },
  };
}

export type SheetLegendPlace = { kind: 'band' | 'right'; area: LegendArea; chipW: number; headH: number } | { kind: 'page'; pages: number };

/** Seiten „Legende zu Blatt …“ für n Farben (meist 1) */
export function legendPagesFor(n: number, PW: number, PH: number): number {
  const L = SHEET_LEGEND;
  const M = SHEET_RESERVES.M;
  const perRow = legendChipsPerRow(PW - 2 * M);
  const rowsPerPage = Math.max(1, Math.floor((PH - M - L.pageBottom - (M + L.pageTop + L.headH)) / L.chipH + 1e-9));
  return Math.max(1, Math.ceil(Math.ceil(n / perRow) / rowsPerPage));
}

/**
 * Wohin kommt die Legende eines Blatts mit n Farben? Nie gekürzt – der Reihe nach: Band unter dem Mosaik (volle
 * Felder), rechte Spalte (volle Felder), Band mit schmalen Feldern, schmale rechte Spalte, sonst eigene Seite(n)
 * „Legende zu Blatt …“ direkt nach dem Blatt.
 */
export function placeSheetLegend(n: number, g: SheetLegendGeometry, PW: number, PH: number): SheetLegendPlace {
  const L = SHEET_LEGEND;
  const fits = (a: LegendArea, chipW: number, headH: number) => a.w >= chipW - 1e-9 && a.h >= legendHeight(n, a.w, chipW, headH) - 1e-9;
  if (fits(g.band, L.chipW, L.headH)) return { kind: 'band', area: g.band, chipW: L.chipW, headH: L.headH };
  if (fits(g.right, L.chipW, L.headH)) return { kind: 'right', area: g.right, chipW: L.chipW, headH: L.headH };
  if (fits(g.band, L.narrowW, L.headH)) return { kind: 'band', area: g.band, chipW: L.narrowW, headH: L.headH };
  const headH = g.right.w >= 60 ? L.headH : L.narrowHeadH;
  if (fits(g.right, L.narrowW, headH)) return { kind: 'right', area: g.right, chipW: L.narrowW, headH };
  return { kind: 'page', pages: legendPagesFor(n, PW, PH) };
}

// ---------------------------------------------------------------- Schnittvorlagen

export const TEMPLATE_BOX = { w: 60, h: 68, firstTop: 22.5, nextTop: 4, bottomGap: 6, noticeH: 9 } as const;

/** Benötigte Kastenhöhe (mm, inkl. 3 mm Abstand) und Kastenspalten einer Vorlage (templateLayout). */
export interface TemplateBoxSpec {
  h: number;
  span: number;
}

export interface TemplateBoxLayout {
  /** Seite (0 = erste Vorlagenseite), Position und Größe (inkl. Abstand) je Kasten */
  boxes: { page: number; x: number; y: number; w: number; h: number }[];
  /** Hinweis „weitere Vorlagen nicht gedruckt“ (nur bei Kürzung) */
  notice: { page: number; y: number } | null;
  pages: number;
}

/**
 * Kastenraster der Schnittvorlagen – genau die Seitenumbrüche des Generators. Kästen laufen zeilenweise; die Höhe einer
 * Reihe ist die größte benötigte Höhe ihrer Kästen (Inhalt wird nie abgeschnitten). Mit einer Anzahl statt der Maße
 * gilt die frühere feste Kastenhöhe (Schätzung).
 */
export function layoutTemplateBoxes(shown: number | TemplateBoxSpec[], truncated: boolean, PW: number, PH: number): TemplateBoxLayout {
  const M = SHEET_RESERVES.M;
  const AW = PW - 2 * M;
  const B = TEMPLATE_BOX;
  const specs: TemplateBoxSpec[] = typeof shown === 'number' ? Array.from({ length: shown }, () => ({ h: B.h, span: 1 })) : shown;
  const perRow = Math.max(1, Math.floor(AW / B.w));
  const bottom = PH - M - B.bottomGap;
  // Reihen bilden
  const rows: { items: { i: number; col: number; span: number }[]; h: number }[] = [];
  let col = perRow;
  specs.forEach((sp, i) => {
    const span = Math.max(1, Math.min(perRow, Math.round(sp.span)));
    if (col + span > perRow) {
      rows.push({ items: [], h: 0 });
      col = 0;
    }
    const r = rows[rows.length - 1];
    r.items.push({ i, col, span });
    r.h = Math.max(r.h, sp.h);
    col += span;
  });
  let page = 0;
  let by = M + B.firstTop;
  let onPage = 0;
  const boxes: TemplateBoxLayout['boxes'] = new Array(specs.length);
  for (const r of rows) {
    if (onPage > 0 && by + r.h > bottom) {
      page++;
      by = M + B.nextTop;
      onPage = 0;
    }
    onPage++;
    for (const it of r.items) boxes[it.i] = { page, x: M + it.col * B.w, y: by, w: it.span * B.w, h: r.h };
    by += r.h;
  }
  let notice: { page: number; y: number } | null = null;
  if (truncated) {
    let y = by + 2;
    if (y + B.noticeH > bottom) {
      page++;
      y = M + 8;
    }
    notice = { page, y: y + 3 };
  }
  return { boxes, notice, pages: specs.length > 0 || truncated ? page + 1 : 0 };
}

// ---------------------------------------------------------------- Koordinatenlisten

/** Zeilenhöhe der Koordinatentabellen (mm) */
export const COORD_ROW_H = 4.2;
/** Platz, den der Kürzungshinweis unter der letzten Tabelle mindestens braucht (4 Zeilen à 4 mm) */
export const COORD_NOTICE_RESERVE = 16;

/**
 * Seiten der Koordinatenlisten – dieselbe Schleife wie der Generator (einzeilige Zeilen, Titel einzeilig,
 * Kopfzeile auf jeder Seite, 60 Zeilen auf der ersten und 62 auf jeder weiteren A4-Seite).
 * Liefert auch die Steine, die aufgeführt werden (Limit opts.coordLimit über alle exportierten Abschnitte).
 */
export function planCoordPages(stonesPerSection: number[], coordLimit: number, PH: number): { pages: number; listed: number; truncated: boolean } {
  const M = SHEET_RESERVES.M;
  const bottom = PH - M - 8;
  let pages = 0;
  let written = 0;
  let truncated = false;
  let lastY: number | null = null;
  for (const total of stonesPerSection) {
    if (written >= coordLimit && total > 0) {
      truncated = true;
      continue;
    }
    const n = Math.min(total, Math.max(0, coordLimit - written));
    if (n < total) truncated = true;
    written += n;
    pages++;
    // Titel (12 pt, eine Zeile) bei M + 8, Tabelle darunter (drawTable)
    let y = M + 8 + 7;
    let fresh = false;
    if (n > 0 && y + COORD_ROW_H > bottom) {
      pages++;
      y = M + 6;
      fresh = true;
    }
    y += COORD_ROW_H;
    for (let i = 0; i < n; i++) {
      if (y > bottom && !fresh) {
        pages++;
        y = M + 6 + COORD_ROW_H;
      }
      fresh = false;
      y += COORD_ROW_H;
    }
    lastY = y + 3;
  }
  if (truncated) {
    const ny = lastY !== null ? lastY + 2 : null;
    if (ny === null || ny + COORD_NOTICE_RESERVE > bottom) pages++;
  }
  return { pages, listed: written, truncated };
}

/**
 * Schätzung der kompakten Koordinatenseiten ohne Messwerte (Oberfläche: „ca.“): je Abschnitt Titel/Beispiel, Spalten-
 * und Zeilentabelle (≈ 6 Einträge je Zeile), eine Farbfolgezeile je Rasterzeile (+ 50 % Umbruch) und eine Zeile je
 * Sonderteil (≈ zugeschnittene Steine).
 */
export function estimateCompactCoordPages(sections: { cols: number; rows: number; specials: number }[], PW: number, PH: number): number {
  const M = SHEET_RESERVES.M;
  const AW = PW - 2 * M;
  const line = 6 * 1.28 * (25.4 / 72);
  const usable = PH - 2 * M - 8;
  const perLine = Math.max(1, Math.floor(AW / 30));
  const tables = Math.max(1, Math.floor((AW + 4) / 96));
  let h = 30;
  for (const s of sections) {
    h += 14 + (Math.ceil(s.cols / perLine) + Math.ceil(s.rows / perLine) + s.rows * 1.5 + Math.ceil(s.specials / tables) + 4) * line;
  }
  return sections.length ? Math.max(1, Math.ceil(h / usable)) : 0;
}

// ---------------------------------------------------------------- Abschnittsübersicht (kompakte Blöcke)

export const SUMMARY = {
  titleY: 8,
  hintY: 12.5,
  firstTop: 17,
  gap: 3,
  bottom: 8,
  titleH: 6.5,
  infoLineH: 3.4,
  infoGap: 1.2,
  chipW: 23,
  chipH: 4.4,
  pad: 1.8,
} as const;

/** Farbfelder („07 ×123“) je Zeile eines Übersichtsblocks */
export function summaryChipsPerRow(PW: number): number {
  const AW = PW - 2 * SHEET_RESERVES.M;
  return Math.max(1, Math.floor((AW - 3) / SUMMARY.chipW));
}

/** Höhe eines Übersichtsblocks (mm) bei `infoLines` Angabezeilen und `colors` Farbfeldern. */
export function summaryBlockHeight(infoLines: number, colors: number, PW: number): number {
  const rows = colors > 0 ? Math.ceil(colors / summaryChipsPerRow(PW)) : 0;
  return SUMMARY.titleH + infoLines * SUMMARY.infoLineH + SUMMARY.infoGap + rows * SUMMARY.chipH + SUMMARY.pad;
}

/** Packt Blöcke (Höhen in Reihenfolge) auf Seiten; liefert je Seite die Indizes und die Oberkante je Block. */
export function packSummaries(heights: number[], PH: number): { blocks: number[]; tops: number[] }[] {
  const M = SHEET_RESERVES.M;
  const bottom = PH - M - SUMMARY.bottom;
  const pages: { blocks: number[]; tops: number[] }[] = [];
  let cur: { blocks: number[]; tops: number[] } | null = null;
  let y = 0;
  heights.forEach((h, i) => {
    if (!cur || (cur.blocks.length > 0 && y + h > bottom)) {
      cur = { blocks: [], tops: [] };
      pages.push(cur);
      y = M + SUMMARY.firstTop;
    }
    cur.blocks.push(i);
    cur.tops.push(y);
    y += h + SUMMARY.gap;
  });
  return pages;
}

// ---------------------------------------------------------------- Reihenfolge der Abschnittsseiten

export type SectionItem = { kind: 'cover'; s: SectionSheets } | { kind: 'compact'; run: SectionSheets[] };

/**
 * Reihenfolge der exportierten Abschnitte: mehrblättrige Abschnitte einzeln (Deckblatt + Blätter), aufeinander
 * folgende einblättrige Abschnitte als Lauf (Übersichtsseite(n) + deren Blätter).
 */
export function sectionItems(plan: SheetPlan): SectionItem[] {
  const out: SectionItem[] = [];
  for (const s of plan.sections) {
    if (!s.selected) continue;
    if (s.sheets.length > 1) out.push({ kind: 'cover', s });
    else {
      const last = out[out.length - 1];
      if (last && last.kind === 'compact') last.run.push(s);
      else out.push({ kind: 'compact', run: [s] });
    }
  }
  return out;
}

// ---------------------------------------------------------------- Gesamtplan

/** Gemessene (bzw. aus den Daten gezählte) Teile des Plans – pdfLayoutFacts() in pdf.ts. */
export interface PdfLayoutFacts {
  /** Seiten vor dem ersten Abschnitt (Deckblatt … Materialliste) */
  front: number;
  /** Deckblattseiten je mehrblättrigem Abschnitt */
  coverPages: Record<string, number>;
  /** Angabezeilen je einblättrigem Abschnitt (Übersichtsblock) */
  summaryInfoLines: Record<string, number>;
  /** verwendete Farben je Abschnitt (Farbfelder im Übersichtsblock) */
  colorsPerSection: Record<string, number>;
  /**
   * je Blatt: Einträge der Zuschnittliste, Codeplan-Zoom (0 = kein Codeplan) und Seiten „Legende zu Blatt …“
   * (0 = Legende auf dem Blatt; fehlt der Wert, wird er aus den Farben geschätzt)
   */
  sheets: Record<string, { cutEntries: number; codeK: number; legendPages?: number }>;
  /** Schnittvorlagen-Gruppen (collectTemplates) */
  templateGroups: number;
  /** Kastenmaße der gedruckten Schnittvorlagen (templateLayout), in Druckreihenfolge */
  templateBoxes?: TemplateBoxSpec[];
  /** Seiten der kompakten Koordinatenliste (gemessen) */
  coordPages?: number;
  /**
   * je Abschnitt: Steine (= computeStats().pieces) und zugeschnittene Steine (= computeStats().cutPieces = Sonderteile
   * der kompakten Koordinatenliste) – damit schätzt planForSelection auch Teilmengen (Export in Teilen) richtig
   */
  stones: Record<string, SectionCounts>;
  /**
   * Schnittvorlagen des ganzen Mosaiks (globale Reihenfolge T1 …): je Vorlage die Abschnitte, in denen sie vorkommt –
   * für Teilmengen (Export in Teilen) zählt nur, was in den exportierten Abschnitten vorkommt
   */
  templateSections?: string[][];
  /** globale Vorlagennummern (T1 = 1) der gedruckten Kästen, in derselben Reihenfolge wie templateBoxes */
  templateBoxNos?: number[];
}

/** Zahlen je Abschnitt aus der Statistik (für Schätzungen ohne gemessene Teile). */
export interface SectionCounts {
  pieces: number;
  cutPieces?: number;
  /** verwendete Farben */
  colors?: number;
}

export type PiecesInput = Record<string, number | SectionCounts> | ReadonlyMap<string, number | SectionCounts> | ((id: string) => number | SectionCounts | undefined);

/** Hinweise für Schätzungen ohne gemessene Teile. */
export interface PlanHints {
  paletteSize?: number;
  hasOriginal?: boolean;
  hasPreview?: boolean;
}

export type PlanPart = 'front' | 'sectionCovers' | 'sectionSummaries' | 'sheetLegends' | 'cutLists' | 'codePlans' | 'templates' | 'coords';

export interface PdfPagePlan {
  total: number;
  /** Deckblatt, Bilder, Gesamtübersicht, Farblegende, Materialliste */
  front: number;
  /** Deckblätter mehrblättriger Abschnitte */
  sectionCovers: number;
  /** Seiten „Abschnittsübersicht“ (kompakte Blöcke einblättriger Abschnitte) */
  sectionSummaries: number;
  /** sectionCovers + sectionSummaries */
  sectionPages: number;
  /** Verlegeblätter */
  sheets: number;
  /** Seiten „Legende zu Blatt …“ (wenn die Farblegende nicht auf das Blatt passt) */
  sheetLegends: number;
  cutLists: number;
  codePlans: number;
  templates: number;
  coords: number;
  /** geschätzte Teile (keine Messwerte übergeben) – in der Oberfläche mit „ca.“ kennzeichnen */
  estimated: PlanPart[];
  sheetPlan: SheetPlan;
}

function countsOf(input: PiecesInput, id: string): SectionCounts | undefined {
  const v = typeof input === 'function' ? input(id) : input instanceof Map ? input.get(id) : (input as Record<string, number | SectionCounts>)[id];
  if (v === undefined) return undefined;
  return typeof v === 'number' ? { pieces: v } : v;
}

/** Simuliert eine einfache Tabelle (einzeilige Zeilen, rowH 5) – nur für die Schätzung des Vorspanns. */
function simRows(n: number, y: number, PH: number, rowH = 5): { pages: number; y: number } {
  const M = SHEET_RESERVES.M;
  const bottom = PH - M - 8;
  let pages = 0;
  y += rowH;
  for (let i = 0; i < n; i++) {
    if (y > bottom) {
      pages++;
      y = M + 6 + rowH;
    }
    y += rowH;
  }
  return { pages, y: y + 3 };
}

/**
 * Seitenplan des PDFs. Mit vollständigen `facts` exakt (= doc.getNumberOfPages()); ohne sie werden Vorspann,
 * Deckblätter, Blockhöhen, Zuschnittlisten und Codepläne aus den Abschnittszahlen geschätzt (`estimated`).
 */
export function planPdfPages(
  layout: Layout,
  grid: SectionGrid,
  opts: PdfOptions,
  piecesPerSection: PiecesInput,
  templateGroups?: number,
  facts?: Partial<PdfLayoutFacts> & PlanHints,
): PdfPagePlan {
  const plan = planSheets(layout, grid, opts);
  const { PW, PH, scale } = plan;
  const M = SHEET_RESERVES.M;
  const AW = PW - 2 * M;
  const estimated = new Set<PlanPart>();
  const codeMode = opts.codePlan ?? 'auto';
  const coordMode = coordModeOf(opts);
  const tile = Math.min(layout.tileW, layout.tileH);

  // ---- Vorspann
  let front: number;
  if (facts?.front !== undefined) front = facts.front;
  else {
    estimated.add('front');
    const images = opts.includeImages ? (facts?.hasOriginal !== false ? 1 : 0) + (facts?.hasPreview !== false ? 1 : 0) : 0;
    const availH = Math.min(PH * 0.55, PH - 2 * M - 30);
    const ms = Math.min(AW / layout.finishedW, availH / layout.finishedH);
    const ov = simRows(grid.sections.length, M + 14 + layout.finishedH * ms + 8, PH);
    const pal = facts?.paletteSize ?? 24;
    const legend = simRows(pal, M + 15, PH);
    const mat = simRows(pal + 12, M + 70, PH);
    front = 1 + images + 1 + ov.pages + 1 + legend.pages + 1 + mat.pages;
  }

  // ---- Abschnitte
  let sectionCovers = 0;
  let sectionSummaries = 0;
  let sheets = 0;
  let sheetLegends = 0;
  let cutLists = 0;
  let codePlans = 0;
  const stonesPerSection: number[] = [];
  const compactSections: { cols: number; rows: number; specials: number }[] = [];
  const colorsOf = (id: string, part: PlanPart) => {
    const f = facts?.colorsPerSection?.[id];
    if (f !== undefined) return f;
    estimated.add(part);
    return countsOf(piecesPerSection, id)?.colors ?? Math.min(facts?.paletteSize ?? 24, 24);
  };
  /** Legendenseiten eines Blatts: gemessen, sonst aus den Farben des Abschnitts geschätzt */
  const legendPagesOf = (s: SectionSheets, sh: SheetRange): number => {
    const f = facts?.sheets?.[sh.key]?.legendPages;
    if (f !== undefined) return f;
    estimated.add('sheetLegends');
    const n = countsOf(piecesPerSection, s.section.id)?.colors ?? Math.min(facts?.paletteSize ?? 24, 24);
    const place = placeSheetLegend(Math.max(1, n), sheetLegendGeometry(layout, sh, s.section, grid, scale, PW, PH), PW, PH);
    return place.kind === 'page' ? place.pages : 0;
  };
  const sheetFacts = (s: SectionSheets, sh: SheetRange): { cutEntries: number; codeK: number } => {
    const f = facts?.sheets?.[sh.key];
    if (f) return f;
    // Schätzung: zugeschnittene Steine anteilig nach Fläche; Vorlagennummer im Stein, wenn halbe Steine sie tragen
    estimated.add('cutLists');
    estimated.add('codePlans');
    const c = countsOf(piecesPerSection, s.section.id);
    const secArea = s.section.w * s.section.h;
    const w = layout.colX[sh.c1 - 1] + layout.colW[sh.c1 - 1] - layout.colX[sh.c0];
    const h = layout.rowY[sh.r1 - 1] + layout.rowH[sh.r1 - 1] - layout.rowY[sh.r0];
    const share = secArea > 0 ? (w * h) / secArea : 1;
    const onPiece = tile * 0.5 * scale >= TNO_MIN;
    const cutEntries = onPiece ? 0 : Math.round((c?.cutPieces ?? 0) * share);
    const codeless = tile * scale < CODE_MIN_CELL - EPS;
    const codeK = codeMode === 'off' ? 0 : codeMode === 'always' || codeless ? codePlanZoom(tile, tile, scale).k : 0;
    return { cutEntries, codeK };
  };
  /** Blattgruppe: Blätter (je mit Codeplan-Seiten), danach die gemeinsame Zuschnittliste */
  const emitGroup = (group: { s: SectionSheets; sh: SheetRange }[]) => {
    const counts: number[] = [];
    for (const { s, sh } of group) {
      sheets++;
      sheetLegends += legendPagesOf(s, sh);
      const f = sheetFacts(s, sh);
      if (f.codeK > 0) codePlans += codePlanParts(layout, sh, scale * f.codeK, plan.printW, plan.printH).length;
      counts.push(f.cutEntries);
    }
    cutLists += layoutCutList(counts, PW, PH).pages;
  };
  for (const item of sectionItems(plan)) {
    if (item.kind === 'cover') {
      const id = item.s.section.id;
      const f = facts?.coverPages?.[id];
      if (f !== undefined) sectionCovers += f;
      else {
        estimated.add('sectionCovers');
        // Kopfblock + Mini-Übersicht ≈ 80 mm, dann eine Zeile je Farbe
        sectionCovers += 1 + simRows(colorsOf(id, 'sectionCovers'), M + 80, PH).pages;
      }
      emitGroup(item.s.sheets.map((sh) => ({ s: item.s, sh })));
    } else {
      const heights = item.run.map((s) => summaryBlockHeight(facts?.summaryInfoLines?.[s.section.id] ?? 3, colorsOf(s.section.id, 'sectionSummaries'), PW));
      if (item.run.some((s) => facts?.summaryInfoLines?.[s.section.id] === undefined)) estimated.add('sectionSummaries');
      const pages = packSummaries(heights, PH);
      sectionSummaries += pages.length;
      for (const p of pages) emitGroup(p.blocks.map((i) => ({ s: item.run[i], sh: item.run[i].sheets[0] })));
    }
  }
  for (const s of plan.sections) {
    if (!s.selected) continue;
    const measured = facts?.stones?.[s.section.id];
    const counted = countsOf(piecesPerSection, s.section.id);
    const st = measured?.pieces ?? counted?.pieces;
    if (st === undefined && coordMode === 'perStone') estimated.add('coords');
    stonesPerSection.push(st ?? 0);
    // Sonderteile der kompakten Liste = zugeschnittene Steine (computeStats().cutPieces), gemessen bevorzugt
    compactSections.push({ cols: s.section.c1 - s.section.c0, rows: s.section.r1 - s.section.r0, specials: measured?.cutPieces ?? counted?.cutPieces ?? 0 });
  }

  // ---- Schnittvorlagen
  let templates = 0;
  const groups = facts?.templateGroups ?? templateGroups;
  if (opts.includeTemplates) {
    if (groups === undefined) estimated.add('templates');
    const n = groups ?? 0;
    if (n > 0) {
      const shown = Math.min(n, Math.max(0, opts.templateLimit));
      // Kastenhöhen hängen vom Inhalt ab (gemessen in pdfLayoutFacts); sonst feste Höhe als Schätzung
      const boxes = facts?.templateBoxes && facts.templateBoxes.length === shown ? facts.templateBoxes : null;
      if (!boxes && shown > 0) estimated.add('templates');
      templates = layoutTemplateBoxes(boxes ?? shown, n > shown, PW, PH).pages;
    }
  }

  // ---- Koordinaten: je Stein (exakt aus den Steinzahlen), kompakt (gemessen bzw. geschätzt) oder aus
  let coords = 0;
  if (coordMode === 'perStone') coords = planCoordPages(stonesPerSection, opts.coordLimit, PH).pages;
  else if (coordMode === 'compact') {
    if (facts?.coordPages !== undefined) coords = facts.coordPages;
    else {
      estimated.add('coords');
      coords = estimateCompactCoordPages(compactSections, PW, PH);
    }
  }

  const sectionPages = sectionCovers + sectionSummaries;
  return {
    total: front + sectionPages + sheets + sheetLegends + cutLists + codePlans + templates + coords,
    front,
    sectionCovers,
    sectionSummaries,
    sectionPages,
    sheets,
    sheetLegends,
    cutLists,
    codePlans,
    templates,
    coords,
    estimated: [...estimated],
    sheetPlan: plan,
  };
}
