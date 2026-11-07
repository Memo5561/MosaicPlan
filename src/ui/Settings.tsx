import { useEffect, useState } from 'react';
import { useI18n, type Lang } from '../i18n';
import { db, type AppSettings } from '../storage/db';
import { Field, NumberInput, Segmented } from './components';

export function Settings({ app, setApp }: { app: AppSettings; setApp: (a: AppSettings) => void }) {
  const { t, n } = useI18n();
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    navigator.storage?.estimate?.().then((e) => setUsage({ used: e.usage ?? 0, quota: e.quota ?? 0 }));
    navigator.storage?.persisted?.().then(setPersisted);
  }, []);
  return (
    <div className="page narrow">
      <h1>{t('settings.title')}</h1>
      <Field label={t('settings.lang')}>
        <Segmented<Lang>
          value={app.lang}
          testId="lang-select"
          options={[
            { value: 'de', label: 'Deutsch' },
            { value: 'en', label: 'English' },
            { value: 'tr', label: 'Türkçe' },
          ]}
          onChange={(v) => setApp({ ...app, lang: v })}
        />
      </Field>
      <Field label={t('settings.deltaE')} hint={t('settings.deltaEHint')}>
        <Segmented value={app.deltaE} options={[{ value: '2000', label: 'CIEDE2000' }, { value: '76', label: 'CIE76' }]} onChange={(v) => setApp({ ...app, deltaE: v })} />
      </Field>
      <Field label={t('settings.unit')}>
        <Segmented value={app.defaultUnit} options={[{ value: 'mm', label: 'mm' }, { value: 'cm', label: 'cm' }, { value: 'm', label: 'm' }]} onChange={(v) => setApp({ ...app, defaultUnit: v })} />
      </Field>
      <Field label={t('settings.reserve')}>
        <NumberInput value={app.defaultReserve} onChange={(v) => setApp({ ...app, defaultReserve: v })} min={0} max={200} suffix="%" />
      </Field>
      <Field label={t('settings.grout')}>
        <input type="color" value={app.defaultGrout.toLowerCase()} onChange={(e) => setApp({ ...app, defaultGrout: e.target.value.toUpperCase() })} />
      </Field>
      <h2>{t('settings.storage')}</h2>
      <p className="muted">{t('settings.storageHint')}</p>
      {usage && (
        <p>
          {t('settings.used', { u: n(usage.used / 1e6, 1), q: n(usage.quota / 1e6, 0) })}
        </p>
      )}
      <p>
        {persisted ? t('settings.persisted') : t('settings.notPersisted')}{' '}
        {!persisted && navigator.storage?.persist && (
          <button className="btn small" onClick={() => navigator.storage.persist().then(setPersisted)}>
            {t('settings.persist')}
          </button>
        )}
      </p>
      <p>{navigator.onLine ? t('settings.online') : t('settings.offline')}</p>
      <button
        className="btn danger"
        onClick={async () => {
          if (!confirm(t('settings.wipeConfirm'))) return;
          for (const s of ['projects', 'images', 'mosaics', 'progress', 'materials']) await db.clear(s);
          location.hash = '#/';
          location.reload();
        }}
      >
        {t('settings.wipe')}
      </button>
      <h2>{t('settings.about')}</h2>
      <p className="muted small">{t('settings.aboutText')}</p>
    </div>
  );
}
