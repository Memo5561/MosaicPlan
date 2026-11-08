/**
 * Rückmeldung nach dem Speichern einer Datei (PDF, CSV, Projektsicherung).
 *
 * SaveResultNote zeigt EIN Speicherergebnis an (role=status):
 *  - APK, Datei in Documents bestätigt → „Gespeichert: Documents/MosaicPlan/<Name>“ + „Teilen …“;
 *  - APK, Documents ging nicht → Warnung mit Grund + „Teilen …“ (die Datei liegt nur im App-Cache);
 *  - APK, nicht einmal der Cache ging → Fehler mit Grund, kein Teilen;
 *  - Browser → „Download gestartet: <Name>“ (den Ordner bestimmt der Browser).
 * Ein Pfad erscheint NUR, wenn savedPath gesetzt ist – nie wird ein Ort genannt, der nicht geschrieben wurde.
 *
 * SaveResultHost ist eine app-weite Meldungsleiste (unten, über allem). downloadBlob meldet dort jedes
 * Ergebnis im APK (announceSave), damit auch Ansichten ohne eigene Anzeige zeigen, wohin die Datei ging.
 * Wer selbst eine SaveResultNote anzeigt, ruft downloadBlob(…, { announce: false }) auf.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { I18nContext, makeT, numberFormatter, useI18n, type Lang, type TFunc } from '../i18n';
import { reshare, type NativeSaveResult, type SaveResult } from '../platform';
import './css/w2-android-platform.css';

export type SaveNoteState = 'saved' | 'not-saved' | 'failed' | 'download';

export function saveNoteState(r: SaveResult): SaveNoteState {
  if (r.kind === 'download') return 'download';
  if (r.savedPath) return 'saved';
  return r.cacheUri ? 'not-saved' : 'failed';
}

/** Lesbarer Grund, warum nicht (in Documents) gespeichert wurde */
export function saveFailReasonText(t: TFunc, r: NativeSaveResult): string {
  const detail = r.error ?? '';
  switch (r.reason) {
    case 'permission':
      return t('filesave.reason.permission');
    case 'size':
      return t('filesave.reason.size', { detail });
    case 'cache':
      return t('filesave.reason.cache', { detail });
    default:
      return detail || '?';
  }
}

/** Pfad mit Umbruchmöglichkeiten nach „/“ und „_“ (statt mitten im Wort) */
function breakablePath(p: string): ReactNode[] {
  return p.split(/(?<=[/_])/).flatMap((part, i) => (i ? [<wbr key={`w${i}`} />, part] : [part]));
}

export function SaveResultNote(props: { result: SaveResult; onDismiss?: () => void; onInteract?: () => void; testId?: string }) {
  const { t } = useI18n();
  const r = props.result;
  const state = saveNoteState(r);
  const [sharing, setSharing] = useState(false);
  const [share, setShare] = useState<{ shared: boolean; error?: string }>(() => (r.kind === 'native' ? { shared: r.shared, error: r.shareError } : { shared: false }));
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setShare(r.kind === 'native' ? { shared: r.shared, error: r.shareError } : { shared: false });
  }, [r]);

  const fileName = r.kind === 'native' ? (r.savedName ?? r.name) : r.name;
  const doShare = async () => {
    if (r.kind !== 'native' || !r.cacheUri || sharing) return;
    props.onInteract?.();
    setSharing(true);
    const s = await reshare(r.cacheUri, fileName);
    if (!alive.current) return;
    setSharing(false);
    setShare((prev) => ({ shared: prev.shared || s.shared, error: s.error }));
  };

  const icon = state === 'saved' ? '✓' : state === 'download' ? '↓' : state === 'not-saved' ? '!' : '✕';
  return (
    <div className={`w2ap-note w2ap-${state}`} role="status" aria-live="polite" data-testid={props.testId ?? 'save-note'} data-state={state}>
      <span className="w2ap-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="w2ap-body">
        {r.kind === 'download' && <p>{t('filesave.download', { name: r.name })}</p>}
        {r.kind === 'native' && state === 'saved' && (
          <>
            <p>
              <b>{t('filesave.savedLabel')}</b>{' '}
              <code className="w2ap-path" data-testid="save-note-path">
                {breakablePath(r.savedPath ?? '')}
              </code>
            </p>
            <p className="w2ap-sub">{t('filesave.where')}</p>
          </>
        )}
        {r.kind === 'native' && state === 'not-saved' && (
          <>
            <p>
              <b>{t('filesave.notSaved')}</b>
            </p>
            <p className="w2ap-sub" data-testid="save-note-reason">
              {t('filesave.reason', { reason: saveFailReasonText(t, r) })}
            </p>
          </>
        )}
        {r.kind === 'native' && state === 'failed' && (
          <>
            <p>
              <b>{t('filesave.failed', { name: r.name })}</b>
            </p>
            <p className="w2ap-sub" data-testid="save-note-reason">
              {t('filesave.reason', { reason: saveFailReasonText(t, r) })}
            </p>
          </>
        )}
        {share.shared && <p className="w2ap-sub">{t('filesave.shared')}</p>}
        {share.error && <p className="w2ap-sub w2ap-err">{t('filesave.shareFailed', { reason: share.error })}</p>}
        {r.kind === 'native' && r.cacheUri && (
          <div className="w2ap-actions">
            <button type="button" className={`btn small ${state === 'not-saved' ? 'primary' : ''}`} onClick={doShare} disabled={sharing} data-testid="save-note-share">
              {sharing ? t('filesave.sharing') : share.shared ? t('filesave.shareAgain') : t('filesave.share')}
            </button>
          </div>
        )}
      </div>
      {props.onDismiss && (
        <button type="button" className="icon-btn w2ap-close" onClick={props.onDismiss} aria-label={t('filesave.dismiss')} title={t('filesave.dismiss')} data-testid="save-note-dismiss">
          ✕
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- app-weite Meldungen

interface HostEntry {
  id: number;
  result?: SaveResult;
  /** reiner Hinweistext (i18n-Schlüssel), z. B. nach Neustart der Anzeige */
  notice?: string;
  sticky: boolean;
}

/** Erfolgsmeldungen verschwinden nach dieser Zeit von selbst (außer nach Teilen); Warnungen bleiben. */
const SUCCESS_MS = 15000;
const MAX_ENTRIES = 3;

let entries: HostEntry[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function push(e: Omit<HostEntry, 'id'>) {
  entries = [...entries, { ...e, id: ++seq }].slice(-MAX_ENTRIES);
  emit();
}

/** Speicherergebnis app-weit melden (nur im APK sinnvoll; Browser-Downloads zeigt der Browser selbst). */
export function announceSave(result: SaveResult): void {
  if (result.kind !== 'native') return;
  push({ result, sticky: saveNoteState(result) !== 'saved' });
}

/** Hinweis app-weit anzeigen (bleibt, bis er geschlossen wird). */
export function announceNotice(key: string): void {
  if (entries.some((e) => e.notice === key)) return;
  push({ notice: key, sticky: true });
}

function dismiss(id: number) {
  entries = entries.filter((e) => e.id !== id);
  emit();
}
function makeSticky(id: number) {
  entries = entries.map((e) => (e.id === id ? { ...e, sticky: true } : e));
  emit();
}

/** Nur für Tests */
export function _hostEntries(): readonly HostEntry[] {
  return entries;
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** Sprache der App: App.tsx setzt <html lang>; der Host liegt außerhalb des Sprachkontexts. */
function useDocumentLang(): Lang {
  const read = (): Lang => {
    const l = typeof document !== 'undefined' ? document.documentElement.lang : 'de';
    return l === 'en' || l === 'tr' ? l : 'de';
  };
  const [lang, setLang] = useState<Lang>(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setLang(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    setLang(read());
    return () => mo.disconnect();
  }, []);
  return lang;
}

function HostItem({ e }: { e: HostEntry }) {
  const { t } = useI18n();
  useEffect(() => {
    if (e.sticky) return;
    const id = window.setTimeout(() => dismiss(e.id), SUCCESS_MS);
    return () => window.clearTimeout(id);
  }, [e.id, e.sticky]);
  if (e.result) return <SaveResultNote result={e.result} onDismiss={() => dismiss(e.id)} onInteract={() => makeSticky(e.id)} testId="save-toast" />;
  return (
    <div className="w2ap-note w2ap-info" role="status" aria-live="polite" data-testid="notice-toast" data-notice={e.notice}>
      <span className="w2ap-icon" aria-hidden="true">
        i
      </span>
      <div className="w2ap-body">
        <p>{t(e.notice ?? '')}</p>
      </div>
      <button type="button" className="icon-btn w2ap-close" onClick={() => dismiss(e.id)} aria-label={t('filesave.dismiss')} title={t('filesave.dismiss')} data-testid="save-note-dismiss">
        ✕
      </button>
    </div>
  );
}

export function SaveResultHost() {
  const list = useSyncExternalStore(subscribe, () => entries, () => entries);
  const lang = useDocumentLang();
  const ctx = { lang, t: makeT(lang), setLang: () => {}, n: numberFormatter(lang) };
  if (list.length === 0) return null;
  return (
    <I18nContext.Provider value={ctx}>
      <div className="w2ap-host" data-testid="save-toasts">
        {list.map((e) => (
          <HostItem key={e.id} e={e} />
        ))}
      </div>
    </I18nContext.Provider>
  );
}
