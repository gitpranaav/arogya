import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";

import { createSessionToken, getSessionCookieName } from "@/src/lib/auth/session";
import { getDb } from "@/src/lib/mongodb/client";
import { enforceUsageLimit, parseBoundedJson } from "@/src/lib/security/access";
import { getUserByEmail } from "@/src/lib/mongodb/repo";

export async function POST(request: Request) {
  try {
    const body = (await parseBoundedJson(request, 4 * 1024)) as { email?: string; password?: string };
    const email = body.email?.trim().toLowerCase();
    const password = body.password ?? "";

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
    }

    if (email.length > 250 || password.length > 1024) return NextResponse.json({ error: "Invalid credentials" }, { status: 400 });
    const db = await getDb();
    if (!await enforceUsageLimit(db, `login-doctor:${email}`, 12, 15 * 60 * 1000)) return NextResponse.json({ error: "Too many attempts; try later" }, { status: 429 });
    const user = await getUserByEmail(email);
    if (!user?.password_hash) {
      return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
    }

    const valid = await bcrypt.compare(password, String(user.password_hash));
    if (!valid) {
      return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
    }

    if (String(user.role ?? "doctor") !== "doctor") return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
    const token = await createSessionToken({
      uid: user._id.toString(),
      email: String(user.email),
      role: String(user.role ?? "doctor"),
      session_version: Number(user.session_version ?? 0),
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
