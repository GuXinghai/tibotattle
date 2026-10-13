// Test seam for the calibration corpus the accounting build takes from its
// `calibrationSource`. A plain scanner's usage and rate-limit facts are held
// resident here and projected with the same production projections the
// shipping corpus uses, so a test can drive the build with an ordinary scan
// and still exercise the real fold. The scan's result is shaped as a complete
// unified-reader result, which the build now requires.
import { REPLAY_SAFE_CALIBRATION_INTERNALS as internals, createAccountingPricer } from "../../src/replay-safe-accounting-cache.js";
import { declaredSpeedModeAt } from "../../src/codex-speed-baseline.js";

const {
  ALLOWANCE_HISTORY_WINDOW_MINUTES,
  STREAMED_USAGE_MEMO_BYTES,
  STREAMED_USAGE_STAMP_BYTES,
  calibrationPlanEvidence,
  eventProjection,
  fixedError,
  transitionUsageProjection,
  weeklyRateLimitProjection,
} = internals;

export const TEST_GENERATION = "generation-test-1";
export const TEST_GENERATION_FINGERPRINT = "generation-fingerprint-test-1";
const TEST_START_AT = "2026-07-20T12:00:00.000Z";
const TEST_END_AT = "2026-07-27T12:00:00.000Z";
const USAGE_GRACE_MS = 5 * 60_000;

function corpusFrom({ usage, snapshots, startAt, endMs, declaredSpeedBaselines, limits }) {
  const price = createAccountingPricer();
  const compact = [];
  for (const rawEvent of usage) {
    const observedMs = Date.parse(rawEvent?.timestamp);
    if (!Number.isFinite(observedMs) || observedMs > endMs + USAGE_GRACE_MS) continue;
    const event = eventProjection(rawEvent, price);
    if (event === null || event.isSpark) continue;
    event.declaredSpeed = event.speed === "unknown"
      ? declaredSpeedModeAt(declaredSpeedBaselines, observedMs) ?? "unknown"
      : "unknown";
    compact.push({ observedMs, row: transitionUsageProjection(rawEvent, event) });
  }
  // The shipping corpus is ordered by event time; ties keep delivery order.
  compact.sort((left, right) => left.observedMs - right.observedMs);
  const rows = compact.map((entry) => entry.row);
  const usageMs = compact.map((entry) => entry.observedMs);
  const planEvidence = calibrationPlanEvidence({ ordered: true, maximum: limits.weeklySnapshots });
  const weekly = [];
  for (const snapshot of snapshots) {
    const observedMs = Date.parse(snapshot?.timestamp);
    if (!Number.isFinite(observedMs)) continue;
    planEvidence.observe(snapshot);
    const window = snapshot?.window;
    if (window?.limitId === "codex"
        && ALLOWANCE_HISTORY_WINDOW_MINUTES.has(window.windowDurationMins)) {
      weekly.push(weeklyRateLimitProjection(snapshot));
    }
  }
  const retainedUsageEvents = rows.length;
  const usageMetadataBytes = retainedUsageEvents * (STREAMED_USAGE_STAMP_BYTES + STREAMED_USAGE_MEMO_BYTES);
  // The shipping corpus refuses a usage stamp budget it cannot hold, before
  // any row is materialized; the fake keeps the same typed refusal.
  if (usageMetadataBytes > limits.retainedBytes) {
    throw fixedError("accounting_transition_memory_budget_exceeded");
  }
  return {
    commitSeq: 1,
    coveredAt: { startAt, endAt: new Date(endMs).toISOString() },
    retainedUsageEvents,
    usageMetadataCapacity: retainedUsageEvents,
    usageMetadataBytes,
    weeklyRateLimitSnapshots: weekly,
    planAttribution: planEvidence.finish(),
    usageMs,
    metrics: () => ({ retainedUsageEvents, weeklySnapshots: weekly.length, commitSeq: 1 }),
    readUsageSlice: async (low, high) => (low >= high ? [] : rows.slice(low, high)),
    forEachRetainedUsage: async (consume) => {
      for (const row of rows) await consume(row);
    },
    finish: async () => {},
    dispose: () => {},
  };
}

/**
 * Wraps a scan callback. The wrapper records the usage and rate-limit facts
 * the build's main scan delivers (the call that carries `indexedHistory`; the
 * history fallback read does not), returns a complete unified-reader result,
 * and exposes the matching calibration source as `scan.calibrationSource`.
 */
export function withResidentCalibration(scanCallback, {
  generation = TEST_GENERATION,
  generationFingerprint = TEST_GENERATION_FINGERPRINT,
  coverageStatus = "complete",
  generationProof = true,
  startAt = TEST_START_AT,
  endAt = TEST_END_AT,
} = {}) {
  const recorded = { usage: [], snapshots: [], startAt: null };
  const scan = async (options = {}) => {
    const isMainScan = options.indexedHistory !== undefined;
    if (isMainScan) {
      recorded.usage = [];
      recorded.snapshots = [];
      recorded.startAt = options.startAt ?? null;
    }
    const deliverUsage = (rawEvent) => {
      if (isMainScan) recorded.usage.push(rawEvent);
      return options.onUsage?.(rawEvent);
    };
    const deliverSnapshot = (snapshot) => {
      if (isMainScan) recorded.snapshots.push(snapshot);
      return options.onRateLimitSnapshot?.(snapshot);
    };
    const result = await scanCallback({
      ...options,
      onUsage: deliverUsage,
      onRateLimitSnapshot: deliverSnapshot,
    });
    scan.calls += 1;
    return {
      readerVersion: "test-unified-reader-v1",
      schemaVersion: "test-unified-schema-v1",
      parserVersion: "test-parser-v1",
      contractVersion: "test-contract-v1",
      generation,
      generationFingerprint,
      coverage: {
        status: coverageStatus,
        blockReason: null,
        skippedSourceCount: 0,
        skippedSourceBytes: 0,
        skippedThreadCount: 0,
        generationProof,
        generatedAt: endAt,
        coveredAt: { startAt, endAt },
      },
      diagnosticsAvailable: true,
      capabilities: {
        readsRawSources: false,
        deterministicCanonicalOrder: true,
        sourceOrderingProvenance: true,
        sourceOffsetProvenance: true,
        sourceScopedQuotaOccurrences: true,
        durableDiagnostics: true,
        crashSafeGenerationPublication: true,
      },
      diagnostics: result?.diagnostics ?? {},
    };
  };
  scan.calls = 0;
  scan.calibrationSource = {
    probe: async () => recorded.usage.length > 0,
    open: async ({ endMs, limits, declaredSpeedBaselines = [] }) => corpusFrom({
      usage: recorded.usage,
      snapshots: recorded.snapshots,
      startAt: recorded.startAt ?? new Date(endMs - 365 * 24 * 60 * 60 * 1_000).toISOString(),
      endMs,
      declaredSpeedBaselines,
      limits,
    }),
  };
  return scan;
}
