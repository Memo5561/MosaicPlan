import { useEffect, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';
import { deltaE2000, hexToLab, isValidHex } from '../../core/color';
import { paletteDisplayName } from '../../core/colorNames';
import { addPaletteColor, matchDeltaEValid, normalizePaletteNames, removePaletteColor, resetAutoName, updatePaletteColor } from '../../core/edits';
import type { ComputeDiagnostics } from '../../core/mosaic';
import { applyMaterialMerge, planColorRemoval, planMaterialMerge, type MaterialMergePlan, type RemovalPlan } from '../../core/paletteOps';
import type { Material, MosaicData, PaletteColor, PaletteMode } from '../../core/types';
import { tCount, useI18n, type TFunc } from '../../i18n';
import { Badge, Field, Modal, NumberInput, Segmented, Slider, Swatch } from '../components';
import { computedDeltaE } from './staleReasons';
import type { ProjectApi } from './useProject';
import '../css/w1-mosaic-core.css';
import '../css/w2-colour-honesty.css';

export const COLOR_COUNTS = [8, 12, 16, 24, 32, 48, 64, 100, 150, 200];

function nearestMaterial(p: PaletteColor, mats: Material[]): { m: Material; d: number } | null {
  let best: { m: Material; d: number } | null = null;
  for (const m of mats) {
    if (!isValidHex(m.hex)) continue;
    const l = hexToLab(m.hex);
    const d = deltaE2000(p.lab[0], p.lab[1], p.lab[2], l[0], l[1], l[2]);
    if (!best || d < best.d) best = { m, d };
  }
  return best;
}

/**
 * Hält die gespeicherten automatischen Farbnamen der Palette auf dem Stand der UI-Sprache (und übernimmt einmalig
 * die automatischen Namen von Projekten vor Welle 2). Läuft im Arbeitsbereich – also auf jedem Schritt – beim
 * Öffnen, bei Sprachwechsel, nach einer Berechnung und wenn eine anderswo gespeicherte Berechnung übernommen wird;
 * nicht bei jeder Tastatureingabe im Namensfeld. Nie während einer Berechnung (Palette gesperrt).
 * Steindetail, PDF und CSV lösen automatische Namen zusätzlich selbst in der Sprache auf (paletteDisplayName).
 */
export function useLocalizedPaletteNames(api: ProjectApi): void {
  const { lang } = useI18n();
  const palette = api.rec?.palette;
  const ref = useRef(palette);
  ref.current = palette;
  useEffect(() => {
    const cur = ref.current;
    if (!api.loaded || api.paletteLocked || !cur || !cur.length) return;
    const next = normalizePaletteNames(cur, lang);
    if (next !== cur) api.setPalette(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang, api.loaded, api.paletteLocked, api.computed?.data, api.rec?.meta.id, api.rec?.mosaicRev]);
}

/** „Angefordert N – verwendet M …“ aus den Kennzahlen der letzten Berechnung (null bei älteren Ergebnissen). */
export function colorCountNotice(d: ComputeDiagnostics | undefined, t: TFunc): { text: string; warn: boolean } | null {
  if (!d || d.requestedColors === undefined || d.usedColors === undefined || !d.paletteMode) return null;
  const req = d.requestedColors;
  const used = d.usedColors;
  const parts: string[] = [];
  let warn = false;
  if (d.paletteMode === 'auto') {
    parts.push(t('w2ch.count.auto', { req, used }));
    if (d.imageColors !== undefined && d.imageColors < req) parts.push(t('w2ch.count.fewerImage', { n: d.imageColors }));
    const noStones = (d.imageColors ?? req) - used;
    if (noStones > 0) parts.push(tCount(t, 'w2ch.count.noStones', noStones, { n: noStones }));
  } else if (d.paletteMode === 'auto-snap') {
    const merged = d.mergedColors ?? 0;
    parts.push(t('w2ch.count.snap', { req, used, merged }));
    const noStones = (d.imageColors ?? req) - merged - used;
    if (noStones > 0) parts.push(tCount(t, 'w2ch.count.noStones', noStones, { n: noStones }));
    if (used < req) {
      parts.push(t('w2ch.count.snapMore'));
      warn = true;
    }
  } else if (d.paletteMode === 'materials') parts.push(t('w2ch.count.materials', { req, used }));
  else parts.push(t('w2ch.count.custom', { req, used }));
  return { text: parts.join(' '), warn };
}

export function StepColors({ api, materials }: { api: ProjectApi; materials: Material[] }) {
  const { t } = useI18n();
  const s = api.rec!.settings;
  const usesMaterials = s.paletteMode === 'materials' || s.paletteMode === 'auto-snap';
  const locked = api.paletteLocked;
  const nonDefault = s.deltaE !== '2000' || s.dither > 0;
  // „Erweitert“ ist geöffnet, wenn dort etwas vom Standard abweicht – danach entscheidet der Benutzer
  const [advOpen, setAdvOpen] = useState(nonDefault);
  return (
    <div>
      {locked && (
        <div className="w1mc-notice w1fx-locked" role="status" data-testid="palette-locked">
          <span>{t('colors.locked')}</span>
        </div>
      )}
      {/* Während einer Berechnung gesperrt: das Ergebnis bestimmt, worauf die Farbindizes zeigen */}
      <fieldset className="w1fx-fieldset" disabled={locked}>
        <Field label={t('colors.mode')} hint={t(`colors.mode.${s.paletteMode}.hint`)}>
          <Segmented
            value={s.paletteMode}
            testId="palette-mode"
            options={[
              { value: 'auto', label: t('colors.mode.auto') },
              { value: 'auto-snap', label: t('colors.mode.auto-snap') },
              { value: 'materials', label: t('colors.mode.materials') },
              { value: 'custom', label: t('colors.mode.custom') },
            ]}
            onChange={(v) => api.setSettings({ paletteMode: v })}
          />
        </Field>
      </fieldset>
      {(s.paletteMode === 'auto' || s.paletteMode === 'auto-snap') && (
        <Field label={t('colors.count')}>
          <div className="btn-row wrap" data-testid="color-counts">
            {COLOR_COUNTS.map((c) => (
              <button key={c} className={`btn chip ${s.colorCount === c ? 'primary' : ''}`} onClick={() => api.setSettings({ colorCount: c })}>
                {c}
              </button>
            ))}
            <NumberInput value={s.colorCount} onChange={(v) => api.setSettings({ colorCount: Math.round(v) })} min={2} max={256} width={60} label={t('colors.count')} />
          </div>
        </Field>
      )}
      {usesMaterials && (
        <Field label={t('colors.materials')}>
          {materials.length === 0 ? (
            <Badge kind="warn">{t('colors.noMaterials')}</Badge>
          ) : (
            <div className="mat-select">
              <button className="btn small" onClick={() => api.setSettings({ materialIds: [] })}>
                {t('colors.allMaterials')} ({materials.length})
              </button>
              {materials.map((m) => {
                const on = s.materialIds.length === 0 || s.materialIds.includes(m.id);
                return (
                  <label key={m.id} className="mat-chip">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        const cur = s.materialIds.length === 0 ? materials.map((x) => x.id) : s.materialIds;
                        const next = on ? cur.filter((x) => x !== m.id) : [...cur, m.id];
                        api.setSettings({ materialIds: next.length === materials.length ? [] : next });
                      }}
                    />
                    <Swatch hex={isValidHex(m.hex) ? m.hex : '#000'} size={14} /> {m.colorNumber || m.colorName} <small className="muted">{m.manufacturer}</small>
                  </label>
                );
              })}
            </div>
          )}
        </Field>
      )}
      <details className="advanced w2ch-advanced" open={advOpen} onToggle={(e) => setAdvOpen((e.currentTarget as HTMLDetailsElement).open)} data-testid="colors-advanced">
        <summary>
          <span className="w2ch-adv-title">{t('w2ch.advanced')}</span>
          <span className="w2ch-adv-values" data-testid="colors-advanced-summary">
            {t('colors.deltaE')}: {s.deltaE === '76' ? 'CIE76' : 'CIEDE2000'} · {t('colors.dither')}: {Math.round(s.dither * 100)} %
          </span>
          {nonDefault && <Badge kind="warn">{t('w2ch.advancedChanged')}</Badge>}
        </summary>
        <div className="two-col">
          <div>
            <Field label={t('colors.deltaE')} hint={t('w2ch.deltaEHint')}>
              <Segmented value={s.deltaE} testId="deltae-mode" options={[{ value: '2000', label: 'CIEDE2000' }, { value: '76', label: 'CIE76' }]} onChange={(v) => api.setSettings({ deltaE: v })} />
            </Field>
          </div>
          <div>
            <Slider label={t('colors.dither')} value={Math.round(s.dither * 100)} min={0} max={100} onChange={(v) => api.setSettings({ dither: v / 100 })} format={(v) => `${v} %`} />
            <small className="muted">{t('colors.ditherHint')}</small>
          </div>
        </div>
      </details>
      <fieldset className="w1fx-fieldset" disabled={locked} data-testid="palette-fieldset">
        <PaletteEditor api={api} materials={materials} />
      </fieldset>
    </div>
  );
}

const codeStr = (c: number) => String(c).padStart(2, '0');

/**
 * Namensfeld der Palette: bricht lange Namen um und wächst in der Höhe mit, statt sie abzuschneiden – der Zusatz
 * („Hautton dunkel 2“, „Karminrot (dunkel)“), der gleichnamige Farben unterscheidet, bleibt so auch auf dem Handy
 * sichtbar. Ein Name ist einzeilig: Enter beendet die Eingabe, Zeilenumbrüche werden zu Leerzeichen.
 */
function NameField({ onValue, value, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'> & { value: string; onValue: (v: string) => void; 'data-testid'?: string; 'data-auto'?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  };
  useLayoutEffect(fit, [value]);
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return (
    <textarea
      {...rest}
      ref={ref}
      rows={1}
      className="text w2ch-name"
      value={value}
      onChange={(e) => onValue(e.target.value.replace(/\s*[\r\n]+\s*/g, ' '))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** Farbfeld + Nummer + Name, z. B. „■ 09 Hellblau“. */
function ColorChip({ code, hex, name }: { code: number; hex: string; name: string }) {
  return (
    <span className="w1mc-chip">
      <Swatch hex={hex} size={16} />
      <b>{codeStr(code)}</b>
      <span>{name}</span>
    </span>
  );
}

/** Zustand, auf den sich ein geöffneter Dialog bezieht – ändert er sich, wird nicht blind angewendet. */
interface Snapshot {
  palette: PaletteColor[];
  data: MosaicData | null;
  version: number;
}

type MergeDialog = { kind: 'merge'; plan: MaterialMergePlan; snap: Snapshot } | { kind: 'replace'; next: PaletteColor[]; snap: Snapshot };

export function PaletteEditor({ api, materials }: { api: ProjectApi; materials: Material[] }) {
  const { t, n, lang } = useI18n();
  const rec = api.rec!;
  const palette = rec.palette;
  const formula = rec.settings.deltaE;
  const mode = rec.settings.paletteMode;
  const [newHex, setNewHex] = useState('#3366CC');
  const [removing, setRemoving] = useState<{ plan: RemovalPlan; target: number; snap: Snapshot } | null>(null);
  const [merging, setMerging] = useState<MergeDialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stats = api.stats;
  // Statistik passt nur zur Palette, wenn sie für genau diese Farben berechnet wurde
  const statsOk = !!stats && stats.perColor.length === palette.length;
  const usedCount = statsOk ? stats.perColor.filter((c) => c.pieces > 0).length : null;
  const custom = mode === 'custom';
  const snapMode = mode === 'auto-snap' || mode === 'materials';
  const editable = custom || !!api.computed;
  const matById = new Map(materials.map((m) => [m.id, m]));
  const dn = (p: PaletteColor) => paletteDisplayName(p, lang);
  const counts = api.computed ? colorCountNotice(rec.diagnostics, t) : null;
  // ΔE-Formel, mit der die Abweichung je Farbe gemessen wurde (die der Berechnung, nicht die eingestellte).
  // Die Einstufung „> 5 deutlich“ (rot) gilt nur für CIEDE2000 – wie die Einstufung in Schritt 7.
  const resultDE = computedDeltaE(rec.computedWith) ?? (api.stale ? null : rec.settings.deltaE);
  const deLabel = resultDE === '76' ? 'ΔE76' : resultDE === '2000' ? 'ΔE00' : 'ΔE';
  const rateMatch = resultDE === '2000';

  const snapNow = (): Snapshot => ({ palette, data: api.computed?.data ?? null, version: api.version });
  const unchangedSince = (s: Snapshot) => s.palette === palette && s.data === (api.computed?.data ?? null) && s.version === api.version;
  const removingOk = !!removing && unchangedSince(removing.snap);
  const mergingOk = !!merging && unchangedSince(merging.snap);

  // Ändern sich Palette oder Raster, während ein Dialog offen ist (Ergebnis einer Hintergrundberechnung,
  // anderer Tab), passt sein Plan nicht mehr: schließen und Bescheid geben – nie mit veralteten Indizes
  // weiterzeichnen. Ebenso, sobald eine Berechnung beginnt (Palette gesperrt).
  useEffect(() => {
    if (removing && (!removingOk || api.paletteLocked)) {
      setRemoving(null);
      setNotice(t(api.paletteLocked ? 'colors.locked' : 'colors.rm.changed'));
    }
    if (merging && (!mergingOk || api.paletteLocked)) {
      setMerging(null);
      setNotice(t(api.paletteLocked ? 'colors.locked' : 'colors.rm.changed'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette, api.computed?.data, api.version, api.paletteLocked]);

  // ---------- Farbe entfernen: erst Dialog (betroffene Steine, Ersatzfarbe wählbar), dann ausführen
  const askRemove = (i: number) => {
    if (palette.length <= 1) return;
    setNotice(null);
    const plan = planColorRemoval(palette, api.computed?.data ?? null, i, formula);
    setRemoving({ plan, target: plan.options[0].index, snap: snapNow() });
  };

  const doRemove = () => {
    if (!removing) return;
    if (!unchangedSince(removing.snap)) {
      setRemoving(null);
      setNotice(t('colors.rm.changed'));
      return;
    }
    const { plan, target } = removing;
    const p = palette[plan.index];
    const tp = palette[target];
    if (!p || !tp) {
      setRemoving(null);
      setNotice(t('colors.rm.changed'));
      return;
    }
    // Namen der verbleibenden Farben wieder eindeutig und so kurz wie möglich (z. B. „Rot (hell)“ → „Rot“)
    const next = normalizePaletteNames(api.computed ? removePaletteColor(palette, api.computed.data, plan.index, target, formula) : palette.filter((_, k) => k !== plan.index), lang);
    api.setPalette(next);
    if (api.computed) api.touchMosaic();
    const tpNow = next[target > plan.index ? target - 1 : target] ?? tp;
    setNotice(
      (api.computed && plan.pieces > 0
        ? tCount(t, 'colors.rm.done', plan.pieces, { code: codeStr(p.code), n: n(plan.pieces), target: `${codeStr(tpNow.code)} ${dn(tpNow)}` })
        : t('colors.rm.doneNoStones', { code: codeStr(p.code) })) + (api.computed && !custom ? ` ${t(mode === 'materials' ? 'colors.rm.noteMaterials' : 'colors.rm.noteAuto', { code: codeStr(p.code) })}` : ''),
    );
    setRemoving(null);
  };

  // ---------- Palette aus Materialien: nach einer Berechnung zusammenführen (Indizes/Nummern bleiben), sonst ersetzen
  const openMerge = () => {
    setNotice(null);
    if (api.computed) {
      setMerging({ kind: 'merge', plan: planMaterialMerge(palette, api.computed.data, materials, formula, lang), snap: snapNow() });
      return;
    }
    let p: PaletteColor[] = [];
    for (const m of materials) if (isValidHex(m.hex)) p = addPaletteColor(p, m.hex, m.colorName || m.colorNumber, lang, m.id);
    if (!p.length) {
      setNotice(t('colors.merge.noValid'));
      return;
    }
    if (palette.length === 0) {
      api.setPalette(p);
      setNotice(tCount(t, 'colors.merge.replaced', p.length, { n: p.length }));
      return;
    }
    setMerging({ kind: 'replace', next: p, snap: snapNow() });
  };

  const applyMerge = () => {
    if (!merging) return;
    if (!unchangedSince(merging.snap)) {
      setMerging(null);
      setNotice(t('colors.rm.changed'));
      return;
    }
    if (merging.kind === 'replace') {
      api.setPalette(merging.next);
      setNotice(tCount(t, 'colors.merge.replaced', merging.next.length, { n: merging.next.length }));
    } else if (api.computed && !merging.plan.unchanged && !merging.plan.noValidMaterials) {
      const plan = merging.plan;
      const next = applyMaterialMerge(plan, api.computed.data, formula);
      api.setPalette(normalizePaletteNames(next, lang));
      api.touchMosaic();
      setNotice(t('colors.merge.done', { added: plan.added.length, removed: plan.removed.length, n: n(plan.movedStones), de: n(plan.maxDeltaE, 1) }));
    }
    setMerging(null);
  };

  const matchAll = (adoptColor: boolean) => {
    let next = palette;
    palette.forEach((p, i) => {
      const nm = nearestMaterial(p, materials);
      // Farbe übernehmen: Name des Materials, falls vorhanden – sonst bleibt ein automatischer Name automatisch
      if (nm) next = updatePaletteColor(next, i, { materialId: nm.m.id, ...(adoptColor ? { hex: nm.m.hex, ...(nm.m.colorName ? { name: nm.m.colorName } : {}) } : {}) }, lang);
    });
    api.setPalette(next);
  };

  const anyMatch = palette.some((p) => !!p.matchDeltaE);

  return (
    <div className="palette-editor">
      <div className="row-between">
        <h3>
          {t('colors.palette')} ({palette.length})
          {usedCount !== null && usedCount < palette.length && (
            <small className="muted w1mc-count" data-testid="palette-used-count">
              {t('colors.usedOf', { used: usedCount, total: palette.length })}
            </small>
          )}
        </h3>
        <div className="btn-row wrap">
          {materials.length > 0 && palette.length > 0 && (
            <>
              <button className="btn small" onClick={() => matchAll(false)}>
                {t('colors.linkMaterials')}
              </button>
              <button className="btn small" onClick={() => matchAll(true)}>
                {t('colors.adoptMaterials')}
              </button>
            </>
          )}
          {custom && materials.length > 0 && (
            <button className="btn small" onClick={openMerge} data-testid="palette-from-materials">
              {t('colors.fromMaterials')}
            </button>
          )}
        </div>
      </div>
      {counts && (
        <p className={`w2ch-counts ${counts.warn ? 'warn-box' : ''}`} data-testid="palette-counts">
          {counts.text}
        </p>
      )}
      {notice && (
        <div className="w1mc-notice" role="status" data-testid="palette-notice">
          <span>{notice}</span>
          <button className="icon-btn" onClick={() => setNotice(null)} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
      )}
      {!editable && <p className="muted">{t('colors.afterCompute')}</p>}
      {editable && (
        <>
          <div className="table-wrap">
            <table className="data w2ch-palette" data-testid="palette-table">
              <thead>
                <tr>
                  <th className="w2ch-sticky">{t('colors.code')}</th>
                  <th>{t('colors.name')}</th>
                  <th className="num">{t('colors.stones')}</th>
                  <th className="num">{t('colors.need')}</th>
                  <th>{t('colors.material')}</th>
                  <th>{t('w2ch.hexLab')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {palette.map((p, i) => {
                  const cs = statsOk ? stats.perColor[i] : undefined;
                  const unused = !!cs && cs.pieces === 0;
                  const m = p.materialId ? matById.get(p.materialId) : undefined;
                  const missing = !!p.materialId && !m;
                  const dm = m && isValidHex(m.hex) ? (() => {
                    const l = hexToLab(m.hex);
                    return deltaE2000(p.lab[0], p.lab[1], p.lab[2], l[0], l[1], l[2]);
                  })() : null;
                  const match = matchDeltaEValid(p, cs?.pieces, api.manualEdits);
                  const name = dn(p);
                  return (
                    <tr key={`${p.code}-${i}`} className={unused ? 'w1mc-unused' : undefined} data-unused={unused ? 'true' : undefined} data-code={codeStr(p.code)}>
                      <td className="w2ch-sticky" data-col="code">
                        <span className="w2ch-code">
                          <b>{codeStr(p.code)}</b>
                          <input type="color" value={p.hex.length === 7 ? p.hex.toLowerCase() : '#000000'} onChange={(e) => api.setPalette(updatePaletteColor(palette, i, { hex: e.target.value }, lang))} aria-label={`${t('colors.swatch')} ${codeStr(p.code)}`} />
                        </span>
                      </td>
                      <td data-col="name">
                        <NameField
                          value={name}
                          placeholder={t('w2ch.namePlaceholder')}
                          title={p.nameKey ? `${name} – ${t('w2ch.autoName')}` : name}
                          data-testid="palette-name"
                          data-auto={p.nameKey ? 'true' : undefined}
                          aria-label={`${t('colors.name')} ${codeStr(p.code)}`}
                          onValue={(v) => api.setPalette(updatePaletteColor(palette, i, { name: v }, lang))}
                          onBlur={(e) => {
                            if (!e.target.value.trim()) api.setPalette(resetAutoName(palette, i, lang));
                          }}
                        />
                      </td>
                      <td className="num" data-col="stones">
                        {cs ? n(cs.pieces) : '–'}
                        {unused && <span className="w1mc-tag">{t('colors.unused')}</span>}
                        {/* Abweichung vom Foto: nur solange sie zu den aktuellen Steinen passt, sonst ehrlich „ΔE –“ */}
                        {cs && cs.pieces > 0 && anyMatch && (
                          match ? (
                            <span
                              className={`w2ch-de ${rateMatch && match.mean > 5 ? 'bad' : ''}`}
                              data-testid="palette-match"
                              data-formula={resultDE ?? undefined}
                              title={t('w2ch.matchTitle', { de: deLabel, n: n(match.pieces), mean: n(match.mean, 1), max: n(match.max, 1), over5: n(match.over5), over10: n(match.over10) })}
                            >
                              {t('w2ch.match', { de: deLabel, mean: n(match.mean, 1) })}
                              <span className="w2ch-max"> · {t('w2ch.matchMax', { max: n(match.max, 0) })}</span>
                              {match.over5 > 0 && <span className="w2ch-over"> · {t('w2ch.over5', { n: n(match.over5) })}</span>}
                            </span>
                          ) : (
                            <span className="w2ch-de stale" data-testid="palette-match-stale" title={t('w2ch.matchStaleTitle')}>
                              {t('w2ch.matchStale')}
                            </span>
                          )
                        )}
                      </td>
                      {/* Math.max: computeStats liefert für Farben ohne Steine ceil(−1e−9) = −0 */}
                      <td className="num small" data-col="need">
                        {cs ? (
                          <>
                            {n(Math.max(0, cs.rawWithReserve))} <span className="w2ch-unit">{t('colors.rawShort')}</span>
                          </>
                        ) : (
                          '–'
                        )}
                      </td>
                      <td data-col="material" className="w2ch-mat">
                        <select
                          value={p.materialId ?? ''}
                          onChange={(e) => api.setPalette(updatePaletteColor(palette, i, { materialId: e.target.value || undefined }, lang))}
                          aria-label={`${t('colors.material')} ${codeStr(p.code)}`}
                          className={missing ? 'w2ch-missing' : undefined}
                        >
                          <option value="">–</option>
                          {/* Verknüpftes Material nicht mehr vorhanden: sichtbar machen statt still „–“ anzuzeigen */}
                          {missing && (
                            <option value={p.materialId} disabled>
                              {t('w2ch.materialMissing')}
                            </option>
                          )}
                          {materials.map((mm) => (
                            <option key={mm.id} value={mm.id}>
                              {mm.manufacturer} {mm.colorNumber} {mm.colorName}
                            </option>
                          ))}
                        </select>
                        {missing && (
                          <span className="badge badge-warn w2ch-missing-badge" data-testid="palette-material-missing" title={t('w2ch.materialMissingTitle')}>
                            {t('w2ch.materialMissing')}
                          </span>
                        )}
                        {/* In den Materialmodi ist die Palettenfarbe die Materialfarbe (ΔE 0) – nur eine echte Abweichung zeigen */}
                        {dm !== null && (!snapMode || dm >= 0.5) && <small className={`w2ch-mat-de ${dm > 5 ? 'warn' : 'muted'}`}>{snapMode ? t('w2ch.materialDE', { de: n(dm, 1) }) : `ΔE ${n(dm, 1)}`}</small>}
                        {p.mergedFrom !== undefined && p.mergedFrom > 1 && (
                          <small className="w2ch-mat-de muted" data-testid="palette-merged" title={t('w2ch.mergedFromTitle', { n: p.mergedFrom })}>
                            {t('w2ch.mergedFrom', { n: p.mergedFrom })}
                          </small>
                        )}
                      </td>
                      <td className="mono small w2ch-hexlab" data-col="hexlab">
                        {p.hex} · L {n(p.lab[0], 1)} a {n(p.lab[1], 1)} b {n(p.lab[2], 1)}
                      </td>
                      <td>
                        <button className="icon-btn" title={t('common.remove')} aria-label={`${t('common.remove')} ${codeStr(p.code)}`} onClick={() => askRemove(i)} disabled={palette.length <= 1} data-testid="palette-remove">
                          🗑
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {anyMatch && (
            <p className="muted small" data-testid="palette-match-hint">
              {t('w2ch.matchHint')} {rateMatch ? t('w2ch.matchScale') : resultDE === '76' ? t('w2ch.matchNoScale') : ''}
            </p>
          )}
          <div className="btn-row">
            <input type="color" value={newHex} onChange={(e) => setNewHex(e.target.value)} aria-label={t('colors.newColor')} />
            <button className="btn" onClick={() => api.setPalette(addPaletteColor(palette, newHex, undefined, lang))}>
              + {t('colors.add')}
            </button>
            {!custom && api.computed && <small className="muted">{t('colors.addHint')}</small>}
          </div>
          {api.computed && <p className="muted small">{t('colors.removeHint')}</p>}
          {api.computed && !custom && (
            <p className="muted small" data-testid="palette-recompute-caveat">
              {t(mode === 'materials' ? 'colors.removeHintMaterials' : 'colors.removeHintAuto')}
            </p>
          )}
        </>
      )}

      {/* Nur anzeigen, solange der Plan zum aktuellen Stand passt (sonst schließt der Effekt oben den Dialog) */}
      {removing && removingOk && (
        <RemoveDialog
          palette={palette}
          plan={removing.plan}
          target={removing.target}
          computed={!!api.computed}
          mode={mode}
          onTarget={(target) => setRemoving({ ...removing, target })}
          onCancel={() => setRemoving(null)}
          onConfirm={doRemove}
        />
      )}
      {merging && mergingOk && <MergeDialogView dialog={merging} oldCount={palette.length} onCancel={() => setMerging(null)} onApply={applyMerge} />}
    </div>
  );
}

function RemoveDialog(props: {
  palette: PaletteColor[];
  plan: RemovalPlan;
  target: number;
  computed: boolean;
  mode: PaletteMode;
  onTarget: (i: number) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t, n, lang } = useI18n();
  const { palette, plan, target } = props;
  const dn = (c: PaletteColor) => paletteDisplayName(c, lang);
  const p = palette[plan.index];
  const tp = palette[target];
  // Schutz: passt der Plan nicht mehr zur Palette, nichts zeichnen (der Aufrufer schließt den Dialog)
  if (!p || !tp || plan.options.some((o) => !palette[o.index])) return null;
  const opt = plan.options.find((o) => o.index === target);
  const showChoice = props.computed && plan.pieces > 0;
  // Nur bei eigener Palette bleibt eine Entfernung beim Neuberechnen erhalten
  const noteKey = props.mode === 'custom' ? 'colors.rm.note' : props.mode === 'materials' ? 'colors.rm.noteMaterials' : 'colors.rm.noteAuto';
  return (
    <Modal
      title={t('colors.rm.title', { code: codeStr(p.code), name: dn(p) })}
      onClose={props.onCancel}
      footer={
        <>
          <button className="btn" onClick={props.onCancel}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" onClick={props.onConfirm} data-testid="palette-remove-confirm">
            {t('colors.rm.confirm')}
          </button>
        </>
      }
    >
      <div className="w1mc-dialog" data-testid="palette-remove-dialog">
        {!props.computed && <p>{t('colors.rm.notComputed')}</p>}
        {props.computed && plan.pieces === 0 && <p>{t('colors.rm.noStones')}</p>}
        {showChoice && (
          <>
            <p data-testid="palette-remove-stones">{tCount(t, 'colors.rm.stones', plan.pieces, { n: n(plan.pieces) })}</p>
            <div className="w1mc-swap" data-testid="palette-remove-swap">
              <ColorChip code={p.code} hex={p.hex} name={dn(p)} />
              <span className="w1mc-arrow" aria-hidden="true">
                →
              </span>
              <ColorChip code={tp.code} hex={tp.hex} name={dn(tp)} />
              {opt && <span className="w1mc-de">ΔE {n(opt.deltaE, 1)}</span>}
            </div>
            <label className="w1mc-select">
              {t('colors.rm.replacement')}
              <select value={target} onChange={(e) => props.onTarget(Number(e.target.value))} data-testid="palette-remove-target">
                {plan.options.map((o, k) => (
                  <option key={o.index} value={o.index}>
                    {codeStr(palette[o.index].code)} {dn(palette[o.index])} – ΔE {n(o.deltaE, 1)}
                    {k === 0 ? ` (${t('colors.rm.nearest')})` : ''}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {props.computed && (
          <p className="muted small" data-testid="palette-remove-note">
            {t(noteKey, { code: codeStr(p.code) })}
          </p>
        )}
      </div>
    </Modal>
  );
}

function MergeDialogView({ dialog, oldCount, onCancel, onApply }: { dialog: MergeDialog; oldCount: number; onCancel: () => void; onApply: () => void }) {
  const { t, n } = useI18n();
  const plan = dialog.kind === 'merge' ? dialog.plan : null;
  const nothingToDo = !!plan && (plan.unchanged || plan.noValidMaterials);
  return (
    <Modal
      title={t('colors.merge.title')}
      onClose={onCancel}
      footer={
        nothingToDo ? (
          <button className="btn" onClick={onCancel}>
            {t('common.close')}
          </button>
        ) : (
          <>
            <button className="btn" onClick={onCancel}>
              {t('common.cancel')}
            </button>
            <button className="btn primary" onClick={onApply} data-testid="palette-merge-apply">
              {t('colors.merge.apply')}
            </button>
          </>
        )
      }
    >
      <div className="w1mc-dialog" data-testid="palette-merge-dialog">
        {dialog.kind === 'replace' && <p>{t('colors.merge.replaceInfo', { n: dialog.next.length, last: codeStr(dialog.next.length), old: oldCount })}</p>}
        {plan && plan.noValidMaterials && <p>{t('colors.merge.noValid')}</p>}
        {plan && plan.unchanged && <p className="w1mc-summary ok">{t('colors.merge.unchanged')}</p>}
        {plan && !nothingToDo && (
          <>
            <p className="muted small">{t('colors.merge.intro')}</p>
            <div className={`w1mc-summary ${plan.movedStones > 0 ? '' : 'ok'}`} data-testid="palette-merge-summary">
              {plan.movedStones > 0 ? tCount(t, 'colors.merge.moved', plan.movedStones, { n: n(plan.movedStones), de: n(plan.maxDeltaE, 1) }) : t('colors.merge.movedNone')}
            </div>
            {plan.removed.length > 0 && (
              <>
                <p>{tCount(t, 'colors.merge.removed', plan.removed.length, { n: plan.removed.length })}</p>
                <ul className="w1mc-list" data-testid="palette-merge-removed">
                  {plan.removed.map((r) => (
                    <li key={r.code}>
                      <ColorChip code={r.code} hex={r.hex} name={r.name} />
                      <span className="w1mc-arrow" aria-hidden="true">
                        →
                      </span>
                      <ColorChip code={r.targetCode} hex={r.targetHex} name={r.targetName} />
                      <span className="w1mc-meta">
                        {t('colors.stones')}: {n(r.pieces)} · ΔE {n(r.deltaE, 1)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {plan.added.length > 0 && (
              <>
                <p>{tCount(t, 'colors.merge.added', plan.added.length, { n: plan.added.length })}</p>
                <div className="w1mc-added">
                  {plan.added.map((a) => (
                    <ColorChip key={a.code} code={a.code} hex={a.hex} name={a.name} />
                  ))}
                </div>
              </>
            )}
            {plan.linked > 0 && <p>{tCount(t, 'colors.merge.linked', plan.linked, { n: plan.linked })}</p>}
            {plan.recolored.length > 0 && (
              <p>
                {tCount(t, 'colors.merge.recolored', plan.recolored.length, {
                  n: plan.recolored.length,
                  stones: n(plan.recolored.reduce((s, r) => s + r.pieces, 0)),
                  de: n(Math.max(...plan.recolored.map((r) => r.deltaE)), 1),
                })}
              </p>
            )}
            <p className="muted small">{t('colors.merge.recompute')}</p>
          </>
        )}
      </div>
    </Modal>
  );
}
