/**
 * Farbnamen für automatisch erzeugte Palettenfarben.
 *
 * - Ein Lab-Wert erhält den Namen der nächstgelegenen Referenzfarbe (CIEDE2000) aus einer kuratierten
 *   Tabelle typischer Mosaik-, Porträt- und Landschaftsfarben. Unbunte Farben (C* < 6) werden nur nach
 *   Helligkeit benannt (Weiß … Schwarz), damit Grau nie einen Farbstich-Namen bekommt.
 * - Gespeichert wird ein sprachneutraler Schlüssel (`nameKey`) und ggf. ein Zusatz (`nameSuffix`).
 *   Daraus entsteht der Name in jeder UI-Sprache (de/en/tr) – automatische Namen folgen der Sprache.
 * - Mehrere automatische Farben mit demselben Schlüssel werden unterscheidbar gemacht: zwei oder drei
 *   deutlich verschieden helle Farben erhalten „hell/mittel/dunkel“, sonst eine laufende Nummer
 *   (nach Helligkeit, die hellste zuerst). Material- und vom Benutzer eingegebene Namen werden nie verändert.
 *
 * Die Namen sind reine Beschriftungen: Farbnummern, HEX/Lab, Stückzahlen und Geometrie hängen nicht davon ab.
 */
import { deltaE2000, hexToLab, type ColorNameLang, type Lab } from './color';

/** Zusatz zur Unterscheidung gleichnamiger automatischer Farben: relative Helligkeit oder laufende Nummer (ab 1). */
export type NameSuffix = 'light' | 'medium' | 'dark' | number;

interface NameEntry {
  de: string;
  en: string;
  tr: string;
  /**
   * Der Name enthält bereits ein Helligkeitswort („Hellblau“, „Hautton dunkel“) – gleichnamige Farben
   * werden dann nummeriert statt „Hellblau (hell)“.
   */
  toned?: true;
}

/** Alle Namensschlüssel mit Übersetzung (je Sprache eindeutig, siehe Test). */
export const COLOR_NAMES: Record<string, NameEntry> = {
  // ---- unbunt
  white: { de: 'Weiß', en: 'White', tr: 'Beyaz' },
  cream: { de: 'Creme', en: 'Cream', tr: 'Krem' },
  lightgray: { de: 'Hellgrau', en: 'Light grey', tr: 'Açık gri', toned: true },
  gray: { de: 'Grau', en: 'Grey', tr: 'Gri' },
  darkgray: { de: 'Dunkelgrau', en: 'Dark grey', tr: 'Koyu gri', toned: true },
  anthracite: { de: 'Anthrazit', en: 'Anthracite', tr: 'Antrasit' },
  black: { de: 'Schwarz', en: 'Black', tr: 'Siyah' },
  // ---- Rot
  red: { de: 'Rot', en: 'Red', tr: 'Kırmızı' },
  darkred: { de: 'Dunkelrot', en: 'Dark red', tr: 'Koyu kırmızı', toned: true },
  wine: { de: 'Weinrot', en: 'Wine red', tr: 'Bordo' },
  carmine: { de: 'Karminrot', en: 'Carmine', tr: 'Karmin' },
  coral: { de: 'Koralle', en: 'Coral', tr: 'Mercan' },
  salmon: { de: 'Lachs', en: 'Salmon', tr: 'Somon' },
  // ---- Rosa / Magenta
  rose: { de: 'Rosa', en: 'Rose', tr: 'Pembe' },
  oldrose: { de: 'Altrosa', en: 'Old rose', tr: 'Gül kurusu' },
  pink: { de: 'Pink', en: 'Pink', tr: 'Canlı pembe' },
  magenta: { de: 'Magenta', en: 'Magenta', tr: 'Macenta' },
  raspberry: { de: 'Himbeere', en: 'Raspberry', tr: 'Ahududu' },
  // ---- Orange / Erdtöne
  orange: { de: 'Orange', en: 'Orange', tr: 'Turuncu' },
  lightorange: { de: 'Hellorange', en: 'Light orange', tr: 'Açık turuncu', toned: true },
  terracotta: { de: 'Terrakotta', en: 'Terracotta', tr: 'Kiremit' },
  rust: { de: 'Rostbraun', en: 'Rust', tr: 'Pas rengi' },
  apricot: { de: 'Apricot', en: 'Apricot', tr: 'Kayısı' },
  peach: { de: 'Pfirsich', en: 'Peach', tr: 'Şeftali' },
  // ---- Gelb
  yellow: { de: 'Gelb', en: 'Yellow', tr: 'Sarı' },
  lightyellow: { de: 'Hellgelb', en: 'Light yellow', tr: 'Açık sarı', toned: true },
  lemon: { de: 'Zitronengelb', en: 'Lemon', tr: 'Limon sarısı' },
  golden: { de: 'Goldgelb', en: 'Golden yellow', tr: 'Altın sarısı' },
  honey: { de: 'Honiggelb', en: 'Honey', tr: 'Bal rengi' },
  ochre: { de: 'Ocker', en: 'Ochre', tr: 'Toprak sarısı' },
  mustard: { de: 'Senfgelb', en: 'Mustard', tr: 'Hardal' },
  // ---- Beige / Haut
  beige: { de: 'Beige', en: 'Beige', tr: 'Bej' },
  sand: { de: 'Sand', en: 'Sand', tr: 'Kum rengi' },
  skin_light: { de: 'Hautton hell', en: 'Skin tone light', tr: 'Açık ten rengi', toned: true },
  skin_medium: { de: 'Hautton mittel', en: 'Skin tone medium', tr: 'Orta ten rengi', toned: true },
  skin_dark: { de: 'Hautton dunkel', en: 'Skin tone dark', tr: 'Koyu ten rengi', toned: true },
  // ---- Braun
  caramel: { de: 'Karamell', en: 'Caramel', tr: 'Karamel' },
  lightbrown: { de: 'Hellbraun', en: 'Light brown', tr: 'Açık kahve', toned: true },
  brown: { de: 'Braun', en: 'Brown', tr: 'Kahverengi' },
  darkbrown: { de: 'Dunkelbraun', en: 'Dark brown', tr: 'Koyu kahve', toned: true },
  chocolate: { de: 'Schokobraun', en: 'Chocolate', tr: 'Çikolata' },
  taupe: { de: 'Taupe', en: 'Taupe', tr: 'Vizon' },
  // ---- Grün
  olive: { de: 'Oliv', en: 'Olive', tr: 'Zeytin' },
  olivegreen: { de: 'Olivgrün', en: 'Olive green', tr: 'Zeytin yeşili' },
  yellowgreen: { de: 'Gelbgrün', en: 'Yellow green', tr: 'Fıstık yeşili' },
  lightgreen: { de: 'Hellgrün', en: 'Light green', tr: 'Açık yeşil', toned: true },
  green: { de: 'Grün', en: 'Green', tr: 'Yeşil' },
  darkgreen: { de: 'Dunkelgrün', en: 'Dark green', tr: 'Koyu yeşil', toned: true },
  firgreen: { de: 'Tannengrün', en: 'Fir green', tr: 'Çam yeşili' },
  sage: { de: 'Salbeigrün', en: 'Sage', tr: 'Adaçayı yeşili' },
  mint: { de: 'Mint', en: 'Mint', tr: 'Nane yeşili' },
  emerald: { de: 'Smaragdgrün', en: 'Emerald', tr: 'Zümrüt yeşili' },
  // ---- Türkis
  turquoise: { de: 'Türkis', en: 'Turquoise', tr: 'Turkuaz' },
  lightturquoise: { de: 'Helltürkis', en: 'Light turquoise', tr: 'Açık turkuaz', toned: true },
  petrol: { de: 'Petrol', en: 'Petrol', tr: 'Petrol mavisi' },
  // ---- Blau
  iceblue: { de: 'Eisblau', en: 'Ice blue', tr: 'Buz mavisi' },
  lightblue: { de: 'Hellblau', en: 'Light blue', tr: 'Açık mavi', toned: true },
  skyblue: { de: 'Himmelblau', en: 'Sky blue', tr: 'Gök mavisi' },
  blue: { de: 'Blau', en: 'Blue', tr: 'Mavi' },
  royalblue: { de: 'Königsblau', en: 'Royal blue', tr: 'Saks mavisi' },
  darkblue: { de: 'Dunkelblau', en: 'Dark blue', tr: 'Koyu mavi', toned: true },
  navy: { de: 'Marineblau', en: 'Navy', tr: 'Lacivert' },
  steelblue: { de: 'Stahlblau', en: 'Steel blue', tr: 'Çelik mavisi' },
  greyblue: { de: 'Graublau', en: 'Grey blue', tr: 'Gri mavi' },
  denim: { de: 'Jeansblau', en: 'Denim', tr: 'Kot mavisi' },
  // ---- Violett
  violet: { de: 'Violett', en: 'Violet', tr: 'Mor' },
  lilac: { de: 'Flieder', en: 'Lilac', tr: 'Leylak' },
  lavender: { de: 'Lavendel', en: 'Lavender', tr: 'Lavanta' },
  purple: { de: 'Purpur', en: 'Purple', tr: 'Erguvan' },
  plum: { de: 'Pflaume', en: 'Plum', tr: 'Mürdüm' },
  aubergine: { de: 'Aubergine', en: 'Aubergine', tr: 'Patlıcan moru' },
};

/**
 * Referenzfarben (sRGB) je Schlüssel. Ein Schlüssel kann mehrere Anker haben (z. B. reines und
 * gedecktes Rot), damit die nächstgelegene Referenz auch für extreme Bildschirmfarben passt.
 */
const ANCHORS: [key: string, hex: string][] = [
  // unbunt (auch im Vergleich, damit fast unbunte Farben grau heißen können)
  ['white', '#FFFFFF'],
  ['cream', '#F3EBD6'],
  ['cream', '#FFF8E1'],
  ['cream', '#EDE3D3'],
  ['lightgray', '#C8C8C8'],
  ['gray', '#8C8C8C'],
  ['darkgray', '#5A5A5A'],
  ['anthracite', '#383838'],
  ['black', '#121212'],
  // Rot
  ['red', '#FF0000'],
  ['red', '#D81E1E'],
  ['red', '#C41E24'],
  ['darkred', '#8B0000'],
  ['darkred', '#8E1A1A'],
  ['wine', '#6E1423'],
  ['wine', '#58101C'],
  ['carmine', '#A8102E'],
  ['coral', '#F27060'],
  ['salmon', '#F49A82'],
  ['salmon', '#E8907A'],
  // Rosa / Magenta
  ['rose', '#F6B6C4'],
  ['rose', '#F0A0B4'],
  ['oldrose', '#C48A8E'],
  ['oldrose', '#B87A80'],
  ['pink', '#F0408A'],
  ['pink', '#FF69B4'],
  ['magenta', '#FF00FF'],
  ['magenta', '#C0207C'],
  ['raspberry', '#B03060'],
  // Orange / Erdtöne
  ['orange', '#FFA500'],
  ['orange', '#FF8000'],
  ['orange', '#F06A10'],
  ['lightorange', '#FFC070'],
  ['terracotta', '#BC5A3C'],
  ['terracotta', '#C8643C'],
  ['rust', '#8E3A1C'],
  ['rust', '#9C4220'],
  ['apricot', '#F7B37A'],
  ['peach', '#FAD0B0'],
  // Gelb
  ['yellow', '#FFFF00'],
  ['yellow', '#FFE020'],
  ['yellow', '#F4D82C'],
  ['lightyellow', '#FFF4A0'],
  ['lightyellow', '#FFF4C2'],
  ['lemon', '#F2F040'],
  ['golden', '#F5B800'],
  ['golden', '#E8A800'],
  ['honey', '#E8C070'],
  ['ochre', '#C89428'],
  ['ochre', '#B8862C'],
  ['mustard', '#C8A41C'],
  // Beige / Haut
  ['beige', '#DCC8A8'],
  ['beige', '#D2BC98'],
  ['sand', '#C8B088'],
  ['skin_light', '#F2D2BC'],
  ['skin_light', '#EEC6A8'],
  ['skin_medium', '#D9A27E'],
  ['skin_medium', '#CF9670'],
  ['skin_dark', '#A86C4A'],
  ['skin_dark', '#93603E'],
  // Braun
  ['caramel', '#C08040'],
  ['caramel', '#B4783C'],
  ['lightbrown', '#A87C58'],
  ['brown', '#8B4513'],
  ['brown', '#7A4A2C'],
  ['brown', '#6E4428'],
  ['darkbrown', '#4A2C1A'],
  ['darkbrown', '#3E2618'],
  ['chocolate', '#5A3020'],
  ['taupe', '#8C7C6C'],
  ['taupe', '#A09080'],
  // Grün
  ['olive', '#808000'],
  ['olive', '#6E6A28'],
  ['olivegreen', '#556B2F'],
  ['olivegreen', '#5E6E34'],
  ['yellowgreen', '#9ACD32'],
  ['yellowgreen', '#B4D040'],
  ['lightgreen', '#90E090'],
  ['lightgreen', '#A8D8A0'],
  ['green', '#008000'],
  ['green', '#00C000'],
  ['green', '#2E9A3C'],
  ['darkgreen', '#0E4A1C'],
  ['darkgreen', '#1E4A28'],
  ['firgreen', '#24503C'],
  ['sage', '#94A88C'],
  ['sage', '#7E9478'],
  ['mint', '#A8E4C8'],
  ['emerald', '#10A070'],
  // Türkis
  ['turquoise', '#30C0B8'],
  ['turquoise', '#00E0E0'],
  ['turquoise', '#00B4C0'],
  ['lightturquoise', '#9CE4E0'],
  ['petrol', '#1C6070'],
  ['petrol', '#1A5260'],
  // Blau
  ['iceblue', '#D4ECF8'],
  ['lightblue', '#A4C8F0'],
  ['lightblue', '#9CC4E4'],
  ['skyblue', '#5AA8E8'],
  ['skyblue', '#78B4E0'],
  ['blue', '#0000FF'],
  ['blue', '#1E50D0'],
  ['blue', '#2A5CB8'],
  ['royalblue', '#3050C8'],
  ['royalblue', '#4169E1'],
  ['darkblue', '#102878'],
  ['darkblue', '#1C2E6C'],
  ['navy', '#000080'],
  ['navy', '#1A2448'],
  ['navy', '#202A40'],
  ['steelblue', '#4682B4'],
  ['steelblue', '#3C5670'],
  ['greyblue', '#7088A0'],
  ['greyblue', '#8CA0B4'],
  ['denim', '#3C6496'],
  // Violett
  ['violet', '#8000FF'],
  ['violet', '#7A3CA8'],
  ['lilac', '#C0A0DC'],
  ['lilac', '#B49CC8'],
  ['lavender', '#DCD0F0'],
  ['purple', '#800080'],
  ['purple', '#8C1C6C'],
  ['plum', '#6C3050'],
  ['aubergine', '#3E1C3A'],
  ['aubergine', '#4A2040'],
];

/** C*-Grenze für unbunte Farben (Grautöne). */
export const ACHROMATIC_CHROMA = 6;

let anchorLab: { key: string; lab: Lab }[] | null = null;
/** Lab der Referenzfarben – erst beim ersten Aufruf berechnet (zirkulärer Import mit color.ts). */
function anchors(): { key: string; lab: Lab }[] {
  if (!anchorLab) anchorLab = ANCHORS.map(([key, hex]) => ({ key, lab: hexToLab(hex) }));
  return anchorLab;
}

/** Alle Referenzfarben (für Tests und Dokumentation). */
export function colorNameAnchors(): readonly { key: string; hex: string }[] {
  return ANCHORS.map(([key, hex]) => ({ key, hex }));
}

/** Namensschlüssel eines Lab-Werts: unbunt nach L*, sonst nächste Referenzfarbe nach CIEDE2000. */
export function nameKeyFor(lab: Lab): string {
  const [L, a, b] = lab;
  const C = Math.sqrt(a * a + b * b);
  if (C < ACHROMATIC_CHROMA) {
    if (L > 92) return 'white';
    if (L > 82 && b > 3) return 'cream';
    if (L > 70) return 'lightgray';
    if (L > 45) return 'gray';
    if (L > 30) return 'darkgray';
    if (L > 16) return 'anthracite';
    return 'black';
  }
  let best = 'gray';
  let bd = Infinity;
  for (const r of anchors()) {
    const d = deltaE2000(L, a, b, r.lab[0], r.lab[1], r.lab[2]);
    if (d < bd) {
      bd = d;
      best = r.key;
    }
  }
  return best;
}

/** Grundname eines Schlüssels in der Sprache (unbekannter Schlüssel → null). */
export function baseColorName(key: string, lang: ColorNameLang): string | null {
  const e = COLOR_NAMES[key];
  return e ? e[lang] : null;
}

const SUFFIX_WORDS: Record<ColorNameLang, Record<'light' | 'medium' | 'dark', string>> = {
  de: { light: 'hell', medium: 'mittel', dark: 'dunkel' },
  en: { light: 'light', medium: 'medium', dark: 'dark' },
  tr: { light: 'açık', medium: 'orta', dark: 'koyu' },
};

/** Name aus Schlüssel und Zusatz, z. B. „Rot (hell)“, „Hellblau 2“, „Red (dark)“, „Kırmızı (açık)“. */
export function formatAutoName(key: string, suffix: NameSuffix | undefined, lang: ColorNameLang): string | null {
  const base = baseColorName(key, lang);
  if (base === null) return null;
  if (suffix === undefined) return base;
  if (typeof suffix === 'number') return `${base} ${suffix}`;
  return `${base} (${SUFFIX_WORDS[lang][suffix]})`;
}

/** Automatischer Name eines Lab-Werts (ohne Zusatz). */
export function autoColorName(lab: Lab, lang: ColorNameLang = 'de'): string {
  return formatAutoName(nameKeyFor(lab), undefined, lang) as string;
}

/** Felder einer Palettenfarbe, die für die Namensgebung zählen. */
export interface NamedColor {
  name: string;
  lab: Lab;
  nameKey?: string;
  nameSuffix?: NameSuffix;
  materialId?: string;
}

/**
 * Anzeigename einer Palettenfarbe in der UI-Sprache: automatische Namen (nameKey) werden übersetzt,
 * Material- und Benutzernamen unverändert angezeigt.
 */
export function paletteDisplayName(p: Pick<NamedColor, 'name' | 'nameKey' | 'nameSuffix'>, lang: ColorNameLang): string {
  if (p.nameKey) {
    const s = formatAutoName(p.nameKey, p.nameSuffix, lang);
    if (s !== null) return s;
  }
  return p.name;
}

/** Mindestabstand in L*, ab dem „hell/mittel/dunkel“ ehrlich unterscheidet (sonst laufende Nummer). */
export const TONE_MIN_GAP_L = 3;

const norm = (s: string) => s.trim().toLocaleLowerCase();

/**
 * Macht die automatischen Namen einer Palette eindeutig und setzt sie in der Sprache `lang`.
 * Nur Einträge mit nameKey werden verändert (Material- und Benutzernamen nie).
 *  - Gruppen gleicher Schlüssel werden nach L* sortiert (hellste zuerst, bei Gleichstand Palettenreihenfolge).
 *  - 2–3 Einträge, deren L* sich jeweils um mindestens TONE_MIN_GAP_L unterscheidet, und deren Name noch kein
 *    Helligkeitswort enthält: „(hell)“, „(mittel)“, „(dunkel)“.
 *  - sonst eine laufende Nummer 1, 2, … (Nummern, deren Name ein Benutzer-/Materialname belegt, werden übersprungen).
 *  - Ein einzelner Eintrag bleibt ohne Zusatz – außer sein Name ist schon als Benutzer-/Materialname vergeben.
 * Liefert dasselbe Array, wenn sich nichts ändert.
 */
export function uniqueAutoNames<T extends NamedColor>(palette: T[], lang: ColorNameLang): T[] {
  const taken = new Set<string>();
  for (const p of palette) if (!p.nameKey || !COLOR_NAMES[p.nameKey]) taken.add(norm(p.name));
  const groups = new Map<string, number[]>();
  palette.forEach((p, i) => {
    if (!p.nameKey || !COLOR_NAMES[p.nameKey]) return;
    const g = groups.get(p.nameKey);
    if (g) g.push(i);
    else groups.set(p.nameKey, [i]);
  });
  const suffix = new Map<number, NameSuffix | undefined>();
  for (const [key, idx] of groups) {
    idx.sort((x, y) => palette[y].lab[0] - palette[x].lab[0] || x - y);
    const free = (s: NameSuffix | undefined) => !taken.has(norm(formatAutoName(key, s, lang) as string));
    let plan: (NameSuffix | undefined)[] | null = null;
    if (idx.length === 1) {
      if (free(undefined)) plan = [undefined];
    } else if (idx.length <= 3 && !COLOR_NAMES[key].toned) {
      let gapsOk = true;
      for (let k = 1; k < idx.length; k++) if (palette[idx[k - 1]].lab[0] - palette[idx[k]].lab[0] < TONE_MIN_GAP_L) gapsOk = false;
      const words: NameSuffix[] = idx.length === 2 ? ['light', 'dark'] : ['light', 'medium', 'dark'];
      if (gapsOk && words.every(free)) plan = words;
    }
    if (!plan) {
      plan = [];
      let n = 1;
      for (let k = 0; k < idx.length; k++) {
        while (!free(n)) n++;
        plan.push(n++);
      }
    }
    idx.forEach((i, k) => suffix.set(i, plan![k]));
  }
  let changed = false;
  const out = palette.map((p, i) => {
    if (!suffix.has(i)) return p;
    const s = suffix.get(i);
    const name = formatAutoName(p.nameKey!, s, lang) as string;
    if (p.name === name && p.nameSuffix === s) return p;
    changed = true;
    const next = { ...p, name };
    if (s === undefined) delete next.nameSuffix;
    else next.nameSuffix = s;
    return next;
  });
  return changed ? out : palette;
}

/**
 * Erkennt einen automatisch erzeugten Namen an seinem Text (für Paletten ohne nameKey: ältere Projekte,
 * oder wenn ein Aufrufer den Schlüssel nicht weitergereicht hat). Automatisch ist ein Name nur, wenn er
 * – in DE, EN oder TR – genau dem Namen entspricht, den die App für dieses Lab erzeugt (mit oder ohne
 * Zusatz) bzw. mit `legacy` dem Namen der früheren Benennung (legacyDescribeColor).
 */
export function inferAutoName(name: string, lab: Lab, opts: { legacy?: boolean } = {}): { key: string; suffix?: NameSuffix } | null {
  const key = nameKeyFor(lab);
  const langs: ColorNameLang[] = ['de', 'en', 'tr'];
  for (const lang of langs) {
    const base = baseColorName(key, lang) as string;
    if (name === base) return { key };
    if (name.startsWith(`${base} `)) {
      const rest = name.slice(base.length + 1);
      if (/^[1-9]\d{0,3}$/.test(rest)) return { key, suffix: Number(rest) };
      for (const s of ['light', 'medium', 'dark'] as const) if (rest === `(${SUFFIX_WORDS[lang][s]})`) return { key, suffix: s };
    }
  }
  if (opts.legacy) for (const lang of langs) if (name === legacyDescribeColor(lab, lang)) return { key };
  return null;
}

// ---------------------------------------------------------------- frühere Benennung (nur zur Erkennung alter Projekte)

const LEGACY_NAMES: Record<ColorNameLang, Record<string, string>> = {
  de: {
    white: 'Weiß', cream: 'Creme', lightgray: 'Hellgrau', gray: 'Grau', darkgray: 'Dunkelgrau', black: 'Schwarz',
    red: 'Rot', orange: 'Orange', yellow: 'Gelb', lime: 'Gelbgrün', green: 'Grün', teal: 'Türkis', cyan: 'Cyan',
    blue: 'Blau', violet: 'Violett', magenta: 'Magenta', pink: 'Rosa', brown: 'Braun', beige: 'Beige', skin: 'Hautton',
    olive: 'Oliv', light: 'Hell', dark: 'Dunkel', pale: 'Blass',
  },
  en: {
    white: 'White', cream: 'Cream', lightgray: 'Light grey', gray: 'Grey', darkgray: 'Dark grey', black: 'Black',
    red: 'Red', orange: 'Orange', yellow: 'Yellow', lime: 'Lime', green: 'Green', teal: 'Teal', cyan: 'Cyan',
    blue: 'Blue', violet: 'Violet', magenta: 'Magenta', pink: 'Pink', brown: 'Brown', beige: 'Beige', skin: 'Skin tone',
    olive: 'Olive', light: 'Light', dark: 'Dark', pale: 'Pale',
  },
  tr: {
    white: 'Beyaz', cream: 'Krem', lightgray: 'Açık gri', gray: 'Gri', darkgray: 'Koyu gri', black: 'Siyah',
    red: 'Kırmızı', orange: 'Turuncu', yellow: 'Sarı', lime: 'Fıstık yeşili', green: 'Yeşil', teal: 'Turkuaz', cyan: 'Camgöbeği',
    blue: 'Mavi', violet: 'Mor', magenta: 'Macenta', pink: 'Pembe', brown: 'Kahverengi', beige: 'Bej', skin: 'Ten rengi',
    olive: 'Zeytin', light: 'Açık', dark: 'Koyu', pale: 'Soluk',
  },
};

/**
 * Die frühere Benennung (bis Welle 2), unverändert. Sie wendete HSV-artige Farbtongrenzen auf CIELAB-Winkel an
 * (reines Rot hieß „Orange“) und wird nur noch gebraucht, um automatisch erzeugte Namen älterer Projekte zu erkennen.
 */
export function legacyDescribeColor(lab: Lab, lang: ColorNameLang = 'de'): string {
  const N = LEGACY_NAMES[lang];
  const [L, a, b] = lab;
  const C = Math.sqrt(a * a + b * b);
  let h = Math.atan2(b, a) / (Math.PI / 180);
  if (h < 0) h += 360;
  if (C < 8) {
    if (L > 92) return N.white;
    if (L > 82 && b > 3) return N.cream;
    if (L > 70) return N.lightgray;
    if (L > 45) return N.gray;
    if (L > 20) return N.darkgray;
    return N.black;
  }
  let base: string;
  if (h < 20 || h >= 345) base = L > 70 ? N.pink : N.red;
  else if (h < 50) {
    if (L < 55 && C < 50) base = N.brown;
    else if (L >= 55 && C < 40) base = N.skin;
    else base = N.orange;
  } else if (h < 75) {
    if (L < 50) base = N.brown;
    else if (C < 30) base = N.beige;
    else base = N.orange;
  } else if (h < 100) base = L < 50 ? N.olive : C < 25 ? N.beige : N.yellow;
  else if (h < 130) base = L < 45 ? N.olive : N.lime;
  else if (h < 170) base = N.green;
  else if (h < 210) base = N.teal;
  else if (h < 240) base = N.cyan;
  else if (h < 290) base = N.blue;
  else if (h < 320) base = N.violet;
  else base = L > 70 ? N.pink : N.magenta;
  let prefix = '';
  if (L > 75) prefix = N.light;
  else if (L < 35) prefix = N.dark;
  else if (C < 18) prefix = N.pale;
  if (!prefix) return base;
  if (lang === 'de') return prefix + base.toLowerCase();
  return `${prefix} ${base.toLowerCase()}`;
}
