"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/src/components/ui/Card";
import { Badge } from "@/src/components/ui/Badge";
import { FamilyGraphPanel } from "@/src/components/history/FamilyGraphPanel";
import { Button } from "@/src/components/ui/Button";

type HistoryPayload = {
  id?: string;
  patient_id?: string;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
  allergies?: unknown;
  problem_list?: unknown;
  past_surgeries?: unknown;
  family_history?: unknown;
  social_history?: unknown;
  immunizations?: unknown;
  active_meds?: unknown;
} | null;

type ContextResponse = {
  doctor?: { specialty_code?: string; specialization?: string | null; name?: string | null } | null;
  patient?: { id?: string; name?: string | null; phone?: string | null; dob?: string | null; gender?: string | null } | null;
  history?: HistoryPayload;
  specialty_history?: { lmp?: string; g_p_a_l?: string; cycle_history?: string; [key: string]: unknown } | null;
  latest_consultation?: {
    consultation_id?: string;
    created_at?: string;
    visit_type?: string | null;
    status?: string | null;
    chief_complaint?: string | null;
    assessment?: string | null;
    clinical_summary?: string | null;
    patient_summary?: string | null;
    diagnoses?: Array<{ diagnosis_text?: string | null; icd_code_id?: string | null; is_primary?: boolean }>;
    medications?: unknown;
  } | null;
  recent?: Array<{ created_at: string; clinical_summary: string | null }> | null;
};

function titleFromSpecialtyCode(value: string | undefined) {
  if (!value) return "Specialty history";
  return `${value.replace(/_/g, " ").replace(/\b\w/g, (s) => s.toUpperCase())} history`;
}

function formatDate(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateTime(value: string | Date | null | undefined) {
  if (value == null) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function listOrDash(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return "—";
  return value.map((x) => String(x)).join(", ");
}

function textOrDash(value: unknown) {
  if (value == null) return "—";
  const s = String(value).trim();
  return s.length ? s : "—";
}

function fieldLabel(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (s) => s.toUpperCase());
}

function omitSpecialtyKeys(entry: Record<string, unknown>) {
  const blocked = new Set(["lmp", "g_p_a_l", "cycle_history", "created_at", "updated_at", "patient_id", "doctor_id", "specialty_code", "_id"]);
  return Object.entries(entry).filter(([key, value]) => !blocked.has(key) && value != null && String(value).trim().length > 0);
}

function normalizeMedicationLabel(value: unknown) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const med = value as { name?: unknown; dosage?: unknown; frequency?: unknown; duration?: unknown; route?: unknown };
  const parts = [med.name, med.dosage, med.frequency, med.duration, med.route]
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  return parts.join(" · ");
}

const ARRAY_KEYS = new Set(["allergies", "problem_list", "past_surgeries", "immunizations", "active_meds", "diagnoses"]);

function parseEditorValue(key: string, value: string, wasArray: boolean) {
  if (wasArray || ARRAY_KEYS.has(key)) {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return value.trim();
}

function valueToEditorText(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean).join(", ");
  return String(value ?? "");
}

export function PatientHistoryPanel({ consultationId, patientId }: { consultationId?: string; patientId?: string }) {
  const [data, setData] = useState<ContextResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [pendingCore, setPendingCore] = useState<Record<string, unknown>>({});
  const [pendingSpecialty, setPendingSpecialty] = useState<Record<string, unknown>>({});
  const [editing, setEditing] = useState<{ scope: "core" | "specialty"; key: string; asArray: boolean } | null>(null);
  const [editorValue, setEditorValue] = useState("");

  const endpoint = patientId ? `/api/patients/${patientId}/history` : consultationId ? `/api/consultations/context/${consultationId}` : null;

  useEffect(() => {
    if (!endpoint) return;
    let cancelled = false;
    (async () => {
      setError(null);
      const res = await fetch(endpoint);
      const json = await res.json();
      if (cancelled) return;
      if (!res.ok) setError(json.error ?? "Failed to load history");
      else {
        setData(json);
        setPendingCore({});
        setPendingSpecialty({});
        setSaveMsg(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  const targetPatientId = patientId ?? data?.patient?.id ?? data?.history?.patient_id;
  const hasPending = Object.keys(pendingCore).length > 0 || Object.keys(pendingSpecialty).length > 0;

  const startEdit = (scope: "core" | "specialty", key: string, value: unknown) => {
    setEditing({ scope, key, asArray: Array.isArray(value) });
    setEditorValue(valueToEditorText(value));
  };

  const commitEdit = () => {
    if (!editing) return;
    const next = parseEditorValue(editing.key, editorValue, editing.asArray);
    if (editing.scope === "core") {
      setPendingCore((prev) => ({ ...prev, [editing.key]: next }));
    } else {
      setPendingSpecialty((prev) => ({ ...prev, [editing.key]: next }));
    }
    setEditing(null);
    setEditorValue("");
    setSaveMsg(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditorValue("");
  };

  const saveChanges = async () => {
    if (!targetPatientId || !hasPending || saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(`/api/patients/${targetPatientId}/history`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          core: pendingCore,
          specialty_history: pendingSpecialty,
          consultation_id: consultationId,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSaveMsg(json.error ?? "Save failed");
        return;
      }

      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          history: {
            ...(prev.history ?? {}),
            ...pendingCore,
            updated_at: new Date().toISOString(),
          },
          specialty_history: {
            ...(prev.specialty_history ?? {}),
            ...pendingSpecialty,
          },
        };
      });
      setPendingCore({});
      setPendingSpecialty({});
      setSaveMsg("Saved");
    } catch {
      setSaveMsg("Save failed");
    } finally {
      setSaving(false);
    }
  };

  const showValue = (scope: "core" | "specialty", key: string, fallback: unknown) => {
    if (scope === "core" && key in pendingCore) return pendingCore[key];
    if (scope === "specialty" && key in pendingSpecialty) return pendingSpecialty[key];
    return fallback;
  };

  const renderEditable = (scope: "core" | "specialty", key: string, value: unknown, multiline = false) => {
    const active = editing?.scope === scope && editing.key === key;
    const resolved = showValue(scope, key, value);
    if (active) {
      const editorRows = multiline ? 4 : Math.min(Math.max(editorValue.split(/\n|,/).length, 2), 5);
      return (
        <div className="space-y-1 rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-secondary)/0.35)] p-2">
          <textarea
            rows={editorRows}
            className="w-full resize-y rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--accent)/0.25)] bg-[hsl(var(--bg-card))] px-2 py-1.5 text-sm leading-5 text-[hsl(var(--text-primary))] shadow-[var(--shadow-sm)] outline-none"
            value={editorValue}
            onChange={(e) => setEditorValue(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="secondary" className="h-7 px-2 text-xs" onClick={commitEdit}>
              Done
            </Button>
            <button type="button" className="text-xs text-[hsl(var(--text-muted))] underline" onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      );
    }

    const text = Array.isArray(resolved) ? listOrDash(resolved) : multiline ? textOrDash(resolved) : textOrDash(resolved);
    return (
      <p
        className="cursor-text whitespace-pre-wrap break-words text-[13px] leading-5 text-[hsl(var(--text-primary))]"
        onDoubleClick={() => startEdit(scope, key, resolved)}
        title="Double-click to edit"
      >
        {text}
      </p>
    );
  };

  return (
    <div className="space-y-3">
      <Card className="overflow-hidden border-[hsl(var(--accent)/0.18)] bg-[linear-gradient(180deg,hsl(var(--accent)/0.08)_0%,hsl(var(--bg-card))_38%)] shadow-[var(--shadow-sm)]">
        <CardHeader className="border-b border-[hsl(var(--accent)/0.12)] bg-[hsl(var(--accent)/0.04)] pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-sm tracking-tight text-[hsl(var(--text-primary))]">Patient History</CardTitle>
              <p className="text-[11px] text-[hsl(var(--text-muted))]">Editable history, specialty notes, and latest encounter context.</p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {data?.doctor?.specialty_code ? <Badge variant="outline">{data.doctor.specialty_code}</Badge> : null}
              {saveMsg ? <span className="text-xs text-[hsl(var(--text-muted))]">{saveMsg}</span> : null}
              {hasPending ? (
                <Button type="button" size="sm" className="h-7 px-3 text-xs shadow-[var(--shadow-sm)]" onClick={saveChanges} loading={saving}>
                  Save changes
                </Button>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? <p className="text-xs text-[hsl(var(--danger))]">{error}</p> : null}
          <p className="text-[10px] uppercase tracking-[0.18em] text-[hsl(var(--text-muted))]">Double-click any history field to edit, then click Save.</p>

          <div className="space-y-3 rounded-[var(--radius)] border border-[hsl(var(--accent)/0.14)] bg-[hsl(var(--accent)/0.04)] p-3 shadow-[var(--shadow-sm)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--text-secondary))]">Core history</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="group rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--accent)/0.12)] bg-[linear-gradient(180deg,hsl(var(--bg-card))_0%,hsl(var(--bg-secondary)/0.18)_100%)] p-3 shadow-[var(--shadow-sm)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]">
                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Allergies</p>
                {renderEditable("core", "allergies", data?.history?.allergies)}
              </div>
              <div className="group rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--accent)/0.12)] bg-[linear-gradient(180deg,hsl(var(--bg-card))_0%,hsl(var(--bg-secondary)/0.18)_100%)] p-3 shadow-[var(--shadow-sm)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]">
                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Problem list</p>
                {renderEditable("core", "problem_list", data?.history?.problem_list)}
              </div>
              <div className="group rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--accent)/0.12)] bg-[linear-gradient(180deg,hsl(var(--bg-card))_0%,hsl(var(--bg-secondary)/0.18)_100%)] p-3 shadow-[var(--shadow-sm)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]">
                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Past surgeries</p>
                {renderEditable("core", "past_surgeries", data?.history?.past_surgeries)}
              </div>
              <div className="group rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--accent)/0.12)] bg-[linear-gradient(180deg,hsl(var(--bg-card))_0%,hsl(var(--bg-secondary)/0.18)_100%)] p-3 shadow-[var(--shadow-sm)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)]">
                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Immunizations</p>
                {renderEditable("core", "immunizations", data?.history?.immunizations)}
              </div>
              <div className="group rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--accent)/0.12)] bg-[linear-gradient(180deg,hsl(var(--bg-card))_0%,hsl(var(--bg-secondary)/0.18)_100%)] p-3 shadow-[var(--shadow-sm)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] sm:col-span-2">
                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Family history</p>
                {renderEditable("core", "family_history", data?.history?.family_history, true)}
              </div>
              <div className="group rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--accent)/0.12)] bg-[linear-gradient(180deg,hsl(var(--bg-card))_0%,hsl(var(--bg-secondary)/0.18)_100%)] p-3 shadow-[var(--shadow-sm)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] sm:col-span-2">
                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Social history</p>
                {renderEditable("core", "social_history", data?.history?.social_history, true)}
              </div>
              <div className="group rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--accent)/0.12)] bg-[linear-gradient(180deg,hsl(var(--bg-card))_0%,hsl(var(--bg-secondary)/0.18)_100%)] p-3 shadow-[var(--shadow-sm)] transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] sm:col-span-2">
                <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Active meds</p>
                {renderEditable("core", "active_meds", data?.history?.active_meds)}
              </div>
            </div>
          </div>

          {data?.specialty_history ? (
            <div className="space-y-3 rounded-[var(--radius)] border border-[hsl(var(--border))] bg-[linear-gradient(180deg,hsl(var(--bg-secondary)/0.34)_0%,hsl(var(--bg-card))_100%)] p-3 shadow-[var(--shadow-sm)]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--text-secondary))]">{titleFromSpecialtyCode(data?.doctor?.specialty_code)}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Last consultation</p>
                  <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">{textOrDash(data.specialty_history?.last_consultation_at)}</p>
                </div>
                <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Last diagnosis</p>
                  <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">{textOrDash(data.specialty_history?.last_diagnosis)}</p>
                </div>
                <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5 sm:col-span-2">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Diagnoses</p>
                  <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">{listOrDash(data.specialty_history?.diagnoses)}</p>
                </div>
                <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5 sm:col-span-2">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Active meds</p>
                  <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">{listOrDash(data.specialty_history?.active_meds)}</p>
                </div>
              </div>

              {data?.doctor?.specialty_code === "gynec" ? (
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5">
                    <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">LMP</p>
                    <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">{data?.specialty_history?.lmp ?? "—"}</p>
                  </div>
                  <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5">
                    <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">G/P/A/L</p>
                    <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">{data?.specialty_history?.g_p_a_l ?? "—"}</p>
                  </div>
                  <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5 sm:col-span-2">
                    <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Cycle history</p>
                    <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">{data?.specialty_history?.cycle_history ?? "—"}</p>
                  </div>
                </div>
              ) : null}

              <div className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
                {omitSpecialtyKeys(data.specialty_history as Record<string, unknown>).map(([key, value]) => (
                  <div key={key} className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5 shadow-[var(--shadow-sm)]">
                    <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">{fieldLabel(key)}</p>
                    {renderEditable("specialty", key, value, !Array.isArray(value))}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {data?.latest_consultation ? (
            <div className="space-y-3 rounded-[var(--radius)] border border-[hsl(var(--border))] bg-[linear-gradient(180deg,hsl(var(--bg-secondary)/0.34)_0%,hsl(var(--bg-card))_100%)] p-3 shadow-[var(--shadow-sm)]">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--text-secondary))]">Latest consultation</p>
                {data.latest_consultation.visit_type ? <Badge variant="outline">{data.latest_consultation.visit_type}</Badge> : null}
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Date</p>
                  <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">{formatDateTime(data.latest_consultation.created_at)}</p>
                </div>
                <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Status</p>
                  <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">{textOrDash(data.latest_consultation.status)}</p>
                </div>
                <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5 sm:col-span-2">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Chief complaint</p>
                  <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">{textOrDash(data.latest_consultation.chief_complaint)}</p>
                </div>
                <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5 sm:col-span-2">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Assessment</p>
                  <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">{textOrDash(data.latest_consultation.assessment)}</p>
                </div>
                <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5 sm:col-span-2">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Clinical summary</p>
                  <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">{textOrDash(data.latest_consultation.clinical_summary)}</p>
                </div>
                <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5 sm:col-span-2">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Patient summary</p>
                  <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">{textOrDash(data.latest_consultation.patient_summary)}</p>
                </div>
                <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5 sm:col-span-2">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Diagnoses</p>
                  <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">
                    {listOrDash((data.latest_consultation.diagnoses ?? []).map((item) => item.diagnosis_text ?? ""))}
                  </p>
                </div>
                <div className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-2.5 sm:col-span-2">
                  <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">Medications</p>
                  <p className="text-[13px] leading-5 text-[hsl(var(--text-primary))]">
                    {listOrDash((Array.isArray(data.latest_consultation.medications) ? data.latest_consultation.medications : []).map((item) => normalizeMedicationLabel(item)))}
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[hsl(var(--text-secondary))]">Recent summaries</p>
            <div className="space-y-2">
              {(data?.recent ?? []).length ? (
                (data?.recent ?? []).map((row, idx) => (
                  <div key={`${row.created_at}-${idx}`} className="rounded-[var(--radius)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] p-3 shadow-[var(--shadow-sm)]">
                    <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-[hsl(var(--text-muted))]">{formatDate(row.created_at)}</p>
                    <p className="mt-1 text-[13px] leading-5 text-[hsl(var(--text-primary))]">{row.clinical_summary ?? "No summary"}</p>
                  </div>
                ))
              ) : (
                <p className="text-xs text-[hsl(var(--text-muted))]">No recent summaries.</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
      {targetPatientId ? <FamilyGraphPanel patientId={targetPatientId} consultationId={consultationId} /> : null}
    </div>
  );
}

