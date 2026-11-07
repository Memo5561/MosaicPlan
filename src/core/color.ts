/**
 * Farbraum-Umrechnungen (sRGB ⇄ CIE XYZ (D65) ⇄ CIELAB) und Farbabstände
 * (CIE76 und CIEDE2000).
 */

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

/**
 * Schneller Zuordner „Lab → nächste Palettenfarbe“.
 * – Vorauswahl der Kandidaten per CIE76 (die 6 nächsten), Feinentscheidung per CIEDE2000.
 * – Ergebnisse werden für auf 0,5 Lab-Einheiten gerundete Werte zwischengespeichert.
 */
export class NearestColorMatcher {
  private readonly L: Float64Array;
  private readonly A: Float64Array;
  private readonly B: Float64Array;
  private readonly n: number;
  private readonly cache = new Map<number, number>();
  private readonly allowed: Uint8Array;

  constructor(
    palette: Lab[],
    private readonly formula: DeltaEFormula,
    allowedMask?: ArrayLike<boolean>,
  ) {
    this.n = palette.length;
    this.L = new Float64Array(this.n);
    this.A = new Float64Array(this.n);
    this.B = new Float64Array(this.n);
    this.allowed = new Uint8Array(this.n);
    for (let i = 0; i < this.n; i++) {
      this.L[i] = palette[i][0];
      this.A[i] = palette[i][1];
      this.B[i] = palette[i][2];
      this.allowed[i] = allowedMask ? (allowedMask[i] ? 1 : 0) : 1;
    }
    if (!this.allowed.some((v) => v === 1)) throw new Error('Palette ist leer.');
  }

  /** Index der nächsten (erlaubten) Palettenfarbe. */
  nearest(l: number, a: number, b: number): number {
    const kl = Math.round(l * 2);
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

  nearestExact(l: number, a: number, b: number): number {
    const K = 6;
    const candIdx: number[] = [];
    const candD: number[] = [];
    for (let i = 0; i < this.n; i++) {
      if (!this.allowed[i]) continue;
      const dl = l - this.L[i];
      const da = a - this.A[i];
      const db = b - this.B[i];
      const d = dl * dl + da * da + db * db;
      if (candIdx.length < K) {
        candIdx.push(i);
        candD.push(d);
      } else {
        let worst = 0;
        for (let k = 1; k < K; k++) if (candD[k] > candD[worst]) worst = k;
        if (d < candD[worst]) {
          candIdx[worst] = i;
          candD[worst] = d;
        }
      }
    }
    if (this.formula === '76') {
      let best = 0;
      for (let k = 1; k < candIdx.length; k++) if (candD[k] < candD[best]) best = k;
      return candIdx[best];
    }
    let bestI = candIdx[0];
    let bestD = Infinity;
    for (const i of candIdx) {
      const d = deltaE2000(l, a, b, this.L[i], this.A[i], this.B[i]);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
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

const NAMES: Record<ColorNameLang, Record<string, string>> = {
  de: {
    white: 'Weiß', cream: 'Creme', lightgray: 'Hellgrau', gray: 'Grau', darkgray: 'Dunkelgrau', black: 'Schwarz',
    red: 'Rot', orange: 'Orange', yellow: 'Gelb', lime: 'Gelbgrün', green: 'Grün', teal: 'Türkis', cyan: 'Cyan',
    blue: 'Blau', violet: 'Violett', magenta: 'Magenta', pink: 'Rosa', brown: 'Braun', beige: 'Beige', skin: 'Hautton',
    olive: 'Oliv', light: 'Hell', dark: 'Dunkel', pale: 'Blass',
  },
  en: {
    white: 'White', cream: 'Cream', lightgray: 'Light grey', gray: 'Grey', darkgray: 'Dark grey', black: 'Black',
    red: 'Red', orange: 'Orange', yellow: 'Yellow', lime: 'Lime', green: 'Green', teal: 'Teal', cyan: 'Cyan',
    blue: 'Blue', violet: 'Violet', magenta: 'Magenta', pink: 'Pink', brown: 'Brown', beige: 'Beige', skin: 'Skin tone',
    olive: 'Olive', light: 'Light', dark: 'Dark', pale: 'Pale',
  },
  tr: {
    white: 'Beyaz', cream: 'Krem', lightgray: 'Açık gri', gray: 'Gri', darkgray: 'Koyu gri', black: 'Siyah',
    red: 'Kırmızı', orange: 'Turuncu', yellow: 'Sarı', lime: 'Fıstık yeşili', green: 'Yeşil', teal: 'Turkuaz', cyan: 'Camgöbeği',
    blue: 'Mavi', violet: 'Mor', magenta: 'Macenta', pink: 'Pembe', brown: 'Kahverengi', beige: 'Bej', skin: 'Ten rengi',
    olive: 'Zeytin', light: 'Açık', dark: 'Koyu', pale: 'Soluk',
  },
};

/** Erzeugt einen beschreibenden Farbnamen aus einem Lab-Wert. */
export function describeColor(lab: Lab, lang: ColorNameLang = 'de'): string {
  const N = NAMES[lang];
  const [L, a, b] = lab;
  const C = Math.sqrt(a * a + b * b);
  let h = Math.atan2(b, a) / DEG;
  if (h < 0) h += 360;
  if (C < 8) {
    if (L > 92) return N.white;
    if (L > 82 && b > 3) return N.cream;
    if (L > 70) return N.lightgray;
    if (L > 45) return N.gray;
    if (L > 20) return N.darkgray;
    return N.black;
  }
  let base: string;
  if (h < 20 || h >= 345) base = L > 70 ? N.pink : N.red;
  else if (h < 50) {
    if (L < 55 && C < 50) base = N.brown;
    else if (L >= 55 && C < 40) base = N.skin;
    else base = N.orange;
  } else if (h < 75) {
    if (L < 50) base = N.brown;
    else if (C < 30) base = N.beige;
    else base = N.orange;
  } else if (h < 100) base = L < 50 ? N.olive : C < 25 ? N.beige : N.yellow;
  else if (h < 130) base = L < 45 ? N.olive : N.lime;
  else if (h < 170) base = N.green;
  else if (h < 210) base = N.teal;
  else if (h < 240) base = N.cyan;
  else if (h < 290) base = N.blue;
  else if (h < 320) base = N.violet;
  else base = L > 70 ? N.pink : N.magenta;
  let prefix = '';
  if (L > 75) prefix = N.light;
  else if (L < 35) prefix = N.dark;
  else if (C < 18) prefix = N.pale;
  if (!prefix) return base;
  if (lang === 'de') return prefix + base.toLowerCase();
  return `${prefix} ${base.toLowerCase()}`;
}
