import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Badge, Swatch, Toggle } from '../components';
import { StoneDialog } from './StoneDialog';
import { Viewer, type PieceRef, type ViewerHandle } from './Viewer';
import type { ProjectApi } from './useProject';
import type { Material } from '../../core/types';
import { cellId, parseCellId } from '../../core/layout';
import { cellPieceCount } from '../../core/pieces';
import { paletteDisplayName } from '../../core/colorNames';
import '../css/w2-colour-honesty.css';
import '../css/w3-viewer-features.css';

export function StepPreview({ api, materials }: { api: ProjectApi; materials: Material[] }) {
  const { t, n, lang } = useI18n();
  const [realistic, setRealistic] = useState(true);
  const [codes, setCodes] = useState(true);
  const [showSections, setShowSections] = useState(false);
  const [rulers, setRulers] = useState(true);
  const [focus, setFocus] = useState<number | null>(null);
  const [pick, setPick] = useState<{ row: number; col: number; piece: number } | null>(null);
  const [search, setSearch] = useState('');
  /** Suche: nicht gefunden (Text) bzw. gefundener Stein kurz aufleuchten lassen */
  const [notFound, setNotFound] = useState<string | null>(null);
  const [flash, setFlash] = useState<PieceRef | null>(null);
  /** Foto/Mosaik-Vergleich: an/aus, Anteil der sichtbaren Mosaikbreite (0…1), „Foto zeigen“ gedrückt */
  const [compareOn, setCompareOn] = useState(false);
  const [split, setSplit] = useState(0.5);
  const [hold, setHold] = useState(false);
  const viewer = useRef<ViewerHandle>(null);
  const origRef = useRef<HTMLDivElement>(null);
  const c = api.computed;
  /** Referenz = bearbeitetes Foto der letzten Berechnung (nur im Speicher, siehe w3vf.refMissing) */
  const reference = api.processed;

  useEffect(() => {
    const h = origRef.current;
    if (!h || !reference) return;
    h.innerHTML = '';
    // Größe über CSS (.w3vf-orig): ganzes Bild sichtbar, höchstens 200 px hoch
    reference.style.width = '';
    reference.style.height = '';
    reference.setAttribute('data-testid', 'reference-photo');
    h.appendChild(reference);
  }, [reference, c]);

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

  // ohne Referenz kein Vergleich (z. B. nach dem Neuladen)
  useEffect(() => {
    if (!reference) {
      setCompareOn(false);
      setHold(false);
    }
  }, [reference]);

  if (!c) return <p className={api.integrityError ? 'error' : 'muted'}>{t(api.integrityError ? 'compute.err.integrity' : 'preview.notComputed')}</p>;
  const rec = api.rec!;
  const palette = rec.palette;
  const matById = new Map(materials.map((m) => [m.id, m]));
  const comparing = !!reference && (compareOn || hold);
  const pct = Math.round(split * 100);
  /** Text, solange keine Referenz im Speicher ist: während einer Berechnung kommt sie mit dem Ergebnis */
  const refMissingText = api.computing ? t('preview.originalAfterCompute') : t('w3vf.refMissing');
  const holdOn = () => reference && setHold(true);
  const holdOff = () => setHold(false);
  return (
    <div className="viewer-layout">
      <div>
        {api.stale && <Badge kind="warn">{t('preview.stale')}</Badge>}
        {api.materialsChanged && (
          <span title={t('w3lp.materialsChanged')} data-testid="preview-materials-changed">
            <Badge kind="warn">{t('w3lp.materialsChangedBadge')}</Badge>
          </span>
        )}
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
            <p className="muted small w3vf-ref-note" data-testid="reference-missing">
              {!api.computing && <Badge kind="incomplete">{t('common.incomplete')}</Badge>} {refMissingText}
            </p>
          )}
        </div>
        <p className="muted small">{t('preview.hint')}</p>
      </div>
      <aside className="side">
        <Toggle checked={realistic} onChange={setRealistic} label={t('preview.realistic')} />
        <Toggle checked={codes} onChange={setCodes} label={t('preview.codes')} />
        <Toggle checked={showSections} onChange={setShowSections} label={t('preview.sections')} />
        <Toggle checked={rulers} onChange={setRulers} label={t('w3vf.rulers')} hint={t('w3vf.rulersHint')} testId="rulers-toggle" />
        <form
          className="btn-row"
          onSubmit={(e) => {
            e.preventDefault();
            const p = parseCellId(c.layout, search);
            const idx = p ? p.row * c.layout.cols + p.col : -1;
            // auch das Teilstück muss existieren (A001-3 bei einer zweiteiligen Zelle gibt es nicht)
            if (p && p.piece >= 0 && p.piece < Math.max(1, cellPieceCount(c.data, idx))) {
              setNotFound(null);
              setPick({ row: p.row, col: p.col, piece: p.piece });
              viewer.current?.center(c.layout.colX[p.col] + c.layout.colW[p.col] / 2, c.layout.rowY[p.row] + c.layout.rowH[p.row] / 2, 12);
              setFlash({ idx, piece: p.piece });
            } else if (search.trim()) {
              setNotFound(t('w3vf.findNotFound', { id: search.trim(), first: cellId(c.layout, 0, 0), last: cellId(c.layout, c.layout.rows - 1, c.layout.cols - 1) }));
            }
          }}
        >
          <input
            className="text"
            placeholder={t('preview.findStone')}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setNotFound(null);
            }}
            data-testid="find-stone"
          />
          <button className="btn small" type="submit">
            {t('preview.find')}
          </button>
        </form>
        {notFound && (
          <p className="error small" role="alert" data-testid="find-not-found">
            {notFound}
          </p>
        )}
        {/* Bearbeitetes Foto (Referenz der letzten Berechnung) über der Legende */}
        <div className="w3vf-orig">
          <h4>{t('preview.original')}</h4>
          {reference ? (
            <>
              <div className="orig-thumb" ref={origRef} data-testid="orig-thumb" />
              {api.stale && <small className="muted block">{t('w3vf.refStale')}</small>}
            </>
          ) : (
            <small className="muted" data-testid="orig-missing">
              {api.computing ? refMissingText : t('w3vf.refMissingShort')}
            </small>
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
      </aside>
      {pick && (
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
          onClose={() => setPick(null)}
          onNavigate={(row, col, piece) => setPick({ row, col, piece })}
          onChanged={api.touchMosaic}
          onProgress={api.touchProgress}
        />
      )}
    </div>
  );
}
