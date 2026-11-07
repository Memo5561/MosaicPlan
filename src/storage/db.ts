/**
 * Lokale Speicherung in IndexedDB (keine Cloud). Große Binärdaten (Foto,
 * Mosaikraster, Fortschritt) liegen in eigenen Stores, damit Fortschritts-
 * änderungen nicht das ganze Mosaik neu schreiben.
 */
import type { StoredMosaic } from '../core/serialize';
import type { ComputeDiagnostics } from '../core/mosaic';
import type { PdfOptions } from '../core/pdfOptions';
import type { ImageAdjust, Material, PaletteColor, ProjectMeta, ProjectSettings, Region } from '../core/types';

const DB_NAME = 'mosaicplan';
const DB_VERSION = 1;

export interface ProjectRecord {
  meta: ProjectMeta;
  settings: ProjectSettings;
  adjust: ImageAdjust;
  regions: Region[];
  palette: PaletteColor[];
  diagnostics?: ComputeDiagnostics;
  pdfOptions?: Partial<PdfOptions>;
  /** Einstellungen, mit denen das gespeicherte Mosaik berechnet wurde */
  computedWith?: string;
}

export interface ImageRecord {
  original: Blob;
  name: string;
}

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['projects', 'images', 'mosaics', 'progress', 'materials', 'kv']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const r = fn(s);
        let result: T;
        if (r) r.onsuccess = () => (result = r.result);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error ?? new Error('Transaktion abgebrochen'));
      }),
  );
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

// ---------- Projekte
export async function listProjects(): Promise<ProjectRecord[]> {
  const all = await db.all<ProjectRecord>('projects');
  return all.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt);
}
export const loadProject = (id: string) => db.get<ProjectRecord>('projects', id);
export const saveProject = (p: ProjectRecord) => db.put('projects', p.meta.id, p);
export const loadImage = (id: string) => db.get<ImageRecord>('images', id);
export const saveImage = (id: string, r: ImageRecord) => db.put('images', id, r);
export const loadMosaic = (id: string) => db.get<Omit<StoredMosaic, 'progress'>>('mosaics', id);
export const saveMosaic = (id: string, m: Omit<StoredMosaic, 'progress'>) => db.put('mosaics', id, m);
export const loadProgress = (id: string) => db.get<Uint16Array>('progress', id);
export const saveProgress = (id: string, p: Uint16Array) => db.put('progress', id, p);

export async function deleteProject(id: string): Promise<void> {
  await Promise.all(['projects', 'images', 'mosaics', 'progress'].map((s) => db.del(s, id)));
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
