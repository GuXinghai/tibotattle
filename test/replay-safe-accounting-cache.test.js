import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY,
  REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
  assertReplaySafeAccountingCache,
  buildReplaySafeAccountingCache as buildReplaySafeAccountingCacheImpl,
  buildReplaySafeAccountingPeriod,
  createAccountingPricer,
  decodePlanScopedTimelineRow,
  readReplaySafeAccountingCache as readReplaySafeAccountingCacheImpl,
  refreshReplaySafeAccountingCache as refreshReplaySafeAccountingCacheImpl,
} from "../src/replay-safe-accounting-cache.js";
import {
  TEST_GENERATION,
  TEST_GENERATION_FINGERPRINT,
  withResidentCalibration,
} from "./helpers/replay-safe-resident-calibration.js";
import { addUsdStrings, priceCodexUsageEvent, summarizeQuotaWeightedAccounting } from "@app-usagemonitor/accounting";
import {
  readLocalCollectorAccountingCache,
  serializeLocalCollectorAccountingCache,
  writeLocalCollectorAccountingCache,
} from "../src/local-collector-state.js";
import {
  buildRollingQuotaComparisons,
} from "@app-usagemonitor/quota-analysis";

// A scanner built by these helpers carries its own calibration source. A call
// that supplies such a scanner and names no source mode is a unified build
// bound to the helpers' generation, which is the only source the build takes.
function withSourceSeams(options = {}) {
  // A bare scan callback is lifted onto the seam so its usage and rate-limit
  // facts also feed the calibration corpus.
  const scan = typeof options.scan === "function" && options.scan.calibrationSource === undefined
    ? withResidentCalibration(options.scan)
    : options.scan;
  const calibrationSource = options.calibrationSource
    ?? scan?.calibrationSource
    ?? undefined;
  const seamed = calibrationSource === undefined
    ? { ...options }
    : { ...options, scan, calibrationSource };
  if (calibrationSource !== undefined
      && options.sourceMode === undefined
      && options.expectedGeneration === undefined) {
    seamed.sourceMode = "unified";
    seamed.expectedGeneration = TEST_GENERATION;
  }
  return seamed;
}

function buildReplaySafeAccountingCache(options = {}) {
  return buildReplaySafeAccountingCacheImpl(withSourceSeams(options));
}

// The previous JSON paths are test-fixture names only. The wrappers prove the
// same cache contracts against SQLite without allowing production callers to
// use the retired cacheFile option.
function refreshReplaySafeAccountingCache({ cacheFile, ...options } = {}) {
  return refreshReplaySafeAccountingCacheImpl(withSourceSeams({
    ...options,
    ...(cacheFile === undefined ? {} : { stateFile: cacheFile }),
  }));
}

function readReplaySafeAccountingCache({ cacheFile, ...options } = {}) {
  return readReplaySafeAccountingCacheImpl({
    ...options,
    ...(cacheFile === undefined ? {} : { stateFile: cacheFile }),
  });
}

async function writeTestCache(stateFile, cache) {
  await writeLocalCollectorAccountingCache({ stateFile, cache });
}

async function readTestCache(stateFile) {
  return (await readLocalCollectorAccountingCache({ stateFile })).cache;
}

test("a full year of usage can publish a compact cache above the former 16 MiB ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-cache-byte-budget-"));
  const stateFile = join(directory, "state.sqlite");
  const bucketCount = 365 * 24 * 4;
  try {
    const cache = await refreshReplaySafeAccountingCache({
      cacheFile: stateFile,
      now: () => NOW,
      scan: async ({ onUsage }) => {
        for (let bucket = 0; bucket < bucketCount; bucket += 1) {
          onUsage(usageEvent({
            timestamp: new Date(NOW - bucket * 15 * 60_000).toISOString(),
            components: { input_uncached_tokens: 1_000 },
          }));
        }
        return { diagnostics: {} };
      },
    });
    const size = Buffer.byteLength(serializeLocalCollectorAccountingCache(cache));
    assert.ok(size > 16 * 1024 * 1024, "the actual compact cache crosses the former publication ceiling");
    assert.ok(size < 128 * 1024 * 1024);
    assert.equal(cache.timeline.length, bucketCount);
    assert.equal(cache.periods.find((period) => period.id === "all").events, bucketCount);
    const read = await readReplaySafeAccountingCache({ cacheFile: stateFile, now: () => NOW });
    assert.equal(read.status, "available");
    assert.deepEqual(read.cache, cache);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production replay-cache APIs reject the retired JSON cacheFile option", async () => {
  await assert.rejects(
    refreshReplaySafeAccountingCacheImpl({ cacheFile: "/private/retired.json" }),
    /cacheFile was retired; use stateFile/u,
  );
  await assert.rejects(
    readReplaySafeAccountingCacheImpl({ cacheFile: "/private/retired.json" }),
    /cacheFile was retired; use stateFile/u,
  );
});

test("a direct cache build without a scanner or explicit source mode fails closed", async () => {
  await assert.rejects(
    buildReplaySafeAccountingCache({ now: () => NOW }),
    (error) => error?.code === "accounting_source_required",
  );
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      scan: completeUnifiedScanner([]),
      now: () => NOW,
    }),
    (error) => error?.code === "accounting_unified_generation_required",
  );
  await assert.rejects(
    readReplaySafeAccountingCacheImpl({
      stateFile: "/private/unbound-unified-cache.sqlite",
      sourceMode: "unified",
    }),
    (error) => error?.code === "accounting_unified_generation_required",
  );
});

test("unified builds reject incomplete coverage and generation mismatches", async () => {
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: "generation-test-1",
      scan: completeUnifiedScanner([], { coverageStatus: "partial" }),
      now: () => NOW,
    }),
    (error) => error?.code === "accounting_unified_coverage_incomplete",
  );
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: "generation-test-2",
      scan: completeUnifiedScanner([]),
      now: () => NOW,
    }),
    (error) => error?.code === "accounting_unified_generation_mismatch",
  );
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: {
        id: "generation-test-1",
        fingerprint: "generation-fingerprint-expected",
      },
      scan: completeUnifiedScanner([], {
        generationFingerprint: "generation-fingerprint-observed",
      }),
      now: () => NOW,
    }),
    (error) => error?.code === "accounting_unified_generation_mismatch",
  );
});

test("numeric-like object generation ids normalize without changing fingerprints", async () => {
  const cache = await buildReplaySafeAccountingCache({
    sourceMode: "unified",
    expectedGeneration: {
      id: "1.0",
      fingerprint: "generation-fingerprint-test-1",
    },
    scan: completeUnifiedScanner([], { generation: 1 }),
    now: () => NOW,
  });
  assert.equal(cache.sourceDescriptor.generation, "1");
  assert.equal(
    cache.sourceDescriptor.generationFingerprint,
    "generation-fingerprint-test-1",
  );

  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: {
        id: "1.0",
        fingerprint: "1.0",
      },
      scan: completeUnifiedScanner([], {
        generation: 1,
        generationFingerprint: "1",
      }),
      now: () => NOW,
    }),
    (error) => error?.code === "accounting_unified_generation_mismatch",
  );
});

test("unified cache history is attached only after a matching second generation read", async () => {
  const scan = completeUnifiedScanner([
    usageEvent({
      timestamp: "2026-07-27T11:00:00.000Z",
      components: { input_uncached_tokens: 1_000 },
    }),
  ]);
  const cache = await buildReplaySafeAccountingCache({
    sourceMode: "unified",
    expectedGeneration: "generation-test-1",
    scan,
    now: () => NOW,
  });
  assert.equal(scan.calls, 2);
  assert.equal(cache.sourceDescriptor.mode, "unified");
  assert.equal(cache.sourceDescriptor.generation, "generation-test-1");
  assert.equal(cache.history.status, "available");
  assert.equal(cache.history.coverage.status, "complete");
  assert.equal(cache.history.generation, "generation-test-1");
  assert.equal(
    cache.history.generationFingerprint,
    "generation-fingerprint-test-1",
  );
  assert.equal(
    cache.history.coverage.generationFingerprint,
    "generation-fingerprint-test-1",
  );
  assert.equal(cache.history.period.id, "history");
  assert.equal(cache.history.period.events, 1);
});

test("cache reads invalidate when the unified generation no longer matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-generation-reuse-"));
  const stateFile = join(directory, "local-collector-state-v1.sqlite");
  const scan = completeUnifiedScanner([]);
  await refreshReplaySafeAccountingCache({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: "generation-test-1",
    scan,
    now: () => NOW,
  });
  const available = await readReplaySafeAccountingCacheImpl({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: "generation-test-1",
    contextBehavior: "source_native",
  });
  assert.equal(available.status, "available");
  assert.deepEqual(available.cache.sourceDescriptor, {
    schemaVersion: "local-accounting-source-descriptor-v1",
    mode: "unified",
    contextBehavior: "source_native",
    readerVersion: "test-unified-reader-v1",
    schemaVersionUsed: "test-unified-schema-v1",
    parserVersion: "test-parser-v1",
    contractVersion: "test-contract-v1",
    generation: "generation-test-1",
    generationFingerprint: "generation-fingerprint-test-1",
    coverageStatus: "complete",
    coverage: {
      status: "complete",
      blockReason: null,
      skippedSourceCount: 0,
      skippedSourceBytes: 0,
      skippedThreadCount: 0,
      generatedAt: "2026-07-27T12:00:00.000Z",
      coveredAt: {
        startAt: "2026-07-20T12:00:00.000Z",
        endAt: "2026-07-27T12:00:00.000Z",
      },
      sourceCount: null,
      sourceBytes: null,
      usageEvents: null,
      quotaObservations: null,
      quotaOccurrences: null,
      admittedQuotaOccurrences: null,
      generationProof: true,
    },
    diagnosticsAvailable: true,
    generationMatched: true,
    fallbackCount: 0,
    capabilities: {
      readsRawSources: false,
      deterministicCanonicalOrder: true,
      sourceOrderingProvenance: true,
      sourceOffsetProvenance: true,
      sourceScopedQuotaOccurrences: true,
      durableDiagnostics: true,
      crashSafeGenerationPublication: true,
    },
  });
  await assert.rejects(readReplaySafeAccountingCacheImpl({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: "generation-test-1",
    contextBehavior: "legacy_zero",
  }), /contextBehavior is invalid/);
  const invalidated = await readReplaySafeAccountingCacheImpl({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: "generation-test-2",
    contextBehavior: "source_native",
  });
  assert.deepEqual(invalidated, {
    status: "unavailable",
    errorCode: "cache_generation_mismatch",
    cache: null,
  });

  const fingerprintScan = completeUnifiedScanner([], {
    generationFingerprint: "generation-fingerprint-current",
  });
  await refreshReplaySafeAccountingCache({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: {
      id: "generation-test-1",
      fingerprint: "generation-fingerprint-current",
    },
    scan: fingerprintScan,
    now: () => NOW,
  });
  const fingerprintInvalidated = await readReplaySafeAccountingCacheImpl({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: {
      id: "generation-test-1",
      fingerprint: "generation-fingerprint-stale",
    },
    contextBehavior: "source_native",
  });
  assert.deepEqual(fingerprintInvalidated, {
    status: "unavailable",
    errorCode: "cache_generation_mismatch",
    cache: null,
  });

  const tampered = await readTestCache(stateFile);
  tampered.sourceDescriptor.fallbackCount = 1;
  await writeTestCache(stateFile, tampered);
  const fallbackInvalidated = await readReplaySafeAccountingCacheImpl({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: {
      id: "generation-test-1",
      fingerprint: "generation-fingerprint-current",
    },
  });
  assert.deepEqual(fallbackInvalidated, {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });
  tampered.sourceDescriptor.fallbackCount = 0;
  tampered.history.generationFingerprint = "generation-fingerprint-tampered";
  await writeTestCache(stateFile, tampered);
  const historyInvalidated = await readReplaySafeAccountingCacheImpl({
    stateFile,
    sourceMode: "unified",
    expectedGeneration: {
      id: "generation-test-1",
      fingerprint: "generation-fingerprint-current",
    },
    contextBehavior: "source_native",
  });
  assert.deepEqual(historyInvalidated, {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });
});

test("unified reader errors map to closed content-free accounting codes", async () => {
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: "generation-test-1",
      now: () => NOW,
      scan: async () => {
        const error = new Error("private newer-schema detail");
        error.code = "local_unified_index_schema_newer";
        throw error;
      },
    }),
    (error) => (
      error?.code === "local_unified_index_schema_newer"
      && error?.message === "local_unified_index_schema_newer"
    ),
  );
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: "generation-test-1",
      now: () => NOW,
      scan: async () => {
        const error = new Error("private path and row contents");
        error.code = "local_unified_index_row_invalid";
        throw error;
      },
    }),
    (error) => (
      error?.code === "accounting_unified_index_invalid"
      && error?.message === "accounting_unified_index_invalid"
    ),
  );
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: "generation-test-1",
      now: () => NOW,
      scan: async () => {
        throw new Error("private path and row contents");
      },
    }),
    (error) => (
      error?.code === "accounting_unified_read_failed"
      && error?.message === "accounting_unified_read_failed"
    ),
  );
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "unified",
      expectedGeneration: "generation-test-1",
      now: () => NOW,
      scan: async () => {
        const error = new Error("private path and row contents");
        error.code = "accounting_private_internal_detail";
        throw error;
      },
    }),
    (error) => (
      error?.code === "accounting_unified_read_failed"
      && error?.message === "accounting_unified_read_failed"
    ),
  );
});

test("known Spark and reviewed aliases stay diagnosable without folding into normal totals", async () => {
  const cache = await buildReplaySafeAccountingCache({
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:00:00.000Z",
        model: "gpt-5.3-codex-spark",
        components: { input_uncached_tokens: 71_829 },
      }),
      usageEvent({
        timestamp: "2026-07-27T11:05:00.000Z",
        model: "private-unknown-model",
        components: { input_uncached_tokens: 10 },
      }),
      usageEvent({
        timestamp: "2026-07-27T11:10:00.000Z",
        model: "gpt-5.5-codex",
        components: { input_uncached_tokens: 10 },
      }),
    ]),
    now: () => NOW,
  });

  const normal = period(cache, "7d");
  const rows = normal.byModel;
  const spark = normal.spark;
  const unknown = rows.find((row) => row.model === "unknown");
  const alias = rows.find((row) => row.model === "gpt-5.5-codex");
  const sparkRow = spark.byModel.find((row) => row.model === "gpt-5.3-codex-spark");
  assert.equal(normal.events, 2);
  assert.equal(normal.spark.events, 1);
  assert.equal(rows.some((row) => row.model === "gpt-5.3-codex-spark"), false);
  assert.equal(sparkRow.pricingStatus, "known_unpriced");
  assert.equal(spark.apiPriceEquivalentUsd, 0);
  assert.equal(spark.pricingCoverage.unpricedEvents, 1);
  assert.equal(unknown.pricingStatus, "unrecognized");
  assert.equal(unknown.apiPriceEquivalentUsd, 0);
  assert.equal(unknown.pricingCoverage.unpricedEvents, 1);
  assert.equal(alias.pricingStatus, "priced");
  assert.equal(alias.apiPriceEquivalentUsd, 0.00005);
});

test("period coverage retains recognized OpenAI history before the review date", async () => {
  const cache = await buildReplaySafeAccountingCache({
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:00:00.000Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000 },
      }),
      usageEvent({
        timestamp: "2026-07-19T11:00:00.000Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000 },
      }),
    ]),
    now: () => NOW,
  });

  const recent = period(cache, "7d");
  const longer = period(cache, "30d");
  assert.deepEqual(recent.pricingCoverage, {
    fullyPricedEvents: 1,
    partiallyPricedEvents: 0,
    unpricedEvents: 0,
  });
  assert.equal(longer.pricingCoverage.fullyPricedEvents, 2);
  assert.equal(longer.pricingCoverage.unpricedEvents, 0);
  assert.equal(
    100 * recent.pricingCoverage.fullyPricedEvents / recent.events,
    100,
  );
  assert.equal(
    100 * longer.pricingCoverage.fullyPricedEvents / longer.events,
    100,
  );
});

test("indexed history prices each event at its own effective date before and after repricing", async () => {
  const result = await buildReplaySafeAccountingPeriod({
    startAt: "1970-01-01T00:00:00.000Z",
    endAt: "2026-08-01T12:00:00.000Z",
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-25T23:59:59.999Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000_000 },
      }),
      usageEvent({
        timestamp: "2026-07-29T23:59:59.999Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000_000 },
      }),
      usageEvent({
        timestamp: "2026-07-30T00:00:00.000Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });

  assert.equal(result.priceEpochBasis, "event_time_when_registry_has_effective_evidence");
  assert.deepEqual(result.period.pricingCoverage, {
    fullyPricedEvents: 3,
    partiallyPricedEvents: 0,
    unpricedEvents: 0,
  });
  assert.deepEqual(result.period.priceCardBreakdown.map((row) => ({
    priceCardId: row.priceCardId,
    events: row.events,
    costUsd: row.costUsd,
  })), [
    {
      priceCardId: "openai:gpt-5.6-terra:standard:short-from-2026-07-30:official-observed-2026-08-30",
      events: 1,
      costUsd: "2",
    },
    {
      priceCardId: "openai:gpt-5.6-terra:standard:short-through-2026-07-29:official-observed-2026-08-30",
      events: 2,
      costUsd: "5",
    },
  ]);
  assert.equal(result.period.apiPriceEquivalentUsd, 7);
});

const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const COMPONENT_KEYS = [
  "input_uncached_tokens",
  "input_cache_read_tokens",
  "input_cache_write_tokens",
  "output_text_tokens",
  "output_reasoning_tokens",
  "output_combined_tokens",
];

function usageEvent({
  timestamp,
  model = "gpt-5.6-sol",
  components,
  speed = "standard",
  apiServiceTier = "unknown",
  surface = "extension_or_ide",
  agentScope = "root",
  lineageDisposition = "standalone",
}) {
  return {
    timestamp,
    model,
    totalInputContextTokens: 1_000,
    components: Object.fromEntries(
      COMPONENT_KEYS.map((key) => [key, components[key] ?? 0]),
    ),
    componentAvailability: Object.fromEntries(
      COMPONENT_KEYS.map((key) => [key, true]),
    ),
    tierSemantics: {
      codexSpeedMode: speed,
      apiServiceTier,
    },
    surfaceClassification: {
      surface,
      agentScope,
      lineageDisposition,
    },
  };
}

function scanner(events, diagnostics = {}) {
  return withResidentCalibration(async (options) => {
    for (const event of events) options.onUsage(event);
    return {
      diagnostics: {
        filesScanned: 9,
        forkReplayEventsSkipped: 21,
        unattributedForkReplayEventsSkipped: 3,
        duplicateSnapshotsSkipped: 4,
        lineageParentsMissing: 2,
        ...diagnostics,
      },
    };
  });
}

function completeUnifiedScanner(
  events = [],
  {
    generation = TEST_GENERATION,
    generationFingerprint = TEST_GENERATION_FINGERPRINT,
    startAt = "2026-07-20T12:00:00.000Z",
    endAt = "2026-07-27T12:00:00.000Z",
    coverageStatus = "complete",
    generationProof = true,
  } = {},
) {
  return withResidentCalibration(async (options) => {
    for (const event of events) {
      await options.onUsage?.(event);
    }
    return { diagnostics: {} };
  }, { generation, generationFingerprint, startAt, endAt, coverageStatus, generationProof });
}

function weeklySnapshot({
  timestamp,
  usedPercent,
  provider = "openai_codex",
  planType = "pro",
  limitId = "codex",
  slot = "primary",
  durationMinutes = 10_080,
  resetsAt = Math.floor(
    Date.parse("2026-08-03T12:00:00.000Z") / 1_000,
  ),
}) {
  return {
    timestamp,
    timestampMs: Date.parse(timestamp),
    window: {
      provider,
      planType,
      limitId,
      slot,
      windowDurationMins: durationMinutes,
      resetsAt,
      usedPercent,
    },
  };
}

function period(cache, id) {
  const value = cache.periods.find((row) => row.id === id);
  assert.ok(value, `missing ${id} period`);
  return value;
}

test("projects replay-safe diagnostics and aggregates costs, dimensions, and 15-minute buckets", async () => {
  let observedScanOptions;
  const events = [
    usageEvent({
      timestamp: "2026-07-27T11:46:00.000Z",
      components: {
        input_uncached_tokens: 1_000_000,
        input_cache_read_tokens: 1_000_000,
        output_reasoning_tokens: 1_000_000,
      },
    }),
    usageEvent({
      timestamp: "2026-07-27T11:58:00.000Z",
      model: "gpt-5.6-terra",
      components: {
        input_uncached_tokens: 1_000_000,
        output_text_tokens: 400_000,
        output_reasoning_tokens: 600_000,
      },
      speed: "fast",
      apiServiceTier: "priority",
      surface: "subagent",
      agentScope: "subagent",
      lineageDisposition: "forked",
    }),
    usageEvent({
      timestamp: "2026-07-27T11:31:00.000Z",
      model: "future-private-model-name",
      components: { input_uncached_tokens: 100 },
      speed: "future-speed",
      apiServiceTier: "future-tier",
      surface: "future-surface",
      agentScope: "future-agent-scope",
      lineageDisposition: "future-lineage",
    }),
    usageEvent({
      timestamp: "2026-07-25T12:00:00.000Z",
      model: "gpt-5.6-luna",
      components: {
        input_cache_read_tokens: 1_000_000,
        output_text_tokens: 1_000_000,
      },
      speed: "fast",
      surface: "scheduled_task",
      agentScope: "automation",
      lineageDisposition: "parent_linked",
    }),
  ];
  const cache = await buildReplaySafeAccountingCache({
    codexHome: "/private/example-codex-home",
    now: () => NOW,
    // Re-pinned 31 -> 365 (2026-08-08): the standing owner rule forbids
    // convenience-sized history windows outright, so 365 is now the smallest
    // window the builder accepts.
    windowDays: 365,
    scan: async (options) => {
      observedScanOptions ??= options;
      return scanner(events)(options);
    },
  });

  assert.equal(cache.schemaVersion, REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION);
  assert.equal(
    cache.accountingMethod,
    "lineage_aware_cumulative_snapshot_replay_exclusion",
  );
  assert.deepEqual(cache.diagnostics, {
    filesScanned: 9,
    forkReplayEventsExcluded: 21,
    unattributedForkReplayEventsExcluded: 3,
    contradictedLeadingSnapshotsExcluded: 0,
    duplicateSnapshotsExcluded: 4,
    missingLineageParents: 2,
  });
  assert.equal(observedScanOptions.codexHome, "/private/example-codex-home");
  // Re-pinned (2026-08-08): 365 days back from NOW, not 31.
  assert.equal(observedScanOptions.startAt, "2025-07-27T12:00:00.000Z");
  assert.equal(observedScanOptions.endAt, "2026-07-27T12:00:00.000Z");

  const latest = period(cache, "24h");
  assert.equal(latest.events, 3);
  assert.equal(latest.totalTokens, 5_000_100);
  assert.equal(latest.byModel[0].model, "gpt-5.6-sol");
  assert.deepEqual(
    latest.byModel.map((row) => [row.model, row.events]),
    [
      ["gpt-5.6-sol", 1],
      ["gpt-5.6-terra", 1],
      ["unknown", 1],
    ],
  );
  assert.equal(latest.bySpeed.standard.events, 1);
  assert.equal(latest.bySpeed.fast.events, 1);
  assert.equal(latest.bySpeed.unknown.events, 1);
  assert.equal(latest.byApiServiceTier.priority.events, 1);
  assert.equal(latest.byApiServiceTier.unknown.events, 2);
  assert.equal(latest.bySurface.extension_or_ide.events, 1);
  assert.equal(latest.bySurface.subagent.events, 1);
  assert.equal(latest.bySurface.unknown.events, 1);
  assert.equal(latest.byAgentScope.root.events, 1);
  assert.equal(latest.byAgentScope.subagent.events, 1);
  assert.equal(latest.byAgentScope.unknown.events, 1);
  assert.equal(latest.byLineage.standalone.events, 1);
  assert.equal(latest.byLineage.forked.events, 1);
  assert.equal(latest.byLineage.unknown.events, 1);
  assert.equal(latest.pricingCoverage.fullyPricedEvents, 2);
  assert.equal(latest.pricingCoverage.unpricedEvents, 1);
  assert.equal(latest.pricedEventFraction, 0.666667);

  // The observed speed x published-Fast-family crossing is what lets the
  // owner's stated mode be applied at read time without a cache rebuild. Its
  // event counts must reconcile exactly with the speed and model dimensions,
  // and an unrecognised model must land in "unsupported" rather than being
  // given a Fast rate it has no published evidence for.
  assert.deepEqual(
    Object.entries(latest.speedWeighting).flatMap(([speed, families]) => (
      Object.entries(families)
        .filter(([, cell]) => cell.events > 0)
        .map(([family, cell]) => [speed, family, cell.events])
    )),
    [
      ["standard", "gpt-5.6-sol", 1],
      ["fast", "gpt-5.6-terra", 1],
      ["unknown", "unsupported", 1],
    ],
  );
  assert.equal(
    Object.values(latest.speedWeighting).reduce((total, families) => (
      total + Object.values(families).reduce(
        (subtotal, cell) => subtotal + cell.events,
        0,
      )
    ), 0),
    latest.events,
  );
  assert.equal(
    latest.speedWeighting.fast["gpt-5.6-terra"].apiPriceEquivalentUsd
      + latest.speedWeighting.standard["gpt-5.6-sol"].apiPriceEquivalentUsd
      + latest.speedWeighting.unknown.unsupported.apiPriceEquivalentUsd,
    latest.apiPriceEquivalentUsd,
  );

  assert.equal(latest.components.input_uncached_tokens, 2_000_100);
  assert.equal(latest.components.input_cache_read_tokens, 1_000_000);
  assert.equal(latest.components.output_text_tokens, 400_000);
  assert.equal(latest.components.output_reasoning_tokens, 1_600_000);
  assert.equal(latest.components.output_combined_tokens, 0);
  assert.equal(latest.componentCosts.input_uncached_tokens.pricedTokens, 2_000_000);
  assert.equal(latest.componentCosts.input_uncached_tokens.unpricedTokens, 100);
  assert.equal(latest.componentCosts.input_uncached_tokens.costUsd, 7.5);
  assert.equal(latest.componentCosts.input_cache_read_tokens.costUsd, 0.5);
  assert.equal(latest.componentCosts.output_text_tokens.costUsd, 6);
  assert.equal(latest.componentCosts.output_reasoning_tokens.costUsd, 39);
  assert.equal(latest.componentCosts.output_combined_tokens.costUsd, 0);
  assert.equal(latest.apiPriceEquivalentUsd, 53);
  assert.equal(
    Object.values(latest.componentCosts)
      .reduce((sum, row) => sum + row.costUsd, 0),
    latest.apiPriceEquivalentUsd,
  );

  // The model table and the component bars are the two margins of one
  // crossing, so the cells must reconcile in both directions: each model's
  // components add up to that model's own totals, and the models add up to the
  // period. Without this a per-model breakdown could drift from the headline
  // it sits under and still look plausible.
  for (const row of latest.byModel) {
    assert.equal(
      Object.values(row.componentCosts).reduce((sum, cost) => sum + cost.costUsd, 0),
      row.apiPriceEquivalentUsd,
      `${row.model} component costs reconcile with its own total`,
    );
    assert.equal(
      Object.entries(row.components).reduce((sum, [key, tokens]) => (
        // `output_combined_tokens` is an alternative to the text/reasoning
        // split, never an addition to it, so it is excluded exactly as the
        // period's own token total excludes it.
        key === "output_combined_tokens" ? sum : sum + tokens
      ), row.components.output_combined_tokens),
      row.totalTokens,
      `${row.model} components reconcile with its own token total`,
    );
  }
  for (const key of Object.keys(latest.components)) {
    assert.equal(
      latest.byModel.reduce((sum, row) => sum + row.components[key], 0),
      latest.components[key],
      `${key} tokens add up across models`,
    );
    assert.equal(
      Number(latest.byModel
        .reduce((sum, row) => sum + row.componentCosts[key].costUsd, 0)
        .toFixed(6)),
      latest.componentCosts[key].costUsd,
      `${key} cost adds up across models`,
    );
  }
  // An unpriced event must stay visible as unpriced on the model row too,
  // rather than being folded into a priced zero.
  assert.equal(
    latest.byModel.reduce(
      (sum, row) => sum + row.componentCosts.input_uncached_tokens.unpricedTokens,
      0,
    ),
    latest.componentCosts.input_uncached_tokens.unpricedTokens,
  );

  assert.equal(period(cache, "7d").events, 4);
  assert.equal(period(cache, "7d").totalTokens, 7_000_100);
  assert.equal(period(cache, "30d").events, 4);
  assert.equal(period(cache, "all").events, 4);

  assert.deepEqual(
    cache.timeline.map((row) => [
      row.startAt,
      row.endAt,
      row.usageEvents,
      row.totalTokens,
    ]),
    [
      [
        "2026-07-25T12:00:00.000Z",
        "2026-07-25T12:15:00.000Z",
        1,
        2_000_000,
      ],
      [
        "2026-07-27T11:30:00.000Z",
        "2026-07-27T11:45:00.000Z",
        1,
        100,
      ],
      [
        "2026-07-27T11:45:00.000Z",
        "2026-07-27T12:00:00.000Z",
        2,
        5_000_000,
      ],
    ],
  );
  assert.equal(cache.timeline[2].apiPriceEquivalentUsd, 53);
  assert.equal(
    Object.values(cache.timeline[2].speedWeighting)
      .flatMap((families) => Object.values(families))
      .reduce((total, cell) => total + cell.events, 0),
    cache.timeline[2].usageEvents,
  );
  assert.equal(
    Object.values(cache.timeline[2].speedWeighting)
      .flatMap((families) => Object.values(families))
      .reduce(
        (total, cell) => total + cell.apiPriceEquivalentUsd,
        0,
      ),
    cache.timeline[2].apiPriceEquivalentUsd,
  );
  // The receipt names the streamed full-history corpus and its covered span.
  // Its bounded estimate is the usage stamp and memo columns, plus snapshots.
  assert.deepEqual(cache.weeklyCalibrationInput, {
    status: "complete",
    encoding: "accounting_streamed_v1",
    source: "unified_index",
    coveredAt: {
      startAt: "2025-07-27T12:00:00.000Z",
      endAt: "2026-07-27T12:00:00.000Z",
    },
    usageMetadataCapacity: 4,
    usageMetadataBytes: 120,
    retainedUsageEvents: 4,
    retainedWeeklySnapshots: 0,
    estimatedRetainedBytes: 120,
    limits: {
      usageEvents: 750_000,
      weeklySnapshots: 750_000,
      combinedInputs: 1_500_000,
      retainedBytes: 320 * 1024 * 1024,
    },
  });
});

test("replay-safe fast pricing plans keep pre-change events on their historical card", async () => {
  const cache = await buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-08-01T12:00:00.000Z"),
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-29T23:59:59.999Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000_000 },
      }),
      usageEvent({
        timestamp: "2026-07-30T00:00:00.000Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });
  const all = period(cache, "all");
  assert.deepEqual(all.priceCardIds, [
    "openai:gpt-5.6-terra:standard:short-from-2026-07-30:official-observed-2026-08-30",
    "openai:gpt-5.6-terra:standard:short-through-2026-07-29:official-observed-2026-08-30",
  ]);
  assert.deepEqual(all.priceCardBreakdown.map(({ priceCardId, events, costUsd }) => ({
    priceCardId,
    events,
    costUsd,
  })), [
    {
      priceCardId: "openai:gpt-5.6-terra:standard:short-from-2026-07-30:official-observed-2026-08-30",
      events: 1,
      costUsd: "2",
    },
    {
      priceCardId: "openai:gpt-5.6-terra:standard:short-through-2026-07-29:official-observed-2026-08-30",
      events: 1,
      costUsd: "2.5",
    },
  ]);
  assert.equal(all.apiPriceEquivalentUsd, 4.5);
});

test("replay-safe cache rejects price-card event and exact-cost reconciliation drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-provenance-cache-"));
  const cacheFile = join(directory, "accounting.json");
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => Date.parse("2026-08-01T12:00:00.000Z"),
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-30T00:00:00.000Z",
        model: "gpt-5.6-terra",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });
  const all = period(cache, "all");
  assert.equal(all.apiPriceEquivalentUsdExact, "2");

  const badEvents = structuredClone(cache);
  const badEventsPeriod = period(badEvents, "all");
  badEventsPeriod.priceCardBreakdown[0].events += 1;
  await writeTestCache(cacheFile, badEvents);
  assert.deepEqual(await readReplaySafeAccountingCache({ cacheFile }), {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });

  const badCost = structuredClone(cache);
  const badCostPeriod = period(badCost, "all");
  badCostPeriod.priceCardBreakdown[0].costUsd = "3";
  await writeTestCache(cacheFile, badCost);
  assert.deepEqual(await readReplaySafeAccountingCache({ cacheFile }), {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });
});

test("exact decimal totals survive a floating-point half-boundary round trip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-exact-money-rounding-"));
  const stateFile = join(directory, "local-collector-state-v1.sqlite");
  const events = Array.from({ length: 31 }, (_, index) => usageEvent({
    timestamp: new Date(NOW - 60_000 + index).toISOString(),
    model: "gpt-5.6-terra",
    components: { input_uncached_tokens: 1 },
  }));

  // At $2.50 / million tokens, the exact sum is on a seventh-decimal half
  // boundary. Repeated binary-float addition lands on the other side of that
  // boundary on some totals, so the published numeric projection must be
  // derived from the exact decimal ledger rather than the accumulated float.
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile: stateFile,
    now: () => NOW,
    scan: scanner(events),
  });
  const all = period(cache, "all");
  assert.equal(all.apiPriceEquivalentUsdExact, "0.0000775");
  assert.equal(all.apiPriceEquivalentUsd, 0.000078);
  assert.doesNotThrow(() => assertReplaySafeAccountingCache(cache));

  const stored = await readReplaySafeAccountingCache({
    cacheFile: stateFile,
    now: () => NOW,
  });
  assert.equal(stored.status, "available");
  assert.equal(period(stored.cache, "all").apiPriceEquivalentUsd, 0.000078);
});

test("separated output takes precedence over a duplicate combined alias", async () => {
  const cache = await buildReplaySafeAccountingCache({
    now: () => NOW,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        model: "gpt-5.6-terra",
        components: {
          input_uncached_tokens: 1_000_000,
          output_text_tokens: 400_000,
          output_reasoning_tokens: 600_000,
          output_combined_tokens: 1_000_000,
        },
      }),
    ]),
  });
  const latest = period(cache, "24h");

  assert.equal(latest.totalTokens, 2_000_000);
  assert.equal(latest.components.output_text_tokens, 400_000);
  assert.equal(latest.components.output_reasoning_tokens, 600_000);
  assert.equal(latest.components.output_combined_tokens, 0);
  assert.equal(latest.apiPriceEquivalentUsd, 17.5);
  assert.equal(latest.pricingCoverage.fullyPricedEvents, 1);
  assert.equal(latest.componentCosts.output_text_tokens.costUsd, 6);
  assert.equal(latest.componentCosts.output_reasoning_tokens.costUsd, 9);
  assert.equal(latest.componentCosts.output_combined_tokens.costUsd, 0);
  assert.equal(cache.timeline[0].totalTokens, 2_000_000);
  assert.equal(cache.timeline[0].apiPriceEquivalentUsd, 17.5);
  assert.equal(
    Object.values(latest.componentCosts)
      .reduce((sum, row) => sum + row.costUsd, 0),
    17.5,
  );
});

test("combined-only output is retained once and priced as ordinary output", async () => {
  const cache = await buildReplaySafeAccountingCache({
    now: () => NOW,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        model: "gpt-5.6-terra",
        components: {
          input_uncached_tokens: 1_000_000,
          output_combined_tokens: 1_000_000,
        },
      }),
    ]),
  });
  const latest = period(cache, "24h");

  assert.equal(latest.totalTokens, 2_000_000);
  assert.equal(latest.components.output_text_tokens, 0);
  assert.equal(latest.components.output_reasoning_tokens, 0);
  assert.equal(latest.components.output_combined_tokens, 1_000_000);
  assert.equal(latest.apiPriceEquivalentUsd, 17.5);
  assert.equal(latest.pricingCoverage.fullyPricedEvents, 1);
  assert.equal(latest.componentCosts.output_combined_tokens.pricedTokens, 1_000_000);
  assert.equal(latest.componentCosts.output_combined_tokens.unpricedTokens, 0);
  assert.equal(latest.componentCosts.output_combined_tokens.costUsd, 15);
  assert.equal(cache.timeline[0].totalTokens, 2_000_000);
  assert.equal(cache.timeline[0].apiPriceEquivalentUsd, 17.5);
});

test("refresh and read round-trip a valid owner-only cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-accounting-"));
  const cacheFile = join(directory, "nested", "accounting.json");
  const written = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });
  const metadata = await stat(cacheFile);
  const read = await readReplaySafeAccountingCache({ cacheFile });

  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(read.status, "available");
  assert.equal(read.errorCode, null);
  assert.deepEqual(read.cache, written);
  assert.equal(period(read.cache, "24h").apiPriceEquivalentUsd, 5);
});

test("cache freshness uses the covered end and rejects a future projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-freshness-"));
  const cacheFile = join(directory, "accounting.json");
  const written = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });

  const stale = await readReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW + 60 * 60 * 1_000,
    maximumAgeMs: 30 * 60 * 1_000,
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.errorCode, "cache_stale");
  assert.equal(stale.ageSeconds, 3_600);
  assert.deepEqual(stale.cache, written);

  const future = await readReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW - 1,
    maximumAgeMs: 30 * 60 * 1_000,
  });
  assert.deepEqual(future, {
    status: "unavailable",
    errorCode: "cache_from_future",
    cache: null,
  });
});

test("the same lineage-aware scan produces a bounded weekly calibration summary", async () => {
  const resetStarts = [
    Date.parse("2026-07-30T00:00:00.000Z"),
    Date.parse("2026-08-06T00:00:00.000Z"),
    Date.parse("2026-08-13T00:00:00.000Z"),
  ];
  const cache = await buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
    // Re-pinned 31 -> 365 (2026-08-08): the window floor is now 365 days.
    windowDays: 365,
    scan: async ({ onUsage, onRateLimitSnapshot }) => {
      for (const [resetIndex, resetStart] of resetStarts.entries()) {
        const resetsAt = (resetStart + 7 * 24 * 60 * 60 * 1_000) / 1_000;
        for (let boundary = 0; boundary < 10; boundary += 1) {
          const observedMs = resetStart + boundary * 60 * 60 * 1_000;
          if (boundary > 0) {
            onUsage(usageEvent({
              timestamp: new Date(observedMs).toISOString(),
              speed: "unknown",
              components: {
                input_uncached_tokens:
                  1_000_000 + resetIndex * 100_000,
              },
            }));
          }
          onRateLimitSnapshot({
            timestamp: new Date(observedMs).toISOString(),
            timestampMs: observedMs,
            window: {
              provider: "openai_codex",
              planType: "pro",
              limitId: "codex",
              slot: "secondary",
              windowDurationMins: 10_080,
              resetsAt,
              usedPercent: boundary,
            },
          });
        }
      }
      return {
        diagnostics: {
          filesScanned: 3,
          forkReplayEventsSkipped: 4,
          replayedEventsSkipped: 2,
          replayedToolCallsSkipped: 1,
          malformedLines: 0,
          malformedTimestamps: 0,
          malformedUsageRecords: 0,
          malformedRateLimitRecords: 0,
        },
      };
    },
  });

  assert.equal(cache.weeklyCalibration.status, "estimated");
  assert.equal(cache.weeklyCalibration.estimate.qualifyingResets, 3);
  assert.equal(cache.weeklyCalibration.recentResets.length, 3);
  const standardCapacity = cache.allowanceCapacityByScenario.scenarios
    .unresolved_as_standard;
  const fastCapacity = cache.allowanceCapacityByScenario.scenarios
    .unresolved_as_fast;
  assert.equal(
    cache.allowanceCapacityByScenario.schemaVersion,
    "codex-primary-allowance-capacity-v0.1",
  );
  assert.equal(
    standardCapacity.basis.basisFamilyId,
    fastCapacity.basis.basisFamilyId,
  );
  assert.notEqual(standardCapacity.basis.basisId, fastCapacity.basis.basisId);
  assert.equal(
    standardCapacity.basis.unresolvedScenario,
    "unresolved_as_standard",
  );
  assert.equal(fastCapacity.basis.unresolvedScenario, "unresolved_as_fast");
  assert.equal(
    standardCapacity.basis.multiplierRegistryRecordedAt,
    "2026-09-29",
  );
  assert.equal(
    standardCapacity.calibration.validation.selectedCostBasis,
    "speed_lower",
  );
  assert.equal(
    fastCapacity.calibration.validation.selectedCostBasis,
    "speed_upper",
  );
  assert.equal(standardCapacity.calibration.status, "estimated");
  assert.equal(fastCapacity.calibration.status, "estimated");
  assert.equal(
    Number((fastCapacity.calibration.estimate.medianApiPriceEquivalentUsd
      / standardCapacity.calibration.estimate.medianApiPriceEquivalentUsd)
      .toFixed(6)),
    // The published GPT-5.6 Priority/Standard price ratio.
    2,
  );
  assert.deepEqual(cache.weeklyCalibration.accountAttribution, {
    status: "historical_unattributed",
    maySpanMultipleAccounts: true,
    label:
      "Historical estimate; account-unattributed and may combine multiple accounts",
  });
  const serialized = JSON.stringify(cache.weeklyCalibration);
  for (const forbidden of [
    "prompt",
    "response",
    "repository",
    "accountScopeId",
    "modelMix",
    "marginalComponents",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  // The composition block always exists on a v0.7 cache, and a corpus this
  // thin reports its own insufficiency instead of a fake vector.
  assert.equal(
    cache.weeklyCalibration.composition.status,
    "insufficient_observations",
  );
  assert.equal(cache.weeklyCalibration.composition.capacityUsdByModel, null);
});

test("the replay cache retains and fits plan-scoped five-hour allowance history", async () => {
  const resetStarts = [
    Date.parse("2026-09-11T00:00:00.000Z"),
    Date.parse("2026-09-11T05:00:00.000Z"),
    Date.parse("2026-09-11T10:00:00.000Z"),
  ];
  const cache = await buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-09-12T12:00:00.000Z"),
    windowDays: 365,
    scan: async ({ onUsage, onRateLimitSnapshot }) => {
      for (const [resetIndex, resetStart] of resetStarts.entries()) {
        const resetsAt = (resetStart + 5 * 60 * 60 * 1_000) / 1_000;
        for (let boundary = 0; boundary < 10; boundary += 1) {
          const observedMs = resetStart + boundary * 20 * 60 * 1_000;
          if (boundary > 0) {
            onUsage(usageEvent({
              timestamp: new Date(observedMs).toISOString(),
              speed: "unknown",
              components: {
                input_uncached_tokens:
                  200_000 + resetIndex * 20_000,
              },
            }));
          }
          onRateLimitSnapshot(weeklySnapshot({
            timestamp: new Date(observedMs).toISOString(),
            usedPercent: boundary,
            planType: "pro",
            durationMinutes: 300,
            resetsAt,
          }));
        }
      }
      return { diagnostics: {} };
    },
  });

  assert.equal(cache.fiveHourAllowanceCalibration.windowDurationMinutes, 300);
  assert.equal(cache.fiveHourAllowanceCalibration.selectedPlanType, "pro");
  assert.equal(cache.fiveHourAllowanceCalibration.status, "estimated");
  assert.equal(
    cache.fiveHourAllowanceCalibration.estimate.qualifyingResets,
    3,
  );
  assert.equal(
    cache.fiveHourAllowanceCalibration.sourceCounts.rateLimitSnapshots,
    30,
  );
  assert.equal(cache.weeklyCalibration.sourceCounts.rateLimitSnapshots, 0);
  assert.ok(cache.fiveHourAllowanceCalibration.recentResets.every((row) => (
    row.planType === "pro"
  )));
  assert.equal(
    cache.weeklyCalibration.composition.observationCount,
    0,
    "five-hour-only quota evidence cannot feed the seven-day composition fit",
  );
  assert.equal(cache.quotaTimeline.length, 0);
});

test("refresh publishes a fitted reset after an earlier diagnostic-only transition", async (t) => {
  const directory = await mkdtemp(join(
    tmpdir(),
    "usage-monitor-diagnostic-first-calibration-",
  ));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateFile = join(directory, "local-collector-state-v1.sqlite");
  const startMs = Date.parse("2026-08-01T00:00:00.000Z");
  const stamp = (seconds) => new Date(startMs + seconds * 1_000).toISOString();
  const resetsAt = Math.floor(
    (startMs + 7 * 24 * 60 * 60 * 1_000) / 1_000,
  );
  const snapshots = [
    weeklySnapshot({
      timestamp: stamp(0),
      usedPercent: 0,
      planType: "pro",
      resetsAt,
    }),
    weeklySnapshot({
      timestamp: stamp(10),
      usedPercent: 1,
      planType: "pro",
      resetsAt,
    }),
    ...Array.from({ length: 9 }, (_, boundary) => weeklySnapshot({
      timestamp: stamp(20 + boundary * 10),
      usedPercent: boundary,
      planType: "plus",
      resetsAt,
    })),
  ];
  const events = Array.from({ length: 8 }, (_, index) => ({
    ...usageEvent({
      timestamp: stamp(25 + index * 10),
      components: {
        input_uncached_tokens: index === 0 ? 100_000_000 : 1_000_000,
      },
    }),
    planAttribution: {
      basis: "same_record",
      planType: "plus",
      planVariant: null,
    },
    // The first Plus quantity interval begins during the preceding Pro era,
    // so the real transition miner makes only that row diagnostic. Every
    // later interval starts inside the Plus era and remains fit-eligible.
    usageIntervalStartedAt: stamp(index === 0 ? 9 : 21 + index * 10),
    usageIntervalBasis: "previous_session_record",
  }));

  const written = await refreshReplaySafeAccountingCache({
    cacheFile: stateFile,
    now: () => startMs + 12 * 60 * 60 * 1_000,
    windowDays: 365,
    scan: async ({ onUsage, onRateLimitSnapshot }) => {
      for (const event of events) onUsage(event);
      for (const snapshot of snapshots) onRateLimitSnapshot(snapshot);
      return { diagnostics: {} };
    },
  });

  assert.doesNotThrow(() => assertReplaySafeAccountingCache(written));
  const read = await readReplaySafeAccountingCache({
    cacheFile: stateFile,
    now: () => startMs + 12 * 60 * 60 * 1_000,
  });
  assert.equal(read.status, "available");
  assert.equal(read.errorCode, null);
  assert.deepEqual(read.cache, written);

  const projections = [
    written.weeklyCalibration,
    ...Object.values(written.allowanceCapacityByScenario.scenarios)
      .map((scenario) => scenario.calibration),
  ];
  for (const projection of projections) {
    assert.equal(projection.selectedPlanType, "plus");
    assert.equal(projection.status, "estimated");
    assert.equal(projection.estimate.qualifyingResets, 1);
    assert.equal(projection.recentResets.length, 1);
    assert.equal(projection.recentResets[0].eligibleTransitions, 7);
    assert.equal(
      projection.recentResets[0].aggregationEligibility,
      "primary_conditional",
    );
  }
});

test("a mix-varied corpus yields a fitted per-model composition that survives the cache round trip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "composition-cache-"));
  const stateFile = join(directory, "collector-state-v1.sqlite");
  const resetStart = Date.parse("2026-08-10T00:00:00.000Z");
  const resetsAt = (resetStart + 7 * 24 * 60 * 60 * 1_000) / 1_000;
  const nowMs = resetStart + 60 * 60 * 60 * 1_000;
  const cache = await buildReplaySafeAccountingCache({
    now: () => nowMs,
    windowDays: 365,
    scan: async ({ onUsage, onRateLimitSnapshot }) => {
      let usedPercent = 0;
      onRateLimitSnapshot(weeklySnapshot({
        timestamp: new Date(resetStart).toISOString(),
        usedPercent,
        resetsAt,
      }));
      // 25 alternating pure-model 2h bins: sol bins move 1pp on a large
      // token spend, terra bins move 4pp on the same spend — enough rank for
      // the NNLS to separate the two rates, with zero collinearity.
      for (let bin = 0; bin < 25; bin += 1) {
        const binStart = resetStart + bin * 2 * 60 * 60 * 1_000;
        const model = bin % 2 === 0 ? "gpt-5.6-sol" : "gpt-5.6-terra";
        onUsage(usageEvent({
          timestamp: new Date(binStart + 30 * 60_000).toISOString(),
          model,
          components: { input_uncached_tokens: 2_000_000 },
        }));
        usedPercent += bin % 2 === 0 ? 1 : 4;
        onRateLimitSnapshot(weeklySnapshot({
          timestamp: new Date(binStart + 90 * 60_000).toISOString(),
          usedPercent,
          resetsAt,
        }));
      }
      return { diagnostics: {} };
    },
  });
  const composition = cache.weeklyCalibration.composition;
  assert.equal(composition.status, "fitted");
  const sol = composition.capacityUsdByModel["gpt-5.6-sol"];
  const terra = composition.capacityUsdByModel["gpt-5.6-terra"];
  assert.ok(Number.isFinite(sol) && sol > 0);
  assert.ok(Number.isFinite(terra) && terra > 0);
  // Same spend, 4x the displayed movement: terra's $/100pp is materially
  // lower than sol's.
  assert.ok(sol > terra * 2);
  assert.ok(composition.r2 > composition.singleConstantR2);
  assert.ok(Number.isFinite(composition.blendedRecentMixUsd));
  assert.equal(composition.grainHours, 2);
  // The block survives the SQLite round trip and the read-path validator.
  await writeTestCache(stateFile, cache);
  const read = await readReplaySafeAccountingCache({
    cacheFile: stateFile,
    now: () => nowMs,
  });
  assert.equal(read.status, "available");
  assert.deepEqual(read.cache.weeklyCalibration.composition, composition);
});



test("compact plan buckets preserve event-summed tokens and reject malformed evidence", () => {
  const compact = [Date.parse("2026-08-10T00:00:00Z"), 2, 1, 2, 3, 4, 5, 6,
    .5, 1, 2, 1, 0, 1, 1, 21];
  const decoded = decodePlanScopedTimelineRow(compact);
  assert.equal(decoded.totalTokens, 21, "combined and split output totals cannot overwrite one another");
  assert.equal(decoded.usageEvents, 2);
  assert.deepEqual(decoded.weightingCoverage, { observedEvents: 1, declaredFromConfigEvents: 0, assumedEvents: 1 });
  assert.deepEqual(decoded.pricingCoverage, { fullyPricedEvents: 1, partiallyPricedEvents: 1, unpricedEvents: 0 });
  for (const invalid of [compact.slice(0, -1), [...compact, "private"],
    compact.map((v, i) => i === 11 ? 3 : v), compact.map((v, i) => i === 8 ? "0.5" : v),
    compact.map((v, i) => i === 0 ? v + 1 : v)]) {
    assert.equal(decodePlanScopedTimelineRow(invalid), null);
  }
});


test("a composition fit that trips the RSS ceiling mid-way fails soft into a completed v0.7 cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-fit-fail-soft-"));
  const stateFile = join(directory, "collector-state-v1.sqlite");
  let fitSpikeArmed = false;
  let checksSinceArmed = 0;
  const cache = await buildReplaySafeAccountingCache({
    now: () => NOW,
    maximumRssBytes: 1_000,
    // Under the ceiling everywhere except the SECOND check after the scan
    // returns: the first is the build's post-scan phase boundary, the second
    // is the fit's first in-loop cadence check — so the throw provably
    // starts inside the fit, and the ceiling is back under for every later
    // phase.
    rss: () => {
      if (!fitSpikeArmed) return 10;
      checksSinceArmed += 1;
      return checksSinceArmed === 2 ? 1_001 : 10;
    },
    scan: async (options) => {
      const { onUsage } = options;
      for (let index = 0; index < 2_100; index += 1) {
        onUsage(usageEvent({
          timestamp: new Date(NOW - 100_000_000 + index * 1_000).toISOString(),
          components: { input_uncached_tokens: 1 },
        }));
      }
      if (options.indexedHistory === undefined) fitSpikeArmed = true;
      return { diagnostics: {} };
    },
  });

  // The build completed: every event aggregated, the calibration block
  // exists, and only the optional composition enrichment is gone.
  assert.equal(cache.schemaVersion, REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION);
  assert.equal(period(cache, "all").events, 2_100);
  assert.equal(cache.weeklyCalibration.composition, null);
  assert.deepEqual(cache.weeklyCalibration.compositionStatus, {
    status: "fit_failed",
    reason: "accounting_transition_rss_limit_exceeded",
  });

  // The completed cache is valid, survives the SQLite round trip, and the
  // honest failure record survives with it.
  await writeTestCache(stateFile, cache);
  const read = await readReplaySafeAccountingCache({
    cacheFile: stateFile,
    now: () => NOW,
  });
  assert.equal(read.status, "available");
  assert.equal(read.cache.weeklyCalibration.composition, null);
  assert.deepEqual(read.cache.weeklyCalibration.compositionStatus, {
    status: "fit_failed",
    reason: "accounting_transition_rss_limit_exceeded",
  });

  // The failure record is validated, not merely tolerated: an unbounded
  // reason or a record claiming failure NEXT TO a composition block both
  // fail the cache validator.
  const unboundedReason = structuredClone(cache);
  unboundedReason.weeklyCalibration.compositionStatus = {
    status: "fit_failed",
    reason: "free text with spaces / and paths",
  };
  assert.throws(
    () => assertReplaySafeAccountingCache(unboundedReason),
    (error) => error?.code === "cache_invalid",
  );
  const contradictory = structuredClone(cache);
  contradictory.weeklyCalibration.composition = {
    status: "insufficient_observations",
    grainHours: 2,
    observationCount: 0,
    capacityUsdByModel: null,
    modelCostShares: {},
    r2: null,
    singleConstantUsd: null,
    singleConstantR2: null,
    blendedRecentMixUsd: null,
    recentMixDays: 14,
  };
  assert.throws(
    () => assertReplaySafeAccountingCache(contradictory),
    (error) => error?.code === "cache_invalid",
  );
});


// Standing owner rule (2026-08-08): with a unified index covering N months,
// the calibration corpus spans all N months. The fixture resets sit MORE than
// a year before "now" — outside every representable scan window — and the
// scan itself returns nothing, so an estimate can only come from the index.
test("the exact-ledger fast lane reproduces the decimal-string fold to the digit", async () => {
  // Deterministic pseudo-random quantities: a fixed LCG, no wall clock.
  let seed = 0x9e3779b9;
  const next = (bound) => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed % bound;
  };
  const pricer = createAccountingPricer();
  const oracle = createAccountingPricer();
  const dayMs = 24 * 60 * 60 * 1_000;
  const events = [];
  for (let index = 0; index < 4_000; index += 1) {
    const combinedOnly = next(7) === 0;
    const unknownModel = next(29) === 0;
    const timestamp = new Date(NOW - next(400) * dayMs - next(dayMs)).toISOString();
    events.push({
      timestamp,
      model: unknownModel ? "gpt-unknown-model" : "gpt-5.6-sol",
      // Long-context bands price differently; cover both sides of 272k.
      totalInputContextTokens: next(3) === 0 ? 272_000 + next(50_000) : next(200_000),
      components: {
        input_uncached_tokens: next(300_000),
        input_cache_read_tokens: next(300_000),
        input_cache_write_tokens: next(50_000),
        output_text_tokens: combinedOnly ? 0 : next(40_000),
        output_reasoning_tokens: combinedOnly ? 0 : next(40_000),
        output_combined_tokens: combinedOnly ? 1 + next(40_000) : 0,
      },
      tierSemantics: {
        billingSurface: "chatgpt_subscription",
        codexSpeedMode: "standard",
        apiServiceTier: "unknown",
        tierSource: "unknown",
      },
      surfaceClassification: {
        surface: "cli_exec",
        threadSource: "user",
        agentScope: "root",
        lineageDisposition: "standalone",
      },
    });
  }
  // Per-event card breakdown: exact sum of the event's component costs.
  let checkedCards = 0;
  for (const event of events) {
    const priced = pricer(event, event.components);
    const perCard = new Map();
    for (const row of priced.components) {
      if (row.pricingStatus !== "priced") continue;
      perCard.set(row.priceCardId, addUsdStrings(perCard.get(row.priceCardId) ?? "0", row.costUsd));
    }
    for (const item of priced.priceCardBreakdown) {
      assert.equal(item.costUsd, perCard.get(item.priceCardId), item.priceCardId);
      checkedCards += 1;
    }
    assert.equal(priced.totalUsd, addUsdStrings(...priced.components
      .filter((row) => row.pricingStatus === "priced").map((row) => row.costUsd)));
    // The fast plan's closed shape is unchanged (the full pricer's richer
    // shape is untouched by this lane and merely passes through it).
    for (const key of [
      "components", "coverageStatus", "priceCardBreakdown", "selectedPriceCardIds",
      "totalUsd", "warnings",
    ]) assert.ok(Object.hasOwn(priced, key), key);
    assert.deepEqual(Object.getOwnPropertySymbols(priced).filter((symbol) => (
      Object.getOwnPropertyDescriptor(priced, symbol).enumerable
    )), []);
  }
  assert.ok(checkedCards > 1_000);

  // Period totals: the retained exact string equals the per-event fold of
  // the same priced totals, across fast-lane (split output), string-lane
  // (combined-only output, unknown model) and long-context events alike.
  const period = await buildReplaySafeAccountingPeriod({
    id: "history",
    startAt: new Date(NOW - 401 * dayMs).toISOString(),
    endAt: new Date(NOW).toISOString(),
    maximumRssBytes: 64 * 1024 * 1024 * 1024,
    scan: async ({ onUsage }) => {
      for (const event of events) onUsage(event);
    },
  });
  let expectedExact = "0";
  const expectedCards = new Map();
  for (const event of events) {
    const components = { ...event.components };
    const separated = components.output_text_tokens + components.output_reasoning_tokens;
    if (components.output_combined_tokens > 0 && separated > 0) components.output_combined_tokens = 0;
    const pricingComponents = components.output_combined_tokens > 0
      ? { ...components, output_text_tokens: components.output_combined_tokens, output_combined_tokens: 0 }
      : components;
    const priced = oracle({ ...event, model: event.model }, pricingComponents);
    expectedExact = addUsdStrings(expectedExact, priced.totalUsd);
    for (const item of priced.priceCardBreakdown) {
      expectedCards.set(item.priceCardId, addUsdStrings(expectedCards.get(item.priceCardId) ?? "0", item.costUsd));
    }
  }
  assert.equal(period.period.events, events.length);
  assert.equal(period.period.apiPriceEquivalentUsdExact, expectedExact);
  assert.notEqual(expectedExact, "0");
  assert.deepEqual(
    Object.fromEntries(period.period.priceCardBreakdown.map((row) => [row.priceCardId, row.costUsd])),
    Object.fromEntries(expectedCards),
  );
  // The settled rows carry nothing but their closed shape.
  for (const row of period.period.priceCardBreakdown) {
    assert.deepEqual(Object.keys(row).sort(), ["costUsd", "events", "priceCardId"]);
    assert.equal(JSON.stringify(row), JSON.stringify({ priceCardId: row.priceCardId, events: row.events, costUsd: row.costUsd }));
  }
  assert.equal(Object.getOwnPropertySymbols(period.period).length, 0);
});


test("convenience-sized scan windows are rejected outright", async () => {
  for (const windowDays of [31, 93, 364]) {
    await assert.rejects(
      buildReplaySafeAccountingCache({
        now: () => NOW,
        windowDays,
        scan: scanner([]),
      }),
      /Replay-safe accounting options are invalid/u,
      `windowDays ${windowDays}`,
    );
  }
});

// The transition miner refuses more than 10,000 derived rows per call; the
// real corpus already holds ~18k weekly transitions. The derivation is
// batched by reset-window group, so a series past the single-call ceiling
// must succeed and keep every transition.
test("weekly transition derivation crosses the single-call row ceiling by group batching", async () => {
  const resetStarts = [
    Date.parse("2026-05-28T00:00:00.000Z"),
    Date.parse("2026-06-04T00:00:00.000Z"),
    Date.parse("2026-06-11T00:00:00.000Z"),
    Date.parse("2026-06-18T00:00:00.000Z"),
  ];
  const boundariesPerReset = 3_001;
  const cache = await buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-08-20T12:00:00.000Z"),
    scan: async ({ onRateLimitSnapshot }) => {
      for (const resetStart of resetStarts) {
        const resetsAt = (resetStart + 7 * 24 * 60 * 60 * 1_000) / 1_000;
        for (let boundary = 0; boundary < boundariesPerReset; boundary += 1) {
          const observedMs = resetStart + boundary * 60_000;
          onRateLimitSnapshot({
            timestamp: new Date(observedMs).toISOString(),
            timestampMs: observedMs,
            window: {
              provider: "openai_codex",
              planType: "pro",
              limitId: "codex",
              slot: "secondary",
              windowDurationMins: 10_080,
              resetsAt,
              usedPercent: Number((boundary / 100).toFixed(2)),
            },
          });
        }
      }
      return { diagnostics: {} };
    },
  });

  // 4 groups x 3,000 percent changes = 12,000 transitions — strictly more
  // than one derivation call may return, so this passes only through the
  // group-batched path, with every transition retained.
  assert.equal(
    cache.weeklyCalibration.sourceCounts.weeklyTransitions,
    12_000,
  );
  assert.equal(
    cache.weeklyCalibration.sourceCounts.rateLimitSnapshots,
    4 * boundariesPerReset,
  );
});

test("retains exact deterministic quota points for comparison brackets", async () => {
  const snapshots = [
    weeklySnapshot({
      timestamp: "2026-07-27T11:46:00.000Z",
      usedPercent: 10.12349,
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T11:52:00.000Z",
      usedPercent: 20,
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T11:52:00.000Z",
      usedPercent: 19,
      planType: "go",
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T11:30:00.000Z",
      usedPercent: 20.5,
      planType: "prolite",
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T12:00:00.000Z",
      usedPercent: 21,
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T12:00:00.000Z",
      usedPercent: 40,
      slot: "secondary",
      planType: "edu",
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T10:00:00.000Z",
      usedPercent: 8,
      planType: "private-plan-name",
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T10:15:00.000Z",
      usedPercent: 9,
      provider: "private-provider-name",
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T10:30:00.000Z",
      usedPercent: 9,
      limitId: "codex_bengalfox",
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T10:45:00.000Z",
      usedPercent: 9,
      durationMinutes: 300,
    }),
  ];
  const build = async (orderedSnapshots) => buildReplaySafeAccountingCache({
    now: () => NOW,
    scan: async ({ onRateLimitSnapshot }) => {
      for (const snapshot of orderedSnapshots) {
        onRateLimitSnapshot(snapshot);
      }
      return { diagnostics: {} };
    },
  });
  const cache = await build(snapshots);
  const reversed = await build([...snapshots].reverse());

  assert.deepEqual(cache.quotaTimeline, reversed.quotaTimeline);
  assert.deepEqual(cache.quotaTimeline, [
    {
      observedAt: "2026-07-27T10:00:00.000Z",
      limitId: "codex",
      slot: "primary",
      planType: "unknown",
      usedPercent: 8,
      remainingPercent: 92,
      durationMinutes: 10_080,
      resetAt: "2026-08-03T12:00:00.000Z",
      accountAttribution: "historical_unattributed",
    },
    {
      observedAt: "2026-07-27T11:30:00.000Z",
      limitId: "codex",
      slot: "primary",
      planType: "prolite",
      usedPercent: 20.5,
      remainingPercent: 79.5,
      durationMinutes: 10_080,
      resetAt: "2026-08-03T12:00:00.000Z",
      accountAttribution: "historical_unattributed",
    },
    {
      observedAt: "2026-07-27T11:46:00.000Z",
      limitId: "codex",
      slot: "primary",
      planType: "pro",
      usedPercent: 10.123,
      remainingPercent: 89.877,
      durationMinutes: 10_080,
      resetAt: "2026-08-03T12:00:00.000Z",
      accountAttribution: "historical_unattributed",
    },
    {
      observedAt: "2026-07-27T11:52:00.000Z",
      limitId: "codex",
      slot: "primary",
      planType: "go",
      usedPercent: 19,
      remainingPercent: 81,
      durationMinutes: 10_080,
      resetAt: "2026-08-03T12:00:00.000Z",
      accountAttribution: "historical_unattributed",
    },
    // Track identity is (limitId, duration): the provider's primary and
    // secondary slots are UI roles, so the two same-instant 12:00 readings
    // are one track point and the deterministic tie-break keeps exactly one
    // ("edu" sorts before "pro"). The surviving row's slot is provenance of
    // the winning reading, not a second series.
    {
      observedAt: "2026-07-27T12:00:00.000Z",
      limitId: "codex",
      slot: "secondary",
      planType: "edu",
      usedPercent: 40,
      remainingPercent: 60,
      durationMinutes: 10_080,
      resetAt: "2026-08-03T12:00:00.000Z",
      accountAttribution: "historical_unattributed",
    },
  ]);
  const serialized = JSON.stringify(cache.quotaTimeline);
  for (const forbidden of [
    "private-plan-name",
    "private-provider-name",
    "codex_bengalfox",
    "accountScope",
    "accountScopeId",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

// The provider reports the weekly window under the `secondary` slot for the
// first half of the range and under `primary` afterwards — the observed
// server-side slot flip of ~2026-07-06. Identity is (limitId, duration), so
// this is ONE continuous duplicate-rich series spanning the flip, not two
// slot-keyed fragments.
test("retains duplicate-rich quota history across 31 days under the cap", async () => {
  const startMs = Date.parse("2026-07-01T00:00:00.000Z");
  const minutes = 31 * 24 * 60;
  const flipMinute = Math.floor(minutes / 2);
  const snapshots = [];
  for (let minute = 0; minute < minutes; minute += 1) {
    const timestamp = new Date(startMs + minute * 60_000).toISOString();
    const day = Math.floor(minute / (24 * 60));
    snapshots.push(weeklySnapshot({
      timestamp,
      slot: minute < flipMinute ? "secondary" : "primary",
      usedPercent: day,
    }));
  }
  assert.ok(snapshots.length > 10_000);

  const build = async (orderedSnapshots) => buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-08-01T00:00:00.000Z"),
    // Re-pinned 31 -> 365 (2026-08-08): the window floor is now 365 days; the
    // fixture still spans 31 days of observations.
    windowDays: 365,
    scan: async ({ onRateLimitSnapshot }) => {
      for (const snapshot of orderedSnapshots) {
        onRateLimitSnapshot(snapshot);
      }
      return { diagnostics: {} };
    },
  });
  const cache = await build(snapshots);
  const reversed = await build([...snapshots].reverse());

  assert.deepEqual(cache.quotaTimeline, reversed.quotaTimeline);
  // One merged (limitId, duration) track spans the flip; retention stays
  // under the cap and reaches both ends of the covered window.
  assert.ok(cache.quotaTimeline.length > 0);
  assert.ok(cache.quotaTimeline.length <= 10_000);
  assert.equal(
    new Set(
      cache.quotaTimeline.map((row) => `${row.limitId}:${row.durationMinutes}`),
    ).size,
    1,
  );
  assert.equal(
    cache.quotaTimeline[0].observedAt,
    "2026-07-01T00:00:00.000Z",
  );
  assert.equal(
    cache.quotaTimeline.at(-1).observedAt,
    "2026-07-31T23:59:00.000Z",
  );
  assert.equal(
    new Set(cache.quotaTimeline.map((row) => row.observedAt.slice(0, 10))).size,
    31,
  );
  const values = new Set(cache.quotaTimeline.map((row) => row.usedPercent));
  for (let day = 0; day < 31; day += 1) {
    assert.equal(values.has(day), true, `day ${day}`);
  }
  // Slot survives on the rows as provenance of each era of the one track:
  // pre-flip rows carry `secondary`, post-flip rows carry `primary`, and the
  // series is continuous across the boundary.
  const flipMs = Date.parse("2026-07-01T00:00:00.000Z")
    + Math.floor((31 * 24 * 60) / 2) * 60_000;
  for (const row of cache.quotaTimeline) {
    assert.equal(
      row.slot,
      Date.parse(row.observedAt) < flipMs ? "secondary" : "primary",
      `slot provenance at ${row.observedAt}`,
    );
  }
  assert.ok(cache.quotaTimeline.some((row) => row.slot === "secondary"));
  assert.ok(cache.quotaTimeline.some((row) => row.slot === "primary"));
});

// The duplicate-rich case above repeats one value per day, so it never has
// more distinct quota states than the cap and cannot detect an unbounded
// retention path. Real history churns the displayed percentage constantly:
// every retained row is then its own state transition, and prioritising
// transitions without budgeting them returns more rows than the cache is
// allowed to carry. That cache is rejected by its own read validation, which
// is indistinguishable to the owner from having no quota evidence at all.
// Both quota series are finalized by the same retention function and are held
// to the same cap by `validQuotaTimeline`. Spark is used here because weekly
// snapshots additionally feed the transition miner, whose own 10,000-row
// derivation ceiling trips first and would mask the retention defect.
test("churn-rich quota history stays inside the cap and still spans the range", async () => {
  const startMs = Date.parse("2026-07-01T00:00:00.000Z");
  const minutes = 31 * 24 * 60;
  const snapshots = [];
  for (let minute = 0; minute < minutes; minute += 1) {
    const timestamp = new Date(startMs + minute * 60_000).toISOString();
    // A distinct displayed percentage on every observation, so every row is a
    // state transition on its track.
    const usedPercent = Number(((minute % 9_901) / 100).toFixed(2));
    for (const [slot, value] of [
      ["primary", usedPercent],
      ["secondary", Number((usedPercent / 2).toFixed(3))],
    ]) {
      snapshots.push(weeklySnapshot({
        timestamp,
        slot,
        limitId: "codex-spark",
        usedPercent: value,
      }));
    }
  }

  const build = async (orderedSnapshots) => buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-08-01T00:00:00.000Z"),
    // Re-pinned 31 -> 365 (2026-08-08): the window floor is now 365 days; the
    // fixture still spans 31 days of observations.
    windowDays: 365,
    scan: async ({ onRateLimitSnapshot }) => {
      for (const snapshot of orderedSnapshots) {
        onRateLimitSnapshot(snapshot);
      }
      return { diagnostics: {} };
    },
  });
  const cache = await build(snapshots);
  const reversed = await build([...snapshots].reverse());
  const timeline = cache.sparkQuotaTimeline;

  assert.deepEqual(timeline, reversed.sparkQuotaTimeline);
  // The cap is an invariant of the cache contract, not a soft preference:
  // `readReplaySafeAccountingCache` refuses a longer series outright.
  assert.equal(timeline.length, 10_000);
  // Retention must reach both ends of the covered window, not just its tail.
  assert.equal(timeline[0].observedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(timeline.at(-1).observedAt, "2026-07-31T23:59:00.000Z");
  assert.equal(
    new Set(timeline.map((row) => row.observedAt.slice(0, 10))).size,
    31,
  );
  // Track identity is (limitId, duration): the primary and secondary
  // readings are ONE merged track, each instant keeping the deterministic
  // tie-break winner (the lower displayed percentage), never a phantom
  // second series keyed by UI slot.
  assert.equal(
    new Set(timeline.map((row) => `${row.limitId}:${row.durationMinutes}`)).size,
    1,
  );
  for (const row of timeline) {
    const minute = Math.round(
      (Date.parse(row.observedAt) - Date.parse("2026-07-01T00:00:00.000Z"))
        / 60_000,
    );
    const primaryPercent = Number(((minute % 9_901) / 100).toFixed(2));
    const secondaryPercent = Number((primaryPercent / 2).toFixed(3));
    assert.equal(
      row.usedPercent,
      Math.min(primaryPercent, secondaryPercent),
      `merged winner at ${row.observedAt}`,
    );
  }
  // No retained neighbour gap may exceed the widest bracket tolerance the
  // dashboard allows for its narrowest comparison window.
  const merged = timeline.map((row) => Date.parse(row.observedAt));
  let widestGapMs = 0;
  for (let index = 1; index < merged.length; index += 1) {
    widestGapMs = Math.max(widestGapMs, merged[index] - merged[index - 1]);
  }
  assert.ok(
    widestGapMs <= 60 * 60 * 1_000,
    `widest retained gap ${widestGapMs}ms`,
  );
});

test("Spark quota observations stay outside the normal weekly quota timeline", async () => {
  const cache = await buildReplaySafeAccountingCache({
    now: () => NOW,
    scan: async ({ onRateLimitSnapshot }) => {
      onRateLimitSnapshot(weeklySnapshot({
        timestamp: "2026-07-27T11:59:00.000Z",
        usedPercent: 12,
      }));
      onRateLimitSnapshot(weeklySnapshot({
        timestamp: "2026-07-27T11:59:30.000Z",
        usedPercent: 4,
        limitId: "codex-spark",
        durationMinutes: 300,
      }));
      return { diagnostics: {} };
    },
  });

  assert.deepEqual(cache.quotaTimeline.map((row) => row.limitId), ["codex"]);
  assert.deepEqual(cache.sparkQuotaTimeline, [{
    observedAt: "2026-07-27T11:59:30.000Z",
    limitId: "codex-spark",
    slot: "primary",
    planType: "pro",
    usedPercent: 4,
    remainingPercent: 96,
    durationMinutes: 300,
    resetAt: "2026-08-03T12:00:00.000Z",
    accountAttribution: "historical_unattributed",
  }]);
});

// Real captures report the Spark allowance as `codex_bengalfox`;
// `codex-spark` is the reserved marketing token that has never been observed.
// The scan must retain both, each row keeping its observed limit id — the
// consumers filter with SPARK_QUOTA_LIMIT_IDS — or the cached spark series is
// permanently empty against every real capture.
test("Spark quota snapshots are retained under every real Spark limit id and round-trip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-spark-ids-"));
  const cacheFile = join(directory, "accounting.json");
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: async ({ onRateLimitSnapshot }) => {
      onRateLimitSnapshot(weeklySnapshot({
        timestamp: "2026-07-27T11:58:00.000Z",
        usedPercent: 12,
      }));
      onRateLimitSnapshot(weeklySnapshot({
        timestamp: "2026-07-27T11:59:00.000Z",
        usedPercent: 33,
        limitId: "codex_bengalfox",
        durationMinutes: 300,
      }));
      onRateLimitSnapshot(weeklySnapshot({
        timestamp: "2026-07-27T11:59:30.000Z",
        usedPercent: 4,
        limitId: "codex-spark",
        durationMinutes: 300,
      }));
      return { diagnostics: {} };
    },
  });

  assert.deepEqual(cache.quotaTimeline.map((row) => row.limitId), ["codex"]);
  assert.deepEqual(
    cache.sparkQuotaTimeline.map((row) => [row.limitId, row.usedPercent]),
    [["codex_bengalfox", 33], ["codex-spark", 4]],
  );
  // The mixed-id series survives its own read validation: validQuotaTimeline
  // accepts every id in SPARK_QUOTA_LIMIT_IDS on the spark timeline.
  const read = await readReplaySafeAccountingCache({ cacheFile });
  assert.equal(read.status, "available");
  assert.equal(read.errorCode, null);
  assert.deepEqual(read.cache, cache);
});

// At one instant the two Spark ids are two tracks whose retained order must
// be the order the read-side sortKey check expects. localeCompare's variable
// punctuation weighting puts "codex_bengalfox" before "codex-spark" while the
// code-unit check puts them the other way around; a cache emitted in
// collation order would be rejected by its own read validation.
test("same-instant readings under both Spark ids stay deterministic and readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-spark-tie-"));
  const cacheFile = join(directory, "accounting.json");
  const snapshots = [
    weeklySnapshot({
      timestamp: "2026-07-27T11:59:00.000Z",
      usedPercent: 33,
      limitId: "codex_bengalfox",
      durationMinutes: 300,
    }),
    weeklySnapshot({
      timestamp: "2026-07-27T11:59:00.000Z",
      usedPercent: 4,
      limitId: "codex-spark",
      durationMinutes: 300,
    }),
  ];
  const build = async (orderedSnapshots) => refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: async ({ onRateLimitSnapshot }) => {
      for (const snapshot of orderedSnapshots) onRateLimitSnapshot(snapshot);
      return { diagnostics: {} };
    },
  });
  const cache = await build(snapshots);
  const reversed = await build([...snapshots].reverse());

  assert.deepEqual(cache.sparkQuotaTimeline, reversed.sparkQuotaTimeline);
  assert.deepEqual(
    cache.sparkQuotaTimeline.map((row) => row.limitId),
    ["codex-spark", "codex_bengalfox"],
  );
  const read = await readReplaySafeAccountingCache({ cacheFile });
  assert.equal(read.status, "available");
  assert.equal(read.errorCode, null);
});

// Every v0.7 cache was built matching "codex-spark" only, so its spark series
// is empty against real captures. The schema bump withholds those caches for
// rebuild instead of serving them as evidence that no Spark history exists.
test("a v0.7 cache with the permanently empty spark series is withheld for rebuild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-spark-stale-"));
  const cacheFile = join(directory, "accounting.json");
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  await writeTestCache(cacheFile, {
    ...cache,
    schemaVersion: "local-replay-safe-accounting-v0.7",
  });

  const read = await readReplaySafeAccountingCache({ cacheFile });
  assert.equal(read.status, "unavailable");
  assert.equal(read.errorCode, "cache_accounting_semantics_outdated");
  // The CURRENT-cache contract stays withheld; the artifact additionally
  // rides the explicit stale channel so the post-update recalculation can
  // serve it labeled (see replay-safe-accounting-stale-serve.test.js).
  assert.equal(read.cache, null);
  assert.equal(
    read.staleCache.schemaVersion,
    "local-replay-safe-accounting-v0.7",
  );
  assert.equal(read.staleCache.stale, true);
});

test("exact retained quota points make an eligible comparison window testable", async () => {
  const cache = await buildReplaySafeAccountingCache({
    now: () => Date.parse("2026-07-27T17:00:00.000Z"),
    scan: async ({ onRateLimitSnapshot }) => {
      for (const timestamp of [
        "2026-07-27T14:59:00.000Z",
        "2026-07-27T15:01:00.000Z",
        "2026-07-27T15:59:00.000Z",
        "2026-07-27T16:01:00.000Z",
      ]) {
        onRateLimitSnapshot(weeklySnapshot({ timestamp, usedPercent: 10 }));
      }
      return { diagnostics: {} };
    },
  });
  const quotaSeries = cache.quotaTimeline.map((row) => ({
    observedAt: row.observedAt,
    receivedAt: row.observedAt,
    usedPercent: row.usedPercent,
  }));
  const result = buildRollingQuotaComparisons({
    resetEvidence: {
      schemaVersion: "quota-reset-evidence-v0.1",
      status: "eligible",
      refusalCodes: [],
      continuityKey: "fixture-continuity",
      resetKey: "fixture-reset",
      accountTrackId: "account-track:v1:fixture",
      provider: "openai",
      planType: "subscription",
      planVariant: "pro",
      limitId: "codex",
      windowDurationMinutes: 10_080,
      policyEpoch: "fixture-policy",
      resetsAt: "2026-08-03T12:00:00.000Z",
      slots: ["primary"],
      firstObservedAt: quotaSeries[0].observedAt,
      lastObservedAt: quotaSeries.at(-1).observedAt,
      snapshotCount: quotaSeries.length,
      usageEventCount: 0,
      totalCostNanousd: 0,
      sourceDatasetCount: 1,
      boundaries: [],
      quotaSeries,
      usageSeries: [],
    },
    capacityForecast: {
      method: "median_of_prior_completed_resets",
      priorResetCount: 2,
      priorResetKeys: ["prior-one", "prior-two"],
      trainedThrough: "2026-07-27T13:00:00.000Z",
      capacityNanousd: 1,
    },
  });
  assert.equal(result.status, "conditional_comparison");
  assert.deepEqual(result.comparisons.map((row) => [
    row.smoothingHours,
    row.windowStart,
    row.windowEnd,
  ]), [[
    1,
    "2026-07-27T15:00:00.000Z",
    "2026-07-27T16:00:00.000Z",
  ]]);
});

test("cache validation requires weighted and bounded timeline evidence so older cache shapes rebuild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-quota-cache-"));
  const cacheFile = join(directory, "accounting.json");
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([usageEvent({
      timestamp: new Date(NOW).toISOString(),
      components: { input_uncached_tokens: 1_000 },
    })]),
  });
  delete cache.timeline[0].speedWeighting;
  await writeTestCache(cacheFile, cache);
  assert.deepEqual(await readReplaySafeAccountingCache({ cacheFile }), {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });

  const withoutAllowanceCapacity = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  delete withoutAllowanceCapacity.allowanceCapacityByScenario;
  await writeTestCache(cacheFile, withoutAllowanceCapacity);
  assert.deepEqual(await readReplaySafeAccountingCache({ cacheFile }), {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });

  const withoutQuota = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  delete withoutQuota.quotaTimeline;
  await writeTestCache(cacheFile, withoutQuota);
  assert.deepEqual(await readReplaySafeAccountingCache({ cacheFile }), {
    status: "unavailable",
    errorCode: "cache_invalid",
    cache: null,
  });

  const rebuilt = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: async ({ onRateLimitSnapshot }) => {
      onRateLimitSnapshot(weeklySnapshot({
        timestamp: "2026-07-27T11:45:00.000Z",
        usedPercent: 5,
      }));
      return { diagnostics: {} };
    },
  });
  rebuilt.quotaTimeline = Array.from(
    { length: 10_001 },
    () => ({ ...rebuilt.quotaTimeline[0] }),
  );
  await writeTestCache(cacheFile, rebuilt);
  assert.equal(
    (await readReplaySafeAccountingCache({ cacheFile })).errorCode,
    "cache_invalid",
  );
});

test("replay cache rejects the old prefix-priced version and unreviewed model crossing keys", async () => {
  const cache = await buildReplaySafeAccountingCache({
    now: () => NOW,
    scan: scanner([usageEvent({
      timestamp: new Date(NOW).toISOString(),
      components: { input_uncached_tokens: 1_000 },
    })]),
  });
  assert.equal(cache.schemaVersion, "local-replay-safe-accounting-v0.19");
  assert.doesNotThrow(() => assertReplaySafeAccountingCache(cache));
  const oldVersion = structuredClone(cache);
  oldVersion.schemaVersion = "local-replay-safe-accounting-v0.12";
  assert.throws(() => assertReplaySafeAccountingCache(oldVersion));
  oldVersion.schemaVersion = "local-replay-safe-accounting-v0.13";
  assert.throws(() => assertReplaySafeAccountingCache(oldVersion));
  for (const model of ["gpt-5.6", "gpt-5.5-pro", "gpt-5.5-future"]) {
    const invalidCrossing = structuredClone(cache);
    invalidCrossing.timeline[0].speedWeighting.unknown ??= {};
    invalidCrossing.timeline[0].speedWeighting.unknown[model] = {
      events: 1, apiPriceEquivalentUsd: 1,
    };
    assert.throws(() => assertReplaySafeAccountingCache(invalidCrossing), model);
  }
});

test("a replay cache from an older official price registry is withheld", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-pricing-cache-"));
  const cacheFile = join(directory, "accounting.json");
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  await writeTestCache(cacheFile, {
    ...cache,
    priceRegistryVersion: "superseded-price-registry",
  });

  assert.deepEqual(await readReplaySafeAccountingCache({ cacheFile }), {
    status: "unavailable",
    errorCode: "cache_price_registry_outdated",
    cache: null,
  });
});

test("a cache from the former current-price basis is withheld for deterministic rebuild", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-semantics-cache-"));
  const cacheFile = join(directory, "accounting.json");
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  await writeTestCache(cacheFile, {
    ...cache,
    schemaVersion: "local-replay-safe-accounting-v0.1",
    priceEpochBasis: "current_price_sensitivity_at_registry_observation",
  });

  const read = await readReplaySafeAccountingCache({ cacheFile });
  assert.equal(read.status, "unavailable");
  assert.equal(read.errorCode, "cache_accounting_semantics_outdated");
  assert.equal(read.cache, null);
  // The deterministic rebuild still happens; meanwhile the artifact rides the
  // explicit stale channel with its outdated identity named.
  assert.equal(
    read.staleCache.schemaVersion,
    "local-replay-safe-accounting-v0.1",
  );
});

test("refresh forwards AbortSignal and never writes an aborted projection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-abort-"));
  const cacheFile = join(directory, "accounting.json");
  const controller = new AbortController();
  let observedSignal;
  const scan = async (options) => {
    observedSignal = options.signal;
    options.onUsage(usageEvent({
      timestamp: "2026-07-27T11:55:00.000Z",
      components: { input_uncached_tokens: 1_000_000 },
    }));
    controller.abort();
    return { diagnostics: {} };
  };

  await assert.rejects(
    refreshReplaySafeAccountingCache({
      cacheFile,
      now: () => NOW,
      scan,
      signal: controller.signal,
    }),
    (error) => (
      error?.name === "AbortError"
      && error?.code === "accounting_refresh_aborted"
    ),
  );
  assert.equal(observedSignal, controller.signal);
  // State preparation is allowed to create the SQLite container before the
  // scan starts, but an aborted refresh must not store an accounting value.
  assert.equal(await readTestCache(cacheFile), null);
});

test("an abort during cache-store preparation preserves the retained cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-publish-abort-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });
  const before = await readTestCache(cacheFile);
  const controller = new AbortController();

  // The async writer has entered ensureDatabase before returning this promise.
  // Abort immediately while that preparation is awaiting filesystem work; the
  // post-preparation check must stop the synchronous replacement transaction.
  const publication = writeLocalCollectorAccountingCache({
    stateFile: cacheFile,
    cache: {
      ...before,
      generatedAt: new Date(NOW + 1_000).toISOString(),
    },
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(
    publication,
    (error) => (
      error?.name === "AbortError"
      && error?.code === "accounting_refresh_aborted"
    ),
  );
  assert.deepEqual(await readTestCache(cacheFile), before);
});

const ACCOUNTING_RSS_ABSOLUTE =
  REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY.maximumRssBytes;
const ACCOUNTING_RSS_DELTA =
  REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY.rssDeltaBudgetBytes;
// Mirrored from src/export/resource-policy.js: the shared export policy's own
// RSS bound, which clamps the deep-scan guard independently of the above.
const EXPORT_POLICY_MAX_RSS_BYTES = Math.floor(1.5 * 1024 * 1024 * 1024);
// A realistic resting companion RSS after indexing a large history — the
// baseline the in-process arm of the guard is actually shaped for.
const REALISTIC_COMPANION_BASELINE = 800 * 1024 * 1024;

test("the shipped accounting memory policy is the owner-set pair", () => {
  // THE TRIPWIRE, and the only place a literal ceiling lives. Everything else
  // derives, so this is what a policy change has to come through — and the
  // rationale for these numbers is in the constants themselves, not in a pull
  // request that will not be read again.
  assert.deepEqual(REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY, {
    maximumRssBytes: 6 * 1024 * 1024 * 1024,
    rssDeltaBudgetBytes: Math.floor(5.25 * 1024 * 1024 * 1024),
    archiveMaximumRssBytes: 3 * 1024 * 1024 * 1024,
    archiveRssDeltaBudgetBytes: 512 * 1024 * 1024,
  });
  // Which arm binds where. Off the rebuild child's clean baseline the DELTA is
  // the effective ceiling, so raising the absolute alone would have been inert
  // there; the absolute only takes over above a fat in-process baseline. Both
  // regimes are exercised by the two ceiling tests below, and pinning them
  // here is what stops a future edit from moving a number until one of those
  // tests is quietly testing the same arm twice.
  const cleanChildBaseline = 60 * 1024 * 1024;
  assert.ok(
    cleanChildBaseline + ACCOUNTING_RSS_DELTA < ACCOUNTING_RSS_ABSOLUTE,
    "off a clean child baseline the delta must be the binding ceiling",
  );
  assert.ok(
    REALISTIC_COMPANION_BASELINE + ACCOUNTING_RSS_DELTA >= ACCOUNTING_RSS_ABSOLUTE,
    "off a realistic companion baseline the absolute target must be the "
      + "binding ceiling",
  );
  // The deep-scan phase is clamped by the shared export policy at any baseline
  // below 1.5 GiB, the child's included. Asserted so the asymmetry stays a
  // recorded decision (the observed deferrals were all on the transition path)
  // rather than a surprise found in a later incident.
  assert.ok(
    EXPORT_POLICY_MAX_RSS_BYTES < cleanChildBaseline + ACCOUNTING_RSS_DELTA,
    "the scan phase is expected to be clamped by the export policy rather "
      + "than by the accounting delta; if that stops holding, the scan-guard "
      + "regression below is asserting the wrong regime",
  );
});

// The resident companion's OBSERVED whole-process residency (dogfood 0.1.13
// build 1020, 4,886 sources / 128.5 GB indexed), sampled every two seconds
// over twenty seconds: 1,312-2,089 MiB. Both ends matter. The high end is why
// the archive projection cannot be policed by a 2 GiB absolute — the companion
// crosses that line on GC timing alone, so the guard would fire or not fire at
// random. The spread is why the ceiling is resolved off a per-pass baseline
// rather than fixed.
const OBSERVED_COMPANION_RSS_FLOOR = 1_312 * 1024 * 1024;
const OBSERVED_COMPANION_RSS_PEAK = 2_089 * 1024 * 1024;
const ARCHIVE_RSS_ABSOLUTE =
  REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY.archiveMaximumRssBytes;
const ARCHIVE_RSS_DELTA =
  REPLAY_SAFE_ACCOUNTING_MEMORY_POLICY.archiveRssDeltaBudgetBytes;

test("the resident archive projection is bounded by its own policy, never the rebuild's", () => {
  // THE SEPARATION. buildReplaySafeAccountingPeriod once defaulted to the
  // rebuild's ceiling, so the 2026-08-20 raise of a constant that exists to
  // size a SHORT-LIVED CHILD silently handed the resident menu-bar companion
  // a 6 GiB backstop — undoing, for this path, what #38 moved the rebuild out
  // of process to achieve. Free headroom in a process that exits is not free
  // in one the user leaves running all day.
  assert.ok(
    ARCHIVE_RSS_ABSOLUTE < ACCOUNTING_RSS_ABSOLUTE,
    "the resident archive ceiling must stay strictly below the rebuild's; "
      + "equality would mean the default had drifted back into inheritance",
  );
  assert.ok(
    ARCHIVE_RSS_DELTA < ACCOUNTING_RSS_DELTA,
    "the resident archive delta must stay strictly below the rebuild's",
  );

  // Which arm binds, at the residency actually measured on the owner's
  // machine. The DELTA has to be the binding arm across the whole observed
  // band, because the absolute arm charges the projection for memory the
  // companion allocated for unrelated reasons and cannot hand back.
  for (const baseline of [
    OBSERVED_COMPANION_RSS_FLOOR,
    OBSERVED_COMPANION_RSS_PEAK,
  ]) {
    assert.ok(
      baseline + ARCHIVE_RSS_DELTA < ARCHIVE_RSS_ABSOLUTE,
      "across the observed companion band the delta must bind, so the pass "
        + "gets its full budget rather than whatever the absolute leaves over",
    );
  }

  // And the reason a bare absolute was rejected rather than merely retuned: at
  // the pre-raise 2 GiB the observed band STRADDLES the ceiling, so the same
  // projection on the same corpus would defer or not defer on GC timing.
  const PRE_RAISE_ABSOLUTE = 2 * 1024 * 1024 * 1024;
  assert.ok(
    OBSERVED_COMPANION_RSS_FLOOR < PRE_RAISE_ABSOLUTE
      && OBSERVED_COMPANION_RSS_PEAK > PRE_RAISE_ABSOLUTE,
    "restoring the pre-raise absolute would have made the guard a coin flip "
      + "on this machine; that is what the baseline + delta shape avoids",
  );
});

test("an archive projection past its own delta defers while still far under the rebuild ceiling", async () => {
  // The discriminating case, and the one that fails if the default ever goes
  // back to inheriting: residency here is well inside the rebuild's effective
  // ceiling, so a period build reading that policy would sail through.
  const baseline = OBSERVED_COMPANION_RSS_PEAK;
  const overArchiveUnderRebuild = baseline + ARCHIVE_RSS_DELTA + 1;
  assert.ok(
    overArchiveUnderRebuild < ACCOUNTING_RSS_ABSOLUTE
      && overArchiveUnderRebuild < baseline + ACCOUNTING_RSS_DELTA,
    "the fixture must sit under BOTH arms of the rebuild policy, or it is "
      + "not evidence about which policy the archive path read",
  );

  let sampled = 0;
  await assert.rejects(
    buildReplaySafeAccountingPeriod({
      startAt: "1970-01-01T00:00:00.000Z",
      endAt: "2026-08-20T12:00:00.000Z",
      // Baseline first, then the pass grows one byte past its delta.
      rss: () => {
        sampled += 1;
        return sampled === 1 ? baseline : overArchiveUnderRebuild;
      },
      scan: scanner([
        usageEvent({
          timestamp: "2026-07-27T11:55:00.000Z",
          components: { input_uncached_tokens: 1 },
        }),
      ]),
    }),
    (error) => error?.code === "accounting_archive_rss_limit_exceeded",
  );

  // The absolute arm is a real backstop too: a companion already past it gets
  // no projection at all, however little the pass itself would have grown.
  await assert.rejects(
    buildReplaySafeAccountingPeriod({
      startAt: "1970-01-01T00:00:00.000Z",
      endAt: "2026-08-20T12:00:00.000Z",
      rss: () => ARCHIVE_RSS_ABSOLUTE + 1,
      scan: scanner([]),
    }),
    (error) => error?.code === "accounting_archive_rss_limit_exceeded",
  );
});

test("a caller that names its own ceiling keeps it, which is how the rebuild sub-build stays unchanged", async () => {
  // buildReplaySafeAccountingCache passes the effective ceiling it already
  // computed off the CHILD's baseline. That seam has to keep taking the named
  // number verbatim — the archive policy must not tighten a rebuild that is
  // already fighting for room, and must not sample rss() an extra time.
  const named = 4 * 1024 * 1024 * 1024;
  assert.ok(
    named > ARCHIVE_RSS_ABSOLUTE,
    "the named ceiling must exceed the archive absolute, or this proves "
      + "nothing about which one was applied",
  );
  const samples = [];
  const result = await buildReplaySafeAccountingPeriod({
    startAt: "1970-01-01T00:00:00.000Z",
    endAt: "2026-08-20T12:00:00.000Z",
    maximumRssBytes: named,
    rss: () => {
      samples.push(ARCHIVE_RSS_ABSOLUTE + 1);
      return ARCHIVE_RSS_ABSOLUTE + 1;
    },
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1 },
      }),
    ]),
  });
  assert.equal(result.period.events, 1);
  // Two readings: the pre-flight check and the post-scan check. A third would
  // mean the named path had started deriving a baseline it was told not to.
  assert.equal(samples.length, 2);
});

test("an RSS ceiling miss during accounting is a soft target: the prior cache is retained and served", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-bound-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1 },
      }),
    ]),
  });
  const before = await readTestCache(cacheFile);
  assert.notEqual(before, null);
  // Baseline capture, a clean start check, then the post-scan check crosses the
  // absolute ceiling: the injected 100-byte ceiling is far below baseline +
  // delta budget, so this exercises the hard-backstop arm — which is now a soft
  // TARGET, never a hard refresh failure that blanks the dashboard.
  const samples = [50, 50, 101];
  const deferredEvents = [];

  const outcome = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW + 1_000,
    maximumRssBytes: 100,
    rss: () => samples.shift() ?? 101,
    onAccountingRebuildDeferred: (event) => { deferredEvents.push(event); },
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:56:00.000Z",
        components: { input_uncached_tokens: 1 },
      }),
    ]),
  });

  // No throw escaped to fail the refresh; a degraded/deferred outcome is
  // reported instead, naming the budget it missed.
  assert.equal(outcome.status, "accounting_rebuild_deferred");
  assert.equal(outcome.reason, "accounting_transition_rss_limit_exceeded");
  assert.equal(outcome.retained, true);
  assert.equal(outcome.generatedAt, before.generatedAt);
  // The honest degraded note was produced — content-free reason + retained.
  // The deferral now carries the three quantities the guard compared. Six days
  // of these misses were undiagnosable because the note recorded only the code:
  // a too-small ceiling, a bloated parent and an unbounded slice all stayed
  // equally consistent with the evidence. Pinned so the payload can never
  // silently narrow back to a bare reason.
  assert.deepEqual(deferredEvents, [{
    reason: "accounting_transition_rss_limit_exceeded",
    retained: true,
    measurements: {
      baselineRssMib: 0,
      ceilingRssMib: 0,
      observedRssMib: 0,
    },
  }]);
  // The last good cache survives on disk untouched, at its owner-only mode...
  assert.deepEqual(await readTestCache(cacheFile), before);
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
  // ...and is still SERVED: the surface is available, not blanked.
  const served = await readReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW + 1_000,
  });
  assert.equal(served.status, "available");
  assert.deepEqual(served.cache, before);
});

test("the RSS guard is budget-relative: a pass past the delta budget soft-fails below the absolute ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-delta-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  const before = await readTestCache(cacheFile);
  const baseline = 200 * 1024 * 1024;
  // Baseline capture and the start check see the companion's resting RSS; the
  // post-scan check sees the pass one byte past its delta budget while still
  // UNDER the absolute ceiling — the delta arm binds, and it is a soft target:
  // the prior cache is retained, the refresh does not fail. The premise is
  // asserted rather than assumed, so a policy change that made the absolute
  // the binding arm at this baseline fails here instead of leaving this test
  // silently exercising the other arm.
  assert.ok(
    baseline + ACCOUNTING_RSS_DELTA < ACCOUNTING_RSS_ABSOLUTE,
    "this test only exercises the delta arm while baseline + delta stays "
      + "below the absolute ceiling",
  );
  const samples = [baseline, baseline, baseline + ACCOUNTING_RSS_DELTA + 1];

  const outcome = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW + 1_000,
    rss: () => samples.shift() ?? baseline + ACCOUNTING_RSS_DELTA + 1,
    scan: scanner([]),
  });

  assert.equal(outcome.status, "accounting_rebuild_deferred");
  assert.equal(outcome.reason, "accounting_transition_rss_limit_exceeded");
  assert.equal(outcome.retained, true);
  assert.deepEqual(await readTestCache(cacheFile), before);
});

test("a retained-byte budget miss is a soft target that retains the prior cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-bytes-soft-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });
  const before = await readTestCache(cacheFile);
  const deferredEvents = [];

  // The per-row retained-byte meter is likewise advisory: over budget it
  // retains the last good cache rather than failing the refresh.
  const outcome = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW + 1_000,
    transitionResourceLimits: { retainedBytes: 1 },
    onAccountingRebuildDeferred: (event) => { deferredEvents.push(event); },
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:56:00.000Z",
        components: { input_uncached_tokens: 1 },
      }),
    ]),
  });

  assert.equal(outcome.status, "accounting_rebuild_deferred");
  assert.equal(outcome.reason, "accounting_transition_memory_budget_exceeded");
  assert.equal(outcome.retained, true);
  // A retained-byte miss is a different guard and records no RSS quantities,
  // so `measurements` is explicitly null rather than absent — a reader can tell
  // "this guard does not meter RSS" from "the metering was lost".
  assert.deepEqual(deferredEvents, [{
    reason: "accounting_transition_memory_budget_exceeded",
    retained: true,
    measurements: null,
  }]);
  assert.deepEqual(await readTestCache(cacheFile), before);
});

test("a memory-budget miss with no prior cache degrades honestly without throwing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-nocache-"));
  const cacheFile = join(directory, "accounting.json");
  // No prior refresh: nothing valid is on disk to retain.
  const samples = [50, 50, 101];
  const deferredEvents = [];

  const outcome = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    maximumRssBytes: 100,
    rss: () => samples.shift() ?? 101,
    onAccountingRebuildDeferred: (event) => { deferredEvents.push(event); },
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1 },
      }),
    ]),
  });

  // Still no unhandled throw, but nothing is fabricated: retained is false and
  // the surface honestly reports insufficient evidence.
  assert.equal(outcome.status, "accounting_rebuild_deferred");
  assert.equal(outcome.retained, false);
  assert.equal(outcome.generatedAt, null);
  assert.deepEqual(deferredEvents, [{
    reason: "accounting_transition_rss_limit_exceeded",
    retained: false,
    measurements: {
      baselineRssMib: 0,
      ceilingRssMib: 0,
      observedRssMib: 0,
    },
  }]);
  assert.equal(await readTestCache(cacheFile), null);
  const served = await readReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
  });
  assert.equal(served.status, "unavailable");
  assert.equal(served.cache, null);
});

test("the 2026-08-11 incident's own reading is in budget and rebuilds normally", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-in-budget-"));
  const cacheFile = join(directory, "accounting.json");
  const baseline = REALISTIC_COMPANION_BASELINE;
  // The live-failure reading: ~800 MB baseline, the pass climbs to ~1.6 GB.
  // Under the then-current 1.5 GiB ceiling / 512 MiB delta that hard-failed
  // and blanked the dashboard; every policy shipped since keeps it in budget,
  // so the cache builds. Asserted against the live policy rather than a
  // remembered ceiling, so this stays the incident's regression rather than a
  // test of one particular number.
  const climbed = 1_600 * 1024 * 1024;
  assert.ok(
    climbed <= Math.min(ACCOUNTING_RSS_ABSOLUTE, baseline + ACCOUNTING_RSS_DELTA),
    "the reading that caused the 2026-08-11 incident must stay in budget",
  );
  let calls = 0;
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    rss: () => {
      calls += 1;
      return calls <= 2 ? baseline : climbed;
    },
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1 },
      }),
    ]),
  });

  assert.equal(cache.schemaVersion, REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION);
  assert.equal(period(cache, "7d").events, 1);
});

test("the absolute target is the effective transition ceiling for a realistic companion baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-absolute-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  const before = await readTestCache(cacheFile);
  const baseline = REALISTIC_COMPANION_BASELINE;
  // The other arm of the min(). Baseline capture + start check see the ~800 MB
  // resting RSS; the post-scan transition-path check sees the pass one byte
  // past the ABSOLUTE target, which at this baseline is the lower of the two
  // and therefore the exact boundary. Paired with the "1.6 GB completes" test
  // above this brackets the in-process effective ceiling (the 1.6 GB the
  // 2026-08-11 incident tripped at is comfortably under budget at any shipped
  // policy since), and crossing it is a soft target miss.
  assert.ok(
    baseline + ACCOUNTING_RSS_DELTA >= ACCOUNTING_RSS_ABSOLUTE,
    "this test only exercises the absolute arm while a realistic baseline "
      + "plus the delta reaches the absolute ceiling",
  );
  const samples = [baseline, baseline, ACCOUNTING_RSS_ABSOLUTE + 1];

  const outcome = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW + 1_000,
    rss: () => samples.shift() ?? ACCOUNTING_RSS_ABSOLUTE + 1,
    scan: scanner([]),
  });

  assert.equal(outcome.status, "accounting_rebuild_deferred");
  assert.equal(outcome.reason, "accounting_transition_rss_limit_exceeded");
  assert.equal(outcome.retained, true);
  assert.deepEqual(await readTestCache(cacheFile), before);
});

test("a large companion baseline is not charged against the pass budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-baseline-"));
  const cacheFile = join(directory, "accounting.json");
  const baseline = 1_200 * 1024 * 1024;
  // The companion idles at ~1.2 GiB and the pass climbs a modest 50 MiB:
  // well within its delta budget and under the absolute ceiling, so the
  // rebuild must complete — a high resting baseline alone is never a
  // refusal.
  let calls = 0;
  const cache = await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    rss: () => {
      calls += 1;
      return calls <= 2 ? baseline : baseline + 50 * 1024 * 1024;
    },
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1 },
      }),
    ]),
  });

  assert.equal(cache.schemaVersion, REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION);
  assert.equal(period(cache, "7d").events, 1);
});

test("the scan resource guard inherits the budget-relative RSS ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-rss-guard-limit-"));
  const cacheFile = join(directory, "accounting.json");
  const baseline = 100 * 1024 * 1024;
  let observedGuard = null;
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    rss: () => baseline,
    scan: async ({ resourceGuard }) => {
      observedGuard ??= resourceGuard;
      return { diagnostics: {} };
    },
  });

  // The deep-scan guard polices the same pass and carries the LOWER of the
  // accounting effective ceiling and the shared export policy's own RSS bound.
  // Asserted as the explicit min() rather than assuming which side wins, so a
  // future move in either constant fails here instead of silently loosening or
  // tightening the scan phase.
  assert.equal(
    observedGuard?.limits.maximumRssBytes,
    Math.min(baseline + ACCOUNTING_RSS_DELTA, EXPORT_POLICY_MAX_RSS_BYTES),
  );
  // At this modest baseline — the shape the rebuild child actually runs at —
  // the export policy's flat bound is the lower of the two since the
  // 2026-08-20 delta raise, so the scan phase is clamped by the export policy
  // while the transition path runs at the full budget-relative ceiling. Pinned
  // explicitly, because that split is a decision (the observed deferrals were
  // all on the transition path) and not an accident of arithmetic.
  assert.equal(
    observedGuard?.limits.maximumRssBytes,
    EXPORT_POLICY_MAX_RSS_BYTES,
  );
  assert.ok(EXPORT_POLICY_MAX_RSS_BYTES < baseline + ACCOUNTING_RSS_DELTA);
});

test("deep log scanning receives hard resource bounds and preserves the last cache when they trip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-scan-bound-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  const before = await readTestCache(cacheFile);
  let observedGuard = null;

  await assert.rejects(
    refreshReplaySafeAccountingCache({
      cacheFile,
      now: () => NOW + 1_000,
      scan: async ({ resourceGuard }) => {
        observedGuard ??= resourceGuard;
        resourceGuard.observeSourcePlan(
          1,
          resourceGuard.limits.maximumSourceBytes + 1,
        );
        return { diagnostics: {} };
      },
    }),
    (error) => (
      error?.code === "accounting_scan_source_bytes_limit_exceeded"
    ),
  );

  assert.equal(typeof observedGuard?.checkRuntime, "function");
  assert.deepEqual(await readTestCache(cacheFile), before);
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
});

test("the deep-scan guard admits a full rollout corpus and still stops above the source-file ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-scan-files-"));
  const cacheFile = join(directory, "accounting.json");

  // The owner's deduped Codex rollout corpus measured 4,880 files; the ceiling
  // was raised 5_000 -> 100_000 so a real corpus is admitted with headroom.
  let admittedGuard = null;
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: async ({ resourceGuard }) => {
      admittedGuard = resourceGuard;
      resourceGuard.observeSourcePlan(4_880, 0);
      return { diagnostics: {} };
    },
  });
  assert.equal(admittedGuard?.counters.sourceFiles, 4_880);
  const before = await readTestCache(cacheFile);

  // Above the ceiling it still stops, and -- unlike the RSS soft miss -- a
  // source_files trip is a hard failure that retains the prior cache intact.
  await assert.rejects(
    refreshReplaySafeAccountingCache({
      cacheFile,
      now: () => NOW + 1_000,
      scan: async ({ resourceGuard }) => {
        resourceGuard.observeSourcePlan(
          resourceGuard.limits.maximumSourceFiles + 1,
          0,
        );
        return { diagnostics: {} };
      },
    }),
    (error) => error?.code === "accounting_scan_source_files_limit_exceeded",
  );
  assert.deepEqual(await readTestCache(cacheFile), before);
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
});

test("an AbortSignal can interrupt cooperative derivation after a dense scan and preserves the last cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-derive-abort-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([]),
  });
  const before = await readTestCache(cacheFile);
  const controller = new AbortController();
  let scanCompleted = false;
  const scan = async ({ onUsage }) => {
    for (let index = 0; index < 5_000; index += 1) {
      onUsage(usageEvent({
        timestamp: new Date(NOW - 10_000 + index).toISOString(),
        components: { input_uncached_tokens: 1 },
      }));
    }
    scanCompleted = true;
    setImmediate(() => controller.abort());
    return { diagnostics: {} };
  };

  await assert.rejects(
    refreshReplaySafeAccountingCache({
      cacheFile,
      now: () => NOW + 1_000,
      scan,
      signal: controller.signal,
    }),
    (error) => (
      error?.name === "AbortError"
      && error?.code === "accounting_refresh_aborted"
    ),
  );
  assert.equal(scanCompleted, true);
  assert.deepEqual(await readTestCache(cacheFile), before);
});

test("a failed refresh leaves the last good owner-only cache intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-last-good-"));
  const cacheFile = join(directory, "accounting.json");
  await refreshReplaySafeAccountingCache({
    cacheFile,
    now: () => NOW,
    scan: scanner([
      usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1_000_000 },
      }),
    ]),
  });
  const before = await readTestCache(cacheFile);

  await assert.rejects(
    refreshReplaySafeAccountingCache({
      cacheFile,
      now: () => NOW + 1_000,
      scan: async () => {
        throw new Error("controlled_scan_failure");
      },
    }),
    /accounting_unified_read_failed/,
  );

  assert.deepEqual(await readTestCache(cacheFile), before);
  assert.equal((await stat(cacheFile)).mode & 0o777, 0o600);
});

test("Ultrafast replay weights Astra once and withholds unsupported Sol without losing Standard totals", async () => {
  const instant = Date.parse("2026-09-29T20:00:00.000Z");
  for (const model of ["gpt-6-astra", "gpt-6.1-sol"]) {
    const cache = await buildReplaySafeAccountingCache({
      now: () => instant,
      scan: scanner([usageEvent({ timestamp: new Date(instant - 1_000).toISOString(),
        model, speed: "ultrafast", components: { input_uncached_tokens: 1_000 } })]),
    });
    assert.doesNotThrow(() => assertReplaySafeAccountingCache(cache));
    const period = cache.periods.find((row) => row.id === "all");
    assert.equal(period.bySpeed.ultrafast.events, 1);
    const weighted = summarizeQuotaWeightedAccounting({ speedWeighting: period.speedWeighting });
    assert.equal(weighted.coverage.observedEvents, 1);
    const standard = model === "gpt-6-astra" ? .01 : .002;
    assert.equal(period.apiPriceEquivalentUsd, standard);
    if (model === "gpt-6-astra") {
      assert.equal(weighted.quotaWeightedApiPriceEquivalentUsd, .06);
      assert.equal(weighted.weightingStatus, "complete");
    } else {
      assert.equal(weighted.quotaWeightedApiPriceEquivalentUsd, null);
      assert.equal(weighted.weightingStatus, "unknown");
      assert.equal(weighted.unweightedUnknownApiPriceEquivalentUsd, standard);
    }
  }
});

test("memoized accounting matches reviewed context boundaries and nullable observations", () => {
  const pricer = createAccountingPricer();
  for (const model of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"]) {
    for (const totalInputContextTokens of [272_001, 272_000, 271_999, 300_000, 0, null]) {
      const event = usageEvent({ timestamp: "2026-09-29T20:00:00.000Z", model,
        components: { input_uncached_tokens: 300_000, input_cache_read_tokens: 1_000,
          output_text_tokens: 1_000, output_reasoning_tokens: 500 } });
      event.totalInputContextTokens = totalInputContextTokens;
      const expected = priceCodexUsageEvent(event);
      const actual = pricer(event, event.components);
      assert.equal(actual.totalUsd, expected.totalUsd, `${model}/${totalInputContextTokens}`);
      assert.equal(actual.coverageStatus, expected.coverageStatus);
      assert.deepEqual(actual.selectedPriceCardIds, expected.selectedPriceCardIds);
    }
  }
  const knownRawContext = usageEvent({ timestamp: "2026-09-29T20:00:00.000Z",
    model: "gpt-6.1-sol", components: { output_text_tokens: 1_000 } });
  knownRawContext.totalInputContextTokens = null;
  knownRawContext.raw = { input_tokens: 272_001 };
  assert.equal(pricer(knownRawContext, knownRawContext.components).totalUsd, "0.015");

  for (const rawAvailability of [undefined, {}, { input_tokens: false }, { input_tokens: true }]) {
    const event = usageEvent({ timestamp: "2026-09-29T20:00:00.000Z",
      model: "gpt-6.1-sol", components: { input_uncached_tokens: 300_000, output_text_tokens: 1_000 } });
    event.totalInputContextTokens = null;
    event.raw = { input_tokens: 0 };
    event.rawAvailability = rawAvailability;
    assert.equal(pricer(event, event.components).totalUsd, priceCodexUsageEvent(event).totalUsd);
  }

  for (const model of ["gpt-6.1-sol", "gpt-6-astra"]) {
    for (const totalInputContextTokens of [null, 272_001]) {
      const event = usageEvent({ timestamp: "2026-09-29T20:00:00.000Z", model,
        components: { output_text_tokens: 1_000 } });
      event.totalInputContextTokens = totalInputContextTokens;
      for (const name of ["input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens"]) {
        event.components[name] = null;
        event.componentAvailability[name] = false;
      }
      const expected = priceCodexUsageEvent(event);
      assert.deepEqual(pricer(event, event.components), expected);
      assert.equal(expected.coverageStatus, totalInputContextTokens === null ? "unpriced" : "partially_priced");
      assert.equal(expected.totalUsd, totalInputContextTokens === null ? "0" : model === "gpt-6.1-sol" ? "0.015" : "0.075");
    }
  }
});

test("replay accounting preserves unknown context coverage instead of publishing a short-priced event", async () => {
  const instant = Date.parse("2026-09-29T20:00:00.000Z");
  const event = usageEvent({ timestamp: new Date(instant - 1_000).toISOString(),
    model: "gpt-6.1-sol", components: { output_text_tokens: 1_000 } });
  event.totalInputContextTokens = null;
  event.raw = { input_tokens: 0 };
  event.rawAvailability = { input_tokens: false };
  for (const name of ["input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens"]) {
    event.components[name] = null;
    event.componentAvailability[name] = false;
  }
  const cache = await buildReplaySafeAccountingCache({ now: () => instant, scan: scanner([event]) });
  const period = cache.periods.find((row) => row.id === "all");
  assert.equal(period.totalTokens, 1_000);
  assert.equal(period.apiPriceEquivalentUsd, 0);
  assert.equal(period.pricingCoverage.unpricedEvents, 1);
  assert.equal(period.pricingCoverage.fullyPricedEvents, 0);
  assert.equal(cache.weeklyCalibrationInput.retainedUsageEvents, 1);
  assert.doesNotThrow(() => assertReplaySafeAccountingCache(cache));
});

test("a build without a calibration source or a non-unified source mode fails closed", async () => {
  await assert.rejects(
    buildReplaySafeAccountingCacheImpl({
      sourceMode: "unified",
      expectedGeneration: TEST_GENERATION,
      scan: completeUnifiedScanner([]),
      now: () => NOW,
    }),
    (error) => error?.code === "accounting_calibration_source_required",
  );
  await assert.rejects(
    buildReplaySafeAccountingCache({
      sourceMode: "legacy",
      expectedGeneration: TEST_GENERATION,
      scan: completeUnifiedScanner([]),
      now: () => NOW,
    }),
    /sourceMode must be unified/u,
  );
});

test("a stored cache built from the retired legacy source is never served as current", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-monitor-legacy-stored-"));
  const stateFile = join(directory, "local-collector-state-v1.sqlite");
  try {
    const cache = await refreshReplaySafeAccountingCache({
      stateFile,
      now: () => NOW,
      scan: scanner([usageEvent({
        timestamp: "2026-07-27T11:55:00.000Z",
        components: { input_uncached_tokens: 1_000_000 },
      })]),
    });
    await writeTestCache(stateFile, {
      ...structuredClone(cache),
      sourceDescriptor: { ...cache.sourceDescriptor, mode: "legacy" },
    });
    const read = await readReplaySafeAccountingCache({
      stateFile,
      sourceMode: "unified",
      expectedGeneration: TEST_GENERATION,
      now: () => NOW,
    });
    assert.equal(read.status, "unavailable");
    assert.equal(read.cache, null);
    const unfiltered = await readReplaySafeAccountingCache({ stateFile, now: () => NOW });
    assert.equal(unfiltered.status, "unavailable");
    assert.equal(unfiltered.cache, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
