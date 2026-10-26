import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { getServerSession } from "@/src/lib/auth/session";
import { getDb } from "@/src/lib/mongodb/client";

type Params = { params: Promise<{ id: string }> };

/** Prior visits for follow-up linking (doctor or receptionist under that doctor). */
export async function GET(_request: Request, { params }: Params) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["doctor", "receptionist"].includes(String(session.role))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const db = await getDb();
  const doctorObjectId = new ObjectId(session.uid);
  if (!ObjectId.isValid(id)) return NextResponse.json({ error: "Invalid patient ID" }, { status: 400 });
  const patientObjectId = new ObjectId(id);

  const link = await db.collection("patient_doctors").findOne({ patient_id: patientObjectId, doctor_id: doctorObjectId });
  if (!link) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const consultations = await db
    .collection("consultations")
    .find({ patient_id: patientObjectId, doctor_id: doctorObjectId })
    .sort({ created_at: -1 })
    .limit(30)
    .project({ _id: 1, created_at: 1, type: 1, status: 1 })
    .toArray();

  const ids = consultations.map((c) => c._id);
  const emrRows = ids.length
    ? await db
        .collection("emr_entries")
        .find({ consultation_id: { $in: ids } })
        .project({ consultation_id: 1, snapshot: 1, chief_complaint: 1 })
        .toArray()
    : [];

  const emrByC = new Map<string, string | null>();
  for (const row of emrRows as Array<{ consultation_id: ObjectId; snapshot?: unknown; chief_complaint?: string | null }>) {
    const snap = row.snapshot as { chief_complaint?: string | null } | undefined;
    emrByC.set(row.consultation_id.toString(), snap?.chief_complaint ?? row.chief_complaint ?? null);
  }

  return NextResponse.json({
    consultations: consultations.map((c) => ({
      id: c._id.toString(),
      created_at: c.created_at,
      type: c.type ?? "General",
      status: c.status ?? null,
      chief_complaint: emrByC.get(c._id.toString()) ?? null,
    })),
  });
}
