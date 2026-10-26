# MediFlow — development tracker

Updated 2026-10-26. `[x]` means implemented or explicitly verified as stated; `[ ]` remains open. Runtime and clinical verification are separate from source completion. See [code map](CODEBASE_MAP.md), [evidence](doc.md), and [local setup](README.md#local-setup).

## P0 — release blockers

- [x] Install locked dependencies on this Mac: `npm ci --no-audit --no-fund --fetch-retries=0 --fetch-timeout=15000` succeeded. Earlier Linux DNS failures are historical.
- [ ] **Confirmed type errors:** Fix MongoDB string `_id` typing in `app/api/emr/extract-delta/route.ts` and `src/lib/security/access.ts`; nullable EMR in `app/api/emr/review/[id]/route.ts`; Deepgram response narrowing in `app/api/stt/transcribe/route.ts`; document typing in `src/lib/clinical/reviewStateServer.ts` and `src/lib/extraction/history.ts`. Re-run `npm run typecheck` and `npm run build`. Errors predate cleanup and were reproduced after successful installation; do not bypass checks.
- [ ] **Database integration — unverified:** On a disposable replica set, run `verify:mongo` and `verify:stage9:api`; then test practice/role isolation, patient registration, session revocation, quotas, concurrent EMR/metadata/graph edits, leases/replay, immutable transcript retries, late writes after completion, audit rollback/hash ordering and duplicate completion. Verify unique/TTL indexes and legacy records. Depends: working build + disposable MongoDB; `scripts/verify-*.mjs`, `app/api/`.
- [ ] **Provider integration — unverified:** Test Deepgram temporary grants/WebSocket expiry/reconnect and Groq success, schema failures, timeout/429, retry limits and interruption recovery with synthetic data. Depends: test keys + running app; `src/hooks/useSTT.ts`, `app/api/stt/`, extraction routes.
- [ ] **Browser E2E — unverified:** Intake → speech → extraction → correction → allergy/family review → approval → completion → printed prescription. Include refresh, two tabs, 409 recovery, failed completion and exact approved snapshot. Depends: preceding gates; `ConsultationWorkspace.tsx`, `ClinicalReviewDialog.tsx`.
- [ ] **Terminology — failed synthetic fixture:** Resolve penicillin V, cotrimoxazole and codeine false negatives using pharmacist-reviewed, versioned mappings and held-out positive/negative cases. Current speech recall 5/10; prescription recall 4/7. Verify seed/catalog synchronization and stale-rule review invalidation; `src/lib/clinical/`.
- [ ] **Clinical approval — blocked on qualified review:** Validate prescriptions/doses, allergies, intent/negation, Hindi-English grounding, historical context and family lineage/ambiguity. Field presence and lexical overlap do not establish correctness. Depends: clinician/pharmacist reviewers + reference fixtures + E2E evidence.
- [ ] **Privacy/security approval — unverified:** Review access, consent, PHI retention, secrets, audit access, provider agreements and deployment controls. Depends: qualified reviewers and deployment plan.

## P1 — engineering and evaluation

- [ ] Fix the hard-coded Linux TypeScript path in `tests/stage7-regressions.mjs`; use the local dependency by default, as other suites do. Workaround: `MEDIFLOW_TYPESCRIPT=typescript npm test`.
- [ ] Reconcile useful remaining baseline instrumentation from `origin/codex/baseline-evaluation` without replacing current fixes. `eval/fixtures/baseline.json` is already present; separate observability/evaluation modules are not.
- [ ] Measure held-out fact/alert precision and recall, WER, event-to-visible latency, provider calls/tokens/costs, P50/P95 and recovery time. Compare matched workloads; synthetic context sizes are not billable-token measurements. Depends: approved fixtures + provider access; `src/lib/extraction/metrics.ts`, `scripts/eval-stage9.mjs`.
- [ ] Validate legacy medication IDs and ambiguous duplicate-name reconciliation before any migration; `src/lib/emr/medicationIdentity.ts`.
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
- [x] Repository/database-code review and cleanup: remove 17 unused files and 5 redundant documents; consolidate Markdown from 12 files to 7. Import/link checks and 134 regression tests pass with the compiler override; existing type/build failures are tracked above. Live records are outside the clarified scope.
