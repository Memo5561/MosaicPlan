import { useEffect, useRef, useState } from 'react';
import { materialLabel, type MaterialImportNote } from '../core/materialImport';
import type { Material } from '../core/types';
import { tCount, useI18n, type TFunc } from '../i18n';
import { timestampedName, type SaveResult } from '../platform';
import { listProjects, type ProjectRecord } from '../storage/db';
import { deleteProject, duplicateProject, exportProject, importProject, ProjectFileError, type ProjectImportSummary } from '../storage/projects';
import { downloadBlob, safeFileName } from './components';
import { LaidProgress } from './LaidProgress';
import { SaveResultNote } from './SaveResultNote';
import './css/w3-project-portability.css';

function errText(t: TFunc, key: string, e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  const msg = e instanceof Error ? e.message : String(e);
  if (name === 'QuotaExceededError' || /quota/i.test(msg)) return t('projects.err.quota');
  return t(key, { msg });
}

function importErrText(t: TFunc, e: unknown): string {
  if (e instanceof ProjectFileError) return e.code === 'not-project' ? t('projects.err.notProject') : t('projects.err.invalidFile', { msg: e.message });
  return errText(t, 'projects.err.import', e);
}

function fieldLabel(t: TFunc, f: keyof Material): string {
  switch (f) {
    case 'id':
      return t('matcsv.field.id');
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
    default:
      return String(f);
  }
}

/** Wert eines Materialfelds für die Abweichungsliste (0 bei Maßen und fehlender Bestand = unbekannt). */
function fieldValue(t: TFunc, n: (v: number, d?: number) => string, f: keyof Material, v: unknown): string {
  if (f === 'stock' && (v === undefined || v === null)) return t('projimp.unknown');
  if (v === undefined || v === null || v === '') return t('projimp.empty');
  switch (f) {
    case 'type':
      return t(`mat.${String(v)}`);
    case 'lengthMm':
    case 'widthMm':
    case 'thicknessMm':
      return Number(v) === 0 ? t('projimp.unknown') : `${n(Number(v), 2)} mm`;
    case 'price':
      return n(Number(v), 2);
    case 'piecesPerPack':
    case 'stock':
      return n(Number(v));
    default:
      return String(v);
  }
}

function noteText(t: TFunc, n: (v: number, d?: number) => string, note: MaterialImportNote): string {
  switch (note.kind) {
    case 'differs': {
      const diffs = note.fields
        .map((f) => t('projimp.diff', { field: fieldLabel(t, f), file: fieldValue(t, n, f, note.exported[f]), here: fieldValue(t, n, f, note.local[f]) }))
        .join('; ');
      return note.how === 'same-id'
        ? t('projimp.note.differs.same-id', { label: materialLabel(note.exported), diffs })
        : t('projimp.note.differs.matched', { label: materialLabel(note.exported), local: materialLabel(note.local), diffs });
    }
    case 'ambiguous':
      return t('projimp.note.ambiguous', { label: materialLabel(note.exported), n: note.candidates });
    case 'taken':
      return t('projimp.note.taken', { label: materialLabel(note.exported), local: materialLabel(note.local) });
    case 'invalid': {
      const reason = note.reason === 'id' ? t('projimp.reason.id') : note.reason === 'hex' ? t('projimp.reason.hex') : t('projimp.reason.not-object');
      return t('projimp.note.invalid', { reason });
    }
    case 'duplicate':
      return t('projimp.note.duplicate', { id: note.id });
    case 'repaired':
      return t('projimp.note.repaired', { label: materialLabel(note.exported), fields: note.fields.map((f) => fieldLabel(t, f)).join(', ') });
  }
}

/** Rückmeldung nach dem Import: was mit den Materialien der Datei geschah und was fehlt (nichts still verworfen). */
function ImportSummary({ s, go, onDismiss }: { s: ProjectImportSummary; go: (h: string) => void; onDismiss: () => void }) {
  const { t, n } = useI18n();
  const c = s.materials;
  const refs = s.refs.colors + s.refs.selected;
  const poolDiffers = !!s.pool && s.pool.source !== s.pool.here;
  const freeInvalid = s.freeInvalid ?? [];
  const attention = s.missing.colors > 0 || s.missing.selected > 0 || s.notes.length > 0 || poolDiffers || s.newer || freeInvalid.length > 0;
  return (
    <div className={`w3pp-summary ${attention ? 'w3pp-attn' : 'w3pp-ok'}`} role="status" aria-live="polite" data-testid="project-import-summary" data-attention={attention ? '1' : '0'}>
      <span className="w3pp-icon" aria-hidden="true">
        {attention ? '!' : '✓'}
      </span>
      <div className="w3pp-body">
        <p>
          <b>{t('projimp.done', { name: s.name })}</b>
        </p>
        {s.renamed && (
          <p className="w3pp-sub" data-testid="project-import-renamed">
            {t('projimp.renamed', { orig: s.originalName, name: s.name })}
          </p>
        )}
        {s.materialsInFile && c.inserted + c.linked > 0 && (
          <p data-testid="project-import-materials" data-inserted={c.inserted} data-linked={c.linked} data-differing={c.differing}>
            {t('projimp.materials', { x: n(c.inserted), y: n(c.linked), z: n(c.differing) })}
          </p>
        )}
        {refs === 0 && (
          <p className="w3pp-sub" data-testid="project-import-nomaterials">
            {t('projimp.noMaterials')}
          </p>
        )}
        {!s.materialsInFile && refs > 0 && s.missing.colors === 0 && (
          <p className="w3pp-sub" data-testid="project-import-v1ok">
            {t('projimp.v1Ok')}
          </p>
        )}
        {s.missing.colors > 0 && (
          <div className="w3pp-warn" data-testid="project-import-missing" data-count={s.missing.colors}>
            <p>
              <b>{s.materialsInFile ? tCount(t, 'projimp.missing', s.missing.colors, { n: n(s.missing.colors) }) : tCount(t, 'projimp.v1Missing', s.missing.colors, { n: n(s.missing.colors) })}</b>
            </p>
            <p className="w3pp-sub">{t('projimp.missingEffect')}</p>
          </div>
        )}
        {s.missing.selected > 0 && (
          <p className="w3pp-warn" data-testid="project-import-missing-selected">
            {tCount(t, 'projimp.missingSelected', s.missing.selected, { n: n(s.missing.selected) })}
          </p>
        )}
        {poolDiffers && s.pool && (
          <p className="w3pp-sub" data-testid="project-import-pool">
            {t('projimp.pool', { source: n(s.pool.source), here: n(s.pool.here) })}
          </p>
        )}
        {s.newer && <p className="w3pp-sub">{t('projimp.newer', { v: s.version })}</p>}
        {freeInvalid.length > 0 && (
          <p className="w3pp-warn" data-testid="project-import-free-invalid" data-count={freeInvalid.length}>
            {tCount(t, 'projimp.freeInvalid', freeInvalid.length, { n: n(freeInvalid.length), ids: freeInvalid.slice(0, 12).join(', ') + (freeInvalid.length > 12 ? ' …' : '') })}
          </p>
        )}
        {s.notes.length > 0 && (
          <details className="w3pp-details" data-testid="project-import-notes" open={s.notes.length <= 3}>
            <summary>{t('projimp.details', { n: n(s.notes.length) })}</summary>
            <ul>
              {s.notes.map((note, i) => (
                <li key={i} data-kind={note.kind}>
                  {noteText(t, n, note)}
                </li>
              ))}
            </ul>
            {c.differing > 0 && <p className="w3pp-sub">{t('projimp.differsHint')}</p>}
          </details>
        )}
        <div className="w3pp-actions">
          <button type="button" className="btn small primary" onClick={() => go(`#/project/${s.id}`)} data-testid="project-import-open">
            {t('projimp.open')}
          </button>
          {(s.notes.length > 0 || s.missing.colors > 0 || s.missing.selected > 0) && (
            <button type="button" className="btn small" onClick={() => go('#/materials')}>
              {t('projimp.toMaterials')}
            </button>
          )}
        </div>
      </div>
      <button type="button" className="icon-btn w3pp-close" onClick={onDismiss} aria-label={t('projimp.dismiss')} title={t('projimp.dismiss')} data-testid="project-import-dismiss">
        ×
      </button>
    </div>
  );
}

/**
 * Meine Projekte. `onMaterialsChanged`: nach einem Import, der Materialien angelegt hat, die Materialliste der
 * App neu laden (sonst sähe das geöffnete Projekt die neuen Materialien erst nach einem Neustart).
 */
export function Projects({ go, onMaterialsChanged }: { go: (h: string) => void; onMaterialsChanged?: () => void }) {
  const { t, n } = useI18n();
  const [list, setList] = useState<ProjectRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Projekt, für das gerade Kopieren/Sichern/Löschen läuft (Knöpfe der Zeile gesperrt) */
  const [busy, setBusy] = useState<string | null>(null);
  /** Import läuft (Importknopf gesperrt) */
  const [importing, setImporting] = useState(false);
  /** Rückmeldung des letzten Imports */
  const [imported, setImported] = useState<ProjectImportSummary | null>(null);
  /** Ergebnis der letzten Sicherung je Projekt (wohin gespeichert / Teilen) */
  const [saved, setSaved] = useState<Record<string, SaveResult>>({});
  const imp = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reload = async () => {
    try {
      const l = await listProjects();
      if (alive.current) setList(l);
    } catch (e) {
      if (!alive.current) return;
      setList((cur) => cur ?? []);
      setErr(errText(t, 'projects.err.load', e));
    }
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Aktion einer Projektzeile: gesperrt während sie läuft, Fehler sichtbar statt unbehandelt */
  const run = async (id: string, errKey: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(id);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      if (alive.current) setErr(errText(t, errKey, e));
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  return (
    <div className="page">
      <div className="row-between">
        <h1>{t('projects.title')}</h1>
        <div className="btn-row">
          <button className="btn" onClick={() => imp.current?.click()} disabled={importing} data-testid="project-import">
            {importing ? t('projimp.busy') : t('projects.import')}
          </button>
          <input
            ref={imp}
            type="file"
            accept="application/json,.json,.mosaicplan"
            hidden
            data-testid="project-import-input"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f || importing) return;
              setErr(null);
              setImported(null);
              setImporting(true);
              try {
                const summary = await importProject(f, { nameSuffix: t('projimp.suffix') });
                // neu angelegte Materialien sofort in der App bekannt machen (Projekt, Materialverwaltung)
                if (summary.materials.inserted > 0) onMaterialsChanged?.();
                if (alive.current) setImported(summary);
                await reload();
              } catch (x) {
                if (alive.current) setErr(importErrText(t, x));
              } finally {
                if (alive.current) setImporting(false);
              }
            }}
          />
        </div>
      </div>
      {err && (
        <p className="error" role="alert" data-testid="projects-error">
          {err}
        </p>
      )}
      {imported && <ImportSummary s={imported} go={go} onDismiss={() => setImported(null)} />}
      {list === null && <p>{t('common.loading')}</p>}
      {list && list.length === 0 && <p className="muted">{t('projects.empty')}</p>}
      <div className="project-list">
        {list?.map((p) => {
          const id = p.meta.id;
          const rowBusy = busy === id;
          const note = saved[id];
          return (
            <div
              key={id}
              className={`project-row ${imported?.id === id ? 'w3pp-imported' : ''}`}
              data-testid="project-row"
              data-project={id}
              aria-busy={rowBusy || undefined}
            >
              <button className="thumb-btn" onClick={() => go(`#/project/${id}`)}>
                {p.meta.thumb ? <img src={p.meta.thumb} alt="" /> : <div className="thumb-empty">🧩</div>}
              </button>
              <div className="grow">
                <button className="link" onClick={() => go(`#/project/${id}`)}>
                  <b>{p.meta.name}</b>
                </button>
                <div className="muted small">
                  {n(p.settings.widthMm / 10, 2)} × {n(p.settings.heightMm / 10, 2)} cm · {t('projects.tile')} {n(p.settings.tileW, 1)} × {n(p.settings.tileH, 1)} mm · {t('projects.joint')} {n(p.settings.joint, 1)} mm
                  <br />
                  {t('projects.updated')}: {new Date(p.meta.updatedAt).toLocaleString()} · {p.meta.computed ? t('projects.computed') : t('projects.notComputed')}
                </div>
                {/* Verlegefortschritt – nur mit gespeicherten Zahlen zum aktuellen Raster (ältere Projekte: nach dem Öffnen) */}
                <LaidProgress rec={p} />
              </div>
              <div className="btn-row wrap">
                <button
                  className="btn small"
                  disabled={busy !== null}
                  onClick={() =>
                    run(id, 'projects.err.duplicate', async () => {
                      await duplicateProject(id, t('projects.copySuffix'));
                      await reload();
                    })
                  }
                >
                  {t('common.duplicate')}
                </button>
                <button
                  className="btn small"
                  disabled={busy !== null}
                  data-testid="project-export"
                  onClick={() =>
                    run(id, 'projects.err.export', async () => {
                      const b = await exportProject(id);
                      // Datum/Uhrzeit im Namen: eine neue Sicherung überschreibt nie eine ältere
                      const r = await downloadBlob(b, timestampedName(safeFileName(p.meta.name), 'mosaicplan.json'), { announce: false });
                      if (alive.current) setSaved((s) => ({ ...s, [id]: r }));
                    })
                  }
                >
                  {rowBusy ? t('projects.busy') : t('common.export')}
                </button>
                <button
                  className="btn small danger"
                  disabled={busy !== null}
                  onClick={() => {
                    if (!confirm(t('projects.deleteConfirm', { name: p.meta.name }))) return;
                    void run(id, 'projects.err.delete', async () => {
                      await deleteProject(id);
                      setSaved(({ [id]: _gone, ...rest }) => rest);
                      if (imported?.id === id) setImported(null);
                      await reload();
                    });
                  }}
                >
                  {t('common.delete')}
                </button>
              </div>
              {note && (
                <div className="w2ap-row-note" aria-label={t('projects.exportedFor', { name: p.meta.name })}>
                  <SaveResultNote
                    result={note}
                    onDismiss={() => setSaved(({ [id]: _gone, ...rest }) => rest)}
                    testId="project-save-note"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
