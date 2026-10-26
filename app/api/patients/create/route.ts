import { NextResponse } from "next/server";

import { getServerSession } from "@/src/lib/auth/session";
import { registerPatientForPractice } from "@/src/lib/mongodb/repo";

export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["doctor", "receptionist"].includes(String(session.role))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    const { parseBoundedJson } = await import("@/src/lib/security/access");
    body = await parseBoundedJson(request, 16 * 1024) as Record<string, unknown>;
  } catch { return NextResponse.json({ error: "Invalid intake payload" }, { status: 400 }); }
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
  if (!name || name.length > 150 || !/^[+0-9 ()-]{7,22}$/.test(phone)) {
    return NextResponse.json({ error: "Valid name and phone are required" }, { status: 400 });
  }
  const validArray = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 40 && v.every(x => typeof x === "string" && x.length <= 200));
  if (!validArray(body.allergies) || !validArray(body.chronic_conditions)) return NextResponse.json({ error: "Invalid medical history" }, { status: 400 });
  let result: { id?: string; conflict?: boolean };
  try { result = await registerPatientForPractice({
    name, phone,
    dob: typeof body.dob === "string" ? body.dob.slice(0, 30) : null,
    gender: typeof body.gender === "string" ? body.gender.slice(0, 40) : null,
    blood_group: typeof body.blood_group === "string" ? body.blood_group.slice(0, 10) : null,
    allergies: body.allergies as string[] | undefined,
    chronic_conditions: body.chronic_conditions as string[] | undefined,
    address: typeof body.address === "string" ? body.address.slice(0, 1000) : null,
  }, session.uid); }
  catch { return NextResponse.json({ error: "Patient registration unavailable; records were not partially committed" }, { status: 503 }); }
  if (result.conflict) return NextResponse.json({ error: "Phone already belongs to a patient outside this practice. Identity verification and explicit linking are required." }, { status: 409 });
  return NextResponse.json({ id: result.id });
}
