import { useEffect, useRef, useState, type ReactNode } from 'react';
import { tCount, useI18n, type Lang, type TFunc } from '../../i18n';
import { timestampedName, type SaveResult } from '../../platform';
import { downloadBlob, Modal, safeFileName } from '../components';
import { SaveResultNote, saveNoteState } from '../SaveResultNote';
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
  /**
   * Palettenfarben, die seit der letzten Berechnung bearbeitet wurden (HEX, Name, Material, hinzugefügt) und
   * beim Neuberechnen verloren gehen (nur wenn die Berechnung die Palette neu erstellt, nicht bei eigener Palette)
   */
  paletteEdits: number;
  /** true: betrifft das gespeicherte, wegen eines Fehlers nicht angezeigte Mosaik */
  stored: boolean;
}

/**
 * Verlust beim Neuberechnen, oder null, wenn nichts verloren geht (dann wird ohne Rückfrage gerechnet).
 * Angezeigtes Mosaik: verlegte Steine + manuelle Änderungen + bearbeitete Palettenfarben. Nicht angezeigtes
 * gespeichertes Mosaik (Integritätsfehler): dessen verlegte Steine.
 */
export function recomputeLoss(o: { computed: boolean; placed: number; total: number; edits: number; paletteEdits?: number; storedPlaced: number; storedCells: number }): RecomputeLoss | null {
  const paletteEdits = o.paletteEdits ?? 0;
  if (o.computed) return o.placed > 0 || o.edits > 0 || paletteEdits > 0 ? { placed: o.placed, total: o.total, edits: o.edits, paletteEdits, stored: false } : null;
  return o.storedPlaced > 0 ? { placed: o.storedPlaced, total: 0, edits: 0, paletteEdits: 0, stored: true } : null;
}

export function lossOf(api: ProjectApi): RecomputeLoss | null {
  return recomputeLoss({
    computed: !!api.computed,
    placed: api.progress?.total.placed ?? 0,
    total: api.progress?.total.total ?? 0,
    edits: api.computed ? api.manualEdits : 0,
    paletteEdits: api.computed ? api.paletteEdits : 0,
    storedPlaced: !api.computed && api.integrityError ? (api.rejected?.placed ?? 0) : 0,
    storedCells: api.rejected?.cells ?? 0,
  });
}

/** Aufzählung „1.526 als verlegt markierte Steine (25,6 % des Mosaiks), 3 manuelle Änderungen und 2 geänderte Palettenfarben“. */
export function lossList(l: RecomputeLoss, t: TFunc, n: (v: number, d?: number) => string): string {
  const parts: string[] = [];
  if (l.placed > 0) {
    if (l.total > 0) {
      const pct = (l.placed / l.total) * 100;
      // nie „0 %“ für verlegte Steine: sehr kleine Anteile als „< 0,1 %“
      parts.push(tCount(t, 'w2ws.guard.placed', l.placed, { n: n(l.placed), pct: pct < 0.05 ? `< ${n(0.1, 1)}` : n(pct, 1) }));
    }
    else parts.push(tCount(t, 'w2ws.guard.placedStored', l.placed, { n: n(l.placed) }));
  }
  if (l.edits > 0) parts.push(tCount(t, 'w2ws.guard.edits', l.edits, { n: n(l.edits) }));
  if (l.paletteEdits > 0) parts.push(tCount(t, 'w2ws.guard.paletteEdits', l.paletteEdits, { n: n(l.paletteEdits) }));
  if (parts.length <= 2) return parts.join(t('w2ws.guard.and'));
  return `${parts.slice(0, -1).join(', ')}${t('w2ws.guard.and')}${parts[parts.length - 1]}`;
}

const LOCALE: Record<Lang, string> = { de: 'de-DE', en: 'en-GB', tr: 'tr-TR' };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Neuberechnen mit Schutz vor Datenverlust: Gehen verlegte Steine, manuelle Änderungen oder bearbeitete
 * Palettenfarben verloren, fragt ein Dialog zuerst nach – mit Sicherungskopie (Standard), ohne Sicherung oder
 * Abbrechen. Schlägt die Sicherung fehl, wird NICHT berechnet; angeboten wird dann die Sicherung als Datei.
 *
 * Wird während der Berechnung am angezeigten Mosaik weitergearbeitet (verlegt, Abschnitt fertig, Steine
 * geändert), übernimmt useProject das Ergebnis nicht still: Es wartet (api.pendingResult), und derselbe Dialog
 * fragt mit den Zahlen von jetzt – Sicherungskopie und übernehmen, ohne Sicherung übernehmen oder das neue
 * Ergebnis verwerfen. Schließen lässt das Ergebnis warten (Hinweis im Projektkopf öffnet den Dialog wieder).
 */
export function useGuardedCompute(api: ProjectApi, onDone: () => void) {
  const { t, n, lang } = useI18n();
  const [ask, setAsk] = useState<RecomputeLoss | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [download, setDownload] = useState<{ result?: SaveResult; error?: string } | null>(null);
  const [backup, setBackup] = useState<{ id: string; name: string } | null>(null);
  /** Dialog zum wartenden Ergebnis geöffnet */
  const [pendingOpen, setPendingOpen] = useState(false);
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

  // Neues wartendes Ergebnis: Dialog öffnen (frische Rückmeldungen)
  const pendingAt = api.pendingResult?.at ?? null;
  useEffect(() => {
    if (pendingAt === null) {
      setPendingOpen(false);
      return;
    }
    cancelled.current = false;
    setFailure(null);
    setDownload(null);
    setPendingOpen(true);
  }, [pendingAt]);

  const run = async () => {
    const ok = await apiRef.current.compute();
    if (ok && mounted.current) onDoneRef.current();
  };
  const applyPending = async () => {
    const ok = await apiRef.current.applyPending();
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
      setDownload(null);
      setAsk(l);
      return;
    }
    void run();
  };

  const pendingMode = !!api.pendingResult && pendingOpen;

  const close = () => {
    if (busy) cancelled.current = true; // Sicherung läuft weiter, danach aber KEINE Berechnung/Übernahme
    setAsk(null);
    setPendingOpen(false);
    setFailure(null);
    setDownload(null);
  };

  /** Sicherungskopie anlegen, danach neu berechnen bzw. das wartende Ergebnis übernehmen. */
  const backupThen = async (next: 'compute' | 'apply') => {
    const a = apiRef.current;
    if (!a.rec) return;
    setBusy(true);
    setFailure(null);
    setDownload(null);
    cancelled.current = false;
    const date = new Date().toLocaleString(LOCALE[lang], { dateStyle: 'short', timeStyle: 'short' });
    const suffix = t(next === 'apply' ? 'w2ws.pending.backupSuffix' : 'w2ws.backupSuffix', { date });
    const name = `${a.rec.meta.name} ${suffix}`.trim();
    let nid: string;
    try {
      nid = await a.createBackupCopy(suffix);
    } catch (e) {
      if (!mounted.current) return;
      setBusy(false);
      // nichts berechnen/übernehmen – der jetzige Stand bleibt unverändert
      setFailure(t(next === 'apply' ? 'w2ws.pending.failed' : 'w2ws.guard.failed', { msg: saveErrorText(classifySaveError(e), t) || errText(e) }));
      return;
    }
    if (!mounted.current) return;
    setBusy(false);
    setBackup({ id: nid, name });
    if (cancelled.current) return; // Dialog wurde während der Sicherung geschlossen
    setAsk(null);
    setPendingOpen(false);
    if (next === 'apply') await applyPending();
    else await run();
  };

  const withoutBackup = async (next: 'compute' | 'apply') => {
    setAsk(null);
    setPendingOpen(false);
    setFailure(null);
    if (next === 'apply') await applyPending();
    else await run();
  };

  const discardResult = () => {
    apiRef.current.discardPending();
    close();
  };

  const downloadInstead = async () => {
    const a = apiRef.current;
    try {
      const blob = await a.exportCurrent();
      // Ergebnis zeigt der Dialog selbst (SaveResultNote) – keine zweite Meldung in der Meldungsleiste
      const r = await downloadBlob(blob, timestampedName(safeFileName(a.rec?.meta.name ?? ''), 'mosaicplan.json'), { announce: false });
      if (mounted.current) setDownload({ result: r });
    } catch (e) {
      if (mounted.current) setDownload({ error: t('w2ws.save.downloadFailed', { msg: errText(e) }) });
    }
  };

  // Zahlen live (falls sich etwas ändert, solange der Dialog offen ist); ohne Verlust die Momentaufnahme
  const live = lossOf(api);
  const shown = pendingMode ? live : ask ? (live ?? ask) : null;
  const open = pendingMode || !!ask;
  const mode: 'compute' | 'apply' = pendingMode ? 'apply' : 'compute';
  const downloadState = download?.result ? saveNoteState(download.result) : null;
  const dialog: ReactNode = open ? (
    <Modal
      title={pendingMode ? t('w2ws.pending.title') : t('w2ws.guard.title')}
      onClose={close}
      footer={
        <div className="btn-row w2ws-guard-foot">
          {pendingMode ? (
            <button className="btn" disabled={busy} onClick={discardResult} data-testid="guard-discard-result">
              {t('w2ws.pending.discard')}
            </button>
          ) : (
            <button className="btn" onClick={close} data-testid="guard-cancel">
              {t('common.cancel')}
            </button>
          )}
          <button className="btn danger" disabled={busy} onClick={() => void withoutBackup(mode)} data-testid="guard-nobackup">
            {pendingMode ? t('w2ws.pending.noBackup') : t('w2ws.guard.noBackup')}
          </button>
          {!failure && (
            <button className="btn primary" disabled={busy} autoFocus onClick={() => void backupThen(mode)} data-testid="guard-backup">
              {busy ? t('w2ws.guard.creating') : pendingMode ? t('w2ws.pending.backup') : t('w2ws.guard.backup')}
            </button>
          )}
        </div>
      }
    >
      <div data-testid="recompute-guard" data-mode={mode}>
        <p className="w2ws-guard-lead" data-testid="guard-loss">
          {pendingMode
            ? shown
              ? t('w2ws.pending.lead', { list: lossList(shown, t, n) })
              : t('w2ws.pending.leadNone')
            : shown?.stored
              ? t('w2ws.guard.leadStored', { list: lossList(shown, t, n) })
              : t('w2ws.guard.lead', { list: shown ? lossList(shown, t, n) : '' })}
        </p>
        <p className="muted small">{pendingMode ? t('w2ws.pending.info') : t('w2ws.guard.backupInfo')}</p>
        {failure && (
          <div className="w1fx-banner" role="alert" data-testid="guard-error">
            <span>{failure}</span>
            <button className="btn small" onClick={() => void downloadInstead()} data-testid="guard-download">
              {t('w2ws.guard.downloadInstead')}
            </button>
          </div>
        )}
        {download?.result && <SaveResultNote result={download.result} testId="guard-download-note" />}
        {download?.result && downloadState !== 'failed' && (
          <p className="muted small" data-testid="guard-download-msg">
            {t('w2ws.guard.downloaded')}
          </p>
        )}
        {download?.error && (
          <p className="error" role="status" data-testid="guard-download-msg">
            {download.error}
          </p>
        )}
      </div>
    </Modal>
  ) : null;

  return {
    request,
    dialog,
    backup,
    clearBackup: () => setBackup(null),
    /** Ergebnis wartet, Dialog ist geschlossen → Hinweis im Projektkopf zeigen */
    pendingHidden: !!api.pendingResult && !pendingOpen,
    openPending: () => {
      setFailure(null);
      setDownload(null);
      setPendingOpen(true);
    },
  };
}
