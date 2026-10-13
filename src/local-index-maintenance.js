import { existsSync, statSync } from "node:fs";
import { Worker, parentPort, workerData } from "node:worker_threads";

import { auditPairing, rebuildPairing } from "./local-index-pairing.js";
import { auditRollups, rebuildRollups } from "./local-index-rollup.js";
import { auditWorkRollups, rebuildWorkRollups } from "./local-index-work-rollup.js";
import { LOCAL_INDEX_WAL_LIMITS, localIndexWalHardLimit } from "./local-index-refresh.js";
import {
  createLocalIndexWriter, openLocalIndexStore, readCommitSeq, withReadSnapshot,
} from "./local-index-store.js";

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function differences(database) {
  const rollup = auditRollups(database);
  const work = auditWorkRollups(database);
  const pairing = auditPairing(database);
  return { rollup, work, pairing, consistent: rollup === 0 && work === 0 && pairing === 0 };
}

// No rollout or secret access. The writer lock fences a second audit and the
// rebuild together, so another process cannot invalidate the repair decision.
function maintain(indexFile, walLimits) {
  if (!existsSync(indexFile)) throw failure("local_index_maintenance_unavailable");
  let database = openLocalIndexStore(indexFile, { readOnly: true });
  try {
    const result = withReadSnapshot(database, ({ commitSeq }) => ({
      status: "audited", commitSeq, ...differences(database),
    }));
    if (result.consistent) return result;
  } finally {
    database.close();
  }
  database = openLocalIndexStore(indexFile);
  const writer = createLocalIndexWriter(database);
  try {
    writer.begin();
    const before = differences(database);
    if (before.consistent) {
      const commitSeq = readCommitSeq(database);
      writer.rollback();
      return { status: "audited", commitSeq, ...before };
    }
    let walBytes = 0;
    try { walBytes = statSync(`${indexFile}-wal`).size; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    // Reserve two complete store footprints (including WAL frame overhead)
    // before a full regroup. This deliberately overestimates derived-only work
    // and defers under pinned-reader or disk pressure rather than ignoring the
    // ingestion resource policy. Recheck under the writer lock.
    const pages = Number(database.prepare("PRAGMA page_count").get().page_count);
    const pageBytes = Number(database.prepare("PRAGMA page_size").get().page_size);
    const reserveBytes = 2 * pages * (pageBytes + 24) + 32;
    if (walBytes + reserveBytes >= localIndexWalHardLimit(indexFile, walLimits)) {
      throw failure("local_index_maintenance_deferred");
    }
    if (before.rollup > 0) rebuildRollups(database);
    if (before.work > 0) rebuildWorkRollups(database);
    if (before.pairing > 0) rebuildPairing(database);
    if (!differences(database).consistent) throw failure("local_index_maintenance_inconsistent");
    const commitSeq = writer.commit({ kind: "verify", sourcesChanged: 0 });
    return { status: "repaired", commitSeq, ...before, consistent: true };
  } finally {
    writer.rollback();
    database.close();
  }
}

/** Off-thread audit and atomic repair, aborted by terminating the SQLite owner. */
export function maintainLocalIndex({ indexFile, signal = null, walLimits = LOCAL_INDEX_WAL_LIMITS } = {}) {
  if (signal?.aborted) return Promise.reject(failure("local_index_maintenance_cancelled"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./local-index-maintenance.js", import.meta.url), {
      workerData: { operation: "maintenance", indexFile, walLimits },
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
      if (message?.status === "audited" || message?.status === "repaired") result = message;
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
    parentPort.postMessage(maintain(workerData.indexFile, workerData.walLimits));
  } catch (error) {
    // Native/SQLite errors may contain private paths; only this fixed token
    // crosses the worker boundary.
    parentPort.postMessage({ status: error?.code === "local_index_maintenance_deferred" ? "deferred" : "failed" });
  }
}
