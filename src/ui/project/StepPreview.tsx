import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Badge, Swatch, Toggle } from '../components';
import { FindStone } from './FindStone';
import { HistoryButtons, HistoryStatus, useHistoryShortcuts } from './HistoryControls';
import { PANEL_QUERY, StoneDialog, useMediaQuery } from './StoneDialog';
import { Viewer, type PieceRef, type ViewerHandle } from './Viewer';
import type { ProjectApi } from './useProject';
import type { Material } from '../../core/types';
import { cellPieceCount } from '../../core/pieces';
import { paletteDisplayName } from '../../core/colorNames';
import '../css/w2-colour-honesty.css';
import '../css/w3-viewer-features.css';
import '../css/w5-undo-editing.css';

export function StepPreview({ api, materials }: { api: ProjectApi; materials: Material[] }) {
  const { t, n, lang } = useI18n();
  const [realistic, setRealistic] = useState(true);
  const [codes, setCodes] = useState(true);
  const [showSections, setShowSections] = useState(false);
  const [rulers, setRulers] = useState(true);
  const [focus, setFocus] = useState<number | null>(null);
  const [pick, setPick] = useState<{ row: number; col: number; piece: number } | null>(null);
  const [flash, setFlash] = useState<PieceRef | null>(null);
  /** Foto/Mosaik-Vergleich: an/aus, Anteil der sichtbaren Mosaikbreite (0…1), „Foto zeigen“ gedrückt */
  const [compareOn, setCompareOn] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [hold, setHold] = useState(false);
  const viewer = useRef<ViewerHandle>(null);
  const c = api.computed;
  /** Breiter Bildschirm: Steindetail ersetzt die Seitenleiste neben dem Mosaik (kein Dialog darüber) */
  const wide = useMediaQuery(PANEL_QUERY);
  /** Vergleichsfoto = bearbeitetes Foto der letzten Berechnung (mit dem Raster gespeichert, siehe useProject) */
  const reference = api.reference.canvas;
  useHistoryShortcuts(api);

  // Vorschaubild über der Legende: dasselbe Canvas (Callback-Ref – die Seitenleiste wird beim Steindetail ersetzt)
  const thumbRef = useCallback(
    (h: HTMLDivElement | null) => {
      if (!h || !reference) return;
      if (h.firstChild === reference) return;
      h.innerHTML = '';
      // Größe über CSS (.w3vf-orig): ganzes Bild sichtbar, höchstens 200 px hoch
      reference.style.width = '';
      reference.style.height = '';
      reference.setAttribute('data-testid', 'reference-photo');
      h.appendChild(reference);
    },
    [reference],
  );

  // Stein öffnen, den eine andere Stelle angefordert hat (z. B. Hinweis zu ungültigen Freiformsteinen)
  const handledRequest = useRef(0);
  useEffect(() => {
    const req = api.stoneRequest;
    if (!req || !c || req.n === handledRequest.current) return;
    handledRequest.current = req.n;
    if (req.row >= c.layout.rows || req.col >= c.layout.cols) return;
    const idx = req.row * c.layout.cols + req.col;
    // angefordertes Teilstück nur, wenn die Zelle (noch) so viele Teile hat – sonst Teil 1
    const piece = req.piece > 0 && req.piece < cellPieceCount(c.data, idx) ? req.piece : 0;
    setPick({ row: req.row, col: req.col, piece });
    viewer.current?.center(c.layout.colX[req.col] + c.layout.colW[req.col] / 2, c.layout.rowY[req.row] + c.layout.rowH[req.row] / 2, 12);
    setFlash({ idx, piece });
  }, [api.stoneRequest, c]);

  // ohne Referenz kein Vergleich
  useEffect(() => {
    if (!reference) {
      setCompareOn(false);
      setHold(false);
    }
  }, [reference]);

  // Rückgängig/Wiederholen: betroffenen Stein kurz aufleuchten lassen
  const lastEv = api.history.last;
  const seenEv = useRef(lastEv?.seq ?? 0);
  useEffect(() => {
    if (!lastEv || lastEv.seq === seenEv.current) return;
    seenEv.current = lastEv.seq;
    if ((lastEv.kind === 'undo' || lastEv.kind === 'redo') && lastEv.flash) setFlash({ ...lastEv.flash });
  }, [lastEv]);

  if (!c) return <p className={api.integrityError ? 'error' : 'muted'}>{t(api.integrityError ? 'compute.err.integrity' : 'preview.notComputed')}</p>;
  const rec = api.rec!;
  const palette = rec.palette;
  const matById = new Map(materials.map((m) => [m.id, m]));
  const comparing = !!reference && (compareOn || hold);
  const pct = Math.round(split * 100);
  const holdOn = () => reference && setHold(true);
  const holdOff = () => setHold(false);
  const ref = api.reference;
  const refErr = ref.error ? (['photo-changed', 'no-photo', 'no-key', 'not-computed'].includes(ref.error) ? t(`w5ue.ref.block.${ref.error}`) : t(`w5ue.ref.err.${ref.error}`)) : null;

  const onFound = (row: number, col: number, piece: number) => {
    setPick({ row, col, piece });
    viewer.current?.center(c.layout.colX[col] + c.layout.colW[col] / 2, c.layout.rowY[row] + c.layout.rowH[row] / 2, 12);
    setFlash({ idx: row * c.layout.cols + col, piece });
  };

  const stone = pick && (
    <StoneDialog
      layout={c.layout}
      data={c.data}
      palette={palette}
      materials={materials}
      sections={api.sections}
      row={pick.row}
      col={pick.col}
      piece={pick.piece}
      minPieceMm={rec.settings.shapes.minPieceMm}
      readOnly={!!api.computing || api.paletteLocked}
      variant={wide ? 'panel' : 'modal'}
      history={<HistoryButtons api={api} testIdPrefix="stone-history" compact />}
      paletteMode={rec.settings.paletteMode}
      deltaE={rec.settings.deltaE}
      onClose={() => setPick(null)}
      onNavigate={(row, col, piece) => setPick({ row, col, piece })}
      onEdit={api.editCell}
    />
  );

  return (
    <div className="viewer-layout">
      <div>
        <div className="w5ue-toolbar">
          <HistoryButtons api={api} />
          {api.stale && <Badge kind="warn">{t('preview.stale')}</Badge>}
          {api.materialsChanged && (
            <span title={t('w3lp.materialsChanged')} data-testid="preview-materials-changed">
              <Badge kind="warn">{t('w3lp.materialsChangedBadge')}</Badge>
            </span>
          )}
          <HistoryStatus api={api} />
        </div>
        <Viewer
          ref={viewer}
          layout={c.layout}
          data={c.data}
          palette={palette}
          version={api.version}
          progressVersion={api.progressVersion}
          groutHex={rec.settings.groutHex}
          surface={rec.settings.surface}
          realistic={realistic}
          showCodes={codes}
          progressMode={false}
          sections={showSections ? api.sections : null}
          highlight={pick}
          focusColor={focus}
          rulers={rulers}
          flash={flash}
          compareImage={comparing ? reference : null}
          compareSplit={hold ? 1 : split}
          onCompareSplit={compareOn && !hold ? setSplit : undefined}
          onPick={(row, col, piece) => setPick({ row, col, piece })}
        />
        <div className="w3vf-compare" data-testid="compare-box">
          <div className="w3vf-compare-row">
            <Toggle checked={compareOn && !!reference} onChange={setCompareOn} label={t('w3vf.compareToggle')} disabled={!reference} testId="compare-toggle" />
            <button
              type="button"
              className="btn small w3vf-hold"
              aria-pressed={hold}
              disabled={!reference}
              data-testid="compare-hold"
              onPointerDown={(e) => {
                if (e.button !== 0 && e.pointerType === 'mouse') return;
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  /* Zeiger bereits beendet */
                }
                holdOn();
              }}
              onPointerUp={holdOff}
              onPointerCancel={holdOff}
              onLostPointerCapture={holdOff}
              onKeyDown={(e) => {
                if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                  e.preventDefault();
                  holdOn();
                }
              }}
              onKeyUp={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  holdOff();
                }
              }}
              onBlur={holdOff}
              onContextMenu={(e) => e.preventDefault()}
            >
              {t('w3vf.holdPhoto')}
            </button>
          </div>
          {reference && compareOn && (
            <>
              <label className="w3vf-compare-row">
                <span>{t('w3vf.compareShare')}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={pct}
                  onChange={(e) => setSplit(Number(e.target.value) / 100)}
                  aria-label={t('w3vf.compareShare')}
                  data-testid="compare-slider"
                />
                <span className="w3vf-compare-val" data-testid="compare-value">
                  {pct} %
                </span>
              </label>
              <small className="muted">{t('w3vf.compareHint')}</small>
            </>
          )}
          {!reference && (
            <div className="w3vf-ref-note w5ue-ref small" data-testid="reference-missing" data-state={api.computing ? 'computing' : (ref.busy ?? (ref.block ? 'blocked' : 'missing'))}>
              {api.computing ? (
                <span className="muted">{t('preview.originalAfterCompute')}</span>
              ) : ref.busy ? (
                <span className="muted">{t(ref.busy === 'loading' ? 'w5ue.ref.loading' : 'w5ue.ref.regenerating')}</span>
              ) : (
                <>
                  <span className="muted">
                    <Badge kind="incomplete">{t('common.incomplete')}</Badge> {t('w5ue.ref.missing')}
                  </span>
                  {ref.block ? (
                    <span className="muted">{t(`w5ue.ref.block.${ref.block}`)}</span>
                  ) : (
                    <span className="w5ue-ref-actions">
                      <button type="button" className="btn small" onClick={() => void api.regenerateReference()} data-testid="reference-regenerate">
                        {t('w5ue.ref.regenerate')}
                      </button>
                      <span className="muted">{t('w5ue.ref.regenerateHint')}</span>
                    </span>
                  )}
                  {refErr && ref.error !== ref.block && (
                    <span className="error" role="alert" data-testid="reference-error">
                      {refErr}
                    </span>
                  )}
                </>
              )}
            </div>
          )}
          {reference && ref.origin === 'regenerated' && (
            <small className="muted block" data-testid="reference-regenerated">
              {t('w5ue.ref.regenerated')}
            </small>
          )}
          {reference && refErr && (
            <small className="error block" role="alert" data-testid="reference-error">
              {refErr}
            </small>
          )}
        </div>
        <p className="muted small">{t('preview.hint')}</p>
        {!wide && stone}
      </div>
      {wide && stone ? (
        <aside className="side w5ue-side">{stone}</aside>
      ) : (
        <aside className="side">
          <Toggle checked={realistic} onChange={setRealistic} label={t('preview.realistic')} />
          <Toggle checked={codes} onChange={setCodes} label={t('preview.codes')} />
          <Toggle checked={showSections} onChange={setShowSections} label={t('preview.sections')} />
          <Toggle checked={rulers} onChange={setRulers} label={t('w3vf.rulers')} hint={t('w3vf.rulersHint')} testId="rulers-toggle" />
          <FindStone layout={c.layout} data={c.data} onFound={onFound} />
          {/* Bearbeitetes Foto (Referenz der letzten Berechnung) über der Legende */}
          <div className="w3vf-orig">
            <h4>{t('preview.original')}</h4>
            {reference ? (
              <>
                <div className="orig-thumb" ref={thumbRef} data-testid="orig-thumb" />
                {api.stale && <small className="muted block">{t('w3vf.refStale')}</small>}
              </>
            ) : (
              <div className="w5ue-ref small" data-testid="orig-missing">
                <span className="muted">
                  {api.computing ? t('preview.originalAfterCompute') : ref.busy ? t(ref.busy === 'loading' ? 'w5ue.ref.loading' : 'w5ue.ref.regenerating') : ref.block ? t(`w5ue.ref.block.${ref.block}`) : t('w5ue.ref.missingShort')}
                </span>
                {!api.computing && !ref.busy && !ref.block && (
                  <span>
                    <button type="button" className="btn small" onClick={() => void api.regenerateReference()} title={t('w5ue.ref.regenerateHint')} data-testid="reference-regenerate-side">
                      {t('w5ue.ref.regenerate')}
                    </button>
                  </span>
                )}
              </div>
            )}
          </div>
          <h4>
            {t('preview.legend')} ({palette.length})
          </h4>
          <div className="legend-list">
            {palette.map((p, i) => {
              const m = p.materialId ? matById.get(p.materialId) : undefined;
              const matText = m ? [m.manufacturer, m.colorNumber].filter((x) => x && x.trim()).join(' ') || m.colorName : '';
              return (
                <button key={i} className={`legend-item ${focus === i ? 'active' : ''}`} onClick={() => setFocus(focus === i ? null : i)} data-testid="legend-item">
                  <Swatch hex={p.hex} />
                  <b>{String(p.code).padStart(2, '0')}</b>
                  <span className="grow w2ch-legend-name">
                    <span data-testid="legend-name">{paletteDisplayName(p, lang)}</span>
                    {/* Verknüpftes Material als Zweitzeile (wie im PDF): Hersteller und Farbnummer */}
                    {m && matText && (
                      <small className="w2ch-legend-mat" data-testid="legend-material">
                        {matText}
                      </small>
                    )}
                    {p.materialId && !m && (
                      <small className="w2ch-legend-mat missing" data-testid="legend-material-missing">
                        {t('w2ch.legendMaterialMissing')}
                      </small>
                    )}
                  </span>
                  <span className="muted">{api.stats ? n(api.stats.perColor[i]?.pieces ?? 0) : '…'}</span>
                </button>
              );
            })}
          </div>
          {focus !== null && <small className="muted">{t('preview.focusHint')}</small>}
          <small className="muted block w5ue-hnote">{t('w5ue.historyNote')}</small>
        </aside>
      )}
    </div>
  );
}
