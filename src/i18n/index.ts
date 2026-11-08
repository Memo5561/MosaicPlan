import { createContext, useContext } from 'react';
import { de } from './de';
import { en } from './en';
import { tr } from './tr';

export type Lang = 'de' | 'en' | 'tr';
export type Dict = Record<keyof typeof de, string>;

type ExtModule = { de?: Record<string, string>; en?: Record<string, string>; tr?: Record<string, string> };

/**
 * Zusätzliche Übersetzungen aus src/i18n/ext/*.ts (je Funktionsbereich eine Datei mit {de, en, tr}).
 * So können neue Funktionen eigene Texte mitbringen, ohne die großen Wörterbücher zu ändern.
 */
const extModules = import.meta.glob<ExtModule>('./ext/*.ts', { eager: true });

function merged(lang: Lang, base: Record<string, string>): Dict {
  const out: Record<string, string> = { ...base };
  for (const m of Object.values(extModules)) Object.assign(out, m[lang] ?? {});
  return out as Dict;
}

export const dictionaries: Record<Lang, Dict> = { de: merged('de', de), en: merged('en', en), tr: merged('tr', tr) };

export type TFunc = (key: string, params?: Record<string, string | number>) => string;

export function makeT(lang: Lang): TFunc {
  const d = dictionaries[lang] as Record<string, string>;
  const fallback = dictionaries.de as Record<string, string>;
  return (key, params) => {
    let s = d[key] ?? fallback[key] ?? key;
    if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
    return s;
  };
}

/**
 * Text mit Anzahl: Für genau 1 wird – falls vorhanden – die Einzahl `${key}.one` verwendet
 * („1 Stein hat …“ statt „1 Steine haben …“), sonst der Grundschlüssel (Mehrzahl). Sprachen ohne
 * eigene Einzahlform (Türkisch) enthalten unter `.one` denselben Text.
 */
export function tCount(t: TFunc, key: string, count: number, params?: Record<string, string | number>): string {
  if (count === 1) {
    const one = t(`${key}.one`, params);
    if (one !== `${key}.one`) return one;
  }
  return t(key, params);
}

export interface I18nCtx {
  lang: Lang;
  t: TFunc;
  setLang: (l: Lang) => void;
  /** Zahl mit Dezimaltrennzeichen der Sprache */
  n: (v: number, decimals?: number) => string;
}

export const I18nContext = createContext<I18nCtx>({
  lang: 'de',
  t: makeT('de'),
  setLang: () => {},
  n: (v) => String(v),
});

export const useI18n = () => useContext(I18nContext);

export function numberFormatter(lang: Lang) {
  const locale = lang === 'de' ? 'de-DE' : lang === 'tr' ? 'tr-TR' : 'en-GB';
  return (v: number, decimals = 0) => {
    if (!Number.isFinite(v)) return '–';
    return v.toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
  };
}
