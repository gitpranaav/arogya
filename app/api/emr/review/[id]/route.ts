import { NextResponse } from "next/server";
import { accessConsultation, parseBoundedJson } from "@/src/lib/security/access";
import { loadClinicalReviewState } from "@/src/lib/clinical/reviewStateServer";
import { reviewedSnapshotFingerprint } from "@/src/lib/clinical/reviewPolicy";
import { clinicalTransaction, isClinicalConflict } from "@/src/lib/mongodb/clinicalTransaction";
import { logConsultationAudit } from "@/src/lib/audit/consultationLedger";
import { readProvenance } from "@/src/lib/emr/grounding";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const auth = await accessConsultation((await params).id, { doctorOnly: true, active: true });
  if ("error" in auth) return auth.error;
  const state = await loadClinicalReviewState(auth.db, auth.consultationId, auth.consultation.patient_id);
  const requiredEvidence = new Set<string>([
    ...Object.values(readProvenance(state.emr?.provenance)).flatMap(entry => entry.evidence_segment_ids ?? []),
    ...state.findings.flatMap((finding: { evidence_segment_ids?: string[] }) => finding.evidence_segment_ids ?? []),
  ]);
  const segments = Array.isArray(state.transcript?.segments) ? state.transcript.segments as Array<{ id?: string; text?: string }> : [];
  const evidence = [...new Map([...segments.filter(segment => segment.id && requiredEvidence.has(segment.id)).slice(-220),
    ...segments.slice(-60)].map(segment => [segment.id, { id: segment.id, text: segment.text }])).values()];
  return NextResponse.json({
    version: state.version, status: state.status, requires_review: Boolean(state.emr?.requires_review),
    blockers: state.blockers, snapshot: state.snapshot, provenance: state.emr?.provenance ?? {},
    evidence,
    family_proposals: {
      relatives: (state.familyGraph?.relatives ?? []).filter((x: { status?: string }) => x.status === "proposed"),
      assertions: (state.familyGraph?.assertions ?? []).filter((x: { status?: string }) => x.status === "proposed"),
    },
    allergies: state.safety.allergies, warning_details: state.safety.issues,
    safety_rules_version: state.safety.rule_version,
    allergy_status: state.safety.allergies.length ? "recorded" : "not_assessed",
    warnings: state.warnings, grounding_findings: state.findings,
    final_extraction_complete: !state.blockers.some(b => b.code === "final_transcript"),
  });
}

export async function POST(request: Request, { params }: Params) {
  const auth = await accessConsultation((await params).id, { doctorOnly: true, active: true });
  if ("error" in auth) return auth.error;
  let input: Record<string, unknown>;
  try { input = await parseBoundedJson(request, 10 * 1024) as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "Invalid review" }, { status: 400 }); }
  const state = await loadClinicalReviewState(auth.db, auth.consultationId, auth.consultation.patient_id);
  const emr = state.emr;
  if (!emr || state.blockers.length) return NextResponse.json({
    error: "Resolve mandatory clinical review blockers before sign-off", blockers: state.blockers }, { status: 422 });
  if (!Number.isSafeInteger(input?.expected_version) || input.expected_version !== state.version)
    return NextResponse.json({ error: "EMR changed. Review latest version", current_version: state.version, reload_required: true }, { status: 409 });
  if (input.confirmed_review !== true) return NextResponse.json({ error: "Clinician must explicitly approve the reviewed EMR" }, { status: 422 });
  if (input.confirmed_prescription !== true) return NextResponse.json({ error: "Clinician must explicitly verify prescription details and medication safety" }, { status: 422 });
  if (input.allergy_assessment !== (state.safety.allergies.length ? "confirmed_known" : "confirmed_none"))
    return NextResponse.json({ error: "Explicit allergy assessment required" }, { status: 422 });
  const grounded = input.acknowledged_grounding;
  if (state.findings.length && (!Array.isArray(grounded) || state.findings.some((f: { path: string }) => !grounded.includes(f.path))))
    return NextResponse.json({ error: "Unsupported or uncertain AI grounding findings require explicit doctor review" }, { status: 422 });
  const warnings = input.acknowledged_warnings;
  if (!Array.isArray(warnings) || state.warnings.some(w => !warnings.includes(w)))
    return NextResponse.json({ error: "Prescription safety warnings require explicit acknowledgement" }, { status: 422 });
  const timestamp = new Date().toISOString();
  const provenance = structuredClone(readProvenance(emr.provenance));
  for (const entry of Object.values(provenance)) if (["ai", "staff_entry", "staff_correction"].includes(entry.origin)) entry.reviewed = true;
  const fingerprint = reviewedSnapshotFingerprint(state.snapshot, provenance, state.findings);
  try {
    await clinicalTransaction(auth.db, async mongoSession => {
      // Validate the clinical data again inside the transaction. Preflight GET is not authorization to sign stale data.
      const latest = await loadClinicalReviewState(auth.db, auth.consultationId, auth.consultation.patient_id);
      if (latest.blockers.length || latest.version !== state.version || latest.fingerprint !== state.fingerprint ||
          latest.allergyFingerprint !== state.allergyFingerprint || latest.safety.rule_version !== state.safety.rule_version ||
          JSON.stringify(latest.warnings) !== JSON.stringify(state.warnings)) throw new Error("version_conflict");
      const result = await auth.db.collection("emr_entries").updateOne({ _id: emr._id, version: state.version, requires_review: emr.requires_review ?? { $exists: false } },
        { $set: { requires_review: false, provenance, review: {
          version: state.version, doctor_id: auth.session.uid, actor_id: auth.session.actor_id ?? auth.session.uid,
          snapshot_fingerprint: fingerprint,
          allergy_assessment: input.allergy_assessment, allergy_fingerprint: state.allergyFingerprint,
          acknowledged_warnings: state.warnings, acknowledged_grounding: state.findings.map((f: { path: string }) => f.path),
          acknowledged_issues: state.safety.issues, safety_rules_version: state.safety.rule_version,
          reviewed_at: timestamp }, updated_at: timestamp } }, { session: mongoSession });
      if (!result.matchedCount) throw new Error("version_conflict");
      await logConsultationAudit(auth.db, { consultationId: auth.consultationId, patientId: auth.consultation.patient_id,
        actorId: auth.session.actor_id ?? auth.session.uid, actorRole: "doctor", source: "doctor_manual", eventType: "clinical_review_accepted",
        before: { reviewed: false }, after: { reviewed: true, version: state.version, fingerprint,
          warnings_acknowledged: state.warnings, acknowledged_issues: state.safety.issues,
          grounding_acknowledged: state.findings.map((f: { path: string }) => f.path), safety_rules_version: state.safety.rule_version },
        allowNoop: true, mongoSession });
    }, { activeConsultationId: auth.consultationId });
  } catch (error) {
    return NextResponse.json({ error: isClinicalConflict(error) || (error instanceof Error && error.message === "version_conflict")
      ? "Clinical data changed; reload review without discarding unsaved edits" : "Review could not be committed atomically",
      reload_required: true }, { status: isClinicalConflict(error) || (error instanceof Error && error.message === "version_conflict") ? 409 : 503 });
  }
  return NextResponse.json({ ok: true, reviewed_version: state.version, review_fingerprint: fingerprint });
}
