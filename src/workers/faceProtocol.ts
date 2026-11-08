import type { FaceBox } from '../core/faceDetect';

/** Anfrage an face.worker.ts: RGBA-Pixel des Editorbildes (Puffer wird übertragen, nicht kopiert). */
export interface FaceRequest {
  id: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type FaceResponse = { id: number; ok: true; faces: FaceBox[]; ms: number } | { id: number; ok: false; error: 'cascade' | 'detect'; message: string };
