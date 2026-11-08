import { useEffect, useRef, useState } from 'react';
import type { Region } from '../core/types';
import { useI18n } from '../i18n';
import { listProjects, type AppSettings, type ProjectRecord } from '../storage/db';
import { createProject } from '../storage/projects';
import { createFromPhoto, createFromSample, fetchAppBlob, pickDroppedFile, projectNameFromFile, type HomePhotoErrorKind } from './homeIntake';
import { loadBitmap } from './project/imagePrep';

export const SAMPLES: { key: string; file: string; w: number; tile: number; joint: number; colors: number; regions?: Region[] }[] = [
  { key: 'portrait', file: 'samples/portrait.png', w: 400, tile: 5, joint: 1, colors: 32, regions: [{ id: 'face', type: 'face', shape: 'ellipse', x: 0.27, y: 0.25, w: 0.46, h: 0.5 }] },
  { key: 'landscape', file: 'samples/landscape.png', w: 1200, tile: 8, joint: 1.5, colors: 24 },
  { key: 'animal', file: 'samples/animal.png', w: 500, tile: 6, joint: 1, colors: 24 },
  { key: 'city', file: 'samples/city.png', w: 2000, tile: 10, joint: 2, colors: 16 },
];

type Busy = null | 'photo' | 'blank' | 'sample';
type HomeError = { kind: HomePhotoErrorKind; name: string; where: 'photo' | 'sample' };

/**
 * Startseite: eine klare Hauptaktion („Foto auswählen und loslegen“, auch per Ziehen & Ablegen),
 * darunter eine kompakte Zeile mit leerem Projekt, Projekten, Materialien und Einstellungen,
 * zuletzt bearbeitete Projekte und die Beispielprojekte. Nicht lesbare Fotos werden gemeldet;
 * ein Projekt entsteht erst, wenn das Foto gelesen werden konnte.
 */
export function Home({ app, go }: { app: AppSettings; go: (hash: string) => void }) {
  const { t, n } = useI18n();
  const [recent, setRecent] = useState<ProjectRecord[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const samplesRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const busyRef = useRef(false);
  const [err, setErr] = useState<HomeError | null>(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    let alive = true;
    listProjects()
      .then((p) => alive && setRecent(p.slice(0, 4)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const begin = (b: Exclude<Busy, null>) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(b);
    setErr(null);
    return true;
  };
  const end = () => {
    busyRef.current = false;
    setBusy(null);
  };

  const startWithPhoto = async (photo: File) => {
    if (!begin('photo')) return;
    try {
      const r = await createFromPhoto(photo, {
        decode: loadBitmap,
        create: (aspect) => createProject(projectNameFromFile(photo.name, t('home.newProjectName')), app, { photo, photoName: photo.name, aspect }),
      });
      if (r.ok) go(`#/project/${r.id}/photo`);
      else {
        console.warn('Foto nicht übernommen', r.error);
        setErr({ kind: r.kind, name: photo.name || '…', where: 'photo' });
      }
    } finally {
      end();
    }
  };
  const startRef = useRef(startWithPhoto);
  startRef.current = startWithPhoto;

  const blankProject = async () => {
    if (!begin('blank')) return;
    try {
      const id = await createProject(`${t('home.newProjectName')} ${new Date().toLocaleDateString()}`, app);
      go(`#/project/${id}/photo`);
    } catch (e) {
      console.warn('Projekt nicht angelegt', e);
      setErr({ kind: 'save', name: '', where: 'photo' });
    } finally {
      end();
    }
  };

  const sample = async (s: (typeof SAMPLES)[number]) => {
    if (!begin('sample')) return;
    try {
      const r = await createFromSample(s.file, {
        fetchBlob: fetchAppBlob,
        decode: loadBitmap,
        create: (blob, aspect) =>
          createProject(t(`sample.${s.key}`), app, {
            photo: blob,
            photoName: s.file.split('/').pop(),
            aspect,
            settings: { widthMm: s.w, tileW: s.tile, tileH: s.tile, joint: s.joint, colorCount: s.colors },
            regions: s.regions,
          }),
      });
      if (r.ok) go(`#/project/${r.id}/compute`);
      else {
        console.warn('Beispielprojekt nicht angelegt', r.error);
        setErr({ kind: r.kind, name: s.file.split('/').pop() ?? s.file, where: 'sample' });
      }
    } finally {
      end();
    }
  };

  // Ziehen & Ablegen: Ein Foto, das irgendwo auf der Startseite losgelassen wird, startet ein Projekt
  // (statt dass der Browser die Datei öffnet und die App verlässt). Der Kopfbereich zeigt das Ziel an.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDrag(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDrag(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDrag(false);
      const f = pickDroppedFile(e.dataTransfer?.files);
      if (f) void startRef.current(f);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const errText = err ? t(`home.err.${err.kind}`, { name: err.name }) : '';

  return (
    <div className="page home">
      <section className={`hero ${drag ? 'drag' : ''}`} aria-labelledby="home-title" data-testid="home-hero">
        <div className="hero-text">
          <h1 id="home-title">MosaicPlan</h1>
          <p className="lead">{t('home.tagline')}</p>
        </div>
        <div className="hero-drop" data-testid="home-drop">
          <div className="hero-drop-icon" aria-hidden="true">
            📷
          </div>
          <button className="btn primary big hero-cta" onClick={() => fileRef.current?.click()} disabled={busy !== null} data-testid="home-cta">
            {busy === 'photo' ? t('home.ctaBusy') : t('home.cta')}
          </button>
          <p className="hero-drop-hint">
            <span className="drop-only">{drag ? t('home.dropNow') : t('home.dropHint')} · </span>
            {t('home.formats')}
          </p>
          <button className="hero-link" onClick={() => samplesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} data-testid="home-see-samples">
            {t('home.seeSamples')} ↓
          </button>
        </div>
        <p className="hero-privacy">{t('home.privacy')}</p>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          data-testid="home-photo"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void startWithPhoto(f);
            e.target.value = '';
          }}
        />
      </section>
      {/* für Screenreader; sichtbar steht derselbe Text im Hauptknopf */}
      <p className="sr-only" role="status">
        {busy === 'photo' ? t('home.ctaBusy') : ''}
      </p>
      {err?.where === 'photo' && (
        <p className="error home-error" role="alert" data-testid="photo-error">
          {errText}
        </p>
      )}
      <nav className="home-links" aria-label={t('home.more')}>
        <button className="btn" onClick={blankProject} disabled={busy !== null} data-testid="new-project" title={t('home.newProjectHint')}>
          <span aria-hidden="true">＋</span> {t('home.blankProject')}
        </button>
        <button className="btn" onClick={() => go('#/projects')} data-testid="home-projects" title={t('home.myProjectsHint')}>
          <span aria-hidden="true">🗂️</span> {t('home.myProjects')}
        </button>
        <button className="btn" onClick={() => go('#/materials')} data-testid="home-materials" title={t('home.materialsHint')}>
          <span aria-hidden="true">🧱</span> {t('home.materials')}
        </button>
        <button className="btn" onClick={() => go('#/settings')} data-testid="home-settings" title={t('home.settingsHint')}>
          <span aria-hidden="true">⚙️</span> {t('home.settings')}
        </button>
      </nav>
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
      <section className="home-samples" ref={samplesRef} aria-labelledby="home-samples-title">
        <h2 id="home-samples-title">{t('home.samples')}</h2>
        <p className="muted small">{t('home.samplesHint')}</p>
        {busy === 'sample' && (
          <p className="home-status" role="status">
            {t('home.sampleBusy')}
          </p>
        )}
        {err?.where === 'sample' && (
          <p className="error home-error" role="alert" data-testid="sample-error">
            {errText}
          </p>
        )}
        <div className="project-cards">
          {SAMPLES.map((s) => (
            <button key={s.key} className="project-card" onClick={() => sample(s)} disabled={busy !== null} data-testid={`sample-${s.key}`}>
              <img src={s.file} alt="" />
              <b>{t(`sample.${s.key}`)}</b>
              <small className="muted">
                {n(s.w / 10, 1)} cm · {n(s.tile, 1)} mm · {t('home.joint')} {n(s.joint, 1)} mm
              </small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
