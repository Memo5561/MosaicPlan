/**
 * Farbe eines Steins aus einem Kamerafoto messen (Paket w6-colour-measure). Reines Modul ohne DOM (testbar in Node).
 *
 * Ablauf:
 *  1. Optional eine neutrale Referenz antippen (weißes Papier oder Graukarte 18 %): `measureReference` mittelt die
 *     Fläche und liefert Kanalfaktoren (von Kries in linearem sRGB). Mehr als 2 % übersteuerte Pixel → abgelehnt
 *     („Referenz überbelichtet“), es wird dann NICHT korrigiert.
 *  2. Den Stein antippen: `samplePatch` verwirft übersteuerte Pixel (ein Kanal ≥ 250, Glanzlichter), sortiert die
 *     übrigen nach L* und verwirft die hellsten 10 % (restliche Spiegelungen) und die dunkelsten 10 % (Fuge,
 *     Kantenschatten). Der Rest wird in LINEAREM sRGB gemittelt (nicht in den gammakodierten Werten).
 *
 * Ehrlichkeit (Anforderung 18): Das Ergebnis ist eine Näherung. Handykameras regeln Belichtung und Weißabgleich
 * selbst und wenden Tonkurven an; ein Kameraprofil ist unbekannt. Das Ergebnis ist nie eine kalibrierte oder
 * Herstellerfarbe und wird überall als „gemessen (Näherung)“ gekennzeichnet.
 */
import { deltaE2000, hexToLab, rgbToHex, type Lab } from './color';
import type { Material } from './types';

export type Lin = [number, number, number];
export type Gains = [number, number, number];
/** Art der Referenz: 'paper' = weißes Papier (nur Farbstich), 'grey18' = Graukarte 18 % (Farbstich und Belichtung) */
export type ReferenceMode = 'paper' | 'grey18';
export type ColorSource = NonNullable<Material['colorSource']>;

/** RGBA-Pixel wie ImageData (Zeilen von oben, 4 Bytes je Pixel). */
export interface RgbaImage {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

/** Ab diesem Kanalwert gilt ein Pixel als übersteuert (Glanzlicht, ausgefressen) und wird verworfen. */
export const CLIP_LEVEL = 250;
/** Anteil, der oben und unten nach L* verworfen wird. */
export const TRIM_FRACTION = 0.1;
/** Höchstanteil übersteuerter Pixel in der Referenzfläche. */
export const REF_MAX_CLIPPED = 0.02;
/** Mindesthelligkeit (lineare Luminanz) der Referenz – darunter ist sie zu dunkel für eine Korrektur. */
export const REF_MIN_LUMINANCE = 0.02;
/** Ab dieser Streuung (ΔE2000) ist die Messfläche ungleichmäßig → Warnung. */
export const SPREAD_WARN_DE = 4;
/** Ab diesem Anteil übersteuerter Pixel in der Steinfläche → Warnung „Spiegelung“. */
export const CLIPPED_WARN_FRACTION = 0.2;
/** Höchstzahl ausgewerteter Pixel je Fläche (größere Flächen werden gleichmäßig ausgedünnt). */
export const MAX_SAMPLES = 40_000;

const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** sRGB-Kanal (0..255) → linear (0..1). */
export const srgbToLinear = (v: number): number => LIN[Math.max(0, Math.min(255, Math.round(v)))];

/** linear (0..1, wird geklemmt) → sRGB-Kanal 0..255 (gerundet). */
export function linearToSrgb(c: number): number {
  const x = Math.max(0, Math.min(1, c));
  const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

const XN = 0.95047;
const ZN = 1.08883;
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;
const f = (t: number) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);

/** Relative Luminanz Y (D65) eines linearen sRGB-Werts. */
export const luminance = (l: Lin): number => 0.2126729 * l[0] + 0.7151522 * l[1] + 0.072175 * l[2];

/** Lineares sRGB (ungerundet) → CIELAB (D65), wie color.ts, aber ohne 8-Bit-Rundung. */
export function linearToLab(l: Lin): Lab {
  const [R, G, B] = l;
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / XN;
  const y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / ZN;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Lineares sRGB → HEX (auf den sRGB-Farbraum geklemmt). */
export const linearToHex = (l: Lin): string => rgbToHex(linearToSrgb(l[0]), linearToSrgb(l[1]), linearToSrgb(l[2]));

export interface PatchResult {
  /** Mittelwert der verwendeten Pixel in linearem sRGB (nach der Korrektur, falls Faktoren angegeben) */
  lin: Lin;
  /** CIELAB des gespeicherten HEX-Werts (also genau das, was später gerechnet wird) */
  lab: Lab;
  hex: string;
  /** verwendete Pixel (nach Verwerfen und Kürzen) */
  n: number;
  /** ausgewertete Pixel der Fläche (vor dem Verwerfen) */
  total: number;
  /** Anteil übersteuerter Pixel (ein Kanal ≥ CLIP_LEVEL) an der Fläche */
  clippedFrac: number;
  /** Streuung: quadratisches Mittel des ΔE2000 jedes verwendeten Pixels zum Mittelwert */
  spreadDE: number;
  /** true, wenn die Korrektur einen Kanal über 1 bzw. unter 0 schob (HEX wurde geklemmt) */
  clamped: boolean;
}

export interface PatchOptions {
  /** Kanalfaktoren aus `whiteBalanceGains` (Standard: keine Korrektur) */
  gains?: Gains;
  /** Anteil oben/unten nach L* (Standard TRIM_FRACTION) */
  trim?: number;
}

/**
 * Mittelt eine kreisförmige Fläche (Mittelpunkt cx, cy, Radius r in Bildpixeln) robust:
 * übersteuerte Pixel weg, oben und unten je 10 % nach L* weg, Mittelwert in linearem sRGB.
 * null, wenn die Fläche außerhalb des Bilds liegt oder kein Pixel übrig bleibt.
 */
export function samplePatch(img: RgbaImage, cx: number, cy: number, r: number, opts: PatchOptions = {}): PatchResult | null {
  const { width: W, height: H, data } = img;
  const rad = Math.max(0.5, r);
  const x0 = Math.max(0, Math.floor(cx - rad));
  const x1 = Math.min(W - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad));
  const y1 = Math.min(H - 1, Math.ceil(cy + rad));
  if (x1 < x0 || y1 < y0) return null;
  const area = Math.PI * rad * rad;
  const step = area > MAX_SAMPLES ? Math.ceil(Math.sqrt(area / MAX_SAMPLES)) : 1;
  const r2 = rad * rad;
  const lins: number[] = [];
  const ls: number[] = [];
  let total = 0;
  let clipped = 0;
  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > r2) continue;
      const i = (y * W + x) * 4;
      const R = data[i];
      const G = data[i + 1];
      const B = data[i + 2];
      total++;
      if (R >= CLIP_LEVEL || G >= CLIP_LEVEL || B >= CLIP_LEVEL) {
        clipped++;
        continue;
      }
      const l: Lin = [LIN[R], LIN[G], LIN[B]];
      lins.push(l[0], l[1], l[2]);
      ls.push(linearToLab(l)[0]);
    }
  }
  if (total === 0) return null;
  const kept = ls.length;
  // alles übersteuert: kein Messwert (hex leer, nie übernehmbar)
  if (kept === 0) return { lin: [NaN, NaN, NaN], lab: [NaN, NaN, NaN], hex: '', n: 0, total, clippedFrac: clipped / total, spreadDE: NaN, clamped: false };
  const trim = Math.max(0, Math.min(0.45, opts.trim ?? TRIM_FRACTION));
  const order = Array.from({ length: kept }, (_, i) => i).sort((a, b) => ls[a] - ls[b]);
  const cut = Math.floor(kept * trim);
  const use = kept - 2 * cut > 0 ? order.slice(cut, kept - cut) : order;
  const g = opts.gains ?? [1, 1, 1];
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (const i of use) {
    sr += lins[i * 3];
    sg += lins[i * 3 + 1];
    sb += lins[i * 3 + 2];
  }
  const raw: Lin = [(sr / use.length) * g[0], (sg / use.length) * g[1], (sb / use.length) * g[2]];
  const clamped = raw.some((c) => c > 1 || c < 0);
  const lin: Lin = [Math.max(0, Math.min(1, raw[0])), Math.max(0, Math.min(1, raw[1])), Math.max(0, Math.min(1, raw[2]))];
  const meanLab = linearToLab(lin);
  let s2 = 0;
  for (const i of use) {
    const p = linearToLab([Math.min(1, lins[i * 3] * g[0]), Math.min(1, lins[i * 3 + 1] * g[1]), Math.min(1, lins[i * 3 + 2] * g[2])]);
    const d = deltaE2000(p[0], p[1], p[2], meanLab[0], meanLab[1], meanLab[2]);
    s2 += d * d;
  }
  const hex = linearToHex(lin);
  return { lin, lab: hexToLab(hex), hex, n: use.length, total, clippedFrac: clipped / total, spreadDE: Math.sqrt(s2 / use.length), clamped };
}

/**
 * Kanalfaktoren (von Kries in linearem sRGB) aus dem gemessenen Referenzwert.
 * - 'paper': Weißes Papier – nur der Farbstich wird entfernt. Die Kanäle werden auf die Luminanz der Referenz
 *   angeglichen, die Helligkeit bleibt, denn das wahre L* des Papiers ist unbekannt (keine erfundene Belichtung).
 * - 'grey18': Graukarte 18 % – Ziel linear 0,18 je Kanal, korrigiert Farbstich UND Belichtung.
 */
export function whiteBalanceGains(refLin: Lin, mode: ReferenceMode): Gains {
  const target = mode === 'grey18' ? 0.18 : luminance(refLin);
  return [target / refLin[0], target / refLin[1], target / refLin[2]];
}

/** Faktoren auf einen linearen Wert anwenden → linear (geklemmt), Lab des HEX-Werts und HEX. */
export function applyGains(lin: Lin, gains: Gains): { lin: Lin; lab: Lab; hex: string; clamped: boolean } {
  const raw: Lin = [lin[0] * gains[0], lin[1] * gains[1], lin[2] * gains[2]];
  const clamped = raw.some((c) => c > 1 || c < 0);
  const out: Lin = [Math.max(0, Math.min(1, raw[0])), Math.max(0, Math.min(1, raw[1])), Math.max(0, Math.min(1, raw[2]))];
  const hex = linearToHex(out);
  return { lin: out, lab: hexToLab(hex), hex, clamped };
}

export type ReferenceResult =
  | { ok: true; mode: ReferenceMode; lin: Lin; gains: Gains; patch: PatchResult }
  | { ok: false; reason: 'clipped' | 'dark' | 'outside'; patch: PatchResult | null };

/**
 * Referenzfläche messen. Abgelehnt (keine Korrektur!) bei mehr als 2 % übersteuerten Pixeln („Referenz
 * überbelichtet“), bei zu dunkler Referenz oder außerhalb des Bilds.
 */
export function measureReference(img: RgbaImage, cx: number, cy: number, r: number, mode: ReferenceMode): ReferenceResult {
  const patch = samplePatch(img, cx, cy, r);
  if (!patch || patch.total === 0) return { ok: false, reason: 'outside', patch };
  if (patch.clippedFrac > REF_MAX_CLIPPED || patch.n === 0) return { ok: false, reason: 'clipped', patch };
  if (luminance(patch.lin) < REF_MIN_LUMINANCE || Math.min(...patch.lin) <= 0) return { ok: false, reason: 'dark', patch };
  return { ok: true, mode, lin: patch.lin, gains: whiteBalanceGains(patch.lin, mode), patch };
}

/** Hinweise zu einer Steinmessung (für die Anzeige; alle Werte bleiben Näherungen). */
export function measureWarnings(p: PatchResult, hasReference: boolean): ('spread' | 'clipped' | 'no-reference' | 'clamped' | 'empty')[] {
  const w: ('spread' | 'clipped' | 'no-reference' | 'clamped' | 'empty')[] = [];
  if (p.n === 0) w.push('empty');
  if (p.spreadDE > SPREAD_WARN_DE) w.push('spread');
  if (p.clippedFrac > CLIPPED_WARN_FRACTION) w.push('clipped');
  if (p.clamped) w.push('clamped');
  if (!hasReference) w.push('no-reference');
  return w;
}

/** ΔE2000 zwischen zwei HEX-Werten (ungültig → NaN). */
export function deltaEHex(a: string, b: string): number {
  try {
    const p = hexToLab(a);
    const q = hexToLab(b);
    return deltaE2000(p[0], p[1], p[2], q[0], q[1], q[2]);
  } catch {
    return NaN;
  }
}

/** Referenzart der Messung → gespeicherter Wert in Material.colorSource.reference. */
export const referenceOf = (mode: ReferenceMode | null): ColorSource['reference'] => (mode === 'paper' ? 'white' : mode === 'grey18' ? 'grey' : 'none');

/** Herkunftsangabe einer Fotomessung (Streuung auf 0,1 ΔE gerundet, so wie sie angezeigt und exportiert wird). */
export function photoSource(mode: ReferenceMode | null, spreadDE: number, now: Date = new Date()): ColorSource {
  return { kind: 'photo', measuredAt: now.toISOString(), reference: referenceOf(mode), spreadDE: Math.round(spreadDE * 10) / 10 };
}

/**
 * Herkunftsangabe eines gespeicherten Materials prüfen (Daten können aus Projektdateien anderer Geräte stammen).
 * Ungültiges → undefined bzw. das Feld weggelassen; nie geraten.
 */
export function readColorSource(raw: unknown): ColorSource | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'manual' && o.kind !== 'eyedropper' && o.kind !== 'photo') return undefined;
  const out: ColorSource = { kind: o.kind };
  if (o.kind !== 'photo') return out;
  if (typeof o.measuredAt === 'string' && Number.isFinite(Date.parse(o.measuredAt))) out.measuredAt = o.measuredAt;
  if (o.reference === 'none' || o.reference === 'white' || o.reference === 'grey') out.reference = o.reference;
  if (typeof o.spreadDE === 'number' && Number.isFinite(o.spreadDE) && o.spreadDE >= 0) out.spreadDE = o.spreadDE;
  return out;
}

/** Zwei Herkunftsangaben gleich (in der Genauigkeit des CSV-Exports: Streuung auf 0,1 ΔE)? */
export function sameColorSource(a: unknown, b: unknown): boolean {
  const x = readColorSource(a);
  const y = readColorSource(b);
  if (!x || !y) return !x && !y;
  const sp = (v?: number) => (v === undefined ? null : Math.round(v * 10));
  return x.kind === y.kind && (x.reference ?? null) === (y.reference ?? null) && sp(x.spreadDE) === sp(y.spreadDE) && (x.measuredAt ?? null) === (y.measuredAt ?? null);
}
