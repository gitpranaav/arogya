import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { getServerSession } from "@/src/lib/auth/session";
import { getDb } from "@/src/lib/mongodb/client";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["doctor", "receptionist"].includes(String(session.role))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  if (!ObjectId.isValid(id)) return NextResponse.json({ error: "Invalid consultation ID" }, { status: 400 });
  const db = await getDb();
  const doctorObjectId = new ObjectId(session.uid);

  const consultation = await db.collection("consultations").findOne({ _id: new ObjectId(id), doctor_id: doctorObjectId });
  if (!consultation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const patientId = consultation.patient_id;
  if (!patientId) return NextResponse.json({ error: "Missing patient_id" }, { status: 500 });

  // must be linked doctor<->patient
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
      .project({ _id: 1, created_at: 1 })
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
  const latestEmr = latestConsultationId
    ? await db.collection("emr_entries").findOne({ consultation_id: latestConsultationId })
    : null;
  const latestPrescription = latestConsultationId
    ? await db.collection("prescriptions").findOne({ consultation_id: latestConsultationId })
    : null;
  const latestDiagnoses = latestEmr?._id
    ? await db.collection("emr_diagnoses").find({ emr_entry_id: latestEmr._id }).toArray()
    : [];

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
  const patientAllergies = Array.isArray(patient?.allergies) ? patient.allergies : [];
  const historyPayload = history
    ? {
        ...core,
        allergies: Array.from(new Set([...patientAllergies, ...(Array.isArray(core.allergies) ? core.allergies : [])])),
        id: history._id.toString(),
        patient_id: (history as { patient_id?: unknown }).patient_id?.toString?.() ?? String(patientId),
        created_at: (history as { created_at?: string | Date | null }).created_at ?? null,
        updated_at: (history as { updated_at?: string | Date | null }).updated_at ?? null,
      }
    : null;

  return NextResponse.json({
    consultation: { id: consultation._id.toString(), type: consultation.type ?? null, status: consultation.status ?? null },
    doctor: { id: doctorObjectId.toString(), specialty_code, specialization: (doctor as any)?.specialization ?? null, name: (doctor as any)?.name ?? null },
    patient: patient
      ? { id: patient._id.toString(), name: patient.name ?? null, phone: patient.phone ?? null, dob: patient.dob ?? null, gender: patient.gender ?? null }
      : null,
    history: historyPayload ?? { allergies: patientAllergies },
    allergy_status: patientAllergies.length || (Array.isArray(core.allergies) && core.allergies.length) ? "recorded" : "not_assessed",
    specialty_history: specialty?.data ?? null,
    latest_consultation: latestConsultation,
    recent,
  });
}

