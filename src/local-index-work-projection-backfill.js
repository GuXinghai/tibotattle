import {
  auditWorkRollups,
  rebuildWorkRollupRange,
  WORK_ROLLUP_DAY_MS,
} from "./local-index-work-rollup.js";
import {
  auditWorkloadBuckets,
  rebuildWorkloadBucketRange,
  WORKLOAD_BUCKET_MS,
} from "./local-index-workload-bucket.js";
import { committedPredicate } from "./local-index-rollup.js";

// Bounded, resumable construction of the v11 work projections from committed
// usage facts. It never reads a rollout, never moves a source cursor and never
// creates an integrity gap for unchanged evidence. Each call replaces one
// aligned time range per projection inside its own transaction; completed
// ranges survive cancellation and WAL deferral.

export const WORK_PROJECTION_BACKFILL_BATCH_MS = 86_400_000;
export const WORK_PROJECTION_BACKFILL_MAX_EVENTS = 20_000;
export const WORK_PROJECTION_NAMES = Object.freeze(["work_rollup", "workload_bucket"]);

export function readWorkProjectionStatuses(database) {
  const rows = database.prepare(`
    SELECT projection_name, status, attempt, updated_at_ms
    FROM projection_watermark WHERE partition_key = 'all'`).all();
  const statuses = { work_rollup: null, workload_bucket: null };
  for (const row of rows) {
    if (Object.hasOwn(statuses, row.projection_name)) {
      statuses[row.projection_name] = {
        status: row.status,
        attempt: Number(row.attempt),
        updatedAtMs: row.updated_at_ms === null ? null : Number(row.updated_at_ms),
      };
    }
  }
  return statuses;
}

export function workProjectionBackfillPending(database) {
  const statuses = readWorkProjectionStatuses(database);
  return WORK_PROJECTION_NAMES.some((name) => statuses[name]?.status !== "ready");
}

function committedBounds(database) {
  return database.prepare(`
    SELECT MIN(u.observed_at_ms) AS first_at, MAX(u.observed_at_ms) AS last_at
    FROM usage_event u WHERE ${committedPredicate("u")}`).get();
}

function alignDown(value, size) {
  return Math.floor(value / size) * size;
}

function alignUp(value, size) {
  return Math.ceil(value / size) * size;
}

function ensureQueue(database, projection, nowMs) {
  const existing = database.prepare(`
    SELECT * FROM repair_queue
    WHERE scope_kind = 'projection_backfill' AND scope_key = ?
    ORDER BY queue_id LIMIT 1`).get(projection);
  if (existing !== undefined) return existing;
  const bounds = committedBounds(database);
  const size = projection === "work_rollup" ? WORK_ROLLUP_DAY_MS : WORKLOAD_BUCKET_MS;
  const lower = bounds.first_at === null ? 0 : alignDown(Number(bounds.first_at), size);
  const upper = bounds.last_at === null ? 0 : alignUp(Number(bounds.last_at) + 1, size);
  const inserted = database.prepare(`
    INSERT INTO repair_queue(scope_kind, scope_key, lower_ms, upper_ms, priority,
      reason, attempt, next_retry_at_ms, status, lease_owner, lease_expires_at_ms,
      created_at_ms, updated_at_ms)
    VALUES ('projection_backfill', ?, ?, ?, 100, 'projection_backfill', 0, NULL,
      'queued', NULL, NULL, ?, ?)`).run(projection, lower, upper, nowMs, nowMs);
  return database.prepare("SELECT * FROM repair_queue WHERE queue_id = ?")
    .get(Number(inserted.lastInsertRowid));
}

function eventCount(database, fromMs, toMs) {
  return Number(database.prepare(`
    SELECT COUNT(*) AS n FROM usage_event u
    WHERE ${committedPredicate("u")} AND u.observed_at_ms >= ? AND u.observed_at_ms < ?`)
    .get(fromMs, toMs).n);
}

function batchRange(database, projection, queue, maxEvents) {
  const size = projection === "work_rollup" ? WORK_ROLLUP_DAY_MS : WORKLOAD_BUCKET_MS;
  const lower = Number(queue.lower_ms);
  const upper = Math.max(Number(queue.upper_ms), lower);
  if (lower >= upper) return { from: lower, to: upper };
  let to = Math.min(upper, lower + WORK_PROJECTION_BACKFILL_BATCH_MS);
  // A projection row covers a whole day or five-minute bucket. Never delete a
  // partially covered row; align every non-final boundary down to the row size.
  if (to < upper) to = alignDown(to, size);
  if (to <= lower) to = Math.min(upper, lower + size);
  // Bound one transaction by the number of facts it must regroup. Halve the
  // candidate range, but never below one whole projection row; a single
  // oversized day or bucket is accepted rather than split illegally.
  while (to < upper && eventCount(database, lower, to) > maxEvents) {
    const span = to - lower;
    const next = lower + Math.max(size, alignDown(Math.floor(span / 2), size));
    if (next >= to) break;
    to = next;
  }
  return { from: lower, to };
}

function basisFingerprint(database) {
  return database.prepare("SELECT value FROM meta WHERE key = 'rollup_basis'").get()?.value ?? null;
}

function markReady(database, projection, commitSeq, nowMs) {
  database.prepare(`
    UPDATE projection_watermark SET status = 'ready', last_change_seq = ?,
      computed_at_ms = ?, attempt = attempt + 1, updated_at_ms = ?,
      basis_fingerprint = ?
    WHERE projection_name = ? AND partition_key = 'all'`)
    .run(commitSeq, nowMs, nowMs, basisFingerprint(database), projection);
}

function auditOne(database, projection) {
  return projection === "work_rollup"
    ? auditWorkRollups(database)
    : auditWorkloadBuckets(database);
}

/**
 * Replace at most one aligned range per projection. The caller owns the
 * surrounding write transaction, so a partially applied batch rolls back.
 * Returns `{ status: "pending" | "ready", projections: [...] }`.
 */
export function backfillWorkProjectionBatch(database, {
  nowMs = Date.now(),
  maxEvents = WORK_PROJECTION_BACKFILL_MAX_EVENTS,
  commitSeq = 0,
} = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    throw new TypeError("maxEvents must be a positive safe integer");
  }
  const processed = [];
  let allReady = true;
  for (const projection of WORK_PROJECTION_NAMES) {
    let watermark = database.prepare(`
      SELECT * FROM projection_watermark
      WHERE projection_name = ? AND partition_key = 'all'`).get(projection);
    if (watermark === undefined) {
      database.prepare(`
        INSERT INTO projection_watermark(projection_name, partition_key, status)
        VALUES (?, 'all', 'pending')`).run(projection);
      watermark = database.prepare(`
        SELECT * FROM projection_watermark
        WHERE projection_name = ? AND partition_key = 'all'`).get(projection);
    }
    if (watermark.status === "ready") {
      processed.push({ projection, status: "ready", audit: 0 });
      continue;
    }
    const queue = ensureQueue(database, projection, nowMs);
    if (queue.status === "done") {
      const audit = auditOne(database, projection);
      if (audit === 0) {
        markReady(database, projection, commitSeq, nowMs);
        processed.push({ projection, status: "ready", audit: 0 });
        continue;
      }
      allReady = false;
      database.prepare(`
        UPDATE projection_watermark SET status = 'stale', attempt = attempt + 1,
          updated_at_ms = ? WHERE projection_name = ? AND partition_key = 'all'`)
        .run(nowMs, projection);
      processed.push({ projection, status: "stale", audit });
      continue;
    }
    const range = batchRange(database, projection, queue, maxEvents);
    if (range.from < range.to) {
      if (projection === "work_rollup") {
        rebuildWorkRollupRange(database, range.from, range.to);
      } else {
        rebuildWorkloadBucketRange(database, range.from, range.to);
      }
    }
    const finished = range.to >= Number(queue.upper_ms);
    database.prepare(`
      UPDATE repair_queue SET lower_ms = ?, status = ?, attempt = attempt + 1,
        updated_at_ms = ? WHERE queue_id = ?`)
      .run(finished ? Number(queue.upper_ms) : range.to,
        finished ? "done" : "queued", nowMs, Number(queue.queue_id));
    database.prepare(`
      UPDATE projection_watermark SET status = 'building', last_change_seq = ?,
        attempt = attempt + 1, updated_at_ms = ?
      WHERE projection_name = ? AND partition_key = 'all'`)
      .run(commitSeq, nowMs, projection);
    processed.push({
      projection, status: finished ? "auditing" : "building",
      fromMs: range.from, toMs: range.to, finished,
    });
    allReady = false;
  }
  return { status: allReady ? "ready" : "pending", projections: processed };
}
