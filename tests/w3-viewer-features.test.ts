/**
 * w3-viewer-features: Lineal, Bereichsfokus, grauer Farbfokus, Foto/Mosaik-Vergleich, Malen/Rechteck im Viewer.
 * Alles reine Anzeige- bzw. Auswahlregeln – Geometrie, Stückzahlen und Daten bleiben unverändert.
 */
import { describe, expect, it } from 'vitest';
import { hexToLab, hexToRgb } from '../src/core/color';
import { setCellKind, setRangePlaced } from '../src/core/edits';
import { cellId, computeLayout, computeSections, parseCellId, type Layout } from '../src/core/layout';
import { cellPieceCount, cellPieces } from '../src/core/pieces';
import {
  blendLum,
  compareSplitAt,
  compareSplitX,
  DIM_ALPHA,
  DIM_WASH_DARK,
  DIM_WASH_LIGHT,
  dimmedPalette,
  dimmedRgb,
  dimWashGrey,
  focusOverlayRects,
  LAID_TINT,
  rangeWorldRect,
  RULER_MIN_LABEL_PX,
  RULER_PX,
  rulerColLabel,
  rulerInsets,
  rulerLabelIndices,
  rulerLabelStep,
  rulerLeftPx,
  rulerPlan,
  rulerRowLabel,
  type View,
} from '../src/core/render';
import { progressOf, type Range } from '../src/core/stats';
import { CellKind, createEmptyMosaic, type MosaicData, type PaletteColor } from '../src/core/types';
import { cellNearPoint, inRange, PaintStroke, pieceAtPoint, rangePieceCount, rectRange, segmentSamples } from '../src/ui/project/viewerInput';

const pal = (hexes: string[]): PaletteColor[] => hexes.map((hex, i) => ({ code: i + 1, name: `F${i + 1}`, hex, lab: hexToLab(hex) }));

/** 40 × 50 cm, 5-mm-Steine, 1 mm Fuge, Rand zuschneiden – 67 × 84 Zellen (mehr als 26 Zeilen → AA …) */
const portrait = (): Layout => computeLayout({ widthMm: 400, heightMm: 500, tileW: 5, tileH: 5, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });

/** Ansicht wie Viewer.fit mit Lineal (6 px Abstand zum Band, sonst 16 px, mittig, nie unter dem Lineal) */
function fitView(layout: Layout, width: number, height: number, rulers = true): View {
  const ins = rulerInsets(layout, rulers);
  const pad = 16;
  const padL = ins.left ? ins.left + 6 : pad;
  const padT = ins.top ? ins.top + 6 : pad;
  const s = Math.min((width - padL - pad) / layout.finishedW, (height - padT - pad) / layout.finishedH);
  return { scale: s, ox: Math.max(padL, (width - layout.finishedW * s) / 2), oy: Math.max(padT, (height - layout.finishedH * s) / 2), width, height };
}

describe('Lineal: Beschriftungsschritt wie im PDF (jede ab 14 px, sonst jede 5./10./50. …)', () => {
  it('rulerLabelStep für verschiedene Rasterabstände', () => {
    expect(rulerLabelStep(40)).toBe(1);
    expect(rulerLabelStep(14)).toBe(1);
    expect(rulerLabelStep(13.9)).toBe(5);
    expect(rulerLabelStep(2.8)).toBe(5);
    expect(rulerLabelStep(2.79)).toBe(10);
    expect(rulerLabelStep(1.4)).toBe(10);
    expect(rulerLabelStep(1.39)).toBe(50);
    expect(rulerLabelStep(0.28)).toBe(50);
    expect(rulerLabelStep(0.27)).toBe(100);
    expect(rulerLabelStep(0.0001)).toBe(50000);
    expect(rulerLabelStep(0)).toBe(50000);
    expect(rulerLabelStep(Number.NaN)).toBe(50000);
    // breitere Beschriftungen (z. B. vierstellige Spaltennummern) brauchen mehr Abstand
    expect(rulerLabelStep(20, 26)).toBe(5);
    expect(rulerLabelStep(26, 26)).toBe(1);
    // der gewählte Schritt hält den Mindestabstand ein, der nächstkleinere nicht
    const steps = [1, 5, 10, 50, 100, 500, 1000];
    for (const pitch of [0.3, 0.9, 1.7, 3.3, 7, 13, 15, 60]) {
      const s = rulerLabelStep(pitch);
      expect(pitch * s).toBeGreaterThanOrEqual(RULER_MIN_LABEL_PX - 1e-9);
      const i = steps.indexOf(s);
      if (i > 0) expect(pitch * steps[i - 1]).toBeLessThan(RULER_MIN_LABEL_PX);
    }
  });

  it('rulerLabelIndices: erste Zeile/Spalte plus jede step-te wie im PDF ((i+1) % step === 0)', () => {
    expect(rulerLabelIndices(0, 6, 1)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rulerLabelIndices(0, 23, 5)).toEqual([0, 4, 9, 14, 19]);
    expect(rulerLabelIndices(7, 23, 5)).toEqual([9, 14, 19]);
    expect(rulerLabelIndices(4, 5, 5)).toEqual([4]);
    expect(rulerLabelIndices(5, 9, 5)).toEqual([]);
    expect(rulerLabelIndices(0, 0, 5)).toEqual([]);
    expect(rulerLabelIndices(0, 120, 50)).toEqual([0, 49, 99]);
    expect(rulerLabelIndices(3, 40, 10)).toEqual([9, 19, 29, 39]);
    // gleiche Auswahl wie die Verlegeblätter im PDF (pdf.ts: (col + 1) % cs === 0), dort zusätzlich die erste Spalte des Blatts
    for (const step of [1, 5, 10, 50]) {
      const pdf = Array.from({ length: 300 }, (_, i) => i).filter((i) => (i + 1) % step === 0 || i === 0);
      expect(rulerLabelIndices(0, 300, step)).toEqual(pdf);
    }
  });

  it('Linealbeschriftungen sind genau die Zeilen- und Spaltenteile der Stein-ID (cellId)', () => {
    const L = portrait();
    expect(L.rows).toBeGreaterThan(26);
    for (let r = 0; r < L.rows; r++) {
      for (let c = 0; c < L.cols; c++) {
        const id = cellId(L, r, c);
        const m = /^([A-Z]+)(\d+)$/.exec(id)!;
        expect(m[1]).toBe(rulerRowLabel(r));
        expect(Number(m[2])).toBe(Number(rulerColLabel(c)));
        expect(parseCellId(L, `${rulerRowLabel(r)}${rulerColLabel(c)}`)).toEqual({ row: r, col: c, piece: 0 });
      }
    }
    expect(rulerRowLabel(0)).toBe('A');
    expect(rulerRowLabel(25)).toBe('Z');
    expect(rulerRowLabel(26)).toBe('AA');
    expect(rulerColLabel(0)).toBe('1');
    expect(rulerColLabel(33)).toBe('34');
  });

  it('rulerPlan: in der Gesamtansicht A und 1, Positionen = Zellmitten, kein Gedränge', () => {
    const L = portrait();
    for (const [w, h] of [
      [1000, 700],
      [390, 520],
      [1600, 1100],
    ]) {
      const v = fitView(L, w, h);
      const plan = rulerPlan(L, v);
      expect(plan.top).toBe(RULER_PX);
      expect(plan.left).toBe(rulerLeftPx(L.rows));
      expect(plan.cols[0].label).toBe('1');
      expect(plan.rows[0].label).toBe('A');
      for (const l of plan.cols) {
        expect(l.label).toBe(rulerColLabel(l.index));
        expect(l.pos).toBeCloseTo(v.ox + (L.colX[l.index] + L.colW[l.index] / 2) * v.scale, 9);
        expect(l.pos).toBeGreaterThanOrEqual(plan.left);
      }
      for (const l of plan.rows) {
        expect(l.label).toBe(rulerRowLabel(l.index));
        expect(l.pos).toBeCloseTo(v.oy + (L.rowY[l.index] + L.rowH[l.index] / 2) * v.scale, 9);
        expect(l.pos).toBeGreaterThanOrEqual(plan.top);
      }
      // Abstand zwischen zwei Beschriftungen: mindestens (step − 1) Raster (erste → step-te), sonst step Raster
      const minGap = (labels: { pos: number }[], step: number, pitch: number) => {
        for (let i = 1; i < labels.length; i++) expect(labels[i].pos - labels[i - 1].pos).toBeGreaterThanOrEqual(Math.max(1, step - 1) * pitch * 0.6);
      };
      minGap(plan.cols, plan.colStep, (L.tileW + L.joint) * v.scale);
      minGap(plan.rows, plan.rowStep, (L.tileH + L.joint) * v.scale);
    }
  });

  it('rulerPlan: hineingezoomt nur sichtbare Zeilen/Spalten, jede beschriftet', () => {
    const L = portrait();
    const v: View = { scale: 8, ox: -600, oy: -900, width: 800, height: 600 };
    const plan = rulerPlan(L, v);
    expect(plan.colStep).toBe(1);
    expect(plan.rowStep).toBe(1);
    expect(plan.cols.length).toBeGreaterThan(5);
    for (let i = 1; i < plan.cols.length; i++) expect(plan.cols[i].index).toBe(plan.cols[i - 1].index + 1);
    for (const l of plan.cols) expect(l.pos).toBeLessThanOrEqual(v.width);
    // erste sichtbare Spalte: Mitte rechts vom linken Band
    const firstVisible = plan.cols[0].index;
    expect(v.ox + (L.colX[firstVisible] + L.colW[firstVisible] / 2) * v.scale).toBeGreaterThanOrEqual(plan.left);
  });

  it('linkes Band wächst mit dreistelligen Zeilenbuchstaben', () => {
    expect(rulerLeftPx(26)).toBe(RULER_PX);
    expect(rulerLeftPx(702)).toBe(RULER_PX); // ZZ
    expect(rulerLeftPx(703)).toBe(RULER_PX + 6); // AAA
    expect(rulerInsets({ rows: 10 }, false)).toEqual({ top: 0, left: 0 });
  });
});

describe('Bereichsfokus: Schleier deckt genau die Fläche außerhalb ab', () => {
  /** Jeder Abtastpunkt der Ansicht liegt in genau einem Schleier-Rechteck oder im Bereich */
  function checkCoverage(L: Layout, rg: Range, v: View) {
    const rects = focusOverlayRects(L, rg, v);
    const wr = rangeWorldRect(L, rg);
    const inside = (x: number, y: number) => {
      if (!wr) return false;
      const X0 = v.ox + wr.x0 * v.scale;
      const X1 = v.ox + wr.x1 * v.scale;
      const Y0 = v.oy + wr.y0 * v.scale;
      const Y1 = v.oy + wr.y1 * v.scale;
      return x >= X0 && x < X1 && y >= Y0 && y < Y1;
    };
    let area = 0;
    for (const r of rects) {
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(v.width + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(v.height + 1e-9);
      area += r.w * r.h;
    }
    // Fläche: Schleier + sichtbarer Bereich = ganze Ansicht
    let innerArea = 0;
    if (wr) {
      const iw = Math.max(0, Math.min(v.width, v.ox + wr.x1 * v.scale) - Math.max(0, v.ox + wr.x0 * v.scale));
      const ih = Math.max(0, Math.min(v.height, v.oy + wr.y1 * v.scale) - Math.max(0, v.oy + wr.y0 * v.scale));
      innerArea = iw * ih;
    }
    expect(area + innerArea).toBeCloseTo(v.width * v.height, 6);
    // Abtastung: genau eine Abdeckung je Punkt
    for (let y = 0.5; y < v.height; y += 7.3) {
      for (let x = 0.5; x < v.width; x += 7.1) {
        const n = rects.filter((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h).length + (inside(x, y) ? 1 : 0);
        expect(n).toBe(1);
      }
    }
  }

  it('Abschnitt mitten in der Ansicht, teilweise außerhalb, ganz außerhalb, leer', () => {
    const L = portrait();
    const G = computeSections(L, 150, 150);
    const v = fitView(L, 900, 700);
    for (const s of G.sections) checkCoverage(L, s, v);
    checkCoverage(L, { r0: 10, r1: 30, c0: 5, c1: 20 }, { scale: 6, ox: -100, oy: -200, width: 640, height: 480 });
    checkCoverage(L, { r0: 0, r1: 3, c0: 0, c1: 3 }, { scale: 6, ox: -1000, oy: -1500, width: 640, height: 480 });
    checkCoverage(L, { r0: 5, r1: 5, c0: 0, c1: 3 }, v);
    expect(focusOverlayRects(L, { r0: 5, r1: 5, c0: 0, c1: 3 }, v)).toEqual([{ x: 0, y: 0, w: 900, h: 700 }]);
  });

  it('Bereichsgrenze = Abschnittsgrenze auf Fugenmitte (am Mosaikrand ohne Außenfuge)', () => {
    const L = portrait();
    const G = computeSections(L, 150, 150);
    for (const s of G.sections) {
      const wr = rangeWorldRect(L, s)!;
      expect(wr.x0).toBeCloseTo(Math.max(0, s.x - L.joint / 2), 9);
      expect(wr.y0).toBeCloseTo(Math.max(0, s.y - L.joint / 2), 9);
      expect(wr.x1).toBeCloseTo(Math.min(L.finishedW, s.x + s.w + L.joint / 2), 9);
      expect(wr.y1).toBeCloseTo(Math.min(L.finishedH, s.y + s.h + L.joint / 2), 9);
    }
    // alle Abschnitte zusammen decken das Mosaik lückenlos und ohne Überlappung ab
    const total = G.sections.reduce((a, s) => {
      const wr = rangeWorldRect(L, s)!;
      return a + (wr.x1 - wr.x0) * (wr.y1 - wr.y0);
    }, 0);
    expect(total).toBeCloseTo(L.finishedW * L.finishedH, 6);
  });
});

describe('Farbfokus: grauer Schleier, der sich von der hervorgehobenen Farbe abhebt', () => {
  it('dunkle/mittlere Fokusfarbe → abgeblendete Steine hellgrau, helle Fokusfarbe → dunkelgrau', () => {
    const p = pal(['#F4F1EC', '#C0262D', '#3A6EA5', '#000000', '#E8D9A0']);
    expect(dimWashGrey(p, 1)).toBe(DIM_WASH_LIGHT); // Rot (Lum 85)
    expect(dimWashGrey(p, 3)).toBe(DIM_WASH_LIGHT);
    expect(dimWashGrey(p, 0)).toBe(DIM_WASH_DARK); // fast Weiß
    expect(dimWashGrey(p, 4)).toBe(DIM_WASH_DARK); // helles Beige
    expect(dimWashGrey(p, null)).toBe(DIM_WASH_LIGHT);
    expect(dimWashGrey(p, 99)).toBe(DIM_WASH_LIGHT);
  });

  it('abgeblendete Farben sind neutral grau (nie grünlich wie der Verlegt-Ton), Fokusfarbe unverändert', () => {
    const hexes = ['#F4F1EC', '#C0262D', '#3A6EA5', '#000000', '#E8D9A0', '#2E7D32', '#9B59B6'];
    const p = pal(hexes);
    for (let focus = 0; focus < p.length; focus++) {
      const d = dimmedPalette(p, focus);
      expect(d[focus]).toBe(p[focus]);
      const [fr, fg, fb] = hexToRgb(p[focus].hex);
      const focusLum = blendLum(fr, fg, fb);
      for (let i = 0; i < d.length; i++) {
        if (i === focus) continue;
        const [r, g, b] = hexToRgb(d[i].hex);
        expect(r).toBe(g);
        expect(g).toBe(b);
        // deutlich anders hell als die hervorgehobene Farbe
        expect(Math.abs(r - focusLum)).toBeGreaterThan(45);
      }
    }
    // Verlegt-Ton ist farbig (grün > rot), der Schleier nie
    expect(LAID_TINT[1]).toBeGreaterThan(LAID_TINT[0] + 20);
    // Eingabe unverändert
    expect(p.map((x) => x.hex)).toEqual(hexes);
  });

  it('Formel: Helligkeit wie Canvas-„saturation“, dann Überblendung mit DIM_ALPHA', () => {
    const [v] = dimmedRgb([0, 0, 0], DIM_WASH_LIGHT);
    expect(v).toBeCloseTo(255 * DIM_ALPHA, 9);
    const [w] = dimmedRgb([200, 100, 50], DIM_WASH_DARK);
    expect(w).toBeCloseTo((0.3 * 200 + 0.59 * 100 + 0.11 * 50) * (1 - DIM_ALPHA) + DIM_WASH_DARK * DIM_ALPHA, 9);
    // Schwarz bei dunkler Fokusfarbe wie bisher (weißer Schleier)
    const d = dimmedPalette(pal(['#000000', '#C0262D']), 1);
    expect(hexToRgb(d[0].hex)).toEqual([199, 199, 199]);
  });
});

describe('Foto/Mosaik-Vergleich: Trennlinie im sichtbaren Teil der Mosaikfläche', () => {
  it('Gesamtansicht: Anteil der Mosaikbreite; hineingezoomt: Anteil der Ansicht; außerhalb: null', () => {
    const L = portrait();
    const v = fitView(L, 1000, 700);
    const W = L.finishedW * v.scale;
    expect(compareSplitX(L, v, 0.5)).toBeCloseTo(v.ox + W / 2, 9);
    expect(compareSplitX(L, v, 0)).toBeCloseTo(v.ox, 9);
    expect(compareSplitX(L, v, 1)).toBeCloseTo(v.ox + W, 9);
    expect(compareSplitX(L, v, 2)).toBeCloseTo(v.ox + W, 9);
    expect(compareSplitX(L, v, Number.NaN)).toBeCloseTo(v.ox + W / 2, 9);
    const z: View = { scale: 10, ox: -500, oy: -500, width: 800, height: 600 };
    expect(compareSplitX(L, z, 0.25)).toBeCloseTo(200, 9);
    expect(compareSplitX(L, { ...z, ox: 900 }, 0.5)).toBeNull();
    expect(compareSplitX(L, { ...z, ox: -L.finishedW * 10 - 1 }, 0.5)).toBeNull();
    // Umkehrung
    for (const s of [0, 0.1, 0.5, 0.93, 1]) {
      expect(compareSplitAt(L, v, compareSplitX(L, v, s)!)).toBeCloseTo(s, 9);
      expect(compareSplitAt(L, z, compareSplitX(L, z, s)!)).toBeCloseTo(s, 9);
    }
    expect(compareSplitAt(L, v, -50)).toBe(0);
    expect(compareSplitAt(L, v, 5000)).toBe(1);
  });
});

describe('Malen und Rechteck: Treffer aus der exakten Steingeometrie', () => {
  function small() {
    const L = computeLayout({ widthMm: 66, heightMm: 42, tileW: 5, tileH: 5, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const data = createEmptyMosaic(L.cols, L.rows);
    return { L, data };
  }
  const centre = (L: Layout, row: number, col: number) => ({ x: L.colX[col] + L.colW[col] / 2, y: L.rowY[row] + L.rowH[row] / 2 });

  it('pieceAtPoint: Stein in der Zelle, Fuge → null, geteilte Zelle → richtiges Teilstück', () => {
    const { L, data } = small();
    expect(L.cols).toBe(11);
    const c = centre(L, 2, 3);
    expect(pieceAtPoint(L, data, c.x, c.y)).toEqual({ idx: 2 * L.cols + 3, piece: 0, row: 2, col: 3 });
    // Fugenmitte zwischen Spalte 3 und 4
    expect(pieceAtPoint(L, data, L.colX[4] - L.joint / 2, c.y)).toBeNull();
    expect(pieceAtPoint(L, data, -5, c.y)).toBeNull();
    expect(setCellKind(L, data, 2, 3, { kind: CellKind.SUB, k: 2 }, 1)).toBeNull();
    const ps = cellPieces(L, data, 2, 3);
    expect(ps.length).toBe(4);
    for (let i = 0; i < ps.length; i++) {
      const xs = ps[i].poly.map((p) => p.x);
      const ys = ps[i].poly.map((p) => p.y);
      const px = (Math.min(...xs) + Math.max(...xs)) / 2;
      const py = (Math.min(...ys) + Math.max(...ys)) / 2;
      expect(pieceAtPoint(L, data, px, py)?.piece).toBe(i);
    }
    // innere Fuge der 2×2-Unterteilung trifft keinen Stein
    expect(pieceAtPoint(L, data, c.x, c.y)).toBeNull();
  });

  it('Malstrich: erster Stein bestimmt den Zielzustand, nur sich ändernde Steine, jeder einmal', () => {
    const { L, data } = small();
    // Zeile 1: Spalten 4 und 6 schon verlegt
    data.progress[1 * L.cols + 4] = 1;
    data.progress[1 * L.cols + 6] = 1;
    const a = centre(L, 1, 0);
    const b = centre(L, 1, L.cols - 1);
    const st = new PaintStroke(L, data);
    st.addAt(a.x, a.y);
    st.addSegment(a.x, a.y, b.x, b.y);
    st.addSegment(b.x, b.y, a.x, a.y); // zurück: nichts doppelt, nichts rückgängig
    expect(st.set).toBe(true);
    expect(st.pieces.map((p) => p.idx - L.cols)).toEqual([0, 1, 2, 3, 5, 7, 8, 9, 10]);
    // Start auf einem verlegten Stein → „nicht verlegt“, nur verlegte Steine werden gesammelt
    const c4 = centre(L, 1, 4);
    const st2 = new PaintStroke(L, data);
    st2.addAt(c4.x, c4.y);
    st2.addSegment(c4.x, c4.y, b.x, b.y);
    expect(st2.set).toBe(false);
    expect(st2.pieces).toEqual([
      { idx: L.cols + 4, piece: 0 },
      { idx: L.cols + 6, piece: 0 },
    ]);
    // die Daten selbst ändert der Strich nicht
    expect(data.progress[L.cols]).toBe(0);
  });

  it('Malstrich: ein schneller Zug über eine ganze Zeile trifft jede Zelle, nichts außerhalb des Bereichs', () => {
    const { L, data } = small();
    const focus: Range = { r0: 0, r1: L.rows, c0: 2, c1: 8 };
    const a = centre(L, 0, 0);
    const b = centre(L, 0, L.cols - 1);
    const st = new PaintStroke(L, data, focus);
    st.addAt(a.x, a.y);
    st.addSegment(a.x, a.y, b.x, b.y);
    expect(st.pieces.map((p) => p.idx)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(st.pieces.every((p) => inRange(focus, Math.floor(p.idx / L.cols), p.idx % L.cols))).toBe(true);
    // Unterteilte Zelle: alle vier Teilstücke einzeln
    expect(setCellKind(L, data, 3, 5, { kind: CellKind.SUB, k: 2 }, 1)).toBeNull();
    const ps = cellPieces(L, data, 3, 5);
    const st2 = new PaintStroke(L, data);
    for (const p of ps) {
      const xs = p.poly.map((q) => q.x);
      const ys = p.poly.map((q) => q.y);
      st2.addAt((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2);
    }
    expect(st2.pieces.map((p) => p.piece)).toEqual([0, 1, 2, 3]);
    expect(segmentSamples(0, 0, 10, 0, 2).length).toBe(5);
    expect(segmentSamples(0, 0, 0, 0, 2)).toEqual([[0, 0]]);
  });

  it('Rechteck: rastet auf Zellen ein, auf den Fokusbereich beschnitten; Steinzahl = progressOf', () => {
    const { L, data } = small();
    expect(cellNearPoint(L, -10, -10)).toEqual({ row: 0, col: 0 });
    expect(cellNearPoint(L, 1e6, 1e6)).toEqual({ row: L.rows - 1, col: L.cols - 1 });
    expect(cellNearPoint(L, L.colX[3] + 1, L.rowY[2] + 1)).toEqual({ row: 2, col: 3 });
    // in der Fuge: angrenzende Zelle
    const nj = cellNearPoint(L, L.colX[4] - L.joint / 2 - 0.01, L.rowY[2] + 1);
    expect(nj.col).toBe(3);
    expect(rectRange({ row: 5, col: 7 }, { row: 2, col: 3 })).toEqual({ r0: 2, r1: 6, c0: 3, c1: 8 });
    expect(rectRange({ row: 5, col: 7 }, { row: 2, col: 3 }, { r0: 0, r1: 4, c0: 5, c1: 11 })).toEqual({ r0: 2, r1: 4, c0: 5, c1: 8 });
    expect(rectRange({ row: 5, col: 7 }, { row: 5, col: 7 }, { r0: 0, r1: 4, c0: 0, c1: 4 })).toBeNull();
    expect(setCellKind(L, data, 3, 5, { kind: CellKind.SUB, k: 3 }, 1)).toBeNull();
    expect(setCellKind(L, data, 2, 4, { kind: CellKind.DIAG_A }, 1)).toBeNull();
    const rg = rectRange({ row: 1, col: 2 }, { row: 4, col: 8 })!;
    const n = rangePieceCount(L, data, rg)!;
    expect(n).toBe(progressOf(L, data, rg).total);
    expect(n).toBe(4 * 7 - 2 + 9 + 2);
    // setRangePlaced auf genau diesen Bereich verlegt genau diese Steine
    setRangePlaced(L, data, rg, true);
    expect(progressOf(L, data).placed).toBe(n);
    expect(rangePieceCount(L, data, rg, 10)).toBeNull();
    let sum = 0;
    for (let i = 0; i < L.cols * L.rows; i++) sum += cellPieceCount(data, i);
    expect(rangePieceCount(L, data, { r0: 0, r1: L.rows, c0: 0, c1: L.cols })).toBe(sum);
  });
});

describe('Hilfsfunktionen ändern keine Daten', () => {
  it('PaintStroke/rangePieceCount/pieceAtPoint lassen das Mosaik unverändert', () => {
    const L = portrait();
    const data: MosaicData = createEmptyMosaic(L.cols, L.rows);
    data.progress[5] = 1;
    const before = Array.from(data.progress);
    const st = new PaintStroke(L, data);
    st.addSegment(0, 0, L.finishedW, L.finishedH);
    rangePieceCount(L, data, { r0: 0, r1: L.rows, c0: 0, c1: L.cols });
    pieceAtPoint(L, data, 10, 10);
    expect(Array.from(data.progress)).toEqual(before);
    expect(st.pieces.length).toBeGreaterThan(10);
  });
});
