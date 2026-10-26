import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";

import { ConsultationWorkspace } from "@/src/components/doctor/consultation/ConsultationWorkspace";
import { getServerContext } from "@/src/lib/mongodb/server";

type ConsultationPageProps = {
  params: Promise<{ id: string }>;
};

interface ConsultationRecord {
  id: string;
  type: string | null;
  status: string | null;
  started_at: string | null;
  follow_up_due_at?: string | null;
  patients?: { name: string } | null;
}

export default async function ConsultationPage({ params }: ConsultationPageProps) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) notFound();
  const { db, session } = await getServerContext();
  const doctorObjectId = new ObjectId(session.uid);
  const consultationDoc = await db.collection("consultations").findOne({ _id: new ObjectId(id), doctor_id: doctorObjectId });
  if (!consultationDoc) notFound();
  const link = consultationDoc.patient_id
    ? await db.collection("patient_doctors").findOne({ patient_id: consultationDoc.patient_id, doctor_id: doctorObjectId })
    : null;
  if (consultationDoc.patient_id && !link) notFound();

  const patient = consultationDoc.patient_id ? await db.collection("patients").findOne({ _id: consultationDoc.patient_id }) : null;
  const consultation = {
    id: consultationDoc._id.toString(),
    type: consultationDoc.type ?? null,
    status: consultationDoc.status ?? null,
    started_at: consultationDoc.started_at ?? null,
    follow_up_due_at: consultationDoc.follow_up_due_at ?? null,
    patients: patient ? { name: patient.name } : null,
  } as ConsultationRecord;
  if (!consultation) notFound();

  const patientId = consultationDoc.patient_id ? consultationDoc.patient_id.toString() : null;

  return (
    <ConsultationWorkspace
      consultationId={consultation.id}
      patientId={patientId}
      patientName={consultation.patients?.name ?? "Unknown Patient"}
      consultationType={consultation.type ?? "General"}
      initialStatus={consultation.status}
      initialStartedAt={consultation.started_at}
      initialFollowUpDueAt={consultation.follow_up_due_at ?? null}
    />
  );
}
