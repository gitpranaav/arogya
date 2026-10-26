import type { TranscriptSegment } from "../emr/types";

/** Browser scheduling only. Server-side transcript cursor remains authoritative. */
export const BATCH_POLICY = Object.freeze({ maxSegments: 12, maxChars: 3600, maxWaitMs: 4000, quietMs: 900 });
export type BatchDecision = { segments: TranscriptSegment[]; ready: boolean; reason: "empty" | "size" | "count" | "boundary" | "age" | "flush" | "waiting" };

export function chooseTranscriptBatch(
  pending: readonly TranscriptSegment[], nowMs: number, firstQueuedAtMs: number,
  lastArrivalAtMs: number, force = false,
): BatchDecision {
  if (!pending.length) return { segments: [], ready: false, reason: "empty" };
  const selected: TranscriptSegment[] = [];
  let chars = 0;
  for (const segment of pending) {
    if (selected.length >= BATCH_POLICY.maxSegments || (selected.length && chars + segment.text.length > BATCH_POLICY.maxChars)) break;
    selected.push(segment);
    chars += segment.text.length;
  }
  // Do not split a single finalized segment; the server enforces its own size ceiling.
  const capped = selected.length < pending.length;
  const last = selected[selected.length - 1];
  const punctuated = /[.!?।]\s*$/.test(last.text);
  const quiet = nowMs - lastArrivalAtMs >= BATCH_POLICY.quietMs;
  const elapsed = nowMs - firstQueuedAtMs >= BATCH_POLICY.maxWaitMs;
  const reason = force ? "flush" : capped ? (selected.length >= BATCH_POLICY.maxSegments ? "count" : "size")
    : punctuated && quiet ? "boundary" : elapsed ? "age" : "waiting";
  return { segments: selected, ready: reason !== "waiting", reason };
}

/** A skipped cursor must not silently advance past speech not yet processed. */
export function pendingFromCursor(segments: readonly TranscriptSegment[], cursorId: string | null): TranscriptSegment[] | null {
  const finalized = segments.filter(s => s.is_final !== false);
  if (!cursorId) return finalized;
  const at = finalized.findIndex(s => s.id === cursorId);
  return at < 0 ? null : finalized.slice(at + 1);
}
