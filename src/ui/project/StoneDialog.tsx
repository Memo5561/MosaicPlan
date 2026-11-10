import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { deltaE, type DeltaEFormula } from '../../core/color';
import { paletteDisplayName } from '../../core/colorNames';
import { bbox, centroid } from '../../core/geometry';
import type { HistoryFlash, HistoryLabel } from '../../core/journal';
import { cellId, sectionOfCell, type Layout, type SectionGrid } from '../../core/layout';
import { analyzeCut, cellPieces, cellRect, cutLineItems, pieceWidthCheck, type CutInfo, type WidthCheck } from '../../core/pieces';
import {
  allowedCellKinds,
  cellKindWidth,
  checkCellKind,
  freeEditorPieces,
  neighbors,
  sameCellKind,
  setCellKind,
  setCellPlaced,
  setFreePieces,
  setPieceColor,
  shadeStep,
  togglePiecePlaced,
  validateFreePieces,
  type CellKindError,
  type KindChange,
  type ShadeCandidate,
} from '../../core/edits';
import { makeRawSizeFn } from '../../core/stats';
import { CellKind, Rec, type Material, type MosaicData, type PaletteColor, type PaletteMode } from '../../core/types';
import { useI18n, type TFunc } from '../../i18n';
import { Badge, Modal, NumberInput, Swatch } from '../components';
import { CutTemplateSvg } from './CutTemplateSvg';
import { FreeformEditor, freeIssueText } from './FreeformEditor';
import type { EditResult } from './useProject';
import '../css/w1-cut-correctness.css';
import '../css/w3-freeform-editor.css';
import '../css/w5-undo-editing.css';

export interface CutInstructionItem {
  text: string;
  kind: 'info' | 'through' | 'notch' | 'invalid';
}

/** Schnittanweisung als Zeilen. Alle Maße stammen aus analyzeCut (exakte Polygon-Geometrie). */
export function cutInstructionItems(info: CutInfo, t: TFunc, n: (v: number, d?: number) => string): CutInstructionItem[] {
  if (info.invalid) return [{ text: t('cut.invalid'), kind: 'invalid' }];
  if (!info.fits) return [{ text: t('cut.notFit', { w: n(info.w, 1), h: n(info.h, 1), rw: n(info.rawW, 1), rh: n(info.rawH, 1) }), kind: 'info' }];
  if (!info.needsCut) return [{ text: t('cut.none', { w: n(info.w, 1), h: n(info.h, 1) }), kind: 'info' }];
  const out: CutInstructionItem[] = [];
  const info1 = (text: string) => out.push({ text, kind: 'info' });
  if (info.shape === 'rectangle' || info.shape === 'square') {
    if (info.polyInRaw.length === 4 && info.cutLines.every(([a, b]) => Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6))
      info1(t('cut.rect', { w: n(info.w, 1), h: n(info.h, 1) }));
  } else if (info.shape === 'triangle') {
    const e = [...info.edges].sort((a, b) => a - b);
    info1(t('cut.triangle', { a: n(e[0], 1), b: n(e[1], 1), c: n(e[2], 1) }));
  } else {
    info1(t('cut.polygon', { k: info.polyInRaw.length }));
  }
  // dieselbe Reihenfolge und Nummerierung wie im PDF (cutLineItems)
  const items = cutLineItems(info);
  for (const it of items) {
    const pts = { x1: n(it.a.x, 1), y1: n(it.a.y, 1), x2: n(it.b.x, 1), y2: n(it.b.y, 1) };
    if (it.kind === 'through') out.push({ text: t('cut.line', { i: it.no, ...pts }), kind: 'through' });
    else out.push({ text: t(it.kind === 'notch' ? 'cut.notch' : 'cut.notchEdge', { i: it.no, ...pts }), kind: 'notch' });
  }
  info1(t('cut.angles', { a: info.angles.map((a) => `${n(a, 1)}°`).join(', ') }));
  if (!info.convex) {
    // Reihenfolge-Hinweis nur, wenn es beides gibt – sonst verwiese er auf Schritte, die es nicht gibt
    const through = items.some((it) => it.kind === 'through');
    const notch = items.some((it) => it.kind !== 'through');
    info1(t(through && notch ? 'cut.nonConvex' : notch ? 'cut.nonConvexNotchOnly' : 'cut.nonConvexPlain'));
  }
  return out;
}

/** Gemessene Werte zur Mindestbreite als Text, z. B. „Inkreismaß 1,93 mm < 2 mm (schmalste Stelle 2,33 mm)“. */
export function widthFailText(w: WidthCheck, min: number, t: TFunc, n: (v: number, d?: number) => string): string {
  if (w.failed === 'degenerate') return t('width.degenerate');
  const vals = { cal: n(w.caliper, 2), inc: n(w.incircle, 2), min: n(min, 2) };
  return t(w.failed === 'incircle' ? 'width.failIncircle' : 'width.failCaliper', vals);
}

export function cutInstruction(info: CutInfo, t: TFunc, n: (v: number, d?: number) => string): string[] {
  return cutInstructionItems(info, t, n).map((x) => x.text);
}

/** Anzahl der ähnlichsten Farben in der Farbreihe (weitere über „Alle Farben“) */
export const NEAR_COLORS = 12;
/** ab diesem Helligkeitsunterschied (L*) zeigt eine Farbe ▲ (heller) bzw. ▼ (dunkler) */
export const MARK_DL = 1;

/** Breiter Bildschirm: Steindetail neben dem Mosaik (statt als Dialog darüber). Gleiche Grenze wie .viewer-layout. */
export const PANEL_QUERY = '(min-width: 981px)';

/** CSS-Media-Query als Zustand */
export function useMediaQuery(query: string): boolean {
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

/** Zweistellige Farbnummer */
const codeOf = (p: PaletteColor | undefined) => String(p?.code ?? '?').padStart(2, '0');

interface Props {
  layout: Layout;
  data: MosaicData;
  palette: PaletteColor[];
  materials: Material[];
  sections: SectionGrid | null;
  row: number;
  col: number;
  piece: number;
  minPieceMm: number;
  onClose: () => void;
  onNavigate: (row: number, col: number, piece: number) => void;
  /**
   * Jede Änderung (Farbe, Form, Freiform, verlegt) läuft hierüber – mit Verlaufseintrag (api.editCell): `mutate` ändert
   * die Zelle `idx`, `label` beschreibt die Änderung für Rückgängig/Wiederholen.
   */
  onEdit: (idx: number, mutate: () => void, label: HistoryLabel, flash?: HistoryFlash) => EditResult | null;
  /** Nur ansehen: während einer Berechnung (das angezeigte Mosaik wird gleich ersetzt) keine Änderungen */
  readOnly?: boolean;
  /** 'panel': neben dem Mosaik (breite Bildschirme, kein Hintergrund, Mosaik bleibt bedienbar) · 'modal': Dialog */
  variant?: 'modal' | 'panel';
  /** Rückgängig/Wiederholen-Knöpfe */
  history?: ReactNode;
  /** Farbquelle (für den Hinweis, woher eine fehlende hellere/dunklere Farbe kommt) */
  paletteMode?: PaletteMode;
  /** ΔE-Formel des Projekts (Ähnlichkeit, Heller/Dunkler) */
  deltaE?: DeltaEFormula;
}

/**
 * Steindetail. Reihenfolge (alle Breiten, einspaltig): Kurzinfo mit „verlegt“, Farbe ändern (Heller/Dunkler, die
 * ähnlichsten Farben), Schnittanweisung mit Vorlage, Form ändern, Position und Nachbarn. Auf breiten Bildschirmen als
 * Seitenleiste neben dem Mosaik ('panel'), sonst als Dialog. Alle Maße kommen aus analyzeCut auf den echten Polygonen.
 */
export function StoneDialog(p: Props) {
  const { t, n, lang } = useI18n();
  const [, setTick] = useState(0);
  const [freeOpen, setFreeOpen] = useState(false);
  const [lineAngle, setLineAngle] = useState(45);
  const [lineOffset, setLineOffset] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const headId = useId();
  const variant = p.variant ?? 'modal';
  const formula = p.deltaE ?? '2000';
  const { layout, data, palette } = p;
  const idx = p.row * layout.cols + p.col;
  const pieces = cellPieces(layout, data, p.row, p.col);
  const pi = Math.max(0, Math.min(p.piece, pieces.length - 1));
  const piece = pieces[pi];
  const pc = piece ? palette[piece.color] : undefined;

  // Ähnlichkeit bezogen auf die Farbe, die der Stein beim Öffnen hatte – die Reihe springt nach einem Klick nicht
  const cellKey = `${idx}:${pi}`;
  const anchorRef = useRef<{ key: string; code: number } | null>(null);
  if (piece && (!anchorRef.current || anchorRef.current.key !== cellKey)) anchorRef.current = { key: cellKey, code: pc?.code ?? -1 };
  const anchorFound = anchorRef.current ? palette.findIndex((q) => q.code === anchorRef.current!.code) : -1;
  const anchor = anchorFound >= 0 ? anchorFound : (piece?.color ?? -1);
  const similar = useMemo(() => {
    const a = palette[anchor];
    if (!a) return [] as { i: number; q: PaletteColor; d: number }[];
    return palette.map((q, i) => ({ i, q, d: deltaE(formula, a.lab, q.lab) })).sort((x, y) => x.d - y.d || x.i - y.i);
  }, [palette, anchor, formula]);

  // Seitenleiste: Esc schließt (ein darüberliegender Dialog, z. B. der Freiform-Editor, hat Vorrang)
  const onCloseRef = useRef(p.onClose);
  onCloseRef.current = p.onClose;
  useEffect(() => {
    if (variant !== 'panel') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.modal-backdrop')) return;
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [variant]);

  if (!piece) return null;
  const raw = makeRawSizeFn(layout, palette, p.materials);
  const info = analyzeCut(piece.poly, raw(piece.color).w, raw(piece.color).h);
  const cid = cellId(layout, p.row, p.col);
  const id = cid + (pieces.length > 1 ? `-${pi + 1}` : '');
  const sec = p.sections ? sectionOfCell(p.sections, p.row, p.col) : null;
  const placed = ((data.progress[idx] >> pi) & 1) === 1;
  const rec = data.rec[idx];
  const ro = !!p.readOnly;

  /** Änderung mit Verlaufseintrag; danach neu zeichnen */
  const edit = (mutate: () => void, label: HistoryLabel, flash?: HistoryFlash): EditResult | null => {
    if (ro) return null;
    const r = p.onEdit(idx, mutate, label, flash);
    setTick((x) => x + 1);
    return r;
  };
  const setColor = (target: number) => {
    if (ro || target === piece.color) return;
    edit(() => setPieceColor(data, idx, pi, target), { key: 'w5ue.h.color', params: { id, from: codeOf(palette[piece.color]), to: codeOf(palette[target]) } }, { idx, piece: pi });
  };

  const b = bbox(piece.poly);
  const ctr = centroid(piece.poly);
  const shapeKind = data.kind[idx];
  const cell = cellRect(layout, p.row, p.col);
  // verknüpftes Material: null = keine Verknüpfung, undefined = Verknüpfung zeigt ins Leere
  const material = pc?.materialId ? p.materials.find((x) => x.id === pc.materialId) : null;
  // gespeicherte Freiformzelle prüfen (ältere Projekte konnten überlappende Teile ohne Fuge speichern)
  const freeCheck = shapeKind === CellKind.FREE ? validateFreePieces(cell.w, cell.h, data.free.get(idx) ?? [], p.minPieceMm, layout.joint) : null;
  const freeGapWarnings = freeCheck ? freeCheck.warnings.filter((w) => w.code === 'gap') : [];
  const isCutKind = shapeKind === CellKind.DIAG_A || shapeKind === CellKind.DIAG_B || shapeKind === CellKind.LINE || shapeKind === CellKind.SUB || shapeKind === CellKind.FREE;
  // Gespeicherte Teile, die nach der aktuellen Mindestbreite nicht schneidbar sind (z. B. ältere Berechnung)
  const width = pieceWidthCheck(piece.poly, p.minPieceMm);
  const belowMin = !info.invalid && isCutKind && !width.ok;
  const allowed = allowedCellKinds(layout, data, p.row, p.col, p.minPieceMm);
  const lineChange: KindChange = { kind: CellKind.LINE, angleDeg: lineAngle, offsetMm: lineOffset };
  const lineErr = checkCellKind(layout, p.row, p.col, lineChange, p.minPieceMm);
  // Grund mit den gemessenen Werten des schmalsten Teils (statt nur „zu schmal“)
  const why = (err: string | null, ch: KindChange): string | undefined => {
    if (!err) return undefined;
    if (err !== 'too-small') return t(`edit.err.${err}`);
    const w = cellKindWidth(layout, p.row, p.col, ch, p.minPieceMm);
    return `${t('edit.err.too-small')} ${w ? widthFailText(w, p.minPieceMm, t, n) : ''}`.trim();
  };
  const reasons: { label: string; text: string }[] = [];
  // beide Diagonalen eines Rechtecks sind Spiegelbilder (gleiche Maße) – ein gemeinsamer Grund genügt
  if (allowed.diagA && allowed.diagA === allowed.diagB) reasons.push({ label: t('edit.diag'), text: why(allowed.diagA, { kind: CellKind.DIAG_A })! });
  else {
    if (allowed.diagA) reasons.push({ label: t('edit.diagA'), text: why(allowed.diagA, { kind: CellKind.DIAG_A })! });
    if (allowed.diagB) reasons.push({ label: t('edit.diagB'), text: why(allowed.diagB, { kind: CellKind.DIAG_B })! });
  }
  if (allowed.sub2) reasons.push({ label: '2×2', text: why(allowed.sub2, { kind: CellKind.SUB, k: 2 })! });
  if (allowed.sub3) reasons.push({ label: '3×3', text: why(allowed.sub3, { kind: CellKind.SUB, k: 3 })! });
  if (lineErr) reasons.push({ label: `${t('edit.lineCut')} ${n(lineAngle, 1)}° / ${n(lineOffset, 1)} mm`, text: why(lineErr, lineChange)! });

  /** Name der Form für die Verlaufsbeschriftung („t:“ = Übersetzungsschlüssel, siehe historyLabelText) */
  const kindName = (ch: KindChange): string =>
    ch.kind === CellKind.FULL
      ? 't:edit.full'
      : ch.kind === CellKind.DIAG_A
        ? 't:edit.diagA'
        : ch.kind === CellKind.DIAG_B
          ? 't:edit.diagB'
          : ch.kind === CellKind.SUB
            ? `${ch.k ?? 2}×${ch.k ?? 2}`
            : `${t('edit.lineCut')} ${n(ch.angleDeg ?? 0, 1)}° / ${n(ch.offsetMm ?? 0, 1)} mm`;
  const setKind = (ch: KindChange) => {
    if (ro) return;
    // Unveränderte Form: nichts tun (Verlegestatus und gewähltes Teil bleiben erhalten)
    if (sameCellKind(layout, data, p.row, p.col, ch)) {
      setMsg(null);
      return;
    }
    const box: { err: CellKindError | null } = { err: null };
    edit(
      () => {
        box.err = setCellKind(layout, data, p.row, p.col, ch, p.minPieceMm);
      },
      { key: 'w5ue.h.shape', params: { id: cid, to: kindName(ch) } },
      { idx, piece: 0 },
    );
    if (box.err) setMsg(why(box.err, ch) ?? t(`edit.err.${box.err}`));
    else {
      setMsg(null);
      p.onNavigate(p.row, p.col, 0);
    }
  };

  // ---------- Heller / Dunkler: nur vorhandene Palettenfarben gleichen Farbtons (shadeStep)
  const lighter = shadeStep(palette, piece.color, 'lighter', formula);
  const darker = shadeStep(palette, piece.color, 'darker', formula);
  const fromMaterials = p.paletteMode === 'materials' || p.paletteMode === 'auto-snap';
  const shadeSrc = t(fromMaterials ? 'w5ue.shade.srcMaterial' : 'w5ue.shade.srcColor');
  const shadeHint = !lighter && !darker ? t('w5ue.shade.noneBoth', { src: shadeSrc }) : !lighter ? t('w5ue.shade.noLighter', { src: shadeSrc }) : !darker ? t('w5ue.shade.noDarker', { src: shadeSrc }) : null;
  const shadeBtn = (dir: 'lighter' | 'darker', c: ShadeCandidate | null) => {
    const q = c ? palette[c.index] : undefined;
    const lbl = t(dir === 'lighter' ? 'w5ue.shade.lighter' : 'w5ue.shade.darker');
    const title =
      c && q
        ? t('w5ue.shade.title', { code: codeOf(q), name: paletteDisplayName(q, lang), dl: `${c.dL > 0 ? '+' : '−'}${n(Math.abs(c.dL), 1)}`, de: n(c.dE, 1) })
        : t(dir === 'lighter' ? 'w5ue.shade.noLighter' : 'w5ue.shade.noDarker', { src: shadeSrc });
    return (
      <button
        type="button"
        className={`btn w5ue-shade-btn ${dir}`}
        disabled={ro || !c}
        title={title}
        aria-label={`${lbl}: ${title}`}
        onClick={() => c && setColor(c.index)}
        data-testid={`shade-${dir}`}
        data-target={q ? codeOf(q) : ''}
      >
        <span className="w5ue-shade-dir">
          {dir === 'lighter' ? '▲' : '▼'} {lbl}
        </span>
        {c && q ? (
          <span className="w5ue-shade-to">
            <Swatch hex={q.hex} size={18} /> <b>{codeOf(q)}</b> <small>ΔE {n(c.dE, 1)}</small>
          </span>
        ) : (
          <small className="w5ue-shade-to muted">{t('w5ue.shade.none')}</small>
        )}
      </button>
    );
  };

  // ---------- Farbreihe: die ähnlichsten Farben (bezogen auf die Ausgangsfarbe) + „Alle Farben“
  const shown = showAll ? similar : similar.slice(0, NEAR_COLORS);
  const list = shown.some((x) => x.i === piece.color) ? shown : [...shown, ...similar.filter((x) => x.i === piece.color)];
  const cur = palette[piece.color];
  const anc = palette[anchor];
  const dAnchor = cur && anc ? deltaE(formula, anc.lab, cur.lab) : 0;

  const placedLabel: HistoryLabel = { key: placed ? 'w4lw.st.openOne' : 'w4lw.st.laidOne', params: { id } };
  const summary = (
    <section className="w5ue-sum" data-testid="stone-summary">
      <div className="w5ue-sum-head">
        <Swatch hex={pc?.hex ?? '#000'} size={30} />
        <div className="w5ue-sum-main">
          <div>
            <b>{codeOf(pc)}</b> {pc ? paletteDisplayName(pc, lang) : ''} <small className="muted">{pc?.hex}</small>
          </div>
          <small className="muted">
            {n(info.w, 1)} × {n(info.h, 1)} mm · {t(`shape.${info.shape}`)}
          </small>
        </div>
      </div>
      <div className="w5ue-sum-id small" data-testid="stone-id">
        <b>{id}</b> · {t('stone.row')} {cellId(layout, p.row, 0).replace(/\d+$/, '')} / {t('stone.col')} {p.col + 1}
        {pieces.length > 1 && ` · ${t('stone.piece')} ${pi + 1}/${pieces.length}`}
      </div>
      {pieces.length > 1 && (
        <div className="neighbors w5ue-pieces" role="group" aria-label={t('stone.piece')}>
          {pieces.map((q, i) => (
            <button key={i} className={`neighbor ${i === pi ? 'active' : ''}`} aria-pressed={i === pi} onClick={() => p.onNavigate(p.row, p.col, i)}>
              {t('stone.piece')} {i + 1} <Swatch hex={palette[q.color]?.hex ?? '#000'} size={12} />
            </button>
          ))}
        </div>
      )}
      <div className="w5ue-laid-row">
        <label className={`w5ue-laid ${placed ? 'on' : ''} ${ro ? 'disabled' : ''}`}>
          <input type="checkbox" checked={placed} data-testid="stone-placed" disabled={ro} onChange={() => edit(() => togglePiecePlaced(data, idx, pi), placedLabel, { idx, piece: pi })} />
          <span>{placed ? `✓ ${t('w5ue.laidOn')}` : t('stone.placedThis')}</span>
        </label>
        {pieces.length > 1 && (
          <button className="btn small" disabled={ro} onClick={() => edit(() => setCellPlaced(data, idx, true), { key: 'w5ue.h.cellLaid', params: { id: cid } }, { idx, piece: 0 })}>
            {t('stone.placedCell')}
          </button>
        )}
        {variant === 'modal' && p.history && <span className="w5ue-sum-hist">{p.history}</span>}
      </div>
    </section>
  );

  const colorSection = (
    <section className="w5ue-sec w5ue-color">
      <h4>{t('w5ue.colorTitle')}</h4>
      <div className="w5ue-shade" title={t('w5ue.shade.rule')}>
        {shadeBtn('lighter', lighter)}
        {shadeBtn('darker', darker)}
      </div>
      {shadeHint && (
        <small className="muted block w5ue-shade-hint" data-testid="shade-hint">
          {shadeHint}
        </small>
      )}
      <div className={`color-pick w5ue-colors ${showAll ? 'all' : ''}`} data-testid="color-pick">
        {list.map(({ i, q, d }) => {
          const dl = cur ? q.lab[0] - cur.lab[0] : 0;
          const mark = i === piece.color ? null : dl >= MARK_DL ? 'up' : dl <= -MARK_DL ? 'down' : null;
          const rel = mark === 'up' ? t('w5ue.mark.lighter', { dl: n(dl, 1) }) : mark === 'down' ? t('w5ue.mark.darker', { dl: n(-dl, 1) }) : '';
          const title = `${codeOf(q)} ${paletteDisplayName(q, lang)} · ΔE ${n(d, 1)}${rel ? ` · ${rel}` : ''}`;
          return (
            <button
              key={i}
              className={`cp ${i === piece.color ? 'active' : ''}`}
              title={title}
              aria-label={title}
              aria-pressed={i === piece.color}
              disabled={ro}
              onClick={() => setColor(i)}
              data-code={codeOf(q)}
              data-mark={mark ?? ''}
            >
              <Swatch hex={q.hex} size={22} />
              <small>{codeOf(q)}</small>
              {mark && (
                <span className={`w5ue-mark ${mark}`} aria-hidden="true">
                  {mark === 'up' ? '▲' : '▼'}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="w5ue-color-foot">
        {cur && (
          <p className="small w5ue-selected" data-testid="color-selected">
            <Swatch hex={cur.hex} size={14} /> <b>{codeOf(cur)}</b> {paletteDisplayName(cur, lang)} ·{' '}
            {anchor === piece.color ? t('w5ue.sel.origin') : t('w5ue.sel.delta', { de: n(dAnchor, 1), code: codeOf(anc) })}
          </p>
        )}
        {palette.length > NEAR_COLORS && (
          <button type="button" className="btn small w5ue-all" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)} data-testid="colors-all">
            {showAll ? t('w5ue.colorsFewer', { n: NEAR_COLORS }) : t('w5ue.colorsAll', { n: palette.length })}
          </button>
        )}
      </div>
      <small className="muted block">{t('w5ue.colorHint')}</small>
    </section>
  );

  const cutSection = (
    <section className="w5ue-sec">
      <h4>{t('stone.cut')}</h4>
      {info.invalid ? (
        <Badge kind="error">{t('stone.invalid')}</Badge>
      ) : info.needsCut ? (
        <Badge kind="ok">{t('stone.computedTemplate')}</Badge>
      ) : (
        <Badge kind="info">{t('stone.noCut')}</Badge>
      )}
      <ul className="cut-list" data-testid="cut-instructions">
        {cutInstructionItems(info, t, n).map((l, i) => (
          <li key={i} className={`cut-${l.kind}`}>
            {l.text}
          </li>
        ))}
      </ul>
      {belowMin && (
        <div className="stone-width-note" data-testid="stone-below-min">
          <Badge kind="warn">{t('stone.belowMin', { min: n(p.minPieceMm, 2), why: widthFailText(width, p.minPieceMm, t, n) })}</Badge>
        </div>
      )}
      {freeCheck && (freeCheck.errors.length > 0 || freeGapWarnings.length > 0) && (
        <div className={`w3fe-free-issues ${freeCheck.errors.length > 0 ? 'err' : 'warn'}`} data-testid="stone-free-issues">
          {freeCheck.errors.length > 0 ? t('w3fe.freeCellIssues') : t('w3fe.freeCellWarnings')}
          <ul>
            {[...freeCheck.errors, ...freeGapWarnings].map((is, i) => (
              <li key={i}>{freeIssueText(is, t, n, cell.w, cell.h)}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="w5ue-tpl">
        <CutTemplateSvg info={info} color={pc?.hex ?? '#ccc'} />
      </div>
      <p className="muted small">{t('stone.templateLegend')}</p>
      {rec !== 0 && (
        <div className="recommend">
          <Badge kind="warn">{t('stone.recommendation')}</Badge>
          <ul>
            {rec & Rec.FINER ? <li>{t('rec.finer')}</li> : null}
            {rec & Rec.EDGE_CUT ? <li>{t('rec.edgeCut')}</li> : null}
          </ul>
          <small className="muted">{t('rec.note')}</small>
        </div>
      )}
    </section>
  );

  const shapeSection = (
    <section className="w5ue-sec">
      <h4>{t('edit.shape')}</h4>
      <fieldset className="w1fx-fieldset" disabled={ro}>
        <div className="btn-row wrap" data-testid="shape-buttons">
          <button className={`btn small ${shapeKind === CellKind.FULL ? 'primary' : ''}`} onClick={() => setKind({ kind: CellKind.FULL })} data-testid="kind-full">
            {t('edit.full')}
          </button>
          <button
            className={`btn small ${shapeKind === CellKind.DIAG_A ? 'primary' : ''}`}
            disabled={!!allowed.diagA}
            title={why(allowed.diagA, { kind: CellKind.DIAG_A })}
            onClick={() => setKind({ kind: CellKind.DIAG_A })}
            data-testid="kind-diagA"
          >
            {t('edit.diagA')}
          </button>
          <button
            className={`btn small ${shapeKind === CellKind.DIAG_B ? 'primary' : ''}`}
            disabled={!!allowed.diagB}
            title={why(allowed.diagB, { kind: CellKind.DIAG_B })}
            onClick={() => setKind({ kind: CellKind.DIAG_B })}
            data-testid="kind-diagB"
          >
            {t('edit.diagB')}
          </button>
          <button
            className={`btn small ${shapeKind === CellKind.SUB && pieces.length === 4 ? 'primary' : ''}`}
            disabled={!!allowed.sub2}
            title={why(allowed.sub2, { kind: CellKind.SUB, k: 2 })}
            onClick={() => setKind({ kind: CellKind.SUB, k: 2 })}
            data-testid="kind-sub2"
          >
            2×2
          </button>
          <button
            className={`btn small ${shapeKind === CellKind.SUB && pieces.length === 9 ? 'primary' : ''}`}
            disabled={!!allowed.sub3}
            title={why(allowed.sub3, { kind: CellKind.SUB, k: 3 })}
            onClick={() => setKind({ kind: CellKind.SUB, k: 3 })}
            data-testid="kind-sub3"
          >
            3×3
          </button>
          <button className={`btn small ${shapeKind === CellKind.FREE ? 'primary' : ''}`} onClick={() => setFreeOpen(true)} data-testid="kind-free">
            {t('edit.free')}
          </button>
        </div>
        <div className="btn-row wrap" style={{ marginTop: 8 }}>
          <span className="small">{t('edit.lineCut')}:</span>
          <NumberInput value={lineAngle} onChange={setLineAngle} min={0} max={180} suffix="°" width={56} label={t('edit.angle')} />
          <NumberInput value={lineOffset} onChange={setLineOffset} min={-20} max={20} suffix="mm" width={56} label={t('edit.offset')} />
          <button className={`btn small ${shapeKind === CellKind.LINE ? 'primary' : ''}`} disabled={!!lineErr} title={why(lineErr, lineChange)} onClick={() => setKind(lineChange)} data-testid="kind-line">
            {t('common.apply')}
          </button>
        </div>
      </fieldset>
      <small className="muted block">{t('edit.lineHint')}</small>
      {reasons.length > 0 && (
        <ul className="kind-reasons" data-testid="kind-reasons" aria-label={t('edit.notPossible')}>
          {reasons.map((r) => (
            <li key={r.label}>
              <b>{r.label}</b> – {t('edit.notPossible')} {r.text}
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="error">{msg}</p>}
    </section>
  );

  const positionSection = (
    <section className="w5ue-sec">
      <h4>{t('stone.position')}</h4>
      <table className="kv">
        <tbody>
          {sec && (
            <tr>
              <th>{t('stone.section')}</th>
              <td>{sec.id}</td>
            </tr>
          )}
          <tr>
            <th>{t('stone.coords')}</th>
            <td data-testid="stone-coords">
              X {n(b.minX, 2)} mm · Y {n(b.minY, 2)} mm
              <small className="muted block">
                {t('stone.center')}: {n(ctr.x, 2)} / {n(ctr.y, 2)} mm · {t('stone.originHint')}
              </small>
            </td>
          </tr>
          <tr>
            <th>{t('stone.color')}</th>
            <td>
              <Swatch hex={pc?.hex ?? '#000'} size={18} /> <b>{codeOf(pc)}</b> {pc ? paletteDisplayName(pc, lang) : ''} · {pc?.hex}
              <small className="muted block">
                L*a*b* {n(pc?.lab[0] ?? 0, 1)} / {n(pc?.lab[1] ?? 0, 1)} / {n(pc?.lab[2] ?? 0, 1)}
                {material && (
                  <span data-testid="stone-material">
                    {` · ${t('stone.material')}: ${[material.manufacturer, material.product, material.colorNumber].filter((x) => x && x.trim()).join(' ') || material.colorName}`}
                  </span>
                )}
              </small>
              {material === undefined && (
                <span className="w3fe-stone-badge" data-testid="stone-material-missing" title={t('w2ch.materialMissingTitle')}>
                  <Badge kind="warn">{t('w3fe.materialMissing')}</Badge>
                </span>
              )}
            </td>
          </tr>
          <tr>
            <th>{t('stone.size')}</th>
            <td data-testid="stone-size">
              {n(info.w, 2)} × {n(info.h, 2)} mm · {t('stone.area')} {n(info.area, 2)} mm²
              {!info.invalid && info.needsCut && info.convex && (
                <small className="muted block" data-testid="stone-min-width">
                  {t('stone.minWidth', { w: n(width.caliper, 2), inc: n(width.incircle, 2) })}
                </small>
              )}
            </td>
          </tr>
          <tr>
            <th>{t('stone.shape')}</th>
            <td>{t(`shape.${info.shape}`)}</td>
          </tr>
          <tr>
            <th>{t('stone.raw')}</th>
            <td>
              {n(info.rawW, 2)} × {n(info.rawH, 2)} mm
            </td>
          </tr>
        </tbody>
      </table>
      <h4>{t('stone.neighbors')}</h4>
      <div className="neighbors">
        {neighbors(layout, p.row, p.col).map((nb) => {
          const nps = cellPieces(layout, data, nb.row, nb.col);
          return (
            <button key={nb.dir} className="neighbor" onClick={() => p.onNavigate(nb.row, nb.col, 0)}>
              <span className="muted">{t(`dir.${nb.dir}`)}</span> <b>{cellId(layout, nb.row, nb.col)}</b>{' '}
              {nps.map((q, i) => (
                <span key={i} title={palette[q.color] ? `${codeOf(palette[q.color])} ${paletteDisplayName(palette[q.color], lang)}` : ''}>
                  <Swatch hex={palette[q.color]?.hex ?? '#000'} size={12} />
                </span>
              ))}
            </button>
          );
        })}
      </div>
    </section>
  );

  const content = (
    // „stone-grid“: bisherige Klasse des Inhalts (Tests anderer Pakete lesen darüber den Text); hier einspaltig, siehe CSS
    <div className={`w5ue-stone stone-grid ${variant === 'panel' ? 'w5ue-stone-panel' : 'w5ue-stone-modal'}`} data-w5ue-history="">
      {ro && (
        <p className="w1mc-notice w1fx-locked small" role="status" data-testid="stone-locked">
          {t('w2ws.lockedComputing')}
        </p>
      )}
      {summary}
      {colorSection}
      {cutSection}
      {shapeSection}
      {positionSection}
    </div>
  );

  const freeEditor = freeOpen && !ro && (
    <FreeformEditor
      cellW={cell.w}
      cellH={cell.h}
      joint={layout.joint}
      initial={freeEditorPieces(layout, data, p.row, p.col)}
      palette={palette}
      minPieceMm={p.minPieceMm}
      onClose={() => setFreeOpen(false)}
      onSave={(fp) => {
        const box = { ok: false };
        edit(
          () => {
            box.ok = setFreePieces(layout, data, p.row, p.col, fp, p.minPieceMm).ok;
          },
          { key: 'w5ue.h.free', params: { id: cid } },
          { idx, piece: 0 },
        );
        if (box.ok) {
          setFreeOpen(false);
          p.onNavigate(p.row, p.col, 0);
        }
        return box.ok;
      }}
    />
  );

  const title = `${t('stone.title')} ${id}`;
  if (variant === 'panel')
    return (
      <section className="w5ue-panel" role="dialog" aria-modal="false" aria-labelledby={headId} data-testid="stone-panel">
        <div className="w5ue-panel-head">
          <h3 id={headId}>{title}</h3>
          {p.history}
          {/* gleiche Testkennung wie der Schließen-Knopf der Dialoge: das Steindetail schließt überall gleich */}
          <button type="button" className="icon-btn" onClick={p.onClose} aria-label={t('w5ue.closePanel')} title={`${t('w5ue.closePanel')} (Esc)`} data-testid="modal-close">
            ✕
          </button>
        </div>
        <div className="w5ue-panel-body">{content}</div>
        {/* Freiform-Editor als Dialog über allem (die Seitenleiste klebt und bildet eine eigene Ebene) */}
        {freeEditor && createPortal(freeEditor, document.body)}
      </section>
    );
  return (
    <Modal title={title} onClose={p.onClose}>
      {content}
      {freeEditor}
    </Modal>
  );
}
