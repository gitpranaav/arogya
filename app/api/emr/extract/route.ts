import Groq from "groq-sdk";
import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { accessConsultation, enforceUsageLimit, parseBoundedJson } from "@/src/lib/security/access";
import { EXTRACT_FULL_SYSTEM_PROMPT } from "@/src/lib/emr/extractDeltaPrompt";
import { ensureMedicationIds, reconcileMedicationIds } from "@/src/lib/emr/medicationIdentity";
import { GROUNDING_SCHEMA_VERSION, groundFinalSnapshot } from "@/src/lib/emr/grounding";
import { normalizeMedicationsArray } from "@/src/lib/emr/normalizeMedications";
import { sanitizeSnapshot } from "@/src/lib/emr/validation";
import { screenPrescription } from "@/src/lib/clinical/prescriptionSafetyServer";
import { clinicalTransaction, isClinicalConflict } from "@/src/lib/mongodb/clinicalTransaction";
import { logConsultationAudit } from "@/src/lib/audit/consultationLedger";
import type { EMRSnapshot } from "@/src/lib/emr/types";
import { buildClinicalContext, ContextBudgetError, CONTEXT_VERSION } from "@/src/lib/extraction/context";
import { retrieveAuthorizedHistory } from "@/src/lib/extraction/history";
import { recordExtractionMetric } from "@/src/lib/extraction/metrics";
import { prepareFamilyProposals, mergeFamilyProposals } from "@/src/lib/familyHistory/proposals";
import { graphFromRecord } from "@/src/lib/familyHistory/graph";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await parseBoundedJson(request, 256 * 1024) as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid extraction request" }, { status: 400 }); }
  const auth = await accessConsultation(body?.consultation_id, { doctorOnly: true, active: true });
  if ("error" in auth) return auth.error;
  const { db, session, consultationId, consultation } = auth;
  const transcript = await db.collection("transcripts").findOne({ consultation_id: consultationId });
  if (!transcript || transcript.processing_status !== "completed") return NextResponse.json({ error: "Finish and persist transcription before final extraction" }, { status: 409 });
  const transcriptText = String(transcript.raw_text ?? "").trim();
  const segments = Array.isArray(transcript.segments) ? transcript.segments.filter((s: { is_final?: boolean; id?: string; text?: string }) => s?.is_final !== false && typeof s.id === "string" && typeof s.text === "string") : [];
  if (!segments.length) return NextResponse.json({ error: "Persisted finalized segments required for grounded extraction" }, { status: 422 });
  if (!transcriptText || transcriptText.length > 150_000) return NextResponse.json({ error: "Transcript missing or too large" }, { status: 400 });
  const existing = await db.collection("emr_entries").findOne({ consultation_id: consultationId });
  const transcriptHash = createHash("sha256").update(transcriptText).digest("hex");
  const model = process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";
  const started = Date.now();
  // Calculate cache dependencies from authoritative records rather than the browser.
  const patient = await db.collection("patients").findOne({ _id: consultation.patient_id }, { projection: { allergies: 1 } });
  const history = await db.collection("patient_history").findOne({ patient_id: consultation.patient_id }, { projection: { "core.allergies": 1 } });
  const allergies = Array.from(new Set([...(Array.isArray(patient?.allergies) ? patient.allergies : []),
    ...(Array.isArray(history?.core?.allergies) ? history.core.allergies : [])])).filter(x => typeof x === "string");
  const historical = await retrieveAuthorizedHistory(db, consultation.patient_id, consultation.doctor_id, consultationId, transcriptText);
  const existingSnap = ensureMedicationIds((existing?.snapshot ?? {}) as EMRSnapshot, consultationId.toString());
  let context: ReturnType<typeof buildClinicalContext>;
  try { context = buildClinicalContext({ snapshot: existingSnap, allergies,
    allergyStatus: allergies.length ? "recorded" : "not_assessed", segments, history: historical, mode: "final" }); }
  catch (e) { if (e instanceof ContextBudgetError) return NextResponse.json({ error: e.message }, { status: 413 }); throw e; }
  // Do not hash the pre-extraction EMR snapshot: the model will update that snapshot.
  // Clinical EMR edits are invalidated separately by final_cached_version.
  const cacheHash = createHash("sha256").update(EXTRACT_FULL_SYSTEM_PROMPT).update(CONTEXT_VERSION)
    .update(JSON.stringify({ transcriptHash, allergies, historical, model })).digest("hex");
  if (existing?.final_transcript_hash === transcriptHash && existing?.grounding_version === GROUNDING_SCHEMA_VERSION &&
    existing?.final_context_hash === cacheHash && existing?.final_cached_version === Number(existing?.version ?? 0)) {
    recordExtractionMetric("final", "cache", { totalMs: Date.now() - started });
    return NextResponse.json({ snapshot: existing.snapshot, version: existing.version ?? 0, cached: true });
  }
  if (!await enforceUsageLimit(db, `groq-final:${session.uid}`, 30, 60 * 60 * 1000)) return NextResponse.json({ error: "Final extraction quota reached" }, { status: 429 });
  const key = process.env.GROQ_API_KEY;
  if (!key) return NextResponse.json({ error: "AI extraction unavailable" }, { status: 503 });
  try {
    const groq = new Groq({ apiKey: key, timeout: 40_000, maxRetries: 0 });
    const providerStarted = Date.now();
    const completion = await groq.chat.completions.create({ model, temperature: 0.05,
      response_format: { type: "json_object" }, messages: [
        { role: "system", content: EXTRACT_FULL_SYSTEM_PROMPT },
        { role: "user", content: context.json },
      ] });
    const data = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) return NextResponse.json({ error: "Invalid AI output" }, { status: 422 });
    const familyProposals = prepareFamilyProposals(data.family_history_proposals, segments);
    const strings = (v: unknown) => Array.isArray(v) ? v.filter(x => typeof x === "string" && x.length <= 500).slice(0, 40) : [];
    const diagnoses = strings(data.diagnosis ?? data.diagnosis_text);
    const candidate: EMRSnapshot = sanitizeSnapshot({
      vitals: data.vitals && typeof data.vitals === "object" && !Array.isArray(data.vitals) ? data.vitals : {},
      chief_complaint: typeof data.chief_complaint === "string" ? data.chief_complaint : null,
      history_of_present_illness: typeof data.history_of_present_illness === "string" ? data.history_of_present_illness : null,
      symptoms: strings(data.symptoms),
      physical_examination: typeof data.physical_examination === "string" ? data.physical_examination : null,
      assessment: typeof data.assessment === "string" ? data.assessment : null,
      plan: typeof data.plan === "string" ? data.plan : null,
      diagnosis_text: diagnoses,
      medications: normalizeMedicationsArray(data.medications).slice(0, 40),
      lab_tests_ordered: strings(data.lab_tests_ordered),
      clinical_summary: typeof data.clinical_summary === "string" ? data.clinical_summary : null,
      patient_summary: typeof data.patient_summary === "string" ? data.patient_summary : null,
    });
    candidate.medications = reconcileMedicationIds(existingSnap.medications ?? [], candidate.medications ?? []);
    const grounding = groundFinalSnapshot(candidate, existingSnap, data.field_evidence, segments, existing?.provenance);
    // Legacy manual overrides are retained during migration of old EMR records.
    const manual = Array.isArray(existing?.manual_override_keys) ? existing.manual_override_keys as string[] : [];
    for (const field of manual) if (!(field === "medications" && Object.keys(existing?.provenance ?? {}).some(key => key.startsWith("medications[id="))) && Object.prototype.hasOwnProperty.call(existingSnap, field)) (grounding.snapshot as unknown as Record<string, unknown>)[field] = (existingSnap as unknown as Record<string, unknown>)[field];
    const finalSnapshot = sanitizeSnapshot(grounding.snapshot);
    const existingFindings = Array.isArray(existing?.grounding_findings) ? existing.grounding_findings : [];
    const acceptedPaths = new Set(Object.entries(grounding.provenance).filter(([path, record]) =>
      record?.origin === "ai" && (!existing?.provenance?.[path] || record.updated_at !== existing.provenance[path]?.updated_at)).map(([path]) => path));
    const findings = [...existingFindings.filter((f: { path: string }) => !acceptedPaths.has(f.path)), ...grounding.findings].slice(-80);
    const safety = await screenPrescription(db, consultation.patient_id, finalSnapshot);
    const filter = existing ? { _id: existing._id, version: existing.version ?? { $exists: false } } : { consultation_id: consultationId, version: { $exists: false } };
    try {
      if (familyProposals.length) await db.collection("patient_family_graphs").createIndex({ patient_id: 1 }, { unique: true });
      await clinicalTransaction(db, async mongoSession => {
        const write = await db.collection("emr_entries").updateOne(filter,
          { $set: { snapshot: finalSnapshot, provenance: grounding.provenance, grounding_version: GROUNDING_SCHEMA_VERSION, grounding_findings: findings, safety_screen: { issues: safety.issues, rule_version: safety.rule_version }, final_transcript_hash: transcriptHash, final_context_hash: cacheHash, final_cached_version: Number(existing?.version ?? 0) + 1, final_extraction_at: new Date().toISOString(),
            requires_review: true, review: null, updated_at: new Date().toISOString() }, $inc: { version: 1 },
            $setOnInsert: { consultation_id: consultationId, created_at: new Date().toISOString() } },
          { upsert: !existing, session: mongoSession });
        if (!write.matchedCount && !write.upsertedCount) throw new Error("version_conflict");
        if (familyProposals.length) {
          const familyCollection = db.collection("patient_family_graphs");
          const storedFamily = await familyCollection.findOne({ patient_id: consultation.patient_id }, { session: mongoSession });
          const beforeFamily = graphFromRecord(storedFamily);
          const afterFamily = mergeFamilyProposals(storedFamily, familyProposals, consultationId.toString());
          if (afterFamily.version !== beforeFamily.version) {
            const familyWrite = await familyCollection.updateOne(
              storedFamily ? { _id: storedFamily._id, version: beforeFamily.version } : { patient_id: consultation.patient_id, version: { $exists: false } },
              { $set: { schema_version: afterFamily.schema_version, version: afterFamily.version,
                relatives: afterFamily.relatives, assertions: afterFamily.assertions, updated_at: afterFamily.updated_at },
                $setOnInsert: { patient_id: consultation.patient_id, created_at: new Date().toISOString() } },
              { upsert: !storedFamily, session: mongoSession });
            if (!familyWrite.matchedCount && !familyWrite.upsertedCount) throw new Error("version_conflict");
            await logConsultationAudit(db, { consultationId, patientId: consultation.patient_id, actorId: session.uid, actorRole: session.role,
              source: "ai_final", eventType: "family_history_proposal", before: beforeFamily, after: afterFamily,
              metadata: { segment_ids: familyProposals.flatMap(p => p.evidence_segment_ids), schema_version: afterFamily.schema_version }, mongoSession });
          }
        }
        await logConsultationAudit(db, { consultationId, patientId: consultation.patient_id, actorId: session.uid, actorRole: session.role,
          source: "ai_final", eventType: "ai_final_edit", before: existingSnap, after: finalSnapshot,
          metadata: { transcript_sha256: transcriptHash, version: Number(existing?.version ?? 0) + 1 }, allowNoop: true, mongoSession });
      }, { activeConsultationId: consultationId });
    } catch (err) {
      if (isClinicalConflict(err)) return NextResponse.json({ error: "EMR changed while extracting. Retry", retryable: true }, { status: 409 });
      throw err;
    }
    recordExtractionMetric("final", "success", { inputChars: context.chars,
      inputTokens: completion.usage?.prompt_tokens, outputTokens: completion.usage?.completion_tokens,
      historicalItems: historical.length, providerMs: Date.now() - providerStarted, totalMs: Date.now() - started });
    return NextResponse.json({ snapshot: finalSnapshot, grounding_findings: findings, version: Number(existing?.version ?? 0) + 1 });
  } catch {
    recordExtractionMetric("final", "failure", { totalMs: Date.now() - started });
    return NextResponse.json({ error: "Final extraction or validation failed" }, { status: 502 });
  }
}
