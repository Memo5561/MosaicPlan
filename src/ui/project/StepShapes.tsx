import { useMemo } from 'react';
import { anyLineSplitCuttable, diagA, diagB, maxAllowedMinWidth, pieceCuttable, subdivisionCuttable, worstWidth } from '../../core/pieces';
import { BG_CUT_FACTOR_FOCUS, BG_CUT_FACTOR_MAX, bgCutFactorOf, withShapeOption } from '../../core/types';
import { useI18n } from '../../i18n';
import { Badge, Field, NumberInput, Segmented, Slider, Toggle } from '../components';
import { widthFailText } from './StoneDialog';
import { RegionEditor } from './RegionEditor';
import type { ProjectApi } from './useProject';
import '../css/w1-cut-correctness.css';
import '../css/w4-cut-placement-accents.css';

export function StepShapes({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const sh = s.shapes;
  const set = (patch: Partial<typeof sh>) => api.setSettings({ shapes: withShapeOption(sh, patch) });
  const regions = api.rec!.regions;
  const hasRegions = regions.length > 0;
  const hasFace = regions.some((r) => r.type === 'face');
  const bg = bgCutFactorOf(sh);
  const bgText = (f: number) => (f <= 1 ? t('w4cpa.bg.value1') : t(f >= BG_CUT_FACTOR_MAX ? 'w4cpa.bg.valueMax' : 'w4cpa.bg.value', { f: n(f, 1) }));
  const k = sh.subdivK;
  const subSize = (s.tileW - (k - 1) * s.joint) / k;
  const subSizeH = (s.tileH - (k - 1) * s.joint) / k;
  // Dieselbe Prüfung wie in der Berechnung (pieceCuttable auf den exakten Teilen eines ganzen Rastersteins)
  const tile = { x: 0, y: 0, w: s.tileW, h: s.tileH };
  const subOk = subdivisionCuttable(tile, k, s.joint, sh.minPieceMm);
  const diagPieces = [...diagA(tile, s.joint), ...diagB(tile, s.joint)];
  // gemessene Werte des schmalsten Dreiecks (Inkreismaß ist bei Dreiecken die strengere Bedingung)
  const diagWidth = worstWidth(diagPieces, sh.minPieceMm);
  const diagOk = diagPieces.every((p) => pieceCuttable(p, sh.minPieceMm));
  const diagMax = diagOk ? 0 : maxAllowedMinWidth(diagPieces);
  const lineOk = useMemo(() => anyLineSplitCuttable(tile, s.joint, sh.minPieceMm), [s.tileW, s.tileH, s.joint, sh.minPieceMm]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="two-col">
      <div>
        <p className="muted small">{t('shapes.intro')}</p>
        <Toggle checked={sh.diagonal} onChange={(v) => set({ diagonal: v })} label={t('shapes.diagonal')} hint={t('shapes.diagonalHint')} />
        {sh.diagonal && !diagOk && (
          <div className="shape-note" data-testid="diag-too-small">
            <Badge kind="warn">
              {t('shapes.diagTooSmall', { w: n(s.tileW, 1), h: n(s.tileH, 1), g: n(s.joint, 1), min: n(sh.minPieceMm, 2), why: widthFailText(diagWidth, sh.minPieceMm, t, n) })}
              {diagMax > 0 && ` ${t('shapes.diagMaxMin', { max: n(diagMax, 1) })}`}
            </Badge>
          </div>
        )}
        <Toggle checked={sh.line} onChange={(v) => set({ line: v })} label={t('shapes.line')} hint={t('shapes.lineHint')} />
        {sh.line && !lineOk && (
          <div className="shape-note" data-testid="line-too-small">
            <Badge kind="warn">{t('shapes.lineTooSmall', { w: n(s.tileW, 1), h: n(s.tileH, 1), g: n(s.joint, 1), min: n(sh.minPieceMm, 2) })}</Badge>
          </div>
        )}
        <Toggle
          checked={sh.line && sh.contourContinuity === true}
          disabled={!sh.line}
          onChange={(v) => set({ contourContinuity: v })}
          label={t('w4cpa.cc.label')}
          hint={sh.line ? t('w4cpa.cc.hint') : t('w4cpa.cc.needsLine')}
          testId="contour-continuity"
        />
        <Toggle checked={sh.subdivide} onChange={(v) => set({ subdivide: v })} label={t('shapes.subdivide')} hint={t('shapes.subdivideHint')} />
        {sh.subdivide && (
          <Field label={t('shapes.subK')} hint={t('shapes.subSize', { w: n(subSize, 2), h: n(subSizeH, 2) })}>
            <Segmented value={sh.subdivK} options={[{ value: 2, label: '2 × 2' }, { value: 3, label: '3 × 3' }]} onChange={(v) => set({ subdivK: v })} />
          </Field>
        )}
        {sh.subdivide && !subOk && (
          <div className="shape-note" data-testid="sub-too-small">
            <Badge kind="warn">{t('shapes.subTooSmallW', { w: n(Math.max(0, subSize), 2), h: n(Math.max(0, subSizeH), 2), min: n(sh.minPieceMm, 1) })}</Badge>
          </div>
        )}
        <Slider label={t('shapes.detail')} value={Math.round(sh.detailLevel * 100)} min={0} max={100} onChange={(v) => set({ detailLevel: v / 100 })} format={(v) => `${v} %`} />
        <Toggle checked={sh.autoDetail} onChange={(v) => set({ autoDetail: v })} label={t('shapes.autoDetail')} hint={t('shapes.autoDetailHint')} />
        <Toggle checked={sh.skinProtect} onChange={(v) => set({ skinProtect: v })} label={t('shapes.skin')} hint={t('shapes.skinHint')} />
        <section className="w4cpa-cuts" data-testid="cut-focus">
          <h4>{t('w4cpa.bg.title')}</h4>
          {hasRegions ? (
            <>
              <Slider
                label={t('w4cpa.bg.label')}
                value={Math.round(bg * 2)}
                min={2}
                max={BG_CUT_FACTOR_MAX * 2}
                onChange={(v) => set({ bgCutFactor: v / 2 })}
                format={(v) => bgText(v / 2)}
              />
              <div className="w4cpa-ends" aria-hidden="true">
                <span>{t('w4cpa.bg.many')}</span>
                <span>{t('w4cpa.bg.few')}</span>
              </div>
              <div className="w4cpa-preset-row">
                {bg === BG_CUT_FACTOR_FOCUS ? (
                  <span className="w4cpa-ok small" data-testid="cut-focus-active">
                    {t('w4cpa.bg.presetActive', { f: n(bg, 1) })}
                  </span>
                ) : (
                  <button className="btn small" onClick={() => set({ bgCutFactor: BG_CUT_FACTOR_FOCUS })} data-testid="cut-focus-preset">
                    {t(hasFace ? 'w4cpa.bg.preset' : 'w4cpa.bg.presetRegions')}
                  </button>
                )}
                {bg > 1 && (
                  <button className="btn small" onClick={() => set({ bgCutFactor: undefined })} data-testid="cut-focus-reset">
                    {t('w4cpa.bg.reset')}
                  </button>
                )}
              </div>
              <p className="muted small w4cpa-hint">{t('w4cpa.bg.hint')}</p>
              <p className="small w4cpa-hint" data-testid="cut-focus-hair">
                {t('w4cpa.bg.hairHint')}
              </p>
            </>
          ) : (
            <>
              <p className="muted small w4cpa-hint" data-testid="cut-focus-no-regions">
                {t('w4cpa.bg.noRegions')}
              </p>
              {bg > 1 && (
                <p className="warn small w4cpa-hint" data-testid="cut-focus-inactive">
                  {t('w4cpa.bg.inactive', { f: n(bg, 1) })}
                </p>
              )}
            </>
          )}
        </section>
        <Field label={t('shapes.minPiece')} hint={t('shapes.minPieceHint')}>
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
