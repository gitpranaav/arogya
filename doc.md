# MediFlow — verification record

Updated 2026-10-26. Current decision: **release verification incomplete; not production/clinically validated**. [TODO.md](TODO.md) owns release gates; [README.md](README.md) owns setup/demo commands; [CODEBASE_MAP.md](CODEBASE_MAP.md) owns architecture and collection contracts.

## Project setup and runtime verification — 2026-10-26

Scope expanded to full local setup and testing. Environment: macOS, Node 26.7.0, npm 11.19.0, Next 16.2.2, MongoDB 7 replica set `rs0` in Docker container `mediflow-demo-rs`, loopback port 27029. Production app: `http://127.0.0.1:3000`. All records/audio were synthetic; no production database was accessed. Local credentials are Git-ignored.

| Command / check | Observed result |
|---|---|
| `npm run typecheck` | **Pass**, exit 0; all 15 original diagnostics fixed without bypasses. |
| `NEXT_TELEMETRY_DISABLED=1 npm run build` | **Pass**, exit 0; production routes compile. Middleware-to-proxy deprecation remains. |
| `npm test` | **Pass, 137/137** synthetic/mocked regressions; no compiler-path override. |
| `seed:core`, `seed:icd10`, `seed:medications`, `demo:seed` | **Pass**; local indexes, 26 ICD codes, 123 catalog products and two synthetic practices. |
| `npm run verify:mongo` | **Pass, 5/5** real replica-set primitive checks. |
| `npm run verify:stage9:api` | **Pass, 14/14** HTTP smoke checks. |
| `npm run verify:system` | **Pass, 72/72** real database/production HTTP checks with a local Groq fixture. |
| `npm run verify:browser` | **Pass, 27/27** Chromium checks; no uncaught JavaScript errors. |
| `npm run verify:providers` | **Pass, 4/4** live checks: medical file transcription, temporary grant + Chromium WebSocket, Groq delta and final extraction. |

Runtime artifacts: [system](eval/results/system-verification.json), [browser](eval/results/browser-verification.json), [providers](eval/results/provider-verification.json). Screenshots are local, under `.playwright-cli/`. Provider confidence is a service output, not measured accuracy.

Confirmed fixes: typed MongoDB/string IDs and nullable records; Deepgram accepted-only response handling; portable test compiler; seed/verification environment loading; staff password minimum; normalized medication metadata causing final extraction failure; lost single-digit evidence quantities; consultation timer hydration mismatch; navigation leaking into printed prescriptions. Printing now requires a completed encounter and issued approval metadata, reads the stored prescription, and adds no inferred dose schedule or generic advice. Tests reject active/cross-practice printing and prove later EMR changes cannot alter the issued medication output.

Live Groq initially returned `404 model_not_found` for `llama-3.3-70b-versatile`. The account's authenticated model list and [Groq model documentation](https://console.groq.com/docs/structured-outputs) support the selected configurable default `openai/gpt-oss-120b`; final cache identity includes the model. Empty `.env.local` entries had masked provider keys in `.env`; the local entries were populated without logging secrets. Deepgram uses its [temporary-token flow](https://developers.deepgram.com/reference/auth/tokens/grant). A Node 26 experimental HTTP/2 WebSocket run timed out; the final test uses Chromium and received finalized words with a normal close.

The system suite verifies practice/role isolation, same-version contention, audit-failure rollback, graph conflicts, immutable transcript retries, extraction replay/backoff/expired-lease recovery, malformed AI rejection, stale approval, concurrent completion (one prescription/event), history synchronization, hash-linked audit and receptionist session revocation. Browser coverage includes intake, search/settings, mobile dashboard, autosave/reload, explicit findings/allergy/prescription review, completion and print media. These suites are separate from live audio capture through the app's recorder.

Docker Desktop stopped during an early run and was restarted. Repeated synthetic logins also demonstrated the real rate limiter's 429 response; no application limits were disabled. Test harness selector/timing failures were corrected to wait for actual form hydration and visible completion state.

**Still incomplete:** actual recorder permission/pause/reconnect/expiry scenarios, multi-tab UI recovery, legacy migrations, broader provider/load testing, and qualified clinical/privacy review. Header Safety alerts and Profile actions are placeholders; reception lacks logout UI and links patient details to doctor-only pages. Allergy detection still misses fixture cases below. **Next P0:** pharmacist-reviewed terminology corrections and held-out evaluation alongside remaining runtime acceptance; do not treat successful smoke tests as clinical approval.

## Earlier cleanup verification — 2026-10-26

Scope: repository/database-code review and file/documentation cleanup, as clarified by the user. Environment: macOS, Node **26.7.0**, npm **11.19.0**, Next **16.2.2**; existing uncommitted implementation preserved. No live database inspection or database writes were requested/performed. No local connection or provider credentials were configured.

| Check / exact command | Observed result |
|---|---|
| `npm ci --no-audit --no-fund --fetch-retries=0 --fetch-timeout=15000` | **Pass**, exit 0; 185 packages installed; no package versions changed. |
| `npm test` before cleanup | **Fail**, exit 1: 114 cases passed; Stage 7 suite could not load its hard-coded Linux global TypeScript path. |
| `node --test tests/stage7-regressions.mjs` | Confirms missing `/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript`. Existing harness portability issue. |
| `MEDIFLOW_TYPESCRIPT=typescript npm test` after cleanup | **Pass**, exit 0: **134/134** synthetic/mocked tests. Uses installed project TypeScript through the harness's existing override. Includes offline evaluation. |
| `npm run typecheck`, before and after cleanup | **Fail**, exit 2: same **15 existing diagnostics** across six files, detailed below. Dependencies are installed; these are actual source typing problems. |
| `NEXT_TELEMETRY_DISABLED=1 npm run build` after cleanup | **Fail**, exit 1: Turbopack compiles successfully, then TypeScript rejects extraction-batch string IDs. Also warns that middleware should migrate to proxy. |
| Local import/Markdown link checks; `git diff --check` | **Pass**: local imports resolve across 123 source files; local document paths/anchors resolve; no whitespace errors. |
| SHA-256 comparison with pre-cleanup snapshot | **Pass**: all retained source, tests, fixtures, manifests/lockfile and AGENTS/CLAUDE instructions are unchanged. Test-generated evaluation timings were restored to their original artifact. |
| Live MongoDB/API, Deepgram/Groq, browser and clinical evaluation | **Not run**; outside this cleanup's source-review scope. Existing release gates remain open. |

Confirmed type errors:

| File | Finding |
|---|---|
| `app/api/emr/extract-delta/route.ts` | Six diagnostics: string batch IDs conflict with default MongoDB ObjectId collection typing |
| `src/lib/security/access.ts` | String quota ID conflicts with default ObjectId typing |
| `app/api/emr/review/[id]/route.ts` | Two accesses to possibly null `state.emr` |
| `app/api/stt/transcribe/route.ts` | Deepgram response union is not narrowed before accessing `results` |
| `src/lib/clinical/reviewStateServer.ts` | Two untyped MongoDB documents do not satisfy review-policy shapes |
| `src/lib/extraction/history.ts` | Three callback parameter types require fields absent from generic MongoDB document types |

These failures predated cleanup and were fixed in the subsequent setup task above. They are retained here as historical provenance.

## Repository cleanup

Removed **17 unreferenced non-documentation files**, after import/reference inspection and checking that none contained pre-existing edits:

- Legacy Supabase wrappers/schema: `src/lib/supabase/client.ts`, `server.ts`, `types.ts`.
- Unused ICD helper chain: `src/lib/icd/enrichMedications.ts`, `icdQueryPhrases.ts`, `mongoMatch.ts`, `nihSearch.ts`, `resolveForMedication.ts`.
- Unused `src/lib/mongodb/serializers.ts`, `src/components/stt/LiveSTTPanel.tsx`, and UI `EmptyState.tsx`, `Skeleton.tsx`, `Tooltip.tsx`.
- Unreferenced `public/file.svg`, `public/globe.svg`, `public/window.svg`, and root raster logo `image.png`; the prescription's SVG logo remains.

The active legacy-named auth middleware and landing-page logos remain. The alternate EMR editor and its dependencies remain because that editor has pre-existing uncommitted changes. Package manifests, lockfile, seed/backfill scripts, fixtures, tests and active runtime source are preserved.

Markdown consolidated from **12 files to 7**, reducing repository documentation by approximately **79%** (210 KB → 45 KB):

| Removed document | Retained information |
|---|---|
| `build_steps.md` | Obsolete Supabase-first/reset instructions retired; current MongoDB setup is in README |
| `handoffs.md` | Current architecture in CODEBASE_MAP; outstanding work in TODO; historical evidence below |
| `DEMO_GUIDE.md` | Local replica-set setup, safe seed, smoke/demo scenarios and cleanup in README |
| `EVALUATION_REPORT.md` | Metrics, limitations and false negatives below; raw fixture/results retained |
| `RELEASE_CHECKLIST.md` | Deduplicated release gates in TODO; observed checks here |

`prompt.md` was shortened while retaining workflow/safety requirements. At cleanup, `AGENTS.md` (including Next.js rules) and `CLAUDE.md` were unchanged. The user subsequently removed `CLAUDE.md`; its obsolete links were removed.

Recovery snapshot of pre-cleanup repository files, hashes and Git status:
`/var/folders/g3/4tl86_052j7g3hybh3k04w6m0000gn/T/mediflow-cleanup-6_yn5u7g`.
This is a temporary local backup, not a tracked project dependency.

## Synthetic evaluation

Historical evaluation: 2026-10-26 Stage 9 replay of the original 2026-10-07 development fixture from `origin/codex/baseline-evaluation`. Sixteen cases, 20 speech events and 16 prescription checks; fixture hash and individual outcomes are in `eval/results/stage9-offline.json`. Reproduce with `npm run eval:stage9` (rewrites generated timings/results).

| Metric | Historical old heuristic | Stage 9 implementation |
|---|---:|---:|
| Speech TP / FP / FN / TN | 6 / 2 / 4 / 8 | 5 / 0 / 5 / 10 |
| Speech precision / recall | 75% / 60% | 100% / **50%** |
| Prescription TP / FP / FN / TN | 5 / 0 / 2 / 9 | 4 / 0 / 3 / 9 |
| Prescription precision / recall | 100% / 71.4% | 100% / **57.1%** |
| Selected lexical-grounding assertions | — | 4/4 |
| Family proposals TP / FP / FN / TN | — | 2 / 0 / 0 / 2 |
| Synthetic batching | 24 individual events | 8 scheduled logical calls |
| Sample user JSON size | 10,060 characters | 590 characters |

Recall regressed against the recorded historical heuristic; high precision on this tiny fixture is not clinical accuracy. The old result is contextual evidence, not a controlled A/B execution.

Stage 9 fixed present-progressive intent (“I am starting…”), increasing current speech recall from 4/10 to 5/10. Remaining misses include fragmented penicillin V potassium, cotrimoxazole/sulfamethoxazole and codeine. Unknown-medication review prompts are not counted as detected ingredient conflicts. Changes require pharmacist-reviewed mappings and held-out examples, not fixture-specific padding.

Batching/context figures are synthetic, exclude fixed system prompts and do not measure live calls or billable tokens. Node detector timing is in-process only. **Not measured:** transcription WER, live event-to-visible latency, Groq P50/P95, provider tokens/cost/error rate and interruption recovery. Content-free `MEDIFLOW_METRICS=1` instrumentation exists for later measurement.

## Historical provenance

The following results came from earlier isolated Linux runs (Node 22.16.0, npm 10.9.2, global TypeScript 5.8.3), not this Mac or a deployed service. Prior archives were based on `main` at `c488439` plus evolving uncommitted fixes.

| Date / checkpoint | Recorded evidence and limits |
|---|---|
| 2026-10-25 security verification | `npm test`: 29/29 synthetic/mocked tests; script syntax and whitespace checks passed. Registry DNS/dependencies and MongoDB/providers unavailable. |
| 2026-10-25 Stage 3 | 48/48 tests after ingredient/intent screening. Fixed speech-cue matching and missing completion-medication variable. Clinical rules unvalidated. |
| 2026-10-25 Stage 4 | 66/66 tests; selected EMR modules strict-checked with temporary type mocks. Grounding/provenance/stable IDs present; not full typecheck or clinical entailment validation. |
| 2026-10-25 Stage 5 | 77/77 tests via global compiler. Active-parent claims, audit/index sequencing, lease/replay and metadata CAS hardened; real contention/rollback untested. |
| 2026-10-25 Stage 6 | 92/92 tests; helper check used stubs; 108 files syntax-parsed. Separate benchmark: 24→8 calls and 9,197→535 characters, a different sample from Stage 9. |
| 2026-10-25 Stage 7 / handoff | 112/112 tests with explicit global compiler; graph/proposal strict check used temporary shims. Family graph/API tests mocked; no live integration. |
| 2026-10-25 Stage 8 | 130/130 offline tests; structured clinician review/fingerprint/completion protections. |
| 2026-10-26 Stage 9 | 134/134 offline tests; evaluator and demo scripts syntax-checked. Demo seed/API runner prepared, not executed live. |
| 2026-10-26 Linux build recheck | Bounded `npm ci` exit 1: EAI_AGAIN + npm exit-handler error. Typecheck exit 2: missing declarations; build exit 127: no Next binary. Tests 134/134; evaluator pass; 115 TS/TSX syntax parses; 25/25 manifest/lockfile direct specs agreed. |

Historical targeted checks used temporary declarations and cannot establish full-project validity. Earlier registry and missing-tool blocks apply to those environments; the current Mac results above take precedence.

The setup results above supersede the historical build/database/provider/browser blockers. Production still requires the open acceptance gates in TODO and qualified clinical/pharmacy and privacy/security approval.
