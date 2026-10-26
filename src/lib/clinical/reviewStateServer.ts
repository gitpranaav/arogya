/** Server-owned sign-off state; never take warnings or blocking conditions from the client. */
import { createHash } from "node:crypto";
import type { Db, ObjectId } from "mongodb";
import type { EMRSnapshot, TranscriptSegment } from "@/src/lib/emr/types";
import type { FamilyGraph } from "@/src/lib/familyHistory/graph";
import { screenPrescription } from "./prescriptionSafetyServer";
import { prescriptionFieldProblems, transcriptBlockers, familyProposalBlockers, reviewStatus, reviewedSnapshotFingerprint, type ReviewBlocker } from "./reviewPolicy";

export async function loadClinicalReviewState(db: Db, consultationId: ObjectId, patientId: ObjectId) {
  const [emr, transcript, familyGraph, pendingBatch] = await Promise.all([
    db.collection("emr_entries").findOne({ consultation_id: consultationId }),
    db.collection<{ consultation_id: ObjectId; processing_status?: string; raw_text?: string; segments?: TranscriptSegment[] }>("transcripts").findOne({ consultation_id: consultationId }),
    db.collection<Partial<FamilyGraph> & { patient_id: ObjectId }>("patient_family_graphs").findOne({ patient_id: patientId }),
    db.collection("emr_extraction_batches").findOne({ consultation_id: consultationId, status: "processing" }),
  ]);
  const snapshot = (emr?.snapshot ?? {}) as EMRSnapshot;
  const safety = await screenPrescription(db, patientId, snapshot);
  const blockers: ReviewBlocker[] = [
    ...transcriptBlockers(transcript, emr?.final_transcript_hash),
    ...prescriptionFieldProblems(snapshot),
    ...familyProposalBlockers(familyGraph),
  ];
  // A failed delta is superseded by a successful full extraction of the final transcript;
  // only an in-flight batch can still change the EMR during sign-off.
  if (pendingBatch) blockers.push({ code: "pending_extraction", path: "transcript", message: "An AI extraction batch is still processing; finish it before sign-off" });
  if (!emr) blockers.push({ code: "missing_emr", path: "emr", message: "No EMR exists to review" });
  const findings = Array.isArray(emr?.grounding_findings) ? emr.grounding_findings : [];
  const warnings = safety.issues.map(x => x.message);
  const version = Number(emr?.version ?? 0);
  const fingerprint = reviewedSnapshotFingerprint(snapshot, emr?.provenance ?? {}, findings);
  const allergyFingerprint = createHash("sha256").update(JSON.stringify([...safety.allergies].sort())).digest("hex");
  const reviewed = !emr?.requires_review && emr?.review?.version === version &&
    emr?.review?.snapshot_fingerprint === fingerprint &&
    emr?.review?.allergy_fingerprint === allergyFingerprint &&
    emr?.review?.safety_rules_version === safety.rule_version &&
    emr?.review?.allergy_assessment === (safety.allergies.length ? "confirmed_known" : "confirmed_none") &&
    warnings.every(warning => (emr?.review?.acknowledged_warnings ?? []).includes(warning)) &&
    findings.every((finding: { path: string }) => (emr?.review?.acknowledged_grounding ?? []).includes(finding.path));
  return { emr, transcript, snapshot, familyGraph, pendingBatch, blockers, findings, safety,
    warnings, version, fingerprint, reviewed, status: reviewStatus({ blockers, reviewed }),
    allergyFingerprint };
}
