import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { readLocalIndexGenerationIdentity } from "../src/local-index-companion-source.js";
import {
  createLocalIndexUsageExplainerReaders,
  localIndexUsageExplainerOptions,
} from "../src/local-index-usage-explainer.js";
import { openLocalIndexStore } from "../src/local-index-store.js";
import { createLocalUsageExplainer } from "../src/local-usage-explainer.js";
import { createWorkspace } from "./helpers/local-index-facts.js";

const FROM_MS = Date.parse("2026-08-20T00:00:00Z");
const TO_MS = Date.parse("2026-09-02T00:00:00Z");
// The corpus has quota rows and non-monotonic series inside the window.
const CORPUS = {
  variety: true, files: 30, events: 1_800, days: 6, seed: 23,
  fillerBytesPerEvent: 0, quotaRate: 1, endAt: "2026-09-01T00:00:00.000Z",
};

async function buildV2(workspace) {
  const v2File = join(workspace.state, "v2.sqlite");
  await refreshLocalIndex({
    codexHome: workspace.codexHome, indexFile: v2File, secretFile: workspace.secretFile,
    workerCount: 1,
  });
  return v2File;
}

test("the v2 health is available with the companion's generation, and unavailable otherwise", async () => {
  const workspace = createWorkspace(CORPUS);
  try {
    const v2File = await buildV2(workspace);
    const { readHealth } = createLocalIndexUsageExplainerReaders();
    const health = readHealth({ indexFile: v2File });
    assert.equal(health.status, "available");
    assert.equal(health.errorCode, null);
    assert.ok(["complete", "partial"].includes(health.generation.status));
    assert.match(health.generation.fingerprint, /^generation-v2-[0-9a-f]{64}$/u);
    const identity = readLocalIndexGenerationIdentity({ indexFile: v2File });
    assert.deepEqual(
      { id: health.generation.id, fingerprint: health.generation.fingerprint },
      identity,
      "the explainer and the companion must name the same publication",
    );

    const unavailable = {
      status: "unavailable",
      errorCode: "usage_explainer_index_unavailable",
      generation: null,
    };
    assert.deepEqual(readHealth({ indexFile: join(workspace.state, "absent.sqlite") }), unavailable);

    const neverCommitted = join(workspace.state, "empty.sqlite");
    openLocalIndexStore(neverCommitted, { create: true }).close();
    assert.deepEqual(readHealth({ indexFile: neverCommitted }), unavailable);
  } finally {
    workspace.cleanup();
  }
});

test("the v2 allowance movement classifies every admitted row exactly once", async () => {
  const workspace = createWorkspace(CORPUS);
  try {
    const v2File = await buildV2(workspace);
    const { readAllowance, readHealth } = createLocalIndexUsageExplainerReaders();
    const page = readAllowance({
      indexFile: v2File, fromMs: FROM_MS, toMs: TO_MS, offset: 0, limit: 25,
    });
    assert.equal(page.status, "available");
    assert.ok(page.rowCount > 0, "the corpus must carry quota rows in the window");
    assert.ok(page.nonMonotonicCount > 0, "the corpus must reach a non-monotonic series");
    assert.equal(
      page.observedMovementCount + page.nonMonotonicCount
        + page.resetIdentityMissingCount + page.singleObservationCount,
      page.rowCount,
    );
    assert.equal(page.generation.fingerprint, readHealth({ indexFile: v2File }).generation.fingerprint);
  } finally {
    workspace.cleanup();
  }
});

test("allowance pages concatenate to the same list whatever their size", async () => {
  const workspace = createWorkspace(CORPUS);
  try {
    const v2File = await buildV2(workspace);
    const { readAllowance } = createLocalIndexUsageExplainerReaders();
    const pages = (indexFile, limit) => {
      const windows = [];
      let offset = 0;
      let rowCount = null;
      for (let guard = 0; guard < 10_000; guard += 1) {
        const page = readAllowance({ indexFile, fromMs: FROM_MS, toMs: TO_MS, offset, limit });
        assert.equal(page.status, "available");
        rowCount ??= page.rowCount;
        assert.equal(page.rowCount, rowCount);
        windows.push(...page.windows);
        if (page.nextOffset === null) return { windows, rowCount };
        assert.equal(page.nextOffset, offset + page.windows.length);
        offset = page.nextOffset;
      }
      throw new Error("pagination did not terminate");
    };
    const small = pages(v2File, 2);
    const large = pages(v2File, 7);
    assert.equal(small.windows.length, small.rowCount);
    assert.deepEqual(small.windows, large.windows);
  } finally {
    workspace.cleanup();
  }
});

test("invalid allowance input is rejected before the store is opened", () => {
  const workspace = createWorkspace({ variety: true, files: 6, events: 120, days: 3, seed: 72 });
  try {
    const v2File = join(workspace.state, "v2.sqlite");
    const { readAllowance } = createLocalIndexUsageExplainerReaders();
    const bad = [
      { indexFile: "" },
      { fromMs: -1 },
      { toMs: FROM_MS - 1 },
      { offset: -1 },
      { limit: 0 },
      { limit: 26 },
      { fromMs: 1.5 },
    ];
    for (const override of bad) {
      const input = { indexFile: v2File, fromMs: FROM_MS, toMs: TO_MS, ...override };
      assert.throws(() => readAllowance(input), TypeError, JSON.stringify(Object.keys(override)));
    }
  } finally {
    workspace.cleanup();
  }
});

test("the v2 work usage is one scope's snapshot of the window, and fails closed", async () => {
  const workspace = createWorkspace(CORPUS);
  try {
    const v2File = await buildV2(workspace);
    const { readWorkUsage } = createLocalIndexUsageExplainerReaders();
    const actual = await readWorkUsage({
      indexFile: v2File, secretFile: workspace.secretFile, codexHome: workspace.codexHome,
      fromMs: FROM_MS, toMs: TO_MS,
    });
    assert.equal(actual.status, "available");
    assert.ok(actual.cells.length > 0, "the window must carry work cells");
    assert.ok(Array.isArray(actual.scopes) && actual.scopes.length > 0);

    const missing = await readWorkUsage({
      indexFile: join(workspace.state, "absent.sqlite"), secretFile: workspace.secretFile,
      codexHome: workspace.codexHome, fromMs: FROM_MS, toMs: TO_MS,
    });
    assert.equal(missing.status, "missing");
    await assert.rejects(
      () => readWorkUsage({
        indexFile: v2File, secretFile: workspace.secretFile, codexHome: workspace.codexHome,
        fromMs: TO_MS, toMs: FROM_MS,
      }),
      { code: "local_unified_index_work_query_invalid" },
    );
  } finally {
    workspace.cleanup();
  }
});

test("the explainer options carry the v2 readers and the service reads the store through them", async () => {
  const options = localIndexUsageExplainerOptions();
  assert.deepEqual(Object.keys(options.localIndexReaders).sort(), ["readAllowance", "readHealth", "readWorkUsage"]);
  assert.throws(
    () => createLocalUsageExplainer({ indexFile: "/synthetic/index.sqlite" }),
    TypeError,
    "the readers are required: the explainer never defaults to a store reader",
  );

  const workspace = createWorkspace(CORPUS);
  try {
    const v2File = await buildV2(workspace);
    const explainer = createLocalUsageExplainer({
      indexFile: v2File,
      secretFile: workspace.secretFile,
      codexHome: workspace.codexHome,
      clock: () => TO_MS,
      ...options,
    });
    const health = await explainer.query({
      schemaVersion: "local-usage-explainer-v1", plan: "data_health", period: "7d", limit: 5,
    });
    assert.equal(health.status, "available");
    assert.ok(!JSON.stringify(health).includes(workspace.root), "no private path in the result");
  } finally {
    workspace.cleanup();
  }
});
