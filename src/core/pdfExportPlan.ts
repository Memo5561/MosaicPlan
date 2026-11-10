/**
 * PDF-Export planen (Paket w5-pdf-export-ui) – reine Logik ohne DOM und ohne jsPDF, in Node testbar:
 *
 *  - Abschnittsauswahl als Text: parseSectionRange („A1-C4, D7“ – exakt geprüft, unbekannte Abschnitte werden
 *    abgelehnt, nie still weggelassen) und formatSectionRange (kürzeste Schreibweise einer Auswahl).
 *  - Auswahl ändern: toggleSection / toggleLine (ganze Zeile oder Spalte) / openSections (noch nicht fertig verlegt).
 *  - Speicherbedarf eines Exports als RICHTWERT: jsPDF hält alle Seiten bis zur Ausgabe im Speicher. Gemessen
 *    (Node/V8, Verlegeblätter 1:1): ≈ 1 KB je Stein mit Farbnummer, ≈ 0,1 KB je Stein ohne Nummer, ≈ 5 KB je
 *    Tabellenzeile der Koordinatenliste „je Stein“; die Ausgabe (doc.output) braucht bis zum Doppelten.
 *  - Speichergrenze des Geräts (memoryBudget) und Aufteilung in Teile (planExportParts): aufeinanderfolgende
 *    Abschnitte in Lesereihenfolge, jeder Teil unter der Grenze, gleichmäßig verteilt.
 *  - Markierung „PDF-Export läuft“ im Gerätespeicher: bleibt sie nach einem Neustart stehen, ist der letzte Export
 *    nicht fertig geworden (z. B. Absturz wegen Speichermangel) – die Oberfläche rät dann zum Export in Teilen.
 *
 * Nichts hier ändert Geometrie, Stückzahlen oder Schnittmaße; Seitenzahlen kommen aus planPdfPages (pdfPlan.ts).
 */
import { rowIndexFromLabel, rowLabel, type Layout, type SectionGrid } from './layout';
import { coordModeOf, type PdfOptions } from './pdfOptions';
import { CODE_MIN_CELL, codePlanZoom, planPdfPages, planSheets, type PdfLayoutFacts, type PdfPagePlan, type PiecesInput, type PlanHints } from './pdfPlan';

// ---------------------------------------------------------------- Abschnittsauswahl als Text

export type RangeIssue =
  /** nichts eingegeben */
  | { kind: 'empty' }
  /** kein Abschnitt und kein Bereich, z. B. „A1--“ oder „A01“ */
  | { kind: 'syntax'; token: string }
  /** richtig geschrieben, aber diesen Abschnitt gibt es nicht */
  | { kind: 'unknown'; token: string; id: string };

export interface RangeParse {
  /** gewählte Abschnitte in Rasterreihenfolge (zeilenweise), ohne Doppelte; leer, wenn es Fehler gibt */
  ids: string[];
  issues: RangeIssue[];
}

const ID_RE = /^([A-Z]+)([1-9]\d*)$/;

/**
 * Liest eine Abschnittsauswahl: einzelne Abschnitte („D7“) und rechteckige Bereiche („A1-C4“ = Zeilen A bis C,
 * Spalten 1 bis 4), getrennt durch Komma, Semikolon oder Leerzeichen. Bindestrich, Halbgeviertstrich, „:“ und „bis“/„to“
 * trennen Bereichsenden; Groß-/Kleinschreibung ist egal. Exakt: Jeder Fehler (unlesbarer Eintrag, unbekannter
 * Abschnitt) wird gemeldet, und dann wird NICHTS ausgewählt – nie wird ein Eintrag still weggelassen.
 */
export function parseSectionRange(text: string, grid: Pick<SectionGrid, 'srows' | 'scols'>): RangeParse {
  const norm = text
    .toUpperCase()
    .replace(/\s+(?:BIS|TO)\s+/g, '-')
    .replace(/\s*[-–—−:]\s*/g, '-');
  const tokens = norm.split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) return { ids: [], issues: [{ kind: 'empty' }] };
  const issues: RangeIssue[] = [];
  const picked = new Uint8Array(grid.srows * grid.scols);
  const cellOf = (id: string, token: string): { sr: number; sc: number } | null => {
    const m = ID_RE.exec(id);
    if (!m) {
      issues.push({ kind: 'syntax', token });
      return null;
    }
    const sr = rowIndexFromLabel(m[1]);
    const sc = Number(m[2]) - 1;
    if (!(sr >= 0 && sr < grid.srows && sc >= 0 && sc < grid.scols)) {
      issues.push({ kind: 'unknown', token, id });
      return null;
    }
    return { sr, sc };
  };
  for (const token of tokens) {
    const parts = token.split('-');
    if (parts.length > 2 || parts.some((p) => !p)) {
      issues.push({ kind: 'syntax', token });
      continue;
    }
    const a = cellOf(parts[0], token);
    const b = parts.length === 2 ? cellOf(parts[1], token) : a;
    if (!a || !b) continue;
    for (let sr = Math.min(a.sr, b.sr); sr <= Math.max(a.sr, b.sr); sr++)
      for (let sc = Math.min(a.sc, b.sc); sc <= Math.max(a.sc, b.sc); sc++) picked[sr * grid.scols + sc] = 1;
  }
  if (issues.length) return { ids: [], issues };
  const ids: string[] = [];
  for (let sr = 0; sr < grid.srows; sr++) for (let sc = 0; sc < grid.scols; sc++) if (picked[sr * grid.scols + sc]) ids.push(`${rowLabel(sr)}${sc + 1}`);
  return { ids, issues };
}

/**
 * Kürzeste übliche Schreibweise einer Auswahl („A1-B2, D7“): größtmögliche Rechtecke, zeilenweise von oben links.
 * parseSectionRange(formatSectionRange(ids)) ergibt wieder genau diese Abschnitte. Unbekannte IDs werden ignoriert.
 */
export function formatSectionRange(ids: readonly string[], grid: Pick<SectionGrid, 'srows' | 'scols'>): string {
  const { srows, scols } = grid;
  const on = new Uint8Array(srows * scols);
  for (const id of ids) {
    const m = ID_RE.exec(id);
    if (!m) continue;
    const sr = rowIndexFromLabel(m[1]);
    const sc = Number(m[2]) - 1;
    if (sr >= 0 && sr < srows && sc >= 0 && sc < scols) on[sr * scols + sc] = 1;
  }
  const out: string[] = [];
  for (let sr = 0; sr < srows; sr++)
    for (let sc = 0; sc < scols; sc++) {
      if (!on[sr * scols + sc]) continue;
      let w = 1;
      while (sc + w < scols && on[sr * scols + sc + w]) w++;
      let h = 1;
      grow: while (sr + h < srows) {
        for (let k = 0; k < w; k++) if (!on[(sr + h) * scols + sc + k]) break grow;
        h++;
      }
      for (let y = sr; y < sr + h; y++) for (let x = sc; x < sc + w; x++) on[y * scols + x] = 0;
      const a = `${rowLabel(sr)}${sc + 1}`;
      out.push(w === 1 && h === 1 ? a : `${a}-${rowLabel(sr + h - 1)}${sc + w}`);
    }
  return out.join(', ');
}

// ---------------------------------------------------------------- Auswahl ändern

/**
 * Auswahl in Rasterreihenfolge ohne Doppelte und ohne unbekannte Abschnitte. `null` = alle Abschnitte: auch eine
 * leere Auswahl und eine Auswahl aller Abschnitte werden zu `null` (im PDF fehlt dann nie versehentlich alles).
 */
export function normalizeSelection(ids: readonly string[] | null | undefined, grid: SectionGrid): string[] | null {
  if (!ids) return null;
  const want = new Set(ids);
  const out = grid.sections.filter((s) => want.has(s.id)).map((s) => s.id);
  return out.length === 0 || out.length === grid.sections.length ? null : out;
}

/** Einen Abschnitt an- oder abwählen. Bei „alle“ (null) wählt das Antippen NUR diesen Abschnitt. */
export function toggleSection(sel: readonly string[] | null, id: string, grid: SectionGrid): string[] | null {
  if (!sel) return normalizeSelection([id], grid);
  return normalizeSelection(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id], grid);
}

/**
 * Ganze Abschnittszeile (Buchstabe) oder -spalte (Nummer) an- oder abwählen: sind alle ihre Abschnitte gewählt,
 * werden sie abgewählt, sonst alle hinzugefügt. Bei „alle“ (null) wird NUR diese Zeile bzw. Spalte gewählt.
 */
export function toggleLine(sel: readonly string[] | null, grid: SectionGrid, axis: 'row' | 'col', index: number): string[] | null {
  const line = grid.sections.filter((s) => (axis === 'row' ? s.sr : s.sc) === index).map((s) => s.id);
  if (!line.length) return normalizeSelection(sel, grid);
  if (!sel) return normalizeSelection(line, grid);
  const cur = new Set(sel);
  const all = line.every((id) => cur.has(id));
  for (const id of line) {
    if (all) cur.delete(id);
    else cur.add(id);
  }
  return normalizeSelection([...cur], grid);
}

/** Abschnitte, die noch nicht fertig verlegt sind (verlegt < Steine). Ohne Fortschrittszahlen: null. */
export function openSections(grid: SectionGrid, progress: ReadonlyMap<string, { placed: number; total: number }> | null | undefined): string[] | null {
  if (!progress) return null;
  return grid.sections.filter((s) => {
    const p = progress.get(s.id);
    return !p || p.placed < p.total;
  }).map((s) => s.id);
}

// ---------------------------------------------------------------- Speicherbedarf (Richtwert)

/** Gemessene Richtwerte in Byte (siehe Kopfkommentar). */
export const PDF_MEMORY = {
  /** Stein mit Farbnummer (Verlegeblatt oder Codeplan) */
  codedStone: 1024,
  /** Stein ohne Farbnummer (zu klein für den Maßstab) */
  plainStone: 102,
  /** Tabellenzeile der Koordinatenliste „je Stein“ */
  coordRow: 5120,
  /** kompakte Koordinaten: je Rasterzeile des Abschnitts (Farbfolge) */
  compactRow: 512,
  /** Ausgabe des fertigen Dokuments braucht bis zum Doppelten */
  safety: 2,
} as const;

export interface SectionCost {
  id: string;
  /** Steine des Abschnitts (aus den Zählern; sonst Rasterzellen) */
  stones: number;
  /** davon mit Farbnummer gezeichnet (Blatt + ggf. Codeplan) */
  coded: number;
  /** ohne Farbnummer gezeichnet */
  plain: number;
  /** Tabellenzeilen „je Stein“ (höchstens coordLimit je Datei) */
  coordRows: number;
  /** Richtwert des Speicherbedarfs in Byte (mit Sicherheitsfaktor) */
  bytes: number;
}

/**
 * Speicherbedarf je exportiertem Abschnitt (Rasterreihenfolge) als Richtwert. `stonesOf` liefert die Steinzahl
 * eines Abschnitts (fehlt sie, zählen die Rasterzellen); `facts` (gemessener Seitenplan) nennt je Blatt, ob es
 * Codeplan-Seiten bekommt – ohne Messung gilt dieselbe Regel wie im Seitenplan (alle Steine zu klein → Codeplan).
 */
export function sectionCosts(
  layout: Layout,
  grid: SectionGrid,
  opts: PdfOptions,
  stonesOf?: (id: string) => number | undefined,
  facts?: Pick<PdfLayoutFacts, 'sheets'> | null,
): SectionCost[] {
  const plan = planSheets(layout, grid, opts);
  const tile = Math.min(layout.tileW, layout.tileH);
  const codeless = tile * plan.scale < CODE_MIN_CELL - 1e-6;
  const codeMode = opts.codePlan ?? 'auto';
  const coordMode = coordModeOf(opts);
  const M = PDF_MEMORY;
  const out: SectionCost[] = [];
  for (const s of plan.sections) {
    if (!s.selected) continue;
    const sec = s.section;
    const cells = (sec.c1 - sec.c0) * (sec.r1 - sec.r0);
    const stones = Math.max(0, stonesOf?.(sec.id) ?? cells);
    // Codeplan: die Steine des Blatts werden dort noch einmal – mit Nummer – gezeichnet
    let planShare = 0;
    for (const sh of s.sheets) {
      const k = facts?.sheets?.[sh.key]?.codeK ?? (codeMode === 'off' ? 0 : codeMode === 'always' || codeless ? codePlanZoom(tile, tile, plan.scale).k : 0);
      if (k > 0 && cells > 0) planShare += ((sh.c1 - sh.c0) * (sh.r1 - sh.r0)) / cells;
    }
    const coded = (codeless ? 0 : stones) + stones * Math.min(1, planShare);
    const plain = codeless ? stones : 0;
    const coordRows = coordMode === 'perStone' ? Math.min(stones, Math.max(0, opts.coordLimit)) : 0;
    const compactRows = coordMode === 'compact' ? sec.r1 - sec.r0 : 0;
    const bytes = M.safety * (coded * M.codedStone + plain * M.plainStone + coordRows * M.coordRow + compactRows * M.compactRow);
    out.push({ id: sec.id, stones, coded, plain, coordRows, bytes: Math.round(bytes) });
  }
  return out;
}

// ---------------------------------------------------------------- Speichergrenze

export const PDF_BUDGET = {
  /** Anteil der Heap-Grenze des Browsers, den EIN Export höchstens brauchen soll */
  heapShare: 0.35,
  /** ohne Angabe des Browsers (Firefox, Safari): vorsichtige feste Grenze */
  fallbackBytes: 150 * 1024 * 1024,
  /** kleinste Grenze, auf die nach einem abgebrochenen Export gesenkt wird */
  minBytes: 8 * 1024 * 1024,
} as const;

export interface MemoryBudget {
  bytes: number;
  /** 'heap': aus performance.memory.jsHeapSizeLimit · 'fallback': feste Grenze · 'override': gespeicherte Grenze dieses Geräts */
  source: 'heap' | 'fallback' | 'override';
}

/**
 * Speichergrenze für einen Export: gespeicherte Grenze dieses Geräts (nach einem abgebrochenen Export gesenkt, oder
 * für Tests gesetzt), sonst 35 % der Heap-Grenze des Browsers, sonst 150 MB.
 */
export function memoryBudget(env: { jsHeapSizeLimit?: number | null; overrideMb?: number | null }): MemoryBudget {
  if (env.overrideMb !== undefined && env.overrideMb !== null && Number.isFinite(env.overrideMb) && env.overrideMb > 0)
    return { bytes: Math.round(env.overrideMb * 1024 * 1024), source: 'override' };
  if (env.jsHeapSizeLimit && Number.isFinite(env.jsHeapSizeLimit) && env.jsHeapSizeLimit > 0)
    return { bytes: Math.round(env.jsHeapSizeLimit * PDF_BUDGET.heapShare), source: 'heap' };
  return { bytes: PDF_BUDGET.fallbackBytes, source: 'fallback' };
}

/**
 * Neue Grenze nach einem nicht beendeten Export: Lag sein Richtwert innerhalb der damaligen Grenze, war die Grenze
 * für dieses Gerät zu hoch – künftig gilt die Hälfte seines Richtwerts. Lag er darüber (bewusst „trotzdem als eine
 * Datei“), sagt der Abbruch nichts über die Grenze: null (keine Änderung).
 */
export function loweredBudgetAfterCrash(crashedBytes: number, budgetBytes: number): number | null {
  if (!(crashedBytes > 0) || !(budgetBytes > 0) || crashedBytes > budgetBytes) return null;
  const next = Math.max(PDF_BUDGET.minBytes, Math.floor(crashedBytes / 2));
  return next < budgetBytes ? next : null;
}

// ---------------------------------------------------------------- Aufteilung in Teile

export interface ExportPart {
  /** 0 … n−1 */
  index: number;
  ids: string[];
  stones: number;
  bytes: number;
}

export interface PartsPlan {
  parts: ExportPart[];
  /** Summe aller Abschnitte (eine Datei) */
  totalBytes: number;
  /** Abschnitte, die allein schon über der Grenze liegen (je ein eigener Teil) */
  tooBig: string[];
  /** passt als EINE Datei unter die Grenze */
  fitsSingle: boolean;
}

function cutParts(costs: readonly SectionCost[], cap: number): number[][] {
  const groups: number[][] = [];
  let cur: number[] = [];
  let sum = 0;
  costs.forEach((c, i) => {
    if (cur.length && sum + c.bytes > cap) {
      groups.push(cur);
      cur = [];
      sum = 0;
    }
    cur.push(i);
    sum += c.bytes;
  });
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * Gleichmäßige Aufteilung in genau k aufeinanderfolgende Teile: Schnitt i liegt dort, wo die laufende Summe dem
 * i-ten k-tel der Gesamtsumme am nächsten kommt. Liefert null, wenn ein mehrteiliger Lauf dabei über `cap` käme.
 */
function evenParts(costs: readonly SectionCost[], k: number, cap: number): number[][] | null {
  const n = costs.length;
  if (k < 1 || k > n) return null;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + costs[i].bytes;
  const total = prefix[n];
  const cuts = [0];
  for (let i = 1; i < k; i++) {
    const target = (total * i) / k;
    const lo = cuts[i - 1] + 1;
    const hi = n - (k - i);
    let best = lo;
    for (let j = lo; j <= hi; j++) if (Math.abs(prefix[j] - target) < Math.abs(prefix[best] - target)) best = j;
    cuts.push(best);
  }
  cuts.push(n);
  const groups: number[][] = [];
  for (let i = 0; i < k; i++) {
    const g: number[] = [];
    for (let j = cuts[i]; j < cuts[i + 1]; j++) g.push(j);
    if (g.length > 1 && prefix[cuts[i + 1]] - prefix[cuts[i]] > cap) return null;
    groups.push(g);
  }
  return groups;
}

/**
 * Teilt die exportierten Abschnitte (Rasterreihenfolge) in aufeinanderfolgende Läufe, jeder höchstens `budgetBytes`
 * groß: zuerst die kleinste Anzahl Teile (gierig), dann bei gleicher Anzahl gleichmäßig verteilt (möglichst gleich
 * große Teile; sonst der kleinste größte Teil). Jeder Abschnitt steht in genau einem Teil. Ein Abschnitt, der allein
 * über der Grenze liegt, bildet einen eigenen Teil und wird in `tooBig` genannt – nie teilt er sich einen Teil.
 */
export function planExportParts(costs: readonly SectionCost[], budgetBytes: number): PartsPlan {
  const totalBytes = costs.reduce((a, c) => a + c.bytes, 0);
  const tooBig = costs.filter((c) => c.bytes > budgetBytes).map((c) => c.id);
  let groups = cutParts(costs, budgetBytes);
  const k = groups.length;
  if (k > 1) {
    const even = evenParts(costs, k, budgetBytes);
    if (even) groups = even;
    else {
      // kleinste Obergrenze (≤ Grenze), mit der die gierige Aufteilung bei k Teilen bleibt
      let lo = 0;
      let hi = budgetBytes;
      for (let it = 0; it < 60 && hi - lo > 1; it++) {
        const mid = Math.floor((lo + hi) / 2);
        if (cutParts(costs, mid).length <= k) hi = mid;
        else lo = mid;
      }
      const tight = cutParts(costs, hi);
      if (tight.length === k) groups = tight;
    }
  }
  const parts = groups.map((g, index) => ({
    index,
    ids: g.map((i) => costs[i].id),
    stones: g.reduce((a, i) => a + costs[i].stones, 0),
    bytes: g.reduce((a, i) => a + costs[i].bytes, 0),
  }));
  return { parts, totalBytes, tooBig, fitsSingle: totalBytes <= budgetBytes };
}

// ---------------------------------------------------------------- Seitenplan je Export

/**
 * Seitenplan für eine Abschnittsauswahl aus EINER Messung: `facts` stammen vom Trockenlauf des Generators für
 * `measuredIds` (null = alle). Für genau diese Auswahl ist der Plan exakt; für eine Teilmenge (ein Teil des Exports)
 * gelten die je Abschnitt und Blatt gemessenen Werte weiter; Vorspann und Schnittvorlagen gelten ungefähr, die
 * Koordinatenseiten werden neu geschätzt (alle drei in `estimated` genannt). Ohne `facts`: Schätzung aus den Abschnittszahlen.
 */
export function planForSelection(
  layout: Layout,
  grid: SectionGrid,
  opts: PdfOptions,
  ids: readonly string[] | null,
  stones: PiecesInput,
  facts?: (Partial<PdfLayoutFacts> & PlanHints) | null,
  measuredIds?: readonly string[] | null,
): PdfPagePlan {
  const o: PdfOptions = { ...opts, sectionIds: ids ? [...ids] : null };
  if (!facts) return planPdfPages(layout, grid, o, stones);
  if (sameSelection(ids, measuredIds ?? null, grid)) return planPdfPages(layout, grid, o, facts.stones ?? stones, facts.templateGroups, facts);
  // Teilmenge: Vorspann und Schnittvorlagen der Messung gelten nur ungefähr, Koordinatenseiten werden geschätzt
  const plan = planPdfPages(layout, grid, o, facts.stones ?? stones, facts.templateGroups, { ...facts, coordPages: undefined });
  const estimated = new Set(plan.estimated);
  estimated.add('front');
  if (o.includeTemplates) estimated.add('templates');
  return { ...plan, estimated: [...estimated] };
}

/** Gleiche Auswahl? (null = alle Abschnitte) */
export function sameSelection(a: readonly string[] | null, b: readonly string[] | null, grid: SectionGrid): boolean {
  const na = normalizeSelection(a, grid);
  const nb = normalizeSelection(b, grid);
  if (!na || !nb) return na === nb;
  return na.length === nb.length && na.every((id, i) => id === nb[i]);
}

// ---------------------------------------------------------------- Dateinamen

/**
 * Dateiname eines Exports: `<Projekt>_verlegeplan.pdf`; bei einer Abschnittsauswahl mit den Abschnitten
 * (`…_verlegeplan_A1-B2_D7.pdf`, lange Auswahlen als Anzahl „12x“) und bei Teilen mit „Teil 02 von 12“.
 */
export function exportFileName(base: string, o: { range?: string | null; count?: number; part?: { index: number; total: number; word: string; ofWord: string } } = {}): string {
  let name = `${base}_verlegeplan`;
  if (o.part) {
    const w = String(o.part.total).length;
    name += `_${o.part.word}-${String(o.part.index + 1).padStart(w, '0')}-${o.part.ofWord}-${o.part.total}`;
  }
  if (o.range) {
    const r = o.range.replace(/\s+/g, '').replace(/,/g, '_');
    name += r.length <= 40 ? `_${r}` : `_${o.count ?? r.split('_').length}x`;
  }
  return `${name}.pdf`;
}

// ---------------------------------------------------------------- Markierung „PDF-Export läuft“

export const PDF_INFLIGHT_KEY = 'mp.pdfInFlight';
export const PDF_BUDGET_KEY = 'mp.pdfBudgetMb';

export interface KeyStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface InFlightInfo {
  projectId: string;
  projectName: string;
  /** exportierte Abschnitte und Steine dieses Auftrags */
  sections: number;
  stones: number;
  /** Richtwert des Speicherbedarfs und damalige Grenze (Byte) */
  bytes: number;
  budgetBytes: number;
  /** Teil k von n (0-basiert), falls in Teilen exportiert wurde */
  part?: { index: number; total: number };
  /** Startzeit (ms) */
  at: number;
}

/** Vor jedem PDF-Auftrag setzen. Speicher gesperrt oder voll: ohne Auswirkung (nur Komfort). */
export function markInFlight(store: KeyStore | null | undefined, info: InFlightInfo): void {
  if (!store) return;
  try {
    store.setItem(PDF_INFLIGHT_KEY, JSON.stringify(info));
  } catch {
    /* nur Komfort */
  }
}

/** Nach jedem PDF-Auftrag (Erfolg, Fehler, Abbruch) löschen. */
export function clearInFlight(store: KeyStore | null | undefined): void {
  if (!store) return;
  try {
    store.removeItem(PDF_INFLIGHT_KEY);
  } catch {
    /* nur Komfort */
  }
}

/** Stehen gebliebene Markierung lesen (null: keine oder unlesbar – eine unlesbare wird entfernt). */
export function readInFlight(store: KeyStore | null | undefined): InFlightInfo | null {
  if (!store) return null;
  try {
    const raw = store.getItem(PDF_INFLIGHT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<InFlightInfo> | null;
    const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
    if (!v || typeof v !== 'object' || typeof v.projectId !== 'string' || !num(v.bytes) || !num(v.budgetBytes) || !num(v.at)) {
      store.removeItem(PDF_INFLIGHT_KEY);
      return null;
    }
    const part = v.part && num(v.part.index) && num(v.part.total) ? { index: v.part.index, total: v.part.total } : undefined;
    return {
      projectId: v.projectId,
      projectName: typeof v.projectName === 'string' ? v.projectName : '',
      sections: num(v.sections) ? (v.sections as number) : 0,
      stones: num(v.stones) ? (v.stones as number) : 0,
      bytes: v.bytes as number,
      budgetBytes: v.budgetBytes as number,
      part,
      at: v.at as number,
    };
  } catch {
    return null;
  }
}

/** Gespeicherte Speichergrenze dieses Geräts in MB (null: keine). */
export function readBudgetOverride(store: KeyStore | null | undefined): number | null {
  if (!store) return null;
  try {
    const raw = store.getItem(PDF_BUDGET_KEY);
    if (raw === null || raw.trim() === '') return null;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Speichergrenze dieses Geräts merken (MB) bzw. mit null wieder dem Browser überlassen. */
export function writeBudgetOverride(store: KeyStore | null | undefined, mb: number | null): void {
  if (!store) return;
  try {
    if (mb === null) store.removeItem(PDF_BUDGET_KEY);
    else store.setItem(PDF_BUDGET_KEY, String(Math.round(mb * 100) / 100));
  } catch {
    /* nur Komfort */
  }
}
