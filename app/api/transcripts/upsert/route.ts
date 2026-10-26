import { NextResponse } from "next/server";
import { accessConsultation, parseBoundedJson } from "@/src/lib/security/access";
import { logConsultationAudit } from "@/src/lib/audit/consultationLedger";
import { clinicalTransaction, isClinicalConflict } from "@/src/lib/mongodb/clinicalTransaction";

type Segment = { id: string; text: string; is_final?: boolean; [key: string]: unknown };
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("consultation_id");
  const auth = await accessConsultation(id);
  if ("error" in auth) return auth.error;
  const transcript = await auth.db.collection("transcripts").findOne({ consultation_id: auth.consultationId },
    { projection: { _id: 0, raw_text: 1, segments: 1, processing_status: 1, updated_at: 1, created_at: 1 } });
  return NextResponse.json({ transcript: transcript ?? null });
}
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await parseBoundedJson(request, 512 * 1024) as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid transcript" }, { status: 400 }); }
  const auth = await accessConsultation(body?.consultation_id, { active: true });
  if ("error" in auth) return auth.error;
  const input = body.segments;
  if (!Array.isArray(input) || input.length > 3000 || input.some((s: Segment) => !s ||
      typeof s.id !== "string" || !/^[\w-]{1,80}$/.test(s.id) || typeof s.text !== "string" || s.text.length > 3500 || s.is_final === false))
    return NextResponse.json({ error: "Invalid transcript segments" }, { status: 400 });
  const status = body.processing_status;
  if (!["in_progress", "paused", "completed"].includes(String(status))) return NextResponse.json({ error: "Invalid transcript state" }, { status: 400 });
  const { db, consultationId, consultation, session } = auth;
  // Retry on concurrent modifications so existing segment IDs are never dropped.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await db.collection("transcripts").findOne({ consultation_id: consultationId });
    const currentSegments = Array.isArray(current?.segments) ? current.segments as Segment[] : [];
    const byId = new Map(currentSegments.map(s => [s.id, s]));
    // A finalized segment is an immutable clinical evidence record. A repeated ID
    // with different text must be rejected, never silently accepted as a retry.
    if ((input as Segment[]).some(s => byId.has(s.id) && byId.get(s.id)?.text !== s.text))
      return NextResponse.json({ error: "Transcript segment ID conflicts with persisted evidence" }, { status: 409 });
    if (current?.processing_status === "completed") {
      if ((input as Segment[]).some(s => !byId.has(s.id)))
        return NextResponse.json({ error: "Completed transcript is immutable" }, { status: 409 });
      // Delayed 'in_progress' uploads must not rewrite an already completed
      // transcript or increment its version during doctor review/finalization.
      return NextResponse.json({ ok: true, segment_count: currentSegments.length, processing_status: "completed" });
    }
    for (const s of input as Segment[]) if (!byId.has(s.id)) byId.set(s.id, { id: s.id, text: s.text, is_final: true,
      timestamp: typeof s.timestamp === "string" ? s.timestamp.slice(0, 40) : undefined,
      confidence: typeof s.confidence === "number" ? s.confidence : undefined,
      start_ms: typeof s.start_ms === "number" ? s.start_ms : undefined,
      end_ms: typeof s.end_ms === "number" ? s.end_ms : undefined,
      language: typeof s.language === "string" ? s.language.slice(0, 20) : null, sequence: typeof s.sequence === "number" && Number.isInteger(s.sequence) && s.sequence >= 0 ? s.sequence : undefined,
      speaker: s.speaker === "patient" ? "patient" : "doctor" });
    if (byId.size > 3000) return NextResponse.json({ error: "Transcript segment limit reached" }, { status: 413 });
    const merged = [...byId.values()].sort((a, b) => (typeof a.sequence === "number" && typeof b.sequence === "number") ? (a.sequence - b.sequence) : (String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? ""))));
    const nextStatus = current?.processing_status === "completed" ? "completed" : status;
    const now = new Date().toISOString();
    const filter = current ? { _id: current._id, version: current.version ?? { $exists: false } } : { consultation_id: consultationId, version: { $exists: false } };
    try {
      const updated = await clinicalTransaction(db, async mongoSession => {
        const result = await db.collection("transcripts").updateOne(filter,
          { $set: { raw_text: merged.map(s => s.text).join(" "), segments: merged, processing_status: nextStatus, updated_at: now },
            $inc: { version: 1 }, $setOnInsert: { consultation_id: consultationId, created_at: now } },
          { upsert: !current, session: mongoSession });
        if (!result.matchedCount && !result.upsertedCount) throw new Error("version_conflict");
        if (!current || (nextStatus === "completed" && current.processing_status !== "completed")) {
          await logConsultationAudit(db, { consultationId, patientId: consultation.patient_id, actorId: session.actor_id ?? session.uid,
            actorRole: session.role, source: "system", eventType: !current ? "transcription_started" : "transcription_stopped",
            before: { status: current?.processing_status ?? null }, after: { status: nextStatus }, allowNoop: true,
            mongoSession });
        }
        return { ok: true, segment_count: merged.length, processing_status: nextStatus };
      }, { activeConsultationId: consultationId });
      return NextResponse.json(updated);
    } catch (e: any) {
      if (isClinicalConflict(e)) {
        if (e instanceof Error && e.message === "Consultation is no longer active")
          return NextResponse.json({ error: "Consultation completed; transcript is locked" }, { status: 409 });
        continue;
      }
      return NextResponse.json({ error: "Transcript and audit could not be committed" }, { status: 503 });
    }
  }
  return NextResponse.json({ error: "Transcript concurrently updated, retry" }, { status: 409 });
}
