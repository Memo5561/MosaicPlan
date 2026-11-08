import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isValidHex } from '../../core/color';
import {
  cellCoverage,
  cellGrid,
  farDeltaE,
  groutCandidates,
  hexToLinear,
  linToSrgb8,
  mosaicCells,
  normHex,
  prepareFarModel,
  recommendGrout,
  targetLinear,
  worthSwitching,
  type CellGrid,
  type FarModel,
  type GroutScore,
} from '../../core/grout';
import { applyAdjustments } from '../../core/imageOps';
import { computeLayout, estimateCells, type Layout } from '../../core/layout';
import { useI18n } from '../../i18n';
import { Badge, Field, NumberInput, Segmented, Swatch } from '../components';
import '../css/w2-grout-preview.css';
import { layoutParamsOf, type ProjectApi } from './useProject';
import { canvasToRaw, renderCropped, rotatedSize } from './imagePrep';

const UNIT_F = { mm: 1, cm: 10, m: 1000 } as const;

export function LayoutSummary({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const { layout, layoutError, rec } = api;
  if (layoutError) return <p className="error">{layoutError}</p>;
  if (!layout || !rec) return null;
  const cells = layout.cols * layout.rows;
  const cutCols = Array.from(layout.colW).filter((w) => Math.abs(w - layout.tileW) > 1e-9).length;
  const cutRows = Array.from(layout.rowH).filter((h) => Math.abs(h - layout.tileH) > 1e-9).length;
  const stoneArea = Array.from(layout.colW).reduce((a, b) => a + b, 0) * Array.from(layout.rowH).reduce((a, b) => a + b, 0);
  const total = layout.finishedW * layout.finishedH;
  return (
    <div className="summary-box" data-testid="layout-summary">
      <div className="stat">
        <span>{t('size.grid')}</span>
        <b>
          {n(layout.cols)} × {n(layout.rows)}
        </b>
      </div>
      <div className="stat">
        <span>{t('size.positions')}</span>
        <b data-testid="grid-positions">{n(cells)}</b>
      </div>
      <div className="stat">
        <span>{t('size.finished')}</span>
        <b data-testid="finished-size">
          {n(layout.finishedW, 2)} × {n(layout.finishedH, 2)} mm
        </b>
      </div>
      <div className="stat">
        <span>{t('size.jointShare')}</span>
        <b>{n(((total - stoneArea) / total) * 100, 1)} %</b>
      </div>
      {(cutCols > 0 || cutRows > 0) && (
        <div className="stat">
          <span>{t('size.edgeCut')}</span>
          <b>
            {cutCols} {t('size.colsShort')} / {cutRows} {t('size.rowsShort')}
          </b>
        </div>
      )}
      {(layout.restX > 1e-6 || layout.restY > 1e-6) && (
        <div className="stat warn">
          <span>{t('size.rest')}</span>
          <b>
            {n(layout.restX, 2)} × {n(layout.restY, 2)} mm
          </b>
        </div>
      )}
      <p className="muted small">{t('size.formula', { w: n(layout.tileW, 2), g: n(layout.joint, 2) })}</p>
      {cells > 2_000_000 && <Badge kind="warn">{t('size.manyCells')}</Badge>}
    </div>
  );
}

export function StepSize({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const f = UNIT_F[s.unit];
  const presets: [number, number][] = [
    [30, 40],
    [40, 40],
    [50, 70],
    [60, 90],
    [100, 100],
    [200, 100],
    [300, 200],
    [500, 300],
    [1000, 500],
  ];
  // Maße des Originals (sourceSize), nicht der evtl. verkleinerten Arbeitskopie – sonst weicht
  // „Höhe aus Foto“ durch Rundung der Arbeitskopie um bis zu 0,02 % ab
  const photoAspect = api.bitmap ? (() => {
    const r = rotatedSize(api.sourceSize?.w ?? api.bitmap.width, api.sourceSize?.h ?? api.bitmap.height, api.rec!.adjust);
    const c = api.rec!.adjust.crop;
    return c ? (c.w * r.w) / (c.h * r.h) : r.w / r.h;
  })() : null;
  return (
    <div className="two-col">
      <div>
        <Field label={t('size.unit')}>
          <Segmented value={s.unit} options={[{ value: 'mm', label: 'mm' }, { value: 'cm', label: 'cm' }, { value: 'm', label: 'm' }]} onChange={(u) => api.setSettings({ unit: u })} />
        </Field>
        <Field label={t('size.width')}>
          <NumberInput value={s.widthMm / f} onChange={(v) => api.setSettings({ widthMm: v * f })} min={0.1} suffix={s.unit} testId="width-input" decimals={4} />
        </Field>
        <Field label={t('size.height')}>
          <NumberInput value={s.heightMm / f} onChange={(v) => api.setSettings({ heightMm: v * f })} min={0.1} suffix={s.unit} testId="height-input" decimals={4} />
        </Field>
        {photoAspect && (
          <div className="btn-row wrap">
            <button className="btn small" onClick={() => api.setSettings({ heightMm: Math.round((s.widthMm / photoAspect) * 10) / 10 })}>
              {t('size.heightFromPhoto')}
            </button>
            <button className="btn small" onClick={() => api.setSettings({ widthMm: Math.round(s.heightMm * photoAspect * 10) / 10 })}>
              {t('size.widthFromPhoto')}
            </button>
            <button className="btn small" onClick={() => api.setSettings({ widthMm: s.heightMm, heightMm: s.widthMm })}>
              ⇄ {t('size.swap')}
            </button>
          </div>
        )}
        <h4>{t('size.presets')}</h4>
        <div className="btn-row wrap">
          {presets.map(([w, h]) => (
            <button key={`${w}x${h}`} className="btn small" onClick={() => api.setSettings({ widthMm: w * 10, heightMm: h * 10 })}>
              {w} × {h} cm
            </button>
          ))}
        </div>
        <Field label={t('size.edgeMode')} hint={t(`size.edge.${s.edgeMode}.hint`)}>
          <Segmented
            value={s.edgeMode}
            options={[
              { value: 'whole', label: t('size.edge.whole') },
              { value: 'cut-end', label: t('size.edge.cut-end') },
              { value: 'cut-both', label: t('size.edge.cut-both') },
            ]}
            onChange={(v) => api.setSettings({ edgeMode: v })}
          />
        </Field>
        <Field label={t('size.minCut')}>
          <NumberInput value={s.minCutMm} onChange={(v) => api.setSettings({ minCutMm: v })} min={0.5} max={20} suffix="mm" />
        </Field>
        <p className="muted small">
          {t('size.area')}: {n((s.widthMm * s.heightMm) / 1e6, 4)} m²
        </p>
      </div>
      <div>
        <LayoutSummary api={api} />
        <p className="muted small">{t('size.originHint')}</p>
      </div>
    </div>
  );
}

export function StepTiles({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const sizes = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const custom: [number, number][] = [
    [3, 5],
    [4, 8],
    [6, 10],
    [8, 12],
  ];
  const outOfRange = s.tileW < 2 || s.tileW > 12 || s.tileH < 2 || s.tileH > 12;
  return (
    <div className="two-col">
      <div>
        <h4>{t('tiles.square')}</h4>
        <div className="btn-row wrap" data-testid="tile-presets">
          {sizes.map((v) => (
            <button key={v} className={`btn chip ${s.tileW === v && s.tileH === v ? 'primary' : ''}`} onClick={() => api.setSettings({ tileW: v, tileH: v })}>
              {v} × {v} mm
            </button>
          ))}
        </div>
        <h4>{t('tiles.rect')}</h4>
        <div className="btn-row wrap">
          {custom.map(([w, h]) => (
            <button key={`${w}x${h}`} className={`btn chip ${s.tileW === w && s.tileH === h ? 'primary' : ''}`} onClick={() => api.setSettings({ tileW: w, tileH: h })}>
              {w} × {h} mm
            </button>
          ))}
        </div>
        <h4>{t('tiles.custom')}</h4>
        <div className="btn-row">
          <NumberInput value={s.tileW} onChange={(v) => api.setSettings({ tileW: v })} min={0.5} max={100} suffix="mm" label={t('tiles.w')} testId="tile-w" />
          <span>×</span>
          <NumberInput value={s.tileH} onChange={(v) => api.setSettings({ tileH: v })} min={0.5} max={100} suffix="mm" label={t('tiles.h')} testId="tile-h" />
        </div>
        {outOfRange && <Badge kind="warn">{t('tiles.outOfRange')}</Badge>}
        <Field label={t('tiles.surface')}>
          <Segmented value={s.surface} options={[{ value: 'glass', label: t('mat.glass') }, { value: 'ceramic', label: t('mat.ceramic') }]} onChange={(v) => api.setSettings({ surface: v })} />
        </Field>
        <p className="muted small">{t('tiles.mixedHint')}</p>
        <p className="muted small">{t('tiles.materialHint')}</p>
      </div>
      <div>
        <LayoutSummary api={api} />
        <p className="muted small">
          {t('tiles.pitch')}: {n(s.tileW + s.joint, 2)} × {n(s.tileH + s.joint, 2)} mm
        </p>
      </div>
    </div>
  );
}

export function StepJoint({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const s = api.rec!.settings;
  const presets = [0, 0.5, 1, 1.5, 2, 3];
  // Vergleich: wie viele Steine passen ohne Fugenberücksichtigung (falsche Rechnung) vs. korrekt
  let naive: number | null = null;
  try {
    const L = computeLayout({ ...layoutParamsOf(s), edgeMode: 'whole' });
    const naiveCols = Math.floor(s.widthMm / s.tileW);
    naive = naiveCols - L.cols;
  } catch {
    naive = null;
  }
  const est = estimateCells(layoutParamsOf(s));
  return (
    <div className="two-col">
      <div>
        <h4>{t('joint.width')}</h4>
        <div className="btn-row wrap" data-testid="joint-presets">
          {presets.map((v) => (
            <button key={v} className={`btn chip ${s.joint === v ? 'primary' : ''}`} onClick={() => api.setSettings({ joint: v })}>
              {n(v, 1)} mm
            </button>
          ))}
        </div>
        <Field label={t('joint.custom')}>
          <NumberInput value={s.joint} onChange={(v) => api.setSettings({ joint: v })} min={0} max={20} suffix="mm" testId="joint-input" />
        </Field>
        <Field label={t('joint.color')} hint={t('grout.dryHint')}>
          <GroutColorInput value={s.groutHex} onChange={(hex) => api.setSettings({ groutHex: hex })} />
        </Field>
        <GroutAdvice api={api} />
        <Field label={t('joint.depth')} hint={t('joint.depthHint')}>
          <NumberInput value={s.groutDepthMm} onChange={(v) => api.setSettings({ groutDepthMm: v })} min={0} max={30} suffix="mm" />
        </Field>
        {naive !== null && naive > 0 && <p className="muted small">{t('joint.naive', { n: naive })}</p>}
        <p className="muted small">{t('joint.estimate', { c: n(est.cols), r: n(est.rows) })}</p>
      </div>
      <div>
        <LayoutSummary api={api} />
      </div>
    </div>
  );
}

/** Fugenfarbe: Farbwähler plus HEX-Feld (für den gemessenen Wert einer getrockneten Probe). */
function GroutColorInput({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);
  const valid = isValidHex(text);
  const pickerValue = isValidHex(value) ? normHex(value).toLowerCase() : '#bdb8ae';
  return (
    <span className="gp-color">
      <input type="color" value={pickerValue} onChange={(e) => onChange(e.target.value.toUpperCase())} aria-label={t('joint.color')} data-testid="grout-color" />
      <input
        className={`gp-hex ${valid ? '' : 'invalid'}`}
        value={text}
        spellCheck={false}
        autoCapitalize="characters"
        autoComplete="off"
        aria-label={t('grout.hex')}
        aria-invalid={!valid}
        data-testid="grout-hex"
        maxLength={7}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          // Kurzform (#ABC) erst beim Verlassen übernehmen; Ungültiges verwerfen
          if (isValidHex(text) && normHex(text) !== normHex(value)) {
            const hex = normHex(text);
            onChange(hex);
            setText(hex);
          } else setText(value);
        }}
        onChange={(e) => {
          const v = e.target.value.trim();
          setText(v);
          // nur vollständige sechsstellige Werte übernehmen (die dreistellige Kurzform nicht schon beim Tippen)
          if (isValidHex(v) && v.replace('#', '').length === 6) onChange(normHex(v));
        }}
      />
      {!valid && (
        <span className="gp-hex-err" role="alert">
          {t('grout.hexInvalid')}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- Fugenfarben-Empfehlung (Schätzung)

/** Höchstens so viele Felder im Fernwirkungs-Modell der Oberfläche (große Projekte: k × k Zellen je Feld). */
const ADVICE_MAX_FIELDS = 160_000;

interface PhotoModel {
  key: string;
  layout: Layout;
  grid: CellGrid;
  /** Fotofarbe je Feld (linear) und Steinbedeckung bei ganzen Steinen */
  target: Float32Array;
  coverage: Float32Array;
  ideal: FarModel;
}
interface StoneModel {
  key: string;
  coverage: Float32Array;
  stones: Float32Array;
  model: FarModel;
}

const nextTick = () => new Promise<void>((res) => window.setTimeout(res, 0));

/**
 * Foto des Zuschnitts in etwa 2 Pixeln je Feld (höchstens Quellauflösung), mit den globalen Farb- und
 * Tonwerteinstellungen (Weißabgleich, Tonwerte, Helligkeit, Kontrast, Sättigung) wie in der Berechnung.
 * Lokale Filter (Schärfe, Details, Hintergrund) ändern die Fernwirkung kaum und entfallen hier.
 * Liest das Foto nur (renderCropped zeichnet in ein neues Canvas).
 */
function photoForGrid(api: ProjectApi, grid: CellGrid) {
  const bmp = api.bitmap!;
  const adj = api.rec!.adjust;
  const crop = api.effectiveCrop!;
  const r = rotatedSize(bmp.width, bmp.height, adj);
  const cw = Math.max(1, crop.w * r.w);
  const ch = Math.max(1, crop.h * r.h);
  const pw = Math.max(8, Math.round(Math.min(cw, grid.w * 2)));
  const ph = Math.max(8, Math.round(Math.min(ch, grid.h * 2)));
  const raw = canvasToRaw(renderCropped(bmp, adj, crop, pw, ph));
  return applyAdjustments(raw, { ...adj, crop: null, sharpen: 0, detailBoost: 0, bgSimplify: 0 }, []);
}

function useGroutAdvice(api: ProjectApi) {
  const rec = api.rec!;
  const lpKey = JSON.stringify(layoutParamsOf(rec.settings));
  const c = api.effectiveCrop;
  const photoKey = api.bitmap && api.layout && c ? `${lpKey}|${JSON.stringify(rec.adjust)}|${c.x},${c.y},${c.w},${c.h}` : '';
  const [photo, setPhoto] = useState<PhotoModel | null>(null);
  const [stone, setStone] = useState<StoneModel | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const bitmap = api.bitmap;

  // 1) Foto-Modell: neu bei anderem Foto, Zuschnitt, Bildeinstellungen oder Raster – nicht bei der Fugenfarbe
  useEffect(() => {
    if (!photoKey) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const a = apiRef.current;
        const layout = a.layout!;
        const grid = cellGrid(layout, ADVICE_MAX_FIELDS);
        const img = photoForGrid(a, grid);
        await nextTick();
        if (cancelled) return;
        const target = targetLinear(img, layout, grid);
        const coverage = cellCoverage(layout, null, grid);
        await nextTick();
        if (cancelled) return;
        const ideal = prepareFarModel({ w: grid.w, h: grid.h, target, stones: null, coverage, k: grid.k });
        if (!cancelled) setPhoto({ key: photoKey, layout, grid, target, coverage, ideal });
      } catch (e) {
        console.warn('Fernwirkung: Schätzung fehlgeschlagen', e);
        if (!cancelled) setFailedKey(photoKey);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [photoKey, bitmap]);
  const photoNow = photo && photo.key === photoKey ? photo : null;

  // 2) Berechnetes Mosaik: nur wenn sein Raster dem aktuellen entspricht (sonst wäre es ein anderes Mosaik)
  const computed = api.computed;
  const sameGrid = !!computed && JSON.stringify(computed.layoutParams) === lpKey;
  const palette = rec.palette;
  const version = api.version;
  useEffect(() => {
    if (!photoNow || !computed || !sameGrid) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      try {
        const mc = mosaicCells(computed.layout, computed.data, palette, photoNow.grid);
        const model = prepareFarModel({ w: photoNow.grid.w, h: photoNow.grid.h, target: photoNow.target, stones: mc.stones, coverage: mc.coverage, k: photoNow.grid.k });
        if (!cancelled) setStone({ key: `${photoNow.key}|${version}`, coverage: mc.coverage, stones: mc.stones, model });
      } catch (e) {
        console.warn('Fernwirkung des Mosaiks: Schätzung fehlgeschlagen', e);
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [photoNow, computed, sameGrid, palette, version]);
  const stoneNow = stone && sameGrid && stone.key === `${photoKey}|${version}` ? stone : null;

  // 3) Rangliste (billig): alle Kandidaten + aktuelle Farbe
  const groutHex = rec.settings.groutHex;
  const ranked = useMemo(() => (photoNow ? recommendGrout(photoNow.ideal, groutCandidates(groutHex)) : null), [photoNow, groutHex]);
  const mosaic = useMemo(() => {
    if (!stoneNow || !ranked) return null;
    const cur = hexToLinear(groutHex);
    const best = hexToLinear(ranked[0].hex);
    if (!cur || !best) return null;
    return { current: farDeltaE(stoneNow.model, cur), best: farDeltaE(stoneNow.model, best) };
  }, [stoneNow, ranked, groutHex]);

  return {
    hasPhoto: !!api.bitmap,
    failed: !!photoKey && failedKey === photoKey,
    photo: photoNow,
    stone: stoneNow,
    ranked,
    mosaic,
    computedOtherGrid: !!computed && !sameGrid,
  };
}

function GroutAdvice({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const adv = useGroutAdvice(api);
  const groutHex = normHex(api.rec!.settings.groutHex);
  const name = (sc: { key: string }) => (sc.key === 'current' ? t('grout.c.current') : t(`grout.c.${sc.key}`));
  const de = (v: number) => n(v, 1);
  const apply = (hex: string) => api.setSettings({ groutHex: hex });

  let body: ReactNode;
  if (!adv.hasPhoto) body = <p className="muted small">{t('grout.noPhoto')}</p>;
  else if (adv.failed) body = <p className="muted small">{t('grout.error')}</p>;
  else if (!adv.ranked || !adv.photo)
    body = (
      <p className="muted small" data-testid="grout-busy">
        {t('grout.busy')}
      </p>
    );
  else if (adv.photo.ideal.meanCoverage > 0.9995)
    // ohne Fuge (0 mm) bedecken die Steine alles: die Fugenfarbe ändert die Fernwirkung nicht
    body = (
      <p className="muted small" data-testid="grout-recommendation" data-switch="0">
        {t('grout.noJoint')}
      </p>
    );
  else {
    const ranked = adv.ranked;
    const best = ranked[0];
    const current = ranked.find((r) => r.hex === groutHex) ?? null;
    const switchIt = !!current && best.hex !== groutHex && worthSwitching(current, best);
    // praktisch gleich gut (Rundung der Anzeige): die aktuelle Farbe gilt als beste
    const otherBest = best.hex !== groutHex && !(current && current.mean - best.mean < 0.05);
    body = (
      <>
        {switchIt && current ? (
          <div className="gp-rec" data-testid="grout-recommendation" data-best={best.hex} data-switch="1">
            <Swatch hex={best.hex} size={22} />
            <span className="gp-rec-text">
              {t('grout.recommend', { name: name(best), best: de(best.mean), current: de(current.mean) })} – <b>{t('grout.estimate')}</b>
            </span>
            <button className="btn small primary" onClick={() => apply(best.hex)} data-testid="grout-apply">
              {t('grout.apply')}
            </button>
          </div>
        ) : current ? (
          <div className="gp-rec ok" data-testid="grout-recommendation" data-best={best.hex} data-switch="0">
            <Swatch hex={groutHex} size={22} />
            <span className="gp-rec-text">
              {otherBest ? t('grout.keep', { current: de(current.mean), name: name(best), best: de(best.mean) }) : t('grout.isBest', { current: de(current.mean) })} –{' '}
              <b>{t('grout.estimate')}</b>
            </span>
          </div>
        ) : null}
        {adv.mosaic && (
          <p className="small gp-mosaic" data-testid="grout-mosaic">
            {t('grout.mosaic', { current: de(adv.mosaic.current.mean) })}
            {otherBest && t('grout.mosaicWithBest', { name: name(best), best: de(adv.mosaic.best.mean) })}
          </p>
        )}
        {adv.computedOtherGrid && <p className="muted small">{t('grout.mosaicOtherGrid')}</p>}
        <FarPreview photo={adv.photo} stone={adv.stone} currentHex={groutHex} best={switchIt ? best : null} name={name} />
        <details className="gp-details">
          <summary>{t('grout.list')}</summary>
          <table className="gp-table" data-testid="grout-table">
            <thead>
              <tr>
                <th>{t('grout.colColor')}</th>
                <th>{t('grout.colMean')}</th>
                <th>{t('grout.colP95')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ranked.map((r) => (
                <GroutRow key={r.hex} r={r} name={name(r)} isCurrent={r.hex === groutHex} onApply={() => apply(r.hex)} de={de} />
              ))}
            </tbody>
          </table>
          <p className="muted small">{t('grout.listHint')}</p>
        </details>
        <details className="gp-details">
          <summary>{t('grout.how')}</summary>
          <p className="muted small">{t('grout.howText', { cov: n(adv.photo.ideal.meanCoverage * 100, 0) })}</p>
        </details>
      </>
    );
  }
  return (
    <section className="gp-box" data-testid="grout-advice">
      <h4>
        {t('grout.title')} <Badge kind="info">{t('grout.estimate')}</Badge>
      </h4>
      {body}
    </section>
  );
}

function GroutRow({ r, name, isCurrent, onApply, de }: { r: GroutScore; name: string; isCurrent: boolean; onApply: () => void; de: (v: number) => string }) {
  const { t } = useI18n();
  return (
    <tr className={isCurrent ? 'current' : ''} data-hex={r.hex}>
      <td>
        <span className="gp-name">
          <Swatch hex={r.hex} size={16} />
          <span>
            {name} <span className="muted">{r.hex}</span>
          </span>
        </span>
      </td>
      <td>{de(r.mean)}</td>
      <td>{de(r.p95)}</td>
      <td>
        {isCurrent ? (
          <span className="muted small">{t('grout.currentTag')}</span>
        ) : (
          <button className="btn small" onClick={onApply}>
            {t('grout.apply')}
          </button>
        )}
      </td>
    </tr>
  );
}

/**
 * Kleine Ansicht „aus der Entfernung“: je Feld die optische Mischung f·Stein + (1−f)·Fuge in linearem Licht
 * (mit den berechneten Steinfarben, sonst ideale Steine in Fotofarbe) neben dem Foto. Schätzung.
 */
function FarPreview({ photo, stone, currentHex, best, name }: { photo: PhotoModel; stone: StoneModel | null; currentHex: string; best: GroutScore | null; name: (s: { key: string }) => string }) {
  const { t } = useI18n();
  const items: { key: string; label: string; grout: string | null }[] = [
    { key: 'photo', label: t('grout.pv.photo'), grout: null },
    { key: 'current', label: t('grout.pv.current'), grout: currentHex },
  ];
  if (best) items.push({ key: 'best', label: `${t('grout.pv.best')}: ${name(best)}`, grout: best.hex });
  return (
    <figure className="gp-preview" data-testid="grout-preview">
      <div className="gp-thumbs">
        {items.map((it) => (
          <div key={it.key} className="gp-thumb">
            <FieldCanvas photo={photo} stone={stone} grout={it.grout} label={it.label} />
            <span className="small">
              {it.grout && <Swatch hex={it.grout} size={11} />} {it.label}
            </span>
          </div>
        ))}
      </div>
      <figcaption className="muted small">{stone ? t('grout.pv.stones') : t('grout.pv.ideal')}</figcaption>
    </figure>
  );
}

function FieldCanvas({ photo, stone, grout, label }: { photo: PhotoModel; stone: StoneModel | null; grout: string | null; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const { w, h } = photo.grid;
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(w, h);
    const g = grout ? hexToLinear(grout) : null;
    const src = stone && g ? stone.stones : photo.target;
    const cov = stone && g ? stone.coverage : photo.coverage;
    for (let i = 0; i < w * h; i++) {
      const f = g ? cov[i] : 1;
      for (let k = 0; k < 3; k++) img.data[i * 4 + k] = linToSrgb8(f * src[i * 3 + k] + (g ? (1 - f) * g[k] : 0));
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [photo, stone, grout]);
  return <canvas ref={ref} role="img" aria-label={label} style={{ aspectRatio: `${photo.layout.finishedW} / ${photo.layout.finishedH}` }} />;
}
