/**
 * Zahleneingabe nach Sprache lesen (ohne React, damit die Tests es direkt prüfen können).
 *
 * Regeln (DE/TR: Tausenderpunkt, Dezimalkomma · EN: Tausenderkomma, Dezimalpunkt):
 *  1. Leerzeichen am Anfang/Ende werden ignoriert. Leerzeichen, geschützte (U+00A0) und schmale
 *     Leerzeichen (U+2009, U+202F) im Inneren sind nur als Tausendertrennung in Dreiergruppen erlaubt
 *     („1 000“, „12 500,5“); sonst ist die Eingabe ungültig („12 5“ → NaN, statt still 125 zu raten).
 *  2. Tausendergruppen der Sprache werden nur erkannt, wenn die Zahl nicht mit 0 beginnt
 *     („1.000“ → 1000 in DE/TR, aber „0.125“ → 0,125) und jede Gruppe genau drei Ziffern hat.
 *  3. Sonst darf höchstens ein Punkt oder Komma vorkommen; es ist das Dezimaltrennzeichen.
 *     So funktionieren „12,5“ und „12.5“ in jeder Sprache.
 *  4. Ein Trennzeichen am Ende ist erlaubt („12,“ → 12), damit das Feld beim Tippen nicht rot blinkt.
 *  5. Alles andere ergibt NaN (z. B. „1,2,3“, „12abc“, „1e3“, „1.000.5,3“). Das Feld wird dann als
 *     ungültig markiert und der Wert nicht übernommen.
 */
export type NumLang = 'de' | 'en' | 'tr';

export interface ParsedNum {
  /** gelesener Wert oder NaN */
  value: number;
  /** true, wenn Tausendertrennzeichen oder Leerzeichen entfernt wurden (dann zeigt die Eingabe einen Hinweis) */
  regrouped: boolean;
}

/** Leerzeichen-Varianten: normales, geschütztes (NBSP), schmales (U+2009), schmales geschütztes (U+202F), Ziffernbreite (U+2007) */
const SPACE_CLASS = '[ \\t\\u00A0\\u2007\\u2009\\u202F]';
const HAS_SPACE = new RegExp(SPACE_CLASS);
const ALL_SPACES = new RegExp(SPACE_CLASS, 'g');
/** Leerzeichen nur als Tausendertrennung: 1 000 / 12 500 / 1 000 000, optional mit Dezimalteil */
const SPACE_GROUPED = new RegExp(`^-?[1-9]\\d{0,2}(?:${SPACE_CLASS}\\d{3})+(?:[.,]\\d*)?$`);
const CANONICAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

const separators = (lang: NumLang): { group: string; decimal: string } => (lang === 'en' ? { group: ',', decimal: '.' } : { group: '.', decimal: ',' });

const groupPatterns = new Map<NumLang, RegExp>();
function groupPattern(lang: NumLang): RegExp {
  let re = groupPatterns.get(lang);
  if (!re) {
    const { group, decimal } = separators(lang);
    const g = `\\${group}`;
    const d = `\\${decimal}`;
    re = new RegExp(`^-?[1-9]\\d{0,2}(?:${g}\\d{3})+(?:${d}\\d*)?$`);
    groupPatterns.set(lang, re);
  }
  return re;
}

export function parseLocaleNumInfo(input: string, lang: NumLang): ParsedNum {
  const invalid: ParsedNum = { value: NaN, regrouped: false };
  // typografische Minuszeichen wie '-' behandeln
  let s = String(input ?? '')
    .replace(/[−‒–]/g, '-')
    .trim();
  if (!s) return invalid;
  let regrouped = false;
  if (HAS_SPACE.test(s)) {
    if (!SPACE_GROUPED.test(s)) return invalid;
    s = s.replace(ALL_SPACES, '');
    regrouped = true;
  }
  const { group, decimal } = separators(lang);
  if (groupPattern(lang).test(s)) {
    s = s.split(group).join('').replace(decimal, '.');
    regrouped = true;
  } else {
    const seps = s.match(/[.,]/g)?.length ?? 0;
    if (seps > 1) return invalid;
    s = s.replace(',', '.');
  }
  if (!CANONICAL.test(s)) return invalid;
  const value = Number(s);
  return Number.isFinite(value) ? { value, regrouped } : invalid;
}

/** Zahl aus einer Benutzereingabe in der Sprache `lang`; NaN, wenn die Eingabe nicht eindeutig lesbar ist. */
export function parseLocaleNum(input: string, lang: NumLang): number {
  return parseLocaleNumInfo(input, lang).value;
}
