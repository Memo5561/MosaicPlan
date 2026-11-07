/**
 * Darstellung des Mosaiks auf einem 2D-Canvas (Bildschirm, Offscreen, PDF-Vorschaubild).
 * Es werden nur sichtbare Zellen gezeichnet (virtuelles Rendering für Millionen Steine).
 */
import { hexToRgb, textColorFor } from './color';
import { bbox, centroid } from './geometry';
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
  overview?: CanvasImageSource | null;
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

/** Übersichtsbild: 1 Pixel je Rasterzelle (flächengewichtete Mischfarbe). */
export function buildOverviewRGBA(layout: Layout, data: MosaicData, palette: PaletteColor[]): Uint8ClampedArray {
  const { cols, rows } = layout;
  const out = new Uint8ClampedArray(cols * rows * 4);
  const rgb = palette.map((p) => hexToRgb(p.hex));
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const k = data.kind[idx];
      let r = 0;
      let g = 0;
      let b = 0;
      if (k === CellKind.FULL) {
        const c = rgb[data.c1[idx]] ?? [0, 0, 0];
        r = c[0];
        g = c[1];
        b = c[2];
      } else if (k === CellKind.SUB || k === CellKind.FREE) {
        const cs = k === CellKind.SUB ? Array.from(data.sub.get(idx) ?? [data.c1[idx]]) : (data.free.get(idx) ?? []).map((f) => f.color);
        for (const ci of cs) {
          const c = rgb[ci] ?? [0, 0, 0];
          r += c[0] / cs.length;
          g += c[1] / cs.length;
          b += c[2] / cs.length;
        }
      } else {
        const a = rgb[data.c1[idx]] ?? [0, 0, 0];
        const c = rgb[data.c2[idx]] ?? [0, 0, 0];
        r = (a[0] + c[0]) / 2;
        g = (a[1] + c[1]) / 2;
        b = (a[2] + c[2]) / 2;
      }
      out[idx * 4] = r;
      out[idx * 4 + 1] = g;
      out[idx * 4 + 2] = b;
      out[idx * 4 + 3] = 255;
    }
  }
  return out;
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

  const pitchPx = (Math.min(layout.tileW, layout.tileH) + layout.joint) * scale;
  const vr = visibleRange(layout, view);
  const cellCount = (vr.r1 - vr.r0) * (vr.c1 - vr.c0);

  if ((pitchPx < 3 || cellCount > 400_000) && opt.overview) {
    ctx.imageSmoothingEnabled = pitchPx < 1;
    ctx.drawImage(opt.overview, ox, oy, layout.finishedW * scale, layout.finishedH * scale);
    ctx.imageSmoothingEnabled = true;
  } else {
    const variants = colorVariants(palette, opt.realistic && pitchPx >= 4);
    const drawHighlights = opt.realistic && pitchPx >= 9;
    const hiA = opt.surface === 'glass' ? 0.22 : 0.1;
    const gl = drawHighlights ? glaze(opt.surface) : null;
    const codeFont = opt.showCodes && pitchPx >= 18;
    const dim = opt.focusColor !== undefined && opt.focusColor !== null;
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
            ctx.fillStyle = 'rgba(255,255,255,0.78)';
            ctx.fillRect(x, y, w, h);
          }
          if (opt.progressMode && prog & 1) drawPlaced(ctx, x, y, w, h);
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
              ctx.fillStyle = 'rgba(255,255,255,0.78)';
              ctx.fill();
            }
            if (opt.progressMode && (prog >> i) & 1) {
              ctx.fillStyle = 'rgba(255,255,255,0.55)';
              ctx.fill();
            }
            if (codeFont && Math.min(b.w, b.h) * scale >= 12) {
              const c = centroid(p.poly);
              drawCode(ctx, palette[p.color], ox + c.x * scale, oy + c.y * scale, Math.min(b.w, b.h) * scale * 0.8);
            }
          }
          if (opt.progressMode && ps.length && (prog & ((1 << ps.length) - 1)) === (1 << ps.length) - 1) {
            drawPlaced(
              ctx,
              ox + layout.colX[col] * scale,
              oy + layout.rowY[row] * scale,
              layout.colW[col] * scale,
              layout.rowH[row] * scale,
              true,
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

function drawPlaced(ctx: Ctx2D, x: number, y: number, w: number, h: number, onlyCheck = false) {
  if (!onlyCheck) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(x, y, w, h);
  }
  if (Math.min(w, h) >= 10) {
    ctx.strokeStyle = '#1b8a3a';
    ctx.lineWidth = Math.max(1.5, Math.min(w, h) * 0.1);
    ctx.beginPath();
    ctx.moveTo(x + w * 0.25, y + h * 0.55);
    ctx.lineTo(x + w * 0.43, y + h * 0.72);
    ctx.lineTo(x + w * 0.76, y + h * 0.3);
    ctx.stroke();
  }
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
  let overview: OffscreenCanvas | null = null;
  if ((Math.min(layout.tileW, layout.tileH) + layout.joint) * scale < 3) {
    overview = new OffscreenCanvas(layout.cols, layout.rows);
    const octx = overview.getContext('2d')!;
    const rgba = buildOverviewRGBA(layout, data, palette);
    octx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, layout.cols, layout.rows), 0, 0);
  }
  renderMosaic(ctx, layout, data, palette, { scale, ox: 0, oy: 0, width: W, height: H }, {
    groutHex: opt.groutHex ?? '#BDB8AE',
    realistic: opt.realistic ?? true,
    surface: opt.surface ?? 'glass',
    showCodes: opt.showCodes ?? false,
    progressMode: opt.progressMode ?? false,
    sections: opt.sections ?? null,
    overview,
    background: opt.groutHex ?? '#BDB8AE',
  });
  return cv;
}
