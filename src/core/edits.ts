/**
 * Manuelle Änderungen am Mosaik (einzelne Steine, Formen, Palette, Fortschritt).
 */
import { hexToLab, describeColor, NearestColorMatcher, type ColorNameLang } from './color';
import { area, cleanPoly, isSimple, polygonsOverlap, type Pt } from './geometry';
import type { Layout } from './layout';
import type { Range } from './stats';
import { cellPieceCount, cellPieces, cellRect, lineSplit, pieceCuttable } from './pieces';
import { CellKind, type CellKindValue, type FreePiece, type MosaicData, type PaletteColor } from './types';

export function setPieceColor(data: MosaicData, idx: number, piece: number, color: number): void {
  const kind = data.kind[idx];
  if (kind === CellKind.FULL) data.c1[idx] = color;
  else if (kind === CellKind.SUB) {
    const s = data.sub.get(idx);
    if (s && piece < s.length) s[piece] = color;
    if (piece === 0) data.c1[idx] = color;
  } else if (kind === CellKind.FREE) {
    const f = data.free.get(idx);
    if (f && f[piece]) f[piece].color = color;
  } else if (piece === 0) data.c1[idx] = color;
  else data.c2[idx] = color;
}

export interface KindChange {
  kind: CellKindValue;
  /** SUB */
  k?: 2 | 3;
  /** LINE: Winkel der Schnittlinien-Normalen in Grad und Abstand zur Zellmitte in mm */
  angleDeg?: number;
  offsetMm?: number;
}

/** Ändert die Zellart; Farben werden sinnvoll übernommen. Liefert Fehlermeldung oder null. */
export function setCellKind(layout: Layout, data: MosaicData, row: number, col: number, ch: KindChange, minPieceMm: number): string | null {
  const idx = row * layout.cols + col;
  const before = cellPieces(layout, data, row, col);
  const colA = before[0]?.color ?? data.c1[idx];
  const colB = before[1]?.color ?? colA;
  const r = cellRect(layout, row, col);
  switch (ch.kind) {
    case CellKind.FULL:
      break;
    case CellKind.DIAG_A:
    case CellKind.DIAG_B:
      break;
    case CellKind.LINE: {
      const a = ((ch.angleDeg ?? 0) * Math.PI) / 180;
      const nx = Math.cos(a);
      const ny = Math.sin(a);
      const d = ch.offsetMm ?? 0;
      const [p, q] = lineSplit(r, nx, ny, d, layout.joint);
      if (p.length < 3 || q.length < 3) return 'line-outside';
      if (!pieceCuttable(p, minPieceMm) || !pieceCuttable(q, minPieceMm)) return 'too-small';
      data.line.set(idx, new Float32Array([nx, ny, d]));
      break;
    }
    case CellKind.SUB: {
      const k = ch.k ?? 2;
      const sw = (r.w - (k - 1) * layout.joint) / k;
      const sh = (r.h - (k - 1) * layout.joint) / k;
      if (Math.min(sw, sh) < minPieceMm) return 'too-small';
      const arr = new Uint16Array(k * k);
      for (let i = 0; i < arr.length; i++) arr[i] = before[i]?.color ?? colA;
      data.sub.set(idx, arr);
      break;
    }
    case CellKind.FREE:
      return 'use-setFreePieces';
  }
  if (ch.kind !== CellKind.LINE) data.line.delete(idx);
  if (ch.kind !== CellKind.SUB) data.sub.delete(idx);
  data.free.delete(idx);
  data.kind[idx] = ch.kind;
  data.c1[idx] = colA;
  data.c2[idx] = colB;
  data.progress[idx] = 0;
  return null;
}

export interface FreeValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateFreePieces(cellW: number, cellH: number, pieces: FreePiece[], minPieceMm: number): FreeValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (pieces.length === 0) errors.push('no-pieces');
  if (pieces.length > 16) errors.push('too-many');
  const polys = pieces.map((p) => cleanPoly(p.poly));
  polys.forEach((p, i) => {
    const n = i + 1;
    if (p.length < 3) {
      errors.push(`piece ${n}: <3`);
      return;
    }
    if (!isSimple(p)) errors.push(`piece ${n}: self-intersecting`);
    if (p.some((q) => q.x < -1e-6 || q.y < -1e-6 || q.x > cellW + 1e-6 || q.y > cellH + 1e-6)) errors.push(`piece ${n}: outside`);
    if (area(p) < 0.25) errors.push(`piece ${n}: area`);
    else if (!pieceCuttable(p, minPieceMm)) warnings.push(`piece ${n}: thin`);
  });
  for (let i = 0; i < polys.length; i++)
    for (let j = i + 1; j < polys.length; j++) if (polys[i].length >= 3 && polys[j].length >= 3 && polygonsOverlap(polys[i], polys[j])) errors.push(`overlap ${i + 1}/${j + 1}`);
  return { ok: errors.length === 0, errors, warnings };
}

export function setFreePieces(layout: Layout, data: MosaicData, row: number, col: number, pieces: FreePiece[], minPieceMm: number): FreeValidation {
  const r = cellRect(layout, row, col);
  const v = validateFreePieces(r.w, r.h, pieces, minPieceMm);
  if (!v.ok) return v;
  const idx = row * layout.cols + col;
  data.kind[idx] = CellKind.FREE;
  data.free.set(
    idx,
    pieces.map((p) => ({ poly: cleanPoly(p.poly).map((q: Pt) => ({ x: q.x, y: q.y })), color: p.color })),
  );
  data.sub.delete(idx);
  data.line.delete(idx);
  data.c1[idx] = pieces[0].color;
  data.progress[idx] = 0;
  return v;
}

// ---------------- Fortschritt
export function togglePiecePlaced(data: MosaicData, idx: number, piece: number): boolean {
  data.progress[idx] ^= 1 << piece;
  return ((data.progress[idx] >> piece) & 1) === 1;
}

export function setCellPlaced(data: MosaicData, idx: number, placed: boolean): void {
  const n = cellPieceCount(data, idx);
  data.progress[idx] = placed ? (1 << n) - 1 : 0;
}

export function setRangePlaced(layout: Layout, data: MosaicData, rg: Range, placed: boolean): void {
  for (let r = rg.r0; r < rg.r1; r++) for (let c = rg.c0; c < rg.c1; c++) setCellPlaced(data, r * layout.cols + c, placed);
}

// ---------------- Palette
export function nextCode(palette: PaletteColor[]): number {
  return palette.reduce((m, p) => Math.max(m, p.code), 0) + 1;
}

export function addPaletteColor(palette: PaletteColor[], hex: string, name?: string, lang: ColorNameLang = 'de', materialId?: string): PaletteColor[] {
  const lab = hexToLab(hex);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return [
    ...palette,
    {
      code: nextCode(palette),
      hex: hex.toUpperCase().startsWith('#') ? hex.toUpperCase() : `#${hex.toUpperCase()}`,
      lab: [r2(lab[0]), r2(lab[1]), r2(lab[2])],
      name: name || describeColor(lab, lang),
      materialId,
    },
  ];
}

function remapAll(data: MosaicData, map: (c: number) => number): void {
  for (let i = 0; i < data.c1.length; i++) {
    data.c1[i] = map(data.c1[i]);
    data.c2[i] = map(data.c2[i]);
  }
  for (const v of data.sub.values()) for (let q = 0; q < v.length; q++) v[q] = map(v[q]);
  for (const v of data.free.values()) for (const f of v) f.color = map(f.color);
}

/**
 * Entfernt eine Palettenfarbe. Alle Steine dieser Farbe erhalten `replacement`
 * oder – wenn nicht angegeben – die nächstgelegene verbleibende Farbe (ΔE).
 */
export function removePaletteColor(palette: PaletteColor[], data: MosaicData, index: number, replacement?: number, formula: '2000' | '76' = '2000'): PaletteColor[] {
  if (palette.length <= 1) throw new Error('Die letzte Farbe kann nicht entfernt werden.');
  let target = replacement;
  if (target === undefined || target === index) {
    const mask = palette.map((_, i) => i !== index);
    const m = new NearestColorMatcher(
      palette.map((p) => p.lab),
      formula,
      mask,
    );
    const l = palette[index].lab;
    target = m.nearestExact(l[0], l[1], l[2]);
  }
  const t = target;
  remapAll(data, (c) => {
    const v = c === index ? t : c;
    return v > index ? v - 1 : v;
  });
  return palette.filter((_, i) => i !== index);
}

export function updatePaletteColor(palette: PaletteColor[], index: number, patch: Partial<Pick<PaletteColor, 'hex' | 'name' | 'materialId'>>): PaletteColor[] {
  return palette.map((p, i) => {
    if (i !== index) return p;
    const next = { ...p, ...patch };
    if (patch.hex) {
      const lab = hexToLab(patch.hex);
      next.hex = patch.hex.toUpperCase();
      next.lab = [Math.round(lab[0] * 100) / 100, Math.round(lab[1] * 100) / 100, Math.round(lab[2] * 100) / 100];
    }
    return next;
  });
}

/** Ersetzt in einem Bereich (oder überall) Farbe a durch b. Gibt die Anzahl geänderter Steine zurück. */
export function replaceColor(layout: Layout, data: MosaicData, from: number, to: number, rg?: Range): number {
  const r = rg ?? { r0: 0, r1: layout.rows, c0: 0, c1: layout.cols };
  let n = 0;
  for (let row = r.r0; row < r.r1; row++)
    for (let col = r.c0; col < r.c1; col++) {
      const idx = row * layout.cols + col;
      const ps = cellPieces(layout, data, row, col);
      ps.forEach((p, i) => {
        if (p.color === from) {
          setPieceColor(data, idx, i, to);
          n++;
        }
      });
    }
  return n;
}

/** Benachbarte Zellen (oben, rechts, unten, links). */
export function neighbors(layout: Layout, row: number, col: number): { dir: 'N' | 'E' | 'S' | 'W'; row: number; col: number }[] {
  const res: { dir: 'N' | 'E' | 'S' | 'W'; row: number; col: number }[] = [];
  if (row > 0) res.push({ dir: 'N', row: row - 1, col });
  if (col < layout.cols - 1) res.push({ dir: 'E', row, col: col + 1 });
  if (row < layout.rows - 1) res.push({ dir: 'S', row: row + 1, col });
  if (col > 0) res.push({ dir: 'W', row, col: col - 1 });
  return res;
}
