import { committedPredicate } from "./local-index-rollup.js";

// Impact manifest for the local index store.
//
// The manifest is written in the same transaction as a source advance. It does
// not decide whether facts are trustworthy; it records what a published change
// can affect so projections can recompute only that region. Source evidence is
// never rewritten by these tables.

export const IMPACT_SCHEMA_VERSION = 1;
export const IMPACT_MANIFEST_RETENTION_CHANGES = 50_000;

export const PUBLICATION_KINDS = Object.freeze([
  "cold", "refresh", "verify", "maintenance", "fact_correction",
]);

export const SOURCE_CHANGE_MODES = Object.freeze([
  "new",
  "append",
  "range_rescan",
  "source_replace",
  "quarantine_gap",
  "presence_changed",
  "semantic_noop",
  "fact_correction",
]);

export const IMPACT_CONFIDENCE = Object.freeze(["exact", "bounded", "unknown"]);

export const FACT_KINDS = Object.freeze([
  "usage", "quota", "tool", "work", "lineage_snapshot", "diagnostic",
]);

export const REPAIR_STATUS = Object.freeze([
  "queued", "leased", "running", "deferred", "done", "failed",
]);

export const PROJECTION_STATUS = Object.freeze([
  "pending", "building", "ready", "stale", "deferred",
]);

export const IMPACT_PARTITION_STATUSES = Object.freeze([
  "dirty", "pending", "ready", "unknown",
]);

export const PARTITION_KINDS = Object.freeze([
  "usage_time_range", "work_time_range", "session", "lineage_component",
  "quota_time_range", "accounting_window", "coverage", "quota_observation",
]);

export const BASIS_KINDS = Object.freeze([
  "fact_delta", "quota_canonical", "quota_observation", "lineage_snapshot",
  "coverage",
]);

// Closed code vocabularies. A new production reason needs an explicit schema
// migration; do not accept free-form errors, paths or account identifiers.
export const SOURCE_CHANGE_REASONS = Object.freeze([
  "model_attribution_recovery",
  "boundary_changed",
  "response_reconciliation",
  "segment_mismatch",
  "parser_version",
  "identity_changed",
  "cursor_invalid",
  "same_size_changed",
  "compressed_changed",
  "quarantine_changed",
  "shrink",
  "session_rescan",
  "dependency_quarantine_changed",
  "dependency_quarantine",
  "cold_build",
  "rediscovered",
  "discovery_absent",
  "runtime_model_evidence",
  "codex_rollout_content_invalid",
  "codex_rollout_tail_incomplete",
  "codex_rollout_lineage_invalid",
  "codex_rollout_compression_unsupported",
  "codex_rollout_filename_identity_mismatch",
  "codex_rollout_generation_ambiguous",
  "codex_rollout_checkpoint_history_unsupported",
]);

export const REPAIR_SCOPE_KINDS = Object.freeze([
  "projection_backfill", "usage_time_range", "work_time_range", "session",
  "coverage", "integrity_gap",
]);

export const REPAIR_REASONS = Object.freeze([
  "projection_backfill", "integrity_gap", "coverage",
]);

const sqlList = (values) => values.map((value) => `'${value}'`).join(", ");

export const IMPACT_SCHEMA = `
  -- One durable row per published commit, including commits with no source
  -- change. commit_log remains the bounded display summary.
  CREATE TABLE IF NOT EXISTS publication(
    commit_seq INTEGER PRIMARY KEY CHECK(commit_seq >= 1),
    committed_at_ms INTEGER NOT NULL CHECK(committed_at_ms >= 0),
    kind TEXT NOT NULL CHECK(kind IN (${sqlList(PUBLICATION_KINDS)})),
    manifest_complete INTEGER NOT NULL CHECK(manifest_complete IN (0, 1)),
    source_change_count INTEGER NOT NULL CHECK(source_change_count >= 0)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS source_change(
    change_id INTEGER PRIMARY KEY,
    commit_seq INTEGER NOT NULL REFERENCES publication(commit_seq)
      CHECK(commit_seq >= 1),
    source_id INTEGER NOT NULL REFERENCES source,
    mode TEXT NOT NULL CHECK(mode IN (${sqlList(SOURCE_CHANGE_MODES)})),
    reason TEXT CHECK(reason IS NULL OR reason IN (${sqlList(SOURCE_CHANGE_REASONS)})),
    old_file_id TEXT,
    new_file_id TEXT,
    old_scanned_bytes INTEGER,
    new_scanned_bytes INTEGER,
    old_size_bytes INTEGER,
    new_size_bytes INTEGER,
    old_event_count INTEGER NOT NULL DEFAULT 0 CHECK(old_event_count >= 0),
    new_event_count INTEGER NOT NULL DEFAULT 0 CHECK(new_event_count >= 0),
    confidence TEXT NOT NULL CHECK(confidence IN ('exact', 'bounded', 'unknown')),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
  ) STRICT;

  -- Per-fact-kind deltas. A source change can alter usage, quota, tool, work,
  -- lineage or diagnostic facts independently.
  CREATE TABLE IF NOT EXISTS change_fact_count(
    change_id INTEGER NOT NULL REFERENCES source_change ON DELETE CASCADE,
    fact_kind TEXT NOT NULL CHECK(fact_kind IN (${sqlList(FACT_KINDS)})),
    old_count INTEGER NOT NULL CHECK(old_count >= 0),
    new_count INTEGER NOT NULL CHECK(new_count >= 0),
    old_min_at_ms INTEGER,
    old_max_at_ms INTEGER,
    new_min_at_ms INTEGER,
    new_max_at_ms INTEGER,
    PRIMARY KEY(change_id, fact_kind)
  ) STRICT, WITHOUT ROWID;

  -- A safe upper bound of what a change can affect. Rows may be coarser than
  -- the final projection key; time ranges are valid partitions.
  CREATE TABLE IF NOT EXISTS impact_partition(
    change_id INTEGER NOT NULL REFERENCES source_change ON DELETE CASCADE,
    partition_kind TEXT NOT NULL CHECK(partition_kind IN (${sqlList(PARTITION_KINDS)})),
    partition_key TEXT NOT NULL CHECK(length(partition_key) BETWEEN 1 AND 512),
    lower_ms INTEGER,
    upper_ms INTEGER,
    session_id INTEGER REFERENCES session,
    lineage_component_id INTEGER,
    account_scope_id INTEGER REFERENCES account_scope,
    basis_kind TEXT NOT NULL CHECK(basis_kind IN (${sqlList(BASIS_KINDS)})),
    basis_key TEXT CHECK(basis_key IS NULL OR length(basis_key) BETWEEN 1 AND 512),
    status TEXT NOT NULL CHECK(status IN (${sqlList(IMPACT_PARTITION_STATUSES)})),
    PRIMARY KEY(change_id, partition_kind, partition_key, basis_kind)
  ) STRICT, WITHOUT ROWID;

  -- Explicit unknown byte/time regions. A gap is never converted to zero.
  CREATE TABLE IF NOT EXISTS integrity_gap(
    gap_id INTEGER PRIMARY KEY,
    source_id INTEGER NOT NULL REFERENCES source,
    byte_start INTEGER NOT NULL CHECK(byte_start >= 0),
    byte_end INTEGER,
    event_lower_ms INTEGER,
    event_upper_ms INTEGER,
    reason TEXT NOT NULL CHECK(reason IN (${sqlList(SOURCE_CHANGE_REASONS)})),
    confidence TEXT NOT NULL CHECK(confidence IN (${sqlList(IMPACT_CONFIDENCE)})),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    repair_status TEXT NOT NULL CHECK(repair_status IN (
      'open', 'queued', 'repaired', 'superseded')),
    CHECK(byte_end IS NULL OR byte_end >= byte_start)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS projection_watermark(
    projection_name TEXT NOT NULL,
    partition_key TEXT NOT NULL CHECK(length(partition_key) BETWEEN 1 AND 512),
    last_change_seq INTEGER,
    last_change_id INTEGER,
    basis_fingerprint TEXT,
    computed_at_ms INTEGER,
    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
    updated_at_ms INTEGER,
    status TEXT NOT NULL CHECK(status IN (${sqlList(PROJECTION_STATUS)})),
    PRIMARY KEY(projection_name, partition_key)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS repair_queue(
    queue_id INTEGER PRIMARY KEY,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN (${sqlList(REPAIR_SCOPE_KINDS)})),
    scope_key TEXT NOT NULL CHECK(length(scope_key) BETWEEN 1 AND 512),
    lower_ms INTEGER,
    upper_ms INTEGER,
    priority INTEGER NOT NULL,
    reason TEXT NOT NULL CHECK(reason IN (${sqlList(REPAIR_REASONS)})),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
    next_retry_at_ms INTEGER,
    status TEXT NOT NULL CHECK(status IN (${sqlList(REPAIR_STATUS)})),
    lease_owner TEXT,
    lease_expires_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
  ) STRICT;
`;

export const IMPACT_INDEX_SCHEMA = `
  CREATE INDEX IF NOT EXISTS publication_committed
    ON publication(committed_at_ms);
  CREATE INDEX IF NOT EXISTS source_change_commit
    ON source_change(commit_seq);
  CREATE INDEX IF NOT EXISTS source_change_source
    ON source_change(source_id, change_id);
  CREATE INDEX IF NOT EXISTS impact_partition_time
    ON impact_partition(partition_kind, lower_ms, upper_ms);
  CREATE INDEX IF NOT EXISTS impact_partition_session
    ON impact_partition(session_id);
  CREATE INDEX IF NOT EXISTS impact_partition_lineage
    ON impact_partition(lineage_component_id);
  CREATE INDEX IF NOT EXISTS integrity_gap_source
    ON integrity_gap(source_id, repair_status);
  CREATE INDEX IF NOT EXISTS projection_watermark_status
    ON projection_watermark(status);
  CREATE INDEX IF NOT EXISTS repair_queue_due
    ON repair_queue(status, next_retry_at_ms, priority);
`;

export function createLocalIndexImpactSchema(database) {
  database.exec(IMPACT_SCHEMA);
  database.exec(IMPACT_INDEX_SCHEMA);
}

/**
 * The committed fact summary for one source. Counts and observed-time bounds
 * use only facts at or below the source cursor; provisional rows are not part
 * of a published change.
 */
export function quotaDependencyPartitions(database, {
  oldIds = [], newIds = [], sessionId = null, limit = 100, includeAll = false,
} = {}) {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 100;
  const oldSet = new Set(oldIds);
  const newSet = new Set(newIds);
  const changed = [...new Set([...oldSet, ...newSet])]
    // A source append can re-rank an observation already referenced by both
    // sides. When quota facts changed, every referenced id is a safe dependency.
    .filter((id) => includeAll || !(oldSet.has(id) && newSet.has(id)))
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .sort((left, right) => left - right);
  const partitions = [];
  // Multiple canonical observations can reference the same source/session.
  // Merge those partitions by their primary key instead of inserting duplicates.
  const usageRanges = new Map();
  for (const id of changed.slice(0, safeLimit)) {
    const refs = database.prepare(`
      SELECT u.source_id AS source_id, u.session_id AS session_id,
             MIN(u.observed_at_ms) AS lo, MAX(u.observed_at_ms) AS hi
      FROM usage_event u
      WHERE u.quota_observation_id = ? AND ${committedPredicate("u")}
      GROUP BY u.source_id, u.session_id
      ORDER BY u.source_id, u.session_id`).all(id);
    const bounds = refs.flatMap((row) => [Number(row.lo), Number(row.hi)])
      .filter((value) => Number.isFinite(value));
    const lowerMs = bounds.length === 0 ? null : Math.min(...bounds);
    const upperMs = bounds.length === 0 ? null : Math.max(...bounds);
    partitions.push({
      partitionKind: "quota_observation",
      partitionKey: `quota_observation:${id}`,
      lowerMs,
      upperMs,
      sessionId,
      basisKind: "quota_observation",
      status: "dirty",
    });
    for (const ref of refs) {
      const sourceId = Number(ref.source_id);
      const refSession = ref.session_id === null ? null : Number(ref.session_id);
      const key = `${sourceId}:${refSession ?? "none"}`;
      const existing = usageRanges.get(key);
      const lo = Number(ref.lo);
      const hi = Number(ref.hi);
      usageRanges.set(key, {
        sourceId,
        sessionId: refSession,
        lowerMs: existing === undefined ? lo : Math.min(existing.lowerMs, lo),
        upperMs: existing === undefined ? hi : Math.max(existing.upperMs, hi),
      });
    }
  }
  for (const range of usageRanges.values()) {
    partitions.push({
      partitionKind: "usage_time_range",
      partitionKey: `usage_time_range:${range.sourceId}:${range.sessionId ?? "none"}`,
      lowerMs: range.lowerMs,
      upperMs: range.upperMs,
      sessionId: range.sessionId,
      basisKind: "quota_observation",
      status: "dirty",
    });
  }
  return { partitions, truncated: changed.length > safeLimit };
}

/**
 * Bound durable change rows. A projection whose watermark is at or below the
 * returned `sinceChangeId` can no longer prove it saw every change and must
 * rebuild its bounded component rather than assume no impact.
 */
export function pruneImpactManifest(database, {
  keepChanges = IMPACT_MANIFEST_RETENTION_CHANGES,
} = {}) {
  if (!Number.isSafeInteger(keepChanges) || keepChanges < 1) {
    throw new TypeError("keepChanges must be a positive safe integer");
  }
  const bounds = database.prepare(
    "SELECT MIN(change_id) AS first_id, MAX(change_id) AS last_id FROM source_change",
  ).get();
  if (bounds.last_id === null) return { deletedChanges: 0, sinceChangeId: null };
  const cutoff = Number(bounds.last_id) - keepChanges;
  if (cutoff < Number(bounds.first_id)) return { deletedChanges: 0, sinceChangeId: null };
  const deletedChanges = Number(database.prepare(
    "DELETE FROM source_change WHERE change_id <= ?",
  ).run(cutoff).changes);
  const oldestRetained = database.prepare(
    "SELECT MIN(commit_seq) AS seq FROM source_change",
  ).get()?.seq ?? null;
  if (oldestRetained !== null) {
    database.prepare(`
      DELETE FROM publication
      WHERE commit_seq < ?
        AND NOT EXISTS (SELECT 1 FROM source_change c WHERE c.commit_seq = publication.commit_seq)`)
      .run(oldestRetained);
  }
  database.prepare(`
    INSERT INTO meta(key, value) VALUES ('impact_manifest_since_change_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(cutoff));
  return { deletedChanges, sinceChangeId: cutoff };
}

export function sourceImpactSummary(database, { sourceId, sessionId = null } = {}) {
  if (!Number.isSafeInteger(sourceId) || sourceId < 1) {
    throw new TypeError("sourceId must be a positive safe integer");
  }
  const table = (name, column) => {
    const row = database.prepare(`
      SELECT COUNT(*) AS n, MIN(t.${column}) AS lo, MAX(t.${column}) AS hi
      FROM ${name} t
      WHERE t.source_id = ? AND ${committedPredicate("t")}`).get(sourceId);
    return {
      count: Number(row.n),
      min: row.lo === null ? null : Number(row.lo),
      max: row.hi === null ? null : Number(row.hi),
    };
  };
  const quota = table("quota_occurrence", "observed_at_ms");
  quota.ids = new Set(database.prepare(`
    SELECT DISTINCT q.canonical_observation_id AS id
    FROM quota_occurrence q
    WHERE q.source_id = ? AND q.canonical_observation_id IS NOT NULL
      AND ${committedPredicate("q")}`).all(sourceId).map((row) => Number(row.id)));
  return {
    usage: table("usage_event", "observed_at_ms"),
    quota,
    tool: table("tool_class_fact", "observed_at_ms"),
    work: table("work_lifecycle_fact", "observed_at_ms"),
    lineage: sessionId === null || sessionId === undefined
      ? { count: 0, min: null, max: null }
      : {
        count: Number(database.prepare(
          "SELECT COUNT(*) AS n FROM lineage_snapshot WHERE session_id = ?",
        ).get(sessionId).n),
        min: null,
        max: null,
      },
    diagnostic: {
      count: Number(database.prepare(
        "SELECT COUNT(*) AS n FROM source_diagnostic WHERE source_id = ?",
      ).get(sourceId).n),
      min: null,
      max: null,
    },
  };
}
