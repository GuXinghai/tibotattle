import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { linkSync, readFileSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { stableJson } from "../src/export/canonical-json.js";
import { convertPreReleaseIndexCopy, classifyPreReleaseIndexConversionFailure } from "../scripts/lib/pre-release-index-conversion.mjs";
import {
  PRE_RELEASE_INDEX_SCHEMA_ALLOWLIST_READY,
  PRE_RELEASE_INDEX_V8_SCHEMA_OBJECTS,
  PRE_RELEASE_INDEX_V8_OBJECT_SQL_SHA256,
  PRE_RELEASE_INDEX_V8_TEST_SEEDS,
  PRE_RELEASE_INDEX_V9_MIGRATED_OBJECT_SQL_SHA256,
  PRE_RELEASE_INDEX_ALTERED_STORE_STATE_SQL,
} from "../scripts/lib/pre-release-index-v8-schema.mjs";
import { loadWindowsLegacyStateReadBinding } from "../src/platform/index.js";
import { assertWindowsOwnerOnly } from "./helpers/windows-owner-only-fixture.js";

const FILE_NAME = "local-index-store-v1.sqlite";
const NATIVE_SKIP = process.platform === "win32" && process.arch === "x64" ? false : "native Windows x64 only";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const identitySha = identity => sha(Buffer.from(stableJson({
  volumeSerialNumber: identity.volumeSerialNumber,
  fileId: identity.fileId,
  linkCount: identity.linkCount,
})));
const failure = category => error => classifyPreReleaseIndexConversionFailure(error)
  === `PRE_RELEASE_INDEX_CONVERSION_${category}`;
const fixedFailure = category => error => error.message === "Pre-release index conversion refused"
  && failure(category)(error);

// This fixture executes the pinned 63e8753a writer's captured sqlite_schema
// SQL, then inserts content-free synthetic rows. It never relabels a v9 file.
function installV8SourceTriggers(database) {
  for (const object of PRE_RELEASE_INDEX_V8_SCHEMA_OBJECTS.filter(row => row.type === "trigger")) {
    if (object.name.startsWith("calculation_source_")) database.exec(object.sql);
  }
}

function createCanonicalV8Schema(database, { alteredStoreState = false } = {}) {
  database.prepare("PRAGMA journal_mode=WAL").get();
  database.exec("PRAGMA foreign_keys=ON");
  for (const object of PRE_RELEASE_INDEX_V8_SCHEMA_OBJECTS.filter(row => row.type === "table")) {
    if (alteredStoreState && object.name === 'store_state') {
      database.exec(`CREATE TABLE store_state(
    id INTEGER PRIMARY KEY CHECK(id = 1),
    commit_seq INTEGER NOT NULL) STRICT`);
      database.exec('ALTER TABLE store_state ADD COLUMN calculation_revision INTEGER NOT NULL DEFAULT 0 CHECK(calculation_revision >= 0)');
      assert.equal(database.prepare("SELECT sql FROM sqlite_schema WHERE name='store_state'").get().sql,
        PRE_RELEASE_INDEX_ALTERED_STORE_STATE_SQL);
    } else database.exec(object.sql);
  }
  for (const object of PRE_RELEASE_INDEX_V8_SCHEMA_OBJECTS.filter(row => row.type === "index")) database.exec(object.sql);
  for (const object of PRE_RELEASE_INDEX_V8_SCHEMA_OBJECTS.filter(row => row.type === "trigger")) {
    if (!object.name.startsWith("calculation_source_")) database.exec(object.sql);
  }
  for (const [table, rows] of Object.entries(PRE_RELEASE_INDEX_V8_TEST_SEEDS)) {
    for (const row of rows) {
      const columns = Object.keys(row);
      database.prepare(`INSERT INTO "${table}" (${columns.map(column => `"${column}"`).join(",")})
        VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(column => row[column]));
    }
  }
  installV8SourceTriggers(database);
  database.exec("PRAGMA application_id=0x554d4932; PRAGMA user_version=8");
}

function insertSyntheticRows(database) {
  database.prepare("INSERT INTO session(session_local,session_uuid) VALUES (?,?)")
    .run(Buffer.alloc(32, 0x11), "synthetic-session");
  database.prepare("INSERT INTO account_scope(status,reason,plan_type,scope_local) VALUES (?,?,?,?)")
    .run("synthetic", null, null, null);
  database.prepare("INSERT INTO model(model_id,recognition) VALUES (?,?)")
    .run("synthetic-model", "synthetic");
  database.prepare(`INSERT INTO tier_semantics(api_service_tier,billing_surface,codex_speed_mode,tier_source,provider_tier_raw)
    VALUES (?,?,?,?,?)`).run("default", "codex", "default", "turn_context", null);
  database.prepare(`INSERT INTO surface_class(agent_scope,surface,thread_source,lineage_disposition)
    VALUES (?,?,?,?)`).run("codex", "cli", "synthetic", "native");
  database.prepare(`INSERT INTO source(
    source_local,source_ordinal,session_id,surface_id,path,rollout_key,presence,size_bytes,mtime_ms,
    scanned_bytes,parser_version,carry_tier_raw,carry_tier_observed_at_ms,lineage_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    Buffer.alloc(32, 0x22), 0, 1, 1, "C:\\synthetic\\rollout.jsonl", "synthetic-rollout", "present",
    1, 100, 0, "synthetic-v8-fixture", "fast", 100, '{"synthetic":true}',
  );
  // A provisional fact and deliberately stale rollup prove that conversion
  // calls only the connection migration, not normal-open repair/reconcile.
  database.prepare(`INSERT INTO usage_event(
    source_id,source_offset,observed_at_ms,event_key,session_id,account_scope_id,model_id,tier_id,
    surface_id,reasoning_effort,flags) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    1, 1, 100, Buffer.alloc(32, 0x33), 1, 1, 1, 1, 1, 0, 1,
  );
  database.prepare(`INSERT INTO usage_rollup(
    bucket_ms,model_id,tier_id,surface_id,account_scope_id,shape,ctx_class,events,in_uncached,
    in_cache_read,in_cache_write,out_text,out_reasoning,out_combined) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    0, 1, 1, 1, 1, 0, 0, 777, 0, 0, 0, 0, 0, 0,
  );
}

async function makeFixture(t, { mutateSource = null, alteredStoreState = false } = {}) {
  const native = loadWindowsLegacyStateReadBinding();
  const root = resolve(".release-build", `pre-release-index-conversion-${randomUUID()}`);
  native.ensureDirectory(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const workRoot = join(root, "fixture-writer");
  const sourceRoot = join(root, "v8-backup");
  const destinationRoot = join(root, "converted-copy");
  native.ensureDirectory(workRoot);
  native.ensureDirectory(sourceRoot);
  native.ensureDirectory(destinationRoot);
  const workFile = join(workRoot, FILE_NAME);

  const writer = new DatabaseSync(workFile);
  try {
    createCanonicalV8Schema(writer, { alteredStoreState });
    insertSyntheticRows(writer);
    writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { writer.close(); }

  const fixtureCheck = new DatabaseSync(`${pathToFileURL(workFile).href}?mode=ro&immutable=1`, { readOnly: true });
  try {
    assert.equal(fixtureCheck.prepare("PRAGMA user_version").get().user_version, 8);
    assert.equal(fixtureCheck.prepare("PRAGMA application_id").get().application_id, 0x554d4932);
    assert.equal(fixtureCheck.prepare("PRAGMA table_info(source)").all().some(row => row.name === "carry_tier_source"), false);
    const sourceTriggers = fixtureCheck.prepare("SELECT sql FROM sqlite_schema WHERE name LIKE 'calculation_source_%'").all();
    assert.equal(sourceTriggers.length, 3);
    assert.equal(sourceTriggers.some(row => row.sql.includes("carry_tier_source")), false);
  } finally { fixtureCheck.close(); }
  const sourceHeader = readFileSync(workFile);
  assert.equal(sourceHeader.subarray(18, 20).toString("hex"), "0202");

  if (mutateSource) {
    const physicalV8 = new DatabaseSync(workFile);
    try {
      mutateSource(physicalV8);
      physicalV8.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally { physicalV8.close(); }
  }

  let writerRootGuard;
  let backupRootGuard;
  let sourceLease;
  try {
    writerRootGuard = native.acquireProtectedDirectoryGuard(workRoot);
    backupRootGuard = native.acquireProtectedDirectoryGuard(sourceRoot);
    sourceLease = native.openLegacyStateFile(workFile);
    native.copyLegacyStateFile(sourceLease, sourceRoot, backupRootGuard.identity, FILE_NAME);
  } finally {
    if (sourceLease) native.closeSourceFile(sourceLease);
    if (backupRootGuard) native.releaseProtectedDirectoryGuard(backupRootGuard.guard);
    if (writerRootGuard) native.releaseProtectedDirectoryGuard(writerRootGuard.guard);
  }

  const sourceFile = join(sourceRoot, FILE_NAME);
  return {
    native, root, workFile, sourceRoot, sourceFile, destinationRoot,
    expectedSourceSha256: sha(readFileSync(sourceFile)),
    options: () => ({ sourceFile, destinationRoot, expectedSourceSha256: sha(readFileSync(sourceFile)) }),
  };
}

function sourceSnapshot(fixture) {
  const names = readdirSync(fixture.sourceRoot).sort();
  const entries = names.map(name => {
    const file = join(fixture.sourceRoot, name);
    const stat = statSync(file);
    const security = fixture.native.inspectPath(file);
    return {
      name, sha256: sha(readFileSync(file)), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      identity: security.identity, ownerMatches: security.ownerMatches, daclProtected: security.daclProtected,
      broadAccess: security.broadAccess, nonOwnerAllow: security.nonOwnerAllow,
    };
  });
  return {
    entries,
    mainSha256: entries.find(entry => entry.name === FILE_NAME)?.sha256,
  };
}

test('the exact historical ALTER-created store_state spelling preserves rows and schema SQL', { skip: NATIVE_SKIP }, async t => {
  const fixture = await makeFixture(t, { alteredStoreState: true });
  const result = await convertPreReleaseIndexCopy(fixture.options());
  assert.equal(result.sourceLogicalSha256, result.targetLogicalSha256);
  const database = new DatabaseSync(`${pathToFileURL(join(fixture.destinationRoot, FILE_NAME)).href}?mode=ro&immutable=1`, { readOnly: true });
  try { assert.equal(database.prepare("SELECT sql FROM sqlite_schema WHERE name='store_state'").get().sql,
    PRE_RELEASE_INDEX_ALTERED_STORE_STATE_SQL); } finally { database.close(); }
});

test("configuration is closed and rejects accessors, proxies, foreign objects, empty hashes and root overlap", async () => {
  const valid = {
    sourceFile: "C:\\synthetic\\local-index-store-v1.sqlite",
    destinationRoot: "C:\\synthetic-output",
    expectedSourceSha256: "a".repeat(64),
  };
  for (const options of [undefined, null, [], Object.create(null), new Date(),
    { sourceFile: valid.sourceFile, destinationRoot: valid.destinationRoot },
    { ...valid, signal: {} }, { ...valid, extra: true },
    { ...valid, [Symbol("extra")]: true }, { ...valid, expectedSourceSha256: "" },
    { ...valid, expectedSourceSha256: "A".repeat(64) }, new Proxy({ ...valid }, {})]) {
    await assert.rejects(convertPreReleaseIndexCopy(options), failure("CONFIGURATION_INVALID"));
  }
  let getterCalled = false;
  const accessor = { ...valid };
  Object.defineProperty(accessor, "sourceFile", { get() { getterCalled = true; return valid.sourceFile; } });
  await assert.rejects(convertPreReleaseIndexCopy(accessor), failure("CONFIGURATION_INVALID"));
  assert.equal(getterCalled, false);
  await assert.rejects(convertPreReleaseIndexCopy({ ...valid, destinationRoot: "C:\\synthetic\\nested" }), failure("ROOT_OVERLAP"));
  await assert.rejects(convertPreReleaseIndexCopy({ ...valid, signal: AbortSignal.abort() }), failure("CANCELLED"));
  assert.equal(classifyPreReleaseIndexConversionFailure({ code: "PRE_RELEASE_INDEX_CONVERSION_SOURCE_CHANGED" }),
    "PRE_RELEASE_INDEX_CONVERSION_UNAVAILABLE");
});

test("a genuine v8 backup copy converts through PERSIST without repairing or reconciling rows", { skip: NATIVE_SKIP }, async t => {
  const fixture = await makeFixture(t);
  const before = sourceSnapshot(fixture);
  const result = await convertPreReleaseIndexCopy(fixture.options());

  assert.equal(result.code, "index_copy_upgraded_v8_to_v9");
  assert.equal(result.sourceVersion, 8); assert.equal(result.targetVersion, 9);
  assert.equal(result.sourceSha256, before.mainSha256);
  assert.equal(result.targetSha256, sha(readFileSync(join(fixture.destinationRoot, FILE_NAME))));
  assert.equal(result.sourceRows, result.targetRows);
  assert.equal(result.sourceLogicalSha256, result.targetLogicalSha256);
  const sourceFileIdentity = before.entries.find(entry => entry.name === FILE_NAME).identity;
  const sourceRootIdentity = fixture.native.inspectPath(fixture.sourceRoot).identity;
  const destinationRootIdentity = fixture.native.inspectPath(fixture.destinationRoot).identity;
  const targetFileIdentity = fixture.native.inspectPath(join(fixture.destinationRoot, FILE_NAME)).identity;
  for (const key of ["sourceRootIdentitySha256", "sourceFileIdentitySha256",
    "destinationRootIdentitySha256", "targetFileIdentitySha256"]) {
    assert.match(result[key], /^[a-f0-9]{64}$/u);
  }
  assert.equal(result.sourceRootIdentitySha256, identitySha(sourceRootIdentity));
  assert.equal(result.sourceFileIdentitySha256, identitySha(sourceFileIdentity));
  assert.equal(result.destinationRootIdentitySha256, identitySha(destinationRootIdentity));
  assert.equal(result.targetFileIdentitySha256, identitySha(targetFileIdentity));
  assert.equal(Object.hasOwn(result, "sourceFileIdentity"), false);
  assert.doesNotMatch(JSON.stringify(result), /volumeSerialNumber|fileId|linkCount/u);
  assert.equal(result.tableRows.find(row => row.table === "usage_event").rows, 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-model|synthetic-rollout|synthetic\\|[A-Za-z]:\\/u);
  assert.deepEqual(sourceSnapshot(fixture), before, "the protected source and its identity remain unchanged");

  const files = readdirSync(fixture.destinationRoot).sort();
  assert.deepEqual(files, [FILE_NAME, `${FILE_NAME}-journal`].sort());
  assert.equal(statSync(join(fixture.destinationRoot, `${FILE_NAME}-journal`)).size, 0);
  assertWindowsOwnerOnly(join(fixture.destinationRoot, FILE_NAME));
  assertWindowsOwnerOnly(join(fixture.destinationRoot, `${FILE_NAME}-journal`));
  const targetHeader = readFileSync(join(fixture.destinationRoot, FILE_NAME));
  assert.equal(targetHeader.subarray(18, 20).toString("hex"), "0101");
  assert.equal(targetHeader.readUInt32BE(60), 9);

  const targetFile = join(fixture.destinationRoot, FILE_NAME);
  const database = new DatabaseSync(`${pathToFileURL(targetFile).href}?mode=ro&immutable=1`, { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA user_version").get().user_version, 9);
    assert.equal(database.prepare("PRAGMA application_id").get().application_id, 0x554d4932);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM source WHERE carry_tier_source IS NOT NULL").get().n, 0);
    assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM usage_event u JOIN source s ON s.id=u.source_id
      WHERE u.source_offset>s.scanned_bytes`).get().n, 1);
    assert.equal(database.prepare("SELECT events FROM usage_rollup").get().events, 777);
    assert.notEqual(database.prepare("PRAGMA journal_mode").get().journal_mode.toLowerCase(), "wal");
    const objects = database.prepare(`SELECT type,name,sql FROM sqlite_schema
      WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name`).all();
    for (const object of objects) {
      assert.equal(sha(Buffer.from(object.sql ?? "")),
        PRE_RELEASE_INDEX_V9_MIGRATED_OBJECT_SQL_SHA256[`${object.type}:${object.name}`], `${object.type}:${object.name}`);
    }
  } finally { database.close(); }
});

test("wrong source hash and an occupied destination refuse without changing either input", { skip: NATIVE_SKIP }, async t => {
  const fixture = await makeFixture(t);
  const before = sourceSnapshot(fixture);
  await assert.rejects(convertPreReleaseIndexCopy({ ...fixture.options(), expectedSourceSha256: "0".repeat(64) }),
    failure("SOURCE_HASH_MISMATCH"));
  assert.deepEqual(readdirSync(fixture.destinationRoot), []);
  assert.deepEqual(sourceSnapshot(fixture), before);

  const sentinel = join(fixture.destinationRoot, "synthetic-sentinel");
  fixture.native.createFile(sentinel, Buffer.from("synthetic"));
  const sentinelHash = sha(readFileSync(sentinel));
  await assert.rejects(convertPreReleaseIndexCopy(fixture.options()), failure("DESTINATION_NOT_EMPTY"));
  assert.equal(sha(readFileSync(sentinel)), sentinelHash);
  assert.deepEqual(sourceSnapshot(fixture), before);
});

test("a pre-aborted conversion leaves the explicit source hash and empty target root untouched", { skip: NATIVE_SKIP }, async t => {
  const fixture = await makeFixture(t);
  const before = sourceSnapshot(fixture);
  const expectedHash = fixture.options().expectedSourceSha256;
  await assert.rejects(convertPreReleaseIndexCopy({ ...fixture.options(), signal: AbortSignal.abort() }), failure("CANCELLED"));
  assert.deepEqual(readdirSync(fixture.destinationRoot), []);
  assert.deepEqual(sourceSnapshot(fixture), before);
  assert.equal(sha(readFileSync(fixture.sourceFile)), expectedHash);
});

test("an inherited source-file DACL is refused without repair or source-byte changes", { skip: NATIVE_SKIP }, async t => {
  const fixture = await makeFixture(t);
  const sourceHash = sha(readFileSync(fixture.sourceFile));
  execFileSync("icacls.exe", [fixture.sourceFile, "/inheritance:e"], { stdio: "ignore", windowsHide: true });
  const unsafeAcl = fixture.native.inspectPath(fixture.sourceFile);
  assert.equal(unsafeAcl.daclProtected, false);
  await assert.rejects(convertPreReleaseIndexCopy(fixture.options()), fixedFailure("ACL_INVALID"));
  assert.equal(sha(readFileSync(fixture.sourceFile)), sourceHash);
  assert.deepEqual(fixture.native.inspectPath(fixture.sourceFile), unsafeAcl, "conversion did not repair the source ACL");
  assert.deepEqual(readdirSync(fixture.destinationRoot), []);
});

test("an inherited destination-root DACL is refused without repair or source mutation", { skip: NATIVE_SKIP }, async t => {
  const fixture = await makeFixture(t);
  const sourceBefore = sourceSnapshot(fixture);
  execFileSync("icacls.exe", [fixture.destinationRoot, "/inheritance:e"], { stdio: "ignore", windowsHide: true });
  const unsafeAcl = fixture.native.inspectPath(fixture.destinationRoot);
  assert.equal(unsafeAcl.daclProtected, false);
  await assert.rejects(convertPreReleaseIndexCopy(fixture.options()), fixedFailure("ROOT_INVALID"));
  assert.deepEqual(fixture.native.inspectPath(fixture.destinationRoot), unsafeAcl, "conversion did not repair the destination ACL");
  assert.deepEqual(sourceSnapshot(fixture), sourceBefore);
  assert.deepEqual(readdirSync(fixture.destinationRoot), []);
});

test("a hardlinked protected source is refused before destination creation", { skip: NATIVE_SKIP }, async t => {
  const fixture = await makeFixture(t);
  linkSync(fixture.sourceFile, join(fixture.root, "synthetic-hardlink"));
  await assert.rejects(convertPreReleaseIndexCopy(fixture.options()), error =>
    ["PRE_RELEASE_INDEX_CONVERSION_UNAVAILABLE", "PRE_RELEASE_INDEX_CONVERSION_IDENTITY_INVALID"].includes(
      classifyPreReleaseIndexConversionFailure(error)));
  assert.deepEqual(readdirSync(fixture.destinationRoot), []);
});

test("an open writable SQLite handle blocks source freezing; closing it leaves the same source convertible", { skip: NATIVE_SKIP }, async t => {
  const fixture = await makeFixture(t);
  const initial = sourceSnapshot(fixture).entries.find(entry => entry.name === FILE_NAME);
  const options = fixture.options();
  let writer;
  try {
    writer = new DatabaseSync(fixture.sourceFile, { timeout: 5000 });
    const heldOpen = sourceSnapshot(fixture).entries.find(entry => entry.name === FILE_NAME);
    await assert.rejects(convertPreReleaseIndexCopy(options), fixedFailure("UNAVAILABLE"));
    assert.deepEqual(sourceSnapshot(fixture).entries.find(entry => entry.name === FILE_NAME), heldOpen,
      "failed admission did not change the live source");
    assert.deepEqual(readdirSync(fixture.destinationRoot), []);
  } finally {
    writer?.close();
  }

  const afterClose = sourceSnapshot(fixture).entries.find(entry => entry.name === FILE_NAME);
  assert.equal(afterClose.sha256, initial.sha256);
  assert.equal(afterClose.sha256, options.expectedSourceSha256);
  assert.deepEqual(afterClose.identity, initial.identity);
  assert.equal(afterClose.ownerMatches, initial.ownerMatches);
  assert.equal(afterClose.daclProtected, initial.daclProtected);
  assert.equal(afterClose.broadAccess, initial.broadAccess);
  assert.equal(afterClose.nonOwnerAllow, initial.nonOwnerAllow);
  assert.equal(await convertPreReleaseIndexCopy(options).then(result => result.code), "index_copy_upgraded_v8_to_v9");
});

for (const [suffix, bytes] of [
  ["-wal", Buffer.from("synthetic-uncommitted-wal")],
  ["-shm", Buffer.from("synthetic-shm")],
  ["-journal", Buffer.from([1, ...Buffer.alloc(27)])],
]) {
  test(`nonempty or hot source ${suffix} refuses before copying`, { skip: NATIVE_SKIP }, async t => {
    const fixture = await makeFixture(t);
    fixture.native.createFile(join(fixture.sourceRoot, `${FILE_NAME}${suffix}`), bytes);
    const before = sourceSnapshot(fixture);
    await assert.rejects(convertPreReleaseIndexCopy(fixture.options()), failure("DATABASE_NOT_COLD"));
    assert.deepEqual(readdirSync(fixture.destinationRoot), []);
    assert.deepEqual(sourceSnapshot(fixture), before);
  });
}

test("existing empty source sidecars are accepted and left byte-for-byte intact", { skip: NATIVE_SKIP }, async t => {
  const fixture = await makeFixture(t);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    fixture.native.createFile(join(fixture.sourceRoot, `${FILE_NAME}${suffix}`), Buffer.alloc(0));
  }
  const before = sourceSnapshot(fixture);
  const result = await convertPreReleaseIndexCopy(fixture.options());
  assert.equal(result.code, "index_copy_upgraded_v8_to_v9");
  assert.deepEqual(sourceSnapshot(fixture), before);
});

test("unknown table schema and a non-v8 version fail closed before destination creation", { skip: NATIVE_SKIP }, async t => {
  const unknown = await makeFixture(t, { mutateSource: db => db.exec("CREATE TABLE synthetic_unknown_schema(value TEXT)") });
  await assert.rejects(convertPreReleaseIndexCopy(unknown.options()), failure("SCHEMA_UNSUPPORTED"));
  assert.deepEqual(readdirSync(unknown.destinationRoot), []);

  const unknownTrigger = await makeFixture(t, {
    mutateSource: db => db.exec("CREATE TRIGGER synthetic_unknown_trigger AFTER INSERT ON source BEGIN SELECT 1; END"),
  });
  await assert.rejects(convertPreReleaseIndexCopy(unknownTrigger.options()), failure("SCHEMA_UNSUPPORTED"));
  assert.deepEqual(readdirSync(unknownTrigger.destinationRoot), []);

  const sqlitePrefix = await makeFixture(t, { mutateSource: db => db.exec("CREATE TABLE sqliteXevil(value TEXT)") });
  await assert.rejects(convertPreReleaseIndexCopy(sqlitePrefix.options()), failure("SCHEMA_UNSUPPORTED"));
  assert.deepEqual(readdirSync(sqlitePrefix.destinationRoot), []);

  const wrongVersion = await makeFixture(t, { mutateSource: db => db.exec("PRAGMA user_version=7") });
  await assert.rejects(convertPreReleaseIndexCopy(wrongVersion.options()), failure("DATABASE_UNSUPPORTED"));
  assert.deepEqual(readdirSync(wrongVersion.destinationRoot), []);
});

test("known trigger and optional index names with changed SQL bodies still fail the exact schema gate", { skip: NATIVE_SKIP }, async t => {
  const trigger = await makeFixture(t, { mutateSource: db => {
    db.exec("DROP TRIGGER calculation_source_insert");
    db.exec("CREATE TRIGGER calculation_source_insert AFTER INSERT ON source BEGIN SELECT 1; END");
  } });
  await assert.rejects(convertPreReleaseIndexCopy(trigger.options()), failure("SCHEMA_UNSUPPORTED"));
  assert.deepEqual(readdirSync(trigger.destinationRoot), []);

  const index = await makeFixture(t, { mutateSource: db => {
    db.exec("DROP INDEX usage_event_observed");
    db.exec("CREATE INDEX usage_event_observed ON usage_event(session_id)");
  } });
  await assert.rejects(convertPreReleaseIndexCopy(index.options()), failure("SCHEMA_UNSUPPORTED"));
  assert.deepEqual(readdirSync(index.destinationRoot), []);
});

test("a closed v8 variant with a reviewed optional secondary index absent converts without changing rows", { skip: NATIVE_SKIP }, async t => {
  const fixture = await makeFixture(t, { mutateSource: db => db.exec("DROP INDEX usage_event_observed") });
  const before = sourceSnapshot(fixture);
  const result = await convertPreReleaseIndexCopy(fixture.options());
  assert.equal(result.code, "index_copy_upgraded_v8_to_v9");
  assert.equal(result.sourceLogicalSha256, result.targetLogicalSha256);
  assert.deepEqual(sourceSnapshot(fixture), before);
  assert.deepEqual(readdirSync(fixture.destinationRoot), [FILE_NAME, `${FILE_NAME}-journal`].sort());
});

test("the physical v8 fixture derives from the pinned pre-v9 writer rather than a version relabel", { skip: NATIVE_SKIP }, async t => {
  assert.equal(PRE_RELEASE_INDEX_SCHEMA_ALLOWLIST_READY, true);
  const fixture = await makeFixture(t);
  const file = fixture.sourceFile;
  const database = new DatabaseSync(`${pathToFileURL(file).href}?mode=ro&immutable=1`, { readOnly: true });
  try {
    const version = database.prepare("PRAGMA user_version").get().user_version;
    const sourceColumns = database.prepare("PRAGMA table_info(source)").all().map(row => row.name);
    const triggerSql = database.prepare("SELECT sql FROM sqlite_schema WHERE name='calculation_source_update'").get().sql;
    assert.equal(version, 8);
    assert.equal(sourceColumns.includes("carry_tier_source"), false);
    assert.equal(triggerSql.includes("carry_tier_source"), false);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n, 1);
    const objects = database.prepare(`SELECT type,name,sql FROM sqlite_schema
      WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name`).all();
    for (const object of objects) {
      assert.equal(sha(Buffer.from(object.sql ?? "")),
        PRE_RELEASE_INDEX_V8_OBJECT_SQL_SHA256[`${object.type}:${object.name}`], `${object.type}:${object.name}`);
    }
  } finally { database.close(); }
  // The fixture DDL and SQL hashes are pinned to 63e8753a in the canonical
  // schema artifact; it contains the actual v8 source table and trigger SQL.
});
