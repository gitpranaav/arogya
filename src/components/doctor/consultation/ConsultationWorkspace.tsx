"use client";

import { ChevronLeft, ChevronRight, Clock3, PanelRightClose, PanelRightOpen, Printer } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/src/components/ui/Badge";
import { Button } from "@/src/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/src/components/ui/Card";
import { Input } from "@/src/components/ui/Input";
import { EMRLivePanel } from "@/src/components/emr/EMRLivePanel";
import { ClinicalReviewDialog } from "@/src/components/doctor/consultation/ClinicalReviewDialog";
import { STTRecorder } from "@/src/components/stt/STTRecorder";
import { TranscriptViewer } from "@/src/components/stt/TranscriptViewer";
import { PatientHistoryPanel } from "@/src/components/history/PatientHistoryPanel";
import { useSTT } from "@/src/hooks/useSTT";
import type { EMRSnapshot, TranscriptSegment } from "@/src/lib/emr/types";
import { detectLiveAllergySignals } from "@/src/lib/clinical/allergySafety";
import { chooseTranscriptBatch, pendingFromCursor } from "@/src/lib/extraction/batching";

interface WorkspaceProps {
  consultationId: string;
  patientId: string | null;
  patientName: string;
  consultationType: string;
  initialStatus?: string | null;
  initialStartedAt: string | null;
  initialFollowUpDueAt?: string | null;
}

type AuditEvent = {
  id: string;
  actor_role: string | null;
  source: string | null;
  event_type: string | null;
  sequence_no: number | null;
  created_at: string | null;
  changed_paths: string[];
};

function formatElapsed(seconds: number) {
  const h = Math.floor(seconds / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function formatBloodPressure(vitals: EMRSnapshot["vitals"]) {
  const systolic = vitals?.bp_systolic;
  const diastolic = vitals?.bp_diastolic;
  if (systolic == null && diastolic == null) return "";
  return `${systolic ?? ""}${systolic != null || diastolic != null ? "/" : ""}${diastolic ?? ""}`;
}

function parseBloodPressure(value: string) {
  const text = value.trim();
  if (!text) {
    return { bp_systolic: null as number | null, bp_diastolic: null as number | null };
  }

  const match = text.match(/^(\d{2,3})(?:\s*\/\s*(\d{2,3}))?$/);
  if (!match) {
    return null;
  }

  return {
    bp_systolic: Number(match[1]) || null,
    bp_diastolic: match[2] ? Number(match[2]) || null : null,
  };
}

const FOLLOW_UP_INTENT_REGEX = /(follow[\s-]?up|come back|review|meet me|show me again|visit again|phir se|wapas|dobara|dikha|dikhana)/i;
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  ek: 1,
  do: 2,
  teen: 3,
  char: 4,
  chaar: 4,
  paanch: 5,
  chhe: 6,
  cheh: 6,
  saat: 7,
  aath: 8,
  nau: 9,
  das: 10,
};

function parseCountToken(token: string): number | null {
  const normalized = token.toLowerCase().trim();
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return NUMBER_WORDS[normalized] ?? null;
}

function inferFollowUpFromTranscript(transcript: string): { days: number; evidence: string } | null {
  const cleaned = String(transcript ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  const chunks = cleaned
    .split(/[.!?\n।]+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const chunk = chunks[i];
    if (!FOLLOW_UP_INTENT_REGEX.test(chunk)) continue;

    const dayMatch = chunk.match(/(?:after|in)?\s*(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|ek|do|teen|char|chaar|paanch|chhe|cheh|saat|aath|nau|das)\s*(?:day|days|din)\b/i);
    if (dayMatch) {
      const count = parseCountToken(dayMatch[1]);
      if (count && count > 0) return { days: count, evidence: chunk };
    }

    const weekMatch = chunk.match(/(?:after|in)?\s*(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|ek|do|teen|char|chaar|paanch|chhe|cheh|saat|aath|nau|das|a)\s*(?:week|weeks|hafta|hafte|hafton)\b/i);
    if (weekMatch) {
      const token = weekMatch[1].toLowerCase() === "a" ? "one" : weekMatch[1];
      const count = parseCountToken(token);
      if (count && count > 0) return { days: count * 7, evidence: chunk };
    }
  }

  return null;
}

function toDateInputValue(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(base: Date, days: number) {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function asIsoFromDateInput(value: string) {
  if (!value?.trim()) return null;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function ConsultationWorkspace({
  consultationId,
  patientId,
  patientName,
  consultationType,
  initialStatus,
  initialStartedAt,
  initialFollowUpDueAt,
}: WorkspaceProps) {
  const [syncText, setSyncText] = useState("Sync pending");
  const [isEnded, setIsEnded] = useState(String(initialStatus ?? "").toLowerCase() === "completed");
  const [patientAllergies, setPatientAllergies] = useState<string[]>([]);
  const [emrSnapshot, setEmrSnapshot] = useState<EMRSnapshot>({});
  const [emrVersion, setEmrVersion] = useState(0);
  const [manualPending, setManualPending] = useState(false);
  const manualPendingRef = useRef(false);
  const updateManualPending = useCallback((dirty: boolean) => {
    manualPendingRef.current = dirty;
    setManualPending(dirty);
  }, []);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [cursor, setCursor] = useState<{ last_final_segment_id?: string | null; last_final_index?: number | null } | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditExpanded, setAuditExpanded] = useState(false);
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const [followUpDate, setFollowUpDate] = useState<string>(
    initialFollowUpDueAt ? toDateInputValue(new Date(initialFollowUpDueAt)) : ""
  );
  const [followUpEdited, setFollowUpEdited] = useState(Boolean(initialFollowUpDueAt));
  const [followUpSaving, setFollowUpSaving] = useState(false);
  const [followUpNotice, setFollowUpNotice] = useState<string | null>(null);
  const extractingRef = useRef(false);
  const [emrLoaded, setEmrLoaded] = useState(false);
  const queuedBatchRef = useRef<{ id: string; firstAt: number; lastId: string; lastAt: number } | null>(null);
  const finalExtractionDoneRef = useRef(false);
  const finalExtractionInFlightRef = useRef(false);
  const deltaRetryCountRef = useRef(0);
  const deltaBlockedRef = useRef<string | null>(null);
  const deltaRetryTimerRef = useRef<number | null>(null);
  const emrSnapshotRef = useRef<EMRSnapshot>({});
  const cursorRef = useRef<typeof cursor>(null);
  const sttSegmentsRef = useRef<TranscriptSegment[]>([]);
  const patientAllergiesRef = useRef<string[]>([]);
  emrSnapshotRef.current = emrSnapshot;
  cursorRef.current = cursor;
  patientAllergiesRef.current = patientAllergies;

  const stt = useSTT({ consultationId });
  sttSegmentsRef.current = (stt.segments ?? []) as TranscriptSegment[];

  const startedAt = useMemo(
    () => new Date(initialStartedAt ?? new Date().toISOString()),
    [initialStartedAt]
  );
  const [elapsed, setElapsed] = useState(
    Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000))
  );

  useEffect(() => {
    const tick = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)));
    }, 1000);
    return () => clearInterval(tick);
  }, [startedAt]);


  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await fetch(`/api/consultations/${consultationId}/audit`);
      const data = await res.json();
      if (cancelled) return;
      if (!res.ok) {
        setAuditError(data.error ?? "Failed to load audit trail");
        return;
      }
      setAuditEvents(Array.isArray(data.events) ? data.events : []);
      setAuditError(null);
    };

    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [consultationId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/emr/by-consultation/${consultationId}`, { method: "GET" });
      const data = await res.json();
      if (cancelled) return;
      if (res.ok && data?.emr_entry?.snapshot) setEmrSnapshot(data.emr_entry.snapshot);
      if (res.ok && data?.emr_entry) setEmrVersion(Number(data.emr_entry.version ?? 0));
      if (res.ok && data?.emr_entry?.extraction_cursor) setCursor(data.emr_entry.extraction_cursor);
      if (res.ok) setEmrLoaded(true);
      else setSyncText(String(data?.error ?? "EMR loading failed; extraction disabled"));
    })();
    return () => {
      cancelled = true;
    };
  }, [consultationId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/consultations/context/${consultationId}`);
      const data = await res.json();
      if (cancelled) return;
      const list = data?.history?.allergies;
      if (res.ok && Array.isArray(list)) {
        setPatientAllergies(list.map((x: unknown) => String(x).trim()).filter(Boolean));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [consultationId]);

  const processDeltaExtraction = useCallback(async (force = false) => {
    if (isEnded || !emrLoaded || extractingRef.current || (deltaRetryTimerRef.current != null && !force)) return;
    extractingRef.current = true;

    try {
      // Drain all newly finalized segments so EMR updates keep up while speaking.
      while (true) {
        // A clinician edit that has not been persisted is authoritative in the
        // browser; pause extraction rather than race a whole-snapshot PUT.
        if (manualPendingRef.current) break;
        const finalSegments = (sttSegmentsRef.current ?? []).filter((s) => s?.is_final !== false) as TranscriptSegment[];
        const pending = pendingFromCursor(finalSegments, cursorRef.current?.last_final_segment_id ?? null);
        if (!pending) { setSyncText("Extraction cursor mismatch — reload consultation"); break; }
        if (!pending.length) { queuedBatchRef.current = null; deltaBlockedRef.current = null; break; }
        // Do not turn a permanent validation/clinical error into infinite polling.
        if (deltaBlockedRef.current === pending[0].id) break;
        const now = Date.now();
        const first = pending[0].id;
        const last = pending[pending.length - 1].id;
        if (queuedBatchRef.current?.id !== first) queuedBatchRef.current = { id: first, firstAt: now, lastId: last, lastAt: now };
        else if (queuedBatchRef.current.lastId !== last) {
          queuedBatchRef.current.lastId = last;
          queuedBatchRef.current.lastAt = now;
        }
        const timing = queuedBatchRef.current;
        const batch = chooseTranscriptBatch(pending, now, timing.firstAt, timing.lastAt, force);
        if (!batch.ready) break;
        const delta = batch.segments;

        const res = await fetch("/api/emr/extract-delta", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            consultation_id: consultationId,
            segments_delta: delta,
            emr_snapshot: emrSnapshotRef.current,
            cursor: cursorRef.current,
            patient_allergies: patientAllergiesRef.current,
          }),
        });
        const data = await res.json();
        if (res.ok) {
          deltaRetryCountRef.current = 0;
          if (deltaRetryTimerRef.current != null) {
            window.clearTimeout(deltaRetryTimerRef.current);
            deltaRetryTimerRef.current = null;
          }
          // If the clinician started editing during this provider call, do not
          // advance the local EMR version without also adopting the server's
          // snapshot: that could turn a stale whole-document PUT into an
          // apparently current write that erases the AI changes.
          if (manualPendingRef.current) {
            setSyncText("EMR updated during unsaved manual edits — reload to resolve version conflict");
            break;
          }
          if (typeof data?.version === "number") setEmrVersion(data.version);
          if (data?.snapshot) {
            emrSnapshotRef.current = data.snapshot;
            setEmrSnapshot(data.snapshot);
          }
          if (data?.new_cursor) {
            cursorRef.current = data.new_cursor;
            setCursor(data.new_cursor);
          }
          queuedBatchRef.current = null;
          setSyncText(`Synced ${new Date().toLocaleTimeString("en-IN")}`);
        } else {
          // An explicit server retryable:false overrides generic 429/5xx heuristics.
          const retryable = typeof data?.retryable === "boolean" ? data.retryable : res.status === 429 || res.status >= 500;
          const code = String(data?.error_code ?? "extract_delta_failed");
          const message = String(data?.error ?? "Delta extraction failed");

          if (!retryable || code === "provider_auth" || code === "missing_api_key") {
            deltaBlockedRef.current = delta[0].id;
            setSyncText(`Live extraction paused: ${message}`);
            break;
          }

          deltaRetryCountRef.current += 1;
          const backoffMs = Math.min(15000, 1200 * 2 ** Math.max(0, deltaRetryCountRef.current - 1));
          setSyncText(`Live extraction retrying in ${Math.ceil(backoffMs / 1000)}s (${message})`);

          if (deltaRetryTimerRef.current != null) {
            window.clearTimeout(deltaRetryTimerRef.current);
          }
          deltaRetryTimerRef.current = window.setTimeout(() => {
            deltaRetryTimerRef.current = null;
            void processDeltaExtraction();
          }, backoffMs);
          break;
        }
      }
    } finally {
      extractingRef.current = false;
    }
  }, [consultationId, emrLoaded, isEnded]);

  useEffect(() => {
    if (!manualPending) void processDeltaExtraction(stt.status === "paused" || stt.status === "idle");
  }, [processDeltaExtraction, stt.segments, stt.status, manualPending]);

  // A bounded timer flushes utterances that have no explicit punctuation.
  useEffect(() => {
    const timer = window.setInterval(() => { if (!manualPendingRef.current) void processDeltaExtraction(); }, 500);
    return () => window.clearInterval(timer);
  }, [processDeltaExtraction]);

  useEffect(() => {
    return () => {
      if (deltaRetryTimerRef.current != null) {
        window.clearTimeout(deltaRetryTimerRef.current);
        deltaRetryTimerRef.current = null;
      }
    };
  }, []);

  const recentFinalized = (stt.segments ?? []).slice(-2).map(segment => segment.text).join(" ");
  const liveAllergyAlert = useMemo(() => {
    const warnings = detectLiveAllergySignals(patientAllergies, recentFinalized, stt.interimText ?? "")
      .filter(signal => signal.intent !== "negated" && signal.intent !== "historical");
    return warnings.length ? warnings.map(signal => signal.warning).join(" · ") : null;
  }, [patientAllergies, recentFinalized, stt.interimText]);

  const followUpSuggestion = useMemo(() => inferFollowUpFromTranscript(stt.fullText ?? ""), [stt.fullText]);

  useEffect(() => {
    if (!followUpSuggestion || followUpEdited) return;
    setFollowUpDate(toDateInputValue(addDays(new Date(), followUpSuggestion.days)));
  }, [followUpEdited, followUpSuggestion]);

  const saveFollowUp = useCallback(async () => {
    setFollowUpSaving(true);
    setFollowUpNotice(null);
    try {
      const followUpDueAt = asIsoFromDateInput(followUpDate);
      const payload: Record<string, unknown> = {
        follow_up_due_at: followUpDueAt,
      };
      if (followUpSuggestion?.days) payload.follow_up_in_days = followUpSuggestion.days;

      const res = await fetch(`/api/consultations/${consultationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFollowUpNotice(String(data?.error ?? "Failed to save follow-up"));
        return;
      }
      setFollowUpNotice(followUpDueAt ? "Follow-up saved" : "Follow-up cleared");
      setSyncText(`Synced ${new Date().toLocaleTimeString("en-IN")}`);
      setFollowUpOpen(false);
    } finally {
      setFollowUpSaving(false);
    }
  }, [consultationId, followUpDate, followUpSuggestion?.days]);

  const runFinalExtraction = useCallback(async (): Promise<boolean> => {
    if (manualPending) { setSyncText("Save manual EMR edits before final extraction"); return false; }
    if (finalExtractionDoneRef.current) return true;
    if (finalExtractionInFlightRef.current) return false;
    finalExtractionInFlightRef.current = true;
    try {
      // Never run final extraction over an outstanding delta update.
      for (let i = 0; i < 50 && extractingRef.current; i++) {
        await new Promise(resolve => window.setTimeout(resolve, 100));
      }
      if (extractingRef.current) { setSyncText("Extraction still processing; retry"); return false; }
      // Explicit stop/completion must drain persisted pending segments regardless of batching age.
      await processDeltaExtraction(true);
      if (extractingRef.current) { setSyncText("Live extraction still processing; retry"); return false; }
      const res = await fetch("/api/emr/extract", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consultation_id: consultationId }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.snapshot) { setSyncText(String(data?.error ?? "Final extraction failed")); return false; }
      setEmrSnapshot(data.snapshot);
      if (typeof data.version === "number") setEmrVersion(data.version);
      setSyncText(`Final extraction ready for doctor review`);
      finalExtractionDoneRef.current = true;
      return true;
    } catch (err) { setSyncText(err instanceof Error ? err.message : "Final extraction failed"); return false; }
    finally { finalExtractionInFlightRef.current = false; }
  }, [consultationId, manualPending, processDeltaExtraction]);

  const handleStopClick = useCallback(async () => {
    try {
      if (stt.status !== "idle") await stt.stop();
      await runFinalExtraction();
    } catch (e) { setSyncText(e instanceof Error ? e.message : "Could not finalize transcription"); }
  }, [runFinalExtraction, stt]);

  const endConsultation = async () => {
    if (isFinalizing || manualPendingRef.current) { setSyncText("Save unsaved EMR edits before review"); return; }
    setIsFinalizing(true);
    try {
      if (stt.status !== "idle") await stt.stop();
      const extractionOk = await runFinalExtraction();
      if (!extractionOk) return;
      // Structured review fetches the latest authoritative server state. It never signs automatically.
      setReviewOpen(true);
    } catch (error) { setSyncText(error instanceof Error ? error.message : "Unable to prepare clinical review"); }
    finally { setIsFinalizing(false); }
  };

  const navigateToReviewField = (path: string) => {
    setReviewOpen(false);
    if (path === "family_history") {
      setHistoryOpen(true);
      window.requestAnimationFrame(() => document.getElementById("mediflow-family-history")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    } else {
      window.requestAnimationFrame(() => document.getElementById("mediflow-emr-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    }
    setSyncText(`Correct or verify ${path}, save edits, then reopen review`);
  };

  return (
    <div className="flex h-[calc(100dvh-4.5rem)] min-h-[480px] flex-col gap-2">
      {reviewOpen && !isEnded && <ClinicalReviewDialog consultationId={consultationId} hasUnsavedEdits={manualPending}
        onClose={() => setReviewOpen(false)} onNeedsEdit={navigateToReviewField}
        onCompleted={() => { setIsEnded(true); setReviewOpen(false); setSyncText("Consultation completed with doctor-approved EMR"); }} />}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-2 py-3">
          <div>
            <p className="text-sm text-[hsl(var(--text-muted))]">Patient</p>
            <h2 className="text-lg font-semibold text-[hsl(var(--text-primary))]">{patientName}</h2>
            {patientId ? (
              <Link
                href={`/doctor/patients/${patientId}`}
                className="text-xs font-medium text-[hsl(var(--accent))] underline-offset-2 hover:underline"
              >
                Open consultation history
              </Link>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="info">{consultationType}</Badge>
            <Badge variant={isEnded ? "success" : reviewOpen ? "warning" : "outline"}>{isEnded ? "Completed" : reviewOpen ? "Pending Review" : "Active"}</Badge>
            <Badge variant="outline">
              <Clock3 className="mr-1 h-3.5 w-3.5" />
              {formatElapsed(elapsed)}
            </Badge>
            <Button
              variant="secondary"
              onClick={() => {
                setFollowUpOpen((v) => !v);
                if (!followUpEdited && followUpSuggestion?.days) {
                  setFollowUpDate(toDateInputValue(addDays(new Date(), followUpSuggestion.days)));
                }
              }}
            >
              {followUpDate ? `Follow-up: ${followUpDate}` : "Set Follow-up"}
            </Button>
            <Button variant="danger" onClick={endConsultation} disabled={isEnded || isFinalizing || manualPending}>
              {isFinalizing ? "Preparing Review…" : "Review & Complete"}
            </Button>
            {isEnded && (
              <Link href={`/doctor/consultations/${String(consultationId)}/prescription`} target="_blank">
                <Button variant="primary">
                  <Printer className="mr-2 h-4 w-4" />
                  Print Prescription
                </Button>
              </Link>
            )}
          </div>
        </CardContent>
        {followUpOpen ? (
          <CardContent className="border-t border-[hsl(var(--border))] py-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-end">
              <div className="w-full max-w-xs">
                <Input
                  type="date"
                  label="Next follow-up date"
                  value={followUpDate}
                  onChange={(event) => {
                    setFollowUpDate(event.target.value);
                    setFollowUpEdited(true);
                  }}
                />
              </div>
              <Button variant="secondary" onClick={() => {
                setFollowUpDate("");
                setFollowUpEdited(true);
              }}>
                Clear
              </Button>
              <Button onClick={saveFollowUp} loading={followUpSaving}>
                Save Follow-up
              </Button>
              {followUpSuggestion?.days ? (
                <p className="text-xs text-[hsl(var(--text-muted))]">
                  Suggested from transcript: {followUpSuggestion.days} day(s)
                </p>
              ) : (
                <p className="text-xs text-[hsl(var(--text-muted))]">No follow-up phrase detected yet</p>
              )}
            </div>
            {followUpSuggestion?.evidence ? (
              <p className="mt-1 truncate text-[11px] text-[hsl(var(--text-muted))]" title={followUpSuggestion.evidence}>
                Evidence: {followUpSuggestion.evidence}
              </p>
            ) : null}
            {followUpNotice ? <p className="mt-1 text-xs text-[hsl(var(--text-secondary))]">{followUpNotice}</p> : null}
          </CardContent>
        ) : null}
      </Card>

      <div className={"grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-2 xl:gap-2 " + (historyOpen ? "xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_minmax(0,22rem)]" : "xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_3.25rem]") }>
        <Card className="flex min-h-0 min-w-0 flex-col lg:min-h-[240px] xl:min-h-0">
          <CardHeader className="shrink-0 py-2 pb-1">
            <CardTitle className="text-sm">STT + Transcript</CardTitle>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 overflow-auto px-3 pb-3 pt-0 text-sm text-[hsl(var(--text-secondary))]">
            <div className="space-y-3">
              <STTRecorder
                status={stt.status}
                error={stt.error}
                onStart={stt.start}
                onStop={handleStopClick}
                onPause={async () => { await stt.pause(); await processDeltaExtraction(true); }}
                onResume={stt.resume}
                disabled={isEnded}
              />

              <TranscriptViewer segments={stt.segments as any} interimText={stt.interimText} />
            </div>
          </CardContent>
        </Card>
        <Card className="flex min-h-0 min-w-0 flex-col lg:min-h-[320px] xl:min-h-0">
          <CardHeader className="shrink-0 py-2 pb-1">
            <CardTitle className="text-sm">Live EMR</CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-2 pt-0">
            <div id="mediflow-emr-panel" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [-webkit-overflow-scrolling:touch] xl:overflow-y-auto">
              <EMRLivePanel
                consultationId={consultationId}
                snapshot={emrSnapshot}
                onChangeSnapshot={setEmrSnapshot}
                version={emrVersion}
                onSaved={setEmrVersion}
                onDirtyChange={updateManualPending}
                patientAllergies={patientAllergies}
                liveAllergyAlert={liveAllergyAlert}
              />
            </div>
          </CardContent>
        </Card>
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden lg:col-span-2 xl:col-span-1">
          <div className={historyOpen ? "mb-2 flex justify-start" : "mb-2 flex justify-center"}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-9 w-9 rounded-full px-0"
              onClick={() => setHistoryOpen((open) => !open)}
              aria-expanded={historyOpen}
              aria-label={historyOpen ? "Hide patient history" : "Show patient history"}
            >
              {historyOpen ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            </Button>
          </div>
          <div className={"min-h-0 flex-1 overflow-hidden transition-all duration-300 ease-out " + (historyOpen ? "opacity-100 translate-x-0 pl-4" : "pointer-events-none opacity-0 translate-x-2 pl-0")}>
            <div id="mediflow-family-history" className="h-full overflow-y-auto">
              <PatientHistoryPanel consultationId={consultationId} />
            </div>
          </div>
        </div>
      </div>

      {!auditExpanded ? (
        <div className="fixed bottom-4 right-4 z-40">
          <Button
            type="button"
            variant="secondary"
            className="h-10 rounded-full px-4 shadow-[var(--shadow-md)]"
            onClick={() => setAuditExpanded(true)}
            aria-label="Open audit trail"
          >
            <PanelRightOpen className="h-4 w-4" />
            Audit Trail
          </Button>
        </div>
      ) : (
        <div className="pointer-events-none fixed bottom-4 right-4 z-40 w-[min(92vw,22rem)]">
          <div className="pointer-events-auto">
            <Card className="overflow-hidden shadow-[var(--shadow-md)]">
              <CardHeader className="py-2 pb-1">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm">Audit Trail</CardTitle>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-8 px-2 text-xs"
                    onClick={() => setAuditExpanded(false)}
                    aria-label="Collapse audit trail"
                  >
                    <PanelRightClose className="h-4 w-4" />
                    Collapse
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 px-3 pb-3 pt-0">
                <p className="text-xs text-[hsl(var(--text-muted))]">{syncText}</p>
                {auditError ? <p className="text-xs text-[hsl(var(--danger))]">{auditError}</p> : null}
                {(auditEvents ?? []).length ? (
                  <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
                    {auditEvents.slice(0, 8).map((event) => (
                      <div
                        key={event.id}
                        className="rounded-[calc(var(--radius)-4px)] border border-[hsl(var(--border))] bg-[hsl(var(--bg-card))] px-2 py-1.5 transition-colors hover:bg-[hsl(var(--bg-secondary))]"
                        title={event.changed_paths.join(", ")}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium text-[hsl(var(--text-primary))]">#{event.sequence_no ?? "-"} {event.event_type ?? "event"}</p>
                          <p className="text-[10px] text-[hsl(var(--text-muted))]">{event.created_at ? new Date(event.created_at).toLocaleTimeString("en-IN") : ""}</p>
                        </div>
                        <p className="text-[10px] text-[hsl(var(--text-secondary))]">{event.source ?? "-"} · {event.actor_role ?? "-"}</p>
                        {event.changed_paths.length ? (
                          <p className="truncate text-[10px] text-[hsl(var(--text-muted))]">changed: {event.changed_paths.slice(0, 3).join(", ")}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-[hsl(var(--text-muted))]">No audit events yet.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
