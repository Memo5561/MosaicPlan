// Typen für die mitgelieferte pico.js (MIT, siehe LICENSE in diesem Ordner).

/** Bewertung eines quadratischen Ausschnitts (Mitte r/c, Kantenlänge s, Pixel); < 0 = kein Gesicht */
export type ClassifyRegion = (r: number, c: number, s: number, pixels: ArrayLike<number>, ldim: number) => number;

/** [Zeile der Mitte, Spalte der Mitte, Kantenlänge, Bewertung] in Pixeln */
export type PicoDetection = [r: number, c: number, s: number, q: number];

export interface PicoImage {
  /** Graustufen, eine Zeile nach der anderen */
  pixels: ArrayLike<number>;
  nrows: number;
  ncols: number;
  /** Zeilenlänge in pixels (meist = ncols) */
  ldim: number;
}

export interface PicoParams {
  shiftfactor: number;
  minsize: number;
  maxsize: number;
  scalefactor: number;
}

declare const pico: {
  unpack_cascade(bytes: Int8Array): ClassifyRegion;
  run_cascade(image: PicoImage, classify: ClassifyRegion, params: PicoParams): PicoDetection[];
  cluster_detections(dets: PicoDetection[], iouthreshold: number): PicoDetection[];
  instantiate_detection_memory(size: number): (dets: PicoDetection[]) => PicoDetection[];
};

export default pico;
