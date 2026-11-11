/**
 * Texte des Pakets w6-pdf-finish: echte Seitenzahl nach dem Erzeugen (mit Aufteilung je Teil des PDFs), „Teil k/n
 * (Abschnitte …)“ in jeder Kopfzeile eines Teil-PDFs und die Seiten jeder Koordinatenart in der Auswahl.
 */
export const de: Record<string, string> = {
  'w6pf.pdf.partHead': 'Teil {k}/{n} (Abschnitte {range})',
  'w6pf.done': 'PDF erstellt ({size}): {pages}',
  'w6pf.done.same': 'wie vorab geschätzt',
  'w6pf.done.differs': 'vorab geschätzt: ca. {n}',
  'w6pf.bd.entry': '{label}: {n}',
  'w6pf.bd.front': 'Deckblatt bis Materialliste',
  'w6pf.bd.sections': 'Abschnittsseiten',
  'w6pf.bd.sheets': 'Verlegeblätter',
  'w6pf.bd.sheetLegends': 'Legendenseiten',
  'w6pf.bd.codePlans': 'Codeplan',
  'w6pf.bd.cutLists': 'Zuschnittlisten',
  'w6pf.bd.templates': 'Schnittvorlagen',
  'w6pf.bd.coords': 'Koordinaten',
  'w6pf.coordPages': 'ca. {n} S.',
  'w6pf.coordOffHint': 'Eingeschaltet: kompakt {compact}, je Stein {perStone}',
};

export const en: Record<string, string> = {
  'w6pf.pdf.partHead': 'Part {k}/{n} (sections {range})',
  'w6pf.done': 'PDF created ({size}): {pages}',
  'w6pf.done.same': 'as estimated beforehand',
  'w6pf.done.differs': 'estimated beforehand: approx. {n}',
  'w6pf.bd.entry': '{label}: {n}',
  'w6pf.bd.front': 'Cover page to material list',
  'w6pf.bd.sections': 'Section pages',
  'w6pf.bd.sheets': 'Laying sheets',
  'w6pf.bd.sheetLegends': 'Legend pages',
  'w6pf.bd.codePlans': 'Code plan',
  'w6pf.bd.cutLists': 'Cut lists',
  'w6pf.bd.templates': 'Cutting templates',
  'w6pf.bd.coords': 'Coordinates',
  'w6pf.coordPages': 'approx. {n} p.',
  'w6pf.coordOffHint': 'When switched on: compact {compact}, per tile {perStone}',
};

export const tr: Record<string, string> = {
  'w6pf.pdf.partHead': 'Kısım {k}/{n} (bölümler {range})',
  'w6pf.done': 'PDF oluşturuldu ({size}): {pages}',
  'w6pf.done.same': 'önceden tahmin edildiği gibi',
  'w6pf.done.differs': 'önceden tahmin: yakl. {n}',
  'w6pf.bd.entry': '{label}: {n}',
  'w6pf.bd.front': 'Kapak sayfasından malzeme listesine',
  'w6pf.bd.sections': 'Bölüm sayfaları',
  'w6pf.bd.sheets': 'Döşeme paftaları',
  'w6pf.bd.sheetLegends': 'Renk açıklaması sayfaları',
  'w6pf.bd.codePlans': 'Kod planı',
  'w6pf.bd.cutLists': 'Kesim listeleri',
  'w6pf.bd.templates': 'Kesim şablonları',
  'w6pf.bd.coords': 'Koordinatlar',
  'w6pf.coordPages': 'yakl. {n} s.',
  'w6pf.coordOffHint': 'Açıldığında: kısa {compact}, taş başına {perStone}',
};
