import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FACE_OPTIONS,
  detectFacesGray,
  detectFacesRGBA,
  FACE_MIN_SCORE,
  faceCandidates,
  faceConfidence,
  loadCascade,
  rgbaToGray,
  rotateGray,
  rotatePoint,
  type FaceBox,
} from '../src/core/faceDetect';
import { applyAdjustments, resizeArea, type RGBAImage } from '../src/core/imageOps';
import { computeLayout } from '../src/core/layout';
import { computeMosaic } from '../src/core/mosaic';
import { DEFAULT_ADJUST, DEFAULT_SHAPES, type Region } from '../src/core/types';
import { dictionaries } from '../src/i18n';
import {
  coveredByRegion,
  moveRect,
  nativeEyeBand,
  nativeSuggestion,
  nudgeRect,
  picoSuggestion,
  regionAt,
  regionContains,
  regionOrigin,
  resizeRect,
  suggestionRegions,
} from '../src/ui/project/faceSuggest';
import { loadPng, prepareFor } from './helpers';

const cascadeBytes = readFileSync('src/vendor/pico/facefinder.bin');
const classify = loadCascade(cascadeBytes);

/** wie im Editor: längere Seite 640 px (RegionEditor rendert das Bild so) */
function editorSize(img: RGBAImage): RGBAImage {
  const s = 640 / Math.max(img.width, img.height);
  return resizeArea(img, Math.round(img.width * s), Math.round(img.height * s));
}

// Von Hand markierter Gesichtsbereich des gemeinfreien Testbilds (siehe tests/fixtures/face-pd-portrait.txt)
const FACE = { x: 0.35, y: 0.15, w: 0.19, h: 0.21 };
const EYES = [
  { x: 0.395, y: 0.197 },
  { x: 0.488, y: 0.197 },
];
const centre = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const inBox = (p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
function iou(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ox * oy) / (a.w * a.h + b.w * b.h - ox * oy);
}
const within01 = (b: FaceBox | { x: number; y: number; w: number; h: number }) => b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= 1 + 1e-9 && b.y + b.h <= 1 + 1e-9;

describe('w4-face-detector: mitgelieferte Erkennung (pico.js, MIT)', () => {
  it('Lizenz und Prüfsummen der mitgelieferten Dateien stimmen', () => {
    const lic = readFileSync('src/vendor/pico/LICENSE', 'utf8');
    expect(lic).toMatch(/The MIT License/);
    expect(lic).toMatch(/Copyright \(c\) 2013 Nenad Markus/);
    expect(lic).toMatch(/puploc/); // ausdrücklich nicht enthalten
    const sha = createHash('sha256').update(cascadeBytes).digest('hex');
    expect(lic).toContain(sha);
    const js = readFileSync('src/vendor/pico/pico.js', 'utf8');
    expect(js.split('\n')[0]).toMatch(/released under the MIT license/);
    expect(js).toMatch(/export default pico/);
  });

  it('beschädigte Kaskade wird abgelehnt statt still falsch zu rechnen', () => {
    expect(() => loadCascade(new Uint8Array(10))).toThrow('face-cascade');
    expect(() => loadCascade(cascadeBytes.subarray(0, 5000))).toThrow('face-cascade');
    expect(() => loadCascade(new Uint8Array(cascadeBytes))).not.toThrow();
  });

  it('Graustufen wie pico ((2R + 7G + B) / 10) und Drehung um die Bildmitte', () => {
    const g = rgbaToGray(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 100, 100, 100, 255]), 4, 1);
    expect(Array.from(g)).toEqual([51, 178, 25, 100]);
    expect(() => rgbaToGray(new Uint8ClampedArray(8), 4, 1)).toThrow('face-image');
    const img = new Uint8Array(30 * 20).map((_, i) => (i * 7) % 256);
    expect(Array.from(rotateGray(img, 30, 20, 0)).every((v, i) => v === img[i] || (i % 30 >= 29 || i >= 30 * 19))).toBe(true);
    const [x, y] = rotatePoint(...rotatePoint(3, 17, 30, 20, 15), 30, 20, -15);
    expect(x).toBeCloseTo(3, 9);
    expect(y).toBeCloseTo(17, 9);
  });

  it('Richtwert-Stufen der Sicherheit', () => {
    expect(faceConfidence(FACE_MIN_SCORE)).toBe('low');
    expect(faceConfidence(120)).toBe('medium');
    expect(faceConfidence(400)).toBe('high');
  });
});

describe('w4-face-detector: echtes Porträt (gemeinfrei) und Bilder ohne Gesicht', () => {
  const portrait = loadPng('tests/fixtures/face-pd-portrait.png');

  for (const [label, img] of [
    ['Originalgröße 320 px', portrait],
    ['Editorgröße 640 px', editorSize(portrait)],
  ] as const) {
    it(`${label}: genau ein Gesicht, Mitte im von Hand markierten Gesichtsbereich`, () => {
      const faces = detectFacesRGBA(classify, img);
      expect(faces).toHaveLength(1);
      const f = faces[0];
      expect(f.score).toBeGreaterThanOrEqual(FACE_MIN_SCORE);
      expect(inBox(centre(f), FACE)).toBe(true);
      expect(iou(f, FACE)).toBeGreaterThan(0.4);
      expect(within01(f)).toBe(true);
    });
  }

  it('geneigter Kopf (±15°) wird über die gedrehten Suchdurchgänge gefunden, an der richtigen Stelle', () => {
    const img = editorSize(portrait);
    const gray = rgbaToGray(img.data, img.width, img.height);
    const c = centre(FACE);
    for (const deg of [-15, 15]) {
      const rot = rotateGray(gray, img.width, img.height, deg);
      const faces = detectFacesGray(classify, rot, img.width, img.height);
      expect(faces.length).toBe(1);
      // Gesicht im gedrehten Bild: Punkt p des Originals liegt bei rotatePoint(p, −deg)
      const [ex, ey] = rotatePoint(c.x * img.width, c.y * img.height, img.width, img.height, -deg);
      const got = centre(faces[0]);
      expect(Math.hypot(got.x - ex / img.width, got.y - ey / img.height)).toBeLessThan(0.05);
      // nur aufrecht gesucht: deutlich schwächer oder gar nicht
      const upright = detectFacesGray(classify, rot, img.width, img.height, { angles: [0] });
      expect(upright.length === 0 || upright[0].score < faces[0].score).toBe(true);
    }
  });

  for (const name of ['landscape', 'city', 'animal']) {
    it(`${name}.png: keine Erkennung über der Schwelle`, () => {
      const img = editorSize(loadPng(`public/samples/${name}.png`));
      expect(detectFacesRGBA(classify, img)).toEqual([]);
      // auch die Kandidaten unter der Schwelle bleiben weit darunter
      const g = rgbaToGray(img.data, img.width, img.height);
      for (const c of faceCandidates(classify, g, img.width, img.height)) expect(c.q).toBeLessThan(FACE_MIN_SCORE / 2);
    });
  }

  it('synthetisches Porträt (Beispiel): kein Absturz, Ergebnis im Bild', () => {
    const img = editorSize(loadPng('public/samples/portrait.png'));
    const faces = detectFacesRGBA(classify, img);
    expect(Array.isArray(faces)).toBe(true);
    for (const f of faces) expect(within01(f)).toBe(true);
  });

  it('leere, winzige und einfarbige Bilder: keine Erkennung, kein Fehler', () => {
    expect(detectFacesGray(classify, new Uint8Array(0), 0, 0)).toEqual([]);
    expect(detectFacesGray(classify, new Uint8Array(10 * 10), 10, 10)).toEqual([]);
    expect(detectFacesGray(classify, new Uint8Array(200 * 150).fill(128), 200, 150)).toEqual([]);
    expect(detectFacesGray(classify, new Uint8Array(5), 200, 150)).toEqual([]); // zu kurzer Puffer
  });

  it('Standardwerte: mindestens 8 % der kürzeren Seite, drei Neigungen, Schwelle 50', () => {
    expect(DEFAULT_FACE_OPTIONS.minSizeFrac).toBe(0.08);
    expect([...DEFAULT_FACE_OPTIONS.angles].sort((a, b) => a - b)).toEqual([-15, 0, 15]);
    expect(DEFAULT_FACE_OPTIONS.minScore).toBe(FACE_MIN_SCORE);
  });
});

describe('w4-face-detector: Vorschläge → Bereiche (erst nach Bestätigung)', () => {
  const portrait = editorSize(loadPng('tests/fixtures/face-pd-portrait.png'));
  const face = detectFacesRGBA(classify, portrait)[0];

  it('Gesichts-Ellipse umfasst das markierte Gesicht, die geschätzte Augenpartie beide Augen', () => {
    const s = picoSuggestion(face, 's1');
    expect(s.source).toBe('pico');
    expect(s.eyesFrom).toBe('proportions');
    expect(s.score).toBe(face.score);
    const f = { shape: 'ellipse' as const, ...s.face };
    // Mitte und die vier Seitenmitten des von Hand markierten Gesichts liegen in der Ellipse
    const c = centre(FACE);
    for (const p of [c, { x: FACE.x, y: c.y }, { x: FACE.x + FACE.w, y: c.y }, { x: c.x, y: FACE.y }, { x: c.x, y: FACE.y + FACE.h }]) expect(regionContains(f, p.x, p.y)).toBe(true);
    const e = { shape: 'ellipse' as const, ...s.eyes };
    for (const p of EYES) expect(regionContains(e, p.x, p.y)).toBe(true);
    // Augenpartie liegt im Gesicht und ist deutlich kleiner
    expect(regionContains(f, centre(s.eyes).x, centre(s.eyes).y)).toBe(true);
    expect(s.eyes.w * s.eyes.h).toBeLessThan(0.25 * s.face.w * s.face.h);
    for (const r of [s.face, s.eyes]) expect(within01(r)).toBe(true);
  });

  it('Übernehmen erzeugt genau Gesicht (Ellipse) + Detail Augenpartie, mit Herkunft und neuen IDs', () => {
    let k = 0;
    const s = picoSuggestion(face, 's1');
    const regs = suggestionRegions(s, () => `r${++k}`);
    expect(regs.map((r) => [r.id, r.type, r.shape, r.origin])).toEqual([
      ['r1', 'face', 'ellipse', 'auto-face'],
      ['r2', 'detail', 'ellipse', 'auto-eyes'],
    ]);
    expect(regionOrigin(regs[1])).toBe('auto-eyes');
    expect(regionOrigin({ id: 'x', type: 'face', shape: 'rect', x: 0, y: 0, w: 1, h: 1 })).toBeUndefined();
    // ohne Übernehmen entsteht nichts: der Vorschlag selbst ist kein Bereich
    expect('type' in s).toBe(false);
  });

  it('übernommene Bereiche rechnen genau wie gezeichnete (das Feld „origin“ ändert nichts)', () => {
    const layout = computeLayout({ widthMm: 120, heightMm: 120, tileW: 5, tileH: 5, joint: 1, edgeMode: 'cut-end', minCutMm: 2 });
    const src = prepareFor(loadPng('tests/fixtures/face-pd-portrait.png'), layout);
    let k = 0;
    const withOrigin = suggestionRegions(picoSuggestion(face, 's1'), () => `r${++k}`);
    const plain: Region[] = withOrigin.map(({ origin: _o, ...r }) => (void _o, r));
    const run = (regions: Region[]) => {
      const img = applyAdjustments(src, { ...DEFAULT_ADJUST }, regions);
      return computeMosaic(img, { layout, shapes: { ...DEFAULT_SHAPES }, paletteMode: 'auto', colorCount: 12, dither: 0, deltaE: '2000', regions, seed: 3 });
    };
    const a = run(withOrigin);
    const b = run(plain);
    expect(Array.from(a.data.kind)).toEqual(Array.from(b.data.kind));
    expect(Array.from(a.data.c1)).toEqual(Array.from(b.data.c1));
    expect(a.palette.map((p) => p.hex)).toEqual(b.palette.map((p) => p.hex));
    // und die Gesichtsregion wirkt überhaupt (mehr geschnittene Zellen als ganz ohne Bereiche)
    const none = run([]);
    const cuts = (d: typeof a.data) => Array.from(d.kind).filter((v) => v !== 0).length;
    expect(cuts(a.data)).toBeGreaterThanOrEqual(cuts(none.data));
  });

  it('bereits markiertes Gesicht deckt den Vorschlag ab', () => {
    const s = picoSuggestion(face, 's1');
    const faceRegion: Region = { id: 'f', type: 'face', shape: 'ellipse', ...FACE };
    expect(coveredByRegion(s, [faceRegion])).toBe(true);
    expect(coveredByRegion(s, [{ ...faceRegion, type: 'detail' }])).toBe(false);
    expect(coveredByRegion(s, [{ ...faceRegion, x: 0.7 }])).toBe(false);
  });

  it('FaceDetector-Treffer: Augenpartie aus Augenpunkten, sonst aus festen Anteilen', () => {
    const box = { x: 0.3, y: 0.2, w: 0.4, h: 0.4 };
    const withEyes = nativeEyeBand(box, [
      { x: 0.42, y: 0.33 },
      { x: 0.58, y: 0.33 },
    ]);
    expect(withEyes.from).toBe('landmarks');
    for (const p of [
      { x: 0.42, y: 0.33 },
      { x: 0.58, y: 0.33 },
    ])
      expect(inBox(p, withEyes.rect)).toBe(true);
    const without = nativeEyeBand(box);
    expect(without.from).toBe('proportions');
    for (const [k, v] of Object.entries({ x: 0.34, y: 0.3, w: 0.32, h: 0.1 })) expect(without.rect[k as 'x'], k).toBeCloseTo(v, 12);
    const s = nativeSuggestion(box, 'n1');
    expect(s.score).toBeNull();
    expect(s.confidence).toBeNull();
    expect(within01(s.face)).toBe(true);
  });
});

describe('w4-face-detector: Bereiche verschieben und in der Größe ändern', () => {
  const r = { x: 0.2, y: 0.3, w: 0.4, h: 0.2 };

  it('Verschieben bleibt ganz im Bild, Größe unverändert', () => {
    expect(moveRect(r, 0.1, -0.1)).toEqual({ x: 0.30000000000000004, y: 0.19999999999999998, w: 0.4, h: 0.2 });
    expect(moveRect(r, 5, 5)).toEqual({ x: 0.6, y: 0.8, w: 0.4, h: 0.2 });
    expect(moveRect(r, -5, -5)).toEqual({ x: 0, y: 0, w: 0.4, h: 0.2 });
  });

  it('Ecke ziehen: gegenüberliegende Ecke bleibt fest, Mindestgröße, nie über den Bildrand', () => {
    const se = resizeRect(r, 'se', 0.9, 0.9);
    expect(se.x).toBe(0.2);
    expect(se.y).toBe(0.3);
    expect(se.w).toBeCloseTo(0.7, 12);
    expect(se.h).toBeCloseTo(0.6, 12);
    const nw = resizeRect(r, 'nw', 0.9, 0.9, 0.05, 0.05); // über die feste Ecke hinaus → Mindestgröße
    expect(nw.x + nw.w).toBeCloseTo(0.6, 12);
    expect(nw.y + nw.h).toBeCloseTo(0.5, 12);
    expect(nw.w).toBeCloseTo(0.05, 12);
    expect(nw.h).toBeCloseTo(0.05, 12);
    const out = resizeRect(r, 'ne', 1.5, -0.5);
    expect(out).toEqual({ x: 0.2, y: 0, w: 0.8, h: 0.5 });
  });

  it('Tastatur: Pfeil verschiebt, Umschalt + Pfeil ändert die Größe, andere Tasten nichts', () => {
    expect(nudgeRect(r, 'ArrowRight', false)).toEqual(moveRect(r, 0.01, 0));
    const bigger = nudgeRect(r, 'ArrowDown', true)!;
    expect(bigger.h).toBeCloseTo(0.21, 12);
    expect(bigger.x).toBe(0.2);
    expect(nudgeRect(r, 'Enter', false)).toBeNull();
  });

  it('Antippen wählt bei verschachtelten Bereichen den kleinsten (Augenpartie im Gesicht)', () => {
    const faceR = { id: 'f', type: 'face' as const, shape: 'ellipse' as const, x: 0.2, y: 0.1, w: 0.5, h: 0.7 };
    const eyes = { id: 'e', type: 'detail' as const, shape: 'ellipse' as const, x: 0.3, y: 0.3, w: 0.3, h: 0.1 };
    expect(regionAt([faceR, eyes], 0.45, 0.35)?.id).toBe('e');
    expect(regionAt([eyes, faceR], 0.45, 0.35)?.id).toBe('e');
    expect(regionAt([faceR, eyes], 0.45, 0.7)?.id).toBe('f');
    // Ecke des umschließenden Rechtecks liegt nicht in der Ellipse
    expect(regionAt([faceR], 0.21, 0.11)).toBeNull();
    expect(regionAt([{ ...faceR, shape: 'rect' as const }], 0.21, 0.11)?.id).toBe('f');
  });
});

describe('w4-face-detector: Texte und Offline-Vorrat', () => {
  it('dynamisch zusammengesetzte Schlüssel gibt es in DE, EN und TR', () => {
    const keys = [...['low', 'medium', 'high'].map((k) => `w4fd.conf.${k}`), ...['nw', 'ne', 'sw', 'se'].map((k) => `w4fd.corner.${k}`)];
    for (const lang of ['de', 'en', 'tr'] as const) for (const k of keys) expect((dictionaries[lang] as Record<string, string>)[k], `${lang}:${k}`).toBeTruthy();
  });

  it('Texte nennen die Grenzen (nur frontale menschliche Gesichter) und „geschätzt“', () => {
    const de = dictionaries.de as Record<string, string>;
    expect(de['w4fd.scope']).toMatch(/nur frontale menschliche Gesichter/);
    // ehrlich über die Grenze: gezeichnete/gemalte Gesichter erkennt die Automatik nicht (z. B. das Beispielporträt)
    expect(de['w4fd.none']).toMatch(/^Kein Gesicht automatisch erkannt .*gezeichnete oder gemalte Gesichter/);
    expect(de['w4fd.noneKept']).toMatch(/markierten Gesichtsbereiche bleiben unverändert/);
    expect(de['w4fd.scope']).toMatch(/gezeichneten\/gemalten Gesichter/);
    expect(de['w4fd.estimated']).toBe('geschätzt');
    expect(de['w4fd.sugg.title']).toMatch(/automatisch erkannt – bitte prüfen/);
    expect(de['w4fd.sugg.adds']).toMatch(/geschätzt/);
  });

  it('Service Worker speichert die Kaskade (*.bin) vorab', () => {
    const cfg = readFileSync('vite.config.ts', 'utf8');
    const m = cfg.match(/globPatterns:\s*\[([^\]]*)\]/);
    expect(m?.[1]).toMatch(/\bbin\b/);
    const worker = readFileSync('src/workers/face.worker.ts', 'utf8');
    expect(worker).toMatch(/new URL\('\.\.\/vendor\/pico\/facefinder\.bin', import\.meta\.url\)/);
  });
});
