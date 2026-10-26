import { ObjectId } from "mongodb";

import { getDb } from "@/src/lib/mongodb/client";

export function asObjectId(value: string) {
  return new ObjectId(value);
}

export async function getUserByEmail(email: string) {
  const db = await getDb();
  return db.collection("users").findOne({ email: email.toLowerCase() });
}

export async function getUserById(id: string) {
  const db = await getDb();
  return db.collection("users").findOne({ _id: asObjectId(id) });
}

export async function createPatient(payload: Record<string, unknown>) {
  const db = await getDb();
  const result = await db.collection("patients").insertOne({
    ...payload,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return result.insertedId.toString();
}

/** Intake is not permission to alter another practice's clinical history. */
export async function registerPatientForPractice(payload: {
  phone: string; name: string; dob?: string | null; gender?: string | null;
  blood_group?: string | null; allergies?: string[]; chronic_conditions?: string[]; address?: string | null;
}, doctorId: string): Promise<{ id?: string; conflict?: boolean }> {
  const db = await getDb();
  const phone = payload.phone.trim();
  const existing = await db.collection("patients").findOne({ phone });
  if (existing) {
    const link = await db.collection("patient_doctors").findOne({ patient_id: existing._id, doctor_id: asObjectId(doctorId) });
    if (!link) return { conflict: true };
    // This is a lookup for an existing linked patient, NEVER a clinical history update.
    return { id: existing._id.toString() };
  }
  // Create the patient and practice association atomically. An orphaned patient
  // must never claim the globally unique phone number after a partial failure.
  const mongoSession = db.client.startSession();
  try {
    const patientId = new ObjectId();
    await mongoSession.withTransaction(async () => {
      const now = new Date().toISOString();
      await db.collection("patients").insertOne({ _id: patientId, ...payload, phone,
        allergies: payload.allergies ?? [], chronic_conditions: payload.chronic_conditions ?? [],
        created_at: now, updated_at: now }, { session: mongoSession });
      await db.collection("patient_doctors").insertOne({ patient_id: patientId,
        doctor_id: asObjectId(doctorId), created_at: now }, { session: mongoSession });
    });
    return { id: patientId.toString() };
  } catch (err: any) {
    if (err?.code === 11000) return { conflict: true }; // concurrent registration
    throw err;
  } finally { await mongoSession.endSession(); }
}

export async function ensurePatientDoctorLink(patientId: string, doctorId: string) {
  const db = await getDb();
  await db.collection("patient_doctors").updateOne(
    { patient_id: asObjectId(patientId), doctor_id: asObjectId(doctorId) },
    { $setOnInsert: { patient_id: asObjectId(patientId), doctor_id: asObjectId(doctorId), created_at: new Date().toISOString() } },
    { upsert: true }
  );
}
