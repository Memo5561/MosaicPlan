import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Layout } from '../../core/layout';
import { paletteDisplayName } from '../../core/colorNames';
import { renderFull } from '../../core/render';
import type { MosaicData, PaletteColor } from '../../core/types';
import { useI18n } from '../../i18n';
import type { RawImage } from '../../workers/protocol';
import { Segmented } from '../components';
import { renderCropped } from './imagePrep';
import type { Step } from './stepNav';
import type { ProjectApi } from './useProject';
import '../css/w3-live-preview.css';

/**
 * Live-Vorschau der Schritte 2–7 (Paket w3-live-preview).
 *
 * Zeigt das Mosaik der AKTUELLEN Einstellungen, während Größe, Steine, Fuge, Farben und Formen gewählt werden.
 * Die Vorschau ist eine vollständige, exakte Berechnung (derselbe Rechenweg wie „Berechnen“), wird aber nie
 * gespeichert – erst „Vorschau übernehmen“ in Schritt 7 schreibt sie fest. Deshalb trägt sie dauerhaft das
 * Kennzeichen „Vorschau – noch nicht übernommen“. Während neu gerechnet wird, ist das alte Bild abgedunkelt
 * (mit Hinweis), damit ein veraltetes Bild nie aktuell wirkt. Unter dem Bild stehen nur exakte Rastermaße,
 * keine Stückzahlen je Farbe (die kommen ausschließlich aus dem gespeicherten Mosaik).
 */

/** Schritte mit Live-Vorschau */
export const PREVIEW_STEPS: readonly Step[] = ['size', 'tiles', 'joint', 'colors', 'shapes', 'compute'];

/** Längste Seite des Vorschaubilds in Pixeln */
const PREVIEW_PX = 640;
/** Höchstens so viele Farbfelder der Vorschau-Palette (Schritt 5) */
const SWATCH_MAX = 64;

const COLLAPSE_KEY = 'mp.w3lp.collapsed';

function readCollapsed(group: string): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}') as Record<string, boolean>;
    return v[group] === true;
  } catch {
    return false;
  }
}

function writeCollapsed(group: string, on: boolean) {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}') as Record<string, boolean>;
    v[group] = on;
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(v));
  } catch {
    /* nur Komfort */
  }
}

/** Kurzer, stabiler Kennwert eines Textes (FNV-1a) – für Tests und zum Erkennen eines neuen Bildes. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

interface Shown {
  /** 'preview': Vorschau · 'committed': gespeichertes Mosaik passt zu den Einstellungen · 'committed-old': gespeichertes, veraltetes Mosaik */
  kind: 'preview' | 'committed' | 'committed-old';
  layout: Layout;
  data: MosaicData;
  palette: PaletteColor[];
  processed: RawImage | HTMLCanvasElement | null;
  /** Kennwert des gezeigten Ergebnisses */
  key: string;
}

/**
 * Rahmen für einen Schritt mit Live-Vorschau: Inhalt links, Vorschau rechts (Desktop) bzw. klebend über den
 * Einstellungen (≤ 980 px). Die Vorschau lässt sich ausblenden (in Schritt 6 getrennt gemerkt, damit der
 * Bereichs-Editor dort genug Platz hat).
 */
export function PreviewLayout({ api, step, children }: { api: ProjectApi; step: Step; children: ReactNode }) {
  const group = step === 'shapes' ? 'shapes' : 'default';
  const [collapsedBy, setCollapsedBy] = useState<Record<string, boolean>>(() => ({ shapes: readCollapsed('shapes'), default: readCollapsed('default') }));
  const collapsed = collapsedBy[group] === true;
  const toggle = useCallback(() => {
    setCollapsedBy((m) => {
      const next = !m[group];
      writeCollapsed(group, next);
      return { ...m, [group]: next };
    });
  }, [group]);
  const empty = !api.bitmap;
  return (
    <div className={`w3lp-layout${collapsed ? ' w3lp-is-collapsed' : ''}${empty ? ' w3lp-is-empty' : ''}`} data-testid="live-preview-layout">
      <div className="w3lp-main">{children}</div>
      <LivePreview api={api} step={step} collapsed={collapsed} onToggle={toggle} />
    </div>
  );
}

export function LivePreview({ api, step, collapsed = false, onToggle }: { api: ProjectApi; step?: Step; collapsed?: boolean; onToggle?: () => void }) {
  const { t, n, lang } = useI18n();
  const { watchPreview } = api;
  // Nur solange die Vorschau angezeigt wird, rechnet sie
  // (ausgeblendet: keine Rechenlast – z. B. auf dem Handy in Schritt 6)
  useEffect(() => (collapsed ? undefined : watchPreview()), [watchPreview, collapsed]);
  const pv = api.preview;
  const rec = api.rec!;
  const [view, setView] = useState<'mosaic' | 'photo'>('mosaic');

  const computed = api.computed;
  const shown: Shown | null = useMemo(() => {
    if (pv.committedCurrent && computed) return { kind: 'committed', layout: computed.layout, data: computed.data, palette: rec.palette, processed: api.processed, key: `c:${rec.mosaicRev ?? ''}:${api.version}` };
    if (pv.result) return { kind: 'preview', layout: pv.result.layout, data: pv.result.data, palette: pv.result.palette, processed: pv.result.processed, key: `p:${shortHash(pv.result.sig)}` };
    if (computed) return { kind: 'committed-old', layout: computed.layout, data: computed.data, palette: rec.palette, processed: api.processed, key: `o:${rec.mosaicRev ?? ''}:${api.version}` };
    return null;
  }, [pv.committedCurrent, pv.result, computed, rec.palette, rec.mosaicRev, api.processed, api.version]);

  const outdated = !!shown && (shown.kind === 'committed-old' || (shown.kind === 'preview' && !pv.current));
  const blocked = !!pv.inputError || !!pv.error;
  const manual = outdated || !shown ? !pv.auto && !pv.runningCurrent && !pv.paused && !blocked : false;
  const waiting = (outdated || !shown) && pv.paused && !blocked;
  const updating = (outdated || !shown) && !manual && !waiting && !blocked;
  const state = pv.inputError ? 'input' : pv.error ? 'failed' : waiting ? 'paused' : manual ? 'manual' : updating ? 'updating' : 'ready';

  // ---------- Zeichnen
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const groutHex = rec.settings.groutHex;
  const surface = rec.settings.surface;
  const { bitmap, effectiveCrop } = api;
  const adjust = rec.adjust;
  const [photoKind, setPhotoKind] = useState<'processed' | 'crop' | null>(null);
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !shown || collapsed) return;
    let src: CanvasImageSource & { width: number; height: number };
    try {
      const mosaic = renderFull(shown.layout, shown.data, shown.palette, PREVIEW_PX, { groutHex, surface, realistic: true });
      src = mosaic;
      let pk: 'processed' | 'crop' | null = null;
      if (view === 'photo') {
        const W = mosaic.width;
        const H = mosaic.height;
        const p = shown.processed;
        if (p && 'data' in p) {
          const tmp = document.createElement('canvas');
          tmp.width = p.width;
          tmp.height = p.height;
          tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
          const out = document.createElement('canvas');
          out.width = W;
          out.height = H;
          const ctx = out.getContext('2d')!;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(tmp, 0, 0, W, H);
          src = out;
          pk = 'processed';
        } else if (p) {
          const out = document.createElement('canvas');
          out.width = W;
          out.height = H;
          out.getContext('2d')!.drawImage(p, 0, 0, W, H);
          src = out;
          pk = 'processed';
        } else if (bitmap && effectiveCrop) {
          src = renderCropped(bitmap, adjust, effectiveCrop, W, H);
          pk = 'crop';
        }
      }
      setPhotoKind(pk);
      cv.width = src.width;
      cv.height = src.height;
      const ctx = cv.getContext('2d')!;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(src, 0, 0);
    } catch (e) {
      // z. B. Foto inzwischen freigegeben – das nächste Ergebnis zeichnet neu
      console.warn('Vorschau konnte nicht gezeichnet werden', e);
    }
  }, [shown, view, groutHex, surface, collapsed, bitmap, effectiveCrop, adjust]);

  // Noch kein Mosaik: das Foto im aktuellen Zuschnitt (abgedunkelt, ausdrücklich als Foto gekennzeichnet)
  const photoRef = useRef<HTMLCanvasElement>(null);
  const curLayout = api.layout;
  useEffect(() => {
    const cv = photoRef.current;
    if (!cv || shown || collapsed || !bitmap || !effectiveCrop || !curLayout) return;
    try {
      const s = Math.min(PREVIEW_PX / curLayout.finishedW, PREVIEW_PX / curLayout.finishedH);
      const src = renderCropped(bitmap, adjust, effectiveCrop, Math.max(1, Math.round(curLayout.finishedW * s)), Math.max(1, Math.round(curLayout.finishedH * s)));
      cv.width = src.width;
      cv.height = src.height;
      cv.getContext('2d')!.drawImage(src, 0, 0);
    } catch (e) {
      console.warn('Foto konnte nicht gezeichnet werden', e);
    }
  }, [shown, collapsed, bitmap, effectiveCrop, curLayout, adjust]);

  // ---------- Texte
  const pct = pv.running ? Math.round(pv.running.fraction * 100) : null;
  const seconds = (ms: number) => n(Math.max(0.1, ms / 1000), 1);
  let status: ReactNode = null;
  if (pv.inputError) {
    status = <p className="muted small" data-testid="live-preview-input">{pv.inputError === 'no-photo' ? t('w3lp.noPhoto') : pv.inputError === 'layout' ? t('w3lp.layoutError') : t(`compute.err.${pv.inputError}`)}</p>;
  } else if (pv.error) {
    status = (
      <p className="error small" role="status" data-testid="live-preview-failed">
        {t('w3lp.failed', { msg: pv.error })}{' '}
        <button className="btn small" onClick={api.refreshPreview}>
          {t('w3lp.retry')}
        </button>
      </p>
    );
  } else if (waiting) {
    status = <p className="muted small" data-testid="live-preview-paused">{t('w3lp.paused')}</p>;
  } else if (manual) {
    status = (
      <div className="w3lp-manual" data-testid="live-preview-manual" data-reason={pv.reason ?? ''}>
        <p className="muted small">{pv.reason === 'slow' && pv.lastMs !== null ? t('w3lp.manual.slow', { s: seconds(pv.lastMs) }) : t('w3lp.manual.cells', { n: n(pv.cells) })}</p>
        <button className="btn small primary" onClick={api.refreshPreview} data-testid="live-preview-refresh">
          ↻ {t('w3lp.refresh')}
        </button>
        <small className="muted" data-testid="live-preview-estimate">
          {t('w3lp.estimate', { s: seconds(pv.estimateMs) })}
        </small>
      </div>
    );
  }

  const badge =
    shown?.kind === 'committed' ? (
      <span className="w3lp-badge w3lp-badge-ok" data-testid="live-preview-badge" data-kind="committed">
        {t('w3lp.badge.committed')}
      </span>
    ) : shown?.kind === 'committed-old' ? (
      <span className="w3lp-badge w3lp-badge-old" data-testid="live-preview-badge" data-kind="committed-old">
        {t('w3lp.badge.committedOld')}
      </span>
    ) : (
      <span className="w3lp-badge" data-testid="live-preview-badge" data-kind="preview">
        {t('w3lp.badge.preview')}
      </span>
    );

  const busyText = pct !== null ? t('w3lp.updatingPct', { pct }) : shown ? t('w3lp.updating') : t('w3lp.first');
  const layout = shown?.layout ?? api.layout;
  const aspect = layout ? `${layout.finishedW} / ${layout.finishedH}` : '4 / 3';

  return (
    <aside
      className={`w3lp${collapsed ? ' w3lp-collapsed' : ''}`}
      aria-label={t('w3lp.title')}
      data-testid="live-preview"
      data-state={state}
      data-kind={shown?.kind ?? 'none'}
      data-current={shown && !outdated ? '1' : '0'}
      data-key={shown?.key ?? ''}
    >
      <div className="w3lp-head">
        {/* Mit Bild sagt das Kennzeichen, was gezeigt wird („Vorschau – noch nicht übernommen“ / „Übernommenes Mosaik“) */}
        {!collapsed && shown ? badge : <span className="w3lp-title">{t('w3lp.title')}</span>}
        {onToggle && (
          <button
            type="button"
            className="btn small w3lp-toggle"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t('w3lp.show') : t('w3lp.hide')}
            title={collapsed ? t('w3lp.show') : t('w3lp.hide')}
            data-testid="live-preview-toggle"
          >
            <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
            <span className="w3lp-toggle-text">{collapsed ? t('w3lp.showShort') : t('w3lp.hideShort')}</span>
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="w3lp-body">
          {shown ? (
            <>
              <div className={`w3lp-stage${updating || waiting || manual ? ' w3lp-dim' : ''}`} style={{ aspectRatio: aspect }}>
                <canvas ref={canvasRef} className="w3lp-canvas" data-testid="live-preview-canvas" data-kind={shown.kind} data-key={shown.key} data-view={view} />
                {updating && (
                  <div className="w3lp-busy" role="status" data-testid="live-preview-busy">
                    <span className="w3lp-spinner" aria-hidden="true" />
                    <span>{busyText}</span>
                  </div>
                )}
                {outdated && !updating && <div className="w3lp-outdated small">{t('w3lp.outdated')}</div>}
              </div>
              <div className="w3lp-tools">
                <Segmented
                  value={view}
                  testId="live-preview-view"
                  options={[
                    { value: 'mosaic', label: t('w3lp.view.mosaic') },
                    { value: 'photo', label: t('w3lp.view.photo') },
                  ]}
                  onChange={setView}
                />
                {shown.kind === 'preview' && pv.current && pv.result && <small className="muted">{t('w3lp.took', { s: seconds(pv.result.ms) })}</small>}
              </div>
              {view === 'photo' && photoKind && <p className="muted small w3lp-note">{photoKind === 'processed' ? t('w3lp.photoProcessed') : t('w3lp.photoCrop')}</p>}
              {step === 'colors' && shown.kind === 'preview' && (
                // Farben, die die Vorschau gewählt hat – nur zur Ansicht (keine Stückzahlen; die Palette darunter gilt erst nach „Übernehmen“)
                <div className={`w3lp-swatches${outdated ? ' w3lp-stats-old' : ''}`} data-testid="live-preview-swatches" data-count={shown.palette.length}>
                  <span className="muted small">{t('w3lp.swatches', { n: shown.palette.length })}</span>
                  <div className="w3lp-swatch-row">
                    {shown.palette.slice(0, SWATCH_MAX).map((p) => (
                      <span key={p.code} className="w3lp-sw" style={{ background: p.hex }} title={`${String(p.code).padStart(2, '0')} · ${p.hex} · ${paletteDisplayName(p, lang)}`} />
                    ))}
                    {shown.palette.length > SWATCH_MAX && <span className="muted small">+{shown.palette.length - SWATCH_MAX}</span>}
                  </div>
                </div>
              )}
              <dl className={`w3lp-stats${outdated ? ' w3lp-stats-old' : ''}`} aria-label={t('w3lp.stats.label')} data-testid="live-preview-stats">
                <div>
                  <dt>{t('size.grid')}</dt>
                  <dd>
                    {n(shown.layout.cols)} × {n(shown.layout.rows)}
                  </dd>
                </div>
                <div>
                  <dt>{t('size.positions')}</dt>
                  <dd>{n(shown.layout.cols * shown.layout.rows)}</dd>
                </div>
                <div>
                  <dt>{t('size.finished')}</dt>
                  <dd>
                    {n(shown.layout.finishedW, 1)} × {n(shown.layout.finishedH, 1)} mm
                  </dd>
                </div>
              </dl>
              {status}
              <p className="muted small w3lp-note">{shown.kind === 'committed' ? t('w3lp.hintCommitted') : t('w3lp.hint')}</p>
            </>
          ) : (
            <>
              {!pv.inputError && (
                <div className="w3lp-stage w3lp-placeholder w3lp-dim" style={{ aspectRatio: aspect }}>
                  {api.bitmap && <canvas ref={photoRef} className="w3lp-canvas" data-testid="live-preview-photo" aria-hidden="true" />}
                  {updating ? (
                    <div className="w3lp-busy" role="status" data-testid="live-preview-busy">
                      <span className="w3lp-spinner" aria-hidden="true" />
                      <span>{busyText}</span>
                    </div>
                  ) : (
                    api.bitmap && <div className="w3lp-outdated small">{t('w3lp.photoOnly')}</div>
                  )}
                </div>
              )}
              {status}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
