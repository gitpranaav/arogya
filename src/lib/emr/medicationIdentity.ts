import { createHash, randomUUID } from "node:crypto";
import type { EMRMedication, EMRSnapshot } from "./types";

export const MEDICATION_ID_PATTERN = /^med_[0-9a-f]{32}$/;
export function createMedicationId(): string { return `med_${randomUUID().replace(/-/g, "")}`; }
function legacyId(seed: string, index: number): string {
  return `med_${createHash("sha256").update(`${seed}:${index}`).digest("hex").slice(0, 32)}`;
}
function normalizedName(name: string): string { return name.toLowerCase().trim().replace(/\s+/g, " "); }
/** Legacy rows receive reproducible IDs until their next versioned write persists them. */
export function ensureMedicationIds(snapshot: EMRSnapshot, seed = "legacy"): EMRSnapshot {
  const seen = new Set<string>();
  if (!snapshot.medications) return { ...snapshot };
  return { ...snapshot, medications: snapshot.medications.map((med, index) => {
    let id = med.id && MEDICATION_ID_PATTERN.test(med.id) ? med.id : legacyId(seed, index);
    if (seen.has(id)) id = createMedicationId();
    seen.add(id);
    return { ...med, id };
  }) };
}
/** Preserve IDs across reorder, edits and unique-name matches. Ambiguous names are never guessed. */
export function reconcileMedicationIds(previous: EMRMedication[] = [], incoming: EMRMedication[] = []): EMRMedication[] {
  const used = new Set<string>();
  return incoming.map(row => {
    let matched: EMRMedication | undefined = row.id ? previous.find(p => p.id === row.id && Boolean(p.id) && !used.has(p.id!)) : undefined;
    if (!matched && !row.id) {
      const same = previous.filter(p => Boolean(p.id) && !used.has(p.id!) && normalizedName(p.name) === normalizedName(row.name));
      if (same.length === 1 && incoming.filter(x => normalizedName(x.name) === normalizedName(row.name)).length === 1) matched = same[0];
    }
    const id = matched?.id ?? (row.id && MEDICATION_ID_PATTERN.test(row.id) && !used.has(row.id) ? row.id : createMedicationId());
    used.add(id);
    return { ...row, id };
  });
}
export function medicationIndexById(snapshot: EMRSnapshot, id: string): number {
  return snapshot.medications?.findIndex(m => m.id === id) ?? -1;
}
