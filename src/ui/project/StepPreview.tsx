import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Badge, Swatch, Toggle } from '../components';
import { deviceKey, useCoarsePointer } from './deviceKind';
import { FindStone } from './FindStone';
import { HistoryButtons, HistoryStatus, useHistoryShortcuts } from './HistoryControls';
import { PANEL_QUERY, StoneDialog, useMediaQuery } from './StoneDialog';
import { Viewer, type PieceRef, type ViewerHandle } from './Viewer';
import type { ProjectApi } from './useProject';
import type { Material } from '../../core/types';
import { cellPieceCount } from '../../core/pieces';
import { paletteDisplayName } from '../../core/colorNames';
import { deviationMap, deviationSummary, hasPhotoTargets } from '../../core/deviation';
import type { Range } from '../../core/stats';
import { BatchPanel, rangeLabel, type BatchScope } from './BatchPanel';
import { rangeCells } from '../../core/batch';
import { DeviationLegend, DeviationPanel } from './DeviationPanel';
import { PngExportPanel } from './PngExportPanel';
import { PreviewOverlay } from './PreviewOverlay';
import { computedDeltaE, restoreComputedSettings } from './staleReasons';
import '../css/w2-colour-honesty.css';
import '../css/w3-viewer-features.css';
import '../css/w5-undo-editing.css';
import '../css/w6-compare-batch.css';
import '../css/w6-fix-ui.css';

/** Werkzeuge unter dem Viewer (Paket w6-compare-batch) */
type PreviewTool = 'deviation' | 'batch' | 'png';

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
  /** Viewer samt Zusatzebene (Abweichungskarte, gewählter Bereich) */
  const stage = useRef<HTMLDivElement>(null);
  /** Werkzeuge: Abweichung, Bereich bearbeiten, Bild (PNG) – null = zugeklappt */
  const [tool, setTool] = useState<PreviewTool | null>(null);
  const [overlayOn, setOverlayOn] = useState(false);
  const [scope, setScope] = useState<BatchScope>('rect');
  const [selection, setSelection] = useState<Range | null>(null);
  const [rectMode, setRectMode] = useState(false);
  const [sectionId, setSectionId] = useState<string | null>(null);
  /** zuletzt bearbeiteter Bereich (Umriss nach „Anwenden“, „Im Mosaik ansehen“) */
  const [result, setResult] = useState<Range | null>(null);
  /** Legende + Viewer (für „Karte an“: ins Bild holen) */
  const mapArea = useRef<HTMLDivElement>(null);
  /** Ansicht und Seitenposition vor dem Verschieben für das Blatt – beim Schließen wiederhergestellt (nur Antippen) */
  const beforeSheet = useRef<{ view: { scale: number; ox: number; oy: number }; scrollY: number } | null>(null);
  const c = api.computed;
  /** Breiter Bildschirm: Steindetail ersetzt die Seitenleiste neben dem Mosaik (kein Dialog darüber) */
  const wide = useMediaQuery(PANEL_QUERY);
  /** Finger statt Maus: Hinweis sagt „antippen“ statt „anklicken“ */
  const coarse = useCoarsePointer();
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

  // neues Raster: die Auswahl gehört zum alten
  useEffect(() => {
    setSelection(null);
    setRectMode(false);
    setResult(null);
  }, [c?.layout]);

  // ΔE-Formel und Farbmischung der BERECHNUNG (nicht eine inzwischen geänderte Einstellung)
  const recNow = api.rec;
  const formula = (recNow && computedDeltaE(recNow.computedWith)) ?? recNow?.settings.deltaE ?? '2000';
  const dither = useMemo(() => (recNow ? ((restoreComputedSettings(recNow)?.settings ?? recNow.settings).dither ?? 0) > 0 : false), [recNow]);
  const palNow = recNow?.palette;
  const hasTargets = !!c && hasPhotoTargets(c.data);
  const mapOn = overlayOn && hasTargets;
  // Abweichungskarte und Legendenzahlen: neu bei jeder Bearbeitung (version) und jeder Palettenänderung
  const devMap = useMemo(() => (mapOn && c && palNow ? deviationMap(c.layout, c.data, palNow, formula) : null), [mapOn, c, palNow, formula, api.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const devSummary = useMemo(() => (mapOn && c && palNow ? deviationSummary(c.data, palNow, formula) : null), [mapOn, c, palNow, formula, api.version]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const readOnly = !!api.computing || api.paletteLocked;
  /** Element ganz ins Bild holen, falls es (teilweise) außerhalb liegt – Werkzeuge stehen unter dem Mosaik */
  const reveal = (el: Element | null) => {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  /** Unterkante der klebenden Kopfzeile (darunter beginnt der sichtbare Bereich) */
  const barBottom = () => document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
  /**
   * Schmale Bildschirme: Das Steindetail liegt als Blatt unten über der Seite. Den Stein so legen, dass er im freien
   * Streifen ÜBER dem Blatt mittig liegt; reicht der sichtbare Teil des Mosaiks dafür nicht, erst die Seite schieben.
   * `onlyIfHidden`: nichts tun, wenn der Stein schon sichtbar über dem Blatt liegt. Liefert true, wenn bewegt wurde.
   */
  const placeAboveSheet = (xMm: number, yMm: number, onlyIfHidden: boolean): boolean => {
    const st = stage.current;
    const vw = viewer.current;
    const sheet = document.querySelector('.w5ue-stone-modal')?.closest('.modal');
    if (!st || !vw || !sheet) return false;
    const sheetTop = sheet.getBoundingClientRect().top;
    const bar = barBottom();
    let r = st.getBoundingClientRect();
    if (onlyIfHidden) {
      const v = vw.getView();
      const sy = r.top + v.oy + yMm * v.scale;
      if (sy > Math.max(r.top, bar) + 12 && sy < Math.min(r.bottom, sheetTop) - 12) return false;
    }
    const free = () => Math.min(r.bottom, sheetTop) - Math.max(r.top, bar);
    if (free() < Math.min(160, (sheetTop - bar) * 0.8)) {
      window.scrollBy({ top: r.top - bar - 4, left: 0, behavior: 'instant' as ScrollBehavior });
      r = st.getBoundingClientRect();
    }
    const top = Math.max(r.top, bar);
    const bottom = Math.min(r.bottom, sheetTop);
    if (bottom - top < 24) return true;
    const atY = (top + bottom) / 2 - r.top;
    if (onlyIfHidden) {
      // angetippter Stein: nur senkrecht schieben (waagrecht liegt er schon unter dem Finger)
      const v = vw.getView();
      vw.setView({ ...v, oy: atY - yMm * v.scale });
    } else vw.center(xMm, yMm, 0, atY);
    return true;
  };
  /** Stein (Mitte in mm) nach dem Öffnen des Blatts über dem Blatt zeigen – zwei Bilder später steht seine Höhe fest */
  const afterSheet = (row: number, col: number, onlyIfHidden: boolean, restore: boolean) => {
    const x = c.layout.colX[col] + c.layout.colW[col] / 2;
    const y = c.layout.rowY[row] + c.layout.rowH[row] / 2;
    const prev = viewer.current ? { view: viewer.current.getView(), scrollY: window.scrollY } : null;
    beforeSheet.current = null;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (placeAboveSheet(x, y, onlyIfHidden) && restore) beforeSheet.current = prev;
      }),
    );
  };
  /** Stein im Mosaik angetippt: öffnen; am Handy nur verschieben, wenn das Blatt ihn verdecken würde */
  const onPickStone = (row: number, col: number, piece: number) => {
    setPick({ row, col, piece });
    if (!wide) afterSheet(row, col, true, true);
  };
  /** Steindetail schließen – nach einer Verschiebung für das Blatt die vorige Ansicht wiederherstellen */
  const closeStone = () => {
    setPick(null);
    const prev = beforeSheet.current;
    beforeSheet.current = null;
    if (!prev) return;
    viewer.current?.setView(prev.view);
    window.scrollTo({ top: prev.scrollY, left: 0, behavior: 'instant' as ScrollBehavior });
  };
  /** Stein zeigen (mittig bzw. über dem Blatt) und öffnen */
  const showStone = (row: number, col: number, piece: number) => {
    onFound(row, col, piece);
    if (!wide) afterSheet(row, col, false, false);
  };
  /** Sprung aus der Liste „Größte Abweichungen“: Stein zeigen und öffnen, Mosaik ins Bild holen */
  const onJump = (row: number, col: number, piece: number) => {
    if (!wide) {
      showStone(row, col, piece);
      return;
    }
    onFound(row, col, piece);
    reveal(stage.current);
  };
  /** „Bereich aufziehen“: Mosaik ins Bild holen */
  const setRectModeShow = (on: boolean) => {
    setRectMode(on);
    if (on) reveal(stage.current);
  };
  /** Legende und Mosaik ganz oben unter der Kopfzeile zeigen (Karte an, Ergebnis ansehen) */
  const revealMap = () => {
    const el = mapArea.current;
    if (!el || typeof el.scrollIntoView !== 'function') return;
    const r = el.getBoundingClientRect();
    const bar = barBottom();
    if (r.top < bar - 1 || r.top > Math.max(bar + 80, window.innerHeight * 0.35)) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  /** Abweichungskarte an/aus – beim Einschalten das Mosaik ins Bild holen */
  const setMap = (on: boolean) => {
    setOverlayOn(on);
    if (on) requestAnimationFrame(() => revealMap());
  };
  /** Ergebnis der Bereichsbearbeitung hervorheben; `go`: hinzoomen und Mosaik ins Bild holen */
  const onShowResult = (where: Range | 'all', go: boolean) => {
    const rg = where === 'all' ? { r0: 0, r1: c.layout.rows, c0: 0, c1: c.layout.cols } : where;
    setResult(rg);
    if (!go) return;
    setPick(null);
    if (where === 'all') viewer.current?.fit();
    else {
      const x0 = c.layout.colX[rg.c0];
      const y0 = c.layout.rowY[rg.r0];
      const x1 = c.layout.colX[rg.c1 - 1] + c.layout.colW[rg.c1 - 1];
      const y1 = c.layout.rowY[rg.r1 - 1] + c.layout.rowH[rg.r1 - 1];
      viewer.current?.zoomTo({ x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) });
    }
    setFlash({ idx: rg.r0 * c.layout.cols + rg.c0, piece: 0 });
    requestAnimationFrame(() => revealMap());
  };
  /** Viewer im Modus „Rechteck aufziehen“ */
  const rectActive = tool === 'batch' && scope === 'rect' && rectMode;
  /** Umriss im Mosaik: Auswahl (Bereich bearbeiten, Rechteck) bzw. zuletzt geänderter Bereich */
  const outline = tool === 'batch' && scope === 'rect' && selection ? selection : tool === 'batch' ? result : null;
  const batchSection = tool === 'batch' && scope === 'section' ? sectionId : null;
  const toolBtn = (id: PreviewTool, label: string) => (
    <button
      type="button"
      className={`w6cb-tab ${tool === id ? 'active' : ''}`}
      aria-expanded={tool === id}
      aria-controls="w6cb-tool-body"
      onClick={() => {
        setTool(tool === id ? null : id);
        if (id !== 'batch') setRectMode(false);
        setResult(null);
      }}
      data-testid={`tool-${id}`}
    >
      {label}
      {id === 'deviation' && mapOn && <span className="w6cb-dot" aria-hidden="true" />}
    </button>
  );

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
      // Abweichung zum Foto im Steindetail, solange das Werkzeug „Abweichung“ offen oder die Karte an ist (sonst bleibt die
      // Farbreihe am Handy ohne Blättern sichtbar)
      photoFormula={tool === 'deviation' || mapOn ? formula : undefined}
      shortSheet
      onClose={closeStone}
      onNavigate={(row, col, piece) => setPick({ row, col, piece })}
      onEdit={api.editCell}
    />
  );

  return (
    <div className="viewer-layout">
      <div>
        <div className="w5ue-toolbar">
          <HistoryButtons api={api} />
          <button
            type="button"
            className={`btn small w6cb-quick ${mapOn ? 'active' : ''}`}
            aria-pressed={mapOn}
            aria-label={t('w6cb.quick')}
            disabled={!hasTargets}
            title={hasTargets ? t('w6cb.overlayHint') : t('w6cb.legacy')}
            onClick={() => setMap(!overlayOn)}
            data-testid="deviation-quick"
          >
            <span className="w6fx-q-icon" aria-hidden="true" />
            <span className="w6fx-q-long">{t('w6cb.quick')}</span>
            <span className="w6fx-q-short" aria-hidden="true">
              {t('w6fx.quickShort')}
            </span>
          </button>
          {api.stale && <Badge kind="warn">{t('preview.stale')}</Badge>}
          {api.materialsChanged && (
            <span title={t('w3lp.materialsChanged')} data-testid="preview-materials-changed">
              <Badge kind="warn">{t('w3lp.materialsChangedBadge')}</Badge>
            </span>
          )}
          <HistoryStatus api={api} />
        </div>
        <div className="w6fx-map-area" ref={mapArea}>
          {mapOn && <DeviationLegend summary={devSummary} dither={dither} stale={api.stale} formula={formula} />}
          <div className="w6cb-stage" ref={stage}>
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
              sections={showSections || batchSection ? api.sections : null}
              selectedSection={batchSection}
              highlight={pick}
              focusColor={focus}
              rulers={rulers}
              flash={flash}
              compareImage={comparing ? reference : null}
              compareSplit={hold ? 1 : split}
              onCompareSplit={compareOn && !hold ? setSplit : undefined}
              onPick={onPickStone}
              mode={rectActive ? 'rect' : 'tap'}
              onRect={(rg) => {
                setSelection(rg);
                setRectMode(false);
                setResult(null);
                // breite Bildschirme: danach die Aktionen zeigen; schmale: Auswahl bleibt sichtbar, die Leiste führt weiter
                if (wide) requestAnimationFrame(() => reveal(document.querySelector('[data-testid="batch-panel"]')));
              }}
            />
            <PreviewOverlay stage={stage} viewer={viewer} layout={c.layout} rulers={rulers} deviation={devMap} selection={outline} />
            {rectActive && (
              <div className="w6fx-banner" role="status" data-testid="rect-banner">
                <span>{t(deviceKey('w6fx.rect.banner', coarse))}</span>
                <button type="button" className="btn small" onClick={() => setRectMode(false)} data-testid="rect-banner-cancel">
                  {t('w6fx.rect.cancel')}
                </button>
              </div>
            )}
            {!rectActive && tool === 'batch' && scope === 'rect' && selection && !wide && (
              <div className="w6fx-banner" role="status" data-testid="selection-banner">
                <span>
                  {t('w6fx.sel.banner', {
                    range: rangeLabel(c.layout, selection),
                    cells: t('w6cb.allInfo', { cells: n(rangeCells(selection)) }),
                  })}
                </span>
                <button type="button" className="btn small primary" onClick={() => reveal(document.querySelector('[data-testid="batch-panel"]'))} data-testid="selection-banner-actions">
                  {t('w6fx.sel.actions')}
                </button>
              </div>
            )}
          </div>
        </div>
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
        <p className="muted small" data-testid="preview-hint">{t(deviceKey('w5fu.previewHint', coarse))}</p>
        <section className="w6cb-tools" aria-labelledby="w6fx-tools-h" data-testid="preview-tools">
          <h3 className="w6fx-tools-h" id="w6fx-tools-h">
            {t('w6fx.tools.heading')}
          </h3>
          <div className="w6cb-tabs" role="group" aria-label={t('w6cb.toolsTitle')}>
            {toolBtn('deviation', t('w6cb.tab.deviation'))}
            {toolBtn('batch', t('w6cb.tab.batch'))}
            {toolBtn('png', t('w6cb.tab.png'))}
          </div>
          <div id="w6cb-tool-body">
            {tool === 'deviation' && (
              <DeviationPanel
                api={api}
                layout={c.layout}
                data={c.data}
                palette={palette}
                formula={formula}
                dither={dither}
                overlayOn={overlayOn}
                setOverlayOn={setMap}
                onJump={onJump}
              />
            )}
            {tool === 'batch' && (
              <BatchPanel
                api={api}
                layout={c.layout}
                data={c.data}
                palette={palette}
                formula={formula}
                minPieceMm={rec.settings.shapes.minPieceMm}
                readOnly={readOnly}
                sections={api.sections}
                scope={scope}
                setScope={setScope}
                selection={selection}
                setSelection={setSelection}
                rectMode={rectMode}
                setRectMode={setRectModeShow}
                sectionId={sectionId}
                setSectionId={setSectionId}
                coarse={coarse}
                onShow={onShowResult}
              />
            )}
            {tool === 'png' && (
              <PngExportPanel
                layout={c.layout}
                data={c.data}
                palette={palette}
                name={rec.meta.name}
                groutHex={rec.settings.groutHex}
                surface={rec.settings.surface}
                realistic={realistic}
                codes={codes}
                sections={api.sections}
                selection={selection}
                sectionId={sectionId}
              />
            )}
          </div>
        </section>
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
