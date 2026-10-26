# MediFlow — contributor instructions

Read this file, [TODO.md](TODO.md), [CODEBASE_MAP.md](CODEBASE_MAP.md), and relevant [verification notes](doc.md) before changes. Follow the Next.js rules in [AGENTS.md](AGENTS.md).

## Workflow

1. Inspect Git status and actual source, callers, API contracts, indexes and tests. The working tree may include uncommitted implementation; preserve unrelated changes. Historical reports and branches do not override current code.
2. Check tools/dependencies before claiming results. For Next.js work, read relevant installed `node_modules/next/dist/docs/` guides. Use applicable skills and current documentation when needed.
3. Keep changes scoped. Preserve authentication, practice isolation, clinician review, allergy controls, evidence checks, transactions and auditability. Confirm consumers before deleting files.
4. Update documentation in the same change:
   - `CODEBASE_MAP.md`: affected paths, public symbols, responsibilities, I/O, dependencies and status; remove obsolete entries.
   - `TODO.md`: implementation, remaining verification and actionable confirmed defects, with priority, dependencies and files. Avoid duplicate tasks.
   - `doc.md`: dated environment, commands, actual outcomes, limitations and next gate. Preserve historical provenance without repeating stage narratives.
5. Run appropriate checks and inspect the final diff. Distinguish syntax, typechecking, build, mocks, database/API tests, providers, browser E2E and clinical evaluation. Do not repeatedly retry an unchanged environmental blocker.
6. Report changes, checks, limitations and the next unresolved P0 task. Never claim production or clinical readiness without evidence and qualified approval.

## Evidence and safety

- **Implemented / `[x]`** means source or a named deliverable exists, not deployment or live verification. **Partial** means acceptance remains incomplete; **Blocked** names the missing prerequisite; **Unverified** means evidence is absent. P0 blocks release, P1 is follow-up, P2 is deferred.
- Use synthetic/de-identified fixtures, disposable databases and test-only keys. Never log credentials or clinical secrets; never seed, migrate or drop production data. `verify:mongo` is restricted to a disposable local replica set.
- Check actor, practice, patient, consultation, expected version, evidence and audit event. Include negative authorization, failed writes and concurrency when relevant.
- Groq output is an untrusted proposal; Deepgram output is unverified transcription. Heuristics need clinical validation. Keep doctor sign-off and prescription conflicts server-enforced.
- MongoDB and custom cookie sessions are authoritative. Reconcile `origin/codex/baseline-evaluation` deliberately: its fixture is already present, but older app code must not replace current fixes.
