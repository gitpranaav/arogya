import type { EMRMedication } from "@/src/lib/emr/types";
import { evaluatePrescriptionSafety } from "./allergySafety";

/** Backwards-compatible warning strings; details/IDs are available via evaluatePrescriptionSafety.
 * All results are clinical decision-support prompts, not diagnoses or approved rules. */
export function findAllergyMedicationWarnings(allergies: string[], medications: EMRMedication[]): string[] {
  return evaluatePrescriptionSafety(allergies, medications).map(issue => issue.message);
}
