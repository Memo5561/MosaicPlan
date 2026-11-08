import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isValidHex } from '../../core/color';
import {
  cellCoverage,
  cellGrid,
  groutCandidates,
  hexToLinear,
  linToSrgb8,
  mosaicCells,
  normHex,
  prepareFarModel,
  recommendGrout,
  targetLinear,
  worthSwitching,
  type CellGrid,
  type FarModel,
  type GroutScore,
} from '../../core/grout';
import { applyAdjustments } from '../../core/imageOps';
import { computeLayout, isLayoutError, jointShareOf, type Layout, type LayoutError } from '../../core/layout';
import { subdivisionCuttable } from '../../core/pieces';
import { useI18n, type TFunc } from '../../i18n';
import { Badge, Field, Modal, NumberInput, Segmented, Swatch } from '../components';
import '../css/w2-grout-preview.css';
import '../css/w3-face-guidance.css';
import { layoutParamsOf, type ProjectApi } from './useProject';
import { canvasToRaw, renderCropped, rotatedSize } from './imagePrep';
import { computedMatchesPhoto } from './staleReasons';
import { stepHash } from './stepNav';
import { FACE_GREEN_FROM, FACE_RED_BELOW, faceLight, faceRegionsOf, smallestFaceSpan, subStoneSize, tradeoffRows, type TradeoffRow } from './faceGuidance';

const UNIT_F = { mm: 1, cm: 10, m: 1000 } as const;

type NumFmt = (v: number, decimals?: number) => string;

/** Sehr große Zahlen (absurde Eingaben) nicht als hunderstellige Ziffernfolge ausgeben */
const bigNum = (v: number, n: NumFmt) => (v < 1e15 ? n(v) : v.toExponential(2));

/** Rasterfehler in der Sprache der Oberfläche (Rückfall: deutscher Text des Kerns) – Fehlertext und Handlungshinweis. */
export function layoutErrorText(e: LayoutError | Error, t: TFunc, n: NumFmt): { text: string; hint: string | null } {
  if (!isLayoutError(e)) return { text: e.message, hint: null };
  const p = e.params;
  const num = (k: string, d = 2) => (typeof p[k] === 'number' ? n(p[k] as number, d) : String(p[k] ?? ''));
  switch (e.code) {
    case 'invalidDims':
      return { text: t('layout.err.invalidDims'), hint: t('layout.hint.invalidDims') };
    case 'smallerThanTile': {
      const dim = t(p.axis === 'y' ? 'layout.dim.y' : 'layout.dim.x');
      const vals = { dim, len: num('length'), tile: num('tile'), min: num('minCut') };
      // „nur ganze Steine“: es fehlt ein ganzer Stein; mit Zuschnitt: auch die kleinste Randsteinbreite ist unterschritten
      return p.mode === 'whole'
        ? { text: t('layout.err.smallerThanTile', vals), hint: t('layout.hint.smallerThanTile', vals) }
        : { text: t('layout.err.smallerThanMinCut', vals), hint: t('layout.hint.smallerThanMinCut', vals) };
    }
    case 'tooManyCells':
      return {
        text: t('layout.err.tooManyCells', { cells: bigNum(Number(p.cells), n), cols: bigNum(Number(p.cols), n), rows: bigNum(Number(p.rows), n), max: n(Number(p.max)) }),
        hint: t('layout.hint.tooManyCells'),
      };
    default:
      return { text: e.message, hint: null };
  }
}

/** Rasterfehler der aktuellen Einstellungen: lokal neu berechnet, damit Code und Zahlen übersetzt werden können. */
function LayoutErrorBox({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  let err: Error | null = null;
  try {
    computeLayout(layoutParamsOf(api.rec!.settings));
  } catch (e) {
    err = e instanceof Error ? e : new Error(String(e));
  }
  // Ohne lokalen Fehler (sollte nicht vorkommen): den Text aus useProject zeigen
  const { text, hint } = err ? layoutErrorText(err, t, n) : { text: api.layoutError ?? '', hint: null };
  return (
    <div className="w3fg-layout-err" role="alert" data-testid="layout-error" data-code={err && isLayoutError(err) ? err.code : ''}>
      <p className="error">{text}</p>
      {hint && <p className="small">{hint}</p>}
    </div>
  );
}

/** zu Schritt 6 „Steinformen“ (eigener Verlaufseintrag; Workspace folgt der Adresse) */
const goStep = (api: ProjectApi, step: 'shapes' | 'compute') => {
  if (api.rec) location.hash = stepHash(api.rec.meta.id, step);
};

/**
 * „Detailgrad (Richtwert)“: wie viele Rasterpositionen über das (kleinste) markierte Gesicht gehen – exakt aus
 * dem Raster gezählt; nur die Ampel-Schwellen sind ein Richtwert. Ohne Gesichtsbereich ein neutraler Hinweis.
 */
function DetailMeter({ api, layout, withTradeoff }: { api: ProjectApi; layout: Layout; withTradeoff: boolean }) {
  const { t, n } = useI18n();
  const regions = api.rec!.regions;
  const info = smallestFaceSpan(layout, regions);
  const light = info ? faceLight(info.span.cols) : null;
  return (
    <div className="w3fg-detail" data-testid="detail-meter" data-light={light ?? 'none'}>
      <div className="w3fg-detail-head">
        <b>{t('w3fg.detail.title')}</b> <Badge kind="info">{t('w3fg.richtwert')}</Badge>
      </div>
      {info && light ? (
        <>
          <p className="w3fg-face-line">
            <span className={`w3fg-dot w3fg-${light}`} aria-hidden="true" />
            <b data-testid="face-span" data-cols={info.span.cols} data-rows={info.span.rows}>
              {t('w3fg.detail.face', { cols: n(info.span.cols), rows: n(info.span.rows) })}
            </b>
            <span className={`w3fg-light w3fg-${light}`}>{t(`w3fg.light.${light}`)}</span>
            <span className="muted small">{t('w3fg.detail.faceSize', { w: n(info.span.mmW / 10, 1), h: n(info.span.mmH / 10, 1) })}</span>
          </p>
          {info.count > 1 && <p className="muted small">{t('w3fg.detail.smallest', { n: info.count, i: info.index + 1 })}</p>}
          <p className="small">{t(`w3fg.reason.${light}`)}</p>
          {light !== 'green' && <p className="small">{t(withTradeoff ? 'w3fg.detail.moreHere' : 'w3fg.detail.moreSteps')}</p>}
          <details className="w3fg-how">
            <summary className="small">{t('w3fg.detail.howTitle')}</summary>
            <p className="muted small">{t('w3fg.detail.how')}</p>
          </details>
        </>
      ) : (
        <p className="muted small w3fg-noface" data-testid="detail-noface">
          {t('w3fg.detail.noFace')}{' '}
          <button className="btn small" onClick={() => goStep(api, 'shapes')} data-testid="detail-go-shapes">
            {t('w3fg.detail.goShapes')}
          </button>
        </p>
      )}
    </div>
  );
}

export function LayoutSummary({ api, withTradeoff = false }: { api: ProjectApi; withTradeoff?: boolean }) {
  const { t, n } = useI18n();
  const { layout, layoutError, rec } = api;
  if (rec && (layoutError || !layout)) return <LayoutErrorBox api={api} />;
  if (!layout || !rec) return null;
  const cells = layout.cols * layout.rows;
  const cutCols = Array.from(layout.colW).filter((w) => Math.abs(w - layout.tileW) > 1e-9).length;
  const cutRows = Array.from(layout.rowH).filter((h) => Math.abs(h - layout.tileH) > 1e-9).length;
  return (
    <div className="summary-box" data-testid="layout-summary">
      <div className="stat">
        <span>{t('size.grid')}</span>
        <b>
          {n(layout.cols)} × {n(layout.rows)}
        </b>
      </div>
      <div className="stat">
        <span>{t('size.positions')}</span>
        <b data-testid="grid-positions">{n(cells)}</b>
      </div>
      <div className="stat">
        <span>{t('size.finished')}</span>
        <b data-testid="finished-size">
          {n(layout.finishedW, 2)} × {n(layout.finishedH, 2)} mm
        </b>
      </div>
      <div className="stat">
        <span>{t('size.jointShare')}</span>
        <b>{n(jointShareOf(layout) * 100, 1)} %</b>
      </div>
      {(cutCols > 0 || cutRows > 0) && (
        <div className="stat">
          <span>{t('size.edgeCut')}</span>
          <b>
            {cutCols} {t('size.colsShort')} / {cutRows} {t('size.rowsShort')}
          </b>
        </div>
      )}
      {(layout.restX > 1e-6 || layout.restY > 1e-6) && (
        <div className="stat warn">
          <span>{t('size.rest')}</span>
          <b>
            {n(layout.restX, 2)} × {n(layout.restY, 2)} mm
          </b>
        </div>
      )}
      <p className="muted small">{t('size.formula', { w: n(layout.tileW, 2), g: n(layout.joint, 2) })}</p>
      {cells > 2_000_000 && <Badge kind="warn">{t('size.manyCells')}</Badge>}
      <DetailMeter api={api} layout={layout} withTradeoff={withTradeoff} />
    </div>
  );
}

/**
 * Vergleichstabelle Steingröße / Mosaikgröße – jede Zahl exakt aus computeLayout (siehe faceGuidance.ts).
 * „Übernehmen“ ändert nur die Einstellung; ist schon ein Mosaik berechnet, wird vorher nachgefragt.
 */
function TradeoffTable({ api }: { api: ProjectApi }) {
  const { t, n, lang } = useI18n();
  // Fugenanteil immer mit einer Nachkommastelle („36,0 %“ neben „30,4 %“)
  const locale = lang === 'de' ? 'de-DE' : lang === 'tr' ? 'tr-TR' : 'en-GB';
  const pct = (v: number) => (v * 100).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const rec = api.rec!;
  const s = rec.settings;
  const f = UNIT_F[s.unit];
  const rows = useMemo(
    () => tradeoffRows(s, rec.regions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.widthMm, s.heightMm, s.tileW, s.tileH, s.joint, s.edgeMode, s.minCutMm, rec.regions],
  );
  const [pending, setPending] = useState<TradeoffRow | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const hasFace = faceRegionsOf(rec.regions).length > 0;
  const label = (r: TradeoffRow) =>
    r.kind === 'width'
      ? t('w3fg.to.size', { w: n(r.widthMm / f, 2), h: n(r.heightMm / f, 2), unit: s.unit, f: n(r.factor ?? 1, 1) })
      : t('w3fg.to.tile', { w: n(r.tileW, 2), h: n(r.tileH, 2) });
  const doApply = (r: TradeoffRow) => {
    api.setSettings(r.patch);
    setApplied(label(r));
  };
  const placed = api.progress?.total.placed ?? 0;
  const edits = api.manualEdits;
  const pal = api.paletteEdits;
  return (
    <section className="w3fg-to" data-testid="tradeoff">
      <h4>{t('w3fg.to.title')}</h4>
      <p className="muted small">{t('w3fg.to.intro', { g: n(s.joint, 2) })}</p>
      <div className="table-wrap">
        <table className="data w3fg-to-table">
          <thead>
            <tr>
              <th>{t('w3fg.to.col.option')}</th>
              <th className="num">{t('w3fg.to.col.cells')}</th>
              <th className="num">{t('w3fg.to.col.joint')}</th>
              {hasFace && <th className="num">{t('w3fg.to.col.face')}</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const res = r.result;
              return (
                <tr key={r.key} className={r.isCurrent ? 'w3fg-current' : ''} data-testid={`to-${r.key}`} data-cells={res.ok ? res.cells : ''}>
                  <td className="w3fg-c-label">
                    <span className="w3fg-to-label">{label(r)}</span>
                    {r.isCurrent && <span className="w3fg-tag">{t('w3fg.to.current')}</span>}
                    {res.ok && (res.tiny || res.highJoint) && (
                      <span className="w3fg-flags">
                        {res.tiny && <Badge kind="warn">{t('w3fg.to.flag.tiny')}</Badge>}
                        {res.highJoint && <Badge kind="warn">{t('w3fg.to.flag.highJoint')}</Badge>}
                      </span>
                    )}
                    {!res.ok && (
                      <span className="w3fg-to-err small" title={layoutErrorText(res.error, t, n).text}>
                        {isLayoutError(res.error)
                          ? `${t('w3fg.to.notPossible')}: ${t(`w3fg.to.err.${res.error.code}`, { cells: bigNum(Number(res.error.params.cells ?? 0), n) })}`
                          : res.error.message}
                      </span>
                    )}
                  </td>
                  <td className="num w3fg-c-num" data-label={t('w3fg.to.col.cells')}>
                    {res.ok ? (
                      <>
                        {n(res.cells)}
                        <span className="w3fg-grid muted">
                          {n(res.cols)} × {n(res.rows)}
                        </span>
                      </>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td className="num w3fg-c-num" data-label={t('w3fg.to.col.joint')}>
                    {res.ok ? `${pct(res.jointShare)} %` : '–'}
                  </td>
                  {hasFace && (
                    <td className="num w3fg-c-num" data-label={t('w3fg.to.col.face')}>
                      {res.ok && res.face && res.light ? (
                        <span className="w3fg-face-cell" data-light={res.light} title={t(`w3fg.light.${res.light}`)}>
                          <span className={`w3fg-dot w3fg-${res.light}`} aria-hidden="true" />
                          {n(res.face.cols)}
                          <span className="sr-only"> ({t(`w3fg.light.${res.light}`)})</span>
                        </span>
                      ) : (
                        '–'
                      )}
                    </td>
                  )}
                  <td className="w3fg-c-act">
                    {!r.isCurrent && res.ok && (
                      <button className="btn small" onClick={() => (api.computed ? setPending(r) : doApply(r))} data-testid={`to-apply-${r.key}`}>
                        {t('common.apply')}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasFace && (
        <p className="muted small">
          <span className="w3fg-dot w3fg-red" aria-hidden="true" /> &lt; {FACE_RED_BELOW} · <span className="w3fg-dot w3fg-yellow" aria-hidden="true" /> {FACE_RED_BELOW}–{FACE_GREEN_FROM - 1} ·{' '}
          <span className="w3fg-dot w3fg-green" aria-hidden="true" /> ≥ {FACE_GREEN_FROM} ({t('w3fg.richtwert')})
        </p>
      )}
      {applied && (
        <p className="small w3fg-applied" role="status" data-testid="to-applied">
          {t('w3fg.to.applied', { what: applied })}
        </p>
      )}
      {pending && (
        <Modal
          title={t('w3fg.to.confirm.title')}
          onClose={() => setPending(null)}
          footer={
            <>
              <button className="btn" onClick={() => setPending(null)} data-testid="to-confirm-cancel">
                {t('common.cancel')}
              </button>
              <button
                className="btn primary"
                data-testid="to-confirm"
                onClick={() => {
                  const r = pending;
                  setPending(null);
                  doApply(r);
                }}
              >
                {t('common.apply')}
              </button>
            </>
          }
        >
          <p>{t('w3fg.to.confirm.text', { what: label(pending) })}</p>
          <p className="small">{placed > 0 || edits > 0 || pal > 0 ? t('w3fg.to.confirm.keep', { placed: n(placed), edits: n(edits), pal: n(pal) }) : t('w3fg.to.confirm.keepNone')}</p>
        </Modal>
      )}
    </section>
  );
}

/** Ehrlicher Hinweis zu gemischten Steingrößen (Anforderung 18: Unvollständiges als unvollständig markieren). */
function MixedSizesNote({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const sz = (tile: number, k: number) => {
    const v = subStoneSize(tile, s.joint, k);
    return v > 0 ? n(v, 2) : '–';
  };
  // dieselbe Prüfung wie Berechnung und Schritt 6 (Mindestbreite eines Schnittteils)
  const tile = { x: 0, y: 0, w: s.tileW, h: s.tileH };
  const tooSmall = [2, 3].filter((k) => !subdivisionCuttable(tile, k, s.joint, s.shapes.minPieceMm)).map((k) => `${k}×${k}`);
  return (
    <div className="note w3fg-mixed" data-testid="mixed-sizes">
      <p className="small">{t('tiles.mixedHint')}</p>
      <p className="small">
        <Badge kind="incomplete">{t('common.incomplete')}</Badge> {t('w3fg.tiles.mixedIncomplete')}
      </p>
      <p className="small muted" data-testid="sub-sizes">
        {t('w3fg.tiles.subSizes', { w: n(s.tileW, 2), h: n(s.tileH, 2), g: n(s.joint, 2), a2: sz(s.tileW, 2), b2: sz(s.tileH, 2), a3: sz(s.tileW, 3), b3: sz(s.tileH, 3) })}
      </p>
      {tooSmall.length > 0 && (
        <p className="small w3fg-msg-warn" data-testid="sub-too-narrow">
          {t('w3fg.tiles.subTooNarrow', { k: tooSmall.join(' / '), min: n(s.shapes.minPieceMm, 2) })}
        </p>
      )}
    </div>
  );
}

export function StepSize({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const f = UNIT_F[s.unit];
  const presets: [number, number][] = [
    [30, 40],
    [40, 40],
    [50, 70],
    [60, 90],
    [100, 100],
    [200, 100],
    [300, 200],
    [500, 300],
    [1000, 500],
  ];
  // Maße des Originals (sourceSize), nicht der evtl. verkleinerten Arbeitskopie – sonst weicht
  // „Höhe aus Foto“ durch Rundung der Arbeitskopie um bis zu 0,02 % ab
  const photoAspect = api.bitmap ? (() => {
    const r = rotatedSize(api.sourceSize?.w ?? api.bitmap.width, api.sourceSize?.h ?? api.bitmap.height, api.rec!.adjust);
    const c = api.rec!.adjust.crop;
    return c ? (c.w * r.w) / (c.h * r.h) : r.w / r.h;
  })() : null;
  return (
    <div className="two-col">
      <div>
        <Field label={t('size.unit')}>
          <Segmented value={s.unit} options={[{ value: 'mm', label: 'mm' }, { value: 'cm', label: 'cm' }, { value: 'm', label: 'm' }]} onChange={(u) => api.setSettings({ unit: u })} />
        </Field>
        <Field label={t('size.width')}>
          <NumberInput value={s.widthMm / f} onChange={(v) => api.setSettings({ widthMm: v * f })} min={0.1} suffix={s.unit} testId="width-input" decimals={4} />
        </Field>
        <Field label={t('size.height')}>
          <NumberInput value={s.heightMm / f} onChange={(v) => api.setSettings({ heightMm: v * f })} min={0.1} suffix={s.unit} testId="height-input" decimals={4} />
        </Field>
        {photoAspect && (
          <div className="btn-row wrap">
            <button className="btn small" onClick={() => api.setSettings({ heightMm: Math.round((s.widthMm / photoAspect) * 10) / 10 })}>
              {t('size.heightFromPhoto')}
            </button>
            <button className="btn small" onClick={() => api.setSettings({ widthMm: Math.round(s.heightMm * photoAspect * 10) / 10 })}>
              {t('size.widthFromPhoto')}
            </button>
            <button className="btn small" onClick={() => api.setSettings({ widthMm: s.heightMm, heightMm: s.widthMm })}>
              ⇄ {t('size.swap')}
            </button>
          </div>
        )}
        <h4>{t('size.presets')}</h4>
        <div className="btn-row wrap">
          {presets.map(([w, h]) => (
            <button key={`${w}x${h}`} className="btn small" onClick={() => api.setSettings({ widthMm: w * 10, heightMm: h * 10 })}>
              {w} × {h} cm
            </button>
          ))}
        </div>
        <Field label={t('size.edgeMode')} hint={t(`size.edge.${s.edgeMode}.hint`)}>
          <Segmented
            value={s.edgeMode}
            options={[
              { value: 'whole', label: t('size.edge.whole') },
              { value: 'cut-end', label: t('size.edge.cut-end') },
              { value: 'cut-both', label: t('size.edge.cut-both') },
            ]}
            onChange={(v) => api.setSettings({ edgeMode: v })}
          />
        </Field>
        <Field label={t('size.minCut')}>
          <NumberInput value={s.minCutMm} onChange={(v) => api.setSettings({ minCutMm: v })} min={0.5} max={20} suffix="mm" />
        </Field>
        <p className="muted small">
          {t('size.area')}: {n((s.widthMm * s.heightMm) / 1e6, 4)} m²
        </p>
      </div>
      <div>
        <LayoutSummary api={api} withTradeoff />
        <TradeoffTable api={api} />
        <p className="muted small">{t('size.originHint')}</p>
      </div>
    </div>
  );
}

export function StepTiles({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const sizes = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const custom: [number, number][] = [
    [3, 5],
    [4, 8],
    [6, 10],
    [8, 12],
  ];
  const outOfRange = s.tileW < 2 || s.tileW > 12 || s.tileH < 2 || s.tileH > 12;
  return (
    <div className="two-col">
      <div>
        <h4>{t('tiles.square')}</h4>
        <div className="btn-row wrap" data-testid="tile-presets">
          {sizes.map((v) => (
            <button key={v} className={`btn chip ${s.tileW === v && s.tileH === v ? 'primary' : ''}`} onClick={() => api.setSettings({ tileW: v, tileH: v })}>
              {v} × {v} mm
            </button>
          ))}
        </div>
        <h4>{t('tiles.rect')}</h4>
        <div className="btn-row wrap">
          {custom.map(([w, h]) => (
            <button key={`${w}x${h}`} className={`btn chip ${s.tileW === w && s.tileH === h ? 'primary' : ''}`} onClick={() => api.setSettings({ tileW: w, tileH: h })}>
              {w} × {h} mm
            </button>
          ))}
        </div>
        <h4>{t('tiles.custom')}</h4>
        <div className="btn-row">
          <NumberInput value={s.tileW} onChange={(v) => api.setSettings({ tileW: v })} min={0.5} max={100} suffix="mm" label={t('tiles.w')} testId="tile-w" />
          <span>×</span>
          <NumberInput value={s.tileH} onChange={(v) => api.setSettings({ tileH: v })} min={0.5} max={100} suffix="mm" label={t('tiles.h')} testId="tile-h" />
        </div>
        {outOfRange && <Badge kind="warn">{t('tiles.outOfRange')}</Badge>}
        <Field label={t('tiles.surface')}>
          <Segmented value={s.surface} options={[{ value: 'glass', label: t('mat.glass') }, { value: 'ceramic', label: t('mat.ceramic') }]} onChange={(v) => api.setSettings({ surface: v })} />
        </Field>
        <MixedSizesNote api={api} />
        <p className="muted small">{t('tiles.materialHint')}</p>
      </div>
      <div>
        <LayoutSummary api={api} withTradeoff />
        <p className="muted small">
          {t('tiles.pitch')}: {n(s.tileW + s.joint, 2)} × {n(s.tileH + s.joint, 2)} mm
        </p>
        <TradeoffTable api={api} />
      </div>
    </div>
  );
}

export function StepJoint({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const presets = [0, 0.5, 1, 1.5, 2, 3];
  // Vergleich: wie viele Steine passen ohne Fugenberücksichtigung (falsche Rechnung) vs. korrekt
  let naive: number | null = null;
  try {
    const L = computeLayout({ ...layoutParamsOf(s), edgeMode: 'whole' });
    const naiveCols = Math.floor(s.widthMm / s.tileW);
    naive = naiveCols - L.cols;
  } catch {
    naive = null;
  }
  return (
    <div className="two-col">
      <div>
        <h4>{t('joint.width')}</h4>
        <div className="btn-row wrap" data-testid="joint-presets">
          {presets.map((v) => (
            <button key={v} className={`btn chip ${s.joint === v ? 'primary' : ''}`} onClick={() => api.setSettings({ joint: v })}>
              {n(v, 1)} mm
            </button>
          ))}
        </div>
        <Field label={t('joint.custom')}>
          <NumberInput value={s.joint} onChange={(v) => api.setSettings({ joint: v })} min={0} max={20} suffix="mm" testId="joint-input" />
        </Field>
        <Field label={t('joint.color')} hint={t('grout.dryHint')}>
          <GroutColorInput value={s.groutHex} onChange={(hex) => api.setSettings({ groutHex: hex })} />
        </Field>
        <GroutAdvice api={api} />
        <Field label={t('joint.depth')} hint={t('joint.depthHint')}>
          <NumberInput value={s.groutDepthMm} onChange={(v) => api.setSettings({ groutDepthMm: v })} min={0} max={30} suffix="mm" />
        </Field>
        {naive !== null && naive > 0 && <p className="muted small">{t('joint.naive', { n: naive })}</p>}
      </div>
      <div>
        <LayoutSummary api={api} />
      </div>
    </div>
  );
}

/** Fugenfarbe: Farbwähler plus HEX-Feld (für den gemessenen Wert einer getrockneten Probe). */
function GroutColorInput({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  const valid = isValidHex(text);
  const pickerValue = isValidHex(value) ? normHex(value).toLowerCase() : '#bdb8ae';
  return (
    <span className="gp-color">
      <input type="color" value={pickerValue} onChange={(e) => onChange(e.target.value.toUpperCase())} aria-label={t('joint.color')} data-testid="grout-color" />
      <input
        className={`gp-hex ${valid ? '' : 'invalid'}`}
        value={text}
        spellCheck={false}
        autoCapitalize="characters"
        autoComplete="off"
        aria-label={t('grout.hex')}
        aria-invalid={!valid}
        data-testid="grout-hex"
        maxLength={7}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          // Kurzform (#ABC) erst beim Verlassen übernehmen; Ungültiges verwerfen
          if (isValidHex(text) && normHex(text) !== normHex(value)) {
            const hex = normHex(text);
            onChange(hex);
            setText(hex);
          } else setText(value);
        }}
        onChange={(e) => {
          const v = e.target.value.trim();
          setText(v);
          // nur vollständige sechsstellige Werte übernehmen (die dreistellige Kurzform nicht schon beim Tippen)
          if (isValidHex(v) && v.replace('#', '').length === 6) onChange(normHex(v));
        }}
      />
      {!valid && (
        <span className="gp-hex-err" role="alert">
          {t('grout.hexInvalid')}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- Fugenfarben-Empfehlung (Schätzung)

/** Höchstens so viele Felder im Fernwirkungs-Modell der Oberfläche (große Projekte: k × k Zellen je Feld). */
const ADVICE_MAX_FIELDS = 160_000;

interface PhotoModel {
  key: string;
  layout: Layout;
  grid: CellGrid;
  /** Fotofarbe je Feld (linear) und Steinbedeckung bei ganzen Steinen */
  target: Float32Array;
  coverage: Float32Array;
  ideal: FarModel;
}
interface StoneModel {
  key: string;
  coverage: Float32Array;
  stones: Float32Array;
  model: FarModel;
}

const nextTick = () => new Promise<void>((res) => window.setTimeout(res, 0));

/**
 * Foto des Zuschnitts in etwa 2 Pixeln je Feld (höchstens Quellauflösung), mit den globalen Farb- und
 * Tonwerteinstellungen (Weißabgleich, Tonwerte, Helligkeit, Kontrast, Sättigung) wie in der Berechnung.
 * Lokale Filter (Schärfe, Details, Hintergrund) ändern die Fernwirkung kaum und entfallen hier.
 * Liest das Foto nur (renderCropped zeichnet in ein neues Canvas).
 */
function photoForGrid(api: ProjectApi, grid: CellGrid) {
  const bmp = api.bitmap!;
  const adj = api.rec!.adjust;
  const crop = api.effectiveCrop!;
  const r = rotatedSize(bmp.width, bmp.height, adj);
  const cw = Math.max(1, crop.w * r.w);
  const ch = Math.max(1, crop.h * r.h);
  const pw = Math.max(8, Math.round(Math.min(cw, grid.w * 2)));
  const ph = Math.max(8, Math.round(Math.min(ch, grid.h * 2)));
  const raw = canvasToRaw(renderCropped(bmp, adj, crop, pw, ph));
  return applyAdjustments(raw, { ...adj, crop: null, sharpen: 0, detailBoost: 0, bgSimplify: 0 }, []);
}

function useGroutAdvice(api: ProjectApi) {
  const rec = api.rec!;
  const lpKey = JSON.stringify(layoutParamsOf(rec.settings));
  const c = api.effectiveCrop;
  // mit der Foto-Identität: das Modell eines früheren Fotos wird nie für ein neues verwendet
  const photoKey = api.bitmap && api.layout && c ? `${rec.imageRev ?? ''}|${lpKey}|${JSON.stringify(rec.adjust)}|${c.x},${c.y},${c.w},${c.h}` : '';
  const [photo, setPhoto] = useState<PhotoModel | null>(null);
  const [stone, setStone] = useState<StoneModel | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const bitmap = api.bitmap;

  // 1) Foto-Modell: neu bei anderem Foto, Zuschnitt, Bildeinstellungen oder Raster – nicht bei der Fugenfarbe
  useEffect(() => {
    if (!photoKey) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const a = apiRef.current;
        const layout = a.layout!;
        const grid = cellGrid(layout, ADVICE_MAX_FIELDS);
        const img = photoForGrid(a, grid);
        await nextTick();
        if (cancelled) return;
        const target = targetLinear(img, layout, grid);
        const coverage = cellCoverage(layout, null, grid);
        await nextTick();
        if (cancelled) return;
        const ideal = prepareFarModel({ w: grid.w, h: grid.h, target, stones: null, coverage, k: grid.k });
        if (!cancelled) setPhoto({ key: photoKey, layout, grid, target, coverage, ideal });
      } catch (e) {
        console.warn('Fernwirkung: Schätzung fehlgeschlagen', e);
        if (!cancelled) setFailedKey(photoKey);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [photoKey, bitmap]);
  const photoNow = photo && photo.key === photoKey ? photo : null;

  // 2) Berechnetes Mosaik: nur wenn sein Raster dem aktuellen entspricht (sonst wäre es ein anderes Mosaik) UND es
  //    aus diesem Foto mit diesem Zuschnitt und diesen Bildeinstellungen berechnet wurde – sonst verglichen wir die
  //    alten Steine mit einem Bild, aus dem sie nie berechnet wurden (eine Zahl ohne Bedeutung).
  const computed = api.computed;
  const sameGrid = !!computed && JSON.stringify(computed.layoutParams) === lpKey;
  const samePhoto = !!computed && computedMatchesPhoto(rec);
  const useStones = sameGrid && samePhoto;
  const palette = rec.palette;
  const version = api.version;
  const [stoneFailedKey, setStoneFailedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!photoNow || !computed || !useStones) return;
    let cancelled = false;
    const key = `${photoNow.key}|${version}`;
    const timer = window.setTimeout(() => {
      try {
        const mc = mosaicCells(computed.layout, computed.data, palette, photoNow.grid);
        const model = prepareFarModel({ w: photoNow.grid.w, h: photoNow.grid.h, target: photoNow.target, stones: mc.stones, coverage: mc.coverage, k: photoNow.grid.k });
        if (!cancelled) setStone({ key, coverage: mc.coverage, stones: mc.stones, model });
      } catch (e) {
        console.warn('Fernwirkung des Mosaiks: Schätzung fehlgeschlagen', e);
        if (!cancelled) setStoneFailedKey(key);
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [photoNow, computed, useStones, palette, version]);
  const stoneKey = `${photoKey}|${version}`;
  const stoneNow = stone && useStones && stone.key === stoneKey ? stone : null;
  const stoneFailed = useStones && stoneFailedKey === stoneKey;

  // 3) Rangliste (billig): alle Kandidaten + aktuelle Farbe – mit EINEM Modell für Empfehlung, Liste und Abdeckung:
  //    die berechneten Steine (Farben und Schnittteile), solange das berechnete Mosaik zu Raster und Foto passt,
  //    sonst ideale ganze Steine in Fotofarbe. Solange das Steinmodell noch entsteht: „wird geschätzt …“.
  const groutHex = rec.settings.groutHex;
  const basis: 'stones' | 'ideal' | null = !photoNow ? null : useStones && !stoneFailed ? (stoneNow ? 'stones' : null) : 'ideal';
  const model = basis === 'stones' ? stoneNow!.model : basis === 'ideal' ? photoNow!.ideal : null;
  const ranked = useMemo(() => (model ? recommendGrout(model, groutCandidates(groutHex)) : null), [model, groutHex]);

  return {
    hasPhoto: !!api.bitmap,
    failed: !!photoKey && failedKey === photoKey,
    photo: photoNow,
    stone: stoneNow,
    ranked,
    /** Grundlage von Empfehlung, Liste und Abdeckung */
    basis,
    /** mittlere Abdeckung der Steine im verwendeten Modell (0…1) */
    coverage: model ? model.meanCoverage : null,
    computedOtherGrid: !!computed && !sameGrid,
    computedOtherPhoto: !!computed && sameGrid && !samePhoto,
  };
}

function GroutAdvice({ api }: { api: ProjectApi }) {
  const { t, n, lang } = useI18n();
  const adv = useGroutAdvice(api);
  const groutHex = normHex(api.rec!.settings.groutHex);
  const name = (sc: { key: string }) => (sc.key === 'current' ? t('grout.c.current') : t(`grout.c.${sc.key}`));
  // ΔE immer mit genau einer Nachkommastelle („5,0“ neben „4,9“, nicht „5“)
  const locale = lang === 'de' ? 'de-DE' : lang === 'tr' ? 'tr-TR' : 'en-GB';
  const de = (v: number) => (Number.isFinite(v) ? v.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '–');
  const apply = (hex: string) => api.setSettings({ groutHex: hex });

  let body: ReactNode;
  if (!adv.hasPhoto) body = <p className="muted small">{t('grout.noPhoto')}</p>;
  else if (adv.failed) body = <p className="muted small">{t('grout.error')}</p>;
  else if (!adv.ranked || !adv.photo || !adv.basis)
    body = (
      <p className="muted small" data-testid="grout-busy">
        {t('grout.busy')}
      </p>
    );
  else if (adv.photo.ideal.meanCoverage > 0.9995)
    // ohne Fuge (0 mm) bedecken die Steine alles: die Fugenfarbe ändert die Fernwirkung nicht
    body = (
      <p className="muted small" data-testid="grout-recommendation" data-switch="0">
        {t('grout.noJoint')}
      </p>
    );
  else {
    const ranked = adv.ranked;
    const best = ranked[0];
    const current = ranked.find((r) => r.hex === groutHex) ?? null;
    const switchIt = !!current && best.hex !== groutHex && worthSwitching(current, best);
    // praktisch gleich gut (Rundung der Anzeige): die aktuelle Farbe gilt als beste
    const otherBest = best.hex !== groutHex && !(current && current.mean - best.mean < 0.05);
    body = (
      <>
        {switchIt && current ? (
          <div className="gp-rec" data-testid="grout-recommendation" data-best={best.hex} data-switch="1">
            <Swatch hex={best.hex} size={22} />
            <span className="gp-rec-text">
              {t('grout.recommend', { name: name(best), best: de(best.mean), current: de(current.mean) })} – <b>{t('grout.estimate')}</b>
            </span>
            <button className="btn small primary" onClick={() => apply(best.hex)} data-testid="grout-apply">
              {t('grout.apply')}
            </button>
          </div>
        ) : current ? (
          <div className="gp-rec ok" data-testid="grout-recommendation" data-best={best.hex} data-switch="0">
            <Swatch hex={groutHex} size={22} />
            <span className="gp-rec-text">
              {otherBest ? t('grout.keep', { current: de(current.mean), name: name(best), best: de(best.mean) }) : t('grout.isBest', { current: de(current.mean) })} –{' '}
              <b>{t('grout.estimate')}</b>
            </span>
          </div>
        ) : null}
        {/* Grundlage aller Zahlen dieses Kastens (Empfehlung, Liste, Abdeckung) – ein Modell, keine zwei „aktuell“-Werte */}
        <p className="small muted gp-basis" data-testid="grout-basis" data-basis={adv.basis}>
          {adv.basis === 'stones' ? t('grout.basisStones') : t('grout.basisIdeal')}
        </p>
        {adv.computedOtherGrid && (
          <p className="muted small" data-testid="grout-other-grid">
            {t('grout.mosaicOtherGrid')}
          </p>
        )}
        {adv.computedOtherPhoto && (
          <p className="muted small" data-testid="grout-other-photo">
            {t('grout.mosaicOtherPhoto')}
          </p>
        )}
        <FarPreview photo={adv.photo} stone={adv.stone} currentHex={groutHex} best={switchIt ? best : null} name={name} />
        <details className="gp-details">
          <summary>{t('grout.list')}</summary>
          <div className="gp-table-wrap">
          <table className="gp-table" data-testid="grout-table">
            <thead>
              <tr>
                <th>{t('grout.colColor')}</th>
                <th>{t('grout.colMean')}</th>
                <th>{t('grout.colP95')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ranked.map((r) => (
                <GroutRow key={r.hex} r={r} name={name(r)} isCurrent={r.hex === groutHex} onApply={() => apply(r.hex)} de={de} />
              ))}
            </tbody>
          </table>
          </div>
          <p className="muted small">{t('grout.listHint')}</p>
        </details>
        <details className="gp-details">
          <summary>{t('grout.how')}</summary>
          <p className="muted small" data-testid="grout-how">
            {t(adv.basis === 'stones' ? 'grout.howTextStones' : 'grout.howText', { cov: n((adv.coverage ?? adv.photo.ideal.meanCoverage) * 100, 0) })}
          </p>
        </details>
      </>
    );
  }
  return (
    <section className="gp-box" data-testid="grout-advice">
      <h4>
        {t('grout.title')} <Badge kind="info">{t('grout.estimate')}</Badge>
      </h4>
      {body}
    </section>
  );
}

function GroutRow({ r, name, isCurrent, onApply, de }: { r: GroutScore; name: string; isCurrent: boolean; onApply: () => void; de: (v: number) => string }) {
  const { t } = useI18n();
  return (
    <tr className={isCurrent ? 'current' : ''} data-hex={r.hex}>
      <td>
        <span className="gp-name">
          <Swatch hex={r.hex} size={16} />
          <span>
            {name} <span className="muted">{r.hex}</span>
          </span>
        </span>
        {/* Handy: „Übernehmen“ hier statt in der letzten Spalte (siehe w2-grout-preview.css) */}
        <span className="gp-apply-inline">
          {isCurrent ? (
            <span className="small gp-current-tag">{t('grout.currentTag')}</span>
          ) : (
            <button className="btn small" onClick={onApply}>
              {t('grout.apply')}
            </button>
          )}
        </span>
      </td>
      <td>{de(r.mean)}</td>
      <td>{de(r.p95)}</td>
      <td>
        {isCurrent ? (
          <span className="muted small">{t('grout.currentTag')}</span>
        ) : (
          <button className="btn small" onClick={onApply}>
            {t('grout.apply')}
          </button>
        )}
      </td>
    </tr>
  );
}

/**
 * Kleine Ansicht „aus der Entfernung“: je Feld die optische Mischung f·Stein + (1−f)·Fuge in linearem Licht
 * (mit den berechneten Steinfarben, sonst ideale Steine in Fotofarbe) neben dem Foto. Schätzung.
 */
function FarPreview({ photo, stone, currentHex, best, name }: { photo: PhotoModel; stone: StoneModel | null; currentHex: string; best: GroutScore | null; name: (s: { key: string }) => string }) {
  const { t } = useI18n();
  const items: { key: string; label: string; grout: string | null }[] = [
    { key: 'photo', label: t('grout.pv.photo'), grout: null },
    { key: 'current', label: t('grout.pv.current'), grout: currentHex },
  ];
  if (best) items.push({ key: 'best', label: `${t('grout.pv.best')}: ${name(best)}`, grout: best.hex });
  return (
    <figure className="gp-preview" data-testid="grout-preview">
      <div className="gp-thumbs">
        {items.map((it) => (
          <div key={it.key} className="gp-thumb">
            <FieldCanvas photo={photo} stone={stone} grout={it.grout} label={it.label} />
            <span className="small">
              {it.grout && <Swatch hex={it.grout} size={11} />} {it.label}
            </span>
          </div>
        ))}
      </div>
      <figcaption className="muted small">{stone ? t('grout.pv.stones') : t('grout.pv.ideal')}</figcaption>
    </figure>
  );
}

function FieldCanvas({ photo, stone, grout, label }: { photo: PhotoModel; stone: StoneModel | null; grout: string | null; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const { w, h } = photo.grid;
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    const g = grout ? hexToLinear(grout) : null;
    const src = stone && g ? stone.stones : photo.target;
    const cov = stone && g ? stone.coverage : photo.coverage;
    for (let i = 0; i < w * h; i++) {
      const f = g ? cov[i] : 1;
      for (let k = 0; k < 3; k++) img.data[i * 4 + k] = linToSrgb8(f * src[i * 3 + k] + (g ? (1 - f) * g[k] : 0));
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [photo, stone, grout]);
  return <canvas ref={ref} role="img" aria-label={label} style={{ aspectRatio: `${photo.layout.finishedW} / ${photo.layout.finishedH}` }} />;
}
