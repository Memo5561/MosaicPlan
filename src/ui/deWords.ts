import { deviationBin } from '../core/deviation';
import type { TFunc } from '../i18n';

/**
 * ΔE in Worten mit denselben Grenzen wie die Legende der Abweichungskarte (deviationBin) und compute.deHint:
 * kaum sichtbar (< 2) · erkennbar (2–5) · deutlich (5–10) · stark (> 10). Ergebnis z. B. „deutlich (ΔE 7,3)“ bzw. kurz
 * „deutlich (7,3)“ (Paket w6-fix-ui).
 */
export function deText(t: TFunc, n: (v: number, d?: number) => string, d: number, short = false): string {
  return t(short ? 'w6fx.deShort' : 'w6fx.deWord', { word: t(`w6fx.de.${deviationBin(d)}`), v: n(d, 1) });
}
