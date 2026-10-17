import { createHash } from "node:crypto";

import { APP_OFFICIAL_PRICE_CARDS } from "@app-usagemonitor/accounting";

// Usage rollups for the local index store.
//
// A rollup row is the exact sum of the usage events that share one *key*. The
// key holds everything a projection of an event can depend on other than its
// token quantities, so a row can be projected once with summed quantities and
// weighted by its event count instead of projecting every event:
//
//   bucket_ms        15-minute UTC bucket (never straddles a UTC date, which is
//                    the granularity of every price-card effective boundary)
//   model_id         store model row (recognition is resolved at read time)
//   tier_id          speed mode and API tier (resolved at read time)
//   surface_id       surface, agent scope and lineage disposition
//   account_scope_id attributed or not
//   shape            which token columns are NULL (bits 0-5), which are
//                    positive (bits 6-11) and whether a combined output
//                    contradicts its split (bit 12)
//   ctx_class        where the event's total input context falls among the
//                    price registry's context thresholds (-1: unavailable)
//
// Nothing here stores a price. A registry revision therefore changes no stored
// rollup unless it moves a context threshold, which the basis check detects.
//
// One SQL expression defines the key. The triggers, the bulk build, the audit
// and the read path's edge queries all use it, so the stored rows and an ad-hoc
// GROUP BY over the facts cannot disagree.
//
// Invariant: usage_rollup is the grouping of the facts at or below each
// source's cursor (`source.scanned_bytes`). A parallel build writes facts
// before their source's cursor moves; those are provisional and are not
// counted until the cursor passes them, and a cursor that moves back uncounts
// what it leaves behind. Readers therefore never see a half-built source,
// whichever way the build ran.

export const ROLLUP_BUCKET_MS = 15 * 60 * 1_000;
export const ROLLUP_SCHEMA_VERSION = 1;

const TOKEN_COLUMNS = Object.freeze([
  "tokens_in_uncached",
  "tokens_in_cache_read",
  "tokens_in_cache_write",
  "tokens_out_text",
  "tokens_out_reasoning",
  "tokens_out_combined",
]);

const KEY_COLUMNS = Object.freeze([
  "bucket_ms", "model_id", "tier_id", "surface_id", "account_scope_id",
  "shape", "ctx_class",
]);

const SUM_COLUMNS = Object.freeze([
  ["in_uncached", "tokens_in_uncached"],
  ["in_cache_read", "tokens_in_cache_read"],
  ["in_cache_write", "tokens_in_cache_write"],
  ["out_text", "tokens_out_text"],
  ["out_reasoning", "tokens_out_reasoning"],
  ["out_combined", "tokens_out_combined"],
]);

export const ROLLUP_SCHEMA = `
  -- Context thresholds the rollup key classifies against. Derived from the
  -- price registry; replaced (and the rollups rebuilt) when they change.
  CREATE TABLE IF NOT EXISTS rollup_context_start(
    start_tokens INTEGER PRIMARY KEY CHECK(start_tokens >= 0)) STRICT;

  CREATE TABLE IF NOT EXISTS usage_rollup(
    bucket_ms INTEGER NOT NULL,
    model_id INTEGER NOT NULL,
    tier_id INTEGER NOT NULL,
    surface_id INTEGER NOT NULL,
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
    PRIMARY KEY(bucket_ms, model_id, tier_id, surface_id, account_scope_id,
                shape, ctx_class)) STRICT, WITHOUT ROWID;
`;

/** The expressions that compute each key column from a fact row. */
export function rollupKeyExpressions(row) {
  const col = (name) => `${row}.${name}`;
  const at = col("observed_at_ms");
  const nulls = TOKEN_COLUMNS
    .map((name, index) => `((${col(name)} IS NULL) << ${index})`).join(" | ");
  const positives = TOKEN_COLUMNS
    .map((name, index) => `((COALESCE(${col(name)}, 0) > 0) << ${index + 6})`).join(" | ");
  const conflict = `((${col("tokens_out_text")} IS NOT NULL`
    + ` AND ${col("tokens_out_reasoning")} IS NOT NULL`
    + ` AND ${col("tokens_out_combined")} IS NOT NULL`
    + ` AND ${col("tokens_out_combined")}`
    + ` != ${col("tokens_out_text")} + ${col("tokens_out_reasoning")}) << 12)`;
  const contextValue = `COALESCE(${col("total_input_context")},`
    + ` CASE WHEN ${col("tokens_in_uncached")} IS NOT NULL`
    + ` AND ${col("tokens_in_cache_read")} IS NOT NULL`
    + ` AND ${col("tokens_in_cache_write")} IS NOT NULL`
    + ` THEN ${col("tokens_in_uncached")} + ${col("tokens_in_cache_read")}`
    + ` + ${col("tokens_in_cache_write")} END)`;
  return {
    bucket_ms: `CASE WHEN ${at} >= 0 THEN (${at} / ${ROLLUP_BUCKET_MS}) * ${ROLLUP_BUCKET_MS}`
      + ` ELSE ((${at} - ${ROLLUP_BUCKET_MS - 1}) / ${ROLLUP_BUCKET_MS}) * ${ROLLUP_BUCKET_MS} END`,
    model_id: col("model_id"),
    tier_id: col("tier_id"),
    surface_id: col("surface_id"),
    account_scope_id: col("account_scope_id"),
    shape: `(${nulls} | ${positives} | ${conflict})`,
    ctx_class: `CASE WHEN ${contextValue} IS NULL THEN -1 ELSE`
      + ` (SELECT COUNT(*) FROM rollup_context_start`
      + ` WHERE start_tokens <= ${contextValue}) END`,
  };
}

function sumExpressions(row) {
  return SUM_COLUMNS.map(([target, source]) => [target, `COALESCE(${row}.${source}, 0)`]);
}

/** The predicate that selects committed facts: at or below the cursor. */
export function committedPredicate(alias = "u") {
  return `${alias}.source_offset <= (SELECT scanned_bytes FROM source WHERE id = ${alias}.source_id)`;
}

/**
 * A `SELECT` that groups facts by rollup key. `alias` names the usage_event
 * table; `where` is a predicate over it (default: the committed facts) and
 * `sign` is -1 to produce the amounts to subtract.
 */
export function rollupGroupSql({ alias = "u", where = committedPredicate("u"), sign = 1 } = {}) {
  const key = rollupKeyExpressions(alias);
  const sums = sumExpressions(alias);
  const negate = sign < 0 ? "-" : "";
  return `
    SELECT ${KEY_COLUMNS.map((name) => `${key[name]} AS ${name}`).join(",\n           ")},
           ${negate}COUNT(*) AS events,
           ${sums.map(([target, expression]) => `${negate}SUM(${expression}) AS ${target}`).join(",\n           ")}
    FROM usage_event ${alias}
    WHERE ${where}
    GROUP BY ${KEY_COLUMNS.join(", ")}`;
}

function triggerSql() {
  const added = rollupKeyExpressions("NEW");
  const removed = rollupKeyExpressions("OLD");
  const addSums = sumExpressions("NEW");
  const removeSums = sumExpressions("OLD");
  const keyList = KEY_COLUMNS.join(", ");
  const sumList = SUM_COLUMNS.map(([target]) => target).join(", ");
  const accumulate = `ON CONFLICT(${keyList}) DO UPDATE SET
        events = events + excluded.events,
        ${SUM_COLUMNS.map(([target]) => `${target} = ${target} + excluded.${target}`).join(",\n        ")};`;
  const cursorRange = (from, to) => `u.source_id = NEW.id AND u.source_offset > ${from}`
    + ` AND u.source_offset <= ${to}`;
  return `
    CREATE TRIGGER IF NOT EXISTS usage_rollup_insert AFTER INSERT ON usage_event
    WHEN NEW.source_offset <= (SELECT scanned_bytes FROM source WHERE id = NEW.source_id)
    BEGIN
      INSERT INTO usage_rollup(${keyList}, events, ${sumList})
      VALUES (${KEY_COLUMNS.map((name) => added[name]).join(", ")}, 1,
          ${addSums.map(([, expression]) => expression).join(", ")})
      ${accumulate}
    END;

    CREATE TRIGGER IF NOT EXISTS usage_rollup_delete AFTER DELETE ON usage_event
    WHEN OLD.source_offset <= (SELECT scanned_bytes FROM source WHERE id = OLD.source_id)
    BEGIN
      UPDATE usage_rollup SET
        events = events - 1,
        ${removeSums.map(([target, expression]) => `${target} = ${target} - ${expression}`).join(",\n        ")}
      WHERE ${KEY_COLUMNS.map((name) => `${name} = ${removed[name]}`).join("\n        AND ")};
    END;

    CREATE TRIGGER IF NOT EXISTS usage_rollup_model_update
    AFTER UPDATE OF model_id ON usage_event
    WHEN OLD.model_id <> NEW.model_id AND NEW.source_offset <= (SELECT scanned_bytes FROM source WHERE id=NEW.source_id)
    BEGIN
      UPDATE usage_rollup SET events=events-1,
        ${removeSums.map(([target,expression])=>`${target}=${target}-${expression}`).join(', ')}
      WHERE ${KEY_COLUMNS.map(name=>`${name}=${removed[name]}`).join(' AND ')};
      INSERT INTO usage_rollup(${keyList},events,${sumList})
      VALUES (${KEY_COLUMNS.map(name=>added[name]).join(', ')},1,${addSums.map(([,expression])=>expression).join(', ')})
      ${accumulate}
    END;

    CREATE TRIGGER IF NOT EXISTS usage_rollup_cursor_advance
    AFTER UPDATE OF scanned_bytes ON source
    WHEN NEW.scanned_bytes > OLD.scanned_bytes
    BEGIN
      INSERT INTO usage_rollup(${keyList}, events, ${sumList})
      ${rollupGroupSql({ where: cursorRange("OLD.scanned_bytes", "NEW.scanned_bytes") })}
      ${accumulate}
    END;

    CREATE TRIGGER IF NOT EXISTS usage_rollup_cursor_retreat
    AFTER UPDATE OF scanned_bytes ON source
    WHEN NEW.scanned_bytes < OLD.scanned_bytes
    BEGIN
      INSERT INTO usage_rollup(${keyList}, events, ${sumList})
      ${rollupGroupSql({ where: cursorRange("NEW.scanned_bytes", "OLD.scanned_bytes"), sign: -1 })}
      ${accumulate}
    END;
  `;
}

export const ROLLUP_TRIGGER_SCHEMA = triggerSql();

/**
 * Context thresholds of the price registry, as the first token count of each
 * class. A comparison against a registry boundary can be inclusive or
 * exclusive on either side, so each boundary contributes itself and its
 * successor: every event of one class then prices identically.
 */
export function contextClassStarts(cards = APP_OFFICIAL_PRICE_CARDS) {
  const starts = new Set();
  for (const card of cards) {
    for (const component of card?.components ?? []) {
      for (const name of ["min_total_input_tokens", "max_total_input_tokens"]) {
        const value = component?.conditions?.[name];
        if (value === undefined || value === null) continue;
        const tokens = Number(value);
        if (!Number.isSafeInteger(tokens) || tokens < 0) {
          throw new TypeError("price registry context threshold is invalid");
        }
        starts.add(tokens);
        starts.add(tokens + 1);
      }
    }
  }
  return [...starts].sort((left, right) => left - right);
}

export function rollupBasisFingerprint(starts) {
  return createHash("sha256")
    .update(`usage-rollup-v${ROLLUP_SCHEMA_VERSION}\0${starts.join(",")}`)
    .digest("hex");
}

/** The thresholds currently stored, ascending. */
export function storedContextStarts(database) {
  return database.prepare(
    "SELECT start_tokens FROM rollup_context_start ORDER BY start_tokens",
  ).all().map((row) => Number(row.start_tokens));
}

function sameStarts(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * True when the stored thresholds equal the registry's. A reader that sees
 * `false` must not trust the rollups.
 */
export function rollupBasisCurrent(database, starts = contextClassStarts()) {
  return sameStarts(storedContextStarts(database), starts);
}

/**
 * Replace the rollups with a grouping of the facts. Runs inside the caller's
 * transaction. Used on creation and when the registry's thresholds change.
 */
export function rebuildRollups(database, starts = contextClassStarts()) {
  database.exec("DELETE FROM usage_rollup");
  database.exec("DELETE FROM rollup_context_start");
  const insert = database.prepare(
    "INSERT INTO rollup_context_start(start_tokens) VALUES (?)",
  );
  for (const start of starts) insert.run(start);
  const keyList = KEY_COLUMNS.join(", ");
  const sumList = SUM_COLUMNS.map(([target]) => target).join(", ");
  database.exec(`
    INSERT INTO usage_rollup(${keyList}, events, ${sumList})
    ${rollupGroupSql()}`);
  database.prepare(`
    INSERT INTO meta(key, value) VALUES ('rollup_basis', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(rollupBasisFingerprint(starts));
  return Number(database.prepare("SELECT COUNT(*) AS n FROM usage_rollup").get().n);
}

/**
 * Bring the rollups in line with the registry when the store is opened for
 * writing. Takes a write transaction only when the basis moved.
 */
export function reconcileRollups(database, starts = contextClassStarts(), onRebuild = null) {
  if (rollupBasisCurrent(database, starts)) return false;
  database.exec("BEGIN IMMEDIATE");
  try {
    rebuildRollups(database, starts);
    // Other tables keyed by the same context classes move with them.
    if (onRebuild !== null) onRebuild(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* keep the original failure */ }
    throw error;
  }
  return true;
}

/** Remove rows whose events were all deleted. Cheap; the table is small. */
export function pruneEmptyRollups(database) {
  return Number(database.prepare(
    "DELETE FROM usage_rollup WHERE events = 0",
  ).run().changes);
}

/**
 * Compare the stored rollups with a fresh grouping of the facts. Returns the
 * number of rows that differ in either direction, so 0 means identical.
 */
export function auditRollups(database) {
  database.exec("DROP TABLE IF EXISTS temp.rollup_audit");
  database.exec(`
    CREATE TEMP TABLE rollup_audit AS ${rollupGroupSql()}`);
  try {
    const columns = [...KEY_COLUMNS, "events", ...SUM_COLUMNS.map(([target]) => target)]
      .join(", ");
    const missing = Number(database.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT ${columns} FROM temp.rollup_audit
        EXCEPT
        SELECT ${columns} FROM usage_rollup WHERE events > 0)`).get().n);
    const extra = Number(database.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT ${columns} FROM usage_rollup WHERE events > 0
        EXCEPT
        SELECT ${columns} FROM temp.rollup_audit)`).get().n);
    // A pruned table holds no row at or below zero; one would hide from the
    // comparison above, so it is a difference of its own.
    const hollow = Number(database.prepare(
      "SELECT COUNT(*) AS n FROM usage_rollup WHERE events <= 0",
    ).get().n);
    return missing + extra + hollow;
  } finally {
    database.exec("DROP TABLE IF EXISTS temp.rollup_audit");
  }
}

export { KEY_COLUMNS as ROLLUP_KEY_COLUMNS, SUM_COLUMNS as ROLLUP_SUM_COLUMNS };
