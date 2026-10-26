import { NextResponse } from "next/server";

import { getServerSession } from "@/src/lib/auth/session";
import { getDb } from "@/src/lib/mongodb/client";

export async function GET(request: Request) {
  const session = await getServerSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["doctor", "receptionist"].includes(String(session.role))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim();
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? "8") || 8, 1), 20);
  if (!q) return NextResponse.json({ medications: [] });
  if (q.length > 80) return NextResponse.json({ error: "Search query too long" }, { status: 400 });

  const db = await getDb();
  const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const medications = await db
    .collection("medication_catalog")
    .find({ $or: [{ name: regex }, { generic_name: regex }, { aliases: regex }] })
    .limit(limit)
    .toArray()
    .then((rows) =>
      rows.map((row) => ({
        id: row._id.toString(),
        name: row.name,
        generic_name: row.generic_name ?? null,
        ingredients: Array.isArray(row.ingredients) ? row.ingredients : [],
        catalog_version: row.catalog_version ?? null,
        default_strength: row.default_strength ?? null,
        default_route: row.default_route ?? null,
        aliases: Array.isArray(row.aliases) ? row.aliases : [],
      }))
    );

  return NextResponse.json({ medications });
}