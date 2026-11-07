import { useEffect, useMemo, useRef, useState } from 'react';
import { applyAdjustments } from '../../core/imageOps';
import { DEFAULT_ADJUST } from '../../core/types';
import { useI18n } from '../../i18n';
import { Field, Slider, Toggle } from '../components';
import { CropEditor } from './CropEditor';
import { canvasToRaw, rawToCanvas, renderCropped, renderRotated } from './imagePrep';
import type { ProjectApi } from './useProject';

export function PhotoInput({ onFile, label, testId }: { onFile: (f: File) => void; label: string; testId?: string }) {
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
      <button className="btn primary" onClick={() => ref.current?.click()}>
        {label}
      </button>
    </>
  );
}

export function StepPhoto({ api }: { api: ProjectApi }) {
  const { t } = useI18n();
  const { rec, bitmap, layout, effectiveCrop } = api;
  const [drag, setDrag] = useState(false);
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

  const onFile = (f: File) => void api.setPhoto(f, f.name);

  if (!bitmap) {
    return (
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
          if (f) onFile(f);
        }}
      >
        <div className="dropzone-icon">🖼️</div>
        <p>{t('photo.drop')}</p>
        <PhotoInput onFile={onFile} label={t('photo.choose')} testId="photo-input" />
        <p className="muted small">{t('photo.local')}</p>
      </div>
    );
  }

  const aspect = layout ? layout.finishedW / layout.finishedH : 1;

  return (
    <div className="two-col">
      <div>
        <h3>{t('photo.crop')}</h3>
        {rotated && effectiveCrop && <CropEditor source={rotated} crop={effectiveCrop} aspect={aspect} onChange={(c) => api.setAdjust({ crop: c })} maxHeight={520} />}
        <p className="muted small">
          {t('photo.cropHint')} · {bitmap.width} × {bitmap.height} px · {api.image?.name}
        </p>
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
          <PhotoInput onFile={onFile} label={t('photo.replace')} />
        </div>
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
    </div>
  );
}
