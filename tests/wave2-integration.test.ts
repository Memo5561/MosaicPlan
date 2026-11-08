/**
 * Integrationstest Welle 2: Schnittstellen zwischen den Paketen, die erst nach dem Zusammenführen
 * zusammenwirken.
 *  - useProject.buildFixedPalette (w2-photo-intake) reicht nameKey/nameSuffix der eigenen Palette
 *    (w2-colour-honesty) und den Materialbestand (Vertrag für Welle 3) an die Berechnung weiter.
 *  - Automatische Namen bleiben über eine Berechnung automatisch, eingetippte bleiben wörtlich.
 *  - Sicherungsdateien aus dem Arbeitsbereich tragen Datum und Uhrzeit (wie „Meine Projekte“).
 */
import { describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { nameKeyFor, paletteDisplayName } from '../src/core/colorNames';
import { computeMosaic } from '../src/core/mosaic';
import { piecesPerColor } from '../src/core/paletteOps';
import type { Material, PaletteColor } from '../src/core/types';
import { timestampedName } from '../src/platform';
import { buildFixedPalette } from '../src/ui/project/useProject';
import { baseParams, CUSTOM8, sampleSetup } from './w1-mosaic-core.fixtures';

describe('Welle 2: Palette → Berechnung', () => {
  it('eigene Palette: nameKey/nameSuffix werden weitergereicht, eingetippte Namen nicht als automatisch markiert', () => {
    const palette: PaletteColor[] = CUSTOM8.map((c, i) => {
      const lab = hexToLab(c.hex);
      // erste Farbe: automatischer Name (Schlüssel gesetzt), Rest: wörtlich eingetippte Namen
      return i === 0 ? { code: c.code, hex: c.hex, name: 'x', lab, nameKey: nameKeyFor(lab), nameSuffix: 1 } : { code: c.code, hex: c.hex, name: c.name, lab };
    });
    const fixed = buildFixedPalette({ paletteMode: 'custom', materialIds: [] }, palette, [])!;
    expect(fixed[0].nameKey).toBe(palette[0].nameKey);
    expect(fixed[0].nameSuffix).toBe(1);
    for (const f of fixed.slice(1)) expect(f.nameKey).toBeUndefined();

    const su = sampleSetup('portrait');
    const r = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: fixed }));
    // Reihenfolge, Nummern und HEX unverändert; der automatische Name bleibt automatisch
    expect(r.palette.map((p) => p.code)).toEqual(palette.map((p) => p.code));
    expect(r.palette.map((p) => p.hex.toUpperCase())).toEqual(palette.map((p) => p.hex.toUpperCase()));
    expect(r.palette[0].nameKey).toBe(palette[0].nameKey);
    expect(paletteDisplayName(r.palette[0], 'de')).not.toBe('x');
    // eingetippte Namen bleiben wörtlich
    for (let i = 1; i < palette.length; i++) expect(r.palette[i].name).toBe(palette[i].name);
    // Stückzahlen: je Farbe = gezählte Teilstücke des Rasters
    const perColor = piecesPerColor(r.data, r.palette.length);
    expect(r.palette.map((p) => p.matchDeltaE?.pieces ?? 0)).toEqual(perColor);
  });

  it('Materialmodi: Bestand wird weitergereicht (nur wenn angegeben)', () => {
    const m: Material[] = [
      { id: 'a', type: 'glass', manufacturer: 'X', product: 'P', colorNumber: '1', colorName: '', hex: '#ff0000', lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 0, packageSize: '', piecesPerPack: 0, stock: 250 },
      { id: 'b', type: 'glass', manufacturer: 'X', product: 'P', colorNumber: '2', colorName: 'Blau', hex: '#0000ff', lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 0, packageSize: '', piecesPerPack: 0 },
    ];
    const fixed = buildFixedPalette({ paletteMode: 'materials', materialIds: [] }, [], m)!;
    expect(fixed.map((f) => f.stock)).toEqual([250, undefined]);
    expect('stock' in fixed[1]).toBe(false);
  });
});

describe('Welle 2: Sicherungsdateien', () => {
  it('Name mit Datum und Uhrzeit (Ortszeit)', () => {
    expect(timestampedName('Katze', 'mosaicplan.json', new Date(2026, 10, 8, 14, 32))).toBe('Katze_2026-11-08_1432.mosaicplan.json');
  });
});
