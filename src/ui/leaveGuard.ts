/**
 * Schutz beim Verlassen einer Ansicht (z. B. Projekt mit nicht gespeicherten Änderungen).
 *
 * Eine Ansicht meldet eine Prüffunktion an. Bevor die App die Ansicht verlässt – Kopfzeilen-Navigation,
 * „←“, Zurück-Taste/-Geste (Adressänderung) – fragt sie `requestLeave`. Die Prüffunktion liefert true
 * („darf sofort verlassen“) oder false; dann hat sie selbst nachgefragt und ruft `proceed` auf, sobald
 * verlassen werden darf. Ohne angemeldete Prüffunktion wird immer sofort verlassen.
 */
export type LeaveGuard = (proceed: () => void) => boolean;

let current: LeaveGuard | null = null;

/** Meldet eine Prüffunktion an; liefert die Abmeldung (für useEffect). */
export function setLeaveGuard(g: LeaveGuard): () => void {
  current = g;
  return () => {
    if (current === g) current = null;
  };
}

/** true: sofort verlassen. false: die Ansicht fragt nach und ruft `proceed` später selbst auf. */
export function requestLeave(proceed: () => void): boolean {
  return current ? current(proceed) : true;
}

/** Projekt-ID einer Adresse „#/project/<id>/…“ (sonst null). */
export function projectOfHash(hash: string): string | null {
  const m = /^#\/?project\/([^/]+)/.exec(hash);
  return m ? m[1] : null;
}

/** Verlässt der Wechsel von `prev` nach `next` eine geöffnete Projektansicht? */
export function leavesProject(prev: string, next: string): boolean {
  const p = projectOfHash(prev);
  return p !== null && projectOfHash(next) !== p;
}
