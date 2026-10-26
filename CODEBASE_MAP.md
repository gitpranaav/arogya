# MediFlow — codebase map

Updated 2026-10-26 from the working tree, including existing uncommitted changes. **Implemented** below means source exists; live behavior is unverified unless [doc.md](doc.md) records a pass. Clinical heuristics, provider integrations and release acceptance remain **Partial**. [TODO.md](TODO.md) owns outstanding work.

## Architecture

Next.js App Router/React UI → cookie/role/practice checks → MongoDB `cliniq`. Deepgram supplies transcription; Groq proposes EMR facts; NIH Clinical Tables is an ICD search fallback.

`ConsultationWorkspace` → `useSTT` → persisted finalized transcript → bounded delta/final extraction → validation/grounding + versioned EMR/audit → clinician review → transactional completion, prescription and history.

- `patient_doctors` links patients to doctor/practice IDs. API handlers authorize independently; root middleware excludes APIs.
- `clinicalTransaction` uses snapshot/majority transactions and can claim an active parent consultation. Requires a replica set or sharded MongoDB.
- EMR/transcript/graph versions prevent stale writes; metadata CAS currently uses the server-read version.
- Extraction batches use deterministic string IDs, token-CAS leases, three attempts and ≥30-second retry delay. Processing lease expiry is separate from 24-hour done/failed TTL retention. Replays read the current EMR.
- Review binds the EMR version/fingerprint, transcript, provenance, allergies and rule version. Completion requires current approval. Audit events are hash-linked and transactionally written, not independently immutable.
- The 123-product catalog, speech intent, lexical grounding and family proposals are unvalidated clinical aids. Historical evidence is not a current prescription instruction.

## MongoDB collections

Source-derived contracts; the dedicated local MongoDB 7 replica set was seeded and tested. No production records/indexes were inspected. References use ObjectIds except string extraction/rate-limit IDs and local family-node IDs. Clinical timestamps commonly use ISO strings; TTL/lease expiry uses Dates.

| Collection | Relationships / content | Index definition |
|---|---|---|
| `users` | Practice/doctor root; profile, password hashes, receptionist actor/session versions | Unique email |
| `patients` | Demographics, allergies/conditions; global phone identity, access via practice links | Unique phone; created time; doctor + created time |
| `patient_doctors` | `patient_id` → patients, `doctor_id` → users | Unique patient + doctor; doctor + created time |
| `consultations` | Patient/doctor, visit/follow-up, active/completed status, metadata/clinical/audit revisions | Doctor + created time; patient + created time |
| `transcripts` | One per consultation; immutable finalized segments, raw text, status/version | Unique consultation |
| `emr_entries` | One per consultation; snapshot/version/cursor, stable medicine IDs, provenance, safety, final hash, review | Unique consultation |
| `emr_extraction_batches` | Consultation + segment-hash string ID; status, lease token/expiry, attempts/result | Built-in unique ID; `expires_at` TTL |
| `consultation_audit_events` | Consultation/patient/actor, sequence, before/after, changed paths and hash chain | Unique consultation + sequence; unique event hash; consultation/patient/actor + time |
| `prescriptions` | Completed consultation medication/diagnosis data and approved EMR version/fingerprint/reviewer | Unique consultation |
| `patient_history` | Patient core allergies, conditions, surgeries, medicines, family/social history | Unique patient |
| `patient_specialty_history` | Patient + specialty + doctor-specific history | Unique patient + specialty + doctor; doctor + specialty + update time |
| `patient_family_graphs` | Unique patient graph; relative/condition IDs, lineage, review status, consultation/segment evidence | Unique patient, created by graph/extraction routes |
| `emr_diagnoses` | Legacy EMR-entry/ICD references; still read in patient detail/context | EMR entry |
| `icd10_codes` | Local diagnosis dictionary; remote fallback in search API | Unique code; code/description text |
| `medication_catalog` | Searchable names/aliases/ingredients/catalog version; seeded from shared JSON | Seed upserts by name; no explicit unique index in catalog seed |
| `api_usage_limits` | String caller/bucket ID, atomic counters and expiry | Built-in unique ID; `expires_at` TTL |

Most indexes: `scripts/seed/01_core.mjs`. Audit indexes: `src/lib/audit/consultationLedger.ts`. Catalog seed: `scripts/seed/08_medication_catalog.mjs`. Family graph links are local to a patient's graph; proposals do not create patient diagnoses or identify other real patients.

## APIs

Paths below are under `app/api/` and end in `/route.ts`. Each listed method is an exported handler returning JSON/status/cookies.

| Path | Method | Contract / main data |
|---|---|---|
| `auth/login` | POST | Email/password → signed doctor cookie; users + usage limits |
| `auth/receptionist/login` | POST | Doctor email/staff password → scoped receptionist cookie/actor |
| `auth/logout` | POST | Clear session cookie |
| `doctor/settings` | GET/PATCH | Authorized profile fields ↔ users |
| `doctor/receptionist-password` | PATCH | Change hash and revoke old receptionist sessions |
| `patients/create` | POST | Intake → new/linked patient; reject cross-practice phone collision |
| `patients/[id]/consultations` | GET | Practice-authorized encounter list |
| `patients/[id]/history` | GET/PUT | Shared/specialty history; transaction/audit when consultation supplied |
| `patients/[id]/family-graph` | GET/PATCH | Doctor-only graph; active consultation + expected version + action → graph or conflict |
| `consultations/create` | POST | Linked patient, visit/follow-up → active encounter + EMR/audit |
| `consultations/context/[id]` | GET | Authorized patient/allergy/history/recent-visit context |
| `consultations/[id]` | PATCH | Metadata CAS or reviewed-version completion → prescription/history/audit |
| `consultations/[id]/audit` | GET | Doctor-owned encounter → up to 100 recent audit events |
| `transcripts/upsert` | GET/POST | Consultation → transcript; finalized segments/status → versioned persistence |
| `stt/token` | POST | Active owned consultation → temporary Deepgram token |
| `stt/transcribe` | POST | Bounded multipart audio + consultation query → transcript/words/confidence |
| `emr/by-consultation/[id]` | GET/PUT | Hydrated snapshot/version/provenance; expected-version save with role restrictions |
| `emr/[id]` | PUT | Partial validated EMR patch + version → protected, audited snapshot |
| `emr/extract-delta` | POST | Persisted segment delta → grounded operations/snapshot/cursor/version; leased Groq call, optional family proposals |
| `emr/extract` | POST | Completed transcript → grounded final snapshot; version/context cache and protected clinician edits |
| `emr/review/[id]` | GET/POST | Doctor review state; expected version + explicit confirmations/acknowledgements → fingerprinted approval |
| `icd/search` | GET | Bounded query → local ICD results/NIH fallback; authenticated/quota-limited |
| `medications/search` | GET | Bounded query → shared-catalog search results; authenticated/quota-limited |

## Pages and UI

Page/layout paths are under `app/`; export names identify their main components.

| File | Component / responsibility |
|---|---|
| `page.tsx` | `Home`: starter landing page, still uses Next/Vercel SVGs |
| `layout.tsx` | `RootLayout`: metadata, global styles, theme |
| `login/page.tsx` | `LoginPage`: doctor login |
| `doctor/layout.tsx` | `DoctorLayout`: session/profile guard and shell |
| `doctor/page.tsx` | `DoctorDashboardPage`: encounter counts/trends/start |
| `doctor/patients/page.tsx` | `PatientsPage`: linked patient list |
| `doctor/patients/[id]/page.tsx` | `PatientDetailPage`: authorized patient/history/prescriptions |
| `doctor/consultations/page.tsx` | `ConsultationsPage`: filtered/paginated encounters |
| `doctor/consultations/[id]/page.tsx` | `ConsultationDetailPage`: encounter/transcript/EMR |
| `doctor/consultation/[id]/page.tsx` | `ConsultationPage`: active workspace |
| `doctor/consultations/[id]/prescription/page.tsx` | `PrescriptionPage`: completed/approved issued prescription only; exact stored instructions, no inferred schedule |
| `doctor/settings/page.tsx` | `DoctorSettingsPage`: profile/staff credentials; password UI matches API minimum |
| `receptionist/layout.tsx` | `ReceptionistLayout`: role-gated shell |
| `receptionist/login/page.tsx` | `ReceptionistLoginPage`: staff login |
| `receptionist/patients/page.tsx` | `ReceptionistPatientsPage`: scoped intake dashboard |

Components below are relative to `src/components/`. Unless stated otherwise, the filename is the primary exported component.

| File(s) | Props/data → behavior / dependencies |
|---|---|
| `ErrorBoundary.tsx` | Children → render fallback; React, Button |
| `doctor/DoctorShell.tsx`, `doctor/Header.tsx`, `doctor/Sidebar.tsx` | Profile/route/children → navigation shell; header/sidebar hidden and content unclipped in print media |
| `doctor/AddPatientModal.tsx`, `doctor/PatientsClient.tsx` | Patient list/intake → filtering and patient-create API |
| `doctor/PatientDetailTabs.tsx` | Patient/history → demographic/visit tabs |
| `doctor/dashboard/StartConsultationModal.tsx` | Patients/visit/follow-up → consultation-create API |
| `doctor/dashboard/ConsultationSparkline.tsx` | Encounter points → Recharts line chart |
| `doctor/consultation/ConsultationWorkspace.tsx` | Encounter props → STT, extraction, autosave, stop/flush, review/completion; preserves dirty edits; timer initializes identically on server/client |
| `doctor/consultation/ClinicalReviewDialog.tsx` | Encounter/callbacks → evidence/allergy/family review, approval, 409 reload, completion retry |
| `doctor/consultation/PrescriptionPrintButton.tsx` | Click → browser print |
| `emr/EMRLivePanel.tsx` | Snapshot/version/allergies → serialized autosave, stable medication rows, catalog/ICD lookup, safety warnings |
| `history/PatientHistoryPanel.tsx` | Patient/consultation → core/specialty history editor and family graph |
| `history/FamilyGraphPanel.tsx` | Patient/active consultation → graph view, edits/review, conflict recovery |
| `receptionist/ReceptionistIntakeCard.tsx` | Patients → intake/start/update consultation APIs |
| `stt/STTRecorder.tsx`, `stt/TranscriptViewer.tsx` | Recorder state/actions and finalized/interim speech → controls/text |
| `theme/ThemeProvider.tsx`, `theme/ThemeToggle.tsx` | Theme context (`useTheme`) and persisted toggle |
| `ui/Avatar.tsx`, `ui/Badge.tsx`, `ui/Button.tsx`, `ui/Spinner.tsx` | Shared identity/status/actions/loading primitives |
| `ui/Card.tsx` | Card + Header/Title/Description/Content/Footer composition |
| `ui/Input.tsx`, `ui/Modal.tsx`, `ui/Select.tsx` | Forms/dialog/select; Radix used by Modal/Select |
| `emr/EMRPanel.tsx`, `emr/AISuggestions.tsx`, `emr/ExtractButton.tsx`, `emr/ICD10Search.tsx` | **Unverified alternate branch:** no active page consumer. Retained because EMRPanel has existing uncommitted work; uses final extraction and EMR-by-ID APIs |

Hooks under `src/hooks/`: `useSTT.ts` owns microphone/WebSocket/grants/persisted segments/recovery; `useEMRExtraction.ts` supplies extraction status/results to the alternate editor.

## Shared libraries

Paths are relative to `src/lib/`. Public symbols shown are the main navigation points; source owns complete type/helper definitions.

| File | Main symbols and contract / dependencies |
|---|---|
| `auth/session.ts` | `createSessionToken`, `verifySessionToken`, `getServerSession`, `getSessionCookieName`: HMAC cookie ↔ verified/revocable role session; users |
| `security/access.ts` | `validId`, `accessConsultation`, `enforceUsageLimit`, `readLimitedBytes`, `parseBoundedJson`, `isPlainObject`: ownership, quotas and bounded input |
| `mongodb/client.ts` | `getDb`: MONGODB_URI → reused driver connection, always `cliniq` |
| `mongodb/server.ts` | `getServerContext`: role/session guard → DB/session or redirect |
| `mongodb/repo.ts` | `asObjectId`, user getters, `createPatient`, `registerPatientForPractice`, `ensurePatientDoctorLink`: identity/intake; patient+link transaction |
| `mongodb/clinicalTransaction.ts` | `clinicalTransaction`, `ClinicalConflictError`, `isClinicalConflict`: session callback + optional active parent → atomic result/conflict |
| `audit/consultationLedger.ts` | `prepareAuditIndexes`, `logConsultationAudit`: per-DB indexes; session-required parent revision, canonical diffs and SHA-256 chain |
| `supabase/middleware.ts` | `updateSession`: **active custom-cookie page guard despite legacy folder name**; no Supabase client |
| `consultations/visitTypes.ts` | `normalizeConsultationType`, options/constants: permitted visit types |
| `clinical/medicationCatalog.json` | Versioned 123-product names, aliases, ingredients, routes/strengths → matcher + seed; clinical validation pending |
| `clinical/medicationTerminology.ts` | `normalizeMedicationText`, `resolveMedication`, `findMedicationMentions`: bounded alias trie; unknown/ambiguous states and catalog version |
| `clinical/allergySafety.ts` | `evaluatePrescriptionSafety`, `detectLiveAllergySignals`: ingredient/rule issues and intent-aware interim/final speech signals; versioned, unvalidated rules |
| `clinical/allergyMedicationCheck.ts` | `findAllergyMedicationWarnings`: compatibility wrapper around shared safety engine |
| `clinical/prescriptionSafetyServer.ts` | `screenPrescription`: patient/history allergies + snapshot → issues/rule version |
| `clinical/reviewPolicy.ts` | `prescriptionFieldProblems`, `reviewedSnapshotFingerprint`, `reviewStatus`, `transcriptBlockers`, `familyProposalBlockers`: pure review criteria |
| `clinical/reviewStateServer.ts` | `loadClinicalReviewState`: EMR/transcript/leases/graph/safety → server-authoritative blockers/approval validity |
| `emr/types.ts` | Snapshot/medication/operation/segment/cursor/provenance/finding/entry contracts |
| `emr/validation.ts` | `validFactPath`, `validFactValue`, `validateEMROperations`, `sanitizeSnapshot`: untrusted JSON → bounded allowed data |
| `emr/merge.ts` | `parsePath`, `applyEMROps`: validated operations → stable-ID snapshot mutations |
| `emr/normalizeMedications.ts` | `normalizeMedicationEntry`, `normalizeMedicationsArray`: raw rows → standardized medications |
| `emr/medicationIdentity.ts` | `createMedicationId`, `ensureMedicationIds`, `reconcileMedicationIds`, `medicationIndexById`: stable IDs, deterministic legacy hydration |
| `emr/grounding.ts` | `evaluateClaim`, `readProvenance`, `applyProvenanceChanges`, `groundDeltaOps`, `changedClinicalFields`, `protectClinicianPaths`, `groundFinalSnapshot`: lexical support including single-digit quantities, clinical-field evidence (excluding storage metadata) and protected edits |
| `emr/extractDeltaPrompt.ts` | `EXTRACT_DELTA_SYSTEM_PROMPT`, `EXTRACT_FULL_SYSTEM_PROMPT`: evidence/ID-aware Groq prompts, optional family drafts |
| `emr/summaries.ts` | `buildClinicalSummary`, `buildPatientSummary`: snapshot → derived, unverified text |
| `extraction/batching.ts` | `chooseTranscriptBatch`, `pendingFromCursor`, `BATCH_POLICY`: finalized speech/time/cursor → bounded sequential batch |
| `extraction/context.ts` | `buildClinicalContext`, `ContextBudgetError`, version/limits: server EMR/allergies/evidence → compact JSON or explicit budget failure |
| `extraction/history.ts` | `referencesPriorCare`, `retrieveAuthorizedHistory`: explicit reference → bounded same-practice completed encounter citations |
| `extraction/metrics.ts` | `recordExtractionMetric`: optional MEDIFLOW_METRICS numeric-only timing/usage logs |
| `familyHistory/graph.ts` | `blankGraph`, `graphFromRecord`, `applyFamilyAction`, `traverseFamily`, `GraphValidationError`: stable graph IDs, review/lineage/cycle validation, depth ≤4 |
| `familyHistory/proposals.ts` | `prepareFamilyProposals`, `mergeFamilyProposals`: current segment evidence → conservative drafts; preserve accepted/rejected facts |
| `utils.ts` | `cn`: conditional class-name joining |

## Scripts, fixtures and tests

| File | Responsibility / inputs and outputs |
|---|---|
| `scripts/seed/01_core.mjs` | MONGODB_URI → core indexes in `cliniq` |
| `scripts/seed/02_icd10.mjs` | Seed common ICD dictionary |
| `scripts/seed/03_demo.mjs` | Legacy doctor/patient/encounter/transcript/EMR fixtures |
| `scripts/seed/04_backfill_patient_doctor_id.mjs` | Legacy patient doctor field backfill |
| `scripts/seed/05_backfill_patient_doctors.mjs` | Existing patients/consultations → practice links |
| `scripts/seed/06_history_demo.mjs` | Synthetic core/specialty history |
| `scripts/seed/07_backfill_consultation_follow_up.mjs` | Legacy consultation follow-up fields |
| `scripts/seed/08_medication_catalog.mjs` | Shared catalog JSON → searchable medication documents |
| `scripts/seed/demo-stage9.mjs` | Guarded local URI + distinct test passwords → two synthetic practices; revokes old demo sessions |
| `scripts/verify-mongo.mjs` | MONGODB_TEST_URI → five primitive assertions in random disposable DB; cleans up its DB |
| `scripts/verify-stage9-api.mjs` | Loopback app/test passwords → scoped HTTP smoke assertions; synthetic writes |
| `scripts/verify-system.mjs` | Local production server + MongoDB + explicit Groq fixture → 72 integration checks; guarded fault injection and browser review fixture |
| `scripts/verify-browser.mjs` | `playwright-cli` + demo credentials → Chromium UI results and ignored screenshots; requires fresh system fixture |
| `scripts/verify-providers.mjs` | Test keys + macOS speech synthesis + Chromium → live synthetic Deepgram/Groq checks, no clinical accuracy claim |
| `eval/results/system-verification.json`, `browser-verification.json`, `provider-verification.json` | Dated runtime results with exact checks and scope |
| `scripts/benchmark-stage6.mjs` | Synthetic batch/context simulation; no live tokens/costs |
| `scripts/eval-stage9.mjs` | Offline deterministic replay → result JSON; no DB/provider calls |
| `eval/fixtures/baseline.json` | Original 16 development cases/20 speech events, copied from baseline branch |
| `eval/results/stage9-offline.json` | Saved synthetic confusion counts/timings; live metrics null |
| `tests/security-regressions.mjs` | 80 security/clinical/grounding/concurrency tests with TS transpilation and mocks |
| `tests/stage6-regressions.mjs` | 15 batching/context/history/cache tests |
| `tests/stage7-regressions.mjs` | 20 family graph/proposal/route tests; local TypeScript dependency by default |
| `tests/stage8-regressions.mjs` | 18 sign-off/fingerprint/blocker/rollback tests |
| `tests/stage9-regressions.mjs` | Four prescribing/evaluation/local-demo-guard tests |

Seed/backfill scripts mutate their selected database; inspect them and use disposable targets. Cleanup ran no seeds; the subsequent setup task seeded only the dedicated disposable instance. No legacy migration was run.

## Configuration and documentation

- `package.json`, `package-lock.json`: scripts/dependencies and reproducible install; preserved during cleanup.
- `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`: TypeScript, Next.js and Tailwind configuration.
- `middleware.ts`: page guard via legacy-named auth helper. Next 16 emits a migration-to-proxy warning.
- `app/globals.css`, `app/favicon.ico`, `public/next.svg`, `public/vercel.svg`, `public/caduceus.svg`: active styling/assets.
- `.env.example`: safe loopback/test configuration template; `.env.local` holds Git-ignored credentials. `GROQ_MODEL` defaults to `openai/gpt-oss-120b` in both extraction routes and participates in final cache identity.
- `.gitignore`: dependencies, real environment files, build output, generated type caches and `.playwright-cli/`; retains `.env.example`.
- `README.md`: setup/demo/commands; `TODO.md`: tasks; `doc.md`: evidence; `CODEBASE_MAP.md`: this inventory.
- `AGENTS.md` → `prompt.md`: contributor instructions. The user removed `CLAUDE.md` after cleanup.

Removed paths and documentation merge destinations are recorded once in [doc.md](doc.md#repository-cleanup).
