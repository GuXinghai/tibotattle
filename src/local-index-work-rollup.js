import {
  committedPredicate,
  rollupKeyExpressions,
} from "./local-index-rollup.js";

// Work-usage rollups.
//
// The work breakdown groups usage by thread (session), working directory,
// model and account scope, over four rolling periods. Everything it needs per
// group is additive, so a group is stored once per UTC day:
//
//   day_ms, session_id, work_directory_id (0 = unknown), model_id,
//   account_scope_id, shape and ctx_class as in usage_rollup, and
//   prov: bit 0 partial parse, bit 1 cache write assumed zero,
//         bit 2 status update (quota with no spend)
//
// plus the event count, the six token sums and the latest instant. Days never
// straddle a price-card effective date, so a row prices as one. Like the usage
// rollups, rows describe facts at or below each source's cursor and are
// maintained by triggers.
//
// `last_at_ms` is the one non-additive field. A delete that removes the
// latest event of a row cannot cheaply find the next one, so it clears the
// value; readers recompute a cleared value from the day's events.

export const WORK_ROLLUP_DAY_MS = 86_400_000;

const KEY_COLUMNS = Object.freeze([
  "day_ms", "session_id", "work_directory_id", "model_id", "account_scope_id",
  "shape", "ctx_class", "prov",
]);

const SUM_COLUMNS = Object.freeze([
  ["in_uncached", "tokens_in_uncached"],
  ["in_cache_read", "tokens_in_cache_read"],
  ["in_cache_write", "tokens_in_cache_write"],
  ["out_text", "tokens_out_text"],
  ["out_reasoning", "tokens_out_reasoning"],
  ["out_combined", "tokens_out_combined"],
]);

export const WORK_ROLLUP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS work_rollup(
    day_ms INTEGER NOT NULL,
    session_id INTEGER NOT NULL,
    work_directory_id INTEGER NOT NULL,
    model_id INTEGER NOT NULL,
    account_scope_id INTEGER NOT NULL,
    shape INTEGER NOT NULL,
    ctx_class INTEGER NOT NULL,
    prov INTEGER NOT NULL,
    events INTEGER NOT NULL,
    in_uncached INTEGER NOT NULL,
    in_cache_read INTEGER NOT NULL,
    in_cache_write INTEGER NOT NULL,
    out_text INTEGER NOT NULL,
    out_reasoning INTEGER NOT NULL,
    out_combined INTEGER NOT NULL,
    last_at_ms INTEGER,
    PRIMARY KEY(day_ms, session_id, work_directory_id, model_id,
                account_scope_id, shape, ctx_class, prov)) STRICT, WITHOUT ROWID;
`;

function keyExpressions(row) {
  const usage = rollupKeyExpressions(row);
  const at = `${row}.observed_at_ms`;
  return {
    day_ms: `CASE WHEN ${at} >= 0 THEN (${at} / ${WORK_ROLLUP_DAY_MS}) * ${WORK_ROLLUP_DAY_MS}`
      + ` ELSE ((${at} - ${WORK_ROLLUP_DAY_MS - 1}) / ${WORK_ROLLUP_DAY_MS}) * ${WORK_ROLLUP_DAY_MS} END`,
    session_id: `${row}.session_id`,
    work_directory_id: `COALESCE(${row}.work_directory_id, 0)`,
    model_id: `${row}.model_id`,
    account_scope_id: `${row}.account_scope_id`,
    shape: usage.shape,
    ctx_class: usage.ctx_class,
    prov: `((${row}.flags & 1) | ((${row}.flags & 4) >> 1) | ((${row}.flags & 8) >> 1))`,
  };
}

function sums(row) {
  return SUM_COLUMNS.map(([target, source]) => [target, `COALESCE(${row}.${source}, 0)`]);
}

/** A grouping of committed facts (or a cursor range of them). */
export function workRollupGroupSql({ alias = "u", where = committedPredicate("u"), sign = 1 } = {}) {
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
  return `
    CREATE TRIGGER IF NOT EXISTS work_rollup_insert AFTER INSERT ON usage_event
    WHEN NEW.source_offset <= (SELECT scanned_bytes FROM source WHERE id = NEW.source_id)
    BEGIN
      INSERT INTO work_rollup(${keyList}, events, ${sumList}, last_at_ms)
      VALUES (${KEY_COLUMNS.map((name) => added[name]).join(", ")}, 1,
          ${sums("NEW").map(([, expression]) => expression).join(", ")}, NEW.observed_at_ms)
      ${accumulate(false)}
    END;

    CREATE TRIGGER IF NOT EXISTS work_rollup_delete AFTER DELETE ON usage_event
    WHEN OLD.source_offset <= (SELECT scanned_bytes FROM source WHERE id = OLD.source_id)
    BEGIN
      UPDATE work_rollup SET
        events = events - 1,
        ${sums("OLD").map(([target, expression]) => `${target} = ${target} - ${expression}`).join(",\n        ")},
        last_at_ms = CASE WHEN last_at_ms = OLD.observed_at_ms THEN NULL ELSE last_at_ms END
      WHERE ${KEY_COLUMNS.map((name) => `${name} = ${removed[name]}`).join("\n        AND ")};
    END;

    CREATE TRIGGER IF NOT EXISTS work_rollup_cursor_advance
    AFTER UPDATE OF scanned_bytes ON source
    WHEN NEW.scanned_bytes > OLD.scanned_bytes
    BEGIN
      INSERT INTO work_rollup(${keyList}, events, ${sumList}, last_at_ms)
      ${workRollupGroupSql({ where: range("OLD.scanned_bytes", "NEW.scanned_bytes") })}
      ${accumulate(false)}
    END;

    CREATE TRIGGER IF NOT EXISTS work_rollup_cursor_retreat
    AFTER UPDATE OF scanned_bytes ON source
    WHEN NEW.scanned_bytes < OLD.scanned_bytes
    BEGIN
      INSERT INTO work_rollup(${keyList}, events, ${sumList}, last_at_ms)
      ${workRollupGroupSql({ where: range("NEW.scanned_bytes", "OLD.scanned_bytes"), sign: -1 })}
      ${accumulate(true)}
    END;
  `;
}

export const WORK_ROLLUP_TRIGGER_SCHEMA = triggerSql();

/** Rebuild the table from the committed facts. Inside the caller's transaction. */
export function rebuildWorkRollups(database) {
  database.exec("DELETE FROM work_rollup");
  const keyList = KEY_COLUMNS.join(", ");
  const sumList = SUM_COLUMNS.map(([target]) => target).join(", ");
  database.exec(`
    INSERT INTO work_rollup(${keyList}, events, ${sumList}, last_at_ms)
    ${workRollupGroupSql()}`);
}

export function pruneEmptyWorkRollups(database) {
  return Number(database.prepare("DELETE FROM work_rollup WHERE events = 0").run().changes);
}

/**
 * Compare the stored rows with a fresh grouping. A cleared `last_at_ms` is
 * allowed (it is recomputed at read time); a stored one must be exact.
 * Returns the number of differing rows.
 */
export function auditWorkRollups(database) {
  database.exec("DROP TABLE IF EXISTS temp.work_rollup_audit");
  database.exec(`CREATE TEMP TABLE work_rollup_audit AS ${workRollupGroupSql()}`);
  try {
    const columns = [...KEY_COLUMNS, "events", ...SUM_COLUMNS.map(([target]) => target)].join(", ");
    const missing = Number(database.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT ${columns} FROM temp.work_rollup_audit
        EXCEPT SELECT ${columns} FROM work_rollup WHERE events > 0)`).get().n);
    const extra = Number(database.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT ${columns} FROM work_rollup WHERE events > 0
        EXCEPT SELECT ${columns} FROM temp.work_rollup_audit)`).get().n);
    const wrongLast = Number(database.prepare(`
      SELECT COUNT(*) AS n FROM work_rollup w
      JOIN temp.work_rollup_audit a USING (${KEY_COLUMNS.join(", ")})
      WHERE w.events > 0 AND w.last_at_ms IS NOT NULL AND w.last_at_ms != a.last_at_ms`).get().n);
    const hollow = Number(database.prepare(
      "SELECT COUNT(*) AS n FROM work_rollup WHERE events <= 0",
    ).get().n);
    return missing + extra + wrongLast + hollow;
  } finally {
    database.exec("DROP TABLE IF EXISTS temp.work_rollup_audit");
  }
}

export { KEY_COLUMNS as WORK_ROLLUP_KEY_COLUMNS, SUM_COLUMNS as WORK_ROLLUP_SUM_COLUMNS };
