import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { pointInPolygon } from '../../core/geometry';
import { indexAt, type Layout, type Section, type SectionGrid } from '../../core/layout';
import { cellPieces } from '../../core/pieces';
import { buildOverviewRGBA, renderMosaic, type View } from '../../core/render';
import type { MosaicData, PaletteColor } from '../../core/types';
import { useI18n } from '../../i18n';
import '../css/w1-touch-input-safety.css';
import { exceedsTapSlop, isTapDuration, MAX_SCALE, pieceMinSideMm, tapDecision } from './touchTap';

const ZOOM_ANIM_MS = 220;
const HINT_MS = 1500;

export interface ViewerProps {
  layout: Layout;
  data: MosaicData;
  palette: PaletteColor[];
  version: number;
  progressVersion: number;
  groutHex: string;
  surface: 'glass' | 'ceramic';
  realistic: boolean;
  showCodes: boolean;
  progressMode: boolean;
  sections: SectionGrid | null;
  selectedSection?: string | null;
  highlight?: { row: number; col: number; piece: number } | null;
  focusColor?: number | null;
  onPick?: (row: number, col: number, piece: number) => void;
  height?: number | string;
}

export interface ViewerHandle {
  fit: () => void;
  zoomTo: (s: Section | { x: number; y: number; w: number; h: number }) => void;
  center: (xMm: number, yMm: number, minScale?: number) => void;
}

export const Viewer = forwardRef<ViewerHandle, ViewerProps>(function Viewer(props, ref) {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ scale: 1, ox: 0, oy: 0, width: 0, height: 0 });
  const raf = useRef(0);
  const propsRef = useRef(props);
  propsRef.current = props;
  const fitted = useRef(false);
  /** laufende Zoom-Animation (requestAnimationFrame-ID) */
  const anim = useRef(0);
  /**
   * Ein Finger-/Stift-Tippen wurde verarbeitet (Stein gewählt oder hineingezoomt). Das folgende touchend
   * wird dann abgebrochen, damit der Browser keine Kompatibilitäts-Mausereignisse (mousedown/mouseup/click)
   * an derselben Stelle nachschickt. Die würden sonst im gerade geöffneten Steindialog landen und z. B.
   * „verlegt“ ankreuzen oder zum Nachbarstein springen. Als Ref (nicht im Effekt), damit ein Neuaufbau
   * der Zeiger-Listener zwischen pointerup und touchend das Flag nicht verliert.
   */
  const tapHandled = useRef(false);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef(0);

  const stopAnim = useCallback(() => {
    cancelAnimationFrame(anim.current);
    anim.current = 0;
  }, []);
  const showHint = useCallback((text: string) => {
    setHint(text);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), HINT_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(hintTimer.current), []);

  const overview = useMemo(() => {
    const { layout, data, palette } = props;
    const c = document.createElement('canvas');
    c.width = layout.cols;
    c.height = layout.rows;
    const rgba = buildOverviewRGBA(layout, data, palette);
    c.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, layout.cols, layout.rows), 0, 0);
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.layout, props.data, props.palette, props.version]);

  const draw = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const cv = canvas.current;
      if (!cv) return;
      const p = propsRef.current;
      const dpr = window.devicePixelRatio || 1;
      const ctx = cv.getContext('2d')!;
      // aktueller Maßstab (CSS-px je mm) – für Browser-Tests und Fehlersuche
      cv.dataset.scale = view.current.scale.toFixed(4);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderMosaic(ctx, p.layout, p.data, p.palette, view.current, {
        groutHex: p.groutHex,
        realistic: p.realistic,
        surface: p.surface,
        showCodes: p.showCodes,
        progressMode: p.progressMode,
        sections: p.sections,
        selectedSection: p.selectedSection,
        highlight: p.highlight,
        focusColor: p.focusColor,
        overview,
        background: getComputedStyle(cv).getPropertyValue('--viewer-bg') || '#e9e5de',
      });
    });
  }, [overview]);

  const fit = useCallback(() => {
    stopAnim();
    const v = view.current;
    if (v.width <= 0 || v.height <= 0) return;
    const L = propsRef.current.layout;
    const pad = 16;
    const s = Math.min((v.width - 2 * pad) / L.finishedW, (v.height - 2 * pad) / L.finishedH);
    v.scale = s;
    v.ox = (v.width - L.finishedW * s) / 2;
    v.oy = (v.height - L.finishedH * s) / 2;
    draw();
  }, [draw, stopAnim]);

  const zoomTo = useCallback(
    (r: { x: number; y: number; w: number; h: number }) => {
      stopAnim();
      const v = view.current;
      const pad = 24;
      const s = Math.min((v.width - 2 * pad) / r.w, (v.height - 2 * pad) / r.h);
      v.scale = s;
      v.ox = (v.width - r.w * s) / 2 - r.x * s;
      v.oy = (v.height - r.h * s) / 2 - r.y * s;
      draw();
    },
    [draw, stopAnim],
  );

  const center = useCallback(
    (x: number, y: number, minScale = 0) => {
      stopAnim();
      const v = view.current;
      if (v.scale < minScale) v.scale = minScale;
      v.ox = v.width / 2 - x * v.scale;
      v.oy = v.height / 2 - y * v.scale;
      draw();
    },
    [draw, stopAnim],
  );

  useImperativeHandle(ref, () => ({ fit, zoomTo, center }), [fit, zoomTo, center]);

  // Größe
  useEffect(() => {
    const el = wrap.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.max(1, Math.round(r.height * dpr));
      cv.style.width = `${r.width}px`;
      cv.style.height = `${r.height}px`;
      const v = view.current;
      v.width = r.width;
      v.height = r.height;
      if (!fitted.current && r.width > 0) {
        fitted.current = true;
        fit();
      } else draw();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, draw]);

  useEffect(() => {
    draw();
  }, [draw, props.version, props.progressVersion, props.realistic, props.showCodes, props.progressMode, props.sections, props.selectedSection, props.highlight, props.focusColor, props.groutHex, props.surface, props.palette]);

  useEffect(() => {
    fitted.current = false;
    if (view.current.width > 0) {
      fitted.current = true;
      fit();
    }
  }, [props.layout, fit]);

  // Geister-Klicks nach einem Finger-Tippen unterdrücken (siehe tapHandled). Nur bei erkannten Tipps:
  // Verschieben und Pinch-Zoom bleiben unberührt.
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const onTouchEnd = (e: TouchEvent) => {
      if (tapHandled.current && e.cancelable) e.preventDefault();
      tapHandled.current = false;
    };
    cv.addEventListener('touchend', onTouchEnd, { passive: false });
    return () => cv.removeEventListener('touchend', onTouchEnd);
  }, []);

  // Interaktion: Ziehen, Zoomen (Rad/Pinch), Antippen
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let downAt: { x: number; y: number; t: number; type: string } | null = null;
    let moved = false;
    let pinchDist = 0;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const minScale = () => {
      const v = view.current;
      const L = propsRef.current.layout;
      return Math.min(v.width / L.finishedW, v.height / L.finishedH) * 0.25;
    };
    const zoomAt = (px: number, py: number, f: number) => {
      const v = view.current;
      const ns = Math.min(MAX_SCALE, Math.max(minScale(), v.scale * f));
      const k = ns / v.scale;
      v.ox = px - (px - v.ox) * k;
      v.oy = py - (py - v.oy) * k;
      v.scale = ns;
      draw();
    };
    /** sanftes Hineinzoomen um den Tippunkt: der Stein unter dem Finger bleibt unter dem Finger */
    const animateZoomAt = (px: number, py: number, f: number) => {
      stopAnim();
      const v = view.current;
      const s0 = v.scale;
      const s1 = Math.min(MAX_SCALE, Math.max(minScale(), s0 * f));
      const ox0 = v.ox;
      const oy0 = v.oy;
      const t0 = performance.now();
      const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const step = (now: number) => {
        const u = reduce ? 1 : Math.min(1, Math.max(0, (now - t0) / ZOOM_ANIM_MS));
        const e = 1 - Math.pow(1 - u, 3);
        const s = s0 * Math.pow(s1 / s0, e);
        v.ox = px - (px - ox0) * (s / s0);
        v.oy = py - (py - oy0) * (s / s0);
        v.scale = s;
        draw();
        anim.current = u < 1 ? requestAnimationFrame(step) : 0;
      };
      anim.current = requestAnimationFrame(step);
    };
    /** Stein unter dem Punkt (CSS-px im Canvas); in der Fuge das nächstgelegene Teil der Zelle */
    const hitAt = (px: number, py: number) => {
      const v = view.current;
      const L = propsRef.current.layout;
      const xm = (px - v.ox) / v.scale;
      const ym = (py - v.oy) / v.scale;
      const col = indexAt(L.colX, L.colW, xm, L.joint);
      const row = indexAt(L.rowY, L.rowH, ym, L.joint);
      if (col < 0 || row < 0) return null;
      const ps = cellPieces(L, propsRef.current.data, row, col);
      if (!ps.length) return null;
      let piece = ps.findIndex((q) => pointInPolygon({ x: xm, y: ym }, q.poly));
      if (piece < 0) {
        let bd = Infinity;
        ps.forEach((q, i) => {
          const cx = q.poly.reduce((s, pt) => s + pt.x, 0) / q.poly.length;
          const cy = q.poly.reduce((s, pt) => s + pt.y, 0) / q.poly.length;
          const d = Math.hypot(cx - xm, cy - ym);
          if (d < bd) {
            bd = d;
            piece = i;
          }
        });
      }
      piece = Math.max(0, piece);
      return { row, col, piece, poly: ps[piece].poly };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      stopAnim();
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)));
    };
    const onDown = (e: PointerEvent) => {
      tapHandled.current = false;
      stopAnim();
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* Zeiger bereits beendet */
      }
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size === 1) {
        downAt = { ...p, t: performance.now(), type: e.pointerType || 'mouse' };
        moved = false;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        moved = true;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const p = local(e);
      const prev = pointers.get(e.pointerId)!;
      pointers.set(e.pointerId, p);
      if (pointers.size === 1) {
        if (downAt && exceedsTapSlop(downAt.type, p.x - downAt.x, p.y - downAt.y)) moved = true;
        if (moved) {
          view.current.ox += p.x - prev.x;
          view.current.oy += p.y - prev.y;
          draw();
        }
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
        pinchDist = d;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const p = local(e);
      pointers.delete(e.pointerId);
      if (pointers.size === 0 && downAt && !moved) {
        const touchLike = downAt.type !== 'mouse';
        // Finger/Stift lange gedrückt: kein Antippen (Maus unverändert)
        const hit = isTapDuration(downAt.type, performance.now() - downAt.t) ? hitAt(p.x, p.y) : null;
        if (hit) {
          const d = tapDecision(downAt.type, pieceMinSideMm(hit.poly), view.current.scale);
          if (touchLike) {
            tapHandled.current = true;
            // ohne die Mausereignisse wandert der Fokus nicht mehr von selbst aus Eingabefeldern
            const ae = document.activeElement;
            if (ae instanceof HTMLElement && ae.matches('input, textarea, select')) ae.blur();
          }
          if (d.pick) propsRef.current.onPick?.(hit.row, hit.col, hit.piece);
          else {
            animateZoomAt(p.x, p.y, d.zoom);
            showHint(tRef.current('viewer.tapZoomHint'));
          }
        }
      }
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0) downAt = null;
    };
    /** Abbruch durch den Browser oder eine System-Geste: nur Zustand zurücksetzen, nie auswählen */
    const onCancel = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      moved = true;
      if (pointers.size < 2) pinchDist = 0;
      if (pointers.size === 0) downAt = null;
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onCancel);
    return () => {
      stopAnim();
      cv.removeEventListener('wheel', onWheel);
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onCancel);
    };
  }, [draw, stopAnim, showHint]);

  const zoomBtn = (f: number) => {
    stopAnim();
    const v = view.current;
    const k = f;
    const px = v.width / 2;
    const py = v.height / 2;
    v.ox = px - (px - v.ox) * k;
    v.oy = py - (py - v.oy) * k;
    v.scale *= k;
    draw();
  };

  return (
    <div className="viewer" ref={wrap} style={{ height: props.height ?? '62vh' }}>
      <canvas ref={canvas} data-testid="mosaic-canvas" />
      <div className="viewer-tools">
        <button onClick={() => zoomBtn(1.5)} aria-label={t('viewer.zoomIn')} title={t('viewer.zoomIn')} data-testid="viewer-zoom-in">
          ＋
        </button>
        <button onClick={() => zoomBtn(1 / 1.5)} aria-label={t('viewer.zoomOut')} title={t('viewer.zoomOut')} data-testid="viewer-zoom-out">
          －
        </button>
        <button onClick={fit} aria-label={t('viewer.fit')} title={t('viewer.fit')} data-testid="viewer-fit">
          ⤢
        </button>
      </div>
      {hint && (
        <div className="viewer-hint" role="status" data-testid="viewer-hint">
          {hint}
        </div>
      )}
    </div>
  );
});
