/// <reference lib="webworker" />
/**
 * Koordinaten-CSV im eigenen Worker (Paket w6-plan-exports, Kanal 'csv').
 *
 * buildCsvChunks liefert Bänder von etwa 20.000 Zeilen; sie werden hier fortlaufend in einen Blob gefaltet
 * (sobald etwa 32 MB Text anstehen). So entsteht nie ein einziger riesiger Text – weder hier noch auf der
 * Hauptseite: zurück geht nur der Blob (wird als Verweis übergeben, nicht kopiert). Die Hauptseite setzt das BOM
 * davor und speichert ihn. Abbrechen = Worker beenden (cancelChannel('csv')).
 */
import { buildCsvChunks, CsvPaletteError, prepareCsv } from '../core/csv';
import { computeLayout, sectionsFor, type LayoutParams, type SectionSettings } from '../core/layout';
import { unpackMosaic, type StoredMosaic } from '../core/serialize';
import type { Material, PaletteColor } from '../core/types';

declare const self: DedicatedWorkerGlobalScope;

export interface CsvWorkerRequest {
  type: 'csv';
  id: number;
  layoutParams: LayoutParams;
  mosaic: StoredMosaic;
  palette: PaletteColor[];
  materials: Material[];
  sections: SectionSettings;
  /** null: ganzes Mosaik */
  sectionIds: string[] | null;
  decimalComma: boolean;
  /** Sprache der automatischen Farbnamen */
  lang?: 'de' | 'en' | 'tr';
}

export type CsvWorkerResponse =
  /** phase 'prepare': erster Durchlauf (Vorlagennummern, Zeilenzahl); 'rows': Zeilen geschrieben (done / total) */
  | { type: 'progress'; id: number; phase: 'prepare' | 'rows'; fraction: number; done: number; total: number }
  | { type: 'error'; id: number; message: string; code?: string; maxIndex?: number; paletteSize?: number }
  /** fertige CSV (ohne BOM) und Anzahl der Datenzeilen (ohne Kopfzeile) */
  | { type: 'csv'; id: number; blob: Blob; rows: number };

/** so viel Text (UTF-16-Zeichen ≈ Bytes, die Zeilen sind fast nur ASCII) sammeln, bevor er in den Blob wandert */
const FOLD_CHARS = 32 * 1024 * 1024;
/** Fortschritt höchstens so oft melden (ms) */
const PROGRESS_MS = 100;

const post = (m: CsvWorkerResponse) => self.postMessage(m);

self.onmessage = (ev: MessageEvent<CsvWorkerRequest>) => {
  const msg = ev.data;
  if (msg?.type !== 'csv') return;
  try {
    const layout = computeLayout(msg.layoutParams);
    const data = unpackMosaic(msg.mosaic);
    const grid = sectionsFor(layout, msg.sections);
    let last = 0;
    const prep = prepareCsv(layout, data, msg.palette, msg.materials, grid, msg.sectionIds, (row) => {
      const now = performance.now();
      if (now - last < PROGRESS_MS) return;
      last = now;
      post({ type: 'progress', id: msg.id, phase: 'prepare', fraction: (row + 1) / layout.rows, done: row + 1, total: layout.rows });
    });
    const total = prep.rows;
    post({ type: 'progress', id: msg.id, phase: 'rows', fraction: 0, done: 0, total });
    let blob = new Blob([]);
    let parts: string[] = [];
    let pending = 0;
    const gen = buildCsvChunks(layout, data, msg.palette, msg.materials, grid, msg.sectionIds, msg.decimalComma, msg.lang, {
      prep,
      onRows: (done) => {
        const now = performance.now();
        if (now - last < PROGRESS_MS && done < total) return;
        last = now;
        post({ type: 'progress', id: msg.id, phase: 'rows', fraction: total ? done / total : 1, done, total });
      },
    });
    let r = gen.next();
    while (!r.done) {
      parts.push(r.value);
      pending += r.value.length;
      if (pending >= FOLD_CHARS) {
        // die Texte gehen in den Blob über (UTF-8) und können freigegeben werden
        blob = new Blob([blob, ...parts]);
        parts = [];
        pending = 0;
      }
      r = gen.next();
    }
    blob = new Blob([blob, ...parts], { type: 'text/csv;charset=utf-8' });
    parts = [];
    post({ type: 'csv', id: msg.id, blob, rows: r.value });
  } catch (e) {
    if (e instanceof CsvPaletteError) post({ type: 'error', id: msg.id, message: e.message, code: e.code, maxIndex: e.maxIndex, paletteSize: e.paletteSize });
    else post({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) });
  }
};
