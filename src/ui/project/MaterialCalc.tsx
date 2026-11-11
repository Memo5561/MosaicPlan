import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { paletteDisplayName } from '../../core/colorNames';
import { buildShoppingCsv, formatMoney, SHOPPING_FILE_SUFFIX, shoppingRows, shoppingTotals, type ShoppingRow } from '../../core/shoppingCsv';
import { jointAreaValid, type Stats } from '../../core/stats';
import type { Material, PaletteColor } from '../../core/types';
import { tCount, useI18n, type TFunc } from '../../i18n';
import { isNative } from '../../platform';
import { Badge, downloadBlob, NumberInput, safeFileName, SaveResultNote, Swatch, type SaveResult } from '../components';
import { useMedia } from './deviceKind';
import { stepHash } from './stepNav';
import type { ProjectApi } from './useProject';
import '../css/w1-review-fixes.css';
import '../css/w5-material-shopping.css';
import '../css/w5-fix-ui.css';

/**
 * Schritt 9, Ansicht „Material & Einkauf“ (volle Breite, ohne Viewer):
 *  - Kennzahlen: Steine gesamt, Rohsteine inkl. Reserve (sichere Obergrenze), Materialkosten (2 Nachkommastellen,
 *    „unvollständig“), Fugenmasse (Schätzung) und die Reserve;
 *  - Hinweise: Fehlbestand je Material, fehlende/nicht zugeordnete Materialien, nicht erfasster Bestand;
 *  - Einkaufsliste je Material (stats.perMaterial; ein Material für mehrere Farben = eine Zeile) mit Bedarf und
 *    Einkauf (Bedarf − Bestand), Packungen nur mit Stückzahl je Packung, Kosten nur mit Preis – nie geschätzt;
 *  - Bedarf je Farbe (Name, Material, Steine, davon geschnitten, Rohsteine, inkl. Reserve);
 *  - Berechnung im Detail, Anzahl je Form und je Größe;
 *  - „Einkaufsliste als CSV“ und „Drucken“ (Druck zeigt nur diese Ansicht, siehe w5-material-shopping.css).
 * Bis 600 px Breite werden die Tabellen als Karten dargestellt (gleiches Markup, Beschriftung aus data-label).
 */

const code2 = (pal: readonly PaletteColor[], i: number) => String(pal[i]?.code ?? '?').padStart(2, '0');

function materialName(t: TFunc, m: Material): string {
  return `${m.manufacturer} ${m.product}`.replace(/\s+/g, ' ').trim() || t(`mat.${m.type}`);
}

/** Farbnummern mit kleinem Farbfeld; Textinhalt bleibt „01, 02, 05“ */
function ColorCodes({ pal, colors }: { pal: readonly PaletteColor[]; colors: number[] }) {
  return (
    <span className="w5ms-codes">
      {colors.map((c, k) => (
        <Fragment key={c}>
          {k > 0 && ', '}
          <span className="w5ms-code">
            <Swatch hex={pal[c]?.hex ?? '#000'} size={10} title={pal[c]?.hex} />
            {code2(pal, c)}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** Handy-Breite: wie die Kartenansicht in w5-material-shopping.css */
export const PHONE_QUERY = '(max-width: 600px)';

/**
 * Abschnitt, der sich auf dem Handy zuklappen lässt (Bedarf je Farbe, Berechnung im Detail): dort anfangs zu,
 * damit die Seite nicht zehntausende Pixel lang wird; auf breiten Bildschirmen ein normaler Abschnitt.
 * Beim Drucken öffnet MaterialCalc alle <details> (beforeprint) und zeigt die Überschrift (CSS).
 */
function Fold(props: { phone: boolean; title: ReactNode; className?: string; testId?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const cls = `w5ms-section ${props.className ?? ''}`;
  if (!props.phone)
    return (
      <section className={cls} data-testid={props.testId}>
        <h3 className="w5ms-h">{props.title}</h3>
        {props.children}
      </section>
    );
  return (
    <details className={`${cls} w5fu-fold`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)} data-testid={props.testId}>
      <summary className="w5fu-fold-sum">
        <h3 className="w5ms-h">{props.title}</h3>
      </summary>
      {props.children}
    </details>
  );
}

/** Kennzahl im Kopf */
function Stat(props: { label: ReactNode; value: ReactNode; sub?: ReactNode; testId?: string }) {
  return (
    <div className="w5ms-stat">
      <span className="w5ms-stat-label">{props.label}</span>
      <b className="w5ms-stat-value" data-testid={props.testId}>
        {props.value}
      </b>
      {props.sub && <span className="w5ms-stat-sub">{props.sub}</span>}
    </div>
  );
}

function ShoppingTable({ rows, st, pal }: { rows: ShoppingRow[]; st: Stats; pal: readonly PaletteColor[] }) {
  const { t, n, lang } = useI18n();
  const tot = useMemo(() => shoppingTotals(st, rows), [st, rows]);
  const money = (v: number | undefined) => (v === undefined ? '–' : formatMoney(v, lang));
  const anyCost = rows.some((r) => r.cost !== undefined);
  const anyGrid = rows.some((r) => r.rawAssumedGrid);
  const dash = (title: string) => (
    <span className="muted" title={title}>
      –
    </span>
  );
  return (
    <section className="w5ms-section" data-testid="mc-shopping">
      <h3 className="w5ms-h">{t('w5ms.shop.title')}</h3>
      <div className="table-wrap">
        <table className="data small w5ms-table w5ms-cards w5ms-shop" data-testid="mc-shop-table">
          <thead>
            <tr>
              <th rowSpan={2}>{t('w5ms.shop.material')}</th>
              <th rowSpan={2}>{t('w5ms.shop.colorNo')}</th>
              <th rowSpan={2}>{t('w5ms.shop.colors')}</th>
              <th rowSpan={2}>{t('w5ms.shop.rawSize')}</th>
              <th rowSpan={2} className="num">
                {t('w5ms.shop.price')}
              </th>
              <th colSpan={3} className="w5ms-group">
                {t('w5ms.shop.groupNeed')}
              </th>
              <th colSpan={4} className="w5ms-group w5ms-group-buy">
                {t('w5ms.shop.groupBuy')}
              </th>
            </tr>
            <tr>
              <th className="num">{t('w5ms.shop.need')}</th>
              <th className="num">{t('w5ms.shop.packs')}</th>
              <th className="num">{t('w5ms.shop.cost')}</th>
              <th className="num w5ms-buy-start">{t('w5ms.shop.stock')}</th>
              <th className="num">{t('w5ms.shop.toBuy')}</th>
              <th className="num">{t('w5ms.shop.packsToBuy')}</th>
              <th className="num">{t('w5ms.shop.buyCost')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const m = r.material;
              const missingOnly = r.materialId === null && r.unlinkedColors.length === 0;
              return (
                <tr key={r.materialId ?? '-'} data-testid="mc-shop-row" data-material={r.materialId ?? ''} className={r.materialId === null ? 'w5ms-none' : undefined}>
                  <td className="w5ms-c-mat" data-col="material">
                    {m ? (
                      <span className="w5ms-mat">
                        <Swatch hex={m.hex || '#000'} size={14} />
                        <span>
                          <b>{materialName(t, m)}</b>
                          <small className="muted w5ms-type">{t(`mat.${m.type}`)}</small>
                        </span>
                      </span>
                    ) : (
                      <span className="w5ms-mat">
                        <span className="w5ms-nomat-sw" aria-hidden="true" />
                        <span>
                          <b>{t('w5ms.shop.noMaterialGroup')}</b>
                          {r.missingColors.length > 0 && (
                            <span className="badge badge-warn w5ms-badge" title={t('w2ch.materialMissingTitle')}>
                              {t('w2ch.materialMissing')}
                            </span>
                          )}
                          {!missingOnly && <small className="muted w5ms-type">{t('w5ms.shop.noMaterial')}</small>}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="w5ms-c-no" data-col="colorNo" data-label={t('w5ms.shop.colorNo')}>
                    {m?.colorNumber ? <span className="mono">{m.colorNumber}</span> : <span className="muted">–</span>}
                    {m?.colorName && <small className="muted w5ms-sub">{m.colorName}</small>}
                  </td>
                  <td className="w5ms-c-colors" data-col="colors" data-label={t('w5ms.shop.colors')}>
                    <ColorCodes pal={pal} colors={r.colors} />
                  </td>
                  <td className="w5ms-c-raw" data-col="rawSize" data-label={t('w5ms.shop.rawSize')}>
                    <span className="w5ms-nowrap">
                      {n(r.rawW, 1)} × {n(r.rawH, 1)} mm{r.rawAssumedGrid && <span title={t('w5ms.shop.gridAssumed')}> *</span>}
                    </span>
                  </td>
                  <th className="w5ms-cardgroup" aria-hidden="true">
                    {t('w5ms.shop.groupNeed')}
                  </th>
                  <td className="num w5ms-c-price" data-col="price" data-label={t('w5ms.shop.price')}>
                    {r.price !== undefined ? money(r.price) : m ? dash(t('w5ms.shop.noPriceTitle')) : '–'}
                  </td>
                  <td className="num w5ms-c-need" data-col="need" data-label={t('w5ms.shop.need')}>
                    <b>{n(r.need)}</b>
                  </td>
                  <td className="num w5ms-c-packs" data-col="packs" data-label={t('w5ms.shop.packs')}>
                    {r.packs !== undefined ? (
                      <>
                        <span data-testid="mc-shop-packs">{n(r.packs)}</span> <small className="muted">{t('w5ms.shop.perPack', { n: n(r.piecesPerPack ?? 0) })}</small>
                        {r.packageSize && <small className="muted w5ms-sub">{r.packageSize}</small>}
                      </>
                    ) : m ? (
                      dash(t('w5ms.shop.noPackTitle'))
                    ) : (
                      '–'
                    )}
                  </td>
                  <td className="num w5ms-c-cost" data-col="cost" data-label={t('w5ms.shop.cost')}>
                    {r.cost !== undefined ? money(r.cost) : m ? dash(t(r.packs === undefined ? 'w5ms.shop.noPackTitle' : 'w5ms.shop.noPriceTitle')) : '–'}
                  </td>
                  <th className="w5ms-cardgroup" aria-hidden="true">
                    {t('w5ms.shop.groupBuy')}
                  </th>
                  <td className="num w5ms-buy-start w5ms-c-stock" data-col="stock" data-label={t('w5ms.shop.stock')}>
                    {r.stock !== undefined ? (
                      <span data-testid="mc-shop-stock">{n(r.stock)}</span>
                    ) : m ? (
                      <span className="muted" title={t('w5ms.shop.noStockTitle')}>
                        {t('w5ms.shop.stockUnknown')}
                      </span>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td className={`num w5ms-c-tobuy ${r.short ? 'error' : ''}`} data-col="toBuy" data-label={t('w5ms.shop.toBuy')} data-testid="mc-shop-tobuy" title={r.short ? t('plan.stockShort') : undefined}>
                    {r.toBuy !== undefined ? r.short ? <b>{n(r.toBuy)}</b> : n(r.toBuy) : '–'}
                  </td>
                  <td className="num w5ms-c-packsbuy" data-col="packsToBuy" data-label={t('w5ms.shop.packsToBuy')}>
                    {r.packsToBuy !== undefined ? (
                      <>
                        <b data-testid="mc-shop-packs-buy">{n(r.packsToBuy)}</b> <small className="muted">{t('w5ms.shop.perPack', { n: n(r.piecesPerPack ?? 0) })}</small>
                      </>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td className="num w5ms-c-buycost" data-col="buyCost" data-label={t('w5ms.shop.buyCost')}>
                    {money(r.buyCost)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="w5ms-sum" data-testid="mc-shop-sumrow">
              <th colSpan={5} className="w5ms-c-mat">
                {t('w5ms.shop.sum')}
              </th>
              <th className="w5ms-cardgroup" aria-hidden="true">
                {t('w5ms.shop.groupNeed')}
              </th>
              <td className="num w5ms-c-need" data-col="need" data-label={t('w5ms.shop.need')} data-testid="mc-shop-need-sum">
                <b>{n(tot.need)}</b>
              </td>
              <td className="num w5ms-c-packs w5ms-empty" data-col="packs" />
              <td className="num w5ms-c-cost" data-col="cost" data-label={t('w5ms.shop.cost')}>
                <b data-testid="mc-shop-sum">{anyCost ? money(tot.cost) : '–'}</b>
                {anyCost && !tot.costComplete && (
                  <>
                    {' '}
                    <Badge kind="incomplete">{t('common.incomplete')}</Badge>
                  </>
                )}
              </td>
              <th className="w5ms-cardgroup" aria-hidden="true">
                {t('w5ms.shop.groupBuy')}
              </th>
              <td className="num w5ms-buy-start w5ms-c-stock w5ms-empty" data-col="stock" />
              <td className="num w5ms-c-tobuy" data-col="toBuy" data-label={t('w5ms.shop.toBuy')} data-testid="mc-shop-tobuy-sum">
                {tot.stockRecorded > 0 ? (
                  <>
                    <b>{n(tot.toBuy)}</b>
                    {!tot.toBuyComplete && (
                      <>
                        {' '}
                        <Badge kind="incomplete">{t('common.incomplete')}</Badge>
                      </>
                    )}
                  </>
                ) : (
                  '–'
                )}
              </td>
              <td className="num w5ms-c-packsbuy w5ms-empty" data-col="packsToBuy" />
              <td className="num w5ms-c-buycost" data-col="buyCost" data-label={t('w5ms.shop.buyCost')}>
                <b data-testid="mc-shop-buy-sum">{tot.anyBuyCost ? money(tot.buyCost) : '–'}</b>
                {tot.anyBuyCost && !tot.buyCostComplete && (
                  <>
                    {' '}
                    <Badge kind="incomplete">{t('common.incomplete')}</Badge>
                  </>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {anyGrid && <p className="muted small w5ms-foot">{t('w5ms.shop.gridAssumed')}</p>}
      <p className="muted small w5ms-foot">{t('w5ms.shop.hint')}</p>
    </section>
  );
}

function PerColorTable({ st, pal, phone }: { st: Stats; pal: readonly PaletteColor[]; phone: boolean }) {
  const { t, n, lang } = useI18n();
  const used = st.perColor.filter((c) => c.pieces > 0);
  const sum = used.reduce((a, c) => ({ pieces: a.pieces + c.pieces, cut: a.cut + c.cut, raw: a.raw + c.raw, res: a.res + c.rawWithReserve }), { pieces: 0, cut: 0, raw: 0, res: 0 });
  const pct = n(st.reservePct, 2);
  return (
    <Fold phone={phone} title={t('plan.perColor')} testId="mc-per-color-sec">
      {/* nur Rohsteine je Farbe (addieren sich zur Gesamtzahl); Packungen, Bestand und Kosten stehen je Material oben */}
      <div className={`table-wrap ${used.length > 15 ? 'tall' : ''}`}>
        <table className="data small w5ms-table w5ms-cards w5ms-colors" data-testid="mc-per-color">
          <thead>
            <tr>
              <th>{t('colors.code')}</th>
              <th>{t('colors.name')}</th>
              <th>{t('w5ms.shop.material')}</th>
              <th className="num">{t('colors.stones')}</th>
              <th className="num" title={t('w5ms.color.cutTitle')}>
                {t('w5ms.color.cut')}
              </th>
              <th className="num">{t('plan.raw')}</th>
              <th className="num" title={t('w5ms.color.reserveTitle', { pct })}>
                +{pct} %
              </th>
            </tr>
          </thead>
          <tbody>
            {used.map((c) => {
              const p = pal[c.color];
              const m = c.material;
              return (
                <tr key={c.color} data-testid="mc-color-row">
                  <td className="w5ms-cc-code" data-col="code">
                    <span className="w1fx-code">
                      <Swatch hex={p?.hex ?? '#000'} size={12} />
                      {code2(pal, c.color)}
                    </span>
                  </td>
                  <td className="w5ms-cc-name" data-col="name">
                    {p ? paletteDisplayName(p, lang) : '?'}
                  </td>
                  <td className={`w5ms-cc-mat ${!m && !c.materialMissing ? 'w5ms-cc-nomat' : ''}`} data-col="material">
                    {m ? (
                      <span>
                        {materialName(t, m)}
                        {m.colorNumber && <span className="muted mono"> {m.colorNumber}</span>}
                      </span>
                    ) : c.materialMissing ? (
                      <span className="badge badge-warn w5ms-badge" title={t('w2ch.materialMissingTitle')} data-testid="mc-color-missing">
                        {t('w2ch.materialMissing')}
                      </span>
                    ) : (
                      <span className="muted">{t('w5ms.color.noMaterial')}</span>
                    )}
                  </td>
                  <td className="num" data-col="pieces" data-label={t('colors.stones')}>
                    {n(c.pieces)}
                  </td>
                  <td className="num" data-col="cut" data-label={t('plan.cutShort')}>
                    {n(c.cut)}
                  </td>
                  <td className="num" data-col="raw" data-label={t('plan.raw')}>
                    {n(c.raw)}
                    {c.rawAssumedGrid && <span title={t('w5ms.shop.gridAssumed')}>*</span>}
                  </td>
                  <td className="num" data-col="rawWithReserve" data-label={`+${pct} %`}>
                    <b>{n(c.rawWithReserve)}</b>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="w5ms-sum">
              <th colSpan={3} className="w5ms-cc-sumlabel">
                {t('w5ms.shop.sum')}
              </th>
              <td className="num" data-col="pieces" data-label={t('colors.stones')} data-testid="mc-color-sum-pieces">
                {n(sum.pieces)}
              </td>
              <td className="num" data-col="cut" data-label={t('plan.cutShort')}>
                {n(sum.cut)}
              </td>
              <td className="num" data-col="raw" data-label={t('plan.raw')} data-testid="mc-color-sum-raw">
                {n(sum.raw)}
              </td>
              <td className="num" data-col="rawWithReserve" data-label={`+${pct} %`} data-testid="mc-color-sum-reserve">
                <b>{n(sum.res)}</b>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Fold>
  );
}

export function MaterialCalc({ api }: { api: ProjectApi }) {
  const { t, n, lang } = useI18n();
  const st = api.stats;
  const rec = api.rec!;
  const s = rec.settings;
  const pal = rec.palette;
  const reserves = [5, 10, 15, 20];
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const [csvErr, setCsvErr] = useState<string | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const native = isNative();
  const phone = useMedia(PHONE_QUERY);
  const rows = useMemo(() => (st ? shoppingRows(st, pal) : []), [st, pal]);
  const tot = useMemo(() => (st ? shoppingTotals(st, rows) : null), [st, rows]);

  // Druck: aufgeklappte Erklärungen mitdrucken, danach den vorherigen Zustand wiederherstellen
  useEffect(() => {
    let closed: HTMLDetailsElement[] = [];
    const before = () => {
      closed = [...(root.current?.querySelectorAll('details') ?? [])].filter((d) => !d.open);
      for (const d of closed) d.open = true;
    };
    const after = () => {
      for (const d of closed) d.open = false;
      closed = [];
    };
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);

  if (!st || !tot) return <p className="muted">{t('common.loading')}</p>;

  // Flächen nur als Zahl, wenn sie der Geometrie entsprechen (sonst z. B. negative Fugenfläche durch überlappende
  // Freiformteile älterer/importierter Projekte)
  const areasOk = jointAreaValid(st);
  const areaInvalid = (
    <span className="warn" data-testid="area-invalid">
      {st.invalidFreeCells > 0 ? tCount(t, 'w3fx.area.invalid', st.invalidFreeCells, { n: n(st.invalidFreeCells) }) : t('w3fx.area.inconsistent')}
    </span>
  );
  const money = (v: number) => formatMoney(v, lang);
  const anyCost = rows.some((r) => r.cost !== undefined);
  const anyMaterial = rows.some((r) => r.materialId !== null) || st.missingMaterials.length > 0;
  const noneRow = rows.find((r) => r.materialId === null);
  const missingColors = noneRow?.missingColors ?? [];
  const unlinkedColors = noneRow?.unlinkedColors ?? [];
  const usedColors = st.perColor.filter((c) => c.pieces > 0).length;
  const codes = (cs: number[]) => cs.map((c) => code2(pal, c)).join(', ');
  const goColors = () => {
    location.hash = stepHash(rec.meta.id, 'colors');
  };
  const goMaterials = () => {
    location.hash = '#/materials';
  };
  // Prüfzähler: fehlende Werte (nicht geprüft) gelten nicht als 0 Treffer, sondern werden gar nicht angezeigt
  const overlapCells = st.overlapCells ?? 0;
  const thinPieces = st.thinPieces ?? 0;
  const thinFreePieces = st.thinFreePieces ?? 0;
  const minPieceText = n(s.shapes.minPieceMm, 2);

  const exportCsv = async () => {
    setCsvErr(null);
    setSaved(null);
    setCsvBusy(true);
    try {
      const csv = buildShoppingCsv(st, pal, [], lang);
      const name = `${safeFileName(rec.meta.name)}_${SHOPPING_FILE_SUFFIX[lang]}.csv`;
      const r = await downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), name, { announce: false });
      setSaved(r);
    } catch (e) {
      setCsvErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCsvBusy(false);
    }
  };

  return (
    <div data-testid="material-calc" className="w5ms" data-busy={api.statsBusy ? 'yes' : 'no'} data-min-checked={st.thinPieces === undefined ? 'no' : 'yes'} ref={root}>
      <h2 className="w5ms-print-only">{t('w5ms.printHead', { name: rec.meta.name })}</h2>
      <p className="w5ms-print-only muted small">{t('w5ms.printDate', { date: new Date().toLocaleDateString(lang === 'de' ? 'de-DE' : lang === 'tr' ? 'tr-TR' : 'en-GB') })}</p>

      {/* ---------------- Kennzahlen */}
      <div className="w5ms-stats" data-testid="mc-stats">
        <Stat label={t('plan.stonesTotal')} value={n(st.pieces)} testId="mc-pieces" sub={t('w5ms.stat.piecesSub', { cut: n(st.cutPieces), whole: n(st.uncutPieces) })} />
        <Stat label={t('plan.withReserve')} value={n(st.rawWithReserveTotal)} testId="mc-raw-reserve" sub={t('w5ms.stat.rawSub', { pct: n(st.reservePct, 2) })} />
        <Stat
          label={t('w5ms.stat.cost')}
          testId="mc-cost"
          value={
            <>
              {anyCost ? money(st.totalCost) : '–'}
              {(anyCost || anyMaterial) && !st.costComplete && (
                <>
                  {' '}
                  <Badge kind="incomplete">{t('common.incomplete')}</Badge>
                </>
              )}
            </>
          }
          sub={
            <>
              {anyCost ? t('w5ms.stat.costSub') : anyMaterial ? t('w5ms.stat.costNone') : t('w5ms.color.noMaterial')}
              {tot.anyBuyCost && (
                <span className="w5ms-stat-buy" data-testid="mc-buy-cost" title={t('w5ms.stat.buyTitle')}>
                  {t('w5ms.stat.buy', { cost: money(tot.buyCost) })}
                  {!tot.buyCostComplete && <> ({t('common.incomplete')})</>}
                </span>
              )}
            </>
          }
        />
        <Stat
          label={t('plan.grout')}
          testId="mc-grout-stat"
          value={areasOk ? <>≈ {n(st.groutKg, 2)} kg</> : '–'}
          sub={areasOk ? t('w5ms.stat.groutSub') : areaInvalid}
        />
        <div className="w5ms-stat w5ms-reserve" title={t('w5ms.stat.reserveTitle')}>
          <span className="w5ms-stat-label">{t('plan.reserve')}</span>
          <div className="btn-row wrap w5ms-noprint" role="group" aria-label={t('plan.reserve')}>
            {reserves.map((r) => (
              <button key={r} type="button" className={`btn chip ${s.reservePct === r ? 'primary' : ''}`} aria-pressed={s.reservePct === r} onClick={() => api.setSettings({ reservePct: r })}>
                {r} %
              </button>
            ))}
            <NumberInput value={s.reservePct} onChange={(v) => api.setSettings({ reservePct: v })} min={0} max={200} suffix="%" width={50} label={t('plan.reserve')} />
          </div>
          <b className="w5ms-stat-value w5ms-print-only">{n(st.reservePct, 2)} %</b>
        </div>
      </div>

      {/* ---------------- Aktionen */}
      <div className="w5ms-actions w5ms-noprint">
        <button type="button" className="btn" onClick={exportCsv} disabled={csvBusy || api.statsBusy} title={api.statsBusy ? t('w4fx.stats.updating') : t('w5ms.csvTitle')} data-testid="mc-csv">
          ⤓ {t('w5ms.csv')}
        </button>
        {native ? (
          <span className="muted small w5ms-print-na" data-testid="mc-print-na">
            <Badge kind="incomplete">{t('common.incomplete')}</Badge> {t('w5ms.printNative')}
          </span>
        ) : (
          <button type="button" className="btn" onClick={() => window.print()} title={t('w5ms.printTitle')} data-testid="mc-print">
            ⎙ {t('w5ms.print')}
          </button>
        )}
        {/* nach einer Änderung (Reserve, Palette, Steine …) zeigen die Zahlen bis zum neuen Durchlauf den alten Stand */}
        {api.statsBusy && (
          <span className="muted small" role="status" data-testid="mc-updating">
            {t('w4fx.stats.updating')}
          </span>
        )}
      </div>
      {saved && (
        <div className="w5ms-noprint">
          <SaveResultNote result={saved} onDismiss={() => setSaved(null)} testId="mc-csv-note" />
        </div>
      )}
      {csvErr && (
        <p className="error small" role="alert" data-testid="mc-csv-error">
          {t('w5ms.csvError', { msg: csvErr })}
        </p>
      )}

      {/* ---------------- Hinweise */}
      {tot.shortfalls.length > 0 && (
        <div className="w5ms-banner w5ms-banner-short" role="status" data-testid="mc-shortfall">
          <b>{tCount(t, 'w5ms.short.title', tot.shortfalls.length, { n: n(tot.shortfalls.length) })}</b>
          <ul>
            {tot.shortfalls.map((r) => (
              <li key={r.materialId ?? '-'} data-testid="mc-short-item">
                {r.material && <Swatch hex={r.material.hex || '#000'} size={12} />} <b>{r.material ? materialName(t, r.material) : t('w5ms.shop.noMaterialGroup')}</b>
                {r.material?.colorNumber && <span className="mono"> {r.material.colorNumber}</span>} <span className="muted">({codes(r.colors)})</span>:{' '}
                {t('w5ms.short.item', { need: n(r.need), stock: n(r.stock ?? 0), toBuy: n(r.toBuy ?? 0) })}
                {r.packsToBuy !== undefined && <> = {tCount(t, 'w5ms.short.packs', r.packsToBuy, { n: n(r.packsToBuy) })}</>}
                {r.buyCost !== undefined && <> · {money(r.buyCost)}</>}
              </li>
            ))}
          </ul>
          {/* Summe nur über Materialien mit erfasstem Bestand: ohne Bestand (oder ohne Material) ist offen, was zu
              kaufen ist – dann ausdrücklich als Teilsumme und „unvollständig“ kennzeichnen */}
          <p data-testid="mc-short-total" data-complete={tot.shortTotalComplete ? 'yes' : 'no'}>
            <b>
              {t(tot.toBuyComplete ? 'w5ms.short.total' : 'w5fu.short.totalPartial', { n: n(tot.shortToBuy) })}
              {tot.shortPacksComplete && <> · {tCount(t, 'w5ms.short.totalPacks', tot.shortPacks, { n: n(tot.shortPacks) })}</>}
              {tot.shortCostKnown && <> · {t('w5ms.short.totalCost', { cost: money(tot.shortCost) })}</>}
            </b>
            {!tot.shortTotalComplete && (
              <>
                {' '}
                <Badge kind="incomplete">{t('common.incomplete')}</Badge>
              </>
            )}
            {!tot.shortPacksComplete && <span className="muted"> · {t('w5ms.short.packsIncomplete')}</span>}
          </p>
          {!tot.toBuyComplete && (
            <p className="muted small" data-testid="mc-short-partial">
              {t('w5fu.short.partialNote')}
            </p>
          )}
        </div>
      )}
      {st.invalidColorPieces > 0 && (
        <p className="w5ms-banner w5ms-banner-error" role="alert" data-testid="mc-invalid-color">
          {tCount(t, 'w5ms.invalidColor', st.invalidColorPieces, { n: n(st.invalidColorPieces) })}
        </p>
      )}
      {/* Prüfzähler der Statistik (ein Durchlauf, dieselbe Regel wie Berechnung und Steindetail). thinPieces und
          thinFreePieces fehlen, solange die Mindestbreite nicht geprüft wurde – dann steht hier nichts (nie „0“). */}
      {overlapCells > 0 && (
        <p className="w5ms-banner w5ms-banner-error" role="alert" data-testid="mc-overlap" data-count={overlapCells}>
          {tCount(t, 'w5int.overlap', overlapCells, { n: n(overlapCells) })}
        </p>
      )}
      {thinPieces > 0 && (
        <p className="w5ms-banner w5ms-banner-warn" role="status" data-testid="mc-thin" data-count={thinPieces}>
          {tCount(t, 'w5int.thin', thinPieces, { n: n(thinPieces), min: minPieceText })}
        </p>
      )}
      {thinFreePieces > 0 && (
        <p className="w5ms-banner" data-testid="mc-thin-free" data-count={thinFreePieces}>
          {tCount(t, 'w5int.thinFree', thinFreePieces, { n: n(thinFreePieces), min: minPieceText })}
        </p>
      )}
      {(missingColors.length > 0 || unlinkedColors.length > 0) && (
        <div className={`w5ms-banner ${missingColors.length ? 'w5ms-banner-warn' : 'w5ms-banner-info'}`} data-testid="mc-nomaterial">
          {missingColors.length > 0 && <p data-testid="mc-missing">{t('w5ms.missing', { codes: codes(missingColors) })}</p>}
          {unlinkedColors.length > 0 && (
            <p data-testid="mc-unlinked">{unlinkedColors.length === usedColors && !anyMaterial ? t('w5ms.unlinkedAll') : t('w5ms.unlinked', { codes: codes(unlinkedColors) })}</p>
          )}
          <button type="button" className="btn small w5ms-noprint" onClick={goColors} data-testid="mc-go-colors">
            {t('w5ms.goColors')}
          </button>
        </div>
      )}
      {tot.materials > 0 && tot.stockRecorded < tot.materials && (
        <div className="w5ms-banner w5ms-banner-info" data-testid="mc-stock-unknown">
          <p>{tot.stockRecorded === 0 ? t('w5ms.stockNone') : tCount(t, 'w5ms.stockUnknown', tot.materials - tot.stockRecorded, { n: n(tot.materials - tot.stockRecorded) })}</p>
          <button type="button" className="btn small w5ms-noprint" onClick={goMaterials} data-testid="mc-go-materials">
            {t('w5ms.goMaterials')}
          </button>
        </div>
      )}

      {/* ---------------- Einkaufsliste je Material */}
      <ShoppingTable rows={rows} st={st} pal={pal} />

      {/* ---------------- Bedarf je Farbe | Berechnung im Detail */}
      <div className="w5ms-grid">
        <PerColorTable st={st} pal={pal} phone={phone} />
        <Fold phone={phone} title={t('w5ms.details')} className="w5ms-details" testId="mc-details-sec">
          <table className="kv small">
            <tbody>
              <tr>
                <th>{t('plan.gridPositions')}</th>
                <td data-testid="mc-grid">{n(st.gridPositions)}</td>
              </tr>
              <tr>
                <th>{t('plan.stonesTotal')}</th>
                <td>{n(st.pieces)}</td>
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
              {(anyCost || anyMaterial) && (
                <tr>
                  <th>{t('plan.cost')}</th>
                  <td data-testid="mc-cost-kv">
                    {anyCost ? money(st.totalCost) : '–'} {!st.costComplete && <Badge kind="incomplete">{t('common.incomplete')}</Badge>}
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
          <div className="w5ms-pair">
            <div>
              <h4>{t('plan.perShape')}</h4>
              <table className="data small" data-testid="mc-per-shape">
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
              <div className="table-wrap w5ms-sizes">
                <table className="data small" data-testid="mc-per-size">
                  <tbody>
                    {st.perSize.slice(0, 200).map((z) => (
                      <tr key={z.key}>
                        <td>{t(`shape.${z.shape}`)}</td>
                        <td className="w5ms-nowrap">
                          {n(z.w, 1)} × {n(z.h, 1)} mm
                        </td>
                        <td className="num">{n(z.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {st.perSize.length > 200 && (
                <p className="muted small w5ms-foot" data-testid="mc-sizes-truncated">
                  {t('w5ms.sizesTruncated', { n: n(st.perSize.length) })}
                </p>
              )}
            </div>
          </div>
        </Fold>
      </div>
    </div>
  );
}
