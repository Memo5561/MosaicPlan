import { useEffect, useState } from 'react';
import type { Material } from '../../core/types';
import { tCount, useI18n } from '../../i18n';
import { Badge } from '../components';
import { StepColors } from './StepColors';
import { StepCompute } from './StepCompute';
import { StepJoint, StepSize, StepTiles } from './StepGeometry';
import { StepPdf } from './StepPdf';
import { StepPhoto } from './StepPhoto';
import { StepPlan } from './StepPlan';
import { StepPreview } from './StepPreview';
import { StepShapes } from './StepShapes';
import { useProject } from './useProject';
import '../css/w1-review-fixes.css';

const STEPS = ['photo', 'size', 'tiles', 'joint', 'colors', 'shapes', 'compute', 'preview', 'plan', 'pdf'] as const;
type Step = (typeof STEPS)[number];

export function Workspace({ id, materials, initialStep, onBack }: { id: string; materials: Material[]; initialStep?: string; onBack: () => void }) {
  const { t, lang } = useI18n();
  const api = useProject(id, materials, lang);
  const [step, setStep] = useState<Step>((STEPS as readonly string[]).includes(initialStep ?? '') ? (initialStep as Step) : 'photo');

  useEffect(() => {
    const h = `#/project/${id}/${step}`;
    if (location.hash !== h) history.replaceState(null, '', h);
  }, [id, step]);

  useEffect(() => {
    if (api.loaded && api.computed && !initialStep) setStep('preview');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.loaded]);

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
  const idx = STEPS.indexOf(step);
  const needsComputed = ['preview', 'plan', 'pdf'];
  return (
    <div className="page workspace">
      <div className="ws-head">
        <button className="btn small" onClick={onBack}>
          ← {t('nav.projects')}
        </button>
        <input className="title-input" value={api.rec.meta.name} onChange={(e) => api.update((r) => ({ ...r, meta: { ...r.meta, name: e.target.value } }))} aria-label={t('project.name')} data-testid="project-name" />
        {api.computed && <Badge kind="ok">{t('project.computed')}</Badge>}
        {api.stale && (
          <button className="badge badge-warn as-btn" onClick={() => setStep('compute')}>
            {t('project.stale')}
          </button>
        )}
      </div>
      {/* Gespeichertes Mosaik passt nicht zum Projekt: auf jedem Schritt sichtbar, nicht nur in Schritt 7 */}
      {api.integrityError && !api.computed && (
        <div className="w1fx-banner" role="alert" data-testid="integrity-banner">
          <span>{t('compute.err.integrity')}</span>
          {step !== 'compute' && (
            <button className="btn small" onClick={() => setStep('compute')}>
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
      <nav className="stepper" aria-label={t('project.steps')}>
        {STEPS.map((s, i) => (
          <button
            key={s}
            className={`step ${s === step ? 'active' : ''} ${needsComputed.includes(s) && !api.computed ? 'disabled' : ''}`}
            onClick={() => setStep(s)}
            data-testid={`step-${s}`}
          >
            <span className="step-no">{i + 1}</span>
            <span className="step-label">{t(`step.${s}`)}</span>
          </button>
        ))}
      </nav>
      <section className="step-body">
        <h2>
          {idx + 1}. {t(`step.${step}`)}
        </h2>
        <p className="muted step-intro">{t(`step.${step}.intro`)}</p>
        {step === 'photo' && <StepPhoto api={api} />}
        {step === 'size' && <StepSize api={api} />}
        {step === 'tiles' && <StepTiles api={api} />}
        {step === 'joint' && <StepJoint api={api} />}
        {step === 'colors' && <StepColors api={api} materials={materials} />}
        {step === 'shapes' && <StepShapes api={api} />}
        {step === 'compute' && <StepCompute api={api} onDone={() => setStep('preview')} />}
        {step === 'preview' && <StepPreview api={api} materials={materials} />}
        {step === 'plan' && <StepPlan api={api} materials={materials} />}
        {step === 'pdf' && <StepPdf api={api} materials={materials} />}
      </section>
      <div className="step-nav">
        <button className="btn" disabled={idx === 0} onClick={() => setStep(STEPS[idx - 1])}>
          ← {t('common.back')}
        </button>
        <button className="btn primary" disabled={idx === STEPS.length - 1} onClick={() => setStep(STEPS[idx + 1])} data-testid="next-step">
          {t('common.next')} →
        </button>
      </div>
    </div>
  );
}
