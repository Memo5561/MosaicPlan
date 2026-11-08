import { useEffect, useState } from 'react';
import { exportProject } from '../../storage/projects';
import { tCount, useI18n } from '../../i18n';
import { Badge, downloadBlob, ProgressBar, safeFileName } from '../components';
import { EmptyState } from './EmptyState';
import { lossList, lossOf } from './RecomputeGuard';
import { computedDeltaE, deltaERating, restoreComputedSettings, splitRestorable, staleReasonLabels, type StaleReason } from './staleReasons';
import { computeOverall } from './previewPolicy';
import { LayoutSummary } from './StepGeometry';
import type { Step } from './stepNav';
import type { ProjectApi } from './useProject';
import type { ComputeDiagnostics } from '../../core/mosaic';
import '../css/w2-workspace-shell.css';
import '../css/w3-live-preview.css';

/** „Verwendete Farben: M von N“ – nur wenn die Berechnung beide Zahlen geliefert hat (ältere Ergebnisse nicht). */
function ColorsUsedRow({ d }: { d: ComputeDiagnostics }) {
  const { t, n } = useI18n();
  if (d.usedColors === undefined || d.requestedColors === undefined) return null;
  return (
    <tr>
      <th>{t('w3lp.colorsUsed')}</th>
      <td data-testid="colors-used">{t('w3lp.colorsUsedVal', { used: n(d.usedColors), req: n(d.requestedColors) })}</td>
    </tr>
  );
}

export function StepCompute({ api, onCompute, onGo, reasons }: { api: ProjectApi; onCompute: () => void; onGo: (s: Step) => void; reasons: StaleReason[] }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const d = api.rec!.diagnostics;
  const cells = api.layout ? api.layout.cols * api.layout.rows : 0;
  const phaseLabel = api.computing ? t(`compute.phase.${api.computing.phase}`) : '';
  const overall = computeOverall(api.computing);
  const other = api.otherJob;
  // Fertige Vorschau der aktuellen Einstellungen: „Vorschau übernehmen“ speichert sie ohne zweite Berechnung
  const commitPreview = api.previewCommittable;
  const pvd = commitPreview ? api.preview.result?.diagnostics : undefined;
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
  // Was „Änderungen verwerfen“ hier wirklich wiederherstellt (nach einem Fotowechsel nicht Bereiche/Zuschnitt des alten Fotos)
  const { restorable, notRestorable } = splitRestorable(reasons);
  // Hinweis nennt die Werte, auf die zurückgesetzt wird (nicht „alt → neu“)
  const discardHint = t('w2ws.stale.discardHint', { list: staleReasonLabels(restorable, t, n, { target: 'from' }).join(', ') });
  // Berechnung erstellt die Palette neu (automatisch/Materialien) – eigene Palette bleibt
  const paletteRebuilt = s.paletteMode !== 'custom';
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
        {api.bitmap && <p className="muted small">{t('w3lp.computeIntro')}</p>}
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
                  title={discardHint}
                  onClick={() => {
                    api.update((r) => restoreComputedSettings(r) ?? r);
                    setDiscarded(true);
                  }}
                >
                  ↶ {t('w2ws.stale.discard')}
                </button>
                <small className="muted" data-testid="discard-hint">
                  {discardHint}
                </small>
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
          <>
            {other && !commitPreview && !api.computing ? (
              // App-weit läuft nur eine Berechnung: hier nicht still warten, sondern sagen, welche läuft
              <div className="w3lp-other" role="status" data-testid="other-job">
                <span>{t('w3lp.otherJob', { name: other.projectName, pct: Math.round(computeOverall(other.progress) * 100) })}</span>
                <a className="btn small" href={`#/project/${other.projectId}/compute`} data-testid="other-job-open">
                  {t('w3lp.otherJob.open')}
                </a>
                <button className="btn small danger" onClick={api.cancelOtherJob} data-testid="other-job-cancel">
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <div className="btn-row" style={{ marginTop: 12 }}>
                {!api.computing ? (
                  <button className="btn primary big" data-testid="compute-btn" data-mode={commitPreview ? 'commit' : 'compute'} disabled={!api.layout} onClick={onCompute}>
                    {commitPreview ? t('w3lp.commit') : api.computed ? t('compute.recompute') : t('compute.start')}
                  </button>
                ) : (
                  <button className="btn danger" onClick={api.cancelCompute} data-testid="compute-cancel" disabled={api.computing.phase === 'commit'}>
                    {t('common.cancel')}
                  </button>
                )}
              </div>
            )}
            {!api.computing && commitPreview && (
              <p className="muted small w3lp-commit-hint" data-testid="commit-hint">
                {t('w3lp.commitHint')}
              </p>
            )}
            {!api.computing && !commitPreview && api.preview.runningCurrent && (
              <p className="muted small w3lp-commit-hint" data-testid="reuse-hint">
                {t('w3lp.reuseHint')}
              </p>
            )}
          </>
        )}
        {api.computed && !api.computing && api.stale && reasons.length === 0 && <p className="warn small">{t('compute.staleWarn')}</p>}
        {api.computed &&
          !api.computing &&
          (loss ? (
            <p className="warn small w2ws-overwrite" data-testid="overwrite-warn">
              {t('w2ws.overwriteCounts', { list: lossList(loss, t, n) })}
              {paletteRebuilt && ` ${t('w2ws.paletteRebuilt')}`}
            </p>
          ) : (
            <p className="muted small" data-testid="overwrite-warn">
              {!paletteRebuilt ? t('w2ws.overwriteNone') : api.paletteEditsUnknown ? t('w2ws.overwriteNoneLegacy') : t('w2ws.overwriteNoneAuto')}
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
        {api.computing && (
          <div data-testid="compute-progress">
            <ProgressBar value={overall} label={`${phaseLabel} ${Math.round(api.computing.fraction * 100)} %`} />
            {api.computing.phase !== 'commit' && <p className="muted small">{t('w3lp.runningElsewhere')}</p>}
          </div>
        )}
        {api.computeError && <p className="error">{t(`compute.err.${api.computeError}`) === `compute.err.${api.computeError}` ? api.computeError : t(`compute.err.${api.computeError}`)}</p>}
      </div>
      <div>
        {d && api.computed && (
          <>
            {pvd ? (
              // Neben einer neuen Vorschau klar sagen, welches Ergebnis gespeichert ist
              <div className="w3lp-diag-head">
                <h3>{t('compute.result')}</h3>
                <span className="w3lp-badge w3lp-badge-ok">{t('w3lp.badge.committed')}</span>
              </div>
            ) : (
              <h3>{t('compute.result')}</h3>
            )}
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
                <ColorsUsedRow d={d} />
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
        {pvd && (
          // Ergebnis der Vorschau, die „Vorschau übernehmen“ speichern würde (gemessene Werte dieser Berechnung)
          <>
            <div className="w3lp-diag-head">
              <h3>{t('compute.result')}</h3>
              <span className="w3lp-badge">{t('w3lp.previewResult')}</span>
            </div>
            <table className="kv" data-testid="preview-diagnostics">
              <tbody>
                <tr>
                  <th>{t('compute.meanDE')}</th>
                  <td>{n(pvd.meanDeltaE, 2)}</td>
                </tr>
                <ColorsUsedRow d={pvd} />
                <tr>
                  <th>{t('compute.splitCells')}</th>
                  <td>{n(pvd.splitCells)}</td>
                </tr>
                <tr>
                  <th>{t('compute.subCells')}</th>
                  <td>{n(pvd.subCells)}</td>
                </tr>
                <tr>
                  <th>{t('compute.time')}</th>
                  <td>{n(pvd.timeMs / 1000, 1)} s</td>
                </tr>
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
