import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LOCAL_API_PRICING_METHOD_VERSION } from "@app-usagemonitor/accounting";
import {
  createDeferredAccountingRebuildRecorder,
  createLocalCollectorRefreshRunner,
  createTerminalRefreshFailureRecorder,
  LOCAL_COMPANION_FRESH_INDEX_REFRESH_TIMEOUT_MS,
  LOCAL_COMPANION_REFRESH_CANCEL_SETTLEMENT_MS,
  LOCAL_COMPANION_REFRESH_TIMEOUT_MAX_MS,
  LocalCompanionRefreshController,
} from "../src/local-companion-refresh.js";
import {
  localCompanionStatePaths,
} from "../src/local-installation-diagnostics.js";
import {
  readLocalCollectorAccountingCache,
  readLocalCollectorCheckpoint,
  writeLocalCollectorAccountingCache,
} from "../src/local-collector-state.js";
import {
  runCollectorOnce,
} from "../src/passive-collector.js";
import {
  CodexAppServerError,
} from "../src/providers/codex/account.js";
import {
  REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
} from "../src/replay-safe-accounting-cache.js";
import { buildLocalIndexAccountingCache } from "../src/local-index-accounting-cache.js";
import { readLocalIndexGenerationIdentity } from "../src/local-index-companion-source.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { createWorkspace } from "./helpers/local-index-facts.js";
import { createProtectedFixtureDirectory } from "./helpers/windows-owner-only-fixture.js";

const COMPLETE_INDEX = Object.freeze({
  mode: "recent_7d",
  status: "recent_7d_complete",
  phase: "complete",
  boundedBy: "modified_at_and_collection_start",
  filesDiscovered: 9,
  filesSelected: 4,
  filesProcessed: 4,
  recordsWritten: 12,
  coveredAt: {
    startAt: "2026-07-16T12:00:00.000Z",
    endAt: "2026-07-23T12:00:00.000Z",
  },
});

const PARTIAL_INDEX = Object.freeze({
  ...COMPLETE_INDEX,
  status: "recent_7d_partial",
  filesProcessed: 3,
  coveredAt: {
    startAt: null,
    endAt: "2026-07-23T12:00:00.000Z",
  },
});

const PAUSED_INDEX = Object.freeze({
  ...COMPLETE_INDEX,
  status: "bounded_pause",
  phase: "paused",
  filesProcessed: 2,
  coveredAt: {
    startAt: "2026-07-16T12:00:00.000Z",
    endAt: null,
  },
});

function createManualTimerScheduler() {
  let nowMs = 0;
  let nextId = 1;
  const scheduled = new Map();
  return {
    now: () => nowMs,
    setTimeout(callback, delayMs) {
      const handle = {
        id: nextId,
        unref() {},
      };
      nextId += 1;
      scheduled.set(handle, {
        callback,
        dueAt: nowMs + delayMs,
        id: handle.id,
      });
      return handle;
    },
    clearTimeout(handle) {
      scheduled.delete(handle);
    },
    advanceBy(elapsedMs) {
      const target = nowMs + elapsedMs;
      while (true) {
        const ready = [...scheduled.entries()]
          .filter(([, value]) => value.dueAt <= target)
          .sort((left, right) => (
            left[1].dueAt - right[1].dueAt || left[1].id - right[1].id
          ))[0];
        if (ready === undefined) break;
        const [handle, value] = ready;
        scheduled.delete(handle);
        nowMs = value.dueAt;
        value.callback();
      }
      nowMs = target;
    },
  };
}

async function flushControllerSettlement(controller) {
  for (let attempt = 0; attempt < 100 && controller.isRunning(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("refresh controller admits the bounded fresh-index ceiling", () => {
  const dependencies = {
    runner: async () => ({}),
    dataStore: { async reload() {} },
  };
  assert.equal(
    LOCAL_COMPANION_FRESH_INDEX_REFRESH_TIMEOUT_MS,
    14_400_000,
  );
  assert.equal(
    LOCAL_COMPANION_REFRESH_TIMEOUT_MAX_MS,
    14_400_000,
  );
  assert.equal(LOCAL_COMPANION_REFRESH_CANCEL_SETTLEMENT_MS, 30_000);
  assert.doesNotThrow(() => new LocalCompanionRefreshController({
    ...dependencies,
    timeoutMs: LOCAL_COMPANION_REFRESH_TIMEOUT_MAX_MS,
    accountingTimeoutMs: LOCAL_COMPANION_REFRESH_TIMEOUT_MAX_MS,
  }));
  assert.throws(
    () => new LocalCompanionRefreshController({
      ...dependencies,
      timeoutMs: LOCAL_COMPANION_REFRESH_TIMEOUT_MAX_MS + 1,
    }),
    /14,400,000/u,
  );
  for (const accountingTimeoutMs of [999, 14_400_001]) {
    assert.throws(
      () => new LocalCompanionRefreshController({
        ...dependencies,
        accountingTimeoutMs,
      }),
      /accountingTimeoutMs.*14,400,000/u,
    );
  }
  for (const cancelSettlementMs of [999, 60_001]) {
    assert.throws(
      () => new LocalCompanionRefreshController({
        ...dependencies,
        cancelSettlementMs,
      }),
      /cancelSettlementMs.*60,000/u,
    );
  }
  const dynamicallyInvalid = new LocalCompanionRefreshController({
    ...dependencies,
    timeoutMsForRun: () => LOCAL_COMPANION_REFRESH_TIMEOUT_MAX_MS + 1,
  });
  assert.throws(() => dynamicallyInvalid.start(), /14,400,000/u);
});

test("refresh controller resolves a fresh-state timeout for each run", async () => {
  let selections = 0;
  const controller = new LocalCompanionRefreshController({
    runner: async () => ({}),
    dataStore: { async reload() {} },
    timeoutMs: 5 * 60_000,
    timeoutMsForRun() {
      selections += 1;
      return selections === 1
        ? LOCAL_COMPANION_FRESH_INDEX_REFRESH_TIMEOUT_MS
        : 5 * 60_000;
    },
  });
  assert.equal(controller.start(), true);
  while (controller.isRunning()) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(controller.start(), true);
  while (controller.isRunning()) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(selections, 2);
});

test("quick refresh publishes quota/headline data without deep index, accounting, or archive work", async () => {
  const calls = {
    unified: 0,
    accounting: 0,
    archive: 0,
  };
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 4,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
      },
      indexing: COMPLETE_INDEX,
    }),
    refreshUnifiedIndex: async () => {
      calls.unified += 1;
      throw new Error("quick refresh must not advance the unified index");
    },
    refreshAccounting: async () => {
      calls.accounting += 1;
      throw new Error("quick refresh must not rebuild accounting");
    },
    refreshArchiveIndex: async () => {
      calls.archive += 1;
      throw new Error("quick refresh must not scan the archive");
    },
  });

  const result = await runner({ mode: "quick" });
  assert.deepEqual(calls, { unified: 0, accounting: 0, archive: 0 });
  assert.equal(result.filesDiscovered, 4);
  assert.equal(result.quotaRefresh.recordWritten, true);
  assert.equal(Object.hasOwn(result, "unifiedIndex"), false);
  assert.equal(Object.hasOwn(result, "accounting"), false);
  assert.equal(Object.hasOwn(result, "archiveIndex"), false);
  await assert.rejects(
    runner({ mode: "automatic" }),
    /mode must be quick or detailed/u,
  );
});

test("quick refresh skips rollout backfill and a bounded collector continuation", async () => {
  const collectorCalls = [];
  const deepCalls = { unified: 0, accounting: 0, archive: 0 };
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async (options) => {
      collectorCalls.push(options);
      return {
        rolloutRecordsWritten: 0,
        filesDiscovered: 9,
        refresh: { attempted: true, recordWritten: true, errorCode: null },
        // An inherited checkpoint must not turn a quick quota observation
        // into the detailed runner's continuation pass.
        indexing: PAUSED_INDEX,
      };
    },
    refreshUnifiedIndex: async () => { deepCalls.unified += 1; },
    refreshAccounting: async () => { deepCalls.accounting += 1; },
    refreshArchiveIndex: async () => { deepCalls.archive += 1; },
  });

  const result = await runner({ mode: "quick" });
  assert.equal(collectorCalls.length, 1);
  assert.equal(collectorCalls[0].backfill, false);
  assert.equal(Object.hasOwn(collectorCalls[0], "backfillSinceAt"), false);
  assert.equal(collectorCalls[0].skipRolloutIngestion, true);
  assert.equal(collectorCalls[0].refreshStale, true);
  assert.equal(collectorCalls[0].staleAfterMs, 0);
  assert.deepEqual(deepCalls, { unified: 0, accounting: 0, archive: 0 });
  assert.equal(result.quotaRefresh.recordWritten, true);
  assert.deepEqual(result.indexing, PAUSED_INDEX);
  assert.equal(Object.hasOwn(result, "unifiedIndex"), false);
  assert.equal(Object.hasOwn(result, "accounting"), false);
  assert.equal(Object.hasOwn(result, "archiveIndex"), false);
});

test("refresh controller forwards mode and reloads quick and detailed results distinctly", async () => {
  const modes = [];
  const reloads = [];
  const controller = new LocalCompanionRefreshController({
    runner: async ({ mode }) => {
      modes.push(mode);
      return {
        rolloutRecordsWritten: 0,
        filesDiscovered: 0,
        quotaRefresh: {
          attempted: true,
          recordWritten: false,
          errorCode: null,
        },
      };
    },
    dataStore: {
      async reload(options) {
        reloads.push(options);
      },
    },
  });

  assert.equal(controller.start({ mode: "quick" }), true);
  while (controller.isRunning()) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(controller.start(), true);
  while (controller.isRunning()) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(modes, ["quick", "detailed"]);
  assert.equal(reloads[0].purpose, "quick");
  assert.equal(reloads[0].returnOverview, false);
  assert.equal(Object.hasOwn(reloads[0], "unifiedProjectionReuse"), false);
  assert.equal(reloads[1].purpose, "full");
  assert.equal(reloads[1].returnOverview, false);
  assert.equal(Object.hasOwn(reloads[1], "unifiedProjectionReuse"), true);
  assert.throws(
    () => controller.start({ mode: "automatic" }),
    /mode must be quick or detailed/u,
  );
});

test("refresh mode and actual start time survive joins and terminal outcomes", async () => {
  for (const mode of ["quick", "detailed"]) {
    for (const outcome of ["succeeded", "failed", "cancelled"]) {
      const pending = Promise.withResolvers();
      const startedAt = Date.parse("2026-09-01T12:00:00.000Z");
      let now = startedAt;
      const controller = new LocalCompanionRefreshController({
        clock: () => now,
        runner: () => pending.promise,
        dataStore: { async reload() {} },
      });
      assert.equal(controller.getStatus().mode, null);
      assert.equal(controller.getStatus().startedAt, null);
      assert.equal(controller.start({ mode }), true);
      const running = controller.getStatus();
      assert.equal(running.mode, mode);
      assert.equal(running.startedAt, new Date(startedAt).toISOString());
      now += 15_000;
      assert.equal(controller.start({
        mode: mode === "quick" ? "detailed" : "quick",
      }), false);
      assert.deepEqual(controller.getStatus(), running,
        "a 409 join keeps the running operation's mode and start receipt");
      if (outcome === "cancelled") controller.cancel();
      if (outcome === "failed") pending.reject(new Error("synthetic failure"));
      else pending.resolve({});
      await flushControllerSettlement(controller);
      const terminal = controller.getStatus();
      assert.equal(terminal.status, outcome);
      assert.equal(terminal.mode, mode);
      assert.equal(terminal.startedAt, running.startedAt);
      assert.equal(terminal.refreshId, running.refreshId);
      assert.equal(terminal.finishedAt, new Date(now).toISOString());
    }
  }
});

// The unified index generation the accounting cache is bound to. Every
// unified fixture below proves this exact generation, so reuse is exercised
// against a current, complete index rather than an absent one.
const UNIFIED_GENERATION = Object.freeze({
  id: 14,
  fingerprint: "r".repeat(64),
  status: "complete",
  discoveryComplete: true,
  diagnosticsComplete: true,
  usageProvenanceComplete: true,
  sourceOrderComplete: true,
  quotaProvenanceComplete: true,
  toolProvenanceComplete: true,
});

// The zero-fallback attestation a unified accounting cache carries. Without it
// the cache is never reusable and a rebuild is never authoritative.
const UNIFIED_SOURCE_DESCRIPTOR = Object.freeze({
  mode: "unified",
  readerVersion: "replay-safe-reader-v1",
  contextBehavior: "source_native",
  coverageStatus: "complete",
  generation: UNIFIED_GENERATION.id,
  generationFingerprint: UNIFIED_GENERATION.fingerprint,
  generationMatched: true,
  fallbackCount: 0,
  diagnosticsAvailable: true,
  capabilities: null,
});

const REUSABLE_ACCOUNTING_CACHE = Object.freeze({
  weeklyApiIntervals: Object.freeze({schemaVersion:'weekly-api-interval-v1',status:'available',rows:[]}),
  schemaVersion: REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
  pricingMethodVersion: LOCAL_API_PRICING_METHOD_VERSION,
  generatedAt: "2026-07-23T10:00:00.000Z",
  coveredAt: Object.freeze({
    startAt: "2026-06-22T10:00:00.000Z",
    endAt: "2026-07-23T10:00:00.000Z",
  }),
  periods: Object.freeze([
    Object.freeze({ id: "7d", events: 17 }),
  ]),
  diagnostics: Object.freeze({
    forkReplayEventsExcluded: 29,
  }),
  sourceDescriptor: UNIFIED_SOURCE_DESCRIPTOR,
});

// The authority the runner projects for an accepted unified cache or rebuild.
const INTERNAL_UNIFIED_ACCOUNTING_AUTHORITY = Object.freeze({
  sourceMode: "unified",
  readerVersion: UNIFIED_SOURCE_DESCRIPTOR.readerVersion,
  compatibilityBehavior: "source_native",
  coverageStatus: "complete",
  generation: UNIFIED_GENERATION.id,
  generationFingerprint: UNIFIED_GENERATION.fingerprint,
  generationMatched: true,
  fallbackCount: 0,
  diagnosticsAvailable: true,
  capabilities: null,
});

// The bounded deep-ingestion progress the runner publishes as it starts the
// unified index. It replaces the quick-result phase before accounting begins.
const UNIFIED_DEEP_START_PROGRESS = Object.freeze({
  kind: "unified_index",
  status: "scanning",
  phase: "rollout_index",
  filesDiscovered: 0,
  filesSelected: 0,
  filesProcessed: 0,
  recordsWritten: 0,
});

const UNIFIED_ACCOUNTING_CALCULATING_PROGRESS = Object.freeze({
  kind: "accounting",
  status: "calculating",
});

function ingestedUnifiedIndex(generation = UNIFIED_GENERATION) {
  return async () => ({ status: "ingested", generation });
}

test("overview cadence advances accounting after ingestion without launching another writer", async () => {
  const stages = [];
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({ rolloutRecordsWritten: 1, filesDiscovered: 1,
      refresh: { attempted: true, recordWritten: true, errorCode: null }, indexing: COMPLETE_INDEX }),
    refreshUnifiedIndex: async () => { stages.push("index"); return { status: "ingested", generation: UNIFIED_GENERATION }; },
    refreshAccounting: async ({ expectedGeneration }) => {
      assert.equal(expectedGeneration.id, UNIFIED_GENERATION.id);
      stages.push("accounting"); return REUSABLE_ACCOUNTING_CACHE;
    },
    refreshArchiveIndex: async () => { throw Error("overview must not launch archive maintenance"); },
  });
  const result = await runner({ mode: "overview" });
  assert.deepEqual(stages, ["index", "accounting"]);
  assert.equal(result.accounting.refreshStatus, "rebuilt");
  assert.equal(result.accounting.status, "replay_safe");
});

test("overview cadence exposes an accounting failure instead of reporting silent omission", async () => {
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({ rolloutRecordsWritten: 1, refresh: { attempted: true, recordWritten: true, errorCode: null } }),
    refreshUnifiedIndex: ingestedUnifiedIndex(),
    refreshAccounting: async () => { throw Object.assign(new Error("synthetic"), { code: "accounting_unified_source_unavailable" }); },
  });
  const result = await runner({ mode: "overview" });
  assert.equal(result.accounting.status, "unavailable");
  assert.equal(result.accounting.errorCode, "accounting_unified_source_unavailable");
});

test("an unavailable accounting report degrades the shared refresh receipt explicitly", async () => {
  const controller = new LocalCompanionRefreshController({
    runner: async () => ({ accounting: { status: "unavailable", errorCode: "accounting_unified_source_unavailable" } }),
    dataStore: { async reload() {} },
  });
  controller.start({ mode: "overview" });
  await controller.whenSettled();
  assert.equal(controller.getStatus().status, "degraded");
  assert.equal(controller.getStatus().failedStep, "accounting");
  assert.equal(controller.getStatus().failureCode, "accounting_unified_source_unavailable");
});

const FRESH_NOTIFICATION_EVIDENCE = Object.freeze({
  schemaVersion: "usagemonitor-notification-evidence-v2",
  status: "fresh_provider_observation",
  provider: "openai_codex",
  source: "app_server_read",
  freshness: "fresh",
  observedAt: "2026-07-23T12:00:00.000Z",
  continuityKey: "a".repeat(43),
  windows: Object.freeze([Object.freeze({
    lane: "primary",
    usedPercent: 84,
    durationMinutes: 10080,
    resetAt: "2026-07-30T12:00:00.000Z",
    resetProofKind: "provider_reported_schedule_only",
  })]),
});

test("local refresh exposes only the closed fresh direct-provider notification receipt", async (t) => {
  const validRunner = createLocalCollectorRefreshRunner({
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 0,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
        notificationEvidence: FRESH_NOTIFICATION_EVIDENCE,
      },
    }),
  });
  const valid = await validRunner();
  assert.deepEqual(valid.notificationEvidence, FRESH_NOTIFICATION_EVIDENCE);
  // The unified accounting block is a separate, explicit status. The closed
  // receipt itself must not carry account material.
  const receiptPayload = { ...valid };
  delete receiptPayload.accounting;
  assert.equal(JSON.stringify(receiptPayload).includes("account"), false);
  assert.equal(JSON.stringify(valid).includes("/private/"), false);

  const genericRunner = createLocalCollectorRefreshRunner({
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 0,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
        notificationEvidence: {
          ...FRESH_NOTIFICATION_EVIDENCE,
          windows: [{
            ...FRESH_NOTIFICATION_EVIDENCE.windows[0],
            durationMinutes: 43_200,
          }],
        },
      },
    }),
  });
  assert.equal(
    (await genericRunner()).notificationEvidence.windows[0].durationMinutes,
    43_200,
  );

  const expiredRunner = createLocalCollectorRefreshRunner({
    clock: () => Date.parse("2026-07-23T12:05:00.001Z"),
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 0,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
        notificationEvidence: FRESH_NOTIFICATION_EVIDENCE,
      },
    }),
  });
  assert.equal(
    Object.hasOwn(await expiredRunner(), "notificationEvidence"),
    false,
  );

  for (const [name, notificationEvidence] of [
    ["stale", { ...FRESH_NOTIFICATION_EVIDENCE, freshness: "stale" }],
    ["mixed source", { ...FRESH_NOTIFICATION_EVIDENCE, source: "ledger" }],
    ["inferred", { ...FRESH_NOTIFICATION_EVIDENCE, status: "inferred" }],
    ["zero duration", {
      ...FRESH_NOTIFICATION_EVIDENCE,
      windows: [{
        ...FRESH_NOTIFICATION_EVIDENCE.windows[0],
        durationMinutes: 0,
      }],
    }],
    ["overlong duration", {
      ...FRESH_NOTIFICATION_EVIDENCE,
      windows: [{
        ...FRESH_NOTIFICATION_EVIDENCE.windows[0],
        durationMinutes: 525_601,
      }],
    }],
    ["fractional duration", {
      ...FRESH_NOTIFICATION_EVIDENCE,
      windows: [{
        ...FRESH_NOTIFICATION_EVIDENCE.windows[0],
        durationMinutes: 1.5,
      }],
    }],
  ]) {
    await t.test(name, async () => {
      const runner = createLocalCollectorRefreshRunner({
        selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
        runCollector: async () => ({
          rolloutRecordsWritten: 0,
          filesDiscovered: 0,
          refresh: {
            attempted: true,
            recordWritten: true,
            errorCode: null,
            notificationEvidence,
          },
        }),
      });
      const result = await runner();
      assert.equal(Object.hasOwn(result, "notificationEvidence"), false);
    });
  }
});

test("refresh controller binds every terminal receipt to one opaque refresh run", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const refreshIds = [
    "10000000-0000-4000-8000-000000000000",
    "20000000-0000-4000-8000-000000000000",
  ];
  const controller = new LocalCompanionRefreshController({
    runner: async () => {
      await gate;
      return {
        rolloutRecordsWritten: 0,
        filesDiscovered: 0,
        quotaRefresh: { attempted: true, recordWritten: true, errorCode: null },
        indexing: COMPLETE_INDEX,
      };
    },
    dataStore: { async reload() {} },
    createRefreshId: () => refreshIds.shift(),
  });

  assert.equal(controller.start(), true);
  const firstId = controller.getStatus().refreshId;
  assert.equal(firstId, "10000000-0000-4000-8000-000000000000");
  assert.equal(controller.start(), false);
  assert.equal(controller.getStatus().refreshId, firstId);

  release();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "succeeded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(controller.getStatus().status, "succeeded");
  assert.equal(controller.getStatus().refreshId, firstId);

  assert.equal(controller.start(), true);
  assert.equal(
    controller.getStatus().refreshId,
    "20000000-0000-4000-8000-000000000000",
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "succeeded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(controller.getStatus().status, "succeeded");
});

test("local refresh bounds the headline collector pass and returns only safe progress", async () => {
  let options;
  const controller = new AbortController();
  const progress = [];
  const runner = createLocalCollectorRefreshRunner({
    codexHome: "/private/codex-home",
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: async () => Buffer.alloc(32, 7),
    }),
    runCollector: async (value) => {
      options = value;
      await value.onProgress(COMPLETE_INDEX);
      return {
        rolloutRecordsWritten: 12,
        filesDiscovered: 9,
        refresh: {
          attempted: true,
          recordWritten: true,
          errorCode: null,
        },
        indexing: {
          ...COMPLETE_INDEX,
          privatePath: "/private/must-not-escape",
        },
      };
    },
  });

  const result = await runner({
    signal: controller.signal,
    onProgress: (value) => progress.push(value),
  });

  // Rollout ingestion belongs to the unified index. The collector only reads
  // quota evidence and carries the headline-pass bounds.
  assert.equal(options.backfill, false);
  assert.equal(Object.hasOwn(options, "backfillSinceAt"), false);
  assert.equal(options.skipRolloutIngestion, true);
  assert.equal(options.signal, controller.signal);
  assert.equal(options.maximumRecentRunBytes, 128 * 1024 * 1024);
  assert.equal(options.maximumRecentTailBytes, 4 * 1024 * 1024);
  assert.equal(options.maximumRecentPreludeBytes, 512 * 1024);
  assert.equal(options.maximumBufferedLineBytes, 1024 * 1024);
  assert.equal(progress.length, 2);
  assert.deepEqual(progress[0], COMPLETE_INDEX);
  assert.deepEqual(progress[1], {
    ...COMPLETE_INDEX,
    phase: "quick_result",
  });
  assert.equal(result.rolloutRecordsWritten, 12);
  assert.deepEqual(result.indexing, COMPLETE_INDEX);
  assert.equal(JSON.stringify(result).includes("/private/"), false);
});

test("local refresh routes collector, credential lock, and accounting writes beneath explicit state", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "local-refresh-state-"));
  const paths = localCompanionStatePaths(stateRoot);
  let collectorOptions;
  let selectionOptions;
  try {
    const runner = createLocalCollectorRefreshRunner({
      codexHome: join(stateRoot, "read-only-codex-source"),
      stateFile: paths.collectorStateFile,
      unifiedIndexFile: paths.unifiedIndexFile,
      unifiedIndexSecretFile: paths.unifiedIndexSecretFile,
      accountObservationOperationLockFile:
        paths.accountObservationLockFile,
      selectAccountObservationSecret: (options) => {
        selectionOptions = options;
        return { loadAccountObservationSecret: null };
      },
      runCollector: async (options) => {
        collectorOptions = options;
        return {
          rolloutRecordsWritten: 0,
          filesDiscovered: 0,
          refresh: {
            attempted: false,
            recordWritten: false,
            errorCode: null,
          },
        };
      },
      refreshUnifiedIndex: async ({ indexFile, secretFile }) => {
        assert.equal(indexFile, paths.unifiedIndexFile);
        assert.equal(secretFile, paths.unifiedIndexSecretFile);
        return { status: "ingested", generation: UNIFIED_GENERATION };
      },
      refreshAccounting: async ({
        stateFile,
        unifiedIndexFile,
        expectedGeneration,
      }) => {
        assert.equal(stateFile, paths.collectorStateFile);
        assert.equal(unifiedIndexFile, paths.unifiedIndexFile);
        assert.equal(expectedGeneration.id, UNIFIED_GENERATION.id);
        return {
          generatedAt: "2026-07-23T12:00:00.000Z",
          periods: [],
          diagnostics: {},
          sourceDescriptor: UNIFIED_SOURCE_DESCRIPTOR,
        };
      },
    });

    await runner();

    assert.equal(
      selectionOptions.operationLockFile,
      paths.accountObservationLockFile,
    );
    assert.deepEqual(
      [
        collectorOptions.stateFile,
      ],
      [
        paths.collectorStateFile,
      ],
    );
    for (const path of Object.values(paths)) {
      assert.equal(relative(stateRoot, path).startsWith(".."), false);
    }
  } finally {
    await rm(stateRoot, { recursive: true });
  }
});

test("unified accounting mode never advances the legacy archive and passes explicit authority", async () => {
  const order = [];
  let accountingOptions = null;
  const runner = createLocalCollectorRefreshRunner({
    codexHome: "/private/codex-home",
    unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 1,
      filesDiscovered: 1,
      refresh: {
        attempted: false,
        recordWritten: false,
        errorCode: null,
      },
      indexing: COMPLETE_INDEX,
    }),
    refreshUnifiedIndex: async () => {
      order.push("unified");
      return {
        status: "ingested",
        generation: {
          id: 7,
          fingerprint: "a".repeat(64),
          status: "complete",
          discoveryComplete: true,
          diagnosticsComplete: true,
          usageProvenanceComplete: true,
          sourceOrderComplete: true,
          quotaProvenanceComplete: true,
          toolProvenanceComplete: true,
        },
      };
    },
    refreshAccounting: async (options) => {
      order.push("accounting");
      accountingOptions = options;
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [{ id: "7d", events: 1 }],
        diagnostics: {},
        sourceDescriptor: { fallbackCount: 0 },
      };
    },
    refreshArchiveIndex: async () => {
      throw new Error("legacy archive must stay dormant in unified mode");
    },
  });

  const result = await runner();
  assert.deepEqual(order, ["unified", "accounting"]);
  assert.equal(accountingOptions.sourceMode, "unified");
  assert.equal(accountingOptions.contextBehavior, "source_native");
  assert.equal(
    accountingOptions.unifiedIndexFile,
    "/private/local-unified-index-v1.sqlite",
  );
  assert.equal(result.archiveIndex, undefined);
  assert.equal(result.accounting.sourceMode, "unified");
});

test("tool-only partial coverage and an inherited legacy indexing status do not block unified accounting", async () => {
  let accountingCalls = 0;
  const generation = {
    id: 8,
    fingerprint: "t".repeat(64),
    status: "partial",
    blockReason: "tool_provenance_incomplete",
    discoveryComplete: true,
    diagnosticsComplete: true,
    usageProvenanceComplete: true,
    sourceOrderComplete: true,
    quotaProvenanceComplete: true,
    toolProvenanceComplete: false,
  };
  const runner = createLocalCollectorRefreshRunner({
    unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 1,
      filesDiscovered: 1,
      refresh: { attempted: false, recordWritten: false, errorCode: null },
      indexing: {
        ...COMPLETE_INDEX,
        status: "recent_7d_indexing",
        phase: "rollout_index",
        coveredAt: {
          ...COMPLETE_INDEX.coveredAt,
          endAt: null,
        },
      },
    }),
    refreshUnifiedIndex: async () => ({ status: "ingested", generation }),
    refreshAccounting: async (options) => {
      accountingCalls += 1;
      assert.equal(options.expectedGeneration.status, "partial");
      assert.equal(
        options.expectedGeneration.blockReason,
        "tool_provenance_incomplete",
      );
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [{ id: "7d", events: 1 }],
        diagnostics: {},
        sourceDescriptor: { fallbackCount: 0 },
      };
    },
  });

  const result = await runner();
  assert.equal(accountingCalls, 1);
  assert.equal(result.accounting.sourceMode, "unified");
  assert.equal(result.accounting.refreshStatus, "rebuilt");
  assert.equal(result.indexing.status, "recent_7d_indexing");
  assert.equal(result.unifiedIndex.generation.toolProvenanceComplete, false);
});

test("rollout quarantine remains accounting-authoritative but terminates the controller as degraded", async () => {
  let accountingCalls = 0;
  const generation = {
    id: 9,
    fingerprint: "d".repeat(64),
    status: "partial",
    blockReason: "codex_rollout_sources_quarantined",
    discoveredSourceCount: 3,
    discoveredSourceBytes: 3_000,
    indexedSourceCount: 1,
    indexedSourceBytes: 1_000,
    skippedSourceCount: 2,
    skippedSourceBytes: 2_000,
    skippedThreadCount: 1,
    issueCounts: {
      codex_rollout_generation_ambiguous: {
        threadCount: 1,
        sourceCount: 2,
        sourceBytes: 2_000,
      },
    },
    discoveryComplete: true,
    diagnosticsComplete: true,
    usageProvenanceComplete: true,
    sourceOrderComplete: true,
    quotaProvenanceComplete: true,
    toolProvenanceComplete: true,
  };
  const runner = createLocalCollectorRefreshRunner({
    unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 1,
      filesDiscovered: 3,
      refresh: { attempted: false, recordWritten: false, errorCode: null },
      indexing: COMPLETE_INDEX,
    }),
    refreshUnifiedIndex: async () => ({ status: "ingested", generation }),
    refreshAccounting: async (options) => {
      accountingCalls += 1;
      assert.equal(options.expectedGeneration.status, "partial");
      assert.equal(
        options.expectedGeneration.blockReason,
        "codex_rollout_sources_quarantined",
      );
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [{ id: "7d", events: 1 }],
        diagnostics: {},
        sourceDescriptor: {
          fallbackCount: 0,
          coverage: {
            status: "partial",
            blockReason: "codex_rollout_sources_quarantined",
            skippedSourceCount: 2,
            skippedThreadCount: 1,
          },
        },
      };
    },
  });

  const result = await runner();
  assert.equal(accountingCalls, 1);
  assert.equal(result.accounting.status, "replay_safe");
  assert.equal(result.accounting.sourceMode, "unified");
  assert.equal(result.unifiedIndex.generation.status, "partial");
  assert.equal(result.unifiedIndex.generation.skippedSourceCount, 2);
  assert.deepEqual(result.unifiedIndex.generation.reasonCounts, {
    codex_rollout_generation_ambiguous: 1,
  });

  const controller = new LocalCompanionRefreshController({
    runner: async () => result,
    dataStore: { reload: async () => {} },
  });
  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "degraded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const status = controller.getStatus();
  assert.equal(status.status, "degraded");
  assert.equal(status.errorCode, "refresh_degraded");
  assert.equal(status.failedStep, "unified_index");
  assert.equal(status.failureCode, "codex_rollout_generation_ambiguous");
  assert.equal(status.result.accounting.status, "replay_safe");
  assert.equal(status.result.unifiedIndex.generation.skippedSourceCount, 2);
});

test("unified authority keeps quota-only collection prospective and softens a collector-only pause", async () => {
  const collectorOptions = [];
  const expectedGeneration = {
    id: 12,
    fingerprint: "p".repeat(64),
    status: "complete",
    discoveryComplete: true,
    diagnosticsComplete: true,
    usageProvenanceComplete: true,
    sourceOrderComplete: true,
    quotaProvenanceComplete: true,
    toolProvenanceComplete: true,
  };
  const runner = createLocalCollectorRefreshRunner({
    unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async (options) => {
      collectorOptions.push(options);
      return {
        rolloutRecordsWritten: 0,
        filesDiscovered: 9,
        resourceLimit: {
          code: "collector_resource_source_bytes_limit_exceeded",
          dimension: "source_bytes",
          limit: 128 * 1024 * 1024,
          observed: 128 * 1024 * 1024 + 1,
        },
        refresh: {
          attempted: false,
          recordWritten: false,
          errorCode: null,
        },
        indexing: PAUSED_INDEX,
      };
    },
    refreshUnifiedIndex: async () => ({
      status: "ingested",
      generation: expectedGeneration,
    }),
    refreshAccounting: async () => ({
      generatedAt: "2026-07-23T12:00:00.000Z",
      periods: [{ id: "7d", events: 3 }],
      diagnostics: {},
      sourceDescriptor: { fallbackCount: 0 },
    }),
  });

  const result = await runner();
  assert.equal(collectorOptions.length, 1);
  assert.equal(collectorOptions[0].backfill, false);
  assert.equal(collectorOptions[0].skipRolloutIngestion, true);
  assert.equal(Object.hasOwn(collectorOptions[0], "backfillSinceAt"), false);
  assert.equal(result.indexing.status, "bounded_pause");
  assert.equal(result.accounting.sourceMode, "unified");
  assert.equal(result.accounting.refreshStatus, "rebuilt");
});

test("a reusable unified accounting cache does not announce a cold rebuild", async () => {
  const progress = [];
  let rebuilds = 0;
  const expectedGeneration = {
    id: 14,
    fingerprint: "r".repeat(64),
    status: "complete",
    discoveryComplete: true,
    diagnosticsComplete: true,
    usageProvenanceComplete: true,
    sourceOrderComplete: true,
    quotaProvenanceComplete: true,
    toolProvenanceComplete: true,
  };
  const runner = createLocalCollectorRefreshRunner({
    unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 1,
      refresh: { attempted: false, recordWritten: false, errorCode: null },
      indexing: COMPLETE_INDEX,
    }),
    refreshUnifiedIndex: async () => ({
      status: "ingested",
      generation: expectedGeneration,
    }),
    readAccountingCache: async (options) => {
      assert.equal(options.expectedGeneration.id, expectedGeneration.id);
      assert.equal(
        options.expectedGeneration.fingerprint,
        expectedGeneration.fingerprint,
      );
      return {
        status: "available",
        errorCode: null,
        cache: {
          ...REUSABLE_ACCOUNTING_CACHE,
          sourceDescriptor: {
            mode: "unified",
            fallbackCount: 0,
          },
        },
      };
    },
    refreshAccounting: async () => {
      rebuilds += 1;
      throw new Error("a reusable cache must not rebuild");
    },
  });

  const result = await runner({ onProgress: (value) => progress.push(value) });

  assert.equal(rebuilds, 0);
  assert.equal(result.accounting.refreshStatus, "reused");
  assert.equal(progress.some((value) => value?.kind === "accounting"), false);
});

test("a semantics-outdated unified cache announces one rebuild and receives the cold-work bound", async (t) => {
  const timers = createManualTimerScheduler();
  const rebuildEntered = Promise.withResolvers();
  const rebuildSettled = Promise.withResolvers();
  const events = [];
  let rebuilds = 0;
  let rebuildSignal;
  t.after(() => rebuildSettled.resolve({}));
  const generation = {
    id: 15,
    fingerprint: "s".repeat(64),
    status: "complete",
    discoveryComplete: true,
    diagnosticsComplete: true,
    usageProvenanceComplete: true,
    sourceOrderComplete: true,
    quotaProvenanceComplete: true,
    toolProvenanceComplete: true,
  };
  const collectorRunner = createLocalCollectorRefreshRunner({
    unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 1,
      refresh: { attempted: false, recordWritten: false, errorCode: null },
      indexing: COMPLETE_INDEX,
    }),
    refreshUnifiedIndex: async () => ({
      status: "ingested",
      generation,
    }),
    readAccountingCache: async (options) => {
      assert.equal(options.sourceMode, "unified");
      assert.equal(options.expectedGeneration.id, generation.id);
      events.push("cache_accounting_semantics_outdated");
      return {
        status: "unavailable",
        errorCode: "cache_accounting_semantics_outdated",
        cache: null,
      };
    },
    refreshAccounting: async ({ expectedGeneration, signal }) => {
      rebuilds += 1;
      rebuildSignal = signal;
      assert.equal(expectedGeneration.id, generation.id);
      events.push("rebuild");
      rebuildEntered.resolve();
      return rebuildSettled.promise;
    },
  });
  const runner = ({ onProgress, ...options }) => collectorRunner({
    ...options,
    onProgress: async (progress) => {
      if (progress?.kind === "accounting") events.push("accounting_marker");
      await onProgress(progress);
    },
  });
  const controller = new LocalCompanionRefreshController({
    runner,
    dataStore: { async reload() {} },
    timeoutMs: 1_000,
    accountingTimeoutMs: 4_000,
    monotonicClock: timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  assert.equal(controller.start(), true);
  await rebuildEntered.promise;
  assert.deepEqual(events, [
    "cache_accounting_semantics_outdated",
    "accounting_marker",
    "rebuild",
  ]);
  assert.equal(rebuilds, 1);
  assert.deepEqual(controller.getStatus().progress, {
    kind: "accounting",
    status: "calculating",
  });

  timers.advanceBy(3_999);
  assert.equal(controller.getStatus().status, "running");
  assert.equal(rebuildSignal.aborted, false);
  timers.advanceBy(1);
  assert.equal(controller.getStatus().status, "failed");
  assert.equal(controller.getStatus().errorCode, "refresh_timed_out");
  assert.equal(rebuildSignal.aborted, true);

  rebuildSettled.resolve({});
  await flushControllerSettlement(controller);
  assert.equal(rebuilds, 1);
  assert.equal(controller.getStatus().status, "failed");
});

test("a fresh unified machine completes its first refresh when the app-server read fails", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "local-refresh-fresh-machine-"));
  createProtectedFixtureDirectory(join(stateRoot, "state"));
  const expectedGeneration = {
    id: 1,
    fingerprint: "f".repeat(64),
    status: "complete",
    discoveryComplete: true,
    diagnosticsComplete: true,
    usageProvenanceComplete: true,
    sourceOrderComplete: true,
    quotaProvenanceComplete: true,
    toolProvenanceComplete: true,
  };
  try {
    // A machine on its very first pass: real session logs exist, but the
    // Codex app-server quota read fails (no per-user Codex session). The
    // refresh must still reach the unified index and accounting instead of
    // aborting at the collector with nothing indexed.
    const codexHome = join(stateRoot, "codex-home");
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    await writeFile(
      join(codexHome, "sessions", "rollout-2026-08-19T00-00-00-fresh.jsonl"),
      "",
    );
    const stateFile = join(stateRoot, "state", "local-collector-state-v1.sqlite");
    let unifiedIndexRuns = 0;
    const runner = createLocalCollectorRefreshRunner({
      codexHome,
      stateFile,
      unifiedIndexFile: join(stateRoot, "state", "local-unified-index-v1.sqlite"),
      selectAccountObservationSecret: () => ({
        loadAccountObservationSecret: null,
      }),
      runCollector: (options) => runCollectorOnce({
        ...options,
        appServerFactory: () => ({
          async start() {
            throw new CodexAppServerError(
              "app_server_unavailable",
              "Unable to start the Codex app-server",
            );
          },
          close() {},
        }),
      }),
      refreshUnifiedIndex: async () => {
        unifiedIndexRuns += 1;
        return { status: "ingested", generation: expectedGeneration };
      },
      refreshAccounting: async () => ({
        generatedAt: "2026-08-19T12:00:00.000Z",
        periods: [{ id: "7d", events: 0 }],
        diagnostics: {},
        sourceDescriptor: { fallbackCount: 0 },
      }),
      clock: () => Date.parse("2026-08-19T12:00:00.000Z"),
    });

    const first = await runner();
    assert.equal(unifiedIndexRuns, 1);
    assert.deepEqual(first.quotaRefresh, {
      attempted: true,
      recordWritten: false,
      errorCode: "app_server_unavailable",
    });
    assert.equal(first.unifiedIndex.status, "ingested");
    assert.equal(first.accounting.status, "replay_safe");
    assert.equal(first.accounting.refreshStatus, "rebuilt");

    // The failed pass still persisted its checkpoint, so the loop is broken:
    // the next pass recovers from the durable row and completes the same way.
    const checkpoint = await readLocalCollectorCheckpoint({ stateFile });
    assert.equal(
      checkpoint.diagnostics.appServerErrorCounts.app_server_unavailable,
      1,
    );
    const second = await runner();
    assert.equal(unifiedIndexRuns, 2);
    assert.equal(second.quotaRefresh.errorCode, "app_server_unavailable");
    assert.equal(second.unifiedIndex.status, "ingested");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("quick refresh reports a quota failure, preserves no-change state, and recovers on the next observation", async () => {
  const collectorResults = [
    {
      rolloutRecordsWritten: 0,
      filesDiscovered: 0,
      refresh: {
        attempted: true,
        recordWritten: false,
        errorCode: "app_server_unavailable",
      },
    },
    {
      rolloutRecordsWritten: 0,
      filesDiscovered: 0,
      refresh: {
        attempted: true,
        recordWritten: false,
        errorCode: null,
      },
    },
    {
      rolloutRecordsWritten: 0,
      filesDiscovered: 0,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
      },
    },
  ];
  const collectorOptions = [];
  let unifiedIndexRuns = 0;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async (options) => {
      collectorOptions.push(options);
      return collectorResults.shift();
    },
    refreshUnifiedIndex: async () => {
      unifiedIndexRuns += 1;
      return { status: "ingested" };
    },
  });

  const failed = await runner({ mode: "quick" });
  assert.deepEqual(failed.quotaRefresh, {
    attempted: true,
    recordWritten: false,
    errorCode: "app_server_unavailable",
  });
  assert.equal(failed.unifiedIndex, undefined);

  const unchanged = await runner({ mode: "quick" });
  assert.deepEqual(unchanged.quotaRefresh, {
    attempted: true,
    recordWritten: false,
    errorCode: null,
  });

  const recovered = await runner({ mode: "quick" });
  assert.deepEqual(recovered.quotaRefresh, {
    attempted: true,
    recordWritten: true,
    errorCode: null,
  });
  assert.equal(collectorOptions.length, 3);
  assert.equal(collectorOptions.every((options) => options.skipRolloutIngestion), true);
  assert.equal(unifiedIndexRuns, 0);
});

test("detailed refresh keeps quota and unified-index failures independent and recovers", async () => {
  const completeGeneration = {
    id: 1,
    fingerprint: "e".repeat(64),
    status: "complete",
    discoveryComplete: true,
    diagnosticsComplete: true,
    usageProvenanceComplete: true,
    sourceOrderComplete: true,
    quotaProvenanceComplete: true,
    toolProvenanceComplete: true,
  };
  const collectorResults = [
    {
      rolloutRecordsWritten: 0,
      filesDiscovered: 0,
      refresh: {
        attempted: true,
        recordWritten: false,
        errorCode: "app_server_unavailable",
      },
    },
    {
      rolloutRecordsWritten: 0,
      filesDiscovered: 0,
      refresh: {
        attempted: true,
        recordWritten: false,
        errorCode: "app_server_unavailable",
      },
    },
    {
      rolloutRecordsWritten: 0,
      filesDiscovered: 0,
      refresh: {
        attempted: true,
        recordWritten: false,
        errorCode: null,
      },
    },
    {
      rolloutRecordsWritten: 0,
      filesDiscovered: 0,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
      },
    },
  ];
  let indexPass = 0;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => collectorResults.shift(),
    refreshUnifiedIndex: async () => {
      indexPass += 1;
      if (indexPass === 2) {
        const error = new Error("synthetic index failure");
        error.code = "local_unified_index_file_changed";
        throw error;
      }
      return {
        status: "ingested",
        generation: completeGeneration,
        unchanged: indexPass === 3,
      };
    },
    readAccountingCache: async () => ({
      status: "unavailable",
      errorCode: "cache_missing",
      cache: null,
    }),
    refreshAccounting: async () => ({
      generatedAt: "2026-08-19T12:00:00.000Z",
      periods: [{ id: "7d", events: 0 }],
      diagnostics: {},
      sourceDescriptor: { fallbackCount: 0 },
    }),
  });

  const quotaFailureWithIndexSuccess = await runner({ mode: "detailed" });
  assert.equal(quotaFailureWithIndexSuccess.quotaRefresh.errorCode, "app_server_unavailable");
  assert.equal(quotaFailureWithIndexSuccess.unifiedIndex.status, "ingested");
  assert.equal(quotaFailureWithIndexSuccess.accounting.status, "replay_safe");

  const bothFailed = await runner({ mode: "detailed" });
  assert.equal(bothFailed.quotaRefresh.errorCode, "app_server_unavailable");
  assert.deepEqual(bothFailed.unifiedIndex, {
    status: "failed",
    errorCode: "local_unified_index_file_changed",
  });
  assert.equal(bothFailed.accounting.status, "unavailable");

  const noNewObservation = await runner({ mode: "detailed" });
  assert.equal(noNewObservation.quotaRefresh.recordWritten, false);
  assert.equal(noNewObservation.unifiedIndex.status, "ingested");
  assert.equal(noNewObservation.unifiedIndex.unchanged, true);

  const recovered = await runner({ mode: "detailed" });
  assert.deepEqual(recovered.quotaRefresh, {
    attempted: true,
    recordWritten: true,
    errorCode: null,
  });
  assert.equal(recovered.unifiedIndex.status, "ingested");
  assert.equal(indexPass, 4);
});

test("a mid-run checkpoint loss fails the refresh under the stable collector code", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "local-refresh-store-fault-"));
  createProtectedFixtureDirectory(join(stateRoot, "state"));
  const clock = () => Date.parse("2026-08-19T12:00:00.000Z");
  try {
    const codexHome = join(stateRoot, "codex-home");
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    const stateFile = join(stateRoot, "state", "local-collector-state-v1.sqlite");
    const seed = () => runCollectorOnce({
      codexHome,
      stateFile,
      refreshStale: false,
      clock,
    });
    let unifiedIndexRuns = 0;
    const runner = createLocalCollectorRefreshRunner({
      codexHome,
      stateFile,
      unifiedIndexFile: join(stateRoot, "state", "local-unified-index-v1.sqlite"),
      selectAccountObservationSecret: () => ({
        loadAccountObservationSecret: null,
      }),
      runCollector: (options) => runCollectorOnce({
        ...options,
        appServerFactory: () => ({
          async start() {
            // Externally strip the durable checkpoint row mid-run. This is a
            // real store fault, not a first run, so it must stay terminal.
            const database = new DatabaseSync(stateFile);
            try {
              database.prepare("DELETE FROM meta WHERE key = 'checkpoint'").run();
            } finally {
              database.close();
            }
            throw new CodexAppServerError("temporary_disconnect", "connection lost");
          },
          close() {},
        }),
      }),
      refreshUnifiedIndex: async () => {
        unifiedIndexRuns += 1;
        return { status: "ingested", generation: null };
      },
      clock,
    });

    await seed();
    await assert.rejects(
      runner(),
      (error) => error?.code === "app_record_checkpoint_unavailable"
        && error?.refreshStep === "collector",
    );
    assert.equal(unifiedIndexRuns, 0);

    await seed();
    const controller = new LocalCompanionRefreshController({
      runner,
      dataStore: { async reload() {} },
      clock,
    });
    assert.equal(controller.start(), true);
    // The runner performs real collector-state I/O, so settle on wall time
    // rather than event-loop ticks.
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (controller.getStatus().status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const status = controller.getStatus();
    assert.equal(status.status, "failed");
    assert.equal(status.errorCode, "refresh_failed");
    assert.equal(status.failedStep, "collector");
    assert.equal(status.failureCode, "app_record_checkpoint_unavailable");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("unified mode fails closed when the authoritative generation is missing or incomplete", async (t) => {
  const cases = [
    {
      name: "failed ingest",
      unifiedIndex: {
        status: "failed",
        errorCode: "local_unified_index_file_changed",
      },
      expectedUnifiedIndex: {
        status: "failed",
        errorCode: "local_unified_index_refresh_failed",
      },
      expectedAccountingError: "accounting_unified_source_unavailable",
      expectedCoverage: "unavailable",
      expectedGeneration: null,
      expectedFingerprint: null,
    },
    {
      name: "missing generation",
      unifiedIndex: { status: "ingested" },
      expectedUnifiedIndex: {
        status: "failed",
        errorCode: "local_unified_index_generation_invalid",
      },
      expectedAccountingError: "accounting_unified_source_unavailable",
      expectedCoverage: "unavailable",
      expectedGeneration: null,
      expectedFingerprint: null,
    },
    {
      name: "partial generation",
      unifiedIndex: {
        status: "ingested",
        generation: {
          id: 7,
          fingerprint: "b".repeat(64),
          status: "partial",
          discoveryComplete: false,
          diagnosticsComplete: true,
          usageProvenanceComplete: true,
          sourceOrderComplete: true,
          quotaProvenanceComplete: true,
          toolProvenanceComplete: true,
        },
      },
      expectedUnifiedIndex: {
        status: "ingested",
        generation: {
          id: 7,
          fingerprint: "b".repeat(64),
          status: "partial",
          blockReason: null,
          schemaVersion: null,
          parserVersion: null,
          contractVersion: null,
          coveredAt: { startAt: null, endAt: null },
          sourceCount: 0,
          sourceBytes: 0,
          discoveredSourceCount: 0,
          discoveredSourceBytes: 0,
          indexedSourceCount: 0,
          indexedSourceBytes: 0,
          skippedSourceCount: 0,
          skippedSourceBytes: 0,
          skippedThreadCount: 0,
          reasonCounts: {},
          usageEvents: 0,
          quotaOccurrences: 0,
          toolFacts: 0,
          toolFactFingerprint: null,
          discoveryComplete: false,
          diagnosticsComplete: true,
          usageProvenanceComplete: true,
          sourceOrderComplete: true,
          quotaProvenanceComplete: true,
          toolProvenanceComplete: true,
        },
        unchanged: false,
        sources: 0,
        sourcesSkipped: 0,
        sourcesTouched: 0,
        sourcesResumed: 0,
        sourcesRescanned: 0,
        sourcesScanned: 0,
        bytesScanned: 0,
        forkReplayEventsSkipped: 0,
        unattributedForkReplayEventsSkipped: 0,
        insertedUsageEvents: 0,
        totalUsageEvents: 0,
        wallMs: 0,
      },
      expectedAccountingError: "accounting_unified_coverage_incomplete",
      expectedCoverage: "partial",
      expectedGeneration: 7,
      expectedFingerprint: "b".repeat(64),
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let accountingCalls = 0;
      let cacheReads = 0;
      let archiveCalls = 0;
      const runner = createLocalCollectorRefreshRunner({
        codexHome: "/private/codex-home",
        unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
        readAccountingCache: async () => {
          cacheReads += 1;
          throw new Error("unified mode must not read a cache without authority");
        },
        selectAccountObservationSecret: () => ({
          loadAccountObservationSecret: null,
        }),
        runCollector: async () => ({
          rolloutRecordsWritten: 1,
          filesDiscovered: 1,
          refresh: {
            attempted: false,
            recordWritten: false,
            errorCode: null,
          },
          indexing: COMPLETE_INDEX,
        }),
        refreshUnifiedIndex: async () => fixture.unifiedIndex,
        refreshAccounting: async () => {
          accountingCalls += 1;
          throw new Error("unified accounting must not run without authority");
        },
        refreshArchiveIndex: async () => {
          archiveCalls += 1;
          throw new Error("legacy archive must stay dormant in unified mode");
        },
      });

      const result = await runner();
      assert.deepEqual(result.unifiedIndex, fixture.expectedUnifiedIndex);
      assert.deepEqual(result.accounting, {
        status: "unavailable",
        sourceMode: "unified",
        errorCode: fixture.expectedAccountingError,
        compatibilityBehavior: "source_native",
        coverageStatus: fixture.expectedCoverage,
        generation: fixture.expectedGeneration,
        generationFingerprint: fixture.expectedFingerprint,
        generationMatched: false,
        fallbackCount: 0,
        diagnosticsAvailable: false,
      });
      assert.equal(accountingCalls, 0);
      assert.equal(cacheReads, 0);
      assert.equal(archiveCalls, 0);
      assert.equal(result.archiveIndex, undefined);
      assert.equal(JSON.stringify(result).includes("/private/"), false);
    });
  }
});

test("unified accounting reader errors stay unavailable without legacy fallback", async () => {
  let accountingCalls = 0;
  let archiveCalls = 0;
  const expectedGeneration = {
    id: 8,
    fingerprint: "c".repeat(64),
    status: "complete",
    discoveryComplete: true,
    diagnosticsComplete: true,
    usageProvenanceComplete: true,
    sourceOrderComplete: true,
    quotaProvenanceComplete: true,
    toolProvenanceComplete: true,
  };
  const runner = createLocalCollectorRefreshRunner({
    codexHome: "/private/codex-home",
    unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 1,
      filesDiscovered: 1,
      refresh: {
        attempted: false,
        recordWritten: false,
        errorCode: null,
      },
      indexing: COMPLETE_INDEX,
    }),
    refreshUnifiedIndex: async () => ({
      status: "ingested",
      generation: expectedGeneration,
    }),
    refreshAccounting: async (options) => {
      accountingCalls += 1;
      assert.equal(options.sourceMode, "unified");
      assert.equal(options.contextBehavior, "source_native");
      assert.equal(options.expectedGeneration.id, expectedGeneration.id);
      assert.equal(
        options.expectedGeneration.fingerprint,
        expectedGeneration.fingerprint,
      );
      assert.equal(options.expectedGeneration.status, expectedGeneration.status);
      const error = new Error("private reader path must not escape");
      error.code = "accounting_unified_generation_changed";
      throw error;
    },
    refreshArchiveIndex: async () => {
      archiveCalls += 1;
      throw new Error("legacy archive must stay dormant in unified mode");
    },
  });

  const result = await runner();
  assert.deepEqual(result.accounting, {
    status: "unavailable",
    sourceMode: "unified",
    errorCode: "accounting_unified_generation_changed",
    compatibilityBehavior: "source_native",
    coverageStatus: "complete",
    generation: 8,
    generationFingerprint: "c".repeat(64),
    generationMatched: false,
    fallbackCount: 0,
    diagnosticsAvailable: false,
  });
  assert.equal(accountingCalls, 1);
  assert.equal(archiveCalls, 0);
  assert.equal(result.archiveIndex, undefined);
  assert.equal(JSON.stringify(result).includes("private reader path"), false);
});

test("unified accounting resource limits reach the bounded refresh failure", async () => {
  const expectedGeneration = {
    id: 9,
    fingerprint: "d".repeat(64),
    status: "complete",
    discoveryComplete: true,
    diagnosticsComplete: true,
    usageProvenanceComplete: true,
    sourceOrderComplete: true,
    quotaProvenanceComplete: true,
    toolProvenanceComplete: true,
  };
  const runner = createLocalCollectorRefreshRunner({
    unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 1,
      filesDiscovered: 1,
      refresh: { attempted: false, recordWritten: false, errorCode: null },
      indexing: COMPLETE_INDEX,
    }),
    refreshUnifiedIndex: async () => ({
      status: "ingested",
      generation: expectedGeneration,
    }),
    refreshAccounting: async () => {
      const error = new Error("private accounting budget detail");
      error.code = "accounting_transition_usage_limit_exceeded";
      throw error;
    },
  });

  await assert.rejects(
    runner(),
    (error) => error?.code === "accounting_transition_usage_limit_exceeded"
      && error?.refreshStep === "accounting",
  );

  const controller = new LocalCompanionRefreshController({
    runner,
    dataStore: { async reload() {} },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });
  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "failed") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const status = controller.getStatus();
  assert.equal(status.status, "failed");
  assert.equal(status.errorCode, "refresh_resource_limited");
  assert.equal(status.failedStep, "accounting");
  assert.equal(status.failureCode, "accounting_transition_usage_limit_exceeded");
  assert.equal(JSON.stringify(status).includes("private accounting budget detail"), false);
});

test("unified accounting measurement-invalid failures remain terminal", async () => {
  const measurementCodes = [
    "accounting_transition_rss_measurement_invalid",
    "accounting_archive_rss_measurement_invalid",
  ];
  for (const code of measurementCodes) {
    const expectedGeneration = {
      id: 11,
      fingerprint: "m".repeat(64),
      status: "complete",
      discoveryComplete: true,
      diagnosticsComplete: true,
      usageProvenanceComplete: true,
      sourceOrderComplete: true,
      quotaProvenanceComplete: true,
      toolProvenanceComplete: true,
    };
    const runner = createLocalCollectorRefreshRunner({
      unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
      selectAccountObservationSecret: () => ({
        loadAccountObservationSecret: null,
      }),
      runCollector: async () => ({
        rolloutRecordsWritten: 1,
        filesDiscovered: 1,
        refresh: { attempted: false, recordWritten: false, errorCode: null },
        indexing: COMPLETE_INDEX,
      }),
      refreshUnifiedIndex: async () => ({
        status: "ingested",
        generation: expectedGeneration,
      }),
      refreshAccounting: async () => {
        const error = new Error("private RSS measurement detail");
        error.code = code;
        throw error;
      },
    });

    await assert.rejects(
      runner(),
      (error) => error?.code === code && error?.refreshStep === "accounting",
    );

    const controller = new LocalCompanionRefreshController({
      runner,
      dataStore: { async reload() {} },
      clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
    });
    assert.equal(controller.start(), true);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (controller.getStatus().status === "failed") break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    const status = controller.getStatus();
    assert.equal(status.status, "failed");
    assert.equal(status.errorCode, "refresh_failed");
    assert.equal(status.failedStep, "accounting");
    assert.equal(status.failureCode, code);
    assert.equal(JSON.stringify(status).includes("private RSS measurement detail"), false);
  }
});

test("public unified accounting errors use the fixed unavailable-code allowlist", async () => {
  const controller = new LocalCompanionRefreshController({
    runner: async () => ({
      accounting: {
        status: "unavailable",
        sourceMode: "unified",
        errorCode: "accounting_private_callback",
      },
    }),
    dataStore: { async reload() {} },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "degraded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const status = controller.getStatus();
  assert.equal(status.status, "degraded");
  assert.equal(status.failedStep, "accounting");
  assert.equal(status.failureCode, "accounting_unified_source_unavailable");
  assert.equal(
    status.result.accounting.errorCode,
    "accounting_unified_source_unavailable",
  );
  assert.equal(JSON.stringify(status).includes("accounting_private_callback"), false);
});

test("unified accounting rejects a cache whose fallback attestation is nonzero", async () => {
  const runner = createLocalCollectorRefreshRunner({
    unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 1,
      filesDiscovered: 1,
      refresh: { attempted: false, recordWritten: false, errorCode: null },
      indexing: COMPLETE_INDEX,
    }),
    refreshUnifiedIndex: async () => ({
      status: "ingested",
      generation: {
        id: 10,
        fingerprint: "e".repeat(64),
        status: "complete",
        discoveryComplete: true,
        diagnosticsComplete: true,
        usageProvenanceComplete: true,
        sourceOrderComplete: true,
        quotaProvenanceComplete: true,
        toolProvenanceComplete: true,
      },
    }),
    refreshAccounting: async () => ({
      generatedAt: "2026-07-23T12:00:00.000Z",
      periods: [{ id: "7d", events: 4 }],
      sourceDescriptor: { fallbackCount: 1 },
    }),
  });

  const result = await runner();
  assert.equal(result.accounting.status, "unavailable");
  assert.equal(result.accounting.errorCode, "accounting_unified_source_unavailable");
  assert.equal(result.accounting.fallbackCount, 0);
});

test("zero-write local refresh reuses a current valid accounting cache without altering it", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "local-refresh-zero-write-state-"));
  const stateFile = join(stateRoot, "local-collector-state.sqlite");
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const controller = new AbortController();
  const clock = () => Date.parse("2026-07-23T12:00:00.000Z");
  const before = structuredClone(REUSABLE_ACCOUNTING_CACHE);
  let readOptions;
  let rebuilds = 0;
  const runner = createLocalCollectorRefreshRunner({
    stateFile,
    clock,
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 3,
      refresh: {
        attempted: true,
        recordWritten: false,
        errorCode: null,
      },
    }),
    refreshUnifiedIndex: ingestedUnifiedIndex(),
    readAccountingCache: async (options) => {
      readOptions = options;
      return {
        status: "available",
        errorCode: null,
        cache: REUSABLE_ACCOUNTING_CACHE,
      };
    },
    refreshAccounting: async () => {
      rebuilds += 1;
      throw new Error("accounting cache must not be rebuilt");
    },
  });

  const result = await runner({ signal: controller.signal });

  const { expectedGeneration, ...readRequest } = readOptions;
  assert.deepEqual(readRequest, {
    stateFile,
    now: clock,
    sourceMode: "unified",
    contextBehavior: "source_native",
    maximumAgeMs: 30 * 60 * 1_000,
  });
  assert.equal(expectedGeneration.id, UNIFIED_GENERATION.id);
  assert.equal(expectedGeneration.fingerprint, UNIFIED_GENERATION.fingerprint);
  assert.equal(rebuilds, 0);
  assert.deepEqual(REUSABLE_ACCOUNTING_CACHE, before);
  assert.deepEqual(result.accounting, {
    status: "replay_safe",
    ...INTERNAL_UNIFIED_ACCOUNTING_AUTHORITY,
    refreshStatus: "reused",
    generatedAt: "2026-07-23T10:00:00.000Z",
    events: 17,
    forkReplayEventsExcluded: 29,
  });
});

test("zero-write local refresh rebuilds when the cache cannot be safely reused", async (t) => {
  const cases = [
    {
      name: "missing cache",
      read: async () => ({
        status: "unavailable",
        errorCode: "cache_missing",
        cache: null,
      }),
    },
    {
      name: "invalid cache",
      read: async () => ({
        status: "unavailable",
        errorCode: "cache_invalid",
        cache: null,
      }),
    },
    {
      name: "stale cache",
      read: async () => ({
        status: "stale",
        errorCode: "cache_stale",
        cache: REUSABLE_ACCOUNTING_CACHE,
      }),
    },
    {
      name: "missing interval projection",
      read: async () => ({status:'available',errorCode:null,
        cache:{...REUSABLE_ACCOUNTING_CACHE,weeklyApiIntervals:undefined}}),
    },
    {
      name: "failed interval projection",
      read: async () => ({status:'available',errorCode:null,
        cache:{...REUSABLE_ACCOUNTING_CACHE,weeklyApiIntervals:{status:'unavailable',reason:'weekly_api_projection_failed'}}}),
    },
    {
      name: "stale schema",
      read: async () => ({
        status: "available",
        errorCode: null,
        cache: {
          ...REUSABLE_ACCOUNTING_CACHE,
          schemaVersion: "local-replay-safe-accounting-v0.0",
        },
      }),
    },
    {
      name: "read failure",
      read: async () => {
        throw new Error("cache temporarily unreadable");
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let rebuilds = 0;
      const runner = createLocalCollectorRefreshRunner({
        selectAccountObservationSecret: () => ({
          loadAccountObservationSecret: null,
        }),
        runCollector: async () => ({
          rolloutRecordsWritten: 0,
          filesDiscovered: 0,
          refresh: {
            attempted: false,
            recordWritten: false,
            errorCode: null,
          },
        }),
        refreshUnifiedIndex: ingestedUnifiedIndex(),
        readAccountingCache: fixture.read,
        refreshAccounting: async () => {
          rebuilds += 1;
          return {
            generatedAt: "2026-07-23T12:00:00.000Z",
            periods: [{ id: "7d", events: 23 }],
            diagnostics: { forkReplayEventsExcluded: 31 },
            sourceDescriptor: UNIFIED_SOURCE_DESCRIPTOR,
          };
        },
      });

      const result = await runner();

      assert.equal(rebuilds, 1);
      assert.deepEqual(result.accounting, {
        status: "replay_safe",
        ...INTERNAL_UNIFIED_ACCOUNTING_AUTHORITY,
        refreshStatus: "rebuilt",
        generatedAt: "2026-07-23T12:00:00.000Z",
        events: 23,
        forkReplayEventsExcluded: 31,
      });
    });
  }
});

test("a quota-only refresh reuses current accounting while retaining fresh quota evidence", async () => {
  let cacheReads = 0;
  let rebuilds = 0;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      refresh: { attempted: true, recordWritten: true, errorCode: null },
    }),
    refreshUnifiedIndex: ingestedUnifiedIndex(),
    readAccountingCache: async () => {
      cacheReads += 1;
      return {
        status: "available",
        errorCode: null,
        cache: REUSABLE_ACCOUNTING_CACHE,
      };
    },
    refreshAccounting: async () => {
      rebuilds += 1;
      throw new Error("quota-only collection must not rebuild token accounting");
    },
  });

  const result = await runner();

  assert.equal(cacheReads, 1);
  assert.equal(rebuilds, 0);
  assert.equal(result.accounting.refreshStatus, "reused");
  assert.deepEqual(result.quotaRefresh, {
    attempted: true,
    recordWritten: true,
    errorCode: null,
  });
});

test("a memory-budget rebuild miss serves the retained cache, reports deferred, and backs off", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "local-refresh-budget-state-"));
  const stateFile = join(stateRoot, "local-collector-state.sqlite");
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  let nowMs = Date.parse("2026-07-23T12:00:00.000Z");
  const clock = () => nowMs;
  let rebuildAttempts = 0;
  let deferForNextRebuild = true;
  const runner = createLocalCollectorRefreshRunner({
    stateFile,
    clock,
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({
      // New rollout usage: token accounting genuinely warrants a rebuild.
      rolloutRecordsWritten: 5,
      filesDiscovered: 3,
      refresh: { attempted: true, recordWritten: false, errorCode: null },
    }),
    refreshUnifiedIndex: ingestedUnifiedIndex(),
    readAccountingCache: async () => ({
      status: "available",
      errorCode: null,
      cache: REUSABLE_ACCOUNTING_CACHE,
    }),
    refreshAccounting: async () => {
      rebuildAttempts += 1;
      if (deferForNextRebuild) {
        return {
          status: "accounting_rebuild_deferred",
          reason: "accounting_transition_rss_limit_exceeded",
          retained: true,
          generatedAt: REUSABLE_ACCOUNTING_CACHE.generatedAt,
          coveredAt: REUSABLE_ACCOUNTING_CACHE.coveredAt,
        };
      }
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [{ id: "7d", events: 41 }],
        diagnostics: { forkReplayEventsExcluded: 3 },
        sourceDescriptor: UNIFIED_SOURCE_DESCRIPTOR,
      };
    },
  });

  // First pass: the rebuild is attempted, misses budget, and the retained
  // cache is served as a labelled "deferred" estimate — the refresh does NOT
  // fail.
  const first = await runner();
  assert.equal(rebuildAttempts, 1);
  assert.deepEqual(first.accounting, {
    status: "replay_safe",
    ...INTERNAL_UNIFIED_ACCOUNTING_AUTHORITY,
    refreshStatus: "deferred",
    generatedAt: "2026-07-23T10:00:00.000Z",
    events: 17,
    forkReplayEventsExcluded: 29,
  });
  assert.deepEqual(first.accountingRebuildDeferred, {
    reason: "accounting_transition_rss_limit_exceeded",
    retained: true,
    consecutive: 1,
  });

  // Second pass a minute later, still within the backoff window: the doomed
  // full rebuild is skipped entirely and the retained cache is served again.
  // A backoff pass attempts nothing, so it neither reports a deferral nor
  // advances the streak.
  nowMs += 60_000;
  const second = await runner();
  assert.equal(rebuildAttempts, 1);
  assert.equal(second.accounting.refreshStatus, "deferred");
  assert.equal(second.accountingRebuildDeferred, undefined);

  // Once the backoff elapses the rebuild is re-attempted and misses again:
  // the streak counts consecutive ATTEMPTS, across backoff windows.
  nowMs += 31 * 60_000;
  const stillDeferred = await runner();
  assert.equal(rebuildAttempts, 2);
  assert.deepEqual(stillDeferred.accountingRebuildDeferred, {
    reason: "accounting_transition_rss_limit_exceeded",
    retained: true,
    consecutive: 2,
  });

  // Once the backoff elapses the full rebuild is re-attempted; now it fits and
  // succeeds, and the backoff is cleared so later passes rebuild immediately.
  nowMs += 31 * 60_000;
  deferForNextRebuild = false;
  const third = await runner();
  assert.equal(rebuildAttempts, 3);
  assert.equal(third.accounting.refreshStatus, "rebuilt");
  assert.equal(third.accounting.events, 41);
  assert.equal(third.accountingRebuildDeferred, undefined);

  const fourth = await runner();
  assert.equal(rebuildAttempts, 4);
  assert.equal(fourth.accounting.refreshStatus, "rebuilt");

  // A later miss starts a fresh streak: the successful rebuild reset it.
  deferForNextRebuild = true;
  const fifth = await runner();
  assert.equal(rebuildAttempts, 5);
  assert.deepEqual(fifth.accountingRebuildDeferred, {
    reason: "accounting_transition_rss_limit_exceeded",
    retained: true,
    consecutive: 1,
  });
});

test("zero-write budget backoff keeps an expired accounting result deferred", async () => {
  let nowMs = Date.parse("2026-07-23T12:00:00.000Z");
  let rebuilds = 0;
  const runner = createLocalCollectorRefreshRunner({
    clock: () => nowMs,
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({ rolloutRecordsWritten: 0, filesDiscovered: 0,
      refresh: { attempted: false, recordWritten: false, errorCode: null } }),
    refreshUnifiedIndex: ingestedUnifiedIndex(),
    readAccountingCache: async ({ maximumAgeMs = null }) => ({
      status: maximumAgeMs === null ? "available" : "stale",
      cache: REUSABLE_ACCOUNTING_CACHE,
    }),
    refreshAccounting: async () => {
      rebuilds++;
      return { status: "accounting_rebuild_deferred",
        reason: "accounting_transition_rss_limit_exceeded", retained: true };
    },
  });
  assert.equal((await runner()).accounting.refreshStatus, "deferred");
  nowMs += 60_000;
  const second = await runner();
  assert.equal(second.accounting.refreshStatus, "deferred");
  assert.equal(second.accounting.generatedAt, REUSABLE_ACCOUNTING_CACHE.generatedAt);
  assert.equal(rebuilds, 1);
});

test("budget backoff serves a real prior-generation cache only as deferred", async t => {
  const workspace = createWorkspace({ files: 1, events: 5, days: 1 });
  t.after(() => workspace.cleanup());
  const indexFile = join(workspace.state, "index.sqlite");
  const stateFile = join(workspace.state, "collector.sqlite");
  let nowMs = Date.parse("2026-09-01T01:00:00.000Z");
  await refreshLocalIndex({ codexHome: workspace.codexHome, indexFile,
    secretFile: workspace.secretFile, workerCount: 1 });
  const oldGeneration = readLocalIndexGenerationIdentity({ indexFile });
  const cache = await buildLocalIndexAccountingCache({ indexFile,
    codexHome: workspace.codexHome, expectedGeneration: oldGeneration, now: () => nowMs });
  await writeLocalCollectorAccountingCache({ stateFile, cache });
  const database = new DatabaseSync(indexFile);
  try {
    database.exec("BEGIN; UPDATE source SET mtime_ms=mtime_ms+1; UPDATE store_state SET commit_seq=commit_seq+1 WHERE id=1; COMMIT");
  } finally { database.close(); }
  const generation = readLocalIndexGenerationIdentity({ indexFile });
  assert.notEqual(generation.fingerprint, oldGeneration.fingerprint);
  let writes = 1, rebuilds = 0;
  const runner = createLocalCollectorRefreshRunner({
    stateFile, unifiedIndexFile: indexFile, codexHome: workspace.codexHome,
    clock: () => nowMs,
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({ rolloutRecordsWritten: writes, filesDiscovered: 1,
      refresh: { attempted: false, recordWritten: false, errorCode: null } }),
    refreshUnifiedIndex: ingestedUnifiedIndex({ ...UNIFIED_GENERATION, ...generation }),
    refreshAccounting: async () => {
      rebuilds++;
      return { status: "accounting_rebuild_deferred",
        reason: "accounting_transition_rss_limit_exceeded", retained: true };
    },
  });
  for (let pass = 0; pass < 2; pass++) {
    const result = await runner();
    assert.equal(result.accounting.refreshStatus, "deferred");
    assert.equal(result.accounting.generationMatched, false);
    assert.equal(String(result.accounting.generation), String(oldGeneration.id));
    assert.equal(result.accounting.generationFingerprint, oldGeneration.fingerprint);
    assert.equal(result.accounting.generatedAt, cache.generatedAt);
    assert.equal(result.accounting.events, cache.periods.find(row => row.id === "7d").events);
    writes = 0;
    nowMs += 60_000;
  }
  assert.equal(rebuilds, 1);
  const stored = await readLocalCollectorAccountingCache({ stateFile });
  assert.deepEqual(stored.cache, cache, "backoff never republishes old calculations as a new generation");
});

test("a budget miss with no retained cache defers without fabricating an accounting block", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "local-refresh-empty-budget-state-"));
  const stateFile = join(stateRoot, "local-collector-state.sqlite");
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const runner = createLocalCollectorRefreshRunner({
    stateFile,
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({
      rolloutRecordsWritten: 5,
      filesDiscovered: 3,
      refresh: { attempted: true, recordWritten: false, errorCode: null },
    }),
    refreshUnifiedIndex: ingestedUnifiedIndex(),
    readAccountingCache: async () => ({
      status: "unavailable",
      errorCode: "cache_missing",
      cache: null,
    }),
    refreshAccounting: async () => ({
      status: "accounting_rebuild_deferred",
      reason: "accounting_transition_rss_limit_exceeded",
      retained: false,
      generatedAt: null,
      coveredAt: null,
    }),
  });

  const result = await runner();
  // No cache to serve -> no accounting block is invented, but the run still
  // succeeds and reports the deferred outcome honestly.
  // The unified block is an explicit unavailable status, never a replay-safe
  // estimate with invented totals.
  assert.equal(result.accounting.status, "unavailable");
  assert.equal(Object.hasOwn(result.accounting, "events"), false);
  assert.equal(Object.hasOwn(result.accounting, "refreshStatus"), false);
  assert.deepEqual(result.accountingRebuildDeferred, {
    reason: "accounting_transition_rss_limit_exceeded",
    retained: false,
    consecutive: 1,
  });
});

test("the deferred accounting rebuild recorder files one bounded, rate-limited note", async () => {
  const notes = [];
  let nowMs = 1_000;
  const record = createDeferredAccountingRebuildRecorder({
    recordNote: async (note) => { notes.push(note); },
    clock: () => nowMs,
    randomIndex: () => 0,
  });

  assert.equal(
    await record({
      reason: "accounting_transition_rss_limit_exceeded",
      retained: true,
    }),
    true,
  );
  assert.deepEqual(notes, [{
    reference: "TT-000000",
    surface: "local_refresh",
    code: "accounting_rebuild_deferred",
    requestId: "",
    step: "accounting",
    detail: "accounting_transition_rss_limit_exceeded",
  }]);

  // The same signature within the hour is suppressed so a backed-off scheduler
  // loop cannot become a write storm.
  assert.equal(
    await record({
      reason: "accounting_transition_rss_limit_exceeded",
      retained: true,
    }),
    false,
  );
  assert.equal(notes.length, 1);

  // An hour later the same signature lands again.
  nowMs += 60 * 60 * 1_000;
  assert.equal(
    await record({
      reason: "accounting_transition_rss_limit_exceeded",
      retained: true,
    }),
    true,
  );
  assert.equal(notes.length, 2);

  // A free-text reason is dropped rather than written; the note stays bounded.
  nowMs += 60 * 60 * 1_000;
  await record({ reason: "free text / with spaces", retained: true });
  assert.equal(notes.at(-1).detail, undefined);
});

test("the controller files a degraded note, not a terminal one, for a soft budget miss", async () => {
  let reloads = 0;
  let terminalCalls = 0;
  const degraded = [];
  const controller = new LocalCompanionRefreshController({
    runner: async () => ({
      rolloutRecordsWritten: 0,
      accountingRebuildDeferred: {
        reason: "accounting_transition_rss_limit_exceeded",
        retained: true,
      },
    }),
    dataStore: { async reload() { reloads += 1; } },
    onTerminalFailure: () => { terminalCalls += 1; },
    onDegradedOutcome: (outcome) => { degraded.push(outcome); },
  });

  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "succeeded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  // A budget miss is a SOFT success: the dashboard was reloaded (retained cache
  // served), no terminal failure was filed, and the degraded note fired once.
  assert.equal(status.status, "succeeded");
  assert.equal(status.errorCode, null);
  assert.equal(reloads, 1);
  assert.equal(terminalCalls, 0);
  assert.deepEqual(degraded, [{
    reason: "accounting_transition_rss_limit_exceeded",
    retained: true,
  }]);
  assert.deepEqual(status.result.accountingRebuildDeferred, {
    status: "deferred",
    reason: "accounting_transition_rss_limit_exceeded",
    retained: true,
    // The runner in this harness reports no streak, so the projection
    // presents the one attempt it is looking at.
    consecutive: 1,
  });
});

test("local refresh rebuilds when rollout usage changes or no definitive count is reported", async (t) => {
  const cases = [
    {
      name: "rollout record written",
      collector: {
        rolloutRecordsWritten: 1,
        refresh: { attempted: false, recordWritten: false, errorCode: null },
      },
    },
    {
      name: "rollout write count missing",
      collector: {
        refresh: { attempted: false, recordWritten: false, errorCode: null },
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      let cacheReads = 0;
      let rebuilds = 0;
      const runner = createLocalCollectorRefreshRunner({
        selectAccountObservationSecret: () => ({
          loadAccountObservationSecret: null,
        }),
        runCollector: async () => fixture.collector,
        refreshUnifiedIndex: ingestedUnifiedIndex(),
        readAccountingCache: async () => {
          cacheReads += 1;
          return {
            status: "available",
            errorCode: null,
            cache: REUSABLE_ACCOUNTING_CACHE,
          };
        },
        refreshAccounting: async () => {
          rebuilds += 1;
          return {
            generatedAt: "2026-07-23T12:00:00.000Z",
            periods: [],
            diagnostics: {},
            sourceDescriptor: UNIFIED_SOURCE_DESCRIPTOR,
          };
        },
      });

      const result = await runner();

      assert.equal(cacheReads, 0);
      assert.equal(rebuilds, 1);
      assert.equal(result.accounting.refreshStatus, "rebuilt");
    });
  }
});

test("local refresh forwards its AbortSignal into replay-safe accounting", async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), "local-refresh-abort-state-"));
  const stateFile = join(stateRoot, "local-collector-state.sqlite");
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const controller = new AbortController();
  const clock = () => Date.parse("2026-07-23T12:00:00.000Z");
  let accountingOptions;
  const runner = createLocalCollectorRefreshRunner({
    codexHome: "/private/codex-home",
    stateFile,
    unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
    clock,
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: async () => Buffer.alloc(32, 8),
    }),
    refreshUnifiedIndex: ingestedUnifiedIndex(),
    runCollector: async () => ({
      rolloutRecordsWritten: 2,
      filesDiscovered: 3,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
      },
      indexing: COMPLETE_INDEX,
    }),
    refreshAccounting: async (options) => {
      accountingOptions = options;
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [{ id: "7d", events: 17 }],
        diagnostics: { forkReplayEventsExcluded: 29 },
        sourceDescriptor: UNIFIED_SOURCE_DESCRIPTOR,
      };
    },
  });

  const result = await runner({ signal: controller.signal });

  assert.equal(accountingOptions.codexHome, "/private/codex-home");
  assert.equal(accountingOptions.stateFile, stateFile);
  assert.equal(accountingOptions.now, clock);
  // Re-pinned 93 -> 365 (2026-08-08): the standing owner rule forbids
  // convenience-sized history windows (31 and 93 were both wrong). The
  // calibration corpus no longer follows this window at all when the unified
  // index is present, so the rebuild also receives the index path.
  assert.equal(accountingOptions.windowDays, 365);
  assert.equal(
    accountingOptions.unifiedIndexFile,
    "/private/local-unified-index-v1.sqlite",
  );
  assert.equal(accountingOptions.signal, controller.signal);
  assert.deepEqual(result.accounting, {
    status: "replay_safe",
    ...INTERNAL_UNIFIED_ACCOUNTING_AUTHORITY,
    refreshStatus: "rebuilt",
    generatedAt: "2026-07-23T12:00:00.000Z",
    events: 17,
    forkReplayEventsExcluded: 29,
  });
});

// The unified-index increment must land BEFORE the accounting rebuild: the
// rebuild sources its full-history calibration corpus from that index, so the
// old order left the calibration one refresh behind the collection it
// belonged to.
test("the unified index advances before accounting reads it for calibration", async () => {
  const order = [];
  const runner = createLocalCollectorRefreshRunner({
    unifiedIndexFile: "/private/local-unified-index-v1.sqlite",
    unifiedIndexSecretFile: "/private/local-unified-index-device-salt-v1",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 1,
      filesDiscovered: 1,
      refresh: { attempted: true, recordWritten: true, errorCode: null },
      indexing: COMPLETE_INDEX,
    }),
    refreshUnifiedIndex: async (options) => {
      order.push(["unified_index", options.indexFile, options.secretFile]);
      return {
        status: "ingested",
        generation: {
          id: 1,
          fingerprint: "b".repeat(64),
          status: "complete",
          discoveryComplete: true,
          diagnosticsComplete: true,
          usageProvenanceComplete: true,
          sourceOrderComplete: true,
          quotaProvenanceComplete: true,
          toolProvenanceComplete: true,
        },
        sources: 1,
        sourcesTouched: 1,
        insertedUsageEvents: 1,
        totalUsageEvents: 1,
        bytesScanned: 10,
        wallMs: 1,
      };
    },
    refreshAccounting: async () => {
      order.push(["accounting"]);
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [],
        diagnostics: {},
        sourceDescriptor: { fallbackCount: 0 },
      };
    },
  });

  const result = await runner();

  assert.deepEqual(order.map(([step]) => step), ["unified_index", "accounting"]);
  assert.deepEqual(order[0].slice(1), [
    "/private/local-unified-index-v1.sqlite",
    "/private/local-unified-index-device-salt-v1",
  ]);
  assert.equal(result.unifiedIndex.status, "ingested");
  assert.equal(result.accounting.refreshStatus, "rebuilt");
});

test("an aborted zero-write refresh does not bypass accounting cancellation through reuse", async () => {
  const controller = new AbortController();
  let cacheReads = 0;
  let accountingSignal;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 0,
      filesDiscovered: 3,
      refresh: {
        attempted: false,
        recordWritten: false,
        errorCode: null,
      },
    }),
    refreshUnifiedIndex: async () => {
      // Cancellation lands while the index step runs. The accounting step must
      // observe the aborted signal rather than reuse the cache.
      controller.abort();
      return { status: "ingested", generation: UNIFIED_GENERATION };
    },
    readAccountingCache: async () => {
      cacheReads += 1;
      return {
        status: "available",
        errorCode: null,
        cache: REUSABLE_ACCOUNTING_CACHE,
      };
    },
    refreshAccounting: async ({ signal }) => {
      accountingSignal = signal;
      const error = new Error("accounting_refresh_aborted");
      error.name = "AbortError";
      throw error;
    },
  });

  await assert.rejects(
    runner({ signal: controller.signal }),
    { name: "AbortError", message: "accounting_refresh_aborted" },
  );
  assert.equal(cacheReads, 0);
  assert.equal(accountingSignal, controller.signal);
});

test("local refresh publishes a quick-result boundary before deep accounting", async () => {
  const progress = [];
  let accountingStartedAfterQuickResult = false;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 2,
      filesDiscovered: 9,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
      },
      indexing: COMPLETE_INDEX,
    }),
    refreshUnifiedIndex: ingestedUnifiedIndex(),
    refreshAccounting: async () => {
      accountingStartedAfterQuickResult =
        progress[0]?.phase === "quick_result"
        && progress[1]?.kind === "unified_index"
        && progress.at(-1)?.kind === "accounting";
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [{ id: "7d", events: 17 }],
        diagnostics: { forkReplayEventsExcluded: 29 },
        sourceDescriptor: UNIFIED_SOURCE_DESCRIPTOR,
      };
    },
  });

  const result = await runner({
    onProgress: async (value) => {
      progress.push(value);
    },
  });

  assert.equal(accountingStartedAfterQuickResult, true);
  // Deep ingestion's own progress replaces the quick-result phase before the
  // accounting rebuild; the quick result remains the first publication.
  assert.equal(progress.length, 3);
  assert.deepEqual(progress[0], {
    ...COMPLETE_INDEX,
    phase: "quick_result",
  });
  assert.deepEqual(progress[1], UNIFIED_DEEP_START_PROGRESS);
  assert.deepEqual(progress[2], UNIFIED_ACCOUNTING_CALCULATING_PROGRESS);
  assert.equal(result.accounting.refreshStatus, "rebuilt");
});

test("unified-index progress replaces quick result with bounded deep counts", async () => {
  const progress = [];
  const generation = {
    id: 19,
    fingerprint: "deep-progress-generation",
    status: "complete",
    discoveryComplete: true,
    diagnosticsComplete: true,
    usageProvenanceComplete: true,
    sourceOrderComplete: true,
    quotaProvenanceComplete: true,
    toolProvenanceComplete: true,
  };
  const runner = createLocalCollectorRefreshRunner({
    codexHome: "/private/codex-home",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 1,
      filesDiscovered: 9,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
      },
      indexing: COMPLETE_INDEX,
    }),
    refreshUnifiedIndex: async ({ onProgress }) => {
      await onProgress({
        sources: 12,
        sourcesScanned: 4,
        usageEvents: 27,
        sourceBytes: 8_000,
        privatePath: "/private/must-not-escape",
      });
      return { status: "ingested", generation };
    },
  });

  await runner({ onProgress: (value) => progress.push(value) });

  assert.deepEqual(progress, [
    { ...COMPLETE_INDEX, phase: "quick_result" },
    {
      kind: "unified_index",
      status: "scanning",
      phase: "rollout_index",
      filesDiscovered: 0,
      filesSelected: 0,
      filesProcessed: 0,
      recordsWritten: 0,
    },
    {
      kind: "unified_index",
      status: "scanning",
      phase: "rollout_index",
      filesDiscovered: 12,
      filesSelected: 12,
      filesProcessed: 4,
      recordsWritten: 27,
    },
  ]);
  assert.equal(JSON.stringify(progress).includes("must-not-escape"), false);
  assert.equal(JSON.stringify(progress).includes("sourceBytes"), false);
});

test("unified-index progress rejects malformed and broadened payloads", async () => {
  const progress = [];
  const runner = createLocalCollectorRefreshRunner({
    codexHome: "/private/codex-home",
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 1,
      filesDiscovered: 9,
      refresh: { attempted: true, recordWritten: true, errorCode: null },
      indexing: COMPLETE_INDEX,
    }),
    refreshUnifiedIndex: async ({ onProgress }) => {
      const valid = {
        kind: "unified_index",
        status: "scanning",
        phase: "rollout_index",
        filesDiscovered: 12,
        filesSelected: 10,
        filesProcessed: 4,
        recordsWritten: 27,
      };
      await onProgress({ ...valid, privatePath: "/must/not/escape" });
      await onProgress({ ...valid, recordsWritten: -1 });
      await onProgress({ ...valid, filesSelected: 13 });
      await onProgress({ ...valid, filesProcessed: 11 });
      await onProgress(valid);
      return {
        status: "ingested",
        generation: {
          id: 20,
          fingerprint: "bounded-worker-progress",
          status: "complete",
          discoveryComplete: true,
          diagnosticsComplete: true,
          usageProvenanceComplete: true,
          sourceOrderComplete: true,
          quotaProvenanceComplete: true,
          toolProvenanceComplete: true,
        },
      };
    },
  });

  await runner({ onProgress: (value) => progress.push(value) });
  assert.deepEqual(progress.slice(-1), [{
    kind: "unified_index",
    status: "scanning",
    phase: "rollout_index",
    filesDiscovered: 12,
    filesSelected: 10,
    filesProcessed: 4,
    recordsWritten: 27,
  }]);
  assert.equal(progress.length, 3);
});

test("seven changed sources hand off to accounting until the full snapshot is published", async (t) => {
  const scanSeen = Promise.withResolvers();
  const releaseScan = Promise.withResolvers();
  const accountingSeen = Promise.withResolvers();
  const releaseAccounting = Promise.withResolvers();
  const projectionSeen = Promise.withResolvers();
  const releaseProjection = Promise.withResolvers();
  const reloadPurposes = [];
  const accountingProgress = { kind: "accounting", status: "calculating" };
  t.after(() => {
    releaseScan.resolve();
    releaseAccounting.resolve();
    releaseProjection.resolve();
  });
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({
      rolloutRecordsWritten: 1,
      filesDiscovered: 9,
      refresh: { attempted: true, recordWritten: true, errorCode: null },
      indexing: COMPLETE_INDEX,
    }),
    refreshUnifiedIndex: async ({ onProgress }) => {
      await onProgress({ sources: 7_215, sourcesScanned: 7, usageEvents: 27 });
      scanSeen.resolve();
      await releaseScan.promise;
      return {
        status: "ingested",
        generation: {
          id: 21,
          fingerprint: "synthetic-accounting-handoff",
          status: "complete",
          discoveryComplete: true,
          diagnosticsComplete: true,
          usageProvenanceComplete: true,
          sourceOrderComplete: true,
          quotaProvenanceComplete: true,
          toolProvenanceComplete: true,
        },
      };
    },
    refreshAccounting: async () => {
      accountingSeen.resolve();
      await releaseAccounting.promise;
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [{ id: "7d", events: 17 }],
        diagnostics: {},
        sourceDescriptor: { fallbackCount: 0 },
      };
    },
  });
  const controller = new LocalCompanionRefreshController({
    runner,
    dataStore: {
      async reload({ purpose }) {
        reloadPurposes.push(purpose);
        if (purpose === "full") {
          projectionSeen.resolve();
          await releaseProjection.promise;
        }
      },
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  await scanSeen.promise;
  const scanning = controller.getStatus();
  assert.equal(scanning.status, "running");
  assert.equal(scanning.progress.filesProcessed, 7);
  assert.equal(scanning.progress.filesSelected, 7_215);
  assert.deepEqual(reloadPurposes, ["quick"]);

  releaseScan.resolve();
  await accountingSeen.promise;
  const calculating = controller.getStatus();
  assert.equal(calculating.status, "running");
  assert.deepEqual(calculating.progress, accountingProgress);
  assert.equal(calculating.quickResultAt, scanning.quickResultAt);
  assert.equal(calculating.finishedAt, null);
  assert.equal(calculating.result, null);
  assert.deepEqual(reloadPurposes, ["quick"], "stage handoff does not reload a second quick result");

  releaseAccounting.resolve();
  await projectionSeen.promise;
  const projecting = controller.getStatus();
  assert.equal(projecting.status, "running");
  assert.deepEqual(projecting.progress, accountingProgress);
  assert.equal(projecting.finishedAt, null);
  assert.equal(projecting.result, null);
  assert.deepEqual(reloadPurposes, ["quick", "full"]);

  releaseProjection.resolve();
  for (let attempt = 0; attempt < 100 && controller.isRunning(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const finished = controller.getStatus();
  assert.equal(finished.status, "succeeded");
  assert.deepEqual(finished.progress, COMPLETE_INDEX);
  assert.equal(finished.result.accounting.status, "replay_safe");
  assert.deepEqual(reloadPurposes, ["quick", "full"]);
});

test("accounting progress accepts only its exact count-free work marker", async (t) => {
  const ready = Promise.withResolvers();
  const release = Promise.withResolvers();
  let publish;
  const reloadPurposes = [];
  t.after(() => release.resolve({}));
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      publish = onProgress;
      ready.resolve();
      return release.promise;
    },
    dataStore: { async reload({ purpose }) { reloadPurposes.push(purpose); } },
  });
  assert.equal(controller.start(), true);
  await ready.promise;
  const valid = { kind: "accounting", status: "calculating" };
  await publish(valid);
  for (const invalid of [
    { kind: "accounting" },
    { ...valid, status: "complete" },
    { ...valid, status: "quick_result" },
    { ...valid, phase: "quick_result" },
    { ...valid, filesProcessed: 0, filesSelected: 0 },
    { ...valid, sources: 7_215, sourcesScanned: 7 },
    { ...valid, message: "synthetic unreviewed text" },
    { ...COMPLETE_INDEX, ...valid, phase: "quick_result" },
  ]) {
    await publish(invalid);
    assert.deepEqual(controller.getStatus().progress, valid);
    assert.equal(controller.getStatus().status, "running");
    assert.equal(controller.getStatus().quickResultAt, null);
    assert.deepEqual(reloadPurposes, []);
  }
  release.resolve({});
  for (let attempt = 0; attempt < 100 && controller.isRunning(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(controller.getStatus().status, "succeeded");
  assert.equal(controller.getStatus().progress, null);
  assert.deepEqual(reloadPurposes, ["full"]);
});

test("an exact accounting rebuild marker extends the ordinary deadline once to the cold-work bound", async (t) => {
  const timers = createManualTimerScheduler();
  const entered = Promise.withResolvers();
  const settled = Promise.withResolvers();
  let publish;
  let signal;
  t.after(() => settled.resolve({}));
  const controller = new LocalCompanionRefreshController({
    runner: async ({ signal: activeSignal, onProgress }) => {
      signal = activeSignal;
      publish = onProgress;
      entered.resolve();
      return settled.promise;
    },
    dataStore: { async reload() {} },
    timeoutMs: 1_000,
    accountingTimeoutMs: 1_500,
    monotonicClock: timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  assert.equal(controller.start(), true);
  await entered.promise;
  // The first marker arrives close to the ordinary deadline. It grants a
  // 1,500 ms total-from-start bound, not another 1,500 ms from this point.
  timers.advanceBy(900);
  await publish({ kind: "accounting", status: "calculating" });
  timers.advanceBy(300);
  // Repeated and future-shaped markers cannot move the total deadline again.
  await publish({ kind: "accounting", status: "calculating" });
  await publish({
    kind: "accounting",
    status: "calculating",
    privateUnreviewedField: true,
  });
  timers.advanceBy(299);
  assert.equal(controller.getStatus().status, "running");
  assert.equal(signal.aborted, false);

  timers.advanceBy(1);
  assert.equal(controller.getStatus().status, "failed");
  assert.equal(controller.getStatus().errorCode, "refresh_timed_out");
  assert.equal(signal.aborted, true);
  settled.resolve({});
  await flushControllerSettlement(controller);
  assert.equal(controller.getStatus().status, "failed");
});

test("a late accounting marker cannot extend work after cancellation", async (t) => {
  const timers = createManualTimerScheduler();
  const entered = Promise.withResolvers();
  const settled = Promise.withResolvers();
  let publish;
  let signal;
  t.after(() => settled.resolve({}));
  const controller = new LocalCompanionRefreshController({
    runner: async ({ signal: activeSignal, onProgress }) => {
      signal = activeSignal;
      publish = onProgress;
      entered.resolve();
      return settled.promise;
    },
    dataStore: { async reload() {} },
    timeoutMs: 1_000,
    accountingTimeoutMs: 1_500,
    cancelSettlementMs: 1_000,
    monotonicClock: timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  assert.equal(controller.start(), true);
  await entered.promise;
  assert.equal(controller.cancel(), true);
  assert.equal(signal.aborted, true);
  await publish({ kind: "accounting", status: "calculating" });
  timers.advanceBy(999);
  assert.equal(controller.getStatus().status, "cancelling");
  assert.equal(controller.isRunning(), true);

  timers.advanceBy(1);
  await flushControllerSettlement(controller);
  assert.equal(controller.getStatus().status, "cancelled");
  assert.equal(controller.getStatus().errorCode, "refresh_cancelled");
  assert.equal(controller.isRunning(), false);

  settled.resolve({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getStatus().status, "cancelled");
});

test("the cancellation watchdog releases an abort-ignoring accounting run without clobbering its successor", async (t) => {
  const timers = createManualTimerScheduler();
  const firstEntered = Promise.withResolvers();
  const firstSettled = Promise.withResolvers();
  const secondEntered = Promise.withResolvers();
  const secondSettled = Promise.withResolvers();
  let firstPublish;
  let firstSignal;
  let runs = 0;
  let reloads = 0;
  t.after(() => {
    firstSettled.resolve({});
    secondSettled.resolve({});
  });
  const controller = new LocalCompanionRefreshController({
    runner: async ({ signal, onProgress }) => {
      runs += 1;
      if (runs === 1) {
        firstSignal = signal;
        firstPublish = onProgress;
        await onProgress({ kind: "accounting", status: "calculating" });
        firstEntered.resolve();
        // Deliberately ignore AbortSignal: the controller must bound how long
        // this defective runner owns the foreground slot.
        return firstSettled.promise;
      }
      secondEntered.resolve();
      return secondSettled.promise;
    },
    dataStore: { async reload() { reloads += 1; } },
    timeoutMs: 1_000,
    accountingTimeoutMs: 4_000,
    cancelSettlementMs: 1_000,
    monotonicClock: timers.now,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  assert.equal(controller.start(), true);
  await firstEntered.promise;
  assert.equal(controller.cancel(), true);
  assert.equal(firstSignal.aborted, true);
  timers.advanceBy(999);
  assert.equal(controller.isRunning(), true);
  assert.equal(controller.getStatus().status, "cancelling");

  timers.advanceBy(1);
  await flushControllerSettlement(controller);
  assert.equal(controller.isRunning(), false);
  assert.equal(controller.getStatus().status, "cancelled");
  assert.equal(controller.getStatus().result, null);
  assert.equal(reloads, 0);

  assert.equal(controller.start(), true);
  await secondEntered.promise;
  const successorId = controller.getStatus().refreshId;
  assert.equal(controller.getStatus().status, "running");

  // A late progress callback and settlement from the detached first runner
  // belong to its old refresh generation. Neither may mutate or release the
  // successor's state or in-flight ownership.
  await firstPublish({ kind: "accounting", status: "calculating" });
  firstSettled.resolve({ indexing: COMPLETE_INDEX });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.isRunning(), true);
  assert.equal(controller.getStatus().refreshId, successorId);
  assert.equal(controller.getStatus().status, "running");
  assert.equal(controller.getStatus().progress, null);
  assert.equal(reloads, 0);

  secondSettled.resolve({ indexing: COMPLETE_INDEX });
  await flushControllerSettlement(controller);
  assert.equal(controller.getStatus().refreshId, successorId);
  assert.equal(controller.getStatus().status, "succeeded");
  assert.equal(reloads, 1);
});

test("accounting work markers never survive failure, cancellation, or timeout as running work", async (t) => {
  for (const outcome of ["failure", "cancel", "timeout"]) {
    await t.test(outcome, async (t) => {
      const entered = Promise.withResolvers();
      const settled = Promise.withResolvers();
      const reloadPurposes = [];
      let signal;
      t.after(() => settled.resolve({}));
      const controller = new LocalCompanionRefreshController({
        runner: async ({ signal: activeSignal, onProgress }) => {
          signal = activeSignal;
          await onProgress({ kind: "accounting", status: "calculating" });
          entered.resolve();
          return settled.promise;
        },
        dataStore: { async reload({ purpose }) { reloadPurposes.push(purpose); } },
        timeoutMs: 1_000,
        // This test owns terminal-state cleanup, not deadline extension; keep
        // its accounting bound equal to its deliberately tiny base timeout.
        accountingTimeoutMs: 1_000,
      });
      assert.equal(controller.start(), true);
      await entered.promise;
      assert.equal(controller.getStatus().status, "running");
      assert.deepEqual(controller.getStatus().progress, {
        kind: "accounting", status: "calculating",
      });
      if (outcome === "failure") {
        settled.reject(new Error("synthetic accounting failure"));
      } else if (outcome === "cancel") {
        assert.equal(controller.cancel(), true);
        assert.equal(controller.getStatus().status, "cancelling");
        settled.resolve({});
      } else {
        await new Promise((resolve) => setTimeout(resolve, 1_050));
        assert.equal(controller.getStatus().status, "failed");
        assert.equal(controller.getStatus().progress, null);
        settled.resolve({});
      }
      for (let attempt = 0; attempt < 100 && controller.isRunning(); attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const status = controller.getStatus();
      assert.equal(status.status, outcome === "cancel" ? "cancelled" : "failed");
      assert.equal(status.errorCode, {
        failure: "refresh_failed", cancel: "refresh_cancelled", timeout: "refresh_timed_out",
      }[outcome]);
      assert.equal(status.progress, null);
      assert.equal(status.quickResultAt, null);
      assert.equal(signal.aborted, outcome !== "failure");
      assert.deepEqual(reloadPurposes, []);
      assert.equal(JSON.stringify(status).includes("synthetic accounting failure"), false);
    });
  }
});

test("partial recent coverage publishes a quick result before deep accounting", async () => {
  const progress = [];
  let rebuilds = 0;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => ({
      rolloutRecordsWritten: 2,
      filesDiscovered: 9,
      refresh: {
        attempted: true,
        recordWritten: true,
        errorCode: null,
      },
      indexing: PARTIAL_INDEX,
    }),
    refreshUnifiedIndex: ingestedUnifiedIndex(),
    refreshAccounting: async () => {
      rebuilds += 1;
      assert.equal(progress[0]?.phase, "quick_result");
      assert.equal(progress.at(-1)?.kind, "accounting");
      return {
        generatedAt: "2026-07-23T12:00:00.000Z",
        periods: [{ id: "7d", events: 17 }],
        diagnostics: { forkReplayEventsExcluded: 29 },
        sourceDescriptor: UNIFIED_SOURCE_DESCRIPTOR,
      };
    },
  });

  const result = await runner({
    onProgress: async (value) => {
      progress.push(value);
    },
  });

  assert.equal(rebuilds, 1);
  assert.deepEqual(progress, [
    { ...PARTIAL_INDEX, phase: "quick_result" },
    UNIFIED_DEEP_START_PROGRESS,
    UNIFIED_ACCOUNTING_CALCULATING_PROGRESS,
  ]);
  assert.deepEqual(result.indexing, PARTIAL_INDEX);
  assert.equal(result.accounting.refreshStatus, "rebuilt");
});

test("a hard collector resource pause stops automatic continuation and preserves its headline", async () => {
  let collectorCalls = 0;
  let accountingCalls = 0;
  const progress = [];
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async () => {
      collectorCalls += 1;
      return {
        rolloutRecordsWritten: 0,
        filesDiscovered: 20_000,
        resourceLimit: {
          code: "collector_resource_directory_entries_limit_exceeded",
          dimension: "directory_entries",
          limit: 20_000,
          observed: 20_001,
        },
        refresh: {
          attempted: false,
          recordWritten: false,
          errorCode: null,
        },
        indexing: PAUSED_INDEX,
      };
    },
    refreshAccounting: async () => {
      accountingCalls += 1;
      throw new Error("resource-limited collection must not start accounting");
    },
  });

  await assert.rejects(
    runner({
      onProgress: async (value) => {
        progress.push(value);
      },
    }),
    (error) => error?.code === "collector_resource_limit_exceeded",
  );
  assert.equal(collectorCalls, 1);
  assert.equal(accountingCalls, 0);
  assert.deepEqual(progress, [{
    ...PAUSED_INDEX,
    phase: "quick_result",
  }]);
});

test("cancellation after the early headline does not start the normal continuation", async () => {
  const controller = new AbortController();
  let collectorCalls = 0;
  let accountingCalls = 0;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({
      loadAccountObservationSecret: null,
    }),
    runCollector: async ({ signal }) => {
      collectorCalls += 1;
      assert.equal(signal, controller.signal);
      return {
        rolloutRecordsWritten: 2,
        filesDiscovered: 9,
        refresh: {
          attempted: true,
          recordWritten: true,
          errorCode: null,
        },
        indexing: {
          ...PAUSED_INDEX,
          filesProcessed: 1,
          recordsWritten: 2,
        },
      };
    },
    refreshAccounting: async () => {
      accountingCalls += 1;
      throw new Error("cancelled headline must not start deep accounting");
    },
  });

  const result = await runner({
    signal: controller.signal,
    onProgress: async (value) => {
      if (value.phase === "quick_result") controller.abort();
    },
  });

  assert.equal(collectorCalls, 1);
  assert.equal(accountingCalls, 0);
  assert.equal(result.indexing.status, "bounded_pause");
  assert.equal(result.quotaRefresh.recordWritten, true);
});

test("refresh controller reloads a quick result while deep accounting continues", async () => {
  const reloads = [];
  let releaseAccounting;
  const accountingGate = new Promise((resolve) => {
    releaseAccounting = resolve;
  });
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      await onProgress({
        ...COMPLETE_INDEX,
        phase: "quick_result",
      });
      await accountingGate;
      return {
        rolloutRecordsWritten: 7,
        filesDiscovered: 9,
        quotaRefresh: {
          attempted: true,
          recordWritten: true,
          errorCode: null,
        },
        accounting: {
          status: "replay_safe",
          refreshStatus: "rebuilt",
          generatedAt: "2026-07-23T11:45:00.000Z",
          events: 17,
          forkReplayEventsExcluded: 29,
        },
        indexing: COMPLETE_INDEX,
      };
    },
    dataStore: {
      async reload(options) {
        reloads.push(options);
      },
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().quickResultAt !== null) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  const quick = controller.getStatus();
  assert.equal(quick.status, "running");
  assert.equal(quick.progress.phase, "quick_result");
  assert.equal(quick.quickResultAt, "2026-07-23T12:00:00.000Z");
  assert.equal(reloads.length, 1);

  releaseAccounting();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "succeeded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(controller.getStatus().status, "succeeded");
  assert.deepEqual(
    reloads.map(({ purpose, returnOverview }) => ({ purpose, returnOverview })),
    [
      { purpose: "quick", returnOverview: false },
      { purpose: "full", returnOverview: false },
    ],
  );
});

test("quick refresh skips the terminal reload after a published quick result", async () => {
  const reloads = [];
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      await onProgress({
        ...COMPLETE_INDEX,
        phase: "quick_result",
      });
      return { indexing: COMPLETE_INDEX };
    },
    dataStore: {
      async reload(options) {
        reloads.push(options);
      },
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start({ mode: "quick" }), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "succeeded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  assert.equal(status.status, "succeeded");
  assert.equal(status.quickResultAt, "2026-07-23T12:00:00.000Z");
  assert.deepEqual(
    reloads.map(({ purpose, returnOverview }) => ({ purpose, returnOverview })),
    [{ purpose: "quick", returnOverview: false }],
  );
});

test("quick refresh retries terminal reload after a failed quick-result publication", async () => {
  const reloads = [];
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      await onProgress({
        ...COMPLETE_INDEX,
        phase: "quick_result",
      });
      return { indexing: COMPLETE_INDEX };
    },
    dataStore: {
      async reload(options) {
        reloads.push(options);
        if (reloads.length === 1) throw new Error("quick snapshot unavailable");
      },
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start({ mode: "quick" }), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "succeeded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  assert.equal(status.status, "succeeded");
  assert.equal(status.quickResultAt, null);
  assert.deepEqual(
    reloads.map(({ purpose, returnOverview }) => ({ purpose, returnOverview })),
    [
      { purpose: "quick", returnOverview: false },
      { purpose: "quick", returnOverview: false },
    ],
  );
});

test("refresh controller keeps a bounded-pause headline observable after the pass settles", async () => {
  let reloads = 0;
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      await onProgress({
        ...PAUSED_INDEX,
        phase: "quick_result",
      });
      return {
        rolloutRecordsWritten: 5,
        filesDiscovered: 9,
        quotaRefresh: {
          attempted: true,
          recordWritten: true,
          errorCode: null,
        },
        indexing: PAUSED_INDEX,
      };
    },
    dataStore: {
      async reload() {
        reloads += 1;
      },
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "succeeded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  assert.equal(status.status, "succeeded");
  assert.equal(status.quickResultAt, "2026-07-23T12:00:00.000Z");
  assert.equal(status.progress.status, "bounded_pause");
  assert.equal(status.progress.phase, "quick_result");
  assert.equal(status.result.indexing.phase, "paused");
  assert.equal(reloads, 2);
});

test("refresh controller cancels bounded work without reloading deep state", async () => {
  let observedAbort = false;
  let reloads = 0;
  const controller = new LocalCompanionRefreshController({
    runner: ({ signal, onProgress }) => new Promise((resolve) => {
      onProgress({
        ...COMPLETE_INDEX,
        status: "recent_7d_indexing",
        phase: "rollout_index",
        filesProcessed: 1,
        recordsWritten: 2,
        coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
      });
      signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve({
          indexing: {
            ...COMPLETE_INDEX,
            status: "bounded_pause",
            phase: "paused",
            filesProcessed: 1,
            recordsWritten: 2,
            coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
          },
        });
      }, { once: true });
    }),
    dataStore: {
      async reload() {
        reloads += 1;
      },
    },
  });

  assert.equal(controller.start(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.cancel(), true);
  assert.equal(controller.cancel(), false);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "cancelled") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  assert.equal(observedAbort, true);
  assert.equal(status.status, "cancelled");
  assert.equal(status.errorCode, "refresh_cancelled");
  assert.equal(status.progress.status, "bounded_pause");
  assert.equal(status.progress.recordsWritten, 2);
  assert.equal(reloads, 0);
  assert.equal(controller.cancel(), false);
});

test("cancel during terminal projection aborts reload and cannot publish success", async () => {
  let projectionStarted;
  const enteredProjection = new Promise((resolve) => {
    projectionStarted = resolve;
  });
  let observedSignal = null;
  let reloadSettled = false;
  const controller = new LocalCompanionRefreshController({
    runner: async () => ({ indexing: COMPLETE_INDEX }),
    dataStore: {
      reload: ({ purpose, signal }) => new Promise((resolve, reject) => {
        assert.equal(purpose, "full");
        observedSignal = signal;
        projectionStarted();
        signal.addEventListener("abort", () => {
          reloadSettled = true;
          const error = new Error("local_companion_snapshot_reload_aborted");
          error.code = "local_companion_snapshot_reload_aborted";
          reject(error);
        }, { once: true });
      }),
    },
  });

  assert.equal(controller.start(), true);
  await enteredProjection;
  assert.equal(observedSignal?.aborted, false);
  assert.equal(controller.cancel(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!controller.isRunning()) break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(reloadSettled, true);
  assert.equal(observedSignal.aborted, true);
  assert.equal(controller.getStatus().status, "cancelled");
  assert.equal(controller.getStatus().errorCode, "refresh_cancelled");
});

test("refresh controller publishes bounded progress and reloads after success", async () => {
  let reloads = 0;
  const reloadOptions = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      onProgress({
        ...COMPLETE_INDEX,
        status: "recent_7d_indexing",
        phase: "rollout_index",
        filesProcessed: 2,
        recordsWritten: 5,
        coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
      });
      await gate;
      return {
        rolloutRecordsWritten: 7,
        filesDiscovered: 9,
        quotaRefresh: {
          attempted: true,
          recordWritten: false,
          errorCode: "temporary_disconnect",
        },
        accounting: {
          status: "replay_safe",
          sourceMode: "unified",
          refreshStatus: "reused",
          readerVersion: "replay-safe-reader-v1",
          compatibilityBehavior: "source_native",
          coverageStatus: "complete",
          generation: 8,
          generationFingerprint: `generation-v2-${"a".repeat(64)}`,
          generationMatched: true,
          fallbackCount: 0,
          diagnosticsAvailable: true,
          generatedAt: "2026-07-23T11:45:00.000Z",
          events: 17,
          forkReplayEventsExcluded: 29,
        },
        // The runner has already projected this descriptor once before the
        // controller applies the final HTTP-safe projection.
        unifiedIndex: {
          status: "ingested",
          unchanged: true,
          generation: {
            id: 8,
            fingerprint: `generation-v2-${"a".repeat(64)}`,
            status: "complete",
            blockReason: null,
            schemaVersion: "local-unified-index-v2",
            parserVersion: "unified-rollout-typed-v4",
            contractVersion: "telemetry-contribution-v0.1",
            coveredAt: {
              startAt: "2026-06-01T00:00:00.000Z",
              endAt: "2026-07-23T12:00:00.000Z",
            },
            sourceCount: 4_566,
            sourceBytes: 118_712_104_546,
            usageEvents: 560_047,
            quotaOccurrences: 778_963,
            discoveryComplete: true,
            diagnosticsComplete: true,
            usageProvenanceComplete: true,
            sourceOrderComplete: true,
            quotaProvenanceComplete: true,
            toolProvenanceComplete: true,
          },
        },
        indexing: COMPLETE_INDEX,
      };
    },
    dataStore: {
      async reload(options) {
        reloads += 1;
        reloadOptions.push(options);
      },
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getStatus().status, "running");
  assert.equal(controller.getStatus().progress.status, "recent_7d_indexing");
  release();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "degraded") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  assert.equal(status.status, "degraded");
  assert.equal(status.quota.status, "failed");
  assert.equal(status.usage.status, "reused");
  assert.equal(status.progress.status, "recent_7d_complete");
  assert.deepEqual(status.result.indexing, COMPLETE_INDEX);
  assert.deepEqual(status.result.accounting, {
    status: "replay_safe",
    sourceMode: "unified",
    refreshStatus: "reused",
    readerVersion: "replay-safe-reader-v1",
    compatibilityBehavior: "source_native",
    coverageStatus: "complete",
    generation: "8",
    generationFingerprint: `generation-v2-${"a".repeat(64)}`,
    generationMatched: true,
    fallbackCount: 0,
    diagnosticsAvailable: true,
    generatedAt: "2026-07-23T11:45:00.000Z",
    events: 17,
    forkReplayEventsExcluded: 29,
  });
  assert.deepEqual(status.result.unifiedIndex.generation.coveredAt, {
    startAt: "2026-06-01T00:00:00.000Z",
    endAt: "2026-07-23T12:00:00.000Z",
  });
  assert.equal(status.result.unifiedIndex.generation.sourceCount, 4_566);
  assert.equal(
    status.result.unifiedIndex.generation.sourceBytes,
    118_712_104_546,
  );
  assert.equal(reloads, 1);
  assert.deepEqual(reloadOptions[0].unifiedProjectionReuse, {
    generationFingerprint: `generation-v2-${"a".repeat(64)}`,
  });
});

test("refresh controller exposes only allowlisted unified-index failure codes", async () => {
  for (const fixture of [
    ...[
      "local_unified_index_publication_busy",
      "local_unified_index_publication_timed_out",
      "local_unified_index_publication_failed",
      "local_unified_index_model_recovery_stalled",
      "codex_response_usage_checkpoint_conflict",
      "codex_response_usage_invalid",
      "codex_response_usage_timestamp_invalid",
      "codex_response_usage_identity_invalid",
      "codex_response_usage_session_unattributed",
      "codex_response_usage_identity_conflict",
      "codex_response_usage_chain_incomplete",
      "codex_response_usage_legacy_conflict",
      "codex_response_usage_legacy_scope_unattributed",
      "codex_response_usage_resource_limit",
      "codex_response_usage_rescan_required",
      "local_index_aborted",
      "local_index_worker_failed",
      "local_index_wal_limit",
      "local_index_candidate_replay_required",
      "local_index_candidate_unfinished",
      "local_index_journal_mode_refused",
      "local_index_quarantine_invalid",
      "local_index_transaction_open",
      "local_index_transaction_required",
      "local_index_maintenance_failed",
      "local_index_maintenance_cancelled",
      "local_index_maintenance_deferred",
      "local_index_family_mismatch",
      "local_index_newer_version",
      "local_index_file_invalid",
      "local_index_unavailable",
      "local_index_secret_invalid",
      "local_index_secret_unavailable",
      "local_unified_index_legacy_ordinals_unavailable",
      "codex_rollout_source_changed",
    ].map((input) => ({ input, expected: input })),
    {
      input: "local_unified_index_file_changed",
      expected: "local_unified_index_file_changed",
    },
    {
      input: "local_unified_index_schema_newer",
      expected: "local_unified_index_schema_newer",
    },
    {
      input: "local_unified_index_private_path_detail",
      expected: "local_unified_index_refresh_failed",
    },
    {
      input: "Failed reading /Users/private/unified.sqlite",
      expected: "local_unified_index_refresh_failed",
    },
  ]) {
    const controller = new LocalCompanionRefreshController({
      runner: async () => ({
        unifiedIndex: {
          status: "failed",
          errorCode: fixture.input,
        },
      }),
      dataStore: { reload: async () => {} },
    });

    assert.equal(controller.start(), true);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (controller.getStatus().status === "succeeded") break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    const status = controller.getStatus();
    assert.equal(status.status, "degraded");
    assert.equal(status.errorCode, "refresh_degraded");
    assert.equal(status.failedStep, "unified_index");
    assert.equal(status.failureCode, fixture.expected);
    assert.equal(status.result.unifiedIndex.errorCode, fixture.expected);
    assert.equal(JSON.stringify(status).includes("/Users/private"), false);
  }
});

test("settled index, accounting and quota failures are recorded without changing their partial outcomes", async () => {
  for (const result of [
    { unifiedIndex: { status: "failed", errorCode: "codex_response_usage_legacy_conflict" } },
    { accounting: { status: "unavailable", errorCode: "accounting_unified_read_failed" } },
    { quotaRefresh: { attempted: true, errorCode: "app_server_unavailable" } },
  ]) {
    for (const brokenSink of [false, true]) {
      const notes = [];
      const controller = new LocalCompanionRefreshController({
        runner: async () => result, dataStore: { async reload() {} },
        onTerminalFailure: note => { notes.push(note);if (brokenSink) throw new Error('synthetic sink failure'); },
      });
      controller.start();await controller.whenSettled();
      const status = controller.getStatus();
      assert.equal(status.status, "degraded");
      assert.deepEqual(notes, [{ errorCode: "refresh_degraded", failedStep: status.failedStep,
        ...(status.failureCode === undefined ? {} : { failureCode: status.failureCode }) }]);
      if (result.quotaRefresh) assert.equal(notes[0].failureCode, 'app_server_unavailable');
      assert.equal(status.running, false);
    }
  }
});

test("parser failures keep their fixed code across the runner and stop accounting before publication", async () => {
  for (const code of ['codex_response_usage_legacy_conflict', 'codex_response_usage_identity_conflict',
    'codex_response_usage_chain_incomplete', 'codex_response_usage_invalid']) {
    let accountingCalls = 0;
    const runner = createLocalCollectorRefreshRunner({
      selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
      runCollector: async () => ({ rolloutRecordsWritten: 0, filesDiscovered: 0 }),
      refreshUnifiedIndex: async () => { const e = new Error('synthetic private detail');e.code = code;throw e; },
      refreshAccounting: async () => { accountingCalls++; },
    });
    const result = await runner({ mode: 'overview' });
    assert.equal(result.unifiedIndex.errorCode, code);
    assert.equal(accountingCalls, 0);
    assert.equal(JSON.stringify(result).includes('synthetic private detail'), false);
  }
});

test("refresh controller projects a fixed safety-limit state while retaining the quick result", async () => {
  let reloads = 0;
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      await onProgress({
        ...COMPLETE_INDEX,
        phase: "quick_result",
      });
      const error = new Error("private resource detail");
      error.code = "accounting_scan_source_bytes_limit_exceeded";
      throw error;
    },
    dataStore: {
      async reload() {
        reloads += 1;
      },
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "failed") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  assert.equal(status.status, "failed");
  assert.equal(status.errorCode, "refresh_resource_limited");
  assert.equal(status.progress.phase, "quick_result");
  assert.equal(status.quickResultAt, "2026-07-23T12:00:00.000Z");
  assert.equal(JSON.stringify(status).includes("private resource detail"), false);
  assert.equal(reloads, 1);
});

test("refresh controller reloads the full snapshot after the collector limit settles", async () => {
  const reloads = [];
  const controller = new LocalCompanionRefreshController({
    runner: async () => {
      const error = new Error("collector limit");
      error.code = "collector_resource_limit_exceeded";
      throw error;
    },
    dataStore: {
      async reload(options) {
        reloads.push(options);
      },
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "failed") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(controller.getStatus().status, "failed");
  assert.equal(controller.getStatus().errorCode, "refresh_resource_limited");
  assert.deepEqual(
    reloads.map(({ purpose, returnOverview }) => ({ purpose, returnOverview })),
    [{ purpose: "full", returnOverview: false }],
  );
});

test("refresh controller classifies transition-derivation limits as fixed safety stops", async () => {
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      await onProgress({
        ...COMPLETE_INDEX,
        phase: "quick_result",
      });
      const error = new Error("private transition detail");
      error.code = "accounting_transition_rss_limit_exceeded";
      throw error;
    },
    dataStore: {
      async reload() {},
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
  });

  assert.equal(controller.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (controller.getStatus().status === "failed") break;
    await new Promise((resolve) => setImmediate(resolve));
  }

  const status = controller.getStatus();
  assert.equal(status.status, "failed");
  assert.equal(status.errorCode, "refresh_resource_limited");
  assert.equal(status.progress.phase, "quick_result");
  assert.equal(status.quickResultAt, "2026-07-23T12:00:00.000Z");
  assert.equal(JSON.stringify(status).includes("private transition detail"), false);
});

test("refresh timeout aborts collector work without reloading deep state", async () => {
  let observedAbort = false;
  let reloads = 0;
  const controller = new LocalCompanionRefreshController({
    runner: ({ signal, onProgress }) => new Promise((resolve) => {
      onProgress({
        ...COMPLETE_INDEX,
        status: "recent_7d_indexing",
        phase: "rollout_index",
        filesProcessed: 1,
        recordsWritten: 2,
        coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
      });
      signal.addEventListener("abort", () => {
        observedAbort = true;
        resolve({
          indexing: {
            ...COMPLETE_INDEX,
            status: "bounded_pause",
            phase: "paused",
            filesProcessed: 1,
            recordsWritten: 2,
            coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
          },
        });
      }, { once: true });
    }),
    dataStore: {
      async reload() {
        reloads += 1;
      },
    },
    timeoutMs: 1_000,
  });

  assert.equal(controller.start(), true);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  const status = controller.getStatus();
  assert.equal(observedAbort, true);
  assert.equal(status.status, "failed");
  assert.equal(status.errorCode, "refresh_timed_out");
  assert.equal(status.progress.status, "bounded_pause");
  assert.equal(status.progress.recordsWritten, 2);
  assert.equal(status.result.indexing.status, "bounded_pause");
  assert.equal(reloads, 0);
  assert.equal(JSON.stringify(status).includes("/private/"), false);
});

test("a timed-out refresh cannot be reclassified as user-cancelled while settling", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onProgress }) => {
      await onProgress({
        ...COMPLETE_INDEX,
        status: "recent_7d_indexing",
        phase: "rollout_index",
        filesProcessed: 1,
        recordsWritten: 2,
        coveredAt: { ...COMPLETE_INDEX.coveredAt, endAt: null },
      });
      await gate;
      return { indexing: PAUSED_INDEX };
    },
    dataStore: {
      async reload() {},
    },
    timeoutMs: 1_000,
  });

  assert.equal(controller.getStatus().running, false);
  assert.equal(controller.start(), true);
  assert.equal(controller.getStatus().running, true);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal(controller.getStatus().status, "failed");
  assert.equal(controller.getStatus().errorCode, "refresh_timed_out");
  assert.equal(controller.isRunning(), true);
  assert.equal(controller.getStatus().running, true);
  assert.equal(controller.cancel(), false);

  release();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!controller.isRunning()) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(controller.getStatus().status, "failed");
  assert.equal(controller.getStatus().errorCode, "refresh_timed_out");
  assert.equal(controller.getStatus().running, false);
});

test("terminal refresh failures invoke the failure observer with bounded identity only", async () => {
  const observed = [];
  const failing = new LocalCompanionRefreshController({
    runner: async () => {
      const error = new Error("private failure detail /Users/private");
      error.code = "accounting_transition_rss_limit_exceeded";
      error.refreshStep = "accounting";
      throw error;
    },
    dataStore: {
      async reload() {},
    },
    clock: () => Date.parse("2026-07-23T12:00:00.000Z"),
    onTerminalFailure: (failure) => {
      observed.push(failure);
    },
  });

  assert.equal(failing.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (failing.getStatus().status === "failed") break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, [{
    errorCode: "refresh_resource_limited",
    failedStep: "accounting",
    failureCode: "accounting_transition_rss_limit_exceeded",
  }]);
  assert.equal(
    JSON.stringify(observed).includes("private failure detail"),
    false,
  );

  // Success never reaches the observer.
  const succeeded = [];
  const succeeding = new LocalCompanionRefreshController({
    runner: async () => ({}),
    dataStore: {
      async reload() {},
    },
    onTerminalFailure: (failure) => {
      succeeded.push(failure);
    },
  });
  assert.equal(succeeding.start(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!succeeding.isRunning()) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(succeeding.getStatus().status, "succeeded");
  assert.deepEqual(succeeded, []);

  // Cancellation is a user action, not a failure: no entry.
  const cancelled = [];
  const cancelling = new LocalCompanionRefreshController({
    runner: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
    dataStore: {
      async reload() {},
    },
    onTerminalFailure: (failure) => {
      cancelled.push(failure);
    },
  });
  assert.equal(cancelling.start(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelling.cancel(), true);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!cancelling.isRunning()) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(cancelling.getStatus().status, "cancelled");
  assert.deepEqual(cancelled, []);
});

test("a timed-out refresh files exactly one terminal failure entry, even after settling", async () => {
  const observed = [];
  const controller = new LocalCompanionRefreshController({
    runner: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        resolve({ indexing: PAUSED_INDEX });
      }, { once: true });
    }),
    dataStore: {
      async reload() {},
    },
    timeoutMs: 1_000,
    onTerminalFailure: (failure) => {
      observed.push(failure);
    },
  });

  assert.equal(controller.start(), true);
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal(controller.getStatus().status, "failed");
  assert.equal(controller.getStatus().errorCode, "refresh_timed_out");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!controller.isRunning()) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  // The timer filed the entry the moment the failure became terminal; the
  // later settlement of the same run must not file a second one.
  assert.deepEqual(observed, [{ errorCode: "refresh_timed_out" }]);
});

test("terminal refresh failure notes are bounded, step-stamped, and rate-limited per signature", async () => {
  const notes = [];
  let nowMs = Date.parse("2026-08-11T09:00:00.000Z");
  let nextSymbol = 0;
  const record = createTerminalRefreshFailureRecorder({
    recordNote: (note) => {
      notes.push(note);
    },
    clock: () => nowMs,
    randomIndex: (bound) => {
      nextSymbol = (nextSymbol + 7) % bound;
      return nextSymbol;
    },
  });

  const resourceLimited = {
    errorCode: "refresh_resource_limited",
    failedStep: "accounting",
    failureCode: "accounting_transition_rss_limit_exceeded",
  };
  assert.equal(await record(resourceLimited), true);
  assert.equal(notes.length, 1);
  assert.match(notes[0].reference, /^TT-[0-9A-HJKMNP-TV-Z]{6}$/u);
  assert.deepEqual({ ...notes[0], reference: null }, {
    reference: null,
    surface: "local_refresh",
    code: "refresh_resource_limited",
    requestId: "",
    step: "accounting",
    detail: "accounting_transition_rss_limit_exceeded",
  });

  // The incident cadence: the identical signature every five minutes must
  // collapse to the one existing line for a full hour.
  for (let minutes = 5; minutes < 60; minutes += 5) {
    nowMs += 5 * 60_000;
    assert.equal(await record(resourceLimited), false);
  }
  assert.equal(notes.length, 1);

  // A genuinely different signature is never suppressed.
  nowMs += 60_000;
  assert.equal(await record({
    errorCode: "refresh_failed",
    failedStep: "unified_index",
    failureCode: "local_unified_index_refresh_failed",
  }), true);
  assert.equal(notes.length, 2);
  assert.deepEqual({ ...notes[1], reference: null }, {
    reference: null,
    surface: "local_refresh",
    code: "refresh_failed",
    requestId: "",
    step: "unified_index",
    detail: "local_unified_index_refresh_failed",
  });

  // After the hour the original signature files again.
  nowMs += 60 * 60_000;
  assert.equal(await record(resourceLimited), true);
  assert.equal(notes.length, 3);

  // A timeout carries no step or underlying code: nothing invented.
  assert.equal(await record({ errorCode: "refresh_timed_out" }), true);
  assert.deepEqual({ ...notes[3], reference: null }, {
    reference: null,
    surface: "local_refresh",
    code: "refresh_timed_out",
    requestId: "",
  });

  // Malformed identity collapses to bounded fixed codes, never free text.
  assert.equal(await record({
    errorCode: "Failed reading /Users/private/state.json",
    failedStep: "not_a_step",
    failureCode: "free text with spaces",
  }), true);
  assert.deepEqual({ ...notes[4], reference: null }, {
    reference: null,
    surface: "local_refresh",
    code: "refresh_failed",
    requestId: "",
  });
  assert.equal(JSON.stringify(notes).includes("/Users/private"), false);
});

test("a failing diagnostics writer is contained and cannot become a write storm", async () => {
  let attempts = 0;
  let nowMs = Date.parse("2026-08-11T09:00:00.000Z");
  const record = createTerminalRefreshFailureRecorder({
    recordNote: () => {
      attempts += 1;
      throw new Error("disk full");
    },
    clock: () => nowMs,
  });

  const failure = {
    errorCode: "refresh_resource_limited",
    failedStep: "accounting",
    failureCode: "accounting_transition_rss_limit_exceeded",
  };
  assert.equal(await record(failure), false);
  assert.equal(attempts, 1);
  // The rate-limit stamp survives the failed write: a broken log costs this
  // hour's line rather than one write attempt per failure-loop tick.
  nowMs += 5 * 60_000;
  assert.equal(await record(failure), false);
  assert.equal(attempts, 1);
});

test("quick polling omits reset details only after a successful startup read; detailed refreshes retain them", async () => {
  const optionsSeen = [];
  const classifiersSeen = [];
  let succeeds = false;
  const makeRunner = () => createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async (options) => {
      optionsSeen.push(options.excludeResetCreditDetails);
      classifiersSeen.push(options.resetEventClassifier);
      return { refresh: { attempted: true, recordWritten: succeeds, errorCode: succeeds ? null : "app_server_unavailable" } };
    },
    readAccountingCache: async () => null,
  });
  const runner = makeRunner();
  await runner({ mode: "quick" });
  succeeds = true;
  await runner({ mode: "quick" });
  await runner({ mode: "quick" });
  await runner({ mode: "detailed" });
  await makeRunner()({ mode: "quick" });
  assert.deepEqual(optionsSeen, [false, false, true, false, false]);
  assert.equal(classifiersSeen.slice(0, 4).every(
    (classifier) => classifier === classifiersSeen[0],
  ), true, "one volatile baseline is reused across a companion runner's polls");
  assert.notEqual(classifiersSeen[4], classifiersSeen[0]);
  assert.equal(typeof classifiersSeen[0].observe, "function");
  assert.equal(typeof classifiersSeen[0].reset, "function");
});

const PUBLISHED_INDEX_FOR_UPLOAD = Object.freeze({
  status: "ingested", unchanged: false,
  generation: {
    id: 1, fingerprint: `generation-v2-${"a".repeat(64)}`, status: "complete",
    discoveryComplete: true, diagnosticsComplete: true,
    usageProvenanceComplete: true, sourceOrderComplete: true,
    quotaProvenanceComplete: true, toolProvenanceComplete: true,
  },
});

test("index publication observer follows validated detailed reload, excluding non-publications", async (t) => {
  for (const [name, mode, unifiedIndex, expected] of [
    ["changed detailed", "detailed", PUBLISHED_INDEX_FOR_UPLOAD, 1],
    ["quick", "quick", PUBLISHED_INDEX_FOR_UPLOAD, 0],
    ["unchanged", "detailed", { ...PUBLISHED_INDEX_FOR_UPLOAD, unchanged: true }, 0],
    ["unknown change status", "detailed", { ...PUBLISHED_INDEX_FOR_UPLOAD, unchanged: undefined }, 0],
    ["failed", "detailed", { status: "failed" }, 0],
    ["missing descriptor", "detailed", { status: "ingested" }, 0],
    ["partial", "detailed", { ...PUBLISHED_INDEX_FOR_UPLOAD, generation: {
      ...PUBLISHED_INDEX_FOR_UPLOAD.generation, status: "partial",
    } }, 0],
    ["unproven completeness", "detailed", { ...PUBLISHED_INDEX_FOR_UPLOAD, generation: {
      ...PUBLISHED_INDEX_FOR_UPLOAD.generation, discoveryComplete: false,
    } }, 0],
  ]) {
    await t.test(name, async () => {
      let reloaded = false;
      const observed = [];
      const controller = new LocalCompanionRefreshController({
        runner: async () => ({ unifiedIndex }),
        dataStore: { async reload() { reloaded = true; } },
        onIndexPublished: (...args) => {
          assert.equal(reloaded, true);
          observed.push(args);
        },
      });
      assert.equal(controller.start({ mode }), true);
      await flushControllerSettlement(controller);
      assert.equal(observed.length, expected);
      if (expected) assert.deepEqual(observed, [[]], "no generation identifiers leave observer");
    });
  }
});

test("index publication observer is fenced on failed or cancelled reload and cannot break success", async (t) => {
  for (const outcome of ["failed_reload", "cancelled_reload", "throwing_observer", "rejecting_observer"]) {
    await t.test(outcome, async () => {
      let calls = 0;
      let controller;
      controller = new LocalCompanionRefreshController({
        runner: async () => ({ unifiedIndex: PUBLISHED_INDEX_FOR_UPLOAD }),
        dataStore: { async reload() {
          if (outcome === "failed_reload") throw new Error("synthetic reload failure");
          if (outcome === "cancelled_reload") controller.cancel();
        } },
        onIndexPublished: () => {
          calls += 1;
          if (outcome === "throwing_observer") throw new Error("synthetic observer failure");
          return Promise.reject(new Error("synthetic observer rejection"));
        },
      });
      controller.start();
      await flushControllerSettlement(controller);
      assert.equal(calls, outcome.endsWith("observer") ? 1 : 0);
      if (outcome === "cancelled_reload") assert.equal(controller.getStatus().status, "cancelled");
      if (outcome.endsWith("observer")) assert.equal(controller.getStatus().status, "succeeded");
    });
  }
});


test("overview indexing uses the configured source budget beyond one minute without resetting its hard deadline", async (t) => {
  const timers=createManualTimerScheduler(),entered=Promise.withResolvers(),settled=Promise.withResolvers();
  let signal,publish,selections=0,reloads=0;t.after(()=>settled.resolve({}));
  const controller=new LocalCompanionRefreshController({
    runner:async options=>{signal=options.signal;publish=options.onProgress;entered.resolve();return settled.promise;},
    dataStore:{async reload(){reloads++;}},timeoutMs:1000,timeoutMsForRun:()=>{selections++;return 120_000;},
    monotonicClock:timers.now,setTimeoutImpl:timers.setTimeout,clearTimeoutImpl:timers.clearTimeout,
  });
  controller.start({mode:"overview"});await entered.promise;assert.equal(selections,1);
  timers.advanceBy(59_000);await publish({sources:10,sourcesScanned:1,usageEvents:10});
  timers.advanceBy(30_000);assert.equal(controller.getStatus().status,"running");assert.equal(signal.aborted,false);
  await publish({sources:10,sourcesScanned:2,usageEvents:20});
  timers.advanceBy(30_999);assert.equal(controller.getStatus().status,"running");
  timers.advanceBy(1);assert.equal(controller.getStatus().errorCode,"refresh_timed_out");assert.equal(signal.aborted,true);
  settled.resolve({});await flushControllerSettlement(controller);assert.equal(controller.getStatus().status,"failed");assert.equal(reloads,0);
});

test("overview grants only the existing one-time accounting extension after a longer valid index phase", async (t) => {
  const timers=createManualTimerScheduler(),entered=Promise.withResolvers(),settled=Promise.withResolvers();let publish,signal;
  t.after(()=>settled.resolve({}));
  const controller=new LocalCompanionRefreshController({runner:async options=>{publish=options.onProgress;signal=options.signal;entered.resolve();return settled.promise;},
    dataStore:{async reload(){}},timeoutMsForRun:()=>120_000,accountingTimeoutMs:240_000,
    monotonicClock:timers.now,setTimeoutImpl:timers.setTimeout,clearTimeoutImpl:timers.clearTimeout});
  controller.start({mode:"overview"});await entered.promise;
  timers.advanceBy(110_000);await publish({kind:"accounting",status:"calculating"});
  timers.advanceBy(100_000);assert.equal(controller.getStatus().status,"running");
  await publish({kind:"accounting",status:"calculating"});
  timers.advanceBy(29_999);assert.equal(controller.getStatus().status,"running");
  timers.advanceBy(1);assert.equal(controller.getStatus().errorCode,"refresh_timed_out");assert.equal(signal.aborted,true);
  settled.resolve({});await flushControllerSettlement(controller);
});


test("refresh requests expose actual capabilities and collapse stronger work into one follow-up", async () => {
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const modes = [];
  const controller = new LocalCompanionRefreshController({
    runner: async ({ mode }) => { const index = modes.length; modes.push(mode); return gates[index].promise; },
    dataStore: { async reload() {} },
  });
  const first = controller.request({ mode: "quick" });
  assert.equal(first.started, true);
  assert.deepEqual(first.refresh.capabilities, { quota: true, usage: false, resetDetails: false });
  await new Promise(setImmediate);
  const upgrade = controller.request({ mode: "overview" });
  assert.equal(upgrade.joined, false); assert.equal(upgrade.pending, true);
  assert.equal(upgrade.refresh.refreshId, first.refresh.refreshId);
  assert.equal(upgrade.refresh.mode, "quick");
  controller.request({ mode: "detailed" });
  controller.request({ mode: "detailed" });
  assert.equal(controller.getStatus().pending.mode, "detailed");
  const complete = controller.whenSettled();
  gates[0].resolve({});
  await new Promise(setImmediate);
  assert.deepEqual(modes, ["quick", "detailed"]);
  assert.equal(controller.getStatus().pending, null);
  assert.equal(controller.request({ mode: "overview" }).joined, true);
  gates[1].resolve({}); await complete;
  assert.equal(controller.isRunning(), false);
  assert.equal(controller.getStatus().mode, "detailed");
});

test("cancel clears the merged follow-up instead of immediately restarting usage", async () => {
  const gate = Promise.withResolvers(); let calls = 0;
  const controller = new LocalCompanionRefreshController({
    runner: async () => { calls++; return gate.promise; }, dataStore: { async reload() {} },
  });
  controller.request({ mode: "quick" }); await new Promise(setImmediate);
  controller.request({ mode: "detailed" });
  controller.cancel(); assert.equal(controller.getStatus().pending, null);
  gate.resolve({}); await controller.whenSettled();
  assert.equal(calls, 1); assert.equal(controller.getStatus().status, "cancelled");
});

test("overview publishes durable quota before usage and preserves it when usage fails", async () => {
  const quotaReady = Promise.withResolvers(), usage = Promise.withResolvers(); let publishes = 0, reloads = 0;
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onQuotaReady }) => {
      await onQuotaReady({ attempted: true, recordWritten: true, errorCode: null });
      quotaReady.resolve(); await usage.promise; throw new Error("synthetic failure");
    },
    dataStore: { async reload() { reloads++; }, async publishQuota({ isCurrent }) {
      assert.equal(isCurrent(), true); publishes++; return { published: true, observedAt: "2026-10-21T00:00:00.000Z" };
    } },
  });
  controller.request({ mode: "overview", reason: "automatic" }); await quotaReady.promise;
  const partial = controller.getStatus();
  assert.equal(partial.status, "running"); assert.equal(partial.quota.status, "published");
  assert.ok(partial.quickResultAt); assert.equal(partial.usage.status, "running");
  usage.resolve(); await controller.whenSettled();
  assert.equal(controller.getStatus().status, "failed");
  assert.equal(controller.getStatus().quota.publishedAt, partial.quickResultAt);
  assert.equal(controller.getStatus().usage.status, "failed");
  assert.equal(publishes, 1); assert.equal(reloads, 0);
});

test("quota failure cannot publish a headline or reset quota age while usage succeeds", async () => {
  let publishes = 0, reloads = 0;
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onQuotaReady, onProgress }) => {
      await onQuotaReady({ attempted: true, recordWritten: false, errorCode: "temporary_disconnect" });
      await onProgress({ ...COMPLETE_INDEX, phase: "quick_result" });
      return { quotaRefresh: { attempted: true, recordWritten: false, errorCode: "temporary_disconnect" } };
    }, dataStore: { async reload() { reloads++; }, async publishQuota() { publishes++; return { published: true }; } },
  });
  controller.start({ mode: "overview" }); await controller.whenSettled();
  const status = controller.getStatus();
  assert.equal(status.status, "degraded"); assert.equal(status.quota.status, "failed");
  assert.equal(status.usage.status, "succeeded"); assert.equal(status.quickResultAt, null);
  assert.equal(publishes, 0); assert.equal(reloads, 1);
});

test("quota publication yielding across cancellation cannot update its run receipt", async () => {
  const entered = Promise.withResolvers(), publication = Promise.withResolvers(); let current;
  const controller = new LocalCompanionRefreshController({
    runner: async ({ onQuotaReady }) => {
      await onQuotaReady({ attempted: true, recordWritten: true, errorCode: null }); return {};
    }, dataStore: { async reload() {}, async publishQuota({ isCurrent }) {
      current = isCurrent; entered.resolve(); await publication.promise; return { published: true };
    } },
  });
  controller.start({ mode: "overview" }); await entered.promise;
  controller.cancel(); assert.equal(current(), false); publication.resolve();
  await controller.whenSettled();
  assert.equal(controller.getStatus().status, "cancelled");
  assert.equal(controller.getStatus().quickResultAt, null);
});

test("production runner reports durable quota independently before unified usage work", async () => {
  const stages = [];
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({ refresh: { attempted: true, recordWritten: true, errorCode: null } }),
    refreshUnifiedIndex: async () => { stages.push("usage"); return { status: "ingested", generation: null }; },
  });
  await runner({ mode: "overview", onQuotaReady: async quota => {
    assert.deepEqual(quota, { attempted: true, recordWritten: true, errorCode: null }); stages.push("quota");
  } });
  assert.deepEqual(stages, ["quota", "usage"]);
});


test("reviewed provider transport errors continue usage while durable collector faults stay terminal", async () => {
  let usage = 0;
  const runner = createLocalCollectorRefreshRunner({
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => { throw Object.assign(new Error("synthetic"), { code: "temporary_disconnect" }); },
    refreshUnifiedIndex: async () => { usage++; return { status: "ingested", generation: null }; },
  });
  const result = await runner({ mode: "overview" });
  assert.equal(usage, 1); assert.equal(result.quotaRefresh.errorCode, "temporary_disconnect");
});
