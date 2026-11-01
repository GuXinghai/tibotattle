import {
  committedPredicate,
  rollupKeyExpressions,
} from "./local-index-rollup.js";

// Five-minute workload projection for the overview workload reader.
//
// A bucket is the exact sum of the committed usage events that share one key:
//
//   bucket_start_ms   five-minute UTC bucket (negative instants floor down)
//   session_id        store session row
//   model_id          store model row
//   tier_id           speed mode and API tier, resolved at read time
//   account_scope_id  attributed or not
//   shape, ctx_class  as in usage_rollup
//
// plus the event count, the six token sums and `last_at_ms`. No price is
// stored: the reader prices each bucket with the same `usageProjection` path
// as raw events. `last_at_ms` preserves open-task activity when the latest
// event of a bucket was deleted; a cleared value is recomputed by the reader
// from the bucket's committed events.
//
// The key deliberately omits provenance flags. Every trigger that can change a
// key or measure is covered: insert, delete, cursor advance/retreat and an
// update of any participating column.

export const WORKLOAD_BUCKET_SCHEMA_VERSION = 1;
export const WORKLOAD_BUCKET_MS = 5 * 60 * 1_000;

const KEY_COLUMNS = Object.freeze([
  "bucket_start_ms", "session_id", "model_id", "tier_id",
  "account_scope_id", "shape", "ctx_class",
]);

const SUM_COLUMNS = Object.freeze([
  ["in_uncached", "tokens_in_uncached"],
  ["in_cache_read", "tokens_in_cache_read"],
  ["in_cache_write", "tokens_in_cache_write"],
  ["out_text", "tokens_out_text"],
  ["out_reasoning", "tokens_out_reasoning"],
  ["out_combined", "tokens_out_combined"],
]);

const UPDATE_COLUMNS = Object.freeze([
  "session_id", "model_id", "tier_id", "account_scope_id", "observed_at_ms",
  ...SUM_COLUMNS.map(([, source]) => source), "total_input_context",
]);

export const WORKLOAD_BUCKET_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workload_bucket(
    bucket_start_ms INTEGER NOT NULL,
    session_id INTEGER NOT NULL,
    model_id INTEGER NOT NULL,
    tier_id INTEGER NOT NULL,
    account_scope_id INTEGER NOT NULL,
    shape INTEGER NOT NULL,
    ctx_class INTEGER NOT NULL,
    events INTEGER NOT NULL,
    in_uncached INTEGER NOT NULL,
    in_cache_read INTEGER NOT NULL,
    in_cache_write INTEGER NOT NULL,
    out_text INTEGER NOT NULL,
    out_reasoning INTEGER NOT NULL,
    out_combined INTEGER NOT NULL,
    last_at_ms INTEGER,
    PRIMARY KEY(bucket_start_ms, session_id, model_id, tier_id,
                account_scope_id, shape, ctx_class)) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS workload_bucket_observed
    ON workload_bucket(bucket_start_ms, session_id);
`;

function keyExpressions(row) {
  const usage = rollupKeyExpressions(row);
  const at = `${row}.observed_at_ms`;
  return {
    bucket_start_ms: `CASE WHEN ${at} >= 0 THEN (${at} / ${WORKLOAD_BUCKET_MS}) * ${WORKLOAD_BUCKET_MS}`
      + ` ELSE ((${at} - ${WORKLOAD_BUCKET_MS - 1}) / ${WORKLOAD_BUCKET_MS}) * ${WORKLOAD_BUCKET_MS} END`,
    session_id: `${row}.session_id`,
    model_id: `${row}.model_id`,
    tier_id: `${row}.tier_id`,
    account_scope_id: `${row}.account_scope_id`,
    shape: usage.shape,
    ctx_class: usage.ctx_class,
  };
}

function sums(row) {
  return SUM_COLUMNS.map(([target, source]) => [target, `COALESCE(${row}.${source}, 0)`]);
}

/** A grouping of committed facts (or a cursor range of them). */
export function workloadBucketGroupSql({ alias = "u", where = committedPredicate("u"), sign = 1 } = {}) {
  const key = keyExpressions(alias);
  const negate = sign < 0 ? "-" : "";
  return `
    SELECT ${KEY_COLUMNS.map((name) => `${key[name]} AS ${name}`).join(",\n           ")},
           ${negate}COUNT(*) AS events,
           ${sums(alias).map(([target, expression]) => `${negate}SUM(${expression}) AS ${target}`).join(",\n           ")},
           MAX(${alias}.observed_at_ms) AS last_at_ms
    FROM usage_event ${alias}
    WHERE ${where}
    GROUP BY ${KEY_COLUMNS.join(", ")}`;
}

/**
 * A grouping restricted to one half-open observed-time range. The range is
 * inclusive at `fromMs` and exclusive at `toMs`, matching the backfill batches.
 */
export function workloadBucketRangeSql(fromMs, toMs, { alias = "u", sign = 1 } = {}) {
  const where = `${committedPredicate(alias)} AND ${alias}.observed_at_ms >= ${fromMs}`
    + ` AND ${alias}.observed_at_ms < ${toMs}`;
  return workloadBucketGroupSql({ alias, where, sign });
}

function triggerSql() {
  const added = keyExpressions("NEW");
  const removed = keyExpressions("OLD");
  const keyList = KEY_COLUMNS.join(", ");
  const sumList = SUM_COLUMNS.map(([target]) => target).join(", ");
  const accumulate = (clearLast) => `ON CONFLICT(${keyList}) DO UPDATE SET
        events = events + excluded.events,
        ${SUM_COLUMNS.map(([target]) => `${target} = ${target} + excluded.${target}`).join(",\n        ")},
        last_at_ms = ${clearLast ? "NULL" : "MAX(last_at_ms, excluded.last_at_ms)"};`;
  const range = (from, to) => `u.source_id = NEW.id AND u.source_offset > ${from}`
    + ` AND u.source_offset <= ${to}`;
  const keyMatch = KEY_COLUMNS.map((name) => `${name} = ${removed[name]}`).join("\n        AND ");
  return `
    CREATE TRIGGER IF NOT EXISTS workload_bucket_insert AFTER INSERT ON usage_event
    WHEN NEW.source_offset <= (SELECT scanned_bytes FROM source WHERE id = NEW.source_id)
    BEGIN
      INSERT INTO workload_bucket(${keyList}, events, ${sumList}, last_at_ms)
      VALUES (${KEY_COLUMNS.map((name) => added[name]).join(", ")}, 1,
          ${sums("NEW").map(([, expression]) => expression).join(", ")}, NEW.observed_at_ms)
      ${accumulate(false)}
    END;

    CREATE TRIGGER IF NOT EXISTS workload_bucket_delete AFTER DELETE ON usage_event
    WHEN OLD.source_offset <= (SELECT scanned_bytes FROM source WHERE id = OLD.source_id)
    BEGIN
      UPDATE workload_bucket SET
        events = events - 1,
        ${sums("OLD").map(([target, expression]) => `${target} = ${target} - ${expression}`).join(",\n        ")},
        last_at_ms = CASE WHEN last_at_ms = OLD.observed_at_ms THEN NULL ELSE last_at_ms END
      WHERE ${keyMatch};
    END;

    CREATE TRIGGER IF NOT EXISTS workload_bucket_update
    AFTER UPDATE OF ${UPDATE_COLUMNS.join(", ")} ON usage_event
    WHEN OLD.source_offset <= (SELECT scanned_bytes FROM source WHERE id = OLD.source_id)
      AND NEW.source_offset <= (SELECT scanned_bytes FROM source WHERE id = NEW.source_id)
    BEGIN
      UPDATE workload_bucket SET
        events = events - 1,
        ${sums("OLD").map(([target, expression]) => `${target} = ${target} - ${expression}`).join(",\n        ")},
        last_at_ms = CASE WHEN last_at_ms = OLD.observed_at_ms THEN NULL ELSE last_at_ms END
      WHERE ${keyMatch};
      DELETE FROM workload_bucket WHERE ${keyMatch} AND events = 0;
      INSERT INTO workload_bucket(${keyList}, events, ${sumList}, last_at_ms)
      VALUES (${KEY_COLUMNS.map((name) => added[name]).join(", ")}, 1,
          ${sums("NEW").map(([, expression]) => expression).join(", ")}, NEW.observed_at_ms)
      -- The old row may still hold later events; a new maximum is not the
      -- true maximum. A cleared value is explicit and recomputed by readers.
      ${accumulate(true)}
    END;

    CREATE TRIGGER IF NOT EXISTS workload_bucket_cursor_advance
    AFTER UPDATE OF scanned_bytes ON source
    WHEN NEW.scanned_bytes > OLD.scanned_bytes
    BEGIN
      INSERT INTO workload_bucket(${keyList}, events, ${sumList}, last_at_ms)
      ${workloadBucketGroupSql({ where: range("OLD.scanned_bytes", "NEW.scanned_bytes") })}
      ${accumulate(false)}
    END;

    CREATE TRIGGER IF NOT EXISTS workload_bucket_cursor_retreat
    AFTER UPDATE OF scanned_bytes ON source
    WHEN NEW.scanned_bytes < OLD.scanned_bytes
    BEGIN
      INSERT INTO workload_bucket(${keyList}, events, ${sumList}, last_at_ms)
      ${workloadBucketGroupSql({ where: range("NEW.scanned_bytes", "OLD.scanned_bytes"), sign: -1 })}
      ${accumulate(true)}
    END;
  `;
}

export const WORKLOAD_BUCKET_TRIGGER_SCHEMA = triggerSql();

/** Rebuild the whole table from committed facts. Inside the caller's transaction. */
export function rebuildWorkloadBuckets(database) {
  database.exec("DELETE FROM workload_bucket");
  const keyList = KEY_COLUMNS.join(", ");
  const sumList = SUM_COLUMNS.map(([target]) => target).join(", ");
  database.exec(`
    INSERT INTO workload_bucket(${keyList}, events, ${sumList}, last_at_ms)
    ${workloadBucketGroupSql()}`);
}

/**
 * Replace one half-open time range with a fresh grouping of its committed
 * facts. The caller owns the transaction. This is the bounded backfill unit:
 * it is exact even when a source append committed before the batch, because
 * only rows inside the range are replaced.
 */
export function rebuildWorkloadBucketRange(database, fromMs, toMs) {
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs >= toMs) {
    throw new TypeError("invalid workload bucket range");
  }
  database.prepare(
    "DELETE FROM workload_bucket WHERE bucket_start_ms >= ? AND bucket_start_ms < ?",
  ).run(fromMs, toMs);
  const keyList = KEY_COLUMNS.join(", ");
  const sumList = SUM_COLUMNS.map(([target]) => target).join(", ");
  database.exec(`
    INSERT INTO workload_bucket(${keyList}, events, ${sumList}, last_at_ms)
    ${workloadBucketRangeSql(fromMs, toMs)}`);
}

export function pruneEmptyWorkloadBuckets(database) {
  return Number(database.prepare(
    "DELETE FROM workload_bucket WHERE events = 0",
  ).run().changes);
}

/**
 * Compare the stored rows with a fresh grouping. A cleared `last_at_ms` is
 * allowed; a stored one must be exact. Returns the number of differing rows.
 */
export function auditWorkloadBuckets(database) {
  database.exec("DROP TABLE IF EXISTS temp.workload_bucket_audit");
  database.exec(`CREATE TEMP TABLE workload_bucket_audit AS ${workloadBucketGroupSql()}`);
  try {
    const columns = [...KEY_COLUMNS, "events", ...SUM_COLUMNS.map(([target]) => target)].join(", ");
    const missing = Number(database.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT ${columns} FROM temp.workload_bucket_audit
        EXCEPT SELECT ${columns} FROM workload_bucket WHERE events > 0)`).get().n);
    const extra = Number(database.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT ${columns} FROM workload_bucket WHERE events > 0
        EXCEPT SELECT ${columns} FROM temp.workload_bucket_audit)`).get().n);
    const wrongLast = Number(database.prepare(`
      SELECT COUNT(*) AS n FROM workload_bucket w
      JOIN temp.workload_bucket_audit a USING (${KEY_COLUMNS.join(", ")})
      WHERE w.events > 0 AND w.last_at_ms IS NOT NULL AND w.last_at_ms != a.last_at_ms`).get().n);
    const hollow = Number(database.prepare(
      "SELECT COUNT(*) AS n FROM workload_bucket WHERE events <= 0",
    ).get().n);
    return missing + extra + wrongLast + hollow;
  } finally {
    database.exec("DROP TABLE IF EXISTS temp.workload_bucket_audit");
  }
}

export { KEY_COLUMNS as WORKLOAD_BUCKET_KEY_COLUMNS, SUM_COLUMNS as WORKLOAD_BUCKET_SUM_COLUMNS };
