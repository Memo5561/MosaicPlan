/**
 * Prüfstand für e2e/w5-target-colours.e2e.cjs: der Rechenkern (Laden des gespeicherten Rasters und Abweichung
 * Foto ↔ Stein) als Skript für die Seite der echten App. Der Test liest damit, was die App wirklich in IndexedDB
 * gespeichert hat, und rechnet darauf mit denselben Funktionen, die später die Abweichungsanzeige benutzt.
 * Wird mit esbuild gebündelt (IIFE) – gehört nicht zur App.
 */
import { deltaE } from '../src/core/color';
import {
  deviationByColor,
  deviationForCell,
  deviationForPiece,
  deviationMap,
  deviationSummary,
  hasPhotoTargets,
  nearestColorForPiece,
  pieceTarget,
  targetState,
  topDeviations,
} from '../src/core/deviation';
import { computeLayout, parseCellId, pieceId } from '../src/core/layout';
import { cellPieceCount } from '../src/core/pieces';
import { unpackMosaic } from '../src/core/serialize';

const api = {
  deltaE,
  deviationByColor,
  deviationForCell,
  deviationForPiece,
  deviationMap,
  deviationSummary,
  hasPhotoTargets,
  nearestColorForPiece,
  pieceTarget,
  targetState,
  topDeviations,
  computeLayout,
  parseCellId,
  pieceId,
  cellPieceCount,
  unpackMosaic,
};

(globalThis as unknown as { __w5tc: typeof api }).__w5tc = api;
