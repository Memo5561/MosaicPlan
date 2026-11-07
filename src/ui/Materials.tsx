import { useRef, useState } from 'react';
import { hexToLab, isValidHex } from '../core/color';
import type { Material } from '../core/types';
import { useI18n } from '../i18n';
import { deleteMaterial, saveMaterial, uid } from '../storage/db';
import { downloadBlob, Field, Modal, NumberInput, Swatch } from './components';

const EMPTY: Omit<Material, 'id'> = {
  type: 'glass',
  manufacturer: '',
  product: '',
  colorNumber: '',
  colorName: '',
  hex: '#808080',
  lengthMm: 10,
  widthMm: 10,
  thicknessMm: 4,
  price: 0,
  packageSize: '',
  piecesPerPack: 0,
  stock: undefined,
  notes: '',
};

const CSV_FIELDS: (keyof Material)[] = ['type', 'manufacturer', 'product', 'colorNumber', 'colorName', 'hex', 'lengthMm', 'widthMm', 'thicknessMm', 'price', 'packageSize', 'piecesPerPack', 'stock', 'notes'];

export function materialsToCsv(list: Material[]): string {
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_FIELDS.join(';'), ...list.map((m) => CSV_FIELDS.map((f) => esc(m[f])).join(';'))].join('\r\n');
}

export function parseMaterialsCsv(text: string): Material[] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ';' || ch === ',' || ch === '\t') {
      cur.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      cur.push(field);
      field = '';
      if (cur.some((c) => c.trim() !== '')) rows.push(cur);
      cur = [];
    } else field += ch;
  }
  cur.push(field);
  if (cur.some((c) => c.trim() !== '')) rows.push(cur);
  if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim());
  const num = (s: string) => {
    const v = parseFloat((s ?? '').replace(',', '.'));
    return Number.isFinite(v) ? v : 0;
  };
  const out: Material[] = [];
  for (const r of rows.slice(1)) {
    const get = (f: string) => r[head.indexOf(f)] ?? '';
    const hex = get('hex').trim();
    if (!isValidHex(hex)) continue;
    const type = get('type') as Material['type'];
    out.push({
      id: uid(),
      type: ['glass', 'ceramic', 'smalti', 'stone', 'other'].includes(type) ? type : 'other',
      manufacturer: get('manufacturer'),
      product: get('product'),
      colorNumber: get('colorNumber'),
      colorName: get('colorName'),
      hex: (hex.startsWith('#') ? hex : `#${hex}`).toUpperCase(),
      lengthMm: num(get('lengthMm')),
      widthMm: num(get('widthMm')),
      thicknessMm: num(get('thicknessMm')),
      price: num(get('price')),
      packageSize: get('packageSize'),
      piecesPerPack: Math.round(num(get('piecesPerPack'))),
      stock: get('stock') ? Math.round(num(get('stock'))) : undefined,
      notes: get('notes'),
    });
  }
  return out;
}

export function Materials({ materials, reload }: { materials: Material[]; reload: () => void }) {
  const { t, n } = useI18n();
  const [edit, setEdit] = useState<Material | null>(null);
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const imp = useRef<HTMLInputElement>(null);
  const list = materials.filter((m) => `${m.manufacturer} ${m.product} ${m.colorNumber} ${m.colorName} ${m.hex}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="page">
      <div className="row-between">
        <h1>{t('mats.title')}</h1>
        <div className="btn-row wrap">
          <button className="btn primary" onClick={() => setEdit({ ...EMPTY, id: uid() })} data-testid="add-material">
            + {t('mats.add')}
          </button>
          <button className="btn" onClick={() => imp.current?.click()}>
            {t('mats.importCsv')}
          </button>
          <button className="btn" onClick={() => downloadBlob(new Blob(['﻿', materialsToCsv(materials)], { type: 'text/csv;charset=utf-8' }), 'mosaicplan_materialien.csv')} disabled={!materials.length}>
            {t('mats.exportCsv')}
          </button>
          <input
            ref={imp}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              const items = parseMaterialsCsv(await f.text());
              for (const m of items) await saveMaterial(m);
              setMsg(t('mats.imported', { n: items.length }));
              reload();
            }}
          />
        </div>
      </div>
      <p className="muted small">{t('mats.intro')}</p>
      {msg && <p className="ok">{msg}</p>}
      <input className="text" placeholder={t('common.search')} value={filter} onChange={(e) => setFilter(e.target.value)} />
      {materials.length === 0 ? (
        <p className="muted">{t('mats.empty')}</p>
      ) : (
        <div className="table-wrap">
          <table className="data" data-testid="materials-table">
            <thead>
              <tr>
                <th />
                <th>{t('mats.type')}</th>
                <th>{t('mats.manufacturer')}</th>
                <th>{t('mats.product')}</th>
                <th>{t('mats.colorNumber')}</th>
                <th>{t('mats.colorName')}</th>
                <th>HEX / Lab</th>
                <th>{t('mats.dims')}</th>
                <th className="num">{t('mats.price')}</th>
                <th>{t('mats.pack')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((m) => {
                const lab = isValidHex(m.hex) ? hexToLab(m.hex) : [0, 0, 0];
                return (
                  <tr key={m.id}>
                    <td>
                      <Swatch hex={isValidHex(m.hex) ? m.hex : '#000'} size={24} />
                    </td>
                    <td>{t(`mat.${m.type}`)}</td>
                    <td>{m.manufacturer}</td>
                    <td>{m.product}</td>
                    <td>{m.colorNumber}</td>
                    <td>{m.colorName}</td>
                    <td className="mono small">
                      {m.hex}
                      <br />
                      {n(lab[0], 1)}/{n(lab[1], 1)}/{n(lab[2], 1)}
                    </td>
                    <td className="small">
                      {n(m.lengthMm, 1)} × {n(m.widthMm, 1)} × {n(m.thicknessMm, 1)} mm
                    </td>
                    <td className="num">{m.price ? n(m.price, 2) : '–'}</td>
                    <td className="small">
                      {m.packageSize} {m.piecesPerPack ? `(${n(m.piecesPerPack)} ${t('mats.pcs')})` : ''}
                    </td>
                    <td>
                      <button className="icon-btn" onClick={() => setEdit(m)} aria-label={t('common.edit')}>
                        ✎
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={t('common.delete')}
                        onClick={async () => {
                          if (!confirm(t('mats.deleteConfirm'))) return;
                          await deleteMaterial(m.id);
                          reload();
                        }}
                      >
                        🗑
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {edit && (
        <MaterialForm
          value={edit}
          onClose={() => setEdit(null)}
          onSave={async (m) => {
            await saveMaterial(m);
            setEdit(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function MaterialForm({ value, onClose, onSave }: { value: Material; onClose: () => void; onSave: (m: Material) => void }) {
  const { t } = useI18n();
  const [m, setM] = useState<Material>(value);
  const set = (p: Partial<Material>) => setM((x) => ({ ...x, ...p }));
  const hexOk = isValidHex(m.hex);
  const ED = (globalThis as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
  return (
    <Modal
      title={t('mats.edit')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={!hexOk} onClick={() => onSave({ ...m, hex: (m.hex.startsWith('#') ? m.hex : `#${m.hex}`).toUpperCase() })} data-testid="save-material">
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('mats.type')}>
          <select value={m.type} onChange={(e) => set({ type: e.target.value as Material['type'] })}>
            {(['glass', 'ceramic', 'smalti', 'stone', 'other'] as const).map((x) => (
              <option key={x} value={x}>
                {t(`mat.${x}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('mats.manufacturer')}>
          <input className="text" value={m.manufacturer} onChange={(e) => set({ manufacturer: e.target.value })} data-testid="mat-manufacturer" />
        </Field>
        <Field label={t('mats.product')}>
          <input className="text" value={m.product} onChange={(e) => set({ product: e.target.value })} />
        </Field>
        <Field label={t('mats.colorNumber')}>
          <input className="text" value={m.colorNumber} onChange={(e) => set({ colorNumber: e.target.value })} data-testid="mat-colornumber" />
        </Field>
        <Field label={t('mats.colorName')}>
          <input className="text" value={m.colorName} onChange={(e) => set({ colorName: e.target.value })} />
        </Field>
        <Field label={t('mats.color')} hint={t('mats.colorHint')}>
          <div className="btn-row">
            <input type="color" value={hexOk && m.hex.length === 7 ? m.hex.toLowerCase() : '#808080'} onChange={(e) => set({ hex: e.target.value.toUpperCase() })} />
            <input className={`text mono ${hexOk ? '' : 'invalid'}`} value={m.hex} onChange={(e) => set({ hex: e.target.value })} style={{ width: 100 }} data-testid="mat-hex" />
            {ED && (
              <button
                className="btn small"
                onClick={async () => {
                  try {
                    const r = await new ED().open();
                    set({ hex: r.sRGBHex.toUpperCase() });
                  } catch {
                    /* abgebrochen */
                  }
                }}
              >
                {t('mats.eyedropper')}
              </button>
            )}
          </div>
        </Field>
        <Field label={t('mats.length')}>
          <NumberInput value={m.lengthMm} onChange={(v) => set({ lengthMm: v })} min={0} suffix="mm" />
        </Field>
        <Field label={t('mats.width')}>
          <NumberInput value={m.widthMm} onChange={(v) => set({ widthMm: v })} min={0} suffix="mm" />
        </Field>
        <Field label={t('mats.thickness')}>
          <NumberInput value={m.thicknessMm} onChange={(v) => set({ thicknessMm: v })} min={0} suffix="mm" />
        </Field>
        <Field label={t('mats.price')}>
          <NumberInput value={m.price} onChange={(v) => set({ price: v })} min={0} decimals={2} />
        </Field>
        <Field label={t('mats.packageSize')}>
          <input className="text" value={m.packageSize} onChange={(e) => set({ packageSize: e.target.value })} placeholder={t('mats.packagePlaceholder')} />
        </Field>
        <Field label={t('mats.perPack')}>
          <NumberInput value={m.piecesPerPack} onChange={(v) => set({ piecesPerPack: Math.round(v) })} min={0} />
        </Field>
        <Field label={t('mats.stock')}>
          <NumberInput value={m.stock ?? 0} onChange={(v) => set({ stock: Math.round(v) })} min={0} />
        </Field>
        <Field label={t('mats.notes')}>
          <input className="text" value={m.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
