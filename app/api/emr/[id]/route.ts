import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { getDb } from "@/src/lib/mongodb/client";
import { getServerSession } from "@/src/lib/auth/session";
import { validId, parseBoundedJson } from "@/src/lib/security/access";
import { ensureMedicationIds, reconcileMedicationIds } from "@/src/lib/emr/medicationIdentity";
import { applyProvenanceChanges, changedClinicalFields } from "@/src/lib/emr/grounding";
import { sanitizeSnapshot } from "@/src/lib/emr/validation";
import { screenPrescription } from "@/src/lib/clinical/prescriptionSafetyServer";
import { clinicalTransaction, isClinicalConflict } from "@/src/lib/mongodb/clinicalTransaction";
import { logConsultationAudit } from "@/src/lib/audit/consultationLedger";

type Params = { params: Promise<{ id: string }> };
export async function PUT(request: Request, { params }: Params) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.role !== "doctor" || !validId(session.uid)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  if (!validId(id)) return NextResponse.json({ error: "Invalid EMR ID" }, { status: 400 });
  const db = await getDb();
  const emr = await db.collection("emr_entries").findOne({ _id: new ObjectId(id) });
  if (!emr || !validId(emr.consultation_id?.toString())) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { accessConsultation } = await import("@/src/lib/security/access");
  const auth = await accessConsultation(emr.consultation_id.toString(), { doctorOnly: true, active: true });
  if ("error" in auth) return auth.error;
  let body: Record<string, unknown>;
  try { body = await parseBoundedJson(request) as Record<string, unknown>; if (!body || Object.keys(body).some(k => !["snapshot", "expected_version"].includes(k))) throw new Error(); }
  catch { return NextResponse.json({ error: "Invalid update" }, { status: 400 }); }
  if (!Number.isInteger(body.expected_version) || Number(body.expected_version) !== Number(emr.version ?? 0)) return NextResponse.json({ error: "EMR version conflict" }, { status: 409 });
  let snapshot;
  try {
    // This legacy editor sends only a subset of fields. Treat its snapshot as
    // a patch: replacing the full EMR would erase diagnoses and prescriptions.
    const patch = sanitizeSnapshot(body.snapshot);
    const prior = ensureMedicationIds(emr.snapshot ?? {}, emr.consultation_id.toString());
    snapshot = sanitizeSnapshot({ ...prior, ...patch, ...(patch.medications ? { medications: reconcileMedicationIds(prior.medications, patch.medications) } : {}) });
  } catch { return NextResponse.json({ error: "Invalid EMR snapshot" }, { status: 400 }); }
  // The alternate EMR editor must protect manual changes exactly like the
  // consultation-scoped editor; otherwise later AI extraction can undo them.
  const before = (emr.snapshot ?? {}) as Record<string, unknown>;
  const after = snapshot as Record<string, unknown>;
  const priorWithIds = ensureMedicationIds(before, emr.consultation_id.toString()) as Record<string, unknown>;
  const changed = Object.keys({ ...priorWithIds, ...after }).filter(key => JSON.stringify(priorWithIds[key]) !== JSON.stringify(after[key]));
  const oldSnapshot = ensureMedicationIds(emr.snapshot ?? {}, emr.consultation_id.toString());
  const changedPaths = changedClinicalFields(oldSnapshot, snapshot);
  const provenance = applyProvenanceChanges(emr.provenance, changedPaths.map(path => ({ path,
    origin: emr.provenance?.[path] ? "clinician_correction" as const : "clinician_entry" as const, actor_id: session.uid, actor_role: "doctor" as const })));
  const safety = await screenPrescription(db, auth.consultation.patient_id, snapshot);
  try {
    await clinicalTransaction(db, async mongoSession => {
      const result = await db.collection("emr_entries").updateOne({ _id: emr._id, version: emr.version ?? { $exists: false } },
        { ...(changed.length ? { $addToSet: { manual_override_keys: { $each: changed } } } : {}),
          $set: { snapshot, provenance, safety_screen: { issues: safety.issues, rule_version: safety.rule_version }, requires_review: true, review: null, updated_at: new Date().toISOString() }, $inc: { version: 1 } },
        { session: mongoSession });
      if (!result.matchedCount) throw new Error("Concurrent update");
      await logConsultationAudit(db, { consultationId: auth.consultationId, patientId: auth.consultation.patient_id,
        actorId: session.uid, actorRole: session.role, source: "doctor_manual", eventType: "emr_manual_edit",
        before: emr.snapshot ?? null, after: snapshot, allowNoop: true, mongoSession });
    }, { activeConsultationId: auth.consultationId });
  } catch (error) {
    return NextResponse.json({ error: isClinicalConflict(error) ? "Concurrent update" : "Atomic EMR update unavailable" },
      { status: isClinicalConflict(error) ? 409 : 503 });
  }
  return NextResponse.json({ ok: true, version: Number(emr.version ?? 0) + 1 });
}
