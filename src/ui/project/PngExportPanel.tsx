/**
 * Vorschau als Bild (PNG) speichern (Paket w6-compare-batch): ganzes Mosaik, ein Abschnitt oder der gewählte Bereich,
 * lange Seite 2000/4000/8000 px (8000 nur am Desktop), höchstens 40 MP (Handy/APK 16 MP). Gezeichnet im eigenen
 * Worker wie die Vorschau; gespeichert über downloadBlob (im APK Documents/MosaicPlan bzw. Teilen-Menü).
 * Beschriftet als „Vorschau – kein maßstäblicher Plan“ (im Dialog und als Textfeld im PNG).
 */
import { useEffect, useRef, useState } from 'react';
import type { Layout, SectionGrid } from '../../core/layout';
import { mosaicRect, PNG_MAX_MP, PNG_MAX_MP_NATIVE, PNG_SIZES, pngSize, type WorldRect } from '../../core/previewPng';
import { rangeWorldRect } from '../../core/render';
import type { Range } from '../../core/stats';
import type { MosaicData, PaletteColor } from '../../core/types';
import { useI18n, type Lang } from '../../i18n';
import { isNative } from '../../platform';
import { downloadBlob, safeFileName, SaveResultNote, Segmented, type SaveResult } from '../components';
import type { PreviewPngRequest, PreviewPngResponse } from '../../workers/w6-preview-png.worker';
import { rangeLabel } from './BatchPanel';
import { useCoarsePointer } from './deviceKind';
import '../css/w6-compare-batch.css';

type Target = 'all' | 'section' | 'rect';

const FILE_WORD: Record<Lang, string> = {
  de: 'vorschau',
  en: 'preview',
  tr: 'onizleme',
};

export interface PngExportPanelProps {
  layout: Layout;
  data: MosaicData;
  palette: PaletteColor[];
  name: string;
  groutHex: string;
  surface: 'glass' | 'ceramic';
  realistic: boolean;
  codes: boolean;
  sections: SectionGrid | null;
  selection: Range | null;
  /** zuletzt gewählter Abschnitt (z. B. aus „Bereich bearbeiten“) */
  sectionId: string | null;
}

let seq = 1;

/** PNG im Worker zeichnen und kodieren */
function renderInWorker(req: Omit<PreviewPngRequest, 'id'>): Promise<{ png: ArrayBuffer; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    let w: Worker;
    try {
      w = new Worker(new URL('../../workers/w6-preview-png.worker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const id = seq++;
    w.onmessage = (ev: MessageEvent<PreviewPngResponse>) => {
      if (ev.data.id !== id) return;
      w.terminate();
      if (ev.data.ok)
        resolve({
          png: ev.data.png,
          width: ev.data.width,
          height: ev.data.height,
        });
      else reject(new Error(ev.data.message));
    };
    w.onerror = (e) => {
      e.preventDefault();
      w.terminate();
      reject(new Error(e.message || 'Worker'));
    };
    w.postMessage({ ...req, id } satisfies PreviewPngRequest);
  });
}

export function PngExportPanel(p: PngExportPanelProps) {
  const { t, n, lang } = useI18n();
  const coarse = useCoarsePointer();
  const native = isNative();
  const desktop = !native && !coarse;
  const maxMp = native || coarse ? PNG_MAX_MP_NATIVE : PNG_MAX_MP;
  const sizes = PNG_SIZES.filter((s) => s < 8000 || desktop);
  const [maxPx, setMaxPx] = useState<number>(4000);
  const px = sizes.includes(maxPx as (typeof PNG_SIZES)[number]) ? maxPx : sizes[sizes.length - 1];
  const [target, setTarget] = useState<Target>('all');
  const [secId, setSecId] = useState<string | null>(p.sectionId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    save: SaveResult;
    width: number;
    height: number;
  } | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    if (p.sectionId) setSecId(p.sectionId);
  }, [p.sectionId]);

  const sections = p.sections?.sections ?? [];
  const section = sections.find((s) => s.id === secId) ?? sections[0] ?? null;
  const tgt: Target = target === 'section' && !section ? 'all' : target === 'rect' && !p.selection ? 'all' : target;
  let rect: WorldRect = mosaicRect(p.layout);
  let suffix = '';
  if (tgt === 'section' && section) {
    const wr = rangeWorldRect(p.layout, section);
    if (wr) rect = { x: wr.x0, y: wr.y0, w: wr.x1 - wr.x0, h: wr.y1 - wr.y0 };
    suffix = `_${section.id}`;
  } else if (tgt === 'rect' && p.selection) {
    const wr = rangeWorldRect(p.layout, p.selection);
    if (wr) rect = { x: wr.x0, y: wr.y0, w: wr.x1 - wr.x0, h: wr.y1 - wr.y0 };
    suffix = `_${rangeLabel(p.layout, p.selection).replace('–', '-')}`;
  }
  const size = pngSize(rect, px, maxMp);
  const fileName = `${safeFileName(p.name)}${suffix}_${FILE_WORD[lang]}.png`;

  const save = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      // ohne Fotofarben (für das Bild ohne Bedeutung) – weniger zu kopieren
      const { targets: _omit, ...data } = p.data;
      void _omit;
      const out = await renderInWorker({
        layout: p.layout,
        data: data as MosaicData,
        palette: p.palette,
        rect,
        size,
        opt: {
          groutHex: p.groutHex,
          surface: p.surface,
          realistic: p.realistic,
          showCodes: p.codes,
        },
        text: [
          { keyword: 'Title', text: p.name },
          { keyword: 'Description', text: t('w6cb.png.label') },
          { keyword: 'Software', text: 'MosaicPlan' },
        ],
      });
      const r = await downloadBlob(new Blob([out.png], { type: 'image/png' }), fileName, { announce: false });
      if (alive.current) setResult({ save: r, width: out.width, height: out.height });
    } catch (e) {
      if (alive.current) setError(String((e as Error)?.message ?? e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className="w6cb-panel" data-testid="png-panel">
      <p className="small">
        <b>{t('w6cb.png.label')}</b> – {t('w6cb.png.hint')}
      </p>
      <div className="w6cb-row w6cb-wrap">
        <span className="w6cb-lbl">{t('w6cb.png.what')}</span>
        <Segmented<Target>
          value={tgt}
          onChange={setTarget}
          options={[
            { value: 'all', label: t('w6cb.scope.all') },
            ...(sections.length ? [{ value: 'section' as Target, label: t('w6cb.scope.section') }] : []),
            ...(p.selection ? [{ value: 'rect' as Target, label: t('w6cb.png.rect') }] : []),
          ]}
          testId="png-target"
        />
        {tgt === 'section' && (
          <select value={section?.id ?? ''} onChange={(e) => setSecId(e.target.value)} data-testid="png-section" aria-label={t('w6cb.section')}>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        )}
        {tgt === 'rect' && p.selection && <span className="small mono">{rangeLabel(p.layout, p.selection)}</span>}
      </div>
      <div className="w6cb-row w6cb-wrap">
        <span className="w6cb-lbl">{t('w6cb.png.size')}</span>
        <Segmented<number> value={px} onChange={setMaxPx} options={sizes.map((s) => ({ value: s, label: `${n(s)} px` }))} testId="png-size" />
      </div>
      <p className="small" data-testid="png-dims" data-w={size.width} data-h={size.height} data-cap={maxMp}>
        {t('w6cb.png.dims', {
          w: n(size.width),
          h: n(size.height),
          mp: n((size.width * size.height) / 1e6, 1),
          ppmm: n(size.pxPerMm, 2),
        })}
        {size.clamped && <span className="muted"> · {t('w6cb.png.clamped', { mp: n(maxMp) })}</span>}
        {!desktop && <span className="muted block">{t('w6cb.png.mobile', { mp: n(maxMp) })}</span>}
      </p>
      <div className="w6cb-row w6cb-wrap">
        <button type="button" className="btn primary small" onClick={() => void save()} disabled={busy} data-testid="png-save">
          {busy ? t('w6cb.png.busy') : t('w6cb.png.save')}
        </button>
        <small className="muted">{fileName}</small>
      </div>
      <small className="muted block">{t('w6cb.png.options')}</small>
      {error && (
        <p className="error small" role="alert" data-testid="png-error">
          {t('w6cb.png.error', { msg: error })}
        </p>
      )}
      {result && (
        <div data-testid="png-result" data-w={result.width} data-h={result.height}>
          <SaveResultNote result={result.save} />
        </div>
      )}
    </div>
  );
}
