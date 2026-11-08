import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hexToLab } from '../../core/color';
import { repairDegenerateCells } from '../../core/edits';
import { checkMosaicIntegrity } from '../../core/integrity';
import { computeLayout, sectionsFor, type Layout, type LayoutParams, type SectionGrid } from '../../core/layout';
import type { ComputeDiagnostics, FixedColor } from '../../core/mosaic';
import { renderFull } from '../../core/render';
import { packMosaic, unpackMosaic, type MosaicDataWithRev } from '../../core/serialize';
import { popcount, progressOf, type Stats } from '../../core/stats';
import { DEFAULT_ADJUST, type ImageAdjust, type Material, type MosaicData, type PaletteColor, type ProjectSettings, type Region } from '../../core/types';
import {
  commitComputed,
  DELETED,
  isDeletedError,
  isPaletteChangedError,
  keepStoredComputeFields,
  loadProjectState,
  mergeComputeFields,
  onStoreEvent,
  PALETTE_CHANGED,
  resolveComputedPalette,
  saveProjectState,
  txMulti,
  uid,
  type ComputeFields,
  type ImageRecord,
  type ProjectRecord,
  type SaveGuard,
  type SaveParts,
  type StoredMosaicNoProgress,
} from '../../storage/db';
import { beginCompute, isComputing, onComputeLock } from '../../storage/computeLock';
import { buildProjectExport, duplicateProject } from '../../storage/projects';
import { cancelChannel, runWorker } from '../../workers/client';
import {
  canvasToJpeg,
  canvasToRaw,
  fitCrop,
  loadBitmap,
  loadWorkingBitmap,
  needsFullResolution,
  PhotoSaveError,
  renderCropped,
  renderRotated,
  rotatedSize,
  workingSize,
  type WorkingBitmap,
} from './imagePrep';
import type { Lang } from '../../i18n';

export function layoutParamsOf(s: ProjectSettings): LayoutParams {
  return { widthMm: s.widthMm, heightMm: s.heightMm, tileW: s.tileW, tileH: s.tileH, joint: s.joint, edgeMode: s.edgeMode, minCutMm: s.minCutMm };
}

/**
 * Feste Palette als Eingabe der Berechnung (reine Funktion, von compute() verwendet):
 * 'materials'/'auto-snap' → Materialfarben (Auswahl oder alle), 'custom' → eigene Palette MIT Farbnummer
 * (Nummern bleiben über Neuberechnungen erhalten, auch Lücken nach dem Entfernen), 'auto' → keine.
 * Wirft 'no-materials' / 'no-palette', wenn die nötige Liste leer ist.
 */
export function buildFixedPalette(s: Pick<ProjectSettings, 'paletteMode' | 'materialIds'>, palette: readonly PaletteColor[], materials: readonly Material[]): FixedColor[] | undefined {
  if (s.paletteMode === 'materials' || s.paletteMode === 'auto-snap') {
    const pool = materials.filter((m) => s.materialIds.length === 0 || s.materialIds.includes(m.id));
    const fixed: FixedColor[] = pool.map((m) => ({
      lab: hexToLab(m.hex),
      hex: m.hex.toUpperCase(),
      name: m.colorName || `${m.manufacturer} ${m.colorNumber}`.trim(),
      materialId: m.id,
      // Bestand: Vertrag für Welle 3 (die Berechnung nutzt ihn noch nicht)
      ...(m.stock !== undefined ? { stock: m.stock } : {}),
    }));
    if (!fixed.length) throw new Error('no-materials');
    return fixed;
  }
  if (s.paletteMode === 'custom') {
    // nameKey/nameSuffix: automatische Namen bleiben automatisch (folgen der UI-Sprache), eingetippte bleiben wörtlich
    const fixed: FixedColor[] = palette.map((p) => ({
      lab: p.lab,
      hex: p.hex,
      name: p.name,
      materialId: p.materialId,
      code: p.code,
      ...(p.nameKey ? { nameKey: p.nameKey, nameSuffix: p.nameSuffix } : {}),
    }));
    if (!fixed.length) throw new Error('no-palette');
    return fixed;
  }
  return undefined;
}

/** Pixelmaße des Originalfotos (nach EXIF-Ausrichtung) und ob die Arbeitskopie verkleinert ist. */
export interface SourceSize {
  w: number;
  h: number;
  reduced: boolean;
}

/**
 * Neues Projekt für ein anderes Foto auf Basis des aktuellen (reine Funktion): übernimmt alle Einstellungen
 * (Breite, Steine, Fuge, Farben, Formen, Abschnitte, Material) und bei eigener Palette die Palette; die Höhe
 * folgt dem Seitenverhältnis des neuen Fotos. Bereiche, Zuschnitt/Bildoptimierung, Berechnung und
 * Fortschritt gehören zum alten Foto und werden nicht übernommen.
 */
export function projectFromPhoto(r: ProjectRecord, id: string, name: string, aspect: number, now: number, imageRev: string): ProjectRecord {
  const s = r.settings;
  const heightMm = Number.isFinite(aspect) && aspect > 0 ? Math.round((s.widthMm / aspect) * 10) / 10 : s.heightMm;
  return {
    meta: { id, name, createdAt: now, updatedAt: now, computed: false },
    settings: { ...s, shapes: { ...s.shapes }, materialIds: [...s.materialIds], heightMm },
    adjust: { ...DEFAULT_ADJUST },
    regions: [],
    palette: s.paletteMode === 'custom' ? r.palette.map((p) => ({ ...p })) : [],
    imageRev,
  };
}

/** Projektname aus einem Dateinamen („IMG_2041.jpg“ → „IMG_2041“). */
export function nameFromFile(fileName: string, fallback: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim() || fallback;
}

export function computeKey(r: ProjectRecord): string {
  const s = r.settings;
  return JSON.stringify({
    l: layoutParamsOf(s),
    sh: s.shapes,
    pm: s.paletteMode,
    cc: s.colorCount,
    di: s.dither,
    de: s.deltaE,
    mi: s.paletteMode === 'materials' || s.paletteMode === 'auto-snap' ? s.materialIds : [],
    cp: s.paletteMode === 'custom' ? r.palette.map((p) => p.hex) : [],
    a: r.adjust,
    rg: r.regions,
    // Identität des Fotos. Ohne imageRev (ältere Projekte) lässt JSON.stringify den Eintrag weg,
    // der Schlüssel bleibt dann Zeichen für Zeichen derselbe wie bisher.
    im: r.imageRev,
  });
}

export interface ComputedState {
  layout: Layout;
  layoutParams: LayoutParams;
  data: MosaicData;
}

export interface ComputeProgress {
  phase: string;
  fraction: number;
}

/** 'saved': alles gespeichert · 'saving': Änderungen werden gleich/gerade gespeichert · 'error': Speichern fehlgeschlagen */
export type SaveState = 'saved' | 'saving' | 'error';
export interface SaveError {
  /** 'quota': Gerätespeicher voll · 'connection': Verbindung zum Gerätespeicher verloren · 'deleted': Projekt wurde gelöscht */
  code: 'quota' | 'connection' | 'deleted' | 'other';
  message: string;
}
/** Gespeichertes Raster gehört nicht zur gespeicherten Palette → wird nicht angezeigt, neu berechnen nötig */
export type IntegrityError = 'mismatch';

/** Was über ein gespeichertes, aber nicht angezeigtes Raster bekannt ist (siehe restoreComputed). */
export interface RejectedMosaic {
  /** Grund aus restoreComputed (z. B. 'index': Farbindex außerhalb der Palette, 'rev': andere Berechnung) */
  reason: string;
  /** Rasterpositionen des gespeicherten Rasters */
  cells: number;
  /** als verlegt markierte Steine im gespeicherten Fortschritt – sie gehen beim Neuberechnen verloren */
  placed: number;
}

/** Verlegte Steine im gespeicherten Fortschritt (nur wenn er zum gespeicherten Raster passt). */
export function placedInStored(m: StoredMosaicNoProgress | undefined, prog: Uint16Array | undefined): number {
  if (!m || !prog || prog.length !== m.cols * m.rows) return 0;
  let n = 0;
  for (let i = 0; i < prog.length; i++) if (prog[i]) n += popcount(prog[i]);
  return n;
}

type SaveKey = 'rec' | 'mosaic' | 'progress' | 'image';
const KEYS: SaveKey[] = ['rec', 'mosaic', 'progress', 'image'];
/** Entprellzeiten je Teil (ms) */
export const SAVE_DEBOUNCE: Record<SaveKey, number> = { rec: 250, progress: 150, mosaic: 300, image: 0 };
/** Spätestens nach dieser Zeit wird auch bei Dauerbearbeitung gespeichert (ms) */
const SAVE_MAX_WAIT = 2000;
/** Wartezeiten bis zum nächsten automatischen Versuch nach einem Fehler (ms) */
export const SAVE_RETRY_MS = [2000, 5000, 15000, 60000];

export function classifySaveError(e: unknown): SaveError {
  const name = e && typeof e === 'object' ? (e as { name?: string }).name : undefined;
  const message = e instanceof Error ? e.message : String(e);
  if (isDeletedError(e)) return { code: 'deleted', message };
  if (name === 'QuotaExceededError' || /quota/i.test(message)) return { code: 'quota', message };
  if (name === 'InvalidStateError' || name === 'UnknownError' || name === 'TransactionInactiveError') return { code: 'connection', message };
  return { code: 'other', message };
}

/**
 * Baut den angezeigten Rechenstand aus gespeicherten Daten – aber nur, wenn Raster und Projekt
 * nachweislich zusammengehören (gleiches Raster wie berechnet, gleiche Revision, alle Farbindizes
 * in der Palette). Sonst wird nichts angezeigt und `mismatch` gemeldet.
 */
export function restoreComputed(rec: ProjectRecord, m: StoredMosaicNoProgress | undefined, prog: Uint16Array | undefined): { computed: ComputedState | null; mismatch: string | null } {
  if (!m) return { computed: null, mismatch: rec.mosaicRev !== undefined || rec.computedWith !== undefined ? 'missing' : null };
  if (!rec.computedWith) return { computed: null, mismatch: 'no-key' };
  let lp: LayoutParams;
  let layout: Layout;
  try {
    lp = (JSON.parse(rec.computedWith) as { l: LayoutParams }).l;
    layout = computeLayout(lp);
  } catch {
    return { computed: null, mismatch: 'layout' };
  }
  const n = m.cols * m.rows;
  if (layout.cols !== m.cols || layout.rows !== m.rows) return { computed: null, mismatch: 'layout' };
  if (m.kind?.length !== n || m.c1?.length !== n || m.c2?.length !== n) return { computed: null, mismatch: 'shape' };
  const check = checkMosaicIntegrity(rec, m);
  if (!check.ok) return { computed: null, mismatch: check.reason };
  try {
    const data = unpackMosaic({ ...m, progress: prog && prog.length === n ? prog : new Uint16Array(n) });
    return { computed: { layout, layoutParams: lp, data }, mismatch: null };
  } catch {
    return { computed: null, mismatch: 'shape' };
  }
}

function withRev(m: StoredMosaicNoProgress, rev: string | undefined): StoredMosaicNoProgress {
  const out = { ...m };
  if (rev !== undefined) out.rev = rev;
  else delete out.rev;
  return out;
}

function packWithoutProgress(d: MosaicData, rev: string | undefined): { mosaic: StoredMosaicNoProgress; progress: Uint16Array } {
  const { progress, ...rest } = packMosaic(d);
  return { mosaic: withRev(rest, rev), progress };
}

export function useProject(id: string, materials: Material[], lang: Lang) {
  const [rec, setRecState] = useState<ProjectRecord | null>(null);
  const [image, setImageState] = useState<ImageRecord | null>(null);
  /** Arbeitskopie des Fotos (bei großen Fotos verkleinert, siehe loadWorkingBitmap) */
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  /** Pixelmaße des Originalfotos; gilt für Zuschnitt, Seitenverhältnis und Arbeitsauflösung */
  const [sourceSize, setSourceSize] = useState<SourceSize | null>(null);
  /** 'unreadable': gespeichertes Foto konnte nicht gelesen werden (neu auswählen) */
  const [imageError, setImageError] = useState<'unreadable' | null>(null);
  const [computed, setComputedState] = useState<ComputedState | null>(null);
  const [version, setVersion] = useState(0);
  const [progressVersion, setProgressVersion] = useState(0);
  const [computing, setComputing] = useState<ComputeProgress | null>(null);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [sectionStats, setSectionStats] = useState<Map<string, Stats>>(new Map());
  const [statsBusy, setStatsBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [processed, setProcessed] = useState<HTMLCanvasElement | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [integrityError, setIntegrityError] = useState<IntegrityError | null>(null);
  const [rejected, setRejected] = useState<RejectedMosaic | null>(null);
  /** Beim Laden reparierte Zellen mit leeren Teilen (Fuge breiter als der Stein, ältere Projekte) */
  const [repairedCells, setRepairedCells] = useState(0);
  /** Läuft irgendwo (diese Ansicht, eine frühere Ansicht im Hintergrund, anderer Tab) eine Berechnung? */
  const [paletteLocked, setPaletteLocked] = useState(() => isComputing(id));

  // Die Refs sind die maßgebliche Quelle (sofort aktuell, auch in Ereignis-Handlern beim Verlassen
  // der Seite); der React-State spiegelt sie für das Rendern.
  const recRef = useRef<ProjectRecord | null>(null);
  const computedRef = useRef<ComputedState | null>(null);
  const imageRef = useRef<ImageRecord | null>(null);
  /**
   * Palette, wie sie zuletzt nachweislich gespeichert war (Laden, Übernehmen, Berechnen, Speichern).
   * Weicht die Palette im Arbeitsspeicher davon ab, hat der Benutzer sie hier bearbeitet.
   */
  const paletteBaseRef = useRef<PaletteColor[] | null>(null);
  const instanceRef = useRef('');
  if (!instanceRef.current) instanceRef.current = uid();
  const mounted = useRef(true);

  const setRecBoth = useCallback((next: ProjectRecord | null) => {
    recRef.current = next;
    setRecState(next);
  }, []);
  const setComputedBoth = useCallback((next: ComputedState | null) => {
    computedRef.current = next;
    setComputedState(next);
  }, []);

  // ---------- Speichern
  // Jede Änderung erhöht die Generation ihres Teils. Ein Speichervorgang schreibt ALLE ungespeicherten
  // Teile in einer Transaktion; ein Teil gilt erst als gespeichert, wenn diese Transaktion abgeschlossen ist.
  const sv = useRef({
    gen: { rec: 0, mosaic: 0, progress: 0, image: 0 } as Record<SaveKey, number>,
    saved: { rec: 0, mosaic: 0, progress: 0, image: 0 } as Record<SaveKey, number>,
    /** höchste Generation, die gerade geschrieben wird oder geschrieben wurde */
    writing: { rec: 0, mosaic: 0, progress: 0, image: 0 } as Record<SaveKey, number>,
    timers: {} as Partial<Record<SaveKey, { t: number; first: number }>>,
    inflight: new Set<Promise<void>>(),
    retryTimer: 0,
    retryAttempt: 0,
    error: null as SaveError | null,
    /** Projekt wurde gelöscht → nie wieder anlegen */
    deleted: false,
    /** Eine fremde Berechnung ist bekannt, aber noch nicht übernommen */
    staleKnown: false,
    /** Eigene Berechnung konnte nicht gespeichert werden → nächster Vorgang schreibt den Stand im Speicher vollständig */
    force: false,
    pendingImage: null as ImageRecord | null,
  });
  const persistRef = useRef<(mode: 'normal' | 'unload') => Promise<void>>(() => Promise.resolve());

  const refreshSaveState = useCallback(() => {
    const s = sv.current;
    const unsaved = KEYS.some((k) => s.gen[k] > s.saved[k]);
    setSaveState(s.error ? 'error' : unsaved || s.inflight.size > 0 ? 'saving' : 'saved');
  }, []);

  const setError = useCallback(
    (e: SaveError | null) => {
      sv.current.error = e;
      setSaveError(e);
      refreshSaveState();
    },
    [refreshSaveState],
  );

  const scheduleRetry = useCallback(() => {
    const s = sv.current;
    if (!mounted.current || s.deleted) return;
    window.clearTimeout(s.retryTimer);
    const ms = SAVE_RETRY_MS[Math.min(s.retryAttempt, SAVE_RETRY_MS.length - 1)];
    s.retryAttempt++;
    s.retryTimer = window.setTimeout(() => void persistRef.current('normal').catch(() => {}), ms);
  }, []);

  /** Verwirft ausstehende Speicherungen des bisherigen Rasters (es wurde durch ein anderes ersetzt). */
  const discardGrid = useCallback(() => {
    const s = sv.current;
    for (const k of ['mosaic', 'progress'] as const) {
      s.saved[k] = s.writing[k] = s.gen[k];
      const tm = s.timers[k];
      if (tm) window.clearTimeout(tm.t);
      delete s.timers[k];
    }
    refreshSaveState();
  }, [refreshSaveState]);

  // Übernimmt eine anderswo (Hintergrund-Berechnung einer früheren Ansicht, anderer Tab) gespeicherte Berechnung.
  const adoptRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const persist = useCallback(
    (mode: 'normal' | 'unload'): Promise<void> => {
      const s = sv.current;
      for (const k of KEYS) {
        const tm = s.timers[k];
        if (tm) window.clearTimeout(tm.t);
      }
      s.timers = {};
      if (s.deleted) return mode === 'unload' ? Promise.resolve() : Promise.reject(new Error(DELETED));
      const unload = mode === 'unload';
      // Beim Verlassen der Seite auch Teile neu schreiben, deren Vorgang noch läuft – er kommt sonst evtl. nicht mehr an.
      const keys = KEYS.filter((k) => s.gen[k] > (unload ? s.saved[k] : Math.max(s.saved[k], s.writing[k])));
      if (!keys.length) return Promise.resolve();
      if (unload && s.staleKnown && !s.force) return Promise.resolve(); // veraltetes Raster: ohne Prüfung nichts schreiben
      const r = recRef.current;
      const c = computedRef.current;
      const parts: SaveParts = {};
      const covered = new Set<SaveKey>();
      if (keys.includes('rec') && r) {
        parts.rec = r;
        covered.add('rec');
      }
      if ((keys.includes('mosaic') || keys.includes('progress')) && c) {
        if (keys.includes('mosaic')) {
          // Raster immer zusammen mit dem Fortschritt (Formänderungen setzen „verlegt“ zurück)
          const pk = packWithoutProgress(c.data, r?.mosaicRev);
          parts.mosaic = pk.mosaic;
          covered.add('mosaic');
        }
        parts.progress = c.data.progress;
        covered.add('progress');
      }
      if (keys.includes('image') && s.pendingImage) {
        parts.image = s.pendingImage;
        covered.add('image');
      }
      // ohne Datenquelle (z. B. Raster ersetzt) gibt es nichts mehr zu schreiben
      for (const k of keys) if (!covered.has(k)) s.saved[k] = s.writing[k] = s.gen[k];
      if (!covered.size) {
        refreshSaveState();
        return Promise.resolve();
      }
      const gens = { ...s.gen };
      for (const k of covered) s.writing[k] = Math.max(s.writing[k], gens[k]);
      const guard: SaveGuard = unload ? 'none' : s.force ? 'exists' : 'rev';
      const wasForced = s.force;
      const paletteEdited = !!r && r.palette !== paletteBaseRef.current;
      const p: Promise<void> = saveProjectState(id, parts, guard, r?.mosaicRev, { paletteEdited })
        .then(
          (outcome) => {
            if (outcome === 'deleted') {
              s.deleted = true;
              for (const k of covered) s.writing[k] = s.saved[k];
              window.clearTimeout(s.retryTimer);
              setError({ code: 'deleted', message: DELETED });
              throw new Error(DELETED);
            }
            for (const k of covered) s.saved[k] = Math.max(s.saved[k], gens[k]);
            if (outcome === 'ok' && parts.rec) paletteBaseRef.current = parts.rec.palette;
            if (parts.image && s.pendingImage === parts.image) s.pendingImage = null;
            if (wasForced && guard === 'exists') s.force = false;
            s.retryAttempt = 0;
            window.clearTimeout(s.retryTimer);
            if (s.error) setError(null);
            if (outcome === 'stale') {
              // anderswo neu berechnet: eigene Projektbearbeitungen sind gespeichert, das veraltete Raster nicht
              s.staleKnown = true;
              void adoptRef.current();
            }
          },
          (e: unknown) => {
            for (const k of covered) if (s.writing[k] === gens[k]) s.writing[k] = s.saved[k];
            console.warn('Speichern fehlgeschlagen', e);
            setError(classifySaveError(e));
            scheduleRetry();
            throw e;
          },
        )
        .finally(() => {
          s.inflight.delete(p);
          refreshSaveState();
        });
      s.inflight.add(p);
      refreshSaveState();
      return p;
    },
    [id, refreshSaveState, scheduleRetry, setError],
  );
  persistRef.current = persist;

  /** Markiert einen Teil als geändert und plant das Speichern (entprellt). */
  const markDirty = useCallback(
    (key: SaveKey) => {
      if (!mounted.current) return;
      const s = sv.current;
      s.gen[key]++;
      const now = Date.now();
      const cur = s.timers[key];
      if (!cur || now - cur.first < SAVE_MAX_WAIT) {
        if (cur) window.clearTimeout(cur.t);
        s.timers[key] = { t: window.setTimeout(() => void persistRef.current('normal').catch(() => {}), SAVE_DEBOUNCE[key]), first: cur?.first ?? now };
      }
      refreshSaveState();
    },
    [refreshSaveState],
  );

  /**
   * Speichert sofort alles Ungespeicherte und wartet auch auf laufende Vorgänge.
   * Wird abgelehnt, wenn etwas nicht gespeichert werden konnte.
   */
  const flush = useCallback(async () => {
    const before = [...sv.current.inflight];
    const p = persist('normal');
    const results = await Promise.allSettled([...before, p]);
    const bad = results.find((x): x is PromiseRejectedResult => x.status === 'rejected');
    if (bad) throw bad.reason;
  }, [persist]);

  /** Erneut speichern (für „Erneut versuchen“); liefert true, wenn jetzt alles gespeichert ist. Wirft nie. */
  const retrySave = useCallback(
    (): Promise<boolean> =>
      flush().then(
        () => true,
        () => false,
      ),
    [flush],
  );

  useEffect(() => {
    mounted.current = true;
    // Beim Verlassen/Neuladen/Schließen: sofort (ohne vorheriges Lesen) schreiben und festschreiben,
    // sonst bricht der Browser die Transaktion ab. visibilitychange deckt Android-App-Wechsel ab.
    const onLeave = () => void persistRef.current('unload').catch(() => {});
    const onVis = () => {
      if (document.visibilityState === 'hidden') onLeave();
    };
    window.addEventListener('beforeunload', onLeave);
    window.addEventListener('pagehide', onLeave);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      window.removeEventListener('pagehide', onLeave);
      document.removeEventListener('visibilitychange', onVis);
      // Verlassen innerhalb der App: Seite lebt weiter, also mit Prüfung speichern
      void persistRef.current('normal').catch(() => {});
      mounted.current = false;
      window.clearTimeout(sv.current.retryTimer);
    };
  }, []);

  // ---------- Laden
  useEffect(() => {
    let alive = true;
    (async () => {
      let st;
      try {
        st = await loadProjectState(id);
      } catch (e) {
        console.warn('Projekt konnte nicht geladen werden', e);
        if (alive) setLoaded(true);
        return;
      }
      if (!alive) return;
      const r = st.rec;
      if (!r) {
        setLoaded(true);
        return;
      }
      setRecBoth(r);
      paletteBaseRef.current = r.palette;
      if (st.image) {
        imageRef.current = st.image;
        setImageState(st.image);
        try {
          const wb = await loadWorkingBitmap(st.image.original);
          if (alive) {
            setBitmap(wb.bitmap);
            setSourceSize({ w: wb.srcW, h: wb.srcH, reduced: wb.reduced });
          } else wb.bitmap.close();
        } catch (e) {
          // nicht still verschlucken: Schritt 1 bittet darum, das Foto neu auszuwählen
          console.warn('Gespeichertes Foto konnte nicht gelesen werden', e);
          if (alive) setImageError('unreadable');
        }
      }
      if (!alive) return;
      const res = restoreComputed(r, st.mosaic, st.progress);
      if (res.computed) {
        // Ältere Projekte: Zellen mit leeren Teilen (z. B. Dreiecksteilung trotz zu breiter Fuge) werden zu
        // ganzen Steinen – sonst zählten Statistik und Fortschritt Teile, die es nicht gibt. Der Benutzer
        // wird informiert (Hinweis im Projektkopf), der reparierte Stand wird gespeichert.
        const fixed = repairDegenerateCells(res.computed.layout, res.computed.data);
        if (fixed > 0) {
          console.warn(`${fixed} Zellen mit leeren Teilen repariert`);
          setRepairedCells(fixed);
          markDirty('mosaic');
        }
      }
      setComputedBoth(res.computed);
      if (res.mismatch) {
        console.warn('Gespeichertes Mosaik passt nicht zum Projekt:', res.mismatch);
        setIntegrityError('mismatch');
        setComputeError('integrity');
        if (st.mosaic) setRejected({ reason: res.mismatch, cells: st.mosaic.cols * st.mosaic.rows, placed: placedInStored(st.mosaic, st.progress) });
      }
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [id, setRecBoth, setComputedBoth, markDirty]);

  // Sperre der Palette, solange irgendwo eine Berechnung dieses Projekts läuft
  useEffect(() => {
    setPaletteLocked(isComputing(id));
    return onComputeLock(() => setPaletteLocked(isComputing(id)));
  }, [id]);

  // Foto freigeben, sobald es ersetzt wurde oder die Ansicht geschlossen wird (große Fotos belegen viel Speicher)
  useEffect(() => {
    if (!bitmap) return;
    return () => {
      try {
        bitmap.close();
      } catch {
        /* bereits freigegeben */
      }
    };
  }, [bitmap]);

  const adopt = useCallback(async () => {
    const s = sv.current;
    let st;
    try {
      st = await loadProjectState(id, { image: false });
    } catch (e) {
      console.warn(e);
      return;
    }
    if (!mounted.current) return;
    const cur = recRef.current;
    if (!st.rec) {
      s.deleted = true;
      setError({ code: 'deleted', message: DELETED });
      return;
    }
    if (!cur || (st.rec.mosaicRev ?? null) === (cur.mosaicRev ?? null)) {
      s.staleKnown = false;
      return;
    }
    // Ohne eigene ungespeicherte Bearbeitungen den gespeicherten Stand vollständig übernehmen (auch die
    // Einstellungen, mit denen anderswo berechnet wurde); sonst eigene Bearbeitungen behalten und nur
    // Raster + Palette (+ zugehörige Felder) aus dem Speicher nehmen.
    const recClean = s.gen.rec === s.saved.rec && s.writing.rec === s.saved.rec;
    // Eine hier bearbeitete eigene Palette bleibt, wenn sie zum neuen Raster passt (nur ergänzt/geändert)
    setRecBoth(recClean ? st.rec : keepStoredComputeFields(cur, st.rec, { paletteEdited: cur.palette !== paletteBaseRef.current }));
    paletteBaseRef.current = st.rec.palette;
    discardGrid();
    const res = restoreComputed(st.rec, st.mosaic, st.progress);
    setComputedBoth(res.computed);
    setIntegrityError(res.mismatch ? 'mismatch' : null);
    setRejected(res.mismatch && st.mosaic ? { reason: res.mismatch, cells: st.mosaic.cols * st.mosaic.rows, placed: placedInStored(st.mosaic, st.progress) } : null);
    setComputeError((prev) => (res.mismatch ? 'integrity' : prev === 'integrity' ? null : prev));
    setVersion((v) => v + 1);
    setProgressVersion((v) => v + 1);
    s.staleKnown = false;
  }, [id, discardGrid, setError, setRecBoth, setComputedBoth]);
  adoptRef.current = adopt;

  useEffect(
    () =>
      onStoreEvent((e) => {
        if (e.id !== id || e.source === instanceRef.current || !mounted.current) return;
        if (e.type === 'deleted') {
          sv.current.deleted = true;
          setError({ code: 'deleted', message: DELETED });
          return;
        }
        if (e.type !== 'computed') return;
        if ((e.mosaicRev ?? null) !== (recRef.current?.mosaicRev ?? null)) {
          sv.current.staleKnown = true;
          void adoptRef.current();
        }
      }),
    [id, setError],
  );

  const update = useCallback(
    (fn: (r: ProjectRecord) => ProjectRecord) => {
      const prev = recRef.current;
      if (!prev) return;
      const next = { ...fn(prev) };
      next.meta = { ...next.meta, updatedAt: Date.now() };
      setRecBoth(next);
      markDirty('rec');
    },
    [markDirty, setRecBoth],
  );

  const setSettings = useCallback((patch: Partial<ProjectSettings>) => update((r) => ({ ...r, settings: { ...r.settings, ...patch } })), [update]);
  const setAdjust = useCallback((patch: Partial<ImageAdjust>) => update((r) => ({ ...r, adjust: { ...r.adjust, ...patch } })), [update]);
  const setRegions = useCallback((regions: Region[]) => update((r) => ({ ...r, regions })), [update]);
  const setPalette = useCallback((palette: PaletteColor[]) => update((r) => ({ ...r, palette })), [update]);

  /** Nach manuellen Änderungen am Raster aufrufen (Steinfarbe/-form, Farbe entfernt). */
  const touchMosaic = useCallback(() => {
    setVersion((v) => v + 1);
    markDirty('mosaic');
    update((r) => ({ ...r, meta: { ...r.meta, manualEdits: (r.meta.manualEdits ?? 0) + 1 } }));
  }, [markDirty, update]);

  const touchProgress = useCallback(() => {
    setProgressVersion((v) => v + 1);
    markDirty('progress');
  }, [markDirty]);

  // ---------- Foto
  /**
   * Ersetzt das Foto dieses Projekts. Wirft, wenn das Foto nicht gelesen werden kann – dann bleibt das
   * bisherige Foto samt Zuschnitt unverändert. `clearRegions`: Gesichts-/Detailbereiche (gehören zum alten
   * Foto) löschen. `prepared`: bereits gelesene Arbeitskopie (wird übernommen und später freigegeben).
   * Liefert `saved: false`, wenn Foto/Projekt nicht sofort gespeichert werden konnten (der Speicherstatus
   * zeigt den Fehler, Speichern wird automatisch wiederholt).
   */
  const setPhoto = useCallback(
    async (blob: Blob, name: string, opts: { clearRegions?: boolean; prepared?: WorkingBitmap } = {}): Promise<{ saved: boolean }> => {
      const wb = opts.prepared ?? (await loadWorkingBitmap(blob));
      if (!mounted.current) {
        wb.bitmap.close();
        return { saved: false };
      }
      const img = { original: blob, name };
      imageRef.current = img;
      setImageState(img);
      setBitmap(wb.bitmap);
      setSourceSize({ w: wb.srcW, h: wb.srcH, reduced: wb.reduced });
      setImageError(null);
      sv.current.pendingImage = img;
      update((r) => {
        // Projektseitenverhältnis an Foto anpassen, wenn noch nichts berechnet wurde
        const aspect = wb.srcW / wb.srcH;
        const s = r.settings;
        const settings = r.computedWith ? s : { ...s, heightMm: Math.round((s.widthMm / aspect) * 10) / 10 };
        // neue Foto-Identität: eine vorhandene Berechnung gilt damit als veraltet
        const next: ProjectRecord = { ...r, imageRev: uid(), settings, adjust: { ...r.adjust, crop: null, rotation: 0, fineRotate: 0, flipH: false } };
        if (opts.clearRegions) next.regions = [];
        return next;
      });
      markDirty('image');
      // Foto und Projekt sofort gemeinsam speichern; Fehler erscheinen zusätzlich im Speicherstatus
      try {
        await persistRef.current('normal');
        return { saved: true };
      } catch {
        return { saved: false };
      }
    },
    [markDirty, update],
  );

  /**
   * Legt für ein anderes Foto ein NEUES Projekt an (Einstellungen wie dieses, siehe projectFromPhoto);
   * dieses Projekt bleibt unverändert. Projekt und Foto werden in einer Transaktion gespeichert.
   * Wirft PhotoSaveError, wenn nichts gespeichert werden konnte. Liefert die neue Projekt-ID.
   */
  const createProjectFromPhoto = useCallback(async (blob: Blob, fileName: string, src: { w: number; h: number }, fallbackName: string): Promise<string> => {
    const r = recRef.current;
    if (!r) throw new Error('Projekt nicht geladen');
    const nid = uid();
    const next = projectFromPhoto(r, nid, nameFromFile(fileName, fallbackName), src.w / src.h, Date.now(), uid());
    const image: ImageRecord = { original: blob, name: fileName || 'foto' };
    try {
      await txMulti<void>(['projects', 'images'], 'readwrite', (ctx) => {
        ctx.store('projects').put(next, nid);
        ctx.store('images').put(image, nid);
        ctx.commit();
      });
    } catch (e) {
      throw new PhotoSaveError(e);
    }
    return nid;
  }, []);

  // ---------- abgeleitete Werte
  const layoutInfo = useMemo(() => {
    if (!rec) return { layout: null as Layout | null, error: null as string | null };
    try {
      return { layout: computeLayout(layoutParamsOf(rec.settings)), error: null };
    } catch (e) {
      return { layout: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [rec]);

  const sections: SectionGrid | null = useMemo(() => {
    if (!computed || !rec) return null;
    return sectionsFor(computed.layout, rec.settings);
  }, [computed, rec?.settings.sectionMode, rec?.settings.sectionWmm, rec?.settings.sectionHmm, rec?.settings.sectionCols, rec?.settings.sectionRows]); // eslint-disable-line react-hooks/exhaustive-deps

  const stale = !!rec && !!computed && rec.computedWith !== computeKey(rec);

  /** Schneller Verlegefortschritt (ohne Geometrie) – gesamt und je Abschnitt. */
  const progress = useMemo(() => {
    if (!computed || !sections) return null;
    const total = progressOf(computed.layout, computed.data);
    const perSection = new Map(sections.sections.map((s) => [s.id, progressOf(computed.layout, computed.data, s)]));
    return { total, perSection };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed, sections, version, progressVersion]);

  /** Effektiver Zuschnitt (normiert) passend zum Seitenverhältnis der fertigen Mosaikfläche. */
  // Maße des Originals (nicht der evtl. verkleinerten Arbeitskopie): Zuschnitt und Arbeitsauflösung wie bei voller Dekodierung
  const srcW = sourceSize?.w ?? bitmap?.width ?? 0;
  const srcH = sourceSize?.h ?? bitmap?.height ?? 0;
  const effectiveCrop = useMemo(() => {
    if (!rec || !bitmap || !layoutInfo.layout || !srcW || !srcH) return null;
    const { w, h } = rotatedSize(srcW, srcH, rec.adjust);
    return fitCrop(rec.adjust.crop, w, h, layoutInfo.layout.finishedW / layoutInfo.layout.finishedH);
  }, [rec, bitmap, srcW, srcH, layoutInfo.layout]);

  // ---------- Statistik (im Worker)
  const statsReq = useRef(0);
  const lastStatsVersion = useRef(-1);
  useEffect(() => {
    if (!computed || !rec) {
      setStats(null);
      return;
    }
    const my = ++statsReq.current;
    const timer = window.setTimeout(async () => {
      setStatsBusy(true);
      try {
        const secs = sectionsFor(computed.layout, rec.settings);
        const res = await runWorker<'stats'>('stats', {
          type: 'stats',
          layoutParams: computed.layoutParams,
          mosaic: packMosaic(computed.data),
          palette: rec.palette,
          materials,
          reservePct: rec.settings.reservePct,
          groutDepthMm: rec.settings.groutDepthMm,
          ranges: secs.sections.map((s) => ({ key: s.id, range: { r0: s.r0, r1: s.r1, c0: s.c0, c1: s.c1 } })),
        });
        if (my !== statsReq.current) return;
        setStats(res.total);
        setSectionStats(new Map(res.ranges.map((r) => [r.key, r.stats])));
      } catch (e) {
        console.error(e);
      } finally {
        if (my === statsReq.current) setStatsBusy(false);
      }
    }, lastStatsVersion.current === version ? 1500 : 250);
    lastStatsVersion.current = version;
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed, version, progressVersion, rec?.palette, materials, rec?.settings.reservePct, rec?.settings.groutDepthMm, rec?.settings.sectionMode, rec?.settings.sectionWmm, rec?.settings.sectionHmm, rec?.settings.sectionCols, rec?.settings.sectionRows]);

  // ---------- Berechnung
  const compute = useCallback(async () => {
    // Momentaufnahme NUR für die Eingaben der Berechnung; das Ergebnis wird später in den neuesten Stand übernommen
    const r = recRef.current;
    if (!r || !bitmap || !layoutInfo.layout) return false;
    // Foto zum Zeitpunkt des Starts (ein Fotowechsel während der Berechnung macht das Ergebnis „veraltet“)
    const original = imageRef.current?.original ?? null;
    const reduced = !!sourceSize?.reduced;
    const sw = srcW || bitmap.width;
    const sh = srcH || bitmap.height;
    setComputeError(null);
    setComputing({ phase: 'prepare', fraction: 0 });
    // Palette sperren (auch für andere Ansichten/Tabs), bis das Ergebnis gespeichert oder verworfen ist
    const endLock = beginCompute(id);
    try {
      const layout = layoutInfo.layout;
      const lp = layoutParamsOf(r.settings);
      // Zuschnitt und Arbeitsauflösung aus den Maßen des ORIGINALS – genau wie bei voller Dekodierung
      const { w: rw, h: rh } = rotatedSize(sw, sh, r.adjust);
      const crop = fitCrop(r.adjust.crop, rw, rh, layout.finishedW / layout.finishedH);
      const ws = workingSize(layout.cols * layout.rows, layout.finishedW / layout.finishedH, crop.w * rw * crop.h * rh);
      // Hat die verkleinerte Arbeitskopie im Zuschnitt zu wenig Pixel, wird das Original vorübergehend voll gelesen
      const { w: bw, h: bh } = rotatedSize(bitmap.width, bitmap.height, r.adjust);
      let full: ImageBitmap | null = null;
      if (original && needsFullResolution(reduced, crop, bw, bh, ws)) {
        try {
          full = await loadBitmap(original);
        } catch (e) {
          // z. B. zu wenig Speicher: mit der Arbeitskopie rechnen (gleiche Pixelzahl, etwas weniger Bilddetail)
          console.warn('Original konnte nicht voll gelesen werden – Berechnung mit der Arbeitskopie', e);
        }
      }
      const raw = (() => {
        try {
          return canvasToRaw(renderCropped(full ?? bitmap, r.adjust, crop, ws.w, ws.h));
        } finally {
          full?.close(); // volle Auflösung nur für diesen einen Zuschnitt im Speicher halten
        }
      })();
      const s = r.settings;
      // mit Farbnummer: eigene Paletten behalten ihre Nummern (auch Lücken nach dem Entfernen einer Farbe)
      const fixed = buildFixedPalette(s, r.palette, materials);
      const res = await runWorker<'compute'>(
        'compute',
        {
          type: 'compute',
          image: raw,
          adjust: { ...r.adjust, crop: null },
          regions: r.regions,
          layoutParams: lp,
          params: {
            shapes: s.shapes,
            paletteMode: s.paletteMode,
            colorCount: s.colorCount,
            dither: s.dither,
            deltaE: s.deltaE,
            fixedPalette: fixed,
            regions: r.regions,
            lang,
          },
        },
        [raw.data.buffer],
        (phase, fraction) => setComputing({ phase, fraction }),
      );
      const data: MosaicDataWithRev = unpackMosaic(res.mosaic);
      const proc = document.createElement('canvas');
      proc.width = res.processed.width;
      proc.height = res.processed.height;
      proc.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(res.processed.data), res.processed.width, res.processed.height), 0, 0);
      const thumbCanvas = renderFull(layout, data, res.palette, 320, { groutHex: s.groutHex, realistic: false });
      const thumb = await canvasToJpeg(thumbCanvas, 0.8);
      // Schlüssel der tatsächlich berechneten Eingaben (Momentaufnahme; bei eigener Palette mit der
      // neu nummerierten Ergebnispalette) – nie des neuesten Stands: Änderungen während der Berechnung
      // erscheinen so korrekt als „Einstellungen geändert“.
      const keyRec: ProjectRecord = s.paletteMode === 'custom' ? { ...r, palette: res.palette } : r;
      const fields: ComputeFields = {
        palette: res.palette,
        diagnostics: res.diagnostics as ComputeDiagnostics,
        computedWith: computeKey(keyRec),
        mosaicRev: uid(),
        computedImageRev: r.imageRev,
        thumb,
        updatedAt: Date.now(),
        // Eigene Palette ist eine Eingabe: Änderungen während der Berechnung nicht überschreiben
        ...(s.paletteMode === 'custom' ? { customInput: r.palette } : {}),
      };
      // Wurde die eigene Palette hier während der Berechnung verkürzt oder umsortiert, passt das Ergebnis nicht mehr
      if (mounted.current && recRef.current && !resolveComputedPalette(recRef.current.palette, fields)) throw new Error(PALETTE_CHANGED);
      const pk = packWithoutProgress(data, fields.mosaicRev);
      let saveFailure: unknown = null;
      let committed: ProjectRecord | null = null;
      try {
        // Projekt (neuester gespeicherter Stand + Ergebnisfelder), Raster und Fortschritt in EINER Transaktion
        committed = await commitComputed(id, fields, pk.mosaic, pk.progress, instanceRef.current);
      } catch (e) {
        if (isDeletedError(e)) {
          // Projekt wurde während der Berechnung gelöscht: nichts speichern, nicht wieder anlegen
          if (mounted.current) setComputeError('deleted');
          return false;
        }
        // Eigene Palette wurde anderswo verkürzt/umsortiert: nichts gespeichert, Palette und altes Raster bleiben
        if (isPaletteChangedError(e)) throw e;
        saveFailure = e;
      }
      if (!mounted.current) {
        if (saveFailure) console.warn('Ergebnis konnte nicht gespeichert werden', saveFailure);
        return !saveFailure;
      }
      setProcessed(proc);
      data.rev = fields.mosaicRev;
      const latest = recRef.current ?? r;
      // Palette, die jetzt zum gespeicherten Raster gehört (bei eigener Palette ggf. mit Ergänzungen,
      // die anderswo während der Berechnung gespeichert wurden – siehe commitComputed)
      const storedPalette = committed?.palette ?? fields.palette;
      const asStored = () => mergeComputeFields({ ...latest, palette: storedPalette }, { ...fields, customInput: undefined, palette: storedPalette, computedWith: committed?.computedWith ?? fields.computedWith });
      let merged: ProjectRecord;
      if (latest.palette === paletteBaseRef.current) {
        // hier nicht bearbeitet: der gespeicherte Stand gilt
        merged = asStored();
      } else {
        try {
          // hier bearbeitet (noch nicht gespeichert): nur ergänzt/geändert → bleibt, sonst gilt das Gespeicherte
          merged = mergeComputeFields(latest, fields);
        } catch {
          // Palette wurde in den Millisekunden des Speicherns verkürzt (sonst gesperrt): Raster und
          // gespeicherte Palette gehören zusammen – diese Palette gilt.
          merged = asStored();
        }
      }
      setRecBoth(merged);
      paletteBaseRef.current = committed?.palette ?? fields.palette;
      setComputedBoth({ layout, layoutParams: lp, data });
      setIntegrityError(null);
      setRejected(null);
      discardGrid(); // ausstehende Speicherungen gehören zum ersetzten Raster
      setVersion((v) => v + 1);
      setProgressVersion((v) => v + 1);
      if (saveFailure) {
        // Ergebnis ist berechnet, aber nicht gespeichert: im Speicher behalten, vollständig nachspeichern
        console.warn('Ergebnis konnte nicht gespeichert werden', saveFailure);
        const sref = sv.current;
        sref.force = true;
        markDirty('rec');
        markDirty('mosaic');
        markDirty('progress');
        setError(classifySaveError(saveFailure));
      }
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'abgebrochen' && mounted.current) setComputeError(msg);
      return false;
    } finally {
      endLock();
      setComputing(null);
    }
  }, [bitmap, sourceSize, srcW, srcH, layoutInfo.layout, materials, id, lang, discardGrid, markDirty, setError, setRecBoth, setComputedBoth]);

  const cancelCompute = useCallback(() => cancelChannel('compute'), []);

  const originalPreview = useCallback((maxPx: number) => (bitmap && rec ? renderRotated(bitmap, rec.adjust, maxPx) : null), [bitmap, rec]);

  /**
   * Projektdatei aus dem Stand im ARBEITSSPEICHER (nicht aus dem Gerätespeicher) – zum Sichern,
   * wenn Speichern fehlschlägt.
   */
  const exportCurrent = useCallback(async (): Promise<Blob> => {
    const r = recRef.current;
    if (!r) throw new Error('Projekt nicht geladen');
    const c = computedRef.current;
    const pk = c ? packWithoutProgress(c.data, r.mosaicRev) : null;
    return buildProjectExport(r, imageRef.current, pk?.mosaic ?? null, pk?.progress ?? null);
  }, []);

  /**
   * Legt eine vollständige Kopie des Projekts an (Datensatz, Foto, Raster, Fortschritt) und liefert ihre ID.
   * Speichert vorher alles Ausstehende; schlägt das fehl, wird KEINE Kopie angelegt (Fehler wird geworfen).
   */
  const createBackupCopy = useCallback(
    async (suffix: string): Promise<string> => {
      await flush();
      const nid = await duplicateProject(id, suffix);
      if (!nid) throw new Error(DELETED);
      return nid;
    },
    [flush, id],
  );

  return {
    loaded,
    rec,
    image,
    /** Arbeitskopie des Fotos (kann kleiner als das Original sein – Maße des Originals: sourceSize) */
    bitmap,
    /** Pixelmaße des Originalfotos (nach EXIF-Ausrichtung) und ob die Arbeitskopie verkleinert ist */
    sourceSize,
    /** 'unreadable': gespeichertes Foto konnte nicht gelesen werden */
    imageError,
    layout: layoutInfo.layout,
    layoutError: layoutInfo.error,
    computed,
    sections,
    version,
    progressVersion,
    stats,
    sectionStats,
    progress,
    statsBusy,
    computing,
    computeError,
    stale,
    effectiveCrop,
    processed,
    /** Speicherstatus für die Anzeige („Gespeichert ✓ / Speichert … / Nicht gespeichert“) */
    saveState,
    saveError,
    /** 'mismatch': gespeichertes Raster gehört nicht zur Palette – nicht angezeigt, neu berechnen */
    integrityError,
    /** Angaben zum nicht angezeigten gespeicherten Raster (z. B. verlegte Steine, die beim Neuberechnen verloren gehen) */
    rejected,
    /** beim Laden reparierte Zellen mit leeren Teilen (0 = keine) */
    repairedCells,
    dismissRepaired: () => setRepairedCells(0),
    /** Palette gesperrt, weil (irgendwo) eine Berechnung dieses Projekts läuft */
    paletteLocked,
    /** Anzahl manueller Rasteränderungen seit der letzten Berechnung */
    manualEdits: rec?.meta.manualEdits ?? 0,
    update,
    setSettings,
    setAdjust,
    setRegions,
    setPalette,
    setPhoto,
    createProjectFromPhoto,
    touchMosaic,
    touchProgress,
    compute,
    cancelCompute,
    originalPreview,
    flush,
    retrySave,
    exportCurrent,
    createBackupCopy,
  };
}

export type ProjectApi = ReturnType<typeof useProject>;
