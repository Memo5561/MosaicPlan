/**
 * Zusammengehörigkeit von gespeichertem Projekt (Palette) und gespeichertem Mosaikraster.
 *
 * Das Raster speichert je Stein nur einen Index in die Palette des Projekts. Raster und Palette
 * gehören deshalb nur dann zusammen, wenn sie aus derselben Berechnung stammen (gleiche Revision)
 * und jeder verwendete Farbindex in der Palette existiert. Passt das nicht, darf das Raster weder
 * angezeigt noch geplant oder gedruckt werden – sonst erschienen Steine in falschen Farben.
 */
import type { StoredMosaic } from './serialize';
import { CellKind, type MosaicData } from './types';

/** Raster im Speicher oder in gespeicherter Form (mit oder ohne Fortschritt). */
export type AnyMosaic = MosaicData | Omit<StoredMosaic, 'progress'>;

/**
 * Größter Farbindex, den das Raster tatsächlich verwendet (−1 bei leerem Raster).
 *
 * Geprüft werden genau die Farben, die gezeichnet und gezählt werden:
 * c1 jeder Zelle, c2 nur bei zweiteiligen Zellen (Diagonale ╲/╱ und Kantenschnitt),
 * die k×k-Farben unterteilter Zellen und die Farben aller Freiform-Teile.
 */
export function maxColorIndex(d: AnyMosaic): number {
  const n = d.kind.length;
  let max = -1;
  for (let i = 0; i < n; i++) {
    const k = d.kind[i];
    if (d.c1[i] > max) max = d.c1[i];
    if ((k === CellKind.DIAG_A || k === CellKind.DIAG_B || k === CellKind.LINE) && d.c2[i] > max) max = d.c2[i];
  }
  if ('subCol' in d) {
    // gespeicherte Form: Zellindizes, Längen und Farben hintereinander
    let o = 0;
    for (let j = 0; j < d.subIdx.length; j++) {
      const len = d.subLen[j];
      if (d.kind[d.subIdx[j]] === CellKind.SUB) for (let q = o; q < o + len; q++) if (d.subCol[q] > max) max = d.subCol[q];
      o += len;
    }
    for (const [idx, pieces] of d.free) if (d.kind[idx] === CellKind.FREE) for (const p of pieces) if (p.color > max) max = p.color;
  } else {
    for (const [idx, cols] of d.sub) if (d.kind[idx] === CellKind.SUB) for (let q = 0; q < cols.length; q++) if (cols[q] > max) max = cols[q];
    for (const [idx, pieces] of d.free) if (d.kind[idx] === CellKind.FREE) for (const p of pieces) if (p.color > max) max = p.color;
  }
  return max;
}

export type IntegrityReason = 'rev' | 'index';

export interface IntegrityResult {
  ok: boolean;
  /** 'rev': Raster stammt aus einer anderen Berechnung; 'index': Farbindex außerhalb der Palette */
  reason: IntegrityReason | null;
}

/**
 * Prüft, ob ein gespeichertes Raster zum gespeicherten Projekt gehört.
 * Daten älterer Versionen ohne Revision (auf beiden Seiten) bestehen die Revisionsprüfung;
 * für sie bleibt die Indexprüfung der einzige Schutz.
 */
export function checkMosaicIntegrity(rec: { mosaicRev?: string; palette: readonly unknown[] }, stored: AnyMosaic & { rev?: string }): IntegrityResult {
  if ((rec.mosaicRev ?? null) !== (stored.rev ?? null)) return { ok: false, reason: 'rev' };
  if (maxColorIndex(stored) >= rec.palette.length) return { ok: false, reason: 'index' };
  return { ok: true, reason: null };
}
