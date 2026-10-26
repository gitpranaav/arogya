/**
 * Disposable MongoDB replica-set smoke verification, run only against local port 27029.
 * Uses a random database and synthetic records; does not read/write the application DB.
 * This tests MongoDB semantics, not the Next.js API workflows or clinical correctness.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });

const uri = process.env.MONGODB_TEST_URI;
if (!uri) throw new Error("Set MONGODB_TEST_URI for a disposable local replica set");
const parsed = new URL(uri);
if (parsed.protocol !== "mongodb:" || parsed.hostname !== "127.0.0.1" || parsed.port !== "27029" ||
    parsed.username || parsed.password || parsed.searchParams.get("directConnection") !== "true") {
  throw new Error("Safety check: use only mongodb://127.0.0.1:27029/?directConnection=true&replicaSet=rs0 (no credentials)");
}
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
const name = `mediflow_verify_${randomBytes(6).toString("hex")}`;
const db = client.db(name);
let checks = 0;
async function check(label, fn) { await fn(); checks++; console.log(`PASS ${checks}: ${label}`); }
try {
  await client.connect();
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName) throw new Error("MongoDB is not a replica set");

  await check("unique indexes reject duplicate synthetic transcript and EMR records", async () => {
    await db.collection("transcripts").createIndex({ consultation_id: 1 }, { unique: true });
    await db.collection("emr_entries").createIndex({ consultation_id: 1 }, { unique: true });
    await db.collection("consultation_audit_events").createIndex({ consultation_id: 1, sequence_no: 1 }, { unique: true });
    const cid = new ObjectId();
    await db.collection("transcripts").insertOne({ consultation_id: cid, segments: [] });
    await assert.rejects(db.collection("transcripts").insertOne({ consultation_id: cid, segments: [] }), e => e?.code === 11000);
  });

  await check("transaction abort rolls back a multi-collection clinical write", async () => {
    const pid = new ObjectId();
    const s = client.startSession();
    try {
      await assert.rejects(s.withTransaction(async () => {
        await db.collection("patients").insertOne({ _id: pid, name: "SYNTHETIC_DO_NOT_USE" }, { session: s });
        await db.collection("patient_doctors").insertOne({ patient_id: pid, doctor_id: new ObjectId() }, { session: s });
        throw new Error("intentional_test_rollback");
      }), /intentional_test_rollback/);
    } finally { await s.endSession(); }
    assert.equal(await db.collection("patients").countDocuments({ _id: pid }), 0);
    assert.equal(await db.collection("patient_doctors").countDocuments({ patient_id: pid }), 0);
  });

  const cid = new ObjectId();
  await db.collection("emr_entries").insertOne({ consultation_id: cid, version: 0, snapshot: { chief_complaint: "SYNTHETIC" } });
  await check("competing compare-and-swap EMR updates allow only one writer", async () => {
    const col = db.collection("emr_entries");
    const [a, b] = await Promise.all([
      col.updateOne({ consultation_id: cid, version: 0 }, { $inc: { version: 1 }, $set: { snapshot: { assessment: "A" } } }),
      col.updateOne({ consultation_id: cid, version: 0 }, { $inc: { version: 1 }, $set: { snapshot: { assessment: "B" } } }),
    ]);
    assert.equal(a.matchedCount + b.matchedCount, 1);
    assert.equal((await col.findOne({ consultation_id: cid })).version, 1);
  });

  await check("failed audit insert aborts its EMR update in one transaction", async () => {
    const audits = db.collection("consultation_audit_events");
    await audits.insertOne({ consultation_id: cid, sequence_no: 1, event_hash: "synthetic-first" });
    const before = await db.collection("emr_entries").findOne({ consultation_id: cid });
    const s = client.startSession();
    try {
      await assert.rejects(s.withTransaction(async () => {
        await db.collection("emr_entries").updateOne({ consultation_id: cid, version: 1 }, { $inc: { version: 1 } }, { session: s });
        await audits.insertOne({ consultation_id: cid, sequence_no: 1, event_hash: "duplicate-audit" }, { session: s });
      }), e => e?.code === 11000);
    } finally { await s.endSession(); }
    assert.equal((await db.collection("emr_entries").findOne({ consultation_id: cid })).version, before.version);
    assert.equal(await audits.countDocuments({ consultation_id: cid }), 1);
  });

  await check("duplicate batch IDs cannot be accepted twice", async () => {
    const batches = db.collection("emr_extraction_batches");
    await batches.insertOne({ _id: "synthetic-batch-1", status: "done" });
    await assert.rejects(batches.insertOne({ _id: "synthetic-batch-1", status: "processing" }), e => e?.code === 11000);
    assert.equal((await batches.findOne({ _id: "synthetic-batch-1" })).status, "done");
  });
  console.log(`PASS all ${checks} disposable MongoDB checks (${hello.setName})`);
} finally {
  // Only the randomly generated synthetic database is removed.
  try { await db.dropDatabase(); } catch (err) { console.error("Could not clean up synthetic test database:", name, err); }
  await client.close();
}
