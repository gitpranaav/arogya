import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { getServerSession } from "@/src/lib/auth/session";
import { logConsultationAudit } from "@/src/lib/audit/consultationLedger";
import { getDb } from "@/src/lib/mongodb/client";
import { parseBoundedJson } from "@/src/lib/security/access";
import { clinicalTransaction } from "@/src/lib/mongodb/clinicalTransaction";

type Params = { params: Promise<{ id: string }> };

const ALLOWED_CORE_KEYS = new Set([
  "allergies",
  "problem_list",
  "past_surgeries",
  "family_history",
  "social_history",
  "immunizations",
  "active_meds",
]);

function sanitizeObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, unknown>;
  return value as Record<string, unknown>;
}

export async function GET(_request: Request, { params }: Params) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["doctor", "receptionist"].includes(String(session.role))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const db = await getDb();
  const doctorObjectId = new ObjectId(session.uid);
  if (!ObjectId.isValid(id)) return NextResponse.json({ error: "Invalid patient ID" }, { status: 400 });
  const patientId = new ObjectId(id);

  const link = await db.collection("patient_doctors").findOne({ patient_id: patientId, doctor_id: doctorObjectId });
  if (!link) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [patient, history, doctor, recentConsultations] = await Promise.all([
    db.collection("patients").findOne({ _id: patientId }),
    db.collection("patient_history").findOne({ patient_id: patientId }),
    db.collection("users").findOne({ _id: doctorObjectId }, { projection: { specialty_code: 1, specialization: 1, name: 1 } }),
    db
      .collection("consultations")
      .find({ patient_id: patientId, doctor_id: doctorObjectId, status: "completed" })
      .sort({ created_at: -1 })
      .limit(5)
      .project({ _id: 1, created_at: 1, type: 1, status: 1 })
      .toArray(),
  ]);

  const specialty_code = String((doctor as any)?.specialty_code ?? "general");
  const specialty = await db.collection("patient_specialty_history").findOne({
    patient_id: patientId,
    doctor_id: doctorObjectId,
    specialty_code,
  });

  const latestCompleted = recentConsultations[0] ?? null;
  const latestConsultationId = latestCompleted?._id ?? null;
  const latestEmr = latestConsultationId ? await db.collection("emr_entries").findOne({ consultation_id: latestConsultationId }) : null;
  const latestPrescription = latestConsultationId ? await db.collection("prescriptions").findOne({ consultation_id: latestConsultationId }) : null;
  const latestDiagnoses = latestEmr?._id ? await db.collection("emr_diagnoses").find({ emr_entry_id: latestEmr._id }).toArray() : [];

  const latestConsultation = latestCompleted
    ? {
        consultation_id: latestCompleted._id.toString(),
        created_at: latestCompleted.created_at,
        visit_type: latestCompleted.type ?? "General",
        status: latestCompleted.status ?? null,
        chief_complaint: latestEmr?.snapshot?.chief_complaint ?? latestEmr?.chief_complaint ?? null,
        assessment: latestEmr?.snapshot?.assessment ?? latestEmr?.assessment ?? null,
        clinical_summary: latestEmr?.snapshot?.clinical_summary ?? latestEmr?.clinical_summary ?? null,
        patient_summary: latestEmr?.snapshot?.patient_summary ?? null,
        diagnoses: latestDiagnoses.map((row) => ({
          diagnosis_text: row.diagnosis_text ?? null,
          icd_code_id: row.icd_code_id?.toString?.() ?? null,
          is_primary: Boolean(row.is_primary),
        })),
        medications: Array.isArray(latestPrescription?.medications) ? latestPrescription.medications : latestEmr?.snapshot?.medications ?? [],
      }
    : null;

  const recentIds = recentConsultations.map((c) => c._id);
  const recentEmr = recentIds.length
    ? await db
        .collection("emr_entries")
        .find({ consultation_id: { $in: recentIds } })
        .project({ consultation_id: 1, snapshot: 1, clinical_summary: 1, created_at: 1 })
        .toArray()
    : [];

  const emrMap = new Map(recentEmr.map((e) => [e.consultation_id.toString(), e]));
  const recent = recentConsultations.map((c) => ({
    consultation_id: c._id.toString(),
    created_at: c.created_at,
    clinical_summary: emrMap.get(c._id.toString())?.snapshot?.clinical_summary ?? emrMap.get(c._id.toString())?.clinical_summary ?? null,
  }));

  const core = (history as { core?: Record<string, unknown> } | null)?.core ?? {};
  const historyPayload = history
    ? {
        ...core,
        id: history._id.toString(),
        patient_id: (history as { patient_id?: unknown }).patient_id?.toString?.() ?? String(patientId),
        created_at: (history as { created_at?: string | Date | null }).created_at ?? null,
        updated_at: (history as { updated_at?: string | Date | null }).updated_at ?? null,
      }
    : null;

  return NextResponse.json({
    doctor: { id: doctorObjectId.toString(), specialty_code, specialization: (doctor as any)?.specialization ?? null, name: (doctor as any)?.name ?? null },
    patient: patient ? { id: patient._id.toString(), name: patient.name ?? null, phone: patient.phone ?? null, dob: patient.dob ?? null, gender: patient.gender ?? null } : null,
    history: historyPayload,
    specialty_history: specialty?.data ?? null,
    latest_consultation: latestConsultation,
    recent,
  });
}

export async function PUT(request: Request, { params }: Params) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Receptionists may capture intake but cannot rewrite longitudinal clinical history.
  if (session.role !== "doctor") return NextResponse.json({ error: "Only doctors may edit clinical history" }, { status: 403 });

  const { id } = await params;
  const db = await getDb();
  const doctorObjectId = new ObjectId(session.uid);
  if (!ObjectId.isValid(id)) return NextResponse.json({ error: "Invalid patient ID" }, { status: 400 });
  const patientId = new ObjectId(id);

  const link = await db.collection("patient_doctors").findOne({ patient_id: patientId, doctor_id: doctorObjectId });
  if (!link) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { core?: Record<string, unknown>; specialty_history?: Record<string, unknown>; consultation_id?: string };
  try { body = await parseBoundedJson(request, 32 * 1024) as typeof body; }
  catch { return NextResponse.json({ error: "Invalid history payload" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid history payload" }, { status: 400 });
  if (body.consultation_id !== undefined) {
    if (typeof body.consultation_id !== "string" || !ObjectId.isValid(body.consultation_id)) return NextResponse.json({ error: "Invalid consultation ID" }, { status: 400 });
    const owner = await db.collection("consultations").findOne({ _id: new ObjectId(body.consultation_id), patient_id: patientId, doctor_id: doctorObjectId });
    if (!owner || owner.status !== "active") return NextResponse.json({ error: "Consultation is not active or not owned by this practice" }, { status: 403 });
  }
  const coreInput = sanitizeObject(body.core);
  const specialtyInput = sanitizeObject(body.specialty_history);
  const beforeHistory = await db.collection("patient_history").findOne({ patient_id: patientId });
  const beforeSpecialty = await db.collection("patient_specialty_history").findOne({ patient_id: patientId, doctor_id: doctorObjectId });

  const coreSet: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(coreInput)) {
    if (!ALLOWED_CORE_KEYS.has(key)) return NextResponse.json({ error: "History field not permitted" }, { status: 400 });
    if (JSON.stringify(value).length > 8000) return NextResponse.json({ error: "History field too large" }, { status: 413 });
    if (["allergies", "problem_list", "past_surgeries", "immunizations", "active_meds"].includes(key) &&
      (!Array.isArray(value) || value.length > 40 || value.some(x => typeof x !== "string" || x.length > 250)))
      return NextResponse.json({ error: "Invalid clinical history list" }, { status: 400 });
    coreSet[`core.${key}`] = value;
  }

  const specialtySet: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(specialtyInput)) {
    if (!/^[a-z][a-z0-9_]{0,60}$/.test(key) || ["doctor_id", "patient_id", "specialty_code", "created_at", "updated_at"].includes(key))
      return NextResponse.json({ error: "Invalid specialty history field" }, { status: 400 });
    if (JSON.stringify(value).length > 8000) return NextResponse.json({ error: "Specialty history value too large" }, { status: 400 });
    specialtySet[`data.${key}`] = value;
  }
  const doctor = await db.collection("users").findOne({ _id: doctorObjectId }, { projection: { specialty_code: 1 } });
  const specialtyCode = String(doctor?.specialty_code ?? "general");
  const now = new Date().toISOString();
  try {
    await clinicalTransaction(db, async mongoSession => {
      if (Object.keys(coreSet).length) {
        await db.collection("patient_history").updateOne({ patient_id: patientId },
          { $set: { ...coreSet, updated_at: now }, $setOnInsert: { patient_id: patientId, created_at: now } },
          { upsert: true, session: mongoSession });
      }
      if (Object.keys(specialtySet).length) {
        await db.collection("patient_specialty_history").updateOne({ patient_id: patientId, doctor_id: doctorObjectId, specialty_code: specialtyCode },
          { $set: { ...specialtySet, updated_at: now }, $setOnInsert: { patient_id: patientId,
            doctor_id: doctorObjectId, specialty_code: specialtyCode, created_at: now } },
          { upsert: true, session: mongoSession });
      }
      if (body.consultation_id && (Object.keys(coreSet).length || Object.keys(specialtySet).length)) {
        const beforeCore = ((beforeHistory as { core?: Record<string, unknown> } | null)?.core ?? {}) as Record<string, unknown>;
        const beforeSpecialtyData = ((beforeSpecialty as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
        const afterCore = { ...beforeCore };
        for (const [key, value] of Object.entries(coreInput)) afterCore[key] = value;
        const afterSpecialty = { ...beforeSpecialtyData, ...specialtyInput };
        await logConsultationAudit(db, {
          consultationId: new ObjectId(body.consultation_id), patientId,
          actorId: session.actor_id ?? session.uid, actorRole: session.role,
          source: "doctor_manual", eventType: "doctor_history_edit", before: { core: beforeCore, specialty_history: beforeSpecialtyData },
          after: { core: afterCore, specialty_history: afterSpecialty },
          metadata: { route: "patients.history.put", core_keys: Object.keys(coreInput), specialty_keys: Object.keys(specialtyInput) },
          mongoSession,
        });
      }
    }, body.consultation_id ? { activeConsultationId: new ObjectId(body.consultation_id) } : {});
  } catch {
    return NextResponse.json({ error: "History update could not be committed atomically" }, { status: 503 });
  }

  return NextResponse.json({ ok: true });
}
