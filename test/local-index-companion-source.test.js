import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { readLocalIndexCompanionProjection } from "../src/local-index-companion-source.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { appendSyntheticCodexEvents } from "../src/synthetic-codex-rollout-corpus.js";
import { createWorkspace } from "./helpers/local-index-facts.js";

const END_MS = Date.parse("2026-09-01T00:00:00.000Z");

// The envelope the snapshot builder consumes must keep its shape.
const ENVELOPE_KEYS = [
  "status", "errorCode", "generatedAt", "indexStatus", "generation", "coveredAt",
  "usageEvents", "quotaObservations", "sourceCount", "sourceBytes",
  "discoveredSourceCount", "discoveredSourceBytes", "indexedSourceCount",
  "indexedSourceBytes", "skippedSourceCount", "skippedSourceBytes",
  "skippedThreadCount", "rolloutIssueCounts", "indexBytes", "latestExportableRecordAt",
  "tools", "toolCoverageStatus", "toolCoverageBlockReason", "usage",
  "cacheSwitchImpact", "cacheContinuityImpact", "timeline",
];

test("the v2 projection carries the snapshot envelope and a complete generation", async () => {
  const workspace = createWorkspace({ variety: true, files: 30, events: 1_500, days: 8, seed: 21 });
  try {
    const v2File = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: v2File, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const nowMs = END_MS + 3_600_000;
    const actual = await readLocalIndexCompanionProjection({ indexFile: v2File, nowMs });
    for (const key of ENVELOPE_KEYS) assert.ok(key in actual, `envelope key ${key}`);
    assert.equal(actual.status, "available");

    // The facts the snapshot builder tests before it trusts a generation.
    const generation = actual.generation;
    assert.ok(Number.isSafeInteger(generation.id) && generation.id >= 1);
    for (const name of [
      "discoveryComplete", "diagnosticsComplete", "usageProvenanceComplete",
      "sourceOrderComplete", "quotaProvenanceComplete",
    ]) assert.equal(generation[name], true, name);
    assert.match(generation.fingerprint, /^generation-v2-[0-9a-f]{64}$/u);

    const again = await readLocalIndexCompanionProjection({ indexFile: v2File, nowMs });
    assert.equal(again.generation.fingerprint, generation.fingerprint, "stable while nothing commits");

    appendSyntheticCodexEvents(workspace.receipt.sources.slice(0, 2), {
      seed: 8, events: 3, fillerBytesPerEvent: 100, atMs: Date.parse("2026-09-02T00:00:00Z"),
    });
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: v2File, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const advanced = await readLocalIndexCompanionProjection({ indexFile: v2File, nowMs });
    assert.ok(advanced.generation.id > generation.id, "the publication id moves forward");
    assert.notEqual(advanced.generation.fingerprint, generation.fingerprint);
  } finally {
    workspace.cleanup();
  }
});

test("the work breakdown rides beside the projection and names the same publication", async () => {
  const workspace = createWorkspace({ files: 12, events: 400, days: 5, seed: 22 });
  try {
    const v2File = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: v2File, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const result = await readLocalIndexCompanionProjection({
      indexFile: v2File, nowMs: END_MS + 3_600_000, includeWorkUsage: true,
      codexHome: workspace.codexHome, secretFile: workspace.secretFile,
    });
    assert.equal(result.companion.status, "available");
    assert.ok(["available", "unavailable"].includes(result.workUsage.status));
    await assert.rejects(
      readLocalIndexCompanionProjection({ indexFile: v2File, includeWorkUsage: true }),
      TypeError,
    );
  } finally {
    workspace.cleanup();
  }
});

test("missing, deferred and never-committed stores are explicit states", async () => {
  const workspace = createWorkspace({ files: 3, events: 40 });
  try {
    const missing = await readLocalIndexCompanionProjection({
      indexFile: join(workspace.state, "absent.sqlite"),
    });
    assert.equal(missing.status, "missing");
    assert.equal(missing.generation, null);
    const deferred = await readLocalIndexCompanionProjection({
      indexFile: join(workspace.state, "absent.sqlite"), mode: "deferred",
    });
    assert.equal(deferred.status, "deferred");
    assert.equal(deferred.errorCode, "local_unified_index_deferred");
    await assert.rejects(
      readLocalIndexCompanionProjection({ indexFile: join(workspace.state, "x"), mode: "weekly" }),
      TypeError,
    );
  } finally {
    workspace.cleanup();
  }
});
