/**
 * Abschnittsauswahl für den PDF-Export (Paket w5-pdf-export-ui) – immer verfügbar, auch bei vielen hundert
 * Abschnitten: Die Abschnitte stehen wie im Mosaik als Raster (Zeilen = Buchstaben, Spalten = Nummern).
 *  - Antippen wählt einen Abschnitt an oder ab; bei „Alle“ wählt es nur diesen.
 *  - Zeilenbuchstabe bzw. Spaltennummer am Rand wählt die ganze Zeile bzw. Spalte an oder ab.
 *  - „Nur offene Abschnitte“ wählt alle, die noch nicht fertig verlegt sind.
 *  - Bereichsfeld „A1-C4, D7“: exakt gelesen – ein unbekannter oder unlesbarer Eintrag wird mit Meldung abgelehnt
 *    und ändert nichts.
 * `selected === null` bedeutet „alle Abschnitte“.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { rowLabel, type SectionGrid } from '../../core/layout';
import { formatSectionRange, normalizeSelection, openSections, parseSectionRange, toggleLine, toggleSection, type RangeIssue } from '../../core/pdfExportPlan';
import { useI18n, type TFunc } from '../../i18n';
import { deviceKey, useCoarsePointer } from './deviceKind';

/** Ab so vielen Abschnitten wird das Raster in einem scrollbaren Feld gezeigt. */
export const PICKER_SCROLL_FROM = 200;

function issueText(t: TFunc, issue: RangeIssue, grid: SectionGrid): string {
  switch (issue.kind) {
    case 'empty':
      return t('w5pe.pick.err.empty');
    case 'syntax':
      return t('w5pe.pick.err.syntax', { token: issue.token });
    case 'unknown':
      return t('w5pe.pick.err.unknown', { id: issue.id, last: `${rowLabel(grid.srows - 1)}${grid.scols}` });
  }
}

export function SectionPicker(props: {
  grid: SectionGrid;
  /** null = alle Abschnitte */
  selected: string[] | null;
  onChange: (ids: string[] | null) => void;
  /** Verlegefortschritt je Abschnitt (für „Nur offene Abschnitte“ und die ✓-Markierung) */
  progress?: ReadonlyMap<string, { placed: number; total: number }> | null;
  disabled?: boolean;
}) {
  const { t, n } = useI18n();
  const { grid, selected, onChange, progress, disabled } = props;
  const inputId = useId();
  /** Finger: „antippen“, Maus: „anklicken“ */
  const coarse = useCoarsePointer();
  const total = grid.sections.length;
  const selSet = useMemo(() => (selected ? new Set(selected) : null), [selected]);
  const canonical = useMemo(() => (selected ? formatSectionRange(selected, grid) : ''), [selected, grid]);
  const [text, setText] = useState(canonical);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<RangeIssue[]>([]);
  // Auswahl von außen geändert (Antippen, „Alle“, anderer Schritt): Feld zeigt wieder die aktuelle Auswahl
  useEffect(() => {
    setText(canonical);
    setDirty(false);
    setIssues([]);
  }, [canonical]);

  const open = useMemo(() => openSections(grid, progress), [grid, progress]);
  const openCount = open ? open.length : 0;
  const pick = (ids: string[] | null) => {
    if (!disabled) onChange(ids);
  };
  const applyRange = () => {
    const res = parseSectionRange(text, grid);
    if (res.issues.length) {
      setIssues(res.issues);
      return;
    }
    setIssues([]);
    setDirty(false);
    const next = normalizeSelection(res.ids, grid);
    pick(next);
    // gleiche Auswahl wie vorher (nur anders geschrieben): Feld trotzdem auf die übliche Schreibweise setzen
    setText(next ? formatSectionRange(next, grid) : '');
  };

  const count = selected ? selected.length : total;
  const summary = !selected
    ? t('w5pe.pick.sumAll', { n: n(total) })
    : t('w5pe.pick.sum', { k: n(count), n: n(total), range: canonical.length > 80 ? `${canonical.slice(0, 78)} …` : canonical });
  const scroll = total > PICKER_SCROLL_FROM;
  const rows = Array.from({ length: grid.srows }, (_, sr) => sr);
  const cols = Array.from({ length: grid.scols }, (_, sc) => sc);

  return (
    <div className="w5pe-picker" data-testid="section-picker" data-selected={selected ? selected.join(',') : 'all'} data-count={count}>
      <div className="btn-row wrap">
        <button type="button" className={`btn small ${!selected ? 'primary' : ''}`} aria-pressed={!selected} disabled={disabled} onClick={() => pick(null)} data-testid="sec-all">
          {t('pdfui.allSections')} ({n(total)})
        </button>
        {/* nur sinnvoll, wenn schon Abschnitte fertig verlegt sind (sonst dasselbe wie „Alle“) */}
        {open && openCount < total && (
          <button
            type="button"
            className="btn small"
            disabled={disabled || openCount === 0}
            title={openCount === 0 ? t('w5pe.pick.openNone') : t('w5pe.pick.openTitle')}
            onClick={() => pick(normalizeSelection(open, grid))}
            data-testid="sec-open"
          >
            {t('w5pe.pick.open', { n: n(openCount) })}
          </button>
        )}
      </div>
      <div className="w5pe-range">
        <label htmlFor={inputId} className="small">
          {t('w5pe.pick.range')}
        </label>
        <input
          id={inputId}
          type="text"
          value={text}
          disabled={disabled}
          placeholder={t('w5pe.pick.placeholder')}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={issues.length > 0}
          aria-describedby={`${inputId}-msg`}
          data-testid="sec-range"
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
            if (issues.length) setIssues([]);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              applyRange();
            }
          }}
        />
        <button type="button" className={`btn small ${dirty ? 'primary' : ''}`} disabled={disabled || !dirty} onClick={applyRange} data-testid="sec-range-apply">
          {t('w5pe.pick.apply')}
        </button>
      </div>
      <div id={`${inputId}-msg`}>
        {issues.length > 0 ? (
          <p className="error small w5pe-range-msg" role="alert" data-testid="sec-range-error">
            {issues.slice(0, 3).map((i) => issueText(t, i, grid)).join(' ')}
            {issues.length > 3 ? ` ${t('w5pe.pick.err.more', { n: issues.length - 3 })}` : ''} {t('w5pe.pick.err.unchanged')}
          </p>
        ) : (
          <p className="muted small w5pe-range-msg" data-testid="sec-summary">
            {summary}
          </p>
        )}
      </div>
      <div className={`w5pe-grid-wrap ${scroll ? 'scroll' : ''}`}>
        <div
          className={`w5pe-grid ${scroll || grid.scols > 10 ? 'dense' : ''}`}
          role="group"
          aria-label={t('pdfui.sections')}
          style={{ gridTemplateColumns: `auto repeat(${grid.scols}, minmax(${scroll || grid.scols > 10 ? 40 : 0}px, 1fr))` }}
          data-testid="sec-grid"
        >
          <span className="w5pe-corner" aria-hidden="true" />
          {cols.map((sc) => (
            <button
              key={`c${sc}`}
              type="button"
              className="w5pe-line col"
              disabled={disabled}
              title={t('w5pe.pick.col', { id: sc + 1 })}
              aria-label={t('w5pe.pick.col', { id: sc + 1 })}
              onClick={() => pick(toggleLine(selected, grid, 'col', sc))}
              data-testid="sec-col"
              data-col={sc + 1}
            >
              {sc + 1}
            </button>
          ))}
          {rows.map((sr) => [
            <button
              key={`r${sr}`}
              type="button"
              className="w5pe-line row"
              disabled={disabled}
              title={t('w5pe.pick.row', { id: rowLabel(sr) })}
              aria-label={t('w5pe.pick.row', { id: rowLabel(sr) })}
              onClick={() => pick(toggleLine(selected, grid, 'row', sr))}
              data-testid="sec-row"
              data-row={rowLabel(sr)}
            >
              {rowLabel(sr)}
            </button>,
            ...cols.map((sc) => {
              const s = grid.sections[sr * grid.scols + sc];
              const on = !!selSet && selSet.has(s.id);
              const p = progress?.get(s.id);
              const done = !!p && p.total > 0 && p.placed >= p.total;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`btn chip w5pe-cell ${on ? 'primary' : ''} ${!selSet ? 'all' : ''} ${done ? 'done' : ''}`}
                  aria-pressed={on || !selSet}
                  disabled={disabled}
                  title={p ? t('w5pe.pick.cellTitle', { id: s.id, placed: n(p.placed), total: n(p.total) }) : s.id}
                  onClick={() => pick(toggleSection(selected, s.id, grid))}
                  data-testid="sec-cell"
                  data-section={s.id}
                >
                  {s.id}
                </button>
              );
            }),
          ])}
        </div>
      </div>
      <p className="muted small w5pe-pick-hint" data-testid="sec-hint">
        {t(deviceKey('w5fu.pick.hint', coarse))}
      </p>
    </div>
  );
}
