"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/src/components/ui/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/Card";
import { Input } from "@/src/components/ui/Input";
import { Select } from "@/src/components/ui/Select";
import { consultationTypeOptions } from "@/src/lib/consultations/visitTypes";

const FOLLOW_NONE = "_none";

interface PriorConsultationOption {
  id: string;
  created_at: string;
  type: string;
  chief_complaint: string | null;
}

interface PatientOption {
  id: string;
  name: string;
}

interface ReceptionistIntakeCardProps {
  patients: PatientOption[];
}

export function ReceptionistIntakeCard({ patients }: ReceptionistIntakeCardProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [patientId, setPatientId] = useState<string>("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [chiefComplaint, setChiefComplaint] = useState("");
  const [visitType, setVisitType] = useState("General");
  const [priorOptions, setPriorOptions] = useState<PriorConsultationOption[]>([]);
  const [followUpOfId, setFollowUpOfId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return patients.slice(0, 12);
    return patients.filter((patient) => patient.name.toLowerCase().includes(q)).slice(0, 12);
  }, [patients, query]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!pickerRef.current) return;
      if (!pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, []);

  useEffect(() => {
    if (!patientId) {
      setPriorOptions([]);
      setFollowUpOfId("");
      return;
    }
    setFollowUpOfId("");
    setPriorOptions([]);
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/patients/${patientId}/consultations`);
      const data = (await res.json()) as { consultations?: PriorConsultationOption[] };
      if (cancelled) return;
      if (res.ok && Array.isArray(data.consultations)) setPriorOptions(data.consultations);
      else setPriorOptions([]);
    })();
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  const followUpSelectOptions = useMemo(() => {
    return [
      { value: FOLLOW_NONE, label: "None (new episode)" },
      ...priorOptions.map((c) => {
        const d = new Date(c.created_at);
        const dateLabel = Number.isNaN(d.getTime()) ? c.created_at : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
        const tail = c.chief_complaint?.trim() ? ` — ${c.chief_complaint.trim().slice(0, 48)}` : "";
        return { value: c.id, label: `${dateLabel} · ${c.type}${tail}` };
      }),
    ];
  }, [priorOptions]);

  async function saveIntake() {
    setError(null);
    setSuccess(null);
    if (!patientId) {
      setError("Select a patient first.");
      return;
    }
    setLoading(true);
    try {
      const createRes = await fetch("/api/consultations/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patient_id: patientId,
          type: visitType,
          chief_complaint: chiefComplaint.trim() || undefined,
          follow_up_of: followUpOfId.trim() || undefined,
        }),
      });
      const createData = (await createRes.json()) as { consultation_id?: string; error?: string };
      if (!createRes.ok || !createData.consultation_id) {
        setError(createData.error ?? "Could not start intake consultation.");
        return;
      }

      const snapshot = {
        chief_complaint: chiefComplaint.trim() || null,
      };

      const emrRes = await fetch(`/api/emr/by-consultation/${createData.consultation_id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot, expected_version: 0 }),
      });
      const emrData = (await emrRes.json()) as { error?: string };
      if (!emrRes.ok) {
        setError(emrData.error ?? "Consultation was created but intake details failed to save.");
        return;
      }

      await fetch(`/api/consultations/${createData.consultation_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intake_status: "done", intake_completed_at: new Date().toISOString() }),
      });

      setSuccess("Intake saved. Doctor can continue this consultation.");
      setChiefComplaint("");
      const selected = patients.find((patient) => patient.id === patientId);
      setQuery(selected?.name ?? "");
      router.refresh();
    } catch {
      setError("Failed to save intake details.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reception Intake</CardTitle>
        <CardDescription>Select patient and chief complaint before doctor starts.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5" ref={pickerRef}>
          <Input
            label="Patient"
            value={query}
            onFocus={() => setPickerOpen(true)}
            onChange={(event) => {
              setQuery(event.target.value);
              setPatientId("");
              setPickerOpen(true);
            }}
            placeholder="Search and select patient"
          />
          {pickerOpen ? (
            <div className="max-h-56 overflow-auto rounded-[calc(var(--radius)-2px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-1">
              {filtered.length ? (
                filtered.map((patient) => (
                  <button
                    key={patient.id}
                    type="button"
                    className="flex w-full items-center justify-between rounded-[calc(var(--radius)-4px)] px-2 py-2 text-left text-sm text-[hsl(var(--text-primary))] hover:bg-[hsl(var(--bg-secondary))]"
                    onClick={() => {
                      setPatientId(patient.id);
                      setQuery(patient.name);
                      setPickerOpen(false);
                    }}
                  >
                    <span>{patient.name}</span>
                  </button>
                ))
              ) : (
                <p className="px-2 py-2 text-xs text-[hsl(var(--text-muted))]">No patient matches search</p>
              )}
            </div>
          ) : null}
          {patientId ? <p className="text-xs text-[hsl(var(--text-muted))]">Selected patient ready</p> : null}
        </div>
        <Select value={visitType} onValueChange={setVisitType} options={consultationTypeOptions} placeholder="Visit type" />
        {patientId && priorOptions.length ? (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-[hsl(var(--text-secondary))]">Follow-up of (optional)</p>
            <Select
              value={followUpOfId || FOLLOW_NONE}
              onValueChange={(v) => setFollowUpOfId(v === FOLLOW_NONE ? "" : v)}
              options={followUpSelectOptions}
              placeholder="Link to prior visit"
            />
          </div>
        ) : null}
        <Input
          label="Chief complaint"
          value={chiefComplaint}
          onChange={(event) => setChiefComplaint(event.target.value)}
          placeholder="Fever since 2 days"
        />
        {error ? <p className="text-xs text-[hsl(var(--danger))]">{error}</p> : null}
        {success ? <p className="text-xs text-[hsl(var(--success))]">{success}</p> : null}
        <Button onClick={saveIntake} loading={loading}>
          Save Intake and Create Consultation
        </Button>
      </CardContent>
    </Card>
  );
}
