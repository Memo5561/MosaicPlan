import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { dictionaries } from '../src/i18n';
import {
  aspectOf,
  createFromPhoto,
  createFromSample,
  decodeAspect,
  isHeicLike,
  pickDroppedFile,
  projectNameFromFile,
  type DecodedImage,
} from '../src/ui/homeIntake';

const CSS = readFileSync('src/ui/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Wirksamer Wert einer CSS-Eigenschaft für `selector` außerhalb von @media: die letzte Deklaration der letzten
 * Regel, deren Selektorliste genau diesen Selektor enthält (wie die Kaskade; Rückfallwerte davor zählen nicht).
 */
function prop(selector: string, name: string): string {
  const top = CSS.split(/@media/)[0];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let found: string | null = null;
  for (const m of top.matchAll(re)) {
    const sels = m[1].split(',').map((s) => s.trim());
    if (!sels.includes(selector)) continue;
    for (const d of m[2].matchAll(new RegExp(`(?:^|;|\\s)${name}\\s*:\\s*([^;]+);`, 'g'))) found = d[1].trim().replace(/\s+/g, ' ');
  }
  if (found === null) throw new Error(`${selector} { ${name} } nicht gefunden`);
  return found;
}

function token(name: string): string {
  return prop(':root', `--${name}`);
}

/** var(--x) auflösen, Hex-Farbe zurückgeben */
function color(v: string): string {
  const m = v.match(/^var\(--([\w-]+)\)$/);
  const out = m ? token(m[1]) : v;
  if (!/^#[0-9a-f]{6}$/i.test(out)) throw new Error(`keine Hex-Farbe: ${v} → ${out}`);
  return out;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe('Design-Token: Kontrast nach WCAG AA', () => {
  it('Referenzwerte der Kontrastformel', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });

  const bg = () => token('bg');
  const white = '#ffffff';
  const textPairs: [string, () => string, () => string][] = [
    ['muted auf --bg', () => token('muted'), bg],
    ['muted auf Weiß', () => token('muted'), () => white],
    ['muted auf Tabellenkopf', () => token('muted'), () => color(prop('table.data th', 'background'))],
    ['muted auf --viewer-bg', () => token('muted'), () => token('viewer-bg')],
    ['weiß auf --accent (Hauptknopf)', () => token('accent-ink'), () => token('accent')],
    ['weiß auf --accent-hover', () => token('accent-ink'), () => token('accent-hover')],
    ['--accent als Textfarbe auf --bg', () => token('accent'), bg],
    ['warn auf --bg', () => token('warn'), bg],
    ['warn auf Weiß', () => token('warn'), () => white],
    ['warn auf .badge-warn', () => color(prop('.badge-warn', 'color')), () => color(prop('.badge-warn', 'background'))],
    ['ok auf .badge-ok', () => color(prop('.badge-ok', 'color')), () => color(prop('.badge-ok', 'background'))],
    ['ok auf Weiß', () => token('ok'), () => white],
    ['err auf .badge-error', () => color(prop('.badge-error', 'color')), () => color(prop('.badge-error', 'background'))],
    ['err auf --bg', () => token('err'), bg],
    ['info-Badge', () => color(prop('.badge-info', 'color')), () => color(prop('.badge-info', 'background'))],
    ['unvollständig-Badge', () => color(prop('.badge-incomplete', 'color')), () => color(prop('.badge-incomplete', 'background'))],
    ['ink-soft auf --bg', () => token('ink-soft'), bg],
    ['aktiver Schritt: weiß auf --accent', () => '#ffffff', () => color(prop('.step.active .step-no', 'background'))],
  ];
  for (const [name, fg, bgc] of textPairs) {
    it(`${name} ≥ 4,5 : 1`, () => {
      expect(contrast(fg(), bgc())).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('Fortschrittsbalken: Beschriftung (--ink) auf beiden Verlaufsfarben ≥ 4,5 : 1', () => {
    const g = prop('.progress-bar', 'background');
    const stops = g.match(/#[0-9a-f]{6}/gi) ?? [];
    expect(stops.length).toBeGreaterThanOrEqual(2);
    for (const s of stops) expect(contrast(token('ink'), s)).toBeGreaterThanOrEqual(4.5);
  });

  it('Bedienelemente (WCAG 1.4.11): Feldrahmen und ausgeschalteter Schalter ≥ 3 : 1', () => {
    expect(contrast(token('field-line'), '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrast(token('field-line'), bg())).toBeGreaterThanOrEqual(3);
    expect(contrast(color(prop('.toggle-track', 'background')), '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrast(token('teal'), '#ffffff')).toBeGreaterThanOrEqual(3);
  });

  it('Hauptfarbe und Fehlerrot bleiben unterscheidbar (nicht identisch)', () => {
    expect(token('accent').toLowerCase()).not.toBe(token('err').toLowerCase());
  });
});

describe('Touch-Größen und sichere Bereiche (styles.css)', () => {
  const coarse = (() => {
    const i = CSS.lastIndexOf('@media (pointer: coarse)');
    expect(i).toBeGreaterThan(0);
    return CSS.slice(i);
  })();
  const minHeightOf = (sel: string) => {
    for (const m of coarse.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sels = m[1].replace('@media (pointer: coarse)', '').split(',').map((s) => s.trim());
      const v = m[2].match(/min-height:\s*(\d+)px/);
      if (sels.includes(sel) && v) return Number(v[1]);
    }
    return 0;
  };

  it('Grob-Zeiger-Block steht nach den Breiten-Regeln (überstimmt sie)', () => {
    expect(CSS.lastIndexOf('@media (pointer: coarse)')).toBeGreaterThan(CSS.lastIndexOf('@media (max-width: 600px)'));
  });

  it('Knöpfe, Segmente, Navigation und Schritte mindestens 44 px', () => {
    for (const s of ['.btn', '.btn.small', '.btn.chip', '.segmented button', '.neighbor', '.mainnav button', '.step', '.icon-btn', '.viewer-tools button', 'input.text', 'select', '.numin input', 'label.inline']) {
      expect(`${s}: ${minHeightOf(s)}`).toBe(`${s}: ${Math.max(44, minHeightOf(s))}`);
    }
    expect(minHeightOf('.legend-item')).toBeGreaterThanOrEqual(40);
    expect(minHeightOf('.section-cell')).toBeGreaterThanOrEqual(40);
    expect(minHeightOf('.cp')).toBeGreaterThanOrEqual(48);
  });

  it('Eingaben mit 16 px Schrift (kein Auto-Zoom)', () => {
    expect(coarse).toMatch(/input\.text,\s*select,\s*\.numin input\s*\{\s*font-size:\s*16px/);
  });

  it('Dialog und Seitenende berücksichtigen die sicheren Bereiche (Android randlos)', () => {
    expect(prop('.modal-backdrop', 'padding')).toContain('env(safe-area-inset-top)');
    expect(prop('.modal-backdrop', 'padding')).toContain('env(safe-area-inset-bottom)');
    expect(prop('.modal', 'max-height')).toContain('100dvh');
    expect(prop('main', 'padding-bottom')).toContain('env(safe-area-inset-bottom)');
  });
});

describe('Startseite: Foto annehmen (homeIntake)', () => {
  const bmp = (w: number, h: number) => {
    const close = vi.fn();
    const img: DecodedImage = { width: w, height: h, close };
    return { img, close };
  };

  it('erkennt HEIC/HEIF an Typ oder Endung', () => {
    expect(isHeicLike({ name: 'IMG_0001.HEIC', type: '' })).toBe(true);
    expect(isHeicLike({ name: 'x', type: 'image/heif' })).toBe(true);
    expect(isHeicLike({ name: 'foto.jpg', type: 'image/jpeg' })).toBe(false);
  });

  it('Seitenverhältnis nur für echte Bildgrößen', () => {
    expect(aspectOf(400, 300)).toBeCloseTo(4 / 3, 10);
    expect(aspectOf(0, 300)).toBeNull();
    expect(aspectOf(NaN, 3)).toBeNull();
  });

  it('decodeAspect gibt das Bild sofort frei – auch wenn es keine Größe hat', async () => {
    const a = bmp(800, 600);
    await expect(decodeAspect(new Blob(), async () => a.img)).resolves.toBeCloseTo(4 / 3, 10);
    expect(a.close).toHaveBeenCalledTimes(1);
    const b = bmp(0, 0);
    await expect(decodeAspect(new Blob(), async () => b.img)).rejects.toThrow();
    expect(b.close).toHaveBeenCalledTimes(1);
  });

  it('nicht lesbares Foto: kein Projekt, Meldung „decode“', async () => {
    const create = vi.fn(async () => 'id');
    const file = Object.assign(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0])], { type: 'image/jpeg' }), { name: 'kaputt.jpg' });
    const r = await createFromPhoto(file, {
      decode: async () => {
        throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
      },
      create,
    });
    expect(r).toMatchObject({ ok: false, kind: 'decode' });
    expect(create).not.toHaveBeenCalled();
  });

  it('HEIC, das der Browser nicht öffnen kann: Meldung „heic“', async () => {
    const create = vi.fn(async () => 'id');
    const file = Object.assign(new Blob([], { type: '' }), { name: 'IMG_4711.heic' });
    const r = await createFromPhoto(file, { decode: () => Promise.reject(new Error('x')), create });
    expect(r).toMatchObject({ ok: false, kind: 'heic' });
    expect(create).not.toHaveBeenCalled();
  });

  it('Projekt erst nach erfolgreichem Lesen; Bild vorher freigegeben', async () => {
    const a = bmp(1200, 800);
    const order: string[] = [];
    a.img.close = () => order.push('close');
    const r = await createFromPhoto(Object.assign(new Blob(), { name: 'a.png' }), {
      decode: async () => {
        order.push('decode');
        return a.img;
      },
      create: async (aspect) => {
        order.push(`create ${aspect}`);
        return 'p1';
      },
    });
    expect(r).toEqual({ ok: true, id: 'p1' });
    expect(order).toEqual(['decode', 'close', 'create 1.5']);
  });

  it('Speicherfehler beim Anlegen: Meldung „save“', async () => {
    const r = await createFromPhoto(Object.assign(new Blob(), { name: 'a.png' }), {
      decode: async () => bmp(10, 10).img,
      create: () => Promise.reject(new DOMException('voll', 'QuotaExceededError')),
    });
    expect(r).toMatchObject({ ok: false, kind: 'save' });
  });

  it('Beispielprojekt: Ladefehler → „sample“, Speicherfehler → „save“, sonst Projekt-ID', async () => {
    const create = vi.fn(async () => 's1');
    const failFetch = await createFromSample('samples/x.png', { fetchBlob: () => Promise.reject(new Error('HTTP 404')), decode: async () => bmp(1, 1).img, create });
    expect(failFetch).toMatchObject({ ok: false, kind: 'sample' });
    expect(create).not.toHaveBeenCalled();
    const failSave = await createFromSample('samples/x.png', {
      fetchBlob: async () => new Blob(),
      decode: async () => bmp(4, 3).img,
      create: () => Promise.reject(new Error('quota')),
    });
    expect(failSave).toMatchObject({ ok: false, kind: 'save' });
    const ok = await createFromSample('samples/x.png', { fetchBlob: async () => new Blob(), decode: async () => bmp(4, 3).img, create });
    expect(ok).toEqual({ ok: true, id: 's1' });
    expect(create).toHaveBeenCalledWith(expect.any(Blob), 4 / 3);
  });

  it('abgelegte Dateien: erste Bilddatei, sonst erste Datei (für eine Meldung)', () => {
    const txt = { name: 'notiz.txt', type: 'text/plain' };
    const jpg = { name: 'foto.jpg', type: 'image/jpeg' };
    expect(pickDroppedFile([txt, jpg])).toBe(jpg);
    expect(pickDroppedFile([txt])).toBe(txt);
    expect(pickDroppedFile([])).toBeNull();
    expect(pickDroppedFile(null)).toBeNull();
  });

  it('Projektname aus Dateiname', () => {
    expect(projectNameFromFile('Urlaub 2024.JPG', 'Mosaik')).toBe('Urlaub 2024');
    expect(projectNameFromFile('.jpg', 'Mosaik')).toBe('Mosaik');
    expect(projectNameFromFile(undefined, 'Mosaik')).toBe('Mosaik');
  });
});

describe('Texte (de/en/tr)', () => {
  it('Datenschutzhinweis ohne Fachbegriff „IndexedDB“', () => {
    for (const lang of ['de', 'en', 'tr'] as const) expect(dictionaries[lang]['home.privacy']).not.toMatch(/IndexedDB/i);
  });

  it('Kurzbezeichnungen der Navigation in allen Sprachen', () => {
    const want = {
      de: ['Start', 'Projekte', 'Material', 'Einstellungen'],
      en: ['Home', 'Projects', 'Materials', 'Settings'],
      tr: ['Ana sayfa', 'Projeler', 'Malzeme', 'Ayarlar'],
    };
    for (const lang of ['de', 'en', 'tr'] as const) {
      const d = dictionaries[lang] as Record<string, string>;
      expect(['home', 'projects', 'materials', 'settings'].map((k) => d[`nav.${k}Short`])).toEqual(want[lang]);
    }
  });

  it('Lesefehler nennt JPG und HEIC; Startseite heißt „Beispielprojekte“', () => {
    for (const lang of ['de', 'en', 'tr'] as const) {
      const d = dictionaries[lang] as Record<string, string>;
      expect(d['home.err.decode']).toMatch(/JPG/);
      expect(d['home.err.decode']).toMatch(/HEIC/);
      expect(d['home.err.heic']).toMatch(/HEIC/);
      expect(d['home.err.decode']).toContain('{name}');
    }
    const de = dictionaries.de as Record<string, string>;
    expect(de['home.samples']).toBe('Beispielprojekte');
    expect(de['home.cta']).toBe('Foto auswählen und loslegen');
    expect(de['home.samplesHint']).toMatch(/[Ss]ynthetische Testbilder/);
  });
});
