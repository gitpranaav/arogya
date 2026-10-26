import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("Missing MONGODB_URI");

const client = new MongoClient(uri);
await client.connect();
const db = client.db("cliniq");

await Promise.all([
  db.collection("users").createIndex({ email: 1 }, { unique: true }),
  db.collection("patients").createIndex({ phone: 1 }, { unique: true }),
  db.collection("patients").createIndex({ created_at: -1 }),
  db.collection("patients").createIndex({ doctor_id: 1, created_at: -1 }),
  db.collection("patient_doctors").createIndex({ patient_id: 1, doctor_id: 1 }, { unique: true }),
  db.collection("patient_doctors").createIndex({ doctor_id: 1, created_at: -1 }),
  db.collection("patient_history").createIndex({ patient_id: 1 }, { unique: true }),
  db.collection("patient_specialty_history").createIndex({ patient_id: 1, specialty_code: 1, doctor_id: 1 }, { unique: true }),
  db.collection("patient_specialty_history").createIndex({ doctor_id: 1, specialty_code: 1, updated_at: -1 }),
  db.collection("consultations").createIndex({ doctor_id: 1, created_at: -1 }),
  db.collection("consultations").createIndex({ patient_id: 1, created_at: -1 }),
  db.collection("transcripts").createIndex({ consultation_id: 1 }, { unique: true }),
  db.collection("emr_entries").createIndex({ consultation_id: 1 }, { unique: true }),
  db.collection("emr_diagnoses").createIndex({ emr_entry_id: 1 }),
  db.collection("icd10_codes").createIndex({ code: 1 }, { unique: true }),
  db.collection("icd10_codes").createIndex({ description: "text", code: "text" }),
  db.collection("prescriptions").createIndex({ consultation_id: 1 }, { unique: true }),
  db.collection("api_usage_limits").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
  db.collection("emr_extraction_batches").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
]);

console.log("Core collections and indexes ready.");
await client.close();
