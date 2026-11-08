import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { Badge, Swatch, Toggle } from '../components';
import { StoneDialog } from './StoneDialog';
import { Viewer, type ViewerHandle } from './Viewer';
import type { ProjectApi } from './useProject';
import type { Material } from '../../core/types';
import { parseCellId } from '../../core/layout';

export function StepPreview({ api, materials }: { api: ProjectApi; materials: Material[] }) {
  const { t, n } = useI18n();
  const [realistic, setRealistic] = useState(true);
  const [codes, setCodes] = useState(true);
  const [showSections, setShowSections] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  const [pick, setPick] = useState<{ row: number; col: number; piece: number } | null>(null);
  const [search, setSearch] = useState('');
  const viewer = useRef<ViewerHandle>(null);
  const origRef = useRef<HTMLDivElement>(null);
  const c = api.computed;

  useEffect(() => {
    const h = origRef.current;
    if (!h || !api.processed) return;
    h.innerHTML = '';
    const cv = api.processed;
    cv.style.width = '100%';
    cv.style.height = 'auto';
    h.appendChild(cv);
  }, [api.processed]);

  if (!c) return <p className={api.integrityError ? 'error' : 'muted'}>{t(api.integrityError ? 'compute.err.integrity' : 'preview.notComputed')}</p>;
  const rec = api.rec!;
  const palette = rec.palette;
  return (
    <div className="viewer-layout">
      <div>
        {api.stale && <Badge kind="warn">{t('preview.stale')}</Badge>}
        <Viewer
          ref={viewer}
          layout={c.layout}
          data={c.data}
          palette={palette}
          version={api.version}
          progressVersion={api.progressVersion}
          groutHex={rec.settings.groutHex}
          surface={rec.settings.surface}
          realistic={realistic}
          showCodes={codes}
          progressMode={false}
          sections={showSections ? api.sections : null}
          highlight={pick}
          focusColor={focus}
          onPick={(row, col, piece) => setPick({ row, col, piece })}
        />
        <p className="muted small">{t('preview.hint')}</p>
      </div>
      <aside className="side">
        <Toggle checked={realistic} onChange={setRealistic} label={t('preview.realistic')} />
        <Toggle checked={codes} onChange={setCodes} label={t('preview.codes')} />
        <Toggle checked={showSections} onChange={setShowSections} label={t('preview.sections')} />
        <form
          className="btn-row"
          onSubmit={(e) => {
            e.preventDefault();
            const p = parseCellId(c.layout, search);
            if (p) {
              setPick({ row: p.row, col: p.col, piece: p.piece });
              viewer.current?.center(c.layout.colX[p.col], c.layout.rowY[p.row], 12);
            }
          }}
        >
          <input className="text" placeholder={t('preview.findStone')} value={search} onChange={(e) => setSearch(e.target.value)} data-testid="find-stone" />
          <button className="btn small" type="submit">
            {t('preview.find')}
          </button>
        </form>
        <h4>
          {t('preview.legend')} ({palette.length})
        </h4>
        <div className="legend-list">
          {palette.map((p, i) => (
            <button key={i} className={`legend-item ${focus === i ? 'active' : ''}`} onClick={() => setFocus(focus === i ? null : i)}>
              <Swatch hex={p.hex} />
              <b>{String(p.code).padStart(2, '0')}</b>
              <span className="grow">{p.name}</span>
              <span className="muted">{api.stats ? n(api.stats.perColor[i]?.pieces ?? 0) : '…'}</span>
            </button>
          ))}
        </div>
        {focus !== null && <small className="muted">{t('preview.focusHint')}</small>}
        <h4>{t('preview.original')}</h4>
        <div className="orig-thumb" ref={origRef}>
          {!api.processed && <small className="muted">{t('preview.originalAfterCompute')}</small>}
        </div>
      </aside>
      {pick && (
        <StoneDialog
          layout={c.layout}
          data={c.data}
          palette={palette}
          materials={materials}
          sections={api.sections}
          row={pick.row}
          col={pick.col}
          piece={pick.piece}
          minPieceMm={rec.settings.shapes.minPieceMm}
          onClose={() => setPick(null)}
          onNavigate={(row, col, piece) => setPick({ row, col, piece })}
          onChanged={api.touchMosaic}
          onProgress={api.touchProgress}
        />
      )}
    </div>
  );
}
