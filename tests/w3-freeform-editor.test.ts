/**
 * w3-freeform-editor: exakte Überlappungs- und Fugenprüfung für Freiform-Teile, typisierte Befunde,
 * Vorlagen und verlustfreie Übernahme bestehender Zellen in den Editor.
 */
import { describe, expect, it } from 'vitest';
import {
  freeEditorPieces,
  freeIssuePieces,
  MAX_FREE_PIECES,
  setCellKind,
  setFreePieces,
  snapFreePoint,
  validateFreePieces,
  type FreeIssue,
  type KindChange,
} from '../src/core/edits';
import {
  area,
  convexIntersectionArea,
  isSimple,
  polygonDistance,
  polygonIntersectionArea,
  polygonsOverlap,
  rectPoly,
  signedArea,
  triangulate,
  type Pt,
} from '../src/core/geometry';
import { computeLayout } from '../src/core/layout';
import { cellPieces, cellRect, diagA, freePreset, FREE_PRESET_KINDS, lineSplit } from '../src/core/pieces';
import { computeStats } from '../src/core/stats';
import { CellKind, createEmptyMosaic, type FreePiece, type PaletteColor } from '../src/core/types';
import { dictionaries, makeT } from '../src/i18n';
import { freeIssueText } from '../src/ui/project/FreeformEditor';
import { classifyShape } from '../src/core/geometry';

const P = (a: number[][]): Pt[] => a.map(([x, y]) => ({ x, y }));
const fp = (...polys: number[][][]): FreePiece[] => polys.map((p, i) => ({ poly: P(p), color: i }));
const codes = (is: FreeIssue[]) => is.map((i) => i.code);

/** Pseudozufall mit festem Startwert (reproduzierbar). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ================================================================ Geometrie

describe('triangulate', () => {
  it('zerlegt konvexe, nicht-konvexe, im und gegen den Uhrzeigersinn orientierte Polygone flächengleich', () => {
    const polys = [
      P([[0, 0], [8, 0], [8, 8], [0, 8]]),
      P([[0, 0], [8, 0], [8, 2], [2, 2], [2, 8], [0, 8]]), // L
      P([[0, 0], [0, 8], [2, 8], [2, 2], [8, 2], [8, 0]]), // L, andere Orientierung
      P([[4, 0], [5, 3], [8, 4], [5, 5], [4, 8], [3, 5], [0, 4], [3, 3]]), // Stern
      P([[0, 0], [6, 0], [6, 6], [4, 6], [4, 2], [2, 2], [2, 6], [0, 6]]), // U
    ];
    for (const p of polys) {
      const tri = triangulate(p);
      expect(tri.length).toBe(p.length - 2);
      expect(tri.reduce((s, t) => s + area(t), 0)).toBeCloseTo(area(p), 9);
      for (const t of tri) expect(signedArea(t)).toBeGreaterThan(0);
    }
  });

  it('weniger als drei Ecken oder Fläche 0 ergeben keine Dreiecke', () => {
    expect(triangulate(P([[0, 0], [1, 1]]))).toEqual([]);
    expect(triangulate(P([[0, 0], [1, 1], [2, 2]]))).toEqual([]);
  });

  it('zufällige sternförmige Polygone: Summe der Dreiecke = Polygonfläche', () => {
    const r = rng(7);
    for (let it = 0; it < 400; it++) {
      const n = 3 + Math.floor(r() * 12);
      const p: Pt[] = [];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        const rad = 0.5 + r() * 5;
        p.push({ x: 6 + rad * Math.cos(a), y: 6 + rad * Math.sin(a) });
      }
      expect(isSimple(p)).toBe(true);
      expect(triangulate(p).reduce((s, t) => s + area(t), 0)).toBeCloseTo(area(p), 8);
    }
  });
});

describe('polygonIntersectionArea', () => {
  const cases: [string, number[][], number[][], number][] = [
    ['Streifen 8×5 überlappen 8×2', [[0, 0], [8, 0], [8, 5], [0, 5]], [[0, 3], [8, 3], [8, 8], [0, 8]], 16],
    ['gestapeltes Paar (früher übersehen)', [[3.5, 4], [5.5, 4], [5.5, 7.5], [3.5, 7.5]], [[3.5, 1.5], [5.5, 1.5], [5.5, 5.5], [3.5, 5.5]], 3],
    ['Dreieck im Quadrat', [[0, 0], [8, 0], [0, 8]], [[0, 0], [8, 0], [8, 8], [0, 8]], 32],
    ['Dreiecke an gemeinsamer Diagonale', [[0, 0], [8, 0], [0, 8]], [[8, 0], [8, 8], [0, 8]], 0],
    ['L gegen Rechteck (nicht konvex)', [[0, 0], [8, 0], [8, 2], [2, 2], [2, 8], [0, 8]], [[0, 0], [4, 0], [4, 4], [0, 4]], 12],
    ['saubere Teilung mit 1 mm Fuge', [[0, 0], [3.5, 0], [3.5, 8], [0, 8]], [[4.5, 0], [8, 0], [8, 8], [4.5, 8]], 0],
    ['ganz enthalten', [[0, 0], [8, 0], [8, 8], [0, 8]], [[2, 2], [3, 2], [3, 3]], 0.5],
    ['nur Ecke berührt', [[0, 0], [4, 0], [4, 4], [0, 4]], [[4, 4], [8, 4], [8, 8], [4, 8]], 0],
    ['Ecke auf Kante', [[0, 0], [4, 0], [4, 4], [0, 4]], [[4, 2], [8, 0], [8, 4]], 0],
  ];
  for (const [name, a, b, exp] of cases)
    it(`${name}: ${exp} mm² (symmetrisch)`, () => {
      expect(polygonIntersectionArea(P(a), P(b))).toBeCloseTo(exp, 9);
      expect(polygonIntersectionArea(P(b), P(a))).toBeCloseTo(exp, 9);
    });

  it('achsparallele Rechtecke im 0,5-mm-Raster (viele kollineare Kanten): exakt wie die Rechteckformel', () => {
    const r = rng(11);
    const g = () => Math.round(r() * 16) / 2;
    for (let it = 0; it < 2000; it++) {
      const [x1, x2] = [g(), g()].sort((u, v) => u - v);
      const [y1, y2] = [g(), g()].sort((u, v) => u - v);
      const [u1, u2] = [g(), g()].sort((u, v) => u - v);
      const [v1, v2] = [g(), g()].sort((u, v) => u - v);
      if (x2 - x1 < 0.5 || y2 - y1 < 0.5 || u2 - u1 < 0.5 || v2 - v1 < 0.5) continue;
      const exp = Math.max(0, Math.min(x2, u2) - Math.max(x1, u1)) * Math.max(0, Math.min(y2, v2) - Math.max(y1, v1));
      expect(polygonIntersectionArea(rectPoly(x1, y1, x2 - x1, y2 - y1), rectPoly(u1, v1, u2 - u1, v2 - v1))).toBeCloseTo(exp, 9);
    }
  });

  it('Rechteck gegen Dreieck: gleich dem direkten konvexen Beschnitt', () => {
    const r = rng(3);
    const g = () => Math.round(r() * 16) / 2;
    for (let it = 0; it < 1000; it++) {
      const rect = rectPoly(g() / 2, g() / 2, 1 + g() / 2, 1 + g() / 2);
      const tri = P([[g(), g()], [g(), g()], [g(), g()]]);
      if (area(tri) < 0.1) continue;
      expect(polygonIntersectionArea(rect, tri)).toBeCloseTo(convexIntersectionArea(rect, tri), 9);
    }
  });

  it('polygonsOverlap nutzt die exakte Fläche (das gestapelte Paar wird jetzt erkannt, Berührung nicht)', () => {
    expect(polygonsOverlap(P([[3.5, 4], [5.5, 4], [5.5, 7.5], [3.5, 7.5]]), P([[3.5, 1.5], [5.5, 1.5], [5.5, 5.5], [3.5, 5.5]]))).toBe(true);
    expect(polygonsOverlap(P([[0, 0], [8, 0], [0, 8]]), P([[8, 0], [8, 8], [0, 8]]))).toBe(false);
  });
});

describe('polygonDistance und isSimple', () => {
  it('Abstände: Fuge, Berührung, Kreuzung, Enthaltensein', () => {
    expect(polygonDistance(P([[0, 0], [3.5, 0], [3.5, 8], [0, 8]]), P([[4.5, 0], [8, 0], [8, 8], [4.5, 8]]))).toBeCloseTo(1, 12);
    expect(polygonDistance(P([[0, 0], [8, 0], [0, 8]]), P([[8, 0], [8, 8], [0, 8]]))).toBe(0);
    expect(polygonDistance(P([[0, 0], [4, 0], [4, 4], [0, 4]]), P([[2, -1], [3, -1], [3, 5], [2, 5]]))).toBe(0); // Kreuz ohne Ecke im anderen
    expect(polygonDistance(P([[0, 0], [8, 0], [8, 8], [0, 8]]), P([[2, 2], [3, 2], [3, 3]]))).toBe(0);
    // Diagonalteilung mit Fuge g: Abstand der Dreiecke = g
    for (const g of [0.5, 1, 1.5, 3]) {
      const [p, q] = diagA({ x: 10, y: 20, w: 8, h: 5 }, g);
      expect(polygonDistance(p, q)).toBeCloseTo(g, 9);
    }
  });

  it('isSimple erkennt auch Selbstberührung (Ecke auf Kante) und zurücklaufende Kanten', () => {
    expect(isSimple(P([[0, 0], [4, 0], [4, 4], [0, 4]]))).toBe(true);
    expect(isSimple(P([[0, 0], [4, 4], [4, 0], [0, 4]]))).toBe(false); // Schleife
    expect(isSimple(P([[0, 0], [4, 0], [4, 4], [2, 0], [0, 4]]))).toBe(false); // Ecke auf Kante
    expect(isSimple(P([[0, 0], [4, 0], [2, 0], [2, 3]]))).toBe(false); // läuft auf sich zurück
    expect(isSimple(P([[0, 0], [8, 0], [8, 2], [2, 2], [2, 8], [0, 8]]))).toBe(true);
  });
});

// ================================================================ Prüfung der Freiformteile

describe('validateFreePieces: typisierte Befunde', () => {
  it('zwei 8×5-Streifen, die sich in einer 8×8-Zelle überlappen, werden abgelehnt', () => {
    const v = validateFreePieces(8, 8, fp([[0, 0], [8, 0], [8, 5], [0, 5]], [[0, 3], [8, 3], [8, 8], [0, 8]]), 2, 1);
    expect(v.ok).toBe(false);
    expect(v.errors).toHaveLength(1);
    const e = v.errors[0];
    expect(e.code).toBe('overlap');
    if (e.code === 'overlap') {
      expect([e.a, e.b]).toEqual([1, 2]);
      expect(e.areaMm2).toBeCloseTo(16, 9);
    }
  });

  it('das früher übersehene gestapelte Paar wird abgelehnt (3 mm²)', () => {
    const v = validateFreePieces(8, 8, fp([[3.5, 4], [5.5, 4], [5.5, 7.5], [3.5, 7.5]], [[3.5, 1.5], [5.5, 1.5], [5.5, 5.5], [3.5, 5.5]]), 0, 0);
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual([{ code: 'overlap', a: 1, b: 2, areaMm2: expect.closeTo(3, 9) }]);
  });

  it('zwei Dreiecke an einer Diagonale mit 1 mm Fuge werden ohne Befund angenommen', () => {
    const [p, q] = diagA({ x: 0, y: 0, w: 8, h: 8 }, 1);
    const v = validateFreePieces(8, 8, [{ poly: p, color: 0 }, { poly: q, color: 1 }], 2, 1);
    expect(v).toEqual({ ok: true, errors: [], warnings: [] });
    // eine saubere senkrechte Teilung mit 1 mm Fuge ebenso
    expect(validateFreePieces(8, 8, fp([[0, 0], [3.5, 0], [3.5, 8], [0, 8]], [[4.5, 0], [8, 0], [8, 8], [4.5, 8]]), 2, 1)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('sich berührende Teile: Warnung „Fuge“ (0 mm), kein Fehler', () => {
    const v = validateFreePieces(8, 8, fp([[0, 0], [8, 0], [0, 8]], [[8, 0], [8, 8], [0, 8]]), 2, 1);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([{ code: 'gap', a: 1, b: 2, gapMm: 0, jointMm: 1 }]);
  });

  it('Fugenwarnung nur unter Projektfuge − 0,01 mm; ohne Fuge keine Fugenprüfung', () => {
    const pair = (gap: number) => fp([[0, 0], [4 - gap / 2, 0], [4 - gap / 2, 8], [0, 8]], [[4 + gap / 2, 0], [8, 0], [8, 8], [4 + gap / 2, 8]]);
    const gapOf = (v: ReturnType<typeof validateFreePieces>) => v.warnings.find((w) => w.code === 'gap');
    expect(gapOf(validateFreePieces(8, 8, pair(0), 1, 1.5))).toMatchObject({ gapMm: 0, jointMm: 1.5 });
    expect(gapOf(validateFreePieces(8, 8, pair(0.5), 1, 1.5))).toMatchObject({ gapMm: expect.closeTo(0.5, 9) });
    expect(gapOf(validateFreePieces(8, 8, pair(1.495), 1, 1.5))).toBeUndefined();
    expect(gapOf(validateFreePieces(8, 8, pair(1.5), 1, 1.5))).toBeUndefined();
    expect(validateFreePieces(8, 8, pair(0), 1, 0).warnings).toEqual([]);
    // schräger Abstand: Ecke zu Kante
    const tri = fp([[0, 0], [8, 0], [0, 8]], [[8, 1], [8, 8], [1, 8]]);
    const w = gapOf(validateFreePieces(8, 8, tri, 1, 1));
    expect(w).toMatchObject({ gapMm: expect.closeTo(1 / Math.SQRT2, 9) });
  });

  it('Fehlercodes mit Teilnummern ab 1', () => {
    expect(codes(validateFreePieces(8, 8, [], 1).errors)).toEqual(['noPieces']);
    const many = Array.from({ length: MAX_FREE_PIECES + 1 }, (_, i) => ({ poly: rectPoly((i % 4) * 2, Math.floor(i / 4) * 1.6, 1.5, 1.2), color: 0 }));
    expect(validateFreePieces(8, 8, many, 0).errors[0]).toEqual({ code: 'tooMany', max: 16, count: 17 });
    const v = validateFreePieces(
      8,
      8,
      fp(
        [[0, 0], [2, 0], [2, 2], [0, 2]], // ok
        [[4, 0], [5, 0]], // zu wenige Punkte
        [[3, 3], [7, 7], [7, 3], [3, 7]], // Schleife
        [[6, 6], [9, 6], [9, 8], [6, 8]], // außerhalb
        [[0, 7], [0.4, 7], [0.4, 7.4], [0, 7.4]], // 0,16 mm²
      ),
      0,
    );
    expect(v.errors).toEqual([
      { code: 'tooFewPoints', piece: 2, count: 2 },
      { code: 'selfIntersect', piece: 3 },
      { code: 'outside', piece: 4 },
      { code: 'areaTooSmall', piece: 5, areaMm2: expect.closeTo(0.16, 9), minMm2: 0.25 },
    ]);
    expect(v.ok).toBe(false);
  });

  it('dünne Teile: Warnung mit gemessener schmalster Stelle und Inkreismaß', () => {
    const v = validateFreePieces(8, 8, fp([[0, 0], [8, 0], [8, 1], [0, 1]]), 2, 0);
    expect(v.ok).toBe(true);
    expect(v.warnings).toEqual([{ code: 'thin', piece: 1, minMm: 2, caliperMm: expect.closeTo(1, 9), incircleMm: expect.closeTo((4 * 8) / 18, 9), convex: true }]);
  });

  it('freeIssuePieces liefert die betroffenen Teile als Index ab 0', () => {
    expect(freeIssuePieces({ code: 'overlap', a: 1, b: 3, areaMm2: 2 })).toEqual([0, 2]);
    expect(freeIssuePieces({ code: 'outside', piece: 2 })).toEqual([1]);
    expect(freeIssuePieces({ code: 'noPieces' })).toEqual([]);
  });

  it('jeder Befund wird in DE, EN und TR vollständig übersetzt (keine offenen Platzhalter)', () => {
    const all: FreeIssue[] = [
      { code: 'noPieces' },
      { code: 'tooMany', max: 16, count: 17 },
      { code: 'tooFewPoints', piece: 1, count: 2 },
      { code: 'selfIntersect', piece: 2 },
      { code: 'outside', piece: 3 },
      { code: 'areaTooSmall', piece: 1, areaMm2: 0.1, minMm2: 0.25 },
      { code: 'overlap', a: 1, b: 3, areaMm2: 2.5 },
      { code: 'thin', piece: 2, minMm: 2, caliperMm: 1.2, incircleMm: 1.1, convex: false },
      { code: 'gap', a: 1, b: 2, gapMm: 0.4, jointMm: 1 },
      { code: 'gap', a: 1, b: 2, gapMm: 0, jointMm: 1 },
    ];
    for (const lang of ['de', 'en', 'tr'] as const) {
      const t = makeT(lang);
      for (const is of all) {
        const s = freeIssueText(is, t, (v, d = 0) => v.toFixed(d), 8, 8);
        expect(s).not.toMatch(/\{\w+\}/);
        expect(s).not.toMatch(/^free\./);
      }
    }
    const de = makeT('de');
    const n = (v: number, d = 0) => v.toFixed(d).replace('.', ',');
    expect(freeIssueText({ code: 'overlap', a: 1, b: 3, areaMm2: 2.5 }, de, n, 8, 8)).toMatch(/^Teil 1 und Teil 3 überlappen sich \(2,50 mm²\)/);
    expect(freeIssueText({ code: 'gap', a: 1, b: 2, gapMm: 0.4, jointMm: 1 }, de, n, 8, 8)).toBe('Fuge zwischen Teil 1 und Teil 2 nur 0,40 mm (Projektfuge 1,00 mm).');
    expect(freeIssueText({ code: 'gap', a: 1, b: 2, gapMm: 0, jointMm: 1 }, de, n, 8, 8)).toMatch(/berühren sich/);
  });

  it('edit.lineHint nennt die Richtungen genau so, wie lineSplit sie schneidet', () => {
    const d = dictionaries.de as Record<string, string>;
    expect(d['edit.lineHint']).toMatch(/0° = senkrecht/);
    expect(d['edit.lineHint']).toMatch(/45° = ╱/);
    expect(d['edit.lineHint']).toMatch(/90° = waagerecht/);
    expect(d['edit.lineHint']).toMatch(/135° = ╲/);
    const r = { x: 0, y: 0, w: 10, h: 10 };
    const dir = (deg: number) => {
      const a = (deg * Math.PI) / 180;
      const [p] = lineSplit(r, Math.cos(a), Math.sin(a), 0, 0);
      // Schnittkante = Kante von p, die nicht auf dem Zellrand liegt
      const n = p.length;
      for (let i = 0; i < n; i++) {
        const u = p[i];
        const v = p[(i + 1) % n];
        const onBorder = (Math.abs(u.x - v.x) < 1e-9 && (Math.abs(u.x) < 1e-9 || Math.abs(u.x - 10) < 1e-9)) || (Math.abs(u.y - v.y) < 1e-9 && (Math.abs(u.y) < 1e-9 || Math.abs(u.y - 10) < 1e-9));
        if (!onBorder) return { dx: v.x - u.x, dy: v.y - u.y };
      }
      return null;
    };
    const kind = (deg: number) => {
      const e = dir(deg)!;
      if (Math.abs(e.dx) < 1e-9) return '│';
      if (Math.abs(e.dy) < 1e-9) return '─';
      // y nach unten: gleiche Vorzeichen = von oben links nach unten rechts (╲)
      return Math.sign(e.dx) === Math.sign(e.dy) ? '╲' : '╱';
    };
    expect([kind(0), kind(45), kind(90), kind(135)]).toEqual(['│', '╱', '─', '╲']);
    // positiver Versatz bei 0° verschiebt die Linie nach rechts
    const [left] = lineSplit(r, 1, 0, 1, 0);
    expect(Math.max(...left.map((q) => q.x))).toBeCloseTo(6, 9);
  });
});

describe('snapFreePoint', () => {
  it('rastet an den Zellrand (≤ 0,2 mm), rundet sonst auf 0,1 mm und begrenzt auf die Zelle', () => {
    expect(snapFreePoint({ x: 0.19, y: 4.81 }, 5, 5)).toEqual({ x: 0, y: 5 });
    expect(snapFreePoint({ x: 0.26, y: 2.34 }, 5, 5)).toEqual({ x: 0.3, y: 2.3 });
    expect(snapFreePoint({ x: -3, y: 9 }, 5, 5)).toEqual({ x: 0, y: 5 });
    // Randzelle mit krummem Maß: der Rand bleibt exakt
    expect(snapFreePoint({ x: 4.3, y: 1 }, 4.37, 5)).toEqual({ x: 4.37, y: 1 });
    expect(snapFreePoint({ x: 4.12, y: 1 }, 4.37, 5)).toEqual({ x: 4.1, y: 1 });
    expect(snapFreePoint({ x: NaN, y: 1 }, 4, 5)).toEqual({ x: 0, y: 1 });
  });
});

// ================================================================ Vorlagen

describe('freePreset', () => {
  const sizes: [number, number][] = [[2, 2], [3, 5], [5, 5], [8, 8], [6, 10], [12, 8]];
  const joints = [0, 0.5, 1, 1.5, 2, 3];

  it('jede Vorlage ist für jede mögliche Zellgröße und Fuge gültig – ohne Fehler und ohne Fugenwarnung', () => {
    let checked = 0;
    for (const [w, h] of sizes)
      for (const g of joints)
        for (const k of FREE_PRESET_KINDS) {
          const polys = freePreset(k, w, h, g);
          if (!polys) {
            // nur, wenn die Fuge ein Teil verschluckt
            expect(['diagA', 'diagB', 'half', 'trapezoid']).toContain(k);
            expect(g).toBeGreaterThan(0);
            continue;
          }
          const v = validateFreePieces(w, h, polys.map((poly, i) => ({ poly, color: i })), 0, g);
          expect(v.errors, `${k} ${w}×${h} g${g}`).toEqual([]);
          expect(v.warnings.filter((x) => x.code === 'gap'), `${k} ${w}×${h} g${g}`).toEqual([]);
          checked++;
        }
    expect(checked).toBeGreaterThan(180);
  });

  it('Formen, Teilzahl und Flächen stimmen', () => {
    const shapes = (k: (typeof FREE_PRESET_KINDS)[number]) => freePreset(k, 8, 6, 1)!.map((p) => classifyShape(p));
    expect(shapes('full')).toEqual(['rectangle']);
    expect(shapes('diagA')).toEqual(['triangle', 'triangle']);
    expect(shapes('diagB')).toEqual(['triangle', 'triangle']);
    expect(shapes('half')).toEqual(['rectangle', 'rectangle']);
    expect(shapes('rhombus')).toEqual(['rhombus']);
    expect(shapes('trapezoid')).toEqual(['trapezoid', 'trapezoid']);
    const half = freePreset('half', 8, 6, 1)!;
    expect(half.map(area)).toEqual([expect.closeTo(3.5 * 6, 9), expect.closeTo(3.5 * 6, 9)]);
    // hohe Zelle: waagerecht halbiert
    const tall = freePreset('half', 4, 9, 1)!;
    expect(tall.map(area)).toEqual([expect.closeTo(4 * 4, 9), expect.closeTo(4 * 4, 9)]);
    expect(area(freePreset('rhombus', 8, 6, 1)![0])).toBeCloseTo(24, 9);
    // dieselbe Geometrie wie die Formknöpfe „Dreiecke ╲“
    expect(freePreset('diagA', 8, 6, 1)!.map(area)).toEqual(diagA({ x: 0, y: 0, w: 8, h: 6 }, 1).map(area));
  });

  it('null, wenn die Fuge breiter als die Zelle ist', () => {
    expect(freePreset('half', 2, 2, 3)).toBeNull();
    expect(freePreset('diagA', 1, 1, 3)).toBeNull();
    expect(freePreset('full', 2, 2, 3)).not.toBeNull();
  });
});

// ================================================================ Übernahme bestehender Zellen in den Editor

describe('Rundreise: Zellen im Editor öffnen', () => {
  const tiles: [number, number][] = [[3, 3], [5, 5], [8, 8], [4, 8], [6, 10], [12, 12]];
  const joints = [0.5, 1, 1.5, 2, 3];

  it('jede Diagonal-, Unterteilungs- und Kantenschnittzelle prüft fehlerfrei und ohne Fugenwarnung – und bleibt beim Speichern gleich', () => {
    let cells = 0;
    for (const [tw, th] of tiles)
      for (const g of joints) {
        // Randmodus „Rand zuschneiden“: auch Randzellen mit krummem Maß und Zellen fern vom Ursprung
        const layout = computeLayout({ widthMm: 3 * tw + 2 * g + 1.37, heightMm: 2 * th + g + 0.83, tileW: tw, tileH: th, joint: g, edgeMode: 'cut-end', minCutMm: 0.5 });
        const changes: KindChange[] = [
          { kind: CellKind.DIAG_A },
          { kind: CellKind.DIAG_B },
          { kind: CellKind.SUB, k: 2 },
          { kind: CellKind.SUB, k: 3 },
          ...Array.from({ length: 12 }, (_, i) => [-1, 0, 0.5].map((d): KindChange => ({ kind: CellKind.LINE, angleDeg: i * 15, offsetMm: d }))).flat(),
        ];
        for (let row = 0; row < layout.rows; row++)
          for (let col = 0; col < layout.cols; col++)
            for (const ch of changes) {
              const data = createEmptyMosaic(layout.cols, layout.rows);
              const idx = row * layout.cols + col;
              data.c1[idx] = 1;
              data.c2[idx] = 2;
              if (setCellKind(layout, data, row, col, ch, 1) !== null) continue;
              const r = cellRect(layout, row, col);
              const init = freeEditorPieces(layout, data, row, col);
              const v = validateFreePieces(r.w, r.h, init, 1, layout.joint);
              expect(v.errors, `${tw}×${th} g${g} ${row}/${col} ${JSON.stringify(ch)}`).toEqual([]);
              expect(v.warnings, `${tw}×${th} g${g} ${row}/${col} ${JSON.stringify(ch)}`).toEqual([]);
              const before = cellPieces(layout, data, row, col);
              const sv = setFreePieces(layout, data, row, col, init, 1);
              expect(sv.ok).toBe(true);
              const after = cellPieces(layout, data, row, col);
              expect(after.length).toBe(before.length);
              after.forEach((q, i) => {
                expect(area(q.poly)).toBeCloseTo(area(before[i].poly), 9);
                expect(q.color).toBe(before[i].color);
              });
              // gespeicherte Freiformzelle öffnet unverändert
              expect(freeEditorPieces(layout, data, row, col)).toEqual(data.free.get(idx)!.map((f) => ({ poly: f.poly, color: f.color })));
              cells++;
            }
      }
    expect(cells).toBeGreaterThan(2000);
  });
});

// ================================================================ Speichern und Statistik

describe('setFreePieces und Flächenbilanz', () => {
  const layout = computeLayout({ widthMm: 26, heightMm: 17, tileW: 8, tileH: 8, joint: 1, edgeMode: 'whole', minCutMm: 2 });
  const palette: PaletteColor[] = [0, 1, 2, 3].map((i) => ({ code: i + 1, hex: '#808080', lab: [53.59, 0, 0], name: `F${i}` }));
  const STATS_OPTS = { reservePct: 0, groutDepthMm: 3 };

  it('überlappende Teile werden nicht gespeichert (die Fugenfläche kann nicht mehr negativ werden)', () => {
    const data = createEmptyMosaic(layout.cols, layout.rows);
    const before = computeStats(layout, data, palette, [], STATS_OPTS);
    const v = setFreePieces(layout, data, 0, 0, fp([[0, 0], [8, 0], [8, 5], [0, 5]], [[0, 3], [8, 3], [8, 8], [0, 8]]), 2);
    expect(v.ok).toBe(false);
    expect(data.kind[0]).toBe(CellKind.FULL);
    const after = computeStats(layout, data, palette, [], STATS_OPTS);
    expect(after.stoneArea).toBe(before.stoneArea);
    expect(after.jointArea).toBeGreaterThan(0);
  });

  it('sich berührende Teile werden mit Warnung gespeichert; die Projektfuge wird geprüft', () => {
    const data = createEmptyMosaic(layout.cols, layout.rows);
    const v = setFreePieces(layout, data, 0, 1, fp([[0, 0], [8, 0], [0, 8]], [[8, 0], [8, 8], [0, 8]]), 2);
    expect(v.ok).toBe(true);
    expect(v.warnings).toEqual([{ code: 'gap', a: 1, b: 2, gapMm: 0, jointMm: 1 }]);
    expect(data.kind[1]).toBe(CellKind.FREE);
  });

  it('zufällige Freiform-Änderungen: je Zelle Σ Teilflächen ≤ Zellfläche, Steinfläche ≤ Σ Zellflächen', () => {
    const r = rng(42);
    const g = () => Math.round(r() * 16) / 2;
    const data = createEmptyMosaic(layout.cols, layout.rows);
    let accepted = 0;
    let rejected = 0;
    for (let it = 0; it < 600; it++) {
      const row = Math.floor(r() * layout.rows);
      const col = Math.floor(r() * layout.cols);
      const cr = cellRect(layout, row, col);
      const nPieces = 1 + Math.floor(r() * 3);
      const pieces: FreePiece[] = [];
      for (let k = 0; k < nPieces; k++) {
        if (r() < 0.5) {
          const [x1, x2] = [g(), g()].sort((u, v) => u - v);
          const [y1, y2] = [g(), g()].sort((u, v) => u - v);
          pieces.push({ poly: rectPoly(Math.min(x1, cr.w), Math.min(y1, cr.h), Math.min(x2, cr.w) - Math.min(x1, cr.w), Math.min(y2, cr.h) - Math.min(y1, cr.h)), color: k });
        } else pieces.push({ poly: P([[Math.min(g(), cr.w), Math.min(g(), cr.h)], [Math.min(g(), cr.w), Math.min(g(), cr.h)], [Math.min(g(), cr.w), Math.min(g(), cr.h)]]), color: k });
      }
      const v = setFreePieces(layout, data, row, col, pieces, 0.5);
      if (v.ok) accepted++;
      else rejected++;
    }
    expect(accepted).toBeGreaterThan(30);
    expect(rejected).toBeGreaterThan(30);
    let sumCells = 0;
    for (let row = 0; row < layout.rows; row++)
      for (let col = 0; col < layout.cols; col++) {
        const cr = cellRect(layout, row, col);
        sumCells += cr.w * cr.h;
        const ps = cellPieces(layout, data, row, col);
        expect(ps.reduce((s, q) => s + area(q.poly), 0)).toBeLessThanOrEqual(cr.w * cr.h + 1e-6);
        for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) expect(polygonIntersectionArea(ps[i].poly, ps[j].poly)).toBeLessThanOrEqual(0.01);
      }
    const st = computeStats(layout, data, palette, [], STATS_OPTS);
    expect(st.stoneArea).toBeLessThanOrEqual(sumCells + 1e-6);
    // Fugenfläche mindestens die Fläche zwischen den Zellen
    expect(st.jointArea).toBeGreaterThanOrEqual(st.finishedArea - sumCells - 1e-6);
  });
});
