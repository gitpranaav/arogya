/** Local, versioned medication resolution. Catalog entries are seeded to MongoDB as well.
 * Mapping is a conservative engineering aid, NOT an approved drug reference. */
import catalog from "./medicationCatalog.json";

export const MEDICATION_CATALOG_VERSION = catalog.version;
export type CatalogEntry = (typeof catalog.entries)[number];
export type Resolution =
  | { status: "resolved"; entry: CatalogEntry; ingredients: string[] }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "unknown" };

export function normalizeMedicationText(input: string): string {
  return String(input ?? "").normalize("NFKC").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

const entries = catalog.entries as CatalogEntry[];
const aliases = new Map<string, CatalogEntry[]>();
for (const entry of entries) {
  for (const raw of [entry.name, entry.generic_name, ...entry.aliases]) {
    const key = normalizeMedicationText(raw);
    if (!key) continue;
    const list = aliases.get(key) ?? [];
    if (!list.some(item => item.id === entry.id)) list.push(entry);
    aliases.set(key, list);
  }
}

function resolveAlias(key: string): Resolution {
  const matches = aliases.get(key) ?? [];
  if (!matches.length) return { status: "unknown" };
  const ingredientSets = new Set(matches.map(entry => [...entry.ingredients].sort().join("|")));
  // A brand/generic synonym may legitimately identify several catalog products
  // with identical ingredients; two distinct ingredient sets must fail closed.
  if (ingredientSets.size !== 1) return { status: "ambiguous", candidates: matches.map(m => m.name) };
  return { status: "resolved", entry: matches[0], ingredients: matches[0].ingredients };
}

/** Resolve full entered product names; only an appended strength/route is stripped. */
export function resolveMedication(name: string): Resolution {
  const exact = normalizeMedicationText(name);
  if (!exact || exact.length > 160) return { status: "unknown" };
  let resolved = resolveAlias(exact);
  if (resolved.status !== "unknown") return resolved;
  // e.g. "Paracetamol 500mg" and "Augmentin 625 mg oral". Do not strip
  // other words; a partial name must never silently resolve a combination.
  const withoutStrength = exact.replace(/\s+\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|iu|units?)(?:\s+(?:oral|tablet|capsule|injection))*$/, "");
  if (withoutStrength !== exact) resolved = resolveAlias(withoutStrength);
  return resolved;
}

interface TrieNode { next: Map<string, TrieNode>; alias?: string; }
const root: TrieNode = { next: new Map() };
for (const alias of aliases.keys()) {
  let node = root;
  for (const token of alias.split(" ")) {
    if (!node.next.has(token)) node.next.set(token, { next: new Map() });
    node = node.next.get(token)!;
  }
  node.alias = alias;
}

export interface MedicationMention {
  alias: string;
  start: number;
  end: number;
  resolution: Resolution;
}

/** Token trie: longest complete alias, word boundaries, bounded per-utterance cost. */
export function findMedicationMentions(input: string): MedicationMention[] {
  const words = normalizeMedicationText(input).split(" ").filter(Boolean).slice(0, 400);
  const found: MedicationMention[] = [];
  for (let i = 0; i < words.length;) {
    let node = root;
    let match: { alias: string; end: number } | undefined;
    for (let j = i; j < Math.min(i + 8, words.length); j++) {
      const next = node.next.get(words[j]);
      if (!next) break;
      node = next;
      if (node.alias) match = { alias: node.alias, end: j + 1 };
    }
    if (match) {
      found.push({ ...match, start: i, resolution: resolveAlias(match.alias) });
      i = match.end;
    } else i++;
  }
  return found;
}
