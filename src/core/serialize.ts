/**
 * Kompakte, strukturierte-Klon-fähige Darstellung der Mosaikdaten
 * (für IndexedDB und Worker-Transfers).
 */
import type { Pt } from './geometry';
import { CellKind, type FreePiece, type MosaicData, type PhotoTargets } from './types';

export interface StoredMosaic {
  v: 1;
  cols: number;
  rows: number;
  kind: Uint8Array;
  c1: Uint16Array;
  c2: Uint16Array;
  /** SUB: Zellindizes, Längen, Farben hintereinander */
  subIdx: Int32Array;
  subLen: Uint8Array;
  subCol: Uint16Array;
  lineIdx: Int32Array;
  lineVal: Float32Array;
  free: [number, { poly: [number, number][]; color: number }[]][];
  progress: Uint16Array;
  rec: Uint8Array;
  /**
   * Revision dieses Rasters. Sie wird bei jeder Berechnung neu vergeben und zusammen mit
   * `ProjectRecord.mosaicRev` in derselben Transaktion gespeichert: Raster und Palette gehören
   * nur zusammen, wenn beide Revisionen gleich sind. Fehlt bei Daten aus älteren Versionen.
   */
  rev?: string;
  /*
   * Fotofarben der Steine (MosaicData.targets, siehe PhotoTargets) – alle sechs Felder gemeinsam oder keines (Raster,
   * die vor dieser Funktion berechnet wurden). Bewusst nur Uint8Array auf oberster Ebene: Die Projektdatei
   * (src/storage/projects.ts) schreibt jedes Typed Array der obersten Ebene als Base64 und liest ihr unbekannte Felder
   * als Uint8Array zurück – so überstehen die Fotofarben Export und Import Byte für Byte, ohne Änderung am Dateiformat.
   */
  /** Zellart bei der Berechnung, 1 Byte je Zelle */
  tKind?: Uint8Array;
  /** Fotofarbe des ganzen Steins bzw. von Teil 1 je Zelle (3 Byte) */
  tLab1?: Uint8Array;
  /** Fotofarbe von Teil 2 je Zweiteiler (3 Byte, Zellreihenfolge) */
  tLab2?: Uint8Array;
  /** Schnittgerade je Zweiteiler bei der Berechnung: Bytes von Float32 [nx, ny, d] (12 Byte, Zellreihenfolge) */
  tLine?: Uint8Array;
  /** Teilsteine je k×k-Zelle (Zellreihenfolge) */
  tSubLen?: Uint8Array;
  /** Fotofarben der Teilsteine: Bytes von Float32 [L*, a*, b*] (12 Byte je Teilstein) */
  tSubLab?: Uint8Array;
}

/** Mosaikdaten, die (optional) wissen, zu welcher gespeicherten Revision sie gehören. */
export type MosaicDataWithRev = MosaicData & { rev?: string };

/** Felder der Fotofarben in der gespeicherten Form */
type StoredTargets = Required<Pick<StoredMosaic, 'tKind' | 'tLab1' | 'tLab2' | 'tLine' | 'tSubLen' | 'tSubLab'>>;

/** Dieselben Bytes, als Uint8Array angesehen (keine Kopie). */
const bytesOf = (a: Float32Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

function packTargets(t: PhotoTargets): StoredTargets {
  return { tKind: t.kind, tLab1: t.lab1, tLab2: t.lab2, tLine: bytesOf(t.line), tSubLen: t.subLen, tSubLab: bytesOf(t.subLab) };
}

const isU8 = (v: unknown): v is Uint8Array => v instanceof Uint8Array;

/** Float32-Werte aus ihren Bytes (ohne Kopie, wenn die Lage im Puffer es erlaubt; Länge muss durch 4 teilbar sein). */
function float32Of(b: Uint8Array): Float32Array {
  if (b.byteOffset % 4 === 0) return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  return new Float32Array(b.slice().buffer);
}

/**
 * Fotofarben aus der gespeicherten Form – nur, wenn sie vollständig und in sich stimmig sind (Längen passen zum Raster
 * und zueinander, jede Zellart ist eine der Berechnung). Sonst fehlen sie, als wäre das Raster älter: Die Fotofarben
 * sind Zusatzwissen, ein beschädigter Teil darf weder das Laden verhindern noch falsche Abweichungen liefern.
 */
export function unpackTargets(s: Partial<StoredMosaic>, cells: number): PhotoTargets | undefined {
  const { tKind, tLab1, tLab2, tLine, tSubLen, tSubLab } = s;
  if (!isU8(tKind) || !isU8(tLab1) || !isU8(tLab2) || !isU8(tLine) || !isU8(tSubLen) || !isU8(tSubLab)) return undefined;
  if (tKind.length !== cells || tLab1.length !== cells * 3) return undefined;
  let split = 0;
  let sub = 0;
  for (let i = 0; i < cells; i++) {
    const k = tKind[i];
    if (k === CellKind.DIAG_A || k === CellKind.DIAG_B || k === CellKind.LINE) split++;
    else if (k === CellKind.SUB) sub++;
    else if (k !== CellKind.FULL) return undefined;
  }
  if (tLab2.length !== split * 3 || tLine.length !== split * 12 || tSubLen.length !== sub) return undefined;
  let pieces = 0;
  for (let j = 0; j < sub; j++) {
    if (tSubLen[j] < 1) return undefined;
    pieces += tSubLen[j];
  }
  if (tSubLab.length !== pieces * 12) return undefined;
  return { kind: tKind, lab1: tLab1, lab2: tLab2, line: float32Of(tLine), subLen: tSubLen, subLab: float32Of(tSubLab) };
}

/**
 * Gespeicherte Form der Mosaikdaten. Die Fotofarben (`targets`) gehören dazu; mit `{ targets: false }` bleiben sie weg –
 * für Empfänger, die sie nicht brauchen (Statistik, PDF, CSV im Worker), spart das die Kopie von rund 4 Byte je Zelle.
 * Nie zum Speichern ohne Fotofarben packen: Sie lassen sich nur durch eine neue Berechnung wiederherstellen.
 */
export function packMosaic(d: MosaicDataWithRev, opts: { targets?: boolean } = {}): StoredMosaic {
  const subIdx = new Int32Array(d.sub.size);
  const subLen = new Uint8Array(d.sub.size);
  let total = 0;
  for (const v of d.sub.values()) total += v.length;
  const subCol = new Uint16Array(total);
  let i = 0;
  let o = 0;
  for (const [k, v] of d.sub) {
    subIdx[i] = k;
    subLen[i] = v.length;
    subCol.set(v, o);
    o += v.length;
    i++;
  }
  const lineIdx = new Int32Array(d.line.size);
  const lineVal = new Float32Array(d.line.size * 3);
  i = 0;
  for (const [k, v] of d.line) {
    lineIdx[i] = k;
    lineVal.set(v, i * 3);
    i++;
  }
  const free: StoredMosaic['free'] = [];
  for (const [k, v] of d.free) free.push([k, v.map((f) => ({ poly: f.poly.map((p) => [p.x, p.y] as [number, number]), color: f.color }))]);
  return {
    v: 1,
    cols: d.cols,
    rows: d.rows,
    kind: d.kind,
    c1: d.c1,
    c2: d.c2,
    subIdx,
    subLen,
    subCol,
    lineIdx,
    lineVal,
    free,
    progress: d.progress,
    rec: d.rec,
    ...(d.rev !== undefined ? { rev: d.rev } : {}),
    ...(d.targets && opts.targets !== false ? packTargets(d.targets) : {}),
  };
}

export function unpackMosaic(s: StoredMosaic): MosaicDataWithRev {
  const sub = new Map<number, Uint16Array>();
  let o = 0;
  for (let i = 0; i < s.subIdx.length; i++) {
    sub.set(s.subIdx[i], s.subCol.slice(o, o + s.subLen[i]));
    o += s.subLen[i];
  }
  const line = new Map<number, Float32Array>();
  for (let i = 0; i < s.lineIdx.length; i++) line.set(s.lineIdx[i], s.lineVal.slice(i * 3, i * 3 + 3));
  const free = new Map<number, FreePiece[]>();
  for (const [k, v] of s.free) free.set(k, v.map((f) => ({ poly: f.poly.map(([x, y]) => ({ x, y }) as Pt), color: f.color })));
  const targets = unpackTargets(s, s.cols * s.rows);
  return {
    cols: s.cols,
    rows: s.rows,
    kind: s.kind,
    c1: s.c1,
    c2: s.c2,
    sub,
    line,
    free,
    progress: s.progress,
    rec: s.rec ?? new Uint8Array(s.cols * s.rows),
    ...(s.rev !== undefined ? { rev: s.rev } : {}),
    ...(targets ? { targets } : {}),
  };
}

/** Transferierbare Puffer für postMessage (jeder Puffer genau einmal – doppelte Einträge lehnt postMessage ab). */
export function transferablesOf(s: StoredMosaic): ArrayBuffer[] {
  const views: (ArrayBufferView | undefined)[] = [s.kind, s.c1, s.c2, s.subIdx, s.subLen, s.subCol, s.lineIdx, s.lineVal, s.progress, s.rec, s.tKind, s.tLab1, s.tLab2, s.tLine, s.tSubLen, s.tSubLab];
  const out = new Set<ArrayBuffer>();
  for (const v of views) if (v) out.add(v.buffer as ArrayBuffer);
  return [...out];
}

/** Tiefe Kopie (einschließlich der Fotofarben). */
export function cloneMosaic(d: MosaicData): MosaicData {
  return unpackMosaic(structuredClone(packMosaic(d)));
}
