import { createHash, randomUUID } from "crypto";
import Groq from "groq-sdk";
import type { Document } from "mongodb";
import { NextResponse } from "next/server";
import { accessConsultation, enforceUsageLimit, parseBoundedJson } from "@/src/lib/security/access";
import { validateEMROperations } from "@/src/lib/emr/validation";
import { screenPrescription } from "@/src/lib/clinical/prescriptionSafetyServer";
import { EXTRACT_DELTA_SYSTEM_PROMPT } from "@/src/lib/emr/extractDeltaPrompt";
import { ensureMedicationIds } from "@/src/lib/emr/medicationIdentity";
import { GROUNDING_SCHEMA_VERSION, groundDeltaOps, applyProvenanceChanges, changedClinicalFields, readProvenance } from "@/src/lib/emr/grounding";
import { buildClinicalSummary, buildPatientSummary } from "@/src/lib/emr/summaries";
import { applyEMROps } from "@/src/lib/emr/merge";
import { clinicalTransaction, isClinicalConflict } from "@/src/lib/mongodb/clinicalTransaction";
import { logConsultationAudit } from "@/src/lib/audit/consultationLedger";
import type { EMRSnapshot, TranscriptSegment } from "@/src/lib/emr/types";
import { buildClinicalContext, ContextBudgetError } from "@/src/lib/extraction/context";
import { retrieveAuthorizedHistory } from "@/src/lib/extraction/history";
import { recordExtractionMetric } from "@/src/lib/extraction/metrics";
import { prepareFamilyProposals, mergeFamilyProposals } from "@/src/lib/familyHistory/proposals";
import { graphFromRecord } from "@/src/lib/familyHistory/graph";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await parseBoundedJson(request, 96 * 1024) as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid extraction payload" }, { status: 400 }); }
  const auth = await accessConsultation(body?.consultation_id, { active: true });
  if ("error" in auth) return auth.error;
  const { db, session, consultationId, consultation } = auth;
  if (!Array.isArray(body.segments_delta) || body.segments_delta.length > 30 || body.segments_delta.some(s =>
    !s || typeof s.id !== "string" || !/^[\w-]{1,80}$/.test(s.id) || typeof s.text !== "string" || !s.text.trim() || s.text.length > 3500 || s.is_final === false))
    return NextResponse.json({ error: "Invalid finalized segments" }, { status: 400 });
  const segments = body.segments_delta as TranscriptSegment[];
  const current = await db.collection("emr_entries").findOne({ consultation_id: consultationId });
  if (!segments.length) return NextResponse.json({ operations: [], snapshot: current?.snapshot ?? {}, new_cursor: current?.extraction_cursor ?? null, version: current?.version ?? 0 });
  // Resolve a previously committed batch before inspecting the new cursor: retries
  // otherwise appear "out of order" after their original call succeeds.
  const batchHash = createHash("sha256").update(segments.map(s => `${s.id}:${s.text}`).join("\n")).digest("hex");
  const batchId = `${consultationId.toString()}:delta:${batchHash}`;
  // Batch IDs are deterministic content keys, not MongoDB-generated ObjectIds.
  const jobs = db.collection<Document & { _id: string }>("emr_extraction_batches");
  const requestStarted = Date.now();
  const previous = await jobs.findOne({ _id: batchId });
  if (previous?.status === "done") {
    // A retry must not send an old snapshot back to a tab after a clinician edit.
    const latest = await db.collection("emr_entries").findOne({ consultation_id: consultationId });
    recordExtractionMetric("delta", "cache", { totalMs: Date.now() - requestStarted });
    return NextResponse.json({ ...previous.result, snapshot: latest?.snapshot ?? previous.result.snapshot,
      new_cursor: latest?.extraction_cursor ?? previous.result.new_cursor,
      version: latest?.version ?? previous.result.version, replayed: true });
  }
  const transcript = await db.collection("transcripts").findOne({ consultation_id: consultationId }, { projection: { segments: 1 } });
  const recorded = Array.isArray(transcript?.segments) ? transcript.segments as TranscriptSegment[] : [];
  const lastProcessed = current?.extraction_cursor?.last_final_segment_id;
  const lastPos = lastProcessed ? recorded.findIndex(s => s.id === lastProcessed) : -1;
  if (lastProcessed && lastPos < 0) return NextResponse.json({ error: "Extraction cursor no longer matches transcript", retryable: false }, { status: 409 });
  const expected = recorded.slice(lastPos + 1, lastPos + segments.length + 1);
  if (expected.length !== segments.length || expected.some((s, i) => s.id !== segments[i].id || s.text !== segments[i].text))
    return NextResponse.json({ error: "Transcript segments not yet persisted or out of order", retryable: true }, { status: 409 });
  if (!await enforceUsageLimit(db, `groq-delta:${session.uid}`, 240, 60 * 60 * 1000)) return NextResponse.json({ error: "Extraction quota reached" }, { status: 429 });
  const leaseToken = randomUUID();
  try { await jobs.insertOne({ _id: batchId, consultation_id: consultationId, status: "processing", lease_token: leaseToken,
    attempt_count: 1, created_at: new Date(), lease_expires_at: new Date(Date.now() + 120_000) }); }
  catch (e: any) {
    if (e?.code !== 11000) throw e;
    const prior = await jobs.findOne({ _id: batchId });
    if (prior?.status === "done") {
      const latest = await db.collection("emr_entries").findOne({ consultation_id: consultationId });
      return NextResponse.json({ ...prior.result, snapshot: latest?.snapshot ?? prior.result.snapshot,
        new_cursor: latest?.extraction_cursor ?? prior.result.new_cursor,
        version: latest?.version ?? prior.result.version, replayed: true });
    }
    // The TTL index applies only to completed results, not live leases. Old
    // processing records use expires_at for compatibility until reclaimed.
    const attempts = Number(prior?.attempt_count ?? 1);
    if (attempts >= 3 && prior?.status !== "done")
      return NextResponse.json({ error: "Extraction retry limit reached; clinician intervention required", retryable: false }, { status: 429 });
    const now = new Date();
    const leaseExpiry = prior?.lease_expires_at instanceof Date ? prior.lease_expires_at : prior?.expires_at;
    const expired = prior?.status === "processing" && leaseExpiry instanceof Date && leaseExpiry.getTime() < now.getTime();
    const eligibleFailure = prior?.status === "failed" && (!(prior.retry_after instanceof Date) || prior.retry_after <= now) && prior.retryable !== false;
    if (expired || eligibleFailure) {
      const filter = eligibleFailure
        ? { _id: batchId, status: "failed", lease_token: prior.lease_token }
        : { _id: batchId, status: "processing", lease_token: prior.lease_token,
            ...(prior.lease_expires_at instanceof Date ? { lease_expires_at: { $lt: now } } : { expires_at: { $lt: now } }) };
      const recovered = await jobs.updateOne(filter,
        { $set: { status: "processing", lease_token: leaseToken, created_at: now,
          lease_expires_at: new Date(now.getTime() + 120_000) },
          $unset: { expires_at: "", retry_after: "", retryable: "" }, $inc: { attempt_count: 1 } });
      if (!recovered.matchedCount) return NextResponse.json({ error: "Extraction already processing", retryable: true }, { status: 409 });
    } else if (prior?.status === "failed" && prior.retryable === false) {
      return NextResponse.json({ error: "AI response rejected; a corrected transcript is required", retryable: false }, { status: 422 });
    } else return NextResponse.json({ error: "Extraction batch already processing or awaiting retry", retryable: true }, { status: 409 });
  }
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("Missing AI configuration");
    const patient = await db.collection("patients").findOne({ _id: consultation.patient_id }, { projection: { allergies: 1 } });
    const history = await db.collection("patient_history").findOne({ patient_id: consultation.patient_id }, { projection: { "core.allergies": 1 } });
    const allergies = Array.from(new Set([...(Array.isArray(patient?.allergies) ? patient.allergies : []), ...(Array.isArray(history?.core?.allergies) ? history.core.allergies : [])]));
    const currentSnapshot = ensureMedicationIds((current?.snapshot ?? {}) as EMRSnapshot, consultationId.toString());
    // Only already-persisted transcript evidence is sent; client snapshot/history are ignored.
    const priorTail = recorded.slice(Math.max(0, lastPos - 2), lastPos + 1);
    const evidence = await retrieveAuthorizedHistory(db, consultation.patient_id, consultation.doctor_id,
      consultationId, segments.map(s => s.text).join(" "));
    const context = buildClinicalContext({ snapshot: currentSnapshot, segments, priorTail,
      history: evidence, allergies, allergyStatus: allergies.length ? "recorded" : "not_assessed", mode: "delta" });
    const groq = new Groq({ apiKey, timeout: 25_000, maxRetries: 0 });
    const providerStarted = Date.now();
    const completion = await groq.chat.completions.create({ model: process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b", temperature: 0.05, response_format: { type: "json_object" },
      messages: [{ role: "system", content: EXTRACT_DELTA_SYSTEM_PROMPT }, { role: "user", content: context.json }] });
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
    const proposed = validateEMROperations(parsed.operations, new Set(segments.map(s => s.id)));
    const familyProposals = prepareFamilyProposals(parsed.family_history_proposals, segments);
    // A previously confirmed manual edit takes precedence over AI suggestions.
    // A clinician must explicitly change it again; incremental extraction cannot undo it.
    const protectedFields = new Set(Array.isArray(current?.manual_override_keys) ? current.manual_override_keys : []);
    const priorProvenance = readProvenance(current?.provenance);
    const proposedAllowed = proposed.filter(op => {
      const isMed = op.path.startsWith("medications");
      if (protectedFields.has(op.path.split(/[.\[]/, 1)[0]) && (!isMed ||
        !Object.keys(priorProvenance).some(key => key.startsWith("medications[id=")))) return false;
      if (!isMed) return !Object.entries(priorProvenance).some(([key, val]) => key === op.path && (["clinician_entry", "clinician_correction", "staff_entry", "staff_correction"].includes(val.origin)));
      const marker = /^medications\[id=(med_[0-9a-f]{32})\]/.exec(op.path);
      if (op.path === "medications" && protectedFields.has("medications")) return false;
      if (!marker) return true; // legacy indexes still resolved against the versioned snapshot
      return !Object.entries(priorProvenance).some(([key, val]) => key.startsWith(`medications[id=${marker[1]}]`) &&
        (["clinician_entry", "clinician_correction", "staff_entry", "staff_correction"].includes(val.origin)) && (op.path === key || !op.path.includes("].")));
    });
    const grounded = groundDeltaOps(proposedAllowed, segments, currentSnapshot);
    const operations = grounded.operations;
    const merged: EMRSnapshot = ensureMedicationIds(applyEMROps(currentSnapshot, operations), consultationId.toString());
    // Preserve the existing summary UX, but never present automatically composed prose as grounded clinical evidence.
    const generatedSummaries: string[] = [];
    if (!merged.clinical_summary) {
      const summary = buildClinicalSummary(merged);
      if (summary) { merged.clinical_summary = summary; generatedSummaries.push("clinical_summary"); }
    }
    if (!merged.patient_summary) {
      const summary = buildPatientSummary(merged);
      if (summary) { merged.patient_summary = summary; generatedSummaries.push("patient_summary"); }
    }
    const changed = changedClinicalFields(currentSnapshot, merged);
    const candidateChanges = grounded.changes.flatMap(c => {
      if (c.path === "medications[+]" || c.path === "medications") return changed.filter(p => p.startsWith("medications[")).map(path => ({ ...c, path }));
      if (/^(?:symptoms|diagnosis_text|lab_tests_ordered)\[\d+\]$/.test(c.path)) return changed.includes(c.path.split("[")[0]) ? [c] : [];
      const indexed = /^medications\[(\d+)\](.*)/.exec(c.path);
      const target = indexed && merged.medications?.[Number(indexed[1])]?.id;
      const targetPath = target ? `medications[id=${target}]${indexed![2]}` : c.path;
      return changed.filter(p => p === targetPath || p.startsWith(`${targetPath}.`) || (targetPath.endsWith("]") && p.startsWith(`${targetPath}.`))).map(path => ({ ...c, path }));
    });
    const generatedChanges = generatedSummaries.map(path => ({ path, origin: "ai" as const,
      evidence_segment_ids: [...new Set(grounded.changes.flatMap(c => c.evidence_segment_ids))], grounding: "unverified" as const }));
    const provenance = applyProvenanceChanges(current?.provenance, [...candidateChanges, ...generatedChanges]);
    const generatedFindings = generatedSummaries.map(path => ({ path, reason: "Derived summary requires clinician verification", evidence_segment_ids: [...new Set(grounded.changes.flatMap(c => c.evidence_segment_ids))] }));
    const groundingFindings = [...(Array.isArray(current?.grounding_findings) ? current.grounding_findings : []), ...grounded.findings, ...generatedFindings].slice(-80);
    merged.needs_confirmation = [...new Set([...(merged.needs_confirmation ?? []), ...grounded.findings.map(f => f.path.replace(/^medications\[\+\]\..*$/, "medications[+]")), ...generatedSummaries])].slice(0, 80);
    const safety = await screenPrescription(db, consultation.patient_id, merged);
    const last = segments[segments.length - 1];
    const cursor = { last_final_segment_id: last.id, last_final_index: Number(current?.extraction_cursor?.last_final_index ?? -1) + segments.length };
    const expectedVersion = Number(current?.version ?? 0);
    const filter = current ? { _id: current._id, version: current.version ?? { $exists: false } } : { consultation_id: consultationId, version: { $exists: false } };
    const result = { operations, snapshot: merged, new_cursor: cursor, version: expectedVersion + 1, grounding_findings: groundingFindings };
    if (familyProposals.length) await db.collection("patient_family_graphs").createIndex({ patient_id: 1 }, { unique: true });
    await clinicalTransaction(db, async mongoSession => {
      const update = await db.collection("emr_entries").updateOne(filter,
        { $set: { snapshot: merged, extraction_cursor: cursor, safety_screen: { issues: safety.issues, rule_version: safety.rule_version }, requires_review: true, review: null,
          provenance, grounding_version: GROUNDING_SCHEMA_VERSION, grounding_findings: groundingFindings,
          updated_at: new Date().toISOString() },
          $inc: { version: 1 }, $setOnInsert: { consultation_id: consultationId, created_at: new Date().toISOString() } },
        { upsert: !current, session: mongoSession });
      if (!update.matchedCount && !update.upsertedCount) throw new Error("version_conflict");
      const completedBatch = await jobs.updateOne({ _id: batchId, status: "processing", lease_token: leaseToken },
        { $set: { status: "done", result, finished_at: new Date(), expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) },
          $unset: { lease_expires_at: "" } },
        { session: mongoSession });
      if (!completedBatch.matchedCount) throw new Error("lease_lost");
      if (familyProposals.length) {
        const familyCollection = db.collection("patient_family_graphs");
        const storedFamily = await familyCollection.findOne({ patient_id: consultation.patient_id }, { session: mongoSession });
        const beforeFamily = graphFromRecord(storedFamily);
        const afterFamily = mergeFamilyProposals(storedFamily, familyProposals, consultationId.toString());
        if (afterFamily.version !== beforeFamily.version) {
          const familyWrite = await familyCollection.updateOne(
            storedFamily ? { _id: storedFamily._id, version: beforeFamily.version } : { patient_id: consultation.patient_id, version: { $exists: false } },
            { $set: { schema_version: afterFamily.schema_version, version: afterFamily.version, relatives: afterFamily.relatives,
              assertions: afterFamily.assertions, updated_at: afterFamily.updated_at },
              $setOnInsert: { patient_id: consultation.patient_id, created_at: new Date().toISOString() } },
            { upsert: !storedFamily, session: mongoSession });
          if (!familyWrite.matchedCount && !familyWrite.upsertedCount) throw new Error("version_conflict");
          await logConsultationAudit(db, { consultationId, patientId: consultation.patient_id,
            actorId: session.actor_id ?? session.uid, actorRole: session.role, source: "ai_delta", eventType: "family_history_proposal",
            before: beforeFamily, after: afterFamily,
            metadata: { segment_ids: familyProposals.flatMap(p => p.evidence_segment_ids), schema_version: afterFamily.schema_version }, mongoSession });
        }
      }
      await logConsultationAudit(db, { consultationId, patientId: consultation.patient_id,
        actorId: session.actor_id ?? session.uid, actorRole: session.role, source: "ai_delta", eventType: "ai_delta_edit",
        before: current?.snapshot ?? null, after: merged,
        metadata: { segment_ids: segments.map(s => s.id), batch_id: batchId }, allowNoop: true, mongoSession });
    }, { activeConsultationId: consultationId });
    recordExtractionMetric("delta", "success", { inputChars: context.chars,
      inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
      historicalItems: evidence.length, providerMs: Date.now() - providerStarted, totalMs: Date.now() - requestStarted });
    return NextResponse.json(result);
  } catch (error) {
    // Retain a bounded retry record; never reset a reclaimed/completed worker's job.
    // TTL retention is separate from lease expiry so MongoDB cannot delete an
    // active job while its provider call is still running.
    const retryable = !(error instanceof ContextBudgetError) &&
      !(error instanceof Error && error.message.startsWith("Invalid AI"));
    recordExtractionMetric("delta", "failure", { totalMs: Date.now() - requestStarted });
    await jobs.updateOne({ _id: batchId, status: "processing", lease_token: leaseToken },
      { $set: { status: "failed", retryable, retry_after: new Date(Date.now() + 30_000),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000) }, $unset: { lease_expires_at: "" } }).catch(() => {});
    if (error instanceof ContextBudgetError) return NextResponse.json({ error: error.message, retryable: false }, { status: 413 });
    if (isClinicalConflict(error))
      return NextResponse.json({ error: "Extraction state changed; reload latest EMR and retry", retryable: true }, { status: 409 });
    if (error instanceof Error && error.message.startsWith("Invalid AI")) return NextResponse.json({ error: "AI response failed validation", retryable: false }, { status: 422 });
    return NextResponse.json({ error: "Extraction failed", retryable: true }, { status: 503 });
  }
}
