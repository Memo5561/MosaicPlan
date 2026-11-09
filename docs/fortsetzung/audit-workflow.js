export const meta = {
  name: 'mosaicplan-audit',
  description: 'Audit MosaicPlan across 8 dimensions, adversarially verify each finding, synthesize an implementation plan',
  phases: [
    { title: 'Audit', detail: '8 parallel specialist auditors (read-only)' },
    { title: 'Verify', detail: '2 independent skeptics per finding' },
    { title: 'Plan', detail: 'synthesize prioritized work packages' },
  ],
}

const SP = '/tmp/claude-0/-home-user-MosaicPlan/2af1e5b3-d1bd-540e-aeb5-6edf8b6b0ca5/scratchpad/audit'

const SPEC = `ORIGINAL USER REQUIREMENTS (German user, personal use) for "MosaicPlan":
1 Upload any photo -> realistic glass/ceramic mosaic; show per stone: position, color, size, shape, whether it must be cut, cut dimensions, count per color, how everything assembles. Must be buildable with real tiles.
2 Free project size (cm and m), e.g. 30x40cm up to 1000x500cm, no max.
3 Tile sizes 2x2..12x12 mm, custom (3x5, 4x8, 6x10, 8x12), and DIFFERENT tile sizes within one project with real computed positions/dimensions per stone.
4 Joint width 0/0.5/1/1.5/2/3 mm + custom; must be included in finished size calc.
5 Shapes: square, rectangular, triangular, rhombus, trapezoid, individually cut, freeform with own contour. App auto-suggests shapes; finer & custom cut stones in complex areas (faces, eyes, hair, contours). Cut template with contour+dimensions for each custom stone. Must distinguish shape recommendation vs. geometrically computed cut template.
6 Photo: upload, crop, rotate, brightness, contrast, saturation, sharpen, simplify background, emphasize details, optimize colors. Realistic mosaic preview. CIELAB + Delta-E, k-means. Faces must not be distorted.
7 Color count 8/12/16/24/32/48/64/100/150/200; add/remove own colors; unique numbers (01=Weiss...); per color: number, swatch, HEX, CIELAB, stone count, material need; match against real tiles.
8 Material DB: type, manufacturer, product, color number, color, length, width, thickness, price, package size, pieces per pack; glass/ceramic/other; prefer owned colors; suggest nearest when missing.
9 Stone-by-stone laying plan: unique IDs (A001 X0 Y0 ...), overview, numbered grid, positions, color codes, shapes, sizes, cut dims, coordinates from a defined origin, legend, quantities. Each stone counted once; totals must match geometry.
10 Huge projects (hundreds of thousands to millions of stones) with tile-based computation; auto split into sections A1|A2.. each with number, position, laying plan, legend, counts, joining marks; sections fit exactly; edit/print sections separately.
11 Material calc: total, per color/shape/size, material need, m2, waste, reserve 5/10/15/20/custom; distinguish grid positions, stone areas, joints.
12 PDF: cover, original photo, preview, overview, numbered laying sheets, legend, material list, cut templates, coordinates, counts, page numbers; A4/A3/large/custom; auto multi-page with exact joining marks; printed grids must align exactly.
13 Click any stone -> detail (position, color, code, size, shape, coords, cut instruction, neighbors); manually change single stones (e.g. lighter blue); totals update automatically.
14 Progress: mark stones laid; show laid/open/finished sections/remaining/percent; persisted.
15 Modern high-quality design, app name MosaicPlan, German default + English + Turkish. Home: New project, Upload photo, My projects, Materials, Settings. Simple 10-step flow.
16 Web app for PC, tablet, Android phone (now ALSO shipped as an Android APK via Capacitor). Preferably React, TS, Canvas/WebGL, OpenCV, CIELAB, IndexedDB, Web Workers, PDF lib. No paid cloud, local data, offline.
17 Test everything (stones complete, coords, dims, joints, unique codes, counts, PDF==preview, sections, persistence). Test projects: human portrait, landscape, animal, cityscape.
18 Mark incomplete features as incomplete; never invent results or show wrong cut dimensions.
The user has now said: "make EVERYTHING clearly much, much better".`

const CONTEXT = `You are auditing the MosaicPlan app in /home/user/MosaicPlan (React 19 + TypeScript + Vite PWA, Capacitor Android wrapper in android/). Read README.md first for architecture, definitions and the honest limitations table.
Key code: src/core/* (pure TS: color.ts, geometry.ts, layout.ts, pieces.ts, mosaic.ts, kmeans.ts, imageOps.ts, stats.ts, edits.ts, render.ts, pdf.ts, csv.ts, serialize.ts, types.ts), src/workers/* (compute.worker.ts, client.ts, protocol.ts), src/ui/* (App.tsx, Home, Projects, Materials, Settings, components.tsx, styles.css, project/{Workspace,useProject,Step*,Viewer,StoneDialog,CropEditor,CutTemplateSvg,imagePrep}.tsx), src/i18n/{de,en,tr}.ts, src/platform.ts (Capacitor native save/share), tests/*.test.ts (vitest), e2e/run-e2e.cjs (Playwright).
${SPEC}

RULES (strict):
- READ-ONLY on the repository: do NOT edit, create or delete any file under /home/user/MosaicPlan, do NOT run npm run build / npm install / git commands that change state. Write all your scratch scripts, screenshots, PDFs and outputs ONLY under your own folder ${SP}/<your-dimension>/ (create it).
- A production build is already served at http://localhost:4173/ (vite preview). Use it for browser checks. Do not restart or rebuild it.
- Browser automation: write .cjs scripts that do require('playwright'); chromium.launch() needs no options. Each script gets its own fresh browser context (IndexedDB isolated). Test projects are on the home page (data-testid="sample-portrait|sample-landscape|sample-animal|sample-city"); useful test ids: compute-btn, mosaic-canvas, step-<photo|size|tiles|joint|colors|shapes|compute|preview|plan|pdf>, stone-id, cut-instructions, color-pick, progress-pct, placed-count, pdf-btn, width-input, height-input, tile-presets, lang-select, new-project, home-photo, add-material. See e2e/run-e2e.cjs for a working example flow.
- Run TypeScript snippets against the core with: npx tsx <script.ts> using ABSOLUTE imports like import { computeMosaic } from '/home/user/MosaicPlan/src/core/mosaic'. tests/helpers.ts has loadPng/prepareFor helpers (import it absolutely). Sample images: /home/user/MosaicPlan/public/samples/{portrait,landscape,animal,city}.png (synthetic SVG renders). You MAY download a few public-domain/CC0 real photos (e.g. Wikimedia Commons) into your scratch folder for realistic evaluation.
- pdftoppm and ImageMagick (convert/montage/identify) are available for rendering/inspecting PDFs and images. Look at your screenshots/renders with the Read tool (it shows images).
- Evidence over opinion: every finding must cite concrete evidence (file:line, a reproduction script path + its output, a screenshot path, or a measurement). Do not report speculative issues you could not check.
- Proposals must be concrete and implementable (what to change, where, how), and must respect requirement 18 (never invent results, never show wrong cut dimensions).
- Rate impact 1-5 (5 = the user would clearly notice / correctness or data-loss) and effort S/M/L.
Return 6-15 findings, most impactful first. Quality over quantity.`

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          kind: { type: 'string', enum: ['bug', 'quality', 'ux', 'performance', 'missing-feature', 'robustness'] },
          problem: { type: 'string' },
          evidence: { type: 'string' },
          proposal: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          impact: { type: 'integer', minimum: 1, maximum: 5 },
          effort: { type: 'string', enum: ['S', 'M', 'L'] },
        },
        required: ['title', 'kind', 'problem', 'evidence', 'proposal', 'files', 'impact', 'effort'],
      },
    },
  },
  required: ['findings'],
}

const DIMS = [
  { key: 'algo-quality', prompt: `DIMENSION: Mosaic output QUALITY and REALISM (the core value). Run computeMosaic (src/core/mosaic.ts) on all four samples and on 1-3 real public-domain photos you download (ideally a real human face portrait). Render results (renderFull from src/core/render.ts needs OffscreenCanvas which Node lacks - instead write your own simple PNG renderer with pngjs from cellPieces(), or use the browser at :4173 and screenshot the preview). Compare to the source visually AND numerically (mean/95p deltaE, edge alignment, structure). Judge: face fidelity (eyes, mouth, skin gradients), contour/edge following, palette selection (are important small-area colors lost? skin tones?), dithering artifacts, usefulness and craft-realism of the chosen cut shapes (would a real mosaicist cut these? too many slivers? quantized 15deg line cuts adequate?), adaptive detail (subdivision), andamento/flow (real mosaics follow contours - could the app offer contour-following laying?). Propose concrete algorithm improvements with expected measurable gains.` },
  { key: 'ux-desktop', prompt: `DIMENSION: Desktop UX and visual design (1440x900). Walk the full journey in the browser: home, new project without photo, upload a photo (use public/samples/*.png via setInputFiles on data-testid=photo-input or home-photo), all 10 steps, stone dialog, freeform editor, palette editing, materials CRUD and CSV import/export, projects list, settings, language switch. Screenshot every screen and READ them. Critique: clarity of the 10-step flow for a non-technical German hobby mosaicist, wording/terminology (German quality, jargon like "ΔE"/"K-Means" exposure), information hierarchy, visual polish and consistency, feedback/progress, empty/error states, discoverability (e.g. how to change a stone, how to print one section), defaults (are defaults good for a first result?), what a "premium" app would do differently. Concrete UI proposals with component/file names.` },
  { key: 'ux-mobile-android', prompt: `DIMENSION: Phone/tablet UX and Android-app (Capacitor) specifics. In the browser emulate phone (390x844, isMobile, hasTouch) and tablet (820x1180) and walk the full flow incl. viewer pan/pinch/tap, stone dialog, crop editor and region drawing by touch, stepper navigation, long tables, modals, keyboard input of numbers with comma. Screenshot and READ everything; find overflow, tiny tap targets (<40px), unusable controls, layout breaks. Then review Android specifics by reading android/ (MainActivity, AndroidManifest, capacitor.config.ts), src/platform.ts, src/main.tsx: hardware BACK button behaviour (does it exit the app instead of closing dialogs/going back a step?), status bar/safe areas/edge-to-edge on Android 15+, app pause/kill -> are pending debounced saves flushed (visibilitychange/pagehide fire in WebView?), file saving to Documents on Android 10+ (scoped storage: will Directory.Documents writes fail?), share sheet, photo picker / camera capture, large image memory in WebView, splash/icons, WebView version assumptions (module workers, OffscreenCanvas, structuredClone). Propose concrete fixes (e.g. @capacitor/app backButton listener, @capacitor/status-bar, etc.).` },
  { key: 'correctness-core', prompt: `DIMENSION: Correctness of the core computation (src/core). Do a deep adversarial code review AND write tsx scripts doing randomized/property testing over many parameter combinations (tile sizes 2-12 incl. rectangles, joints 0-3 incl. fractional, all edge modes, tiny and huge projects, minCut, subdivision k=2/3, line cuts at all 12 angles and offsets, rectangular non-square cells, edge-cut cells with splits, freeform pieces, materials with raw sizes different from tile size, rotated fits). Check invariants: pieces inside cell, no overlaps, min distance between pieces in a cell >= joint, stoneArea+jointArea=total, unique IDs, cut info consistent (polyInRaw congruent to piece, cut lines actually produce the piece, edges/angles correct, yieldPerRaw never over-optimistic e.g. two triangles of different colors from one raw stone, rectangle yield with kerf), classification correct, stats totals = sum of sections, serialization round trip, edits (removePaletteColor remap, setCellKind progress reset, replaceColor), csv correctness, parseCellId. Also review numeric robustness (floating errors at 1000x500cm, toFixed keys in CutCache collisions). Report each real bug with a minimal repro script and its output.` },
  { key: 'correctness-ui-state', prompt: `DIMENSION: Correctness of app state, persistence and data safety (src/ui/project/useProject.ts, Workspace.tsx, Step*.tsx, Viewer.tsx, StoneDialog.tsx, storage/db.ts, storage/projects.ts, workers/client.ts). Review for stale closures, race conditions (debounced saves vs. navigation/reload, compute while editing, stats responses out of order), data loss (recompute silently wipes manual edits and progress - is the user warned/confirmed? project import/export round trip incl. progress & custom palette & regions, duplicate), stale-detection correctness (computeKey), palette edits in each palette mode, materials mode with deleted materials, editing settings that change the grid after compute, memory leaks (object URLs, ImageBitmaps, workers), error handling (worker crash, IndexedDB quota). Reproduce suspected bugs in the browser at :4173 with Playwright scripts (reload mid-edit etc.) and report with evidence.` },
  { key: 'pdf-print', prompt: `DIMENSION: PDF laying plan quality and print accuracy (src/core/pdf.ts). Generate PDFs via tsx (see tests/pdf.test.ts for how to call generatePdf; pass fonts as base64 of public/fonts/DejaVuSans*.ttf) for several configs: A4 portrait 1:1 with 5mm stones; 2mm stones at 1:1 and 2:1; 12mm stones; A3 landscape; fit-to-page; custom paper; Turkish; a project with materials linked (build Material objects); with many cut templates. Render pages with pdftoppm at 100-150 dpi and READ them. Check: text overlaps/clipping, readability of codes, legend completeness, whether laying sheets at 1:1 really measure correctly (verify coordinates in the PDF content stream: e.g. distance between two cell rects equals pitch in mm), whether registration crosses of neighbouring sheets coincide in project coordinates, whether sheet splitting wastes paper, cover/overview quality, cut template legibility (dimension labels collisions), coordinate table usefulness, page count/size for large projects, missing requirement items. Propose concrete layout/content improvements.` },
  { key: 'performance-scale', prompt: `DIMENSION: Performance and scalability. Measure with tsx: computeMosaic and computeStats time and peak memory (process.memoryUsage) for ~50k, ~500k, ~2M, ~5M cells with shapes on/off; buildOverviewRGBA; generatePdf for a 200x100cm project (all sections) - time, page count, file size; packMosaic size. In the browser measure: compute time for a big project (set size via width-input/height-input and tile 4mm), viewer pan/zoom frame times at different zoom levels (use performance.now in page.evaluate around rAF or measure long tasks), stats recompute latency after a single stone edit, IndexedDB save latency, main-thread blocking (long tasks) during interactions. Identify the top bottlenecks with profiling evidence and propose concrete optimizations (incremental stats, OffscreenCanvas worker rendering, tile caching, avoiding full mosaic clone per stats request, typed-array pieces, etc.).` },
  { key: 'spec-gaps', prompt: `DIMENSION: Requirement coverage and feature gaps vs. the ORIGINAL USER REQUIREMENTS above, plus what would make this a genuinely professional mosaic planning tool. Go through each numbered requirement, check the actual implementation (code + browser), and classify: done / partial / missing / done-but-weak. Known partials per README: rhombus only via freeform, mixed tile sizes only via k x k subdivision, face detection only via browser API, no OpenCV, no undo. Propose concrete designs for the most valuable gaps, e.g.: true mixed-size zones (different base grids per region with exact joint handling at zone borders), rhombus/diamond and offset (brick/running bond) layouts, contour-following "opus vermiculatum" outline rows around important edges, undo/redo, color calibration from a photo of the user's real tiles, stock-aware palette (respect available quantities), print a single section quickly, compare original vs mosaic slider, per-section editing mode, guided laying mode (next stone suggestion), export to SVG/PNG of plans. For each proposal give an implementation sketch that respects exact geometry (no invented numbers).` },
]

phase('Audit')
const VERDICT = {
  type: 'object',
  properties: {
    real: { type: 'boolean' },
    worthIt: { type: 'boolean' },
    reasoning: { type: 'string' },
    correctedProposal: { type: 'string' },
  },
  required: ['real', 'worthIt', 'reasoning'],
}

const results = await pipeline(
  DIMS,
  (d) => agent(`${CONTEXT}\n\n${d.prompt}\n\nYour scratch folder: ${SP}/${d.key}/`, { label: `audit:${d.key}`, phase: 'Audit', schema: FINDINGS }),
  (r, d) =>
    parallel(
      (r?.findings ?? []).map((f, i) => () =>
        parallel([
          () => agent(`${CONTEXT}\n\nYou are a SKEPTIC verifying one audit finding from the "${d.key}" auditor. Try to REFUTE it: re-check the evidence yourself (read the cited code, re-run or write a minimal repro under ${SP}/verify-${d.key}-${i}/). Set real=false if the problem does not exist, is misdiagnosed, or is already handled. Set worthIt=false if the fix would not noticeably help the user or is unsafe. If the proposal is flawed but the problem is real, give a correctedProposal. Default to real=false when you cannot confirm.\n\nFINDING:\n${JSON.stringify(f, null, 2)}`, { label: `refute:${d.key}#${i}`, phase: 'Verify', schema: VERDICT }),
          () => agent(`${CONTEXT}\n\nYou judge the VALUE and SAFETY of one proposed improvement from the "${d.key}" auditor, from the perspective of the German hobby mosaicist user who wants a much, much better app. Check the cited code. Is the problem real as described (real)? Would implementing the proposal clearly improve the product without breaking exact geometry/count guarantees or inventing results (worthIt)? Suggest a better/safer correctedProposal if appropriate. Write any scratch files only under ${SP}/value-${d.key}-${i}/.\n\nFINDING:\n${JSON.stringify(f, null, 2)}`, { label: `value:${d.key}#${i}`, phase: 'Verify', schema: VERDICT }),
        ]).then((vs) => {
          const v = vs.filter(Boolean)
          const realVotes = v.filter((x) => x.real).length
          const worthVotes = v.filter((x) => x.worthIt).length
          return { ...f, dim: d.key, id: `${d.key}#${i}`, keep: realVotes === v.length && v.length > 0 && worthVotes >= 1, verdicts: v }
        }),
      ),
    ),
)

const all = results.filter(Boolean).flat().filter(Boolean)
const kept = all.filter((f) => f.keep)
const dropped = all.filter((f) => !f.keep)
log(`${all.length} findings, ${kept.length} verified, ${dropped.length} dropped`)

phase('Plan')
const PLAN = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    waves: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          packages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                goal: { type: 'string' },
                findingIds: { type: 'array', items: { type: 'string' } },
                ownedFiles: { type: 'array', items: { type: 'string' } },
                newFiles: { type: 'array', items: { type: 'string' } },
                steps: { type: 'array', items: { type: 'string' } },
                acceptance: { type: 'array', items: { type: 'string' } },
                risk: { type: 'string' },
              },
              required: ['id', 'title', 'goal', 'findingIds', 'ownedFiles', 'steps', 'acceptance'],
            },
          },
        },
        required: ['name', 'packages'],
      },
    },
    deferred: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'waves', 'deferred'],
}
const plan = await agent(
  `${CONTEXT}\n\nYou are the lead architect. Below are VERIFIED audit findings (each with skeptic verdicts and possibly corrected proposals - prefer correctedProposal when present). Produce an implementation plan that makes MosaicPlan "much, much better" for the user, prioritizing by user impact (correctness/data-safety first, then core mosaic quality, then UX on phone/Android and desktop, then PDF, then performance, then new features).\nOrganize work into WAVES of WORK PACKAGES. Packages in the same wave will be implemented IN PARALLEL by separate engineers in separate git worktrees and then merged, so within a wave each package must OWN a DISJOINT set of existing files (ownedFiles) - no file may appear in two packages of the same wave. Translation strings: tell packages to put NEW i18n keys in their own new file src/i18n/ext/<package-id>.ts exporting {de, en, tr} objects (an aggregator will merge them) instead of editing de.ts/en.ts/tr.ts. Each package: concrete steps referencing files/functions, and acceptance criteria that can be checked with vitest/tsx/Playwright. Keep packages coherent (one engineer, roughly 1-3 hours of focused work each). Use as many waves as needed (later waves may touch files from earlier waves). List anything you consciously defer.\n\nVERIFIED FINDINGS:\n${JSON.stringify(kept.map(({ verdicts, keep, ...f }) => ({ ...f, verdicts: verdicts.map((v) => ({ real: v.real, worthIt: v.worthIt, reasoning: v.reasoning, correctedProposal: v.correctedProposal })) })), null, 1)}`,
  { label: 'plan', phase: 'Plan', schema: PLAN },
)

return { plan, kept: kept.map(({ verdicts, keep, ...f }) => ({ ...f, corrected: verdicts.map((v) => v.correctedProposal).filter(Boolean) })), dropped: dropped.map((f) => ({ id: f.id, title: f.title, why: f.verdicts.map((v) => v.reasoning).join(' || ').slice(0, 400) })) }
