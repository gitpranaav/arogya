import { ObjectId, type Db } from "mongodb";
import { NextResponse } from "next/server";
import { getServerSession } from "@/src/lib/auth/session";
import { getDb } from "@/src/lib/mongodb/client";

export const validId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id);
export type AccessResult =
  | { error: NextResponse }
  | { db: Db; session: NonNullable<Awaited<ReturnType<typeof getServerSession>>>; consultation: Record<string, any>; consultationId: ObjectId };

export async function accessConsultation(id: unknown, options: { doctorOnly?: boolean; active?: boolean } = {}): Promise<AccessResult> {
  const session = await getServerSession();
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!validId(session.uid) || (options.doctorOnly ? session.role !== "doctor" : !["doctor", "receptionist"].includes(session.role))) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  if (!validId(id)) return { error: NextResponse.json({ error: "Invalid consultation ID" }, { status: 400 }) };
  const db = await getDb();
  const consultationId = new ObjectId(id);
  const consultation = await db.collection("consultations").findOne({ _id: consultationId, doctor_id: new ObjectId(session.uid) });
  if (!consultation) return { error: NextResponse.json({ error: "Consultation not found" }, { status: 404 }) };
  if (options.active && consultation.status !== "active") return { error: NextResponse.json({ error: "Consultation is not active" }, { status: 409 }) };
  return { db, session, consultation, consultationId };
}

/** Count requests in a fixed UTC time bucket, atomically across server instances. */
export async function enforceUsageLimit(db: Db, key: string, max: number, windowMs: number): Promise<boolean> {
  const bucket = Math.floor(Date.now() / windowMs);
  const id = `${key}:${bucket}`;
  const result = await db.collection<{ _id: string; count: number; expires_at: Date }>("api_usage_limits").findOneAndUpdate(
    { _id: id }, { $inc: { count: 1 }, $setOnInsert: { expires_at: new Date((bucket + 2) * windowMs) } },
    { upsert: true, returnDocument: "after" }
  );
  return Number(result?.count ?? Infinity) <= max;
}

export async function readLimitedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("payload_too_large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("payload_too_large");
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
export async function parseBoundedJson(request: Request, maxBytes = 128 * 1024): Promise<unknown> {
  const bytes = await readLimitedBytes(request, maxBytes);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
