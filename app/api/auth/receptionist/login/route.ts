import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";

import { createSessionToken, getSessionCookieName } from "@/src/lib/auth/session";
import { getDb } from "@/src/lib/mongodb/client";
import { enforceUsageLimit, parseBoundedJson } from "@/src/lib/security/access";
import { getUserByEmail } from "@/src/lib/mongodb/repo";

export async function POST(request: Request) {
  try {
    const body = (await parseBoundedJson(request, 4 * 1024)) as { doctor_email?: string; password?: string };
    const doctorEmail = body.doctor_email?.trim().toLowerCase();
    const password = body.password ?? "";

    if (!doctorEmail || !password) {
      return NextResponse.json({ error: "Doctor email and password are required." }, { status: 400 });
    }

    if (doctorEmail.length > 250 || password.length > 1024) return NextResponse.json({ error: "Invalid credentials" }, { status: 400 });
    const db = await getDb();
    if (!await enforceUsageLimit(db, `login-reception:${doctorEmail}`, 12, 15 * 60 * 1000)) return NextResponse.json({ error: "Too many attempts; try later" }, { status: 429 });
    const doctor = await getUserByEmail(doctorEmail);
    if (!doctor || String(doctor.role ?? "doctor") !== "doctor") {
      return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
    }

    const hash = (doctor as any).receptionist_password_hash;
    if (!hash) {
      return NextResponse.json({ error: "Receptionist access is not enabled for this doctor." }, { status: 403 });
    }

    const valid = await bcrypt.compare(password, String(hash));
    if (!valid) {
      return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
    }

    // Stable identity for the shared receptionist credential (individual staff accounts remain future work).
    const { ObjectId } = await import("mongodb");
    const actor = doctor.receptionist_actor_id ?? new ObjectId();
    if (!doctor.receptionist_actor_id) await db.collection("users").updateOne({ _id: doctor._id, receptionist_actor_id: { $exists: false } },
      { $set: { receptionist_actor_id: actor } });
    const refreshed = await db.collection("users").findOne({ _id: doctor._id }, { projection: { receptionist_actor_id: 1 } });
    const token = await createSessionToken({
      uid: doctor._id.toString(),
      email: String(doctor.email),
      role: "receptionist",
      actor_id: String(refreshed?.receptionist_actor_id ?? actor),
      session_version: Number(doctor.receptionist_session_version ?? 0),
    });

    const response = NextResponse.json({ ok: true });
    response.cookies.set(getSessionCookieName(), token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return response;
  } catch (error) {
    return NextResponse.json({ error: "Login temporarily unavailable." }, { status: 503 });
  }
}

