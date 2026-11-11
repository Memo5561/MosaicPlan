/**
 * w5-target-colours – Fotofarbe je Stein (MosaicData.targets) und Abweichung Foto ↔ Stein (src/core/deviation.ts):
 *  1. Die Berechnung hält die Fotofarben fest; für ein unverändertes Raster ergibt die Abweichung EXAKT die Kennzahlen
 *     der Berechnung (mean/max/p95 und MatchDeltaE je Farbe) – in allen Modi, ohne Einfluss auf das Ergebnis (Golden).
 *  2. Abweichung je Stein, Karte, größte Abweichungen und Zusammenfassung stimmen mit einer unabhängigen Nachrechnung
 *     überein – auch nach zufälligen manuellen Änderungen und in Teilbereichen.
 *  3. Nach Änderungen wird neu gerechnet: Farbe eines Steins, Palettenfarbe, entfernte Farbe; geänderte Form und
 *     Freiform haben keine Fotoreferenz (nie geschätzt), eine wiederhergestellte Form hat sie wieder.
 *  4. Speichern/Laden, Worker-Übergabe und Projektdatei erhalten die Fotofarben Byte für Byte; ältere oder
 *     beschädigte Daten laden ohne sie.
 *  5. Vertrag für Welle 6: Material.colorSource.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deltaE, hexToLab, type DeltaEFormula, type Lab } from '../src/core/color';
import {
  DEVIATION_LEGEND,
  deviationBin,
  deviationByColor,
  deviationForCell,
  deviationForPiece,
  deviationMap,
  deviationSummary,
  hasPhotoTargets,
  nearestColorForPiece,
  pieceTarget,
  targetState,
  topDeviations,
  type TargetState,
} from '../src/core/deviation';
import { removePaletteColor, restoreCell, setCellKind, setFreePieces, setPieceColor, snapshotCell, updatePaletteColor } from '../src/core/edits';
import { pieceColor } from '../src/core/laying';
import { pieceId, type Layout } from '../src/core/layout';
import { changedFields, materialsToCsv, MATERIAL_CSV_FIELDS } from '../src/core/materialsCsv';
import { computeMosaic, type ComputeParams, type ComputeResult } from '../src/core/mosaic';
import { piecesPerColor } from '../src/core/paletteOps';
import { cellPieceCount, cellRect, freePreset } from '../src/core/pieces';
import { cloneMosaic, packMosaic, transferablesOf, unpackMosaic, unpackTargets, type StoredMosaic } from '../src/core/serialize';
import { computeStats, type Range } from '../src/core/stats';
import { CellKind, createEmptyMosaic, DEFAULT_ADJUST, DEFAULT_SETTINGS, DEFAULT_SHAPES, type Material, type MosaicData, type PaletteColor, type PhotoTargets } from '../src/core/types';
import type { ProjectRecord } from '../src/storage/db';
import { buildProjectExport, parseProjectFile } from '../src/storage/projects';
import { baseParams, CUSTOM8, customFixed, MATERIALS12, materialFixed, mosaicHashes, sampleSetup, type MosaicHashes } from './w1-mosaic-core.fixtures';

// ---------------------------------------------------------------- Berechnete Beispiele (je Schlüssel einmal)

interface Case {
  key: string;
  sample: string;
  formula: DeltaEFormula;
  patch: () => Partial<ComputeParams>;
}

const CASES: Case[] = [
  { key: 'portrait', sample: 'portrait', formula: '2000', patch: () => ({}) },
  { key: 'landscape', sample: 'landscape', formula: '2000', patch: () => ({}) },
  { key: 'animal', sample: 'animal', formula: '2000', patch: () => ({}) },
  { key: 'city', sample: 'city', formula: '2000', patch: () => ({}) },
  { key: 'portrait/dither-cie76', sample: 'portrait', formula: '76', patch: () => ({ dither: 0.6, deltaE: '76' }) },
  { key: 'portrait/dither', sample: 'portrait', formula: '2000', patch: () => ({ dither: 0.5 }) },
  { key: 'portrait/materials', sample: 'portrait', formula: '2000', patch: () => ({ paletteMode: 'materials', fixedPalette: materialFixed(MATERIALS12) }) },
  { key: 'portrait/auto-snap', sample: 'portrait', formula: '2000', patch: () => ({ paletteMode: 'auto-snap', colorCount: 16, fixedPalette: materialFixed(MATERIALS12) }) },
  { key: 'portrait/custom', sample: 'portrait', formula: '2000', patch: () => ({ paletteMode: 'custom', fixedPalette: customFixed(CUSTOM8) }) },
  { key: 'city/detail-k3', sample: 'city', formula: '2000', patch: () => ({ shapes: { ...DEFAULT_SHAPES, subdivK: 3, detailLevel: 0.9, autoDetail: false } }) },
  { key: 'portrait/contour', sample: 'portrait', formula: '2000', patch: () => ({ shapes: { ...DEFAULT_SHAPES, contourContinuity: true, detailLevel: 0.8 } }) },
  {
    key: 'animal/no-shapes',
    sample: 'animal',
    formula: '2000',
    patch: () => ({ shapes: { diagonal: false, line: false, subdivide: false, subdivK: 2, detailLevel: 0.5, autoDetail: true, skinProtect: true, minPieceMm: 1.5 } }),
  },
];

const results = new Map<string, { res: ComputeResult; layout: Layout; formula: DeltaEFormula }>();
function computed(key: string) {
  let hit = results.get(key);
  if (!hit) {
    const c = CASES.find((x) => x.key === key)!;
    const su = sampleSetup(c.sample);
    hit = { res: computeMosaic(su.img, baseParams(su, c.patch())), layout: su.layout, formula: c.formula };
    results.set(key, hit);
  }
  return hit;
}
/** Frische, unabhängige Kopie eines berechneten Beispiels (Tests ändern sie). */
function fresh(key: string) {
  const c = computed(key);
  return { data: cloneMosaic(c.res.data), palette: c.res.palette.map((p) => ({ ...p })), layout: c.layout, formula: c.formula, diagnostics: c.res.diagnostics };
}

// ---------------------------------------------------------------- Unabhängige Nachrechnung

const isSplit = (k: number) => k === CellKind.DIAG_A || k === CellKind.DIAG_B || k === CellKind.LINE;

/**
 * Fotofarbe und Zustand eines Teilstücks direkt aus den gepackten Feldern (ohne deviation.ts). `s`, `u`, `o`: Anzahl der
 * Zweiteiler, k×k-Zellen und k×k-Teilsteine der Berechnung VOR der Zelle.
 */
function refAt(data: MosaicData, idx: number, piece: number, s: number, u: number, o: number): { state: TargetState; lab: Lab | null } {
  const t = data.targets!;
  if (data.kind[idx] === CellKind.FREE) return { state: 'free', lab: null };
  const k = t.kind[idx];
  let same = data.kind[idx] === k;
  if (same && k === CellKind.SUB) same = data.sub.get(idx)?.length === t.subLen[u];
  if (same && k === CellKind.LINE) {
    const l = data.line.get(idx);
    same = !!l && l[0] === t.line[s * 3] && l[1] === t.line[s * 3 + 1] && l[2] === t.line[s * 3 + 2];
  }
  if (!same) return { state: 'shape', lab: null };
  const q = (arr: Uint8Array, i: number): Lab => [arr[i * 3] / 2.55, arr[i * 3 + 1] - 128, arr[i * 3 + 2] - 128];
  if (k === CellKind.SUB) return { state: 'ok', lab: piece < t.subLen[u] ? [t.subLab[(o + piece) * 3], t.subLab[(o + piece) * 3 + 1], t.subLab[(o + piece) * 3 + 2]] : null };
  if (piece === 0) return { state: 'ok', lab: q(t.lab1, idx) };
  if (piece === 1 && isSplit(k)) return { state: 'ok', lab: q(t.lab2, s) };
  return { state: 'ok', lab: null };
}

/** Wie refAt, die Ränge werden von der ersten Zelle an gezählt. */
function refTarget(data: MosaicData, idx: number, piece: number): { state: TargetState; lab: Lab | null } {
  const t = data.targets;
  if (!t) return { state: 'legacy', lab: null };
  let s = 0;
  let u = 0;
  let o = 0;
  for (let i = 0; i < idx; i++) {
    if (isSplit(t.kind[i])) s++;
    else if (t.kind[i] === CellKind.SUB) o += t.subLen[u++];
  }
  return refAt(data, idx, piece, s, u, o);
}

interface RefPiece {
  idx: number;
  piece: number;
  pieces: number;
  color: number;
  state: TargetState;
  d: number | null;
}

/** Alle Teilstücke (im Bereich) in Leserichtung mit unabhängig gerechneter Abweichung. */
function refPieces(data: MosaicData, palette: readonly PaletteColor[], formula: DeltaEFormula, range?: Range): RefPiece[] {
  const out: RefPiece[] = [];
  const rg = range ?? { r0: 0, r1: data.rows, c0: 0, c1: data.cols };
  const t = data.targets;
  let s = 0;
  let u = 0;
  let o = 0;
  // immer von der ersten Zelle an zählen – auch wenn nur ein Teilbereich gefragt ist
  for (let idx = 0; idx < data.kind.length; idx++) {
    const row = Math.floor(idx / data.cols);
    const col = idx % data.cols;
    if (row >= rg.r0 && row < rg.r1 && col >= rg.c0 && col < rg.c1) {
      const n = cellPieceCount(data, idx);
      for (let q = 0; q < n; q++) {
        const color = pieceColor(data, idx, q);
        const rt = t ? refAt(data, idx, q, s, u, o) : { state: 'legacy' as const, lab: null };
        const lab = palette[color]?.lab;
        out.push({ idx, piece: q, pieces: n, color, state: rt.state, d: rt.lab && lab ? deltaE(formula, rt.lab, lab) : null });
      }
    }
    if (t) {
      if (isSplit(t.kind[idx])) s++;
      else if (t.kind[idx] === CellKind.SUB) o += t.subLen[u++];
    }
  }
  return out;
}

const firstCell = (data: MosaicData, pred: (idx: number) => boolean): number => {
  for (let i = 0; i < data.kind.length; i++) if (pred(i)) return i;
  throw new Error('keine passende Zelle im Beispiel');
};
const rc = (data: MosaicData, idx: number) => ({ row: Math.floor(idx / data.cols), col: idx % data.cols });

/** Kleiner deterministischer Zufallsgenerator (mulberry32) */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ================================================================ 1. Berechnung

describe('Berechnung hält die Fotofarbe jedes Steins fest', () => {
  for (const c of CASES) {
    it(`${c.key}: Abweichung des unveränderten Rasters = Kennzahlen der Berechnung (exakt)`, () => {
      const { res, layout, formula } = computed(c.key);
      const { data, palette, diagnostics } = res;
      const t = data.targets!;
      expect(t).toBeDefined();
      expect(hasPhotoTargets(data)).toBe(true);

      // Aufbau: Form der Berechnung = heutige Form; Längen der gepackten Felder
      const N = data.kind.length;
      expect(Array.from(t.kind)).toEqual(Array.from(data.kind));
      expect(t.kind).not.toBe(data.kind); // Kopie – manuelle Formänderungen berühren sie nicht
      expect(t.lab1.length).toBe(N * 3);
      expect(t.lab2.length).toBe(diagnostics.splitCells * 3);
      expect(t.line.length).toBe(diagnostics.splitCells * 3);
      expect(t.subLen.length).toBe(diagnostics.subCells);
      expect(t.subLab.length).toBe(Array.from(t.subLen).reduce((a, b) => a + b, 0) * 3);
      expect(data.sub.size).toBe(diagnostics.subCells);

      // Jeder Stein ist gemessen – so viele wie die Statistik zählt
      const sum = deviationSummary(data, palette, formula);
      const total = piecesPerColor(data, palette.length).reduce((a, b) => a + b, 0);
      expect(sum.pieces).toBe(total);
      expect(sum.measured).toBe(total);
      expect(sum.missing).toEqual({ legacy: 0, free: 0, shape: 0, color: 0 });
      expect(sum.bins.reduce((a, b) => a + b, 0)).toBe(total);

      // exakt die Kennzahlen der Berechnung (nicht nur „innerhalb der Rundung“)
      expect(sum.mean).toBe(diagnostics.meanDeltaE);
      expect(sum.max).toBe(diagnostics.maxDeltaE);
      expect(sum.p95).toBe(diagnostics.p95DeltaE);
      expect(deviationByColor(data, palette, formula)).toEqual(palette.map((p) => p.matchDeltaE));
      expect(sum.over5).toBe(palette.reduce((a, p) => a + p.matchDeltaE!.over5, 0));
      expect(sum.over10).toBe(palette.reduce((a, p) => a + p.matchDeltaE!.over10, 0));

      // Karte: keine Zelle ohne Fotoreferenz, größter Wert = größte Abweichung der Berechnung
      const map = deviationMap(layout, data, palette, formula);
      expect(map.length).toBe(N);
      let mapMax = 0;
      for (let i = 0; i < N; i++) {
        expect(Number.isNaN(map[i])).toBe(false);
        if (map[i] > mapMax) mapMax = map[i];
      }
      expect(mapMax).toBe(Math.fround(diagnostics.maxDeltaE));
      const top = topDeviations(layout, data, palette, formula, 1);
      expect(top[0].deltaE).toBe(diagnostics.maxDeltaE);
    });
  }

  it('Schnittgerade der Berechnung ist je Kantenschnitt bitgleich festgehalten (auch nach „Konturen durchgehend“)', () => {
    for (const key of ['portrait', 'portrait/contour']) {
      const { data } = computed(key).res;
      const t = data.targets!;
      let s = 0;
      let lines = 0;
      for (let i = 0; i < data.kind.length; i++) {
        if (!isSplit(data.kind[i])) continue;
        const cur = data.line.get(i);
        if (data.kind[i] === CellKind.LINE) {
          lines++;
          expect(Array.from(t.line.subarray(s * 3, s * 3 + 3))).toEqual(Array.from(cur!));
        } else expect(Array.from(t.line.subarray(s * 3, s * 3 + 3))).toEqual([0, 0, 0]);
        s++;
      }
      expect(lines).toBeGreaterThan(0);
    }
  });

  it('ohne Einfluss auf das Ergebnis: Golden-Hashes unverändert', () => {
    const golden = JSON.parse(readFileSync('tests/golden/mosaic-hashes.json', 'utf8')) as { samples: Record<string, MosaicHashes>; modes: Record<string, MosaicHashes> };
    for (const key of ['portrait', 'landscape', 'animal', 'city']) expect(mosaicHashes(computed(key).res.data, computed(key).res.palette)).toEqual(golden.samples[key]);
    for (const key of ['portrait/dither-cie76', 'portrait/materials', 'portrait/auto-snap', 'city/detail-k3', 'animal/no-shapes']) {
      expect(mosaicHashes(computed(key).res.data, computed(key).res.palette)).toEqual(golden.modes[key]);
    }
  });

  it('Speicherbedarf: 4 Byte je Zelle + 15 je Zweiteiler + (1 + 12·k²) je k×k-Zelle', () => {
    for (const key of ['portrait', 'city/detail-k3', 'animal/no-shapes']) {
      const { data, diagnostics } = computed(key).res;
      const t = data.targets!;
      const bytes = t.kind.byteLength + t.lab1.byteLength + t.lab2.byteLength + t.line.byteLength + t.subLen.byteLength + t.subLab.byteLength;
      let sub = 0;
      for (const v of data.sub.values()) sub += 1 + 12 * v.length;
      expect(bytes).toBe(4 * data.kind.length + 15 * diagnostics.splitCells + sub);
    }
    // ohne Formen: genau 4 Byte je Zelle
    const plain = computed('animal/no-shapes').res.data.targets!;
    expect(plain.lab2.length + plain.line.length + plain.subLen.length + plain.subLab.length).toBe(0);
  });
});

// ================================================================ 2. Abweichung je Stein, Karte, Liste

describe('Abweichung je Stein, Karte und größte Abweichungen', () => {
  for (const key of ['portrait', 'city/detail-k3', 'portrait/dither-cie76']) {
    it(`${key}: jeder Stein wie unabhängig nachgerechnet`, () => {
      const { res, layout, formula } = computed(key);
      const { data, palette } = res;
      const ref = refPieces(data, palette, formula);
      const map = deviationMap(layout, data, palette, formula);
      const cellMax = new Map<number, number>();
      let kinds = 0;
      for (const p of ref) {
        expect(p.state).toBe('ok');
        expect(p.d).not.toBeNull();
        expect(deviationForPiece(data, palette, p.idx, p.piece, formula)).toBe(p.d);
        expect(targetState(data, p.idx)).toBe('ok');
        cellMax.set(p.idx, Math.max(cellMax.get(p.idx) ?? 0, p.d!));
        kinds |= 1 << data.kind[p.idx];
      }
      // das Porträt deckt ganze Steine, beide Diagonalen, Kantenschnitte und k×k ab; das Stadtbild viele 3×3-Zellen
      const all = (1 << CellKind.FULL) | (1 << CellKind.DIAG_A) | (1 << CellKind.DIAG_B) | (1 << CellKind.LINE) | (1 << CellKind.SUB);
      if (key.startsWith('portrait')) expect(kinds).toBe(all);
      else expect(kinds & ((1 << CellKind.FULL) | (1 << CellKind.LINE) | (1 << CellKind.SUB))).toBe((1 << CellKind.FULL) | (1 << CellKind.LINE) | (1 << CellKind.SUB));
      for (const [idx, d] of cellMax) {
        expect(map[idx]).toBe(Math.fround(d));
        expect(deviationForCell(data, palette, idx, formula)).toBe(d);
      }
      // Fotofarbe: ganze Steine/Zweiteiler vom Speicherraster, Teilsteine ungerundet
      const full = firstCell(data, (i) => data.kind[i] === CellKind.FULL);
      const t = data.targets!;
      expect(pieceTarget(data, full, 0)).toEqual([t.lab1[full * 3] / 2.55, t.lab1[full * 3 + 1] - 128, t.lab1[full * 3 + 2] - 128]);
      expect(pieceTarget(data, full, 1)).toBeNull();
      const sub = firstCell(data, (i) => data.kind[i] === CellKind.SUB);
      expect(pieceTarget(data, sub, data.sub.get(sub)!.length)).toBeNull();
      expect(pieceTarget(data, sub, 0)).toEqual(refTarget(data, sub, 0).lab);
      const split = firstCell(data, (i) => isSplit(data.kind[i]));
      expect(pieceTarget(data, split, 1)).toEqual(refTarget(data, split, 1).lab);
      expect(pieceTarget(data, split, 2)).toBeNull();
    });
  }

  it('ungültige Angaben liefern null/NaN statt eines Werts', () => {
    const { res, formula } = computed('portrait');
    const { data, palette } = res;
    for (const idx of [-1, data.kind.length, 1.5, NaN]) {
      expect(pieceTarget(data, idx, 0)).toBeNull();
      expect(deviationForPiece(data, palette, idx, 0, formula)).toBeNull();
      expect(Number.isNaN(deviationForCell(data, palette, idx, formula))).toBe(true);
      expect(nearestColorForPiece(data, palette, idx, 0, formula)).toBeNull();
    }
    expect(pieceTarget(data, 0, -1)).toBeNull();
    expect(pieceTarget(data, 0, 0.5)).toBeNull();
    expect(() => deviationMap({ cols: data.cols + 1, rows: data.rows }, data, palette, formula)).toThrow();
    expect(() => topDeviations({ cols: data.cols, rows: data.rows - 1 }, data, palette, formula, 5)).toThrow();
  });

  it('größte Abweichungen: absteigend, bei Gleichstand in Leserichtung, mit Bezeichnung – wie vollständig sortiert', () => {
    const { res, layout, formula } = computed('portrait/dither');
    const { data, palette } = res;
    const sorted = refPieces(data, palette, formula)
      .filter((p) => p.d !== null)
      .sort((a, b) => b.d! - a.d! || a.idx - b.idx || a.piece - b.piece);
    for (const n of [1, 7, 50, 333]) {
      const top = topDeviations(layout, data, palette, formula, n);
      expect(top.length).toBe(n);
      top.forEach((p, i) => {
        const r = sorted[i];
        expect([p.idx, p.piece, p.pieces, p.color, p.deltaE]).toEqual([r.idx, r.piece, r.pieces, r.color, r.d]);
        expect(p.row * data.cols + p.col).toBe(p.idx);
        expect(p.id).toBe(pieceId(layout, p.row, p.col, p.piece, p.pieces));
        expect(p.target).toEqual(refTarget(data, p.idx, p.piece).lab);
      });
      for (let i = 1; i < top.length; i++) expect(top[i - 1].deltaE >= top[i].deltaE).toBe(true);
    }
    // mehr verlangt als vorhanden: alle Steine, jeder genau einmal
    const all = topDeviations(layout, data, palette, formula, sorted.length + 100);
    expect(all.length).toBe(sorted.length);
    expect(new Set(all.map((p) => p.id)).size).toBe(sorted.length);
    for (const n of [0, -3, NaN]) expect(topDeviations(layout, data, palette, formula, n)).toEqual([]);
    expect(topDeviations(layout, data, palette, formula, 2.9).length).toBe(2);
  });

  it('Gleichstand: gleiche Abweichung → Leserichtung entscheidet (einfarbige Palette, gleiche Fotofarbe)', () => {
    const { data, layout } = fresh('animal/no-shapes');
    const t = data.targets!;
    // alle Steine auf Farbe 0, vier Steine mit derselben, stark abweichenden Fotofarbe
    data.c1.fill(0);
    const palette: PaletteColor[] = [{ code: 1, name: 'Grau', hex: '#808080', lab: hexToLab('#808080') }];
    const N = data.kind.length;
    const picks = [N - 1, 5, data.cols * 3 + 2, 77];
    for (let i = 0; i < N; i++) t.lab1.set([137, 128, 128], i * 3); // ≈ Palettenfarbe
    for (const i of picks) t.lab1.set([255, 128, 128], i * 3); // Weiß
    const top = topDeviations(layout, data, palette, '2000', 3);
    expect(top.map((p) => p.idx)).toEqual([5, 77, data.cols * 3 + 2]);
    expect(new Set(top.map((p) => p.deltaE)).size).toBe(1);
    // ein später kommender Stein mit größerer Abweichung verdrängt den in Leserichtung letzten der Gleichen
    t.lab1.set([0, 128, 128], (N - 2) * 3); // Schwarz
    expect(topDeviations(layout, data, palette, '2000', 3).map((p) => p.idx)).toEqual([N - 2, 5, 77]);
    expect(topDeviations(layout, data, palette, '2000', 5).map((p) => p.idx)).toEqual([N - 2, 5, 77, data.cols * 3 + 2, N - 1]);
    expect(topDeviations(layout, data, palette, '2000', 1).map((p) => p.idx)).toEqual([N - 2]);
  });

  it('gleiche Fotofarbe, viele verschiedene Steinfarben: jeder Stein gegen SEINE Farbe (Zwischenspeicher trennt die Farben)', () => {
    // 16 × 8 Zweiteiler, alle Teile mit derselben Fotofarbe, jedes Teil in einer zufälligen von 4096 Palettenfarben –
    // im kleinen Zwischenspeicher eines so kleinen Rasters teilen sich viele (Fotofarbe, Steinfarbe)-Paare einen Platz
    const cols = 16;
    const rows = 8;
    const N = cols * rows;
    const data = createEmptyMosaic(cols, rows);
    data.kind.fill(CellKind.DIAG_A);
    const lab1 = new Uint8Array(N * 3);
    for (let i = 0; i < N; i++) lab1.set([140, 150, 110], i * 3);
    data.targets = { kind: data.kind.slice(), lab1, lab2: lab1.slice(), line: new Float32Array(N * 3), subLen: new Uint8Array(0), subLab: new Float32Array(0) };
    const palette: PaletteColor[] = Array.from({ length: 4096 }, (_, i) => {
      const hex = `#${[i & 15, (i >> 4) & 15, (i >> 8) & 15].map((v) => (v * 17).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
      return { code: i + 1, name: hex, hex, lab: hexToLab(hex) };
    });
    const target: Lab = [140 / 2.55, 150 - 128, 110 - 128];
    const rnd = rng(4711);
    for (const formula of ['2000', '76'] as const) {
      for (let i = 0; i < N; i++) {
        data.c1[i] = Math.floor(rnd() * palette.length);
        data.c2[i] = Math.floor(rnd() * palette.length);
      }
      const d1 = Array.from({ length: N }, (_, i) => deltaE(formula, target, palette[data.c1[i]].lab));
      const d2 = Array.from({ length: N }, (_, i) => deltaE(formula, target, palette[data.c2[i]].lab));
      expect(Array.from(deviationMap({ cols, rows }, data, palette, formula))).toEqual(d1.map((d, i) => Math.fround(Math.max(d, d2[i]))));
      const s = deviationSummary(data, palette, formula);
      expect(s.measured).toBe(2 * N);
      expect(s.max).toBe(Math.max(...d1, ...d2));
      let acc = 0;
      for (let i = 0; i < N; i++) acc = acc + d1[i] + d2[i];
      expect(s.mean).toBe(acc / (2 * N));
      const top = topDeviations({ cols, rows }, data, palette, formula, 2 * N);
      for (const p of top) expect(p.deltaE).toBe(p.piece === 0 ? d1[p.idx] : d2[p.idx]);
      // dieselben Paare mehrfach (jede Farbe in jeder Zelle zweimal): gleiche Paare ergeben denselben Wert
      const twice = { ...data, c2: data.c1 };
      expect(Array.from(deviationMap({ cols, rows }, twice, palette, formula))).toEqual(d1.map((d) => Math.fround(d)));
    }
  });

  it('Teilbereich (z. B. Abschnitt): Zusammenfassung und Liste nur aus dem Bereich, Summe der Bereiche = Ganzes', () => {
    const { res, layout, formula } = computed('city/detail-k3');
    const { data, palette } = res;
    const whole = deviationSummary(data, palette, formula);
    const midR = Math.floor(data.rows / 3);
    const midC = Math.floor(data.cols / 2) + 1;
    const parts: Range[] = [
      { r0: 0, r1: midR, c0: 0, c1: midC },
      { r0: 0, r1: midR, c0: midC, c1: data.cols },
      { r0: midR, r1: data.rows, c0: 0, c1: midC },
      { r0: midR, r1: data.rows, c0: midC, c1: data.cols },
    ];
    let measured = 0;
    let max = 0;
    const bins = [0, 0, 0, 0];
    for (const rg of parts) {
      const s = deviationSummary(data, palette, formula, rg);
      const ref = refPieces(data, palette, formula, rg);
      expect(s.pieces).toBe(ref.length);
      expect(s.measured).toBe(ref.length);
      expect(s.max).toBe(Math.max(...ref.map((p) => p.d!)));
      expect(s.mean).toBeCloseTo(ref.reduce((a, p) => a + p.d!, 0) / ref.length, 10);
      measured += s.measured;
      max = Math.max(max, s.max);
      s.bins.forEach((b, i) => (bins[i] += b));
      const sorted = ref.slice().sort((a, b) => b.d! - a.d! || a.idx - b.idx || a.piece - b.piece);
      const top = topDeviations(layout, data, palette, formula, 20, rg);
      expect(top.map((p) => [p.idx, p.piece, p.deltaE])).toEqual(sorted.slice(0, 20).map((p) => [p.idx, p.piece, p.d]));
    }
    expect(measured).toBe(whole.measured);
    expect(max).toBe(whole.max);
    expect(bins).toEqual(whole.bins);
    // Bereich über den Rand hinaus wird begrenzt, leerer Bereich zählt nichts
    expect(deviationSummary(data, palette, formula, { r0: -5, r1: data.rows + 5, c0: -5, c1: data.cols + 5 })).toEqual(whole);
    expect(deviationSummary(data, palette, formula, { r0: 3, r1: 3, c0: 0, c1: data.cols }).pieces).toBe(0);
    expect(topDeviations(layout, data, palette, formula, 5, { r0: 0, r1: data.rows, c0: 4, c1: 4 })).toEqual([]);
  });

  it('Legende: unter 2 · 2 bis 5 · über 5 bis 10 · über 10', () => {
    expect(DEVIATION_LEGEND).toEqual([2, 5, 10]);
    expect([0, 1.99, 2, 5, 5.01, 10, 10.01, 99].map(deviationBin)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    const { res, formula } = computed('portrait/dither');
    const ref = refPieces(res.data, res.palette, formula);
    const s = deviationSummary(res.data, res.palette, formula);
    expect(s.bins).toEqual([0, 1, 2, 3].map((b) => ref.filter((p) => deviationBin(p.d!) === b).length));
    expect(s.bins[2] + s.bins[3]).toBe(s.over5);
    expect(s.bins[3]).toBe(s.over10);
  });
});

// ================================================================ 3. Nach Änderungen

describe('Abweichung nach manuellen Änderungen', () => {
  it('umgefärbter Stein: seine Abweichung wird neu gerechnet, alle anderen bleiben', () => {
    const { data, palette, layout, formula } = fresh('portrait');
    const before = deviationMap(layout, data, palette, formula);
    const sumBefore = deviationSummary(data, palette, formula);
    const idx = firstCell(data, (i) => data.kind[i] === CellKind.FULL && data.c1[i] !== 0);
    const old = data.c1[idx];
    const target = pieceTarget(data, idx, 0)!;
    const d0 = deviationForPiece(data, palette, idx, 0, formula)!;
    expect(d0).toBe(deltaE(formula, target, palette[old].lab));

    setPieceColor(data, idx, 0, 0);
    const d1 = deviationForPiece(data, palette, idx, 0, formula)!;
    expect(d1).toBe(deltaE(formula, target, palette[0].lab));
    expect(d1).not.toBe(d0);
    expect(pieceTarget(data, idx, 0)).toEqual(target); // die Fotofarbe selbst ändert sich nie
    const after = deviationMap(layout, data, palette, formula);
    for (let i = 0; i < after.length; i++) expect(after[i]).toBe(i === idx ? Math.fround(d1) : before[i]);
    const sumAfter = deviationSummary(data, palette, formula);
    expect(sumAfter.measured).toBe(sumBefore.measured);
    expect(sumAfter.mean).toBeCloseTo(sumBefore.mean + (d1 - d0) / sumBefore.measured, 9);
    const by = deviationByColor(data, palette, formula);
    expect(by[old].pieces).toBe(palette[old].matchDeltaE!.pieces - 1);
    expect(by[0].pieces).toBe(palette[0].matchDeltaE!.pieces + 1);

    // zurück: wieder exakt die Werte der Berechnung
    setPieceColor(data, idx, 0, old);
    expect(deviationSummary(data, palette, formula)).toEqual(sumBefore);
    expect(deviationByColor(data, palette, formula)).toEqual(palette.map((p) => p.matchDeltaE));
  });

  it('Teil eines Zweiteilers und Teilstein einer k×k-Zelle umfärben', () => {
    const { data, palette, formula } = fresh('portrait');
    const split = firstCell(data, (i) => isSplit(data.kind[i]));
    const t1 = pieceTarget(data, split, 1)!;
    const other = (c: number) => (c + 1) % palette.length;
    const c2 = other(data.c2[split]);
    const keep = deviationForPiece(data, palette, split, 0, formula);
    setPieceColor(data, split, 1, c2);
    expect(deviationForPiece(data, palette, split, 1, formula)).toBe(deltaE(formula, t1, palette[c2].lab));
    expect(deviationForPiece(data, palette, split, 0, formula)).toBe(keep);

    const sub = firstCell(data, (i) => data.kind[i] === CellKind.SUB);
    const n = data.sub.get(sub)!.length;
    const tq = pieceTarget(data, sub, n - 1)!;
    const cq = other(data.sub.get(sub)![n - 1]);
    const rest = Array.from({ length: n - 1 }, (_, q) => deviationForPiece(data, palette, sub, q, formula));
    setPieceColor(data, sub, n - 1, cq);
    expect(deviationForPiece(data, palette, sub, n - 1, formula)).toBe(deltaE(formula, tq, palette[cq].lab));
    expect(Array.from({ length: n - 1 }, (_, q) => deviationForPiece(data, palette, sub, q, formula))).toEqual(rest);
    expect(deviationForCell(data, palette, sub, formula)).toBe(Math.max(...Array.from({ length: n }, (_, q) => deviationForPiece(data, palette, sub, q, formula)!)));
  });

  it('Vorschlag „nächste Farbe“: ohne Farbmischung hat jeder ganze Stein und Zweiteiler bereits die nächste Farbe', () => {
    const { res, formula } = computed('portrait');
    const { data, palette } = res;
    let checked = 0;
    for (let idx = 0; idx < data.kind.length; idx++) {
      if (data.kind[idx] === CellKind.SUB) continue;
      for (let q = 0; q < cellPieceCount(data, idx); q++) {
        const nc = nearestColorForPiece(data, palette, idx, q, formula)!;
        expect(nc.better).toBe(false);
        expect(nc.current).toBe(deviationForPiece(data, palette, idx, q, formula));
        expect(nc.deltaE).toBe(nc.current);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it('Vorschlag „nächste Farbe“ mit Farbmischung: übernehmen senkt die Abweichung genau auf den genannten Wert', () => {
    const { data, palette, formula } = fresh('portrait/dither');
    let better = 0;
    for (let idx = 0; idx < data.kind.length; idx++) {
      if (data.kind[idx] !== CellKind.FULL) continue;
      const nc = nearestColorForPiece(data, palette, idx, 0, formula)!;
      // der Vorschlag ist wirklich die nächste Farbe (jede Palettenfarbe verglichen)
      const tl = pieceTarget(data, idx, 0)!;
      expect(nc.deltaE).toBe(Math.min(...palette.map((p) => deltaE(formula, tl, p.lab))));
      if (!nc.better) continue;
      better++;
      expect(nc.deltaE).toBeLessThan(nc.current!);
      setPieceColor(data, idx, 0, nc.index);
      expect(deviationForPiece(data, palette, idx, 0, formula)).toBe(nc.deltaE);
      expect(nearestColorForPiece(data, palette, idx, 0, formula)!.better).toBe(false);
    }
    expect(better).toBeGreaterThan(0);
    // danach ist keine Abweichung größer als vorher im Mittel
    expect(deviationSummary(data, palette, formula).mean).toBeLessThan(computed('portrait/dither').res.diagnostics.meanDeltaE);
  });

  it('geänderte Palettenfarbe: alle Steine dieser Farbe gegen den neuen Farbton, die übrigen unverändert', () => {
    const { data, palette, layout, formula } = fresh('portrait');
    const i = 3;
    const before = refPieces(data, palette, formula);
    const next = updatePaletteColor(palette, i, { hex: '#3366CC' });
    expect(next[i].lab).not.toEqual(palette[i].lab);
    const after = refPieces(data, next, formula);
    const map = deviationMap(layout, data, next, formula);
    let changed = 0;
    after.forEach((p, k) => {
      expect(deviationForPiece(data, next, p.idx, p.piece, formula)).toBe(p.d);
      if (p.color === i) {
        expect(p.d).toBe(deltaE(formula, refTarget(data, p.idx, p.piece).lab!, next[i].lab));
        changed++;
      } else expect(p.d).toBe(before[k].d);
      expect(map[p.idx] >= Math.fround(p.d!)).toBe(true);
    });
    expect(changed).toBe(palette[i].matchDeltaE!.pieces);
    const by = deviationByColor(data, next, formula);
    by.forEach((m, c) => {
      if (c !== i) expect(m).toEqual(palette[c].matchDeltaE);
    });
    expect(by[i].pieces).toBe(palette[i].matchDeltaE!.pieces);
    expect(by[i].mean).not.toBe(palette[i].matchDeltaE!.mean);
  });

  it('entfernte Palettenfarbe: Steine messen gegen die Ersatzfarbe, alle anderen behalten ihren Wert', () => {
    const { data, palette, formula } = fresh('portrait');
    const i = 5;
    const before = refPieces(data, palette, formula);
    const next = removePaletteColor(palette, data, i, 2, formula);
    const after = refPieces(data, next, formula);
    expect(after.length).toBe(before.length);
    after.forEach((p, k) => {
      expect(p.state).toBe('ok');
      expect(deviationForPiece(data, next, p.idx, p.piece, formula)).toBe(p.d);
      if (before[k].color === i) expect(p.d).toBe(deltaE(formula, refTarget(data, p.idx, p.piece).lab!, palette[2].lab));
      else expect(p.d).toBe(before[k].d);
    });
    const s = deviationSummary(data, next, formula);
    expect(s.measured).toBe(before.length);
    expect(s.missing.color).toBe(0);
  });

  it('Farbindex außerhalb der Palette: nicht gemessen (Grund „color“), nie ein erfundener Wert', () => {
    const { data, palette, layout, formula } = fresh('animal/no-shapes');
    const short = palette.slice(0, palette.length - 1);
    const lost = palette[palette.length - 1].matchDeltaE!.pieces;
    expect(lost).toBeGreaterThan(0);
    const s = deviationSummary(data, short, formula);
    expect(s.missing).toEqual({ legacy: 0, free: 0, shape: 0, color: lost });
    expect(s.measured).toBe(s.pieces - lost);
    const idx = firstCell(data, (i) => data.c1[i] === palette.length - 1);
    expect(deviationForPiece(data, short, idx, 0, formula)).toBeNull();
    expect(Number.isNaN(deviationMap(layout, data, short, formula)[idx])).toBe(true);
    const nc = nearestColorForPiece(data, short, idx, 0, formula)!;
    expect(nc.current).toBeNull();
    expect(nc.better).toBe(true);
    expect(nearestColorForPiece(data, [], idx, 0, formula)).toBeNull();
    // Palettenfarbe ohne gültiges L*a*b* zählt genauso: kein Wert statt NaN
    const broken = palette.map((p, i) => (i === palette.length - 1 ? { ...p, lab: [NaN, 0, 0] as Lab } : p));
    const sb = deviationSummary(data, broken, formula);
    expect(sb.missing.color).toBe(lost);
    expect(Number.isFinite(sb.mean) && Number.isFinite(sb.max)).toBe(true);
    expect(deviationForPiece(data, broken, idx, 0, formula)).toBeNull();
    expect(nearestColorForPiece(data, broken, idx, 0, formula)!.index).not.toBe(palette.length - 1);
  });
});

describe('Form geändert oder Freiform: keine Fotoreferenz', () => {
  it('ganzer Stein → Dreiecke: keine Fotoreferenz; zurück zum ganzen Stein: wieder der Wert der Berechnung', () => {
    const { data, palette, layout, formula } = fresh('portrait');
    const idx = firstCell(data, (i) => data.kind[i] === CellKind.FULL && i > data.cols * 5);
    const { row, col } = rc(data, idx);
    const d0 = deviationForPiece(data, palette, idx, 0, formula);
    const sum0 = deviationSummary(data, palette, formula);
    expect(setCellKind(layout, data, row, col, { kind: CellKind.DIAG_A }, 2)).toBeNull();
    expect(targetState(data, idx)).toBe('shape');
    expect(pieceTarget(data, idx, 0)).toBeNull();
    expect(pieceTarget(data, idx, 1)).toBeNull();
    expect(deviationForPiece(data, palette, idx, 0, formula)).toBeNull();
    expect(nearestColorForPiece(data, palette, idx, 1, formula)).toBeNull();
    expect(Number.isNaN(deviationForCell(data, palette, idx, formula))).toBe(true);
    expect(Number.isNaN(deviationMap(layout, data, palette, formula)[idx])).toBe(true);
    const s = deviationSummary(data, palette, formula);
    expect(s.pieces).toBe(sum0.pieces + 1);
    expect(s.measured).toBe(sum0.measured - 1);
    expect(s.missing).toEqual({ legacy: 0, free: 0, shape: 2, color: 0 });
    expect(topDeviations(layout, data, palette, formula, s.pieces).some((p) => p.idx === idx)).toBe(false);
    // die Nachbarn in den gepackten Feldern sind nicht verrutscht
    for (const p of refPieces(data, palette, formula)) expect(deviationForPiece(data, palette, p.idx, p.piece, formula)).toBe(p.d);

    expect(setCellKind(layout, data, row, col, { kind: CellKind.FULL }, 2)).toBeNull();
    expect(targetState(data, idx)).toBe('ok');
    expect(deviationForPiece(data, palette, idx, 0, formula)).toBe(d0);
    expect(deviationSummary(data, palette, formula)).toEqual(sum0);
  });

  it('Diagonale gedreht, Kantenschnitt verschoben, k×k umgeteilt: keine Fotoreferenz; Rückgängig stellt sie wieder her', () => {
    const { data, palette, layout, formula } = fresh('portrait');
    const cells = [
      firstCell(data, (i) => data.kind[i] === CellKind.DIAG_A),
      firstCell(data, (i) => data.kind[i] === CellKind.DIAG_B),
      firstCell(data, (i) => data.kind[i] === CellKind.LINE),
      firstCell(data, (i) => data.kind[i] === CellKind.SUB),
    ];
    const sum0 = deviationSummary(data, palette, formula);
    for (const idx of cells) {
      const { row, col } = rc(data, idx);
      const snap = snapshotCell(data, idx);
      const d0 = Array.from({ length: cellPieceCount(data, idx) }, (_, q) => deviationForPiece(data, palette, idx, q, formula));
      const kind = data.kind[idx];
      if (kind === CellKind.DIAG_A) expect(setCellKind(layout, data, row, col, { kind: CellKind.DIAG_B }, 0.1)).toBeNull();
      else if (kind === CellKind.DIAG_B) expect(setCellKind(layout, data, row, col, { kind: CellKind.DIAG_A }, 0.1)).toBeNull();
      else if (kind === CellKind.LINE) {
        // dieselbe Zellart, andere Schnittgerade (direkt gesetzt wie setCellKind es speichert)
        const l = data.line.get(idx)!;
        data.line.set(idx, new Float32Array([l[0], l[1], l[2] + 0.5]));
      } else {
        // dieselbe Zellart, andere Teilung (2×2 → 3×3)
        const k2 = data.sub.get(idx)!.length;
        data.sub.set(idx, new Uint16Array(k2 === 4 ? 9 : 4).fill(data.c1[idx]));
      }
      expect(targetState(data, idx)).toBe('shape');
      for (let q = 0; q < cellPieceCount(data, idx); q++) expect(deviationForPiece(data, palette, idx, q, formula)).toBeNull();
      expect(Number.isNaN(deviationMap(layout, data, palette, formula)[idx])).toBe(true);
      const s = deviationSummary(data, palette, formula);
      expect(s.missing.shape).toBe(cellPieceCount(data, idx));
      expect(s.measured).toBe(sum0.measured - d0.length);
      // Rückgängig (Momentaufnahme zurückschreiben)
      restoreCell(data, idx, snap);
      expect(targetState(data, idx)).toBe('ok');
      expect(Array.from({ length: d0.length }, (_, q) => deviationForPiece(data, palette, idx, q, formula))).toEqual(d0);
    }
    expect(deviationSummary(data, palette, formula)).toEqual(sum0);
  });

  it('dieselbe Form von Hand erneut gewählt (Kantenschnitt mit gleichem Winkel und Versatz): Fotoreferenz gilt wieder', () => {
    const { data, palette, layout, formula } = fresh('portrait');
    let done = 0;
    for (let idx = 0; idx < data.kind.length && done < 25; idx++) {
      if (data.kind[idx] !== CellKind.LINE) continue;
      const { row, col } = rc(data, idx);
      const l = data.line.get(idx)!;
      const angleDeg = Math.round((Math.atan2(l[1], l[0]) * 180) / Math.PI);
      const offsetMm = l[2];
      const colors = [data.c1[idx], data.c2[idx]];
      const d0 = [0, 1].map((q) => deviationForPiece(data, palette, idx, q, formula));
      expect(setCellKind(layout, data, row, col, { kind: CellKind.FULL }, 0.1)).toBeNull();
      expect(targetState(data, idx)).toBe('shape');
      expect(setCellKind(layout, data, row, col, { kind: CellKind.LINE, angleDeg, offsetMm }, 0.1)).toBeNull();
      expect(targetState(data, idx)).toBe('ok');
      setPieceColor(data, idx, 0, colors[0]);
      setPieceColor(data, idx, 1, colors[1]);
      expect([0, 1].map((q) => deviationForPiece(data, palette, idx, q, formula))).toEqual(d0);
      // ein anderer Winkel ist eine andere Form
      expect(setCellKind(layout, data, row, col, { kind: CellKind.LINE, angleDeg: (angleDeg + 90) % 180, offsetMm: 0 }, 0.1)).toBeNull();
      expect(targetState(data, idx)).toBe('shape');
      done++;
    }
    expect(done).toBeGreaterThan(5);
  });

  it('Freiformstein: keine Fotoreferenz (Grund „free“); Zusammenfassung zählt seine Teile', () => {
    const { data, palette, layout, formula } = fresh('portrait');
    const sum0 = deviationSummary(data, palette, formula);
    const idx = firstCell(data, (i) => data.kind[i] === CellKind.FULL && i > data.cols * 8 + 3);
    const { row, col } = rc(data, idx);
    const r = cellRect(layout, row, col);
    const polys = freePreset('trapezoid', r.w, r.h, layout.joint)!;
    expect(setFreePieces(layout, data, row, col, polys.map((poly, i) => ({ poly, color: i })), 0.1).ok).toBe(true);
    expect(targetState(data, idx)).toBe('free');
    for (let q = 0; q < polys.length; q++) {
      expect(pieceTarget(data, idx, q)).toBeNull();
      expect(deviationForPiece(data, palette, idx, q, formula)).toBeNull();
    }
    expect(Number.isNaN(deviationMap(layout, data, palette, formula)[idx])).toBe(true);
    const s = deviationSummary(data, palette, formula);
    expect(s.missing).toEqual({ legacy: 0, free: polys.length, shape: 0, color: 0 });
    expect(s.measured).toBe(sum0.measured - 1);
    expect(s.pieces).toBe(sum0.pieces - 1 + polys.length);
    // Statistik und Abweichung zählen dieselben Steine
    expect(s.pieces).toBe(computeStats(layout, data, palette, [], { reservePct: 0, groutDepthMm: 3 }).pieces);
  });

  it('Raster ohne Fotofarben (vor dieser Funktion berechnet): keine Abweichung – Grund „legacy“', () => {
    const { data, palette, layout, formula } = fresh('portrait');
    const pieces = deviationSummary(data, palette, formula).pieces;
    delete data.targets;
    expect(hasPhotoTargets(data)).toBe(false);
    expect(targetState(data, 0)).toBe('legacy');
    expect(pieceTarget(data, 0, 0)).toBeNull();
    expect(deviationForPiece(data, palette, 0, 0, formula)).toBeNull();
    expect(nearestColorForPiece(data, palette, 0, 0, formula)).toBeNull();
    const map = deviationMap(layout, data, palette, formula);
    expect(map.every((v) => Number.isNaN(v))).toBe(true);
    const s = deviationSummary(data, palette, formula);
    expect(s).toEqual({ pieces, measured: 0, missing: { legacy: pieces, free: 0, shape: 0, color: 0 }, mean: 0, max: 0, p95: 0, bins: [0, 0, 0, 0], over5: 0, over10: 0 });
    expect(topDeviations(layout, data, palette, formula, 50)).toEqual([]);
    expect(deviationByColor(data, palette, formula).every((m) => m.pieces === 0 && m.mean === 0 && m.max === 0)).toBe(true);
  });

  it('Fotofarben eines anderen Rasters (falsche Zellenzahl) werden nicht benutzt', () => {
    const a = fresh('portrait');
    const b = fresh('animal');
    a.data.targets = b.data.targets;
    expect(hasPhotoTargets(a.data)).toBe(false);
    expect(targetState(a.data, 0)).toBe('legacy');
    expect(deviationSummary(a.data, a.palette, a.formula).measured).toBe(0);
  });

  it('in sich unstimmige Fotofarben (Feldlängen passen nicht zur Zellart) werden nicht benutzt', () => {
    const variants: ((t: PhotoTargets) => Partial<PhotoTargets>)[] = [
      (t) => ({ lab2: t.lab2.subarray(3) }),
      (t) => ({ line: t.line.subarray(0, t.line.length - 3) }),
      (t) => ({ subLen: t.subLen.subarray(1) }),
      (t) => ({ subLab: t.subLab.subarray(3) }),
      (t) => ({ subLen: t.subLen.map(() => 0) }),
      (t) => {
        const kind = t.kind.slice();
        kind[3] = CellKind.FREE;
        return { kind };
      },
    ];
    for (const v of variants) {
      const { data, palette, layout, formula } = fresh('portrait');
      data.targets = { ...data.targets!, ...v(data.targets!) };
      expect(hasPhotoTargets(data)).toBe(false);
      expect(targetState(data, 0)).toBe('legacy');
      expect(pieceTarget(data, 0, 0)).toBeNull();
      const s = deviationSummary(data, palette, formula);
      expect(s.measured).toBe(0);
      expect(s.missing.legacy).toBe(s.pieces);
      expect(deviationMap(layout, data, palette, formula).every((x) => Number.isNaN(x))).toBe(true);
    }
  });

  it('zufällige Änderungen (Farbe, Form, Freiform, Rückgängig): Karte, Zusammenfassung und Liste = unabhängige Nachrechnung', () => {
    const { data, palette, layout, formula } = fresh('city/detail-k3');
    const rnd = rng(20261110);
    const N = data.kind.length;
    const pick = () => Math.floor(rnd() * N);
    const undo: { idx: number; snap: ReturnType<typeof snapshotCell> }[] = [];
    for (let step = 0; step < 400; step++) {
      const idx = pick();
      const { row, col } = rc(data, idx);
      const r = rnd();
      if (r < 0.35) {
        const n = cellPieceCount(data, idx);
        if (n > 0) setPieceColor(data, idx, Math.floor(rnd() * n), Math.floor(rnd() * palette.length));
      } else if (r < 0.75) {
        undo.push({ idx, snap: snapshotCell(data, idx) });
        const kinds = [
          { kind: CellKind.FULL },
          { kind: CellKind.DIAG_A },
          { kind: CellKind.DIAG_B },
          { kind: CellKind.SUB, k: 2 as const },
          { kind: CellKind.SUB, k: 3 as const },
          { kind: CellKind.LINE, angleDeg: Math.floor(rnd() * 12) * 15, offsetMm: Math.round((rnd() * 4 - 2) * 2) / 2 },
        ];
        setCellKind(layout, data, row, col, kinds[Math.floor(rnd() * kinds.length)], 0.5);
      } else if (r < 0.85) {
        undo.push({ idx, snap: snapshotCell(data, idx) });
        const cr = cellRect(layout, row, col);
        const polys = freePreset(rnd() < 0.5 ? 'rhombus' : 'half', cr.w, cr.h, layout.joint);
        if (polys) setFreePieces(layout, data, row, col, polys.map((poly) => ({ poly, color: Math.floor(rnd() * palette.length) })), 0.1);
      } else if (undo.length) {
        const u = undo.splice(Math.floor(rnd() * undo.length), 1)[0];
        restoreCell(data, u.idx, u.snap);
      }
    }
    const ref = refPieces(data, palette, formula);
    const states = { ok: 0, legacy: 0, free: 0, shape: 0 };
    for (const p of ref) states[p.state]++;
    // der Test deckt alle Fälle ab
    expect(states.ok).toBeGreaterThan(10000);
    expect(states.shape).toBeGreaterThan(50);
    expect(states.free).toBeGreaterThan(10);

    const map = deviationMap(layout, data, palette, formula);
    const cellMax = new Map<number, number>();
    for (const p of ref) {
      expect(deviationForPiece(data, palette, p.idx, p.piece, formula)).toBe(p.d);
      expect(targetState(data, p.idx)).toBe(p.state);
      if (p.d !== null) cellMax.set(p.idx, Math.max(cellMax.get(p.idx) ?? 0, p.d));
    }
    for (let i = 0; i < N; i++) {
      const m = cellMax.get(i);
      if (m === undefined) expect(Number.isNaN(map[i])).toBe(true);
      else expect(map[i]).toBe(Math.fround(m));
    }
    const s = deviationSummary(data, palette, formula);
    const measured = ref.filter((p) => p.d !== null);
    expect(s.pieces).toBe(ref.length);
    expect(s.measured).toBe(measured.length);
    expect(s.missing).toEqual({ legacy: 0, free: states.free, shape: states.shape, color: 0 });
    expect(s.max).toBe(Math.max(...measured.map((p) => p.d!)));
    let acc = 0;
    for (const p of measured) acc += p.d!;
    expect(s.mean).toBe(acc / measured.length);
    expect(s.pieces).toBe(computeStats(layout, data, palette, [], { reservePct: 0, groutDepthMm: 3 }).pieces);

    // Teilbereiche, die nicht am Zeilenanfang beginnen
    for (let k = 0; k < 12; k++) {
      const r0 = Math.floor(rnd() * data.rows);
      const c0 = Math.floor(rnd() * data.cols);
      const rg: Range = { r0, r1: Math.min(data.rows, r0 + 1 + Math.floor(rnd() * 40)), c0, c1: Math.min(data.cols, c0 + 1 + Math.floor(rnd() * 60)) };
      const part = refPieces(data, palette, formula, rg);
      const pm = part.filter((p) => p.d !== null);
      const ps = deviationSummary(data, palette, formula, rg);
      expect(ps.pieces).toBe(part.length);
      expect(ps.measured).toBe(pm.length);
      expect(ps.max).toBe(pm.length ? Math.max(...pm.map((p) => p.d!)) : 0);
      const sorted = pm.slice().sort((a, b) => b.d! - a.d! || a.idx - b.idx || a.piece - b.piece);
      expect(topDeviations(layout, data, palette, formula, 10, rg).map((p) => [p.idx, p.piece, p.deltaE])).toEqual(sorted.slice(0, 10).map((p) => [p.idx, p.piece, p.d]));
    }
  });
});

// ================================================================ 4. Speichern, Laden, Übertragen

const TARGET_FIELDS = ['tKind', 'tLab1', 'tLab2', 'tLine', 'tSubLen', 'tSubLab'] as const;

function expectSameTargets(a: PhotoTargets | undefined, b: PhotoTargets | undefined) {
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  for (const f of ['kind', 'lab1', 'lab2', 'line', 'subLen', 'subLab'] as const) {
    expect(a![f].constructor).toBe(b![f].constructor);
    expect(a![f].length).toBe(b![f].length);
    expect(Buffer.from(a![f].buffer, a![f].byteOffset, a![f].byteLength).equals(Buffer.from(b![f].buffer, b![f].byteOffset, b![f].byteLength))).toBe(true);
  }
}

describe('Fotofarben speichern, laden und übertragen', () => {
  it('packMosaic/unpackMosaic: Fotofarben Byte für Byte, Abweichung danach identisch', () => {
    for (const key of ['portrait', 'city/detail-k3', 'animal/no-shapes']) {
      const { res, layout, formula } = computed(key);
      const packed = packMosaic(res.data);
      for (const f of TARGET_FIELDS) expect(packed[f]).toBeInstanceOf(Uint8Array); // Projektdatei liest unbekannte Felder als Uint8Array
      expect(packed.tLine!.length).toBe(packed.tLab2!.length * 4);
      expect(packed.tSubLab!.length).toBe(res.data.targets!.subLab.length * 4);
      const back = unpackMosaic(structuredClone(packed)); // wie IndexedDB: strukturierte Kopie
      expectSameTargets(back.targets, res.data.targets);
      expect(deviationSummary(back, res.palette, formula)).toEqual(deviationSummary(res.data, res.palette, formula));
      expect(Buffer.from(deviationMap(layout, back, res.palette, formula).buffer).equals(Buffer.from(deviationMap(layout, res.data, res.palette, formula).buffer))).toBe(true);
      // zweimal packen ergibt dasselbe (kein Verschleiß über viele Speichervorgänge)
      const again = packMosaic(back);
      for (const f of TARGET_FIELDS) expect(Buffer.from(again[f]!).equals(Buffer.from(packed[f]!))).toBe(true);
    }
  });

  it('nach einer manuellen Änderung gespeichert und geladen: Fotofarben unverändert, Abweichung wie im Arbeitsspeicher', () => {
    const { data, palette, layout, formula } = fresh('portrait');
    const idx = firstCell(data, (i) => data.kind[i] === CellKind.FULL && data.c1[i] !== 1);
    setPieceColor(data, idx, 0, 1);
    const { row, col } = rc(data, idx + 1);
    setCellKind(layout, data, row, col, { kind: CellKind.DIAG_B }, 0.1);
    const back = unpackMosaic(structuredClone(packMosaic(data)));
    expectSameTargets(back.targets, computed('portrait').res.data.targets);
    expect(deviationSummary(back, palette, formula)).toEqual(deviationSummary(data, palette, formula));
    expect(deviationForPiece(back, palette, idx, 0, formula)).toBe(deviationForPiece(data, palette, idx, 0, formula));
    expect(targetState(back, idx + 1)).toBe(targetState(data, idx + 1));
  });

  it('Raster ohne Fotofarben (ältere Version) lädt wie bisher – ohne Fotofarben', () => {
    const { res } = computed('portrait');
    const old = packMosaic(res.data, { targets: false });
    for (const f of TARGET_FIELDS) expect(f in old).toBe(false);
    const back = unpackMosaic(structuredClone(old));
    expect(back.targets).toBeUndefined();
    expect('targets' in back).toBe(false);
    expect(mosaicHashes(back, res.palette)).toEqual(mosaicHashes(res.data, res.palette));
    // und wird ohne Fotofarben wieder gespeichert (nichts erfunden)
    for (const f of TARGET_FIELDS) expect(f in packMosaic(back)).toBe(false);
  });

  it('unvollständige oder unstimmige Fotofarben werden verworfen, das Raster lädt trotzdem', () => {
    const { res } = computed('portrait');
    const good = packMosaic(res.data);
    const cells = good.cols * good.rows;
    expect(unpackTargets(good, cells)).toBeDefined();
    const broken: ((s: StoredMosaic) => void)[] = [
      (s) => delete s.tKind,
      (s) => delete s.tSubLab,
      (s) => (s.tLab1 = s.tLab1!.subarray(3)),
      (s) => (s.tLab2 = new Uint8Array(s.tLab2!.length + 3)),
      (s) => (s.tLine = s.tLine!.subarray(0, s.tLine!.length - 12)),
      (s) => (s.tSubLen = new Uint8Array(s.tSubLen!.length + 1)),
      (s) => (s.tSubLen = s.tSubLen!.map(() => 0)),
      (s) => (s.tSubLab = new Uint8Array(s.tSubLab!.length - 12)),
      (s) => {
        s.tKind = s.tKind!.slice();
        s.tKind[0] = CellKind.FREE; // Freiform ist nie eine Form der Berechnung
      },
      (s) => {
        s.tKind = s.tKind!.slice();
        s.tKind[7] = 9;
      },
      (s) => ((s as unknown as Record<string, unknown>).tLab1 = Array.from(s.tLab1!)),
      (s) => ((s as unknown as Record<string, unknown>).tLine = new Float32Array(s.tLine!.length / 4)),
      (s) => ((s as unknown as Record<string, unknown>).tSubLen = null),
    ];
    for (const breakIt of broken) {
      const s = { ...good };
      breakIt(s);
      expect(unpackTargets(s, cells)).toBeUndefined();
      const back = unpackMosaic(s);
      expect(back.targets).toBeUndefined();
      expect(mosaicHashes(back, res.palette)).toEqual(mosaicHashes(res.data, res.palette));
    }
    // falsche Zellenzahl
    expect(unpackTargets(good, cells + 1)).toBeUndefined();
  });

  it('Schnittgeraden/Teilsteine an ungerader Stelle im Puffer (keine Float32-Sicht möglich) werden kopiert gelesen', () => {
    const { res, formula } = computed('portrait');
    const good = packMosaic(res.data);
    const shifted = (u: Uint8Array) => {
      const buf = new Uint8Array(u.length + 1);
      buf.set(u, 1);
      return buf.subarray(1);
    };
    const s = { ...good, tLine: shifted(good.tLine!), tSubLab: shifted(good.tSubLab!) };
    expect(s.tLine.byteOffset % 4).toBe(1);
    const back = unpackMosaic(s);
    expectSameTargets(back.targets, res.data.targets);
    expect(deviationSummary(back, res.palette, formula).mean).toBe(res.diagnostics.meanDeltaE);
  });

  it('Übergabe aus dem Worker: jeder Puffer genau einmal übertragbar, Fotofarben kommen an', () => {
    const { res, formula } = computed('city/detail-k3');
    const data = cloneMosaic(res.data);
    const packed = packMosaic(data);
    const transfer = transferablesOf(packed);
    expect(new Set(transfer).size).toBe(transfer.length);
    for (const f of TARGET_FIELDS) expect(transfer.includes(packed[f]!.buffer as ArrayBuffer)).toBe(true);
    const moved = structuredClone(packed, { transfer });
    expect(packed.tLab1!.byteLength).toBe(0); // übertragen, nicht kopiert
    const back = unpackMosaic(moved);
    expectSameTargets(back.targets, res.data.targets);
    expect(deviationSummary(back, res.palette, formula)).toEqual(deviationSummary(res.data, res.palette, formula));
    // ohne Fotofarben (z. B. Statistik im Worker): nur die Rasterpuffer
    const lean = packMosaic(res.data, { targets: false });
    expect(transferablesOf(lean).length).toBe(10);
  });

  it('cloneMosaic: tiefe Kopie einschließlich der Fotofarben', () => {
    const { res } = computed('portrait');
    const copy = cloneMosaic(res.data);
    expectSameTargets(copy.targets, res.data.targets);
    expect(copy.targets!.lab1.buffer).not.toBe(res.data.targets!.lab1.buffer);
    expect(copy.targets!.subLab.buffer).not.toBe(res.data.targets!.subLab.buffer);
    copy.targets!.lab1[0] ^= 0xff;
    expect(res.data.targets!.lab1[0]).not.toBe(copy.targets!.lab1[0]);
  });

  it('Projektdatei (Export → Import): Fotofarben Byte für Byte, Abweichung identisch; ältere Datei ohne Fotofarben', async () => {
    const { res, layout, formula } = computed('portrait');
    const su = sampleSetup('portrait');
    const rec: ProjectRecord = {
      meta: { id: 'p', name: 'Porträt', createdAt: 1, updatedAt: 2, computed: true },
      settings: { ...DEFAULT_SETTINGS, shapes: { ...DEFAULT_SETTINGS.shapes }, ...su.lp },
      adjust: { ...DEFAULT_ADJUST },
      regions: [],
      palette: res.palette,
      mosaicRev: 'rev-1',
    };
    const { progress, ...mosaic } = { ...packMosaic(res.data), rev: 'rev-1' };
    const text = await (await buildProjectExport(rec, null, mosaic, progress, [])).text();
    const parsed = parseProjectFile(text);
    for (const f of TARGET_FIELDS) expect(parsed.mosaic![f]).toBeInstanceOf(Uint8Array);
    const back = unpackMosaic({ ...parsed.mosaic!, progress: parsed.progress! });
    expectSameTargets(back.targets, res.data.targets);
    expect(mosaicHashes(back, parsed.record.palette)).toEqual(mosaicHashes(res.data, res.palette));
    // die Palette übersteht JSON exakt → dieselben Zahlen wie vor dem Export
    const s = deviationSummary(back, parsed.record.palette, formula);
    expect(s.mean).toBe(res.diagnostics.meanDeltaE);
    expect(s.max).toBe(res.diagnostics.maxDeltaE);
    expect(deviationByColor(back, parsed.record.palette, formula)).toEqual(res.palette.map((p) => p.matchDeltaE));
    expect(topDeviations(layout, back, parsed.record.palette, formula, 10)).toEqual(topDeviations(layout, res.data, res.palette, formula, 10));

    // Datei einer älteren Version: keine Fotofarben-Felder
    const raw = JSON.parse(text) as { mosaic: Record<string, unknown> };
    for (const f of TARGET_FIELDS) delete raw.mosaic[f];
    const older = parseProjectFile(JSON.stringify(raw));
    const olderData = unpackMosaic({ ...older.mosaic!, progress: older.progress! });
    expect(olderData.targets).toBeUndefined();
    expect(mosaicHashes(olderData, older.record.palette)).toEqual(mosaicHashes(res.data, res.palette));
    // beschädigtes Feld in der Datei: Fotofarben weg, Projekt lädt
    const bad = JSON.parse(text) as { mosaic: Record<string, { $b64: string }> };
    bad.mosaic.tLab1 = { $b64: bad.mosaic.tLab1.$b64.slice(0, 400) };
    const badParsed = parseProjectFile(JSON.stringify(bad));
    expect(unpackMosaic({ ...badParsed.mosaic!, progress: badParsed.progress! }).targets).toBeUndefined();
  });
});

// ================================================================ 5. Vertrag für Welle 6

describe('Material.colorSource (Vertrag für „Farbe messen“)', () => {
  const base: Material = { id: 'm1', type: 'glass', manufacturer: 'Test', product: 'Glas', colorNumber: 'A1', colorName: 'Blau', hex: '#3366CC', lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 0, packageSize: '', piecesPerPack: 0 };

  it('Feld ist optional und nimmt Herkunft, Datum, Referenz und Streuung auf', () => {
    const manual: Material = { ...base, colorSource: { kind: 'manual' } };
    const dropper: Material = { ...base, colorSource: { kind: 'eyedropper' } };
    const photo: Material = { ...base, colorSource: { kind: 'photo', measuredAt: '2026-11-10T12:00:00.000Z', reference: 'white', spreadDE: 1.8 } };
    const refs: NonNullable<Material['colorSource']>['reference'][] = ['none', 'white', 'grey', undefined];
    expect([manual, dropper, photo].map((m) => m.colorSource!.kind)).toEqual(['manual', 'eyedropper', 'photo']);
    expect(refs.length).toBe(4);
    expect(base.colorSource).toBeUndefined();
    expect(structuredClone(photo)).toEqual(photo); // in IndexedDB speicherbar
  });

  it('CSV: Herkunft nur in den angehängten Herkunftsspalten (Welle 6), nicht im Feldvergleich', () => {
    const photo: Material = { ...base, colorSource: { kind: 'photo', reference: 'grey', spreadDE: 2.5 } };
    expect((MATERIAL_CSV_FIELDS as string[]).includes('colorSource')).toBe(false);
    const strip = (csv: string) => csv.split('\r\n').map((l) => l.split(';').slice(0, MATERIAL_CSV_FIELDS.length).join(';')).join('\r\n');
    expect(strip(materialsToCsv([photo], 'de'))).toBe(strip(materialsToCsv([base], 'de')));
    expect(materialsToCsv([photo], 'de')).toContain(';Foto-Messung (Näherung);;Graukarte 18 %;2,5');
    expect(changedFields(base, photo)).toEqual([]);
  });
});
