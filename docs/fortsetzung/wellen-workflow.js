export const meta = {
  name: 'mosaicplan-wave',
  description: 'Implement one wave of MosaicPlan work packages in parallel worktrees, merge, adversarially review and fix',
  phases: [
    { title: 'Implement', detail: 'one engineer per work package, isolated git worktree' },
    { title: 'Merge', detail: 'merge package branches, integration checks' },
    { title: 'Review', detail: 'diverse-lens review of the wave diff' },
    { title: 'Verify', detail: 'skeptic per review finding' },
    { title: 'Fix', detail: 'fix confirmed findings, full checks, push' },
  ],
}

const SP = '/tmp/claude-0/-home-user-MosaicPlan/2af1e5b3-d1bd-540e-aeb5-6edf8b6b0ca5/scratchpad'
const MAIN = '/home/user/MosaicPlan'
const BR = 'ccr-e3c91906-ceq1vn'
const ATTR = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01HRsuhChU65a7esy7yzLDx5'
const { wave, ids, baseSha } = args

const COMMON = `Project: MosaicPlan, a personal German mosaic-planning app (React 19 + TS + Vite PWA, Capacitor Android wrapper in android/). Main checkout: ${MAIN} on branch ${BR}. Read README.md for architecture and exact-geometry definitions. The user (German hobby mosaicist) asked to make EVERYTHING much, much better. Non-negotiable: exact geometry and counts (totals equal geometry, cut dims only from analyzeCut on real polygons), never invent results, estimates labelled "Schätzung"/"Richtwert", incomplete features marked as incomplete (requirement 18). German is the default UI language, English and Turkish must stay complete.
Tools: npx tsx <file.ts> runs TS scripts; Playwright via require('playwright') in .cjs scripts (chromium.launch() needs no options); pdftoppm + ImageMagick available; Read tool shows images. Commit messages in German, ending with these two lines:\n${ATTR}`

const PKG_RESULT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    branch: { type: 'string' },
    commit: { type: 'string' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    outOfOwnershipEdits: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, status: { type: 'string', enum: ['pass', 'fail', 'partial', 'not-run'] }, evidence: { type: 'string' } }, required: ['criterion', 'status', 'evidence'] } },
    checks: { type: 'object', properties: { typecheck: { type: 'boolean' }, tests: { type: 'boolean' }, build: { type: 'boolean' }, e2e: { type: 'boolean' } }, required: ['typecheck', 'tests', 'build', 'e2e'] },
    notes: { type: 'string' },
  },
  required: ['id', 'branch', 'commit', 'summary', 'filesChanged', 'acceptance', 'checks', 'notes'],
}

phase('Implement')
const pkgResults = await parallel(ids.map((id, i) => () => agent(`${COMMON}

You are the engineer for work package "${id}" of wave ${wave}. Your full briefing (package goal, steps, acceptance criteria, owned files, the verified audit findings with evidence and skeptic-corrected proposals, global rules, deferred items, and the other packages running IN PARALLEL with their owned files) is in: ${SP}/plan/${id}.json — read it completely first. The briefing was written BEFORE earlier waves were implemented: also read the reports of all earlier waves in ${SP}/plan/wave*-report.json (deviations from the plan, new APIs, contracts actually delivered, decisions) and then the CURRENT source code — the code is the source of truth where it differs from the briefing.

You work in an ISOLATED git worktree (your current working directory). Setup, exactly:
  1. git checkout -B wp/${id} ${BR}   (start from the current tip of ${BR}; verify with git log -1)
  2. if [ ! -e node_modules ]; then ln -s ${MAIN}/node_modules node_modules; fi   (do NOT run npm install unless your package explicitly adds a dependency; if it does, run npm install in your worktree and include package.json + package-lock.json changes)
  NEVER modify files in ${MAIN} (the main checkout) and never push.

Implementation rules:
- Implement the package goal fully and with high quality. Follow the steps, but if a step is wrong or unsafe after reading the code, do the right thing and explain in notes. Prefer correctedProposal from skeptic verdicts.
- Only edit your ownedFiles plus brand-new files unique to your package (src/i18n/ext/${id}.ts for new translation keys with de/en/tr; src/ui/css/${id}.css for CSS unless you own styles.css; tests/${id}*.test.ts; e2e/${id}.e2e.cjs). Do NOT edit de.ts/en.ts/tr.ts. If an edit outside ownership is truly unavoidable, keep it minimal and list it in outOfOwnershipEdits (other packages edit their files concurrently; overlaps cause merge conflicts).
- Write unit tests for logic and a Playwright e2e script e2e/${id}.e2e.cjs for UI behaviour (usage: node e2e/${id}.e2e.cjs <baseUrl> <outDir>; exit code 0 on success; print ✔/✘ lines).
- Verify before committing, in your worktree: npm run typecheck; npm test; npm run build; then serve with: npx vite preview --port ${4300 + i} --strictPort (in background) and run node e2e/run-e2e.cjs http://localhost:${4300 + i}/ ${SP}/wave${wave}/${id}/e2e AND your own e2e script; look at screenshots of the UI you changed (Read tool) and polish. Kill your preview server afterwards. Everything must be green; the existing e2e must keep passing (if your change intentionally alters something the existing e2e asserts, adjust your understanding — do not edit e2e/run-e2e.cjs; report it in notes).
- Commit all work on branch wp/${id} (git add -A; exclude node_modules symlink and dist — check git status; the symlink must NOT be committed). Return the result object.`, { label: `impl:${id}`, phase: 'Implement', schema: PKG_RESULT, isolation: 'worktree' })))

const done = pkgResults.filter(Boolean)
log(`Implemented ${done.length}/${ids.length} packages: ${done.map((r) => `${r.id}(${Object.values(r.checks).every(Boolean) ? 'green' : 'issues'})`).join(', ')}`)

phase('Merge')
const MERGE = {
  type: 'object',
  properties: {
    merged: { type: 'array', items: { type: 'string' } },
    skipped: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, reason: { type: 'string' } }, required: ['id', 'reason'] } },
    headSha: { type: 'string' },
    checks: { type: 'string' },
    integrationFixes: { type: 'string' },
  },
  required: ['merged', 'skipped', 'headSha', 'checks', 'integrationFixes'],
}
const merge = await agent(`${COMMON}

You are the integrator for wave ${wave}. Work in the MAIN checkout ${MAIN} (branch ${BR}). The wave base commit is ${baseSha}. Package engineers committed their work on local branches wp/<id> (git branch --list 'wp/*'). Their reports:
${JSON.stringify(done.map((r) => ({ id: r.id, branch: r.branch, commit: r.commit, summary: r.summary, checks: r.checks, outOfOwnershipEdits: r.outOfOwnershipEdits, notes: r.notes, failedAcceptance: r.acceptance.filter((a) => a.status !== 'pass') })), null, 1)}
Packages expected: ${ids.join(', ')} (missing ones failed to report). Package briefings: ${SP}/plan/<id>.json.

Steps:
1. Ensure ${MAIN} is clean (git status). Merge each package branch into ${BR} with git merge --no-ff wp/<id> -m "Merge <id>: <title>" (+ attribution lines). Resolve conflicts carefully, preserving the intent of BOTH sides (read both briefings). If a branch is fundamentally broken (does not compile, failing tests that you cannot fix with a small change), you may skip it (git merge --abort) and report why — prefer fixing.
2. After merging, run in ${MAIN}: npm run typecheck; npm test; npm run build. Restart the shared preview server on port 4173 (pkill -f "vite preview --port 4173"; then nohup npx vite preview --port 4173 --strictPort > ${SP}/preview.log 2>&1 &) and run node e2e/run-e2e.cjs http://localhost:4173/ ${SP}/wave${wave}/merged-e2e plus every e2e/w*.e2e.cjs script present. Fix integration bugs (commit fixes with clear German messages). Leave the 4173 preview server running at the end.
3. git push origin ${BR} (retry on network errors). Return the report (headSha = git rev-parse HEAD).`, { label: `merge:wave${wave}`, phase: 'Merge', schema: MERGE })

phase('Review')
const FIND = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'integer', minimum: 1, maximum: 5 },
          file: { type: 'string' },
          problem: { type: 'string' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['title', 'severity', 'file', 'problem', 'evidence', 'fix'],
      },
    },
  },
  required: ['findings'],
}
const LENSES = [
  { key: 'correctness', text: 'logic bugs, wrong edge-case handling, broken invariants, stale closures, race conditions, data loss, broken persistence. Write repro scripts (tsx / Playwright) for every claim.' },
  { key: 'geometry-honesty', text: 'exact geometry/count guarantees and requirement 18: any place where totals no longer match geometry, cut dimensions not derived from analyzeCut polygons, estimates not labelled, invented numbers, misleading UI claims, incomplete features not marked. Verify with tsx scripts.' },
  { key: 'ux-regressions', text: 'user-visible regressions and polish problems on desktop (1440x900) AND phone (390x844 touch): walk all changed screens in the browser at http://localhost:4173/ (rebuilt by the integrator), screenshot and READ them; broken layouts, untranslated keys (also switch to English and Turkish), confusing German wording, dead buttons, console errors.' },
  { key: 'integration', text: 'cross-package integration problems from merging parallel packages: duplicated logic, conflicting assumptions, a contract one package expected that another did not deliver, tests that pass in isolation but mask broken behaviour, performance regressions on big projects (e.g. 1000x500 cm at 4 mm), Android/Capacitor implications.' },
]
const reviewed = await pipeline(
  LENSES,
  (l) => agent(`${COMMON}

Review the code changes of wave ${wave}: git -C ${MAIN} diff ${baseSha}..HEAD (read package briefings ${SP}/plan/<id>.json for ${ids.join(', ')} to know the intent). Lens: ${l.text}
READ-ONLY on the repository (do not edit files in ${MAIN}, do not rebuild); scratch files only under ${SP}/wave${wave}/review-${l.key}/. The current build is served at http://localhost:4173/. Report only real, evidenced problems (0-12 findings), most severe first.`, { label: `review:${l.key}`, phase: 'Review', schema: FIND }),
  (r, l) =>
    parallel(
      (r?.findings ?? []).map((f, i) => () =>
        agent(`${COMMON}

You are a SKEPTIC. Try to REFUTE this review finding about wave ${wave} (diff ${baseSha}..HEAD in ${MAIN}). Re-check the code and reproduce it yourself (scratch only under ${SP}/wave${wave}/verify-${l.key}-${i}/, read-only on the repo, build served at http://localhost:4173/). Set real=false if it is not reproducible, misdiagnosed, intended behaviour, or already handled; default to real=false when uncertain.
FINDING: ${JSON.stringify(f)}`, { label: `verify:${l.key}#${i}`, phase: 'Verify', schema: { type: 'object', properties: { real: { type: 'boolean' }, reasoning: { type: 'string' }, betterFix: { type: 'string' } }, required: ['real', 'reasoning'] } }).then((v) => (v && v.real ? { ...f, lens: l.key, betterFix: v.betterFix, verifyReason: v.reasoning } : null)),
      ),
    ),
)
const confirmed = reviewed.filter(Boolean).flat().filter(Boolean)
log(`Review: ${confirmed.length} confirmed findings`)

phase('Fix')
const fix = await agent(`${COMMON}

You are the fixer for wave ${wave}. Work in the MAIN checkout ${MAIN} (branch ${BR}). Fix ALL of the following verified review findings properly (root cause, add/adjust tests where it makes sense). Then run npm run typecheck; npm test; npm run build; restart the preview on 4173 (pkill -f "vite preview --port 4173"; nohup npx vite preview --port 4173 --strictPort > ${SP}/preview.log 2>&1 &), run node e2e/run-e2e.cjs http://localhost:4173/ ${SP}/wave${wave}/final-e2e and every e2e/w*.e2e.cjs. Everything must be green. Commit (German message + attribution lines) and git push origin ${BR}. Leave the preview server running.
FINDINGS:
${JSON.stringify(confirmed, null, 1)}
Return a concise report: which findings were fixed how, final check results, final HEAD sha.`, { label: `fix:wave${wave}`, phase: 'Fix' })

return { pkgResults: done.map((r) => ({ id: r.id, summary: r.summary, checks: r.checks, notFullyPassed: r.acceptance.filter((a) => a.status !== 'pass'), notes: r.notes, outOfOwnershipEdits: r.outOfOwnershipEdits })), missing: ids.filter((id) => !done.find((r) => r.id === id)), merge, confirmed: confirmed.map((c) => ({ lens: c.lens, title: c.title, severity: c.severity })), fix }
