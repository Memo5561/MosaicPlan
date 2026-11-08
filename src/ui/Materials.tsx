import { useRef, useState, type ReactNode } from 'react';
import { hexToLab, isValidHex } from '../core/color';
import {
  decodeCsvBytes,
  findMaterialUsage,
  materialsCsvTemplate,
  materialsToCsv,
  parseMaterialsCsv,
  planMaterialImport,
  type CsvEncoding,
  type CsvField,
  type CsvSkip,
  type CsvWarning,
  type ImportMode,
  type MaterialImportPlan,
  type MaterialsCsvError,
  type MaterialsCsvOk,
} from '../core/materialsCsv';
import type { Material } from '../core/types';
import { useI18n, type TFunc } from '../i18n';
import { deleteMaterial, listProjects, saveMaterial, uid } from '../storage/db';
import { downloadBlob, Field, Modal, NumberInput, Swatch } from './components';
import './css/w1-materials-csv.css';

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

/** Höchstzahl gelisteter Zeilen je Abschnitt der Importvorschau (Rest als „… und n weitere“). */
const LIST_LIMIT = 200;

type Msg = { kind: 'ok' | 'warn' | 'error'; text: string } | null;

interface ImportPreviewData {
  fileName: string;
  encoding: CsvEncoding;
  parsed: MaterialsCsvOk;
  update: MaterialImportPlan;
  asNew: MaterialImportPlan;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Kurzbezeichnung eines Materials für Listen und Rückfragen. */
function materialLabel(m: Pick<Material, 'manufacturer' | 'product' | 'colorNumber' | 'colorName' | 'hex'>): string {
  const main = [m.manufacturer, m.product, m.colorNumber].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');
  const name = (m.colorName ?? '').trim();
  if (main && name) return `${main} · ${name}`;
  return main || name || m.hex;
}

function fieldLabel(t: TFunc, f: CsvField): string {
  switch (f) {
    case 'id':
      return t('matcsv.field.id');
    case 'size':
      return t('matcsv.field.size');
    case 'hex':
      return 'HEX';
    case 'type':
      return t('mats.type');
    case 'manufacturer':
      return t('mats.manufacturer');
    case 'product':
      return t('mats.product');
    case 'colorNumber':
      return t('mats.colorNumber');
    case 'colorName':
      return t('mats.colorName');
    case 'lengthMm':
      return t('mats.length');
    case 'widthMm':
      return t('mats.width');
    case 'thicknessMm':
      return t('mats.thickness');
    case 'price':
      return t('mats.price');
    case 'packageSize':
      return t('mats.packageSize');
    case 'piecesPerPack':
      return t('mats.perPack');
    case 'stock':
      return t('mats.stock');
    case 'notes':
      return t('mats.notes');
  }
}

function skipText(t: TFunc, s: CsvSkip): string {
  return t(`matcsv.skip.${s.reason}`, { value: s.value ?? '', ref: s.ref ?? '' });
}

function warnText(t: TFunc, w: CsvWarning): string {
  return t(`matcsv.warn.${w.reason}`, { value: w.value });
}

function delimName(t: TFunc, d: string): string {
  if (d === ';') return t('matcsv.delim.semicolon');
  if (d === '\t') return t('matcsv.delim.tab');
  if (d === ',') return t('matcsv.delim.comma');
  return t('matcsv.delim.other', { c: d });
}

function parseErrorText(t: TFunc, e: MaterialsCsvError): string {
  const cols = e.error === 'no-hex-column' ? e.columns.map((c) => c.header).join(', ') : e.headers.join(', ');
  return t(`matcsv.err.${e.error}`, { cols: cols || '–' });
}

export function Materials({ materials, reload }: { materials: Material[]; reload: () => void }) {
  const { t, n, lang } = useI18n();
  const [edit, setEdit] = useState<Material | null>(null);
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [preview, setPreview] = useState<ImportPreviewData | null>(null);
  const [report, setReport] = useState<{ plan: MaterialImportPlan; parsed: MaterialsCsvOk } | null>(null);
  const [busy, setBusy] = useState(false);
  const imp = useRef<HTMLInputElement>(null);
  const list = materials.filter((m) =>
    `${m.manufacturer} ${m.product} ${m.colorNumber} ${m.colorName} ${m.hex} ${m.notes ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  const saveCsv = async (text: string, name: string) => {
    try {
      await downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), `${name}.csv`);
    } catch (e) {
      setMsg({ kind: 'error', text: t('matcsv.exportError', { msg: errText(e) }) });
    }
  };

  const onFile = async (f: File) => {
    setMsg(null);
    setReport(null);
    try {
      const dec = decodeCsvBytes(new Uint8Array(await f.arrayBuffer()));
      const parsed = parseMaterialsCsv(dec.text);
      if (!parsed.ok) {
        setMsg({ kind: 'error', text: parseErrorText(t, parsed) });
        return;
      }
      setPreview({
        fileName: f.name,
        encoding: dec.encoding,
        parsed,
        update: planMaterialImport(parsed, materials, 'update', uid),
        asNew: planMaterialImport(parsed, materials, 'new', uid),
      });
    } catch (e) {
      setMsg({ kind: 'error', text: t('matcsv.err.read', { msg: errText(e) }) });
    }
  };

  const applyImport = async (mode: ImportMode) => {
    if (!preview) return;
    const plan = mode === 'update' ? preview.update : preview.asNew;
    const writes = [...plan.items.map((x) => x.material), ...plan.updates.map((u) => u.after)];
    setBusy(true);
    let done = 0;
    try {
      for (const m of writes) {
        await saveMaterial(m);
        done++;
      }
      setMsg({
        kind: plan.skipped.length || plan.warnings.length ? 'warn' : 'ok',
        text: t('matcsv.done', { new: plan.items.length, upd: plan.updates.length, same: plan.identical.length, failed: plan.skipped.length }),
      });
    } catch (e) {
      setMsg({ kind: 'error', text: t('matcsv.saveError', { done, total: writes.length, msg: errText(e) }) });
    } finally {
      setBusy(false);
      setReport(plan.skipped.length || plan.warnings.length ? { plan, parsed: preview.parsed } : null);
      setPreview(null);
      reload();
    }
  };

  const onDelete = async (m: Material) => {
    let text = t('matcsv.del.confirm', { name: materialLabel(m) });
    try {
      const usage = findMaterialUsage(await listProjects(), m.id);
      if (usage.length) {
        const names = usage
          .map((u) => (u.colors === 1 ? t('matcsv.del.colors1', { name: u.name }) : u.colors > 1 ? t('matcsv.del.colorsN', { name: u.name, n: u.colors }) : t('matcsv.del.selected', { name: u.name })))
          .join(', ');
        text += `\n\n${usage.length === 1 ? t('matcsv.del.usedOne', { list: names }) : t('matcsv.del.usedMany', { n: usage.length, list: names })}\n${t('matcsv.del.effect')}`;
      }
    } catch {
      text += `\n\n${t('matcsv.del.checkFailed')}`;
    }
    if (!confirm(text)) return;
    try {
      await deleteMaterial(m.id);
    } catch (e) {
      setMsg({ kind: 'error', text: t('matcsv.del.error', { msg: errText(e) }) });
    }
    reload();
  };

  return (
    <div className="page">
      <div className="row-between">
        <h1>{t('mats.title')}</h1>
        <div className="btn-row wrap">
          <button className="btn primary" onClick={() => setEdit({ ...EMPTY, id: uid() })} data-testid="add-material">
            + {t('mats.add')}
          </button>
          <button className="btn" onClick={() => imp.current?.click()} data-testid="import-csv">
            {t('mats.importCsv')}
          </button>
          <button className="btn" onClick={() => void saveCsv(materialsToCsv(materials, lang), t('matcsv.exportFile'))} disabled={!materials.length} data-testid="export-csv">
            {t('mats.exportCsv')}
          </button>
          <button className="btn" onClick={() => void saveCsv(materialsCsvTemplate(lang), t('matcsv.templateFile'))} data-testid="template-csv">
            {t('matcsv.template')}
          </button>
          <input
            ref={imp}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
            hidden
            data-testid="import-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onFile(f);
            }}
          />
        </div>
      </div>
      <p className="muted small">{t('mats.intro')}</p>
      <p className="muted small mc-import-hint">{t('matcsv.importHint')}</p>
      {msg && (
        <p className={`${msg.kind} mc-msg`} role="status" data-testid="mats-msg">
          {msg.text}
        </p>
      )}
      {report && (
        <details className="mc-report" data-testid="import-report" open>
          <summary>{t('matcsv.report')}</summary>
          <IssueLists plan={report.plan} parsed={report.parsed} />
        </details>
      )}
      <div className="mc-search">
        <input className="text" placeholder={t('common.search')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        {filter.trim() && materials.length > 0 && <span className="muted small">{t('matcsv.count', { shown: list.length, n: materials.length })}</span>}
      </div>
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
                <th className="num">{t('mats.stock')}</th>
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
                      {n(m.lengthMm, 2)} × {n(m.widthMm, 2)} × {n(m.thicknessMm, 2)} mm
                    </td>
                    <td className="num">{m.price ? n(m.price, 2) : '–'}</td>
                    <td className="small">
                      {m.packageSize} {m.piecesPerPack ? `(${n(m.piecesPerPack)} ${t('mats.pcs')})` : ''}
                    </td>
                    <td className="num">{m.stock !== undefined && m.stock !== null ? n(m.stock) : '–'}</td>
                    <td className="nowrap">
                      <button className="icon-btn" onClick={() => setEdit(m)} aria-label={t('common.edit')}>
                        ✎
                      </button>
                      <button className="icon-btn" aria-label={t('common.delete')} data-testid="delete-material" onClick={() => void onDelete(m)}>
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
            try {
              await saveMaterial(m);
            } catch (e) {
              setMsg({ kind: 'error', text: errText(e) });
            }
            setEdit(null);
            reload();
          }}
        />
      )}
      {preview && <ImportPreview data={preview} busy={busy} onApply={(mode) => void applyImport(mode)} onCancel={() => !busy && setPreview(null)} />}
    </div>
  );
}

function Limited<T>({ items, render }: { items: T[]; render: (x: T, i: number) => ReactNode }) {
  const { t } = useI18n();
  return (
    <>
      {items.slice(0, LIST_LIMIT).map(render)}
      {items.length > LIST_LIMIT && <li className="muted">{t('matcsv.more', { n: items.length - LIST_LIMIT })}</li>}
    </>
  );
}

/** Nicht importierte Zeilen und Hinweise (in der Vorschau und nach dem Import). */
function IssueLists({ plan, parsed }: { plan: MaterialImportPlan; parsed: MaterialsCsvOk }) {
  const { t } = useI18n();
  const header = (f: CsvField) => parsed.columns.find((c) => c.field === f)?.header ?? fieldLabel(t, f);
  return (
    <>
      {plan.skipped.length > 0 && (
        <details open className="mc-section">
          <summary className="error">
            {t('matcsv.list.failed')} ({plan.skipped.length})
          </summary>
          <ul className="mc-list" data-testid="import-failed-list">
            <Limited
              items={plan.skipped}
              render={(s, i) => (
                <li key={i}>
                  <b>{t('matcsv.line', { line: s.line })}:</b> {skipText(t, s)}
                </li>
              )}
            />
          </ul>
        </details>
      )}
      {plan.warnings.length > 0 && (
        <details open className="mc-section">
          <summary className="warn">
            {t('matcsv.list.warnings')} ({plan.warnings.length})
          </summary>
          <p className="muted small mc-note">{t('matcsv.warnHint')}</p>
          <ul className="mc-list" data-testid="import-warning-list">
            <Limited
              items={plan.warnings}
              render={(w, i) => (
                <li key={i}>
                  <b>
                    {t('matcsv.line', { line: w.line })} · {header(w.field)}:
                  </b>{' '}
                  {warnText(t, w)}
                </li>
              )}
            />
          </ul>
        </details>
      )}
    </>
  );
}

function ImportPreview({ data, busy, onApply, onCancel }: { data: ImportPreviewData; busy: boolean; onApply: (mode: ImportMode) => void; onCancel: () => void }) {
  const { t, n } = useI18n();
  const { parsed, update: u, asNew } = data;
  const writes = u.items.length + u.updates.length;
  const showAsNew = asNew.items.length > u.items.length;
  const fmt = (f: keyof Material, v: unknown): string => {
    if (v === undefined || v === null || v === '') return '–';
    if (f === 'type') return t(`mat.${String(v)}`);
    if (typeof v === 'number') return n(v, 4);
    return String(v);
  };
  const firstSkip = u.skipped[0];
  const cols = parsed.columns.map((c) => `${c.header}${c.factor === 10 ? ` (${t('matcsv.cols.cmNote')})` : ''}`);
  return (
    <Modal
      wide
      title={t('matcsv.previewTitle')}
      onClose={onCancel}
      footer={
        <div className="mc-foot">
          <button className="btn" onClick={onCancel} disabled={busy} data-testid="import-cancel">
            {t('common.cancel')}
          </button>
          {showAsNew && (
            <button className="btn" onClick={() => onApply('new')} disabled={busy || asNew.items.length === 0} data-testid="import-as-new">
              {t('matcsv.btn.asNew')} ({asNew.items.length})
            </button>
          )}
          <button className="btn primary" onClick={() => onApply('update')} disabled={busy || writes === 0} data-testid="import-apply">
            {u.updates.length ? t('matcsv.btn.update') : t('matcsv.btn.import')} ({writes})
          </button>
        </div>
      }
    >
      <div data-testid="import-preview">
        <p className="muted small">
          {t('matcsv.fileInfo', { name: data.fileName, delim: delimName(t, parsed.delimiter), enc: data.encoding, rows: parsed.dataRows })}
          {parsed.sepLine && ` ${t('matcsv.sepLine')}`}
        </p>
        <p className="mc-summary" data-testid="import-summary">
          <span className="ok">{t('matcsv.sum.new', { n: u.items.length })}</span> · <span>{t('matcsv.sum.update', { n: u.updates.length })}</span> ·{' '}
          <span className="muted">{t('matcsv.sum.identical', { n: u.identical.length })}</span> ·{' '}
          <span className={u.skipped.length ? 'error' : 'muted'}>
            {t('matcsv.sum.failed', { n: u.skipped.length })}
            {firstSkip && ` (${t('matcsv.line', { line: firstSkip.line })}: ${skipText(t, firstSkip).split(' – ')[0]}${u.skipped.length > 1 ? ' …' : ''})`}
          </span>
          {u.warnings.length > 0 && (
            <>
              {' '}
              · <span className="warn">{t('matcsv.sum.warnings', { n: u.warnings.length })}</span>
            </>
          )}
        </p>
        <div className="mc-cols small">
          <div>
            <span className="muted">{t('matcsv.cols.found')}</span> {cols.join(' · ')}
          </div>
          {parsed.ignoredColumns.length > 0 && (
            <div className="warn">
              {t('matcsv.cols.ignored')} {parsed.ignoredColumns.join(' · ')}
            </div>
          )}
          {parsed.duplicateColumns.length > 0 && (
            <div className="warn">
              {t('matcsv.cols.duplicate')} {parsed.duplicateColumns.join(' · ')}
            </div>
          )}
          {parsed.unsupportedUnitColumns.length > 0 && (
            <div className="warn">
              {t('matcsv.cols.unit')} {parsed.unsupportedUnitColumns.join(' · ')}
            </div>
          )}
          {parsed.missingFields.length > 0 && (
            <div>
              <span className="muted">{t('matcsv.cols.missing')}</span> {parsed.missingFields.map((f) => fieldLabel(t, f)).join(' · ')}
              <div className="muted">{t('matcsv.cols.missingHint')}</div>
            </div>
          )}
          {parsed.leadingLines.length > 0 && <div className="muted">{t('matcsv.leading', { lines: parsed.leadingLines.join(', ') })}</div>}
        </div>
        <IssueLists plan={u} parsed={parsed} />
        {u.updates.length > 0 && (
          <details className="mc-section" open={u.updates.length <= 10}>
            <summary>
              {t('matcsv.list.updates')} ({u.updates.length})
            </summary>
            <ul className="mc-list" data-testid="import-update-list">
              <Limited
                items={u.updates}
                render={(x, i) => (
                  <li key={i}>
                    <Swatch hex={x.after.hex} size={14} /> <b>{t('matcsv.line', { line: x.line })}</b> · {materialLabel(x.before)}:{' '}
                    {x.changed.map((f) => t('matcsv.change', { field: fieldLabel(t, f), from: fmt(f, x.before[f]), to: fmt(f, x.after[f]) })).join('; ')}
                  </li>
                )}
              />
            </ul>
          </details>
        )}
        {u.items.length > 0 && (
          <details className="mc-section" open={u.items.length <= 10}>
            <summary>
              {t('matcsv.list.new')} ({u.items.length})
            </summary>
            <ul className="mc-list" data-testid="import-new-list">
              <Limited
                items={u.items}
                render={(x, i) => (
                  <li key={i}>
                    <Swatch hex={x.material.hex} size={14} /> <b>{t('matcsv.line', { line: x.line })}</b> · {materialLabel(x.material)} · {x.material.hex}
                  </li>
                )}
              />
            </ul>
          </details>
        )}
        {u.identical.length > 0 && (
          <details className="mc-section">
            <summary className="muted">
              {t('matcsv.list.identical')} ({u.identical.length})
            </summary>
            <ul className="mc-list">
              <Limited
                items={u.identical}
                render={(x, i) => (
                  <li key={i}>
                    <Swatch hex={x.material.hex} size={14} /> {t('matcsv.line', { line: x.line })} · {materialLabel(x.material)}
                  </li>
                )}
              />
            </ul>
          </details>
        )}
        <div className="mc-help small muted">
          {writes === 0 ? (
            <p>{t('matcsv.nothing')}</p>
          ) : (
            <p>{u.updates.length ? t('matcsv.help.update', { n: u.items.length, m: u.updates.length }) : t('matcsv.help.import', { n: u.items.length })}</p>
          )}
          {showAsNew && <p>{t('matcsv.help.asNew', { n: asNew.items.length })}</p>}
        </div>
      </div>
    </Modal>
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
        <Field label={t('mats.color')} hint={<span data-testid="mat-color-hint">{ED ? t('mats.colorHint') : t('matcsv.colorHintManual')}</span>}>
          <div className="btn-row">
            <input type="color" value={hexOk && m.hex.replace('#', '').length === 6 ? `#${m.hex.replace('#', '').toLowerCase()}` : '#808080'} onChange={(e) => set({ hex: e.target.value.toUpperCase() })} />
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
