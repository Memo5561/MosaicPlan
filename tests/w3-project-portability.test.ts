/**
 * Projekt zwischen Geräten übertragen (w3-project-portability): Die Projektdatei nimmt die verknüpften
 * Materialien mit; der Import überschreibt nie vorhandene Materialien, ordnet nur exakt zu und meldet alles.
 * (Das Schreiben in IndexedDB prüft e2e/w3-project-portability.e2e.cjs im Browser.)
 */
import { describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { computeLayout } from '../src/core/layout';
import {
  danglingMaterialRefs,
  materialKey,
  planProjectMaterialImport,
  referencedMaterialIds,
  remapComputeKey,
  remapIdList,
  remapMaterialRefsDeep,
  remapPaletteMaterials,
  remapPaletteSig,
  sanitizeMaterial,
  selectMaterials,
} from '../src/core/materialImport';
import { packMosaic, unpackMosaic } from '../src/core/serialize';
import { computeStats } from '../src/core/stats';
import { CellKind, createEmptyMosaic, DEFAULT_ADJUST, DEFAULT_SETTINGS, type Material, type PaletteColor } from '../src/core/types';
import { paletteEditsSince, paletteSignature, type ProjectRecord } from '../src/storage/db';
import {
  buildProjectExport,
  parseProjectFile,
  prepareProjectImport,
  PROJECT_FILE_VERSION,
  ProjectFileError,
  uniqueImportName,
  type ParsedProjectFile,
} from '../src/storage/projects';
import { computeKey } from '../src/ui/project/useProject';

function mat(id: string, over: Partial<Material> = {}): Material {
  return {
    id,
    type: 'glass',
    manufacturer: 'Bisazza',
    product: 'Vetricolor',
    colorNumber: id.toUpperCase(),
    colorName: 'Kobaltblau',
    hex: '#2050C0',
    lengthMm: 20,
    widthMm: 20,
    thicknessMm: 4,
    price: 12.5,
    packageSize: '1 kg',
    piecesPerPack: 250,
    notes: '',
    ...over,
  };
}

const freeze = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('planProjectMaterialImport', () => {
  it('leerer Materialbestand: alles mit ursprünglicher ID neu angelegt, Zuordnung unverändert', () => {
    const exp = [mat('a'), mat('b', { hex: '#C02020' })];
    const plan = planProjectMaterialImport(exp, []);
    expect(plan.inserts.map((m) => m.id)).toEqual(['a', 'b']);
    expect(plan.inserts).toEqual(exp);
    expect(plan.mapping).toEqual({ a: 'a', b: 'b' });
    expect(plan.counts).toEqual({ inserted: 2, linked: 0, differing: 0 });
    expect(plan.notes).toEqual([]);
  });

  it('gleiche ID mit anderen Daten: vorhandenes Material bleibt unverändert, Abweichung wird gemeldet', () => {
    const local = [mat('a', { price: 15, hex: '#2050C1', stock: 40 })];
    const before = freeze(local);
    const plan = planProjectMaterialImport([mat('a', { stock: 100 })], local);
    expect(plan.inserts).toEqual([]);
    expect(plan.mapping).toEqual({ a: 'a' });
    expect(plan.counts).toEqual({ inserted: 0, linked: 1, differing: 1 });
    expect(plan.links).toEqual([{ exportedId: 'a', localId: 'a', how: 'same-id', differs: ['hex', 'price', 'stock'] }]);
    expect(plan.notes).toHaveLength(1);
    const note = plan.notes[0];
    expect(note.kind).toBe('differs');
    if (note.kind === 'differs') {
      expect(note.how).toBe('same-id');
      expect(note.fields).toEqual(['hex', 'price', 'stock']);
      expect(note.local.price).toBe(15);
      expect(note.exported.price).toBe(12.5);
    }
    // nie überschrieben
    expect(local).toEqual(before);
  });

  it('gleiche ID mit gleichen Daten: zugeordnet, ohne Hinweis', () => {
    const plan = planProjectMaterialImport([mat('a')], [mat('a')]);
    expect(plan.counts).toEqual({ inserted: 0, linked: 1, differing: 0 });
    expect(plan.notes).toEqual([]);
  });

  it('exakter Schlüssel (Hersteller + Produkt + Farbnummer + Größe, normalisiert): auf die vorhandene ID umgeschrieben', () => {
    const local = [mat('local-1', { manufacturer: '  BISAZZA ', product: 'vetricolor', colorNumber: 'a', price: 13 })];
    const plan = planProjectMaterialImport([mat('a')], local);
    expect(plan.inserts).toEqual([]);
    expect(plan.mapping).toEqual({ a: 'local-1' });
    expect(plan.links[0]).toMatchObject({ exportedId: 'a', localId: 'local-1', how: 'matched' });
    expect(plan.counts).toEqual({ inserted: 0, linked: 1, differing: 1 });
    const note = plan.notes[0];
    expect(note.kind === 'differs' && note.how === 'matched' && note.fields).toEqual(['manufacturer', 'product', 'colorNumber', 'price']);
  });

  it('Umlaute/Akzente zählen beim Schlüssel nicht, Maße schon exakt', () => {
    expect(materialKey(mat('x', { manufacturer: 'Glasbläserei Müller', colorNumber: '09' }))).toBe(materialKey(mat('y', { manufacturer: 'glasblaserei muller', colorNumber: '09' })));
    expect(materialKey(mat('x', { lengthMm: 20 }))).not.toBe(materialKey(mat('x', { lengthMm: 20.5 })));
    expect(materialKey(mat('x', { manufacturer: '' }))).toBeNull();
    expect(materialKey(mat('x', { colorNumber: ' ' }))).toBeNull();
  });

  it('kein „nächstes“ Material: ähnliche, aber nicht exakt gleiche Materialien werden nie gewählt', () => {
    const exported = mat('a', { colorNumber: '09', hex: '#2050C0' });
    const local = [
      mat('size', { colorNumber: '09', lengthMm: 10, widthMm: 10 }), // andere Größe
      mat('number', { colorNumber: '9' }), // andere Farbnummer
      mat('product', { colorNumber: '09', product: 'Vetricolor Plus' }), // anderes Produkt
      mat('maker', { colorNumber: '09', manufacturer: 'Sicis' }), // anderer Hersteller
      mat('hex', { colorNumber: '10', hex: '#2050C0' }), // gleiche Farbe, andere Nummer
    ];
    const plan = planProjectMaterialImport([exported], local);
    expect(plan.mapping).toEqual({ a: 'a' });
    expect(plan.inserts.map((m) => m.id)).toEqual(['a']);
    expect(plan.counts).toEqual({ inserted: 1, linked: 0, differing: 0 });
  });

  it('mehrere gleich gute Treffer: nicht geraten – angelegt und gemeldet; ein in allen Feldern gleicher Treffer ist eindeutig', () => {
    const local = [mat('l1', { colorNumber: 'A', price: 1 }), mat('l2', { colorNumber: 'A', price: 2 })];
    const amb = planProjectMaterialImport([mat('a')], local);
    expect(amb.inserts.map((m) => m.id)).toEqual(['a']);
    expect(amb.notes).toEqual([{ kind: 'ambiguous', exported: mat('a'), candidates: 2 }]);

    const exact = planProjectMaterialImport([mat('a', { price: 2 })], local);
    expect(exact.mapping).toEqual({ a: 'l2' });
    expect(exact.counts).toEqual({ inserted: 0, linked: 1, differing: 0 });
  });

  it('ein vorhandenes Material wird höchstens einem Material der Datei zugeordnet', () => {
    // auf dem Quellgerät zwei Materialien mit gleichem Schlüssel (z. B. doppelt erfasst)
    const exp = [mat('a', { colorNumber: 'K' }), mat('b', { colorNumber: 'K', hex: '#C02020' })];
    const plan = planProjectMaterialImport(exp, [mat('l', { colorNumber: 'K' })]);
    expect(plan.mapping).toEqual({ a: 'l', b: 'b' });
    expect(plan.inserts.map((m) => m.id)).toEqual(['b']);
    expect(plan.notes.map((n) => n.kind)).toEqual(['taken']);

    // per ID belegtes Material steht für den Schlüsselabgleich nicht mehr zur Verfügung
    const plan2 = planProjectMaterialImport([mat('l', { colorNumber: 'K' }), mat('c', { colorNumber: 'K' })], [mat('l', { colorNumber: 'K' })]);
    expect(plan2.mapping).toEqual({ l: 'l', c: 'c' });
    expect(plan2.notes.map((n) => n.kind)).toEqual(['taken']);
  });

  it('ohne Hersteller/Farbnummer: nur ein in allen beschreibenden Feldern gleiches Material wird zugeordnet', () => {
    const plain = (id: string, over: Partial<Material> = {}) => mat(id, { manufacturer: '', colorNumber: '', colorName: 'Blau', ...over });
    expect(planProjectMaterialImport([plain('a')], [plain('l', { stock: 7, notes: 'Regal 3' })]).mapping).toEqual({ a: 'l' });
    expect(planProjectMaterialImport([plain('a')], [plain('l', { price: 13 })]).mapping).toEqual({ a: 'a' });
    expect(planProjectMaterialImport([plain('a')], [plain('l', { hex: '#2050C1' })]).mapping).toEqual({ a: 'a' });
  });

  it('unbrauchbare und doppelte Einträge werden gemeldet, nie still übernommen', () => {
    const plan = planProjectMaterialImport([null, 'x', { ...mat('a'), id: '' }, mat('b', { hex: 'blau' }), mat('c'), mat('c', { price: 99 })], []);
    expect(plan.inserts.map((m) => m.id)).toEqual(['c']);
    expect(plan.inserts[0].price).toBe(12.5);
    expect(plan.notes).toEqual([
      { kind: 'invalid', id: '', reason: 'not-object' },
      { kind: 'invalid', id: '', reason: 'not-object' },
      { kind: 'invalid', id: '', reason: 'id' },
      { kind: 'invalid', id: 'b', reason: 'hex' },
      { kind: 'duplicate', id: 'c' },
    ]);
    expect(plan.mapping).toEqual({ c: 'c' });
  });

  it('sanitizeMaterial: unlesbare Einzelwerte → „unbekannt“, gemeldet; unbekannte Felder bleiben', () => {
    const s = sanitizeMaterial({ ...mat('a'), hex: '2050c0', type: 'gold', price: 'teuer', lengthMm: -3, stock: Number.NaN, extra: 'neu' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.material.hex).toBe('#2050C0');
    expect(s.material.type).toBe('other');
    expect(s.material.price).toBe(0);
    expect(s.material.lengthMm).toBe(0);
    expect('stock' in s.material).toBe(false);
    expect((s.material as unknown as { extra: string }).extra).toBe('neu');
    expect(s.repaired).toEqual(['type', 'lengthMm', 'price', 'stock']);
    const plan = planProjectMaterialImport([{ ...mat('a'), price: 'teuer' }], []);
    expect(plan.notes.map((n) => n.kind)).toEqual(['repaired']);
  });
});

describe('Export: nur verknüpfte Materialien', () => {
  it('Palette und nicht leere Materialauswahl, ohne Doppelte; leere Auswahl nimmt nicht den ganzen Katalog mit', () => {
    const palette = [{ materialId: 'b' }, {}, { materialId: 'a' }, { materialId: 'b' }];
    expect(referencedMaterialIds(palette, [])).toEqual(['b', 'a']);
    expect(referencedMaterialIds(palette, ['c', 'a'])).toEqual(['b', 'a', 'c']);
    expect(referencedMaterialIds(undefined, undefined)).toEqual([]);
    const all = [mat('a'), mat('b'), mat('c'), mat('d')];
    expect(selectMaterials(['b', 'gone', 'a'], all).map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('Verweise umschreiben', () => {
  const map = { a: 'L1', b: 'b' };

  it('Palette, ID-Liste und tiefe Verweise', () => {
    const pal = [{ code: 1, materialId: 'a' }, { code: 2, materialId: 'b' }, { code: 3 }];
    const out = remapPaletteMaterials(pal, map);
    expect(out.map((p) => p.materialId)).toEqual(['L1', 'b', undefined]);
    expect(out[1]).toBe(pal[1]);
    expect(remapIdList(['a', 'b', 'L1'], map)).toEqual(['L1', 'b']);
    const diag = { meanDeltaE: 1, missing: [{ nearestMaterialId: 'a', hex: '#000000' }], selection: { materialIds: ['a', 'x'] } };
    const d2 = remapMaterialRefsDeep(diag, map);
    expect(d2.missing[0].nearestMaterialId).toBe('L1');
    expect(d2.selection.materialIds).toEqual(['L1', 'x']);
    expect(diag.missing[0].nearestMaterialId).toBe('a');
    const untouched = { meanDeltaE: 2 };
    expect(remapMaterialRefsDeep(untouched, map)).toBe(untouched);
  });

  it('Berechnungsschlüssel: nur „mi“ ändert sich, sonst Zeichen für Zeichen gleich', () => {
    const key = JSON.stringify({ l: { widthMm: 300 }, pm: 'materials', mi: ['a', 'b'], a: { b: 0.5 } });
    expect(remapComputeKey(key, map)).toBe(JSON.stringify({ l: { widthMm: 300 }, pm: 'materials', mi: ['L1', 'b'], a: { b: 0.5 } }));
    expect(remapComputeKey(key, { a: 'a', b: 'b' })).toBe(key);
    expect(remapComputeKey('kaputt{', map)).toBe('kaputt{');
    expect(remapComputeKey(undefined, map)).toBeUndefined();
  });

  it('Paletten-Fingerabdruck: Material-ID ersetzt, Format wie paletteEntrySig', () => {
    const pal: PaletteColor[] = [{ code: 1, name: 'X', hex: '#112233', lab: hexToLab('#112233'), materialId: 'a' }];
    const sig = paletteSignature(pal);
    const remapped = remapPaletteSig(sig, map);
    expect(paletteEditsSince(remapped, remapPaletteMaterials(pal, map))).toBe(0);
    expect(paletteEditsSince(sig, remapPaletteMaterials(pal, map))).toBe(1);
  });

  it('danglingMaterialRefs zählt Verweise ohne Material', () => {
    expect(danglingMaterialRefs([{ materialId: 'a' }, { materialId: 'x' }, {}, { materialId: '' }], ['a', 'y', 'z'], new Set(['a']))).toEqual({ colors: 1, selected: 2 });
  });
});

describe('uniqueImportName', () => {
  it('Zusatz nur bei gleichem Namen, fortlaufend nummeriert', () => {
    expect(uniqueImportName('Porträt', ['Landschaft'])).toBe('Porträt');
    expect(uniqueImportName('Porträt', ['porträt '])).toBe('Porträt (Import)');
    expect(uniqueImportName('Porträt', ['Porträt', 'Porträt (Import)'])).toBe('Porträt (Import 2)');
    expect(uniqueImportName('Porträt', ['Porträt', 'Porträt (Import)', 'Porträt (Import 2)'])).toBe('Porträt (Import 3)');
    expect(uniqueImportName('Portrait', ['Portrait'], '(imported)')).toBe('Portrait (imported)');
    expect(uniqueImportName('Portre', ['Portre', 'Portre (içe aktarıldı)'], '(içe aktarıldı)')).toBe('Portre (içe aktarıldı 2)');
  });
});

// ---------------------------------------------------------------- Rundreise Export → Import

/** 6 × 4 Raster (10-mm-Steine, 2 mm Fuge) mit ganzen Steinen und Diagonalschnitten in drei Farben. */
function sampleProject(materialIds: (string | undefined)[], settings: Partial<ProjectRecord['settings']> = {}) {
  const lp = { widthMm: 72, heightMm: 48, tileW: 10, tileH: 10, joint: 2, edgeMode: 'whole' as const, minCutMm: DEFAULT_SETTINGS.minCutMm };
  const layout = computeLayout(lp);
  const d = createEmptyMosaic(layout.cols, layout.rows);
  for (let i = 0; i < d.kind.length; i++) {
    d.c1[i] = i % 3;
    if (i % 5 === 0) {
      d.kind[i] = CellKind.DIAG_A;
      d.c2[i] = (i + 1) % 3;
    } else d.kind[i] = CellKind.FULL;
  }
  const hexes = ['#2050C0', '#C02020', '#20A040'];
  const palette: PaletteColor[] = hexes.map((hex, i) => ({ code: i + 1, name: `F${i + 1}`, hex, lab: hexToLab(hex), materialId: materialIds[i] }));
  const rec: ProjectRecord = {
    meta: { id: 'src', name: 'Porträt', createdAt: 1, updatedAt: 2, computed: true },
    settings: { ...DEFAULT_SETTINGS, shapes: { ...DEFAULT_SETTINGS.shapes }, ...lp, reservePct: 10, ...settings },
    adjust: { ...DEFAULT_ADJUST },
    regions: [],
    palette,
    mosaicRev: 'rev-1',
    computedPaletteSig: paletteSignature(palette),
  };
  rec.computedWith = computeKey(rec);
  return { rec, layout, data: d, mosaic: { ...packMosaic(d), rev: 'rev-1' } };
}

async function exportParsed(rec: ProjectRecord, mosaic: ReturnType<typeof sampleProject>['mosaic'], materials: Material[] | null): Promise<ParsedProjectFile> {
  const image = { name: 'foto.png', original: new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: 'image/png' }) };
  const progress = new Uint16Array(mosaic.cols * mosaic.rows).fill(1);
  const blob = await buildProjectExport(rec, image, mosaic, progress, materials);
  return parseProjectFile(await blob.text());
}

const stats = (p: ReturnType<typeof sampleProject>, palette: PaletteColor[], materials: Material[]) =>
  computeStats(p.layout, p.data, palette, materials, { reservePct: p.rec.settings.reservePct, groutDepthMm: 3 });

describe('Rundreise: Projektdatei mit Materialien', () => {
  // Gerät A: drei Materialien mit eigenem Rohsteinmaß (20 × 20 mm) und Preisen, ein unbenutztes
  const deviceA = [mat('m1', { hex: '#2050C0' }), mat('m2', { hex: '#C02020', lengthMm: 30, widthMm: 15, price: 8 }), mat('m3', { hex: '#20A040', piecesPerPack: 100 }), mat('unused')];

  it('Datei Version 2 enthält genau die verknüpften Materialien; Foto, Raster und Fortschritt unverändert', async () => {
    const p = sampleProject(['m1', 'm2', 'm3']);
    const parsed = await exportParsed(p.rec, p.mosaic, deviceA);
    expect(parsed.version).toBe(PROJECT_FILE_VERSION);
    expect((parsed.materials as Material[]).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(parsed.materialPool).toBeNull();
    expect(Array.from(parsed.image!.bytes)).toEqual([137, 80, 78, 71, 1, 2, 3]);
    expect(unpackMosaic(parsed.mosaic as never).c1).toEqual(p.data.c1);
    expect(parsed.mosaic!.rev).toBe('rev-1');
    expect(parsed.progress!.length).toBe(p.mosaic.cols * p.mosaic.rows);
  });

  it('Import in einen leeren Materialbestand: alle Farben verknüpft, Rohsteine inkl. Reserve und Kosten wie auf Gerät A', async () => {
    const p = sampleProject(['m1', 'm2', 'm3']);
    const parsed = await exportParsed(p.rec, p.mosaic, deviceA);
    const prep = prepareProjectImport(parsed, [], [], { id: 'new', now: 99 });
    expect(prep.inserts.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(prep.summary.materials).toEqual({ inserted: 3, linked: 0, differing: 0 });
    expect(prep.summary.missing).toEqual({ colors: 0, selected: 0 });
    expect(prep.rec.meta).toMatchObject({ id: 'new', name: 'Porträt', updatedAt: 99 });
    expect(prep.rec.palette.map((c) => c.materialId)).toEqual(['m1', 'm2', 'm3']);
    // weder „Einstellungen geändert“ noch „bearbeitete Palettenfarben“
    expect(computeKey(prep.rec)).toBe(prep.rec.computedWith);
    expect(paletteEditsSince(prep.rec.computedPaletteSig, prep.rec.palette)).toBe(0);

    const a = stats(p, p.rec.palette, deviceA);
    const b = stats(p, prep.rec.palette, prep.inserts);
    expect(b.rawWithReserveTotal).toBe(a.rawWithReserveTotal);
    expect(b.rawTotal).toBe(a.rawTotal);
    expect(b.totalCost).toBe(a.totalCost);
    expect(b.costComplete).toBe(true);
    // Gegenprobe: ohne die Materialien (alte Datei) fiele der Bedarf auf das Rastermaß zurück
    const lost = stats(p, prep.rec.palette, []);
    expect(lost.rawWithReserveTotal).not.toBe(a.rawWithReserveTotal);
  });

  it('Import mit widersprüchlicher ID: das Material dieses Geräts bleibt, Abweichung gemeldet, Verweise bleiben', async () => {
    const p = sampleProject(['m1', 'm2', 'm3']);
    const parsed = await exportParsed(p.rec, p.mosaic, deviceA);
    const local = [mat('m2', { hex: '#C02020', lengthMm: 10, widthMm: 10, price: 9 })];
    const prep = prepareProjectImport(parsed, local, ['Porträt'], { id: 'new', now: 99 });
    expect(prep.inserts.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(prep.summary.materials).toEqual({ inserted: 2, linked: 1, differing: 1 });
    expect(prep.summary.notes).toHaveLength(1);
    expect(prep.summary.notes[0]).toMatchObject({ kind: 'differs', how: 'same-id', fields: ['lengthMm', 'widthMm', 'price'] });
    expect(prep.rec.palette.map((c) => c.materialId)).toEqual(['m1', 'm2', 'm3']);
    expect(prep.rec.meta.name).toBe('Porträt (Import)');
    expect(prep.summary).toMatchObject({ renamed: true, originalName: 'Porträt', name: 'Porträt (Import)' });
    // Bedarf wird mit den Daten dieses Geräts gerechnet – jede Farbe hat ein Material
    const b = stats(p, prep.rec.palette, [...local, ...prep.inserts]);
    expect(b.perColor.every((c) => c.rawW > 0)).toBe(true);
    expect(b.costComplete).toBe(true);
  });

  it('exakter Treffer mit anderer ID: Palette, Materialauswahl, Schlüssel und Fingerabdruck umgeschrieben – Projekt bleibt aktuell', async () => {
    const p = sampleProject(['m1', 'm2', 'm3'], { paletteMode: 'materials', materialIds: ['m1', 'm2', 'm3'] });
    const parsed = await exportParsed(p.rec, p.mosaic, deviceA);
    // Gerät B hat m2 schon – mit eigener ID (z. B. selbst erfasst)
    const local = [{ ...deviceA[1], id: 'b-own-m2' }];
    const prep = prepareProjectImport(parsed, local, [], { id: 'new', now: 99 });
    expect(prep.inserts.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(prep.summary.materials).toEqual({ inserted: 2, linked: 1, differing: 0 });
    expect(prep.rec.palette.map((c) => c.materialId)).toEqual(['m1', 'b-own-m2', 'm3']);
    expect(prep.rec.settings.materialIds).toEqual(['m1', 'b-own-m2', 'm3']);
    expect(computeKey(prep.rec)).toBe(prep.rec.computedWith);
    expect(prep.rec.computedWith).not.toBe(p.rec.computedWith);
    expect(paletteEditsSince(prep.rec.computedPaletteSig, prep.rec.palette)).toBe(0);
    expect(prep.summary.missing).toEqual({ colors: 0, selected: 0 });
    // Quelle unverändert
    expect(parsed.record.palette.map((c) => c.materialId)).toEqual(['m1', 'm2', 'm3']);
    const a = stats(p, p.rec.palette, deviceA);
    const b = stats(p, prep.rec.palette, [...local, ...prep.inserts]);
    expect(b.rawWithReserveTotal).toBe(a.rawWithReserveTotal);
    expect(b.totalCost).toBe(a.totalCost);
  });

  it('Version-1-Datei (ohne Materialien): Warnung mit Anzahl der Farben ohne gültiges Material', async () => {
    const p = sampleProject(['m1', 'm2', undefined]);
    const parsed = await exportParsed(p.rec, p.mosaic, deviceA);
    const v1: ParsedProjectFile = { ...parsed, version: 1, materials: null };
    const prep = prepareProjectImport(v1, [], [], { id: 'new', now: 99 });
    expect(prep.summary.materialsInFile).toBe(false);
    expect(prep.summary.refs).toEqual({ colors: 2, selected: 0 });
    expect(prep.summary.missing).toEqual({ colors: 2, selected: 0 });
    expect(prep.inserts).toEqual([]);
    // auf demselben Gerät (Materialien vorhanden) fehlt nichts
    const same = prepareProjectImport(v1, deviceA, [], { id: 'new', now: 99 });
    expect(same.summary.missing).toEqual({ colors: 0, selected: 0 });
  });

  it('echte Version-1-Datei (altes Format) wird weiterhin gelesen', async () => {
    const p = sampleProject(['m1', undefined, undefined]);
    const parsed = await exportParsed(p.rec, p.mosaic, null);
    expect(parsed.materials).toBeNull();
    const raw = JSON.parse(await (await buildProjectExport(p.rec, null, p.mosaic, null, null)).text());
    raw.version = 1;
    const v1 = parseProjectFile(JSON.stringify(raw));
    expect(v1.version).toBe(1);
    expect(v1.materials).toBeNull();
    expect(v1.image).toBeNull();
    expect(v1.progress).toBeNull();
    expect(unpackMosaic(v1.mosaic as never).kind).toEqual(p.data.kind);
  });

  it('Auswahl „alle Materialien“: Katalog wird nicht mitgenommen, Größe des Quellkatalogs gemeldet', async () => {
    const p = sampleProject(['m1', 'm2', 'm3'], { paletteMode: 'auto-snap', materialIds: [] });
    const parsed = await exportParsed(p.rec, p.mosaic, deviceA);
    expect((parsed.materials as Material[]).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(parsed.materialPool).toBe(4);
    const prep = prepareProjectImport(parsed, [], [], { id: 'new', now: 99 });
    expect(prep.summary.pool).toEqual({ source: 4, here: 3 });
  });

  it('Verweis auf ein schon beim Export fehlendes Material bleibt sichtbar offen', async () => {
    const p = sampleProject(['m1', 'gone', 'm3'], { paletteMode: 'materials', materialIds: ['m1', 'gone2'] });
    const parsed = await exportParsed(p.rec, p.mosaic, deviceA);
    expect((parsed.materials as Material[]).map((m) => m.id)).toEqual(['m1', 'm3']);
    const prep = prepareProjectImport(parsed, [], [], { id: 'new', now: 99 });
    expect(prep.summary.missing).toEqual({ colors: 1, selected: 1 });
  });
});

describe('parseProjectFile', () => {
  it('erkennt fremde und beschädigte Dateien', () => {
    const code = (text: string) => {
      try {
        parseProjectFile(text);
        return 'ok';
      } catch (e) {
        return e instanceof ProjectFileError ? e.code : 'other';
      }
    };
    expect(code('kein json')).toBe('not-project');
    expect(code('{"format":"etwas-anderes"}')).toBe('not-project');
    expect(code('[]')).toBe('not-project');
    expect(code('{"format":"mosaicplan-project","record":{"meta":{}}}')).toBe('invalid');
    expect(code('{"format":"mosaicplan-project","record":{"meta":{"name":"x"},"settings":{}},"progress":"AA=="}')).toBe('invalid');
    expect(code('{"format":"mosaicplan-project","record":{"meta":{"name":"x"},"settings":{}},"image":{"data":"!!"}}')).toBe('invalid');
    expect(code('{"format":"mosaicplan-project","record":{"meta":{"name":"x"},"settings":{}}}')).toBe('ok');
    const min = parseProjectFile('{"format":"mosaicplan-project","record":{"meta":{"name":"x"},"settings":{}}}');
    expect(min.record.palette).toEqual([]);
    expect(min.record.settings.materialIds).toEqual([]);
    expect(min.version).toBe(1);
  });
});
