/**
 * Abweichung Foto ↔ Stein in der Vorschau (Paket w6-compare-batch): Legende der Karte, Zusammenfassung, Liste
 * „Größte Abweichungen“ (Sprung zum Stein, Steindetail öffnet sich) und die Abweichung des gewählten Steins mit der
 * nächsten Palettenfarbe als Vorschlag.
 *
 * Die Abweichung des gewählten Steins steht im Steindetail (StoneDeviation) – am Handy liegt das Steindetail als Blatt
 * über der Seite, ein Block hier wäre verdeckt (Paket w6-fix-ui).
 *
 * Alle Werte kommen aus src/core/deviation.ts: ΔE zwischen der bei der Berechnung gemessenen Fotofarbe und der
 * AKTUELLEN Farbe des Steins, mit der ΔE-Formel der Berechnung. Steine ohne Fotoreferenz (Freiform, Form geändert,
 * vor dieser Funktion berechnet) bekommen nie einen geschätzten Wert.
 */
import { useMemo } from 'react';
import { labToHex, type DeltaEFormula } from '../../core/color';
import { paletteDisplayName } from '../../core/colorNames';
import { deviationBin, deviationForPiece, deviationSummary, hasPhotoTargets, nearestColorForPiece, pieceTarget, targetState, topDeviations, type DeviationSummary } from '../../core/deviation';
import { forEachPieceColor } from '../../core/batch';
import { type Layout } from '../../core/layout';
import type { MosaicData, PaletteColor } from '../../core/types';
import { useI18n } from '../../i18n';
import { deText } from '../deWords';
import { Badge, Swatch, Toggle } from '../components';
import { DEVIATION_COLORS, NO_REFERENCE_COLOR, rgbaCss } from './PreviewOverlay';
import type { ProjectApi } from './useProject';
import '../css/w6-compare-batch.css';
import '../css/w6-fix-ui.css';

/** Einträge der Liste „Größte Abweichungen“ */
export const TOP_DEVIATIONS = 50;

const code2 = (p: PaletteColor | undefined) => (p ? String(p.code).padStart(2, '0') : '?');

/**
 * Abweichung des gewählten Steins im Steindetail (Paket w6-fix-ui): Fotofarbe ↔ Steinfarbe, ΔE in Worten und die nächste
 * Palettenfarbe zum Übernehmen. Nur, wenn das Raster Fotofarben hat; ohne Fotoreferenz des Steins steht der Grund da.
 * `formula` ist die ΔE-Formel der BERECHNUNG.
 */
export function StoneDeviation(p: { data: MosaicData; palette: PaletteColor[]; formula: DeltaEFormula; idx: number; piece: number; id: string; readOnly: boolean; onApply: (color: number) => void }) {
  const { t, n, lang } = useI18n();
  const { data, palette, formula, idx, piece } = p;
  if (!hasPhotoTargets(data)) return null;
  const target = pieceTarget(data, idx, piece);
  const d = deviationForPiece(data, palette, idx, piece, formula);
  const near = nearestColorForPiece(data, palette, idx, piece, formula);
  const state = targetState(data, idx);
  const color = currentColorOf(data, idx, piece);
  return (
    <section className="w5ue-sec w6fx-stone-dev" data-testid="deviation-stone" data-id={p.id} data-de={d ?? ''}>
      <h4>{t('w6fx.stone.title')}</h4>
      {target && d !== null ? (
        <>
          <div className="w6fx-pair">
            <span className="w6fx-pair-item">
              <Swatch hex={labToHex(target[0], target[1], target[2])} size={28} title={t('w6cb.photoColor')} />
              <small>{t('w6fx.stone.photo')}</small>
            </span>
            <span aria-hidden="true" className="w6fx-pair-arrow">
              ↔
            </span>
            <span className="w6fx-pair-item">
              <Swatch hex={palette[color]?.hex ?? '#ff00ff'} size={28} />
              <small>
                {t('w6fx.stone.tile')} {code2(palette[color])}
              </small>
            </span>
            <b className="w6fx-de-word" style={{ borderBottomColor: rgbaCss(DEVIATION_COLORS[deviationBin(d)]) }} data-testid="deviation-stone-de">
              {t('w6fx.stone.de', { word: deText(t, n, d) })}
            </b>
          </div>
          {near &&
            (near.better ? (
              <div className="w6fx-near">
                <span className="small">
                  <Swatch hex={palette[near.index]?.hex ?? '#ff00ff'} size={16} />{' '}
                  {t('w6fx.stone.nearest', { code: code2(palette[near.index]), name: paletteDisplayName(palette[near.index], lang), word: deText(t, n, near.deltaE) })}
                </span>
                <button type="button" className="btn small primary" disabled={p.readOnly} onClick={() => p.onApply(near.index)} data-testid="deviation-stone-apply">
                  → {t('w6fx.stone.apply', { code: code2(palette[near.index]) })}
                </button>
              </div>
            ) : (
              <small className="muted block">{t('w6cb.alreadyNearest')}</small>
            ))}
        </>
      ) : (
        <small className="muted block" data-testid="deviation-stone-none">
          {t(`w6cb.noRef.${state === 'ok' ? 'color' : state}`)}
        </small>
      )}
    </section>
  );
}

/** Legende der Karte (unter dem Viewer, solange die Karte an ist) */
export function DeviationLegend({ summary, dither, stale, formula }: { summary: DeviationSummary | null; dither: boolean; stale: boolean; formula: DeltaEFormula }) {
  const { t, n } = useI18n();
  const labels = [t('w6cb.bin0'), t('w6cb.bin1'), t('w6cb.bin2'), t('w6cb.bin3')];
  const missing = summary ? summary.pieces - summary.measured : null;
  return (
    <div className="w6cb-legend" data-testid="deviation-legend">
      <span className="w6cb-legend-title">
        {t('w6cb.legendTitle', {
          formula: formula === '76' ? 'CIE76' : 'CIEDE2000',
        })}
      </span>
      {labels.map((l, i) => (
        <span key={i} className="w6cb-legend-item" data-testid="deviation-bin" data-bin={i}>
          <span className="w6cb-sw" style={{ background: rgbaCss(DEVIATION_COLORS[i]) }} />
          {l}
          {summary && <span className="muted"> ({n(summary.bins[i])})</span>}
        </span>
      ))}
      <span className="w6cb-legend-item" data-testid="deviation-bin" data-bin="none">
        <span className="w6cb-sw w6cb-sw-hatch" style={{ backgroundColor: rgbaCss(NO_REFERENCE_COLOR) }} />
        {t('w6cb.noRef')}
        {missing !== null && <span className="muted"> ({n(missing)})</span>}
      </span>
      {stale && (
        <span data-testid="deviation-stale" title={t('w6cb.staleHint')}>
          <Badge kind="warn">{t('w6cb.staleBadge')}</Badge>
        </span>
      )}
      {dither && (
        <small className="muted block w6cb-legend-note" data-testid="deviation-dither">
          {t('w6cb.ditherNote')}
        </small>
      )}
    </div>
  );
}

export interface DeviationPanelProps {
  api: ProjectApi;
  layout: Layout;
  data: MosaicData;
  palette: PaletteColor[];
  formula: DeltaEFormula;
  dither: boolean;
  overlayOn: boolean;
  setOverlayOn: (on: boolean) => void;
  onJump: (row: number, col: number, piece: number) => void;
}

export function DeviationPanel(p: DeviationPanelProps) {
  const { t, n } = useI18n();
  const { api, layout, data, palette, formula } = p;
  const version = api.version;
  const has = hasPhotoTargets(data);
  // Zusammenfassung und Liste: neu bei jeder Bearbeitung (version) und jeder Palettenänderung
  const summary = useMemo(() => (has ? deviationSummary(data, palette, formula) : null), [has, data, palette, formula, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const top = useMemo(() => (has ? topDeviations(layout, data, palette, formula, TOP_DEVIATIONS) : []), [has, layout, data, palette, formula, version]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="w6cb-panel" data-testid="deviation-panel">
      <div className="w6cb-row">
        <Toggle checked={p.overlayOn && has} onChange={p.setOverlayOn} label={t('w6cb.overlayToggle')} hint={t('w6cb.overlayHint')} disabled={!has} testId="deviation-toggle" />
      </div>
      {!has ? (
        <p className="small" data-testid="deviation-legacy">
          <Badge kind="incomplete">{t('common.incomplete')}</Badge> {t('w6cb.legacy')}
        </p>
      ) : (
        <>
          {summary && (
            <p className="small w6cb-summary" data-testid="deviation-summary" data-measured={summary.measured} data-pieces={summary.pieces}>
              {t('w6cb.summary', {
                measured: n(summary.measured),
                pieces: n(summary.pieces),
                mean: n(summary.mean, 1),
                max: n(summary.max, 1),
                p95: n(summary.p95),
              })}
              {summary.pieces > summary.measured && (
                <>
                  {' '}
                  <span className="muted">
                    {t('w6cb.summaryMissing', {
                      free: n(summary.missing.free),
                      shape: n(summary.missing.shape),
                    })}
                  </span>
                </>
              )}
            </p>
          )}
          {formula === '76' && <small className="muted block">{t('w6cb.note76')}</small>}
          {p.dither && !p.overlayOn && <small className="muted block">{t('w6cb.ditherNote')}</small>}

          <h4 className="w6cb-h">{t('w6cb.topTitle', { n: n(top.length) })}</h4>
          {top.length === 0 ? (
            <p className="muted small">{t('w6cb.topEmpty')}</p>
          ) : (
            <div className="w6fx-top-head small muted" aria-hidden="true">
              <span className="w6cb-rank">{t('w6fx.col.rank')}</span>
              <span className="w6cb-id">{t('w6fx.col.id')}</span>
              <span className="w6fx-head-pair">
                {t('w6fx.col.photo')} ↔ {t('w6fx.col.tile')}
              </span>
              <span className="w6cb-de">{t('w6fx.col.de')}</span>
            </div>
          )}
          {top.length > 0 && (
            <ol className="w6cb-top" data-testid="deviation-top">
              {top.map((d, i) => {
                const pc = palette[d.color];
                return (
                  <li key={`${d.idx}-${d.piece}`} data-testid="deviation-item" data-id={d.id} data-de={d.deltaE}>
                    <button type="button" className="w6cb-top-btn" onClick={() => p.onJump(d.row, d.col, d.piece)} title={t('w6cb.jump')}>
                      <span className="w6cb-rank muted">{i + 1}.</span>
                      <span className="w6cb-id mono">{d.id}</span>
                      <span className="w6cb-pair">
                        <Swatch hex={labToHex(d.target[0], d.target[1], d.target[2])} size={16} title={t('w6cb.photoColor')} />
                        <span aria-hidden="true">↔</span>
                        <Swatch hex={pc?.hex ?? '#ff00ff'} size={16} />
                        <span>{code2(pc)}</span>
                      </span>
                      <span
                        className="w6cb-de"
                        style={{
                          borderColor: rgbaCss(DEVIATION_COLORS[d.deltaE < 2 ? 0 : d.deltaE <= 5 ? 1 : d.deltaE <= 10 ? 2 : 3]),
                        }}
                      >
                        {deText(t, n, d.deltaE, true)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          <small className="muted block">{t('w6cb.topHint')}</small>
        </>
      )}
    </div>
  );
}

/** Aktueller Palettenindex eines Teilstücks (wie cellPieces) */
function currentColorOf(data: MosaicData, idx: number, piece: number): number {
  let c = -1;
  forEachPieceColor(data, idx, (q, color) => {
    if (q === piece) c = color;
  });
  return c;
}
