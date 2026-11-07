import { useI18n } from '../../i18n';
import { Badge, ProgressBar } from '../components';
import { LayoutSummary } from './StepGeometry';
import type { ProjectApi } from './useProject';

export function StepCompute({ api, onDone }: { api: ProjectApi; onDone: () => void }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const d = api.rec!.diagnostics;
  const cells = api.layout ? api.layout.cols * api.layout.rows : 0;
  const phaseLabel = api.computing ? t(`compute.phase.${api.computing.phase}`) : '';
  const phases = ['prepare', 'adjust', 'lab', 'analyze', 'palette', 'assign'];
  const pIdx = api.computing ? Math.max(0, phases.indexOf(api.computing.phase)) : 0;
  const overall = api.computing ? (pIdx + api.computing.fraction) / phases.length : 0;
  return (
    <div className="two-col">
      <div>
        <h3>{t('compute.summary')}</h3>
        <table className="kv">
          <tbody>
            <tr>
              <th>{t('compute.size')}</th>
              <td>
                {n(s.widthMm / 10, 2)} × {n(s.heightMm / 10, 2)} cm
              </td>
            </tr>
            <tr>
              <th>{t('compute.tile')}</th>
              <td>
                {n(s.tileW, 2)} × {n(s.tileH, 2)} mm
              </td>
            </tr>
            <tr>
              <th>{t('compute.joint')}</th>
              <td>{n(s.joint, 2)} mm</td>
            </tr>
            <tr>
              <th>{t('compute.colors')}</th>
              <td>
                {t(`colors.mode.${s.paletteMode}`)}
                {(s.paletteMode === 'auto' || s.paletteMode === 'auto-snap') && ` · ${s.colorCount}`}
              </td>
            </tr>
            <tr>
              <th>{t('compute.shapes')}</th>
              <td>
                {[s.shapes.diagonal && t('shapes.diagonal'), s.shapes.line && t('shapes.line'), s.shapes.subdivide && `${t('shapes.subdivide')} ${s.shapes.subdivK}×${s.shapes.subdivK}`].filter(Boolean).join(', ') || t('shapes.none')}
              </td>
            </tr>
            <tr>
              <th>{t('compute.regions')}</th>
              <td>{api.rec!.regions.length}</td>
            </tr>
          </tbody>
        </table>
        <LayoutSummary api={api} />
        {!api.bitmap && <Badge kind="warn">{t('compute.needPhoto')}</Badge>}
        {cells > 5_000_000 && <Badge kind="warn">{t('compute.huge')}</Badge>}
        <div className="btn-row" style={{ marginTop: 12 }}>
          {!api.computing ? (
            <button
              className="btn primary big"
              data-testid="compute-btn"
              disabled={!api.bitmap || !api.layout}
              onClick={async () => {
                if (await api.compute()) onDone();
              }}
            >
              {api.computed ? t('compute.recompute') : t('compute.start')}
            </button>
          ) : (
            <button className="btn danger" onClick={api.cancelCompute}>
              {t('common.cancel')}
            </button>
          )}
        </div>
        {api.computed && !api.computing && api.stale && <p className="warn small">{t('compute.staleWarn')}</p>}
        {api.computed && !api.computing && <p className="muted small">{t('compute.overwriteWarn')}</p>}
        {api.computing && <ProgressBar value={overall} label={`${phaseLabel} ${Math.round(api.computing.fraction * 100)} %`} />}
        {api.computeError && <p className="error">{t(`compute.err.${api.computeError}`) === `compute.err.${api.computeError}` ? api.computeError : t(`compute.err.${api.computeError}`)}</p>}
      </div>
      <div>
        {d && api.computed && (
          <>
            <h3>{t('compute.result')}</h3>
            <table className="kv" data-testid="diagnostics">
              <tbody>
                <tr>
                  <th>{t('compute.meanDE')}</th>
                  <td>{n(d.meanDeltaE, 2)}</td>
                </tr>
                <tr>
                  <th>{t('compute.p95DE')}</th>
                  <td>≤ {n(d.p95DeltaE, 0)}</td>
                </tr>
                <tr>
                  <th>{t('compute.splitCells')}</th>
                  <td>{n(d.splitCells)}</td>
                </tr>
                <tr>
                  <th>{t('compute.subCells')}</th>
                  <td>{n(d.subCells)}</td>
                </tr>
                <tr>
                  <th>{t('compute.recCells')}</th>
                  <td>{n(d.recommendCells)}</td>
                </tr>
                <tr>
                  <th>{t('compute.time')}</th>
                  <td>{n(d.timeMs / 1000, 1)} s</td>
                </tr>
              </tbody>
            </table>
            <p className="muted small">{t('compute.deHint')}</p>
          </>
        )}
      </div>
    </div>
  );
}
