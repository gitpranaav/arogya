/** De-identified operational metrics only; never log clinical text, IDs or provider credentials. */
export function recordExtractionMetric(mode: "delta" | "final", event: "success" | "failure" | "cache", values: {
  inputChars?: number; providerMs?: number; totalMs?: number; inputTokens?: number; outputTokens?: number; historicalItems?: number;
}) {
  if (process.env.MEDIFLOW_METRICS !== "1") return;
  const safe: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) if (typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key] = Math.round(value);
  console.info(JSON.stringify({ event: "mediflow_extraction_stage6", mode, outcome: event, ...safe }));
}
