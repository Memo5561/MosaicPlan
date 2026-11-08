/**
 * w2-photo-intake – reine Logik hinter Foto-Laden, Zuschnitt und Foto-Ersetzen:
 *  1. Arbeitskopie großer Fotos: ein Maßstab, Fläche ≤ 16 MP, Seitenverhältnis erhalten.
 *  2. Fehlermeldung nach dem Lesen/Speichern (HEIC / unlesbar / Speicher).
 *  3. Zuschnitt-Geometrie: Ecke ziehen (gegenüberliegende Ecke fest, Seitenverhältnis exakt, Projektion
 *     auf die Diagonale, Bild- und Mindestgrenzen), Verschieben, Zoom-Regler, zwei Finger, Pixelanzeige.
 *  4. Volle Auflösung für die Berechnung nur, wenn die Arbeitskopie im Zuschnitt zu wenig Pixel hat.
 *  5. Eigene Palette mit Nummernlücken: Nummern bleiben über zwei Berechnungen (Eingabeaufbau wie useProject).
 *  6. Neues Projekt für ein anderes Foto: Einstellungen übernommen, nichts vom alten Foto.
 */
import { describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { computeMosaic } from '../src/core/mosaic';
import { DEFAULT_ADJUST, DEFAULT_SETTINGS, type Material, type PaletteColor } from '../src/core/types';
import type { ProjectRecord } from '../src/storage/db';
import {
  aspectDrift,
  cropPixelInfo,
  cropZoomOf,
  defaultCrop,
  MAX_ASPECT_DRIFT,
  MAX_WORKING_PX,
  maxCrop,
  moveCrop,
  needsFullResolution,
  PhotoSaveError,
  photoErrorKey,
  pinchCrop,
  resizeCropFromCorner,
  workingBitmapTarget,
  workingSize,
  zoomCrop,
  type Corner,
  type Crop,
} from '../src/ui/project/imagePrep';
import { buildFixedPalette, computeKey, nameFromFile, projectFromPhoto } from '../src/ui/project/useProject';
import { baseParams, CUSTOM8, sampleSetup } from './w1-mosaic-core.fixtures';

/** deterministischer Zufall */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// ================================================================ 1. Arbeitskopie
describe('Arbeitskopie großer Fotos', () => {
  it('8000 × 6000: ein Maßstab, ≤ 16 MP, Seitenverhältnis innerhalb 0,5 %', () => {
    const t = workingBitmapTarget(8000, 6000)!;
    expect(t).not.toBeNull();
    expect(t.w * t.h).toBeLessThanOrEqual(MAX_WORKING_PX);
    expect(t.w).toBe(4618);
    expect(t.h).toBe(3464);
    expect(aspectDrift(t.w, t.h, 8000, 6000)).toBeLessThan(MAX_ASPECT_DRIFT);
  });
  it('bis 16 MP keine Verkleinerung (12-MP-Handyfoto bleibt unverändert)', () => {
    expect(workingBitmapTarget(4000, 3000)).toBeNull();
    expect(workingBitmapTarget(4000, 4000)).toBeNull();
    expect(workingBitmapTarget(0, 100)).toBeNull();
    expect(workingBitmapTarget(Number.NaN, 100)).toBeNull();
  });
  it('Panorama und Hochformat: Fläche ≤ maxPx, Seitenverhältnis erhalten (Zufallstest)', () => {
    const r = rng(11);
    for (let i = 0; i < 2000; i++) {
      const w = 300 + Math.floor(r() * 30000);
      const h = 300 + Math.floor(r() * 20000);
      const t = workingBitmapTarget(w, h);
      if (w * h <= MAX_WORKING_PX) {
        expect(t).toBeNull();
        continue;
      }
      expect(t).not.toBeNull();
      expect(t!.w * t!.h).toBeLessThanOrEqual(MAX_WORKING_PX);
      expect(t!.w).toBeLessThan(w);
      // gleiche Höhe wie beim Dekodieren mit nur resizeWidth (⌈srcH · w / srcW⌉)
      expect(t!.h).toBe(Math.ceil((h * t!.w) / w));
      if (Math.min(t!.w, t!.h) >= 200) expect(aspectDrift(t!.w, t!.h, w, h)).toBeLessThan(MAX_ASPECT_DRIFT);
    }
  });
  it('aspectDrift: gedrehte Arbeitskopie (Hochformat statt Querformat) wird erkannt', () => {
    expect(aspectDrift(3000, 4000, 4000, 3000)).toBeGreaterThan(0.4);
    expect(aspectDrift(4618, 3464, 8000, 6000)).toBeLessThan(0.0002);
  });
});

// ================================================================ 2. Fehlermeldungen
describe('photoErrorKey', () => {
  const decodeErr = Object.assign(new Error('The source image could not be decoded.'), { name: 'InvalidStateError' });
  it('HEIC nach Typ oder Dateiendung (auch Großschreibung)', () => {
    expect(photoErrorKey({ type: 'image/heic', name: 'a.jpg' }, decodeErr)).toBe('photo.err.heic');
    expect(photoErrorKey({ type: 'image/heif' }, decodeErr)).toBe('photo.err.heic');
    expect(photoErrorKey({ type: '', name: 'IMG_0001.HEIC' }, decodeErr)).toBe('photo.err.heic');
    expect(photoErrorKey({ type: '', name: 'bild.heif' }, decodeErr)).toBe('photo.err.heic');
  });
  it('sonst „nicht lesbar“ – auch bei leerem Typ und InvalidStateError', () => {
    expect(photoErrorKey({ type: 'image/jpeg', name: 'a.jpg' }, decodeErr)).toBe('photo.err.decode');
    expect(photoErrorKey({ type: '', name: '' }, new Error('x'))).toBe('photo.err.decode');
    expect(photoErrorKey({}, undefined)).toBe('photo.err.decode');
  });
  it('Speicherfehler (auch bei HEIC-Namen, denn gelesen wurde das Foto ja)', () => {
    expect(photoErrorKey({ name: 'a.heic' }, new PhotoSaveError(new Error('x')))).toBe('photo.err.save');
    expect(photoErrorKey({ name: 'a.jpg' }, Object.assign(new Error('full'), { name: 'QuotaExceededError' }))).toBe('photo.err.save');
    expect(photoErrorKey({ name: 'a.jpg' }, new Error('Quota exceeded'))).toBe('photo.err.save');
  });
});

// ================================================================ 3. Zuschnitt-Geometrie
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
/** Seitenverhältnis in Bildpixeln */
const cropAspect = (c: Crop, rw: number, rh: number) => (c.w * rw) / (c.h * rh);
const inside = (c: Crop) => c.x >= -1e-12 && c.y >= -1e-12 && c.x + c.w <= 1 + 1e-12 && c.y + c.h <= 1 + 1e-12 && c.w > 0 && c.h > 0;
function cornerPt(c: Crop, k: Corner, rw: number, rh: number) {
  const x = k === 'ne' || k === 'se' ? c.x + c.w : c.x;
  const y = k === 'sw' || k === 'se' ? c.y + c.h : c.y;
  return { x: x * rw, y: y * rh };
}
const OPP: Record<Corner, Corner> = { nw: 'se', se: 'nw', ne: 'sw', sw: 'ne' };

describe('Zuschnitt: Ecke ziehen', () => {
  const rw = 800;
  const rh = 1000;
  const aspect = 0.8;
  const full = defaultCrop(rw, rh, aspect);

  it('unten rechts nach innen: kleiner, oben links fest, Seitenverhältnis exakt', () => {
    const c = resizeCropFromCorner(full, 'se', -200, -200, rw, rh, aspect, 50);
    expect(c.w * rw).toBeLessThan(full.w * rw - 100);
    expect(near(cropAspect(c, rw, rh), aspect)).toBe(true);
    expect(near(c.x, full.x) && near(c.y, full.y)).toBe(true);
  });
  it('oben links nach innen: unten rechts bleibt', () => {
    const c = resizeCropFromCorner(full, 'nw', 200, 200, rw, rh, aspect, 50);
    const a = cornerPt(full, 'se', rw, rh);
    const b = cornerPt(c, 'se', rw, rh);
    expect(near(a.x, b.x, 1e-6) && near(a.y, b.y, 1e-6)).toBe(true);
    expect(c.w).toBeLessThan(full.w);
  });
  it('rein senkrechte Bewegung ändert die Größe (Projektion auf die Diagonale)', () => {
    const start = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
    const c = resizeCropFromCorner(start, 'se', 0, 150, rw, rh, aspect, 50);
    expect(c.w).toBeGreaterThan(start.w);
    // Zug genau entlang der Diagonale um (W, W/a) vergrößert um W
    const d = resizeCropFromCorner(start, 'se', 80, 100, rw, rh, aspect, 50);
    expect(near(d.w * rw, start.w * rw + 80, 1e-6)).toBe(true);
  });
  it('nach außen: auf das Bild begrenzt', () => {
    const start = { x: 0.2, y: 0.3, w: 0.4, h: 0.4 };
    const c = resizeCropFromCorner(start, 'se', 5000, 5000, rw, rh, aspect, 50);
    expect(inside(c)).toBe(true);
    expect(near(c.x, 0.2) && near(c.y, 0.3)).toBe(true);
    expect(near(Math.max(c.x + c.w, c.y + c.h), 1, 1e-9)).toBe(true);
    expect(near(cropAspect(c, rw, rh), aspect)).toBe(true);
  });
  it('Mindestgröße: kürzere Seite ≥ minShort; kleinerer Startrahmen wird nicht aufgeblasen', () => {
    const c = resizeCropFromCorner(full, 'se', -5000, -5000, rw, rh, aspect, 90);
    expect(near(Math.min(c.w * rw, c.h * rh), 90, 1e-6)).toBe(true);
    const small = { x: 0.4, y: 0.4, w: 50 / rw, h: 62.5 / rh };
    const s2 = resizeCropFromCorner(small, 'se', -10, -10, rw, rh, aspect, 90);
    expect(near(s2.w, small.w)).toBe(true);
  });
  it('Zufallstest: alle Ecken, im Bild, Seitenverhältnis exakt, Gegenecke fest', () => {
    const r = rng(5);
    for (let i = 0; i < 3000; i++) {
      const W = 200 + r() * 6000;
      const H = 200 + r() * 6000;
      const a = 0.25 + r() * 4;
      const m = maxCrop(W, H, a);
      const z = 0.2 + r() * 0.8;
      const start = zoomCrop({ x: r() * 0.5, y: r() * 0.5, w: m.w, h: m.h }, W, H, a, z);
      const k = (['nw', 'ne', 'sw', 'se'] as Corner[])[Math.floor(r() * 4)];
      const c = resizeCropFromCorner(start, k, (r() - 0.5) * 2 * W, (r() - 0.5) * 2 * H, W, H, a, Math.min(W, H) * 0.05);
      expect(inside(c)).toBe(true);
      expect(Math.abs(cropAspect(c, W, H) / a - 1)).toBeLessThan(1e-9);
      const p0 = cornerPt(start, OPP[k], W, H);
      const p1 = cornerPt(c, OPP[k], W, H);
      expect(Math.abs(p0.x - p1.x)).toBeLessThan(1e-6 * W);
      expect(Math.abs(p0.y - p1.y)).toBeLessThan(1e-6 * H);
    }
  });
});

describe('Zuschnitt: Verschieben, Regler, zwei Finger, Pixelanzeige', () => {
  const rw = 4000;
  const rh = 3000;
  const aspect = 1;
  it('Verschieben bleibt im Bild, Größe unverändert', () => {
    const c = moveCrop({ x: 0.5, y: 0.5, w: 0.3, h: 0.4 }, 0.9, -0.9);
    expect(c).toEqual({ x: 0.7, y: 0, w: 0.3, h: 0.4 });
  });
  it('Regler: 50 % um die Mitte, exakt im Seitenverhältnis; Rückrechnung cropZoomOf', () => {
    const m = maxCrop(rw, rh, aspect);
    const c = zoomCrop(m, rw, rh, aspect, 0.5);
    expect(near(c.w, m.w / 2) && near(c.h, m.h / 2)).toBe(true);
    expect(near(c.x + c.w / 2, m.x + m.w / 2) && near(c.y + c.h / 2, m.y + m.h / 2)).toBe(true);
    expect(near(cropAspect(c, rw, rh), aspect)).toBe(true);
    expect(near(cropZoomOf(c, rw, rh, aspect), 0.5)).toBe(true);
    // am Rand: Mitte wird so weit nötig verschoben, das Bild nie verlassen
    const edge = zoomCrop({ x: 0, y: 0, w: 0.1, h: 0.1 * (rw / rh) }, rw, rh, aspect, 0.9);
    expect(inside(edge)).toBe(true);
    expect(near(zoomCrop(c, rw, rh, aspect, 1).w, m.w)).toBe(true);
  });
  it('Zwei Finger: Größe × Faktor, begrenzt auf Bild und Mindestgröße', () => {
    const start = zoomCrop(maxCrop(rw, rh, aspect), rw, rh, aspect, 0.4);
    const g = pinchCrop(start, 1.5, 0, 0, rw, rh, aspect, 100);
    expect(near(g.w, start.w * 1.5)).toBe(true);
    expect(near(cropAspect(g, rw, rh), aspect)).toBe(true);
    const big = pinchCrop(start, 10, 0, 0, rw, rh, aspect, 100);
    expect(near(big.w, maxCrop(rw, rh, aspect).w)).toBe(true);
    expect(inside(big)).toBe(true);
    const tiny = pinchCrop(start, 0.01, 0, 0, rw, rh, aspect, 100);
    expect(near(tiny.w * rw, 100, 1e-6)).toBe(true);
    const moved = pinchCrop(start, 1, 0.05, -0.05, rw, rh, aspect, 100);
    expect(near(moved.x, start.x + 0.05) && near(moved.y, start.y - 0.05)).toBe(true);
    expect(near(pinchCrop(start, Number.NaN, 0, 0, rw, rh, aspect, 100).w, start.w)).toBe(true);
  });
  it('Pixelanzeige aus Ausschnitt und Raster', () => {
    const info = cropPixelInfo({ x: 0, y: 0, w: 0.5, h: 0.5 }, 4000, 3000, 100, 75);
    expect(info).toEqual({ w: 2000, h: 1500, perStoneW: 20, perStoneH: 20 });
    expect(cropPixelInfo({ x: 0, y: 0, w: 1, h: 1 }, 10, 10, 0, 0).perStoneW).toBe(0);
  });
});

// ================================================================ 4. Volle Auflösung nur bei Bedarf
describe('Berechnung: Original voll lesen nur bei Bedarf', () => {
  it('48-MP-Foto, Arbeitskopie 4618 × 3464', () => {
    const full = { x: 0, y: 0, w: 1, h: 1 };
    // ganzes Bild: Arbeitsauflösung höchstens 6 MP < 16 MP der Kopie → Kopie reicht
    const ws = workingSize(333 * 250, 4 / 3, 8000 * 6000);
    expect(needsFullResolution(true, full, 4618, 3464, ws)).toBe(false);
    // 30-%-Ausschnitt: im Original 2400 × 1800 = 4,3 MP, Arbeitsauflösung 3 MP, Kopie nur 1,44 MP → Original lesen
    const small = { x: 0.35, y: 0.35, w: 0.3, h: 0.3 };
    const ws2 = workingSize(333 * 250, 4 / 3, 0.3 * 8000 * 0.3 * 6000);
    expect(ws2.w * ws2.h).toBeGreaterThan(0.3 * 4618 * 0.3 * 3464);
    expect(needsFullResolution(true, small, 4618, 3464, ws2)).toBe(true);
    // nicht verkleinert: nie
    expect(needsFullResolution(false, small, 4618, 3464, ws2)).toBe(false);
  });
  it('Arbeitsauflösung hängt nur vom Original ab (gleiche Pixelzahl wie ohne Arbeitskopie)', () => {
    const crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    const a = workingSize(167 * 125, 4 / 3, crop.w * 8000 * crop.h * 6000);
    expect(a.w * a.h).toBeLessThanOrEqual(6_000_000 * 1.001);
    expect(Math.abs(a.w / a.h - 4 / 3)).toBeLessThan(0.01);
  });
});

// ================================================================ 5. Eigene Palette: Nummern stabil
describe('Eigene Palette mit Nummernlücken (Eingabeaufbau wie useProject.compute)', () => {
  const palette: PaletteColor[] = CUSTOM8.map((c) => ({ code: c.code, hex: c.hex, name: c.name, lab: hexToLab(c.hex) }));
  const s = { paletteMode: 'custom' as const, materialIds: [] as string[] };

  it('buildFixedPalette reicht die Nummern weiter', () => {
    const fixed = buildFixedPalette(s, palette, [])!;
    expect(fixed.map((f) => f.code)).toEqual([1, 2, 3, 5, 6, 7, 8, 9]);
    expect(() => buildFixedPalette(s, [], [])).toThrow('no-palette');
    expect(buildFixedPalette({ paletteMode: 'auto', materialIds: [] }, palette, [])).toBeUndefined();
  });

  it('zwei Berechnungen hintereinander: Nummern, Reihenfolge und HEX bleiben', () => {
    const su = sampleSetup('portrait');
    const run = (pal: PaletteColor[]) => computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: buildFixedPalette(s, pal, []) }));
    const r1 = run(palette);
    expect(r1.palette.map((p) => p.code)).toEqual([1, 2, 3, 5, 6, 7, 8, 9]);
    expect(r1.palette.map((p) => p.hex.toUpperCase())).toEqual(palette.map((p) => p.hex.toUpperCase()));
    // wie useProject: Ergebnispalette wird Projektpalette und Eingabe der nächsten Berechnung
    const r2 = run(r1.palette);
    expect(r2.palette.map((p) => [p.code, p.hex.toUpperCase(), p.name])).toEqual(r1.palette.map((p) => [p.code, p.hex.toUpperCase(), p.name]));
    expect(Buffer.from(r2.data.c1.buffer).equals(Buffer.from(r1.data.c1.buffer))).toBe(true);
    // Schlüssel des berechneten Stands bleibt gleich → kein „veraltet“ nach dem Neuberechnen
    const rec = (pal: PaletteColor[]): ProjectRecord => ({ meta: { id: 'x', name: 'x', createdAt: 0, updatedAt: 0, computed: true }, settings: { ...DEFAULT_SETTINGS, paletteMode: 'custom' }, adjust: { ...DEFAULT_ADJUST }, regions: [], palette: pal });
    expect(computeKey(rec(r2.palette))).toBe(computeKey(rec(r1.palette)));
  });

  it('Materialmodus: Auswahl bzw. alle Materialien, Fehler ohne Material', () => {
    const m: Material[] = [
      { id: 'a', type: 'glass', manufacturer: 'X', product: 'P', colorNumber: '1', colorName: '', hex: '#ff0000', lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 0, packageSize: '', piecesPerPack: 0 },
      { id: 'b', type: 'glass', manufacturer: 'X', product: 'P', colorNumber: '2', colorName: 'Blau', hex: '#0000ff', lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 0, packageSize: '', piecesPerPack: 0 },
    ];
    expect(buildFixedPalette({ paletteMode: 'materials', materialIds: [] }, [], m)!.map((f) => [f.hex, f.name, f.materialId])).toEqual([
      ['#FF0000', 'X 1', 'a'],
      ['#0000FF', 'Blau', 'b'],
    ]);
    expect(buildFixedPalette({ paletteMode: 'auto-snap', materialIds: ['b'] }, [], m)!.length).toBe(1);
    expect(() => buildFixedPalette({ paletteMode: 'materials', materialIds: ['zz'] }, [], m)).toThrow('no-materials');
  });
});

// ================================================================ 6. Neues Projekt für ein anderes Foto
describe('projectFromPhoto', () => {
  const base: ProjectRecord = {
    meta: { id: 'old', name: 'Alt', createdAt: 1, updatedAt: 2, computed: true, thumb: 'data:x' },
    settings: { ...DEFAULT_SETTINGS, widthMm: 600, heightMm: 800, tileW: 5, tileH: 5, joint: 1.5, colorCount: 48, paletteMode: 'custom', materialIds: ['m1'] },
    adjust: { ...DEFAULT_ADJUST, brightness: 30, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, rotation: 90 },
    regions: [{ id: 'f', type: 'face', shape: 'ellipse', x: 0.2, y: 0.2, w: 0.3, h: 0.3 }],
    palette: CUSTOM8.map((c) => ({ code: c.code, hex: c.hex, name: c.name, lab: hexToLab(c.hex) })),
    computedWith: '{"x":1}',
    mosaicRev: 'rev1',
    imageRev: 'img1',
    computedImageRev: 'img1',
  };
  it('übernimmt Einstellungen und eigene Palette, Höhe aus dem neuen Foto, nichts vom alten Foto', () => {
    const p = projectFromPhoto(base, 'new', 'Katze', 4 / 3, 99, 'img2');
    expect(p.meta).toEqual({ id: 'new', name: 'Katze', createdAt: 99, updatedAt: 99, computed: false });
    expect(p.settings).toEqual({ ...base.settings, heightMm: 450 });
    expect(p.settings.shapes).not.toBe(base.settings.shapes);
    expect(p.adjust).toEqual(DEFAULT_ADJUST);
    expect(p.regions).toEqual([]);
    expect(p.palette.map((c) => c.code)).toEqual([1, 2, 3, 5, 6, 7, 8, 9]);
    expect(p.palette[0]).not.toBe(base.palette[0]);
    expect(p.imageRev).toBe('img2');
    expect(p.computedWith).toBeUndefined();
    expect(p.mosaicRev).toBeUndefined();
    expect(p.computedImageRev).toBeUndefined();
    expect(p.diagnostics).toBeUndefined();
  });
  it('automatische Palette wird nicht übernommen (sie ist ein Ergebnis); ungültiges Seitenverhältnis lässt die Höhe', () => {
    const p = projectFromPhoto({ ...base, settings: { ...base.settings, paletteMode: 'auto' } }, 'n', 'N', Number.NaN, 1, 'i');
    expect(p.palette).toEqual([]);
    expect(p.settings.heightMm).toBe(800);
  });
  it('Projektname aus dem Dateinamen', () => {
    expect(nameFromFile('IMG_2041.jpg', 'Mosaik')).toBe('IMG_2041');
    expect(nameFromFile('urlaub.foto.jpeg', 'Mosaik')).toBe('urlaub.foto');
    expect(nameFromFile('', 'Mosaik')).toBe('Mosaik');
    expect(nameFromFile('.jpg', 'Mosaik')).toBe('Mosaik');
  });
});
