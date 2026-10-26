# MediFlow

AI-assisted outpatient documentation: receptionist intake → live transcription → structured EMR → clinician correction/review → prescription and patient history.

Built with Next.js 16.2.2, React 19, TypeScript, Tailwind, MongoDB, Deepgram and Groq. Authentication uses signed cookies; MongoDB database `cliniq` is the active data store.

**Status:** local setup, production build, 137 regressions, 72 database/HTTP checks, 27 browser checks and four live provider checks pass. Remaining runtime and clinical gates are recorded in [verification results](doc.md) and [tasks](TODO.md).

[Demo video](https://drive.google.com/file/d/1hRLmQ0q5aWjXYqqNvjyfLfftncEREua2/view?usp=sharing)

## Local setup

Use Node 22+ (Next.js minimum: 20.9), npm, and a disposable MongoDB replica set. The optional Docker example below uses MongoDB 7. Live speech/extraction also needs test-only Deepgram/Groq keys.

```bash
npm ci
cp -n .env.example .env.local
```

Fill `.env.local` with a generated `AUTH_SECRET`, two distinct demo passwords (at least 12 characters), and test provider keys. Generate secrets locally with `openssl rand -hex 32`. Empty entries in `.env.local` override values in `.env`; keep the intended values in `.env.local`. Never commit credentials.

`GROQ_MODEL` defaults to `openai/gpt-oss-120b`, verified available to the configured test account. The former hard-coded `llama-3.3-70b-versatile` returned `model_not_found`. Changing models invalidates the final-extraction cache and requires new clinical evaluation.

Start a dedicated local replica set:

```bash
docker run -d --name mediflow-demo-rs -p 127.0.0.1:27029:27017 \
  mongo:7 --replSet rs0 --bind_ip_all
docker exec mediflow-demo-rs mongosh --quiet --eval \
  'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
docker exec mediflow-demo-rs mongosh --quiet --eval 'db.hello().isWritablePrimary'
```

Wait for `true`. `.env.example` already provides the loopback replica-set URI for both `MONGODB_URI` and `MONGODB_TEST_URI`.

The database name is hard-coded to `cliniq`; changing the URI path does not select another app database. Keep provider keys server-side. Use only this disposable instance for seeds/backfills and synthetic testing.

```bash
npm run seed:core
npm run seed:icd10
npm run seed:medications
npm run verify:mongo
```

`verify:mongo` creates/removes its own random test database and tests database primitives, not the application API.

## Synthetic demo

With the environment configured:

```bash
npm run demo:seed
npm run typecheck
npm test
npm run build
npm run start -- --hostname 127.0.0.1
```

The guarded seeder creates `demo-doctor-a@mediflow.invalid` and `demo-doctor-b@mediflow.invalid`, creates no patients, and invalidates older demo sessions. It requires the local URI above. Prefer it over the older `seed:demo`/`seed:all` fixture scripts.

Open [doctor login](http://127.0.0.1:3000/login) or [receptionist login](http://127.0.0.1:3000/receptionist/login). Use doctor A's email and the matching password from `.env.local`. After a restart, use `docker start mediflow-demo-rs` and `npm run start -- --hostname 127.0.0.1`.

In another terminal:

```bash
npm run verify:stage9:api
npm run verify:system
npm run verify:browser
# Opt-in live calls using synthetic audio/text and test keys:
npm run verify:providers
```

`verify:system` starts a separate production server with a local Groq fixture and real MongoDB, exercises fault injection/rollback, and leaves synthetic records for browser review. Run it before each `verify:browser`; that flow completes its prepared encounter. The browser runner requires `playwright-cli` on PATH. The provider runner requires `playwright-cli` and macOS `say`/`afconvert` and makes billable calls. Results are saved under `eval/results/`; browser screenshots go in Git-ignored `.playwright-cli/`.

Run these against the dedicated demo database only, with no concurrent manual edits. Repeated logins can reach the real 12-attempt/15-minute quota; wait for the next bucket. The suites do not disable authorization or quotas.

Manual acceptance flow:

1. Open `/receptionist/login` using doctor A's email and the receptionist password. Register a fictional patient, record an allergy, and create a consultation.
2. Sign out; log in at `/login` as doctor A. Record synthetic speech, inspect finalized segments and extraction evidence, and check prescribing/negation alerts.
3. Correct the EMR; inspect medication fields, allergies and provenance. Add a synthetic family-history statement and accept/reject its proposal separately from patient diagnoses.
4. Review the final transcript/EMR, resolve blockers, explicitly acknowledge required findings, approve the current version and complete. Check prescription, history and audit.
5. Verify doctor B cannot access the records, reception cannot sign off, and repeated completion produces one prescription.

Exercise reconnect/refresh, Groq timeout/429/malformed output, competing edits (409), post-approval medication changes (re-review), pending family proposals, and audit-failure rollback. See [doc.md](doc.md) for executed coverage and remaining scenarios. Script success does not establish clinical correctness. Prescription printing now requires an issued, approved record; legacy encounters without approval metadata need a deliberate migration.

After saving test evidence, remove only the dedicated test container and its volumes:

```bash
docker rm -f -v mediflow-demo-rs
```

## Commands and documentation

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Development / production compilation / production server |
| `npm run typecheck` | Full project TypeScript check |
| `npm test` | Synthetic/mocked regression suite |
| `npm run eval:stage9` | Offline fixture evaluation; rewrites `eval/results/stage9-offline.json` |
| `npm run verify:mongo` | Disposable replica-set primitive checks |
| `npm run demo:seed` / `verify:stage9:api` | Local synthetic users / HTTP smoke checks |
| `npm run verify:system` | Real database/HTTP workflow with simulated Groq |
| `npm run verify:browser` | Chromium intake, editing, review and print checks |
| `npm run verify:providers` | Live synthetic Deepgram/Groq smoke tests |
| Other `seed:*` scripts | Catalogs, legacy fixtures/backfills; inspect before running |

- [CODEBASE_MAP.md](CODEBASE_MAP.md): architecture, APIs, modules and all 16 MongoDB collections.
- [TODO.md](TODO.md): release blockers and follow-up work.
- [doc.md](doc.md): dated verification, evaluation and cleanup evidence.
- [AGENTS.md](AGENTS.md) → [prompt.md](prompt.md): contributor rules.

Team: Jayraj Rathi, Sarvesh Rathi, Pranav Navandar, Shubham Soni, Suraj Mundhada.
