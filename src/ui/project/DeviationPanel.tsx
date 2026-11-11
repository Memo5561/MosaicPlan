/**
 * Abweichung Foto ↔ Stein in der Vorschau (Paket w6-compare-batch): Legende der Karte, Zusammenfassung, Liste
 * „Größte Abweichungen“ (Sprung zum Stein, Steindetail öffnet sich) und die Abweichung des gewählten Steins mit der
 * nächsten Palettenfarbe als Vorschlag.
 *
 * Alle Werte kommen aus src/core/deviation.ts: ΔE zwischen der bei der Berechnung gemessenen Fotofarbe und der
 * AKTUELLEN Farbe des Steins, mit der ΔE-Formel der Berechnung. Steine ohne Fotoreferenz (Freiform, Form geändert,
 * vor dieser Funktion berechnet) bekommen nie einen geschätzten Wert.
 */
import { useMemo } from 'react';
import { labToHex, type DeltaEFormula } from '../../core/color';
import { paletteDisplayName } from '../../core/colorNames';
import { deviationForPiece, deviationSummary, hasPhotoTargets, nearestColorForPiece, pieceTarget, targetState, topDeviations, type DeviationSummary } from '../../core/deviation';
import { forEachPieceColor } from '../../core/batch';
import { setPieceColor } from '../../core/edits';
import { pieceId, type Layout } from '../../core/layout';
import { cellPieceCount } from '../../core/pieces';
import type { MosaicData, PaletteColor } from '../../core/types';
import { useI18n } from '../../i18n';
import { Badge, Swatch, Toggle } from '../components';
import { DEVIATION_COLORS, NO_REFERENCE_COLOR, rgbaCss } from './PreviewOverlay';
import type { ProjectApi } from './useProject';
import '../css/w6-compare-batch.css';

/** Einträge der Liste „Größte Abweichungen“ */
export const TOP_DEVIATIONS = 50;

const code2 = (p: PaletteColor | undefined) => (p ? String(p.code).padStart(2, '0') : '?');

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
  /** gewählter Stein (Steindetail offen) */
  pick: { row: number; col: number; piece: number } | null;
  onJump: (row: number, col: number, piece: number) => void;
  readOnly: boolean;
}

export function DeviationPanel(p: DeviationPanelProps) {
  const { t, n, lang } = useI18n();
  const { api, layout, data, palette, formula } = p;
  const version = api.version;
  const has = hasPhotoTargets(data);
  // Zusammenfassung und Liste: neu bei jeder Bearbeitung (version) und jeder Palettenänderung
  const summary = useMemo(() => (has ? deviationSummary(data, palette, formula) : null), [has, data, palette, formula, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const top = useMemo(() => (has ? topDeviations(layout, data, palette, formula, TOP_DEVIATIONS) : []), [has, layout, data, palette, formula, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = (row: number, col: number, piece: number, to: number) => {
    if (p.readOnly) return;
    const idx = row * layout.cols + col;
    const pieces = cellPieceCount(data, idx);
    const id = pieceId(layout, row, col, piece, pieces);
    const fromIdx = currentColorOf(data, idx, piece);
    p.api.editCell(
      idx,
      () => setPieceColor(data, idx, piece, to),
      {
        key: 'w5ue.h.color',
        params: { id, from: code2(palette[fromIdx]), to: code2(palette[to]) },
      },
      { idx, piece },
    );
  };

  // gewählter Stein: Fotofarbe ↔ Steinfarbe und nächste Palettenfarbe
  const sel = p.pick;
  const selInfo = useMemo(() => {
    if (!sel) return null;
    const idx = sel.row * layout.cols + sel.col;
    if (sel.row >= layout.rows || sel.col >= layout.cols) return null;
    const pieces = cellPieceCount(data, idx);
    const piece = sel.piece < pieces ? sel.piece : 0;
    const id = pieceId(layout, sel.row, sel.col, piece, pieces);
    const target = pieceTarget(data, idx, piece);
    const d = deviationForPiece(data, palette, idx, piece, formula);
    const near = nearestColorForPiece(data, palette, idx, piece, formula);
    return {
      idx,
      piece,
      id,
      target,
      d,
      near,
      state: targetState(data, idx),
      color: currentColorOf(data, idx, piece),
    };
  }, [sel, layout, data, palette, formula, version]); // eslint-disable-line react-hooks/exhaustive-deps

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

          {/* gewählter Stein */}
          {selInfo && (
            <div className="w6cb-stone" data-testid="deviation-stone" data-id={selInfo.id} data-de={selInfo.d ?? ''}>
              <b>{selInfo.id}</b>{' '}
              {selInfo.target && selInfo.d !== null ? (
                <>
                  <span className="w6cb-pair">
                    <Swatch hex={labToHex(selInfo.target[0], selInfo.target[1], selInfo.target[2])} title={t('w6cb.photoColor')} />
                    <span className="muted">{t('w6cb.photoColor')}</span>
                    <span aria-hidden="true">↔</span>
                    <Swatch hex={palette[selInfo.color]?.hex ?? '#ff00ff'} />
                    <span>{code2(palette[selInfo.color])}</span>
                  </span>{' '}
                  <span data-testid="deviation-stone-de">{t('w6cb.de', { v: n(selInfo.d, 1) })}</span>
                  {selInfo.near && (
                    <span className="block w6cb-near">
                      {selInfo.near.better ? (
                        <>
                          {t('w6cb.nearest')} <Swatch hex={palette[selInfo.near.index]?.hex ?? '#ff00ff'} /> <b>{code2(palette[selInfo.near.index])}</b>{' '}
                          {paletteDisplayName(palette[selInfo.near.index], lang)} · {t('w6cb.de', { v: n(selInfo.near.deltaE, 1) })}{' '}
                          <button
                            type="button"
                            className="btn small"
                            disabled={p.readOnly}
                            onClick={() => apply(Math.floor(selInfo.idx / layout.cols), selInfo.idx % layout.cols, selInfo.piece, selInfo.near!.index)}
                            data-testid="deviation-stone-apply"
                          >
                            {t('w6cb.applyNearest', {
                              code: code2(palette[selInfo.near.index]),
                            })}
                          </button>
                        </>
                      ) : (
                        <span className="muted">{t('w6cb.alreadyNearest')}</span>
                      )}
                    </span>
                  )}
                </>
              ) : (
                <span className="muted" data-testid="deviation-stone-none">
                  {t(`w6cb.noRef.${selInfo.state === 'ok' ? 'color' : selInfo.state}`)}
                </span>
              )}
            </div>
          )}

          <h4 className="w6cb-h">{t('w6cb.topTitle', { n: n(top.length) })}</h4>
          {top.length === 0 ? (
            <p className="muted small">{t('w6cb.topEmpty')}</p>
          ) : (
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
                        {n(d.deltaE, 1)}
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
