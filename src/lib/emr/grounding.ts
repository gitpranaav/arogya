import type { EMROp, EMRSnapshot, EMRMedication, FieldProvenance, TranscriptSegment, GroundingFinding } from "./types";
import { medicationIndexById } from "./medicationIdentity";

export const GROUNDING_SCHEMA_VERSION = "grounding-v1";
const stop = new Set(["and", "the", "with", "a", "to", "is", "of", "or", "for", "by", "on", "at", "per", "patient", "day", "days", "oral"]);
function tokens(text: string): string[] {
  return (text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []).filter(t => (t.length >= 2 || /^\d+$/.test(t)) && !stop.has(t));
}
function claimTokens(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "number") return [String(value)];
  if (typeof value === "string") return tokens(value);
  if (Array.isArray(value)) return value.flatMap(claimTokens);
  if (typeof value === "object") return Object.entries(value as unknown as Record<string, unknown>)
    .filter(([k]) => !["id", "confidence", "icd10_code", "icd10_description"].includes(k))
    .flatMap(([, v]) => claimTokens(v));
  return [];
}
/** Conservative, explainable lexical check; NOT proof of clinical semantic correctness. */
export function evaluateClaim(value: unknown, segments: TranscriptSegment[]): "lexical_support" | "unverified" | "contradicted" {
  const spoken = segments.map(s => s.text).join(" ");
  const words = new Set(tokens(spoken));
  const claims = claimTokens(value);
  if (!claims.length || !spoken.trim()) return "unverified";
  const importantNumbers = claims.filter(t => /^\d+$/.test(t));
  if (importantNumbers.some(n => !words.has(n))) return "unverified";
  const lexical = claims.filter(t => !/^\d+$/.test(t));
  if (lexical.length && !lexical.some(t => words.has(t))) return "unverified";
  if (!lexical.length && !importantNumbers.every(n => words.has(n))) return "unverified";
  // Only reject strong negation of the quoted claim; otherwise fail conservatively to review.
  const mention = lexical.find(t => words.has(t)) ?? importantNumbers[0];
  if (mention) {
    const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const negation = new RegExp(`\\b(?:no|not|never|denies|without|ruled\\s+out|do\\s+not)\\b(?:\\W+\\w+){0,4}\\W+${escaped}\\b`, "i");
    if (negation.test(spoken)) return "contradicted";
  }
  return "lexical_support";
}
export function readProvenance(raw: unknown): Record<string, FieldProvenance> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, FieldProvenance>) };
}
export function applyProvenanceChanges(previous: unknown, changes: Array<{ path: string; origin: FieldProvenance["origin"]; evidence_segment_ids?: string[]; confidence?: FieldProvenance["confidence"]; grounding?: FieldProvenance["grounding"]; actor_id?: string; actor_role?: "doctor" | "receptionist" }>, timestamp = new Date().toISOString()): Record<string, FieldProvenance> {
  const result = readProvenance(previous);
  for (const change of changes) {
    result[change.path] = { origin: change.origin, evidence_segment_ids: change.evidence_segment_ids ?? [],
      confidence: change.confidence ?? null, grounding: change.grounding ?? "clinician_verified",
      reviewed: change.origin === "clinician_entry" || change.origin === "clinician_correction", updated_at: timestamp,
      ...(change.actor_id ? { actor_id: change.actor_id } : {}), ...(change.actor_role ? { actor_role: change.actor_role } : {}) };
  }
  return result;
}
function canonicalPath(path: string, snapshot: EMRSnapshot): string {
  const match = /^medications\[(\d+)\](.*)$/.exec(path);
  if (!match) return path;
  const id = snapshot.medications?.[Number(match[1])]?.id;
  return id ? `medications[id=${id}]${match[2]}` : path;
}
/** Returns safe proposed mutations and review-only findings. Evidence IDs MUST be checked before calling. */
export function groundDeltaOps(ops: EMROp[], segments: TranscriptSegment[], snapshot: EMRSnapshot): {
  operations: EMROp[]; findings: GroundingFinding[]; changes: Array<{ path: string; origin: "ai"; evidence_segment_ids: string[]; confidence?: FieldProvenance["confidence"]; grounding: "lexical_support" }>;
} {
  const byId = new Map(segments.map(s => [s.id, s]));
  const operations: EMROp[] = [], findings: GroundingFinding[] = [], changes = [] as Array<{ path: string; origin: "ai"; evidence_segment_ids: string[]; confidence?: FieldProvenance["confidence"]; grounding: "lexical_support" }>;
  for (const op of ops) {
    const evidenceIds = [...new Set(op.evidence_segment_ids ?? [])];
    const evidence = evidenceIds.map(id => byId.get(id)).filter((s): s is TranscriptSegment => Boolean(s));
    const path = canonicalPath(op.path, snapshot);
    if (op.op === "mark_uncertain") {
      operations.push(op);
      findings.push({ path, reason: "AI marked uncertain", evidence_segment_ids: evidenceIds });
      continue;
    }
    if (op.op === "retract_fact") {
      // Retracting a confirmed statement is unsafe without independent review.
      operations.push({ op: "mark_uncertain", path: op.path, evidence_segment_ids: evidenceIds });
      findings.push({ path, reason: "AI retraction requires clinician confirmation", evidence_segment_ids: evidenceIds });
      continue;
    }
    if (op.path === "medications" && Array.isArray(op.value)) {
      // Never replace the complete prescription from an AI array: retain omitted rows.
      for (const row of op.value) {
        const name = typeof row === "object" && row && "name" in row ? String((row as { name: unknown }).name) : "";
        const prior = (snapshot.medications ?? []).filter(m => m.name.trim().toLowerCase() === name.trim().toLowerCase());
        if (prior.length > 1) {
          findings.push({ path: "medications", reason: "Ambiguous duplicate medication identity", evidence_segment_ids: evidenceIds });
          operations.push({ op: "mark_uncertain", path: "medications", evidence_segment_ids: evidenceIds });
          continue;
        }
        const path = prior[0]?.id ? `medications[id=${prior[0].id}]` : "medications[+]";
        const result = groundDeltaOps([{ ...op, path, value: row }], segments, snapshot);
        operations.push(...result.operations);
        findings.push(...result.findings);
        changes.push(...result.changes);
      }
      continue;
    }
    if (["symptoms", "diagnosis_text", "lab_tests_ordered"].includes(op.path) && Array.isArray(op.value)) {
      const supported = op.value.filter((value, index) => {
        const verdict = evaluateClaim(value, evidence);
        if (verdict === "lexical_support") {
          changes.push({ path: `${op.path}[${index}]`, origin: "ai", evidence_segment_ids: evidenceIds,
            confidence: op.confidence, grounding: "lexical_support" });
          return true;
        }
        findings.push({ path: `${op.path}[${index}]`, evidence_segment_ids: evidenceIds,
          reason: verdict === "contradicted" ? "Potentially negated claim" : "List item lacks lexical support" });
        return false;
      });
      if (!supported.length) operations.push({ op: "mark_uncertain", path: op.path, evidence_segment_ids: evidenceIds });
      else operations.push({ ...op, value: supported });
      continue;
    }
    const medicationObject = /^medications\[(?:\+|\d+|id=med_[0-9a-f]{32})\]$/.test(op.path) &&
      op.value && typeof op.value === "object" && !Array.isArray(op.value);
    if (medicationObject) {
      const supported: Record<string, unknown> = {};
      for (const [field, val] of Object.entries(op.value as unknown as Record<string, unknown>)) {
        const result = evaluateClaim(val, evidence);
        if (result === "lexical_support") supported[field] = val;
        else findings.push({ path: `${path}.${field}`, reason: result === "contradicted" ? "Potentially negated claim" : "Medication field lacks lexical support", evidence_segment_ids: evidenceIds });
      }
      if (!Object.keys(supported).length || (op.path === "medications[+]" && !supported.name)) {
        operations.push({ op: "mark_uncertain", path: op.path, evidence_segment_ids: evidenceIds });
        continue;
      }
      operations.push({ ...op, value: supported });
      changes.push({ path, origin: "ai", evidence_segment_ids: evidenceIds, confidence: op.confidence, grounding: "lexical_support" });
      continue;
    }
    const grounding = evaluateClaim(op.value, evidence);
    if (grounding !== "lexical_support") {
      operations.push({ op: "mark_uncertain", path: op.path, evidence_segment_ids: evidenceIds });
      findings.push({ path, reason: grounding === "contradicted" ? "Potentially negated claim" : "Claim lacks lexical support; semantic verification required", evidence_segment_ids: evidenceIds });
      continue;
    }
    operations.push(op);
    changes.push({ path, origin: "ai", evidence_segment_ids: evidenceIds,
      confidence: "confidence" in op ? op.confidence : undefined, grounding });
  }
  return { operations, findings, changes };
}
/** Field granularity for manual patches and replacement snapshots, including stable medicine paths. */
export function changedClinicalFields(before: EMRSnapshot, after: EMRSnapshot): string[] {
  const paths: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "needs_confirmation") continue;
    if (key === "medications") {
      const old = new Map((before.medications ?? []).map(m => [m.id, m]));
      for (const med of after.medications ?? []) {
        for (const field of Object.keys(med)) {
          if (field === "id") continue;
          if (JSON.stringify(old.get(med.id)?.[field as keyof typeof med]) !== JSON.stringify(med[field as keyof typeof med])) paths.push(`medications[id=${med.id}].${field}`);
        }
      }
      for (const med of before.medications ?? []) if (!(after.medications ?? []).some(m => m.id === med.id)) paths.push(`medications[id=${med.id}]`);
    } else if (key === "vitals") {
      for (const f of new Set([...Object.keys(before.vitals ?? {}), ...Object.keys(after.vitals ?? {})])) {
        if (JSON.stringify((before.vitals as unknown as Record<string, unknown> | undefined)?.[f]) !== JSON.stringify((after.vitals as unknown as Record<string, unknown> | undefined)?.[f])) paths.push(`vitals.${f}`);
      }
    } else if (JSON.stringify(before[key as keyof EMRSnapshot]) !== JSON.stringify(after[key as keyof EMRSnapshot])) paths.push(key);
  }
  return paths;
}
export function protectClinicianPaths(before: EMRSnapshot, candidate: EMRSnapshot, provenance: unknown): EMRSnapshot {
  const next = structuredClone(candidate);
  for (const [path, entry] of Object.entries(readProvenance(provenance))) {
    if (!["clinician_entry", "clinician_correction", "staff_entry", "staff_correction"].includes(entry.origin)) continue;
    if (path.startsWith("medications[id=")) {
      const match = /^medications\[id=(med_[0-9a-f]{32})\](?:\.(\w+))?$/.exec(path);
      if (!match) continue;
      const original = before.medications?.find(m => m.id === match[1]);
      if (!original) continue;
      const idx = medicationIndexById(next, match[1]);
      if (idx < 0) { next.medications ??= []; next.medications.push({ ...original }); }
      else if (match[2]) (next.medications![idx] as unknown as Record<string, unknown>)[match[2]] = (original as unknown as Record<string, unknown>)[match[2]];
      else next.medications![idx] = { ...original };
      continue;
    }
    if (path.startsWith("vitals.")) {
      const field = path.slice(7); next.vitals ??= {};
      (next.vitals as unknown as Record<string, unknown>)[field] = (before.vitals as unknown as Record<string, unknown> | undefined)?.[field];
    } else if (Object.prototype.hasOwnProperty.call(before, path)) (next as unknown as Record<string, unknown>)[path] = (before as unknown as Record<string, unknown>)[path];
  }
  return next;
}

/** Ground full extraction against individual, persisted finalized transcript segments.
 * Missing evidence never authorizes a clinical update. Compatible with pre-ID rows.
 */
export function groundFinalSnapshot(candidate: EMRSnapshot, previous: EMRSnapshot,
  fieldEvidence: unknown, segments: TranscriptSegment[], priorProvenance: unknown): {
  snapshot: EMRSnapshot; provenance: Record<string, FieldProvenance>; findings: GroundingFinding[];
} {
  const references = fieldEvidence && typeof fieldEvidence === "object" && !Array.isArray(fieldEvidence)
    ? fieldEvidence as unknown as Record<string, unknown> : {};
  const byId = new Map(segments.filter(s => s.is_final !== false).map(s => [s.id, s]));
  const snapshot: EMRSnapshot = structuredClone(previous);
  const findings: GroundingFinding[] = [];
  const changes: Array<{ path: string; origin: "ai"; evidence_segment_ids: string[]; grounding: "lexical_support" }> = [];
  const evaluate = (path: string, sourcePath: string, value: unknown): boolean => {
    const rawIds = references[sourcePath];
    const ids = Array.isArray(rawIds) && rawIds.length && rawIds.length <= 30 && rawIds.every(id => typeof id === "string" && byId.has(id))
      ? [...new Set(rawIds as string[])] : [];
    const support = evaluateClaim(value, ids.map(id => byId.get(id)!));
    if (!ids.length || support !== "lexical_support") {
      findings.push({ path, evidence_segment_ids: ids,
        reason: !ids.length ? "Missing/invalid finalized transcript evidence" : support === "contradicted" ? "Potential negation/contradiction" : "Unsupported clinical claim; clinician verification required" });
      return false;
    }
    changes.push({ path, origin: "ai", evidence_segment_ids: ids, grounding: "lexical_support" });
    return true;
  };
  for (const key of Object.keys(candidate) as Array<keyof EMRSnapshot>) {
    if (key === "needs_confirmation") continue;
    if (key === "medications") {
      const existing = previous.medications ?? [];
      const out = [...existing];
      for (let i = 0; i < (candidate.medications ?? []).length; i++) {
        const row = candidate.medications![i];
        const match = row.id && existing.find(m => m.id === row.id);
        const id = row.id!;
        const canonical = `medications[id=${id}]`;
        const namePath = `medications[${i}].name`;
        if (!match && !evaluate(`${canonical}.name`, namePath, row.name)) continue;
        const merged: EMRMedication = { name: row.name, ...(match ?? {}), id };
        for (const [field, value] of Object.entries(row)) {
          // Only clinical prescription fields are evidence-bearing AI updates.
          // Normalization also supplies storage metadata (including undefined confidence).
          if (!["dosage", "frequency", "duration", "route", "instructions"].includes(field) || value == null || value === "") continue;
          if (evaluate(`${canonical}.${field}`, `medications[${i}].${field}`, value)) (merged as unknown as Record<string, unknown>)[field] = value;
        }
        if (match) {
          const at = out.findIndex(m => m.id === id);
          if (at >= 0) out[at] = merged;
        } else out.push(merged);
      }
      snapshot.medications = out;
    } else if (key === "vitals") {
      snapshot.vitals = { ...(previous.vitals ?? {}) };
      for (const [field, value] of Object.entries(candidate.vitals ?? {})) {
        if (value === null) continue;
        const path = `vitals.${field}`;
        if (evaluate(path, path, value)) (snapshot.vitals as unknown as Record<string, unknown>)[field] = value;
      }
    } else {
      const value = candidate[key];
      if (value === null || (Array.isArray(value) && !value.length)) continue;
      // Array values need evidence for each assertion, not just a common reference for the list.
      if (Array.isArray(value)) {
        const accepted = value.filter((item, index) => evaluate(`${key}[${index}]`, `${key}[${index}]`, item));
        if (accepted.length) (snapshot as unknown as Record<string, unknown>)[key] = [...new Set([...(Array.isArray(previous[key]) ? previous[key] as string[] : []), ...accepted])];
      } else if (evaluate(key, key, value)) (snapshot as unknown as Record<string, unknown>)[key] = value;
    }
  }
  const protectedSnapshot = protectClinicianPaths(previous, snapshot, priorProvenance);
  // Clinician-protected paths cannot acquire fresh AI provenance.
  const protectedPaths = readProvenance(priorProvenance);
  const acceptedChanges = changes.filter(c => !Object.entries(protectedPaths).some(([p, v]) =>
    (["clinician_entry", "clinician_correction", "staff_entry", "staff_correction"].includes(v.origin)) && (p === c.path || c.path.startsWith(`${p}.`) || c.path.startsWith(`${p}[`))));
  const provenance = applyProvenanceChanges(priorProvenance, acceptedChanges);
  const requested = new Set([...(previous.needs_confirmation ?? []), ...findings.map(f => f.path.replace(/^medications\[\+\]\..*$/, "medications[+]"))]);
  protectedSnapshot.needs_confirmation = [...requested].slice(0, 80);
  return { snapshot: protectedSnapshot, provenance, findings };
}
