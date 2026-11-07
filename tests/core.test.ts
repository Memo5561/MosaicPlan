import { describe, expect, it } from 'vitest';
import { deltaE2000, hexToLab, labToHex, rgbToLab, NearestColorMatcher, describeColor } from '../src/core/color';
import { area, classifyShape, interiorAngles, rectPoly } from '../src/core/geometry';
import { cellId, computeAxis, computeLayout, computeSections, indexAt, parseCellId, rowLabel, sectionOfCell } from '../src/core/layout';
import { analyzeCut, cellPieces, diagA, diagB, lineSplit, subRects } from '../src/core/pieces';
import { computeStats } from '../src/core/stats';
import { CellKind, createEmptyMosaic, type PaletteColor } from '../src/core/types';
import { kmeansLab } from '../src/core/kmeans';

describe('Farbe (CIELAB / ΔE)', () => {
  it('Weiß und Schwarz', () => {
    const w = rgbToLab(255, 255, 255);
    expect(w[0]).toBeCloseTo(100, 2);
    expect(Math.abs(w[1])).toBeLessThan(0.01);
    expect(Math.abs(w[2])).toBeLessThan(0.01);
    expect(rgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 5);
  });
  it('Rundreise sRGB → Lab → sRGB', () => {
    for (const hex of ['#FF0000', '#00FF00', '#0000FF', '#123456', '#C0FFEE', '#808080']) {
      const lab = hexToLab(hex);
      expect(labToHex(lab[0], lab[1], lab[2])).toBe(hex);
    }
  });
  it('CIEDE2000 – Referenzdaten Sharma et al. (2005)', () => {
    const cases: [number, number, number, number, number, number, number][] = [
      [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
      [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
      [50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412],
      [50, -1.3802, -84.2814, 50, 0, -82.7485, 1.0],
      [50, 0, 0, 50, -1, 2, 2.3669],
      [50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792],
      [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
      [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
      [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
      [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
      [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
    ];
    for (const [l1, a1, b1, l2, a2, b2, exp] of cases) {
      expect(deltaE2000(l1, a1, b1, l2, a2, b2)).toBeCloseTo(exp, 3);
    }
  });
  it('Nächste Farbe', () => {
    const pal = ['#FFFFFF', '#000000', '#FF0000', '#0000FF'].map(hexToLab);
    const m = new NearestColorMatcher(pal, '2000');
    const red = hexToLab('#EE1111');
    expect(m.nearest(red[0], red[1], red[2])).toBe(2);
    const navy = hexToLab('#101080');
    expect(m.nearest(navy[0], navy[1], navy[2])).toBe(3);
  });
  it('Farbnamen', () => {
    expect(describeColor(hexToLab('#FFFFFF'))).toBe('Weiß');
    expect(describeColor(hexToLab('#000000'))).toBe('Schwarz');
    expect(describeColor(hexToLab('#9fc5f8'))).toBe('Hellblau');
  });
});

describe('Raster mit Fugen', () => {
  it('Beispiel aus der Aufgabenstellung: A002 liegt bei X = 6 mm (5 mm Stein + 1 mm Fuge)', () => {
    const L = computeLayout({ widthMm: 300, heightMm: 300, tileW: 5, tileH: 5, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    expect(L.colX[0]).toBe(0);
    expect(L.colX[1]).toBe(6);
    expect(cellId(L, 0, 0)).toBe('A001');
    expect(cellId(L, 0, 1)).toBe('A002');
  });

  it('Fugen werden bei der Gesamtgröße berücksichtigt (nicht n·Steinbreite)', () => {
    const ax = computeAxis(2000, 5, 1, 'whole', 2);
    // n = floor((2000+1)/6) = 333 → 333·5 + 332·1 = 1997 mm
    expect(ax.pos.length).toBe(333);
    expect(ax.used).toBeCloseTo(1997, 9);
    expect(ax.rest).toBeCloseTo(3, 9);
  });

  it('Randsteine zuschneiden füllt exakt die gewünschte Länge', () => {
    for (const [L, w, g] of [
      [2000, 5, 1],
      [1000, 8, 1.5],
      [300, 12, 3],
      [10000, 2, 0.5],
      [453, 7, 2],
      [100, 10, 0],
    ]) {
      for (const mode of ['cut-end', 'cut-both'] as const) {
        const ax = computeAxis(L, w, g, mode, 2);
        let sum = 0;
        for (let i = 0; i < ax.size.length; i++) {
          sum += ax.size[i];
          expect(ax.size[i]).toBeLessThanOrEqual(w + 1e-9);
          expect(ax.size[i]).toBeGreaterThanOrEqual(2 - 1e-9);
          if (i > 0) expect(ax.pos[i] - (ax.pos[i - 1] + ax.size[i - 1])).toBeCloseTo(g, 9);
        }
        sum += (ax.size.length - 1) * g;
        expect(sum).toBeCloseTo(ax.used, 6);
        expect(ax.used + ax.rest).toBeCloseTo(L, 6);
        if (w > 2) expect(ax.used).toBeCloseTo(L, 6);
        else expect(ax.rest).toBeLessThan(g + 2); // 2-mm-Steine mit 2 mm Mindestschnitt: Rest wird ausgewiesen
      }
    }
  });

  it('Großprojekt 200 × 100 cm, 5 mm, 1 mm Fuge', () => {
    const L = computeLayout({ widthMm: 2000, heightMm: 1000, tileW: 5, tileH: 5, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
    expect(L.cols).toBe(334);
    expect(L.rows).toBe(167);
    expect(L.finishedW).toBeCloseTo(2000, 6);
    expect(L.finishedH).toBeCloseTo(1000, 6);
  });

  it('beliebige Größen inkl. 1000 × 500 cm', () => {
    const L = computeLayout({ widthMm: 10000, heightMm: 5000, tileW: 10, tileH: 10, joint: 2, edgeMode: 'whole', minCutMm: 2 });
    expect(L.cols).toBe(833);
    expect(L.finishedW).toBeCloseTo(833 * 10 + 832 * 2, 6);
  });

  it('Zeilenbezeichnungen', () => {
    expect(rowLabel(0)).toBe('A');
    expect(rowLabel(25)).toBe('Z');
    expect(rowLabel(26)).toBe('AA');
    expect(rowLabel(701)).toBe('ZZ');
    expect(rowLabel(702)).toBe('AAA');
    const L = computeLayout({ widthMm: 5000, heightMm: 3000, tileW: 4, tileH: 4, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const ids = new Set<string>();
    for (let r = 0; r < L.rows; r += 7) for (let c = 0; c < L.cols; c += 13) ids.add(cellId(L, r, c));
    expect(ids.size).toBe(Math.ceil(L.rows / 7) * Math.ceil(L.cols / 13));
    const p = parseCellId(L, cellId(L, 599, 999));
    expect(p).toEqual({ row: 599, col: 999, piece: 0 });
  });

  it('Klick-Koordinate → Zelle', () => {
    const L = computeLayout({ widthMm: 100, heightMm: 100, tileW: 5, tileH: 5, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    expect(indexAt(L.colX, L.colW, 0, 1)).toBe(0);
    expect(indexAt(L.colX, L.colW, 6.2, 1)).toBe(1);
    expect(indexAt(L.colX, L.colW, 11.9, 1)).toBe(2);
  });

  it('Abschnitte decken jede Zelle genau einmal ab und liegen auf Rasterlinien', () => {
    const L = computeLayout({ widthMm: 2000, heightMm: 1000, tileW: 5, tileH: 5, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
    const G = computeSections(L, 503, 335);
    expect(G.scols).toBe(4);
    expect(G.srows).toBe(3);
    const cover = new Uint8Array(L.cols * L.rows);
    for (const s of G.sections) {
      expect(s.w).toBeLessThanOrEqual(503 + 1e-9);
      for (let r = s.r0; r < s.r1; r++) for (let c = s.c0; c < s.c1; c++) cover[r * L.cols + c]++;
    }
    expect(cover.every((v) => v === 1)).toBe(true);
    // benachbarte Abschnitte: genau eine Fuge Abstand
    const a1 = G.sections[0];
    const a2 = G.sections[1];
    expect(a2.x - (a1.x + a1.w)).toBeCloseTo(1, 9);
    expect(sectionOfCell(G, 0, a2.c0).id).toBe('A2');
    expect(sectionOfCell(G, G.rowStarts[1], 0).id).toBe('B1');
  });
});

describe('Steinformen und Schnittvorlagen', () => {
  const r = { x: 0, y: 0, w: 5, h: 5 };
  it('Diagonale Dreiecke mit Fuge', () => {
    for (const [p, q] of [diagA(r, 1), diagB(r, 1)]) {
      expect(p.length).toBe(3);
      expect(q.length).toBe(3);
      const leg = 5 - Math.SQRT1_2; // Fuge 1 mm senkrecht zur Diagonale
      expect(area(p)).toBeCloseTo((leg * leg) / 2, 9);
      expect(area(q)).toBeCloseTo((leg * leg) / 2, 9);
      expect(classifyShape(p)).toBe('triangle');
    }
  });
  it('Diagonale ohne Fuge halbiert exakt', () => {
    const [p, q] = diagA(r, 0);
    expect(area(p) + area(q)).toBeCloseTo(25, 9);
  });
  it('Kantenschnitt: Flächen + Fuge = Zelle', () => {
    const n = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const [p, q] = lineSplit({ x: 10, y: 20, w: 8, h: 8 }, n[0], n[1], 0.5, 0);
    expect(area(p) + area(q)).toBeCloseTo(64, 9);
    const [p1, q1] = lineSplit({ x: 0, y: 0, w: 8, h: 8 }, 1, 0, 1, 1);
    expect(classifyShape(p1)).toBe('rectangle');
    expect(area(p1)).toBeCloseTo((4 + 1 - 0.5) * 8, 9);
    expect(area(q1)).toBeCloseTo((4 - 1 - 0.5) * 8, 9);
  });
  it('k×k Unterteilung mit Fugen', () => {
    const s = subRects({ x: 0, y: 0, w: 8, h: 8 }, 2, 1);
    expect(s).toHaveLength(4);
    expect(area(s[0])).toBeCloseTo(3.5 * 3.5, 9);
    expect(s[1][0].x).toBeCloseTo(4.5, 9);
  });
  it('Formklassifizierung', () => {
    expect(classifyShape(rectPoly(0, 0, 5, 5))).toBe('square');
    expect(classifyShape(rectPoly(0, 0, 4, 8))).toBe('rectangle');
    expect(classifyShape([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 5, y: 3 }, { x: 1, y: 3 }])).toBe('trapezoid');
    expect(classifyShape([{ x: 0, y: 2 }, { x: 3, y: 0 }, { x: 6, y: 2 }, { x: 3, y: 4 }])).toBe('rhombus');
    expect(classifyShape([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 5, y: 2 }, { x: 1, y: 2 }])).toBe('parallelogram');
    expect(interiorAngles(rectPoly(0, 0, 3, 2)).every((a) => Math.abs(a - 90) < 1e-9)).toBe(true);
  });
  it('Schnittinfo: ganzer Stein → kein Schnitt', () => {
    const c = analyzeCut(rectPoly(12, 18, 5, 5), 5, 5);
    expect(c.needsCut).toBe(false);
    expect(c.yieldPerRaw).toBe(1);
    expect(c.cutLines).toHaveLength(0);
  });
  it('Schnittinfo: Randstein 2 × 5 mm aus 5 × 5 mm', () => {
    const c = analyzeCut(rectPoly(0, 0, 2, 5), 5, 5);
    expect(c.needsCut).toBe(true);
    expect(c.shape).toBe('rectangle');
    expect(c.cutLines).toHaveLength(1);
    expect(c.yieldPerRaw).toBe(2);
    expect(c.w).toBeCloseTo(2, 9);
  });
  it('Schnittinfo: Dreieck aus Diagonalschnitt – eine Schnittlinie, 2 Stück je Rohstein', () => {
    const [p] = diagA({ x: 0, y: 0, w: 5, h: 5 }, 0);
    const c = analyzeCut(p, 5, 5);
    expect(c.shape).toBe('triangle');
    expect(c.cutLines).toHaveLength(1);
    expect(c.yieldPerRaw).toBe(2);
    expect(c.edges.sort((a, b) => a - b)[2]).toBeCloseTo(Math.hypot(5, 5), 9);
  });
  it('Schnittinfo: Teil größer als Rohstein → passt nicht', () => {
    const c = analyzeCut(rectPoly(0, 0, 10, 10), 8, 8);
    expect(c.fits).toBe(false);
  });
});

describe('Stückzahlen und Flächen', () => {
  it('Steinfläche + Fugenfläche = Gesamtfläche; jeder Stein genau einmal', () => {
    const L = computeLayout({ widthMm: 203, heightMm: 151, tileW: 6, tileH: 4, joint: 1.5, edgeMode: 'cut-end', minCutMm: 1.5 });
    const d = createEmptyMosaic(L.cols, L.rows);
    // gemischte Zellarten
    for (let i = 0; i < L.cols * L.rows; i++) {
      const m = i % 5;
      if (m === 1) {
        d.kind[i] = CellKind.DIAG_A;
        d.c2[i] = 1;
      } else if (m === 2) {
        d.kind[i] = CellKind.DIAG_B;
        d.c2[i] = 2;
      } else if (m === 3) {
        d.kind[i] = CellKind.SUB;
        d.sub.set(i, new Uint16Array([0, 1, 2, 0]));
      } else if (m === 4) {
        d.kind[i] = CellKind.LINE;
        d.line.set(i, new Float32Array([Math.cos(0.3), Math.sin(0.3), 0.4]));
        d.c2[i] = 1;
      }
    }
    const pal: PaletteColor[] = ['#FFFFFF', '#888888', '#000000'].map((hex, i) => ({ code: i + 1, hex, name: hex, lab: hexToLab(hex) }));
    const s = computeStats(L, d, pal, [], { reservePct: 10, groutDepthMm: 3 });
    // manuell nachzählen
    let pieces = 0;
    let stone = 0;
    for (let r = 0; r < L.rows; r++)
      for (let c = 0; c < L.cols; c++) {
        const ps = cellPieces(L, d, r, c);
        pieces += ps.length;
        for (const p of ps) stone += area(p.poly);
      }
    expect(s.pieces).toBe(pieces);
    expect(s.perColor.reduce((a, c) => a + c.pieces, 0)).toBe(pieces);
    expect(Object.values(s.perShape).reduce((a, b) => a + b, 0)).toBe(pieces);
    expect(s.perSize.reduce((a, b) => a + b.count, 0)).toBe(pieces);
    expect(s.stoneArea).toBeCloseTo(stone, 6);
    expect(s.stoneArea + s.jointArea).toBeCloseTo(203 * 151, 6);
    expect(s.gridPositions).toBe(L.cols * L.rows);
    for (const c of s.perColor) expect(c.rawWithReserve).toBeGreaterThanOrEqual(c.raw);
  });

  it('nur ganze Steine: Fugenfläche exakt', () => {
    const L = computeLayout({ widthMm: 100, heightMm: 100, tileW: 5, tileH: 5, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const d = createEmptyMosaic(L.cols, L.rows);
    const pal: PaletteColor[] = [{ code: 1, hex: '#FFFFFF', name: 'Weiß', lab: [100, 0, 0] }];
    const s = computeStats(L, d, pal, [], { reservePct: 10, groutDepthMm: 3 });
    expect(L.cols).toBe(16);
    expect(s.pieces).toBe(256);
    expect(s.cutPieces).toBe(0);
    expect(s.finishedW).toBeCloseTo(16 * 5 + 15, 9);
    expect(s.jointArea).toBeCloseTo(95 * 95 - 256 * 25, 6);
    expect(s.rawTotal).toBe(256);
    expect(s.rawWithReserveTotal).toBe(Math.ceil(256 * 1.1));
  });
});

describe('K-Means', () => {
  it('trennt klar getrennte Farbgruppen', () => {
    const pts: number[] = [];
    const cols = [
      [20, 0, 0],
      [80, 30, 30],
      [50, -40, 40],
    ];
    for (let i = 0; i < 300; i++) {
      const c = cols[i % 3];
      pts.push(c[0] + (i % 7) * 0.1, c[1] - (i % 5) * 0.1, c[2]);
    }
    const r = kmeansLab(new Float32Array(pts), new Float32Array(300).fill(1), 3);
    expect(r.centers).toHaveLength(3);
    const ls = r.centers.map((c) => Math.round(c[0] / 10) * 10).sort((a, b) => a - b);
    expect(ls).toEqual([20, 50, 80]);
  });
});
