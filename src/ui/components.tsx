import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';

export function parseNum(s: string): number {
  return parseFloat(s.replace(',', '.').trim());
}

/** Zahleneingabe, akzeptiert Komma und Punkt; übernimmt Wert bei gültiger Eingabe. */
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
  const { lang } = useI18n();
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
  const v = parseNum(text);
  const invalid = !Number.isFinite(v) || (props.min !== undefined && v < props.min) || (props.max !== undefined && v > props.max);
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
          const nv = parseNum(e.target.value);
          if (Number.isFinite(nv) && (props.min === undefined || nv >= props.min) && (props.max === undefined || nv <= props.max)) props.onChange(nv);
        }}
      />
      {props.suffix && <span className="suffix">{props.suffix}</span>}
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

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="toggle-track" />
      <span>
        {props.label}
        {props.hint && <small className="muted block">{props.hint}</small>}
      </span>
    </label>
  );
}

export function Modal(props: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  const { t } = useI18n();
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [props]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{props.title}</h3>
          <button className="icon-btn" onClick={props.onClose} aria-label={t('common.close')}>
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

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function safeFileName(s: string) {
  return s.replace(/[^\p{L}\p{N}\-_ ]+/gu, '').trim().replace(/\s+/g, '_') || 'mosaicplan';
}
