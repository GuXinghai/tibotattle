/**
 * Content-free diagnostics shared by the Windows Electron smoke harnesses.
 *
 * These pure validators and classifiers consume only closed, bounded markers
 * from the Electron main process. They never expose renderer, companion, or
 * refresh response data.
 */

const COMPANION_PROCESS_PREFIX = "TIBOTATTLE_ELECTRON_COMPANION_PROCESS ";
const DASHBOARD_FAILURE_PREFIX = "TIBOTATTLE_ELECTRON_DASHBOARD_FAILURE ";
const RENDER_PROCESS_FAILURE_REASONS = new Set([
  "clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "unknown",
]);
const COMPANION_PROCESS_OUTCOMES = new Set([
  "exit_zero", "exit_nonzero", "signal_abrt", "signal_segv", "signal_kill", "signal_term", "signal_other",
]);

function validateCompanionProcessEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Reflect.ownKeys(value).length !== 3
      || !["starting", "ready", "stopping"].includes(value.phase)) return null;
  if (value.event === "started" && value.phase === "starting" && value.outcome === null
      || value.event === "exited" && COMPANION_PROCESS_OUTCOMES.has(value.outcome)) {
    return Object.freeze({ event: value.event, phase: value.phase, outcome: value.outcome });
  }
  return null;
}

export function validateCompanionProcessDiagnostics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Reflect.ownKeys(value).length !== 2) return null;
  const lastEvent = value.lastEvent === null ? null : validateCompanionProcessEvent(value.lastEvent);
  const firstUnexpectedExit = value.firstUnexpectedExit === null ? null
    : validateCompanionProcessEvent(value.firstUnexpectedExit);
  if (value.lastEvent !== null && lastEvent === null
      || value.firstUnexpectedExit !== null && firstUnexpectedExit === null
      || firstUnexpectedExit !== null && (lastEvent === null
        || firstUnexpectedExit.event !== "exited" || firstUnexpectedExit.phase === "stopping")) return null;
  return Object.freeze({ lastEvent, firstUnexpectedExit });
}

function createDiagnosticLineReader(onLine) {
  let pending = "";
  let discarding = false;
  return (chunk) => {
    const pieces = Buffer.from(chunk).toString("utf8").split("\n");
    for (let index = 0; index < pieces.length; index += 1) {
      if (!discarding) {
        if (pending.length + pieces[index].length > 512) { pending = ""; discarding = true; }
        else pending += pieces[index];
      }
      if (index < pieces.length - 1) {
        if (!discarding) onLine(pending);
        pending = ""; discarding = false;
      }
    }
  };
}

export function validateDashboardFailureDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Reflect.ownKeys(value).length !== 2) return null;
  const boundedNetworkCode = Number.isInteger(value.reason) && value.reason >= -999 && value.reason <= -1;
  if ((value.stage === "load_url" || value.stage === "did_fail_load") && (value.reason === null || boundedNetworkCode)
      || value.stage === "render_process_gone" && RENDER_PROCESS_FAILURE_REASONS.has(value.reason)) {
    return Object.freeze({ stage: value.stage, reason: value.reason });
  }
  return null;
}

export function createDashboardFailureDiagnostics() {
  let failure = null;
  return Object.freeze({
    feed: createDiagnosticLineReader((line) => {
      if (failure !== null || !line.startsWith(DASHBOARD_FAILURE_PREFIX)) return;
      try { failure = validateDashboardFailureDiagnostic(JSON.parse(line.slice(DASHBOARD_FAILURE_PREFIX.length))); }
      catch { /* Other stderr is discarded. */ }
    }),
    snapshot: () => failure,
  });
}

/** Consume only a closed main-process marker; discard every other stderr byte. */
export function createCompanionProcessDiagnostics() {
  let lastEvent = null;
  let firstUnexpectedExit = null;
  function line(value) {
    if (!value.startsWith(COMPANION_PROCESS_PREFIX)) return;
    let event;
    try { event = validateCompanionProcessEvent(JSON.parse(value.slice(COMPANION_PROCESS_PREFIX.length))); }
    catch { return; }
    if (event === null) return;
    lastEvent = event;
    if (firstUnexpectedExit === null && event.event === "exited" && event.phase !== "stopping") {
      firstUnexpectedExit = event;
    }
  }
  return Object.freeze({
    feed: createDiagnosticLineReader(line),
    snapshot: () => validateCompanionProcessDiagnostics({ lastEvent, firstUnexpectedExit }),
  });
}

export const ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES = Object.freeze({
  duplicate: "ELECTRON_SMOKE_STARTUP_REFRESH_DUPLICATED",
  invalidReceipt: "ELECTRON_SMOKE_STARTUP_REFRESH_RECEIPT_INVALID",
  changedReceipt: "ELECTRON_SMOKE_STARTUP_REFRESH_RECEIPT_CHANGED",
  acceptanceTimeout: "ELECTRON_SMOKE_STARTUP_REFRESH_ACCEPTANCE_TIMEOUT",
  completionTimeout: "ELECTRON_SMOKE_STARTUP_REFRESH_COMPLETION_TIMEOUT",
  failed: "ELECTRON_SMOKE_STARTUP_REFRESH_FAILED",
  cancelled: "ELECTRON_SMOKE_STARTUP_REFRESH_CANCELLED",
  degradedInvalid: "ELECTRON_SMOKE_STARTUP_REFRESH_DEGRADED_INVALID",
  boundaryInvalid: "ELECTRON_SMOKE_REFRESH_BOUNDARY_INVALID",
});

export const ELECTRON_SMOKE_DEGRADED_FAILURE_CODES = Object.freeze([
  "codex_rollout_compression_unsupported",
  "codex_rollout_filename_identity_mismatch",
  "codex_rollout_generation_ambiguous",
  "codex_rollout_lineage_invalid",
  "codex_rollout_content_invalid",
  "codex_rollout_tail_incomplete",
]);

const DEGRADED_FAILURE_CODE_SET = new Set(
  ELECTRON_SMOKE_DEGRADED_FAILURE_CODES,
);

/**
 * Classify one renderer startup-refresh observation without consulting the
 * companion or exposing any response data.  Keeping this decision pure lets
 * the contract lane exercise stale receipts, duplicate renderer requests,
 * and terminal receipt transitions independently of an Electron runtime.
 */
export function classifyAutomaticStartupRefreshReceipt({
  phase,
  requestCount,
  refresh,
  previousRefreshId = null,
  expectedRefreshId = null,
} = {}) {
  if (!Number.isInteger(requestCount) || requestCount < 0) {
    return Object.freeze({
      status: "failed",
      errorCode: ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.duplicate,
    });
  }
  if (requestCount > 1) {
    return Object.freeze({
      status: "failed",
      errorCode: ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.duplicate,
    });
  }
  if (requestCount === 0 && phase === "acceptance") {
    return Object.freeze({ status: "pending" });
  }
  if (requestCount === 0) {
    return Object.freeze({
      status: "failed",
      errorCode: ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.duplicate,
    });
  }
  if (refresh?.status === "idle") {
    return Object.freeze({ status: "pending" });
  }
  if (typeof refresh?.refreshId !== "string" || refresh.refreshId.length === 0) {
    return Object.freeze({
      status: "failed",
      errorCode: ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.invalidReceipt,
    });
  }
  if (phase === "acceptance") {
    if (refresh.refreshId === previousRefreshId) {
      return Object.freeze({ status: "pending" });
    }
    return Object.freeze({ status: "accepted", refreshId: refresh.refreshId });
  }
  if (phase !== "completion" || refresh.refreshId !== expectedRefreshId) {
    return Object.freeze({
      status: "failed",
      errorCode: ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.changedReceipt,
    });
  }
  if (refresh.status === "succeeded") {
    return Object.freeze({
      status: "completed",
      refreshId: refresh.refreshId,
      terminalStatus: "succeeded",
    });
  }
  if (refresh.status === "degraded") {
    const generation = refresh.result?.unifiedIndex?.generation;
    const accounting = refresh.result?.accounting;
    const coherent = refresh.errorCode === "refresh_degraded"
      && refresh.failedStep === "unified_index"
      && DEGRADED_FAILURE_CODE_SET.has(refresh.failureCode)
      && refresh.result?.unifiedIndex?.status === "ingested"
      && generation?.status === "partial"
      && generation?.blockReason === "codex_rollout_sources_quarantined"
      && Number.isSafeInteger(generation.skippedSourceCount)
      && generation.skippedSourceCount > 0
      && Number.isSafeInteger(generation.skippedThreadCount)
      && generation.skippedThreadCount > 0
      && Number.isSafeInteger(generation.reasonCounts?.[refresh.failureCode])
      && generation.reasonCounts[refresh.failureCode] > 0
      && generation.discoveryComplete === true
      && generation.diagnosticsComplete === true
      && generation.usageProvenanceComplete === true
      && generation.sourceOrderComplete === true
      && generation.quotaProvenanceComplete === true
      && accounting?.status === "replay_safe"
      && accounting.sourceMode === "unified"
      && accounting.coverageStatus === "partial"
      && accounting.generationMatched === true
      && accounting.fallbackCount === 0
      && accounting.diagnosticsAvailable === true;
    return coherent
      ? Object.freeze({
        status: "completed",
        refreshId: refresh.refreshId,
        terminalStatus: "degraded",
        degradedFailureCode: refresh.failureCode,
      })
      : Object.freeze({
        status: "failed",
        errorCode: ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.degradedInvalid,
      });
  }
  if (refresh.status === "failed") {
    return Object.freeze({
      status: "failed",
      errorCode: ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.failed,
    });
  }
  if (refresh.status === "cancelled") {
    return Object.freeze({
      status: "failed",
      errorCode: ELECTRON_SMOKE_STARTUP_REFRESH_ERROR_CODES.cancelled,
    });
  }
  return Object.freeze({ status: "pending", refreshId: refresh.refreshId });
}
