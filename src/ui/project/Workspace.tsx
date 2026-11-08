import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Material } from '../../core/types';
import { tCount, useI18n } from '../../i18n';
import { Badge } from '../components';
import { modalDepth } from '../modalHistory';
import { EmptyState } from './EmptyState';
import { useGuardedCompute } from './RecomputeGuard';
import { SaveErrorBanner, SaveStatus } from './SaveStatus';
import { staleReasonLabels, staleReasons } from './staleReasons';
import { StepColors } from './StepColors';
import { StepCompute } from './StepCompute';
import { StepJoint, StepSize, StepTiles } from './StepGeometry';
import { centeredScrollLeft, lastStepOf, rememberStep, RESULT_STEPS, resumeStep, STEPS, stepFromHash, stepHash, stepStates, isStep, type Step } from './stepNav';
import { StepPdf } from './StepPdf';
import { StepPhoto } from './StepPhoto';
import { StepPlan } from './StepPlan';
import { StepPreview } from './StepPreview';
import { StepShapes } from './StepShapes';
import { computeKey, useProject } from './useProject';
import '../css/w1-review-fixes.css';
import '../css/w2-workspace-shell.css';

const COMPUTE_PHASES = ['prepare', 'adjust', 'lab', 'analyze', 'palette', 'assign'];

/** Wartet, bis ein gerade geschlossener Dialog seinen Verlaufseintrag abgebaut hat (sonst würde ein neuer Schritt-Eintrag dahinter landen). */
async function modalHistorySettled(maxMs = 1000) {
  for (let waited = 0; waited < maxMs && typeof history !== 'undefined' && modalDepth(history.state) > 0; waited += 50) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function Workspace({ id, materials, initialStep, onBack }: { id: string; materials: Material[]; initialStep?: string; onBack: () => void }) {
  const { t, n, lang } = useI18n();
  const api = useProject(id, materials, lang);

  // Schritt aus der Adresse beim Öffnen – einmal festgehalten. Spätere Prop-Änderungen (z. B. das
  // verspätete hashchange nach dem Öffnen) überschreiben die Weiterleitung nach dem Laden nicht.
  const routeStep = useRef<Step | undefined>(isStep(initialStep) ? initialStep : undefined);
  const [step, setStepState] = useState<Step>(routeStep.current ?? 'photo');
  const stepRef = useRef(step);
  stepRef.current = step;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Vom Benutzer gewählter Schritt: eigener Verlaufseintrag (Zurück/Vorwärts, Android-Zurück-Taste). */
  const goStep = useCallback(
    (s: Step) => {
      if (!mounted.current) return;
      stepRef.current = s;
      setStepState(s);
      const h = stepHash(id, s);
      if (location.hash !== h) location.hash = h;
    },
    [id],
  );

  // Zurück/Vorwärts im Verlauf (und Adressänderungen von außen): Schritt aus der Adresse übernehmen
  useEffect(() => {
    const sync = () => {
      const s = stepFromHash(location.hash, id);
      if (s && s !== stepRef.current) {
        stepRef.current = s;
        setStepState(s);
      }
    };
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, [id]);
  useEffect(() => {
    const s = stepFromHash(location.hash, id);
    if (s && s !== stepRef.current) {
      stepRef.current = s;
      setStepState(s);
    }
  }, [initialStep, id]);

  // Nach dem Laden: Ohne Schritt in der Adresse dort weitermachen, wo es sinnvoll ist (ersetzt den Eintrag)
  const redirected = useRef(false);
  useEffect(() => {
    if (!api.loaded || redirected.current) return;
    redirected.current = true;
    if (!api.rec) return;
    const target = routeStep.current ?? resumeStep({ computed: !!api.computed, placed: api.progress?.total.placed ?? 0, lastStep: lastStepOf(id) });
    if (target !== stepRef.current) {
      stepRef.current = target;
      setStepState(target);
    }
    const h = stepHash(id, target);
    if (location.hash !== h && stepFromHash(location.hash, id) === undefined) history.replaceState(history.state, '', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.loaded]);

  useEffect(() => {
    if (api.loaded && api.rec) rememberStep(id, step);
  }, [api.loaded, api.rec, id, step]);

  // Fertig-Hinweis, wenn eine Berechnung endet, während ein anderer Schritt offen ist
  const [doneNotice, setDoneNotice] = useState(false);
  useEffect(() => {
    if (step === 'preview') setDoneNotice(false);
  }, [step]);
  useEffect(() => {
    if (api.computing) setDoneNotice(false);
  }, [api.computing]);
  const onComputed = useCallback(async () => {
    if (!mounted.current) return;
    if (stepRef.current !== 'compute') {
      setDoneNotice(true);
      return;
    }
    await modalHistorySettled();
    if (mounted.current && stepRef.current === 'compute') goStep('preview');
  }, [goStep]);
  const guard = useGuardedCompute(api, () => void onComputed());

  // Bildlauf: neuer Schritt beginnt oben; aktiver Schritt steht mittig in der Schrittleiste
  const rootRef = useRef<HTMLDivElement>(null);
  const stepperRef = useRef<HTMLElement>(null);
  const prevStep = useRef<Step | null>(null);
  const centerChip = useCallback(() => {
    const bar = stepperRef.current;
    const chip = bar?.querySelector<HTMLElement>('.step.active');
    if (!bar || !chip) return;
    const br = bar.getBoundingClientRect();
    const cr = chip.getBoundingClientRect();
    bar.scrollLeft = centeredScrollLeft({ scrollLeft: bar.scrollLeft, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth, barLeft: br.left, chipLeft: cr.left, chipWidth: cr.width });
  }, []);
  const ready = api.loaded && !!api.rec;
  useLayoutEffect(() => {
    if (!ready) return;
    centerChip();
    if (prevStep.current !== null && prevStep.current !== step) window.scrollTo({ top: 0 });
    prevStep.current = step;
  }, [ready, step, centerChip]);
  useEffect(() => {
    if (!ready) return;
    const onResize = () => centerChip();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [ready, centerChip]);

  // Höhe der (klebenden) Kopfzeile, damit die Schrittleiste direkt darunter haften kann
  useLayoutEffect(() => {
    if (!ready) return;
    const bar = document.querySelector<HTMLElement>('.topbar');
    const root = rootRef.current;
    if (!bar || !root) return;
    const set = () => {
      const pos = getComputedStyle(bar).position;
      root.style.setProperty('--w2ws-top', `${pos === 'sticky' || pos === 'fixed' ? Math.round(bar.getBoundingClientRect().height) : 0}px`);
    };
    set();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : null;
    ro?.observe(bar);
    window.addEventListener('resize', set);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', set);
    };
  }, [ready]);

  const reasons = useMemo(() => (api.rec && api.computed && api.stale ? staleReasons(api.rec.computedWith, computeKey(api.rec)) : []), [api.rec, api.computed, api.stale]);
  const reasonText = staleReasonLabels(reasons, t, n).join(', ');

  if (!api.loaded) return <div className="page">{t('common.loading')}</div>;
  if (!api.rec) {
    return (
      <div className="page">
        <p className="error">{t('project.notFound')}</p>
        <button className="btn" onClick={onBack}>
          {t('common.back')}
        </button>
      </div>
    );
  }
  const rec = api.rec;
  const idx = STEPS.indexOf(step);
  const states = stepStates({ hasPhoto: !!api.bitmap, computed: !!api.computed, stale: api.stale });
  const canCompute = !!api.bitmap && !!api.layout;
  const computeAsNext = step === 'compute' && canCompute && (!api.computed || api.stale);
  const pct = api.computing ? Math.round(((Math.max(0, COMPUTE_PHASES.indexOf(api.computing.phase)) + api.computing.fraction) / COMPUTE_PHASES.length) * 100) : 0;

  // Leerer Zustand statt eines Schritts ohne Grundlage
  const photoMissing = !api.bitmap;
  const photoUnreadable = photoMissing && !!api.image;
  const resultEmpty = RESULT_STEPS.includes(step) && !api.computed;
  const emptyResult = resultEmpty ? (
    api.integrityError ? (
      <EmptyState
        icon="⚠"
        tone="error"
        testId="empty-state"
        title={t('w2ws.empty.integrity.title')}
        text={t('compute.err.integrity')}
        actions={[{ label: t('w2ws.empty.goCompute'), onClick: () => goStep('compute'), primary: true, testId: 'empty-go-compute' }]}
      />
    ) : photoMissing ? (
      <EmptyState
        icon="🖼"
        testId="empty-state"
        title={photoUnreadable ? t('w2ws.empty.photoUnreadable.title') : t('w2ws.empty.noPhoto.title')}
        text={photoUnreadable ? t('w2ws.empty.photoUnreadable.text') : t('w2ws.empty.noPhoto.textResult')}
        actions={[{ label: t('w2ws.empty.goPhoto'), onClick: () => goStep('photo'), primary: true, testId: 'empty-go-photo' }]}
      />
    ) : (
      <EmptyState
        icon="🧮"
        testId="empty-state"
        title={api.computing ? t('w2ws.computing', { pct }) : t('w2ws.empty.noResult.title')}
        text={t('w2ws.empty.noResult.text')}
        actions={[{ label: t('w2ws.empty.goCompute'), onClick: () => goStep('compute'), primary: true, testId: 'empty-go-compute' }]}
      />
    )
  ) : null;

  return (
    <div className="page workspace w2ws" ref={rootRef}>
      <div className="ws-head">
        <button className="btn small w2ws-back" onClick={onBack} aria-label={t('nav.projects')} title={t('nav.projects')}>
          ← <span className="w2ws-back-label">{t('nav.projects')}</span>
        </button>
        <input className="title-input" value={rec.meta.name} onChange={(e) => api.update((r) => ({ ...r, meta: { ...r.meta, name: e.target.value } }))} aria-label={t('project.name')} data-testid="project-name" />
        <div className="w2ws-head-status">
          <SaveStatus state={api.saveState} />
          {api.computed && <Badge kind="ok">{t('project.computed')}</Badge>}
          {api.stale && (
            <button className="badge badge-warn as-btn" onClick={() => goStep('compute')} title={reasonText ? t('w2ws.stale.lead', { list: reasonText }) : undefined} data-testid="stale-badge">
              {t('project.stale')}
            </button>
          )}
          {api.computing && step !== 'compute' && (
            <button className="badge badge-info as-btn" onClick={() => goStep('compute')} data-testid="computing-badge">
              {t('w2ws.computing', { pct })}
            </button>
          )}
          {doneNotice && !api.computing && (
            <button className="badge badge-ok as-btn w2ws-done" onClick={() => goStep('preview')} data-testid="compute-done">
              ✓ {t('w2ws.done')}
            </button>
          )}
        </div>
      </div>
      <SaveErrorBanner api={api} />
      {/* Gespeichertes Mosaik passt nicht zum Projekt: auf jedem Schritt sichtbar, nicht nur in Schritt 7 */}
      {api.integrityError && !api.computed && (
        <div className="w1fx-banner" role="alert" data-testid="integrity-banner">
          <span>{t('compute.err.integrity')}</span>
          {step !== 'compute' && (
            <button className="btn small" onClick={() => goStep('compute')}>
              {t('integrity.goCompute')}
            </button>
          )}
        </div>
      )}
      {api.repairedCells > 0 && (
        <div className="w1fx-banner info" role="status" data-testid="repair-banner">
          <span>{tCount(t, 'repair.notice', api.repairedCells, { n: api.repairedCells })}</span>
          <button className="icon-btn" onClick={api.dismissRepaired} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
      )}
      {guard.backup && (
        <div className="w1fx-banner info" role="status" data-testid="backup-notice">
          <span>{t('w2ws.backupDone', { name: guard.backup.name })}</span>
          <a className="btn small" href={`#/project/${guard.backup.id}`} data-testid="backup-open">
            {t('w2ws.backupOpen')}
          </a>
          <button className="icon-btn" onClick={guard.clearBackup} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
      )}
      <nav className="stepper" aria-label={t('project.steps')} ref={stepperRef}>
        {STEPS.map((s, i) => {
          const st = states[s];
          const active = s === step;
          const title = st.unavailable ? t('w2ws.step.unavailable') : st.warn ? t('w2ws.step.stale') : undefined;
          return (
            <button
              key={s}
              type="button"
              className={`step ${active ? 'active' : ''} ${st.unavailable ? 'disabled' : ''} ${st.done ? 'w2ws-done' : ''} ${st.warn ? 'w2ws-warn' : ''}`}
              onClick={() => goStep(s)}
              aria-current={active ? 'step' : undefined}
              title={title}
              data-testid={`step-${s}`}
              data-status={st.done ? 'done' : st.warn ? 'stale' : st.unavailable ? 'unavailable' : 'open'}
            >
              <span className="step-no">{i + 1}</span>
              {st.done && (
                <span className="w2ws-mark w2ws-mark-ok" aria-hidden="true">
                  <svg viewBox="0 0 10 10" width="10" height="10">
                    <path d="M1.6 5.2 4 7.5 8.4 2.6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              )}
              {st.warn && (
                <span className="w2ws-mark w2ws-mark-warn" aria-hidden="true">
                  !
                </span>
              )}
              <span className="step-label">{t(`step.${s}`)}</span>
              {(st.done || st.warn || st.unavailable) && <span className="w2ws-sr">{` (${st.done ? t('w2ws.step.done') : st.warn ? t('w2ws.step.stale') : t('w2ws.step.unavailable')})`}</span>}
            </button>
          );
        })}
      </nav>
      <section className="step-body" aria-labelledby="w2ws-step-title">
        <div className="w2ws-step-head">
          <h2 id="w2ws-step-title">
            {idx + 1}. {t(`step.${step}`)}
          </h2>
          <p className="muted step-intro">{t(`step.${step}.intro`)}</p>
        </div>
        {step === 'photo' && <StepPhoto api={api} />}
        {step === 'size' && <StepSize api={api} />}
        {step === 'tiles' && <StepTiles api={api} />}
        {step === 'joint' && <StepJoint api={api} />}
        {step === 'colors' && <StepColors api={api} materials={materials} />}
        {step === 'shapes' && (
          <>
            {photoMissing && (
              <EmptyState
                compact
                icon="🖼"
                testId="shapes-no-photo"
                title={photoUnreadable ? t('w2ws.empty.photoUnreadable.title') : t('w2ws.empty.noPhoto.title')}
                text={t('w2ws.empty.shapesNoPhoto')}
                actions={[{ label: t('w2ws.empty.goPhoto'), onClick: () => goStep('photo'), testId: 'empty-go-photo' }]}
              />
            )}
            <StepShapes api={api} />
          </>
        )}
        {step === 'compute' && <StepCompute api={api} onCompute={guard.request} onGo={goStep} reasons={reasons} />}
        {step === 'preview' && (emptyResult ?? <StepPreview api={api} materials={materials} />)}
        {step === 'plan' && (emptyResult ?? <StepPlan api={api} materials={materials} />)}
        {step === 'pdf' && (emptyResult ?? <StepPdf api={api} materials={materials} />)}
      </section>
      <div className="step-nav" data-testid="step-nav">
        <button className="btn" disabled={idx === 0} onClick={() => goStep(STEPS[idx - 1])} data-testid="prev-step">
          ← {t('common.back')}
        </button>
        <div className="w2ws-nav-mid">
          <span className="w2ws-counter" data-testid="step-counter">
            {t('w2ws.counter', { n: idx + 1, total: STEPS.length })}
          </span>
          {step === 'photo' && photoMissing && (
            <small className="muted w2ws-nav-hint" data-testid="photo-later">
              {t('w2ws.photoLater')}
            </small>
          )}
        </div>
        {computeAsNext ? (
          <button className="btn primary" disabled={!!api.computing} onClick={guard.request} data-testid="next-step" data-action="compute">
            {api.computing ? t('w2ws.nav.computing') : api.computed ? t('w2ws.nav.recompute') : t('w2ws.nav.compute')}
          </button>
        ) : (
          <button className="btn primary" disabled={idx === STEPS.length - 1} onClick={() => goStep(STEPS[idx + 1])} data-testid="next-step">
            {t('common.next')} →
          </button>
        )}
      </div>
      {guard.dialog}
    </div>
  );
}
