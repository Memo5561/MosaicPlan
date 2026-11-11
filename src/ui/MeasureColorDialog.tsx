/**
 * „Farbe aus Foto messen“ (Paket w6-colour-measure): Foto aufnehmen oder wählen, optional eine neutrale Referenz
 * (weißes Papier / Graukarte 18 %) antippen, dann den Stein. Gemessen wird eine Fläche (Glanzlichter, Fuge und
 * Kantenschatten verworfen, Mittel in linearem sRGB, siehe core/colorMeasure.ts). Es wird nichts gespeichert:
 * „Übernehmen“ setzt nur den HEX-Wert im Materialformular, gespeichert wird dort mit „Speichern“.
 * Das Ergebnis ist eine Näherung (Richtwert) und wird nie als kalibriert dargestellt (Anforderung 18).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isValidHex } from '../core/color';
import {
  deltaEHex,
  measureReference,
  measureWarnings,
  photoSource,
  readColorSource,
  samplePatch,
  SPREAD_WARN_DE,
  type ColorSource,
  type RgbaImage,
  type ReferenceMode,
} from '../core/colorMeasure';
import { useI18n, type Lang, type TFunc } from '../i18n';
import { Modal, Swatch } from './components';
import { loadWorkingBitmap, photoErrorKey } from './project/imagePrep';
import './css/w6-colour-measure.css';

/** Längste Seite des Messbilds (Speicher auf Android begrenzen; für eine Steinfläche mehr als genug). */
const MEASURE_MAX_SIDE = 2000;
const ZOOMS = [1, 1.5, 2, 3, 4, 6, 8];

type RefChoice = 'none' | ReferenceMode;
type Pt = { x: number; y: number };

interface Photo {
  canvas: HTMLCanvasElement;
  img: RgbaImage;
  w: number;
  h: number;
  srcW: number;
  srcH: number;
}

const locale = (lang: Lang) => (lang === 'de' ? 'de-DE' : lang === 'tr' ? 'tr-TR' : 'en-GB');

/**
 * Kurztext zur Herkunft eines Farbwerts für Liste, Formular und Importvorschau. null = nichts anzeigen
 * (eingegeben oder unbekannt), außer `always` ist gesetzt.
 */
export function colorSourceLabel(t: TFunc, n: (v: number, d?: number) => string, raw: unknown, always = false): string | null {
  const src = readColorSource(raw);
  if (!src) return always ? t('w6cm.tag.unknown') : null;
  if (src.kind === 'manual') return always ? t('w6cm.tag.manual') : null;
  if (src.kind === 'eyedropper') return t('w6cm.tag.eyedropper');
  const ref = t(`w6cm.ref.${src.reference ?? 'none'}`);
  return src.spreadDE !== undefined ? t('w6cm.tag.photo', { ref, de: n(src.spreadDE, 1) }) : t('w6cm.tag.photoNoSpread', { ref });
}

/** Kennzeichnung eines gemessenen Farbwerts (Fotomessung bzw. Pipette); nichts bei eingegebenen Werten. */
export function ColorSourceTag({ source, testId }: { source: unknown; testId?: string }) {
  const { t, n, lang } = useI18n();
  const label = colorSourceLabel(t, n, source);
  if (!label) return null;
  const src = readColorSource(source)!;
  const title =
    src.kind === 'photo'
      ? src.measuredAt
        ? t('w6cm.tag.title', { date: new Date(src.measuredAt).toLocaleDateString(locale(lang)) })
        : t('w6cm.tag.titleNoDate')
      : undefined;
  return (
    <span className={`w6cm-tag ${src.kind === 'photo' ? 'is-photo' : 'is-dropper'}`} title={title} data-testid={testId}>
      {label}
    </span>
  );
}

export function MeasureColorDialog({ currentHex, onApply, onClose }: { currentHex: string; onApply: (hex: string, source: ColorSource) => void; onClose: () => void }) {
  const { t, n } = useI18n();
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refChoice, setRefChoice] = useState<RefChoice>('paper');
  const [target, setTarget] = useState<'ref' | 'tile'>('ref');
  const [refPt, setRefPt] = useState<Pt | null>(null);
  const [tilePt, setTilePt] = useState<Pt | null>(null);
  const [radius, setRadius] = useState(12);
  const [zoomIdx, setZoomIdx] = useState(0);
  const [fitW, setFitW] = useState(0);
  const camRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const cropRef = useRef<HTMLCanvasElement>(null);
  const zoomFocus = useRef<{ fx: number; fy: number } | null>(null);
  const zoom = ZOOMS[zoomIdx];

  const onFile = async (file: File) => {
    setError(null);
    setLoading(true);
    try {
      const wb = await loadWorkingBitmap(file, MEASURE_MAX_SIDE * MEASURE_MAX_SIDE);
      const bmp = wb.bitmap;
      const s = Math.min(1, MEASURE_MAX_SIDE / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * s));
      const h = Math.max(1, Math.round(bmp.height * s));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('canvas');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      const data = ctx.getImageData(0, 0, w, h);
      setPhoto({ canvas, img: { data: data.data, width: w, height: h }, w, h, srcW: wb.srcW, srcH: wb.srcH });
      setRefPt(null);
      setTilePt(null);
      setZoomIdx(0);
      setRadius(Math.max(4, Math.round(Math.max(w, h) * 0.015)));
      setTarget(refChoice === 'none' ? 'tile' : 'ref');
    } catch (e) {
      setError(t(photoErrorKey(file, e)));
    } finally {
      setLoading(false);
    }
  };

  // Einpassbreite: ganzes Foto im Rahmen (Breite des Dialogs, Höhe höchstens ~55 % des Fensters)
  useLayoutEffect(() => {
    if (!photo) return;
    const fit = () => {
      const st = stageRef.current;
      if (!st) return;
      const maxH = Math.max(200, Math.min(window.innerHeight * 0.55, 620));
      setFitW(Math.max(120, Math.floor(Math.min(st.clientWidth, (maxH * photo.w) / photo.h))));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [photo]);

  const refRes = useMemo(() => (photo && refPt && refChoice !== 'none' ? measureReference(photo.img, refPt.x, refPt.y, radius, refChoice) : null), [photo, refPt, radius, refChoice]);
  const gains = refRes?.ok ? refRes.gains : undefined;
  const res = useMemo(() => (photo && tilePt ? samplePatch(photo.img, tilePt.x, tilePt.y, radius, { gains }) : null), [photo, tilePt, radius, gains]);
  const warnings = res ? measureWarnings(res, !!gains) : [];
  const usable = !!res && res.n > 0 && isValidHex(res.hex);

  // Ansicht zeichnen: Foto + Messkreise (Linienstärke unabhängig vom Zoom)
  useEffect(() => {
    const cv = viewRef.current;
    if (!cv || !photo) return;
    cv.width = photo.w;
    cv.height = photo.h;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(photo.canvas, 0, 0);
    const px = photo.w / Math.max(1, fitW * zoom);
    const ring = (p: Pt, color: string, dash: boolean) => {
      ctx.save();
      ctx.lineWidth = 2.5 * px;
      ctx.setLineDash(dash ? [6 * px, 4 * px] : []);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 1.5 * px, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    };
    if (refPt && refChoice !== 'none') ring(refPt, refRes && !refRes.ok ? '#ff5a5a' : '#ffffff', true);
    if (tilePt) ring(tilePt, '#ffd23f', false);
  }, [photo, refPt, tilePt, radius, fitW, zoom, refChoice, refRes]);

  // Ausschnitt neben dem Messwert: die Steinfläche vergrößert
  useEffect(() => {
    const cv = cropRef.current;
    if (!cv || !photo || !tilePt) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const side = Math.max(8, radius * 2.4);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(photo.canvas, tilePt.x - side / 2, tilePt.y - side / 2, side, side, 0, 0, cv.width, cv.height);
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cv.width / 2, cv.height / 2, (radius / side) * cv.width, 0, Math.PI * 2);
    ctx.stroke();
  }, [photo, tilePt, radius]);

  // Zoom um den zuletzt angetippten Punkt (sonst um die Mitte der Ansicht)
  useLayoutEffect(() => {
    const st = stageRef.current;
    const f = zoomFocus.current;
    if (!st || !f) return;
    zoomFocus.current = null;
    st.scrollLeft = f.fx * st.scrollWidth - st.clientWidth / 2;
    st.scrollTop = f.fy * st.scrollHeight - st.clientHeight / 2;
  }, [zoomIdx]);

  const changeZoom = (idx: number) => {
    const st = stageRef.current;
    const p = target === 'ref' ? (refPt ?? tilePt) : (tilePt ?? refPt);
    if (photo && p) zoomFocus.current = { fx: p.x / photo.w, fy: p.y / photo.h };
    else if (st) zoomFocus.current = { fx: (st.scrollLeft + st.clientWidth / 2) / Math.max(1, st.scrollWidth), fy: (st.scrollTop + st.clientHeight / 2) / Math.max(1, st.scrollHeight) };
    setZoomIdx(Math.max(0, Math.min(ZOOMS.length - 1, idx)));
  };

  const onTap = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!photo) return;
    const r = e.currentTarget.getBoundingClientRect();
    const p = { x: ((e.clientX - r.left) / r.width) * photo.w, y: ((e.clientY - r.top) / r.height) * photo.h };
    if (p.x < 0 || p.y < 0 || p.x > photo.w || p.y > photo.h) return;
    if (target === 'ref' && refChoice !== 'none') {
      setRefPt(p);
      const rr = measureReference(photo.img, p.x, p.y, radius, refChoice);
      if (rr.ok) setTarget('tile');
    } else setTilePt(p);
  };

  const chooseRef = (c: RefChoice) => {
    setRefChoice(c);
    if (c === 'none') setTarget('tile');
    else if (!refPt) setTarget('ref');
  };

  const maxRadius = photo ? Math.max(6, Math.round(Math.min(photo.w, photo.h) / 6)) : 100;
  const deCurrent = res && usable && isValidHex(currentHex) ? deltaEHex(currentHex, res.hex) : NaN;
  const refStatus = refChoice === 'none' ? null : !refRes ? null : refRes.ok ? { cls: 'ok', text: t('w6cm.refOk', { n: n(refRes.patch.n) }) } : { cls: 'error', text: t(`w6cm.refErr.${refRes.reason}`) };

  return (
    <Modal
      wide
      title={t('w6cm.title')}
      onClose={onClose}
      footer={
        <div className="w6cm-foot">
          <span className="muted small">{t('w6cm.applyHint')}</span>
          <div className="btn-row">
            <button className="btn" onClick={onClose} data-testid="measure-cancel">
              {t('common.cancel')}
            </button>
            <button className="btn primary" disabled={!usable} onClick={() => res && usable && onApply(res.hex, photoSource(gains ? (refChoice as ReferenceMode) : null, res.spreadDE))} data-testid="measure-apply">
              {t('w6cm.apply')}
            </button>
          </div>
        </div>
      }
    >
      <div className="w6cm" data-testid="measure-dialog">
        {!photo && <p className="muted small">{t('w6cm.intro')}</p>}
        <div className="btn-row wrap">
          <button className={`btn ${photo ? '' : 'primary'}`} onClick={() => camRef.current?.click()} disabled={loading}>
            📷 {photo ? t('w6cm.other') : t('w6cm.take')}
          </button>
          <button className="btn" onClick={() => pickRef.current?.click()} disabled={loading}>
            {t('w6cm.pick')}
          </button>
          {([camRef, pickRef] as const).map((ref, i) => (
            <input
              key={i}
              ref={ref}
              type="file"
              accept="image/*"
              {...(i === 0 ? { capture: 'environment' as const } : {})}
              hidden
              data-testid={i === 0 ? 'measure-file-camera' : 'measure-file'}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void onFile(f);
              }}
            />
          ))}
          {loading && <span className="muted small">{t('w6cm.loading')}</span>}
          {photo && !loading && (
            <span className="muted small">{photo.srcW * photo.srcH > photo.w * photo.h ? t('w6cm.photoInfo', { w: photo.w, h: photo.h }) : t('w6cm.photoInfoFull', { w: photo.w, h: photo.h })}</span>
          )}
        </div>
        {error && (
          <p className="error" role="alert" data-testid="measure-error">
            {error}
          </p>
        )}

        <div className="w6cm-controls">
          <label className="w6cm-field is-ref">
            <span>{t('w6cm.refType')}</span>
            <select value={refChoice} onChange={(e) => chooseRef(e.target.value as RefChoice)} data-testid="measure-ref-type">
              <option value="paper">{t('w6cm.refType.paper')}</option>
              <option value="grey18">{t('w6cm.refType.grey18')}</option>
              <option value="none">{t('w6cm.refType.none')}</option>
            </select>
            <small className="muted">{t(`w6cm.refHint.${refChoice}`)}</small>
          </label>
          {photo && (
            <>
              <div className="w6cm-field">
                <span>{t('w6cm.tapTarget')}</span>
                <div className="seg" role="group">
                  <button className={`btn small ${target === 'ref' ? 'primary' : ''}`} disabled={refChoice === 'none'} aria-pressed={target === 'ref'} onClick={() => setTarget('ref')} data-testid="measure-target-ref">
                    {t('w6cm.target.ref')}
                  </button>
                  <button className={`btn small ${target === 'tile' ? 'primary' : ''}`} aria-pressed={target === 'tile'} onClick={() => setTarget('tile')} data-testid="measure-target-tile">
                    {t('w6cm.target.tile')}
                  </button>
                </div>
              </div>
              <label className="w6cm-field">
                <span>
                  {t('w6cm.size')} <span className="muted">{t('w6cm.sizeValue', { d: radius * 2 })}</span>
                </span>
                <input type="range" min={2} max={maxRadius} value={Math.min(radius, maxRadius)} onChange={(e) => setRadius(Number(e.target.value))} data-testid="measure-size" />
              </label>
            </>
          )}
        </div>

        {photo && (
          <div className="w6cm-main">
            <div className="w6cm-left">
              <p className="w6cm-step" data-testid="measure-step">
                <b>{target === 'ref' && refChoice !== 'none' ? t('w6cm.step.ref') : t('w6cm.step.tile')}</b> <span className="muted small">{zoom > 1 ? t('w6cm.panHint') : ''}</span>
              </p>
              {refStatus && (
                <p className={`${refStatus.cls} small`} role="status" data-testid="measure-ref-status">
                  {refStatus.text}
                </p>
              )}
              <div className="w6cm-stagewrap">
                <div className="w6cm-stage" ref={stageRef}>
                  <canvas ref={viewRef} className="w6cm-view" style={{ width: fitW ? Math.round(fitW * zoom) : '100%' }} onClick={onTap} data-testid="measure-canvas" />
                </div>
                <div className="w6cm-zoom">
                  <button className="icon-btn" onClick={() => changeZoom(zoomIdx + 1)} disabled={zoomIdx >= ZOOMS.length - 1} aria-label={t('w6cm.zoomIn')} title={t('w6cm.zoomIn')} data-testid="measure-zoom-in">
                    +
                  </button>
                  <button className="icon-btn" onClick={() => changeZoom(zoomIdx - 1)} disabled={zoomIdx === 0} aria-label={t('w6cm.zoomOut')} title={t('w6cm.zoomOut')}>
                    −
                  </button>
                  <button className="icon-btn" onClick={() => changeZoom(0)} disabled={zoomIdx === 0} aria-label={t('w6cm.zoomFit')} title={t('w6cm.zoomFit')}>
                    ⤢
                  </button>
                </div>
              </div>
              {res && usable && (
                <p className="w6cm-quick small" aria-hidden="true">
                  <Swatch hex={res.hex} size={18} /> <span className="mono">{res.hex}</span> · {t('w6cm.res.spread', { de: n(res.spreadDE, 1) })}
                  {warnings.some((w) => w !== 'no-reference') && <span className="warn"> · ⚠</span>}
                </p>
              )}
            </div>

            <section className="w6cm-result" data-testid="measure-result" aria-live="polite">
              <h4>{t('w6cm.res.title')}</h4>
              {!res ? (
                <p className="muted small">{t('w6cm.res.none')}</p>
              ) : (
                <>
                  <div className="w6cm-compare">
                    <figure>
                      <canvas ref={cropRef} width={96} height={96} className="w6cm-crop" />
                      <figcaption>{t('w6cm.res.crop')}</figcaption>
                    </figure>
                    <figure>
                      <span className="w6cm-swatch" style={{ background: usable ? res.hex : 'transparent' }} />
                      <figcaption>{t('w6cm.res.measured')}</figcaption>
                    </figure>
                    {isValidHex(currentHex) && (
                      <figure>
                        <span className="w6cm-swatch small" style={{ background: currentHex }} />
                        <figcaption>{t('w6cm.res.current')}</figcaption>
                      </figure>
                    )}
                    {usable && (
                      <div className="w6cm-values small">
                        <div className="mono" data-testid="measure-hex">
                          {res.hex}
                        </div>
                        <div className="mono">
                          Lab {n(res.lab[0], 1)} / {n(res.lab[1], 1)} / {n(res.lab[2], 1)}
                        </div>
                        {Number.isFinite(deCurrent) && <div>{t('w6cm.res.de', { de: n(deCurrent, 1) })}</div>}
                        <div data-testid="measure-spread">{t('w6cm.res.spread', { de: n(res.spreadDE, 1) })}</div>
                        <div className="muted">{t('w6cm.res.pixels', { n: n(res.n), clip: n(res.clippedFrac * 100, 0) })}</div>
                      </div>
                    )}
                  </div>
                  {warnings.length > 0 && (
                    <ul className="w6cm-warn" data-testid="measure-warnings">
                      {warnings.map((w) => (
                        <li key={w} className={w === 'empty' ? 'error' : 'warn'}>
                          {t(`w6cm.warn.${w}`, { max: SPREAD_WARN_DE, p: n(res.clippedFrac * 100, 0) })}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
              <p className="muted small w6cm-honesty">{t('w6cm.honesty')}</p>
            </section>
          </div>
        )}
        {!photo && (
          <p className="muted small">
            <Swatch hex={isValidHex(currentHex) ? currentHex : '#808080'} size={14} /> {t('w6cm.res.current')}: <span className="mono">{currentHex}</span>
          </p>
        )}
      </div>
    </Modal>
  );
}
