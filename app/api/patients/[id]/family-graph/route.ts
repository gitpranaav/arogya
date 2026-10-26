import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { getServerSession } from "@/src/lib/auth/session";
import { getDb } from "@/src/lib/mongodb/client";
import { validId, parseBoundedJson } from "@/src/lib/security/access";
import { clinicalTransaction, isClinicalConflict } from "@/src/lib/mongodb/clinicalTransaction";
import { logConsultationAudit } from "@/src/lib/audit/consultationLedger";
import { applyFamilyAction, graphFromRecord, GraphValidationError, traverseFamily, type FamilyAction } from "@/src/lib/familyHistory/graph";

type Params = { params: Promise<{ id: string }> };

async function authorize(id: string) {
  const session = await getServerSession();
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (session.role !== "doctor" || !validId(session.uid)) return { error: NextResponse.json({ error: "Doctor access required" }, { status: 403 }) };
  if (!validId(id)) return { error: NextResponse.json({ error: "Invalid patient ID" }, { status: 400 }) };
  const db = await getDb();
  const patientId = new ObjectId(id), doctorId = new ObjectId(session.uid);
  if (!await db.collection("patient_doctors").findOne({ patient_id: patientId, doctor_id: doctorId }))
    return { error: NextResponse.json({ error: "Patient not found in practice" }, { status: 404 }) };
  return { db, patientId, doctorId, session };
}

export async function GET(request: Request, { params }: Params) {
  const auth = await authorize((await params).id);
  if ("error" in auth) return auth.error;
  const { db, patientId } = auth;
  const doc = await db.collection("patient_family_graphs").findOne({ patient_id: patientId });
  const graph = graphFromRecord(doc);
  const depthRaw = new URL(request.url).searchParams.get("depth");
  const depth = depthRaw === null ? 4 : Number(depthRaw);
  if (!Number.isInteger(depth) || depth < 0 || depth > 4) return NextResponse.json({ error: "Invalid traversal depth" }, { status: 400 });
  return NextResponse.json({ graph, view: traverseFamily(graph, "patient", depth) });
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await authorize((await params).id);
  if ("error" in auth) return auth.error;
  const { db, patientId, doctorId, session } = auth;
  let body: { consultation_id?: string; expected_version?: number; change?: FamilyAction };
  try { body = await parseBoundedJson(request, 8 * 1024) as typeof body; }
  catch { return NextResponse.json({ error: "Invalid family graph payload" }, { status: 400 }); }
  if (!body || !validId(body.consultation_id) || !Number.isSafeInteger(body.expected_version) || body.expected_version! < 0 || !body.change)
    return NextResponse.json({ error: "Expected version, active consultation and action required" }, { status: 400 });
  const consultationId = new ObjectId(body.consultation_id);
  const owner = await db.collection("consultations").findOne({ _id: consultationId, patient_id: patientId, doctor_id: doctorId, status: "active" });
  if (!owner) return NextResponse.json({ error: "Active consultation required" }, { status: 403 });
  // Index readiness outside the transaction. The unique patient_id index guards first-write races.
  await db.collection("patient_family_graphs").createIndex({ patient_id: 1 }, { unique: true });
  try {
    const graph = await clinicalTransaction(db, async mongoSession => {
      const collection = db.collection("patient_family_graphs");
      const stored = await collection.findOne({ patient_id: patientId }, { session: mongoSession });
      const before = graphFromRecord(stored);
      if (before.version !== body.expected_version) throw new Error("version_conflict");
      const after = applyFamilyAction(before, body.change!);
      const result = await collection.updateOne(
        stored ? { _id: stored._id, version: before.version } : { patient_id: patientId, version: { $exists: false } },
        { $set: { schema_version: after.schema_version, version: after.version, relatives: after.relatives, assertions: after.assertions,
          updated_at: after.updated_at }, $setOnInsert: { patient_id: patientId, created_at: new Date().toISOString() } },
        { upsert: !stored, session: mongoSession });
      if (!result.matchedCount && !result.upsertedCount) throw new Error("version_conflict");
      await logConsultationAudit(db, { consultationId, patientId,
        actorId: session.actor_id ?? session.uid, actorRole: session.role,
        source: "doctor_manual", eventType: "family_graph_change", before, after,
        metadata: { schema_version: after.schema_version, action: body.change!.action, graph_version: after.version }, mongoSession });
      return after;
    }, { activeConsultationId: consultationId });
    return NextResponse.json({ graph });
  } catch (error) {
    if (error instanceof GraphValidationError) return NextResponse.json({ error: error.message }, { status: 422 });
    if (isClinicalConflict(error)) return NextResponse.json({ error: "Family graph changed; reload and retry", retryable: true }, { status: 409 });
    return NextResponse.json({ error: "Family graph could not be committed atomically" }, { status: 503 });
  }
}
