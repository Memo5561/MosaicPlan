/**
 * Farbe aus Foto messen (Paket w6-colour-measure):
 *  1. samplePatch: Glanzlichter, Fuge/Kantenschatten und Rauschen verfälschen den Mittelwert nicht (ΔE00 < 1).
 *  2. Mittelwert in linearem sRGB, nicht in Gammawerten.
 *  3. Weißabgleich: Farbstich der Referenz wird entfernt (Papier: nur Stich; Graukarte: Stich und Belichtung).
 *  4. Übersteuerte oder zu dunkle Referenz wird abgelehnt (keine Korrektur).
 *  5. Herkunftsangabe prüfen/vergleichen.
 *  6. Material-CSV: Herkunftsspalten am Ende, Rundreise, ältere Dateien, HEX-Änderung ohne Herkunft.
 */
import { describe, expect, it } from 'vitest';
import { deltaE2000, hexToLab, hexToRgb, type Lab } from '../src/core/color';
import {
  applyGains,
  CLIP_LEVEL,
  linearToLab,
  luminance,
  measureReference,
  measureWarnings,
  photoSource,
  readColorSource,
  sameColorSource,
  samplePatch,
  srgbToLinear,
  whiteBalanceGains,
  type Lin,
  type RgbaImage,
} from '../src/core/colorMeasure';
import { COLOR_SOURCE_CSV_HEADERS, MATERIAL_CSV_FIELDS, materialsCsvTemplate, materialsToCsv, parseMaterialsCsv, parseMeasureDate, planMaterialImport, type MaterialsCsvOk } from '../src/core/materialsCsv';
import type { Material } from '../src/core/types';

// ---------------------------------------------------------------- Hilfen

/** Deterministischer Zufall (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function image(w: number, h: number, px: (x: number, y: number) => [number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  return { data, width: w, height: h };
}

const lin2srgb = (c: number) => {
  const x = Math.max(0, Math.min(1, c));
  return Math.round((x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255);
};
const toLin = (hex: string): Lin => hexToRgb(hex).map(srgbToLinear) as Lin;
const de = (p: Lab, q: Lab) => deltaE2000(p[0], p[1], p[2], q[0], q[1], q[2]);

/** Szene „fotografiert“: lineare Szenenfarbe × Lichtfarbe × Belichtung, dann sRGB 8 Bit. */
function shoot(lin: Lin, cast: Lin, exposure: number): [number, number, number] {
  return [lin2srgb(lin[0] * cast[0] * exposure), lin2srgb(lin[1] * cast[1] * exposure), lin2srgb(lin[2] * cast[2] * exposure)];
}

// ---------------------------------------------------------------- 1./2. samplePatch

describe('samplePatch: robuste Flächenmessung', () => {
  const BASE = '#3A6EA5';
  const base = hexToRgb(BASE);

  it('flache Fläche mit 10 % weißen Glanzlichtern, dunklen Randpixeln und Rauschen → ΔE00 < 1', () => {
    const rnd = rng(7);
    const W = 120;
    const H = 120;
    const cx = 60;
    const cy = 60;
    const R = 40;
    const img = image(W, H, (x, y) => {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      // dunkler Rand (Fuge / Kantenschatten) im äußeren Ring der Messfläche: ≈ 8 % der Fläche
      if (d > R * 0.96 && d <= R) return [28, 26, 24];
      const u = rnd();
      if (u < 0.07) return [255, 255, 255]; // übersteuerte Glanzlichter
      if (u < 0.1) return [236, 240, 244]; // helle, nicht übersteuerte Spiegelung
      const n = () => Math.round((rnd() - 0.5) * 10);
      return [base[0] + n(), base[1] + n(), base[2] + n()];
    });
    const res = samplePatch(img, cx, cy, R)!;
    expect(res).not.toBeNull();
    expect(res.clippedFrac).toBeGreaterThan(0.04);
    expect(res.clippedFrac).toBeLessThan(0.1);
    const d = de(res.lab, hexToLab(BASE));
    expect(d).toBeLessThan(1);
    // ohne Verwerfen (einfacher Mittelwert in Gammawerten) wäre das Ergebnis deutlich daneben
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let cnt = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > R) continue;
        const i = (y * W + x) * 4;
        sr += img.data[i];
        sg += img.data[i + 1];
        sb += img.data[i + 2];
        cnt++;
      }
    const naive = hexToLab(`#${[sr, sg, sb].map((v) => Math.round(v / cnt).toString(16).padStart(2, '0')).join('')}`);
    expect(de(naive, hexToLab(BASE))).toBeGreaterThan(2);
    expect(res.spreadDE).toBeLessThan(4);
    expect(measureWarnings(res, true)).toEqual([]);
  });

  it('Mittelwert in linearem sRGB (Schachbrett zweier Grauwerte)', () => {
    const img = image(40, 40, (x, y) => ((x + y) % 2 ? [40, 40, 40] : [200, 200, 200]));
    const res = samplePatch(img, 20, 20, 15)!;
    const expected = (srgbToLinear(40) + srgbToLinear(200)) / 2;
    expect(res.lin[0]).toBeCloseTo(expected, 3);
    expect(lin2srgb(expected)).not.toBe(120); // Gammamittel wäre 120
    expect(res.hex).toBe(`#${lin2srgb(expected).toString(16).padStart(2, '0').repeat(3)}`.toUpperCase());
    // zwei sehr verschiedene Werte: große Streuung → Warnung
    expect(res.spreadDE).toBeGreaterThan(4);
    expect(measureWarnings(res, true)).toContain('spread');
  });

  it('Fläche teilweise außerhalb: nur Pixel im Bild; ganz außerhalb → null', () => {
    const img = image(20, 20, () => [base[0], base[1], base[2]]);
    const part = samplePatch(img, 0, 0, 6)!;
    expect(part.total).toBeGreaterThan(0);
    expect(part.hex).toBe(BASE);
    expect(samplePatch(img, -50, -50, 5)).toBeNull();
  });

  it('nur übersteuerte Pixel → kein Messwert (leer, nie übernehmbar)', () => {
    const img = image(20, 20, () => [255, 255, CLIP_LEVEL]);
    const res = samplePatch(img, 10, 10, 6)!;
    expect(res.n).toBe(0);
    expect(res.hex).toBe('');
    expect(res.clippedFrac).toBe(1);
    expect(measureWarnings(res, true)).toContain('empty');
  });

  it('große Flächen werden ausgedünnt, das Ergebnis bleibt gleich', () => {
    const img = image(600, 600, () => [base[0], base[1], base[2]]);
    const res = samplePatch(img, 300, 300, 280)!;
    expect(res.total).toBeLessThan(50_000);
    expect(res.hex).toBe(BASE);
  });
});

// ---------------------------------------------------------------- 3./4. Weißabgleich und Referenz

describe('Weißabgleich mit Referenz', () => {
  const TILE = '#3A6EA5';
  const tileLin = toLin(TILE);
  const cast: Lin = [1.25, 1.0, 0.7]; // warmes Kunstlicht
  const exposure = 0.85;
  const paperLin: Lin = [0.8, 0.8, 0.8];
  const greyLin: Lin = [0.18, 0.18, 0.18];

  /** Foto: links Referenz, rechts Stein. */
  const scene = (refLin: Lin) => image(200, 100, (x) => (x < 100 ? shoot(refLin, cast, exposure) : shoot(tileLin, cast, exposure)));

  it('ohne Korrektur ist der Farbstich deutlich sichtbar', () => {
    const res = samplePatch(scene(paperLin), 150, 50, 30)!;
    expect(de(res.lab, hexToLab(TILE))).toBeGreaterThan(5);
    expect(measureWarnings(res, false)).toContain('no-reference');
  });

  it('Graukarte 18 %: Farbstich UND Belichtung korrigiert → ΔE00 < 1', () => {
    const img = scene(greyLin);
    const ref = measureReference(img, 50, 50, 30, 'grey18');
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    const res = samplePatch(img, 150, 50, 30, { gains: ref.gains })!;
    expect(de(res.lab, hexToLab(TILE))).toBeLessThan(1);
  });

  it('weißes Papier: Farbstich entfernt, Helligkeit bleibt (keine erfundene Belichtung)', () => {
    const img = scene(paperLin);
    const ref = measureReference(img, 50, 50, 30, 'paper');
    expect(ref.ok).toBe(true);
    if (!ref.ok) return;
    // die Referenz selbst wird neutral, ihre Luminanz bleibt
    const refCorr = applyGains(ref.lin, ref.gains);
    const refLab = linearToLab(refCorr.lin);
    expect(Math.abs(refLab[1])).toBeLessThan(0.5);
    expect(Math.abs(refLab[2])).toBeLessThan(0.5);
    expect(luminance(refCorr.lin)).toBeCloseTo(luminance(ref.lin), 4);
    // der Stein: Kanalverhältnisse wie in der Szene (Stich weg), Helligkeit um einen gemeinsamen Faktor
    const res = samplePatch(img, 150, 50, 30, { gains: ref.gains })!;
    const k = res.lin[1] / tileLin[1];
    expect(res.lin[0] / tileLin[0] / k).toBeCloseTo(1, 1);
    expect(res.lin[2] / tileLin[2] / k).toBeCloseTo(1, 1);
    // Farbton/Buntheit wie das Original (gleicher Abstand nur bis auf die Helligkeit)
    const want = linearToLab([tileLin[0] * k, tileLin[1] * k, tileLin[2] * k]);
    expect(de(res.lab, want)).toBeLessThan(1);
    // die Gains für 'paper' entsprechen target = Luminanz der Referenz
    const g = whiteBalanceGains(ref.lin, 'paper');
    expect(g.map((x, i) => x * ref.lin[i])).toEqual(g.map(() => expect.closeTo(luminance(ref.lin), 6)));
  });

  it('übersteuerte Referenz (> 2 % ausgefressen) wird abgelehnt', () => {
    const rnd = rng(3);
    const img = image(100, 100, () => (rnd() < 0.06 ? [255, 255, 255] : [235, 232, 228]));
    const ref = measureReference(img, 50, 50, 30, 'paper');
    expect(ref.ok).toBe(false);
    if (!ref.ok) expect(ref.reason).toBe('clipped');
    // knapp unter der Grenze (1 %) wird sie angenommen
    const rnd2 = rng(4);
    const img2 = image(100, 100, (x, y) => (x === 50 && y % 10 === 0 ? [255, 255, 255] : rnd2() < 0 ? [0, 0, 0] : [235, 232, 228]));
    expect(measureReference(img2, 50, 50, 30, 'paper').ok).toBe(true);
  });

  it('vollständig weiße (ausgefressene) Referenz und zu dunkle Referenz werden abgelehnt', () => {
    const white = image(60, 60, () => [255, 255, 255]);
    const r1 = measureReference(white, 30, 30, 20, 'paper');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('clipped');
    const dark = image(60, 60, () => [8, 8, 8]);
    const r2 = measureReference(dark, 30, 30, 20, 'grey18');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('dark');
    expect(measureReference(dark, -100, -100, 5, 'grey18')).toMatchObject({ ok: false, reason: 'outside' });
  });

  it('Korrektur über den Farbraum hinaus wird geklemmt und gemeldet', () => {
    const out = applyGains([0.9, 0.5, 0.2], [2, 1, 1]);
    expect(out.clamped).toBe(true);
    expect(out.lin[0]).toBe(1);
  });
});

// ---------------------------------------------------------------- 5. Herkunftsangabe

describe('Herkunft des Farbwerts', () => {
  it('photoSource: Referenzart, Datum, Streuung auf 0,1 gerundet', () => {
    const s = photoSource('paper', 1.84, new Date('2026-11-10T12:00:00.000Z'));
    expect(s).toEqual({ kind: 'photo', measuredAt: '2026-11-10T12:00:00.000Z', reference: 'white', spreadDE: 1.8 });
    expect(photoSource('grey18', 2).reference).toBe('grey');
    expect(photoSource(null, 2).reference).toBe('none');
  });

  it('readColorSource verwirft Ungültiges, ohne zu raten', () => {
    expect(readColorSource(undefined)).toBeUndefined();
    expect(readColorSource({ kind: 'kalibriert' })).toBeUndefined();
    expect(readColorSource({ kind: 'manual', spreadDE: 3 })).toEqual({ kind: 'manual' });
    expect(readColorSource({ kind: 'photo', spreadDE: '2', reference: 'blau', measuredAt: 'gestern' })).toEqual({ kind: 'photo' });
    expect(readColorSource({ kind: 'photo', spreadDE: 2.5, reference: 'grey', measuredAt: '2026-11-10T12:00:00.000Z' })).toEqual({
      kind: 'photo',
      spreadDE: 2.5,
      reference: 'grey',
      measuredAt: '2026-11-10T12:00:00.000Z',
    });
  });

  it('sameColorSource vergleicht in Exportgenauigkeit', () => {
    expect(sameColorSource(undefined, undefined)).toBe(true);
    expect(sameColorSource({ kind: 'photo', spreadDE: 1.83 }, { kind: 'photo', spreadDE: 1.8 })).toBe(true);
    expect(sameColorSource({ kind: 'photo', spreadDE: 1.83 }, { kind: 'photo', spreadDE: 2.1 })).toBe(false);
    expect(sameColorSource({ kind: 'manual' }, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------- 6. Material-CSV

const ok = (text: string): MaterialsCsvOk => {
  const p = parseMaterialsCsv(text);
  if (!p.ok) throw new Error(p.error);
  return p;
};
const ids = () => {
  let i = 0;
  return () => `n${++i}`;
};
const mat = (p: Partial<Material> & { id: string }): Material => ({
  type: 'glass',
  manufacturer: '',
  product: '',
  colorNumber: '',
  colorName: '',
  hex: '#808080',
  lengthMm: 10,
  widthMm: 10,
  thicknessMm: 4,
  price: 0,
  packageSize: '',
  piecesPerPack: 0,
  ...p,
});

describe('Material-CSV: Herkunftsspalten', () => {
  const photo = mat({ id: 'p1', manufacturer: 'Sicis', colorNumber: '09', hex: '#3A6EA5', colorSource: { kind: 'photo', measuredAt: '2026-11-10T12:00:00.000Z', reference: 'white', spreadDE: 1.8 } });
  const dropper = mat({ id: 'p2', manufacturer: 'Sicis', colorNumber: '10', hex: '#112233', colorSource: { kind: 'eyedropper' } });
  const manual = mat({ id: 'p3', manufacturer: 'Sicis', colorNumber: '11', hex: '#445566', colorSource: { kind: 'manual' } });
  const unknown = mat({ id: 'p4', manufacturer: 'Sicis', colorNumber: '12', hex: '#778899' });
  const all = [photo, dropper, manual, unknown];

  it('Export: vier Herkunftsspalten am Ende, Fotomessung als Näherung gekennzeichnet', () => {
    const csv = materialsToCsv(all, 'de', { bom: false });
    const [head, l1, l2, l3, l4] = csv.split('\r\n');
    expect(head.endsWith(';Notiz;Farbherkunft;Gemessen am;Messreferenz;Messstreuung (ΔE)')).toBe(true);
    expect(l1.endsWith(';Foto-Messung (Näherung);2026-11-10T12:00:00.000Z;weißes Papier;1,8')).toBe(true);
    expect(l2.endsWith(';Pipette;;;')).toBe(true);
    expect(l3.endsWith(';eingegeben;;;')).toBe(true);
    expect(l4.endsWith(';;;;')).toBe(true);
    expect(materialsToCsv([photo], 'en', { bom: false })).toContain(',photo measurement (approximation),2026-11-10T12:00:00.000Z,white paper,1.8');
    expect(materialsToCsv([photo], 'tr', { bom: false })).toContain(';fotoğraf ölçümü (yaklaşık);2026-11-10T12:00:00.000Z;beyaz kâğıt;1,8');
  });

  for (const lang of ['de', 'en', 'tr'] as const) {
    it(`Rundreise und erneuter Import: Herkunft erhalten, alles identisch (${lang})`, () => {
      const p = ok(materialsToCsv(all, lang));
      expect(p.warnings).toEqual([]);
      expect(p.columns.filter((c) => c.field.startsWith('src')).map((c) => c.header)).toEqual(Object.values(COLOR_SOURCE_CSV_HEADERS[lang]));
      const fresh = planMaterialImport(p, [], 'update', ids());
      expect(fresh.items.map((x) => x.material.colorSource)).toEqual([photo.colorSource, dropper.colorSource, manual.colorSource, undefined]);
      const again = planMaterialImport(p, all, 'update', ids());
      expect(again.updates).toEqual([]);
      expect(again.identical).toHaveLength(4);
    });
  }

  it('ältere Dateien ohne Herkunftsspalten: Import unverändert, vorhandene Herkunft bleibt', () => {
    const old = 'ID;Hersteller;Farbnummer;HEX;Preis\r\np1;Sicis;09;#3A6EA5;3,5\r\nneu;Bisazza;1;#ABCDEF;1\r\n';
    const p = ok(old);
    expect(p.missingFields).not.toContain('colorSource' as never);
    expect(p.warnings).toEqual([]);
    const plan = planMaterialImport(p, [photo], 'update', ids());
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].changed).toEqual(['price']);
    expect(plan.updates[0].after.colorSource).toEqual(photo.colorSource);
    expect(plan.items[0].material.colorSource).toBeUndefined();
  });

  it('neuer HEX-Wert ohne Herkunftsangabe: Fotomessung entfällt (gehört zum alten Wert) und wird gemeldet', () => {
    const p = ok('ID;HEX\r\np1;#3A6EA6\r\n');
    const plan = planMaterialImport(p, [photo], 'update', ids());
    expect(plan.updates[0].changed).toEqual(['hex', 'colorSource']);
    expect(plan.updates[0].after.colorSource).toBeUndefined();
    // mit leerer Herkunftszelle genauso
    const p2 = ok('ID;HEX;Farbherkunft\r\np1;#3A6EA6;\r\n');
    expect(planMaterialImport(p2, [photo], 'update', ids()).updates[0].after.colorSource).toBeUndefined();
  });

  it('geänderte Herkunft ist eine Änderung; Streuung in Exportgenauigkeit', () => {
    const p = ok('ID;HEX;Farbherkunft\r\np1;#3A6EA5;eingegeben\r\n');
    const plan = planMaterialImport(p, [photo], 'update', ids());
    expect(plan.updates[0].changed).toEqual(['colorSource']);
    expect(plan.updates[0].after.colorSource).toEqual({ kind: 'manual' });
    const precise = { ...photo, colorSource: { ...photo.colorSource!, spreadDE: 1.83 } };
    const same = planMaterialImport(ok(materialsToCsv([photo], 'de')), [precise], 'update', ids());
    expect(same.identical).toHaveLength(1);
  });

  it('unbekannte Herkunftswerte werden gemeldet und nicht übernommen; Datum de/ISO wird gelesen', () => {
    const p = ok('HEX;Farbherkunft;Gemessen am;Messreferenz;Messstreuung (ΔE)\r\n#111111;kalibriert;;;\r\n#222222;Foto;10.11.2026 14:30;Graukarte;±2,4\r\n#333333;Foto;gestern;blau;-1\r\n');
    expect(p.rows[0].values.colorSource).toBeUndefined();
    expect(p.rows[1].values.colorSource).toMatchObject({ kind: 'photo', reference: 'grey', spreadDE: 2.4 });
    expect(Date.parse(p.rows[1].values.colorSource!.measuredAt!)).toBe(new Date(2026, 10, 10, 14, 30).getTime());
    expect(p.rows[2].values.colorSource).toEqual({ kind: 'photo' });
    expect(p.warnings.map((w) => [w.line, w.field, w.reason])).toEqual([
      [2, 'srcKind', 'source-unknown'],
      [4, 'srcDate', 'source-unknown'],
      [4, 'srcRef', 'source-unknown'],
      [4, 'srcSpread', 'number-negative'],
    ]);
  });

  it('parseMeasureDate: nur eindeutige Formate', () => {
    expect(parseMeasureDate('2026-11-10T12:00:00.000Z')).toBe('2026-11-10T12:00:00.000Z');
    expect(parseMeasureDate('31.02.2026')).toBeNull();
    expect(parseMeasureDate('11/10/2026')).toBeNull();
  });

  it('Spaltennamen „Referenz“, „Herkunft“ oder „Streuung“ allein werden nicht als Herkunft gedeutet', () => {
    const p = ok('HEX;Referenz;Herkunft;Streuung\r\n#111111;A-12;Italien;x\r\n');
    expect(p.ignoredColumns).toEqual(['Referenz', 'Herkunft', 'Streuung']);
    expect(p.rows[0].values.colorSource).toBeUndefined();
  });

  it('Vorlage enthält die Herkunftsspalten und importiert als „eingegeben“', () => {
    const p = ok(materialsCsvTemplate('de'));
    expect(p.columns).toHaveLength(MATERIAL_CSV_FIELDS.length + 4);
    expect(p.rows[0].values.colorSource).toEqual({ kind: 'manual' });
  });
});
