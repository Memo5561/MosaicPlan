/**
 * Schritt 10 – PDF-Verlegeplan (Paket w5-pdf-export-ui).
 *
 * Vor dem Erzeugen steht, was im PDF sein wird und wie viele Seiten jeder Teil ungefähr braucht: Der Seitenplan
 * wird vorab mit dem Seitenaufbau des PDF-Generators gemessen (Worker-Kanal 'pdfPlan', siehe pdfPlanFacts.ts) und
 * mit planPdfPages() zusammengezählt. Vor dem Erzeugen tragen alle Seitenzahlen „ca.“.
 *
 * Abschnitte sind immer wählbar (SectionPicker). Braucht ein Export voraussichtlich mehr Arbeitsspeicher, als das
 * Gerät sicher hergibt (Richtwert, siehe core/pdfExportPlan.ts), wird er in Teilen angeboten: aufeinanderfolgende
 * Abschnitte, ein Teil nach dem anderen, jeder ein eigener Auftrag im Worker – nie mehrere Downloads auf einmal.
 *
 * Sicherheit: Sind die Einstellungen seit der Berechnung geändert, muss „Mit alter Berechnung exportieren“ bestätigt
 * werden (oder neu berechnen). Wurde das Foto seit der Berechnung ersetzt, fehlt die Seite „Originalfoto“ – nie steht
 * ein fremdes Foto neben dem Mosaik. Speichern wird abgewartet und sein echtes Ergebnis angezeigt; „Abbrechen“
 * beendet den Auftrag; Adressen früherer Dateien werden freigegeben (pdfExportStore.ts).
 *
 * Welle 6 (w6-pdf-finish): Nach dem Erzeugen steht die echte Seitenzahl der Datei (vom Generator gezählt, mit Aufteilung
 * je Teil und Vergleich mit der Schätzung vorab); die Koordinatenart nennt vorab die Seiten jeder Art.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Layout } from '../../core/layout';
import type { PdfBreakdown, PdfImage } from '../../core/pdf';
import {
  exportFileName,
  formatSectionRange,
  memoryBudget,
  normalizeSelection,
  planExportParts,
  planForSelection,
  readBudgetOverride,
  sectionCosts,
  writeBudgetOverride,
  type ExportPart,
  type MemoryBudget,
} from '../../core/pdfExportPlan';
import { coordModeOf, DEFAULT_PDF_OPTIONS, effectiveSheetScale, fitSheetScale, fmtScale, printableArea, type CodePlanMode, type CoordMode, type PdfOptions } from '../../core/pdfOptions';
import { CODE_MIN_CELL, CODE_PLAN_WHOLE_MAX_K, codePlanZoom, planPdfPages, type PlanPart } from '../../core/pdfPlan';
import { renderFull } from '../../core/render';
import { packMosaic } from '../../core/serialize';
import type { ImageAdjust, Material } from '../../core/types';
import { dictionaries, tCount, useI18n } from '../../i18n';
import { cancelChannel, runWorker } from '../../workers/client';
import { Badge, Field, NumberInput, ProgressBar, safeFileName, SaveResultNote, Segmented, Toggle } from '../components';
import '../css/w5-pdf-export-ui.css';
import { canvasToJpeg, rotatedSize } from './imagePrep';
import {
  CANCELLED,
  cancelPdfJob,
  clearPdfMessages,
  crashNotice,
  detectCrashedExport,
  dismissCrashNotice,
  dropOtherProjects,
  localStore,
  pdfFileSig,
  pdfJobRunning,
  pdfJobState,
  pruneFiles,
  runPdfJob,
  subscribePdfJobs,
  watchPdfJobs,
  type PdfFile,
} from './pdfExportStore';
import { usePartFacts, usePdfFacts, type PdfPlanRequest } from './pdfPlanFacts';
import { SectionPicker } from './SectionPicker';
import { photoChangedSince, staleReasonLabels, staleReasons } from './staleReasons';
import { clearStepAction, setStepAction } from './stepAction';
import { stepHash } from './stepNav';
import { computeKey, type ProjectApi } from './useProject';

type Rec = NonNullable<ProjectApi['rec']>;
type Computed = NonNullable<ProjectApi['computed']>;
type Grid = NonNullable<ProjectApi['sections']>;

const MIB = 1024 * 1024;
/** längste Seite des Vorschaubilds bzw. des Originalfotos im PDF (px) */
const PREVIEW_PX = 2400;
const ORIGINAL_PX = 1800;
/** ab so vielen Seiten: Hinweis „sehr viele Seiten“ */
const MANY_PAGES = 300;

/** Maße des Vorschaubilds – dieselbe Rechnung wie renderFull (für den Seitenplan, ohne das Bild zu zeichnen) */
function previewSizeOf(layout: Layout): { w: number; h: number } {
  const scale = Math.min(PREVIEW_PX / layout.finishedW, PREVIEW_PX / layout.finishedH);
  return { w: Math.max(1, Math.round(layout.finishedW * scale)), h: Math.max(1, Math.round(layout.finishedH * scale)) };
}

/** Maße des Originalfotos im PDF – dieselbe Rechnung wie renderRotated */
function originalSizeOf(bitmap: { width: number; height: number }, adjust: ImageAdjust): { w: number; h: number } {
  const r = rotatedSize(bitmap.width, bitmap.height, adjust);
  const scale = Math.min(1, ORIGINAL_PX / Math.max(r.w, r.h));
  return { w: Math.max(1, Math.round(r.w * scale)), h: Math.max(1, Math.round(r.h * scale)) };
}

/** so oft wird ein fremder Vermerk „Export läuft“ (anderer Tab) erneut geprüft (ms) */
const CRASH_RECHECK_MS = 10_000;

/** fortlaufende Nummer je Objekt (für die Kennung fertiger Dateien: neues Raster = neue Nummer) */
const objIds = new WeakMap<object, number>();
let nextObjId = 1;
function objId(o: object): number {
  let v = objIds.get(o);
  if (v === undefined) objIds.set(o, (v = nextObjId++));
  return v;
}

/** Speichergrenze dieses Geräts: gespeicherter Wert, sonst aus der Heap-Grenze des Browsers, sonst feste Annahme */
function deviceBudget(): MemoryBudget {
  const mem = (performance as unknown as { memory?: { jsHeapSizeLimit?: number } }).memory;
  return memoryBudget({ jsHeapSizeLimit: mem?.jsHeapSizeLimit, overrideMb: readBudgetOverride(localStore()) });
}

export function StepPdf({ api, materials }: { api: ProjectApi; materials: Material[] }) {
  const { t } = useI18n();
  const rec = api.rec;
  const c = api.computed;
  const G = api.sections;
  if (!rec || !c || !G) return <p className={api.integrityError ? 'error' : 'muted'}>{t(api.integrityError ? 'compute.err.integrity' : 'preview.notComputed')}</p>;
  return <PdfExport api={api} materials={materials} rec={rec} c={c} G={G} />;
}

interface ContentItem {
  key: string;
  label: string;
  /** null = noch nicht bekannt (Messung läuft) */
  pages: number | null;
  off: boolean;
  note?: string;
}

function PdfExport({ api, materials, rec, c, G }: { api: ProjectApi; materials: Material[]; rec: Rec; c: Computed; G: Grid }) {
  const { t, n, lang } = useI18n();
  const projectId = rec.meta.id;

  // ---------------------------------------------------------------- Optionen
  const stored = rec.pdfOptions;
  const opts = useMemo<PdfOptions>(() => {
    const o = { ...DEFAULT_PDF_OPTIONS, ...(stored ?? {}) };
    // nur Abschnitte, die es (noch) gibt; leer oder alle = „alle“
    return { ...o, sectionIds: normalizeSelection(o.sectionIds, G) };
  }, [stored, G]);
  const optsKey = JSON.stringify(opts);
  const setOpts = (p: Partial<PdfOptions>) => api.update((r) => ({ ...r, pdfOptions: { ...DEFAULT_PDF_OPTIONS, ...(r.pdfOptions ?? {}), ...p } }));
  const sel = opts.sectionIds;
  const selCount = sel ? sel.length : G.sections.length;
  const selectionDropped = useMemo(() => {
    const ids = stored?.sectionIds;
    if (!ids?.length) return false;
    const have = new Set(G.sections.map((s) => s.id));
    return ids.some((id) => !have.has(id));
  }, [stored?.sectionIds, G]);

  // ---------------------------------------------------------------- Maßstab und Farbnummern
  const area = printableArea(opts);
  const fitScale = fitSheetScale(G.sections, area.printW, area.printH);
  // wirksamer Blattmaßstab wie im PDF (bei „an Seite anpassen“ der gemeinsame Anpassungsmaßstab aller Abschnitte)
  const effScale = effectiveSheetScale(opts, G.sections, area.printW, area.printH);
  const tileMin = Math.min(c.layout.tileW, c.layout.tileH);
  const codeless = tileMin * effScale < CODE_MIN_CELL;
  const tooSmallCodes = opts.codePlan !== 'off' && codeless;
  // auch im Codeplan (höchstens CODE_PLAN_WHOLE_MAX_K-fach) zu klein: ganze Steine bekommen keine Farbnummer
  const codesIncomplete = opts.codePlan !== 'off' && codePlanZoom(tileMin, Infinity, effScale).wholeComplete === false;
  const coordMode = coordModeOf(opts);

  // ---------------------------------------------------------------- Foto: nie ein fremdes Foto neben dem Mosaik
  const photoReplaced = photoChangedSince(rec);
  const bitmap = api.bitmap;
  const hasOriginal = !!bitmap && !photoReplaced;
  const origSize = useMemo(() => (bitmap && !photoReplaced ? originalSizeOf(bitmap, rec.adjust) : null), [bitmap, photoReplaced, rec.adjust]);
  const prevSize = useMemo(() => previewSizeOf(c.layout), [c.layout]);

  // ---------------------------------------------------------------- Aufträge (laufen unabhängig von dieser Ansicht)
  const job = useSyncExternalStore(subscribePdfJobs, () => pdfJobState(projectId));
  const runningId = useSyncExternalStore(subscribePdfJobs, pdfJobRunning);
  const crash = useSyncExternalStore(subscribePdfJobs, crashNotice);
  const busy = job.busy;
  const otherBusy = !!runningId && runningId !== projectId;
  useEffect(() => {
    dropOtherProjects(projectId);
    return watchPdfJobs(projectId);
  }, [projectId]);

  // ---------------------------------------------------------------- Speichergrenze; nicht beendeter Export
  const [budgetRev, setBudgetRev] = useState(0);
  useEffect(() => {
    // stehen gebliebener Vermerk „Export läuft“: Hinweis zeigen und ggf. die Grenze dieses Geräts senken. Gehört er
    // zu einem Export, der in einem anderen Tab noch läuft, wird später erneut geprüft (pdfExportStore.ts).
    const check = () => {
      if (detectCrashedExport(deviceBudget().bytes)) setBudgetRev((v) => v + 1);
    };
    check();
    const timer = window.setInterval(check, CRASH_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, []);
  // auch eine asynchron erkannte (Web-Sperre) gesenkte Grenze gilt sofort
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const budget = useMemo(() => deviceBudget(), [budgetRev, crash]);

  // ---------------------------------------------------------------- Seitenplan vorab messen
  const perSection = api.progress?.perSection ?? null;
  const stonesOf = useCallback((id: string) => perSection?.get(id)?.total, [perSection]);
  const origKey = origSize ? `${origSize.w}x${origSize.h}` : '';
  /** steht für den Stand, zu dem gemessen wird: neues Objekt = neu messen */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const token = useMemo(() => ({}), [optsKey, c.data, c.layout, api.version, rec.palette, materials, rec.settings, rec.meta.name, lang, origKey]);
  const baseRequest = () => ({
    layoutParams: c.layoutParams,
    // ohne Fotofarben der Steine: PDF und Seitenplan brauchen sie nicht – spart im Worker die Kopie von rund 4 Byte je Zelle
    mosaic: packMosaic(c.data, { targets: false }),
    palette: rec.palette,
    materials,
    settings: rec.settings,
    projectName: rec.meta.name,
    dateStr: new Date().toLocaleDateString(lang === 'de' ? 'de-DE' : lang === 'tr' ? 'tr-TR' : 'en-GB'),
    dict: dictionaries[lang] as Record<string, string>,
    locale: lang,
    fontsBase: new URL('./', document.baseURI).href,
  });
  const measured = usePdfFacts(
    token,
    (): PdfPlanRequest => ({ type: 'pdfPlan', ...baseRequest(), originalSize: origSize ?? undefined, previewSize: prevSize, options: opts }),
    !!busy || otherBusy,
  );
  const facts = measured.facts;
  /** grobe Schätzung ohne Messung: nur ihre nicht geschätzten Teile (z. B. Verlegeblätter) werden gezeigt */
  const rough = useMemo(
    () => planPdfPages(c.layout, G, opts, (id) => stonesOf(id), undefined, { paletteSize: rec.palette.length, hasOriginal, hasPreview: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [c.layout, G, optsKey, stonesOf, rec.palette.length, hasOriginal],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const plan = useMemo(() => (facts ? planForSelection(c.layout, G, opts, sel, (id) => stonesOf(id), facts, sel) : null), [facts, c.layout, G, optsKey, stonesOf]);
  const src = plan ?? rough;
  const known = (...parts: PlanPart[]) => !!plan || parts.every((p) => !rough.estimated.includes(p));

  // ---------------------------------------------------------------- Speicherbedarf und Teile
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const costs = useMemo(() => sectionCosts(c.layout, G, opts, stonesOf, facts), [c.layout, G, optsKey, stonesOf, facts]);
  const partsPlan = useMemo(() => planExportParts(costs, budget.bytes), [costs, budget.bytes]);
  const totalStones = useMemo(() => costs.reduce((a, x) => a + x.stones, 0), [costs]);
  const inParts = !partsPlan.fitsSingle;
  const tooBig = useMemo(() => new Set(partsPlan.tooBig), [partsPlan.tooBig]);
  // jeder Teil wird mit genau seinen Abschnitten gemessen – wie eine Einzeldatei derselben Abschnitte (gleiche Zahl);
  // bis dahin gilt die Schätzung aus der Messung des Ganzen
  const partIds = useMemo(() => (inParts && partsPlan.parts.length > 1 ? partsPlan.parts.map((p) => p.ids) : []), [inParts, partsPlan]);
  const partFacts = usePartFacts(
    token,
    partIds,
    (ids, index, total): PdfPlanRequest => ({ type: 'pdfPlan', ...baseRequest(), originalSize: origSize ?? undefined, previewSize: prevSize, options: { ...opts, sectionIds: ids }, part: { index, total } }),
    !!busy || otherBusy || !facts,
  );
  const partPlans = useMemo(
    () =>
      partIds.map((ids, i) => {
        const pf = partFacts[i];
        return pf ? planForSelection(c.layout, G, opts, ids, (id) => stonesOf(id), pf, ids) : planForSelection(c.layout, G, opts, ids, (id) => stonesOf(id), facts, sel);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [partIds, partFacts, facts, c.layout, G, optsKey, stonesOf],
  );
  const partsPages = partPlans.reduce((a, p) => a + p.total, 0);
  // Seiten jeder Koordinatenart für diese Auswahl (aus derselben Messung: die kompakte Liste wird immer mitgemessen,
  // „je Stein“ folgt exakt aus den Steinzahlen) – vor dem Erzeugen mit „ca.“
  const coordAlt = useMemo(() => {
    if (!facts) return null;
    const of = (m: Exclude<CoordMode, 'off'>) => planForSelection(c.layout, G, { ...opts, includeCoords: true, coordMode: m }, sel, (id) => stonesOf(id), facts, sel).coords;
    return { compact: of('compact'), perStone: of('perStone') };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts, c.layout, G, optsKey, stonesOf]);
  const coordPagesLabel = (m: Exclude<CoordMode, 'off'>) => (coordAlt ? t('w6pf.coordPages', { n: n(coordAlt[m]) }) : null);
  const [singleAnyway, setSingleAnyway] = useState(false);

  // fertige Dateien gehören zu allem, was im PDF steht – denselben Angaben wie die Seitenmessung (`token`): Optionen,
  // Auswahl, Raster, Palette, zugeordnete Materialien, Einstellungen, Projektname, Sprache, Foto (ersetzt, Zuschnitt/
  // Drehung) und Aufteilung. Ändert sich etwas davon, wird die Datei verworfen (Adresse freigegeben) – nie wird ein
  // veraltetes PDF als fertig angeboten.
  const matKey = useMemo(() => {
    const used = new Set(rec.palette.map((p) => p.materialId).filter(Boolean));
    return materials.filter((m) => used.has(m.id));
  }, [materials, rec.palette]);
  const sig = useMemo(
    () =>
      pdfFileSig({
        optsKey,
        version: api.version,
        mosaicRev: rec.mosaicRev ?? '',
        gridIds: [objId(c.data), objId(c.layout)],
        lang,
        photoReplaced,
        original: origKey,
        adjust: rec.adjust,
        palette: rec.palette,
        materials: matKey,
        settings: rec.settings,
        projectName: rec.meta.name,
        parts: inParts ? partsPlan.parts.map((p) => p.ids.length) : 0,
      }),
    [optsKey, api.version, rec.mosaicRev, c.data, c.layout, lang, photoReplaced, origKey, rec.adjust, rec.palette, matKey, rec.settings, rec.meta.name, inParts, partsPlan],
  );
  useEffect(() => pruneFiles(projectId, sig), [projectId, sig, job.files]);
  const files = job.files.filter((f) => f.sig === sig);
  const fileOf = (key: string): PdfFile | undefined => files.find((f) => f.key === key);

  // ---------------------------------------------------------------- veraltete Berechnung: ausdrücklich bestätigen
  const [confirmStale, setConfirmStale] = useState(false);
  useEffect(() => {
    if (!api.stale) setConfirmStale(false);
  }, [api.stale]);
  const blocked = api.stale && !confirmStale;
  const reasonText = api.stale ? staleReasonLabels(staleReasons(rec.computedWith, computeKey(rec)), t, n).join(', ') : '';

  // ---------------------------------------------------------------- Erzeugen
  const imgCache = useRef<{ token: object; preview: PdfImage; original?: PdfImage } | null>(null);
  const fmtBytes = (b: number) => (b >= MIB ? `${n(b / MIB, b >= 100 * MIB ? 0 : 1)} MB` : `${n(Math.max(1, b / 1024), 0)} KB`);
  const rangeOf = (ids: string[]) => {
    const r = formatSectionRange(ids, G);
    return r.length <= 34 ? r : `${ids[0]} … ${ids[ids.length - 1]}`;
  };

  const start = (key: string, ids: string[] | null, part: { index: number; total: number } | null, bytes: number, stones: number) => {
    // Dateiname in der Sprache der Oberfläche, nur ASCII (ä → ae, ş → s …)
    const name = exportFileName(safeFileName(rec.meta.name), {
      stem: safeFileName(t('w5fp.file.stem')),
      range: ids ? formatSectionRange(ids, G) : null,
      count: ids?.length,
      part: part ? { ...part, word: safeFileName(t('w5pe.file.part')), ofWord: safeFileName(t('w5pe.file.of')) } : undefined,
    });
    const tk = token;
    // Worker der Seitenmessung beenden: sein Speicher (Schriften, Kopie des Rasters) wird für den Export frei
    cancelChannel('pdfPlan');
    void runPdfJob({
      projectId,
      key,
      name,
      sig,
      ids,
      inFlight: { projectId, projectName: rec.meta.name, sections: ids ? ids.length : G.sections.length, stones, bytes, budgetBytes: budget.bytes, part: part ?? undefined, at: Date.now() },
      produce: async (progress, cancelled) => {
        // Bilder nur einmal je Stand erzeugen (bei Teilen für alle Teile dieselben)
        let img = imgCache.current && imgCache.current.token === tk ? imgCache.current : null;
        if (!img) {
          // erst die Anzeige („wird erzeugt …“, Abbrechen) zeichnen lassen – das Vorschaubild blockiert kurz
          await new Promise((r) => setTimeout(r, 0));
          const prev = renderFull(c.layout, c.data, rec.palette, PREVIEW_PX, { groutHex: rec.settings.groutHex, realistic: true, surface: rec.settings.surface });
          const preview: PdfImage = { dataUrl: await canvasToJpeg(prev, 0.9), w: prev.width, h: prev.height };
          let original: PdfImage | undefined;
          // Foto seit der Berechnung ersetzt: kein „Originalfoto“ (es gehörte nicht zu diesem Mosaik)
          const oc = photoReplaced ? null : api.originalPreview(ORIGINAL_PX);
          if (oc) original = { dataUrl: await canvasToJpeg(oc, 0.88), w: oc.width, h: oc.height };
          img = { token: tk, preview, original };
          imgCache.current = img;
        }
        if (cancelled()) throw new Error(CANCELLED);
        const res = await runWorker<'pdf'>(
          'pdf',
          { type: 'pdf', ...baseRequest(), original: img.original, preview: img.preview, options: { ...opts, sectionIds: ids }, part: part ?? undefined },
          [],
          (phase, f) => progress(f, phase),
        );
        // echte Seitenzahl und Aufteilung (vom Generator gezählt) mit der Datei speichern
        return { pdf: res.pdf, report: { pages: res.pages, breakdown: res.breakdown, planMatches: res.planMatches } };
      },
    });
  };
  const startSingle = () => start('single', sel, null, partsPlan.totalBytes, totalStones);
  const startPart = (p: ExportPart) => start(`part-${p.index}`, p.ids, { index: p.index, total: partsPlan.parts.length }, p.bytes, p.stones);
  const locked = !!busy || otherBusy;
  const goStep = (step: 'compute' | 'plan') => {
    location.hash = stepHash(projectId, step);
  };

  // ---------------------------------------------------------------- Inhalt mit Seitenzahlen
  const imagePages = (opts.includeImages && hasOriginal ? 1 : 0) + (opts.includeImages ? 1 : 0);
  const items: ContentItem[] = [
    { key: 'front', label: t('w5pe.c.front'), pages: known('front') ? src.front - imagePages : null, off: false },
    {
      key: 'original',
      label: t('w5pe.c.original'),
      pages: opts.includeImages && hasOriginal ? 1 : 0,
      off: !(opts.includeImages && hasOriginal),
      note: !opts.includeImages ? undefined : photoReplaced ? t('w5pe.c.originalReplaced') : !bitmap ? t('w5pe.c.originalMissing') : undefined,
    },
    { key: 'preview', label: t('w5pe.c.preview'), pages: opts.includeImages ? 1 : 0, off: !opts.includeImages },
    { key: 'sections', label: t('w5pe.c.sections'), pages: known('sectionCovers', 'sectionSummaries') ? src.sectionPages : null, off: false },
    { key: 'sheets', label: t('w5pe.c.sheets'), pages: src.sheets, off: false },
    ...(known('sheetLegends') && src.sheetLegends > 0 ? [{ key: 'sheetLegends', label: t('w5pe.c.sheetLegends'), pages: src.sheetLegends, off: false }] : []),
    {
      key: 'codePlans',
      label: t('w5pe.c.codePlans'),
      pages: opts.codePlan === 'off' ? 0 : known('codePlans') ? src.codePlans : null,
      off: opts.codePlan === 'off',
      note: opts.codePlan !== 'off' && known('codePlans') && src.codePlans === 0 ? t('w5pe.c.codeNone') : undefined,
    },
    {
      key: 'cutLists',
      label: t('w5pe.c.cutLists'),
      pages: known('cutLists') ? src.cutLists : null,
      off: false,
      note: known('cutLists') && src.cutLists === 0 ? t('w5pe.c.cutNone') : undefined,
    },
    { key: 'templates', label: t('w5pe.c.templates'), pages: !opts.includeTemplates ? 0 : known('templates') ? src.templates : null, off: !opts.includeTemplates },
    {
      key: 'coords',
      label: t(coordMode === 'perStone' ? 'w5pe.c.coords.perStone' : coordMode === 'compact' ? 'w5pe.c.coords.compact' : 'w5pe.c.coords.off'),
      pages: coordMode === 'off' ? 0 : known('coords') ? src.coords : null,
      off: coordMode === 'off',
    },
  ];
  const pagesOf = (key: string) => items.find((i) => i.key === key)?.pages ?? null;
  /** Seiten dieses Teils neben dem Schalter (ohne den Schalter können sich auch andere Teile ändern – es zählt die Gesamtzahl) */
  const pagesHint = (key: string, on: boolean) => {
    const p = pagesOf(key);
    return on && p !== null && p > 0 ? tCount(t, 'w5pe.plan.total', p, { n: n(p) }) : undefined;
  };

  // ---------------------------------------------------------------- Teile
  const parts = partsPlan.parts;
  const nextPart = parts.find((p) => !fileOf(`part-${p.index}`) && !p.ids.some((id) => tooBig.has(id)));
  const partsDone = parts.filter((p) => fileOf(`part-${p.index}`)).length;
  const busyPart = busy && busy.key.startsWith('part-') ? Number(busy.key.slice(5)) : null;
  const single = fileOf('single');

  // ---------------------------------------------------------------- Hauptaktion oben und in der Leiste unten (statt „Weiter“)
  const actionRef = useRef<() => void>(() => {});
  const runAction = useCallback(() => actionRef.current(), []);
  const action = ((): { label: string; disabled: boolean; kind: string; title?: string; run: () => void } => {
    const none = () => {};
    if (busy) return { label: t('w5fp.action.busy', { pct: Math.round(busy.f * 100) }), disabled: true, kind: 'busy', run: none };
    if (otherBusy) return { label: t('w5fp.action.otherBusy'), disabled: true, kind: 'other', run: none };
    const title = blocked ? t('w5fp.action.blocked') : undefined;
    if (!inParts || singleAnyway) return { label: plan ? t('w5fp.action.generate', { n: n(plan.total) }) : t('pdfui.generate'), disabled: blocked, kind: 'single', title, run: startSingle };
    if (nextPart) {
      const pp = partPlans[nextPart.index];
      const k = nextPart.index + 1;
      return { label: pp ? t('w5fp.action.part', { k, n: parts.length, p: n(pp.total) }) : t('w5pe.parts.next', { k, n: parts.length }), disabled: blocked, kind: 'part', title, run: () => startPart(nextPart) };
    }
    return { label: t('w5fp.action.allDone'), disabled: true, kind: 'done', run: none };
  })();
  actionRef.current = action.run;
  useEffect(() => {
    setStepAction({ step: 'pdf', label: action.label, disabled: action.disabled, title: action.title, kind: action.kind, run: runAction });
  });
  useEffect(() => () => clearStepAction('pdf'), []);

  /** Seitenzahl der Schätzung vorab für eine fertige Datei (einzelne Datei bzw. gemessener Teil) */
  const estimateOf = (f: PdfFile): number | null => {
    if (f.key === 'single') return plan ? plan.total : null;
    const i = Number(f.key.slice(5));
    return partFacts[i] && partPlans[i] ? partPlans[i].total : null;
  };
  /** Aufteilung der echten Seitenzahl, z. B. „Verlegeblätter: 16 · Schnittvorlagen: 13 · Koordinaten: 8“ */
  const breakdownText = (bd: PdfBreakdown) =>
    (
      [
        ['w6pf.bd.front', bd.front],
        ['w6pf.bd.sections', bd.sectionCovers + bd.sectionSummaries],
        ['w6pf.bd.sheets', bd.sheets],
        ['w6pf.bd.sheetLegends', bd.sheetLegends],
        ['w6pf.bd.codePlans', bd.codePlans],
        ['w6pf.bd.cutLists', bd.cutLists],
        ['w6pf.bd.templates', bd.templates],
        ['w6pf.bd.coords', bd.coords],
      ] as const
    )
      .filter(([, v]) => v > 0)
      .map(([key, v]) => t('w6pf.bd.entry', { label: t(key), n: n(v) }))
      .join(' · ');
  const fileLine = (f: PdfFile, testId?: string) => {
    const r = f.report;
    const est = r ? estimateOf(f) : null;
    return (
      <div className="w5pe-file" data-testid={testId} data-name={f.name} data-pages={r ? r.pages : ''} data-estimate={est ?? ''} data-plan-matches={r ? (r.planMatches ? 'yes' : 'no') : ''}>
        <p>
          ✓ {r ? t('w6pf.done', { size: fmtBytes(f.size), pages: tCount(t, 'w5pe.pagesExact', r.pages, { n: n(r.pages) }) }) : t('w5pe.done', { size: fmtBytes(f.size) })}
          {r && est !== null && <small className="muted"> ({est === r.pages ? t('w6pf.done.same') : t('w6pf.done.differs', { n: n(est) })})</small>}
        </p>
        {r && (
          <p className="muted small" data-testid="pdf-done-breakdown">
            {breakdownText(r.breakdown)}
          </p>
        )}
        {f.url && (
          <div className="btn-row wrap">
            <a className="btn small" style={{ textDecoration: 'none' }} href={f.url} target="_blank" rel="noreferrer" data-testid="pdf-open">
              {t('pdfui.open')}
            </a>
            <a className="btn small" style={{ textDecoration: 'none' }} href={f.url} download={f.name} data-testid="pdf-download">
              {t('w5pe.download')}
            </a>
          </div>
        )}
        <SaveResultNote result={f.save} testId="pdf-save-note" />
      </div>
    );
  };

  return (
    <div className="two-col w5pe" data-testid="pdf-step">
      {/* während ein Export läuft, bleiben die Optionen stehen – die fertige Datei gehört zu genau diesen Angaben */}
      <fieldset className="w5pe-options" disabled={locked}>
        {/* Hauptaktion gleich oben (auf schmalen Bildschirmen zusätzlich in der Leiste unten, siehe Workspace.tsx) */}
        <div className="btn-row wrap w5pe-top" data-testid="pdf-top" style={{ marginBottom: 14, alignItems: 'center' }}>
          <button type="button" className="btn primary" disabled={action.disabled} onClick={runAction} title={action.title} data-testid="pdf-top-action" data-kind={action.kind}>
            {action.label}
          </button>
          {action.title && <small className="muted">{action.title}</small>}
        </div>
        <Field label={t('pdfui.format')}>
          <Segmented
            value={opts.format}
            options={[
              { value: 'a4', label: 'A4' },
              { value: 'a3', label: 'A3' },
              { value: 'a2', label: 'A2' },
              { value: 'a1', label: 'A1' },
              { value: 'a0', label: 'A0' },
              { value: 'custom', label: t('pdfui.custom') },
            ]}
            onChange={(v) => setOpts({ format: v })}
          />
        </Field>
        {opts.format === 'custom' && (
          <div className="btn-row">
            <NumberInput value={opts.customW ?? 210} onChange={(v) => setOpts({ customW: v })} min={100} max={5000} suffix="mm" label={t('size.width')} />
            ×
            <NumberInput value={opts.customH ?? 297} onChange={(v) => setOpts({ customH: v })} min={100} max={5000} suffix="mm" label={t('size.height')} />
          </div>
        )}
        <Field label={t('pdfui.orientation')}>
          <Segmented
            value={opts.orientation}
            options={[
              { value: 'portrait', label: t('pdfui.portrait') },
              { value: 'landscape', label: t('pdfui.landscape') },
            ]}
            onChange={(v) => setOpts({ orientation: v })}
          />
        </Field>
        <Field label={t('pdfui.scale')} hint={t('pdfui.scaleHint')}>
          <Segmented
            value={opts.sheetScale}
            options={[
              { value: 1, label: '1:1' },
              { value: 2, label: '2:1' },
              { value: 3, label: '3:1' },
              { value: 4, label: '4:1' },
              {
                value: 0,
                label: (
                  <>
                    {t('pdfui.fit')}{' '}
                    <small className="w5pe-fit-scale" data-testid="pdf-fit-scale">
                      ({fmtScale(fitScale, lang)})
                    </small>
                  </>
                ),
              },
            ]}
            onChange={(v) => setOpts({ sheetScale: v })}
          />
          {opts.sheetScale <= 0 && (
            <p className="muted small w5pe-fit-note" data-testid="pdf-fit-note">
              {t('w5pe.fitNote', { scale: fmtScale(fitScale, lang) })}
            </p>
          )}
        </Field>
        {tooSmallCodes && <Badge kind="warn">{t('pdfui.codesTooSmall')}</Badge>}
        {opts.codePlan === 'off' && codeless && <Badge kind="warn">{t('pdf.w4.codesOffWarn')}</Badge>}
        {codesIncomplete && (
          <p className="w5pe-box warn small" data-testid="pdf-codes-incomplete">
            {t('w4fx.pdf.codesIncomplete', { k: CODE_PLAN_WHOLE_MAX_K })}
          </p>
        )}
        <Field label={t('w5pe.codePlan')} hint={t('w5pe.codePlanHint')}>
          <Segmented<CodePlanMode>
            value={opts.codePlan ?? 'auto'}
            options={[
              { value: 'auto', label: t('w5pe.codePlan.auto') },
              { value: 'always', label: t('w5pe.codePlan.always') },
              { value: 'off', label: t('w5pe.codePlan.off') },
            ]}
            onChange={(v) => setOpts({ codePlan: v })}
            testId="pdf-codeplan"
          />
        </Field>
        <Field label={t('pdfui.sections')}>
          {selectionDropped && (
            <p className="w5pe-box warn small" data-testid="pdf-selection-dropped">
              {t('w5pe.pick.dropped')}
            </p>
          )}
          <SectionPicker grid={G} selected={sel} onChange={(ids) => setOpts({ sectionIds: ids })} progress={perSection} disabled={locked} />
        </Field>
        <Toggle checked={opts.includeImages} onChange={(v) => setOpts({ includeImages: v })} label={t('pdfui.images')} hint={opts.includeImages && imagePages > 0 ? tCount(t, 'w5pe.pagesExact', imagePages, { n: imagePages }) : undefined} />
        <Toggle checked={opts.includeTemplates} onChange={(v) => setOpts({ includeTemplates: v })} label={t('pdfui.templates')} hint={pagesHint('templates', opts.includeTemplates)} />
        <Toggle
          checked={opts.includeCoords}
          onChange={(v) => setOpts({ includeCoords: v, ...(v && opts.coordMode === 'off' ? { coordMode: 'compact' as const } : {}) })}
          label={t('pdfui.coords')}
          hint={
            coordMode !== 'off'
              ? pagesHint('coords', true)
              : coordAlt
                ? t('w6pf.coordOffHint', { compact: coordPagesLabel('compact') ?? '', perStone: coordPagesLabel('perStone') ?? '' })
                : undefined
          }
        />
        {opts.includeCoords && (
          <div className="w5pe-sub" data-testid="pdf-coord-modes" data-compact={coordAlt ? coordAlt.compact : ''} data-per-stone={coordAlt ? coordAlt.perStone : ''}>
            <Segmented<'compact' | 'perStone'>
              value={coordMode === 'perStone' ? 'perStone' : 'compact'}
              options={(['compact', 'perStone'] as const).map((m) => {
                const pg = coordPagesLabel(m);
                return {
                  value: m,
                  label: (
                    <>
                      {t(m === 'compact' ? 'w5pe.coordMode.compact' : 'w5pe.coordMode.perStone')}
                      {pg && (
                        <small className="w5pe-fit-scale" data-testid={`pdf-coord-pages-${m}`}>
                          {' '}
                          · {pg}
                        </small>
                      )}
                    </>
                  ),
                };
              })}
              onChange={(v) => setOpts({ coordMode: v })}
              testId="pdf-coordmode"
            />
            {coordMode === 'perStone' && (
              <Field label={t('pdfui.coordLimit')}>
                <NumberInput value={opts.coordLimit} onChange={(v) => setOpts({ coordLimit: Math.round(v) })} min={0} max={2_000_000} width={90} />
              </Field>
            )}
            <p className="field-hint">{t(coordMode === 'perStone' ? 'w5pe.coordHint.perStone' : 'pdfui.coordHint')}</p>
          </div>
        )}
      </fieldset>

      <div>
        {crash && (
          <div className="w5pe-box danger" role="alert" data-testid="pdf-crash-note">
            <p>
              <b>{t('w5pe.crash.title')}</b>
            </p>
            <p className="small">{t('w5pe.crash.text', { name: crash.info.projectName, stones: n(crash.info.stones), need: fmtBytes(crash.info.bytes) })}</p>
            {crash.loweredToBytes !== null && <p className="small">{t('w5pe.crash.lowered', { limit: fmtBytes(crash.loweredToBytes) })}</p>}
            <button type="button" className="btn small" onClick={dismissCrashNotice} data-testid="pdf-crash-dismiss">
              {t('w5pe.crash.dismiss')}
            </button>
          </div>
        )}
        {(api.stale || photoReplaced) && (
          <div className="w5pe-box warn" data-testid="pdf-stale">
            <p>
              <Badge kind="warn">{t('project.stale')}</Badge> <b>{t('w5pe.stale.title')}</b>
            </p>
            <p className="small">
              {reasonText ? `${t('w2ws.stale.lead', { list: reasonText })} ` : ''}
              {t('w5pe.stale.text')}
            </p>
            {photoReplaced && (
              <p className="small" data-testid="pdf-photo-replaced">
                {t('w5pe.stale.photo')}
              </p>
            )}
            <div className="btn-row wrap">
              <button type="button" className="btn small primary" onClick={() => goStep('compute')} data-testid="pdf-stale-recompute">
                {t('w5pe.stale.recompute')}
              </button>
              {api.stale && (
                <label className="w5pe-confirm">
                  <input type="checkbox" checked={confirmStale} onChange={(e) => setConfirmStale(e.target.checked)} data-testid="pdf-stale-confirm" />
                  <span>{t('w5pe.stale.confirm')}</span>
                </label>
              )}
            </div>
          </div>
        )}

        <h3>{t('pdfui.contents')}</h3>
        <ul className="w5pe-contents" data-testid="pdf-contents">
          {items.map((it) => (
            <li key={it.key} className={it.off ? 'off' : ''} data-part={it.key} data-off={it.off ? 'yes' : 'no'} data-pages={it.pages === null ? '' : it.pages}>
              <span className="w5pe-c-label">
                <span className="w5pe-c-name">{it.label}</span>
                {(it.off || it.note) && <small className="muted"> – {it.note ?? t('w5pe.c.off')}</small>}
              </span>
              <span className="w5pe-c-pages">{it.off ? '–' : it.pages === null ? '…' : it.pages === 0 ? '–' : t('w5pe.pages', { n: n(it.pages) })}</span>
            </li>
          ))}
        </ul>
        <div className="w5pe-total" data-testid="pdf-plan" data-state={measured.status} data-total={plan ? plan.total : ''} data-sheets={src.sheets} data-ms={measured.ms ?? ''}>
          {plan ? (
            <p className="w5pe-total-line">
              <b data-testid="pdf-total">{tCount(t, 'w5pe.plan.total', plan.total, { n: n(plan.total) })}</b>
              {plan.total > MANY_PAGES && <Badge kind="warn">{t('pdfui.many')}</Badge>}
            </p>
          ) : measured.status === 'failed' ? (
            <p className="w5pe-box warn small" data-testid="pdf-plan-failed">
              {t('w5pe.plan.failed', { msg: measured.error ?? '?' })}
            </p>
          ) : (
            <p className="w5pe-total-line muted" role="status">
              <span className="w5pe-spinner" aria-hidden="true" /> {t('w5pe.plan.measuring')}
            </p>
          )}
          <p className="muted small">
            {t('w5pe.plan.sub', { s: n(selCount), p: n(src.sheets), scale: fmtScale(effScale, lang) })}
            {plan ? ` · ${t('w5pe.plan.note')}` : ''}
          </p>
          {inParts && !singleAnyway && partPlans.length > 1 && (
            <p className="small" data-testid="pdf-parts-total" data-total={partsPages}>
              {t('w5fp.parts.total', { n: partPlans.length, pages: n(partsPages) })}
            </p>
          )}
        </div>
        <p className="muted small">{t('pdfui.printHint')}</p>

        {otherBusy && (
          <div className="w5pe-box info" data-testid="pdf-other-busy">
            <p className="small">{t('w5pe.otherBusy')}</p>
            <button type="button" className="btn small" onClick={cancelPdfJob}>
              {t('w5pe.otherCancel')}
            </button>
          </div>
        )}

        {!inParts || singleAnyway ? (
          <div className="w5pe-actions">
            {inParts && singleAnyway && (
              <p className="w5pe-box warn small" data-testid="pdf-single-warning">
                {t('w5pe.single.anywayText')}{' '}
                <button type="button" className="link w5pe-link" onClick={() => setSingleAnyway(false)} disabled={locked}>
                  {t('w5pe.single.back')}
                </button>
              </p>
            )}
            <button className="btn primary big" disabled={locked || blocked} onClick={startSingle} data-testid="pdf-btn">
              {busy && busy.key === 'single' ? t('w5pe.generating') : t('pdfui.generate')}
            </button>
          </div>
        ) : (
          <div className="w5pe-box w5pe-parts" data-testid="pdf-parts" data-parts={parts.length} data-done={partsDone}>
            <p>
              <b>{parts.length > 1 ? t('w5pe.parts.title', { n: parts.length }) : t('w5pe.parts.titleTooBig')}</b>
            </p>
            <p className="small">
              {t('w5pe.parts.why', { need: fmtBytes(partsPlan.totalBytes), limit: fmtBytes(budget.bytes) })} {parts.length > 1 ? t('w5pe.parts.what', { n: parts.length }) : ''}
            </p>
            {partsPlan.tooBig.length > 0 && (
              <div className="w5pe-box warn small" data-testid="pdf-too-big">
                <p>{t('w5pe.parts.tooBig', { ids: rangeOf(partsPlan.tooBig) })}</p>
                <button type="button" className="btn small" onClick={() => goStep('plan')}>
                  {t('w5pe.parts.toPlan')}
                </button>
              </div>
            )}
            <ol className="w5pe-part-list">
              {parts.map((p, i) => {
                const f = fileOf(`part-${p.index}`);
                const big = p.ids.some((id) => tooBig.has(id));
                const pp = partPlans[i];
                return (
                  <li
                    key={p.index}
                    className={f ? 'done' : ''}
                    data-testid="pdf-part"
                    data-part={p.index + 1}
                    data-sections={p.ids.join(',')}
                    data-done={f ? 'yes' : 'no'}
                    data-pages={pp ? pp.total : ''}
                    data-measured={partFacts[i] ? 'yes' : 'no'}
                  >
                    <div className="w5pe-part-head">
                      <span className="w5pe-part-name">
                        <b>{t('w5pe.parts.part', { k: p.index + 1, n: parts.length })}</b> · {tCount(t, 'w5pe.parts.sections', p.ids.length, { range: rangeOf(p.ids), count: n(p.ids.length) })}
                        <small className="muted">
                          {' '}
                          · {pp ? `${tCount(t, 'w5pe.plan.total', pp.total, { n: n(pp.total) })} · ` : ''}
                          {t('w5pe.parts.mem', { need: fmtBytes(p.bytes) })}
                        </small>
                        {big && (
                          <>
                            {' '}
                            <Badge kind="warn">{t('w5pe.parts.tooBigBadge')}</Badge>
                          </>
                        )}
                      </span>
                      <button type="button" className="btn small" disabled={locked || blocked} onClick={() => startPart(p)} data-testid="pdf-part-btn">
                        {busyPart === p.index ? t('w5pe.generating') : f ? t('w5pe.parts.again') : big ? t('w5pe.parts.tryAnyway') : t('w5pe.parts.make')}
                      </button>
                    </div>
                    {f && fileLine(f, 'pdf-part-file')}
                  </li>
                );
              })}
            </ol>
            {nextPart ? (
              <button className="btn primary big" disabled={locked || blocked} onClick={() => startPart(nextPart)} data-testid="pdf-part-next">
                {busyPart !== null ? t('w5pe.generatingPart', { k: busyPart + 1, n: parts.length }) : t('w5pe.parts.next', { k: nextPart.index + 1, n: parts.length })}
              </button>
            ) : (
              partsDone === parts.length && (
                <p className="ok" data-testid="pdf-parts-done">
                  ✓ {t('w5pe.parts.allDone', { n: parts.length })}
                </p>
              )
            )}
            <p className="muted small" data-testid="pdf-budget" data-budget-mb={Math.round((budget.bytes / MIB) * 100) / 100} data-source={budget.source}>
              {t(`w5pe.mem.src.${budget.source}`, { limit: fmtBytes(budget.bytes) })}{' '}
              {budget.source === 'override' && (
                <button
                  type="button"
                  className="link w5pe-link"
                  disabled={locked}
                  onClick={() => {
                    writeBudgetOverride(localStore(), null);
                    setBudgetRev((v) => v + 1);
                  }}
                  data-testid="pdf-budget-reset"
                >
                  {t('w5pe.mem.reset')}
                </button>
              )}
            </p>
            <details className="w5pe-anyway">
              <summary>{t('w5pe.single.anywayTitle')}</summary>
              <p className="small">{t('w5pe.single.anywayText')}</p>
              <button type="button" className="btn small" disabled={locked} onClick={() => setSingleAnyway(true)} data-testid="pdf-single-anyway">
                {t('w5pe.single.anywayBtn')}
              </button>
            </details>
          </div>
        )}
        {blocked && (
          <p className="warn small" data-testid="pdf-need-confirm">
            {t('w5pe.stale.need')}
          </p>
        )}

        {busy && (
          <div className="w5pe-busy" data-testid="pdf-busy">
            <ProgressBar value={busy.f} label={`${Math.round(busy.f * 100)} %`} />
            <button type="button" className="btn small" onClick={cancelPdfJob} data-testid="pdf-cancel">
              {t('common.cancel')}
            </button>
          </div>
        )}
        {job.error && (
          <p className="error" data-testid="pdf-error">
            {job.error}
          </p>
        )}
        {job.cancelled && !busy && (
          <p className="muted" role="status" data-testid="pdf-cancelled">
            {t('w5pe.cancelled')}{' '}
            <button type="button" className="link w5pe-link" onClick={() => clearPdfMessages(projectId)}>
              {t('common.close')}
            </button>
          </p>
        )}
        {single && (!inParts || singleAnyway) && fileLine(single, 'pdf-done')}
      </div>
    </div>
  );
}
