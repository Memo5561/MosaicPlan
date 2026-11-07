import { createContext, useContext } from 'react';
import { de } from './de';
import { en } from './en';
import { tr } from './tr';

export type Lang = 'de' | 'en' | 'tr';
export type Dict = Record<keyof typeof de, string>;

export const dictionaries: Record<Lang, Dict> = { de, en, tr };

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
