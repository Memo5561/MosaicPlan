/**
 * Verlauf für Rückgängig/Wiederholen (Paket w5-undo-editing): Steinfarbe, Steinform, Freiform, Verlegestatus und
 * Palette. Reiner TypeScript-Kern ohne DOM – getestet in tests/w5-undo-editing.test.ts.
 *
 * Grundregeln
 *  - Jeder Eintrag kennt den Zustand VORHER und NACHHER. Rückgängig wird nur angewendet, wenn der aktuelle Zustand
 *    genau dem NACHHER entspricht (Wiederholen: dem VORHER). Sonst wurde inzwischen etwas anderes geändert – der
 *    Eintrag wird verworfen und nie ein alter Stand über eine neuere Änderung geschrieben.
 *  - Ein Eintrag gilt nur für die Palette, deren Farbreihenfolge (Farbnummern) er kennt (`sigBefore`/`sigAfter`):
 *    Farbindizes im Raster bedeuten nach einem Entfernen/Umsortieren etwas anderes.
 *  - Höchstens 200 Einträge bzw. 32 MB; die ältesten fallen heraus. Ein einzelner Eintrag über der Grenze wird
 *    nicht gespeichert (der Verlauf wird dann geleert – nie halb).
 *  - Der Verlauf lebt nur im Arbeitsspeicher dieser Sitzung (useProject leert ihn bei jedem neuen Raster).
 *  - Zahlen (Stückzahlen, Flächen) werden nie aus dem Verlauf abgeleitet: nach dem Anwenden rechnet die Statistik
 *    wie nach jeder Bearbeitung neu.
 */
import type { DeltaEFormula } from './color';
import { freePiecesEqual, cloneFreePieces, nearestOtherColor, removePaletteColor } from './edits';
import type { MaterialMergePlan } from './paletteOps';
import type { Range } from './stats';
import type { FreePiece, MosaicData, PaletteColor } from './types';

export const JOURNAL_MAX_ENTRIES = 200;
export const JOURNAL_MAX_BYTES = 32 * 1024 * 1024;
/** Palettenänderungen derselben Art an derselben Farbe innerhalb dieser Zeit ergeben EINEN Eintrag (Farbwähler, Tippen) */
export const JOURNAL_COALESCE_MS = 1500;

/** Beschriftung eines Eintrags: i18n-Schlüssel mit Platzhaltern (Sprache erst beim Anzeigen) oder fertiger Text. */
export interface HistoryLabel {
  key?: string;
  params?: Record<string, string | number>;
  text?: string;
}

/** Stein, der nach dem Anwenden kurz hervorgehoben wird */
export interface HistoryFlash {
  idx: number;
  piece: number;
}

interface EntryBase {
  label: HistoryLabel;
  flash?: HistoryFlash;
  /** Farbreihenfolge der Palette vor/nach der Änderung (paletteIndexSig) */
  sigBefore: string;
  sigAfter: string;
  /** geschätzter Speicherbedarf in Byte (für die 32-MB-Grenze) */
  bytes: number;
  /** Zeitpunkt (ms) – für das Zusammenfassen von Palettenänderungen */
  at: number;
  /** gleiche Kennung kurz hintereinander → ein Eintrag (nur Palettenänderungen ohne Rasteränderung) */
  coalesce?: string;
}

// ---------------------------------------------------------------- Zellen (struct-of-arrays)

/** Zustand vieler Zellen als Spalten (Position k ↔ Zelle idx[k]); Zusatzlisten nur für Zellen, die sie haben. */
export interface CellSide {
  kind: Uint8Array;
  c1: Uint16Array;
  c2: Uint16Array;
  progress: Uint16Array;
  sub: Map<number, Uint16Array>;
  line: Map<number, Float32Array>;
  free: Map<number, FreePiece[]>;
}

export interface CellsEntry extends EntryBase {
  type: 'cells';
  idx: Uint32Array;
  before: CellSide;
  after: CellSide;
  /** Raster (Zellart, Farben, Formen) geändert → Statistik neu, manuelle Änderung */
  mosaicChanged: boolean;
  /** Verlegestatus geändert */
  progressChanged: boolean;
}

export interface ProgressEntry extends EntryBase {
  type: 'progress';
  /** einzelne Zellen ODER ein Bereich (zeilenweise, Breite = range.c1 − range.c0) */
  cells: Int32Array | null;
  range: Range | null;
  cols: number;
  before: Uint16Array;
  after: Uint16Array;
}

/**
 * Ein Entfernen einer Palettenfarbe als kompakte Umkehrung: nur die Stellen, die die entfernte Farbe hatten
 * (c1-, c2-Zellen, (Zelle, Teil) bei Unterteilung und Freiform). Rückgängig = alle Indizes ≥ `index` um 1 erhöhen,
 * dann `index` an den gemerkten Stellen wieder eintragen. Speicher wächst mit den Steinen dieser einen Farbe.
 */
export interface RemoveStep {
  /** entfernte Position (vor dem Entfernen) */
  index: number;
  /** Ersatzfarbe (Position vor dem Entfernen) */
  target: number;
  c1: Uint32Array;
  c2: Uint32Array;
  /** Paare (Zelle, Teil q) */
  sub: Uint32Array;
  /** Paare (Zelle, Teil k) */
  free: Uint32Array;
}

export interface PaletteEntry extends EntryBase {
  type: 'palette';
  prev: PaletteColor[];
  next: PaletteColor[];
  /** Entfernte Farben in Ausführungsreihenfolge (leer: nur die Palette geändert, Raster unverändert) */
  steps: RemoveStep[];
}

export type JournalEntry = CellsEntry | ProgressEntry | PaletteEntry;

/** Farbreihenfolge einer Palette (Farbnummern in Indexreihenfolge) – gleicher Wert ⇒ gleiche Bedeutung der Indizes. */
export function paletteIndexSig(palette: readonly PaletteColor[]): string {
  return `${palette.length}:${palette.map((p) => p.code).join(',')}`;
}

/**
 * Inhalt einer Palettenfarbe, wie er für Rückgängig zählt: Nummer, Farbe, Material, Feinstein-Material und – bei
 * Benutzer- und Materialnamen – der Name. Automatische Namen zählen nur über ihren Schlüssel (sie folgen der Sprache
 * und dürfen sich dabei ändern, ohne dass ein Eintrag ungültig wird). Das Feinstein-Material (fineMaterialId) zählt
 * mit: Zuordnen/Entfernen ist eine eigene, rückgängig machbare Änderung, und ein älterer Paletteneintrag passt danach
 * nicht mehr (statt beim Rückgängigmachen die Feinstein-Zuordnung aller Farben zu überschreiben).
 */
export function paletteEntryKey(p: PaletteColor): string {
  const name = p.userNamed || !p.nameKey ? `n:${p.name}` : `k:${p.nameKey}|${p.nameSuffix ?? ''}`;
  return JSON.stringify([p.code, p.hex.toUpperCase(), p.materialId ?? '', p.fineMaterialId ?? '', name]);
}

/** Gleiche Palette im Sinne von paletteEntryKey (Reihenfolge zählt)? */
export function samePaletteContent(a: readonly PaletteColor[], b: readonly PaletteColor[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && paletteEntryKey(a[i]) !== paletteEntryKey(b[i])) return false;
  return true;
}

function emptySide(n: number): CellSide {
  return { kind: new Uint8Array(n), c1: new Uint16Array(n), c2: new Uint16Array(n), progress: new Uint16Array(n), sub: new Map(), line: new Map(), free: new Map() };
}

/** Zellen eindeutig und aufsteigend */
export function uniqueCells(cells: Iterable<number>): Uint32Array {
  const arr = Uint32Array.from(new Set(cells));
  arr.sort();
  return arr;
}

/** Zustand der Zellen `idx` (tiefe Kopie). */
export function captureCellSide(data: MosaicData, idx: Uint32Array): CellSide {
  const s = emptySide(idx.length);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    s.kind[k] = data.kind[i];
    s.c1[k] = data.c1[i];
    s.c2[k] = data.c2[i];
    s.progress[k] = data.progress[i];
    const sub = data.sub.get(i);
    if (sub) s.sub.set(k, sub.slice());
    const line = data.line.get(i);
    if (line) s.line.set(k, line.slice());
    const free = data.free.get(i);
    if (free) s.free.set(k, cloneFreePieces(free));
  }
  return s;
}

function arrEq(a: ArrayLike<number> | undefined, b: ArrayLike<number> | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Entspricht Zelle `cell` genau Position k des Zustands? */
export function sideMatches(data: MosaicData, cell: number, s: CellSide, k: number): boolean {
  return (
    data.kind[cell] === s.kind[k] &&
    data.c1[cell] === s.c1[k] &&
    data.c2[cell] === s.c2[k] &&
    data.progress[cell] === s.progress[k] &&
    arrEq(data.sub.get(cell), s.sub.get(k)) &&
    arrEq(data.line.get(cell), s.line.get(k)) &&
    freePiecesEqual(data.free.get(cell), s.free.get(k))
  );
}

/** Schreibt Position k des Zustands in Zelle `cell` (Kopien – der Zustand bleibt unverändert). */
function writeSide(data: MosaicData, cell: number, s: CellSide, k: number): void {
  data.kind[cell] = s.kind[k];
  data.c1[cell] = s.c1[k];
  data.c2[cell] = s.c2[k];
  data.progress[cell] = s.progress[k];
  const sub = s.sub.get(k);
  if (sub) data.sub.set(cell, sub.slice());
  else data.sub.delete(cell);
  const line = s.line.get(k);
  if (line) data.line.set(cell, line.slice());
  else data.line.delete(cell);
  const free = s.free.get(k);
  if (free) data.free.set(cell, cloneFreePieces(free));
  else data.free.delete(cell);
}

function sameSideAt(a: CellSide, ka: number, b: CellSide, kb: number): { mosaic: boolean; progress: boolean } {
  const mosaic =
    a.kind[ka] === b.kind[kb] &&
    a.c1[ka] === b.c1[kb] &&
    a.c2[ka] === b.c2[kb] &&
    arrEq(a.sub.get(ka), b.sub.get(kb)) &&
    arrEq(a.line.get(ka), b.line.get(kb)) &&
    freePiecesEqual(a.free.get(ka), b.free.get(kb));
  return { mosaic, progress: a.progress[ka] === b.progress[kb] };
}

function pickSide(s: CellSide, ks: number[]): CellSide {
  const o = emptySide(ks.length);
  ks.forEach((k, j) => {
    o.kind[j] = s.kind[k];
    o.c1[j] = s.c1[k];
    o.c2[j] = s.c2[k];
    o.progress[j] = s.progress[k];
    const sub = s.sub.get(k);
    if (sub) o.sub.set(j, sub);
    const line = s.line.get(k);
    if (line) o.line.set(j, line);
    const free = s.free.get(k);
    if (free) o.free.set(j, free);
  });
  return o;
}

function sideBytes(s: CellSide): number {
  let b = s.kind.byteLength + s.c1.byteLength + s.c2.byteLength + s.progress.byteLength;
  for (const v of s.sub.values()) b += v.byteLength + 48;
  for (const v of s.line.values()) b += v.byteLength + 48;
  for (const v of s.free.values()) for (const f of v) b += 48 + f.poly.length * 32;
  return b;
}

export interface EntryMeta {
  label: HistoryLabel;
  flash?: HistoryFlash;
  /** Farbreihenfolge der Palette (paletteIndexSig) */
  sig: string;
  at?: number;
}

/**
 * Eintrag für Zellen, deren Zustand vorher (`idx`/`before`, siehe captureCellSide) gemerkt wurde – nachher ist der
 * aktuelle Zustand. Nur wirklich geänderte Zellen kommen in den Eintrag; null, wenn sich nichts geändert hat.
 */
export function cellsEntryFrom(data: MosaicData, idx: Uint32Array, before: CellSide, meta: EntryMeta): CellsEntry | null {
  const after = captureCellSide(data, idx);
  const ks: number[] = [];
  let mosaicChanged = false;
  let progressChanged = false;
  for (let k = 0; k < idx.length; k++) {
    const same = sameSideAt(before, k, after, k);
    if (same.mosaic && same.progress) continue;
    ks.push(k);
    if (!same.mosaic) mosaicChanged = true;
    if (!same.progress) progressChanged = true;
  }
  if (!ks.length) return null;
  const all = ks.length === idx.length;
  const e: CellsEntry = {
    type: 'cells',
    idx: all ? idx : Uint32Array.from(ks, (k) => idx[k]),
    before: all ? before : pickSide(before, ks),
    after: all ? after : pickSide(after, ks),
    mosaicChanged,
    progressChanged,
    label: meta.label,
    flash: meta.flash,
    sigBefore: meta.sig,
    sigAfter: meta.sig,
    bytes: 0,
    at: meta.at ?? Date.now(),
  };
  e.bytes = 128 + e.idx.byteLength + sideBytes(e.before) + sideBytes(e.after);
  return e;
}

// ---------------------------------------------------------------- Verlegestatus

/** Verlegestatus vorher (wie laying.ts ProgressSnapshot): einzelne Zellen oder ein Bereich */
export type ProgressBefore = { kind: 'cells'; cells: Int32Array; before: Uint16Array } | { kind: 'range'; range: Range; before: Uint16Array };

function progressPositions(e: Pick<ProgressEntry, 'cells' | 'range' | 'cols'>, fn: (cell: number, k: number) => void): void {
  if (e.cells) {
    for (let k = 0; k < e.cells.length; k++) fn(e.cells[k], k);
    return;
  }
  const rg = e.range!;
  const w = rg.c1 - rg.c0;
  for (let r = rg.r0; r < rg.r1; r++) for (let c = rg.c0; c < rg.c1; c++) fn(r * e.cols + c, (r - rg.r0) * w + (c - rg.c0));
}

/** Eintrag für eine Änderung des Verlegestatus (vorher gemerkt, nachher = aktuell); null, wenn sich nichts geändert hat. */
export function progressEntryFrom(data: MosaicData, cols: number, snap: ProgressBefore, meta: EntryMeta): ProgressEntry | null {
  if (snap.kind === 'cells') {
    const keep: number[] = [];
    for (let k = 0; k < snap.cells.length; k++) if (data.progress[snap.cells[k]] !== snap.before[k]) keep.push(k);
    if (!keep.length) return null;
    const cells = Int32Array.from(keep, (k) => snap.cells[k]);
    const before = Uint16Array.from(keep, (k) => snap.before[k]);
    const after = Uint16Array.from(cells, (c) => data.progress[c]);
    return { type: 'progress', cells, range: null, cols, before, after, label: meta.label, flash: meta.flash, sigBefore: meta.sig, sigAfter: meta.sig, bytes: 96 + cells.byteLength + before.byteLength + after.byteLength, at: meta.at ?? Date.now() };
  }
  const e: ProgressEntry = {
    type: 'progress',
    cells: null,
    range: { ...snap.range },
    cols,
    before: snap.before,
    after: new Uint16Array(snap.before.length),
    label: meta.label,
    flash: meta.flash,
    sigBefore: meta.sig,
    sigAfter: meta.sig,
    bytes: 0,
    at: meta.at ?? Date.now(),
  };
  let changed = false;
  progressPositions(e, (cell, k) => {
    e.after[k] = data.progress[cell];
    if (e.after[k] !== e.before[k]) changed = true;
  });
  if (!changed) return null;
  e.bytes = 96 + e.before.byteLength + e.after.byteLength;
  return e;
}

// ---------------------------------------------------------------- Palette

/** Merkt die Stellen, die Farbe `index` tragen (vor dem Entfernen). */
export function recordRemoveStep(data: MosaicData, index: number, target: number): RemoveStep {
  const c1: number[] = [];
  const c2: number[] = [];
  for (let i = 0; i < data.c1.length; i++) {
    if (data.c1[i] === index) c1.push(i);
    if (data.c2[i] === index) c2.push(i);
  }
  const sub: number[] = [];
  for (const [cell, arr] of data.sub) for (let q = 0; q < arr.length; q++) if (arr[q] === index) sub.push(cell, q);
  const free: number[] = [];
  for (const [cell, ps] of data.free) for (let k = 0; k < ps.length; k++) if (ps[k].color === index) free.push(cell, k);
  return { index, target, c1: Uint32Array.from(c1), c2: Uint32Array.from(c2), sub: Uint32Array.from(sub), free: Uint32Array.from(free) };
}

/**
 * Entfernt eine Palettenfarbe wie removePaletteColor (gleiche Ersatzfarbe: angegeben oder exakt nächste) und hängt
 * die Umkehrung an `steps` an.
 */
export function removeColorRecorded(palette: PaletteColor[], data: MosaicData, index: number, replacement: number | undefined, formula: DeltaEFormula, steps: RemoveStep[]): PaletteColor[] {
  if (palette.length <= 1) throw new Error('Die letzte Farbe kann nicht entfernt werden.');
  const target = replacement === undefined || replacement === index ? nearestOtherColor(palette, index, formula) : replacement;
  steps.push(recordRemoveStep(data, index, target));
  return removePaletteColor(palette, data, index, target, formula);
}

/** applyMaterialMerge (paletteOps.ts) mit gemerkter Umkehrung jedes Entfernens – gleiches Ergebnis. */
export function mergeRecorded(plan: MaterialMergePlan, data: MosaicData | null, formula: DeltaEFormula, steps: RemoveStep[]): PaletteColor[] {
  if (plan.noValidMaterials) throw new Error('Keine Materialfarbe mit gültigem HEX-Wert.');
  let cur = plan.staged;
  const alive = cur.map((_, i) => i);
  plan.removeIdx.forEach((r, n) => {
    const at = alive.indexOf(r);
    const to = alive.indexOf(plan.targetIdx[n]);
    cur = data ? removeColorRecorded(cur, data, at, to, formula, steps) : cur.filter((_, i) => i !== at);
    alive.splice(at, 1);
  });
  return cur;
}

/** Tragen genau die gemerkten Stellen den Wert `v`? */
function slotsHold(data: MosaicData, s: RemoveStep, v: number): boolean {
  for (const c of s.c1) if (data.c1[c] !== v) return false;
  for (const c of s.c2) if (data.c2[c] !== v) return false;
  for (let j = 0; j < s.sub.length; j += 2) {
    const arr = data.sub.get(s.sub[j]);
    if (!arr || s.sub[j + 1] >= arr.length || arr[s.sub[j + 1]] !== v) return false;
  }
  for (let j = 0; j < s.free.length; j += 2) {
    const ps = data.free.get(s.free[j]);
    if (!ps || s.free[j + 1] >= ps.length || ps[s.free[j + 1]].color !== v) return false;
  }
  return true;
}

function slotCount(s: RemoveStep): number {
  return s.c1.length + s.c2.length + s.sub.length / 2 + s.free.length / 2;
}

/** Anzahl aller Farbstellen mit Wert v (c1, c2, Unterteilung, Freiform) */
function countValue(data: MosaicData, v: number): number {
  let n = 0;
  for (let i = 0; i < data.c1.length; i++) {
    if (data.c1[i] === v) n++;
    if (data.c2[i] === v) n++;
  }
  for (const arr of data.sub.values()) for (let q = 0; q < arr.length; q++) if (arr[q] === v) n++;
  for (const ps of data.free.values()) for (const f of ps) if (f.color === v) n++;
  return n;
}

function remap(data: MosaicData, map: (c: number) => number): void {
  for (let i = 0; i < data.c1.length; i++) {
    data.c1[i] = map(data.c1[i]);
    data.c2[i] = map(data.c2[i]);
  }
  for (const v of data.sub.values()) for (let q = 0; q < v.length; q++) v[q] = map(v[q]);
  for (const v of data.free.values()) for (const f of v) f.color = map(f.color);
}

/** Zielposition der Ersatzfarbe NACH dem Entfernen */
const targetAfter = (s: RemoveStep) => (s.target > s.index ? s.target - 1 : s.target);

function undoStep(data: MosaicData, s: RemoveStep): void {
  const i = s.index;
  remap(data, (v) => (v >= i ? v + 1 : v));
  for (const c of s.c1) data.c1[c] = i;
  for (const c of s.c2) data.c2[c] = i;
  for (let j = 0; j < s.sub.length; j += 2) data.sub.get(s.sub[j])![s.sub[j + 1]] = i;
  for (let j = 0; j < s.free.length; j += 2) data.free.get(s.free[j])![s.free[j + 1]].color = i;
}

function redoStep(data: MosaicData, s: RemoveStep): void {
  const i = s.index;
  const t = s.target;
  remap(data, (c) => {
    const v = c === i ? t : c;
    return v > i ? v - 1 : v;
  });
}

/** Nimmt bereits ausgeführte Entfernen-Schritte exakt zurück (z. B. wenn eine Palettenaktion mittendrin scheitert). */
export function undoRemoveSteps(data: MosaicData, steps: readonly RemoveStep[]): void {
  for (let j = steps.length - 1; j >= 0; j--) undoStep(data, steps[j]);
}

/**
 * Art einer Palettenänderung ohne bekannte Rasteränderung (api.setPalette):
 *  - 'cosmetic': nur automatische Namen in anderer Sprache/Schreibweise – kein Verlaufseintrag
 *  - 'update': gleiche Farben an gleicher Stelle, Inhalt geändert (HEX, Name, Material, Feinstein-Material) – Indizes bleiben gültig
 *  - 'add': Farben nur hinten angehängt – Indizes bleiben gültig
 *  - 'reorder': Farben entfernt/umsortiert – Farbindizes im Raster bedeuten danach etwas anderes
 * `codes`: Farbnummern der geänderten (update) bzw. angehängten (add) bzw. entfernten (reorder) Farben.
 */
export function classifyPaletteChange(prev: readonly PaletteColor[], next: readonly PaletteColor[]): { kind: 'cosmetic' | 'update' | 'add' | 'reorder'; codes: number[] } {
  if (samePaletteContent(prev, next)) return { kind: 'cosmetic', codes: [] };
  if (paletteIndexSig(prev) === paletteIndexSig(next)) {
    const codes: number[] = [];
    for (let i = 0; i < next.length; i++) if (paletteEntryKey(prev[i]) !== paletteEntryKey(next[i])) codes.push(next[i].code);
    return { kind: 'update', codes };
  }
  // angehängt (die übrigen Farben behalten ihre Stelle; automatische Namen dürfen dabei einen Zusatz erhalten)
  if (next.length > prev.length && prev.every((p, i) => p.code === next[i].code)) return { kind: 'add', codes: next.slice(prev.length).map((p) => p.code) };
  const left = new Set(next.map((p) => p.code));
  return { kind: 'reorder', codes: prev.filter((p) => !left.has(p.code)).map((p) => p.code) };
}

function stepBytes(s: RemoveStep): number {
  return 64 + s.c1.byteLength + s.c2.byteLength + s.sub.byteLength + s.free.byteLength;
}

export function paletteEntryFrom(prev: PaletteColor[], next: PaletteColor[], steps: RemoveStep[], meta: Omit<EntryMeta, 'sig'> & { coalesce?: string }): PaletteEntry {
  return {
    type: 'palette',
    prev,
    next,
    steps,
    label: meta.label,
    flash: meta.flash,
    sigBefore: paletteIndexSig(prev),
    sigAfter: paletteIndexSig(next),
    coalesce: meta.coalesce,
    at: meta.at ?? Date.now(),
    bytes: 128 + (prev.length + next.length) * 256 + steps.reduce((a, s) => a + stepBytes(s), 0),
  };
}

// ---------------------------------------------------------------- Anwenden

export interface JournalTarget {
  /** angezeigtes Raster (null: noch nichts berechnet – dann gibt es nur Paletteneinträge ohne Rasteränderung) */
  data: MosaicData | null;
  palette: readonly PaletteColor[];
}

export type ApplyResult =
  | { status: 'empty' }
  /** inzwischen anders geändert – Eintrag verworfen, nichts angewendet */
  | { status: 'stale'; entry: JournalEntry }
  | {
      status: 'ok';
      entry: JournalEntry;
      /** neue Palette (nur Paletteneinträge) */
      palette?: PaletteColor[];
      /** geänderte Zellen (null: viele/unbekannt – Zähler neu aufbauen) */
      cells: number[] | null;
      mosaicChanged: boolean;
      progressChanged: boolean;
    };

/** Mehr geänderte Zellen werden nicht einzeln gemeldet */
const DIRTY_LIST_MAX = 500_000;

function applyEntry(t: JournalTarget, e: JournalEntry, dir: 'undo' | 'redo'): ApplyResult {
  const sigNow = paletteIndexSig(t.palette);
  if (sigNow !== (dir === 'undo' ? e.sigAfter : e.sigBefore)) return { status: 'stale', entry: e };
  if (e.type === 'cells') {
    const d = t.data;
    if (!d) return { status: 'stale', entry: e };
    const want = dir === 'undo' ? e.after : e.before;
    const put = dir === 'undo' ? e.before : e.after;
    for (let k = 0; k < e.idx.length; k++) if (e.idx[k] >= d.kind.length || !sideMatches(d, e.idx[k], want, k)) return { status: 'stale', entry: e };
    for (let k = 0; k < e.idx.length; k++) writeSide(d, e.idx[k], put, k);
    return { status: 'ok', entry: e, cells: e.idx.length > DIRTY_LIST_MAX ? null : Array.from(e.idx), mosaicChanged: e.mosaicChanged, progressChanged: e.progressChanged };
  }
  if (e.type === 'progress') {
    const d = t.data;
    if (!d) return { status: 'stale', entry: e };
    const want = dir === 'undo' ? e.after : e.before;
    const put = dir === 'undo' ? e.before : e.after;
    let ok = true;
    progressPositions(e, (cell, k) => {
      if (ok && (cell >= d.progress.length || d.progress[cell] !== want[k])) ok = false;
    });
    if (!ok) return { status: 'stale', entry: e };
    const cells: number[] = [];
    progressPositions(e, (cell, k) => {
      if (d.progress[cell] !== put[k]) {
        d.progress[cell] = put[k];
        cells.push(cell);
      }
    });
    return { status: 'ok', entry: e, cells: cells.length > DIRTY_LIST_MAX ? null : cells, mosaicChanged: false, progressChanged: true };
  }
  // Palette
  const wantPal = dir === 'undo' ? e.next : e.prev;
  if (!samePaletteContent(t.palette, wantPal)) return { status: 'stale', entry: e };
  const d = t.data;
  if (e.steps.length && !d) return { status: 'stale', entry: e };
  if (d && e.steps.length) {
    if (dir === 'undo') {
      // in umgekehrter Reihenfolge zurücknehmen; passt ein Schritt nicht, die bereits zurückgenommenen wiederholen
      const done: RemoveStep[] = [];
      for (let j = e.steps.length - 1; j >= 0; j--) {
        const s = e.steps[j];
        if (!slotsHold(d, s, targetAfter(s))) {
          for (let q = done.length - 1; q >= 0; q--) redoStep(d, done[q]);
          return { status: 'stale', entry: e };
        }
        undoStep(d, s);
        done.push(s);
      }
    } else {
      const done: RemoveStep[] = [];
      for (const s of e.steps) {
        if (!slotsHold(d, s, s.index) || countValue(d, s.index) !== slotCount(s)) {
          for (let q = done.length - 1; q >= 0; q--) undoStep(d, done[q]);
          return { status: 'stale', entry: e };
        }
        redoStep(d, s);
        done.push(s);
      }
    }
  }
  return { status: 'ok', entry: e, palette: dir === 'undo' ? e.prev : e.next, cells: null, mosaicChanged: e.steps.length > 0, progressChanged: false };
}

export type PushOutcome = 'pushed' | 'coalesced' | 'too-large' | 'noop';

/**
 * Stapel für Rückgängig und Wiederholen. Neue Einträge leeren „Wiederholen“. Grenzen: Anzahl und Byte; die ältesten
 * fallen heraus.
 */
export class EditJournal {
  private undoStack: JournalEntry[] = [];
  private redoStack: JournalEntry[] = [];
  private total = 0;

  constructor(
    readonly maxEntries = JOURNAL_MAX_ENTRIES,
    readonly maxBytes = JOURNAL_MAX_BYTES,
  ) {}

  get undoSize(): number {
    return this.undoStack.length;
  }
  get redoSize(): number {
    return this.redoStack.length;
  }
  /** Speicherbedarf aller Einträge (Byte, geschätzt) */
  get bytes(): number {
    return this.total;
  }
  peekUndo(): JournalEntry | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }
  peekRedo(): JournalEntry | undefined {
    return this.redoStack[this.redoStack.length - 1];
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.total = 0;
  }

  private trim(): void {
    while (this.undoStack.length + this.redoStack.length > this.maxEntries || (this.total > this.maxBytes && this.undoStack.length > 0)) {
      const old = this.undoStack.shift();
      if (!old) break;
      this.total -= old.bytes;
    }
  }

  /**
   * Neuer Eintrag. Paletteneinträge ohne Rasteränderung mit gleicher Kennung (`coalesce`) innerhalb von 1,5 s werden
   * zusammengefasst (z. B. Ziehen im Farbwähler, Tippen eines Namens); heben sie sich auf, verschwindet der Eintrag.
   * Ein Eintrag größer als die Byte-Grenze wird nicht gespeichert – dann wird der Verlauf geleert ('too-large'), weil
   * ältere Einträge ohne ihn nicht mehr sicher anwendbar wären.
   */
  push(entry: JournalEntry): PushOutcome {
    if (entry.bytes > this.maxBytes) {
      this.clear();
      return 'too-large';
    }
    const top = this.peekUndo();
    if (
      entry.type === 'palette' &&
      entry.coalesce &&
      !entry.steps.length &&
      top &&
      top.type === 'palette' &&
      !top.steps.length &&
      top.coalesce === entry.coalesce &&
      !this.redoStack.length &&
      entry.at - top.at <= JOURNAL_COALESCE_MS &&
      samePaletteContent(top.next, entry.prev)
    ) {
      this.undoStack.pop();
      this.total -= top.bytes;
      if (samePaletteContent(top.prev, entry.next)) return 'noop';
      const merged = paletteEntryFrom(top.prev, entry.next, [], { label: entry.label, coalesce: entry.coalesce, at: entry.at });
      this.undoStack.push(merged);
      this.total += merged.bytes;
      return 'coalesced';
    }
    for (const r of this.redoStack) this.total -= r.bytes;
    this.redoStack = [];
    this.undoStack.push(entry);
    this.total += entry.bytes;
    this.trim();
    return 'pushed';
  }

  /** Letzten Eintrag zurücknehmen – nur, wenn der aktuelle Zustand genau seinem NACHHER entspricht. */
  undo(t: JournalTarget): ApplyResult {
    const e = this.undoStack.pop();
    if (!e) return { status: 'empty' };
    this.total -= e.bytes;
    const r = applyEntry(t, e, 'undo');
    if (r.status === 'ok') {
      this.redoStack.push(e);
      this.total += e.bytes;
    }
    return r;
  }

  /** Zuletzt Zurückgenommenes wiederholen – nur, wenn der aktuelle Zustand genau seinem VORHER entspricht. */
  redo(t: JournalTarget): ApplyResult {
    const e = this.redoStack.pop();
    if (!e) return { status: 'empty' };
    this.total -= e.bytes;
    const r = applyEntry(t, e, 'redo');
    if (r.status === 'ok') {
      this.undoStack.push(e);
      this.total += e.bytes;
    }
    return r;
  }
}
