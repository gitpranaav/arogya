import { MongoClient } from "mongodb";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";

dotenv.config({ path: ".env.local" });

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("Missing MONGODB_URI");

// Seed uses the same versioned ingredient/alias catalog as browser and server safety checks.
// The mapping is a curated software demo dataset, not a clinically certified formulary.
const catalog = JSON.parse(readFileSync(new URL("../../src/lib/clinical/medicationCatalog.json", import.meta.url), "utf8"));
const medicines = catalog.entries;

const client = new MongoClient(uri);
await client.connect();
const db = client.db("cliniq");

await db.collection("medication_catalog").bulkWrite(
  medicines.map(({ id, name, generic_name, ingredients, aliases, default_route, default_strength }) => ({
    updateOne: {
      filter: { name },
      update: {
        $set: {
          name,
          generic_name,
          default_route,
          default_strength,
          catalog_id: id, catalog_version: catalog.version, ingredients,
          aliases: Array.from(new Set([generic_name, name.toLowerCase(), ...aliases])),
          updated_at: new Date().toISOString(),
        },
        $setOnInsert: {
          created_at: new Date().toISOString(),
        },
      },
      upsert: true,
    },
  }))
);

console.log(`Seeded ${medicines.length} medication catalog entries.`);
await client.close();