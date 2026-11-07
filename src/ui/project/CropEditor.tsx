import { useEffect, useRef } from 'react';
import type { Crop } from './imagePrep';

/** Zuschnitt mit fixiertem Seitenverhältnis (= Mosaikfläche). Verschieben und Größe per Eckgriff. */
export function CropEditor(props: { source: HTMLCanvasElement; crop: Crop; aspect: number; onChange: (c: Crop) => void; maxHeight?: number }) {
  const holder = useRef<HTMLDivElement>(null);
  const { source, crop, aspect } = props;
  useEffect(() => {
    const h = holder.current;
    if (!h) return;
    h.querySelector('canvas')?.remove();
    source.style.width = '100%';
    source.style.height = 'auto';
    source.style.display = 'block';
    h.prepend(source);
  }, [source]);

  const startDrag = (e: React.PointerEvent, mode: 'move' | 'resize') => {
    e.preventDefault();
    e.stopPropagation();
    const el = holder.current!;
    const rect = el.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, c: { ...crop } };
    const rw = source.width;
    const rh = source.height;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / rect.width;
      const dy = (ev.clientY - start.y) / rect.height;
      if (mode === 'move') {
        props.onChange({
          ...start.c,
          x: Math.min(1 - start.c.w, Math.max(0, start.c.x + dx)),
          y: Math.min(1 - start.c.h, Math.max(0, start.c.y + dy)),
        });
      } else {
        // Breite in Pixeln ändern, Höhe folgt dem Seitenverhältnis
        let wPx = Math.max(20, (start.c.w + dx) * rw);
        let hPx = wPx / aspect;
        const maxW = (1 - start.c.x) * rw;
        const maxH = (1 - start.c.y) * rh;
        const sc = Math.min(1, maxW / wPx, maxH / hPx);
        wPx *= sc;
        hPx *= sc;
        props.onChange({ ...start.c, w: wPx / rw, h: hPx / rh });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="crop-holder" ref={holder} style={{ maxWidth: props.maxHeight ? (props.maxHeight * source.width) / source.height : undefined }}>
      <div className="crop-shade" style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${crop.x * 100}% ${crop.y * 100}%, ${crop.x * 100}% ${(crop.y + crop.h) * 100}%, ${(crop.x + crop.w) * 100}% ${(crop.y + crop.h) * 100}%, ${(crop.x + crop.w) * 100}% ${crop.y * 100}%, ${crop.x * 100}% ${crop.y * 100}%)` }} />
      <div
        className="crop-box"
        style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
        onPointerDown={(e) => startDrag(e, 'move')}
      >
        <div className="crop-thirds" />
        <div className="crop-handle" onPointerDown={(e) => startDrag(e, 'resize')} />
      </div>
    </div>
  );
}
