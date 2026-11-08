import { useEffect, useMemo, useRef, useState } from 'react';
import { applyAdjustments } from '../../core/imageOps';
import { DEFAULT_ADJUST } from '../../core/types';
import { tCount, useI18n } from '../../i18n';
import { Field, Modal, Slider, Toggle } from '../components';
import { CropEditor } from './CropEditor';
import { canvasToRaw, loadWorkingBitmap, photoErrorKey, rawToCanvas, renderCropped, renderRotated, rotatedSize, type WorkingBitmap } from './imagePrep';
import type { ProjectApi } from './useProject';
import '../css/w2-photo-intake.css';

export function PhotoInput({ onFile, label, testId, primary = true, disabled }: { onFile: (f: File) => void; label: string; testId?: string; primary?: boolean; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        hidden
        data-testid={testId}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
      <button className={primary ? 'btn primary' : 'btn'} onClick={() => ref.current?.click()} disabled={disabled} data-testid={testId ? `${testId}-btn` : undefined}>
        {label}
      </button>
    </>
  );
}

/** Hinweis „Porträt? Gesicht markieren“ ausgeblendet? (localStorage kann fehlen/gesperrt sein) */
const TIP_KEY = 'mosaicplan.tip.portraitFace';
function tipDismissed(): boolean {
  try {
    return localStorage.getItem(TIP_KEY) === '1';
  } catch {
    return false;
  }
}
function dismissTip() {
  try {
    localStorage.setItem(TIP_KEY, '1');
  } catch {
    /* nur für diese Sitzung ausgeblendet */
  }
}

/** Gelesenes neues Foto, für das der Benutzer noch wählen muss (neues Projekt / ersetzen / abbrechen) */
interface PendingPhoto {
  file: File;
  wb: WorkingBitmap;
}

export function StepPhoto({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const { rec, bitmap, layout, effectiveCrop, sourceSize } = api;
  const [drag, setDrag] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPhoto | null>(null);
  const [keepRegions, setKeepRegions] = useState(false);
  const [creating, setCreating] = useState(false);
  const [keptRegionsNote, setKeptRegionsNote] = useState(false);
  const [tipHidden, setTipHidden] = useState(tipDismissed);
  const adj = rec!.adjust;

  const rotated = useMemo(() => (bitmap ? renderRotated(bitmap, { ...adj }, 900) : null), [bitmap, adj.rotation, adj.fineRotate, adj.flipH]); // eslint-disable-line react-hooks/exhaustive-deps

  // Vorschau der Bildoptimierung (klein, im Hauptthread)
  const [after, setAfter] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!bitmap || !effectiveCrop || !layout) return;
    const id = window.setTimeout(() => {
      const aspect = layout.finishedW / layout.finishedH;
      const tw = aspect >= 1 ? 520 : Math.round(520 * aspect);
      const th = Math.round(tw / aspect);
      const c = renderCropped(bitmap, adj, effectiveCrop, tw, th);
      const out = applyAdjustments(canvasToRaw(c), adj, rec!.regions);
      setAfter(rawToCanvas(out));
    }, 180);
    return () => window.clearTimeout(id);
  }, [bitmap, adj, effectiveCrop, layout, rec]);

  const afterRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = afterRef.current;
    if (!h || !after) return;
    h.innerHTML = '';
    after.style.width = 'auto';
    after.style.height = 'auto';
    after.style.maxWidth = '100%';
    after.style.maxHeight = '520px';
    after.style.display = 'block';
    after.dataset.testid = 'adjusted-preview';
    h.appendChild(after);
  }, [after]);

  // Ein gelesenes, aber nicht übernommenes Foto beim Verlassen freigeben
  const pendingRef = useRef<PendingPhoto | null>(null);
  pendingRef.current = pending;
  useEffect(
    () => () => {
      pendingRef.current?.wb.bitmap.close();
      pendingRef.current = null;
    },
    [],
  );

  const r = rec!;
  const faceRegions = r.regions.filter((g) => g.type === 'face').length;
  const placed = api.progress?.total.placed ?? 0;
  /** Gehört schon etwas zum bisherigen Foto (Berechnung oder Bereiche)? Dann vor dem Ersetzen fragen. */
  const needsChoice = !!r.computedWith || !!api.computed || r.regions.length > 0;

  const replaceHere = async (file: File, wb: WorkingBitmap, clearRegions: boolean) => {
    setLoading(true);
    try {
      const { saved } = await api.setPhoto(file, file.name, { prepared: wb, clearRegions });
      setKeptRegionsNote(!clearRegions && r.regions.length > 0);
      if (!saved) setErr(t('photo.err.save'));
    } catch (e) {
      setErr(t(photoErrorKey(file, e)));
    } finally {
      setLoading(false);
    }
  };

  const onFile = async (f: File) => {
    if (loading || creating) return;
    setErr(null);
    setLoading(true);
    let wb: WorkingBitmap;
    try {
      // erst lesen, dann entscheiden: ein unlesbares Foto ändert nichts am Projekt
      wb = await loadWorkingBitmap(f);
    } catch (e) {
      console.warn('Foto konnte nicht gelesen werden', e);
      setErr(t(photoErrorKey(f, e)));
      setLoading(false);
      return;
    }
    if (needsChoice) {
      setKeepRegions(false);
      setPending({ file: f, wb });
      setLoading(false);
      return;
    }
    await replaceHere(f, wb, false);
  };

  const cancelPending = () => {
    pending?.wb.bitmap.close();
    setPending(null);
  };

  const chooseReplace = () => {
    if (!pending) return;
    const p = pending;
    setPending(null);
    void replaceHere(p.file, p.wb, !keepRegions);
  };

  const chooseNewProject = async () => {
    if (!pending || creating) return;
    const p = pending;
    setCreating(true);
    try {
      const nid = await api.createProjectFromPhoto(p.file, p.file.name, { w: p.wb.srcW, h: p.wb.srcH }, t('home.newProjectName'));
      p.wb.bitmap.close();
      pendingRef.current = null;
      // Navigation mit offenem Dialog: der Arbeitsbereich wird neu aufgebaut, das alte Projekt speichert beim Verlassen
      location.hash = `#/project/${nid}/photo`;
      window.scrollTo(0, 0);
    } catch (e) {
      p.wb.bitmap.close();
      setPending(null);
      setErr(t(photoErrorKey(p.file, e)));
    } finally {
      setCreating(false);
    }
  };

  const errorBox = err && (
    <p className="error w2pi-error" role="alert" data-testid="photo-error">
      {err}
    </p>
  );
  const loadingBox = loading && (
    <p className="muted small w2pi-loading" role="status" data-testid="photo-loading">
      <span className="w2pi-spinner" aria-hidden="true" /> {t('photo.loading')}
    </p>
  );

  const dialog = pending && (
    <Modal title={t('photo.replace.title')} onClose={cancelPending}>
      <div className="w2pi-replace" data-testid="replace-dialog">
        <p>
          {t('photo.replace.newPhoto', { name: pending.file.name || '–', w: n(pending.wb.srcW), h: n(pending.wb.srcH) })}
        </p>
        <p className="small">{t('photo.replace.intro')}</p>
        <ul className="small w2pi-facts">
          {(r.computedWith || api.computed) && <li>{t('photo.replace.factComputed')}</li>}
          {placed > 0 && <li>{tCount(t, 'photo.replace.factPlaced', placed, { n: n(placed) })}</li>}
          {r.regions.length > 0 && <li>{tCount(t, 'photo.replace.factRegions', r.regions.length, { n: r.regions.length })}</li>}
        </ul>
        <div className="w2pi-choice w2pi-recommended">
          <button className="btn primary" onClick={() => void chooseNewProject()} disabled={creating} data-testid="replace-new-project">
            {t('photo.replace.new')}
          </button>
          <p className="small muted">{t('photo.replace.newHint')}</p>
        </div>
        <div className="w2pi-choice">
          <button className="btn" onClick={chooseReplace} disabled={creating} data-testid="replace-in-project">
            {t('photo.replace.here')}
          </button>
          <p className="small muted">
            {t(r.computedWith || api.computed ? 'photo.replace.hereHintComputed' : 'photo.replace.hereHint')}
            {placed > 0 && ` ${tCount(t, 'photo.replace.hereHintPlaced', placed, { n: n(placed) })}`}
          </p>
          {r.regions.length > 0 && (
            <label className="inline w2pi-keep">
              <input type="checkbox" checked={keepRegions} onChange={(e) => setKeepRegions(e.target.checked)} data-testid="replace-keep-regions" />
              <span>{tCount(t, 'photo.replace.keepRegions', r.regions.length, { n: r.regions.length })}</span>
            </label>
          )}
        </div>
        <div className="btn-row">
          <button className="btn" onClick={cancelPending} disabled={creating} data-testid="replace-cancel">
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </Modal>
  );

  if (!bitmap) {
    return (
      <>
        <div
          className={`dropzone ${drag ? 'drag' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files[0];
            if (f) void onFile(f);
          }}
        >
          <div className="dropzone-icon">🖼️</div>
          {api.imageError === 'unreadable' && (
            <p className="error" role="alert" data-testid="photo-unreadable">
              {t('photo.err.stored')}
            </p>
          )}
          <p>{t('photo.drop')}</p>
          <PhotoInput onFile={(f) => void onFile(f)} label={t('photo.choose')} testId="photo-input" disabled={loading} />
          {loadingBox}
          {errorBox}
          <p className="muted small">{t('photo.local')}</p>
          <p className="muted small">{t('photo.formats')}</p>
        </div>
        {dialog}
      </>
    );
  }

  const aspect = layout ? layout.finishedW / layout.finishedH : 1;
  const sw = sourceSize?.w ?? bitmap.width;
  const sh = sourceSize?.h ?? bitmap.height;
  const rot = rotatedSize(sw, sh, adj);
  const reduced = !!sourceSize?.reduced;
  const imageStale = !!api.computed && !!r.computedImageRev && r.imageRev !== r.computedImageRev;

  return (
    <div className="two-col">
      <div>
        <h3>{t('photo.crop')}</h3>
        {rotated && effectiveCrop && (
          <CropEditor
            source={rotated}
            crop={effectiveCrop}
            aspect={aspect}
            srcW={rot.w}
            srcH={rot.h}
            grid={layout ? { cols: layout.cols, rows: layout.rows } : null}
            onChange={(c) => api.setAdjust({ crop: c })}
            maxHeight={520}
          />
        )}
        <p className="muted small">{t('photo.cropHint')}</p>
        <p className="small" data-testid="photo-size" data-src-w={sw} data-src-h={sh} data-work-w={bitmap.width} data-work-h={bitmap.height} data-reduced={reduced ? '1' : '0'}>
          {reduced
            ? t('photo.sizeReduced', { w: n(sw), h: n(sh), ww: n(bitmap.width), wh: n(bitmap.height) })
            : t('photo.sizeFull', { w: n(sw), h: n(sh) })}
          {api.image?.name ? ` · ${api.image.name}` : ''}
        </p>
        {imageStale && (
          <p className="warn small" role="status" data-testid="photo-stale">
            {t('photo.staleMosaic')}
          </p>
        )}
        {keptRegionsNote && r.regions.length > 0 && (
          <p className="warn small" role="status" data-testid="photo-regions-kept">
            {t('photo.regionsKept')}
          </p>
        )}
        <div className="btn-row wrap">
          <button className="btn" onClick={() => api.setAdjust({ rotation: (((adj.rotation + 270) % 360) as 0), crop: null })}>
            ⟲ {t('photo.rotateLeft')}
          </button>
          <button className="btn" onClick={() => api.setAdjust({ rotation: (((adj.rotation + 90) % 360) as 0), crop: null })}>
            ⟳ {t('photo.rotateRight')}
          </button>
          <button className="btn" onClick={() => api.setAdjust({ flipH: !adj.flipH })}>
            ⇋ {t('photo.flip')}
          </button>
          <button className="btn" onClick={() => api.setAdjust({ crop: null })}>
            {t('photo.resetCrop')}
          </button>
          <PhotoInput onFile={(f) => void onFile(f)} label={t('photo.replace')} testId="photo-replace" primary={false} disabled={loading || creating} />
        </div>
        {loadingBox}
        {errorBox}
        {!tipHidden && faceRegions === 0 && (
          <div className="w2pi-tip" role="note" data-testid="portrait-tip">
            <span>{t('photo.portraitTip')}</span>
            <button
              className="icon-btn"
              onClick={() => {
                dismissTip();
                setTipHidden(true);
              }}
              aria-label={t('photo.portraitTipHide')}
              title={t('photo.portraitTipHide')}
              data-testid="portrait-tip-dismiss"
            >
              ✕
            </button>
          </div>
        )}
        <Slider label={t('photo.fineRotate')} value={adj.fineRotate} min={-15} max={15} step={0.5} onChange={(v) => api.setAdjust({ fineRotate: v })} format={(v) => `${v}°`} />
      </div>
      <div>
        <h3>{t('photo.optimize')}</h3>
        <div className="after-preview" ref={afterRef} />
        <Slider label={t('photo.brightness')} value={adj.brightness} min={-100} max={100} onChange={(v) => api.setAdjust({ brightness: v })} />
        <Slider label={t('photo.contrast')} value={adj.contrast} min={-100} max={100} onChange={(v) => api.setAdjust({ contrast: v })} />
        <Slider label={t('photo.saturation')} value={adj.saturation} min={-100} max={100} onChange={(v) => api.setAdjust({ saturation: v })} />
        <Slider label={t('photo.sharpen')} value={adj.sharpen} min={0} max={100} onChange={(v) => api.setAdjust({ sharpen: v })} />
        <Slider label={t('photo.detail')} value={adj.detailBoost} min={0} max={100} onChange={(v) => api.setAdjust({ detailBoost: v })} />
        <Slider label={t('photo.bg')} value={adj.bgSimplify} min={0} max={100} onChange={(v) => api.setAdjust({ bgSimplify: v })} />
        <Field label="" hint={t('photo.bgHint')}>
          <span />
        </Field>
        <Toggle checked={adj.autoLevels} onChange={(v) => api.setAdjust({ autoLevels: v })} label={t('photo.autoLevels')} />
        <Toggle checked={adj.whiteBalance} onChange={(v) => api.setAdjust({ whiteBalance: v })} label={t('photo.whiteBalance')} />
        <button className="btn" onClick={() => api.setAdjust({ ...DEFAULT_ADJUST, rotation: adj.rotation, fineRotate: adj.fineRotate, flipH: adj.flipH, crop: adj.crop })}>
          {t('photo.resetAdjust')}
        </button>
      </div>
      {dialog}
    </div>
  );
}
