/**
 * Darstellung des Mosaiks auf einem 2D-Canvas (Bildschirm, Offscreen, PDF-Vorschaubild).
 * Es werden nur sichtbare Zellen gezeichnet (virtuelles Rendering für Millionen Steine).
 */
import { hexToRgb, rgbToHex, textColorFor } from './color';
import { area, bbox, centroid } from './geometry';
import { cellStoneMix, footprints, hexToLinear, linearPalette, linToSrgb8 } from './grout';
import { indexAt, type Layout, type SectionGrid } from './layout';
import { cellPieces } from './pieces';
import { CellKind, type MosaicData, type PaletteColor } from './types';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

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
/** Abblenden nicht hervorgehobener Farben (focusColor): Weiß mit dieser Deckkraft darüber. */
export const DIM_ALPHA = 0.78;
const DIM_FILL = `rgba(255,255,255,${DIM_ALPHA})`;

/**
 * Palette für die Übersicht bei hervorgehobener Farbe: alle anderen Farben so aufgehellt, wie die
 * Steinansicht sie mit dem weißen Schleier zeigt (Überblendung in sRGB wie im Canvas).
 */
export function dimmedPalette(palette: PaletteColor[], focus: number): PaletteColor[] {
  return palette.map((p, i) => {
    if (i === focus) return p;
    let rgb: [number, number, number];
    try {
      rgb = hexToRgb(p.hex);
    } catch {
      return p;
    }
    const [r, g, b] = rgb.map((v) => v * (1 - DIM_ALPHA) + 255 * DIM_ALPHA);
    return { ...p, hex: rgbToHex(r, g, b) };
  });
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

export function renderMosaic(ctx: Ctx2D, layout: Layout, data: MosaicData, palette: PaletteColor[], view: View, opt: RenderOptions): void {
  const { scale, ox, oy } = view;
  ctx.save();
  ctx.fillStyle = opt.background ?? '#e9e5de';
  ctx.fillRect(0, 0, view.width, view.height);
  // Fugenfläche = gesamte Mosaikfläche in Fugenfarbe
  ctx.fillStyle = opt.groutHex;
  ctx.fillRect(ox, oy, layout.finishedW * scale, layout.finishedH * scale);

  const pitchPx = pitchPxOf(layout, scale);
  const vr = visibleRange(layout, view);
  const cellCount = (vr.r1 - vr.r0) * (vr.c1 - vr.c0);

  if ((pitchPx < 3 || cellCount > 400_000) && opt.overview) {
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
    const checkInk = opt.progressMode ? checkInks(palette) : null;
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
          if (dim && ci !== opt.focusColor) {
            ctx.fillStyle = DIM_FILL;
            ctx.fillRect(x, y, w, h);
          }
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
            if (dim && p.color !== opt.focusColor) {
              ctx.fillStyle = DIM_FILL;
              ctx.fill();
            }
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
  ctx.restore();
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
