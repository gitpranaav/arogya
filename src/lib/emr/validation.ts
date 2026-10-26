import { MEDICATION_ID_PATTERN } from "./medicationIdentity";
import type { EMROp, EMRSnapshot } from "./types";
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

const textFields = new Set(["chief_complaint", "clinical_summary", "patient_summary", "history_of_present_illness", "physical_examination", "assessment", "plan"]);
const arrayFields = new Set(["symptoms", "diagnosis_text", "lab_tests_ordered"]);
const vitals = new Set(["bp_systolic", "bp_diastolic", "pulse_rate", "heart_rate", "respiratory_rate", "temperature", "spo2", "height", "weight"]);
const medFields = new Set(["name", "dosage", "frequency", "duration", "route", "instructions"]);
const storedMedFields = new Set([...medFields, "icd10_code", "icd10_description", "confidence", "id"]);
const maximumItems = 40;
const medIdPath = /^medications\[id=(med_[0-9a-f]{32})\](?:\.([a-z_]+))?$/;
export function validFactPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 90) return false;
  if (textFields.has(path) || arrayFields.has(path) || path === "medications") return true;
  if (path === "medications[+]") return true;
  const byId = medIdPath.exec(path);
  if (byId) return !byId[2] || medFields.has(byId[2]);
  if (path.startsWith("vitals.")) return vitals.has(path.slice(7));
  const m = /^medications\[(\d+)\](?:\.([a-z_]+))?$/.exec(path);
  return Boolean(m && Number(m[1]) < maximumItems && (!m[2] || medFields.has(m[2])));
}
function validText(v: unknown): boolean { return (typeof v === "string" && v.length <= 8000) || v === null; }
function validList(v: unknown): boolean { return Array.isArray(v) && v.length <= maximumItems && v.every(x => typeof x === "string" && x.length <= 500); }
function validMedication(v: unknown, stored = false): boolean {
  return isPlainObject(v) && Object.keys(v).length <= 10 && Object.entries(v).every(([k, value]) => (stored ? storedMedFields : medFields).has(k) && (k === "id" ? typeof value === "string" && MEDICATION_ID_PATTERN.test(value) : k === "confidence" ? ["high", "medium", "low", null, undefined].includes(value as any) : validText(value) && (value === null || String(value).length <= 1000)));
}
export function validFactValue(path: string, value: unknown): boolean {
  if (textFields.has(path)) return validText(value);
  if (arrayFields.has(path)) return validList(value);
  if (path.startsWith("vitals.")) return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10000);
  if (path === "medications") return Array.isArray(value) && value.length <= maximumItems && value.every(item => validMedication(item));
  if (path === "medications[+]" || /^medications\[\d+\]$/.test(path) || (medIdPath.test(path) && !medIdPath.exec(path)?.[2])) return validMedication(value);
  if (/^medications\[\d+\]\.[a-z_]+$/.test(path) || (medIdPath.test(path) && Boolean(medIdPath.exec(path)?.[2]))) return validText(value) && (value === null || String(value).length <= 1000);
  return false;
}
export function validateEMROperations(raw: unknown, segmentIds: Set<string>): EMROp[] {
  if (!Array.isArray(raw) || raw.length > 80) throw new Error("Invalid AI operations count");
  return raw.map((item: unknown) => {
    if (!isPlainObject(item) || !["set_fact", "update_fact", "retract_fact", "mark_uncertain"].includes(String(item.op))) throw new Error("Invalid AI operation");
    if (!validFactPath(item.path)) throw new Error(`Invalid AI field path`);
    if (!Array.isArray(item.evidence_segment_ids) || !item.evidence_segment_ids.length || !item.evidence_segment_ids.every((id: unknown) => typeof id === "string" && segmentIds.has(id))) {
      throw new Error("AI operation without valid segment evidence");
    }
    if ((item.op === "set_fact" || item.op === "update_fact") && !validFactValue(item.path, item.value)) throw new Error("Invalid AI field value");
    if ((item.op === "set_fact" || item.op === "update_fact") && (item.path === "medications" || item.path.startsWith("medications[")) && typeof item.value === "object" && item.value !== null && JSON.stringify(item.value).includes('"id"')) throw new Error("Invalid AI medication identity");
    return item as EMROp;
  });
}
export function sanitizeSnapshot(value: unknown): EMRSnapshot {
  if (!isPlainObject(value)) throw new Error("Invalid EMR snapshot");
  const next: Record<string, unknown> = {};
  if (Object.keys(value).length > 25) throw new Error("Invalid EMR field count");
  for (const [key, v] of Object.entries(value)) {
    if (key === "vitals") {
      if (!isPlainObject(v) || Object.entries(v).some(([k, n]) => !vitals.has(k) || !(n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 10000)))) throw new Error("Invalid vitals");
    } else if (key === "needs_confirmation") {
      if (!Array.isArray(v) || v.length > 80 || v.some(x => !validFactPath(x) && !/^(?:symptoms|diagnosis_text|lab_tests_ordered)\[(?:[0-9]|[1-3][0-9])\]$/.test(x))) throw new Error("Invalid confirmation paths");
    } else if (key === "medications") {
      if (!Array.isArray(v) || v.length > maximumItems || !v.every(x => validMedication(x, true)) || new Set(v.map(x => x.id).filter(Boolean)).size !== v.filter(x => x.id).length) throw new Error("Invalid medications");
    } else if (key === "diagnosis_icd") {
      if (!Array.isArray(v) || v.length > maximumItems || v.some(x =>
        !isPlainObject(x) || Object.entries(x).some(([field, val]) => {
          if (field === "confidence") return !["high", "medium", "low", null, undefined].includes(val as any);
          if (!["diagnosis", "icd10_code", "icd10_description"].includes(field)) return true;
          const maxLength = field === "icd10_code" ? 50 : 1000;
          return !(val === null || (typeof val === "string" && val.length <= maxLength));
        }))) throw new Error("Invalid diagnosis codes");
    } else if (!validFactPath(key) || !validFactValue(key, v)) throw new Error(`Invalid snapshot field: ${key}`);
    next[key] = v;
  }
  return next as EMRSnapshot;
}
