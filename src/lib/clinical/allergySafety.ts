import type { EMRMedication } from "@/src/lib/emr/types";
import { MEDICATION_CATALOG_VERSION, normalizeMedicationText, resolveMedication, findMedicationMentions } from "./medicationTerminology";

// Explicit, narrow rules. Ingredient classification alone is NOT a cross-allergy rule.
// These provisional engineering rules require clinical/pharmacy governance before deployment.
export const ALLERGY_RULESET_VERSION = `allergy-rules-unvalidated-v1|${MEDICATION_CATALOG_VERSION}`;
const allergenAliases: Record<string, string> = {
  acetaminophen: "paracetamol", amoxycillin: "amoxicillin", pcn: "penicillin",
  "non steroidal anti inflammatory drugs": "nsaid", "nonsteroidal anti inflammatory drugs": "nsaid",
};
const explicitRules: ReadonlyArray<{ id: string; allergen: string; ingredients: readonly string[] }> = [
  { id: "penicillin-to-amoxicillin", allergen: "penicillin", ingredients: ["amoxicillin"] },
  // Explicit watchlists preserve conservative alerts for documented class allergies.
  // They are potential-risk prompts, not proofs of cross-reactivity.
  { id: "aspirin-nsaid-watchlist", allergen: "aspirin", ingredients: ["ibuprofen", "naproxen", "diclofenac", "ketorolac", "meloxicam", "aceclofenac"] },
  { id: "nsaid-watchlist", allergen: "nsaid", ingredients: ["aspirin", "ibuprofen", "naproxen", "diclofenac", "ketorolac", "meloxicam", "aceclofenac"] },
  { id: "opioid-watchlist", allergen: "opioid", ingredients: ["tramadol"] },
];
const ignoredAllergyLabels = new Set(["none", "nil", "nka", "nkda", "no known allergies", "no known drug allergies"]);

function allergyIdentity(raw: string): string {
  const normalized = normalizeMedicationText(raw).replace(/^allergic to /, "").replace(/ allergy$/, "");
  return allergenAliases[normalized] ?? normalized;
}

export type SafetyIssue = {
  id: string;
  kind: "ingredient_conflict" | "explicit_rule" | "unknown_medication" | "ambiguous_medication" | "unresolved_allergen";
  medication: string;
  allergy?: string;
  ingredient?: string;
  rule_id?: string;
  message: string;
  medication_index: number;
  rule_version: string;
};

/** Same deterministic decision path for browser suggestions and server review. */
export function evaluatePrescriptionSafety(allergies: string[], medications: EMRMedication[]): SafetyIssue[] {
  const allergenMap = new Map<string, { display: string; identity: string }>();
  for (const raw of allergies ?? []) {
    if (typeof raw !== "string") continue;
    const identity = allergyIdentity(raw);
    if (identity && !ignoredAllergyLabels.has(identity) && !allergenMap.has(identity))
      allergenMap.set(identity, { display: raw.trim(), identity });
  }
  const cleanedAllergies = [...allergenMap.values()];
  const results: SafetyIssue[] = [];
  const add = (issue: Omit<SafetyIssue, "rule_version">) => results.push({ ...issue, rule_version: ALLERGY_RULESET_VERSION });
  medications.slice(0, 40).forEach((med, index) => {
    if (!med || typeof med.name !== "string" || !med.name.trim()) return;
    const medication = med.name.trim();
    const resolved = resolveMedication(medication);
    if (resolved.status !== "resolved") {
      add({ id: `${index}:${resolved.status}:${normalizeMedicationText(medication)}`, medication_index: index,
        kind: resolved.status === "unknown" ? "unknown_medication" : "ambiguous_medication", medication,
        message: `Medication identity ${resolved.status}: ${medication}. Clinician must verify active ingredients.` });
      return;
    }
    for (const allergen of cleanedAllergies) {
      const matched = resolved.ingredients.find(ingredient => normalizeMedicationText(ingredient) === allergen.identity);
      if (matched) {
        add({ id: `${index}:ingredient:${matched}:${allergen.identity}`, medication_index: index,
          kind: "ingredient_conflict", medication, allergy: allergen.display, ingredient: matched,
          message: `Potential allergy conflict: ${medication} contains ${matched}; recorded allergy: ${allergen.display}.` });
        continue;
      }
      let ruled = false;
      for (const rule of explicitRules) {
        if (allergen.identity === rule.allergen && resolved.ingredients.some(i => rule.ingredients.includes(i))) {
          ruled = true;
          add({ id: `${index}:rule:${rule.id}`, medication_index: index, kind: "explicit_rule", medication,
            allergy: allergen.display, rule_id: rule.id,
            message: `Potential allergy conflict: ${medication} triggers explicit safety rule ${rule.id} for ${allergen.display}.` });
        }
      }
      // Do not infer that unrelated allergies cross-react with an ingredient.
      // Unresolved allergy terminology is surfaced for human assessment.
      if (!ruled && resolveMedication(allergen.identity).status !== "resolved" &&
          !explicitRules.some(rule => rule.allergen === allergen.identity) &&
          !resolved.ingredients.some(i => normalizeMedicationText(i) === allergen.identity)) {
        add({ id: `${index}:allergen-unmapped:${allergen.identity}`, medication_index: index, kind: "unresolved_allergen",
          medication, allergy: allergen.display,
          message: `Recorded allergy '${allergen.display}' is not mapped to a medication ingredient; check ${medication} manually.` });
      }
    }
  });
  return [...new Map(results.map(issue => [issue.id, issue])).values()];
}

export type SpeechIntent = "prescribing" | "mentioned" | "negated" | "historical";
export type SpeechSignal = { id: string; medication: string; ingredient: string; intent: SpeechIntent;
  phase: "interim" | "finalized"; warning: string; rule_version: string };

/** Local speech screening does not need the LLM, MongoDB or a network connection. */
export function detectLiveAllergySignals(allergies: string[], finalized: string, interim = ""): SpeechSignal[] {
  const results: SpeechSignal[] = [];
  for (const [text, phase] of [[finalized, "finalized"], [interim, "interim"]] as const) {
    const tokens = normalizeMedicationText(text).split(" ").filter(Boolean).slice(-400);
    if (!tokens.length) continue;
    const context = tokens.join(" ");
    for (const mention of findMedicationMentions(context)) {
      if (mention.resolution.status !== "resolved") continue;
      const drug = mention.resolution.entry.name;
      const conflict = evaluatePrescriptionSafety(allergies, [{ name: drug }]).find(issue =>
        issue.kind === "ingredient_conflict" || issue.kind === "explicit_rule");
      if (!conflict) continue;
      // Analyze only the local clause, not the entire transcript, so earlier negations
      // do not suppress a later explicit instruction.
      const before = tokens.slice(Math.max(0, mention.start - 9), mention.start).join(" ");
      const local = before.split(/\b(?:but|however|then|instead|and)\b/).pop() ?? before;
      const after = tokens.slice(mention.end, mention.end + 5).join(" ");
      const negated = /(?:do not|don t|dont|never|avoid|stop|no need to|not to|should not|must not|will not|not prescribe|not prescribing)(?:\s+\w+){0,4}$/.test(local) ||
        /\bnot allergic to\s*$/.test(local) || /\b(?:avoid|contraindicated)\b/.test(after);
      const historical = /\b(?:previously|historically|earlier|last year|last week|used to|was taking|history of|had taken)\b/.test(local);
      const prescribing = /\b(?:prescribe|prescribing|start|starting|give|giving|administer|administering|order|ordering|take|taking|continue|continuing|begin|beginning|add|adding)(?:\s+\w+){0,3}$/.test(local);
      const intent: SpeechIntent = negated ? "negated" : historical ? "historical" : prescribing ? "prescribing" : "mentioned";
      results.push({ id: `${conflict.id}:${intent}`, medication: drug, ingredient: conflict.ingredient ?? drug,
        intent, phase, rule_version: ALLERGY_RULESET_VERSION,
        warning: `${phase === "interim" ? "Provisional" : "Finalized"} ${intent === "prescribing" ? "prescribing-intent" : "medication-mention"} allergy check: ${drug} matches a recorded allergy; verify before prescribing.` });
    }
  }
  // Same medication/intent in interim and finalized speech is one signal; prefer finalized.
  const distinct = new Map<string, SpeechSignal>();
  for (const signal of results) {
    const previous = distinct.get(signal.id);
    if (!previous || signal.phase === "finalized") distinct.set(signal.id, signal);
  }
  return [...distinct.values()];
}
