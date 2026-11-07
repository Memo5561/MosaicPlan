import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hexToLab } from '../../core/color';
import { computeLayout, sectionsFor, type Layout, type LayoutParams, type SectionGrid } from '../../core/layout';
import type { ComputeDiagnostics, FixedColor } from '../../core/mosaic';
import { renderFull } from '../../core/render';
import { packMosaic, unpackMosaic, type StoredMosaic } from '../../core/serialize';
import type { Stats } from '../../core/stats';
import type { ImageAdjust, Material, MosaicData, PaletteColor, ProjectSettings, Region } from '../../core/types';
import { loadImage, loadMosaic, loadProgress, loadProject, saveImage, saveMosaic, saveProgress, saveProject, type ImageRecord, type ProjectRecord } from '../../storage/db';
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

export function useProject(id: string, materials: Material[], lang: Lang) {
  const [rec, setRec] = useState<ProjectRecord | null>(null);
  const [image, setImage] = useState<ImageRecord | null>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [computed, setComputed] = useState<ComputedState | null>(null);
  const [version, setVersion] = useState(0);
  const [progressVersion, setProgressVersion] = useState(0);
  const [computing, setComputing] = useState<ComputeProgress | null>(null);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [sectionStats, setSectionStats] = useState<Map<string, Stats>>(new Map());
  const [statsBusy, setStatsBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [processed, setProcessed] = useState<HTMLCanvasElement | null>(null);
  const saveTimers = useRef<Record<string, number>>({});
  const recRef = useRef<ProjectRecord | null>(null);
  recRef.current = rec;
  const computedRef = useRef<ComputedState | null>(null);
  computedRef.current = computed;

  // ---------- Laden
  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await loadProject(id);
      if (!alive || !r) {
        setLoaded(true);
        return;
      }
      setRec(r);
      const img = await loadImage(id);
      if (img) {
        setImage(img);
        try {
          const bmp = await loadBitmap(img.original);
          if (alive) setBitmap(bmp);
        } catch {
          /* Bild nicht lesbar */
        }
      }
      const m = await loadMosaic(id);
      if (m && r.computedWith) {
        try {
          const lp = (JSON.parse(r.computedWith) as { l: LayoutParams }).l;
          const layout = computeLayout(lp);
          const prog = (await loadProgress(id)) ?? new Uint16Array(m.cols * m.rows);
          if (layout.cols === m.cols && layout.rows === m.rows) {
            const data = unpackMosaic({ ...(m as StoredMosaic), progress: prog.length === m.cols * m.rows ? prog : new Uint16Array(m.cols * m.rows) });
            if (alive) setComputed({ layout, layoutParams: lp, data });
          }
        } catch {
          /* inkonsistente Daten ignorieren */
        }
      }
      if (alive) setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  // ---------- Speichern (entprellt)
  const schedule = useCallback((key: string, ms: number, fn: () => Promise<void>) => {
    window.clearTimeout(saveTimers.current[key]);
    saveTimers.current[key] = window.setTimeout(() => {
      delete saveTimers.current[key];
      fn().catch((e) => console.error('Speichern fehlgeschlagen', e));
    }, ms);
  }, []);

  const flush = useCallback(async () => {
    const r = recRef.current;
    const c = computedRef.current;
    const jobs: Promise<void>[] = [];
    for (const k of Object.keys(saveTimers.current)) {
      window.clearTimeout(saveTimers.current[k]);
      delete saveTimers.current[k];
      if (k === 'rec' && r) jobs.push(saveProject(r));
      if (k === 'mosaic' && c) {
        const { progress: _p, ...rest } = packMosaic(c.data);
        void _p;
        jobs.push(saveMosaic(id, rest));
      }
      if (k === 'progress' && c) jobs.push(saveProgress(id, c.data.progress));
    }
    await Promise.all(jobs);
  }, [id]);

  useEffect(() => {
    const h = () => void flush();
    window.addEventListener('pagehide', h);
    document.addEventListener('visibilitychange', h);
    return () => {
      window.removeEventListener('pagehide', h);
      document.removeEventListener('visibilitychange', h);
      void flush();
    };
  }, [flush]);

  const update = useCallback(
    (fn: (r: ProjectRecord) => ProjectRecord) => {
      setRec((prev) => {
        if (!prev) return prev;
        const next = fn(prev);
        next.meta = { ...next.meta, updatedAt: Date.now() };
        recRef.current = next;
        schedule('rec', 400, () => saveProject(recRef.current!));
        return next;
      });
    },
    [schedule],
  );

  const setSettings = useCallback((patch: Partial<ProjectSettings>) => update((r) => ({ ...r, settings: { ...r.settings, ...patch } })), [update]);
  const setAdjust = useCallback((patch: Partial<ImageAdjust>) => update((r) => ({ ...r, adjust: { ...r.adjust, ...patch } })), [update]);
  const setRegions = useCallback((regions: Region[]) => update((r) => ({ ...r, regions })), [update]);
  const setPalette = useCallback((palette: PaletteColor[]) => update((r) => ({ ...r, palette })), [update]);

  /** Nach manuellen Änderungen am Raster aufrufen. */
  const touchMosaic = useCallback(() => {
    setVersion((v) => v + 1);
    schedule('mosaic', 1200, async () => {
      const c = computedRef.current;
      if (!c) return;
      const { progress: _p, ...rest } = packMosaic(c.data);
      void _p;
      await saveMosaic(id, rest);
      await saveProgress(id, c.data.progress);
    });
    update((r) => r);
  }, [id, schedule, update]);

  const touchProgress = useCallback(() => {
    setProgressVersion((v) => v + 1);
    schedule('progress', 600, async () => {
      const c = computedRef.current;
      if (c) await saveProgress(id, c.data.progress);
    });
  }, [id, schedule]);

  // ---------- Foto
  const setPhoto = useCallback(
    async (blob: Blob, name: string) => {
      const bmp = await loadBitmap(blob);
      const img = { original: blob, name };
      await saveImage(id, img);
      setImage(img);
      setBitmap(bmp);
      update((r) => {
        // Projektseitenverhältnis an Foto anpassen, wenn noch nichts berechnet wurde
        const aspect = bmp.width / bmp.height;
        const s = r.settings;
        const settings = r.computedWith ? s : { ...s, heightMm: Math.round((s.widthMm / aspect) * 10) / 10 };
        return { ...r, settings, adjust: { ...r.adjust, crop: null, rotation: 0, fineRotate: 0, flipH: false } };
      });
    },
    [id, update],
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

  /** Effektiver Zuschnitt (normiert) passend zum Seitenverhältnis der fertigen Mosaikfläche. */
  const effectiveCrop = useMemo(() => {
    if (!rec || !bitmap || !layoutInfo.layout) return null;
    const { w, h } = rotatedSize(bitmap.width, bitmap.height, rec.adjust);
    return fitCrop(rec.adjust.crop, w, h, layoutInfo.layout.finishedW / layoutInfo.layout.finishedH);
  }, [rec, bitmap, layoutInfo.layout]);

  // ---------- Statistik (im Worker)
  const statsReq = useRef(0);
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
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed, version, progressVersion, rec?.palette, materials, rec?.settings.reservePct, rec?.settings.groutDepthMm, rec?.settings.sectionMode, rec?.settings.sectionWmm, rec?.settings.sectionHmm, rec?.settings.sectionCols, rec?.settings.sectionRows]);

  // ---------- Berechnung
  const compute = useCallback(async () => {
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
      const data = unpackMosaic(res.mosaic);
      const proc = document.createElement('canvas');
      proc.width = res.processed.width;
      proc.height = res.processed.height;
      proc.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(res.processed.data), res.processed.width, res.processed.height), 0, 0);
      setProcessed(proc);
      const st: ComputedState = { layout, layoutParams: lp, data };
      // Palette übernehmen (Materialzuordnung aus Materialmodus bleibt erhalten)
      const key = computeKey(r);
      const thumbCanvas = renderFull(layout, data, res.palette, 320, { groutHex: s.groutHex, realistic: false });
      const thumb = await canvasToJpeg(thumbCanvas, 0.8);
      const next: ProjectRecord = {
        ...r,
        palette: res.palette,
        diagnostics: res.diagnostics as ComputeDiagnostics,
        computedWith: key,
        meta: { ...r.meta, computed: true, thumb, updatedAt: Date.now() },
      };
      // Bei eigener Palette ändert sich der Schlüssel nicht durch Neunummerierung
      if (r.settings.paletteMode === 'custom') next.computedWith = computeKey(next);
      recRef.current = next;
      setRec(next);
      computedRef.current = st;
      setComputed(st);
      setVersion((v) => v + 1);
      const { progress, ...rest } = packMosaic(data);
      await Promise.all([saveProject(next), saveMosaic(id, rest), saveProgress(id, progress)]);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== 'abgebrochen') setComputeError(msg);
      return false;
    } finally {
      setComputing(null);
    }
  }, [bitmap, layoutInfo.layout, materials, id, lang]);

  const cancelCompute = useCallback(() => cancelChannel('compute'), []);

  const originalPreview = useCallback((maxPx: number) => (bitmap && rec ? renderRotated(bitmap, rec.adjust, maxPx) : null), [bitmap, rec]);

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
    statsBusy,
    computing,
    computeError,
    stale,
    effectiveCrop,
    processed,
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
  };
}

export type ProjectApi = ReturnType<typeof useProject>;
