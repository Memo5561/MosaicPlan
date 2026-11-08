/**
 * w4-laying-workbench: Werkbank „Verlegen“ – Farbe je Teilstück, offene/verlegte Steine je Farbe,
 * Verlegereihenfolge, nächster offener Stein, Rückgängig, Stein suchen.
 * Alle Zählungen müssen exakt progressOf (bzw. computeStats) entsprechen.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { setCellKind, setCellPlaced, setFreePieces, setPieceColor, setRangePlaced, togglePiecePlaced } from '../src/core/edits';
import {
  captureCells,
  captureRange,
  ColorProgressCounter,
  forEachChanged,
  fullRange,
  isRefPlaced,
  layingOrder,
  nextUnplaced,
  orderPosOf,
  packRef,
  pieceColor,
  progressByColor,
  ProgressUndo,
  rangeCounts,
  readLayingPrefs,
  refIdx,
  refPiece,
  resolveStoneId,
  restoreSnapshot,
  rowBlock,
  setPiecesPlaced,
  writeLayingPrefs,
  type PrefStore,
} from '../src/core/laying';
import { cellId, sectionsFor, type Layout, type SectionGrid } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { cellPieceCount, cellPieces, cellRect, freePreset } from '../src/core/pieces';
import { computeStats, progressOf, type Range } from '../src/core/stats';
import { CellKind, DEFAULT_SETTINGS, type MosaicData, type PaletteColor } from '../src/core/types';
import { baseParams, GOLDEN_SAMPLES, sampleSetup } from './w1-mosaic-core.fixtures';

interface Sample {
  key: string;
  layout: Layout;
  data: MosaicData;
  palette: PaletteColor[];
  sections: SectionGrid;
}

/** deterministischer Zufall */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const samples: Sample[] = [];

beforeAll(() => {
  for (const s of GOLDEN_SAMPLES) {
    const su = sampleSetup(s.key);
    const res = computeMosaic(su.img, baseParams(su));
    const data = res.data;
    // dazu einige Handänderungen, damit jede Zellart vorkommt (Dreiecke, Kantenschnitt, 2×2, 3×3, Freiform)
    const L = su.layout;
    const min = DEFAULT_SETTINGS.shapes.minPieceMm;
    const at = (f: number) => [Math.floor(L.rows * f), Math.floor(L.cols * (1 - f))] as const;
    const pc = res.palette.length;
    const [r1, c1] = at(0.1);
    setCellKind(L, data, r1, c1, { kind: CellKind.DIAG_A }, min);
    setPieceColor(data, r1 * L.cols + c1, 1, (data.c1[r1 * L.cols + c1] + 1) % pc);
    const [r2, c2] = at(0.2);
    setCellKind(L, data, r2, c2, { kind: CellKind.SUB, k: 2 }, min);
    setPieceColor(data, r2 * L.cols + c2, 3, (data.c1[r2 * L.cols + c2] + 2) % pc);
    const [r3, c3] = at(0.3);
    setCellKind(L, data, r3, c3, { kind: CellKind.SUB, k: 3 }, min);
    const [r4, c4] = at(0.4);
    setCellKind(L, data, r4, c4, { kind: CellKind.LINE, angleDeg: 30, offsetMm: 0.4 }, min);
    const [r5, c5] = at(0.6);
    const cr = cellRect(L, r5, c5);
    const fp = freePreset('rhombus', cr.w, cr.h, L.joint);
    if (fp) setFreePieces(L, data, r5, c5, fp.map((poly, i) => ({ poly, color: (i * 3) % pc })), min);
    samples.push({ key: s.key, layout: L, data, palette: res.palette, sections: sectionsFor(L, DEFAULT_SETTINGS) });
  }
}, 240_000);

/** zufälligen Fortschritt setzen: teils ganze Zellen, teils einzelne Teilstücke, ein Abschnitt halb fertig */
function randomProgress(sm: Sample, seed: number) {
  const { layout: L, data } = sm;
  const r = rng(seed);
  data.progress.fill(0);
  for (let idx = 0; idx < data.kind.length; idx++) {
    const x = r();
    if (x < 0.15) setCellPlaced(data, idx, true);
    else if (x < 0.3) {
      const n = cellPieceCount(data, idx);
      if (n > 0) togglePiecePlaced(data, idx, Math.floor(r() * n));
    }
  }
  // Abschnitt A1 zur Hälfte (obere Hälfte der Zeilen) fertig
  const a1 = sm.sections.sections[0];
  setRangePlaced(L, data, { r0: a1.r0, r1: a1.r0 + Math.floor((a1.r1 - a1.r0) / 2), c0: a1.c0, c1: a1.c1 }, true);
}

describe('pieceColor: gleiche Reihenfolge wie cellPieces', () => {
  it('für jede Zelle aller vier Testprojekte (inkl. Dreieck, Kantenschnitt, 2×2, 3×3, Freiform)', () => {
    const kinds = new Set<number>();
    for (const sm of samples) {
      const { layout: L, data } = sm;
      for (let row = 0; row < L.rows; row++)
        for (let col = 0; col < L.cols; col++) {
          const idx = row * L.cols + col;
          kinds.add(data.kind[idx]);
          const ps = cellPieces(L, data, row, col);
          expect(ps.length).toBe(cellPieceCount(data, idx));
          for (let i = 0; i < ps.length; i++) expect(pieceColor(data, idx, i)).toBe(ps[i].color);
          expect(pieceColor(data, idx, ps.length)).toBe(-1);
        }
    }
    for (const k of [CellKind.FULL, CellKind.DIAG_A, CellKind.LINE, CellKind.SUB, CellKind.FREE]) expect(kinds.has(k)).toBe(true);
  });
});

describe('progressByColor', () => {
  it('Summe je Abschnitt und gesamt = progressOf (vier Testprojekte, zufälliger Fortschritt)', () => {
    for (const [k, sm] of samples.entries()) {
      randomProgress(sm, 11 + k);
      const { layout: L, data } = sm;
      let sumPlaced = 0;
      let sumTotal = 0;
      for (const sec of sm.sections.sections) {
        const m = progressByColor(L, data, sec);
        let placed = 0;
        let total = 0;
        for (const e of m.values()) {
          expect(e.placed).toBeGreaterThanOrEqual(0);
          expect(e.placed).toBeLessThanOrEqual(e.total);
          placed += e.placed;
          total += e.total;
        }
        expect({ placed, total }).toEqual(progressOf(L, data, sec));
        expect({ placed, total }).toEqual(rangeCounts(L, data, sec));
        sumPlaced += placed;
        sumTotal += total;
      }
      expect({ placed: sumPlaced, total: sumTotal }).toEqual(progressOf(L, data));
      // ganzes Mosaik direkt
      let p = 0;
      let t = 0;
      for (const e of progressByColor(L, data).values()) {
        p += e.placed;
        t += e.total;
      }
      expect({ placed: p, total: t }).toEqual(progressOf(L, data));
    }
  });

  it('je Farbe identisch mit computeStats (Steine und verlegt) – Porträt, Abschnitt A1 und gesamt', () => {
    const sm = samples[0];
    randomProgress(sm, 99);
    for (const rg of [sm.sections.sections[0], undefined]) {
      const st = computeStats(sm.layout, sm.data, sm.palette, [], { reservePct: 0, groutDepthMm: 3 }, rg);
      const m = progressByColor(sm.layout, sm.data, rg);
      for (const cs of st.perColor) {
        const e = m.get(cs.color) ?? { placed: 0, total: 0 };
        expect([cs.color, e.total, e.placed]).toEqual([cs.color, cs.pieces, cs.placed]);
      }
    }
  });

  it('Zähler mit Nachführung = Neuaufbau nach jeder Änderung', () => {
    const sm = samples[2];
    const { layout: L, data } = sm;
    randomProgress(sm, 5);
    const sec = sm.sections.sections[1] ?? sm.sections.sections[0];
    const cnt = ColorProgressCounter.build(L, data, sec);
    const all = ColorProgressCounter.build(L, data);
    const r = rng(77);
    for (let step = 0; step < 60; step++) {
      const snap =
        step % 10 === 9
          ? captureRange(L, data, { r0: sec.r0, r1: sec.r0 + 2, c0: sec.c0, c1: sec.c1 })
          : captureCells(data, [Math.floor(r() * data.kind.length), Math.floor(r() * data.kind.length)]);
      if (snap.kind === 'range') setRangePlaced(L, data, snap.range, r() < 0.7);
      else
        for (const idx of snap.cells) {
          const n = cellPieceCount(data, idx);
          if (n) togglePiecePlaced(data, idx, Math.floor(r() * n));
        }
      forEachChanged(L, data, snap, (idx, before, now) => {
        cnt.update(data, idx, before, now);
        all.update(data, idx, before, now);
      });
      expect(cnt.counts).toEqual(progressByColor(L, data, sec));
      expect(all.totals()).toEqual(progressOf(L, data));
    }
  });
});

describe('layingOrder', () => {
  it('besucht jeden Stein des Bereichs genau einmal (beide Reihenfolgen, alle Abschnitte, vier Testprojekte)', () => {
    for (const sm of samples) {
      const { layout: L, data, palette } = sm;
      for (const sec of sm.sections.sections) {
        const total = progressOf(L, data, sec).total;
        for (const order of ['serpentine', 'color'] as const) {
          const o = layingOrder(L, data, sec, { order, colorRank: (c) => palette[c]?.code ?? 1e9 });
          expect(o.length).toBe(total);
          const seen = new Set<number>();
          for (const code of o) {
            const idx = refIdx(code);
            const row = Math.floor(idx / L.cols);
            const col = idx - row * L.cols;
            expect(row >= sec.r0 && row < sec.r1 && col >= sec.c0 && col < sec.c1).toBe(true);
            expect(refPiece(code)).toBeLessThan(cellPieceCount(data, idx));
            seen.add(code);
          }
          expect(seen.size).toBe(total);
        }
      }
    }
  });

  it('Reihe für Reihe in Schlangenlinie; Farbe für Farbe nach Farbnummer, darin dieselbe Schlangenlinie', () => {
    const sm = samples[0];
    const { layout: L, data, palette } = sm;
    const sec = sm.sections.sections[3] ?? sm.sections.sections[0];
    const ser = layingOrder(L, data, sec, { order: 'serpentine' });
    // erste Zeile links → rechts, zweite rechts → links
    const first = refIdx(ser[0]);
    expect(first).toBe(sec.r0 * L.cols + sec.c0);
    const [a, b] = rowBlock(ser, L.cols, 0);
    expect(a).toBe(0);
    const secondRowFirst = refIdx(ser[b]);
    expect(secondRowFirst).toBe((sec.r0 + 1) * L.cols + sec.c1 - 1);
    const rank = (c: number) => palette[c]?.code ?? 1e9;
    const col = layingOrder(L, data, sec, { order: 'color', colorRank: rank });
    const posInSer = new Map<number, number>();
    ser.forEach((code, i) => posInSer.set(code, i));
    for (let i = 1; i < col.length; i++) {
      const ca = pieceColor(data, refIdx(col[i - 1]), refPiece(col[i - 1]));
      const cb = pieceColor(data, refIdx(col[i]), refPiece(col[i]));
      expect(rank(ca)).toBeLessThanOrEqual(rank(cb));
      if (ca === cb) expect(posInSer.get(col[i - 1])!).toBeLessThan(posInSer.get(col[i])!);
    }
  });

  it('mit Farbfilter: nur diese Farbe, Anzahl = progressByColor', () => {
    const sm = samples[1];
    const { layout: L, data } = sm;
    const sec = sm.sections.sections[0];
    const m = progressByColor(L, data, sec);
    for (const [c, e] of m) {
      for (const order of ['serpentine', 'color'] as const) {
        const o = layingOrder(L, data, sec, { order, color: c });
        expect(o.length).toBe(e.total);
        for (const code of o) expect(pieceColor(data, refIdx(code), refPiece(code))).toBe(c);
      }
    }
  });

  it('nächster offener Stein: ab Position, mit Umlauf; -1 wenn alles verlegt', () => {
    const sm = samples[0];
    const { layout: L, data } = sm;
    const sec = sm.sections.sections[0];
    data.progress.fill(0);
    const o = layingOrder(L, data, sec, { order: 'serpentine' });
    expect(nextUnplaced(o, data, 0)).toBe(0);
    setPiecesPlaced(data, [0, 1, 2].map((p) => ({ idx: refIdx(o[p]), piece: refPiece(o[p]) })), true);
    expect(nextUnplaced(o, data, 0)).toBe(3);
    expect(nextUnplaced(o, data, 1)).toBe(3);
    // ab dem Ende: Umlauf an den Anfang
    setRangePlaced(L, data, { r0: sec.r1 - 1, r1: sec.r1, c0: sec.c0, c1: sec.c1 }, true);
    expect(nextUnplaced(o, data, o.length - 1)).toBe(3);
    expect(nextUnplaced(o, data, o.length - 1, false)).toBe(-1);
    setRangePlaced(L, data, sec, true);
    expect(nextUnplaced(o, data, 0)).toBe(-1);
    expect(orderPosOf(o, refIdx(o[5]), refPiece(o[5]))).toBe(5);
    expect(isRefPlaced(data, o[5])).toBe(true);
  });

  it('Reihe fertig (Block einer Zeile): genau die Steine dieser Zeile im Abschnitt', () => {
    const sm = samples[0];
    const { layout: L, data } = sm;
    const sec = sm.sections.sections[0];
    data.progress.fill(0);
    const o = layingOrder(L, data, sec, { order: 'serpentine' });
    const [a, b] = rowBlock(o, L.cols, 7);
    const row = Math.floor(refIdx(o[7]) / L.cols);
    expect(b - a).toBe(progressOf(L, data, { r0: row, r1: row + 1, c0: sec.c0, c1: sec.c1 }).total);
    const refs = Array.from(o.subarray(a, b), (code) => ({ idx: refIdx(code), piece: refPiece(code) }));
    expect(setPiecesPlaced(data, refs, true)).toBe(b - a);
    expect(progressOf(L, data, sec).placed).toBe(b - a);
    expect(progressOf(L, data, { r0: row, r1: row + 1, c0: sec.c0, c1: sec.c1 })).toEqual({ placed: b - a, total: b - a });
  });
});

describe('Ändern und Rückgängig (nur Verlegefortschritt)', () => {
  it('setPiecesPlaced setzt, schaltet nicht um, überspringt ungültige Teilstücke', () => {
    const sm = samples[3];
    const { data } = sm;
    data.progress.fill(0);
    const refs = [
      { idx: 5, piece: 0 },
      { idx: 5, piece: 0 },
      { idx: 6, piece: 0 },
      { idx: 7, piece: 9 },
    ];
    expect(setPiecesPlaced(data, refs, true)).toBe(2);
    expect(setPiecesPlaced(data, refs, true)).toBe(0);
    expect(data.progress[5] & 1).toBe(1);
    expect(data.progress[7]).toBe(0);
    expect(setPiecesPlaced(data, refs, false)).toBe(2);
    expect(data.progress[5]).toBe(0);
  });

  it('Rückgängig stellt die exakten Zahlen wieder her – auch für teilweise verlegte Abschnitte', () => {
    for (const [k, sm] of samples.entries()) {
      const { layout: L, data } = sm;
      randomProgress(sm, 300 + k);
      const original = data.progress.slice();
      const perSecBefore = sm.sections.sections.map((s) => progressOf(L, data, s));
      const undo = new ProgressUndo<string>(50);
      const r = rng(1234 + k);
      for (let step = 0; step < 40; step++) {
        const sec = sm.sections.sections[Math.floor(r() * sm.sections.sections.length)];
        const what = r();
        if (what < 0.25) {
          // „Abschnitt fertig“ bzw. „Zurücksetzen“ auf einem (teilweise) verlegten Abschnitt
          const snap = captureRange(L, data, sec);
          setRangePlaced(L, data, sec, r() < 0.6);
          undo.push(snap, 'section');
        } else if (what < 0.5) {
          // Rechteck
          const rg: Range = { r0: sec.r0, r1: Math.min(sec.r1, sec.r0 + 3), c0: sec.c0 + 1, c1: Math.min(sec.c1, sec.c0 + 6) };
          const snap = captureRange(L, data, rg);
          setRangePlaced(L, data, rg, true);
          undo.push(snap, 'rect');
        } else if (what < 0.75) {
          // Malstrich: einige Steine auf „verlegt“
          const refs: { idx: number; piece: number }[] = [];
          for (let j = 0; j < 8; j++) {
            const idx = (sec.r0 + Math.floor(r() * (sec.r1 - sec.r0))) * L.cols + sec.c0 + Math.floor(r() * (sec.c1 - sec.c0));
            const n = cellPieceCount(data, idx);
            if (n) refs.push({ idx, piece: Math.floor(r() * n) });
          }
          const snap = captureCells(
            data,
            refs.map((x) => x.idx),
          );
          setPiecesPlaced(data, refs, r() < 0.8);
          undo.push(snap, 'paint');
        } else {
          // Antippen
          const idx = Math.floor(r() * data.kind.length);
          const n = cellPieceCount(data, idx);
          if (!n) continue;
          const snap = captureCells(data, [idx]);
          togglePiecePlaced(data, idx, Math.floor(r() * n));
          undo.push(snap, 'tap');
        }
      }
      expect(undo.size).toBeGreaterThan(0);
      while (undo.size) restoreSnapshot(L, data, undo.pop()!.snap);
      expect(Buffer.from(data.progress.buffer).equals(Buffer.from(original.buffer))).toBe(true);
      expect(sm.sections.sections.map((s) => progressOf(L, data, s))).toEqual(perSecBefore);
    }
  });

  it('restoreSnapshot meldet genau die geänderten Zellen mit Masken davor/danach', () => {
    const sm = samples[0];
    const { layout: L, data } = sm;
    data.progress.fill(0);
    const sec = sm.sections.sections[0];
    togglePiecePlaced(data, sec.r0 * L.cols + sec.c0, 0);
    const snap = captureRange(L, data, sec);
    setRangePlaced(L, data, sec, true);
    const changed = restoreSnapshot(L, data, snap);
    const cells = (sec.r1 - sec.r0) * (sec.c1 - sec.c0);
    expect(changed.length).toBe(cells - (cellPieceCount(data, sec.r0 * L.cols + sec.c0) === 1 ? 1 : 0));
    for (const c of changed) expect(data.progress[c.idx]).toBe(c.after);
    expect(progressOf(L, data, sec).placed).toBe(1);
  });

  it('höchstens 50 Schritte und eine Speichergrenze – die ältesten fallen heraus', () => {
    const sm = samples[0];
    const u = new ProgressUndo<number>(50, 1 << 20);
    for (let i = 0; i < 70; i++) u.push(captureCells(sm.data, [i]), i);
    expect(u.size).toBe(50);
    expect(u.pop()!.meta).toBe(69);
    const big = new ProgressUndo<number>(50, 2000); // ein Eintrag = 20·40·2 + 64 Byte
    for (let i = 0; i < 5; i++) big.push(captureRange(sm.layout, sm.data, { r0: 0, r1: 20, c0: 0, c1: 40 }), i);
    expect(big.size).toBe(1);
    expect(big.pop()!.meta).toBe(4);
    expect(big.pop()).toBeUndefined();
  });
});

describe('Stein suchen', () => {
  it('gültige IDs, Teilstücke, ungültige Zusätze und unbekannte IDs', () => {
    const sm = samples[0];
    const { layout: L, data } = sm;
    const last = cellId(L, L.rows - 1, L.cols - 1);
    expect(resolveStoneId(L, data, '')).toEqual({ ok: false, reason: 'empty' });
    expect(resolveStoneId(L, data, 'ZZ9999')).toEqual({ ok: false, reason: 'unknown' });
    expect(resolveStoneId(L, data, last)).toMatchObject({ ok: true, row: L.rows - 1, col: L.cols - 1 });
    // ganze Zelle finden
    let full = -1;
    let two = -1;
    for (let i = 0; i < data.kind.length && (full < 0 || two < 0); i++) {
      if (cellPieceCount(data, i) === 1 && full < 0) full = i;
      if (cellPieceCount(data, i) === 2 && two < 0) two = i;
    }
    const id1 = cellId(L, Math.floor(full / L.cols), full % L.cols);
    expect(resolveStoneId(L, data, ` ${id1.toLowerCase()} `)).toMatchObject({ ok: true, piece: 0, pieces: 1 });
    expect(resolveStoneId(L, data, `${id1}-1`)).toMatchObject({ ok: true, piece: 0 });
    expect(resolveStoneId(L, data, `${id1}-2`)).toMatchObject({ ok: false, reason: 'piece', pieces: 1 });
    expect(resolveStoneId(L, data, `${id1}-0`)).toMatchObject({ ok: false, reason: 'piece', pieces: 1 });
    const id2 = cellId(L, Math.floor(two / L.cols), two % L.cols);
    expect(resolveStoneId(L, data, `${id2}-2`)).toMatchObject({ ok: true, piece: 1, pieces: 2 });
    expect(resolveStoneId(L, data, `${id2}-3`)).toMatchObject({ ok: false, reason: 'piece', pieces: 2 });
  });
});

describe('gemerkte Auswahl (Abschnitt, Reihenfolge)', () => {
  it('liest/schreibt je Projekt; gesperrter Speicher wirft nie', () => {
    const mem = new Map<string, string>();
    const store: PrefStore = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
    expect(readLayingPrefs('p1', store)).toEqual({ section: null, order: 'serpentine' });
    writeLayingPrefs('p1', { section: 'B2', order: 'color' }, store);
    writeLayingPrefs('p2', { section: null, order: 'serpentine' }, store);
    expect(readLayingPrefs('p1', store)).toEqual({ section: 'B2', order: 'color' });
    expect(readLayingPrefs('p2', store)).toEqual({ section: null, order: 'serpentine' });
    mem.set('mosaicplan.laying', '{kaputt');
    expect(readLayingPrefs('p1', store)).toEqual({ section: null, order: 'serpentine' });
    const throwing: PrefStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(readLayingPrefs('p1', throwing)).toEqual({ section: null, order: 'serpentine' });
    expect(() => writeLayingPrefs('p1', { section: 'A1', order: 'serpentine' }, throwing)).not.toThrow();
    expect(readLayingPrefs('p1', null)).toEqual({ section: null, order: 'serpentine' });
  });
});

describe('Hilfsfunktionen', () => {
  it('packRef/refIdx/refPiece bis 40 Mio. Zellen und 16 Teilstücke', () => {
    for (const [idx, piece] of [
      [0, 0],
      [39_999_999, 15],
      [123456, 7],
    ]) {
      const code = packRef(idx, piece);
      expect(code).toBeLessThan(2 ** 31);
      const arr = Int32Array.of(code);
      expect(refIdx(arr[0])).toBe(idx);
      expect(refPiece(arr[0])).toBe(piece);
    }
    expect(fullRange({ rows: 3, cols: 4 })).toEqual({ r0: 0, r1: 3, c0: 0, c1: 4 });
  });
});
