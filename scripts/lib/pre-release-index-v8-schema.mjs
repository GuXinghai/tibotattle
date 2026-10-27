import { createHash } from "node:crypto";
import canonical from "./pre-release-index-v8-schema.json" with { type: "json" };

const SHA256 = /^[a-f0-9]{64}$/u;
const EXPECTED_REVISION = "63e8753a27a0da0c67d8ddd3226df4dd855ad055";
const EXPECTED_WRITER = "src/local-index-store.js";
const ALLOWED_MIGRATION_SQL_DELTAS = new Set([
  "table:source",
  "trigger:calculation_source_update",
]);

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected) {
  return plainRecord(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function freezeSchemaRows(rows) {
  if (!Array.isArray(rows) || rows.length !== 85) throw new TypeError("schema row count");
  const hashes = Object.create(null);
  const tableNames = Object.create(null);
  const frozen = [];
  let totalSqlBytes = 0;
  for (const row of rows) {
    if (!exactKeys(row, ["type", "name", "tbl_name", "sql", "sqlSha256"])
        || !["table", "index", "trigger"].includes(row.type)
        || typeof row.name !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(row.name)
        || typeof row.tbl_name !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(row.tbl_name)
        || typeof row.sql !== "string" || !SHA256.test(row.sqlSha256)) {
      throw new TypeError("schema object shape");
    }
    totalSqlBytes += Buffer.byteLength(row.sql, "utf8");
    if (totalSqlBytes > 1024 * 1024) throw new TypeError("schema text bounds");
    const actualHash = createHash("sha256").update(row.sql, "utf8").digest("hex");
    if (actualHash !== row.sqlSha256) throw new TypeError("schema hash mismatch");
    const key = `${row.type}:${row.name}`;
    if (Object.hasOwn(hashes, key)) throw new TypeError("duplicate schema object");
    hashes[key] = row.sqlSha256;
    tableNames[key] = row.tbl_name;
    frozen.push(Object.freeze({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql }));
  }
  const counts = { table: 0, index: 0, trigger: 0 };
  for (const row of frozen) counts[row.type] += 1;
  if (counts.table !== 25 || counts.index !== 9 || counts.trigger !== 51) {
    throw new TypeError("schema object classes");
  }
  return { rows: Object.freeze(frozen), hashes: Object.freeze(hashes), tableNames: Object.freeze(tableNames) };
}

function freezeSeeds(seeds) {
  if (!exactKeys(seeds, ["meta", "store_state", "rollup_context_start"])) throw new TypeError("seed tables");
  const expectedRows = { meta: 3, store_state: 1, rollup_context_start: 4 };
  const output = Object.create(null);
  for (const [table, rows] of Object.entries(seeds)) {
    if (!Array.isArray(rows) || rows.length !== expectedRows[table]) throw new TypeError("seed rows");
    for (const row of rows) {
      if (!plainRecord(row) || Object.values(row).some((value) =>
        value !== null && !["string", "number", "boolean"].includes(typeof value))) {
        throw new TypeError("seed value type");
      }
      const expectedColumns = table === "meta" ? ["key", "value"]
        : table === "store_state" ? ["id", "commit_seq", "calculation_revision"]
          : ["start_tokens"];
      if (Object.keys(row).sort().join("\0") !== expectedColumns.sort().join("\0")) {
        throw new TypeError("seed columns");
      }
      Object.freeze(row);
    }
    output[table] = Object.freeze([...rows]);
  }
  return Object.freeze(output);
}

function buildCatalog(value) {
  if (!exactKeys(value, ["sourceRevision", "writer", "schemaVersion", "schema", "targetVersion", "targetSchema", "seeds"])
      || value.sourceRevision !== EXPECTED_REVISION || value.writer !== EXPECTED_WRITER
      || value.schemaVersion !== 8 || value.targetVersion !== 9) throw new TypeError("schema provenance");
  const source = freezeSchemaRows(value.schema);
  const target = freezeSchemaRows(value.targetSchema);
  const sourceKeys = Object.keys(source.hashes).sort();
  const targetKeys = Object.keys(target.hashes).sort();
  if (sourceKeys.join("\0") !== targetKeys.join("\0")) throw new TypeError("migration object set");
  for (const key of sourceKeys) {
    const sourceRow = source.rows.find((row) => `${row.type}:${row.name}` === key);
    const targetRow = target.rows.find((row) => `${row.type}:${row.name}` === key);
    if (source.tableNames[key] !== target.tableNames[key]
        || sourceRow.tbl_name !== targetRow.tbl_name
        || (!ALLOWED_MIGRATION_SQL_DELTAS.has(key) && source.hashes[key] !== target.hashes[key])) {
      throw new TypeError("unapproved migration SQL delta");
    }
  }
  const seeds = freezeSeeds(value.seeds);
  return Object.freeze({ source, target, seeds });
}

let catalog = null;
try { catalog = buildCatalog(canonical); } catch { /* Refuse conversion until the canonical catalog validates. */ }

export const PRE_RELEASE_INDEX_SCHEMA_ALLOWLIST_READY = catalog !== null;
export const PRE_RELEASE_INDEX_V8_OBJECT_SQL_SHA256 = catalog?.source.hashes ?? Object.freeze({});
export const PRE_RELEASE_INDEX_V9_MIGRATED_OBJECT_SQL_SHA256 = catalog?.target.hashes ?? Object.freeze({});
// The existing v6→v7 ALTER TABLE path appends this column with a space,
// whereas a newly created store uses a newline. Admit that exact historical
// SQL spelling only; do not normalize arbitrary input or constraints.
export const PRE_RELEASE_INDEX_ALTERED_STORE_STATE_SQL = `CREATE TABLE store_state(
    id INTEGER PRIMARY KEY CHECK(id = 1),
    commit_seq INTEGER NOT NULL, calculation_revision INTEGER NOT NULL DEFAULT 0 CHECK(calculation_revision >= 0)) STRICT`;
export const PRE_RELEASE_INDEX_ALTERED_STORE_STATE_SQL_SHA256 = createHash('sha256')
  .update(PRE_RELEASE_INDEX_ALTERED_STORE_STATE_SQL).digest('hex');
export const PRE_RELEASE_INDEX_V8_OBJECT_TABLE_NAMES = catalog?.source.tableNames ?? Object.freeze({});
export const PRE_RELEASE_INDEX_V9_MIGRATED_OBJECT_TABLE_NAMES = catalog?.target.tableNames ?? Object.freeze({});
export const PRE_RELEASE_INDEX_V8_SCHEMA_OBJECTS = catalog?.source.rows ?? Object.freeze([]);
export const PRE_RELEASE_INDEX_V9_SCHEMA_OBJECTS = catalog?.target.rows ?? Object.freeze([]);
export const PRE_RELEASE_INDEX_V8_TEST_SEEDS = catalog?.seeds ?? Object.freeze({});
export const PRE_RELEASE_INDEX_SCHEMA_PROVENANCE = Object.freeze({
  sourceRevision: EXPECTED_REVISION,
  writer: EXPECTED_WRITER,
  schemaVersion: 8,
  targetVersion: 9,
  acceptedSqlDeltas: Object.freeze([...ALLOWED_MIGRATION_SQL_DELTAS]),
});
