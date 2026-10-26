import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { getServerSession } from "@/src/lib/auth/session";
import { getDb } from "@/src/lib/mongodb/client";
import { parseBoundedJson } from "@/src/lib/security/access";

export async function GET() {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (String(session.role) !== "doctor") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const db = await getDb();
  const user = await db.collection("users").findOne(
    { _id: new ObjectId(session.uid) },
    { projection: { clinic_name: 1, clinic_address: 1, clinic_phone: 1, registration_number: 1, doctor_name: 1, name: 1 } }
  );

  return NextResponse.json({
    clinic_name: user?.clinic_name ?? "",
    clinic_address: user?.clinic_address ?? "",
    clinic_phone: user?.clinic_phone ?? "",
    registration_number: user?.registration_number ?? "",
    doctor_name: user?.doctor_name ?? user?.name ?? "",
  });
}

export async function PATCH(request: Request) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (String(session.role) !== "doctor") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try { body = await parseBoundedJson(request, 8 * 1024) as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "Invalid doctor settings" }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  const allowed = new Set(["clinic_name", "clinic_address", "clinic_phone", "registration_number", "doctor_name"]);
  if (Object.keys(body).some(k => !allowed.has(k) || typeof body[k] !== "string" || body[k].length > (k === "clinic_address" ? 1000 : 200)))
    return NextResponse.json({ error: "Invalid settings field" }, { status: 400 });
  const payload: Record<string, string> = { updated_at: new Date().toISOString() };
  for (const [key, value] of Object.entries(body)) payload[key] = (value as string).trim();

  const db = await getDb();
  await db.collection("users").updateOne({ _id: new ObjectId(session.uid) }, { $set: payload });

  return NextResponse.json({ ok: true });
}