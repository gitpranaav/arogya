/** Patient-scoped family graph. No relative is linked to another patient account. */
import { randomUUID } from "crypto";

export const FAMILY_GRAPH_SCHEMA = 1;
export type Relation = "mother" | "father" | "sibling" | "child" | "grandmother" | "grandfather" | "unknown";
export type Lineage = "maternal" | "paternal" | "unknown";
export type ReviewStatus = "proposed" | "confirmed" | "rejected";
export type EvidenceOrigin = "ai_extracted" | "patient_reported" | "clinician_entry" | "clinician_correction";
export type Relative = { id: string; relative_to: string; relation: Relation; lineage: Lineage; label: string; status: ReviewStatus; origin: EvidenceOrigin; evidence_segment_ids: string[]; updated_at: string };
export type FamilyAssertion = { id: string; relative_id: string; condition: string; status: ReviewStatus; origin: EvidenceOrigin; confidence: "high" | "medium" | "low" | "unknown"; evidence_segment_ids: string[]; consultation_id?: string; updated_at: string };
export type FamilyGraph = { schema_version: number; version: number; relatives: Relative[]; assertions: FamilyAssertion[]; updated_at?: string };
export type FamilyAction =
  | { action: "add_relative"; relative_to: string; relation: Relation; lineage?: Lineage; label?: string }
  | { action: "edit_relative"; id: string; relative_to?: string; relation?: Relation; lineage?: Lineage; label?: string }
  | { action: "remove_relative"; id: string }
  | { action: "review_relative"; id: string; decision: "confirmed" | "rejected" }
  | { action: "add_condition"; relative_id: string; condition: string; evidence_source?: "patient_reported" | "clinician_entry"; confidence?: FamilyAssertion["confidence"] }
  | { action: "edit_condition"; id: string; condition: string }
  | { action: "remove_condition"; id: string }
  | { action: "review_condition"; id: string; decision: "confirmed" | "rejected" };

const relations = new Set<Relation>(["mother", "father", "sibling", "child", "grandmother", "grandfather", "unknown"]);
const lineages = new Set<Lineage>(["maternal", "paternal", "unknown"]);
export function blankGraph(): FamilyGraph { return { schema_version: FAMILY_GRAPH_SCHEMA, version: 0, relatives: [], assertions: [] }; }
export function graphFromRecord(doc: unknown): FamilyGraph {
  if (!doc || typeof doc !== "object") return blankGraph();
  const d = doc as Record<string, unknown>;
  return { schema_version: FAMILY_GRAPH_SCHEMA, version: Number.isSafeInteger(d.version) && Number(d.version) >= 0 ? Number(d.version) : 0,
    relatives: Array.isArray(d.relatives) ? d.relatives as Relative[] : [], assertions: Array.isArray(d.assertions) ? d.assertions as FamilyAssertion[] : [],
    updated_at: typeof d.updated_at === "string" ? d.updated_at : undefined };
}
export class GraphValidationError extends Error { constructor(message: string) { super(message); this.name = "GraphValidationError"; } }
function fail(message: string): never { throw new GraphValidationError(message); }
function trimmed(value: unknown, max: number, required = true): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) fail("Invalid or oversized text");
  return value.trim();
}
function ensureValid(graph: FamilyGraph): void {
  if (graph.relatives.length > 64 || graph.assertions.length > 128) fail("Family graph limit exceeded");
  const lookup = new Map(graph.relatives.map(r => [r.id, r]));
  if (lookup.size !== graph.relatives.length) fail("Duplicate relative ID");
  for (const r of graph.relatives) {
    if (!relations.has(r.relation) || !lineages.has(r.lineage) || (r.relative_to !== "patient" && !lookup.has(r.relative_to)) || r.relative_to === r.id) fail("Invalid family relationship");
    if (["sibling", "child", "unknown"].includes(r.relation) && !r.label && r.origin !== "ai_extracted") fail("A label is required to distinguish relatives");
    if (r.relation === "grandmother" || r.relation === "grandfather") {
      if (r.relative_to === "patient" && r.lineage === "unknown") fail("Specify maternal or paternal grandparent lineage");
    }
    const seen = new Set<string>([r.id]);
    let cursor = r.relative_to;
    while (cursor !== "patient") {
      if (seen.has(cursor)) fail("Family relationship cycle");
      seen.add(cursor);
      cursor = lookup.get(cursor)?.relative_to ?? "patient";
    }
  }
  // Unique parent slots, unique named relatives under each direct relationship.
  for (let i = 0; i < graph.relatives.length; i++) {
    for (const other of graph.relatives.slice(i + 1)) {
      const r = graph.relatives[i];
      if (r.relative_to !== other.relative_to || r.relation !== other.relation || r.lineage !== other.lineage || r.status === "rejected" || other.status === "rejected") continue;
      if (["mother", "father"].includes(r.relation) || (r.label && other.label && r.label.toLowerCase() === other.label.toLowerCase())) fail("Duplicate family relationship");
    }
  }
  const assertionIds = new Set<string>();
  for (const a of graph.assertions) {
    if (assertionIds.has(a.id) || !lookup.has(a.relative_id)) fail("Invalid condition link");
    assertionIds.add(a.id);
  }
}
export function applyFamilyAction(graph: FamilyGraph, action: FamilyAction, now = new Date().toISOString()): FamilyGraph {
  const next: FamilyGraph = { ...graph, relatives: graph.relatives.map(r => ({ ...r, evidence_segment_ids: [...r.evidence_segment_ids] })),
    assertions: graph.assertions.map(a => ({ ...a, evidence_segment_ids: [...a.evidence_segment_ids] })), updated_at: now };
  if (!action || typeof action !== "object") fail("Invalid action");
  const getRelative = (id: string) => next.relatives.find(r => r.id === id) ?? fail("Relative not found");
  const getAssertion = (id: string) => next.assertions.find(a => a.id === id) ?? fail("Condition not found");
  switch (action.action) {
    case "add_relative":
      if (["sibling", "child", "unknown"].includes(action.relation) && !action.label?.trim()) fail("A label is required to distinguish relatives");
      next.relatives.push({ id: `rel_${randomUUID()}`, relative_to: trimmed(action.relative_to, 50), relation: action.relation,
        lineage: action.lineage ?? "unknown", label: trimmed(action.label ?? "", 90, false), status: "confirmed", origin: "clinician_entry", evidence_segment_ids: [], updated_at: now }); break;
    case "edit_relative": {
      const r = getRelative(action.id);
      if (action.relative_to !== undefined) r.relative_to = trimmed(action.relative_to, 50);
      if (action.relation !== undefined) r.relation = action.relation;
      if (action.lineage !== undefined) r.lineage = action.lineage;
      if (action.label !== undefined) r.label = trimmed(action.label, 90, false);
      r.status = "confirmed"; r.origin = "clinician_correction"; r.updated_at = now; break;
    }
    case "remove_relative": {
      getRelative(action.id);
      // Reject removal of a parent node while it has dependent relatives.
      if (next.relatives.some(r => r.relative_to === action.id)) fail("Remove dependent relatives first");
      next.relatives = next.relatives.filter(r => r.id !== action.id);
      next.assertions = next.assertions.filter(a => a.relative_id !== action.id); break;
    }
    case "review_relative": {
      if (!["confirmed", "rejected"].includes(action.decision)) fail("Invalid review decision");
      const r = getRelative(action.id);
      if (r.status !== "proposed") fail("Only proposals can be reviewed");
      r.status = action.decision; r.updated_at = now; break;
    }
    case "add_condition": {
      const r = getRelative(action.relative_id);
      if (r.status === "rejected") fail("Cannot attach to rejected relative");
      const condition = trimmed(action.condition, 180);
      if (action.evidence_source !== undefined && !["patient_reported", "clinician_entry"].includes(action.evidence_source)) fail("Invalid evidence origin");
      if (action.confidence !== undefined && !["high", "medium", "low", "unknown"].includes(action.confidence)) fail("Invalid confidence");
      if (next.assertions.some(a => a.relative_id === r.id && a.condition.toLowerCase() === condition.toLowerCase() && a.status !== "rejected")) fail("Duplicate condition assertion");
      next.assertions.push({ id: `cond_${randomUUID()}`, relative_id: r.id, condition, status: "confirmed", origin: action.evidence_source ?? "clinician_entry",
        confidence: action.confidence ?? "unknown", evidence_segment_ids: [], updated_at: now }); break;
    }
    case "edit_condition": { const a = getAssertion(action.id); if (getRelative(a.relative_id).status === "rejected") fail("Relative has been rejected"); a.condition = trimmed(action.condition, 180); a.status = "confirmed"; a.origin = "clinician_correction"; a.updated_at = now; break; }
    case "remove_condition": getAssertion(action.id); next.assertions = next.assertions.filter(a => a.id !== action.id); break;
    case "review_condition": { if (!["confirmed", "rejected"].includes(action.decision)) fail("Invalid review decision"); const a = getAssertion(action.id); if (a.status !== "proposed") fail("Only proposals can be reviewed");
      if (action.decision === "confirmed" && getRelative(a.relative_id).status !== "confirmed") fail("Confirm relative before its condition"); a.status = action.decision; a.updated_at = now; break; }
    default: fail("Unknown family action");
  }
  ensureValid(next);
  next.version = graph.version + 1;
  return next;
}

/** Depth-limited relative traversal; never queries or links external patient identities. */
export function traverseFamily(graph: FamilyGraph, start = "patient", maxDepth = 3) {
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 4) fail("Invalid traversal depth");
  const visited = new Set([start]);
  const selected: Relative[] = [];
  let frontier = [start];
  for (let depth = 0; depth < maxDepth; depth++) {
    const next: string[] = [];
    for (const id of frontier) for (const relative of graph.relatives) {
      if (relative.relative_to === id && !visited.has(relative.id) && relative.status !== "rejected") {
        visited.add(relative.id); selected.push(relative); next.push(relative.id);
      }
    }
    frontier = next;
  }
  return { relatives: selected, assertions: graph.assertions.filter(a => visited.has(a.relative_id) && a.status !== "rejected") };
}
