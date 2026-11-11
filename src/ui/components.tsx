import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n, type Lang } from '../i18n';
import { isNative, saveNative, type SaveResult, type ShareMode } from '../platform';
import { getModalHistory, type ModalHandle } from './modalHistory';
import { announceSave } from './SaveResultNote';
import { parseLocaleNum, parseLocaleNumInfo } from './numberParse';
import './css/w1-touch-input-safety.css';

// Für Aufrufer von downloadBlob, die das Ergebnis selbst anzeigen
export { SaveResultNote } from './SaveResultNote';
export type { SaveResult } from '../platform';

// Dialog-Verlauf früh einrichten, damit ein nach dem Neuladen verwaister Dialog-Eintrag sofort bereinigt wird.
getModalHistory();

/**
 * Zahl aus einer Benutzereingabe (Standard: deutsche Schreibweise, „1.000,5“ = 1000,5).
 * Ungültige oder mehrdeutige Eingaben ergeben NaN – siehe parseLocaleNum in numberParse.ts.
 */
export function parseNum(s: string, lang: Lang = 'de'): number {
  return parseLocaleNum(s, lang);
}

/**
 * Zahleneingabe nach Sprache: DE/TR „1.000,5“, EN „1,000.5“; „12,5“ und „12.5“ gehen überall.
 * Übernimmt den Wert nur bei gültiger Eingabe. Wurden Tausendertrennzeichen oder Leerzeichen entfernt,
 * zeigt ein Hinweis den verstandenen Wert ohne Gruppierung (z. B. „→ 1000 cm“).
 */
export function NumberInput(props: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  width?: number;
  id?: string;
  label?: string;
  decimals?: number;
  testId?: string;
}) {
  const { lang, t } = useI18n();
  const fmt = (v: number) => {
    const d = Math.pow(10, props.decimals ?? 3);
    const s = String(Math.round(v * d) / d);
    return lang === 'en' ? s : s.replace('.', ',');
  };
  const [text, setText] = useState(() => fmt(props.value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(fmt(props.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.value]);
  const parsed = parseLocaleNumInfo(text, lang);
  const v = parsed.value;
  const invalid = !Number.isFinite(v) || (props.min !== undefined && v < props.min) || (props.max !== undefined && v > props.max);
  const readAs = parsed.regrouped && !invalid ? `${fmt(v)}${props.suffix ? ` ${props.suffix}` : ''}` : null;
  return (
    <span className={`numin ${invalid ? 'invalid' : ''}`}>
      <input
        id={props.id}
        aria-label={props.label}
        data-testid={props.testId}
        inputMode="decimal"
        value={text}
        style={props.width ? { width: props.width } : undefined}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          if (invalid) setText(fmt(props.value));
          else setText(fmt(v));
        }}
        onChange={(e) => {
          setText(e.target.value);
          const nv = parseLocaleNum(e.target.value, lang);
          if (Number.isFinite(nv) && (props.min === undefined || nv >= props.min) && (props.max === undefined || nv <= props.max)) props.onChange(nv);
        }}
      />
      {props.suffix && <span className="suffix">{props.suffix}</span>}
      {readAs && (
        <span className="numin-hint" role="status" title={t('num.readAs', { v: readAs })} data-testid={props.testId ? `${props.testId}-hint` : undefined}>
          → {readAs}
        </span>
      )}
    </span>
  );
}

export function Slider(props: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <label className="slider">
      <span className="slider-head">
        <span>{props.label}</span>
        <span className="muted">{props.format ? props.format(props.value) : props.value}</span>
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step ?? 1} value={props.value} onChange={(e) => props.onChange(parseFloat(e.target.value))} />
    </label>
  );
}

export function Segmented<T extends string | number>(props: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; testId?: string }) {
  return (
    <div className="segmented" role="radiogroup" data-testid={props.testId}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          className={o.value === props.value ? 'active' : ''}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean; testId?: string }) {
  return (
    <label className={`toggle ${props.disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} data-testid={props.testId} />
      <span className="toggle-track" />
      <span>
        {props.label}
        {props.hint && <small className="muted block">{props.hint}</small>}
      </span>
    </label>
  );
}

/**
 * Dialog. Jeder offene Dialog hat einen eigenen Verlaufseintrag (siehe modalHistory.ts): Zurück-Taste/-Geste
 * schließt zuerst den obersten Dialog, ✕/Esc/Hintergrund gehen über den Verlauf zurück, programmatisches
 * Schließen (Speichern, Abbrechen) entfernt den eigenen Eintrag wieder. Esc wirkt nur auf den obersten Dialog.
 * Der Hintergrund schließt nur, wenn Drücken und Loslassen beide auf dem Hintergrund lagen – ein verirrter
 * Maus-/Klick-Nachläufer einer Touch-Geste kann den Dialog so nicht schließen.
 */
export function Modal(props: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const { t } = useI18n();
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const handle = useRef<ModalHandle | null>(null);
  const downOnBackdrop = useRef(false);
  const upOnBackdrop = useRef(false);
  const requestClose = () => {
    if (handle.current) handle.current.requestClose();
    else onCloseRef.current();
  };
  useEffect(() => {
    const h = getModalHistory()?.register(() => onCloseRef.current()) ?? null;
    handle.current = h;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (h && !h.isTop()) return;
      if (h) h.requestClose();
      else onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (handle.current === h) handle.current = null;
      h?.release();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
        upOnBackdrop.current = false;
      }}
      onPointerUp={(e) => {
        upOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const ok = downOnBackdrop.current && upOnBackdrop.current && e.target === e.currentTarget;
        downOnBackdrop.current = false;
        upOnBackdrop.current = false;
        if (ok) requestClose();
      }}
    >
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{props.title}</h3>
          <button className="icon-btn" onClick={requestClose} aria-label={t('common.close')} data-testid="modal-close">
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function Swatch({ hex, size = 18, title }: { hex: string; size?: number; title?: string }) {
  return <span className="swatch" title={title ?? hex} style={{ background: hex, width: size, height: size }} />;
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  return (
    <div className="progress">
      <div className="progress-bar" style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
      {label && <span className="progress-label">{label}</span>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      <div className="field-control">{children}</div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function Badge({ kind, children }: { kind: 'ok' | 'warn' | 'info' | 'incomplete' | 'error'; children: ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

/**
 * Datei ausgeben. Im Browser als Download ({kind:'download'}); im APK über saveNative (Documents/MosaicPlan,
 * sonst Teilen-Menü) mit dem echten Ergebnis. Wirft im APK nie – Fehler stehen im Ergebnis.
 * Im APK erscheint das Ergebnis app-weit in der Meldungsleiste (SaveResultHost), außer mit
 * `announce: false` – dann zeigt der Aufrufer selbst eine <SaveResultNote result={…} /> an.
 */
export async function downloadBlob(blob: Blob, name: string, opts: { announce?: boolean; share?: ShareMode } = {}): Promise<SaveResult> {
  if (isNative()) {
    const r = await saveNative(blob, name, { share: opts.share });
    if (opts.announce !== false) announceSave(r);
    return r;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { kind: 'download', name };
}

/**
 * Dateinamensicherer Teil eines Downloads: nur ASCII-Buchstaben, Ziffern, „-“ und „_“ (Leerzeichen → „_“). Umlaute und
 * türkische Buchstaben werden umschrieben (ä → ae, ö → oe, ü → ue, ß → ss, ç → c, ğ → g, ı → i, İ → I, ş → s), andere
 * Akzente entfallen (é → e) – so kommen Namen auf jedem Gerät, in Mails und Archiven unverändert an.
 */
export function safeFileName(s: string) {
  const map: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', ẞ: 'SS', ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ş: 's', Ş: 'S', æ: 'ae', Æ: 'Ae', ø: 'o', Ø: 'O', œ: 'oe', Œ: 'Oe', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', þ: 'th', Þ: 'Th' };
  const ascii = s
    .replace(/[äöüÄÖÜßẞçÇğĞıİşŞæÆøØœŒłŁđĐþÞ]/g, (ch) => map[ch] ?? ch)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  return ascii.replace(/[^A-Za-z0-9\-_ ]+/g, '').trim().replace(/\s+/g, '_') || 'mosaicplan';
}
