import { computeLayout, estimateCells } from '../../core/layout';
import { useI18n } from '../../i18n';
import { Badge, Field, NumberInput, Segmented } from '../components';
import { layoutParamsOf, type ProjectApi } from './useProject';
import { rotatedSize } from './imagePrep';

const UNIT_F = { mm: 1, cm: 10, m: 1000 } as const;

export function LayoutSummary({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const { layout, layoutError, rec } = api;
  if (layoutError) return <p className="error">{layoutError}</p>;
  if (!layout || !rec) return null;
  const cells = layout.cols * layout.rows;
  const cutCols = Array.from(layout.colW).filter((w) => Math.abs(w - layout.tileW) > 1e-9).length;
  const cutRows = Array.from(layout.rowH).filter((h) => Math.abs(h - layout.tileH) > 1e-9).length;
  const stoneArea = Array.from(layout.colW).reduce((a, b) => a + b, 0) * Array.from(layout.rowH).reduce((a, b) => a + b, 0);
  const total = layout.finishedW * layout.finishedH;
  return (
    <div className="summary-box" data-testid="layout-summary">
      <div className="stat">
        <span>{t('size.grid')}</span>
        <b>
          {n(layout.cols)} × {n(layout.rows)}
        </b>
      </div>
      <div className="stat">
        <span>{t('size.positions')}</span>
        <b data-testid="grid-positions">{n(cells)}</b>
      </div>
      <div className="stat">
        <span>{t('size.finished')}</span>
        <b data-testid="finished-size">
          {n(layout.finishedW, 2)} × {n(layout.finishedH, 2)} mm
        </b>
      </div>
      <div className="stat">
        <span>{t('size.jointShare')}</span>
        <b>{n(((total - stoneArea) / total) * 100, 1)} %</b>
      </div>
      {(cutCols > 0 || cutRows > 0) && (
        <div className="stat">
          <span>{t('size.edgeCut')}</span>
          <b>
            {cutCols} {t('size.colsShort')} / {cutRows} {t('size.rowsShort')}
          </b>
        </div>
      )}
      {(layout.restX > 1e-6 || layout.restY > 1e-6) && (
        <div className="stat warn">
          <span>{t('size.rest')}</span>
          <b>
            {n(layout.restX, 2)} × {n(layout.restY, 2)} mm
          </b>
        </div>
      )}
      <p className="muted small">{t('size.formula', { w: n(layout.tileW, 2), g: n(layout.joint, 2) })}</p>
      {cells > 2_000_000 && <Badge kind="warn">{t('size.manyCells')}</Badge>}
    </div>
  );
}

export function StepSize({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const f = UNIT_F[s.unit];
  const presets: [number, number][] = [
    [30, 40],
    [40, 40],
    [50, 70],
    [60, 90],
    [100, 100],
    [200, 100],
    [300, 200],
    [500, 300],
    [1000, 500],
  ];
  const photoAspect = api.bitmap ? (() => {
    const r = rotatedSize(api.bitmap.width, api.bitmap.height, api.rec!.adjust);
    const c = api.rec!.adjust.crop;
    return c ? (c.w * r.w) / (c.h * r.h) : r.w / r.h;
  })() : null;
  return (
    <div className="two-col">
      <div>
        <Field label={t('size.unit')}>
          <Segmented value={s.unit} options={[{ value: 'mm', label: 'mm' }, { value: 'cm', label: 'cm' }, { value: 'm', label: 'm' }]} onChange={(u) => api.setSettings({ unit: u })} />
        </Field>
        <Field label={t('size.width')}>
          <NumberInput value={s.widthMm / f} onChange={(v) => api.setSettings({ widthMm: v * f })} min={0.1} suffix={s.unit} testId="width-input" decimals={4} />
        </Field>
        <Field label={t('size.height')}>
          <NumberInput value={s.heightMm / f} onChange={(v) => api.setSettings({ heightMm: v * f })} min={0.1} suffix={s.unit} testId="height-input" decimals={4} />
        </Field>
        {photoAspect && (
          <div className="btn-row wrap">
            <button className="btn small" onClick={() => api.setSettings({ heightMm: Math.round((s.widthMm / photoAspect) * 10) / 10 })}>
              {t('size.heightFromPhoto')}
            </button>
            <button className="btn small" onClick={() => api.setSettings({ widthMm: Math.round(s.heightMm * photoAspect * 10) / 10 })}>
              {t('size.widthFromPhoto')}
            </button>
            <button className="btn small" onClick={() => api.setSettings({ widthMm: s.heightMm, heightMm: s.widthMm })}>
              ⇄ {t('size.swap')}
            </button>
          </div>
        )}
        <h4>{t('size.presets')}</h4>
        <div className="btn-row wrap">
          {presets.map(([w, h]) => (
            <button key={`${w}x${h}`} className="btn small" onClick={() => api.setSettings({ widthMm: w * 10, heightMm: h * 10 })}>
              {w} × {h} cm
            </button>
          ))}
        </div>
        <Field label={t('size.edgeMode')} hint={t(`size.edge.${s.edgeMode}.hint`)}>
          <Segmented
            value={s.edgeMode}
            options={[
              { value: 'whole', label: t('size.edge.whole') },
              { value: 'cut-end', label: t('size.edge.cut-end') },
              { value: 'cut-both', label: t('size.edge.cut-both') },
            ]}
            onChange={(v) => api.setSettings({ edgeMode: v })}
          />
        </Field>
        <Field label={t('size.minCut')}>
          <NumberInput value={s.minCutMm} onChange={(v) => api.setSettings({ minCutMm: v })} min={0.5} max={20} suffix="mm" />
        </Field>
        <p className="muted small">
          {t('size.area')}: {n((s.widthMm * s.heightMm) / 1e6, 4)} m²
        </p>
      </div>
      <div>
        <LayoutSummary api={api} />
        <p className="muted small">{t('size.originHint')}</p>
      </div>
    </div>
  );
}

export function StepTiles({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const sizes = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const custom: [number, number][] = [
    [3, 5],
    [4, 8],
    [6, 10],
    [8, 12],
  ];
  const outOfRange = s.tileW < 2 || s.tileW > 12 || s.tileH < 2 || s.tileH > 12;
  return (
    <div className="two-col">
      <div>
        <h4>{t('tiles.square')}</h4>
        <div className="btn-row wrap" data-testid="tile-presets">
          {sizes.map((v) => (
            <button key={v} className={`btn chip ${s.tileW === v && s.tileH === v ? 'primary' : ''}`} onClick={() => api.setSettings({ tileW: v, tileH: v })}>
              {v} × {v} mm
            </button>
          ))}
        </div>
        <h4>{t('tiles.rect')}</h4>
        <div className="btn-row wrap">
          {custom.map(([w, h]) => (
            <button key={`${w}x${h}`} className={`btn chip ${s.tileW === w && s.tileH === h ? 'primary' : ''}`} onClick={() => api.setSettings({ tileW: w, tileH: h })}>
              {w} × {h} mm
            </button>
          ))}
        </div>
        <h4>{t('tiles.custom')}</h4>
        <div className="btn-row">
          <NumberInput value={s.tileW} onChange={(v) => api.setSettings({ tileW: v })} min={0.5} max={100} suffix="mm" label={t('tiles.w')} testId="tile-w" />
          <span>×</span>
          <NumberInput value={s.tileH} onChange={(v) => api.setSettings({ tileH: v })} min={0.5} max={100} suffix="mm" label={t('tiles.h')} testId="tile-h" />
        </div>
        {outOfRange && <Badge kind="warn">{t('tiles.outOfRange')}</Badge>}
        <Field label={t('tiles.surface')}>
          <Segmented value={s.surface} options={[{ value: 'glass', label: t('mat.glass') }, { value: 'ceramic', label: t('mat.ceramic') }]} onChange={(v) => api.setSettings({ surface: v })} />
        </Field>
        <p className="muted small">{t('tiles.mixedHint')}</p>
        <p className="muted small">{t('tiles.materialHint')}</p>
      </div>
      <div>
        <LayoutSummary api={api} />
        <p className="muted small">
          {t('tiles.pitch')}: {n(s.tileW + s.joint, 2)} × {n(s.tileH + s.joint, 2)} mm
        </p>
      </div>
    </div>
  );
}

export function StepJoint({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const presets = [0, 0.5, 1, 1.5, 2, 3];
  // Vergleich: wie viele Steine passen ohne Fugenberücksichtigung (falsche Rechnung) vs. korrekt
  let naive: number | null = null;
  try {
    const L = computeLayout({ ...layoutParamsOf(s), edgeMode: 'whole' });
    const naiveCols = Math.floor(s.widthMm / s.tileW);
    naive = naiveCols - L.cols;
  } catch {
    naive = null;
  }
  const est = estimateCells(layoutParamsOf(s));
  return (
    <div className="two-col">
      <div>
        <h4>{t('joint.width')}</h4>
        <div className="btn-row wrap" data-testid="joint-presets">
          {presets.map((v) => (
            <button key={v} className={`btn chip ${s.joint === v ? 'primary' : ''}`} onClick={() => api.setSettings({ joint: v })}>
              {n(v, 1)} mm
            </button>
          ))}
        </div>
        <Field label={t('joint.custom')}>
          <NumberInput value={s.joint} onChange={(v) => api.setSettings({ joint: v })} min={0} max={20} suffix="mm" testId="joint-input" />
        </Field>
        <Field label={t('joint.color')}>
          <input type="color" value={s.groutHex} onChange={(e) => api.setSettings({ groutHex: e.target.value.toUpperCase() })} /> <span className="muted">{s.groutHex}</span>
        </Field>
        <Field label={t('joint.depth')} hint={t('joint.depthHint')}>
          <NumberInput value={s.groutDepthMm} onChange={(v) => api.setSettings({ groutDepthMm: v })} min={0} max={30} suffix="mm" />
        </Field>
        {naive !== null && naive > 0 && <p className="muted small">{t('joint.naive', { n: naive })}</p>}
        <p className="muted small">{t('joint.estimate', { c: n(est.cols), r: n(est.rows) })}</p>
      </div>
      <div>
        <LayoutSummary api={api} />
      </div>
    </div>
  );
}
