import bcrypt from "bcryptjs";
import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { getServerSession } from "@/src/lib/auth/session";
import { getDb } from "@/src/lib/mongodb/client";
import { parseBoundedJson } from "@/src/lib/security/access";

export async function PATCH(request: Request) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (String(session.role) !== "doctor") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { receptionist_password?: string };
  try { body = await parseBoundedJson(request, 4 * 1024) as typeof body; }
  catch { return NextResponse.json({ error: "Invalid input" }, { status: 400 }); }
  const password = body.receptionist_password ?? "";
  if (typeof password !== "string" || password.trim().length < 10 || password.length > 256) {
    return NextResponse.json({ error: "Password must be 10–256 characters." }, { status: 400 });
  }

  const db = await getDb();
  const receptionist_password_hash = await bcrypt.hash(password, 10);
  await db.collection("users").updateOne(
    { _id: new ObjectId(session.uid) },
    { $set: { receptionist_password_hash, updated_at: new Date().toISOString() }, $inc: { receptionist_session_version: 1 } }
  );

  return NextResponse.json({ ok: true });
}

