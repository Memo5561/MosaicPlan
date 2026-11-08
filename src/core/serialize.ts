/**
 * Kompakte, strukturierte-Klon-fähige Darstellung der Mosaikdaten
 * (für IndexedDB und Worker-Transfers).
 */
import type { Pt } from './geometry';
import type { FreePiece, MosaicData } from './types';

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
}

/** Mosaikdaten, die (optional) wissen, zu welcher gespeicherten Revision sie gehören. */
export type MosaicDataWithRev = MosaicData & { rev?: string };

export function packMosaic(d: MosaicDataWithRev): StoredMosaic {
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
  };
}

/** Transferierbare Puffer für postMessage. */
export function transferablesOf(s: StoredMosaic): ArrayBuffer[] {
  return [s.kind, s.c1, s.c2, s.subIdx, s.subLen, s.subCol, s.lineIdx, s.lineVal, s.progress, s.rec].map((a) => a.buffer as ArrayBuffer);
}

export function cloneMosaic(d: MosaicData): MosaicData {
  return unpackMosaic(structuredClone(packMosaic(d)));
}
