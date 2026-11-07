/**
 * Ende-zu-Ende-Prüfung der Berechnung mit den vier Testprojekten
 * (Porträt, Landschaft, Tier, Stadtbild).
 */
import { describe, expect, it } from 'vitest';
import { deltaE2000, isValidHex } from '../src/core/color';
import { applyAdjustments } from '../src/core/imageOps';
import { area, bbox, polygonsOverlap, type Pt } from '../src/core/geometry';
import { cellId, computeLayout, computeSections, computeSectionsByCount, type LayoutParams } from '../src/core/layout';
import { computeMosaic, isSkinLab } from '../src/core/mosaic';
import { cellPieces, cellRect } from '../src/core/pieces';
import { computeStats } from '../src/core/stats';
import { packMosaic, unpackMosaic } from '../src/core/serialize';
import { CellKind, DEFAULT_ADJUST, DEFAULT_SHAPES, type MosaicData, type PaletteColor, type Region } from '../src/core/types';
import { loadPng, prepareFor } from './helpers';

interface Case {
  name: string;
  file: string;
  lp: LayoutParams;
  colors: number;
  regions?: Region[];
}

const CASES: Case[] = [
  {
    name: 'Menschenporträt',
    file: 'public/samples/portrait.png',
    lp: { widthMm: 400, heightMm: 500, tileW: 5, tileH: 5, joint: 1, edgeMode: 'cut-end', minCutMm: 2 },
    colors: 32,
    regions: [{ id: 'f', type: 'face', shape: 'ellipse', x: 0.27, y: 0.25, w: 0.46, h: 0.5 }],
  },
  { name: 'Landschaft', file: 'public/samples/landscape.png', lp: { widthMm: 1200, heightMm: 800, tileW: 8, tileH: 8, joint: 1.5, edgeMode: 'cut-both', minCutMm: 2 }, colors: 24 },
  { name: 'Tier', file: 'public/samples/animal.png', lp: { widthMm: 500, heightMm: 500, tileW: 6, tileH: 6, joint: 1, edgeMode: 'whole', minCutMm: 2 }, colors: 24 },
  { name: 'Stadtbild', file: 'public/samples/city.png', lp: { widthMm: 2000, heightMm: 1333, tileW: 10, tileH: 10, joint: 2, edgeMode: 'cut-end', minCutMm: 2 }, colors: 16 },
];

function allColorIndices(d: MosaicData): number[] {
  const out: number[] = [];
  for (let i = 0; i < d.kind.length; i++) {
    const k = d.kind[i];
    if (k === CellKind.FULL) out.push(d.c1[i]);
    else if (k === CellKind.SUB) out.push(...d.sub.get(i)!);
    else out.push(d.c1[i], d.c2[i]);
  }
  return out;
}

function minDistBetween(a: Pt[], b: Pt[]): number {
  // minimale Distanz zwischen zwei konvexen Polygonen (Ecke–Kante)
  const segDist = (p: Pt, q1: Pt, q2: Pt) => {
    const dx = q2.x - q1.x;
    const dy = q2.y - q1.y;
    const l = dx * dx + dy * dy;
    let t = l ? ((p.x - q1.x) * dx + (p.y - q1.y) * dy) / l : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (q1.x + t * dx), p.y - (q1.y + t * dy));
  };
  let m = Infinity;
  for (const p of a) for (let i = 0; i < b.length; i++) m = Math.min(m, segDist(p, b[i], b[(i + 1) % b.length]));
  for (const p of b) for (let i = 0; i < a.length; i++) m = Math.min(m, segDist(p, a[i], a[(i + 1) % a.length]));
  return m;
}

describe.each(CASES)('Testprojekt $name', (c) => {
  const layout = computeLayout(c.lp);
  const img = applyAdjustments(prepareFor(loadPng(c.file), layout), { ...DEFAULT_ADJUST, sharpen: 20 }, c.regions ?? []);
  const res = computeMosaic(img, {
    layout,
    shapes: { ...DEFAULT_SHAPES },
    paletteMode: 'auto',
    colorCount: c.colors,
    dither: 0,
    deltaE: '2000',
    regions: c.regions ?? [],
  });
  const { data, palette } = res;

  it('Palette: eindeutige, fortlaufende Farbnummern und gültige Farbwerte', () => {
    expect(palette.length).toBeGreaterThan(1);
    expect(palette.length).toBeLessThanOrEqual(c.colors);
    expect(new Set(palette.map((p) => p.code)).size).toBe(palette.length);
    palette.forEach((p, i) => {
      expect(p.code).toBe(i + 1);
      expect(isValidHex(p.hex)).toBe(true);
    });
    const used = new Set(allColorIndices(data));
    expect(used.size).toBe(palette.length); // keine ungenutzten Farben
    for (const ci of used) expect(ci).toBeLessThan(palette.length);
  });

  it('Farbtreue: mittleres ΔE im erwarteten Bereich', () => {
    expect(res.diagnostics.meanDeltaE).toBeLessThan(8);
  });

  it('Alle Steine vorhanden, innerhalb ihrer Zelle, ohne Überlappung, Fugen eingehalten', () => {
    const ids = new Set<string>();
    let pieces = 0;
    const g = layout.joint;
    for (let row = 0; row < layout.rows; row++) {
      for (let col = 0; col < layout.cols; col++) {
        const r = cellRect(layout, row, col);
        const ps = cellPieces(layout, data, row, col);
        expect(ps.length).toBeGreaterThan(0);
        for (let i = 0; i < ps.length; i++) {
          const b = bbox(ps[i].poly);
          expect(b.minX).toBeGreaterThanOrEqual(r.x - 1e-6);
          expect(b.minY).toBeGreaterThanOrEqual(r.y - 1e-6);
          expect(b.maxX).toBeLessThanOrEqual(r.x + r.w + 1e-6);
          expect(b.maxY).toBeLessThanOrEqual(r.y + r.h + 1e-6);
          expect(area(ps[i].poly)).toBeGreaterThan(0);
          const id = cellId(layout, row, col) + (ps.length > 1 ? `-${i + 1}` : '');
          expect(ids.has(id)).toBe(false);
          ids.add(id);
          pieces++;
          for (let j = i + 1; j < ps.length; j++) {
            expect(polygonsOverlap(ps[i].poly, ps[j].poly)).toBe(false);
            expect(minDistBetween(ps[i].poly, ps[j].poly)).toBeGreaterThanOrEqual(g - 1e-6);
          }
        }
        if (col > 0) expect(layout.colX[col] - (layout.colX[col - 1] + layout.colW[col - 1])).toBeCloseTo(g, 9);
      }
    }
    const st = computeStats(layout, data, palette, [], { reservePct: 10, groutDepthMm: 3 });
    expect(st.pieces).toBe(pieces);
    expect(ids.size).toBe(pieces);
    expect(st.perColor.reduce((s, x) => s + x.pieces, 0)).toBe(pieces);
    expect(st.stoneArea + st.jointArea).toBeCloseTo(layout.finishedW * layout.finishedH, 3);
    if (c.lp.edgeMode !== 'whole') {
      expect(layout.finishedW).toBeCloseTo(c.lp.widthMm, 6);
      expect(layout.finishedH).toBeCloseTo(c.lp.heightMm, 6);
    }
  });

  it('Abschnitte passen exakt zusammen', () => {
    const G = computeSections(layout, 300, 300);
    let cells = 0;
    for (const s of G.sections) {
      cells += (s.r1 - s.r0) * (s.c1 - s.c0);
      const right = G.sections.find((x) => x.sr === s.sr && x.sc === s.sc + 1);
      if (right) expect(right.x - (s.x + s.w)).toBeCloseTo(layout.joint, 9);
      const below = G.sections.find((x) => x.sc === s.sc && x.sr === s.sr + 1);
      if (below) expect(below.y - (s.y + s.h)).toBeCloseTo(layout.joint, 9);
    }
    expect(cells).toBe(layout.cols * layout.rows);
    const total = computeStats(layout, data, palette, [], { reservePct: 10, groutDepthMm: 3 });
    const sum = G.sections.reduce((acc, s) => acc + computeStats(layout, data, palette, [], { reservePct: 10, groutDepthMm: 3 }, s).pieces, 0);
    expect(sum).toBe(total.pieces);
  });

  it('Speichern/Laden (Serialisierung) verlustfrei', () => {
    const copy = unpackMosaic(structuredClone(packMosaic(data)));
    expect(allColorIndices(copy)).toEqual(allColorIndices(data));
    expect(Array.from(copy.kind)).toEqual(Array.from(data.kind));
  });

  if (c.name === 'Menschenporträt') {
    it('Gesicht: mehrere Hauttöne in der Palette, feinere Formen im Gesichtsbereich', () => {
      const skin = palette.filter((p: PaletteColor) => isSkinLab(p.lab[0], p.lab[1], p.lab[2]));
      expect(skin.length).toBeGreaterThanOrEqual(3);
      expect(res.diagnostics.splitCells + res.diagnostics.subCells).toBeGreaterThan(0);
      // Hautfarbe auf der Wange (Bildkoordinate) gut getroffen
      const col = Math.floor(layout.cols * 0.4);
      const row = Math.floor(layout.rows * 0.5);
      const p = palette[cellPieces(layout, data, row, col)[0].color];
      const ref = [70, 18, 22];
      expect(deltaE2000(p.lab[0], p.lab[1], p.lab[2], ref[0], ref[1], ref[2])).toBeLessThan(15);
    });
  }
});

describe('Großformat', () => {
  it('200 × 100 cm, 5 mm, 1 mm Fuge mit Formen: 55.778 Positionen', () => {
    const layout = computeLayout({ widthMm: 2000, heightMm: 1000, tileW: 5, tileH: 5, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
    expect(layout.cols * layout.rows).toBe(334 * 167);
    const img = prepareFor(loadPng('public/samples/landscape.png'), layout);
    const res = computeMosaic(img, { layout, shapes: DEFAULT_SHAPES, paletteMode: 'auto', colorCount: 48, dither: 0.3, deltaE: '2000', regions: [] });
    const st = computeStats(layout, res.data, res.palette, [], { reservePct: 10, groutDepthMm: 3 });
    expect(st.gridPositions).toBe(55778);
    expect(st.pieces).toBeGreaterThanOrEqual(55778);
    // max. 50 × 50 cm: 83 Spalten (497 mm) je Abschnitt → 5 × 3 Abschnitte
    const G = computeSections(layout, 500, 500);
    expect(G.scols).toBe(5);
    expect(G.srows).toBe(3);
    expect(G.sections.every((s) => s.w <= 500 && s.h <= 500)).toBe(true);
    // Beispiel aus der Aufgabenstellung: A1–A4 / B1–B4 / C1–C4
    const H = computeSectionsByCount(layout, 4, 3);
    expect(H.sections.map((s) => s.id)).toEqual(['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'B4', 'C1', 'C2', 'C3', 'C4']);
    const cover = new Uint8Array(layout.cols * layout.rows);
    for (const s of H.sections) for (let r = s.r0; r < s.r1; r++) for (let c = s.c0; c < s.c1; c++) cover[r * layout.cols + c]++;
    expect(cover.every((v) => v === 1)).toBe(true);
    expect(H.sections.reduce((a, s) => a + computeStats(layout, res.data, res.palette, [], { reservePct: 10, groutDepthMm: 3 }, s).pieces, 0)).toBe(st.pieces);
  });

  it('1000 × 500 cm, 4 mm, 1 mm Fuge: 2 Mio. Positionen (kachelweise, ohne Formen)', () => {
    const layout = computeLayout({ widthMm: 10000, heightMm: 5000, tileW: 4, tileH: 4, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    expect(layout.cols).toBe(2000);
    expect(layout.rows).toBe(1000);
    const img = prepareFor(loadPng('public/samples/city.png'), layout);
    const t0 = Date.now();
    const res = computeMosaic(img, {
      layout,
      shapes: { ...DEFAULT_SHAPES, diagonal: false, line: false, subdivide: false },
      paletteMode: 'auto',
      colorCount: 64,
      dither: 0,
      deltaE: '2000',
      regions: [],
    });
    const st = computeStats(layout, res.data, res.palette, [], { reservePct: 10, groutDepthMm: 3 });
    expect(st.pieces).toBe(2_000_000);
    expect(st.perColor.reduce((a, b) => a + b.pieces, 0)).toBe(2_000_000);
    expect(st.jointArea).toBeCloseTo(layout.finishedW * layout.finishedH - 2_000_000 * 16, 0);
    console.log(`2 Mio. Positionen: ${Date.now() - t0} ms`);
  }, 300000);
});
