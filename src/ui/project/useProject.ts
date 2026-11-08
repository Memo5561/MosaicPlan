import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hexToLab, isValidHex } from '../../core/color';
import { invalidFreeCells, repairDegenerateCells } from '../../core/edits';
import { checkMosaicIntegrity } from '../../core/integrity';
import { cellId, computeLayout, sectionsFor, type Layout, type LayoutParams, type SectionGrid } from '../../core/layout';
import type { ComputeDiagnostics, FixedColor } from '../../core/mosaic';
import { renderFull } from '../../core/render';
import { carryOverProgress, type CarryOverReport, type CarrySide } from '../../core/progressCarry';
import { applyDiff, applyDirty, buildProgressIndex, countProgress, progressFromIndex, type ProgressIndex } from '../../core/progressIndex';
import { packMosaic, unpackMosaic, type MosaicDataWithRev } from '../../core/serialize';
import { popcount, type Stats } from '../../core/stats';
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
  type CarryOverInfo,
  type CommitCarry,
  type ComputeFields,
  type ImageRecord,
  type ProgressSummary,
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
 * Zellenliste eines touch*-Aufrufs: Array oder anderes Iterable von Zellindizes. Alles andere (z. B. ein Klick-Ereignis,
 * wenn die Funktion direkt als onClick übergeben wird) gilt als „keine Liste“.
 */
function cellList(v: unknown): Iterable<number> | null {
  if (!v || typeof v !== 'object' || typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') return null;
  return v as Iterable<number>;
}

/** Schlüssel der Abschnittseinstellungen (gleicher Schlüssel + gleiches Raster ⇒ gleiche Abschnitte). */
export function sectionKeyOf(s: Pick<ProjectSettings, 'sectionMode' | 'sectionWmm' | 'sectionHmm' | 'sectionCols' | 'sectionRows'>): string {
  return JSON.stringify([s.sectionMode ?? 'size', s.sectionWmm, s.sectionHmm, s.sectionCols ?? null, s.sectionRows ?? null]);
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

/**
 * Pflichtfarben als Eingabe der Berechnung (reine Funktion, von describeComputeInputs verwendet): nur in den Modi
 * „Automatisch aus dem Foto“ und „Meine Steine – begrenzte Farbanzahl“, mit dem Lab-Wert aus dem HEX-Wert. Ungültige
 * HEX-Werte fallen weg, gleiche zählen einmal. undefined, wenn es keine gibt – die Worker-Anfrage (und damit ihr
 * Fingerabdruck) älterer Projekte bleibt dann unverändert.
 */
export function pinnedFixedColors(s: Pick<ProjectSettings, 'paletteMode' | 'pinnedColors'>): FixedColor[] | undefined {
  if (s.paletteMode !== 'auto' && s.paletteMode !== 'auto-snap') return undefined;
  const out: FixedColor[] = [];
  const seen = new Set<string>();
  for (const p of s.pinnedColors ?? []) {
    const raw = typeof p?.hex === 'string' ? p.hex.trim() : '';
    if (!isValidHex(raw)) continue;
    let h = raw.replace('#', '').toUpperCase();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const hex = `#${h}`;
    if (seen.has(hex)) continue;
    seen.add(hex);
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : hex;
    out.push({ lab: hexToLab(hex), hex, name });
  }
  return out.length ? out : undefined;
}

/** Kurzer Hash (53 Bit, cyrb53) eines Textes – für Fingerabdrücke, die im Projekt gespeichert werden. */
function hash53(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Fingerabdruck der Materialien, aus denen eine Berechnung ihre Farben nimmt (reine Funktion; Eingabe ist die feste
 * Palette von buildFixedPalette). Nur in den Modi „Materialien“ und „Meine Steine – begrenzte Farbanzahl“, sonst
 * undefined. Enthalten: Farbton und Name jedes angebotenen Materials, bei der begrenzten Farbanzahl zusätzlich, ob es
 * auf Lager ist (nur das wertet die Auswahl aus – 200 → 150 Stück ändert nichts, 0 → 200 schon). Ohne Material-IDs
 * und sortiert: Nach einem Import mit gleichen Materialdaten bleibt er gleich. 'none': keine Materialien vorhanden.
 * computeKey kennt die Materialinhalte nicht; dieser Fingerabdruck wird mit der Berechnung gespeichert
 * (computedMaterialSig) und zeigt, wenn die Materialien seitdem geändert wurden.
 */
export function materialInputSig(paletteMode: ProjectSettings['paletteMode'], fixed: readonly FixedColor[] | undefined | 'none'): string | undefined {
  if (paletteMode !== 'materials' && paletteMode !== 'auto-snap') return undefined;
  if (fixed === 'none' || !fixed || !fixed.length) return 'none';
  const snap = paletteMode === 'auto-snap';
  const entries = fixed.map((f) => JSON.stringify(snap ? [f.hex.toUpperCase(), f.name, (f.stock ?? 0) > 0] : [f.hex.toUpperCase(), f.name])).sort();
  return `${entries.length}:${hash53(entries.join('|'))}`;
}

/** Fingerabdruck der Materialien für den Projektstand `r` und die Materialien dieses Geräts (siehe materialInputSig). */
export function materialSigFor(r: Pick<ProjectRecord, 'settings' | 'palette'>, materials: readonly Material[]): string | undefined {
  const pm = r.settings.paletteMode;
  if (pm !== 'materials' && pm !== 'auto-snap') return undefined;
  try {
    return materialInputSig(pm, buildFixedPalette(r.settings, r.palette, materials));
  } catch {
    return materialInputSig(pm, 'none');
  }
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
    // Pflichtfarben (nur Automatik-Modi). Ohne Pflichtfarben fehlt der Eintrag – ältere Schlüssel bleiben gleich.
    pc: (s.paletteMode === 'auto' || s.paletteMode === 'auto-snap') && s.pinnedColors?.length ? s.pinnedColors.map((p) => p.hex.toUpperCase()) : undefined,
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
  /** Fingerabdruck der angebotenen Materialien (siehe materialInputSig; undefined außerhalb der Materialmodi) */
  materialSig: string | undefined;
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
  // Pflichtfarben (z. B. Schwarz für Pupillen) – nur gesetzt, wenn vorhanden (Fingerabdruck älterer Projekte gleich)
  const pinned = pinnedFixedColors(s);
  const request: ComputeRequest = {
    type: 'compute',
    adjust: { ...r.adjust, crop: null },
    regions: r.regions,
    layoutParams: lp,
    params: {
      shapes: s.shapes,
      paletteMode: s.paletteMode,
      colorCount: s.colorCount,
      dither: s.dither,
      deltaE: s.deltaE,
      fixedPalette: fixed,
      regions: r.regions,
      lang: env.lang,
      ...(pinned ? { pinnedColors: pinned } : {}),
    },
  };
  const key = computeKey(r);
  const sig = JSON.stringify({ q: request, c: crop, ws, f: full, im: r.imageRev ?? null, sw: env.srcW, sh: env.srcH });
  return { ok: true, rec: r, key, sig, materialSig: materialInputSig(s.paletteMode, fixed), lang: env.lang, layout, lp, cells, crop, ws, full, request, bitmap: env.bitmap };
}

/** Ergebnis einer Berechnung (Vorschau oder „Berechnen“), noch nicht gespeichert. */
export interface ComputeOutput {
  sig: string;
  key: string;
  /** Fingerabdruck der angebotenen Materialien (wird mit dem Ergebnis gespeichert) */
  materialSig?: string;
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

/**
 * Arbeitsbild für eine Berechnung. Die Vorschau (`consume` = false) behält es im Zwischenspeicher und gibt dem Worker
 * eine Kopie – die nächste Vorschau derselben Geometrie braucht es wieder. „Berechnen“ (`consume` = true) nimmt es
 * aus dem Zwischenspeicher und übergibt es ohne Kopie: Danach (Schritte 8–10) braucht es niemand mehr, und ein
 * 6-MP-Arbeitsbild belegt 24 MB.
 */
export async function rawFor(inp: Pick<ComputeInputs, 'bitmap' | 'rec' | 'crop' | 'ws' | 'full'>, cache: RawCache, original: Blob | null, consume = false, render: (bmp: ImageBitmap, inp: Pick<ComputeInputs, 'rec' | 'crop' | 'ws'>) => RawImage = (bmp, i) => canvasToRaw(renderCropped(bmp, i.rec.adjust, i.crop, i.ws.w, i.ws.h))): Promise<RawImage> {
  const bmp = inp.bitmap;
  if (!bmp) throw new Error('no-photo');
  const ck = rawCacheKey(inp);
  let raw: RawImage;
  const hit = cache.current;
  if (hit && hit.bitmap === bmp && hit.key === ck) {
    raw = hit.raw;
    if (consume) {
      cache.current = null;
      return raw;
    }
  } else {
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
      raw = render(fullBmp ?? bmp, inp);
    } finally {
      fullBmp?.close(); // volle Auflösung nur für diesen einen Zuschnitt im Speicher halten
    }
    if (consume) return raw;
    // Vorschauen derselben Geometrie rechnen mit genau diesen Bildpunkten
    cache.current = { bitmap: bmp, key: ck, raw };
  }
  // Kopie für die Übergabe an den Worker (das Original bleibt im Zwischenspeicher)
  return { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data) };
}

/** Rechnet die beschriebenen Eingaben im Worker des Kanals (Vorschau: 'preview', Berechnung: 'compute'). */
export async function runComputeWith(inp: ComputeInputs, channel: Channel, onProgress: (phase: string, fraction: number) => void, cache: RawCache, original: Blob | null): Promise<ComputeOutput> {
  const t0 = performance.now();
  // Die Berechnung braucht das Arbeitsbild danach nicht mehr (siehe rawFor)
  const raw = await rawFor(inp, cache, original, channel === 'compute');
  const res = await runWorker<'compute'>(channel, { ...inp.request, image: raw }, [raw.data.buffer as ArrayBuffer], onProgress);
  const data: MosaicDataWithRev = unpackMosaic(res.mosaic);
  return {
    sig: inp.sig,
    key: inp.key,
    materialSig: inp.materialSig,
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
export function commitFieldsOf(out: Pick<ComputeOutput, 'snapshot' | 'palette' | 'diagnostics' | 'materialSig'>, o: { thumb?: string; now: number; rev: string }): ComputeFields {
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
    // Materialien, aus denen die Farben genommen wurden (Materialien später geändert → nicht mehr „aktuell“)
    ...(out.materialSig !== undefined ? { computedMaterialSig: out.materialSig } : {}),
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
export interface ProjectHandler {
  instance: string;
  /**
   * Erfüllt, sobald die Ansicht ihren Stand geladen hat (oder geschlossen wurde). Erst danach wird sie gefragt und
   * übernimmt ein Ergebnis – sonst könnte der noch laufende Ladevorgang ein gerade übernommenes Ergebnis mit dem
   * zuvor gelesenen alten Raster überschreiben (neue Palette + altes Raster = falsche Farben).
   */
  ready(): Promise<void>;
  latestPalette(): PaletteColor[] | null;
  groutHex(): string | null;
  workAtRisk(): boolean;
  /**
   * Angezeigter Stand (Raster mit den neuesten Markierungen „verlegt“, Palette, Revision) als Grundlage für die
   * Übernahme des Fortschritts beim Festschreiben; null: keiner angezeigt.
   */
  carryBase(): CarryBase | null;
  hold(job: PendingCommit): void;
  applyCommitted(job: PendingCommit, committed: ProjectRecord | null, saveFailure: unknown): void;
  onError(code: string): void;
}

/**
 * Die angemeldete Ansicht des Projekts, sobald sie geladen ist (siehe ProjectHandler.ready); undefined: keine offen.
 * Höchstens `maxWaitMs` lang (hängt das Laden, endet der Auftrag trotzdem): Eine noch ladende Ansicht stellt ein
 * übergebenes Ergebnis dann zurück und liest Projekt und Raster nach dem Laden gemeinsam neu (applyCommitted).
 */
export async function settledHandler(id: string, maxWaitMs = 20_000): Promise<ProjectHandler | undefined> {
  const until = Date.now() + maxWaitMs;
  for (let i = 0; i < 50; i++) {
    const h = projectHandler<ProjectHandler>(id);
    if (!h) return undefined;
    const left = until - Date.now();
    if (left <= 0) return h;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([h.ready(), new Promise<void>((r) => (timer = setTimeout(r, left)))]);
    if (timer !== undefined) clearTimeout(timer);
    // Während des Wartens kann eine neuere Ansicht angemeldet worden sein: auf deren Laden ebenfalls warten
    if (projectHandler<ProjectHandler>(id) === h) return h;
  }
  return projectHandler<ProjectHandler>(id);
}

/** Stand, aus dem der Verlegefortschritt beim Neuberechnen übernommen wird (siehe core/progressCarry.ts). */
export interface CarryBase extends CarrySide {
  /** Revision des Rasters (mosaicRev) */
  rev: string | undefined;
}

/** Ergebnis der Übernahme für ein neues Raster: Fortschritt, Felder für den Projektstand, Bericht. */
export interface CarryOutcome {
  progress: Uint16Array;
  fields: Pick<ComputeFields, 'progressSummary' | 'carryOver'>;
  report: CarryOverReport | null;
}

/**
 * Fortschritt des alten Stands `base` für das neue Ergebnis `job` (reine Funktion): nur nachweislich gleiche Steine
 * bleiben verlegt. `palette`: die Palette, die mit dem neuen Raster gespeichert wird. Dazu die exakten Zahlen für
 * Projektlisten (progressSummary) und – wenn vorher etwas verlegt war – der Bericht für den Hinweis (carryOver).
 * Kann der Vergleich nicht durchgeführt werden, bleibt nichts verlegt (nie geraten).
 */
export function carryFor(base: CarryBase | null, job: Pick<PendingCommit, 'lp' | 'data' | 'fields'>, palette: readonly PaletteColor[], now = Date.now()): CarryOutcome {
  let res: { progress: Uint16Array; report: CarryOverReport | null };
  try {
    res = carryOverProgress(base, { lp: job.lp, data: job.data, palette });
  } catch (e) {
    console.warn('Fortschritt konnte nicht verglichen werden – nichts übernommen', e);
    res = { progress: new Uint16Array(job.data.cols * job.data.rows), report: null };
  }
  const counts = countProgress({ ...job.data, progress: res.progress });
  const rev = job.fields.mosaicRev;
  return {
    progress: res.progress,
    report: res.report,
    fields: {
      progressSummary: { placed: counts.placed, total: counts.total, rev },
      ...(res.report ? { carryOver: { ...res.report, rev, at: now } } : {}),
    },
  };
}

/** Gespeicherter Stand als Grundlage der Übernahme (nur, wenn Raster und Projekt nachweislich zusammengehören). */
export function carryBaseFromStored(st: { rec: ProjectRecord; mosaic?: StoredMosaicNoProgress; progress?: Uint16Array }): CarryBase | null {
  const res = restoreComputed(st.rec, st.mosaic, st.progress);
  if (!res.computed) return null;
  return { rev: st.rec.mosaicRev, lp: res.computed.layoutParams, data: res.computed.data, palette: st.rec.palette };
}

/** Ergebnis mit übernommenem Fortschritt (neues Fortschritts-Array; Raster und Palette unverändert). */
function withCarry(job: PendingCommit, c: CarryOutcome): PendingCommit {
  return { ...job, fields: { ...job.fields, ...c.fields }, data: { ...job.data, progress: c.progress }, pk: { ...job.pk, progress: c.progress } };
}

/**
 * Schreibt ein Ergebnis fest (Projekt, Raster, Fortschritt in EINER Transaktion, siehe commitComputed) – auch
 * wenn keine Ansicht des Projekts mehr offen ist – und übergibt es der angemeldeten Ansicht.
 * Der Verlegefortschritt des ersetzten Rasters bleibt, wo es nachweislich derselbe Stein ist (carryFor): verglichen
 * wird mit dem angezeigten Stand (neueste Markierungen), sonst – oder wenn inzwischen anderswo neu berechnet wurde –
 * mit dem gespeicherten, in derselben Transaktion gelesenen Stand.
 * Wirft bei geänderter eigener Palette (PALETTE_CHANGED).
 */
async function persistCommit(id: string, job: PendingCommit, fallbackSource: string): Promise<JobOutcome> {
  const h0 = projectHandler<ProjectHandler>(id);
  const view = h0?.carryBase?.() ?? null;
  // Ergebnis der Übernahme aus der Transaktion (bei einer Wiederholung der Transaktion gilt das letzte)
  const box: { carried: CarryOutcome | null } = { carried: null };
  const carry: CommitCarry = {
    baseRev: view ? view.rev : null,
    run: (palette, stored) => {
      const c = carryFor(stored ? carryBaseFromStored(stored) : view, job, palette);
      box.carried = c;
      return { progress: c.progress, fields: c.fields };
    },
  };
  let committed: ProjectRecord | null = null;
  let saveFailure: unknown = null;
  try {
    committed = await commitComputed(id, job.fields, job.pk.mosaic, job.pk.progress, h0?.instance ?? fallbackSource, carry);
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
  // Nicht gespeichert (z. B. Speicher voll): im Arbeitsspeicher mit dem angezeigten Stand vergleichen; das Ergebnis
  // wird später vollständig nachgespeichert
  // Ebenso, wenn die Transaktion abbrach, nachdem sie verglichen hatte (dann wurde nichts geschrieben)
  if (!box.carried || saveFailure) {
    const latest = h0?.latestPalette() ?? job.fields.palette;
    box.carried = carryFor(view, job, resolveComputedPalette(latest, job.fields)?.palette ?? job.fields.palette);
  }
  const done = withCarry(job, box.carried);
  // Eine gerade (wieder) geöffnete Ansicht übernimmt das Ergebnis erst nach ihrem Laden
  const h = await settledHandler(id);
  if (h) {
    h.applyCommitted(done, committed, saveFailure);
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
  // Eine gerade (wieder) geöffnete Ansicht erst fertig laden lassen: Palette, Fugenfarbe und Arbeit am Mosaik sind
  // erst dann bekannt
  const job = await prepareCommit(out, (await settledHandler(id))?.groutHex() ?? out.snapshot.settings.groutHex, origin);
  const h = await settledHandler(id);
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
  /**
   * Foto nach Bildoptimierung, mit dem das Raster `rev` berechnet wurde (Vergleich Foto/Mosaik). Angezeigt wird es nur,
   * solange genau dieses Raster gilt – nach dem Übernehmen eines anderswo berechneten Mosaiks nicht mehr.
   */
  const [processedState, setProcessed] = useState<{ canvas: HTMLCanvasElement; rev: string | undefined } | null>(null);
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
  /** Stand geladen (siehe Laden) – erst danach übernimmt die Ansicht Ergebnisse und anderswo gespeicherte Mosaike */
  const loadedRef = useRef(false);
  /** Erfüllt, sobald geladen oder geschlossen (ProjectHandler.ready) */
  const readyRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!readyRef.current) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    readyRef.current = { promise, resolve };
  }
  /**
   * Generation des Stands im Arbeitsspeicher: Jedes Übernehmen eines zusammengehörigen Stands (Ergebnis einer
   * Berechnung, anderswo gespeichertes Mosaik) erhöht sie. Ein Lesevorgang, der vorher begonnen hat, setzt seinen
   * Stand dann nicht mehr (er würde Projekt und Raster verschiedener Stände mischen), sondern liest neu.
   */
  const snapGenRef = useRef(0);
  /** Ergebnis, das vor dem Ende des Ladens ankam – wird danach übernommen */
  const deferredCommit = useRef<{ job: PendingCommit; committed: ProjectRecord | null; saveFailure: unknown } | null>(null);

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

  // ---------- Verlegefortschritt als Zähler (Paket w4-progress-engine, siehe core/progressIndex.ts)
  // Ein Antippen ändert ein Bit: Die Zähler werden nur für die geänderten Zellen nachgeführt statt das ganze Raster
  // (und jeden Abschnitt einzeln) neu zu zählen. Neu aufgebaut wird bei anderem Raster, anderen Abschnitten und
  // Änderungen an Steinen ohne Zellenliste.
  const pidxRef = useRef<{ index: ProgressIndex; data: MosaicData; layout: Layout; secKey: string; gen: number } | null>(null);
  /** Erhöht bei Änderungen am Raster ohne Zellenliste – die Zähler werden beim nächsten Zugriff neu aufgebaut */
  const structGenRef = useRef(0);
  /** Zähler, falls sie zum angezeigten Raster und den Abschnitten passen (sonst null). */
  const liveIndex = useCallback((): ProgressIndex | null => {
    const c = computedRef.current;
    const r = recRef.current;
    const cur = pidxRef.current;
    if (!c || !r || !cur) return null;
    return cur.data === c.data && cur.layout === c.layout && cur.secKey === sectionKeyOf(r.settings) && cur.gen === structGenRef.current ? cur.index : null;
  }, []);
  /** Zähler des angezeigten Rasters – bei Bedarf in einem Durchgang neu aufgebaut. */
  const syncIndex = useCallback((): ProgressIndex | null => {
    const c = computedRef.current;
    const r = recRef.current;
    if (!c || !r) {
      pidxRef.current = null;
      return null;
    }
    const live = liveIndex();
    if (live) return live;
    const index = buildProgressIndex(c.layout, c.data, sectionsFor(c.layout, r.settings));
    pidxRef.current = { index, data: c.data, layout: c.layout, secKey: sectionKeyOf(r.settings), gen: structGenRef.current };
    return index;
  }, [liveIndex]);

  /**
   * Schreibt den Verlegefortschritt für Projektlisten (meta.progressSummary) in den Projektstand, wenn er sich
   * geändert hat; gespeichert wird er zusammen mit dem Fortschritt (eine Transaktion). `bump`: als Bearbeitung zählen
   * (Änderungszeitpunkt), nicht beim bloßen Nachtragen nach dem Laden.
   */
  const syncSummary = useCallback(
    (bump: boolean) => {
      const r = recRef.current;
      if (!r || !computedRef.current) return;
      const index = syncIndex();
      if (!index) return;
      const next: ProgressSummary = { placed: index.placedAll, total: index.totalAll, ...(r.mosaicRev !== undefined ? { rev: r.mosaicRev } : {}) };
      const cur = r.meta.progressSummary;
      if (cur && cur.placed === next.placed && cur.total === next.total && (cur.rev ?? null) === (next.rev ?? null)) return;
      setRecBoth({ ...r, meta: { ...r.meta, progressSummary: next, ...(bump ? { updatedAt: Date.now() } : {}) } });
      markDirty('rec');
    },
    [syncIndex, setRecBoth, markDirty],
  );

  // ---------- Statistik-Aufträge (höchstens einer läuft; siehe unten)
  const statsCtl = useRef({ running: false, again: false, scheduled: false, req: 0 });

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
      // Statistik gehört zu dieser Ansicht: ein laufender Auftrag ist überflüssig
      if (statsCtl.current.running) cancelChannel('stats');
      // Ein Auftrag, der auf das Laden dieser Ansicht wartet, darf nicht hängen bleiben
      readyRef.current?.resolve();
    };
  }, []);

  // ---------- Laden
  useEffect(() => {
    let alive = true;
    const finish = () => {
      loadedRef.current = true;
      setLoaded(true);
      readyRef.current?.resolve();
      // Ein Ergebnis, das während des Ladens ankam, jetzt (auf dem geladenen Stand) übernehmen
      const d = deferredCommit.current;
      deferredCommit.current = null;
      if (d && recRef.current) handlerImpl.current.applyCommitted(d.job, d.committed, d.saveFailure);
    };
    (async () => {
      // Generation beim Lesen: Wird währenddessen anderswo ein neues Mosaik gespeichert (siehe adopt), wird
      // Projekt + Raster + Fortschritt gemeinsam neu gelesen – nie Projekt des einen und Raster des anderen Stands.
      let gen = snapGenRef.current;
      let st;
      try {
        st = await loadProjectState(id);
      } catch (e) {
        console.warn('Projekt konnte nicht geladen werden', e);
        if (alive) finish();
        return;
      }
      if (!alive) return;
      if (!st.rec) {
        finish();
        return;
      }
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
      for (let i = 0; i < 5 && snapGenRef.current !== gen; i++) {
        gen = snapGenRef.current;
        try {
          const again = await loadProjectState(id, { image: false });
          if (!alive) return;
          st = { ...again, image: st.image };
        } catch (e) {
          console.warn('Projekt konnte nicht neu gelesen werden', e);
          break;
        }
      }
      const r = st.rec;
      if (!r) {
        // inzwischen gelöscht
        sv.current.deleted = true;
        setError({ code: 'deleted', message: DELETED });
        finish();
        return;
      }
      // Projekt und Raster aus EINEM gelesenen Stand – zusammen gesetzt
      setRecBoth(r);
      paletteBaseRef.current = r.palette;
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
      // Ältere Projekte (oder ein veralteter Wert): Fortschritt für „Meine Projekte“ nachtragen – ohne als Bearbeitung zu zählen
      if (res.computed) syncSummary(false);
      finish();
    })();
    return () => {
      alive = false;
    };
  }, [id, setRecBoth, setComputedBoth, markDirty, setError, syncSummary]);

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
    // Noch beim Laden: Der Ladevorgang liest Projekt + Raster + Fortschritt dann gemeinsam neu
    if (!loadedRef.current) {
      snapGenRef.current++;
      return;
    }
    const gen = snapGenRef.current;
    let st;
    try {
      st = await loadProjectState(id, { image: false });
    } catch (e) {
      console.warn(e);
      return;
    }
    if (!mounted.current) return;
    // Während des Lesens wurde ein anderer Stand übernommen (z. B. eigenes Ergebnis): neu lesen statt ihn mit dem
    // vorher gelesenen (evtl. älteren) Stand zu überschreiben
    if (snapGenRef.current !== gen) {
      void adoptRef.current();
      return;
    }
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
    snapGenRef.current++;
    setRecBoth(recClean ? st.rec : keepStoredComputeFields(cur, st.rec, { paletteEdited: cur.palette !== paletteBaseRef.current }));
    paletteBaseRef.current = st.rec.palette;
    discardGrid();
    const res = restoreComputed(st.rec, st.mosaic, st.progress);
    setComputedBoth(res.computed);
    if (res.computed) syncSummary(false);
    setIntegrityError(res.mismatch ? 'mismatch' : null);
    setRejected(res.mismatch && st.mosaic ? { reason: res.mismatch, cells: st.mosaic.cols * st.mosaic.rows, placed: placedInStored(st.mosaic, st.progress) } : null);
    setComputeError((prev) => (res.mismatch ? 'integrity' : prev === 'integrity' ? null : prev));
    setVersion((v) => v + 1);
    setProgressVersion((v) => v + 1);
    s.staleKnown = false;
  }, [id, discardGrid, setError, setRecBoth, setComputedBoth, syncSummary]);
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
   * `dirtyCells`: geänderte Zellen (Zellindizes). Mit Liste werden die Fortschrittszähler nur für diese Zellen
   * nachgeführt (auch eine geänderte Teilezahl), ohne Liste beim nächsten Zugriff neu aufgebaut.
   */
  const touchMosaic = useCallback(
    (dirtyCells?: Iterable<number>) => {
      const cells = cellList(dirtyCells);
      const index = liveIndex();
      const c = computedRef.current;
      if (cells && index && c) applyDirty(index, c.data, cells);
      else structGenRef.current++;
      noteEdit(id);
      setVersion((v) => v + 1);
      markDirty('mosaic');
      update((r) => ({ ...r, meta: { ...r.meta, manualEdits: (r.meta.manualEdits ?? 0) + 1 } }));
      // Teilezahl (Form geändert) und damit die Zahlen für „Meine Projekte“ können sich geändert haben
      syncSummary(false);
    },
    [id, markDirty, update, liveIndex, syncSummary],
  );

  /**
   * Nach Änderungen am Verlegefortschritt aufrufen (die Bits sind bereits gesetzt). `dirtyCells`: geänderte Zellen –
   * dann werden nur deren Zähler nachgeführt (Mikrosekunden statt eines Durchgangs über das ganze Raster); ohne Liste
   * werden alle Masken mit den gemerkten verglichen. Löst KEINE Neuberechnung der Statistik aus.
   */
  const touchProgress = useCallback(
    (dirtyCells?: Iterable<number>) => {
      const cells = cellList(dirtyCells);
      const index = liveIndex();
      const c = computedRef.current;
      if (index && c) {
        if (cells) applyDirty(index, c.data, cells);
        else applyDiff(index, c.data);
      }
      noteEdit(id);
      setProgressVersion((v) => v + 1);
      markDirty('progress');
      syncSummary(true);
    },
    [id, markDirty, liveIndex, syncSummary],
  );

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
  // Raster nur bei geänderten Rastermaßen neu bestimmen (nicht bei jeder Projektänderung, z. B. beim Umbenennen –
  // sonst zeichneten alle davon abhängigen Ansichten bei jedem Tastendruck neu)
  const lpKey = rec ? JSON.stringify(layoutParamsOf(rec.settings)) : null;
  const layoutInfo = useMemo(() => {
    if (lpKey === null) return { layout: null as Layout | null, error: null as string | null };
    try {
      return { layout: computeLayout(JSON.parse(lpKey) as LayoutParams), error: null };
    } catch (e) {
      return { layout: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [lpKey]);

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

  /**
   * Gespeicherte Freiformzellen mit ungültigen (z. B. überlappenden) Teilen – aus älteren oder importierten Projekten.
   * Sie werden nicht umgewandelt (das zerstörte die eigene Arbeit), sondern im Projektkopf gemeldet; Flächen und
   * Fugenmasse sind dann nicht berechenbar, der PDF-Plan ist gesperrt (siehe jointAreaValid).
   */
  const invalidFree = useMemo(() => {
    if (!computed) return [] as { id: string; row: number; col: number }[];
    return invalidFreeCells(computed.layout, computed.data).map((c) => ({ id: cellId(computed.layout, c.row, c.col), row: c.row, col: c.col }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed, version]);
  /** Stein, der in der Vorschau (Schritt 8) geöffnet werden soll (z. B. aus dem Hinweis zu ungültigen Freiformsteinen) */
  const [stoneRequest, setStoneRequest] = useState<{ row: number; col: number; n: number } | null>(null);
  const requestStone = useCallback((row: number, col: number) => setStoneRequest((p) => ({ row, col, n: (p?.n ?? 0) + 1 })), []);
  /**
   * Erledigte Anforderung vergessen (beim Verlassen von Schritt 8, wenn die Vorschau nicht angezeigt wird) – sonst
   * öffnete Schritt 8 den Stein bei jedem erneuten Öffnen wieder (z. B. nach dem nächsten Berechnen).
   */
  const clearStoneRequest = useCallback(() => setStoneRequest((p) => (p ? null : p)), []);

  /**
   * Verlegefortschritt gesamt und je Abschnitt – aus den Zählern (siehe syncIndex/touchProgress), ohne das Raster neu
   * zu zählen. Exakt dieselben Zahlen wie progressOf (tests/w4-progress-engine.test.ts).
   */
  const progress = useMemo(() => {
    if (!computed || !sections) return null;
    const index = syncIndex();
    return index ? progressFromIndex(index) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed, sections, version, progressVersion, syncIndex]);

  /**
   * Übernahme des Verlegefortschritts bei der letzten Berechnung (gleiches Raster: nachweislich gleiche Steine bleiben
   * verlegt; sonst nicht übertragbar) – nur, solange sie zum angezeigten Raster gehört und der Hinweis nicht
   * geschlossen wurde.
   */
  const lastCarryOver: CarryOverInfo | null = rec?.lastCarryOver && computed && rec.lastCarryOver.rev === rec.mosaicRev ? rec.lastCarryOver : null;
  const dismissCarryOver = useCallback(
    () =>
      update((r) => {
        if (!r.lastCarryOver) return r;
        const next = { ...r };
        delete next.lastCarryOver;
        return next;
      }),
    [update],
  );

  /** Effektiver Zuschnitt (normiert) passend zum Seitenverhältnis der fertigen Mosaikfläche. */
  // Maße des Originals (nicht der evtl. verkleinerten Arbeitskopie): Zuschnitt und Arbeitsauflösung wie bei voller Dekodierung
  const srcW = sourceSize?.w ?? bitmap?.width ?? 0;
  const srcH = sourceSize?.h ?? bitmap?.height ?? 0;
  // Nur von Fotobearbeitung, Foto und Seitenverhältnis abhängig (gleiche Identität bei anderen Änderungen)
  const adjustNow = rec?.adjust;
  const aspectNow = layoutInfo.layout ? layoutInfo.layout.finishedW / layoutInfo.layout.finishedH : 0;
  const effectiveCrop = useMemo(() => {
    if (!adjustNow || !bitmap || !aspectNow || !srcW || !srcH) return null;
    const { w, h } = rotatedSize(srcW, srcH, adjustNow);
    return fitCrop(adjustNow.crop, w, h, aspectNow);
  }, [adjustNow, bitmap, srcW, srcH, aspectNow]);

  // ---------- Statistik (im Worker)
  // Höchstens EIN Statistik-Auftrag läuft. Ändern sich die Eingaben, während einer läuft, ist er veraltet: Er wird
  // abgebrochen (cancelChannel('stats')) und danach läuft genau einer mit den neuesten Eingaben. So stauen sich keine
  // Aufträge im Worker, und eine echte Änderung wartet nie hinter veralteten mehrsekündigen Läufen. Der
  // Verlegefortschritt löst keinen Auftrag aus (seine Zahlen kommen aus den Zählern, siehe progress).
  const materialsRef = useRef(materials);
  materialsRef.current = materials;
  const startStatsRef = useRef<() => void>(() => {});
  const startStats = useCallback(() => {
    const ctl = statsCtl.current;
    if (!mounted.current) return;
    if (ctl.running) {
      // laufender Auftrag ist veraltet: abbrechen, danach läuft genau einer mit den neuesten Eingaben
      ctl.again = true;
      cancelChannel('stats');
      return;
    }
    const c = computedRef.current;
    const r = recRef.current;
    if (!c || !r) {
      setStatsBusy(false);
      return;
    }
    ctl.running = true;
    ctl.again = false;
    const my = ctl.req;
    setStatsBusy(true);
    let req: Parameters<typeof runWorker<'stats'>>[1];
    try {
      const secs = sectionsFor(c.layout, r.settings);
      req = {
        type: 'stats',
        layoutParams: c.layoutParams,
        mosaic: packMosaic(c.data),
        palette: r.palette,
        materials: materialsRef.current,
        reservePct: r.settings.reservePct,
        groutDepthMm: r.settings.groutDepthMm,
        ranges: secs.sections.map((x) => ({ key: x.id, range: { r0: x.r0, r1: x.r1, c0: x.c0, c1: x.c1 } })),
      };
    } catch (e) {
      console.error(e);
      ctl.running = false;
      setStatsBusy(false);
      return;
    }
    runWorker<'stats'>('stats', req)
      .then(
        (res) => {
          // Nur das Ergebnis der neuesten Anforderung zeigen (sonst stünden veraltete Zahlen da)
          if (!mounted.current || my !== ctl.req || ctl.scheduled) return;
          setStats(res.total);
          setSectionStats(new Map(res.ranges.map((x) => [x.key, x.stats])));
        },
        (e: unknown) => {
          // abgebrochen (veraltet): kein Fehler
          if (!(e instanceof Error && e.message === 'abgebrochen')) console.error(e);
        },
      )
      .finally(() => {
        ctl.running = false;
        if (!mounted.current) return;
        if (ctl.again || (my !== ctl.req && !ctl.scheduled)) {
          ctl.again = false;
          startStatsRef.current();
        } else if (!ctl.scheduled) setStatsBusy(false);
      });
  }, []);
  startStatsRef.current = startStats;

  const lastStatsVersion = useRef(-1);
  useEffect(() => {
    const ctl = statsCtl.current;
    if (!computed || !rec) {
      // nichts berechnet: ein laufender Auftrag ist überflüssig
      ctl.req++;
      ctl.scheduled = false;
      if (ctl.running) cancelChannel('stats');
      setStats(null);
      setStatsBusy(false);
      return;
    }
    // Eingaben geändert: bis zum (entprellten) neuen Auftrag gelten die angezeigten Zahlen als „wird aktualisiert“
    ctl.scheduled = true;
    setStatsBusy(true);
    const timer = window.setTimeout(
      () => {
        ctl.scheduled = false;
        ctl.req++;
        startStatsRef.current();
      },
      lastStatsVersion.current === version ? 1500 : 250,
    );
    lastStatsVersion.current = version;
    return () => window.clearTimeout(timer);
    // progressVersion bewusst NICHT: Antippen im Verlegemodus startet keinen Statistik-Durchlauf
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed, version, rec?.palette, materials, rec?.settings.reservePct, rec?.settings.groutDepthMm, rec?.settings.sectionMode, rec?.settings.sectionWmm, rec?.settings.sectionHmm, rec?.settings.sectionCols, rec?.settings.sectionRows]);

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
    if (!computedRef.current) return false;
    return (syncIndex()?.placedAll ?? 0) > 0 || (recRef.current?.meta.manualEdits ?? 0) > 0;
  }, [syncIndex]);

  /**
   * Übernimmt ein gespeichertes Ergebnis in diese Ansicht (wird vom Auftrag aufgerufen – auch, wenn er in einer
   * früheren Ansicht dieses Projekts gestartet wurde).
   */
  const applyCommitted = useCallback(
    (job: PendingCommit, committed: ProjectRecord | null, saveFailure: unknown) => {
      if (!mounted.current) return;
      if (!loadedRef.current) {
        // Noch beim Laden (sollte dank ProjectHandler.ready nicht vorkommen): nach dem Laden übernehmen
        deferredCommit.current = { job, committed, saveFailure };
        snapGenRef.current++;
        return;
      }
      const { fields, data, proc, layout, lp } = job;
      snapGenRef.current++;
      // Vergleichsfoto gehört genau zu diesem Raster
      setProcessed({ canvas: proc, rev: fields.mosaicRev });
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
      // Eine übernommene Vorschau teilt ihr Raster jetzt mit dem gespeicherten Mosaik: nicht weiter als Vorschau führen.
      // Nach „Berechnen“ gehört eine ältere Vorschau zu anderen Einstellungen: nicht vor dem neueren gespeicherten
      // Mosaik zeigen und ihren Speicher (Raster, Arbeitsbild) freigeben.
      setPreview((p) => (p.result ? { ...p, result: null } : p));
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
      ready: () => readyRef.current!.promise,
      latestPalette: () => recRef.current?.palette ?? null,
      groutHex: () => recRef.current?.settings.groutHex ?? null,
      workAtRisk: () => handlerImpl.current.displayedWorkAtRisk(),
      carryBase: () => {
        const c = computedRef.current;
        const r = recRef.current;
        if (!c || !r || !loadedRef.current) return null;
        return { rev: r.mosaicRev, lp: c.layoutParams, data: c.data, palette: r.palette };
      },
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
  // Ohne angezeigte Vorschau (Schritte 1 und 8–10, ausgeblendet) braucht niemand das zwischengespeicherte Arbeitsbild
  useEffect(() => {
    if (previewWatchers <= 0) rawCache.current = null;
  }, [previewWatchers]);

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
  /**
   * Materialien seit der Berechnung geändert (Farbton, Name, Bestand bei begrenzter Farbanzahl, hinzugefügt/gelöscht):
   * Neu berechnen ergäbe andere Farben, obwohl computeKey gleich ist. Ältere Projekte ohne gespeicherten Fingerabdruck:
   * unbekannt – nicht gemeldet.
   */
  const materialSigNow = useMemo(() => (rec ? materialSigFor(rec, materials) : undefined), [rec?.settings.paletteMode, rec?.settings.materialIds, materials]); // eslint-disable-line react-hooks/exhaustive-deps
  const materialsChanged = !!rec && !!computed && !stale && rec.computedMaterialSig !== undefined && materialSigNow !== undefined && rec.computedMaterialSig !== materialSigNow;
  const committedCurrent = !!computed && !stale && !materialsChanged;
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
    /** Statistik wird gerade (neu) berechnet – angezeigte Zahlen sind bis dahin die der letzten Berechnung */
    statsBusy,
    /** Übernahme des Verlegefortschritts bei der letzten Berechnung (null: nichts zu melden) */
    lastCarryOver,
    dismissCarryOver,
    /** Fortschritt der Berechnung dieses Projekts (auch einer vor dem erneuten Öffnen gestarteten) */
    computing,
    /** laufende Berechnung eines anderen Projekts (app-weit nur eine) – „Berechnung für „X“ läuft noch“ */
    otherJob,
    cancelOtherJob,
    /** Zeitpunkt, zu dem diese Ansicht zuletzt ein Ergebnis übernommen hat (0 = noch keins) */
    committedAt,
    computeError,
    stale,
    /** Materialien seit der Berechnung geändert (Einstellungen gleich) – Neu berechnen ergäbe andere Farben */
    materialsChanged,
    /** Live-Vorschau der aktuellen Einstellungen (nie gespeichert) */
    preview: previewInfo,
    /** „Übernehmen“ speichert die fertige Vorschau ohne zweite Berechnung */
    previewCommittable,
    watchPreview,
    refreshPreview,
    effectiveCrop,
    /** Foto nach Bildoptimierung des angezeigten Rasters (null: nicht vorhanden oder gehört zu einem anderen Raster) */
    processed: processedState && rec && processedState.rev === rec.mosaicRev ? processedState.canvas : null,
    /** Speicherstatus für die Anzeige („Gespeichert ✓ / Speichert … / Nicht gespeichert“) */
    saveState,
    saveError,
    /** 'mismatch': gespeichertes Raster gehört nicht zur Palette – nicht angezeigt, neu berechnen */
    integrityError,
    /** Angaben zum nicht angezeigten gespeicherten Raster (z. B. verlegte Steine, die beim Neuberechnen verloren gehen) */
    rejected,
    /** beim Laden reparierte Zellen mit leeren Teilen (0 = keine) */
    repairedCells,
    /** gespeicherte Freiformzellen mit ungültigen Teilen (Bezeichnung, Zeile, Spalte) */
    invalidFree,
    /** Stein, der in Schritt 8 geöffnet werden soll (Zähler n: jede Anforderung zählt) */
    stoneRequest,
    requestStone,
    clearStoneRequest,
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
