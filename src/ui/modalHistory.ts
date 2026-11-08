/**
 * Dialoge im Browserverlauf: Jeder offene Dialog (Modal) belegt einen eigenen Verlaufseintrag
 * (gleiche URL, nur `history.state` ändert sich). Dadurch schließt die Zurück-Taste/-Geste
 * (Browser, PWA, Android-WebView) zuerst den obersten Dialog, statt das Projekt zu verlassen.
 *
 * Modell: Die Anzahl der Dialog-Einträge über dem Basiseintrag (`mpModalDepth` im State) soll gleich
 * der Anzahl offener Dialoge sein. Abweichungen werden ausgeglichen:
 *  - Dialog öffnet → pushState (Tiefe + 1).
 *  - Zurück (popstate auf geringere Tiefe) → die obersten Dialoge über der neuen Tiefe schließen (LIFO).
 *  - ✕/Esc/Hintergrund → history.back(); der Dialog schließt beim popstate.
 *  - Dialog verschwindet programmatisch (Speichern, Abbrechen …) → eigener Eintrag wird mit history.go(−n) entfernt.
 *  - StrictMode-Doppel-Mount: Abgleich erst in einer Microtask, daher kein doppelter Eintrag.
 *  - Vorwärts auf einen veralteten Dialog-Eintrag → sofort wieder zurück.
 * Die Logik ist ohne DOM testbar (siehe tests/w1-touch-input-safety.test.ts).
 */

export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string): void;
  go(delta: number): void;
}

export interface ModalHistoryEnv {
  history: HistoryLike;
  onPopState: (fn: () => void) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  queueMicrotask: (fn: () => void) => void;
}

export interface ModalHandle {
  /** Benutzer möchte schließen (✕, Esc, Hintergrund): geht über den Verlauf zurück. */
  requestClose: () => void;
  /** oberster offener Dialog? (nur dieser reagiert auf Esc) */
  isTop: () => boolean;
  /** beim Unmount aufrufen */
  release: () => void;
}

interface Entry {
  id: number;
  close: () => void;
  closing: boolean;
  released: boolean;
}

/** Wartezeit, bis ein eigener Verlaufsschritt als verloren gilt (dann wird direkt geschlossen). */
const TRAVERSE_TIMEOUT_MS = 800;

export function modalDepth(state: unknown): number {
  const d = state && typeof state === 'object' ? (state as { mpModalDepth?: unknown }).mpModalDepth : undefined;
  return typeof d === 'number' && Number.isInteger(d) && d > 0 ? d : 0;
}

export function createModalHistory(env: ModalHistoryEnv) {
  const h = env.history;
  const entries: Entry[] = [];
  let seq = 0;
  let traversing = false;
  let target = 0;
  let timer: unknown = null;
  let pendingClose: Entry[] = [];
  let syncQueued = false;

  const depth = () => modalDepth(h.state);
  const active = () => entries.filter((e) => !e.closing);
  const baseState = (): Record<string, unknown> => {
    const s = h.state;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
    const rest = { ...(s as Record<string, unknown>) };
    delete rest.mpModal;
    delete rest.mpModalDepth;
    return rest;
  };

  const traverse = (delta: number) => {
    traversing = true;
    target = depth() + delta;
    if (timer !== null) env.clearTimeout(timer);
    timer = env.setTimeout(() => {
      timer = null;
      finishTraverse();
      sync();
    }, TRAVERSE_TIMEOUT_MS);
    h.go(delta);
  };

  const finishTraverse = () => {
    traversing = false;
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
    const pc = pendingClose;
    pendingClose = [];
    for (const e of pc) if (!e.released) e.close();
  };

  const sync = () => {
    syncQueued = false;
    if (traversing) return; // popstate gleicht danach erneut ab
    const cur = depth();
    const act = active();
    const want = act.length;
    if (cur < want) {
      for (let k = cur + 1; k <= want; k++) h.pushState({ ...baseState(), mpModal: act[k - 1].id, mpModalDepth: k }, '');
    } else if (cur > want) traverse(want - cur);
  };

  const queueSync = () => {
    if (syncQueued) return;
    syncQueued = true;
    env.queueMicrotask(sync);
  };

  env.onPopState(() => {
    const d = depth();
    const own = traversing && d === target;
    finishTraverse(); // vom Benutzer angeforderte Schließungen ausführen
    if (!own) {
      // Zurück-Taste/-Geste: alle Dialoge über der neuen Tiefe schließen, oberster zuerst
      const act = active();
      for (const e of act.slice(d).reverse()) {
        e.closing = true;
        e.close();
      }
    }
    sync();
  });

  // Nach einem Neuladen auf einem Dialog-Eintrag ist kein Dialog offen: zurück auf den Basiseintrag.
  if (depth() > 0) traverse(-depth());

  const requestClose = (e: Entry) => {
    if (e.released) return;
    if (e.closing) {
      // schon angefordert, aber noch offen (z. B. Eltern-Komponente hat nicht geschlossen): direkt
      if (!pendingClose.includes(e)) e.close();
      return;
    }
    const act = active();
    const k = act.indexOf(e) + 1;
    e.closing = true;
    if (!traversing && k === act.length && depth() === k) {
      pendingClose.push(e);
      traverse(-1);
    } else {
      e.close();
      queueSync();
    }
  };

  return {
    register(close: () => void): ModalHandle {
      const e: Entry = { id: ++seq, close, closing: false, released: false };
      entries.push(e);
      sync();
      return {
        requestClose: () => requestClose(e),
        isTop: () => {
          const act = active();
          return act[act.length - 1] === e;
        },
        release: () => {
          if (e.released) return;
          e.released = true;
          const i = entries.indexOf(e);
          if (i >= 0) entries.splice(i, 1);
          pendingClose = pendingClose.filter((x) => x !== e);
          queueSync();
        },
      };
    },
    /** offene (nicht schließende) Dialoge – für Tests */
    openCount: () => active().length,
  };
}

export type ModalHistory = ReturnType<typeof createModalHistory>;

let instance: ModalHistory | null = null;

/** Gemeinsame Instanz im Browser; null ohne `window` (Tests in Node). */
export function getModalHistory(): ModalHistory | null {
  if (instance) return instance;
  if (typeof window === 'undefined' || typeof history === 'undefined') return null;
  instance = createModalHistory({
    history: window.history,
    onPopState: (fn) => window.addEventListener('popstate', fn),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (id) => window.clearTimeout(id as number),
    queueMicrotask: (fn) => queueMicrotask(fn),
  });
  return instance;
}
