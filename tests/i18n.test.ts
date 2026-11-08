import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dictionaries } from '../src/i18n';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

describe('Übersetzungen', () => {
  it('alle verwendeten Schlüssel existieren in DE, EN und TR', () => {
    const used = new Set<string>();
    for (const f of files('src')) {
      if (f.includes('i18n')) continue;
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.\-]+)'/g)) used.add(m[1]);
      // Texte mit Anzahl: tCount(t, 'schlüssel', n, …)
      for (const m of src.matchAll(/\btCount\(\s*\w+\s*,\s*'([a-zA-Z0-9_.\-]+)'/g)) used.add(m[1]);
    }
    const dynamic = [
      ...['photo', 'size', 'tiles', 'joint', 'colors', 'shapes', 'compute', 'preview', 'plan', 'pdf'].flatMap((s) => [`step.${s}`, `step.${s}.intro`]),
      ...['square', 'rectangle', 'triangle', 'rhombus', 'trapezoid', 'parallelogram', 'custom'].map((s) => `shape.${s}`),
      ...['glass', 'ceramic', 'smalti', 'stone', 'other'].map((s) => `mat.${s}`),
      ...['N', 'E', 'S', 'W'].map((s) => `dir.${s}`),
      ...['whole', 'cut-end', 'cut-both'].flatMap((s) => [`size.edge.${s}`, `size.edge.${s}.hint`]),
      ...['auto', 'auto-snap', 'materials', 'custom'].flatMap((s) => [`colors.mode.${s}`, `colors.mode.${s}.hint`]),
      ...['prepare', 'adjust', 'lab', 'analyze', 'palette', 'assign'].map((s) => `compute.phase.${s}`),
      ...['no-materials', 'no-palette'].map((s) => `compute.err.${s}`),
      ...['line-outside', 'too-small', 'use-setFreePieces'].map((s) => `edit.err.${s}`),
      ...['portrait', 'landscape', 'animal', 'city'].map((s) => `sample.${s}`),
      ...['face', 'detail'].map((s) => `shapes.region.${s}`),
      ...['cover', 'original', 'preview', 'overview', 'sheets', 'legend', 'materials', 'templates', 'coords', 'counts', 'pages'].map((s) => `pdfui.c.${s}`),
    ];
    for (const k of dynamic) used.add(k);
    const missing: string[] = [];
    for (const lang of ['de', 'en', 'tr'] as const) {
      const d = dictionaries[lang] as Record<string, string>;
      for (const k of used) if (!d[k]) missing.push(`${lang}:${k}`);
    }
    expect(missing).toEqual([]);
  });

  it('Erweiterungsdateien: gleiche Schlüssel in DE, EN und TR', () => {
    const de = Object.keys(dictionaries.de).sort();
    expect(Object.keys(dictionaries.en).sort()).toEqual(de);
    expect(Object.keys(dictionaries.tr).sort()).toEqual(de);
  });

  it('englische und türkische Texte ohne deutsche Anführungszeichen „…“ (Türkisch: “…”)', () => {
    const bad: string[] = [];
    for (const lang of ['en', 'tr'] as const) {
      for (const [k, v] of Object.entries(dictionaries[lang] as Record<string, string>)) if (v.includes('„')) bad.push(`${lang}:${k}`);
    }
    expect(bad).toEqual([]);
  });

  it('gleiche Platzhalter in allen Sprachen', () => {
    const de = dictionaries.de as Record<string, string>;
    for (const lang of ['en', 'tr'] as const) {
      const d = dictionaries[lang] as Record<string, string>;
      for (const [k, v] of Object.entries(de)) {
        const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
        expect(`${lang}:${k}:${ph(d[k])}`).toBe(`${lang}:${k}:${ph(v)}`);
      }
    }
  });
});
