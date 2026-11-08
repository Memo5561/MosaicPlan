import { useEffect, useMemo, useRef, useState } from 'react';
import { regionCellSpan } from '../../core/layout';
import type { Region } from '../../core/types';
import { uid } from '../../storage/db';
import { useI18n } from '../../i18n';
import { Badge, Segmented } from '../components';
import '../css/w3-face-guidance.css';
import { expandFaceBox, faceLight, faceRegionsOf, MIN_REGION_PX, regionLargeEnough, startsDrawing } from './faceGuidance';
import { detectFaces, renderCropped } from './imagePrep';
import { staleReasons } from './staleReasons';
import { stepHash } from './stepNav';
import { computeKey, type ProjectApi } from './useProject';

/** Automatische Gesichtserkennung gibt es nur mit der Shape-Detection-API (z. B. nicht in Chromium ohne Flag, Firefox, Safari). */
const canDetect = () => typeof globalThis !== 'undefined' && 'FaceDetector' in globalThis;

/**
 * Gesichts- und Detailbereiche auf dem Foto markieren.
 *
 * - Maus und Stift zeichnen direkt. Ein Finger zeichnet nur nach „Bereich zeichnen“ (touch-action: none);
 *   sonst bleibt das Bild wischbar (pan-y pinch-zoom), damit ein Wischen zum Scrollen keinen Bereich anlegt.
 *   Nach einem gezeichneten Bereich schaltet der Zeichenmodus wieder ab.
 * - pointercancel / lostpointercapture brechen ohne Speichern ab; Bereiche unter 24 px je Seite werden verworfen.
 * - Jeder Bereich trägt seine Nummer (wie in der Liste); Gesichter zeigen, wie viele Steine sie überspannen.
 */
export function RegionEditor({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const { bitmap, effectiveCrop, layout } = api;
  const rec = api.rec!;
  const regions = rec.regions;
  const [mode, setMode] = useState<Region['type']>('face');
  const [shape, setShape] = useState<Region['shape']>('ellipse');
  const [draft, setDraft] = useState<Region | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: 'info' | 'warn' } | null>(null);
  const [detecting, setDetecting] = useState(false);
  const detectSupported = useMemo(canDetect, []);
  const holder = useRef<HTMLDivElement>(null);
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  const cleanupRef = useRef<(() => void) | null>(null);

  // Bild nur neu zeichnen, wenn sich Foto, Zuschnitt, Bildeinstellungen oder das Seitenverhältnis ändern –
  // nicht bei jedem neuen Bereich (sonst flackert das Bild bei jeder Änderung)
  const aspect = layout ? layout.finishedW / layout.finishedH : null;
  const adjust = rec.adjust;
  const img = useMemo(() => {
    if (!bitmap || !effectiveCrop || !aspect) return null;
    const tw = aspect >= 1 ? 640 : Math.round(640 * aspect);
    return renderCropped(bitmap, adjust, effectiveCrop, tw, Math.round(tw / aspect));
  }, [bitmap, effectiveCrop, aspect, adjust]);
  useEffect(() => {
    const h = holder.current;
    if (!h || !img) return;
    h.querySelector('canvas')?.remove();
    img.style.width = '100%';
    img.style.display = 'block';
    img.setAttribute('aria-hidden', 'true');
    h.prepend(img);
  }, [img]);
  // laufende Geste beim Verlassen beenden (Listener nicht liegen lassen)
  useEffect(() => () => cleanupRef.current?.(), []);

  // Bereiche seit der letzten Berechnung geändert? (nur dann der Hinweis hier – die übrigen Gründe zeigt Schritt 7)
  const regionsChanged = useMemo(() => {
    if (!api.computed || !rec.computedWith) return false;
    try {
      return staleReasons(rec.computedWith, computeKey(rec)).some((r) => r.group === 'regions');
    } catch {
      return false;
    }
  }, [api.computed, rec]);

  if (!img) return <p className="muted">{t('shapes.noPhoto')}</p>;

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!startsDrawing(e, drawingRef.current)) return;
    cleanupRef.current?.();
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x0 = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y0 = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    const pointerId = e.pointerId;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      /* Zeiger schon weg */
    }
    if (e.pointerType === 'mouse') e.preventDefault(); // keine Textauswahl beim Ziehen
    let cur: Region = { id: uid(), type: mode, shape, x: x0, y: y0, w: 0, h: 0 };
    let done = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const x1 = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const y1 = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      cur = { ...cur, x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      setDraft(cur);
    };
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('lostpointercapture', cancel);
      try {
        if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
      } catch {
        /* schon freigegeben */
      }
      if (cleanupRef.current === abort) cleanupRef.current = null;
      setDraft(null);
      if (!commit) return;
      if (regionLargeEnough(cur, r.width, r.height)) {
        const next = [...api.rec!.regions, cur];
        api.setRegions(next);
        setMsg({ text: t('w3fg.added', { n: next.length }), kind: 'info' });
        setDrawing(false); // nächster Fingerwisch scrollt wieder
      } else if (cur.w > 0 || cur.h > 0 || drawingRef.current) {
        setMsg({ text: t('w3fg.tooSmall', { px: MIN_REGION_PX }), kind: 'warn' });
      }
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(true);
    };
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || done) return;
      finish(false);
      setMsg({ text: t('w3fg.cancelled'), kind: 'warn' });
    };
    const abort = () => finish(false);
    cleanupRef.current = abort;
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('lostpointercapture', cancel);
  };

  const remove = (id: string) => {
    api.setRegions(regions.filter((x) => x.id !== id));
    setMsg(null);
  };
  const startFace = () => {
    setMode('face');
    setShape('ellipse');
    setDrawing(true);
    setMsg(null);
  };
  const detect = async () => {
    setDetecting(true);
    try {
      const faces = await detectFaces(img);
      if (faces === null) setMsg({ text: t('shapes.faceUnsupported'), kind: 'warn' });
      else if (faces.length === 0) setMsg({ text: t('shapes.faceNone'), kind: 'info' });
      else {
        setMsg({ text: t('shapes.faceFound', { n: faces.length }), kind: 'info' });
        api.setRegions([...api.rec!.regions, ...faces.map((f) => ({ id: uid(), type: 'face' as const, shape: 'ellipse' as const, ...expandFaceBox(f) }))]);
      }
    } finally {
      setDetecting(false);
    }
  };

  const hasFace = faceRegionsOf(regions).length > 0;
  const all = draft ? [...regions, draft] : regions;
  const shapeName = (s: Region['shape']) => t(s === 'ellipse' ? 'w3fg.shape.ellipse' : 'w3fg.shape.rect');
  return (
    <div className="w3fg-regions">
      <h3>{t('shapes.regions')}</h3>
      <p className="muted small">{t('shapes.regionsHint')}</p>
      {!detectSupported && !hasFace && (
        <div className="w3fg-manual" data-testid="face-manual-card">
          <b>{t('w3fg.manual.title')}</b>
          <p className="small">{t('w3fg.manual.text')}</p>
          <button className="btn small primary" onClick={startFace} data-testid="face-manual-start">
            {t('w3fg.manual.start')}
          </button>
        </div>
      )}
      <div className="btn-row wrap w3fg-tools">
        <Segmented value={mode} options={[{ value: 'face', label: t('shapes.region.face') }, { value: 'detail', label: t('shapes.region.detail') }]} onChange={setMode} testId="region-type" />
        <Segmented
          value={shape}
          options={[
            { value: 'ellipse', label: <span title={shapeName('ellipse')} aria-label={shapeName('ellipse')}>◯</span> },
            { value: 'rect', label: <span title={shapeName('rect')} aria-label={shapeName('rect')}>▭</span> },
          ]}
          onChange={setShape}
          testId="region-shape"
        />
        <button className={`btn small ${drawing ? 'primary' : ''}`} aria-pressed={drawing} onClick={() => setDrawing((d) => !d)} data-testid="region-draw-toggle">
          {drawing ? t('w3fg.drawStop') : t('w3fg.draw')}
        </button>
        {detectSupported && (
          <button className="btn small" onClick={detect} disabled={detecting} data-testid="detect-faces">
            {t('shapes.detectFaces')}
          </button>
        )}
      </div>
      {drawing && (
        <p className="small w3fg-draw-hint" role="status">
          {t('w3fg.drawHint')}
        </p>
      )}
      {msg && (
        <p className={`small ${msg.kind === 'warn' ? 'w3fg-msg-warn' : 'muted'}`} role="status" data-testid="region-msg">
          {msg.text}
        </p>
      )}
      <div className={`region-holder w3fg-holder ${drawing ? 'w3fg-draw' : ''}`} ref={holder} onPointerDown={onDown} data-testid="region-holder" data-drawing={drawing ? '1' : '0'}>
        {all.map((r, i) => (
          <div
            key={r.id}
            className={`region region-${r.type} ${r.shape} ${r === draft ? 'w3fg-draft' : ''}`}
            data-testid={r === draft ? 'region-draft' : 'region-overlay'}
            style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
          >
            {r !== draft && <span className="w3fg-num">{i + 1}</span>}
          </div>
        ))}
      </div>
      {regionsChanged && (
        <div className="w3fg-changed" role="status" data-testid="regions-changed">
          <span>{t('w3fg.regionsChanged')}</span>
          <button className="btn small" onClick={() => (location.hash = stepHash(rec.meta.id, 'compute'))} data-testid="regions-go-compute">
            {t('w3fg.goCompute')}
          </button>
        </div>
      )}
      {regions.length === 0 ? (
        <p className="muted small">{t('w3fg.none')}</p>
      ) : (
        <ul className="region-list w3fg-list" data-testid="region-list">
          {regions.map((r, i) => {
            const span = r.type === 'face' && layout ? regionCellSpan(layout, r) : null;
            const light = span ? faceLight(span.cols) : null;
            return (
              <li key={r.id} data-testid="region-item">
                <span className="w3fg-num-inline">{i + 1}</span>
                <span className="w3fg-item-text">
                  <span>
                    {t(`shapes.region.${r.type}`)} ({shapeName(r.shape)})
                  </span>
                  {span && light && (
                    <span className="small w3fg-span" data-testid="region-face-span" data-cols={span.cols} data-light={light}>
                      <span className={`w3fg-dot w3fg-${light}`} aria-hidden="true" />
                      {t('w3fg.faceSpan', { cols: n(span.cols), rows: n(span.rows) })} · {t(`w3fg.light.${light}`)} <Badge kind="info">{t('w3fg.richtwert')}</Badge>
                    </span>
                  )}
                </span>
                <button className="icon-btn w3fg-del" onClick={() => remove(r.id)} aria-label={t('w3fg.removeN', { n: i + 1 })} title={t('w3fg.removeN', { n: i + 1 })}>
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {regions.length > 0 && (
        <button className="btn small" onClick={() => remove(regions[regions.length - 1].id)} data-testid="region-remove-last">
          {t('w3fg.removeLast')}
        </button>
      )}
    </div>
  );
}
