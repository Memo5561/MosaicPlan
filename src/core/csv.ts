/**
 * Vollständige Stein-Koordinatenliste als CSV (Semikolon-getrennt, für Excel/LibreOffice).
 */
import { bbox, type Pt } from './geometry';
import { cellId, sectionOfCell, type Layout, type SectionGrid } from './layout';
import { cellPieces } from './pieces';
import { CutCache, makeRawSizeFn, pieceCutInfo } from './stats';
import type { Material, MosaicData, PaletteColor } from './types';

export function buildCsv(
  layout: Layout,
  data: MosaicData,
  palette: PaletteColor[],
  materials: Material[],
  sections: SectionGrid,
  sectionIds: string[] | null,
  decimalComma = true,
): string {
  const raw = makeRawSizeFn(layout, palette, materials);
  const cache = new CutCache();
  const f = (v: number) => {
    const s = (Math.round(v * 100) / 100).toFixed(2);
    return decimalComma ? s.replace('.', ',') : s;
  };
  const polyStr = (p: Pt[]) => p.map((q) => `${f(q.x)} ${f(q.y)}`).join(' | ');
  const out: string[] = [
    'Position;Abschnitt;Zeile;Spalte;Teil;X_mm;Y_mm;Breite_mm;Hoehe_mm;Flaeche_mm2;Farbcode;Farbname;HEX;Form;Zuschnitt;Rohstein_mm;Verlegt;Kontur_mm',
  ];
  const sel = sectionIds ? new Set(sectionIds) : null;
  for (let row = 0; row < layout.rows; row++) {
    for (let col = 0; col < layout.cols; col++) {
      const sec = sectionOfCell(sections, row, col);
      if (sel && !sel.has(sec.id)) continue;
      const ps = cellPieces(layout, data, row, col);
      const idx = row * layout.cols + col;
      ps.forEach((p, i) => {
        const r = raw(p.color);
        const ci = pieceCutInfo(cache, layout, data, row, col, i, p.poly, r);
        const b = bbox(p.poly);
        const pc = palette[p.color];
        out.push(
          [
            cellId(layout, row, col) + (ps.length > 1 ? `-${i + 1}` : ''),
            sec.id,
            row + 1,
            col + 1,
            i + 1,
            f(b.minX),
            f(b.minY),
            f(ci.w),
            f(ci.h),
            f(ci.area),
            String(pc?.code ?? '').padStart(2, '0'),
            `"${(pc?.name ?? '').replace(/"/g, '""')}"`,
            pc?.hex ?? '',
            ci.shape,
            ci.needsCut ? 'ja' : 'nein',
            `${f(r.w)}x${f(r.h)}`,
            (data.progress[idx] >> i) & 1 ? 'ja' : 'nein',
            polyStr(p.poly),
          ].join(';'),
        );
      });
    }
  }
  return out.join('\r\n');
}
