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
import type { CarryOverReport } from '../core/progressCarry';
import type { PdfOptions } from '../core/pdfOptions';
import type { ImageAdjust, Material, PaletteColor, ProjectMeta, ProjectSettings, Region } from '../core/types';

const DB_NAME = 'mosaicplan';
const DB_VERSION = 1;
const STORES = ['projects', 'images', 'mosaics', 'progress', 'materials', 'kv'];
/** Stores, die je Projekt einen Eintrag unter der Projekt-ID haben */
export const PROJECT_STORES = ['projects', 'images', 'mosaics', 'progress'] as const;

/**
 * Verlegefortschritt eines Projekts für Listen („Meine Projekte“, Startseite), ohne das Raster zu laden. Wird mit
 * jedem Speichern des Fortschritts bzw. Rasters geschrieben und bei jeder Berechnung neu gesetzt; `rev` ist die
 * Revision des Rasters, zu dem die Zahlen gehören (passt sie nicht zu `mosaicRev`, wird nichts angezeigt).
 * Fehlt bei älteren Projekten, bis sie geöffnet werden.
 */
export interface ProgressSummary {
  /** als verlegt markierte Steine */
  placed: number;
  /** Steine im Mosaik */
  total: number;
  rev?: string;
}

export interface ProjectRecordMeta extends ProjectMeta {
  /** Anzahl manueller Änderungen am Raster seit der letzten Berechnung (Steinfarbe/-form, Farbe entfernt) */
  manualEdits?: number;
  /** Verlegefortschritt für Projektlisten (siehe ProgressSummary) */
  progressSummary?: ProgressSummary;
}

/**
 * Was die letzte Berechnung mit dem Verlegefortschritt des vorherigen Rasters gemacht hat (siehe
 * core/progressCarry.ts): gleiches Raster → nachweislich gleiche Steine bleiben verlegt, sonst nichts übertragbar.
 * Wird einmal angezeigt, bis der Benutzer den Hinweis schließt oder neu berechnet; `rev` = Raster, zu dem er gehört.
 */
export interface CarryOverInfo extends CarryOverReport {
  rev: string;
  at: number;
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
  /**
   * Fingerabdruck der Palette, die die letzte Berechnung festgeschrieben hat (Farbnummer → paletteEntrySig).
   * In den Modi „automatisch“ und „Materialien“ erstellt Neu berechnen die Palette neu; Abweichungen davon
   * sind Bearbeitungen, die dabei verloren gehen (siehe paletteEditsSince). Fehlt bei älteren Projekten.
   */
  computedPaletteSig?: Record<string, string>;
  /**
   * Fingerabdruck der Materialien, aus denen die letzte Berechnung ihre Farben genommen hat (Modi „Materialien“ und
   * „Meine Steine – begrenzte Farbanzahl“; siehe materialInputSig in useProject.ts). Weicht der Fingerabdruck der
   * aktuellen Materialien ab (Farbton, Name, Bestand, hinzugefügt/gelöscht), würde Neu berechnen andere Farben
   * ergeben. Fehlt bei älteren Projekten und in den anderen Modi.
   */
  computedMaterialSig?: string;
  /** Übernahme des Verlegefortschritts bei der letzten Berechnung (fehlt: nichts zu melden) */
  lastCarryOver?: CarryOverInfo;
}

/**
 * Verlegefortschritt zum Anzeigen in Listen – nur, wenn er zum gespeicherten Raster gehört und plausibel ist
 * (ganze Zahlen, 0 ≤ verlegt ≤ gesamt, gesamt > 0). Sonst null: dann wird nichts angezeigt, nie geschätzt.
 */
export function listProgressOf(r: Pick<ProjectRecord, 'meta' | 'mosaicRev'>): { placed: number; total: number } | null {
  const ps = r.meta.progressSummary;
  if (!ps || !r.meta.computed) return null;
  if ((ps.rev ?? null) !== (r.mosaicRev ?? null)) return null;
  const { placed, total } = ps;
  if (!Number.isInteger(placed) || !Number.isInteger(total) || total <= 0 || placed < 0 || placed > total) return null;
  return { placed, total };
}

/**
 * Ganzzahliger Prozentwert für „NN % verlegt“: abgerundet, damit „100 %“ nur erscheint, wenn alles verlegt ist;
 * ein einzelner verlegter Stein ergibt nie „0 %“ (dann `lessThanOne`).
 */
export function laidPercent(placed: number, total: number): { pct: number; lessThanOne: boolean } {
  const r = laidPercentAt(placed, total, 0);
  return { pct: r.value, lessThanOne: r.lessThan };
}

/**
 * Prozentwert mit `decimals` Nachkommastellen für alle Fortschrittsanzeigen (Listen, Schritt 9, Abschnittskacheln) –
 * EINE Regel: auf die angezeigte Genauigkeit abgerundet, „100“ nur, wenn alles verlegt ist, und `lessThan`, wenn
 * Steine verlegt sind, der abgerundete Wert aber 0 wäre (Anzeige „< 1 %“ bzw. „< 0,1 %“ statt „0 %“).
 */
export function laidPercentAt(placed: number, total: number, decimals = 0): { value: number; lessThan: boolean } {
  if (total <= 0 || placed <= 0) return { value: 0, lessThan: false };
  if (placed >= total) return { value: 100, lessThan: false };
  const f = 10 ** Math.max(0, Math.floor(decimals));
  // ganzzahlige Rechnung (placed·100·f ÷ total) vor dem Abrunden – kein 24,999… statt 25
  const steps = Math.min(100 * f - 1, Math.floor((placed * 100 * f) / total));
  return { value: steps / f, lessThan: steps === 0 };
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
  /** Fingerabdruck der angebotenen Materialien (siehe ProjectRecord.computedMaterialSig) */
  computedMaterialSig?: string;
  /** Verlegefortschritt des neuen Rasters (fehlt: unbekannt → wird in Listen nicht angezeigt) */
  progressSummary?: ProgressSummary;
  /** Übernahme des Verlegefortschritts (fehlt: nichts zu melden) */
  carryOver?: CarryOverInfo;
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
 * Was an einer Palettenfarbe Bearbeitung des Benutzers ist: HEX-Wert, Material-Verknüpfung und ein nicht
 * automatischer Name (Benutzer-/Materialname). Automatische Namen (nameKey) zählen nicht – sie folgen nur der
 * Sprache bzw. ändern sich mit dem HEX-Wert.
 */
export function paletteEntrySig(p: PaletteColor): string {
  return JSON.stringify([p.hex.toUpperCase(), p.materialId ?? null, p.nameKey ? null : p.name]);
}

/** Fingerabdruck einer Palette: Farbnummer → paletteEntrySig. */
export function paletteSignature(palette: readonly PaletteColor[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of palette) out[String(p.code)] = paletteEntrySig(p);
  return out;
}

/**
 * Anzahl der Palettenfarben, die seit der letzten Berechnung geändert (HEX, Name, Material) oder hinzugefügt
 * wurden – exakt aus dem gespeicherten Fingerabdruck. Entfernte Farben zählen hier nicht (sie sind bereits
 * manuelle Änderungen am Mosaik). 0, wenn kein Fingerabdruck bekannt ist (ältere Projekte).
 */
export function paletteEditsSince(sig: Record<string, string> | undefined, palette: readonly PaletteColor[]): number {
  if (!sig) return 0;
  let n = 0;
  for (const p of palette) if (sig[String(p.code)] !== paletteEntrySig(p)) n++;
  return n;
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
    // Palette, wie diese Berechnung sie festschreibt (bei eigener Palette ggf. mit den Ergänzungen des Benutzers)
    computedPaletteSig: paletteSignature(pal.palette),
    computedMaterialSig: f.computedMaterialSig,
    // gehören zum neuen Raster: ohne Angabe entfernt (nie Zahlen des ersetzten Rasters weiterzeigen)
    lastCarryOver: f.carryOver,
    meta: dropUndefined({ ...latest.meta, computed: true, thumb: f.thumb ?? latest.meta.thumb, updatedAt: f.updatedAt, manualEdits: 0, progressSummary: f.progressSummary }),
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
    computedPaletteSig: stored.computedPaletteSig,
    computedMaterialSig: stored.computedMaterialSig,
    lastCarryOver: stored.lastCarryOver,
    meta: dropUndefined({ ...mine.meta, computed: stored.meta.computed, thumb: stored.meta.thumb, manualEdits: stored.meta.manualEdits, progressSummary: stored.meta.progressSummary }),
  });
}

/**
 * Fortschritt beim Festschreiben einer Berechnung aus dem ersetzten Raster übernehmen (siehe core/progressCarry.ts).
 * `baseRev`: Revision des Stands, den der Aufrufer im Arbeitsspeicher hat (geöffnete Ansicht, mit den neuesten
 * Markierungen); null = keiner. Stimmt sie mit dem gespeicherten Raster überein, ruft die Transaktion `run(palette,
 * null)` auf; sonst liest sie Raster und Fortschritt aus dem Speicher (in derselben Transaktion) und übergibt sie –
 * so wird nie gegen ein anderes Raster verglichen. `palette` ist die Palette, die mit dem neuen Raster gespeichert
 * wird. `run` liefert den zu schreibenden Fortschritt und die Felder zur Übernahme (progressSummary, carryOver).
 */
export interface CommitCarry {
  baseRev: string | undefined | null;
  run(palette: PaletteColor[], stored: { rec: ProjectRecord; mosaic?: StoredMosaicNoProgress; progress?: Uint16Array } | null): {
    progress: Uint16Array;
    fields: Pick<ComputeFields, 'progressSummary' | 'carryOver'>;
  };
}

/**
 * Speichert eine fertige Berechnung atomar: liest INNERHALB der Transaktion den neuesten
 * gespeicherten Projektstand, übernimmt nur die Ergebnisfelder und schreibt Projekt, Raster
 * (mit neuer Revision) und Fortschritt gemeinsam. Wurde das Projekt inzwischen gelöscht,
 * wird nichts geschrieben und mit Error('deleted') abgelehnt; passt die inzwischen geänderte
 * eigene Palette nicht mehr zum Ergebnis, ebenso nichts und Error('palette-changed').
 * Mit `carry` wird der Fortschritt des ersetzten Rasters übernommen, wo es nachweislich dieselben Steine sind.
 */
export function commitComputed(id: string, fields: ComputeFields, mosaic: StoredMosaicNoProgress, progress: Uint16Array, source?: string, carry?: CommitCarry): Promise<ProjectRecord> {
  return txMulti<ProjectRecord>(['projects', 'mosaics', 'progress'], 'readwrite', (ctx) => {
    ctx.on(ctx.store('projects').get(id) as IDBRequest<ProjectRecord | undefined>, (latest) => {
      if (!latest) {
        ctx.abort(new Error(DELETED));
        return;
      }
      const write = (prog: Uint16Array, f: ComputeFields) => {
        const next = mergeComputeFields(latest, f);
        ctx.store('projects').put(next, id);
        ctx.store('mosaics').put({ ...mosaic, rev: fields.mosaicRev }, id);
        ctx.store('progress').put(prog, id);
        ctx.commit();
        ctx.done(next);
      };
      if (!carry) {
        write(progress, fields);
        return;
      }
      // Palette, die mit dem neuen Raster gespeichert wird (wirft bei verkürzter eigener Palette – nichts geschrieben)
      const pal = resolveComputedPalette(latest.palette, fields);
      if (!pal) throw new Error(PALETTE_CHANGED);
      const finish = (stored: { rec: ProjectRecord; mosaic?: StoredMosaicNoProgress; progress?: Uint16Array } | null) => {
        const r = carry.run(pal.palette, stored);
        write(r.progress, { ...fields, ...r.fields });
      };
      if (carry.baseRev !== null && (latest.mosaicRev ?? null) === (carry.baseRev ?? null)) {
        finish(null);
        return;
      }
      // Stand im Arbeitsspeicher gehört nicht zum gespeicherten Raster (oder es gibt keinen): gespeicherten lesen
      const stored: { rec: ProjectRecord; mosaic?: StoredMosaicNoProgress; progress?: Uint16Array } = { rec: latest };
      ctx.on(ctx.store('mosaics').get(id) as IDBRequest<StoredMosaicNoProgress | undefined>, (m) => {
        stored.mosaic = m;
        ctx.on(ctx.store('progress').get(id) as IDBRequest<Uint16Array | undefined>, (p) => {
          stored.progress = p;
          finish(stored);
        });
      });
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
  /**
   * Nur der Verlegefortschritt für Projektlisten (meta.progressSummary, ggf. Änderungszeitpunkt). Ohne `rec` wird
   * NICHT der ganze Projektstand dieses Tabs geschrieben, sondern nur dieses Feld im gespeicherten Projekt geändert –
   * ein Antippen beim Verlegen überschreibt so nie Name, Einstellungen, Palette oder Bereiche aus einem anderen Tab.
   */
  summary?: SummaryPatch;
}

/** Änderung von meta.progressSummary (siehe SaveParts.summary) */
export interface SummaryPatch {
  value: ProgressSummary;
  /** Änderungszeitpunkt (nur bei einer Bearbeitung, nicht beim Nachtragen nach dem Laden) */
  updatedAt?: number;
}

/**
 * Gespeichertes Projekt mit neuem Listen-Fortschritt – alle übrigen Felder bleiben, wie sie gespeichert sind. null,
 * wenn der Fortschritt nicht zum gespeicherten Raster gehört (anderswo neu berechnet) oder sich nichts ändert.
 */
export function withProgressSummary(stored: ProjectRecord, p: SummaryPatch): ProjectRecord | null {
  if ((stored.mosaicRev ?? null) !== (p.value.rev ?? null)) return null;
  const cur = stored.meta.progressSummary;
  const sameValue = !!cur && cur.placed === p.value.placed && cur.total === p.value.total && (cur.rev ?? null) === (p.value.rev ?? null);
  const updatedAt = p.updatedAt !== undefined ? Math.max(stored.meta.updatedAt ?? 0, p.updatedAt) : stored.meta.updatedAt;
  if (sameValue && updatedAt === stored.meta.updatedAt) return null;
  return { ...stored, meta: { ...stored.meta, progressSummary: p.value, updatedAt } };
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
  // Beim Verlassen der Seite (ohne Lesen) lässt sich der Listen-Fortschritt nicht gezielt ändern: eigene, nachgelagerte
  // Transaktion (bestes Bemühen) – bricht sie ab, bleibt der bisherige Wert, der Fortschritt selbst ist gespeichert
  const summaryLater = guard === 'none' && !!parts.summary && !parts.rec;
  if (!stores.length) {
    if (summaryLater) void patchSummaryOnly(id, parts.summary!).catch(() => {});
    return Promise.resolve('ok');
  }
  const writeAll = (ctx: TxCtx<SaveOutcome>, stored?: ProjectRecord) => {
    if (parts.rec) ctx.store('projects').put(parts.rec, id);
    else if (parts.summary && stored) {
      const next = withProgressSummary(stored, parts.summary);
      if (next) ctx.store('projects').put(next, id);
    }
    if (parts.mosaic) ctx.store('mosaics').put(parts.mosaic, id);
    if (parts.progress) ctx.store('progress').put(parts.progress, id);
    if (parts.image) ctx.store('images').put(parts.image, id);
    ctx.commit();
    ctx.done('ok');
  };
  const main = txMulti<SaveOutcome>(stores, 'readwrite', (ctx) => {
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
      writeAll(ctx, stored);
    });
  });
  if (summaryLater) void patchSummaryOnly(id, parts.summary!).catch(() => {});
  return main;
}

/** Nur meta.progressSummary im gespeicherten Projekt ändern (eigene Transaktion, siehe saveProjectState). */
function patchSummaryOnly(id: string, p: SummaryPatch): Promise<void> {
  return txMulti<void>(['projects'], 'readwrite', (ctx) => {
    ctx.on(ctx.store('projects').get(id) as IDBRequest<ProjectRecord | undefined>, (stored) => {
      const next = stored ? withProgressSummary(stored, p) : null;
      if (next) ctx.store('projects').put(next, id);
      ctx.commit();
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
