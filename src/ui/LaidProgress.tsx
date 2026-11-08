import { useI18n } from '../i18n';
import { laidPercent, listProgressOf, type ProjectRecord } from '../storage/db';
import './css/w4-progress-engine.css';

/**
 * „NN % verlegt“ mit schmalem Fortschrittsbalken für Projektlisten („Meine Projekte“, Startseite). Zahlen aus
 * meta.progressSummary – nur, wenn sie zum gespeicherten Raster gehören (listProgressOf); sonst wird nichts angezeigt
 * (ältere Projekte bis zum nächsten Öffnen). Nie geschätzt.
 */
export function LaidProgress({ rec, compact }: { rec: Pick<ProjectRecord, 'meta' | 'mosaicRev'>; compact?: boolean }) {
  const { t, n } = useI18n();
  const p = listProgressOf(rec);
  if (!p) return null;
  const { pct, lessThanOne } = laidPercent(p.placed, p.total);
  const label = lessThanOne ? t('w4pe.laidLess') : t('w4pe.laid', { pct: n(pct) });
  const title = t('w4pe.laidTitle', { placed: n(p.placed), total: n(p.total) });
  // ein einzelner verlegter Stein bleibt als schmaler Streifen sichtbar (Text nennt „unter 1 %“)
  const width = p.placed >= p.total ? 100 : p.placed > 0 ? Math.max(1, (p.placed / p.total) * 100) : 0;
  return (
    <span className={`w4pe-laid ${compact ? 'w4pe-compact' : ''} ${p.placed >= p.total ? 'w4pe-done' : ''}`} title={title} data-testid="project-progress" data-placed={p.placed} data-total={p.total}>
      <span className="w4pe-laid-text">{label}</span>
      <span className="w4pe-bar" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.placed}>
        <span className="w4pe-bar-fill" style={{ width: `${width}%` }} />
      </span>
    </span>
  );
}
