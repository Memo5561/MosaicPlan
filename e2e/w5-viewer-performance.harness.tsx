/**
 * Prüfstand für e2e/w5-viewer-performance.e2e.cjs: rendert den echten Viewer (src/ui/project/Viewer.tsx) mit einem
 * synthetischen Mosaik (Glas-Steine mit Glasur, Farbcodes, geteilte/unterteilte/Freiform-Zellen, verlegte Steine,
 * Abschnitte) und vergleicht sein Bild Pixel für Pixel mit einem frischen renderMosaic derselben Ansicht.
 * So wird geprüft, dass der Rückpuffer (Verschieben, Streifen, geänderte Steine, Zoom) nie ein anderes Bild zeigt.
 * Wird vom e2e-Skript mit esbuild gebündelt; nicht Teil der App.
 */
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/ui/styles.css';
import { hexToLab } from '../src/core/color';
import { setCellKind, setFreePieces } from '../src/core/edits';
import { computeLayout, computeSections } from '../src/core/layout';
import { renderMosaic } from '../src/core/render';
import { CellKind, createEmptyMosaic, type PaletteColor } from '../src/core/types';
import { I18nContext, makeT, numberFormatter } from '../src/i18n';
import { Viewer, type ViewerHandle, type ViewerProps } from '../src/ui/project/Viewer';

/**
 * Parameter vom e2e-Skript: w/h Mosaikgröße in mm; simple = nur ganze Steine ohne Codes und Häkchen (nur Rechtecke
 * und Glasurbild – dort ist die Kantenglättung des Canvas verschiebungsinvariant);
 * refMargin = Vergleichsbild mit Rand zeichnen (misst die Verschiebungsempfindlichkeit des Rasterers selbst).
 */
const hp = (window as unknown as { __hp?: { w?: number; h?: number; simple?: boolean; refMargin?: number } }).__hp ?? {};
const W = hp.w ?? 1500;
const H = hp.h ?? 1100;
const layout = computeLayout({ widthMm: W, heightMm: H, tileW: 10, tileH: 10, joint: 2, edgeMode: 'whole', minCutMm: 2 });
const data = createEmptyMosaic(layout.cols, layout.rows);
const hexes = ['#F2EEE6', '#C0262D', '#3A6EA5', '#2E7D32', '#E8B04A', '#1D1F1B', '#8E5A9B', '#5BB8C9'];
const palette: PaletteColor[] = hexes.map((hex, i) => ({ code: i + 1, name: `F${i + 1}`, hex, lab: hexToLab(hex) }));
for (let i = 0; i < data.c1.length; i++) data.c1[i] = (i * 7 + Math.floor(i / layout.cols) * 3) % hexes.length;
// geteilte, unterteilte und Freiform-Zellen verstreut, einige Steine verlegt
for (let r = 1; !hp.simple && r < layout.rows; r += 4) {
  for (let c = (r * 3) % 5; c < layout.cols; c += 5) {
    const k = (r + c) % 4;
    if (k === 0) setCellKind(layout, data, r, c, { kind: CellKind.DIAG_A }, 1);
    else if (k === 1) setCellKind(layout, data, r, c, { kind: CellKind.SUB, k: 2 }, 1);
    else if (k === 2) setCellKind(layout, data, r, c, { kind: CellKind.LINE, angleDeg: 30 + c, offsetMm: 1 }, 1);
    else
      setFreePieces(
        layout,
        data,
        r,
        c,
        [
          { poly: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 6 }], color: (r + c) % hexes.length },
          { poly: [{ x: 10, y: 2 }, { x: 10, y: 10 }, { x: 2, y: 10 }], color: (r * c + 1) % hexes.length },
        ],
        1,
      );
    data.c2[r * layout.cols + c] = (r + 2 * c) % hexes.length;
  }
}
for (let i = 0; i < data.progress.length; i += 11) data.progress[i] = 1;
const sections = computeSections(layout, 300, 240);

declare global {
  interface Window {
    __h: {
      layout: { cols: number; rows: number; colX: number[]; colW: number[]; rowY: number[]; rowH: number[]; finishedW: number; finishedH: number };
      setProps: (p: Partial<ViewerProps>) => void;
      viewer: () => ViewerHandle | null;
      /** Farbe eines Steins ändern (wie der Steindialog) und version erhöhen */
      setColor: (idx: number, color: number) => void;
      /** Stein als verlegt umschalten und progressVersion erhöhen (wie ein Tippen im Verlegemodus) */
      toggleLaid: (idx: number) => void;
      /** Farbe ändern, OHNE version zu erhöhen (Sicherheitsnetz: Abgleich bei jedem Bild außerhalb einer Geste) */
      setColorSilently: (idx: number, color: number) => void;
      c1: (idx: number) => number;
      /** Viewer-Canvas mit frischem renderMosaic derselben Ansicht vergleichen */
      compare: (dump?: boolean) => { max: number; over1: number; total: number; at: [number, number] | null; frame: string; images?: { viewer: string; fresh: string; diff: string } };
    };
  }
}

let current: ViewerProps | null = null;

function Harness() {
  const [extra, setExtra] = useState<Partial<ViewerProps>>({});
  const [version, setVersion] = useState(0);
  const [pv, setPv] = useState(0);
  const ref = useRef<ViewerHandle>(null);
  window.__h.setProps = (p) => setExtra((prev) => ({ ...prev, ...p }));
  window.__h.viewer = () => ref.current;
  window.__h.setColor = (idx, color) => {
    data.c1[idx] = color;
    setVersion((v) => v + 1);
  };
  window.__h.toggleLaid = (idx) => {
    data.progress[idx] ^= 1;
    setPv((v) => v + 1);
  };
  const props: ViewerProps = {
    layout,
    data,
    palette,
    version,
    progressVersion: pv,
    groutHex: '#BDB8AE',
    surface: 'glass',
    realistic: true,
    showCodes: !hp.simple,
    progressMode: !hp.simple,
    sections,
    selectedSection: null,
    highlight: null,
    rulers: true,
    height: 560,
    ...extra,
  };
  current = props;
  return (
    <div style={{ width: 760, padding: 0 }}>
      <Viewer ref={ref} {...props} />
    </div>
  );
}

window.__h = {
  layout: {
    cols: layout.cols,
    rows: layout.rows,
    colX: Array.from(layout.colX),
    colW: Array.from(layout.colW),
    rowY: Array.from(layout.rowY),
    rowH: Array.from(layout.rowH),
    finishedW: layout.finishedW,
    finishedH: layout.finishedH,
  },
  setProps: () => {},
  viewer: () => null,
  setColor: () => {},
  toggleLaid: () => {},
  setColorSilently: (idx, color) => {
    data.c1[idx] = color;
  },
  c1: (idx) => data.c1[idx],
  compare: (dump) => {
    const cv = document.querySelector('[data-testid="mosaic-canvas"]') as HTMLCanvasElement;
    const v = window.__h.viewer()?.drawnView();
    const p = current;
    if (!cv || !v || !p) return { max: 999, over1: -1, total: 0, at: null, frame: 'none' };
    const dpr = window.devicePixelRatio || 1;
    const M = hp.refMargin ?? 0;
    const ref = document.createElement('canvas');
    ref.width = cv.width + 2 * M;
    ref.height = cv.height + 2 * M;
    const ctx = ref.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, M, M);
    const bg = getComputedStyle(cv).getPropertyValue('--viewer-bg').trim() || '#e9e5de';
    renderMosaic(ctx, p.layout, p.data, p.palette, v, {
      groutHex: p.groutHex,
      realistic: p.realistic,
      surface: p.surface,
      showCodes: p.showCodes,
      progressMode: p.progressMode,
      sections: p.sections,
      selectedSection: p.selectedSection,
      highlight: p.highlight,
      focusColor: p.focusColor,
      background: bg,
      rulers: !!p.rulers,
      focusRange: p.focusRange ?? null,
    });
    const a = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
    const b = ctx.getImageData(M, M, cv.width, cv.height).data;
    let max = 0;
    let over1 = 0;
    let at: [number, number] | null = null;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > 1) over1++;
      if (d > max) {
        max = d;
        const px = i >> 2;
        at = [px % cv.width, Math.floor(px / cv.width)];
      }
    }
    const res = { max, over1, total: a.length, at, frame: cv.dataset.frame ?? '' };
    if (!dump) return res;
    // Bilder zur Fehlersuche: Viewer, frisches Bild, Abweichungen > 1 rot
    const diff = document.createElement('canvas');
    diff.width = cv.width;
    diff.height = cv.height;
    const dctx = diff.getContext('2d')!;
    const img = dctx.createImageData(cv.width, cv.height);
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
      const g = (a[i] + a[i + 1] + a[i + 2]) / 3;
      img.data[i] = d > 1 ? 255 : g * 0.5 + 100;
      img.data[i + 1] = d > 1 ? 0 : g * 0.5 + 100;
      img.data[i + 2] = d > 1 ? 0 : g * 0.5 + 100;
      img.data[i + 3] = 255;
    }
    dctx.putImageData(img, 0, 0);
    return { ...res, images: { viewer: cv.toDataURL(), fresh: ref.toDataURL(), diff: diff.toDataURL() } };
  },
};

const root = document.getElementById('root')!;
createRoot(root).render(
  <I18nContext.Provider value={{ lang: 'de', t: makeT('de'), setLang: () => {}, n: numberFormatter('de') }}>
    <Harness />
  </I18nContext.Provider>,
);
