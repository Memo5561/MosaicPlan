import { describe, expect, it } from 'vitest';
import {
  cellId,
  computeAxis,
  computeLayout,
  isLayoutError,
  jointShareOf,
  LayoutError,
  layoutCounts,
  MAX_CELLS,
  parseCellId,
  regionCellSpan,
  type EdgeMode,
  type LayoutParams,
} from '../src/core/layout';
import {
  expandFaceBox,
  FACE_GREEN_FROM,
  FACE_RED_BELOW,
  faceLight,
  regionLargeEnough,
  smallestFaceSpan,
  startsDrawing,
  subStoneSize,
  tradeoffRows,
} from '../src/ui/project/faceGuidance';
import type { Region } from '../src/core/types';
import { de } from '../src/i18n/ext/w3-face-guidance';
import { dictionaries } from '../src/i18n';

const P = (widthMm: number, heightMm: number, tile: number, joint = 1, edgeMode: EdgeMode = 'cut-end', minCutMm = 2): LayoutParams => ({ widthMm, heightMm, tileW: tile, tileH: tile, joint, edgeMode, minCutMm });
const face = (x: number, w: number, shape: Region['shape'] = 'ellipse', y = 0.2, h = 0.5): Region => ({ id: `f${x}${w}`, type: 'face', shape, x, y, w, h });

/** Bisherige computeAxis-Implementierung (vor w3-face-guidance) als Referenz für Bitgleichheit */
function oldAxis(L: number, w: number, g: number, mode: EdgeMode, minCut: number) {
  const pitch = w + g;
  let n = Math.floor((L + g) / pitch + 1e-9);
  const sizes: number[] = [];
  if (n < 1) {
    if (mode !== 'whole' && L >= minCut) sizes.push(L);
    else throw new Error('klein');
  } else {
    const r = L - (n * w + (n - 1) * g);
    if (mode === 'whole' || r <= 1e-6) {
      for (let i = 0; i < n; i++) sizes.push(w);
    } else if (mode === 'cut-end') {
      const c = r - g;
      if (c >= minCut - 1e-9) {
        for (let i = 0; i < n; i++) sizes.push(w);
        sizes.push(c);
      } else {
        const c2 = (w + c) / 2;
        if (n >= 1 && c2 >= minCut - 1e-9) {
          for (let i = 0; i < n - 1; i++) sizes.push(w);
          sizes.push(c2, c2);
        } else for (let i = 0; i < n; i++) sizes.push(w);
      }
    } else {
      let full = n - 1;
      let c = (L - full * w - (full + 1) * g) / 2;
      while (c < minCut - 1e-9 && full > 0) {
        full -= 1;
        c = (L - full * w - (full + 1) * g) / 2;
      }
      if (c >= minCut - 1e-9 && c <= w + 1e-9) {
        sizes.push(c);
        for (let i = 0; i < full; i++) sizes.push(w);
        sizes.push(c);
      } else for (let i = 0; i < n; i++) sizes.push(w);
    }
  }
  n = sizes.length;
  const pos = new Float64Array(n);
  const size = new Float64Array(n);
  let x = 0;
  let cutCount = 0;
  for (let i = 0; i < n; i++) {
    pos[i] = x;
    size[i] = sizes[i];
    if (Math.abs(sizes[i] - w) > 1e-9) cutCount++;
    x += sizes[i] + g;
  }
  const used = pos[n - 1] + size[n - 1];
  return { pos, size, used, rest: Math.max(0, L - used), cutCount };
}

describe('regionCellSpan (Steine über einen Bereich, exakt aus dem Raster)', () => {
  it('Standardprojekt 300 × 400 mm, 8-mm-Steine, 1 mm Fuge, Gesicht w = 0,46 → 15 Steine quer', () => {
    const L = computeLayout(P(300, 400, 8));
    expect(L.cols).toBe(34);
    for (const shape of ['ellipse', 'rect'] as const) {
      const s = regionCellSpan(L, face(0.27, 0.46, shape));
      expect(s.cols).toBe(15);
      expect(s.mmW).toBeCloseTo(0.46 * 300, 9);
    }
  });
  it('400 mm Breite mit 5-mm-Steinen → 31 Steine quer', () => {
    const L = computeLayout(P(400, 400, 5));
    expect(regionCellSpan(L, face(0.27, 0.46)).cols).toBe(31);
    expect(regionCellSpan(L, face(0.27, 0.46, 'rect')).cols).toBe(31);
  });
  it('zählt genau die Zellen, deren Mitte im Rechteck liegt (Brute Force)', () => {
    const L = computeLayout(P(237, 181, 7, 1.5, 'cut-both'));
    for (const [x, w, y, h] of [
      [0, 1, 0, 1],
      [0.1, 0.33, 0.4, 0.21],
      [0.5, 0.01, 0.5, 0.01],
      [-0.2, 0.5, 0.9, 0.4],
    ]) {
      const s = regionCellSpan(L, { shape: 'rect', x, y, w, h });
      let cols = 0;
      for (let c = 0; c < L.cols; c++) {
        const m = L.colX[c] + L.colW[c] / 2;
        if (m >= Math.max(0, x) * L.finishedW && m <= Math.min(1, x + w) * L.finishedW) cols++;
      }
      let rows = 0;
      for (let r = 0; r < L.rows; r++) {
        const m = L.rowY[r] + L.rowH[r] / 2;
        if (m >= Math.max(0, y) * L.finishedH && m <= Math.min(1, y + h) * L.finishedH) rows++;
      }
      expect([s.cols, s.rows]).toEqual([cols, rows]);
    }
  });
  it('Ellipse: Zellen der Rasterzeile durch die Mitte, deren Mitte in der Ellipse liegt (Brute Force)', () => {
    const L = computeLayout(P(300, 400, 8));
    const r = face(0.31, 0.37, 'ellipse', 0.12, 0.29);
    const ecx = (r.x + r.w / 2) * L.finishedW;
    const ecy = (r.y + r.h / 2) * L.finishedH;
    let row = 0;
    for (let i = 1; i < L.rows; i++) if (Math.abs(L.rowY[i] + L.rowH[i] / 2 - ecy) < Math.abs(L.rowY[row] + L.rowH[row] / 2 - ecy)) row = i;
    const cy = L.rowY[row] + L.rowH[row] / 2;
    let cols = 0;
    for (let c = 0; c < L.cols; c++) {
      const dx = (L.colX[c] + L.colW[c] / 2 - ecx) / ((r.w * L.finishedW) / 2);
      const dy = (cy - ecy) / ((r.h * L.finishedH) / 2);
      if (dx * dx + dy * dy <= 1) cols++;
    }
    expect(regionCellSpan(L, r).cols).toBe(cols);
    expect(cols).toBeGreaterThan(10);
  });
  it('leere oder entartete Bereiche → 0, ohne Fehler', () => {
    const L = computeLayout(P(100, 100, 5));
    expect(regionCellSpan(L, { shape: 'ellipse', x: 0.5, y: 0.5, w: 0, h: 0.2 }).cols).toBe(0);
    expect(regionCellSpan(L, { shape: 'rect', x: 2, y: 2, w: 0.2, h: 0.2 })).toMatchObject({ cols: 0, rows: 0, mmW: 0, mmH: 0 });
  });
});

describe('LayoutError (übersetzbare Rasterfehler)', () => {
  const codeOf = (p: LayoutParams) => {
    try {
      computeLayout(p);
      return null;
    } catch (e) {
      expect(isLayoutError(e)).toBe(true);
      expect(e).toBeInstanceOf(LayoutError);
      return { code: (e as LayoutError).code, params: (e as LayoutError).params, message: (e as Error).message };
    }
  };
  it('ungültige Maße', () => {
    expect(codeOf(P(0, 100, 5))?.code).toBe('invalidDims');
    expect(codeOf(P(100, 100, 0))?.code).toBe('invalidDims');
    expect(codeOf(P(100, 100, 5, -1))?.code).toBe('invalidDims');
    expect(codeOf(P(NaN, 100, 5))?.code).toBe('invalidDims');
    expect(codeOf(P(Infinity, 100, 5))?.code).toBe('invalidDims');
    expect(codeOf(P(100, 100, 5, NaN))?.code).toBe('invalidDims');
    expect(codeOf(P(0, 100, 5))?.message).toBe('Ungültige Maße.');
  });
  it('kleiner als ein Stein: Achse, Länge, Steinmaß und Modus als Parameter', () => {
    const e = codeOf(P(1, 400, 8));
    expect(e?.code).toBe('smallerThanTile');
    expect(e?.params).toMatchObject({ axis: 'x', length: 1, tile: 8, minCut: 2, mode: 'cut-end' });
    expect(e?.message).toBe('Die Projektgröße ist kleiner als ein einzelner Stein.');
    const h = codeOf({ ...P(300, 6, 8), edgeMode: 'whole' });
    expect(h?.code).toBe('smallerThanTile');
    expect(h?.params).toMatchObject({ axis: 'y', length: 6, tile: 8, mode: 'whole' });
    // mit Zuschnitt reicht die kleinste Randsteinbreite
    expect(codeOf(P(6, 400, 8))).toBeNull();
  });
  it('zu viele Rasterpositionen – geprüft, bevor Arrays angelegt werden (auch bei absurden Maßen)', () => {
    const e = codeOf(P(100_000, 100_000, 10, 1, 'whole'));
    expect(e?.code).toBe('tooManyCells');
    expect(e?.params).toMatchObject({ cells: 9091 * 9091, max: MAX_CELLS, cols: 9091, rows: 9091 });
    expect(e?.message).toContain('unterstützt werden höchstens 40.000.000');
    const t0 = Date.now();
    expect(codeOf(P(1e12, 100, 5))?.code).toBe('tooManyCells');
    expect(() => computeAxis(1e12, 5, 1, 'cut-end', 2)).toThrow(LayoutError);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it('layoutCounts = computeLayout (ohne Arrays)', () => {
    for (const p of [P(300, 400, 8), P(401, 333, 5, 1.5, 'cut-both'), P(100, 100, 3, 0, 'whole'), P(6, 6, 8)]) {
      const L = computeLayout(p);
      expect(layoutCounts(p)).toEqual({ cols: L.cols, rows: L.rows });
    }
  });
});

describe('computeAxis nach dem Umbau bitgleich zur bisherigen Implementierung', () => {
  it('5000 zufällige Achsen in allen Randmodi', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let checked = 0;
    for (let i = 0; i < 5000; i++) {
      const w = 0.5 + Math.round(rnd() * 240) / 20;
      const g = Math.round(rnd() * 8) / 4;
      const L = Math.round(rnd() * 30000) / 10 + 0.1;
      const mode = (['whole', 'cut-end', 'cut-both'] as const)[i % 3];
      const minCut = Math.round(rnd() * 40) / 10;
      let a: ReturnType<typeof oldAxis> | null = null;
      try {
        a = oldAxis(L, w, g, mode, minCut);
      } catch {
        a = null;
      }
      if (!a) {
        expect(() => computeAxis(L, w, g, mode, minCut)).toThrow(LayoutError);
        continue;
      }
      const b = computeAxis(L, w, g, mode, minCut);
      expect(Array.from(b.pos)).toEqual(Array.from(a.pos));
      expect(Array.from(b.size)).toEqual(Array.from(a.size));
      expect([b.used, b.rest, b.cutCount]).toEqual([a.used, a.rest, a.cutCount]);
      checked++;
    }
    expect(checked).toBeGreaterThan(4000);
  });
});

describe('parseCellId: Teilstück ab 1', () => {
  const L = computeLayout(P(300, 400, 8));
  it('„-0“ und „-00“ sind ungültig, „-2“ ist Teilstück 1', () => {
    expect(parseCellId(L, 'A001-0')).toBeNull();
    expect(parseCellId(L, 'A001-00')).toBeNull();
    expect(parseCellId(L, 'A001-01')).toBeNull();
    expect(parseCellId(L, 'A001-2')).toEqual({ row: 0, col: 0, piece: 1 });
    expect(parseCellId(L, 'A001-1')).toEqual({ row: 0, col: 0, piece: 0 });
    expect(parseCellId(L, 'A001')).toEqual({ row: 0, col: 0, piece: 0 });
  });
  it('außerhalb des Rasters → null; Kleinschreibung und Leerzeichen gehen', () => {
    expect(parseCellId(L, 'ZZ999')).toBeNull();
    expect(parseCellId(L, 'A000')).toBeNull();
    expect(parseCellId(L, '  b002-3 ')).toEqual({ row: 1, col: 1, piece: 2 });
    expect(parseCellId(L, cellId(L, L.rows - 1, L.cols - 1))).toEqual({ row: L.rows - 1, col: L.cols - 1, piece: 0 });
  });
});

describe('Gesichts-Ampel und Vergleichstabelle', () => {
  it('Ampel: rot < 16, gelb 16–29, grün ≥ 30', () => {
    expect([faceLight(0), faceLight(15), faceLight(16), faceLight(29), faceLight(30), faceLight(80)]).toEqual(['red', 'red', 'yellow', 'yellow', 'green', 'green']);
    expect([FACE_RED_BELOW, FACE_GREEN_FROM]).toEqual([16, 30]);
  });
  it('kleinstes Gesicht entscheidet', () => {
    const L = computeLayout(P(300, 400, 8));
    const regions: Region[] = [face(0.1, 0.5), { id: 'd', type: 'detail', shape: 'rect', x: 0, y: 0, w: 0.05, h: 0.05 }, face(0.6, 0.2)];
    const s = smallestFaceSpan(L, regions)!;
    expect(s.index).toBe(2);
    expect(s.count).toBe(2);
    expect(s.span).toEqual(regionCellSpan(L, regions[2]));
    expect(smallestFaceSpan(L, [])).toBeNull();
  });
  it('jede Zeile exakt aus computeLayout; Breite × 1,5/× 2 behält das Seitenverhältnis', () => {
    const s = { widthMm: 300, heightMm: 400, tileW: 8, tileH: 8, joint: 1, edgeMode: 'cut-end' as const, minCutMm: 2 };
    const rows = tradeoffRows(s, [face(0.27, 0.46)]);
    expect(rows.map((r) => r.key)).toEqual(['current', 'tile-4', 'tile-5', 'tile-6', 'tile-10', 'tile-12', 'width-1.5', 'width-2']);
    for (const r of rows) {
      const L = computeLayout({ ...s, tileW: r.tileW, tileH: r.tileH, widthMm: r.widthMm, heightMm: r.heightMm });
      if (!r.result.ok) throw new Error('unerwartet');
      expect([r.result.cols, r.result.rows, r.result.cells]).toEqual([L.cols, L.rows, L.cols * L.rows]);
      expect(r.result.jointShare).toBe(jointShareOf(L));
      expect(r.result.face).toEqual(regionCellSpan(L, face(0.27, 0.46)));
      expect(r.widthMm / r.heightMm).toBeCloseTo(300 / 400, 12);
    }
    expect(rows[0].isCurrent && Object.keys(rows[0].patch).length === 0).toBe(true);
    expect(rows.find((r) => r.key === 'width-2')!.patch).toEqual({ widthMm: 600, heightMm: 800 });
    expect(rows.find((r) => r.key === 'tile-5')!.patch).toEqual({ tileW: 5, tileH: 5 });
    const cur = rows[0].result;
    expect(cur.ok && cur.face?.cols).toBe(15);
    expect(cur.ok && cur.light).toBe('red');
  });
  it('Markierungen: Fugenanteil > 35 % und Steine < 4 mm; Fehler statt Zahlen bei zu großem Raster', () => {
    const rows = tradeoffRows({ widthMm: 300, heightMm: 300, tileW: 3, tileH: 3, joint: 2, edgeMode: 'whole', minCutMm: 2 }, []);
    const cur = rows[0].result;
    expect(cur.ok && cur.tiny).toBe(true);
    expect(cur.ok && cur.highJoint).toBe(true); // 1 − 9/25 = 64 %
    const big = tradeoffRows({ widthMm: 50_000, heightMm: 50_000, tileW: 8, tileH: 8, joint: 1, edgeMode: 'whole', minCutMm: 2 }, []);
    const r4 = big.find((r) => r.key === 'tile-4')!.result;
    expect(r4.ok).toBe(false);
    expect(!r4.ok && isLayoutError(r4.error) && r4.error.code).toBe('tooManyCells');
  });
  it('Teilsteingröße wie in StepShapes', () => {
    expect(subStoneSize(8, 1, 2)).toBe(3.5);
    expect(subStoneSize(8, 1, 3)).toBe(2);
    expect(subStoneSize(10, 2, 2)).toBe(4);
  });
});

describe('Bereiche zeichnen: Eingaberegeln', () => {
  it('Finger nur im Zeichenmodus, Maus (links) und Stift immer, nur primärer Zeiger', () => {
    expect(startsDrawing({ pointerType: 'touch', isPrimary: true, button: 0 }, false)).toBe(false);
    expect(startsDrawing({ pointerType: 'touch', isPrimary: true, button: 0 }, true)).toBe(true);
    expect(startsDrawing({ pointerType: 'touch', isPrimary: false, button: 0 }, true)).toBe(false);
    expect(startsDrawing({ pointerType: 'mouse', isPrimary: true, button: 0 }, false)).toBe(true);
    expect(startsDrawing({ pointerType: 'mouse', isPrimary: true, button: 2 }, true)).toBe(false);
    expect(startsDrawing({ pointerType: 'pen', isPrimary: true, button: 0 }, false)).toBe(true);
  });
  it('Mindestgröße 24 px je Seite auf dem Bildschirm', () => {
    expect(regionLargeEnough({ w: 24 / 340, h: 24 / 425 }, 340, 425)).toBe(true);
    expect(regionLargeEnough({ w: 23 / 340, h: 0.5 }, 340, 425)).toBe(false);
    expect(regionLargeEnough({ w: 0.5, h: 0.01 }, 340, 425)).toBe(false);
  });
  it('erkannte Gesichtsbox wird erweitert und bleibt im Bild', () => {
    const b = expandFaceBox({ x: 0.8, y: 0.05, w: 0.3, h: 0.4 });
    expect(b.x + b.w).toBeLessThanOrEqual(1 + 1e-12);
    expect(b.y).toBe(0);
    expect(b.y + b.h).toBeLessThanOrEqual(1 + 1e-12);
  });
});

describe('Übersetzungen', () => {
  it('jeder layout.err.*-Code hat einen Text in allen Sprachen', () => {
    for (const code of ['invalidDims', 'smallerThanTile', 'tooManyCells']) {
      expect(de[`layout.err.${code}`]).toBeTruthy();
      for (const l of ['de', 'en', 'tr'] as const) expect((dictionaries[l] as Record<string, string>)[`layout.err.${code}`]).toBeTruthy();
    }
  });
  it('dynamisch zusammengesetzte Schlüssel (Ampel, Begründung, Rasterfehler) existieren in allen Sprachen', () => {
    const keys = [
      ...['red', 'yellow', 'green'].flatMap((l) => [`w3fg.light.${l}`, `w3fg.reason.${l}`]),
      ...['invalidDims', 'smallerThanTile', 'smallerThanMinCut', 'tooManyCells'].flatMap((c) => [`layout.err.${c}`, `layout.hint.${c}`]),
      ...['invalidDims', 'smallerThanTile', 'tooManyCells'].map((c) => `w3fg.to.err.${c}`),
      'layout.dim.x',
      'layout.dim.y',
    ];
    for (const l of ['de', 'en', 'tr'] as const) for (const k of keys) expect(`${l}:${k}:${!!(dictionaries[l] as Record<string, string>)[k]}`).toBe(`${l}:${k}:true`);
  });
  it('Texte nennen Schwellen als Richtwert, nicht als feste Aussage', () => {
    expect(de['w3fg.richtwert']).toBe('Richtwert');
    expect(de['w3fg.detail.how']).toMatch(/Richtwert/);
    expect(de['w3fg.reason.red']).toMatch(/16/);
    expect(de['w3fg.reason.green']).toMatch(/30/);
  });
});
