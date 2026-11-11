/**
 * Einkaufsliste je Material (w5-material-shopping): Zeilen, Summen und CSV-Export.
 *
 * Alle Zahlen kommen unverändert aus `Stats.perMaterial` (stats.ts): ein Material, das mehreren Farben
 * zugeordnet ist, ist EINE Zeile; Σ Bedarf über alle Zeilen = `rawWithReserveTotal`, Σ Kosten = `totalCost`.
 * Hier wird nichts geschätzt:
 *  - Packungen nur mit Stückzahl je Packung > 0, Kosten nur zusätzlich mit Preis > 0 (sonst leer bzw. „–“);
 *  - „zu kaufen“ nur mit erfasstem Bestand (auch 0); ohne Bestand bleibt es leer – es wird NICHT angenommen,
 *    dass nichts vorrätig ist;
 *  - Einkaufskosten = Packungen zu kaufen × Preis, nur wenn Bestand, Packungsgröße und Preis erfasst sind.
 * Farben ohne Material (oder mit gelöschtem/nicht importiertem Material) bilden eine Zeile „ohne Material“ mit
 * Rastermaß als Rohsteinmaß (Richtwert) und ohne Packungen/Kosten.
 *
 * CSV: ';' und Dezimalkomma (de/tr), ',' und Punkt (en) – wie der Material- und Koordinatenexport; UTF-8 mit BOM,
 * damit Excel Umlaute erkennt; eine Kopfzeile, je Material eine Zeile, zuletzt die Summenzeile.
 */
import { materialRowGridAssumed, type Stats } from './stats';
import { csvFormatFor, MATERIAL_TYPE_WORDS } from './materialsCsv';
import type { Material, PaletteColor } from './types';

export type ShoppingLang = 'de' | 'en' | 'tr';

export interface ShoppingRow {
  /** null = Gruppe „ohne Material“ */
  materialId: string | null;
  material?: Material;
  /** Palettenindizes der Farben mit Steinen, die dieses Material verwenden */
  colors: number[];
  /** Farbnummern dieser Farben, zweistellig („04“) */
  codes: string[];
  /** nur Gruppe „ohne Material“: Farben, deren Material-ID auf ein fehlendes Material zeigt */
  missingColors: number[];
  /** nur Gruppe „ohne Material“: Farben ohne Material-ID */
  unlinkedColors: number[];
  rawW: number;
  rawH: number;
  /** Rohsteinmaß = Rastermaß angenommen (kein Material, Material fehlt oder Material ohne gültiges Maß) */
  rawAssumedGrid: boolean;
  pieces: number;
  raw: number;
  /** Rohsteine inkl. Reserve */
  need: number;
  stock?: number;
  toBuy?: number;
  /** Stück je Packung (nur > 0) */
  piecesPerPack?: number;
  /** Preis je Packung (nur > 0) */
  price?: number;
  /** Packungsbezeichnung aus der Materialverwaltung (z. B. „Beutel 100 Stück“), leer wenn nicht erfasst */
  packageSize: string;
  packs?: number;
  packsToBuy?: number;
  /** Packungen × Preis für den ganzen Bedarf (= MaterialStat.cost) */
  cost?: number;
  /** Packungen zu kaufen × Preis – nur mit erfasstem Bestand, Packungsgröße und Preis */
  buyCost?: number;
  /** Bestand erfasst und kleiner als der Bedarf */
  short: boolean;
}

export interface ShoppingTotals {
  pieces: number;
  raw: number;
  /** Σ Bedarf = stats.rawWithReserveTotal */
  need: number;
  /** Σ Kosten = stats.totalCost */
  cost: number;
  /** = stats.costComplete */
  costComplete: boolean;
  /** Materialien (ohne die Gruppe „ohne Material“) */
  materials: number;
  /** Materialien mit erfasstem Bestand */
  stockRecorded: number;
  /** Σ zu kaufen über die Materialien mit erfasstem Bestand */
  toBuy: number;
  /** jede Zeile hat einen erfassten Bestand (keine Gruppe „ohne Material“) */
  toBuyComplete: boolean;
  /** Σ Einkaufskosten über die Zeilen, für die sie berechenbar sind */
  buyCost: number;
  /** Einkaufskosten für jede Zeile berechenbar und keine Steine mit ungültiger Farbe */
  buyCostComplete: boolean;
  /** mindestens eine Zeile hat Einkaufskosten */
  anyBuyCost: boolean;
  /** Materialien, deren Bestand nicht reicht (toBuy > 0), in Listenreihenfolge */
  shortfalls: ShoppingRow[];
  /** Σ Packungen zu kaufen über die Materialien mit Fehlbestand und Packungsgröße */
  shortPacks: number;
  /** alle Materialien mit Fehlbestand haben eine Packungsgröße */
  shortPacksComplete: boolean;
  /** Σ zu kaufen über die Materialien mit Fehlbestand (= toBuy, nur Materialien mit erfasstem Bestand) */
  shortToBuy: number;
  /** Σ Einkaufskosten über die Materialien mit Fehlbestand, für die sie berechenbar sind */
  shortCost: number;
  /** jedes Material mit Fehlbestand hat Einkaufskosten (Packungsgröße und Preis erfasst) */
  shortCostKnown: boolean;
  /**
   * Die Fehlbestand-Summe deckt den ganzen Einkauf ab: Bestand für jede Zeile erfasst (keine Materialien ohne
   * Bestand, keine Gruppe „ohne Material“) und keine Steine mit ungültiger Farbe. Sonst ist „zu kaufen“ nur
   * eine Teilsumme und muss als unvollständig gekennzeichnet werden.
   */
  shortTotalComplete: boolean;
  /** Einkaufskosten des Fehlbestands vollständig: shortCostKnown und shortTotalComplete */
  shortCostComplete: boolean;
}

const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Farbnummer zweistellig, wie in Legende und Plan */
export function colorCode(palette: readonly PaletteColor[], i: number): string {
  return String(palette[i]?.code ?? '?').padStart(2, '0');
}

/** Zeilen der Einkaufsliste in der Reihenfolge von stats.perMaterial („ohne Material“ zuletzt). */
export function shoppingRows(stats: Stats, palette: readonly PaletteColor[], materials: readonly Material[] = []): ShoppingRow[] {
  const byId = new Map(materials.map((m) => [m.id, m]));
  return stats.perMaterial.map((ms) => {
    const m = ms.material ?? (ms.materialId ? byId.get(ms.materialId) : undefined);
    const ppp = m && isPos(m.piecesPerPack) ? m.piecesPerPack : undefined;
    const price = m && isPos(m.price) ? m.price : undefined;
    const missingColors = ms.materialId === null ? ms.colors.filter((c) => stats.perColor[c]?.materialMissing) : [];
    const unlinkedColors = ms.materialId === null ? ms.colors.filter((c) => !stats.perColor[c]?.materialMissing) : [];
    const buyCost = ms.packsToBuy !== undefined && price !== undefined ? ms.packsToBuy * price : undefined;
    return {
      materialId: ms.materialId,
      material: m,
      colors: ms.colors,
      codes: ms.colors.map((c) => colorCode(palette, c)),
      missingColors,
      unlinkedColors,
      rawW: ms.rawW,
      rawH: ms.rawH,
      // nur das Grundstein-Material einer Farbe kann ein angenommenes Rastermaß haben – nicht ihr Feinstein-Material (w6-fine-tiles)
      rawAssumedGrid: materialRowGridAssumed(ms, stats.perColor),
      pieces: ms.pieces,
      raw: ms.raw,
      need: ms.need,
      stock: ms.stock,
      toBuy: ms.toBuy,
      piecesPerPack: ppp,
      price,
      packageSize: (m?.packageSize ?? '').trim(),
      packs: ms.packs,
      packsToBuy: ms.packsToBuy,
      cost: ms.cost,
      buyCost,
      short: ms.toBuy !== undefined && ms.toBuy > 0,
    };
  });
}

export function shoppingTotals(stats: Stats, rows: readonly ShoppingRow[]): ShoppingTotals {
  let pieces = 0;
  let raw = 0;
  let need = 0;
  let toBuy = 0;
  let buyCost = 0;
  let stockRecorded = 0;
  let materials = 0;
  let toBuyComplete = true;
  let buyCostComplete = stats.invalidColorPieces === 0;
  let anyBuyCost = false;
  let shortPacks = 0;
  let shortPacksComplete = true;
  let shortToBuy = 0;
  let shortCost = 0;
  let shortCostKnown = true;
  const shortfalls: ShoppingRow[] = [];
  for (const r of rows) {
    pieces += r.pieces;
    raw += r.raw;
    need += r.need;
    if (r.materialId !== null) materials++;
    if (r.stock !== undefined) {
      stockRecorded++;
      toBuy += r.toBuy ?? 0;
    } else toBuyComplete = false;
    if (r.buyCost !== undefined) {
      buyCost += r.buyCost;
      anyBuyCost = true;
    } else buyCostComplete = false;
    if (r.short) {
      shortfalls.push(r);
      if (r.packsToBuy !== undefined) shortPacks += r.packsToBuy;
      else shortPacksComplete = false;
      shortToBuy += r.toBuy ?? 0;
      if (r.buyCost !== undefined) shortCost += r.buyCost;
      else shortCostKnown = false;
    }
  }
  // Materialien mit Bestand ≥ Bedarf kosten nichts (0 zu kaufen) – unvollständig wird die Summe nur durch Zeilen
  // ohne erfassten Bestand (dort ist offen, was zu kaufen ist) und Steine ohne gültige Farbe
  const shortTotalComplete = toBuyComplete && stats.invalidColorPieces === 0;
  return {
    pieces,
    raw,
    need,
    cost: stats.totalCost,
    costComplete: stats.costComplete,
    materials,
    stockRecorded,
    toBuy,
    toBuyComplete,
    buyCost,
    buyCostComplete,
    anyBuyCost,
    shortfalls,
    shortPacks,
    shortPacksComplete,
    shortToBuy,
    shortCost,
    shortCostKnown,
    shortTotalComplete,
    shortCostComplete: shortCostKnown && shortTotalComplete,
  };
}

// ---------------------------------------------------------------- CSV

type Col =
  | 'manufacturer'
  | 'product'
  | 'colorNumber'
  | 'colorName'
  | 'type'
  | 'colors'
  | 'rawW'
  | 'rawH'
  | 'pieces'
  | 'raw'
  | 'need'
  | 'stock'
  | 'toBuy'
  | 'piecesPerPack'
  | 'packageSize'
  | 'packs'
  | 'packsToBuy'
  | 'price'
  | 'cost'
  | 'buyCost'
  | 'note';

export const SHOPPING_CSV_COLUMNS: readonly Col[] = [
  'manufacturer',
  'product',
  'colorNumber',
  'colorName',
  'type',
  'colors',
  'rawW',
  'rawH',
  'pieces',
  'raw',
  'need',
  'stock',
  'toBuy',
  'piecesPerPack',
  'packageSize',
  'packs',
  'packsToBuy',
  'price',
  'cost',
  'buyCost',
  'note',
];

/** Kopfzeile und Hinweise je Sprache ({pct} = Reserve in %) */
export const SHOPPING_CSV_TEXT: Record<ShoppingLang, Record<Col | 'sum' | 'noMaterial' | 'missing' | 'unlinked' | 'gridAssumed' | 'noSize' | 'noPack' | 'noPrice' | 'noStock' | 'costIncomplete' | 'buyIncomplete' | 'toBuyIncomplete' | 'invalidColor', string>> = {
  de: {
    manufacturer: 'Hersteller',
    product: 'Produkt',
    colorNumber: 'Farbnummer',
    colorName: 'Farbname',
    type: 'Typ',
    colors: 'Farben (Nr.)',
    rawW: 'Rohstein Breite (mm)',
    rawH: 'Rohstein Länge (mm)',
    pieces: 'Steine',
    raw: 'Rohsteine',
    need: 'Bedarf inkl. Reserve {pct} %',
    stock: 'Bestand',
    toBuy: 'Zu kaufen',
    piecesPerPack: 'Stück je Packung',
    packageSize: 'Packung',
    packs: 'Packungen (Bedarf)',
    packsToBuy: 'Packungen zu kaufen',
    price: 'Preis je Packung',
    cost: 'Kosten (Bedarf)',
    buyCost: 'Kosten (Einkauf)',
    note: 'Hinweis',
    sum: 'Summe',
    noMaterial: '(ohne Material)',
    missing: 'Material fehlt (gelöscht oder nicht importiert) bei Farbe {codes}',
    unlinked: 'kein Material zugeordnet bei Farbe {codes}',
    gridAssumed: 'Rohsteinmaß = Rastermaß angenommen (Richtwert)',
    noSize: 'Material ohne Maß – Rastermaß angenommen (Richtwert)',
    noPack: 'Stück je Packung nicht erfasst – keine Packungen',
    noPrice: 'Preis nicht erfasst – keine Kosten',
    noStock: 'Bestand nicht erfasst – „Zu kaufen“ leer',
    costIncomplete: 'Kosten unvollständig',
    buyIncomplete: 'Einkaufskosten unvollständig (Bestand, Packungsgröße oder Preis fehlt)',
    toBuyIncomplete: 'Zu kaufen unvollständig – Bestand nicht für alle Materialien erfasst (Summe nur der Materialien mit erfasstem Bestand)',
    invalidColor: '{n} Steine ohne gültige Farbe nicht enthalten',
  },
  en: {
    manufacturer: 'Manufacturer',
    product: 'Product',
    colorNumber: 'Colour number',
    colorName: 'Colour name',
    type: 'Type',
    colors: 'Colours (no.)',
    rawW: 'Raw tile width (mm)',
    rawH: 'Raw tile length (mm)',
    pieces: 'Tiles',
    raw: 'Raw tiles',
    need: 'Need incl. reserve {pct} %',
    stock: 'Stock',
    toBuy: 'To buy',
    piecesPerPack: 'Pieces per pack',
    packageSize: 'Pack',
    packs: 'Packs (need)',
    packsToBuy: 'Packs to buy',
    price: 'Price per pack',
    cost: 'Cost (need)',
    buyCost: 'Cost (purchase)',
    note: 'Note',
    sum: 'Total',
    noMaterial: '(no material)',
    missing: 'material missing (deleted or not imported) for colour {codes}',
    unlinked: 'no material assigned for colour {codes}',
    gridAssumed: 'raw tile size = grid size assumed (guide value)',
    noSize: 'material without size – grid size assumed (guide value)',
    noPack: 'pieces per pack not recorded – no packs',
    noPrice: 'price not recorded – no cost',
    noStock: 'stock not recorded – “To buy” empty',
    costIncomplete: 'cost incomplete',
    buyIncomplete: 'purchase cost incomplete (stock, pack size or price missing)',
    toBuyIncomplete: 'to buy incomplete – stock not recorded for every material (total only of materials with recorded stock)',
    invalidColor: '{n} tiles without a valid colour not included',
  },
  tr: {
    manufacturer: 'Üretici',
    product: 'Ürün',
    colorNumber: 'Renk numarası',
    colorName: 'Renk adı',
    type: 'Tür',
    colors: 'Renkler (no.)',
    rawW: 'Ham taş genişliği (mm)',
    rawH: 'Ham taş uzunluğu (mm)',
    pieces: 'Taş',
    raw: 'Ham taş',
    need: 'Yedek dahil ihtiyaç %{pct}',
    stock: 'Stok',
    toBuy: 'Alınacak',
    piecesPerPack: 'Paket başına adet',
    packageSize: 'Paket',
    packs: 'Paket (ihtiyaç)',
    packsToBuy: 'Alınacak paket',
    price: 'Paket fiyatı',
    cost: 'Maliyet (ihtiyaç)',
    buyCost: 'Maliyet (alım)',
    note: 'Not',
    sum: 'Toplam',
    noMaterial: '(malzemesiz)',
    missing: 'malzeme eksik (silinmiş veya içe aktarılmamış), renk {codes}',
    unlinked: 'malzeme atanmamış, renk {codes}',
    gridAssumed: 'ham taş ölçüsü = ızgara ölçüsü varsayıldı (yaklaşık değer)',
    noSize: 'ölçüsüz malzeme – ızgara ölçüsü varsayıldı (yaklaşık değer)',
    noPack: 'paket başına adet kayıtlı değil – paket yok',
    noPrice: 'fiyat kayıtlı değil – maliyet yok',
    noStock: 'stok kayıtlı değil – “Alınacak” boş',
    costIncomplete: 'maliyet eksik',
    buyIncomplete: 'alım maliyeti eksik (stok, paket boyutu veya fiyat yok)',
    toBuyIncomplete: 'alınacak eksik – stok her malzeme için kayıtlı değil (toplam yalnızca stoku kayıtlı malzemeler)',
    invalidColor: 'geçerli rengi olmayan {n} taş dahil değil',
  },
};

function fill(s: string, params: Record<string, string | number>): string {
  let out = s;
  for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

function csvCell(s: string, delim: string): string {
  const needsQuote = s.includes(delim) || /["\r\n]/.test(s) || s !== s.trim();
  return needsQuote ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Zahl ohne Tausendertrennzeichen; Dezimalkomma außer im Englischen. `fixed` = feste Nachkommastellen. */
function csvNum(v: number | undefined, decimalComma: boolean, fixed?: number): string {
  if (v === undefined || !Number.isFinite(v)) return '';
  const s = fixed !== undefined ? v.toFixed(fixed) : String(Math.round(v * 1e6) / 1e6);
  return decimalComma ? s.replace('.', ',') : s;
}

/** Hinweise einer Zeile (was fehlt oder angenommen wurde) */
export function shoppingRowNotes(r: ShoppingRow, lang: ShoppingLang, palette: readonly PaletteColor[]): string[] {
  const T = SHOPPING_CSV_TEXT[lang];
  const codes = (cs: number[]) => cs.map((c) => colorCode(palette, c)).join(', ');
  const out: string[] = [];
  if (r.materialId === null) {
    if (r.missingColors.length) out.push(fill(T.missing, { codes: codes(r.missingColors) }));
    if (r.unlinkedColors.length) out.push(fill(T.unlinked, { codes: codes(r.unlinkedColors) }));
    out.push(T.gridAssumed);
    return out;
  }
  if (r.rawAssumedGrid) out.push(T.noSize);
  if (r.piecesPerPack === undefined) out.push(T.noPack);
  else if (r.price === undefined) out.push(T.noPrice);
  if (r.stock === undefined) out.push(T.noStock);
  return out;
}

/**
 * Einkaufsliste als CSV (eine Zeile je Material + Summenzeile). Summen: Bedarf = stats.rawWithReserveTotal,
 * Kosten (Bedarf) = stats.totalCost (auf 2 Nachkommastellen). Fehlende Werte bleiben leer (nie geschätzt).
 */
export function buildShoppingCsv(stats: Stats, palette: readonly PaletteColor[], materials: readonly Material[], lang: ShoppingLang, opts: { bom?: boolean } = {}): string {
  const { delimiter: D, decimalComma } = csvFormatFor(lang);
  const T = SHOPPING_CSV_TEXT[lang];
  const rows = shoppingRows(stats, palette, materials);
  const tot = shoppingTotals(stats, rows);
  const pct = csvNum(stats.reservePct, decimalComma);
  const head = SHOPPING_CSV_COLUMNS.map((c) => csvCell(fill(T[c], { pct }), D)).join(D);
  const line = (cells: Record<Col, string>) => SHOPPING_CSV_COLUMNS.map((c) => csvCell(cells[c], D)).join(D);
  const body = rows.map((r) => {
    const m = r.material;
    return line({
      manufacturer: m ? m.manufacturer : T.noMaterial,
      product: m?.product ?? '',
      colorNumber: m?.colorNumber ?? '',
      colorName: m?.colorName ?? '',
      type: m ? (MATERIAL_TYPE_WORDS[lang][m.type] ?? m.type) : '',
      colors: r.codes.join(', '),
      rawW: csvNum(r.rawW, decimalComma),
      rawH: csvNum(r.rawH, decimalComma),
      pieces: csvNum(r.pieces, decimalComma),
      raw: csvNum(r.raw, decimalComma),
      need: csvNum(r.need, decimalComma),
      stock: csvNum(r.stock, decimalComma),
      toBuy: csvNum(r.toBuy, decimalComma),
      piecesPerPack: csvNum(r.piecesPerPack, decimalComma),
      packageSize: r.packageSize,
      packs: csvNum(r.packs, decimalComma),
      packsToBuy: csvNum(r.packsToBuy, decimalComma),
      price: csvNum(r.price, decimalComma),
      cost: csvNum(r.cost, decimalComma, 2),
      buyCost: csvNum(r.buyCost, decimalComma, 2),
      note: shoppingRowNotes(r, lang, palette).join(' · '),
    });
  });
  const sumNotes: string[] = [];
  if (!tot.costComplete) sumNotes.push(T.costIncomplete);
  // „Zu kaufen“-Summe nur über Materialien mit erfasstem Bestand: ausdrücklich als unvollständig kennzeichnen
  if (tot.stockRecorded > 0 && !tot.toBuyComplete) sumNotes.push(T.toBuyIncomplete);
  if (tot.anyBuyCost && !tot.buyCostComplete) sumNotes.push(T.buyIncomplete);
  if (stats.invalidColorPieces > 0) sumNotes.push(fill(T.invalidColor, { n: stats.invalidColorPieces }));
  const sum = line({
    manufacturer: T.sum,
    product: '',
    colorNumber: '',
    colorName: '',
    type: '',
    colors: '',
    rawW: '',
    rawH: '',
    pieces: csvNum(tot.pieces, decimalComma),
    raw: csvNum(tot.raw, decimalComma),
    need: csvNum(tot.need, decimalComma),
    stock: '',
    toBuy: tot.stockRecorded > 0 ? csvNum(tot.toBuy, decimalComma) : '',
    piecesPerPack: '',
    packageSize: '',
    packs: '',
    packsToBuy: '',
    price: '',
    // keine erfassten Preise → keine Kosten (leer, nicht 0)
    cost: rows.some((r) => r.cost !== undefined) ? csvNum(tot.cost, decimalComma, 2) : '',
    buyCost: tot.anyBuyCost ? csvNum(tot.buyCost, decimalComma, 2) : '',
    note: sumNotes.join(' · '),
  });
  return (opts.bom === false ? '' : '﻿') + [head, ...body, sum].join('\r\n') + '\r\n';
}

/** Dateiname-Zusatz je Sprache */
export const SHOPPING_FILE_SUFFIX: Record<ShoppingLang, string> = { de: 'einkaufsliste', en: 'shopping-list', tr: 'alisveris-listesi' };

/** Betrag mit genau zwei Nachkommastellen in der Schreibweise der Sprache (ohne Währungszeichen – es gibt keine Währungseinstellung). */
export function formatMoney(v: number, lang: ShoppingLang): string {
  if (!Number.isFinite(v)) return '–';
  const locale = lang === 'de' ? 'de-DE' : lang === 'tr' ? 'tr-TR' : 'en-GB';
  return v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
