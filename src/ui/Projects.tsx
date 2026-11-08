import { useEffect, useRef, useState } from 'react';
import { useI18n, type TFunc } from '../i18n';
import { timestampedName, type SaveResult } from '../platform';
import { listProjects, type ProjectRecord } from '../storage/db';
import { deleteProject, duplicateProject, exportProject, importProject } from '../storage/projects';
import { downloadBlob, safeFileName } from './components';
import { SaveResultNote } from './SaveResultNote';

function errText(t: TFunc, key: string, e: unknown): string {
  const name = (e as { name?: string } | null)?.name;
  const msg = e instanceof Error ? e.message : String(e);
  if (name === 'QuotaExceededError' || /quota/i.test(msg)) return t('projects.err.quota');
  return t(key, { msg });
}

export function Projects({ go }: { go: (h: string) => void }) {
  const { t, n } = useI18n();
  const [list, setList] = useState<ProjectRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Projekt, für das gerade Kopieren/Sichern/Löschen läuft (Knöpfe der Zeile gesperrt) */
  const [busy, setBusy] = useState<string | null>(null);
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
          <button className="btn" onClick={() => imp.current?.click()}>
            {t('projects.import')}
          </button>
          <input
            ref={imp}
            type="file"
            accept="application/json,.json,.mosaicplan"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setErr(null);
              try {
                await importProject(f);
                await reload();
              } catch (x) {
                setErr(errText(t, 'projects.err.import', x));
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
      {list === null && <p>{t('common.loading')}</p>}
      {list && list.length === 0 && <p className="muted">{t('projects.empty')}</p>}
      <div className="project-list">
        {list?.map((p) => {
          const id = p.meta.id;
          const rowBusy = busy === id;
          const note = saved[id];
          return (
            <div key={id} className="project-row" data-testid="project-row" aria-busy={rowBusy || undefined}>
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
