import {
  danglingMaterialRefs,
  diagnosticMaterialIds,
  linkReferencedMaterials,
  mappingChangesIds,
  planProjectMaterialImport,
  referencedMaterialIds,
  remapComputeKey,
  remapIdList,
  remapMaterialRefsDeep,
  remapPaletteMaterials,
  remapPaletteSig,
  selectMaterials,
  type MaterialImportNote,
  type ProjectMaterialImportPlan,
} from '../core/materialImport';
import { invalidFreeCells } from '../core/edits';
import { cellId, computeLayout, type LayoutParams } from '../core/layout';
import { unpackMosaic } from '../core/serialize';
import { DEFAULT_ADJUST, DEFAULT_SETTINGS, type Material, type ProjectSettings, type Region } from '../core/types';
import {
  db,
  deleteProject,
  listMaterials,
  loadProjectState,
  PROJECT_STORES,
  txMulti,
  uid,
  type AppSettings,
  type ImageRecord,
  type ProjectRecord,
  type StoredMosaicNoProgress,
} from './db';

export async function createProject(
  name: string,
  app: AppSettings,
  opts: { photo?: Blob; photoName?: string; settings?: Partial<ProjectSettings>; regions?: Region[]; aspect?: number } = {},
): Promise<string> {
  const id = uid();
  const now = Date.now();
  const settings: ProjectSettings = {
    ...DEFAULT_SETTINGS,
    shapes: { ...DEFAULT_SETTINGS.shapes },
    reservePct: app.defaultReserve,
    groutHex: app.defaultGrout,
    deltaE: app.deltaE,
    unit: app.defaultUnit,
    ...opts.settings,
  };
  if (opts.aspect && !opts.settings?.heightMm) settings.heightMm = Math.round((settings.widthMm / opts.aspect) * 10) / 10;
  const rec: ProjectRecord = {
    meta: { id, name, createdAt: now, updatedAt: now, computed: false },
    settings,
    adjust: { ...DEFAULT_ADJUST },
    regions: opts.regions ?? [],
    palette: [],
    ...(opts.photo ? { imageRev: uid() } : {}),
  };
  const image: ImageRecord | null = opts.photo ? { original: opts.photo, name: opts.photoName ?? 'foto' } : null;
  // Projekt und Foto gemeinsam anlegen – nie ein Projekt mit Foto-Revision, aber ohne Foto
  await txMulti<void>(image ? ['projects', 'images'] : ['projects'], 'readwrite', (ctx) => {
    ctx.store('projects').put(rec, id);
    if (image) ctx.store('images').put(image, id);
    ctx.commit();
  });
  return id;
}

/**
 * Kopiert ein Projekt vollständig (Datensatz inkl. Revisionen, Foto, Raster, Fortschritt).
 * Gelesen wird ein zusammengehöriger Stand, geschrieben wird in einer Transaktion.
 */
export async function duplicateProject(id: string, suffix: string): Promise<string | null> {
  const st = await loadProjectState(id);
  if (!st.rec) return null;
  const r = st.rec;
  const nid = uid();
  const now = Date.now();
  const copy: ProjectRecord = { ...structuredClone(r), meta: { ...structuredClone(r.meta), id: nid, name: `${r.meta.name} ${suffix}`.trim(), createdAt: now, updatedAt: now } };
  await txMulti<void>(['projects', 'images', 'mosaics', 'progress'], 'readwrite', (ctx) => {
    ctx.store('projects').put(copy, nid);
    if (st.image) ctx.store('images').put(st.image, nid);
    if (st.mosaic) ctx.store('mosaics').put(st.mosaic, nid);
    if (st.progress) ctx.store('progress').put(st.progress, nid);
    ctx.commit();
  });
  return nid;
}

// ---------- Sicherung (Projekt als Datei, z. B. für Wechsel zwischen PC und Tablet)
function b64(buf: ArrayBufferLike): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const viewBytes = (v: ArrayBufferView) => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);

const TYPED: Record<string, new (b: ArrayBuffer) => ArrayBufferView> = {
  kind: Uint8Array,
  c1: Uint16Array,
  c2: Uint16Array,
  subIdx: Int32Array,
  subLen: Uint8Array,
  subCol: Uint16Array,
  lineIdx: Int32Array,
  lineVal: Float32Array,
  rec: Uint8Array,
};


/** Kennung der Projektdatei (*.mosaicplan.json). */
export const PROJECT_FILE_FORMAT = 'mosaicplan-project';
/**
 * Formatversion der Projektdatei:
 *  1: Projekt, Foto, Raster, Fortschritt.
 *  2: zusätzlich `materials` – die Materialien, auf die das Projekt verweist (Palettenfarben, Materialauswahl) –
 *     und bei der Auswahl „alle Materialien“ `materialPool` (Anzahl der Materialien auf dem Quellgerät).
 *     Optional `materialRefs`: Materialien, auf die nur die Diagnose verweist („Fehlende Farben“ → nächstes Material);
 *     sie werden beim Import nur vorhandenen zugeordnet, nie angelegt.
 * Ältere App-Versionen lesen Version-2-Dateien weiterhin (sie prüfen nur `format` und übergehen die Materialien).
 */
export const PROJECT_FILE_VERSION = 2;

/** Projekt rechnet mit „allen Materialien“ des Geräts (Materialmodus ohne ausdrückliche Auswahl). */
function usesAllMaterials(s: Partial<ProjectSettings> | undefined): boolean {
  return !!s && (s.paletteMode === 'materials' || s.paletteMode === 'auto-snap') && (!Array.isArray(s.materialIds) || s.materialIds.length === 0);
}

/** Materialien dieses Geräts für die Projektdatei; null, wenn sie nicht lesbar sind (Datei dann ohne Materialliste). */
async function loadMaterialsForExport(): Promise<Material[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Notfall-Sicherung bei Speicherfehlern: nie auf eine hängende Datenbank warten
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 4000);
    });
    return await Promise.race([listMaterials(), timeout]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Baut die Projektdatei aus einem gegebenen Stand. Wird sowohl für den gespeicherten Stand
 * (exportProject) als auch für den Stand im Arbeitsspeicher genutzt (Notfall-Sicherung, wenn
 * das Speichern auf dem Gerät fehlschlägt). Die Revisionen von Projekt und Raster werden
 * mitgeschrieben, damit die Zusammengehörigkeit nach dem Import prüfbar bleibt.
 *
 * Mitgenommen werden nur die Materialien, auf die das Projekt verweist (Palettenfarben und eine nicht
 * leere Materialauswahl), nie der ganze Katalog. `materials`: alle Materialien dieses Geräts; ohne Angabe
 * werden sie aus der Datenbank gelesen, `null` = nicht verfügbar (Datei dann ohne Materialliste).
 */
export async function buildProjectExport(
  rec: ProjectRecord,
  image: ImageRecord | null | undefined,
  mosaic: StoredMosaicNoProgress | null | undefined,
  progress: Uint16Array | null | undefined,
  materials?: readonly Material[] | null,
): Promise<Blob> {
  const all = materials === undefined ? await loadMaterialsForExport() : materials;
  const m: Record<string, unknown> | null = mosaic
    ? Object.fromEntries(Object.entries(mosaic).map(([k, v]) => [k, ArrayBuffer.isView(v) ? { $b64: b64(viewBytes(v)) } : v]))
    : null;
  const exportedIds = referencedMaterialIds(rec.palette, rec.settings?.materialIds);
  const refIds = diagnosticMaterialIds(rec.diagnostics, exportedIds);
  const payload = {
    format: PROJECT_FILE_FORMAT,
    version: PROJECT_FILE_VERSION,
    record: rec,
    image: image ? { name: image.name, type: image.original.type, data: b64(await image.original.arrayBuffer()) } : null,
    mosaic: m,
    progress: progress ? b64(viewBytes(progress)) : null,
    ...(all ? { materials: selectMaterials(exportedIds, all) } : {}),
    ...(all && refIds.length ? { materialRefs: selectMaterials(refIds, all) } : {}),
    ...(all && usesAllMaterials(rec.settings) ? { materialPool: { count: all.length } } : {}),
  };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

export async function exportProject(id: string): Promise<Blob> {
  const st = await loadProjectState(id);
  if (!st.rec) throw new Error('Projekt nicht gefunden');
  return buildProjectExport(st.rec, st.image, st.mosaic, st.progress);
}

// ---------- Import

/** 'not-project': keine MosaicPlan-Projektdatei · 'invalid': Projektdatei unvollständig oder beschädigt */
export class ProjectFileError extends Error {
  readonly code: 'not-project' | 'invalid';
  constructor(code: 'not-project' | 'invalid', message: string) {
    super(message);
    this.name = 'ProjectFileError';
    this.code = code;
  }
}

/** Gelesene, geprüfte Projektdatei (noch nichts gespeichert). */
export interface ParsedProjectFile {
  version: number;
  record: ProjectRecord;
  image: { name: string; type: string; bytes: Uint8Array } | null;
  mosaic: StoredMosaicNoProgress | null;
  progress: Uint16Array | null;
  /** Materialliste der Datei; null = die Datei enthält keine (Version 1 oder beim Export nicht lesbar) */
  materials: unknown[] | null;
  /** Materialien, auf die nur die Diagnose verweist (werden nur zugeordnet, nie angelegt) */
  materialRefs: unknown[];
  /** Auswahl „alle Materialien“: Anzahl der Materialien auf dem Quellgerät (falls bekannt) */
  materialPool: number | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Liest und prüft eine Projektdatei (rein, ohne Datenbank). Wirft ProjectFileError. */
export function parseProjectFile(text: string): ParsedProjectFile {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ProjectFileError('not-project', 'Keine MosaicPlan-Projektdatei');
  }
  if (!isObj(payload) || payload.format !== PROJECT_FILE_FORMAT) throw new ProjectFileError('not-project', 'Keine MosaicPlan-Projektdatei');
  const r = payload.record;
  if (!isObj(r) || !isObj(r.meta) || !isObj(r.settings) || (r.palette !== undefined && !Array.isArray(r.palette))) {
    throw new ProjectFileError('invalid', 'Projektdatei unvollständig');
  }
  try {
    const settings = { ...(r.settings as unknown as ProjectSettings) };
    if (!Array.isArray(settings.materialIds)) settings.materialIds = [];
    const record = {
      ...(r as unknown as ProjectRecord),
      meta: { ...(r.meta as unknown as ProjectRecord['meta']), name: typeof r.meta.name === 'string' ? r.meta.name : '' },
      settings,
      adjust: isObj(r.adjust) ? (r.adjust as unknown as ProjectRecord['adjust']) : { ...DEFAULT_ADJUST },
      regions: Array.isArray(r.regions) ? (r.regions as Region[]) : [],
      palette: Array.isArray(r.palette) ? (r.palette as ProjectRecord['palette']) : [],
    } as ProjectRecord;
    const img = payload.image;
    const image = isObj(img) && typeof img.data === 'string' ? { name: typeof img.name === 'string' ? img.name : 'foto', type: typeof img.type === 'string' ? img.type : '', bytes: unb64(img.data) } : null;
    let mosaic: StoredMosaicNoProgress | null = null;
    if (isObj(payload.mosaic)) {
      const m: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(payload.mosaic)) {
        if (v && typeof v === 'object' && '$b64' in (v as object)) {
          const bytes = unb64((v as { $b64: string }).$b64);
          const C = TYPED[k] ?? Uint8Array;
          m[k] = new C(bytes.buffer as ArrayBuffer);
        } else m[k] = v;
      }
      mosaic = m as StoredMosaicNoProgress;
    }
    const progress = typeof payload.progress === 'string' ? new Uint16Array(unb64(payload.progress).buffer as ArrayBuffer) : null;
    const pool = payload.materialPool;
    return {
      version: typeof payload.version === 'number' && Number.isFinite(payload.version) ? payload.version : 1,
      record,
      image,
      mosaic,
      progress,
      materials: Array.isArray(payload.materials) ? payload.materials : null,
      materialRefs: Array.isArray(payload.materialRefs) ? payload.materialRefs : [],
      materialPool: isObj(pool) && typeof pool.count === 'number' && Number.isFinite(pool.count) ? pool.count : null,
    };
  } catch (e) {
    // z. B. beschädigte Base64-Daten oder ein Raster mit falscher Bytelänge
    throw new ProjectFileError('invalid', `Projektdatei beschädigt (${e instanceof Error ? e.message : String(e)})`);
  }
}

/**
 * Eindeutiger Name für ein importiertes Projekt: unverändert, wenn noch kein Projekt so heißt, sonst mit
 * Zusatz („Porträt (Import)“, „Porträt (Import 2)“ …). Vergleich ohne Groß-/Kleinschreibung und Randleerzeichen.
 */
export function uniqueImportName(name: string, existing: readonly string[], suffix = '(Import)'): string {
  const key = (s: string) => s.trim().toLowerCase();
  const taken = new Set(existing.map(key));
  if (!taken.has(key(name))) return name;
  const base = name.trim();
  const sfx = suffix.trim() || '(Import)';
  const numbered = (i: number) => {
    if (i === 1) return `${base} ${sfx}`.trim();
    return (sfx.endsWith(')') ? `${base} ${sfx.slice(0, -1)} ${i})` : `${base} ${sfx} ${i}`).trim();
  };
  let i = 1;
  while (taken.has(key(numbered(i)))) i++;
  return numbered(i);
}

/** Ergebnis eines Projektimports (für die Rückmeldung in „Meine Projekte“). */
export interface ProjectImportSummary {
  id: string;
  name: string;
  /** Name in der Datei */
  originalName: string;
  /** Zusatz angehängt, weil schon ein Projekt so heißt */
  renamed: boolean;
  /** Formatversion der Datei */
  version: number;
  /** Datei aus einer neueren App-Version */
  newer: boolean;
  /** Datei enthält eine Materialliste (ab Version 2) */
  materialsInFile: boolean;
  /** X neu angelegt, Y vorhandenen zugeordnet, Z davon mit abweichenden Daten */
  materials: ProjectMaterialImportPlan['counts'];
  notes: MaterialImportNote[];
  /** Verweise des Projekts auf Materialien: Palettenfarben mit Material bzw. Einträge der Materialauswahl */
  refs: { colors: number; selected: number };
  /** davon ohne Material nach dem Import */
  missing: { colors: number; selected: number };
  /** Auswahl „alle Materialien“: Anzahl auf dem Quellgerät und hier (nach dem Import); null = nicht betroffen/unbekannt */
  pool: { source: number; here: number } | null;
  /**
   * Freiformsteine der Datei mit ungültigen (z. B. überlappenden) Teilen – Bezeichnungen (A001 …). Sie werden importiert
   * und im Projekt gemeldet (nicht still umgewandelt); Flächen und PDF-Plan erst nach der Korrektur.
   */
  freeInvalid: string[];
}

/** Freiformsteine eines gespeicherten Rasters mit ungültigen Teilen (Bezeichnungen); leer, wenn nicht prüfbar. */
export function invalidFreeCellIds(rec: Pick<ProjectRecord, 'computedWith'>, mosaic: StoredMosaicNoProgress | null | undefined): string[] {
  if (!mosaic || !rec.computedWith) return [];
  try {
    const lp = (JSON.parse(rec.computedWith) as { l: LayoutParams }).l;
    const layout = computeLayout(lp);
    const n = mosaic.cols * mosaic.rows;
    if (layout.cols !== mosaic.cols || layout.rows !== mosaic.rows) return [];
    const data = unpackMosaic({ ...mosaic, progress: new Uint16Array(n) });
    if (!data.free.size) return [];
    return invalidFreeCells(layout, data).map((c) => cellId(layout, c.row, c.col));
  } catch {
    // nicht lesbares Raster: das meldet die Integritätsprüfung beim Öffnen
    return [];
  }
}

/**
 * Bereitet den Import vor (rein, schreibt nichts): Abgleich der Materialien (planProjectMaterialImport),
 * Umschreiben der Material-Verweise im Projekt, eindeutiger Name und Rückmeldung.
 */
export function prepareProjectImport(
  parsed: ParsedProjectFile,
  local: readonly Material[],
  existingNames: readonly string[],
  opts: { id: string; now: number; nameSuffix?: string },
): { rec: ProjectRecord; inserts: Material[]; summary: ProjectImportSummary } {
  const plan = planProjectMaterialImport(parsed.materials ?? [], local);
  // Nur erwähnte Materialien (Diagnose „Fehlende Farben“) vorhandenen zuordnen – nie anlegen
  const mapping: Record<string, string> = { ...linkReferencedMaterials(parsed.materialRefs ?? [], local), ...plan.mapping };
  const src = parsed.record;
  let rec: ProjectRecord = structuredClone(src);
  if (mappingChangesIds(mapping)) {
    // Verweise auf die zugeordneten Materialien dieses Geräts umschreiben – auch im Berechnungsschlüssel und im
    // Paletten-Fingerabdruck, damit das Projekt nicht fälschlich als „geändert“ bzw. „bearbeitet“ gilt
    rec = {
      ...rec,
      palette: remapPaletteMaterials(rec.palette, mapping),
      settings: { ...rec.settings, materialIds: remapIdList(rec.settings.materialIds, mapping) },
      ...(rec.computedWith !== undefined ? { computedWith: remapComputeKey(rec.computedWith, mapping) } : {}),
      ...(rec.computedPaletteSig !== undefined ? { computedPaletteSig: remapPaletteSig(rec.computedPaletteSig, mapping) } : {}),
      ...(rec.diagnostics !== undefined ? { diagnostics: remapMaterialRefsDeep(rec.diagnostics, mapping) } : {}),
    };
  }
  const originalName = src.meta.name;
  const name = uniqueImportName(originalName, existingNames, opts.nameSuffix);
  rec.meta = { ...rec.meta, id: opts.id, name, updatedAt: opts.now };
  const available = new Set([...local.map((m) => m.id), ...plan.inserts.map((m) => m.id)]);
  const pool = parsed.materialPool !== null && usesAllMaterials(rec.settings) ? { source: parsed.materialPool, here: available.size } : null;
  return {
    rec,
    inserts: plan.inserts,
    summary: {
      id: opts.id,
      name,
      originalName,
      renamed: name !== originalName,
      version: parsed.version,
      newer: parsed.version > PROJECT_FILE_VERSION,
      materialsInFile: parsed.materials !== null,
      materials: plan.counts,
      notes: plan.notes,
      refs: {
        // Farben mit Material-Verweis (Grundstein oder Feinstein)
        colors: rec.palette.filter((p) => (typeof p?.materialId === 'string' && p.materialId !== '') || (typeof p?.fineMaterialId === 'string' && p.fineMaterialId !== '')).length,
        selected: rec.settings.materialIds.length,
      },
      missing: danglingMaterialRefs(rec.palette, rec.settings.materialIds, available),
      pool,
      freeInvalid: invalidFreeCellIds(rec, parsed.mosaic),
    },
  };
}

/**
 * Importiert eine Projektdatei als neues Projekt. Die Materialien der Datei werden vorhandenen zugeordnet
 * oder angelegt (siehe materialImport.ts) – vorhandene Materialien werden nie überschrieben. Alles in EINER
 * Transaktion: kein halb importiertes Projekt und kein Abgleich gegen einen inzwischen geänderten Bestand.
 * `nameSuffix`: Zusatz für den Namen, falls schon ein Projekt so heißt (Standard „(Import)“).
 */
export async function importProject(file: Blob, opts: { nameSuffix?: string } = {}): Promise<ProjectImportSummary> {
  const parsed = parseProjectFile(await file.text());
  const id = uid();
  const now = Date.now();
  const image: ImageRecord | null = parsed.image ? { name: parsed.image.name, original: new Blob([parsed.image.bytes as Uint8Array<ArrayBuffer>], { type: parsed.image.type }) } : null;
  return txMulti<ProjectImportSummary>([...PROJECT_STORES, 'materials'], 'readwrite', (ctx) => {
    ctx.on(ctx.store('materials').getAll() as IDBRequest<Material[]>, (local) => {
      ctx.on(ctx.store('projects').getAll() as IDBRequest<ProjectRecord[]>, (projects) => {
        const names = projects.map((p) => (typeof p?.meta?.name === 'string' ? p.meta.name : ''));
        const prep = prepareProjectImport(parsed, local, names, { id, now, nameSuffix: opts.nameSuffix });
        for (const m of prep.inserts) ctx.store('materials').put(m, m.id);
        ctx.store('projects').put(prep.rec, id);
        if (image) ctx.store('images').put(image, id);
        if (parsed.mosaic) ctx.store('mosaics').put(parsed.mosaic, id);
        if (parsed.progress) ctx.store('progress').put(parsed.progress, id);
        ctx.commit();
        ctx.done(prep.summary);
      });
    });
  });
}

export { deleteProject, db };
