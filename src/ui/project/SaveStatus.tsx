import { useEffect, useState } from 'react';
import { useI18n, type TFunc } from '../../i18n';
import { downloadBlob, safeFileName } from '../components';
import type { ProjectApi, SaveError, SaveState } from './useProject';
import '../css/w2-workspace-shell.css';

/** Kurzer Speicherstatus im Projektkopf: „Gespeichert ✓“ · „Speichert …“ · „Nicht gespeichert“. */
export function SaveStatus({ state }: { state: SaveState }) {
  const { t } = useI18n();
  const label = state === 'error' ? t('w2ws.save.error') : state === 'saving' ? t('w2ws.save.saving') : t('w2ws.save.saved');
  const title = state === 'error' ? t('w2ws.save.title.error') : state === 'saving' ? t('w2ws.save.title.saving') : t('w2ws.save.title.saved');
  return (
    <span className={`w2ws-save w2ws-save-${state}`} data-testid="save-status" data-state={state} title={title}>
      {state === 'saving' && <span className="w2ws-save-dot" aria-hidden="true" />}
      {label}
    </span>
  );
}

/** Text zur Fehlerart (unbekannte Arten → allgemeiner Text mit der Meldung). */
export function saveErrorText(e: SaveError | null, t: TFunc): string {
  if (!e) return '';
  if (e.code === 'quota') return t('w2ws.save.quota');
  if (e.code === 'connection') return t('w2ws.save.connection');
  if (e.code === 'deleted') return t('w2ws.save.deleted');
  return t('w2ws.save.other', { msg: e.message || '?' });
}

/**
 * Dauerhafter Hinweis, solange Speichern fehlschlägt: Erneut versuchen (schreibt den aktuellen Stand
 * aus dem Arbeitsspeicher) und Sicherung herunterladen (Projektdatei aus dem Arbeitsspeicher, nicht
 * aus dem Gerätespeicher – der enthält die ungespeicherten Änderungen ja gerade nicht).
 */
export function SaveErrorBanner({ api }: { api: ProjectApi }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<'retry' | 'download' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const err = api.saveError;
  const show = api.saveState === 'error' && !!err;
  // Meldung zu einem früheren Versuch gilt nicht mehr, sobald sich der Fehler ändert oder behoben ist
  useEffect(() => setMsg(null), [err?.code, err?.message, show]);
  if (!show || !err) return null;
  const deleted = err.code === 'deleted';
  return (
    <div className="w1fx-banner w2ws-save-banner" role="alert" data-testid="save-error">
      <span>
        <b>{saveErrorText(err, t)}</b> {deleted ? t('w2ws.save.adviceDeleted') : t('w2ws.save.advice')}
        {msg && (
          <span className="block small" data-testid="save-error-msg">
            {msg}
          </span>
        )}
      </span>
      {!deleted && (
        <button
          className="btn small"
          disabled={busy !== null}
          data-testid="save-retry"
          onClick={async () => {
            setBusy('retry');
            setMsg(null);
            const ok = await api.retrySave();
            setBusy(null);
            if (!ok) setMsg(t('w2ws.save.stillFailing'));
          }}
        >
          {busy === 'retry' ? t('w2ws.save.retrying') : t('w2ws.save.retry')}
        </button>
      )}
      <button
        className="btn small"
        disabled={busy !== null}
        data-testid="save-download"
        onClick={async () => {
          setBusy('download');
          setMsg(null);
          try {
            const blob = await api.exportCurrent();
            await downloadBlob(blob, `${safeFileName(api.rec?.meta.name ?? '')}.mosaicplan.json`);
          } catch (e) {
            setMsg(t('w2ws.save.downloadFailed', { msg: e instanceof Error ? e.message : String(e) }));
          } finally {
            setBusy(null);
          }
        }}
      >
        {t('w2ws.save.download')}
      </button>
    </div>
  );
}
