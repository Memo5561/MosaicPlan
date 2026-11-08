import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Material } from './core/types';
import { I18nContext, makeT, numberFormatter, type Lang } from './i18n';
import { DEFAULT_APP, listMaterials, loadAppSettings, saveAppSettings, type AppSettings } from './storage/db';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { Home } from './ui/Home';
import { Materials } from './ui/Materials';
import { Projects } from './ui/Projects';
import { Settings } from './ui/Settings';
import { Workspace } from './ui/project/Workspace';

function useHash(): [string, (h: string) => void] {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const h = () => setHash(location.hash || '#/');
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  const go = useCallback((h: string) => {
    if (location.hash !== h) location.hash = h;
    setHash(h);
    window.scrollTo(0, 0);
  }, []);
  return [hash, go];
}

export function App() {
  const [app, setAppState] = useState<AppSettings>(DEFAULT_APP);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [ready, setReady] = useState(false);
  const [hash, go] = useHash();

  useEffect(() => {
    Promise.all([loadAppSettings(), listMaterials()])
      .then(([a, m]) => {
        setAppState(a);
        setMaterials(m);
      })
      .catch((e) => console.error(e))
      .finally(() => setReady(true));
    navigator.storage?.persist?.().catch(() => {});
  }, []);

  const setApp = useCallback((a: AppSettings) => {
    setAppState(a);
    void saveAppSettings(a);
  }, []);
  const reloadMaterials = useCallback(() => void listMaterials().then(setMaterials), []);

  const i18n = useMemo(
    () => ({ lang: app.lang, t: makeT(app.lang), setLang: (l: Lang) => setApp({ ...app, lang: l }), n: numberFormatter(app.lang) }),
    [app, setApp],
  );

  useEffect(() => {
    document.documentElement.lang = app.lang;
  }, [app.lang]);

  const parts = hash.replace(/^#\/?/, '').split('/');
  const route = parts[0] || '';
  const t = i18n.t;

  return (
    <I18nContext.Provider value={i18n}>
      <header className="topbar">
        <button className="brand" onClick={() => go('#/')}>
          <img src="icon.svg" alt="" width={28} height={28} />
          <span>MosaicPlan</span>
        </button>
        <nav className="mainnav">
          <button className={route === '' ? 'active' : ''} onClick={() => go('#/')}>
            {t('nav.home')}
          </button>
          <button className={route === 'projects' || route === 'project' ? 'active' : ''} onClick={() => go('#/projects')}>
            {t('nav.projects')}
          </button>
          <button className={route === 'materials' ? 'active' : ''} onClick={() => go('#/materials')}>
            {t('nav.materials')}
          </button>
          <button className={route === 'settings' ? 'active' : ''} onClick={() => go('#/settings')}>
            {t('nav.settings')}
          </button>
        </nav>
        <select className="lang" value={app.lang} onChange={(e) => setApp({ ...app, lang: e.target.value as Lang })} aria-label={t('settings.lang')}>
          <option value="de">DE</option>
          <option value="en">EN</option>
          <option value="tr">TR</option>
        </select>
      </header>
      <main>
        {/* Darstellungsfehler nur in dieser Ansicht abfangen; Wechsel der Ansicht setzt zurück */}
        <ErrorBoundary key={route === 'project' ? `project/${parts[1] ?? ''}` : route} t={t}>
          {!ready ? (
            <div className="page">{t('common.loading')}</div>
          ) : route === 'project' && parts[1] ? (
            <Workspace key={parts[1]} id={parts[1]} initialStep={parts[2]} materials={materials} onBack={() => go('#/projects')} />
          ) : route === 'projects' ? (
            <Projects go={go} />
          ) : route === 'materials' ? (
            <Materials materials={materials} reload={reloadMaterials} />
          ) : route === 'settings' ? (
            <Settings app={app} setApp={setApp} />
          ) : (
            <Home app={app} go={go} />
          )}
        </ErrorBoundary>
      </main>
    </I18nContext.Provider>
  );
}
