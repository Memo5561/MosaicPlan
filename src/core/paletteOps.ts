/**
 * Palettenänderungen an einem bereits berechneten Mosaik – ohne dass Steine still ihre Farbe wechseln.
 *
 * Grundregel: Palettenindizes in den Mosaikdaten bleiben gültig. Farben werden nur ANGEHÄNGT
 * (alte Indizes unverändert) oder über removePaletteColor in ABSTEIGENDER Indexreihenfolge entfernt
 * (nur die Steine der entfernten Farbe werden umgestellt, alle anderen behalten ihre Farbe und Nummer).
 * Es wird nie eine ganze Palette umsortiert.
 */
import { deltaE, hexToRgb, isValidHex, rgbToHex, type ColorNameLang, type DeltaEFormula } from './color';
import { addPaletteColor, removePaletteColor, updatePaletteColor } from './edits';
import { CellKind, type Material, type MosaicData, type PaletteColor } from './types';

/** HEX in einheitlicher Form „#RRGGBB“ (Großbuchstaben); ungültig → null. */
export function normHex(hex: string | undefined | null): string | null {
  if (!hex || !isValidHex(hex)) return null;
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r, g, b);
}

/**
 * Anzahl der Steine je Palettenindex. Zählt dieselben Teilstücke wie cellPieces (ganzer Stein 1,
 * Dreiecke/Kantenschnitt 2, k×k-Unterteilung k², Freiform je Kontur) – nur ohne Geometrie.
 * Indizes außerhalb der Palette werden (wie in computeStats) nicht gezählt.
 */
export function piecesPerColor(data: MosaicData, paletteLength: number): number[] {
  const out = new Array<number>(paletteLength).fill(0);
  const add = (c: number) => {
    if (c < paletteLength) out[c]++;
  };
  const n = data.kind.length;
  for (let i = 0; i < n; i++) {
    switch (data.kind[i]) {
      case CellKind.DIAG_A:
      case CellKind.DIAG_B:
        add(data.c1[i]);
        add(data.c2[i]);
        break;
      case CellKind.LINE:
        add(data.c1[i]);
        if (data.line.has(i)) add(data.c2[i]);
        break;
      case CellKind.SUB: {
        const s = data.sub.get(i);
        if (s) for (let q = 0; q < s.length; q++) add(s[q]);
        else add(data.c1[i]);
        break;
      }
      case CellKind.FREE:
        for (const f of data.free.get(i) ?? []) add(f.color);
        break;
      default:
        add(data.c1[i]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- Farbe entfernen

export interface ReplacementOption {
  index: number;
  deltaE: number;
}

export interface RemovalPlan {
  index: number;
  /** Steine dieser Farbe (0, wenn noch nicht berechnet) */
  pieces: number;
  /** Ersatzfarben nach ΔE aufsteigend; die erste ist der Vorschlag */
  options: ReplacementOption[];
}

/** Ersatzfarben (alle übrigen Farben, nächste zuerst) und Anzahl betroffener Steine für das Entfernen von palette[index]. */
export function planColorRemoval(palette: PaletteColor[], data: MosaicData | null, index: number, formula: DeltaEFormula): RemovalPlan {
  const l = palette[index].lab;
  const options = palette
    .map((p, i) => ({ index: i, deltaE: i === index ? Infinity : deltaE(formula, l, p.lab) }))
    .filter((o) => o.index !== index)
    .sort((a, b) => a.deltaE - b.deltaE || a.index - b.index);
  const pieces = data ? piecesPerColor(data, palette.length)[index] : 0;
  return { index, pieces, options };
}

// ---------------------------------------------------------------- Palette aus Materialien

export interface MergeRemoval {
  code: number;
  name: string;
  hex: string;
  pieces: number;
  targetCode: number;
  targetName: string;
  targetHex: string;
  deltaE: number;
}

export interface MergeRecolor {
  code: number;
  name: string;
  fromHex: string;
  toHex: string;
  pieces: number;
  deltaE: number;
}

export interface MaterialMergePlan {
  /** Ergebnis-Palette (vorhandene Farben mit unveränderter Nummer, neue Materialfarben angehängt) */
  palette: PaletteColor[];
  /** neu angehängte Materialfarben (mit neuen, noch nie vergebenen Nummern dieser Palette) */
  added: PaletteColor[];
  /** Farben ohne passendes Material – ihre Steine erhalten die nächste verbleibende Farbe (ΔE) */
  removed: MergeRemoval[];
  /** Anzahl Farben, die über gleichen HEX-Wert mit einem Material verknüpft werden */
  linked: number;
  /** verknüpfte Farben, deren Materialfarbe sich geändert hat (HEX wird übernommen, Steine behalten ihre Nummer) */
  recolored: MergeRecolor[];
  /** Steine, die auf eine andere Farbe umgestellt werden (Summe der Steine aller entfernten Farben) */
  movedStones: number;
  /** größtes ΔE zwischen entfernter Farbe und Ersatzfarbe über alle entfernten Farben mit Steinen (0 = keine) */
  maxDeltaE: number;
  /** nichts zu tun – die Palette entspricht bereits den Materialien */
  unchanged: boolean;
  /** keine Material-Farbe mit gültigem HEX-Wert → Zusammenführen nicht möglich */
  noValidMaterials: boolean;
  /** intern: Palette nach Verknüpfen/Umfärben/Anhängen, vor dem Entfernen */
  staged: PaletteColor[];
  /** intern: zu entfernende Indizes in `staged` (absteigend) und ihre Ersatzfarbe (Index in `staged`) */
  removeIdx: number[];
  targetIdx: number[];
}

/**
 * Plant „Palette aus Materialien“ für eine vorhandene Palette, ohne etwas zu verändern.
 *  1. Jede Palettenfarbe sucht ihr Material: zuerst über materialId, dann über exakt gleichen HEX-Wert.
 *  2. Materialien ohne Palettenfarbe werden angehängt (addPaletteColor, neue Nummern).
 *  3. Palettenfarben ohne Material werden entfernt; ihre Steine erhalten die nach ΔE nächste verbleibende Farbe.
 */
export function planMaterialMerge(
  palette: PaletteColor[],
  data: MosaicData | null,
  materials: Material[],
  formula: DeltaEFormula,
  lang: ColorNameLang = 'de',
): MaterialMergePlan {
  const valid = materials.map((m) => ({ m, hex: normHex(m.hex) })).filter((x): x is { m: Material; hex: string } => x.hex !== null);
  const byId = new Map(valid.map((x) => [x.m.id, x]));
  const byHex = new Map<string, { m: Material; hex: string }>();
  for (const x of valid) if (!byHex.has(x.hex)) byHex.set(x.hex, x);
  const pieces = data ? piecesPerColor(data, palette.length) : palette.map(() => 0);

  // 1. Verknüpfen
  let staged = palette;
  const covered = new Set<string>();
  const keep: boolean[] = [];
  let linked = 0;
  const recolored: MergeRecolor[] = [];
  palette.forEach((p, i) => {
    const viaId = p.materialId ? byId.get(p.materialId) : undefined;
    const match = viaId ?? byHex.get(normHex(p.hex) ?? '');
    if (!match) {
      keep.push(false);
      return;
    }
    keep.push(true);
    covered.add(match.m.id);
    if (!viaId) {
      linked++;
      staged = updatePaletteColor(staged, i, { materialId: match.m.id });
    } else if (normHex(p.hex) !== match.hex) {
      staged = updatePaletteColor(staged, i, { hex: match.hex });
      recolored.push({ code: p.code, name: p.name, fromHex: p.hex, toHex: match.hex, pieces: pieces[i], deltaE: deltaE(formula, p.lab, staged[i].lab) });
    }
  });

  // 2. Fehlende Materialien anhängen (vor dem Entfernen: so kollidieren neue Nummern nie mit entfernten).
  //    Ein Material mit exakt derselben Farbe wie eine verbleibende Palettenfarbe wird nicht doppelt aufgenommen.
  const presentHex = new Set(staged.filter((_, i) => keep[i]).map((p) => normHex(p.hex)));
  const before = staged.length;
  for (const x of valid) {
    if (covered.has(x.m.id) || presentHex.has(x.hex)) continue;
    staged = addPaletteColor(staged, x.hex, x.m.colorName || x.m.colorNumber, lang, x.m.id);
    presentHex.add(x.hex);
    keep.push(true);
  }
  const added = staged.slice(before);

  // 3. Entfernen planen (Ersatz = nächste verbleibende Farbe nach ΔE, exakt über alle Kandidaten)
  const removeIdx: number[] = [];
  const targetIdx: number[] = [];
  const removed: MergeRemoval[] = [];
  // Mit mindestens einem gültigen Material bleibt immer mindestens eine Farbe (verknüpft oder angehängt).
  const noValidMaterials = valid.length === 0;
  if (!noValidMaterials) {
    for (let i = palette.length - 1; i >= 0; i--) {
      if (keep[i]) continue;
      let best = -1;
      let bd = Infinity;
      for (let j = 0; j < staged.length; j++) {
        if (!keep[j]) continue;
        const d = deltaE(formula, staged[i].lab, staged[j].lab);
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      removeIdx.push(i);
      targetIdx.push(best);
      const t = staged[best];
      removed.push({ code: palette[i].code, name: palette[i].name, hex: palette[i].hex, pieces: pieces[i], targetCode: t.code, targetName: t.name, targetHex: t.hex, deltaE: bd });
    }
    removed.reverse();
  }
  const movedStones = removed.reduce((s, r) => s + r.pieces, 0);
  const maxDeltaE = removed.reduce((m, r) => (r.pieces > 0 ? Math.max(m, r.deltaE) : m), 0);
  return {
    palette: noValidMaterials ? palette : staged.filter((_, i) => keep[i]),
    added,
    removed,
    linked,
    recolored,
    movedStones,
    maxDeltaE,
    unchanged: !noValidMaterials && added.length === 0 && removed.length === 0 && linked === 0 && recolored.length === 0,
    noValidMaterials,
    staged,
    removeIdx,
    targetIdx,
  };
}

/**
 * Führt einen Plan aus: entfernt die Farben über removePaletteColor in absteigender Indexreihenfolge
 * (mit der geplanten Ersatzfarbe). `data` wird dabei umgeschrieben; ohne Daten wird nur die Palette gefiltert.
 */
export function applyMaterialMerge(plan: MaterialMergePlan, data: MosaicData | null, formula: DeltaEFormula): PaletteColor[] {
  if (plan.noValidMaterials) throw new Error('Keine Materialfarbe mit gültigem HEX-Wert.');
  let cur = plan.staged;
  // alive[k] = Index in `staged` der Farbe, die aktuell an Position k steht
  const alive = cur.map((_, i) => i);
  plan.removeIdx.forEach((r, n) => {
    const at = alive.indexOf(r);
    const to = alive.indexOf(plan.targetIdx[n]);
    cur = data ? removePaletteColor(cur, data, at, to, formula) : cur.filter((_, i) => i !== at);
    alive.splice(at, 1);
  });
  return cur;
}

/**
 * „Palette aus Materialien“ für ein berechnetes Mosaik: anhängen statt ersetzen, nur Farben ohne Material
 * entfernen (Steine → nächste verbleibende Farbe). Liefert die neue Palette und die umgestellten Steine.
 */
export function mergePaletteFromMaterials(
  palette: PaletteColor[],
  data: MosaicData | null,
  materials: Material[],
  formula: DeltaEFormula,
  lang: ColorNameLang = 'de',
): { palette: PaletteColor[]; movedStones: number; maxDeltaE: number; plan: MaterialMergePlan } {
  const plan = planMaterialMerge(palette, data, materials, formula, lang);
  return { palette: applyMaterialMerge(plan, data, formula), movedStones: plan.movedStones, maxDeltaE: plan.maxDeltaE, plan };
}
