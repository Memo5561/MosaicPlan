/**
 * Zusatzebene über dem Viewer der Vorschau (Paket w6-compare-batch): Abweichungskarte Foto ↔ Stein (ΔE je Zelle,
 * feste Legende, „keine Fotoreferenz“ schraffiert) und der gewählte Bereich der Bereichsbearbeitung.
 *
 * Eigenes Canvas über dem Mosaik, ohne Eingriff in den Viewer: Es folgt der gezeichneten Ansicht des Viewers
 * (ViewerHandle.drawnView) – der Viewer schreibt bei jedem Bild Maßstab und Ursprung an sein Canvas (data-scale,
 * data-ox, data-oy); ein MutationObserver zeichnet diese Ebene im selben Bild nach (vor dem Anzeigen). Zeiger-
 * ereignisse gehen durch (pointer-events: none); Zoom-Knöpfe, Hinweise und das Viewer-Overlay liegen darüber (CSS).
 *
 * Die Karte ist ein Bild mit einem Pixel je Zelle, das in Streifen gleicher Zellbreite exakt auf die Zellflächen
 * (bis zur Fugenmitte, wie rangeWorldRect) gelegt wird – auch mit zugeschnittenen Randsteinen deckungsgleich.
 * Rein lesend: keine Änderung an Raster, Zählung, Statistik oder PDF.
 */
import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { deviationBin } from '../../core/deviation';
import type { Layout } from '../../core/layout';
import { rangeWorldRect, rulerInsets, visibleRange, type View } from '../../core/render';
import type { Range } from '../../core/stats';
import type { ViewerHandle } from './Viewer';

/** Farben der Legende (RGBA, über das Mosaik gelegt): unter 2 · 2–5 · über 5–10 · über 10 · keine Fotoreferenz */
export const DEVIATION_COLORS: readonly [number, number, number, number][] = [
  [30, 140, 80, 0.22],
  [242, 190, 30, 0.55],
  [236, 104, 22, 0.75],
  [196, 18, 58, 0.88],
];
export const NO_REFERENCE_COLOR: [number, number, number, number] = [70, 72, 92, 0.5];

export const rgbaCss = (c: readonly [number, number, number, number]) => `rgba(${c[0]},${c[1]},${c[2]},${c[3]})`;

/** Zellen gleicher Ausdehnung hintereinander: [i0, i1) und ihre Weltkoordinaten (bis zur Fugenmitte, am Rand ohne Außenfuge) */
export interface Band {
  i0: number;
  i1: number;
  w0: number;
  w1: number;
}

/** Streifen gleicher Zellausdehnung einer Achse (pos/size wie layout.colX/colW), begrenzt auf [0, total]. */
export function axisBands(pos: Float64Array, size: Float64Array, n: number, joint: number, total: number): Band[] {
  const hj = joint / 2;
  const lo = (i: number) => Math.max(0, pos[i] - hj);
  const hi = (i: number) => Math.min(total, pos[i] + size[i] + hj);
  const bands: Band[] = [];
  let i0 = 0;
  for (let i = 1; i <= n; i++) {
    if (i < n && Math.abs(hi(i) - lo(i) - (hi(i0) - lo(i0))) < 1e-7 && Math.abs(lo(i) - hi(i - 1)) < 1e-7) continue;
    bands.push({ i0, i1: i, w0: lo(i0), w1: hi(i - 1) });
    i0 = i;
  }
  return bands;
}

/** Bild der Abweichungskarte: ein Pixel je Zelle, Farbe nach Legendenklasse, NaN = keine Fotoreferenz. */
export function deviationRGBA(map: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(map.length * 4);
  const cols = DEVIATION_COLORS.map((c) => [c[0], c[1], c[2], Math.round(c[3] * 255)]);
  const none = [NO_REFERENCE_COLOR[0], NO_REFERENCE_COLOR[1], NO_REFERENCE_COLOR[2], Math.round(NO_REFERENCE_COLOR[3] * 255)];
  for (let i = 0; i < map.length; i++) {
    const d = map[i];
    const c = d === d ? cols[deviationBin(d)] : none;
    out.set(c, i * 4);
  }
  return out;
}

/** Ab dieser Zellgröße auf dem Bildschirm (CSS-px) werden Zellen ohne Fotoreferenz zusätzlich schraffiert */
const HATCH_MIN_PX = 5;
/** höchstens so viele schraffierte Zellen je Bild (sonst nur die graue Fläche) */
const HATCH_MAX_CELLS = 40_000;

export interface PreviewOverlayProps {
  /** Element, das den Viewer enthält (position: relative) */
  stage: RefObject<HTMLDivElement | null>;
  viewer: RefObject<ViewerHandle | null>;
  layout: Layout;
  rulers: boolean;
  /** Abweichung je Zelle (NaN = keine Fotoreferenz); null = Karte aus */
  deviation: Float32Array | null;
  /** gewählter Bereich der Bereichsbearbeitung (Umriss) */
  selection: Range | null;
}

export function PreviewOverlay({ stage, viewer, layout, rulers, deviation, selection }: PreviewOverlayProps) {
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const lastKey = useRef('');

  // Bild der Karte (ein Pixel je Zelle) und die Zellen ohne Fotoreferenz
  const bitmap = useMemo(() => {
    if (!deviation || deviation.length !== layout.cols * layout.rows) return null;
    const c = document.createElement('canvas');
    c.width = layout.cols;
    c.height = layout.rows;
    c.getContext('2d')?.putImageData(new ImageData(deviationRGBA(deviation) as Uint8ClampedArray<ArrayBuffer>, layout.cols, layout.rows), 0, 0);
    const gaps: number[] = [];
    for (let i = 0; i < deviation.length; i++) if (deviation[i] !== deviation[i]) gaps.push(i);
    return { canvas: c, gaps: Int32Array.from(gaps) };
  }, [deviation, layout]);
  const bands = useMemo(
    () => ({
      x: axisBands(layout.colX, layout.colW, layout.cols, layout.joint, layout.finishedW),
      y: axisBands(layout.rowY, layout.rowH, layout.rows, layout.joint, layout.finishedH),
    }),
    [layout],
  );

  const inputs = useRef({ bitmap, bands, layout, rulers, selection });
  inputs.current = { bitmap, bands, layout, rulers, selection };
  /** Eingaben des zuletzt gezeichneten Bildes (Vergleich nach Identität) */
  const lastInputs = useRef<unknown[]>([]);

  const draw = useRef<(force?: boolean) => void>(() => {});
  draw.current = (force = false) => {
    const c = cv.current;
    const st = stage.current;
    const v: View | null = viewer.current?.drawnView() ?? null;
    const main = st?.querySelector<HTMLCanvasElement>('[data-testid="mosaic-canvas"]');
    if (!c || !v || !main) return;
    const { bitmap: bm, bands: bd, layout: L, rulers: ru, selection: sel } = inputs.current;
    const key = `${v.scale}|${v.ox}|${v.oy}|${v.width}|${v.height}|${main.width}|${main.height}`;
    const cur = [bm, bd, L, ru, sel];
    if (!force && key === lastKey.current && cur.every((x, i) => x === lastInputs.current[i])) return;
    lastKey.current = key;
    lastInputs.current = cur;
    if (c.width !== main.width) c.width = main.width;
    if (c.height !== main.height) c.height = main.height;
    c.style.width = main.style.width;
    c.style.height = main.style.height;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = main.width / Math.max(1, v.width);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (!bm && !sel) {
      c.dataset.drawn = '0';
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    const ins = rulerInsets(L, ru);
    ctx.beginPath();
    ctx.rect(ins.left, ins.top, v.width - ins.left, v.height - ins.top);
    ctx.clip();
    const s = v.scale;
    let hatched = 0;
    if (bm) {
      ctx.imageSmoothingEnabled = false;
      for (const bx of bd.x) for (const by of bd.y) ctx.drawImage(bm.canvas, bx.i0, by.i0, bx.i1 - bx.i0, by.i1 - by.i0, v.ox + bx.w0 * s, v.oy + by.w0 * s, (bx.w1 - bx.w0) * s, (by.w1 - by.w0) * s);
      ctx.imageSmoothingEnabled = true;
      // Schraffur „keine Fotoreferenz“ über die sichtbaren Steinflächen dieser Zellen
      const cellPx = Math.min(L.tileW, L.tileH) * s;
      if (bm.gaps.length && cellPx >= HATCH_MIN_PX) {
        const vr = visibleRange(L, v);
        ctx.beginPath();
        for (let k = 0; k < bm.gaps.length && hatched < HATCH_MAX_CELLS; k++) {
          const idx = bm.gaps[k];
          const row = Math.floor(idx / L.cols);
          const col = idx - row * L.cols;
          if (row < vr.r0 || row >= vr.r1 || col < vr.c0 || col >= vr.c1) continue;
          ctx.rect(v.ox + L.colX[col] * s, v.oy + L.rowY[row] * s, L.colW[col] * s, L.rowH[row] * s);
          hatched++;
        }
        if (hatched) {
          ctx.save();
          ctx.clip();
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 1.5;
          const step = 6;
          ctx.beginPath();
          for (let x = -v.height; x < v.width; x += step) {
            ctx.moveTo(x, v.height);
            ctx.lineTo(x + v.height, 0);
          }
          ctx.stroke();
          ctx.restore();
        }
      }
    }
    // gewählter Bereich: Umriss bis zur Fugenmitte (wie das Rechteck beim Aufziehen)
    const wr = sel ? rangeWorldRect(L, sel) : null;
    if (wr) {
      const x = v.ox + wr.x0 * s;
      const y = v.oy + wr.y0 * s;
      const w = (wr.x1 - wr.x0) * s;
      const h = (wr.y1 - wr.y0) * s;
      ctx.fillStyle = 'rgba(182,69,43,0.10)';
      ctx.fillRect(x, y, w, h);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeRect(x, y, w, h);
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 4]);
      ctx.strokeStyle = '#b6452b';
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
    ctx.restore();
    c.dataset.drawn = '1';
    c.dataset.map = bm ? '1' : '0';
    c.dataset.hatched = String(hatched);
  };

  // Lage über dem Viewer und Nachzeichnen bei jedem Bild des Viewers
  useEffect(() => {
    const st = stage.current;
    const el = st?.querySelector<HTMLDivElement>('.viewer');
    const main = st?.querySelector<HTMLCanvasElement>('[data-testid="mosaic-canvas"]');
    const b = box.current;
    if (!st || !el || !main || !b) return;
    const place = () => {
      b.style.left = `${el.offsetLeft + el.clientLeft}px`;
      b.style.top = `${el.offsetTop + el.clientTop}px`;
      b.style.width = `${el.clientWidth}px`;
      b.style.height = `${el.clientHeight}px`;
      draw.current(true);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    const mo = new MutationObserver(() => draw.current());
    mo.observe(main, {
      attributes: true,
      attributeFilter: ['data-scale', 'data-ox', 'data-oy', 'width', 'height'],
    });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [stage, layout]);

  // geänderte Eingaben (Karte, Bereich, Lineal): sofort neu zeichnen
  useEffect(() => {
    draw.current(true);
  }, [bitmap, bands, rulers, selection]);

  return (
    <div ref={box} className="w6cb-ovbox" aria-hidden="true">
      <canvas ref={cv} className="w6cb-ov" data-testid="deviation-overlay" />
    </div>
  );
}
