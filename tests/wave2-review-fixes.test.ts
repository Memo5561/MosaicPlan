/**
 * Nachbesserungen Welle 2 (Review): Benutzernamen der Palette, Palettenbearbeitungen als Verlust beim
 * Neuberechnen, „Änderungen verwerfen“ nach einem Fotowechsel, Sprache der Farbnamen in CSV,
 * Schutz beim Verlassen eines Projekts.
 */
import { describe, expect, it } from 'vitest';
import { hexToLab } from '../src/core/color';
import { buildCsv } from '../src/core/csv';
import { addPaletteColor, isLegacyPalette, normalizePaletteNames, resetAutoName, updatePaletteColor } from '../src/core/edits';
import { sectionsFor } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { DEFAULT_ADJUST, DEFAULT_SETTINGS, type PaletteColor } from '../src/core/types';
import { makeT, numberFormatter } from '../src/i18n';
import { keepStoredComputeFields, mergeComputeFields, paletteEditsSince, paletteSignature, type ProjectRecord } from '../src/storage/db';
import { leavesProject, projectOfHash, requestLeave, setLeaveGuard } from '../src/ui/leaveGuard';
import { lossList, recomputeLoss } from '../src/ui/project/RecomputeGuard';
import { computedMatchesPhoto, photoChangedSince, restoreComputedSettings, splitRestorable, staleReasonLabels, staleReasons } from '../src/ui/project/staleReasons';
import { buildFixedPalette, computeKey } from '../src/ui/project/useProject';
import { baseParams, sampleSetup } from './w1-mosaic-core.fixtures';

const t = makeT('de');
const n = numberFormatter('de');

function pc(hex: string, code: number, extra: Partial<PaletteColor> = {}): PaletteColor {
  const l = hexToLab(hex);
  return { code, hex, lab: [Math.round(l[0] * 100) / 100, Math.round(l[1] * 100) / 100, Math.round(l[2] * 100) / 100], name: '', ...extra };
}

function rec(patch: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    meta: { id: 'p1', name: 'Test', createdAt: 0, updatedAt: 0, computed: true },
    settings: structuredClone(DEFAULT_SETTINGS),
    adjust: structuredClone(DEFAULT_ADJUST),
    regions: [],
    palette: [pc('#112233', 1, { name: 'Dunkel' }), pc('#EEDDCC', 2, { name: 'Hell' })],
    imageRev: 'img-1',
    ...patch,
  };
}
const computed = (patch: Partial<ProjectRecord> = {}): ProjectRecord => {
  const r = rec(patch);
  return { ...r, computedWith: computeKey(r) };
};

// ================================================================ Benutzernamen

describe('eingetippte Farbnamen werden nie automatisch geändert', () => {
  it('zweimal „Rot“ für zwei automatische Rottöne bleibt „Rot“ – auch nach Öffnen und Sprachwechsel', () => {
    let p = addPaletteColor(addPaletteColor([], '#E01818', undefined, 'de'), '#C81414', undefined, 'de');
    expect(p.map((x) => x.name)).toEqual(['Rot (hell)', 'Rot (dunkel)']);
    p = updatePaletteColor(p, 0, { name: 'Rot' }, 'de');
    p = updatePaletteColor(p, 1, { name: 'Rot' }, 'de');
    expect(p.map((x) => [x.name, x.nameKey, x.userNamed])).toEqual([
      ['Rot', undefined, true],
      ['Rot', undefined, true],
    ]);
    const de = normalizePaletteNames(p, 'de');
    expect(de).toBe(p); // nichts zu tun
    const en = normalizePaletteNames(de, 'en');
    expect(en.map((x) => x.name)).toEqual(['Rot', 'Rot']);
  });

  it('nur den Zusatz entfernt („Rot (hell)“ → „Rot“): bleibt so', () => {
    let p = addPaletteColor(addPaletteColor([], '#E01818', undefined, 'de'), '#C81414', undefined, 'de');
    p = updatePaletteColor(p, 0, { name: 'Rot' }, 'de');
    const back = normalizePaletteNames(p, 'de');
    // der eingetippte Name bleibt genau; der übrige automatische Name bleibt davon unterscheidbar (nie zweimal „Rot“ durch die App)
    expect(back.map((x) => x.name)).toEqual(['Rot', 'Rot 1']);
    expect([back[0].userNamed, back[1].nameKey]).toEqual([true, 'red']);
    expect(normalizePaletteNames(back, 'en').map((x) => x.name)).toEqual(['Rot', 'Red']);
  });

  it('HEX-Änderung an einer Farbe mit Benutzernamen behält den Namen', () => {
    let p = addPaletteColor([], '#E01818', undefined, 'de');
    p = updatePaletteColor(p, 0, { name: 'Rot' }, 'de');
    p = updatePaletteColor(p, 0, { hex: '#2040C0' }, 'de');
    expect([p[0].name, p[0].nameKey, p[0].userNamed]).toEqual(['Rot', undefined, true]);
    // „leeren“ setzt wieder auf den automatischen Namen (folgt dann der Sprache)
    p = resetAutoName(p, 0, 'de');
    expect(p[0].userNamed).toBeUndefined();
    expect(p[0].nameKey).toBeTruthy();
  });

  it('Material-Verknüpfung lösen: der Materialname bleibt wörtlich', () => {
    const p = [pc('#E01818', 1, { name: 'Rot', materialId: 'm1' }), pc('#FFFFFF', 2, { name: 'Weiß', materialId: 'm2' })];
    const un = updatePaletteColor(p, 0, { materialId: undefined }, 'de');
    expect([un[0].name, un[0].materialId, un[0].userNamed]).toEqual(['Rot', undefined, true]);
    expect(normalizePaletteNames(un, 'en')[0].name).toBe('Rot');
  });

  it('ältere Projekte (vor Welle 2): automatische Namen werden genau einmal übernommen, der Rest als Benutzername markiert', () => {
    const legacy = [pc('#FF0000', 1, { name: 'Orange' }), pc('#0000FF', 2, { name: 'Blau' }), pc('#00FF00', 3, { name: 'Mein Grün' })];
    expect(isLegacyPalette(legacy)).toBe(true);
    const once = normalizePaletteNames(legacy, 'de');
    // „Orange“ war die frühere automatische Benennung von #FF0000 → korrekt „Rot“; „Blau“ entspricht NICHT der
    // früheren Benennung von #0000FF und gilt daher als eingetippt
    expect(once.map((x) => [x.name, !!x.nameKey, !!x.userNamed])).toEqual([
      ['Rot', true, false],
      [once[1].name, false, true],
      ['Mein Grün', false, true],
    ]);
    expect(isLegacyPalette(once)).toBe(false);
    expect(normalizePaletteNames(once, 'de')).toBe(once);
  });

  it('Berechnung mit eigener Palette (buildFixedPalette) behält Benutzernamen und Markierung', () => {
    let p = addPaletteColor(addPaletteColor([], '#F4F1EA', undefined, 'de'), '#1E1A18', undefined, 'de');
    p = updatePaletteColor(p, 0, { name: 'Weiß' }, 'de'); // gleich dem automatischen Namen, aber eingetippt
    const su = sampleSetup('portrait');
    const fixed = buildFixedPalette({ paletteMode: 'custom', materialIds: [] }, p, []);
    const res = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: fixed }));
    expect(res.palette.map((x) => [x.name, x.nameKey, !!x.userNamed])).toEqual([
      ['Weiß', undefined, true],
      [p[1].name, p[1].nameKey, false],
    ]);
    // auf Englisch folgt nur der automatische Name
    expect(normalizePaletteNames(res.palette, 'en').map((x) => x.name)).toEqual(['Weiß', 'Black']);
  });
});

// ================================================================ CSV in der Sprache der Oberfläche

describe('CSV: Farbnamen in der Sprache der Oberfläche', () => {
  it('automatische Namen übersetzt, Benutzernamen wörtlich', () => {
    let p = addPaletteColor(addPaletteColor([], '#F4F1EA', undefined, 'de'), '#1E1A18', undefined, 'de');
    p = updatePaletteColor(p, 1, { name: 'Mein Schwarz' }, 'de');
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: buildFixedPalette({ paletteMode: 'custom', materialIds: [] }, p, []) }));
    const secs = sectionsFor(su.layout, DEFAULT_SETTINGS);
    const names = (lang?: 'de' | 'en' | 'tr') =>
      new Set(
        buildCsv(su.layout, res.data, res.palette, [], secs, null, true, lang)
          .split('\r\n')
          .slice(1)
          .map((l) => l.split(';')[11]),
      );
    expect(names('de')).toEqual(new Set(['"Weiß"', '"Mein Schwarz"']));
    expect(names('en')).toEqual(new Set(['"White"', '"Mein Schwarz"']));
    expect(names('tr')).toEqual(new Set(['"Beyaz"', '"Mein Schwarz"']));
  });
});

// ================================================================ Palettenbearbeitungen gehen beim Neuberechnen verloren

describe('Palettenbearbeitungen seit der Berechnung (automatisch/Materialien)', () => {
  const base = [pc('#EDE8E1', 1, { name: 'Weiß', nameKey: 'white' }), pc('#E8B494', 2, { name: 'Hautton hell', nameKey: 'skin_light' }), pc('#7A4A2C', 3, { name: 'Braun', nameKey: 'brown' })];
  const sig = paletteSignature(base);

  it('zählt HEX-, Namens- und Materialänderungen sowie neue Farben exakt – nicht die Übersetzung automatischer Namen', () => {
    expect(paletteEditsSince(sig, base)).toBe(0);
    // Sprachwechsel: automatische Namen ändern sich, das ist keine Bearbeitung
    expect(paletteEditsSince(sig, normalizePaletteNames(base, 'en'))).toBe(0);
    let p = updatePaletteColor(base, 0, { hex: '#123456' }, 'de');
    p = updatePaletteColor(p, 1, { name: 'Mein Hautton' }, 'de');
    p = updatePaletteColor(p, 2, { materialId: 'm7' }, 'de');
    expect(paletteEditsSince(sig, p)).toBe(3);
    p = addPaletteColor(p, '#00FF00', undefined, 'de');
    expect(paletteEditsSince(sig, p)).toBe(4);
    // ohne Fingerabdruck (ältere Projekte) nichts behaupten
    expect(paletteEditsSince(undefined, p)).toBe(0);
  });

  it('der Fingerabdruck wird beim Übernehmen einer Berechnung gesetzt und beim Übernehmen von anderswo mitgenommen', () => {
    const r = rec({ palette: base });
    const merged = mergeComputeFields(r, { palette: base, computedWith: computeKey(r), mosaicRev: 'rev-1', updatedAt: 1 });
    expect(merged.computedPaletteSig).toEqual(sig);
    expect(merged.meta.manualEdits).toBe(0);
    const mine = { ...r, palette: updatePaletteColor(base, 0, { name: 'X' }, 'de') };
    expect(keepStoredComputeFields(mine, merged).computedPaletteSig).toEqual(sig);
  });

  it('die Rückfrage nennt bearbeitete Palettenfarben (auch ohne verlegte Steine)', () => {
    const l = recomputeLoss({ computed: true, placed: 0, total: 100, edits: 0, paletteEdits: 2, storedPlaced: 0, storedCells: 0 });
    expect(l).toEqual({ placed: 0, total: 100, edits: 0, paletteEdits: 2, stored: false });
    expect(lossList(l!, t, n)).toBe('2 bearbeitete Palettenfarben (Name, Farbton oder Material – die Palette wird neu erstellt)');
    expect(lossList({ placed: 40, total: 219782, edits: 0, paletteEdits: 0, stored: false }, t, n)).toBe('40 als verlegt markierte Steine (< 0,1 % des Mosaiks)');
    expect(lossList({ placed: 3, total: 100, edits: 1, paletteEdits: 1, stored: false }, t, n)).toBe(
      '3 als verlegt markierte Steine (3 % des Mosaiks), 1 manuelle Änderung am Mosaik (z. B. Steinfarbe, Steinform, Umstellung beim Entfernen einer Farbe) und 1 bearbeitete Palettenfarbe (Name, Farbton oder Material – die Palette wird neu erstellt)',
    );
  });
});

// ================================================================ „Änderungen verwerfen“ nach einem Fotowechsel

describe('Änderungen verwerfen nach „Foto ersetzen“', () => {
  const face = { id: 'face', type: 'face' as const, shape: 'ellipse' as const, x: 0.27, y: 0.25, w: 0.46, h: 0.5 };
  /** berechnet mit Zuschnitt, Drehung, Spiegeln, Helligkeit und Gesichtsbereich */
  const before = computed({ adjust: { ...DEFAULT_ADJUST, crop: { x: 0.2, y: 0.1, w: 0.5, h: 0.7 }, rotation: 270, flipH: true, brightness: 5 }, regions: [face] });
  /** wie setPhoto: neue Foto-Identität, Zuschnitt/Drehung/Spiegeln zurückgesetzt, Bereiche gelöscht; dazu Helligkeit geändert */
  const replaced: ProjectRecord = { ...before, imageRev: 'img-2', adjust: { ...before.adjust, crop: null, rotation: 0, fineRotate: 0, flipH: false, brightness: 20 }, regions: [] };

  it('nur die fotounabhängigen Einstellungen gelten als wiederherstellbar', () => {
    const reasons = staleReasons(replaced.computedWith, computeKey(replaced));
    expect(reasons.map((r) => r.group)).toEqual(['adjust', 'regions', 'photo']);
    const { restorable, notRestorable } = splitRestorable(reasons);
    expect(restorable).toEqual([{ group: 'adjust', fields: ['brightness'] }]);
    expect(notRestorable).toEqual([{ group: 'adjust', fields: ['crop', 'rotation', 'flipH'] }, { group: 'regions' }, { group: 'photo' }]);
    expect(photoChangedSince(replaced)).toBe(true);
  });

  it('Bereiche und Zuschnitt/Drehung des alten Fotos landen nie auf dem neuen Foto', () => {
    const back = restoreComputedSettings(replaced)!;
    expect(back.imageRev).toBe('img-2');
    expect(back.regions).toEqual([]);
    expect(back.adjust.crop).toBeNull();
    expect(back.adjust.rotation).toBe(0);
    expect(back.adjust.flipH).toBe(false);
    expect(back.adjust.brightness).toBe(5); // wiederhergestellt
    const left = splitRestorable(staleReasons(back.computedWith, computeKey(back)));
    expect(left.restorable).toEqual([]);
    expect(left.notRestorable.map((r) => r.group)).toEqual(['adjust', 'regions', 'photo']);
  });

  it('ohne Fotowechsel wird weiterhin alles wiederhergestellt', () => {
    const changed: ProjectRecord = { ...before, adjust: { ...before.adjust, rotation: 90 }, regions: [] };
    const back = restoreComputedSettings(changed)!;
    expect(computeKey(back)).toBe(before.computedWith);
    expect(splitRestorable(staleReasons(changed.computedWith, computeKey(changed))).notRestorable).toEqual([]);
  });

  it('Hinweis nennt die Werte, auf die zurückgesetzt wird', () => {
    const r = computed({ settings: { ...DEFAULT_SETTINGS, tileW: 5, tileH: 5, joint: 1 } });
    const ch = { ...r, settings: { ...r.settings, tileW: 11, tileH: 11, joint: 2 } };
    const reasons = staleReasons(r.computedWith, computeKey(ch));
    expect(staleReasonLabels(reasons, t, n)).toEqual(['Steingröße 5 × 5 → 11 × 11 mm', 'Fuge 1 → 2 mm']);
    expect(staleReasonLabels(reasons, t, n, { target: 'from' })).toEqual(['Steingröße 5 × 5 mm', 'Fuge 1 mm']);
    expect(t('w2ws.stale.discardHint', { list: staleReasonLabels(reasons, t, n, { target: 'from' }).join(', ') })).toBe('Setzt zurück auf die Werte der letzten Berechnung: Steingröße 5 × 5 mm, Fuge 1 mm.');
  });
});

// ================================================================ Fernwirkung: berechnetes Mosaik passt zum Foto?

describe('Fernwirkung des berechneten Mosaiks nur mit dessen Foto', () => {
  it('gleiches Foto und gleiche Bildeinstellungen → ja; anderes Foto, Zuschnitt oder Helligkeit → nein', () => {
    const r = computed({ adjust: { ...DEFAULT_ADJUST, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } } });
    expect(computedMatchesPhoto(r)).toBe(true);
    // Reihenfolge der Felder spielt keine Rolle
    expect(computedMatchesPhoto({ ...r, adjust: Object.fromEntries(Object.entries(r.adjust).reverse()) as ProjectRecord['adjust'] })).toBe(true);
    expect(computedMatchesPhoto({ ...r, imageRev: 'img-2' })).toBe(false);
    expect(computedMatchesPhoto({ ...r, adjust: { ...r.adjust, crop: null } })).toBe(false);
    expect(computedMatchesPhoto({ ...r, adjust: { ...r.adjust, brightness: 10 } })).toBe(false);
    // Bereiche ändern das Foto nicht
    const withRegion: ProjectRecord = { ...r, regions: [{ id: 'x', type: 'detail', shape: 'rect', x: 0, y: 0, w: 0.1, h: 0.1 }] };
    expect(computedMatchesPhoto(withRegion)).toBe(true);
    expect(computedMatchesPhoto({ ...r, computedWith: undefined })).toBe(false);
  });
});

// ================================================================ Verlassen eines Projekts

describe('Schutz beim Verlassen eines Projekts', () => {
  it('erkennt das Verlassen der Projektansicht (nicht den Schrittwechsel)', () => {
    expect(projectOfHash('#/project/abc/colors')).toBe('abc');
    expect(projectOfHash('#/projects')).toBeNull();
    expect(leavesProject('#/project/abc/colors', '#/project/abc/plan')).toBe(false);
    expect(leavesProject('#/project/abc/colors', '#/projects')).toBe(true);
    expect(leavesProject('#/project/abc', '#/project/xyz')).toBe(true);
    expect(leavesProject('#/projects', '#/')).toBe(false);
  });

  it('ohne Prüffunktion sofort, mit Prüffunktion erst nach deren Freigabe', () => {
    expect(requestLeave(() => {})).toBe(true);
    let held: (() => void) | null = null;
    const off = setLeaveGuard((proceed) => {
      held = proceed;
      return false;
    });
    let left = false;
    expect(requestLeave(() => (left = true))).toBe(false);
    expect(left).toBe(false);
    held!();
    expect(left).toBe(true);
    off();
    expect(requestLeave(() => {})).toBe(true);
  });
});
