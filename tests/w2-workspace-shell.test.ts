import { describe, expect, it } from 'vitest';
import { DEFAULT_ADJUST, DEFAULT_SETTINGS } from '../src/core/types';
import { dictionaries, makeT, numberFormatter } from '../src/i18n';
import type { ProjectRecord } from '../src/storage/db';
import { lossList, recomputeLoss } from '../src/ui/project/RecomputeGuard';
import { computedDeltaE, deltaERating, isRestorable, restoreComputedSettings, staleReasonLabels, staleReasons } from '../src/ui/project/staleReasons';
import { centeredScrollLeft, isStep, lastStepOf, rememberStep, resumeStep, STEPS, stepFromHash, stepHash, stepStates, type StepStore } from '../src/ui/project/stepNav';
import { computeKey } from '../src/ui/project/useProject';

function rec(patch: Partial<ProjectRecord> = {}): ProjectRecord {
  const base: ProjectRecord = {
    meta: { id: 'p1', name: 'Test', createdAt: 0, updatedAt: 0, computed: true },
    settings: structuredClone(DEFAULT_SETTINGS),
    adjust: structuredClone(DEFAULT_ADJUST),
    regions: [],
    palette: [
      { hex: '#112233', lab: [10, 0, -10], name: 'Dunkel', code: 1 },
      { hex: '#EEDDCC', lab: [90, 2, 8], name: 'Hell', code: 2 },
    ] as ProjectRecord['palette'],
    imageRev: 'img-1',
  };
  const r = { ...base, ...patch };
  return r;
}
/** Projekt, das „mit den aktuellen Einstellungen berechnet“ ist */
function computed(patch: Partial<ProjectRecord> = {}): ProjectRecord {
  const r = rec(patch);
  return { ...r, computedWith: computeKey(r) };
}
const t = makeT('de');
const n = numberFormatter('de');

describe('Schritt-Route', () => {
  it('erkennt nur gültige Schritte dieses Projekts', () => {
    expect(STEPS).toHaveLength(10);
    expect(isStep('plan')).toBe(true);
    expect(isStep('foo')).toBe(false);
    expect(isStep(undefined)).toBe(false);
    expect(stepHash('abc', 'colors')).toBe('#/project/abc/colors');
    expect(stepFromHash('#/project/abc/colors', 'abc')).toBe('colors');
    expect(stepFromHash('#/project/abc', 'abc')).toBeUndefined();
    expect(stepFromHash('#/project/abc/foo', 'abc')).toBeUndefined();
    expect(stepFromHash('#/project/xyz/colors', 'abc')).toBeUndefined();
    expect(stepFromHash('#/projects', 'abc')).toBeUndefined();
    expect(stepFromHash('', 'abc')).toBeUndefined();
  });

  it('Öffnen ohne Schritt: Verlegeplan bei verlegten Steinen, sonst Vorschau; unberechnet der letzte Einstellungsschritt', () => {
    expect(resumeStep({ computed: true, placed: 1526 })).toBe('plan');
    expect(resumeStep({ computed: true, placed: 0 })).toBe('preview');
    expect(resumeStep({ computed: true, placed: 0, lastStep: 'colors' })).toBe('preview');
    expect(resumeStep({ computed: false, placed: 0 })).toBe('photo');
    expect(resumeStep({ computed: false, placed: 0, lastStep: 'colors' })).toBe('colors');
    // ohne Ergebnis nie auf einen leeren Ergebnisschritt
    expect(resumeStep({ computed: false, placed: 0, lastStep: 'plan' })).toBe('photo');
    expect(resumeStep({ computed: false, placed: 0, lastStep: 'bogus' })).toBe('photo');
  });

  it('Status je Schritt nur aus bekannten Zuständen', () => {
    const none = stepStates({ hasPhoto: false, computed: false, stale: false });
    expect(Object.values(none).some((s) => s.done || s.warn)).toBe(false);
    expect(['preview', 'plan', 'pdf'].every((s) => none[s as keyof typeof none].unavailable)).toBe(true);
    expect(none.compute.unavailable).toBe(false);

    const ok = stepStates({ hasPhoto: true, computed: true, stale: false });
    expect(STEPS.filter((s) => ok[s].done)).toEqual(['photo', 'compute', 'preview', 'plan']);
    expect(STEPS.some((s) => ok[s].warn || ok[s].unavailable)).toBe(false);

    const stale = stepStates({ hasPhoto: true, computed: true, stale: true });
    expect(STEPS.filter((s) => stale[s].done)).toEqual(['photo']);
    expect(STEPS.filter((s) => stale[s].warn)).toEqual(['compute', 'preview', 'plan', 'pdf']);
  });

  it('aktiver Schritt mittig in der Schrittleiste, begrenzt auf den Scrollbereich', () => {
    // Leiste 300 px breit, Inhalt 900 px, Chip bei 700 px (sichtbar bei 700 − 0), 100 px breit
    expect(centeredScrollLeft({ scrollLeft: 0, scrollWidth: 900, clientWidth: 300, barLeft: 0, chipLeft: 700, chipWidth: 100 })).toBe(600);
    expect(centeredScrollLeft({ scrollLeft: 0, scrollWidth: 900, clientWidth: 300, barLeft: 0, chipLeft: 500, chipWidth: 100 })).toBe(400);
    expect(centeredScrollLeft({ scrollLeft: 400, scrollWidth: 900, clientWidth: 300, barLeft: 0, chipLeft: 10, chipWidth: 100 })).toBe(310);
    expect(centeredScrollLeft({ scrollLeft: 200, scrollWidth: 900, clientWidth: 300, barLeft: 20, chipLeft: 30, chipWidth: 100 })).toBe(110);
    expect(centeredScrollLeft({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300, barLeft: 0, chipLeft: 200, chipWidth: 100 })).toBe(0);
  });

  it('letzter Schritt je Projekt (nur Komfort): übersteht kaputte Daten und gesperrten Speicher', () => {
    const mem = new Map<string, string>();
    const store: StepStore = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) };
    expect(lastStepOf('a', store)).toBeNull();
    rememberStep('a', 'colors', store);
    rememberStep('b', 'joint', store);
    expect(lastStepOf('a', store)).toBe('colors');
    expect(lastStepOf('b', store)).toBe('joint');
    for (let i = 0; i < 60; i++) rememberStep(`x${i}`, 'size', store);
    const map = JSON.parse(mem.get('mosaicplan.lastStep')!);
    expect(Object.keys(map)).toHaveLength(50);
    expect(lastStepOf('a', store)).toBeNull(); // älteste verdrängt
    mem.set('mosaicplan.lastStep', '{kaputt');
    expect(lastStepOf('x59', store)).toBeNull();
    const throwing: StepStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => rememberStep('a', 'plan', throwing)).not.toThrow();
    expect(lastStepOf('a', throwing)).toBeNull();
    expect(lastStepOf('a', null)).toBeNull();
  });
});

describe('Was hat sich seit der Berechnung geändert?', () => {
  it('nichts geändert → keine Gründe', () => {
    const r = computed();
    expect(staleReasons(r.computedWith, computeKey(r))).toEqual([]);
  });

  it('Fuge, Größe, Steingröße mit alten und neuen Werten', () => {
    const r = computed();
    const changed = { ...r, settings: { ...r.settings, joint: 2, widthMm: 600, tileW: 5, tileH: 5 } };
    const rs = staleReasons(r.computedWith, computeKey(changed));
    expect(rs.map((x) => x.group)).toEqual(['size', 'tile', 'joint']);
    expect(rs[2]).toEqual({ group: 'joint', from: 1, to: 2 });
    expect(staleReasonLabels(rs, t, n)).toEqual(['Bildgröße 30 × 40 → 60 × 40 cm', 'Steingröße 8 × 8 → 5 × 5 mm', 'Fuge 1 → 2 mm']);
  });

  it('Fotobearbeitung nennt die geänderten Regler', () => {
    const r = computed();
    const changed = { ...r, adjust: { ...r.adjust, brightness: r.adjust.brightness + 1, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } } };
    const rs = staleReasons(r.computedWith, computeKey(changed));
    expect(rs).toEqual([{ group: 'adjust', fields: ['crop', 'brightness'] }]);
    expect(staleReasonLabels(rs, t, n)).toEqual(['Fotobearbeitung (Zuschnitt, Helligkeit)']);
  });

  it('Farben, ΔE-Formel, Mischung, Formen, Bereiche, Foto', () => {
    const r = computed();
    const changed: ProjectRecord = {
      ...r,
      settings: { ...r.settings, colorCount: 8, deltaE: '76', dither: 0.4, shapes: { ...r.settings.shapes, diagonal: !r.settings.shapes.diagonal } },
      regions: [{ id: 'g', type: 'face', shape: 'ellipse', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
      imageRev: 'img-2',
    };
    const rs = staleReasons(r.computedWith, computeKey(changed));
    expect(rs.map((x) => x.group)).toEqual(['shapes', 'colorCount', 'dither', 'deltaE', 'regions', 'photo']);
    // Ausgangswert = Standard-Farbmischung neuer Projekte (seit w3-colour-quality 50 %)
    expect(staleReasonLabels(rs, t, n)).toEqual(['Steinformen', 'Farbanzahl 24 → 8', `Farbmischung ${DEFAULT_SETTINGS.dither * 100} → 40 %`, 'Farbabstand (ΔE-Formel) CIEDE2000 → CIE76', 'Gesichts-/Detailbereiche', 'Foto ersetzt']);
    expect(rs.filter((x) => !isRestorable(x)).map((x) => x.group)).toEqual(['photo']);
  });

  it('eigene Palette und Materialauswahl', () => {
    const r = computed({ settings: { ...DEFAULT_SETTINGS, paletteMode: 'custom' } });
    const more = { ...r, palette: [...r.palette, { hex: '#FF0000', lab: [53, 80, 67], name: 'Rot', code: 3 }] as ProjectRecord['palette'] };
    expect(staleReasons(r.computedWith, computeKey(more)).map((x) => x.group)).toEqual(['customPalette']);
    const m = computed({ settings: { ...DEFAULT_SETTINGS, paletteMode: 'materials', materialIds: ['m1'] } });
    const m2 = { ...m, settings: { ...m.settings, materialIds: ['m1', 'm2'] } };
    expect(staleReasons(m.computedWith, computeKey(m2)).map((x) => x.group)).toEqual(['materials']);
  });

  it('unlesbarer oder fehlender Schlüssel → „sonstige Einstellungen“ (der Stand ist trotzdem veraltet)', () => {
    const r = rec();
    expect(staleReasons('{kaputt', computeKey(r))).toEqual([{ group: 'other' }]);
    expect(staleReasons(undefined, computeKey(r))).toEqual([{ group: 'other' }]);
    expect(staleReasonLabels([{ group: 'other' }], t, n)).toEqual(['sonstige Einstellungen']);
  });

  it('älterer Schlüssel ohne Foto-Identität: neues Foto zählt als „Foto ersetzt“', () => {
    const legacy = computed({ imageRev: undefined });
    const now = { ...legacy, imageRev: 'neu' };
    expect(staleReasons(legacy.computedWith, computeKey(now)).map((x) => x.group)).toEqual(['photo']);
  });
});

describe('Änderungen verwerfen', () => {
  it('stellt die berechneten Einstellungen exakt wieder her – danach ist der Stand wieder aktuell', () => {
    const r = computed({ regions: [{ id: 'f', type: 'face', shape: 'rect', x: 0.2, y: 0.2, w: 0.3, h: 0.3 }] });
    const changed: ProjectRecord = {
      ...r,
      settings: { ...r.settings, joint: 3, tileW: 6, tileH: 6, colorCount: 12, deltaE: '76', dither: 0.3, edgeMode: 'whole', shapes: { ...r.settings.shapes, line: !r.settings.shapes.line }, groutHex: '#000000' },
      adjust: { ...r.adjust, brightness: 7, rotation: 90 },
      regions: [],
      meta: { ...r.meta, name: 'Umbenannt' },
    };
    expect(computeKey(changed)).not.toBe(r.computedWith);
    const back = restoreComputedSettings(changed)!;
    expect(computeKey(back)).toBe(r.computedWith);
    // nicht berechnungsrelevante Felder bleiben unberührt
    expect(back.meta.name).toBe('Umbenannt');
    expect(back.settings.groutHex).toBe('#000000');
    expect(back.regions).toEqual(r.regions);
  });

  it('Foto und eigene Palette bleiben – sie sind danach die einzigen Gründe', () => {
    const r = computed({ settings: { ...DEFAULT_SETTINGS, paletteMode: 'custom' } });
    const changed: ProjectRecord = { ...r, imageRev: 'img-2', settings: { ...r.settings, joint: 2 }, palette: [...r.palette].reverse() };
    const back = restoreComputedSettings(changed)!;
    expect(back.imageRev).toBe('img-2');
    expect(back.palette).toBe(changed.palette);
    expect(staleReasons(r.computedWith, computeKey(back)).map((x) => x.group)).toEqual(['customPalette', 'photo']);
  });

  it('Materialauswahl nur in Material-Modi; neuere Formoptionen bleiben bei älterem Schlüssel', () => {
    const r = computed();
    const changed = { ...r, settings: { ...r.settings, materialIds: ['x'] } };
    // im Modus „automatisch“ ohne Bedeutung → bleibt
    expect(restoreComputedSettings(changed)!.settings.materialIds).toEqual(['x']);
    const key = JSON.parse(r.computedWith!);
    delete key.sh.minPieceMm;
    const legacy = { ...r, computedWith: JSON.stringify(key), settings: { ...r.settings, shapes: { ...r.settings.shapes, minPieceMm: 3 } } };
    expect(restoreComputedSettings(legacy)!.settings.shapes.minPieceMm).toBe(3);
    expect(restoreComputedSettings({ ...r, computedWith: undefined })).toBeNull();
  });
});

describe('Farbabweichung: Einstufung', () => {
  it('Schwellen wie im Hinweistext (< 2 · 2–5 · > 5)', () => {
    expect(deltaERating(0)).toBe('low');
    expect(deltaERating(1.99)).toBe('low');
    expect(deltaERating(2)).toBe('mid');
    expect(deltaERating(5)).toBe('mid');
    expect(deltaERating(5.01)).toBe('high');
    expect(deltaERating(Number.NaN)).toBeNull();
  });
  it('Formel des berechneten Ergebnisses, nicht der aktuellen Einstellung', () => {
    const r = computed({ settings: { ...DEFAULT_SETTINGS, deltaE: '76' } });
    expect(computedDeltaE(r.computedWith)).toBe('76');
    expect(computedDeltaE(computed().computedWith)).toBe('2000');
    expect(computedDeltaE(undefined)).toBeNull();
  });
});

describe('Rückfrage vor dem Neuberechnen', () => {
  it('fragt nur, wenn verlegte Steine oder manuelle Änderungen verloren gehen', () => {
    expect(recomputeLoss({ computed: true, placed: 0, total: 5950, edits: 0, storedPlaced: 0, storedCells: 0 })).toBeNull();
    expect(recomputeLoss({ computed: true, placed: 1526, total: 5950, edits: 0, storedPlaced: 0, storedCells: 0 })).toEqual({ placed: 1526, total: 5950, edits: 0, paletteEdits: 0, stored: false });
    expect(recomputeLoss({ computed: true, placed: 0, total: 5950, edits: 2, storedPlaced: 0, storedCells: 0 })).toEqual({ placed: 0, total: 5950, edits: 2, paletteEdits: 0, stored: false });
    // nicht angezeigtes gespeichertes Mosaik (Integritätsfehler) mit Fortschritt
    expect(recomputeLoss({ computed: false, placed: 0, total: 0, edits: 0, storedPlaced: 12, storedCells: 400 })).toEqual({ placed: 12, total: 0, edits: 0, paletteEdits: 0, stored: true });
    expect(recomputeLoss({ computed: false, placed: 0, total: 0, edits: 0, storedPlaced: 0, storedCells: 400 })).toBeNull();
  });

  it('nennt exakte Zahlen, Einzahl und Mehrzahl', () => {
    expect(lossList({ placed: 1526, total: 5952, edits: 3, paletteEdits: 0, stored: false }, t, n)).toBe(
      '1.526 als verlegt markierte Steine (25,6 % des Mosaiks) und 3 manuelle Änderungen am Mosaik (z. B. Steinfarbe, Steinform, Umstellung beim Entfernen einer Farbe)',
    );
    expect(lossList({ placed: 1, total: 4, edits: 0, paletteEdits: 0, stored: false }, t, n)).toBe('1 als verlegt markierter Stein (25 % des Mosaiks)');
    expect(lossList({ placed: 0, total: 4, edits: 1, paletteEdits: 0, stored: false }, t, n)).toBe('1 manuelle Änderung am Mosaik (z. B. Steinfarbe, Steinform, Umstellung beim Entfernen einer Farbe)');
    expect(lossList({ placed: 12, total: 0, edits: 0, paletteEdits: 0, stored: true }, t, n)).toBe('12 als verlegt markierte Steine');
    const en = makeT('en');
    expect(lossList({ placed: 1526, total: 5952, edits: 3, paletteEdits: 0, stored: false }, en, numberFormatter('en'))).toBe(
      '1,526 stones marked as laid (25.6 % of the mosaic) and 3 manual changes to the mosaic (e.g. stone colour, stone shape, reassignment when a colour was removed)',
    );
  });
});

describe('Texte', () => {
  it('alle neuen Schlüssel in DE, EN und TR', () => {
    const keys = Object.keys(dictionaries.de).filter((k) => k.startsWith('w2ws.'));
    expect(keys.length).toBeGreaterThan(80);
    for (const lang of ['en', 'tr'] as const) for (const k of keys) expect((dictionaries[lang] as Record<string, string>)[k], `${lang}:${k}`).toBeTruthy();
    expect(dictionaries.de['project.stale' as keyof typeof dictionaries.de]).toBe('Einstellungen geändert');
  });
});
