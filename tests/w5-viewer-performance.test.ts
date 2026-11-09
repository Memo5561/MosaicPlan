/**
 * w5-viewer-performance: Rückpuffer des Viewers. Geprüft wird die Logik ohne Browser:
 * - Rechteck-/Ringpuffer-Hilfen und das Nachwachsen des Randes,
 * - der Zellschatten erkennt jede Änderung exakt (auch In-place-Änderungen an Unterteilung/Freiform),
 * - BaseBuffer mit einem Pixel-Modell-Canvas: nach beliebigem Verschieben, Bearbeiten (mit/ohne Versionszähler),
 *   Größen- und Maßstabswechsel zeigt der Bildschirm Pixel für Pixel genau das, was ein frisches Zeichnen zeigen würde,
 * - renderMosaic = Steinebene (baseOnly) + drawMosaicOverlay, Zeichnen eines Ausschnitts = derselbe Inhalt.
 * Die echte Canvas-Kantenglättung prüft e2e/w5-viewer-performance.e2e.cjs im Browser.
 */
import { describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { setCellKind, setFreePieces, setPieceColor } from '../src/core/edits';
import { computeLayout, computeSections } from '../src/core/layout';
import { drawMosaicOverlay, drawPadPx, drawRange, renderMosaic, visibleRange, type RenderOptions, type View } from '../src/core/render';
import { CellKind, createEmptyMosaic, type MosaicData, type PaletteColor } from '../src/core/types';
import {
  BaseBuffer,
  bboxRect,
  CellShadow,
  containsRect,
  intersectRect,
  marginFor,
  nextSlab,
  rectArea,
  wrapPieces,
  type BaseFrame,
  type CanvasFactory,
  type DevRect,
  type RenderArea,
} from '../src/ui/project/viewerBase';

const pal = (hexes: string[]): PaletteColor[] => hexes.map((hex, i) => ({ code: i + 1, name: `F${i + 1}`, hex, lab: hexToLab(hex) }));

/** deterministischer Zufall */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------- Rechtecke

describe('Rechteck- und Ringpuffer-Hilfen', () => {
  it('wrapPieces zerlegt ein Rechteck lückenlos und überlappungsfrei, jedes Stück liegt im Puffer', () => {
    const r = rng(1);
    for (let t = 0; t < 400; t++) {
      const bw = 5 + Math.floor(r() * 40);
      const bh = 5 + Math.floor(r() * 40);
      const x0 = Math.floor((r() - 0.5) * 300);
      const y0 = Math.floor((r() - 0.5) * 300);
      const rect = { x0, y0, x1: x0 + 1 + Math.floor(r() * bw), y1: y0 + 1 + Math.floor(r() * bh) };
      const ps = wrapPieces(rect, bw, bh);
      expect(ps.length).toBeLessThanOrEqual(4);
      expect(ps.reduce((a, p) => a + rectArea(p.rect), 0)).toBe(rectArea(rect));
      const seen = new Set<string>();
      for (const p of ps) {
        expect(containsRect(rect, p.rect)).toBe(true);
        // Pufferkoordinaten innerhalb [0, bw) × [0, bh), jedes Pufferpixel höchstens einmal
        expect(p.rect.x0 + p.tx).toBeGreaterThanOrEqual(0);
        expect(p.rect.x1 + p.tx).toBeLessThanOrEqual(bw);
        expect(p.rect.y0 + p.ty).toBeGreaterThanOrEqual(0);
        expect(p.rect.y1 + p.ty).toBeLessThanOrEqual(bh);
        expect(Math.abs(p.tx % bw)).toBe(0);
        expect(Math.abs(p.ty % bh)).toBe(0);
        for (let y = p.rect.y0; y < p.rect.y1; y++)
          for (let x = p.rect.x0; x < p.rect.x1; x++) {
            const k = `${x + p.tx},${y + p.ty}`;
            expect(seen.has(k)).toBe(false);
            seen.add(k);
          }
      }
    }
  });

  it('intersectRect, bboxRect, containsRect', () => {
    const a = { x0: 0, y0: 0, x1: 10, y1: 10 };
    const b = { x0: 3, y0: 4, x1: 6, y1: 8 };
    expect(intersectRect(a, b)).toEqual(b);
    expect(containsRect(a, b)).toBe(true);
    expect(containsRect(b, a)).toBe(false);
    expect(bboxRect(a, b)).toEqual(a);
    expect(intersectRect(a, { x0: 10, y0: 0, x1: 12, y1: 5 })).toBeNull();
  });

  it('nextSlab lässt den gültigen Bereich als Rechteck bis zum Fenster wachsen, jeder Schritt höchstens maxArea', () => {
    const win = { x0: -30, y0: -20, x1: 130, y1: 100 };
    let valid: DevRect = { x0: 0, y0: 0, x1: 100, y1: 80 };
    let n = 0;
    for (;;) {
      const s = nextSlab(valid, win, 500);
      if (!s) break;
      expect(rectArea(s)).toBeLessThanOrEqual(Math.max(500, Math.max(s.x1 - s.x0, s.y1 - s.y0)));
      expect(intersectRect(s, valid)).toBeNull();
      const u = bboxRect(valid, s);
      // Vereinigung ist wieder ein Rechteck: Fläche addiert sich genau
      expect(rectArea(u)).toBe(rectArea(valid) + rectArea(s));
      valid = u;
      expect(++n).toBeLessThan(1000);
    }
    expect(valid).toEqual(win);
  });

  it('Rand: 12,5 % je Seite, höchstens 256 px, bei riesigen Bildschirmen keiner', () => {
    expect(marginFor(2560, 1600)).toEqual({ mx: 256, my: 200 });
    expect(marginFor(800, 600)).toEqual({ mx: 100, my: 75 });
    expect(marginFor(8000, 4000)).toEqual({ mx: 0, my: 0 });
  });
});

// ---------------------------------------------------------------- Zellschatten

describe('CellShadow: exakter Vergleich je Zelle', () => {
  const layout = computeLayout({ widthMm: 120, heightMm: 60, tileW: 10, tileH: 10, joint: 2, edgeMode: 'whole', minCutMm: 2 });
  const all = { r0: 0, r1: layout.rows, c0: 0, c1: layout.cols };
  const fresh = () => {
    const d = createEmptyMosaic(layout.cols, layout.rows);
    for (let i = 0; i < d.c1.length; i++) d.c1[i] = i % 5;
    setCellKind(layout, d, 1, 1, { kind: CellKind.SUB, k: 2 }, 1);
    setCellKind(layout, d, 1, 2, { kind: CellKind.LINE, angleDeg: 20, offsetMm: 1 }, 1);
    setCellKind(layout, d, 1, 3, { kind: CellKind.DIAG_B }, 1);
    setFreePieces(
      layout,
      d,
      2,
      2,
      [
        { poly: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 6 }], color: 1 },
        { poly: [{ x: 10, y: 2 }, { x: 10, y: 10 }, { x: 2, y: 10 }], color: 2 },
      ],
      1,
    );
    return d;
  };
  const idx = (r: number, c: number) => r * layout.cols + c;

  it('nach dem Erfassen keine Abweichung; noch nie erfasste Zellen gelten als geändert', () => {
    const d = fresh();
    const sh = new CellShadow();
    sh.reset(layout.cols * layout.rows);
    expect(sh.diff(d, layout.cols, all, true, 1e9)!.length).toBe(layout.cols * layout.rows);
    sh.capture(d, layout.cols, all, true);
    expect(sh.diff(d, layout.cols, all, true, 1e9)).toEqual([]);
  });

  it('Geometrie wird nur für geteilte/unterteilte/Freiform-Zellen kopiert', () => {
    const d = fresh();
    const sh = new CellShadow();
    sh.reset(layout.cols * layout.rows);
    sh.capture(d, layout.cols, all, true);
    expect(sh.extCount).toBe(4);
  });

  it('erkennt jede sichtbare Änderung – auch In-place an Unterteilung, Freiform und Schnittgerade', () => {
    const cases: [string, (d: MosaicData) => void, number][] = [
      ['ganze Farbe', (d) => setPieceColor(d, idx(0, 0), 0, 4), idx(0, 0)],
      ['SUB-Farbe in place', (d) => setPieceColor(d, idx(1, 1), 3, 4), idx(1, 1)],
      ['LINE c2', (d) => setPieceColor(d, idx(1, 2), 1, 4), idx(1, 2)],
      ['DIAG → FULL', (d) => setCellKind(layout, d, 1, 3, { kind: CellKind.FULL }, 1), idx(1, 3)],
      ['FREE-Farbe in place', (d) => setPieceColor(d, idx(2, 2), 1, 0), idx(2, 2)],
      ['FREE-Polygon in place', (d) => void (d.free.get(idx(2, 2))![0].poly[2].y = 5), idx(2, 2)],
      ['Schnittgerade in place', (d) => void (d.line.get(idx(1, 2))![2] = Math.fround(1.5)), idx(1, 2)],
      ['verlegt (ganzer Stein)', (d) => void (d.progress[idx(3, 3)] ^= 1), idx(3, 3)],
      ['verlegt (Teil 2 einer Unterteilung)', (d) => void (d.progress[idx(1, 1)] ^= 2), idx(1, 1)],
    ];
    for (const [name, mutate, at] of cases) {
      const d = fresh();
      const sh = new CellShadow();
      sh.reset(layout.cols * layout.rows);
      sh.capture(d, layout.cols, all, true);
      mutate(d);
      expect(sh.diff(d, layout.cols, all, true, 1e9), name).toEqual([at]);
      // erfassen → wieder gleich
      sh.captureCell(d, at, true);
      expect(sh.diff(d, layout.cols, all, true, 1e9), name).toEqual([]);
    }
  });

  it('Fortschritt zählt nur im Verlegemodus; Grenze liefert null', () => {
    const d = fresh();
    const sh = new CellShadow();
    sh.reset(layout.cols * layout.rows);
    sh.capture(d, layout.cols, all, false);
    d.progress[idx(0, 5)] = 1;
    expect(sh.diff(d, layout.cols, all, false, 1e9)).toEqual([]);
    d.c1[idx(0, 1)] = 3;
    d.c1[idx(0, 2)] = 3;
    expect(sh.diff(d, layout.cols, all, false, 1)).toBeNull();
    expect(sh.diff(d, layout.cols, all, false, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------- BaseBuffer mit Pixel-Modell

/** Pixel-Modell eines Canvas: je Pixel eine Inhalts-Kennung (−1 = leer). Nur das, was BaseBuffer benutzt. */
class FakeSurface {
  px: Int32Array;
  constructor(
    public width: number,
    public height: number,
  ) {
    this.px = new Int32Array(width * height).fill(-1);
  }
}
class FakeCtx {
  private t = { e: 0, f: 0 };
  private clipR: DevRect;
  private stack: { t: { e: number; f: number }; clip: DevRect }[] = [];
  private path: DevRect | null = null;
  imageSmoothingEnabled = true;
  globalCompositeOperation = 'source-over';
  constructor(public s: FakeSurface) {
    this.clipR = { x0: 0, y0: 0, x1: s.width, y1: s.height };
  }
  get clipRect() {
    return this.clipR;
  }
  get offset() {
    return this.t;
  }
  save() {
    this.stack.push({ t: { ...this.t }, clip: { ...this.clipR } });
  }
  restore() {
    const st = this.stack.pop()!;
    this.t = st.t;
    this.clipR = st.clip;
  }
  setTransform(a: number, _b: number, _c: number, d: number, e: number, f: number) {
    // BaseBuffer selbst nutzt nur reine Verschiebungen (a = d = 1)
    if (a !== 1 || d !== 1) throw new Error('nur Verschiebung');
    this.t = { e, f };
  }
  beginPath() {
    this.path = null;
  }
  rect(x: number, y: number, w: number, h: number) {
    this.path = { x0: x + this.t.e, y0: y + this.t.f, x1: x + w + this.t.e, y1: y + h + this.t.f };
  }
  clip() {
    this.clipR = intersectRect(this.clipR, this.path) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
  }
  /** ein Pixel im aktuellen Ausschnitt setzen (Gerätekoordinaten) */
  put(x: number, y: number, v: number) {
    const c = this.clipR;
    if (x < c.x0 || x >= c.x1 || y < c.y0 || y >= c.y1) return;
    this.s.px[y * this.s.width + x] = v;
  }
  clearRect(x: number, y: number, w: number, h: number) {
    for (let yy = y + this.t.f; yy < y + h + this.t.f; yy++) for (let xx = x + this.t.e; xx < x + w + this.t.e; xx++) this.put(xx, yy, -1);
  }
  drawImage(src: FakeSurface, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) {
    if (sw !== dw || sh !== dh || ![sx, sy, dx, dy].every(Number.isInteger)) throw new Error('nur 1:1 mit ganzen Pixeln');
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        if (sx + x < 0 || sy + y < 0 || sx + x >= src.width || sy + y >= src.height) throw new Error('außerhalb der Quelle');
        this.put(dx + x + this.t.e, dy + y + this.t.f, src.px[(sy + y) * src.width + sx + x]);
      }
  }
}

describe('BaseBuffer: Bildschirm = frisch gezeichnetes Bild, bei jedem Schritt', () => {
  const layout = computeLayout({ widthMm: 600, heightMm: 420, tileW: 10, tileH: 10, joint: 2, edgeMode: 'whole', minCutMm: 2 });
  const scale = 0.7; // ≈ 8,4 px je Raster bei dpr 1
  const k = scale; // dpr 1

  /** Inhalt eines Weltpixels (relativ zum Mosaikursprung): Zelle × 16 + Farbe (+ verlegt), Fuge/außen −2 */
  const contentAt = (d: MosaicData, X: number, Y: number): number => {
    const x = (X + 0.5) / k;
    const y = (Y + 0.5) / k;
    const col = findCell(layout.colX, layout.colW, x);
    const row = findCell(layout.rowY, layout.rowH, y);
    if (col < 0 || row < 0) return -2;
    const i = row * layout.cols + col;
    return i * 64 + d.c1[i] * 2 + (d.progress[i] & 1);
  };
  function findCell(pos: Float64Array, size: Float64Array, v: number): number {
    for (let i = 0; i < pos.length; i++) if (v >= pos[i] && v < pos[i] + size[i]) return i;
    return -1;
  }

  function setup(vw: number, vh: number) {
    const data = createEmptyMosaic(layout.cols, layout.rows);
    for (let i = 0; i < data.c1.length; i++) data.c1[i] = i % 7;
    let renders = 0;
    const create: CanvasFactory = (w, h) => {
      const s = new FakeSurface(w, h);
      return { canvas: s as unknown as CanvasImageSource & { width: number; height: number }, ctx: new FakeCtx(s) as unknown as CanvasRenderingContext2D };
    };
    let buf: BaseBuffer;
    const render: RenderArea = (ctx, area, tx, ty) => {
      renders++;
      const c = ctx as unknown as FakeCtx;
      // der Ausschnitt ist bereits beschnitten und geleert
      expect(c.clipRect).toEqual({ x0: area.x0 + tx, y0: area.y0 + ty, x1: area.x1 + tx, y1: area.y1 + ty });
      for (let Y = area.y0; Y < area.y1; Y++) for (let X = area.x0; X < area.x1; X++) c.put(X + tx, Y + ty, contentAt(data, X - buf.rx, Y - buf.ry));
    };
    buf = new BaseBuffer(create, render);
    const screen = new FakeSurface(vw, vh);
    const sctx = new FakeCtx(screen);
    return { data, buf, screen, sctx, renders: () => renders };
  }

  const check = (screen: FakeSurface, data: MosaicData, devOx: number, devOy: number) => {
    let bad = 0;
    for (let j = 0; j < screen.height; j++)
      for (let i = 0; i < screen.width; i++) if (screen.px[j * screen.width + i] !== contentAt(data, i - devOx, j - devOy)) bad++;
    return bad;
  };

  it('Zufallsfolge aus Verschieben, Bearbeiten (mit und ohne Zähler), Rand-Nachzeichnen, Größe und Maßstab: nie ein falsches Pixel', () => {
    const vw0 = 90;
    const vh0 = 70;
    const s = setup(vw0, vh0);
    let { screen, sctx } = s;
    const { data, buf } = s;
    const r = rng(7);
    let devOx = 20;
    let devOy = 15;
    let version = 0;
    let pv = 0;
    let vw = vw0;
    let vh = vh0;
    const key = ['k'];
    const frame = (verify: boolean) => {
      const f: BaseFrame = { key, layout, data, scale, dpr: 1, devOx, devOy, vw, vh, version, progressVersion: pv, progressMode: true, verify };
      return buf.frame(f, sctx as unknown as CanvasRenderingContext2D);
    };
    frame(true);
    expect(check(screen, data, devOx, devOy)).toBe(0);
    let silentPending = false;
    for (let step = 0; step < 500; step++) {
      const op = r();
      let verify = false;
      if (op < 0.45) {
        // verschieben (meist klein, manchmal weit)
        const far = r() < 0.15;
        devOx += Math.round((r() - 0.5) * (far ? 600 : 40));
        devOy += Math.round((r() - 0.5) * (far ? 600 : 40));
      } else if (op < 0.6) {
        // Stein bearbeiten (Farbe) + version
        const i = Math.floor(r() * data.c1.length);
        data.c1[i] = (data.c1[i] + 1) % 7;
        version++;
        verify = r() < 0.5;
      } else if (op < 0.7) {
        // Verlegt-Tippen + progressVersion (Geste läuft noch: kein Abgleich außer durch den Zähler)
        const i = Math.floor(r() * data.c1.length);
        data.progress[i] ^= 1;
        pv++;
      } else if (op < 0.75) {
        // Änderung OHNE Zähler (Sicherheitsnetz): das nächste Bild außerhalb einer Geste muss sie zeigen
        const i = Math.floor(r() * data.c1.length);
        data.c1[i] = (data.c1[i] + 3) % 7;
        silentPending = true;
      } else if (op < 0.88) {
        // Rand in Leerlaufzeit
        for (let n = 0; n < 3; n++) buf.fillStep(1500, { version, progressVersion: pv });
        continue;
      } else if (op < 0.94) {
        // Bild außerhalb einer Geste
        verify = true;
      } else if (op < 0.97) {
        vw = 60 + Math.floor(r() * 60);
        vh = 50 + Math.floor(r() * 40);
        screen = new FakeSurface(vw, vh);
        sctx = new FakeCtx(screen);
      } else {
        // andere Eingaben (z. B. Palette): Neuaufbau über den Schlüssel
        key[0] = `k${step}`;
      }
      const st = frame(verify || silentPending);
      if (verify || silentPending) silentPending = false;
      expect(st.rects).toBeGreaterThanOrEqual(0);
      expect(check(screen, data, devOx, devOy), `Schritt ${step}`).toBe(0);
    }
  });

  it('Verschieben innerhalb des Randes zeichnet nichts neu; ein geänderter Stein zeichnet nur sein Umfeld', () => {
    const { data, buf, screen, sctx, renders } = setup(100, 80);
    const f = (o: Partial<BaseFrame>): BaseFrame => ({ key: ['a'], layout, data, scale, dpr: 1, devOx: 0, devOy: 0, vw: 100, vh: 80, version: 0, progressVersion: 0, progressMode: true, verify: false, ...o });
    buf.frame(f({}), sctx as unknown as CanvasRenderingContext2D);
    while (buf.fillStep(1e9, { version: 0, progressVersion: 0 }));
    expect(buf.needsFill).toBe(false);
    const r0 = renders();
    // innerhalb des Randes (12 px rechts, 9 px unten)
    let st = buf.frame(f({ devOx: -10, devOy: -8 }), sctx as unknown as CanvasRenderingContext2D);
    expect(st.rects).toBe(0);
    expect(renders()).toBe(r0);
    expect(check(screen, data, -10, -8)).toBe(0);
    // ein Stein ändert sich (version): nur er wird neu gezeichnet
    const i = 3 * layout.cols + 4;
    data.c1[i] = 6;
    st = buf.frame(f({ devOx: -10, devOy: -8, version: 1 }), sctx as unknown as CanvasRenderingContext2D);
    expect(st.dirty).toBe(1);
    expect(st.reset).toBe(false);
    const cell = (layout.tileW + layout.joint) * scale;
    expect(st.px).toBeLessThanOrEqual(Math.ceil(3 * cell + 6) ** 2);
    expect(check(screen, data, -10, -8)).toBe(0);
    // Verlegt-Tippen
    data.progress[i] = 1;
    st = buf.frame(f({ devOx: -10, devOy: -8, version: 1, progressVersion: 1 }), sctx as unknown as CanvasRenderingContext2D);
    expect(st.dirty).toBe(1);
    expect(check(screen, data, -10, -8)).toBe(0);
    // viele Änderungen auf einmal → ganz neu (valid verworfen), Bild trotzdem richtig
    for (let n = 0; n < data.c1.length; n++) data.c1[n] = (data.c1[n] + 1) % 7;
    st = buf.frame(f({ devOx: -10, devOy: -8, version: 2, progressVersion: 1 }), sctx as unknown as CanvasRenderingContext2D);
    expect(check(screen, data, -10, -8)).toBe(0);
  });

  it('Schlüssel, Maßstab, Größe oder Daten-Objekt geändert → Neuaufbau', () => {
    const { data, buf, sctx } = setup(80, 60);
    const base: BaseFrame = { key: ['a', 1], layout, data, scale, dpr: 1, devOx: 0, devOy: 0, vw: 80, vh: 60, version: 0, progressVersion: 0, progressMode: false, verify: false };
    const ctx = sctx as unknown as CanvasRenderingContext2D;
    expect(buf.frame(base, ctx).reset).toBe(true);
    expect(buf.frame({ ...base }, ctx).reset).toBe(false);
    expect(buf.frame({ ...base, key: ['a', 2] }, ctx).reset).toBe(true);
    expect(buf.frame({ ...base, key: ['a', 2], scale: scale * 1.1 }, ctx).reset).toBe(true);
    expect(buf.frame({ ...base, key: ['a', 2], scale: scale * 1.1, dpr: 2 }, ctx).reset).toBe(true);
    const d2 = createEmptyMosaic(layout.cols, layout.rows);
    expect(buf.frame({ ...base, key: ['a', 2], scale: scale * 1.1, dpr: 2, data: d2 }, ctx).reset).toBe(true);
    expect(buf.matches({ key: ['a', 2], dpr: 2, vw: 80, vh: 60 })).toBe(true);
    expect(buf.matches({ key: ['a', 3], dpr: 2, vw: 80, vh: 60 })).toBe(false);
  });
});

// ---------------------------------------------------------------- render.ts

/** Zeichenbefehle mitschreiben (Methodenaufrufe und gesetzte Eigenschaften) */
function recorder() {
  const log: string[] = [];
  const state: Record<string, unknown> = {};
  const target = {
    measureText: (s: string) => ({ width: s.length * 6 }),
  };
  const ctx = new Proxy(target as Record<string, unknown>, {
    get(t, p: string) {
      if (p in t) return t[p];
      if (p in state) return state[p];
      return (...args: unknown[]) => {
        log.push(`${p}(${args.map((a) => (typeof a === 'number' ? +a.toFixed(6) : typeof a === 'object' ? 'obj' : String(a))).join(',')})`);
      };
    },
    set(_t, p: string, v) {
      state[p] = v;
      log.push(`${p}=${typeof v === 'number' ? +v.toFixed(6) : String(v)}`);
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}

describe('render.ts: Steinebene + Überlagerung = renderMosaic', () => {
  const layout = computeLayout({ widthMm: 300, heightMm: 200, tileW: 10, tileH: 10, joint: 2, edgeMode: 'whole', minCutMm: 2 });
  const data = createEmptyMosaic(layout.cols, layout.rows);
  for (let i = 0; i < data.c1.length; i++) data.c1[i] = i % 4;
  setCellKind(layout, data, 2, 3, { kind: CellKind.DIAG_A }, 1);
  data.progress[5] = 1;
  const palette = pal(['#F2EEE6', '#C0262D', '#3A6EA5', '#2E7D32']);
  const view: View = { scale: 2, ox: -40, oy: 18, width: 400, height: 300 };
  const opt: RenderOptions = {
    groutHex: '#BDB8AE',
    realistic: true,
    surface: 'glass',
    showCodes: true,
    progressMode: true,
    sections: computeSections(layout, 100, 80),
    selectedSection: 'A1',
    highlight: { row: 2, col: 3, piece: 1 },
    focusColor: 2,
    rulers: true,
    focusRange: { r0: 1, r1: 5, c0: 2, c1: 9 },
  };

  it('identische Zeichenbefehle: renderMosaic = renderMosaic(baseOnly) + drawMosaicOverlay', () => {
    const a = recorder();
    renderMosaic(a.ctx, layout, data, palette, view, opt);
    const b = recorder();
    renderMosaic(b.ctx, layout, data, palette, view, { ...opt, baseOnly: true });
    drawMosaicOverlay(b.ctx, layout, data, view, opt);
    // die Überlagerung läuft in eigenem save/restore
    const strip = (l: string[]) => l.filter((x) => x !== 'save()' && x !== 'restore()');
    expect(strip(b.log)).toEqual(strip(a.log));
    expect(a.log.length).toBeGreaterThan(500);
  });

  it('baseOnly zeichnet keine Überlagerung (keine Schrift außer Farbcodes, kein Lineal)', () => {
    const b = recorder();
    const info = renderMosaic(b.ctx, layout, data, palette, view, { ...opt, baseOnly: true });
    expect(info.rulers).toBeNull();
    expect(b.log.some((l) => l.startsWith('setLineDash'))).toBe(false);
  });

  it('drawRange: Obermenge der sichtbaren Zellen, um drawPadPx erweitert; leerer Ausschnitt außerhalb', () => {
    const vr = visibleRange(layout, view);
    const dr = drawRange(layout, view, { x: 0, y: 0, w: view.width, h: view.height });
    expect(dr.c0).toBeLessThanOrEqual(vr.c0);
    expect(dr.r0).toBeLessThanOrEqual(vr.r0);
    expect(dr.c1).toBeGreaterThanOrEqual(vr.c1);
    expect(dr.r1).toBeGreaterThanOrEqual(vr.r1);
    const pad = drawPadPx(layout, view.scale);
    expect(pad).toBeCloseTo(12 * 2 + 2, 9);
    // jede Zelle, deren um pad erweitertes Rechteck den Ausschnitt schneidet, ist dabei – und keine andere
    const area = { x: 100, y: 60, w: 37, h: 23 };
    const r = drawRange(layout, view, area);
    for (let c = 0; c < layout.cols; c++) {
      const x0 = view.ox + layout.colX[c] * view.scale - pad;
      const x1 = view.ox + (layout.colX[c] + layout.colW[c]) * view.scale + pad;
      const hit = x1 > area.x && x0 < area.x + area.w;
      expect(c >= r.c0 && c < r.c1, `Spalte ${c}`).toBe(hit);
    }
    const out = drawRange(layout, view, { x: 5000, y: 0, w: 10, h: 10 });
    expect(out.c1 - out.c0).toBe(0);
  });

  it('Ausschnitt (area): Hintergrund nur dort, Steine nur in seiner Nähe', () => {
    const a = recorder();
    renderMosaic(a.ctx, layout, data, palette, view, { ...opt, baseOnly: true, area: { x: 100, y: 60, w: 37, h: 23 } });
    expect(a.log).toContain('fillRect(100,60,37,23)');
    const full = recorder();
    renderMosaic(full.ctx, layout, data, palette, view, { ...opt, baseOnly: true });
    expect(a.log.length).toBeLessThan(full.log.length / 5);
  });

  it('overviewMode: false erzwingt Steine, true die Übersicht (wenn vorhanden)', () => {
    const small: View = { ...view, scale: 0.1 };
    const ov = {} as CanvasImageSource;
    const a = recorder();
    renderMosaic(a.ctx, layout, data, palette, small, { ...opt, overview: ov, overviewMode: false, baseOnly: true });
    expect(a.log.filter((l) => l.startsWith('drawImage')).length).toBe(0);
    const b = recorder();
    renderMosaic(b.ctx, layout, data, palette, view, { ...opt, overview: ov, overviewMode: true, baseOnly: true });
    expect(b.log.filter((l) => l.startsWith('drawImage')).length).toBe(1);
    const c = recorder();
    renderMosaic(c.ctx, layout, data, palette, small, { ...opt, overview: ov, baseOnly: true });
    expect(c.log.filter((l) => l.startsWith('drawImage')).length).toBe(1);
  });
});

