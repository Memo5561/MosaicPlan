/**
 * Freiform-Editor für eine Rasterzelle (w3-freeform-editor).
 *
 * Zeichenfläche in mm (viewBox), Zeigerpositionen über getScreenCTM().inverse() – richtig auch dann, wenn
 * CSS die Fläche verkleinert. Eckpunkte lassen sich mit Maus, Finger oder Stift ziehen, „+“ auf einer Kante
 * fügt einen Punkt ein, Vorlagen und „Neu zeichnen“ ersetzen alle Teile. Nur angeklickte und gezogene Punkte
 * werden eingerastet (snapFreePoint); vorgeladene Teile und Vorlagen behalten ihre exakten Koordinaten.
 *
 * Alles Angezeigte wird aus den gezeichneten Koordinaten berechnet (Kantenlängen, Fläche, Außenmaß);
 * validateFreePieces ist die einzige Prüfung – dieselbe, die setFreePieces beim Speichern anwendet.
 */
import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { paletteDisplayName } from '../../core/colorNames';
import { freeIssuePieces, MAX_FREE_PIECES, snapFreePoint, validateFreePieces, type FreeIssue } from '../../core/edits';
import { area, bbox, centroid, cleanPoly, signedArea, type Pt } from '../../core/geometry';
import { freePreset, FREE_PRESET_KINDS, type FreePresetKind } from '../../core/pieces';
import type { FreePiece, PaletteColor } from '../../core/types';
import { useI18n, type TFunc } from '../../i18n';
import { Modal, NumberInput, Swatch } from '../components';
import '../css/w3-freeform-editor.css';

type NFmt = (v: number, decimals?: number) => string;

/** Übersetzter Text eines Prüfbefunds (eine Zeile), z. B. „Teil 1 und Teil 3 überlappen sich (2,5 mm²) …“. */
export function freeIssueText(issue: FreeIssue, t: TFunc, n: NFmt, cellW: number, cellH: number): string {
  switch (issue.code) {
    case 'noPieces':
      return t('free.err.noPieces');
    case 'tooMany':
      return t('free.err.tooMany', { count: issue.count, max: issue.max });
    case 'tooFewPoints':
      return t('free.err.tooFewPoints', { piece: issue.piece, count: issue.count });
    case 'selfIntersect':
      return t('free.err.selfIntersect', { piece: issue.piece });
    case 'outside':
      return t('free.err.outside', { piece: issue.piece, w: n(cellW, 2), h: n(cellH, 2) });
    case 'areaTooSmall':
      return t('free.err.areaTooSmall', { piece: issue.piece, area: n(issue.areaMm2, 2), min: n(issue.minMm2, 2) });
    case 'overlap':
      return t('free.err.overlap', { a: issue.a, b: issue.b, area: n(issue.areaMm2, 2) });
    case 'thin': {
      const s = t('free.warn.thin', { piece: issue.piece, min: n(issue.minMm, 2), cal: n(issue.caliperMm, 2), inc: n(issue.incircleMm, 2) });
      return issue.convex ? s : `${s} ${t('free.warn.thinApprox')}`;
    }
    case 'gap':
      // unter 0,005 mm würde „0“ angezeigt: dann ehrlich „berühren sich“
      return issue.gapMm < 0.005
        ? t('free.warn.touch', { a: issue.a, b: issue.b, joint: n(issue.jointMm, 2) })
        : t('free.warn.gap', { a: issue.a, b: issue.b, gap: n(issue.gapMm, 2), joint: n(issue.jointMm, 2) });
  }
}

export interface FreeformEditorProps {
  cellW: number;
  cellH: number;
  /** Projektfuge in mm (für die Fugenprüfung und die Vorlagen) */
  joint: number;
  /** vorgeladene Teile, relativ zur oberen linken Zellecke (exakt, ungerundet) */
  initial: FreePiece[];
  palette: PaletteColor[];
  minPieceMm: number;
  onClose: () => void;
  onSave: (p: FreePiece[]) => boolean;
}

interface DragState {
  pointerId: number;
  mode: 'add' | 'vertex';
  pi: number;
  k: number;
  sx: number;
  sy: number;
  moved: boolean;
  /** Zustand vor dem Ziehen liegt bereits im Verlauf (Rückgängig) */
  pushed: boolean;
}

const HISTORY_MAX = 100;

function presetLabel(k: FreePresetKind, t: TFunc): string {
  switch (k) {
    case 'full':
      return t('w3fe.preset.full');
    case 'diagA':
      return t('w3fe.preset.diagA');
    case 'diagB':
      return t('w3fe.preset.diagB');
    case 'half':
      return t('w3fe.preset.half');
    case 'rhombus':
      return t('w3fe.preset.rhombus');
    case 'trapezoid':
      return t('w3fe.preset.trapezoid');
  }
}

const mapPiece = (ps: FreePiece[], pi: number, fn: (p: FreePiece) => FreePiece) => ps.map((p, i) => (i === pi ? fn(p) : p));
const segLen = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

export function FreeformEditor(props: FreeformEditorProps) {
  const { t, n, lang } = useI18n();
  const W = props.cellW;
  const H = props.cellH;
  const joint = Math.max(0, props.joint);
  const [pieces, setPieces] = useState<FreePiece[]>(() => props.initial.map((p) => ({ poly: p.poly.map((q) => ({ x: q.x, y: q.y })), color: p.color })));
  const [active, setActive] = useState(0);
  const [history, setHistory] = useState<FreePiece[][]>([]);
  const lastKey = useRef<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // Bildschirmpixel je mm: damit Griffe, Linien und Beschriftungen auf jeder Größe gleich groß bleiben
  const [ppm, setPpm] = useState(40);
  /** Verfügbarer Platz der Zeichenfläche in CSS-Pixeln (Breite des Containers, höchstens 560; Höhe 60 % des Fensters) */
  const [avail, setAvail] = useState<{ w: number; h: number } | null>(null);
  const coarse = useMemo(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches, []);

  const v = useMemo(() => validateFreePieces(W, H, pieces, props.minPieceMm, joint), [W, H, pieces, props.minPieceMm, joint]);
  const errPieces = useMemo(() => new Set(v.errors.flatMap(freeIssuePieces)), [v]);
  const warnPieces = useMemo(() => new Set(v.warnings.flatMap(freeIssuePieces)), [v]);
  const presets = useMemo(() => new Map(FREE_PRESET_KINDS.map((k) => [k, freePreset(k, W, H, joint)] as const)), [W, H, joint]);

  const ai = Math.min(active, Math.max(0, pieces.length - 1));
  const act: FreePiece | undefined = pieces[ai];
  const baseColor = act?.color ?? props.initial[0]?.color ?? 0;

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const m = svg.getScreenCTM();
      if (m && m.a > 0 && Number.isFinite(m.a)) setPpm(m.a);
      const cw = svg.parentElement?.clientWidth ?? 0;
      const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
      if (cw > 0 && vh > 0) {
        const next = { w: Math.min(560, cw), h: 0.6 * vh };
        setAvail((a) => (a && Math.abs(a.w - next.w) < 0.5 && Math.abs(a.h - next.h) < 0.5 ? a : next));
      }
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(svg);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  /** Änderung mit Verlaufseintrag; gleiche `key` hintereinander (z. B. Tippen in ein Zahlenfeld) ergeben einen Eintrag. */
  const commit = (next: FreePiece[], key: string | null = null) => {
    if (key === null || key !== lastKey.current) setHistory((h) => [...h.slice(-(HISTORY_MAX - 1)), pieces]);
    lastKey.current = key;
    setPieces(next);
  };
  const undo = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    lastKey.current = null;
    setPieces(prev);
    setActive((a) => Math.min(a, Math.max(0, prev.length - 1)));
  };

  const toMm = (clientX: number, clientY: number): Pt | null => {
    const m = svgRef.current?.getScreenCTM();
    if (!m) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (drag.current) return; // zweiter Finger: ignorieren
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const svg = e.currentTarget;
    const el = (e.target as Element).closest('[data-vtx],[data-mid]');
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* ältere Browser: ohne Capture weiter */
    }
    const base = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false };
    const vtx = el?.getAttribute('data-vtx');
    if (vtx) {
      const [pi, k] = vtx.split(':').map(Number);
      setActive(pi);
      drag.current = { ...base, mode: 'vertex', pi, k, pushed: false };
      setDragging(`${pi}:${k}`);
      e.preventDefault();
      return;
    }
    const mid = el?.getAttribute('data-mid');
    if (mid) {
      const [pi, k] = mid.split(':').map(Number);
      const poly = pieces[pi]?.poly;
      if (!poly || poly.length < 2) return;
      const a = poly[k];
      const b = poly[(k + 1) % poly.length];
      // genau in der Kantenmitte einfügen: die Form bleibt gleich, bis der Punkt gezogen wird
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      commit(mapPiece(pieces, pi, (p) => ({ ...p, poly: [...p.poly.slice(0, k + 1), m, ...p.poly.slice(k + 1)] })));
      setActive(pi);
      drag.current = { ...base, mode: 'vertex', pi, k: k + 1, pushed: true };
      setDragging(`${pi}:${k + 1}`);
      e.preventDefault();
      return;
    }
    drag.current = { ...base, mode: 'add', pi: ai, k: -1, pushed: false };
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.moved) {
      const slop = e.pointerType === 'mouse' ? 3 : 8;
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < slop) return;
      d.moved = true;
    }
    if (d.mode !== 'vertex') return;
    const p = toMm(e.clientX, e.clientY);
    if (!p) return;
    const q = snapFreePoint(p, W, H);
    if (!d.pushed) {
      setHistory((h) => [...h.slice(-(HISTORY_MAX - 1)), pieces]);
      lastKey.current = null;
      d.pushed = true;
    }
    setPieces((ps) => mapPiece(ps, d.pi, (pc) => ({ ...pc, poly: pc.poly.map((r, j) => (j === d.k ? q : r)) })));
    e.preventDefault();
  };

  const endDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* bereits freigegeben */
    }
    drag.current = null;
    setDragging(null);
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    endDrag(e);
    // Ein Punkt entsteht nur bei einem Klick/Tippen ohne Bewegung, nie nach dem Ziehen eines Punkts
    if (d.mode !== 'add' || d.moved) return;
    const p = toMm(e.clientX, e.clientY);
    if (!p) return;
    const q = snapFreePoint(p, W, H);
    if (pieces.length === 0) {
      commit([{ poly: [q], color: baseColor }]);
      setActive(0);
      return;
    }
    commit(mapPiece(pieces, ai, (pc) => ({ ...pc, poly: [...pc.poly, q] })));
  };

  const onPointerCancel = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointerId === e.pointerId) endDrag(e);
  };

  // ---------- Werkzeuge
  const clearAll = () => {
    commit([{ poly: [], color: baseColor }]);
    setActive(0);
  };
  const applyPreset = (k: FreePresetKind) => {
    const polys = presets.get(k);
    if (!polys) return;
    const c0 = pieces[0]?.color ?? baseColor;
    const c1 = pieces[1]?.color ?? c0;
    commit(polys.map((poly, i) => ({ poly: poly.map((q) => ({ x: q.x, y: q.y })), color: i === 0 ? c0 : c1 })));
    setActive(0);
  };
  const addPiece = () => {
    if (pieces.length >= MAX_FREE_PIECES) return;
    commit([...pieces, { poly: [], color: baseColor }]);
    setActive(pieces.length);
  };
  const deletePiece = () => {
    commit(pieces.filter((_, i) => i !== ai));
    setActive(Math.max(0, ai - 1));
  };
  const setPt = (k: number, patch: Partial<Pt>, key: string) =>
    commit(
      mapPiece(pieces, ai, (p) => ({ ...p, poly: p.poly.map((q, j) => (j === k ? { ...q, ...patch } : q)) })),
      key,
    );
  const deletePt = (k: number) => commit(mapPiece(pieces, ai, (p) => ({ ...p, poly: p.poly.filter((_, j) => j !== k) })));

  // ---------- Maße (exakt aus den gezeichneten Koordinaten)
  const maxD = Math.max(W, H);
  // Rand um die Zelle in BILDSCHIRMPIXELN bemessen (nicht als Anteil der Zelle): Die Kantenlängen stehen außen und
  // brauchen ~LABEL_PX – sonst würden sie auf dem Handy am Rand abgeschnitten („4,:“). Aus pad · ppm ≥ LABEL_PX mit
  // ppm = Platz / (Maß + 2 · pad) folgt pad ≥ LABEL_PX · Maß / (Platz − 2 · LABEL_PX), für Breite und Höhe.
  const LABEL_PX = 44;
  const padFor = (dim: number, space: number) => (space > 2 * LABEL_PX + 20 ? (LABEL_PX * dim) / (space - 2 * LABEL_PX) : maxD * 0.5);
  const pad = Math.max(maxD * 0.1, avail ? Math.max(padFor(W, avail.w), padFor(H, avail.h)) : maxD * 0.2);
  const px = (v0: number) => v0 / ppm;
  const fs = px(12);
  const gridStep = maxD <= 30 ? 1 : maxD <= 150 ? 5 : 10;
  const otherArea = pieces.reduce((s, p, i) => (i === ai ? s : s + area(cleanPoly(p.poly))), 0);
  const showFullHint = !!act && act.poly.length < 3 && pieces.length > 1 && otherArea >= 0.9 * W * H;
  const actClean = act ? cleanPoly(act.poly) : [];
  const actBox = act && act.poly.length > 0 ? bbox(act.poly) : null;

  const edgeCount = (poly: Pt[]) => (poly.length >= 3 ? poly.length : poly.length === 2 ? 1 : 0);
  const outward = (poly: Pt[], a: Pt, b: Pt) => {
    const L = segLen(a, b) || 1;
    const s = poly.length >= 3 ? Math.sign(signedArea(poly)) || 1 : 1;
    return { x: (s * (b.y - a.y)) / L, y: (-s * (b.x - a.x)) / L };
  };

  const pieceColor = (c: number) => props.palette[c]?.hex ?? '#cccccc';
  const drawing = !!act && act.poly.length < 3;
  const order = pieces.map((_, i) => i).filter((i) => i !== ai);
  if (act) order.push(ai);

  return (
    <Modal
      title={t('free.title')}
      onClose={props.onClose}
      wide
      footer={
        <>
          {!v.ok && (
            <span className="w3fe-blocked small" data-testid="free-save-blocked">
              {t('w3fe.saveBlocked')}
            </span>
          )}
          <button className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={!v.ok} onClick={() => props.onSave(pieces)} data-testid="free-save">
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="w3fe-editor">
        <p className="muted small w3fe-hint">{t('w3fe.hint', { w: n(W, 2), h: n(H, 2), joint: n(joint, 2) })}</p>
        <div className="w3fe-toolbar" role="toolbar">
          <button className="btn small" onClick={undo} disabled={history.length === 0} title={t('w3fe.undoTitle')} data-testid="free-undo">
            ↶ {t('w3fe.undo')}
          </button>
          <button className="btn small" onClick={clearAll} title={t('w3fe.clearTitle')} data-testid="free-clear">
            {t('w3fe.clear')}
          </button>
          <span className="w3fe-presets-label small muted">{t('w3fe.presets')}</span>
          {FREE_PRESET_KINDS.map((k) => {
            const ok = !!presets.get(k);
            return (
              <button
                key={k}
                className="btn small"
                disabled={!ok}
                title={ok ? t('w3fe.presetTitle', { joint: n(joint, 2) }) : t('w3fe.presetImpossible')}
                onClick={() => applyPreset(k)}
                data-testid={`free-preset-${k}`}
              >
                {presetLabel(k, t)}
              </button>
            );
          })}
        </div>
        <div className="w3fe-grid">
          <div className="w3fe-canvas">
            <svg
              ref={svgRef}
              className={`free-svg w3fe-svg ${dragging ? 'dragging' : ''}`}
              viewBox={`${-pad} ${-pad} ${W + 2 * pad} ${H + 2 * pad}`}
              style={{ aspectRatio: `${W + 2 * pad} / ${H + 2 * pad}` }}
              aria-label={t('w3fe.canvasLabel')}
              data-testid="free-svg"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onContextMenu={(e) => e.preventDefault()}
            >
              <rect x={0} y={0} width={W} height={H} className="w3fe-cell" />
              {Array.from({ length: Math.floor(W / gridStep + 1e-9) + 1 }, (_, i) => (
                <line key={`gx${i}`} x1={i * gridStep} y1={0} x2={i * gridStep} y2={H} className="w3fe-gridline" />
              ))}
              {Array.from({ length: Math.floor(H / gridStep + 1e-9) + 1 }, (_, i) => (
                <line key={`gy${i}`} x1={0} y1={i * gridStep} x2={W} y2={i * gridStep} className="w3fe-gridline" />
              ))}
              <rect x={0} y={0} width={W} height={H} className="w3fe-cell-edge" />
              {/* Ebene 1: Flächen und Umrisse (gewähltes Teil zuletzt) */}
              {order.map((i) => {
                const p = pieces[i];
                const isAct = i === ai;
                const pts = p.poly.map((q) => `${q.x},${q.y}`).join(' ');
                return (
                  <g key={`p${i}`} className={`w3fe-piece ${isAct ? 'active' : ''}`} data-piece={i + 1}>
                    {p.poly.length >= 3 && <polygon points={pts} fill={pieceColor(p.color)} className="w3fe-fill" />}
                    {isAct ? (
                      <>
                        {p.poly.length >= 2 && <polyline points={pts} className="w3fe-outline active" />}
                        {p.poly.length >= 3 && (
                          <line
                            x1={p.poly[p.poly.length - 1].x}
                            y1={p.poly[p.poly.length - 1].y}
                            x2={p.poly[0].x}
                            y2={p.poly[0].y}
                            className="w3fe-closing"
                            data-testid="free-closing"
                          />
                        )}
                      </>
                    ) : (
                      p.poly.length >= 2 && <polygon points={pts} className="w3fe-outline" />
                    )}
                  </g>
                );
              })}
              {/* Ebene 2: Teile mit Fehlern (rot) oder Hinweisen (orange) gestrichelt umrandet */}
              {pieces.map((p, i) => {
                const err = errPieces.has(i);
                if ((!err && !warnPieces.has(i)) || p.poly.length < 2) return null;
                return (
                  <polygon
                    key={`i${i}`}
                    points={p.poly.map((q) => `${q.x},${q.y}`).join(' ')}
                    className={err ? 'w3fe-issue-err' : 'w3fe-issue-warn'}
                    data-testid={err ? 'free-piece-error' : 'free-piece-warning'}
                    data-piece={i + 1}
                  />
                );
              })}
              {/* Ebene 3: Teilnummern */}
              {pieces.map((p, i) => {
                const ctr = p.poly.length >= 3 && area(p.poly) > 1e-9 ? centroid(p.poly) : null;
                if (!ctr) return null;
                return (
                  <g key={`n${i}`} className={`w3fe-num ${i === ai ? 'active' : ''}`} pointerEvents="none">
                    <circle cx={ctr.x} cy={ctr.y} r={px(10)} />
                    <text x={ctr.x} y={ctr.y} fontSize={px(11)} dy="0.35em" textAnchor="middle">
                      {i + 1}
                    </text>
                  </g>
                );
              })}
              {/* Ebene 4: Kantenlängen und „+“ des gewählten Teils */}
              {act &&
                Array.from({ length: edgeCount(act.poly) }, (_, k) => {
                  const a = act.poly[k];
                  const b = act.poly[(k + 1) % act.poly.length];
                  const L = segLen(a, b);
                  const o = outward(act.poly, a, b);
                  const label = n(L, 1);
                  // Abstand nach außen: Griff „+“ (6 px) + halbe Textbreite in Normalenrichtung
                  const off = px(13 + Math.abs(o.x) * label.length * 3.6 + Math.abs(o.y) * 5);
                  const mx = (a.x + b.x) / 2;
                  const my = (a.y + b.y) / 2;
                  // Sicherheitsnetz: Beschriftung bleibt innerhalb der Zeichenfläche
                  const halfW = px(label.length * 3.6 + 3);
                  const halfH = px(8);
                  const lx = Math.min(W + pad - halfW, Math.max(-pad + halfW, mx + o.x * off));
                  const ly = Math.min(H + pad - halfH, Math.max(-pad + halfH, my + o.y * off));
                  const showMid = L * ppm >= 30;
                  return (
                    <g key={`e${k}`}>
                      <text
                        x={lx}
                        y={ly}
                        fontSize={fs}
                        dy="0.35em"
                        textAnchor="middle"
                        className={`w3fe-len ${act.poly.length >= 3 && k === act.poly.length - 1 ? 'closing' : ''}`}
                        strokeWidth={px(3)}
                        pointerEvents="none"
                        data-testid="free-edge-len"
                      >
                        {label}
                      </text>
                      {showMid && (
                        <g className="w3fe-mid" data-mid={`${ai}:${k}`} data-testid="free-mid">
                          <circle cx={mx} cy={my} r={px(coarse ? 14 : 9)} className="w3fe-hit" />
                          <circle cx={mx} cy={my} r={px(6)} className="w3fe-mid-dot" />
                          <path d={`M${mx - px(3.5)} ${my}H${mx + px(3.5)}M${mx} ${my - px(3.5)}V${my + px(3.5)}`} className="w3fe-mid-plus" />
                        </g>
                      )}
                    </g>
                  );
                })}
              {/* Ebene 5: Eckpunkte (ziehbar), die des gewählten Teils oben und nummeriert */}
              {order.map((i) =>
                pieces[i].poly.map((q, k) => {
                  const isAct = i === ai;
                  // Solange das gewählte Teil gezeichnet wird (< 3 Punkte), setzt jeder Klick einen Punkt –
                  // auch auf einer Ecke eines anderen Teils (sonst würde dieses Teil gewählt und gezogen)
                  const locked = !isAct && drawing;
                  return (
                    <g
                      key={`v${i}:${k}`}
                      className={`w3fe-vtx ${dragging === `${i}:${k}` ? 'dragging' : ''}`}
                      data-vtx={locked ? undefined : `${i}:${k}`}
                      pointerEvents={locked ? 'none' : undefined}
                      data-testid={isAct ? 'free-vertex' : undefined}
                    >
                      <circle cx={q.x} cy={q.y} r={px(isAct ? (coarse ? 22 : 13) : coarse ? 14 : 8)} className="w3fe-hit" />
                      {isAct ? (
                        <>
                          <circle cx={q.x} cy={q.y} r={px(9)} className="w3fe-vtx-dot active" />
                          <text x={q.x} y={q.y} fontSize={px(10)} dy="0.35em" textAnchor="middle" className="w3fe-vtx-no" pointerEvents="none">
                            {k + 1}
                          </text>
                        </>
                      ) : (
                        <circle cx={q.x} cy={q.y} r={px(4)} className="w3fe-vtx-dot" />
                      )}
                    </g>
                  );
                }),
              )}
            </svg>
          </div>
          <div className="w3fe-side">
            <div className="btn-row wrap w3fe-tabs">
              {pieces.map((p, i) => (
                <button
                  key={i}
                  className={`btn small w3fe-tab ${i === ai ? 'primary' : ''}`}
                  aria-pressed={i === ai}
                  onClick={() => setActive(i)}
                  data-testid="free-piece-tab"
                >
                  <Swatch hex={pieceColor(p.color)} size={12} /> {t('stone.piece')} {i + 1}
                  {errPieces.has(i) ? (
                    <span className="w3fe-dot err" title={t('w3fe.hasError')} aria-label={t('w3fe.hasError')} />
                  ) : warnPieces.has(i) ? (
                    <span className="w3fe-dot warn" title={t('w3fe.hasWarning')} aria-label={t('w3fe.hasWarning')} />
                  ) : null}
                </button>
              ))}
              <button
                className="btn small"
                onClick={addPiece}
                disabled={pieces.length >= MAX_FREE_PIECES}
                title={pieces.length >= MAX_FREE_PIECES ? t('w3fe.maxPieces', { max: MAX_FREE_PIECES }) : undefined}
                data-testid="free-new-piece"
              >
                + {t('free.newPiece')}
              </button>
            </div>
            {showFullHint && (
              <p className="small w3fe-fullhint" data-testid="free-full-hint">
                {t('w3fe.fullHint')}
              </p>
            )}
            {act && (
              <>
                <div className="btn-row wrap w3fe-piece-tools">
                  <select
                    value={act.color}
                    aria-label={t('stone.color')}
                    onChange={(e) => commit(mapPiece(pieces, ai, (p) => ({ ...p, color: +e.target.value })), `color:${ai}`)}
                  >
                    {props.palette.map((c, i) => (
                      <option key={i} value={i}>
                        {String(c.code).padStart(2, '0')} {paletteDisplayName(c, lang)}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn small"
                    disabled={act.poly.length === 0}
                    onClick={() => commit(mapPiece(pieces, ai, (p) => ({ ...p, poly: p.poly.slice(0, -1) })))}
                    data-testid="free-undo-point"
                  >
                    {t('free.undoPoint')}
                  </button>
                  <button className="btn small danger" onClick={deletePiece} data-testid="free-delete-piece">
                    {t('free.deletePiece')}
                  </button>
                </div>
                {act.poly.length >= 3 && actBox && (
                  <div className="w3fe-measure" data-testid="free-measure">
                    <b>{t('w3fe.measure', { piece: ai + 1 })}</b>
                    <div>{t('w3fe.measureVals', { k: act.poly.length, area: n(area(actClean), 2), w: n(actBox.w, 2), h: n(actBox.h, 2) })}</div>
                    <small className="muted">{t('w3fe.measureNote')}</small>
                  </div>
                )}
                {act.poly.length === 0 ? (
                  <p className="small muted w3fe-nopts">{t('w3fe.noPoints')}</p>
                ) : (
                  <div className="w3fe-pts">
                    <table className="mini w3fe-table" data-testid="free-points">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>X (mm)</th>
                          <th>Y (mm)</th>
                          <th title={t('w3fe.edgeTitle')}>{t('w3fe.edge')}</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {act.poly.map((q, k) => {
                          const next = act.poly[(k + 1) % act.poly.length];
                          const hasEdge = act.poly.length >= 3 || (act.poly.length === 2 && k === 0);
                          return (
                            <tr key={k} className={dragging === `${ai}:${k}` ? 'w3fe-row-drag' : ''} data-testid="free-point-row">
                              <td>{k + 1}</td>
                              <td>
                                <NumberInput value={q.x} onChange={(x) => setPt(k, { x }, `num:${ai}:${k}:x`)} min={0} max={W} width={64} decimals={2} label={`X ${k + 1}`} testId={`free-x-${k}`} />
                              </td>
                              <td>
                                <NumberInput value={q.y} onChange={(y) => setPt(k, { y }, `num:${ai}:${k}:y`)} min={0} max={H} width={64} decimals={2} label={`Y ${k + 1}`} testId={`free-y-${k}`} />
                              </td>
                              <td className="num muted" data-testid="free-edge-cell">
                                {hasEdge ? n(segLen(q, next), 2) : '–'}
                              </td>
                              <td>
                                <button
                                  className="icon-btn w3fe-del"
                                  onClick={() => deletePt(k)}
                                  aria-label={t('w3fe.deletePoint', { k: k + 1 })}
                                  title={t('w3fe.deletePoint', { k: k + 1 })}
                                  data-testid="free-del-point"
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
            <div className="w3fe-issues" aria-live="polite" data-testid="free-issues">
              <h5>{t('w3fe.check')}</h5>
              {v.errors.length === 0 && v.warnings.length === 0 ? (
                <p className="w3fe-ok small" data-testid="free-ok">
                  ✓ {t('w3fe.allOk')}
                </p>
              ) : (
                <ul>
                  {v.errors.map((is, k) => (
                    <li key={`e${k}`} className="err" data-testid="free-error">
                      {freeIssueText(is, t, n, W, H)}
                    </li>
                  ))}
                  {v.warnings.map((is, k) => (
                    <li key={`w${k}`} className="warn" data-testid="free-warning">
                      {freeIssueText(is, t, n, W, H)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
