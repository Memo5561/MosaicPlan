/**
 * Paket w5-undo-editing: Momentaufnahmen von Zellen, Verlauf (Rückgängig/Wiederholen) und „heller/dunkler“.
 */
import { describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import {
  addPaletteColor,
  cellEquals,
  cellMatches,
  restoreCell,
  setCellKind,
  setFreePieces,
  setPieceColor,
  shadeStep,
  snapshotCell,
  SHADE_MAX_DAB,
  SHADE_MAX_DL,
  SHADE_MIN_DL,
} from '../src/core/edits';
import {
  captureCellSide,
  cellsEntryFrom,
  EditJournal,
  mergeRecorded,
  paletteEntryFrom,
  paletteIndexSig,
  progressEntryFrom,
  removeColorRecorded,
  samePaletteContent,
  uniqueCells,
  type RemoveStep,
} from '../src/core/journal';
import { captureCells as captureProgressCells, captureRange } from '../src/core/laying';
import { computeLayout, type LayoutParams } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { applyMaterialMerge, piecesPerColor, planMaterialMerge } from '../src/core/paletteOps';
import { packMosaic, unpackMosaic, type StoredMosaic } from '../src/core/serialize';
import { computeStats } from '../src/core/stats';
import { CellKind, createEmptyMosaic, type Material, type MosaicData, type PaletteColor } from '../src/core/types';
import { baseParams, sampleSetup } from './w1-mosaic-core.fixtures';

const LP: LayoutParams = { widthMm: 66, heightMm: 44, tileW: 10, tileH: 10, joint: 1, edgeMode: 'whole', minCutMm: 2 };
const MIN = 1.5;

function palette10(): PaletteColor[] {
  let p: PaletteColor[] = [];
  const hexes = ['#FFFFFF', '#000000', '#FF0000', '#00AA00', '#0000FF', '#FFFF00', '#888888', '#9FC5F8', '#6FA8DC', '#3D85C6'];
  for (const h of hexes) p = addPaletteColor(p, h, undefined, 'de');
  return p;
}

function grid(): { layout: ReturnType<typeof computeLayout>; data: MosaicData } {
  const layout = computeLayout(LP);
  const data = createEmptyMosaic(layout.cols, layout.rows);
  for (let i = 0; i < data.c1.length; i++) data.c1[i] = i % 10;
  return { layout, data };
}

const stats = (layout: ReturnType<typeof computeLayout>, data: MosaicData, pal: PaletteColor[]) => JSON.stringify(computeStats(layout, data, pal, [], { reservePct: 10, groutDepthMm: 3 }));
const sig = (pal: readonly PaletteColor[]) => paletteIndexSig(pal);

/** Gespeichertes Raster in fester Reihenfolge (Map-Reihenfolge spielt für den Inhalt keine Rolle) */
function canonical(m: StoredMosaic) {
  const d = unpackMosaic(m);
  const sortMap = <T>(mp: Map<number, T>) => [...mp.entries()].sort((a, b) => a[0] - b[0]);
  return JSON.stringify({
    kind: [...d.kind],
    c1: [...d.c1],
    c2: [...d.c2],
    progress: [...d.progress],
    sub: sortMap(d.sub).map(([k, v]) => [k, [...v]]),
    line: sortMap(d.line).map(([k, v]) => [k, [...v]]),
    free: sortMap(d.free),
  });
}

/** Alle Bytes des gepackten Rasters (Reihenfolge inklusive) */
function packBytes(d: MosaicData): string {
  const m = packMosaic(d);
  const parts: string[] = [];
  for (const k of ['kind', 'c1', 'c2', 'subIdx', 'subLen', 'subCol', 'lineIdx', 'lineVal', 'progress', 'rec'] as const) {
    const a = m[k] as ArrayBufferView;
    parts.push(Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64'));
  }
  parts.push(JSON.stringify(m.free));
  return parts.join('|');
}

describe('Momentaufnahme einer Zelle (snapshotCell / restoreCell / cellEquals)', () => {
  it('Rundreise für jede Zellart, inklusive Löschen fehlender Zusatzlisten', () => {
    const { layout, data } = grid();
    const kinds: [string, () => void][] = [
      ['FULL', () => setCellKind(layout, data, 0, 0, { kind: CellKind.FULL }, MIN)],
      ['DIAG_A', () => setCellKind(layout, data, 0, 0, { kind: CellKind.DIAG_A }, MIN)],
      ['DIAG_B', () => setCellKind(layout, data, 0, 0, { kind: CellKind.DIAG_B }, MIN)],
      ['LINE', () => setCellKind(layout, data, 0, 0, { kind: CellKind.LINE, angleDeg: 45, offsetMm: 1 }, MIN)],
      ['SUB2', () => setCellKind(layout, data, 0, 0, { kind: CellKind.SUB, k: 2 }, MIN)],
      ['SUB3', () => setCellKind(layout, data, 0, 0, { kind: CellKind.SUB, k: 3 }, MIN)],
      [
        'FREE',
        () =>
          setFreePieces(
            layout,
            data,
            0,
            0,
            [
              { poly: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], color: 4 },
              { poly: [{ x: 10, y: 1 }, { x: 10, y: 10 }, { x: 1, y: 10 }], color: 5 },
            ],
            MIN,
          ),
      ],
    ];
    for (const [name, make] of kinds) {
      expect(make() === null || (typeof make === 'function' && true), name).toBe(true);
      data.progress[0] = 0b1;
      const snap = snapshotCell(data, 0);
      expect(cellMatches(data, 0, snap), name).toBe(true);
      // Momentaufnahme ist unabhängig vom Raster
      const before = JSON.stringify({ ...snap, sub: snap.sub && [...snap.sub], line: snap.line && [...snap.line] });
      data.sub.get(0)?.fill(9);
      data.line.get(0)?.fill(0);
      const f = data.free.get(0);
      if (f) f[0].poly[0].x = 0.5;
      expect(JSON.stringify({ ...snap, sub: snap.sub && [...snap.sub], line: snap.line && [...snap.line] }), name).toBe(before);
      // auf eine ganz andere Zellart zurückschreiben
      setCellKind(layout, data, 0, 0, { kind: name === 'FULL' ? CellKind.SUB : CellKind.FULL, k: 2 }, MIN);
      restoreCell(data, 0, snap);
      expect(cellEquals(snapshotCell(data, 0), snap), name).toBe(true);
      expect(data.sub.has(0), name).toBe(!!snap.sub);
      expect(data.line.has(0), name).toBe(!!snap.line);
      expect(data.free.has(0), name).toBe(!!snap.free);
      // mehrfach anwendbar: Raster ändern, erneut zurückschreiben
      data.sub.get(0)?.fill(1);
      restoreCell(data, 0, snap);
      expect(cellMatches(data, 0, snap), name).toBe(true);
    }
  });

  it('cellEquals unterscheidet jedes Feld', () => {
    const { layout, data } = grid();
    setCellKind(layout, data, 0, 0, { kind: CellKind.SUB, k: 2 }, MIN);
    const a = snapshotCell(data, 0);
    const variants = [
      { ...a, kind: CellKind.FULL },
      { ...a, c1: a.c1 + 1 },
      { ...a, c2: a.c2 + 1 },
      { ...a, progress: 1 },
      { ...a, sub: Uint16Array.of(1, 2, 3, 4) },
      { ...a, sub: undefined },
      { ...a, line: Float32Array.of(1, 0, 0) },
      { ...a, free: [{ poly: [{ x: 0, y: 0 }], color: 1 }] },
    ];
    for (const v of variants) expect(cellEquals(a, v)).toBe(false);
    expect(cellEquals(a, snapshotCell(data, 0))).toBe(true);
  });
});

describe('Rückgängig/Wiederholen für Zellen', () => {
  it('SUB [3,5,7,9] mit Verlegestatus 101 → ganzer Stein → Rückgängig: exakt wie vorher, Statistik gleich', () => {
    const { layout, data } = grid();
    const pal = palette10();
    const idx = 1 * layout.cols + 2;
    expect(setCellKind(layout, data, 1, 2, { kind: CellKind.SUB, k: 2 }, MIN)).toBeNull();
    [3, 5, 7, 9].forEach((c, q) => setPieceColor(data, idx, q, c));
    data.progress[idx] = 0b101;
    const orig = snapshotCell(data, idx);
    const statsBefore = stats(layout, data, pal);
    const packBefore = canonical(packMosaic(data));
    const j = new EditJournal();
    const ids = uniqueCells([idx]);
    const before = captureCellSide(data, ids);
    expect(setCellKind(layout, data, 1, 2, { kind: CellKind.FULL }, MIN)).toBeNull();
    expect(data.progress[idx]).toBe(0);
    const e = cellsEntryFrom(data, ids, before, { label: { text: 'Form' }, sig: sig(pal) });
    expect(e).not.toBeNull();
    expect(e!.mosaicChanged && e!.progressChanged).toBe(true);
    expect(j.push(e!)).toBe('pushed');
    const statsEdited = stats(layout, data, pal);
    expect(statsEdited).not.toBe(statsBefore);
    const r = j.undo({ data, palette: pal });
    expect(r.status).toBe('ok');
    expect(cellMatches(data, idx, orig)).toBe(true);
    expect([...data.sub.get(idx)!]).toEqual([3, 5, 7, 9]);
    expect(data.progress[idx]).toBe(0b101);
    expect(stats(layout, data, pal)).toBe(statsBefore);
    expect(canonical(packMosaic(data))).toBe(packBefore);
    // Wiederholen → wieder ganzer Stein, gleiche Statistik wie nach der Änderung
    expect(j.redo({ data, palette: pal }).status).toBe('ok');
    expect(data.kind[idx]).toBe(CellKind.FULL);
    expect(stats(layout, data, pal)).toBe(statsEdited);
    expect(j.undoSize).toBe(1);
    expect(j.redoSize).toBe(0);
  });

  it('keine Änderung → kein Eintrag; erneutes „Ganzer Stein“ auf ganzem Stein ändert nichts', () => {
    const { layout, data } = grid();
    const ids = uniqueCells([5]);
    const before = captureCellSide(data, ids);
    setCellKind(layout, data, 0, 5, { kind: CellKind.FULL }, MIN);
    expect(cellsEntryFrom(data, ids, before, { label: {}, sig: '' })).toBeNull();
  });

  it('nie einen alten Stand über eine neuere Änderung schreiben (Eintrag wird verworfen)', () => {
    const { data } = grid();
    const pal = palette10();
    const j = new EditJournal();
    const ids = uniqueCells([3]);
    const before = captureCellSide(data, ids);
    setPieceColor(data, 3, 0, 2);
    j.push(cellsEntryFrom(data, ids, before, { label: {}, sig: sig(pal) })!);
    // ohne Verlauf geändert (z. B. „verlegt“ markiert)
    data.progress[3] = 1;
    const snapNow = snapshotCell(data, 3);
    const r = j.undo({ data, palette: pal });
    expect(r.status).toBe('stale');
    expect(cellMatches(data, 3, snapNow)).toBe(true);
    expect(j.undoSize + j.redoSize).toBe(0);
  });

  it('nach einem unverfolgten Entfernen einer Palettenfarbe gelten alte Zelleinträge nicht mehr', () => {
    const { data } = grid();
    const pal = palette10();
    const j = new EditJournal();
    const ids = uniqueCells([3]);
    const before = captureCellSide(data, ids);
    setPieceColor(data, 3, 0, 1);
    j.push(cellsEntryFrom(data, ids, before, { label: {}, sig: sig(pal) })!);
    const shorter = pal.filter((_, i) => i !== 7);
    expect(j.undo({ data, palette: shorter }).status).toBe('stale');
  });

  it('Mehrzellen-Eintrag ist struct-of-arrays und enthält nur geänderte Zellen', () => {
    const { data } = grid();
    const ids = uniqueCells([0, 1, 2, 3, 4, 5]);
    const before = captureCellSide(data, ids);
    setPieceColor(data, 1, 0, 9);
    setPieceColor(data, 4, 0, 9);
    const e = cellsEntryFrom(data, ids, before, { label: {}, sig: 'x' })!;
    expect([...e.idx]).toEqual([1, 4]);
    expect(e.before.c1).toBeInstanceOf(Uint16Array);
    expect([...e.before.c1]).toEqual([1, 4]);
    expect([...e.after.c1]).toEqual([9, 9]);
    expect(e.progressChanged).toBe(false);
  });
});

describe('Rückgängig/Wiederholen für den Verlegestatus', () => {
  it('Zellen und Bereich: exakt zurück und wieder vor; neuere Markierung wird nie überschrieben', () => {
    const { layout, data } = grid();
    const pal = palette10();
    const j = new EditJournal();
    const s1 = captureProgressCells(data, [7]);
    data.progress[7] = 1;
    j.push(progressEntryFrom(data, layout.cols, s1, { label: { text: 'A' }, sig: sig(pal) })!);
    const rg = { r0: 0, r1: 2, c0: 0, c1: 3 };
    const s2 = captureRange(layout, data, rg);
    for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) data.progress[r * layout.cols + c] = 1;
    const e2 = progressEntryFrom(data, layout.cols, s2, { label: { text: 'B' }, sig: sig(pal) })!;
    expect(e2.range).toEqual(rg);
    j.push(e2);
    const all = [...data.progress];
    expect(j.undo({ data, palette: pal }).status).toBe('ok');
    expect(data.progress[0]).toBe(0);
    expect(data.progress[7]).toBe(1);
    expect(j.undo({ data, palette: pal }).status).toBe('ok');
    expect(data.progress.every((v) => v === 0)).toBe(true);
    expect(j.redo({ data, palette: pal }).status).toBe('ok');
    expect(j.redo({ data, palette: pal }).status).toBe('ok');
    expect([...data.progress]).toEqual(all);
    // neuere, nicht verfolgte Markierung im Bereich → Rückgängig wird verworfen
    data.progress[layout.cols] = 0;
    expect(j.undo({ data, palette: pal }).status).toBe('stale');
    expect(data.progress[0]).toBe(1);
    // unveränderter Verlegestatus → kein Eintrag
    expect(progressEntryFrom(data, layout.cols, captureProgressCells(data, [1, 2]), { label: {}, sig: '' })).toBeNull();
  });
});

describe('Palette: Entfernen mit kompakter Umkehrung', () => {
  it('Porträt: häufigste Farbe entfernen und zurücknehmen ergibt packMosaic Byte für Byte', () => {
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su));
    const data = res.data;
    const pal = res.palette;
    // einige Unterteilungs-/Freiformzellen sicherstellen (auch deren Farbstellen werden zurückgeschrieben)
    const counts = piecesPerColor(data, pal.length);
    const most = counts.indexOf(Math.max(...counts));
    const freeCell = [...Array(data.kind.length).keys()].find((i) => data.kind[i] === CellKind.FULL && data.c1[i] === most)!;
    const row = Math.floor(freeCell / su.layout.cols);
    const col = freeCell % su.layout.cols;
    const cw = su.layout.colW[col];
    const ch = su.layout.rowH[row];
    expect(
      setFreePieces(
        su.layout,
        data,
        row,
        col,
        [
          { poly: [{ x: 0, y: 0 }, { x: cw, y: 0 }, { x: 0, y: ch }], color: most },
          { poly: [{ x: cw, y: 1.5 }, { x: cw, y: ch }, { x: 1.5, y: ch }], color: (most + 1) % pal.length },
        ],
        0,
      ).ok,
    ).toBe(true);
    data.progress[freeCell] = 0b11;
    const bytesBefore = packBytes(data);
    const statsBefore = stats(su.layout, data, pal);
    const j = new EditJournal();
    const steps: RemoveStep[] = [];
    const next = removeColorRecorded(pal, data, most, undefined, '2000', steps);
    expect(next.length).toBe(pal.length - 1);
    const e = paletteEntryFrom(pal, next, steps, { label: { text: 'entfernt' } });
    // Speicher wächst mit den Steinen dieser einen Farbe (≤ 8 Byte je Stelle)
    const slots = steps[0].c1.length + steps[0].c2.length + steps[0].sub.length / 2 + steps[0].free.length / 2;
    expect(slots).toBeGreaterThanOrEqual(counts[most]);
    expect(e.bytes - (pal.length + next.length) * 256 - 128 - 64).toBeLessThanOrEqual(8 * slots);
    j.push(e);
    const bytesAfter = packBytes(data);
    expect(bytesAfter).not.toBe(bytesBefore);
    const u = j.undo({ data, palette: next });
    expect(u.status).toBe('ok');
    if (u.status !== 'ok') return;
    expect(u.palette).toBe(pal);
    expect(packBytes(data)).toBe(bytesBefore);
    expect(stats(su.layout, data, pal)).toBe(statsBefore);
    // Wiederholen ergibt genau den Stand nach dem Entfernen
    const r = j.redo({ data, palette: pal });
    expect(r.status).toBe('ok');
    expect(packBytes(data)).toBe(bytesAfter);
    // Palette inzwischen anders (Farbe umbenannt durch den Benutzer) → nicht anwenden
    const renamed = next.map((p, i) => (i === 0 ? { ...p, name: 'Mein Weiß', userNamed: true } : p));
    expect(j.undo({ data, palette: renamed }).status).toBe('stale');
    expect(packBytes(data)).toBe(bytesAfter);
  });

  it('Stelle inzwischen anders gefärbt → Entfernen wird nicht zurückgenommen (und nichts halb)', () => {
    const { data } = grid();
    const pal = palette10();
    const j = new EditJournal();
    const steps: RemoveStep[] = [];
    const next = removeColorRecorded(pal, data, 4, 5, '2000', steps);
    j.push(paletteEntryFrom(pal, next, steps, { label: {} }));
    const changedCell = steps[0].c1[0];
    data.c1[changedCell] = 0;
    const snap = packBytes(data);
    expect(j.undo({ data, palette: next }).status).toBe('stale');
    expect(packBytes(data)).toBe(snap);
  });

  it('„Palette aus Materialien“ mit Umkehrung: gleiches Ergebnis wie applyMaterialMerge, Rückgängig exakt', () => {
    const su = sampleSetup('animal');
    const res = computeMosaic(su.img, baseParams(su, { colorCount: 12 }));
    const pal = res.palette;
    // Materialien: die Hälfte der Palettenfarben + zwei neue → die übrigen Farben werden entfernt
    const mats: Material[] = pal.slice(0, 6).map((p, i) => ({ id: `m${i}`, hex: p.hex, colorName: `Mat ${i}` }) as unknown as Material);
    mats.push({ id: 'mx', hex: '#123456', colorName: 'Neu 1' } as unknown as Material, { id: 'my', hex: '#E0C0A0', colorName: 'Neu 2' } as unknown as Material);
    const plan = planMaterialMerge(pal, res.data, mats, '2000', 'de');
    expect(plan.removeIdx.length).toBeGreaterThan(1);
    const ref = unpackMosaic(packMosaic(res.data));
    const expected = applyMaterialMerge(plan, ref, '2000');
    const data = res.data;
    const before = packBytes(data);
    const steps: RemoveStep[] = [];
    const got = mergeRecorded(plan, data, '2000', steps);
    expect(samePaletteContent(got, expected)).toBe(true);
    expect(packBytes(data)).toBe(packBytes(ref));
    const j = new EditJournal();
    j.push(paletteEntryFrom(pal, got, steps, { label: {} }));
    expect(j.undo({ data, palette: got }).status).toBe('ok');
    expect(packBytes(data)).toBe(before);
  });

  it('Palettenänderungen ohne Raster: Zusammenfassen kurz hintereinander, Aufheben → kein Eintrag', () => {
    const pal = palette10();
    const j = new EditJournal();
    const a = pal.map((p, i) => (i === 2 ? { ...p, hex: '#EE0000' } : p));
    const b = a.map((p, i) => (i === 2 ? { ...p, hex: '#DD0000' } : p));
    expect(j.push(paletteEntryFrom(pal, a, [], { label: {}, coalesce: 'hex:2', at: 1000 }))).toBe('pushed');
    expect(j.push(paletteEntryFrom(a, b, [], { label: {}, coalesce: 'hex:2', at: 1500 }))).toBe('coalesced');
    expect(j.undoSize).toBe(1);
    const u = j.undo({ data: null, palette: b });
    expect(u.status === 'ok' && u.palette).toBe(pal);
    expect(j.redo({ data: null, palette: pal }).status).toBe('ok');
    // zurück auf den Ausgangswert innerhalb der Zeit → Eintrag verschwindet
    const j2 = new EditJournal();
    j2.push(paletteEntryFrom(pal, a, [], { label: {}, coalesce: 'hex:2', at: 1000 }));
    expect(j2.push(paletteEntryFrom(a, pal, [], { label: {}, coalesce: 'hex:2', at: 1200 }))).toBe('noop');
    expect(j2.undoSize).toBe(0);
    // nach der Zeitspanne: eigener Eintrag
    const j3 = new EditJournal();
    j3.push(paletteEntryFrom(pal, a, [], { label: {}, coalesce: 'hex:2', at: 1000 }));
    expect(j3.push(paletteEntryFrom(a, b, [], { label: {}, coalesce: 'hex:2', at: 5000 }))).toBe('pushed');
    expect(j3.undoSize).toBe(2);
  });

  it('automatische Namen in anderer Sprache machen einen Paletteneintrag nicht ungültig', () => {
    const pal = palette10();
    const next = addPaletteColor(pal, '#123456', undefined, 'de');
    const j = new EditJournal();
    j.push(paletteEntryFrom(pal, next, [], { label: {} }));
    const english = next.map((p) => ({ ...p, name: `${p.name} (en)` }));
    expect(j.undo({ data: null, palette: english }).status).toBe('ok');
  });
});

describe('Grenzen des Verlaufs', () => {
  it('höchstens N Einträge und höchstens die Byte-Grenze; die ältesten fallen heraus', () => {
    const { layout, data } = grid();
    const j = new EditJournal(200, 4000);
    for (let i = 0; i < 300; i++) {
      const cell = i % data.progress.length;
      const s = captureProgressCells(data, [cell]);
      data.progress[cell] ^= 1;
      expect(j.push(progressEntryFrom(data, layout.cols, s, { label: {}, sig: sig([]) })!)).toBe('pushed');
      expect(j.bytes).toBeLessThanOrEqual(4000);
    }
    expect(j.undoSize).toBeGreaterThan(0);
    expect(j.undoSize).toBeLessThan(200);
    const big = new EditJournal(200, 32 * 1024 * 1024);
    for (let i = 0; i < 260; i++) {
      const s = captureProgressCells(data, [0]);
      data.progress[0] ^= 1;
      big.push(progressEntryFrom(data, layout.cols, s, { label: {}, sig: sig([]) })!);
    }
    expect(big.undoSize).toBe(200);
    // die neuesten 200 bleiben anwendbar
    let ok = 0;
    while (big.undo({ data, palette: [] }).status === 'ok') ok++;
    expect(ok).toBe(200);
  });

  it('ein Eintrag über der Byte-Grenze wird nicht gespeichert, der Verlauf geleert', () => {
    const { layout, data } = grid();
    const j = new EditJournal(200, 130);
    const s = captureProgressCells(data, [0]);
    data.progress[0] = 1;
    j.push(progressEntryFrom(data, layout.cols, s, { label: {}, sig: sig([]) })!);
    const rg = { r0: 0, r1: layout.rows, c0: 0, c1: layout.cols };
    const s2 = captureRange(layout, data, rg);
    data.progress.fill(1);
    const e = progressEntryFrom(data, layout.cols, s2, { label: {}, sig: sig([]) })!;
    expect(e.bytes).toBeGreaterThan(130);
    expect(j.push(e)).toBe('too-large');
    expect(j.undoSize + j.redoSize).toBe(0);
    expect(j.bytes).toBe(0);
  });

  it('neuer Eintrag leert Wiederholen', () => {
    const { layout, data } = grid();
    const j = new EditJournal();
    for (const cell of [0, 1]) {
      const s = captureProgressCells(data, [cell]);
      data.progress[cell] = 1;
      j.push(progressEntryFrom(data, layout.cols, s, { label: {}, sig: sig([]) })!);
    }
    j.undo({ data, palette: [] });
    expect(j.redoSize).toBe(1);
    const s = captureProgressCells(data, [5]);
    data.progress[5] = 1;
    j.push(progressEntryFrom(data, layout.cols, s, { label: {}, sig: sig([]) })!);
    expect(j.redoSize).toBe(0);
    expect(j.redo({ data, palette: [] }).status).toBe('empty');
  });
});

describe('Heller / Dunkler (nur vorhandene Palettenfarben gleichen Farbtons)', () => {
  const blues = (): PaletteColor[] => {
    let p: PaletteColor[] = [];
    for (const h of ['#CFE2F3', '#9FC5F8', '#6FA8DC', '#3D85C6', '#0B5394', '#F4CCCC', '#FFFFFF', '#000000', '#B7B7B7']) p = addPaletteColor(p, h, undefined, 'de');
    return p;
  };
  it('nächster Schritt in derselben Farbe', () => {
    const p = blues();
    const mid = p.findIndex((x) => x.hex === '#6FA8DC');
    const up = shadeStep(p, mid, 'lighter');
    const down = shadeStep(p, mid, 'darker');
    expect(p[up!.index].hex).toBe('#9FC5F8');
    expect(p[down!.index].hex).toBe('#3D85C6');
    expect(up!.dL).toBeGreaterThanOrEqual(SHADE_MIN_DL);
    expect(down!.dL).toBeLessThanOrEqual(-SHADE_MIN_DL);
    expect(up!.dab).toBeLessThanOrEqual(SHADE_MAX_DAB);
  });
  it('keine passende Farbe → null (nie erfunden); Weiß/Schwarz zählen nicht als „helleres Blau“', () => {
    const p = blues();
    const lightest = p.findIndex((x) => x.hex === '#CFE2F3');
    expect(shadeStep(p, lightest, 'lighter')).toBeNull();
    const darkest = p.findIndex((x) => x.hex === '#0B5394');
    expect(shadeStep(p, darkest, 'darker')).toBeNull();
    // Grau: Weiß ist neutral, aber mehr als 20 L* heller → kein Vorschlag; mit einem hellen Grau dazwischen dieses
    const grey = p.findIndex((x) => x.hex === '#B7B7B7');
    expect(shadeStep(p, grey, 'lighter')).toBeNull();
    const p2 = addPaletteColor(p, '#D0D0D0', undefined, 'de');
    const g = shadeStep(p2, grey, 'lighter');
    expect(g && p2[g.index].hex).toBe('#D0D0D0');
    const lab = hexToLab('#F4CCCC');
    expect(lab[1]).toBeGreaterThan(5);
  });
  it('kein Sprung über mehr als 20 L* (Hellbeige → Dunkelgrau ist kein „dunkler“)', () => {
    let p: PaletteColor[] = [];
    for (const h of ['#EED7C7', '#68615D', '#FFFFFF']) p = addPaletteColor(p, h, undefined, 'de');
    expect(shadeStep(p, 0, 'darker')).toBeNull();
    const withStep = addPaletteColor(p, '#D2BCAD', undefined, 'de');
    const d = shadeStep(withStep, 0, 'darker')!;
    expect(withStep[d.index].hex).toBe('#D2BCAD');
    expect(Math.abs(d.dL)).toBeLessThanOrEqual(SHADE_MAX_DL);
  });
});
