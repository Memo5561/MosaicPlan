import { useEffect, useRef, useState, type ReactNode } from 'react';
import { tCount, useI18n, type Lang, type TFunc } from '../../i18n';
import { downloadBlob, Modal, safeFileName } from '../components';
import { saveErrorText } from './SaveStatus';
import { classifySaveError, type ProjectApi } from './useProject';
import '../css/w2-workspace-shell.css';

/** Was ein Neuberechnen verwerfen würde – exakte Zahlen aus dem aktuellen Stand. */
export interface RecomputeLoss {
  /** als verlegt markierte Steine */
  placed: number;
  /** Steine im Mosaik (für den Anteil) */
  total: number;
  /** manuelle Änderungen seit der letzten Berechnung (Zähler, nicht Steine) */
  edits: number;
  /** true: betrifft das gespeicherte, wegen eines Fehlers nicht angezeigte Mosaik */
  stored: boolean;
}

/**
 * Verlust beim Neuberechnen, oder null, wenn nichts verloren geht (dann wird ohne Rückfrage gerechnet).
 * Angezeigtes Mosaik: verlegte Steine + manuelle Änderungen. Nicht angezeigtes gespeichertes Mosaik
 * (Integritätsfehler): dessen verlegte Steine.
 */
export function recomputeLoss(o: { computed: boolean; placed: number; total: number; edits: number; storedPlaced: number; storedCells: number }): RecomputeLoss | null {
  if (o.computed) return o.placed > 0 || o.edits > 0 ? { placed: o.placed, total: o.total, edits: o.edits, stored: false } : null;
  return o.storedPlaced > 0 ? { placed: o.storedPlaced, total: 0, edits: 0, stored: true } : null;
}

export function lossOf(api: ProjectApi): RecomputeLoss | null {
  return recomputeLoss({
    computed: !!api.computed,
    placed: api.progress?.total.placed ?? 0,
    total: api.progress?.total.total ?? 0,
    edits: api.computed ? api.manualEdits : 0,
    storedPlaced: !api.computed && api.integrityError ? (api.rejected?.placed ?? 0) : 0,
    storedCells: api.rejected?.cells ?? 0,
  });
}

/** Aufzählung „1.526 als verlegt markierte Steine (25,6 % des Mosaiks) und 3 manuelle Änderungen“. */
export function lossList(l: RecomputeLoss, t: TFunc, n: (v: number, d?: number) => string): string {
  const parts: string[] = [];
  if (l.placed > 0) {
    if (l.total > 0) parts.push(tCount(t, 'w2ws.guard.placed', l.placed, { n: n(l.placed), pct: n((l.placed / l.total) * 100, 1) }));
    else parts.push(tCount(t, 'w2ws.guard.placedStored', l.placed, { n: n(l.placed) }));
  }
  if (l.edits > 0) parts.push(tCount(t, 'w2ws.guard.edits', l.edits, { n: n(l.edits) }));
  return parts.join(t('w2ws.guard.and'));
}

const LOCALE: Record<Lang, string> = { de: 'de-DE', en: 'en-GB', tr: 'tr-TR' };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Neuberechnen mit Schutz vor Datenverlust: Gehen verlegte Steine oder manuelle Änderungen verloren,
 * fragt ein Dialog zuerst nach – mit Sicherungskopie (Standard), ohne Sicherung oder Abbrechen.
 * Schlägt die Sicherung fehl, wird NICHT berechnet; angeboten wird dann die Sicherung als Datei.
 */
export function useGuardedCompute(api: ProjectApi, onDone: () => void) {
  const { t, n, lang } = useI18n();
  const [ask, setAsk] = useState<RecomputeLoss | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [downloadMsg, setDownloadMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [backup, setBackup] = useState<{ id: string; name: string } | null>(null);
  const mounted = useRef(true);
  const cancelled = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async () => {
    const ok = await apiRef.current.compute();
    if (ok && mounted.current) onDoneRef.current();
  };

  /** Berechnen anfordern (Schaltfläche in Schritt 7 und in der Schrittleiste unten). */
  const request = () => {
    const a = apiRef.current;
    if (a.computing || !a.bitmap || !a.layout) return;
    const l = lossOf(a);
    if (l) {
      cancelled.current = false;
      setFailure(null);
      setDownloadMsg(null);
      setAsk(l);
      return;
    }
    void run();
  };

  const close = () => {
    if (busy) cancelled.current = true; // Sicherung läuft weiter, danach aber KEINE Berechnung
    setAsk(null);
    setFailure(null);
    setDownloadMsg(null);
  };

  const backupThenCompute = async () => {
    const a = apiRef.current;
    if (!a.rec) return;
    setBusy(true);
    setFailure(null);
    setDownloadMsg(null);
    cancelled.current = false;
    const date = new Date().toLocaleString(LOCALE[lang], { dateStyle: 'short', timeStyle: 'short' });
    const suffix = t('w2ws.backupSuffix', { date });
    const name = `${a.rec.meta.name} ${suffix}`.trim();
    let nid: string;
    try {
      nid = await a.createBackupCopy(suffix);
    } catch (e) {
      if (!mounted.current) return;
      setBusy(false);
      // nichts berechnen – der jetzige Stand bleibt unverändert
      setFailure(t('w2ws.guard.failed', { msg: saveErrorText(classifySaveError(e), t) || errText(e) }));
      return;
    }
    if (!mounted.current) return;
    setBusy(false);
    setBackup({ id: nid, name });
    if (cancelled.current) return; // Dialog wurde während der Sicherung geschlossen
    setAsk(null);
    await run();
  };

  const computeWithoutBackup = async () => {
    setAsk(null);
    setFailure(null);
    await run();
  };

  const downloadInstead = async () => {
    const a = apiRef.current;
    try {
      const blob = await a.exportCurrent();
      await downloadBlob(blob, `${safeFileName(a.rec?.meta.name ?? '')}.mosaicplan.json`);
      if (mounted.current) setDownloadMsg({ ok: true, text: t('w2ws.guard.downloaded') });
    } catch (e) {
      if (mounted.current) setDownloadMsg({ ok: false, text: t('w2ws.save.downloadFailed', { msg: errText(e) }) });
    }
  };

  // Zahlen live (falls sich etwas ändert, solange der Dialog offen ist); ohne Verlust die Momentaufnahme
  const shown = ask ? (lossOf(api) ?? ask) : null;
  const dialog: ReactNode = shown ? (
    <Modal
      title={t('w2ws.guard.title')}
      onClose={close}
      footer={
        <div className="btn-row w2ws-guard-foot">
          <button className="btn" onClick={close} data-testid="guard-cancel">
            {t('common.cancel')}
          </button>
          <button className="btn danger" disabled={busy} onClick={() => void computeWithoutBackup()} data-testid="guard-nobackup">
            {t('w2ws.guard.noBackup')}
          </button>
          {!failure && (
            <button className="btn primary" disabled={busy} autoFocus onClick={() => void backupThenCompute()} data-testid="guard-backup">
              {busy ? t('w2ws.guard.creating') : t('w2ws.guard.backup')}
            </button>
          )}
        </div>
      }
    >
      <div data-testid="recompute-guard">
        <p className="w2ws-guard-lead" data-testid="guard-loss">
          {shown.stored ? t('w2ws.guard.leadStored', { list: lossList(shown, t, n) }) : t('w2ws.guard.lead', { list: lossList(shown, t, n) })}
        </p>
        <p className="muted small">{t('w2ws.guard.backupInfo')}</p>
        {failure && (
          <div className="w1fx-banner" role="alert" data-testid="guard-error">
            <span>{failure}</span>
            <button className="btn small" onClick={() => void downloadInstead()} data-testid="guard-download">
              {t('w2ws.guard.downloadInstead')}
            </button>
          </div>
        )}
        {downloadMsg && (
          <p className={downloadMsg.ok ? 'muted small' : 'error'} role="status" data-testid="guard-download-msg">
            {downloadMsg.text}
          </p>
        )}
      </div>
    </Modal>
  ) : null;

  return { request, dialog, backup, clearBackup: () => setBackup(null) };
}
