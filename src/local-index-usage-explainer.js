import { lstatSync } from "node:fs";

import { projectLocalAllowanceMovementRows } from "./local-usage-explainer.js";
import { describeLocalIndexGeneration } from "./local-index-companion-source.js";
import { readLocalIndexReport } from "./local-index-report.js";
import { readLocalIndexWorkUsage } from "./local-index-work-usage.js";
import {
  openLocalIndexStore,
  readCommitSeq,
  withReadSnapshot,
} from "./local-index-store.js";
import { workUsageError } from "./reporting/index.js";

// The usage explainer's three readers over the v2 local index store.
//
// They accept the argument objects that local-usage-explainer.js injects into
// createUsageExplainerService. The store is opened read-only and is never
// created, migrated or written here. Errors are mapped to fixed codes; no path
// leaves this module.

const ALLOWANCE_SOURCE_LIMIT = 25;
const UNAVAILABLE_INDEX = "usage_explainer_index_unavailable";
const UNAVAILABLE_ALLOWANCE = "usage_explainer_allowance_unavailable";
const WORK_QUERY_INVALID = "local_unified_index_work_query_invalid";

function fixedErrorCode(error, fallback) {
  return typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,99}$/u.test(error.code)
    ? error.code
    : fallback;
}

/**
 * Open the store read-only, when it is a regular file. `null` means there is
 * no store to read; a missing file throws ENOENT from the lstat.
 */
function openStore(indexFile) {
  const metadata = lstatSync(indexFile);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
  return openLocalIndexStore(indexFile, { readOnly: true });
}

/**
 * The publication descriptor of one read snapshot, built the way the companion
 * projection builds it, so the fingerprint agrees with that projection's.
 */
function generationAt(database, commitSeq) {
  if (!Number.isSafeInteger(commitSeq) || commitSeq < 1) return null;
  const report = readLocalIndexReport(database, { nowMs: Date.now() });
  return describeLocalIndexGeneration(database, report, commitSeq);
}

function unavailableHealth() {
  return { status: "unavailable", errorCode: UNAVAILABLE_INDEX, generation: null };
}

function readHealth({ indexFile } = {}) {
  let database = null;
  try {
    database = openStore(indexFile);
    if (database === null) return unavailableHealth();
    const generation = withReadSnapshot(database, ({ commitSeq }) => (
      generationAt(database, commitSeq)
    ));
    if (generation === null) return unavailableHealth();
    return { status: "available", errorCode: null, generation };
  } catch {
    return unavailableHealth();
  } finally {
    database?.close();
  }
}

// The allowance query over quota occurrences. A fact is committed
// when its line-end offset lies within the source's scanned bytes; the
// tie-break is the fact's stable key, so the order is total and reproducible.
const ALLOWANCE_MOVEMENT_QUERY = `
  WITH eligible AS (
    SELECT q.observed_at_ms, q.provider, q.plan_type, q.limit_id,
           q.used_percent, q.resets_at_ms, q.duration_mins,
           src.source_local, q.source_offset, q.slot_order
    FROM quota_occurrence q
    JOIN source src ON src.id = q.source_id
    WHERE q.admission = 'admitted'
      AND q.source_offset <= src.scanned_bytes
      AND q.observed_at_ms >= ?
      AND q.observed_at_ms < ?
  ), ranked AS (
    SELECT *,
      ROW_NUMBER() OVER (
        PARTITION BY provider, COALESCE(plan_type, ''), limit_id,
          duration_mins, COALESCE(resets_at_ms, -1)
        ORDER BY observed_at_ms, source_local, source_offset, slot_order
      ) AS first_rank,
      ROW_NUMBER() OVER (
        PARTITION BY provider, COALESCE(plan_type, ''), limit_id,
          duration_mins, COALESCE(resets_at_ms, -1)
        ORDER BY observed_at_ms DESC, source_local DESC, source_offset DESC, slot_order DESC
      ) AS last_rank
    FROM eligible
  ), collapsed AS (
    SELECT provider, COALESCE(plan_type, 'unknown') AS plan_type, limit_id,
           duration_mins, resets_at_ms,
           MIN(observed_at_ms) AS first_observed_at_ms,
           MAX(observed_at_ms) AS last_observed_at_ms,
           MAX(CASE WHEN first_rank = 1 THEN used_percent END) AS first_used_percent,
           MAX(CASE WHEN last_rank = 1 THEN used_percent END) AS last_used_percent,
           COUNT(*) AS observation_count
    FROM ranked
    GROUP BY provider, COALESCE(plan_type, ''), limit_id,
             duration_mins, COALESCE(resets_at_ms, -1)
  ), classified AS (
    SELECT *, CASE
      WHEN resets_at_ms IS NULL THEN 3
      WHEN observation_count < 2 THEN 4
      WHEN last_used_percent >= first_used_percent THEN 1
      ELSE 2
    END AS movement_status_rank
    FROM collapsed
  )
  SELECT *,
    COUNT(*) OVER () AS total_count,
    SUM(CASE WHEN movement_status_rank = 1 THEN 1 ELSE 0 END)
      OVER () AS observed_count,
    SUM(CASE WHEN movement_status_rank = 2 THEN 1 ELSE 0 END)
      OVER () AS non_monotonic_count,
    SUM(CASE WHEN movement_status_rank = 3 THEN 1 ELSE 0 END)
      OVER () AS reset_identity_missing_count,
    SUM(CASE WHEN movement_status_rank = 4 THEN 1 ELSE 0 END)
      OVER () AS single_observation_count
  FROM classified
  ORDER BY movement_status_rank,
           CASE WHEN movement_status_rank = 1
             THEN ABS(last_used_percent - first_used_percent)
             ELSE NULL
           END DESC,
           last_observed_at_ms DESC,
           provider, plan_type, limit_id,
           duration_mins, COALESCE(resets_at_ms, -1)
  LIMIT ? OFFSET ?`;

function unavailableAllowance(errorCode, generation = null) {
  return {
    status: "unavailable",
    errorCode,
    generation,
    windows: [],
    truncated: false,
    rowCount: 0,
    observedMovementCount: 0,
    resetIdentityMissingCount: 0,
    singleObservationCount: 0,
    nonMonotonicCount: 0,
    nextOffset: null,
  };
}

function readAllowance({
  indexFile,
  fromMs,
  toMs,
  offset = 0,
  limit = ALLOWANCE_SOURCE_LIMIT,
} = {}) {
  if (
    typeof indexFile !== "string"
    || indexFile.length < 1
    || !Number.isSafeInteger(fromMs)
    || fromMs < 0
    || !Number.isSafeInteger(toMs)
    || toMs < fromMs
    || !Number.isSafeInteger(offset)
    || offset < 0
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > ALLOWANCE_SOURCE_LIMIT
  ) {
    throw new TypeError("allowance movement input is invalid");
  }
  let database = null;
  try {
    database = openStore(indexFile);
    if (database === null) return unavailableAllowance(UNAVAILABLE_ALLOWANCE);
    const read = withReadSnapshot(database, ({ commitSeq }) => {
      const generation = generationAt(database, commitSeq);
      if (generation === null) return { generation, rows: null };
      const rows = database.prepare(ALLOWANCE_MOVEMENT_QUERY).all(
        fromMs,
        toMs,
        limit,
        offset,
      );
      return { generation, rows };
    });
    if (read.rows === null) return unavailableAllowance(UNAVAILABLE_ALLOWANCE, read.generation);
    const { generation, rows } = read;
    const first = rows.length === 0 ? null : rows[0];
    const rowCount = first === null ? 0 : Number(first.total_count);
    const nextOffset = offset + rows.length < rowCount
      ? offset + rows.length
      : null;
    return {
      status: "available",
      errorCode: null,
      generation,
      windows: projectLocalAllowanceMovementRows(rows),
      truncated: nextOffset !== null,
      rowCount,
      observedMovementCount: first === null ? 0 : Number(first.observed_count),
      resetIdentityMissingCount: first === null ? 0 : Number(first.reset_identity_missing_count),
      singleObservationCount: first === null ? 0 : Number(first.single_observation_count),
      nonMonotonicCount: first === null ? 0 : Number(first.non_monotonic_count),
      nextOffset,
    };
  } catch (error) {
    return unavailableAllowance(fixedErrorCode(error, UNAVAILABLE_ALLOWANCE));
  } finally {
    database?.close();
  }
}

/**
 * The work-usage snapshot of the explainer's window: one scope's snapshot of
 * the `custom` period. The work read is
 * asynchronous, so the store's commit sequence is compared before and after;
 * a commit in between claims nothing.
 */
async function readWorkUsage({
  indexFile,
  secretFile = null,
  codexHome,
  fromMs,
  toMs,
  signal = null,
} = {}) {
  if (
    !Number.isSafeInteger(fromMs)
    || fromMs < 0
    || !Number.isSafeInteger(toMs)
    || toMs < fromMs
  ) {
    throw workUsageError(WORK_QUERY_INVALID);
  }
  let database = null;
  try {
    database = openStore(indexFile);
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unavailable" };
  }
  if (database === null) return { status: "unavailable" };
  try {
    const before = readCommitSeq(database);
    if (!Number.isSafeInteger(before) || before < 1) return { status: "unavailable" };
    const result = await readLocalIndexWorkUsage({
      database,
      indexFile,
      codexHome,
      secretFile,
      nowMs: toMs,
      signal,
      intervals: [{ id: "custom", fromMs, toMs }],
    });
    if (readCommitSeq(database) !== before) return { status: "unavailable" };
    const period = result.periods.custom;
    const selected = period.scopes.find((scope) => scope.status === "unavailable")?.id
      ?? period.scopes[0]?.id
      ?? "scope-0";
    if (!period.snapshots[selected]) {
      throw workUsageError("work_usage_scope_unavailable");
    }
    return period.snapshots[selected];
  } finally {
    database.close();
  }
}

/** The three readers the usage explainer injects, over the v2 store. */
export function createLocalIndexUsageExplainerReaders() {
  return Object.freeze({ readHealth, readWorkUsage, readAllowance });
}

/**
 * The explainer options a composition root spreads into
 * `createLocalUsageExplainer`: the v2 readers. The store is the only index.
 */
export function localIndexUsageExplainerOptions() {
  return Object.freeze({ localIndexReaders: createLocalIndexUsageExplainerReaders() });
}
