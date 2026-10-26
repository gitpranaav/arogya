import type { EMRSnapshot, TranscriptSegment } from "../emr/types";

export const CONTEXT_VERSION = "compact-context-v1";
export const CONTEXT_LIMITS = Object.freeze({ deltaChars: 35000, finalChars: 58000, historyChars: 3200, tailChars: 1000 });

export type HistoricalEvidence = {
  consultation_id: string;
  date: string | null;
  kind: "prior_prescription" | "prior_emr" | "prior_transcript";
  source_id: string;
  value: unknown;
  evidence_segment_ids?: string[];
};

export type ClinicalContextInput = {
  snapshot: EMRSnapshot;
  allergies: string[];
  allergyStatus: "recorded" | "not_assessed" | "no_known_allergies";
  segments: TranscriptSegment[];
  priorTail?: TranscriptSegment[];
  history?: HistoricalEvidence[];
  mode: "delta" | "final";
};

export class ContextBudgetError extends Error {
  constructor(readonly size: number, readonly limit: number) { super("Clinical evidence exceeds model context budget; manual review or smaller evidence batches required"); }
}

/** Counts JSON UTF-16 characters, a deterministic conservative input-size guard, NOT exact tokenizer counts. */
export function buildClinicalContext(input: ClinicalContextInput) {
  const snapshot = input.snapshot;
  const facts = {
    vitals: snapshot.vitals,
    chief_complaint: snapshot.chief_complaint,
    symptoms: snapshot.symptoms,
    diagnosis_text: snapshot.diagnosis_text,
    history_of_present_illness: snapshot.history_of_present_illness,
    physical_examination: snapshot.physical_examination,
    assessment: snapshot.assessment,
    plan: snapshot.plan,
    lab_tests_ordered: snapshot.lab_tests_ordered,
    // Stable row identities are essential for delta updates; omit derived ICD and summaries.
    medications: snapshot.medications?.map(m => ({ id: m.id, name: m.name, dosage: m.dosage, frequency: m.frequency,
      duration: m.duration, route: m.route, instructions: m.instructions })),
  };
  const compactFacts = Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined && v !== null && (!Array.isArray(v) || v.length)));
  const tail = (input.priorTail ?? []).slice(-3).map(s => ({ id: s.id, text: s.text })).filter(s => s.text);
  while (JSON.stringify(tail).length > CONTEXT_LIMITS.tailChars && tail.length) tail.shift();
  const history: HistoricalEvidence[] = [];
  for (const item of (input.history ?? []).slice(0, 6)) {
    if (JSON.stringify([...history, item]).length > CONTEXT_LIMITS.historyChars) break;
    history.push(item);
  }
  const payload = {
    context_version: CONTEXT_VERSION,
    mode: input.mode,
    patient_allergy_status: input.allergyStatus,
    patient_allergies: input.allergies,
    emr_facts: compactFacts,
    prior_finalized_tail: input.mode === "delta" ? tail : [],
    historical_evidence_unverified_for_current_visit: history,
    ...(input.mode === "delta" ? { segments_delta: input.segments.map(s => ({ id: s.id, text: s.text, confidence: s.confidence ?? null })) }
      : { transcript_segments: input.segments.map(s => ({ id: s.id, text: s.text })) }),
  };
  const json = JSON.stringify(payload);
  const limit = input.mode === "delta" ? CONTEXT_LIMITS.deltaChars : CONTEXT_LIMITS.finalChars;
  if (json.length > limit) throw new ContextBudgetError(json.length, limit);
  return { payload, json, chars: json.length, estimatedTokens: Math.ceil(json.length / 4), limit };
}
