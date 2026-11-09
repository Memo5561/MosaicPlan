/**
 * Paket w5-undo-editing: reine Hilfen der Oberfläche – Art einer Palettenänderung, Beschriftungen, gespeichertes
 * Vergleichsfoto (Maße, Einstellungen der Berechnung, wann „Referenz neu erzeugen“ möglich ist) und Übersetzungen.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addPaletteColor, normalizePaletteNames, removePaletteColor, updatePaletteColor } from '../src/core/edits';
import { classifyPaletteChange, paletteIndexSig } from '../src/core/journal';
import { createEmptyMosaic, DEFAULT_ADJUST, DEFAULT_SETTINGS, type PaletteColor } from '../src/core/types';
import { dictionaries } from '../src/i18n';
import type { ProjectRecord } from '../src/storage/db';
import { referenceFits } from '../src/storage/db';
import { computedSettings, recordAtCompute, referenceSize, regenerateBlock, REFERENCE_MAX_PX } from '../src/ui/project/referenceImage';
import { computeKey, paletteLabel } from '../src/ui/project/useProject';

function pal(): PaletteColor[] {
  let p: PaletteColor[] = [];
  for (const h of ['#FFFFFF', '#FF0000', '#0000FF', '#00AA00']) p = addPaletteColor(p, h, undefined, 'de');
  return p;
}

function project(): ProjectRecord {
  return {
    meta: { id: 'p1', name: 'Test', createdAt: 1, updatedAt: 1, computed: true },
    settings: { ...DEFAULT_SETTINGS, widthMm: 300, heightMm: 200 },
    adjust: { ...DEFAULT_ADJUST, brightness: 12 },
    regions: [{ id: 'f', type: 'face', shape: 'ellipse', x: 0.3, y: 0.2, w: 0.4, h: 0.5 }],
    palette: pal(),
    imageRev: 'img-1',
  };
}

describe('Art einer Palettenänderung (setPalette)', () => {
  it('Sprache der automatischen Namen: kosmetisch (kein Verlaufseintrag)', () => {
    const p = pal();
    expect(classifyPaletteChange(p, normalizePaletteNames(p, 'en')).kind).toBe('cosmetic');
  });
  it('HEX/Name/Material an gleicher Stelle: Änderung mit Farbnummer', () => {
    const p = pal();
    const n = updatePaletteColor(p, 2, { hex: '#1133EE' }, 'de');
    expect(classifyPaletteChange(p, n)).toEqual({ kind: 'update', codes: [3] });
    const named = updatePaletteColor(p, 1, { name: 'Mein Rot' }, 'de');
    expect(classifyPaletteChange(p, named)).toEqual({ kind: 'update', codes: [2] });
  });
  it('angehängt: „hinzugefügt“ (Indizes bleiben gültig), auch wenn automatische Namen einen Zusatz bekommen', () => {
    const p = pal();
    const n = addPaletteColor(p, '#EE0000', undefined, 'de');
    const c = classifyPaletteChange(p, n);
    expect(c).toEqual({ kind: 'add', codes: [5] });
    expect(paletteIndexSig(n).startsWith(`5:${p.map((x) => x.code).join(',')}`)).toBe(true);
  });
  it('entfernt/umsortiert: Indizes bedeuten danach etwas anderes', () => {
    const p = pal();
    const n = removePaletteColor(p, createEmptyMosaic(2, 2), 1);
    expect(classifyPaletteChange(p, n)).toEqual({ kind: 'reorder', codes: [2] });
    expect(classifyPaletteChange(p, [p[1], p[0], p[2], p[3]]).kind).toBe('reorder');
  });
  it('Beschriftungen mit zweistelligen Farbnummern', () => {
    expect(paletteLabel('remove', [5])).toEqual({ key: 'w5ue.h.palRemove', params: { codes: '05' } });
    expect(paletteLabel('add', [12, 3])).toEqual({ key: 'w5ue.h.palAdd', params: { codes: '12, 03' } });
    expect(paletteLabel('merge', [1])).toEqual({ key: 'w5ue.h.palMerge' });
    expect(paletteLabel('update', [])).toEqual({ key: 'w5ue.h.palReplace' });
  });
});

describe('Vergleichsfoto', () => {
  it('höchstens 2048 px Kantenlänge, Seitenverhältnis bleibt, nie vergrößert', () => {
    expect(referenceSize(6000, 4000)).toEqual({ w: REFERENCE_MAX_PX, h: 1365 });
    expect(referenceSize(1500, 3000)).toEqual({ w: 1024, h: 2048 });
    expect(referenceSize(800, 600)).toEqual({ w: 800, h: 600 });
    expect(referenceSize(0, 10)).toEqual({ w: 0, h: 0 });
  });
  it('gehört nur zum Raster mit derselben Revision', () => {
    const ref = { jpeg: new Blob(), rev: 'r1', w: 10, h: 10, origin: 'compute' as const, at: 0 };
    expect(referenceFits(ref, 'r1')).toBe(true);
    expect(referenceFits(ref, 'r2')).toBe(false);
    expect(referenceFits(undefined, 'r1')).toBe(false);
    expect(referenceFits({ ...ref, rev: undefined }, undefined)).toBe(true);
  });
  it('„Referenz neu erzeugen“ nutzt Raster, Bildbearbeitung und Bereiche der Berechnung – nicht die aktuellen', () => {
    const r = project();
    r.computedWith = computeKey(r);
    const k = computedSettings(r)!;
    expect(k.adjust.brightness).toBe(12);
    expect(k.lp.widthMm).toBe(300);
    expect(k.imageRev).toBe('img-1');
    // danach geändert: Helligkeit, Breite, Bereiche
    const later: ProjectRecord = { ...r, settings: { ...r.settings, widthMm: 500 }, adjust: { ...r.adjust, brightness: -30 }, regions: [] };
    const at = recordAtCompute(later)!;
    expect(at.adjust.brightness).toBe(12);
    expect(at.settings.widthMm).toBe(300);
    expect(at.regions).toHaveLength(1);
    expect(computeKey(at)).toBe(r.computedWith);
  });
  it('nicht möglich: nichts berechnet, Einstellungen fehlen, kein Foto, Foto ersetzt', () => {
    const r = project();
    r.computedWith = computeKey(r);
    expect(regenerateBlock(r, true, true)).toBeNull();
    expect(regenerateBlock(r, false, true)).toBe('not-computed');
    expect(regenerateBlock({ ...r, computedWith: undefined }, true, true)).toBe('no-key');
    expect(regenerateBlock({ ...r, computedWith: '{kaputt' }, true, true)).toBe('no-key');
    expect(regenerateBlock(r, true, false)).toBe('no-photo');
    expect(regenerateBlock({ ...r, imageRev: 'img-2' }, true, true)).toBe('photo-changed');
  });
});

describe('Übersetzungen des Pakets', () => {
  it('jeder im Code verwendete w5ue-Schlüssel existiert in DE, EN und TR', () => {
    const files = ['src/ui/project/StoneDialog.tsx', 'src/ui/project/StepPreview.tsx', 'src/ui/project/StepPlan.tsx', 'src/ui/project/HistoryControls.tsx', 'src/ui/project/useProject.ts', 'src/ui/project/StepColors.tsx'];
    const used = new Set<string>();
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/'(w5ue\.[a-zA-Z0-9.\-]+[a-zA-Z0-9])'/g)) used.add(m[1]);
    for (const b of ['photo-changed', 'no-photo', 'no-key', 'not-computed']) used.add(`w5ue.ref.block.${b}`);
    for (const e of ['failed', 'inputs', 'not-saved']) used.add(`w5ue.ref.err.${e}`);
    expect(used.size).toBeGreaterThan(30);
    const missing: string[] = [];
    for (const lang of ['de', 'en', 'tr'] as const) for (const k of used) if (!(dictionaries[lang] as Record<string, string>)[k]) missing.push(`${lang}:${k}`);
    expect(missing).toEqual([]);
  });
  it('Hinweis zum Rückgängig in Schritt 9 nennt weiter „solange das Projekt geöffnet ist – auch nach einem Schrittwechsel“', () => {
    expect((dictionaries.de as Record<string, string>)['w4lw.undoNote']).toMatch(/solange das Projekt geöffnet ist – auch nach einem Schrittwechsel/);
  });
});
