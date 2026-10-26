import { cookies } from "next/headers";

const COOKIE_NAME = "cliniq_session";
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

type SessionPayload = {
  uid: string;
  email: string;
  role: string;
  exp: number;
  session_version: number;
  actor_id?: string;
};

function toBase64Url(value: string) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

async function sign(data: string, secret: string) {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function createSessionToken(payload: Omit<SessionPayload, "exp">, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("Missing AUTH_SECRET.");
  const completePayload: SessionPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encodedPayload = toBase64Url(JSON.stringify(completePayload));
  const signature = await sign(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export async function verifySessionToken(token: string | undefined | null) {
  if (!token) return null;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const [encodedPayload, givenSignature] = token.split(".");
  if (!encodedPayload || !givenSignature) return null;
  const expectedSignature = await sign(encodedPayload, secret);
  if (expectedSignature.length !== givenSignature.length) return null;
  // Fixed-length, constant-time comparison also works in the Edge runtime.
  let mismatch = 0;
  for (let i = 0; i < expectedSignature.length; i += 1) mismatch |= expectedSignature.charCodeAt(i) ^ givenSignature.charCodeAt(i);
  if (mismatch !== 0) return null;
  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload)) as SessionPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000) || !Number.isInteger(payload.session_version)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function getServerSession() {
  const cookieStore = await cookies();
  const session = await verifySessionToken(cookieStore.get(COOKIE_NAME)?.value);
  if (!session || !/^[0-9a-f]{24}$/i.test(session.uid)) return null;
  // This database check revokes tokens after password/account changes.
  const { getDb } = await import("@/src/lib/mongodb/client");
  const { ObjectId } = await import("mongodb");
  const db = await getDb();
  const doctor = await db.collection("users").findOne({ _id: new ObjectId(session.uid) },
    { projection: { role: 1, session_version: 1, receptionist_session_version: 1, receptionist_actor_id: 1, receptionist_password_hash: 1, password_hash: 1 } });
  if (!doctor) return null;
  if (session.role === "doctor" && (doctor.role ?? "doctor") === "doctor" && doctor.password_hash && session.session_version === Number(doctor.session_version ?? 0)) return session;
  if (session.role === "receptionist" && doctor.receptionist_password_hash && session.session_version === Number(doctor.receptionist_session_version ?? 0)
    && session.actor_id && session.actor_id === String(doctor.receptionist_actor_id ?? "")) return session;
  return null;
}

export function getSessionCookieName() {
  return COOKIE_NAME;
}
