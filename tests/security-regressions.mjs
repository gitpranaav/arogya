/** Self-contained source-level tests (Node built-ins and globally installed TypeScript). */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ts = require(process.env.MEDIFLOW_TYPESCRIPT ?? "typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function moduleOf(rel, mocks = {}, cache = {}) {
  rel = rel.startsWith("@/") ? rel.slice(2) : rel;
  rel = rel.replace(/^\.\//, "");
  if (rel.endsWith(".json")) return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const filename = path.join(root, rel.endsWith(".ts") || rel.endsWith(".tsx") ? rel : `${rel}.ts`);
  if (cache[filename]) return cache[filename].exports;
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  cache[filename] = module;
  const localRequire = spec => {
    if (Object.prototype.hasOwnProperty.call(mocks, spec)) return mocks[spec];
    if (spec.startsWith("@/")) return moduleOf(spec, mocks, cache);
    if (spec.startsWith(".")) return moduleOf(path.relative(root, path.resolve(path.dirname(filename), spec)), mocks, cache);
    return require(spec);
  };
  new Function("require", "module", "exports", code)(localRequire, module, module.exports);
  return module.exports;
}
const validator = moduleOf("src/lib/emr/validation");
const reducer = moduleOf("src/lib/emr/merge");
const allergy = moduleOf("src/lib/clinical/allergyMedicationCheck");
const segs = new Set(["segment-1"]);
test("C5: approved AI fact changes work", () => {
  const ops = validator.validateEMROperations([
    { op: "set_fact", path: "vitals.pulse_rate", value: 80, evidence_segment_ids: ["segment-1"] },
    { op: "update_fact", path: "medications[0]", value: { name: "Amoxicillin", dosage: "500mg" }, evidence_segment_ids: ["segment-1"] },
  ], segs);
  const s = reducer.applyEMROps({}, ops);
  assert.equal(s.vitals.pulse_rate, 80);
  assert.equal(s.medications[0].dosage, "500mg");
});
test("C5: reject unsafe paths, index bombs, fabricated evidence and invalid values", () => {
  for (const op of [
    { op: "set_fact", path: "__proto__.polluted", value: true, evidence_segment_ids: ["segment-1"] },
    { op: "set_fact", path: "medications[10000]", value: { name: "X" }, evidence_segment_ids: ["segment-1"] },
    { op: "set_fact", path: "doctor_id", value: "attacker", evidence_segment_ids: ["segment-1"] },
    { op: "set_fact", path: "vitals.pulse_rate", value: -10, evidence_segment_ids: ["segment-1"] },
    { op: "set_fact", path: "chief_complaint", value: "a", evidence_segment_ids: ["fake"] },
    { op: "set_fact", path: "chief_complaint", value: "a" },
  ]) assert.throws(() => validator.validateEMROperations([op], segs));
  const s = reducer.applyEMROps({}, [{ op: "set_fact", path: "__proto__.polluted", value: true },
    { op: "set_fact", path: "medications[10000]", value: { name: "X" } }]);
  assert.equal(({}).polluted, undefined);
  assert.equal(s.medications, undefined);
});
test("C5: every AI medication, including the second row, uses the strict generated-data schema", () => {
  assert.equal(validator.validFactValue("medications", [
    { name: "Drug 1" }, { name: "Drug 2", icd10_code: "injected-code" },
  ]), false);
  assert.throws(() => validator.validateEMROperations([{
    op: "set_fact", path: "medications", evidence_segment_ids: ["segment-1"],
    value: [{ name: "Drug 1" }, { name: "Drug 2", icd10_code: "injected-code" }],
  }], segs));
});
test("H4: exact paracetamol allergy now alerts", () => {
  const w = allergy.findAllergyMedicationWarnings(["paracetamol"], [{ name: "Paracetamol 500mg" }]);
  assert.ok(w.length && w[0].includes("paracetamol"));
});
test("H1/H5: validate snapshot mutation and reject unbounded fields", () => {
  assert.deepEqual(validator.sanitizeSnapshot({ chief_complaint: "Pain", medications: [{ name: "Paracetamol", icd10_code: "", dosage: "500mg" }] }).medications.length, 1);
  assert.throws(() => validator.sanitizeSnapshot({ doctor_id: "evil" }));
  assert.throws(() => validator.sanitizeSnapshot({ medications: Array.from({length: 41}, () => ({name: "x"})) }));
});
class MockId { constructor(v){this.v=v;} toString(){return this.v;} }
const sessionDoctor = { uid: "aaaaaaaaaaaaaaaaaaaaaaaa", role: "doctor" };
function authMock(sesh, owner, status="active") {
  return {
    mongodb: { ObjectId: MockId },
    "next/server": { NextResponse: { json: (body, opts) => ({ body, status: opts?.status ?? 200 }) } },
    "@/src/lib/auth/session": { getServerSession: async () => sesh },
    "@/src/lib/mongodb/client": { getDb: async () => ({ collection: () => ({ findOne: async filter =>
      owner && filter.doctor_id.toString() === owner ? { _id: filter._id, doctor_id: filter.doctor_id, status } : null }) }) },
  };
}
test("C1: cross-practice access is denied", async () => {
  const { accessConsultation } = moduleOf("src/lib/security/access", authMock(sessionDoctor, "bbbbbbbbbbbbbbbbbbbbbbbb"));
  const result = await accessConsultation("cccccccccccccccccccccccc");
  assert.equal(result.error.status, 404);
});
test("C1: inactive consultations reject mutations", async () => {
  const { accessConsultation } = moduleOf("src/lib/security/access", authMock(sessionDoctor, sessionDoctor.uid, "completed"));
  const result = await accessConsultation("cccccccccccccccccccccccc", { active: true });
  assert.equal(result.error.status, 409);
});
test("C1: unauthenticated and invalid identifier rejected", async () => {
  let access = moduleOf("src/lib/security/access", authMock(null, sessionDoctor.uid)).accessConsultation;
  assert.equal((await access("cccccccccccccccccccccccc")).error.status, 401);
  access = moduleOf("src/lib/security/access", authMock(sessionDoctor, sessionDoctor.uid)).accessConsultation;
  assert.equal((await access("bad-id")).error.status, 400);
  assert.ok(!(await access("cccccccccccccccccccccccc", { doctorOnly: true })).error);
});

test("C2: patient with a phone number owned by another practice cannot be linked or overwritten", async () => {
  let updates = 0;
  const db = { collection: name => ({
    findOne: async () => name === "patients" ? { _id: new MockId("cccccccccccccccccccccccc"), phone: "1234567890" } : null,
    updateOne: async () => { updates++; }, insertOne: async () => { updates++; },
  }) };
  const repo = moduleOf("src/lib/mongodb/repo", { mongodb: { ObjectId: MockId }, "@/src/lib/mongodb/client": { getDb: async () => db } });
  const result = await repo.registerPatientForPractice({ phone: "1234567890", name: "Different patient" }, sessionDoctor.uid);
  assert.equal(result.conflict, true);
  assert.equal(updates, 0);
});

test("C6: completion refuses a consultation without a finalized transcript and extraction", async () => {
  const auth = { session: sessionDoctor, consultationId: new MockId("cccccccccccccccccccccccc"),
    consultation: { status: "active", patient_id: new MockId("dddddddddddddddddddddddd") },
    db: { collection: name => ({ findOne: async () => name === "emr_entries" ? { version: 1 } : null }) } };
  const route = moduleOf("app/api/consultations/[id]/route", {
    mongodb: { ObjectId: MockId },
    "next/server": { NextResponse: { json: (body, opts) => ({ body, status: opts?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => auth, parseBoundedJson: async () => ({ status: "completed" }) },
  });
  const res = await route.PATCH({}, { params: Promise.resolve({ id: "cccccccccccccccccccccccc" }) });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Final transcript/i);
});

test("H2: completed transcript cannot accept a new finalized segment", async () => {
  const auth = { consultationId: new MockId("cccccccccccccccccccccccc"),
    consultation: { status: "active" }, session: sessionDoctor,
    db: { collection: name => ({ findOne: async () => name === "transcripts" ? { segments: [{ id: "known", text: "a" }], processing_status: "completed" } : null }) } };
  const route = moduleOf("app/api/transcripts/upsert/route", {
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async () => {} },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async () => {} },
    "next/server": { NextResponse: { json: (body, opts) => ({ body, status: opts?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => auth,
      parseBoundedJson: async () => ({ consultation_id: "cccccccccccccccccccccccc", segments: [{ id: "new", text: "late" }], processing_status: "completed" }) },
  });
  const res = await route.POST({});
  assert.equal(res.status, 409);
  assert.match(res.body.error, /immutable/i);
});

test("C3: transcription token endpoint denies an unauthorized consultation before accessing provider", async () => {
  const route = moduleOf("app/api/stt/token/route", {
    "next/server": { NextResponse: { json: (body, opts) => ({ body, status: opts?.status ?? 200 }) } },
    "@/src/lib/security/access": {
      parseBoundedJson: async () => ({ consultation_id: "cccccccccccccccccccccccc" }),
      accessConsultation: async () => ({ error: { body: { error: "Consultation not found" }, status: 404 } }),
      enforceUsageLimit: async () => { throw new Error("Provider quota must not run"); },
    },
  });
  const res = await route.POST({});
  assert.equal(res.status, 404);
});

test("H1: stale manual EMR version returns 409 without modifying state", async () => {
  let writes = 0;
  const auth = { consultationId: new MockId("cccccccccccccccccccccccc"), consultation: { patient_id: new MockId("dddddddddddddddddddddddd") },
    session: sessionDoctor, db: { collection: () => ({ findOne: async () => ({ version: 3, snapshot: { chief_complaint: "Original" } }),
      updateOne: async () => { writes++; } }) } };
  const route = moduleOf("app/api/emr/by-consultation/[id]/route", {
    "next/server": { NextResponse: { json: (body, opts) => ({ body, status: opts?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => auth,
      parseBoundedJson: async () => ({ snapshot: { chief_complaint: "Stale" }, expected_version: 2 }) },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async () => { writes++; } },
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async () => {} },
  });
  const res = await route.PUT({}, { params: Promise.resolve({ id: "cccccccccccccccccccccccc" }) });
  assert.equal(res.status, 409);
  assert.equal(writes, 0);
});

test("H1: idempotent delta retry returns committed batch after cursor advances", async () => {
  let providerCalls = 0;
  const done = { operations: [], snapshot: { chief_complaint: "Current" }, version: 5,
    new_cursor: { last_final_segment_id: "segment-1", last_final_index: 0 } };
  const auth = { consultationId: new MockId("cccccccccccccccccccccccc"), consultation: { patient_id: new MockId("dddddddddddddddddddddddd") },
    session: sessionDoctor, db: { collection: name => ({ findOne: async () => name === "emr_entries"
      ? { version: 5, snapshot: done.snapshot, extraction_cursor: done.new_cursor }
      : name === "emr_extraction_batches" ? { status: "done", result: done } : (providerCalls++, null) }) } };
  class GroqMock { constructor() { providerCalls++; } }
  const route = moduleOf("app/api/emr/extract-delta/route", {
    "groq-sdk": { __esModule: true, default: GroqMock },
    "next/server": { NextResponse: { json: (body, opts) => ({ body, status: opts?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => auth,
      parseBoundedJson: async () => ({ consultation_id: "cccccccccccccccccccccccc", segments_delta: [{ id: "segment-1", text: "Pain" }] }),
      enforceUsageLimit: async () => { providerCalls++; return true; } },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async () => {} },
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async () => {} },
  });
  const res = await route.POST({});
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ...done, replayed: true });
  assert.equal(providerCalls, 0);
});

// Stabilization tests exercise route handlers with deterministic provider/database substitutes.
// They are not a replacement for a running MongoDB replica set or live Deepgram/Groq calls.
test("STT v5: prerecorded transcription accepts a bounded multipart upload and reads the v5 response", async () => {
  const buffer = new Uint8Array(512);
  const form = new FormData();
  form.append("audio", new File([buffer], "test.webm", { type: "audio/webm" }));
  const calls = [];
  class DeepgramV5 {
    constructor(options) {
      assert.equal(options.apiKey, "dummy-deepgram-key");
      this.listen = { v1: { media: { transcribeFile: async (buf, options) => {
        calls.push({ buf, options });
        return { results: { channels: [{ alternatives: [{ transcript: "Synthetic clinical test", confidence: 0.9, words: [] }] }] } };
      } } } };
    }
  }
  const route = moduleOf("app/api/stt/transcribe/route", {
    "@deepgram/sdk": { DeepgramClient: DeepgramV5 },
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/src/lib/security/access": {
      accessConsultation: async () => ({ db: {}, session: sessionDoctor }),
      enforceUsageLimit: async () => true,
      readLimitedBytes: async req => new Uint8Array(await req.arrayBuffer()),
    },
  });
  const before = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_API_KEY = "dummy-deepgram-key";
  try {
    const res = await route.POST(new Request("http://localhost/api/stt/transcribe?consultation_id=abc", { method: "POST", body: form }));
    assert.equal(res.status, 200);
    assert.equal(res.body.transcript, "Synthetic clinical test");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].buf.length, 512);
    assert.equal(calls[0].options.model, "nova-3-medical");
  } finally {
    if (before === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = before;
  }
});

test("STT v5: an accepted-only provider response cannot masquerade as an empty completed transcript", async () => {
  const form = new FormData();
  form.append("audio", new File([new Uint8Array(512)], "test.webm", { type: "audio/webm" }));
  const route = moduleOf("app/api/stt/transcribe/route", {
    "@deepgram/sdk": { DeepgramClient: class {
      listen = { v1: { media: { transcribeFile: async () => ({ request_id: "synthetic-pending-request" }) } } };
    } },
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/src/lib/security/access": {
      accessConsultation: async () => ({ db: {}, session: sessionDoctor }),
      enforceUsageLimit: async () => true,
      readLimitedBytes: async req => new Uint8Array(await req.arrayBuffer()),
    },
  });
  const previous = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_API_KEY = "synthetic-test-key";
  try {
    const response = await route.POST(new Request("http://localhost/api/stt/transcribe?consultation_id=abc", { method: "POST", body: form }));
    assert.equal(response.status, 502);
    assert.equal(response.body.transcript, undefined);
    assert.match(response.body.error, /completed result/);
  } finally {
    if (previous === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = previous;
  }
});

test("STT: short-lived token route passes a mocked provider grant and never returns the secret", async () => {
  const previous = process.env.DEEPGRAM_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.DEEPGRAM_API_KEY = "private-provider-key";
  let called = false;
  globalThis.fetch = async (url, options) => {
    called = true;
    assert.equal(url, "https://api.deepgram.com/v1/auth/grant");
    assert.equal(options.headers.Authorization, "Token private-provider-key");
    return new Response(JSON.stringify({ access_token: "mocked-short-lived-jwt", expires_in: 30 }), { status: 200 });
  };
  try {
    const route = moduleOf("app/api/stt/token/route", {
      "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200, headers: options?.headers }) } },
      "@/src/lib/security/access": {
        parseBoundedJson: async () => ({ consultation_id: "cccccccccccccccccccccccc" }),
        accessConsultation: async () => ({ db: {}, session: sessionDoctor }),
        enforceUsageLimit: async () => true,
      },
    });
    const res = await route.POST({});
    assert.equal(res.status, 200);
    assert.equal(res.body.token, "mocked-short-lived-jwt");
    assert.equal(res.body.mode, "bearer");
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.ok(!JSON.stringify(res).includes("private-provider-key"));
    assert.equal(called, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.DEEPGRAM_API_KEY;
    else process.env.DEEPGRAM_API_KEY = previous;
  }
});

test("H3: ancillary consultation update does not commit when audit insertion fails", async () => {
  const state = { follow_up_due_at: null };
  let wroteSession = null;
  const db = { collection: () => ({ updateOne: async (filter, update, options) => {
    assert.equal(filter.status, "active");
    wroteSession = options.session;
    state.follow_up_due_at = update.$set.follow_up_due_at;
    return { matchedCount: 1 };
  } }) };
  const txSession = { test: "atomic-session" };
  const route = moduleOf("app/api/consultations/[id]/route", {
    mongodb: { ObjectId: MockId },
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/src/lib/security/access": {
      accessConsultation: async () => ({ db, consultationId: new MockId("cccccccccccccccccccccccc"), consultation: { status: "active", patient_id: "dddddddddddddddddddddddd" }, session: sessionDoctor }),
      parseBoundedJson: async () => ({ follow_up_due_at: "2026-11-20T00:00:00.000Z" }),
    },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async (_db, work) => {
      const before = { ...state };
      try { return await work(txSession); }
      catch (error) { Object.assign(state, before); throw error; }
    } },
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async (_db, event) => {
      assert.equal(event.mongoSession, txSession);
      throw new Error("Simulated audit insert failure");
    } },
  });
  const response = await route.PATCH({}, { params: Promise.resolve({ id: "cccccccccccccccccccccccc" }) });
  assert.equal(response.status, 503);
  assert.equal(state.follow_up_due_at, null);
  assert.equal(wroteSession, txSession);
});

test("H1: failed delta retains a bounded retry record scoped to its own lease", async () => {
  let deletion = null;
  const recorded = [{ id: "s1", text: "Synthetic symptoms", is_final: true }];
  const db = { collection: name => {
    if (name === "emr_entries") return { findOne: async () => null };
    if (name === "transcripts") return { findOne: async () => ({ segments: recorded }) };
    if (name === "patients" || name === "patient_history") return { findOne: async () => ({ allergies: [] }) };
    if (name === "emr_extraction_batches") return {
      findOne: async () => null, insertOne: async () => ({}),
      updateOne: async (filter, update) => { deletion = filter; assert.equal(update.$set.status, "failed");
        assert.ok(update.$set.retry_after instanceof Date); assert.ok(update.$set.expires_at instanceof Date);
        assert.equal(update.$unset.lease_expires_at, ""); return { matchedCount: 1 }; },
    };
    throw new Error("Unexpected collection " + name);
  } };
  class FailingGroq {
    constructor() { this.chat = { completions: { create: async () => { throw new Error("Simulated provider outage"); } } }; }
  }
  const route = moduleOf("app/api/emr/extract-delta/route", {
    mongodb: { ObjectId: MockId },
    "groq-sdk": { __esModule: true, default: FailingGroq },
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => ({ db, session: sessionDoctor,
      consultationId: new MockId("cccccccccccccccccccccccc"), consultation: { patient_id: "dddddddddddddddddddddddd" } }),
      parseBoundedJson: async () => ({ consultation_id: "cccccccccccccccccccccccc", segments_delta: recorded }),
      enforceUsageLimit: async () => true },
  });
  const old = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "dummy-provider-key";
  try {
    const result = await route.POST({});
    assert.equal(result.status, 503);
    assert.equal(deletion.status, "processing");
    assert.match(deletion.lease_token, /^[0-9a-f-]{36}$/);
  } finally {
    if (old === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = old;
  }
});

test("C4: rate limiting is backed by an atomic counter and blocks requests over quota", async () => {
  let count = 0;
  const mocks = authMock(sessionDoctor, sessionDoctor.uid);
  const access = moduleOf("src/lib/security/access", mocks);
  const db = { collection: name => {
    assert.equal(name, "api_usage_limits");
    return { findOneAndUpdate: async (filter, update, options) => {
      assert.equal(update.$inc.count, 1);
      assert.equal(options.upsert, true);
      assert.ok(filter._id.startsWith("stt:"));
      return { count: ++count };
    } };
  } };
  assert.equal(await access.enforceUsageLimit(db, "stt:practice", 2, 60_000), true);
  assert.equal(await access.enforceUsageLimit(db, "stt:practice", 2, 60_000), true);
  assert.equal(await access.enforceUsageLimit(db, "stt:practice", 2, 60_000), false);
});

test("C4: request body stream is rejected once actual bytes exceed the quota", async () => {
  const access = moduleOf("src/lib/security/access", authMock(sessionDoctor, sessionDoctor.uid));
  const req = new Request("http://localhost/upload", { method: "POST",
    body: new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); controller.close();
    } }), duplex: "half" });
  await assert.rejects(access.readLimitedBytes(req, 10), /payload_too_large/);
});

test("C7: doctor review rejects unacknowledged medication-allergy warnings", async () => {
  const emr = { _id: new MockId("eeeeeeeeeeeeeeeeeeeeeeee"), version: 2,
    final_transcript_hash: (await import("node:crypto")).createHash("sha256").update("test").digest("hex"), snapshot: { medications: [{ name: "Paracetamol 500mg", dosage: "500 mg", frequency: "once daily", duration: "3 days" }] } };
  const db = { collection: name => ({ findOne: async () => {
    if (name === "emr_entries") return emr;
    if (name === "patients") return { allergies: ["paracetamol"] };
    if (name === "patient_history") return { core: {} };
    if (name === "transcripts") return { processing_status: "completed", raw_text: "test" };
    if (name === "patient_family_graphs" || name === "emr_extraction_batches") return null;
    throw new Error("Unexpected collection");
  } }) };
  const route = moduleOf("app/api/emr/review/[id]/route", {
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/src/lib/security/access": {
      accessConsultation: async () => ({ db, consultationId: new MockId("cccccccccccccccccccccccc"),
        consultation: { patient_id: new MockId("dddddddddddddddddddddddd") }, session: sessionDoctor }),
      parseBoundedJson: async () => ({ expected_version: 2, confirmed_review: true, confirmed_prescription: true, allergy_assessment: "confirmed_known", acknowledged_warnings: [] }),
    },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async () => { throw new Error("Must block before DB write"); } },
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async () => { throw new Error("Must block before audit"); } },
  });
  const res = await route.POST({}, { params: Promise.resolve({ id: "cccccccccccccccccccccccc" }) });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /acknowledgement/i);
});

test("C6/H3: synthetic reviewed completion issues one prescription, history update and audit; repeat is idempotent", async () => {
  const { createHash } = await import("node:crypto");
  const transcriptText = "Synthetic clinical dialogue for deterministic test only";
  const sha = text => createHash("sha256").update(text).digest("hex");
  const consultation = { status: "active", patient_id: new MockId("dddddddddddddddddddddddd") };
  const emr = { _id: new MockId("eeeeeeeeeeeeeeeeeeeeeeee"), version: 2, requires_review: false,
    final_transcript_hash: sha(transcriptText), snapshot: { diagnosis_text: ["Synthetic condition"], medications: [{ name: "Paracetamol", dosage: "500 mg", frequency: "once daily", duration: "3 days" }] },
    provenance: {}, grounding_findings: [],
    review: { version: 2, doctor_id: sessionDoctor.uid, allergy_assessment: "confirmed_none",
      allergy_fingerprint: sha("[]"), acknowledged_warnings: [],
      safety_rules_version: moduleOf("src/lib/clinical/allergySafety").ALLERGY_RULESET_VERSION } };
  emr.review.snapshot_fingerprint = moduleOf("src/lib/clinical/reviewPolicy").reviewedSnapshotFingerprint(emr.snapshot, {}, []);
  const transcript = { _id: new MockId("ffffffffffffffffffffffff"), version: 1,
    processing_status: "completed", raw_text: transcriptText };
  const docs = { emr_entries: emr, transcripts: transcript, patients: { allergies: [] },
    patient_history: { core: { problem_list: [] } }, users: { specialty_code: "general" },
    consultations: consultation, patient_specialty_history: null, prescriptions: null };
  const session = { withTransaction: async callback => callback(), endSession: async () => {} };
  const writes = [];
  const audits = [];
  const db = { client: { startSession: () => session }, collection: name => ({
    findOne: async () => docs[name] ?? null,
    updateOne: async (filter, update, options) => {
      assert.equal(options.session, session);
      if (name === "consultations" && filter.status !== "active") throw new Error("Expected active consultation claim");
      writes.push(name);
      if (name === "prescriptions" || name === "patient_history" || name === "patient_specialty_history") {
        docs[name] = { ...(docs[name] ?? {}), ...update.$set };
      } else if (docs[name]) Object.assign(docs[name], update.$set ?? {});
      return { matchedCount: 1 };
    },
  }) };
  const route = moduleOf("app/api/consultations/[id]/route", {
    mongodb: { ObjectId: MockId },
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/src/lib/security/access": {
      accessConsultation: async () => ({ db, session: sessionDoctor,
        consultationId: new MockId("cccccccccccccccccccccccc"), consultation }),
      parseBoundedJson: async () => ({ status: "completed", reviewed_version: 2 }),
    },
    "@/src/lib/audit/consultationLedger": { prepareAuditIndexes: async () => {},
      logConsultationAudit: async (_db, event) => { assert.equal(event.mongoSession, session); audits.push(event); } },
  });
  const params = { params: Promise.resolve({ id: "cccccccccccccccccccccccc" }) };
  const first = await route.PATCH({}, params);
  assert.equal(first.status, 200);
  assert.equal(consultation.status, "completed");
  assert.equal(docs.prescriptions.medications.length, 1);
  assert.ok(docs.patient_history.core.problem_list.includes("Synthetic condition"));
  assert.equal(audits.length, 1);
  const second = await route.PATCH({}, params);
  assert.equal(second.status, 200);
  assert.equal(second.body.already_completed, true);
  assert.equal(audits.length, 1);
  assert.equal(writes.filter(name => name === "prescriptions").length, 1);
});

test("C5/H1: mocked Groq delta validates evidence, persists one versioned batch and audit event", async () => {
  const recorded = [{ id: "s1", text: "Synthetic symptom", is_final: true }];
  const events = { inserted: null, committed: null, emr: null, audit: null, deleted: false };
  const mongoSession = { test: "transaction-session" };
  const db = { collection: name => {
    if (name === "emr_entries") return {
      findOne: async () => null,
      updateOne: async (filter, update, options) => {
        assert.equal(options.session, mongoSession);
        events.emr = update;
        return { matchedCount: 0, upsertedCount: 1 };
      },
    };
    if (name === "transcripts") return { findOne: async () => ({ segments: recorded }) };
    if (name === "patients" || name === "patient_history") return { findOne: async () => ({ allergies: [] }) };
    if (name === "emr_extraction_batches") return {
      findOne: async () => null,
      insertOne: async doc => { events.inserted = doc; },
      updateOne: async (filter, update, options) => {
        assert.equal(filter.lease_token, events.inserted.lease_token);
        assert.equal(filter.status, "processing");
        assert.equal(options.session, mongoSession);
        events.committed = update.$set;
        return { matchedCount: 1 };
      },
      deleteOne: async () => { events.deleted = true; },
    };
    throw new Error("Unexpected collection " + name);
  } };
  class SyntheticGroq {
    constructor() {
      this.chat = {
        completions: {
          create: async () => ({ choices: [{ message: {
            content: JSON.stringify({ operations: [{ op: "set_fact", path: "chief_complaint",
              value: "Synthetic symptom", evidence_segment_ids: ["s1"] }] }),
          } }] }),
        },
      };
    }
  }
  const route = moduleOf("app/api/emr/extract-delta/route", {
    mongodb: { ObjectId: MockId },
    "groq-sdk": { __esModule: true, default: SyntheticGroq },
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => ({ db, session: sessionDoctor,
      consultationId: new MockId("cccccccccccccccccccccccc"), consultation: { patient_id: "dddddddddddddddddddddddd" } }),
      parseBoundedJson: async () => ({ consultation_id: "cccccccccccccccccccccccc", segments_delta: recorded }),
      enforceUsageLimit: async () => true },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async (_db, work) => work(mongoSession) },
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async (_db, event) => { events.audit = event; } },
  });
  const previous = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "synthetic-provider-key";
  try {
    const res = await route.POST({});
    assert.equal(res.status, 200);
    assert.equal(res.body.snapshot.chief_complaint, "Synthetic symptom");
    assert.equal(res.body.version, 1);
    assert.equal(events.committed.status, "done");
    assert.ok(events.committed.expires_at.getTime() - Date.now() > 23 * 60 * 60 * 1000);
    assert.equal(events.emr.$inc.version, 1);
    assert.deepEqual(events.audit.metadata.segment_ids, ["s1"]);
    assert.equal(events.audit.mongoSession, mongoSession);
    assert.equal(events.deleted, false);
  } finally {
    if (previous === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previous;
  }
});

test("H2: delayed in-progress upload after completed transcript is idempotent and does not advance version", async () => {
  const consultationId = new MockId("cccccccccccccccccccccccc");
  let updates = 0;
  let audits = 0;
  const current = { _id: new MockId("eeeeeeeeeeeeeeeeeeeeeeee"), version: 8,
    processing_status: "completed", segments: [{ id: "existing", text: "Synthetic note" }] };
  const route = moduleOf("app/api/transcripts/upsert/route", {
    "next/server": { NextResponse: { json: (body, opts) => ({ body, status: opts?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => ({ consultationId, consultation: { patient_id: new MockId("dddddddddddddddddddddddd") }, session: sessionDoctor,
      db: { collection: name => ({ findOne: async () => name === "transcripts" ? current : null,
        updateOne: async () => { updates += 1; throw new Error("Should not write completed transcript"); } }) } }),
      parseBoundedJson: async () => ({ consultation_id: consultationId.toString(),
        segments: [{ id: "existing", text: "Synthetic note" }], processing_status: "in_progress" }) },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async () => { updates += 1; } },
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async () => { audits += 1; } },
  });
  const res = await route.POST({});
  assert.equal(res.status, 200);
  assert.equal(res.body.segment_count, 1);
  assert.equal(res.body.processing_status, "completed");
  assert.equal(updates, 0);
  assert.equal(audits, 0);
});

test("H2: existing transcript evidence ID cannot be silently reused with conflicting text", async () => {
  const consultationId = new MockId("cccccccccccccccccccccccc");
  let writes = 0;
  const route = moduleOf("app/api/transcripts/upsert/route", {
    "next/server": { NextResponse: { json: (body, opts) => ({ body, status: opts?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => ({ consultationId, consultation: { patient_id: new MockId("dddddddddddddddddddddddd") }, session: sessionDoctor,
      db: { collection: name => ({ findOne: async () => name === "transcripts" ?
        { version: 3, processing_status: "in_progress", segments: [{ id: "segment-1", text: "Initial fact" }] } : null }) } }),
      parseBoundedJson: async () => ({ consultation_id: consultationId.toString(),
        segments: [{ id: "segment-1", text: "Contradictory replacement" }], processing_status: "in_progress" }) },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async () => { writes += 1; } },
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async () => {} },
  });
  const res = await route.POST({});
  assert.equal(res.status, 409);
  assert.match(res.body.error, /conflicts with persisted evidence/i);
  assert.equal(writes, 0);
});

test("H1/H2: UI concurrency guards are present in compiled React modules", () => {
  // Static/AST-level assertion only: it does not render React or claim browser E2E.
  const workspace = fs.readFileSync(path.join(root, "src/components/doctor/consultation/ConsultationWorkspace.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(root, "src/components/emr/EMRLivePanel.tsx"), "utf8");
  for (const [file, source] of [["workspace", workspace], ["panel", panel]]) {
    const diagnostics = ts.transpileModule(source, { fileName: `${file}.tsx`, reportDiagnostics: true,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).diagnostics ?? [];
    assert.equal(diagnostics.length, 0);
  }
  assert.match(workspace, /if\s*\(manualPendingRef\.current\)\s*\{\s*setSyncText\("EMR updated during unsaved manual edits/);
  assert.match(panel, /if\s*\(editRevisionRef\.current\s*===\s*capturedRevision\)/);
  assert.match(panel, /if\s*\(saveInFlightRef\.current\s*\|\|\s*!dirtyRef\.current\)\s*return/);
});

test("H2: unexpected Deepgram WebSocket close restores idle state (source-level hook contract)", () => {
  const file = fs.readFileSync(path.join(root, "src/hooks/useSTT.ts"), "utf8");
  const closeHandler = /ws\.onclose\s*=\s*\(e\)\s*=>\s*\{([\s\S]*?)\n      \};/.exec(file)?.[1];
  assert.ok(closeHandler, "WebSocket close handler must exist");
  assert.match(closeHandler, /if\s*\(stoppingRef\.current\)\s*return/);
  assert.match(closeHandler, /setStatus\("idle"\)/);
  assert.doesNotMatch(closeHandler, /if\s*\(status\s*!==\s*"idle"\)/);
});

test("H1/C5: alternate EMR editor marks changed clinician fields as protected manual overrides", async () => {
  const emr = { _id: new MockId("eeeeeeeeeeeeeeeeeeeeeeee"),
    consultation_id: new MockId("cccccccccccccccccccccccc"), version: 4,
    snapshot: { chief_complaint: "Original note", assessment: "Previous assessment",
      medications: [{ name: "Synthetic prescription" }] } };
  const session = { id: "synthetic-mongo-session" };
  let actualUpdate = null;
  let auditCount = 0;
  const db = { collection: name => ({
    findOne: async () => name === "emr_entries" ? emr : null,
    updateOne: async (_filter, update, options) => {
      assert.equal(options.session, session);
      actualUpdate = update;
      return { matchedCount: 1 };
    },
  }) };
  const route = moduleOf("app/api/emr/[id]/route", {
    mongodb: { ObjectId: MockId },
    "next/server": { NextResponse: { json: (body, opts) => ({ body, status: opts?.status ?? 200 }) } },
    "@/src/lib/auth/session": { getServerSession: async () => sessionDoctor },
    "@/src/lib/mongodb/client": { getDb: async () => db },
    "@/src/lib/security/access": {
      validId: id => /^[a-f0-9]{24}$/.test(id),
      parseBoundedJson: async () => ({ expected_version: 4,
        snapshot: { chief_complaint: "Clinician correction", assessment: "Previous assessment" } }),
      accessConsultation: async () => ({ db, consultationId: emr.consultation_id,
        consultation: { patient_id: new MockId("dddddddddddddddddddddddd") }, session: sessionDoctor }),
    },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async (_db, fn) => fn(session) },
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async () => { auditCount++; } },
  });
  const response = await route.PUT({}, { params: Promise.resolve({ id: emr._id.toString() }) });
  assert.equal(response.status, 200);
  assert.deepEqual(actualUpdate.$addToSet.manual_override_keys.$each, ["chief_complaint"]);
  assert.equal(actualUpdate.$set.snapshot.medications[0].name, "Synthetic prescription",
    "Partial edits must preserve existing medication orders");
  assert.match(actualUpdate.$set.snapshot.medications[0].id, /^med_[0-9a-f]{32}$/);
  assert.equal(actualUpdate.$set.requires_review, true);
  assert.equal(actualUpdate.$set.review, null);
  assert.equal(auditCount, 1);
});

test("C5: diagnosis coding data must be bounded and scalar before EMR persistence", () => {
  const good = { diagnosis_icd: [{ diagnosis: "Synthetic condition", icd10_code: "Z00.0",
    icd10_description: "Synthetic test", confidence: "low" }] };
  assert.deepEqual(validator.sanitizeSnapshot(good).diagnosis_icd, good.diagnosis_icd);
  for (const bad of [
    { diagnosis: { injected: "object" }, icd10_code: "Z00" },
    { diagnosis: "OK", icd10_code: "X".repeat(1000) },
    { diagnosis: "OK", confidence: "verified" },
  ]) assert.throws(() => validator.sanitizeSnapshot({ diagnosis_icd: [bad] }), /Invalid diagnosis codes/);
});

const terminology = moduleOf("src/lib/clinical/medicationTerminology");
const stage3 = moduleOf("src/lib/clinical/allergySafety");
test("Stage3: seeded brand products resolve to complete active ingredient sets", () => {
  assert.deepEqual(terminology.resolveMedication("Augmentin").ingredients, ["amoxicillin", "clavulanate"]);
  assert.deepEqual(terminology.resolveMedication("Zerodol-P").ingredients, ["aceclofenac", "paracetamol"]);
  assert.deepEqual(terminology.resolveMedication("Dolo 650").ingredients, ["paracetamol"]);
  assert.deepEqual(terminology.resolveMedication("Pan-D").ingredients, ["pantoprazole", "domperidone"]);
});
test("Stage3: generic, synonym, strength suffix and token boundaries resolve conservatively", () => {
  assert.deepEqual(terminology.resolveMedication("Acetaminophen 500mg").ingredients, ["paracetamol"]);
  assert.deepEqual(terminology.resolveMedication("AMOXICILLIN 500 mg oral").ingredients, ["amoxicillin"]);
  assert.equal(terminology.resolveMedication("unknownbrand 500mg").status, "unknown");
  assert.equal(terminology.resolveMedication("Augmentin plus something").status, "unknown");
  assert.ok(terminology.findMedicationMentions("Please give Dolo 650, not dolomite").some(x => x.alias === "dolo 650"));
  assert.ok(!terminology.findMedicationMentions("This is a dolomite supplement").length);
});
test("Stage3: same ingredient in combination branded drug triggers precise allergy issue", () => {
  const issues = stage3.evaluatePrescriptionSafety(["paracetamol"], [{ name: "Zerodol-P" }]);
  assert.ok(issues.some(x => x.kind === "ingredient_conflict" && x.ingredient === "paracetamol"));
  assert.ok(issues.every(x => x.rule_version === stage3.ALLERGY_RULESET_VERSION));
});
test("Stage3: narrow explicit penicillin rule applies only to named ingredients, not every cephalosporin", () => {
  const yes = stage3.evaluatePrescriptionSafety(["penicillin allergy"], [{ name: "Augmentin" }]);
  assert.ok(yes.some(x => x.kind === "explicit_rule" && x.rule_id === "penicillin-to-amoxicillin"));
  const no = stage3.evaluatePrescriptionSafety(["penicillin"], [{ name: "Cefuroxime" }]);
  assert.ok(!no.some(x => x.kind === "explicit_rule" || x.kind === "ingredient_conflict"));
});
test("Stage3: unknown medication identity remains unresolved even without listed allergies", () => {
  const issues = stage3.evaluatePrescriptionSafety([], [{ name: "Completely Unknown Medicine" }]);
  assert.equal(issues[0].kind, "unknown_medication");
  assert.match(issues[0].message, /must verify/i);
});
test("Stage3: missing allergy terminology is flagged for human assessment without invented cross-reactivity", () => {
  const issues = stage3.evaluatePrescriptionSafety(["latex"], [{ name: "Paracetamol" }]);
  assert.ok(issues.some(x => x.kind === "unresolved_allergen"));
  assert.ok(!issues.some(x => x.kind === "ingredient_conflict" || x.kind === "explicit_rule"));
});
test("Stage3: interim prescribing intent yields provisional alert without Groq", () => {
  const alerts = stage3.detectLiveAllergySignals(["acetaminophen"], "", "Please prescribe Dolo 650 today");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].intent, "prescribing");
  assert.equal(alerts[0].phase, "interim");
});
test("Stage3: negated medication prescription is not a prescribing conflict", () => {
  const alerts = stage3.detectLiveAllergySignals(["paracetamol"], "Do not prescribe Dolo 650");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].intent, "negated");
});
test("Stage3: historical medication mentions are distinguished from orders", () => {
  const alerts = stage3.detectLiveAllergySignals(["paracetamol"], "Previously the patient was taking Dolo 650");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].intent, "historical");
});
test("Stage3: a discussion mention does not become a prescription order", () => {
  const alerts = stage3.detectLiveAllergySignals(["paracetamol"], "We discussed Dolo 650 as a previous option");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].intent, "mentioned");
});
test("Stage3: duplicate interim/finalized mentions are collapsed", () => {
  const alerts = stage3.detectLiveAllergySignals(["paracetamol"], "Start Dolo 650", "Start Dolo 650");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].phase, "finalized");
});
test("Stage3: multi-ingredient conflicts are deterministic and deduplicated", () => {
  const issues = stage3.evaluatePrescriptionSafety(["paracetamol", "paracetamol"], [{ name: "Zerodol-P" }]);
  assert.equal(issues.filter(x => x.kind === "ingredient_conflict").length, 1);
  assert.deepEqual(stage3.evaluatePrescriptionSafety(["paracetamol"], [{ name: "Zerodol-P" }]),
    stage3.evaluatePrescriptionSafety(["paracetamol"], [{ name: "Zerodol-P" }]));
});
test("Stage3: explicit aspirin/NSAID watchlist maintains a conservative warning without asserting class-wide cross-reactivity", () => {
  const issues = stage3.evaluatePrescriptionSafety(["aspirin allergy"], [{ name: "Ibuprofen" }]);
  assert.ok(issues.some(x => x.rule_id === "aspirin-nsaid-watchlist"));
  const unrelated = stage3.evaluatePrescriptionSafety(["aspirin allergy"], [{ name: "Metformin" }]);
  assert.ok(!unrelated.some(x => x.kind === "explicit_rule" || x.kind === "ingredient_conflict"));
});
test("Stage3: mapped but unrelated substance allergy does not create an erroneous medication conflict", () => {
  const issues = stage3.evaluatePrescriptionSafety(["amoxicillin allergy"], [{ name: "Paracetamol" }]);
  assert.deepEqual(issues, []);
});
test("Stage3: not-assessed allergy terminology stays unresolved and cannot silently establish safety", () => {
  const issues = stage3.evaluatePrescriptionSafety(["not assessed"], [{ name: "Paracetamol" }]);
  assert.ok(issues.some(x => x.kind === "unresolved_allergen"));
});
test("Stage3: completion cannot silently issue unknown medication without a doctor's safety acknowledgement", async () => {
  const { createHash } = await import("node:crypto");
  const transcript = "Synthetic test only";
  const hash = text => createHash("sha256").update(text).digest("hex");
  const emr = { version: 1, requires_review: false, final_transcript_hash: hash(transcript),
    snapshot: { medications: [{ name: "not-in-catalog-medication", dosage: "1 mg", frequency: "once daily", duration: "2 days" }] },
    provenance: {}, grounding_findings: [],
    review: { version: 1, doctor_id: sessionDoctor.uid, allergy_assessment: "confirmed_none",
      allergy_fingerprint: hash("[]"), safety_rules_version: stage3.ALLERGY_RULESET_VERSION,
      acknowledged_warnings: [] } };
  emr.review.snapshot_fingerprint = moduleOf("src/lib/clinical/reviewPolicy").reviewedSnapshotFingerprint(emr.snapshot, {}, []);
  const db = { collection: name => ({ findOne: async () => ({
    emr_entries: emr, transcripts: { raw_text: transcript, processing_status: "completed" },
    patients: { allergies: [] }, patient_history: { core: { allergies: [] } },
  })[name] ?? null }) };
  const route = moduleOf("app/api/consultations/[id]/route", {
    mongodb: { ObjectId: MockId },
    "next/server": { NextResponse: { json: (body, opts) => ({ body, status: opts?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => ({ db, session: sessionDoctor,
      consultationId: new MockId("cccccccccccccccccccccccc"), consultation: { status: "active", patient_id: new MockId("dddddddddddddddddddddddd") } }),
      parseBoundedJson: async () => ({ status: "completed", reviewed_version: 1 }) },
  });
  const res = await route.PATCH({}, { params: Promise.resolve({ id: "cccccccccccccccccccccccc" }) });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /acknowledg/i);
});
test("Stage3: seeded catalog retains 123 source medicines with explicit ingredient arrays", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "src/lib/clinical/medicationCatalog.json"), "utf8"));
  assert.equal(catalog.entries.length, 123);
  assert.ok(catalog.entries.every(x => x.id && x.name && x.generic_name && x.ingredients.length));
  assert.equal(new Set(catalog.entries.map(x => x.id)).size, catalog.entries.length);
});
test("Stage3: doctor acknowledgement persists exact structured issues and rule version alongside clinical audit", async () => {
  const emr = { _id: new MockId("eeeeeeeeeeeeeeeeeeeeeeee"), version: 7,
    final_transcript_hash: (await import("node:crypto")).createHash("sha256").update("synthetic").digest("hex"), snapshot: { medications: [{ name: "Dolo 650", dosage: "650 mg", frequency: "once daily", duration: "3 days" }] } };
  const db = { collection: name => ({
    findOne: async () => name === "emr_entries" ? emr : name === "patients" ? { allergies: ["paracetamol"] } : name === "transcripts" ? { processing_status: "completed", raw_text: "synthetic" } : name === "patient_history" ? { core: {} } : null,
    updateOne: async (_filter, update, opts) => { assert.ok(opts.session); emr.review = update.$set.review; return { matchedCount: 1 }; },
  }) };
  const expected = stage3.evaluatePrescriptionSafety(["paracetamol"], emr.snapshot.medications);
  const persistedAudits = [];
  const route = moduleOf("app/api/emr/review/[id]/route", {
    "next/server": { NextResponse: { json: (body, opts) => ({ body, status: opts?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => ({ db, consultationId: new MockId("cccccccccccccccccccccccc"),
      consultation: { patient_id: new MockId("dddddddddddddddddddddddd") }, session: sessionDoctor }),
      parseBoundedJson: async () => ({ expected_version: 7, confirmed_review: true, confirmed_prescription: true, allergy_assessment: "confirmed_known", acknowledged_warnings: expected.map(x => x.message) }) },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async (_db, fn) => fn({ id: "synthetic-session" }) },
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async (_db, event) => { persistedAudits.push(event); } },
  });
  const response = await route.POST({}, { params: Promise.resolve({ id: "cccccccccccccccccccccccc" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(emr.review.acknowledged_issues, expected);
  assert.equal(emr.review.safety_rules_version, stage3.ALLERGY_RULESET_VERSION);
  assert.equal(persistedAudits[0].after.acknowledged_issues.length, expected.length);
});
test("Stage3: provisional transcript banner is distinct from non-dismissible prescription warning", () => {
  const s = fs.readFileSync(path.join(root, "src/components/emr/EMRLivePanel.tsx"), "utf8");
  assert.match(s, /Provisional conversation check/);
  assert.match(s, /Prescription safety review required/);
  assert.match(s, /role="alert"/);
  assert.doesNotMatch(s, /setDismissedAllergyBanner\(allergyBanner\)/);
});

// Stage 4: deterministic, source-level clinical grounding and stable identity.
const identity4 = moduleOf("src/lib/emr/medicationIdentity");
const grounding4 = moduleOf("src/lib/emr/grounding");
const evidence4 = [{ id: "e1", is_final: true, text: "Start amoxicillin 500 mg twice daily" },
  { id: "e2", is_final: true, text: "Pulse rate is 80" }];
test("Stage4: legacy medication ID migration is deterministic and duplicates are disallowed", () => {
  const old = { medications: [{ name: "A" }, { name: "A" }] };
  const x = identity4.ensureMedicationIds(old, "synthetic-consultation");
  const y = identity4.ensureMedicationIds(old, "synthetic-consultation");
  assert.deepEqual(x, y);
  assert.notEqual(x.medications[0].id, x.medications[1].id);
  assert.throws(() => validator.sanitizeSnapshot({ medications: [x.medications[0], x.medications[0]] }), /Invalid medications/);
});
test("Stage4: ID-addressed medication update survives reorder without touching the other medicine", () => {
  const a = { id: identity4.createMedicationId(), name: "Amoxicillin" };
  const b = { id: identity4.createMedicationId(), name: "Cetirizine" };
  const operation = { op: "update_fact", path: `medications[id=${a.id}].dosage`, value: "500 mg", evidence_segment_ids: ["e1"] };
  assert.equal(validator.validateEMROperations([operation], new Set(["e1"]))[0].path, operation.path);
  const updated = reducer.applyEMROps({ medications: [b, a] }, [operation]);
  assert.equal(updated.medications[1].dosage, "500 mg");
  assert.equal(updated.medications[0].dosage, undefined);
  assert.equal(updated.medications[1].id, a.id);
});
test("Stage4: new medication appended with server-generated stable identity", () => {
  const op = { op: "set_fact", path: "medications[+]", value: { name: "Amoxicillin" }, evidence_segment_ids: ["e1"] };
  validator.validateEMROperations([op], new Set(["e1"]));
  const updated = reducer.applyEMROps({}, [op]);
  assert.match(updated.medications[0].id, /^med_[0-9a-f]{32}$/);
  assert.equal(updated.medications[0].name, "Amoxicillin");
  assert.equal(identity4.reconcileMedicationIds(updated.medications, [...updated.medications].reverse())[0].id, updated.medications[0].id);
});
test("Stage4: unknown target IDs cannot silently create a different medication", () => {
  const unknown = identity4.createMedicationId();
  const out = reducer.applyEMROps({ medications: [{ id: identity4.createMedicationId(), name: "A" }] }, [{ op: "set_fact", path: `medications[id=${unknown}].dosage`, value: "30 mg" }]);
  assert.equal(out.medications.length, 1);
  assert.ok(out.needs_confirmation.includes(`medications[id=${unknown}].dosage`));
});
test("Stage4: evidence ID must reference a real segment and lexical content must match", () => {
  assert.throws(() => validator.validateEMROperations([{ op: "set_fact", path: "chief_complaint", value: "Diabetes", evidence_segment_ids: ["fabricated"] }], new Set(["e1"])));
  assert.equal(grounding4.evaluateClaim("Amoxicillin", evidence4), "lexical_support");
  assert.equal(grounding4.evaluateClaim("Diabetes", evidence4), "unverified");
  assert.equal(grounding4.evaluateClaim(80, evidence4), "lexical_support");
});
test("Stage4: negated claim is not inserted into AI-authored EMR", () => {
  const seg = [{ id: "n1", text: "Patient denies fever", is_final: true }];
  assert.equal(grounding4.evaluateClaim("fever", seg), "contradicted");
  const evaluated = grounding4.groundDeltaOps([{ op: "set_fact", path: "chief_complaint", value: "fever", evidence_segment_ids: ["n1"] }], seg, {});
  assert.equal(evaluated.operations[0].op, "mark_uncertain");
  assert.equal(evaluated.findings[0].reason, "Potentially negated claim");
});
test("Stage4: fabricated AI value becomes review-only finding, not clinical fact", () => {
  const evaluated = grounding4.groundDeltaOps([{ op: "set_fact", path: "chief_complaint", value: "Diabetes", evidence_segment_ids: ["e1"] }], evidence4, {});
  assert.equal(evaluated.operations[0].op, "mark_uncertain");
  assert.equal(reducer.applyEMROps({}, evaluated.operations).chief_complaint, undefined);
  assert.equal(evaluated.findings.length, 1);
});
test("Stage4: medication field-level evidence excludes unsaid dosage", () => {
  const op = { op: "set_fact", path: "medications[+]", value: { name: "amoxicillin", dosage: "900 mg" }, evidence_segment_ids: ["e1"] };
  const evaluated = grounding4.groundDeltaOps([op], evidence4, {});
  assert.deepEqual(evaluated.operations[0].value, { name: "amoxicillin" });
  assert.ok(evaluated.findings.some(x => x.path.endsWith(".dosage")));
});
test("Stage4: full extraction keeps only fields with evidence and preserves existing clinical facts", () => {
  const prior = { chief_complaint: "Persistent cough", medications: [] };
  const candidate = { chief_complaint: "Diabetes", vitals: { pulse_rate: 80 }, diagnosis_text: ["Tuberculosis"] };
  const result = grounding4.groundFinalSnapshot(candidate, prior, { chief_complaint: ["e1"], "vitals.pulse_rate": ["e2"], "diagnosis_text[0]": ["e1"] }, evidence4, {});
  assert.equal(result.snapshot.chief_complaint, "Persistent cough");
  assert.equal(result.snapshot.vitals.pulse_rate, 80);
  assert.equal(result.snapshot.diagnosis_text, undefined);
  assert.ok(result.snapshot.needs_confirmation.includes("chief_complaint"));
  assert.deepEqual(result.provenance["vitals.pulse_rate"].evidence_segment_ids, ["e2"]);
});
test("Stage4: persisted provenance survives a subsequent unrelated AI operation", () => {
  const original = grounding4.applyProvenanceChanges({}, [{ path: "chief_complaint", origin: "ai", evidence_segment_ids: ["e1"], grounding: "lexical_support" }], "2026-01-01T00:00:00Z");
  const updated = grounding4.applyProvenanceChanges(original, [{ path: "vitals.pulse_rate", origin: "clinician_entry" }]);
  assert.deepEqual(updated.chief_complaint.evidence_segment_ids, ["e1"]);
  assert.equal(updated["vitals.pulse_rate"].origin, "clinician_entry");
});
test("Stage4: clinician correction resists final extraction and keeps its origin", () => {
  const prior = { chief_complaint: "Clinician confirmed note", medications: [{ id: identity4.createMedicationId(), name: "Amoxicillin", dosage: "250 mg" }] };
  const path = `medications[id=${prior.medications[0].id}].dosage`;
  const provenance = grounding4.applyProvenanceChanges({}, [{ path: "chief_complaint", origin: "clinician_correction" }, { path, origin: "clinician_correction" }]);
  const candidate = { chief_complaint: "amoxicillin", medications: [{ ...prior.medications[0], dosage: "500 mg" }] };
  const result = grounding4.groundFinalSnapshot(candidate, prior, { chief_complaint: ["e1"], "medications[0].dosage": ["e1"] }, evidence4, provenance);
  assert.equal(result.snapshot.chief_complaint, "Clinician confirmed note");
  assert.equal(result.snapshot.medications[0].dosage, "250 mg");
  assert.equal(result.provenance[path].origin, "clinician_correction");
});
test("Final extraction accepts normalized medications without grounding storage metadata", () => {
  const normalize = moduleOf("src/lib/emr/normalizeMedications");
  for (const confidence of [undefined, "high"]) {
    const candidate = { medications: identity4.reconcileMedicationIds([], normalize.normalizeMedicationsArray([
      { name: "Paracetamol", dosage: "500 mg", frequency: "once daily", duration: "3 days", confidence,
        icd10_code: "fabricated-code", icd10_description: "fabricated description" },
    ])) };
    const evidence = Object.fromEntries(["name", "dosage", "frequency", "duration"].map(field => [`medications[0].${field}`, ["m1"]]));
    const result = grounding4.groundFinalSnapshot(candidate, {}, evidence,
      [{ id: "m1", text: "Prescribe Paracetamol 500 mg once daily for 3 days.", is_final: true }], {});
    assert.doesNotThrow(() => validator.sanitizeSnapshot(result.snapshot));
    assert.equal(result.snapshot.medications[0].dosage, "500 mg");
    assert.equal(result.snapshot.medications[0].icd10_code, undefined);
    assert.equal(result.snapshot.medications[0].confidence, undefined);
    assert.deepEqual(result.findings, []);
  }
});

test("Grounding retains single-digit quantities and rejects unsupported numbers", () => {
  const segments = [{ id: "m1", text: "Take 1 tablet for 3 days.", is_final: true }];
  assert.equal(grounding4.evaluateClaim("3 days", segments), "lexical_support");
  assert.equal(grounding4.evaluateClaim("1 tablet", segments), "lexical_support");
  assert.equal(grounding4.evaluateClaim("2 tablets", segments), "unverified");
  assert.equal(grounding4.evaluateClaim("5 days", segments), "unverified");
});

test("Stage4: AI medication identity injection is rejected", () => {
  const id = identity4.createMedicationId();
  assert.throws(() => validator.validateEMROperations([{ op: "set_fact", path: "medications[+]", value: { name: "Amoxicillin", id }, evidence_segment_ids: ["e1"] }], new Set(["e1"])));
});
test("Stage4: review requires grounding acknowledgement, while existing allergy checks remain in force", async () => {
  const emr = { _id: new MockId("eeeeeeeeeeeeeeeeeeeeeeee"), version: 9, final_transcript_hash: (await import("node:crypto")).createHash("sha256").update("synthetic").digest("hex"),
    snapshot: {}, grounding_findings: [{ path: "chief_complaint", reason: "Unsupported claim", evidence_segment_ids: ["e1"] }] };
  const db = { collection: name => ({ findOne: async () => name === "emr_entries" ? emr : name === "transcripts" ? { processing_status: "completed", raw_text: "synthetic" } : null }) };
  const route = moduleOf("app/api/emr/review/[id]/route", {
    "next/server": { NextResponse: { json: (body, o) => ({ body, status: o?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => ({ db, consultationId: new MockId("cccccccccccccccccccccccc"), consultation: { patient_id: new MockId("dddddddddddddddddddddddd") }, session: sessionDoctor }), parseBoundedJson: async () => ({ expected_version: 9, confirmed_review: true, confirmed_prescription: true, allergy_assessment: "confirmed_none", acknowledged_warnings: [] }) },
    "@/src/lib/clinical/prescriptionSafetyServer": { screenPrescription: async () => ({ issues: [], allergies: [], rule_version: "test" }) },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async (_db, fn) => fn({}) },
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async () => ({}) },
  });
  const response = await route.POST({}, { params: Promise.resolve({ id: "cccccccccccccccccccccccc" }) });
  assert.equal(response.status, 422);
  assert.match(response.body.error, /grounding|Unsupported|uncertain/i);
});

test("Stage4: mocked final extraction grounds vitals, rejects negation and protects clinician correction", async () => {
  const consultationId = new MockId("cccccccccccccccccccccccc");
  const emr = { _id: new MockId("eeeeeeeeeeeeeeeeeeeeeeee"), version: 4,
    snapshot: { chief_complaint: "Clinician-confirmed note" }, manual_override_keys: ["chief_complaint"],
    provenance: grounding4.applyProvenanceChanges({}, [{ path: "chief_complaint", origin: "clinician_correction" }]) };
  let committed, audit;
  const session = { id: "synthetic-mongo-session" };
  const transcript = { processing_status: "completed", raw_text: "Patient denies fever. Pulse rate is 80",
    segments: [{ id: "e1", text: "Patient denies fever", is_final: true }, { id: "e2", text: "Pulse rate is 80", is_final: true }] };
  const db = { collection: name => ({
    findOne: async () => name === "transcripts" ? transcript : name === "emr_entries" ? emr : null,
    updateOne: async (_filter, update, options) => {
      assert.equal(options.session, session);
      committed = update.$set;
      return { matchedCount: 1 };
    },
  }) };
  class SyntheticGroq {
    constructor() { this.chat = { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({
      chief_complaint: "fever", vitals: { pulse_rate: 80 }, field_evidence: { chief_complaint: ["e1"], "vitals.pulse_rate": ["e2"] },
    }) } }] }) } }; }
  }
  const route = moduleOf("app/api/emr/extract/route", {
    "groq-sdk": { __esModule: true, default: SyntheticGroq },
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => ({ db, session: sessionDoctor, consultationId,
      consultation: { patient_id: new MockId("dddddddddddddddddddddddd") } }),
      parseBoundedJson: async () => ({ consultation_id: consultationId.toString() }), enforceUsageLimit: async () => true },
    "@/src/lib/clinical/prescriptionSafetyServer": { screenPrescription: async () => ({ issues: [], rule_version: "synthetic" }) },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async (_db, fn) => fn(session) },
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async (_db, event) => { audit = event; } },
  });
  const prior = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "synthetic-not-live";
  try {
    const result = await route.POST({});
    assert.equal(result.status, 200);
    assert.equal(committed.snapshot.chief_complaint, "Clinician-confirmed note");
    assert.equal(committed.snapshot.vitals.pulse_rate, 80);
    assert.deepEqual(committed.provenance["vitals.pulse_rate"].evidence_segment_ids, ["e2"]);
    assert.equal(committed.provenance.chief_complaint.origin, "clinician_correction");
    assert.equal(committed.grounding_findings[0].path, "chief_complaint");
    assert.ok(audit && audit.mongoSession === session);
  } finally { if (prior === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = prior; }
});

test("Stage4: doctor approval marks AI provenance reviewed in same review transaction", async () => {
  const emr = { _id: new MockId("eeeeeeeeeeeeeeeeeeeeeeee"), version: 6,
    final_transcript_hash: (await import("node:crypto")).createHash("sha256").update("synthetic").digest("hex"), snapshot: { chief_complaint: "Pain" },
    provenance: grounding4.applyProvenanceChanges({}, [{ path: "chief_complaint", origin: "ai", evidence_segment_ids: ["e1"], grounding: "lexical_support" }]) };
  let update;
  const db = { collection: name => ({ findOne: async () => name === "emr_entries" ? emr : name === "transcripts" ? { processing_status: "completed", raw_text: "synthetic" } : null, updateOne: async (_, u) => { update = u; return { matchedCount: 1 }; } }) };
  const route = moduleOf("app/api/emr/review/[id]/route", {
    "next/server": { NextResponse: { json: (body, o) => ({ body, status: o?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => ({ db, consultationId: new MockId("cccccccccccccccccccccccc"), consultation: { patient_id: new MockId("dddddddddddddddddddddddd") }, session: sessionDoctor }), parseBoundedJson: async () => ({ expected_version: 6, confirmed_review: true, confirmed_prescription: true, allergy_assessment: "confirmed_none", acknowledged_warnings: [] }) },
    "@/src/lib/clinical/prescriptionSafetyServer": { screenPrescription: async () => ({ issues: [], allergies: [], rule_version: "test" }) },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async (_db, fn) => fn({}), isClinicalConflict: () => false },
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async () => ({}) },
  });
  const response = await route.POST({}, { params: Promise.resolve({ id: "cccccccccccccccccccccccc" }) });
  assert.equal(response.status, 200);
  assert.equal(update.$set.provenance.chief_complaint.reviewed, true);
  assert.deepEqual(update.$set.provenance.chief_complaint.evidence_segment_ids, ["e1"]);
});

test("Stage4: unresolved array findings remain a valid bounded snapshot", () => {
  const previous = {};
  const candidate = { diagnosis_text: ["Unsupported synthetic diagnosis"] };
  const grounded = grounding4.groundFinalSnapshot(candidate, previous, { "diagnosis_text[0]": ["e1"] }, evidence4, {});
  assert.equal(grounded.snapshot.diagnosis_text, undefined);
  assert.ok(grounded.snapshot.needs_confirmation.includes("diagnosis_text[0]"));
  assert.doesNotThrow(() => validator.sanitizeSnapshot(grounded.snapshot));
  assert.doesNotThrow(() => validator.sanitizeSnapshot({ needs_confirmation: ["medications[+]", "diagnosis_text[0]"] }));
});

test("Stage4: multi-item AI list checks every clinical assertion independently", () => {
  const candidate = { op: "set_fact", path: "symptoms", value: ["amoxicillin", "unspoken-syndrome"], evidence_segment_ids: ["e1"] };
  const result = grounding4.groundDeltaOps([candidate], evidence4, {});
  assert.deepEqual(result.operations[0].value, ["amoxicillin"]);
  assert.ok(result.findings.some(f => f.path === "symptoms[1]"));
  assert.equal(result.changes[0].path, "symptoms[0]");
});
test("Stage4: whole-medication AI list is decomposed and cannot erase existing treatment", () => {
  const old = { medications: [{ id: identity4.createMedicationId(), name: "Cetirizine" }] };
  const proposal = { op: "set_fact", path: "medications", value: [{ name: "amoxicillin" }], evidence_segment_ids: ["e1"] };
  const grounded = grounding4.groundDeltaOps([proposal], evidence4, old);
  const updated = reducer.applyEMROps(old, grounded.operations);
  assert.equal(updated.medications.length, 2);
  assert.equal(updated.medications[0].name, "Cetirizine");
  assert.equal(updated.medications[1].name, "amoxicillin");
});

// Stage 5: deterministic substitutes exercise the concurrency/audit contracts.
// These do not substitute for a disposable MongoDB replica-set integration run.
test("Stage5: audit indexes initialize once per database and retry after a failed initialization", async () => {
  let count = 0;
  let rejectFirst = true;
  const client = {};
  function fakeDb(name) {
    return { client, databaseName: name, collection: () => ({ createIndex: async () => {
      count++;
      if (name === "temporary_failure" && rejectFirst) { rejectFirst = false; throw Error("index_create_unavailable"); }
    } }) };
  }
  const ledger = moduleOf("src/lib/audit/consultationLedger", { mongodb: { ObjectId: MockId } });
  const a = fakeDb("first");
  await Promise.all([ledger.prepareAuditIndexes(a), ledger.prepareAuditIndexes(a)]);
  assert.equal(count, 5, "concurrent initialization must not issue duplicate indexes");
  await ledger.prepareAuditIndexes(fakeDb("second"));
  assert.equal(count, 10, "a separate database must not inherit ready state");
  await assert.rejects(ledger.prepareAuditIndexes(fakeDb("temporary_failure")), /index_create_unavailable/);
  await ledger.prepareAuditIndexes(fakeDb("temporary_failure"));
});

test("Stage5: audit refuses nontransactional or invalid consultation writes", async () => {
  let writes = 0;
  const ledger = moduleOf("src/lib/audit/consultationLedger", { mongodb: { ObjectId: Object.assign(MockId, { isValid: v => /^[a-f0-9]{24}$/.test(v) }) } });
  const db = { collection: () => { writes++; throw new Error("must not access DB"); } };
  await assert.rejects(ledger.logConsultationAudit(db, {
    consultationId: "cccccccccccccccccccccccc", source: "doctor_manual", eventType: "manual_edit", before: {}, after: { x: 1 },
  }), /audit_transaction_required/);
  await assert.rejects(ledger.logConsultationAudit(db, {
    consultationId: "invalid", source: "doctor_manual", eventType: "manual_edit", mongoSession: {},
  }), /audit_consultation_id_invalid/);
  assert.equal(writes, 0);
});

test("Stage5: no-op audit does not mutate the parent or append an event", async () => {
  let writes = 0;
  const ledger = moduleOf("src/lib/audit/consultationLedger", { mongodb: { ObjectId: Object.assign(MockId, { isValid: v => /^[a-f0-9]{24}$/.test(v) }) } });
  const db = { collection: () => { writes++; throw Error("unexpected database call"); } };
  await ledger.logConsultationAudit(db, { consultationId: "cccccccccccccccccccccccc", source: "doctor_manual",
    eventType: "no_change", before: { val: 1 }, after: { val: 1 }, mongoSession: {} });
  assert.equal(writes, 0);
});

test("Stage5: audit refuses missing consultation instead of writing an orphaned event", async () => {
  let inserted = false;
  const ledger = moduleOf("src/lib/audit/consultationLedger", { mongodb: { ObjectId: Object.assign(MockId, { isValid: v => /^[a-f0-9]{24}$/.test(v) }) } });
  const db = { collection: name => name === "consultations" ? {
    updateOne: async () => ({ matchedCount: 0 }),
  } : { insertOne: async () => { inserted = true; }, find: () => { throw Error("should stop before reading previous event"); } } };
  await assert.rejects(ledger.logConsultationAudit(db, { consultationId: "cccccccccccccccccccccccc", source: "ai_delta",
    eventType: "ai_change", before: {}, after: { value: 1 }, mongoSession: {} }), /audit_consultation_missing/);
  assert.equal(inserted, false);
});

test("Stage5: a transaction cannot mutate an already completed consultation", async () => {
  let startedWork = 0;
  let endedSession = 0;
  let state = "completed";
  const db = { client: { startSession: () => ({
    withTransaction: async (cb) => cb(), endSession: async () => { endedSession++; },
  }) }, collection: () => ({ updateOne: async filter => ({ matchedCount: filter.status === state ? 1 : 0 }) }) };
  const transaction = moduleOf("src/lib/mongodb/clinicalTransaction", {
    "@/src/lib/audit/consultationLedger": { prepareAuditIndexes: async () => {} },
  });
  await assert.rejects(transaction.clinicalTransaction(db, async () => { startedWork++; },
    { activeConsultationId: new MockId("cccccccccccccccccccccccc") }), /no longer active/);
  assert.equal(startedWork, 0);
  assert.equal(endedSession, 1);
  state = "active";
  await transaction.clinicalTransaction(db, async () => { startedWork++; },
    { activeConsultationId: new MockId("cccccccccccccccccccccccc") });
  assert.equal(startedWork, 1);
  assert.equal(endedSession, 2);
  assert.equal(transaction.isClinicalConflict({ code: 112 }), true);
  assert.equal(transaction.isClinicalConflict({ code: 11000 }), true);
});

test("Stage5: a committed delta replay returns the newest clinician snapshot/version", async () => {
  const done = { operations: [], snapshot: { chief_complaint: "AI prior" }, version: 2,
    new_cursor: { last_final_segment_id: "segment-1", last_final_index: 0 } };
  const latest = { snapshot: { chief_complaint: "Clinician corrected" }, version: 3,
    extraction_cursor: { last_final_segment_id: "segment-2", last_final_index: 1 } };
  const db = { collection: name => ({ findOne: async () => name === "emr_entries" ? latest :
    name === "emr_extraction_batches" ? { status: "done", result: done } : null }) };
  const route = moduleOf("app/api/emr/extract-delta/route", {
    mongodb: { ObjectId: MockId },
    "groq-sdk": { __esModule: true, default: class { constructor() { throw Error("must not invoke provider"); } } },
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => ({ db, session: sessionDoctor,
      consultationId: new MockId("cccccccccccccccccccccccc"), consultation: { patient_id: new MockId("dddddddddddddddddddddddd") } }),
      parseBoundedJson: async () => ({ consultation_id: "cccccccccccccccccccccccc", segments_delta: [{ id: "segment-1", text: "Pain" }] }) },
  });
  const res = await route.POST({});
  assert.equal(res.status, 200);
  assert.equal(res.body.replayed, true);
  assert.deepEqual(res.body.snapshot, latest.snapshot);
  assert.deepEqual(res.body.new_cursor, latest.extraction_cursor);
  assert.equal(res.body.version, 3);
});

test("Stage5: exhausted extraction lease retries do not call Groq or write the EMR", async () => {
  let mutated = false;
  const recorded = [{ id: "segment-1", text: "Cough", is_final: true }];
  const db = { collection: name => ({
    findOne: async () => name === "emr_entries" ? { version: 0, snapshot: {} }
      : name === "emr_extraction_batches" ? { status: "failed", attempt_count: 3, retryable: true }
      : name === "transcripts" ? { segments: recorded } : null,
    updateOne: async () => { mutated = true; }, insertOne: async () => { throw { code: 11000 }; },
  }) };
  const route = moduleOf("app/api/emr/extract-delta/route", {
    mongodb: { ObjectId: MockId },
    "groq-sdk": { __esModule: true, default: class { constructor() { throw Error("provider called"); } } },
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => ({ db, session: sessionDoctor,
      consultationId: new MockId("cccccccccccccccccccccccc"), consultation: { patient_id: new MockId("dddddddddddddddddddddddd") } }),
      parseBoundedJson: async () => ({ consultation_id: "cccccccccccccccccccccccc", segments_delta: recorded }),
      enforceUsageLimit: async () => true },
  });
  const res = await route.POST({});
  assert.equal(res.status, 429);
  assert.equal(res.body.retryable, false);
  assert.equal(mutated, false);
});

test("Stage5: competing consultation-scoped EMR saves allow one CAS update and one 409", async () => {
  let doc = { _id: new MockId("eeeeeeeeeeeeeeeeeeeeeeee"), version: 0, snapshot: { chief_complaint: "Initial" } };
  let auditWrites = 0;
  const db = { collection: name => name === "emr_entries" ? {
    findOne: async () => ({ ...doc, snapshot: { ...doc.snapshot } }),
    updateOne: async filter => {
      if (filter.version !== doc.version) return { matchedCount: 0, upsertedCount: 0 };
      doc = { ...doc, version: doc.version + 1 };
      return { matchedCount: 1, upsertedCount: 0 };
    },
  } : { findOne: async () => null } };
  const route = moduleOf("app/api/emr/by-consultation/[id]/route", {
    mongodb: { ObjectId: MockId },
    "next/server": { NextResponse: { json: (body, opts) => ({ body, status: opts?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => ({ db, session: sessionDoctor,
      consultationId: new MockId("cccccccccccccccccccccccc"), consultation: { patient_id: new MockId("dddddddddddddddddddddddd") } }),
      parseBoundedJson: async request => request.body },
    "@/src/lib/clinical/prescriptionSafetyServer": { screenPrescription: async () => ({ issues: [], rule_version: "synthetic" }) },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async (_db, work) => work({}),
      isClinicalConflict: error => error instanceof Error && error.message === "Concurrent EMR update" },
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async () => { auditWrites++; } },
  });
  const makeReq = label => ({ body: { expected_version: 0, snapshot: { chief_complaint: label } } });
  const responses = await Promise.all([
    route.PUT(makeReq("Clinician A"), { params: Promise.resolve({ id: "cccccccccccccccccccccccc" }) }),
    route.PUT(makeReq("Clinician B"), { params: Promise.resolve({ id: "cccccccccccccccccccccccc" }) }),
  ]);
  assert.deepEqual(responses.map(x => x.status).sort(), [200, 409]);
  assert.equal(doc.version, 1);
  assert.equal(auditWrites, 1);
});

test("Stage5: expired delta lease is reclaimed by token and old TTL expiry is cleared", async () => {
  let reclaim;
  let cleanup;
  const recorded = [{ id: "segment-1", text: "SYNTHETIC new cough", is_final: true }];
  const db = { collection: name => {
    if (name === "emr_entries") return { findOne: async () => ({ version: 0, snapshot: {} }) };
    if (name === "transcripts") return { findOne: async () => ({ segments: recorded }) };
    if (name === "patients" || name === "patient_history") return { findOne: async () => ({ allergies: [] }) };
    if (name === "emr_extraction_batches") return {
      findOne: async () => ({ status: "processing", lease_token: "previous-token", attempt_count: 1,
        expires_at: new Date(0) }),
      insertOne: async () => { throw { code: 11000 }; },
      updateOne: async (filter, update) => {
        if (update.$set.status === "processing") reclaim = { filter, update };
        if (update.$set.status === "failed") cleanup = { filter, update };
        return { matchedCount: 1 };
      },
    };
    throw Error("unexpected collection " + name);
  } };
  const route = moduleOf("app/api/emr/extract-delta/route", {
    mongodb: { ObjectId: MockId },
    "groq-sdk": { __esModule: true, default: class { constructor() {
      this.chat = { completions: { create: async () => { throw Error("offline provider"); } } };
    } } },
    "next/server": { NextResponse: { json: (body, opts) => ({ body, status: opts?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => ({ db, session: sessionDoctor,
      consultationId: new MockId("cccccccccccccccccccccccc"), consultation: { patient_id: new MockId("dddddddddddddddddddddddd") } }),
      parseBoundedJson: async () => ({ consultation_id: "cccccccccccccccccccccccc", segments_delta: recorded }),
      enforceUsageLimit: async () => true },
  });
  const previous = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "synthetic-key";
  try {
    const response = await route.POST({});
    assert.equal(response.status, 503);
    assert.equal(reclaim.filter.lease_token, "previous-token");
    assert.equal(reclaim.update.$unset.expires_at, "");
    assert.equal(reclaim.update.$inc.attempt_count, 1);
    assert.equal(cleanup.filter.lease_token, reclaim.update.$set.lease_token);
    assert.ok(cleanup.update.$set.retry_after instanceof Date);
  } finally {
    if (previous === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previous;
  }
});

test("Stage5: version-only no-op writes still produce one hash-linked audit event when requested", async () => {
  const events = [];
  const session = { synthetic: true };
  const db = { collection: name => name === "consultations" ? {
    updateOne: async (_filter, _update, options) => {
      assert.equal(options.session, session);
      return { matchedCount: 1 };
    },
  } : { find: () => ({ sort: () => ({ limit: () => ({ next: async () => events.at(-1) ?? null }) }) }),
    insertOne: async (record, options) => {
      assert.equal(options.session, session);
      events.push(record);
    } } };
  const ledger = moduleOf("src/lib/audit/consultationLedger", {
    mongodb: { ObjectId: Object.assign(MockId, { isValid: v => /^[a-f0-9]{24}$/.test(v) }) },
  });
  const input = { consultationId: "cccccccccccccccccccccccc", actorId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    actorRole: "doctor", source: "doctor_manual", eventType: "emr_version_increment",
    before: { chief_complaint: "same" }, after: { chief_complaint: "same" }, allowNoop: true, mongoSession: session };
  await ledger.logConsultationAudit(db, input);
  await ledger.logConsultationAudit(db, input);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].changed_paths, []);
  assert.equal(events[0].sequence_no, 1);
  assert.equal(events[1].sequence_no, 2);
  assert.equal(events[1].prev_hash, events[0].event_hash);
  assert.match(events[1].event_hash, /^[a-f0-9]{64}$/);
});

test("Stage5: simultaneous consultation metadata updates cannot both pass the version filter", async () => {
  let persistedVersion = 0;
  let audits = 0;
  const consultation = { status: "active", metadata_version: 0, patient_id: new MockId("dddddddddddddddddddddddd") };
  const db = { collection: () => ({ updateOne: async (filter) => {
    if (filter.metadata_version !== persistedVersion) return { matchedCount: 0 };
    persistedVersion++;
    return { matchedCount: 1 };
  } }) };
  const route = moduleOf("app/api/consultations/[id]/route", {
    mongodb: { ObjectId: MockId },
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    "@/src/lib/security/access": { accessConsultation: async () => ({ db, session: sessionDoctor,
      consultationId: new MockId("cccccccccccccccccccccccc"), consultation }),
      parseBoundedJson: async request => request.body },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async (_db, callback) => callback({}) },
    "@/src/lib/audit/consultationLedger": { prepareAuditIndexes: async () => {},
      logConsultationAudit: async () => { audits++; } },
  });
  const makeRequest = days => ({ body: { follow_up_in_days: days } });
  const responses = await Promise.all([
    route.PATCH(makeRequest(7), { params: Promise.resolve({ id: "cccccccccccccccccccccccc" }) }),
    route.PATCH(makeRequest(14), { params: Promise.resolve({ id: "cccccccccccccccccccccccc" }) }),
  ]);
  assert.deepEqual(responses.map(x => x.status).sort(), [200, 409]);
  assert.equal(persistedVersion, 1);
  assert.equal(audits, 1);
});
