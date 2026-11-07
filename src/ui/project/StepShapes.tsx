import { useEffect, useMemo, useRef, useState } from 'react';
import type { Region } from '../../core/types';
import { useI18n } from '../../i18n';
import { Badge, Field, NumberInput, Segmented, Slider, Toggle } from '../components';
import { detectFaces, renderCropped } from './imagePrep';
import type { ProjectApi } from './useProject';
import { uid } from '../../storage/db';

export function StepShapes({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const sh = s.shapes;
  const set = (patch: Partial<typeof sh>) => api.setSettings({ shapes: { ...sh, ...patch } });
  const k = sh.subdivK;
  const subSize = (s.tileW - (k - 1) * s.joint) / k;
  const subSizeH = (s.tileH - (k - 1) * s.joint) / k;
  return (
    <div className="two-col">
      <div>
        <p className="muted small">{t('shapes.intro')}</p>
        <Toggle checked={sh.diagonal} onChange={(v) => set({ diagonal: v })} label={t('shapes.diagonal')} hint={t('shapes.diagonalHint')} />
        <Toggle checked={sh.line} onChange={(v) => set({ line: v })} label={t('shapes.line')} hint={t('shapes.lineHint')} />
        <Toggle checked={sh.subdivide} onChange={(v) => set({ subdivide: v })} label={t('shapes.subdivide')} hint={t('shapes.subdivideHint')} />
        {sh.subdivide && (
          <Field label={t('shapes.subK')} hint={t('shapes.subSize', { w: n(subSize, 2), h: n(subSizeH, 2) })}>
            <Segmented value={sh.subdivK} options={[{ value: 2, label: '2 × 2' }, { value: 3, label: '3 × 3' }]} onChange={(v) => set({ subdivK: v })} />
          </Field>
        )}
        {sh.subdivide && Math.min(subSize, subSizeH) < sh.minPieceMm && <Badge kind="warn">{t('shapes.subTooSmall')}</Badge>}
        <Slider label={t('shapes.detail')} value={Math.round(sh.detailLevel * 100)} min={0} max={100} onChange={(v) => set({ detailLevel: v / 100 })} format={(v) => `${v} %`} />
        <Toggle checked={sh.autoDetail} onChange={(v) => set({ autoDetail: v })} label={t('shapes.autoDetail')} hint={t('shapes.autoDetailHint')} />
        <Toggle checked={sh.skinProtect} onChange={(v) => set({ skinProtect: v })} label={t('shapes.skin')} hint={t('shapes.skinHint')} />
        <Field label={t('shapes.minPiece')}>
          <NumberInput value={sh.minPieceMm} onChange={(v) => set({ minPieceMm: v })} min={0.5} max={10} suffix="mm" />
        </Field>
        <div className="note">
          <b>{t('shapes.typesTitle')}</b>
          <ul className="small">
            <li>{t('shapes.types.computed')}</li>
            <li>{t('shapes.types.recommend')}</li>
            <li>{t('shapes.types.free')}</li>
            <li>
              <Badge kind="incomplete">{t('common.incomplete')}</Badge> {t('shapes.types.rhombus')}
            </li>
          </ul>
        </div>
      </div>
      <div>
        <RegionEditor api={api} />
      </div>
    </div>
  );
}

function RegionEditor({ api }: { api: ProjectApi }) {
  const { t } = useI18n();
  const { bitmap, effectiveCrop, layout } = api;
  const regions = api.rec!.regions;
  const [mode, setMode] = useState<Region['type']>('face');
  const [shape, setShape] = useState<Region['shape']>('ellipse');
  const [draft, setDraft] = useState<Region | null>(null);
  const [faceMsg, setFaceMsg] = useState<string | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const img = useMemo(() => {
    if (!bitmap || !effectiveCrop || !layout) return null;
    const aspect = layout.finishedW / layout.finishedH;
    const tw = aspect >= 1 ? 640 : Math.round(640 * aspect);
    return renderCropped(bitmap, api.rec!.adjust, effectiveCrop, tw, Math.round(tw / aspect));
  }, [bitmap, effectiveCrop, layout, api.rec]);
  useEffect(() => {
    const h = holder.current;
    if (!h || !img) return;
    h.querySelector('canvas')?.remove();
    img.style.width = '100%';
    img.style.display = 'block';
    h.prepend(img);
  }, [img]);
  if (!img) return <p className="muted">{t('shapes.noPhoto')}</p>;

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x0 = (e.clientX - r.left) / r.width;
    const y0 = (e.clientY - r.top) / r.height;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let cur: Region = { id: uid(), type: mode, shape, x: x0, y: y0, w: 0, h: 0 };
    const move = (ev: PointerEvent) => {
      const x1 = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const y1 = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      cur = { ...cur, x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      setDraft(cur);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      setDraft(null);
      if (cur.w > 0.01 && cur.h > 0.01) api.setRegions([...api.rec!.regions, cur]);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const all = draft ? [...regions, draft] : regions;
  return (
    <div>
      <h3>{t('shapes.regions')}</h3>
      <p className="muted small">{t('shapes.regionsHint')}</p>
      <div className="btn-row wrap">
        <Segmented value={mode} options={[{ value: 'face', label: t('shapes.region.face') }, { value: 'detail', label: t('shapes.region.detail') }]} onChange={setMode} />
        <Segmented value={shape} options={[{ value: 'ellipse', label: '◯' }, { value: 'rect', label: '▭' }]} onChange={setShape} />
        <button
          className="btn small"
          onClick={async () => {
            const faces = await detectFaces(img);
            if (faces === null) setFaceMsg(t('shapes.faceUnsupported'));
            else if (faces.length === 0) setFaceMsg(t('shapes.faceNone'));
            else {
              setFaceMsg(t('shapes.faceFound', { n: faces.length }));
              api.setRegions([
                ...regions,
                ...faces.map((f) => ({ id: uid(), type: 'face' as const, shape: 'ellipse' as const, x: Math.max(0, f.x - f.w * 0.15), y: Math.max(0, f.y - f.h * 0.25), w: Math.min(1, f.w * 1.3), h: Math.min(1, f.h * 1.45) })),
              ]);
            }
          }}
        >
          {t('shapes.detectFaces')}
        </button>
      </div>
      {faceMsg && <p className="muted small">{faceMsg}</p>}
      <div className="region-holder" ref={holder} onPointerDown={onDown}>
        {all.map((r) => (
          <div
            key={r.id}
            className={`region region-${r.type} ${r.shape}`}
            style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
          />
        ))}
      </div>
      <ul className="region-list">
        {regions.map((r, i) => (
          <li key={r.id}>
            {i + 1}. {t(`shapes.region.${r.type}`)} ({r.shape === 'ellipse' ? '◯' : '▭'})
            <button className="icon-btn" onClick={() => api.setRegions(regions.filter((x) => x.id !== r.id))} aria-label={t('common.remove')}>
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
