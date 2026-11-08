import { DEFAULT_ADJUST, DEFAULT_SETTINGS, type ProjectSettings, type Region } from '../core/types';
import { db, deleteProject, loadProjectState, txMulti, uid, type AppSettings, type ImageRecord, type ProjectRecord, type StoredMosaicNoProgress } from './db';

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

/**
 * Baut die Projektdatei aus einem gegebenen Stand. Wird sowohl für den gespeicherten Stand
 * (exportProject) als auch für den Stand im Arbeitsspeicher genutzt (Notfall-Sicherung, wenn
 * das Speichern auf dem Gerät fehlschlägt). Die Revisionen von Projekt und Raster werden
 * mitgeschrieben, damit die Zusammengehörigkeit nach dem Import prüfbar bleibt.
 */
export async function buildProjectExport(rec: ProjectRecord, image: ImageRecord | null | undefined, mosaic: StoredMosaicNoProgress | null | undefined, progress: Uint16Array | null | undefined): Promise<Blob> {
  const m: Record<string, unknown> | null = mosaic
    ? Object.fromEntries(Object.entries(mosaic).map(([k, v]) => [k, ArrayBuffer.isView(v) ? { $b64: b64(viewBytes(v)) } : v]))
    : null;
  const payload = {
    format: 'mosaicplan-project',
    version: 1,
    record: rec,
    image: image ? { name: image.name, type: image.original.type, data: b64(await image.original.arrayBuffer()) } : null,
    mosaic: m,
    progress: progress ? b64(viewBytes(progress)) : null,
  };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

export async function exportProject(id: string): Promise<Blob> {
  const st = await loadProjectState(id);
  if (!st.rec) throw new Error('Projekt nicht gefunden');
  return buildProjectExport(st.rec, st.image, st.mosaic, st.progress);
}

export async function importProject(file: Blob): Promise<string> {
  const payload = JSON.parse(await file.text());
  if (payload?.format !== 'mosaicplan-project') throw new Error('Keine MosaicPlan-Projektdatei');
  const id = uid();
  const rec = payload.record as ProjectRecord;
  rec.meta = { ...rec.meta, id, updatedAt: Date.now() };
  const image: ImageRecord | null = payload.image ? { name: payload.image.name, original: new Blob([unb64(payload.image.data) as Uint8Array<ArrayBuffer>], { type: payload.image.type }) } : null;
  let mosaic: StoredMosaicNoProgress | null = null;
  if (payload.mosaic) {
    const m: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload.mosaic as Record<string, unknown>)) {
      if (v && typeof v === 'object' && '$b64' in (v as object)) {
        const bytes = unb64((v as { $b64: string }).$b64);
        const C = TYPED[k] ?? Uint8Array;
        m[k] = new C(bytes.buffer as ArrayBuffer);
      } else m[k] = v;
    }
    mosaic = m as StoredMosaicNoProgress;
  }
  const progress = payload.progress ? new Uint16Array(unb64(payload.progress).buffer as ArrayBuffer) : null;
  // alles oder nichts: kein halb importiertes Projekt
  await txMulti<void>(['projects', 'images', 'mosaics', 'progress'], 'readwrite', (ctx) => {
    ctx.store('projects').put(rec, id);
    if (image) ctx.store('images').put(image, id);
    if (mosaic) ctx.store('mosaics').put(mosaic, id);
    if (progress) ctx.store('progress').put(progress, id);
    ctx.commit();
  });
  return id;
}

export { deleteProject, db };
