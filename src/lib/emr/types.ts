import type { ObjectId } from "mongodb";

export type Confidence = "high" | "medium" | "low";

export type EMRVitals = {
  bp_systolic?: number | null;
  bp_diastolic?: number | null;
  pulse_rate?: number | null;
  heart_rate?: number | null;
  respiratory_rate?: number | null;
  temperature?: number | null;
  spo2?: number | null;
  weight?: number | null;
  height?: number | null;
};

export type EMRMedication = {
  /** Stable server-owned row identity; optional on historical records. */
  id?: string;
  name: string;
  dosage?: string | null;
  frequency?: string | null;
  duration?: string | null;
  route?: string | null;
  instructions?: string | null;
  /** Indication / billing ICD-10 mapped from local DB search */
  icd10_code?: string | null;
  icd10_description?: string | null;
  confidence?: Confidence;
};

export type EMRDiagnosisIcd = {
  diagnosis: string;
  icd10_code?: string | null;
  icd10_description?: string | null;
  confidence?: Confidence;
};

export type EMRSnapshot = {
  vitals?: EMRVitals;
  chief_complaint?: string | null;
  symptoms?: string[];
  diagnosis_text?: string[];
  diagnosis_icd?: EMRDiagnosisIcd[];
  medications?: EMRMedication[];
  lab_tests_ordered?: string[];
  history_of_present_illness?: string | null;
  physical_examination?: string | null;
  assessment?: string | null;
  plan?: string | null;
  clinical_summary?: string | null;
  patient_summary?: string | null;
  needs_confirmation?: string[];
};

export type EMROp =
  | { op: "set_fact"; path: string; value: unknown; confidence?: Confidence; evidence_segment_ids?: string[] }
  | { op: "update_fact"; path: string; value: unknown; confidence?: Confidence; evidence_segment_ids?: string[] }
  | { op: "retract_fact"; path: string; evidence_segment_ids?: string[] }
  | { op: "mark_uncertain"; path: string; note?: string; evidence_segment_ids?: string[] };

export type ExtractionCursor = {
  last_final_segment_id?: string | null;
  last_final_index?: number | null;
};

export type TranscriptSegment = {
  id: string;
  text: string;
  confidence?: number;
  is_final?: boolean;
  start_ms?: number;
  end_ms?: number;
  sequence?: number;
  language?: string | null;
  timestamp?: string;
  speaker?: string;
};

export type FieldProvenance = {
  origin: "ai" | "clinician_entry" | "clinician_correction" | "staff_entry" | "staff_correction" | "legacy_unknown";
  evidence_segment_ids: string[];
  confidence: Confidence | null;
  grounding: "lexical_support" | "unverified" | "contradicted" | "clinician_verified";
  reviewed: boolean;
  updated_at: string;
  actor_id?: string;
  actor_role?: "doctor" | "receptionist";
};
export type GroundingFinding = { path: string; reason: string; evidence_segment_ids: string[] };

export type EMREntryDoc = {
  _id: ObjectId;
  consultation_id: ObjectId;
  snapshot?: EMRSnapshot;
  extraction_cursor?: ExtractionCursor;
  provenance?: Record<string, FieldProvenance>;
  grounding_findings?: GroundingFinding[];
  requires_review?: boolean;
  created_at: string;
  updated_at: string;
};

