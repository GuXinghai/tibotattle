import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildLocalCompanionSnapshot } from "../src/local-companion-data.js";
import { createLocalIndexBackend } from "../src/local-index-backend.js";
import { readLocalIndexGenerationIdentity } from "../src/local-index-companion-source.js";
import {
  buildLocalIndexCacheDropThreadLinks, cacheDropThreadLookupKey,
} from "../src/local-index-cache-drop-links.js";
import { createLocalIndexSecondaryIndexes, createLocalIndexWriter, openLocalIndexStore } from "../src/local-index-store.js";
import { appendSyntheticCodexEvents } from "../src/synthetic-codex-rollout-corpus.js";
import { createWorkspace } from "./helpers/local-index-facts.js";

const NOW_MS = Date.parse("2026-09-01T01:00:00.000Z");
const noNames = async () => new Map();

async function overviewFor(workspace, backend, indexFile) {
  const root = mkdtempSync(join(tmpdir(), "cache-drop-links-"));
  try {
    const snapshot = await buildLocalCompanionSnapshot({
      root,
      collectorStateFile: join(workspace.state, "collector.sqlite"),
      accountingSourceMode: "unified",
      unifiedIndexFile: indexFile,
      unifiedProjectionReader: (options, controls) => backend.projectionReader.reader(options, controls),
      now: () => NOW_MS,
    });
    return snapshot.overview;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ROOT = "11111111-1111-4111-8111-111111111111";
const WORKER = "22222222-2222-4222-8222-222222222222";
const THIRD = "33333333-3333-4333-8333-333333333333";
const LOCAL_NOW = Date.parse("2026-08-30T12:00:00.000Z");
const local = (number) => Buffer.alloc(32, number);
const switchRow = () => ({
  observedAt: new Date(LOCAL_NOW - 60_000).toISOString(), gapSeconds: 60,
  previous: { model: "gpt-5.6-sol", reasoningEffort: "low" },
  current: { model: "gpt-5.6-sol", reasoningEffort: "high" },
  changeType: "reasoning_only", previousCacheReadTokens: 1_000,
  currentCacheReadTokens: 0, lostCacheTokens: 1_000,
  estimatedPremiumUsd: null, estimatedPremiumUsdExact: null,
});
const continuityRow = () => ({
  observedAt: new Date(LOCAL_NOW - 30_000).toISOString(), gapSeconds: 600,
  configuration: { model: "gpt-5.6-terra", reasoningEffort: "high" },
  gapBand: "five_to_thirty_minutes", previousCacheReadTokens: 2_000,
  currentCacheReadTokens: 100, lostCacheTokens: 1_900,
  estimatedPremiumUsd: null, estimatedPremiumUsdExact: null,
});

// A v2 store holding exact cache-drop adjacency: one session per source, with
// the same rows the analyzer's recent tables describe. Every write commits on
// its own, so each read sees the current publication identity.
async function storeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cache-drop-links-v2-"));
  const indexFile = join(root, "index.sqlite");
  const database = openLocalIndexStore(indexFile, { create: true });
  t.after(() => {
    if (database.isOpen) database.close();
    rmSync(root, { recursive: true, force: true });
  });
  const writer = createLocalIndexWriter(database);
  const write = (work) => {
    writer.begin();
    try {
      const result = work();
      writer.commit({ kind: "refresh" });
      return result;
    } catch (error) {
      writer.rollback();
      throw error;
    }
  };
  const dims = write(() => {
    const surfaceId = writer.internSurface({ agentScope: "root", surface: "desktop",
      threadSource: "user", lineageDisposition: "canonical" });
    const sessions = {
      1: writer.internSession(local(1), ROOT),
      2: writer.internSession(local(2), WORKER),
      3: writer.internSession(local(3), THIRD),
    };
    const sources = {};
    for (const number of [1, 2]) {
      const { id } = writer.registerSource({ sourceLocal: local(number), sessionId: sessions[number],
        surfaceId, path: `synthetic-${number}`, rolloutKey: `synthetic-${number}`,
        sizeBytes: 1_000_000, mtimeMs: LOCAL_NOW });
      writer.commitSourceState(id, { sessionId: sessions[number], surfaceId, path: `synthetic-${number}`,
        rolloutKey: `synthetic-${number}`, sizeBytes: 1_000_000, mtimeMs: LOCAL_NOW,
        scannedBytes: 1_000_000, diagnostics: {} });
      sources[number] = id;
    }
    return {
      sessions, sources, surfaceId,
      tierId: writer.internTier({ apiServiceTier: "standard", billingSurface: "chatgpt_subscription",
        codexSpeedMode: "standard", tierSource: "observed", providerTierRaw: null }),
      accountScopeId: writer.internAccountScope({ status: "unattributed", reason: null, planType: null, scopeLocal: null }),
      models: { 1: writer.internModel("gpt-5.6-sol", "recognized"), 2: writer.internModel("gpt-5.6-terra", "recognized") },
    };
  });
  let key = 0;
  function event({ session = 1, time, source = 1, offset, model = 1, effort = 4, cached = 0,
    uncached = 1_100, written = 0, turn = false, compacted = false }) {
    const eventKey = Buffer.alloc(32);
    eventKey.writeUInt32BE(++key);
    write(() => {
      writer.writeUsageEvent({
        sourceId: dims.sources[source], sourceOffset: offset, observedAtMs: time, eventKey,
        sessionId: dims.sessions[session], accountScopeId: dims.accountScopeId,
        modelId: dims.models[model], tierId: dims.tierId, surfaceId: dims.surfaceId,
        quotaObservationId: null, tierObservedAtMs: null, reasoningEffort: effort,
        tokensInUncached: uncached, tokensInCacheRead: cached, tokensInCacheWrite: written,
        tokensOutText: null, tokensOutReasoning: null, tokensOutCombined: null, totalInputContext: null,
      });
      if (turn || compacted) writer.writeBoundary({ sourceId: dims.sources[source], sourceOffset: offset,
        compactionBefore: compacted, turnContextBefore: turn, compactedAtMs: compacted ? time - 1 : null });
    });
    return eventKey;
  }
  event({ time: LOCAL_NOW - 120_000, offset: 100, effort: 2, cached: 1_000 });
  event({ time: LOCAL_NOW - 60_000, offset: 200 });
  event({ session: 2, source: 2, model: 2, time: LOCAL_NOW - 630_000, offset: 100, cached: 2_000 });
  event({ session: 2, source: 2, model: 2, time: LOCAL_NOW - 30_000, offset: 200, cached: 100, uncached: 2_200, turn: true });
  // The reader-only indexes the refresh pipeline creates after a bulk load.
  createLocalIndexSecondaryIndexes(database);
  const overview = {
    accounting: {
      cacheSwitchImpact: { status: "available", recent: [switchRow()], periods: [
        { periodId: "24h", recent: [switchRow()] },
        { periodId: "7d", recent: [switchRow()] },
      ] },
      cacheContinuityImpact: { status: "available", periods: [
        { periodId: "all", recent: [continuityRow()] },
      ] },
    },
  };
  // The publication identity is read per call: the overview names exactly the
  // publication the links are resolved against.
  const withIdentity = () => {
    const current = readLocalIndexGenerationIdentity({ indexFile });
    return { ...overview, accounting: { ...overview.accounting,
      generation: String(current.id),
      cacheDiagnosticsSource: { generation: String(current.id), generationFingerprint: current.fingerprint } } };
  };
  const readThreadMetadata = async (_home, ids) => new Map(ids.map((id) => [id, {
    id, name: id === ROOT ? "Synthetic root" : null,
    nickname: id === WORKER ? "Ada" : null,
    parent: id === WORKER ? { id: ROOT, name: "Synthetic root" } : null,
    ignoredPrivateField: "must-not-be-emitted",
  }]));
  return { root, indexFile, overview, event,
    generation: () => String(readLocalIndexGenerationIdentity({ indexFile }).id),
    run: (extra = {}) => buildLocalIndexCacheDropThreadLinks({
      indexFile, codexHome: root, overview: withIdentity(), nowMs: LOCAL_NOW, readThreadMetadata, ...extra,
    }) };
}

test("both recent tables resolve exact adjacency identities without mutating anonymous accounting", async (t) => {
  const f = await storeFixture(t);
  const beforeOverview = structuredClone(f.overview);
  const beforeNames = readdirSync(f.root);
  const result = await f.run();
  assert.equal(result.status, "available");
  assert.equal(result.generation, f.generation());
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0], {
    kind: "switch", key: cacheDropThreadLookupKey("switch", switchRow()),
    thread: { id: ROOT, name: "Synthetic root", nickname: null, parent: null },
  });
  assert.deepEqual(result.entries[1].thread, {
    id: WORKER, name: null, nickname: "Ada", parent: { id: ROOT, name: "Synthetic root" },
  });
  assert.deepEqual(f.overview, beforeOverview);
  assert.deepEqual(readdirSync(f.root), beforeNames);
  assert.deepEqual(Object.keys(result), ["schemaVersion", "status", "generation", "entries"]);
  assert.doesNotMatch(JSON.stringify(result), /ignoredPrivateField|must-not-be-emitted|session_local/u);
});

test("a missing local name store keeps exact thread-ID fallbacks", async (t) => {
  const f = await storeFixture(t);
  const result = await f.run({ readThreadMetadata: async () => { throw new Error("private path must not escape"); } });
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0].thread, { id: ROOT, name: null, nickname: null, parent: null });
  assert.doesNotMatch(JSON.stringify(result), /private path/u);
});

test("timestamp tuples ambiguous across sessions never guess a thread", async (t) => {
  const f = await storeFixture(t);
  f.event({ session: 3, time: LOCAL_NOW - 120_000, offset: 300, effort: 2, cached: 1_000 });
  f.event({ session: 3, time: LOCAL_NOW - 60_000, offset: 400 });
  const result = await f.run();
  assert.equal(result.entries.some((entry) => entry.kind === "switch"), false,
    "a second exact match in another session makes attribution ambiguous");
});

test("lookup keys are bounded and closed to valid recent-row fields", () => {
  assert.equal(cacheDropThreadLookupKey("switch", switchRow()), JSON.stringify([
    "switch", switchRow().observedAt, 60, "gpt-5.6-sol", "low", "gpt-5.6-sol", "high", 1_000, 0, 1_000,
  ]));
  assert.equal(cacheDropThreadLookupKey("continuity", continuityRow()), JSON.stringify([
    "continuity", continuityRow().observedAt, 600, "gpt-5.6-terra", "high", "gpt-5.6-terra", "high", 2_000, 100, 1_900,
  ]));
  for (const patch of [
    { observedAt: "2026-08-30" }, { gapSeconds: 0.0001 }, { gapSeconds: -1 },
    { previousCacheReadTokens: Infinity }, { currentCacheReadTokens: 999 },
    { lostCacheTokens: 0 }, { lostCacheTokens: Number.MAX_SAFE_INTEGER },
    { current: { model: "x".repeat(201), reasoningEffort: "high" } },
    { current: { model: "gpt-5.6-sol", reasoningEffort: "unknown" } },
  ]) assert.equal(cacheDropThreadLookupKey("switch", { ...switchRow(), ...patch }), null);
  assert.equal(cacheDropThreadLookupKey("arbitrary", switchRow()), null);
});

test("a foreign or moved publication links nothing", async () => {
  const workspace = createWorkspace({ variety: true, files: 8, events: 300, days: 4, seed: 42 });
  try {
    const indexFile = join(workspace.state, "v2.sqlite");
    const backend = createLocalIndexBackend({
      indexFile, secretFile: workspace.secretFile, workerCount: 1, now: () => NOW_MS,
    });
    await backend.refreshUnifiedIndex({ codexHome: workspace.codexHome });
    const overview = await overviewFor(workspace, backend, indexFile);
    const run = (value) => buildLocalIndexCacheDropThreadLinks({
      indexFile, codexHome: workspace.codexHome, overview: value, nowMs: NOW_MS,
      readThreadMetadata: noNames,
    });

    const foreign = structuredClone(overview);
    foreign.accounting.cacheDiagnosticsSource.generationFingerprint = `generation-v2-${"0".repeat(64)}`;
    assert.deepEqual((await run(foreign)).entries, []);
    assert.equal((await run(foreign)).status, "unavailable");

    const legacyShape = structuredClone(overview);
    legacyShape.accounting.cacheDiagnosticsSource.generationFingerprint = `generation-${"a".repeat(64)}`;
    assert.equal((await run(legacyShape)).status, "unavailable");

    // The publication the overview named has been replaced.
    appendSyntheticCodexEvents([workspace.receipt.sources.at(-1)], {
      seed: 5, events: 3, fillerBytesPerEvent: 0, atMs: Date.parse("2026-08-31T23:00:00.000Z"),
    });
    await backend.refreshUnifiedIndex({ codexHome: workspace.codexHome });
    assert.equal((await run(overview)).status, "unavailable");
  } finally {
    workspace.cleanup();
  }
});
