import { jointAreaValid, type Stats } from '../../core/stats';
import { tCount, useI18n } from '../../i18n';
import { Badge, Field, NumberInput, Swatch } from '../components';
import type { ProjectApi } from './useProject';
import '../css/w1-review-fixes.css';
import '../css/w4-laying-workbench.css';

/**
 * Materialberechnung und Einkaufsliste (Schritt 9, Ansicht „Material & Einkauf“). Aus StepPlan.tsx
 * herausgelöst, Inhalt und Zahlen unverändert; die Ansicht nutzt jetzt die volle Breite (zwei Spalten
 * am Desktop: Kennzahlen links, Bedarf je Farbe und Einkaufsliste rechts).
 */

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
                    {/* Bestand unter dem Namen, damit alle Zahlenspalten auch in schmale Spalten passen */}
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
  // Flächen nur als Zahl, wenn sie der Geometrie entsprechen (sonst z. B. negative Fugenfläche durch überlappende
  // Freiformteile älterer/importierter Projekte)
  const areasOk = jointAreaValid(st);
  const areaInvalid = (
    <span className="warn" data-testid="area-invalid">
      {st.invalidFreeCells > 0 ? tCount(t, 'w3fx.area.invalid', st.invalidFreeCells, { n: n(st.invalidFreeCells) }) : t('w3fx.area.inconsistent')}
    </span>
  );
  return (
    <div data-testid="material-calc" className="w4lw-mc" data-busy={api.statsBusy ? 'yes' : 'no'}>
      <div className="w4lw-mc-a">
        {/* nach einer Änderung (Reserve, Palette, Steine …) zeigen die Zahlen bis zum neuen Durchlauf den alten Stand */}
        {api.statsBusy && (
          <p className="muted small" role="status" data-testid="mc-updating">
            {t('w4fx.stats.updating')}
          </p>
        )}
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
              <td data-testid="mc-area-stones">
                {areasOk ? (
                  <>
                    {n(st.stoneArea / 1e6, 4)} m² ({n((st.stoneArea / st.finishedArea) * 100, 1)} %)
                  </>
                ) : (
                  areaInvalid
                )}
              </td>
            </tr>
            <tr>
              <th>{t('plan.areaJoints')}</th>
              <td data-testid="mc-area-joints">
                {areasOk ? (
                  <>
                    {n(st.jointArea / 1e6, 4)} m² ({n((st.jointArea / st.finishedArea) * 100, 1)} %)
                  </>
                ) : (
                  areaInvalid
                )}
              </td>
            </tr>
            <tr>
              <th>{t('plan.raw')}</th>
              <td>{n(st.rawTotal)}</td>
            </tr>
            <tr>
              <th>{t('plan.waste')}</th>
              <td>
                {areasOk ? (
                  <>
                    {n(st.wasteArea / 1e6, 4)} m² ({n(st.wastePct, 1)} %)
                  </>
                ) : (
                  areaInvalid
                )}
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
              <td data-testid="mc-grout">
                {areasOk ? (
                  <>
                    ≈ {n(st.groutKg, 2)} kg <small className="muted">({t('plan.estimate')})</small>
                  </>
                ) : (
                  areaInvalid
                )}
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
      </div>
      <div className="w4lw-mc-b">
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
      </div>
      <div className="w4lw-mc-c">
        <div className="w4lw-mc-pair">
          <div>
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
          </div>
          <div>
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
        </div>
      </div>
    </div>
  );
}
