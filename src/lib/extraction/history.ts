import type { Db, ObjectId } from "mongodb";
import type { HistoricalEvidence } from "./context";
import type { EMRMedication, EMRSnapshot, TranscriptSegment } from "../emr/types";

/** Only explicit references trigger history retrieval; this is not clinical inference. */
export function referencesPriorCare(text: string): boolean {
  return /\b(previous|last visit|last time|earlier visit|prior (?:consultation|prescription|medication|medicine|treatment)|history of|continue (?:the |my |same )?(?:medicine|medication|tablet|treatment)|pichli|pichle|pehle|purani|last appointment)\b/i.test(text);
}

/** Caller MUST supply patient and practice from an authorized consultation, never request body fields. */
export async function retrieveAuthorizedHistory(db: Db, patientId: ObjectId, doctorId: ObjectId,
  consultationId: ObjectId, speech: string): Promise<HistoricalEvidence[]> {
  if (!referencesPriorCare(speech)) return [];
  const visits = await db.collection("consultations").find({
    patient_id: patientId, doctor_id: doctorId, status: "completed", _id: { $ne: consultationId },
  }, { projection: { _id: 1, created_at: 1, started_at: 1 } }).sort({ created_at: -1, _id: -1 }).limit(3).toArray();
  if (!visits.length) return [];
  const ids = visits.map((v: { _id: ObjectId }) => v._id);
  const [rx, emrs, older] = await Promise.all([
    db.collection<{ consultation_id: ObjectId; medications?: EMRMedication[] }>("prescriptions").find({ consultation_id: { $in: ids } }, { projection: { _id: 1, consultation_id: 1, medications: 1 } }).limit(3).toArray(),
    db.collection<{ consultation_id: ObjectId; snapshot?: EMRSnapshot }>("emr_entries").find({ consultation_id: { $in: ids } }, { projection: { _id: 1, consultation_id: 1, "snapshot.diagnosis_text": 1, "snapshot.medications": 1 } }).limit(3).toArray(),
    db.collection<{ consultation_id: ObjectId; segments?: TranscriptSegment[] }>("transcripts").find({ consultation_id: { $in: ids } }, { projection: { _id: 1, consultation_id: 1, segments: { $slice: -20 } } }).limit(3).toArray(),
  ]);
  const evidence: HistoricalEvidence[] = [];
  for (const visit of visits) {
    const key = String(visit._id);
    const date = visit.created_at ?? visit.started_at;
    const stamp = date instanceof Date ? date.toISOString() : (typeof date === "string" ? date : null);
    const pres = rx.find(p => String(p.consultation_id) === key);
    if (pres && Array.isArray(pres.medications)) evidence.push({ consultation_id: key, date: stamp, kind: "prior_prescription", source_id: String(pres._id),
      value: pres.medications.slice(0, 12).map(m => ({ id: m.id, name: m.name, dosage: m.dosage })) });
    const emr = emrs.find(e => String(e.consultation_id) === key);
    if (emr?.snapshot) evidence.push({ consultation_id: key, date: stamp, kind: "prior_emr", source_id: String(emr._id),
      value: { diagnoses: Array.isArray(emr.snapshot.diagnosis_text) ? emr.snapshot.diagnosis_text.slice(0, 8) : [] } });
    // Only bounded, medication-related previous utterances, never entire old transcripts.
    const prior = older.find(t => String(t.consultation_id) === key);
    const meds = Array.isArray(prior?.segments) ? prior.segments.filter((s: { text?: string }) =>
      /\b(medicine|medication|tablet|dose|prescrib|continue|mg|drug)\b/i.test(String(s.text ?? ""))).slice(-2) : [];
    for (const s of meds) if (typeof s.id === "string" && typeof s.text === "string")
      evidence.push({ consultation_id: key, date: stamp, kind: "prior_transcript", source_id: String(prior!._id),
        evidence_segment_ids: [s.id], value: s.text.slice(0, 240) });
  }
  return evidence.slice(0, 9);
}
