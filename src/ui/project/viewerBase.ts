/**
 * Rückpuffer des Viewers (w5-viewer-performance): Die Steinebene wird einmal mit renderMosaic (baseOnly) in ein
 * unsichtbares Canvas gezeichnet und beim Verschieben nur noch kopiert – mit ganzzahligem Versatz in Gerätepixeln,
 * deshalb pixelgleich mit einem frischen renderMosaic derselben Ansicht (gemessen bei dpr 1: max. Kanalabweichung
 * ≤ 1 für Rechtecke und Glasur). Kanten schräger Teile, Häkchen, Schrift und – bei dpr ≠ 1 – Glasurränder glättet
 * bzw. filtert der Rasterer je nach Lage leicht anders; das tut er auch, wenn dasselbe Bild nur verschoben frisch
 * gezeichnet wird. Steinfarben sind immer gleich (e2e/w5-viewer-performance.e2e.cjs). Neu sichtbare Streifen werden mit
 * derselben Funktion nachgezeichnet (clip + Ausschnitt), geänderte Steine ebenso.
 *
 * Koordinaten: „Inhalts-Pixel“ (CDC) = Gerätepixel einer gedachten, unendlich großen Ansicht mit dem
 * Ursprung (rx, ry) des letzten vollständigen Neuaufbaus: X = rx + dpr·scale·x_mm. Der Bildschirm zeigt
 * X + D mit ganzzahligem D = (aktueller Ursprung − rx). Der Puffer ist ringförmig (toroidal): Inhalts-Pixel X liegt
 * im Puffer bei X mod Breite. Dadurch muss beim Verschieben nie umkopiert werden; ein Fenster `win` von genau
 * Pufferbreite × -höhe ist abbildbar, davon ist `valid` (ein Rechteck) aktuell gezeichnet.
 *
 * Gültigkeit (Anforderung: nie eine falsche Farbe zeigen): CellShadow merkt sich je Zelle exakt, mit welchen Daten
 * sie zuletzt gezeichnet wurde (Art, Farben, Fortschritt, Geometrie). Nach jeder Änderung (version/progressVersion)
 * und bei jedem Bild außerhalb einer Geste wird der gezeichnete Bereich damit verglichen; abweichende Zellen
 * werden neu gezeichnet. Der Viewer braucht dafür keine Liste geänderter Zellen – auch Änderungen ohne Liste
 * (Steindialog, Rückgängig, Farbe entfernen) werden zellgenau erkannt. Volles Neuzeichnen ist immer erlaubt.
 */
import { drawRange, type ScreenRect, type View } from '../../core/render';
import type { Layout } from '../../core/layout';
import { CellKind, type MosaicData } from '../../core/types';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// ------------------------------------------------------------------ Rechtecke (ganzzahlige Gerätepixel, halboffen)

/** Rechteck [x0, x1) × [y0, y1) in ganzen Gerätepixeln */
export interface DevRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const rectArea = (r: DevRect | null): number => (r ? Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0) : 0);
export const rectEmpty = (r: DevRect | null): boolean => !r || r.x1 <= r.x0 || r.y1 <= r.y0;

export function intersectRect(a: DevRect | null, b: DevRect | null): DevRect | null {
  if (!a || !b) return null;
  const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
  return rectEmpty(r) ? null : r;
}

export function containsRect(outer: DevRect | null, inner: DevRect): boolean {
  return !!outer && inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;
}

export function bboxRect(a: DevRect, b: DevRect): DevRect {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/** Ein Stück eines Inhaltsrechtecks im Ringpuffer: Pufferpixel = Inhaltspixel + (tx, ty) */
export interface WrapPiece {
  rect: DevRect;
  tx: number;
  ty: number;
}

/** Zerlegt ein Inhaltsrechteck (höchstens bw × bh groß) an den Umbruchkanten des Ringpuffers (≤ 4 Stücke). */
export function wrapPieces(r: DevRect, bw: number, bh: number): WrapPiece[] {
  if (rectEmpty(r)) return [];
  const seg = (a: number, b: number, n: number) => {
    const out: { a: number; b: number; t: number }[] = [];
    let s = a;
    while (s < b) {
      const k = Math.floor(s / n);
      const e = Math.min(b, (k + 1) * n);
      out.push({ a: s, b: e, t: k === 0 ? 0 : -k * n });
      s = e;
    }
    return out;
  };
  const xs = seg(r.x0, Math.min(r.x1, r.x0 + bw), bw);
  const ys = seg(r.y0, Math.min(r.y1, r.y0 + bh), bh);
  const out: WrapPiece[] = [];
  for (const y of ys) for (const x of xs) out.push({ rect: { x0: x.a, y0: y.a, x1: x.b, y1: y.b }, tx: x.t, ty: y.t });
  return out;
}

/**
 * Nächster Streifen, um `valid` Richtung `win` zu vergrößern (höchstens `maxArea` Pixel, mindestens 1 px dick),
 * so dass valid ∪ Streifen wieder ein Rechteck ist. null = valid deckt win schon ab.
 */
export function nextSlab(valid: DevRect, win: DevRect, maxArea: number): DevRect | null {
  const h = valid.y1 - valid.y0;
  const w = valid.x1 - valid.x0;
  const thick = (len: number, room: number) => Math.max(1, Math.min(room, Math.floor(maxArea / Math.max(1, len))));
  if (valid.x0 > win.x0) {
    const t = thick(h, valid.x0 - win.x0);
    return { x0: valid.x0 - t, y0: valid.y0, x1: valid.x0, y1: valid.y1 };
  }
  if (valid.x1 < win.x1) {
    const t = thick(h, win.x1 - valid.x1);
    return { x0: valid.x1, y0: valid.y0, x1: valid.x1 + t, y1: valid.y1 };
  }
  if (valid.y0 > win.y0) {
    const t = thick(w, valid.y0 - win.y0);
    return { x0: valid.x0, y0: valid.y0 - t, x1: valid.x1, y1: valid.y0 };
  }
  if (valid.y1 < win.y1) {
    const t = thick(w, win.y1 - valid.y1);
    return { x0: valid.x0, y0: valid.y1, x1: valid.x1, y1: valid.y1 + t };
  }
  return null;
}

// ------------------------------------------------------------------ Zellschatten (exakter Vergleich)

/** Zellbereich [r0, r1) × [c0, c1) */
export interface CellRange {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

const FULL_TAG = 0x80000000;
const EXT_TAG = 0x40000000;

/**
 * Merkt sich je Zelle exakt den Zustand, mit dem sie zuletzt in den Puffer gezeichnet wurde:
 * - ganze Steine: Art, Farbe, Fortschritt (Bit 0) in einem Uint32 – verlustfrei gepackt;
 * - geteilte/unterteilte/Freiform-Zellen: Art + vollständige Kopie von c1, c2, Fortschritt und Geometrie
 *   (Schnittgerade, k×k-Farben, Freiformpolygone mit Farben).
 * Kein Hash: eine Änderung wird nie übersehen. Noch nie gezeichnete Zellen gelten immer als geändert.
 */
export class CellShadow {
  private sig = new Uint32Array(0);
  private ext = new Map<number, Float64Array>();
  private scratch: number[] = [];

  /**
   * Für ein Raster mit n Zellen vorbereiten. Gelesen werden nur Zellen, die seit dem letzten Neuaufbau gezeichnet
   * wurden (der Puffer vergleicht nur im gezeichneten Bereich, und jede Zelle dort wurde beim Zeichnen erfasst) –
   * alte Einträge müssen deshalb nicht gelöscht werden. Nur die Geometrie-Kopien werden begrenzt.
   */
  reset(n: number): void {
    if (this.sig.length !== n) {
      this.sig = new Uint32Array(n);
      this.ext.clear();
    } else if (this.ext.size > 50_000) {
      for (const idx of this.ext.keys()) this.sig[idx] = 0;
      this.ext.clear();
    }
  }

  /** Anzahl gespeicherter Geometrie-Kopien (für Tests) */
  get extCount(): number {
    return this.ext.size;
  }

  private fullSig(data: MosaicData, idx: number, withProgress: boolean): number {
    return (FULL_TAG | (data.c1[idx] << 3) | (withProgress ? (data.progress[idx] & 1) << 19 : 0)) >>> 0;
  }

  /** Inhalt einer nicht-ganzen Zelle in scratch schreiben */
  private extOf(data: MosaicData, idx: number, kind: number, withProgress: boolean): number[] {
    const s = this.scratch;
    s.length = 0;
    s.push(kind, data.c1[idx], data.c2[idx], withProgress ? data.progress[idx] : 0);
    if (kind === CellKind.LINE) {
      const l = data.line.get(idx);
      if (!l) s.push(-1);
      else {
        s.push(l.length);
        for (let i = 0; i < l.length; i++) s.push(l[i]);
      }
    } else if (kind === CellKind.SUB) {
      const v = data.sub.get(idx);
      if (!v) s.push(-1);
      else {
        s.push(v.length);
        for (let i = 0; i < v.length; i++) s.push(v[i]);
      }
    } else if (kind === CellKind.FREE) {
      const fp = data.free.get(idx);
      if (!fp) s.push(-1);
      else {
        s.push(fp.length);
        for (const f of fp) {
          s.push(f.color, f.poly.length);
          for (const p of f.poly) s.push(p.x, p.y);
        }
      }
    }
    return s;
  }

  private same(stored: Float64Array | undefined, cur: number[]): boolean {
    if (!stored || stored.length !== cur.length) return false;
    for (let i = 0; i < cur.length; i++) {
      const a = stored[i];
      const b = cur[i];
      if (a !== b && !(a !== a && b !== b)) return false;
    }
    return true;
  }

  /** Zustand der Zellen im Bereich übernehmen (nach dem Zeichnen) */
  capture(data: MosaicData, cols: number, rg: CellRange, withProgress: boolean): void {
    for (let r = rg.r0; r < rg.r1; r++) {
      for (let c = rg.c0; c < rg.c1; c++) this.captureCell(data, r * cols + c, withProgress);
    }
  }

  captureCell(data: MosaicData, idx: number, withProgress: boolean): void {
    if (idx < 0 || idx >= this.sig.length) return;
    const kind = data.kind[idx];
    if (kind === CellKind.FULL) {
      this.sig[idx] = this.fullSig(data, idx, withProgress);
      this.ext.delete(idx);
    } else {
      this.sig[idx] = (EXT_TAG | kind) >>> 0;
      this.ext.set(idx, Float64Array.from(this.extOf(data, idx, kind, withProgress)));
    }
  }

  /** Stimmt die Zelle mit dem gemerkten Zustand überein? */
  cellSame(data: MosaicData, idx: number, withProgress: boolean): boolean {
    const kind = data.kind[idx];
    const s = this.sig[idx];
    if (kind === CellKind.FULL) return s === this.fullSig(data, idx, withProgress);
    if (s !== ((EXT_TAG | kind) >>> 0)) return false;
    return this.same(this.ext.get(idx), this.extOf(data, idx, kind, withProgress));
  }

  /**
   * Geänderte Zellen im Bereich (Zellindizes, zeilenweise). Mehr als `limit` → null (dann lohnt nur noch
   * vollständiges Neuzeichnen). limit 0 → [] oder null: „gibt es überhaupt eine Abweichung?“.
   */
  diff(data: MosaicData, cols: number, rg: CellRange, withProgress: boolean, limit: number): number[] | null {
    const out: number[] = [];
    for (let r = rg.r0; r < rg.r1; r++) {
      const base = r * cols;
      for (let c = rg.c0; c < rg.c1; c++) {
        const idx = base + c;
        if (this.cellSame(data, idx, withProgress)) continue;
        if (out.length >= limit) return null;
        out.push(idx);
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ Rückpuffer

/** Zeichnet den Inhaltsbereich `area` (CDC) in ctx, wobei Inhaltspixel X bei X + tx liegt. ctx ist bereits auf
 *  dieses Rechteck beschnitten und dort geleert; Transformation = Einheit. */
export type RenderArea = (ctx: Ctx2D, area: DevRect, tx: number, ty: number) => void;

/** Was ein Bild gekostet hat (für Tests, Fehlersuche und data-Attribute) */
export interface FrameStats {
  /** vollständiger Neuaufbau (Schlüssel, Maßstab oder Größe geändert) */
  reset: boolean;
  /** Zahl gezeichneter Rechtecke (Streifen, geänderte Steine) */
  rects: number;
  /** gezeichnete Fläche in Gerätepixeln */
  px: number;
  /** abweichende Zellen beim Vergleich mit dem Zellschatten (-1 = nicht verglichen) */
  dirty: number;
}

export interface BaseFrame {
  /** alles außer Maßstab, Ursprung und Größe, was die Steinebene beeinflusst (Identität/Wert je Eintrag) */
  key: readonly unknown[];
  layout: Layout;
  data: MosaicData;
  scale: number;
  dpr: number;
  /** ganzzahliger Ursprung der aktuellen Ansicht in Gerätepixeln (round(ox·dpr)) */
  devOx: number;
  devOy: number;
  /** Größe des Bildschirm-Canvas in Gerätepixeln */
  vw: number;
  vh: number;
  version: number;
  progressVersion: number;
  progressMode: boolean;
  /** den ganzen gezeichneten Bereich mit den Daten vergleichen (Bild außerhalb einer Geste) */
  verify: boolean;
}

/** Mehr geänderte Zellen als das → ganz neu zeichnen */
export const DIRTY_FULL_LIMIT = 20_000;
/** Ab so vielen geänderten Zellen werden sie zu Kacheln zusammengefasst */
export const DIRTY_TILE_FROM = 48;
export const DIRTY_TILE_PX = 256;

/** Rand um die sichtbare Fläche (je Seite, Gerätepixel): 12,5 % der Seitenlänge, höchstens 256 px; bei sehr großen Bildschirmen 0 */
export function marginFor(vw: number, vh: number): { mx: number; my: number } {
  if (vw * vh > 16_000_000) return { mx: 0, my: 0 };
  return { mx: Math.min(256, Math.round(vw * 0.125)), my: Math.min(256, Math.round(vh * 0.125)) };
}

const sameKey = (a: readonly unknown[] | null, b: readonly unknown[]) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

export type CanvasFactory = (w: number, h: number) => { canvas: CanvasImageSource & { width: number; height: number }; ctx: Ctx2D };

export class BaseBuffer {
  canvas: (CanvasImageSource & { width: number; height: number }) | null = null;
  private ctx: Ctx2D | null = null;
  key: readonly unknown[] | null = null;
  scale = 0;
  dpr = 1;
  /** Ursprung des letzten Neuaufbaus (Gerätepixel) – Bezug der Inhaltspixel */
  rx = 0;
  ry = 0;
  bw = 0;
  bh = 0;
  vw = 0;
  vh = 0;
  mx = 0;
  my = 0;
  win: DevRect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  valid: DevRect | null = null;
  readonly shadow = new CellShadow();
  private layout: Layout | null = null;
  private data: MosaicData | null = null;
  private progressMode = false;
  private version = NaN;
  private progressVersion = NaN;
  /** Zähler (Tests/Fehlersuche): Neuaufbauten, gezeichnete Rechtecke und Gerätepixel insgesamt */
  resets = 0;
  paints = 0;
  paintedPx = 0;
  stats: FrameStats = { reset: false, rects: 0, px: 0, dirty: -1 };

  constructor(
    private readonly create: CanvasFactory,
    private readonly render: RenderArea,
  ) {}

  /** Passt der Puffer (bis auf Maßstab) zu diesen Eingaben? Dann taugt er als skalierte Vorschau. */
  matches(f: Pick<BaseFrame, 'key' | 'dpr' | 'vw' | 'vh'>): boolean {
    return !!this.canvas && sameKey(this.key, f.key) && this.dpr === f.dpr && this.vw === f.vw && this.vh === f.vh;
  }

  /** Inhaltsrechteck des Bildschirms für diesen Ursprung */
  viewport(devOx: number, devOy: number): DevRect {
    const dx = devOx - this.rx;
    const dy = devOy - this.ry;
    return { x0: -dx, y0: -dy, x1: -dx + this.vw, y1: -dy + this.vh };
  }

  /** Inhaltsbereich (CDC) → CSS-Ansicht und Ausschnitt, wie renderMosaic sie bekommt */
  cssView(): View {
    return { scale: this.scale, ox: this.rx / this.dpr, oy: this.ry / this.dpr, width: this.vw / this.dpr, height: this.vh / this.dpr };
  }

  cssArea(r: DevRect): ScreenRect {
    return { x: r.x0 / this.dpr, y: r.y0 / this.dpr, w: (r.x1 - r.x0) / this.dpr, h: (r.y1 - r.y0) / this.dpr };
  }

  /** Zellen, deren Zeichnung das Inhaltsrechteck berühren kann – genau die, die renderMosaic dafür zeichnet */
  cellsOf(r: DevRect): CellRange {
    return drawRange(this.layout!, this.cssView(), this.cssArea(r));
  }

  /** Inhaltsrechteck einer Zelle samt Rand, in dem ihre Zeichnung liegen kann (ganze Pixel, nach außen gerundet) */
  cellRect(idx: number): DevRect {
    const L = this.layout!;
    const row = Math.floor(idx / L.cols);
    const col = idx - row * L.cols;
    const k = this.dpr * this.scale;
    const pad = (Math.max(L.tileW, L.tileH) + L.joint) * k + 2 * this.dpr;
    return {
      x0: Math.floor(this.rx + L.colX[col] * k - pad),
      y0: Math.floor(this.ry + L.rowY[row] * k - pad),
      x1: Math.ceil(this.rx + (L.colX[col] + L.colW[col]) * k + pad),
      y1: Math.ceil(this.ry + (L.rowY[row] + L.rowH[row]) * k + pad),
    };
  }

  private allocate(f: BaseFrame): void {
    const { mx, my } = marginFor(f.vw, f.vh);
    const bw = f.vw + 2 * mx;
    const bh = f.vh + 2 * my;
    if (!this.canvas || this.bw !== bw || this.bh !== bh) {
      const c = this.create(bw, bh);
      this.canvas = c.canvas;
      this.ctx = c.ctx;
    }
    this.bw = bw;
    this.bh = bh;
    this.mx = mx;
    this.my = my;
  }

  /** Alles verwerfen (z. B. beim Aushängen); der nächste Frame baut neu auf */
  drop(): void {
    this.canvas = null;
    this.ctx = null;
    this.key = null;
    this.valid = null;
    this.layout = null;
    this.data = null;
  }

  /** Neuaufbau: neuer Bezug, nichts gültig */
  private reset(f: BaseFrame): void {
    this.allocate(f);
    this.key = f.key;
    this.scale = f.scale;
    this.dpr = f.dpr;
    this.vw = f.vw;
    this.vh = f.vh;
    this.rx = f.devOx;
    this.ry = f.devOy;
    this.layout = f.layout;
    this.data = f.data;
    this.progressMode = f.progressMode;
    this.win = { x0: -this.mx, y0: -this.my, x1: f.vw + this.mx, y1: f.vh + this.my };
    this.valid = null;
    this.version = f.version;
    this.progressVersion = f.progressVersion;
    this.shadow.reset(f.layout.cols * f.layout.rows);
    this.resets++;
    this.stats.reset = true;
  }

  /** Inhaltsrechteck in den Puffer zeichnen (Ringpuffer: bis zu 4 Stücke), jeweils beschnitten und geleert */
  private paint(r: DevRect): void {
    const ctx = this.ctx!;
    for (const pc of wrapPieces(r, this.bw, this.bh)) {
      const x = pc.rect.x0 + pc.tx;
      const y = pc.rect.y0 + pc.ty;
      const w = pc.rect.x1 - pc.rect.x0;
      const h = pc.rect.y1 - pc.rect.y0;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.clearRect(x, y, w, h);
      this.render(ctx, pc.rect, pc.tx, pc.ty);
      ctx.restore();
      this.stats.rects++;
      this.stats.px += w * h;
      this.paints++;
      this.paintedPx += w * h;
    }
  }

  /** Rechteck zeichnen und den Zustand seiner Zellen merken */
  private paintAndCapture(r: DevRect): void {
    this.paint(r);
    this.shadow.capture(this.data!, this.layout!.cols, this.cellsOf(r), this.progressMode);
  }

  /**
   * Gezeichneten Bereich mit den Daten vergleichen und abweichende Zellen neu zeichnen.
   * Zu viele Abweichungen → valid = null (der Aufrufer zeichnet dann neu).
   */
  private verify(): void {
    const V = this.valid;
    if (!V) return;
    const L = this.layout!;
    const dirty = this.shadow.diff(this.data!, L.cols, this.cellsOf(V), this.progressMode, DIRTY_FULL_LIMIT);
    this.stats.dirty = dirty ? dirty.length : DIRTY_FULL_LIMIT + 1;
    if (!dirty) {
      this.valid = null;
      return;
    }
    if (!dirty.length) return;
    const rects = this.dirtyRects(dirty, V);
    if (rects.reduce((a, r) => a + rectArea(r), 0) > 0.6 * rectArea(V)) {
      this.valid = null;
      return;
    }
    for (const r of rects) this.paint(r);
    for (const idx of dirty) this.shadow.captureCell(this.data!, idx, this.progressMode);
  }

  /** Neu zu zeichnende Rechtecke für geänderte Zellen (einzeln oder zu Kacheln zusammengefasst), ∩ V */
  dirtyRects(dirty: number[], V: DevRect): DevRect[] {
    const cells = dirty.map((i) => intersectRect(this.cellRect(i), V)).filter((r): r is DevRect => !!r);
    if (cells.length <= DIRTY_TILE_FROM) return cells;
    const T = DIRTY_TILE_PX;
    const rows = new Map<number, Set<number>>();
    for (const r of cells) {
      for (let ty = Math.floor(r.y0 / T); ty * T < r.y1; ty++) {
        let s = rows.get(ty);
        if (!s) rows.set(ty, (s = new Set()));
        for (let tx = Math.floor(r.x0 / T); tx * T < r.x1; tx++) s.add(tx);
      }
    }
    const out: DevRect[] = [];
    for (const [ty, set] of rows) {
      const xs = [...set].sort((a, b) => a - b);
      let start = xs[0];
      let prev = xs[0];
      const flush = () => {
        const r = intersectRect({ x0: start * T, y0: ty * T, x1: (prev + 1) * T, y1: (ty + 1) * T }, V);
        if (r) out.push(r);
      };
      for (let i = 1; i < xs.length; i++) {
        if (xs[i] === prev + 1) prev = xs[i];
        else {
          flush();
          start = prev = xs[i];
        }
      }
      flush();
    }
    return out;
  }

  /**
   * Gültigen Bereich um `r` erweitern (valid ∪ r muss ein Rechteck sein). Vorher werden die Zellen geprüft, die
   * schon im gültigen Bereich und jetzt auch in r gezeichnet werden: weichen sie ab, wird erst der ganze gültige
   * Bereich abgeglichen – sonst bekäme eine Zelle Pixel aus zwei verschiedenen Ständen.
   */
  private extend(r: DevRect): void {
    const V = this.valid;
    if (V) {
      const a = this.cellsOf(r);
      const b = this.cellsOf(V);
      const band = { r0: Math.max(a.r0, b.r0), r1: Math.min(a.r1, b.r1), c0: Math.max(a.c0, b.c0), c1: Math.min(a.c1, b.c1) };
      if (band.r1 > band.r0 && band.c1 > band.c0 && this.shadow.diff(this.data!, this.layout!.cols, band, this.progressMode, 0) === null) {
        this.verify();
        if (!this.valid) {
          // zu viel geändert: nur den sichtbaren Bereich neu aufbauen (der Aufrufer prüft valid erneut)
          return;
        }
      }
    }
    this.paintAndCapture(r);
    this.valid = this.valid ? bboxRect(this.valid, r) : { ...r };
  }

  /**
   * Bild vorbereiten: Puffer passend machen (Neuaufbau, Abgleich mit den Daten, neue Streifen) und den sichtbaren
   * Bereich auf `screen` kopieren (Transformation dort = Einheit, ganzzahliger Versatz → pixelgenau).
   */
  frame(f: BaseFrame, screen: Ctx2D): FrameStats {
    this.stats = { reset: false, rects: 0, px: 0, dirty: -1 };
    if (!this.matches(f) || this.scale !== f.scale || this.layout !== f.layout || this.data !== f.data || this.progressMode !== f.progressMode) this.reset(f);
    // Änderungen an den Daten (oder Bild außerhalb einer Geste): abgleichen
    if (this.valid && (f.verify || f.version !== this.version || (this.progressMode && f.progressVersion !== this.progressVersion))) this.verify();
    this.version = f.version;
    this.progressVersion = f.progressVersion;
    const vp = this.viewport(f.devOx, f.devOy);
    // Fenster nachführen: sichtbarer Bereich muss im Ringpuffer abbildbar sein
    if (!containsRect(this.win, vp)) {
      this.win = { x0: vp.x0 - this.mx, y0: vp.y0 - this.my, x1: vp.x1 + this.mx, y1: vp.y1 + this.my };
      this.valid = intersectRect(this.valid, this.win);
    }
    for (let guard = 0; guard < 3 && !containsRect(this.valid, vp); guard++) {
      const V = this.valid;
      if (!V) break;
      const B = bboxRect(V, vp);
      if (rectArea(B) - rectArea(V) > rectArea(vp)) {
        // weit gesprungen: alten Bereich verwerfen, nur den sichtbaren zeichnen
        this.valid = null;
        break;
      }
      // links/rechts (in der Höhe von V), dann oben/unten (volle Breite): jedes Zwischenergebnis bleibt ein Rechteck
      const parts: DevRect[] = [
        { x0: B.x0, y0: V.y0, x1: V.x0, y1: V.y1 },
        { x0: V.x1, y0: V.y0, x1: B.x1, y1: V.y1 },
        { x0: B.x0, y0: B.y0, x1: B.x1, y1: V.y0 },
        { x0: B.x0, y0: V.y1, x1: B.x1, y1: B.y1 },
      ];
      for (const r of parts) {
        if (!this.valid) break;
        if (!rectEmpty(r)) this.extend(r);
      }
    }
    if (!containsRect(this.valid, vp)) {
      this.paintAndCapture(vp);
      this.valid = { ...vp };
    }
    this.blit(screen, vp);
    return this.stats;
  }

  /** Sichtbaren Bereich 1:1 auf den Bildschirm kopieren */
  private blit(screen: Ctx2D, vp: DevRect): void {
    const src = this.canvas!;
    screen.save();
    screen.setTransform(1, 0, 0, 1, 0, 0);
    screen.imageSmoothingEnabled = false;
    // leeren statt überblenden: das Ergebnis ist genau der Pufferinhalt, auch bei durchscheinendem Hintergrund
    screen.clearRect(0, 0, this.vw, this.vh);
    for (const pc of wrapPieces(vp, this.bw, this.bh)) {
      const w = pc.rect.x1 - pc.rect.x0;
      const h = pc.rect.y1 - pc.rect.y0;
      screen.drawImage(src, pc.rect.x0 + pc.tx, pc.rect.y0 + pc.ty, w, h, pc.rect.x0 - vp.x0, pc.rect.y0 - vp.y0, w, h);
    }
    screen.restore();
  }

  /** Muss der Rand noch nachgezeichnet werden? */
  get needsFill(): boolean {
    return !!this.canvas && !!this.valid && !containsRect(this.valid, this.win);
  }

  /**
   * Ein Stück des Randes nachzeichnen (höchstens maxArea Gerätepixel), wenn nichts anderes zu tun ist.
   * Nur mit den Daten, mit denen der Puffer zuletzt abgeglichen wurde (der Aufrufer prüft Schlüssel und Version).
   * Liefert true, solange noch Rand fehlt.
   */
  fillStep(maxArea: number, current: Pick<BaseFrame, 'version' | 'progressVersion'>): boolean {
    if (!this.needsFill) return false;
    // zwischenzeitliche Änderungen gleicht erst das nächste Bild ab (es vergleicht den ganzen Bereich)
    if (current.version !== this.version || (this.progressMode && current.progressVersion !== this.progressVersion)) return false;
    const s = nextSlab(this.valid!, this.win, maxArea);
    if (!s) return false;
    this.extend(s);
    return this.needsFill;
  }

  /**
   * Skalierte Vorschau während einer Zoom-Geste: den gültigen Bereich mit Faktor scale/this.scale an die Stelle
   * der neuen Ansicht zeichnen (unscharf erlaubt; das genaue Bild folgt nach der Geste).
   */
  drawScaled(screen: Ctx2D, scale: number, devOx: number, devOy: number): void {
    if (!this.canvas || !this.valid) return;
    const a = scale / this.scale;
    const bx = devOx - this.rx * a;
    const by = devOy - this.ry * a;
    screen.save();
    screen.setTransform(1, 0, 0, 1, 0, 0);
    screen.imageSmoothingEnabled = true;
    for (const pc of wrapPieces(this.valid, this.bw, this.bh)) {
      const w = pc.rect.x1 - pc.rect.x0;
      const h = pc.rect.y1 - pc.rect.y0;
      screen.drawImage(this.canvas, pc.rect.x0 + pc.tx, pc.rect.y0 + pc.ty, w, h, a * pc.rect.x0 + bx, a * pc.rect.y0 + by, a * w, a * h);
    }
    screen.restore();
  }
}
