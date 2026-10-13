import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildLocalIndexAccountingCache,
  refreshLocalIndexAccountingCache,
} from "../src/local-index-accounting-cache.js";
import { readLocalIndexCompanionProjection } from "../src/local-index-companion-source.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import {
  assertReplaySafeAccountingCache,
  readReplaySafeAccountingCache,
} from "../src/replay-safe-accounting-cache.js";
import { appendSyntheticCodexEvents } from "../src/synthetic-codex-rollout-corpus.js";
import { createWorkspace } from "./helpers/local-index-facts.js";

const END_MS = Date.parse("2026-09-01T00:00:00.000Z");
const NOW_MS = END_MS + 3_600_000;

test("the v2 cache is bound to the generation the companion projection names", async () => {
  const workspace = createWorkspace({ variety: true, files: 24, events: 900, days: 8, seed: 31 });
  try {
    const v2File = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: v2File, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const g2 = (await readLocalIndexCompanionProjection({ indexFile: v2File, nowMs: NOW_MS })).generation;
    const actual = await buildLocalIndexAccountingCache({
      indexFile: v2File,
      expectedGeneration: { id: g2.id, fingerprint: g2.fingerprint },
      now: () => NOW_MS,
    });
    assertReplaySafeAccountingCache(actual);

    assert.equal(actual.sourceDescriptor.mode, "unified");
    assert.equal(actual.sourceDescriptor.generation, String(g2.id));
    assert.equal(actual.sourceDescriptor.generationFingerprint, g2.fingerprint);
    assert.equal(actual.history.status, "available");
    assert.equal(actual.periods.length, 4);
    assert.ok(actual.history.period.byModel.length > 0, "the history period holds events");
    assert.equal(actual.weeklyCalibrationInput.source, "unified_index");
  } finally {
    workspace.cleanup();
  }
});

test("a store that committed since the generation was read fails closed", async () => {
  const workspace = createWorkspace({ files: 10, events: 300, days: 5, seed: 32 });
  try {
    const v2File = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: v2File, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const before = (await readLocalIndexCompanionProjection({ indexFile: v2File, nowMs: NOW_MS })).generation;
    appendSyntheticCodexEvents(workspace.receipt.sources.slice(0, 2), {
      seed: 9, events: 3, fillerBytesPerEvent: 100, atMs: Date.parse("2026-09-02T00:00:00Z"),
    });
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: v2File, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    await assert.rejects(
      buildLocalIndexAccountingCache({
        indexFile: v2File,
        expectedGeneration: { id: before.id, fingerprint: before.fingerprint },
        now: () => NOW_MS,
      }),
      (error) => error.code === "accounting_unified_generation_mismatch",
    );
    const after = (await readLocalIndexCompanionProjection({ indexFile: v2File, nowMs: NOW_MS })).generation;
    const cache = await buildLocalIndexAccountingCache({
      indexFile: v2File,
      expectedGeneration: { id: after.id, fingerprint: after.fingerprint },
      now: () => NOW_MS,
    });
    assert.equal(cache.sourceDescriptor.generation, String(after.id));
  } finally {
    workspace.cleanup();
  }
});

test("the published cache is readable only against the generation it was built for", async () => {
  const workspace = createWorkspace({ files: 10, events: 300, days: 5, seed: 33 });
  try {
    const v2File = join(workspace.state, "v2.sqlite");
    const stateFile = join(workspace.state, "collector.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: v2File, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const generation = (await readLocalIndexCompanionProjection({
      indexFile: v2File, nowMs: NOW_MS,
    })).generation;
    const expectedGeneration = { id: generation.id, fingerprint: generation.fingerprint };
    const published = await refreshLocalIndexAccountingCache({
      stateFile, indexFile: v2File, expectedGeneration, now: () => NOW_MS,
    });
    assert.equal(published.sourceDescriptor.generation, String(generation.id));

    const read = await readReplaySafeAccountingCache({
      stateFile, sourceMode: "unified", expectedGeneration,
    });
    assert.equal(read.status, "available");
    assert.deepEqual(read.cache.periods, published.periods);

    const stale = await readReplaySafeAccountingCache({
      stateFile,
      sourceMode: "unified",
      expectedGeneration: { id: generation.id + 1, fingerprint: generation.fingerprint },
    });
    assert.notEqual(stale.status, "available");
  } finally {
    workspace.cleanup();
  }
});
