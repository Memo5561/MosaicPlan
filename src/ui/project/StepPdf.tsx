import { useState } from 'react';
import { DEFAULT_PDF_OPTIONS, PAPER, type PdfOptions } from '../../core/pdfOptions';
import { renderFull } from '../../core/render';
import { packMosaic } from '../../core/serialize';
import type { Material } from '../../core/types';
import { dictionaries, useI18n } from '../../i18n';
import { runWorker } from '../../workers/client';
import { Badge, downloadBlob, Field, NumberInput, ProgressBar, safeFileName, Segmented, Toggle } from '../components';
import { canvasToJpeg } from './imagePrep';
import type { ProjectApi } from './useProject';

export function StepPdf({ api, materials }: { api: ProjectApi; materials: Material[] }) {
  const { t, n, lang } = useI18n();
  const rec = api.rec!;
  const c = api.computed;
  const G = api.sections;
  const opts: PdfOptions = { ...DEFAULT_PDF_OPTIONS, ...(rec.pdfOptions ?? {}) };
  const setOpts = (p: Partial<PdfOptions>) => api.update((r) => ({ ...r, pdfOptions: { ...opts, ...p } }));
  const [busy, setBusy] = useState<{ f: number; label: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; size: number; pages?: number } | null>(null);
  if (!c || !G) return <p className="muted">{t('preview.notComputed')}</p>;

  const [pw, ph] = opts.format === 'custom' ? [opts.customW ?? 210, opts.customH ?? 297] : PAPER[opts.format];
  const sel = opts.sectionIds;
  const selected = G.sections.filter((s) => !sel || sel.includes(s.id));
  // Abschätzung Blattanzahl
  const PW = opts.orientation === 'portrait' ? Math.min(pw, ph) : Math.max(pw, ph);
  const PH = opts.orientation === 'portrait' ? Math.max(pw, ph) : Math.min(pw, ph);
  const printW = PW - 32;
  const printH = PH - 53;
  const sheets = selected.reduce((acc, s) => {
    if (opts.sheetScale <= 0) return acc + 1;
    return acc + Math.ceil((s.w * opts.sheetScale) / printW) * Math.ceil((s.h * opts.sheetScale) / printH);
  }, 0);
  const tooSmallCodes = Math.min(c.layout.tileW, c.layout.tileH) * (opts.sheetScale || 1) < 2.2;

  const generate = async () => {
    setErr(null);
    setResult(null);
    setBusy({ f: 0, label: 'images' });
    try {
      const prev = renderFull(c.layout, c.data, rec.palette, 2400, { groutHex: rec.settings.groutHex, realistic: true, surface: rec.settings.surface });
      const preview = { dataUrl: await canvasToJpeg(prev, 0.9), w: prev.width, h: prev.height };
      let original;
      const oc = api.originalPreview(1800);
      if (oc) original = { dataUrl: await canvasToJpeg(oc, 0.88), w: oc.width, h: oc.height };
      const res = await runWorker<'pdf'>(
        'pdf',
        {
          type: 'pdf',
          layoutParams: c.layoutParams,
          mosaic: packMosaic(c.data),
          palette: rec.palette,
          materials,
          settings: rec.settings,
          projectName: rec.meta.name,
          dateStr: new Date().toLocaleDateString(lang === 'de' ? 'de-DE' : lang === 'tr' ? 'tr-TR' : 'en-GB'),
          original,
          preview,
          dict: dictionaries[lang] as Record<string, string>,
          locale: lang,
          fontsBase: new URL('./', document.baseURI).href,
          options: opts,
        },
        [],
        (phase, f) => setBusy({ f, label: phase }),
      );
      const blob = new Blob([res.pdf], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      setResult({ url, size: blob.size });
      downloadBlob(blob, `${safeFileName(rec.meta.name)}_verlegeplan.pdf`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="two-col">
      <div>
        <Field label={t('pdfui.format')}>
          <Segmented
            value={opts.format}
            options={[
              { value: 'a4', label: 'A4' },
              { value: 'a3', label: 'A3' },
              { value: 'a2', label: 'A2' },
              { value: 'a1', label: 'A1' },
              { value: 'a0', label: 'A0' },
              { value: 'custom', label: t('pdfui.custom') },
            ]}
            onChange={(v) => setOpts({ format: v })}
          />
        </Field>
        {opts.format === 'custom' && (
          <div className="btn-row">
            <NumberInput value={opts.customW ?? 210} onChange={(v) => setOpts({ customW: v })} min={100} max={5000} suffix="mm" label={t('size.width')} />
            ×
            <NumberInput value={opts.customH ?? 297} onChange={(v) => setOpts({ customH: v })} min={100} max={5000} suffix="mm" label={t('size.height')} />
          </div>
        )}
        <Field label={t('pdfui.orientation')}>
          <Segmented
            value={opts.orientation}
            options={[
              { value: 'portrait', label: t('pdfui.portrait') },
              { value: 'landscape', label: t('pdfui.landscape') },
            ]}
            onChange={(v) => setOpts({ orientation: v })}
          />
        </Field>
        <Field label={t('pdfui.scale')} hint={t('pdfui.scaleHint')}>
          <Segmented
            value={opts.sheetScale}
            options={[
              { value: 1, label: '1:1' },
              { value: 2, label: '2:1' },
              { value: 3, label: '3:1' },
              { value: 4, label: '4:1' },
              { value: 0, label: t('pdfui.fit') },
            ]}
            onChange={(v) => setOpts({ sheetScale: v })}
          />
        </Field>
        {tooSmallCodes && <Badge kind="warn">{t('pdfui.codesTooSmall')}</Badge>}
        <Field label={t('pdfui.sections')}>
          <div className="btn-row wrap">
            <button className={`btn small ${!sel ? 'primary' : ''}`} onClick={() => setOpts({ sectionIds: null })}>
              {t('pdfui.allSections')} ({G.sections.length})
            </button>
            {G.sections.length <= 200 &&
              G.sections.map((s) => {
                const on = !sel || sel.includes(s.id);
                return (
                  <button
                    key={s.id}
                    className={`btn chip ${sel && on ? 'primary' : ''}`}
                    onClick={() => {
                      const cur = sel ?? [];
                      const next = sel && on ? cur.filter((x) => x !== s.id) : [...cur.filter((x) => x !== s.id), s.id];
                      setOpts({ sectionIds: next.length ? next : null });
                    }}
                  >
                    {s.id}
                  </button>
                );
              })}
          </div>
        </Field>
        <Toggle checked={opts.includeImages} onChange={(v) => setOpts({ includeImages: v })} label={t('pdfui.images')} />
        <Toggle checked={opts.includeTemplates} onChange={(v) => setOpts({ includeTemplates: v })} label={t('pdfui.templates')} />
        <Toggle checked={opts.includeCoords} onChange={(v) => setOpts({ includeCoords: v })} label={t('pdfui.coords')} />
        {opts.includeCoords && (
          <Field label={t('pdfui.coordLimit')} hint={t('pdfui.coordHint')}>
            <NumberInput value={opts.coordLimit} onChange={(v) => setOpts({ coordLimit: Math.round(v) })} min={0} max={2_000_000} width={90} />
          </Field>
        )}
      </div>
      <div>
        <h3>{t('pdfui.contents')}</h3>
        <ol className="small">
          {['cover', 'original', 'preview', 'overview', 'sheets', 'legend', 'materials', 'templates', 'coords', 'counts', 'pages'].map((k) => (
            <li key={k}>{t(`pdfui.c.${k}`)}</li>
          ))}
        </ol>
        <p>
          {t('pdfui.estimate', { s: selected.length, p: n(sheets) })}
          {sheets > 300 && <Badge kind="warn">{t('pdfui.many')}</Badge>}
        </p>
        <p className="muted small">{t('pdfui.printHint')}</p>
        <button className="btn primary big" disabled={!!busy} onClick={generate} data-testid="pdf-btn">
          {busy ? t('common.loading') : t('pdfui.generate')}
        </button>
        {busy && <ProgressBar value={busy.f} label={`${Math.round(busy.f * 100)} %`} />}
        {err && <p className="error">{err}</p>}
        {result && (
          <p data-testid="pdf-done">
            ✓ {t('pdfui.done', { kb: n(result.size / 1024, 0) })}{' '}
            <a href={result.url} target="_blank" rel="noreferrer">
              {t('pdfui.open')}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
