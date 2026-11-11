import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { bbox, pointInPolygon } from '../../core/geometry';
import { indexAt, pieceId, sectionOfCell, type Layout, type Section, type SectionGrid } from '../../core/layout';
import { cellPieces } from '../../core/pieces';
import {
  buildOverviewRGBA,
  buildProgressOverlayRGBA,
  compareSplitAt,
  compareSplitX,
  dimmedPalette,
  drawMosaicOverlay,
  LAID_ALPHA,
  LAID_TINT,
  overviewActive,
  pitchPxOf,
  rangeWorldRect,
  renderMosaic,
  rulerInsets,
  type RenderInfo,
  type RenderOptions,
  type View,
} from '../../core/render';
import type { Range } from '../../core/stats';
import type { MosaicData, PaletteColor } from '../../core/types';
import { useI18n } from '../../i18n';
import '../css/w1-touch-input-safety.css';
import '../css/w3-viewer-features.css';
import { isCoarsePointer, useCoarsePointer } from './deviceKind';
import { exceedsTapSlop, isTapDuration, LONG_PRESS_MS, MAX_SCALE, pieceMinSideMm, tapDecision, TOUCH_ZOOM_TARGET_PX } from './touchTap';
import { BaseBuffer, type BaseFrame, type CanvasFactory, type RenderArea } from './viewerBase';
import { cellNearPoint, inRange, PaintStroke, pieceAtPoint, rangePieceCount, rectRange, type PieceRef } from './viewerInput';

/** Ruhetext der Statuszeile: „Mauszeiger über einen Stein bewegen“ nur, wenn das Hauptzeigegerät eine Maus ist */
const hoverIdleKey = () => (isCoarsePointer() ? 'w5fu.hoverIdle.touch' : 'w3vf.hoverIdle');

export type { PieceRef } from './viewerInput';

const ZOOM_ANIM_MS = 220;
/**
 * Zoom mit Rad oder zwei Fingern: währenddessen wird die zwischengespeicherte Steinebene skaliert gezeigt; so viele
 * Millisekunden nach dem letzten Zoomschritt folgt das genaue Bild (nie bleibt ein skaliertes Bild stehen).
 */
export const ZOOM_SETTLE_MS = 130;
/** Rand des Rückpuffers je Leerlauf-Schritt nachzeichnen (Gerätepixel) */
const FILL_CHUNK_PX = 131_072;
/** Übersicht als Unterlage der skalierten Vorschau nur bauen, wenn das schnell geht (sonst nur, wenn schon vorhanden) */
const UNDERLAY_MAX_CELLS = 400_000;
const HINT_MS = 1500;
/** Dauer der kurzen Hervorhebung (Prop `flash`) */
export const FLASH_MS = 600;
/** Malen mit dem Finger erst ab dieser Rastergröße auf dem Bildschirm (CSS-px) – sonst erst hineinzoomen */
export const PAINT_MIN_TOUCH_PX = 12;
/** Greifbereich der Vergleichs-Trennlinie (CSS-px links/rechts) */
const SPLIT_GRAB_PX = 16;

/** Tippen = Stein wählen (bisher), Malen = über Steine ziehen, Rechteck = Zellbereich aufziehen */
export type ViewerMode = 'tap' | 'paint' | 'rect';

/** Antippen außerhalb des Fokusbereichs: getroffener Stein und sein Abschnitt (falls Abschnitte bekannt) */
export interface OutsideTap {
  row: number;
  col: number;
  piece: number;
  sectionId: string | null;
}

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
  /** Zeilen-/Spaltenlineal oben und links (Bezeichnungen wie in den Stein-IDs und im PDF) */
  rulers?: boolean;
  /**
   * Nur dieser Zellbereich ist aktiv: außerhalb abgedunkelt; Antippen, Malen und Rechtecke außerhalb wählen nie
   * etwas aus. Ein Antippen außerhalb meldet onOutsideTap (ohne Handler: kurzer Hinweis im Viewer).
   */
  focusRange?: Range | null;
  onOutsideTap?: (info: OutsideTap) => void;
  /**
   * 'tap' (Standard): wie bisher. 'paint': Ziehen mit einem Finger/der Maus erfasst jeden berührten Stein; beim
   * Loslassen EIN Aufruf onPaint(steine, set) – `set` ist der Zielzustand „verlegt“ aus dem ersten Stein, `steine`
   * enthält nur Steine, deren Zustand sich dadurch ändert. 'rect': Rechteck aufziehen (rastet auf Zellen ein),
   * beim Loslassen onRect(bereich). In beiden Modi verschieben zwei Finger, die Leertaste oder die mittlere
   * Maustaste die Ansicht. Der Viewer ändert selbst nie Daten.
   */
  mode?: ViewerMode;
  onPaint?: (pieces: PieceRef[], set: boolean) => void;
  onRect?: (range: Range) => void;
  /** Langes Drücken (500 ms) bzw. Rechtsklick auf einen Stein (nur im Modus 'tap') */
  onLongPick?: (row: number, col: number, piece: number) => void;
  /** Stein kurz (FLASH_MS) aufleuchten lassen – jedes neue Objekt startet die Hervorhebung neu */
  flash?: PieceRef | null;
  /** Statuszeile unter dem Viewer (nur Geräte mit Maus): Stein-ID und Lage in mm unter dem Zeiger. Standard: an */
  hoverStatus?: boolean;
  /** Foto/Mosaik-Vergleich: bearbeitetes Foto (deckungsgleich auf der Mosaikfläche) links der Trennlinie */
  compareImage?: CanvasImageSource | null;
  /** 0…1 der sichtbaren Mosaikbreite (Standard 0,5) */
  compareSplit?: number;
  /** Trennlinie ziehen (ohne Handler ist sie nicht verschiebbar) */
  onCompareSplit?: (split: number) => void;
}

export interface ViewerHandle {
  fit: () => void;
  zoomTo: (s: Section | { x: number; y: number; w: number; h: number }) => void;
  /** Punkt (mm) mittig zeigen; `atY`: stattdessen in dieser Höhe (CSS-Pixel ab Oberkante des Viewers), z. B. über einem Blatt */
  center: (xMm: number, yMm: number, minScale?: number, atY?: number) => void;
  /** Ansicht des zuletzt gezeichneten Bildes (Ursprung auf ganze Gerätepixel gerundet) – für Tests und Vergleiche */
  drawnView: () => View | null;
  /** Maßstab und Ursprung jetzt (ungerundet) – zum späteren Wiederherstellen mit setView */
  getView: () => { scale: number; ox: number; oy: number };
  setView: (v: { scale: number; ox: number; oy: number }) => void;
}

/** Laufende Zeiger-Geste */
type Gesture =
  | { kind: 'none' }
  | { kind: 'tap' }
  | { kind: 'pan' }
  | { kind: 'pinch' }
  | { kind: 'paint'; stroke: PaintStroke; last: { x: number; y: number } }
  /** Malen gesperrt (Finger, Steine zu klein): Ziehen verschiebt, Tippen zoomt hinein */
  | { kind: 'paintBlocked' }
  | { kind: 'rect'; a: { row: number; col: number }; b: { row: number; col: number } }
  | { kind: 'split' };

const isTypingTarget = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.matches('input, textarea, select, [contenteditable="true"]'));

export const Viewer = forwardRef<ViewerHandle, ViewerProps>(function Viewer(props, ref) {
  const { t, n } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const nRef = useRef(n);
  nRef.current = n;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const statusMain = useRef<HTMLSpanElement>(null);
  const statusSub = useRef<HTMLSpanElement>(null);
  const view = useRef<View>({ scale: 1, ox: 0, oy: 0, width: 0, height: 0 });
  const raf = useRef(0);
  const ovRaf = useRef(0);
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
  /** laufende Geste (für das Overlay: Malstrich, Rechteck) */
  const gesture = useRef<Gesture>({ kind: 'none' });
  /** Stein unter dem Mauszeiger (Overlay-Umriss) */
  const hover = useRef<{ row: number; col: number; piece: number } | null>(null);
  /** Hervorhebung (Prop flash): Stein und Startzeit */
  const flashState = useRef<{ ref: PieceRef; t0: number } | null>(null);
  /** Leertaste gedrückt (Verschieben in den Modi Malen/Rechteck) */
  const spaceDown = useRef(false);

  /** Zoom-Geste läuft: skalierte Vorschau erlaubt (siehe ZOOM_SETTLE_MS) */
  const zooming = useRef(false);
  const settleTimer = useRef(0);

  const stopAnim = useCallback(() => {
    if (anim.current) {
      cancelAnimationFrame(anim.current);
      anim.current = 0;
      // abgebrochene Zoom-Animation: das nächste Bild ist wieder genau
      zooming.current = false;
    }
  }, []);
  const showHint = useCallback((text: string) => {
    setHint(text);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), HINT_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(hintTimer.current), []);

  /**
   * Übersichtsbilder (1 Pixel je Zelle) werden erst gebaut, wenn renderMosaic sie wirklich zeichnet
   * (kleiner Maßstab oder sehr viele sichtbare Steine), und nur neu, wenn sich ihre Eingaben ändern:
   * Raster, Palette, Bearbeitungen, Fugenfarbe, hervorgehobene Farbe – bzw. für das Fortschritts-Overlay
   * der Fortschritt. Beim Hineinzoomen und Bearbeiten großer Projekte entfällt so der Neuaufbau.
   */
  const ovCache = useRef<{ key: unknown[]; canvas: HTMLCanvasElement } | null>(null);
  const progCache = useRef<{ key: unknown[]; canvas: HTMLCanvasElement | null } | null>(null);
  const sameKey = (a: unknown[] | undefined, b: unknown[]) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);
  const toCanvas = (rgba: Uint8ClampedArray, w: number, h: number) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
    return c;
  };
  const overviewFor = (p: ViewerProps): HTMLCanvasElement => {
    const focus = p.focusColor ?? null;
    const key = [p.layout, p.data, p.palette, p.version, p.groutHex, focus];
    if (!ovCache.current || !sameKey(ovCache.current.key, key)) {
      const pal = focus !== null ? dimmedPalette(p.palette, focus) : p.palette;
      ovCache.current = { key, canvas: toCanvas(buildOverviewRGBA(p.layout, p.data, pal, p.groutHex), p.layout.cols, p.layout.rows) };
    }
    return ovCache.current.canvas;
  };
  /** Ist die Übersicht für diese Eingaben schon gebaut? */
  const overviewCached = (p: ViewerProps) => !!ovCache.current && sameKey(ovCache.current.key, [p.layout, p.data, p.palette, p.version, p.groutHex, p.focusColor ?? null]);
  const progressCached = (p: ViewerProps) => !!progCache.current && sameKey(progCache.current.key, [p.layout, p.data, p.version, p.progressVersion]);
  const progressOverlayFor = (p: ViewerProps): HTMLCanvasElement | null => {
    const key = [p.layout, p.data, p.version, p.progressVersion];
    if (!progCache.current || !sameKey(progCache.current.key, key)) {
      const pr = buildProgressOverlayRGBA(p.layout, p.data);
      progCache.current = { key, canvas: pr.any ? toCanvas(pr.rgba, p.layout.cols, p.layout.rows) : null };
    }
    return progCache.current.canvas;
  };

  /** Hintergrund des Viewers aus der CSS-Variable --viewer-bg: einmal lesen, neu nur bei Themenwechsel */
  const bg = useRef('#e9e5de');
  const readBg = useCallback(() => {
    const cv = canvas.current;
    const v = cv ? getComputedStyle(cv).getPropertyValue('--viewer-bg').trim() : '';
    bg.current = v || '#e9e5de';
  }, []);

  /** Vom Lineal belegte Ränder (oben/links) */
  const insets = () => rulerInsets(propsRef.current.layout, propsRef.current.rulers);

  // ------------------------------------------------------------------ Overlay (leicht, ohne Neuzeichnen der Steine)
  /** Pfad eines Steins in Bildschirmkoordinaten */
  const piecePath = (ctx: CanvasRenderingContext2D, poly: { x: number; y: number }[]) => {
    const v = drawnView.current ?? view.current;
    ctx.beginPath();
    poly.forEach((pt, k) => {
      const X = v.ox + pt.x * v.scale;
      const Y = v.oy + pt.y * v.scale;
      if (k === 0) ctx.moveTo(X, Y);
      else ctx.lineTo(X, Y);
    });
    ctx.closePath();
  };
  const paintOverlay = () => {
    const oc = overlay.current;
    if (!oc) return;
    const ctx = oc.getContext('2d');
    if (!ctx) return;
    const p = propsRef.current;
    const v = drawnView.current ?? view.current;
    const L = p.layout;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, oc.width, oc.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = gesture.current;
    // Malstrich: Vorschau der Steine, deren Zustand sich ändern wird
    if (g.kind === 'paint' && g.stroke.pieces.length) {
      const set = g.stroke.set === true;
      const laidFill = `rgba(${LAID_TINT[0]},${LAID_TINT[1]},${LAID_TINT[2]},${LAID_ALPHA})`;
      for (const pr of g.stroke.pieces) {
        const row = Math.floor(pr.idx / L.cols);
        const col = pr.idx - row * L.cols;
        const pc = cellPieces(L, p.data, row, col)[pr.piece];
        if (!pc) continue;
        piecePath(ctx, pc.poly);
        if (set) {
          ctx.fillStyle = laidFill;
          ctx.fill();
          ctx.strokeStyle = 'rgba(21,95,43,0.9)';
        } else {
          // „nicht verlegt“: Stein wieder in seiner Farbe zeigen
          ctx.fillStyle = p.palette[pc.color]?.hex ?? '#ff00ff';
          ctx.fill();
          ctx.strokeStyle = 'rgba(182,69,43,0.95)';
        }
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    // Rechteck: eingerastet auf Zellen, mit Bezeichnung und Steinzahl
    if (g.kind === 'rect') {
      const rg = rectRange(g.a, g.b, p.focusRange ?? null);
      const wr = rg ? rangeWorldRect(L, rg) : null;
      if (rg && wr) {
        const x = v.ox + wr.x0 * v.scale;
        const y = v.oy + wr.y0 * v.scale;
        const w = (wr.x1 - wr.x0) * v.scale;
        const h = (wr.y1 - wr.y0) * v.scale;
        ctx.fillStyle = 'rgba(182,69,43,0.16)';
        ctx.fillRect(x, y, w, h);
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = '#b6452b';
        ctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
        ctx.setLineDash([]);
        const label = rectLabel(rg);
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width + 14;
        const ins = insets();
        const lx = Math.min(Math.max(ins.left + 4, x), v.width - tw - 4);
        const ly = Math.max(ins.top + 4, y - 26 < ins.top + 4 ? y + 4 : y - 26);
        ctx.fillStyle = 'rgba(20,28,40,0.85)';
        ctx.fillRect(lx, ly, tw, 22);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, lx + 7, ly + 11.5);
      }
    }
    // Mauszeiger: Umriss des Steins darunter
    const hv = hover.current;
    if (hv && g.kind !== 'rect' && g.kind !== 'split') {
      const pc = cellPieces(L, p.data, hv.row, hv.col)[hv.piece];
      if (pc) {
        piecePath(ctx, pc.poly);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(20,28,40,0.75)';
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    }
    // kurze Hervorhebung (flash)
    const fl = flashState.current;
    if (fl) {
      const u = (performance.now() - fl.t0) / FLASH_MS;
      if (u >= 1) flashState.current = null;
      else {
        const row = Math.floor(fl.ref.idx / L.cols);
        const col = fl.ref.idx - row * L.cols;
        const pc = row >= 0 && row < L.rows ? cellPieces(L, p.data, row, col)[fl.ref.piece] : undefined;
        if (pc) {
          const a = 1 - u;
          piecePath(ctx, pc.poly);
          ctx.fillStyle = `rgba(255,255,255,${0.55 * a})`;
          ctx.fill();
          ctx.lineWidth = 2 + 6 * a;
          ctx.strokeStyle = `rgba(255,61,0,${a})`;
          ctx.stroke();
        }
        ovRaf.current = requestAnimationFrame(paintOverlay);
      }
    }
  };
  /** Nur das Overlay neu zeichnen (Maus, Malstrich, Rechteck, flash) */
  const drawOverlay = () => {
    cancelAnimationFrame(ovRaf.current);
    ovRaf.current = requestAnimationFrame(paintOverlay);
  };
  /** Beschriftung des Rechtecks: „B003 – F012 · 5 Zeilen × 10 Spalten · 50 Steine“ (je Bereich nur einmal gezählt) */
  const rectLabelCache = useRef<{ key: string; label: string } | null>(null);
  const rectLabel = (rg: Range) => {
    const p = propsRef.current;
    const L = p.layout;
    const key = `${rg.r0},${rg.r1},${rg.c0},${rg.c1}`;
    if (rectLabelCache.current?.key === key) return rectLabelCache.current.label;
    const from = pieceId(L, rg.r0, rg.c0, 0, 1);
    const to = pieceId(L, rg.r1 - 1, rg.c1 - 1, 0, 1);
    const cnt = rangePieceCount(L, p.data, rg);
    const base = tRef.current('w3vf.rectLabel', { from, to, rows: nRef.current(rg.r1 - rg.r0), cols: nRef.current(rg.c1 - rg.c0) });
    const label = cnt === null ? base : `${base} · ${tRef.current(cnt === 1 ? 'w3vf.stones.one' : 'w3vf.stones', { n: nRef.current(cnt) })}`;
    rectLabelCache.current = { key, label };
    return label;
  };

  // ------------------------------------------------------------------ Rückpuffer (Steinebene zwischengespeichert)
  /**
   * Die Steinebene (renderMosaic ohne Überlagerung) liegt in einem unsichtbaren Canvas (viewerBase.ts). Verschieben
   * kopiert sie mit ganzzahligem Versatz – pixelgleich mit einem frischen renderMosaic (bis auf die positionsabhängige
   * Kantenglättung des Rasterers selbst, nie eine Farbe) – und zeichnet nur neu sichtbare Streifen; geänderte Steine erkennt der Puffer selbst (Zellschatten) und zeichnet nur sie neu.
   * Überlagerung (Abschnitte, Auswahl, Lineal, Fokus, Vergleich) kommt jedes Bild frisch darüber.
   */
  const base = useRef<BaseBuffer | null>(null);
  /** Rückpuffer nicht verfügbar (kein 2D-Kontext): wie bisher jedes Bild ganz zeichnen */
  const baseOff = useRef(false);
  /** Ansicht des zuletzt gezeichneten Bildes (Ursprung auf ganze Gerätepixel gerundet) */
  const drawnView = useRef<View | null>(null);
  /** Finger/Maustasten auf dem Canvas (Geste läuft: kein Abgleich mit den Daten nötig, solange sich nichts ändert) */
  const pointersDown = useRef(0);
  const fillJob = useRef<{ idle: boolean; id: number } | null>(null);

  /** Alles, was die Steinebene beeinflusst – außer Maßstab, Ursprung und Größe (die prüft der Puffer selbst) */
  const baseKey = (p: ViewerProps): unknown[] => [p.layout, p.data, p.palette, p.realistic, p.surface, p.showCodes, p.progressMode, p.focusColor ?? null, p.groutHex, bg.current];
  const stoneOptions = (p: ViewerProps): RenderOptions => ({
    groutHex: p.groutHex,
    realistic: p.realistic,
    surface: p.surface,
    showCodes: p.showCodes,
    progressMode: p.progressMode,
    focusColor: p.focusColor,
    background: bg.current,
  });
  /**
   * Puffer als losgelöstes <canvas> wie der Bildschirm – NICHT OffscreenCanvas: Chrome rastert beide unterschiedlich
   * (gemessen: abweichende Kantenglättung aller schrägen Kanten); gleiche Art = gleiches Bild, Kopieren bleibt auf der GPU.
   */
  const createCanvas: CanvasFactory = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('2d');
    return { canvas: c, ctx };
  };
  /** Ausschnitt der Steinebene in den Puffer zeichnen – dieselbe Funktion wie für den Bildschirm */
  const renderArea: RenderArea = (ctx, area, tx, ty) => {
    const b = base.current!;
    const p = propsRef.current;
    ctx.setTransform(b.dpr, 0, 0, b.dpr, tx, ty);
    renderMosaic(ctx, p.layout, p.data, p.palette, b.cssView(), { ...stoneOptions(p), area: b.cssArea(area), baseOnly: true, overviewMode: false });
  };

  const cancelFill = () => {
    const j = fillJob.current;
    if (!j) return;
    if (j.idle && typeof cancelIdleCallback === 'function') cancelIdleCallback(j.id);
    else window.clearTimeout(j.id);
    fillJob.current = null;
  };
  /** Rand des Puffers in Leerlaufzeit nachzeichnen (kleine Stücke, nur solange er zu den aktuellen Eingaben passt) */
  const scheduleFill = () => {
    if (fillJob.current || !base.current?.needsFill) return;
    const run = (deadline?: IdleDeadline) => {
      fillJob.current = null;
      const b = base.current;
      const p = propsRef.current;
      if (!b || !b.key) return;
      const key = baseKey(p);
      if (key.length !== b.key.length || key.some((k, i) => k !== b.key![i])) return;
      const t0 = performance.now();
      let more = false;
      do more = b.fillStep(FILL_CHUNK_PX, p);
      while (more && (deadline ? deadline.timeRemaining() > 6 : performance.now() - t0 < 6));
      if (more) scheduleFill();
    };
    fillJob.current =
      typeof requestIdleCallback === 'function'
        ? { idle: true, id: requestIdleCallback(run, { timeout: 400 }) }
        : { idle: false, id: window.setTimeout(() => run(), 40) };
  };

  /** Zoomschritt (Rad, zwei Finger): skalierte Vorschau, genaues Bild ZOOM_SETTLE_MS nach dem letzten Schritt */
  const noteZoom = () => {
    zooming.current = true;
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      zooming.current = false;
      draw();
    }, ZOOM_SETTLE_MS);
  };

  /**
   * Unterlage der skalierten Vorschau (dort, wo der Puffer nichts hat, z. B. beim Herauszoomen): Übersicht, wenn
   * vorhanden oder schnell gebaut, sonst Hintergrund und Fugenfläche.
   */
  const drawUnderlay = (ctx: CanvasRenderingContext2D, p: ViewerProps, v: View) => {
    const small = p.layout.cols * p.layout.rows <= UNDERLAY_MAX_CELLS;
    const ov = small || overviewCached(p) ? overviewFor(p) : null;
    if (ov) {
      const prog = p.progressMode && (small || progressCached(p)) ? progressOverlayFor(p) : null;
      renderMosaic(ctx, p.layout, p.data, p.palette, v, { ...stoneOptions(p), overview: ov, overviewProgress: prog, overviewMode: true, baseOnly: true });
      return;
    }
    ctx.fillStyle = bg.current;
    ctx.fillRect(0, 0, v.width, v.height);
    ctx.fillStyle = p.groutHex;
    ctx.fillRect(v.ox, v.oy, p.layout.finishedW * v.scale, p.layout.finishedH * v.scale);
  };

  /** Ein Bild zeichnen (im requestAnimationFrame) */
  const frame = () => {
    const cv = canvas.current;
    if (!cv) return;
    const p = propsRef.current;
    const dpr = window.devicePixelRatio || 1;
    const ctx = cv.getContext('2d')!;
    const v0 = view.current;
    // Ursprung auf ganze Gerätepixel: dann ist das Kopieren des Puffers pixelgenau (Eingaben bleiben unverändert genau)
    const devOx = Math.round(v0.ox * dpr);
    const devOy = Math.round(v0.oy * dpr);
    const v: View = { scale: v0.scale, ox: devOx / dpr, oy: devOy / dpr, width: v0.width, height: v0.height };
    drawnView.current = v;
    // aktueller Maßstab (CSS-px je mm) und Ursprung – für Browser-Tests und Fehlersuche
    cv.dataset.scale = v.scale.toFixed(4);
    cv.dataset.ox = v.ox.toFixed(2);
    cv.dataset.oy = v.oy.toFixed(2);
    cv.dataset.fw = String(p.layout.finishedW);
    cv.dataset.fh = String(p.layout.finishedH);
    const ov = overviewActive(p.layout, v);
    cv.dataset.overview = ov ? '1' : '0';
    const compare = p.compareImage ? { image: p.compareImage, split: p.compareSplit ?? 0.5, labels: { left: tRef.current('w3vf.comparePhoto'), right: tRef.current('w3vf.compareMosaic') } } : null;
    const overlayOpt = {
      sections: p.sections,
      selectedSection: p.selectedSection,
      highlight: p.highlight,
      rulers: !!p.rulers,
      focusRange: p.focusRange ?? null,
      compare,
    };
    let info: RenderInfo | null = null;
    if (!ov && !baseOff.current) {
      try {
        const b = (base.current ??= new BaseBuffer(createCanvas, renderArea));
        const f: BaseFrame = {
          key: baseKey(p),
          layout: p.layout,
          data: p.data,
          scale: v.scale,
          dpr,
          devOx,
          devOy,
          vw: cv.width,
          vh: cv.height,
          version: p.version,
          progressVersion: p.progressVersion,
          progressMode: p.progressMode,
          // außerhalb einer Geste den gezeichneten Bereich mit den Daten abgleichen (fängt jede Änderung)
          verify: !zooming.current && !anim.current && pointersDown.current === 0,
        };
        if (zooming.current && b.matches(f) && b.scale !== f.scale && b.valid) {
          // Zoom-Geste: Puffer skaliert, Überlagerung genau
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          drawUnderlay(ctx, p, v);
          b.drawScaled(ctx, v.scale, devOx, devOy);
          cv.dataset.frame = 'scaled';
        } else {
          const st = b.frame(f, ctx);
          cv.dataset.frame = 'exact';
          cv.dataset.baseResets = String(b.resets);
          cv.dataset.baseRects = String(st.rects);
          cv.dataset.baseDirty = String(st.dirty);
          cv.dataset.basePaints = String(b.paints);
          scheduleFill();
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        info = drawMosaicOverlay(ctx, p.layout, p.data, v, overlayOpt);
      } catch (e) {
        // kein Offscreen-2D-Kontext o. Ä.: ab jetzt wie bisher direkt zeichnen
        console.warn('Viewer: Rückpuffer nicht verfügbar', e);
        baseOff.current = true;
        base.current = null;
        info = null;
      }
    }
    if (!info) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      info = renderMosaic(ctx, p.layout, p.data, p.palette, v, {
        ...stoneOptions(p),
        ...overlayOpt,
        overview: ov ? overviewFor(p) : null,
        overviewProgress: ov && p.progressMode ? progressOverlayFor(p) : null,
      });
      cv.dataset.frame = 'direct';
    }
    // gezeichnete Linealbeschriftungen (für Browser-Tests)
    cv.dataset.rulerCols = info.rulers ? info.rulers.cols.map((l) => l.label).join(',') : '';
    cv.dataset.rulerRows = info.rulers ? info.rulers.rows.map((l) => l.label).join(',') : '';
    // Overlay im selben Bild, damit Strich/Rechteck/Umriss nie gegenüber den Steinen verrutschen
    cancelAnimationFrame(ovRaf.current);
    paintOverlay();
  };

  const draw = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(frame);
    // frame liest nur Refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Aufräumen: Puffer, Leerlauf-Nachzeichnen und Zoom-Timer
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      window.clearTimeout(settleTimer.current);
      cancelFill();
      base.current?.drop();
      base.current = null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // --viewer-bg beim Einhängen und bei Themenwechsel (Systemeinstellung, data-theme/class am Dokument) lesen
  useEffect(() => {
    readBg();
    draw();
    const update = () => {
      readBg();
      draw();
    };
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    mq?.addEventListener?.('change', update);
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(update) : null;
    const opts = { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] };
    mo?.observe(document.documentElement, opts);
    if (document.body) mo?.observe(document.body, opts);
    return () => {
      mq?.removeEventListener?.('change', update);
      mo?.disconnect();
    };
  }, [readBg, draw]);

  const fit = useCallback(() => {
    stopAnim();
    const v = view.current;
    if (v.width <= 0 || v.height <= 0) return;
    const L = propsRef.current.layout;
    const ins = rulerInsets(L, propsRef.current.rulers);
    const pad = 16;
    // mit Lineal: auf der Linealseite 6 px Abstand zum Band, sonst wie bisher 16 px; mittig in der ganzen Ansicht,
    // solange das Mosaik dabei nicht unter das Lineal rutscht (so wird es durch das Lineal kaum kleiner)
    const padL = ins.left ? ins.left + 6 : pad;
    const padT = ins.top ? ins.top + 6 : pad;
    const s = Math.min((v.width - padL - pad) / L.finishedW, (v.height - padT - pad) / L.finishedH);
    v.scale = s;
    v.ox = Math.max(padL, (v.width - L.finishedW * s) / 2);
    v.oy = Math.max(padT, (v.height - L.finishedH * s) / 2);
    draw();
  }, [draw, stopAnim]);

  const zoomTo = useCallback(
    (r: { x: number; y: number; w: number; h: number }) => {
      stopAnim();
      const v = view.current;
      const ins = rulerInsets(propsRef.current.layout, propsRef.current.rulers);
      const pad = 24;
      const aw = v.width - ins.left;
      const ah = v.height - ins.top;
      const s = Math.min((aw - 2 * pad) / r.w, (ah - 2 * pad) / r.h);
      v.scale = s;
      v.ox = ins.left + (aw - r.w * s) / 2 - r.x * s;
      v.oy = ins.top + (ah - r.h * s) / 2 - r.y * s;
      draw();
    },
    [draw, stopAnim],
  );

  const center = useCallback(
    (x: number, y: number, minScale = 0, atY?: number) => {
      stopAnim();
      const v = view.current;
      const ins = rulerInsets(propsRef.current.layout, propsRef.current.rulers);
      if (v.scale < minScale) v.scale = minScale;
      v.ox = ins.left + (v.width - ins.left) / 2 - x * v.scale;
      v.oy = (atY !== undefined && Number.isFinite(atY) ? Math.max(ins.top, Math.min(v.height, atY)) : ins.top + (v.height - ins.top) / 2) - y * v.scale;
      draw();
    },
    [draw, stopAnim],
  );

  const getDrawnView = useCallback(() => (drawnView.current ? { ...drawnView.current } : null), []);
  const getView = useCallback(() => ({ scale: view.current.scale, ox: view.current.ox, oy: view.current.oy }), []);
  const setView = useCallback(
    (nv: { scale: number; ox: number; oy: number }) => {
      if (!(nv.scale > 0) || !Number.isFinite(nv.ox) || !Number.isFinite(nv.oy)) return;
      stopAnim();
      const v = view.current;
      v.scale = nv.scale;
      v.ox = nv.ox;
      v.oy = nv.oy;
      // Eingaben (Antippen) gelten sofort für die neue Ansicht – nicht erst nach dem nächsten Bild
      const dpr = window.devicePixelRatio || 1;
      if (drawnView.current) drawnView.current = { ...drawnView.current, scale: v.scale, ox: Math.round(v.ox * dpr) / dpr, oy: Math.round(v.oy * dpr) / dpr };
      draw();
    },
    [draw, stopAnim],
  );
  useImperativeHandle(ref, () => ({ fit, zoomTo, center, drawnView: getDrawnView, getView, setView }), [fit, zoomTo, center, getDrawnView, getView, setView]);

  // Größe (Haupt-Canvas und Overlay gleich)
  useEffect(() => {
    const el = wrap.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      for (const c of [cv, overlay.current]) {
        if (!c) continue;
        c.width = Math.max(1, Math.round(r.width * dpr));
        c.height = Math.max(1, Math.round(r.height * dpr));
        c.style.width = `${r.width}px`;
        c.style.height = `${r.height}px`;
      }
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
  }, [
    draw,
    props.version,
    props.progressVersion,
    props.realistic,
    props.showCodes,
    props.progressMode,
    props.sections,
    props.selectedSection,
    props.highlight,
    props.focusColor,
    props.groutHex,
    props.surface,
    props.palette,
    props.rulers,
    props.focusRange,
    props.compareImage,
    props.compareSplit,
  ]);

  useEffect(() => {
    fitted.current = false;
    if (view.current.width > 0) {
      fitted.current = true;
      fit();
    }
  }, [props.layout, fit]);

  // Lineal ein/aus: Ansicht so verschieben, dass derselbe Inhalt im freien Bereich bleibt
  const prevInsets = useRef(rulerInsets(props.layout, props.rulers));
  useEffect(() => {
    const ins = rulerInsets(props.layout, props.rulers);
    const prev = prevInsets.current;
    prevInsets.current = ins;
    if (prev.left === ins.left && prev.top === ins.top) return;
    const v = view.current;
    v.ox += (ins.left - prev.left) / 2;
    v.oy += (ins.top - prev.top) / 2;
    draw();
  }, [props.layout, props.rulers, draw]);

  // kurze Hervorhebung: jedes neue flash-Objekt startet sie neu
  useEffect(() => {
    if (!props.flash) return;
    flashState.current = { ref: props.flash, t0: performance.now() };
    drawOverlay();
    // drawOverlay liest nur Refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.flash]);

  // Moduswechsel bricht eine laufende Geste ab
  useEffect(() => {
    gesture.current = { kind: 'none' };
    drawOverlay();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode]);

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

  // Leertaste: Verschieben in den Modi Malen/Rechteck (nur, solange der Zeiger über dem Viewer ist)
  const hovering = useRef(false);
  useEffect(() => {
    const el = wrap.current;
    const setPan = (on: boolean) => {
      spaceDown.current = on;
      el?.classList.toggle('w3vf-pan', on);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (e.type === 'keydown') {
        if (!hovering.current || isTypingTarget(e.target) || (propsRef.current.mode ?? 'tap') === 'tap') return;
        e.preventDefault();
        setPan(true);
      } else if (spaceDown.current) {
        e.preventDefault();
        setPan(false);
      }
    };
    const onBlur = () => setPan(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Interaktion: Ziehen, Zoomen (Rad/Pinch), Antippen, Malen, Rechteck, Trennlinie
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const el = wrap.current;
    const pointers = new Map<number, { x: number; y: number }>();
    let downAt: { x: number; y: number; t: number; type: string } | null = null;
    let moved = false;
    let pinchDist = 0;
    let pinchMid: { x: number; y: number } | null = null;
    let longTimer = 0;
    let longFired = false;
    /** Hinweis „Steine zu klein zum Malen“ in dieser Geste schon gezeigt */
    let blockedHinted = false;
    let lastType = 'mouse';
    const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    /** Bildschirm → mm im zuletzt gezeichneten Bild (Treffer stimmen mit dem Gezeigten überein) */
    const toWorld = (px: number, py: number) => {
      const v = drawnView.current ?? view.current;
      return { x: (px - v.ox) / v.scale, y: (py - v.oy) / v.scale };
    };
    /** Punkt im Lineal? (dort wird nie ein Stein gewählt) */
    const inRuler = (px: number, py: number) => {
      const ins = insets();
      return px < ins.left || py < ins.top;
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
      if (k !== 1) noteZoom();
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
        // Zwischenbilder dürfen skaliert sein, das letzte ist genau
        zooming.current = u < 1;
        if (u >= 1) window.clearTimeout(settleTimer.current);
        draw();
        anim.current = u < 1 ? requestAnimationFrame(step) : 0;
      };
      anim.current = requestAnimationFrame(step);
    };
    /** Stein unter dem Punkt (CSS-px im Canvas); in der Fuge das nächstgelegene Teil der Zelle */
    const hitAt = (px: number, py: number) => {
      if (inRuler(px, py)) return null;
      const L = propsRef.current.layout;
      const { x: xm, y: ym } = toWorld(px, py);
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
    /** Antippen außerhalb des Fokusbereichs melden (ohne Handler: Hinweis im Viewer) */
    const outside = (hit: { row: number; col: number; piece: number }) => {
      const p = propsRef.current;
      const sectionId = p.sections ? (sectionOfCell(p.sections, hit.row, hit.col)?.id ?? null) : null;
      if (p.onOutsideTap) p.onOutsideTap({ row: hit.row, col: hit.col, piece: hit.piece, sectionId });
      else showHint(tRef.current(sectionId ? 'w3vf.outsideHintSection' : 'w3vf.outsideHint', { id: sectionId ?? '' }));
    };
    const mode = () => propsRef.current.mode ?? 'tap';
    const compareX = () => {
      const p = propsRef.current;
      return p.compareImage ? compareSplitX(p.layout, view.current, p.compareSplit ?? 0.5) : null;
    };
    const nearSplit = (px: number, py: number) => {
      const p = propsRef.current;
      if (!p.onCompareSplit) return false;
      const x = compareX();
      if (x === null || Math.abs(px - x) > SPLIT_GRAB_PX) return false;
      const v = view.current;
      return py >= v.oy - SPLIT_GRAB_PX && py <= v.oy + p.layout.finishedH * v.scale + SPLIT_GRAB_PX;
    };
    const clearLong = () => {
      window.clearTimeout(longTimer);
      longTimer = 0;
    };
    const setHover = (h: { row: number; col: number; piece: number } | null) => {
      const a = hover.current;
      if (a === h || (a && h && a.row === h.row && a.col === h.col && a.piece === h.piece)) return;
      hover.current = h;
      drawOverlay();
    };
    /** Statuszeile (Maus): Stein-ID und Lage wie im Steindetail, dazu die Zeigerposition */
    const updateStatus = (px: number, py: number) => {
      const p = propsRef.current;
      const sm = statusMain.current;
      const ss = statusSub.current;
      if (p.hoverStatus === false || !sm || !ss) return;
      const L = p.layout;
      const w = toWorld(px, py);
      const nn = nRef.current;
      const tt = tRef.current;
      const insideMosaic = !inRuler(px, py) && w.x >= 0 && w.y >= 0 && w.x <= L.finishedW && w.y <= L.finishedH;
      sm.dataset.idle = insideMosaic ? '0' : '1';
      if (!insideMosaic) {
        sm.textContent = tt(hoverIdleKey());
        ss.textContent = '';
        setHover(null);
        return;
      }
      ss.textContent = tt('w3vf.hoverCursor', { x: nn(w.x, 1), y: nn(w.y, 1) });
      const hit = pieceAtPoint(L, p.data, w.x, w.y);
      if (hit) {
        const ps = cellPieces(L, p.data, hit.row, hit.col);
        const b = bbox(ps[hit.piece].poly);
        sm.textContent = tt('w3vf.hoverStone', { id: pieceId(L, hit.row, hit.col, hit.piece, ps.length), x: nn(b.minX, 2), y: nn(b.minY, 2) });
        setHover({ row: hit.row, col: hit.col, piece: hit.piece });
      } else {
        const near = cellNearPoint(L, w.x, w.y);
        sm.textContent = tt('w3vf.hoverJoint', { id: pieceId(L, near.row, near.col, 0, 1) });
        setHover(null);
      }
    };
    const cancelGesture = () => {
      gesture.current = { kind: 'none' };
      clearLong();
      drawOverlay();
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
      lastType = e.pointerType || 'mouse';
      const pr = propsRef.current;
      // Rechtsklick mit onLongPick: erledigt das contextmenu-Ereignis
      if (lastType === 'mouse' && e.button === 2 && pr.onLongPick && mode() === 'tap') return;
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* Zeiger bereits beendet */
      }
      const p = local(e);
      pointers.set(e.pointerId, p);
      pointersDown.current = pointers.size;
      if (pointers.size === 1) {
        downAt = { ...p, t: performance.now(), type: lastType };
        moved = false;
        longFired = false;
        blockedHinted = false;
        clearLong();
        const m = mode();
        const middle = lastType === 'mouse' && e.button === 1;
        if (middle) e.preventDefault(); // kein Auto-Scrollen
        // Malen/Rechteck nur mit Finger, Stift oder linker Maustaste; andere Tasten und die Leertaste verschieben
        const primary = lastType !== 'mouse' || e.button === 0;
        if (nearSplit(p.x, p.y) && primary) {
          gesture.current = { kind: 'split' };
          el?.classList.add('w3vf-splitting');
        } else if (m !== 'tap' && (!primary || spaceDown.current)) {
          gesture.current = { kind: 'pan' };
        } else if (m === 'paint') {
          if (lastType !== 'mouse' && pitchPxOf(pr.layout, view.current.scale) < PAINT_MIN_TOUCH_PX) {
            gesture.current = { kind: 'paintBlocked' };
          } else {
            const stroke = new PaintStroke(pr.layout, pr.data, pr.focusRange ?? null);
            if (!inRuler(p.x, p.y)) {
              const w = toWorld(p.x, p.y);
              stroke.addAt(w.x, w.y);
            }
            gesture.current = { kind: 'paint', stroke, last: p };
            drawOverlay();
          }
        } else if (m === 'rect') {
          const w = toWorld(p.x, p.y);
          const a = cellNearPoint(pr.layout, w.x, w.y);
          rectLabelCache.current = null;
          gesture.current = { kind: 'rect', a, b: a };
        } else {
          gesture.current = { kind: 'tap' };
          if (pr.onLongPick) longTimer = window.setTimeout(onLong, LONG_PRESS_MS);
        }
      } else if (pointers.size === 2) {
        // zweiter Finger: Malstrich/Rechteck verwerfen, verschieben und zoomen
        clearLong();
        gesture.current = { kind: 'pinch' };
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        moved = true;
        drawOverlay();
      }
    };
    /** langes Drücken (nur Modus 'tap', nur mit onLongPick) */
    const onLong = () => {
      longTimer = 0;
      if (gesture.current.kind !== 'tap' || moved || pointers.size !== 1 || !downAt) return;
      longFired = true;
      const hit = hitAt(downAt.x, downAt.y);
      if (!hit) return;
      if (downAt.type !== 'mouse') tapHandled.current = true;
      if (!inRange(propsRef.current.focusRange, hit.row, hit.col)) {
        outside(hit);
        return;
      }
      const d = tapDecision(downAt.type, pieceMinSideMm(hit.poly), view.current.scale);
      if (d.pick) propsRef.current.onLongPick?.(hit.row, hit.col, hit.piece);
      else {
        animateZoomAt(downAt.x, downAt.y, d.zoom);
        showHint(tRef.current('viewer.tapZoomHint'));
      }
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      if (!pointers.has(e.pointerId)) {
        // Mauszeiger ohne gedrückte Taste: Statuszeile, Umriss, Cursor an der Trennlinie
        if ((e.pointerType || 'mouse') === 'mouse') {
          hovering.current = true;
          updateStatus(p.x, p.y);
          el?.classList.toggle('w3vf-split-hover', nearSplit(p.x, p.y));
        }
        return;
      }
      const prev = pointers.get(e.pointerId)!;
      pointers.set(e.pointerId, p);
      if (pointers.size === 1) {
        if (downAt && exceedsTapSlop(downAt.type, p.x - downAt.x, p.y - downAt.y)) {
          if (!moved) clearLong();
          moved = true;
        }
        const g = gesture.current;
        // Malen mit dem Finger, Steine zu klein: nicht still verschieben, sondern sofort sagen, warum nichts markiert wird
        if (g.kind === 'paintBlocked' && moved && !blockedHinted) {
          blockedHinted = true;
          showHint(tRef.current('w4fx.paintTooSmall'));
        }
        if (e.pointerType === 'mouse') updateStatus(p.x, p.y);
        if (g.kind === 'paint') {
          const a = toWorld(g.last.x, g.last.y);
          const b = toWorld(p.x, p.y);
          g.last = p;
          if (!inRuler(p.x, p.y) && g.stroke.addSegment(a.x, a.y, b.x, b.y) > 0) drawOverlay();
        } else if (g.kind === 'rect') {
          const w = toWorld(p.x, p.y);
          const b = cellNearPoint(propsRef.current.layout, w.x, w.y);
          if (b.row !== g.b.row || b.col !== g.b.col) {
            g.b = b;
            drawOverlay();
          }
        } else if (g.kind === 'split') {
          const s = compareSplitAt(propsRef.current.layout, view.current, p.x);
          if (s !== null) propsRef.current.onCompareSplit?.(s);
        } else if (g.kind === 'pan' || moved) {
          // Tippen, das zum Verschieben wurde; Verschieben (Leertaste/Mitteltaste); ein Finger nach dem Pinch
          view.current.ox += p.x - prev.x;
          view.current.oy += p.y - prev.y;
          draw();
        }
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        // zwei Finger: Mittelpunkt verschiebt, Abstand zoomt
        if (pinchMid) {
          view.current.ox += mid.x - pinchMid.x;
          view.current.oy += mid.y - pinchMid.y;
        }
        if (pinchDist > 0) zoomAt(mid.x, mid.y, d / pinchDist);
        else draw();
        pinchDist = d;
        pinchMid = mid;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const p = local(e);
      pointers.delete(e.pointerId);
      pointersDown.current = pointers.size;
      clearLong();
      const g = gesture.current;
      if (pointers.size === 0 && downAt) {
        const touchLike = downAt.type !== 'mouse';
        const pr = propsRef.current;
        if (g.kind === 'tap' && !moved && !longFired) {
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
            if (!inRange(pr.focusRange, hit.row, hit.col)) outside(hit);
            else if (d.pick) pr.onPick?.(hit.row, hit.col, hit.piece);
            else {
              animateZoomAt(p.x, p.y, d.zoom);
              showHint(tRef.current('viewer.tapZoomHint'));
            }
          }
        } else if (g.kind === 'paint') {
          if (touchLike) tapHandled.current = true;
          const st = g.stroke;
          if (!st.pieces.length && !moved) {
            // Antippen in der Fuge oder außerhalb des Bereichs: nichts ändern
            const hit = hitAt(p.x, p.y);
            if (hit && !inRange(pr.focusRange, hit.row, hit.col)) outside(hit);
          }
          if (st.pieces.length && st.set !== null) pr.onPaint?.(st.pieces.slice(), st.set);
        } else if (g.kind === 'paintBlocked') {
          if (moved) {
            // gezogen: das Mosaik wurde nur verschoben – Hinweis steht (siehe onMove), kein Geister-Klick
            tapHandled.current = true;
            if (!blockedHinted) showHint(tRef.current('w4fx.paintTooSmall'));
          } else {
            tapHandled.current = true;
            const pitch = pitchPxOf(pr.layout, view.current.scale);
            animateZoomAt(p.x, p.y, Math.min(TOUCH_ZOOM_TARGET_PX / Math.max(0.01, pitch), MAX_SCALE / view.current.scale));
            showHint(tRef.current('w3vf.paintZoomHint'));
          }
        } else if (g.kind === 'rect') {
          if (touchLike) tapHandled.current = true;
          if (!moved) showHint(tRef.current('w3vf.rectHint'));
          else {
            const rg = rectRange(g.a, g.b, pr.focusRange ?? null);
            if (rg) pr.onRect?.(rg);
            else outside({ ...g.b, piece: 0 });
          }
        }
      }
      if (pointers.size < 2) {
        pinchDist = 0;
        pinchMid = null;
      }
      if (pointers.size === 1) {
        // nach dem Pinch verschiebt der verbleibende Finger nur noch
        gesture.current = { kind: 'pan' };
        moved = true;
      }
      if (pointers.size === 0) {
        downAt = null;
        gesture.current = { kind: 'none' };
        el?.classList.remove('w3vf-splitting');
        // Haupt-Canvas und Overlay im selben Bild: der Strich verschwindet erst mit den geänderten Steinen
        draw();
      }
    };
    /** Abbruch durch den Browser oder eine System-Geste: nur Zustand zurücksetzen, nie auswählen */
    const onCancel = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      pointersDown.current = pointers.size;
      moved = true;
      if (pointers.size < 2) {
        pinchDist = 0;
        pinchMid = null;
      }
      if (pointers.size === 0) {
        downAt = null;
        el?.classList.remove('w3vf-splitting');
        cancelGesture();
      }
    };
    const onLeave = (e: PointerEvent) => {
      if ((e.pointerType || 'mouse') !== 'mouse') return;
      hovering.current = false;
      el?.classList.remove('w3vf-split-hover');
      const sm = statusMain.current;
      if (sm && pointers.size === 0) {
        sm.dataset.idle = '1';
        sm.textContent = tRef.current(hoverIdleKey());
        if (statusSub.current) statusSub.current.textContent = '';
      }
      if (pointers.size === 0) setHover(null);
    };
    const onEnter = (e: PointerEvent) => {
      if ((e.pointerType || 'mouse') === 'mouse') hovering.current = true;
    };
    /** Rechtsklick = langes Drücken (Maus); bei Finger/Stift nur das System-Kontextmenü unterdrücken */
    const onContext = (e: MouseEvent) => {
      const pr = propsRef.current;
      // Malen/Rechteck: rechte Taste verschiebt, kein Kontextmenü über dem Mosaik
      if (mode() !== 'tap') {
        e.preventDefault();
        return;
      }
      if (!pr.onLongPick) return;
      e.preventDefault();
      if (lastType !== 'mouse') return;
      const p = local(e);
      const hit = hitAt(p.x, p.y);
      if (!hit) return;
      if (!inRange(pr.focusRange, hit.row, hit.col)) outside(hit);
      else pr.onLongPick(hit.row, hit.col, hit.piece);
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onCancel);
    cv.addEventListener('pointerleave', onLeave);
    cv.addEventListener('pointerenter', onEnter);
    cv.addEventListener('contextmenu', onContext);
    return () => {
      stopAnim();
      clearLong();
      pointersDown.current = 0;
      cv.removeEventListener('wheel', onWheel);
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onCancel);
      cv.removeEventListener('pointerleave', onLeave);
      cv.removeEventListener('pointerenter', onEnter);
      cv.removeEventListener('contextmenu', onContext);
    };
    // drawOverlay/insets/updateStatus lesen nur Refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draw, stopAnim, showHint]);

  const zoomBtn = (f: number) => {
    stopAnim();
    const v = view.current;
    const ins = rulerInsets(propsRef.current.layout, propsRef.current.rulers);
    const k = f;
    const px = ins.left + (v.width - ins.left) / 2;
    const py = ins.top + (v.height - ins.top) / 2;
    v.ox = px - (px - v.ox) * k;
    v.oy = py - (py - v.oy) * k;
    v.scale *= k;
    draw();
  };

  const mode = props.mode ?? 'tap';
  const statusOn = props.hoverStatus !== false;
  const coarse = useCoarsePointer();
  return (
    <>
      <div
        className={`viewer w3vf-viewer w3vf-mode-${mode} ${props.height === undefined ? 'w3vf-auto-h' : ''} ${props.rulers ? 'w3vf-has-rulers' : ''}`}
        ref={wrap}
        style={props.height !== undefined ? { height: props.height } : undefined}
        data-mode={mode}
      >
        <canvas ref={canvas} data-testid="mosaic-canvas" />
        <canvas ref={overlay} className="w3vf-overlay" aria-hidden="true" />
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
      {statusOn && (
        <div className="w3vf-status" data-testid="viewer-status">
          <span ref={statusMain} className="w3vf-status-main" data-idle="1" data-testid="viewer-status-main">
            {t(coarse ? 'w5fu.hoverIdle.touch' : 'w3vf.hoverIdle')}
          </span>
          <span ref={statusSub} className="w3vf-status-sub" data-testid="viewer-status-cursor" />
        </div>
      )}
    </>
  );
});
