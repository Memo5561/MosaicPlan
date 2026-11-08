/**
 * Materialien beim Übertragen eines Projekts zwischen Geräten (Projektdatei *.mosaicplan.json).
 *
 * Eine Projektdatei (ab Version 2) enthält die Materialien, auf die das Projekt verweist: die Materialien
 * der Palettenfarben (palette[].materialId) und eine ausdrückliche Materialauswahl (settings.materialIds).
 * Beim Import wird jedes Material der Datei einem Material dieses Geräts zugeordnet oder neu angelegt:
 *
 *  1. Gleiche ID vorhanden → das Material dieses Geräts bleibt unverändert (wird nie überschrieben).
 *     Weichen seine Daten von der Datei ab, wird das mit den Feldern gemeldet.
 *  2. Sonst exakt gleicher Schlüssel aus Hersteller + Produkt + Farbnummer + Länge × Breite (Text ohne
 *     Groß-/Kleinschreibung, Umlaute/Akzente und Mehrfach-Leerzeichen; Maße exakt) → diesem Material
 *     zugeordnet, die Verweise im Projekt zeigen danach auf dessen ID. Ohne Hersteller oder Farbnummer gibt
 *     es keinen Schlüssel; dann zählt nur ein Material, das in allen beschreibenden Feldern gleich ist.
 *  3. Sonst wird das Material der Datei mit seiner ursprünglichen ID angelegt.
 *
 * Es wird nie ein „ähnliches“ oder „nächstes“ Material gewählt: Passen mehrere Materialien dieses Geräts
 * gleich gut, oder ist das passende schon einem anderen Material der Datei zugeordnet, wird das Material
 * der Datei angelegt und das gemeldet.
 *
 * Reines Modul ohne Speicher-, UI- oder i18n-Abhängigkeiten (testbar in Node).
 */
import { changedFields, foldText, normalizeHex } from './materialsCsv';
import type { Material } from './types';

export const MATERIAL_TYPES: readonly Material['type'][] = ['glass', 'ceramic', 'smalti', 'stone', 'other'];

const TEXT_FIELDS = ['manufacturer', 'product', 'colorNumber', 'colorName', 'packageSize'] as const;
const NUMBER_FIELDS = ['lengthMm', 'widthMm', 'thicknessMm', 'price', 'piecesPerPack'] as const;
/** Felder, die beim Abgleich ohne Schlüssel (kein Hersteller/keine Farbnummer) nicht gleich sein müssen */
const UNKEYED_IGNORE = new Set<keyof Material>(['stock', 'notes']);

/** Text für den Abgleich: ohne Groß-/Kleinschreibung, Umlaute/Akzente und mehrfache Leerzeichen. */
export const normText = (s: unknown): string =>
  foldText(typeof s === 'string' ? s : '')
    .replace(/\s+/g, ' ')
    .trim();

/** Kurzbezeichnung eines Materials („Hersteller Produkt Farbnummer · Farbe“). */
export function materialLabel(m: Pick<Material, 'manufacturer' | 'product' | 'colorNumber' | 'colorName' | 'hex'>): string {
  const main = [m.manufacturer, m.product, m.colorNumber]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const name = (m.colorName ?? '').trim();
  if (main && name) return `${main} · ${name}`;
  return main || name || m.hex;
}

// ---------------------------------------------------------------- Export

/**
 * IDs der Materialien, auf die ein Projekt verweist: Palettenfarben und eine nicht leere Materialauswahl
 * (leere Auswahl = „alle Materialien“ – dann wird nicht der ganze Katalog mitgenommen). Ohne Doppelte,
 * in der Reihenfolge des ersten Vorkommens.
 */
export function referencedMaterialIds(palette: readonly { materialId?: string }[] | undefined, materialIds: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id === 'string' && id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  for (const p of palette ?? []) add(p?.materialId);
  for (const id of materialIds ?? []) add(id);
  return out;
}

/** Die Materialien zu `ids`, die auf diesem Gerät vorhanden sind (Reihenfolge wie `ids`). */
export function selectMaterials(ids: readonly string[], all: readonly Material[]): Material[] {
  const byId = new Map(all.map((m) => [m.id, m]));
  return ids.map((id) => byId.get(id)).filter((m): m is Material => !!m);
}

// ---------------------------------------------------------------- Import: Prüfen der Datei

export type InvalidMaterialReason = 'not-object' | 'id' | 'hex';

export type SanitizedMaterial = { ok: true; material: Material; repaired: (keyof Material)[] } | { ok: false; id: string; reason: InvalidMaterialReason };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Prüft ein Material aus einer Projektdatei. Unbrauchbar ist es ohne ID oder ohne gültigen HEX-Wert.
 * Unlesbare Einzelwerte werden auf den „unbekannt“-Wert der App gesetzt (Text leer, Zahl 0, Bestand
 * unbekannt, Art „Sonstiges“) und als `repaired` gemeldet – nie geraten. Weitere Felder (z. B. aus einer
 * neueren App-Version) bleiben erhalten.
 */
export function sanitizeMaterial(raw: unknown): SanitizedMaterial {
  if (!isObj(raw)) return { ok: false, id: '', reason: 'not-object' };
  const id = raw.id;
  if (typeof id !== 'string' || !id.trim()) return { ok: false, id: typeof id === 'string' ? id : '', reason: 'id' };
  const hex = typeof raw.hex === 'string' ? normalizeHex(raw.hex) : null;
  if (!hex) return { ok: false, id, reason: 'hex' };
  const repaired: (keyof Material)[] = [];
  const m = { ...raw, id, hex } as Record<string, unknown>;
  if (!MATERIAL_TYPES.includes(raw.type as Material['type'])) {
    if (raw.type !== undefined) repaired.push('type');
    m.type = 'other';
  }
  for (const f of TEXT_FIELDS) {
    if (typeof raw[f] !== 'string') {
      if (raw[f] !== undefined && raw[f] !== null) repaired.push(f);
      m[f] = '';
    }
  }
  for (const f of NUMBER_FIELDS) {
    const v = raw[f];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      if (v !== undefined && v !== null) repaired.push(f);
      m[f] = 0;
    }
  }
  const stock = raw.stock;
  if (stock !== undefined && (typeof stock !== 'number' || !Number.isFinite(stock) || stock < 0)) {
    if (stock !== null) repaired.push('stock');
    delete m.stock;
  }
  if (raw.notes !== undefined && typeof raw.notes !== 'string') {
    if (raw.notes !== null) repaired.push('notes');
    delete m.notes;
  }
  return { ok: true, material: m as unknown as Material, repaired };
}

// ---------------------------------------------------------------- Import: Abgleich

export type MaterialImportNote =
  /** zugeordnetes Material dieses Geräts (gleiche ID bzw. gleicher Schlüssel) hat andere Daten als die Datei – es bleibt unverändert */
  | { kind: 'differs'; how: 'same-id' | 'matched'; exported: Material; local: Material; fields: (keyof Material)[] }
  /** mehrere Materialien dieses Geräts passen gleich gut → nicht geraten, Material der Datei angelegt */
  | { kind: 'ambiguous'; exported: Material; candidates: number }
  /** das passende Material ist schon einem anderen Material der Datei zugeordnet → Material der Datei angelegt */
  | { kind: 'taken'; exported: Material; local: Material }
  /** unbrauchbarer Eintrag der Datei (Verweise darauf bleiben ohne Material) */
  | { kind: 'invalid'; id: string; reason: InvalidMaterialReason }
  /** dieselbe ID mehrfach in der Datei – nur der erste Eintrag zählt */
  | { kind: 'duplicate'; id: string }
  /** unlesbare Einzelwerte auf „unbekannt“ gesetzt (siehe sanitizeMaterial) */
  | { kind: 'repaired'; exported: Material; fields: (keyof Material)[] };

export interface MaterialLink {
  exportedId: string;
  localId: string;
  how: 'same-id' | 'matched';
  /** Felder, in denen das Material dieses Geräts von der Datei abweicht (leer = gleich) */
  differs: (keyof Material)[];
}

export interface ProjectMaterialImportPlan {
  /** ID in der Datei → ID auf diesem Gerät, für jedes aufgelöste Material (bei gleicher ID und Neuanlage unverändert) */
  mapping: Record<string, string>;
  /** neu anzulegende Materialien (mit ihrer ursprünglichen ID) */
  inserts: Material[];
  /** Materialien der Datei, die einem vorhandenen Material zugeordnet wurden */
  links: MaterialLink[];
  notes: MaterialImportNote[];
  counts: {
    /** X: neu angelegt */
    inserted: number;
    /** Y: vorhandenen zugeordnet (gleiche ID oder gleicher Schlüssel) */
    linked: number;
    /** Z: davon mit abweichenden Daten */
    differing: number;
  };
}

/** Schlüssel Hersteller + Produkt + Farbnummer + Länge × Breite; null ohne Hersteller oder Farbnummer. */
export function materialKey(m: Pick<Material, 'manufacturer' | 'product' | 'colorNumber' | 'lengthMm' | 'widthMm'>): string | null {
  const mfr = normText(m.manufacturer);
  const no = normText(m.colorNumber);
  if (!mfr || !no) return null;
  return [mfr, normText(m.product), no, String(m.lengthMm), String(m.widthMm)].join('\u0001');
}

/** Ohne Schlüssel: in allen beschreibenden Feldern gleich (Bestand und Notiz dürfen abweichen). */
function sameUnkeyed(a: Material, b: Material): boolean {
  return changedFields(a, b).every((f) => UNKEYED_IGNORE.has(f));
}

/**
 * Abgleich der Materialien einer Projektdatei mit den Materialien dieses Geräts (siehe Kopfkommentar).
 * Schreibt nichts und verändert keine Eingabe.
 */
export function planProjectMaterialImport(exported: readonly unknown[], local: readonly Material[]): ProjectMaterialImportPlan {
  const notes: MaterialImportNote[] = [];
  const byId = new Map(local.map((m) => [m.id, m]));
  const valid: Material[] = [];
  const seen = new Set<string>();
  for (const raw of exported) {
    const s = sanitizeMaterial(raw);
    if (!s.ok) {
      notes.push({ kind: 'invalid', id: s.id, reason: s.reason });
      continue;
    }
    if (seen.has(s.material.id)) {
      notes.push({ kind: 'duplicate', id: s.material.id });
      continue;
    }
    seen.add(s.material.id);
    if (s.repaired.length) notes.push({ kind: 'repaired', exported: s.material, fields: s.repaired });
    valid.push(s.material);
  }

  const mapping: Record<string, string> = {};
  const links: MaterialLink[] = [];
  const inserts: Material[] = [];
  /** vorhandene Materialien, die schon einem Material der Datei zugeordnet sind */
  const claimed = new Set<string>();

  // 1. gleiche ID: vorhandenes Material bleibt
  const rest: Material[] = [];
  for (const e of valid) {
    const l = byId.get(e.id);
    if (!l) {
      rest.push(e);
      continue;
    }
    claimed.add(l.id);
    mapping[e.id] = l.id;
    const differs = changedFields(e, l);
    links.push({ exportedId: e.id, localId: l.id, how: 'same-id', differs });
    if (differs.length) notes.push({ kind: 'differs', how: 'same-id', exported: e, local: l, fields: differs });
  }

  // 2. exakter Schlüssel, 3. sonst neu mit eigener ID
  const keyed = new Map<string, Material[]>();
  for (const l of local) {
    const k = materialKey(l);
    if (k === null) continue;
    const list = keyed.get(k);
    if (list) list.push(l);
    else keyed.set(k, [l]);
  }
  const unkeyed = local.filter((l) => materialKey(l) === null);
  for (const e of rest) {
    const k = materialKey(e);
    const cands = k === null ? unkeyed.filter((l) => sameUnkeyed(e, l)) : (keyed.get(k) ?? []);
    let target: Material | undefined;
    if (cands.length === 1) target = cands[0];
    else if (cands.length > 1) {
      // mehrere: nur ein in allen Feldern gleiches Material ist eindeutig – sonst nie raten
      const same = cands.filter((l) => changedFields(e, l).length === 0);
      if (same.length === 1) target = same[0];
      else notes.push({ kind: 'ambiguous', exported: e, candidates: cands.length });
    }
    if (target && claimed.has(target.id)) {
      notes.push({ kind: 'taken', exported: e, local: target });
      target = undefined;
    }
    if (target) {
      claimed.add(target.id);
      mapping[e.id] = target.id;
      const differs = changedFields(e, target);
      links.push({ exportedId: e.id, localId: target.id, how: 'matched', differs });
      if (differs.length) notes.push({ kind: 'differs', how: 'matched', exported: e, local: target, fields: differs });
      continue;
    }
    mapping[e.id] = e.id;
    inserts.push(e);
  }

  return {
    mapping,
    inserts,
    links,
    notes,
    counts: { inserted: inserts.length, linked: links.length, differing: links.filter((l) => l.differs.length > 0).length },
  };
}

// ---------------------------------------------------------------- Import: Verweise umschreiben

export type IdMapping = Readonly<Record<string, string>>;

const has = (m: IdMapping, id: string) => Object.prototype.hasOwnProperty.call(m, id);

/** Ändert die Zuordnung überhaupt eine ID? (Nur dann werden Verweise umgeschrieben.) */
export function mappingChangesIds(m: IdMapping): boolean {
  return Object.entries(m).some(([a, b]) => a !== b);
}

export function remapId(id: string, m: IdMapping): string {
  return has(m, id) ? m[id] : id;
}

/** IDs-Liste umschreiben; Doppelte (zwei IDs → dasselbe Material) werden entfernt, Reihenfolge bleibt. */
export function remapIdList(ids: readonly string[], m: IdMapping): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const n = typeof id === 'string' ? remapId(id, m) : id;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Palette mit umgeschriebenen Material-Verweisen (unveränderte Einträge bleiben dieselben Objekte). */
export function remapPaletteMaterials<T extends { materialId?: string }>(palette: readonly T[], m: IdMapping): T[] {
  return palette.map((p) => (p && typeof p.materialId === 'string' && remapId(p.materialId, m) !== p.materialId ? { ...p, materialId: remapId(p.materialId, m) } : p));
}

/**
 * Berechnungsschlüssel (computedWith, JSON) mit umgeschriebener Materialauswahl `mi`, damit ein importiertes
 * Projekt nicht fälschlich als „Einstellungen geändert“ gilt. Nicht lesbare oder nicht eindeutig
 * wiederherstellbare Schlüssel bleiben Zeichen für Zeichen unverändert.
 */
export function remapComputeKey(key: string | undefined, m: IdMapping): string | undefined {
  if (!key) return key;
  try {
    const k = JSON.parse(key) as unknown;
    if (!isObj(k) || !Array.isArray(k.mi) || JSON.stringify(k) !== key) return key;
    const mi = remapIdList(k.mi as string[], m);
    if (mi.length === k.mi.length && mi.every((v, i) => v === (k.mi as string[])[i])) return key;
    return JSON.stringify({ ...k, mi });
  } catch {
    return key;
  }
}

/**
 * Paletten-Fingerabdruck (Farbnummer → JSON [hex, materialId, name], siehe paletteEntrySig) mit
 * umgeschriebenen Material-IDs, damit importierte Farben nicht als „bearbeitet“ zählen.
 */
export function remapPaletteSig(sig: Record<string, string> | undefined, m: IdMapping): Record<string, string> | undefined {
  if (!sig || !isObj(sig)) return sig;
  const out: Record<string, string> = {};
  for (const [code, v] of Object.entries(sig)) {
    out[code] = v;
    if (typeof v !== 'string') continue;
    try {
      const a = JSON.parse(v) as unknown;
      if (Array.isArray(a) && typeof a[1] === 'string' && remapId(a[1], m) !== a[1] && JSON.stringify(a) === v) {
        const b = [...a];
        b[1] = remapId(a[1], m);
        out[code] = JSON.stringify(b);
      }
    } catch {
      /* unverändert */
    }
  }
  return out;
}

/**
 * Material-Verweise in beliebigen Zusatzdaten (z. B. Berechnungsdiagnose) umschreiben: Felder, deren Name
 * auf „materialId“ endet (Text), bzw. auf „materialIds“ (Liste). Unveränderte Teile bleiben dieselben Objekte.
 */
export function remapMaterialRefsDeep<T>(value: T, m: IdMapping): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const y = walk(x);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? out : v;
    }
    if (!isObj(v)) return v;
    let out: Record<string, unknown> | null = null;
    for (const [k, x] of Object.entries(v)) {
      let y: unknown = x;
      if (typeof x === 'string' && /materialid$/i.test(k)) y = remapId(x, m);
      else if (Array.isArray(x) && /materialids$/i.test(k) && x.every((i) => typeof i === 'string')) {
        const r = remapIdList(x as string[], m);
        y = r.length === x.length && r.every((id, i) => id === x[i]) ? x : r;
      } else y = walk(x);
      if (y !== x) {
        out ??= { ...v };
        out[k] = y;
      }
    }
    return out ?? v;
  };
  return walk(value) as T;
}

/**
 * Verweise, die nach dem Import ins Leere zeigen: Palettenfarben mit Material-ID ohne Material
 * (Materialbedarf dieser Farben: Rohsteinmaß = Rastermaß, ohne Packungen/Kosten) und Einträge der
 * ausdrücklichen Materialauswahl ohne Material.
 */
export function danglingMaterialRefs(palette: readonly { materialId?: string }[], materialIds: readonly string[], available: ReadonlySet<string>): { colors: number; selected: number } {
  return {
    colors: palette.filter((p) => typeof p?.materialId === 'string' && p.materialId !== '' && !available.has(p.materialId)).length,
    selected: materialIds.filter((id) => !available.has(id)).length,
  };
}
