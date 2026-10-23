import { performance } from "node:perf_hooks";

// A closed, content-free, process-local diagnostic contract. Parent spans are
// inclusive; concurrent or nested spans must never be summed as total time.
export const LOCAL_REFRESH_TIMING_STAGES = Object.freeze([
  "refresh_runner", "refresh_setup", "quota_collect", "quota_publish", "index_refresh",
  "reuse_proof_before", "reuse_check", "cache_read", "accounting_rebuild",
  "reuse_proof_after", "reuse_remember", "proof_index_read", "proof_origins",
  "snapshot_reload", "snapshot_build", "snapshot_clone", "snapshot_persist", "snapshot_prepare_state", "snapshot_accounting_read", "snapshot_index_projection",
  "snapshot_collector_projection", "accounting_scan", "accounting_corpus_open",
  "accounting_fit", "accounting_weekly_origins", "accounting_weekly_intervals",
  "accounting_transitions", "accounting_corpus_finish", "accounting_finalize",
  "accounting_prepare_state", "accounting_validate", "accounting_publish",
]);
const STAGES = new Set(LOCAL_REFRESH_TIMING_STAGES);
const REUSE_PHASES = new Set(["proof_before", "lookup", "proof_after", "remember"]);
const REUSE_CODES = new Set([
  "context_unavailable", "file_unavailable", "session_limit", "generation_changed",
  "origins_unavailable", "origins_unknown", "identity_changed", "proof_available",
  "proof_unavailable", "retained_absent", "inputs_changed", "clock_invalid", "expired",
  "fallback_present", "intervals_unavailable", "cache_invalid", "cache_oversize",
  "proof_changed", "retained", "reused", "republished", "operation_failed",
]);
const ORIGIN_CODES = new Set([
  "requested", "known", "unknown", "thread_row_missing", "thread_row_invalid",
  "unknown_with_usage", "unknown_without_usage", "metadata_invalid_request", "metadata_home_unavailable",
  "metadata_database_missing", "metadata_database_changed", "metadata_database_busy", "metadata_access_refused",
  "metadata_schema_unsupported", "metadata_origin_columns_missing", "metadata_parent_limit",
  "metadata_read_failed", "metadata_close_failed",
]);
export function reportLocalRefreshOriginDiagnostic(observer, phase, code, count) {
  if (typeof observer !== "function") return;
  try { Promise.resolve(observer(Object.freeze({ phase, code, count }))).catch(() => {}); }
  catch { /* Origin diagnostics cannot change proof eligibility. */ }
}
export function reportLocalRefreshReuseDiagnostic(observer, phase, code) {
  if (typeof observer !== "function" || !REUSE_PHASES.has(phase) || !REUSE_CODES.has(code)) return;
  try { Promise.resolve(observer(Object.freeze({ phase, code }))).catch(() => {}); }
  catch { /* Diagnostic observers cannot affect the cache gate. */ }
}
const MAX_MS = 86_400_000;
const monotonicNow = () => performance.now();
const instant = clock => {
  try { const value = clock(); return Number.isFinite(value) ? value : null; }
  catch { return null; }
};
const duration = (start, end) => start !== null && end !== null && end >= start && end - start <= MAX_MS
  ? Math.round((end - start) * 1000) / 1000 : null;

export function createLocalRefreshTimer({ onTiming = null, clock = monotonicNow } = {}) {
  if (onTiming !== null && typeof onTiming !== "function") throw new TypeError("onTiming must be a function or null");
  if (typeof clock !== "function") throw new TypeError("timing clock must be a function");
  function start(stage) {
    if (!STAGES.has(stage)) throw new TypeError("unknown refresh timing stage");
    const began = onTiming === null ? null : instant(clock);
    let done = false;
    return (error = null) => {
      if (done) return;
      done = true;
      if (onTiming === null) return;
      const wallMs = duration(began, instant(clock));
      if (wallMs === null) return;
      const outcome = error === null ? "completed" : error?.name === "AbortError" ? "cancelled" : "failed";
      try {
        // Optional observers cannot change accounting, cancellation or writes.
        Promise.resolve(onTiming(Object.freeze({ stage, wallMs, outcome }))).catch(() => {});
      } catch { /* Diagnostics are independent of the operation's result. */ }
    };
  }
  async function measure(stage, work) {
    const finish = start(stage);
    try { const value = await work(); finish(); return value; }
    catch (error) { finish(error ?? {}); throw error; }
  }
  function measureSync(stage, work) {
    const finish = start(stage);
    try { const value = work(); finish(); return value; }
    catch (error) { finish(error ?? {}); throw error; }
  }
  return { start, measure, measureSync };
}

export function createLocalRefreshTimingRecorder({ clock = monotonicNow } = {}) {
  if (typeof clock !== "function") throw new TypeError("timing clock must be a function");
  const began = instant(clock), stages = new Map(), reuse = new Map(), origins = new Map();
  let finished = false, totalMs = null;
  const record = value => {
    if (finished || !value || Object.keys(value).sort().join() !== "outcome,stage,wallMs"
        || !STAGES.has(value.stage) || !Number.isFinite(value.wallMs) || value.wallMs < 0 || value.wallMs > MAX_MS
        || !["completed", "failed", "cancelled"].includes(value.outcome)) return;
    const row = stages.get(value.stage) ?? { stage: value.stage, wallMs: 0, calls: 0, failed: 0, cancelled: 0 };
    if (row.calls >= Number.MAX_SAFE_INTEGER || row.wallMs + value.wallMs > MAX_MS) return;
    row.wallMs = Math.round((row.wallMs + value.wallMs) * 1000) / 1000;
    row.calls++;
    if (value.outcome !== "completed") row[value.outcome]++;
    stages.set(value.stage, row);
  };
  return {
    record,
    recordReuse(value) {
      if (finished || !value || Object.keys(value).sort().join() !== "code,phase"
          || !REUSE_PHASES.has(value.phase) || !REUSE_CODES.has(value.code)) return;
      const key = `${value.phase}:${value.code}`;
      const row = reuse.get(key) ?? { phase: value.phase, code: value.code, calls: 0 };
      if (row.calls < Number.MAX_SAFE_INTEGER) row.calls++;
      reuse.set(key, row);
    },
    recordOrigin(value) {
      if (finished || !value || Object.keys(value).sort().join() !== "code,count,phase"
          || !["proof_before", "proof_after"].includes(value.phase) || !ORIGIN_CODES.has(value.code)
          || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > 25_000) return;
      const key = `${value.phase}:${value.code}`;
      const row = origins.get(key) ?? { phase: value.phase, code: value.code, count: 0 };
      if (row.count + value.count > 25_000) return;
      row.count += value.count;
      origins.set(key, row);
    },
    finish() { if (!finished) { totalMs = duration(began, instant(clock)); finished = true; } },
    snapshot() { return { schemaVersion: "local-refresh-timing-v1", totalMs: finished ? totalMs : null,
      stages: LOCAL_REFRESH_TIMING_STAGES.flatMap(stage => stages.has(stage) ? [{ ...stages.get(stage) }] : []),
      reuse: [...reuse.values()].map(row => ({ ...row })),
      origins: [...origins.values()].map(row => ({ ...row })) }; },
  };
}
