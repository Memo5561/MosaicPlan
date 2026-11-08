/**
 * Gemeinsame Testdaten für tests/w1-mosaic-core.test.ts (Golden-Hashes, eigene Palette,
 * „Palette aus Materialien“). Keine Testdatei – wird nur importiert.
 */
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';
import { hexToLab } from '../src/core/color';
import { applyAdjustments, type RGBAImage } from '../src/core/imageOps';
import { computeLayout, type Layout, type LayoutParams } from '../src/core/layout';
import type { ComputeParams, FixedColor } from '../src/core/mosaic';
import { addPaletteColor } from '../src/core/edits';
import { DEFAULT_ADJUST, DEFAULT_SETTINGS, DEFAULT_SHAPES, type Material, type MosaicData, type PaletteColor, type Region } from '../src/core/types';
import { loadPng, prepareFor } from './helpers';

/**
 * Spiegel der Testprojekte aus src/ui/Home.tsx (SAMPLES) mit den Vorgaben aus
 * createProject (Höhe aus dem Seitenverhältnis des Fotos, Randmodus/Mindestschnitt aus DEFAULT_SETTINGS).
 * Bewusst kopiert: Änderungen an den Startseiten-Vorgaben sollen die Golden-Hashes nicht verändern.
 */
export const GOLDEN_SAMPLES: { key: string; file: string; w: number; tile: number; joint: number; colors: number; regions?: Region[] }[] = [
  { key: 'portrait', file: 'public/samples/portrait.png', w: 400, tile: 5, joint: 1, colors: 32, regions: [{ id: 'face', type: 'face', shape: 'ellipse', x: 0.27, y: 0.25, w: 0.46, h: 0.5 }] },
  { key: 'landscape', file: 'public/samples/landscape.png', w: 1200, tile: 8, joint: 1.5, colors: 24 },
  { key: 'animal', file: 'public/samples/animal.png', w: 500, tile: 6, joint: 1, colors: 24 },
  { key: 'city', file: 'public/samples/city.png', w: 2000, tile: 10, joint: 2, colors: 16 },
];

function pngSize(file: string): { w: number; h: number } {
  const png = PNG.sync.read(readFileSync(file));
  return { w: png.width, h: png.height };
}

export interface SampleSetup {
  layout: Layout;
  lp: LayoutParams;
  img: RGBAImage;
  regions: Region[];
  colors: number;
}

const setupCache = new Map<string, SampleSetup>();

/** Layout und vorbereitetes Bild eines Testprojekts (wie in der App: Zuschnitt, Skalierung, Bildanpassung). */
export function sampleSetup(key: string): SampleSetup {
  const hit = setupCache.get(key);
  if (hit) return hit;
  const s = GOLDEN_SAMPLES.find((x) => x.key === key);
  if (!s) throw new Error(`unbekanntes Testprojekt ${key}`);
  const { w, h } = pngSize(s.file);
  const lp: LayoutParams = {
    widthMm: s.w,
    heightMm: Math.round((s.w / (w / h)) * 10) / 10,
    tileW: s.tile,
    tileH: s.tile,
    joint: s.joint,
    edgeMode: DEFAULT_SETTINGS.edgeMode,
    minCutMm: DEFAULT_SETTINGS.minCutMm,
  };
  const layout = computeLayout(lp);
  const regions = s.regions ?? [];
  const img = applyAdjustments(prepareFor(loadPng(s.file), layout), { ...DEFAULT_ADJUST }, regions);
  const res = { layout, lp, img, regions, colors: s.colors };
  setupCache.set(key, res);
  return res;
}

/** Standard-Berechnungsparameter eines Testprojekts (Seed 7, Standardformen, ohne Dithering). */
export function baseParams(su: SampleSetup, patch: Partial<ComputeParams> = {}): ComputeParams {
  return {
    layout: su.layout,
    shapes: { ...DEFAULT_SHAPES },
    paletteMode: 'auto',
    colorCount: su.colors,
    dither: 0,
    deltaE: '2000',
    regions: su.regions,
    seed: 7,
    ...patch,
  };
}

// ---------------------------------------------------------------- Hashes

const bytes = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

function digest(feed: (u: (b: Uint8Array | string) => void) => void): string {
  const h = createHash('sha256');
  feed((b) => h.update(b));
  return h.digest('hex').slice(0, 20);
}

export interface MosaicHashes {
  cells: number;
  kind: string;
  c1: string;
  c2: string;
  rec: string;
  sub: string;
  line: string;
  free: string;
  palette: string;
}

/**
 * Hashes über alle Ergebnisdaten (kind, c1, c2, rec, sub, line, free) und die Palette (Code + HEX, ohne Namen).
 * Rohbytes – damit ist „gleich“ wirklich bitgleich.
 */
export function mosaicHashes(data: MosaicData, palette: PaletteColor[]): MosaicHashes {
  const sortedKeys = <T>(m: Map<number, T>) => [...m.keys()].sort((a, b) => a - b);
  return {
    cells: data.kind.length,
    kind: digest((u) => u(bytes(data.kind))),
    c1: digest((u) => u(bytes(data.c1))),
    c2: digest((u) => u(bytes(data.c2))),
    rec: digest((u) => u(bytes(data.rec))),
    sub: digest((u) => {
      for (const k of sortedKeys(data.sub)) {
        u(`${k}:`);
        u(bytes(data.sub.get(k)!));
        u(';');
      }
    }),
    line: digest((u) => {
      for (const k of sortedKeys(data.line)) {
        u(`${k}:`);
        u(bytes(data.line.get(k)!));
        u(';');
      }
    }),
    free: digest((u) => {
      for (const k of sortedKeys(data.free)) u(`${k}:${JSON.stringify(data.free.get(k))};`);
    }),
    palette: digest((u) => u(JSON.stringify(palette.map((p) => [p.code, p.hex.toUpperCase()])))),
  };
}

// ---------------------------------------------------------------- Paletten / Materialien

/**
 * Eigene Palette mit Lücke in den Nummern (4 fehlt) und einer Farbe, die im Porträt
 * kein Stein braucht (reines Gelb).
 */
export const CUSTOM8: { code: number; hex: string; name: string }[] = [
  { code: 1, hex: '#F4F1EA', name: 'Weiß' },
  { code: 2, hex: '#1E1A18', name: 'Schwarz' },
  { code: 3, hex: '#E8B494', name: 'Haut' },
  { code: 5, hex: '#4E2C1C', name: 'Braun' },
  { code: 6, hex: '#7FA0BA', name: 'Blaugrau' },
  { code: 7, hex: '#A02432', name: 'Rot' },
  { code: 8, hex: '#2E4A62', name: 'Dunkelblau' },
  { code: 9, hex: '#FFFF00', name: 'Gelb' },
];
export const YELLOW = '#FFFF00';

export function customFixed(list: { code?: number; hex: string; name: string; materialId?: string }[]): FixedColor[] {
  return list.map((c) => ({ lab: hexToLab(c.hex), hex: c.hex.toUpperCase(), name: c.name, materialId: c.materialId, code: c.code }) as FixedColor);
}

function mat(id: string, hex: string, colorName: string): Material {
  return { id, type: 'glass', manufacturer: 'Test', product: 'Glas', colorNumber: id.toUpperCase(), colorName, hex, lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 0, packageSize: '', piecesPerPack: 0 };
}

/** 12 Materialien, passend zum Porträt (Hintergrund, Haare, Haut, Pullover, Augen). */
export const MATERIALS12: Material[] = [
  mat('m1', '#F7F4EE', 'Weiß'),
  mat('m2', '#141414', 'Schwarz'),
  mat('m3', '#F0C8A8', 'Haut hell'),
  mat('m4', '#D2946E', 'Haut dunkel'),
  mat('m5', '#5A341F', 'Braun'),
  mat('m6', '#33190F', 'Dunkelbraun'),
  mat('m7', '#9BBDD3', 'Hellblau'),
  mat('m8', '#5F7F99', 'Mittelblau'),
  mat('m9', '#2C4258', 'Dunkelblau'),
  mat('m10', '#A52A36', 'Rot'),
  mat('m11', '#6A1420', 'Dunkelrot'),
  mat('m12', '#2F5A44', 'Grün'),
];

/** Wie useProject die Materialien an computeMosaic übergibt (Modus „materials“/„auto-snap“). */
export function materialFixed(mats: Material[]): FixedColor[] {
  return mats.map((m) => ({ lab: hexToLab(m.hex), hex: m.hex.toUpperCase(), name: m.colorName || `${m.manufacturer} ${m.colorNumber}`.trim(), materialId: m.id }));
}

/** Wie der Knopf „Palette aus Materialien“ ohne Berechnung die Palette aufbaut. */
export function paletteFromMaterials(mats: Material[]): PaletteColor[] {
  let p: PaletteColor[] = [];
  for (const m of mats) p = addPaletteColor(p, m.hex, m.colorName || m.colorNumber, 'de', m.id);
  return p;
}
