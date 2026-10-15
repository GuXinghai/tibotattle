import { createHash } from "node:crypto";

const VERSION = "local-index-fact-preservation-v1";
const TABLES = Object.freeze({
  work_lifecycle_fact: { order: "source_offset", link: null },
  usage_event: { order: "source_offset", link: "quota_observation_id" },
  quota_occurrence: { order: "source_offset,slot_order", link: "canonical_observation_id" },
});
const sha = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { code }); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (value, expected) => value && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...expected].sort().join(",");

function schema(db) {
  // This inspection tool never opens through the writable/migrating store API.
  if (db.prepare("PRAGMA application_id").get().application_id !== 0x554d4932
      || db.prepare("PRAGMA user_version").get().user_version !== 5
      || db.prepare("SELECT value FROM meta WHERE key='family'").get()?.value !== "local-index-store") {
    fail("preservation_store_unsupported");
  }
  return Object.fromEntries(Object.keys(TABLES).map(table => [table,
    db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)]));
}

export function validatePreservationBaseline(baseline) {
  if (baseline?.version !== VERSION) fail("preservation_baseline_unsupported");
  if (!keys(baseline, ["version", "columns", "sources", "tables"])
      || !keys(baseline.columns, Object.keys(TABLES))
      || !keys(baseline.tables, Object.keys(TABLES))
      || !Array.isArray(baseline.sources) || baseline.sources.length > 1_000_000) {
    fail("preservation_baseline_invalid");
  }
  let prior = 0;
  for (const source of baseline.sources) {
    if (!keys(source, ["id", "end", "identityDigest"]) || !integer(source.id)
        || source.id <= prior || !integer(source.end) || !digest(source.identityDigest)) {
      fail("preservation_baseline_invalid");
    }
    prior = source.id;
  }
  for (const table of Object.keys(TABLES)) {
    const fields = baseline.columns[table], hashes = baseline.tables[table];
    if (!Array.isArray(fields) || !fields.length || fields.length > 100
        || fields.some(field => typeof field !== "string" || !/^[a-z_]+$/.test(field))
        || new Set(fields).size !== fields.length
        || !keys(hashes, ["count", "physicalDigest", "semanticDigest"])
        || !integer(hashes.count) || !digest(hashes.physicalDigest) || !digest(hashes.semanticDigest)) {
      fail("preservation_baseline_invalid");
    }
  }
  return baseline;
}

function fingerprint(db, sources) {
  const tables = {};
  for (const [table, { order, link }] of Object.entries(TABLES)) {
    const physical = createHash("sha256"), semantic = createHash("sha256");
    let count = 0;
    // LEFT JOIN preserves broken references so they cannot silently disappear.
    const select = db.prepare(`SELECT f.*${link ? ", q.id AS __id, q.observed_at_ms AS __at, q.limit_id AS __limit, q.slot AS __slot" : ""}
      FROM ${table} f ${link ? `LEFT JOIN quota_observation q ON q.id=f.${link}` : ""}
      WHERE f.source_id=? AND f.source_offset<=? ORDER BY ${order.split(",").map(name => `f.${name}`).join(",")}`);
    for (const source of sources) {
      for (const result of select.iterate(source.id, source.end)) {
        const { __id, __at, __limit, __slot, ...row } = result;
        physical.update(JSON.stringify(row));
        if (link) {
          if (row[link] === null) {
            if (table === "quota_occurrence") fail("preservation_quota_link_missing");
          } else {
            if (__id === null) fail("preservation_quota_link_missing");
            if (!integer(__at) || typeof __limit !== "string" || typeof __slot !== "string") {
              fail("preservation_quota_identity_invalid");
            }
            // Canonical identity is unique on these three fields. Winner values
            // may change on later observations; original occurrence fields stay
            // in this hash in full, including NULL and all token/percentage data.
            row[link] = [__at, __limit, __slot];
          }
        }
        semantic.update(JSON.stringify(row));
        count++;
      }
    }
    tables[table] = { count, physicalDigest: physical.digest("hex"), semanticDigest: semantic.digest("hex") };
  }
  return tables;
}

function checkSources(db, sources) {
  const select = db.prepare("SELECT source_local,scanned_bytes FROM source WHERE id=?");
  for (const source of sources) {
    const row = select.get(source.id);
    if (!row) fail("preservation_source_missing");
    if (sha(row.source_local) !== source.identityDigest) fail("preservation_source_identity_changed");
    if (row.scanned_bytes < source.end) fail("preservation_source_cursor_regressed");
  }
}

// Caller owns a single read transaction for capture/verify and integrity checks.
// Optional cursors restrict capture to an independently verified older scope;
// they must never be used to replace an unverified failing baseline.
export function capturePreservationBaseline(db, { cursors } = {}) {
  const columns = schema(db);
  const select = db.prepare("SELECT source_local,scanned_bytes FROM source WHERE id=?");
  if (cursors === undefined && db.prepare("SELECT COUNT(*) AS n FROM source").get().n > 1_000_000) {
    fail("preservation_scope_invalid");
  }
  const scope = cursors ?? db.prepare("SELECT id,scanned_bytes FROM source ORDER BY id").all()
    .map(row => [row.id, row.scanned_bytes]);
  if (!Array.isArray(scope) || scope.length > 1_000_000) fail("preservation_scope_invalid");
  const sources = scope.map(([id, end]) => {
    if (!integer(id) || !integer(end)) fail("preservation_scope_invalid");
    const row = select.get(id);
    if (!row || end > row.scanned_bytes) fail("preservation_scope_invalid");
    return { id, end, identityDigest: sha(row.source_local) };
  }).sort((a, b) => a.id - b.id);
  const baseline = { version: VERSION, columns, sources, tables: fingerprint(db, sources) };
  return validatePreservationBaseline(baseline);
}

export function verifyPreservationBaseline(db, input) {
  const baseline = validatePreservationBaseline(input);
  if (JSON.stringify(schema(db)) !== JSON.stringify(baseline.columns)) fail("preservation_schema_changed");
  checkSources(db, baseline.sources);
  const current = fingerprint(db, baseline.sources), tables = {}, errors = [];
  for (const table of Object.keys(TABLES)) {
    const before = baseline.tables[table], after = current[table];
    const unchanged = before.count === after.count && before.semanticDigest === after.semanticDigest;
    const code = unchanged ? null : after.count < before.count ? "preservation_records_missing"
      : after.count > before.count ? "preservation_records_added_in_original_scope"
        : "preservation_fact_or_association_changed";
    if (code) errors.push({ table, code });
    tables[table] = { originalCount: before.count, retainedCount: after.count, unchanged,
      internalLinksRebuilt: unchanged && before.physicalDigest !== after.physicalDigest };
  }
  const integrity = db.prepare("PRAGMA quick_check").get().quick_check === "ok";
  const foreignKeysValid = db.prepare("PRAGMA foreign_key_check").get() === undefined;
  if (!integrity) errors.push({ code: "preservation_integrity_failed" });
  if (!foreignKeysValid) errors.push({ code: "preservation_foreign_key_failed" });
  return { allOriginalFactsUnchanged: errors.length === 0, tables, integrity, foreignKeysValid, errors };
}
