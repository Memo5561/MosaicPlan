/**
 * Paket w6-compare-batch: Bereichsbearbeitung (Probelauf = Ergebnis, ein Verlaufseintrag, Rückgängig exakt),
 * Abweichungskarte (Streifen deckungsgleich mit den Zellen, Farben der Legende) und PNG-Vorschau (Größengrenze, Textfeld).
 */
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyColorMap, applyReplace, applyShapeReset, colorCensus, forEachPieceColor, journalBytesUpperBound, planReplace, planShade, planShapeReset } from '../src/core/batch';
import { deviationBin, deviationMap } from '../src/core/deviation';
import { addPaletteColor, replaceColor, setCellKind, setFreePieces, setPieceColor, shadeStep } from '../src/core/edits';
import { captureCellSide, cellsEntryFrom, EditJournal, paletteIndexSig, uniqueCells } from '../src/core/journal';
import { computeLayout, type Layout, type LayoutParams } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { cellPieceCount, cellPieces } from '../src/core/pieces';
import { area } from '../src/core/geometry';
import { addPngText, isPng, pngDimensions, pngSize, readPngText, PNG_MAX_MP, PNG_MAX_MP_NATIVE, PNG_SIZES } from '../src/core/previewPng';
import { cloneMosaic, packMosaic, unpackMosaic, type StoredMosaic } from '../src/core/serialize';
import { computeStats } from '../src/core/stats';
import { CellKind, createEmptyMosaic, type MosaicData, type PaletteColor } from '../src/core/types';
import { axisBands, deviationRGBA, DEVIATION_COLORS, NO_REFERENCE_COLOR } from '../src/ui/project/PreviewOverlay';
import { baseParams, sampleSetup } from './w1-mosaic-core.fixtures';

const MIN = 1.5;

function palette(hexes: string[]): PaletteColor[] {
  let p: PaletteColor[] = [];
  for (const h of hexes) p = addPaletteColor(p, h, undefined, 'de');
  return p;
}
const PAL = palette(['#FFFFFF', '#000000', '#FF0000', '#00AA00', '#0000FF', '#FFFF00', '#888888', '#9FC5F8', '#6FA8DC', '#3D85C6', '#C9DDF5', '#1F5A96']);

/** Pseudozufall (reproduzierbar) */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Raster mit allen Zellarten (Diagonale, Kantenschnitt, k×k, Freiform), zufälligen Farben und Verlegestatus */
function mixedGrid(lp: Partial<LayoutParams> = {}, seed = 1): { layout: Layout; data: MosaicData } {
  const layout = computeLayout({ widthMm: 133, heightMm: 89, tileW: 10, tileH: 10, joint: 1, edgeMode: 'cut-both', minCutMm: 2, ...lp });
  const data = createEmptyMosaic(layout.cols, layout.rows);
  const r = rng(seed);
  const nPal = PAL.length;
  for (let row = 0; row < layout.rows; row++)
    for (let col = 0; col < layout.cols; col++) {
      const idx = row * layout.cols + col;
      data.c1[idx] = Math.floor(r() * nPal);
      data.c2[idx] = Math.floor(r() * nPal);
      const k = r();
      if (k < 0.1) setCellKind(layout, data, row, col, { kind: CellKind.DIAG_A }, MIN);
      else if (k < 0.18) setCellKind(layout, data, row, col, { kind: CellKind.DIAG_B }, MIN);
      else if (k < 0.24) setCellKind(layout, data, row, col, { kind: CellKind.LINE, angleDeg: 30, offsetMm: 0.5 }, MIN);
      else if (k < 0.3) {
        if (setCellKind(layout, data, row, col, { kind: CellKind.SUB, k: 2 }, MIN) === null) for (let q = 0; q < 4; q++) setPieceColor(data, idx, q, Math.floor(r() * nPal));
      } else if (k < 0.32) {
        const w = layout.colW[col];
        const h = layout.rowH[row];
        const v = setFreePieces(
          layout,
          data,
          row,
          col,
          [
            {
              poly: [
                { x: 0, y: 0 },
                { x: w / 2 - 0.5, y: 0 },
                { x: w / 2 - 0.5, y: h },
                { x: 0, y: h },
              ],
              color: Math.floor(r() * nPal),
            },
            {
              poly: [
                { x: w / 2 + 0.5, y: 0 },
                { x: w, y: 0 },
                { x: w, y: h },
                { x: w / 2 + 0.5, y: h },
              ],
              color: Math.floor(r() * nPal),
            },
          ],
          MIN,
        );
        expect(v.ok).toBe(true);
      }
      const n = cellPieceCount(data, idx);
      data.progress[idx] = Math.floor(r() * (1 << n));
    }
  return { layout, data };
}

/** Raster in fester Reihenfolge (Map-Reihenfolge spielt für den Inhalt keine Rolle) */
function canonical(m: StoredMosaic): string {
  const d = unpackMosaic(m);
  const sortMap = <T>(mp: Map<number, T>) => [...mp.entries()].sort((a, b) => a[0] - b[0]);
  return JSON.stringify({
    kind: [...d.kind],
    c1: [...d.c1],
    c2: [...d.c2],
    progress: [...d.progress],
    sub: sortMap(d.sub).map(([k, v]) => [k, [...v]]),
    line: sortMap(d.line).map(([k, v]) => [k, [...v]]),
    free: sortMap(d.free),
  });
}
const clone = (d: MosaicData) => cloneMosaic(d);
const stats = (layout: Layout, d: MosaicData) => computeStats(layout, d, PAL, [], { reservePct: 10, groutDepthMm: 3 });

describe('Bereichsbearbeitung: Steine wie cellPieces', () => {
  it('forEachPieceColor liefert dieselben Teilstücke und Farben wie cellPieces (alle Zellarten, auch unvollständige)', () => {
    const { layout, data } = mixedGrid();
    // unvollständige Zellen wie aus älteren Projekten: Kantenschnitt ohne Gerade, k×k ohne Farbfeld, Freiform ohne Teile
    data.kind[0] = CellKind.LINE;
    data.line.delete(0);
    data.kind[1] = CellKind.SUB;
    data.sub.delete(1);
    data.kind[2] = CellKind.FREE;
    data.free.delete(2);
    for (let row = 0; row < layout.rows; row++)
      for (let col = 0; col < layout.cols; col++) {
        const idx = row * layout.cols + col;
        const got: number[] = [];
        const n = forEachPieceColor(data, idx, (q, c) => got.push(q * 1000 + c));
        const want = cellPieces(layout, data, row, col).map((p, q) => q * 1000 + p.color);
        expect(got).toEqual(want);
        expect(n).toBe(want.length);
      }
  });

  it('Probelauf „Farbe A → B“ = angewendete Zahl = replaceColor, Ergebnis identisch; Steinzahl und Statistik-Summen unverändert', () => {
    for (const seed of [1, 2, 3]) {
      const { layout, data } = mixedGrid({}, seed);
      const ranges = [undefined, { r0: 1, r1: 5, c0: 2, c1: 9 }, { r0: 0, r1: layout.rows, c0: 3, c1: 4 }, { r0: 6, r1: 99, c0: -3, c1: 5 }];
      for (const rg of ranges) {
        for (const [from, to] of [
          [3, 7],
          [0, 1],
          [11, 2],
        ]) {
          const a = clone(data);
          const b = clone(data);
          const plan = planReplace(a, rg, from, to);
          const before = stats(layout, a);
          const applied = applyReplace(a, plan.cells, from, to);
          const ref = replaceColor(layout, b, from, to, rg && { r0: Math.max(0, rg.r0), r1: Math.min(layout.rows, rg.r1), c0: Math.max(0, rg.c0), c1: Math.min(layout.cols, rg.c1) });
          expect(applied).toBe(plan.pieces);
          expect(applied).toBe(ref);
          expect(canonical(packMosaic(a))).toBe(canonical(packMosaic(b)));
          const after = stats(layout, a);
          expect(after.pieces).toBe(before.pieces);
          expect(after.stoneArea).toBe(before.stoneArea);
          expect(after.perColor.reduce((s, c) => s + c.pieces, 0)).toBe(after.pieces);
          expect(after.perColor[from]?.pieces ?? 0).toBe((before.perColor[from]?.pieces ?? 0) - plan.pieces);
        }
      }
    }
  });

  it('gleiche Farbe A = B: nichts zu tun', () => {
    const { data } = mixedGrid();
    expect(planReplace(data, null, 4, 4)).toEqual({ cells: new Uint32Array(0), pieces: 0 });
  });

  it('colorCensus zählt jeden Stein des Bereichs genau einmal', () => {
    const { layout, data } = mixedGrid();
    const rg = { r0: 2, r1: 7, c0: 1, c1: 11 };
    const c = colorCensus(data, PAL.length, rg);
    let pieces = 0;
    for (let row = rg.r0; row < rg.r1; row++) for (let col = rg.c0; col < rg.c1; col++) pieces += cellPieces(layout, data, row, col).length;
    expect(c.pieces).toBe(pieces);
    expect(c.perColor.reduce((s, v) => s + v, 0) + c.outside).toBe(pieces);
    expect(c.cells).toBe(50);
  });
});

describe('Heller/Dunkler für einen Bereich', () => {
  it('nur Palettenfarben gleichen Farbtons (shadeStep), alle gleichzeitig; nicht passende Steine bleiben und werden gezählt', () => {
    const { layout, data } = mixedGrid({}, 5);
    for (const dir of ['lighter', 'darker'] as const) {
      const d = clone(data);
      const plan = planShade(PAL, d, null, dir, '2000');
      const census = colorCensus(d, PAL.length, null);
      expect(plan.matched + plan.unmatched).toBe(census.pieces);
      // Zuordnung = shadeStep je Farbe
      for (const r of plan.rows) {
        const s = shadeStep(PAL, r.from, dir, '2000');
        expect(r.to?.index ?? null).toBe(s?.index ?? null);
        expect(r.pieces).toBe(census.perColor[r.from]);
      }
      // die Blautöne (Testpalette) haben Abstufungen, Rot/Grün nicht
      expect(plan.rows.some((r) => r.to)).toBe(true);
      expect(plan.rows.some((r) => !r.to)).toBe(true);
      const before = clone(d);
      const n = applyColorMap(d, plan.cells, plan.map);
      expect(n).toBe(plan.matched);
      // gleichzeitig: jeder Stein hat genau map[alte Farbe] (oder die alte Farbe) – keine Kette
      for (let row = 0; row < layout.rows; row++)
        for (let col = 0; col < layout.cols; col++) {
          const was = cellPieces(layout, before, row, col).map((p) => p.color);
          const now = cellPieces(layout, d, row, col).map((p) => p.color);
          expect(now).toEqual(was.map((c) => (plan.map[c] >= 0 ? plan.map[c] : c)));
        }
      expect(stats(layout, d).pieces).toBe(stats(layout, before).pieces);
    }
  });
});

describe('Form zurücksetzen', () => {
  // w6-fix-ui: ohne Fotofarben (dieses Testraster) nimmt der ganze Stein die Farbe mit der größten Fläche der Zelle –
  // früher die des ersten Teils (willkürlich). Mit Fotofarben: tests/w6-fix-ui.test.ts.
  it('Plan zählt Zellen, Steine und verlegte Steine; danach nur ganze Steine in der Farbe mit der größten Fläche', () => {
    const { layout, data } = mixedGrid({}, 9);
    const rg = { r0: 0, r1: 6, c0: 0, c1: 13 };
    const plan = planShapeReset(layout, data, PAL, '2000', rg);
    let cells = 0;
    let pieces = 0;
    let laid = 0;
    const first: number[] = [];
    for (let row = rg.r0; row < rg.r1; row++)
      for (let col = rg.c0; col < rg.c1; col++) {
        const idx = row * layout.cols + col;
        if (data.kind[idx] === CellKind.FULL) continue;
        cells++;
        const ps = cellPieces(layout, data, row, col);
        pieces += ps.length;
        for (let q = 0; q < ps.length; q++) if ((data.progress[idx] >> q) & 1) laid++;
        // größte Fläche je Farbe (Gleichstand: die zuerst vorkommende)
        const sum = new Map<number, number>();
        for (const q of ps) sum.set(q.color, (sum.get(q.color) ?? 0) + area(q.poly));
        let best = ps[0]?.color ?? data.c1[idx];
        for (const [c, a] of sum) if (a > sum.get(best)! + 1e-9) best = c;
        first.push(best);
      }
    expect(plan.cells.length).toBe(cells);
    expect(plan.piecesBefore).toBe(pieces);
    expect(plan.laid).toBe(laid);
    expect(laid).toBeGreaterThan(0);
    expect(plan.photoCells).toBe(0);
    expect(plan.areaCells).toBe(cells);
    expect([...plan.colors]).toEqual(first);
    const totalBefore = stats(layout, data).pieces;
    expect(applyShapeReset(layout, data, plan.cells, MIN, plan.colors)).toBe(cells);
    plan.cells.forEach((idx, k) => {
      expect(data.kind[idx]).toBe(CellKind.FULL);
      expect(data.c1[idx]).toBe(first[k]);
      expect(data.progress[idx]).toBe(0);
    });
    expect(stats(layout, data).pieces).toBe(totalBefore - pieces + cells);
    expect(planShapeReset(layout, data, PAL, '2000', rg).cells.length).toBe(0);
  });
});

describe('Ein Verlaufseintrag je Aktion, Rückgängig exakt', () => {
  it('Farbe A → B, Heller und Form zurücksetzen: Rückgängig stellt das Raster genau wieder her, Wiederholen das Ergebnis', () => {
    const { layout, data } = mixedGrid({}, 11);
    const j = new EditJournal();
    const sig = paletteIndexSig(PAL);
    const original = canonical(packMosaic(data));
    const statsOrig = JSON.stringify(stats(layout, data));
    const results: string[] = [];
    for (const [i, mk] of [
      () => {
        const p = planReplace(data, { r0: 1, r1: 6, c0: 2, c1: 10 }, 7, 9);
        return { cells: p.cells, run: () => applyReplace(data, p.cells, 7, 9), colour: true };
      },
      () => {
        const p = planShade(PAL, data, null, 'lighter', '2000');
        return { cells: p.cells, run: () => applyColorMap(data, p.cells, p.map), colour: true };
      },
      () => {
        const p = planShapeReset(layout, data, PAL, '2000', { r0: 0, r1: 4, c0: 0, c1: 13 });
        return { cells: p.cells, run: () => applyShapeReset(layout, data, p.cells, MIN, p.colors), colour: false };
      },
    ].entries()) {
      const st = mk();
      const ids = uniqueCells(st.cells);
      const before = captureCellSide(data, ids);
      // Speicherbedarf vor dem Anwenden geschätzt (wie in der Oberfläche): exakt für Farbänderungen, Obergrenze für Form zurücksetzen
      const bound = journalBytesUpperBound(data, ids);
      st.run();
      const e = cellsEntryFrom(data, ids, before, { label: { text: `Schritt ${i}` }, sig });
      expect(e).not.toBeNull();
      if (st.colour) expect(e!.bytes).toBe(bound);
      else expect(e!.bytes).toBeLessThanOrEqual(bound);
      expect(j.push(e!)).toBe('pushed');
      results.push(canonical(packMosaic(data)));
    }
    expect(j.undoSize).toBe(3);
    for (let i = 2; i >= 0; i--) {
      expect(j.undo({ data, palette: PAL }).status).toBe('ok');
      expect(canonical(packMosaic(data))).toBe(i === 0 ? original : results[i - 1]);
    }
    expect(JSON.stringify(stats(layout, data))).toBe(statsOrig);
    for (let i = 0; i < 3; i++) {
      expect(j.redo({ data, palette: PAL }).status).toBe('ok');
      expect(canonical(packMosaic(data))).toBe(results[i]);
    }
  });
});

describe('Abweichungskarte über dem Viewer', () => {
  it('Streifen gleicher Zellbreite legen jede Zelle exakt auf ihre Fläche bis zur Fugenmitte (auch mit Randzuschnitt)', () => {
    for (const lp of [
      { widthMm: 133, heightMm: 89, tileW: 10, tileH: 10, joint: 1, edgeMode: 'cut-both' as const, minCutMm: 2 },
      { widthMm: 131.4, heightMm: 77.7, tileW: 8, tileH: 12, joint: 1.5, edgeMode: 'cut-end' as const, minCutMm: 2 },
      { widthMm: 120, heightMm: 60, tileW: 5, tileH: 5, joint: 0, edgeMode: 'whole' as const, minCutMm: 2 },
    ]) {
      const L = computeLayout(lp);
      for (const [pos, size, n, total] of [
        [L.colX, L.colW, L.cols, L.finishedW],
        [L.rowY, L.rowH, L.rows, L.finishedH],
      ] as const) {
        const bands = axisBands(pos, size, n, L.joint, total);
        expect(bands.length).toBeLessThanOrEqual(3);
        expect(bands[0].i0).toBe(0);
        expect(bands[bands.length - 1].i1).toBe(n);
        expect(bands[0].w0).toBe(0);
        expect(bands[bands.length - 1].w1).toBeCloseTo(total, 9);
        for (const b of bands) {
          const per = (b.w1 - b.w0) / (b.i1 - b.i0);
          for (let i = b.i0; i < b.i1; i++) {
            const lo = Math.max(0, pos[i] - L.joint / 2);
            const hi = Math.min(total, pos[i] + size[i] + L.joint / 2);
            expect(b.w0 + (i - b.i0) * per).toBeCloseTo(lo, 9);
            expect(b.w0 + (i - b.i0 + 1) * per).toBeCloseTo(hi, 9);
          }
        }
      }
    }
  });

  it('Bildpunkte nach Legendenklasse; NaN = keine Fotoreferenz', () => {
    const map = new Float32Array([0, 1.99, 2, 5, 5.01, 10, 10.5, NaN]);
    const rgba = deviationRGBA(map);
    const want = [0, 0, 1, 1, 2, 2, 3, -1];
    want.forEach((bin, i) => {
      const c = bin < 0 ? NO_REFERENCE_COLOR : DEVIATION_COLORS[bin];
      expect([...rgba.subarray(i * 4, i * 4 + 3)]).toEqual([c[0], c[1], c[2]]);
      expect(rgba[i * 4 + 3]).toBe(Math.round(c[3] * 255));
      if (bin >= 0) expect(deviationBin(map[i])).toBe(bin);
    });
  });

  it('Karte eines berechneten Mosaiks: Freiform ohne Fotoreferenz, Umfärben zur Fotofarbe senkt den Wert', () => {
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su));
    const L = su.layout;
    const data = res.data;
    const pal = res.palette;
    const m0 = deviationMap(L, data, pal, '2000');
    expect(m0.every((v) => Number.isFinite(v))).toBe(true);
    // Stein mit der größten Abweichung zur nächsten Palettenfarbe umfärben
    let worst = 0;
    for (let i = 1; i < m0.length; i++) if (data.kind[i] === CellKind.FULL && (data.kind[worst] !== CellKind.FULL || m0[i] > m0[worst])) worst = i;
    const row = Math.floor(worst / L.cols);
    const col = worst % L.cols;
    expect(data.kind[worst]).toBe(CellKind.FULL);
    // Freiform in einer anderen Zelle → NaN (keine Fotoreferenz)
    const fi = worst === 0 ? 1 : 0;
    const w = L.colW[fi % L.cols];
    const h = L.rowH[0];
    setFreePieces(
      L,
      data,
      0,
      fi % L.cols,
      [
        {
          poly: [
            { x: 0, y: 0 },
            { x: w, y: 0 },
            { x: w, y: h },
            { x: 0, y: h },
          ],
          color: 0,
        },
      ],
      1,
    );
    const m1 = deviationMap(L, data, pal, '2000');
    expect(Number.isNaN(m1[fi])).toBe(true);
    expect(m1.filter((v) => Number.isNaN(v)).length).toBe(1);
    // nächste Farbe statt der gewählten (Dithering aus: die Berechnung wählt bereits die nächste – dann gleich)
    let best = 0;
    let bd = Infinity;
    for (let c = 0; c < pal.length; c++) {
      const cur = data.c1[worst];
      data.c1[worst] = c;
      const d = deviationMap(L, data, pal, '2000')[worst];
      data.c1[worst] = cur;
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    expect(bd).toBeLessThanOrEqual(m1[worst]);
    // eine sichtbar schlechtere Farbe erhöht den Wert, die nächste senkt ihn wieder
    const far = pal.reduce((a, _, i) => (Math.abs(pal[i].lab[0] - pal[best].lab[0]) > Math.abs(pal[a].lab[0] - pal[best].lab[0]) ? i : a), 0);
    data.c1[worst] = far;
    const high = deviationMap(L, data, pal, '2000')[worst];
    data.c1[worst] = best;
    const low = deviationMap(L, data, pal, '2000')[worst];
    expect(low).toBeLessThan(high);
    expect(low).toBe(bd);
    expect(row * L.cols + col).toBe(worst);
  });
});

/** kleines echtes PNG (RGBA, ungefiltert) */
function tinyPng(w: number, h: number): Uint8Array {
  const crcT = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    out.set(
      [...type].map((c) => c.charCodeAt(0)),
      4,
    );
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = new Uint8Array(h * (1 + w * 4));
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))];
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return all;
}

describe('Vorschau als Bild (PNG)', () => {
  it('Größe: lange Seite wie gewählt, nie über der Megapixel-Grenze (40 MP, Handy 16 MP)', () => {
    const rects = [
      { w: 1000, h: 1000 },
      { w: 2000, h: 1000 },
      { w: 600, h: 4000 },
      { w: 3000, h: 2999 },
      { w: 10, h: 10000 },
    ];
    for (const r of rects)
      for (const px of PNG_SIZES)
        for (const mp of [PNG_MAX_MP, PNG_MAX_MP_NATIVE]) {
          const s = pngSize(r, px, mp);
          expect(s.width * s.height).toBeLessThanOrEqual(mp * 1e6);
          expect(Math.max(s.width, s.height)).toBeLessThanOrEqual(px);
          if (!s.clamped) expect(Math.max(s.width, s.height)).toBe(px);
          else expect(s.width * s.height).toBeGreaterThan(mp * 1e6 * 0.99);
          expect(s.width).toBe(Math.max(1, Math.round(r.w * s.pxPerMm)));
          expect(s.height).toBe(Math.max(1, Math.round(r.h * s.pxPerMm)));
        }
    expect(pngSize({ w: 1000, h: 1000 }, 8000, 40).clamped).toBe(true);
    expect(pngSize({ w: 2000, h: 1000 }, 8000, 40)).toMatchObject({ width: 8000, height: 4000, clamped: false });
  });

  it('Textfeld „Vorschau – kein maßstäblicher Plan“ (iTXt, UTF-8) mit gültiger Prüfsumme; Bild unverändert lesbar', () => {
    const png = tinyPng(7, 5);
    expect(isPng(png)).toBe(true);
    const out = addPngText(png, [
      { keyword: 'Description', text: 'Vorschau – kein maßstäblicher Plan' },
      { keyword: 'Title', text: 'Porträt Ünal' },
    ]);
    expect(pngDimensions(out)).toEqual({ width: 7, height: 5 });
    const texts = readPngText(out);
    expect(texts).toEqual([
      { keyword: 'Description', text: 'Vorschau – kein maßstäblicher Plan', crcOk: true },
      { keyword: 'Title', text: 'Porträt Ünal', crcOk: true },
    ]);
    // ohne die Textblöcke byte-gleich zum Original
    const extra = out.length - png.length;
    expect(extra).toBeGreaterThan(0);
    expect([...out.subarray(0, 33)]).toEqual([...png.subarray(0, 33)]);
    expect([...out.subarray(33 + extra)]).toEqual([...png.subarray(33)]);
    expect(addPngText(new Uint8Array([1, 2, 3]), [{ keyword: 'a', text: 'b' }])).toEqual(new Uint8Array([1, 2, 3]));
  });
});
