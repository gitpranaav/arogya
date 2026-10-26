import { NextResponse } from "next/server";
import { accessConsultation, enforceUsageLimit, parseBoundedJson } from "@/src/lib/security/access";
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await parseBoundedJson(request, 1024) as Record<string, unknown>; } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }
  const auth = await accessConsultation(body?.consultation_id, { active: true });
  if ("error" in auth) return auth.error;
  const allowed = await enforceUsageLimit(auth.db, `stt-grants:${auth.session.uid}`, 30, 60 * 60 * 1000);
  if (!allowed) return NextResponse.json({ error: "STT connection quota exceeded" }, { status: 429 });
  const secret = process.env.DEEPGRAM_API_KEY;
  if (!secret) return NextResponse.json({ error: "STT provider unavailable" }, { status: 503 });
  try {
    const res = await fetch("https://api.deepgram.com/v1/auth/grant", { method: "POST",
      headers: { Authorization: `Token ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_seconds: 30 }), signal: AbortSignal.timeout(7000), cache: "no-store" });
    if (!res.ok) return NextResponse.json({ error: "STT provider authorization failed" }, { status: 502 });
    const response = await res.json() as { access_token?: string; expires_in?: number };
    if (!response.access_token) throw new Error("No temporary token");
    return NextResponse.json({ token: response.access_token, mode: "bearer", expires_in: response.expires_in },
      { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "STT token service unavailable" }, { status: 503 }); }
}
