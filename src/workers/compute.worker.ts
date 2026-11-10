/// <reference lib="webworker" />
import { applyAdjustments } from '../core/imageOps';
import { buildCsv } from '../core/csv';
import { computeLayout, sectionsFor } from '../core/layout';
import { computeMosaic } from '../core/mosaic';
import { generatePdf, pdfLayoutFacts } from '../core/pdf';
import { packMosaic, transferablesOf, unpackMosaic } from '../core/serialize';
import { computeAllStats } from '../core/stats';
import type { WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

const post = (m: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(m, transfer);

let fontCache: { regular: string; bold: string } | null = null;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

async function loadFonts(base: string): Promise<{ regular: string; bold: string } | undefined> {
  if (fontCache) return fontCache;
  try {
    const [r, b] = await Promise.all([fetch(`${base}fonts/DejaVuSans.ttf`), fetch(`${base}fonts/DejaVuSans-Bold.ttf`)]);
    if (!r.ok || !b.ok) return undefined;
    fontCache = { regular: toBase64(await r.arrayBuffer()), bold: toBase64(await b.arrayBuffer()) };
    return fontCache;
  } catch {
    return undefined;
  }
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'compute': {
        const layout = computeLayout(msg.layoutParams);
        post({ type: 'progress', id: msg.id, phase: 'adjust', fraction: 0 });
        const processed = applyAdjustments(msg.image, msg.adjust, msg.regions);
        post({ type: 'progress', id: msg.id, phase: 'adjust', fraction: 1 });
        const res = computeMosaic(processed, { ...msg.params, layout, regions: msg.regions }, (phase, fraction) =>
          post({ type: 'progress', id: msg.id, phase, fraction }),
        );
        const packed = packMosaic(res.data);
        post(
          { type: 'compute', id: msg.id, mosaic: packed, palette: res.palette, diagnostics: res.diagnostics, processed },
          [...transferablesOf(packed), processed.data.buffer as ArrayBuffer],
        );
        break;
      }
      case 'stats': {
        const layout = computeLayout(msg.layoutParams);
        const data = unpackMosaic(msg.mosaic);
        const opts = { reservePct: msg.reservePct, groutDepthMm: msg.groutDepthMm, minPieceMm: msg.minPieceMm };
        // EIN Durchlauf für Gesamt und (falls angefragt) alle Abschnitte – exakt dieselben Zahlen wie je Bereich
        const grid = msg.sections ? sectionsFor(layout, msg.sections) : null;
        const all = computeAllStats(layout, data, msg.palette, msg.materials, opts, grid);
        const perSection = grid ? grid.sections.map((s, i) => ({ id: s.id, stats: all.perSection[i] })) : [];
        post({ type: 'stats', id: msg.id, total: all.total, perSection });
        break;
      }
      case 'pdf': {
        const layout = computeLayout(msg.layoutParams);
        const data = unpackMosaic(msg.mosaic);
        const sections = sectionsFor(layout, msg.settings);
        const fonts = await loadFonts(msg.fontsBase);
        const t = (key: string, params?: Record<string, string | number>) => {
          let s = msg.dict[key] ?? key;
          if (params) for (const [k, v] of Object.entries(params)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
          return s;
        };
        const pdf = await generatePdf(
          {
            projectName: msg.projectName,
            dateStr: msg.dateStr,
            layout,
            data,
            palette: msg.palette,
            materials: msg.materials,
            settings: msg.settings,
            sections,
            original: msg.original,
            preview: msg.preview,
            t,
            locale: msg.locale,
            fonts,
          },
          msg.options,
          (f, label) => post({ type: 'progress', id: msg.id, phase: label, fraction: f }),
        );
        post({ type: 'pdf', id: msg.id, pdf }, [pdf]);
        break;
      }
      case 'pdfPlan': {
        // Seitenplan vorab messen: derselbe Generator im Trockenlauf (ohne Bilder und Blätter), von den Bildern nur die Maße
        const layout = computeLayout(msg.layoutParams);
        const data = unpackMosaic(msg.mosaic);
        const sections = sectionsFor(layout, msg.settings);
        const fonts = await loadFonts(msg.fontsBase);
        const t = (key: string, params?: Record<string, string | number>) => {
          let s = msg.dict[key] ?? key;
          if (params) for (const [k, v] of Object.entries(params)) s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
          return s;
        };
        const facts = pdfLayoutFacts(
          {
            projectName: msg.projectName,
            dateStr: msg.dateStr,
            layout,
            data,
            palette: msg.palette,
            materials: msg.materials,
            settings: msg.settings,
            sections,
            original: msg.originalSize ? { dataUrl: '', ...msg.originalSize } : undefined,
            preview: msg.previewSize ? { dataUrl: '', ...msg.previewSize } : undefined,
            t,
            locale: msg.locale,
            fonts,
          },
          msg.options,
        );
        post({ type: 'pdfPlan', id: msg.id, facts });
        break;
      }
      case 'csv': {
        const layout = computeLayout(msg.layoutParams);
        const data = unpackMosaic(msg.mosaic);
        const sections = sectionsFor(layout, msg.sections);
        const csv = buildCsv(layout, data, msg.palette, msg.materials, sections, msg.sectionIds, msg.decimalComma, msg.lang);
        post({ type: 'csv', id: msg.id, csv });
        break;
      }
    }
  } catch (e) {
    post({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) });
  }
};
