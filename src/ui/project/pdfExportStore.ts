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
 * Fertige Dateien: im Browser bleibt je Datei eine Adresse zum erneuten Herunterladen bzw. Öffnen, bis sie ersetzt
 * oder verworfen wird (dann wird die Adresse freigegeben); im APK steht das echte Speicherergebnis (SaveResult).
 */
import { clearInFlight, loweredBudgetAfterCrash, markInFlight, readInFlight, writeBudgetOverride, type InFlightInfo, type KeyStore } from '../../core/pdfExportPlan';
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

const onPageHide = () => clearInFlight(localStore());

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
  produce: (progress: (f: number, label: string) => void, cancelled: () => boolean) => Promise<ArrayBuffer>;
}): Promise<boolean> {
  if (running) return false;
  running = o.projectId;
  cancelRequested = false;
  const store = localStore();
  markInFlight(store, o.inFlight);
  // normales Verlassen der Seite ist kein Absturz: Vermerk dabei löschen
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);
  patch(o.projectId, { busy: { key: o.key, f: 0, label: 'images' }, error: null, cancelled: false });
  try {
    const buf = await o.produce(
      (f, label) => {
        if (running === o.projectId) patch(o.projectId, { busy: { key: o.key, f, label } });
      },
      () => cancelRequested,
    );
    if (cancelRequested) throw new Error(CANCELLED);
    const blob = new Blob([buf], { type: 'application/pdf' });
    const save = await downloadBlob(blob, o.name, { announce: false });
    // Ansicht inzwischen geschlossen: Ergebnis im APK app-weit melden (sonst erführe der Benutzer nichts davon)
    if (!viewers.has(o.projectId)) announceSave(save);
    const file: PdfFile = { key: o.key, name: o.name, size: blob.size, url: isNative() ? null : URL.createObjectURL(blob), save, sig: o.sig, ids: o.ids };
    const prev = pdfJobState(o.projectId).files;
    prev.filter((f) => f.key === o.key).forEach(revoke);
    patch(o.projectId, { files: [...prev.filter((f) => f.key !== o.key), file] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === CANCELLED) patch(o.projectId, { cancelled: true });
    else patch(o.projectId, { error: msg });
  } finally {
    clearInFlight(store);
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

/**
 * Prüft einmal je Sitzung, ob der Vermerk „Export läuft“ eines früheren Exports stehen geblieben ist (der Export
 * wurde also nicht fertig). Dann wird der Vermerk gelöscht und – falls der Export unter der damaligen Grenze lag –
 * die Speichergrenze dieses Geräts gesenkt und gemerkt. Der Hinweis bleibt, bis er geschlossen wird.
 */
export function detectCrashedExport(currentBudgetBytes: number): CrashNotice | null {
  if (running || crashChecked) return crash;
  crashChecked = true;
  const store = localStore();
  const info = readInFlight(store);
  if (!info) return crash;
  clearInFlight(store);
  const lowered = loweredBudgetAfterCrash(info.bytes, Math.min(info.budgetBytes, currentBudgetBytes));
  if (lowered !== null) writeBudgetOverride(store, lowered / (1024 * 1024));
  crash = { info, loweredToBytes: lowered };
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
}
