import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { backfillWorkProjectionBatch, readWorkProjectionStatuses } from "../src/local-index-work-projection-backfill.js";
import { auditWorkRollups } from "../src/local-index-work-rollup.js";
import { auditWorkloadBuckets } from "../src/local-index-workload-bucket.js";
import {
  createLocalIndexWriter,
  openLocalIndexStore,
} from "../src/local-index-store.js";

const DAY = 86_400_000;
const BASE = Date.UTC(2026, 8, 1);

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "local-index-work-projection-"));
  return {
    root,
    file: join(root, "index.sqlite"),
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function seed(writer, count = 24) {
  const sessionId = writer.internSession(Buffer.alloc(32, 9), null);
  const surfaceId = writer.internSurface({
    agentScope: "root", surface: "codex", threadSource: "cli",
    lineageDisposition: "standalone",
  });
  const modelA = writer.internModel("gpt-5.5", "recognized");
  const modelB = writer.internModel("gpt-5.5-mini", "recognized");
  const tierA = writer.internTier({
    apiServiceTier: "standard", billingSurface: "subscription",
    codexSpeedMode: "standard", tierSource: "observed", providerTierRaw: null,
  });
  const tierB = writer.internTier({
    apiServiceTier: "priority", billingSurface: "subscription",
    codexSpeedMode: "fast", tierSource: "observed", providerTierRaw: null,
  });
  const accountA = writer.internAccountScope({
    status: "available", reason: null, planType: "plus", scopeLocal: Buffer.alloc(32, 4),
  });
  const accountB = writer.internAccountScope({
    status: "unavailable", reason: "missing_account", planType: null, scopeLocal: null,
  });
  const directoryA = writer.internWorkDirectory("/synthetic/a");
  const directoryB = writer.internWorkDirectory("/synthetic/b");
  const source = writer.registerSource({
    sourceLocal: Buffer.alloc(32, 2), ordinal: 0, sessionId, surfaceId,
    path: "synthetic.jsonl", rolloutKey: "synthetic", sizeBytes: 1_000_000, mtimeMs: 1,
  });
  for (let index = 0; index < count; index += 1) {
    writer.writeUsageEvent({
      sourceId: source.id,
      sourceOffset: 100 + index,
      observedAtMs: BASE + index * 7 * 60_000 + (index % 3) * DAY,
      eventKey: Buffer.alloc(32, index + 1),
      sessionId,
      accountScopeId: index % 4 === 0 ? accountB : accountA,
      modelId: index % 2 === 0 ? modelA : modelB,
      tierId: index % 3 === 0 ? tierB : tierA,
      surfaceId,
      reasoningEffort: 8,
      partial: index % 5 === 0,
      cacheWriteAssumedZero: index % 7 === 0,
      statusOnly: index % 11 === 0,
      workDirectoryId: index % 5 === 0 ? null : index % 2 === 0 ? directoryA : directoryB,
      tokensInUncached: index % 11 === 0 ? null : 10 + index,
      tokensInCacheRead: index % 7 === 0 ? null : index,
      tokensInCacheWrite: index % 5 === 0 ? 0 : 2,
      tokensOutText: index % 11 === 0 ? null : 3,
      tokensOutReasoning: index % 11 === 0 ? null : 1,
      tokensOutCombined: index % 11 === 0 ? null : 4,
      totalInputContext: index % 6 === 0 ? null : 1000 + index,
    });
  }
  writer.commitSourceState(source.id, {
    sessionId, surfaceId, path: "synthetic.jsonl", rolloutKey: "synthetic",
    sizeBytes: 1_000_000, mtimeMs: 1, scannedBytes: 100 + count,
    diagnostics: { tokenCounts: count },
  });
  return { sourceId: source.id, sessionId, surfaceId, modelA, modelB, tierA, tierB, accountA, accountB, directoryA, directoryB };
}

test("both work projections match a fresh grouping after insert, cursor movement and key updates", () => {
  const f = workspace();
  try {
    const database = openLocalIndexStore(f.file, { create: true });
    const writer = createLocalIndexWriter(database);
    try {
      writer.begin();
      const ids = seed(writer);
      writer.commit();
      assert.equal(auditWorkRollups(database), 0);
      assert.equal(auditWorkloadBuckets(database), 0);
      assert.ok(Number(database.prepare(
        "SELECT COUNT(*) AS n FROM work_rollup WHERE tier_id = ?",
      ).get(ids.tierB).n) > 0, "the v2 key separates tiers");
      assert.ok(Number(database.prepare(
        "SELECT COUNT(*) AS n FROM workload_bucket WHERE bucket_start_ms % ? = 0",
      ).get(5 * 60_000).n) > 0, "buckets align to five minutes");

      // Mutate every participating key and measure column. The update
      // triggers must subtract the old row and accumulate the new one.
      database.prepare(`UPDATE usage_event SET model_id=?, tier_id=?,
        account_scope_id=?, work_directory_id=?, observed_at_ms=observed_at_ms + ?,
        flags=flags | 1, tokens_in_uncached=tokens_in_uncached + 1,
        tokens_in_cache_read=tokens_in_cache_read + 2,
        total_input_context=COALESCE(total_input_context, 0) + 3
        WHERE source_offset = ?`)
        .run(ids.modelB, ids.tierB, ids.accountB, ids.directoryB, 60_000, 101);
      assert.equal(auditWorkRollups(database), 0, "work rollup after update");
      assert.equal(auditWorkloadBuckets(database), 0, "workload bucket after update");

      // Deleting a range retreats the cursor first, so both projections undo
      // the removed facts exactly once.
      writer.begin();
      writer.deleteSourceFacts(ids.sourceId, { fromOffset: 110 });
      writer.commit();
      assert.equal(auditWorkRollups(database), 0, "work rollup after delete");
      assert.equal(auditWorkloadBuckets(database), 0, "workload bucket after delete");
      assert.equal(
        Number(database.prepare("SELECT COALESCE(SUM(events),0) AS n FROM workload_bucket").get().n),
        Number(database.prepare("SELECT COUNT(*) AS n FROM usage_event u WHERE u.source_offset <= (SELECT scanned_bytes FROM source WHERE id=u.source_id)").get().n),
      );
    } finally {
      database.close();
    }
  } finally {
    f.cleanup();
  }
});

test("bounded backfill builds both projections from committed facts and resumes to readiness", () => {
  const f = workspace();
  try {
    const database = openLocalIndexStore(f.file, { create: true });
    const writer = createLocalIndexWriter(database);
    try {
      writer.begin();
      seed(writer, 60);
      writer.commit();
      const before = {
        sources: database.prepare("SELECT COUNT(*) AS n FROM source").get().n,
        usage: database.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n,
        sequence: database.prepare("SELECT commit_seq FROM store_state WHERE id=1").get().commit_seq,
      };
      database.exec("DELETE FROM work_rollup; DELETE FROM workload_bucket");
      database.prepare("UPDATE projection_watermark SET status='pending', attempt=0, computed_at_ms=NULL")
        .run();
      database.prepare("DELETE FROM repair_queue WHERE scope_kind='projection_backfill'").run();

      let steps = 0;
      let status = "pending";
      while (status !== "ready" && steps < 100) {
        writer.begin();
        const step = backfillWorkProjectionBatch(database, {
          nowMs: BASE + steps, maxEvents: 5,
        });
        writer.commit(step.status === "ready"
          ? { kind: "verify", sourcesChanged: 0 }
          : { bumpSeq: false });
        status = step.status;
        steps += 1;
      }
      assert.equal(status, "ready", `backfill needed ${steps} steps`);
      assert.ok(steps > 1, "the bounded batch policy split the history");
      assert.equal(auditWorkRollups(database), 0);
      assert.equal(auditWorkloadBuckets(database), 0);
      assert.deepEqual(
        Object.fromEntries(Object.entries(readWorkProjectionStatuses(database))
          .map(([name, value]) => [name, value.status])),
        { work_rollup: "ready", workload_bucket: "ready" },
      );
      assert.deepEqual({
        sources: database.prepare("SELECT COUNT(*) AS n FROM source").get().n,
        usage: database.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n,
        sequence: database.prepare("SELECT commit_seq FROM store_state WHERE id=1").get().commit_seq,
      }, {
        ...before,
        // The final readiness publication is the only sequence bump.
        sequence: before.sequence + 1,
      });
      assert.equal(database.prepare(
        "SELECT COUNT(*) AS n FROM repair_queue WHERE scope_kind='projection_backfill' AND status='done'",
      ).get().n, 2);
    } finally {
      database.close();
    }
  } finally {
    f.cleanup();
  }
});
