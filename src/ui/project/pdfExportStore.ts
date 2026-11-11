/**
 * Laufende und fertige PDF-Exporte eines Projekts – unabhängig von der Ansicht (Paket w5-pdf-export-ui).
 *
 * Ein Export gehört nicht dem Schritt „PDF“, der ihn gestartet hat: Wechselt der Benutzer den Schritt, läuft er
 * weiter; kehrt er zurück, sieht er Fortschritt, „Abbrechen“ und die fertigen Dateien wieder. Es läuft höchstens
 * EIN Export (ein jsPDF-Dokument im Speicher) – Teile werden nacheinander erzeugt, nie mehrere Downloads auf einmal.
 *
 * Vor jedem Auftrag wird im Gerätespeicher „Export läuft“ vermerkt und danach gelöscht (auch bei Fehler, Abbruch und
 * beim normalen Verlassen der Seite). Steht der Vermerk beim nächsten Öffnen noch da, ist der Export nicht fertig
 * geworden – z. B. weil der Speicher nicht reichte und die Anzeige neu gestartet wurde.
 *
 * Mehrere Tabs teilen sich den Gerätespeicher: Der Vermerk nennt die Seite, die exportiert (owner), und trägt alle
 * PDF_INFLIGHT_BEAT_MS ein Lebenszeichen (beat). Solange es jünger als 30 s ist – oder die Seite die Web-Sperre
 * PDF_LOCK_NAME hält (Browser geben sie erst frei, wenn die Seite wirklich weg ist) –, gilt der Export als laufend:
 * Kein anderer Tab löscht den Vermerk oder senkt deswegen die Speichergrenze.
 *
 * Fertige Dateien: im Browser bleibt je Datei eine Adresse zum erneuten Herunterladen bzw. Öffnen, bis sie ersetzt
 * oder verworfen wird (dann wird die Adresse freigegeben); im APK steht das echte Speicherergebnis (SaveResult).
 */
import {
  clearInFlight,
  inFlightLive,
  loweredBudgetAfterCrash,
  markInFlight,
  PDF_INFLIGHT_BEAT_MS,
  readInFlight,
  writeBudgetOverride,
  type InFlightInfo,
  type KeyStore,
} from '../../core/pdfExportPlan';
import type { PdfBreakdown } from '../../core/pdf';
import { isNative, type SaveResult } from '../../platform';
import { cancelChannel } from '../../workers/client';
import { downloadBlob } from '../components';
import { announceSave } from '../SaveResultNote';

export interface PdfFile {
  /** 'single' oder 'part-<Nummer ab 0>' */
  key: string;
  name: string;
  size: number;
  /** nur im Browser: Adresse der Datei (Öffnen / erneut herunterladen) */
  url: string | null;
  save: SaveResult;
  /** Optionen/Auswahl, zu denen die Datei gehört (siehe pruneFiles) */
  sig: string;
  /** exportierte Abschnitte (null = alle) */
  ids: string[] | null;
  /** echte Seitenzahl und Aufteilung je Teil (vom Generator gezählt); fehlt, wenn `produce` nur die Datei lieferte */
  report?: PdfFileReport;
}

/** Seiten eines erzeugten PDFs (Paket w6-pdf-finish) */
export interface PdfFileReport {
  pages: number;
  breakdown: PdfBreakdown;
  planMatches: boolean;
}

export interface PdfJobState {
  /** laufender Auftrag: Schlüssel der Datei, Anteil 0…1 und Phase */
  busy: { key: string; f: number; label: string } | null;
  error: string | null;
  /** letzter Auftrag wurde abgebrochen */
  cancelled: boolean;
  files: PdfFile[];
}

export const CANCELLED = 'abgebrochen';

const EMPTY: PdfJobState = { busy: null, error: null, cancelled: false, files: [] };
const states = new Map<string, PdfJobState>();
const listeners = new Set<() => void>();
const viewers = new Map<string, number>();
/** Projekt des laufenden Auftrags (app-weit höchstens einer) */
let running: string | null = null;
/** „Abbrechen“ wurde gedrückt (auch während der Bildvorbereitung, die noch nicht im Worker läuft) */
let cancelRequested = false;

function emit() {
  for (const fn of [...listeners]) fn();
}
function patch(projectId: string, p: Partial<PdfJobState>) {
  states.set(projectId, { ...(states.get(projectId) ?? EMPTY), ...p });
  emit();
}

export function localStore(): KeyStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function pdfJobState(projectId: string): PdfJobState {
  return states.get(projectId) ?? EMPTY;
}

export function subscribePdfJobs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Läuft irgendwo ein PDF-Export (auch eines anderen Projekts)? */
export function pdfJobRunning(): string | null {
  return running;
}

/** Die Ansicht „PDF“ eines Projekts ist offen (Ergebnisse werden dort angezeigt statt app-weit gemeldet). */
export function watchPdfJobs(projectId: string): () => void {
  viewers.set(projectId, (viewers.get(projectId) ?? 0) + 1);
  return () => {
    const n = (viewers.get(projectId) ?? 1) - 1;
    if (n <= 0) viewers.delete(projectId);
    else viewers.set(projectId, n);
  };
}

function revoke(f: PdfFile) {
  if (f.url) URL.revokeObjectURL(f.url);
}

/** Alles, wovon der Inhalt eines PDFs abhängt (Schritt 10, siehe pdfFileSig). */
export interface PdfSigInput {
  /** Optionen inkl. Abschnittsauswahl (JSON) */
  optsKey: string;
  /** Bearbeitungsstand und Kennung des Rasters (neues Raster = neue Kennung) */
  version: number;
  mosaicRev: string;
  gridIds: number[];
  lang: string;
  photoReplaced: boolean;
  /** Maße des Originalfotos im PDF ('' = keins) und Zuschnitt/Drehung/Korrekturen des Fotos */
  original: string;
  adjust: unknown;
  palette: unknown;
  /** den Farben zugeordnete Materialien */
  materials: unknown;
  settings: unknown;
  projectName: string;
  /** Aufteilung in Teile (Abschnitte je Teil) bzw. 0 */
  parts: number[] | 0;
}

/**
 * Kennung „zu welchem Stand gehört eine fertige Datei“: dieselben Angaben, mit denen Schritt 10 die Seiten misst –
 * Optionen, Raster, Palette, zugeordnete Materialien, Einstellungen, Projektname, Sprache, Foto und Aufteilung. Ändert
 * sich eine davon, verwirft pruneFiles die Datei – nie wird ein veraltetes PDF als fertig angeboten.
 */
export function pdfFileSig(i: PdfSigInput): string {
  return JSON.stringify([i.optsKey, i.version, i.mosaicRev, i.gridIds, i.lang, i.photoReplaced, i.original, i.adjust ?? null, i.palette ?? null, i.materials ?? null, i.settings ?? null, i.projectName, i.parts]);
}

/** Verwirft fertige Dateien, die nicht (mehr) zu den aktuellen Optionen gehören, und gibt ihre Adressen frei. */
export function pruneFiles(projectId: string, sig: string): void {
  const st = states.get(projectId);
  if (!st || st.files.every((f) => f.sig === sig)) return;
  st.files.filter((f) => f.sig !== sig).forEach(revoke);
  patch(projectId, { files: st.files.filter((f) => f.sig === sig) });
}

/** Verwirft die fertigen Dateien aller ANDEREN Projekte (deren Adressen hielten sonst die PDFs im Speicher). */
export function dropOtherProjects(projectId: string): void {
  for (const [id, st] of states) {
    if (id === projectId || id === running) continue;
    st.files.forEach(revoke);
    states.delete(id);
  }
}

/** Meldungen (Fehler, „abgebrochen“) ausblenden. */
export function clearPdfMessages(projectId: string): void {
  const st = states.get(projectId);
  if (st && (st.error || st.cancelled)) patch(projectId, { error: null, cancelled: false });
}

/** Bricht den laufenden Export ab (der PDF-Worker wird beendet). */
export function cancelPdfJob(): void {
  if (!running) return;
  cancelRequested = true;
  cancelChannel('pdf');
}

/** Kennung dieser Seite (Tab) – neu bei jedem Laden; steht im Vermerk „Export läuft“ */
export const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
/** Web-Sperre, die die exportierende Seite hält (navigator.locks; wird mit der Seite freigegeben) */
export const PDF_LOCK_NAME = 'mp.pdfExport';

interface LockLike {
  request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void> | void): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[] }>;
}
function webLocks(): LockLike | null {
  try {
    const l = typeof navigator !== 'undefined' ? (navigator as unknown as { locks?: LockLike }).locks : undefined;
    return l && typeof l.request === 'function' && typeof l.query === 'function' ? l : null;
  } catch {
    return null;
  }
}

const onPageHide = () => clearInFlight(localStore(), TAB_ID);

/**
 * Führt EINEN Export aus: `produce` liefert das PDF (im Worker erzeugt), danach wird gespeichert bzw. heruntergeladen
 * (abgewartet) und die Datei in die Liste gestellt – eine frühere Datei mit demselben Schlüssel wird ersetzt und ihre
 * Adresse freigegeben. Liefert false, wenn schon ein Export läuft.
 */
export async function runPdfJob(o: {
  projectId: string;
  key: string;
  name: string;
  sig: string;
  ids: string[] | null;
  inFlight: InFlightInfo;
  /** `cancelled()` nach jedem Schritt außerhalb des Workers prüfen und dann mit CANCELLED abbrechen */
  produce: (progress: (f: number, label: string) => void, cancelled: () => boolean) => Promise<ArrayBuffer | { pdf: ArrayBuffer; report: PdfFileReport }>;
}): Promise<boolean> {
  if (running) return false;
  running = o.projectId;
  cancelRequested = false;
  const store = localStore();
  const mark: InFlightInfo = { ...o.inFlight, owner: TAB_ID, beat: Date.now() };
  markInFlight(store, mark);
  // Lebenszeichen: andere Tabs halten den Vermerk dann nicht für einen Absturz
  let lastBeat = mark.beat ?? 0;
  const beat = () => {
    lastBeat = Date.now();
    const cur = readInFlight(store);
    if (cur && cur.owner === TAB_ID) markInFlight(store, { ...cur, beat: lastBeat });
  };
  const beatTimer = setInterval(beat, PDF_INFLIGHT_BEAT_MS);
  // Web-Sperre (falls vorhanden): gilt auch, wenn ein Hintergrund-Tab seine Zeitgeber drosselt
  let releaseLock: (() => void) | null = null;
  let ended = false;
  webLocks()
    ?.request(PDF_LOCK_NAME, { ifAvailable: true }, (lock) =>
      !lock || ended
        ? undefined
        : new Promise<void>((res) => {
            releaseLock = res;
          }),
    )
    .catch(() => {});
  // normales Verlassen der Seite ist kein Absturz: Vermerk dabei löschen
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);
  patch(o.projectId, { busy: { key: o.key, f: 0, label: 'images' }, error: null, cancelled: false });
  try {
    const out = await o.produce(
      (f, label) => {
        if (running === o.projectId) patch(o.projectId, { busy: { key: o.key, f, label } });
        if (Date.now() - lastBeat >= PDF_INFLIGHT_BEAT_MS) beat();
      },
      () => cancelRequested,
    );
    if (cancelRequested) throw new Error(CANCELLED);
    const withReport = 'report' in out && 'pdf' in out;
    const buf = withReport ? out.pdf : (out as ArrayBuffer);
    const report = withReport ? out.report : undefined;
    const blob = new Blob([buf], { type: 'application/pdf' });
    const save = await downloadBlob(blob, o.name, { announce: false });
    // Ansicht inzwischen geschlossen: Ergebnis im APK app-weit melden (sonst erführe der Benutzer nichts davon)
    if (!viewers.has(o.projectId)) announceSave(save);
    const file: PdfFile = { key: o.key, name: o.name, size: blob.size, url: isNative() ? null : URL.createObjectURL(blob), save, sig: o.sig, ids: o.ids, ...(report ? { report } : {}) };
    const prev = pdfJobState(o.projectId).files;
    prev.filter((f) => f.key === o.key).forEach(revoke);
    patch(o.projectId, { files: [...prev.filter((f) => f.key !== o.key), file] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === CANCELLED) patch(o.projectId, { cancelled: true });
    else patch(o.projectId, { error: msg });
  } finally {
    clearInterval(beatTimer);
    ended = true;
    (releaseLock as (() => void) | null)?.();
    clearInFlight(store, TAB_ID);
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
    running = null;
    patch(o.projectId, { busy: null });
  }
  return true;
}

// ---------------------------------------------------------------- nicht beendeter Export (Absturz)

export interface CrashNotice {
  info: InFlightInfo;
  /** neue, gesenkte Speichergrenze dieses Geräts in Byte (null: Grenze unverändert) */
  loweredToBytes: number | null;
}

let crash: CrashNotice | null = null;
let crashChecked = false;
/** Abfrage der Web-Sperre läuft (asynchron) */
let lockQuery = false;
/** so lange nach dem letzten Lebenszeichen kann die Web-Sperre eines eben gestarteten Exports noch fehlen (ms) */
const LOCK_GRACE_MS = 3_000;

/** Derselbe Vermerk? (zwischen Lesen und Löschen kann ein anderer Tab einen neuen gesetzt haben) */
const sameMark = (a: InFlightInfo, b: InFlightInfo | null) => !!b && a.at === b.at && a.owner === b.owner && a.projectId === b.projectId;

function declareCrash(info: InFlightInfo, currentBudgetBytes: number): void {
  const store = localStore();
  if (!sameMark(info, readInFlight(store))) {
    // inzwischen gelöscht oder durch einen neuen Export ersetzt: kein Absturz dieses Vermerks
    return;
  }
  crashChecked = true;
  clearInFlight(store);
  const lowered = loweredBudgetAfterCrash(info.bytes, Math.min(info.budgetBytes, currentBudgetBytes));
  if (lowered !== null) writeBudgetOverride(store, lowered / (1024 * 1024));
  crash = { info, loweredToBytes: lowered };
}

/**
 * Prüft, ob der Vermerk „Export läuft“ eines früheren Exports stehen geblieben ist (der Export wurde also nicht
 * fertig). Dann wird der Vermerk gelöscht und – falls der Export unter der damaligen Grenze lag – die Speichergrenze
 * dieses Geräts gesenkt und gemerkt. Der Hinweis bleibt, bis er geschlossen wird. Einmal je Sitzung entschieden –
 * außer der Vermerk gehört zu einem Export, der in einem anderen Tab noch läuft (frisches Lebenszeichen oder gehaltene
 * Web-Sperre): Dann bleibt alles unverändert und die Oberfläche fragt später erneut. Mit Web-Sperren fällt die
 * Entscheidung asynchron; ihr Ergebnis wird über subscribePdfJobs gemeldet.
 */
export function detectCrashedExport(currentBudgetBytes: number, now: number = Date.now()): CrashNotice | null {
  if (running || crashChecked) return crash;
  const store = localStore();
  const info = readInFlight(store);
  if (!info) {
    crashChecked = true;
    return crash;
  }
  const locks = webLocks();
  if (locks) {
    // Web-Sperre gehalten = der Export läuft in einer anderen Seite. Nicht gehalten = die Seite ist weg (Browser geben
    // die Sperre erst mit der Seite frei) – außer der Vermerk ist ganz frisch (die Sperre wird gerade angefordert).
    if (!lockQuery) {
      lockQuery = true;
      const fresh = info.owner !== TAB_ID && now - Math.max(info.at, info.beat ?? 0) < LOCK_GRACE_MS;
      const decide = (held: boolean) => {
        lockQuery = false;
        if (held || fresh || crashChecked || running) return;
        declareCrash(info, currentBudgetBytes);
        emit();
      };
      locks.query().then(
        (st) => decide((st.held ?? []).some((l) => l.name === PDF_LOCK_NAME)),
        // Abfrage gescheitert: nach dem Lebenszeichen entscheiden
        () => decide(inFlightLive(info, TAB_ID, now)),
      );
    }
    return crash;
  }
  // ohne Web-Sperren: frisches Lebenszeichen einer anderen Seite = dieser Export läuft noch – nichts löschen, nichts senken
  if (inFlightLive(info, TAB_ID, now)) return crash;
  declareCrash(info, currentBudgetBytes);
  return crash;
}

export function crashNotice(): CrashNotice | null {
  return crash;
}

export function dismissCrashNotice(): void {
  if (!crash) return;
  crash = null;
  emit();
}

/** Nur für Tests: alles zurücksetzen. */
export function resetPdfJobsForTest(): void {
  states.clear();
  listeners.clear();
  viewers.clear();
  running = null;
  cancelRequested = false;
  crash = null;
  crashChecked = false;
  lockQuery = false;
}
