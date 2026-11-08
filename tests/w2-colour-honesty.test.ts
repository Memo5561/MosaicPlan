/**
 * w2-colour-honesty:
 *  1. Farbnamen: nächste Referenzfarbe (Rot heißt Rot), alle Schlüssel in DE/EN/TR, eindeutige automatische Namen,
 *     Material- und Benutzernamen bleiben, HEX-Änderung benennt automatische Farben um, ältere Projekte.
 *  2. Exakter Farbzuordner: nearestExact = Vergleich mit jeder Farbe (auch 64/200 Farben), Entfernen einer Farbe.
 *  3. Ehrliche Kennzahlen: matchDeltaE je Farbe (Summe = Steine gesamt), angefordert/verwendet, zusammengelegt.
 */
import { describe, expect, it } from 'vitest';
import { deltaE, deltaE2000, describeColor, hexToLab, labToHex, NearestColorMatcher, rgbToHex, rgbToLab, type ColorNameLang, type Lab } from '../src/core/color';
import {
  ACHROMATIC_CHROMA,
  colorNameAnchors,
  COLOR_NAMES,
  formatAutoName,
  inferAutoName,
  legacyDescribeColor,
  nameKeyFor,
  paletteDisplayName,
  uniqueAutoNames,
} from '../src/core/colorNames';
import { addPaletteColor, isAutoNamed, matchDeltaEValid, nearestOtherColor, normalizePaletteNames, removePaletteColor, resetAutoName, updatePaletteColor } from '../src/core/edits';
import { imageToLab, computeMosaic, type FixedColor } from '../src/core/mosaic';
import { kmeansLab } from '../src/core/kmeans';
import { computeStats } from '../src/core/stats';
import { piecesPerColor } from '../src/core/paletteOps';
import { CellKind, createEmptyMosaic, type PaletteColor } from '../src/core/types';
import { loadPng } from './helpers';
import { baseParams, customFixed, GOLDEN_SAMPLES, MATERIALS12, materialFixed, sampleSetup } from './w1-mosaic-core.fixtures';

const LANGS: ColorNameLang[] = ['de', 'en', 'tr'];
const STATS_OPTS = { reservePct: 0, groutDepthMm: 3 };
const name = (hex: string, lang: ColorNameLang = 'de') => describeColor(hexToLab(hex), lang);

/** Deterministischer Zufall (mulberry32) */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randLab = (r: () => number): Lab => rgbToLab(Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256));

function bruteForce(pal: Lab[], l: Lab, formula: '2000' | '76' = '2000', skip = -1): number {
  let best = -1;
  let bd = Infinity;
  pal.forEach((c, i) => {
    if (i === skip) return;
    const d = deltaE(formula, l, c);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

function pc(hex: string, code: number, extra: Partial<PaletteColor> = {}): PaletteColor {
  const l = hexToLab(hex);
  return { code, hex, lab: [Math.round(l[0] * 100) / 100, Math.round(l[1] * 100) / 100, Math.round(l[2] * 100) / 100], name: '', ...extra };
}

// ================================================================ 1. Farbnamen

describe('Farbnamen: nächste Referenzfarbe statt falscher Farbtongrenzen', () => {
  it('Rot heißt Rot, Blau heißt Blau … (Abnahmekriterien)', () => {
    expect(name('#FF0000')).toBe('Rot');
    expect(name('#CC0000')).toBe('Rot');
    expect(['Dunkelrot', 'Weinrot']).toContain(name('#8B0000'));
    expect(name('#0000FF')).toBe('Blau');
    expect(['Marineblau', 'Dunkelblau']).toContain(name('#000080'));
    expect(name('#FFFF00')).toBe('Gelb');
    expect(name('#FFA500')).toBe('Orange');
    expect(name('#808000')).toBe('Oliv');
    expect(name('#FFFFFF')).toBe('Weiß');
    expect(name('#000000')).toBe('Schwarz');
    expect(name('#9fc5f8')).toBe('Hellblau');
  });

  it('weitere Bezugsfarben (Familien)', () => {
    expect(name('#FF8000')).toBe('Orange');
    expect(name('#008000')).toBe('Grün');
    expect(['Türkis', 'Helltürkis']).toContain(name('#00FFFF'));
    expect(name('#8000FF')).toBe('Violett');
    expect(name('#FF00FF')).toBe('Magenta');
    expect(['Braun', 'Rostbraun']).toContain(name('#8B4513'));
    expect(name('#4169E1')).toMatch(/blau/i);
    expect(['Weinrot', 'Karminrot', 'Dunkelrot']).toContain(name('#841929'));
    expect(name('#808080')).toBe('Grau');
  });

  it('dieselben Farben in EN und TR', () => {
    expect(name('#FF0000', 'en')).toBe('Red');
    expect(name('#0000FF', 'en')).toBe('Blue');
    expect(name('#FFFF00', 'en')).toBe('Yellow');
    expect(name('#FF0000', 'tr')).toBe('Kırmızı');
    expect(name('#0000FF', 'tr')).toBe('Mavi');
    expect(name('#FFFF00', 'tr')).toBe('Sarı');
    expect(name('#FFFFFF', 'tr')).toBe('Beyaz');
  });

  it('unbunte Farben (C* < 6) heißen nur nach Helligkeit – nie mit Farbstich', () => {
    const grey = ['white', 'cream', 'lightgray', 'gray', 'darkgray', 'anthracite', 'black'];
    for (let L = 0; L <= 100; L += 2.5)
      for (const [a, b] of [
        [0, 0],
        [3, -3],
        [-4, 2],
        [2, 5],
      ]) {
        expect(Math.hypot(a, b)).toBeLessThan(ACHROMATIC_CHROMA);
        expect(grey).toContain(nameKeyFor([L, a, b]));
      }
  });

  it('jeder Schlüssel hat DE/EN/TR, Namen je Sprache eindeutig, mit Zusatz höchstens 22 Zeichen', () => {
    for (const lang of LANGS) {
      const all = Object.values(COLOR_NAMES).map((e) => e[lang]);
      expect(all.every((s) => typeof s === 'string' && s.trim().length > 0)).toBe(true);
      expect(new Set(all.map((s) => s.toLocaleLowerCase())).size).toBe(all.length);
      // Namen mit Helligkeitswort werden nur nummeriert (uniqueAutoNames), die übrigen auch „(hell)“ usw.
      for (const key of Object.keys(COLOR_NAMES))
        for (const suffix of COLOR_NAMES[key].toned ? ([undefined, 99] as const) : ([undefined, 'light', 'medium', 'dark', 99] as const))
          expect((formatAutoName(key, suffix, lang) as string).length, `${lang} ${key} ${suffix}`).toBeLessThanOrEqual(22);
    }
    // jeder Anker verweist auf einen bekannten Schlüssel, jeder bunte Schlüssel hat einen Anker
    const anchors = colorNameAnchors();
    for (const a of anchors) expect(COLOR_NAMES[a.key], a.key).toBeDefined();
    for (const key of Object.keys(COLOR_NAMES)) expect(anchors.some((a) => a.key === key), key).toBe(true);
  });

  it('jeder Anker wird mit seinem eigenen Namen benannt (keine Anker sind verdeckt)', () => {
    for (const a of colorNameAnchors()) {
      const l = hexToLab(a.hex);
      if (Math.hypot(l[1], l[2]) < ACHROMATIC_CHROMA) continue; // unbunt: nach Helligkeit
      expect(nameKeyFor(l), a.hex).toBe(a.key);
    }
  });

  it('describeColor behält die Signatur (Lab, Sprache) und ist deterministisch', () => {
    const l = hexToLab('#C04040');
    expect(describeColor(l)).toBe(describeColor(l, 'de'));
    expect(LANGS.map((g) => describeColor(l, g))).toEqual(LANGS.map((g) => formatAutoName(nameKeyFor(l), undefined, g)));
  });
});

describe('Eindeutige automatische Namen', () => {
  for (const s of GOLDEN_SAMPLES)
    for (const n of [16, 24, 32])
      it(`${s.key}, ${n} Farben: alle automatischen Namen eindeutig (DE/EN/TR), Materialnamen unverändert`, () => {
        const su = sampleSetup(s.key);
        const res = computeMosaic(su.img, baseParams(su, { colorCount: n }));
        expect(res.palette.every((p) => !!p.nameKey)).toBe(true);
        for (const lang of LANGS) {
          const names = res.palette.map((p) => paletteDisplayName(p, lang));
          expect(new Set(names).size).toBe(names.length);
        }
        // gespeicherter Name = Anzeigename in der Berechnungssprache
        expect(res.palette.map((p) => p.name)).toEqual(res.palette.map((p) => paletteDisplayName(p, 'de')));
      });

  it('„Nur eigene Materialien“: Materialnamen bleiben genau so', () => {
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su, { paletteMode: 'materials', fixedPalette: materialFixed(MATERIALS12) }));
    const byId = new Map(MATERIALS12.map((m) => [m.id, m.colorName]));
    for (const p of res.palette) {
      expect(p.nameKey).toBeUndefined();
      expect(p.name).toBe(byId.get(p.materialId!));
    }
  });

  it('hell/mittel/dunkel nur bei deutlich verschiedener Helligkeit, sonst Nummern; Benutzernamen bleiben und werden nicht doppelt vergeben', () => {
    const mk = (hex: string, code: number) => pc(hex, code, { nameKey: 'red', name: '' });
    const a = uniqueAutoNames([mk('#E01818', 1), mk('#B81414', 2)], 'de');
    expect(a.map((p) => p.name)).toEqual(['Rot (hell)', 'Rot (dunkel)']);
    expect(a.map((p) => paletteDisplayName(p, 'en'))).toEqual(['Red (light)', 'Red (dark)']);
    expect(a.map((p) => paletteDisplayName(p, 'tr'))).toEqual(['Kırmızı (açık)', 'Kırmızı (koyu)']);
    // Reihenfolge der Palette egal – die hellere heißt „hell“
    const b = uniqueAutoNames([mk('#B81414', 1), mk('#E01818', 2), mk('#D01616', 3)], 'de');
    expect(b.map((p) => p.name)).toEqual(['Rot (dunkel)', 'Rot (hell)', 'Rot (mittel)']);
    // fast gleich hell → Nummern statt irreführender Helligkeitswörter
    const c = uniqueAutoNames([mk('#D81E1E', 1), mk('#D02424', 2)], 'de');
    expect(c.map((p) => p.name)).toEqual(['Rot 1', 'Rot 2']);
    // Benutzer hat „Rot“ vergeben → automatische Farbe weicht aus
    const d = uniqueAutoNames([{ ...pc('#FF0000', 1), name: 'Rot' }, mk('#E01818', 2)], 'de');
    expect(d[0].name).toBe('Rot');
    expect(d[1].name).toBe('Rot 1');
    // Namen mit Helligkeitswort (Hellblau …) werden nummeriert
    const e = uniqueAutoNames([pc('#A4C8F0', 1, { nameKey: 'lightblue' }), pc('#90B8E0', 2, { nameKey: 'lightblue' })], 'de');
    expect(e.map((p) => p.name)).toEqual(['Hellblau 1', 'Hellblau 2']);
    // nichts zu tun → dasselbe Array
    expect(uniqueAutoNames(a, 'de')).toBe(a);
  });
});

describe('Namen beim Bearbeiten', () => {
  it('addPaletteColor: automatischer Name mit Schlüssel, gleichnamige Farben werden unterscheidbar', () => {
    let p = addPaletteColor([], '#FF0000', undefined, 'de');
    expect(p[0]).toMatchObject({ name: 'Rot', nameKey: 'red' });
    p = addPaletteColor(p, '#C41E24', undefined, 'de');
    expect(new Set(p.map((x) => x.name)).size).toBe(2);
    expect(p.map((x) => x.name)).toEqual(['Rot (hell)', 'Rot (dunkel)']);
    // übergebener Name (Material, Benutzer) bleibt genau so, ohne Schlüssel
    p = addPaletteColor(p, '#D81E1E', 'Rot', 'de', 'm1');
    expect(p[2]).toMatchObject({ name: 'Rot', materialId: 'm1' });
    expect(p[2].nameKey).toBeUndefined();
    expect(p.slice(0, 2).map((x) => x.name)).toEqual(['Rot (hell)', 'Rot (dunkel)']);
  });

  it('HEX-Änderung benennt automatische Farben um, Benutzer- und Materialnamen nicht', () => {
    let p = addPaletteColor([], '#FF0000', undefined, 'de');
    p = addPaletteColor(p, '#0000FF', 'Mein Blau', 'de');
    p = addPaletteColor(p, '#00A000', 'Glas Grün 12', 'de', 'mat-1');
    p = updatePaletteColor(p, 0, { hex: '#0000FF' }, 'de');
    expect(p[0]).toMatchObject({ name: 'Blau', nameKey: 'blue', hex: '#0000FF' });
    p = updatePaletteColor(p, 1, { hex: '#FF0000' }, 'de');
    expect(p[1].name).toBe('Mein Blau');
    expect(p[1].nameKey).toBeUndefined();
    p = updatePaletteColor(p, 2, { hex: '#FFFF00' }, 'de');
    expect(p[2].name).toBe('Glas Grün 12');
    // Material-Wechsel ändert den Namen nicht, ein eingegebener Name macht ihn zum Benutzernamen
    p = updatePaletteColor(p, 0, { materialId: 'mat-2' }, 'de');
    expect(p[0]).toMatchObject({ name: 'Blau', nameKey: 'blue', materialId: 'mat-2' });
    p = updatePaletteColor(p, 0, { name: 'Himmel' }, 'de');
    expect(p[0].name).toBe('Himmel');
    expect(p[0].nameKey).toBeUndefined();
    p = updatePaletteColor(p, 0, { hex: '#FF8000' }, 'de');
    expect(p[0].name).toBe('Himmel');
    // leeres Feld → zurück zum automatischen Namen
    p = resetAutoName(p, 0, 'en');
    expect(p[0]).toMatchObject({ name: 'Orange', nameKey: 'orange' });
  });

  it('HEX-Änderung löscht die Abweichung vom Foto (matchDeltaE) – nur diese Farbe', () => {
    const m = { pieces: 10, mean: 1.2, max: 3, over5: 0, over10: 0 };
    let p: PaletteColor[] = [pc('#FF0000', 1, { nameKey: 'red', name: 'Rot', matchDeltaE: m }), pc('#0000FF', 2, { nameKey: 'blue', name: 'Blau', matchDeltaE: m })];
    p = updatePaletteColor(p, 0, { materialId: 'x' }, 'de');
    expect(p[0].matchDeltaE).toEqual(m);
    p = updatePaletteColor(p, 0, { hex: '#FF0000' }, 'de');
    expect(p[0].matchDeltaE).toEqual(m); // gleiche Farbe
    p = updatePaletteColor(p, 0, { hex: '#EE0000' }, 'de');
    expect(p[0].matchDeltaE).toBeUndefined();
    expect(p[1].matchDeltaE).toEqual(m);
  });

  it('ältere Projekte: ein Name gilt nur als automatisch, wenn er der früheren Benennung entspricht', () => {
    // #FF0000 hieß früher „Orange“ (falsche Farbtongrenzen)
    expect(legacyDescribeColor(hexToLab('#FF0000'), 'de')).toBe('Orange');
    expect(legacyDescribeColor(hexToLab('#FFFF00'), 'en')).toBe('Light lime');
    const legacy: PaletteColor[] = [
      { ...pc('#FF0000', 1), name: 'Orange' },
      { ...pc('#FFFF00', 2), name: 'Light lime' },
      { ...pc('#0000FF', 3), name: 'Mein Blau' },
      { ...pc('#FF0000', 4), name: 'Orange', materialId: 'm' },
    ];
    expect(legacy.map(isAutoNamed)).toEqual([true, true, false, false]);
    // HEX-Änderung an einer früher automatisch benannten Farbe → neuer, korrekter Name
    const up = updatePaletteColor(legacy, 0, { hex: '#FE0000' }, 'de');
    expect(up[0]).toMatchObject({ nameKey: 'red' });
    expect(up[0].name).toMatch(/^Rot/);
    // Übernahme beim Öffnen: Schlüssel ergänzen, korrekt benennen; Benutzer- und Materialnamen bleiben
    const norm = normalizePaletteNames(legacy, 'de');
    expect(norm.map((p) => p.name)).toEqual(['Rot', 'Gelb', 'Mein Blau', 'Orange']);
    expect(norm[3].nameKey).toBeUndefined();
    expect(normalizePaletteNames(norm, 'de')).toBe(norm);
    // Sprache wechseln: automatische Namen folgen, der Rest bleibt
    expect(normalizePaletteNames(norm, 'en').map((p) => p.name)).toEqual(['Red', 'Yellow', 'Mein Blau', 'Orange']);
  });

  it('inferAutoName erkennt automatische Namen mit Zusatz in jeder Sprache', () => {
    const l = hexToLab('#E01818');
    expect(inferAutoName('Rot', l)).toEqual({ key: 'red' });
    expect(inferAutoName('Rot (hell)', l)).toEqual({ key: 'red', suffix: 'light' });
    expect(inferAutoName('Red (dark)', l)).toEqual({ key: 'red', suffix: 'dark' });
    expect(inferAutoName('Kırmızı 3', l)).toEqual({ key: 'red', suffix: 3 });
    expect(inferAutoName('Rot 0', l)).toBeNull();
    expect(inferAutoName('Rotwein', l)).toBeNull();
    expect(inferAutoName('Blau', l)).toBeNull();
  });
});

// ================================================================ 2. Exakter Farbzuordner

describe('NearestColorMatcher.nearestExact ist exakt', () => {
  for (const size of [8, 12, 16, 24, 64, 200])
    it(`${size} zufällige Farben: 100 % gleich dem Vergleich mit jeder Farbe`, () => {
      let total = 0;
      let same = 0;
      for (let p = 0; p < (size > 64 ? 6 : 12); p++) {
        const r = rng(1000 * size + p);
        const pal = Array.from({ length: size }, () => randLab(r));
        const m = new NearestColorMatcher(pal, '2000');
        const m76 = new NearestColorMatcher(pal, '76');
        for (let q = 0; q < 400; q++) {
          const l = randLab(r);
          total++;
          if (m.nearestExact(l[0], l[1], l[2]) === bruteForce(pal, l)) same++;
          expect(m76.nearestExact(l[0], l[1], l[2])).toBe(bruteForce(pal, l, '76'));
        }
      }
      expect(same).toBe(total);
    });

  it('auch nahe an Palettenfarben (gedithertes Ziel) und mit Maske', () => {
    const r = rng(42);
    const pal = Array.from({ length: 120 }, () => randLab(r));
    const mask = pal.map((_, i) => i % 3 !== 0);
    const m = new NearestColorMatcher(pal, '2000', mask);
    for (let q = 0; q < 2000; q++) {
      const base = pal[Math.floor(r() * pal.length)];
      const l: Lab = [base[0] + (r() - 0.5) * 8, base[1] + (r() - 0.5) * 8, base[2] + (r() - 0.5) * 8];
      let best = -1;
      let bd = Infinity;
      pal.forEach((c, i) => {
        if (!mask[i]) return;
        const d = deltaE2000(l[0], l[1], l[2], c[0], c[1], c[2]);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      expect(m.nearestExact(l[0], l[1], l[2])).toBe(best);
    }
  });

  it('Zwischenspeicher: auf dem Raster der gespeicherten Steinfarben gleich nearestExact', () => {
    const r = rng(7);
    const pal = Array.from({ length: 48 }, () => randLab(r));
    const m = new NearestColorMatcher(pal, '2000');
    for (let q = 0; q < 3000; q++) {
      // Werte wie fromQ in mosaic.ts: L = n/2,55, a/b ganzzahlig
      const l: Lab = [Math.floor(r() * 256) / 2.55, Math.floor(r() * 200) - 100, Math.floor(r() * 200) - 100];
      expect(m.nearest(l[0], l[1], l[2])).toBe(m.nearestExact(l[0], l[1], l[2]));
    }
  });
});

describe('Farbe entfernen: Steine erhalten die exakt nächste verbleibende Farbe', () => {
  it('Messbeispiel aus dem Audit: #043956 → #1755F5 (nicht #90B4EC)', () => {
    const hexes = ['#CAC2BB', '#E3B684', '#B5E74E', '#5B9742', '#C79F75', '#0ED4AA', '#1755F5', '#90B4EC', '#043956'];
    const pal = hexes.map((h, i) => pc(h, i + 1, { name: h }));
    expect(pal[nearestOtherColor(pal, 8, '2000')].hex).toBe('#1755F5');
    const data = createEmptyMosaic(9, 1);
    for (let i = 0; i < 9; i++) data.c1[i] = i;
    const next = removePaletteColor(pal, data, 8);
    expect(next.length).toBe(8);
    expect(next[data.c1[8]].hex).toBe('#1755F5');
  });

  it('Landschaft, 64 Bildfarben: #E5D149 → #FFF4C2 (exakt nächste), Stückzahl bleibt', () => {
    const img = loadPng('public/samples/landscape.png');
    const lab = imageToLab(img);
    const N = img.width * img.height;
    const st = Math.max(1, Math.floor(N / 30000));
    const pts: number[] = [];
    for (let i = 0; i < N; i += st) pts.push(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
    const P = new Float32Array(pts);
    const centers = kmeansLab(P, new Float32Array(P.length / 3).fill(1), 64, 30, 7).centers;
    const pal: PaletteColor[] = centers.map((c, i) => ({ code: i + 1, lab: c, hex: labToHex(c[0], c[1], c[2]), name: '' }));
    const idx = pal.findIndex((p) => p.hex === '#E5D149');
    expect(idx).toBeGreaterThanOrEqual(0);
    // ein Stein je Farbe, dazu 5 weitere Steine in #E5D149
    const data = createEmptyMosaic(pal.length + 5, 1);
    for (let i = 0; i < pal.length + 5; i++) data.c1[i] = i < pal.length ? i : idx;
    const before = piecesPerColor(data, pal.length).reduce((a, b) => a + b, 0);
    const next = removePaletteColor(pal, data, idx, undefined, '2000');
    const moved = [idx, ...[0, 1, 2, 3, 4].map((k) => pal.length + k)].map((cell) => next[data.c1[cell]].hex);
    expect(new Set(moved)).toEqual(new Set(['#FFF4C2']));
    expect(piecesPerColor(data, next.length).reduce((a, b) => a + b, 0)).toBe(before);
  });
});

// ================================================================ 3. Ehrliche Kennzahlen je Farbe

function checkMatch(res: ReturnType<typeof computeMosaic>, layout: Parameters<typeof computeStats>[0]) {
  const st = computeStats(layout, res.data, res.palette, [], STATS_OPTS);
  let sum = 0;
  res.palette.forEach((p, i) => {
    const m = p.matchDeltaE!;
    expect(m).toBeDefined();
    expect(m.pieces).toBe(st.perColor[i].pieces);
    expect(m.over10).toBeLessThanOrEqual(m.over5);
    expect(m.over5).toBeLessThanOrEqual(m.pieces);
    if (m.pieces) expect(m.mean).toBeLessThanOrEqual(m.max + 1e-9);
    expect(matchDeltaEValid(p, st.perColor[i].pieces, 0)).toBe(m);
    sum += m.pieces;
  });
  expect(sum).toBe(st.pieces);
  expect(res.diagnostics.usedColors).toBe(st.perColor.filter((c) => c.pieces > 0).length);
  return st;
}

describe('Abweichung je Farbe vom Foto (matchDeltaE) und angefordert/verwendet', () => {
  it('automatisch: Summe der Steine = Steine gesamt, Mittel passt zur Gesamtabweichung', () => {
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su));
    const st = checkMatch(res, su.layout);
    const weighted = res.palette.reduce((s, p) => s + p.matchDeltaE!.mean * p.matchDeltaE!.pieces, 0) / st.pieces;
    expect(Math.abs(weighted - res.diagnostics.meanDeltaE)).toBeLessThan(0.01);
    expect(Math.max(...res.palette.map((p) => p.matchDeltaE!.max))).toBeCloseTo(res.diagnostics.maxDeltaE, 1);
    expect(res.diagnostics).toMatchObject({ paletteMode: 'auto', requestedColors: 32, usedColors: 32, imageColors: 32 });
    expect(res.diagnostics.mergedColors).toBeUndefined();
  });

  it('„Meine Steine – begrenzte Farbanzahl“ mit 336 Katalogfarben: zusammengelegt, Kennzahlen vollständig', () => {
    // Katalog: 7 Stufen je sRGB-Kanal (gleichmäßig im Farbraum), die ersten 336 Farben
    const steps = [0, 42, 85, 128, 170, 213, 255];
    const cat: FixedColor[] = [];
    for (const r of steps) for (const g of steps) for (const b of steps) cat.push({ lab: rgbToLab(r, g, b), hex: rgbToHex(r, g, b), name: `Kat ${cat.length + 1}`, materialId: `k${cat.length + 1}` });
    const catalogue = cat.slice(0, 336);
    expect(catalogue.length).toBe(336);
    const su = sampleSetup('portrait');
    const res = computeMosaic(su.img, baseParams(su, { paletteMode: 'auto-snap', colorCount: 32, fixedPalette: catalogue }));
    checkMatch(res, su.layout);
    const d = res.diagnostics;
    expect(d.paletteMode).toBe('auto-snap');
    expect(d.requestedColors).toBe(32);
    expect(d.usedColors).toBe(res.palette.length);
    expect(d.usedColors!).toBeLessThan(d.requestedColors!);
    expect(d.mergedColors!).toBeGreaterThan(0);
    // jede verwendete Materialfarbe nennt, wie viele Bildfarben auf sie fielen
    expect(res.palette.every((p) => (p.mergedFrom ?? 0) >= 1)).toBe(true);
    expect(res.palette.some((p) => p.mergedFrom! > 1)).toBe(true);
    const sumMerged = res.palette.reduce((s, p) => s + p.mergedFrom!, 0);
    expect(sumMerged).toBeLessThanOrEqual(d.imageColors!);
    expect(d.imageColors! - d.mergedColors!).toBeGreaterThanOrEqual(d.usedColors!);
    // Materialnamen bleiben, kein automatischer Schlüssel
    expect(res.palette.every((p) => p.nameKey === undefined && p.name.startsWith('Kat '))).toBe(true);
  });

  it('„Meine Steine – alle Farben“ und eigene Auswahl: angefordert = Anzahl Farben, verwendet = Farben mit Steinen', () => {
    const su = sampleSetup('portrait');
    const mats = materialFixed(MATERIALS12);
    const res = computeMosaic(su.img, baseParams(su, { paletteMode: 'materials', fixedPalette: mats }));
    checkMatch(res, su.layout);
    expect(res.diagnostics).toMatchObject({ paletteMode: 'materials', requestedColors: 12 });
    const custom = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: customFixed([{ hex: '#F4F1EA', name: 'Weiß' }, { hex: '#FFFF00', name: 'Gelb' }, { hex: '#E8B494', name: 'Haut' }, { hex: '#1E1A18', name: 'Schwarz' }]) }));
    checkMatch(custom, su.layout);
    expect(custom.diagnostics).toMatchObject({ paletteMode: 'custom', requestedColors: 4, usedColors: 3 });
    expect(custom.palette[1].matchDeltaE!.pieces).toBe(0);
  });

  it('eigene Auswahl: Namen bleiben genau, automatische Namen behalten ihren Schlüssel', () => {
    const su = sampleSetup('portrait');
    const pal = addPaletteColor(addPaletteColor(addPaletteColor([], '#F4F1EA', undefined, 'de'), '#E8B494', 'Haut', 'de'), '#A02432', undefined, 'en');
    const fixed: FixedColor[] = pal.map((p) => ({ lab: p.lab, hex: p.hex, name: p.name, materialId: p.materialId, code: p.code }));
    const res = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: fixed }));
    expect(res.palette.map((p) => p.name)).toEqual(pal.map((p) => p.name));
    expect(res.palette.map((p) => p.nameKey)).toEqual(pal.map((p) => p.nameKey));
    // mit weitergereichtem Schlüssel genauso
    const res2 = computeMosaic(su.img, baseParams(su, { paletteMode: 'custom', fixedPalette: pal.map((p) => ({ ...fixed[p.code - 1], nameKey: p.nameKey, nameSuffix: p.nameSuffix })) }));
    expect(res2.palette.map((p) => [p.name, p.nameKey])).toEqual(pal.map((p) => [p.name, p.nameKey]));
  });

  it('matchDeltaEValid: nach manuellen Änderungen oder anderer Stückzahl nicht mehr gültig', () => {
    const m = { pieces: 10, mean: 2, max: 4, over5: 0, over10: 0 };
    const p = pc('#FF0000', 1, { matchDeltaE: m });
    expect(matchDeltaEValid(p, 10, 0)).toBe(m);
    expect(matchDeltaEValid(p, 11, 0)).toBeNull();
    expect(matchDeltaEValid(p, 10, 1)).toBeNull();
    expect(matchDeltaEValid(p, undefined, 0)).toBeNull();
    expect(matchDeltaEValid(pc('#FF0000', 1), 10, 0)).toBeNull();
  });

  it('Farbe entfernen lässt die Kennzahlen stehen, die Anzeige erkennt sie aber als veraltet', () => {
    const su = sampleSetup('animal');
    const res = computeMosaic(su.img, baseParams(su, { colorCount: 12 }));
    const st0 = computeStats(su.layout, res.data, res.palette, [], STATS_OPTS);
    const target = nearestOtherColor(res.palette, 3, '2000');
    const next = removePaletteColor(res.palette, res.data, 3, undefined, '2000');
    const st1 = computeStats(su.layout, res.data, next, [], STATS_OPTS);
    expect(st1.pieces).toBe(st0.pieces);
    const ti = target > 3 ? target - 1 : target;
    expect(next[ti].matchDeltaE!.pieces).toBe(st0.perColor[target].pieces);
    expect(matchDeltaEValid(next[ti], st1.perColor[ti].pieces, 0)).toBeNull(); // mehr Steine als bei der Berechnung
    expect(matchDeltaEValid(next[ti], st1.perColor[ti].pieces, 1)).toBeNull();
  });
});

describe('Zellarten bleiben unberührt (nur Farbzuordnung exakter)', () => {
  it('keine Zelle wechselt durch den Zuordner die Art', () => {
    const su = sampleSetup('city');
    const res = computeMosaic(su.img, baseParams(su, { colorCount: 48, dither: 0.5 }));
    let pieces = 0;
    for (let i = 0; i < res.data.kind.length; i++) pieces += res.data.kind[i] === CellKind.FULL ? 1 : res.data.kind[i] === CellKind.SUB ? res.data.sub.get(i)!.length : 2;
    expect(res.palette.reduce((s, p) => s + p.matchDeltaE!.pieces, 0)).toBe(pieces);
  });
});
