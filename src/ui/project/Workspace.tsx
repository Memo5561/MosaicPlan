import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cellId } from '../../core/layout';
import type { Material } from '../../core/types';
import { tCount, useI18n } from '../../i18n';
import { Badge, downloadBlob, Modal, safeFileName } from '../components';
import { setLeaveGuard } from '../leaveGuard';
import { SaveResultNote } from '../SaveResultNote';
import { timestampedName, type SaveResult } from '../../platform';
import { modalDepth } from '../modalHistory';
import { EmptyState } from './EmptyState';
import { PREVIEW_STEPS, PreviewLayout } from './LivePreview';
import { computeOverall } from './previewPolicy';
import { useGuardedCompute } from './RecomputeGuard';
import { SaveErrorBanner, saveErrorText, SaveStatus } from './SaveStatus';
import { staleReasonLabels, staleReasons } from './staleReasons';
import { StepColors, useLocalizedPaletteNames } from './StepColors';
import { StepCompute } from './StepCompute';
import { StepJoint, StepSize, StepTiles } from './StepGeometry';
import { centeredScrollLeft, lastStepOf, rememberStep, RESULT_STEPS, resumeStep, STEPS, stepFromHash, stepHash, stepStates, isStep, type Step } from './stepNav';
import { StepPdf } from './StepPdf';
import { StepPhoto } from './StepPhoto';
import { StepPlan } from './StepPlan';
import { StepPreview } from './StepPreview';
import { StepShapes } from './StepShapes';
import { computeKey, useProject, type ProjectApi } from './useProject';
import '../css/w1-review-fixes.css';
import '../css/w4-progress-engine.css';
import '../css/w2-workspace-shell.css';
import '../css/w3-live-preview.css';

/** Wartet, bis ein gerade geschlossener Dialog seinen Verlaufseintrag abgebaut hat (sonst würde ein neuer Schritt-Eintrag dahinter landen). */
async function modalHistorySettled(maxMs = 1000) {
  for (let waited = 0; waited < maxMs && typeof history !== 'undefined' && modalDepth(history.state) > 0; waited += 50) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

export function Workspace({ id, materials, initialStep, onBack }: { id: string; materials: Material[]; initialStep?: string; onBack: () => void }) {
  const { t, n, lang } = useI18n();
  const api = useProject(id, materials, lang);
  // Automatische Farbnamen folgen der UI-Sprache – auf jedem Schritt (Verlegeplan, PDF, Steindetail …)
  useLocalizedPaletteNames(api);

  // Schritt aus der Adresse beim Öffnen – einmal festgehalten. Spätere Prop-Änderungen (z. B. das
  // verspätete hashchange nach dem Öffnen) überschreiben die Weiterleitung nach dem Laden nicht.
  const routeStep = useRef<Step | undefined>(isStep(initialStep) ? initialStep : undefined);
  const [step, setStepState] = useState<Step>(routeStep.current ?? 'photo');
  const stepRef = useRef(step);
  stepRef.current = step;
  /** Weiterleitung nach dem Laden erledigt (oder überflüssig, weil schon ein Schritt gewählt wurde) */
  const redirected = useRef(false);
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
      // Ein gewählter Schritt gilt – die Weiterleitung nach dem Laden darf ihn nicht mehr zurücksetzen
      redirected.current = true;
      routeStep.current = undefined;
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

  // Eine in Schritt 8 geöffnete Stein-Anforderung (Hinweise im Projektkopf) gilt nur einmal – beim Verlassen vergessen
  const clearStoneRequest = api.clearStoneRequest;
  useEffect(() => {
    if (step !== 'preview') clearStoneRequest();
  }, [step, clearStoneRequest]);

  // Fertig-Hinweis, wenn eine Berechnung endet, während ein anderer Schritt offen ist
  const [doneNotice, setDoneNotice] = useState(false);
  useEffect(() => {
    if (step === 'preview') setDoneNotice(false);
  }, [step]);
  useEffect(() => {
    if (api.computing) setDoneNotice(false);
  }, [api.computing]);
  const onComputed = useCallback(async () => {
    if (!mounted.current || stepRef.current === 'preview') return;
    if (stepRef.current !== 'compute') {
      setDoneNotice(true);
      return;
    }
    await modalHistorySettled();
    if (mounted.current && stepRef.current === 'compute') goStep('preview');
  }, [goStep]);
  // Ein Ergebnis wurde in diese Ansicht übernommen – auch eines, dessen Berechnung vor dem erneuten Öffnen des
  // Projekts gestartet wurde (sie lief als Auftrag weiter). Ergebnisse aus anderen Tabs zählen nicht.
  const lastCommit = useRef(api.committedAt);
  useEffect(() => {
    if (api.committedAt === lastCommit.current) return;
    lastCommit.current = api.committedAt;
    if (api.committedAt) void onComputed();
  }, [api.committedAt, onComputed]);
  const guard = useGuardedCompute(api, () => {});

  // Schritt 8 ohne gespeichertes Mosaik: passt eine fertige Vorschau zu den Einstellungen, wird sie übernommen
  // (nichts kann verloren gehen). Nie über ein vorhandenes oder ein nicht lesbares gespeichertes Mosaik.
  const autoCommitFor = useRef<string | null>(null);
  const canAutoCommit = step === 'preview' && api.loaded && !!api.rec && !api.computed && !api.rec.computedWith && !api.integrityError && !api.computing && api.previewCommittable;
  useEffect(() => {
    if (!canAutoCommit || !api.preview.result) return;
    const k = api.preview.result.sig;
    if (autoCommitFor.current === k) return;
    autoCommitFor.current = k;
    void api.compute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canAutoCommit]);

  // ---------- Verlassen, solange Speichern fehlschlägt: nicht still verlieren
  const apiRef = useRef(api);
  apiRef.current = api;
  const [leave, setLeave] = useState<{ proceed: () => void; retrying: boolean } | null>(null);
  const [leaveSave, setLeaveSave] = useState<SaveResult | { error: string } | null>(null);
  /** Kennung der offenen Rückfrage (Bleiben/Schließen beendet sie – ein später erfolgreicher Versuch verlässt dann nicht) */
  const leaveReq = useRef(0);
  const stay = () => {
    leaveReq.current++;
    setLeave(null);
  };
  useEffect(
    () =>
      setLeaveGuard((proceed) => {
        const a = apiRef.current;
        if (a.saveState !== 'error' || !a.saveError || a.saveError.code === 'deleted') return true;
        setLeaveSave(null);
        setLeave({ proceed, retrying: true });
        const my = ++leaveReq.current;
        // erst noch einmal speichern – klappt es jetzt, wird ohne Rückfrage verlassen
        void a.retrySave().then(async (ok) => {
          if (!mounted.current || leaveReq.current !== my) return;
          if (!ok) {
            setLeave((l) => (l ? { ...l, retrying: false } : l));
            return;
          }
          setLeave(null);
          await modalHistorySettled();
          proceed();
        });
        return false;
      }),
    [],
  );
  // Tab/Fenster schließen, solange Speichern fehlschlägt: Rückfrage des Browsers
  const unsavedError = api.saveState === 'error' && !!api.saveError && api.saveError.code !== 'deleted';
  useEffect(() => {
    if (!unsavedError) return;
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [unsavedError]);
  const leaveAnyway = async () => {
    const l = leave;
    leaveReq.current++;
    setLeave(null);
    if (!l) return;
    await modalHistorySettled();
    l.proceed();
  };
  const leaveDownload = async () => {
    try {
      const blob = await api.exportCurrent();
      setLeaveSave(await downloadBlob(blob, timestampedName(safeFileName(api.rec?.meta.name ?? ''), 'mosaicplan.json'), { announce: false }));
    } catch (e) {
      setLeaveSave({ error: t('w2ws.save.downloadFailed', { msg: e instanceof Error ? e.message : String(e) }) });
    }
  };

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
    const sticky = (el: Element | null) => {
      if (!el) return false;
      const pos = getComputedStyle(el).position;
      return pos === 'sticky' || pos === 'fixed';
    };
    const set = () => {
      const top = sticky(bar) ? Math.round(bar.getBoundingClientRect().height) : 0;
      root.style.setProperty('--w2ws-top', `${top}px`);
      // Live-Vorschau klebt unter Kopfzeile und (falls klebend) Schrittleiste
      const stepper = stepperRef.current;
      const st = stepper && sticky(stepper) ? Math.round(stepper.getBoundingClientRect().height) : 0;
      root.style.setProperty('--w3lp-top', `${top + st}px`);
    };
    set();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : null;
    ro?.observe(bar);
    if (stepperRef.current) ro?.observe(stepperRef.current);
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
  const computeAsNext = step === 'compute' && canCompute && (!api.computed || api.stale || api.materialsChanged);
  // Fertige Vorschau, die Schritt 8 beim Öffnen übernimmt (siehe canAutoCommit): Schritte 8–10 sind dann nicht
  // „noch nicht berechnet“, sondern nur noch nicht gespeichert
  const previewUncommitted = api.previewCommittable && !api.computed && !rec.computedWith && !api.integrityError;
  const pct = api.computing ? Math.round(computeOverall(api.computing) * 100) : 0;
  const committing = api.computing?.phase === 'commit';
  /** Berechnung eines anderen Projekts blockiert „Berechnen“ (das Übernehmen einer fertigen Vorschau nicht) */
  const blockedByOther = !!api.otherJob && !api.previewCommittable;

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
        title={committing ? t('w3lp.committing') : api.computing ? t('w2ws.computing', { pct }) : t('w2ws.empty.noResult.title')}
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
          {api.materialsChanged && (
            <button className="badge badge-warn as-btn" onClick={() => goStep('compute')} title={t('w3lp.materialsChanged')} data-testid="materials-changed-badge">
              {t('w3lp.materialsChangedBadge')}
            </button>
          )}
          {api.computing && step !== 'compute' && !committing && (
            <button className="badge badge-info as-btn" onClick={() => goStep('compute')} data-testid="computing-badge">
              {t('w2ws.computing', { pct })}
            </button>
          )}
          {guard.pendingHidden && (
            <button className="badge badge-warn as-btn" onClick={guard.openPending} data-testid="pending-badge">
              {t('w2ws.pending.badge')}
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
      {api.invalidFree.length > 0 && (
        // Gespeicherte Freiformsteine mit ungültigen Teilen (ältere/importierte Projekte): nicht still umwandeln, sondern
        // melden – Flächen und Fugenmasse sind damit nicht exakt, der PDF-Plan ist gesperrt
        <div className="w1fx-banner" role="alert" data-testid="free-invalid-banner" data-count={api.invalidFree.length}>
          <span>{tCount(t, 'w3fx.free.notice', api.invalidFree.length, { n: n(api.invalidFree.length) })}</span>
          <span className="btn-row wrap">
            <span className="muted small">{t('w3fx.free.open')}</span>
            {api.invalidFree.slice(0, 8).map((c) => (
              <button
                key={c.id}
                className="btn small"
                data-testid="free-invalid-open"
                title={t('w3fx.free.openStone', { id: c.id })}
                onClick={() => {
                  api.requestStone(c.row, c.col);
                  goStep('preview');
                }}
              >
                {c.id}
              </button>
            ))}
            {api.invalidFree.length > 8 && <span className="muted small">{t('w3fx.free.more', { n: n(api.invalidFree.length - 8) })}</span>}
          </span>
        </div>
      )}
      <CarryOverNotice
        api={api}
        onOpen={(row, col) => {
          api.requestStone(row, col);
          goStep('preview');
        }}
      />
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
          const unavailableText = previewUncommitted ? t('w3lp.step.uncommitted') : t('w2ws.step.unavailable');
          const title = st.unavailable ? unavailableText : st.warn ? t('w2ws.step.stale') : undefined;
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
              data-uncommitted={st.unavailable && previewUncommitted ? '1' : undefined}
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
              {(st.done || st.warn || st.unavailable) && <span className="w2ws-sr">{` (${st.done ? t('w2ws.step.done') : st.warn ? t('w2ws.step.stale') : unavailableText})`}</span>}
            </button>
          );
        })}
      </nav>
      <section className="step-body" aria-labelledby="w2ws-step-title">
        <div className="w2ws-step-head">
          <h2 id="w2ws-step-title">
            {idx + 1}. {t(`step.${step}`)}
          </h2>
          {/* Schritt 7 mit passender Vorschau: Übernehmen speichert sofort – nicht „kann einige Minuten dauern“ */}
          <p className="muted step-intro" data-testid="step-intro">
            {step === 'compute' && api.previewCommittable && !api.computing ? t('w3lp.computeIntroHead') : t(`step.${step}.intro`)}
          </p>
        </div>
        {step === 'photo' && <StepPhoto api={api} />}
        {PREVIEW_STEPS.includes(step) && (
          // Schritte 2–7 mit Live-Vorschau (nie gespeichert; „Vorschau übernehmen“ in Schritt 7)
          <PreviewLayout api={api} step={step}>
            {step === 'size' && <StepSize api={api} />}
            {step === 'tiles' && <StepTiles api={api} />}
            {step === 'joint' && <StepJoint api={api} />}
            {step === 'colors' && <StepColors api={api} materials={materials} onGo={goStep} />}
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
          </PreviewLayout>
        )}
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
          <button
            className="btn primary"
            disabled={!!api.computing || blockedByOther}
            onClick={guard.request}
            data-testid="next-step"
            data-action="compute"
            data-mode={api.previewCommittable ? 'commit' : 'compute'}
            title={blockedByOther && api.otherJob ? t('w3lp.otherJob', { name: api.otherJob.projectName, pct: Math.round(computeOverall(api.otherJob.progress) * 100) }) : undefined}
          >
            {committing ? t('w3lp.committing') : api.computing ? t('w2ws.nav.computing') : api.previewCommittable ? t('w3lp.nav.commit') : api.computed ? t('w2ws.nav.recompute') : t('w2ws.nav.compute')}
          </button>
        ) : (
          <button className="btn primary" disabled={idx === STEPS.length - 1} onClick={() => goStep(STEPS[idx + 1])} data-testid="next-step">
            {t('common.next')} →
          </button>
        )}
      </div>
      {guard.dialog}
      {leave && (
        <Modal
          title={t('w2ws.leave.title')}
          onClose={stay}
          footer={
            <div className="btn-row w2ws-guard-foot">
              <button className="btn" onClick={stay} data-testid="leave-stay">
                {t('w2ws.leave.stay')}
              </button>
              <button className="btn danger" disabled={leave.retrying} onClick={() => void leaveAnyway()} data-testid="leave-anyway">
                {t('w2ws.leave.anyway')}
              </button>
              <button className="btn primary" disabled={leave.retrying} onClick={() => void leaveDownload()} data-testid="leave-download">
                {t('w2ws.save.download')}
              </button>
            </div>
          }
        >
          <div data-testid="leave-guard">
            <p className="w2ws-guard-lead">{leave.retrying ? t('w2ws.leave.retrying') : t('w2ws.leave.lead', { reason: saveErrorText(api.saveError, t) })}</p>
            {!leave.retrying && <p className="muted small">{t('w2ws.leave.info')}</p>}
            {leaveSave && 'kind' in leaveSave && <SaveResultNote result={leaveSave} testId="leave-download-note" />}
            {leaveSave && 'error' in leaveSave && (
              <p className="error" role="status">
                {leaveSave.error}
              </p>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Höchstens so viele betroffene Positionen als Knöpfe (der Rest als Anzahl) */
const CARRY_SHOW_CELLS = 12;

/**
 * Einmaliger Hinweis nach dem Neuberechnen (bis er geschlossen oder neu berechnet wird): wie viele verlegte Steine
 * übernommen wurden und wie viele sich geändert haben (mit den Positionen) – oder dass das Raster geändert wurde und
 * der Fortschritt nicht übertragbar ist. Zahlen exakt aus der Übernahme (core/progressCarry.ts).
 */
function CarryOverNotice({ api, onOpen }: { api: ProjectApi; onOpen: (row: number, col: number) => void }) {
  const { t, n } = useI18n();
  const [open, setOpen] = useState(false);
  const info = api.lastCarryOver;
  const layout = api.computed?.layout;
  if (!info || !layout) return null;
  const close = (
    <button className="icon-btn" onClick={api.dismissCarryOver} aria-label={t('w4pe.carry.dismiss')} title={t('w4pe.carry.dismiss')} data-testid="carry-dismiss">
      ✕
    </button>
  );
  if (info.status === 'layout') {
    return (
      <div className="w1fx-banner w4pe-carry w4pe-warn" role="status" data-testid="carry-notice" data-status="layout" data-kept={0} data-reset={info.reset}>
        <span className="w4pe-carry-body">
          <b>{tCount(t, 'w4pe.carry.layout', info.reset, { n: n(info.reset) })}</b>
          <span className="w4pe-carry-how">{t('w4pe.carry.layoutHint')}</span>
        </span>
        {close}
      </div>
    );
  }
  const cells = info.cells.filter((idx) => idx >= 0 && idx < layout.cols * layout.rows);
  const more = Math.max(0, info.cellCount - Math.min(cells.length, CARRY_SHOW_CELLS));
  return (
    <div className={`w1fx-banner ${info.reset > 0 ? 'w4pe-warn' : 'info'} w4pe-carry`} role="status" data-testid="carry-notice" data-status="kept" data-kept={info.kept} data-reset={info.reset}>
      <span className="w4pe-carry-body">
        <span>
          {t('w4pe.carry.lead')} {tCount(t, 'w4pe.carry.kept', info.kept, { n: n(info.kept) })}
          {info.reset > 0 ? (
            <>
              , {tCount(t, 'w4pe.carry.changed', info.reset, { n: n(info.reset) })}{' '}
              {cells.length > 0 && (
                <button type="button" className="w4pe-carry-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="carry-show">
                  ({open ? t('w4pe.carry.hide') : t('w4pe.carry.show')})
                </button>
              )}
            </>
          ) : (
            <> {t('w4pe.carry.allSame')}</>
          )}
        </span>
        <span className="w4pe-carry-how">{t('w4pe.carry.how')}</span>
        {open && cells.length > 0 && (
          <span className="w4pe-cells" data-testid="carry-cells">
            <span className="small">{t('w4pe.carry.where')}</span>
            {cells.slice(0, CARRY_SHOW_CELLS).map((idx) => {
              const row = Math.floor(idx / layout.cols);
              const col = idx - row * layout.cols;
              const id = cellId(layout, row, col);
              return (
                <button key={idx} type="button" className="btn small" title={t('w4pe.carry.openStone', { id })} onClick={() => onOpen(row, col)} data-testid="carry-cell">
                  {id}
                </button>
              );
            })}
            {more > 0 && <span className="small">{t('w4pe.carry.more', { n: n(more) })}</span>}
          </span>
        )}
      </span>
      {close}
    </div>
  );
}
