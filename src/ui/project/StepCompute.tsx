import { useEffect, useState } from 'react';
import { exportProject } from '../../storage/projects';
import { tCount, useI18n } from '../../i18n';
import { Badge, downloadBlob, ProgressBar, safeFileName } from '../components';
import { EmptyState } from './EmptyState';
import { lossList, lossOf } from './RecomputeGuard';
import { computedDeltaE, deltaERating, isRestorable, restoreComputedSettings, staleReasonLabels, type StaleReason } from './staleReasons';
import { LayoutSummary } from './StepGeometry';
import type { Step } from './stepNav';
import type { ProjectApi } from './useProject';
import '../css/w2-workspace-shell.css';

export function StepCompute({ api, onCompute, onGo, reasons }: { api: ProjectApi; onCompute: () => void; onGo: (s: Step) => void; reasons: StaleReason[] }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const d = api.rec!.diagnostics;
  const cells = api.layout ? api.layout.cols * api.layout.rows : 0;
  const phaseLabel = api.computing ? t(`compute.phase.${api.computing.phase}`) : '';
  const phases = ['prepare', 'adjust', 'lab', 'analyze', 'palette', 'assign'];
  const pIdx = api.computing ? Math.max(0, phases.indexOf(api.computing.phase)) : 0;
  const overall = api.computing ? (pIdx + api.computing.fraction) / phases.length : 0;
  const [backupMsg, setBackupMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [discarded, setDiscarded] = useState(false);
  // Hinweis „wiederhergestellt“ gilt nur, bis wieder etwas geändert oder neu berechnet wird
  useEffect(() => {
    if (api.stale || api.computing) setDiscarded(false);
  }, [api.stale, api.computing]);
  // Nicht angezeigtes gespeichertes Mosaik mit Verlegefortschritt: Neuberechnen ersetzt es
  const lostPlaced = !api.computed && api.integrityError ? (api.rejected?.placed ?? 0) : 0;
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // Was ein Neuberechnen jetzt verwerfen würde (exakte Zahlen; vor dem Berechnen wird nachgefragt)
  const loss = api.computed ? lossOf(api) : null;
  // Änderungen seit der letzten Berechnung
  const reasonLabels = staleReasonLabels(reasons, t, n);
  const restorable = reasons.filter(isRestorable);
  const notRestorable = reasons.filter((r) => !isRestorable(r));
  // Bewertung der Farbabweichung nur für die Formel, mit der das angezeigte Ergebnis berechnet wurde
  const resultDE = computedDeltaE(api.rec!.computedWith) ?? (api.stale ? null : s.deltaE);
  const rating = d && resultDE === '2000' ? deltaERating(d.meanDeltaE) : null;
  const ratingText = rating === 'low' ? t('w2ws.de.low') : rating === 'mid' ? t('w2ws.de.mid') : rating === 'high' ? t('w2ws.de.high') : '';
  const photoUnreadable = !api.bitmap && !!api.image;
  return (
    <div className="two-col">
      <div>
        {!api.bitmap && (
          <EmptyState
            icon="🖼"
            testId="compute-no-photo"
            title={photoUnreadable ? t('w2ws.empty.photoUnreadable.title') : t('w2ws.empty.noPhoto.title')}
            text={photoUnreadable ? t('w2ws.empty.photoUnreadable.text') : t('w2ws.empty.noPhoto.text')}
            actions={[{ label: t('w2ws.empty.goPhoto'), onClick: () => onGo('photo'), primary: true, testId: 'empty-go-photo' }]}
          />
        )}
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
        {cells > 5_000_000 && <Badge kind="warn">{t('compute.huge')}</Badge>}
        {api.computed && api.stale && !api.computing && (
          <div className="w2ws-stale" data-testid="stale-reasons">
            <p className="warn small">
              <b>{t('w2ws.stale.lead', { list: reasonLabels.join(', ') })}</b> {t('w2ws.stale.keep')}
            </p>
            {restorable.length > 0 && (
              <div className="btn-row wrap">
                <button
                  className="btn small"
                  data-testid="discard-changes"
                  title={t('w2ws.stale.discardHint', { list: staleReasonLabels(restorable, t, n).join(', ') })}
                  onClick={() => {
                    api.update((r) => restoreComputedSettings(r) ?? r);
                    setDiscarded(true);
                  }}
                >
                  ↶ {t('w2ws.stale.discard')}
                </button>
                <small className="muted">{t('w2ws.stale.discardHint', { list: staleReasonLabels(restorable, t, n).join(', ') })}</small>
              </div>
            )}
            {notRestorable.length > 0 && <p className="muted small">{t('w2ws.stale.notRestorable', { list: staleReasonLabels(notRestorable, t, n).join(', ') })}</p>}
          </div>
        )}
        {discarded && !api.stale && api.computed && (
          <p className="ok small" role="status" data-testid="discard-msg">
            {t('w2ws.stale.discarded')}
          </p>
        )}
        {api.bitmap && (
          <div className="btn-row" style={{ marginTop: 12 }}>
            {!api.computing ? (
              <button className="btn primary big" data-testid="compute-btn" disabled={!api.layout} onClick={onCompute}>
                {api.computed ? t('compute.recompute') : t('compute.start')}
              </button>
            ) : (
              <button className="btn danger" onClick={api.cancelCompute}>
                {t('common.cancel')}
              </button>
            )}
          </div>
        )}
        {api.computed && !api.computing && api.stale && reasons.length === 0 && <p className="warn small">{t('compute.staleWarn')}</p>}
        {api.computed &&
          !api.computing &&
          (loss ? (
            <p className="warn small w2ws-overwrite" data-testid="overwrite-warn">
              {t('w2ws.overwriteCounts', { list: lossList(loss, t, n) })}
            </p>
          ) : (
            <p className="muted small" data-testid="overwrite-warn">
              {t('w2ws.overwriteNone')}
            </p>
          ))}
        {lostPlaced > 0 && !api.computing && (
          <div className="w1fx-banner" role="alert" data-testid="placed-loss">
            <span>{tCount(t, 'integrity.placedLoss', lostPlaced, { n: n(lostPlaced) })}</span>
            <button
              className="btn small"
              data-testid="placed-loss-download"
              onClick={async () => {
                try {
                  // gespeicherter Stand inkl. Raster und Fortschritt (so, wie er im Gerätespeicher liegt)
                  const b = await exportProject(api.rec!.meta.id);
                  await downloadBlob(b, `${safeFileName(api.rec!.meta.name)}.mosaicplan.json`);
                  setBackupMsg(null);
                } catch (e) {
                  setBackupMsg({ ok: false, text: t('integrity.failed', { msg: errText(e) }) });
                }
              }}
            >
              {t('integrity.download')}
            </button>
            <button
              className="btn small"
              data-testid="placed-loss-copy"
              onClick={async () => {
                try {
                  const suffix = t('projects.copySuffix');
                  await api.createBackupCopy(suffix);
                  setBackupMsg({ ok: true, text: t('integrity.copied', { name: `${api.rec!.meta.name} ${suffix}`.trim() }) });
                } catch (e) {
                  setBackupMsg({ ok: false, text: t('integrity.failed', { msg: errText(e) }) });
                }
              }}
            >
              {t('integrity.copy')}
            </button>
          </div>
        )}
        {backupMsg && (
          <p className={backupMsg.ok ? 'muted small' : 'error'} role="status" data-testid="placed-loss-msg">
            {backupMsg.text}
          </p>
        )}
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
                  <td data-testid="mean-de">
                    {n(d.meanDeltaE, 2)}
                    {ratingText && <span className={`w2ws-rating ${rating}`}> – {ratingText}</span>}
                  </td>
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
