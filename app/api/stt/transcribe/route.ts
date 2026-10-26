import { DeepgramClient } from "@deepgram/sdk";
import { NextResponse } from "next/server";
import { accessConsultation, enforceUsageLimit, readLimitedBytes } from "@/src/lib/security/access";
const MAX_AUDIO = 8 * 1024 * 1024;
export async function POST(request: Request) {
  const url = new URL(request.url);
  const auth = await accessConsultation(url.searchParams.get("consultation_id"), { active: true });
  if ("error" in auth) return auth.error;
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data")) return NextResponse.json({ error: "Expected multipart audio" }, { status: 415 });
  if (Number(request.headers.get("content-length") || 0) > MAX_AUDIO + 8192) return NextResponse.json({ error: "Audio too large" }, { status: 413 });
  if (!await enforceUsageLimit(auth.db, `stt-files:${auth.session.uid}`, 20, 60 * 60 * 1000)) return NextResponse.json({ error: "Transcription quota exceeded" }, { status: 429 });
  try {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "Transcription unavailable" }, { status: 503 });
    // Stream with a hard byte limit even if Content-Length is absent (chunked uploads).
    const raw = await readLimitedBytes(request, MAX_AUDIO + 8192);
    const boundedRequest = new Request(request.url, { method: "POST", headers: request.headers, body: Buffer.from(raw) });
    const form = await boundedRequest.formData();
    const file = form.get("audio");
    if (!(file instanceof File) || file.size > MAX_AUDIO || file.size < 100 || !/^audio\/(webm|wav|mpeg|mp4|ogg|x-wav|aac)/.test(file.type))
      return NextResponse.json({ error: "Invalid audio type or size" }, { status: 400 });
    const buffer = Buffer.from(await file.arrayBuffer());
    const deepgram = new DeepgramClient({ apiKey });
    const response = await deepgram.listen.v1.media.transcribeFile(buffer, { model: "nova-3-medical", smart_format: true, punctuate: true });
    if (!("results" in response)) return NextResponse.json({ error: "Transcription did not return a completed result" }, { status: 502 });
    const alt = response.results?.channels?.[0]?.alternatives?.[0];
    return NextResponse.json({ transcript: alt?.transcript ?? "", words: alt?.words ?? [], confidence: alt?.confidence ?? 0 });
  } catch (error) {
    if (error instanceof Error && error.message === "payload_too_large") return NextResponse.json({ error: "Audio too large" }, { status: 413 });
    return NextResponse.json({ error: "Transcription failed" }, { status: 502 });
  }
}
