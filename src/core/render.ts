/**
 * Darstellung des Mosaiks auf einem 2D-Canvas (Bildschirm, Offscreen, PDF-Vorschaubild).
 * Es werden nur sichtbare Zellen gezeichnet (virtuelles Rendering für Millionen Steine).
 */
import { hexToRgb, rgbToHex, textColorFor } from './color';
import { area, bbox, centroid } from './geometry';
import { cellStoneMix, footprints, hexToLinear, linearPalette, linToSrgb8 } from './grout';
import { indexAt, rowLabel, type Layout, type SectionGrid } from './layout';
import { cellPieces } from './pieces';
import type { Range } from './stats';
import { CellKind, type MosaicData, type PaletteColor } from './types';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Rechteck in Bildschirmpixeln (CSS-px) */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Vergleich Foto/Mosaik: das bearbeitete Foto links der Trennlinie (siehe compareSplitX). */
export interface CompareOptions {
  image: CanvasImageSource;
  /** 0…1 – Anteil der sichtbaren Mosaikbreite links der Trennlinie */
  split: number;
  /** Beschriftung links/rechts der Trennlinie (z. B. „Foto“ / „Mosaik“); render.ts selbst ist sprachneutral */
  labels?: { left: string; right: string } | null;
}

export interface View {
  /** Pixel pro Millimeter */
  scale: number;
  /** Pixelposition des Projektursprungs */
  ox: number;
  oy: number;
  width: number;
  height: number;
}

export interface RenderOptions {
  groutHex: string;
  realistic: boolean;
  surface: 'glass' | 'ceramic';
  showCodes: boolean;
  progressMode: boolean;
  sections?: SectionGrid | null;
  selectedSection?: string | null;
  highlight?: { row: number; col: number; piece: number } | null;
  /** nur diese Farbe hervorheben (andere abgeblendet) */
  focusColor?: number | null;
  /**
   * Übersichtsbild (1 Pixel je Zelle, buildOverviewRGBA) für kleine Maßstäbe. Bei focusColor bitte mit
   * dimmedPalette erzeugen, damit die Übersicht die Abblendung zeigt.
   */
  overview?: CanvasImageSource | null;
  /** Fortschritts-Overlay zur Übersicht (buildProgressOverlayRGBA), nur mit progressMode gezeichnet */
  overviewProgress?: CanvasImageSource | null;
  background?: string;
  /**
   * Zeilen-/Spaltenlineal: oben ein Band mit Spaltennummern (col+1), links eines mit Zeilenbuchstaben (rowLabel) –
   * dieselben Bezeichnungen wie in den Stein-IDs (cellId) und im PDF. Beschriftet wird jede Zeile/Spalte ab
   * RULER_MIN_LABEL_PX Abstand, sonst jede 5./10./50. … (rulerLabelStep). Zeile und Spalte von `highlight`
   * sind hervorgehoben. Die Bänder decken RULER_PX (oben) bzw. rulerLeftPx(rows) (links) der Ansicht ab.
   */
  rulers?: boolean;
  /**
   * Nur dieser Zellbereich (z. B. ein Abschnitt) ist aktiv: alles außerhalb wird mit einem halbdeckenden
   * Schleier überdeckt (Steinansicht und Übersicht gleich). Grenze = Fugenmitte um den Bereich.
   */
  focusRange?: Range | null;
  /** Foto/Mosaik-Vergleich: Foto exakt auf der Mosaikfläche (0, 0, finishedW, finishedH) links der Trennlinie */
  compare?: CompareOptions | null;
  /**
   * Nur die Steinebene zeichnen (Hintergrund, Fuge, Steine bzw. Übersicht) – ohne Bereichsfokus, Vergleich,
   * Abschnitte, Auswahl und Lineal. Die zeichnet drawMosaicOverlay darüber (Rückpuffer des Viewers: die Steinebene
   * wird zwischengespeichert, die Überlagerung jedes Bild neu gezeichnet). Ergebnis zusammen = renderMosaic.
   */
  baseOnly?: boolean;
  /**
   * Nur diesen Ausschnitt (CSS-px im Koordinatensystem der Ansicht, darf außerhalb von 0…width/height liegen)
   * zeichnen: Hintergrund und Fuge nur hier, Steine nur, wenn sie ihn berühren können. Pixel außerhalb sind
   * undefiniert – der Aufrufer begrenzt mit clip(). Innerhalb sind sie dieselben wie beim Zeichnen der ganzen Ansicht.
   */
  area?: ScreenRect | null;
  /** Übersicht erzwingen (true, braucht `overview`) oder Steine erzwingen (false); ohne Angabe automatisch wie bisher */
  overviewMode?: boolean;
}

// ---------------------------------------------------------------- Lineal (Zeilen/Spalten)

/** Höhe des oberen Lineals und Mindestbreite des linken Lineals (CSS-px) */
export const RULER_PX = 18;
/** Ab diesem Abstand (CSS-px) zwischen zwei Beschriftungen wird jede Zeile/Spalte beschriftet */
export const RULER_MIN_LABEL_PX = 14;
/** Beschriftungsschritte wie im PDF (pdf.ts labelStep: 1, 5, 10, 50), für große Projekte fortgesetzt */
export const RULER_STEPS = [1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 50000] as const;

/**
 * Jede wievielte Zeile/Spalte beschriftet wird: der kleinste Schritt aus RULER_STEPS, bei dem zwei
 * Beschriftungen mindestens `minSpacingPx` auseinanderliegen. Bei ≥ 14 px Raster also jede, darunter jede
 * 5., 10., 50. … – dieselbe Schrittfolge wie die Verlegeblätter im PDF, dort aus dem Raster auf Papier.
 */
export function rulerLabelStep(pitchPx: number, minSpacingPx: number = RULER_MIN_LABEL_PX): number {
  if (!(pitchPx > 0)) return RULER_STEPS[RULER_STEPS.length - 1];
  for (const s of RULER_STEPS) if (pitchPx * s >= minSpacingPx - 1e-9) return s;
  return RULER_STEPS[RULER_STEPS.length - 1];
}

/**
 * Zu beschriftende Indizes im Bereich [i0, i1): immer die erste Zeile/Spalte des Mosaiks (A bzw. 1) und jede
 * `step`-te wie im PDF ((i + 1) % step === 0 → 5, 10, 15 … bzw. E, J, O …).
 */
export function rulerLabelIndices(i0: number, i1: number, step: number): number[] {
  const out: number[] = [];
  const a = Math.max(0, Math.floor(i0));
  const b = Math.floor(i1);
  if (b <= a) return out;
  if (a === 0) out.push(0);
  const s = Math.max(1, Math.floor(step));
  // erster Index ≥ a mit (i + 1) % s === 0
  let i = Math.ceil((a + 1) / s) * s - 1;
  if (i === 0) i += s; // Index 0 ist schon enthalten
  for (; i < b; i += s) out.push(i);
  return out;
}

/** Spaltenbeschriftung im Lineal: Spaltennummer wie in der Stein-ID (ohne führende Nullen, wie im PDF) */
export function rulerColLabel(col: number): string {
  return String(col + 1);
}

/** Zeilenbeschriftung im Lineal: Buchstaben wie in der Stein-ID (A … Z, AA …) */
export function rulerRowLabel(row: number): string {
  return rowLabel(row);
}

/** Breite des linken Lineals: 18 px für bis zu zwei Buchstaben, je weiterem Buchstaben 6 px mehr */
export function rulerLeftPx(rows: number): number {
  const len = rowLabel(Math.max(0, rows - 1)).length;
  return RULER_PX + Math.max(0, len - 2) * 6;
}

/** Vom Lineal belegte Ränder der Ansicht (oben/links), 0 ohne Lineal */
export function rulerInsets(layout: Pick<Layout, 'rows'>, rulers: boolean | undefined): { top: number; left: number } {
  return rulers ? { top: RULER_PX, left: rulerLeftPx(layout.rows) } : { top: 0, left: 0 };
}

// ---------------------------------------------------------------- Bereichsfokus

/**
 * Weltrechteck (mm) eines Zellbereichs bis zur Fugenmitte ringsum, am Mosaikrand ohne Außenfuge –
 * wie die gezeichneten Abschnittsgrenzen. Leerer Bereich → null.
 */
export function rangeWorldRect(layout: Layout, rg: Range): { x0: number; y0: number; x1: number; y1: number } | null {
  const c0 = Math.max(0, Math.min(layout.cols, Math.floor(rg.c0)));
  const c1 = Math.max(0, Math.min(layout.cols, Math.floor(rg.c1)));
  const r0 = Math.max(0, Math.min(layout.rows, Math.floor(rg.r0)));
  const r1 = Math.max(0, Math.min(layout.rows, Math.floor(rg.r1)));
  if (c1 <= c0 || r1 <= r0) return null;
  const hj = layout.joint / 2;
  return {
    x0: Math.max(0, layout.colX[c0] - hj),
    y0: Math.max(0, layout.rowY[r0] - hj),
    x1: Math.min(layout.finishedW, layout.colX[c1 - 1] + layout.colW[c1 - 1] + hj),
    y1: Math.min(layout.finishedH, layout.rowY[r1 - 1] + layout.rowH[r1 - 1] + hj),
  };
}

/**
 * Bildschirmrechtecke, die die Ansicht außerhalb des Bereichs genau abdecken (oben, unten, links, rechts;
 * ohne Überlappung, leere weggelassen). Zusammen mit dem sichtbaren Teil des Bereichs ergeben sie die
 * ganze Ansicht. Leerer Bereich → die ganze Ansicht.
 */
export function focusOverlayRects(layout: Layout, rg: Range, view: View): ScreenRect[] {
  const W = view.width;
  const H = view.height;
  const wr = rangeWorldRect(layout, rg);
  if (!wr) return W > 0 && H > 0 ? [{ x: 0, y: 0, w: W, h: H }] : [];
  const cl = (v: number, max: number) => Math.max(0, Math.min(max, v));
  const X0 = cl(view.ox + wr.x0 * view.scale, W);
  const X1 = cl(view.ox + wr.x1 * view.scale, W);
  const Y0 = cl(view.oy + wr.y0 * view.scale, H);
  const Y1 = cl(view.oy + wr.y1 * view.scale, H);
  const out: ScreenRect[] = [];
  const push = (x: number, y: number, w: number, h: number) => {
    if (w > 0 && h > 0) out.push({ x, y, w, h });
  };
  push(0, 0, W, Y0);
  push(0, Y1, W, H - Y1);
  push(0, Y0, X0, Y1 - Y0);
  push(X1, Y0, W - X1, Y1 - Y0);
  return out;
}

/** Schleier außerhalb des fokussierten Bereichs (dunkel wie ein Lichtkegel; anders als Verlegt-Ton und Farbfokus) */
export const FOCUS_RANGE_FILL = 'rgba(24,32,44,0.58)';

// ---------------------------------------------------------------- Foto/Mosaik-Vergleich

/** Sichtbarer Teil der Mosaikfläche in Bildschirm-x (CSS-px), oder null, wenn nichts davon sichtbar ist */
export function visibleMosaicSpanX(layout: Pick<Layout, 'finishedW'>, view: View): { x0: number; x1: number } | null {
  const x0 = Math.max(0, view.ox);
  const x1 = Math.min(view.width, view.ox + layout.finishedW * view.scale);
  return x1 > x0 ? { x0, x1 } : null;
}

/**
 * Bildschirm-x der Trennlinie: `split` (0…1) des SICHTBAREN Teils der Mosaikbreite. In der Gesamtansicht ist das
 * der Anteil der Mosaikbreite; hineingezoomt bleibt die Linie so immer im Bild. null = Mosaik nicht sichtbar.
 */
export function compareSplitX(layout: Pick<Layout, 'finishedW'>, view: View, split: number): number | null {
  const s = visibleMosaicSpanX(layout, view);
  if (!s) return null;
  const f = Number.isFinite(split) ? Math.max(0, Math.min(1, split)) : 0.5;
  return s.x0 + f * (s.x1 - s.x0);
}

/** Umkehrung von compareSplitX: Anteil für eine Bildschirm-x (z. B. beim Ziehen der Trennlinie) */
export function compareSplitAt(layout: Pick<Layout, 'finishedW'>, view: View, x: number): number | null {
  const s = visibleMosaicSpanX(layout, view);
  if (!s) return null;
  return Math.max(0, Math.min(1, (x - s.x0) / (s.x1 - s.x0)));
}

/**
 * Bearbeitetes Foto links der Trennlinie, mit derselben Transformation wie die Steine auf das Weltrechteck
 * (0, 0, finishedW, finishedH) gelegt. Deckungsgleich, weil die Berechnung das Foto genau auf diesem Rechteck
 * abtastet (computeMosaic: sx = Bildbreite / finishedW).
 */
function drawComparePhoto(ctx: Ctx2D, layout: Layout, view: View, c: CompareOptions): void {
  const sx = compareSplitX(layout, view, c.split);
  if (sx === null) return;
  const X = view.ox;
  const Y = view.oy;
  const W = layout.finishedW * view.scale;
  const H = layout.finishedH * view.scale;
  const left = Math.max(0, X);
  if (sx <= left) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, Y, sx - left, H);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c.image, X, Y, W, H);
  ctx.restore();
}

/** Trennlinie mit Griff und Beschriftung (über allem, auch über dem Lineal) */
function drawCompareHandle(ctx: Ctx2D, layout: Layout, view: View, c: CompareOptions, top: number): void {
  const sx = compareSplitX(layout, view, c.split);
  if (sx === null) return;
  const x = Math.round(sx) + 0.5;
  const y0 = Math.max(top, view.oy);
  const y1 = Math.min(view.height, view.oy + layout.finishedH * view.scale);
  if (y1 <= y0) return;
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(20,28,40,0.55)';
  ctx.beginPath();
  ctx.moveTo(x, y0);
  ctx.lineTo(x, y1);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  // Griff in der Mitte des sichtbaren Teils
  const cy = (y0 + y1) / 2;
  ctx.beginPath();
  ctx.arc(x, cy, 13, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(20,28,40,0.7)';
  ctx.stroke();
  ctx.fillStyle = '#1d2a3a';
  ctx.beginPath();
  ctx.moveTo(x - 9, cy);
  ctx.lineTo(x - 3, cy - 5);
  ctx.lineTo(x - 3, cy + 5);
  ctx.closePath();
  ctx.moveTo(x + 9, cy);
  ctx.lineTo(x + 3, cy - 5);
  ctx.lineTo(x + 3, cy + 5);
  ctx.closePath();
  ctx.fill();
  if (c.labels) {
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    // unten im sichtbaren Teil: oben links stehen die Abschnittsbezeichnungen
    const ly = y1 - 16;
    const pill = (text: string, right: boolean) => {
      const w = ctx.measureText(text).width + 12;
      const px = right ? x + 6 : x - 6 - w;
      if (px < 0 || px + w > view.width) return;
      ctx.fillStyle = 'rgba(20,28,40,0.72)';
      ctx.fillRect(px, ly - 9, w, 18);
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.fillText(text, px + 6, ly + 0.5);
    };
    if (c.split > 0.001) pill(c.labels.left, false);
    if (c.split < 0.999) pill(c.labels.right, true);
  }
  ctx.restore();
}

const glazeCache = new Map<string, CanvasImageSource>();

/** Vorgerenderte Glasur (Glanzlicht + Kantenschatten) für realistische Steine. */
function glaze(surface: 'glass' | 'ceramic'): CanvasImageSource | null {
  const hit = glazeCache.get(surface);
  if (hit) return hit;
  if (typeof OffscreenCanvas === 'undefined') return null;
  const S = 64;
  const c = new OffscreenCanvas(S, S);
  const g = c.getContext('2d')!;
  const glass = surface === 'glass';
  const lin = g.createLinearGradient(0, 0, S, S);
  lin.addColorStop(0, `rgba(255,255,255,${glass ? 0.32 : 0.14})`);
  lin.addColorStop(0.45, 'rgba(255,255,255,0)');
  lin.addColorStop(1, `rgba(0,0,0,${glass ? 0.22 : 0.14})`);
  g.fillStyle = lin;
  g.fillRect(0, 0, S, S);
  if (glass) {
    const rad = g.createRadialGradient(S * 0.3, S * 0.25, 1, S * 0.3, S * 0.25, S * 0.45);
    rad.addColorStop(0, 'rgba(255,255,255,0.35)');
    rad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rad;
    g.fillRect(0, 0, S, S);
  }
  // feine Kante
  g.strokeStyle = `rgba(0,0,0,${glass ? 0.25 : 0.18})`;
  g.lineWidth = 2;
  g.strokeRect(1, 1, S - 2, S - 2);
  glazeCache.set(surface, c);
  return c;
}

function hash(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Farbvarianten je Palettenfarbe für natürliche Glas-/Keramikstreuung. */
export function colorVariants(palette: PaletteColor[], realistic: boolean): string[][] {
  return palette.map((p) => {
    if (!realistic) return [p.hex];
    const [r, g, b] = hexToRgb(p.hex);
    const out: string[] = [];
    for (let v = 0; v < 6; v++) {
      const f = 1 + (v - 2.5) * 0.018;
      out.push(`rgb(${Math.min(255, Math.round(r * f))},${Math.min(255, Math.round(g * f))},${Math.min(255, Math.round(b * f))})`);
    }
    return out;
  });
}

/** Standard-Fugenfarbe der Vorschau, wenn keine angegeben ist (wie DEFAULT_SETTINGS.groutHex). */
export const DEFAULT_GROUT_HEX = '#BDB8AE';

/**
 * Übersichtsbild: 1 Pixel je Rasterzelle = optische Mischung des Fußabdrucks dieser Zelle, so wie das Auge
 * das Mosaik aus der Entfernung sieht.
 * - Fußabdruck = Zelle plus je die halbe Fuge zu den Nachbarn (keine Außenfuge); Σ = finishedW × finishedH.
 * - Steinfläche: ganze Steine colW·rowH, sonst Σ Fläche der echten Teilpolygone (cellPieces) – geteilte
 *   Zellen werden also nach Fläche gewichtet, nicht 50/50; Freiform-Teile nach ihrer Fläche, nicht nach Anzahl.
 * - Rest des Fußabdrucks = Fuge in `groutHex`.
 * - Gemischt wird in linearem Licht (physikalisch richtig für die Betrachtung aus der Entfernung),
 *   danach zurück nach sRGB. Ohne Fuge und mit ganzen Steinen ist das Pixel exakt die Palettenfarbe.
 * Reine Anzeige: `data` wird nicht verändert.
 */
export function buildOverviewRGBA(layout: Layout, data: MosaicData, palette: PaletteColor[], groutHex: string = DEFAULT_GROUT_HEX): Uint8ClampedArray {
  const { cols, rows } = layout;
  const out = new Uint8ClampedArray(cols * rows * 4);
  const lp = linearPalette(palette);
  const gl = hexToLinear(groutHex) ?? hexToLinear(DEFAULT_GROUT_HEX)!;
  const { fw, fh } = footprints(layout);
  // Ganze Steine: Steinanteil = (colW/fw)·(rowH/fh). Es gibt nur wenige verschiedene Werte (innen, Rand,
  // Randzuschnitt) – je Kombination eine Farbtabelle für alle Palettenfarben, dann ist jede Zelle ein Nachschlagen.
  const classes = (size: Float64Array, foot: Float64Array) => {
    const vals: number[] = [];
    const cls = new Int32Array(size.length);
    for (let i = 0; i < size.length; i++) {
      const v = foot[i] > 0 ? size[i] / foot[i] : 0;
      let k = vals.indexOf(v);
      if (k < 0) {
        k = vals.length;
        vals.push(v);
      }
      cls[i] = k;
    }
    return { vals, cls };
  };
  const cx = classes(layout.colW, fw);
  const cy = classes(layout.rowH, fh);
  const nPal = lp.length;
  const tables = new Map<number, Uint8Array>();
  const tableFor = (ry: number, rx: number): Uint8Array => {
    const key = ry * cx.vals.length + rx;
    let t = tables.get(key);
    if (!t) {
      const f = Math.min(1, cy.vals[ry] * cx.vals[rx]);
      t = new Uint8Array((nPal + 1) * 3);
      for (let ci = 0; ci <= nPal; ci++) {
        const c = ci < nPal ? lp[ci] : OV_MAGENTA;
        for (let k = 0; k < 3; k++) t[ci * 3 + k] = linToSrgb8(f * c[k] + (1 - f) * gl[k]);
      }
      tables.set(key, t);
    }
    return t;
  };
  const mix = new Float64Array(3);
  for (let row = 0; row < rows; row++) {
    const ry = cy.cls[row];
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const o = idx * 4;
      out[o + 3] = 255;
      if (data.kind[idx] === CellKind.FULL) {
        const t = tableFor(ry, cx.cls[col]);
        const ci = data.c1[idx];
        const q = (ci < nPal ? ci : nPal) * 3;
        out[o] = t[q];
        out[o + 1] = t[q + 1];
        out[o + 2] = t[q + 2];
        continue;
      }
      // geteilte, unterteilte und Freiform-Zellen: echte Teilflächen
      const A = fw[col] * fh[row];
      const covered = cellStoneMix(layout, data, lp, row, col, mix);
      const rest = Math.max(0, A - covered);
      const den = Math.max(A, covered);
      for (let k = 0; k < 3; k++) out[o + k] = linToSrgb8(den > 0 ? (mix[k] + rest * gl[k]) / den : gl[k]);
    }
  }
  return out;
}

const OV_MAGENTA: [number, number, number] = [1, 0, 1];

/** Verlegte Steine: entsättigender grau-grüner Schleier (Bildschirm und Übersicht gleich). */
export const LAID_TINT: [number, number, number] = [112, 146, 122];
export const LAID_ALPHA = 0.62;
const LAID_FILL = `rgba(${LAID_TINT[0]},${LAID_TINT[1]},${LAID_TINT[2]},${LAID_ALPHA})`;
/**
 * Abblenden nicht hervorgehobener Farben (focusColor) – ein GRAUER Schleier: der Stein wird zuerst entsättigt
 * (Canvas-Mischmodus „saturation“ mit Grau = Helligkeit Lum = 0,3·R + 0,59·G + 0,11·B) und dann mit dieser
 * Deckkraft zu einem neutralen Grau hin überblendet. Abgeblendete Steine sind so farblos und nicht mit dem
 * grau-grünen Verlegt-Ton (LAID_TINT) zu verwechseln.
 * Das Grau richtet sich nach der hervorgehobenen Farbe: zu einer dunklen/mittleren Farbe hin Weiß (abgeblendete
 * Steine werden hellgrau, 199…255), zu einer hellen Farbe hin Dunkelgrau (43…100) – die hervorgehobene Farbe
 * hebt sich damit immer ab, auch wenn sie selbst fast weiß ist.
 */
export const DIM_ALPHA = 0.78;
/** Ziel-Grau des Schleiers bei dunkler/mittlerer bzw. heller hervorgehobener Farbe */
export const DIM_WASH_LIGHT = 255;
export const DIM_WASH_DARK = 56;
/** Helligkeit (Lum, 0…255), ab der die hervorgehobene Farbe als hell gilt (Mitte zwischen beiden Schleierbereichen) */
export const DIM_LIGHT_FOCUS_LUM = 149;

/** Helligkeit wie im Canvas-Mischmodus „saturation“/„luminosity“ (W3C Compositing: 0,3·R + 0,59·G + 0,11·B) */
export function blendLum(r: number, g: number, b: number): number {
  return 0.3 * r + 0.59 * g + 0.11 * b;
}

/** Ziel-Grau des Abblend-Schleiers für diese hervorgehobene Farbe (siehe DIM_ALPHA) */
export function dimWashGrey(palette: PaletteColor[], focus: number | null | undefined): number {
  const p = focus !== null && focus !== undefined ? palette[focus] : undefined;
  if (!p) return DIM_WASH_LIGHT;
  try {
    const [r, g, b] = hexToRgb(p.hex);
    return blendLum(r, g, b) > DIM_LIGHT_FOCUS_LUM ? DIM_WASH_DARK : DIM_WASH_LIGHT;
  } catch {
    return DIM_WASH_LIGHT;
  }
}

/** Abgeblendete Farbe (sRGB 0…255) eines Steins: entsättigt, dann zum Grau `wash` hin überblendet */
export function dimmedRgb(rgb: readonly [number, number, number], wash: number): [number, number, number] {
  const L = Math.max(0, Math.min(255, blendLum(rgb[0], rgb[1], rgb[2])));
  const v = L * (1 - DIM_ALPHA) + wash * DIM_ALPHA;
  return [v, v, v];
}

/**
 * Palette für die Übersicht bei hervorgehobener Farbe: alle anderen Farben so, wie die Steinansicht sie mit dem
 * grauen Schleier zeigt (Entsättigung + Überblendung in sRGB wie im Canvas). Die Fuge wird – wie in der
 * Steinansicht – nicht abgeblendet.
 */
export function dimmedPalette(palette: PaletteColor[], focus: number): PaletteColor[] {
  const wash = dimWashGrey(palette, focus);
  return palette.map((p, i) => {
    if (i === focus) return p;
    let rgb: [number, number, number];
    try {
      rgb = hexToRgb(p.hex);
    } catch {
      return p;
    }
    const [r, g, b] = dimmedRgb(rgb, wash);
    return { ...p, hex: rgbToHex(r, g, b) };
  });
}

/** Grauen Schleier auf das aktuelle Rechteck/den aktuellen Pfad legen (Steinansicht) */
function dimShape(ctx: Ctx2D, washFill: string, rect: [number, number, number, number] | null): void {
  const op = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'saturation';
  ctx.fillStyle = '#808080';
  if (rect) ctx.fillRect(rect[0], rect[1], rect[2], rect[3]);
  else ctx.fill();
  ctx.globalCompositeOperation = op;
  ctx.fillStyle = washFill;
  if (rect) ctx.fillRect(rect[0], rect[1], rect[2], rect[3]);
  else ctx.fill();
}

/**
 * Fortschritts-Overlay für die Übersicht: 1 Pixel je Zelle im Farbton LAID_TINT mit der Deckkraft
 * LAID_ALPHA × (verlegte Steinfläche ÷ Fußabdruck) – so sieht ein verlegter Bereich aus der Entfernung
 * genauso aus wie in der Steinansicht (dort wird nur der Stein getönt, nicht die Fuge).
 * `any` = mindestens ein Stein verlegt.
 */
export function buildProgressOverlayRGBA(layout: Layout, data: MosaicData): { rgba: Uint8ClampedArray; any: boolean } {
  const { cols, rows } = layout;
  const out = new Uint8ClampedArray(cols * rows * 4);
  const { fw, fh } = footprints(layout);
  let any = false;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const prog = data.progress[idx];
      if (!prog) continue;
      let laid = 0;
      if (data.kind[idx] === CellKind.FULL) {
        if (prog & 1) laid = layout.colW[col] * layout.rowH[row];
      } else {
        const ps = cellPieces(layout, data, row, col);
        for (let i = 0; i < ps.length; i++) if ((prog >> i) & 1) laid += area(ps[i].poly);
      }
      if (!(laid > 0)) continue;
      any = true;
      const A = fw[col] * fh[row];
      const o = idx * 4;
      out[o] = LAID_TINT[0];
      out[o + 1] = LAID_TINT[1];
      out[o + 2] = LAID_TINT[2];
      out[o + 3] = Math.round(255 * LAID_ALPHA * Math.min(1, A > 0 ? laid / A : 1));
    }
  }
  return { rgba: out, any };
}

/** Pixel je Steinraster (kleinere Steinseite + Fuge) bei diesem Maßstab. */
export function pitchPxOf(layout: Layout, scale: number): number {
  return (Math.min(layout.tileW, layout.tileH) + layout.joint) * scale;
}

/** Zeichnet renderMosaic bei dieser Ansicht das Übersichtsbild (statt einzelner Steine)? */
export function overviewActive(layout: Layout, view: View): boolean {
  if (pitchPxOf(layout, view.scale) < 3) return true;
  const vr = visibleRange(layout, view);
  return (vr.r1 - vr.r0) * (vr.c1 - vr.c0) > 400_000;
}

export function visibleRange(layout: Layout, view: View): { r0: number; r1: number; c0: number; c1: number } {
  const x0 = (0 - view.ox) / view.scale;
  const x1 = (view.width - view.ox) / view.scale;
  const y0 = (0 - view.oy) / view.scale;
  const y1 = (view.height - view.oy) / view.scale;
  const clampIdx = (pos: Float64Array, size: Float64Array, v: number, n: number) => {
    if (v <= pos[0]) return 0;
    if (v >= pos[n - 1] + size[n - 1]) return n - 1;
    const i = indexAt(pos, size, v, layout.joint);
    return i < 0 ? 0 : i;
  };
  return {
    c0: clampIdx(layout.colX, layout.colW, x0, layout.cols),
    c1: clampIdx(layout.colX, layout.colW, x1, layout.cols) + 1,
    r0: clampIdx(layout.rowY, layout.rowH, y0, layout.rows),
    r1: clampIdx(layout.rowY, layout.rowH, y1, layout.rows) + 1,
  };
}

/**
 * Wie weit (CSS-px) die Zeichnung eines Steins höchstens über sein Zellrechteck hinausreicht: Kantenlinie der
 * Glasur samt Gehrung und Kantenglättung, Farbcode. Großzügig ein ganzes Raster plus 2 px – so hängt das Bild
 * nicht davon ab, welche Zellen beim Zeichnen ausgewählt wurden (Rückpuffer: Streifen = ganzes Bild).
 */
export function drawPadPx(layout: Layout, scale: number): number {
  return (Math.max(layout.tileW, layout.tileH) + layout.joint) * scale + 2;
}

/**
 * Zellen, deren Zeichnung das Rechteck (CSS-px der Ansicht) berühren kann: alle Zellen, deren Rechteck
 * – um drawPadPx erweitert – es schneidet. Halboffen [r0, r1) × [c0, c1); leer, wenn r1 ≤ r0 oder c1 ≤ c0.
 */
export function drawRange(layout: Layout, view: View, area: ScreenRect): { r0: number; r1: number; c0: number; c1: number } {
  const pad = drawPadPx(layout, view.scale);
  const x0 = (area.x - pad - view.ox) / view.scale;
  const x1 = (area.x + area.w + pad - view.ox) / view.scale;
  const y0 = (area.y - pad - view.oy) / view.scale;
  const y1 = (area.y + area.h + pad - view.oy) / view.scale;
  return { ...spanOf(layout.colX, layout.colW, layout.cols, x0, x1, 'c'), ...spanOf(layout.rowY, layout.rowH, layout.rows, y0, y1, 'r') };
}

/** Indizes [i0, i1) der Zellen, die das offene Intervall (a, b) in mm schneiden (binäre Suche) */
function spanOf<K extends 'c' | 'r'>(pos: Float64Array, size: Float64Array, n: number, a: number, b: number, k: K): Record<`${K}0` | `${K}1`, number> {
  // erste Zelle, deren Ende > a
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pos[mid] + size[mid] > a) hi = mid;
    else lo = mid + 1;
  }
  const i0 = lo;
  // erste Zelle, deren Anfang ≥ b
  lo = i0;
  hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pos[mid] >= b) hi = mid;
    else lo = mid + 1;
  }
  return { [`${k}0`]: i0, [`${k}1`]: Math.max(i0, lo) } as Record<`${K}0` | `${K}1`, number>;
}

/** Rückgabe von renderMosaic: was zusätzlich gezeichnet wurde */
export interface RenderInfo {
  /** gezeichnete Linealbeschriftungen (null ohne Lineal) */
  rulers: RulerPlan | null;
}

export function renderMosaic(ctx: Ctx2D, layout: Layout, data: MosaicData, palette: PaletteColor[], view: View, opt: RenderOptions): RenderInfo {
  const { scale, ox, oy } = view;
  const area: ScreenRect = opt.area ?? { x: 0, y: 0, w: view.width, h: view.height };
  ctx.save();
  ctx.fillStyle = opt.background ?? '#e9e5de';
  ctx.fillRect(area.x, area.y, area.w, area.h);
  // Fugenfläche = gesamte Mosaikfläche in Fugenfarbe
  ctx.fillStyle = opt.groutHex;
  ctx.fillRect(ox, oy, layout.finishedW * scale, layout.finishedH * scale);

  const pitchPx = pitchPxOf(layout, scale);
  const auto = () => {
    const vr = visibleRange(layout, view);
    return pitchPx < 3 || (vr.r1 - vr.r0) * (vr.c1 - vr.c0) > 400_000;
  };

  if ((opt.overviewMode ?? auto()) && opt.overview) {
    ctx.imageSmoothingEnabled = pitchPx < 1;
    ctx.drawImage(opt.overview, ox, oy, layout.finishedW * scale, layout.finishedH * scale);
    // verlegte Steine bleiben auch in der Übersicht sichtbar
    if (opt.progressMode && opt.overviewProgress) ctx.drawImage(opt.overviewProgress, ox, oy, layout.finishedW * scale, layout.finishedH * scale);
    ctx.imageSmoothingEnabled = true;
  } else {
    const variants = colorVariants(palette, opt.realistic && pitchPx >= 4);
    const drawHighlights = opt.realistic && pitchPx >= 9;
    const hiA = opt.surface === 'glass' ? 0.22 : 0.1;
    const gl = drawHighlights ? glaze(opt.surface) : null;
    const codeFont = opt.showCodes && pitchPx >= 18;
    const dim = opt.focusColor !== undefined && opt.focusColor !== null;
    const washGrey = dim ? dimWashGrey(palette, opt.focusColor) : DIM_WASH_LIGHT;
    const DIM_FILL = `rgba(${washGrey},${washGrey},${washGrey},${DIM_ALPHA})`;
    const checkInk = opt.progressMode ? checkInks(palette) : null;
    // alle Zellen, deren Zeichnung den Ausschnitt berühren kann (auch Kanten knapp außerhalb liegender Nachbarn):
    // so ist jedes Pixel unabhängig davon, welcher Ausschnitt gezeichnet wird
    const vr = drawRange(layout, view, area);
    for (let row = vr.r0; row < vr.r1; row++) {
      for (let col = vr.c0; col < vr.c1; col++) {
        const idx = row * layout.cols + col;
        const kind = data.kind[idx];
        const prog = data.progress[idx];
        if (kind === CellKind.FULL) {
          const ci = data.c1[idx];
          const vs = variants[ci] ?? ['#ff00ff'];
          const x = ox + layout.colX[col] * scale;
          const y = oy + layout.rowY[row] * scale;
          const w = layout.colW[col] * scale;
          const h = layout.rowH[row] * scale;
          ctx.fillStyle = vs[Math.floor(hash(idx) * vs.length)];
          ctx.fillRect(x, y, w, h);
          if (gl) ctx.drawImage(gl, x, y, w, h);
          if (dim && ci !== opt.focusColor) dimShape(ctx, DIM_FILL, [x, y, w, h]);
          if (opt.progressMode && prog & 1) {
            ctx.fillStyle = LAID_FILL;
            ctx.fillRect(x, y, w, h);
            drawCheck(ctx, x, y, w, h, checkInk?.[ci] ?? CHECK_DARK);
          }
          if (codeFont) drawCode(ctx, palette[ci], x + w / 2, y + h / 2, Math.min(w, h));
        } else {
          const ps = cellPieces(layout, data, row, col);
          for (let i = 0; i < ps.length; i++) {
            const p = ps[i];
            const vs = variants[p.color] ?? ['#ff00ff'];
            ctx.beginPath();
            p.poly.forEach((pt, k) => {
              const X = ox + pt.x * scale;
              const Y = oy + pt.y * scale;
              if (k === 0) ctx.moveTo(X, Y);
              else ctx.lineTo(X, Y);
            });
            ctx.closePath();
            ctx.fillStyle = vs[Math.floor(hash(idx * 16 + i) * vs.length)];
            ctx.fill();
            if (gl) {
              const pb = bbox(p.poly);
              ctx.save();
              ctx.clip();
              ctx.drawImage(gl, ox + pb.minX * scale, oy + pb.minY * scale, pb.w * scale, pb.h * scale);
              ctx.restore();
              ctx.strokeStyle = `rgba(255,255,255,${hiA * 0.6})`;
              ctx.lineWidth = Math.max(0.5, pitchPx * 0.03);
              ctx.stroke();
            }
            const b = bbox(p.poly);
            if (dim && p.color !== opt.focusColor) dimShape(ctx, DIM_FILL, null);
            if (opt.progressMode && (prog >> i) & 1) {
              ctx.fillStyle = LAID_FILL;
              ctx.fill();
            }
            if (codeFont && Math.min(b.w, b.h) * scale >= 12) {
              const c = centroid(p.poly);
              drawCode(ctx, palette[p.color], ox + c.x * scale, oy + c.y * scale, Math.min(b.w, b.h) * scale * 0.8);
            }
          }
          if (opt.progressMode && ps.length && (prog & ((1 << ps.length) - 1)) === (1 << ps.length) - 1) {
            drawCheck(
              ctx,
              ox + layout.colX[col] * scale,
              oy + layout.rowY[row] * scale,
              layout.colW[col] * scale,
              layout.rowH[row] * scale,
              checkInk?.[ps[0].color] ?? CHECK_DARK,
            );
          }
        }
      }
    }
  }

  const info: RenderInfo = opt.baseOnly ? { rulers: null } : drawMosaicOverlay(ctx, layout, data, view, opt);
  ctx.restore();
  return info;
}

/**
 * Überlagerung über der Steinebene: Bereichsfokus, Foto-Vergleich, Abschnittsgrenzen, Auswahl, Lineal und
 * Vergleichs-Trennlinie – in dieser Reihenfolge, genau wie am Ende von renderMosaic. Der Viewer zeichnet damit
 * jedes Bild über die zwischengespeicherte Steinebene (renderMosaic mit baseOnly).
 */
export function drawMosaicOverlay(
  ctx: Ctx2D,
  layout: Layout,
  data: MosaicData,
  view: View,
  opt: Pick<RenderOptions, 'sections' | 'selectedSection' | 'highlight' | 'rulers' | 'focusRange' | 'compare'>,
): RenderInfo {
  const { scale, ox, oy } = view;
  ctx.save();
  // Bereichsfokus: Schleier außerhalb (Steinansicht und Übersicht)
  if (opt.focusRange) {
    ctx.fillStyle = FOCUS_RANGE_FILL;
    for (const r of focusOverlayRects(layout, opt.focusRange, view)) ctx.fillRect(r.x, r.y, r.w, r.h);
  }

  // Foto/Mosaik-Vergleich: Foto links der Trennlinie
  if (opt.compare) drawComparePhoto(ctx, layout, view, opt.compare);

  // Abschnittsgrenzen
  if (opt.sections) {
    const G = opt.sections;
    ctx.lineWidth = Math.max(1, Math.min(3, scale * 0.6));
    for (const s of G.sections) {
      const x = ox + (s.x - layout.joint / 2) * scale;
      const y = oy + (s.y - layout.joint / 2) * scale;
      const w = (s.w + layout.joint) * scale;
      const h = (s.h + layout.joint) * scale;
      if (x > view.width || y > view.height || x + w < 0 || y + h < 0) continue;
      const sel = opt.selectedSection === s.id;
      ctx.strokeStyle = sel ? 'rgba(230,80,40,0.95)' : 'rgba(20,30,50,0.7)';
      ctx.setLineDash(sel ? [] : [6, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
      const fs = Math.max(10, Math.min(28, Math.min(w, h) / 6));
      ctx.font = `600 ${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const tw = ctx.measureText(s.id).width;
      ctx.fillStyle = sel ? 'rgba(230,80,40,0.9)' : 'rgba(20,30,50,0.75)';
      ctx.fillRect(x + 4, y + 4, tw + 10, fs + 6);
      ctx.fillStyle = '#fff';
      ctx.fillText(s.id, x + 9, y + 7);
    }
  }

  // Auswahl
  if (opt.highlight) {
    const { row, col, piece } = opt.highlight;
    if (row >= 0 && row < layout.rows && col >= 0 && col < layout.cols) {
      const ps = cellPieces(layout, data, row, col);
      const p = ps[piece] ?? ps[0];
      if (p) {
        ctx.beginPath();
        p.poly.forEach((pt, k) => {
          const X = ox + pt.x * scale;
          const Y = oy + pt.y * scale;
          if (k === 0) ctx.moveTo(X, Y);
          else ctx.lineTo(X, Y);
        });
        ctx.closePath();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#ff3d00';
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    }
  }

  const rulers = opt.rulers ? drawRulers(ctx, layout, view, opt.highlight ?? null, opt.focusRange ?? null) : null;
  if (opt.compare) drawCompareHandle(ctx, layout, view, opt.compare, opt.rulers ? RULER_PX : 0);
  ctx.restore();
  return { rulers };
}

const RULER_BAND = 'rgba(250,248,244,0.95)';
const RULER_EDGE = 'rgba(29,42,58,0.28)';
const RULER_INK = '#1d2a3a';
const RULER_TICK = 'rgba(29,42,58,0.45)';
const RULER_TICK_MINOR = 'rgba(29,42,58,0.2)';
const RULER_HL = '#b6452b';
const RULER_FOCUS = 'rgba(182,69,43,0.16)';

/** Schrift so verkleinern, dass `text` in `maxW` passt (mind. 6 px) */
function fitFont(ctx: Ctx2D, text: string, sizePx: number, maxW: number): number {
  let fs = sizePx;
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  if (w > maxW && w > 0) {
    fs = Math.max(6, (sizePx * maxW) / w);
    ctx.font = `600 ${fs}px system-ui, sans-serif`;
  }
  return fs;
}

/** Eine Linealbeschriftung: Zeilen-/Spaltenindex, Text, Mitte auf dem Bildschirm (x bzw. y in CSS-px) */
export interface RulerLabel {
  index: number;
  label: string;
  pos: number;
}

/** Was das Lineal bei dieser Ansicht zeigt (ohne Zeichnen; von drawRulers verwendet und getestet) */
export interface RulerPlan {
  top: number;
  left: number;
  colStep: number;
  rowStep: number;
  cols: RulerLabel[];
  rows: RulerLabel[];
}

/**
 * Linealbeschriftungen für eine Ansicht: sichtbare Zeilen/Spalten (visibleRange), Schritt nach rulerLabelStep
 * mit dem Raster (Stein + Fuge) als Abstand, Position = Zellmitte (colX + colW/2 bzw. rowY + rowH/2).
 * `colLabelPx`: Breite der breitesten Spaltennummer, `rowLabelPx`: Schrifthöhe der Zeilenbuchstaben – größere
 * Beschriftungen bekommen entsprechend mehr Abstand. Beschriftungen unter dem jeweils anderen Band entfallen.
 */
export function rulerPlan(layout: Layout, view: View, colLabelPx = 12, rowLabelPx = 10): RulerPlan {
  const top = RULER_PX;
  const left = rulerLeftPx(layout.rows);
  const { scale, ox, oy } = view;
  const vr = visibleRange(layout, view);
  const colStep = rulerLabelStep((layout.tileW + layout.joint) * scale, Math.max(RULER_MIN_LABEL_PX, colLabelPx + 4));
  const rowStep = rulerLabelStep((layout.tileH + layout.joint) * scale, Math.max(RULER_MIN_LABEL_PX, rowLabelPx + 4));
  const cols: RulerLabel[] = [];
  for (const c of rulerLabelIndices(vr.c0, vr.c1, colStep)) {
    const x = ox + (layout.colX[c] + layout.colW[c] / 2) * scale;
    if (x < left || x > view.width) continue;
    cols.push({ index: c, label: rulerColLabel(c), pos: x });
  }
  const rows: RulerLabel[] = [];
  for (const r of rulerLabelIndices(vr.r0, vr.r1, rowStep)) {
    const y = oy + (layout.rowY[r] + layout.rowH[r] / 2) * scale;
    if (y < top || y > view.height) continue;
    rows.push({ index: r, label: rulerRowLabel(r), pos: y });
  }
  return { top, left, colStep, rowStep, cols, rows };
}

/**
 * Zeilen-/Spaltenlineal (siehe RenderOptions.rulers). Beschriftungen stehen in der Mitte ihrer Zelle
 * (colX + colW/2 bzw. rowY + rowH/2) und lauten genau wie die Teile der Stein-ID. Gibt die gezeichneten
 * Beschriftungen zurück (für Tests und Barrierefreiheit).
 */
function drawRulers(ctx: Ctx2D, layout: Layout, view: View, hl: { row: number; col: number } | null, focus: Range | null): RulerPlan | null {
  const { scale, ox, oy } = view;
  const W = view.width;
  const H = view.height;
  const top = RULER_PX;
  const left = rulerLeftPx(layout.rows);
  if (W <= left || H <= top) return null;
  ctx.save();
  // Bänder
  ctx.fillStyle = RULER_BAND;
  ctx.fillRect(0, 0, W, top);
  ctx.fillRect(0, top, left, H - top);
  ctx.fillStyle = RULER_EDGE;
  ctx.fillRect(0, top - 1, W, 1);
  ctx.fillRect(left - 1, top, 1, H - top);
  // fokussierter Bereich: seine Spalten und Zeilen im Lineal hinterlegt
  const fr = focus ? rangeWorldRect(layout, focus) : null;
  if (fr) {
    ctx.fillStyle = RULER_FOCUS;
    const fx0 = Math.max(left, ox + fr.x0 * scale);
    const fx1 = Math.min(W, ox + fr.x1 * scale);
    if (fx1 > fx0) ctx.fillRect(fx0, 0, fx1 - fx0, top - 1);
    const fy0 = Math.max(top, oy + fr.y0 * scale);
    const fy1 = Math.min(H, oy + fr.y1 * scale);
    if (fy1 > fy0) ctx.fillRect(0, fy0, left - 1, fy1 - fy0);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const colPitch = (layout.tileW + layout.joint) * scale;
  const rowPitch = (layout.tileH + layout.joint) * scale;
  // stark hineingezoomt etwas größere Schrift
  const colFs = colPitch >= 28 ? 10.5 : 9.5;
  ctx.font = `600 ${colFs}px system-ui, sans-serif`;
  const colLabelW = ctx.measureText(rulerColLabel(layout.cols - 1)).width;
  const rowFs = fitFont(ctx, rulerRowLabel(layout.rows - 1), rowPitch >= 28 ? 10.5 : 9.5, left - 4);
  const plan = rulerPlan(layout, view, colLabelW, rowFs);
  const hlCol = hl && hl.col >= 0 && hl.col < layout.cols ? hl.col : -1;
  const hlRow = hl && hl.row >= 0 && hl.row < layout.rows ? hl.row : -1;

  // ---- Spalten (oben)
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, 0, W - left, top);
  ctx.clip();
  ctx.font = `600 ${colFs}px system-ui, sans-serif`;
  const colCenter = (c: number) => ox + (layout.colX[c] + layout.colW[c] / 2) * scale;
  let hlColBox: [number, number] | null = null;
  if (hlCol >= 0) {
    const x0 = ox + layout.colX[hlCol] * scale;
    const x1 = ox + (layout.colX[hlCol] + layout.colW[hlCol]) * scale;
    const tw = ctx.measureText(rulerColLabel(hlCol)).width + 6;
    const cx = (x0 + x1) / 2;
    const bw = Math.max(x1 - x0, tw);
    hlColBox = [cx - bw / 2 - 2, cx + bw / 2 + 2];
  }
  if (colPitch >= 4) {
    const vr = visibleRange(layout, view);
    ctx.fillStyle = RULER_TICK_MINOR;
    for (let c = vr.c0; c < vr.c1; c++) ctx.fillRect(Math.round(colCenter(c)) - 0.5, top - 3, 1, 2);
  }
  const cols = plan.cols.filter((l) => !(hlColBox && l.pos + colLabelW / 2 > hlColBox[0] && l.pos - colLabelW / 2 < hlColBox[1]));
  for (const l of cols) {
    ctx.fillStyle = RULER_TICK;
    ctx.fillRect(Math.round(l.pos) - 0.5, top - 5, 1, 4);
    ctx.fillStyle = RULER_INK;
    ctx.fillText(l.label, l.pos, 8);
  }
  if (hlCol >= 0 && hlColBox) {
    ctx.fillStyle = RULER_HL;
    ctx.fillRect(hlColBox[0], 0, hlColBox[1] - hlColBox[0], top - 1);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(rulerColLabel(hlCol), (hlColBox[0] + hlColBox[1]) / 2, 8.5);
  }
  ctx.restore();

  // ---- Zeilen (links)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, left, H - top);
  ctx.clip();
  ctx.font = `600 ${rowFs}px system-ui, sans-serif`;
  const rowCenter = (r: number) => oy + (layout.rowY[r] + layout.rowH[r] / 2) * scale;
  let hlRowBox: [number, number] | null = null;
  if (hlRow >= 0) {
    const y0 = oy + layout.rowY[hlRow] * scale;
    const y1 = oy + (layout.rowY[hlRow] + layout.rowH[hlRow]) * scale;
    const cy = (y0 + y1) / 2;
    const bh = Math.max(y1 - y0, rowFs + 6);
    hlRowBox = [cy - bh / 2 - 2, cy + bh / 2 + 2];
  }
  if (rowPitch >= 4) {
    const vr = visibleRange(layout, view);
    ctx.fillStyle = RULER_TICK_MINOR;
    for (let r = vr.r0; r < vr.r1; r++) ctx.fillRect(left - 3, Math.round(rowCenter(r)) - 0.5, 2, 1);
  }
  const rows = plan.rows.filter((l) => !(hlRowBox && l.pos + rowFs / 2 > hlRowBox[0] && l.pos - rowFs / 2 < hlRowBox[1]));
  for (const l of rows) {
    ctx.fillStyle = RULER_TICK;
    ctx.fillRect(left - 5, Math.round(l.pos) - 0.5, 4, 1);
    ctx.fillStyle = RULER_INK;
    ctx.fillText(l.label, (left - 4) / 2, l.pos + 0.5);
  }
  if (hlRow >= 0 && hlRowBox) {
    ctx.fillStyle = RULER_HL;
    ctx.fillRect(0, hlRowBox[0], left - 1, hlRowBox[1] - hlRowBox[0]);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(rulerRowLabel(hlRow), (left - 1) / 2, (hlRowBox[0] + hlRowBox[1]) / 2 + 0.5);
  }
  ctx.restore();

  // Ecke
  ctx.fillStyle = RULER_BAND;
  ctx.fillRect(0, 0, left, top);
  ctx.fillStyle = RULER_EDGE;
  ctx.fillRect(0, top - 1, left, 1);
  ctx.fillRect(left - 1, 0, 1, top);
  ctx.restore();
  return { ...plan, cols, rows };
}

function drawCode(ctx: Ctx2D, p: PaletteColor | undefined, x: number, y: number, size: number) {
  if (!p) return;
  const fs = Math.max(7, Math.min(22, size * 0.42));
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = textColorFor(p.hex);
  ctx.fillText(String(p.code).padStart(2, '0'), x, y);
}

const CHECK_DARK = '#155f2b';
const CHECK_LIGHT = '#ffffff';

/** Farbe des Häkchens je Palettenfarbe: hell auf dunkel getönten Steinen, sonst dunkelgrün. */
function checkInks(palette: PaletteColor[]): string[] {
  return palette.map((p) => {
    let rgb: [number, number, number];
    try {
      rgb = hexToRgb(p.hex);
    } catch {
      return CHECK_DARK;
    }
    // Farbe des getönten Steins (Überblendung wie im Canvas) → relative Helligkeit
    const lin = rgb.map((v, k) => {
      const c = (v * (1 - LAID_ALPHA) + LAID_TINT[k] * LAID_ALPHA) / 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    const Y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return Y < 0.16 ? CHECK_LIGHT : CHECK_DARK;
  });
}

/** Häkchen für einen verlegten Stein (ab 6 px Kantenlänge). */
function drawCheck(ctx: Ctx2D, x: number, y: number, w: number, h: number, ink: string) {
  if (Math.min(w, h) < 6) return;
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(1.2, Math.min(w, h) * 0.11);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x + w * 0.25, y + h * 0.55);
  ctx.lineTo(x + w * 0.43, y + h * 0.72);
  ctx.lineTo(x + w * 0.76, y + h * 0.3);
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
}

/** Rendert das gesamte Mosaik in ein Offscreen-Canvas (für PDF und Miniaturen). */
export function renderFull(
  layout: Layout,
  data: MosaicData,
  palette: PaletteColor[],
  maxPx: number,
  opt: Partial<RenderOptions> = {},
): OffscreenCanvas {
  const scale = Math.min(maxPx / layout.finishedW, maxPx / layout.finishedH);
  const W = Math.max(1, Math.round(layout.finishedW * scale));
  const H = Math.max(1, Math.round(layout.finishedH * scale));
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext('2d')!;
  const groutHex = opt.groutHex ?? DEFAULT_GROUT_HEX;
  const view: View = { scale, ox: 0, oy: 0, width: W, height: H };
  let overview: OffscreenCanvas | null = null;
  let overviewProgress: OffscreenCanvas | null = null;
  // Wie bisher nur bei sehr kleinem Maßstab: sonst zeichnet die Vorschau (PDF, Miniatur) jeden Stein mit Fuge
  if (pitchPxOf(layout, scale) < 3) {
    const focus = opt.focusColor;
    const pal = focus !== undefined && focus !== null ? dimmedPalette(palette, focus) : palette;
    overview = new OffscreenCanvas(layout.cols, layout.rows);
    const rgba = buildOverviewRGBA(layout, data, pal, groutHex);
    overview.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, layout.cols, layout.rows), 0, 0);
    if (opt.progressMode) {
      const pr = buildProgressOverlayRGBA(layout, data);
      if (pr.any) {
        overviewProgress = new OffscreenCanvas(layout.cols, layout.rows);
        overviewProgress.getContext('2d')!.putImageData(new ImageData(pr.rgba as Uint8ClampedArray<ArrayBuffer>, layout.cols, layout.rows), 0, 0);
      }
    }
  }
  renderMosaic(ctx, layout, data, palette, view, {
    groutHex,
    realistic: opt.realistic ?? true,
    surface: opt.surface ?? 'glass',
    showCodes: opt.showCodes ?? false,
    progressMode: opt.progressMode ?? false,
    sections: opt.sections ?? null,
    focusColor: opt.focusColor ?? null,
    overview,
    overviewProgress,
    background: groutHex,
  });
  return cv;
}
