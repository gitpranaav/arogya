"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/src/components/ui/Button";
import type { EMRSnapshot, FieldProvenance } from "@/src/lib/emr/types";
import type { ReviewBlocker, ReviewStatus } from "@/src/lib/clinical/reviewPolicy";

type Finding = { path: string; reason: string; evidence_segment_ids: string[] };
type ReviewPayload = {
  version: number;
  status: ReviewStatus;
  blockers: ReviewBlocker[];
  snapshot: EMRSnapshot;
  provenance: Record<string, FieldProvenance>;
  evidence: Array<{ id: string; text: string }>;
  family_proposals: { relatives: Array<{ id: string; label: string; relation: string }>; assertions: Array<{ id: string; relative_id: string; condition: string }> };
  allergies: string[];
  warnings: string[];
  grounding_findings: Finding[];
};

const pill = "inline-flex rounded-md border border-[hsl(var(--border))] px-2 py-1 text-xs font-semibold";
const wrap = "rounded-md border border-[hsl(var(--border))] p-3 space-y-2";
const format = (value: unknown): string => value == null ? "Not recorded" : typeof value === "string" ? value || "Not recorded" : JSON.stringify(value);

/** Nothing sent to the server is a substitute for server-side validation and review version checks. */
export function ClinicalReviewDialog({ consultationId, onClose, onCompleted, onNeedsEdit, hasUnsavedEdits }: {
  consultationId: string;
  onClose: () => void;
  onCompleted: () => void;
  onNeedsEdit: (path: string) => void;
  hasUnsavedEdits: boolean;
}) {
  const [data, setData] = useState<ReviewPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [checkedWarnings, setCheckedWarnings] = useState<string[]>([]);
  const [checkedGrounding, setCheckedGrounding] = useState<string[]>([]);
  const [confirmedAllergies, setConfirmedAllergies] = useState(false);
  const [confirmedReview, setConfirmedReview] = useState(false);
  const [confirmedPrescription, setConfirmedPrescription] = useState(false);

  const refresh = useCallback(async () => {
    if (hasUnsavedEdits) { setError("Save or resolve unsaved EMR changes before refreshing review. Your edits have not been discarded."); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/emr/review/${consultationId}`, { cache: "no-store" });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error ?? "Unable to load review");
      setData(next as ReviewPayload);
      setCheckedWarnings([]); setCheckedGrounding([]);
      setConfirmedAllergies(false); setConfirmedReview(false); setConfirmedPrescription(false);
      setReloadRequired(false); setError(null);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to load review"); }
    finally { setBusy(false); }
  }, [consultationId, hasUnsavedEdits]);

  useEffect(() => { void refresh(); }, [refresh]);

  const canApprove = useMemo(() => Boolean(data && !busy && !hasUnsavedEdits &&
    data.blockers.length === 0 && confirmedAllergies && confirmedReview && confirmedPrescription &&
    checkedWarnings.length === data.warnings.length && checkedGrounding.length === data.grounding_findings.length),
    [data, busy, hasUnsavedEdits, confirmedAllergies, confirmedReview, confirmedPrescription, checkedWarnings, checkedGrounding]);

  const toggle = (id: string, checked: boolean, setter: (next: string[]) => void, current: string[]) =>
    setter(checked ? [...current, id] : current.filter(x => x !== id));

  const complete = async () => {
    if (!data || !canApprove) return;
    setBusy(true); setError(null);
    try {
      if (data.status !== "Ready for Sign-Off") {
        const review = await fetch(`/api/emr/review/${consultationId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          expected_version: data.version, confirmed_review: true, confirmed_prescription: true,
          allergy_assessment: data.allergies.length ? "confirmed_known" : "confirmed_none",
          acknowledged_warnings: checkedWarnings, acknowledged_grounding: checkedGrounding,
        }) });
        const reviewed = await review.json().catch(() => ({}));
        if (!review.ok) {
          setReloadRequired(review.status === 409 || Boolean(reviewed.reload_required));
          throw new Error(reviewed.error ?? "Unable to record doctor approval");
        }
      }
      const result = await fetch(`/api/consultations/${consultationId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        status: "completed", reviewed_version: data.version,
      }) });
      const finalized = await result.json().catch(() => ({}));
      if (!result.ok) {
        // Review may have committed even when completion failed. Force re-fetch before retrying.
        setReloadRequired(true);
        throw new Error(finalized.error ?? "Consultation completion failed; approved review may be retained. Refresh status before retrying.");
      }
      onCompleted();
    } catch (err) { setError(err instanceof Error ? err.message : "Completion failed"); }
    finally { setBusy(false); }
  };
  const evidenceById = new Map((data?.evidence ?? []).map(s => [s.id, s.text]));
  const section = (label: string, value: unknown) => <div className={wrap}><h4 className="font-semibold">{label}</h4><p className="text-sm whitespace-pre-wrap break-words">{format(value)}</p></div>;

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3" role="presentation">
    <section role="dialog" aria-modal="true" aria-labelledby="clinical-review-title" className="w-full max-w-4xl max-h-[94dvh] overflow-y-auto space-y-4 rounded-lg bg-[hsl(var(--bg-card))] p-5 text-[hsl(var(--text-primary))] shadow-xl">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 id="clinical-review-title" className="text-lg font-bold">Clinician Review & Sign-Off</h2><p className="text-xs text-[hsl(var(--text-muted))]">Only the responsible doctor can approve this recorded EMR version. No AI-generated finding is automatically approved.</p></div>
        <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Close</Button>
      </header>
      {data && <div className="flex items-center gap-3"><span className={pill}>{data.status}</span><span className="text-xs">EMR version {data.version}</span></div>}
      {error && <p role="alert" className="rounded-md border border-[hsl(var(--danger))] p-3 text-sm text-[hsl(var(--danger))]">{error}</p>}
      {reloadRequired && <div className={wrap}><p>Another session changed this consultation. Do not sign off using the stale review.</p><Button type="button" variant="secondary" onClick={() => void refresh()} disabled={busy || hasUnsavedEdits}>Reload server review</Button></div>}
      {!data && <p>{busy ? "Loading the latest server review…" : "Unable to load review. Retry from the consultation."}</p>}
      {data && <>
        {data.blockers.length > 0 && <div className={wrap}><h3 className="font-semibold text-[hsl(var(--danger))]">Requires Correction</h3>{data.blockers.map((b, i) => <div key={`${b.code}-${i}`} className="flex items-center justify-between gap-2 text-sm"><span>{b.message}</span><Button type="button" size="sm" variant="secondary" onClick={() => onNeedsEdit(b.path)}>Go to field</Button></div>)}</div>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {section("Chief complaint", data.snapshot.chief_complaint)}
          {section("Symptoms", (data.snapshot.symptoms ?? []).join(", "))}
          {section("Diagnoses", (data.snapshot.diagnosis_text ?? []).join(", "))}
          {section("Vitals", data.snapshot.vitals)}
          {section("Laboratory tests", data.snapshot.lab_tests_ordered)}
          {section("Assessment and other EMR fields", Object.fromEntries(Object.entries(data.snapshot).filter(([key]) => !["medications", "chief_complaint", "symptoms", "diagnosis_text", "vitals", "lab_tests_ordered"].includes(key))))}
        </div>
        <div className={wrap}><h3 className="font-semibold">Prescription verification</h3>
          {!data.snapshot.medications?.length ? <p className="text-sm">No medications recorded for this consultation.</p> :
            data.snapshot.medications.map((med, i) => <div key={med.id ?? i} className="rounded-md border border-[hsl(var(--border))] p-2 text-sm">
              <p className="font-semibold">{med.name || `Incomplete medication ${i + 1}`}</p><p>Dosage: {format(med.dosage)} · Frequency: {format(med.frequency)} · Duration: {format(med.duration)} · Route: {format(med.route)}</p>
              <p className="text-xs text-[hsl(var(--text-muted))]">ID: {med.id ?? "legacy record"}</p>
              <Button type="button" size="sm" variant="secondary" onClick={() => onNeedsEdit(`medications[${i}]`)}>Review/Edit medication</Button>
            </div>)}
        </div>
        <div className={wrap}><h3 className="font-semibold">Clinical provenance & transcript evidence</h3>
          {Object.keys(data.provenance).length === 0 ? <p className="text-sm">No field-level provenance recorded. Verify all facts manually.</p> :
            Object.entries(data.provenance).slice(0, 100).map(([path, fact]) => <div key={path} className="border-b border-[hsl(var(--border))] pb-2 text-sm">
              <p className="font-medium">{path} · {fact.origin} · {fact.grounding} · {fact.reviewed ? "Reviewed" : "Not reviewed"}</p>
              <p className="text-xs">Confidence: {fact.confidence ?? "Not established"}</p>
              {(fact.evidence_segment_ids ?? []).length ? <p className="text-xs">Transcript evidence: {(fact.evidence_segment_ids ?? []).map(id => `${id}: ${evidenceById.get(id) ?? "Segment not in recent excerpt"}`).join(" | ")}</p> : null}
              <Button type="button" variant="ghost" size="sm" onClick={() => onNeedsEdit(path)}>Correct / reject field in EMR</Button>
            </div>)}
        </div>
        <div className={wrap}><h3 className="font-semibold">Allergy assessment</h3><p className="text-sm">{data.allergies.length ? data.allergies.join(", ") : "No allergies recorded. Explicit patient assessment is required."}</p>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmedAllergies} onChange={e => setConfirmedAllergies(e.target.checked)}/> I personally verified the patient's allergy status.</label>
        </div>
        {data.warnings.length > 0 && <div className={wrap}><h3 className="font-semibold">Prescription safety warnings — doctor acknowledgement required</h3>{data.warnings.map((warning, i) => <label key={i} className="flex gap-2 text-sm"><input type="checkbox" checked={checkedWarnings.includes(warning)} onChange={e => toggle(warning, e.target.checked, setCheckedWarnings, checkedWarnings)}/>{warning}</label>)}</div>}
        {data.grounding_findings.length > 0 && <div className={wrap}><h3 className="font-semibold">Unsupported / uncertain AI findings</h3>{data.grounding_findings.map((finding, i) => <label key={i} className="flex gap-2 text-sm"><input type="checkbox" checked={checkedGrounding.includes(finding.path)} onChange={e => toggle(finding.path, e.target.checked, setCheckedGrounding, checkedGrounding)}/>{finding.path}: {finding.reason}. Verify or correct this finding before acknowledgement.</label>)}</div>}
        {(data.family_proposals.relatives.length > 0 || data.family_proposals.assertions.length > 0) && <div className={wrap}><h3 className="font-semibold">Pending family-history proposals (not confirmed diagnoses)</h3><p className="text-sm">Relatives: {data.family_proposals.relatives.map(r => `${r.label || r.relation} (${r.relation})`).join(", ") || "None"}</p><p className="text-sm">Conditions: {data.family_proposals.assertions.map(a => a.condition).join(", ") || "None"}</p><Button type="button" variant="secondary" size="sm" onClick={() => onNeedsEdit("family_history")}>Review proposals in patient history</Button></div>}
        <div className={wrap}><label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmedPrescription} onChange={e => setConfirmedPrescription(e.target.checked)}/> I checked medication identities, instructions, and prescribing safety.</label><label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmedReview} onChange={e => setConfirmedReview(e.target.checked)}/> I reviewed this entire EMR and approve version {data.version} for sign-off.</label></div>
        <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="secondary" onClick={() => void refresh()} disabled={busy || hasUnsavedEdits}>Refresh Review</Button><Button type="button" variant="primary" disabled={!canApprove || reloadRequired} loading={busy} onClick={() => void complete()}>Approve & Complete Consultation</Button></div>
      </>}
    </section>
  </div>;
}
