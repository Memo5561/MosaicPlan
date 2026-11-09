/**
 * Rückgängig/Wiederholen in der Oberfläche (Paket w5-undo-editing): Knöpfe mit Zählern, Statuszeile und
 * Tastenkürzel (Strg/⌘+Z, Strg+Umschalt+Z, Strg+Y). Der Verlauf selbst liegt in useProject (core/journal.ts).
 */
import { useEffect, useRef, useState } from 'react';
import type { HistoryLabel } from '../../core/journal';
import { useI18n, type TFunc } from '../../i18n';
import type { HistoryEvent, ProjectApi } from './useProject';
import { isTypingTarget } from './previewPolicy';
import '../css/w5-undo-editing.css';

/** Text einer Verlaufsbeschriftung. Platzhalterwerte mit „t:“ am Anfang sind selbst Übersetzungsschlüssel. */
export function historyLabelText(l: HistoryLabel | null | undefined, t: TFunc): string {
  if (!l) return '';
  if (l.text) return l.text;
  if (!l.key) return '';
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(l.params ?? {})) params[k] = typeof v === 'string' && v.startsWith('t:') ? t(v.slice(2)) : v;
  return t(l.key, params);
}

/** Meldung zu einem Verlaufsereignis (Statuszeile) */
export function historyEventText(ev: HistoryEvent, t: TFunc): string {
  const what = historyLabelText(ev.label, t);
  switch (ev.kind) {
    case 'undo':
      return t('w4lw.undone', { what });
    case 'redo':
      return t('w5ue.redone', { what });
    case 'stale':
      return t(ev.entryType === 'palette' ? 'w5ue.stalePalette' : ev.dir === 'redo' ? 'w5ue.staleRedo' : 'w5ue.stale', { what });
    case 'too-large':
      return t('w5ue.tooLarge', { what });
  }
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

/** Tastenkürzel als Text („Strg+Z“ bzw. „⌘Z“) */
export function shortcutText(kind: 'undo' | 'redo', t: TFunc): string {
  if (isMac()) return kind === 'undo' ? '⌘Z' : '⇧⌘Z';
  return t(kind === 'undo' ? 'w5ue.keyUndo' : 'w5ue.keyRedo');
}

/** Fokus in einem Eingabefeld (dort gehört Strg+Z dem Feld) */
export function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const h = el as HTMLElement;
  if (h.isContentEditable) return true;
  if (h.tagName === 'SELECT') return true;
  return isTypingTarget(h as unknown as { tagName?: string; type?: string });
}

/** Ein anderer Dialog (z. B. Freiform-Editor mit eigenem Rückgängig) liegt oben – dann keine Kürzel */
function blockingDialogOpen(): boolean {
  const modals = document.querySelectorAll('.modal[aria-modal="true"]');
  const top = modals[modals.length - 1];
  return !!top && !top.querySelector('[data-w5ue-history]');
}

/**
 * Strg/⌘+Z = Rückgängig, Strg/⌘+Umschalt+Z und Strg+Y = Wiederholen – nicht, solange ein Eingabefeld den Fokus hat
 * oder ein anderer Dialog offen ist. Nur in den Schritten mit Rückgängig-Knöpfen eingebunden.
 */
export function useHistoryShortcuts(api: ProjectApi, enabled = true): void {
  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || !(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      const undo = k === 'z' && !e.shiftKey;
      const redo = (k === 'z' && e.shiftKey) || (k === 'y' && !e.shiftKey);
      if (!undo && !redo) return;
      if (isEditableTarget(document.activeElement) || isEditableTarget(e.target as Element | null)) return;
      if (blockingDialogOpen()) return;
      e.preventDefault();
      if (undo) apiRef.current.undo();
      else apiRef.current.redo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** Rückgängig/Wiederholen-Knöpfe mit Zählern; der Tooltip nennt den nächsten Schritt und das Tastenkürzel. */
export function HistoryButtons(props: { api: ProjectApi; testIdPrefix?: string; compact?: boolean }) {
  const { t, n } = useI18n();
  const h = props.api.history;
  const pre = props.testIdPrefix ?? 'history';
  const undoWhat = historyLabelText(h.undoLabel, t);
  const redoWhat = historyLabelText(h.redoLabel, t);
  const undoTitle = h.undoCount ? `${t('w5ue.undoNext', { what: undoWhat })} (${shortcutText('undo', t)})` : t('w5ue.undoNone');
  const redoTitle = h.redoCount ? `${t('w5ue.redoNext', { what: redoWhat })} (${shortcutText('redo', t)})` : t('w5ue.redoNone');
  return (
    <span className={`w5ue-history ${props.compact ? 'compact' : ''}`} role="group" aria-label={t('w5ue.historyAria')} data-w5ue-history="">
      <button
        type="button"
        className="btn small w5ue-hbtn"
        disabled={h.undoCount === 0 || h.locked}
        onClick={() => props.api.undo()}
        title={h.locked ? t('w2ws.lockedComputing') : undoTitle}
        aria-label={`${t('w4lw.undoLabel')} (${n(h.undoCount)})${h.undoCount ? ` – ${undoWhat}` : ''}`}
        data-testid={`${pre}-undo`}
      >
        ↶ <span className="w5ue-btxt">{t('w4lw.undoLabel')}</span> <span className="w5ue-count">({n(h.undoCount)})</span>
      </button>
      <button
        type="button"
        className="btn small w5ue-hbtn"
        disabled={h.redoCount === 0 || h.locked}
        onClick={() => props.api.redo()}
        title={h.locked ? t('w2ws.lockedComputing') : redoTitle}
        aria-label={`${t('w5ue.redoLabel')} (${n(h.redoCount)})${h.redoCount ? ` – ${redoWhat}` : ''}`}
        data-testid={`${pre}-redo`}
      >
        ↷ <span className="w5ue-btxt">{t('w5ue.redoLabel')}</span> <span className="w5ue-count">({n(h.redoCount)})</span>
      </button>
    </span>
  );
}

/** Statuszeile: was Rückgängig/Wiederholen zuletzt getan hat (verschwindet nach einigen Sekunden). */
export function HistoryStatus(props: { api: ProjectApi; testId?: string }) {
  const { t } = useI18n();
  const ev = props.api.history.last;
  const [shown, setShown] = useState<HistoryEvent | null>(null);
  const seen = useRef(ev?.seq ?? 0);
  useEffect(() => {
    if (!ev || ev.seq === seen.current) return;
    seen.current = ev.seq;
    setShown(ev);
    const h = window.setTimeout(() => setShown((x) => (x?.seq === ev.seq ? null : x)), ev.kind === 'stale' || ev.kind === 'too-large' ? 9000 : 6000);
    return () => window.clearTimeout(h);
  }, [ev]);
  const warn = !!shown && (shown.kind === 'stale' || shown.kind === 'too-large');
  return (
    <div className={`w5ue-hstatus ${shown ? 'on' : ''} ${warn ? 'warn' : ''}`} role={warn ? 'alert' : 'status'} aria-live="polite" data-testid={props.testId ?? 'history-status'} data-kind={shown?.kind ?? ''}>
      {shown ? historyEventText(shown, t) : ''}
    </div>
  );
}
