import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { types as utilTypes } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { win32 } from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { stableJson } from "../../src/export/canonical-json.js";
import {
  PRE_RELEASE_INDEX_SCHEMA_ALLOWLIST_READY,
  PRE_RELEASE_INDEX_V8_OBJECT_SQL_SHA256,
  PRE_RELEASE_INDEX_V8_OBJECT_TABLE_NAMES,
  PRE_RELEASE_INDEX_V9_MIGRATED_OBJECT_SQL_SHA256,
  PRE_RELEASE_INDEX_V9_MIGRATED_OBJECT_TABLE_NAMES,
  PRE_RELEASE_INDEX_ALTERED_STORE_STATE_SQL_SHA256,
} from "./pre-release-index-v8-schema.mjs";
import {
  LOCAL_INDEX_STORE_APPLICATION_ID,
  LOCAL_INDEX_STORE_FAMILY,
  LOCAL_INDEX_STORE_USER_VERSION,
  upgradeLocalIndexV8ToV9,
} from "../../src/local-index-store.js";
import {
  acquireProtectedSqliteFiles,
  configureGuardedSqliteConnection,
  loadWindowsLegacyStateReadBinding,
  loadWindowsLocalVolumeQueryBinding,
} from "../../src/platform/index.js";

export const PRE_RELEASE_INDEX_CONVERSION_MAXIMUM_BYTES = 1024 ** 3;
export const PRE_RELEASE_INDEX_CONVERSION_REPORT_CODE = "index_copy_upgraded_v8_to_v9";

const FILE_NAME = "local-index-store-v1.sqlite";
const SOURCE_VERSION = 8;
const TARGET_VERSION = 9;
const HASH_CHUNK_BYTES = 64 * 1024;
const MAX_CELL_BYTES = 8 * 1024 * 1024;
const MAX_ROW_BYTES = 16 * 1024 * 1024;
const MAX_LOGICAL_ROWS = 100_000_000;
const MAX_LOGICAL_BYTES = 4 * PRE_RELEASE_INDEX_CONVERSION_MAXIMUM_BYTES;
const MAX_SCHEMA_OBJECTS = 128;
const MAX_SCHEMA_SQL_BYTES = 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const DB_HEADER_BYTES = 100;
const ROLLBACK_JOURNAL_HEADER_BYTES = 28;

// The v8 physical schema at 63e8753a (local-index-store.js and its schema
// modules). v9 adds only source.carry_tier_source.
const V8_COLUMNS = Object.freeze({
  meta: [["key", "TEXT"], ["value", "TEXT"]],
  runtime_model_evidence: [
    ["evidence_key", "BLOB"], ["response_key", "BLOB"], ["thread_key", "BLOB"],
    ["turn_key", "BLOB"], ["observed_at_ms", "INTEGER"], ["kind", "TEXT"],
    ["model", "TEXT"], ["previous_model", "TEXT"], ["digest", "BLOB"],
  ],
  store_state: [["id", "INTEGER"], ["commit_seq", "INTEGER"], ["calculation_revision", "INTEGER"]],
  commit_log: [
    ["seq", "INTEGER"], ["committed_at_ms", "INTEGER"], ["kind", "TEXT"],
    ["sources_changed", "INTEGER"], ["events_added", "INTEGER"], ["events_removed", "INTEGER"],
  ],
  model: [["id", "INTEGER"], ["model_id", "TEXT"], ["recognition", "TEXT"]],
  tier_semantics: [
    ["id", "INTEGER"], ["api_service_tier", "TEXT"], ["billing_surface", "TEXT"],
    ["codex_speed_mode", "TEXT"], ["tier_source", "TEXT"], ["provider_tier_raw", "TEXT"],
  ],
  surface_class: [
    ["id", "INTEGER"], ["agent_scope", "TEXT"], ["surface", "TEXT"],
    ["thread_source", "TEXT"], ["lineage_disposition", "TEXT"],
  ],
  account_scope: [
    ["id", "INTEGER"], ["status", "TEXT"], ["reason", "TEXT"],
    ["plan_type", "TEXT"], ["scope_local", "BLOB"],
  ],
  work_directory: [["id", "INTEGER"], ["path", "TEXT"]],
  session: [["id", "INTEGER"], ["session_local", "BLOB"], ["session_uuid", "TEXT"]],
  quota_observation: [
    ["id", "INTEGER"], ["observed_at_ms", "INTEGER"], ["limit_id", "TEXT"],
    ["slot", "TEXT"], ["plan_type", "TEXT"], ["used_percent", "REAL"],
    ["resets_at_ms", "INTEGER"], ["duration_mins", "INTEGER"],
  ],
  source: [
    ["id", "INTEGER"], ["source_local", "BLOB"], ["source_ordinal", "INTEGER"],
    ["session_id", "INTEGER"], ["surface_id", "INTEGER"], ["path", "TEXT"],
    ["rollout_key", "TEXT"], ["presence", "TEXT"], ["file_id", "TEXT"],
    ["birthtime_ms", "REAL"], ["size_bytes", "INTEGER"], ["mtime_ms", "REAL"],
    ["ctime_ms", "REAL"], ["scanned_bytes", "INTEGER"], ["head_digest", "BLOB"],
    ["boundary_digest", "BLOB"], ["tail_digest", "BLOB"], ["verified_at_ms", "INTEGER"],
    ["verified_bytes", "INTEGER"], ["parser_version", "TEXT"], ["quarantine_code", "TEXT"],
    ["snapshots_persisted", "INTEGER"], ["turn_context_seen", "INTEGER"],
    ["carry_model", "TEXT"], ["carry_effort", "TEXT"], ["carry_tier_raw", "TEXT"],
    ["carry_tier_observed_at_ms", "INTEGER"], ["carry_total_input", "INTEGER"],
    ["carry_total_cached", "INTEGER"], ["carry_total_cache_write", "INTEGER"],
    ["carry_total_output", "INTEGER"], ["carry_total_reasoning", "INTEGER"],
    ["carry_total_total", "INTEGER"], ["carry_work_directory_id", "INTEGER"],
    ["compacted_at_ms", "INTEGER"], ["compaction_offset", "INTEGER"],
    ["turn_context_pending", "INTEGER"], ["lineage_json", "TEXT"],
  ],
  source_segment: [["source_id", "INTEGER"], ["segment", "INTEGER"], ["digest", "BLOB"]],
  usage_event: [
    ["source_id", "INTEGER"], ["source_offset", "INTEGER"], ["observed_at_ms", "INTEGER"],
    ["event_key", "BLOB"], ["session_id", "INTEGER"], ["account_scope_id", "INTEGER"],
    ["model_id", "INTEGER"], ["tier_id", "INTEGER"], ["surface_id", "INTEGER"],
    ["quota_observation_id", "INTEGER"], ["tier_observed_at_ms", "INTEGER"],
    ["reasoning_effort", "INTEGER"], ["flags", "INTEGER"], ["work_directory_id", "INTEGER"],
    ["tokens_in_uncached", "INTEGER"], ["tokens_in_cache_read", "INTEGER"],
    ["tokens_in_cache_write", "INTEGER"], ["tokens_out_text", "INTEGER"],
    ["tokens_out_reasoning", "INTEGER"], ["tokens_out_combined", "INTEGER"],
    ["total_input_context", "INTEGER"],
  ],
  usage_event_boundary: [
    ["source_id", "INTEGER"], ["source_offset", "INTEGER"],
    ["compaction_before", "INTEGER"], ["turn_context_before", "INTEGER"], ["compacted_at_ms", "INTEGER"],
  ],
  quota_occurrence: [
    ["source_id", "INTEGER"], ["source_offset", "INTEGER"], ["slot_order", "INTEGER"],
    ["surface_id", "INTEGER"], ["canonical_observation_id", "INTEGER"],
    ["observed_at_ms", "INTEGER"], ["provider", "TEXT"], ["plan_type", "TEXT"],
    ["limit_id", "TEXT"], ["slot", "TEXT"], ["used_percent", "REAL"],
    ["resets_at_ms", "INTEGER"], ["duration_mins", "INTEGER"], ["admission", "TEXT"],
  ],
  tool_class_fact: [
    ["source_id", "INTEGER"], ["source_offset", "INTEGER"], ["tool_ordinal", "INTEGER"],
    ["event_key", "BLOB"], ["session_id", "INTEGER"], ["observed_at_ms", "INTEGER"],
    ["tool_class", "TEXT"], ["source_kind", "TEXT"],
  ],
  work_lifecycle_fact: [
    ["source_id", "INTEGER"], ["source_offset", "INTEGER"], ["session_id", "INTEGER"],
    ["task_key", "BLOB"], ["observed_at_ms", "INTEGER"], ["kind", "TEXT"], ["duration_ms", "INTEGER"],
  ],
  lineage_snapshot: [["session_id", "INTEGER"], ["snapshot_local", "BLOB"]],
  source_diagnostic: [["source_id", "INTEGER"], ["code", "TEXT"], ["count", "INTEGER"]],
  rollup_context_start: [["start_tokens", "INTEGER"]],
  usage_rollup: [
    ["bucket_ms", "INTEGER"], ["model_id", "INTEGER"], ["tier_id", "INTEGER"],
    ["surface_id", "INTEGER"], ["account_scope_id", "INTEGER"], ["shape", "INTEGER"],
    ["ctx_class", "INTEGER"], ["events", "INTEGER"], ["in_uncached", "INTEGER"],
    ["in_cache_read", "INTEGER"], ["in_cache_write", "INTEGER"], ["out_text", "INTEGER"],
    ["out_reasoning", "INTEGER"], ["out_combined", "INTEGER"],
  ],
  cache_candidate: [
    ["source_id", "INTEGER"], ["source_offset", "INTEGER"],
    ["previous_offset", "INTEGER"], ["session_id", "INTEGER"],
  ],
  session_positive: [["session_id", "INTEGER"], ["source_id", "INTEGER"], ["events", "INTEGER"]],
  work_rollup: [
    ["day_ms", "INTEGER"], ["session_id", "INTEGER"], ["work_directory_id", "INTEGER"],
    ["model_id", "INTEGER"], ["account_scope_id", "INTEGER"], ["shape", "INTEGER"],
    ["ctx_class", "INTEGER"], ["prov", "INTEGER"], ["events", "INTEGER"],
    ["in_uncached", "INTEGER"], ["in_cache_read", "INTEGER"], ["in_cache_write", "INTEGER"],
    ["out_text", "INTEGER"], ["out_reasoning", "INTEGER"], ["out_combined", "INTEGER"],
    ["last_at_ms", "INTEGER"],
  ],
});

const V9_COLUMNS = Object.freeze({
  ...V8_COLUMNS,
  source: [...V8_COLUMNS.source, ["carry_tier_source", "TEXT"]],
});

const WITHOUT_ROWID = new Set([
  "runtime_model_evidence", "source_segment", "usage_event", "usage_event_boundary",
  "quota_occurrence", "tool_class_fact", "work_lifecycle_fact", "lineage_snapshot",
  "source_diagnostic", "usage_rollup", "cache_candidate", "session_positive", "work_rollup",
]);
const PRIMARY_KEYS = Object.freeze({
  meta: ["key"], runtime_model_evidence: ["evidence_key"], store_state: ["id"], commit_log: ["seq"],
  model: ["id"], tier_semantics: ["id"], surface_class: ["id"], account_scope: ["id"],
  work_directory: ["id"], session: ["id"], quota_observation: ["id"], source: ["id"],
  source_segment: ["source_id", "segment"],
  usage_event: ["source_id", "source_offset"], usage_event_boundary: ["source_id", "source_offset"],
  quota_occurrence: ["source_id", "source_offset", "slot_order"],
  tool_class_fact: ["source_id", "source_offset", "tool_ordinal"],
  work_lifecycle_fact: ["source_id", "source_offset"],
  lineage_snapshot: ["session_id", "snapshot_local"], source_diagnostic: ["source_id", "code"],
  rollup_context_start: ["start_tokens"],
  usage_rollup: ["bucket_ms", "model_id", "tier_id", "surface_id", "account_scope_id", "shape", "ctx_class"],
  cache_candidate: ["source_id", "source_offset"], session_positive: ["session_id", "source_id"],
  work_rollup: ["day_ms", "session_id", "work_directory_id", "model_id", "account_scope_id", "shape", "ctx_class", "prov"],
});

const OPTIONAL_INDEXES = new Set([
  "usage_event_observed", "usage_event_session", "quota_occurrence_canonical",
  "quota_occurrence_observed", "usage_event_quota", "usage_event_pairing",
  "quota_observation_series", "usage_event_response_identity",
]);
const REQUIRED_INDEXES = new Set(["runtime_model_evidence_response"]);
const KNOWN_INDEXES = new Set([...OPTIONAL_INDEXES, ...REQUIRED_INDEXES]);
const CALCULATION_TABLES = [
  "usage_event", "usage_event_boundary", "quota_occurrence", "quota_observation",
  "tool_class_fact", "work_lifecycle_fact", "lineage_snapshot", "model", "tier_semantics",
  "surface_class", "account_scope", "session", "work_directory",
];
const DIMENSION_TABLES = new Set([
  "model", "tier_semantics", "surface_class", "account_scope", "session", "work_directory",
]);
const KNOWN_TRIGGERS = new Set([
  "usage_rollup_insert", "usage_rollup_delete", "usage_rollup_model_update",
  "usage_rollup_cursor_advance", "usage_rollup_cursor_retreat",
  "work_rollup_insert", "work_rollup_delete", "work_rollup_cursor_advance", "work_rollup_cursor_retreat",
  "cache_pairing_advance", "cache_pairing_retreat", "cache_pairing_delete",
  ...["insert", "update", "delete"].map((operation) => `calculation_source_${operation}`),
  ...["insert", "update", "delete"].map((operation) => `calculation_diagnostic_${operation}`),
  ...CALCULATION_TABLES.flatMap((table) => ["insert", "update", "delete"]
    .filter((operation) => operation !== "insert" || !DIMENSION_TABLES.has(table))
    .map((operation) => `calculation_${table}_${operation}`)),
]);
const REQUIRED_TRIGGERS = new Set(KNOWN_TRIGGERS);

const trustedErrors = new WeakSet();
const retainedResources = new Set();

function fail(category) {
  const error = new Error("Pre-release index conversion refused");
  error.code = `PRE_RELEASE_INDEX_CONVERSION_${category}`;
  trustedErrors.add(error);
  throw error;
}

export function classifyPreReleaseIndexConversionFailure(error) {
  return error && trustedErrors.has(error) ? error.code : "PRE_RELEASE_INDEX_CONVERSION_UNAVAILABLE";
}

function fixed(error, fallback = "UNAVAILABLE") {
  if (error && trustedErrors.has(error)) return error;
  const result = new Error("Pre-release index conversion refused");
  result.code = `PRE_RELEASE_INDEX_CONVERSION_${fallback}`;
  trustedErrors.add(result);
  return result;
}

function contained(parent, child) {
  const relative = win32.relative(parent, child);
  return relative === "" || (!win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"));
}

function localPath(value, file = false) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32767 || value.includes("\0")
      || utilTypes.isProxy(value)) fail("CONFIGURATION_INVALID");
  const normalizedInput = value.replaceAll("/", "\\");
  const components = normalizedInput.slice(3).split("\\").filter(Boolean);
  if (!/^[A-Za-z]:\\/u.test(normalizedInput) || normalizedInput.startsWith("\\\\")
      || normalizedInput.startsWith("\\?\\") || normalizedInput.startsWith("\\.\\")
      || components.some((part) => part === "." || part === ".." || /[<>:"|?*]/u.test(part)
        || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(part))) {
    fail("CONFIGURATION_INVALID");
  }
  const resolved = win32.resolve(normalizedInput);
  if (!/^[A-Za-z]:\\/u.test(resolved) || resolved.length > 32767 || resolved === win32.parse(resolved).root) {
    fail("CONFIGURATION_INVALID");
  }
  if (file && win32.basename(resolved).toLowerCase() !== FILE_NAME) fail("CONFIGURATION_INVALID");
  return resolved;
}

function validateOptions(options) {
  let ownKeys;
  try {
    if (!options || typeof options !== "object" || Array.isArray(options) || utilTypes.isProxy(options)
        || Object.getPrototypeOf(options) !== Object.prototype) fail("CONFIGURATION_INVALID");
    ownKeys = Reflect.ownKeys(options);
    const allowed = new Set(["sourceFile", "destinationRoot", "expectedSourceSha256", "signal"]);
    if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
        || !["sourceFile", "destinationRoot", "expectedSourceSha256"].every((key) => ownKeys.includes(key))) {
      fail("CONFIGURATION_INVALID");
    }
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("CONFIGURATION_INVALID");
    }
  } catch (error) { throw fixed(error, "CONFIGURATION_INVALID"); }

  const sourceFile = localPath(options.sourceFile, true);
  const destinationRoot = localPath(options.destinationRoot);
  const sourceRoot = win32.dirname(sourceFile);
  if (typeof options.expectedSourceSha256 !== "string" || !HASH_PATTERN.test(options.expectedSourceSha256)) {
    fail("CONFIGURATION_INVALID");
  }
  const signal = options.signal;
  if (signal !== undefined && (!(signal instanceof AbortSignal) || utilTypes.isProxy(signal))) {
    fail("CONFIGURATION_INVALID");
  }
  if (contained(sourceRoot, destinationRoot) || contained(destinationRoot, sourceRoot)) fail("ROOT_OVERLAP");
  return Object.freeze({ sourceFile, sourceRoot, destinationRoot,
    expectedSourceSha256: options.expectedSourceSha256, signal: signal ?? undefined });
}

function cancelled(signal) {
  if (signal?.aborted) fail("CANCELLED");
}

function sameIdentity(left, right) {
  return left?.volumeSerialNumber === right?.volumeSerialNumber
    && left?.fileId === right?.fileId && left?.linkCount === right?.linkCount;
}

function sameStat(left, right) {
  return left && right && ["dev", "ino", "nlink", "size", "birthtimeMs", "mtimeMs", "ctimeMs"]
    .every((key) => left[key] === right[key]);
}

function validStat(value) {
  return value && typeof value.dev === "string" && /^[a-f0-9]{16}$/u.test(value.dev)
    && typeof value.ino === "string" && /^[a-f0-9]{32}$/u.test(value.ino)
    && value.nlink === 1 && Number.isSafeInteger(value.size) && value.size >= 0
    && [value.birthtimeMs, value.mtimeMs, value.ctimeMs].every(Number.isFinite);
}

function identityFromStat(stat) {
  return { volumeSerialNumber: stat.dev, fileId: stat.ino, linkCount: stat.nlink };
}

function identitySha256(identity) {
  if (!identity || typeof identity.volumeSerialNumber !== "string"
      || !/^[a-f0-9]{16}$/u.test(identity.volumeSerialNumber)
      || typeof identity.fileId !== "string" || !/^[a-f0-9]{32}$/u.test(identity.fileId)
      || identity.linkCount !== 1) fail("IDENTITY_INVALID");
  return createHash("sha256").update(stableJson({
    volumeSerialNumber: identity.volumeSerialNumber,
    fileId: identity.fileId,
    linkCount: identity.linkCount,
  }), "utf8").digest("hex");
}

function assertProtectedFacts(value, expectedIdentity = null) {
  if (!value || value.isDirectory !== false || value.isRegularFile !== true
      || value.isReparsePoint !== false || value.ownerMatches !== true || value.nullDacl !== false
      || value.daclProtected !== true || value.broadAccess !== false || value.nonOwnerAllow !== false
      || value.unrecognizedAce !== false || value.finalPathResolved !== true
      || value.identity?.linkCount !== 1 || (expectedIdentity && !sameIdentity(value.identity, expectedIdentity))) {
    fail("ACL_INVALID");
  }
  return value.identity;
}

function assertDirectoryGuard(value) {
  if (!value || typeof value !== "object" || !value.guard || !value.identity
      || value.identity.linkCount !== 1
      || typeof value.identity.volumeSerialNumber !== "string"
      || !/^[a-f0-9]{16}$/u.test(value.identity.volumeSerialNumber)
      || typeof value.identity.fileId !== "string"
      || !/^[a-f0-9]{32}$/u.test(value.identity.fileId)) fail("ROOT_INVALID");
  return value;
}

function assertFileBounds(stat, minimum = DB_HEADER_BYTES) {
  if (!validStat(stat) || stat.size < minimum || stat.size > PRE_RELEASE_INDEX_CONVERSION_MAXIMUM_BYTES) {
    fail("SIZE_INVALID");
  }
}

function readBytes(native, lease, offset, size) {
  const bytes = native.readSourceFile(lease, offset, size);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== size) fail("READ_FAILED");
  return bytes;
}

async function hashLease(native, lease, stat, signal) {
  const digest = createHash("sha256");
  for (let offset = 0; offset < stat.size;) {
    cancelled(signal);
    const size = Math.min(HASH_CHUNK_BYTES, stat.size - offset);
    const bytes = readBytes(native, lease, offset, size);
    try { digest.update(bytes); offset += size; } finally { bytes.fill(0); }
    if (offset > 0 && offset % (4 * 1024 * 1024) === 0) await setImmediate();
  }
  cancelled(signal);
  return digest.digest("hex");
}

function sqlitePath(file, readOnly = false) {
  if (!readOnly) return new DatabaseSync(file, { timeout: 5000 });
  return new DatabaseSync(`${pathToFileURL(file).href}?mode=ro&immutable=1`, { readOnly: true, timeout: 5000 });
}

function setReadPragmas(database) {
  database.exec("PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-2048; PRAGMA mmap_size=0;");
  database.enableDefensive?.(true);
}

function scalarPragma(database, pragma) {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  if (!row) fail("DATABASE_UNSUPPORTED");
  return Object.values(row)[0];
}

function assertDbHeader(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== DB_HEADER_BYTES
      || bytes.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
      || bytes[18] !== 2 || bytes[19] !== 2
      || bytes.readUInt32BE(68) !== LOCAL_INDEX_STORE_APPLICATION_ID
      || bytes.readUInt32BE(60) !== SOURCE_VERSION) fail("DATABASE_UNSUPPORTED");
}

function tableColumns(database, table) {
  const count = database.prepare("SELECT COUNT(*) AS count FROM pragma_table_xinfo(?)").get(table)?.count;
  if (!Number.isSafeInteger(count) || count > 256) fail("SCHEMA_UNSUPPORTED");
  return database.prepare(`PRAGMA table_xinfo("${table}")`).all();
}

function schemaRows(database) {
  const bounds = database.prepare(`SELECT COUNT(*) AS objects,
    COALESCE(SUM(length(CAST(sql AS BLOB))),0) AS sql_bytes,
    COALESCE(MAX(length(CAST(name AS BLOB))),0) AS max_name_bytes
    FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'`).get();
  if (!Number.isSafeInteger(bounds?.objects) || bounds.objects > MAX_SCHEMA_OBJECTS
      || !Number.isSafeInteger(bounds.sql_bytes) || bounds.sql_bytes > MAX_SCHEMA_SQL_BYTES
      || !Number.isSafeInteger(bounds.max_name_bytes) || bounds.max_name_bytes > 256) fail("SCHEMA_UNSUPPORTED");
  return database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name")
    .all();
}

function expectedTableColumns(version) {
  return version === TARGET_VERSION ? V9_COLUMNS : V8_COLUMNS;
}

function assertExactSet(actual, expected, optional = new Set()) {
  const values = new Set(actual);
  if ([...values].some((name) => !expected.has(name))
      || [...expected].some((name) => !values.has(name) && !optional.has(name))) fail("SCHEMA_UNSUPPORTED");
}

function assertSchema(database, version) {
  if (scalarPragma(database, "application_id") !== LOCAL_INDEX_STORE_APPLICATION_ID
      || scalarPragma(database, "user_version") !== version
      || database.prepare("SELECT value FROM meta WHERE key='family'").get()?.value !== LOCAL_INDEX_STORE_FAMILY) {
    fail("DATABASE_UNSUPPORTED");
  }
  const expectedTables = expectedTableColumns(version);
  const rows = schemaRows(database);
  const tableRows = rows.filter((row) => row.type === "table");
  if (rows.some((row) => !["table", "index", "trigger"].includes(row.type))) fail("SCHEMA_UNSUPPORTED");
  if (tableRows.length !== Object.keys(expectedTables).length
      || tableRows.some((row) => !Object.hasOwn(expectedTables, row.name))) fail("SCHEMA_UNSUPPORTED");
  const tableList = database.prepare("SELECT name,type,ncol,wr,strict FROM pragma_table_list WHERE schema='main' AND name NOT GLOB 'sqlite_*' ORDER BY name").all();
  if (tableList.length !== Object.keys(expectedTables).length) fail("SCHEMA_UNSUPPORTED");
  for (const [table, definitions] of Object.entries(expectedTables)) {
    const columns = tableColumns(database, table);
    const expected = definitions;
    if (columns.length !== expected.length || columns.some((column, index) =>
      column.name !== expected[index][0] || column.type.toUpperCase() !== expected[index][1]
      || column.hidden !== 0)) fail("SCHEMA_UNSUPPORTED");
    const listed = tableList.find((entry) => entry.name === table);
    if (!listed || listed.type !== "table" || listed.ncol !== expected.length || listed.strict !== 1
        || listed.wr !== (WITHOUT_ROWID.has(table) ? 1 : 0)) fail("SCHEMA_UNSUPPORTED");
  }

  const indexNames = rows.filter((row) => row.type === "index").map((row) => row.name);
  assertExactSet(indexNames, new Set([...KNOWN_INDEXES]), new Set([...OPTIONAL_INDEXES]));
  for (const name of REQUIRED_INDEXES) if (!indexNames.includes(name)) fail("SCHEMA_UNSUPPORTED");
  const triggers = rows.filter((row) => row.type === "trigger").map((row) => row.name);
  assertExactSet(triggers, KNOWN_TRIGGERS);
  for (const name of REQUIRED_TRIGGERS) if (!triggers.includes(name)) fail("SCHEMA_UNSUPPORTED");
  if (version === SOURCE_VERSION
      && rows.some((row) => row.type === "trigger" && row.name.startsWith("calculation_source_")
        && row.sql?.includes("carry_tier_source"))) fail("SCHEMA_UNSUPPORTED");

  if (!PRE_RELEASE_INDEX_SCHEMA_ALLOWLIST_READY) fail("SCHEMA_ALLOWLIST_PENDING");
  const allowedSqlHashes = version === SOURCE_VERSION
    ? PRE_RELEASE_INDEX_V8_OBJECT_SQL_SHA256
    : PRE_RELEASE_INDEX_V9_MIGRATED_OBJECT_SQL_SHA256;
  const allowedTableNames = version === SOURCE_VERSION
    ? PRE_RELEASE_INDEX_V8_OBJECT_TABLE_NAMES
    : PRE_RELEASE_INDEX_V9_MIGRATED_OBJECT_TABLE_NAMES;
  for (const row of rows) {
    const key = `${row.type}:${row.name}`;
    const expectedHash = allowedSqlHashes[key];
    const actualHash = createHash("sha256").update(row.sql ?? "").digest("hex");
    if (typeof expectedHash !== "string" || !HASH_PATTERN.test(expectedHash)
        || allowedTableNames[key] !== row.tbl_name
        || (actualHash !== expectedHash && !(key === 'table:store_state'
          && actualHash === PRE_RELEASE_INDEX_ALTERED_STORE_STATE_SQL_SHA256))) {
      fail("SCHEMA_UNSUPPORTED");
    }
  }
  for (const name of REQUIRED_INDEXES) {
    if (!HASH_PATTERN.test(allowedSqlHashes[`index:${name}`] ?? "")) fail("SCHEMA_ALLOWLIST_PENDING");
  }
  for (const name of REQUIRED_TRIGGERS) {
    if (!HASH_PATTERN.test(allowedSqlHashes[`trigger:${name}`] ?? "")) fail("SCHEMA_ALLOWLIST_PENDING");
  }
  for (const table of Object.keys(expectedTables)) {
    if (!HASH_PATTERN.test(allowedSqlHashes[`table:${table}`] ?? "")) fail("SCHEMA_ALLOWLIST_PENDING");
  }

  if (database.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") fail("INTEGRITY_FAILED");
  if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) fail("FOREIGN_KEY_FAILED");
  return createHash("sha256").update(stableJson({
    applicationId: LOCAL_INDEX_STORE_APPLICATION_ID,
    family: LOCAL_INDEX_STORE_FAMILY,
    objects: rows.map(({ type, name, tbl_name, sql }) => [type, name, tbl_name, sql]),
    userVersion: version,
  })).digest("hex");
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function inspectTableBounds(database, table, definitions) {
  const columns = definitions.map(([name]) => name);
  const maxima = columns.map((name, index) =>
    `MAX(COALESCE(length(CAST(${quoteIdentifier(name)} AS BLOB)),0)) AS c${index}`);
  const rowBytes = `MAX(${columns.map((name) => `COALESCE(length(CAST(${quoteIdentifier(name)} AS BLOB)),0)`).join("+")}) AS row_bytes`;
  const result = database.prepare(`SELECT COUNT(*) AS rows,${[...maxima, rowBytes].join(",")} FROM ${quoteIdentifier(table)}`).get();
  if (!Number.isSafeInteger(result?.rows) || result.rows < 0 || result.rows > MAX_LOGICAL_ROWS) fail("ROW_LIMIT");
  for (let index = 0; index < columns.length; index += 1) {
    const length = result[`c${index}`] ?? 0;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CELL_BYTES) fail("CELL_TOO_LARGE");
  }
  const rowBytesMax = result.row_bytes ?? 0;
  if (!Number.isSafeInteger(rowBytesMax) || rowBytesMax < 0 || rowBytesMax > MAX_ROW_BYTES) fail("CELL_TOO_LARGE");
  return result.rows;
}

function frame(hash, tag, bytes) {
  const header = Buffer.allocUnsafe(9);
  header[0] = tag;
  header.writeBigUInt64BE(BigInt(bytes.byteLength), 1);
  hash.update(header);
  hash.update(bytes);
}

function valueBytes(type, value, declaredType) {
  if (type === "null") {
    if (value !== null) fail("DATABASE_INVALID");
    return [0, Buffer.alloc(0)];
  }
  if (type !== declaredType.toLowerCase()) fail("DATABASE_INVALID");
  if (type === "integer") {
    if (typeof value !== "bigint" || value < -(1n << 63n) || value >= (1n << 63n)) fail("DATABASE_INVALID");
    const bytes = Buffer.allocUnsafe(8); bytes.writeBigInt64BE(value); return [1, bytes];
  }
  if (type === "real") {
    if (typeof value !== "number" || !Number.isFinite(value)) fail("DATABASE_INVALID");
    const bytes = Buffer.allocUnsafe(8); bytes.writeDoubleBE(value); return [2, bytes];
  }
  if (type === "text") {
    if (typeof value !== "string" || !/^(?:[0-9A-F]{2})*$/u.test(value)) fail("DATABASE_INVALID");
    return [3, Buffer.from(value, "hex")];
  }
  if (type === "blob") {
    if (!(value instanceof Uint8Array)) fail("DATABASE_INVALID");
    return [4, Buffer.from(value)];
  }
  fail("DATABASE_INVALID");
}

async function logicalSnapshot(database, columnsByTable, signal) {
  let totalRows = 0;
  let totalHashedBytes = 0;
  const tables = [];
  for (const [table, definitions] of Object.entries(columnsByTable)) {
    cancelled(signal);
    const rowCount = inspectTableBounds(database, table, definitions);
    totalRows += rowCount;
    if (!Number.isSafeInteger(totalRows) || totalRows > MAX_LOGICAL_ROWS) fail("ROW_LIMIT");
    const selection = definitions.flatMap(([name, type], index) => {
      const column = quoteIdentifier(name);
      return [
        `typeof(${column}) AS ${quoteIdentifier(`t${index}`)}`,
        type === "TEXT"
          ? `CASE WHEN ${column} IS NULL THEN NULL ELSE hex(CAST(${column} AS BLOB)) END AS ${quoteIdentifier(`v${index}`)}`
          : `${column} AS ${quoteIdentifier(`v${index}`)}`,
      ];
    }).join(",");
    const order = (PRIMARY_KEYS[table] ?? []).map(quoteIdentifier).join(",");
    if (!order) fail("SCHEMA_UNSUPPORTED");
    const statement = database.prepare(`SELECT ${selection} FROM ${quoteIdentifier(table)} ORDER BY ${order}`);
    statement.setReadBigInts(true);
    const digest = createHash("sha256");
    digest.update(Buffer.from(stableJson([table, definitions]), "utf8"));
    let count = 0;
    for (const row of statement.iterate()) {
      cancelled(signal);
      for (let index = 0; index < definitions.length; index += 1) {
        const [tag, bytes] = valueBytes(row[`t${index}`], row[`v${index}`], definitions[index][1]);
        totalHashedBytes += bytes.byteLength + 9;
        if (!Number.isSafeInteger(totalHashedBytes) || totalHashedBytes > MAX_LOGICAL_BYTES) fail("ROW_LIMIT");
        frame(digest, tag, bytes);
      }
      digest.update(Buffer.from([255]));
      totalHashedBytes += 1;
      if (!Number.isSafeInteger(totalHashedBytes) || totalHashedBytes > MAX_LOGICAL_BYTES) fail("ROW_LIMIT");
      count += 1;
      if (count % 4096 === 0) await setImmediate();
    }
    if (count !== rowCount || !Number.isSafeInteger(count)) fail("DATABASE_CHANGED");
    tables.push(Object.freeze({ table, rows: count, sha256: digest.digest("hex") }));
  }
  return Object.freeze({
    rows: totalRows,
    tables: Object.freeze(tables),
    sha256: createHash("sha256").update(stableJson(tables)).digest("hex"),
  });
}

function assertSnapshotsEqual(before, after) {
  if (before.rows !== after.rows || before.tables.length !== after.tables.length) fail("LOGICAL_DATA_CHANGED");
  for (let index = 0; index < before.tables.length; index += 1) {
    const left = before.tables[index], right = after.tables[index];
    if (left.table !== right.table || left.rows !== right.rows || left.sha256 !== right.sha256) {
      fail("LOGICAL_DATA_CHANGED");
    }
  }
}

function assertCarrySourceNull(database) {
  const value = database.prepare("SELECT COUNT(*) AS count FROM source WHERE carry_tier_source IS NOT NULL").get()?.count;
  if (value !== 0) fail("CARRY_TIER_SOURCE_NOT_NULL");
}

function nativeMissing(error) {
  return error?.code === "ENOENT" || error?.code === "WINDOWS_FILESYSTEM_NOT_FOUND";
}

function statFrozen(native, lease) {
  const stat = native.statSourceFile(lease);
  if (!validStat(stat)) fail("IDENTITY_INVALID");
  return stat;
}

function openFrozen(native, path, leases) {
  const lease = native.openLegacyStateFile(path);
  leases.push(lease);
  return { lease, stat: statFrozen(native, lease), path };
}

function acquireProtectedSourceChild(native, root, rootGuard, leaf, expectedIdentity, childGuards) {
  let guard;
  try { guard = native.acquireProtectedChildGuard(root, rootGuard.identity, leaf); }
  catch { fail("ACL_INVALID"); }
  if (guard?.guard) childGuards.push(guard.guard);
  if (!guard || !guard.guard || !sameIdentity(guard.identity, expectedIdentity)) fail("IDENTITY_CHANGED");
  return guard.identity;
}

function inspectSidecars(native, root, rootGuard, leases, childGuards = null) {
  const found = new Map();
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const name = `${FILE_NAME}${suffix}`;
    const path = win32.join(root, name);
    let entry;
    try { entry = openFrozen(native, path, leases); }
    catch (error) {
      if (nativeMissing(error)) { found.set(name, null); continue; }
      throw error;
    }
    let inspected;
    try { inspected = native.inspectProtectedChild(root, rootGuard.identity, name); }
    catch { fail("ACL_INVALID"); }
    assertProtectedFacts(inspected, identityFromStat(entry.stat));
    if (childGuards) acquireProtectedSourceChild(native, root, rootGuard, name,
      identityFromStat(entry.stat), childGuards);
    if (entry.stat.size > PRE_RELEASE_INDEX_CONVERSION_MAXIMUM_BYTES) fail("SIZE_INVALID");
    if ((suffix === "-wal" || suffix === "-shm") && entry.stat.size > 0) fail("DATABASE_NOT_COLD");
    if (suffix === "-journal" && entry.stat.size > 0) {
      if (entry.stat.size < ROLLBACK_JOURNAL_HEADER_BYTES) fail("DATABASE_NOT_COLD");
      const header = readBytes(native, entry.lease, 0, ROLLBACK_JOURNAL_HEADER_BYTES);
      try { if (header.some((byte) => byte !== 0)) fail("DATABASE_NOT_COLD"); }
      finally { header.fill(0); }
    }
    found.set(name, entry);
  }
  return found;
}

function compareSidecarState(before, after) {
  for (const [name, left] of before) {
    const right = after.get(name);
    if (left === null ? right !== null : !right || !sameStat(left.stat, right.stat)) fail("SOURCE_CHANGED");
  }
}

function sameRootIdentity(left, right) {
  return sameIdentity(left, right);
}

function assertDestinationEmpty(names) {
  if (names.length !== 0) fail("DESTINATION_NOT_EMPTY");
}

function verifyProtectedChild(native, root, rootIdentity, leaf, expected = null) {
  let facts;
  try { facts = native.inspectProtectedChild(root, rootIdentity, leaf); }
  catch { fail("TARGET_INVALID"); }
  const identity = assertProtectedFacts(facts, expected);
  return identity;
}

function createProtectedEmptySidecar(native, root, rootIdentity, leaf) {
  const path = win32.join(root, leaf);
  let identity;
  try { identity = native.createFile(path, Buffer.alloc(0)); }
  catch { fail("DESTINATION_EXISTS"); }
  verifyProtectedChild(native, root, rootIdentity, leaf, identity);
  return Object.freeze({ leaf, path, identity });
}

function closeDatabase(database) {
  if (!database) return true;
  try { database.close(); return database.isOpen === false; } catch { return false; }
}

function releaseDirectory(native, entry) {
  if (entry?.guard) native.releaseProtectedDirectoryGuard(entry.guard);
}

function releaseSourceLeases(native, leases) {
  let failed = false;
  for (let index = leases.length - 1; index >= 0; index -= 1) {
    try { native.closeSourceFile(leases[index]); } catch { failed = true; }
  }
  return !failed;
}

function releaseProtectedSourceChildren(native, guards) {
  let failed = false;
  for (let index = guards.length - 1; index >= 0; index -= 1) {
    try { native.releaseCredentialAuditFileGuard(guards[index]); } catch { failed = true; }
  }
  return !failed;
}

function inspectTargetSidecar(native, destinationRoot, rootIdentity, path, expectedIdentity, leases) {
  const leaf = win32.basename(path);
  let lease;
  try { lease = native.openLegacyStateFile(path); }
  catch (error) { if (nativeMissing(error)) return null; fail("SIDECAR_INVALID"); }
  leases.push(lease);
  let stat;
  try {
    stat = statFrozen(native, lease);
    const facts = native.inspectProtectedChild(destinationRoot, rootIdentity, leaf);
    assertProtectedFacts(facts, expectedIdentity);
  } finally {
    try {
      native.closeSourceFile(lease);
      const index = leases.lastIndexOf(lease);
      if (index >= 0) leases.splice(index, 1);
    } catch { fail("CLOSE_FAILED"); }
  }
  return stat;
}

function cleanupOwnedTargetSidecar(native, destinationRoot, rootIdentity, entry, leases) {
  const current = inspectTargetSidecar(native, destinationRoot, rootIdentity, entry.path, entry.identity, leases);
  if (!current) return;
  if (current.size !== 0) fail("TARGET_NOT_COLD");
  try { native.deleteFile(entry.path, entry.identity); } catch { fail("SIDECAR_CLEANUP_FAILED"); }
}

async function verifyTargetRootAfterConversion(native, destinationRoot, destinationGuard, sqlitePathName,
  mainIdentity, journalIdentity, createdSidecars, leases) {
  for (const sidecar of createdSidecars) {
    cleanupOwnedTargetSidecar(native, destinationRoot, destinationGuard.identity, sidecar, leases);
  }
  const names = await readdir(destinationRoot);
  const expected = [`${sqlitePathName}`, `${sqlitePathName}-journal`].sort();
  if (names.map((name) => name.toLowerCase()).sort().join("\0") !== expected.map((name) => name.toLowerCase()).join("\0")) {
    fail("TARGET_NOT_COLD");
  }
  const main = verifyProtectedChild(native, destinationRoot, destinationGuard.identity, sqlitePathName, mainIdentity);
  const journal = verifyProtectedChild(native, destinationRoot, destinationGuard.identity, `${sqlitePathName}-journal`, journalIdentity);
  const journalLease = native.openLegacyStateFile(win32.join(destinationRoot, `${sqlitePathName}-journal`));
  leases.push(journalLease);
  try { if (statFrozen(native, journalLease).size !== 0) fail("TARGET_NOT_COLD"); }
  finally {
    try {
      native.closeSourceFile(journalLease);
      const index = leases.lastIndexOf(journalLease);
      if (index >= 0) leases.splice(index, 1);
    } catch { fail("CLOSE_FAILED"); }
  }
  return { main, journal };
}

/** One-time v8 copy conversion. The caller supplies a protected empty root. */
export async function convertPreReleaseIndexCopy(options) {
  // The v8 -> v9 copy tool is historical. It must refuse before touching a
  // path once the store's current target is no longer v9.
  if (LOCAL_INDEX_STORE_USER_VERSION !== TARGET_VERSION) fail("TARGET_VERSION_UNSUPPORTED");
  const input = validateOptions(options);
  cancelled(input.signal);
  if (process.platform !== "win32" || process.arch !== "x64") fail("UNSUPPORTED_PLATFORM");
  if (retainedResources.size > 0) fail("CLOSE_FAILED");

  let native;
  let volumeNative;
  try {
    volumeNative = loadWindowsLocalVolumeQueryBinding();
    native = loadWindowsLegacyStateReadBinding();
  } catch { fail("NATIVE_UNAVAILABLE"); }
  if (native !== volumeNative || typeof volumeNative?.isFixedLocalVolume !== "function") fail("NATIVE_UNAVAILABLE");
  try {
    if (volumeNative.isFixedLocalVolume(input.sourceFile) !== true
        || volumeNative.isFixedLocalVolume(input.destinationRoot) !== true) fail("VOLUME_UNSUPPORTED");
  } catch (error) {
    throw fixed(error, "VOLUME_UNSUPPORTED");
  }
  const leases = [];
  const sourceChildGuards = [];
  const ownedSidecars = [];
  let sourceLegacyGuard;
  let sourceProtectedGuard;
  let destinationGuard;
  let source;
  let targetMainIdentity;
  let targetJournalIdentity;
  let sourceDatabase;
  let targetDatabase;
  let sqliteFileGuards;
  let sourceCloseFailed = false;
  let targetCloseFailed = false;
  let sqliteGuardReleaseFailed = false;
  let sourceStartStat;
  let sourceSidecars;
  let targetPath;
  let sourceLogical;
  let targetLogical;
  let sourceSchemaFingerprint;
  let targetSchemaFingerprint;
  let copiedSchemaFingerprint;
  let targetSha256;
  let complete = false;

  try {
    try { sourceLegacyGuard = native.acquireLegacyStateDirectoryGuard(input.sourceRoot); }
    catch { fail("ROOT_INVALID"); }
    try { sourceProtectedGuard = native.acquireProtectedDirectoryGuard(input.sourceRoot); }
    catch { fail("ROOT_INVALID"); }
    try { destinationGuard = native.acquireProtectedDirectoryGuard(input.destinationRoot); }
    catch { fail("ROOT_INVALID"); }
    assertDirectoryGuard(sourceLegacyGuard);
    assertDirectoryGuard(sourceProtectedGuard);
    assertDirectoryGuard(destinationGuard);
    if (!sameRootIdentity(sourceLegacyGuard.identity, sourceProtectedGuard.identity)) fail("ROOT_CHANGED");
    if (native.legacyStateRootsDisjoint(sourceLegacyGuard.guard, destinationGuard.guard) !== true) fail("ROOT_OVERLAP");
    assertDestinationEmpty(await readdir(input.destinationRoot));

    source = openFrozen(native, input.sourceFile, leases);
    assertFileBounds(source.stat);
    let sourceFacts;
    try { sourceFacts = native.inspectProtectedChild(input.sourceRoot, sourceProtectedGuard.identity, FILE_NAME); }
    catch { fail("ACL_INVALID"); }
    assertProtectedFacts(sourceFacts, identityFromStat(source.stat));
    acquireProtectedSourceChild(native, input.sourceRoot, sourceProtectedGuard, FILE_NAME,
      identityFromStat(source.stat), sourceChildGuards);
    sourceStartStat = source.stat;

    const header = readBytes(native, source.lease, 0, DB_HEADER_BYTES);
    try { assertDbHeader(header); } finally { header.fill(0); }
    const sourceSha = await hashLease(native, source.lease, source.stat, input.signal);
    if (sourceSha !== input.expectedSourceSha256) fail("SOURCE_HASH_MISMATCH");

    sourceSidecars = inspectSidecars(native, input.sourceRoot, sourceProtectedGuard, leases, sourceChildGuards);
    try {
      sourceDatabase = sqlitePath(input.sourceFile, true);
      setReadPragmas(sourceDatabase);
      sourceSchemaFingerprint = assertSchema(sourceDatabase, SOURCE_VERSION);
      sourceLogical = await logicalSnapshot(sourceDatabase, V8_COLUMNS, input.signal);
    } catch (error) {
      throw fixed(error, "DATABASE_UNSUPPORTED");
    } finally {
      if (sourceDatabase) {
        if (!closeDatabase(sourceDatabase)) {
          sourceCloseFailed = true;
          fail("CLOSE_FAILED");
        }
        sourceDatabase = null;
      }
    }
    cancelled(input.signal);
    if (!sameStat(sourceStartStat, statFrozen(native, source.lease))) fail("SOURCE_CHANGED");
    compareSidecarState(sourceSidecars, inspectSidecars(native, input.sourceRoot, sourceProtectedGuard, leases));
    if (await hashLease(native, source.lease, source.stat, input.signal) !== input.expectedSourceSha256) fail("SOURCE_CHANGED");

    const copied = native.copyLegacyStateFile(source.lease, input.destinationRoot,
      destinationGuard.identity, FILE_NAME);
    targetMainIdentity = copied;
    if (!targetMainIdentity || targetMainIdentity.linkCount !== 1) fail("TARGET_INVALID");
    targetPath = win32.join(input.destinationRoot, FILE_NAME);
    verifyProtectedChild(native, input.destinationRoot, destinationGuard.identity, FILE_NAME, targetMainIdentity);

    const copiedLease = openFrozen(native, targetPath, leases);
    if (copiedLease.stat.size !== sourceStartStat.size
        || !sameIdentity(targetMainIdentity, identityFromStat(copiedLease.stat))
        || await hashLease(native, copiedLease.lease, copiedLease.stat, input.signal) !== input.expectedSourceSha256) {
      fail("COPY_MISMATCH");
    }
    const copiedHeader = readBytes(native, copiedLease.lease, 0, DB_HEADER_BYTES);
    try { assertDbHeader(copiedHeader); } finally { copiedHeader.fill(0); }
    try {
      native.closeSourceFile(copiedLease.lease);
      leases.splice(leases.lastIndexOf(copiedLease.lease), 1);
    } catch { fail("CLOSE_FAILED"); }

    sqliteFileGuards = acquireProtectedSqliteFiles({ native, path: targetPath, pathApi: win32 });
    if (!sqliteFileGuards || typeof sqliteFileGuards.release !== "function") fail("NATIVE_UNAVAILABLE");
    targetMainIdentity = verifyProtectedChild(native, input.destinationRoot, destinationGuard.identity,
      FILE_NAME, targetMainIdentity);
    targetJournalIdentity = verifyProtectedChild(native, input.destinationRoot, destinationGuard.identity,
      `${FILE_NAME}-journal`);

    const wal = createProtectedEmptySidecar(native, input.destinationRoot, destinationGuard.identity, `${FILE_NAME}-wal`);
    const shm = createProtectedEmptySidecar(native, input.destinationRoot, destinationGuard.identity, `${FILE_NAME}-shm`);
    ownedSidecars.push(wal, shm);
    const sidecarSet = [FILE_NAME, `${FILE_NAME}-journal`, `${FILE_NAME}-wal`, `${FILE_NAME}-shm`].sort();
    if ((await readdir(input.destinationRoot)).map((name) => name.toLowerCase()).sort().join("\0")
      !== sidecarSet.map((name) => name.toLowerCase()).join("\0")) fail("TARGET_NOT_COLD");

    targetDatabase = sqlitePath(targetPath);
    try { configureGuardedSqliteConnection(targetDatabase); } catch { fail("JOURNAL_MODE_REFUSED"); }
    if (String(scalarPragma(targetDatabase, "journal_mode")).toLowerCase() !== "persist") fail("JOURNAL_MODE_REFUSED");
    targetDatabase.exec("PRAGMA synchronous=FULL; PRAGMA journal_size_limit=0;");
    setReadPragmas(targetDatabase);
    copiedSchemaFingerprint = assertSchema(targetDatabase, SOURCE_VERSION);
    if (copiedSchemaFingerprint !== sourceSchemaFingerprint) fail("SCHEMA_UNSUPPORTED");
    const targetBefore = await logicalSnapshot(targetDatabase, V8_COLUMNS, input.signal);
    assertSnapshotsEqual(sourceLogical, targetBefore);

    upgradeLocalIndexV8ToV9(targetDatabase);
    if (String(scalarPragma(targetDatabase, "journal_mode")).toLowerCase() !== "persist") fail("JOURNAL_MODE_REFUSED");
    targetSchemaFingerprint = assertSchema(targetDatabase, TARGET_VERSION);
    assertCarrySourceNull(targetDatabase);
    targetLogical = await logicalSnapshot(targetDatabase, V8_COLUMNS, input.signal);
    assertSnapshotsEqual(sourceLogical, targetLogical);

    if (!closeDatabase(targetDatabase)) {
      targetCloseFailed = true;
      fail("CLOSE_FAILED");
    }
    targetDatabase = null;

    try {
      sqliteFileGuards.release();
      sqliteFileGuards = null;
    } catch {
      sqliteGuardReleaseFailed = true;
      fail("CLOSE_FAILED");
    }

    const targetLease = openFrozen(native, targetPath, leases);
    if (!sameIdentity(targetMainIdentity, identityFromStat(targetLease.stat))) fail("IDENTITY_CHANGED");
    const finalHeader = readBytes(native, targetLease.lease, 0, DB_HEADER_BYTES);
    try {
      if (finalHeader.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
          || finalHeader[18] !== 1 || finalHeader[19] !== 1
          || finalHeader.readUInt32BE(68) !== LOCAL_INDEX_STORE_APPLICATION_ID
          || finalHeader.readUInt32BE(60) !== TARGET_VERSION) fail("DATABASE_UNSUPPORTED");
    } finally { finalHeader.fill(0); }

    // SQLite may remove WAL/SHM during the PERSIST transition or leave an
    // empty file. Remove only empty files this operation created and only while
    // their original native identities match.
    const targetRootState = await verifyTargetRootAfterConversion(native, input.destinationRoot,
      destinationGuard, FILE_NAME, targetMainIdentity, targetJournalIdentity, ownedSidecars, leases);

    let persistedSnapshot;
    targetDatabase = sqlitePath(targetPath, true);
    try {
      setReadPragmas(targetDatabase);
      const persistedSchemaFingerprint = assertSchema(targetDatabase, TARGET_VERSION);
      if (persistedSchemaFingerprint !== targetSchemaFingerprint) fail("SCHEMA_UNSUPPORTED");
      assertCarrySourceNull(targetDatabase);
      persistedSnapshot = await logicalSnapshot(targetDatabase, V8_COLUMNS, input.signal);
    } finally {
      if (!closeDatabase(targetDatabase)) {
        targetCloseFailed = true;
        fail("CLOSE_FAILED");
      }
      targetDatabase = null;
    }
    assertSnapshotsEqual(sourceLogical, persistedSnapshot);

    assertFileBounds(targetLease.stat);
    targetSha256 = await hashLease(native, targetLease.lease, targetLease.stat, input.signal);
    verifyProtectedChild(native, input.destinationRoot, destinationGuard.identity, FILE_NAME, targetMainIdentity);
    verifyProtectedChild(native, input.destinationRoot, destinationGuard.identity, `${FILE_NAME}-journal`, targetRootState.journal);
    await verifyTargetRootAfterConversion(native, input.destinationRoot, destinationGuard,
      FILE_NAME, targetMainIdentity, targetJournalIdentity, ownedSidecars, leases);
    if (!sameStat(sourceStartStat, statFrozen(native, source.lease))) fail("SOURCE_CHANGED");
    if (await hashLease(native, source.lease, sourceStartStat, input.signal) !== input.expectedSourceSha256) fail("SOURCE_CHANGED");
    compareSidecarState(sourceSidecars, inspectSidecars(native, input.sourceRoot, sourceProtectedGuard, leases));
    complete = true;
  } catch (error) {
    if (sourceDatabase && !sourceCloseFailed) {
      if (closeDatabase(sourceDatabase)) sourceDatabase = null;
      else sourceCloseFailed = true;
    }
    if (targetDatabase && !targetCloseFailed) {
      if (closeDatabase(targetDatabase)) targetDatabase = null;
      else targetCloseFailed = true;
    }
    throw fixed(error);
  } finally {
    if (sourceCloseFailed || targetCloseFailed || sqliteGuardReleaseFailed) {
      retainedResources.add({ native, leases, sourceLegacyGuard, sourceProtectedGuard, destinationGuard,
        sqliteFileGuards, sourceDatabase, targetDatabase, sourceChildGuards, ownedSidecars });
    } else {
      let releaseFailed = false;
      if (sqliteFileGuards) {
        try { sqliteFileGuards.release(); } catch { releaseFailed = true; }
      }
      if (!releaseFailed && !releaseProtectedSourceChildren(native, sourceChildGuards)) releaseFailed = true;
      if (!releaseFailed && !releaseSourceLeases(native, leases)) releaseFailed = true;
      if (!releaseFailed) {
        for (const guard of [destinationGuard, sourceProtectedGuard, sourceLegacyGuard]) {
          try { releaseDirectory(native, guard); } catch { releaseFailed = true; }
        }
      }
      if (releaseFailed) {
        retainedResources.add({ native, leases, sourceLegacyGuard, sourceProtectedGuard, destinationGuard,
          sqliteFileGuards, sourceChildGuards, ownedSidecars });
        fail("CLOSE_FAILED");
      }
    }
  }

  if (!complete || !sourceLogical || !targetLogical) fail("UNAVAILABLE");
  return Object.freeze({
    code: PRE_RELEASE_INDEX_CONVERSION_REPORT_CODE,
    sourceVersion: SOURCE_VERSION,
    targetVersion: TARGET_VERSION,
    sourceSha256: input.expectedSourceSha256,
    targetSha256: targetSha256,
    sourceSchemaSha256: sourceSchemaFingerprint,
    targetSchemaSha256: targetSchemaFingerprint,
    sourceRootIdentitySha256: identitySha256(sourceProtectedGuard.identity),
    sourceFileIdentitySha256: identitySha256(identityFromStat(sourceStartStat)),
    destinationRootIdentitySha256: identitySha256(destinationGuard.identity),
    targetFileIdentitySha256: identitySha256(targetMainIdentity),
    sourceRows: sourceLogical.rows,
    targetRows: targetLogical.rows,
    sourceLogicalSha256: sourceLogical.sha256,
    targetLogicalSha256: targetLogical.sha256,
    tableRows: Object.freeze(sourceLogical.tables.map(({ table, rows }) => Object.freeze({ table, rows }))),
  });
}
