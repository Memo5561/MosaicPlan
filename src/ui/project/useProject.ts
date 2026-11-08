import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hexToLab } from '../../core/color';
import { checkMosaicIntegrity } from '../../core/integrity';
import { computeLayout, sectionsFor, type Layout, type LayoutParams, type SectionGrid } from '../../core/layout';
import type { ComputeDiagnostics, FixedColor } from '../../core/mosaic';
import { renderFull } from '../../core/render';
import { packMosaic, unpackMosaic, type MosaicDataWithRev } from '../../core/serialize';
import { progressOf, type Stats } from '../../core/stats';
import type { ImageAdjust, Material, MosaicData, PaletteColor, ProjectSettings, Region } from '../../core/types';
import {
  commitComputed,
  DELETED,
  isDeletedError,
  keepStoredComputeFields,
  loadProjectState,
  mergeComputeFields,
  onStoreEvent,
  saveProjectState,
  uid,
  type ComputeFields,
  type ImageRecord,
  type ProjectRecord,
  type SaveGuard,
  type SaveParts,
  type StoredMosaicNoProgress,
} from '../../storage/db';
import { buildProjectExport, duplicateProject } from '../../storage/projects';
import { cancelChannel, runWorker } from '../../workers/client';
import { canvasToJpeg, canvasToRaw, fitCrop, loadBitmap, renderCropped, renderRotated, rotatedSize, workingSize } from './imagePrep';
import type { Lang } from '../../i18n';

export function layoutParamsOf(s: ProjectSettings): LayoutParams {
  return { widthMm: s.widthMm, heightMm: s.heightMm, tileW: s.tileW, tileH: s.tileH, joint: s.joint, edgeMode: s.edgeMode, minCutMm: s.minCutMm };
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
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
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

  // Die Refs sind die maßgebliche Quelle (sofort aktuell, auch in Ereignis-Handlern beim Verlassen
  // der Seite); der React-State spiegelt sie für das Rendern.
  const recRef = useRef<ProjectRecord | null>(null);
  const computedRef = useRef<ComputedState | null>(null);
  const imageRef = useRef<ImageRecord | null>(null);
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
      const p: Promise<void> = saveProjectState(id, parts, guard, r?.mosaicRev)
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
      if (st.image) {
        imageRef.current = st.image;
        setImageState(st.image);
        try {
          const bmp = await loadBitmap(st.image.original);
          if (alive) setBitmap(bmp);
          else bmp.close();
        } catch {
          /* Bild nicht lesbar */
        }
      }
      if (!alive) return;
      const res = restoreComputed(r, st.mosaic, st.progress);
      setComputedBoth(res.computed);
      if (res.mismatch) {
        console.warn('Gespeichertes Mosaik passt nicht zum Projekt:', res.mismatch);
        setIntegrityError('mismatch');
        setComputeError('integrity');
      }
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [id, setRecBoth, setComputedBoth]);

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
    setRecBoth(recClean ? st.rec : keepStoredComputeFields(cur, st.rec));
    discardGrid();
    const res = restoreComputed(st.rec, st.mosaic, st.progress);
    setComputedBoth(res.computed);
    setIntegrityError(res.mismatch ? 'mismatch' : null);
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
  const setPhoto = useCallback(
    async (blob: Blob, name: string) => {
      const bmp = await loadBitmap(blob);
      if (!mounted.current) {
        bmp.close();
        return;
      }
      const img = { original: blob, name };
      imageRef.current = img;
      setImageState(img);
      setBitmap(bmp);
      sv.current.pendingImage = img;
      update((r) => {
        // Projektseitenverhältnis an Foto anpassen, wenn noch nichts berechnet wurde
        const aspect = bmp.width / bmp.height;
        const s = r.settings;
        const settings = r.computedWith ? s : { ...s, heightMm: Math.round((s.widthMm / aspect) * 10) / 10 };
        // neue Foto-Identität: eine vorhandene Berechnung gilt damit als veraltet
        return { ...r, imageRev: uid(), settings, adjust: { ...r.adjust, crop: null, rotation: 0, fineRotate: 0, flipH: false } };
      });
      markDirty('image');
      // Foto und Projekt sofort gemeinsam speichern; Fehler erscheinen im Speicherstatus
      await persistRef.current('normal').catch(() => {});
    },
    [markDirty, update],
  );

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
  const effectiveCrop = useMemo(() => {
    if (!rec || !bitmap || !layoutInfo.layout) return null;
    const { w, h } = rotatedSize(bitmap.width, bitmap.height, rec.adjust);
    return fitCrop(rec.adjust.crop, w, h, layoutInfo.layout.finishedW / layoutInfo.layout.finishedH);
  }, [rec, bitmap, layoutInfo.layout]);

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
    setComputeError(null);
    setComputing({ phase: 'prepare', fraction: 0 });
    try {
      const layout = layoutInfo.layout;
      const lp = layoutParamsOf(r.settings);
      const { w: rw, h: rh } = rotatedSize(bitmap.width, bitmap.height, r.adjust);
      const crop = fitCrop(r.adjust.crop, rw, rh, layout.finishedW / layout.finishedH);
      const ws = workingSize(layout.cols * layout.rows, layout.finishedW / layout.finishedH, crop.w * rw * crop.h * rh);
      const canvas = renderCropped(bitmap, r.adjust, crop, ws.w, ws.h);
      const raw = canvasToRaw(canvas);
      const s = r.settings;
      let fixed: FixedColor[] | undefined;
      if (s.paletteMode === 'materials' || s.paletteMode === 'auto-snap') {
        const pool = materials.filter((m) => s.materialIds.length === 0 || s.materialIds.includes(m.id));
        fixed = pool.map((m) => ({ lab: hexToLab(m.hex), hex: m.hex.toUpperCase(), name: m.colorName || `${m.manufacturer} ${m.colorNumber}`.trim(), materialId: m.id }));
        if (!fixed.length) throw new Error('no-materials');
      } else if (s.paletteMode === 'custom') {
        fixed = r.palette.map((p) => ({ lab: p.lab, hex: p.hex, name: p.name, materialId: p.materialId }));
        if (!fixed.length) throw new Error('no-palette');
      }
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
      };
      const pk = packWithoutProgress(data, fields.mosaicRev);
      let saveFailure: unknown = null;
      try {
        // Projekt (neuester gespeicherter Stand + Ergebnisfelder), Raster und Fortschritt in EINER Transaktion
        await commitComputed(id, fields, pk.mosaic, pk.progress, instanceRef.current);
      } catch (e) {
        if (isDeletedError(e)) {
          // Projekt wurde während der Berechnung gelöscht: nichts speichern, nicht wieder anlegen
          if (mounted.current) setComputeError('deleted');
          return false;
        }
        saveFailure = e;
      }
      if (!mounted.current) {
        if (saveFailure) console.warn('Ergebnis konnte nicht gespeichert werden', saveFailure);
        return !saveFailure;
      }
      setProcessed(proc);
      data.rev = fields.mosaicRev;
      const latest = recRef.current ?? r;
      setRecBoth(mergeComputeFields(latest, fields));
      setComputedBoth({ layout, layoutParams: lp, data });
      setIntegrityError(null);
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
      setComputing(null);
    }
  }, [bitmap, layoutInfo.layout, materials, id, lang, discardGrid, markDirty, setError, setRecBoth, setComputedBoth]);

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
    bitmap,
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
    /** Anzahl manueller Rasteränderungen seit der letzten Berechnung */
    manualEdits: rec?.meta.manualEdits ?? 0,
    update,
    setSettings,
    setAdjust,
    setRegions,
    setPalette,
    setPhoto,
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
