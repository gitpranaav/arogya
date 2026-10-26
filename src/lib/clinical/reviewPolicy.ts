/** Stage 8 clinical sign-off rules. Deterministic checks, not clinical validation. */
import { createHash } from "node:crypto";
import type { EMRSnapshot } from "@/src/lib/emr/types";

export type ReviewBlocker = { code: string; path: string; message: string };
export type ReviewStatus = "Pending Review" | "Requires Correction" | "Ready for Sign-Off" | "Completed";

const present = (value: unknown) => typeof value === "string" && value.trim().length > 0;

export function prescriptionFieldProblems(snapshot: EMRSnapshot): ReviewBlocker[] {
  const problems: ReviewBlocker[] = [];
  (snapshot.medications ?? []).forEach((med, index) => {
    if (!present(med.name)) {
      // An empty draft is not a prescription; a partially filled row is an error.
      if (Object.entries(med).some(([key, value]) => key !== "id" && present(value))) problems.push({ code: "medication_name", path: `medications[${index}].name`, message: `Medication ${index + 1}: enter a name or remove the draft` });
      return;
    }
    for (const field of ["dosage", "frequency", "duration"] as const) {
      if (!present(med[field])) problems.push({ code: `medication_${field}`, path: `medications[${index}].${field}`, message: `${med.name}: ${field} must be verified before issuing a prescription` });
    }
  });
  return problems;
}

/** Includes medication and provenance state, preventing changed-content sign-off reuse. */
export function reviewedSnapshotFingerprint(snapshot: EMRSnapshot, provenance: unknown, findings: unknown): string {
  return createHash("sha256").update(JSON.stringify({ snapshot, provenance, findings })).digest("hex");
}

export function reviewStatus(options: { completed?: boolean; reviewed?: boolean; blockers: ReviewBlocker[] }): ReviewStatus {
  if (options.completed) return "Completed";
  if (options.blockers.length) return "Requires Correction";
  return options.reviewed ? "Ready for Sign-Off" : "Pending Review";
}

export function transcriptBlockers(transcript: { processing_status?: string; raw_text?: string } | null,
    expectedHash?: string | null): ReviewBlocker[] {
  if (!transcript || transcript.processing_status !== "completed" || !expectedHash ||
      createHash("sha256").update(String(transcript.raw_text ?? "").trim()).digest("hex") !== expectedHash)
    return [{ code: "final_transcript", path: "transcript", message: "Finish transcription and final AI extraction before review" }];
  return [];
}

export function familyProposalBlockers(graph: { relatives?: Array<{ status?: string }>; assertions?: Array<{ status?: string }> } | null): ReviewBlocker[] {
  const count = (graph?.relatives ?? []).filter(x => x.status === "proposed").length +
    (graph?.assertions ?? []).filter(x => x.status === "proposed").length;
  return count ? [{ code: "family_proposals", path: "family_history", message: `${count} family-history proposal(s) require clinician review or rejection` }] : [];
}
