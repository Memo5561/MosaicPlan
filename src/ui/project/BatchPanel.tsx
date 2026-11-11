/**
 * Bereich bearbeiten (Paket w6-compare-batch): Farbe A → B, Heller/Dunkler und „Form zurücksetzen“ für ein im Mosaik
 * aufgezogenes Rechteck, einen Abschnitt oder das ganze Mosaik.
 *
 *  - Jede Aktion zeigt vorher, was sie tun wird (Probelauf mit exakter Steinzahl, Zuordnung der Farben) und ist EIN
 *    Verlaufseintrag (api.editCells): Strg+Z bzw. ↶ macht sie als Ganzes rückgängig.
 *  - Heller/Dunkler nimmt nur vorhandene Palettenfarben gleichen Farbtons; Steine ohne passende Farbe bleiben
 *    unverändert und werden gezählt. Große Sprünge (ΔE über SHADE_BIG_JUMP_DE) sind gekennzeichnet, jede Zeile lässt
 *    sich abwählen; der Probelauf zählt nur die angehakten Zeilen (Paket w6-fix-ui).
 *  - Form zurücksetzen: Farbe nach der Fotofarbe der Zelle (nächste Palettenfarbe), sonst nach der größten Farbfläche.
 *  - Nach dem Anwenden zeigt „Im Mosaik ansehen“ den geänderten Bereich.
 *  - Stückzahlen und Statistik ändern sich nur über die normale Neuberechnung nach der Bearbeitung.
 */
import { useEffect, useMemo, useState } from 'react';
import type { DeltaEFormula } from '../../core/color';
import { paletteDisplayName } from '../../core/colorNames';
import { applyColorMap, applyReplace, applyShapeReset, colorCensus, fitsJournal, planReplace, planShade, planShapeReset, rangeCells, SHADE_BIG_JUMP_DE } from '../../core/batch';
import { cellId, type Layout, type SectionGrid } from '../../core/layout';
import type { Range } from '../../core/stats';
import type { MosaicData, PaletteColor } from '../../core/types';
import { useI18n } from '../../i18n';
import { Badge, Segmented, Swatch } from '../components';
import type { HistoryLabel } from '../../core/journal';
import { deText } from '../deWords';
import { deviceKey } from './deviceKind';
import type { ProjectApi } from './useProject';
import '../css/w6-compare-batch.css';
import '../css/w6-fix-ui.css';

export type BatchScope = 'rect' | 'section' | 'all';
export type BatchAction = 'replace' | 'shade' | 'shape';

const code2 = (p: PaletteColor | undefined) => (p ? String(p.code).padStart(2, '0') : '?');

/** Bezeichnung eines Zellbereichs „B003–F012“ */
export function rangeLabel(layout: Pick<Layout, 'cols'>, rg: Range): string {
  return `${cellId(layout, rg.r0, rg.c0)}–${cellId(layout, rg.r1 - 1, rg.c1 - 1)}`;
}

export interface BatchPanelProps {
  api: ProjectApi;
  layout: Layout;
  data: MosaicData;
  palette: PaletteColor[];
  formula: DeltaEFormula;
  minPieceMm: number;
  readOnly: boolean;
  sections: SectionGrid | null;
  scope: BatchScope;
  setScope: (s: BatchScope) => void;
  selection: Range | null;
  setSelection: (r: Range | null) => void;
  rectMode: boolean;
  setRectMode: (on: boolean) => void;
  sectionId: string | null;
  setSectionId: (id: string | null) => void;
  /** Finger statt Maus (Hinweise ohne Strg+Z bzw. Leertaste) */
  coarse: boolean;
  /**
   * Geänderten Bereich im Viewer hervorheben ('all' = ganzes Mosaik); `go`: außerdem dorthin zoomen und das Mosaik ins
   * Bild holen („Im Mosaik ansehen“).
   */
  onShow: (where: Range | 'all', go: boolean) => void;
}

interface Done {
  text: string;
  count: number;
  /** geänderter Bereich (für „Im Mosaik ansehen“) */
  where: Range | 'all';
}

export function BatchPanel(p: BatchPanelProps) {
  const { t, n, lang } = useI18n();
  const { api, layout, data, palette, formula } = p;
  const version = api.version;
  const [action, setAction] = useState<BatchAction>('replace');
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [dir, setDir] = useState<'lighter' | 'darker'>('lighter');
  const [laidOk, setLaidOk] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  /** Heller/Dunkler: abgewählte Ausgangsfarben (Palettenindex) – bleiben unverändert */
  const [skip, setSkip] = useState<ReadonlySet<number>>(() => new Set());

  const section = p.scope === 'section' && p.sections ? (p.sections.sections.find((s) => s.id === p.sectionId) ?? null) : null;
  /** Wirkungsbereich: null = nichts gewählt; 'all' = ganzes Mosaik */
  const range: Range | 'all' | null = p.scope === 'all' ? 'all' : p.scope === 'section' ? (section ? { r0: section.r0, r1: section.r1, c0: section.c0, c1: section.c1 } : null) : p.selection;
  const rg = range === 'all' ? null : range;
  const rangeKey = range === 'all' ? 'all' : range ? `${range.r0},${range.r1},${range.c0},${range.c1}` : '';
  /** Ortsangabe im Verlauf: Bereich „B003–F012“, Abschnitt „A2“ oder „ganzes Mosaik“ */
  const where = range === 'all' ? 't:w6cb.where.all' : section ? section.id : rg ? rangeLabel(layout, rg) : '';
  const whereSec = !!section;

  // neuer Bereich oder neue Aktion: alte Meldung und Bestätigung verwerfen
  useEffect(() => {
    setDone(null);
    setLaidOk(false);
    setSkip(new Set());
  }, [rangeKey, action, dir]);

  const census = useMemo(() => (range ? colorCensus(data, palette.length, rg) : null), [rangeKey, data, palette, version]); // eslint-disable-line react-hooks/exhaustive-deps
  // Farben im Bereich – dazu die gewählte Ausgangsfarbe, auch wenn sie (nach dem Anwenden) nicht mehr vorkommt
  const present = useMemo(() => (census ? palette.map((_, i) => i).filter((i) => census.perColor[i] > 0 || i === from) : []), [census, palette, from]);
  // Ausgangsfarbe: die gewählte, solange sie im Bereich vorkommt, sonst die häufigste
  // ohne Wahl die häufigste Farbe im Bereich; eine gewählte Farbe bleibt (nie still eine andere Farbe vorschlagen)
  const fromEff = from !== null && from < palette.length ? from : present.length ? present.reduce((a, b) => (census!.perColor[b] > census!.perColor[a] ? b : a), present[0]) : null;
  const toEff = to !== null && to < palette.length && to !== fromEff ? to : palette.findIndex((_, i) => i !== fromEff);

  const replacePlan = useMemo(
    () => (action === 'replace' && range && fromEff !== null && toEff >= 0 ? planReplace(data, rg, fromEff, toEff) : null),
    [action, rangeKey, fromEff, toEff, data, version], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const shadePlan = useMemo(() => (action === 'shade' && range ? planShade(palette, data, rg, dir, formula, skip) : null), [action, rangeKey, dir, data, palette, formula, version, skip]); // eslint-disable-line react-hooks/exhaustive-deps
  const shapePlan = useMemo(() => (action === 'shape' && range ? planShapeReset(layout, data, palette, formula, rg) : null), [action, rangeKey, layout, data, palette, formula, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleSkip = (c: number, use: boolean) =>
    setSkip((cur) => {
      const next = new Set(cur);
      if (use) next.delete(c);
      else next.add(c);
      return next;
    });

  const cells = action === 'replace' ? replacePlan?.cells : action === 'shade' ? shadePlan?.cells : shapePlan?.cells;
  const fits = cells ? fitsJournal(data, cells) : true;

  const label = (key: string, params: Record<string, string | number>): HistoryLabel => ({
    key: whereSec ? `${key}.sec` : key,
    params: { ...params, where },
  });

  const run = () => {
    if (p.readOnly || !cells || !cells.length) return;
    let count = 0;
    let text = '';
    if (action === 'replace' && replacePlan && fromEff !== null) {
      const f = fromEff;
      const tt = toEff;
      const r = api.editCells(
        cells,
        () => (count = applyReplace(data, cells, f, tt)),
        label('w6cb.h.replace', {
          n: replacePlan.pieces,
          from: code2(palette[f]),
          to: code2(palette[tt]),
        }),
        firstFlash(cells),
      );
      if (!r) return;
      // Auswahl festhalten: nach dem Anwenden zeigt der Probelauf dieselben Farben (dann 0 Steine)
      setFrom(f);
      setTo(tt);
      text = t('w6cb.done.replace', {
        n: n(count),
        from: code2(palette[f]),
        to: code2(palette[tt]),
      });
    } else if (action === 'shade' && shadePlan) {
      const map = shadePlan.map;
      api.editCells(
        cells,
        () => (count = applyColorMap(data, cells, map)),
        label(dir === 'lighter' ? 'w6cb.h.lighter' : 'w6cb.h.darker', {
          n: shadePlan.matched,
        }),
        firstFlash(cells),
      );
      text = t(dir === 'lighter' ? 'w6cb.done.lighter' : 'w6cb.done.darker', {
        n: n(count),
        kept: n(shadePlan.unmatched),
      });
    } else if (action === 'shape' && shapePlan) {
      if (shapePlan.laid > 0 && !laidOk) return;
      const colors = shapePlan.colors;
      api.editCells(cells, () => (count = applyShapeReset(layout, data, cells, p.minPieceMm, colors)), label('w6cb.h.shape', { n: shapePlan.cells.length }), firstFlash(cells));
      text = t('w6cb.done.shape', { n: n(count) });
    }
    const at: Range | 'all' = range === 'all' ? 'all' : rg!;
    setDone({ text, count, where: at });
    if (count > 0) p.onShow(at, false);
    setLaidOk(false);
  };

  const sectionOptions = p.sections?.sections ?? [];
  const selCount = p.selection ? rangeCells(p.selection) : 0;

  return (
    <div className="w6cb-panel" data-testid="batch-panel">
      {/* Wirkungsbereich */}
      <div className="w6cb-row">
        <span className="w6cb-lbl">{t('w6cb.scope')}</span>
        <Segmented<BatchScope>
          value={p.scope}
          onChange={(s) => {
            p.setScope(s);
            if (s !== 'rect') p.setRectMode(false);
          }}
          options={[
            { value: 'rect', label: t('w6cb.scope.rect') },
            { value: 'section', label: t('w6cb.scope.section') },
            { value: 'all', label: t('w6cb.scope.all') },
          ]}
          testId="batch-scope"
        />
      </div>
      {p.scope === 'rect' && (
        <div className="w6cb-row w6cb-wrap">
          <button type="button" className={`btn small ${p.rectMode ? 'primary' : ''}`} aria-pressed={p.rectMode} onClick={() => p.setRectMode(!p.rectMode)} data-testid="batch-rect-mode">
            {p.rectMode ? t('w6cb.rectModeOn') : p.selection ? t('w6cb.rectModeAgain') : t('w6cb.rectMode')}
          </button>
          {p.selection ? (
            <span className="small" data-testid="batch-selection" data-range={`${p.selection.r0},${p.selection.r1},${p.selection.c0},${p.selection.c1}`}>
              <b>{rangeLabel(layout, p.selection)}</b> ·{' '}
              {t('w6cb.selCells', {
                rows: n(p.selection.r1 - p.selection.r0),
                cols: n(p.selection.c1 - p.selection.c0),
                cells: n(selCount),
              })}
              {census && (
                <>
                  {' '}
                  ·{' '}
                  {t(census.pieces === 1 ? 'w3vf.stones.one' : 'w3vf.stones', {
                    n: n(census.pieces),
                  })}
                </>
              )}{' '}
              <button type="button" className="btn small" onClick={() => p.setSelection(null)} data-testid="batch-clear">
                {t('w6cb.clearSel')}
              </button>
            </span>
          ) : (
            <span className="muted small">{t('w6cb.noSel')}</span>
          )}
          {p.rectMode && <small className="muted block w6cb-full">{t(deviceKey('w6fx.rectHint', p.coarse))}</small>}
        </div>
      )}
      {p.scope === 'section' && (
        <div className="w6cb-row">
          {sectionOptions.length ? (
            <label className="w6cb-row">
              <span className="w6cb-lbl">{t('w6cb.section')}</span>
              <select value={section?.id ?? ''} onChange={(e) => p.setSectionId(e.target.value || null)} data-testid="batch-section">
                <option value="">{t('w6cb.sectionPick')}</option>
                {sectionOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id}
                  </option>
                ))}
              </select>
              {census && (
                <span className="small muted">
                  {t(census.pieces === 1 ? 'w3vf.stones.one' : 'w3vf.stones', {
                    n: n(census.pieces),
                  })}
                </span>
              )}
            </label>
          ) : (
            <span className="muted small">{t('w6cb.noSections')}</span>
          )}
        </div>
      )}
      {p.scope === 'all' && census && (
        <p className="small muted">
          {t('w6cb.allInfo', { cells: n(census.cells) })} ·{' '}
          {t(census.pieces === 1 ? 'w3vf.stones.one' : 'w3vf.stones', {
            n: n(census.pieces),
          })}
        </p>
      )}

      {/* Aktion */}
      <div className="w6cb-row">
        <span className="w6cb-lbl">{t('w6cb.action')}</span>
        <Segmented<BatchAction>
          value={action}
          onChange={setAction}
          options={[
            { value: 'replace', label: t('w6cb.act.replace') },
            { value: 'shade', label: t('w6cb.act.shade') },
            { value: 'shape', label: t('w6cb.act.shape') },
          ]}
          testId="batch-action"
        />
      </div>

      {!range ? (
        <p className="muted small" data-testid="batch-noscope">
          {p.scope === 'section' ? t('w6cb.needSection') : t('w6cb.needSel')}
        </p>
      ) : (
        <>
          {action === 'replace' && (
            <div className="w6cb-grid">
              <label className="w6cb-row">
                <span className="w6cb-lbl">{t('w6cb.from')}</span>
                {fromEff !== null && <Swatch hex={palette[fromEff].hex} />}
                <select value={fromEff ?? ''} onChange={(e) => setFrom(Number(e.target.value))} data-testid="batch-from" disabled={!present.length}>
                  {present.map((i) => (
                    <option key={i} value={i}>
                      {code2(palette[i])} {paletteDisplayName(palette[i], lang)} ({n(census!.perColor[i])})
                    </option>
                  ))}
                </select>
              </label>
              <label className="w6cb-row">
                <span className="w6cb-lbl">{t('w6cb.to')}</span>
                {toEff >= 0 && <Swatch hex={palette[toEff].hex} />}
                <select value={toEff} onChange={(e) => setTo(Number(e.target.value))} data-testid="batch-to">
                  {palette.map((c, i) =>
                    i === fromEff ? null : (
                      <option key={i} value={i}>
                        {code2(c)} {paletteDisplayName(c, lang)}
                      </option>
                    ),
                  )}
                </select>
              </label>
              {replacePlan && fromEff !== null && (
                <p className="small w6cb-dry" data-testid="batch-dryrun" data-count={replacePlan.pieces}>
                  {t(replacePlan.pieces === 0 ? 'w6cb.dry.replace.none' : replacePlan.pieces === 1 ? 'w6cb.dry.replace.one' : 'w6cb.dry.replace', {
                    n: n(replacePlan.pieces),
                    from: code2(palette[fromEff]),
                    to: code2(palette[toEff]),
                  })}
                </p>
              )}
            </div>
          )}

          {action === 'shade' && shadePlan && (
            <div className="w6cb-grid">
              <Segmented<'lighter' | 'darker'>
                value={dir}
                onChange={setDir}
                options={[
                  { value: 'lighter', label: t('w6cb.lighter') },
                  { value: 'darker', label: t('w6cb.darker') },
                ]}
                testId="batch-dir"
              />
              <small className="muted block">{t('w6cb.shadeRule')}</small>
              <table className="w6cb-map" data-testid="batch-map">
                <tbody>
                  {shadePlan.rows.map((r) => (
                    <tr
                      key={r.from}
                      className={`${r.big ? 'w6fx-big' : ''} ${r.skipped ? 'w6fx-skipped' : ''}`}
                      data-from={palette[r.from].code}
                      data-to={r.to ? palette[r.to.index].code : ''}
                      data-big={r.big ? '1' : '0'}
                      data-skipped={r.skipped ? '1' : '0'}
                    >
                      <td className="w6fx-use">
                        {r.to && (
                          <input
                            type="checkbox"
                            checked={!r.skipped}
                            onChange={(e) => toggleSkip(r.from, e.target.checked)}
                            aria-label={t('w6fx.shade.use', { code: code2(palette[r.from]) })}
                            data-testid="batch-shade-use"
                          />
                        )}
                      </td>
                      <td>
                        <Swatch hex={palette[r.from].hex} size={14} /> {code2(palette[r.from])}
                      </td>
                      <td aria-hidden="true">→</td>
                      <td>
                        {r.to ? (
                          <>
                            <Swatch hex={palette[r.to.index].hex} size={14} /> {code2(palette[r.to.index])}{' '}
                            <span className="muted">
                              {t(dir === 'lighter' ? 'w6fx.shade.lighter' : 'w6fx.shade.darker', {
                                dl: n(Math.abs(r.to.dL), 1),
                                de: deText(t, n, r.to.dE),
                              })}
                            </span>
                            {r.big && (
                              <span className="w6fx-big-badge" data-testid="batch-shade-big">
                                <Badge kind="warn">{t('w6fx.shade.big')}</Badge>
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="muted">{t(dir === 'lighter' ? 'w6cb.noLighter' : 'w6cb.noDarker')}</span>
                        )}
                      </td>
                      <td className="num">{n(r.pieces)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <small className="muted block">{t('w6fx.shade.scale')}</small>
              {shadePlan.rows.some((r) => r.big) && <small className="block w6fx-big-hint">{t('w6fx.shade.bigHint', { max: n(SHADE_BIG_JUMP_DE) })}</small>}
              <p className="small w6cb-dry" data-testid="batch-dryrun" data-count={shadePlan.matched} data-kept={shadePlan.unmatched} data-skipped={shadePlan.skipped}>
                {t('w6cb.dry.shade', {
                  n: n(shadePlan.matched),
                  kept: n(shadePlan.unmatched),
                })}
                {shadePlan.skipped > 0 && <> {t('w6fx.dry.shadeSkipped', { n: n(shadePlan.skipped) })}</>}
              </p>
              {shadePlan.unmatched > 0 && <small className="muted block">{t('w6cb.shadeAdd')}</small>}
            </div>
          )}

          {action === 'shape' && shapePlan && (
            <div className="w6cb-grid">
              <p className="small w6cb-dry" data-testid="batch-dryrun" data-count={shapePlan.cells.length} data-laid={shapePlan.laid}>
                {shapePlan.cells.length
                  ? t('w6cb.dry.shape', {
                      cells: n(shapePlan.cells.length),
                      before: n(shapePlan.piecesBefore),
                    })
                  : t('w6cb.dry.shapeNone')}
                {shapePlan.freeCells > 0 && <> {t('w6cb.dry.shapeFree', { n: n(shapePlan.freeCells) })}</>}
              </p>
              {shapePlan.cells.length > 0 && (
                <ul className="small w6fx-shape-rule" data-testid="batch-shape-rule" data-photo={shapePlan.photoCells} data-area={shapePlan.areaCells}>
                  {shapePlan.photoCells > 0 && <li>{t('w6fx.dry.shapePhoto', { n: n(shapePlan.photoCells) })}</li>}
                  {shapePlan.areaCells > 0 && <li>{t('w6fx.dry.shapeArea', { n: n(shapePlan.areaCells) })}</li>}
                </ul>
              )}
              {shapePlan.laid > 0 && (
                <div className="w6cb-warn" role="alert" data-testid="batch-laid-warn">
                  <Badge kind="warn">{t('w6cb.laidTitle')}</Badge> {t('w6cb.laidWarn', { n: n(shapePlan.laid) })}
                  <label className="w6cb-row">
                    <input type="checkbox" checked={laidOk} onChange={(e) => setLaidOk(e.target.checked)} data-testid="batch-laid-ok" />
                    <span>{t('w6cb.laidOk')}</span>
                  </label>
                </div>
              )}
            </div>
          )}

          {!fits && (
            <p className="small warn" data-testid="batch-too-large">
              {t('w6cb.tooLarge')}
            </p>
          )}
          <div className="w6cb-row w6cb-wrap">
            <button
              type="button"
              className="btn primary small"
              disabled={p.readOnly || !cells || !cells.length || (action === 'shape' && !!shapePlan && shapePlan.laid > 0 && !laidOk)}
              onClick={run}
              data-testid="batch-apply"
            >
              {t('w6cb.apply')}
            </button>
            {p.readOnly && <small className="muted">{t('w6cb.locked')}</small>}
          </div>
        </>
      )}
      {done && (
        <div className="small ok w6fx-done" role="status" data-testid="batch-status" data-count={done.count}>
          <span>
            {done.text} {t(deviceKey('w6fx.undoHint', p.coarse))}
          </span>
          {done.count > 0 && (
            <button type="button" className="btn small" onClick={() => p.onShow(done.where, true)} data-testid="batch-show">
              {t('w6fx.done.show')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Erster geänderter Stein (für das kurze Aufleuchten nach Rückgängig/Wiederholen) */
function firstFlash(cells: Uint32Array) {
  return cells.length ? { idx: cells[0], piece: 0 } : undefined;
}
