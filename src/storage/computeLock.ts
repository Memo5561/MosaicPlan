/**
 * Welche Projekte gerade berechnet werden – in dieser Seite (auch von einer bereits geschlossenen
 * Projektansicht, deren Berechnung im Hintergrund weiterläuft) und in anderen Tabs.
 *
 * Solange eine Berechnung läuft, ist die Palette gesperrt: Das Ergebnis bestimmt, worauf die
 * Farbindizes des neuen Rasters zeigen. Die eigentliche Absicherung liegt in commitComputed
 * (resolveComputedPalette); diese Sperre verhindert nur, dass Benutzer überhaupt in diese Lage kommen.
 *
 * Andere Tabs werden per BroadcastChannel benachrichtigt. Läuft die Berechnung länger, wird die
 * Meldung regelmäßig wiederholt; bleibt sie aus (Tab geschlossen/abgestürzt), erlischt die Sperre.
 */
import { broadcast, onStoreEvent, uid } from './db';

export const LOCK_HEARTBEAT_MS = 4000;
export const LOCK_EXPIRE_MS = 13000;

/** Projekt-ID → Kennung der Berechnung → läuft bis (ms; Infinity für Berechnungen dieser Seite) */
const active = new Map<string, Map<string, number>>();
const own = new Set<string>();
const subs = new Set<() => void>();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let listening = false;

function notify() {
  for (const s of [...subs]) {
    try {
      s();
    } catch (e) {
      console.warn(e);
    }
  }
}

function prune(now = Date.now()): boolean {
  let changed = false;
  for (const [id, m] of active) {
    for (const [k, until] of m) if (until <= now) {
      m.delete(k);
      changed = true;
    }
    if (!m.size) active.delete(id);
  }
  return changed;
}

function scheduleExpiry() {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  let next = Infinity;
  for (const m of active.values()) for (const until of m.values()) if (until < next) next = until;
  if (!Number.isFinite(next)) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = undefined;
    if (prune()) notify();
    scheduleExpiry();
  }, Math.max(50, next - Date.now() + 20));
}

function set(id: string, key: string, until: number | null) {
  let m = active.get(id);
  if (until === null) {
    if (!m?.delete(key)) return;
    if (!m.size) active.delete(id);
  } else {
    if (!m) active.set(id, (m = new Map()));
    m.set(key, until);
  }
  scheduleExpiry();
  notify();
}

function listen() {
  if (listening) return;
  listening = true;
  onStoreEvent((e) => {
    if (e.type !== 'computing' || own.has(e.source)) return;
    set(e.id, e.source, e.active ? Date.now() + LOCK_EXPIRE_MS : null);
  });
}

/** Meldet den Beginn einer Berechnung; die zurückgegebene Funktion meldet das Ende (mehrfach aufrufbar). */
export function beginCompute(id: string): () => void {
  listen();
  const key = uid();
  own.add(key);
  set(id, key, Infinity);
  broadcast({ type: 'computing', id, active: true, source: key });
  const beat = setInterval(() => broadcast({ type: 'computing', id, active: true, source: key }), LOCK_HEARTBEAT_MS);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    clearInterval(beat);
    own.delete(key);
    set(id, key, null);
    broadcast({ type: 'computing', id, active: false, source: key });
  };
}

/** Läuft gerade irgendwo eine Berechnung für dieses Projekt? */
export function isComputing(id: string): boolean {
  listen();
  if (prune()) scheduleExpiry();
  return (active.get(id)?.size ?? 0) > 0;
}

/** Benachrichtigung bei jeder Änderung (Beginn/Ende/Ablauf einer Berechnung). */
export function onComputeLock(fn: () => void): () => void {
  listen();
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
