/**
 * w7-docs-e2e: Prüfungen der Erweiterungsdateien src/i18n/ext/*.ts.
 *
 * src/i18n/index.ts legt alle Erweiterungsdateien nacheinander (Object.assign) über die Grundwörterbücher. Definieren
 * zwei Dateien denselben Schlüssel, entscheidet still die Lade-Reihenfolge, welcher Text erscheint – das ist hier
 * verboten. Außerdem muss jede Datei für sich in DE, EN und TR dieselben Schlüssel und Platzhalter haben (tests/i18n.test.ts
 * prüft das nur für das zusammengeführte Ergebnis, wo eine fehlende Übersetzung vom Grundtext verdeckt würde).
 */
import { describe, expect, it } from 'vitest';
import { dictionaries } from '../src/i18n';

type ExtModule = { de?: Record<string, string>; en?: Record<string, string>; tr?: Record<string, string> };

const modules = import.meta.glob<ExtModule>('../src/i18n/ext/*.ts', { eager: true });
const LANGS = ['de', 'en', 'tr'] as const;
const name = (p: string) => p.replace(/^.*\//, '');
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

describe('i18n-Erweiterungsdateien (src/i18n/ext)', () => {
  it('es gibt Erweiterungsdateien, jede exportiert de, en und tr', () => {
    const entries = Object.entries(modules);
    expect(entries.length).toBeGreaterThan(10);
    const bad = entries.filter(([, m]) => LANGS.some((l) => typeof m[l] !== 'object' || m[l] === null)).map(([p]) => name(p));
    expect(bad).toEqual([]);
  });

  it('keine zwei Dateien definieren (überschreiben) denselben Schlüssel', () => {
    const dups: string[] = [];
    for (const lang of LANGS) {
      const owner = new Map<string, string[]>();
      for (const [p, m] of Object.entries(modules)) {
        for (const k of Object.keys(m[lang] ?? {})) owner.set(k, [...(owner.get(k) ?? []), name(p)]);
      }
      for (const [k, files] of owner) if (files.length > 1) dups.push(`${lang}:${k} → ${files.join(', ')}`);
    }
    expect(dups).toEqual([]);
  });

  it('jede Datei: gleiche Schlüssel in DE, EN und TR', () => {
    const bad: string[] = [];
    for (const [p, m] of Object.entries(modules)) {
      const de = Object.keys(m.de ?? {});
      for (const lang of ['en', 'tr'] as const) {
        const other = m[lang] ?? {};
        for (const k of de) if (!(k in other)) bad.push(`${name(p)}: ${lang} fehlt ${k}`);
        for (const k of Object.keys(other)) if (!(k in (m.de ?? {}))) bad.push(`${name(p)}: ${lang} hat zusätzlich ${k}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('jede Datei: gleiche Platzhalter in DE, EN und TR, keine leeren Texte', () => {
    const bad: string[] = [];
    for (const [p, m] of Object.entries(modules)) {
      for (const [k, v] of Object.entries(m.de ?? {})) {
        for (const lang of LANGS) {
          const s = m[lang]?.[k];
          if (typeof s !== 'string' || s.trim() === '') {
            bad.push(`${name(p)}: ${lang}:${k} leer`);
            continue;
          }
          if (placeholders(s) !== placeholders(v)) bad.push(`${name(p)}: ${lang}:${k} {${placeholders(s)}} ≠ de {${placeholders(v)}}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('jeder Text einer Erweiterungsdatei ist der, der zur Laufzeit gilt', () => {
    const bad: string[] = [];
    for (const [p, m] of Object.entries(modules)) {
      for (const lang of LANGS) {
        const d = dictionaries[lang] as Record<string, string>;
        for (const [k, v] of Object.entries(m[lang] ?? {})) if (d[k] !== v) bad.push(`${name(p)}: ${lang}:${k}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
