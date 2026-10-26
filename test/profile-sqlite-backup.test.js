import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { rm, symlink, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  classifyProfileSqliteBackupFailure, PROFILE_SQLITE_BACKUP_REPORT_SCHEMA,
  verifyColdLocalStateBackup,
} from "../scripts/lib/profile-sqlite-backup.mjs";
import { commitLocalCollectorState } from "../src/local-collector-state.js";
import { openLocalIndexStore } from "../src/local-index-store.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { generateSyntheticCodexCorpus } from "../src/synthetic-codex-rollout-corpus.js";
import { copyWindowsLegacyState, loadWindowsLegacyStateReadBinding } from "../src/platform/index.js";
import { grantSyntheticEveryoneRead } from "./helpers/windows-owner-only-fixture.js";

const SALT = "local-unified-index-device-salt-v1";
const names = { index: "local-index-store-v1.sqlite", collector: "local-collector-state-v1.sqlite" };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const category = code => error => classifyProfileSqliteBackupFailure(error) === `PROFILE_SQLITE_BACKUP_${code}`;

async function fixture(t, family = "index", { populate = false, mutate = null } = {}) {
  const native = loadWindowsLegacyStateReadBinding();
  const root = resolve(".release-build", `profile-sqlite-test-${randomUUID()}`);
  native.ensureDirectory(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, "source"), backupRoot = join(root, "backup");
  native.ensureDirectory(sourceRoot); native.ensureDirectory(backupRoot);
  const file = join(sourceRoot, names[family]);
  if (family === "index") {
    if (populate) {
      const codexHome = join(root, "synthetic-codex");
      generateSyntheticCodexCorpus(codexHome, { seed: 7, files: 2, events: 30, days: 1,
        fillerBytesPerEvent: 0, endAt: "2026-09-01T00:00:00.000Z" });
      await refreshLocalIndex({ codexHome, indexFile: file, secretFile: join(sourceRoot, SALT), workerCount: 1 });
    } else {
      openLocalIndexStore(file, { create: true }).close();
      native.createFile(join(sourceRoot, SALT), Buffer.alloc(32, 71));
    }
  } else {
    await commitLocalCollectorState({ stateFile: file, checkpoint: { schemaVersion: "0.3", files: {}, recentEventKeys: [] },
      records: [{ schemaVersion: "0.3", kind: "codex_tool_class_event", eventKey: "synthetic-event",
        observedAt: "2026-08-03T00:00:00.000Z", toolClass: "other" }], clock: () => Date.parse("2026-08-03T00:00:00.000Z") });
  }
  const db = new DatabaseSync(file);
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); mutate?.(db); } finally { db.close(); }
  assert.equal(copyWindowsLegacyState({ sourceRoot, destinationRoot: backupRoot, binding: native, mode: "copy" }).status, "copied");
  return { native, root, file, backupFile: join(backupRoot, names[family]), options: { sourceRoot, backupRoot, family } };
}

function snapshot(root, native) {
  return readdirSync(root).sort().map(name => {
    const path = join(root, name), stat = statSync(path);
    return { name, sha256: sha(readFileSync(path)), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
      security: native.inspectPath(path) };
  });
}
async function preserved(value, operation) {
  const before = [snapshot(value.options.sourceRoot, value.native), snapshot(value.options.backupRoot, value.native)];
  await operation();
  assert.deepEqual([snapshot(value.options.sourceRoot, value.native), snapshot(value.options.backupRoot, value.native)], before);
  for (const path of [value.file, value.backupFile]) {
    const handle = openSync(path, "r+"); closeSync(handle);
  }
}

for (const family of ["index", "collector"]) {
  test(`native cold ${family} copy verifies real schema, bytes and counts without mutations`, async t => {
    const value = await fixture(t, family, { populate: family === "index" });
    await preserved(value, async () => {
      const result = await verifyColdLocalStateBackup(value.options);
      assert.equal(result.report.schemaVersion, PROFILE_SQLITE_BACKUP_REPORT_SCHEMA);
      assert.equal(result.report.databaseSha256, sha(readFileSync(value.file)));
      assert.notEqual(result.report.sourceIdentitySha256, result.report.backupIdentitySha256);
      assert.equal(result.summary.status, "cold_sqlite_pair_verified");
      assert.equal(result.summary.scope, family === "index" ? "index_database_and_salt_only" : "collector_database_only");
      assert.equal(result.summary.pageIntegrity, "ok"); assert.equal(result.summary.foreignKeys, "ok");
      assert.equal(Object.isFrozen(result.report.tables), true); assert.equal(Object.isFrozen(result.summary), true);
      if (family === "index") {
        assert.ok(result.report.tables.source > 0); assert.ok(result.report.tables.usage_event > 0);
        assert.equal(result.report.saltSha256, sha(readFileSync(join(value.options.sourceRoot, SALT))));
      } else { assert.equal(result.report.tables.records, 1); assert.equal(result.report.saltSha256, null); }
      assert.doesNotMatch(JSON.stringify(result.summary), /sha256|identity|[A-Za-z]:|synthetic-event/iu);
      assert.deepEqual(await verifyColdLocalStateBackup(value.options), result, "repeat verification is deterministic");
    });
  });
}

test("closed configuration refuses unknown keys, getters, roots, families and fake signals before access", async () => {
  const valid = { sourceRoot: "C:\\synthetic-source", backupRoot: "C:\\synthetic-backup", family: "index" };
  for (const options of [undefined, null, [], { ...valid, copy: true }, { ...valid, family: "timing" },
    { ...valid, signal: {} }, { ...valid, [Symbol("unknown")]: true }, { ...valid, backupRoot: undefined }]) {
    await assert.rejects(verifyColdLocalStateBackup(options), category("CONFIGURATION_INVALID"));
  }
  for (const sourceRoot of ["", ".", "relative", "C:\\", "\\source", "C:source", "\\\\server\\share\\source", "C:\\synthetic\\..\\source", "C:\\synthetic\0source"]) {
    await assert.rejects(verifyColdLocalStateBackup({ ...valid, sourceRoot }), category("CONFIGURATION_INVALID"));
  }
  for (const backupRoot of [valid.sourceRoot, "c:\\SYNTHETIC-SOURCE\\child", "C:\\"]) {
    await assert.rejects(verifyColdLocalStateBackup({ ...valid, backupRoot }), category(backupRoot === "C:\\" ? "CONFIGURATION_INVALID" : "ROOT_COLLISION"));
  }
  let called = false;
  await assert.rejects(verifyColdLocalStateBackup({ ...valid, get sourceRoot() { called = true; return valid.sourceRoot; } }), category("CONFIGURATION_INVALID"));
  assert.equal(called, false);
  assert.equal(classifyProfileSqliteBackupFailure({ code: "PROFILE_SQLITE_BACKUP_CANCELLED", message: "private" }), "PROFILE_SQLITE_BACKUP_UNAVAILABLE");
  await assert.rejects(verifyColdLocalStateBackup({ ...valid, signal: AbortSignal.abort() }), category("CANCELLED"));
});

for (const change of ["same-size-bytes", "short-copy", "salt", "short-salt", "missing-salt", "missing-database"]) {
  test(`mismatched or missing ${change} refuses without repairing either copy`, async t => {
    const value = await fixture(t);
    if (change === "same-size-bytes") {
      const bytes = readFileSync(value.backupFile); bytes[bytes.length - 1] ^= 1; writeFileSync(value.backupFile, bytes);
    } else if (change === "short-copy") writeFileSync(value.backupFile, Buffer.alloc(128));
    else if (change === "salt") writeFileSync(join(value.options.backupRoot, SALT), Buffer.alloc(32, 72));
    else if (change === "short-salt") writeFileSync(join(value.options.backupRoot, SALT), Buffer.alloc(31));
    else await unlink(change === "missing-salt" ? join(value.options.backupRoot, SALT) : value.backupFile);
    const code = change === "salt" ? "SALT_MISMATCH" : change === "short-salt" ? "SALT_INVALID"
      : change.startsWith("missing") ? "UNAVAILABLE" : "BYTES_MISMATCH";
    const before = snapshot(value.options.sourceRoot, value.native);
    await assert.rejects(verifyColdLocalStateBackup(value.options), category(code));
    assert.deepEqual(snapshot(value.options.sourceRoot, value.native), before);
    const lease = openSync(value.file, "r+"); closeSync(lease);
  });
}

for (const [name, sql, code] of [
  ["newer version", "PRAGMA user_version=999", "DATABASE_UNSUPPORTED"],
  ["wrong family", "UPDATE meta SET value='unsupported' WHERE key='family'", "DATABASE_UNSUPPORTED"],
  ["foreign keys", "PRAGMA foreign_keys=OFF; CREATE TABLE synthetic_parent(id INTEGER PRIMARY KEY); CREATE TABLE synthetic_child(id INTEGER REFERENCES synthetic_parent); INSERT INTO synthetic_child VALUES(1)", "FOREIGN_KEY_FAILED"],
]) {
  test(`identical copies with ${name} are not accepted`, async t => {
    const value = await fixture(t, "index", { mutate: db => db.exec(sql) });
    await preserved(value, () => assert.rejects(verifyColdLocalStateBackup(value.options), category(code)));
  });
}

test("a wrong SQLite application identity is refused even when both copies match", async t => {
  const value = await fixture(t);
  // The continuity copier rejects this identity too. Corrupt only these test
  // files after a legitimate copy, rather than weakening copier admission.
  for (const file of [value.file, value.backupFile]) {
    const bytes = readFileSync(file); bytes.writeUInt32BE(42, 68); writeFileSync(file, bytes);
  }
  await preserved(value, () => assert.rejects(verifyColdLocalStateBackup(value.options), category("DATABASE_UNSUPPORTED")));
});

for (const [name, transform, code] of [
  ["empty", () => Buffer.alloc(0), "SIZE_INVALID"],
  ["invalid header", bytes => { bytes[0] = 0; return bytes; }, "HEADER_INVALID"],
]) {
  test(`matching ${name} files cannot masquerade as verified databases`, async t => {
    const value = await fixture(t);
    for (const file of [value.file, value.backupFile]) writeFileSync(file, transform(readFileSync(file)));
    await preserved(value, () => assert.rejects(verifyColdLocalStateBackup(value.options), category(code)));
  });
}

test("collector schema marker is checked independently of its physical version", async t => {
  const value = await fixture(t, "collector", { mutate: db => db.exec("UPDATE meta SET value_json='\"unsupported\"' WHERE key='schema_version'") });
  await preserved(value, () => assert.rejects(verifyColdLocalStateBackup(value.options), category("DATABASE_UNSUPPORTED")));
});

test("identical corrupt database pages refuse with content-free failures", async t => {
  const value = await fixture(t);
  for (const file of [value.file, value.backupFile]) {
    const bytes = readFileSync(file); bytes.fill(255, 100, 120); writeFileSync(file, bytes);
  }
  await preserved(value, () => assert.rejects(verifyColdLocalStateBackup(value.options), error => {
    assert.equal(error.message, "Cold local-state backup verification refused");
    return ["PROFILE_SQLITE_BACKUP_UNAVAILABLE", "PROFILE_SQLITE_BACKUP_INTEGRITY_FAILED"].includes(classifyProfileSqliteBackupFailure(error));
  }));
});

for (const location of ["sourceRoot", "backupRoot"]) for (const suffix of ["-wal", "-shm", "-journal"]) {
  test(`nonempty ${location} ${suffix} is preserved and refused`, async t => {
    const value = await fixture(t);
    value.native.createFile(join(value.options[location], names.index + suffix), Buffer.from("synthetic"));
    await preserved(value, () => assert.rejects(verifyColdLocalStateBackup(value.options), category("DATABASE_NOT_COLD")));
  });
}

test("existing empty sidecars are frozen, accepted and neither removed nor populated", async t => {
  const value = await fixture(t);
  for (const root of [value.options.sourceRoot, value.options.backupRoot]) for (const suffix of ["-wal", "-shm", "-journal"]) {
    value.native.createFile(join(root, names.index + suffix), Buffer.alloc(0));
  }
  await preserved(value, () => verifyColdLocalStateBackup(value.options));
});

test("an active writer prevents frozen-source admission without changing state", async t => {
  const value = await fixture(t), writer = openSync(value.file, "r+");
  try { await preserved(value, () => assert.rejects(verifyColdLocalStateBackup(value.options), category("UNAVAILABLE"))); }
  finally { closeSync(writer); }
  await verifyColdLocalStateBackup(value.options);
});

for (const location of ["sourceRoot", "backupRoot"]) {
  test(`hardlinked ${location} database is refused`, async t => {
    const value = await fixture(t);
    linkSync(join(value.options[location], names.index), join(value.root, "synthetic-hardlink"));
    await preserved(value, () => assert.rejects(verifyColdLocalStateBackup(value.options), category("UNAVAILABLE")));
  });
}

test("a junction root is refused without changing its target", async t => {
  const value = await fixture(t), junction = join(value.root, "synthetic-junction");
  await symlink(value.options.backupRoot, junction, "junction");
  try {
    await preserved(value, () => assert.rejects(verifyColdLocalStateBackup({ ...value.options, backupRoot: junction }), category("UNAVAILABLE")));
  } finally { await unlink(junction); }
});

for (const name of ["root", "database", "salt"]) {
  test(`unsafe backup ${name} ACL refuses; source inherited ACL remains unchanged`, async t => {
    const value = await fixture(t);
    grantSyntheticEveryoneRead(value.file); grantSyntheticEveryoneRead(join(value.options.sourceRoot, SALT));
    grantSyntheticEveryoneRead(name === "root" ? value.options.backupRoot : join(value.options.backupRoot, name === "salt" ? SALT : names.index));
    await preserved(value, () => assert.rejects(verifyColdLocalStateBackup(value.options), category("UNAVAILABLE")));
  });
}

test("inherited source ACL is accepted without repair when protected backup bytes match", async t => {
  const value = await fixture(t);
  for (const path of [value.options.sourceRoot, value.file, join(value.options.sourceRoot, SALT)]) grantSyntheticEveryoneRead(path);
  await preserved(value, () => verifyColdLocalStateBackup(value.options));
});

test("cancellation during bounded streaming releases leases and returns no report", async t => {
  const value = await fixture(t, "collector", { mutate: db => db.exec("CREATE TABLE synthetic_padding(payload BLOB); INSERT INTO synthetic_padding VALUES(zeroblob(8388608))") });
  const controller = new AbortController();
  await preserved(value, async () => {
    const pending = verifyColdLocalStateBackup({ ...value.options, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, category("CANCELLED"));
  });
});

test("a sidecar created during verification is detected and left intact", async t => {
  const value = await fixture(t, "collector", { mutate: db => db.exec("CREATE TABLE synthetic_padding(payload BLOB); INSERT INTO synthetic_padding VALUES(zeroblob(8388608))") });
  const path = join(value.options.sourceRoot, names.collector + "-journal");
  const before = readFileSync(value.file);
  const pending = verifyColdLocalStateBackup(value.options);
  value.native.createFile(path, Buffer.alloc(0));
  await assert.rejects(pending, category("SIDECAR_CHANGED"));
  assert.deepEqual(readFileSync(value.file), before);
  assert.equal(statSync(path).size, 0);
  const lease = openSync(value.file, "r+"); closeSync(lease);
});

test("SQLite inspection exceptions close connections and release frozen leases", async t => {
  const value = await fixture(t), prepare = DatabaseSync.prototype.prepare;
  const mock = t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
    if (sql === "PRAGMA quick_check(1)") throw new Error("synthetic private inspection failure");
    return prepare.call(this, sql);
  });
  await preserved(value, () => assert.rejects(verifyColdLocalStateBackup(value.options), category("UNAVAILABLE")));
  mock.mock.restore();
  await verifyColdLocalStateBackup(value.options);
});

test("a changed final native stat refuses the report and releases every lease", async t => {
  const value = await fixture(t), original = value.native.statSourceFile;
  let firstLease, visits = 0;
  const mock = t.mock.method(value.native, "statSourceFile", function (lease) {
    firstLease ??= lease;
    const stat = original.call(this, lease);
    if (lease === firstLease && ++visits > 1) return { ...stat, mtimeMs: stat.mtimeMs + 1 };
    return stat;
  });
  await preserved(value, () => assert.rejects(verifyColdLocalStateBackup(value.options), category("SOURCE_CHANGED")));
  assert.equal(visits, 2);
  mock.mock.restore();
});

test("short native reads refuse instead of hashing incomplete bytes", async t => {
  const value = await fixture(t);
  const mock = t.mock.method(value.native, "readSourceFile", () => Buffer.alloc(0));
  await preserved(value, () => assert.rejects(verifyColdLocalStateBackup(value.options), category("READ_FAILED")));
  assert.equal(mock.mock.callCount(), 1);
  mock.mock.restore();
});

test("oversized input is refused before any database bytes are read", async t => {
  const value = await fixture(t), original = value.native.statSourceFile;
  const mock = t.mock.method(value.native, "statSourceFile", function (lease) {
    return { ...original.call(this, lease), size: 1024 ** 3 + 1 };
  });
  const reads = t.mock.method(value.native, "readSourceFile", () => { throw new Error("must not read oversized input"); });
  await preserved(value, () => assert.rejects(verifyColdLocalStateBackup(value.options), category("SIZE_INVALID")));
  assert.equal(reads.mock.callCount(), 0);
  mock.mock.restore(); reads.mock.restore();
});

test("all frozen handles survive every SQLite close and a transient close failure is retried safely", async t => {
  const value = await fixture(t), original = DatabaseSync.prototype.close;
  let closes = 0;
  const mock = t.mock.method(DatabaseSync.prototype, "close", function () {
    closes++;
    for (const path of [value.file, value.backupFile]) assert.throws(() => openSync(path, "r+"));
    if (closes === 1) throw new Error("synthetic close failure");
    return original.call(this);
  });
  await preserved(value, () => assert.rejects(verifyColdLocalStateBackup(value.options), category("CLOSE_FAILED")));
  assert.equal(closes, 3, "one failed connection remains tracked while the other closes, then retries");
  mock.mock.restore();
  await verifyColdLocalStateBackup(value.options);
});

test("persistent close failure retains leases across GC until the isolated verifier process exits", async t => {
  const value = await fixture(t);
  const moduleURL = new URL("../scripts/lib/profile-sqlite-backup.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { openSync } from "node:fs";
    import { DatabaseSync } from "node:sqlite";
    const { verifyColdLocalStateBackup, classifyProfileSqliteBackupFailure } = await import(process.argv[1]);
    const options = JSON.parse(process.argv[2]);
    DatabaseSync.prototype.close = function () { throw new Error("synthetic close failure"); };
    const refused = error => classifyProfileSqliteBackupFailure(error) === "PROFILE_SQLITE_BACKUP_CLOSE_FAILED";
    await assert.rejects(verifyColdLocalStateBackup(options), refused);
    for (let i = 0; i < 5; i++) { global.gc(); await new Promise(setImmediate); }
    for (const file of JSON.parse(process.argv[3])) assert.throws(() => openSync(file, "r+"));
    await assert.rejects(verifyColdLocalStateBackup(options), refused);
    process.stdout.write("retained-until-exit");
  `, moduleURL, JSON.stringify(value.options), JSON.stringify([value.file, value.backupFile])], { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(child.status, 0, "isolated failure test must complete successfully; stderr is deliberately not forwarded");
  assert.equal(child.stdout, "retained-until-exit");
  await preserved(value, () => verifyColdLocalStateBackup(value.options));
});
