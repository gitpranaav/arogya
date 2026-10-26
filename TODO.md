# MediFlow — development tracker

Updated 2026-10-26. `[x]` means implemented or explicitly verified as stated; `[ ]` remains open. Runtime and clinical verification are separate from source completion. See [code map](CODEBASE_MAP.md), [evidence](doc.md), and [local setup](README.md#local-setup).

## P0 — release blockers

- [x] Install locked dependencies on this Mac: `npm ci --no-audit --no-fund --fetch-retries=0 --fetch-timeout=15000` succeeded. Earlier Linux DNS failures are historical.
- [x] **Build and portability:** Fix MongoDB/Deepgram/nullable-record typing and the Linux-only compiler path. `npm run typecheck`, production build and 137 regressions pass.
- [x] **Local database/API baseline:** Seed a disposable MongoDB 7 replica set; five primitive checks, 14 HTTP smoke checks and 72 real workflow checks pass. Includes practice/role isolation, CAS, rollback, audit hashes, transcript replay, leases/backoff, sign-off, duplicate completion, issued-prescription printing and staff session revocation.
- [ ] **Database acceptance — partial:** Add legacy-record/migration verification, concurrent metadata/graph scenarios and expiry/load testing. Existing results cover new synthetic records, not production data; `scripts/verify-*.mjs`, `app/api/`.
- [ ] **Provider acceptance — partial:** Four live smoke checks pass: Deepgram prerecorded audio and temporary grant/Chromium streaming, plus Groq delta/final extraction; see `eval/results/provider-verification.json`. Extend to grant expiry, reconnect, timeout/retry exhaustion and interrupted audio. No accuracy claim from smoke tests; `src/hooks/useSTT.ts`, `app/api/stt/`, extraction routes.
- [ ] **Browser acceptance — partial:** All 27 Chromium intake/edit/review/print checks pass in `scripts/verify-browser.mjs`, with no uncaught JavaScript errors. Remaining: actual recorder integration with injected audio, permission denial, pause/reconnect, two-tab 409 recovery, failed completion and keyboard/accessibility review. Provider transport and browser workflow tests remain separate.
- [ ] **Terminology — failed synthetic fixture:** Resolve penicillin V, cotrimoxazole and codeine false negatives using pharmacist-reviewed, versioned mappings and held-out positive/negative cases. Current speech recall 5/10; prescription recall 4/7. Verify seed/catalog synchronization and stale-rule review invalidation; `src/lib/clinical/`.
- [ ] **Clinical approval — blocked on qualified review:** Validate prescriptions/doses, allergies, intent/negation, Hindi-English grounding, historical context and family lineage/ambiguity. Field presence and lexical overlap do not establish correctness. Depends: clinician/pharmacist reviewers + reference fixtures + E2E evidence.
- [ ] **Privacy/security approval — unverified:** Review access, consent, PHI retention, secrets, audit access, provider agreements and deployment controls. Depends: qualified reviewers and deployment plan.

## P1 — engineering and evaluation

- [ ] Complete shell controls: `Header.tsx` Safety alerts has no action and Profile only closes the menu; receptionist layout has no logout control and its patient links target doctor-only pages. These are confirmed incomplete UI features.
- [ ] Reconcile useful remaining baseline instrumentation from `origin/codex/baseline-evaluation` without replacing current fixes. `eval/fixtures/baseline.json` is already present; separate observability/evaluation modules are not.
- [ ] Measure held-out fact/alert precision and recall, WER, event-to-visible latency, provider calls/tokens/costs, P50/P95 and recovery time. Compare matched workloads; synthetic context sizes are not billable-token measurements. Depends: approved fixtures + provider access; `src/lib/extraction/metrics.ts`, `scripts/eval-stage9.mjs`.
- [ ] Validate legacy medication IDs, ambiguous duplicate-name reconciliation and prescriptions without approval metadata before any migration. Printing now fails closed for unapproved legacy records; `src/lib/emr/medicationIdentity.ts`, prescription page.
- [ ] Decide patient-level audit policy for standalone history edits without a consultation. Preserve supported editing while reviewing the requirement; `app/api/patients/[id]/history/route.ts`.
- [ ] Decide whether delayed cross-tab metadata edits need a client-supplied expected version; current server CAS only protects competing reads/writes; `app/api/consultations/[id]/route.ts`.
- [ ] Evaluate 24-hour extraction replay retention, final-cache invalidation after review, and oversized transcripts. Keep explicit evidence-budget failure; extraction routes, `src/lib/extraction/context.ts`.
- [ ] Confirm deployment/migration assumptions after a successful build and real index verification. Review legacy middleware naming and unused package dependencies separately; `middleware.ts`, `src/lib/supabase/middleware.ts`, `package.json`.

## P2 — deferred

- [ ] Evaluate ICD candidate caching off the extraction path with source/version and clinician approval; `app/api/icd/search/route.ts`.
- [ ] Improve multiple unnamed-relative and multilingual disambiguation using evaluated fixtures; `src/lib/familyHistory/proposals.ts`.
- [ ] Study finer per-fact review and editor navigation; `ClinicalReviewDialog.tsx`, `EMRLivePanel.tsx`.
- [ ] Review the unused alternate `EMRPanel`/extraction UI branch after reconciling its existing uncommitted edits; retained during cleanup.

## Implemented in the working tree

- [x] Signed/revocable sessions, scoped intake, authorization, request limits and short-lived STT grants.
- [x] Shared 123-product terminology, ingredient/intent matching, safety screens and required doctor acknowledgements.
- [x] Stable medication IDs, bounded AI changes, finalized-segment provenance, lexical grounding and protected clinician corrections.
- [x] Versioned EMR/transcripts/metadata, active-parent transaction claims, bounded extraction leases/retries and hash-linked audit.
- [x] Utterance batching, bounded server context, authorized prior-history retrieval, versioned final cache and content-free metrics.
- [x] Versioned family graph, evidence-cited proposals and clinician review without replacing free-text history.
- [x] Structured sign-off with version/fingerprint/context checks and transactional completion/prescription/history.
- [x] Synthetic regression/evaluation fixtures, local demo seed and API smoke scripts. Execution evidence is in `doc.md`.
- [x] Repository/database-code review and cleanup: remove 17 unused files and 5 redundant documents; consolidate Markdown from 12 files to 7. Historical cleanup passed import/link checks and 134 regressions with a compiler override; the setup task subsequently fixed type/build and portability failures. Live records are outside the clarified scope.

- [x] Fix final extraction of normalized medications: ignore storage metadata as clinical evidence and preserve single-digit quantities during grounding. Regression tests cover supported and mismatched quantities.
- [x] Require completed, approved prescription records for printing; remove inferred dose schedules and boilerplate advice. Verify practice isolation and independence from mutable EMR data; hide navigation in print media.
- [x] Make Groq model configurable with a verified available default and model-sensitive final cache; match the staff password UI to the ten-character API minimum; initialize the consultation timer consistently during hydration.
