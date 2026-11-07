import { DEFAULT_ADJUST, DEFAULT_SETTINGS, type ProjectSettings, type Region } from '../core/types';
import type { StoredMosaic } from '../core/serialize';
import { db, deleteProject, loadImage, loadMosaic, loadProgress, loadProject, saveImage, saveMosaic, saveProgress, saveProject, uid, type AppSettings, type ProjectRecord } from './db';

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
  };
  await saveProject(rec);
  if (opts.photo) await saveImage(id, { original: opts.photo, name: opts.photoName ?? 'foto' });
  return id;
}

export async function duplicateProject(id: string, suffix: string): Promise<string | null> {
  const r = await loadProject(id);
  if (!r) return null;
  const nid = uid();
  const now = Date.now();
  await saveProject({ ...structuredClone(r), meta: { ...r.meta, id: nid, name: `${r.meta.name} ${suffix}`, createdAt: now, updatedAt: now } });
  const img = await loadImage(id);
  if (img) await saveImage(nid, img);
  const m = await loadMosaic(id);
  if (m) await saveMosaic(nid, m);
  const p = await loadProgress(id);
  if (p) await saveProgress(nid, p);
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

export async function exportProject(id: string): Promise<Blob> {
  const rec = await loadProject(id);
  if (!rec) throw new Error('Projekt nicht gefunden');
  const img = await loadImage(id);
  const m = await loadMosaic(id);
  const p = await loadProgress(id);
  const mosaic: Record<string, unknown> | null = m
    ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, ArrayBuffer.isView(v) ? { $b64: b64((v as ArrayBufferView).buffer.slice((v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteOffset + (v as ArrayBufferView).byteLength)) } : v]))
    : null;
  const payload = {
    format: 'mosaicplan-project',
    version: 1,
    record: rec,
    image: img ? { name: img.name, type: img.original.type, data: b64(await img.original.arrayBuffer()) } : null,
    mosaic,
    progress: p ? b64(p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength)) : null,
  };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

export async function importProject(file: Blob): Promise<string> {
  const payload = JSON.parse(await file.text());
  if (payload?.format !== 'mosaicplan-project') throw new Error('Keine MosaicPlan-Projektdatei');
  const id = uid();
  const rec = payload.record as ProjectRecord;
  rec.meta = { ...rec.meta, id, updatedAt: Date.now() };
  await saveProject(rec);
  if (payload.image) await saveImage(id, { name: payload.image.name, original: new Blob([unb64(payload.image.data) as Uint8Array<ArrayBuffer>], { type: payload.image.type }) });
  if (payload.mosaic) {
    const m: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload.mosaic as Record<string, unknown>)) {
      if (v && typeof v === 'object' && '$b64' in (v as object)) {
        const bytes = unb64((v as { $b64: string }).$b64);
        const C = TYPED[k] ?? Uint8Array;
        m[k] = new C(bytes.buffer as ArrayBuffer);
      } else m[k] = v;
    }
    await saveMosaic(id, m as Omit<StoredMosaic, 'progress'>);
  }
  if (payload.progress) await saveProgress(id, new Uint16Array(unb64(payload.progress).buffer as ArrayBuffer));
  return id;
}

export { deleteProject, db };
