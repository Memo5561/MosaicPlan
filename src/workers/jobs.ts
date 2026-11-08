/**
 * Berechnungsaufträge je Projekt – unabhängig von der Projektansicht (Paket w3-live-preview).
 *
 * Eine Berechnung gehört nicht der Komponente, die sie gestartet hat: Verlässt der Benutzer das Projekt,
 * läuft sie hier weiter und speichert ihr Ergebnis selbst. Öffnet er das Projekt wieder, meldet sich die
 * neue Projektansicht an (attachProject) und zeigt über subscribeJobs Phase, Fortschritt und „Abbrechen“;
 * das Ergebnis übernimmt dann sie.
 *
 * Regeln:
 *  - je Projekt höchstens ein Auftrag,
 *  - app-weit höchstens eine Berechnung im Worker („exklusiv“) – ein zweites Projekt sieht
 *    „Berechnung für „X“ läuft noch“ mit Abbrechen. Das sofortige Übernehmen einer fertigen Vorschau
 *    braucht keinen Worker und ist nicht exklusiv.
 *
 * Reine Logik ohne DOM und ohne Speicherzugriff (in Node testbar). Nach einem Neuladen der Seite ist die
 * Liste leer – eine abgebrochene Berechnung wird nie als „läuft noch“ angezeigt.
 */

export interface JobProgress {
  phase: string;
  /** 0…1 innerhalb der Phase */
  fraction: number;
}

export interface JobInfo {
  readonly jobId: string;
  readonly projectId: string;
  /** Projektname für Meldungen in anderen Projekten (folgt Umbenennungen, siehe renameJob) */
  readonly projectName: string;
  /** true: Berechnung im Worker (app-weit nur eine); false: Übernehmen eines fertigen Ergebnisses */
  readonly exclusive: boolean;
  readonly progress: JobProgress;
  readonly startedAt: number;
}

export interface JobContext {
  /** Fortschritt melden (Phase, Anteil 0…1) */
  report(p: JobProgress): void;
  /** true, sobald cancelJob für diesen Auftrag aufgerufen wurde */
  readonly cancelled: boolean;
}

/** Ein anderer Auftrag läuft bereits (app-weit eine Berechnung bzw. je Projekt ein Auftrag). */
export class JobBusyError extends Error {
  readonly running: JobInfo;
  constructor(running: JobInfo) {
    super('busy');
    this.name = 'JobBusyError';
    this.running = running;
  }
}

interface Job {
  info: JobInfo;
  cancel: () => void;
  cancelled: boolean;
}

const jobs = new Map<string, Job>();
const subs = new Set<() => void>();
let seq = 0;

function notify() {
  for (const fn of [...subs]) {
    try {
      fn();
    } catch (e) {
      console.warn(e);
    }
  }
}

/**
 * Startet einen Auftrag für ein Projekt. Wirft JobBusyError, wenn für dieses Projekt schon einer läuft
 * oder – bei `exclusive` – irgendwo eine andere Berechnung im Worker läuft. `run` beginnt im nächsten
 * Mikrotask; der Auftrag gilt bis zum Ende von `run` (erfolgreich, Fehler oder abgebrochen) als laufend.
 */
export function startJob<T>(o: {
  projectId: string;
  projectName: string;
  exclusive: boolean;
  phase?: string;
  cancel: () => void;
  run: (ctx: JobContext) => Promise<T>;
}): { info: JobInfo; promise: Promise<T> } {
  const own = jobs.get(o.projectId);
  if (own) throw new JobBusyError(own.info);
  if (o.exclusive) {
    const other = runningJob();
    if (other) throw new JobBusyError(other);
  }
  const job: Job = {
    info: { jobId: `job-${++seq}-${Date.now().toString(36)}`, projectId: o.projectId, projectName: o.projectName, exclusive: o.exclusive, progress: { phase: o.phase ?? 'prepare', fraction: 0 }, startedAt: Date.now() },
    cancel: o.cancel,
    cancelled: false,
  };
  jobs.set(o.projectId, job);
  notify();
  const ctx: JobContext = {
    report: (p) => {
      if (jobs.get(o.projectId) !== job) return;
      job.info = { ...job.info, progress: { phase: p.phase, fraction: Math.max(0, Math.min(1, p.fraction)) } };
      notify();
    },
    get cancelled() {
      return job.cancelled;
    },
  };
  const promise = Promise.resolve()
    .then(() => o.run(ctx))
    .finally(() => {
      if (jobs.get(o.projectId) === job) {
        jobs.delete(o.projectId);
        notify();
      }
    });
  return { info: job.info, promise };
}

/** Laufender Auftrag dieses Projekts (Momentaufnahme) oder null. */
export function jobFor(projectId: string): JobInfo | null {
  return jobs.get(projectId)?.info ?? null;
}

/** Laufende Berechnung im Worker (app-weit höchstens eine), optional ohne die eines Projekts. */
export function runningJob(exceptProjectId?: string): JobInfo | null {
  for (const j of jobs.values()) if (j.info.exclusive && j.info.projectId !== exceptProjectId) return j.info;
  return null;
}

/** Läuft irgendein Auftrag (auch das kurze Übernehmen)? */
export function anyJob(): boolean {
  return jobs.size > 0;
}

/** Phase, in der das Ergebnis gespeichert wird – ab hier ist ein Auftrag nicht mehr abbrechbar. */
export const COMMIT_PHASE = 'commit';

/** Läuft für dieses Projekt ein Auftrag, der gerade sein Ergebnis speichert (nicht mehr abbrechbar)? */
export function isCommitting(info: Pick<JobInfo, 'progress'> | null | undefined): boolean {
  return !!info && info.progress.phase === COMMIT_PHASE;
}

/**
 * Bricht den Auftrag eines Projekts ab (Worker wird beendet). Liefert false, wenn keiner lief – oder wenn er gerade
 * sein Ergebnis speichert: Diese Phase ist nicht abbrechbar (sonst hieße es „abgebrochen“, und das Ergebnis würde
 * trotzdem gespeichert). Ein Löschen des Projekts während des Speicherns verhindert das Speichern selbst.
 */
export function cancelJob(projectId: string): boolean {
  const j = jobs.get(projectId);
  if (!j || isCommitting(j.info)) return false;
  j.cancelled = true;
  try {
    j.cancel();
  } catch (e) {
    console.warn(e);
  }
  return true;
}

/** Projektname eines laufenden Auftrags aktualisieren (Umbenennen während der Berechnung). */
export function renameJob(projectId: string, name: string): void {
  const j = jobs.get(projectId);
  if (!j || j.info.projectName === name) return;
  j.info = { ...j.info, projectName: name };
  notify();
}

/** Benachrichtigung bei Start, Fortschritt, Umbenennen und Ende eines Auftrags. */
export function subscribeJobs(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

// ---------- Angemeldete Projektansichten
// Die jeweils geöffnete Ansicht eines Projekts übernimmt Ergebnisse in ihren Arbeitsspeicher. Ist keine
// angemeldet, speichert der Auftrag nur (die nächste Ansicht lädt das Ergebnis aus dem Gerätespeicher).
const handlers = new Map<string, unknown>();

/** Meldet die Ansicht eines Projekts an; die zurückgegebene Funktion meldet genau diese wieder ab. */
export function attachProject<H>(projectId: string, handler: H): () => void {
  handlers.set(projectId, handler);
  return () => {
    if (handlers.get(projectId) === handler) handlers.delete(projectId);
  };
}

/** Zurzeit angemeldete Ansicht eines Projekts (oder undefined). */
export function projectHandler<H>(projectId: string): H | undefined {
  return handlers.get(projectId) as H | undefined;
}

// ---------- Bearbeitungen während eines Auftrags
// Zählt Bearbeitungen am angezeigten Raster je Projekt (Steinfarbe/-form, verlegt, Abschnitt fertig) –
// über alle Ansichten hinweg. Ein Auftrag vergleicht den Stand bei Start und Ende: Wurde dazwischen am
// Raster gearbeitet, wird sein Ergebnis nicht still übernommen.
const edits = new Map<string, number>();

export function noteEdit(projectId: string): void {
  edits.set(projectId, (edits.get(projectId) ?? 0) + 1);
}

export function editCount(projectId: string): number {
  return edits.get(projectId) ?? 0;
}

/** Nur für Tests: alles zurücksetzen. */
export function resetJobsForTest(): void {
  jobs.clear();
  handlers.clear();
  edits.clear();
  subs.clear();
}
