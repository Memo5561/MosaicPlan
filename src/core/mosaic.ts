/**
 * Mosaikberechnung: Bildanalyse je Rasterzelle, Formwahl (ganzer Stein,
 * Dreiecke, Kantenschnitt, feinere Steine), Farbquantisierung (K-Means in
 * CIELAB) und Farbzuordnung (CIEDE2000).
 *
 * Die Berechnung läuft kachelweise (64×64 Zellen) und meldet Fortschritt.
 */
import { deltaE2000, deltaE76, labToHex, NearestColorMatcher, rgbToLabInto, type ColorNameLang, type DeltaEFormula, type Lab } from './color';
import { nameKeyFor, uniqueAutoNames, type NameSuffix } from './colorNames';
import { regionMask, detailMap, type RGBAImage } from './imageOps';
import { kmeansLab } from './kmeans';
import type { Layout } from './layout';
import type { Pt } from './geometry';
import { cellRect, diagA, diagB, lineSplit, pieceCuttable, subRects } from './pieces';
import { CellKind, createEmptyMosaic, Rec, type MatchDeltaE, type MosaicData, type PaletteColor, type PaletteMode, type Region, type ShapeOptions } from './types';

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
  /**
   * Bestand des Materials in Stück (nur Materialmodi). „Automatisch → eigene Materialien“ bevorzugt bei fast gleicher
   * Eignung Materialien mit Bestand > 0 (nur bei der Auswahl der Palette, nie bei der Zuordnung der Steine).
   */
  stock?: number;
  /** Schlüssel eines automatischen Namens (Modus 'custom'): der Name bleibt automatisch und folgt der UI-Sprache */
  nameKey?: string;
  nameSuffix?: NameSuffix;
  /** Vom Benutzer benannt (Modus 'custom'): der Name bleibt wörtlich, auch nach dem Neuberechnen */
  userNamed?: boolean;
}

export interface ComputeParams {
  layout: Layout;
  shapes: ShapeOptions;
  paletteMode: PaletteMode;
  colorCount: number;
  /**
   * Farbübergänge mischen: 0 = aus, 1 = volles Floyd-Steinberg – auf ähnliche Farben beschränkt (je Stein nur Farben,
   * die seiner Bildfarbe höchstens DITHER_TOLERANCE ferner liegen als die nächste; nur ganze Steine).
   */
  dither: number;
  deltaE: '2000' | '76';
  /** Materialfarben (für 'materials' und 'auto-snap') bzw. eigene Palette ('custom') */
  fixedPalette?: FixedColor[];
  regions: Region[];
  lang?: ColorNameLang;
  seed?: number;
  /**
   * Vom Benutzer bestätigte Akzentfarben, die in die Palette sollen. Vertrag für Welle 4 – die Berechnung nutzt sie
   * noch nicht.
   */
  pinnedColors?: FixedColor[];
  /**
   * „Automatisch → eigene Materialien“: 'select' (Standard) wählt die Materialien direkt aus dem Bestand
   * (selectMaterials), 'nearest' ist das frühere Verfahren (jede Bildfarbe → nächstes Material, Doppelte
   * zusammengelegt) – nur für Vergleiche und Tests.
   */
  snapMethod?: 'select' | 'nearest';
}

/**
 * Bildfarbe, die keines der angebotenen Materialien gut trifft (Modi mit eigenen Materialien): eine Zielfarbe zum
 * Nachkaufen – ein Farbton, kein Produkt.
 */
export interface MissingColor {
  /** Zielfarbe: typische Fotofarbe (K-Means-Zentrum) */
  hex: string;
  lab: Lab;
  /** Steine, deren Fotofarbe dieser Bildfarbe am nächsten liegt (exakt gezählt, jeder Stein genau einmal) */
  stones: number;
  /** nächstes angebotenes Material (über alle angebotenen, nicht nur die gewählten) */
  nearestMaterialId?: string;
  nearestHex: string;
  nearestName: string;
  /** ΔE (Formel der Berechnung) zwischen Zielfarbe und nächstem Material */
  deltaE: number;
  /** mittleres ΔE dieser Steine zu der Farbe, die sie tatsächlich erhalten haben (gemessen bei der Berechnung) */
  assignedDeltaE: number;
}

/** Kennzahlen der Materialauswahl („Automatisch → eigene Materialien“, selectMaterials) */
export interface SnapSelectionInfo {
  /** Verfahren: 'select' = direkte Auswahl, 'nearest' = früheres Verfahren (nur Vergleich) */
  method: 'select' | 'nearest';
  /** Anzahl Materialien, die das frühere Verfahren (Bildfarbe → nächstes Material) ergeben hätte – Startmenge */
  snapColors: number;
  /** gewählte Materialien (vor dem Entfernen von Farben ohne Steine) */
  selected: number;
  /** durch Tausch verbesserte Wahl (Anzahl Tausche) */
  swaps: number;
  /** aus den Steinfarben ergänzte bzw. gegen ein Material ohne Steine getauschte Materialien */
  filled: number;
  /** wegen Bestand bevorzugte Materialien (je höchstens ΔE 0,5 schlechter im Mittel ihrer Steine) */
  stockSwaps: number;
  /** Rechenbudget der Tauschdurchgänge erreicht (Auswahl gut, aber evtl. nicht weiter verbessert) */
  budgetHit: boolean;
  /** Schutz hat gegriffen: die Auswahl wäre teurer gewesen, es gilt die Startmenge (früheres Verfahren) */
  fallback?: boolean;
  /**
   * Schätzung auf der Stichprobe der Steinfarben (gemessen wie die Zuordnung): mittleres ΔE mit der Startmenge bzw. der
   * gewählten Menge. Fehlt beim früheren Verfahren.
   */
  costSnap?: number;
  costSelected?: number;
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
  /**
   * Angeforderte Farbanzahl: Automatik-Modi = eingestellte Anzahl, „Nur eigene Materialien“ = Anzahl der
   * angebotenen Materialfarben, eigene Palette = Anzahl ihrer Farben. (Optional: ältere Ergebnisse haben es nicht.)
   */
  requestedColors?: number;
  /** Farben, die mindestens einen Stein erhalten haben */
  usedColors?: number;
  /** Farbquelle dieser Berechnung (zum richtigen Lesen von requestedColors) */
  paletteMode?: PaletteMode;
  /** Automatik-Modi: Anzahl der aus dem Foto ermittelten Farben (K-Means-Zentren; weniger als angefordert, wenn das Foto nicht mehr hergibt) */
  imageColors?: number;
  /**
   * „Automatisch → eigene Materialien“ nur beim Verfahren Bildfarbe → nächstes Material ('nearest' oder Schutz der
   * Auswahl gegriffen): Bildfarben, die auf ein bereits gewähltes Material fielen (zusammengelegt). Bei der direkten
   * Auswahl aus dem Bestand nicht gesetzt (dort wird nichts zusammengelegt).
   */
  mergedColors?: number;
  /** Modi mit eigenen Materialien: Anzahl der angebotenen Materialfarben */
  poolColors?: number;
  /** „Automatisch → eigene Materialien“: Kennzahlen der Materialauswahl */
  snapSelection?: SnapSelectionInfo;
  /**
   * Modi mit eigenen Materialien: Bildfarben, die kein angebotenes Material auf ΔE ≤ missingThreshold trifft
   * (absteigend nach Steinen). Leer = alle untersuchten Bildfarben werden getroffen.
   */
  missingColors?: MissingColor[];
  /** Grenze für missingColors (ΔE der Projektformel) */
  missingThreshold?: number;
  /** Anzahl der dafür untersuchten Bildfarben (K-Means-Zentren) */
  missingChecked?: number;
  /** Farbmischung: größter ΔE-Abstand eines Steins zwischen erhaltener und nächster Farbe (zu seiner Bildfarbe) */
  ditherExcessMax?: number;
  /** Farbmischung: Steine, deren erhaltene Farbe um mehr als ΔE 5 schlechter passt als die nächste */
  ditherExcessOver5?: number;
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
  const formula: DeltaEFormula = params.deltaE === '76' ? '76' : '2000';
  const dE = formula === '76' ? deltaE76 : deltaE2000;

  let paletteLab: Lab[] = [];
  let paletteMeta: { hex?: string; name?: string; materialId?: string; code?: number; nameKey?: string; nameSuffix?: NameSuffix; userNamed?: boolean; mergedFrom?: number }[] = [];
  const fixed = params.fixedPalette ?? [];
  const materialMode = params.paletteMode === 'auto-snap' || params.paletteMode === 'materials';
  let imageColors: number | undefined;
  let mergedColors: number | undefined;
  let snapSelection: SnapSelectionInfo | undefined;
  /** Bildfarben (K-Means-Zentren) für „Fehlende Farben“ (Modi mit eigenen Materialien) */
  let imageCentres: Lab[] = [];

  /** Stichprobe der tatsächlichen Steinfarben (gewichtet nach Fläche und Region) */
  const buildSamples = () => {
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
    return { pts: new Float32Array(pts), ws: new Float32Array(ws) };
  };

  if (params.paletteMode === 'auto' || params.paletteMode === 'auto-snap') {
    const { pts, ws } = buildSamples();
    const km = kmeansLab(pts, ws, Math.max(1, params.colorCount), 30, params.seed ?? 7);
    imageColors = km.centers.length;
    if (params.paletteMode === 'auto') {
      paletteLab = km.centers;
      paletteMeta = km.centers.map(() => ({}));
    } else {
      if (!fixed.length) throw new Error('Keine Materialfarben vorhanden.');
      imageCentres = km.centers;
      const k = Math.max(1, params.colorCount);
      // Startmenge (früheres Verfahren): jede Bildfarbe → nächstes Material (exakt über alle Materialien, Formel der
      // Projekteinstellung); mehrere Bildfarben können auf dasselbe Material fallen.
      const snapSet: number[] = [];
      for (const c of km.centers) {
        const m = nearestFixed(fixed, c, dE).index;
        if (!snapSet.includes(m)) snapSet.push(m);
      }
      let chosen = snapSet;
      if (params.snapMethod === 'nearest') {
        snapSelection = { method: 'nearest', snapColors: snapSet.length, selected: snapSet.length, swaps: 0, filled: 0, stockSwaps: 0, budgetHit: false };
      } else {
        // Direkte Auswahl aus dem Bestand auf einer Zusammenfassung der Steinfarben (bis 256 gewichtete Zentren)
        const sum = kmeansLab(pts, ws, Math.min(Math.max(SNAP_SUMMARY_K, 2 * k), ws.length), SNAP_SUMMARY_ITER, (params.seed ?? 7) + 1);
        const sel = selectMaterials(sum.centers, sum.weights, fixed, k, formula, snapSet, { pts, ws });
        chosen = sel.chosen;
        snapSelection = {
          method: 'select',
          snapColors: snapSet.length,
          selected: chosen.length,
          swaps: sel.swaps,
          filled: sel.filled,
          stockSwaps: sel.stockSwaps,
          budgetHit: sel.budgetHit,
          ...(sel.fallback ? { fallback: true } : {}),
          costSnap: round2(sel.costSnap),
          costSelected: round2(sel.costSelected),
        };
      }
      // „aus n Bildfarben … zusammengelegt“ beschreibt nur dort, was wirklich geschah: Bildfarbe → nächstes Material
      // ('nearest' bzw. Schutz der Auswahl gegriffen – dann ist die Palette genau diese Startmenge, und das nächste
      // gewählte Material ist das nächste aller Materialien). Bei der direkten Auswahl aus dem Bestand wird nichts
      // zusammengelegt: Weniger Farben haben dort andere Gründe (Bestand zu klein, keine Verbesserung) – kein
      // mergedFrom/mergedColors.
      const merges = params.snapMethod === 'nearest' || !!snapSelection?.fallback;
      const from = merges ? new Array<number>(chosen.length).fill(0) : null;
      if (from) {
        for (const c of km.centers) {
          let best = 0;
          let bd = Infinity;
          chosen.forEach((m, q) => {
            const d = dE(c[0], c[1], c[2], fixed[m].lab[0], fixed[m].lab[1], fixed[m].lab[2]);
            if (d < bd) {
              bd = d;
              best = q;
            }
          });
          from[best]++;
        }
        mergedColors = km.centers.length - from.filter((x) => x > 0).length;
      }
      chosen.forEach((m, q) => {
        paletteLab.push(fixed[m].lab);
        paletteMeta.push({ hex: fixed[m].hex, name: fixed[m].name, materialId: fixed[m].materialId, ...(from ? { mergedFrom: from[q] } : {}) });
      });
    }
  } else {
    if (!fixed.length) throw new Error('Die Palette ist leer.');
    paletteLab = fixed.map((f) => f.lab);
    paletteMeta = fixed.map((f) => {
      // Eigene Palette: Namen bleiben genau so, wie sie sind. Ein automatischer Name bleibt automatisch – nur über
      // den mitgegebenen Schlüssel (nie am Text geraten: ein eingetipptes „Rot“ bleibt „Rot“); ein Benutzername
      // behält seine Markierung.
      return {
        hex: f.hex,
        name: f.name,
        materialId: f.materialId,
        code: f.code,
        ...(f.nameKey ? { nameKey: f.nameKey, nameSuffix: f.nameSuffix } : f.userNamed ? { userNamed: true } : {}),
      };
    });
    if (params.paletteMode === 'materials') {
      // Nur für „Fehlende Farben“: typische Fotofarben, gegen die der Bestand geprüft wird
      const { pts, ws } = buildSamples();
      imageCentres = kmeansLab(pts, ws, MISSING_IMAGE_COLORS, 30, params.seed ?? 7).centers;
    }
  }
  onProgress?.('palette', 1);

  // ---------------- Zuordnung
  const matcher = new NearestColorMatcher(paletteLab, formula);
  const dither = Math.max(0, Math.min(1, params.dither));
  let errCur = new Float32Array((cols + 2) * 3);
  let errNext = new Float32Array((cols + 2) * 3);
  let sumDE = 0;
  let maxDE = 0;
  let cntDE = 0;
  let ditherExcessMax = 0;
  let ditherExcessOver5 = 0;
  const hist = new Uint32Array(101);
  // je Palettenindex: Stückzahl, ΔE-Summe, max. ΔE, Steine über 5 und über 10 (Bild-Lab je Stein gegen zugeordnete Farbe)
  const nPal = paletteLab.length;
  const pcCnt = new Uint32Array(nPal);
  const pcSum = new Float64Array(nPal);
  const pcMax = new Float64Array(nPal);
  const pcOver5 = new Uint32Array(nPal);
  const pcOver10 = new Uint32Array(nPal);
  // je Bildfarbe (nur Modi mit eigenen Materialien): Steine, deren Fotofarbe ihr am nächsten liegt, und deren ΔE-Summe
  const centreMatcher = materialMode && imageCentres.length ? new NearestColorMatcher(imageCentres, formula) : null;
  const icCnt = new Uint32Array(imageCentres.length);
  const icSum = new Float64Array(imageCentres.length);
  // gemessen gegen die Palettenfarbe, wie sie gespeichert wird (Lab auf 0,01 gerundet) – so ergibt eine erneute
  // Berechnung mit der gespeicherten Palette dieselben Werte
  const storedLab: Lab[] = paletteLab.map((l) => [round2(l[0]), round2(l[1]), round2(l[2])]);
  /** `onGrid`: Farbe liegt auf dem gespeicherten Raster (ganze Steine, Zweiteiler) – dann ist der Zwischenspeicher exakt */
  const track = (l: Lab, pi: number, onGrid: boolean) => {
    const p = storedLab[pi];
    const d = dE(l[0], l[1], l[2], p[0], p[1], p[2]);
    sumDE += d;
    cntDE++;
    if (d > maxDE) maxDE = d;
    hist[Math.min(100, Math.floor(d))]++;
    pcCnt[pi]++;
    pcSum[pi] += d;
    if (d > pcMax[pi]) pcMax[pi] = d;
    if (d > 5) pcOver5[pi]++;
    if (d > 10) pcOver10[pi]++;
    if (centreMatcher) {
      const ci = onGrid ? centreMatcher.nearest(l[0], l[1], l[2]) : centreMatcher.nearestExact(l[0], l[1], l[2]);
      icCnt[ci]++;
      icSum[ci] += d;
    }
  };
  const matchOf = (pi: number): MatchDeltaE => ({
    pieces: pcCnt[pi],
    mean: pcCnt[pi] ? round2(pcSum[pi] / pcCnt[pi]) : 0,
    max: round2(pcMax[pi]),
    over5: pcOver5[pi],
    over10: pcOver10[pi],
  });
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      const kind = data.kind[idx];
      if (kind === CellKind.FULL) {
        const l = fromQ(c1Lab, idx);
        let pi: number;
        if (dither > 0) {
          // Floyd-Steinberg, auf ähnliche Farben beschränkt: Kandidaten sind die nächste Palettenfarbe der eigenen
          // (unvermischten) Bildfarbe und jede, die ihr höchstens DITHER_TOLERANCE ferner liegt. Unter ihnen gewinnt
          // die Farbe, die dem Ziel (Bildfarbe + verteilter Fehler) am nächsten kommt.
          const e = (col + 1) * 3;
          const tl = l[0] + errCur[e];
          const ta = l[1] + errCur[e + 1];
          const tb = l[2] + errCur[e + 2];
          const cand = matcher.candidates(l[0], l[1], l[2]);
          let ci = 0;
          if (cand.idx.length > 1) {
            let p = paletteLab[cand.idx[0]];
            let bd = dE(tl, ta, tb, p[0], p[1], p[2]);
            for (let q = 1; q < cand.idx.length; q++) {
              p = paletteLab[cand.idx[q]];
              const d = dE(tl, ta, tb, p[0], p[1], p[2]);
              if (d < bd) {
                bd = d;
                ci = q;
              }
            }
          }
          pi = cand.idx[ci];
          const excess = cand.d[ci] - cand.d[0];
          if (excess > ditherExcessMax) ditherExcessMax = excess;
          if (excess > 5) ditherExcessOver5++;
          const p = paletteLab[pi];
          // Rest wie bisher verteilen (7/16 rechts, 3/16 unten links, 5/16 unten, 1/16 unten rechts), je Kanal auf
          // ±25 begrenzt, damit keine Artefakte entstehen
          const el = Math.max(-25, Math.min(25, (tl - p[0]) * dither));
          const ea = Math.max(-25, Math.min(25, (ta - p[1]) * dither));
          const eb = Math.max(-25, Math.min(25, (tb - p[2]) * dither));
          const oR = e + 3; // Spalte col + 1
          errCur[oR] += el * (7 / 16);
          errCur[oR + 1] += ea * (7 / 16);
          errCur[oR + 2] += eb * (7 / 16);
          const oL = e - 3; // Spalte col − 1
          errNext[oL] += el * (3 / 16);
          errNext[oL + 1] += ea * (3 / 16);
          errNext[oL + 2] += eb * (3 / 16);
          errNext[e] += el * (5 / 16);
          errNext[e + 1] += ea * (5 / 16);
          errNext[e + 2] += eb * (5 / 16);
          errNext[oR] += el * (1 / 16);
          errNext[oR + 1] += ea * (1 / 16);
          errNext[oR + 2] += eb * (1 / 16);
        } else pi = matcher.nearest(l[0], l[1], l[2]);
        data.c1[idx] = pi;
        track(l, pi, true);
      } else if (kind === CellKind.SUB) {
        const s = subLab.get(idx)!;
        const k2 = s.length / 3;
        const out = new Uint16Array(k2);
        for (let q = 0; q < k2; q++) {
          const l: Lab = [s[q * 3], s[q * 3 + 1], s[q * 3 + 2]];
          out[q] = matcher.nearest(l[0], l[1], l[2]);
          track(l, out[q], false);
        }
        data.sub.set(idx, out);
        data.c1[idx] = out[0];
      } else {
        const l1 = fromQ(c1Lab, idx);
        const l2 = fromQ(c2Lab, idx);
        data.c1[idx] = matcher.nearest(l1[0], l1[1], l1[2]);
        data.c2[idx] = matcher.nearest(l2[0], l2[1], l2[2]);
        track(l1, data.c1[idx], true);
        track(l2, data.c2[idx], true);
      }
    }
    const tmp = errCur;
    errCur = errNext;
    errNext = tmp;
    errNext.fill(0);
    if (row % 64 === 0) onProgress?.('assign', row / rows);
  }
  onProgress?.('assign', 1);

  // ---------------- Fehlende Farben (Modi mit eigenen Materialien)
  let missingColors: MissingColor[] | undefined;
  if (centreMatcher) {
    const list: MissingColor[] = [];
    imageCentres.forEach((c, ci) => {
      const nf = nearestFixed(fixed, c, dE);
      if (nf.d <= MISSING_DELTA_E || icCnt[ci] === 0) return;
      const f = fixed[nf.index];
      list.push({
        hex: labToHex(c[0], c[1], c[2]),
        lab: [round2(c[0]), round2(c[1]), round2(c[2])],
        stones: icCnt[ci],
        ...(f.materialId !== undefined ? { nearestMaterialId: f.materialId } : {}),
        nearestHex: f.hex,
        nearestName: f.name,
        deltaE: round2(nf.d),
        assignedDeltaE: round2(icSum[ci] / icCnt[ci]),
      });
    });
    list.sort((p, q) => q.stones - p.stones || p.lab[0] - q.lab[0]);
    missingColors = list;
  }

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
      const pc: PaletteColor = {
        code: keepCodes ? (codes[i] as number) : i + 1,
        lab: [round2(l[0]), round2(l[1]), round2(l[2])],
        hex: meta.hex ?? labToHex(l[0], l[1], l[2]),
        name: meta.name ?? '',
        materialId: meta.materialId,
      };
      if (meta.nameKey) pc.nameKey = meta.nameKey;
      if (meta.nameSuffix !== undefined) pc.nameSuffix = meta.nameSuffix;
      if (meta.userNamed) pc.userNamed = true;
      pc.matchDeltaE = matchOf(i);
      return pc;
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
      // Name aus dem gespeicherten (gerundeten) Lab, damit derselbe Wert später denselben Schlüssel ergibt
      const lab: Lab = [round2(l[0]), round2(l[1]), round2(l[2])];
      const pc: PaletteColor = {
        code: ni + 1,
        lab,
        hex: meta.hex ?? labToHex(l[0], l[1], l[2]),
        name: meta.name ?? '',
        materialId: meta.materialId,
      };
      if (meta.name === undefined) pc.nameKey = nameKeyFor(lab);
      if (meta.mergedFrom !== undefined) pc.mergedFrom = meta.mergedFrom;
      pc.matchDeltaE = matchOf(old);
      return pc;
    });
    // Automatische Namen eindeutig machen (hell/mittel/dunkel bzw. Nummer) und in der Sprache setzen;
    // Materialnamen bleiben unverändert.
    palette = uniqueAutoNames(palette, lang);
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
      paletteMode: params.paletteMode,
      requestedColors: params.paletteMode === 'auto' || params.paletteMode === 'auto-snap' ? Math.max(1, params.colorCount) : fixed.length,
      usedColors: palette.filter((p) => (p.matchDeltaE?.pieces ?? 0) > 0).length,
      ...(imageColors !== undefined ? { imageColors } : {}),
      ...(mergedColors !== undefined ? { mergedColors } : {}),
      ...(materialMode ? { poolColors: fixed.length } : {}),
      ...(snapSelection ? { snapSelection } : {}),
      ...(missingColors ? { missingColors, missingThreshold: MISSING_DELTA_E, missingChecked: imageCentres.length } : {}),
      ...(dither > 0 ? { ditherExcessMax: round2(ditherExcessMax), ditherExcessOver5 } : {}),
    },
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------- Materialauswahl („Automatisch → eigene Materialien“)

/** Zusammenfassung der Steinfarben für die Auswahl: so viele gewichtete K-Means-Zentren (mindestens 256, bei vielen Farben 2·k) */
export const SNAP_SUMMARY_K = 256;
/** Lloyd-Iterationen der Zusammenfassung (sie muss nicht konvergieren, nur die Verteilung abbilden) */
export const SNAP_SUMMARY_ITER = 10;
/** höchstens so viele Tauschdurchgänge (FastPAM) nach der gierigen Auswahl */
export const SNAP_SWAP_PASSES = 2;
/**
 * Rechenbudget der Tauschdurchgänge in Abstandsauswertungen (≈ 1,5 s auf einem Handy). Bewusst ein Zähler statt einer
 * Uhr: das Ergebnis bleibt bei gleichem Seed auf jedem Gerät gleich.
 */
export const SNAP_SWAP_BUDGET = 150_000_000;
/** Bestand bevorzugen: ein Material mit Bestand > 0 ersetzt ein gewähltes ohne, wenn dessen Steine im Mittel höchstens so viel schlechter passen */
export const SNAP_STOCK_BONUS = 0.5;
/** „Fehlende Farben“: Bildfarben, deren nächstes Material weiter als dieses ΔE entfernt ist */
export const MISSING_DELTA_E = 5;
/** „Meine Steine – alle Farben“: so viele typische Fotofarben werden für „Fehlende Farben“ untersucht */
export const MISSING_IMAGE_COLORS = 32;

type DEFn = (l1: number, a1: number, b1: number, l2: number, a2: number, b2: number) => number;

/** Nächste Farbe einer festen Liste (exakt, Vergleich mit jeder Farbe; bei Gleichstand die niedrigere Position). */
export function nearestFixed(list: readonly FixedColor[], c: Lab, dE: DEFn): { index: number; d: number } {
  let index = 0;
  let d = Infinity;
  for (let i = 0; i < list.length; i++) {
    const f = list[i].lab;
    const di = dE(c[0], c[1], c[2], f[0], f[1], f[2]);
    if (di < d) {
      d = di;
      index = i;
    }
  }
  return { index, d };
}

export interface MaterialSelection {
  /** gewählte Indizes in `materials` */
  chosen: number[];
  swaps: number;
  /** aus den Steinfarben ergänzte bzw. gegen ein Material ohne Steine getauschte Materialien */
  filled: number;
  stockSwaps: number;
  budgetHit: boolean;
  /** Schutz hat gegriffen: es gilt die Startmenge (früheres Verfahren) */
  fallback?: boolean;
  /** mittleres ΔE (je Gewicht, wie bei der Zuordnung gemessen) der Stichprobe mit der Startmenge bzw. der Wahl – eine Schätzung, nicht das Ergebnis */
  costSnap: number;
  costSelected: number;
}

/**
 * Wählt bis zu `k` Materialien, die die Steinfarben zusammen am besten treffen (gewichtetes k-Medoids über dem
 * Materialbestand). `X`/`w`: Zusammenfassung der Steinfarben (Zentren und Gewichte); `samples`: die gewichtete
 * Stichprobe der Steinfarben selbst. Kosten = Σ Gewicht · ΔE zum nächsten gewählten Material, mit der Formel der
 * Berechnung.
 * 1. Start mit `seed` (dem früheren Verfahren: jede Bildfarbe → nächstes Material), dann gierig das Material mit dem
 *    größten Gewinn ergänzen, bis `k` erreicht ist oder keines mehr etwas verbessert.
 * 2. Höchstens SNAP_SWAP_PASSES Tauschdurchgänge (FastPAM1 mit Zwischenspeicher der nächsten/zweitnächsten Wahl),
 *    nur bei echter Verbesserung, innerhalb von SNAP_SWAP_BUDGET.
 * 3. Auffüllen aus der Stichprobe: Solange weniger als `k` gewählt sind oder ein gewähltes Material keiner Steinfarbe am
 *    nächsten liegt (es bekäme keine Steine), wird das Material ergänzt, das Steinfarben als ihr nächstes Material des
 *    ganzen Bestands am meisten verbessert. So hat die Palette min(k, Materialien, die überhaupt Steine bekämen) Farben.
 * 4. Bestand bevorzugen (nur, wenn manche Materialien Bestand > 0 haben und andere nicht): ein gewähltes Material
 *    ohne Bestand wird durch eines mit Bestand ersetzt, wenn dessen Steine im Mittel höchstens SNAP_STOCK_BONUS ΔE
 *    schlechter passen. Die Zuordnung der Steine bleibt rein nach Farbabstand.
 * 5. Schutz: Mit demselben Zuordner wie bei der Berechnung auf der Stichprobe gemessen, darf die Wahl nicht teurer
 *    sein als die Startmenge – sonst gilt die nächstbeste Stufe (ohne Bestandsvorzug, ohne Tausch, Startmenge).
 * Deterministisch (keine Zufallszahlen, kein Zeitlimit nach Uhr).
 */
export function selectMaterials(
  X: readonly Lab[],
  w: readonly number[],
  materials: readonly FixedColor[],
  k: number,
  formula: DeltaEFormula,
  seed: readonly number[],
  samples?: { pts: Float32Array; ws: Float32Array },
): MaterialSelection {
  const J = X.length;
  const M = materials.length;
  const de: DEFn = formula === '76' ? deltaE76 : deltaE2000;
  const D = new Float64Array(J * M);
  let W = 0;
  for (let j = 0; j < J; j++) {
    W += w[j];
    const x = X[j];
    for (let m = 0; m < M; m++) {
      const f = materials[m].lab;
      D[j * M + m] = de(x[0], x[1], x[2], f[0], f[1], f[2]);
    }
  }
  const eps = 1e-9 * Math.max(W, 1e-12);
  const target = Math.min(Math.max(1, k), M);
  const seedSet = [...new Set(seed)].filter((m) => m >= 0 && m < M).slice(0, target);

  // ---- 1. gierig ergänzen (Zusammenfassung)
  const greedy = (start: readonly number[]): number[] => {
    const S = start.slice();
    const inS = new Uint8Array(M);
    for (const m of S) inS[m] = 1;
    const cur = new Float64Array(J).fill(S.length ? Infinity : 1e9);
    for (let j = 0; j < J; j++) for (const m of S) cur[j] = Math.min(cur[j], D[j * M + m]);
    while (S.length < target) {
      let bestM = -1;
      let bestG = 0;
      for (let m = 0; m < M; m++) {
        if (inS[m]) continue;
        let g = 0;
        for (let j = 0; j < J; j++) {
          const diff = cur[j] - D[j * M + m];
          if (diff > 0) g += w[j] * diff;
        }
        if (g > bestG) {
          bestG = g;
          bestM = m;
        }
      }
      if (bestM < 0 || bestG <= eps) break;
      S.push(bestM);
      inS[bestM] = 1;
      for (let j = 0; j < J; j++) cur[j] = Math.min(cur[j], D[j * M + bestM]);
    }
    return S;
  };

  // nächste (Platz in S) und zweitnächste Wahl je Zentrum der Zusammenfassung
  const n1 = new Int32Array(J);
  const d1 = new Float64Array(J);
  const d2 = new Float64Array(J);
  const nearestTwo = (S: readonly number[]) => {
    for (let j = 0; j < J; j++) {
      let a = Infinity;
      let b = Infinity;
      let ia = 0;
      for (let q = 0; q < S.length; q++) {
        const d = D[j * M + S[q]];
        if (d < a) {
          b = a;
          a = d;
          ia = q;
        } else if (d < b) b = d;
      }
      n1[j] = ia;
      d1[j] = a;
      d2[j] = b;
    }
  };

  // ---- 2. Tauschdurchgänge (FastPAM1, sofort tauschen)
  const swap = (start: readonly number[]) => {
    const S = start.slice();
    const inS = new Uint8Array(M);
    for (const m of S) inS[m] = 1;
    let swaps = 0;
    let budgetHit = false;
    let ops = 0;
    if (S.length > 0 && S.length < M) {
      nearestTwo(S);
      const loss = new Float64Array(S.length);
      for (let pass = 0; pass < SNAP_SWAP_PASSES && !budgetHit; pass++) {
        let improved = false;
        for (let m = 0; m < M; m++) {
          if (inS[m]) continue;
          if (ops > SNAP_SWAP_BUDGET) {
            budgetHit = true;
            break;
          }
          let shared = 0;
          loss.fill(0);
          for (let j = 0; j < J; j++) {
            const dm = D[j * M + m];
            const dj = d1[j];
            if (dm < dj) shared += w[j] * (dm - dj);
            else loss[n1[j]] += w[j] * (Math.min(dm, d2[j]) - dj);
          }
          ops += J + S.length;
          let bi = 0;
          for (let q = 1; q < S.length; q++) if (loss[q] < loss[bi]) bi = q;
          if (shared + loss[bi] < -eps) {
            inS[S[bi]] = 0;
            S[bi] = m;
            inS[m] = 1;
            nearestTwo(S);
            ops += J * S.length;
            swaps++;
            improved = true;
          }
        }
        if (!improved) break;
      }
    }
    return { S, swaps, budgetHit };
  };

  // ---- 3. Auffüllen aus der Stichprobe der Steinfarben
  const n = samples ? samples.ws.length : 0;
  let poolNearest: { idx: Int32Array; d: Float64Array } | null = null;
  const pool = () => {
    if (!poolNearest && samples) {
      const pm = new NearestColorMatcher(materials.map((f) => f.lab), formula);
      const idx = new Int32Array(n);
      const d = new Float64Array(n);
      const p = samples.pts;
      for (let i = 0; i < n; i++) {
        const m = pm.nearest(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
        const f = materials[m].lab;
        idx[i] = m;
        d[i] = de(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], f[0], f[1], f[2]);
      }
      poolNearest = { idx, d };
    }
    return poolNearest!;
  };
  const fill = (start: readonly number[]) => {
    if (!samples || !n || !start.length) return { S: start.slice(), filled: 0 };
    const { idx: nIdx, d: dn } = pool();
    const p = samples.pts;
    const ws = samples.ws;
    const S = start.slice();
    const inS = new Uint8Array(M);
    for (const m of S) inS[m] = 1;
    const sm = new NearestColorMatcher(S.map((m) => materials[m].lab), formula);
    const slot = new Int32Array(n);
    const cur = new Float64Array(n);
    const served = new Uint32Array(M);
    let open: number[] = [];
    for (let i = 0; i < n; i++) {
      const m = S[sm.nearest(p[i * 3], p[i * 3 + 1], p[i * 3 + 2])];
      const f = materials[m].lab;
      slot[i] = m;
      cur[i] = de(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], f[0], f[1], f[2]);
      served[m]++;
      if (!inS[nIdx[i]] && cur[i] > dn[i]) open.push(i);
    }
    let filled = 0;
    const gains = new Float64Array(M);
    for (let guard = 0; guard < target + M; guard++) {
      gains.fill(0);
      for (const i of open) gains[nIdx[i]] += ws[i] * (cur[i] - dn[i]);
      let bestM = -1;
      let bestG = 0;
      for (let m = 0; m < M; m++)
        if (!inS[m] && gains[m] > bestG) {
          bestG = gains[m];
          bestM = m;
        }
      if (bestM < 0 || bestG <= 0) break;
      if (S.length < target) S.push(bestM);
      else {
        // voll: nur ein Material ersetzen, das keiner Steinfarbe am nächsten liegt (es bekäme keine Steine)
        const q = S.findIndex((m) => served[m] === 0);
        if (q < 0) break;
        inS[S[q]] = 0;
        S[q] = bestM;
      }
      inS[bestM] = 1;
      filled++;
      const f = materials[bestM].lab;
      const next: number[] = [];
      for (const i of open) {
        const d = de(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], f[0], f[1], f[2]);
        if (d < cur[i]) {
          served[slot[i]]--;
          slot[i] = bestM;
          cur[i] = d;
          served[bestM]++;
        }
        if (!inS[nIdx[i]] && cur[i] > dn[i]) next.push(i);
      }
      open = next;
    }
    return { S, filled };
  };

  // ---- 4. Bestand bevorzugen (bei fast gleicher Eignung, auf der Zusammenfassung)
  const stocked = (m: number) => (materials[m].stock ?? 0) > 0;
  let anyStock = false;
  let anyOther = false;
  for (let m = 0; m < M; m++) {
    if (stocked(m)) anyStock = true;
    else anyOther = true;
  }
  const preferStock = (start: readonly number[]) => {
    const S = start.slice();
    let stockSwaps = 0;
    if (!anyStock || !anyOther || !S.length) return { S, stockSwaps };
    const inS = new Uint8Array(M);
    for (const m of S) inS[m] = 1;
    for (let q = 0; q < S.length; q++) {
      if (stocked(S[q])) continue;
      nearestTwo(S);
      let served = 0;
      let base = 0;
      for (let j = 0; j < J; j++) {
        base += w[j] * d1[j];
        if (n1[j] === q) served += w[j];
      }
      if (served <= 0) continue;
      let bestM = -1;
      let bestInc = Infinity;
      for (let m = 0; m < M; m++) {
        if (inS[m] || !stocked(m)) continue;
        // Kosten, wenn S[q] durch m ersetzt wird (m muss danach selbst Steine erhalten)
        let c = 0;
        let servesM = 0;
        for (let j = 0; j < J; j++) {
          const dm = D[j * M + m];
          const rest = n1[j] === q ? d2[j] : d1[j];
          if (dm < rest) {
            c += w[j] * dm;
            servesM += w[j];
          } else c += w[j] * rest;
        }
        const inc = c - base;
        if (servesM > 0 && inc < bestInc) {
          bestInc = inc;
          bestM = m;
        }
      }
      if (bestM >= 0 && bestInc <= SNAP_STOCK_BONUS * served) {
        inS[S[q]] = 0;
        S[q] = bestM;
        inS[bestM] = 1;
        stockSwaps++;
      }
    }
    return { S, stockSwaps };
  };

  // ---- 5. Schutz: gemessen wie die Zuordnung (NearestColorMatcher, Formel der Berechnung)
  const cost = (S: readonly number[]): number => {
    if (!S.length) return Infinity;
    if (!samples || !n) {
      let c = 0;
      for (let j = 0; j < J; j++) {
        let b = Infinity;
        for (const m of S) b = Math.min(b, D[j * M + m]);
        c += w[j] * b;
      }
      return W > 0 ? c / W : 0;
    }
    const sm = new NearestColorMatcher(S.map((m) => materials[m].lab), formula);
    const p = samples.pts;
    let c = 0;
    let ww = 0;
    for (let i = 0; i < n; i++) {
      const f = materials[S[sm.nearest(p[i * 3], p[i * 3 + 1], p[i * 3 + 2])]].lab;
      c += samples.ws[i] * de(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], f[0], f[1], f[2]);
      ww += samples.ws[i];
    }
    return ww > 0 ? c / ww : 0;
  };

  const g = greedy(seedSet);
  const sw = swap(g);
  const fl = fill(sw.S);
  const st = preferStock(fl.S);
  const costSnap = cost(seedSet);
  const tol = 1e-9 * Math.max(1, costSnap);
  const result = (S: number[], swaps: number, filled: number, stockSwaps: number): MaterialSelection => ({
    chosen: S,
    swaps,
    filled,
    stockSwaps,
    budgetHit: sw.budgetHit,
    costSnap,
    costSelected: cost(S),
  });
  let r = result(st.S, sw.swaps, fl.filled, st.stockSwaps);
  if (r.costSelected <= costSnap + tol) return r;
  if (st.stockSwaps > 0) {
    r = result(fl.S, sw.swaps, fl.filled, 0);
    if (r.costSelected <= costSnap + tol) return r;
  }
  const noSwap = fill(g);
  r = result(noSwap.S, 0, noSwap.filled, 0);
  if (r.costSelected <= costSnap + tol) return r;
  // nur gierig ergänzt: Obermenge der Startmenge
  r = result(g, 0, 0, 0);
  if (r.costSelected <= costSnap + tol) return r;
  return { ...result(seedSet, 0, 0, 0), fallback: true };
}
