import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { regionCellSpan } from '../../core/layout';
import type { Region } from '../../core/types';
import { uid } from '../../storage/db';
import { tCount, useI18n } from '../../i18n';
import { Badge, Segmented } from '../components';
import '../css/w3-face-guidance.css';
import '../css/w4-face-detector.css';
import { faceLight, faceRegionsOf, MIN_REGION_PX, regionLargeEnough, startsDrawing } from './faceGuidance';
import { suggestFaces } from './faceDetectClient';
import {
  cornerOf,
  coveredByRegion,
  MIN_EDIT_FRAC,
  moveRect,
  nudgeRect,
  regionAt,
  regionOrigin,
  resizeRect,
  suggestionRegions,
  type DetectSource,
  type FaceSuggestion,
  type Handle,
  type Rect,
  type RegionWithOrigin,
} from './faceSuggest';
import { renderCropped } from './imagePrep';
import { staleReasons } from './staleReasons';
import { stepHash } from './stepNav';
import { computeKey, type ProjectApi } from './useProject';

/** Zustand der automatischen Gesichtssuche für ein Editorbild (nur im Speicher, nie gespeichert). */
interface DetectView {
  status: 'idle' | 'running' | 'found' | 'none' | 'covered' | 'error' | 'done';
  source: DetectSource | null;
  /** offene Vorschläge (weder übernommen noch verworfen) */
  suggestions: FaceSuggestion[];
}
const IDLE: DetectView = { status: 'idle', source: null, suggestions: [] };

/**
 * Ergebnis der Suche je Editorbild (Projekt, Foto, Zuschnitt, Bildeinstellungen, Seitenverhältnis) für diese
 * Sitzung: Die automatische Suche läuft je Bild nur einmal, und verworfene Vorschläge kommen beim erneuten Öffnen
 * des Schritts nicht wieder. Nie gespeichert – Vorschläge werden erst durch „Übernehmen“ zu Bereichen.
 */
const memo = new Map<string, DetectView>();
function remember(key: string, v: DetectView) {
  memo.delete(key);
  memo.set(key, v);
  while (memo.size > 16) memo.delete(memo.keys().next().value!);
}
const bitmapIds = new WeakMap<object, number>();
let nextBitmapId = 1;
function bitmapId(b: object): number {
  let id = bitmapIds.get(b);
  if (!id) bitmapIds.set(b, (id = nextBitmapId++));
  return id;
}

const HANDLES: Handle[] = ['nw', 'ne', 'sw', 'se'];
const letter = (i: number) => String.fromCharCode(65 + (i % 26));
const pct = (r: Rect) => ({ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
/** Bewegung bis zu dieser Strecke (CSS-Pixel) gilt als Tippen/Klicken, nicht als Ziehen */
const TAP_PX = 6;

/**
 * Gesichts- und Detailbereiche auf dem Foto markieren.
 *
 * - Maus und Stift zeichnen direkt. Ein Finger zeichnet nur nach „Bereich zeichnen“ (touch-action: none);
 *   sonst bleibt das Bild wischbar (pan-y pinch-zoom), damit ein Wischen zum Scrollen keinen Bereich anlegt.
 *   Nach einem gezeichneten Bereich schaltet der Zeichenmodus wieder ab.
 * - pointercancel / lostpointercapture brechen ohne Speichern ab; Bereiche unter 24 px je Seite werden verworfen.
 * - Jeder Bereich trägt seine Nummer (wie in der Liste); Gesichter zeigen, wie viele Steine sie überspannen.
 * - Gesichtsvorschläge (w4-face-detector): beim Öffnen ohne Bereiche einmal automatisch, sonst über
 *   „Gesichter erkennen“ – zuerst FaceDetector des Browsers, sonst die mitgelieferte Offline-Erkennung (pico.js).
 *   Vorschläge sind gestrichelt und werden erst mit „Übernehmen“ zu Bereichen (Gesicht + geschätzte Augenpartie).
 * - Ein Bereich wird durch Antippen/Anklicken (oder „Anpassen“ in der Liste) ausgewählt und lässt sich dann
 *   verschieben und an den Ecken in der Größe ändern (Griffe mit 44 px Trefferfläche, auch per Tastatur).
 */
export function RegionEditor({ api }: { api: ProjectApi }) {
  const { t, n } = useI18n();
  const { bitmap, effectiveCrop, layout } = api;
  const rec = api.rec!;
  const regions = rec.regions;
  const [mode, setMode] = useState<Region['type']>('face');
  const [shape, setShape] = useState<Region['shape']>('ellipse');
  const [draft, setDraft] = useState<Region | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: 'info' | 'warn' } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Bereich während des Verschiebens/Größe-Änderns (erst beim Loslassen gespeichert) */
  const [edit, setEdit] = useState<{ id: string; rect: Rect } | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  const regionsRef = useRef(regions);
  regionsRef.current = regions;
  const cleanupRef = useRef<(() => void) | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Bild nur neu zeichnen, wenn sich Foto, Zuschnitt, Bildeinstellungen oder das Seitenverhältnis ändern –
  // nicht bei jedem neuen Bereich (sonst flackert das Bild bei jeder Änderung)
  const aspect = layout ? layout.finishedW / layout.finishedH : null;
  const adjust = rec.adjust;
  const img = useMemo(() => {
    if (!bitmap || !effectiveCrop || !aspect) return null;
    const tw = aspect >= 1 ? 640 : Math.round(640 * aspect);
    return renderCropped(bitmap, adjust, effectiveCrop, tw, Math.round(tw / aspect));
  }, [bitmap, effectiveCrop, aspect, adjust]);
  useEffect(() => {
    const h = holder.current;
    if (!h || !img) return;
    h.querySelector('canvas')?.remove();
    img.style.width = '100%';
    img.style.display = 'block';
    img.setAttribute('aria-hidden', 'true');
    h.prepend(img);
  }, [img]);
  // laufende Geste beim Verlassen beenden (Listener nicht liegen lassen)
  useEffect(() => () => cleanupRef.current?.(), []);

  // ---------- Gesichtsvorschläge
  const imgKey = useMemo(
    () => (img && bitmap ? `${rec.meta.id}|${rec.imageRev ?? `b${bitmapId(bitmap)}`}|${JSON.stringify(effectiveCrop)}|${JSON.stringify(adjust)}|${aspect}` : null),
    [img, bitmap, rec.meta.id, rec.imageRev, effectiveCrop, adjust, aspect],
  );
  const [det, setDet] = useState<DetectView>(() => (imgKey && memo.get(imgKey)) || IDLE);
  const reqRef = useRef(0);
  const keyRef = useRef(imgKey);
  keyRef.current = imgKey;
  const setDetFor = (key: string, v: DetectView) => {
    remember(key, v);
    if (keyRef.current === key) setDet(v);
  };
  const runDetect = async (key: string, canvas: HTMLCanvasElement) => {
    const my = ++reqRef.current;
    setDetFor(key, { status: 'running', source: null, suggestions: [] });
    const out = await suggestFaces(canvas, uid);
    if (!mounted.current || my !== reqRef.current) {
      // überholt (neues Bild oder erneute Suche) – nichts anzeigen; ein späterer Aufruf läuft frisch
      if (memo.get(key)?.status === 'running') memo.delete(key);
      return;
    }
    if (out.kind === 'error') {
      setDetFor(key, { status: 'error', source: null, suggestions: [] });
      return;
    }
    const fresh = out.suggestions.filter((s) => !coveredByRegion(s, regionsRef.current));
    setDetFor(key, { status: fresh.length ? 'found' : out.suggestions.length ? 'covered' : 'none', source: out.source, suggestions: fresh });
  };
  // beim Öffnen (bzw. neuem Bild) ohne Bereiche einmal automatisch suchen
  useEffect(() => {
    if (!imgKey || !img) return;
    const known = memo.get(imgKey);
    if (known && known.status !== 'running') {
      setDet(known);
      return;
    }
    if (regionsRef.current.length === 0) void runDetect(imgKey, img);
    else setDet(IDLE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgKey]);

  // Bereiche seit der letzten Berechnung geändert? (nur dann der Hinweis hier – die übrigen Gründe zeigt Schritt 7)
  const regionsChanged = useMemo(() => {
    if (!api.computed || !rec.computedWith) return false;
    try {
      return staleReasons(rec.computedWith, computeKey(rec)).some((r) => r.group === 'regions');
    } catch {
      return false;
    }
  }, [api.computed, rec]);

  // Auswahl aufheben, wenn der Bereich nicht mehr existiert
  useEffect(() => {
    if (selectedId && !regions.some((r) => r.id === selectedId)) setSelectedId(null);
  }, [regions, selectedId]);
  // Auswahl auf dem Bild: Fokus auf den Bereich (Pfeiltasten wirken sofort); Esc hebt die Auswahl überall auf
  const focusSel = useRef(false);
  useEffect(() => {
    if (!selectedId) return;
    if (focusSel.current) holder.current?.querySelector<HTMLElement>('.w4fd-sel')?.focus({ preventScroll: true });
    focusSel.current = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedId]);

  if (!img) return <p className="muted">{t('shapes.noPhoto')}</p>;

  const toNorm = (clientX: number, clientY: number, r: DOMRect): [number, number] => [Math.min(1, Math.max(0, (clientX - r.left) / r.width)), Math.min(1, Math.max(0, (clientY - r.top) / r.height))];
  /** Tippen/Klicken auf das Bild: Bereich darunter auswählen (oder Auswahl aufheben). true = ein Bereich getroffen */
  const selectAt = (x: number, y: number): boolean => {
    const hit = regionAt(regionsRef.current, x, y);
    focusSel.current = !!hit;
    setSelectedId(hit ? hit.id : null);
    return !!hit;
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!startsDrawing(e, drawingRef.current)) {
      // Finger ohne Zeichenmodus: Antippen wählt einen Bereich aus; Wischen scrollt (pointercancel)
      if (e.isPrimary && e.pointerType === 'touch') watchTap(e);
      return;
    }
    cleanupRef.current?.();
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const [x0, y0] = toNorm(e.clientX, e.clientY, r);
    const sx = e.clientX;
    const sy = e.clientY;
    const pointerId = e.pointerId;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      /* Zeiger schon weg */
    }
    if (e.pointerType === 'mouse') e.preventDefault(); // keine Textauswahl beim Ziehen
    let cur: Region = { id: uid(), type: mode, shape, x: x0, y: y0, w: 0, h: 0 };
    let moved = false;
    let done = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (Math.abs(ev.clientX - sx) > TAP_PX || Math.abs(ev.clientY - sy) > TAP_PX) moved = true;
      const [x1, y1] = toNorm(ev.clientX, ev.clientY, r);
      cur = { ...cur, x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      setDraft(cur);
    };
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('lostpointercapture', cancel);
      try {
        if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
      } catch {
        /* schon freigegeben */
      }
      if (cleanupRef.current === abort) cleanupRef.current = null;
      setDraft(null);
      if (!commit) return;
      if (regionLargeEnough(cur, r.width, r.height)) {
        const next = [...regionsRef.current, cur];
        api.setRegions(next);
        setSelectedId(null);
        setMsg({ text: t('w3fg.added', { n: next.length }), kind: 'info' });
        setDrawing(false); // nächster Fingerwisch scrollt wieder
      } else if (!moved && selectAt(x0, y0)) {
        // Klick/Tippen auf einen Bereich: auswählen statt „zu klein“
      } else if (cur.w > 0 || cur.h > 0 || drawingRef.current) {
        setMsg({ text: t('w3fg.tooSmall', { px: MIN_REGION_PX }), kind: 'warn' });
      }
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(true);
    };
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || done) return;
      finish(false);
      setMsg({ text: t('w3fg.cancelled'), kind: 'warn' });
    };
    const abort = () => finish(false);
    cleanupRef.current = abort;
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('lostpointercapture', cancel);
  };

  /** Finger ohne Zeichenmodus: kurzes Antippen ohne Bewegung wählt den Bereich darunter aus. */
  const watchTap = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const id = e.pointerId;
    const sx = e.clientX;
    const sy = e.clientY;
    const t0 = performance.now();
    const off = () => {
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', off);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== id) return;
      off();
      if (Math.abs(ev.clientX - sx) <= TAP_PX && Math.abs(ev.clientY - sy) <= TAP_PX && performance.now() - t0 < 800) {
        const [x, y] = toNorm(ev.clientX, ev.clientY, el.getBoundingClientRect());
        selectAt(x, y);
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', off);
  };

  /** Ausgewählten Bereich verschieben ('move') oder an einer Ecke in der Größe ändern. */
  const startEdit = (e: React.PointerEvent<HTMLElement>, region: Region, what: 'move' | Handle) => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.stopPropagation();
    e.preventDefault();
    cleanupRef.current?.();
    const hEl = holder.current;
    if (!hEl) return;
    const box = hEl.getBoundingClientRect();
    const el = e.currentTarget;
    const pointerId = e.pointerId;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      /* Zeiger schon weg */
    }
    const base: Rect = { x: region.x, y: region.y, w: region.w, h: region.h };
    const minW = Math.max(MIN_EDIT_FRAC, MIN_REGION_PX / box.width);
    const minH = Math.max(MIN_EDIT_FRAC, MIN_REGION_PX / box.height);
    const corner = what === 'move' ? null : cornerOf(base, what);
    const sx = e.clientX;
    const sy = e.clientY;
    let cur = base;
    let moved = false;
    let done = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (Math.abs(ev.clientX - sx) > TAP_PX || Math.abs(ev.clientY - sy) > TAP_PX) moved = true;
      if (!moved) return;
      const dx = (ev.clientX - sx) / box.width;
      const dy = (ev.clientY - sy) / box.height;
      cur = what === 'move' ? moveRect(base, dx, dy) : resizeRect(base, what, corner![0] + dx, corner![1] + dy, minW, minH);
      setEdit({ id: region.id, rect: cur });
    };
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('lostpointercapture', cancel);
      try {
        if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
      } catch {
        /* schon freigegeben */
      }
      if (cleanupRef.current === abort) cleanupRef.current = null;
      setEdit(null);
      if (!commit) return;
      if (moved) applyRect(region.id, cur);
      // Fläche nur angetippt: kleinsten Bereich an dieser Stelle auswählen (z. B. die Augenpartie im Gesicht);
      // ein angetippter Griff ändert nichts
      else if (what === 'move') selectAt(...toNorm(sx, sy, box));
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish(true);
    };
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId || done) return;
      finish(false);
      setMsg({ text: t('w4fd.editCancelled'), kind: 'warn' });
    };
    const abort = () => finish(false);
    cleanupRef.current = abort;
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('lostpointercapture', cancel);
  };

  /** Neue Lage speichern. Ein von Hand angepasster Bereich gilt als eigener (Herkunft „automatisch“ entfällt). */
  const applyRect = (id: string, r: Rect) => {
    const list = regionsRef.current;
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    const old = list[i];
    const same = Math.abs(old.x - r.x) < 1e-9 && Math.abs(old.y - r.y) < 1e-9 && Math.abs(old.w - r.w) < 1e-9 && Math.abs(old.h - r.h) < 1e-9;
    if (same) return;
    const { origin: _drop, ...rest } = old as RegionWithOrigin;
    void _drop;
    api.setRegions(list.map((x, j) => (j === i ? { ...rest, x: r.x, y: r.y, w: r.w, h: r.h } : x)));
    setMsg({ text: t('w4fd.moved', { n: i + 1 }), kind: 'info' });
  };

  const onRegionKey = (e: React.KeyboardEvent, region: Region) => {
    if (e.key === 'Escape') {
      setSelectedId(null);
      e.preventDefault();
      return;
    }
    const next = nudgeRect(region, e.key, e.shiftKey);
    if (!next) return;
    e.preventDefault();
    applyRect(region.id, next);
  };

  const remove = (id: string) => {
    api.setRegions(regions.filter((x) => x.id !== id));
    if (selectedId === id) setSelectedId(null);
    setMsg(null);
  };
  const startFace = () => {
    setMode('face');
    setShape('ellipse');
    setDrawing(true);
    setSelectedId(null);
    setMsg(null);
  };
  const toggleDrawing = () => {
    setDrawing((d) => !d);
    setSelectedId(null);
  };
  const toggleSelect = (id: string) => {
    focusSel.current = false; // Fokus bleibt auf dem Knopf in der Liste (Pfeiltasten wirken auch dort)
    setSelectedId((s) => (s === id ? null : id));
    setMsg(null);
  };

  // Vorschläge übernehmen/verwerfen – erst hier entstehen Bereiche
  const afterSuggestion = (rest: FaceSuggestion[]) => {
    if (!imgKey) return;
    setDetFor(imgKey, { ...det, status: rest.length ? 'found' : 'done', suggestions: rest });
  };
  const accept = (s: FaceSuggestion) => {
    const base = regionsRef.current;
    const add = suggestionRegions(s, uid);
    api.setRegions([...base, ...add]);
    afterSuggestion(det.suggestions.filter((x) => x.id !== s.id));
    setSelectedId(null);
    setMsg({ text: t('w4fd.accepted', { a: base.length + 1, b: base.length + 2 }), kind: 'info' });
  };
  const acceptAll = () => {
    const add = det.suggestions.flatMap((s) => suggestionRegions(s, uid));
    api.setRegions([...regionsRef.current, ...add]);
    setMsg({ text: t('w4fd.acceptedAll', { n: det.suggestions.length }), kind: 'info' });
    afterSuggestion([]);
    setSelectedId(null);
  };
  const discard = (s: FaceSuggestion) => {
    afterSuggestion(det.suggestions.filter((x) => x.id !== s.id));
    setMsg({ text: t('w4fd.discarded'), kind: 'info' });
  };

  const hasFace = faceRegionsOf(regions).length > 0;
  const shown = regions.map((r) => (edit && edit.id === r.id ? { ...r, ...edit.rect } : r));
  const shapeName = (s: Region['shape']) => t(s === 'ellipse' ? 'w3fg.shape.ellipse' : 'w3fg.shape.rect');
  const selIndex = selectedId ? regions.findIndex((r) => r.id === selectedId) : -1;
  const sugg = det.suggestions;
  const running = det.status === 'running';

  const statusText =
    det.status === 'running'
      ? t('w4fd.running')
      : det.status === 'found'
        ? tCount(t, 'w4fd.found', sugg.length, { n: sugg.length })
        : det.status === 'none'
          ? t('w4fd.none')
          : det.status === 'covered'
            ? t('w4fd.covered')
            : det.status === 'error'
              ? t('w4fd.error')
              : '';

  return (
    <div className="w3fg-regions w4fd-regions">
      <h3>{t('shapes.regions')}</h3>
      <p className="muted small">{t('shapes.regionsHint')}</p>

      <div className="w4fd-detect">
        <button className="btn small" onClick={() => imgKey && void runDetect(imgKey, img)} disabled={running} data-testid="detect-faces">
          {t('w4fd.detect')}
        </button>
        {statusText && (
          <span className={`small ${det.status === 'error' ? 'w3fg-msg-warn' : 'w4fd-status'}`} role="status" data-testid="face-detect-status" data-status={det.status}>
            {running && <span className="w4fd-spinner" aria-hidden="true" />}
            {statusText}
          </span>
        )}
      </div>
      <p className="small muted w4fd-scope" data-testid="face-detect-scope">
        {t('w4fd.scope')}
      </p>

      {sugg.length > 0 && (
        <div className="w4fd-suggs" data-testid="face-suggestions">
          {sugg.map((s, i) => (
            <div className="w4fd-sugg-card" key={s.id} data-testid="face-suggestion-card" data-source={s.source} data-score={s.score ?? ''} data-confidence={s.confidence ?? ''}>
              <span className="w4fd-letter" aria-hidden="true">
                {letter(i)}
              </span>
              <div className="w4fd-sugg-text">
                <b>{t('w4fd.sugg.title', { letter: letter(i) })}</b>
                <span className="small">
                  {s.source === 'pico' && s.confidence ? (
                    <span title={t('w4fd.sugg.confTip', { score: n(s.score ?? 0) })} data-testid="face-suggestion-conf">
                      {t('w4fd.sugg.conf', { level: t(`w4fd.conf.${s.confidence}`) })} <Badge kind="info">{t('w3fg.richtwert')}</Badge>
                    </span>
                  ) : (
                    t('w4fd.sugg.native')
                  )}
                </span>
                <span className="small muted">{s.eyesFrom === 'landmarks' ? t('w4fd.sugg.addsLandmarks') : t('w4fd.sugg.adds')}</span>
              </div>
              <div className="w4fd-sugg-actions">
                <button className="btn small primary" onClick={() => accept(s)} data-testid="face-suggestion-accept" aria-label={t('w4fd.acceptN', { letter: letter(i) })}>
                  {t('w4fd.accept')}
                </button>
                <button className="btn small" onClick={() => discard(s)} data-testid="face-suggestion-discard" aria-label={t('w4fd.discardN', { letter: letter(i) })}>
                  {t('w4fd.discard')}
                </button>
              </div>
            </div>
          ))}
          {sugg.length > 1 && (
            <button className="btn small" onClick={acceptAll} data-testid="face-suggestion-accept-all">
              {t('w4fd.acceptAll')}
            </button>
          )}
        </div>
      )}

      {!hasFace && sugg.length === 0 && (
        <div className="w3fg-manual" data-testid="face-manual-card">
          <b>{t('w3fg.manual.title')}</b>
          <p className="small">{t('w4fd.manual.text')}</p>
          <button className="btn small primary" onClick={startFace} data-testid="face-manual-start">
            {t('w3fg.manual.start')}
          </button>
        </div>
      )}
      <div className="btn-row wrap w3fg-tools">
        <Segmented value={mode} options={[{ value: 'face', label: t('shapes.region.face') }, { value: 'detail', label: t('shapes.region.detail') }]} onChange={setMode} testId="region-type" />
        <Segmented
          value={shape}
          options={[
            { value: 'ellipse', label: <span title={shapeName('ellipse')} aria-label={shapeName('ellipse')}>◯</span> },
            { value: 'rect', label: <span title={shapeName('rect')} aria-label={shapeName('rect')}>▭</span> },
          ]}
          onChange={setShape}
          testId="region-shape"
        />
        <button className={`btn small ${drawing ? 'primary' : ''}`} aria-pressed={drawing} onClick={toggleDrawing} data-testid="region-draw-toggle">
          {drawing ? t('w3fg.drawStop') : t('w3fg.draw')}
        </button>
      </div>
      {drawing && (
        <p className="small w3fg-draw-hint" role="status">
          {t('w3fg.drawHint')}
        </p>
      )}
      <div className={`region-holder w3fg-holder w4fd-holder ${drawing ? 'w3fg-draw' : ''}`} ref={holder} onPointerDown={onDown} data-testid="region-holder" data-drawing={drawing ? '1' : '0'}>
        {shown.map((r, i) => {
          const sel = r.id === selectedId;
          return (
            <div
              key={r.id}
              className={`region region-${r.type} ${r.shape} ${sel ? 'w4fd-sel' : ''}`}
              data-testid="region-overlay"
              data-selected={sel ? '1' : '0'}
              style={pct(r)}
              onPointerDown={sel ? (e) => startEdit(e, regions[i], 'move') : undefined}
              onKeyDown={sel ? (e) => onRegionKey(e, regions[i]) : undefined}
              tabIndex={sel ? 0 : undefined}
              role={sel ? 'group' : undefined}
              aria-label={sel ? t('w4fd.sel.label', { n: i + 1 }) : undefined}
            >
              <span className="w3fg-num">{i + 1}</span>
              {sel &&
                HANDLES.map((h) => (
                  <span
                    key={h}
                    className={`w4fd-h w4fd-h-${h}`}
                    data-testid={`region-handle-${h}`}
                    title={t('w4fd.handle', { corner: t(`w4fd.corner.${h}`) })}
                    onPointerDown={(e) => startEdit(e, regions[i], h)}
                  />
                ))}
            </div>
          );
        })}
        {draft && <div className={`region region-${draft.type} ${draft.shape} w3fg-draft`} data-testid="region-draft" style={pct(draft)} />}
        {sugg.map((s, i) => (
          <Fragment key={s.id}>
            <div className="w4fd-sugg w4fd-sugg-face" style={pct(s.face)} data-testid="face-suggestion" aria-hidden="true">
              <span className="w4fd-sugg-tag">{letter(i)}</span>
            </div>
            <div className="w4fd-sugg w4fd-sugg-eyes" style={pct(s.eyes)} data-testid="face-suggestion-eyes" aria-hidden="true" />
          </Fragment>
        ))}
      </div>
      {/* Meldungen unter dem Bild: ändern nie die Lage des Bildes während man darauf arbeitet */}
      {msg && (
        <p className={`small w4fd-msg ${msg.kind === 'warn' ? 'w3fg-msg-warn' : 'muted'}`} role="status" data-testid="region-msg">
          {msg.text}
        </p>
      )}
      {sugg.length > 0 && (
        <p className="small muted w4fd-legend">
          <span className="w4fd-legend-item">
            <span className="w4fd-key w4fd-key-face" aria-hidden="true" /> {t('w4fd.legend.face')}
          </span>
          <span className="w4fd-legend-item">
            <span className="w4fd-key w4fd-key-eyes" aria-hidden="true" /> {t('w4fd.legend.eyes')}
          </span>
        </p>
      )}
      {selIndex >= 0 ? (
        <div className="w4fd-selbar" data-testid="region-selbar">
          <div>
            <b>{t('w4fd.sel.title', { n: selIndex + 1 })}</b>
            <span className="small muted">{t('w4fd.sel.hint')}</span>
          </div>
          <button className="btn small" onClick={() => setSelectedId(null)} data-testid="region-sel-done">
            {t('w4fd.sel.done')}
          </button>
        </div>
      ) : (
        regions.length > 0 && <p className="small muted w4fd-selhint">{t('w4fd.selectHint')}</p>
      )}
      {regionsChanged && (
        <div className="w3fg-changed" role="status" data-testid="regions-changed">
          <span>{t('w3fg.regionsChanged')}</span>
          <button className="btn small" onClick={() => (location.hash = stepHash(rec.meta.id, 'compute'))} data-testid="regions-go-compute">
            {t('w3fg.goCompute')}
          </button>
        </div>
      )}
      {regions.length === 0 ? (
        <p className="muted small">{t('w3fg.none')}</p>
      ) : (
        <ul className="region-list w3fg-list" data-testid="region-list">
          {regions.map((r, i) => {
            const span = r.type === 'face' && layout ? regionCellSpan(layout, r) : null;
            const light = span ? faceLight(span.cols) : null;
            const origin = regionOrigin(r);
            const sel = r.id === selectedId;
            return (
              <li key={r.id} data-testid="region-item" data-origin={origin ?? ''} className={sel ? 'w4fd-item-sel' : undefined}>
                <span className="w3fg-num-inline">{i + 1}</span>
                <span className="w3fg-item-text">
                  <span>
                    {t(`shapes.region.${r.type}`)}
                    {origin === 'auto-eyes' && ` – ${t('w4fd.origin.eyes')}`} ({shapeName(r.shape)})
                    {origin === 'auto-eyes' && (
                      <>
                        {' '}
                        <span title={t('w4fd.estimatedTip')} data-testid="region-estimated">
                          <Badge kind="warn">{t('w4fd.estimated')}</Badge>
                        </span>
                      </>
                    )}
                  </span>
                  {origin === 'auto-face' && <span className="small muted">{t('w4fd.origin.face')}</span>}
                  {span && light && (
                    <span className="small w3fg-span" data-testid="region-face-span" data-cols={span.cols} data-light={light}>
                      <span className={`w3fg-dot w3fg-${light}`} aria-hidden="true" />
                      {t('w3fg.faceSpan', { cols: n(span.cols), rows: n(span.rows) })} · {t(`w3fg.light.${light}`)} <Badge kind="info">{t('w3fg.richtwert')}</Badge>
                    </span>
                  )}
                </span>
                <button
                  className={`btn small w4fd-pick ${sel ? 'primary' : ''}`}
                  aria-pressed={sel}
                  onClick={() => toggleSelect(r.id)}
                  onKeyDown={sel ? (e) => onRegionKey(e, r) : undefined}
                  aria-label={t('w4fd.editN', { n: i + 1 })}
                  title={t('w4fd.editN', { n: i + 1 })}
                  data-testid="region-edit"
                >
                  {t('w4fd.edit')}
                </button>
                <button className="icon-btn w3fg-del" onClick={() => remove(r.id)} aria-label={t('w3fg.removeN', { n: i + 1 })} title={t('w3fg.removeN', { n: i + 1 })}>
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {regions.length > 0 && (
        <button className="btn small" onClick={() => remove(regions[regions.length - 1].id)} data-testid="region-remove-last">
          {t('w3fg.removeLast')}
        </button>
      )}
    </div>
  );
}
