import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hexToLab } from '../../core/color';
import { repairDegenerateCells } from '../../core/edits';
import { checkMosaicIntegrity } from '../../core/integrity';
import { computeLayout, sectionsFor, type Layout, type LayoutParams, type SectionGrid } from '../../core/layout';
import type { ComputeDiagnostics, FixedColor } from '../../core/mosaic';
import { renderFull } from '../../core/render';
import { packMosaic, unpackMosaic, type MosaicDataWithRev } from '../../core/serialize';
import { popcount, progressOf, type Stats } from '../../core/stats';
import { DEFAULT_ADJUST, type ImageAdjust, type Material, type MosaicData, type PaletteColor, type ProjectSettings, type Region } from '../../core/types';
import {
  commitComputed,
  DELETED,
  isDeletedError,
  isPaletteChangedError,
  keepStoredComputeFields,
  loadProjectState,
  mergeComputeFields,
  onStoreEvent,
  PALETTE_CHANGED,
  paletteEditsSince,
  resolveComputedPalette,
  saveProjectState,
  txMulti,
  uid,
  type ComputeFields,
  type ImageRecord,
  type ProjectRecord,
  type SaveGuard,
  type SaveParts,
  type StoredMosaicNoProgress,
} from '../../storage/db';
import { beginCompute, isComputing, onComputeLock } from '../../storage/computeLock';
import { buildProjectExport, duplicateProject } from '../../storage/projects';
import { cancelChannel, runWorker, type Channel } from '../../workers/client';
import { attachProject, cancelJob, editCount, JobBusyError, jobFor, noteEdit, projectHandler, renameJob, runningJob, startJob, subscribeJobs, anyJob, type JobInfo, type JobProgress } from '../../workers/jobs';
import type { RawImage, WorkerRequest } from '../../workers/protocol';
import {
  canvasToJpeg,
  canvasToRaw,
  fitCrop,
  loadBitmap,
  loadWorkingBitmap,
  needsFullResolution,
  PhotoSaveError,
  rawToCanvas,
  renderCropped,
  renderRotated,
  rotatedSize,
  workingSize,
  type WorkingBitmap,
} from './imagePrep';
import { estimatePreviewMs, isSlowDevice, isTypingTarget, previewDebounceMs, previewPolicy, type PreviewManualReason } from './previewPolicy';
import type { Lang } from '../../i18n';
import { announceNotice } from '../SaveResultNote';

export function layoutParamsOf(s: ProjectSettings): LayoutParams {
  return { widthMm: s.widthMm, heightMm: s.heightMm, tileW: s.tileW, tileH: s.tileH, joint: s.joint, edgeMode: s.edgeMode, minCutMm: s.minCutMm };
}

/**
 * Feste Palette als Eingabe der Berechnung (reine Funktion, von compute() verwendet):
 * 'materials'/'auto-snap' → Materialfarben (Auswahl oder alle), 'custom' → eigene Palette MIT Farbnummer
 * (Nummern bleiben über Neuberechnungen erhalten, auch Lücken nach dem Entfernen), 'auto' → keine.
 * Wirft 'no-materials' / 'no-palette', wenn die nötige Liste leer ist.
 */
export function buildFixedPalette(s: Pick<ProjectSettings, 'paletteMode' | 'materialIds'>, palette: readonly PaletteColor[], materials: readonly Material[]): FixedColor[] | undefined {
  if (s.paletteMode === 'materials' || s.paletteMode === 'auto-snap') {
    const pool = materials.filter((m) => s.materialIds.length === 0 || s.materialIds.includes(m.id));
    const fixed: FixedColor[] = pool.map((m) => ({
      lab: hexToLab(m.hex),
      hex: m.hex.toUpperCase(),
      name: m.colorName || `${m.manufacturer} ${m.colorNumber}`.trim(),
      materialId: m.id,
      // Bestand: nur „Meine Steine – begrenzte Farbanzahl“ (auto-snap) nutzt ihn – bei der Auswahl, nie bei der Zuordnung der Steine
      ...(m.stock !== undefined ? { stock: m.stock } : {}),
    }));
    if (!fixed.length) throw new Error('no-materials');
    return fixed;
  }
  if (s.paletteMode === 'custom') {
    // nameKey/nameSuffix: automatische Namen bleiben automatisch (folgen der UI-Sprache); userNamed: eingetippte bleiben wörtlich
    const fixed: FixedColor[] = palette.map((p) => ({
      lab: p.lab,
      hex: p.hex,
      name: p.name,
      materialId: p.materialId,
      code: p.code,
      ...(p.nameKey ? { nameKey: p.nameKey, nameSuffix: p.nameSuffix } : p.userNamed ? { userNamed: true } : {}),
    }));
    if (!fixed.length) throw new Error('no-palette');
    return fixed;
  }
  return undefined;
}

/** Pixelmaße des Originalfotos (nach EXIF-Ausrichtung) und ob die Arbeitskopie verkleinert ist. */
export interface SourceSize {
  w: number;
  h: number;
  reduced: boolean;
}

/**
 * Neues Projekt für ein anderes Foto auf Basis des aktuellen (reine Funktion): übernimmt alle Einstellungen
 * (Breite, Steine, Fuge, Farben, Formen, Abschnitte, Material) und bei eigener Palette die Palette; die Höhe
 * folgt dem Seitenverhältnis des neuen Fotos. Bereiche, Zuschnitt/Bildoptimierung, Berechnung und
 * Fortschritt gehören zum alten Foto und werden nicht übernommen.
 */
export function projectFromPhoto(r: ProjectRecord, id: string, name: string, aspect: number, now: number, imageRev: string): ProjectRecord {
  const s = r.settings;
  const heightMm = Number.isFinite(aspect) && aspect > 0 ? Math.round((s.widthMm / aspect) * 10) / 10 : s.heightMm;
  return {
    meta: { id, name, createdAt: now, updatedAt: now, computed: false },
    settings: { ...s, shapes: { ...s.shapes }, materialIds: [...s.materialIds], heightMm },
    adjust: { ...DEFAULT_ADJUST },
    regions: [],
    palette: s.paletteMode === 'custom' ? r.palette.map((p) => ({ ...p })) : [],
    imageRev,
  };
}

/** Projektname aus einem Dateinamen („IMG_2041.jpg“ → „IMG_2041“). */
export function nameFromFile(fileName: string, fallback: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim() || fallback;
}

export function computeKey(r: ProjectRecord): string {
  const s = r.settings;
  return JSON.stringify({
    l: layoutParamsOf(s),
    sh: s.shapes,
    pm: s.paletteMode,
    cc: s.colorCount,
    di: s.dither,
    de: s.deltaE,
    mi: s.paletteMode === 'materials' || s.paletteMode === 'auto-snap' ? s.materialIds : [],
    cp: s.paletteMode === 'custom' ? r.palette.map((p) => p.hex) : [],
    a: r.adjust,
    rg: r.regions,
    // Identität des Fotos. Ohne imageRev (ältere Projekte) lässt JSON.stringify den Eintrag weg,
    // der Schlüssel bleibt dann Zeichen für Zeichen derselbe wie bisher.
    im: r.imageRev,
  });
}

export interface ComputedState {
  layout: Layout;
  layoutParams: LayoutParams;
  data: MosaicData;
}

export interface ComputeProgress {
  phase: string;
  fraction: number;
}

/** 'saved': alles gespeichert · 'saving': Änderungen werden gleich/gerade gespeichert · 'error': Speichern fehlgeschlagen */
export type SaveState = 'saved' | 'saving' | 'error';
export interface SaveError {
  /** 'quota': Gerätespeicher voll · 'connection': Verbindung zum Gerätespeicher verloren · 'deleted': Projekt wurde gelöscht */
  code: 'quota' | 'connection' | 'deleted' | 'other';
  message: string;
}
/** Gespeichertes Raster gehört nicht zur gespeicherten Palette → wird nicht angezeigt, neu berechnen nötig */
export type IntegrityError = 'mismatch';

/** Was über ein gespeichertes, aber nicht angezeigtes Raster bekannt ist (siehe restoreComputed). */
export interface RejectedMosaic {
  /** Grund aus restoreComputed (z. B. 'index': Farbindex außerhalb der Palette, 'rev': andere Berechnung) */
  reason: string;
  /** Rasterpositionen des gespeicherten Rasters */
  cells: number;
  /** als verlegt markierte Steine im gespeicherten Fortschritt – sie gehen beim Neuberechnen verloren */
  placed: number;
}

/**
 * Fertiges Ergebnis einer Berechnung, das noch nicht übernommen wurde, weil während der Berechnung am
 * angezeigten Mosaik weitergearbeitet wurde (Steine verlegt, Abschnitt fertig, Steine geändert). Übernehmen
 * würde diese Arbeit verwerfen – das entscheidet der Benutzer (siehe applyPending/discardPending).
 */
export interface PendingCommit {
  fields: ComputeFields;
  pk: { mosaic: StoredMosaicNoProgress; progress: Uint16Array };
  data: MosaicDataWithRev;
  proc: HTMLCanvasElement;
  layout: Layout;
  lp: LayoutParams;
  /** Projektstand beim Start der Berechnung (Rückfall, falls kein neuerer vorliegt) */
  started: ProjectRecord;
  /** 'preview': übernommene Live-Vorschau (keine zweite Berechnung), 'compute': Berechnung über „Berechnen“ */
  origin: 'compute' | 'preview';
}

/** Was über ein wartendes Ergebnis angezeigt wird. */
export interface PendingResult {
  /** Zeitpunkt, an dem das Ergebnis fertig wurde (ms) */
  at: number;
}

/** Verlegte Steine im gespeicherten Fortschritt (nur wenn er zum gespeicherten Raster passt). */
export function placedInStored(m: StoredMosaicNoProgress | undefined, prog: Uint16Array | undefined): number {
  if (!m || !prog || prog.length !== m.cols * m.rows) return 0;
  let n = 0;
  for (let i = 0; i < prog.length; i++) if (prog[i]) n += popcount(prog[i]);
  return n;
}

type SaveKey = 'rec' | 'mosaic' | 'progress' | 'image';
const KEYS: SaveKey[] = ['rec', 'mosaic', 'progress', 'image'];
/** Entprellzeiten je Teil (ms) */
export const SAVE_DEBOUNCE: Record<SaveKey, number> = { rec: 250, progress: 150, mosaic: 300, image: 0 };
/** Spätestens nach dieser Zeit wird auch bei Dauerbearbeitung gespeichert (ms) */
const SAVE_MAX_WAIT = 2000;
/** Wartezeiten bis zum nächsten automatischen Versuch nach einem Fehler (ms) */
export const SAVE_RETRY_MS = [2000, 5000, 15000, 60000];

export function classifySaveError(e: unknown): SaveError {
  const name = e && typeof e === 'object' ? (e as { name?: string }).name : undefined;
  const message = e instanceof Error ? e.message : String(e);
  if (isDeletedError(e)) return { code: 'deleted', message };
  if (name === 'QuotaExceededError' || /quota/i.test(message)) return { code: 'quota', message };
  if (name === 'InvalidStateError' || name === 'UnknownError' || name === 'TransactionInactiveError') return { code: 'connection', message };
  return { code: 'other', message };
}

/**
 * Baut den angezeigten Rechenstand aus gespeicherten Daten – aber nur, wenn Raster und Projekt
 * nachweislich zusammengehören (gleiches Raster wie berechnet, gleiche Revision, alle Farbindizes
 * in der Palette). Sonst wird nichts angezeigt und `mismatch` gemeldet.
 */
export function restoreComputed(rec: ProjectRecord, m: StoredMosaicNoProgress | undefined, prog: Uint16Array | undefined): { computed: ComputedState | null; mismatch: string | null } {
  if (!m) return { computed: null, mismatch: rec.mosaicRev !== undefined || rec.computedWith !== undefined ? 'missing' : null };
  if (!rec.computedWith) return { computed: null, mismatch: 'no-key' };
  let lp: LayoutParams;
  let layout: Layout;
  try {
    lp = (JSON.parse(rec.computedWith) as { l: LayoutParams }).l;
    layout = computeLayout(lp);
  } catch {
    return { computed: null, mismatch: 'layout' };
  }
  const n = m.cols * m.rows;
  if (layout.cols !== m.cols || layout.rows !== m.rows) return { computed: null, mismatch: 'layout' };
  if (m.kind?.length !== n || m.c1?.length !== n || m.c2?.length !== n) return { computed: null, mismatch: 'shape' };
  const check = checkMosaicIntegrity(rec, m);
  if (!check.ok) return { computed: null, mismatch: check.reason };
  try {
    const data = unpackMosaic({ ...m, progress: prog && prog.length === n ? prog : new Uint16Array(n) });
    return { computed: { layout, layoutParams: lp, data }, mismatch: null };
  } catch {
    return { computed: null, mismatch: 'shape' };
  }
}

function withRev(m: StoredMosaicNoProgress, rev: string | undefined): StoredMosaicNoProgress {
  const out = { ...m };
  if (rev !== undefined) out.rev = rev;
  else delete out.rev;
  return out;
}

function packWithoutProgress(d: MosaicData, rev: string | undefined): { mosaic: StoredMosaicNoProgress; progress: Uint16Array } {
  const { progress, ...rest } = packMosaic(d);
  return { mosaic: withRev(rest, rev), progress };
}

// ---------- Gemeinsamer Rechenweg für Live-Vorschau und Berechnung (Paket w3-live-preview)
// Vorschau und „Berechnen“ benutzen GENAU diese Schritte: describeComputeInputs → runComputeWith →
// prepareCommit → persistCommit. Was die Vorschau zeigt, ist deshalb Stein für Stein das, was „Übernehmen“
// speichert (die Berechnung ist deterministisch, siehe tests/w3-live-preview.test.ts).

/** Umgebung der Berechnung: Arbeitskopie des Fotos, Maße des Originals, Materialien, Sprache. */
export interface ComputeEnv {
  /** Arbeitskopie (für die Identität des Bildes; in Tests null) */
  bitmap: ImageBitmap | null;
  /** Pixelmaße der Arbeitskopie */
  bw: number;
  bh: number;
  /** Pixelmaße des Originals (nach EXIF-Ausrichtung) */
  srcW: number;
  srcH: number;
  /** Arbeitskopie verkleinert? */
  reduced: boolean;
  /** Original-Datei vorhanden (für den vollen Zuschnitt bei verkleinerter Arbeitskopie) */
  hasOriginal: boolean;
  materials: readonly Material[];
  lang: Lang;
}

type ComputeRequest = Omit<Extract<WorkerRequest, { type: 'compute' }>, 'id' | 'image'>;

/** Vollständig beschriebene Eingaben einer Berechnung (ohne die Bildpunkte selbst). */
export interface ComputeInputs {
  ok: true;
  /** Projektstand, dessen Einstellungen berechnet werden */
  rec: ProjectRecord;
  /** computeKey(rec) */
  key: string;
  /**
   * Fingerabdruck ALLER Eingaben des Workers (Anfrage ohne Bild + Zuschnitt, Arbeitsauflösung, volle Auflösung,
   * Foto-Identität). Gleicher Fingerabdruck + gleiche Arbeitskopie ⇒ gleiches Ergebnis.
   */
  sig: string;
  lang: Lang;
  layout: Layout;
  lp: LayoutParams;
  cells: number;
  /** tatsächlich verwendeter Zuschnitt (normiert, auf dem gedrehten Original) */
  crop: { x: number; y: number; w: number; h: number };
  /** Arbeitsauflösung */
  ws: { w: number; h: number };
  /** Original wird für diesen Zuschnitt voll gelesen (verkleinerte Arbeitskopie hat zu wenig Pixel) */
  full: boolean;
  request: ComputeRequest;
  bitmap: ImageBitmap | null;
}
export type ComputeInputsResult = ComputeInputs | { ok: false; error: string };

/**
 * Beschreibt die Eingaben einer Berechnung für den Projektstand `r` (reine Funktion): Raster, Zuschnitt und
 * Arbeitsauflösung aus den Maßen des ORIGINALS (wie bei voller Dekodierung), feste Palette (mit Farbnummern,
 * Namensschlüsseln und Bestand), Worker-Anfrage und Fingerabdruck. Fehler: 'layout', 'no-materials', 'no-palette'.
 */
export function describeComputeInputs(r: ProjectRecord, env: ComputeEnv): ComputeInputsResult {
  const s = r.settings;
  const lp = layoutParamsOf(s);
  let layout: Layout;
  try {
    layout = computeLayout(lp);
  } catch {
    return { ok: false, error: 'layout' };
  }
  const cells = layout.cols * layout.rows;
  const { w: rw, h: rh } = rotatedSize(env.srcW, env.srcH, r.adjust);
  const crop = fitCrop(r.adjust.crop, rw, rh, layout.finishedW / layout.finishedH);
  const ws = workingSize(cells, layout.finishedW / layout.finishedH, crop.w * rw * crop.h * rh);
  const { w: bw, h: bh } = rotatedSize(env.bw, env.bh, r.adjust);
  const full = env.hasOriginal && needsFullResolution(env.reduced, crop, bw, bh, ws);
  let fixed: FixedColor[] | undefined;
  try {
    fixed = buildFixedPalette(s, r.palette, env.materials);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const request: ComputeRequest = {
    type: 'compute',
    adjust: { ...r.adjust, crop: null },
    regions: r.regions,
    layoutParams: lp,
    params: { shapes: s.shapes, paletteMode: s.paletteMode, colorCount: s.colorCount, dither: s.dither, deltaE: s.deltaE, fixedPalette: fixed, regions: r.regions, lang: env.lang },
  };
  const key = computeKey(r);
  const sig = JSON.stringify({ q: request, c: crop, ws, f: full, im: r.imageRev ?? null, sw: env.srcW, sh: env.srcH });
  return { ok: true, rec: r, key, sig, lang: env.lang, layout, lp, cells, crop, ws, full, request, bitmap: env.bitmap };
}

/** Ergebnis einer Berechnung (Vorschau oder „Berechnen“), noch nicht gespeichert. */
export interface ComputeOutput {
  sig: string;
  key: string;
  lang: Lang;
  ws: { w: number; h: number };
  full: boolean;
  layout: Layout;
  layoutParams: LayoutParams;
  data: MosaicDataWithRev;
  palette: PaletteColor[];
  diagnostics: ComputeDiagnostics;
  /** Foto nach Bildoptimierung in Arbeitsauflösung (Vergleich Foto/Mosaik) */
  processed: RawImage;
  /** Projektstand, dessen Einstellungen berechnet wurden */
  snapshot: ProjectRecord;
  cells: number;
  /** Dauer (ms) inkl. Bildvorbereitung */
  ms: number;
  bitmap: ImageBitmap | null;
}

/** Zwischengespeichertes Arbeitsbild (nur Geometrie bestimmt die Bildpunkte; Farbregler wirken erst im Worker). */
export interface RawCache {
  current: { bitmap: ImageBitmap | null; key: string; raw: RawImage } | null;
}

/** Schlüssel des Arbeitsbilds: Drehung, Spiegeln, Zuschnitt, Arbeitsauflösung, volle Auflösung. */
export function rawCacheKey(inp: Pick<ComputeInputs, 'rec' | 'crop' | 'ws' | 'full'>): string {
  const a = inp.rec.adjust;
  return JSON.stringify({ r: a.rotation, f: a.fineRotate, h: a.flipH, c: inp.crop, ws: inp.ws, full: inp.full });
}

async function rawFor(inp: ComputeInputs, cache: RawCache, original: Blob | null): Promise<RawImage> {
  const bmp = inp.bitmap;
  if (!bmp) throw new Error('no-photo');
  const ck = rawCacheKey(inp);
  let raw: RawImage;
  const hit = cache.current;
  if (hit && hit.bitmap === bmp && hit.key === ck) raw = hit.raw;
  else {
    // Hat die verkleinerte Arbeitskopie im Zuschnitt zu wenig Pixel, wird das Original vorübergehend voll gelesen
    let fullBmp: ImageBitmap | null = null;
    if (inp.full && original) {
      try {
        fullBmp = await loadBitmap(original);
      } catch (e) {
        // z. B. zu wenig Speicher: mit der Arbeitskopie rechnen (gleiche Pixelzahl, etwas weniger Bilddetail)
        console.warn('Original konnte nicht voll gelesen werden – Berechnung mit der Arbeitskopie', e);
      }
    }
    try {
      raw = canvasToRaw(renderCropped(fullBmp ?? bmp, inp.rec.adjust, inp.crop, inp.ws.w, inp.ws.h));
    } finally {
      fullBmp?.close(); // volle Auflösung nur für diesen einen Zuschnitt im Speicher halten
    }
    // Vorschau und Berechnung derselben Geometrie rechnen mit genau diesen Bildpunkten
    cache.current = { bitmap: bmp, key: ck, raw };
  }
  // Kopie für die Übergabe an den Worker (das Original bleibt im Zwischenspeicher)
  return { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data) };
}

/** Rechnet die beschriebenen Eingaben im Worker des Kanals (Vorschau: 'preview', Berechnung: 'compute'). */
export async function runComputeWith(inp: ComputeInputs, channel: Channel, onProgress: (phase: string, fraction: number) => void, cache: RawCache, original: Blob | null): Promise<ComputeOutput> {
  const t0 = performance.now();
  const raw = await rawFor(inp, cache, original);
  const res = await runWorker<'compute'>(channel, { ...inp.request, image: raw }, [raw.data.buffer as ArrayBuffer], onProgress);
  const data: MosaicDataWithRev = unpackMosaic(res.mosaic);
  return {
    sig: inp.sig,
    key: inp.key,
    lang: inp.lang,
    ws: inp.ws,
    full: inp.full,
    layout: inp.layout,
    layoutParams: inp.lp,
    data,
    palette: res.palette,
    diagnostics: res.diagnostics as ComputeDiagnostics,
    processed: res.processed,
    snapshot: inp.rec,
    cells: inp.cells,
    ms: performance.now() - t0,
    bitmap: inp.bitmap,
  };
}

/**
 * Ergebnisfelder einer Berechnung (reine Funktion). Schlüssel der tatsächlich berechneten Eingaben
 * (Momentaufnahme; bei eigener Palette mit der neu nummerierten Ergebnispalette) – nie des neuesten Stands:
 * Änderungen während der Berechnung erscheinen so korrekt als „Einstellungen geändert“.
 */
export function commitFieldsOf(out: Pick<ComputeOutput, 'snapshot' | 'palette' | 'diagnostics'>, o: { thumb?: string; now: number; rev: string }): ComputeFields {
  const r = out.snapshot;
  const custom = r.settings.paletteMode === 'custom';
  const keyRec: ProjectRecord = custom ? { ...r, palette: out.palette } : r;
  return {
    palette: out.palette,
    diagnostics: out.diagnostics,
    computedWith: computeKey(keyRec),
    mosaicRev: o.rev,
    computedImageRev: r.imageRev,
    thumb: o.thumb,
    updatedAt: o.now,
    // Eigene Palette ist eine Eingabe: Änderungen während der Berechnung nicht überschreiben
    ...(custom ? { customInput: r.palette } : {}),
  };
}

/** Bereitet ein Ergebnis zum Speichern vor (Miniatur mit der aktuellen Fugenfarbe, gepacktes Raster mit neuer Revision). */
export async function prepareCommit(out: ComputeOutput, groutHex: string, origin: PendingCommit['origin']): Promise<PendingCommit> {
  const thumbCanvas = renderFull(out.layout, out.data, out.palette, 320, { groutHex, realistic: false });
  const thumb = await canvasToJpeg(thumbCanvas, 0.8);
  const fields = commitFieldsOf(out, { thumb, now: Date.now(), rev: uid() });
  return { fields, pk: packWithoutProgress(out.data, fields.mosaicRev), data: out.data, proc: rawToCanvas(out.processed), layout: out.layout, lp: out.layoutParams, started: out.snapshot, origin };
}

/** Wie ein Auftrag endete. */
export type JobOutcome = 'committed' | 'held' | 'dropped' | 'deleted' | 'failed';

/**
 * Die gerade geöffnete Ansicht eines Projekts (useProject), bei jobs.ts angemeldet. Ein Auftrag fragt sie,
 * ob am angezeigten Mosaik Arbeit auf dem Spiel steht, und übergibt ihr das gespeicherte Ergebnis.
 */
interface ProjectHandler {
  instance: string;
  latestPalette(): PaletteColor[] | null;
  groutHex(): string | null;
  workAtRisk(): boolean;
  hold(job: PendingCommit): void;
  applyCommitted(job: PendingCommit, committed: ProjectRecord | null, saveFailure: unknown): void;
  onError(code: string): void;
}

/**
 * Schreibt ein Ergebnis fest (Projekt, Raster, Fortschritt in EINER Transaktion, siehe commitComputed) – auch
 * wenn keine Ansicht des Projekts mehr offen ist – und übergibt es der angemeldeten Ansicht.
 * Wirft bei geänderter eigener Palette (PALETTE_CHANGED).
 */
async function persistCommit(id: string, job: PendingCommit, fallbackSource: string): Promise<JobOutcome> {
  const h0 = projectHandler<ProjectHandler>(id);
  let committed: ProjectRecord | null = null;
  let saveFailure: unknown = null;
  try {
    committed = await commitComputed(id, job.fields, job.pk.mosaic, job.pk.progress, h0?.instance ?? fallbackSource);
  } catch (e) {
    if (isDeletedError(e)) {
      // Projekt wurde während der Berechnung gelöscht: nichts speichern, nicht wieder anlegen
      projectHandler<ProjectHandler>(id)?.onError('deleted');
      return 'deleted';
    }
    // Eigene Palette wurde anderswo verkürzt/umsortiert: nichts gespeichert, Palette und altes Raster bleiben
    if (isPaletteChangedError(e)) throw e;
    saveFailure = e;
  }
  const h = projectHandler<ProjectHandler>(id);
  if (h) {
    h.applyCommitted(job, committed, saveFailure);
    return 'committed';
  }
  if (saveFailure) {
    console.warn('Ergebnis konnte nicht gespeichert werden', saveFailure);
    return 'failed';
  }
  return 'committed';
}

/**
 * Schluss eines Auftrags: vorbereiten, prüfen, speichern. Wurde während des Auftrags am angezeigten Mosaik
 * gearbeitet (verlegt, Abschnitt fertig, Steine geändert), wird das Ergebnis NICHT still übernommen: Es wartet
 * in der geöffneten Ansicht auf die Entscheidung des Benutzers; ist keine offen, bleibt die Arbeit und das
 * Ergebnis wird mit Hinweis verworfen.
 */
async function finishJob(id: string, out: ComputeOutput, startEdits: number, origin: PendingCommit['origin'], source: string): Promise<JobOutcome> {
  const job = await prepareCommit(out, projectHandler<ProjectHandler>(id)?.groutHex() ?? out.snapshot.settings.groutHex, origin);
  const h = projectHandler<ProjectHandler>(id);
  // Wurde die eigene Palette hier während der Berechnung verkürzt oder umsortiert, passt das Ergebnis nicht mehr
  const pal = h?.latestPalette();
  if (pal && !resolveComputedPalette(pal, job.fields)) throw new Error(PALETTE_CHANGED);
  if (editCount(id) !== startEdits) {
    if (!h) {
      console.warn('Berechnung nicht übernommen: während der Berechnung wurde am Mosaik gearbeitet');
      announceNotice('w2ws.pending.dropped');
      return 'dropped';
    }
    if (h.workAtRisk()) {
      h.hold(job);
      return 'held';
    }
  }
  return persistCommit(id, job, source);
}

/** Zuletzt gemessene Rechendauer (Vorschau oder Berechnung) in dieser Sitzung – Grundlage des Richtwerts */
let lastMeasured: { ms: number; cells: number } | null = null;
function noteMeasured(out: Pick<ComputeOutput, 'ms' | 'cells'>) {
  if (out.ms > 0 && out.cells > 0) lastMeasured = { ms: out.ms, cells: out.cells };
}

// Wird ein Projekt gelöscht (auch in einem anderen Tab), endet seine Berechnung sofort
let deleteHookInstalled = false;
function installDeleteHook() {
  if (deleteHookInstalled) return;
  deleteHookInstalled = true;
  onStoreEvent((e) => {
    if (e.type === 'deleted') cancelJob(e.id);
  });
}

/** Zustand der Live-Vorschau (nie gespeichert). */
interface PreviewState {
  /** letzte fertige Vorschau (kann veraltet sein: sig ≠ aktuelle Eingaben) */
  result: ComputeOutput | null;
  /** laufende Vorschau */
  running: { sig: string; progress: JobProgress } | null;
  /** letzte fehlgeschlagene Vorschau (wird für diese Eingaben nicht von selbst wiederholt) */
  error: { sig: string; msg: string } | null;
  /** Dauer und Größe der letzten Vorschau (für Automatik und Richtwert) */
  last: { ms: number; cells: number } | null;
}

/** Was die Live-Vorschau anzeigen kann (siehe LivePreview.tsx). */
export interface PreviewInfo {
  /** letzte fertige Vorschau (evtl. veraltet) */
  result: ComputeOutput | null;
  /** result gehört zu den aktuellen Einstellungen (sonst: abgedunkelt anzeigen) */
  current: boolean;
  /** Fortschritt der laufenden Vorschau (null: keine läuft) */
  running: JobProgress | null;
  /** die laufende Vorschau rechnet die aktuellen Einstellungen */
  runningCurrent: boolean;
  /** Vorschau wartet nach einer Änderung (Entprellen) */
  scheduled: boolean;
  /** Fehlermeldung der Vorschau für die aktuellen Einstellungen */
  error: string | null;
  /** keine Vorschau möglich: 'no-photo', 'layout', 'no-materials', 'no-palette' */
  inputError: string | null;
  /** Rasterpositionen der aktuellen Einstellungen */
  cells: number;
  /** rechnet von selbst (sonst „Vorschau aktualisieren“) */
  auto: boolean;
  reason: PreviewManualReason | null;
  /** Richtwert der Dauer (ms) */
  estimateMs: number;
  /** Dauer der letzten Vorschau (ms) */
  lastMs: number | null;
  /** angehalten, solange eine Berechnung läuft */
  paused: boolean;
  /** das gespeicherte Mosaik entspricht den aktuellen Einstellungen (dann zeigt die Vorschau dieses) */
  committedCurrent: boolean;
}

export function useProject(id: string, materials: Material[], lang: Lang) {
  const [rec, setRecState] = useState<ProjectRecord | null>(null);
  const [image, setImageState] = useState<ImageRecord | null>(null);
  /** Arbeitskopie des Fotos (bei großen Fotos verkleinert, siehe loadWorkingBitmap) */
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  /** Pixelmaße des Originalfotos; gilt für Zuschnitt, Seitenverhältnis und Arbeitsauflösung */
  const [sourceSize, setSourceSize] = useState<SourceSize | null>(null);
  /** 'unreadable': gespeichertes Foto konnte nicht gelesen werden (neu auswählen) */
  const [imageError, setImageError] = useState<'unreadable' | null>(null);
  const [computed, setComputedState] = useState<ComputedState | null>(null);
  const [version, setVersion] = useState(0);
  const [progressVersion, setProgressVersion] = useState(0);
  /**
   * Fortschritt der Berechnung DIESES Projekts – aus dem Auftragsregister (jobs.ts), also auch, wenn sie in
   * einer früheren Ansicht gestartet wurde und beim Verlassen weiterlief.
   */
  const [computing, setComputing] = useState<ComputeProgress | null>(() => jobFor(id)?.progress ?? null);
  /** Berechnung eines ANDEREN Projekts, die gerade läuft (app-weit nur eine) */
  const [otherJob, setOtherJob] = useState<JobInfo | null>(() => runningJob(id));
  /** Läuft irgendein Auftrag? (Vorschau wartet so lange) */
  const [jobsActive, setJobsActive] = useState(() => anyJob());
  /** Zeitpunkt des letzten in dieser Ansicht übernommenen Ergebnisses (für „Berechnung fertig“) */
  const [committedAt, setCommittedAt] = useState(0);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [sectionStats, setSectionStats] = useState<Map<string, Stats>>(new Map());
  const [statsBusy, setStatsBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [processed, setProcessed] = useState<HTMLCanvasElement | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [integrityError, setIntegrityError] = useState<IntegrityError | null>(null);
  const [rejected, setRejected] = useState<RejectedMosaic | null>(null);
  /** Beim Laden reparierte Zellen mit leeren Teilen (Fuge breiter als der Stein, ältere Projekte) */
  const [repairedCells, setRepairedCells] = useState(0);
  /** Läuft irgendwo (diese Ansicht, eine frühere Ansicht im Hintergrund, anderer Tab) eine Berechnung? */
  const [paletteLocked, setPaletteLocked] = useState(() => isComputing(id));
  /** Ergebnis, das wegen Änderungen während der Berechnung auf die Entscheidung des Benutzers wartet */
  const [pendingResult, setPendingResult] = useState<PendingResult | null>(null);
  const pendingRef = useRef<PendingCommit | null>(null);
  // Bearbeitungen des angezeigten Rasters (Steinfarbe/-form, verlegt, Abschnitt fertig) zählt jobs.ts je Projekt
  // (noteEdit/editCount) – über alle Ansichten hinweg. Ein Auftrag vergleicht den Stand bei Start und Ende.

  // ---------- Live-Vorschau (nie gespeichert)
  const [preview, setPreview] = useState<PreviewState>({ result: null, running: null, error: null, last: null });
  const previewRef = useRef(preview);
  previewRef.current = preview;
  /** Anzahl angezeigter Vorschauen (LivePreview) – nur dann wird gerechnet */
  const [previewWatchers, setPreviewWatchers] = useState(0);
  const [previewScheduled, setPreviewScheduled] = useState(false);
  /** Zähler der Vorschau-Anfragen: Ergebnisse älterer Anfragen werden verworfen */
  const previewReq = useRef(0);
  /** laufende Vorschau; `promoted`: wird von „Übernehmen“ als Berechnung weiterverwendet */
  const previewInflight = useRef<{ sig: string; my: number; promise: Promise<ComputeOutput>; listeners: Set<(p: JobProgress) => void>; promoted: boolean } | null>(null);
  /** Arbeitsbild (gemeinsam für Vorschau und Berechnung) */
  const rawCache = useRef<RawCache['current']>(null);

  // Die Refs sind die maßgebliche Quelle (sofort aktuell, auch in Ereignis-Handlern beim Verlassen
  // der Seite); der React-State spiegelt sie für das Rendern.
  const recRef = useRef<ProjectRecord | null>(null);
  const computedRef = useRef<ComputedState | null>(null);
  const imageRef = useRef<ImageRecord | null>(null);
  /**
   * Palette, wie sie zuletzt nachweislich gespeichert war (Laden, Übernehmen, Berechnen, Speichern).
   * Weicht die Palette im Arbeitsspeicher davon ab, hat der Benutzer sie hier bearbeitet.
   */
  const paletteBaseRef = useRef<PaletteColor[] | null>(null);
  const instanceRef = useRef('');
  if (!instanceRef.current) instanceRef.current = uid();
  const mounted = useRef(true);

  const setRecBoth = useCallback((next: ProjectRecord | null) => {
    recRef.current = next;
    setRecState(next);
  }, []);
  const setComputedBoth = useCallback((next: ComputedState | null) => {
    computedRef.current = next;
    setComputedState(next);
  }, []);

  // ---------- Speichern
  // Jede Änderung erhöht die Generation ihres Teils. Ein Speichervorgang schreibt ALLE ungespeicherten
  // Teile in einer Transaktion; ein Teil gilt erst als gespeichert, wenn diese Transaktion abgeschlossen ist.
  const sv = useRef({
    gen: { rec: 0, mosaic: 0, progress: 0, image: 0 } as Record<SaveKey, number>,
    saved: { rec: 0, mosaic: 0, progress: 0, image: 0 } as Record<SaveKey, number>,
    /** höchste Generation, die gerade geschrieben wird oder geschrieben wurde */
    writing: { rec: 0, mosaic: 0, progress: 0, image: 0 } as Record<SaveKey, number>,
    timers: {} as Partial<Record<SaveKey, { t: number; first: number }>>,
    inflight: new Set<Promise<void>>(),
    retryTimer: 0,
    retryAttempt: 0,
    error: null as SaveError | null,
    /** Projekt wurde gelöscht → nie wieder anlegen */
    deleted: false,
    /** Eine fremde Berechnung ist bekannt, aber noch nicht übernommen */
    staleKnown: false,
    /** Eigene Berechnung konnte nicht gespeichert werden → nächster Vorgang schreibt den Stand im Speicher vollständig */
    force: false,
    pendingImage: null as ImageRecord | null,
  });
  const persistRef = useRef<(mode: 'normal' | 'unload') => Promise<void>>(() => Promise.resolve());

  const refreshSaveState = useCallback(() => {
    const s = sv.current;
    const unsaved = KEYS.some((k) => s.gen[k] > s.saved[k]);
    setSaveState(s.error ? 'error' : unsaved || s.inflight.size > 0 ? 'saving' : 'saved');
  }, []);

  const setError = useCallback(
    (e: SaveError | null) => {
      sv.current.error = e;
      setSaveError(e);
      refreshSaveState();
    },
    [refreshSaveState],
  );

  const scheduleRetry = useCallback(() => {
    const s = sv.current;
    if (!mounted.current || s.deleted) return;
    window.clearTimeout(s.retryTimer);
    const ms = SAVE_RETRY_MS[Math.min(s.retryAttempt, SAVE_RETRY_MS.length - 1)];
    s.retryAttempt++;
    s.retryTimer = window.setTimeout(() => void persistRef.current('normal').catch(() => {}), ms);
  }, []);

  /** Verwirft ausstehende Speicherungen des bisherigen Rasters (es wurde durch ein anderes ersetzt). */
  const discardGrid = useCallback(() => {
    const s = sv.current;
    for (const k of ['mosaic', 'progress'] as const) {
      s.saved[k] = s.writing[k] = s.gen[k];
      const tm = s.timers[k];
      if (tm) window.clearTimeout(tm.t);
      delete s.timers[k];
    }
    refreshSaveState();
  }, [refreshSaveState]);

  // Übernimmt eine anderswo (Hintergrund-Berechnung einer früheren Ansicht, anderer Tab) gespeicherte Berechnung.
  const adoptRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const persist = useCallback(
    (mode: 'normal' | 'unload'): Promise<void> => {
      const s = sv.current;
      for (const k of KEYS) {
        const tm = s.timers[k];
        if (tm) window.clearTimeout(tm.t);
      }
      s.timers = {};
      if (s.deleted) return mode === 'unload' ? Promise.resolve() : Promise.reject(new Error(DELETED));
      const unload = mode === 'unload';
      // Beim Verlassen der Seite auch Teile neu schreiben, deren Vorgang noch läuft – er kommt sonst evtl. nicht mehr an.
      const keys = KEYS.filter((k) => s.gen[k] > (unload ? s.saved[k] : Math.max(s.saved[k], s.writing[k])));
      if (!keys.length) return Promise.resolve();
      if (unload && s.staleKnown && !s.force) return Promise.resolve(); // veraltetes Raster: ohne Prüfung nichts schreiben
      const r = recRef.current;
      const c = computedRef.current;
      const parts: SaveParts = {};
      const covered = new Set<SaveKey>();
      if (keys.includes('rec') && r) {
        parts.rec = r;
        covered.add('rec');
      }
      if ((keys.includes('mosaic') || keys.includes('progress')) && c) {
        if (keys.includes('mosaic')) {
          // Raster immer zusammen mit dem Fortschritt (Formänderungen setzen „verlegt“ zurück)
          const pk = packWithoutProgress(c.data, r?.mosaicRev);
          parts.mosaic = pk.mosaic;
          covered.add('mosaic');
        }
        parts.progress = c.data.progress;
        covered.add('progress');
      }
      if (keys.includes('image') && s.pendingImage) {
        parts.image = s.pendingImage;
        covered.add('image');
      }
      // ohne Datenquelle (z. B. Raster ersetzt) gibt es nichts mehr zu schreiben
      for (const k of keys) if (!covered.has(k)) s.saved[k] = s.writing[k] = s.gen[k];
      if (!covered.size) {
        refreshSaveState();
        return Promise.resolve();
      }
      const gens = { ...s.gen };
      for (const k of covered) s.writing[k] = Math.max(s.writing[k], gens[k]);
      const guard: SaveGuard = unload ? 'none' : s.force ? 'exists' : 'rev';
      const wasForced = s.force;
      const paletteEdited = !!r && r.palette !== paletteBaseRef.current;
      const p: Promise<void> = saveProjectState(id, parts, guard, r?.mosaicRev, { paletteEdited })
        .then(
          (outcome) => {
            if (outcome === 'deleted') {
              s.deleted = true;
              for (const k of covered) s.writing[k] = s.saved[k];
              window.clearTimeout(s.retryTimer);
              setError({ code: 'deleted', message: DELETED });
              throw new Error(DELETED);
            }
            for (const k of covered) s.saved[k] = Math.max(s.saved[k], gens[k]);
            if (outcome === 'ok' && parts.rec) paletteBaseRef.current = parts.rec.palette;
            if (parts.image && s.pendingImage === parts.image) s.pendingImage = null;
            if (wasForced && guard === 'exists') s.force = false;
            s.retryAttempt = 0;
            window.clearTimeout(s.retryTimer);
            if (s.error) setError(null);
            if (outcome === 'stale') {
              // anderswo neu berechnet: eigene Projektbearbeitungen sind gespeichert, das veraltete Raster nicht
              s.staleKnown = true;
              void adoptRef.current();
            }
          },
          (e: unknown) => {
            for (const k of covered) if (s.writing[k] === gens[k]) s.writing[k] = s.saved[k];
            console.warn('Speichern fehlgeschlagen', e);
            setError(classifySaveError(e));
            scheduleRetry();
            throw e;
          },
        )
        .finally(() => {
          s.inflight.delete(p);
          refreshSaveState();
        });
      s.inflight.add(p);
      refreshSaveState();
      return p;
    },
    [id, refreshSaveState, scheduleRetry, setError],
  );
  persistRef.current = persist;

  /** Markiert einen Teil als geändert und plant das Speichern (entprellt). */
  const markDirty = useCallback(
    (key: SaveKey) => {
      if (!mounted.current) return;
      const s = sv.current;
      s.gen[key]++;
      const now = Date.now();
      const cur = s.timers[key];
      if (!cur || now - cur.first < SAVE_MAX_WAIT) {
        if (cur) window.clearTimeout(cur.t);
        s.timers[key] = { t: window.setTimeout(() => void persistRef.current('normal').catch(() => {}), SAVE_DEBOUNCE[key]), first: cur?.first ?? now };
      }
      refreshSaveState();
    },
    [refreshSaveState],
  );

  /**
   * Speichert sofort alles Ungespeicherte und wartet auch auf laufende Vorgänge.
   * Wird abgelehnt, wenn etwas nicht gespeichert werden konnte.
   */
  const flush = useCallback(async () => {
    const before = [...sv.current.inflight];
    const p = persist('normal');
    const results = await Promise.allSettled([...before, p]);
    const bad = results.find((x): x is PromiseRejectedResult => x.status === 'rejected');
    if (bad) throw bad.reason;
  }, [persist]);

  /** Erneut speichern (für „Erneut versuchen“); liefert true, wenn jetzt alles gespeichert ist. Wirft nie. */
  const retrySave = useCallback(
    (): Promise<boolean> =>
      flush().then(
        () => true,
        () => false,
      ),
    [flush],
  );

  useEffect(() => {
    mounted.current = true;
    // Beim Verlassen/Neuladen/Schließen: sofort (ohne vorheriges Lesen) schreiben und festschreiben,
    // sonst bricht der Browser die Transaktion ab. visibilitychange deckt Android-App-Wechsel ab.
    const onLeave = () => void persistRef.current('unload').catch(() => {});
    const onVis = () => {
      if (document.visibilityState === 'hidden') onLeave();
    };
    window.addEventListener('beforeunload', onLeave);
    window.addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      window.removeEventListener('pagehide', onLeave);
      document.removeEventListener('visibilitychange', onVis);
      // Verlassen innerhalb der App: Seite lebt weiter, also mit Prüfung speichern. Schlägt auch dieser letzte
      // Versuch fehl, gibt es keine automatischen Wiederholungen mehr – app-weit Bescheid geben statt still verlieren.
      void persistRef.current('normal').catch((e: unknown) => {
        if (!isDeletedError(e) && !sv.current.deleted) announceNotice('w2ws.save.lostOnLeave');
      });
      mounted.current = false;
      // Ein wartendes Ergebnis gehört zu dieser Ansicht: nicht übernommen – Bescheid geben statt still verwerfen
      if (pendingRef.current) {
        pendingRef.current = null;
        announceNotice('w2ws.pending.dropped');
      }
      window.clearTimeout(sv.current.retryTimer);
      // Vorschau gehört zu dieser Ansicht: abbrechen (eine als Berechnung übernommene läuft als Auftrag weiter)
      const inf = previewInflight.current;
      if (inf && !inf.promoted) cancelChannel('preview');
      previewInflight.current = null;
      rawCache.current = null;
    };
  }, []);

  // ---------- Laden
  useEffect(() => {
    let alive = true;
    (async () => {
      let st;
      try {
        st = await loadProjectState(id);
      } catch (e) {
        console.warn('Projekt konnte nicht geladen werden', e);
        if (alive) setLoaded(true);
        return;
      }
      if (!alive) return;
      const r = st.rec;
      if (!r) {
        setLoaded(true);
        return;
      }
      setRecBoth(r);
      paletteBaseRef.current = r.palette;
      if (st.image) {
        imageRef.current = st.image;
        setImageState(st.image);
        try {
          const wb = await loadWorkingBitmap(st.image.original);
          if (alive) {
            setBitmap(wb.bitmap);
            setSourceSize({ w: wb.srcW, h: wb.srcH, reduced: wb.reduced });
          } else wb.bitmap.close();
        } catch (e) {
          // nicht still verschlucken: Schritt 1 bittet darum, das Foto neu auszuwählen
          console.warn('Gespeichertes Foto konnte nicht gelesen werden', e);
          if (alive) setImageError('unreadable');
        }
      }
      if (!alive) return;
      const res = restoreComputed(r, st.mosaic, st.progress);
      if (res.computed) {
        // Ältere Projekte: Zellen mit leeren Teilen (z. B. Dreiecksteilung trotz zu breiter Fuge) werden zu
        // ganzen Steinen – sonst zählten Statistik und Fortschritt Teile, die es nicht gibt. Der Benutzer
        // wird informiert (Hinweis im Projektkopf), der reparierte Stand wird gespeichert.
        const fixed = repairDegenerateCells(res.computed.layout, res.computed.data);
        if (fixed > 0) {
          console.warn(`${fixed} Zellen mit leeren Teilen repariert`);
          setRepairedCells(fixed);
          markDirty('mosaic');
        }
      }
      setComputedBoth(res.computed);
      if (res.mismatch) {
        console.warn('Gespeichertes Mosaik passt nicht zum Projekt:', res.mismatch);
        setIntegrityError('mismatch');
        setComputeError('integrity');
        if (st.mosaic) setRejected({ reason: res.mismatch, cells: st.mosaic.cols * st.mosaic.rows, placed: placedInStored(st.mosaic, st.progress) });
      }
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [id, setRecBoth, setComputedBoth, markDirty]);

  // Sperre der Palette, solange irgendwo eine Berechnung dieses Projekts läuft
  useEffect(() => {
    setPaletteLocked(isComputing(id));
    return onComputeLock(() => setPaletteLocked(isComputing(id)));
  }, [id]);

  // Berechnungsaufträge (jobs.ts): Fortschritt dieses Projekts – auch einer Berechnung, die in einer früheren
  // Ansicht gestartet wurde – und eine laufende Berechnung eines anderen Projekts
  useEffect(() => {
    installDeleteHook();
    const sync = () => {
      setComputing(jobFor(id)?.progress ?? null);
      setOtherJob(runningJob(id));
      setJobsActive(anyJob());
    };
    sync();
    return subscribeJobs(sync);
  }, [id]);

  // Foto freigeben, sobald es ersetzt wurde oder die Ansicht geschlossen wird (große Fotos belegen viel Speicher)
  useEffect(() => {
    if (!bitmap) return;
    return () => {
      if (rawCache.current?.bitmap === bitmap) rawCache.current = null;
      try {
        bitmap.close();
      } catch {
        /* bereits freigegeben */
      }
    };
  }, [bitmap]);

  const adopt = useCallback(async () => {
    const s = sv.current;
    let st;
    try {
      st = await loadProjectState(id, { image: false });
    } catch (e) {
      console.warn(e);
      return;
    }
    if (!mounted.current) return;
    const cur = recRef.current;
    if (!st.rec) {
      s.deleted = true;
      setError({ code: 'deleted', message: DELETED });
      return;
    }
    if (!cur || (st.rec.mosaicRev ?? null) === (cur.mosaicRev ?? null)) {
      s.staleKnown = false;
      return;
    }
    // Ohne eigene ungespeicherte Bearbeitungen den gespeicherten Stand vollständig übernehmen (auch die
    // Einstellungen, mit denen anderswo berechnet wurde); sonst eigene Bearbeitungen behalten und nur
    // Raster + Palette (+ zugehörige Felder) aus dem Speicher nehmen.
    const recClean = s.gen.rec === s.saved.rec && s.writing.rec === s.saved.rec;
    // Eine hier bearbeitete eigene Palette bleibt, wenn sie zum neuen Raster passt (nur ergänzt/geändert)
    setRecBoth(recClean ? st.rec : keepStoredComputeFields(cur, st.rec, { paletteEdited: cur.palette !== paletteBaseRef.current }));
    paletteBaseRef.current = st.rec.palette;
    discardGrid();
    const res = restoreComputed(st.rec, st.mosaic, st.progress);
    setComputedBoth(res.computed);
    setIntegrityError(res.mismatch ? 'mismatch' : null);
    setRejected(res.mismatch && st.mosaic ? { reason: res.mismatch, cells: st.mosaic.cols * st.mosaic.rows, placed: placedInStored(st.mosaic, st.progress) } : null);
    setComputeError((prev) => (res.mismatch ? 'integrity' : prev === 'integrity' ? null : prev));
    setVersion((v) => v + 1);
    setProgressVersion((v) => v + 1);
    s.staleKnown = false;
  }, [id, discardGrid, setError, setRecBoth, setComputedBoth]);
  adoptRef.current = adopt;

  useEffect(
    () =>
      onStoreEvent((e) => {
        if (e.id !== id || e.source === instanceRef.current || !mounted.current) return;
        if (e.type === 'deleted') {
          sv.current.deleted = true;
          setError({ code: 'deleted', message: DELETED });
          return;
        }
        if (e.type !== 'computed') return;
        if ((e.mosaicRev ?? null) !== (recRef.current?.mosaicRev ?? null)) {
          sv.current.staleKnown = true;
          void adoptRef.current();
        }
      }),
    [id, setError],
  );

  const update = useCallback(
    (fn: (r: ProjectRecord) => ProjectRecord) => {
      const prev = recRef.current;
      if (!prev) return;
      const next = { ...fn(prev) };
      next.meta = { ...next.meta, updatedAt: Date.now() };
      setRecBoth(next);
      markDirty('rec');
    },
    [markDirty, setRecBoth],
  );

  const setSettings = useCallback((patch: Partial<ProjectSettings>) => update((r) => ({ ...r, settings: { ...r.settings, ...patch } })), [update]);
  const setAdjust = useCallback((patch: Partial<ImageAdjust>) => update((r) => ({ ...r, adjust: { ...r.adjust, ...patch } })), [update]);
  const setRegions = useCallback((regions: Region[]) => update((r) => ({ ...r, regions })), [update]);
  const setPalette = useCallback((palette: PaletteColor[]) => update((r) => ({ ...r, palette })), [update]);

  /**
   * Nach manuellen Änderungen am Raster aufrufen (Steinfarbe/-form, Farbe entfernt).
   * `_dirtyCells`: geänderte Zellen (Vertrag für Welle 4 – wird noch nicht ausgewertet).
   */
  const touchMosaic = useCallback(
    (_dirtyCells?: number[]) => {
      noteEdit(id);
      setVersion((v) => v + 1);
      markDirty('mosaic');
      update((r) => ({ ...r, meta: { ...r.meta, manualEdits: (r.meta.manualEdits ?? 0) + 1 } }));
    },
    [id, markDirty, update],
  );

  /** Nach Änderungen am Verlegefortschritt aufrufen. `_dirtyCells`: Vertrag für Welle 4 (noch nicht ausgewertet). */
  const touchProgress = useCallback((_dirtyCells?: number[]) => {
    noteEdit(id);
    setProgressVersion((v) => v + 1);
    markDirty('progress');
  }, [id, markDirty]);

  // ---------- Foto
  /**
   * Ersetzt das Foto dieses Projekts. Wirft, wenn das Foto nicht gelesen werden kann – dann bleibt das
   * bisherige Foto samt Zuschnitt unverändert. `clearRegions`: Gesichts-/Detailbereiche (gehören zum alten
   * Foto) löschen. `prepared`: bereits gelesene Arbeitskopie (wird übernommen und später freigegeben).
   * Liefert `saved: false`, wenn Foto/Projekt nicht sofort gespeichert werden konnten (der Speicherstatus
   * zeigt den Fehler, Speichern wird automatisch wiederholt).
   */
  const setPhoto = useCallback(
    async (blob: Blob, name: string, opts: { clearRegions?: boolean; prepared?: WorkingBitmap } = {}): Promise<{ saved: boolean }> => {
      const wb = opts.prepared ?? (await loadWorkingBitmap(blob));
      if (!mounted.current) {
        wb.bitmap.close();
        return { saved: false };
      }
      const img = { original: blob, name };
      imageRef.current = img;
      setImageState(img);
      setBitmap(wb.bitmap);
      setSourceSize({ w: wb.srcW, h: wb.srcH, reduced: wb.reduced });
      setImageError(null);
      sv.current.pendingImage = img;
      update((r) => {
        // Projektseitenverhältnis an Foto anpassen, wenn noch nichts berechnet wurde
        const aspect = wb.srcW / wb.srcH;
        const s = r.settings;
        const settings = r.computedWith ? s : { ...s, heightMm: Math.round((s.widthMm / aspect) * 10) / 10 };
        // neue Foto-Identität: eine vorhandene Berechnung gilt damit als veraltet
        const next: ProjectRecord = { ...r, imageRev: uid(), settings, adjust: { ...r.adjust, crop: null, rotation: 0, fineRotate: 0, flipH: false } };
        if (opts.clearRegions) next.regions = [];
        return next;
      });
      markDirty('image');
      // Foto und Projekt sofort gemeinsam speichern; Fehler erscheinen zusätzlich im Speicherstatus
      try {
        await persistRef.current('normal');
        return { saved: true };
      } catch {
        return { saved: false };
      }
    },
    [markDirty, update],
  );

  /**
   * Legt für ein anderes Foto ein NEUES Projekt an (Einstellungen wie dieses, siehe projectFromPhoto);
   * dieses Projekt bleibt unverändert. Projekt und Foto werden in einer Transaktion gespeichert.
   * Wirft PhotoSaveError, wenn nichts gespeichert werden konnte. Liefert die neue Projekt-ID.
   */
  const createProjectFromPhoto = useCallback(async (blob: Blob, fileName: string, src: { w: number; h: number }, fallbackName: string): Promise<string> => {
    const r = recRef.current;
    if (!r) throw new Error('Projekt nicht geladen');
    const nid = uid();
    const next = projectFromPhoto(r, nid, nameFromFile(fileName, fallbackName), src.w / src.h, Date.now(), uid());
    const image: ImageRecord = { original: blob, name: fileName || 'foto' };
    try {
      await txMulti<void>(['projects', 'images'], 'readwrite', (ctx) => {
        ctx.store('projects').put(next, nid);
        ctx.store('images').put(image, nid);
        ctx.commit();
      });
    } catch (e) {
      throw new PhotoSaveError(e);
    }
    return nid;
  }, []);

  // ---------- abgeleitete Werte
  const layoutInfo = useMemo(() => {
    if (!rec) return { layout: null as Layout | null, error: null as string | null };
    try {
      return { layout: computeLayout(layoutParamsOf(rec.settings)), error: null };
    } catch (e) {
      return { layout: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [rec]);

  const sections: SectionGrid | null = useMemo(() => {
    if (!computed || !rec) return null;
    return sectionsFor(computed.layout, rec.settings);
  }, [computed, rec?.settings.sectionMode, rec?.settings.sectionWmm, rec?.settings.sectionHmm, rec?.settings.sectionCols, rec?.settings.sectionRows]); // eslint-disable-line react-hooks/exhaustive-deps

  const stale = !!rec && !!computed && rec.computedWith !== computeKey(rec);

  /**
   * Palettenfarben, die seit der letzten Berechnung bearbeitet wurden (HEX, Name, Material, hinzugefügt) und beim
   * Neuberechnen verloren gehen: nur in den Modi, in denen die Berechnung die Palette neu erstellt (nicht bei
   * eigener Palette – die ist eine Eingabe und bleibt). Exakt aus dem Fingerabdruck der Berechnung.
   */
  const paletteEdits = rec && computed && rec.settings.paletteMode !== 'custom' ? paletteEditsSince(rec.computedPaletteSig, rec.palette) : 0;
  /** true: Fingerabdruck der berechneten Palette unbekannt (ältere Projekte) – Palettenbearbeitungen nicht einzeln erfasst */
  const paletteEditsUnknown = !!rec && !!computed && rec.settings.paletteMode !== 'custom' && !rec.computedPaletteSig;

  /** Schneller Verlegefortschritt (ohne Geometrie) – gesamt und je Abschnitt. */
  const progress = useMemo(() => {
    if (!computed || !sections) return null;
    const total = progressOf(computed.layout, computed.data);
    const perSection = new Map(sections.sections.map((s) => [s.id, progressOf(computed.layout, computed.data, s)]));
    return { total, perSection };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed, sections, version, progressVersion]);

  /** Effektiver Zuschnitt (normiert) passend zum Seitenverhältnis der fertigen Mosaikfläche. */
  // Maße des Originals (nicht der evtl. verkleinerten Arbeitskopie): Zuschnitt und Arbeitsauflösung wie bei voller Dekodierung
  const srcW = sourceSize?.w ?? bitmap?.width ?? 0;
  const srcH = sourceSize?.h ?? bitmap?.height ?? 0;
  const effectiveCrop = useMemo(() => {
    if (!rec || !bitmap || !layoutInfo.layout || !srcW || !srcH) return null;
    const { w, h } = rotatedSize(srcW, srcH, rec.adjust);
    return fitCrop(rec.adjust.crop, w, h, layoutInfo.layout.finishedW / layoutInfo.layout.finishedH);
  }, [rec, bitmap, srcW, srcH, layoutInfo.layout]);

  // ---------- Statistik (im Worker)
  const statsReq = useRef(0);
  const lastStatsVersion = useRef(-1);
  useEffect(() => {
    if (!computed || !rec) {
      setStats(null);
      return;
    }
    const my = ++statsReq.current;
    const timer = window.setTimeout(async () => {
      setStatsBusy(true);
      try {
        const secs = sectionsFor(computed.layout, rec.settings);
        const res = await runWorker<'stats'>('stats', {
          type: 'stats',
          layoutParams: computed.layoutParams,
          mosaic: packMosaic(computed.data),
          palette: rec.palette,
          materials,
          reservePct: rec.settings.reservePct,
          groutDepthMm: rec.settings.groutDepthMm,
          ranges: secs.sections.map((s) => ({ key: s.id, range: { r0: s.r0, r1: s.r1, c0: s.c0, c1: s.c1 } })),
        });
        if (my !== statsReq.current) return;
        setStats(res.total);
        setSectionStats(new Map(res.ranges.map((r) => [r.key, r.stats])));
      } catch (e) {
        console.error(e);
      } finally {
        if (my === statsReq.current) setStatsBusy(false);
      }
    }, lastStatsVersion.current === version ? 1500 : 250);
    lastStatsVersion.current = version;
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed, version, progressVersion, rec?.palette, materials, rec?.settings.reservePct, rec?.settings.groutDepthMm, rec?.settings.sectionMode, rec?.settings.sectionWmm, rec?.settings.sectionHmm, rec?.settings.sectionCols, rec?.settings.sectionRows]);

  // ---------- Berechnung und Live-Vorschau (gemeinsamer Rechenweg, siehe describeComputeInputs)
  /** Eingaben einer Berechnung für den Projektstand `r` mit dem aktuellen Foto, den Materialien und der Sprache. */
  const describeNow = useCallback(
    (r: ProjectRecord): ComputeInputsResult | null =>
      bitmap
        ? describeComputeInputs(r, {
            bitmap,
            bw: bitmap.width,
            bh: bitmap.height,
            srcW: srcW || bitmap.width,
            srcH: srcH || bitmap.height,
            reduced: !!sourceSize?.reduced,
            hasOriginal: !!image?.original,
            materials,
            lang,
          })
        : null,
    [bitmap, srcW, srcH, sourceSize, image, materials, lang],
  );
  /** Eingaben der aktuellen Einstellungen (Fingerabdruck für Vorschau und „Übernehmen“) */
  const inputsNow = useMemo(() => (rec ? describeNow(rec) : null), [rec, describeNow]);
  const inputsNowRef = useRef(inputsNow);
  inputsNowRef.current = inputsNow;

  // Meldungen in anderen Projekten nennen den aktuellen Namen
  const recName = rec?.meta.name;
  useEffect(() => {
    if (recName !== undefined) renameJob(id, recName);
  }, [id, recName]);

  /** Gibt es am angezeigten Mosaik jetzt etwas, das ein Übernehmen verwerfen würde (verlegt, manuell geändert)? */
  const displayedWorkAtRisk = useCallback((): boolean => {
    const c = computedRef.current;
    if (!c) return false;
    return progressOf(c.layout, c.data).placed > 0 || (recRef.current?.meta.manualEdits ?? 0) > 0;
  }, []);

  /**
   * Übernimmt ein gespeichertes Ergebnis in diese Ansicht (wird vom Auftrag aufgerufen – auch, wenn er in einer
   * früheren Ansicht dieses Projekts gestartet wurde).
   */
  const applyCommitted = useCallback(
    (job: PendingCommit, committed: ProjectRecord | null, saveFailure: unknown) => {
      if (!mounted.current) return;
      const { fields, data, proc, layout, lp } = job;
      setProcessed(proc);
      data.rev = fields.mosaicRev;
      const latest = recRef.current ?? job.started;
      // Palette, die jetzt zum gespeicherten Raster gehört (bei eigener Palette ggf. mit Ergänzungen,
      // die anderswo während der Berechnung gespeichert wurden – siehe commitComputed)
      const storedPalette = committed?.palette ?? fields.palette;
      const asStored = () => mergeComputeFields({ ...latest, palette: storedPalette }, { ...fields, customInput: undefined, palette: storedPalette, computedWith: committed?.computedWith ?? fields.computedWith });
      let merged: ProjectRecord;
      if (latest.palette === paletteBaseRef.current) {
        // hier nicht bearbeitet: der gespeicherte Stand gilt
        merged = asStored();
      } else {
        try {
          // hier bearbeitet (noch nicht gespeichert): nur ergänzt/geändert → bleibt, sonst gilt das Gespeicherte
          merged = mergeComputeFields(latest, fields);
        } catch {
          // Palette wurde in den Millisekunden des Speicherns verkürzt (sonst gesperrt): Raster und
          // gespeicherte Palette gehören zusammen – diese Palette gilt.
          merged = asStored();
        }
      }
      setRecBoth(merged);
      paletteBaseRef.current = committed?.palette ?? fields.palette;
      setComputedBoth({ layout, layoutParams: lp, data });
      setIntegrityError(null);
      setRejected(null);
      setComputeError(null);
      discardGrid(); // ausstehende Speicherungen gehören zum ersetzten Raster
      setVersion((v) => v + 1);
      setProgressVersion((v) => v + 1);
      // Eine übernommene Vorschau teilt ihr Raster jetzt mit dem gespeicherten Mosaik: nicht weiter als Vorschau führen
      if (job.origin === 'preview') setPreview((p) => (p.result && p.result.data === data ? { ...p, result: null } : p));
      setCommittedAt(Date.now());
      if (saveFailure) {
        // Ergebnis ist berechnet, aber nicht gespeichert: im Speicher behalten, vollständig nachspeichern
        console.warn('Ergebnis konnte nicht gespeichert werden', saveFailure);
        const sref = sv.current;
        sref.force = true;
        markDirty('rec');
        markDirty('mosaic');
        markDirty('progress');
        setError(classifySaveError(saveFailure));
      }
    },
    [discardGrid, markDirty, setError, setRecBoth, setComputedBoth],
  );

  // Diese Ansicht beim Auftragsregister anmelden: Ergebnisse (auch einer Berechnung, die vor dem erneuten Öffnen
  // gestartet wurde) landen hier, und hier wird gefragt, ob am angezeigten Mosaik Arbeit auf dem Spiel steht.
  const handlerImpl = useRef({ applyCommitted, displayedWorkAtRisk });
  handlerImpl.current = { applyCommitted, displayedWorkAtRisk };
  useEffect(() => {
    const handler: ProjectHandler = {
      instance: instanceRef.current,
      latestPalette: () => recRef.current?.palette ?? null,
      groutHex: () => recRef.current?.settings.groutHex ?? null,
      workAtRisk: () => handlerImpl.current.displayedWorkAtRisk(),
      hold: (job) => {
        pendingRef.current = job;
        setPendingResult({ at: Date.now() });
      },
      applyCommitted: (job, committed, saveFailure) => handlerImpl.current.applyCommitted(job, committed, saveFailure),
      onError: (code) => {
        if (mounted.current) setComputeError(code);
      },
    };
    return attachProject(id, handler);
  }, [id]);

  /**
   * Berechnen bzw. Übernehmen. Passt eine fertige Live-Vorschau genau zu den aktuellen Eingaben (gleicher
   * Fingerabdruck, gleiches Foto), wird sie ohne zweite Berechnung gespeichert; rechnet sie gerade, wird sie
   * weiterverwendet. Die Berechnung läuft als Auftrag (jobs.ts): Sie endet und speichert auch, wenn die Ansicht
   * geschlossen wird. App-weit läuft höchstens eine Berechnung. Liefert true, wenn ein Ergebnis übernommen wurde.
   */
  const compute = useCallback(async (): Promise<boolean> => {
    // Momentaufnahme NUR für die Eingaben der Berechnung; das Ergebnis wird später in den neuesten Stand übernommen
    const r = recRef.current;
    const inp = r ? describeNow(r) : null;
    if (!r || !inp) return false;
    if (!inp.ok) {
      setComputeError(inp.error);
      return false;
    }
    if (jobFor(id)) return false;
    const pv = previewRef.current.result;
    const direct = pv && pv.sig === inp.sig && pv.bitmap === inp.bitmap ? pv : null;
    const inflight = previewInflight.current;
    const reuse = !direct && inflight && inflight.sig === inp.sig && !inflight.promoted ? inflight : null;
    if (!direct && runningJob(id)) {
      setComputeError('busy');
      return false;
    }
    // Eine Vorschau anderer Einstellungen würde die Berechnung nur bremsen
    if (!direct && !reuse && inflight && !inflight.promoted) cancelChannel('preview');
    // Ein noch wartendes Ergebnis wird durch diese Berechnung ersetzt
    pendingRef.current = null;
    setPendingResult(null);
    setComputeError(null);
    // Stand der Bearbeitungen am angezeigten Mosaik beim Start (siehe noteEdit)
    const startEdits = editCount(id);
    const source = uid();
    const original = imageRef.current?.original ?? null;
    let handle: { promise: Promise<JobOutcome> };
    try {
      handle = startJob<JobOutcome>({
        projectId: id,
        projectName: r.meta.name,
        exclusive: !direct,
        phase: direct ? 'commit' : 'prepare',
        // Übernehmen einer fertigen Vorschau ist sofort fertig und benutzt keinen Worker: nichts abzubrechen
        // (ein Abbruch des Kanals 'compute' träfe sonst die Berechnung eines anderen Projekts)
        cancel: direct ? () => {} : () => cancelChannel(reuse ? 'preview' : 'compute'),
        run: async (ctx) => {
          // Palette sperren (auch für andere Ansichten/Tabs), bis das Ergebnis gespeichert oder verworfen ist
          const endLock = beginCompute(id);
          try {
            let out: ComputeOutput;
            if (direct) out = direct;
            else if (reuse) {
              reuse.promoted = true;
              reuse.listeners.add((p) => ctx.report(p));
              out = await reuse.promise;
            } else {
              out = await runComputeWith(inp, 'compute', (phase, fraction) => ctx.report({ phase, fraction }), rawCache, original);
              noteMeasured(out);
            }
            if (ctx.cancelled) throw new Error('abgebrochen');
            ctx.report({ phase: 'commit', fraction: 0 });
            return await finishJob(id, out, startEdits, direct || reuse ? 'preview' : 'compute', source);
          } finally {
            endLock();
          }
        },
      });
    } catch (e) {
      if (e instanceof JobBusyError) setComputeError('busy');
      return false;
    }
    try {
      return (await handle.promise) === 'committed';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Fehler erscheinen in der Ansicht, die jetzt geöffnet ist (auch nach Verlassen und erneutem Öffnen)
      if (msg !== 'abgebrochen') projectHandler<ProjectHandler>(id)?.onError(msg);
      return false;
    }
  }, [id, describeNow]);

  /**
   * Übernimmt das wartende Ergebnis (verwirft dabei Fortschritt und Änderungen am bisherigen Mosaik – der Aufrufer
   * hat nachgefragt). Liefert true, wenn es übernommen wurde.
   */
  const applyPending = useCallback(async (): Promise<boolean> => {
    const job = pendingRef.current;
    if (!job) return false;
    pendingRef.current = null;
    setPendingResult(null);
    setComputeError(null);
    const endLock = beginCompute(id);
    try {
      // Eigene Palette inzwischen verkürzt/umsortiert: das Ergebnis passt nicht mehr
      if (recRef.current && !resolveComputedPalette(recRef.current.palette, job.fields)) throw new Error(PALETTE_CHANGED);
      return (await persistCommit(id, job, instanceRef.current)) === 'committed';
    } catch (e) {
      if (mounted.current) setComputeError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      endLock();
    }
  }, [id]);

  /** Verwirft das wartende Ergebnis; das angezeigte Mosaik mit seinem Fortschritt bleibt. */
  const discardPending = useCallback(() => {
    pendingRef.current = null;
    setPendingResult(null);
  }, []);

  /** Bricht die Berechnung dieses Projekts ab – auch eine, die vor dem erneuten Öffnen gestartet wurde. */
  const cancelCompute = useCallback(() => void cancelJob(id), [id]);
  /** Bricht die laufende Berechnung eines anderen Projekts ab (app-weit läuft nur eine). */
  const cancelOtherJob = useCallback(() => {
    const o = runningJob(id);
    if (o) cancelJob(o.projectId);
  }, [id]);

  // ---------- Live-Vorschau: rechnet die aktuellen Einstellungen, ohne etwas zu speichern
  /** Startet eine Vorschau für diese Eingaben (verwirft eine laufende ältere; deren Ergebnis wird nie angezeigt). */
  const runPreview = useCallback(async (inp: ComputeInputs) => {
    if (!mounted.current) return;
    const prev = previewInflight.current;
    if (prev?.promoted) return; // läuft als Berechnung weiter – Vorschau wartet ohnehin, solange ein Auftrag läuft
    const my = ++previewReq.current;
    if (prev) cancelChannel('preview');
    previewInflight.current = null;
    const listeners = new Set<(p: JobProgress) => void>();
    setPreview((p) => ({ ...p, running: { sig: inp.sig, progress: { phase: 'prepare', fraction: 0 } } }));
    const onProgress = (phase: string, fraction: number) => {
      for (const l of listeners) l({ phase, fraction });
      if (mounted.current && my === previewReq.current) setPreview((p) => (p.running?.sig === inp.sig ? { ...p, running: { sig: inp.sig, progress: { phase, fraction } } } : p));
    };
    const promise = runComputeWith(inp, 'preview', onProgress, rawCache, imageRef.current?.original ?? null);
    const entry = { sig: inp.sig, my, promise, listeners, promoted: false };
    previewInflight.current = entry;
    try {
      const out = await promise;
      if (previewInflight.current === entry) previewInflight.current = null;
      if (!mounted.current || my !== previewReq.current) return;
      noteMeasured(out);
      setPreview((p) => ({ ...p, result: out, running: null, error: null, last: { ms: out.ms, cells: out.cells } }));
    } catch (e) {
      if (previewInflight.current === entry) previewInflight.current = null;
      if (!mounted.current || my !== previewReq.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      // abgebrochen (neue Einstellungen, Berechnung gestartet): kein Fehler
      setPreview((p) => ({ ...p, running: null, error: msg === 'abgebrochen' ? p.error : { sig: inp.sig, msg } }));
    }
  }, []);
  const runPreviewRef = useRef(runPreview);
  runPreviewRef.current = runPreview;

  /** LivePreview meldet sich an, solange sie angezeigt wird (nur dann rechnet die Vorschau). */
  const watchPreview = useCallback(() => {
    setPreviewWatchers((w) => w + 1);
    return () => setPreviewWatchers((w) => w - 1);
  }, []);

  /** „Vorschau aktualisieren“: sofort rechnen (auch bei großen Mosaiken oder nach einer langsamen Vorschau). */
  const refreshPreview = useCallback(() => {
    const inp = inputsNowRef.current;
    if (!inp || !inp.ok || anyJob()) return;
    setPreview((p) => (p.error?.sig === inp.sig ? { ...p, error: null } : p));
    void runPreviewRef.current(inp);
  }, []);

  const slowDevice = useMemo(() => {
    try {
      return isSlowDevice(typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined, typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
    } catch {
      return false;
    }
  }, []);
  const committedCurrent = !!computed && !stale;
  const sigNow = inputsNow?.ok ? inputsNow.sig : null;
  const cellsNow = inputsNow?.ok ? inputsNow.cells : layoutInfo.layout ? layoutInfo.layout.cols * layoutInfo.layout.rows : 0;
  const policy = previewPolicy({ cells: cellsNow, slow: slowDevice, lastMs: preview.last?.ms ?? null });

  // Nach jeder Änderung (entprellt) neu rechnen – nur wenn eine Vorschau angezeigt wird, das gespeicherte Mosaik die
  // Einstellungen nicht schon zeigt, keine Berechnung läuft und das Mosaik klein bzw. die letzte Vorschau schnell war.
  const previewHasCurrent = !!preview.result && preview.result.sig === sigNow && preview.result.bitmap === bitmap;
  const previewFailedNow = !!sigNow && preview.error?.sig === sigNow;
  useEffect(() => {
    if (previewWatchers <= 0 || !sigNow || committedCurrent || jobsActive || !policy.auto || previewHasCurrent || previewFailedNow) return;
    if (previewInflight.current?.sig === sigNow) return;
    const active = typeof document !== 'undefined' ? (document.activeElement as { tagName?: string; type?: string } | null) : null;
    setPreviewScheduled(true);
    const timer = window.setTimeout(() => {
      setPreviewScheduled(false);
      const inp = inputsNowRef.current;
      if (inp?.ok && inp.sig === sigNow) void runPreviewRef.current(inp);
    }, previewDebounceMs(isTypingTarget(active)));
    return () => {
      window.clearTimeout(timer);
      setPreviewScheduled(false);
    };
  }, [previewWatchers, sigNow, committedCurrent, jobsActive, policy.auto, previewHasCurrent, previewFailedNow]);

  const previewInfo: PreviewInfo = {
    result: preview.result,
    current: previewHasCurrent,
    running: preview.running?.progress ?? null,
    runningCurrent: !!preview.running && preview.running.sig === sigNow,
    scheduled: previewScheduled,
    error: previewFailedNow ? (preview.error?.msg ?? null) : null,
    inputError: !bitmap ? 'no-photo' : inputsNow && !inputsNow.ok ? inputsNow.error : null,
    cells: cellsNow,
    auto: policy.auto,
    reason: policy.reason,
    estimateMs: estimatePreviewMs(cellsNow, preview.last ?? lastMeasured, slowDevice, rec?.settings.dither ?? 0),
    lastMs: preview.last?.ms ?? null,
    paused: jobsActive,
    committedCurrent,
  };
  /** „Übernehmen“ speichert die fertige Vorschau ohne zweite Berechnung */
  const previewCommittable = previewHasCurrent && !committedCurrent;

  const originalPreview = useCallback((maxPx: number) => (bitmap && rec ? renderRotated(bitmap, rec.adjust, maxPx) : null), [bitmap, rec]);

  /**
   * Projektdatei aus dem Stand im ARBEITSSPEICHER (nicht aus dem Gerätespeicher) – zum Sichern,
   * wenn Speichern fehlschlägt.
   */
  const exportCurrent = useCallback(async (): Promise<Blob> => {
    const r = recRef.current;
    if (!r) throw new Error('Projekt nicht geladen');
    const c = computedRef.current;
    const pk = c ? packWithoutProgress(c.data, r.mosaicRev) : null;
    return buildProjectExport(r, imageRef.current, pk?.mosaic ?? null, pk?.progress ?? null);
  }, []);

  /**
   * Legt eine vollständige Kopie des Projekts an (Datensatz, Foto, Raster, Fortschritt) und liefert ihre ID.
   * Speichert vorher alles Ausstehende; schlägt das fehl, wird KEINE Kopie angelegt (Fehler wird geworfen).
   */
  const createBackupCopy = useCallback(
    async (suffix: string): Promise<string> => {
      await flush();
      const nid = await duplicateProject(id, suffix);
      if (!nid) throw new Error(DELETED);
      return nid;
    },
    [flush, id],
  );

  return {
    loaded,
    rec,
    image,
    /** Arbeitskopie des Fotos (kann kleiner als das Original sein – Maße des Originals: sourceSize) */
    bitmap,
    /** Pixelmaße des Originalfotos (nach EXIF-Ausrichtung) und ob die Arbeitskopie verkleinert ist */
    sourceSize,
    /** 'unreadable': gespeichertes Foto konnte nicht gelesen werden */
    imageError,
    layout: layoutInfo.layout,
    layoutError: layoutInfo.error,
    computed,
    sections,
    version,
    progressVersion,
    stats,
    sectionStats,
    progress,
    statsBusy,
    /** Fortschritt der Berechnung dieses Projekts (auch einer vor dem erneuten Öffnen gestarteten) */
    computing,
    /** laufende Berechnung eines anderen Projekts (app-weit nur eine) – „Berechnung für „X“ läuft noch“ */
    otherJob,
    cancelOtherJob,
    /** Zeitpunkt, zu dem diese Ansicht zuletzt ein Ergebnis übernommen hat (0 = noch keins) */
    committedAt,
    computeError,
    stale,
    /** Live-Vorschau der aktuellen Einstellungen (nie gespeichert) */
    preview: previewInfo,
    /** „Übernehmen“ speichert die fertige Vorschau ohne zweite Berechnung */
    previewCommittable,
    watchPreview,
    refreshPreview,
    effectiveCrop,
    processed,
    /** Speicherstatus für die Anzeige („Gespeichert ✓ / Speichert … / Nicht gespeichert“) */
    saveState,
    saveError,
    /** 'mismatch': gespeichertes Raster gehört nicht zur Palette – nicht angezeigt, neu berechnen */
    integrityError,
    /** Angaben zum nicht angezeigten gespeicherten Raster (z. B. verlegte Steine, die beim Neuberechnen verloren gehen) */
    rejected,
    /** beim Laden reparierte Zellen mit leeren Teilen (0 = keine) */
    repairedCells,
    dismissRepaired: () => setRepairedCells(0),
    /** Palette gesperrt, weil (irgendwo) eine Berechnung dieses Projekts läuft */
    paletteLocked,
    /** Anzahl manueller Rasteränderungen seit der letzten Berechnung */
    manualEdits: rec?.meta.manualEdits ?? 0,
    /** Palettenfarben, die seit der letzten Berechnung bearbeitet wurden und beim Neuberechnen verloren gehen */
    paletteEdits,
    /** Palettenbearbeitungen dieses (älteren) Projekts nicht einzeln erfasst */
    paletteEditsUnknown,
    /** Ergebnis wartet auf Entscheidung (während der Berechnung wurde am Mosaik gearbeitet) */
    pendingResult,
    applyPending,
    discardPending,
    update,
    setSettings,
    setAdjust,
    setRegions,
    setPalette,
    setPhoto,
    createProjectFromPhoto,
    touchMosaic,
    touchProgress,
    compute,
    cancelCompute,
    originalPreview,
    flush,
    retrySave,
    exportCurrent,
    createBackupCopy,
  };
}

export type ProjectApi = ReturnType<typeof useProject>;
