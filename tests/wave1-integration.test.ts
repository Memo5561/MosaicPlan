/**
 * Welle 1 – Zusammenspiel der Pakete auf echten Beispielmosaiken:
 *  - w1-mosaic-core (beschleunigte Berechnung) + w1-cut-correctness (Mindestbreite):
 *    kein automatisch geplantes Schnittteil ist schmaler als minPieceMm.
 *  - w1-material-quantities: alle Zahlen endlich, kein „-0“, Summe je Farbe + ungültige = Steine gesamt,
 *    Rohsteine ≥ exakte Untergrenze.
 *  - w1-persistence: das berechnete Mosaik besteht die Integritätsprüfung gegen seine Palette.
 */
import { describe, expect, it } from 'vitest';
import { minCaliperWidth } from '../src/core/geometry';
import { checkMosaicIntegrity } from '../src/core/integrity';
import { computeMosaic } from '../src/core/mosaic';
import { cellPieces } from '../src/core/pieces';
import { computeStats } from '../src/core/stats';
import { DEFAULT_SHAPES } from '../src/core/types';
import { baseParams, sampleSetup } from './w1-mosaic-core.fixtures';

function nonFinite(o: unknown, path: string, out: string[]) {
  if (typeof o === 'number') {
    if (!Number.isFinite(o) || Object.is(o, -0)) out.push(`${path}=${o}`);
    return;
  }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (k !== 'material') nonFinite(v, `${path}.${k}`, out);
}

describe('Welle 1: Berechnung, Schnittregeln, Materialbedarf und Integrität zusammen', () => {
  for (const key of ['portrait', 'landscape']) {
    it(`Beispiel ${key}`, () => {
      const su = sampleSetup(key);
      const res = computeMosaic(su.img, baseParams(su));
      const L = su.layout;
      const min = DEFAULT_SHAPES.minPieceMm;

      let cut = 0;
      let narrow = 0;
      for (let r = 0; r < L.rows; r++)
        for (let c = 0; c < L.cols; c++) {
          const ps = cellPieces(L, res.data, r, c);
          if (ps.length < 2) continue;
          for (const p of ps) {
            cut++;
            if (minCaliperWidth(p.poly) < min - 1e-6) narrow++;
          }
        }
      expect(cut).toBeGreaterThan(0);
      expect(narrow).toBe(0);

      const st = computeStats(L, res.data, res.palette, [], { reservePct: 10, groutDepthMm: 3 });
      const bad: string[] = [];
      nonFinite(st, 'stats', bad);
      expect(bad).toEqual([]);
      expect(st.perColor.reduce((s, c) => s + c.pieces, 0) + st.invalidColorPieces).toBe(st.pieces);
      expect(st.invalidColorPieces).toBe(0);
      for (const cs of st.perColor) {
        expect(cs.raw).toBeGreaterThanOrEqual(Math.ceil(cs.rawExact - 1e-9));
        expect(cs.rawWithReserve).toBeGreaterThanOrEqual(cs.raw);
      }

      expect(checkMosaicIntegrity({ palette: res.palette }, res.data)).toEqual({ ok: true, reason: null });
    });
  }
});
