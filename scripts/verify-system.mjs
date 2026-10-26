/** Real local Next.js + MongoDB integration with an explicitly simulated Groq provider.
 * Uses only synthetic records on the disposable 127.0.0.1:27029 replica set.
 * Does not call Deepgram or Groq, and does not establish clinical accuracy.
 */
import assert from 'node:assert/strict';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createPortServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, open } from 'node:fs/promises';
import { MongoClient, ObjectId } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', quiet: true });
const uri = new URL(process.env.MONGODB_URI ?? '');
assert.equal(uri.protocol, 'mongodb:');
assert.equal(uri.hostname, '127.0.0.1');
assert.equal(uri.port, '27029');
assert.equal(uri.username + uri.password, '');
assert.equal(uri.searchParams.get('replicaSet'), 'rs0');
assert.equal(uri.searchParams.get('directConnection'), 'true');
const password = process.env.DEMO_DOCTOR_PASSWORD;
const receptionPassword = process.env.DEMO_RECEPTIONIST_PASSWORD;
assert.ok(password && receptionPassword && process.env.AUTH_SECRET, 'Configure local demo credentials first');

const report = { executed_at: new Date().toISOString(), database: 'real local MongoDB replica set',
  application: 'real production Next.js HTTP server', provider: 'local Groq HTTP fixture; no live AI or speech calls',
  checks: [], status: 'running' };
function pass(label) { report.checks.push(label); console.log(`PASS ${report.checks.length}: ${label}`); }
const client = new MongoClient(uri.toString(), { serverSelectionTimeoutMS: 5000 });
const db = client.db('cliniq');
let behavior = 'success', providerCalls = 0;
const fixture = {
  chief_complaint: 'headache', symptoms: ['headache'], diagnosis_text: ['headache'],
  medications: [{ name: 'Paracetamol', dosage: '500 mg', frequency: 'once daily', duration: '3 days' }],
  field_evidence: { chief_complaint: ['s1'], 'symptoms[0]': ['s1'], 'diagnosis_text[0]': ['s1'],
    'medications[0].name': ['s2'], 'medications[0].dosage': ['s2'], 'medications[0].frequency': ['s2'], 'medications[0].duration': ['s2'] },
  operations: [{ op: 'set_fact', path: 'symptoms', value: ['headache'], evidence_segment_ids: ['s1'] }],
};
const provider = createServer(async (request, response) => {
  providerCalls++;
  for await (const _chunk of request) { /* Consume synthetic SDK request; do not log its contents. */ }
  response.setHeader('Content-Type', 'application/json');
  if (behavior === 'rate_limit') { response.writeHead(429); response.end(JSON.stringify({ error: { message: 'Synthetic rate limit' } })); return; }
  const content = behavior === 'invalid' ? { operations: [{ op: 'set_fact', path: '__proto__.polluted', value: true, evidence_segment_ids: ['s1'] }] } : fixture;
  response.end(JSON.stringify({ id: 'synthetic-local-completion', object: 'chat.completion', created: 0,
    model: 'local-fixture', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
});
let app, log, originalAuditOptions;
let base;
async function call(method, route, body, cookie) {
  const response = await fetch(new URL(route, base), { method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { status: response.status, data: await response.json().catch(() => null), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function expect(label, method, route, body, cookie, status = 200) {
  const result = await call(method, route, body, cookie);
  assert.ok([status].flat().includes(result.status), `${label}: ${result.status} ${JSON.stringify(result.data)}`);
  pass(label);
  return result;
}
const s1 = { id: 's1', text: 'Patient reports headache. Diagnosis is headache.', is_final: true, sequence: 1 };
const s2 = { id: 's2', text: 'Prescribe Paracetamol 500 mg once daily for 3 days.', is_final: true, sequence: 2 };
async function restoreAuditValidator() {
  if (originalAuditOptions) {
    await db.command({ collMod: 'consultation_audit_events', validator: originalAuditOptions.validator ?? {},
      validationLevel: originalAuditOptions.validationLevel ?? 'strict', validationAction: originalAuditOptions.validationAction ?? 'error' });
    originalAuditOptions = undefined;
  }
}

try {
  await client.connect();
  assert.equal((await db.admin().command({ hello: 1 })).setName, 'rs0');
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const portProbe = createPortServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const logPath = `/tmp/mediflow-system-${randomUUID()}.log`;
  log = await open(logPath, 'w', 0o600);
  app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
      GROQ_API_KEY: 'synthetic-local-fixture', GROQ_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
      DEEPGRAM_API_KEY: '', MEDIFLOW_METRICS: '0' }, stdio: ['ignore', log.fd, log.fd],
  });
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline && app.exitCode === null) {
    try { ready = (await fetch(`${base}/login`, { signal: AbortSignal.timeout(1000) })).status === 200; } catch { /* waiting for server */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, `Local app did not start; inspect ${logPath}`);
  pass('production HTTP server starts');
  const docA = (await expect('doctor A login', 'POST', '/api/auth/login', { email: 'demo-doctor-a@mediflow.invalid', password })).cookie;
  const docB = (await expect('doctor B login', 'POST', '/api/auth/login', { email: 'demo-doctor-b@mediflow.invalid', password })).cookie;
  const reception = (await expect('receptionist login', 'POST', '/api/auth/receptionist/login', { doctor_email: 'demo-doctor-a@mediflow.invalid', password: receptionPassword })).cookie;
  assert.ok(docA && docB && reception);
  const intake = { name: 'SYNTHETIC System Verification', phone: '+1555' + randomInt(1000000, 9999999), gender: 'Other', allergies: ['Penicillin'] };
  await expect('unauthenticated intake denied', 'POST', '/api/patients/create', intake, undefined, 401);
  const patientId = (await expect('receptionist registers synthetic patient', 'POST', '/api/patients/create', intake, reception)).data.id;
  assert.equal((await expect('same-practice registration is idempotent', 'POST', '/api/patients/create', intake, reception)).data.id, patientId);
  await expect('cross-practice phone collision denied', 'POST', '/api/patients/create', intake, docB, 409);
  const createVisit = async () => (await call('POST', '/api/consultations/create', { patient_id: patientId, type: 'General', chief_complaint: 'headache' }, reception));
  const created = await createVisit(); assert.equal(created.status, 200, JSON.stringify(created.data));
  const cid = created.data.consultation_id, oid = new ObjectId(cid);
  pass('consultation and initial EMR/audit created transactionally');
  await expect('owned consultation context', 'GET', `/api/consultations/context/${cid}`, undefined, docA);
  await expect('other practice cannot read context', 'GET', `/api/consultations/context/${cid}`, undefined, docB, [403, 404]);
  await expect('other practice cannot edit EMR', 'PUT', `/api/emr/by-consultation/${cid}`, { snapshot: {}, expected_version: 0 }, docB, 404);
  await expect('receptionist cannot sign off', 'POST', `/api/emr/review/${cid}`, {}, reception, 403);
  await expect('unfinished consultation cannot complete', 'PATCH', `/api/consultations/${cid}`, { status: 'completed', reviewed_version: 0 }, docA, 409);

  const before = await db.collection('emr_entries').findOne({ consultation_id: oid });
  const writers = await Promise.all([77, 78].map(pulse => call('PUT', `/api/emr/by-consultation/${cid}`,
    { snapshot: { chief_complaint: 'headache', vitals: { pulse_rate: pulse } }, expected_version: before.version }, docA)));
  assert.deepEqual(writers.map(r => r.status).sort(), [200, 409]);
  pass('competing real EMR writers produce one save and one 409');
  const saved = await db.collection('emr_entries').findOne({ consultation_id: oid });
  assert.equal(saved.version, before.version + 1);

  // Fail only this synthetic encounter's audit inserts; restore the original validator even on failure.
  originalAuditOptions = (await db.listCollections({ name: 'consultation_audit_events' }).next()).options;
  await db.command({ collMod: 'consultation_audit_events', validator: { consultation_id: { $ne: oid } }, validationAction: 'error', validationLevel: 'strict' });
  try {
    await expect('audit insertion failure rejects EMR update', 'PUT', `/api/emr/by-consultation/${cid}`,
      { snapshot: { ...saved.snapshot, chief_complaint: 'must roll back' }, expected_version: saved.version }, docA, 503);
    const rolledBack = await db.collection('emr_entries').findOne({ consultation_id: oid });
    assert.equal(rolledBack.version, saved.version); assert.deepEqual(rolledBack.snapshot, saved.snapshot);
    pass('real transaction rolls back clinical data on audit failure');
  } finally { await restoreAuditValidator(); }

  await expect('consultation metadata update', 'PATCH', `/api/consultations/${cid}`, { follow_up_in_days: 3 }, docA);
  await expect('patient history update', 'PUT', `/api/patients/${patientId}/history`, { consultation_id: cid, core: { allergies: ['Penicillin'], family_history: 'Synthetic family history' } }, docA);
  await expect('patient history read', 'GET', `/api/patients/${patientId}/history`, undefined, docA);
  await expect('cross-practice history denied', 'GET', `/api/patients/${patientId}/history`, undefined, docB, 403);
  const graph = (await expect('family graph read', 'GET', `/api/patients/${patientId}/family-graph`, undefined, docA)).data.graph;
  const action = { consultation_id: cid, expected_version: graph.version, change: { action: 'add_relative', relative_to: 'patient', relation: 'mother', lineage: 'unknown', label: 'Synthetic mother' } };
  await expect('family graph edit', 'PATCH', `/api/patients/${patientId}/family-graph`, action, docA);
  await expect('stale graph version denied', 'PATCH', `/api/patients/${patientId}/family-graph`, action, docA, 409);
  await expect('cross-practice graph denied', 'GET', `/api/patients/${patientId}/family-graph`, undefined, docB, 404);
  const meds = await expect('medication catalog search', 'GET', '/api/medications/search?q=Paracetamol', undefined, docA);
  assert.ok(meds.data.medications.length > 0);
  await expect('ICD dictionary search', 'GET', '/api/icd/search?q=J00', undefined, docA);
  await expect('doctor profile read', 'GET', '/api/doctor/settings', undefined, docA);
  await expect('doctor profile update', 'PATCH', '/api/doctor/settings', { doctor_name: 'SYNTHETIC Doctor A' }, docA);
  await expect('receptionist cannot change doctor profile', 'PATCH', '/api/doctor/settings', { name: 'Forbidden' }, reception, 403);

  await expect('finalized segment persists', 'POST', '/api/transcripts/upsert', { consultation_id: cid, segments: [s1], processing_status: 'in_progress' }, docA);
  await expect('transcript retry is idempotent', 'POST', '/api/transcripts/upsert', { consultation_id: cid, segments: [s1], processing_status: 'in_progress' }, docA);
  await expect('conflicting segment identity denied', 'POST', '/api/transcripts/upsert', { consultation_id: cid, segments: [{ ...s1, text: 'different text' }], processing_status: 'in_progress' }, docA, 409);
  await expect('transcript read', 'GET', `/api/transcripts/upsert?consultation_id=${cid}`, undefined, docA);
  await expect('delta extraction through local provider fixture', 'POST', '/api/emr/extract-delta', { consultation_id: cid, segments_delta: [s1] }, docA);
  const callsAfterDelta = providerCalls;
  const replay = await expect('committed delta replay', 'POST', '/api/emr/extract-delta', { consultation_id: cid, segments_delta: [s1] }, docA);
  assert.equal(replay.data.replayed, true); assert.equal(providerCalls, callsAfterDelta);
  await expect('completed transcript persists', 'POST', '/api/transcripts/upsert', { consultation_id: cid, segments: [s1, s2], processing_status: 'completed' }, docA);
  const final = await expect('final grounded extraction through provider fixture', 'POST', '/api/emr/extract', { consultation_id: cid }, docA);
  assert.equal(final.data.snapshot.medications?.[0]?.name, 'Paracetamol');
  const callsAfterFinal = providerCalls;
  assert.equal((await expect('final extraction cache', 'POST', '/api/emr/extract', { consultation_id: cid }, docA)).data.cached, true);
  assert.equal(providerCalls, callsAfterFinal);
  let review = (await expect('structured review loads evidence', 'GET', `/api/emr/review/${cid}`, undefined, docA)).data;
  assert.deepEqual(review.blockers, [], JSON.stringify(review.blockers));
  const approval = () => ({ expected_version: review.version, confirmed_review: true, confirmed_prescription: true,
    allergy_assessment: 'confirmed_known', acknowledged_warnings: review.warnings,
    acknowledged_grounding: review.grounding_findings.map(x => x.path) });
  await expect('stale approval version denied', 'POST', `/api/emr/review/${cid}`, { ...approval(), expected_version: review.version - 1 }, docA, 409);
  await expect('explicit prescription confirmation required', 'POST', `/api/emr/review/${cid}`, { ...approval(), confirmed_prescription: false }, docA, 422);
  await expect('doctor approves current evidence and prescription', 'POST', `/api/emr/review/${cid}`, approval(), docA);
  const emrBeforeEdit = await db.collection('emr_entries').findOne({ consultation_id: oid });
  await expect('manual EMR-by-ID update after approval', 'PUT', `/api/emr/${emrBeforeEdit._id}`, { snapshot: { plan: 'Synthetic clinician correction' }, expected_version: review.version }, docA);
  await expect('changed EMR invalidates completion approval', 'PATCH', `/api/consultations/${cid}`, { status: 'completed', reviewed_version: review.version }, docA, 409);
  review = (await call('GET', `/api/emr/review/${cid}`, undefined, docA)).data;
  await expect('doctor re-approves updated version', 'POST', `/api/emr/review/${cid}`, approval(), docA);
  const completionBody = { status: 'completed', reviewed_version: review.version };
  const completed = await Promise.all([call('PATCH', `/api/consultations/${cid}`, completionBody, docA), call('PATCH', `/api/consultations/${cid}`, completionBody, docA)]);
  assert.deepEqual(completed.map(x => x.status), [200, 200], JSON.stringify(completed.map(x => x.data)));
  assert.equal(await db.collection('prescriptions').countDocuments({ consultation_id: oid }), 1);
  assert.equal(await db.collection('consultation_audit_events').countDocuments({ consultation_id: oid, event_type: 'consultation_finalized' }), 1);
  const prescription = await db.collection('prescriptions').findOne({ consultation_id: oid });
  assert.equal(prescription.approved_emr_version, review.version);
  assert.deepEqual(prescription.medications, review.snapshot.medications);
  pass('concurrent completion issues exactly one approved prescription and audit event');
  assert.ok((await db.collection('patient_history').findOne({ patient_id: new ObjectId(patientId) })).core.active_meds.includes('Paracetamol'));
  pass('completion synchronizes longitudinal history');
  await expect('late EMR write rejected', 'PUT', `/api/emr/by-consultation/${cid}`, { snapshot: {}, expected_version: review.version }, docA, 409);
  await expect('late transcript write rejected', 'POST', '/api/transcripts/upsert', { consultation_id: cid, segments: [s1], processing_status: 'completed' }, docA, 409);
  await expect('patient consultations list', 'GET', `/api/patients/${patientId}/consultations`, undefined, docA);
  await expect('consultation audit read', 'GET', `/api/consultations/${cid}/audit`, undefined, docA);
  const audits = await db.collection('consultation_audit_events').find({ consultation_id: oid }).sort({ sequence_no: 1 }).toArray();
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
  let lastHash = '';
  for (let i = 0; i < audits.length; i++) {
    const event = audits[i]; assert.equal(event.sequence_no, i + 1); assert.equal(event.prev_hash, lastHash);
    const payload = { consultation_id: String(event.consultation_id), patient_id: event.patient_id?.toString() ?? null,
      actor_id: event.actor_id?.toString() ?? null, actor_role: event.actor_role, source: event.source, event_type: event.event_type,
      sequence_no: event.sequence_no, prev_hash: event.prev_hash, before: event.before, after: event.after,
      changed_paths: event.changed_paths, metadata: event.metadata, created_at: event.created_at };
    assert.equal(event.event_hash, createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex'));
    lastHash = event.event_hash;
  }
  pass('persisted audit sequence and SHA-256 hash chain verify');
  const printPage = async (id, cookie) => (await fetch(`${base}/doctor/consultations/${id}/prescription`,
    { headers: { Cookie: cookie } })).text();
  const printed = await printPage(cid, docA);
  assert.ok(printed.includes('Print Prescription') && printed.includes('Paracetamol'));
  assert.ok(!printed.includes('1-0-0'), 'Printing must not invent morning dosing');
  pass('approved prescription prints exact instructions without inferred timing');
  assert.ok(!(await printPage(cid, docB)).includes('Print Prescription'));
  pass('another practice cannot print the prescription');
  // Change only a disposable record to prove printing reads the issued prescription, then restore it.
  const completedEmr = await db.collection('emr_entries').findOne({ consultation_id: oid });
  try {
    await db.collection('emr_entries').updateOne({ _id: completedEmr._id },
      { $set: { 'snapshot.medications': [{ name: 'SYNTHETIC UNAPPROVED DRUG' }] } });
    const immutablePrint = await printPage(cid, docA);
    assert.ok(immutablePrint.includes('Paracetamol') && !immutablePrint.includes('SYNTHETIC UNAPPROVED DRUG'));
    pass('printed medication data comes from the issued approved prescription');
  } finally {
    await db.collection('emr_entries').updateOne({ _id: completedEmr._id }, { $set: { snapshot: completedEmr.snapshot } });
  }

  const failedVisit = await createVisit(); assert.equal(failedVisit.status, 200);
  const fid = failedVisit.data.consultation_id, foid = new ObjectId(fid);
  await call('POST', '/api/transcripts/upsert', { consultation_id: fid, segments: [s1], processing_status: 'in_progress' }, docA);
  behavior = 'rate_limit';
  await expect('provider 429 leaves a failed retryable batch', 'POST', '/api/emr/extract-delta', { consultation_id: fid, segments_delta: [s1] }, docA, 503);
  const batch = await db.collection('emr_extraction_batches').findOne({ consultation_id: foid });
  assert.equal(batch.status, 'failed'); assert.equal(batch.attempt_count, 1);
  const callsAtFailure = providerCalls;
  await expect('retry backoff prevents extra provider call', 'POST', '/api/emr/extract-delta', { consultation_id: fid, segments_delta: [s1] }, docA, 409);
  assert.equal(providerCalls, callsAtFailure);
  // Synthetic fault injection models a crashed worker with an expired lease.
  await db.collection('emr_extraction_batches').updateOne({ _id: batch._id }, { $set: { status: 'processing', lease_expires_at: new Date(0) }, $unset: { expires_at: '', retry_after: '' } });
  behavior = 'success';
  await expect('expired extraction lease is reclaimed', 'POST', '/api/emr/extract-delta', { consultation_id: fid, segments_delta: [s1] }, docA);
  const recovered = await db.collection('emr_extraction_batches').findOne({ _id: batch._id });
  assert.equal(recovered.status, 'done'); assert.equal(recovered.attempt_count, 2); assert.notEqual(recovered.lease_token, batch.lease_token);
  pass('lease recovery retains attempt count and replaces worker token');

  const invalidVisit = await createVisit(); assert.equal(invalidVisit.status, 200);
  const invalidId = invalidVisit.data.consultation_id;
  await call('POST', '/api/transcripts/upsert', { consultation_id: invalidId, segments: [s1], processing_status: 'in_progress' }, docA);
  behavior = 'invalid';
  await expect('invalid AI mutation rejected', 'POST', '/api/emr/extract-delta', { consultation_id: invalidId, segments_delta: [s1] }, docA, 422);
  assert.equal((await db.collection('emr_entries').findOne({ consultation_id: new ObjectId(invalidId) })).version, 0);
  pass('invalid provider output does not mutate EMR');
  await expect('missing live STT configuration is explicit', 'POST', '/api/stt/token', { consultation_id: invalidId }, docA, 503);
  const audio = await fetch(`${base}/api/stt/transcribe?consultation_id=${invalidId}`, { method: 'POST', headers: { Cookie: docA }, body: 'invalid' });
  assert.equal(audio.status, 415); pass('audio endpoint rejects wrong media type');
  await expect('receptionist password change', 'PATCH', '/api/doctor/receptionist-password', { receptionist_password: receptionPassword }, docA);
  await expect('old receptionist session revoked', 'POST', '/api/patients/create', intake, reception, 401);
  // Leave an unapproved, fully extracted fixture for the real browser sign-off flow.
  const readyVisit = await expect('create browser review encounter', 'POST', '/api/consultations/create',
    { patient_id: patientId, type: 'General', chief_complaint: 'headache' }, docA);
  const readyId = readyVisit.data.consultation_id;
  behavior = 'success';
  await expect('persist browser review transcript', 'POST', '/api/transcripts/upsert',
    { consultation_id: readyId, segments: [s1, s2], processing_status: 'completed' }, docA);
  await expect('drain browser review extraction cursor', 'POST', '/api/emr/extract-delta',
    { consultation_id: readyId, segments_delta: [s1, s2] }, docA);
  await expect('prepare browser review final extraction', 'POST', '/api/emr/extract', { consultation_id: readyId }, docA);
  assert.ok(!(await printPage(readyId, docA)).includes('Print Prescription'));
  pass('unapproved active encounter cannot print a prescription');
  await expect('logout clears session cookie', 'POST', '/api/auth/logout', undefined, docA);
  report.status = 'passed';
  report.provider_fixture_calls = providerCalls;
  report.synthetic_records = { patient_id: patientId, completed_consultation_id: cid, active_consultation_id: fid, review_consultation_id: readyId };
} catch (error) {
  report.status = 'failed'; report.failure = error.message; process.exitCode = 1;
  console.error(error);
} finally {
  await restoreAuditValidator().catch(error => { console.error('Restore local audit validator failed:', error.message); process.exitCode = 1; });
  if (app && app.exitCode === null) {
    const exited = once(app, 'exit'); app.kill('SIGTERM');
    const timeout = setTimeout(() => app.kill('SIGKILL'), 5000);
    await exited; clearTimeout(timeout);
  }
  await log?.close();
  if (provider.listening) await new Promise(resolve => provider.close(resolve));
  await client.close();
  await mkdir('eval/results', { recursive: true });
  await writeFile('eval/results/system-verification.json', JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.status.toUpperCase()}: ${report.checks.length} integration checks; Groq simulated, MongoDB/HTTP real.`);
}
