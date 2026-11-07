import { useState } from 'react';
import { deltaE2000, hexToLab, isValidHex } from '../../core/color';
import { addPaletteColor, removePaletteColor, updatePaletteColor } from '../../core/edits';
import type { Material, PaletteColor } from '../../core/types';
import { useI18n } from '../../i18n';
import { Badge, Field, NumberInput, Segmented, Slider, Swatch } from '../components';
import type { ProjectApi } from './useProject';

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

export function StepColors({ api, materials }: { api: ProjectApi; materials: Material[] }) {
  const { t } = useI18n();
  const s = api.rec!.settings;
  const usesMaterials = s.paletteMode === 'materials' || s.paletteMode === 'auto-snap';
  return (
    <div>
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
      <div className="two-col">
        <div>
          <Field label={t('colors.deltaE')}>
            <Segmented value={s.deltaE} options={[{ value: '2000', label: 'CIEDE2000' }, { value: '76', label: 'CIE76' }]} onChange={(v) => api.setSettings({ deltaE: v })} />
          </Field>
        </div>
        <div>
          <Slider label={t('colors.dither')} value={Math.round(s.dither * 100)} min={0} max={100} onChange={(v) => api.setSettings({ dither: v / 100 })} format={(v) => `${v} %`} />
          <small className="muted">{t('colors.ditherHint')}</small>
        </div>
      </div>
      <PaletteEditor api={api} materials={materials} />
    </div>
  );
}

export function PaletteEditor({ api, materials }: { api: ProjectApi; materials: Material[] }) {
  const { t, n, lang } = useI18n();
  const rec = api.rec!;
  const palette = rec.palette;
  const [newHex, setNewHex] = useState('#3366CC');
  const stats = api.stats;
  const custom = rec.settings.paletteMode === 'custom';
  const editable = custom || !!api.computed;
  const matById = new Map(materials.map((m) => [m.id, m]));

  const remove = (i: number) => {
    if (palette.length <= 1) return;
    if (api.computed) {
      const next = removePaletteColor(palette, api.computed.data, i, undefined, rec.settings.deltaE);
      api.setPalette(next);
      api.touchMosaic();
    } else api.setPalette(palette.filter((_, k) => k !== i));
  };

  const matchAll = (adoptColor: boolean) => {
    let next = palette;
    palette.forEach((p, i) => {
      const nm = nearestMaterial(p, materials);
      if (nm) next = updatePaletteColor(next, i, { materialId: nm.m.id, ...(adoptColor ? { hex: nm.m.hex, name: nm.m.colorName || p.name } : {}) });
    });
    api.setPalette(next);
  };

  return (
    <div className="palette-editor">
      <div className="row-between">
        <h3>
          {t('colors.palette')} ({palette.length})
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
            <button
              className="btn small"
              onClick={() => {
                let p: PaletteColor[] = [];
                for (const m of materials) if (isValidHex(m.hex)) p = addPaletteColor(p, m.hex, m.colorName || m.colorNumber, lang, m.id);
                api.setPalette(p);
              }}
            >
              {t('colors.fromMaterials')}
            </button>
          )}
        </div>
      </div>
      {!editable && <p className="muted">{t('colors.afterCompute')}</p>}
      {editable && (
        <>
          <div className="table-wrap">
            <table className="data" data-testid="palette-table">
              <thead>
                <tr>
                  <th>{t('colors.code')}</th>
                  <th>{t('colors.swatch')}</th>
                  <th>{t('colors.name')}</th>
                  <th>HEX</th>
                  <th>CIELAB</th>
                  <th className="num">{t('colors.stones')}</th>
                  <th className="num">{t('colors.need')}</th>
                  <th>{t('colors.material')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {palette.map((p, i) => {
                  const cs = stats?.perColor[i];
                  const m = p.materialId ? matById.get(p.materialId) : undefined;
                  const dm = m && isValidHex(m.hex) ? (() => {
                    const l = hexToLab(m.hex);
                    return deltaE2000(p.lab[0], p.lab[1], p.lab[2], l[0], l[1], l[2]);
                  })() : null;
                  return (
                    <tr key={`${p.code}-${i}`}>
                      <td>
                        <b>{String(p.code).padStart(2, '0')}</b>
                      </td>
                      <td>
                        <input type="color" value={p.hex.length === 7 ? p.hex.toLowerCase() : '#000000'} onChange={(e) => api.setPalette(updatePaletteColor(palette, i, { hex: e.target.value }))} aria-label={t('colors.swatch')} />
                      </td>
                      <td>
                        <input className="text" value={p.name} onChange={(e) => api.setPalette(updatePaletteColor(palette, i, { name: e.target.value }))} />
                      </td>
                      <td className="mono">{p.hex}</td>
                      <td className="mono small">
                        {n(p.lab[0], 1)} / {n(p.lab[1], 1)} / {n(p.lab[2], 1)}
                      </td>
                      <td className="num">{cs ? n(cs.pieces) : '–'}</td>
                      <td className="num small">{cs ? `${n(cs.rawWithReserve)} ${t('colors.rawShort')}` : '–'}</td>
                      <td>
                        <select value={p.materialId ?? ''} onChange={(e) => api.setPalette(updatePaletteColor(palette, i, { materialId: e.target.value || undefined }))}>
                          <option value="">–</option>
                          {materials.map((mm) => (
                            <option key={mm.id} value={mm.id}>
                              {mm.manufacturer} {mm.colorNumber} {mm.colorName}
                            </option>
                          ))}
                        </select>
                        {dm !== null && <small className={dm > 5 ? 'warn' : 'muted'}> ΔE {n(dm, 1)}</small>}
                      </td>
                      <td>
                        <button className="icon-btn" title={t('common.remove')} onClick={() => remove(i)} disabled={palette.length <= 1}>
                          🗑
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="btn-row">
            <input type="color" value={newHex} onChange={(e) => setNewHex(e.target.value)} aria-label={t('colors.newColor')} />
            <button className="btn" onClick={() => api.setPalette(addPaletteColor(palette, newHex, undefined, lang))}>
              + {t('colors.add')}
            </button>
            {!custom && api.computed && <small className="muted">{t('colors.addHint')}</small>}
          </div>
          {api.computed && <p className="muted small">{t('colors.removeHint')}</p>}
        </>
      )}
    </div>
  );
}
