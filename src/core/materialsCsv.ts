/**
 * Material-CSV: Export, robuster Import (deutsches/türkisches/englisches Excel) und Abgleich mit
 * vorhandenen Materialien. Reines Modul ohne DOM-, UI- oder i18n-Abhängigkeiten (testbar in Node).
 *
 * Grundsätze:
 * - Das Trennzeichen wird genau einmal bestimmt (optionale Zeile „sep=X“, sonst aus der Kopfzeile,
 *   gezählt nur außerhalb von Anführungszeichen, Vorrang ';' → Tab → ','). Es wird nur daran getrennt.
 * - Zahlen werden nie geraten: Mehrdeutige Werte (z. B. „1.250“ in „Stück/Packung“) werden nicht
 *   übernommen, sondern als Hinweis mit Zeilennummer gemeldet.
 * - Jede übersprungene oder fragwürdige Zeile wird mit Zeile und Grund gemeldet.
 * - Aktualisierungen behalten immer die vorhandene Material-ID (Projektpaletten verweisen per ID).
 */
import type { Material } from './types';

export type CsvLang = 'de' | 'en' | 'tr';
export type MaterialType = Material['type'];
/** Materialfelder mit CSV-Spalte: alle außer der Herkunft des Farbwerts (`colorSource` hat noch keine Spalte). */
export type CsvMaterialField = Exclude<keyof Material, 'colorSource'>;
/** Spalten, die der Import kennt: alle Materialfelder mit Spalte plus eine kombinierte Größenspalte („10×10×4“). */
export type CsvField = CsvMaterialField | 'size';

/** Reihenfolge der Spalten im Export (ID zuerst, damit ein erneuter Import eindeutig zuordnet). */
export const MATERIAL_CSV_FIELDS: CsvMaterialField[] = [
  'id',
  'type',
  'manufacturer',
  'product',
  'colorNumber',
  'colorName',
  'hex',
  'lengthMm',
  'widthMm',
  'thicknessMm',
  'price',
  'packageSize',
  'piecesPerPack',
  'stock',
  'notes',
];

/** Lokalisierte Spaltennamen für Export und Vorlage. */
export const MATERIAL_CSV_HEADERS: Record<CsvLang, Record<CsvMaterialField, string>> = {
  de: {
    id: 'ID',
    type: 'Materialart',
    manufacturer: 'Hersteller',
    product: 'Produkt',
    colorNumber: 'Farbnummer',
    colorName: 'Farbname',
    hex: 'HEX',
    lengthMm: 'Länge (mm)',
    widthMm: 'Breite (mm)',
    thicknessMm: 'Dicke (mm)',
    price: 'Preis je Packung',
    packageSize: 'Packungsgröße',
    piecesPerPack: 'Stück/Packung',
    stock: 'Bestand (Stück)',
    notes: 'Notiz',
  },
  en: {
    id: 'ID',
    type: 'Type',
    manufacturer: 'Manufacturer',
    product: 'Product',
    colorNumber: 'Colour number',
    colorName: 'Colour name',
    hex: 'HEX',
    lengthMm: 'Length (mm)',
    widthMm: 'Width (mm)',
    thicknessMm: 'Thickness (mm)',
    price: 'Price per pack',
    packageSize: 'Package size',
    piecesPerPack: 'Pieces per pack',
    stock: 'Stock (pieces)',
    notes: 'Notes',
  },
  tr: {
    id: 'ID',
    type: 'Malzeme türü',
    manufacturer: 'Üretici',
    product: 'Ürün',
    colorNumber: 'Renk numarası',
    colorName: 'Renk adı',
    hex: 'HEX',
    lengthMm: 'Uzunluk (mm)',
    widthMm: 'Genişlik (mm)',
    thicknessMm: 'Kalınlık (mm)',
    price: 'Paket fiyatı',
    packageSize: 'Paket boyutu',
    piecesPerPack: 'Paket başına adet',
    stock: 'Stok (adet)',
    notes: 'Not',
  },
};

/** Lokalisierte Materialarten im Export. */
export const MATERIAL_TYPE_WORDS: Record<CsvLang, Record<MaterialType, string>> = {
  de: { glass: 'Glas', ceramic: 'Keramik', smalti: 'Smalten', stone: 'Naturstein', other: 'Sonstiges' },
  en: { glass: 'Glass', ceramic: 'Ceramic', smalti: 'Smalti', stone: 'Natural stone', other: 'Other' },
  tr: { glass: 'Cam', ceramic: 'Seramik', smalti: 'Smalti', stone: 'Doğal taş', other: 'Diğer' },
};

/**
 * Kopfzeilen-Aliase (bereits normalisiert: Kleinbuchstaben, ohne Umlaute/Diakritika, ohne Leer- und
 * Sonderzeichen, ohne Einheiten in Klammern). Bewusst NICHT zugeordnet, weil mehrdeutig:
 * „Höhe“ (Länge oder Dicke?), „Anzahl“/„Stückzahl“ (Bestand oder Stück je Packung?), „Preis pro Stück“
 * (die App rechnet mit dem Preis je Packung).
 */
const HEADER_ALIASES: Record<CsvField, string[]> = {
  id: ['id', 'materialid', 'malzemeid'],
  type: ['materialart', 'art', 'typ', 'material', 'werkstoff', 'type', 'materialtype', 'kind', 'tur', 'malzemeturu', 'malzeme', 'cins'],
  manufacturer: ['hersteller', 'marke', 'fabrikat', 'manufacturer', 'brand', 'maker', 'make', 'uretici', 'marka'],
  product: ['produkt', 'produktname', 'serie', 'produktlinie', 'kollektion', 'product', 'productname', 'series', 'productline', 'collection', 'urun', 'urunadi', 'seri', 'koleksiyon'],
  colorNumber: [
    'farbnummer', 'farbnr', 'farbcode', 'farbkennung', 'artikelnummer', 'artikelnr', 'artnr',
    'colornumber', 'colournumber', 'colorno', 'colourno', 'colorcode', 'colourcode', 'code', 'sku', 'articlenumber',
    'renkno', 'renknumarasi', 'renkkodu', 'kod', 'urunkodu',
  ],
  colorName: ['farbe', 'farbname', 'farbbezeichnung', 'bezeichnung', 'name', 'colorname', 'colourname', 'color', 'colour', 'renk', 'renkadi', 'ad', 'isim'],
  hex: ['hex', 'hexcode', 'hexwert', 'farbwert', 'html', 'htmlfarbe', 'hexcolor', 'hexcolour', 'colorvalue', 'colourvalue', 'renkdegeri', 'hexkodu', 'hexrenk'],
  lengthMm: ['lange', 'laenge', 'lengthmm', 'length', 'l', 'uzunluk', 'boy'],
  widthMm: ['breite', 'widthmm', 'width', 'b', 'w', 'genislik', 'en'],
  thicknessMm: ['dicke', 'starke', 'staerke', 'materialstarke', 'thicknessmm', 'thickness', 'depth', 'd', 't', 'kalinlik'],
  price: ['preis', 'preisjepackung', 'preispropackung', 'packungspreis', 'kosten', 'price', 'priceperpack', 'packprice', 'cost', 'fiyat', 'paketfiyati', 'ucret', 'tutar'],
  packageSize: ['packung', 'packungsgrosse', 'verpackung', 'gebinde', 'inhalt', 'packagesize', 'package', 'pack', 'packsize', 'paket', 'paketboyutu', 'ambalaj'],
  piecesPerPack: [
    'stuckpackung', 'stuckjepackung', 'stuckpropackung', 'stkpackung', 'stkjepackung', 'anzahlpropackung', 'anzahljepackung',
    'piecesperpack', 'piecesperpackage', 'pcsperpack', 'pcspack', 'piecespack', 'perpack',
    'paketbasinaadet', 'adetpaket', 'paketadet', 'paketicindekiadet',
  ],
  stock: ['bestand', 'lagerbestand', 'vorrat', 'bestandstuck', 'stock', 'instock', 'onhand', 'inventory', 'stok', 'stokadet', 'mevcut'],
  notes: ['notiz', 'notizen', 'bemerkung', 'bemerkungen', 'kommentar', 'anmerkung', 'anmerkungen', 'notes', 'note', 'comment', 'comments', 'remarks', 'not', 'notlar', 'aciklama'],
  size: ['grosse', 'format', 'masse', 'mass', 'abmessung', 'abmessungen', 'steingrosse', 'size', 'dimensions', 'dimension', 'tilesize', 'boyut', 'ebat', 'olcu'],
};

const TYPE_ALIASES: Record<MaterialType, string[]> = {
  glass: ['glass', 'glas', 'cam', 'glasmosaik', 'mosaikglas', 'glassmosaic', 'cammozaik', 'vetro', 'verre'],
  ceramic: ['ceramic', 'ceramics', 'keramik', 'seramik', 'keramikmosaik', 'ceramicmosaic', 'porzellan', 'porcelain', 'porselen', 'feinsteinzeug'],
  smalti: ['smalti', 'smalten', 'smalto', 'smalt'],
  stone: ['stone', 'naturalstone', 'naturstein', 'stein', 'dogaltas', 'tas', 'marmor', 'marble', 'mermer', 'granit', 'granite', 'travertin', 'travertine'],
  other: ['other', 'sonstiges', 'sonstige', 'andere', 'anderes', 'diger', 'misc'],
};

/** Kleinbuchstaben, Umlaute/Diakritika entfernt (ä→a, ß→ss, ı/İ→i, ş→s, ğ→g, ç→c …). */
export function foldText(s: string): string {
  return s
    .replace(/[ßẞ]/g, 'ss')
    .replace(/[ıİ]/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const UNIT_TOKENS = new Set(['mm', 'cm', 'm', 'in', 'inch', 'inches', 'zoll', 'eur', 'euro', 'usd', 'tl', 'try', 'chf', 'gbp']);

function headerKey(h: string): string {
  const s = foldText(h)
    .replace(/[([{].*?[)\]}]/g, ' ')
    .replace(/[€$£₺"]/g, ' ');
  return s
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok && !UNIT_TOKENS.has(tok))
    .join('');
}

/** Einheit aus der Kopfzeile (nur für Maßspalten relevant). */
function headerUnit(h: string): 'mm' | 'cm' | 'other' | null {
  const f = foldText(h);
  const toks = new Set(f.split(/[^a-z]+/).filter(Boolean));
  if (toks.has('cm')) return 'cm';
  if (toks.has('mm')) return 'mm';
  if (['m', 'in', 'inch', 'inches', 'zoll'].some((x) => toks.has(x)) || f.includes('"')) return 'other';
  return null;
}

/** Alias → Feld und Rang (Position in der Aliasliste; kleiner = spezifischer, z. B. „Farbnummer“ vor „Code“). */
const ALIAS_TO_FIELD = (() => {
  const m = new Map<string, { field: CsvField; rank: number }>();
  for (const [field, list] of Object.entries(HEADER_ALIASES) as [CsvField, string[]][]) list.forEach((a, rank) => m.has(a) || m.set(a, { field, rank }));
  return m;
})();

const TYPE_LOOKUP = (() => {
  const m = new Map<string, MaterialType>();
  for (const [type, list] of Object.entries(TYPE_ALIASES) as [MaterialType, string[]][]) for (const a of list) m.set(a, type);
  return m;
})();

function matchHeaderRanked(h: string): { field: CsvField; rank: number } | null {
  if (/\bhex\b/.test(foldText(h).replace(/[^a-z0-9]+/g, ' '))) return { field: 'hex', rank: -1 };
  const k = headerKey(h);
  return k ? (ALIAS_TO_FIELD.get(k) ?? null) : null;
}

/** Ordnet einen Spaltennamen einem Feld zu (oder null). Exportiert für Tests. */
export function matchHeader(h: string): CsvField | null {
  return matchHeaderRanked(h)?.field ?? null;
}

/** Materialart aus einem Wort (de/en/tr oder interner Schlüssel); null = unbekannt. */
export function matchMaterialType(word: string): MaterialType | null {
  const k = foldText(word).replace(/[^a-z0-9]+/g, '');
  return TYPE_LOOKUP.get(k) ?? null;
}

// ---------------------------------------------------------------- Zeichensatz

export type CsvEncoding = 'UTF-8' | 'UTF-16LE' | 'UTF-16BE' | 'Windows-1252' | 'Windows-1254';

/**
 * Dekodiert eine CSV-Datei. Excel speichert „CSV (Trennzeichen-getrennt)“ ohne BOM im ANSI-Zeichensatz
 * (Windows-1252, türkisch Windows-1254), „CSV UTF-8“ mit BOM und „Unicode-Text“ als UTF-16 mit BOM.
 * Ohne BOM wird zuerst streng UTF-8 versucht; nur wenn das ungültig ist, wird ANSI verwendet.
 * Windows-1254 statt -1252, wenn die Bytes von ğ/Ğ/ı/İ/ş/Ş vorkommen (in -1252 isländische Buchstaben).
 */
export function decodeCsvBytes(bytes: Uint8Array): { text: string; encoding: CsvEncoding } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8' };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16LE' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16BE' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
  } catch {
    const turkish = bytes.some((b) => b === 0xd0 || b === 0xf0 || b === 0xdd || b === 0xfd || b === 0xde || b === 0xfe);
    const enc = turkish ? 'windows-1254' : 'windows-1252';
    return { text: new TextDecoder(enc).decode(bytes), encoding: turkish ? 'Windows-1254' : 'Windows-1252' };
  }
}

// ---------------------------------------------------------------- Export

function csvCell(s: string, delim: string): string {
  const needsQuote = s.includes(delim) || /["\r\n]/.test(s) || s !== s.trim();
  return needsQuote ? `"${s.replace(/"/g, '""')}"` : s;
}

function formatNumber(v: number, decimalComma: boolean): string {
  const s = String(v);
  return decimalComma ? s.replace('.', ',') : s;
}

export interface MaterialsCsvOptions {
  /** UTF-8-BOM voranstellen (Excel erkennt dann Umlaute). Standard: true */
  bom?: boolean;
}

/** Trennzeichen und Dezimalzeichen je Sprache (wie der Koordinaten-CSV-Export). */
export function csvFormatFor(lang: CsvLang): { delimiter: ';' | ','; decimalComma: boolean } {
  return lang === 'en' ? { delimiter: ',', decimalComma: false } : { delimiter: ';', decimalComma: true };
}

function materialCells(m: Partial<Material>, lang: CsvLang): string[] {
  const { delimiter, decimalComma } = csvFormatFor(lang);
  return MATERIAL_CSV_FIELDS.map((f) => {
    const v = m[f];
    let s: string;
    if (v === undefined || v === null) s = '';
    else if (f === 'type') s = MATERIAL_TYPE_WORDS[lang][v as MaterialType] ?? String(v);
    else if (typeof v === 'number') s = formatNumber(v, decimalComma);
    else s = String(v);
    return csvCell(s, delimiter);
  });
}

/**
 * Materialliste als CSV: lokalisierte Kopfzeile, ID-Spalte, ';' + Dezimalkomma (de/tr) bzw. ',' + Punkt (en).
 * Felder mit Trennzeichen, Anführungszeichen, Zeilenumbruch oder Rand-Leerzeichen werden in "…" gesetzt,
 * damit der erneute Import verlustfrei ist.
 */
export function materialsToCsv(list: Material[], lang: CsvLang = 'de', opts: MaterialsCsvOptions = {}): string {
  const { delimiter } = csvFormatFor(lang);
  const head = MATERIAL_CSV_FIELDS.map((f) => csvCell(MATERIAL_CSV_HEADERS[lang][f], delimiter)).join(delimiter);
  const body = list.map((m) => materialCells(m, lang).join(delimiter));
  return (opts.bom === false ? '' : '﻿') + [head, ...body].join('\r\n') + '\r\n';
}

const TEMPLATE_EXAMPLE: Record<CsvLang, Partial<Material>> = {
  de: {
    type: 'glass', manufacturer: 'Beispiel-Hersteller', product: 'Glasmosaik', colorNumber: 'B-001', colorName: 'Mittelblau', hex: '#3A6EA5',
    lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 12.5, packageSize: 'Beutel 100 Stück', piecesPerPack: 100, stock: 250,
    notes: 'Beispielzeile – bitte ersetzen oder löschen',
  },
  en: {
    type: 'glass', manufacturer: 'Example maker', product: 'Glass mosaic', colorNumber: 'B-001', colorName: 'Mid blue', hex: '#3A6EA5',
    lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 12.5, packageSize: 'Bag of 100', piecesPerPack: 100, stock: 250,
    notes: 'Example row – please replace or delete',
  },
  tr: {
    type: 'glass', manufacturer: 'Örnek üretici', product: 'Cam mozaik', colorNumber: 'B-001', colorName: 'Orta mavi', hex: '#3A6EA5',
    lengthMm: 10, widthMm: 10, thicknessMm: 4, price: 12.5, packageSize: '100 adetlik poşet', piecesPerPack: 100, stock: 250,
    notes: 'Örnek satır – lütfen değiştirin veya silin',
  },
};

/** Vorlage: lokalisierte Kopfzeile + eine als Beispiel gekennzeichnete Zeile im Exportformat (ID leer = neu). */
export function materialsCsvTemplate(lang: CsvLang = 'de', opts: MaterialsCsvOptions = {}): string {
  const { delimiter } = csvFormatFor(lang);
  const head = MATERIAL_CSV_FIELDS.map((f) => csvCell(MATERIAL_CSV_HEADERS[lang][f], delimiter)).join(delimiter);
  return (opts.bom === false ? '' : '﻿') + [head, materialCells(TEMPLATE_EXAMPLE[lang], lang).join(delimiter)].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- Import: Zerlegen

export type SkipReason = 'hex-missing' | 'hex-invalid' | 'too-many-columns' | 'unterminated-quote' | 'duplicate-in-file' | 'ambiguous-match';
export type WarnReason =
  | 'number-invalid'
  | 'number-negative'
  | 'thousands-separator'
  | 'ambiguous-number'
  | 'fraction'
  | 'size-unknown'
  | 'type-unknown'
  | 'id-invalid';

export const SKIP_REASONS: SkipReason[] = ['hex-missing', 'hex-invalid', 'too-many-columns', 'unterminated-quote', 'duplicate-in-file', 'ambiguous-match'];
export const WARN_REASONS: WarnReason[] = ['number-invalid', 'number-negative', 'thousands-separator', 'ambiguous-number', 'fraction', 'size-unknown', 'type-unknown', 'id-invalid'];

export interface CsvSkip {
  /** Zeilennummer in der Datei (1-basiert, Beginn des Datensatzes) */
  line: number;
  reason: SkipReason;
  /** Originalwert bzw. Zusatzangabe (z. B. Spaltenzahl, Anzahl Treffer) */
  value?: string;
  /** Bezugszeile (z. B. erste Zeile bei Duplikaten) bzw. Spaltenzahl der Kopfzeile */
  ref?: number;
}

export interface CsvWarning {
  line: number;
  field: CsvField;
  reason: WarnReason;
  /** Originalinhalt der Zelle */
  value: string;
}

export interface ParsedMaterialRow {
  line: number;
  /** ID aus der Datei (nur wenn gültig) */
  id?: string;
  /** Nur Felder, deren Spalte vorhanden und deren Wert gültig ist (leere Zelle = leerer Wert). */
  values: Partial<Omit<Material, 'id'>>;
}

export interface CsvColumn {
  index: number;
  header: string;
  field: CsvField;
  /** Umrechnungsfaktor nach mm (Maßspalten mit „(cm)“ = 10) */
  factor: number;
}

export type CsvDelimiter = ';' | '\t' | ',' | string;

export interface MaterialsCsvOk {
  ok: true;
  delimiter: CsvDelimiter;
  /** true, wenn die Datei per „sep=“-Zeile ihr Trennzeichen angibt */
  sepLine: boolean;
  /** Dezimalkomma zulässig (bei ';' und Tab) */
  decimalComma: boolean;
  headerLine: number;
  /** Zeilen vor der Kopfzeile (z. B. Titelzeile), werden ignoriert */
  leadingLines: number[];
  columns: CsvColumn[];
  /** Nicht erkannte Spaltennamen (werden ignoriert) */
  ignoredColumns: string[];
  /** Spalten, deren Feld schon durch eine frühere Spalte belegt ist (ignoriert) */
  duplicateColumns: string[];
  /** Maßspalten mit nicht unterstützter Einheit (z. B. „Länge (m)“, „Breite (inch)“) – ignoriert */
  unsupportedUnitColumns: string[];
  /** Materialfelder ohne Spalte in der Datei (ohne ID) */
  missingFields: CsvMaterialField[];
  /** Anzahl nicht leerer Datenzeilen */
  dataRows: number;
  rows: ParsedMaterialRow[];
  skipped: CsvSkip[];
  warnings: CsvWarning[];
}

export interface MaterialsCsvError {
  ok: false;
  error: 'empty' | 'no-header' | 'no-hex-column' | 'no-rows';
  delimiter: CsvDelimiter;
  /** erkannte Spalten (für die Fehlermeldung bei fehlender HEX-Spalte) */
  columns: CsvColumn[];
  headers: string[];
}

export type MaterialsCsvParse = MaterialsCsvOk | MaterialsCsvError;

interface RawRecord {
  line: number;
  cells: string[];
  quoted: boolean[];
  unterminated: boolean;
}

/** RFC-4180-Zerlegung an genau einem Trennzeichen. Anführungszeichen öffnen nur am Feldanfang. */
function tokenize(src: string, delim: string, firstLine: number): RawRecord[] {
  const out: RawRecord[] = [];
  let line = firstLine;
  let recLine = firstLine;
  let cells: string[] = [];
  let quoted: boolean[] = [];
  let field = '';
  let inQ = false;
  let wasQ = false;
  const endField = () => {
    cells.push(field);
    quoted.push(wasQ);
    field = '';
    wasQ = false;
  };
  const endRecord = (unterminated: boolean) => {
    endField();
    out.push({ line: recLine, cells, quoted, unterminated });
    cells = [];
    quoted = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else {
        field += ch;
        if (ch === '\n' || (ch === '\r' && src[i + 1] !== '\n')) line++;
      }
      continue;
    }
    if (ch === delim) endField();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRecord(false);
      line++;
      recLine = line;
    } else if (ch === '"' && !wasQ && field.trim() === '') {
      inQ = true;
      wasQ = true;
      field = '';
    } else if (wasQ && (ch === ' ' || ch === '\t')) {
      /* Leerraum nach schließendem Anführungszeichen ignorieren */
    } else field += ch;
  }
  if (inQ) endRecord(true);
  else if (field !== '' || cells.length) endRecord(false);
  return out;
}

/** Erste logische Zeile mit einem Kandidaten-Trennzeichen (außerhalb von Anführungszeichen) auswerten. */
function detectDelimiter(src: string): CsvDelimiter {
  let inQ = false;
  let counts = { ';': 0, '\t': 0, ',': 0 };
  let linesSeen = 0;
  for (let i = 0; i < src.length && linesSeen < 30; i++) {
    const ch = src[i];
    if (ch === '"') inQ = !inQ;
    else if (!inQ && (ch === ';' || ch === '\t' || ch === ',')) counts[ch]++;
    else if (!inQ && (ch === '\n' || ch === '\r')) {
      if (counts[';'] || counts['\t'] || counts[',']) break;
      counts = { ';': 0, '\t': 0, ',': 0 };
      linesSeen++;
    }
  }
  if (counts[';']) return ';';
  if (counts['\t']) return '\t';
  if (counts[',']) return ',';
  return ';';
}

type NumRes = { kind: 'empty' } | { kind: 'ok'; value: number } | { kind: 'err'; reason: WarnReason };

const CURRENCY = /^(€|eur|euro|\$|usd|£|gbp|₺|tl|try|chf|fr\.?)|(€|eur|euro|\$|usd|£|gbp|₺|tl|try|chf|fr\.?)$/gi;

/**
 * Zahl lesen, ohne zu raten.
 * - ';'/Tab-Dateien: ',' und '.' als Dezimalzeichen; ','-Dateien: nur '.'.
 * - „1.250,50“ / „1,250.50“ (Tausender + Dezimal, eindeutig) werden gelesen – außer in Ganzzahlfeldern.
 * - Nur Dreiergruppen („1.250“, „1,250“): in Ganzzahlfeldern immer ein Hinweis; in Dezimalfeldern nur dann
 *   eine Zahl, wenn das Zeichen das übliche Dezimalzeichen der Datei ist und nur eine Gruppe vorliegt.
 */
function parseNum(raw: string, o: { int: boolean; decimalComma: boolean; unit?: 'len' | 'price'; factor?: number }): NumRes {
  let s = raw.replace(/[\s  ]/g, '');
  if (s === '') return { kind: 'empty' };
  let factor = o.factor ?? 1;
  if (o.unit === 'len') {
    const m = /^(.*?)(mm|cm)$/i.exec(s);
    if (m) {
      s = m[1];
      factor = m[2].toLowerCase() === 'cm' ? 10 : 1;
    }
  } else if (o.unit === 'price') s = s.replace(CURRENCY, '');
  let neg = false;
  if (s.startsWith('-') || s.startsWith('−')) {
    neg = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) s = s.slice(1);
  if (s === '') return { kind: 'err', reason: 'number-invalid' };
  const primary = o.decimalComma ? ',' : '.';
  let v: number;
  if (/^\d+$/.test(s)) v = Number(s);
  else if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(s) || /^[1-9]\d{0,2}(,\d{3})+$/.test(s)) {
    if (o.int) return { kind: 'err', reason: 'thousands-separator' };
    const groups = s.split(/[.,]/).length - 1;
    if (groups === 1 && s.includes(primary)) v = Number(s.replace(',', '.'));
    else return { kind: 'err', reason: 'ambiguous-number' };
  } else if (/^[1-9]\d{0,2}(\.\d{3})+,\d+$/.test(s) && o.decimalComma) {
    if (o.int) return { kind: 'err', reason: 'thousands-separator' };
    v = Number(s.replace(/\./g, '').replace(',', '.'));
  } else if (/^[1-9]\d{0,2}(,\d{3})+\.\d+$/.test(s)) {
    if (o.int) return { kind: 'err', reason: 'thousands-separator' };
    v = Number(s.replace(/,/g, ''));
  } else if (/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) v = Number(s);
  else if (o.decimalComma && /^(\d+,?\d*|,\d+)(e[+-]?\d+)?$/i.test(s)) v = Number(s.replace(',', '.'));
  else return { kind: 'err', reason: 'number-invalid' };
  if (!Number.isFinite(v)) return { kind: 'err', reason: 'number-invalid' };
  if (o.int && !Number.isInteger(v)) return { kind: 'err', reason: 'fraction' };
  if (neg && v !== 0) return { kind: 'err', reason: 'number-negative' };
  v *= factor;
  // Gleitkommareste der Einheitenumrechnung (0,95 cm → 9,5 mm) beseitigen
  if (factor !== 1) v = Number(v.toPrecision(12));
  return { kind: 'ok', value: v };
}

/** HEX normalisieren: „3a6ea5“, „#3A6EA5“, „#abc“ → „#3A6EA5“ / „#AABBCC“; ungültig → null. */
export function normalizeHex(raw: string): string | null {
  const s = raw.trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(s)) return `#${s.toUpperCase()}`;
  if (/^[0-9a-f]{3}$/i.test(s))
    return `#${s
      .split('')
      .map((c) => c + c)
      .join('')
      .toUpperCase()}`;
  return null;
}

const NUMERIC_FIELDS: Partial<Record<keyof Material, { int: boolean; unit?: 'len' | 'price' }>> = {
  lengthMm: { int: false, unit: 'len' },
  widthMm: { int: false, unit: 'len' },
  thicknessMm: { int: false, unit: 'len' },
  price: { int: false, unit: 'price' },
  piecesPerPack: { int: true },
  stock: { int: true },
};
const LENGTH_FIELDS = new Set<CsvField>(['lengthMm', 'widthMm', 'thicknessMm', 'size']);
const TEXT_FIELDS = new Set<CsvField>(['manufacturer', 'product', 'colorNumber', 'colorName', 'packageSize', 'notes']);

/** Datei zerlegen und Werte prüfen. Schreibt nichts; Abgleich mit vorhandenen Materialien: planMaterialImport. */
export function parseMaterialsCsv(text: string): MaterialsCsvParse {
  let src = text.replace(/^﻿/, '');
  let firstLine = 1;
  let delimiter: CsvDelimiter;
  let sepLine = false;
  const sep = /^sep=(.)[^\S\r\n]*(\r\n|\n|\r|$)/i.exec(src);
  if (sep) {
    delimiter = sep[1];
    sepLine = true;
    src = src.slice(sep[0].length);
    firstLine = 2;
  } else delimiter = detectDelimiter(src);
  const decimalComma = delimiter !== ',';
  const records = tokenize(src, delimiter, firstLine).filter((r) => r.unterminated || r.cells.some((c, i) => r.quoted[i] || c.trim() !== ''));
  const fail = (error: MaterialsCsvError['error'], columns: CsvColumn[] = [], headers: string[] = []): MaterialsCsvError => ({ ok: false, error, delimiter, columns, headers });
  if (!records.length) return fail('empty');

  // Kopfzeile: erste der ersten 20 Zeilen mit HEX-Spalte; sonst erste mit erkannten Spalten (→ Fehler „HEX fehlt“)
  const mapHeader = (r: RawRecord) => {
    const byField = new Map<CsvField, CsvColumn & { rank: number }>();
    const ignoredColumns: string[] = [];
    const duplicateColumns: string[] = [];
    const unsupportedUnitColumns: string[] = [];
    r.cells.forEach((raw, index) => {
      const header = raw.trim();
      if (!header) return;
      const hit = matchHeaderRanked(header);
      if (!hit) return void ignoredColumns.push(header);
      const { field, rank } = hit;
      let factor = 1;
      if (LENGTH_FIELDS.has(field)) {
        const u = headerUnit(header);
        if (u === 'other') return void unsupportedUnitColumns.push(header);
        if (u === 'cm') factor = 10;
      }
      // Zwei Spalten für dasselbe Feld: die spezifischere Bezeichnung gewinnt, bei Gleichstand die erste.
      const prev = byField.get(field);
      if (prev && prev.rank <= rank) return void duplicateColumns.push(header);
      if (prev) duplicateColumns.push(prev.header);
      byField.set(field, { index, header, field, factor, rank });
    });
    const columns: CsvColumn[] = [...byField.values()].sort((a, b) => a.index - b.index).map(({ index, header, field, factor }) => ({ index, header, field, factor }));
    return { columns, ignoredColumns, duplicateColumns, unsupportedUnitColumns };
  };
  let headerIdx = -1;
  let firstKnown = -1;
  for (let i = 0; i < Math.min(records.length, 20); i++) {
    if (records[i].unterminated) break;
    const h = mapHeader(records[i]);
    if (h.columns.length && firstKnown < 0) firstKnown = i;
    if (h.columns.some((c) => c.field === 'hex')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    if (firstKnown < 0) return fail('no-header', [], records[0].cells.map((c) => c.trim()).filter(Boolean));
    const h = mapHeader(records[firstKnown]);
    return fail('no-hex-column', h.columns, records[firstKnown].cells.map((c) => c.trim()).filter(Boolean));
  }
  const head = mapHeader(records[headerIdx]);
  const headerRec = records[headerIdx];
  const colOf = new Map(head.columns.map((c) => [c.field, c]));
  const headerWidth = headerRec.cells.length;
  const rows: ParsedMaterialRow[] = [];
  const skipped: CsvSkip[] = [];
  const warnings: CsvWarning[] = [];
  const dataRecs = records.slice(headerIdx + 1);
  if (!dataRecs.length) return fail('no-rows', head.columns, headerRec.cells.map((c) => c.trim()).filter(Boolean));

  for (const r of dataRecs) {
    if (r.unterminated) {
      skipped.push({ line: r.line, reason: 'unterminated-quote' });
      continue;
    }
    const extra = r.cells.slice(headerWidth).filter((c, i) => r.quoted[headerWidth + i] || c.trim() !== '').length;
    if (extra > 0) {
      const used = r.cells.length - r.cells.slice().reverse().findIndex((c, i) => r.quoted[r.cells.length - 1 - i] || c.trim() !== '');
      skipped.push({ line: r.line, reason: 'too-many-columns', value: String(used), ref: headerWidth });
      continue;
    }
    const cell = (c: CsvColumn): string | undefined => {
      if (c.index >= r.cells.length) return undefined;
      return r.quoted[c.index] ? r.cells[c.index] : r.cells[c.index].trim();
    };
    const hc = colOf.get('hex')!;
    const hexRaw = cell(hc) ?? '';
    if (!hexRaw.trim()) {
      skipped.push({ line: r.line, reason: 'hex-missing' });
      continue;
    }
    const hex = normalizeHex(hexRaw);
    if (!hex) {
      skipped.push({ line: r.line, reason: 'hex-invalid', value: hexRaw });
      continue;
    }
    const values: Partial<Omit<Material, 'id'>> = { hex };
    const warn = (field: CsvField, reason: WarnReason, value: string) => warnings.push({ line: r.line, field, reason, value });
    let id: string | undefined;
    for (const c of head.columns) {
      if (c.field === 'hex' || c.field === 'size') continue;
      const v = cell(c);
      if (v === undefined) continue;
      if (c.field === 'id') {
        const s = v.trim();
        if (!s) continue;
        if (s.length > 128 || /[\u0000-\u001f\u007f]/.test(s)) warn('id', 'id-invalid', s);
        else id = s;
      } else if (c.field === 'type') {
        if (!v.trim()) values.type = 'other';
        else {
          const ty = matchMaterialType(v);
          if (ty) values.type = ty;
          else warn('type', 'type-unknown', v);
        }
      } else if (TEXT_FIELDS.has(c.field)) {
        (values as Record<string, unknown>)[c.field] = v;
      } else {
        const spec = NUMERIC_FIELDS[c.field as keyof Material];
        if (!spec) continue;
        const res = parseNum(v, { ...spec, decimalComma, factor: c.factor });
        const f = c.field as 'lengthMm' | 'widthMm' | 'thicknessMm' | 'price' | 'piecesPerPack' | 'stock';
        if (res.kind === 'err') warn(f, res.reason, v);
        else if (res.kind === 'empty') {
          if (f === 'stock') values.stock = undefined;
          else values[f] = 0;
        } else values[f] = res.value;
      }
    }
    // kombinierte Größenspalte füllt nur Maße, für die es keine eigene Spalte gibt
    const sc = colOf.get('size');
    if (sc) {
      const v = cell(sc);
      const need = (['lengthMm', 'widthMm', 'thicknessMm'] as const).filter((f) => !colOf.has(f));
      if (v !== undefined && need.length) {
        const parts = v.trim() ? parseSize(v, decimalComma, sc.factor) : { l: 0, w: 0 };
        if (!parts) warn('size', 'number-invalid', v);
        else {
          if (need.includes('lengthMm')) values.lengthMm = parts.l;
          if (need.includes('widthMm')) values.widthMm = parts.w;
          if (need.includes('thicknessMm') && parts.t !== undefined) values.thicknessMm = parts.t;
        }
      }
    }
    // Steinmaß unbekannt (leer/0) → Rastermaß; ehrlich melden
    for (const f of ['lengthMm', 'widthMm'] as const) {
      if (values[f] === 0) {
        const c = colOf.get(f) ?? sc;
        warn(colOf.has(f) ? f : 'size', 'size-unknown', c ? (cell(c) ?? '') : '');
      }
    }
    rows.push({ line: r.line, id, values });
  }

  const present = new Set(head.columns.map((c) => c.field));
  if (present.has('size')) {
    present.add('lengthMm');
    present.add('widthMm');
  }
  const missingFields = MATERIAL_CSV_FIELDS.filter((f) => f !== 'id' && !present.has(f));
  return {
    ok: true,
    delimiter,
    sepLine,
    decimalComma,
    headerLine: headerRec.line,
    leadingLines: records.slice(0, headerIdx).map((r) => r.line),
    columns: head.columns,
    ignoredColumns: head.ignoredColumns,
    duplicateColumns: head.duplicateColumns,
    unsupportedUnitColumns: head.unsupportedUnitColumns,
    missingFields,
    dataRows: dataRecs.length,
    rows,
    skipped,
    warnings: dedupeWarnings(warnings),
  };
}

function dedupeWarnings(ws: CsvWarning[]): CsvWarning[] {
  const seen = new Set<string>();
  return ws.filter((w) => {
    const k = `${w.line}|${w.field}|${w.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** „10x10“, „10 × 10 × 4 mm“, „1x1 cm“ → L, B (, D) in mm; ungültig → null. */
function parseSize(raw: string, decimalComma: boolean, headerFactor: number): { l: number; w: number; t?: number } | null {
  const m = /^\s*([\d.,]+)\s*[x×*]\s*([\d.,]+)(?:\s*[x×*]\s*([\d.,]+))?\s*(mm|cm)?\s*$/i.exec(raw);
  if (!m) return null;
  const factor = m[4] ? (m[4].toLowerCase() === 'cm' ? 10 : 1) : headerFactor;
  const nums = [m[1], m[2], m[3]].map((x) => (x === undefined ? undefined : parseNum(x, { int: false, decimalComma, factor })));
  if (nums.some((n) => n && n.kind !== 'ok')) return null;
  const val = (n: NumRes | undefined) => (n && n.kind === 'ok' ? n.value : undefined);
  return { l: val(nums[0])!, w: val(nums[1])!, t: val(nums[2]) };
}

// ---------------------------------------------------------------- Import: Abgleich

export type ImportMode = 'update' | 'new';

export interface MaterialUpdate {
  line: number;
  before: Material;
  after: Material;
  changed: CsvMaterialField[];
}

export interface MaterialImportPlan {
  mode: ImportMode;
  /** neu anzulegende Materialien */
  items: { line: number; material: Material }[];
  /** vorhandene Materialien, die geändert werden (ID bleibt) */
  updates: MaterialUpdate[];
  /** Zeilen, die einem vorhandenen Material exakt entsprechen (nichts zu tun) */
  identical: { line: number; material: Material }[];
  /** alle nicht übernommenen Zeilen mit Grund (aus dem Zerlegen und aus dem Abgleich), nach Zeile sortiert */
  skipped: CsvSkip[];
  /** Hinweise zu Zeilen, die tatsächlich geschrieben werden */
  warnings: CsvWarning[];
}

const COMPARE_FIELDS = MATERIAL_CSV_FIELDS.filter((f): f is Exclude<CsvMaterialField, 'id'> => f !== 'id');

function sameValue(f: keyof Material, a: unknown, b: unknown): boolean {
  if (f === 'hex') return (normalizeHex(String(a ?? '')) ?? String(a ?? '')) === (normalizeHex(String(b ?? '')) ?? String(b ?? ''));
  if (f === 'notes') return (a ?? '') === (b ?? '');
  if (f === 'stock') return (a ?? null) === (b ?? null);
  return Object.is(a, b);
}

/** Geänderte Felder zwischen zwei Materialständen (ohne ID). */
export function changedFields(a: Material, b: Material): CsvMaterialField[] {
  return COMPARE_FIELDS.filter((f) => !sameValue(f, a[f], b[f]));
}

const DEFAULTS: Omit<Material, 'id'> = {
  type: 'other',
  manufacturer: '',
  product: '',
  colorNumber: '',
  colorName: '',
  hex: '#808080',
  lengthMm: 0,
  widthMm: 0,
  thicknessMm: 0,
  price: 0,
  packageSize: '',
  piecesPerPack: 0,
  stock: undefined,
  notes: '',
};

const norm = (s: string | undefined) => foldText(s ?? '').replace(/\s+/g, ' ').trim();

function signature(m: Omit<Material, 'id'>): string {
  return COMPARE_FIELDS.map((f) => {
    const v = m[f];
    if (f === 'hex') return normalizeHex(String(v)) ?? String(v);
    if (f === 'notes') return v ?? '';
    if (f === 'stock') return v === undefined ? '' : String(v);
    return String(v);
  }).join('\u0001');
}

function sizeKnown(v: Partial<Material>): boolean {
  return (v.lengthMm ?? 0) > 0 && (v.widthMm ?? 0) > 0;
}

/**
 * Abgleich der zerlegten Zeilen mit den vorhandenen Materialien. Schreibt nichts.
 *
 * Modus „update“ (Aktualisieren):
 *  1. ID aus der Datei = vorhandene ID → dieses Material (eigener Export).
 *  2. sonst Hersteller + Produkt + Farbnummer (+ Länge × Breite, wenn bekannt), normalisiert, nur wenn
 *     Hersteller und Farbnummer nicht leer sind. Genau ein Treffer → dieses Material; mehrere → nicht
 *     eindeutig (übersprungen, nie „das nächstbeste“ wählen).
 *  3. ohne Schlüssel: in allen Feldern gleiches Material → identisch.
 *  Treffer ohne Änderung → identisch; sonst Aktualisierung mit unveränderter ID. Spalten, die in der
 *  Datei fehlen, und ungültige Zellen ändern vorhandene Werte nicht.
 * Modus „new“ (Als neu hinzufügen): jede gültige Zeile wird ein zusätzliches Material.
 * In beiden Modi werden Duplikate innerhalb der Datei (gleiche ID bzw. gleicher Schlüssel) übersprungen.
 */
export function planMaterialImport(parsed: MaterialsCsvOk, existing: Material[], mode: ImportMode, newId: () => string): MaterialImportPlan {
  const byId = new Map(existing.map((m) => [m.id, m]));
  const folded = existing.map((m) => ({ m, mfr: norm(m.manufacturer), prod: norm(m.product), no: norm(m.colorNumber) }));
  const bySig = new Map<string, Material>();
  for (const m of existing) if (!bySig.has(signature(m))) bySig.set(signature(m), m);
  const items: MaterialImportPlan['items'] = [];
  const updates: MaterialUpdate[] = [];
  const identical: MaterialImportPlan['identical'] = [];
  const skipped: CsvSkip[] = [...parsed.skipped];
  const fileIds = new Map<string, number>();
  const claimed = new Map<string, number>();
  const newKeys = new Map<string, number>();
  const usedIds = new Set(existing.map((m) => m.id));

  for (const row of parsed.rows) {
    const v = row.values;
    if (row.id) {
      const first = fileIds.get(row.id);
      if (first !== undefined) {
        skipped.push({ line: row.line, reason: 'duplicate-in-file', ref: first });
        continue;
      }
      fileIds.set(row.id, row.line);
    }
    const keyable = !!norm(v.manufacturer) && !!norm(v.colorNumber);
    if (mode === 'update') {
      let target: Material | undefined;
      if (row.id && byId.has(row.id)) target = byId.get(row.id);
      else if (keyable) {
        const mfr = norm(v.manufacturer);
        const no = norm(v.colorNumber);
        const prod = v.product === undefined ? null : norm(v.product);
        const known = sizeKnown(v);
        const cand = folded
          .filter((x) => x.mfr === mfr && x.no === no && (prod === null || x.prod === prod) && (!known || (x.m.lengthMm === v.lengthMm && x.m.widthMm === v.widthMm)))
          .map((x) => x.m);
        if (cand.length === 1) target = cand[0];
        else if (cand.length > 1) {
          const same = cand.find((c) => changedFields(c, { ...c, ...v }).length === 0);
          if (same && !claimed.has(same.id)) {
            claimed.set(same.id, row.line);
            identical.push({ line: row.line, material: same });
          } else skipped.push({ line: row.line, reason: 'ambiguous-match', value: String(cand.length) });
          continue;
        }
      } else {
        const same = bySig.get(signature({ ...DEFAULTS, ...v }));
        if (same) target = same;
      }
      if (target) {
        const first = claimed.get(target.id);
        if (first !== undefined) {
          skipped.push({ line: row.line, reason: 'duplicate-in-file', ref: first });
          continue;
        }
        claimed.set(target.id, row.line);
        const after: Material = { ...target, ...v, id: target.id };
        const changed = changedFields(target, after);
        if (changed.length === 0) identical.push({ line: row.line, material: target });
        else updates.push({ line: row.line, before: target, after, changed });
        continue;
      }
    }
    const draft: Omit<Material, 'id'> = { ...DEFAULTS, ...v };
    const key = keyable
      ? `k|${norm(draft.manufacturer)}|${norm(draft.product)}|${norm(draft.colorNumber)}|${draft.lengthMm}|${draft.widthMm}`
      : `s|${signature(draft)}`;
    const firstNew = newKeys.get(key);
    if (firstNew !== undefined) {
      skipped.push({ line: row.line, reason: 'duplicate-in-file', ref: firstNew });
      continue;
    }
    newKeys.set(key, row.line);
    let id = row.id && !usedIds.has(row.id) ? row.id : newId();
    while (usedIds.has(id)) id = newId();
    usedIds.add(id);
    items.push({ line: row.line, material: { ...draft, id } });
  }

  const written = new Set([...items.map((x) => x.line), ...updates.map((u) => u.line)]);
  return {
    mode,
    items,
    updates,
    identical,
    skipped: skipped.sort((a, b) => a.line - b.line),
    warnings: parsed.warnings.filter((w) => written.has(w.line)),
  };
}

// ---------------------------------------------------------------- Verwendung in Projekten

export interface MaterialRefProject {
  meta: { id: string; name: string };
  palette?: { materialId?: string }[];
  settings?: { materialIds?: string[] };
}

export interface MaterialUsage {
  projectId: string;
  name: string;
  /** Anzahl Palettenfarben, die mit dem Material verknüpft sind */
  colors: number;
  /** Material steht in der expliziten Materialauswahl des Projekts (settings.materialIds) */
  selected: boolean;
}

/** Projekte, deren Palette oder Materialauswahl das Material referenziert. */
export function findMaterialUsage(projects: MaterialRefProject[], materialId: string): MaterialUsage[] {
  const out: MaterialUsage[] = [];
  for (const p of projects) {
    const colors = (p.palette ?? []).filter((c) => c?.materialId === materialId).length;
    const selected = (p.settings?.materialIds ?? []).includes(materialId);
    if (colors || selected) out.push({ projectId: p.meta.id, name: p.meta.name, colors, selected });
  }
  return out;
}
