/**
 * „Was hat sich seit der letzten Berechnung geändert?“ – exakter Vergleich des gespeicherten
 * Berechnungsschlüssels (`rec.computedWith`) mit dem Schlüssel der aktuellen Einstellungen
 * (`computeKey(rec)`), Gruppe für Gruppe. Nichts wird geschätzt: jede genannte Änderung ist ein
 * tatsächlicher Unterschied im Schlüssel. Dazu „Änderungen verwerfen“: stellt die Einstellungen
 * wieder her, mit denen das angezeigte Mosaik berechnet wurde (ohne neu zu berechnen).
 */
import type { TFunc } from '../../i18n';
import type { ProjectRecord } from '../../storage/db';

/** Geparster Berechnungsschlüssel (siehe computeKey in useProject.ts) */
interface KeyObj {
  l?: Record<string, unknown>;
  sh?: Record<string, unknown>;
  pm?: unknown;
  cc?: unknown;
  di?: unknown;
  de?: unknown;
  mi?: unknown;
  cp?: unknown;
  a?: Record<string, unknown>;
  rg?: unknown;
  im?: unknown;
}

export type StaleGroup =
  | 'size'
  | 'tile'
  | 'joint'
  | 'edge'
  | 'minCut'
  | 'layout'
  | 'shapes'
  | 'paletteMode'
  | 'colorCount'
  | 'customPalette'
  | 'materials'
  | 'dither'
  | 'deltaE'
  | 'adjust'
  | 'regions'
  | 'photo'
  | 'other';

export interface StaleReason {
  group: StaleGroup;
  /** alter und neuer Wert, wo eine Zahl/Größe aussagekräftig ist (Größe/Stein: [Breite, Höhe] in mm) */
  from?: number | number[] | string;
  to?: number | number[] | string;
  /** geänderte Felder der Fotobearbeitung */
  fields?: string[];
}

/** Diese Gruppen kann „Änderungen verwerfen“ exakt wiederherstellen. Foto und eigene Palette nicht. */
export const RESTORABLE: readonly StaleGroup[] = ['size', 'tile', 'joint', 'edge', 'minCut', 'layout', 'shapes', 'paletteMode', 'colorCount', 'materials', 'dither', 'deltaE', 'adjust', 'regions'];

/** Felder der Fotobearbeitung in der Reihenfolge der Oberfläche */
export const ADJUST_FIELDS = ['crop', 'rotation', 'fineRotate', 'flipH', 'brightness', 'contrast', 'saturation', 'sharpen', 'detailBoost', 'bgSimplify', 'autoLevels', 'whiteBalance'] as const;

const LAYOUT_FIELDS = ['widthMm', 'heightMm', 'tileW', 'tileH', 'joint', 'edgeMode', 'minCutMm'] as const;

export function parseKey(s: string | undefined | null): KeyObj | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as KeyObj) : null;
  } catch {
    return null;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Unterschiede zwischen dem Schlüssel der Berechnung und dem aktuellen Schlüssel.
 * Leer, wenn beide gleich sind. Sind die Schlüssel verschieden, ohne dass eine bekannte Gruppe
 * abweicht (z. B. unlesbarer alter Schlüssel), lautet der Grund 'other' – der Stand gilt trotzdem
 * als geändert, wie in der App (`stale`).
 */
export function staleReasons(computedWith: string | undefined, currentKey: string): StaleReason[] {
  if (computedWith === currentKey) return [];
  const a = parseKey(computedWith);
  const b = parseKey(currentKey);
  if (!a || !b) return [{ group: 'other' }];
  const out: StaleReason[] = [];
  // Raster: Größe, Steingröße, Fuge, Randmodus, kleinste Randsteinbreite
  if (!same(a.l, b.l)) {
    const la = isObj(a.l) ? a.l : {};
    const lb = isObj(b.l) ? b.l : {};
    const n0 = out.length;
    const wa = num(la.widthMm);
    const ha = num(la.heightMm);
    const wb = num(lb.widthMm);
    const hb = num(lb.heightMm);
    if (!same(la.widthMm, lb.widthMm) || !same(la.heightMm, lb.heightMm))
      out.push(wa !== undefined && ha !== undefined && wb !== undefined && hb !== undefined ? { group: 'size', from: [wa, ha], to: [wb, hb] } : { group: 'size' });
    const ta = [num(la.tileW), num(la.tileH)];
    const tb = [num(lb.tileW), num(lb.tileH)];
    if (!same(la.tileW, lb.tileW) || !same(la.tileH, lb.tileH))
      out.push([...ta, ...tb].every((x) => x !== undefined) ? { group: 'tile', from: ta as number[], to: tb as number[] } : { group: 'tile' });
    if (!same(la.joint, lb.joint)) {
      const ja = num(la.joint);
      const jb = num(lb.joint);
      out.push(ja !== undefined && jb !== undefined ? { group: 'joint', from: ja, to: jb } : { group: 'joint' });
    }
    if (!same(la.edgeMode, lb.edgeMode)) out.push({ group: 'edge' });
    if (!same(la.minCutMm, lb.minCutMm)) out.push({ group: 'minCut' });
    const known = new Set<string>(LAYOUT_FIELDS);
    const extra = [...new Set([...Object.keys(la), ...Object.keys(lb)])].some((k) => !known.has(k) && !same(la[k], lb[k]));
    if (extra || out.length === n0) out.push({ group: 'layout' });
  }
  if (!same(a.sh, b.sh)) out.push({ group: 'shapes' });
  if (!same(a.pm, b.pm)) out.push({ group: 'paletteMode' });
  if (!same(a.cc, b.cc)) {
    const ca = num(a.cc);
    const cb = num(b.cc);
    out.push(ca !== undefined && cb !== undefined ? { group: 'colorCount', from: ca, to: cb } : { group: 'colorCount' });
  }
  if (!same(a.cp, b.cp)) out.push({ group: 'customPalette' });
  if (!same(a.mi, b.mi)) out.push({ group: 'materials' });
  if (!same(a.di, b.di)) {
    const da = num(a.di);
    const db = num(b.di);
    out.push(da !== undefined && db !== undefined ? { group: 'dither', from: da, to: db } : { group: 'dither' });
  }
  if (!same(a.de, b.de)) out.push(typeof a.de === 'string' && typeof b.de === 'string' ? { group: 'deltaE', from: a.de, to: b.de } : { group: 'deltaE' });
  if (!same(a.a, b.a)) {
    const aa = isObj(a.a) ? a.a : {};
    const ab = isObj(b.a) ? b.a : {};
    const keys = [...new Set([...Object.keys(aa), ...Object.keys(ab)])].filter((k) => !same(aa[k], ab[k]));
    const order = ADJUST_FIELDS as readonly string[];
    keys.sort((x, y) => (order.indexOf(x) < 0 ? 99 : order.indexOf(x)) - (order.indexOf(y) < 0 ? 99 : order.indexOf(y)));
    out.push({ group: 'adjust', fields: keys.filter((k) => order.includes(k)) });
  }
  if (!same(a.rg, b.rg)) out.push({ group: 'regions' });
  if (!same(a.im, b.im)) out.push({ group: 'photo' });
  if (!out.length) out.push({ group: 'other' });
  return out;
}

export function isRestorable(r: StaleReason): boolean {
  return RESTORABLE.includes(r.group);
}

/**
 * Felder der Fotobearbeitung, die sich auf das Foto selbst beziehen: Zuschnitt (normierte Koordinaten im Foto),
 * Drehung und Spiegeln. Sie gehören zu genau einem Foto – setPhoto setzt sie beim Ersetzen zurück.
 */
export const PHOTO_GEOMETRY_FIELDS: readonly string[] = ['crop', 'rotation', 'fineRotate', 'flipH'];

/**
 * Was „Änderungen verwerfen“ in diesem Zusammenhang wirklich wiederherstellt. Wurde das Foto seit der
 * Berechnung ersetzt (Grund 'photo'), gehören Gesichts-/Detailbereiche und Zuschnitt/Drehung/Spiegeln der
 * Berechnung zum ALTEN Foto: Sie werden nicht auf das neue Foto übertragen (nicht wiederherstellbar). Die
 * übrigen Bildeinstellungen (Helligkeit, Kontrast …) hängen nicht vom Foto ab und bleiben wiederherstellbar.
 * Hinweistext und restoreComputedSettings richten sich beide danach.
 */
export function splitRestorable(reasons: StaleReason[]): { restorable: StaleReason[]; notRestorable: StaleReason[] } {
  const photo = reasons.some((r) => r.group === 'photo');
  const restorable: StaleReason[] = [];
  const notRestorable: StaleReason[] = [];
  for (const r of reasons) {
    if (!isRestorable(r)) notRestorable.push(r);
    else if (photo && r.group === 'regions') notRestorable.push(r);
    else if (photo && r.group === 'adjust') {
      const fields = r.fields ?? [];
      const tonal = fields.filter((f) => !PHOTO_GEOMETRY_FIELDS.includes(f));
      const geo = fields.filter((f) => PHOTO_GEOMETRY_FIELDS.includes(f));
      if (tonal.length) restorable.push({ ...r, fields: tonal });
      if (geo.length || !tonal.length) notRestorable.push({ ...r, fields: geo });
    } else restorable.push(r);
  }
  return { restorable, notRestorable };
}

/** Wurde das Foto seit der Berechnung ersetzt? (Foto-Identität im Berechnungsschlüssel ≠ aktuelle; wie staleReasons) */
export function photoChangedSince(rec: Pick<ProjectRecord, 'computedWith' | 'imageRev'>): boolean {
  const k = parseKey(rec.computedWith);
  return !!k && !same(k.im, rec.imageRev);
}

/**
 * Passt das berechnete Mosaik zum aktuellen Foto und dessen Bearbeitung (gleiches Foto, gleicher Zuschnitt,
 * gleiche Drehung und Bildeinstellungen)? Nur dann ist ein Vergleich „berechnete Steine ↔ aktuelles Foto“
 * sinnvoll (z. B. Fernwirkung inkl. Fuge). Gesichts-/Detailbereiche, Formen und Farben ändern das Foto nicht.
 */
export function computedMatchesPhoto(rec: Pick<ProjectRecord, 'computedWith' | 'imageRev' | 'adjust'>): boolean {
  const k = parseKey(rec.computedWith);
  if (!k || !same(k.im, rec.imageRev) || !isObj(k.a)) return false;
  const a = k.a;
  const b = rec.adjust as unknown as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((f) => same(a[f], b[f]));
}

/**
 * Projekt mit den Einstellungen, mit denen das gespeicherte Mosaik berechnet wurde (Raster, Formen,
 * Farbquelle/-anzahl, Mischung, ΔE-Formel, Materialauswahl, Fotobearbeitung, Bereiche).
 * Foto und eigene Palette bleiben, wie sie sind (lassen sich aus dem Schlüssel nicht vollständig
 * wiederherstellen). Wurde das Foto inzwischen ersetzt, bleiben außerdem die Gesichts-/Detailbereiche und
 * Zuschnitt/Drehung/Spiegeln des NEUEN Fotos – die der Berechnung gehören zum alten Foto (siehe splitRestorable).
 * null, wenn der Schlüssel fehlt oder unlesbar ist.
 */
export function restoreComputedSettings(rec: ProjectRecord): ProjectRecord | null {
  const k = parseKey(rec.computedWith);
  if (!k) return null;
  const settings = { ...rec.settings };
  if (isObj(k.l)) {
    const lay = settings as unknown as Record<string, unknown>;
    for (const f of LAYOUT_FIELDS) if (f in k.l) lay[f] = k.l[f];
  }
  // Neuere Formoptionen, die der alte Schlüssel nicht kennt, bleiben erhalten
  if (isObj(k.sh)) settings.shapes = { ...rec.settings.shapes, ...(k.sh as Partial<ProjectRecord['settings']['shapes']>) };
  if (k.pm === 'auto' || k.pm === 'auto-snap' || k.pm === 'materials' || k.pm === 'custom') settings.paletteMode = k.pm;
  if (num(k.cc) !== undefined) settings.colorCount = k.cc as number;
  if (num(k.di) !== undefined) settings.dither = k.di as number;
  if (k.de === '2000' || k.de === '76') settings.deltaE = k.de;
  // Materialauswahl steht nur bei Material-Modi im Schlüssel; sonst ist sie für die Berechnung ohne Bedeutung
  if (Array.isArray(k.mi) && (k.pm === 'materials' || k.pm === 'auto-snap')) settings.materialIds = (k.mi as unknown[]).filter((x): x is string => typeof x === 'string');
  const photoChanged = !same(k.im, rec.imageRev);
  let adjust = rec.adjust;
  if (isObj(k.a)) {
    const fromKey: Record<string, unknown> = { ...k.a };
    // Zuschnitt/Drehung/Spiegeln beziehen sich auf das Foto: nie vom alten auf ein neues Foto übertragen
    if (photoChanged) for (const f of PHOTO_GEOMETRY_FIELDS) delete fromKey[f];
    adjust = { ...rec.adjust, ...fromKey } as ProjectRecord['adjust'];
  }
  const regions = !photoChanged && Array.isArray(k.rg) ? (structuredCloneSafe(k.rg) as ProjectRecord['regions']) : rec.regions;
  return { ...rec, settings, adjust, regions };
}

function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Bewertung der mittleren Farbabweichung nach den Schwellen aus compute.deHint (nur für CIEDE2000 sinnvoll). */
export function deltaERating(meanDE: number): 'low' | 'mid' | 'high' | null {
  if (!Number.isFinite(meanDE)) return null;
  if (meanDE < 2) return 'low';
  if (meanDE <= 5) return 'mid';
  return 'high';
}

/** ΔE-Formel, mit der das angezeigte Ergebnis berechnet wurde (nicht die aktuell eingestellte). */
export function computedDeltaE(computedWith: string | undefined): '2000' | '76' | null {
  const k = parseKey(computedWith);
  return k && (k.de === '2000' || k.de === '76') ? k.de : null;
}

/**
 * Lesbare Bezeichnungen der Gründe (für Hinweis, Kopfzeile, Tooltip): Wertänderungen als „alt → neu“.
 * Mit `{ target: 'from' }` nur der Wert der letzten Berechnung („Steingröße 5 × 5 mm“) – für „Änderungen
 * verwerfen“, das genau diese Werte wiederherstellt.
 */
export function staleReasonLabels(reasons: StaleReason[], t: TFunc, n: (v: number, d?: number) => string, opts: { target?: 'from' } = {}): string[] {
  const dims = (v: number[] | undefined, div: number, d: number) => (v ? `${n(v[0] / div, d)} × ${n(v[1] / div, d)}` : '');
  const onlyFrom = opts.target === 'from';
  const val = <T,>(from: T, to: T, fmt: (v: T) => string) => (onlyFrom ? fmt(from) : `${fmt(from)} → ${fmt(to)}`);
  return reasons.map((r) => {
    switch (r.group) {
      case 'size':
        return Array.isArray(r.from) && Array.isArray(r.to) ? `${t('w2ws.reason.size')} ${val(r.from, r.to, (v) => dims(v, 10, 2))} cm` : t('w2ws.reason.size');
      case 'tile':
        return Array.isArray(r.from) && Array.isArray(r.to) ? `${t('w2ws.reason.tile')} ${val(r.from, r.to, (v) => dims(v, 1, 2))} mm` : t('w2ws.reason.tile');
      case 'joint':
        return typeof r.from === 'number' && typeof r.to === 'number' ? `${t('w2ws.reason.joint')} ${val(r.from, r.to, (v) => n(v, 2))} mm` : t('w2ws.reason.joint');
      case 'colorCount':
        return typeof r.from === 'number' && typeof r.to === 'number' ? `${t('w2ws.reason.colorCount')} ${val(r.from, r.to, (v) => n(v))}` : t('w2ws.reason.colorCount');
      case 'dither':
        return typeof r.from === 'number' && typeof r.to === 'number' ? `${t('w2ws.reason.dither')} ${val(r.from, r.to, (v) => n(v * 100))} %` : t('w2ws.reason.dither');
      case 'deltaE':
        return typeof r.from === 'string' && typeof r.to === 'string' ? `${t('w2ws.reason.deltaE')} ${val(r.from, r.to, deName)}` : t('w2ws.reason.deltaE');
      case 'adjust':
        return r.fields && r.fields.length ? `${t('w2ws.reason.adjust')} (${r.fields.map((f) => adjustLabel(f, t)).join(', ')})` : t('w2ws.reason.adjust');
      case 'edge':
        return t('w2ws.reason.edge');
      case 'minCut':
        return t('w2ws.reason.minCut');
      case 'layout':
        return t('w2ws.reason.layout');
      case 'shapes':
        return t('w2ws.reason.shapes');
      case 'paletteMode':
        return t('w2ws.reason.paletteMode');
      case 'customPalette':
        return t('w2ws.reason.customPalette');
      case 'materials':
        return t('w2ws.reason.materials');
      case 'regions':
        return t('w2ws.reason.regions');
      case 'photo':
        return t('w2ws.reason.photo');
      default:
        return t('w2ws.reason.other');
    }
  });
}

const deName = (d: string) => (d === '2000' ? 'CIEDE2000' : d === '76' ? 'CIE76' : d);

function adjustLabel(f: string, t: TFunc): string {
  switch (f) {
    case 'crop':
      return t('w2ws.adj.crop');
    case 'rotation':
      return t('w2ws.adj.rotation');
    case 'fineRotate':
      return t('w2ws.adj.fineRotate');
    case 'flipH':
      return t('w2ws.adj.flipH');
    case 'brightness':
      return t('w2ws.adj.brightness');
    case 'contrast':
      return t('w2ws.adj.contrast');
    case 'saturation':
      return t('w2ws.adj.saturation');
    case 'sharpen':
      return t('w2ws.adj.sharpen');
    case 'detailBoost':
      return t('w2ws.adj.detailBoost');
    case 'bgSimplify':
      return t('w2ws.adj.bgSimplify');
    case 'autoLevels':
      return t('w2ws.adj.autoLevels');
    case 'whiteBalance':
      return t('w2ws.adj.whiteBalance');
    default:
      return f;
  }
}
