import { useState } from 'react';
import { resolveStoneId } from '../../core/laying';
import { cellId, type Layout } from '../../core/layout';
import type { MosaicData } from '../../core/types';
import { tCount, useI18n } from '../../i18n';

/**
 * „Stein suchen“: ID wie in Plan, PDF und CSV eingeben (AP034, AP034-2). Prüft auch, ob es das Teilstück in
 * dieser Zelle gibt; sonst eine Meldung mit den gültigen Bezeichnungen (nur berechnete Grenzen, nichts geraten).
 * Bei Erfolg meldet onFound den Stein – zentrieren und hervorheben macht der Aufrufer (im Verlegemodus ohne
 * ihn als verlegt zu markieren).
 */
export function FindStone(props: { layout: Layout; data: MosaicData; onFound: (row: number, col: number, piece: number) => void; testId?: string }) {
  const { t, n } = useI18n();
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const { layout, data } = props;
  const tid = props.testId ?? 'find-stone';
  return (
    <div className="w4lw-find">
      <form
        className="btn-row"
        onSubmit={(e) => {
          e.preventDefault();
          const r = resolveStoneId(layout, data, text);
          if (r.ok) {
            setMsg(null);
            props.onFound(r.row, r.col, r.piece);
          } else if (r.reason === 'unknown') {
            setMsg(t('w4lw.find.notFound', { id: text.trim(), first: cellId(layout, 0, 0), last: cellId(layout, layout.rows - 1, layout.cols - 1) }));
          } else if (r.reason === 'piece') {
            const cell = cellId(layout, r.row, r.col);
            setMsg(r.pieces <= 0 ? t('w4lw.find.noPieces', { cell }) : tCount(t, 'w4lw.find.pieceNotFound', r.pieces, { cell, n: n(r.pieces) }));
          } else setMsg(null);
        }}
      >
        <input
          className="text"
          placeholder={t('preview.findStone')}
          aria-label={t('preview.findStone')}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setMsg(null);
          }}
          data-testid={tid}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
        />
        <button className="btn small" type="submit" data-testid={`${tid}-go`}>
          {t('preview.find')}
        </button>
      </form>
      {msg && (
        <p className="error small" role="alert" data-testid="find-not-found">
          {msg}
        </p>
      )}
    </div>
  );
}
