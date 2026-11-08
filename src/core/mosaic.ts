/**
 * Mosaikberechnung: Bildanalyse je Rasterzelle, Formwahl (ganzer Stein,
 * Dreiecke, Kantenschnitt, feinere Steine), Farbquantisierung (K-Means in
 * CIELAB) und Farbzuordnung (CIEDE2000).
 *
 * Die Berechnung läuft kachelweise (64×64 Zellen) und meldet Fortschritt.
 */
import { deltaE2000, deltaE76, labToHex, NearestColorMatcher, rgbToLabInto, describeColor, type Lab, type ColorNameLang } from './color';
import { regionMask, detailMap, type RGBAImage } from './imageOps';
import { kmeansLab } from './kmeans';
import type { Layout } from './layout';
import type { Pt } from './geometry';
import { cellRect, diagA, diagB, lineSplit, pieceCuttable, subRects } from './pieces';
import { CellKind, createEmptyMosaic, Rec, type MosaicData, type PaletteColor, type PaletteMode, type Region, type ShapeOptions } from './types';

export interface FixedColor {
  lab: Lab;
  hex: string;
  name: string;
  materialId?: string;
  /**
   * Farbnummer der eigenen Palette (nur Modus 'custom'). Sind alle Nummern eindeutige positive
   * ganze Zahlen, bleiben sie bei der Berechnung erhalten, sonst wird fortlaufend 1…n vergeben.
   */
  code?: number;
}

export interface ComputeParams {
  layout: Layout;
  shapes: ShapeOptions;
  paletteMode: PaletteMode;
  colorCount: number;
  /** 0 = aus, 1 = volles Floyd-Steinberg */
  dither: number;
  deltaE: '2000' | '76';
  /** Materialfarben (für 'materials' und 'auto-snap') bzw. eigene Palette ('custom') */
  fixedPalette?: FixedColor[];
  regions: Region[];
  lang?: ColorNameLang;
  seed?: number;
}

export interface ComputeDiagnostics {
  meanDeltaE: number;
  maxDeltaE: number;
  p95DeltaE: number;
  splitCells: number;
  subCells: number;
  recommendCells: number;
  timeMs: number;
  samplesPerCell: number;
}

export interface ComputeResult {
  data: MosaicData;
  palette: PaletteColor[];
  diagnostics: ComputeDiagnostics;
}

export type ProgressFn = (phase: 'lab' | 'analyze' | 'palette' | 'assign', fraction: number) => void;

const TILE = 64;
const ANGLES = Array.from({ length: 12 }, (_, i) => (i * 15 * Math.PI) / 180);

/** Lab-Bild (Float32, interleaved). Transparente Pixel → Weiß. */
export function imageToLab(img: RGBAImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n * 3);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3];
    if (a < 128) {
      out[i * 3] = 100;
      out[i * 3 + 1] = 0;
      out[i * 3 + 2] = 0;
    } else rgbToLabInto(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], out, i * 3);
  }
  return out;
}

/** Einfache Hautton-Erkennung in CIELAB. */
export function isSkinLab(L: number, a: number, b: number): boolean {
  if (L < 25 || L > 95) return false;
  const C = Math.sqrt(a * a + b * b);
  if (C < 8 || C > 55) return false;
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return h >= 18 && h <= 75;
}

// Quantisierte Lab-Speicherung (3 Byte/Farbe): Fehler < 0,5 ΔE.
function qL(v: number) {
  return Math.max(0, Math.min(255, Math.round(v * 2.55)));
}
function qAB(v: number) {
  return Math.max(0, Math.min(255, Math.round(v + 128)));
}

interface SSEGroup {
  n: number;
  sl: number;
  sa: number;
  sb: number;
  sq: number;
}
function sse(g: SSEGroup): number {
  if (g.n === 0) return 0;
  return g.sq - (g.sl * g.sl + g.sa * g.sa + g.sb * g.sb) / g.n;
}
function newGroup(): SSEGroup {
  return { n: 0, sl: 0, sa: 0, sb: 0, sq: 0 };
}

export function computeMosaic(img: RGBAImage, params: ComputeParams, onProgress?: ProgressFn): ComputeResult {
  const t0 = Date.now();
  const { layout, shapes } = params;
  const { cols, rows } = layout;
  const N = cols * rows;
  const W = img.width;
  const H = img.height;
  const g = layout.joint;
  const lang = params.lang ?? 'de';

  onProgress?.('lab', 0);
  const lab = imageToLab(img);
  const dmap = shapes.autoDetail ? detailMap(img) : null;
  const faceMask = params.regions.some((r) => r.type === 'face') ? regionMask(W, H, params.regions, ['face']) : null;
  const detMask = params.regions.some((r) => r.type === 'detail') ? regionMask(W, H, params.regions, ['detail']) : null;
  onProgress?.('lab', 1);

  const anyShape = shapes.diagonal || shapes.line || shapes.subdivide;
  const S = anyShape ? 6 : N > 3_000_000 ? 3 : 4;
  const NS = S * S;
  const sx = W / layout.finishedW;
  const sy = H / layout.finishedH;

  const data = createEmptyMosaic(cols, rows);
  const c1Lab = new Uint8Array(N * 3);
  const c2Lab = new Uint8Array(anyShape ? N * 3 : 0);
  const subLab = new Map<number, Float32Array>();
  const weight = new Float32Array(N).fill(1);

  const thr = 3 + (1 - Math.max(0, Math.min(1, shapes.detailLevel))) * 12;
  const baseLambda = thr * thr;
  const recK = S % shapes.subdivK === 0 ? shapes.subdivK : 2;

  // Arbeitsspeicher für Stichproben
  const SL = new Float32Array(NS);
  const SA = new Float32Array(NS);
  const SB = new Float32Array(NS);
  const PX = new Float32Array(NS); // mm relativ zur Zellmitte
  const PY = new Float32Array(NS);
  const order = new Int32Array(NS);
  const T = new Float32Array(NS);

  let splitCells = 0;
  let subCells = 0;
  let recommendCells = 0;

  const sampleCell = (row: number, col: number) => {
    const x0 = layout.colX[col];
    const y0 = layout.rowY[row];
    const cw = layout.colW[col];
    const ch = layout.rowH[row];
    let k = 0;
    for (let j = 0; j < S; j++) {
      const my = (j + 0.5) / S;
      const py = (y0 + my * ch) * sy - 0.5;
      const iy = Math.max(0, Math.min(H - 1, Math.floor(py)));
      const iy1 = Math.min(H - 1, iy + 1);
      const fy = Math.max(0, Math.min(1, py - iy));
      for (let i = 0; i < S; i++, k++) {
        const mx = (i + 0.5) / S;
        const px = (x0 + mx * cw) * sx - 0.5;
        const ix = Math.max(0, Math.min(W - 1, Math.floor(px)));
        const ix1 = Math.min(W - 1, ix + 1);
        const fx = Math.max(0, Math.min(1, px - ix));
        const a = (iy * W + ix) * 3;
        const b = (iy * W + ix1) * 3;
        const c = (iy1 * W + ix) * 3;
        const d = (iy1 * W + ix1) * 3;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        SL[k] = lab[a] * w00 + lab[b] * w10 + lab[c] * w01 + lab[d] * w11;
        SA[k] = lab[a + 1] * w00 + lab[b + 1] * w10 + lab[c + 1] * w01 + lab[d + 1] * w11;
        SB[k] = lab[a + 2] * w00 + lab[b + 2] * w10 + lab[c + 2] * w01 + lab[d + 2] * w11;
        PX[k] = (mx - 0.5) * cw;
        PY[k] = (my - 0.5) * ch;
      }
    }
  };

  const groupOf = (indices: (k: number) => number, count: number): SSEGroup[] => {
    const gs: SSEGroup[] = Array.from({ length: count }, newGroup);
    for (let k = 0; k < NS; k++) {
      const gi = indices(k);
      if (gi < 0) continue;
      const gg = gs[gi];
      gg.n++;
      gg.sl += SL[k];
      gg.sa += SA[k];
      gg.sb += SB[k];
      gg.sq += SL[k] * SL[k] + SA[k] * SA[k] + SB[k] * SB[k];
    }
    return gs;
  };
  const meanOf = (gg: SSEGroup): Lab => (gg.n ? [gg.sl / gg.n, gg.sa / gg.n, gg.sb / gg.n] : [50, 0, 0]);

  const totalTiles = Math.ceil(cols / TILE) * Math.ceil(rows / TILE);
  let tileDone = 0;

  for (let ty = 0; ty < rows; ty += TILE) {
    for (let tx = 0; tx < cols; tx += TILE) {
      const yEnd = Math.min(rows, ty + TILE);
      const xEnd = Math.min(cols, tx + TILE);
      for (let row = ty; row < yEnd; row++) {
        for (let col = tx; col < xEnd; col++) {
          const idx = row * cols + col;
          sampleCell(row, col);
          // Statistik der ganzen Zelle: skalare Summen statt groupOf(() => 0, 1) – gleiche Formel und
          // Summationsreihenfolge (bitgleich), aber ohne Objekt-/Closure-Allokation je Zelle (heißeste Schleife).
          let tl = 0;
          let ta = 0;
          let tb = 0;
          let tq = 0;
          for (let k = 0; k < NS; k++) {
            const l = SL[k];
            const a = SA[k];
            const b = SB[k];
            tl += l;
            ta += a;
            tb += b;
            tq += l * l + a * a + b * b;
          }
          const mean: Lab = [tl / NS, ta / NS, tb / NS];
          const fullSSE = tq - (tl * tl + ta * ta + tb * tb) / NS;

          // Gewichte/Regionen an Zellmitte
          const cxp = Math.min(W - 1, Math.max(0, Math.floor((layout.colX[col] + layout.colW[col] / 2) * sx)));
          const cyp = Math.min(H - 1, Math.max(0, Math.floor((layout.rowY[row] + layout.rowH[row] / 2) * sy)));
          const pix = cyp * W + cxp;
          const inFace = faceMask ? faceMask[pix] > 0 : false;
          const inDetail = detMask ? detMask[pix] > 0 : false;
          const skin = shapes.skinProtect && isSkinLab(mean[0], mean[1], mean[2]);
          const det = dmap ? dmap[pix] : 0;
          let lambda = baseLambda;
          if (inFace) lambda *= 0.4;
          else if (inDetail) lambda *= 0.5;
          if (dmap) lambda *= 1.25 - 0.5 * det;
          weight[idx] = (inFace ? 3 : 1) * (skin ? 1.5 : 1);

          let bestKind: number = CellKind.FULL;
          let bestScore = fullSSE;
          let bestColors: Lab[] = [mean];
          let bestLine: Float32Array | null = null;
          let recBits = 0;

          if (fullSSE > lambda * NS * 0.9) {
            const r = cellRect(layout, row, col);
            const cw = r.w;
            const ch = r.h;
            // ---- Diagonalen
            const tryTwo = (kind: number, sideOf: (k: number) => number, polys: () => [Pt[], Pt[]], cost: number, enabled: boolean) => {
              const gs = groupOf(sideOf, 2);
              if (gs[0].n === 0 || gs[1].n === 0) return;
              const score = sse(gs[0]) + sse(gs[1]) + lambda * NS * cost;
              if (score >= bestScore) return;
              // Nur schneidbare Formen kommen in Frage – auch als Empfehlung („sinnvoll, aber deaktiviert“)
              const [pa, pb] = polys();
              if (!pieceCuttable(pa, shapes.minPieceMm) || !pieceCuttable(pb, shapes.minPieceMm)) return;
              if (!enabled) {
                recBits |= Rec.EDGE_CUT;
                return;
              }
              bestScore = score;
              bestKind = kind;
              bestColors = [meanOf(gs[0]), meanOf(gs[1])];
              bestLine = null;
            };
            // „\“: oben rechts = Gruppe 0 (n·(p−TL) > 0 mit n=(h,−w))
            tryTwo(
              CellKind.DIAG_A,
              (k) => (ch * (PX[k] + cw / 2) - cw * (PY[k] + ch / 2) > 0 ? 0 : 1),
              () => diagA(r, g),
              1,
              shapes.diagonal,
            );
            // „/“: oben links = Gruppe 0
            tryTwo(
              CellKind.DIAG_B,
              (k) => (ch * (PX[k] + cw / 2) + cw * (PY[k] + ch / 2) - cw * ch < 0 ? 0 : 1),
              () => diagB(r, g),
              1,
              shapes.diagonal,
            );

            // ---- Kantenschnitt entlang der Hauptgradientenrichtung
            {
              let mxx = 0;
              let mxy = 0;
              let myy = 0;
              for (const ch3 of [SL, SA, SB]) {
                let gx = 0;
                let gy = 0;
                let m = 0;
                for (let k = 0; k < NS; k++) m += ch3[k];
                m /= NS;
                for (let k = 0; k < NS; k++) {
                  gx += PX[k] * (ch3[k] - m);
                  gy += PY[k] * (ch3[k] - m);
                }
                mxx += gx * gx;
                mxy += gx * gy;
                myy += gy * gy;
              }
              const theta = 0.5 * Math.atan2(2 * mxy, mxx - myy);
              let ai = Math.round(((theta < 0 ? theta + Math.PI : theta) * 180) / Math.PI / 15) % 12;
              const tryAngles = [ai, (ai + 1) % 12, (ai + 11) % 12];
              for (ai of tryAngles) {
                const nx = Math.cos(ANGLES[ai]);
                const ny = Math.sin(ANGLES[ai]);
                for (let k = 0; k < NS; k++) {
                  T[k] = nx * PX[k] + ny * PY[k];
                  order[k] = k;
                }
                const ord = Array.from(order).sort((p, q) => T[p] - T[q]);
                // Präfixsummen
                const pre = new Float64Array((NS + 1) * 5);
                for (let q = 0; q < NS; q++) {
                  const k = ord[q];
                  const o = q * 5;
                  pre[o + 5] = pre[o] + 1;
                  pre[o + 6] = pre[o + 1] + SL[k];
                  pre[o + 7] = pre[o + 2] + SA[k];
                  pre[o + 8] = pre[o + 3] + SB[k];
                  pre[o + 9] = pre[o + 4] + SL[k] * SL[k] + SA[k] * SA[k] + SB[k] * SB[k];
                }
                const ext = Math.abs(nx) * (cw / 2) + Math.abs(ny) * (ch / 2);
                for (let d = -ext + 0.5; d <= ext - 0.5 + 1e-9; d += 0.5) {
                  const dq = Math.round(d * 2) / 2;
                  // Anzahl Stichproben mit T < dq
                  let cnt = 0;
                  while (cnt < NS && T[ord[cnt]] < dq) cnt++;
                  if (cnt < NS * 0.12 || cnt > NS * 0.88) continue;
                  // n als ganze Zahl (identischer Wert wie pre[cnt·5]); ein Double aus dem Float64Array
                  // würde die SSEGroup-Objekte polymorph machen und sse() überall verlangsamen.
                  const gA: SSEGroup = { n: cnt, sl: pre[cnt * 5 + 1], sa: pre[cnt * 5 + 2], sb: pre[cnt * 5 + 3], sq: pre[cnt * 5 + 4] };
                  const tot = NS * 5;
                  const gB: SSEGroup = {
                    n: NS - cnt,
                    sl: pre[tot + 1] - gA.sl,
                    sa: pre[tot + 2] - gA.sa,
                    sb: pre[tot + 3] - gA.sb,
                    sq: pre[tot + 4] - gA.sq,
                  };
                  const score = sse(gA) + sse(gB) + lambda * NS * 1.4;
                  if (score >= bestScore) continue;
                  const [pa, pb] = lineSplit(r, nx, ny, dq, g);
                  if (!pieceCuttable(pa, shapes.minPieceMm) || !pieceCuttable(pb, shapes.minPieceMm)) continue;
                  if (!shapes.line) {
                    recBits |= Rec.EDGE_CUT;
                    continue;
                  }
                  bestScore = score;
                  bestKind = CellKind.LINE;
                  bestColors = [meanOf(gA), meanOf(gB)];
                  bestLine = new Float32Array([nx, ny, dq]);
                }
              }
            }

            // ---- Feinere Steine (k×k)
            const subAllowed = shapes.subdivide && (inFace || inDetail || !shapes.autoDetail || det > 0.5);
            const k = shapes.subdivide ? shapes.subdivK : recK;
            if (S % k === 0) {
              const per = S / k;
              const gs = groupOf((q) => {
                const i = q % S;
                const j = (q / S) | 0;
                return ((j / per) | 0) * k + ((i / per) | 0);
              }, k * k);
              let s = 0;
              for (const gg of gs) s += sse(gg);
              const score = s + lambda * NS * (k === 2 ? 2 : 3.2);
              // Feinere Steine nur, wenn die Teilsteine die Mindestbreite erfüllen – sonst weder
              // berechnet noch empfohlen (eine Empfehlung bedeutet „möglich, aber hier deaktiviert“).
              if (score < bestScore && subRects(r, k, g).every((p) => pieceCuttable(p, shapes.minPieceMm))) {
                if (!subAllowed) recBits |= Rec.FINER;
                else {
                  bestScore = score;
                  bestKind = CellKind.SUB;
                  bestColors = gs.map(meanOf);
                  bestLine = null;
                }
              }
            }
          }

          data.kind[idx] = bestKind;
          data.rec[idx] = recBits;
          if (recBits) recommendCells++;
          const c = bestColors[0];
          c1Lab[idx * 3] = qL(c[0]);
          c1Lab[idx * 3 + 1] = qAB(c[1]);
          c1Lab[idx * 3 + 2] = qAB(c[2]);
          if (bestKind === CellKind.DIAG_A || bestKind === CellKind.DIAG_B || bestKind === CellKind.LINE) {
            splitCells++;
            const c2 = bestColors[1];
            c2Lab[idx * 3] = qL(c2[0]);
            c2Lab[idx * 3 + 1] = qAB(c2[1]);
            c2Lab[idx * 3 + 2] = qAB(c2[2]);
            if (bestKind === CellKind.LINE && bestLine) data.line.set(idx, bestLine);
          } else if (bestKind === CellKind.SUB) {
            subCells++;
            const arr = new Float32Array(bestColors.length * 3);
            bestColors.forEach((cc, i) => arr.set(cc, i * 3));
            subLab.set(idx, arr);
          }
        }
      }
      tileDone++;
      if (tileDone % 4 === 0 || tileDone === totalTiles) onProgress?.('analyze', tileDone / totalTiles);
    }
  }

  // ---------------- Palette
  onProgress?.('palette', 0);
  const fromQ = (arr: Uint8Array, i: number): Lab => [arr[i * 3] / 2.55, arr[i * 3 + 1] - 128, arr[i * 3 + 2] - 128];

  let paletteLab: Lab[] = [];
  let paletteMeta: { hex?: string; name?: string; materialId?: string; code?: number }[] = [];
  const fixed = params.fixedPalette ?? [];

  if (params.paletteMode === 'auto' || params.paletteMode === 'auto-snap') {
    // Stichprobe der tatsächlichen Steinfarben (gewichtet nach Fläche und Region)
    const MAXS = 60000;
    let total = 0;
    for (let i = 0; i < N; i++) total += data.kind[i] === CellKind.SUB ? (subLab.get(i)!.length / 3) : data.kind[i] === CellKind.FULL ? 1 : 2;
    const stride = Math.max(1, Math.floor(total / MAXS));
    const pts: number[] = [];
    const ws: number[] = [];
    let counter = 0;
    const push = (l: Lab, w: number) => {
      if (counter++ % stride !== 0) return;
      pts.push(l[0], l[1], l[2]);
      ws.push(w);
    };
    for (let i = 0; i < N; i++) {
      const kind = data.kind[i];
      if (kind === CellKind.FULL) push(fromQ(c1Lab, i), weight[i]);
      else if (kind === CellKind.SUB) {
        const s = subLab.get(i)!;
        const k2 = s.length / 3;
        for (let q = 0; q < k2; q++) push([s[q * 3], s[q * 3 + 1], s[q * 3 + 2]], weight[i] / k2);
      } else {
        push(fromQ(c1Lab, i), weight[i] / 2);
        push(fromQ(c2Lab, i), weight[i] / 2);
      }
    }
    const km = kmeansLab(new Float32Array(pts), new Float32Array(ws), Math.max(1, params.colorCount), 30, params.seed ?? 7);
    if (params.paletteMode === 'auto') {
      paletteLab = km.centers;
      paletteMeta = km.centers.map(() => ({}));
    } else {
      if (!fixed.length) throw new Error('Keine Materialfarben vorhanden.');
      const used = new Map<number, number>();
      for (const c of km.centers) {
        let best = 0;
        let bd = Infinity;
        fixed.forEach((f, i) => {
          const d = deltaE2000(c[0], c[1], c[2], f.lab[0], f.lab[1], f.lab[2]);
          if (d < bd) {
            bd = d;
            best = i;
          }
        });
        used.set(best, Math.min(used.get(best) ?? Infinity, bd));
      }
      for (const [i] of used) {
        paletteLab.push(fixed[i].lab);
        paletteMeta.push({ hex: fixed[i].hex, name: fixed[i].name, materialId: fixed[i].materialId });
      }
    }
  } else {
    if (!fixed.length) throw new Error('Die Palette ist leer.');
    paletteLab = fixed.map((f) => f.lab);
    paletteMeta = fixed.map((f) => ({ hex: f.hex, name: f.name, materialId: f.materialId, code: f.code }));
  }
  onProgress?.('palette', 1);

  // ---------------- Zuordnung
  const matcher = new NearestColorMatcher(paletteLab, params.deltaE);
  const dE = params.deltaE === '76' ? deltaE76 : deltaE2000;
  const dither = Math.max(0, Math.min(1, params.dither));
  let errCur = new Float32Array((cols + 2) * 3);
  let errNext = new Float32Array((cols + 2) * 3);
  let sumDE = 0;
  let maxDE = 0;
  let cntDE = 0;
  const hist = new Uint32Array(101);
  const track = (l: Lab, pi: number) => {
    const p = paletteLab[pi];
    const d = dE(l[0], l[1], l[2], p[0], p[1], p[2]);
    sumDE += d;
    cntDE++;
    if (d > maxDE) maxDE = d;
    hist[Math.min(100, Math.floor(d))]++;
  };
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const kind = data.kind[idx];
      if (kind === CellKind.FULL) {
        const l = fromQ(c1Lab, idx);
        const e = (col + 1) * 3;
        const tl = l[0] + errCur[e];
        const ta = l[1] + errCur[e + 1];
        const tb = l[2] + errCur[e + 2];
        const pi = dither > 0 ? matcher.nearestExact(tl, ta, tb) : matcher.nearest(tl, ta, tb);
        data.c1[idx] = pi;
        track(l, pi);
        if (dither > 0) {
          const p = paletteLab[pi];
          // Fehler begrenzen, damit keine Artefakte entstehen
          const lim = (v: number) => Math.max(-25, Math.min(25, v * dither));
          const el = lim(tl - p[0]);
          const ea = lim(ta - p[1]);
          const eb = lim(tb - p[2]);
          const add = (buf: Float32Array, c: number, f: number) => {
            const o = (c + 1) * 3;
            buf[o] += el * f;
            buf[o + 1] += ea * f;
            buf[o + 2] += eb * f;
          };
          add(errCur, col + 1, 7 / 16);
          add(errNext, col - 1, 3 / 16);
          add(errNext, col, 5 / 16);
          add(errNext, col + 1, 1 / 16);
        }
      } else if (kind === CellKind.SUB) {
        const s = subLab.get(idx)!;
        const k2 = s.length / 3;
        const out = new Uint16Array(k2);
        for (let q = 0; q < k2; q++) {
          const l: Lab = [s[q * 3], s[q * 3 + 1], s[q * 3 + 2]];
          out[q] = matcher.nearest(l[0], l[1], l[2]);
          track(l, out[q]);
        }
        data.sub.set(idx, out);
        data.c1[idx] = out[0];
      } else {
        const l1 = fromQ(c1Lab, idx);
        const l2 = fromQ(c2Lab, idx);
        data.c1[idx] = matcher.nearest(l1[0], l1[1], l1[2]);
        data.c2[idx] = matcher.nearest(l2[0], l2[1], l2[2]);
        track(l1, data.c1[idx]);
        track(l2, data.c2[idx]);
      }
    }
    const tmp = errCur;
    errCur = errNext;
    errNext = tmp;
    errNext.fill(0);
    if (row % 64 === 0) onProgress?.('assign', row / rows);
  }
  onProgress?.('assign', 1);

  // ---------------- Palette abschließen
  let palette: PaletteColor[];
  if (params.paletteMode === 'custom') {
    // Eigene Palette: Jede Farbe bleibt erhalten – Reihenfolge, Farbnummer, HEX, Name und Material –,
    // auch wenn kein Stein sie verwendet (dann 0 Steine in der Statistik). Die Indizes in data zeigen
    // bereits auf genau diese Reihenfolge, daher ist keine Umnummerierung nötig.
    const codes = paletteMeta.map((m) => m.code);
    const keepCodes = codes.every((c) => c !== undefined && Number.isInteger(c) && c > 0) && new Set(codes).size === codes.length;
    palette = paletteLab.map((l, i) => {
      const meta = paletteMeta[i] ?? {};
      return {
        code: keepCodes ? (codes[i] as number) : i + 1,
        lab: [round2(l[0]), round2(l[1]), round2(l[2])],
        hex: meta.hex ?? labToHex(l[0], l[1], l[2]),
        name: meta.name ?? describeColor(l, lang),
        materialId: meta.materialId,
      };
    });
  } else {
    // Automatisch/Materialien: Die Palette wird bei jeder Berechnung neu gebildet – unbenutzte Farben
    // entfernen, nach Helligkeit sortieren, fortlaufend nummerieren.
    const used = new Uint8Array(paletteLab.length);
    for (let i = 0; i < N; i++) {
      const kind = data.kind[i];
      if (kind === CellKind.FULL) used[data.c1[i]] = 1;
      else if (kind === CellKind.SUB) for (const c of data.sub.get(i)!) used[c] = 1;
      else {
        used[data.c1[i]] = 1;
        used[data.c2[i]] = 1;
      }
    }
    const keep = paletteLab.map((_, i) => i).filter((i) => used[i]);
    keep.sort((a, b) => paletteLab[b][0] - paletteLab[a][0]);
    const remap = new Uint16Array(paletteLab.length);
    keep.forEach((old, ni) => (remap[old] = ni));
    for (let i = 0; i < N; i++) {
      data.c1[i] = remap[data.c1[i]];
      data.c2[i] = remap[data.c2[i]];
    }
    for (const [k, v] of data.sub) {
      for (let q = 0; q < v.length; q++) v[q] = remap[v[q]];
      data.sub.set(k, v);
    }
    palette = keep.map((old, ni) => {
      const l = paletteLab[old];
      const meta = paletteMeta[old] ?? {};
      return {
        code: ni + 1,
        lab: [round2(l[0]), round2(l[1]), round2(l[2])],
        hex: meta.hex ?? labToHex(l[0], l[1], l[2]),
        name: meta.name ?? describeColor(l, lang),
        materialId: meta.materialId,
      };
    });
  }

  let acc = 0;
  let p95 = 0;
  for (let i = 0; i <= 100; i++) {
    acc += hist[i];
    if (acc >= cntDE * 0.95) {
      p95 = i + 1;
      break;
    }
  }

  return {
    data,
    palette,
    diagnostics: {
      meanDeltaE: cntDE ? sumDE / cntDE : 0,
      maxDeltaE: maxDE,
      p95DeltaE: p95,
      splitCells,
      subCells,
      recommendCells,
      timeMs: Date.now() - t0,
      samplesPerCell: NS,
    },
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
