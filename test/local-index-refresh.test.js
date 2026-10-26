import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { refreshLocalIndex, validateLocalIndexWorkerCursor } from "../src/local-index-refresh.js";
import { LOCAL_INDEX_PARSER_VERSION } from "../src/local-index-store.js";
import { LOCAL_UNIFIED_INDEX_PARSER_VERSION } from "../src/codex-usage-vocabulary.js";
import { appendSyntheticCodexEvents } from "../src/synthetic-codex-rollout-corpus.js";
import {
  assertSameFacts,
  createWorkspace,
  v2Facts,
} from "./helpers/local-index-facts.js";

test("parallel worker cursor closes tier provenance and rejects unknown or missing provenance", () => {
  const cursor = {
    nextOffset: 32,
    finalModel: null,
    finalEffort: null,
    finalTierRaw: "priority",
    finalTierObservedAtMs: 1_790_000_000_000,
    finalTierSource: "turn_override",
    finalTotals: null,
    finalCwd: null,
    finalCompactionPending: null,
    finalTurnContextPending: false,
    turnContextSeen: true,
    snapshotsPersisted: false,
    windows: { head: null, boundary: null, tail: null },
    segments: null,
  };
  assert.equal(validateLocalIndexWorkerCursor(cursor), cursor);
  assert.throws(() => validateLocalIndexWorkerCursor({ ...cursor, finalTierSource: "unknown" }), {
    code: "local_index_worker_message_invalid",
  });
  assert.throws(() => validateLocalIndexWorkerCursor({
    ...cursor,
    finalTierRaw: null,
    finalTierObservedAtMs: null,
    finalTierSource: null,
    privateExtra: "synthetic",
  }), { code: "local_index_worker_message_invalid" });
  assert.throws(() => validateLocalIndexWorkerCursor({
    ...cursor,
    finalTierSource: null,
  }), { code: "local_index_worker_message_invalid" });
});

test("a cold build in lanes equals the sequential cold build", async () => {
  const workspace = createWorkspace();
  try {
    const sequentialFile = join(workspace.state, "v2-sequential.sqlite");
    const sequential = await refreshLocalIndex({
      codexHome: workspace.codexHome,
      indexFile: sequentialFile,
      secretFile: workspace.secretFile,
      workerCount: 1,
    });
    assert.equal(sequential.mode, "sequential");
    const expected = v2Facts(sequentialFile);
    assert.ok(expected.tools.length > 0 && expected.occurrences.length > 0);
    assert.ok(expected.snapshots.length > 0, "the corpus must exercise fork replay");
    assert.ok(sequential.usageEvents > 1_000);

    const file = join(workspace.state, "v2-lanes.sqlite");
    const result = await refreshLocalIndex({
      codexHome: workspace.codexHome,
      indexFile: file,
      secretFile: workspace.secretFile,
      workerCount: 3,
    });
    assert.equal(result.mode, "lanes");
    assert.equal(result.sourcesNew, sequential.sourcesNew, "lanes: sources");
    const actual = v2Facts(file);
    assert.equal(actual.provisional, 0);
    assertSameFacts(actual, expected, "lanes");
  } finally {
    workspace.cleanup();
  }
});

test("a second refresh with nothing changed opens no write transaction", async () => {
  const workspace = createWorkspace({ files: 20, events: 400 });
  try {
    const file = join(workspace.state, "v2.sqlite");
    const options = {
      codexHome: workspace.codexHome, indexFile: file, secretFile: workspace.secretFile,
      workerCount: 1,
    };
    const first = await refreshLocalIndex(options);
    assert.ok(first.writeTransactions > 0);
    const second = await refreshLocalIndex(options);
    assert.equal(second.writeTransactions, 0);
    assert.equal(second.unchanged, true);
    assert.equal(second.sourcesSkipped, first.sourcesNew);
  } finally {
    workspace.cleanup();
  }
});

test("appends resume and the result equals a cold build of the grown corpus", async () => {
  const workspace = createWorkspace({ files: 30, events: 900 });
  try {
    const live = join(workspace.state, "live.sqlite");
    const options = {
      codexHome: workspace.codexHome, secretFile: workspace.secretFile, workerCount: 1,
    };
    await refreshLocalIndex({ ...options, indexFile: live });
    const sources = workspace.receipt.sources.slice(-6);
    appendSyntheticCodexEvents(sources, {
      seed: 99, events: 5, fillerBytesPerEvent: 160, atMs: Date.parse("2026-09-02T00:00:00Z"),
    });
    const refreshed = await refreshLocalIndex({ ...options, indexFile: live });
    assert.ok(refreshed.sourcesResumed > 0);
    assert.equal(refreshed.sourcesRescanned, 0);
    assert.ok(refreshed.usageEvents > 0);

    const cold = join(workspace.state, "cold.sqlite");
    await refreshLocalIndex({ ...options, indexFile: cold });
    assertSameFacts(v2Facts(live), v2Facts(cold), "resume vs cold");
  } finally {
    workspace.cleanup();
  }
});

test("the store parser version names the extractor revision it was built with", () => {
  assert.ok(
    LOCAL_INDEX_PARSER_VERSION.endsWith(`+${LOCAL_UNIFIED_INDEX_PARSER_VERSION}`),
    "bump the store parser version with the extractor so every source is reparsed",
  );
});

test("the parser version is part of the catalog", async () => {
  const workspace = createWorkspace({ files: 5, events: 60 });
  try {
    const file = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: file, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const versions = db.prepare("SELECT DISTINCT parser_version AS v FROM source").all();
      assert.deepEqual(versions.map((row) => row.v), [LOCAL_INDEX_PARSER_VERSION]);
    } finally {
      db.close();
    }
  } finally {
    workspace.cleanup();
  }
});

test("an unchanged corpus is discovered from the catalog without header reads", async () => {
  const workspace = createWorkspace({ files: 24, events: 500 });
  try {
    const file = join(workspace.state, "v2.sqlite");
    const options = {
      codexHome: workspace.codexHome, indexFile: file, secretFile: workspace.secretFile,
      workerCount: 1,
    };
    await refreshLocalIndex(options);
    const { localCodexLogScanner } = await import("../src/local-node-runtime.js");
    let hits = 0;
    let misses = 0;
    const second = await refreshLocalIndex({
      ...options,
      discover: (discovery) => localCodexLogScanner.discoverCodexRolloutInfos({
        ...discovery,
        inspectionCache: (walked) => {
          const known = discovery.inspectionCache(walked);
          if (known === null) misses += 1; else hits += 1;
          return known;
        },
      }),
    });
    assert.equal(misses, 0);
    assert.equal(hits, workspace.receipt.files);
    assert.equal(second.writeTransactions, 0);

    // One appended source is the only one re-inspected.
    appendSyntheticCodexEvents(workspace.receipt.sources.slice(0, 1), {
      seed: 5, events: 2, fillerBytesPerEvent: 100, atMs: Date.parse("2026-09-04T00:00:00Z"),
    });
    hits = 0;
    misses = 0;
    await refreshLocalIndex({
      ...options,
      discover: (discovery) => localCodexLogScanner.discoverCodexRolloutInfos({
        ...discovery,
        inspectionCache: (walked) => {
          const known = discovery.inspectionCache(walked);
          if (known === null) misses += 1; else hits += 1;
          return known;
        },
      }),
    });
    assert.equal(misses, 1);
    assert.equal(hits, workspace.receipt.files - 1);
  } finally {
    workspace.cleanup();
  }
});

test("the rescan path proves a quota observation unused through an index, and an older store gains it", async () => {
  const workspace = createWorkspace({ files: 8, events: 200, days: 4, seed: 51 });
  try {
    const file = join(workspace.state, "v2.sqlite");
    const options = {
      codexHome: workspace.codexHome, indexFile: file, secretFile: workspace.secretFile, workerCount: 1,
    };
    await refreshLocalIndex(options);
    const plan = (database) => database.prepare(`
      EXPLAIN QUERY PLAN
      DELETE FROM quota_observation WHERE id = 1
        AND NOT EXISTS (SELECT 1 FROM usage_event WHERE quota_observation_id = 1)`)
      .all().map((row) => row.detail).join("\n");
    const inspect = (work) => {
      const database = new DatabaseSync(file);
      try { return work(database); } finally { database.close(); }
    };
    const planned = inspect(plan);
    assert.match(planned, /usage_event_quota/u);
    assert.doesNotMatch(planned, /SCAN usage_event(?! USING)/u, "no full scan of the events");

    // A store built before the index existed must gain it before any rewrite.
    inspect((database) => database.exec("DROP INDEX usage_event_quota"));
    assert.doesNotMatch(inspect(plan), /usage_event_quota/u);
    await refreshLocalIndex(options);
    assert.match(inspect(plan), /usage_event_quota/u);
  } finally {
    workspace.cleanup();
  }
});
