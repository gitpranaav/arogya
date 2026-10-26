/** DB-facing adapter; shared policy remains in the browser-safe allergySafety module. */
import type { Db, ObjectId } from "mongodb";
import type { EMRSnapshot } from "@/src/lib/emr/types";
import { ALLERGY_RULESET_VERSION, evaluatePrescriptionSafety } from "./allergySafety";

export async function screenPrescription(db: Db, patientId: ObjectId, snapshot: EMRSnapshot) {
  const [patient, history] = await Promise.all([
    db.collection("patients").findOne({ _id: patientId }, { projection: { allergies: 1 } }),
    db.collection("patient_history").findOne({ patient_id: patientId }, { projection: { "core.allergies": 1 } }),
  ]);
  const allergies = Array.from(new Set([
    ...(Array.isArray(patient?.allergies) ? patient.allergies : []),
    ...(Array.isArray(history?.core?.allergies) ? history.core.allergies : []),
  ].filter((x): x is string => typeof x === "string" && x.trim().length > 0).map(x => x.trim())));
  const issues = evaluatePrescriptionSafety(allergies, snapshot.medications ?? []);
  return { allergies, issues, rule_version: ALLERGY_RULESET_VERSION };
}
