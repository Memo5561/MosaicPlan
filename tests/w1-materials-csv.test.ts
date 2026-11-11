import { describe, expect, it } from 'vitest';
import {
  MATERIAL_CSV_HEADERS,
  SKIP_REASONS,
  WARN_REASONS,
  decodeCsvBytes,
  findMaterialUsage,
  matchHeader,
  matchMaterialType,
  materialsCsvTemplate,
  materialsToCsv,
  parseMaterialsCsv,
  planMaterialImport,
  type MaterialsCsvOk,
} from '../src/core/materialsCsv';
import type { Material } from '../src/core/types';
import { dictionaries } from '../src/i18n';

function ok(text: string): MaterialsCsvOk {
  const p = parseMaterialsCsv(text);
  if (!p.ok) throw new Error(`Parse-Fehler: ${p.error}`);
  return p;
}

function ids(prefix = 'n') {
  let i = 0;
  return () => `${prefix}${++i}`;
}

function mat(p: Partial<Material> & { id: string }): Material {
  return {
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
    stock: undefined,
    notes: '',
    ...p,
  };
}

/** Materialien mit allen Stolperfallen: Trennzeichen, Anführungszeichen, Zeilenumbrüche, Rand-Leerzeichen, Dezimalwerte. */
const TRICKY: Material[] = [
  mat({
    id: 'a1',
    type: 'glass',
    manufacturer: 'Sicis',
    product: 'Vetricolor',
    colorNumber: '09',
    colorName: 'Blau; dunkel',
    hex: '#3A6EA5',
    lengthMm: 9.5,
    widthMm: 9.5,
    thicknessMm: 4,
    price: 12.5,
    packageSize: 'Matte 30×30, 1 kg',
    piecesPerPack: 900,
    stock: 250,
    notes: 'Rest, Bad; "gut" erhalten',
  }),
  mat({
    id: 'a2',
    type: 'ceramic',
    manufacturer: 'Bisazza',
    product: 'Le Gemme',
    colorNumber: 'GM 20.12',
    colorName: 'Grün',
    hex: '#33AA66',
    lengthMm: 20,
    widthMm: 10,
    thicknessMm: 4.25,
    price: 1250.75,
    packageSize: '',
    piecesPerPack: 0,
    stock: 0,
    notes: 'Zeile 1\r\nZeile 2\nZeile 3',
  }),
  mat({ id: 'a3', type: 'smalti', manufacturer: 'Orsoni', colorNumber: '1.125', colorName: '  Gold  ', hex: '#D4AF37', lengthMm: 15, widthMm: 15, thicknessMm: 0.1, price: 0.125, notes: undefined }),
  mat({ id: 'a4', type: 'stone', manufacturer: 'Doğal Taş A.Ş.', colorName: 'Şeker İnci ığ', hex: '#ABC', lengthMm: 0, widthMm: 0, thicknessMm: 0, price: 1.125 }),
  mat({ id: 'a5', type: 'other', manufacturer: '', colorName: 'x', hex: '#000000', lengthMm: 12.345, widthMm: 7.5, price: 0.1 + 0.2 }),
];

describe('Material-CSV: deutsches Excel', () => {
  const GERMAN =
    'Materialart;Hersteller;Produkt;Farbnummer;Farbe;HEX;Länge;Breite;Dicke;Preis;Packungsgröße;Stück/Packung;Bestand;Notiz\r\n' +
    'Glas;Sicis;Vetricolor;09;Blau;#3A6EA5;9,5;9,5;4;12,50;Matte 30x30;900;250;Rest, Bad\r\n' +
    'Glas;Sicis;Vetricolor;10;Rot;#GG0000;10;10;4;1;x;1;1;\r\n' +
    'Keramik;Bisazza;;11;Grün;3a6;10;10;4;1.250,50 €;x;1.250;;"a ""q"" ; b"\r\n';

  it("'12,50' und '9,5' werden zu 12,5 € und 9,5 mm, Komma im Text bleibt erhalten", () => {
    const p = ok(GERMAN);
    expect(p.delimiter).toBe(';');
    const r = p.rows.find((x) => x.line === 2)!;
    expect(r.values).toMatchObject({ type: 'glass', manufacturer: 'Sicis', colorNumber: '09', price: 12.5, lengthMm: 9.5, widthMm: 9.5, piecesPerPack: 900, stock: 250, notes: 'Rest, Bad' });
  });

  it('ungültiger HEX-Wert wird mit Zeilennummer gemeldet', () => {
    const p = ok(GERMAN);
    expect(p.skipped).toEqual([{ line: 3, reason: 'hex-invalid', value: '#GG0000' }]);
  });

  it("'1.250' in Stück/Packung → Hinweis, nie geraten; Tausender+Dezimal im Preis eindeutig", () => {
    const p = ok(GERMAN);
    expect(p.warnings).toEqual([{ line: 4, field: 'piecesPerPack', reason: 'thousands-separator', value: '1.250' }]);
    const r = p.rows.find((x) => x.line === 4)!;
    expect(r.values.piecesPerPack).toBeUndefined();
    expect(r.values.price).toBe(1250.5);
    expect(r.values.hex).toBe('#33AA66');
    expect(r.values.notes).toBe('a "q" ; b');
    // neu angelegt: Feld bleibt leer (0 = unbekannt), nicht 1 oder 1250
    const plan = planMaterialImport(p, [], 'update', ids());
    expect(plan.items.find((x) => x.line === 4)!.material.piecesPerPack).toBe(0);
  });

  it('mehrdeutige Zahlen in Dezimalfeldern werden nicht geraten', () => {
    const p = ok('HEX;Preis;Länge;Breite\n#111111;1.250;10;10\n#222222;1,250;10;10\n#333333;0.125;12.5;1.000,5\n#444444;12.500.000;10;10\n');
    expect(p.warnings.map((w) => [w.line, w.field, w.reason])).toEqual([
      [2, 'price', 'ambiguous-number'],
      [5, 'price', 'ambiguous-number'],
    ]);
    expect(p.rows.find((r) => r.line === 3)!.values.price).toBe(1.25);
    expect(p.rows.find((r) => r.line === 4)!.values).toMatchObject({ price: 0.125, lengthMm: 12.5, widthMm: 1000.5 });
  });

  it('Bruchzahl, negative Zahl, Text in Zahlenfeldern → Hinweis je Zeile/Feld', () => {
    const p = ok('HEX;Stück/Packung;Bestand;Preis;Länge;Breite\n#111111;12,5;-3;abc;-1;10\n#222222;12,0;7;2,5 EUR;10 mm;1 cm\n');
    expect(p.warnings.map((w) => [w.line, w.field, w.reason])).toEqual([
      [2, 'piecesPerPack', 'fraction'],
      [2, 'stock', 'number-negative'],
      [2, 'price', 'number-invalid'],
      [2, 'lengthMm', 'number-negative'],
    ]);
    expect(p.rows[1].values).toMatchObject({ piecesPerPack: 12, stock: 7, price: 2.5, lengthMm: 10, widthMm: 10 });
  });

  it('Größe 0 oder leer → Hinweis „Rastermaß“, Material wird trotzdem importiert', () => {
    const p = ok('HEX;Länge;Breite\n#111111;0;10\n#222222;;\n');
    expect(p.rows).toHaveLength(2);
    expect(p.warnings.map((w) => [w.line, w.field, w.reason])).toEqual([
      [2, 'lengthMm', 'size-unknown'],
      [3, 'lengthMm', 'size-unknown'],
      [3, 'widthMm', 'size-unknown'],
    ]);
  });

  it('ohne HEX-Spalte: ausdrücklicher Fehler statt „0 importiert“', () => {
    const p = parseMaterialsCsv('Hersteller;Farbnummer;Farbe\nSicis;09;Blau\n');
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.error).toBe('no-hex-column');
      expect(p.columns.map((c) => c.field)).toEqual(['manufacturer', 'colorNumber', 'colorName']);
    }
    const q = parseMaterialsCsv('foo;bar\n1;2\n');
    expect(q.ok === false && q.error).toBe('no-header');
    expect(parseMaterialsCsv('').ok).toBe(false);
    const r = parseMaterialsCsv('HEX;Hersteller\n');
    expect(r.ok === false && r.error).toBe('no-rows');
  });

  it('Windows-1252 (ANSI) ohne BOM wird erkannt; UTF-8 mit BOM; UTF-16LE (Unicode-Text, Tab)', () => {
    const ansi = new Uint8Array([...Buffer.from('L', 'latin1'), 0xe4, ...Buffer.from('nge;HEX;Notiz\r\n9,5;#3A6EA5;Gr', 'latin1'), 0xfc, 0x6e, 0x0d, 0x0a]);
    const d = decodeCsvBytes(ansi);
    expect(d.encoding).toBe('Windows-1252');
    const p = ok(d.text);
    expect(p.columns.map((c) => c.field)).toEqual(['lengthMm', 'hex', 'notes']);
    expect(p.rows[0].values).toMatchObject({ lengthMm: 9.5, notes: 'Grün' });

    // türkisches ANSI: ş = 0xFE, ı = 0xFD in Windows-1254
    const tr = new Uint8Array([...Buffer.from('HEX;Not\r\n#111111;ka', 'latin1'), 0xfe, 0x69, 0x6b, 0xfd, 0x0d, 0x0a]);
    const dt = decodeCsvBytes(tr);
    expect(dt.encoding).toBe('Windows-1254');
    expect(ok(dt.text).rows[0].values.notes).toBe('kaşikı');

    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('Länge;HEX\n1;#111111\n', 'utf8')]);
    expect(decodeCsvBytes(utf8)).toMatchObject({ encoding: 'UTF-8', text: 'Länge;HEX\n1;#111111\n' });

    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hersteller\tHEX\tPreis\r\nSicis\t#3A6EA5\t12,50\r\n', 'utf16le')]);
    const d16 = decodeCsvBytes(new Uint8Array(u16));
    expect(d16.encoding).toBe('UTF-16LE');
    const p16 = ok(d16.text);
    expect(p16.delimiter).toBe('\t');
    expect(p16.rows[0].values).toMatchObject({ manufacturer: 'Sicis', price: 12.5 });
  });
});

describe('Material-CSV: Kopfzeilen und Formate', () => {
  it('deutsche, englische, türkische und großgeschriebene Spaltennamen', () => {
    const cases: [string, string][] = [
      ['HERSTELLER', 'manufacturer'],
      ['  farbnummer ', 'colorNumber'],
      ['Farb-Nr.', 'colorNumber'],
      ['Länge (mm)', 'lengthMm'],
      ['LAENGE', 'lengthMm'],
      ['Stärke', 'thicknessMm'],
      ['Stück/Packung', 'piecesPerPack'],
      ['Stk. je Packung', 'piecesPerPack'],
      ['Bestand (Stück)', 'stock'],
      ['Preis in €', 'price'],
      ['Packungsgröße', 'packageSize'],
      ['Farbe (HEX)', 'hex'],
      ['Farbwert', 'hex'],
      ['Colour number', 'colorNumber'],
      ['Pieces per pack', 'piecesPerPack'],
      ['Thickness [mm]', 'thicknessMm'],
      ['ÜRETİCİ', 'manufacturer'],
      ['Renk numarası', 'colorNumber'],
      ['Renk adı', 'colorName'],
      ['Genişlik', 'widthMm'],
      ['KALINLIK (mm)', 'thicknessMm'],
      ['Paket başına adet', 'piecesPerPack'],
      ['Stok (adet)', 'stock'],
      ['Malzeme türü', 'type'],
      ['Tür', 'type'],
      ['lengthMm', 'lengthMm'],
      ['colorNumber', 'colorNumber'],
      ['Größe', 'size'],
      ['ID', 'id'],
    ];
    for (const [h, f] of cases) expect(`${h} → ${matchHeader(h)}`).toBe(`${h} → ${f}`);
    // bewusst nicht zugeordnet (mehrdeutig)
    for (const h of ['Höhe', 'Anzahl', 'Preis pro Stück', 'Nr.']) expect(matchHeader(h)).toBeNull();
  });

  it('alle Export-Kopfzeilen (de/en/tr) werden wieder erkannt', () => {
    for (const lang of ['de', 'en', 'tr'] as const)
      for (const [f, h] of Object.entries(MATERIAL_CSV_HEADERS[lang])) expect(`${lang}:${h} → ${matchHeader(h)}`).toBe(`${lang}:${h} → ${f}`);
  });

  it('Materialarten: Glas, Keramik, Smalten, Naturstein, cam, seramik; unbekannt → Sonstiges mit Hinweis', () => {
    expect(['Glas', 'Keramik', 'Smalten', 'Naturstein', 'cam', 'seramik', 'GLASS', 'Doğal taş', 'Diğer', 'stone'].map(matchMaterialType)).toEqual([
      'glass',
      'ceramic',
      'smalti',
      'stone',
      'glass',
      'ceramic',
      'glass',
      'stone',
      'other',
      'stone',
    ]);
    const p = ok('Typ;HEX\nVetro;#111111\nHolz;#222222\n;#333333\n');
    expect(p.warnings).toEqual([{ line: 3, field: 'type', reason: 'type-unknown', value: 'Holz' }]);
    const plan = planMaterialImport(p, [], 'update', ids());
    expect(plan.items.map((x) => x.material.type)).toEqual(['glass', 'other', 'other']);
  });

  it('türkische Kopfzeile, tabulatorgetrennt', () => {
    const p = ok('Üretici\tRenk numarası\tRenk adı\tHEX\tUzunluk\tGenişlik\tFiyat\tStok\nOrsoni\t12\tAltın\t#D4AF37\t15\t15\t3,75\t40\n');
    expect(p.delimiter).toBe('\t');
    expect(p.rows[0].values).toMatchObject({ manufacturer: 'Orsoni', colorNumber: '12', colorName: 'Altın', hex: '#D4AF37', lengthMm: 15, widthMm: 15, price: 3.75, stock: 40 });
  });

  it("'sep=,' in der ersten Zeile wird beachtet (Zeilennummern zählen sie mit)", () => {
    const p = ok('sep=,\nHersteller,HEX,Preis\nA,#111111,2.5\nB,#XYZ,1\n');
    expect(p.delimiter).toBe(',');
    expect(p.sepLine).toBe(true);
    expect(p.decimalComma).toBe(false);
    expect(p.rows[0].values.price).toBe(2.5);
    expect(p.skipped).toEqual([{ line: 4, reason: 'hex-invalid', value: '#XYZ' }]);
  });

  it('Trennzeichen nur einmal: Kommas in einer ;-Datei trennen nicht', () => {
    const p = ok('Hersteller;HEX;Notiz;Preis\nA, B;#111111;x, y, z;3,5\n');
    expect(p.rows[0].values).toMatchObject({ manufacturer: 'A, B', notes: 'x, y, z', price: 3.5 });
  });

  it('zu viele Werte (verschobene Spalten) → Zeile übersprungen; leere Zusatzspalten stören nicht', () => {
    const p = ok('Hersteller,HEX,Preis\nA,#111111,12,50\nB,#222222,3;;\nC,#333333,4,,\n');
    expect(p.skipped).toEqual([{ line: 2, reason: 'too-many-columns', value: '4', ref: 3 }]);
    expect(p.warnings).toEqual([{ line: 3, field: 'price', reason: 'number-invalid', value: '3;;' }]);
    expect(p.rows.map((r) => r.values.manufacturer)).toEqual(['B', 'C']);
  });

  it('Zeilenumbruch im Feld: Zeilennummern der folgenden Zeilen stimmen', () => {
    const p = ok('HEX;Notiz\n#111111;"a\nb\r\nc"\n#GG;x\n');
    expect(p.rows[0].values.notes).toBe('a\nb\r\nc');
    expect(p.skipped).toEqual([{ line: 5, reason: 'hex-invalid', value: '#GG' }]);
  });

  it('nicht geschlossenes Anführungszeichen wird gemeldet', () => {
    const p = ok('HEX;Notiz\n#111111;ok\n#222222;"offen\n#333333;x\n');
    expect(p.rows).toHaveLength(1);
    expect(p.skipped).toEqual([{ line: 3, reason: 'unterminated-quote' }]);
  });

  it('Anführungszeichen mitten im Feld ist ein normales Zeichen (z. B. Zoll)', () => {
    const p = ok('HEX;Packungsgröße\n#111111;Matte 12" x 12"\n');
    expect(p.rows[0].values.packageSize).toBe('Matte 12" x 12"');
  });

  it('Titelzeile vor der Kopfzeile wird übersprungen und gemeldet', () => {
    const p = ok('Meine Steine 2026;;\n;;\nHersteller;Farbnummer;HEX\nSicis;09;#3A6EA5\n');
    expect(p.headerLine).toBe(3);
    expect(p.leadingLines).toEqual([1]);
    expect(p.rows).toHaveLength(1);
  });

  it('Einheiten: (cm) wird in mm umgerechnet, (m)/(inch) wird nicht geraten', () => {
    const p = ok('HEX;Länge (cm);Breite (cm);Dicke (m)\n#111111;0,95;2;0,004\n');
    expect(p.unsupportedUnitColumns).toEqual(['Dicke (m)']);
    expect(p.rows[0].values).toMatchObject({ lengthMm: 9.5, widthMm: 20 });
    expect(p.rows[0].values.thicknessMm).toBeUndefined();
  });

  it('kombinierte Größenspalte „10x10x4“ und „2 × 1 cm“', () => {
    const p = ok('HEX;Größe\n#111111;10x10x4\n#222222;2 × 1 cm\n#333333;groß\n');
    expect(p.rows[0].values).toMatchObject({ lengthMm: 10, widthMm: 10, thicknessMm: 4 });
    expect(p.rows[1].values).toMatchObject({ lengthMm: 20, widthMm: 10 });
    expect(p.warnings).toEqual([{ line: 4, field: 'size', reason: 'number-invalid', value: 'groß' }]);
  });

  it('nicht erkannte und doppelte Spalten werden gemeldet; spezifischere Bezeichnung gewinnt', () => {
    const p = ok('Code;Farbnummer;HEX;Lieferant;Name;Farbname\nX1;09;#111111;Foo;Bar;Blau\n');
    expect(p.columns.map((c) => [c.header, c.field])).toEqual([
      ['Farbnummer', 'colorNumber'],
      ['HEX', 'hex'],
      ['Farbname', 'colorName'],
    ]);
    expect(p.duplicateColumns.sort()).toEqual(['Code', 'Name']);
    expect(p.ignoredColumns).toEqual(['Lieferant']);
    expect(p.rows[0].values).toMatchObject({ colorNumber: '09', colorName: 'Blau' });
  });

  it('Altformat der App (interne Spaltennamen, ohne ID) wird importiert', () => {
    const old =
      'type;manufacturer;product;colorNumber;colorName;hex;lengthMm;widthMm;thicknessMm;price;packageSize;piecesPerPack;stock;notes\r\nglass;Sicis;Vetricolor;09;Blau;#3A6EA5;10;10;4;12.5;1 kg;900;;Rest\r\n';
    const p = ok(old);
    expect(p.missingFields).toEqual([]);
    expect(p.rows[0].values).toMatchObject({ type: 'glass', manufacturer: 'Sicis', price: 12.5, piecesPerPack: 900, stock: undefined, notes: 'Rest' });
  });
});

describe('Material-CSV: Export und Rundreise', () => {
  it('Export de: ID-Spalte, lokalisierte Kopfzeile, ;-getrennt, Dezimalkomma, BOM, Quoting', () => {
    const csv = materialsToCsv(TRICKY.slice(0, 1), 'de');
    expect(csv.startsWith('﻿ID;Materialart;Hersteller;')).toBe(true);
    const line = csv.split('\r\n')[1];
    expect(line).toBe('a1;Glas;Sicis;Vetricolor;09;"Blau; dunkel";#3A6EA5;9,5;9,5;4;12,5;Matte 30×30, 1 kg;900;250;"Rest, Bad; ""gut"" erhalten";;;;'); // + 4 leere Herkunftsspalten (w6-colour-measure)
  });

  it('Export en: ,-getrennt, Dezimalpunkt, englische Kopfzeile', () => {
    const csv = materialsToCsv(TRICKY.slice(0, 1), 'en', { bom: false });
    expect(csv.split('\r\n')[0]).toBe('ID,Type,Manufacturer,Product,Colour number,Colour name,HEX,Length (mm),Width (mm),Thickness (mm),Price per pack,Package size,Pieces per pack,Stock (pieces),Notes,Colour source,Measured on,Measuring reference,Measuring spread (ΔE)');
    expect(csv.split('\r\n')[1]).toBe('a1,Glass,Sicis,Vetricolor,09,Blau; dunkel,#3A6EA5,9.5,9.5,4,12.5,"Matte 30×30, 1 kg",900,250,"Rest, Bad; ""gut"" erhalten",,,,');
  });

  for (const lang of ['de', 'en', 'tr'] as const) {
    it(`Rundreise Export → Import verlustfrei (${lang})`, () => {
      const p = ok(materialsToCsv(TRICKY, lang));
      expect(p.skipped).toEqual([]);
      expect(p.rows.map((r) => r.id)).toEqual(TRICKY.map((m) => m.id));
      // in eine leere Datenbank: identische Werte, IDs bleiben erhalten
      const plan = planMaterialImport(p, [], 'update', ids());
      expect(plan.items.map((x) => x.material.id)).toEqual(TRICKY.map((m) => m.id));
      for (const [i, m] of TRICKY.entries()) {
        const got = plan.items[i].material;
        expect({ ...got, notes: got.notes ?? '', hex: got.hex }).toEqual({ ...m, notes: m.notes ?? '', hex: m.hex === '#ABC' ? '#AABBCC' : m.hex });
      }
    });

    it(`erneuter Import des eigenen Exports: 0 neu, N identisch (${lang})`, () => {
      const plan = planMaterialImport(ok(materialsToCsv(TRICKY, lang)), TRICKY, 'update', ids());
      expect(plan.items).toEqual([]);
      expect(plan.updates).toEqual([]);
      expect(plan.skipped).toEqual([]);
      expect(plan.identical.map((x) => x.material.id)).toEqual(TRICKY.map((m) => m.id));
      expect(plan.warnings).toEqual([]);
    });
  }

  it('Vorlage: Kopfzeile + Beispielzeile im Exportformat, importierbar', () => {
    for (const lang of ['de', 'en', 'tr'] as const) {
      const csv = materialsCsvTemplate(lang);
      expect(csv.startsWith('﻿')).toBe(true);
      const p = ok(csv);
      expect(p.missingFields).toEqual([]);
      expect(p.rows).toHaveLength(1);
      expect(p.rows[0].id).toBeUndefined();
      expect(p.rows[0].values).toMatchObject({ type: 'glass', hex: '#3A6EA5', price: 12.5, piecesPerPack: 100 });
      expect(p.warnings).toEqual([]);
    }
  });
});

describe('Material-CSV: Abgleich (Aktualisieren / Als neu hinzufügen)', () => {
  const existing = [
    mat({ id: 'm1', manufacturer: 'Sicis', product: 'Vetricolor', colorNumber: '09', hex: '#3A6EA5', price: 10, stock: 5, notes: 'alt' }),
    mat({ id: 'm2', manufacturer: 'Bisazza', product: '', colorNumber: '20', hex: '#112233' }),
    mat({ id: 'm3', manufacturer: 'Orsoni', product: 'Smalti', colorNumber: '7', hex: '#AA0000', lengthMm: 10, widthMm: 10 }),
    mat({ id: 'm4', manufacturer: 'Orsoni', product: 'Smalti', colorNumber: '7', hex: '#AA0000', lengthMm: 20, widthMm: 20 }),
    mat({ id: 'm5', manufacturer: '', colorName: 'Hausweiß', hex: '#FFFFFF' }),
  ];

  it('Aktualisierung per ID behält die ID und ändert nur vorhandene Spalten', () => {
    const p = ok('ID;HEX;Preis\nm1;#3A6EA5;12,50\n');
    const plan = planMaterialImport(p, existing, 'update', ids());
    expect(plan.items).toEqual([]);
    expect(plan.updates).toHaveLength(1);
    const u = plan.updates[0];
    expect(u.after.id).toBe('m1');
    expect(u.changed).toEqual(['price']);
    expect(u.after).toEqual({ ...existing[0], price: 12.5 });
  });

  it('Abgleich über Hersteller + Produkt + Farbnummer (normalisiert), ID bleibt', () => {
    const p = ok('Hersteller;Produkt;Farbnummer;HEX;Bestand\n  SICIS ;vetricolor;09;#3A6EA5;300\n');
    const plan = planMaterialImport(p, existing, 'update', ids());
    // Zuordnung ohne Groß-/Kleinschreibung und Rand-Leerzeichen; die Schreibweise der Datei wird übernommen
    expect(plan.updates.map((u) => [u.after.id, u.changed])).toEqual([['m1', ['manufacturer', 'product', 'stock']]]);
    expect(plan.updates[0].after).toMatchObject({ manufacturer: 'SICIS', product: 'vetricolor', stock: 300, price: 10, notes: 'alt' });
  });

  it('Größe gehört zum Schlüssel; ohne Größe mehrere Treffer → nicht eindeutig (übersprungen)', () => {
    const p = ok('Hersteller;Produkt;Farbnummer;HEX;Länge;Breite;Preis\nOrsoni;Smalti;7;#AA0000;20;20;9\nOrsoni;Smalti;7;#AA0000;;;9\nOrsoni;Smalti;7;#AA0000;30;30;9\n');
    const plan = planMaterialImport(p, existing, 'update', ids());
    expect(plan.updates.map((u) => u.after.id)).toEqual(['m4']);
    expect(plan.skipped).toEqual([{ line: 3, reason: 'ambiguous-match', value: '2' }]);
    expect(plan.items.map((x) => x.line)).toEqual([4]);
  });

  it('ohne Hersteller/Farbnummer: nur vollständig gleiche Zeile zählt als identisch', () => {
    const p = ok(materialsToCsv([{ ...existing[4], id: '' }], 'de') + 'Sonstiges;;;;;Hausweiß;#FFFFFE;10;10;4;0;;0;;\r\n');
    const plan = planMaterialImport(p, existing, 'update', ids());
    expect(plan.identical.map((x) => x.material.id)).toEqual(['m5']);
    expect(plan.items).toHaveLength(1);
  });

  it('Duplikate innerhalb der Datei werden übersprungen und auf die erste Zeile verwiesen', () => {
    const p = ok('ID;Hersteller;Farbnummer;HEX\nm2;Bisazza;20;#112233\nm2;Bisazza;20;#112233\n;Bisazza;20;#445566\n;Neu;1;#010101\n;neu;1;#020202\n');
    const plan = planMaterialImport(p, existing, 'update', ids());
    expect(plan.identical.map((x) => x.line)).toEqual([2]);
    expect(plan.skipped).toEqual([
      { line: 3, reason: 'duplicate-in-file', ref: 2 },
      { line: 4, reason: 'duplicate-in-file', ref: 2 },
      { line: 6, reason: 'duplicate-in-file', ref: 5 },
    ]);
    expect(plan.items.map((x) => x.line)).toEqual([5]);
  });

  it('unbekannte ID aus anderer Datenbank wird für neue Materialien übernommen (Projektverknüpfungen)', () => {
    const p = ok('ID;Hersteller;Farbnummer;HEX\nfremd-1;Neu;1;#010101\nm1;X;Y;#020202\n');
    const plan = planMaterialImport(p, existing, 'new', ids('x'));
    expect(plan.items.map((x) => x.material.id)).toEqual(['fremd-1', 'x1']);
  });

  it('„Als neu hinzufügen“ legt alle gültigen Zeilen mit neuen IDs an', () => {
    const p = ok(materialsToCsv(existing, 'de'));
    const plan = planMaterialImport(p, existing, 'new', ids('x'));
    expect(plan.updates).toEqual([]);
    expect(plan.identical).toEqual([]);
    expect(plan.items.map((x) => x.material.id)).toEqual(['x1', 'x2', 'x3', 'x4', 'x5']);
    expect(new Set(plan.items.map((x) => x.material.id)).size).toBe(5);
  });

  it('ungültige Werte überschreiben vorhandene nicht; Hinweise nur für geschriebene Zeilen', () => {
    const p = ok('ID;HEX;Stück/Packung;Preis;Länge;Breite\nm1;#3A6EA5;1.250;13;10;10\nm2;#112233;1.250;0;10;10\n');
    const plan = planMaterialImport(p, existing, 'update', ids());
    expect(plan.updates.map((u) => [u.after.id, u.after.piecesPerPack, u.changed])).toEqual([['m1', 0, ['price']]]);
    expect(plan.identical.map((x) => x.material.id)).toEqual(['m2']);
    expect(plan.warnings.map((w) => w.line)).toEqual([2]);
  });

  it('nichts wird verändert: Eingabeliste bleibt unberührt', () => {
    const copy = JSON.parse(JSON.stringify(existing));
    planMaterialImport(ok('ID;HEX;Preis\nm1;#000000;99\n'), existing, 'update', ids());
    expect(JSON.parse(JSON.stringify(existing))).toEqual(copy);
  });
});

describe('Material löschen: Verwendung in Projekten', () => {
  it('zählt Palettenfarben und Materialauswahl je Projekt', () => {
    const projects = [
      { meta: { id: 'p1', name: 'Porträt' }, palette: [{ materialId: 'm1' }, { materialId: 'm2' }, { materialId: 'm1' }], settings: { materialIds: [] } },
      { meta: { id: 'p2', name: 'Bad' }, palette: [], settings: { materialIds: ['m1', 'm3'] } },
      { meta: { id: 'p3', name: 'Küche' }, palette: [{ materialId: 'm2' }], settings: { materialIds: ['m2'] } },
      { meta: { id: 'p4', name: 'Alt' } },
    ];
    expect(findMaterialUsage(projects, 'm1')).toEqual([
      { projectId: 'p1', name: 'Porträt', colors: 2, selected: false },
      { projectId: 'p2', name: 'Bad', colors: 0, selected: true },
    ]);
    expect(findMaterialUsage(projects, 'm9')).toEqual([]);
  });
});

describe('Material-CSV: Übersetzungen', () => {
  it('alle Gründe und Fehlercodes haben Texte in DE, EN und TR', () => {
    const keys = [
      ...SKIP_REASONS.map((r) => `matcsv.skip.${r}`),
      ...WARN_REASONS.map((r) => `matcsv.warn.${r}`),
      ...['empty', 'no-header', 'no-hex-column', 'no-rows'].map((e) => `matcsv.err.${e}`),
      ...['semicolon', 'tab', 'comma', 'other'].map((d) => `matcsv.delim.${d}`),
    ];
    for (const lang of ['de', 'en', 'tr'] as const) {
      const d = dictionaries[lang] as Record<string, string>;
      for (const k of keys) expect(`${lang}:${k}:${!!d[k]}`).toBe(`${lang}:${k}:true`);
    }
  });
});
