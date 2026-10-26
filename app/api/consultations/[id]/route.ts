import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { accessConsultation, parseBoundedJson } from "@/src/lib/security/access";
import { screenPrescription } from "@/src/lib/clinical/prescriptionSafetyServer";
import { prepareAuditIndexes, logConsultationAudit } from "@/src/lib/audit/consultationLedger";
import { clinicalTransaction, isClinicalConflict } from "@/src/lib/mongodb/clinicalTransaction";
import type { EMRSnapshot } from "@/src/lib/emr/types";
import { loadClinicalReviewState } from "@/src/lib/clinical/reviewStateServer";
import { reviewedSnapshotFingerprint } from "@/src/lib/clinical/reviewPolicy";

type Params = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, { params }: Params) {
  const auth = await accessConsultation((await params).id);
  if ("error" in auth) return auth.error;
  let payload: Record<string, unknown>;
  try { payload = await parseBoundedJson(request, 4 * 1024) as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "Invalid consultation update" }, { status: 400 }); }
  if (!payload || !Object.keys(payload).length) return NextResponse.json({ error: "Empty update" }, { status: 400 });
  const allowed = auth.session.role === "doctor"
    ? new Set(["status", "ended_at", "reviewed_version", "follow_up_due_at", "follow_up_in_days", "intake_status", "intake_completed_at"])
    : new Set(["intake_status", "intake_completed_at"]);
  if (Object.keys(payload).some(k => !allowed.has(k))) return NextResponse.json({ error: "Field update forbidden" }, { status: 403 });
  const complete = payload.status === "completed";
  if ("status" in payload && !complete) return NextResponse.json({ error: "Invalid status transition" }, { status: 400 });
  if ("reviewed_version" in payload && !complete) return NextResponse.json({ error: "reviewed_version requires completion" }, { status: 400 });
  if ("ended_at" in payload && !complete) return NextResponse.json({ error: "ended_at requires completion" }, { status: 400 });
  if ("follow_up_due_at" in payload && !(payload.follow_up_due_at === null || (typeof payload.follow_up_due_at === "string" && !Number.isNaN(Date.parse(payload.follow_up_due_at))))) return NextResponse.json({ error: "Invalid follow-up date" }, { status: 400 });
  if ("follow_up_in_days" in payload && (typeof payload.follow_up_in_days !== "number" || !Number.isInteger(payload.follow_up_in_days) || payload.follow_up_in_days < 0 || payload.follow_up_in_days > 3650)) return NextResponse.json({ error: "Invalid follow-up interval" }, { status: 400 });
  if ("intake_status" in payload && payload.intake_status !== "done") return NextResponse.json({ error: "Invalid intake transition" }, { status: 400 });
  if ("intake_completed_at" in payload && (!payload.intake_completed_at || Number.isNaN(Date.parse(String(payload.intake_completed_at))))) return NextResponse.json({ error: "Invalid intake timestamp" }, { status: 400 });
  const { db, consultationId, consultation, session } = auth;
  const now = new Date().toISOString();
  if (!complete) {
    if (consultation.status !== "active") return NextResponse.json({ error: "Consultation closed" }, { status: 409 });
    try {
      await clinicalTransaction(db, async mongoSession => {
        const result = await db.collection("consultations").updateOne({ _id: consultationId, status: "active",
          metadata_version: consultation.metadata_version ?? { $exists: false } },
          { $set: { ...payload, updated_at: now }, $inc: { metadata_version: 1 } }, { session: mongoSession });
        if (!result.matchedCount) throw new Error("consultation_conflict");
        await logConsultationAudit(db, { consultationId, patientId: consultation.patient_id, actorId: session.actor_id ?? session.uid,
          actorRole: session.role, source: session.role === "doctor" ? "doctor_manual" : "receptionist_manual",
          eventType: "consultation_updated", before: { follow_up_due_at: consultation.follow_up_due_at ?? null, intake_status: consultation.intake_status ?? null },
          after: { follow_up_due_at: payload.follow_up_due_at ?? consultation.follow_up_due_at ?? null, intake_status: payload.intake_status ?? consultation.intake_status ?? null },
          mongoSession });
      });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error && error.message === "consultation_conflict"
        ? "Consultation changed" : "Consultation update could not be committed", },
        { status: error instanceof Error && error.message === "consultation_conflict" ? 409 : 503 });
    }
    return NextResponse.json({ ok: true, finalized_sync: false, metadata_version: Number(consultation.metadata_version ?? 0) + 1 });
  }
  if (session.role !== "doctor") return NextResponse.json({ error: "Only the doctor may complete a consultation" }, { status: 403 });
  if (consultation.status === "completed") return NextResponse.json({ ok: true, finalized_sync: true, already_completed: true });
  if (consultation.status !== "active") return NextResponse.json({ error: "Invalid consultation state" }, { status: 409 });
  const [emr, transcript, patient, history] = await Promise.all([
    db.collection("emr_entries").findOne({ consultation_id: consultationId }),
    db.collection("transcripts").findOne({ consultation_id: consultationId }),
    db.collection("patients").findOne({ _id: consultation.patient_id }),
    db.collection("patient_history").findOne({ patient_id: consultation.patient_id }),
  ]);
  if (!transcript || transcript.processing_status !== "completed" || !emr?.final_transcript_hash ||
    emr.final_transcript_hash !== createHash("sha256").update(String(transcript.raw_text ?? "").trim()).digest("hex"))
    return NextResponse.json({ error: "Final transcript and extraction required" }, { status: 409 });
  if (emr.requires_review || !emr.review || emr.review.version !== Number(emr.version ?? 0) || emr.review.doctor_id !== session.uid)
    return NextResponse.json({ error: "Doctor must review latest EMR version" }, { status: 409 });
  if (!Number.isSafeInteger(payload.reviewed_version) || payload.reviewed_version !== Number(emr.version ?? 0))
    return NextResponse.json({ error: "Sign-off version does not match the latest EMR; reload review", reload_required: true }, { status: 409 });
  const clinicalReview = await loadClinicalReviewState(db, consultationId, consultation.patient_id);
  if (clinicalReview.blockers.length) return NextResponse.json({ error: "Unresolved clinical review requirements", blockers: clinicalReview.blockers }, { status: 422 });
  if (!emr.review.snapshot_fingerprint || emr.review.snapshot_fingerprint !==
      reviewedSnapshotFingerprint((emr.snapshot ?? {}) as EMRSnapshot, emr.provenance ?? {}, emr.grounding_findings ?? []))
    return NextResponse.json({ error: "Clinical content changed after review; review latest EMR", reload_required: true }, { status: 409 });
  const allergies = Array.from(new Set([...(Array.isArray(patient?.allergies) ? patient.allergies : []),
    ...(Array.isArray(history?.core?.allergies) ? history.core.allergies : [])].map(x => String(x).trim()).filter(Boolean)));
  if (emr.review.allergy_fingerprint !== createHash("sha256").update(JSON.stringify([...allergies].sort())).digest("hex") ||
    emr.review.allergy_assessment !== (allergies.length ? "confirmed_known" : "confirmed_none"))
    return NextResponse.json({ error: "Allergy assessment changed; review again" }, { status: 409 });
  const snapshot = (emr.snapshot ?? {}) as EMRSnapshot;
  const medications = (snapshot.medications ?? []).filter(m => typeof m.name === "string" && m.name.trim());
  const safety = await screenPrescription(db, consultation.patient_id, snapshot);
  const warnings = safety.issues.map(issue => issue.message);
  if (emr.review.safety_rules_version !== safety.rule_version) return NextResponse.json({ error: "Safety rules changed; review again" }, { status: 409 });
  if ((emr.grounding_findings ?? []).some((finding: { path: string }) =>
      !(emr.review.acknowledged_grounding ?? []).includes(finding.path)))
    return NextResponse.json({ error: "Grounding findings changed; review again" }, { status: 409 });
  if (warnings.some(w => !(emr.review.acknowledged_warnings ?? []).includes(w)))
    return NextResponse.json({ error: "Allergy conflicts require doctor acknowledgement" }, { status: 409 });
  const diagnosisText = Array.isArray(snapshot.diagnosis_text) ? snapshot.diagnosis_text : [];
  // Requires MongoDB replica set: fail closed rather than partially commit prescriptions/history.
  await prepareAuditIndexes(db);
  const mongoSession = db.client.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      // Claim both the reviewed EMR version and transcript version in the transaction.
      const emrClaim = await db.collection("emr_entries").updateOne({ _id: emr._id, version: emr.version ?? { $exists: false }, requires_review: false },
        { $set: { finalized_at: now } }, { session: mongoSession });
      const transcriptClaim = await db.collection("transcripts").updateOne({ _id: transcript._id, version: transcript.version ?? { $exists: false }, processing_status: "completed" },
        { $set: { finalized_at: now } }, { session: mongoSession });
      if (!emrClaim.matchedCount || !transcriptClaim.matchedCount) throw new Error("Clinical data changed");
      const transitioned = await db.collection("consultations").updateOne({ _id: consultationId, status: "active" },
        { $set: { status: "completed", ended_at: now, updated_at: now } }, { session: mongoSession });
      if (!transitioned.matchedCount) throw new Error("Consultation already finalized");
      await db.collection("prescriptions").updateOne({ consultation_id: consultationId },
        { $set: { consultation_id: consultationId, patient_id: consultation.patient_id, doctor_id: new ObjectId(session.uid),
          medications, diagnosis_text: diagnosisText, approved_emr_version: emr.version,
          approved_snapshot_fingerprint: emr.review.snapshot_fingerprint,
          reviewed_by: new ObjectId(session.uid), reviewed_at: emr.review.reviewed_at,
          issued_at: now, updated_at: now },
          $setOnInsert: { created_at: now } }, { upsert: true, session: mongoSession });
      const coreDoc = await db.collection("patient_history").findOne({ patient_id: consultation.patient_id }, { session: mongoSession });
      const existingCore = (coreDoc?.core ?? {}) as Record<string, unknown>;
      const problems = Array.isArray(existingCore.problem_list) ? existingCore.problem_list : [];
      await db.collection("patient_history").updateOne({ patient_id: consultation.patient_id },
        { $set: { patient_id: consultation.patient_id, core: { ...existingCore, problem_list: [...new Set([...problems, ...diagnosisText])],
          active_meds: medications.map(m => m.name), last_consultation_at: now, last_diagnosis: diagnosisText[0] ?? existingCore.last_diagnosis ?? null }, updated_at: now },
          $setOnInsert: { created_at: now } }, { upsert: true, session: mongoSession });
      const user = await db.collection("users").findOne({ _id: new ObjectId(session.uid) }, { session: mongoSession });
      const specialty = typeof user?.specialty_code === "string" ? user.specialty_code : "general";
      const specialtyFilter = { patient_id: consultation.patient_id, doctor_id: new ObjectId(session.uid), specialty_code: specialty };
      const specialtyDoc = await db.collection("patient_specialty_history").findOne(specialtyFilter, { session: mongoSession });
      await db.collection("patient_specialty_history").updateOne(specialtyFilter,
        { $set: { ...specialtyFilter, data: { ...(specialtyDoc?.data ?? {}), active_meds: medications.map(m => m.name),
          diagnoses: diagnosisText, last_diagnosis: diagnosisText[0] ?? specialtyDoc?.data?.last_diagnosis ?? null, last_consultation_at: now }, updated_at: now },
          $setOnInsert: { created_at: now } }, { upsert: true, session: mongoSession });
      await logConsultationAudit(db, { consultationId, patientId: consultation.patient_id, actorId: session.actor_id ?? session.uid, actorRole: "doctor",
        source: "doctor_manual", eventType: "consultation_finalized", before: { status: "active" }, after: { status: "completed", reviewed_version: emr.version,
          reviewed_by: session.uid, reviewed_at: emr.review.reviewed_at,
          review_fingerprint: emr.review.snapshot_fingerprint,
          warnings_acknowledged: emr.review.acknowledged_warnings,
          grounding_acknowledged: emr.review.acknowledged_grounding },
        mongoSession, allowNoop: true });
    });
    return NextResponse.json({ ok: true, finalized_sync: true });
  } catch (error) {
    if (isClinicalConflict(error)) {
      // Another request may have completed this same consultation successfully.
      // A repeat completion must return success without issuing another prescription.
      const latest = await db.collection("consultations").findOne({ _id: consultationId }, { projection: { status: 1 } });
      if (latest?.status === "completed") return NextResponse.json({ ok: true, finalized_sync: true, already_completed: true });
      return NextResponse.json({ error: "Clinical data changed during completion; reload before retrying" }, { status: 409 });
    }
    return NextResponse.json({ error: "Clinical completion could not be committed atomically. MongoDB replica set and unique indexes are required." }, { status: 503 });
  } finally { await mongoSession.endSession(); }
}
