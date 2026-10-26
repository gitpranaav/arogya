import { createHash } from "crypto";
import { ObjectId, type Db, type ClientSession } from "mongodb";

export type AuditSource = "doctor_manual" | "receptionist_manual" | "ai_delta" | "ai_final" | "system";

export type LogConsultationAuditInput = {
  consultationId: ObjectId | string;
  patientId?: ObjectId | string | null;
  actorId?: ObjectId | string | null;
  actorRole?: string | null;
  source: AuditSource;
  eventType: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  allowNoop?: boolean;
  mongoSession?: ClientSession;
};

// Cache index initialization per MongoClient/database, not process-wide. A
// verification DB must never inherit another database's ready flag.
const indexPromises = new WeakMap<object, Map<string, Promise<void>>>();

function toObjectId(value: ObjectId | string | null | undefined) {
  if (!value) return null;
  if (value instanceof ObjectId) return value;
  if (typeof value !== "string") return null;
  if (!ObjectId.isValid(value)) return null;
  return new ObjectId(value);
}

function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSort);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort((a, b) => a.localeCompare(b));
  for (const key of keys) out[key] = stableSort(source[key]);
  return out;
}

function stableStringify(value: unknown) {
  return JSON.stringify(stableSort(value));
}

function hashSha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function toPlain(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collectChangedPaths(before: unknown, after: unknown, prefix = "", out = new Set<string>(), depth = 0) {
  if (depth > 8) {
    out.add(prefix || "$root");
    return out;
  }

  if (Object.is(before, after)) return out;

  const beforeArray = Array.isArray(before);
  const afterArray = Array.isArray(after);

  if (beforeArray || afterArray) {
    if (!beforeArray || !afterArray) {
      out.add(prefix || "$root");
      return out;
    }
    const b = before as unknown[];
    const a = after as unknown[];
    if (b.length !== a.length) {
      out.add(prefix || "$root");
      return out;
    }
    for (let i = 0; i < a.length; i += 1) {
      const nextPrefix = `${prefix}[${i}]`;
      collectChangedPaths(b[i], a[i], nextPrefix, out, depth + 1);
    }
    return out;
  }

  const beforeObj = isObject(before);
  const afterObj = isObject(after);
  if (!beforeObj || !afterObj) {
    out.add(prefix || "$root");
    return out;
  }

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    collectChangedPaths(before[key], after[key], nextPrefix, out, depth + 1);
  }

  return out;
}

async function ensureIndexes(db: Db) {
  let databases = indexPromises.get(db.client);
  if (!databases) { databases = new Map(); indexPromises.set(db.client, databases); }
  const name = db.databaseName;
  if (!databases.has(name)) {
    const pending = (async () => {
      const collection = db.collection("consultation_audit_events");
      await Promise.all([
        collection.createIndex({ consultation_id: 1, sequence_no: 1 }, { unique: true }),
        collection.createIndex({ consultation_id: 1, created_at: -1 }),
        collection.createIndex({ patient_id: 1, created_at: -1 }),
        collection.createIndex({ actor_id: 1, created_at: -1 }),
        collection.createIndex({ event_hash: 1 }, { unique: true }),
      ]);
    })();
    databases.set(name, pending);
    // Failed initialization must be retryable after the DB/index issue is fixed.
    pending.catch(() => { if (databases?.get(name) === pending) databases.delete(name); });
  }
  await databases.get(name);
}

export async function prepareAuditIndexes(db: Db) { await ensureIndexes(db); }

export async function logConsultationAudit(db: Db, input: LogConsultationAuditInput) {
  const consultationId = toObjectId(input.consultationId);
  if (!consultationId) throw new Error("audit_consultation_id_invalid");

  // Audit-chain writes outside the clinical transaction could commit orphaned
  // events or race with another writer. Never permit that fallback.
  if (!input.mongoSession) throw new Error("audit_transaction_required");
  const beforePlain = toPlain(input.before);
  const afterPlain = toPlain(input.after);
  const changedPaths = Array.from(collectChangedPaths(beforePlain, afterPlain)).sort((a, b) => a.localeCompare(b));
  if (!input.allowNoop && changedPaths.length === 0) return;

  const collection = db.collection("consultation_audit_events");
  // The parent write serializes sequence and hash allocation under contention.
  const claimed = await db.collection("consultations").updateOne({ _id: consultationId },
    { $inc: { audit_revision: 1 } }, { session: input.mongoSession });
  if (!claimed.matchedCount) throw new Error("audit_consultation_missing");
  const lastEvent = await collection.find({ consultation_id: consultationId }, { session: input.mongoSession })
    .sort({ sequence_no: -1 }).limit(1).next();
  const sequenceNo = Number(lastEvent?.sequence_no ?? 0) + 1;
  const prevHash = String(lastEvent?.event_hash ?? "");
  const createdAt = new Date().toISOString();

  const patientId = toObjectId(input.patientId);
  const actorId = toObjectId(input.actorId);

  const hashPayload = {
    consultation_id: consultationId.toString(),
    patient_id: patientId?.toString() ?? null,
    actor_id: actorId?.toString() ?? null,
    actor_role: input.actorRole ?? null,
    source: input.source,
    event_type: input.eventType,
    sequence_no: sequenceNo,
    prev_hash: prevHash,
    before: beforePlain,
    after: afterPlain,
    changed_paths: changedPaths,
    metadata: input.metadata ?? null,
    created_at: createdAt,
  };
  const eventHash = hashSha256(stableStringify(hashPayload));

  await collection.insertOne({
    consultation_id: consultationId,
    patient_id: patientId,
    actor_id: actorId,
    actor_role: input.actorRole ?? null,
    source: input.source,
    event_type: input.eventType,
    sequence_no: sequenceNo,
    prev_hash: prevHash,
    event_hash: eventHash,
    before: beforePlain,
    after: afterPlain,
    changed_paths: changedPaths,
    metadata: input.metadata ?? null,
    created_at: createdAt,
  }, { session: input.mongoSession });
}
