"use client";

import { useCallback, useEffect, useState } from "react";
import type { FamilyGraph, FamilyAction, Relation, Lineage } from "@/src/lib/familyHistory/graph";
import { Card, CardContent, CardHeader, CardTitle } from "@/src/components/ui/Card";
import { Button } from "@/src/components/ui/Button";

const relationOptions: Relation[] = ["mother", "father", "sibling", "child", "grandmother", "grandfather", "unknown"];
const lineageOptions: Lineage[] = ["unknown", "maternal", "paternal"];
const inputClass = "rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] px-2 py-1.5 text-sm";

/** Patient-scoped review editor. A consultation is mandatory for any clinical mutation. */
export function FamilyGraphPanel({ patientId, consultationId }: { patientId: string; consultationId?: string }) {
  const [graph, setGraph] = useState<FamilyGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [relation, setRelation] = useState<Relation>("mother");
  const [lineage, setLineage] = useState<Lineage>("unknown");
  const [relativeTo, setRelativeTo] = useState("patient");
  const [label, setLabel] = useState("");
  const [condition, setCondition] = useState("");
  const [selectedRelative, setSelectedRelative] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/patients/${patientId}/family-graph`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Cannot load family history");
      setGraph(data.graph);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Cannot load family history"); }
  }, [patientId]);
  useEffect(() => { void load(); }, [load]);

  const update = async (change: FamilyAction) => {
    if (!graph || !consultationId || working) return;
    setWorking(true); setError(null);
    try {
      const response = await fetch(`/api/patients/${patientId}/family-graph`, { method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consultation_id: consultationId, expected_version: graph.version, change }) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409) await load();
        throw new Error(result.error ?? "Family graph update failed");
      }
      setGraph(result.graph);
      setCondition(""); setLabel("");
    } catch (e) { setError(e instanceof Error ? e.message : "Family graph update failed"); }
    finally { setWorking(false); }
  };
  const canEdit = Boolean(consultationId);
  const active = graph?.relatives.filter(r => r.status !== "rejected") ?? [];
  const selected = selectedRelative || active[0]?.id || "";
  return (
    <Card className="border-[hsl(var(--border))]">
      <CardHeader className="pb-3"><CardTitle className="text-sm">Structured family history</CardTitle>
        <p className="text-xs text-[hsl(var(--text-muted))]">Relative relationships and conditions are distinct from patient diagnoses. AI proposals require clinician review.</p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {error && <p role="alert" className="text-[hsl(var(--danger))]">{error}</p>}
        {!graph && !error && <p>Loading family history…</p>}
        {!canEdit && <p className="text-xs text-[hsl(var(--text-muted))]">Open an active consultation to edit or review family history.</p>}
        {graph && <>
          <p className="text-xs text-[hsl(var(--text-muted))]">Graph version {graph.version} · {active.length} relatives · {graph.assertions.filter(a => a.status !== "rejected").length} conditions</p>
          {active.length ? active.map(relative => (
            <section key={relative.id} className="rounded-lg border border-[hsl(var(--border))] p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{relative.label || relative.relation} · {relative.relation} {relative.lineage !== "unknown" ? `(${relative.lineage})` : ""}
                  <span className="ml-2 text-xs font-normal text-[hsl(var(--text-muted))]">of {relative.relative_to === "patient" ? "patient" : (active.find(r => r.id === relative.relative_to)?.label || "relative")}</span>
                </p>
                <span className="text-xs">{relative.status} · {relative.origin}</span>
              </div>
              {relative.evidence_segment_ids.length > 0 && <p className="text-xs text-[hsl(var(--text-muted))]">Evidence: {relative.evidence_segment_ids.join(", ")}</p>}
              {graph.assertions.filter(a => a.relative_id === relative.id && a.status !== "rejected").map(a => (
                <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-[hsl(var(--bg-secondary))] p-2">
                  <div><p>{a.condition} <span className="text-xs text-[hsl(var(--text-muted))]">({a.status}; {a.confidence})</span></p>
                    <p className="text-xs text-[hsl(var(--text-muted))]">{a.origin} · {a.updated_at.slice(0, 10)} · evidence: {a.evidence_segment_ids.join(", ") || "clinician entry"}</p></div>
                  {canEdit && <div className="flex gap-2">
                    {a.status === "proposed" && <><Button size="sm" variant="secondary" disabled={working} onClick={() => void update({ action: "review_condition", id: a.id, decision: "confirmed" })}>Accept</Button>
                      <Button size="sm" variant="secondary" disabled={working} onClick={() => void update({ action: "review_condition", id: a.id, decision: "rejected" })}>Reject</Button></>}
                    <Button size="sm" variant="secondary" disabled={working} onClick={() => { const correction = window.prompt("Correct condition", a.condition); if (correction !== null) void update({ action: "edit_condition", id: a.id, condition: correction }); }}>Correct</Button>
                    <Button size="sm" variant="secondary" disabled={working} onClick={() => void update({ action: "remove_condition", id: a.id })}>Remove</Button>
                  </div>}
                </div>
              ))}
              {canEdit && <div className="flex flex-wrap gap-2">
                {relative.status === "proposed" && <><Button size="sm" disabled={working} onClick={() => void update({ action: "review_relative", id: relative.id, decision: "confirmed" })}>Confirm relative</Button>
                  <Button size="sm" variant="secondary" disabled={working} onClick={() => void update({ action: "review_relative", id: relative.id, decision: "rejected" })}>Reject relative</Button></>}
                <Button size="sm" variant="secondary" disabled={working} onClick={() => { const corrected = window.prompt("Relative label", relative.label); if (corrected !== null) void update({ action: "edit_relative", id: relative.id, label: corrected }); }}>Edit relative</Button>
                <Button size="sm" variant="secondary" disabled={working} onClick={() => { const corrected = window.prompt(`Relationship (${relationOptions.join(", ")})`, relative.relation); if (corrected && relationOptions.includes(corrected as Relation)) void update({ action: "edit_relative", id: relative.id, relation: corrected as Relation }); }}>Change relation</Button>
                <Button size="sm" variant="secondary" disabled={working} onClick={() => void update({ action: "remove_relative", id: relative.id })}>Remove relative</Button>
              </div>}
            </section>
          )) : <p className="text-xs text-[hsl(var(--text-muted))]">No structured relative records yet. Existing free-text family history remains unchanged.</p>}
          {canEdit && <div className="space-y-3 border-t border-[hsl(var(--border))] pt-3">
            <p className="font-medium">Add relative</p>
            <div className="flex flex-wrap gap-2">
              <label className="text-xs">Relation <select className={inputClass} value={relation} onChange={e => setRelation(e.target.value as Relation)}>{relationOptions.map(x => <option key={x}>{x}</option>)}</select></label>
              <label className="text-xs">Lineage <select className={inputClass} value={lineage} onChange={e => setLineage(e.target.value as Lineage)}>{lineageOptions.map(x => <option key={x}>{x}</option>)}</select></label>
              <label className="text-xs">Relative to <select className={inputClass} value={relativeTo} onChange={e => setRelativeTo(e.target.value)}><option value="patient">Patient</option>{active.map(r => <option key={r.id} value={r.id}>{r.label || r.relation}</option>)}</select></label>
              <input className={inputClass} placeholder="Label (optional)" aria-label="Relative label" value={label} onChange={e => setLabel(e.target.value)} maxLength={90}/>
              <Button size="sm" disabled={working} onClick={() => void update({ action: "add_relative", relative_to: relativeTo, relation, lineage, label })}>Add relative</Button>
            </div>
            {active.length > 0 && <><p className="font-medium">Add condition</p><div className="flex flex-wrap gap-2">
              <select aria-label="Relative" className={inputClass} value={selected} onChange={e => setSelectedRelative(e.target.value)}>{active.map(r => <option key={r.id} value={r.id}>{r.label || r.relation}</option>)}</select>
              <input className={inputClass} placeholder="Reported condition" aria-label="Condition" value={condition} maxLength={180} onChange={e => setCondition(e.target.value)}/>
              <Button size="sm" disabled={working || !condition.trim()} onClick={() => void update({ action: "add_condition", relative_id: selected, condition, evidence_source: "patient_reported" })}>Add condition</Button>
            </div></>}
          </div>}
        </>}
      </CardContent>
    </Card>
  );
}
