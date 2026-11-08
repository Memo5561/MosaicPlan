import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Slider } from '../components';
import { cropPixelInfo, cropZoomOf, LOW_PX_PER_STONE, moveCrop, pinchCrop, resizeCropFromCorner, zoomCrop, type Corner, type Crop } from './imagePrep';
import '../css/w2-photo-intake.css';

/** Kleinster Rahmen (kürzere Seite, CSS-Pixel der Anzeige) beim Ziehen an einer Ecke – Verschieben bleibt möglich. */
export const MIN_BOX_CSS = 90;
/** Trefferfläche eines Eckgriffs (CSS-Pixel), liegt vollständig INNERHALB des Rahmens */
export const HANDLE_HIT = 44;
/** Ab dieser kürzeren Rahmenseite werden alle vier Eckgriffe gezeigt, darunter nur unten rechts */
const ALL_HANDLES_FROM = 110;
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];

type Drag =
  | { kind: 'move'; id: number; x0: number; y0: number; c: Crop }
  | { kind: 'resize'; id: number; corner: Corner; x0: number; y0: number; c: Crop }
  | { kind: 'pinch'; ids: [number, number]; d0: number; mx0: number; my0: number; c: Crop };

/**
 * Zuschnitt mit fixiertem Seitenverhältnis (= Mosaikfläche). Verschieben am Rahmen, Größe an jeder der vier
 * Ecken (die gegenüberliegende Ecke bleibt fest), mit zwei Fingern zoomen oder über den Regler.
 * `srcW × srcH`: Pixel des gedrehten ORIGINALS – Seitenverhältnis und Pixelangaben beziehen sich darauf.
 */
export function CropEditor(props: {
  source: HTMLCanvasElement;
  crop: Crop;
  aspect: number;
  srcW: number;
  srcH: number;
  grid?: { cols: number; rows: number } | null;
  onChange: (c: Crop) => void;
  maxHeight?: number;
}) {
  const { t, n } = useI18n();
  const holder = useRef<HTMLDivElement>(null);
  const { source, crop, aspect, srcW, srcH } = props;
  const cropRef = useRef(crop);
  cropRef.current = crop;
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<Drag | null>(null);
  const [active, setActive] = useState<Corner | 'move' | 'pinch' | null>(null);
  const [disp, setDisp] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const h = holder.current;
    if (!h) return;
    h.querySelector('canvas')?.remove();
    source.style.width = '100%';
    source.style.height = 'auto';
    source.style.display = 'block';
    source.dataset.testid = 'crop-canvas';
    h.prepend(source);
  }, [source]);

  // Angezeigte Größe des Bildes (für Griffgrößen und die Umrechnung Finger → Bildpixel)
  useLayoutEffect(() => {
    const measure = () => {
      const r = source.getBoundingClientRect();
      setDisp((d) => (Math.abs(d.w - r.width) < 0.5 && Math.abs(d.h - r.height) < 0.5 ? d : { w: r.width, h: r.height }));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(source);
    return () => ro?.disconnect();
  }, [source]);

  const rect = () => source.getBoundingClientRect();
  /** kürzeste Rahmenseite in Bildpixeln des Originals, die MIN_BOX_CSS Anzeigepixeln entspricht */
  const minShortSrc = (r: DOMRect) => (r.width > 0 ? (MIN_BOX_CSS * srcW) / r.width : 0);

  const end = () => {
    drag.current = null;
    setActive(null);
  };

  const startPinch = (): boolean => {
    const ids = [...pointers.current.keys()].slice(0, 2);
    if (ids.length < 2) return false;
    const a = pointers.current.get(ids[0])!;
    const b = pointers.current.get(ids[1])!;
    const d0 = Math.hypot(b.x - a.x, b.y - a.y);
    if (d0 < 8) return false;
    drag.current = { kind: 'pinch', ids: [ids[0], ids[1]], d0, mx0: (a.x + b.x) / 2, my0: (a.y + b.y) / 2, c: { ...cropRef.current } };
    setActive('pinch');
    return true;
  };

  const onDown = (e: React.PointerEvent, mode: Corner | 'move') => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      // Ereignisse bleiben beim Rahmen-Halter, auch wenn der Finger das Bild verlässt
      holder.current?.setPointerCapture(e.pointerId);
    } catch {
      /* ältere Browser: Ereignisse kommen trotzdem, solange der Finger auf dem Bild bleibt */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // zweiter Finger während eines Zugs: Zwei-Finger-Zoom
    if (drag.current && pointers.current.size >= 2 && startPinch()) return;
    const c = { ...cropRef.current };
    drag.current = mode === 'move' ? { kind: 'move', id: e.pointerId, x0: e.clientX, y0: e.clientY, c } : { kind: 'resize', id: e.pointerId, corner: mode, x0: e.clientX, y0: e.clientY, c };
    setActive(mode);
  };

  /** Zweiter Finger neben dem Rahmen (auf dem abgedunkelten Bild), während der erste den Rahmen hält */
  const onHolderDown = (e: React.PointerEvent) => {
    if (!drag.current || e.pointerType === 'mouse') return;
    e.preventDefault();
    try {
      holder.current?.setPointerCapture(e.pointerId);
    } catch {
      /* siehe onDown */
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startPinch();
  };

  const onMove = (e: React.PointerEvent) => {
    const p = pointers.current;
    if (!p.has(e.pointerId)) return;
    p.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = drag.current;
    if (!d) return;
    const r = rect();
    if (r.width <= 0 || r.height <= 0) return;
    if (d.kind === 'pinch') {
      const a = p.get(d.ids[0]);
      const b = p.get(d.ids[1]);
      if (!a || !b) return;
      const scale = Math.hypot(b.x - a.x, b.y - a.y) / d.d0;
      const dx = ((a.x + b.x) / 2 - d.mx0) / r.width;
      const dy = ((a.y + b.y) / 2 - d.my0) / r.height;
      onChangeRef.current(pinchCrop(d.c, scale, dx, dy, srcW, srcH, aspect, minShortSrc(r)));
      return;
    }
    if (e.pointerId !== d.id) return;
    if (d.kind === 'move') {
      onChangeRef.current(moveCrop(d.c, (e.clientX - d.x0) / r.width, (e.clientY - d.y0) / r.height));
    } else {
      const dx = ((e.clientX - d.x0) * srcW) / r.width;
      const dy = ((e.clientY - d.y0) * srcH) / r.height;
      onChangeRef.current(resizeCropFromCorner(d.c, d.corner, dx, dy, srcW, srcH, aspect, minShortSrc(r)));
    }
  };

  const onUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pinch') {
      // ein Finger bleibt: als Verschieben weiterführen
      const rest = [...pointers.current.entries()][0];
      if (rest) {
        drag.current = { kind: 'move', id: rest[0], x0: rest[1].x, y0: rest[1].y, c: { ...cropRef.current } };
        setActive('move');
      } else end();
    } else if (d.id === e.pointerId) {
      pointers.current.clear();
      end();
    }
  };

  // Ansicht verlassen mitten im Zug: nichts hängen lassen
  useEffect(() => () => pointers.current.clear(), []);

  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.01;
    const k: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const v = k[e.key];
    if (!v) return;
    e.preventDefault();
    props.onChange(moveCrop(crop, v[0], v[1]));
  };

  const boxW = crop.w * disp.w;
  const boxH = crop.h * disp.h;
  const short = Math.min(boxW, boxH);
  const visible = CORNERS.filter((c) => c === 'se' || c === active || short >= ALL_HANDLES_FROM);
  const hit = Math.round(Math.max(24, Math.min(HANDLE_HIT, short * 0.45 || HANDLE_HIT)));

  const zoom = cropZoomOf(crop, srcW, srcH, aspect);
  const info = props.grid ? cropPixelInfo(crop, srcW, srcH, props.grid.cols, props.grid.rows) : null;
  const perStone = (v: number) => n(v, v < 10 ? 1 : 0);
  const low = info && Math.min(info.perStoneW, info.perStoneH) < LOW_PX_PER_STONE;

  return (
    <div className="w2pi-crop" style={{ maxWidth: props.maxHeight ? (props.maxHeight * source.width) / source.height : undefined }}>
      <div
        className="crop-holder w2pi-holder"
        ref={holder}
        data-testid="crop-holder"
        data-aspect={aspect}
        onPointerDown={onHolderDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onLostPointerCapture={onUp}
      >
        <div
          className="crop-shade"
          style={{
            clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${crop.x * 100}% ${crop.y * 100}%, ${crop.x * 100}% ${(crop.y + crop.h) * 100}%, ${(crop.x + crop.w) * 100}% ${(crop.y + crop.h) * 100}%, ${(crop.x + crop.w) * 100}% ${crop.y * 100}%, ${crop.x * 100}% ${crop.y * 100}%)`,
          }}
        />
        <div
          className={`crop-box w2pi-box ${active ? 'w2pi-dragging' : ''}`}
          data-testid="crop-box"
          tabIndex={0}
          role="group"
          aria-label={t('crop.boxLabel')}
          style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
          onPointerDown={(e) => onDown(e, 'move')}
          onKeyDown={onKey}
        >
          <div className="crop-thirds" />
          {visible.map((c) => (
            <div
              key={c}
              className={`crop-handle w2pi-handle w2pi-${c} ${active === c ? 'active' : ''}`}
              data-testid={`crop-handle-${c}`}
              style={{ width: hit, height: hit }}
              onPointerDown={(e) => onDown(e, c)}
            />
          ))}
        </div>
      </div>
      <div className="w2pi-zoom" data-testid="crop-zoom">
        <Slider label={t('crop.zoom')} value={Math.round(zoom * 100)} min={15} max={100} step={1} onChange={(v) => props.onChange(zoomCrop(crop, srcW, srcH, aspect, v / 100))} format={(v) => `${v} %`} />
      </div>
      {info && (
        <p className="small w2pi-readout" data-testid="crop-readout">
          {t('crop.readout', { w: n(info.w), h: n(info.h), sw: perStone(info.perStoneW), sh: perStone(info.perStoneH) })}
        </p>
      )}
      {low && (
        <p className="small warn" data-testid="crop-lowres">
          {t('crop.lowRes', { min: LOW_PX_PER_STONE })}
        </p>
      )}
    </div>
  );
}
