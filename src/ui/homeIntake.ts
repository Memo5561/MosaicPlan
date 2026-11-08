/**
 * Startseite: ein Foto annehmen (Auswahl oder Ziehen & Ablegen) und daraus ein Projekt anlegen.
 * Reine Ablauflogik ohne DOM-Zugriff – Dekodieren, Speichern und Laden werden übergeben, damit
 * die Regeln testbar sind:
 *  - Ein Projekt wird erst angelegt, nachdem das Foto erfolgreich gelesen wurde.
 *  - Das nur für das Seitenverhältnis dekodierte Bild wird sofort wieder freigegeben (close()).
 *  - Jeder Fehler wird einer verständlichen Meldung zugeordnet; nichts scheitert stumm.
 */

/** Art der Fehlermeldung auf der Startseite (i18n-Schlüssel `home.err.<kind>`). */
export type HomePhotoErrorKind = 'decode' | 'heic' | 'save' | 'sample';

export type FileLike = { name?: string; type?: string };

/** Minimale Schnittstelle eines dekodierten Bildes (ImageBitmap). */
export type DecodedImage = { width: number; height: number; close: () => void };

export type IntakeResult = { ok: true; id: string } | { ok: false; kind: HomePhotoErrorKind; error: unknown };

/** HEIC/HEIF (iPhone, manche Android-Kameras) – nur zur Wahl der Meldung, nie zum vorzeitigen Ablehnen. */
export function isHeicLike(f: FileLike): boolean {
  return /hei[cf]/i.test(f.type ?? '') || /\.(heic|heif)$/i.test(f.name ?? '');
}

/**
 * Seitenverhältnis Breite/Höhe eines dekodierten Bildes; null, wenn das Bild keine brauchbare Größe hat.
 */
export function aspectOf(w: number, h: number): number | null {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  return w / h;
}

/**
 * Dekodiert das Bild nur, um das Seitenverhältnis zu lesen, und gibt es danach sofort frei
 * (ein 48-MP-Foto belegt dekodiert rund 190 MB). Wirft, wenn das Bild nicht lesbar ist.
 */
export async function decodeAspect(blob: Blob, decode: (b: Blob) => Promise<DecodedImage>): Promise<number> {
  const bmp = await decode(blob);
  let aspect: number | null;
  try {
    aspect = aspectOf(bmp.width, bmp.height);
  } finally {
    try {
      bmp.close();
    } catch {
      /* bereits freigegeben */
    }
  }
  if (aspect === null) throw new Error('image has no size');
  return aspect;
}

/** Projektname aus dem Dateinamen (ohne Endung); leer → Ersatzname. */
export function projectNameFromFile(name: string | undefined, fallback: string): string {
  const base = (name ?? '').replace(/\.[^.]+$/, '').trim();
  return base || fallback;
}

/**
 * Aus abgelegten Dateien die erste Bilddatei wählen. Ohne erkennbare Bilddatei wird die erste Datei
 * genommen, damit statt „es passiert nichts“ eine verständliche Fehlermeldung erscheint.
 */
export function pickDroppedFile<T extends FileLike>(files: ArrayLike<T> | null | undefined): T | null {
  if (!files || files.length === 0) return null;
  const list = Array.from(files);
  return list.find((f) => (f.type ?? '').startsWith('image/') || isHeicLike(f)) ?? list[0];
}

/**
 * Neues Projekt aus einem Foto: erst lesen, dann speichern. Lesefehler → 'heic' oder 'decode',
 * Speicherfehler → 'save'. `create` wird nur nach erfolgreichem Lesen aufgerufen.
 */
export async function createFromPhoto(
  photo: Blob & FileLike,
  deps: { decode: (b: Blob) => Promise<DecodedImage>; create: (aspect: number) => Promise<string> },
): Promise<IntakeResult> {
  let aspect: number;
  try {
    aspect = await decodeAspect(photo, deps.decode);
  } catch (error) {
    return { ok: false, kind: isHeicLike(photo) ? 'heic' : 'decode', error };
  }
  try {
    return { ok: true, id: await deps.create(aspect) };
  } catch (error) {
    return { ok: false, kind: 'save', error };
  }
}

/**
 * Beispielprojekt: Bild laden und lesen, dann speichern. Laden/Lesen scheitert → 'sample',
 * Speichern scheitert → 'save'.
 */
export async function createFromSample(
  url: string,
  deps: {
    fetchBlob: (url: string) => Promise<Blob>;
    decode: (b: Blob) => Promise<DecodedImage>;
    create: (blob: Blob, aspect: number) => Promise<string>;
  },
): Promise<IntakeResult> {
  let blob: Blob;
  let aspect: number;
  try {
    blob = await deps.fetchBlob(url);
    aspect = await decodeAspect(blob, deps.decode);
  } catch (error) {
    return { ok: false, kind: 'sample', error };
  }
  try {
    return { ok: true, id: await deps.create(blob, aspect) };
  } catch (error) {
    return { ok: false, kind: 'save', error };
  }
}

/** Lädt eine Datei der App (Beispielbild); HTTP-Fehler werden zu Ausnahmen statt zu einem „Bild“ aus HTML. */
export async function fetchAppBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}
