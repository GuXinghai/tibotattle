import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { RAW_SESSION_UUID } from "./local-index-identity.js";
import {
  PAIRING_SCHEMA,
  PAIRING_TRIGGER_SCHEMA,
} from "./local-index-pairing.js";
import {
  pruneEmptyWorkRollups,
  rebuildWorkRollups,
  WORK_ROLLUP_SCHEMA,
  WORK_ROLLUP_TRIGGER_SCHEMA,
} from "./local-index-work-rollup.js";
import {
  contextClassStarts,
  pruneEmptyRollups,
  reconcileRollups,
  rebuildRollups,
  ROLLUP_SCHEMA,
  ROLLUP_TRIGGER_SCHEMA,
} from "./local-index-rollup.js";

// The local index store.
//
// One owner-only SQLite file in WAL mode. Each rollout source owns its facts;
// a source advances in one transaction that also moves its cursor, so a commit
// is the publication and there is no stage copy, snapshot or generation.
//
// Invariants:
//   * `source.scanned_bytes` is the commit marker. Fact offsets are line-end
//     offsets, so a committed fact has `source_offset <= scanned_bytes`. A
//     fact beyond it is provisional (written by a parallel cold build before
//     the source finished) and is removed by `repairProvisional` on open and
//     ignored by readers.
//   * The store holds no prompt, response, command or session content. Source
//     paths and file identity are allowed (see the 2026-10-12 decision) and
//     never leave the owner-only file.
//   * Facts are never converted from unknown to zero: absent token components
//     are NULL.

export const LOCAL_INDEX_STORE_FAMILY = "local-index-store";
export const LOCAL_INDEX_STORE_APPLICATION_ID = 0x554d4932;
export const LOCAL_INDEX_STORE_USER_VERSION = 9;
// A confirmed native response receipt repaired this derived model. Reparse clears it.
export const EVENT_FLAG_RUNTIME_MODEL = 32;
// Increment when reviewed identity additions can repair previously unknown
// models. Only affected sources reparse, with a per-source committed receipt.
export const LOCAL_INDEX_MODEL_RECOGNITION_VERSION = 2;
// Names the shared extractor revision it was built with, so a change to the
// extractor's semantics cannot leave facts that no reparse will replace.
// test/local-index-refresh.test.js pins the two together.
export const LOCAL_INDEX_PARSER_VERSION = "local-index-rollout-typed-v3+unified-rollout-typed-v22";

// Append-only: ordinals are the on-disk and wire representation.
export const REASONING_EFFORTS = Object.freeze([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown",
]);
const EFFORT_ORDINALS = new Map(REASONING_EFFORTS.map((name, index) => [name, index]));
export function reasoningEffortOrdinal(value) {
  return EFFORT_ORDINALS.get(value) ?? EFFORT_ORDINALS.get("unknown");
}

export const EVENT_FLAG_PARTIAL = 1;
export const EVENT_FLAG_MODEL_INHERITED = 2;
export const EVENT_FLAG_CACHE_WRITE_ASSUMED_ZERO = 4;
// A quota report with no spend, on a verified unchanged cumulative total.
export const EVENT_FLAG_STATUS_ONLY = 8;
export const EVENT_FLAG_RESPONSE_USAGE = 16;

const DIAGNOSTIC_CODES = new Set([
  "malformedWorkRecords",
  "relevantLines", "malformedLines", "malformedTimestamps",
  "malformedAccountingRecords", "malformedUsageRecords",
  "malformedRateLimitRecords", "partialLines", "salvagedRecords",
  "turnContexts", "tokenCounts", "forkReplayEventsSkipped",
  "unattributedForkReplayEventsSkipped", "cumulativeCounterRegressions",
  "cumulativePrefixUnattributed",
  "tierEvents", "modelSeededFromLineage", "tierSeededFromLineage",
  "modelMissing", "oversizedLines", "contradictedLeadingSnapshotsSkipped",
  "toolRecords", "toolEvents", "toolRecordsSkipped",
  "toolSourceHistoryUnavailable", "compactionEvents",
  "responseUsageEvents", "responseDuplicateCopies", "responseForeignThreadRecords", "responseModelUnattributed",
  "responseUnverifiedPrefixTurns",
  "responseModelsRecovered", "responseModelRecoveryVersion",
  "modelRecognitionVersion",
  "deferredTailBytes",
]);

// Extraction-level reasons first; the rest are discovery-level reasons, which
// retain the source row (and so its ordinal) while its facts are removed.
export const EXTRACTION_QUARANTINE_CODES = Object.freeze([
  "codex_rollout_content_invalid",
  "codex_rollout_tail_incomplete",
  "codex_rollout_lineage_invalid",
]);
export const DISCOVERY_QUARANTINE_CODES = Object.freeze([
  "codex_rollout_compression_unsupported",
  "codex_rollout_filename_identity_mismatch",
  "codex_rollout_generation_ambiguous",
]);
const QUARANTINE_CODES = [
  ...EXTRACTION_QUARANTINE_CODES,
  ...DISCOVERY_QUARANTINE_CODES,
];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL) STRICT;

  CREATE TABLE IF NOT EXISTS runtime_model_evidence(
    evidence_key BLOB PRIMARY KEY CHECK(length(evidence_key)=32),
    response_key BLOB CHECK(response_key IS NULL OR length(response_key)=32),
    thread_key BLOB NOT NULL CHECK(length(thread_key)=32),
    turn_key BLOB CHECK(turn_key IS NULL OR length(turn_key)=32),
    observed_at_ms INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('response_completed','fallback_succeeded','fallback_failed','request_context','response_reference')),
    model TEXT NOT NULL,
    previous_model TEXT,
    digest BLOB NOT NULL CHECK(length(digest)=32)) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS runtime_model_evidence_response ON runtime_model_evidence(response_key);

  -- Monotonic publication counter. Readers key every cache off it.
  CREATE TABLE IF NOT EXISTS store_state(
    id INTEGER PRIMARY KEY CHECK(id = 1),
    commit_seq INTEGER NOT NULL,
    calculation_revision INTEGER NOT NULL DEFAULT 0 CHECK(calculation_revision >= 0)) STRICT;

  -- One short summary per refresh; the newest 100 are kept.
  CREATE TABLE IF NOT EXISTS commit_log(
    seq INTEGER PRIMARY KEY,
    committed_at_ms INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('cold', 'refresh', 'verify')),
    sources_changed INTEGER NOT NULL,
    events_added INTEGER NOT NULL,
    events_removed INTEGER NOT NULL) STRICT;

  CREATE TABLE IF NOT EXISTS model(
    id INTEGER PRIMARY KEY,
    model_id TEXT NOT NULL UNIQUE,
    recognition TEXT NOT NULL) STRICT;

  CREATE TABLE IF NOT EXISTS tier_semantics(
    id INTEGER PRIMARY KEY,
    api_service_tier TEXT NOT NULL,
    billing_surface TEXT NOT NULL,
    codex_speed_mode TEXT NOT NULL,
    tier_source TEXT NOT NULL,
    provider_tier_raw TEXT,
    UNIQUE(api_service_tier, billing_surface, codex_speed_mode,
           tier_source, provider_tier_raw)) STRICT;

  CREATE TABLE IF NOT EXISTS surface_class(
    id INTEGER PRIMARY KEY,
    agent_scope TEXT NOT NULL,
    surface TEXT NOT NULL,
    thread_source TEXT NOT NULL,
    lineage_disposition TEXT NOT NULL,
    UNIQUE(agent_scope, surface, thread_source, lineage_disposition)) STRICT;

  CREATE TABLE IF NOT EXISTS account_scope(
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    reason TEXT,
    plan_type TEXT,
    scope_local BLOB,
    UNIQUE(status, reason, plan_type, scope_local)) STRICT;

  -- Working directories observed in rollouts. Local-only evidence (owner
  -- decision 2026-10-12): it never leaves the machine, and project and
  -- worktree names are resolved from it at read time.
  CREATE TABLE IF NOT EXISTS work_directory(
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE CHECK(length(path) BETWEEN 1 AND 4096)) STRICT;

  CREATE TABLE IF NOT EXISTS session(
    id INTEGER PRIMARY KEY,
    session_local BLOB NOT NULL UNIQUE CHECK(length(session_local) = 32),
    session_uuid TEXT) STRICT;

  -- Canonical quota readings, deduplicated across sources. Source-scoped
  -- readings stay in quota_occurrence.
  CREATE TABLE IF NOT EXISTS quota_observation(
    id INTEGER PRIMARY KEY,
    observed_at_ms INTEGER NOT NULL,
    limit_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    plan_type TEXT,
    used_percent REAL,
    resets_at_ms INTEGER,
    duration_mins INTEGER,
    UNIQUE(observed_at_ms, limit_id, slot)) STRICT;

  -- The catalog: one row per rollout source ever seen. A source that vanishes
  -- from disk becomes 'absent' and keeps its facts.
  CREATE TABLE IF NOT EXISTS source(
    id INTEGER PRIMARY KEY,
    source_local BLOB NOT NULL UNIQUE CHECK(length(source_local) = 32),
    source_ordinal INTEGER NOT NULL UNIQUE CHECK(source_ordinal >= 0),
    session_id INTEGER REFERENCES session,
    surface_id INTEGER REFERENCES surface_class,
    path TEXT NOT NULL,
    rollout_key TEXT NOT NULL,
    presence TEXT NOT NULL CHECK(presence IN ('present', 'absent')),
    -- Exact "device:inode" in decimal. NTFS file ids use up to 64 bits, which
    -- doubles cannot hold, so the identity is text and is compared by equality.
    -- NULL means the platform reported no usable file id.
    file_id TEXT,
    birthtime_ms REAL,
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    mtime_ms REAL NOT NULL,
    ctime_ms REAL,
    scanned_bytes INTEGER NOT NULL CHECK(scanned_bytes >= 0),
    head_digest BLOB,
    boundary_digest BLOB,
    tail_digest BLOB,
    verified_at_ms INTEGER,
    verified_bytes INTEGER NOT NULL DEFAULT 0,
    parser_version TEXT NOT NULL,
    quarantine_code TEXT CHECK(quarantine_code IS NULL OR quarantine_code IN (
      'codex_rollout_content_invalid',
      'codex_rollout_tail_incomplete',
      'codex_rollout_lineage_invalid',
      'codex_rollout_compression_unsupported',
      'codex_rollout_filename_identity_mismatch',
      'codex_rollout_generation_ambiguous')),
    snapshots_persisted INTEGER NOT NULL DEFAULT 0,
    turn_context_seen INTEGER NOT NULL DEFAULT 0,
    carry_model TEXT,
    carry_effort TEXT,
    carry_tier_raw TEXT,
    carry_tier_observed_at_ms INTEGER,
    carry_tier_source TEXT CHECK(carry_tier_source IS NULL OR carry_tier_source IN (
      'turn_override', 'rollout_thread_settings')),
    carry_total_input INTEGER,
    carry_total_cached INTEGER,
    carry_total_cache_write INTEGER,
    carry_total_output INTEGER,
    carry_total_reasoning INTEGER,
    carry_total_total INTEGER,
    carry_work_directory_id INTEGER REFERENCES work_directory,
    compacted_at_ms INTEGER,
    compaction_offset INTEGER,
    turn_context_pending INTEGER NOT NULL DEFAULT 0,
    -- Rollout lineage, stored so an unchanged source needs no header read.
    lineage_json TEXT,
    CHECK((compacted_at_ms IS NULL) = (compaction_offset IS NULL))) STRICT;

  -- One SHA-256 per complete 4 MiB aligned segment of [0, scanned_bytes).
  CREATE TABLE IF NOT EXISTS source_segment(
    source_id INTEGER NOT NULL REFERENCES source ON DELETE CASCADE,
    segment INTEGER NOT NULL CHECK(segment >= 0),
    digest BLOB NOT NULL CHECK(length(digest) = 32),
    PRIMARY KEY(source_id, segment)) STRICT, WITHOUT ROWID;

  -- Clustered by source so a resume appends to one range and a rescan or
  -- recovery deletes one range.
  CREATE TABLE IF NOT EXISTS usage_event(
    source_id INTEGER NOT NULL REFERENCES source,
    source_offset INTEGER NOT NULL CHECK(source_offset >= 0),
    observed_at_ms INTEGER NOT NULL,
    event_key BLOB NOT NULL CHECK(length(event_key) = 32),
    session_id INTEGER NOT NULL REFERENCES session,
    account_scope_id INTEGER NOT NULL REFERENCES account_scope,
    model_id INTEGER NOT NULL REFERENCES model,
    tier_id INTEGER NOT NULL REFERENCES tier_semantics,
    surface_id INTEGER NOT NULL REFERENCES surface_class,
    quota_observation_id INTEGER REFERENCES quota_observation,
    tier_observed_at_ms INTEGER,
    reasoning_effort INTEGER NOT NULL,
    flags INTEGER NOT NULL DEFAULT 0,
    -- The working directory in force at this record; NULL is unknown.
    work_directory_id INTEGER REFERENCES work_directory,
    tokens_in_uncached INTEGER,
    tokens_in_cache_read INTEGER,
    tokens_in_cache_write INTEGER,
    tokens_out_text INTEGER,
    tokens_out_reasoning INTEGER,
    tokens_out_combined INTEGER,
    total_input_context INTEGER,
    PRIMARY KEY(source_id, source_offset)) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS usage_event_boundary(
    source_id INTEGER NOT NULL,
    source_offset INTEGER NOT NULL,
    compaction_before INTEGER NOT NULL CHECK(compaction_before IN (0, 1)),
    turn_context_before INTEGER NOT NULL CHECK(turn_context_before IN (0, 1)),
    compacted_at_ms INTEGER,
    CHECK(compaction_before = (compacted_at_ms IS NOT NULL)),
    CHECK(compaction_before = 1 OR turn_context_before = 1),
    PRIMARY KEY(source_id, source_offset)) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS quota_occurrence(
    source_id INTEGER NOT NULL REFERENCES source,
    source_offset INTEGER NOT NULL CHECK(source_offset >= 0),
    slot_order INTEGER NOT NULL CHECK(slot_order >= 0),
    surface_id INTEGER NOT NULL REFERENCES surface_class,
    canonical_observation_id INTEGER NOT NULL REFERENCES quota_observation,
    observed_at_ms INTEGER NOT NULL,
    provider TEXT NOT NULL,
    plan_type TEXT,
    limit_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    used_percent REAL NOT NULL CHECK(used_percent >= 0 AND used_percent <= 100),
    resets_at_ms INTEGER,
    duration_mins INTEGER NOT NULL CHECK(duration_mins >= 1),
    admission TEXT NOT NULL CHECK(admission IN ('admitted', 'held', 'suppressed')),
    PRIMARY KEY(source_id, source_offset, slot_order)) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS tool_class_fact(
    source_id INTEGER NOT NULL REFERENCES source,
    source_offset INTEGER NOT NULL CHECK(source_offset >= 0),
    tool_ordinal INTEGER NOT NULL CHECK(tool_ordinal >= 0),
    event_key BLOB NOT NULL CHECK(length(event_key) = 32),
    session_id INTEGER NOT NULL REFERENCES session,
    observed_at_ms INTEGER NOT NULL,
    tool_class TEXT NOT NULL CHECK(length(tool_class) BETWEEN 1 AND 64),
    source_kind TEXT NOT NULL CHECK(length(source_kind) BETWEEN 1 AND 64),
    PRIMARY KEY(source_id, source_offset, tool_ordinal)) STRICT, WITHOUT ROWID;

  -- Persisted fork-replay boundary: membership is the only question asked.
  CREATE TABLE IF NOT EXISTS work_lifecycle_fact(
    source_id INTEGER NOT NULL REFERENCES source,
    source_offset INTEGER NOT NULL CHECK(source_offset >= 0),
    session_id INTEGER NOT NULL REFERENCES session,
    task_key BLOB NOT NULL CHECK(length(task_key) = 32),
    observed_at_ms INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('start', 'complete', 'abort')),
    duration_ms INTEGER CHECK(duration_ms >= 0),
    PRIMARY KEY(source_id, source_offset)) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS lineage_snapshot(
    session_id INTEGER NOT NULL REFERENCES session,
    snapshot_local BLOB NOT NULL,
    PRIMARY KEY(session_id, snapshot_local)) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS source_diagnostic(
    source_id INTEGER NOT NULL REFERENCES source ON DELETE CASCADE,
    code TEXT NOT NULL,
    count INTEGER NOT NULL CHECK(count >= 0),
    PRIMARY KEY(source_id, code)) STRICT, WITHOUT ROWID;
`;

// Reader-only indexes. A cold build creates them after the load so SQLite does
// not maintain these b-trees for every inserted row.
const SECONDARY_INDEX_SCHEMA = `
  CREATE INDEX IF NOT EXISTS usage_event_observed
    ON usage_event(observed_at_ms);
  CREATE INDEX IF NOT EXISTS usage_event_session
    ON usage_event(session_id, observed_at_ms);
  CREATE INDEX IF NOT EXISTS quota_occurrence_canonical
    ON quota_occurrence(canonical_observation_id);
  CREATE INDEX IF NOT EXISTS quota_occurrence_observed
    ON quota_occurrence(observed_at_ms);
  -- A rescan drops the quota observations a source alone supported, and each
  -- drop must prove that no event still points at it. Without this index that
  -- proof (and the foreign-key check beside it) scans every event, which made
  -- one rescan of a real source take tens of seconds.
  CREATE INDEX IF NOT EXISTS usage_event_quota
    ON usage_event(quota_observation_id) WHERE quota_observation_id IS NOT NULL;
  -- Covers the cache-impact pairing scan: positive-input requests only, in
  -- session order, with everything the adjacency window compares. The
  -- predicate text must match the reader's so the planner can use it.
  CREATE INDEX IF NOT EXISTS usage_event_pairing
    ON usage_event(session_id, source_id, source_offset, observed_at_ms,
                   model_id, reasoning_effort, tier_id, surface_id,
                   tokens_in_cache_read)
    WHERE COALESCE(tokens_in_uncached, 0) + COALESCE(tokens_in_cache_read, 0)
        + COALESCE(tokens_in_cache_write, 0) > 0;
  -- Covers the quota series read: per-track rank sampling walks this index in
  -- order and never touches the table.
  CREATE INDEX IF NOT EXISTS quota_observation_series
    ON quota_observation(limit_id, duration_mins, observed_at_ms,
                         slot, plan_type, used_percent, resets_at_ms);
`;

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function ownerOnlyRegularFile(metadata) {
  return metadata.isFile()
    && metadata.nlink === 1
    && (typeof process.getuid !== "function" || metadata.uid === process.getuid())
    && (process.platform === "win32" || (metadata.mode & 0o077) === 0);
}

function assertOwnerOnlyDirectory(directory) {
  let metadata;
  try {
    metadata = lstatSync(directory);
  } catch {
    throw fixedError("local_index_file_invalid");
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw fixedError("local_index_file_invalid");
  }
  if (process.platform !== "win32" && typeof process.getuid === "function"
      && (metadata.uid !== process.getuid() || (metadata.mode & 0o022) !== 0)) {
    throw fixedError("local_index_file_invalid");
  }
}

function assertOwnerOnlyTarget(file, { allowMissing }) {
  let metadata;
  try {
    metadata = lstatSync(file);
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw fixedError("local_index_unavailable");
  }
  if (!ownerOnlyRegularFile(metadata)) throw fixedError("local_index_file_invalid");
  return metadata;
}

function reserveTarget(file) {
  let descriptor;
  try {
    descriptor = openSync(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    if (!ownerOnlyRegularFile(fstatSync(descriptor))) {
      throw fixedError("local_index_file_invalid");
    }
  } catch (error) {
    if (error?.code === "local_index_file_invalid") throw error;
    throw fixedError(error?.code === "EEXIST" ? "local_index_file_invalid" : "local_index_unavailable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function configure(database, { readOnly, bulkLoad = false }) {
  if (!readOnly) {
    const mode = database.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
    if (mode !== "wal") throw fixedError("local_index_journal_mode_refused");
    database.exec(`
      PRAGMA synchronous=${bulkLoad ? "OFF" : "NORMAL"};
      PRAGMA wal_autocheckpoint=1000;
      PRAGMA journal_size_limit=67108864;
    `);
  }
  database.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA trusted_schema=OFF;
    PRAGMA temp_store=FILE;
    PRAGMA cache_size=-65536;
    PRAGMA mmap_size=0;
  `);
  database.enableDefensive?.(true);
}

function assertFamily(database, { allowWorkloadPredecessor = false } = {}) {
  const applicationId = database.prepare("PRAGMA application_id").get().application_id;
  const userVersion = database.prepare("PRAGMA user_version").get().user_version;
  if (applicationId !== LOCAL_INDEX_STORE_APPLICATION_ID) {
    throw fixedError("local_index_family_mismatch");
  }
  // Fail closed on newer state: an older binary must not write it.
  if (userVersion > LOCAL_INDEX_STORE_USER_VERSION) {
    throw fixedError("local_index_newer_version");
  }
  if (userVersion < LOCAL_INDEX_STORE_USER_VERSION
        && !(allowWorkloadPredecessor && [4,5,6,7,8].includes(userVersion))) {
    throw fixedError("local_index_family_mismatch");
  }
}

/** Identity-only preflight for reviewed forward migrations. This never
 * returns a database handle or permits projections/writes against old state. */
export function readLocalIndexIdentityBeforeMigration(file, { currentOnly = false } = {}) {
  const path = resolve(file);
  assertOwnerOnlyDirectory(dirname(path));
  assertOwnerOnlyTarget(path, { allowMissing: false });
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
    configure(database, { readOnly: true });
    assertFamily(database, { allowWorkloadPredecessor: !currentOnly });
    if (database.prepare("SELECT value FROM meta WHERE key='family'").get()?.value !== LOCAL_INDEX_STORE_FAMILY) {
      throw fixedError("local_index_family_mismatch");
    }
    return { hasFacts: readCommitSeq(database) > 0
      || database.prepare("SELECT 1 AS present FROM source LIMIT 1").get()?.present === 1 };
  } catch (error) {
    if (error?.code?.startsWith("local_index_")) throw error;
    throw fixedError("local_index_unavailable");
  } finally { database?.close(); }
}

// Dependency matrix for the calculation proof. Every fact field, dimension,
// identity and physical ordering is material. Source byte/digest/verification
// metadata is publication-only; completeness transitions remain material.
// All diagnostics are conservative inputs except these extraction counters,
// which only describe physical work and ride in the fresh publication envelope.
const CALCULATION_METADATA_DIAGNOSTICS = [
  "relevantLines", "turnContexts", "tokenCounts", "tierEvents", "toolRecords",
  "responseDuplicateCopies", "responseForeignThreadRecords",
];
function installCalculationRevisionTriggers(database) {
  const tables = ["usage_event", "usage_event_boundary", "quota_occurrence",
    "quota_observation", "tool_class_fact", "work_lifecycle_fact", "lineage_snapshot",
    "model", "tier_semantics", "surface_class",
    "account_scope", "session", "work_directory"];
  for (const table of tables) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
      // Newly interned dimensions are inert until a fact/source references them.
      // Nullable UNIQUE keys can allocate an unused duplicate on replay.
      if (operation === "INSERT" && ["model", "tier_semantics", "surface_class", "account_scope", "session", "work_directory"].includes(table)) continue;
      const when = operation === "UPDATE"
        ? `WHEN ${columns.map(name => `OLD.${name} IS NOT NEW.${name}`).join(" OR ")}` : "";
      database.exec(`CREATE TRIGGER calculation_${table}_${operation.toLowerCase()}
        AFTER ${operation} ON ${table} ${when} BEGIN
        UPDATE store_state SET calculation_revision=calculation_revision+1 WHERE id=1; END`);
    }
  }
  installCalculationSourceRevisionTriggers(database);
  for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    const benign = CALCULATION_METADATA_DIAGNOSTICS.map(code => `'${code}'`).join(",");
    const condition = operation === "INSERT" ? `NEW.code NOT IN (${benign})`
      : operation === "DELETE" ? `OLD.code NOT IN (${benign})`
        : `(OLD.code NOT IN (${benign}) OR NEW.code NOT IN (${benign})) AND (OLD.code IS NOT NEW.code OR OLD.count IS NOT NEW.count)`;
    database.exec(`CREATE TRIGGER calculation_diagnostic_${operation.toLowerCase()}
      AFTER ${operation} ON source_diagnostic WHEN ${condition} BEGIN
      UPDATE store_state SET calculation_revision=calculation_revision+1 WHERE id=1; END`);
  }
}

function installCalculationSourceRevisionTriggers(database, { replaceExisting = false } = {}) {
  const availableColumns = new Set(database.prepare("PRAGMA table_info(source)").all().map((row) => row.name));
  const sourceColumns = ["source_local", "source_ordinal", "session_id", "surface_id",
    "presence", "parser_version", "quarantine_code", "snapshots_persisted",
    "carry_model", "carry_effort", "carry_tier_raw", "carry_tier_observed_at_ms",
    ...(availableColumns.has("carry_tier_source") ? ["carry_tier_source"] : []),
    "carry_work_directory_id", "compacted_at_ms", "compaction_offset", "turn_context_pending"];
  for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
    const name = `calculation_source_${operation.toLowerCase()}`;
    if (replaceExisting) database.exec(`DROP TRIGGER IF EXISTS ${name}`);
    const when = operation === "UPDATE" ? `WHEN ${sourceColumns.map(column => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")}
      OR (OLD.scanned_bytes = OLD.size_bytes) IS NOT (NEW.scanned_bytes = NEW.size_bytes)
      OR (OLD.scanned_bytes IS NOT NEW.scanned_bytes AND (
        ${["usage_event", "usage_event_boundary", "quota_occurrence", "tool_class_fact", "work_lifecycle_fact"].map(table => `EXISTS(SELECT 1 FROM ${table} WHERE source_id=NEW.id AND source_offset>MIN(OLD.scanned_bytes,NEW.scanned_bytes) AND source_offset<=MAX(OLD.scanned_bytes,NEW.scanned_bytes))`).join(" OR ")}
      ))
      OR (CASE WHEN json_valid(OLD.lineage_json) THEN json_remove(OLD.lineage_json,'$.statSize','$.size','$.contentSha256') ELSE OLD.lineage_json END)
        IS NOT (CASE WHEN json_valid(NEW.lineage_json) THEN json_remove(NEW.lineage_json,'$.statSize','$.size','$.contentSha256') ELSE NEW.lineage_json END)` : "";
    database.exec(`CREATE TRIGGER ${name}
      AFTER ${operation} ON source ${when} BEGIN
      UPDATE store_state SET calculation_revision=calculation_revision+1 WHERE id=1; END`);
  }
}

function retireRuntimeCaptureRevisionTriggers(database) {
  // Capture queues receipts without changing published accounting inputs.
  // Foreground reconciliation changes usage_event, whose triggers still fence
  // reuse. Earlier v8 stores also installed triggers on the receipt queue;
  // retire only those triggers, without resetting revisions or rewriting facts.
  const names = ["insert", "update", "delete"].map(operation =>
    `calculation_runtime_model_evidence_${operation}`);
  if (!database.prepare(`SELECT 1 FROM sqlite_master WHERE type='trigger'
    AND tbl_name='runtime_model_evidence' AND name IN (?,?,?) LIMIT 1`).get(...names)) return;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const name of names) database.exec(`DROP TRIGGER IF EXISTS ${name}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function initialize(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(SCHEMA);
    database.exec(ROLLUP_SCHEMA);
    database.exec(PAIRING_SCHEMA);
    database.exec(WORK_ROLLUP_SCHEMA);
    database.prepare(`
      INSERT INTO meta(key, value) VALUES ('family', ?), ('parser_version', ?)`)
      .run(LOCAL_INDEX_STORE_FAMILY, LOCAL_INDEX_PARSER_VERSION);
    // An empty store has nothing to group; this records the thresholds the
    // triggers classify against. The triggers go in last so the rebuild's
    // empty grouping is not counted twice.
    rebuildRollups(database, contextClassStarts());
    database.exec(ROLLUP_TRIGGER_SCHEMA);
    database.exec(PAIRING_TRIGGER_SCHEMA);
    database.exec(WORK_ROLLUP_TRIGGER_SCHEMA);
    database.prepare("INSERT INTO store_state(id, commit_seq) VALUES (1, 0)").run();
    installCalculationRevisionTriggers(database);
    database.exec(`
      PRAGMA application_id=${LOCAL_INDEX_STORE_APPLICATION_ID};
      PRAGMA user_version=${LOCAL_INDEX_STORE_USER_VERSION};
    `);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* keep the original failure */ }
    throw error;
  }
}

/**
 * Open the store. `create` makes a new owner-only file; `readOnly` never
 * mutates it. Writers also run provisional-fact recovery.
 */
const EVIDENCE_WRITE=Symbol('evidence-write');
// Connection-only forward conversion. The caller owns filesystem protection,
// journal mode and copy/source isolation; this helper never opens a path or
// configures SQLite. Normal opens and one-time copy conversion share this SQL.
export function upgradeLocalIndexV8ToV9(database) {
  if (database.isTransaction) throw fixedError("local_index_upgrade_transaction_active");
  database.exec("BEGIN IMMEDIATE");
  try {
    if (database.prepare("PRAGMA application_id").get().application_id !== LOCAL_INDEX_STORE_APPLICATION_ID
        || database.prepare("PRAGMA user_version").get().user_version !== 8) {
      throw fixedError("local_index_upgrade_version_mismatch");
    }
    if (database.prepare("SELECT value FROM meta WHERE key='family'").get()?.value !== LOCAL_INDEX_STORE_FAMILY) {
      throw fixedError("local_index_family_mismatch");
    }
    // v8 stored raw tier and observation time without provenance. Preserve
    // those rows verbatim and leave the additive source field NULL: the
    // missing source cannot be reconstructed from those columns.
    database.exec(`ALTER TABLE source ADD COLUMN carry_tier_source TEXT
      CHECK(carry_tier_source IS NULL OR carry_tier_source IN ('turn_override','rollout_thread_settings'))`);
    installCalculationSourceRevisionTriggers(database, { replaceExisting: true });
    database.exec("PRAGMA user_version=9");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

// Background receipt capture shares the database but must never run ingestion recovery
// while the foreground writer has intentionally committed provisional source batches.
export function openLocalIndexEvidenceStore(file){return openLocalIndexStore(file,{[EVIDENCE_WRITE]:true});}
export function openLocalIndexStore(file, {
  create = false,
  readOnly = false,
  bulkLoad = false,
  [EVIDENCE_WRITE]: evidenceOnly = false,
} = {}) {
  const path = resolve(file);
  if (create && !readOnly) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  assertOwnerOnlyDirectory(dirname(path));
  const existed = assertOwnerOnlyTarget(path, { allowMissing: create && !readOnly }) !== null;
  if (!existed) reserveTarget(path);
  let database;
  try {
    database = new DatabaseSync(path, { readOnly, timeout: 5_000 });
    // Reject newer/foreign files before any write-mode connection pragmas.
    if (existed) assertFamily(database);
    configure(database, { readOnly, bulkLoad });
    if (!existed) initialize(database);
    // Pre-release predecessor conversion belongs to the standalone copy tool.
    // Ordinary readers/writers never upgrade the owner's only database.
    assertFamily(database);
    if (!readOnly) retireRuntimeCaptureRevisionTriggers(database);
    if (!readOnly && !evidenceOnly) {
      // A registry revision that moved a context threshold invalidates the
      // key; the rollups are regrouped from the facts, never from rollouts.
      reconcileRollups(database, undefined, rebuildWorkRollups);
      repairProvisional(database);
    }
  } catch (error) {
    if (database?.isOpen) database.close();
    if (error?.code?.startsWith("local_index_")) throw error;
    throw fixedError("local_index_unavailable");
  }
  if (!readOnly && process.platform !== "win32") chmodSync(path, 0o600);
  return database;
}

const SECONDARY_INDEX_NAMES = [
  "usage_event_observed", "usage_event_session",
  "quota_occurrence_canonical", "quota_occurrence_observed",
  "quota_observation_series", "usage_event_pairing", "usage_event_quota",
];

/**
 * Create the reader-only indexes when they are missing: after a bulk load, or
 * on first open. Performs no write when they already exist.
 */
export function createLocalIndexSecondaryIndexes(database) {
  const present = new Set(database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index'",
  ).all().map((row) => row.name));
  if (SECONDARY_INDEX_NAMES.every((name) => present.has(name))) return false;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(SECONDARY_INDEX_SCHEMA);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* keep the original failure */ }
    throw error;
  }
  return true;
}

/**
 * Run `work` inside one read snapshot, so every statement sees a single
 * `commit_seq`. Keep the work bounded: a pinned reader pins the WAL.
 */
export function withReadSnapshot(database, work) {
  database.exec("BEGIN");
  try {
    const commitSeq = Number(database.prepare(
      "SELECT commit_seq FROM store_state WHERE id = 1",
    ).get().commit_seq);
    return work({ commitSeq });
  } finally {
    try { database.exec("COMMIT"); } catch { /* read transaction already closed */ }
  }
}

export function readPendingResponseModelRecoverySources(database, version) {
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError('Invalid response model recovery version');
  return new Set(database.prepare(`SELECT d.source_id FROM source_diagnostic d
    LEFT JOIN source_diagnostic v ON v.source_id=d.source_id AND v.code='responseModelRecoveryVersion'
    WHERE d.code='responseModelUnattributed' AND d.count>0 AND COALESCE(v.count,0)<?`)
    .all(version).map(row => Number(row.source_id)));
}

export function readPendingModelRecognitionSources(database) {
  return new Set(database.prepare(`SELECT DISTINCT u.source_id FROM usage_event u
    JOIN source s ON s.id=u.source_id JOIN model m ON m.id=u.model_id
    LEFT JOIN source_diagnostic v ON v.source_id=s.id AND v.code='modelRecognitionVersion'
    WHERE m.model_id='unknown' AND u.source_offset<=s.scanned_bytes
      AND COALESCE(v.count,0)<?`).all(LOCAL_INDEX_MODEL_RECOGNITION_VERSION)
    .map(row => Number(row.source_id)));
}

export function readCalculationRevision(database) {
  return Number(database.prepare("SELECT calculation_revision FROM store_state WHERE id=1").get().calculation_revision);
}

export function readCommitSeq(database) {
  return Number(database.prepare(
    "SELECT commit_seq FROM store_state WHERE id = 1",
  ).get().commit_seq);
}

/** Delete facts at or beyond each source's cursor. Idempotent. */
export function repairProvisional(database) {
  const sources = database.prepare(
    "SELECT id, scanned_bytes FROM source",
  ).all();
  if (sources.length === 0) return 0;
  // Probe read-only first: a clean store takes no write transaction.
  const probes = [
    "usage_event", "usage_event_boundary", "quota_occurrence", "tool_class_fact", "work_lifecycle_fact",
  ].map((table) => database.prepare(
    `SELECT 1 AS present FROM ${table} WHERE source_id = ? AND source_offset > ? LIMIT 1`,
  ));
  const dirty = sources.filter((source) => probes.some(
    (probe) => probe.get(Number(source.id), Number(source.scanned_bytes)) !== undefined,
  ));
  if (dirty.length === 0) return 0;
  let removed = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const source of dirty) {
      removed += deleteSourceRange(database, Number(source.id), Number(source.scanned_bytes) + 1);
    }
    pruneEmptyRollups(database);
    pruneEmptyWorkRollups(database);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* keep the original failure */ }
    throw error;
  }
  return removed;
}

function deleteSourceRange(database, sourceId, fromOffset) {
  const affected = database.prepare(`
    SELECT DISTINCT canonical_observation_id AS id FROM quota_occurrence
    WHERE source_id = ? AND source_offset >= ?`).all(sourceId, fromOffset);
  const usage = Number(database.prepare(
    "DELETE FROM usage_event WHERE source_id = ? AND source_offset >= ?",
  ).run(sourceId, fromOffset).changes);
  database.prepare(
    "DELETE FROM usage_event_boundary WHERE source_id = ? AND source_offset >= ?",
  ).run(sourceId, fromOffset);
  database.prepare(
    "DELETE FROM quota_occurrence WHERE source_id = ? AND source_offset >= ?",
  ).run(sourceId, fromOffset);
  database.prepare(
    "DELETE FROM tool_class_fact WHERE source_id = ? AND source_offset >= ?",
  ).run(sourceId, fromOffset);
  database.prepare("DELETE FROM work_lifecycle_fact WHERE source_id = ? AND source_offset >= ?")
    .run(sourceId, fromOffset);
  for (const { id } of affected) {
    const replacement = database.prepare(`
      SELECT plan_type, used_percent, resets_at_ms, duration_mins
      FROM quota_occurrence WHERE canonical_observation_id = ?
      ORDER BY used_percent DESC, COALESCE(resets_at_ms, -1) DESC,
               source_id ASC, source_offset ASC, slot_order ASC
      LIMIT 1`).get(id);
    if (replacement === undefined) {
      database.prepare(`
        DELETE FROM quota_observation WHERE id = ?
          AND NOT EXISTS (SELECT 1 FROM usage_event WHERE quota_observation_id = ?)`)
        .run(id, id);
    } else {
      database.prepare(`
        UPDATE quota_observation SET plan_type = ?, used_percent = ?,
          resets_at_ms = ?, duration_mins = ? WHERE id = ?`).run(
        replacement.plan_type, replacement.used_percent,
        replacement.resets_at_ms, replacement.duration_mins, id,
      );
    }
  }
  return usage;
}

/**
 * The fact writer. Single-threaded and synchronous; every mutation happens
 * between `begin()` and `commit()`.
 */
export function createLocalIndexWriter(database, { deviceSalt = null } = {}) {
  database.exec('CREATE INDEX IF NOT EXISTS usage_event_response_identity ON usage_event(event_key) WHERE (flags & 16)<>0');
  // Retain content-free signatures while a changed source is replaced. Without
  // this transaction-local comparison, deleting its old facts first would let
  // a changed quantity under the same response identity pass unnoticed.
  database.exec('CREATE TEMP TABLE IF NOT EXISTS prior_response_usage(event_key BLOB PRIMARY KEY,u INTEGER,c INTEGER,w INTEGER,o INTEGER,r INTEGER) WITHOUT ROWID');
  void deviceSalt;
  const statements = {
    response: database.prepare('SELECT source_id,observed_at_ms at,model_id model,tier_id tier,tier_observed_at_ms tier_at,(flags & 4) assumed,tokens_in_uncached u,tokens_in_cache_read c,tokens_in_cache_write w,tokens_out_combined o,tokens_out_reasoning r FROM usage_event WHERE event_key=? AND (flags & 16)<>0 LIMIT 1'),
    priorResponse: database.prepare('SELECT u,c,w,o,r FROM prior_response_usage WHERE event_key=?'),
    preserveResponses: database.prepare('INSERT OR IGNORE INTO prior_response_usage SELECT event_key,tokens_in_uncached,tokens_in_cache_read,tokens_in_cache_write,tokens_out_combined,tokens_out_reasoning FROM usage_event WHERE source_id=? AND source_offset>=? AND source_offset<=(SELECT scanned_bytes FROM source WHERE id=?) AND (flags & 16)<>0'),
    hasUsage: database.prepare('SELECT 1 FROM usage_event WHERE source_id=? AND source_offset=?'),
    model: database.prepare(`
      INSERT INTO model(model_id, recognition) VALUES (?, ?)
      ON CONFLICT(model_id) DO NOTHING`),
    selectModel: database.prepare("SELECT id FROM model WHERE model_id = ?"),
    tier: database.prepare(`
      INSERT INTO tier_semantics(api_service_tier, billing_surface,
        codex_speed_mode, tier_source, provider_tier_raw)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`),
    selectTier: database.prepare(`
      SELECT id FROM tier_semantics
      WHERE api_service_tier = ? AND billing_surface = ?
        AND codex_speed_mode = ? AND tier_source = ?
        AND provider_tier_raw IS ?`),
    surface: database.prepare(`
      INSERT INTO surface_class(agent_scope, surface, thread_source, lineage_disposition)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`),
    selectSurface: database.prepare(`
      SELECT id FROM surface_class
      WHERE agent_scope = ? AND surface = ? AND thread_source = ?
        AND lineage_disposition = ?`),
    accountScope: database.prepare(`
      INSERT INTO account_scope(status, reason, plan_type, scope_local)
      VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`),
    selectAccountScope: database.prepare(`
      SELECT id FROM account_scope
      WHERE status = ? AND reason IS ? AND plan_type IS ? AND scope_local IS ?`),
    session: database.prepare(`
      INSERT INTO session(session_local, session_uuid) VALUES (?, ?)
      ON CONFLICT(session_local) DO UPDATE SET
        session_uuid = COALESCE(session.session_uuid, excluded.session_uuid)`),
    selectSession: database.prepare("SELECT id FROM session WHERE session_local = ?"),
    workDirectory: database.prepare(
      "INSERT INTO work_directory(path) VALUES (?) ON CONFLICT(path) DO NOTHING",
    ),
    selectWorkDirectory: database.prepare("SELECT id FROM work_directory WHERE path = ?"),
    selectWorkDirectoryPath: database.prepare("SELECT path FROM work_directory WHERE id = ?"),
    // Two sources can report the same (time, limit, slot) with different
    // readings (a fork replays an older percentage). One whole tuple wins by a
    // total order, so the result does not depend on arrival order.
    quota: database.prepare(`
      INSERT INTO quota_observation(observed_at_ms, limit_id, slot, plan_type,
        used_percent, resets_at_ms, duration_mins)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(observed_at_ms, limit_id, slot) DO UPDATE SET
        plan_type = excluded.plan_type,
        used_percent = excluded.used_percent,
        resets_at_ms = excluded.resets_at_ms,
        duration_mins = excluded.duration_mins
      WHERE excluded.used_percent > quota_observation.used_percent
        OR (excluded.used_percent IS quota_observation.used_percent
            AND COALESCE(excluded.resets_at_ms, -1)
                > COALESCE(quota_observation.resets_at_ms, -1))`),
    selectQuota: database.prepare(`
      SELECT id FROM quota_observation
      WHERE observed_at_ms = ? AND limit_id = ? AND slot = ?`),
    usage: database.prepare(`
      INSERT INTO usage_event(
        source_id, source_offset, observed_at_ms, event_key, session_id,
        account_scope_id, model_id, tier_id, surface_id, quota_observation_id,
        tier_observed_at_ms, reasoning_effort, flags, work_directory_id,
        tokens_in_uncached, tokens_in_cache_read, tokens_in_cache_write,
        tokens_out_text, tokens_out_reasoning, tokens_out_combined,
        total_input_context)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, source_offset) DO NOTHING`),
    boundary: database.prepare(`
      INSERT INTO usage_event_boundary(source_id, source_offset,
        compaction_before, turn_context_before, compacted_at_ms)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`),
    quotaOccurrence: database.prepare(`
      INSERT INTO quota_occurrence(
        source_id, source_offset, slot_order, surface_id,
        canonical_observation_id, observed_at_ms, provider, plan_type,
        limit_id, slot, used_percent, resets_at_ms, duration_mins, admission)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, source_offset, slot_order) DO UPDATE SET
        surface_id = excluded.surface_id,
        canonical_observation_id = excluded.canonical_observation_id,
        observed_at_ms = excluded.observed_at_ms,
        provider = excluded.provider,
        plan_type = excluded.plan_type,
        limit_id = excluded.limit_id,
        slot = excluded.slot,
        used_percent = excluded.used_percent,
        resets_at_ms = excluded.resets_at_ms,
        duration_mins = excluded.duration_mins,
        admission = excluded.admission`),
    settledQuota: database.prepare(`
      SELECT provider, plan_type AS planType, limit_id AS limitId, slot,
             used_percent AS usedPercent, resets_at_ms AS resetsAt,
             duration_mins AS windowDurationMins
      FROM quota_occurrence
      WHERE source_id = ? AND admission = 'admitted'
      GROUP BY provider, plan_type, limit_id, slot, used_percent,
               resets_at_ms, duration_mins`),
    toolFact: database.prepare(`
      INSERT INTO tool_class_fact(source_id, source_offset, tool_ordinal,
        event_key, session_id, observed_at_ms, tool_class, source_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`),
    workFact: database.prepare(`INSERT INTO work_lifecycle_fact
      (source_id, source_offset, session_id, task_key, observed_at_ms, kind, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`),
    lineageSnapshot: database.prepare(`
      INSERT INTO lineage_snapshot(session_id, snapshot_local)
      VALUES (?, ?) ON CONFLICT DO NOTHING`),
    deleteLineageSnapshots: database.prepare(
      "DELETE FROM lineage_snapshot WHERE session_id = ?",
    ),
    deleteSegments: database.prepare("DELETE FROM source_segment WHERE source_id = ?"),
    segment: database.prepare(`
      INSERT INTO source_segment(source_id, segment, digest) VALUES (?, ?, ?)
      ON CONFLICT(source_id, segment) DO UPDATE SET digest = excluded.digest`),
    diagnostic: database.prepare(`
      INSERT INTO source_diagnostic(source_id, code, count) VALUES (?, ?, ?)
      ON CONFLICT(source_id, code) DO UPDATE SET count = excluded.count WHERE count IS NOT excluded.count`),
    selectSource: database.prepare("SELECT id, source_ordinal FROM source WHERE source_local = ?"),
    insertSource: database.prepare(`
      INSERT INTO source(
        source_local, source_ordinal, session_id, surface_id, path, rollout_key,
        presence, file_id, birthtime_ms, size_bytes, mtime_ms, ctime_ms,
        scanned_bytes, parser_version, lineage_json)
      VALUES (?, ?, ?, ?, ?, ?, 'present', ?, ?, ?, ?, ?, 0, ?, ?)`),
    maxOrdinal: database.prepare("SELECT COALESCE(MAX(source_ordinal), -1) AS value FROM source"),
    nextSeq: database.prepare(
      "UPDATE store_state SET commit_seq = commit_seq + 1 WHERE id = 1 RETURNING commit_seq",
    ),
    logCommit: database.prepare(`
      INSERT INTO commit_log(seq, committed_at_ms, kind, sources_changed,
        events_added, events_removed) VALUES (?, ?, ?, ?, ?, ?)`),
    trimLog: database.prepare("DELETE FROM commit_log WHERE seq <= ?"),
  };

  const modelIds = new Map();
  const tierIds = new Map();
  const surfaceIds = new Map();
  const scopeIds = new Map();
  const sessionIds = new Map();
  const workDirectoryIds = new Map();
  const quotaIds = new Map();
  // Bounded SQLite TEMP staging, only for sources without quota or lineage.
  // Those reconciliation classes keep the existing conservative full replay.
  const candidateStatements = new Map();
  const candidateTables = ["usage_event", "usage_event_boundary", "tool_class_fact", "work_lifecycle_fact"];
  const candidateStatementNames = ["usage", "boundary", "toolFact", "workFact", "hasUsage"];
  let candidateSource = null;
  function stopCandidate() {
    if (candidateSource === null) return;
    for (const [name, original] of candidateStatements) statements[name] = original;
    candidateStatements.clear();
    candidateSource = null;
  }
  let transaction = false;
  let transactions = 0;
  let eventsAdded = 0;
  let eventsRemoved = 0;
  let nextOrdinal = null;

  function assertTransaction() {
    if (!transaction) throw fixedError("local_index_transaction_required");
  }

  function intern(cache, key, insert, select) {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    assertTransaction();
    // SQLite UNIQUE treats NULL as distinct. Reuse the reviewed IS-based
    // lookup before inserting so replay cannot accumulate unused dimensions.
    const existing = select();
    if (existing !== undefined) {
      const id = Number(existing.id);
      cache.set(key, id);
      return id;
    }
    insert();
    const id = Number(select().id);
    cache.set(key, id);
    return id;
  }

  return {
    begin() {
      if (transaction) throw fixedError("local_index_transaction_open");
      database.exec("BEGIN IMMEDIATE");
      transaction = true;
      transactions += 1;
      eventsAdded = 0;
      eventsRemoved = 0;
    },
    beginSourceCandidate(sourceId) {
      assertTransaction();
      if (database.prepare("SELECT 1 FROM quota_occurrence WHERE source_id=? LIMIT 1").get(sourceId)
          || database.prepare("SELECT 1 FROM lineage_snapshot WHERE session_id=(SELECT session_id FROM source WHERE id=?) LIMIT 1").get(sourceId)) return false;
      for (const table of candidateTables) {
        const schema = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
        database.exec(schema.replace(`CREATE TABLE ${table}`, `CREATE TEMP TABLE IF NOT EXISTS candidate_${table}`).replace(/ REFERENCES [a-z_]+(?: ON DELETE CASCADE)?/g, ""));
        database.exec(`DELETE FROM candidate_${table}`);
      }
      candidateSource = sourceId;
      for (const name of candidateStatementNames) {
        const original = statements[name];
        let sql = original.sourceSQL;
        for (const table of candidateTables) sql = sql.replace(new RegExp(`\\b${table}\\b`, "g"), `candidate_${table}`);
        candidateStatements.set(name, original);
        statements[name] = database.prepare(sql);
      }
      return true;
    },
    finishSourceCandidate() {
      assertTransaction();
      if (candidateSource === null) return false;
      const sourceId = candidateSource;
      const equal = candidateTables.every(table =>
        database.prepare(`SELECT 1 FROM (SELECT * FROM ${table} WHERE source_id=? EXCEPT SELECT * FROM candidate_${table}) LIMIT 1`).get(sourceId) === undefined
        && database.prepare(`SELECT 1 FROM (SELECT * FROM candidate_${table} EXCEPT SELECT * FROM ${table} WHERE source_id=?) LIMIT 1`).get(sourceId) === undefined);
      stopCandidate();
      if (!equal) throw fixedError("local_index_candidate_replay_required");
      // No durable usage/rollup/pairing rows were deleted or reinserted.
      eventsAdded = 0;
      return true;
    },
    /** Commit and publish. Returns the new `commit_seq`. */
    commit({ kind = "refresh", sourcesChanged = 1, bumpSeq = true } = {}) {
      assertTransaction();
      if (candidateSource !== null) throw fixedError("local_index_candidate_unfinished");
      let seq = null;
      try {
        if (bumpSeq) {
          seq = Number(statements.nextSeq.get().commit_seq);
          statements.logCommit.run(
            seq, Date.now(), kind, sourcesChanged, eventsAdded, eventsRemoved,
          );
          statements.trimLog.run(seq - 100);
        }
        database.exec("COMMIT");
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* keep the original failure */ }
        transaction = false;
        throw error;
      }
      transaction = false;
      return seq;
    },
    rollback() {
      if (!transaction) return;
      stopCandidate();
      try { database.exec("ROLLBACK"); } finally {
        transaction = false;
        for (const cache of [modelIds, tierIds, surfaceIds, scopeIds, sessionIds, workDirectoryIds, quotaIds]) cache.clear();
      }
    },
    get inTransaction() { return transaction; },
    /** Write transactions begun on this writer; the no-change gate reads it. */
    get transactions() { return transactions; },

    internModel(modelId, recognition) {
      return intern(modelIds, modelId,
        () => statements.model.run(modelId, recognition),
        () => statements.selectModel.get(modelId));
    },
    internTier(tier) {
      const key = `${tier.apiServiceTier}\0${tier.billingSurface}\0${tier.codexSpeedMode}\0${tier.tierSource}\0${tier.providerTierRaw ?? ""}\0${tier.providerTierRaw === null ? "n" : "s"}`;
      const args = [tier.apiServiceTier, tier.billingSurface, tier.codexSpeedMode,
        tier.tierSource, tier.providerTierRaw ?? null];
      return intern(tierIds, key,
        () => statements.tier.run(...args),
        () => statements.selectTier.get(...args));
    },
    internSurface(surface) {
      const key = `${surface.agentScope}\0${surface.surface}\0${surface.threadSource}\0${surface.lineageDisposition}`;
      const args = [surface.agentScope, surface.surface, surface.threadSource,
        surface.lineageDisposition];
      return intern(surfaceIds, key,
        () => statements.surface.run(...args),
        () => statements.selectSurface.get(...args));
    },
    internAccountScope(scope) {
      const blob = scope.scopeLocal ?? null;
      const key = `${scope.status}\0${scope.reason ?? ""}\0${scope.reason === null ? "n" : "s"}\0${scope.planType ?? ""}\0${scope.planType === null ? "n" : "s"}\0${blob === null ? "" : Buffer.from(blob).toString("base64")}`;
      const args = [scope.status, scope.reason ?? null, scope.planType ?? null, blob];
      return intern(scopeIds, key,
        () => statements.accountScope.run(...args),
        () => statements.selectAccountScope.get(...args));
    },
    /** `sessionUuid` is recorded only when it is strictly UUID-shaped. */
    internSession(sessionLocalKey, sessionUuid = null) {
      const key = Buffer.from(sessionLocalKey).toString("base64");
      const uuid = typeof sessionUuid === "string" && RAW_SESSION_UUID.test(sessionUuid)
        ? sessionUuid
        : null;
      assertTransaction();
      const cached = sessionIds.get(key);
      if (cached !== undefined && uuid === null) return cached;
      statements.session.run(Buffer.from(sessionLocalKey), uuid);
      const id = Number(statements.selectSession.get(Buffer.from(sessionLocalKey)).id);
      sessionIds.set(key, id);
      return id;
    },
    /** Intern a working directory; null stays unknown. */
    internWorkDirectory(path) {
      if (path === null || path === undefined) return null;
      const cached = workDirectoryIds.get(path);
      if (cached !== undefined) return cached;
      assertTransaction();
      statements.workDirectory.run(path);
      const id = Number(statements.selectWorkDirectory.get(path).id);
      workDirectoryIds.set(path, id);
      if (workDirectoryIds.size > 50_000) workDirectoryIds.clear();
      return id;
    },
    workDirectoryPath(id) {
      if (id === null || id === undefined) return null;
      return statements.selectWorkDirectoryPath.get(Number(id))?.path ?? null;
    },
    internQuota(observation) {
      if (candidateSource !== null) throw fixedError("local_index_candidate_replay_required");
      const key = `${observation.observedAtMs}\0${observation.limitId}\0${observation.slot}`
        + `\0${observation.planType ?? ""}\0${observation.usedPercent ?? ""}`
        + `\0${observation.resetsAtMs ?? ""}\0${observation.durationMins ?? ""}`;
      const cached = quotaIds.get(key);
      if (cached !== undefined) return cached;
      assertTransaction();
      statements.quota.run(
        observation.observedAtMs, observation.limitId, observation.slot,
        observation.planType ?? null, observation.usedPercent ?? null,
        observation.resetsAtMs ?? null, observation.durationMins ?? null,
      );
      const id = Number(statements.selectQuota.get(
        observation.observedAtMs, observation.limitId, observation.slot,
      ).id);
      quotaIds.set(key, id);
      if (quotaIds.size > 200_000) quotaIds.clear();
      return id;
    },

    /**
     * Keep newly allocated ordinals above `floor`. A carried ordinal map must
     * reserve its maximum first, or an unseeded source registered earlier could
     * take an ordinal a later seeded source needs.
     */
    reserveOrdinalsAbove(floor) {
      if (nextOrdinal === null) nextOrdinal = Number(statements.maxOrdinal.get().value) + 1;
      nextOrdinal = Math.max(nextOrdinal, floor + 1);
    },

    /**
     * Register a discovered source and return `{ id, ordinal, created }`. A
     * new source takes `ordinal` when supplied (carried identity metadata),
     * otherwise the next unused one; an existing source keeps its ordinal.
     */
    registerSource(source) {
      assertTransaction();
      const existing = statements.selectSource.get(Buffer.from(source.sourceLocal));
      if (existing !== undefined) {
        return { id: Number(existing.id), ordinal: Number(existing.source_ordinal), created: false };
      }
      if (nextOrdinal === null) nextOrdinal = Number(statements.maxOrdinal.get().value) + 1;
      let ordinal = source.ordinal;
      if (ordinal === undefined || ordinal === null) {
        ordinal = nextOrdinal;
      }
      nextOrdinal = Math.max(nextOrdinal, ordinal + 1);
      statements.insertSource.run(
        Buffer.from(source.sourceLocal), ordinal, source.sessionId ?? null,
        source.surfaceId ?? null, source.path, source.rolloutKey,
        source.fileId ?? null, source.birthtimeMs ?? null,
        source.sizeBytes, source.mtimeMs, source.ctimeMs ?? null,
        LOCAL_INDEX_PARSER_VERSION,
        source.lineageJson ?? null,
      );
      const created = statements.selectSource.get(Buffer.from(source.sourceLocal));
      return { id: Number(created.id), ordinal, created: true };
    },

    writeUsageEvent(event) {
      assertTransaction();
      if (event.responseUsage) {
        const active = statements.response.get(event.eventKey);
        const old = active ?? statements.priorResponse.get(event.eventKey);
        if (old) {
          if (old.u !== event.tokensInUncached || old.c !== event.tokensInCacheRead
              || old.w !== event.tokensInCacheWrite || old.o !== event.tokensOutCombined
              || old.r !== event.tokensOutReasoning) throw fixedError('codex_response_usage_identity_conflict');
          if (active && !(candidateSource === event.sourceId && Number(active.source_id) === event.sourceId)) {
            // A duplicate physical source cannot choose the response's date,
            // model, speed or availability by arrival order. Re-evaluating the
            // canonical source itself remains a versioned, atomic correction.
            if (active.at !== event.observedAtMs || active.model !== event.modelId
                || active.tier !== event.tierId || active.tier_at !== (event.tierObservedAtMs ?? null)
                || active.assumed !== (event.cacheWriteAssumedZero ? EVENT_FLAG_CACHE_WRITE_ASSUMED_ZERO : 0)) {
              throw fixedError('codex_response_usage_identity_conflict');
            }
            return 0;
          }
        }
      }
      const flags = (event.partial ? EVENT_FLAG_PARTIAL : 0)
        | (event.modelInherited ? EVENT_FLAG_MODEL_INHERITED : 0)
        | (event.cacheWriteAssumedZero ? EVENT_FLAG_CACHE_WRITE_ASSUMED_ZERO : 0)
        | (event.statusOnly ? EVENT_FLAG_STATUS_ONLY : 0)
        | (event.responseUsage ? EVENT_FLAG_RESPONSE_USAGE : 0);
      const changed = Number(statements.usage.run(
        event.sourceId, event.sourceOffset, event.observedAtMs,
        event.eventKey, event.sessionId, event.accountScopeId, event.modelId,
        event.tierId, event.surfaceId, event.quotaObservationId ?? null,
        event.tierObservedAtMs ?? null, event.reasoningEffort, flags,
        event.workDirectoryId ?? null, event.tokensInUncached ?? null, event.tokensInCacheRead ?? null,
        event.tokensInCacheWrite ?? null, event.tokensOutText ?? null,
        event.tokensOutReasoning ?? null, event.tokensOutCombined ?? null,
        event.totalInputContext ?? null,
      ).changes);
      eventsAdded += changed;
      return changed;
    },
    writeBoundary(boundary) {
      assertTransaction();
      return Number(statements.boundary.run(
        boundary.sourceId, boundary.sourceOffset,
        boundary.compactionBefore ? 1 : 0, boundary.turnContextBefore ? 1 : 0,
        boundary.compactedAtMs ?? null,
      ).changes);
    },
    hasUsageEvent(sourceId, offset) { return statements.hasUsage.get(sourceId, offset) !== undefined; },
    writeQuotaOccurrence(occurrence) {
      assertTransaction();
      return Number(statements.quotaOccurrence.run(
        occurrence.sourceId, occurrence.sourceOffset, occurrence.slotOrder,
        occurrence.surfaceId, occurrence.canonicalObservationId,
        occurrence.observedAtMs, occurrence.provider, occurrence.planType ?? null,
        occurrence.limitId, occurrence.slot, occurrence.usedPercent,
        occurrence.resetsAtMs ?? null, occurrence.durationMins, occurrence.admission,
      ).changes);
    },
    writeToolFact(fact) {
      assertTransaction();
      return Number(statements.toolFact.run(
        fact.sourceId, fact.sourceOffset, fact.toolOrdinal, fact.eventKey,
        fact.sessionId, fact.observedAtMs, fact.toolClass, fact.sourceKind,
      ).changes);
    },
    writeWorkFact(fact) {
      assertTransaction();
      return Number(statements.workFact.run(fact.sourceId, fact.sourceOffset,
        fact.sessionId, fact.taskKey, fact.observedAtMs, fact.kind, fact.durationMs).changes);
    },
    addLineageSnapshot(sessionId, snapshotLocalKey) {
      if (candidateSource !== null) throw fixedError("local_index_candidate_replay_required");
      assertTransaction();
      statements.lineageSnapshot.run(sessionId, Buffer.from(snapshotLocalKey));
    },
    clearLineageSnapshots(sessionId) {
      assertTransaction();
      if (candidateSource === null) statements.deleteLineageSnapshots.run(sessionId);
    },
    loadSettledQuotaWindows(sourceId) {
      if (candidateSource !== null) return [];
      return statements.settledQuota.all(sourceId).map((row) => ({
        provider: row.provider,
        planType: row.planType,
        limitId: row.limitId,
        slot: row.slot,
        usedPercent: Number(row.usedPercent),
        resetsAt: row.resetsAt === null ? null : Number(row.resetsAt),
        windowDurationMins: Number(row.windowDurationMins),
      }));
    },

    /** Remove a source's facts from `fromOffset` (0 = all of them). */
    deleteSourceFacts(sourceId, { fromOffset = 0 } = {}) {
      assertTransaction();
      statements.preserveResponses.run(sourceId, fromOffset, sourceId);
      // Facts at or below the cursor are counted by the derived tables. Retreat
      // the cursor first so the retreat triggers undo them in bulk and every
      // fact written afterwards is provisional until the next advance counts
      // it. Rewriting facts under a standing cursor would leave the pairing
      // tables, which have no insert trigger, without the replacement facts.
      const retreatTo = Math.max(0, fromOffset - 1);
      const retreated = Number(database.prepare(
        "UPDATE source SET scanned_bytes = ? WHERE id = ? AND scanned_bytes > ?",
      ).run(retreatTo, sourceId, retreatTo).changes);
      const removed = deleteSourceRange(database, sourceId, fromOffset);
      if (removed > 0 || retreated > 0) {
        pruneEmptyRollups(database);
        pruneEmptyWorkRollups(database);
      }
      eventsRemoved += removed;
      return removed;
    },

    /** Only after a stable full-byte comparison; no fact or cursor changes. */
    markContentUnchanged(sourceId, info) {
      assertTransaction();
      database.prepare("UPDATE source SET path=?, mtime_ms=?, ctime_ms=? WHERE id=?")
        .run(info.path, Number(info.mtimeMs), Number(info.ctimeMs), sourceId);
    },
    /** Replace a source's segment digests and diagnostics, then move its cursor. */
    commitSourceState(sourceId, state) {
      assertTransaction();
      if (state.quarantineCode !== null && state.quarantineCode !== undefined
          && !QUARANTINE_CODES.includes(state.quarantineCode)) {
        throw fixedError("local_index_quarantine_invalid");
      }
      if (state.carryTierSource !== null && state.carryTierSource !== undefined
          && !["turn_override", "rollout_thread_settings"].includes(state.carryTierSource)) {
        throw fixedError("local_index_source_state_invalid");
      }
      database.prepare(`
        UPDATE source SET
          session_id = ?, surface_id = ?, path = ?, rollout_key = ?,
          presence = 'present', file_id = ?, birthtime_ms = ?,
          size_bytes = ?, mtime_ms = ?, ctime_ms = ?, scanned_bytes = ?,
          head_digest = ?, boundary_digest = ?, tail_digest = ?, verified_at_ms = ?,
          verified_bytes = ?, parser_version = ?, quarantine_code = ?,
          snapshots_persisted = ?, turn_context_seen = ?, carry_model = ?,
          carry_effort = ?, carry_tier_raw = ?, carry_tier_observed_at_ms = ?, carry_tier_source = ?,
          carry_total_input = ?, carry_total_cached = ?,
          carry_total_cache_write = ?, carry_total_output = ?,
          carry_total_reasoning = ?, carry_total_total = ?,
          carry_work_directory_id = ?, compacted_at_ms = ?, compaction_offset = ?, turn_context_pending = ?,
          lineage_json = ?
        WHERE id = ?`).run(
        state.sessionId ?? null, state.surfaceId ?? null, state.path, state.rolloutKey,
        state.fileId ?? null, state.birthtimeMs ?? null,
        state.sizeBytes, state.mtimeMs, state.ctimeMs ?? null, state.scannedBytes,
        state.headDigest ?? null, state.boundaryDigest ?? null,
        state.tailDigest ?? null, state.verifiedAtMs ?? null, state.verifiedBytes ?? 0,
        LOCAL_INDEX_PARSER_VERSION, state.quarantineCode ?? null,
        state.snapshotsPersisted ? 1 : 0, state.turnContextSeen ? 1 : 0,
        state.carryModel ?? null, state.carryEffort ?? null,
        state.carryTierRaw ?? null, state.carryTierObservedAtMs ?? null,
        state.carryTierSource ?? null,
        state.carryTotals?.input_tokens ?? null,
        state.carryTotals?.cached_input_tokens ?? null,
        state.carryTotals?.cache_write_input_tokens ?? null,
        state.carryTotals?.output_tokens ?? null,
        state.carryTotals?.reasoning_output_tokens ?? null,
        state.carryTotals?.total_tokens ?? null,
        state.carryWorkDirectoryId ?? null,
        state.compactionPending?.observedAtMs ?? null,
        state.compactionPending?.sourceOffset ?? null,
        state.turnContextPending ? 1 : 0,
        state.lineageJson ?? null,
        sourceId,
      );
      if (state.replaceSegments === true) statements.deleteSegments.run(sourceId);
      if (state.segments !== undefined) {
        for (const [segment, digest] of state.segments) {
          statements.segment.run(sourceId, segment, digest);
        }
      }
      if (state.diagnostics !== undefined) {
        const retained = new Set(Object.entries(state.diagnostics ?? {}).filter(([code, value]) =>
          DIAGNOSTIC_CODES.has(code) && Number.isSafeInteger(Number(value)) && Number(value) >= 0).map(([code]) => code));
        for (const row of database.prepare("SELECT code FROM source_diagnostic WHERE source_id=?").all(sourceId)) {
          if (!retained.has(row.code)) database.prepare("DELETE FROM source_diagnostic WHERE source_id=? AND code=?").run(sourceId, row.code);
        }
        for (const [code, value] of Object.entries(state.diagnostics ?? {})) {
          if (!DIAGNOSTIC_CODES.has(code)) continue;
          const count = Number(value);
          if (!Number.isSafeInteger(count) || count < 0) continue;
          statements.diagnostic.run(sourceId, code, count);
        }
      }
    },

    markVerified(sourceId, verifiedAtMs) {
      assertTransaction();
      database.prepare(`
        UPDATE source SET verified_at_ms = ?, verified_bytes = scanned_bytes
        WHERE id = ?`).run(verifiedAtMs, sourceId);
    },

    markPresent(sourceId) {
      assertTransaction();
      return Number(database.prepare("UPDATE source SET presence = 'present' WHERE id = ? AND presence = 'absent'").run(sourceId).changes);
    },

    markAbsent(sourceId) {
      assertTransaction();
      database.prepare("UPDATE source SET presence = 'absent' WHERE id = ?").run(sourceId);
    },
  };
}

/** Load the whole catalog (a few thousand rows) for in-memory comparison. */
export function loadCatalog(database) {
  const catalog = new Map();
  const rows = database.prepare(`SELECT s.*, COALESCE(d.count, 0) AS deferred_tail_bytes
    FROM source s LEFT JOIN source_diagnostic d
      ON d.source_id=s.id AND d.code='deferredTailBytes'`).all();
  for (const row of rows) {
    catalog.set(Buffer.from(row.source_local).toString("hex"), row);
  }
  return catalog;
}
