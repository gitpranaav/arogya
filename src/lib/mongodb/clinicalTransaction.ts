import type { ClientSession, Db, ObjectId } from "mongodb";
import { prepareAuditIndexes } from "@/src/lib/audit/consultationLedger";

export class ClinicalConflictError extends Error {
  constructor(message = "Clinical record changed; reload and retry") {
    super(message);
    this.name = "ClinicalConflictError";
  }
}

/**
 * Apply related clinical writes and their audit event atomically.
 * A consultation-scoped mutation must claim an active parent inside the same
 * transaction. This conflicts with concurrent completion, so a late AI or
 * browser write cannot modify clinical records after finalization.
 * Requires a replica set/sharded MongoDB; never falls back to partial writes.
 */
export async function clinicalTransaction<T>(
  db: Db,
  work: (mongoSession: ClientSession) => Promise<T>,
  options: { activeConsultationId?: ObjectId } = {},
): Promise<T> {
  await prepareAuditIndexes(db);
  const session = db.client.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      if (options.activeConsultationId) {
        const claim = await db.collection("consultations").updateOne(
          { _id: options.activeConsultationId, status: "active" },
          { $inc: { clinical_revision: 1 } }, { session },
        );
        if (!claim.matchedCount) throw new ClinicalConflictError("Consultation is no longer active");
      }
      result = await work(session);
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    return result;
  } finally {
    await session.endSession();
  }
}

/** Treat a stale CAS or a transient write conflict as a reloadable conflict. */
export function isClinicalConflict(error: unknown): boolean {
  if (error instanceof ClinicalConflictError) return true;
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: number; message?: string; hasErrorLabel?: (name: string) => boolean };
  return e.code === 11000 || e.code === 112 ||
    e.hasErrorLabel?.("TransientTransactionError") === true ||
    ["version_conflict", "Concurrent update", "Concurrent EMR update", "lease_lost", "Clinical data changed", "Consultation already finalized"].includes(e.message ?? "");
}
