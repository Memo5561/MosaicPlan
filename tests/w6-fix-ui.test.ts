/**
 * Paket w6-fix-ui: „Form zurücksetzen“ nach der Fotofarbe (nicht nach dem ersten Teil) und Heller/Dunkler mit
 * gekennzeichneten großen Sprüngen und abwählbaren Zeilen – jeweils ein Verlaufseintrag, Probelauf = Ergebnis.
 */
import { describe, expect, it } from 'vitest';
import { applyColorMap, applyShapeReset, colorCensus, planShade, planShapeReset, SHADE_BIG_JUMP_DE } from '../src/core/batch';
import { deltaE2000, hexToLab, type Lab } from '../src/core/color';
import { cellPhotoTarget, hasPhotoTargets, nearestPaletteColor, pieceTarget } from '../src/core/deviation';
import { addPaletteColor, setCellKind, setPieceColor, shadeStep } from '../src/core/edits';
import { area } from '../src/core/geometry';
import { captureCellSide, cellsEntryFrom, EditJournal, paletteIndexSig, uniqueCells } from '../src/core/journal';
import { computeLayout } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { cellPieces } from '../src/core/pieces';
import { cloneMosaic, packMosaic } from '../src/core/serialize';
import { CellKind, createEmptyMosaic, type PaletteColor, type PhotoTargets } from '../src/core/types';
import { baseParams, sampleSetup } from './w1-mosaic-core.fixtures';

const MIN = 1.5;

function palette(hexes: string[]): PaletteColor[] {
  let p: PaletteColor[] = [];
  for (const h of hexes) p = addPaletteColor(p, h, undefined, 'de');
  return p;
}
const WHITE = 0;
const PAL = palette(['#FFFFFF', '#000000', '#5A3A28', '#888888', '#D9B39A', '#3D85C6', '#9FC5F8', '#1F5A96', '#C9DDF5', '#6FA8DC', '#4A8FCF']);

/** Speicherform der Fotofarbe (wie mosaic.ts): L* mal 2,55, a* und b* plus 128, je ein Byte */
const q = (lab: Lab) => [Math.round(lab[0] * 2.55), Math.round(lab[1] + 128), Math.round(lab[2] + 128)];
const fromQ = (b: number[]): Lab => [b[0] / 2.55, b[1] - 128, b[2] - 128];
const json = (d: Parameters<typeof packMosaic>[0]) => JSON.stringify(packMosaic(d));

describe('Form zurücksetzen: Farbe nach der Fotofarbe der Zelle', () => {
  /**
   * 3 × 1 Raster: Zelle 0 = Augenzelle 2×2 (erstes Teil weiß, drei Teile dunkel), Zelle 1 = Kantenschnitt mit ungleichen
   * Teilflächen, Zelle 2 = ganzer Stein. Fotofarben von Hand, in genau der gepackten Form der Berechnung.
   */
  function eyeGrid() {
    const layout = computeLayout({ widthMm: 33, heightMm: 10, tileW: 10, tileH: 10, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    expect(layout.cols).toBe(3);
    expect(layout.rows).toBe(1);
    const data = createEmptyMosaic(3, 1);
    expect(setCellKind(layout, data, 0, 0, { kind: CellKind.SUB, k: 2 }, MIN)).toBeNull();
    setPieceColor(data, 0, 0, WHITE);
    for (let p = 1; p < 4; p++) setPieceColor(data, 0, p, 2);
    expect(setCellKind(layout, data, 0, 1, { kind: CellKind.LINE, angleDeg: 90, offsetMm: 2.5 }, MIN)).toBeNull();
    data.c1[1] = 3;
    data.c2[1] = 4;
    data.c1[2] = 5;
    const white: Lab = [96, 0, 2];
    const dark: Lab = [28, 9, 14];
    const line = data.line.get(1)!;
    const lab1 = new Uint8Array(9);
    lab1.set(q(hexToLab('#888888')), 3);
    lab1.set(q(hexToLab('#3D85C6')), 6);
    const t: PhotoTargets = {
      kind: Uint8Array.from([CellKind.SUB, CellKind.LINE, CellKind.FULL]),
      lab1,
      lab2: Uint8Array.from(q(hexToLab('#D9B39A'))),
      line: Float32Array.from(line),
      subLen: Uint8Array.from([4]),
      subLab: Float32Array.from([...white, ...dark, ...dark, ...dark]),
    };
    data.targets = t;
    return { layout, data, white, dark };
  }

  it('Augenzelle: nicht weiß wie ihr erstes Teil, sondern die Palettenfarbe nächst dem flächengewichteten Fotomittel', () => {
    const { layout, data, white, dark } = eyeGrid();
    expect(hasPhotoTargets(data)).toBe(true);
    const plan = planShapeReset(layout, data, PAL, '2000');
    expect([...plan.cells]).toEqual([0, 1]);
    expect(plan.photoCells).toBe(2);
    expect(plan.areaCells).toBe(0);
    // k×k: gleiche Flächen → einfaches Mittel der vier Fotofarben
    const ps = cellPieces(layout, data, 0, 0);
    const a = ps.map((p) => area(p.poly));
    expect(Math.max(...a) - Math.min(...a)).toBeLessThan(1e-9);
    const mean: Lab = [(white[0] + 3 * dark[0]) / 4, (white[1] + 3 * dark[1]) / 4, (white[2] + 3 * dark[2]) / 4];
    let best = -1;
    let bd = Infinity;
    PAL.forEach((p, i) => {
      const d = deltaE2000(mean[0], mean[1], mean[2], p.lab[0], p.lab[1], p.lab[2]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    expect(plan.colors[0]).toBe(best);
    expect(plan.colors[0]).not.toBe(WHITE);
    expect(plan.byPhoto[0]).toBe(1);
  });

  it('Kantenschnitt: Gewicht = Teilfläche (ungleiche Teile)', () => {
    const { layout, data } = eyeGrid();
    const ps = cellPieces(layout, data, 0, 1);
    const a = ps.map((p) => area(p.poly));
    expect(Math.abs(a[0] - a[1])).toBeGreaterThan(5);
    const t0 = pieceTarget(data, 1, 0)!;
    const t1 = pieceTarget(data, 1, 1)!;
    expect(t0).toEqual(fromQ(q(hexToLab('#888888'))));
    const w: Lab = [0, 1, 2].map((k) => (t0[k] * a[0] + t1[k] * a[1]) / (a[0] + a[1])) as Lab;
    const got = cellPhotoTarget(data, 1, a)!;
    got.forEach((v, k) => expect(v).toBeCloseTo(w[k], 10));
    const plan = planShapeReset(layout, data, PAL, '2000');
    expect(plan.colors[1]).toBe(nearestPaletteColor(PAL, w, '2000')!.index);
  });

  it('ohne Fotoreferenz (Form geändert, Freiform, altes Raster): Farbe mit der größten Fläche', () => {
    const { layout, data } = eyeGrid();
    data.targets = undefined;
    const plan = planShapeReset(layout, data, PAL, '2000');
    expect(plan.photoCells).toBe(0);
    // 2×2: drei von vier Teilen in Farbe 2
    expect(plan.colors[0]).toBe(2);
    // Kantenschnitt: das größere Teil
    const ps = cellPieces(layout, data, 0, 1);
    const big = area(ps[0].poly) > area(ps[1].poly) ? ps[0].color : ps[1].color;
    expect(plan.colors[1]).toBe(big);
  });

  it('Anwenden: genau die geplanten Farben, ein Verlaufseintrag, Rückgängig stellt alles her', () => {
    const { layout, data } = eyeGrid();
    data.progress[0] = 0b0101;
    const before = json(data);
    const plan = planShapeReset(layout, data, PAL, '2000');
    const j = new EditJournal();
    const ids = uniqueCells(plan.cells);
    const side = captureCellSide(data, ids);
    expect(applyShapeReset(layout, data, plan.cells, MIN, plan.colors)).toBe(2);
    plan.cells.forEach((idx, k) => {
      expect(data.kind[idx]).toBe(CellKind.FULL);
      expect(data.c1[idx]).toBe(plan.colors[k]);
      expect(data.progress[idx]).toBe(0);
    });
    const e = cellsEntryFrom(data, ids, side, { label: { text: 'Form zurücksetzen' }, sig: paletteIndexSig(PAL) });
    expect(j.push(e!)).toBe('pushed');
    expect(j.undoSize).toBe(1);
    expect(j.undo({ data, palette: PAL }).status).toBe('ok');
    expect(json(data)).toBe(before);
  });

  it('berechnetes Mosaik: alle geteilten Zellen mit Fotoreferenz bekommen die nächste Farbe zum Fotomittel', () => {
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su));
    const L = su.layout;
    const data = cloneMosaic(res.data);
    data.targets = res.data.targets;
    const pal = res.palette;
    // ein paar Zellen von Hand teilen (deren Form gehört nicht zur Berechnung → größte Fläche)
    let manual = 0;
    for (let i = 0; i < data.kind.length && manual < 5; i += 37)
      if (data.kind[i] === CellKind.FULL && setCellKind(L, data, Math.floor(i / L.cols), i % L.cols, { kind: CellKind.DIAG_A }, MIN) === null) {
        setPieceColor(data, i, 1, (data.c1[i] + 1) % pal.length);
        manual++;
      }
    expect(manual).toBe(5);
    const plan = planShapeReset(L, data, pal, '2000');
    expect(plan.areaCells).toBe(manual);
    expect(plan.photoCells + plan.areaCells).toBe(plan.cells.length);
    plan.cells.forEach((idx, k) => {
      const ps = cellPieces(L, data, Math.floor(idx / L.cols), idx % L.cols);
      const tg = cellPhotoTarget(
        data,
        idx,
        ps.map((p) => area(p.poly)),
      );
      if (plan.byPhoto[k]) expect(plan.colors[k]).toBe(nearestPaletteColor(pal, tg!, '2000')!.index);
      else expect(tg).toBeNull();
    });
    const piecesBefore = plan.piecesBefore;
    expect(applyShapeReset(L, data, plan.cells, MIN, plan.colors)).toBe(plan.cells.length);
    expect(piecesBefore).toBeGreaterThan(plan.cells.length);
  });
});

describe('Heller/Dunkler: großer Sprung, abwählbare Zeilen', () => {
  function grid() {
    const layout = computeLayout({ widthMm: 109, heightMm: 54, tileW: 10, tileH: 10, joint: 1, edgeMode: 'whole', minCutMm: 2 });
    const data = createEmptyMosaic(layout.cols, layout.rows);
    for (let i = 0; i < data.kind.length; i++) data.c1[i] = 5 + (i % 6);
    return { layout, data };
  }

  it('Zeilen über ΔE 8 sind „großer Sprung“; Probelauf = angehakte Zeilen; abgewählte Farben bleiben', () => {
    const { data } = grid();
    for (const dir of ['lighter', 'darker'] as const) {
      const all = planShade(PAL, data, null, dir, '2000');
      const census = colorCensus(data, PAL.length, null);
      expect(all.matched + all.unmatched + all.skipped).toBe(census.pieces);
      expect(all.skipped).toBe(0);
      for (const r of all.rows) {
        const s = shadeStep(PAL, r.from, dir, '2000');
        expect(r.big).toBe(!!s && s.dE > SHADE_BIG_JUMP_DE);
        expect(r.skipped).toBe(false);
      }
      const withTo = all.rows.filter((r) => r.to);
      expect(withTo.length).toBeGreaterThan(1);
      // eine Zeile abwählen (bevorzugt einen großen Sprung)
      const off = (withTo.find((r) => r.big) ?? withTo[0]).from;
      const plan = planShade(PAL, data, null, dir, '2000', new Set([off]));
      const row = plan.rows.find((r) => r.from === off)!;
      expect(row.skipped).toBe(true);
      expect(plan.skipped).toBe(row.pieces);
      expect(plan.matched).toBe(all.matched - row.pieces);
      expect(plan.unmatched).toBe(all.unmatched);
      expect(plan.map[off]).toBe(-1);
      // eine abgewählte Farbe ohne Zielfarbe ändert nichts (sie bleibt „keine passende Farbe“)
      const none = all.rows.find((r) => !r.to);
      if (none) expect(planShade(PAL, data, null, dir, '2000', new Set([none.from])).unmatched).toBe(all.unmatched);
      const d = cloneMosaic(data);
      expect(applyColorMap(d, plan.cells, plan.map)).toBe(plan.matched);
      for (let i = 0; i < d.kind.length; i++) {
        const was = data.c1[i];
        if (was === off) expect(d.c1[i]).toBe(off);
        else expect(d.c1[i]).toBe(plan.map[was] >= 0 ? plan.map[was] : was);
      }
    }
  });

  it('die Testpalette enthält mindestens einen großen Sprung (ΔE über 8) – sonst prüft der Test nichts', () => {
    const { data } = grid();
    const rows = [...planShade(PAL, data, null, 'lighter', '2000').rows, ...planShade(PAL, data, null, 'darker', '2000').rows];
    expect(rows.some((r) => r.big)).toBe(true);
    expect(rows.some((r) => r.to && !r.big)).toBe(true);
  });
});
