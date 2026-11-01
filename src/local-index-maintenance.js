import { existsSync, statSync } from "node:fs";
import { Worker, parentPort, workerData } from "node:worker_threads";

import { auditPairing, rebuildPairing } from "./local-index-pairing.js";
import { auditRollups, rebuildRollups } from "./local-index-rollup.js";
import { auditWorkRollups, rebuildWorkRollups } from "./local-index-work-rollup.js";
import { auditWorkloadBuckets, rebuildWorkloadBuckets } from "./local-index-workload-bucket.js";
import {
  backfillWorkProjectionBatch,
  readWorkProjectionStatuses,
  workProjectionBackfillPending,
} from "./local-index-work-projection-backfill.js";
import {
  IMPACT_MANIFEST_RETENTION_CHANGES,
  pruneImpactManifest,
} from "./local-index-impact.js";
import { LOCAL_INDEX_WAL_LIMITS, localIndexWalHardLimit } from "./local-index-refresh.js";
import {
  createLocalIndexWriter, openLocalIndexStore, readCommitSeq, withReadSnapshot,
} from "./local-index-store.js";

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function differences(database) {
  const projections = readWorkProjectionStatuses(database);
  const ready = (name) => projections[name]?.status === "ready";
  const rollup = auditRollups(database);
  const work = ready("work_rollup") ? auditWorkRollups(database) : 0;
  const workload = ready("workload_bucket") ? auditWorkloadBuckets(database) : 0;
  const pairing = auditPairing(database);
  return {
    rollup, work, workload, pairing, projections,
    consistent: rollup === 0 && work === 0 && workload === 0 && pairing === 0
      && ready("work_rollup") && ready("workload_bucket"),
  };
}

function walBytes(indexFile) {
  try { return statSync(`${indexFile}-wal`).size; }
  catch (error) { if (error?.code !== "ENOENT") throw error; return 0; }
}

function reserveBytes(database) {
  // Reserve two complete store footprints (including WAL frame overhead)
  // before a full regroup. This deliberately overestimates derived-only work
  // and defers under pinned-reader or disk pressure rather than ignoring the
  // ingestion resource policy. Recheck under the writer lock.
  const pages = Number(database.prepare("PRAGMA page_count").get().page_count);
  const pageBytes = Number(database.prepare("PRAGMA page_size").get().page_size);
  return 2 * pages * (pageBytes + 24) + 32;
}

function underPressure(indexFile, database, walLimits) {
  return walBytes(indexFile) + reserveBytes(database) >= localIndexWalHardLimit(indexFile, walLimits);
}

function markProjectionsReady(database, nowMs, commitSeq) {
  const basis = database.prepare("SELECT value FROM meta WHERE key='rollup_basis'").get()?.value ?? null;
  for (const projection of ["work_rollup", "workload_bucket"]) {
    database.prepare(`
      UPDATE projection_watermark SET status='ready', last_change_seq=?,
        computed_at_ms=?, attempt=attempt+1, updated_at_ms=?, basis_fingerprint=?
      WHERE projection_name=? AND partition_key='all'`)
      .run(commitSeq, nowMs, nowMs, basis, projection);
  }
}

function rebuildStaleProjections(database, nowMs, commitSeq) {
  rebuildWorkRollups(database);
  rebuildWorkloadBuckets(database);
  markProjectionsReady(database, nowMs, commitSeq);
  database.prepare(
    "DELETE FROM repair_queue WHERE scope_kind='projection_backfill'",
  ).run();
}

// No rollout or secret access. The writer lock fences a second audit and the
// rebuild together, so another process cannot invalidate the repair decision.
function maintain(indexFile, walLimits, options = {}) {
  if (!existsSync(indexFile)) throw failure("local_index_maintenance_unavailable");
  const maxBatches = Number.isSafeInteger(options.maxBackfillBatches)
    && options.maxBackfillBatches > 0 ? options.maxBackfillBatches : 8;
  const maxEvents = Number.isSafeInteger(options.maxBackfillEvents)
    && options.maxBackfillEvents > 0 ? options.maxBackfillEvents : 20_000;
  const keepChanges = Number.isSafeInteger(options.manifestRetentionChanges)
    && options.manifestRetentionChanges > 0
    ? options.manifestRetentionChanges : IMPACT_MANIFEST_RETENTION_CHANGES;
  let database = openLocalIndexStore(indexFile, { readOnly: true });
  let changeCount = 0;
  try {
    const result = withReadSnapshot(database, ({ commitSeq }) => {
      changeCount = Number(database.prepare(
        "SELECT COUNT(*) AS n FROM source_change",
      ).get().n);
      return { status: "audited", commitSeq, ...differences(database) };
    });
    if (result.consistent && changeCount <= keepChanges) return result;
  } finally {
    database.close();
  }
  database = openLocalIndexStore(indexFile);
  const writer = createLocalIndexWriter(database);
  let manifestPruned = 0;
  try {
    if (changeCount > keepChanges) {
      writer.begin();
      manifestPruned = pruneImpactManifest(database, { keepChanges }).deletedChanges;
      if (manifestPruned > 0) writer.commit({ bumpSeq: false });
      else writer.rollback();
    }
    const pruned = manifestPruned > 0 ? { manifestPruned } : {};
    // Repair only the tables that are ready. A pending projection is built by
    // bounded batches below; an empty projection is never called consistent.
    writer.begin();
    let before = differences(database);
    if (before.rollup > 0 || before.pairing > 0
        || (before.work > 0 && before.projections.work_rollup?.status === "ready")
        || (before.workload > 0 && before.projections.workload_bucket?.status === "ready")
        || before.projections.work_rollup?.status === "stale"
        || before.projections.workload_bucket?.status === "stale") {
      if (underPressure(indexFile, database, walLimits)) {
        throw failure("local_index_maintenance_deferred");
      }
      const stale = before.projections.work_rollup?.status === "stale"
        || before.projections.workload_bucket?.status === "stale";
      if (before.rollup > 0) rebuildRollups(database);
      if (stale) {
        // The following verify commit publishes the readiness atomically.
        rebuildStaleProjections(database, Date.now(), readCommitSeq(database) + 1);
      } else {
        if (before.work > 0) rebuildWorkRollups(database);
        if (before.workload > 0) rebuildWorkloadBuckets(database);
      }
      if (before.pairing > 0) rebuildPairing(database);
      const after = differences(database);
      if (!after.consistent && !workProjectionBackfillPending(database)) {
        throw failure("local_index_maintenance_inconsistent");
      }
      const commitSeq = writer.commit({ kind: "verify", sourcesChanged: 0 });
      const found = {
        rollup: before.rollup, work: before.work,
        workload: before.workload, pairing: before.pairing,
      };
      if (after.consistent) return { status: "repaired", commitSeq, ...after, ...found, ...pruned };
      return { status: "pending", commitSeq, ...after, ...found, ...pruned };
    }
    writer.rollback();

    // Initial v11 backfill: bounded per-projection ranges, each committed
    // separately so a cancellation or WAL deferral resumes at the last range.
    if (workProjectionBackfillPending(database)) {
      for (let batch = 0; batch < maxBatches; batch += 1) {
        if (underPressure(indexFile, database, walLimits)) {
          return {
            status: "pending", deferred: "wal_pressure",
            commitSeq: readCommitSeq(database), ...differences(database),
          };
        }
        writer.begin();
        const currentSeq = readCommitSeq(database);
        const nextSeq = currentSeq + 1;
        const step = backfillWorkProjectionBatch(database, {
          nowMs: Date.now(), maxEvents, commitSeq: currentSeq,
        });
        if (step.status === "ready") {
          // The final readiness publication is the next sequence. A building
          // batch must keep pointing at the publication it was built through.
          database.prepare(`
            UPDATE projection_watermark SET last_change_seq=?
            WHERE partition_key='all'`).run(nextSeq);
        }
        // Readiness is published exactly once, atomically with the last batch.
        writer.commit(step.status === "ready"
          ? { kind: "verify", sourcesChanged: 0 }
          : { bumpSeq: false });
        if (step.status === "ready") {
          const after = differences(database);
          if (after.consistent) {
            return { status: "repaired", commitSeq: readCommitSeq(database), ...after, ...pruned };
          }
          return { status: "pending", commitSeq: readCommitSeq(database), ...after, ...pruned };
        }
      }
      return { status: "pending", commitSeq: readCommitSeq(database), ...differences(database), ...pruned };
    }

    const after = differences(database);
    if (!after.consistent) throw failure("local_index_maintenance_inconsistent");
    return { status: "audited", commitSeq: readCommitSeq(database), ...after, ...pruned };
  } finally {
    try { writer.rollback(); } catch { /* already committed */ }
    database.close();
  }
}

/** Off-thread audit and atomic repair, aborted by terminating the SQLite owner. */
export function maintainLocalIndex({
  indexFile, signal = null, walLimits = LOCAL_INDEX_WAL_LIMITS, maxBackfillBatches, maxBackfillEvents,
  manifestRetentionChanges,
} = {}) {
  if (signal?.aborted) return Promise.reject(failure("local_index_maintenance_cancelled"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./local-index-maintenance.js", import.meta.url), {
      workerData: {
        operation: "maintenance", indexFile, walLimits,
        maxBackfillBatches, maxBackfillEvents, manifestRetentionChanges,
      },
    });
    let result = null;
    let error = null;
    const abort = () => {
      error = failure("local_index_maintenance_cancelled");
      void worker.terminate();
    };
    signal?.addEventListener("abort", abort, { once: true });
    // Close the registration race with an abort arriving during worker creation.
    if (signal?.aborted) abort();
    worker.on("message", (message) => {
      if (["audited", "repaired", "pending"].includes(message?.status)) result = message;
      else error ??= failure(message?.status === "deferred"
        ? "local_index_maintenance_deferred" : "local_index_maintenance_failed");
    });
    worker.on("error", () => { error ??= failure("local_index_maintenance_failed"); });
    worker.on("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      if (error !== null) reject(error);
      else if (code !== 0 || result === null) reject(failure("local_index_maintenance_failed"));
      else resolve(Object.freeze(result));
    });
  });
}

if (parentPort !== null && workerData?.operation === "maintenance") {
  try {
    parentPort.postMessage(maintain(workerData.indexFile, workerData.walLimits, {
      maxBackfillBatches: workerData.maxBackfillBatches,
      maxBackfillEvents: workerData.maxBackfillEvents,
      manifestRetentionChanges: workerData.manifestRetentionChanges,
    }));
  } catch (error) {
    // Native/SQLite errors may contain private paths; only this fixed token
    // crosses the worker boundary.
    parentPort.postMessage({ status: error?.code === "local_index_maintenance_deferred" ? "deferred" : "failed" });
  }
}
