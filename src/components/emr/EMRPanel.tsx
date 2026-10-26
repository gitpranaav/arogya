"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { AISuggestions } from "@/src/components/emr/AISuggestions";
import { ExtractButton } from "@/src/components/emr/ExtractButton";
import { ICD10Search, type ICDItem } from "@/src/components/emr/ICD10Search";
import { Button } from "@/src/components/ui/Button";
import { Input } from "@/src/components/ui/Input";

interface Props {
  consultationId: string;
  emrEntryId?: string;
  transcriptText?: string;
}

export function EMRPanel({ consultationId, emrEntryId, transcriptText = "" }: Props) {
  const [form, setForm] = useState<any>({
    chief_complaint: "",
    history_of_present_illness: "",
    symptoms: [] as string[],
    physical_examination: "",
    assessment: "",
    plan: "",
    clinical_summary: "",
    patient_summary: "",
    medications: [] as Array<{ name: string; dosage: string; frequency: string; duration: string; route: string }>,
    lab_tests_ordered: [] as string[],
  });
  const [diagnoses, setDiagnoses] = useState<Array<ICDItem & { is_primary?: boolean; ai?: boolean; confidence?: string }>>([]);
  const [aiSuggestions, setAiSuggestions] = useState<Array<{ code: string; description: string; confidence?: "high" | "medium" | "low" }>>([]);
  const [saveText, setSaveText] = useState("Not saved yet");
  const [version, setVersion] = useState<number | null>(null);
  const manualEditRef = useRef(false);

  const savePayload = useMemo(() => ({ snapshot: {
    chief_complaint: form.chief_complaint ?? null, symptoms: form.symptoms ?? [],
    assessment: form.assessment ?? null, plan: form.plan ?? null,
    clinical_summary: form.clinical_summary ?? null,
  }, expected_version: version }), [form, version]);
  useEffect(() => {
    if (!emrEntryId) return;
    let cancelled = false;
    void fetch(`/api/emr/by-consultation/${consultationId}`).then(r => r.json()).then(data => {
      if (!cancelled) setVersion(Number(data.emr_entry?.version ?? 0));
    }).catch(() => setSaveText("Could not load EMR version"));
    return () => { cancelled = true; };
  }, [consultationId, emrEntryId]);

  useEffect(() => {
    if (!emrEntryId || version === null || !manualEditRef.current) return;
    const t = setTimeout(async () => {
      const res = await fetch(`/api/emr/${emrEntryId}`, { method: "PUT",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(savePayload) });
      if (!res.ok) { setSaveText("Save failed or EMR version conflict; reload"); return; }
      const response = await res.json();
      setVersion(Number(response.version));
      manualEditRef.current = false;
      setSaveText(`Saved ${new Date().toLocaleTimeString("en-IN")}`);
    }, 3000);
    return () => clearTimeout(t);
  }, [emrEntryId, savePayload]);

  return (
    <div className="space-y-3">
      <ExtractButton
        consultationId={consultationId}
        transcriptText={transcriptText}
        onExtracted={(data) => {
          setForm((prev: any) => ({ ...prev, ...data }));
          setAiSuggestions(data.icd_suggestions ?? []);
        }}
      />
      <Input label="Chief Complaint" value={form.chief_complaint ?? ""} onChange={(e) => { manualEditRef.current = true; setForm({ ...form, chief_complaint: e.target.value }); }} />
      <Input label="Symptoms (comma-separated)" value={(form.symptoms ?? []).join(", ")} onChange={(e) => { manualEditRef.current = true; setForm({ ...form, symptoms: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }); }} />
      <Input label="Assessment" value={form.assessment ?? ""} onChange={(e) => { manualEditRef.current = true; setForm({ ...form, assessment: e.target.value }); }} />
      <Input label="Plan" value={form.plan ?? ""} onChange={(e) => { manualEditRef.current = true; setForm({ ...form, plan: e.target.value }); }} />
      <ICD10Search
        selected={diagnoses}
        onSelect={(item) => setDiagnoses((prev) => (prev.find((x) => x.code === item.code) ? prev : [...prev, item]))}
        onRemove={(id) => setDiagnoses((prev) => prev.filter((x) => x.id !== id))}
      />
      <AISuggestions
        suggestions={aiSuggestions}
        onAccept={(s) => {
          setDiagnoses((prev) => [...prev, { id: `${s.code}-${Math.random()}`, code: s.code, description: s.description, ai: true }]);
          setAiSuggestions((prev) => prev.filter((x) => x.code !== s.code));
        }}
        onReject={(s) => setAiSuggestions((prev) => prev.filter((x) => x.code !== s.code))}
        onAcceptAll={() => {
          setDiagnoses((prev) => [...prev, ...aiSuggestions.map((s) => ({ id: `${s.code}-${Math.random()}`, code: s.code, description: s.description, ai: true }))]);
          setAiSuggestions([]);
        }}
      />
      <div className="flex items-center justify-between">
        <p className="text-xs text-[hsl(var(--text-muted))]">{saveText}</p>
        <div className="flex gap-2">
          <Button variant="secondary">Save Draft</Button>
          <Button>Complete Consultation</Button>
        </div>
      </div>
    </div>
  );
}
