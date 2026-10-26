/** Synthetic-only Stage 8 clinical sign-off regression tests. No real patients/providers/DB. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(import.meta.url)(process.env.MEDIFLOW_TYPESCRIPT ?? "typescript");
const require = createRequire(import.meta.url);
function moduleOf(rel, mocks = {}, cache = {}) {
  if (rel.startsWith("@/")) rel = rel.slice(2);
  if (rel.endsWith(".json")) return JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const file = path.join(root, rel.endsWith(".ts") ? rel : `${rel}.ts`);
  if (cache[file]) return cache[file].exports;
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} }; cache[file] = mod;
  new Function("require", "module", "exports", compiled)((spec) => {
    if (Object.hasOwn(mocks, spec)) return mocks[spec];
    if (spec.startsWith("@/")) return moduleOf(spec, mocks, cache);
    if (spec.startsWith(".")) return moduleOf(path.relative(root, path.resolve(path.dirname(file), spec)), mocks, cache);
    return require(spec);
  }, mod, mod.exports);
  return mod.exports;
}
const policy = moduleOf("src/lib/clinical/reviewPolicy");
const safeMedication = { id: "med_synthetic", name: "Paracetamol", dosage: "500 mg", frequency: "once daily", duration: "3 days" };
const hash = s => createHash("sha256").update(s).digest("hex");
const oid = v => ({ toString: () => v });
const auth = { consultationId: oid("cccccccccccccccccccccccc"), consultation: { patient_id: oid("dddddddddddddddddddddddd"), status: "active" }, session: { uid: "aaaaaaaaaaaaaaaaaaaaaaaa", actor_id: "aaaaaaaaaaaaaaaaaaaaaaaa", role: "doctor" } };
const json = { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } };
const params = { params: Promise.resolve({ id: "cccccccccccccccccccccccc" }) };

function stateFixture({ meds = [], findings = [], graph = null, job = null, allergies = [], transcriptStatus = "completed" } = {}) {
  const emr = { _id: oid("eeeeeeeeeeeeeeeeeeeeeeee"), version: 3, requires_review: true,
    snapshot: { chief_complaint: "Synthetic test", medications: meds }, provenance: {}, grounding_findings: findings,
    final_transcript_hash: hash("synthetic") };
  const docs = { emr_entries: emr, transcripts: { raw_text: "synthetic", processing_status: transcriptStatus,
    segments: [{ id: "s1", text: "synthetic" }] }, patient_family_graphs: graph, emr_extraction_batches: job,
    patients: { allergies }, patient_history: { core: {} } };
  const history = [];
  const db = { collection: name => ({ findOne: async () => docs[name] ?? null, updateOne: async (filter, update, options) => {
    history.push({ name, filter, update, options });
    if (name === "emr_entries") { if (filter.version !== emr.version || filter.requires_review !== emr.requires_review) return { matchedCount: 0 }; Object.assign(emr, update.$set); }
    return { matchedCount: 1 };
  } }) };
  return { emr, docs, db, history };
}
function reviewRoute(fixture, input, opts = {}) {
  return moduleOf("app/api/emr/review/[id]/route", {
    "next/server": json,
    "@/src/lib/security/access": { accessConsultation: async () => opts.authError ? { error: { status: opts.authError } } : { ...auth, db: fixture.db }, parseBoundedJson: async () => input },
    "@/src/lib/clinical/prescriptionSafetyServer": { screenPrescription: async () => ({ allergies: fixture.docs.patients.allergies, issues: opts.issues ?? [], rule_version: "synthetic-v1" }) },
    "./prescriptionSafetyServer": { screenPrescription: async () => ({ allergies: fixture.docs.patients.allergies, issues: opts.issues ?? [], rule_version: "synthetic-v1" }) },
    "@/src/lib/mongodb/clinicalTransaction": { clinicalTransaction: async (_db, work) => work({ transaction: true }), isClinicalConflict: () => false },
    "@/src/lib/audit/consultationLedger": { logConsultationAudit: async (_db, event) => { if (opts.auditFail) throw Error("audit unavailable"); fixture.audit = event; } },
  });
}

const completeInput = { expected_version: 3, confirmed_review: true, confirmed_prescription: true, allergy_assessment: "confirmed_none", acknowledged_warnings: [], acknowledged_grounding: [] };

test("Stage8: medication prescription fields are required; draft rows are not medications", () => {
  assert.deepEqual(policy.prescriptionFieldProblems({ medications: [safeMedication] }), []);
  assert.deepEqual(policy.prescriptionFieldProblems({ medications: [{ id: "med_legacy", name: "", dosage: "", frequency: "", duration: "" }] }), []);
  const invalid = policy.prescriptionFieldProblems({ medications: [{ name: "Paracetamol", dosage: "", frequency: null, duration: "" }] });
  assert.deepEqual(invalid.map(x => x.path), ["medications[0].dosage", "medications[0].frequency", "medications[0].duration"]);
  assert.equal(policy.prescriptionFieldProblems({ medications: [{ name: "", dosage: "500 mg" }] })[0].code, "medication_name");
});
test("Stage8: review statuses and transcript/family blockers are deterministic", () => {
  assert.equal(policy.reviewStatus({ blockers: [], reviewed: false }), "Pending Review");
  assert.equal(policy.reviewStatus({ blockers: [], reviewed: true }), "Ready for Sign-Off");
  assert.equal(policy.reviewStatus({ blockers: [{ code: "x", path: "x", message: "x" }], reviewed: true }), "Requires Correction");
  assert.equal(policy.reviewStatus({ blockers: [], completed: true }), "Completed");
  assert.equal(policy.transcriptBlockers({ raw_text: "synthetic", processing_status: "completed" }, hash("synthetic")).length, 0);
  assert.equal(policy.transcriptBlockers({ raw_text: "synthetic", processing_status: "processing" }, hash("synthetic")).length, 1);
  assert.equal(policy.transcriptBlockers({ raw_text: "altered", processing_status: "completed" }, hash("synthetic")).length, 1);
  assert.equal(policy.familyProposalBlockers({ relatives: [{ status: "proposed" }], assertions: [{ status: "rejected" }] }).length, 1);
});
test("Stage8: signed snapshot hash changes with the snapshot, provenance and findings", () => {
  const original = policy.reviewedSnapshotFingerprint({ medications: [safeMedication] }, {}, []);
  assert.notEqual(original, policy.reviewedSnapshotFingerprint({ medications: [{ ...safeMedication, duration: "1 day" }] }, {}, []));
  assert.notEqual(original, policy.reviewedSnapshotFingerprint({ medications: [safeMedication] }, { "medications[0]": { origin: "ai" } }, []));
  assert.notEqual(original, policy.reviewedSnapshotFingerprint({ medications: [safeMedication] }, {}, [{ path: "diagnosis_text", reason: "unsupported" }]));
});
test("Stage8: review GET exposes structured EMR, status, provenance, pending proposals and bounded evidence", async () => {
  const fixture = stateFixture({ meds: [safeMedication], graph: { relatives: [{ status: "proposed", id: "r1", relation: "mother", label: "" }] } });
  const response = await reviewRoute(fixture, completeInput).GET({}, params);
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "Requires Correction");
  assert.equal(response.body.family_proposals.relatives.length, 1);
  assert.equal(response.body.snapshot.medications[0].name, "Paracetamol");
  assert.equal(response.body.evidence[0].id, "s1");
});
test("Stage8: no authorized doctor means no access to review", async () => {
  const fixture = stateFixture();
  assert.equal((await reviewRoute(fixture, completeInput, { authError: 403 }).GET({}, params)).status, 403);
  assert.equal((await reviewRoute(fixture, completeInput, { authError: 403 }).POST({}, params)).status, 403);
});
test("Stage8: missing medication fields block sign-off before any database mutation", async () => {
  const fixture = stateFixture({ meds: [{ name: "Paracetamol" }] });
  const response = await reviewRoute(fixture, completeInput).POST({}, params);
  assert.equal(response.status, 422);
  assert.ok(response.body.blockers.some(b => b.code === "medication_dosage"));
  assert.equal(fixture.history.length, 0);
});
test("Stage8: active extraction and pending family proposals block sign-off", async () => {
  for (const setup of [{ job: { status: "processing" } }, { graph: { relatives: [{ status: "proposed" }] } }]) {
    const fixture = stateFixture({ meds: [safeMedication], ...setup });
    const response = await reviewRoute(fixture, completeInput).POST({}, params);
    assert.equal(response.status, 422);
    assert.equal(fixture.history.length, 0);
  }
});
test("Stage8: stale version and unapproved EMR cannot be signed", async () => {
  const fixture = stateFixture({ meds: [safeMedication] });
  assert.equal((await reviewRoute(fixture, { ...completeInput, expected_version: 2 }).POST({}, params)).status, 409);
  assert.equal((await reviewRoute(fixture, { ...completeInput, confirmed_review: false }).POST({}, params)).status, 422);
  assert.equal(fixture.history.length, 0);
});
test("Stage8: doctor must explicitly acknowledge every warning and grounding finding", async () => {
  const fixture = stateFixture({ meds: [safeMedication], findings: [{ path: "symptoms[0]", reason: "unsupported", evidence_segment_ids: ["s1"] }] });
  const warning = { id: "w1", message: "Potential allergy", rule_version: "synthetic-v1" };
  const noGrounding = await reviewRoute(fixture, completeInput, { issues: [warning] }).POST({}, params);
  assert.equal(noGrounding.status, 422);
  const noWarning = await reviewRoute(fixture, { ...completeInput, acknowledged_grounding: ["symptoms[0]"] }, { issues: [warning] }).POST({}, params);
  assert.equal(noWarning.status, 422);
  assert.equal(fixture.history.length, 0);
});
test("Stage8: doctor approval persists fingerprint and audit, never mutates original provenance in place", async () => {
  const fixture = stateFixture({ meds: [safeMedication] });
  const before = fixture.emr.provenance;
  const response = await reviewRoute(fixture, completeInput).POST({}, params);
  assert.equal(response.status, 200);
  assert.equal(fixture.emr.review.version, 3);
  assert.equal(fixture.emr.review.snapshot_fingerprint, policy.reviewedSnapshotFingerprint(fixture.emr.snapshot, fixture.emr.provenance, []));
  assert.equal(fixture.emr.requires_review, false);
  assert.ok(fixture.audit && fixture.audit.mongoSession);
  assert.equal(before === fixture.emr.provenance, false);
});
test("Stage8: failed audit does not return a successful sign-off", async () => {
  const fixture = stateFixture({ meds: [safeMedication] });
  const response = await reviewRoute(fixture, completeInput, { auditFail: true }).POST({}, params);
  assert.equal(response.status, 503);
  // Mock session has no rollback; real rollback still requires MongoDB replica-set integration.
});
test("Stage8: doctor approval does not overwrite a concurrent version change", async () => {
  const fixture = stateFixture({ meds: [safeMedication] });
  fixture.db.collection = name => ({ findOne: async () => fixture.docs[name] ?? null,
    updateOne: async () => ({ matchedCount: 0 }) });
  const response = await reviewRoute(fixture, completeInput).POST({}, params);
  assert.equal(response.status, 409);
});
test("Stage8: generic window.confirm was replaced by a version-aware structured dialog", () => {
  const workspace = fs.readFileSync(path.join(root, "src/components/doctor/consultation/ConsultationWorkspace.tsx"), "utf8");
  const dialog = fs.readFileSync(path.join(root, "src/components/doctor/consultation/ClinicalReviewDialog.tsx"), "utf8");
  assert.doesNotMatch(workspace, /window\.confirm\(/);
  assert.match(workspace, /ClinicalReviewDialog/);
  assert.match(dialog, /reviewed_version: data\.version/);
  assert.match(dialog, /hasUnsavedEdits/);
  assert.match(dialog, /role="dialog"/);
});

test("Stage8: changing allergy context invalidates prior sign-off without changing EMR version", async () => {
  const fixture = stateFixture({ meds: [safeMedication] });
  const route = reviewRoute(fixture, completeInput);
  assert.equal((await route.POST({}, params)).status, 200);
  assert.equal((await route.GET({}, params)).body.status, "Ready for Sign-Off");
  fixture.docs.patients.allergies.push("penicillin");
  assert.equal((await route.GET({}, params)).body.status, "Pending Review");
  assert.equal((await reviewRoute(fixture, { ...completeInput, allergy_assessment: "confirmed_known" }).POST({}, params)).status, 200);
});

test("Stage8: pending AI processing blocks review even with a complete transcript", async () => {
  const fixture = stateFixture({ meds: [safeMedication], job: { status: "processing" } });
  const result = await reviewRoute(fixture, completeInput).GET({}, params);
  assert.ok(result.body.blockers.some(b => b.code === "pending_extraction"));
  assert.equal(result.body.status, "Requires Correction");
});

test("Stage8: completion rejects a stale signed snapshot before any transaction", async () => {
  const docs = { emr_entries: { version: 3, requires_review: false,
    snapshot: { medications: [safeMedication] }, final_transcript_hash: hash("synthetic"),
    review: { version: 3, doctor_id: auth.session.uid, snapshot_fingerprint: "obsolete" } },
    transcripts: { processing_status: "completed", raw_text: "synthetic" }, patients: { allergies: [] }, patient_history: { core: {} } };
  const db = { collection: name => ({ findOne: async () => docs[name] ?? null }) };
  const route = moduleOf("app/api/consultations/[id]/route", {
    mongodb: { ObjectId: class { constructor(v) { this.value = v; } } },
    "next/server": json,
    "@/src/lib/security/access": { accessConsultation: async () => ({ ...auth, db }), parseBoundedJson: async () => ({ status: "completed", reviewed_version: 3 }) },
  });
  const result = await route.PATCH({}, params);
  assert.equal(result.status, 409);
  assert.match(result.body.error, /Clinical content changed/i);
});

test("Stage8: completion must use the exact clinician-approved EMR version", async () => {
  const docs = { emr_entries: { version: 4, requires_review: false, final_transcript_hash: hash("synthetic"),
    snapshot: {}, review: { version: 4, doctor_id: auth.session.uid } }, transcripts: { processing_status: "completed", raw_text: "synthetic" } };
  const db = { collection: name => ({ findOne: async () => docs[name] ?? null }) };
  const route = moduleOf("app/api/consultations/[id]/route", {
    mongodb: { ObjectId: class {} }, "next/server": json,
    "@/src/lib/security/access": { accessConsultation: async () => ({ ...auth, db }), parseBoundedJson: async () => ({ status: "completed", reviewed_version: 3 }) },
  });
  const result = await route.PATCH({}, params);
  assert.equal(result.status, 409);
  assert.match(result.body.error, /Sign-off version/i);
});

test("Stage8: clinician cannot bypass explicit prescription verification flag", async () => {
  const fixture = stateFixture({ meds: [safeMedication] });
  const response = await reviewRoute(fixture, { ...completeInput, confirmed_prescription: false }).POST({}, params);
  assert.equal(response.status, 422);
  assert.match(response.body.error, /prescription/i);
  assert.equal(fixture.history.length, 0);
});
