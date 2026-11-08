/**
 * Fehlende Akzentfarben und Pflichtfarben (w4-cut-placement-accents).
 *  - AccentsPanel (Schritt 5 und 7): Gruppen von Steinen, die keine passende Farbe erhalten haben (exakt gezählt, Stand
 *    der Berechnung), mit Vorschlag = gemessener Mittelwert. „Als Pflichtfarbe übernehmen“ ändert nur die Einstellungen
 *    (das Projekt gilt dann als geändert); bei eigener Palette „Zur eigenen Palette hinzufügen“.
 *  - PinnedColorsEditor (Schritt 5): Liste der Pflichtfarben (hinzufügen, Notiz, entfernen) und was die letzte
 *    Berechnung mit jeder gemacht hat.
 */
import { useState } from 'react';
import { addPaletteColor } from '../../core/edits';
import type { AccentSkipped, ComputeDiagnostics, MissingAccent } from '../../core/mosaic';
import { ACCENT_MAX_GROUPS, ACCENT_MIN_DE } from '../../core/mosaic';
import { parseCellId } from '../../core/layout';
import type { Material } from '../../core/types';
import { tCount, useI18n } from '../../i18n';
import { Swatch } from '../components';
import { addPinned, isPinned, normalizeHexInput, pinnedApplies, pinnedResultFor, removePinned, renamePinned } from './pinnedColors';
import type { ProjectApi } from './useProject';
import '../css/w4-cut-placement-accents.css';
import '../css/w4-review-fixes.css';

/** Wie viele Steinbezeichnungen je Vorschlag direkt sichtbar sind (die übrigen gespeicherten im Tooltip) */
const IDS_SHOWN = 8;

function deLabel(formula: '2000' | '76' | null): string {
  return formula === '76' ? 'ΔE76' : formula === '2000' ? 'ΔE00' : 'ΔE';
}

/** Wurden Gruppen abweichender Steine übersprungen (nicht vorgeschlagen)? */
export function accentsSkippedAny(sk: AccentSkipped | undefined): boolean {
  return !!sk && !!(sk.nearPalette?.groups || sk.noMaterial?.groups || sk.inPalette?.groups || sk.ungrouped?.stones);
}

/**
 * Gruppen abweichender Steine, die nicht vorgeschlagen werden – mit Grund und exakter Anzahl. So steht nie
 * „keine Gruppe weicht ab“, wenn Steine abweichen, für die nur kein passendes Material da ist.
 */
function AccentSkippedNotes({ sk, de, thr, half, testId }: { sk: AccentSkipped; de: string; thr: string; half: string; testId: string }) {
  const { t, n } = useI18n();
  const rows: { key: string; why: string; text: string }[] = [];
  const add = (why: 'noMaterial' | 'inPalette' | 'nearPalette') => {
    const c = sk[why];
    if (!c || !c.groups) return;
    rows.push({ key: why, why, text: tCount(t, `w4fx.acc.skip.${why}`, c.groups, { groups: n(c.groups), stones: n(c.stones), de, thr, half }) });
  };
  add('noMaterial');
  add('inPalette');
  add('nearPalette');
  if (sk.ungrouped?.stones) rows.push({ key: 'ungrouped', why: 'ungrouped', text: tCount(t, 'w4fx.acc.skip.ungrouped', sk.ungrouped.stones, { stones: n(sk.ungrouped.stones), de, thr, max: ACCENT_MAX_GROUPS }) });
  if (!rows.length) return null;
  return (
    <ul className="w4fx-acc-skipped small" data-testid={`${testId}-skipped`}>
      {rows.map((r) => (
        <li key={r.key} data-why={r.why} data-testid={`${testId}-skipped-row`}>
          {r.text}
        </li>
      ))}
    </ul>
  );
}

export function AccentsPanel({
  api,
  d,
  formula,
  stale,
  fromPreview = false,
  testId = 'accents',
  onOpenStone,
}: {
  api: ProjectApi;
  d: ComputeDiagnostics | undefined;
  formula: '2000' | '76' | null;
  stale: boolean;
  fromPreview?: boolean;
  testId?: string;
  /** Stein in Schritt 8 öffnen (Zeile, Spalte, Teilstück ab 0); nur für Steine des gespeicherten Mosaiks */
  onOpenStone?: (row: number, col: number, piece: number) => void;
}) {
  const { t, n, lang } = useI18n();
  const [notice, setNotice] = useState<string | null>(null);
  const rec = api.rec;
  if (!rec || !d || !d.missingAccents) return null;
  const list: MissingAccent[] = d.missingAccents;
  const de = deLabel(formula);
  const mode = rec.settings.paletteMode;
  const locale = lang === 'de' ? 'de-DE' : lang === 'tr' ? 'tr-TR' : 'en-GB';
  const f1 = (v: number) => (Number.isFinite(v) ? v.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '–');
  const thr = f1(ACCENT_MIN_DE);
  const sk = d.missingAccentsSkipped;
  const skippedNotes = sk ? <AccentSkippedNotes sk={sk} de={de} thr={thr} half={f1(ACCENT_MIN_DE / 2)} testId={testId} /> : null;
  // Steinbezeichnungen öffnen nur Steine des gespeicherten Mosaiks (Vorschau-Steine gibt es in Schritt 8 noch nicht)
  const layout = !fromPreview && onOpenStone && api.computed ? api.computed.layout : null;
  if (!list.length) {
    if (sk && !accentsSkippedAny(sk)) {
      return (
        <p className="muted small w4cpa-acc-none" data-testid={`${testId}-none`}>
          {t('w4cpa.acc.none', { de, thr })}
          {stale && <span> {t('w4cpa.acc.stale')}</span>}
        </p>
      );
    }
    return (
      <div className="muted small w4cpa-acc-none" data-testid={`${testId}-nosuggest`} data-known={sk ? 'yes' : 'no'}>
        <p>
          {t(sk ? 'w4fx.acc.noneShown' : 'w4fx.acc.noneUnknown', { de, thr })}
          {stale && <span> {t('w4cpa.acc.stale')}</span>}
        </p>
        {skippedNotes}
      </div>
    );
  }
  const pin = (hex: string) => {
    const r = addPinned(rec.settings.pinnedColors, hex);
    if (r.ok) api.setSettings({ pinnedColors: r.list });
    setNotice(t('w4cpa.acc.noticePin', { hex }));
  };
  const addCustom = (hex: string) => {
    api.setPalette(addPaletteColor(rec.palette, hex, undefined, lang));
    setNotice(t('w4cpa.acc.noticeCustom', { hex }));
  };
  return (
    <section className="w4cpa-acc" data-testid={testId}>
      <h4 className="w4cpa-acc-title">
        {t('w4cpa.acc.title')}
        {fromPreview && <span className="w4cpa-acc-src muted small"> · {t('w4cpa.acc.previewSource')}</span>}
      </h4>
      <p className="muted small">{t('w4cpa.acc.intro', { de, thr })}</p>
      {stale && <p className="muted small">{t('w4cpa.acc.stale')}</p>}
      <ul className="w4cpa-acc-list">
        {list.map((a) => {
          const pinned = isPinned(rec.settings.pinnedColors, a.hex);
          const inCustom = mode === 'custom' && rec.palette.some((p) => p.hex.toUpperCase() === a.hex.toUpperCase());
          const shown = a.cellIds.slice(0, IDS_SHOWN);
          const more = a.stones - shown.length;
          return (
            <li key={a.hex} className="w4cpa-acc-item" data-testid={`${testId}-item`} data-hex={a.hex} data-l={a.lab[0]}>
              <span className="w4cpa-acc-swatch">
                <Swatch hex={a.hex} size={26} />
              </span>
              <div className="w4cpa-acc-body">
                <div className="w4cpa-acc-head" data-testid={`${testId}-text`}>
                  {tCount(t, 'w4cpa.acc.row', a.stones, { n: n(a.stones), de, v: f1(a.meanDE), hex: a.hex })}
                </div>
                <div className="muted small">
                  <span className="mono">
                    L {f1(a.lab[0])} a {f1(a.lab[1])} b {f1(a.lab[2])}
                  </span>
                  {' · '}
                  {t('w4cpa.acc.nearest', { de, v: f1(a.nearestDE) })}
                  {a.inFace > 0 && <> · {t('w4cpa.acc.face', { n: n(a.inFace) })}</>}
                </div>
                {a.snapHex && (
                  <div className="small w4cpa-acc-snap" data-testid={`${testId}-snap`}>
                    <Swatch hex={a.snapHex} size={14} /> {t('w4cpa.acc.snap', { name: a.snapName ?? a.snapHex, hex: a.snapHex, de, v: f1(a.snapDE ?? 0) })}
                  </div>
                )}
                <div className="small w4cpa-acc-ids" title={a.cellIds.join(', ')} data-testid={`${testId}-ids`}>
                  {layout && onOpenStone ? (
                    <>
                      {t('w4fx.acc.idsLabel')}{' '}
                      {shown.map((id) => {
                        const p = parseCellId(layout, id);
                        return p ? (
                          <button
                            key={id}
                            type="button"
                            className="btn small w4fx-id-btn"
                            title={t('w4fx.acc.openStone', { id })}
                            data-testid={`${testId}-open`}
                            data-id={id}
                            onClick={() => onOpenStone(p.row, p.col, p.piece)}
                          >
                            {id}
                          </button>
                        ) : (
                          <span key={id} className="mono">
                            {id}{' '}
                          </span>
                        );
                      })}
                    </>
                  ) : (
                    t('w4cpa.acc.ids', { ids: shown.join(', ') })
                  )}
                  {more > 0 && ` ${t('w4cpa.acc.more', { n: n(more) })}`}
                </div>
                <div className="w4cpa-acc-actions">
                  {pinnedApplies(mode) &&
                    (pinned ? (
                      <span className="w4cpa-ok small" data-testid={`${testId}-pinned`}>
                        {t('w4cpa.acc.pinned')}
                      </span>
                    ) : (
                      <button className="btn small" onClick={() => pin(a.hex)} data-testid={`${testId}-pin`}>
                        {t('w4cpa.acc.pin')}
                      </button>
                    ))}
                  {mode === 'custom' &&
                    (inCustom ? (
                      <span className="w4cpa-ok small" data-testid={`${testId}-incustom`}>
                        {t('w4cpa.acc.inPalette')}
                      </span>
                    ) : (
                      <button className="btn small" onClick={() => addCustom(a.hex)} disabled={api.paletteLocked} data-testid={`${testId}-addcustom`}>
                        {t('w4cpa.acc.addCustom')}
                      </button>
                    ))}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {skippedNotes}
      <p className="muted small" data-testid={`${testId}-findhint`}>
        {t(layout ? 'w4fx.acc.openHint' : fromPreview ? 'w4fx.acc.previewIdsHint' : 'w4cpa.acc.findHint')}
      </p>
      {notice && (
        <p className="w4cpa-notice small" role="status" data-testid={`${testId}-notice`}>
          {notice}
        </p>
      )}
    </section>
  );
}

/** Liste der Pflichtfarben in Schritt 5 (wirkt in „Automatisch aus dem Foto“ und „Meine Steine – begrenzte Farbanzahl“). */
export function PinnedColorsEditor({ api, materials }: { api: ProjectApi; materials: Material[] }) {
  const { t, n, lang } = useI18n();
  const [hexIn, setHexIn] = useState('#1D1F1B');
  const [noteIn, setNoteIn] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const rec = api.rec;
  if (!rec) return null;
  const s = rec.settings;
  const list = s.pinnedColors ?? [];
  const mode = s.paletteMode;
  if (!pinnedApplies(mode)) {
    if (!list.length) return null;
    return (
      <p className="muted small w4cpa-pin-other" data-testid="pinned-other-mode">
        {tCount(t, 'w4cpa.pin.otherMode', list.length, { n: list.length })}
      </p>
    );
  }
  const d = api.computed ? rec.diagnostics : undefined;
  const matById = new Map(materials.map((m) => [m.id, m]));
  const locale = lang === 'de' ? 'de-DE' : lang === 'tr' ? 'tr-TR' : 'en-GB';
  const f1 = (v: number) => v.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const de = deLabel(s.deltaE);
  const add = () => {
    const r = addPinned(list, hexIn, noteIn);
    if (!r.ok) {
      setErr(t(r.reason === 'invalid' ? 'w4cpa.pin.invalid' : 'w4cpa.pin.dup'));
      return;
    }
    setErr(null);
    setNoteIn('');
    api.setSettings({ pinnedColors: r.list });
  };
  const status = (hex: string) => {
    const res = pinnedResultFor(d, hex, api.stale);
    if (!res) return <span className="muted">{t('w4cpa.pin.pending')}</span>;
    if (mode === 'auto-snap' && res.materialId !== undefined) {
      const m = matById.get(res.materialId);
      const name = m ? m.colorName || [m.manufacturer, m.colorNumber].filter(Boolean).join(' ') : (res.paletteHex ?? '');
      return res.stones > 0 ? (
        <span>{tCount(t, 'w4cpa.pin.snapUsed', res.stones, { name, de, v: f1(res.snapDE ?? 0), n: n(res.stones) })}</span>
      ) : (
        <span className="warn">{t('w4cpa.pin.snapUnused', { name, de, v: f1(res.snapDE ?? 0) })}</span>
      );
    }
    return res.stones > 0 ? <span className="w4cpa-ok">{tCount(t, 'w4cpa.pin.used', res.stones, { n: n(res.stones) })}</span> : <span className="warn">{t('w4cpa.pin.unused')}</span>;
  };
  const k = Math.max(1, s.colorCount);
  return (
    <div className="field w4cpa-pin" data-testid="pinned-colors">
      <div className="field-label">{t('w4cpa.pin.title')}</div>
      <div className="field-hint">{t(mode === 'auto-snap' ? 'w4cpa.pin.hintSnap' : 'w4cpa.pin.hint')}</div>
      {list.length === 0 ? (
        <p className="muted small" data-testid="pinned-empty">
          {t('w4cpa.pin.empty')}
        </p>
      ) : (
        <ul className="w4cpa-pin-list">
          {list.map((p) => (
            <li key={p.hex} className="w4cpa-pin-row" data-testid="pinned-row" data-hex={p.hex.toUpperCase()}>
              <Swatch hex={p.hex} size={22} />
              <b className="mono">{p.hex.toUpperCase()}</b>
              <input
                className="text w4cpa-pin-note"
                value={p.name ?? ''}
                placeholder={t('w4cpa.pin.notePh')}
                aria-label={`${t('w4cpa.pin.note')} ${p.hex}`}
                onChange={(e) => api.setSettings({ pinnedColors: renamePinned(list, p.hex, e.target.value) })}
              />
              <span className="small w4cpa-pin-status" data-testid="pinned-status">
                {status(p.hex)}
              </span>
              <button className="icon-btn" title={t('w4cpa.pin.remove')} aria-label={`${t('w4cpa.pin.remove')} ${p.hex}`} onClick={() => api.setSettings({ pinnedColors: removePinned(list, p.hex) })} data-testid="pinned-remove">
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.length >= k && (
        <p className="warn small" data-testid="pinned-too-many">
          {t('w4cpa.pin.tooMany', { k })}
        </p>
      )}
      <div className="btn-row wrap w4cpa-pin-add">
        <input type="color" value={normalizeHexInput(hexIn)?.toLowerCase() ?? '#000000'} onChange={(e) => setHexIn(e.target.value.toUpperCase())} aria-label={t('w4cpa.pin.pick')} />
        <input className="text mono w4cpa-pin-hex" value={hexIn} onChange={(e) => setHexIn(e.target.value)} aria-label={t('w4cpa.pin.hexLabel')} data-testid="pinned-hex" onKeyDown={(e) => e.key === 'Enter' && add()} />
        <input className="text w4cpa-pin-note" value={noteIn} placeholder={t('w4cpa.pin.notePh')} aria-label={t('w4cpa.pin.note')} onChange={(e) => setNoteIn(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn small" onClick={add} data-testid="pinned-add">
          + {t('w4cpa.pin.add')}
        </button>
      </div>
      {err && (
        <p className="error small" role="alert" data-testid="pinned-error">
          {err}
        </p>
      )}
    </div>
  );
}
