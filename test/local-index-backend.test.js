import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createCachedLocalUnifiedProjectionReader } from "../apps/local/server.js";
import { buildLocalCompanionSnapshot } from "../src/local-companion-data.js";
import { createLocalCollectorRefreshRunner } from "../src/local-companion-refresh.js";
import { createLocalIndexBackend } from "../src/local-index-backend.js";
import {
  readLocalIndexCompanionProjection,
  readLocalIndexGenerationIdentity,
  readLocalIndexProjectionValidUntil,
} from "../src/local-index-companion-source.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { readLocalIndexWindowBreakdown } from "../src/local-index-window-breakdown.js";
import { appendSyntheticCodexEvents } from "../src/synthetic-codex-rollout-corpus.js";
import { createWorkspace } from "./helpers/local-index-facts.js";

const END_MS = Date.parse("2026-09-01T00:00:00.000Z");
const NOW_MS = END_MS + 3_600_000;

const COLLECTED_INDEXING = Object.freeze({
  mode: "recent_7d",
  status: "recent_7d_complete",
  phase: "complete",
  boundedBy: "modified_at_and_collection_start",
  filesDiscovered: 1,
  filesSelected: 1,
  filesProcessed: 1,
  recordsWritten: 1,
  coveredAt: { startAt: "2026-08-25T00:00:00.000Z", endAt: "2026-09-01T00:00:00.000Z" },
});

// The collector's own pass is out of scope here; this stands in for it so the
// runner's unified-index and accounting steps are the ones under test.
function collector(recordsWritten) {
  return async () => ({
    rolloutRecordsWritten: recordsWritten(),
    filesDiscovered: 1,
    refresh: { attempted: false, recordWritten: false, errorCode: null },
    indexing: COLLECTED_INDEXING,
  });
}

function compose(workspace, backend, { written }) {
  const indexFile = backend.indexFile;
  const stateFile = join(workspace.state, "collector.sqlite");
  const runner = createLocalCollectorRefreshRunner({
    codexHome: workspace.codexHome,
    stateFile,
    accountingSourceMode: "unified",
    unifiedIndexFile: indexFile,
    unifiedIndexSecretFile: workspace.secretFile,
    selectAccountObservationSecret: () => ({ loadAccountObservationSecret: null }),
    runCollector: collector(written),
    refreshUnifiedIndex: backend.refreshUnifiedIndex,
    refreshAccounting: backend.refreshAccounting,
    clock: () => NOW_MS,
  });
  const snapshot = async () => {
    const root = mkdtempSync(join(tmpdir(), "backend-snapshot-"));
    try {
      return await buildLocalCompanionSnapshot({
        root,
        collectorStateFile: stateFile,
        accountingSourceMode: "unified",
        unifiedIndexFile: indexFile,
        unifiedProjectionReader: (options, controls) => backend.projectionReader.reader(options, controls),
        now: () => NOW_MS,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  return { runner, snapshot, stateFile };
}

test("the runner publishes the v2 generation and the snapshot reads the cache built for it", async () => {
  const workspace = createWorkspace({ variety: true, files: 20, events: 600, days: 6, seed: 41 });
  try {
    const indexFile = join(workspace.state, "v2.sqlite");
    const backend = createLocalIndexBackend({
      indexFile, secretFile: workspace.secretFile, workerCount: 1, now: () => NOW_MS,
    });
    let written = 1;
    const { runner, snapshot } = compose(workspace, backend, { written: () => written });

    const first = await runner();
    assert.equal(first.unifiedIndex.status, "ingested");
    assert.equal(first.unifiedIndex.unchanged, false);
    assert.ok(first.unifiedIndex.generation.id >= 1);
    assert.ok(first.unifiedIndex.totalUsageEvents > 0);
    assert.equal(first.accounting.sourceMode, "unified");
    assert.equal(first.accounting.refreshStatus, "rebuilt");

    const before = await snapshot();
    assert.equal(before.overview.accounting.generation, String(first.unifiedIndex.generation.id));
    assert.equal(
      before.overview.accounting.generationFingerprint, first.unifiedIndex.generation.fingerprint,
    );

    // Nothing was collected and nothing grew: the same publication, the same
    // cache, no work.
    written = 0;
    const idle = await runner();
    assert.equal(idle.unifiedIndex.unchanged, true);
    assert.equal(idle.unifiedIndex.generation.id, first.unifiedIndex.generation.id);
    assert.equal(idle.accounting.refreshStatus, "reused");

    // New events advance the publication; the cache follows it.
    appendSyntheticCodexEvents(workspace.receipt.sources.slice(0, 2), {
      seed: 9, events: 4, fillerBytesPerEvent: 100, atMs: Date.parse("2026-09-01T00:30:00Z"),
    });
    written = 1;
    const grown = await runner();
    assert.ok(grown.unifiedIndex.generation.id > first.unifiedIndex.generation.id);
    assert.equal(grown.accounting.refreshStatus, "rebuilt");
    const after = await snapshot();
    assert.equal(after.overview.accounting.generation, String(grown.unifiedIndex.generation.id));
    assert.ok(
      after.overview.accounting.periods.length === before.overview.accounting.periods.length,
    );
  } finally {
    workspace.cleanup();
  }
});

test("a refresh that deferred under log pressure is not a publication", async () => {
  const workspace = createWorkspace({ files: 6, events: 120, days: 4, seed: 42 });
  try {
    const indexFile = join(workspace.state, "v2.sqlite");
    const backend = createLocalIndexBackend({
      indexFile,
      secretFile: workspace.secretFile,
      workerCount: 1,
      refresh: async () => ({ status: "deferred", deferred: { reason: "wal_limit" } }),
    });
    const { runner } = compose(workspace, backend, { written: () => 1 });
    const result = await runner();
    assert.equal(result.unifiedIndex.status, "failed");
    assert.equal(result.unifiedIndex.errorCode, "local_unified_index_publication_busy");
    assert.notEqual(result.accounting?.refreshStatus, "rebuilt");
  } finally {
    workspace.cleanup();
  }
});

test("ordinals are seeded from the previous index only while the store is empty", async () => {
  const workspace = createWorkspace({ files: 8, events: 200, days: 4, seed: 43 });
  try {
    // The previous index is read only through its ordinal map, injected below.
    const legacy = join(workspace.state, "legacy.sqlite");
    writeFileSync(legacy, "");
    // An existing installation's identity is required for ordinal carry.
    writeFileSync(workspace.secretFile, Buffer.alloc(32, 43), { mode: 0o600 });
    const legacyOrdinals = new Map([["ab".repeat(32), 7]]);
    const readOrdinalMap = () => ({ ordinalSeed: legacyOrdinals });
    const indexFile = join(workspace.state, "v2.sqlite");
    const seeds = [];
    const backend = createLocalIndexBackend({
      indexFile,
      secretFile: workspace.secretFile,
      legacyIndexFile: legacy,
      workerCount: 1,
      readOrdinalMap,
      refresh: async (options) => {
        seeds.push(options.ordinalSeed);
        return refreshLocalIndex(options);
      },
    });
    await backend.refreshUnifiedIndex({ codexHome: workspace.codexHome });
    await backend.refreshUnifiedIndex({ codexHome: workspace.codexHome });
    assert.equal(seeds[0], legacyOrdinals, "first pass carries the map");
    assert.equal(seeds[1], null, "a store with sources is never reseeded");

    // An unreadable previous index must not silently mint fresh ordinals.
    const failing = createLocalIndexBackend({
      indexFile: join(workspace.state, "other.sqlite"),
      secretFile: workspace.secretFile,
      legacyIndexFile: legacy,
      workerCount: 1,
      readOrdinalMap: () => { throw new Error("unreadable"); },
    });
    await assert.rejects(
      failing.refreshUnifiedIndex({ codexHome: workspace.codexHome }),
      (error) => error.code === "local_unified_index_legacy_ordinals_unavailable",
    );
  } finally {
    workspace.cleanup();
  }
});

test("the projection reader callbacks plug into the cached reader and honour the publication", async () => {
  const workspace = createWorkspace({ files: 10, events: 300, days: 5, seed: 44 });
  try {
    const indexFile = join(workspace.state, "v2.sqlite");
    const backend = createLocalIndexBackend({
      indexFile, secretFile: workspace.secretFile, workerCount: 1, now: () => NOW_MS,
    });
    await backend.refreshUnifiedIndex({ codexHome: workspace.codexHome });

    const identity = readLocalIndexGenerationIdentity({ indexFile });
    const projection = await readLocalIndexCompanionProjection({ indexFile, nowMs: NOW_MS });
    assert.deepEqual(identity, {
      id: projection.generation.id, fingerprint: projection.generation.fingerprint,
    });
    assert.equal(readLocalIndexGenerationIdentity({ indexFile: join(workspace.state, "none") }), null);

    // A different publication, or none at all, is never reusable.
    assert.equal(
      readLocalIndexProjectionValidUntil({
        indexFile, generationFingerprint: `generation-v2-${"0".repeat(64)}`, nowMs: NOW_MS,
      }),
      NOW_MS,
    );
    const validUntil = readLocalIndexProjectionValidUntil({
      indexFile, generationFingerprint: identity.fingerprint, nowMs: NOW_MS, includeWorkUsage: true,
    });
    assert.ok(validUntil > NOW_MS);

    const cached = createCachedLocalUnifiedProjectionReader(backend.projectionReader);
    try {
      const options = {
        mode: "full", indexFile, nowMs: NOW_MS, includeWorkUsage: true,
        codexHome: workspace.codexHome, secretFile: workspace.secretFile,
      };
      const first = await cached(options);
      assert.equal(first.companion.status, "available");
      assert.equal(first.companion.generation.fingerprint, identity.fingerprint);
      const second = await cached(options);
      assert.deepEqual(second.companion.generation, first.companion.generation);
    } finally {
      await cached.close();
    }
  } finally {
    workspace.cleanup();
  }
});

test("a projection stays exact until the instant the validity bound names", async () => {
  const workspace = createWorkspace({ variety: true, files: 16, events: 500, days: 6, seed: 45 });
  try {
    const indexFile = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile, secretFile: workspace.secretFile, workerCount: 1,
    });
    // Place the clock just inside the corpus so periods and the future cutoff
    // both have rows near their boundaries.
    const nowMs = END_MS - 30 * 3_600_000;
    const read = (at) => readLocalIndexCompanionProjection({ indexFile, nowMs: at });
    const { fingerprint } = readLocalIndexGenerationIdentity({ indexFile });
    const base = await read(nowMs);
    const until = readLocalIndexProjectionValidUntil({
      indexFile, generationFingerprint: fingerprint, nowMs,
    });
    assert.ok(until > nowMs && Number.isFinite(until), "the corpus has a pending boundary");

    const comparable = (projection) => ({
      usageEvents: projection.usageEvents,
      quotaObservations: projection.quotaObservations,
      usage: projection.usage,
      timeline: projection.timeline,
    });
    const inside = await read(until - 1);
    assert.deepEqual(comparable(inside), comparable(base));
    const outside = await read(until);
    assert.notDeepEqual(comparable(outside), comparable(base));
  } finally {
    workspace.cleanup();
  }
});

test("the window breakdown answers the store's ranges and refuses an invalid one", async () => {
  const workspace = createWorkspace({ variety: true, files: 20, events: 700, days: 7, seed: 46 });
  try {
    const v2File = join(workspace.state, "v2.sqlite");
    await refreshLocalIndex({
      codexHome: workspace.codexHome, indexFile: v2File, secretFile: workspace.secretFile,
      workerCount: 1,
    });
    const day = 24 * 3_600_000;
    for (const [fromMs, toMs] of [
      [END_MS - 3 * day, END_MS - day],
      [END_MS - 10 * day, END_MS + day],
      [END_MS - 2 * day - 17, END_MS - 2 * day + 4_001],
    ]) {
      const actual = await readLocalIndexWindowBreakdown({ indexFile: v2File, fromMs, toMs });
      assert.equal(actual.status, "available");
    }
    const whole = await readLocalIndexWindowBreakdown({
      indexFile: v2File, fromMs: END_MS - 10 * day, toMs: END_MS + day,
    });
    assert.ok(whole.events > 0 && whole.byModel.length > 0, "the corpus has priced events");

    await assert.rejects(
      readLocalIndexWindowBreakdown({ indexFile: v2File, fromMs: 5, toMs: 5 }),
      (error) => error.code === "window_range_invalid",
    );
    const missing = await readLocalIndexWindowBreakdown({
      indexFile: join(workspace.state, "missing.sqlite"), fromMs: 1, toMs: 2,
    });
    assert.equal(missing.status, "unavailable");
  } finally {
    workspace.cleanup();
  }
});

test("refresh progress is counts only and monotone", async () => {
  const workspace = createWorkspace({ files: 12, events: 240, days: 4, seed: 47 });
  try {
    const reports = [];
    const backend = createLocalIndexBackend({
      indexFile: join(workspace.state, "v2.sqlite"), secretFile: workspace.secretFile,
      workerCount: 1,
    });
    await backend.refreshUnifiedIndex({
      codexHome: workspace.codexHome,
      onProgress: (value) => { reports.push(value); },
    });
    assert.ok(reports.length >= 1);
    let scanned = 0;
    let events = 0;
    for (const report of reports) {
      assert.deepEqual(Object.keys(report).sort(), ["sources", "sourcesScanned", "usageEvents"]);
      assert.ok(report.sourcesScanned <= report.sources);
      assert.ok(report.sourcesScanned >= scanned && report.usageEvents >= events);
      scanned = report.sourcesScanned;
      events = report.usageEvents;
    }
    // A consumer that throws never fails the refresh.
    const again = await backend.refreshUnifiedIndex({
      codexHome: workspace.codexHome,
      onProgress: () => { throw new Error("consumer failure"); },
    });
    assert.equal(again.status, "ingested");
  } finally {
    workspace.cleanup();
  }
});

test("a missing or stale-stamped store gets the cold refresh deadline", async () => {
  const workspace = createWorkspace({ files: 6, events: 90, days: 3, seed: 48 });
  try {
    const indexFile = join(workspace.state, "v2.sqlite");
    const backend = createLocalIndexBackend({
      indexFile, secretFile: workspace.secretFile, workerCount: 1,
    });
    const timeouts = { existingTimeoutMs: 300_000, freshTimeoutMs: 14_400_000 };
    assert.equal(backend.refreshTimeoutMs(timeouts), 14_400_000);
    await backend.refreshUnifiedIndex({ codexHome: workspace.codexHome });
    assert.equal(backend.refreshTimeoutMs(timeouts), 300_000);

    const database = new DatabaseSync(indexFile);
    try {
      database.exec("UPDATE source SET parser_version = 'older-stamp' WHERE rowid = (SELECT MIN(rowid) FROM source)");
    } finally {
      database.close();
    }
    assert.equal(backend.refreshTimeoutMs(timeouts), 14_400_000);
  } finally {
    workspace.cleanup();
  }
});

test("the local index backend exposes no contribution reader or publication bridge", () => {
  const workspace = createWorkspace({ files: 1, events: 2, days: 1, seed: 49 });
  try {
    const backend = createLocalIndexBackend({ indexFile: join(workspace.state, "v2.sqlite"), secretFile: workspace.secretFile, workerCount: 1 });
    assert.equal(Object.hasOwn(backend, "contribution"), false);
  } finally { workspace.cleanup(); }
});

test("the audit is read-only, content-free and sees a derived table that drifted", async () => {
  const workspace = createWorkspace({ variety: true, files: 8, events: 240, days: 4, seed: 50 });
  try {
    const indexFile = join(workspace.state, "v2.sqlite");
    const backend = createLocalIndexBackend({
      indexFile, secretFile: workspace.secretFile, workerCount: 1,
    });
    assert.deepEqual(backend.audit(), { status: "unavailable", consistent: false });
    await backend.refreshUnifiedIndex({ codexHome: workspace.codexHome });

    const clean = backend.audit();
    assert.equal(clean.status, "audited");
    assert.equal(clean.consistent, true);
    assert.deepEqual([clean.rollup, clean.work, clean.pairing], [0, 0, 0]);
    assert.deepEqual(Object.keys(clean).sort(),
      ["commitSeq", "consistent", "pairing", "rollup", "status", "work"]);

    const database = new DatabaseSync(indexFile);
    try {
      database.exec("UPDATE usage_rollup SET events = events + 1");
    } finally {
      database.close();
    }
    const drifted = backend.audit();
    assert.equal(drifted.consistent, false);
    assert.ok(drifted.rollup > 0);
    assert.equal(drifted.commitSeq, clean.commitSeq, "the audit does not commit");
  } finally {
    workspace.cleanup();
  }
});
