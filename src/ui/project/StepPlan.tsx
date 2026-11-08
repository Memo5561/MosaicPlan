import { useEffect, useMemo, useRef, useState } from 'react';
import { cellPieceCount } from '../../core/pieces';
import { setRangePlaced, togglePiecePlaced } from '../../core/edits';
import { packMosaic } from '../../core/serialize';
import type { Stats } from '../../core/stats';
import type { Material } from '../../core/types';
import { useI18n } from '../../i18n';
import { runWorker } from '../../workers/client';
import { Badge, downloadBlob, Field, NumberInput, ProgressBar, safeFileName, Segmented, Swatch, Toggle } from '../components';
import { StoneDialog } from './StoneDialog';
import { Viewer, type ViewerHandle } from './Viewer';
import type { ProjectApi } from './useProject';
import '../css/w1-review-fixes.css';

export function StepPlan({ api, materials }: { api: ProjectApi; materials: Material[] }) {
  const { t, n, lang } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);
  const [layMode, setLayMode] = useState(false);
  const [pick, setPick] = useState<{ row: number; col: number; piece: number } | null>(null);
  const [tab, setTab] = useState<'sections' | 'material'>('sections');
  const [csvBusy, setCsvBusy] = useState(false);
  const viewer = useRef<ViewerHandle>(null);
  const c = api.computed;
  const rec = api.rec!;
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
  useEffect(() => {
    if (locked) setLayMode(false);
  }, [locked]);
  if (!c || !G) return <p className={api.integrityError ? 'error' : 'muted'}>{t(api.integrityError ? 'compute.err.integrity' : 'preview.notComputed')}</p>;
  const pr = api.progress;
  const pct = pr && pr.total.total ? pr.total.placed / pr.total.total : 0;
  const doneSections = G.sections.filter((x) => {
    const st = pr?.perSection.get(x.id);
    return st && st.total > 0 && st.placed === st.total;
  }).length;

  const exportCsv = async (ids: string[] | null) => {
    setCsvBusy(true);
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
      downloadBlob(new Blob(['﻿', r.csv], { type: 'text/csv;charset=utf-8' }), `${safeFileName(rec.meta.name)}${ids ? `_${ids.join('-')}` : ''}_koordinaten.csv`);
    } finally {
      setCsvBusy(false);
    }
  };

  return (
    <div>
      <div className="summary-box">
        <div className="stat">
          <span>{t('plan.progress')}</span>
          <b data-testid="progress-pct">{n(pct * 100, 1)} %</b>
        </div>
        <div className="stat">
          <span>{t('plan.placed')}</span>
          <b data-testid="placed-count">{pr ? n(pr.total.placed) : '…'}</b>
        </div>
        <div className="stat">
          <span>{t('plan.open')}</span>
          <b>{pr ? n(pr.total.total - pr.total.placed) : '…'}</b>
        </div>
        <div className="stat">
          <span>{t('plan.sectionsDone')}</span>
          <b>
            {doneSections} / {G.sections.length}
          </b>
        </div>
        <ProgressBar value={pct} />
      </div>
      <div className="viewer-layout">
        <div>
          <div className="btn-row wrap">
            <Toggle checked={layMode && !locked} onChange={setLayMode} label={t('plan.layMode')} hint={t('plan.layModeHint')} disabled={locked} testId="lay-mode" />
          </div>
          {locked && (
            <p className="w1mc-notice w1fx-locked small" role="status" data-testid="edit-locked">
              {t('w2ws.lockedComputing')}
            </p>
          )}
          <Viewer
            ref={viewer}
            layout={c.layout}
            data={c.data}
            palette={rec.palette}
            version={api.version}
            progressVersion={api.progressVersion}
            groutHex={s.groutHex}
            surface={s.surface}
            realistic={false}
            showCodes
            progressMode
            sections={G}
            selectedSection={selected}
            highlight={pick}
            onPick={(row, col, piece) => {
              if (layMode && !locked) {
                const idx = row * c.layout.cols + col;
                if (piece < cellPieceCount(c.data, idx)) togglePiecePlaced(c.data, idx, piece);
                api.touchProgress();
              } else setPick({ row, col, piece });
            }}
          />
        </div>
        <aside className="side">
          <Segmented
            value={tab}
            options={[
              { value: 'sections', label: t('plan.sections') },
              { value: 'material', label: t('plan.material') },
            ]}
            onChange={setTab}
          />
          {tab === 'sections' && (
            <>
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
              <p className="muted small">
                {G.scols} × {G.srows} = {G.sections.length} {t('plan.sectionsCount')}
              </p>
              <div className="section-grid-wrap">
              <div className="section-grid" style={{ gridTemplateColumns: `repeat(${G.scols}, minmax(${G.scols > 8 ? 40 : 0}px, 1fr))` }}>
                {G.sections.map((x) => {
                  const st = pr?.perSection.get(x.id);
                  const p = st && st.total ? st.placed / st.total : 0;
                  return (
                    <button
                      key={x.id}
                      className={`section-cell ${selected === x.id ? 'active' : ''} ${p >= 1 ? 'done' : ''}`}
                      onClick={() => {
                        setSelected(x.id);
                        viewer.current?.zoomTo(x);
                      }}
                      title={`${x.id}: ${Math.round(p * 100)} %`}
                    >
                      <b>{x.id}</b>
                      <small>{Math.round(p * 100)}%</small>
                    </button>
                  );
                })}
              </div>
              </div>
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
                  {api.sectionStats.get(sec.id) && <SectionLegend st={api.sectionStats.get(sec.id)!} api={api} />}
                  <div className="btn-row wrap">
                    <button
                      className="btn small"
                      disabled={locked}
                      title={locked ? t('w2ws.lockedComputing') : undefined}
                      data-testid="section-done"
                      onClick={() => {
                        if (apiComputing()) return;
                        setRangePlaced(c.layout, c.data, sec, true);
                        api.touchProgress();
                      }}
                    >
                      ✓ {t('plan.markDone')}
                    </button>
                    <button
                      className="btn small"
                      disabled={locked}
                      title={locked ? t('w2ws.lockedComputing') : undefined}
                      onClick={() => {
                        if (!confirm(t('plan.resetConfirm'))) return;
                        if (apiComputing()) return;
                        setRangePlaced(c.layout, c.data, sec, false);
                        api.touchProgress();
                      }}
                    >
                      {t('plan.reset')}
                    </button>
                    <button className="btn small" disabled={csvBusy} onClick={() => exportCsv([sec.id])}>
                      CSV {sec.id}
                    </button>
                  </div>
                </div>
              )}
              <div className="btn-row wrap" style={{ marginTop: 10 }}>
                <button className="btn small" disabled={csvBusy} onClick={() => exportCsv(null)} data-testid="csv-all">
                  {csvBusy ? t('common.loading') : t('plan.csvAll')}
                </button>
              </div>
            </>
          )}
          {tab === 'material' && <MaterialCalc api={api} />}
        </aside>
      </div>
      {pick && (
        <StoneDialog
          layout={c.layout}
          data={c.data}
          palette={rec.palette}
          materials={materials}
          sections={G}
          row={pick.row}
          col={pick.col}
          piece={pick.piece}
          minPieceMm={s.shapes.minPieceMm}
          readOnly={locked}
          onClose={() => setPick(null)}
          onNavigate={(row, col, piece) => setPick({ row, col, piece })}
          onChanged={api.touchMosaic}
          onProgress={api.touchProgress}
        />
      )}
    </div>
  );
}

function SectionLegend({ st, api }: { st: Stats; api: ProjectApi }) {
  const { t, n } = useI18n();
  return (
    <table className="data small">
      <thead>
        <tr>
          <th>{t('colors.code')}</th>
          <th />
          <th className="num">{t('colors.stones')}</th>
          <th className="num">{t('plan.placedShort')}</th>
        </tr>
      </thead>
      <tbody>
        {st.perColor
          .filter((c) => c.pieces > 0)
          .map((c) => (
            <tr key={c.color}>
              <td>{String(api.rec!.palette[c.color]?.code).padStart(2, '0')}</td>
              <td>
                <Swatch hex={api.rec!.palette[c.color]?.hex ?? '#000'} size={12} />
              </td>
              <td className="num">{n(c.pieces)}</td>
              <td className="num">{n(c.placed)}</td>
            </tr>
          ))}
        <tr>
          <th colSpan={2}>Σ</th>
          <th className="num">{n(st.pieces)}</th>
          <th className="num">{n(st.placed)}</th>
        </tr>
      </tbody>
    </table>
  );
}

/**
 * Einkaufsliste je Material aus stats.perMaterial: ein Material, das mehreren Farben zugeordnet ist,
 * wird einmal gezählt; „kaufen“ = Bedarf − erfasster Bestand (auch Bestand 0). Summe der Kosten = totalCost.
 */
function ShoppingList({ api, st }: { api: ProjectApi; st: Stats }) {
  const { t, n } = useI18n();
  const named = st.perMaterial.filter((m) => m.material);
  if (!named.length) return null;
  const pal = api.rec!.palette;
  const code = (i: number) => String(pal[i]?.code ?? '?').padStart(2, '0');
  return (
    <div className="w1fx-shop" data-testid="mc-shopping">
      <h4>{t('plan.shop.title')}</h4>
      <div className="table-wrap">
        <table className="data small w1fx-tight">
          <thead>
            <tr>
              <th>{t('plan.shop.material')}</th>
              <th className="num">{t('plan.shop.need')}</th>
              <th className="num">{t('plan.shop.toBuy')}</th>
              <th className="num">{t('plan.shop.packs')}</th>
              <th className="num">{t('plan.shop.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {st.perMaterial.map((ms) => {
              const m = ms.material;
              const name = m ? `${m.manufacturer} ${m.colorNumber || m.colorName}`.replace(/\s+/g, ' ').trim() || t(`mat.${m.type}`) : t('plan.shop.noMaterial');
              const short = ms.toBuy !== undefined && ms.toBuy > 0;
              return (
                <tr key={ms.materialId ?? '-'} data-testid="mc-shop-row" data-material={ms.materialId ?? ''}>
                  <td>
                    <span className="w1fx-matname" title={m ? `${m.manufacturer} ${m.product} ${m.colorNumber} ${m.colorName}` : undefined}>
                      {name}
                    </span>
                    <small className="muted">
                      {t('plan.shop.colors')}: {ms.colors.map(code).join(', ')}
                    </small>
                    {/* Bestand unter dem Namen, damit alle Zahlenspalten in die schmale Seitenleiste passen */}
                    {ms.stock !== undefined && (
                      <small className="muted" data-testid="mc-shop-stock">
                        {t('plan.shop.stock')}: {n(ms.stock)}
                      </small>
                    )}
                  </td>
                  <td className="num">{n(ms.need)}</td>
                  <td className={`num ${short ? 'error' : ''}`} data-testid="mc-shop-tobuy" title={short ? t('plan.stockShort') : undefined}>
                    {ms.toBuy !== undefined ? n(ms.toBuy) : '–'}
                  </td>
                  <td className="num">
                    {ms.packs !== undefined ? n(ms.packs) : '–'}
                    {ms.packsToBuy !== undefined && ms.packsToBuy !== ms.packs && <small className="muted">({n(ms.packsToBuy)})</small>}
                  </td>
                  <td className="num">{ms.cost !== undefined ? n(ms.cost, 2) : '–'}</td>
                </tr>
              );
            })}
            {st.totalCost > 0 && (
              <tr>
                <th colSpan={4}>{t('plan.shop.sum')}</th>
                <th className="num" data-testid="mc-shop-sum">
                  {n(st.totalCost, 2)}
                </th>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted small">{t('plan.shop.hint')}</p>
      {!st.costComplete && st.totalCost > 0 && <p className="muted small">{t('plan.shop.incomplete')}</p>}
    </div>
  );
}

export function MaterialCalc({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const st = api.stats;
  const s = api.rec!.settings;
  const reserves = [5, 10, 15, 20];
  if (!st) return <p className="muted">{t('common.loading')}</p>;
  return (
    <div data-testid="material-calc">
      <Field label={t('plan.reserve')}>
        <div className="btn-row wrap">
          {reserves.map((r) => (
            <button key={r} className={`btn chip ${s.reservePct === r ? 'primary' : ''}`} onClick={() => api.setSettings({ reservePct: r })}>
              {r} %
            </button>
          ))}
          <NumberInput value={s.reservePct} onChange={(v) => api.setSettings({ reservePct: v })} min={0} max={200} suffix="%" width={50} label={t('plan.reserve')} />
        </div>
      </Field>
      <table className="kv small">
        <tbody>
          <tr>
            <th>{t('plan.gridPositions')}</th>
            <td data-testid="mc-grid">{n(st.gridPositions)}</td>
          </tr>
          <tr>
            <th>{t('plan.stonesTotal')}</th>
            <td data-testid="mc-pieces">{n(st.pieces)}</td>
          </tr>
          <tr>
            <th>{t('plan.uncut')}</th>
            <td>{n(st.uncutPieces)}</td>
          </tr>
          <tr>
            <th>{t('plan.cut')}</th>
            <td>{n(st.cutPieces)}</td>
          </tr>
          <tr>
            <th>{t('plan.areaTotal')}</th>
            <td>{n(st.finishedArea / 1e6, 4)} m²</td>
          </tr>
          <tr>
            <th>{t('plan.areaStones')}</th>
            <td>
              {n(st.stoneArea / 1e6, 4)} m² ({n((st.stoneArea / st.finishedArea) * 100, 1)} %)
            </td>
          </tr>
          <tr>
            <th>{t('plan.areaJoints')}</th>
            <td>
              {n(st.jointArea / 1e6, 4)} m² ({n((st.jointArea / st.finishedArea) * 100, 1)} %)
            </td>
          </tr>
          <tr>
            <th>{t('plan.raw')}</th>
            <td>{n(st.rawTotal)}</td>
          </tr>
          <tr>
            <th>{t('plan.waste')}</th>
            <td>
              {n(st.wasteArea / 1e6, 4)} m² ({n(st.wastePct, 1)} %)
            </td>
          </tr>
          <tr>
            <th>{t('plan.withReserve')}</th>
            <td>
              <b>{n(st.rawWithReserveTotal)}</b>
            </td>
          </tr>
          <tr>
            <th>{t('plan.grout')}</th>
            <td>
              ≈ {n(st.groutKg, 2)} kg <small className="muted">({t('plan.estimate')})</small>
            </td>
          </tr>
          {st.totalCost > 0 && (
            <tr>
              <th>{t('plan.cost')}</th>
              <td>
                {n(st.totalCost, 2)} {!st.costComplete && <Badge kind="incomplete">{t('common.incomplete')}</Badge>}
              </td>
            </tr>
          )}
          {st.notFitting > 0 && (
            <tr>
              <th>{t('plan.notFitting')}</th>
              <td className="error">{n(st.notFitting)}</td>
            </tr>
          )}
          {st.invalidPieces > 0 && (
            <tr data-testid="mc-invalid">
              <th>{t('plan.invalidPieces')}</th>
              <td className="error">{n(st.invalidPieces)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="muted small">{t('plan.yieldHint')}</p>
      <details className="w1fx-how">
        <summary>{t('plan.yieldHow')}</summary>
        <p className="muted small">{t('plan.yieldDetails')}</p>
      </details>
      <h4>{t('plan.perColor')}</h4>
      {/* Nur Rohsteine je Farbe (addieren sich zur Gesamtzahl); Packungen, Bestand und Kosten je Material unten */}
      <div className="table-wrap">
        <table className="data small w1fx-tight" data-testid="mc-per-color">
          <thead>
            <tr>
              <th>{t('colors.code')}</th>
              <th className="num">{t('colors.stones')}</th>
              <th className="num">{t('plan.cutShort')}</th>
              <th className="num">{t('plan.raw')}</th>
              <th className="num">+{n(s.reservePct, 2)} %</th>
            </tr>
          </thead>
          <tbody>
            {st.perColor
              .filter((c) => c.pieces > 0)
              .map((c) => (
                <tr key={c.color}>
                  <td>
                    <span className="w1fx-code">
                      <Swatch hex={api.rec!.palette[c.color]?.hex ?? '#000'} size={12} />
                      {String(api.rec!.palette[c.color]?.code).padStart(2, '0')}
                    </span>
                  </td>
                  <td className="num">{n(c.pieces)}</td>
                  <td className="num">{n(c.cut)}</td>
                  <td className="num">{n(c.raw)}</td>
                  <td className="num">{n(c.rawWithReserve)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <ShoppingList api={api} st={st} />
      <h4>{t('plan.perShape')}</h4>
      <table className="data small">
        <tbody>
          {Object.entries(st.perShape)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => (
              <tr key={k}>
                <td>{t(`shape.${k}`)}</td>
                <td className="num">{n(v)}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <h4>{t('plan.perSize')}</h4>
      <div className="table-wrap" style={{ maxHeight: 220 }}>
        <table className="data small">
          <tbody>
            {st.perSize.slice(0, 200).map((z) => (
              <tr key={z.key}>
                <td>{t(`shape.${z.shape}`)}</td>
                <td>
                  {n(z.w, 1)} × {n(z.h, 1)} mm
                </td>
                <td className="num">{n(z.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
