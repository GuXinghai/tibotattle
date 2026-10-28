import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { preserveDesktopAccountingCacheV025 } from "../scripts/lib/desktop-calculation-migration.mjs";
import { PRESERVED_ACCOUNTING_HISTORY_META_KEY } from "../src/local-accounting-preserved-history.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readReplaySafeAccountingCache,
  refreshReplaySafeAccountingCache as refreshReplaySafeAccountingCacheImpl,
  REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION,
} from "../src/replay-safe-accounting-cache.js";
import { TEST_GENERATION, withResidentCalibration } from "./helpers/replay-safe-resident-calibration.js";
import {
  readLocalCollectorAccountingCache,
  serializeLocalCollectorAccountingCache,
  writeLocalCollectorAccountingCache,
} from "../src/local-collector-state.js";
import { buildLocalCompanionSnapshot } from "../src/local-companion-data.js";
import { normalizeDashboardPayload, selectAllowancePlanPopulation } from "../apps/web/public/data-client.js";
import { createWorkspace } from "./helpers/local-index-facts.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { buildLocalIndexAccountingCache } from "../src/local-index-accounting-cache.js";
import { readLocalIndexGenerationIdentity } from "../src/local-index-companion-source.js";
import { appendSyntheticCodexEvents } from "../src/synthetic-codex-rollout-corpus.js";
import { createProtectedFixtureDirectory } from "./helpers/windows-owner-only-fixture.js";

// Runtime accepts only current cache format. Old data is retained untouched;
// one-time migration writes a new historical-only receipt for basic figures.
// A current-format generation mismatch remains a separately fenced stale serve.

const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * DAY_MS;
const OUTDATED_SCHEMA_VERSION = "local-replay-safe-accounting-v0.11";
const PREVIOUS_PRICING_SCHEMA_VERSION = "local-replay-safe-accounting-v0.24";
const WITHHELD_SENTENCE =
  "Historical event-time accounting changed. The prior cache is withheld until the next local replay rebuilds it.";

// An estimator-worthy corpus scan: four weekly reset windows whose displayed
// percent advances a whole point per hourly boundary, with usage rows between
// boundaries. Small enough for an in-process refresh, rich enough that the
// weekly calibration reaches "estimated" and every allowance scenario fits —
// so the stale serve below carries REAL projections, not empty summaries.
function estimatorWorthyScan({
  resetStarts = Array.from(
    { length: 4 },
    (_, week) => Date.parse("2026-05-07T00:00:00.000Z") + week * WEEK_MS,
  ),
  boundariesPerReset = 100,
  usagePerBoundary = 2,
} = {}) {
  return withResidentCalibration(async ({ onUsage, onRateLimitSnapshot }) => {
    for (const [resetIndex, resetStartMs] of resetStarts.entries()) {
      const slot = resetIndex * 2 < resetStarts.length
        ? "secondary"
        : "primary";
      for (let boundary = 0; boundary < boundariesPerReset; boundary += 1) {
        const observedAtMs = resetStartMs + boundary * 60 * 60_000;
        onRateLimitSnapshot({
          timestamp: new Date(observedAtMs).toISOString(),
          timestampMs: observedAtMs,
          window: {
            provider: "openai_codex",
            planType: "pro",
            limitId: "codex",
            slot,
            windowDurationMins: 10_080,
            resetsAt: Math.floor((resetStartMs + WEEK_MS) / 1_000),
            usedPercent: boundary,
          },
        });
        for (let step = 0; step < usagePerBoundary; step += 1) {
          onUsage({
            timestamp: new Date(
              observedAtMs + 10_000 + step * 5_000,
            ).toISOString(),
            model: step % 2 === 0 ? "gpt-5.6-sol" : "gpt-5.6-terra",
            components: {
              input_uncached_tokens: 400_000 + boundary * 1_000,
              input_cache_read_tokens: 20_000,
              input_cache_write_tokens: 0,
              output_text_tokens: 900,
              output_reasoning_tokens: 1_200,
              output_combined_tokens: 0,
            },
            tierSemantics: {
              codexSpeedMode: step % 2 === 0 ? "standard" : "fast",
              apiServiceTier: "unknown",
            },
          });
        }
      }
    }
    return { diagnostics: {} };
  });
}

// A real current cache, built through the production refresh, then re-stored
// with only its semantic version flipped to a prior release's tag. Every
// projection inside stays exactly what the estimator produced, which is what
// an updater's on-disk cache looks like: sound content, outdated identity.
// The build takes a unified scan and its calibration source; the estimator
// scan carries both, bound to one generation.
function refreshReplaySafeAccountingCache(options) {
  return refreshReplaySafeAccountingCacheImpl({
    sourceMode: "unified",
    expectedGeneration: TEST_GENERATION,
    calibrationSource: options.scan.calibrationSource,
    ...options,
  });
}

async function writeOutdatedPriorCache(stateFile) {
  const current = await refreshReplaySafeAccountingCache({
    stateFile,
    now: () => NOW - 60 * 60_000,
    scan: estimatorWorthyScan(),
  });
  assert.equal(current.weeklyCalibration.status, "estimated");
  const outdated = {
    ...structuredClone(current),
    schemaVersion: OUTDATED_SCHEMA_VERSION,
  };
  const database = new DatabaseSync(stateFile);
  try { database.prepare("UPDATE meta SET value_json=? WHERE key='accounting_cache'").run(JSON.stringify(outdated)); }
  finally { database.close(); }
  return outdated;
}

async function writeMigratedPriorHistory(stateFile) {
  const current = await refreshReplaySafeAccountingCache({ stateFile,
    now: () => NOW - 60 * 60_000, scan: estimatorWorthyScan() });
  const previous = { ...structuredClone(current), schemaVersion: "local-replay-safe-accounting-v0.25" };
  delete previous.unknownSpeedPolicy;
  const envelope = preserveDesktopAccountingCacheV025(JSON.stringify(previous));
  const database = new DatabaseSync(stateFile);
  try {
    database.exec("BEGIN IMMEDIATE");
    database.prepare("INSERT INTO meta(key,value_json) VALUES (?,?)").run(PRESERVED_ACCOUNTING_HISTORY_META_KEY, JSON.stringify(envelope));
    database.prepare("DELETE FROM meta WHERE key='accounting_cache'").run();
    database.exec("COMMIT");
  } finally { database.close(); }
  return { previous, envelope };
}

function preservedBytes(stateFile) {
  const database = new DatabaseSync(stateFile, { readOnly: true });
  try { return database.prepare("SELECT value_json FROM meta WHERE key=?").get(PRESERVED_ACCOUNTING_HISTORY_META_KEY)?.value_json; }
  finally { database.close(); }
}

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "usage-monitor-stale-serve-"));
  createProtectedFixtureDirectory(join(root, ".usage-monitor"));
  return root;
}

function snapshotOptions(root, stateFile) {
  return {
    root,
    collectorStateFile: stateFile,
    allowDevelopmentArtifactFallback: true,
    now: () => NOW,
  };
}

test("a newer index serves prior generation costs with original provenance and no old allowance inputs", async () => {
  const workspace = createWorkspace({ files: 1, events: 5, days: 1 });
  const indexFile = join(workspace.state, "index.sqlite");
  const stateFile = join(workspace.state, "collector.sqlite");
  const nowMs = Date.parse("2026-09-03T12:00:00.000Z");
  const options = { codexHome: workspace.codexHome, indexFile,
    secretFile: workspace.secretFile, workerCount: 1 };
  try {
    await refreshLocalIndex(options);
    const originalGeneration = readLocalIndexGenerationIdentity({ indexFile });
    const cache = await buildLocalIndexAccountingCache({ indexFile,
      codexHome: workspace.codexHome, expectedGeneration: originalGeneration, now: () => nowMs - 60_000 });
    await writeLocalCollectorAccountingCache({ stateFile, cache });
    appendSyntheticCodexEvents(workspace.receipt.sources, {
      seed: 31, events: 2, atMs: nowMs - 30_000, fillerBytesPerEvent: 0,
    });
    await refreshLocalIndex(options);
    const currentGeneration = readLocalIndexGenerationIdentity({ indexFile });
    assert.notEqual(currentGeneration.id, originalGeneration.id);
    const snapshot = await buildLocalCompanionSnapshot({
      ...snapshotOptions(workspace.root, stateFile), unifiedIndexFile: indexFile,
      now: () => nowMs,
    });
    assert.equal(snapshot.overview.freshness.accountingStatus, "unavailable");
    const served = snapshot.overview.accounting.staleServe;
    assert.equal(served.reason, "local_unified_index_generation_mismatch");
    assert.equal(served.sourceGeneration, cache.sourceDescriptor.generation);
    assert.equal(served.sourceGenerationFingerprint, originalGeneration.fingerprint);
    assert.equal(served.computedAt, cache.generatedAt);
    assert.deepEqual(served.coveredAt, cache.coveredAt);
    const originalAll = cache.periods.find(row => row.id === "all");
    assert.equal(served.periods.find(row => row.periodId === "all").events, originalAll.events);
    assert.equal(snapshot.overview.timeline.allowanceCapacity.stale, undefined);
    assert.notEqual(snapshot.overview.timeline.allowanceCapacity.status, "available");
    assert.equal(snapshot.weekly.stale, undefined);
    const dashboard = normalizeDashboardPayload({ ...snapshot.overview, weekly: snapshot.weekly });
    assert.deepEqual(dashboard.accounting.staleServe, served);
    const malformed = structuredClone(snapshot.overview);
    delete malformed.accounting.staleServe.sourceGenerationFingerprint;
    assert.equal(normalizeDashboardPayload(malformed).accounting.staleServe, null);
    const retained = await readLocalCollectorAccountingCache({ stateFile });
    assert.deepEqual(retained.cache.sourceDescriptor, cache.sourceDescriptor,
      "serving a stale result never relabels its durable generation");
    assert.equal(retained.cache.generatedAt, cache.generatedAt);
  } finally { workspace.cleanup(); }
});

test("old cache format is refused without runtime compatibility or rewriting", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const outdated = await writeOutdatedPriorCache(stateFile);
    const read = await readReplaySafeAccountingCache({ stateFile });
    assert.equal(read.status, "unavailable");
    assert.equal(read.errorCode, "cache_migration_required");
    assert.equal(read.cache, null);
    assert.equal(Object.hasOwn(read, "staleCache"), false);
    assert.deepEqual((await readLocalCollectorAccountingCache({ stateFile })).cache, outdated);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a previous pricing cache remains byte-identical when current runtime requires migration", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const current = await refreshReplaySafeAccountingCache({
      stateFile,
      now: () => NOW - 60 * 60_000,
      scan: estimatorWorthyScan(),
    });
    const previous = structuredClone(current);
    previous.schemaVersion = PREVIOUS_PRICING_SCHEMA_VERSION;
    delete previous.pricingMethodVersion;
    const previousBytes = Buffer.from(serializeLocalCollectorAccountingCache(previous));
    const database = new DatabaseSync(stateFile);
    try { database.prepare("UPDATE meta SET value_json=? WHERE key='accounting_cache'").run(JSON.stringify(previous)); }
    finally { database.close(); }

    const retainedBeforeRead = await readLocalCollectorAccountingCache({ stateFile });
    assert.deepEqual(
      Buffer.from(serializeLocalCollectorAccountingCache(retainedBeforeRead.cache)),
      previousBytes,
    );

    const read = await readReplaySafeAccountingCache({ stateFile });
    assert.equal(read.status, "unavailable");
    assert.equal(read.errorCode, "cache_migration_required");
    assert.equal(read.cache, null);
    assert.equal(Object.hasOwn(read, "staleCache"), false);

    const retainedAfterRead = await readLocalCollectorAccountingCache({ stateFile });
    assert.deepEqual(
      Buffer.from(serializeLocalCollectorAccountingCache(retainedAfterRead.cache)),
      previousBytes,
      "a stale read never rewrites or relabels the retained cache",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a price-registry-outdated cache stays fully withheld: no stale channel", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const current = await refreshReplaySafeAccountingCache({
      stateFile,
      now: () => NOW - 60 * 60_000,
      scan: estimatorWorthyScan(),
    });
    await writeLocalCollectorAccountingCache({
      stateFile,
      cache: {
        ...structuredClone(current),
        priceRegistryVersion: "price-registry-superseded-test",
      },
    });
    const read = await readReplaySafeAccountingCache({ stateFile });
    assert.equal(read.status, "unavailable");
    assert.equal(read.errorCode, "cache_price_registry_outdated");
    assert.equal(read.cache, null);
    // Outdated prices are wrong figures, not merely differently derived ones;
    // they are never served, stale-labeled or otherwise.
    assert.equal(Object.hasOwn(read, "staleCache"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrated history serves original cost and tokens without old allowance projections", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const { previous, envelope } = await writeMigratedPriorHistory(stateFile);
    const before = preservedBytes(stateFile);
    const snapshot = await buildLocalCompanionSnapshot(snapshotOptions(root, stateFile));
    const serve = snapshot.overview.accounting.staleServe;
    assert.equal(serve.status, "historical_only");
    assert.equal(serve.schemaVersion, "local-accounting-preserved-history-summary-v1");
    assert.equal(serve.computedAt, previous.generatedAt);
    assert.deepEqual(serve.coveredAt, previous.coveredAt);
    const originalAll = previous.periods.find(row => row.id === "all");
    assert.deepEqual(serve.periods.find(row => row.periodId === "all"), {
      periodId: "all", periodLabel: originalAll.label, events: originalAll.events,
      totalTokens: originalAll.totalTokens, apiPriceEquivalentUsd: originalAll.apiPriceEquivalentUsd });
    assert.equal(snapshot.weekly.status, "unavailable");
    assert.equal(snapshot.overview.timeline.allowanceCapacity.status, "unavailable");
    assert.equal(snapshot.weekly.stale, undefined);
    const dashboard = normalizeDashboardPayload({ ...snapshot.overview, weekly: snapshot.weekly });
    assert.deepEqual(dashboard.accounting.staleServe, serve);
    assert.equal(dashboard.timeline.allowanceCapacity.status, "unavailable");
    assert.equal(preservedBytes(stateFile), before);
    assert.equal(JSON.parse(before).sourceCacheJson, envelope.sourceCacheJson);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("current cache cannot publish an absent or contradictory allowance scope", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const current = await refreshReplaySafeAccountingCache({ stateFile, now: () => NOW, scan: estimatorWorthyScan() });
    for (const mutate of [x => { delete x.allowanceCapacityByScenario.planScope; },
      x => { x.allowanceCapacityByScenario.planScope.basisId = "wrong-basis"; }]) {
      const malformed = structuredClone(current); mutate(malformed);
      await writeLocalCollectorAccountingCache({ stateFile, cache: malformed });
      const read = await readReplaySafeAccountingCache({ stateFile });
      assert.equal(read.status, "unavailable");
      const snapshot = await buildLocalCompanionSnapshot(snapshotOptions(root, stateFile));
      assert.equal(snapshot.overview.timeline.allowanceCapacity.status, "unavailable");
      assert.equal(snapshot.overview.accounting.staleServe, null);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a fresh account with no prior cache keeps today's honest empty states", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const snapshot = await buildLocalCompanionSnapshot(
      snapshotOptions(root, stateFile),
    );
    assert.equal(snapshot.overview.accounting.staleServe, null);
    assert.equal(snapshot.weekly.status, "unavailable");
    assert.equal(Object.hasOwn(snapshot.weekly, "stale"), false);
    assert.equal(
      snapshot.overview.timeline.allowanceCapacity.status,
      "unavailable",
    );
    assert.equal(
      Object.hasOwn(snapshot.overview.timeline.allowanceCapacity, "stale"),
      false,
    );
    assert.ok(!snapshot.overview.warnings.includes(WITHHELD_SENTENCE));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrated historical evidence survives failed and successful current rebuilds", async () => {
  const root = await fixtureRoot();
  const stateFile = join(root, ".usage-monitor", "local-collector-state-v1.sqlite");
  try {
    const { previous } = await writeMigratedPriorHistory(stateFile);
    const before = preservedBytes(stateFile);
    const deferred = await refreshReplaySafeAccountingCache({ stateFile, now: () => NOW,
      maximumRssBytes: 100, rss: (() => { const samples = [50, 50]; return () => samples.shift() ?? 101; })(),
      scan: estimatorWorthyScan() });
    assert.equal(deferred.status, "accounting_rebuild_deferred");
    assert.equal((await readLocalCollectorAccountingCache({ stateFile })).cache, null);
    assert.equal(preservedBytes(stateFile), before);
    const historical = await buildLocalCompanionSnapshot(snapshotOptions(root, stateFile));
    assert.equal(historical.overview.accounting.staleServe.computedAt, previous.generatedAt);
    assert.equal(historical.weekly.status, "unavailable");
    const rebuilt = await refreshReplaySafeAccountingCache({ stateFile, now: () => NOW, scan: estimatorWorthyScan() });
    assert.equal(rebuilt.schemaVersion, REPLAY_SAFE_ACCOUNTING_SCHEMA_VERSION);
    assert.deepEqual((await readLocalCollectorAccountingCache({ stateFile })).cache, rebuilt);
    assert.equal(preservedBytes(stateFile), before, "publishing current results must not delete the only historical receipt");
    assert.equal((await readReplaySafeAccountingCache({ stateFile })).status, "available");
  } finally { await rm(root, { recursive: true, force: true }); }
});
