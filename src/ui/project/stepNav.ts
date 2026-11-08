/**
 * Schritte des Projekt-Arbeitsbereichs und ihre Abbildung auf die Adresse (Hash-Route).
 *
 * Die Adresse ist die Quelle des angezeigten Schritts: Jeder vom Benutzer gewählte Schritt legt einen
 * eigenen Verlaufseintrag an (`#/project/<id>/<schritt>`), damit Zurück/Vorwärts im Browser und die
 * Zurück-Taste unter Android zwischen den Schritten wechseln. Automatische Weiterleitungen (Öffnen ohne
 * Schritt in der Adresse) ersetzen den Eintrag nur. Reine Logik, ohne DOM testbar.
 */

export const STEPS = ['photo', 'size', 'tiles', 'joint', 'colors', 'shapes', 'compute', 'preview', 'plan', 'pdf'] as const;
export type Step = (typeof STEPS)[number];

/** Schritte, die ein berechnetes Mosaik brauchen (8–10) */
export const RESULT_STEPS: readonly Step[] = ['preview', 'plan', 'pdf'];

export function isStep(s: unknown): s is Step {
  return typeof s === 'string' && (STEPS as readonly string[]).includes(s);
}

export function stepHash(id: string, step: Step): string {
  return `#/project/${id}/${step}`;
}

/** Schritt aus der Adresse – nur, wenn sie auf DIESES Projekt zeigt und einen gültigen Schritt nennt. */
export function stepFromHash(hash: string, id: string): Step | undefined {
  const parts = hash.replace(/^#\/?/, '').split('/');
  if (parts[0] !== 'project' || parts[1] !== id) return undefined;
  return isStep(parts[2]) ? parts[2] : undefined;
}

/**
 * Startschritt beim Öffnen ohne Schritt in der Adresse (z. B. aus „Meine Projekte“):
 * berechnet und schon Steine verlegt → Verlegeplan; berechnet → Vorschau; sonst der zuletzt
 * benutzte Einstellungsschritt (1–7) dieses Projekts, ohne Angabe Schritt 1.
 */
export function resumeStep(o: { computed: boolean; placed: number; lastStep?: string | null }): Step {
  if (o.computed) return o.placed > 0 ? 'plan' : 'preview';
  if (isStep(o.lastStep) && !RESULT_STEPS.includes(o.lastStep)) return o.lastStep;
  return 'photo';
}

export interface StepState {
  /** abgeschlossen (✓): Foto vorhanden bzw. aktuelles Ergebnis vorhanden */
  done: boolean;
  /** Ergebnis vorhanden, aber Einstellungen seitdem geändert */
  warn: boolean;
  /** braucht ein Ergebnis, das es noch nicht gibt (bleibt anklickbar und zeigt dann, was zu tun ist) */
  unavailable: boolean;
}

/** Status je Schritt – nur aus Zuständen, die die App wirklich kennt (kein ✓ für Schritte mit Standardwerten). */
export function stepStates(o: { hasPhoto: boolean; computed: boolean; stale: boolean }): Record<Step, StepState> {
  const current = o.computed && !o.stale;
  const out = {} as Record<Step, StepState>;
  for (const s of STEPS) {
    const result = s === 'compute' || RESULT_STEPS.includes(s);
    out[s] = {
      done: s === 'photo' ? o.hasPhoto : current && (s === 'compute' || s === 'preview' || s === 'plan'),
      warn: result && o.computed && o.stale,
      unavailable: RESULT_STEPS.includes(s) && !o.computed,
    };
  }
  return out;
}

/**
 * Neuer scrollLeft der Schrittleiste, damit der aktive Schritt mittig steht (begrenzt auf den
 * möglichen Bereich). Rechtecke aus getBoundingClientRect, damit nicht auch die Seite scrollt.
 */
export function centeredScrollLeft(o: { scrollLeft: number; scrollWidth: number; clientWidth: number; barLeft: number; chipLeft: number; chipWidth: number }): number {
  const want = o.scrollLeft + (o.chipLeft - o.barLeft) - (o.clientWidth - o.chipWidth) / 2;
  const max = Math.max(0, o.scrollWidth - o.clientWidth);
  return Math.round(Math.min(max, Math.max(0, want)));
}

// ---------- zuletzt benutzter Schritt je Projekt (nur Komfort, nur in diesem Browser)
export interface StepStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
const LAST_KEY = 'mosaicplan.lastStep';
const LAST_MAX = 50;

function defaultStore(): StepStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readMap(store: StepStore | null): Record<string, string> {
  if (!store) return {};
  try {
    const v = JSON.parse(store.getItem(LAST_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function lastStepOf(id: string, store: StepStore | null = defaultStore()): Step | null {
  const s = readMap(store)[id];
  return isStep(s) ? s : null;
}

export function rememberStep(id: string, step: Step, store: StepStore | null = defaultStore()): void {
  if (!store) return;
  try {
    const m = readMap(store);
    delete m[id];
    m[id] = step;
    const keys = Object.keys(m);
    for (const k of keys.slice(0, Math.max(0, keys.length - LAST_MAX))) delete m[k];
    store.setItem(LAST_KEY, JSON.stringify(m));
  } catch {
    /* Speicher gesperrt oder voll: nur Komfort, ohne Auswirkung */
  }
}
