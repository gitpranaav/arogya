import { createHash } from "crypto";
import type { TranscriptSegment } from "@/src/lib/emr/types";
import { graphFromRecord, type FamilyGraph, type FamilyAssertion, type Relation, type Lineage } from "./graph";

export type FamilyProposal = { relation: Relation; lineage?: Lineage; condition: string; confidence?: "high" | "medium" | "low"; evidence_segment_ids: string[] };
const labels: Partial<Record<Relation, RegExp>> = {
  mother: /\b(mother|mom|mum|mummy)\b/i, father: /\b(father|dad|daddy)\b/i,
  sibling: /\b(sister|brother|sibling)\b/i, child: /\b(daughter|son|child)\b/i,
  grandmother: /\b(grandmother|grandma|nani|dadi)\b/i, grandfather: /\b(grandfather|grandpa|nana|dada)\b/i,
};
const ambiguity = /\b(maybe|perhaps|possibly|might|suspected|unsure|unknown|family member|if|rule out|ruling out)\b/i;
const negation = /\b(no|not|never|doesn't|does not|didn't|did not|without|denies|negative for|free of)\b/i;
const idFor = (prefix: string, text: string) => `${prefix}_${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
const normalized = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Only directly cited, unambiguous positive family statements become draft assertions.
 *  Conservative lexical validation is not semantic or clinical confirmation. */
export function prepareFamilyProposals(input: unknown, segments: TranscriptSegment[]): FamilyProposal[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > 12) return [];
  const segmentMap = new Map(segments.filter(s => s.is_final !== false).map(s => [s.id, s.text]));
  const candidates: FamilyProposal[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const p = raw as Partial<FamilyProposal>;
    if (!p.relation || !labels[p.relation] || typeof p.condition !== "string" || p.condition.trim().length < 3 || p.condition.length > 100) continue;
    if (!Array.isArray(p.evidence_segment_ids) || !p.evidence_segment_ids.length || p.evidence_segment_ids.length > 8 ||
      p.evidence_segment_ids.some(id => typeof id !== "string" || !segmentMap.has(id))) continue;
    const text = p.evidence_segment_ids.map(id => segmentMap.get(id)).join(" ");
    if (!labels[p.relation]?.test(text) || !normalized(text).includes(normalized(p.condition)) || ambiguity.test(text) || negation.test(text)) continue;
    if ((p.relation === "grandmother" || p.relation === "grandfather") &&
      !((p.lineage === "maternal" && /\b(maternal|mother.s side|nani|nana)\b/i.test(text)) ||
        (p.lineage === "paternal" && /\b(paternal|father.s side|dadi|dada)\b/i.test(text)))) continue;
    // Do not infer relative labels/identity or turn historical family facts into patient diagnoses.
    candidates.push({ relation: p.relation, lineage: p.lineage ?? "unknown", condition: p.condition.trim(),
      confidence: p.confidence === "high" || p.confidence === "medium" ? p.confidence : "low", evidence_segment_ids: [...new Set(p.evidence_segment_ids)] });
  }
  return candidates;
}

/** Deterministic proposal identities make duplicate Groq batches harmless. */
export function mergeFamilyProposals(graphValue: unknown, proposals: FamilyProposal[], consultationId: string, now = new Date().toISOString()): FamilyGraph {
  const graph = graphFromRecord(graphValue);
  if (!proposals.length) return graph;
  const relatives = [...graph.relatives];
  const assertions = [...graph.assertions];
  let changed = false;
  for (const p of proposals) {
    const lineage = p.lineage ?? "unknown";
    // An unnamed sibling/child cannot be identified as an existing family member from relation alone.
    const distinctByEvidence = p.relation === "sibling" || p.relation === "child";
    const id = idFor("rel", [consultationId, p.relation, lineage,
      ...(distinctByEvidence ? p.evidence_segment_ids : [])].join(":"));
    let relative = distinctByEvidence
      ? relatives.find(r => r.id === id && r.status !== "rejected")
      : relatives.find(r => r.relative_to === "patient" && r.relation === p.relation && r.lineage === lineage && r.status !== "rejected");
    if (!relative) {
      if (relatives.length >= 64) break;
      // A rejected relationship may not be silently recreated by a later AI batch.
      if (relatives.some(r => r.id === id)) continue;
      relative = { id, relative_to: "patient", relation: p.relation, lineage, label: "", status: "proposed", origin: "ai_extracted", evidence_segment_ids: p.evidence_segment_ids, updated_at: now };
      relatives.push(relative); changed = true;
    }
    if (assertions.some(a => a.relative_id === relative!.id && normalized(a.condition) === normalized(p.condition) && a.status !== "rejected")) continue;
    if (assertions.length >= 128) break;
    const a: FamilyAssertion = { id: idFor("cond", `${consultationId}:${relative.id}:${normalized(p.condition)}`), relative_id: relative.id,
      condition: p.condition, status: "proposed", origin: "ai_extracted", confidence: p.confidence ?? "low",
      evidence_segment_ids: p.evidence_segment_ids, consultation_id: consultationId, updated_at: now };
    if (assertions.some(x => x.id === a.id)) continue; // rejected proposal is never silently resurrected
    assertions.push(a); changed = true;
  }
  return changed ? { ...graph, relatives, assertions, version: graph.version + 1, updated_at: now } : graph;
}
