/**
 * Plattform-Anpassungen für die Android-App (Capacitor). Im Browser gibt es hier nichts zu tun.
 *
 * Speichern (saveNative): Im APK gibt es keine Browser-Downloads. Eine Datei wird
 *  1. stückweise (je 3 MiB, ein Vielfaches von 3 Byte → jedes Base64-Stück ist für sich gültig) in den
 *     App-Cache geschrieben (writeFile, dann appendFile) und die Größe geprüft,
 *  2. nativ nach „Documents/MosaicPlan“ kopiert (Filesystem.copy, kein zweites Base64 über die Brücke)
 *     und dort per stat auf die richtige Größe geprüft,
 *  3. nur wenn das nicht ging, sofort über das Teilen-Menü angeboten (sonst läge sie nur im Cache).
 * Das Ergebnis meldet ehrlich, was passiert ist: `savedPath` ist NUR gesetzt, wenn die Datei in
 * Documents bestätigt wurde; ein abgebrochenes Teilen ist kein Fehler (shared = false).
 * saveNative wirft nie – Fehler stehen im Ergebnis, damit Aufrufer ohne await keine unbehandelten
 * Ablehnungen erzeugen.
 *
 * Zurück-Taste und Systemleisten: siehe installBackButton / installSystemBars (aufgerufen in main.tsx).
 */
import { Capacitor, SystemBars, SystemBarsStyle, SystemBarType } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { App } from '@capacitor/app';

export const isNative = () => Capacitor.isNativePlatform();

/** Unterordner in Documents (öffentlich) und im App-Cache */
export const DOCS_DIR = 'MosaicPlan';
/** So zeigt die App den Ordner an – der echte Ordnername auf dem Gerät ist „Documents“. */
export const DOCS_DISPLAY_DIR = `Documents/${DOCS_DIR}`;
/** Stückgröße beim Schreiben: 3 MiB = 3 · 1 048 576 Byte, durch 3 teilbar (Base64 ohne Füllzeichen). */
export const CHUNK_BYTES = 3 * 1024 * 1024;

/** Warum eine Datei nicht in Documents gespeichert werden konnte */
export type SaveFailReason = 'permission' | 'size' | 'other';
/** Wie mit dem Teilen-Menü verfahren wird: nur wenn Documents fehlschlug (Standard), immer, nie */
export type ShareMode = 'fallback' | 'always' | 'never';

export interface NativeSaveResult {
  kind: 'native';
  /** angefragter Dateiname */
  name: string;
  /** Name in Documents/MosaicPlan (bei einem Namenskonflikt mit Uhrzeit-Zusatz), sonst null */
  savedName: string | null;
  /** „Documents/MosaicPlan/<Name>“ – nur gesetzt, wenn Kopie UND Größenprüfung erfolgreich waren */
  savedPath: string | null;
  /** file://-Adresse der Kopie im App-Cache (zum erneuten Teilen); null, wenn schon das Schreiben scheiterte */
  cacheUri: string | null;
  /** Teilen-Menü gezeigt und ein Ziel gewählt */
  shared: boolean;
  /** technische Fehlermeldung (Documents bzw. – mit reason 'cache' – schon der Cache) */
  error?: string;
  reason?: SaveFailReason | 'cache';
  /** Fehler beim Teilen (nicht: abgebrochen) */
  shareError?: string;
}

export interface DownloadResult {
  kind: 'download';
  name: string;
}

/** Ergebnis von downloadBlob: im Browser ein Download, im APK das Speicherergebnis */
export type SaveResult = DownloadResult | NativeSaveResult;

// ---------------------------------------------------------------- Hilfsfunktionen (ohne Plattform)

function errMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') return (e as { message: string }).message;
  return String(e);
}
function errCode(e: unknown): string {
  return e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '';
}
/**
 * Berechtigung verweigert: Filesystem-Plugin „user denied permission request“ (OS-PLUG-FILE-0007) oder
 * fehlende Manifest-Berechtigung. Ein EACCES („Permission denied“, OS-PLUG-FILE-0013) beim Kopieren ist
 * dagegen meist eine gleichnamige Datei einer früheren Installation – dann hilft ein anderer Name.
 */
export function isPermissionError(e: unknown): boolean {
  const code = errCode(e);
  if (code === 'OS-PLUG-FILE-0007') return true;
  if (code.startsWith('OS-PLUG-FILE-')) return false;
  return /denied permission request|missing the following permissions/i.test(errMessage(e));
}
/** Filesystem-Plugin: Elternordner fehlt (OS-PLUG-FILE-0011) */
function isMissingParent(e: unknown): boolean {
  return errCode(e) === 'OS-PLUG-FILE-0011' || /missing parent/i.test(errMessage(e));
}
/** Share-Plugin lehnt mit „Share canceled“ ab, wenn das Menü ohne Auswahl geschlossen wird. */
export function isShareCancel(e: unknown): boolean {
  return /cancel/i.test(errMessage(e)) || (e as { name?: string } | null)?.name === 'AbortError';
}

/** Bytebereiche [von, bis) zum stückweisen Schreiben; eine leere Datei ergibt genau ein leeres Stück. */
export function chunkRanges(size: number, chunk = CHUNK_BYTES): [number, number][] {
  if (!(chunk > 0) || chunk % 3 !== 0) throw new Error('Stückgröße muss ein positives Vielfaches von 3 sein');
  const out: [number, number][] = [];
  for (let a = 0; a < size; a += chunk) out.push([a, Math.min(size, a + chunk)]);
  return out.length ? out : [[0, 0]];
}

/** Base64 eines Bytebereichs (btoa in Blöcken, ohne riesige Argumentlisten) */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

/** Base64-Stücke einer Datei, jedes für sich dekodierbar (Stücklänge Vielfaches von 3). */
export async function* base64Chunks(blob: Blob, chunk = CHUNK_BYTES): AsyncGenerator<string> {
  for (const [a, b] of chunkRanges(blob.size, chunk)) {
    yield bytesToBase64(new Uint8Array(await blob.slice(a, b).arrayBuffer()));
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Dateiname in Name und Endung zerlegen; „.mosaicplan.json“ gilt als eine Endung. */
export function splitFileName(name: string): { base: string; ext: string } {
  const lower = name.toLowerCase();
  if (lower.endsWith('.mosaicplan.json')) return { base: name.slice(0, -'.mosaicplan.json'.length), ext: name.slice(-'.mosaicplan.json'.length) };
  const i = name.lastIndexOf('.');
  return i > 0 ? { base: name.slice(0, i), ext: name.slice(i) } : { base: name, ext: '' };
}

/** Zusatz vor der Endung einfügen: withSuffix('a.pdf', '_2') = 'a_2.pdf' */
export function withSuffix(name: string, suffix: string): string {
  const { base, ext } = splitFileName(name);
  return `${base}${suffix}${ext}`;
}

/**
 * Dateiname mit Datum und Uhrzeit (Ortszeit), z. B. timestampedName('Katze', 'mosaicplan.json')
 * = 'Katze_2026-11-08_1432.mosaicplan.json'. So überschreibt eine neue Sicherung nie eine ältere.
 */
export function timestampedName(base: string, ext: string, d: Date = new Date()): string {
  const e = ext.replace(/^\.+/, '');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `${base}_${stamp}${e ? `.${e}` : ''}`;
}

// ---------------------------------------------------------------- Speichern im APK

/** Schreibt die Datei stückweise in den App-Cache und prüft die Größe. Gibt die file://-Adresse zurück. */
async function writeCache(blob: Blob, path: string): Promise<string> {
  let uri = '';
  let first = true;
  for await (const data of base64Chunks(blob)) {
    if (first) {
      uri = (await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true })).uri;
      first = false;
    } else {
      await Filesystem.appendFile({ path, data, directory: Directory.Cache });
    }
  }
  const st = await Filesystem.stat({ path, directory: Directory.Cache });
  if (Number(st.size) !== blob.size) throw new Error(`Cache: ${st.size} von ${blob.size} Byte geschrieben`);
  return uri || st.uri;
}

async function copyOnce(from: string, toName: string): Promise<void> {
  const to = `${DOCS_DIR}/${toName}`;
  try {
    await Filesystem.copy({ from, directory: Directory.Cache, to, toDirectory: Directory.Documents });
  } catch (e) {
    if (!isMissingParent(e)) throw e;
    // Ordner „MosaicPlan“ gibt es noch nicht: anlegen (existiert er inzwischen, ist das kein Fehler)
    await Filesystem.mkdir({ path: DOCS_DIR, directory: Directory.Documents, recursive: true }).catch(() => {});
    await Filesystem.copy({ from, directory: Directory.Cache, to, toDirectory: Directory.Documents });
  }
}

type DocsOutcome = { savedName: string; savedPath: string } | { savedName: null; savedPath: null; error: string; reason: SaveFailReason };

/** Kopie nach Documents/MosaicPlan; bei einem Konflikt (z. B. Datei einer früheren Installation) einmal mit Uhrzeit-Zusatz. */
async function copyToDocuments(cachePath: string, name: string, size: number, now: () => Date): Promise<DocsOutcome> {
  const d = now();
  const candidates = [name, withSuffix(name, `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`)];
  let last: unknown = null;
  for (const cand of candidates) {
    try {
      await copyOnce(cachePath, cand);
    } catch (e) {
      last = e;
      if (isPermissionError(e)) return { savedName: null, savedPath: null, error: errMessage(e), reason: 'permission' };
      continue;
    }
    // Erst nach bestätigter Größe gilt die Datei als gespeichert
    try {
      const st = await Filesystem.stat({ path: `${DOCS_DIR}/${cand}`, directory: Directory.Documents });
      if (Number(st.size) !== size) return { savedName: null, savedPath: null, error: `${st.size} / ${size} B`, reason: 'size' };
    } catch (e) {
      return { savedName: null, savedPath: null, error: errMessage(e), reason: isPermissionError(e) ? 'permission' : 'other' };
    }
    return { savedName: cand, savedPath: `${DOCS_DISPLAY_DIR}/${cand}` };
  }
  return { savedName: null, savedPath: null, error: errMessage(last), reason: 'other' };
}

/** Teilen-Menü für eine Datei im App-Cache. Abbrechen ist kein Fehler. */
export async function reshare(cacheUri: string, title = ''): Promise<{ shared: boolean; error?: string }> {
  try {
    await Share.share({ title, files: [cacheUri], dialogTitle: title || undefined });
    return { shared: true };
  } catch (e) {
    if (isShareCancel(e)) return { shared: false };
    return { shared: false, error: errMessage(e) };
  }
}

/**
 * Datei im APK speichern (siehe Kopfkommentar). Wirft nie.
 * @param share 'fallback' (Standard): Teilen-Menü nur, wenn Documents nicht ging; 'always'; 'never'
 */
export async function saveNative(blob: Blob, name: string, opts: { share?: ShareMode; now?: () => Date } = {}): Promise<NativeSaveResult> {
  const mode = opts.share ?? 'fallback';
  const now = opts.now ?? (() => new Date());
  const cachePath = `${DOCS_DIR}/${name}`;
  let cacheUri: string;
  try {
    cacheUri = await writeCache(blob, cachePath);
  } catch (e) {
    return { kind: 'native', name, savedName: null, savedPath: null, cacheUri: null, shared: false, error: errMessage(e), reason: 'cache' };
  }
  const docs = await copyToDocuments(cachePath, name, blob.size, now);
  const res: NativeSaveResult = { kind: 'native', name, savedName: docs.savedName, savedPath: docs.savedPath, cacheUri, shared: false };
  if (docs.savedPath === null) {
    res.error = docs.error;
    res.reason = docs.reason;
  }
  if (mode === 'always' || (mode === 'fallback' && docs.savedPath === null)) {
    const s = await reshare(cacheUri, docs.savedName ?? name);
    res.shared = s.shared;
    if (s.error) res.shareError = s.error;
  }
  return res;
}

// ---------------------------------------------------------------- Zurück-Taste (Android)

/** Startseite der App (Hash leer, „#“ oder „#/“) */
export function isRootHash(hash: string): boolean {
  return hash === '' || hash === '#' || hash === '#/';
}

export type BackAction = 'back' | 'minimize' | 'home';

/**
 * Was die Android-Zurück-Taste tun soll. Dialoge und Schritte sind Verlaufseinträge (modalHistory,
 * Schrittwechsel per Hash): offener Dialog → zurück (schließt ihn); Startseite → App minimieren
 * (nicht beenden – der Zustand bleibt erhalten); sonst zurück im Verlauf, und ohne Verlauf zur Startseite.
 */
export function backAction(canGoBack: boolean, hash: string, modalOpen: boolean): BackAction {
  if (modalOpen) return canGoBack ? 'back' : 'minimize';
  if (isRootHash(hash)) return 'minimize';
  return canGoBack ? 'back' : 'home';
}

interface BackButtonApp {
  addListener(eventName: 'backButton', fn: (e: { canGoBack: boolean }) => void): Promise<unknown>;
  minimizeApp(): Promise<void>;
}

/** Zurück-Taste verbinden (nur im APK aufrufen). modalOpen: liefert, ob gerade ein Dialog offen ist. */
export function installBackButton(modalOpen: () => boolean, app: BackButtonApp = App as unknown as BackButtonApp): void {
  app
    .addListener('backButton', ({ canGoBack }) => {
      const a = backAction(!!canGoBack, location.hash, modalOpen());
      if (a === 'back') history.back();
      else if (a === 'home') location.hash = '#/';
      else app.minimizeApp().catch(() => {});
    })
    .catch(() => {});
}

// ---------------------------------------------------------------- Systemleisten (Android)

/**
 * Symbolfarben der Systemleisten. Reicht die Seite unter die Statusleiste (env(safe-area-inset-top) > 0,
 * WebView ≥ 140 mit viewport-fit=cover), liegt die Statusleiste über der dunklen Kopfleiste → helle
 * Symbole (Dark) und die Navigationsleiste über dem hellen Seitenhintergrund → dunkle Symbole (Light).
 * Sonst polstert Capacitor die Leisten mit dem Fensterhintergrund aus – dafür passt DEFAULT.
 */
export function systemBarStyles(underStatusBar: boolean): { status: SystemBarsStyle; nav: SystemBarsStyle } {
  return underStatusBar ? { status: SystemBarsStyle.Dark, nav: SystemBarsStyle.Light } : { status: SystemBarsStyle.Default, nav: SystemBarsStyle.Default };
}

/** Misst env(safe-area-inset-top) mit einem unsichtbaren Element und setzt die Leistenstile (nur im APK). */
export function installSystemBars(): void {
  if (typeof document === 'undefined' || !document.body) return;
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.dataset.testid = 'safe-area-probe';
  probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none;';
  document.body.appendChild(probe);
  let last: boolean | null = null;
  const apply = () => {
    const under = probe.getBoundingClientRect().height > 0.5;
    if (under === last) return;
    last = under;
    const s = systemBarStyles(under);
    SystemBars.setStyle({ bar: SystemBarType.StatusBar, style: s.status }).catch(() => {});
    SystemBars.setStyle({ bar: SystemBarType.NavigationBar, style: s.nav }).catch(() => {});
  };
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(apply).observe(probe);
  window.addEventListener('resize', apply);
  apply();
}
