import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { listProjects, type ProjectRecord } from '../storage/db';
import { deleteProject, duplicateProject, exportProject, importProject } from '../storage/projects';
import { downloadBlob, safeFileName } from './components';

export function Projects({ go }: { go: (h: string) => void }) {
  const { t, n } = useI18n();
  const [list, setList] = useState<ProjectRecord[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const imp = useRef<HTMLInputElement>(null);
  const reload = () => listProjects().then(setList);
  useEffect(() => {
    reload();
  }, []);
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
              try {
                await importProject(f);
                reload();
              } catch (x) {
                setErr(x instanceof Error ? x.message : String(x));
              }
            }}
          />
        </div>
      </div>
      {err && <p className="error">{err}</p>}
      {list === null && <p>{t('common.loading')}</p>}
      {list && list.length === 0 && <p className="muted">{t('projects.empty')}</p>}
      <div className="project-list">
        {list?.map((p) => (
          <div key={p.meta.id} className="project-row" data-testid="project-row">
            <button className="thumb-btn" onClick={() => go(`#/project/${p.meta.id}`)}>
              {p.meta.thumb ? <img src={p.meta.thumb} alt="" /> : <div className="thumb-empty">🧩</div>}
            </button>
            <div className="grow">
              <button className="link" onClick={() => go(`#/project/${p.meta.id}`)}>
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
                onClick={async () => {
                  await duplicateProject(p.meta.id, t('projects.copySuffix'));
                  reload();
                }}
              >
                {t('common.duplicate')}
              </button>
              <button
                className="btn small"
                onClick={async () => {
                  const b = await exportProject(p.meta.id);
                  downloadBlob(b, `${safeFileName(p.meta.name)}.mosaicplan.json`);
                }}
              >
                {t('common.export')}
              </button>
              <button
                className="btn small danger"
                onClick={async () => {
                  if (!confirm(t('projects.deleteConfirm', { name: p.meta.name }))) return;
                  await deleteProject(p.meta.id);
                  reload();
                }}
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
