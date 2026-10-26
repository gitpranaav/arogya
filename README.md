# MediFlow

AI-assisted outpatient documentation: receptionist intake → live transcription → structured EMR → clinician correction/review → prescription and patient history.

Built with Next.js 16.2.2, React 19, TypeScript, Tailwind, MongoDB, Deepgram and Groq. Authentication uses signed cookies; MongoDB database `cliniq` is the active data store.

**Status:** source implemented, release verification incomplete. The 2026-10-26 Mac check installed dependencies but found existing TypeScript errors. Live database/provider/browser and clinical validation remain open; see [verification results](doc.md) and [tasks](TODO.md).

[Demo video](https://drive.google.com/file/d/1hRLmQ0q5aWjXYqqNvjyfLfftncEREua2/view?usp=sharing)

## Local setup

Use Node 22+ (Next.js minimum: 20.9), npm, and a disposable MongoDB replica set. The optional Docker example below uses MongoDB 7. Live speech/extraction also needs test-only Deepgram/Groq keys.

```bash
npm ci
npm run typecheck
npm run build
MEDIFLOW_TYPESCRIPT=typescript npm test
npm run eval:stage9
```

The test override works around the existing Linux-only TypeScript default in the Stage 7 suite. Resolve type/build failures before treating the app as demo-ready.

Start a dedicated local replica set:

```bash
docker run -d --name mediflow-demo-rs -p 127.0.0.1:27029:27017 \
  mongo:7 --replSet rs0 --bind_ip_all
docker exec mediflow-demo-rs mongosh --quiet --eval \
  'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
docker exec mediflow-demo-rs mongosh --quiet --eval 'db.hello().isWritablePrimary'
```

Wait for `true`. Create a Git-ignored `.env.local` with test values:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27029/?directConnection=true&replicaSet=rs0
AUTH_SECRET=<generate-with-openssl-rand-hex-32>
MEDIFLOW_METRICS=1
# Add test-only keys when exercising live providers:
DEEPGRAM_API_KEY=<test-key>
GROQ_API_KEY=<test-key>
```

The database name is hard-coded to `cliniq`; changing the URI path does not select another app database. Keep provider keys server-side. Use only this disposable instance for seeds/backfills and synthetic testing.

```bash
export MONGODB_URI='mongodb://127.0.0.1:27029/?directConnection=true&replicaSet=rs0'
npm run seed:core
npm run seed:icd10
npm run seed:medications
MONGODB_TEST_URI="$MONGODB_URI" npm run verify:mongo
```

`verify:mongo` creates/removes its own random test database and tests database primitives, not the application API.

## Synthetic demo

Create two distinct test passwords of at least 12 characters; the following prompts work in macOS zsh:

```zsh
read -rs 'DEMO_DOCTOR_PASSWORD?Doctor test password: '
read -rs 'DEMO_RECEPTIONIST_PASSWORD?Reception test password: '
export DEMO_DOCTOR_PASSWORD DEMO_RECEPTIONIST_PASSWORD
npm run demo:seed
npm run dev
```

The guarded seeder creates `demo-doctor-a@mediflow.invalid` and `demo-doctor-b@mediflow.invalid`, creates no patients, and invalidates older demo sessions. It requires the local URI above. Prefer it over the older `seed:demo`/`seed:all` fixture scripts.

In another terminal with the same exported passwords, run `npm run verify:stage9:api`. It exercises login, synthetic intake, isolation, transcript retry and review blockers against `http://127.0.0.1:3000`; it is not full E2E coverage.

Manual acceptance flow:

1. Open `/receptionist/login` using doctor A's email and the receptionist password. Register a fictional patient, record an allergy, and create a consultation.
2. Sign out; log in at `/login` as doctor A. Record synthetic speech, inspect finalized segments and extraction evidence, and check prescribing/negation alerts.
3. Correct the EMR; inspect medication fields, allergies and provenance. Add a synthetic family-history statement and accept/reject its proposal separately from patient diagnoses.
4. Review the final transcript/EMR, resolve blockers, explicitly acknowledge required findings, approve the current version and complete. Check prescription, history and audit.
5. Verify doctor B cannot access the records, reception cannot sign off, and repeated completion produces one prescription.

Exercise reconnect/refresh, Groq timeout/429/malformed output, competing edits (409), post-approval medication changes (re-review), pending family proposals, and audit-failure rollback. These are required scenarios, not claims of successful execution. Record observed results in [doc.md](doc.md). Missing providers mean an incomplete demo.

After saving test evidence, remove only the dedicated test container and its volumes:

```bash
docker rm -f -v mediflow-demo-rs
```

## Commands and documentation

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Development / production compilation / production server |
| `npm run typecheck` | Full project TypeScript check |
| `MEDIFLOW_TYPESCRIPT=typescript npm test` | Synthetic/mocked regression suite |
| `npm run eval:stage9` | Offline fixture evaluation; rewrites `eval/results/stage9-offline.json` |
| `npm run verify:mongo` | Disposable replica-set primitive checks |
| `npm run demo:seed` / `verify:stage9:api` | Local synthetic users / HTTP smoke checks |
| Other `seed:*` scripts | Catalogs, legacy fixtures/backfills; inspect before running |

- [CODEBASE_MAP.md](CODEBASE_MAP.md): architecture, APIs, modules and all 16 MongoDB collections.
- [TODO.md](TODO.md): release blockers and follow-up work.
- [doc.md](doc.md): dated verification, evaluation and cleanup evidence.
- [AGENTS.md](AGENTS.md) → [prompt.md](prompt.md): contributor rules; `CLAUDE.md` delegates to them.

Team: Jayraj Rathi, Sarvesh Rathi, Pranav Navandar, Shubham Soni, Suraj Mundhada.
