import { MEDICATION_ID_PATTERN } from "./medicationIdentity";
import type { EMRMedication } from "@/src/lib/emr/types";

function str(v: unknown): string {
  return v == null ? "" : String(v).trim();
}

/** Normalize LLM / legacy shapes into EMRMedication. */
export function normalizeMedicationEntry(raw: unknown): EMRMedication {
  if (raw == null) {
    return { name: "", dosage: "", frequency: "", duration: "", route: "", instructions: "", icd10_code: "", icd10_description: "" };
  }
  if (typeof raw === "string") {
    return { name: raw.trim(), dosage: "", frequency: "", duration: "", route: "", instructions: "", icd10_code: "", icd10_description: "" };
  }
  if (typeof raw !== "object") {
    return { name: "", dosage: "", frequency: "", duration: "", route: "", instructions: "", icd10_code: "", icd10_description: "" };
  }
  const o = raw as Record<string, unknown>;
  const name = str(o.name ?? o.drug ?? o.medication ?? o.drug_name ?? o.medicine);
  return {
    ...(typeof o.id === "string" && MEDICATION_ID_PATTERN.test(o.id) ? { id: o.id } : {}),
    name,
    dosage: str(o.dosage ?? o.dose ?? o.strength ?? o.dosage_strength) || null,
    frequency: str(o.frequency ?? o.freq ?? o.dosing_frequency ?? o.how_often) || null,
    duration: str(o.duration ?? o.days ?? o.course ?? o.length_of_therapy) || null,
    route: str(o.route ?? o.route_of_administration ?? o.ROA) || null,
    instructions: str(o.instructions ?? o.sig ?? o.notes ?? o.patient_instructions) || null,
    icd10_code: str(o.icd10_code ?? o.icd_code) || null,
    icd10_description: str(o.icd10_description ?? o.icd_description) || null,
    confidence: o.confidence === "high" || o.confidence === "medium" || o.confidence === "low" ? o.confidence : undefined,
  };
}

export function normalizeMedicationsArray(raw: unknown): EMRMedication[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeMedicationEntry).filter((m) => m.name.trim().length > 0);
}
