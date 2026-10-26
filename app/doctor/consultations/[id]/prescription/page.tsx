import Image from "next/image";
import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";

import { PrescriptionPrintButton } from "@/src/components/doctor/consultation/PrescriptionPrintButton";
import { Card } from "@/src/components/ui/Card";
import { getServerContext } from "@/src/lib/mongodb/server";

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

async function fetchPrescriptionData(id: string) {
  const { db, session } = await getServerContext();
  const doctorObjectId = new ObjectId(session.uid);

  const [consultation, doctor] = await Promise.all([
    db.collection("consultations").findOne({ _id: new ObjectId(id), doctor_id: doctorObjectId }),
    db.collection("users").findOne({ _id: doctorObjectId }),
  ]);

  if (!consultation || consultation.status !== "completed") return null;

  const [patient, prescription] = await Promise.all([
    consultation.patient_id ? db.collection("patients").findOne({ _id: consultation.patient_id }) : null,
    db.collection("prescriptions").findOne({ consultation_id: consultation._id, doctor_id: doctorObjectId, patient_id: consultation.patient_id }),
  ]);

  if (!prescription || !Number.isSafeInteger(prescription.approved_emr_version) ||
      !prescription.approved_snapshot_fingerprint || !prescription.reviewed_by || !prescription.reviewed_at) return null;

  return {
    consultation,
    patient,
    doctor,
    prescription,
  };
}

export default async function PrescriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) notFound();
  const data = await fetchPrescriptionData(id);
  if (!data) notFound();

  const clinicName = clean(data.doctor?.clinic_name) || "Clinic / Hospital Name";
  const clinicAddress = clean(data.doctor?.clinic_address);
  const clinicPhone = clean(data.doctor?.clinic_phone);
  const registrationNumber = clean(data.doctor?.registration_number);
  const doctorName = clean(data.doctor?.doctor_name) || clean(data.doctor?.name) || "Doctor";
  const diagnosisList = Array.isArray(data.prescription?.diagnosis_text) ? data.prescription.diagnosis_text.map((item: unknown) => clean(item)).filter(Boolean) : [];
  const diagnosis = diagnosisList.join("; ") || "No diagnosis recorded";
  const medications = Array.isArray(data.prescription?.medications) ? data.prescription.medications : [];

  return (
    <div className="mx-auto max-w-5xl bg-[hsl(var(--bg-primary))] px-4 py-4 text-[hsl(var(--text-primary))] print:max-w-none print:px-0 print:py-0">
      <div className="mb-3 flex items-center justify-between gap-3 print:hidden">
        <PrescriptionPrintButton />
      </div>

      <Card className="overflow-hidden border-[1.5px] border-black/20 bg-white text-black shadow-none print:border-0">
        <div className="p-4 sm:p-5">
          <div className="flex items-start gap-4 border-b border-black/20 pb-3">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-black/20 bg-white">
              <Image src="/caduceus.svg" alt="Caduceus" width={48} height={48} className="h-12 w-12 object-contain" priority />
            </div>
            <div className="min-w-0 flex-1 text-center">
              <div className="text-2xl font-semibold uppercase tracking-wide">{clinicName}</div>
              {clinicAddress ? <div className="mt-1 text-sm">{clinicAddress}</div> : null}
              <div className="mt-1 flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm">
                {clinicPhone ? <span>Phone: {clinicPhone}</span> : null}
                {registrationNumber ? <span>Reg. No: {registrationNumber}</span> : null}
              </div>
            </div>
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-black/20 text-3xl font-semibold text-[hsl(var(--accent))]">
              ℞
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-start justify-between gap-3 text-sm">
            <div>
              <div className="font-semibold">Patient: {clean(data.patient?.name) || "Unknown"}</div>
              <div>Age / Sex: {clean(data.patient?.age) || ""}{clean(data.patient?.gender) ? ` / ${clean(data.patient?.gender)}` : ""}</div>
            </div>
            <div className="text-right">
              <div>Date: {formatDate(data.consultation.ended_at ?? data.consultation.created_at)}</div>
              <div>Consultation ID: {String(data.consultation._id)}</div>
            </div>
          </div>

          <div className="mt-4 border-t border-black/20 pt-3">
            <div className="text-sm font-semibold uppercase tracking-wide">Diagnosis</div>
            <div className="mt-1 text-base font-semibold">{diagnosis}</div>
          </div>

          <div className="mt-4 border-t border-black/20 pt-3">
            <div className="text-sm font-semibold uppercase tracking-wide">Prescription</div>
            <table className="mt-2 w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-black/20 text-left">
                  <th className="py-2 pr-2 font-semibold">#</th>
                  <th className="py-2 pr-2 font-semibold">Medicine</th>
                  <th className="py-2 pr-2 font-semibold">Dosage</th>
                  <th className="py-2 pr-2 font-semibold">Timing</th>
                  <th className="py-2 pr-2 font-semibold">Duration</th>
                  <th className="py-2 pr-2 font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody>
                {medications.map((med: any, index: number) => (
                  <tr key={`${clean(med.name)}-${index}`} className="border-b border-black/10 align-top">
                    <td className="py-2 pr-2">{index + 1}</td>
                    <td className="py-2 pr-2 font-semibold uppercase">{clean(med.name)}</td>
                    <td className="py-2 pr-2">
                      <div>{clean(med.dosage) || "-"}</div>
                    </td>
                    <td className="py-2 pr-2">{clean(med.frequency) || "-"}</td>
                    <td className="py-2 pr-2">{clean(med.duration) || "-"}</td>
                    <td className="py-2 pr-2">{[clean(med.route), clean(med.instructions)].filter(Boolean).join(" - ") || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 border-t border-black/20 pt-3">
            <div className="text-right">
              <div className="mt-8 text-sm font-semibold">{doctorName}</div>
              <div className="text-sm">Signature / Stamp</div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
