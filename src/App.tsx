import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Material } from './core/types';
import { I18nContext, makeT, numberFormatter, type Lang } from './i18n';
import { DEFAULT_APP, listMaterials, loadAppSettings, saveAppSettings, type AppSettings } from './storage/db';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { leavesProject, requestLeave } from './ui/leaveGuard';
import { Home } from './ui/Home';
import { Materials } from './ui/Materials';
import { Projects } from './ui/Projects';
import { Settings } from './ui/Settings';
import { Workspace } from './ui/project/Workspace';

function useHash(): [string, (h: string) => void] {
  const [hash, setHash] = useState(location.hash || '#/');
  /** zuletzt übernommene Adresse (für den Schutz beim Verlassen eines Projekts) */
  const cur = useRef(location.hash || '#/');
  /** Adresse, deren Verlassen bereits bestätigt ist (kein zweites Nachfragen) */
  const allowed = useRef<string | null>(null);
  const apply = useCallback((h: string) => {
    cur.current = h;
    setHash(h);
  }, []);
  useEffect(() => {
    const h = () => {
      const next = location.hash || '#/';
      const prev = cur.current;
      if (allowed.current === next || !leavesProject(prev, next)) {
        allowed.current = null;
        apply(next);
        return;
      }
      // Zurück-Taste/-Geste oder Adressänderung verlässt das Projekt: erst fragen (z. B. Änderungen nicht gespeichert)
      const ok = requestLeave(() => {
        allowed.current = next;
        if (location.hash !== next) location.hash = next;
        else apply(next);
      });
      if (ok) apply(next);
      // Projekt bleibt offen: Adresse wiederherstellen (neuer Verlaufseintrag; erneutes Zurück fragt wieder)
      else history.pushState(null, '', prev);
    };
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, [apply]);
  const go = useCallback(
    (h: string) => {
      const navigate = () => {
        if (location.hash !== h) {
          allowed.current = h;
          location.hash = h;
        }
        apply(h);
        window.scrollTo(0, 0);
      };
      // Navigation in der App (Kopfzeile, „←“): beim Verlassen eines Projekts erst fragen
      if (leavesProject(cur.current, h) && !requestLeave(navigate)) return;
      navigate();
    },
    [apply],
  );
  return [hash, go];
}

/** Hauptbereiche (Anforderung 15): Start, Projekte, Materialverwaltung, Einstellungen. */
const NAV: { key: 'home' | 'projects' | 'materials' | 'settings'; hash: string; isActive: (route: string) => boolean }[] = [
  { key: 'home', hash: '#/', isActive: (r) => r === '' },
  { key: 'projects', hash: '#/projects', isActive: (r) => r === 'projects' || r === 'project' },
  { key: 'materials', hash: '#/materials', isActive: (r) => r === 'materials' },
  { key: 'settings', hash: '#/settings', isActive: (r) => r === 'settings' },
];

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
        <button className="brand" onClick={() => go('#/')} aria-label="MosaicPlan">
          <img src="icon.svg" alt="" width={28} height={28} />
          <span>MosaicPlan</span>
        </button>
        <nav className="mainnav" aria-label={t('nav.main')}>
          {NAV.map((it) => {
            const active = it.isActive(route);
            const long = t(`nav.${it.key}`);
            const short = t(`nav.${it.key}Short`);
            return (
              <button
                key={it.key}
                className={active ? 'active' : ''}
                aria-current={active ? 'page' : undefined}
                aria-label={short !== long ? long : undefined}
                onClick={() => go(it.hash)}
                data-testid={`nav-${it.key}`}
              >
                {/* Auf schmalen Bildschirmen die kurze Bezeichnung, damit alle vier Bereiche ohne Scrollen sichtbar sind */}
                {short === long ? (
                  long
                ) : (
                  <>
                    <span className="nav-long">{long}</span>
                    <span className="nav-short" aria-hidden="true">
                      {short}
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </nav>
        {/* Sprache auch in den Einstellungen; auf dem Handy nur dort (Platz für die Hauptnavigation) */}
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
            <Projects go={go} onMaterialsChanged={reloadMaterials} />
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
