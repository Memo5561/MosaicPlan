import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { paletteDisplayName } from '../../core/colorNames';
import { setRangePlaced, togglePiecePlaced } from '../../core/edits';
import { bbox } from '../../core/geometry';
import {
  captureCells,
  captureRange,
  ColorProgressCounter,
  forEachChanged,
  isRefPlaced,
  layingOrder,
  nextUnplaced,
  orderPosOf,
  rangeCounts,
  readLayingPrefs,
  refIdx,
  refPiece,
  rowBlock,
  setPiecesPlaced,
  writeLayingPrefs,
  type LayingOrderKind,
  type ProgressSnapshot,
} from '../../core/laying';
import { cellId, pieceId, rowLabel, type Layout, type Section } from '../../core/layout';
import { analyzeCut, cellPieceCount, cellPieces } from '../../core/pieces';
import { rulerInsets } from '../../core/render';
import { packMosaic } from '../../core/serialize';
import { makeRawSizeFn, type Range } from '../../core/stats';
import type { Material, MosaicData, PaletteColor } from '../../core/types';
import { tCount, useI18n } from '../../i18n';
import { runWorker } from '../../workers/client';
import { Badge, downloadBlob, Field, NumberInput, ProgressBar, safeFileName, Segmented, Swatch, Toggle } from '../components';
import { CutTemplateSvg } from './CutTemplateSvg';
import { FindStone } from './FindStone';
import { historyEventText, HistoryButtons, historyLabelText, shortcutText, useHistoryShortcuts } from './HistoryControls';
import { MaterialCalc } from './MaterialCalc';
import { stepHash } from './stepNav';
import { cutInstructionItems, StoneDialog } from './StoneDialog';
import { MAX_SCALE } from './touchTap';
import type { EditResult, ProjectApi } from './useProject';
import type { HistoryFlash, HistoryLabel } from '../../core/journal';
import { laidPercentAt } from '../../storage/db';
import { Viewer, type OutsideTap, type PieceRef, type ViewerHandle, type ViewerMode } from './Viewer';
import '../css/w1-review-fixes.css';
import '../css/w4-laying-workbench.css';
import '../css/w4-review-fixes.css';
import '../css/w5-undo-editing.css';

export { MaterialCalc } from './MaterialCalc';

/**
 * Eintrag im Verlauf (Rückgängig/Wiederholen, gemeinsam mit Farb-, Form- und Palettenänderungen – siehe
 * useProject/core/journal.ts): Text für die Statuszeile, ggf. der eine geänderte Stein (Hervorhebung). Der Verlauf
 * gehört zum berechneten Mosaik und übersteht das Verlassen von Schritt 9; Neuberechnen, Verlassen des Projekts
 * oder Neuladen leeren ihn.
 */
interface UndoMeta {
  label: string;
  flash?: PieceRef;
}

/** Mehr geänderte Zellen werden nicht einzeln gemeldet (useProject zählt dann neu) */
const DIRTY_MAX = 500_000;
/** Statusmeldung verschwindet nach … ms */
const STATUS_MS = 6000;
/** Stein der Karte „Nächster Stein“ mindestens so groß (CSS-px) zeigen */
const CARD_STONE_PX = 36;

export function StepPlan({ api, materials }: { api: ProjectApi; materials: Material[] }) {
  const { t, n, lang } = useI18n();
  const rec = api.rec!;
  const projectId = rec.meta.id;
  const prefs0 = useMemo(() => readLayingPrefs(projectId), [projectId]);
  const [view, setView] = useState<'lay' | 'material'>('lay');
  const [selected, setSelected] = useState<string | null>(prefs0.section);
  const [layMode, setLayMode] = useState(false);
  const [tool, setTool] = useState<ViewerMode>('tap');
  const [pick, setPick] = useState<{ row: number; col: number; piece: number } | null>(null);
  /** hervorgehobener Stein (gefunden bzw. Karte „Nächster Stein“) */
  const [marker, setMarker] = useState<{ row: number; col: number; piece: number } | null>(null);
  const [flash, setFlash] = useState<PieceRef | null>(null);
  const [focusColor, setFocusColor] = useState<number | null>(null);
  const [orderKind, setOrderKind] = useState<LayingOrderKind>(prefs0.order);
  const [cardOpen, setCardOpen] = useState(false);
  const [cardPos, setCardPos] = useState(-1);
  const cardHistory = useRef<number[]>([]);
  const cardCode = useRef<number | null>(null);
  const [status, setStatusState] = useState<{ text: string; id: number } | null>(null);
  const [outsideAsk, setOutsideAsk] = useState<{ id: string; sec: string; atBottom?: boolean } | null>(null);
  /** atBottom: Rechteck liegt in der oberen Hälfte des Viewers – Rückfrage unten anzeigen, damit sie es nicht verdeckt */
  const [pendingRect, setPendingRect] = useState<{ range: Range; placed: number; total: number; atBottom: boolean } | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const undoSize = api.history.undoCount;
  const redoSize = api.history.redoCount;
  const viewer = useRef<ViewerHandle>(null);
  const viewerBox = useRef<HTMLDivElement>(null);
  const cardBox = useRef<HTMLDivElement>(null);
  const wide = useMedia('(min-width: 981px)');
  const c = api.computed;
  const s = rec.settings;
  const G = api.sections;
  const sec = useMemo(() => G?.sections.find((x) => x.id === selected) ?? null, [G, selected]);
  // Während einer Berechnung dieses Projekts (hier, in einer früheren Ansicht im Hintergrund oder in einem anderen
  // Tab) ist das angezeigte Mosaik schreibgeschützt: es wird gleich ersetzt (siehe useProject, computeLock)
  const locked = !!api.computing || api.paletteLocked;
  const apiRef = useRef(api);
  apiRef.current = api;
  /** aktueller Stand (z. B. nach einer Rückfrage, während der eine Berechnung begonnen haben kann) */
  const apiComputing = () => !!apiRef.current.computing || apiRef.current.paletteLocked;
  const layActive = layMode && !locked && view === 'lay';

  useEffect(() => {
    if (locked) {
      setLayMode(false);
      setPendingRect(null);
    }
  }, [locked]);
  // gewählten Abschnitt und Reihenfolge merken (nur dieser Browser, nur Komfort)
  useEffect(() => {
    writeLayingPrefs(projectId, { section: selected, order: orderKind });
  }, [projectId, selected, orderKind]);
  // gemerkter Abschnitt existiert nach geänderter Einteilung nicht mehr
  useEffect(() => {
    if (G && selected && !G.sections.some((x) => x.id === selected)) setSelected(null);
  }, [G, selected]);
  useHistoryShortcuts(api);
  // Statusmeldung nach einigen Sekunden ausblenden
  useEffect(() => {
    if (!status) return;
    const h = window.setTimeout(() => setStatusState((x) => (x?.id === status.id ? null : x)), STATUS_MS);
    return () => window.clearTimeout(h);
  }, [status]);

  /** offene/verlegte Steine je Farbe im Abschnitt (bzw. im ganzen Mosaik) – nach Änderungen nur nachgeführt */
  const counter = useMemo(
    () => (c ? ColorProgressCounter.build(c.layout, c.data, sec) : null),
    // Mosaikänderungen (version) und angewendetes Rückgängig/Wiederholen (history.applied) bauen neu auf;
    // eigene Fortschrittsänderungen werden in commit() bzw. onDialogEdit nachgeführt
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [c, api.version, sec, api.history.applied],
  );

  /** Verlegereihenfolge der Karte „Nächster Stein“ (nur geöffnet) */
  const order = useMemo(
    () =>
      c && cardOpen
        ? layingOrder(c.layout, c.data, sec, { order: orderKind, color: focusColor, colorRank: (k) => rec.palette[k]?.code ?? Number.MAX_SAFE_INTEGER })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [c, api.version, sec, orderKind, focusColor, cardOpen, rec.palette],
  );
  // neue Reihenfolge: beim bisherigen Stein bleiben, sonst erster offener Stein
  useEffect(() => {
    cardHistory.current = [];
    if (!order || !c) {
      setCardPos(-1);
      return;
    }
    const prev = cardCode.current;
    const keep = prev !== null ? orderPosOf(order, refIdx(prev), refPiece(prev)) : -1;
    setCardPos(keep >= 0 && !isRefPlaced(c.data, prev!) ? keep : nextUnplaced(order, c.data, 0));
    // c.data gehört zu c
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order]);
  const code = order && cardPos >= 0 && cardPos < order.length ? order[cardPos] : null;
  cardCode.current = code;
  // Stein der Karte hervorheben und ins Bild holen
  useEffect(() => {
    if (!c || code === null) return;
    const idx = refIdx(code);
    const row = Math.floor(idx / c.layout.cols);
    const hit = { row, col: idx - row * c.layout.cols, piece: refPiece(code) };
    setMarker(hit);
    showStone(hit.row, hit.col, hit.piece, false);
    // showStone liest nur Refs und das aktuelle Raster
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, c]);

  const wake = useWakeLock(layActive);

  // Rückgängig/Wiederholen (Knöpfe, Strg+Z – auch aus Schritt 8): Statuszeile und Hervorhebung
  const lastEv = api.history.last;
  const seenEv = useRef(lastEv?.seq ?? 0);
  useEffect(() => {
    if (!lastEv || lastEv.seq === seenEv.current) return;
    seenEv.current = lastEv.seq;
    setStatusState({ text: historyEventText(lastEv, t), id: lastEv.seq + Math.random() });
    if ((lastEv.kind === 'undo' || lastEv.kind === 'redo') && lastEv.flash) setFlash({ ...lastEv.flash });
    setOutsideAsk(null);
    // t wechselt nur mit der Sprache
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEv]);

  /**
   * Stein ins Bild holen: nur verschieben/zoomen, wenn er nicht gut sichtbar ist (oder `force`). „Sichtbar“ heißt
   * im freien Teil des Mosaiks – ohne Lineal, Zoomknöpfe und ohne das, was darüber klebt (Kopfzeile, Schrittleiste,
   * unten die Karte „Nächster Stein“ und die Schrittnavigation auf dem Handy).
   */
  function showStone(row: number, col: number, piece: number, force: boolean) {
    const cc = apiRef.current.computed;
    if (!cc) return;
    const ps = cellPieces(cc.layout, cc.data, row, col);
    const p = ps[piece] ?? ps[0];
    if (!p) return;
    const b = bbox(p.poly);
    const minSide = Math.max(0.1, Math.min(b.maxX - b.minX, b.maxY - b.minY));
    const want = Math.min(MAX_SCALE, CARD_STONE_PX / minSide);
    const box = viewerBox.current;
    const cv = box?.querySelector<HTMLCanvasElement>('canvas[data-testid="mosaic-canvas"]');
    if (!box || !cv) {
      viewer.current?.center((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, want);
      return;
    }
    let band = visibleBand(cv, cardBox.current);
    // Mosaik kaum zu sehen (weggescrollt oder von der Karte verdeckt): erst den Viewer ins Bild holen
    if (band.bottom - band.top < Math.min(160, cv.getBoundingClientRect().height * 0.4)) {
      box.scrollIntoView({ block: 'start' });
      band = visibleBand(cv, cardBox.current);
    }
    const ins = rulerInsets(cc.layout, true);
    const r = cv.getBoundingClientRect();
    const left = ins.left + 4;
    const right = r.width - 56;
    const top = Math.max(ins.top + 4, band.top - r.top + 4);
    const bottom = Math.min(r.height - 6, band.bottom - r.top - 6);
    const scale = parseFloat(cv.dataset.scale ?? '');
    const ox = parseFloat(cv.dataset.ox ?? '');
    const oy = parseFloat(cv.dataset.oy ?? '');
    if (!(Number.isFinite(scale) && scale > 0 && Number.isFinite(ox) && Number.isFinite(oy))) {
      viewer.current?.center((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, want);
      return;
    }
    if (!force && ox + b.minX * scale >= left && ox + b.maxX * scale <= right && oy + b.minY * scale >= top && oy + b.maxY * scale <= bottom && minSide * scale >= CARD_STONE_PX * 0.6)
      return;
    // center() setzt die Weltkoordinate in die Mitte des Bereichs rechts/unter dem Lineal – so verschoben, dass der
    // Stein in der Mitte des freien Bereichs liegt
    const s2 = Math.max(scale, want);
    const cx = ins.left + (r.width - ins.left) / 2;
    const cy = ins.top + (r.height - ins.top) / 2;
    const tx = bottom > top ? (left + right) / 2 : cx;
    const ty = bottom > top ? (top + bottom) / 2 : cy;
    viewer.current?.center((b.minX + b.maxX) / 2 - (tx - cx) / s2, (b.minY + b.maxY) / 2 - (ty - cy) / s2, want);
  }

  if (!c || !G) return <p className={api.integrityError ? 'error' : 'muted'}>{t(api.integrityError ? 'compute.err.integrity' : 'preview.notComputed')}</p>;
  const L = c.layout;
  const data = c.data;
  const pr = api.progress;
  const pct = pr && pr.total.total ? pr.total.placed / pr.total.total : 0;
  // gleiche Regel wie „Meine Projekte“ (laidPercentAt): abgerundet, nie „0 %“ mit verlegten Steinen, „100 %“ nur fertig
  const pctShown = pr ? laidPercentAt(pr.total.placed, pr.total.total, 1) : { value: 0, lessThan: false };
  const pctText = pctShown.lessThan ? `< ${n(0.1, 1)} %` : `${n(pctShown.value, 1)} %`;
  const doneSections = G.sections.filter((x) => {
    const st = pr?.perSection.get(x.id);
    return st && st.total > 0 && st.placed === st.total;
  }).length;
  const scopeText = sec ? t('w4lw.scope.sec', { sec: sec.id }) : t('w4lw.scope.all');

  const setStatus = (text: string) => setStatusState({ text, id: Date.now() + Math.random() });
  const bump = () => setTick((x) => x + 1);

  /**
   * Nach einer Änderung am Fortschritt: Zähler je Farbe nachführen, Rückgängig-Eintrag anlegen, speichern lassen.
   * Liefert die Anzahl geänderter Zellen (0: nichts geändert, kein Eintrag).
   */
  const commit = (snap: ProgressSnapshot, meta: UndoMeta): number => {
    const dirty: number[] = [];
    forEachChanged(L, data, snap, (idx, before, now) => {
      counter?.update(data, idx, before, now);
      dirty.push(idx);
    });
    if (!dirty.length) return 0;
    // in den gemeinsamen Verlauf (Rückgängig/Wiederholen exakt, nur solange niemand die Steine anders geändert hat)
    api.recordProgress(snap, { text: meta.label }, meta.flash);
    api.touchProgress(dirty.length > DIRTY_MAX ? undefined : dirty);
    setOutsideAsk(null);
    bump();
    return dirty.length;
  };

  // Status und Hervorhebung kommen über api.history.last (siehe oben); Zähler über history.applied
  const doUndo = () => {
    if (!apiComputing()) api.undo();
  };
  const doRedo = () => {
    if (!apiComputing()) api.redo();
  };

  // ---------------------------------------------------------------- Markieren
  const onPick = (row: number, col: number, piece: number) => {
    if (!layActive) {
      setPick({ row, col, piece });
      return;
    }
    if (pendingRect || apiComputing()) return;
    const idx = row * L.cols + col;
    const cnt = cellPieceCount(data, idx);
    if (piece >= cnt) return;
    const snap = captureCells(data, [idx]);
    const nowLaid = togglePiecePlaced(data, idx, piece);
    const label = t(nowLaid ? 'w4lw.st.laidOne' : 'w4lw.st.openOne', { id: pieceId(L, row, col, piece, cnt) });
    commit(snap, { label, flash: { idx, piece } });
    setStatus(label);
    setFlash({ idx, piece });
  };

  const onPaint = (pieces: PieceRef[], set: boolean) => {
    if (!layActive || pendingRect || apiComputing() || !pieces.length) return;
    const snap = captureCells(
      data,
      pieces.map((p) => p.idx),
    );
    const changed = setPiecesPlaced(data, pieces, set);
    if (!changed) {
      setStatus(t('w4lw.st.nothing'));
      return;
    }
    let label = tCount(t, set ? 'w4lw.st.laidN' : 'w4lw.st.openN', changed, { n: n(changed) });
    let fl: PieceRef | undefined;
    if (pieces.length === 1) {
      const p = pieces[0];
      const row = Math.floor(p.idx / L.cols);
      label = t(set ? 'w4lw.st.laidOne' : 'w4lw.st.openOne', { id: pieceId(L, row, p.idx - row * L.cols, p.piece, cellPieceCount(data, p.idx)) });
      fl = { ...p };
      setFlash(fl);
    }
    commit(snap, { label, flash: fl });
    setStatus(label);
  };

  const onRect = (range: Range) => {
    if (!layActive || apiComputing()) return;
    const cnt = rangeCounts(L, data, range);
    setOutsideAsk(null);
    const yMid = (L.rowY[range.r0] + L.rowY[range.r1 - 1] + L.rowH[range.r1 - 1]) / 2;
    setPendingRect({ range, placed: cnt.placed, total: cnt.total, atBottom: barAtBottom(yMid) });
  };
  /**
   * Rückfrage-Leiste unten statt oben? Nur, wenn die Unterkante des Viewers zu sehen ist. `yMid` (mm im Mosaik):
   * liegt diese Stelle in der oberen Hälfte des sichtbaren Mosaiks, kommt die Leiste nach unten (verdeckt sie nicht);
   * ohne `yMid` (Rückfrage „wechseln?“): unten, wenn oben nicht zu sehen ist oder auf schmalen Bildschirmen (dort steht
   * oben links die Abschnittsbezeichnung).
   */
  function barAtBottom(yMid?: number): boolean {
    const cv = viewerBox.current?.querySelector<HTMLCanvasElement>('canvas[data-testid="mosaic-canvas"]');
    if (!cv) return false;
    const r = cv.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const topVisible = r.top >= -1;
    const bottomVisible = r.bottom <= vh + 1;
    if (!bottomVisible) return false;
    if (!topVisible) return true;
    if (yMid === undefined) return !wide;
    const scale = parseFloat(cv.dataset.scale ?? '');
    const oy = parseFloat(cv.dataset.oy ?? '');
    if (!(scale > 0) || !Number.isFinite(oy)) return false;
    const visTop = Math.max(r.top, 0);
    const visBottom = Math.min(r.bottom, vh);
    return r.top + oy + yMid * scale < (visTop + visBottom) / 2;
  }
  const applyRect = (set: boolean) => {
    const pr0 = pendingRect;
    setPendingRect(null);
    if (!pr0 || apiComputing()) return;
    const snap = captureRange(L, data, pr0.range);
    setRangePlaced(L, data, pr0.range, set);
    let changed = 0;
    forEachChanged(L, data, snap, (_idx, before, now) => {
      for (let v = before ^ now; v; v &= v - 1) changed++;
    });
    const what = tCount(t, set ? 'w4lw.st.laidN' : 'w4lw.st.openN', changed, { n: n(changed) });
    const label = t('w4lw.st.range', { from: cellId(L, pr0.range.r0, pr0.range.c0), to: cellId(L, pr0.range.r1 - 1, pr0.range.c1 - 1), what });
    if (!commit(snap, { label })) {
      setStatus(t('w4lw.st.nothing'));
      return;
    }
    setStatus(label);
  };

  const onOutside = (o: OutsideTap) => {
    if (!layActive || !o.sectionId) return;
    setOutsideAsk({ id: pieceId(L, o.row, o.col, o.piece, cellPieceCount(data, o.row * L.cols + o.col)), sec: o.sectionId, atBottom: barAtBottom() });
  };

  const selectSection = (x: Section) => {
    setSelected(x.id);
    setOutsideAsk(null);
    setPendingRect(null);
    viewer.current?.zoomTo(x);
  };

  const sectionDone = () => {
    if (!sec || apiComputing()) return;
    const before = rangeCounts(L, data, sec);
    const snap = captureRange(L, data, sec);
    setRangePlaced(L, data, sec, true);
    const label = t('w4lw.st.sectionDone', { sec: sec.id, total: n(before.total), n: n(before.total - before.placed) });
    setStatus(commit(snap, { label }) ? label : t('w4lw.st.nothing'));
  };
  const sectionReset = () => {
    if (!sec) return;
    if (!confirm(t('plan.resetConfirm'))) return;
    if (apiComputing()) return;
    const before = rangeCounts(L, data, sec);
    const snap = captureRange(L, data, sec);
    setRangePlaced(L, data, sec, false);
    const label = t('w4lw.st.sectionReset', { sec: sec.id, n: n(before.placed) });
    setStatus(commit(snap, { label }) ? label : t('w4lw.st.nothing'));
  };

  // ---------------------------------------------------------------- Karte „Nächster Stein“
  const openCard = () => {
    setCardOpen(true);
    // Mosaik ganz ins Bild holen (am Desktop reicht es sonst unter den Bildschirmrand)
    if (wide) window.setTimeout(() => viewerBox.current?.scrollIntoView({ block: 'nearest' }), 0);
  };
  const closeCard = () => {
    setCardOpen(false);
    setMarker(null);
  };
  const goTo = (pos: number) => {
    if (!order) return;
    if (cardPos >= 0) cardHistory.current.push(cardPos);
    setCardPos(pos);
    bump();
  };
  const cardLayNext = () => {
    if (!order || code === null || apiComputing()) return;
    const idx = refIdx(code);
    const piece = refPiece(code);
    if (!isRefPlaced(data, code)) {
      const snap = captureCells(data, [idx]);
      setPiecesPlaced(data, [{ idx, piece }], true);
      const row = Math.floor(idx / L.cols);
      const label = t('w4lw.st.laidOne', { id: pieceId(L, row, idx - row * L.cols, piece, cellPieceCount(data, idx)) });
      commit(snap, { label, flash: { idx, piece } });
      setStatus(label);
      setFlash({ idx, piece });
    }
    goTo(nextUnplaced(order, data, cardPos + 1));
  };
  const cardSkip = () => {
    if (!order || cardPos < 0) return;
    goTo(nextUnplaced(order, data, cardPos + 1));
  };
  const cardBack = () => {
    const p = cardHistory.current.pop();
    if (p === undefined) return;
    setCardPos(p);
    bump();
  };
  const cardRowDone = () => {
    if (!order || code === null || apiComputing()) return;
    const [a, b] = rowBlock(order, L.cols, cardPos);
    const refs = Array.from(order.subarray(a, b), (k) => ({ idx: refIdx(k), piece: refPiece(k) }));
    const snap = captureCells(
      data,
      refs.map((r) => r.idx),
    );
    const changed = setPiecesPlaced(data, refs, true);
    const row = Math.floor(refIdx(code) / L.cols);
    const label = t('w4lw.st.row', { row: rowLabel(row), scope: scopeText, what: tCount(t, 'w4lw.st.laidN', changed, { n: n(changed) }) });
    if (commit(snap, { label })) setStatus(label);
    else setStatus(t('w4lw.st.nothing'));
    goTo(nextUnplaced(order, data, b));
  };

  // ---------------------------------------------------------------- Steindetail (jede Änderung mit Verlauf)
  /** Änderung im Steindetail: über api.editCell (Verlauf); Farbzähler bei reiner Verlegeänderung nachführen */
  const onDialogEdit = (idx: number, mutate: () => void, label: HistoryLabel, flash?: HistoryFlash): EditResult | null => {
    const before = data.progress[idx];
    const res = api.editCell(idx, mutate, label, flash);
    if (res?.changed) {
      // Formänderungen bauen die Zähler über api.version neu auf; nur „verlegt“ wird hier nachgeführt
      if (!res.mosaic && res.progress) counter?.update(data, idx, before, data.progress[idx]);
      setStatus(historyLabelText(label, t));
      setOutsideAsk(null);
    }
    bump();
    return res;
  };


  // ---------------------------------------------------------------- Exporte
  const exportCsv = async (ids: string[] | null) => {
    setCsvBusy(true);
    setCsvError(null);
    try {
      const r = await runWorker<'csv'>('pdf', {
        type: 'csv',
        layoutParams: c.layoutParams,
        mosaic: packMosaic(c.data),
        palette: rec.palette,
        materials,
        sections: s,
        sectionIds: ids,
        decimalComma: lang !== 'en',
        lang,
      });
      await downloadBlob(new Blob(['﻿', r.csv], { type: 'text/csv;charset=utf-8' }), `${safeFileName(rec.meta.name)}${ids ? `_${ids.join('-')}` : ''}_koordinaten.csv`);
    } catch (e) {
      setCsvError(t('w4lw.csvError', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setCsvBusy(false);
    }
  };
  const pdfForSection = (id: string) => {
    api.update((r) => ({ ...r, pdfOptions: { ...(r.pdfOptions ?? {}), sectionIds: [id] } }));
    location.hash = stepHash(projectId, 'pdf');
  };

  const toggleLay = (v: boolean) => {
    setLayMode(v);
    if (!v) {
      setTool('tap');
      setPendingRect(null);
      setOutsideAsk(null);
      setCardOpen(false);
      setMarker(null);
    }
  };

  const onFound = (row: number, col: number, piece: number) => {
    const idx = row * L.cols + col;
    setMarker({ row, col, piece });
    setFlash({ idx, piece });
    setStatus(t('w4lw.st.found', { id: pieceId(L, row, col, piece, cellPieceCount(data, idx)) }));
    if (layActive && sec && (row < sec.r0 || row >= sec.r1 || col < sec.c0 || col >= sec.c1)) {
      const other = G.sections.find((x) => row >= x.r0 && row < x.r1 && col >= x.c0 && col < x.c1);
      if (other) setOutsideAsk({ id: pieceId(L, row, col, piece, cellPieceCount(data, idx)), sec: other.id, atBottom: barAtBottom() });
    }
    if (wide) viewerBox.current?.scrollIntoView({ block: 'nearest' });
    showStone(row, col, piece, true);
    // außerhalb des Verlegemodus wie Antippen: Steindetail öffnen (im Verlegemodus nur zeigen, nie verlegen)
    if (!layActive) setPick({ row, col, piece });
  };

  /** Steindetail: auf breiten Bildschirmen anstelle der Seitenleiste (Mosaik bleibt bedienbar), sonst als Dialog */
  const stone = pick && (
    <StoneDialog
      layout={L}
      data={data}
      palette={rec.palette}
      materials={materials}
      sections={G}
      row={pick.row}
      col={pick.col}
      piece={pick.piece}
      minPieceMm={s.shapes.minPieceMm}
      readOnly={locked}
      variant={wide && view === 'lay' ? 'panel' : 'modal'}
      history={<HistoryButtons api={api} testIdPrefix="stone-history" compact />}
      paletteMode={s.paletteMode}
      deltaE={s.deltaE}
      onClose={() => setPick(null)}
      onNavigate={(row, col, piece) => setPick({ row, col, piece })}
      onEdit={onDialogEdit}
    />
  );

  const openForCard = focusColor !== null ? counter?.counts.get(focusColor) : counter?.totals();
  const card = layActive && cardOpen && (
    <NextStoneCard
      compact={!wide}
      boxRef={cardBox}
      layout={L}
      data={data}
      palette={rec.palette}
      materials={materials}
      code={code}
      pos={cardPos}
      total={order?.length ?? 0}
      open={openForCard ? openForCard.total - openForCard.placed : 0}
      scopeText={scopeText}
      colorCode={focusColor !== null ? String(rec.palette[focusColor]?.code ?? '?').padStart(2, '0') : null}
      order={orderKind}
      onOrder={setOrderKind}
      onLayNext={cardLayNext}
      onBack={cardBack}
      canBack={cardHistory.current.length > 0}
      onSkip={cardSkip}
      onRowDone={cardRowDone}
      onDetails={() => {
        if (code === null) return;
        const idx = refIdx(code);
        const row = Math.floor(idx / L.cols);
        setPick({ row, col: idx - row * L.cols, piece: refPiece(code) });
      }}
      onClose={closeCard}
      locked={locked}
    />
  );

  return (
    <div className="w4lw">
      <div className="summary-box">
        <div className="stat">
          <span>{t('plan.progress')}</span>
          <b data-testid="progress-pct">{pctText}</b>
        </div>
        <div className="stat">
          <span>{t('plan.placed')}</span>
          <b data-testid="placed-count">{pr ? n(pr.total.placed) : '…'}</b>
        </div>
        <div className="stat">
          <span>{t('plan.open')}</span>
          <b data-testid="open-count">{pr ? n(pr.total.total - pr.total.placed) : '…'}</b>
        </div>
        <div className="stat">
          <span>{t('plan.sectionsDone')}</span>
          <b>
            {doneSections} / {G.sections.length}
          </b>
        </div>
        <div className="w4lw-viewbar" role="group" aria-label={t('w4lw.view.aria')}>
          <Segmented
            value={view}
            options={[
              { value: 'lay', label: t('w4lw.view.lay') },
              { value: 'material', label: t('w4lw.view.material') },
            ]}
            onChange={setView}
            testId="plan-view"
          />
        </div>
        {/* ein verlegter Stein bleibt als schmaler Streifen sichtbar (wie in den Projektlisten) */}
        <ProgressBar value={pr && pr.total.placed > 0 && pr.total.placed < pr.total.total ? Math.max(0.01, pct) : pct} />
      </div>
      {view === 'material' ? (
        <div className="w4lw-material" data-testid="plan-material">
          <MaterialCalc api={api} />
        </div>
      ) : (
        <div className="viewer-layout w4lw-layout">
          <div className="w4lw-main">
            <div className="w4lw-toolbar">
              <Toggle checked={layActive} onChange={toggleLay} label={t('plan.layMode')} disabled={locked} testId="lay-mode" />
              {layActive && (
                <button
                  type="button"
                  className={`btn small ${cardOpen ? 'primary' : ''}`}
                  onClick={() => (cardOpen ? closeCard() : openCard())}
                  title={t('w4lw.next.openTitle')}
                  aria-pressed={cardOpen}
                  data-testid="next-open"
                >
                  ▶ {t('w4lw.next.open')}
                </button>
              )}
              {layActive && (
                <div className="w4lw-tools" role="group" aria-label={t('w4lw.tool.aria')}>
                  <Segmented
                    value={tool}
                    options={[
                      { value: 'tap', label: t('w4lw.tool.tap') },
                      { value: 'paint', label: t('w4lw.tool.paint') },
                      { value: 'rect', label: t('w4lw.tool.rect') },
                    ]}
                    onChange={(v) => {
                      setTool(v);
                      setPendingRect(null);
                    }}
                    testId="lay-tool"
                  />
                </div>
              )}
              <span className="w4lw-hist" role="group" aria-label={t('w5ue.historyAria')} data-w5ue-history="">
                <button
                  type="button"
                  className="btn small w4lw-undo"
                  disabled={undoSize === 0 || locked}
                  onClick={doUndo}
                  title={`${undoSize ? `${t('w5ue.undoNext', { what: historyLabelText(api.history.undoLabel, t) })} (${shortcutText('undo', t)})\n` : ''}${t('w4lw.undoTitle')}`}
                  aria-label={t('w4lw.undo', { n: n(undoSize) })}
                  data-testid="lay-undo"
                >
                  ↶ <span className="w4lw-undo-txt">{t('w4lw.undoLabel')}</span> <span className="w5ue-count">({n(undoSize)})</span>
                </button>
                <button
                  type="button"
                  className="btn small w4lw-undo"
                  disabled={redoSize === 0 || locked}
                  onClick={doRedo}
                  title={redoSize ? `${t('w5ue.redoNext', { what: historyLabelText(api.history.redoLabel, t) })} (${shortcutText('redo', t)})` : t('w5ue.redoNone')}
                  aria-label={`${t('w5ue.redoLabel')} (${n(redoSize)})`}
                  data-testid="lay-redo"
                >
                  ↷ <span className="w4lw-undo-txt">{t('w5ue.redoLabel')}</span> <span className="w5ue-count">({n(redoSize)})</span>
                </button>
              </span>
            </div>
            {locked && (
              <p className="w1mc-notice w1fx-locked small" role="status" data-testid="edit-locked">
                {t('w2ws.lockedComputing')}
              </p>
            )}
            {/* Statuszeile mit fester Höhe: eine Meldung verschiebt das Mosaik nie unter dem Finger */}
            <div className={`w4lw-status ${status ? 'on' : ''}`} data-testid="lay-status" aria-live="polite" title={status?.text}>
              {status ? status.text : t(layActive ? `w4lw.idle.${tool}` : 'w4lw.idle.view')}
            </div>
            <div className="w4lw-vwrap" ref={viewerBox}>
              <Viewer
                ref={viewer}
                layout={L}
                data={data}
                palette={rec.palette}
                version={api.version}
                progressVersion={api.progressVersion}
                groutHex={s.groutHex}
                surface={s.surface}
                realistic={false}
                showCodes
                progressMode
                sections={layActive && cardOpen ? null : G}
                selectedSection={selected}
                highlight={pick ?? marker}
                focusColor={focusColor}
                rulers
                flash={flash}
                focusRange={pendingRect ? pendingRect.range : layActive && sec ? sec : null}
                onOutsideTap={onOutside}
                mode={layActive && !pendingRect ? tool : 'tap'}
                onPaint={onPaint}
                onRect={onRect}
                onPick={onPick}
              />
              {/* Rückfragen verdecken nie, worum es geht: Rechteck oben → Leiste unten; „wechseln?“ am Handy unten
                  (die Abschnittsbezeichnung steht oben links) */}
              <div className={`w4lw-overlays ${(pendingRect ? pendingRect.atBottom : !!outsideAsk?.atBottom) ? 'at-bottom' : ''}`} data-testid="lay-overlays">
                {pendingRect && (
                  <div className="w4lw-bar" role="alertdialog" aria-label={t('w4lw.tool.rect')} data-testid="rect-confirm">
                    <span>
                      {t('w4lw.rect.ask', {
                        from: cellId(L, pendingRect.range.r0, pendingRect.range.c0),
                        to: cellId(L, pendingRect.range.r1 - 1, pendingRect.range.c1 - 1),
                        total: n(pendingRect.total),
                        placed: n(pendingRect.placed),
                      })}
                    </span>
                    <span className="w4lw-bar-btns">
                      <button type="button" className="btn small primary" disabled={pendingRect.total === pendingRect.placed} onClick={() => applyRect(true)} data-testid="rect-lay">
                        {t('w4lw.rect.lay', { n: n(pendingRect.total - pendingRect.placed) })}
                      </button>
                      {pendingRect.placed > 0 && (
                        <button type="button" className="btn small" onClick={() => applyRect(false)} data-testid="rect-open">
                          {t('w4lw.rect.open', { n: n(pendingRect.placed) })}
                        </button>
                      )}
                      <button type="button" className="btn small" onClick={() => setPendingRect(null)} data-testid="rect-cancel">
                        {t('common.cancel')}
                      </button>
                    </span>
                  </div>
                )}
                {outsideAsk && !pendingRect && (
                  <div className="w4lw-bar" role="status" data-testid="outside-ask">
                    <span>{t('w4lw.outside.ask', { id: outsideAsk.id, sec: outsideAsk.sec })}</span>
                    <span className="w4lw-bar-btns">
                      <button
                        type="button"
                        className="btn small primary"
                        onClick={() => {
                          const x = G.sections.find((q) => q.id === outsideAsk.sec);
                          if (x) selectSection(x);
                        }}
                        data-testid="outside-switch"
                      >
                        {t('w4lw.outside.switch', { sec: outsideAsk.sec })}
                      </button>
                      <button type="button" className="btn small" aria-label={t('common.close')} title={t('common.close')} onClick={() => setOutsideAsk(null)}>
                        ✕
                      </button>
                    </span>
                  </div>
                )}
              </div>
            </div>
            <div className="w4lw-notes">
              {/* beschreibt, was JETZT passiert: ohne Verlegemodus öffnet Antippen das Steindetail */}
              <small className="muted block" data-testid="tool-hint" data-mode={layActive ? tool : 'off'}>
                {t(!layActive ? 'w4fx.toolHint.off' : tool === 'paint' ? 'w4lw.toolHint.paint' : tool === 'rect' ? 'w4lw.toolHint.rect' : 'plan.layModeHint')}
              </small>
              {layActive && sec && <small className="muted block">{t('w4lw.focusNote', { sec: sec.id })}</small>}
              {layActive && <WakeNote state={wake} />}
              {(layActive || undoSize > 0 || redoSize > 0) && <small className="muted block">{t('w4lw.undoNote')}</small>}
            </div>
            {!wide && card}
          </div>
          {wide && stone ? (
            <aside className="side w5ue-side">{stone}</aside>
          ) : (
          <aside className="side w4lw-side">
            {wide && card}
            <FindStone layout={L} data={data} onFound={onFound} />
            <h4 className="w4lw-h">
              {t('plan.sections')}{' '}
              <small className="muted">
                {G.scols} × {G.srows} = {G.sections.length} {t('plan.sectionsCount')}
              </small>
            </h4>
            <div className="section-grid-wrap">
              <div className="section-grid" style={{ gridTemplateColumns: `repeat(${G.scols}, minmax(${G.scols > 8 ? 40 : 0}px, 1fr))` }}>
                {G.sections.map((x) => {
                  const st = pr?.perSection.get(x.id);
                  const done = !!st && st.total > 0 && st.placed === st.total;
                  const sp = st ? laidPercentAt(st.placed, st.total, 0) : { value: 0, lessThan: false };
                  const sTxt = sp.lessThan ? '< 1' : String(sp.value);
                  return (
                    <button
                      key={x.id}
                      className={`section-cell ${selected === x.id ? 'active' : ''} ${done ? 'done' : ''}`}
                      onClick={() => selectSection(x)}
                      title={`${x.id}: ${sTxt} % (${n(st?.placed ?? 0)} / ${n(st?.total ?? 0)})`}
                      aria-pressed={selected === x.id}
                      data-testid="section-cell"
                      data-section={x.id}
                    >
                      <b>{x.id}</b>
                      <small>{sTxt}%</small>
                    </button>
                  );
                })}
              </div>
            </div>
            {sec && (
              <button
                type="button"
                className="btn small"
                title={t('w4lw.sec.allTitle')}
                data-testid="section-clear"
                onClick={() => {
                  setSelected(null);
                  setOutsideAsk(null);
                  viewer.current?.fit();
                }}
              >
                ✕ {t('w4lw.sec.all')}
              </button>
            )}
            {sec && (
              <div className="section-info" data-testid="section-info">
                <h4>
                  {t('plan.section')} {sec.id}
                </h4>
                <table className="kv small">
                  <tbody>
                    <tr>
                      <th>{t('plan.position')}</th>
                      <td>
                        X {n(sec.x, 2)} · Y {n(sec.y, 2)} mm
                      </td>
                    </tr>
                    <tr>
                      <th>{t('plan.size')}</th>
                      <td>
                        {n(sec.w, 2)} × {n(sec.h, 2)} mm
                      </td>
                    </tr>
                    <tr>
                      <th>{t('plan.neighbors')}</th>
                      <td>
                        {(['N', 'E', 'S', 'W'] as const)
                          .map((d) => {
                            const dr = d === 'N' ? -1 : d === 'S' ? 1 : 0;
                            const dc = d === 'W' ? -1 : d === 'E' ? 1 : 0;
                            const sr = sec.sr + dr;
                            const sc = sec.sc + dc;
                            const nb = sr >= 0 && sc >= 0 && sr < G.srows && sc < G.scols ? G.sections[sr * G.scols + sc].id : '–';
                            return `${t(`dir.${d}`)}: ${nb}`;
                          })
                          .join(' · ')}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div className="btn-row wrap">
                  <button className="btn small" disabled={locked} title={locked ? t('w2ws.lockedComputing') : undefined} data-testid="section-done" onClick={sectionDone}>
                    ✓ {t('plan.markDone')}
                  </button>
                  <button className="btn small" disabled={locked} title={locked ? t('w2ws.lockedComputing') : undefined} onClick={sectionReset} data-testid="section-reset">
                    {t('plan.reset')}
                  </button>
                  <button className="btn small" disabled={csvBusy} onClick={() => exportCsv([sec.id])} data-testid="section-csv">
                    CSV {sec.id}
                  </button>
                  <button className="btn small" onClick={() => pdfForSection(sec.id)} title={t('w4lw.sec.pdfTitle', { sec: sec.id })} data-testid="section-pdf">
                    {t('w4lw.sec.pdf', { sec: sec.id })}
                  </button>
                </div>
              </div>
            )}
            {counter && <ColorChips counter={counter} palette={rec.palette} focus={focusColor} onFocus={setFocusColor} scopeText={scopeText} layActive={layActive} />}
            <div className="btn-row wrap" style={{ marginTop: 10 }}>
              <button className="btn small" disabled={csvBusy} onClick={() => exportCsv(null)} data-testid="csv-all">
                {csvBusy ? t('common.loading') : t('plan.csvAll')}
              </button>
            </div>
            {csvError && (
              <p className="error small" role="alert" data-testid="csv-error">
                {csvError}
              </p>
            )}
            <details className="w4lw-secset">
              <summary>{t('w4lw.sec.settings')}</summary>
              <Field label={t('plan.sectionMode')}>
                <Segmented
                  value={s.sectionMode ?? 'size'}
                  options={[
                    { value: 'size', label: t('plan.bySize') },
                    { value: 'count', label: t('plan.byCount') },
                  ]}
                  onChange={(v) => api.setSettings({ sectionMode: v })}
                />
              </Field>
              {(s.sectionMode ?? 'size') === 'size' ? (
                <Field label={t('plan.sectionSize')}>
                  <div className="btn-row">
                    <NumberInput value={s.sectionWmm / 10} onChange={(v) => api.setSettings({ sectionWmm: v * 10 })} min={1} suffix="cm" width={60} label={t('size.width')} />
                    ×
                    <NumberInput value={s.sectionHmm / 10} onChange={(v) => api.setSettings({ sectionHmm: v * 10 })} min={1} suffix="cm" width={60} label={t('size.height')} />
                  </div>
                </Field>
              ) : (
                <Field label={t('plan.sectionCount')}>
                  <div className="btn-row">
                    <NumberInput value={s.sectionCols ?? 4} onChange={(v) => api.setSettings({ sectionCols: Math.max(1, Math.round(v)) })} min={1} max={500} width={50} label={t('pdf.cols')} />
                    ×
                    <NumberInput value={s.sectionRows ?? 3} onChange={(v) => api.setSettings({ sectionRows: Math.max(1, Math.round(v)) })} min={1} max={500} width={50} label={t('pdf.rows')} />
                  </div>
                </Field>
              )}
            </details>
          </aside>
          )}
        </div>
      )}
      {(!wide || view === 'material') && stone}
    </div>
  );
}

/**
 * Senkrechter Bereich (Bildschirmkoordinaten), in dem das Mosaik-Canvas wirklich zu sehen ist: Fenster minus
 * klebende/feste Leisten oben (Kopfzeile, Schrittleiste) und unten (Schrittnavigation, Karte „Nächster Stein“).
 */
function visibleBand(cv: HTMLElement, card: HTMLElement | null): { top: number; bottom: number } {
  const r = cv.getBoundingClientRect();
  let top = Math.max(r.top, 0);
  let bottom = Math.min(r.bottom, window.innerHeight);
  const stuck = (el: Element | null) => {
    if (!el) return null;
    const pos = getComputedStyle(el).position;
    if (pos !== 'sticky' && pos !== 'fixed') return null;
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && b.left < r.right && b.right > r.left ? b : null;
  };
  for (const el of [document.querySelector('.topbar'), document.querySelector('.stepper')]) {
    const b = stuck(el);
    if (b && b.top <= top + 1 && b.bottom > top) top = b.bottom;
  }
  for (const el of [document.querySelector('[data-testid="step-nav"]'), card]) {
    const b = stuck(el);
    if (b && b.bottom >= bottom - 1 && b.top < bottom) bottom = b.top;
  }
  return { top, bottom: Math.max(top, bottom) };
}

/** Offene Steine je Farbe (Abschnitt bzw. ganzes Mosaik); Antippen hebt die Farbe hervor */
function ColorChips(p: { counter: ColorProgressCounter; palette: PaletteColor[]; focus: number | null; onFocus: (c: number | null) => void; scopeText: string; layActive: boolean }) {
  const { t, n, lang } = useI18n();
  const codeOf = (ci: number) => p.palette[ci]?.code ?? Number.MAX_SAFE_INTEGER;
  const entries = [...p.counter.counts.entries()].filter(([, e]) => e.total > 0).sort((a, b) => codeOf(a[0]) - codeOf(b[0]) || a[0] - b[0]);
  const tot = p.counter.totals();
  return (
    <div className="w4lw-chipbox" data-testid="color-chips">
      <h4>{t('w4lw.chips.title', { scope: p.scopeText })}</h4>
      <div className="w4lw-chips">
        {entries.map(([ci, e]) => {
          const pc = p.palette[ci];
          const code = String(pc?.code ?? '?').padStart(2, '0');
          const open = e.total - e.placed;
          return (
            <button
              key={ci}
              type="button"
              className={`w4lw-chip ${p.focus === ci ? 'active' : ''} ${open === 0 ? 'done' : ''}`}
              aria-pressed={p.focus === ci}
              title={`${code} ${pc ? paletteDisplayName(pc, lang) : ''} · ${n(e.placed)} / ${n(e.total)} ${t('plan.placedShort')}`}
              onClick={() => p.onFocus(p.focus === ci ? null : ci)}
              data-testid="color-chip"
              data-color={ci}
              data-open={open}
              data-total={e.total}
            >
              <Swatch hex={pc?.hex ?? '#000'} size={18} />
              <b>{code}</b>
              <small>{open === 0 ? t('w4lw.chips.done') : t('w4lw.chips.open', { open: n(open), total: n(e.total) })}</small>
            </button>
          );
        })}
      </div>
      <p className="small w4lw-chipsum" data-testid="chips-sum">
        {t('w4lw.chips.sum', { open: n(tot.total - tot.placed), total: n(tot.total) })}
        {p.focus !== null && (
          <button type="button" className="btn small w4lw-chipclear" onClick={() => p.onFocus(null)} data-testid="chips-clear">
            {t('w4lw.chips.clear')}
          </button>
        )}
      </p>
      {/* „Nächster Stein“ gibt es nur im Verlegemodus */}
      <small className="muted block" data-testid="chips-hint">
        {t(p.layActive ? 'w4lw.chips.hint' : 'w4fx.chips.hintView')}
      </small>
    </div>
  );
}

/** Karte „Nächster Stein“: ID, Farbe, Größe und Schnittanweisung aus analyzeCut (wie Steindetail, PDF, CSV) */
function NextStoneCard(p: {
  compact: boolean;
  boxRef: RefObject<HTMLDivElement | null>;
  layout: Layout;
  data: MosaicData;
  palette: PaletteColor[];
  materials: Material[];
  code: number | null;
  pos: number;
  total: number;
  open: number;
  scopeText: string;
  colorCode: string | null;
  order: LayingOrderKind;
  onOrder: (o: LayingOrderKind) => void;
  onLayNext: () => void;
  onBack: () => void;
  canBack: boolean;
  onSkip: () => void;
  onRowDone: () => void;
  onDetails: () => void;
  onClose: () => void;
  locked: boolean;
}) {
  const { t, n, lang } = useI18n();
  const L = p.layout;
  const boxRef = p.boxRef;
  // Handy: Karte klebt direkt über der (ebenfalls klebenden) Schrittnavigation
  useEffect(() => {
    const el = boxRef.current;
    if (!p.compact || !el) return;
    const nav = document.querySelector<HTMLElement>('[data-testid="step-nav"]');
    const update = () => {
      const pos = nav ? getComputedStyle(nav).position : '';
      el.style.bottom = nav && (pos === 'sticky' || pos === 'fixed') ? `${nav.offsetHeight}px` : '0px';
    };
    update();
    const ro = typeof ResizeObserver === 'function' && nav ? new ResizeObserver(update) : null;
    if (ro && nav) ro.observe(nav);
    window.addEventListener('resize', update);
    // Eingabefeld mit Fokus: die Navigation wird statisch (siehe w2-workspace-shell.css)
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
      el.style.bottom = '';
    };
  }, [p.compact, boxRef]);
  const orderSwitch = (
    <span className="w4lw-card-order" title={t('w4lw.next.orderHint')}>
      <span className="small muted w4lw-card-orderlbl">{t('w4lw.next.order')}</span>
      <Segmented
        value={p.order}
        options={[
          { value: 'serpentine', label: t('w4lw.next.orderRow') },
          { value: 'color', label: t('w4lw.next.orderColor') },
        ]}
        onChange={p.onOrder}
        testId="next-order"
      />
    </span>
  );
  let body;
  if (p.code === null) {
    body = (
      <p className="w4lw-card-done" data-testid="next-done">
        {p.colorCode ? t('w4lw.next.allDoneColor', { code: p.colorCode, scope: p.scopeText }) : t('w4lw.next.allDone', { scope: p.scopeText })}
      </p>
    );
  } else {
    const idx = refIdx(p.code);
    const piece = refPiece(p.code);
    const row = Math.floor(idx / L.cols);
    const col = idx - row * L.cols;
    const ps = cellPieces(L, p.data, row, col);
    const pc = ps[piece];
    if (pc) {
      const raw = makeRawSizeFn(L, p.palette, p.materials)(pc.color);
      const info = analyzeCut(pc.poly, raw.w, raw.h);
      const color = p.palette[pc.color];
      const laid = isRefPlaced(p.data, p.code);
      const items = cutInstructionItems(info, t, n);
      body = (
        <>
          <div className="w4lw-card-stone">
            <Swatch hex={color?.hex ?? '#000'} size={p.compact ? 34 : 44} />
            <div className="w4lw-card-idbox">
              <div className="w4lw-card-id" data-testid="next-id">
                {pieceId(L, row, col, piece, ps.length)}
                {laid && (
                  <span data-testid="next-laid">
                    {' '}
                    <Badge kind="ok">{t('w4lw.next.laid')}</Badge>
                  </span>
                )}
              </div>
              <div className="small">
                <b>{String(color?.code ?? '?').padStart(2, '0')}</b> {color ? paletteDisplayName(color, lang) : ''} ·{' '}
                <span data-testid="next-size">{t('w4lw.next.size', { w: n(info.w, 2), h: n(info.h, 2) })}</span> · {t(`shape.${info.shape}`)}
              </div>
              {!p.compact && <div className="muted small">{t('w4lw.next.where', { row: rowLabel(row), col: col + 1 })}</div>}
            </div>
          </div>
          <ul className="cut-list w4lw-card-cut" data-testid="next-cut">
            {items.map((l, i) => (
              <li key={i} className={`cut-${l.kind}`}>
                {l.text}
              </li>
            ))}
          </ul>
          {!p.compact && info.needsCut && !info.invalid && info.fits && (
            <div className="w4lw-card-tpl">
              <CutTemplateSvg info={info} color={color?.hex ?? '#ccc'} size={150} />
            </div>
          )}
        </>
      );
    }
  }
  return (
    <section className={`w4lw-card ${p.compact ? 'compact' : ''}`} ref={p.boxRef} data-testid="next-card" aria-label={t('w4lw.next.title')}>
      <div className="w4lw-card-head">
        <b>{t('w4lw.next.title')}</b>
        {p.compact ? orderSwitch : <span />}
        <button type="button" className="icon-btn" aria-label={t('w4lw.next.close')} title={t('w4lw.next.close')} onClick={p.onClose} data-testid="next-close">
          ✕
        </button>
        <span className="muted small w4lw-card-pos" data-testid="next-pos">
          {p.code !== null ? t('w4lw.next.pos', { pos: n(p.pos + 1), total: n(p.total), open: n(p.open), scope: p.scopeText }) : ''}
          {p.colorCode ? ` · ${t('w4lw.next.onlyColor', { code: p.colorCode })}` : ''}
        </span>
      </div>
      {body}
      <div className="w4lw-card-actions">
        <button
          type="button"
          className="btn small w4lw-card-back"
          disabled={!p.canBack}
          onClick={p.onBack}
          aria-label={t('w4lw.next.back')}
          title={t('w4lw.next.back')}
          data-testid="next-back"
        >
          ‹<span className="w4lw-card-btxt"> {t('w4lw.next.back')}</span>
        </button>
        <button type="button" className="btn primary w4lw-card-lay" disabled={p.locked || p.code === null} onClick={p.onLayNext} data-testid="next-lay">
          {t('w4lw.next.layNext')}
        </button>
        <button
          type="button"
          className="btn small w4lw-card-skip"
          disabled={p.code === null}
          onClick={p.onSkip}
          aria-label={t('w4lw.next.skip')}
          title={t('w4lw.next.skip')}
          data-testid="next-skip"
        >
          <span className="w4lw-card-btxt">{t('w4lw.next.skip')} </span>›
        </button>
      </div>
      <div className="w4lw-card-more">
        {p.order === 'serpentine' && (
          <button type="button" className="btn small" disabled={p.locked || p.code === null} onClick={p.onRowDone} title={t('w4lw.next.rowDoneTitle', { scope: p.scopeText })} data-testid="next-row">
            {t('w4lw.next.rowDone')}
          </button>
        )}
        <button type="button" className="btn small" disabled={p.code === null} onClick={p.onDetails} data-testid="next-details">
          {t('w4lw.next.details')}
        </button>
        {!p.compact && orderSwitch}
      </div>
    </section>
  );
}

function WakeNote({ state }: { state: WakeState }) {
  const { t } = useI18n();
  if (state === 'on')
    return (
      <small className="muted block" data-testid="wake-note" data-state="on">
        ☀ {t('w4lw.wake.on')}
      </small>
    );
  if (state === 'unsupported')
    return (
      <small className="muted block" data-testid="wake-note" data-state="unsupported">
        <Badge kind="incomplete">{t('common.incomplete')}</Badge> {t('w4lw.wake.unsupported')}
      </small>
    );
  if (state === 'denied')
    return (
      <small className="muted block" data-testid="wake-note" data-state="denied">
        {t('w4lw.wake.denied')}
      </small>
    );
  return null;
}

type WakeState = 'off' | 'on' | 'unsupported' | 'denied';
type WakeSentinel = { release(): Promise<void>; addEventListener?(type: 'release', fn: () => void): void };
type WakeLockApi = { request(type: 'screen'): Promise<WakeSentinel> };

/**
 * Bildschirm wach halten, solange `active` (Screen Wake Lock API, falls vorhanden). Der Browser gibt die Sperre
 * frei, wenn die Seite in den Hintergrund geht – beim Zurückkehren wird sie neu angefordert.
 */
function useWakeLock(active: boolean): WakeState {
  const [state, setState] = useState<WakeState>('off');
  useEffect(() => {
    if (!active) {
      setState('off');
      return;
    }
    const wl = typeof navigator !== 'undefined' ? (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock : undefined;
    if (!wl || typeof wl.request !== 'function') {
      setState('unsupported');
      return;
    }
    let alive = true;
    let sentinel: WakeSentinel | null = null;
    const request = async () => {
      if (document.visibilityState !== 'visible' || sentinel) return;
      try {
        const s = await wl.request('screen');
        if (!alive) {
          s.release().catch(() => {});
          return;
        }
        sentinel = s;
        setState('on');
        s.addEventListener?.('release', () => {
          if (sentinel === s) sentinel = null;
          if (alive) setState(document.visibilityState === 'visible' ? 'off' : 'on');
        });
      } catch {
        if (alive) setState('denied');
      }
    };
    void request();
    const onVis = () => {
      if (document.visibilityState === 'visible') void request();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVis);
      sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
  return state;
}

/** CSS-Media-Query als Zustand (z. B. breiter Bildschirm → Karte in der Seitenleiste statt unten) */
function useMedia(query: string): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return m;
}
