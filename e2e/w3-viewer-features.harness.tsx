/**
 * Prüfstand für e2e/w3-viewer-features.e2e.cjs: rendert den echten Viewer (src/ui/project/Viewer.tsx) mit einem
 * kleinen synthetischen Mosaik, damit Malen, Rechteck, langes Drücken, Bereichsfokus, Hervorhebung und Vergleich
 * im Browser geprüft werden können, bevor Schritt 9 (Welle 4) sie verwendet. Wird vom e2e-Skript mit esbuild
 * gebündelt; nicht Teil der App.
 */
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/ui/styles.css';
import { hexToLab } from '../src/core/color';
import { setCellKind } from '../src/core/edits';
import { computeLayout, computeSections } from '../src/core/layout';
import { CellKind, createEmptyMosaic, type PaletteColor } from '../src/core/types';
import { I18nContext, makeT, numberFormatter } from '../src/i18n';
import { Viewer, type ViewerHandle, type ViewerProps } from '../src/ui/project/Viewer';

const layout = computeLayout({ widthMm: 120, heightMm: 90, tileW: 10, tileH: 10, joint: 2, edgeMode: 'whole', minCutMm: 2 });
const data = createEmptyMosaic(layout.cols, layout.rows);
const hexes = ['#F2EEE6', '#C0262D', '#3A6EA5', '#2E7D32', '#E8B04A', '#1D1F1B'];
const palette: PaletteColor[] = hexes.map((hex, i) => ({ code: i + 1, name: `F${i + 1}`, hex, lab: hexToLab(hex) }));
for (let i = 0; i < data.c1.length; i++) data.c1[i] = (i * 7 + Math.floor(i / layout.cols)) % hexes.length;
// eine 2×2-Zelle und eine Diagonalzelle in der letzten Zeile
setCellKind(layout, data, layout.rows - 1, 2, { kind: CellKind.SUB, k: 2 }, 1);
setCellKind(layout, data, layout.rows - 1, 5, { kind: CellKind.DIAG_A }, 1);
const sections = computeSections(layout, 60, 48);

type Call = [string, ...unknown[]];
const calls: Call[] = [];

declare global {
  interface Window {
    __h: {
      calls: Call[];
      layout: { cols: number; rows: number; colX: number[]; colW: number[]; rowY: number[]; rowH: number[]; joint: number; finishedW: number; finishedH: number };
      progress: () => number[];
      setProps: (p: Partial<ViewerProps>) => void;
      viewer: () => ViewerHandle | null;
      sections: { id: string; r0: number; r1: number; c0: number; c1: number }[];
    };
  }
}

function Harness() {
  const [extra, setExtra] = useState<Partial<ViewerProps>>({});
  const [pv, setPv] = useState(0);
  const ref = useRef<ViewerHandle>(null);
  window.__h.setProps = (p) => setExtra((prev) => ({ ...prev, ...p }));
  window.__h.viewer = () => ref.current;
  return (
    <div style={{ width: 800, padding: 0 }}>
      <Viewer
        ref={ref}
        layout={layout}
        data={data}
        palette={palette}
        version={0}
        progressVersion={pv}
        groutHex="#BDB8AE"
        surface="glass"
        realistic={false}
        showCodes
        progressMode
        sections={sections}
        height={600}
        rulers
        onPick={(row, col, piece) => calls.push(['pick', row, col, piece])}
        onLongPick={(row, col, piece) => calls.push(['long', row, col, piece])}
        onOutsideTap={(info) => calls.push(['outside', info])}
        onPaint={(pieces, set) => {
          calls.push(['paint', pieces, set]);
          // wie ein Verbraucher in Schritt 9: Bits setzen, dann neu zeichnen lassen
          for (const p of pieces) {
            if (set) data.progress[p.idx] |= 1 << p.piece;
            else data.progress[p.idx] &= ~(1 << p.piece);
          }
          setPv((v) => v + 1);
        }}
        onRect={(rg) => calls.push(['rect', rg])}
        {...extra}
      />
    </div>
  );
}

window.__h = {
  calls,
  layout: {
    cols: layout.cols,
    rows: layout.rows,
    colX: Array.from(layout.colX),
    colW: Array.from(layout.colW),
    rowY: Array.from(layout.rowY),
    rowH: Array.from(layout.rowH),
    joint: layout.joint,
    finishedW: layout.finishedW,
    finishedH: layout.finishedH,
  },
  progress: () => Array.from(data.progress),
  setProps: () => {},
  viewer: () => null,
  sections: sections.sections.map((s) => ({ id: s.id, r0: s.r0, r1: s.r1, c0: s.c0, c1: s.c1 })),
};

const root = document.getElementById('root')!;
createRoot(root).render(
  <I18nContext.Provider value={{ lang: 'de', t: makeT('de'), setLang: () => {}, n: numberFormatter('de') }}>
    <Harness />
  </I18nContext.Provider>,
);
