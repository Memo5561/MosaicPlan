import { useEffect, useRef, useState } from 'react';
import type { Region } from '../core/types';
import { useI18n } from '../i18n';
import { listProjects, type AppSettings, type ProjectRecord } from '../storage/db';
import { createProject } from '../storage/projects';
import { loadBitmap } from './project/imagePrep';

export const SAMPLES: { key: string; file: string; w: number; tile: number; joint: number; colors: number; regions?: Region[] }[] = [
  { key: 'portrait', file: 'samples/portrait.png', w: 400, tile: 5, joint: 1, colors: 32, regions: [{ id: 'face', type: 'face', shape: 'ellipse', x: 0.27, y: 0.25, w: 0.46, h: 0.5 }] },
  { key: 'landscape', file: 'samples/landscape.png', w: 1200, tile: 8, joint: 1.5, colors: 24 },
  { key: 'animal', file: 'samples/animal.png', w: 500, tile: 6, joint: 1, colors: 24 },
  { key: 'city', file: 'samples/city.png', w: 2000, tile: 10, joint: 2, colors: 16 },
];

export function Home({ app, go }: { app: AppSettings; go: (hash: string) => void }) {
  const { t, n } = useI18n();
  const [recent, setRecent] = useState<ProjectRecord[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    listProjects().then((p) => setRecent(p.slice(0, 4)));
  }, []);

  const newProject = async (photo?: File) => {
    setBusy(true);
    try {
      let aspect: number | undefined;
      if (photo) {
        const b = await loadBitmap(photo);
        aspect = b.width / b.height;
      }
      const name = photo ? photo.name.replace(/\.[^.]+$/, '') : `${t('home.newProjectName')} ${new Date().toLocaleDateString()}`;
      const id = await createProject(name, app, { photo, photoName: photo?.name, aspect });
      go(`#/project/${id}/${photo ? 'photo' : 'photo'}`);
    } finally {
      setBusy(false);
    }
  };

  const sample = async (s: (typeof SAMPLES)[number]) => {
    setBusy(true);
    try {
      const blob = await (await fetch(s.file)).blob();
      const b = await loadBitmap(blob);
      const id = await createProject(t(`sample.${s.key}`), app, {
        photo: blob,
        photoName: s.file.split('/').pop(),
        aspect: b.width / b.height,
        settings: { widthMm: s.w, tileW: s.tile, tileH: s.tile, joint: s.joint, colorCount: s.colors },
        regions: s.regions,
      });
      go(`#/project/${id}/compute`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page home">
      <section className="hero">
        <div>
          <h1>MosaicPlan</h1>
          <p className="lead">{t('home.tagline')}</p>
          <p className="muted small">{t('home.privacy')}</p>
        </div>
      </section>
      <section className="tiles">
        <button className="tile" onClick={() => newProject()} disabled={busy} data-testid="new-project">
          <span className="tile-icon">＋</span>
          <b>{t('home.newProject')}</b>
          <small>{t('home.newProjectHint')}</small>
        </button>
        <button className="tile" onClick={() => fileRef.current?.click()} disabled={busy}>
          <span className="tile-icon">📷</span>
          <b>{t('home.uploadPhoto')}</b>
          <small>{t('home.uploadPhotoHint')}</small>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          data-testid="home-photo"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) newProject(f);
            e.target.value = '';
          }}
        />
        <button className="tile" onClick={() => go('#/projects')}>
          <span className="tile-icon">🗂️</span>
          <b>{t('home.myProjects')}</b>
          <small>{t('home.myProjectsHint')}</small>
        </button>
        <button className="tile" onClick={() => go('#/materials')}>
          <span className="tile-icon">🧱</span>
          <b>{t('home.materials')}</b>
          <small>{t('home.materialsHint')}</small>
        </button>
        <button className="tile" onClick={() => go('#/settings')}>
          <span className="tile-icon">⚙️</span>
          <b>{t('home.settings')}</b>
          <small>{t('home.settingsHint')}</small>
        </button>
      </section>
      {recent.length > 0 && (
        <section>
          <h2>{t('home.recent')}</h2>
          <div className="project-cards">
            {recent.map((p) => (
              <button key={p.meta.id} className="project-card" onClick={() => go(`#/project/${p.meta.id}`)}>
                {p.meta.thumb ? <img src={p.meta.thumb} alt="" /> : <div className="thumb-empty">🧩</div>}
                <b>{p.meta.name}</b>
                <small className="muted">
                  {n(p.settings.widthMm / 10, 1)} × {n(p.settings.heightMm / 10, 1)} cm · {n(p.settings.tileW, 1)} mm
                </small>
              </button>
            ))}
          </div>
        </section>
      )}
      <section>
        <h2>{t('home.samples')}</h2>
        <p className="muted small">{t('home.samplesHint')}</p>
        <div className="project-cards">
          {SAMPLES.map((s) => (
            <button key={s.key} className="project-card" onClick={() => sample(s)} disabled={busy} data-testid={`sample-${s.key}`}>
              <img src={s.file} alt="" />
              <b>{t(`sample.${s.key}`)}</b>
              <small className="muted">
                {s.w / 10} cm · {s.tile} mm · {t('home.joint')} {n(s.joint, 1)} mm
              </small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
