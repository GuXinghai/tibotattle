import test from "node:test";
import assert from "node:assert/strict";
import { createLocalCollectorRefreshRunner } from "../src/local-companion-refresh.js";
import { REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION } from "../src/replay-safe-accounting-cache.js";

const generation = { id: 1, fingerprint: "a".repeat(64), status: "complete", discoveryComplete: true,
  diagnosticsComplete: true, usageProvenanceComplete: true, sourceOrderComplete: true,
  quotaProvenanceComplete: true, toolProvenanceComplete: true };
const standard = { mode: "standard", customFastRatioBps: null };
const fast = { mode: "fast", customFastRatioBps: null };
const cache = policy => ({ schemaVersion: REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
  unknownSpeedPolicy: policy, generatedAt: "2026-10-01T00:00:00.000Z", periods: [], diagnostics: {},
  sourceDescriptor: { fallbackCount: 0 }, weeklyApiIntervals: { status: "available" } });

test("refresh captures the policy once before async work and applies a later change only next time", async () => {
  let policy = { ...standard }, release, started;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const options = []; let first = true;
  const runner = createLocalCollectorRefreshRunner({ getUnknownSpeedPolicy: () => policy,
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => { if (first) { first = false; started(); await gate; } return { rolloutRecordsWritten: 1, refresh: {} }; },
    refreshUnifiedIndex: async () => ({ status: "ingested", generation }),
    refreshAccounting: async opts => { options.push(opts.unknownSpeedPolicy); return cache(opts.unknownSpeedPolicy); } });
  const pending = runner(); await began;
  policy.mode = "fast"; release(); await pending; await runner();
  assert.deepEqual(options, [standard, fast]);
  assert.ok(options.every(Object.isFrozen));
});

test("a no-new-usage refresh refuses a different-policy durable cache and rebuilds", async () => {
  let builds = 0;
  const runner = createLocalCollectorRefreshRunner({ getUnknownSpeedPolicy: () => fast,
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: async () => ({ rolloutRecordsWritten: 0, refresh: {} }),
    refreshUnifiedIndex: async () => ({ status: "ingested", generation }),
    readAccountingCache: async () => ({ status: "available", cache: cache(standard) }),
    refreshAccounting: async opts => { builds++; return cache(opts.unknownSpeedPolicy); } });
  const result = await runner();
  assert.equal(builds, 1); assert.equal(result.accounting.refreshStatus, "rebuilt");
});
