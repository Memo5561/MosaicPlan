/**
 * Lokale Speicherung in IndexedDB (keine Cloud). Große Binärdaten (Foto,
 * Mosaikraster, Fortschritt) liegen in eigenen Stores, damit Fortschritts-
 * änderungen nicht das ganze Mosaik neu schreiben.
 *
 * Zusammengehörige Daten (Projekt + Raster + Fortschritt) werden in EINER
 * Transaktion geschrieben, damit nach einem Absturz oder Neuladen nie ein
 * halber Stand übrig bleibt. Schreibtransaktionen werden nach der letzten
 * Anfrage sofort festgeschrieben (`commit()`), damit sie auch beim Schließen
 * oder Neuladen der Seite ankommen.
 */
import type { StoredMosaic } from '../core/serialize';
import type { ComputeDiagnostics } from '../core/mosaic';
import type { PdfOptions } from '../core/pdfOptions';
import type { ImageAdjust, Material, PaletteColor, ProjectMeta, ProjectSettings, Region } from '../core/types';

const DB_NAME = 'mosaicplan';
const DB_VERSION = 1;
const STORES = ['projects', 'images', 'mosaics', 'progress', 'materials', 'kv'];
/** Stores, die je Projekt einen Eintrag unter der Projekt-ID haben */
export const PROJECT_STORES = ['projects', 'images', 'mosaics', 'progress'] as const;

export interface ProjectRecordMeta extends ProjectMeta {
  /** Anzahl manueller Änderungen am Raster seit der letzten Berechnung (Steinfarbe/-form, Farbe entfernt) */
  manualEdits?: number;
}

export interface ProjectRecord {
  meta: ProjectRecordMeta;
  settings: ProjectSettings;
  adjust: ImageAdjust;
  regions: Region[];
  palette: PaletteColor[];
  diagnostics?: ComputeDiagnostics;
  pdfOptions?: Partial<PdfOptions>;
  /** Einstellungen, mit denen das gespeicherte Mosaik berechnet wurde */
  computedWith?: string;
  /**
   * Revision des gespeicherten Rasters (= `mosaics[id].rev`). Wird nur von einer Berechnung neu
   * vergeben und immer zusammen mit dem Raster gespeichert. Fehlt bei älteren Projekten.
   */
  mosaicRev?: string;
  /** Identität des aktuellen Fotos; neu bei jedem Fotowechsel. Fehlt bei älteren Projekten. */
  imageRev?: string;
  /** `imageRev` des Fotos, aus dem das gespeicherte Mosaik berechnet wurde */
  computedImageRev?: string;
}

export interface ImageRecord {
  original: Blob;
  name: string;
}

/** Gespeichertes Raster ohne Fortschritt (der liegt im Store 'progress'). */
export type StoredMosaicNoProgress = Omit<StoredMosaic, 'progress'>;

/** Fehlertext, mit dem Schreibvorgänge für ein gelöschtes Projekt abgelehnt werden. */
export const DELETED = 'deleted';
export const isDeletedError = (e: unknown) => e instanceof Error && e.message === DELETED;

function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  if (e && typeof e === 'object' && 'name' in e) {
    const x = e as { name: string; message?: string };
    const err = new Error(x.message || x.name);
    err.name = x.name;
    return err;
  }
  return new Error(e === undefined || e === null ? 'Transaktion abgebrochen' : String(e));
}
const hasName = (e: unknown, name: string) => !!e && typeof e === 'object' && (e as { name?: string }).name === name;

// ---------- Verbindung
let dbp: Promise<IDBDatabase> | null = null;
let current: IDBDatabase | null = null;

function forget(db: IDBDatabase | null) {
  if (db && current === db) {
    current = null;
    dbp = null;
  }
}

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => {
      const db = req.result;
      current = db;
      // Vom Browser geschlossen (z. B. Websitedaten gelöscht) → beim nächsten Zugriff neu öffnen
      db.onclose = () => forget(db);
      // Andere Seite will die Datenbank aktualisieren → freigeben und später neu öffnen
      db.onversionchange = () => {
        forget(db);
        db.close();
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  dbp = p;
  p.catch(() => {
    if (dbp === p) dbp = null;
  });
  return p;
}

// ---------- Transaktionen
export interface TxCtx<T> {
  store(name: string): IDBObjectStore;
  /** Ruft `cb` mit dem Ergebnis der Anfrage auf. Ausnahmen in `cb` brechen die Transaktion ab. */
  on<R>(req: IDBRequest<R>, cb: (result: R) => void): void;
  /** Bricht die Transaktion ab; das Promise wird mit `err` abgelehnt, nichts wird geschrieben. */
  abort(err: Error): void;
  /** Nach der letzten Anfrage aufrufen: schreibt sofort fest (auch wenn die Seite gerade geschlossen wird). */
  commit(): void;
  /** Ergebnis, mit dem das Promise nach erfolgreichem Abschluss erfüllt wird. */
  done(v: T): void;
}

/**
 * Eine Transaktion über mehrere Stores. `fn` darf nur IndexedDB-Anfragen stellen und in deren
 * Rückrufen (`ctx.on`) weitere Anfragen stellen – kein `await` auf andere Promises, sonst wird die
 * Transaktion vorzeitig beendet. Wirft `fn` oder ein Rückruf, wird alles verworfen und das Promise
 * abgelehnt (keine unbehandelten Ausnahmen). Ist die Verbindung geschlossen worden
 * (InvalidStateError) oder meldet der Browser einen UnknownError, wird einmal mit einer neuen
 * Verbindung wiederholt.
 */
export function txMulti<T = void>(stores: readonly string[], mode: IDBTransactionMode, fn: (ctx: TxCtx<T>) => void): Promise<T> {
  const attempt = (retried: boolean): Promise<T> =>
    open().then((db) => {
      let t: IDBTransaction;
      try {
        t = db.transaction(stores as string[], mode);
      } catch (e) {
        if (!retried && hasName(e, 'InvalidStateError')) {
          forget(db);
          return attempt(true);
        }
        throw toError(e);
      }
      return new Promise<T>((resolve, reject) => {
        let result: T | undefined;
        let failure: Error | null = null;
        let committed = false;
        const fail = (e: unknown) => {
          if (!failure) failure = toError(e);
          try {
            t.abort();
          } catch {
            /* Transaktion bereits beendet */
          }
        };
        const ctx: TxCtx<T> = {
          store: (name) => t.objectStore(name),
          on: (req, cb) => {
            req.onsuccess = () => {
              try {
                cb(req.result);
              } catch (e) {
                fail(e);
              }
            };
          },
          abort: (err) => fail(err),
          commit: () => {
            if (committed || mode === 'readonly' || typeof t.commit !== 'function') return;
            committed = true;
            try {
              t.commit();
            } catch {
              /* ältere Browser / bereits beendet: Transaktion schließt dann von selbst */
            }
          },
          done: (v) => {
            result = v;
          },
        };
        t.oncomplete = () => resolve(result as T);
        t.onabort = () => {
          const err = failure ?? (t.error ? toError(t.error) : new Error('Transaktion abgebrochen'));
          if (!failure && !retried && hasName(err, 'UnknownError')) {
            forget(db);
            attempt(true).then(resolve, reject);
            return;
          }
          reject(err);
        };
        try {
          fn(ctx);
        } catch (e) {
          fail(e);
        }
      });
    });
  return attempt(false);
}

/** Eine Transaktion mit genau einer Anfrage (Schreibvorgänge werden sofort festgeschrieben). */
function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return txMulti<T>([store], mode, (ctx) => {
    const r = fn(ctx.store(store));
    if (r) ctx.on(r, (v) => ctx.done(v));
    ctx.commit();
  });
}

export const db = {
  get<T>(store: string, key: string): Promise<T | undefined> {
    return tx<T>(store, 'readonly', (s) => s.get(key) as IDBRequest<T>);
  },
  put<T>(store: string, key: string, value: T): Promise<void> {
    return tx<void>(store, 'readwrite', (s) => {
      s.put(value, key);
    });
  },
  del(store: string, key: string): Promise<void> {
    return tx<void>(store, 'readwrite', (s) => {
      s.delete(key);
    });
  },
  all<T>(store: string): Promise<T[]> {
    return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },
  keys(store: string): Promise<string[]> {
    return tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys()).then((k) => k.map(String));
  },
  clear(store: string): Promise<void> {
    return tx<void>(store, 'readwrite', (s) => {
      s.clear();
    });
  },
};

// ---------- Ereignisse (gleiche Seite + andere Tabs)
export type StoreEvent =
  /** Eine Berechnung wurde gespeichert (Projekt, Raster und Fortschritt gemeinsam) */
  | { type: 'computed'; id: string; mosaicRev: string; source?: string }
  /** Projekt wurde gelöscht */
  | { type: 'deleted'; id: string; source?: string }
  /**
   * Eine Berechnung für dieses Projekt läuft (active, regelmäßig wiederholt) bzw. ist beendet.
   * `source` kennzeichnet die Berechnung; nur für andere Tabs (siehe computeLock.ts).
   */
  | { type: 'computing'; id: string; active: boolean; source: string };

const listeners = new Set<(e: StoreEvent) => void>();
let channel: BroadcastChannel | null | undefined;

function deliver(e: StoreEvent) {
  for (const l of [...listeners]) {
    try {
      l(e);
    } catch (err) {
      console.warn(err);
    }
  }
}

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  channel = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel('mosaicplan');
      ch.onmessage = (ev: MessageEvent) => {
        const e = ev.data as StoreEvent | null;
        if (e && typeof e === 'object' && (e.type === 'computed' || e.type === 'deleted' || e.type === 'computing') && typeof e.id === 'string') deliver(e);
      };
      (ch as unknown as { unref?: () => void }).unref?.();
      channel = ch;
    }
  } catch {
    channel = null;
  }
  return channel;
}

/** Benachrichtigung über gespeicherte Berechnungen und Löschungen – auch aus anderen Tabs. */
export function onStoreEvent(fn: (e: StoreEvent) => void): () => void {
  getChannel();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(e: StoreEvent) {
  deliver(e);
  broadcast(e);
}

/** Nur an andere Tabs senden (nicht an die Empfänger in dieser Seite). */
export function broadcast(e: StoreEvent) {
  try {
    getChannel()?.postMessage(e);
  } catch {
    /* ohne BroadcastChannel nur in dieser Seite */
  }
}

// ---------- Projekte
export async function listProjects(): Promise<ProjectRecord[]> {
  const all = await db.all<ProjectRecord>('projects');
  return all.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt);
}
export const loadProject = (id: string) => db.get<ProjectRecord>('projects', id);
/** Schreibt einen Projektdatensatz ohne Prüfung (neue Projekte, Import). Bearbeitungen laufen über saveProjectState. */
export const saveProject = (p: ProjectRecord) => db.put('projects', p.meta.id, p);
export const loadImage = (id: string) => db.get<ImageRecord>('images', id);
export const saveImage = (id: string, r: ImageRecord) => db.put('images', id, r);
export const loadMosaic = (id: string) => db.get<StoredMosaicNoProgress>('mosaics', id);
export const saveMosaic = (id: string, m: StoredMosaicNoProgress) => db.put('mosaics', id, m);
export const loadProgress = (id: string) => db.get<Uint16Array>('progress', id);
export const saveProgress = (id: string, p: Uint16Array) => db.put('progress', id, p);

export interface ProjectState {
  rec?: ProjectRecord;
  image?: ImageRecord;
  mosaic?: StoredMosaicNoProgress;
  progress?: Uint16Array;
}

/** Liest Projekt, Raster, Fortschritt (und optional das Foto) als einen zusammengehörigen Stand. */
export function loadProjectState(id: string, opts: { image?: boolean } = {}): Promise<ProjectState> {
  const stores = opts.image === false ? ['projects', 'mosaics', 'progress'] : [...PROJECT_STORES];
  return txMulti<ProjectState>(stores, 'readonly', (ctx) => {
    const out: ProjectState = {};
    ctx.done(out);
    ctx.on(ctx.store('projects').get(id) as IDBRequest<ProjectRecord | undefined>, (v) => (out.rec = v));
    ctx.on(ctx.store('mosaics').get(id) as IDBRequest<StoredMosaicNoProgress | undefined>, (v) => (out.mosaic = v));
    ctx.on(ctx.store('progress').get(id) as IDBRequest<Uint16Array | undefined>, (v) => (out.progress = v));
    if (opts.image !== false) ctx.on(ctx.store('images').get(id) as IDBRequest<ImageRecord | undefined>, (v) => (out.image = v));
  });
}

/** Raster und Fortschritt gemeinsam (eine Transaktion). */
export function saveMosaicAndProgress(id: string, mosaic: StoredMosaicNoProgress, progress: Uint16Array): Promise<void> {
  return txMulti<void>(['mosaics', 'progress'], 'readwrite', (ctx) => {
    ctx.store('mosaics').put(mosaic, id);
    ctx.store('progress').put(progress, id);
    ctx.commit();
  });
}

/** Ergebnisfelder einer Berechnung – sie bestimmen, was die Farbindizes im Raster bedeuten. */
export interface ComputeFields {
  palette: PaletteColor[];
  diagnostics?: ComputeDiagnostics;
  computedWith: string;
  mosaicRev: string;
  computedImageRev?: string;
  thumb?: string;
  updatedAt: number;
  /**
   * Nur bei eigener Palette: die Palette, mit der gerechnet wurde (Momentaufnahme). Die eigene
   * Palette ist eine Eingabe des Benutzers; wurde sie während der Berechnung geändert, wird sie
   * nicht blind durch das Ergebnis ersetzt (siehe resolveComputedPalette).
   */
  customInput?: PaletteColor[];
}

/** Fehlertext: die eigene Palette wurde während der Berechnung so geändert, dass das Ergebnis nicht mehr passt. */
export const PALETTE_CHANGED = 'palette-changed';
export const isPaletteChangedError = (e: unknown) => e instanceof Error && e.message === PALETTE_CHANGED;

function sameColor(a: PaletteColor, b: PaletteColor): boolean {
  return a.code === b.code && a.hex === b.hex && a.name === b.name && (a.materialId ?? null) === (b.materialId ?? null) && a.lab.every((v, i) => v === b.lab[i]);
}

export function samePalette(a: readonly PaletteColor[], b: readonly PaletteColor[]): boolean {
  return a.length === b.length && a.every((c, i) => sameColor(c, b[i]));
}

/**
 * Passt ein Raster, dessen Farbindizes auf die Palette `base` zeigen, auch zur Palette `current`?
 * Ja, wenn jede Farbe von `base` an derselben Stelle mit derselben Farbnummer erhalten ist – Farben
 * wurden also nur angehängt oder an Ort und Stelle umbenannt, umgefärbt oder anders verknüpft.
 * Wurde eine Farbe entfernt oder umsortiert, zeigten die Indizes auf falsche Farben.
 */
export function paletteExtends(current: readonly PaletteColor[], base: readonly PaletteColor[]): boolean {
  if (current.length < base.length) return false;
  for (let i = 0; i < base.length; i++) if (current[i].code !== base[i].code) return false;
  return true;
}

/**
 * Welche Palette gehört nach einer Berechnung in den Projektstand `latestPalette`?
 *  - automatisch/Materialien oder eigene Palette unverändert: die Ergebnispalette,
 *  - eigene Palette nur ergänzt bzw. an Ort und Stelle geändert: die Palette des Benutzers bleibt
 *    (`kept`; das Projekt gilt dann über `computedWith` als geändert → „Einstellungen geändert“),
 *  - eigene Palette verkürzt/umsortiert: `null` – das Ergebnis darf nicht übernommen werden.
 */
export function resolveComputedPalette(latestPalette: readonly PaletteColor[], f: ComputeFields): { palette: PaletteColor[]; kept: boolean } | null {
  if (!f.customInput || samePalette(latestPalette, f.customInput)) return { palette: f.palette, kept: false };
  if (!paletteExtends(latestPalette, f.customInput)) return null;
  return { palette: [...latestPalette], kept: true };
}

function dropUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

/**
 * Übernimmt das Ergebnis einer Berechnung in den neuesten Projektstand (Name, Einstellungen usw. bleiben).
 * Wirft Error(PALETTE_CHANGED), wenn die eigene Palette inzwischen nicht mehr zum Ergebnis passt.
 */
export function mergeComputeFields(latest: ProjectRecord, f: ComputeFields): ProjectRecord {
  const pal = resolveComputedPalette(latest.palette, f);
  if (!pal) throw new Error(PALETTE_CHANGED);
  return dropUndefined({
    ...latest,
    palette: pal.palette,
    diagnostics: f.diagnostics,
    computedWith: f.computedWith,
    mosaicRev: f.mosaicRev,
    computedImageRev: f.computedImageRev,
    meta: dropUndefined({ ...latest.meta, computed: true, thumb: f.thumb ?? latest.meta.thumb, updatedAt: f.updatedAt, manualEdits: 0 }),
  });
}

/** Wurde das gespeicherte Raster mit eigener Palette berechnet? (aus dem Berechnungsschlüssel) */
function computedWithCustom(r: ProjectRecord): boolean {
  if (!r.computedWith) return false;
  try {
    return (JSON.parse(r.computedWith) as { pm?: string }).pm === 'custom';
  } catch {
    return false;
  }
}

/**
 * Eigene Palette, die in dieser Instanz bearbeitet wurde, während anderswo neu berechnet wurde:
 * Sie bleibt erhalten, wenn das gespeicherte Raster mit eigener Palette berechnet wurde und die
 * bearbeitete Palette dessen Palette nur ergänzt bzw. an Ort und Stelle ändert (Indizes bleiben gültig).
 */
function keepMyCustomPalette(mine: ProjectRecord, stored: ProjectRecord, paletteEdited: boolean): boolean {
  return paletteEdited && computedWithCustom(stored) && paletteExtends(mine.palette, stored.palette) && !samePalette(mine.palette, stored.palette);
}

/**
 * Für eine Instanz, deren Raster veraltet ist (anderswo neu berechnet): eigene Bearbeitungen
 * (Name, Einstellungen, Foto-Anpassungen, Bereiche, PDF-Optionen …) behalten, aber alles, was zum
 * gespeicherten Raster gehört, aus dem gespeicherten Stand übernehmen. Ausnahme: eine hier
 * bearbeitete eigene Palette, die zum gespeicherten Raster passt (`paletteEdited`, siehe oben).
 */
export function keepStoredComputeFields(mine: ProjectRecord, stored: ProjectRecord, opts: { paletteEdited?: boolean } = {}): ProjectRecord {
  return dropUndefined({
    ...mine,
    palette: keepMyCustomPalette(mine, stored, !!opts.paletteEdited) ? mine.palette : stored.palette,
    diagnostics: stored.diagnostics,
    computedWith: stored.computedWith,
    mosaicRev: stored.mosaicRev,
    computedImageRev: stored.computedImageRev,
    meta: dropUndefined({ ...mine.meta, computed: stored.meta.computed, thumb: stored.meta.thumb, manualEdits: stored.meta.manualEdits }),
  });
}

/**
 * Speichert eine fertige Berechnung atomar: liest INNERHALB der Transaktion den neuesten
 * gespeicherten Projektstand, übernimmt nur die Ergebnisfelder und schreibt Projekt, Raster
 * (mit neuer Revision) und Fortschritt gemeinsam. Wurde das Projekt inzwischen gelöscht,
 * wird nichts geschrieben und mit Error('deleted') abgelehnt; passt die inzwischen geänderte
 * eigene Palette nicht mehr zum Ergebnis, ebenso nichts und Error('palette-changed').
 */
export function commitComputed(id: string, fields: ComputeFields, mosaic: StoredMosaicNoProgress, progress: Uint16Array, source?: string): Promise<ProjectRecord> {
  return txMulti<ProjectRecord>(['projects', 'mosaics', 'progress'], 'readwrite', (ctx) => {
    ctx.on(ctx.store('projects').get(id) as IDBRequest<ProjectRecord | undefined>, (latest) => {
      if (!latest) {
        ctx.abort(new Error(DELETED));
        return;
      }
      const next = mergeComputeFields(latest, fields);
      ctx.store('projects').put(next, id);
      ctx.store('mosaics').put({ ...mosaic, rev: fields.mosaicRev }, id);
      ctx.store('progress').put(progress, id);
      ctx.commit();
      ctx.done(next);
    });
  }).then((next) => {
    emit({ type: 'computed', id, mosaicRev: fields.mosaicRev, source });
    return next;
  });
}

export interface SaveParts {
  rec?: ProjectRecord;
  mosaic?: StoredMosaicNoProgress;
  progress?: Uint16Array;
  image?: ImageRecord;
}
/**
 * 'rev': nur schreiben, wenn das gespeicherte Raster noch dieselbe Revision hat (sonst nur die
 * eigenen Bearbeitungen am Projekt übernehmen); 'exists': nur prüfen, dass das Projekt noch
 * existiert; 'none': ohne Lesen schreiben (beim Verlassen der Seite – dort kommt nur an, was
 * sofort angefragt wird).
 */
export type SaveGuard = 'rev' | 'exists' | 'none';
export type SaveOutcome = 'ok' | 'stale' | 'deleted';

/** Speichert die angegebenen Teile eines Projekts in EINER Transaktion. */
export function saveProjectState(id: string, parts: SaveParts, guard: SaveGuard, expectedRev?: string, opts: { paletteEdited?: boolean } = {}): Promise<SaveOutcome> {
  const stores: string[] = [];
  if (parts.rec || guard !== 'none') stores.push('projects');
  if (parts.mosaic) stores.push('mosaics');
  if (parts.progress) stores.push('progress');
  if (parts.image) stores.push('images');
  if (!stores.length) return Promise.resolve('ok');
  const writeAll = (ctx: TxCtx<SaveOutcome>) => {
    if (parts.rec) ctx.store('projects').put(parts.rec, id);
    if (parts.mosaic) ctx.store('mosaics').put(parts.mosaic, id);
    if (parts.progress) ctx.store('progress').put(parts.progress, id);
    if (parts.image) ctx.store('images').put(parts.image, id);
    ctx.commit();
    ctx.done('ok');
  };
  return txMulti<SaveOutcome>(stores, 'readwrite', (ctx) => {
    if (guard === 'none') {
      writeAll(ctx);
      return;
    }
    ctx.on(ctx.store('projects').get(id) as IDBRequest<ProjectRecord | undefined>, (stored) => {
      if (!stored) {
        // gelöscht (z. B. in einem anderen Tab) – nicht wieder anlegen
        ctx.commit();
        ctx.done('deleted');
        return;
      }
      if (guard === 'rev' && (stored.mosaicRev ?? null) !== (expectedRev ?? null)) {
        // Raster wurde anderswo neu berechnet: nur eigene Projektbearbeitungen übernehmen,
        // veraltetes Raster/Fortschritt NICHT schreiben
        if (parts.rec) ctx.store('projects').put(keepStoredComputeFields(parts.rec, stored, opts), id);
        if (parts.image) ctx.store('images').put(parts.image, id);
        ctx.commit();
        ctx.done('stale');
        return;
      }
      writeAll(ctx);
    });
  });
}

/** Löscht ein Projekt vollständig (eine Transaktion über alle Projekt-Stores). */
export function deleteProject(id: string): Promise<void> {
  return txMulti<void>(PROJECT_STORES, 'readwrite', (ctx) => {
    for (const s of PROJECT_STORES) ctx.store(s).delete(id);
    ctx.commit();
  }).then(() => emit({ type: 'deleted', id }));
}

// ---------- Materialien
export async function listMaterials(): Promise<Material[]> {
  const all = await db.all<Material>('materials');
  return all.sort((a, b) => (a.manufacturer + a.colorNumber).localeCompare(b.manufacturer + b.colorNumber));
}
export const saveMaterial = (m: Material) => db.put('materials', m.id, m);
export const deleteMaterial = (id: string) => db.del('materials', id);

// ---------- App-Einstellungen
export interface AppSettings {
  lang: 'de' | 'en' | 'tr';
  deltaE: '2000' | '76';
  defaultReserve: number;
  defaultGrout: string;
  defaultUnit: 'cm' | 'm' | 'mm';
}
export const DEFAULT_APP: AppSettings = { lang: 'de', deltaE: '2000', defaultReserve: 10, defaultGrout: '#BDB8AE', defaultUnit: 'cm' };
export async function loadAppSettings(): Promise<AppSettings> {
  return { ...DEFAULT_APP, ...((await db.get<AppSettings>('kv', 'app')) ?? {}) };
}
export const saveAppSettings = (s: AppSettings) => db.put('kv', 'app', s);

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
