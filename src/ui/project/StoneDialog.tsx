import { useMemo, useState } from 'react';
import { deltaE2000 } from '../../core/color';
import { bbox, centroid, type Pt } from '../../core/geometry';
import { cellId, sectionOfCell, type Layout, type SectionGrid } from '../../core/layout';
import { analyzeCut, cellPieces, cellRect, type CutInfo } from '../../core/pieces';
import { neighbors, setCellKind, setFreePieces, setPieceColor, togglePiecePlaced, setCellPlaced, validateFreePieces } from '../../core/edits';
import { makeRawSizeFn } from '../../core/stats';
import { CellKind, Rec, type FreePiece, type Material, type MosaicData, type PaletteColor } from '../../core/types';
import { useI18n, type TFunc } from '../../i18n';
import { Badge, Modal, NumberInput, Swatch } from '../components';
import { CutTemplateSvg } from './CutTemplateSvg';

export function cutInstruction(info: CutInfo, t: TFunc, n: (v: number, d?: number) => string): string[] {
  if (!info.fits) return [t('cut.notFit', { w: n(info.w, 1), h: n(info.h, 1), rw: n(info.rawW, 1), rh: n(info.rawH, 1) })];
  if (!info.needsCut) return [t('cut.none', { w: n(info.w, 1), h: n(info.h, 1) })];
  const out: string[] = [];
  if (info.shape === 'rectangle' || info.shape === 'square') {
    if (info.polyInRaw.length === 4 && info.cutLines.every(([a, b]) => Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6))
      out.push(t('cut.rect', { w: n(info.w, 1), h: n(info.h, 1) }));
  } else if (info.shape === 'triangle') {
    const e = [...info.edges].sort((a, b) => a - b);
    out.push(t('cut.triangle', { a: n(e[0], 1), b: n(e[1], 1), c: n(e[2], 1) }));
  } else {
    out.push(t('cut.polygon', { k: info.polyInRaw.length }));
  }
  info.cutLines.forEach(([a, b], i) => out.push(t('cut.line', { i: i + 1, x1: n(a.x, 1), y1: n(a.y, 1), x2: n(b.x, 1), y2: n(b.y, 1) })));
  out.push(t('cut.angles', { a: info.angles.map((a) => `${n(a, 1)}°`).join(', ') }));
  if (!info.convex) out.push(t('cut.nonConvex'));
  return out;
}

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
  onChanged: () => void;
  onProgress: () => void;
}

export function StoneDialog(p: Props) {
  const { t, n } = useI18n();
  const [, setTick] = useState(0);
  const [freeOpen, setFreeOpen] = useState(false);
  const [lineAngle, setLineAngle] = useState(45);
  const [lineOffset, setLineOffset] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const { layout, data, palette } = p;
  const idx = p.row * layout.cols + p.col;
  const pieces = cellPieces(layout, data, p.row, p.col);
  const pi = Math.min(p.piece, pieces.length - 1);
  const piece = pieces[pi];
  const raw = makeRawSizeFn(layout, palette, p.materials);
  const info = piece ? analyzeCut(piece.poly, raw(piece.color).w, raw(piece.color).h) : null;
  const id = cellId(layout, p.row, p.col) + (pieces.length > 1 ? `-${pi + 1}` : '');
  const sec = p.sections ? sectionOfCell(p.sections, p.row, p.col) : null;
  const pc = piece ? palette[piece.color] : undefined;
  const placed = ((data.progress[idx] >> pi) & 1) === 1;
  const rec = data.rec[idx];

  const similar = useMemo(() => {
    if (!pc) return [];
    return palette
      .map((q, i) => ({ i, q, d: deltaE2000(pc.lab[0], pc.lab[1], pc.lab[2], q.lab[0], q.lab[1], q.lab[2]) }))
      .sort((a, b) => a.d - b.d);
  }, [palette, pc]);

  const changed = () => {
    setTick((x) => x + 1);
    p.onChanged();
  };

  if (!piece || !info) return null;
  const b = bbox(piece.poly);
  const ctr = centroid(piece.poly);
  const shapeKind = data.kind[idx];

  const setKind = (kind: number, extra: { k?: 2 | 3; angleDeg?: number; offsetMm?: number } = {}) => {
    const err = setCellKind(layout, data, p.row, p.col, { kind: kind as 0, ...extra }, p.minPieceMm);
    if (err) setMsg(t(`edit.err.${err}`));
    else {
      setMsg(null);
      p.onNavigate(p.row, p.col, 0);
      changed();
    }
  };

  return (
    <Modal title={`${t('stone.title')} ${id}`} onClose={p.onClose} wide>
      <div className="stone-grid">
        <div>
          <table className="kv">
            <tbody>
              <tr>
                <th>{t('stone.position')}</th>
                <td data-testid="stone-id">
                  <b>{id}</b> · {t('stone.row')} {cellId(layout, p.row, 0).replace(/\d+$/, '')} / {t('stone.col')} {p.col + 1}
                  {pieces.length > 1 && ` · ${t('stone.piece')} ${pi + 1}/${pieces.length}`}
                </td>
              </tr>
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
                  <Swatch hex={pc?.hex ?? '#000'} size={22} /> <b>{String(pc?.code ?? '').padStart(2, '0')}</b> {pc?.name} · {pc?.hex}
                  <small className="muted block">
                    L*a*b* {n(pc?.lab[0] ?? 0, 1)} / {n(pc?.lab[1] ?? 0, 1)} / {n(pc?.lab[2] ?? 0, 1)}
                    {pc?.materialId && ` · ${t('stone.material')}: ${(() => {
                      const m = p.materials.find((x) => x.id === pc.materialId);
                      return m ? `${m.manufacturer} ${m.product} ${m.colorNumber}` : '?';
                    })()}`}
                  </small>
                </td>
              </tr>
              <tr>
                <th>{t('stone.size')}</th>
                <td data-testid="stone-size">
                  {n(info.w, 2)} × {n(info.h, 2)} mm · {t('stone.area')} {n(info.area, 2)} mm²
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
              <tr>
                <th>{t('stone.placed')}</th>
                <td>
                  <label className="inline">
                    <input
                      type="checkbox"
                      checked={placed}
                      data-testid="stone-placed"
                      onChange={() => {
                        togglePiecePlaced(data, idx, pi);
                        setTick((x) => x + 1);
                        p.onProgress();
                      }}
                    />{' '}
                    {t('stone.placedThis')}
                  </label>{' '}
                  {pieces.length > 1 && (
                    <button
                      className="btn small"
                      onClick={() => {
                        setCellPlaced(data, idx, true);
                        setTick((x) => x + 1);
                        p.onProgress();
                      }}
                    >
                      {t('stone.placedCell')}
                    </button>
                  )}
                </td>
              </tr>
            </tbody>
          </table>

          <h4>{t('stone.cut')}</h4>
          {info.needsCut ? (
            <Badge kind="ok">{t('stone.computedTemplate')}</Badge>
          ) : (
            <Badge kind="info">{t('stone.noCut')}</Badge>
          )}
          <ul className="cut-list" data-testid="cut-instructions">
            {cutInstruction(info, t, n).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
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

          <h4>{t('stone.neighbors')}</h4>
          <div className="neighbors">
            {neighbors(layout, p.row, p.col).map((nb) => {
              const nps = cellPieces(layout, data, nb.row, nb.col);
              return (
                <button key={nb.dir} className="neighbor" onClick={() => p.onNavigate(nb.row, nb.col, 0)}>
                  <span className="muted">{t(`dir.${nb.dir}`)}</span> <b>{cellId(layout, nb.row, nb.col)}</b>{' '}
                  {nps.map((q, i) => (
                    <span key={i} title={`${String(palette[q.color]?.code).padStart(2, '0')}`}>
                      <Swatch hex={palette[q.color]?.hex ?? '#000'} size={12} />
                    </span>
                  ))}
                </button>
              );
            })}
          </div>
          {pieces.length > 1 && (
            <div className="neighbors">
              {pieces.map((q, i) => (
                <button key={i} className={`neighbor ${i === pi ? 'active' : ''}`} onClick={() => p.onNavigate(p.row, p.col, i)}>
                  {t('stone.piece')} {i + 1} <Swatch hex={palette[q.color]?.hex ?? '#000'} size={12} />
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <CutTemplateSvg info={info} color={pc?.hex ?? '#ccc'} />
          <p className="muted small">{t('stone.templateLegend')}</p>

          <h4>{t('edit.color')}</h4>
          <div className="color-pick" data-testid="color-pick">
            {similar.slice(0, 40).map(({ i, q, d }) => (
              <button
                key={i}
                className={`cp ${i === piece.color ? 'active' : ''}`}
                title={`${String(q.code).padStart(2, '0')} ${q.name} · ΔE ${n(d, 1)}`}
                onClick={() => {
                  setPieceColor(data, idx, pi, i);
                  changed();
                }}
              >
                <Swatch hex={q.hex} size={22} />
                <small>{String(q.code).padStart(2, '0')}</small>
              </button>
            ))}
          </div>

          <h4>{t('edit.shape')}</h4>
          <div className="btn-row wrap">
            <button className={`btn small ${shapeKind === CellKind.FULL ? 'primary' : ''}`} onClick={() => setKind(CellKind.FULL)}>
              {t('edit.full')}
            </button>
            <button className={`btn small ${shapeKind === CellKind.DIAG_A ? 'primary' : ''}`} onClick={() => setKind(CellKind.DIAG_A)}>
              {t('edit.diagA')}
            </button>
            <button className={`btn small ${shapeKind === CellKind.DIAG_B ? 'primary' : ''}`} onClick={() => setKind(CellKind.DIAG_B)}>
              {t('edit.diagB')}
            </button>
            <button className={`btn small ${shapeKind === CellKind.SUB && pieces.length === 4 ? 'primary' : ''}`} onClick={() => setKind(CellKind.SUB, { k: 2 })}>
              2×2
            </button>
            <button className={`btn small ${shapeKind === CellKind.SUB && pieces.length === 9 ? 'primary' : ''}`} onClick={() => setKind(CellKind.SUB, { k: 3 })}>
              3×3
            </button>
            <button className={`btn small ${shapeKind === CellKind.FREE ? 'primary' : ''}`} onClick={() => setFreeOpen(true)}>
              {t('edit.free')}
            </button>
          </div>
          <div className="btn-row wrap" style={{ marginTop: 8 }}>
            <span className="small">{t('edit.lineCut')}:</span>
            <NumberInput value={lineAngle} onChange={setLineAngle} min={0} max={180} suffix="°" width={56} label={t('edit.angle')} />
            <NumberInput value={lineOffset} onChange={setLineOffset} min={-20} max={20} suffix="mm" width={56} label={t('edit.offset')} />
            <button className={`btn small ${shapeKind === CellKind.LINE ? 'primary' : ''}`} onClick={() => setKind(CellKind.LINE, { angleDeg: lineAngle, offsetMm: lineOffset })}>
              {t('common.apply')}
            </button>
          </div>
          <small className="muted block">{t('edit.lineHint')}</small>
          {msg && <p className="error">{msg}</p>}
        </div>
      </div>
      {freeOpen && (
        <FreeformEditor
          cellW={cellRect(layout, p.row, p.col).w}
          cellH={cellRect(layout, p.row, p.col).h}
          initial={pieces.map((q) => ({ poly: q.poly.map((pt) => ({ x: pt.x - cellRect(layout, p.row, p.col).x, y: pt.y - cellRect(layout, p.row, p.col).y })), color: q.color }))}
          palette={palette}
          minPieceMm={p.minPieceMm}
          onClose={() => setFreeOpen(false)}
          onSave={(fp) => {
            const v = setFreePieces(layout, data, p.row, p.col, fp, p.minPieceMm);
            if (v.ok) {
              setFreeOpen(false);
              p.onNavigate(p.row, p.col, 0);
              changed();
            }
            return v.ok;
          }}
        />
      )}
    </Modal>
  );
}

function FreeformEditor(props: {
  cellW: number;
  cellH: number;
  initial: FreePiece[];
  palette: PaletteColor[];
  minPieceMm: number;
  onClose: () => void;
  onSave: (p: FreePiece[]) => boolean;
}) {
  const { t, n } = useI18n();
  const [pieces, setPieces] = useState<FreePiece[]>(() => props.initial.map((p) => ({ poly: p.poly.map((q) => ({ x: round1(q.x), y: round1(q.y) })), color: p.color })));
  const [active, setActive] = useState(0);
  const size = 320;
  const s = (size - 40) / Math.max(props.cellW, props.cellH);
  const pad = 20;
  const v = validateFreePieces(props.cellW, props.cellH, pieces, props.minPieceMm);
  const addPoint = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const x = round1(Math.min(props.cellW, Math.max(0, (e.clientX - r.left - pad) / s)));
    const y = round1(Math.min(props.cellH, Math.max(0, (e.clientY - r.top - pad) / s)));
    setPieces((ps) => {
      const next = ps.map((p) => ({ ...p, poly: [...p.poly] }));
      if (!next[active]) next[active] = { poly: [], color: ps[0]?.color ?? 0 };
      next[active].poly.push({ x, y });
      return next;
    });
  };
  const setPt = (pi: number, k: number, patch: Partial<Pt>) =>
    setPieces((ps) => ps.map((p, i) => (i === pi ? { ...p, poly: p.poly.map((q, j) => (j === k ? { ...q, ...patch } : q)) } : p)));
  return (
    <Modal
      title={t('free.title')}
      onClose={props.onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={!v.ok} onClick={() => props.onSave(pieces)}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <p className="muted small">{t('free.hint', { w: n(props.cellW, 2), h: n(props.cellH, 2) })}</p>
      <div className="stone-grid">
        <svg width={size} height={size} onClick={addPoint} className="free-svg">
          <rect x={pad} y={pad} width={props.cellW * s} height={props.cellH * s} fill="#f4f1ec" stroke="#888" strokeDasharray="4 3" />
          {Array.from({ length: Math.floor(props.cellW) + 1 }, (_, i) => (
            <line key={`gx${i}`} x1={pad + i * s} y1={pad} x2={pad + i * s} y2={pad + props.cellH * s} stroke="#e2ddd3" />
          ))}
          {Array.from({ length: Math.floor(props.cellH) + 1 }, (_, i) => (
            <line key={`gy${i}`} x1={pad} y1={pad + i * s} x2={pad + props.cellW * s} y2={pad + i * s} stroke="#e2ddd3" />
          ))}
          {pieces.map((p, i) => (
            <g key={i}>
              {p.poly.length >= 2 && (
                <polygon
                  points={p.poly.map((q) => `${pad + q.x * s},${pad + q.y * s}`).join(' ')}
                  fill={props.palette[p.color]?.hex ?? '#ccc'}
                  fillOpacity={0.85}
                  stroke={i === active ? '#ff3d00' : '#222'}
                  strokeWidth={i === active ? 2 : 1}
                />
              )}
              {p.poly.map((q, k) => (
                <circle key={k} cx={pad + q.x * s} cy={pad + q.y * s} r={3.5} fill={i === active ? '#ff3d00' : '#222'} />
              ))}
            </g>
          ))}
        </svg>
        <div>
          <div className="btn-row wrap">
            {pieces.map((_, i) => (
              <button key={i} className={`btn small ${i === active ? 'primary' : ''}`} onClick={() => setActive(i)}>
                {t('stone.piece')} {i + 1}
              </button>
            ))}
            <button
              className="btn small"
              onClick={() => {
                setPieces((ps) => [...ps, { poly: [], color: ps[active]?.color ?? 0 }]);
                setActive(pieces.length);
              }}
            >
              + {t('free.newPiece')}
            </button>
          </div>
          {pieces[active] && (
            <>
              <div className="btn-row wrap" style={{ marginTop: 8 }}>
                <select value={pieces[active].color} onChange={(e) => setPieces((ps) => ps.map((p, i) => (i === active ? { ...p, color: +e.target.value } : p)))}>
                  {props.palette.map((c, i) => (
                    <option key={i} value={i}>
                      {String(c.code).padStart(2, '0')} {c.name}
                    </option>
                  ))}
                </select>
                <button className="btn small" onClick={() => setPieces((ps) => ps.map((p, i) => (i === active ? { ...p, poly: p.poly.slice(0, -1) } : p)))}>
                  {t('free.undoPoint')}
                </button>
                <button
                  className="btn small danger"
                  onClick={() => {
                    setPieces((ps) => ps.filter((_, i) => i !== active));
                    setActive(0);
                  }}
                >
                  {t('free.deletePiece')}
                </button>
              </div>
              <table className="mini">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>X (mm)</th>
                    <th>Y (mm)</th>
                  </tr>
                </thead>
                <tbody>
                  {pieces[active].poly.map((q, k) => (
                    <tr key={k}>
                      <td>{k + 1}</td>
                      <td>
                        <NumberInput value={q.x} onChange={(x) => setPt(active, k, { x })} min={0} max={props.cellW} width={60} decimals={2} />
                      </td>
                      <td>
                        <NumberInput value={q.y} onChange={(y) => setPt(active, k, { y })} min={0} max={props.cellH} width={60} decimals={2} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {!v.ok && <p className="error small">{v.errors.join(' · ')}</p>}
          {v.ok && v.warnings.length > 0 && <p className="warn small">{t('free.thin', { min: n(props.minPieceMm, 1) })}</p>}
        </div>
      </div>
    </Modal>
  );
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}
