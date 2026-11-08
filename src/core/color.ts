/**
 * Farbraum-Umrechnungen (sRGB ⇄ CIE XYZ (D65) ⇄ CIELAB) und Farbabstände
 * (CIE76 und CIEDE2000).
 */
// Zirkulärer Import: colorNames.ts nutzt hexToLab/deltaE2000 erst beim ersten Aufruf (keine Arbeit beim Laden).
import { autoColorName } from './colorNames';

export type Lab = [number, number, number];
export type RGB = [number, number, number];

const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// D65 Referenzweiß
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

function fLab(t: number): number {
  return t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116;
}

function fLabInv(t: number): number {
  const t3 = t * t * t;
  return t3 > EPS ? t3 : (116 * t - 16) / KAPPA;
}

/** sRGB (0..255, ganzzahlig) → CIELAB. */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const out: Lab = [0, 0, 0];
  rgbToLabInto(r, g, b, out, 0);
  return out;
}

/** Schreibt L, a, b ab `offset` in `out` (für Float32Arrays ohne Allokation). */
export function rgbToLabInto(
  r: number,
  g: number,
  b: number,
  out: { [i: number]: number },
  offset: number,
): void {
  const R = SRGB_TO_LIN[r | 0];
  const G = SRGB_TO_LIN[g | 0];
  const B = SRGB_TO_LIN[b | 0];
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / XN;
  const y = (R * 0.2126729 + G * 0.7151522 + B * 0.072175) / YN;
  const z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / ZN;
  const fx = fLab(x);
  const fy = fLab(y);
  const fz = fLab(z);
  out[offset] = 116 * fy - 16;
  out[offset + 1] = 500 * (fx - fy);
  out[offset + 2] = 200 * (fy - fz);
}

function linToSrgb(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/** CIELAB → sRGB (0..255, auf Gamut geklemmt). */
export function labToRgb(L: number, a: number, b: number): RGB {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = fLabInv(fx) * XN;
  const y = (L > KAPPA * EPS ? fy * fy * fy : L / KAPPA) * YN;
  const z = fLabInv(fz) * ZN;
  const R = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const G = x * -0.969266 + y * 1.8760108 + z * 0.041556;
  const B = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  return [linToSrgb(R), linToSrgb(G), linToSrgb(B)];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

export function hexToRgb(hex: string): RGB {
  let s = hex.trim().replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`Ungültiger HEX-Wert: ${hex}`);
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export function isValidHex(hex: string): boolean {
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex.trim());
}

export function hexToLab(hex: string): Lab {
  const [r, g, b] = hexToRgb(hex);
  return rgbToLab(r, g, b);
}

export function labToHex(L: number, a: number, b: number): string {
  const [r, g, bb] = labToRgb(L, a, b);
  return rgbToHex(r, g, bb);
}

/** CIE76: euklidischer Abstand in CIELAB. */
export function deltaE76(l1: number, a1: number, b1: number, l2: number, a2: number, b2: number): number {
  const dl = l1 - l2;
  const da = a1 - a2;
  const db = b1 - b2;
  return Math.sqrt(dl * dl + da * da + db * db);
}

const DEG = Math.PI / 180;
const POW25_7 = Math.pow(25, 7);

/**
 * CIEDE2000 nach Sharma, Wu, Dalal (2005), kL = kC = kH = 1.
 */
export function deltaE2000(L1: number, a1: number, b1: number, L2: number, a2: number, b2: number): number {
  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW25_7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);
  let h1p = C1p === 0 ? 0 : Math.atan2(b1, a1p) / DEG;
  if (h1p < 0) h1p += 360;
  let h2p = C2p === 0 ? 0 : Math.atan2(b2, a2p) / DEG;
  if (h2p < 0) h2p += 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
    else hbarp = (h1p + h2p - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * DEG) +
    0.24 * Math.cos(2 * hbarp * DEG) +
    0.32 * Math.cos((3 * hbarp + 6) * DEG) -
    0.2 * Math.cos((4 * hbarp - 63) * DEG);
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Cbarp7 = Math.pow(Cbarp, 7);
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW25_7));
  const Lm50 = (Lbarp - 50) * (Lbarp - 50);
  const Sl = 1 + (0.015 * Lm50) / Math.sqrt(20 + Lm50);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * DEG) * Rc;
  const tl = dLp / Sl;
  const tc = dCp / Sc;
  const th = dHp / Sh;
  return Math.sqrt(tl * tl + tc * tc + th * th + Rt * tc * th);
}

export type DeltaEFormula = '2000' | '76';

export function deltaE(formula: DeltaEFormula, p: Lab, q: Lab): number {
  return formula === '76'
    ? deltaE76(p[0], p[1], p[2], q[0], q[1], q[2])
    : deltaE2000(p[0], p[1], p[2], q[0], q[1], q[2]);
}

/** Bis zu dieser Anzahl erlaubter Farben vergleicht nearestExact einfach jede Farbe per CIEDE2000. */
export const MATCHER_BRUTE_FORCE_MAX = 16;
/** Kandidaten aus der CIE94-artigen Vorauswahl bei größeren Paletten. */
export const MATCHER_PREFILTER_K = 12;
/**
 * Faktor der unteren Schranke für den Buntheitsteil von CIEDE2000 (siehe nearestExact):
 * 1 − max|R_T|/2 = 1 − sin(60°) ≈ 0,134, mit Sicherheitsabstand abgerundet.
 */
const LB_CHROMA = 0.13;

/**
 * Zuordner „Lab → nächste Palettenfarbe“.
 *
 * nearestExact ist exakt, d. h. liefert immer dieselbe Farbe wie ein Vergleich mit jeder erlaubten Farbe
 * (kleinster Abstand, bei Gleichstand die niedrigere Position):
 * - Formel '76': euklidischer Abstand über alle erlaubten Farben.
 * - Formel '2000', höchstens 16 erlaubte Farben: CIEDE2000 gegen jede Farbe.
 * - Formel '2000', mehr Farben: Vorauswahl der 12 nächsten Farben nach einem symmetrischen CIE94-artigen
 *   Abstand, CIEDE2000 unter diesen ergibt d*. Danach wird jede weitere Farbe geprüft, deren garantierte
 *   untere Schranke von CIEDE2000 unter d* liegt:
 *     ΔE00² ≥ (ΔL/S_L)² + 0,134·(Δa² + Δb²)/(1 + 0,0675·C̄)²
 *   (S_L exakt; ΔC'² + ΔH'² = |Δ(a′, b)|² ≥ Δa² + Δb² wegen a′ = (1+G)·a mit G ≥ 0; S_H < S_C ≤ 1 + 0,045·1,5·C̄
 *   wegen G ≤ 0,5 und T < 3; der Drehterm R_T·(ΔC'/S_C)(ΔH'/S_H) mit |R_T| ≤ 2·sin 60° kann höchstens
 *   86,6 % des Buntheitsteils abziehen). Bei realen Paletten liegt d* klein, die Prüfung kostet dann fast nichts.
 *
 * nearest() speichert Ergebnisse je gerundetem Lab-Wert zwischen: L auf dem Raster der gespeicherten
 * Steinfarben (L·2,55, wie qL in mosaic.ts), a/b auf 0,5. Ganze Steine und Zweiteiler (deren Farben genau auf
 * diesem Raster liegen) erhalten so dasselbe Ergebnis wie nearestExact. Nur ungerundete Werte – die Teilsteine
 * feinerer Unterteilungen (2×2/3×3) – teilen sich einen Eintrag mit Nachbarwerten (< 0,5 Lab-Einheiten entfernt).
 */
export class NearestColorMatcher {
  private readonly L: Float64Array;
  private readonly A: Float64Array;
  private readonly B: Float64Array;
  /** C* je Palettenfarbe (für Vorauswahl und Schranke) */
  private readonly C: Float64Array;
  private readonly cache = new Map<number, number>();
  /** Indizes der erlaubten Farben */
  private readonly idx: Int32Array;
  // Arbeitsspeicher je Abfrage (nicht reentrant – JS ist einfädig)
  private readonly lb2: Float64Array;
  private readonly stamp: Int32Array;
  private query = 0;

  constructor(
    palette: Lab[],
    private readonly formula: DeltaEFormula,
    allowedMask?: ArrayLike<boolean>,
  ) {
    const n = palette.length;
    this.L = new Float64Array(n);
    this.A = new Float64Array(n);
    this.B = new Float64Array(n);
    this.C = new Float64Array(n);
    const allowed: number[] = [];
    for (let i = 0; i < n; i++) {
      this.L[i] = palette[i][0];
      this.A[i] = palette[i][1];
      this.B[i] = palette[i][2];
      this.C[i] = Math.sqrt(palette[i][1] * palette[i][1] + palette[i][2] * palette[i][2]);
      if (!allowedMask || allowedMask[i]) allowed.push(i);
    }
    if (!allowed.length) throw new Error('Palette ist leer.');
    this.idx = Int32Array.from(allowed);
    this.lb2 = new Float64Array(allowed.length);
    this.stamp = new Int32Array(n);
  }

  /** Index der nächsten (erlaubten) Palettenfarbe, mit Zwischenspeicher (siehe Klassenbeschreibung). */
  nearest(l: number, a: number, b: number): number {
    const kl = Math.round(l * 2.55);
    const ka = Math.round(a * 2) + 512;
    const kb = Math.round(b * 2) + 512;
    const key = (kl * 1024 + ka) * 1024 + kb;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const res = this.nearestExact(l, a, b);
    if (this.cache.size > 2_000_000) this.cache.clear();
    this.cache.set(key, res);
    return res;
  }

  /** Index der nächsten (erlaubten) Palettenfarbe ohne Zwischenspeicher – exakt (siehe Klassenbeschreibung). */
  nearestExact(l: number, a: number, b: number): number {
    const idx = this.idx;
    const m = idx.length;
    if (this.formula === '76') {
      let best = idx[0];
      let bd = Infinity;
      for (let k = 0; k < m; k++) {
        const i = idx[k];
        const dl = l - this.L[i];
        const da = a - this.A[i];
        const db = b - this.B[i];
        const d = dl * dl + da * da + db * db;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    }
    if (m <= MATCHER_BRUTE_FORCE_MAX) {
      let best = idx[0];
      let bd = Infinity;
      for (let k = 0; k < m; k++) {
        const i = idx[k];
        const d = deltaE2000(l, a, b, this.L[i], this.A[i], this.B[i]);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best;
    }
    // 1. Vorauswahl (symmetrischer CIE94-artiger Abstand) und untere Schranke von CIEDE2000 je Farbe
    const K = MATCHER_PREFILTER_K;
    const cq = Math.sqrt(a * a + b * b);
    const candIdx = new Int32Array(K).fill(-1);
    const candD = new Float64Array(K).fill(Infinity);
    const lb2 = this.lb2;
    let worst = 0;
    for (let k = 0; k < m; k++) {
      const i = idx[k];
      const dl = l - this.L[i];
      const da = a - this.A[i];
      const db = b - this.B[i];
      const dab2 = da * da + db * db;
      const dc = cq - this.C[i];
      const dh2 = Math.max(0, dab2 - dc * dc);
      const cbar = (cq + this.C[i]) / 2;
      const sc = 1 + 0.045 * cbar;
      const sh = 1 + 0.015 * cbar;
      const d = dl * dl + (dc * dc) / (sc * sc) + dh2 / (sh * sh);
      const lm = ((l + this.L[i]) / 2 - 50) ** 2;
      const sl = 1 + (0.015 * lm) / Math.sqrt(20 + lm);
      const scMax = 1 + 0.0675 * cbar;
      lb2[k] = (dl * dl) / (sl * sl) + (LB_CHROMA * dab2) / (scMax * scMax);
      if (d < candD[worst]) {
        candD[worst] = d;
        candIdx[worst] = i;
        worst = 0;
        for (let q = 1; q < K; q++) if (candD[q] > candD[worst]) worst = q;
      }
    }
    // 2. CIEDE2000 unter den Kandidaten
    const stamp = this.stamp;
    const qid = ++this.query;
    let bestI = -1;
    let bestD = Infinity;
    for (let q = 0; q < K; q++) {
      const i = candIdx[q];
      if (i < 0) continue;
      stamp[i] = qid;
      const d = deltaE2000(l, a, b, this.L[i], this.A[i], this.B[i]);
      if (d < bestD || (d === bestD && i < bestI)) {
        bestD = d;
        bestI = i;
      }
    }
    // 3. Jede andere Farbe, die nach der Schranke noch näher sein könnte, exakt prüfen
    let bd2 = bestD * bestD * (1 + 1e-9) + 1e-12;
    for (let k = 0; k < m; k++) {
      if (lb2[k] > bd2) continue;
      const i = idx[k];
      if (stamp[i] === qid) continue;
      const d = deltaE2000(l, a, b, this.L[i], this.A[i], this.B[i]);
      if (d < bestD || (d === bestD && i < bestI)) {
        bestD = d;
        bestI = i;
        bd2 = bestD * bestD * (1 + 1e-9) + 1e-12;
      }
    }
    if (this.query > 2_000_000_000) {
      this.query = 0;
      stamp.fill(0);
    }
    return bestI;
  }
}

/** Relative Leuchtdichte → schwarze oder weiße Schrift auf Farbfläche. */
export function textColorFor(hex: string): string {
  const [L] = hexToLab(hex);
  return L > 58 ? '#000000' : '#FFFFFF';
}

export type ColorNameLang = 'de' | 'en' | 'tr';

/**
 * Beschreibender Farbname eines Lab-Werts in der Sprache `lang` (nächste Referenzfarbe, siehe colorNames.ts).
 * Für Paletten besser nameKeyFor + uniqueAutoNames verwenden, damit gleichnamige Farben unterscheidbar sind.
 */
export function describeColor(lab: Lab, lang: ColorNameLang = 'de'): string {
  return autoColorName(lab, lang);
}
