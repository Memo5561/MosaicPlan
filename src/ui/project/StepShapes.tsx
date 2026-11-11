import { useEffect, useMemo, useState } from 'react';
import { anyLineSplitCuttable, diagA, diagB, maxAllowedMinWidth, pieceCuttable, subdivisionCuttable, worstWidth } from '../../core/pieces';
import { BG_CUT_FACTOR_FOCUS, BG_CUT_FACTOR_MAX, bgCutFactorOf, FINE_K_OPTIONS, fineTileSize, materialHasSize, withShapeOption, type Material } from '../../core/types';
import { tCount, useI18n } from '../../i18n';
import { listMaterials } from '../../storage/db';
import { Badge, Field, NumberInput, Slider, Toggle } from '../components';
import { widthFailText } from './StoneDialog';
import { RegionEditor } from './RegionEditor';
import type { ProjectApi } from './useProject';
import '../css/w1-cut-correctness.css';
import '../css/w4-cut-placement-accents.css';
import '../css/w6-fine-tiles.css';

/** Materialdatenbank (nur lesend, für „n Materialien in dieser Größe“); null solange nicht geladen. */
function useMaterialList(): Material[] | null {
  const [mats, setMats] = useState<Material[] | null>(null);
  useEffect(() => {
    let alive = true;
    listMaterials().then(
      (m) => alive && setMats(m),
      () => alive && setMats(null),
    );
    return () => {
      alive = false;
    };
  }, []);
  return mats;
}

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
  // ---- Feinsteine (w6-fine-tiles)
  const mats = useMaterialList();
  const fineNow = fineTileSize(s.tileW, s.tileH, s.joint, k);
  const fineStale = sh.fineTileMm !== undefined && fineNow.mm !== sh.fineTileMm;
  const fineRegions = regions.filter((r) => r.type === 'fine');
  const fineDiag = api.computed ? api.rec!.diagnostics?.fineRegions : undefined;
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
          <div className="field w6ft-field">
            <div className="field-label" id="w6ft-size-label">
              {t('w6ft.size.label')}
            </div>
            {/* Feinstein-Größe statt k: je Teilung das exakte Teilsteinmaß und ob es als Feinstein kaufbar ist */}
            <div className="w6ft-sizes" role="radiogroup" aria-labelledby="w6ft-size-label" data-testid="fine-size">
              {FINE_K_OPTIONS.map((kk) => {
                const fs = fineTileSize(s.tileW, s.tileH, s.joint, kk);
                const ok = subdivisionCuttable(tile, kk, s.joint, sh.minPieceMm);
                const nMat = mats ? mats.filter((m) => materialHasSize(m, fs.w, fs.h)).length : null;
                const status = !ok
                  ? t('w6ft.size.tooSmall')
                  : !fs.exact
                    ? t('w6ft.size.notExact')
                    : nMat === null
                      ? t('w6ft.size.exact')
                      : nMat > 0
                        ? tCount(t, 'w6ft.size.exactMats', nMat, { n: n(nMat) })
                        : t('w6ft.size.exactNoMat');
                const kind = !ok ? 'bad' : fs.exact && (nMat ?? 0) > 0 ? 'good' : 'cut';
                const on = sh.subdivK === kk;
                return (
                  <button
                    key={kk}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={`w6ft-size w6ft-${kind} ${on ? 'on' : ''}`}
                    onClick={() => set({ subdivK: kk, fineTileMm: fs.exact ? fs.mm : undefined })}
                    data-testid={`fine-size-k${kk}`}
                    data-exact={fs.exact ? '1' : '0'}
                    data-materials={nMat ?? ''}
                  >
                    <span className="w6ft-size-dims">{t('w6ft.size.dims', { w: n(Math.max(0, fs.w), 2), h: n(Math.max(0, fs.h), 2) })}</span>
                    <span className="w6ft-size-split">{t('w6ft.size.split', { k: kk })}</span>
                    <span className="w6ft-size-status">{status}</span>
                  </button>
                );
              })}
            </div>
            <div className="field-hint">{t('w6ft.size.hint')}</div>
            {fineStale && (
              <p className="warn small" data-testid="fine-size-stale">
                {t('w6ft.size.stale', { mm: n(sh.fineTileMm ?? 0, 2), w: n(s.tileW, 1), g: n(s.joint, 1) })}
              </p>
            )}
          </div>
        )}
        {sh.subdivide && !subOk && (
          <div className="shape-note" data-testid="sub-too-small">
            <Badge kind="warn">{t('shapes.subTooSmallW', { w: n(Math.max(0, subSize), 2), h: n(Math.max(0, subSizeH), 2), min: n(sh.minPieceMm, 1) })}</Badge>
          </div>
        )}
        <Toggle
          checked={sh.subdivide && sh.preferSubInRegions === true}
          disabled={!sh.subdivide}
          onChange={(v) => set({ preferSubInRegions: v })}
          label={t('w6ft.prefer.label')}
          hint={sh.subdivide ? t('w6ft.prefer.hint') : t('w6ft.prefer.needsSub')}
          testId="prefer-sub"
        />
        <section className="w6ft-regions" data-testid="fine-regions">
          <h4>
            <span className="w6ft-key" aria-hidden="true" /> {t('w6ft.region.title')}
          </h4>
          <p className="small w6ft-hint">{t('w6ft.region.hint', { k, w: n(Math.max(0, subSize), 2), h: n(Math.max(0, subSizeH), 2) })}</p>
          <p className="small muted w6ft-hint" data-testid="fine-regions-count">
            {fineRegions.length ? tCount(t, 'w6ft.region.count', fineRegions.length, { n: fineRegions.length }) : t('w6ft.region.none')}
          </p>
          {fineRegions.length > 0 && !sh.subdivide && (
            <p className="warn small w6ft-hint" data-testid="fine-regions-suboff">
              {t('w6ft.region.subOff')}
            </p>
          )}
          {fineRegions.length > 0 && sh.subdivide && !subOk && (
            <p className="warn small w6ft-hint" data-testid="fine-regions-toosmall">
              {t('w6ft.region.tooSmall', { w: n(Math.max(0, subSize), 2), h: n(Math.max(0, subSizeH), 2) })}
            </p>
          )}
          {fineDiag && (
            <p className="small w6ft-hint w6ft-result" data-testid="fine-regions-result" data-cells={fineDiag.cells} data-sub={fineDiag.sub} data-toosmall={fineDiag.tooSmall}>
              {fineDiag.subdivideOff
                ? t('w6ft.region.resultOff')
                : t('w6ft.region.result', { sub: n(fineDiag.sub), cells: n(fineDiag.cells), k: fineDiag.k })}
              {fineDiag.tooSmall > 0 && <> {tCount(t, 'w6ft.region.resultTooSmall', fineDiag.tooSmall, { n: n(fineDiag.tooSmall) })}</>}
              {api.stale && <span className="muted"> {t('w6ft.region.resultStale')}</span>}
            </p>
          )}
        </section>
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
              <p className="muted small w4cpa-hint" data-testid="cut-focus-hint">
                {t('w4cpa.bg.hint')}
                {/* Automatische Farbwahl: die Palette entsteht aus allen Steinen – weniger Hintergrundschnitte verschieben
                    auch die Farben im Gesicht (gemessen: einzelne Steine deutlich). Mit fester Palette bleiben sie gleich. */}
                {(s.paletteMode === 'auto' || s.paletteMode === 'auto-snap') && <> {t('w4fx.bg.paletteNote')}</>}
              </p>
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
        <RegionEditor api={api} typeOptions={[{ value: 'fine', label: t('shapes.region.fine') }]} />
      </div>
    </div>
  );
}
