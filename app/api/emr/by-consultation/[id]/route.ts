import type { EMRSnapshot } from "@/src/lib/emr/types";
import { NextResponse } from "next/server";
import { accessConsultation, parseBoundedJson } from "@/src/lib/security/access";
import { ensureMedicationIds, reconcileMedicationIds } from "@/src/lib/emr/medicationIdentity";
import { applyProvenanceChanges, changedClinicalFields } from "@/src/lib/emr/grounding";
import { sanitizeSnapshot } from "@/src/lib/emr/validation";
import { screenPrescription } from "@/src/lib/clinical/prescriptionSafetyServer";
import { clinicalTransaction, isClinicalConflict } from "@/src/lib/mongodb/clinicalTransaction";
import { logConsultationAudit } from "@/src/lib/audit/consultationLedger";

type Params = { params: Promise<{ id: string }> };
export async function GET(_req: Request, { params }: Params) {
  const auth = await accessConsultation((await params).id);
  if ("error" in auth) return auth.error;
  const doc = await auth.db.collection("emr_entries").findOne({ consultation_id: auth.consultationId });
  if (!doc) return NextResponse.json({ emr_entry: null });
  return NextResponse.json({ emr_entry: {
    id: doc._id.toString(), consultation_id: auth.consultationId.toString(), snapshot: ensureMedicationIds(doc.snapshot ?? {}, auth.consultationId.toString()), provenance: doc.provenance ?? {}, grounding_findings: doc.grounding_findings ?? [],
    extraction_cursor: doc.extraction_cursor ?? null, requires_review: Boolean(doc.requires_review),
    version: doc.version ?? 0, updated_at: doc.updated_at, created_at: doc.created_at,
  } });
}
export async function PUT(req: Request, { params }: Params) {
  const auth = await accessConsultation((await params).id, { active: true });
  if ("error" in auth) return auth.error;
  let incoming: EMRSnapshot;
  let expected: number;
  try {
    const body = await parseBoundedJson(req) as Record<string, unknown>;
    if (!body || !Number.isInteger(body.expected_version) || Number(body.expected_version) < 0) throw new Error("Missing expected_version");
    incoming = sanitizeSnapshot(body.snapshot);
    expected = Number(body.expected_version);
  } catch { return NextResponse.json({ error: "Invalid snapshot or expected_version" }, { status: 400 }); }
  const { db, session, consultation, consultationId } = auth;
  const existing = await db.collection("emr_entries").findOne({ consultation_id: consultationId });
  if (Number(existing?.version ?? 0) !== expected) return NextResponse.json({ error: "EMR has changed. Reload before saving.", current_version: existing?.version ?? 0 }, { status: 409 });
  const isReceptionist = session.role === "receptionist";
  const allowed = new Set(["vitals", "chief_complaint", "symptoms"]);
  if (isReceptionist && Object.keys(incoming).some(k => !allowed.has(k))) return NextResponse.json({ error: "Receptionist field not permitted" }, { status: 403 });
  const priorSnapshot = ensureMedicationIds(existing?.snapshot ?? {}, consultationId.toString());
  const merged: EMRSnapshot = isReceptionist ? { ...priorSnapshot, ...incoming } : incoming;
  if (merged.medications) merged.medications = reconcileMedicationIds(priorSnapshot.medications ?? [], merged.medications);
  const changedPaths = changedClinicalFields(priorSnapshot, merged);
  const existingProvenance = existing?.provenance;
  const provenance = applyProvenanceChanges(existingProvenance, changedPaths.map(path => ({ path,
    origin: isReceptionist
      ? (existingProvenance?.[path] ? "staff_correction" as const : "staff_entry" as const)
      : (existingProvenance?.[path] || path.startsWith("medications[") && priorSnapshot.medications?.some(m => path.includes(`id=${m.id}]`))
        ? "clinician_correction" as const : "clinician_entry" as const),
    actor_id: session.actor_id ?? session.uid, actor_role: isReceptionist ? "receptionist" as const : "doctor" as const })));

  const safety = await screenPrescription(db, consultation.patient_id, merged);
  const before = (existing?.snapshot ?? {}) as Record<string, unknown>;
  const changed = Object.keys(merged).filter(key => JSON.stringify((priorSnapshot as unknown as Record<string, unknown>)[key]) !== JSON.stringify((merged as unknown as Record<string, unknown>)[key]));
  const now = new Date().toISOString();
  const filter = existing ? { _id: existing._id, version: existing.version ?? { $exists: false } } : { consultation_id: consultationId, version: { $exists: false } };
  try {
    await clinicalTransaction(db, async (mongoSession) => {
      const updated = await db.collection("emr_entries").updateOne(filter,
        { ...(changed.length ? { $addToSet: { manual_override_keys: { $each: changed } } } : {}),
          $set: { snapshot: merged, provenance, grounding_findings: existing?.grounding_findings ?? [], safety_screen: { issues: safety.issues, rule_version: safety.rule_version }, requires_review: true, review: null,
            updated_by: session.actor_id ?? session.uid, updated_by_role: session.role, updated_at: now },
          $inc: { version: 1 }, $setOnInsert: { consultation_id: consultationId, created_at: now } },
        { upsert: !existing, session: mongoSession });
      if (!updated.matchedCount && !updated.upsertedCount) throw new Error("Concurrent EMR update");
      await logConsultationAudit(db, { consultationId, patientId: consultation.patient_id,
        actorId: session.actor_id ?? session.uid, actorRole: session.role,
        source: isReceptionist ? "receptionist_manual" : "doctor_manual", eventType: "emr_manual_edit",
        before: existing?.snapshot ?? null, after: merged, metadata: { expected_version: expected, resulting_version: expected + 1 },
        allowNoop: true, mongoSession });
    }, { activeConsultationId: consultationId });
  } catch (e: any) {
    if (isClinicalConflict(e)) return NextResponse.json({ error: "Concurrent EMR update" }, { status: 409 });
    return NextResponse.json({ error: "EMR update could not be committed atomically" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, version: expected + 1, snapshot: merged, safety_issues: safety.issues });
}
