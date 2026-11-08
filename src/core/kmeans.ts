/**
 * Gewichtetes K-Means (k-means++ Initialisierung) im CIELAB-Raum.
 */
import type { Lab } from './color';

export interface KMeansResult {
  centers: Lab[];
  /** Summe der Gewichte je Zentrum */
  weights: number[];
  iterations: number;
  /** nur mit festen Zentren: Summe der Gewichte je festem Zentrum (gleiche Reihenfolge wie übergeben) */
  fixedWeights?: number[];
}

/** Deterministischer Zufallsgenerator (Mulberry32), damit Ergebnisse reproduzierbar sind. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param pts  Lab-Punkte als flaches Array [L,a,b, L,a,b, …]
 * @param w    Gewichte je Punkt
 */
export function kmeansLab(pts: Float32Array, w: Float32Array, k: number, maxIter = 30, seed = 1): KMeansResult {
  const n = w.length;
  if (n === 0) return { centers: [], weights: [], iterations: 0 };
  k = Math.min(k, n);
  const rand = rng(seed);
  const C = new Float64Array(k * 3);
  const dist = new Float64Array(n).fill(Infinity);

  // k-means++
  let totalW = 0;
  for (let i = 0; i < n; i++) totalW += w[i];
  let r = rand() * totalW;
  let first = 0;
  for (let i = 0; i < n; i++) {
    r -= w[i];
    if (r <= 0) {
      first = i;
      break;
    }
  }
  C[0] = pts[first * 3];
  C[1] = pts[first * 3 + 1];
  C[2] = pts[first * 3 + 2];
  for (let c = 1; c < k; c++) {
    const cl = C[(c - 1) * 3];
    const ca = C[(c - 1) * 3 + 1];
    const cb = C[(c - 1) * 3 + 2];
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const dl = pts[i * 3] - cl;
      const da = pts[i * 3 + 1] - ca;
      const db = pts[i * 3 + 2] - cb;
      const d = dl * dl + da * da + db * db;
      if (d < dist[i]) dist[i] = d;
      sum += dist[i] * w[i];
    }
    if (sum <= 0) {
      // alle Punkte bereits abgedeckt → restliche Zentren duplizieren nicht sinnvoll
      return finalize(C, c, pts, w, 0);
    }
    let t = rand() * sum;
    let pick = n - 1;
    for (let i = 0; i < n; i++) {
      t -= dist[i] * w[i];
      if (t <= 0) {
        pick = i;
        break;
      }
    }
    C[c * 3] = pts[pick * 3];
    C[c * 3 + 1] = pts[pick * 3 + 1];
    C[c * 3 + 2] = pts[pick * 3 + 2];
  }

  // Lloyd
  const assign = new Int32Array(n);
  const sums = new Float64Array(k * 3);
  const cw = new Float64Array(k);
  let iter = 0;
  for (; iter < maxIter; iter++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const l = pts[i * 3];
      const a = pts[i * 3 + 1];
      const b = pts[i * 3 + 2];
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dl = l - C[c * 3];
        const da = a - C[c * 3 + 1];
        const db = b - C[c * 3 + 2];
        const d = dl * dl + da * da + db * db;
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      if (assign[i] !== best || iter === 0) changed++;
      assign[i] = best;
    }
    sums.fill(0);
    cw.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      const wi = w[i];
      sums[c * 3] += pts[i * 3] * wi;
      sums[c * 3 + 1] += pts[i * 3 + 1] * wi;
      sums[c * 3 + 2] += pts[i * 3 + 2] * wi;
      cw[c] += wi;
    }
    for (let c = 0; c < k; c++) {
      if (cw[c] > 0) {
        C[c * 3] = sums[c * 3] / cw[c];
        C[c * 3 + 1] = sums[c * 3 + 1] / cw[c];
        C[c * 3 + 2] = sums[c * 3 + 2] / cw[c];
      } else {
        // leeres Cluster: auf den am schlechtesten abgedeckten Punkt setzen
        let worst = 0;
        let wd = -1;
        for (let i = 0; i < n; i++) {
          const a = assign[i];
          const dl = pts[i * 3] - C[a * 3];
          const da = pts[i * 3 + 1] - C[a * 3 + 1];
          const db = pts[i * 3 + 2] - C[a * 3 + 2];
          const d = (dl * dl + da * da + db * db) * w[i];
          if (d > wd) {
            wd = d;
            worst = i;
          }
        }
        C[c * 3] = pts[worst * 3];
        C[c * 3 + 1] = pts[worst * 3 + 1];
        C[c * 3 + 2] = pts[worst * 3 + 2];
        changed++;
      }
    }
    if (changed === 0) break;
  }
  return finalize(C, k, pts, w, iter);
}

/**
 * K-Means mit festen Zentren (z. B. Pflichtfarben), ausgehend von einer fertigen Lösung ohne sie:
 *  1. Aus `start` (Zentren eines gewöhnlichen kmeansLab-Laufs) werden `drop` Zentren entfernt – jeweils das, dessen
 *     Wegfall die gewichtete Summe der quadrierten Abstände am wenigsten erhöht (die festen Zentren zählen dabei mit).
 *  2. Lloyd-Iterationen: Die festen Zentren nehmen an der Zuordnung teil, werden aber nie verschoben.
 * So ändert eine Pflichtfarbe die übrige Palette so wenig wie möglich (kein neuer Zufallsstart). Rückgabe: nur die
 * freien Zentren (ohne leere), `fixedWeights` = Gewicht je festem Zentrum (Reihenfolge wie übergeben). Deterministisch.
 */
export function kmeansLabFixed(pts: Float32Array, w: Float32Array, start: readonly Lab[], fixed: readonly Lab[], drop: number, maxIter = 30): KMeansResult {
  const n = w.length;
  const F = fixed.length;
  const free: Lab[] = start.map((c) => [c[0], c[1], c[2]]);
  const sq = (i: number, c: Lab) => {
    const dl = pts[i * 3] - c[0];
    const da = pts[i * 3 + 1] - c[1];
    const db = pts[i * 3 + 2] - c[2];
    return dl * dl + da * da + db * db;
  };
  // 1. günstigste Zentren entfernen (nächstes/zweitnächstes über freie + feste Zentren)
  for (let r = 0; r < drop && free.length > 0; r++) {
    const all = [...free, ...fixed];
    const loss = new Float64Array(free.length);
    for (let i = 0; i < n; i++) {
      let b1 = Infinity;
      let b2 = Infinity;
      let i1 = -1;
      for (let c = 0; c < all.length; c++) {
        const d = sq(i, all[c]);
        if (d < b1) {
          b2 = b1;
          b1 = d;
          i1 = c;
        } else if (d < b2) b2 = d;
      }
      if (i1 >= 0 && i1 < free.length) loss[i1] += w[i] * ((Number.isFinite(b2) ? b2 : b1) - b1);
    }
    let worst = 0;
    for (let c = 1; c < free.length; c++) if (loss[c] < loss[worst]) worst = c;
    free.splice(worst, 1);
  }
  const k = free.length;
  const KK = k + F;
  const C = new Float64Array(KK * 3);
  free.forEach((c, i) => C.set(c, i * 3));
  fixed.forEach((c, f) => C.set(c, (k + f) * 3));
  const nearestOf = (i: number) => {
    const l = pts[i * 3];
    const a = pts[i * 3 + 1];
    const b = pts[i * 3 + 2];
    let best = 0;
    let bd = Infinity;
    for (let c = 0; c < KK; c++) {
      const dl = l - C[c * 3];
      const da = a - C[c * 3 + 1];
      const db = b - C[c * 3 + 2];
      const d = dl * dl + da * da + db * db;
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  };
  // 2. Lloyd: nur die freien Zentren bewegen
  const assign = new Int32Array(n);
  const sums = new Float64Array(KK * 3);
  const cw = new Float64Array(KK);
  let iter = 0;
  for (; iter < maxIter && k > 0 && n > 0; iter++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const best = nearestOf(i);
      if (assign[i] !== best || iter === 0) changed++;
      assign[i] = best;
    }
    sums.fill(0);
    cw.fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      const wi = w[i];
      sums[c * 3] += pts[i * 3] * wi;
      sums[c * 3 + 1] += pts[i * 3 + 1] * wi;
      sums[c * 3 + 2] += pts[i * 3 + 2] * wi;
      cw[c] += wi;
    }
    for (let c = 0; c < k; c++) {
      if (cw[c] > 0) {
        C[c * 3] = sums[c * 3] / cw[c];
        C[c * 3 + 1] = sums[c * 3 + 1] / cw[c];
        C[c * 3 + 2] = sums[c * 3 + 2] / cw[c];
      } else {
        // leeres Cluster: auf den am schlechtesten abgedeckten Punkt setzen
        let worst = 0;
        let wd = -1;
        for (let i = 0; i < n; i++) {
          const a = assign[i];
          const dl = pts[i * 3] - C[a * 3];
          const da = pts[i * 3 + 1] - C[a * 3 + 1];
          const db = pts[i * 3 + 2] - C[a * 3 + 2];
          const d = (dl * dl + da * da + db * db) * w[i];
          if (d > wd) {
            wd = d;
            worst = i;
          }
        }
        C[c * 3] = pts[worst * 3];
        C[c * 3 + 1] = pts[worst * 3 + 1];
        C[c * 3 + 2] = pts[worst * 3 + 2];
        changed++;
      }
    }
    if (changed === 0) break;
  }
  const weights = new Array<number>(KK).fill(0);
  for (let i = 0; i < n; i++) weights[nearestOf(i)] += w[i];
  const centers: Lab[] = [];
  const ws: number[] = [];
  for (let c = 0; c < k; c++) {
    if (weights[c] <= 0) continue;
    centers.push([C[c * 3], C[c * 3 + 1], C[c * 3 + 2]]);
    ws.push(weights[c]);
  }
  return { centers, weights: ws, iterations: iter, fixedWeights: weights.slice(k) };
}

function finalize(C: Float64Array, k: number, pts: Float32Array, w: Float32Array, iterations: number): KMeansResult {
  const weights = new Array<number>(k).fill(0);
  const n = w.length;
  for (let i = 0; i < n; i++) {
    let best = 0;
    let bd = Infinity;
    for (let c = 0; c < k; c++) {
      const dl = pts[i * 3] - C[c * 3];
      const da = pts[i * 3 + 1] - C[c * 3 + 1];
      const db = pts[i * 3 + 2] - C[c * 3 + 2];
      const d = dl * dl + da * da + db * db;
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    weights[best] += w[i];
  }
  const centers: Lab[] = [];
  const ws: number[] = [];
  for (let c = 0; c < k; c++) {
    if (weights[c] <= 0) continue;
    centers.push([C[c * 3], C[c * 3 + 1], C[c * 3 + 2]]);
    ws.push(weights[c]);
  }
  return { centers, weights: ws, iterations };
}
