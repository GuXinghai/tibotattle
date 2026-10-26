import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFile, rm, appendFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { resolve, join, relative } from "node:path";
import test from "node:test";
import { openLocalIndexStore } from "../src/local-index-store.js";
import { commitLocalCollectorState } from "../src/local-collector-state.js";
import { openTimingStore } from "../src/platform/index.js";
import { createParser, createToolFreeParser, digest, MAX_STATE_BYTES } from "../src/providers/codex/inference-timing.js";
import { grantSyntheticUsageLegacyAcl, SYNTHETIC_USAGE_READER_SID as READER,
  SYNTHETIC_USAGE_LOGON_SID as LOGON, SYNTHETIC_USAGE_OTHER_LOGON_SID as OTHER_LOGON } from "./helpers/windows-usage-legacy-acl.js";
import { loadUsageFreezeQualificationAdapter, openUsageBundleFreezeQualification, preflightUsageSourceAcl, classifyUsageBundleFreezeFailure } from "../scripts/lib/usage-bundle-freeze.mjs";
const require = createRequire(import.meta.url);
const gate = { skip: process.env.USAGE_MONITOR_USAGE_FREEZE_QUALIFICATION === "1" ? false : "explicit isolated usage-freeze native qualification required" };
const category = code => error => classifyUsageBundleFreezeFailure(error) === `USAGE_BUNDLE_FREEZE_${code}`;
const required = ["local-index-store-v1.sqlite", "local-unified-index-device-salt-v1", "local-collector-state-v1.sqlite"];
function legacyAcl(parent, paths, { reader = READER, rights = "RX" } = {}) {
  grantSyntheticUsageLegacyAcl({ fixtureRoot: resolve(parent, ".."), parent, paths, reader, rights: rights === "M" ? "Modify" : "ReadAndExecute" });
}
function legacyOptions(options) {
  const { privateBinding } = preflightUsageSourceAcl({ sourceRoot: options.sourceRoot, maintenanceParent: options.maintenanceParent, adapter: options.adapter });
  return { ...options, ...privateBinding, sourceAclPolicy: "preserve_legacy_usage_v1" };
}
async function fixture(t, extra = [], { sqlite = false } = {}) {
  const adapter = await loadUsageFreezeQualificationAdapter();
  const native = require(resolve(".release-build/usage-freeze-native-v1/native/windows-filesystem/build/Release/windows_filesystem.node"));
  const root = resolve(".release-build", `ub-${randomUUID()}`), parent = join(root, "p"), source = join(parent, "s"), journal = join(root, "journal");
  native.ensureDirectory(root); native.ensureDirectory(parent); native.ensureDirectory(source); native.ensureDirectory(journal);
  for (const name of [...required, ...extra]) {
    if (sqlite && name.endsWith(".sqlite")) continue;
    const parts = name.split("/"); let directory = source;
    for (const part of parts.slice(0, -1)) { directory = join(directory, part); native.ensureDirectory(directory); }
    native.createFile(join(source, ...parts), Buffer.from(name === required[1] ? "s".repeat(32) : `synthetic:${name}`));
  }
  if (sqlite) {
    const inputRoot = join(root, "sql-input"); native.ensureDirectory(inputRoot);
    const sid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).match(/S-1-[0-9-]+/u)[0];
    execFileSync("icacls.exe", [inputRoot, "/grant:r", `*${sid}:(OI)(CI)(F)`], { stdio: "pipe", windowsHide: true });
    openLocalIndexStore(join(inputRoot, required[0]), { create: true }).close();
    await commitLocalCollectorState({ stateFile: join(inputRoot, required[2]),
      checkpoint: { schemaVersion: "0.3", files: {}, recentEventKeys: [] }, records: [], clock: () => 1_700_000_000_000 });
    for (const name of [required[0], required[2]]) {
      const lease = native.openLegacyStateFile(join(inputRoot, name));
      try { native.copyLegacyStateFile(lease, source, native.inspectPath(source).identity, name); }
      finally { native.closeSourceFile(lease); }
    }
  }
  const options = { sourceRoot: source, maintenanceParent: parent, expectedParentIdentity: native.inspectPath(parent).identity,
    journalRoot: journal, expectedSourceIdentity: native.inspectPath(source).identity, operationId: randomUUID(), adapter };
  t.after(async () => {
    const child = relative(resolve(".release-build"), root); assert.ok(child && !child.startsWith("..") && !child.includes(":"));
    await rm(root, { recursive: true, force: true });
  });
  return { native, root, source, journal, options };
}

test("freeze tool rejects a forged adapter before opening any source or journal", async () => {
  await assert.rejects(openUsageBundleFreezeQualification({ sourceRoot: "C:\\synthetic\\source", journalRoot: "C:\\synthetic\\journal",
    operationId: randomUUID(), expectedSourceIdentity: { volumeSerialNumber: "0".repeat(16), fileId: "0".repeat(32), linkCount: 1 }, adapter: {} }), category("CONFIGURATION_INVALID"));
});

test("explicit legacy source policy preserves inherited ACLs, pins the reader and creates only owner-only backup files", gate, async t => {
  const { native, source, root, options } = await fixture(t);
  legacyAcl(options.maintenanceParent, [source, ...required.map(name => join(source, name))]);
  const selected = legacyOptions(options), before = native.inspectPath(join(source, required[0]));
  assert.equal(before.nonOwnerAllow, true); assert.equal(before.daclProtected, false);
  let session = await openUsageBundleFreezeQualification(selected);
  try {
    await session.freeze(); const manifest = await session.snapshot();
    const target = join(root, "backup"), intent = join(root, "intent"); native.ensureDirectory(target); native.ensureDirectory(intent);
    const result = await session.backup({ backupRoot: target, expectedBackupIdentity: native.inspectPath(target).identity, intentRoot: intent, operationId: randomUUID(), mode: "copy" });
    assert.equal(result.manifestSha256, manifest.manifestSha256);
    for (const name of required) { const metadata = native.inspectPath(join(target, name)); assert.equal(metadata.nonOwnerAllow, false); assert.equal(metadata.daclProtected, true); }
    session.abandon(); session = await openUsageBundleFreezeQualification({ ...selected, resume: true });
    await session.reacquire(); assert.equal((await session.snapshot()).manifestSha256, manifest.manifestSha256);
    await session.restorePermissions(); assert.deepEqual(native.inspectPath(join(source, required[0])), before);
  } finally { if (session.summary().status !== "permissions_restored") await session.restorePermissions(); session.abandon(); }
});

test("legacy policy cannot be selected without a metadata pin or silently substituted on resume", gate, async t => {
  const { source, options } = await fixture(t); legacyAcl(options.maintenanceParent, [source, ...required.map(name => join(source, name))]);
  await assert.rejects(openUsageBundleFreezeQualification({ ...options, sourceAclPolicy: "preserve_legacy_usage_v1" }), category("CONFIGURATION_INVALID"));
  const selected = legacyOptions(options);
  await assert.rejects(openUsageBundleFreezeQualification({ ...selected, expectedParentSecuritySha256: "0".repeat(64) }), category("SOURCE_POLICY_CHANGED"));
  const session = await openUsageBundleFreezeQualification(selected); await session.freeze(); session.abandon();
  await assert.rejects(openUsageBundleFreezeQualification({ ...options, resume: true }), category("STORAGE_UNAVAILABLE"));
  const resumed = await openUsageBundleFreezeQualification({ ...selected, resume: true });
  try { await resumed.restorePermissions(); } finally { resumed.abandon(); }
});

const historicalSnapshots = ["inference-timing-v2/model-performance-snapshot.json",
  `inference-timing-v2/model-performance-snapshot-v6-${"a".repeat(64)}.json`];
function snapshotOptions(options) {
  return { ...legacyOptions(options), sourceAclPolicy: "preserve_legacy_usage_snapshot_v1" };
}
function fixtureDescriptor(path) {
  return execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "[Console]::Write([Convert]::ToBase64String((Get-Acl -LiteralPath ([Console]::In.ReadToEnd())).GetSecurityDescriptorBinaryForm()))"],
  { input: path, encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
}
test("snapshot-only legacy policy preserves two independent logon ACEs across reopen and byte backup without transferring ACLs", gate, async t => {
  const { native, source, root, options } = await fixture(t, historicalSnapshots);
  legacyAcl(options.maintenanceParent, [source, ...required.map(name => join(source, name))]);
  for (const [index, name] of historicalSnapshots.entries()) grantSyntheticUsageLegacyAcl({ fixtureRoot: root,
    parent: join(source, name), reader: index ? OTHER_LOGON : LOGON });
  const before = historicalSnapshots.map(name => fixtureDescriptor(join(source, name))), selected = snapshotOptions(options);
  let session = await openUsageBundleFreezeQualification(selected);
  try {
    await session.freeze(); const manifest = await session.snapshot(); session.abandon();
    await assert.rejects(openUsageBundleFreezeQualification({ ...selected, sourceAclPolicy: "preserve_legacy_usage_v1", resume: true }), category("STORAGE_UNAVAILABLE"));
    session = await openUsageBundleFreezeQualification({ ...selected, resume: true }); await session.reacquire();
    assert.equal((await session.snapshot()).manifestSha256, manifest.manifestSha256);
    const target = join(root, "backup"), intent = join(root, "intent"); native.ensureDirectory(target); native.ensureDirectory(join(target, "inference-timing-v2")); native.ensureDirectory(intent);
    await session.backup({ backupRoot: target, expectedBackupIdentity: native.inspectPath(target).identity, intentRoot: intent, operationId: randomUUID(), mode: "copy" });
    for (const name of historicalSnapshots) {
      assert.deepEqual(await readFile(join(target, name)), await readFile(join(source, name)));
      const metadata = native.inspectPath(join(target, name)); assert.equal(metadata.nonOwnerAllow, false); assert.equal(metadata.daclProtected, true);
    }
    await session.restorePermissions(); await session.restorePermissions();
    assert.deepEqual(historicalSnapshots.map(name => fixtureDescriptor(join(source, name))), before);
  } finally { if (session.summary().status !== "permissions_restored") await session.restorePermissions(); session.abandon(); }
});

for (const change of ["old_policy", "reader_write", "multiple_sessions", "database_scope"]) test(`snapshot exception refuses ${change} without repairing source permissions`, gate, async t => {
  const { source, root, options } = await fixture(t, historicalSnapshots);
  legacyAcl(options.maintenanceParent, [source, ...required.map(name => join(source, name))]);
  const file = join(source, change === "database_scope" ? required[0] : historicalSnapshots[0]);
  grantSyntheticUsageLegacyAcl({ fixtureRoot: root, parent: file, reader: LOGON, rights: change === "reader_write" ? "Modify" : "ReadAndExecute" });
  if (change === "multiple_sessions") grantSyntheticUsageLegacyAcl({ fixtureRoot: root, parent: file, reader: OTHER_LOGON });
  const before = fixtureDescriptor(file);
  const session = await openUsageBundleFreezeQualification(change === "old_policy" ? legacyOptions(options) : snapshotOptions(options));
  try { await assert.rejects(session.freeze(), category("NATIVE_OR_SELECTION_REFUSED")); }
  finally { await session.restorePermissions(); session.abandon(); }
  assert.equal(fixtureDescriptor(file), before);
});

test("native snapshot entrypoint rejects databases, wrong roots and a nested directory with the same name", gate, async t => {
  const { native, source, root, options } = await fixture(t, [...historicalSnapshots,
    "inference-timing-v2/timing-experiment.sqlite", "model-performance-snapshot.json",
    "private/inference-timing-v2/model-performance-snapshot.json"]);
  legacyAcl(options.maintenanceParent, [source, ...required.map(name => join(source, name))]);
  const guard = native.acquireLegacyStateDirectoryGuard(options.maintenanceParent);
  const descriptor = native.readUsageFreezeDirectorySecurity(guard.guard); native.releaseProtectedDirectoryGuard(guard.guard);
  const identities = new Map(["", "inference-timing-v2", "private", "private/inference-timing-v2",
    "inference-timing-v2/timing-experiment.sqlite", "model-performance-snapshot.json", "private/inference-timing-v2/model-performance-snapshot.json"]
    .map(path => [join(source, path), native.inspectPath(join(source, path)).identity]));
  const leases = [], tag = Buffer.alloc(16, 17);
  const hold = object => { leases.push(object); native.applyUsageDirectoryFreeze(object.lease); return object; };
  const child = (parent, name, path) => hold(native.openUsageFreezeChildDirectory(parent.lease, name, identities.get(path)));
  try {
    const parent = hold(native.openLegacyUsageFreezeParentDirectory(options.maintenanceParent, tag, descriptor)); native.sealUsageFreezeParentDirectory(parent.lease);
    const usage = child(parent, "s", source), primary = child(usage, "inference-timing-v2", join(source, "inference-timing-v2"));
    const privateRoot = child(usage, "private", join(source, "private"));
    const nested = child(privateRoot, "inference-timing-v2", join(source, "private/inference-timing-v2"));
    for (const [directory, name, path] of [
      [primary, "timing-experiment.sqlite", "inference-timing-v2/timing-experiment.sqlite"],
      [usage, "model-performance-snapshot.json", "model-performance-snapshot.json"],
      [nested, "model-performance-snapshot.json", "private/inference-timing-v2/model-performance-snapshot.json"],
    ]) assert.throws(() => native.openUsageFreezeSnapshotFile(directory.lease, name, identities.get(join(source, path))), { code: "WINDOWS_FILESYSTEM_USAGE_FREEZE_SNAPSHOT_POLICY_SCOPE" });
  } finally {
    descriptor.fill(0);
    for (const object of leases.reverse()) { native.restoreUsageDirectoryFreeze(object.lease); native.closeUsageFreezeDirectory(object.lease); }
  }
});

test("a parent ACL change after preflight refuses before installing a freeze", gate, async t => {
  const { native, source, options } = await fixture(t); legacyAcl(options.maintenanceParent, [source, ...required.map(name => join(source, name))]);
  const session = await openUsageBundleFreezeQualification(legacyOptions(options));
  legacyAcl(options.maintenanceParent, [], { reader: "S-1-5-21-111111111-222222222-333333333-5555" });
  const before = native.inspectPath(options.maintenanceParent);
  try { await assert.rejects(session.freeze(), category("NATIVE_OR_SELECTION_REFUSED")); assert.equal(session.summary().status, "prepared"); }
  finally { await session.restorePermissions(); session.abandon(); }
  assert.deepEqual(native.inspectPath(options.maintenanceParent), before);
});

for (const change of ["reader_write", "broad_read", "reader_changed"]) test(`legacy source policy rejects ${change} without widening permissions`, gate, async t => {
  const { source, options } = await fixture(t);
  legacyAcl(options.maintenanceParent, [source, ...required.map(name => join(source, name))], change === "reader_write" ? { rights: "M" } : change === "broad_read" ? { reader: "S-1-1-0" } : {});
  if (change === "reader_changed") grantSyntheticUsageLegacyAcl({ fixtureRoot: resolve(options.maintenanceParent, ".."), parent: join(source, required[0]), reader: "S-1-5-21-111111111-222222222-333333333-5555" });
  const selected = legacyOptions(options);
  if (change !== "reader_changed") { await assert.rejects(openUsageBundleFreezeQualification(selected), category("SOURCE_POLICY_REFUSED")); return; }
  const session = await openUsageBundleFreezeQualification(selected);
  try { await assert.rejects(session.freeze(), category("NATIVE_OR_SELECTION_REFUSED")); }
  finally { await session.restorePermissions(); session.abandon(); }
});

test("cold inspection validates real core schemas under the full native barrier without writing", gate, async t => {
  const { options } = await fixture(t, [], { sqlite: true }), session = await openUsageBundleFreezeQualification(options);
  try {
    await session.freeze(); const before = await session.snapshot();
    const result = await session.inspectColdSqlite({ timingIdentity: "current" });
    assert.equal(result.summary.status, "cold_usage_sqlite_verified"); assert.equal(result.summary.databases, 2);
    assert.equal((await session.snapshot()).manifestSha256, before.manifestSha256);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(session.inspectColdSqlite({ timingIdentity: "current", signal: controller.signal }), category("CANCELLED"));
  } finally { await session.restorePermissions(); session.abandon(); }
});

test("timing inspection refuses oversized persisted fields before projecting measurement rows", gate, async t => {
  const { source, options } = await fixture(t, [], { sqlite: true });
  const store = await openTimingStore(join(source, "inference-timing-v2"), { createParser, digest, MAX_STATE_BYTES, METHOD: 2, parserVersion: 18, correlationKey: Buffer.alloc(32, 5) });
  try {
    store.db.prepare("INSERT INTO source(digest,fingerprint,cursor,snapshot,state) VALUES(zeroblob(32),'synthetic',0,printf('%.*c',?,'x'),'{}')").run(32 * 1024 ** 2 + 1);
  } finally { await store.close(); }
  const session = await openUsageBundleFreezeQualification(options);
  try {
    await session.freeze();
    await assert.rejects(session.inspectColdSqlite({ timingIdentity: "current" }), category("TIMING_STATE_TOO_LARGE"));
  } finally { await session.restorePermissions(); session.abandon(); }
});

for (const journal of ["zero-header", "hot-header", "short-header"]) test(`cold inspection explicitly reviews preserved rollback ${journal}`, gate, async t => {
  const { native, source, options } = await fixture(t, [], { sqlite: true });
  const bytes = Buffer.alloc(journal === "short-header" ? 12 : 600); if (journal === "hot-header") bytes[0] = 1;
  native.createFile(join(source, required[0] + "-journal"), bytes);
  const session = await openUsageBundleFreezeQualification(options);
  try {
    await session.freeze(); const before = await session.snapshot();
    if (journal === "zero-header") assert.equal((await session.inspectColdSqlite({ timingIdentity: "current" })).summary.databases, 2);
    else await assert.rejects(session.inspectColdSqlite({ timingIdentity: "current" }), category("DATABASE_NOT_COLD"));
    assert.equal((await session.snapshot()).manifestSha256, before.manifestSha256);
  } finally { await session.restorePermissions(); session.abandon(); }
});

for (const mismatch of [false, true]) test(`timing correlation is checked per selected source scope, mismatch=${mismatch}`, gate, async t => {
  const { source, options } = await fixture(t, [], { sqlite: true });
  for (const [scope, keyByte] of [["source-" + "a".repeat(64), 1], ["source-" + "b".repeat(64), 2]]) {
    for (const role of ["primary", "supplement"]) {
      const store = await openTimingStore(join(source, role === "primary" ? "inference-timing-v2" : "inference-timing-tool-free-v1", scope), {
        createParser: role === "primary" ? createParser : createToolFreeParser, digest, MAX_STATE_BYTES,
        METHOD: role === "primary" ? 2 : 3, parserVersion: 18, correlationKey: Buffer.alloc(32, keyByte + (mismatch && role === "supplement" ? 1 : 0)),
      });
      await store.close();
    }
  }
  const session = await openUsageBundleFreezeQualification(options);
  try {
    await session.freeze();
    if (mismatch) await assert.rejects(session.inspectColdSqlite({ timingIdentity: "current" }), category("TIMING_CORRELATION_MISMATCH"));
    else assert.equal((await session.inspectColdSqlite({ timingIdentity: "current" })).summary.databases, 6);
    await assert.rejects(session.inspectColdSqlite({ timingIdentity: "legacy" }), category("DATABASE_UNSUPPORTED"));
  } finally { await session.restorePermissions(); session.abandon(); }
});

for (const variant of ["known", "unknown-column", "unknown-table"]) test(`historical 4/5 inspection is explicit and schema-closed: ${variant}`, gate, async t => {
  const { native, source, options } = await fixture(t, [], { sqlite: true });
  const turnColumns = ["key BLOB PRIMARY KEY", "source INTEGER", "offset INTEGER", "at INTEGER", "model TEXT", "effort TEXT",
    "tokens INTEGER", "reasoning INTEGER", "duration INTEGER", "ttft INTEGER", "responses INTEGER", "covered INTEGER", "quality TEXT",
    "sample_tokens INTEGER", "sample_reasoning INTEGER", "sample_duration INTEGER", "sample_responses INTEGER", "sample_total_responses INTEGER",
    "sample_method TEXT", "turn_duration INTEGER", "speed_mode TEXT", "speed_mode_source TEXT", "api_service_tier TEXT"];
  for (const [family, version] of [["inference-timing-v2", 4], ["inference-timing-tool-free-v1", 5]]) {
    const directory = join(source, family); native.ensureDirectory(directory);
    const path = join(directory, "timing-experiment.sqlite"); native.createFile(path, Buffer.alloc(0));
    const db = new DatabaseSync(path);
    try {
      db.exec(`CREATE TABLE metadata (key BLOB NOT NULL); CREATE TABLE source (id INTEGER PRIMARY KEY,digest BLOB,fingerprint TEXT,cursor INTEGER,snapshot TEXT,state TEXT,revision INTEGER,telemetry_revision INTEGER${variant === "unknown-column" ? ",unreviewed TEXT" : ""});
        CREATE TABLE turn (${turnColumns.join(",")}); PRAGMA application_id=0x54425450; PRAGMA user_version=${version};`);
      db.prepare("INSERT INTO metadata VALUES (?)").run(Buffer.alloc(32, 17));
      if (variant === "unknown-table") db.exec("CREATE TABLE unreviewed (value TEXT)");
    } finally { db.close(); }
  }
  const session = await openUsageBundleFreezeQualification(options);
  try {
    await session.freeze(); const before = await session.snapshot();
    await assert.rejects(session.inspectColdSqlite({ timingIdentity: "legacy" }), category("DATABASE_UNSUPPORTED"));
    await assert.rejects(session.inspectColdSqlite({ timingIdentity: "current", includeHistoricalTiming: true }), category("CONFIGURATION_INVALID"));
    if (variant === "known") {
      const result = await session.inspectColdSqlite({ timingIdentity: "legacy", includeHistoricalTiming: true });
      assert.equal(result.summary.databases, 4);
      for (const entry of result.privateReport.databases.filter(row => row.timing)) {
        assert.equal(entry.timing.historicalParserVersion, "not_recorded");
        assert.equal(entry.timing.replayTable, "absent_in_verified_v4_v5_contract");
        assert.equal(Object.hasOwn(entry.tables, "parser_replay_turn"), false);
      }
    } else await assert.rejects(session.inspectColdSqlite({ timingIdentity: "legacy", includeHistoricalTiming: true }), category("DATABASE_UNSUPPORTED"));
    assert.equal((await session.snapshot()).manifestSha256, before.manifestSha256);
  } finally { await session.restorePermissions(); session.abandon(); }
});

test("native closed selection freezes exactly usage payloads and restores permissions without changing bytes", gate, async t => {
  const extra = ["private/codex-speed-baseline-v0.1.json", "work-usage-snapshot.json", "diagnostics-v0.1.log"];
  const { source, options } = await fixture(t, extra), before = new Map();
  for (const name of [...required, ...extra]) before.set(name, await readFile(join(source, name)));
  const session = await openUsageBundleFreezeQualification(options);
  try {
    await session.freeze(); assert.equal(session.summary().status, "frozen");
    const first = await session.snapshot(), second = await session.snapshot();
    assert.equal(first.manifestSha256, second.manifestSha256); assert.equal(first.summary.files, 5);
    assert.ok(!first.privateManifest.files.some(row => row.relativePath === "diagnostics-v0.1.log"));
    await assert.rejects(appendFile(join(source, required[0]), "x"));
    await appendFile(join(source, "diagnostics-v0.1.log"), "owner-unselected");
    await session.restorePermissions();
    const journalBefore = await readFile(join(options.journalRoot, "operation.json"));
    await session.restorePermissions(); assert.deepEqual(await readFile(join(options.journalRoot, "operation.json")), journalBefore);
    for (const name of [...required, ...extra].filter(name => name !== "diagnostics-v0.1.log")) assert.deepEqual(await readFile(join(source, name)), before.get(name));
  } finally { if (session.summary().status !== "permissions_restored") await session.restorePermissions(); session.abandon(); }
});

test("source controls join the same durable barrier but never enter the byte-copy payload", gate, async t => {
  const { native, source, root, options } = await fixture(t), controlsRoot = join(options.maintenanceParent, "desktop-settings");
  native.ensureDirectory(controlsRoot);
  const settings = '{"schemaVersion":"synthetic-source","refreshPaused":true,"appearance":"dark"}';
  const cadence = '{"schemaVersion":"synthetic-cadence","lastAutomaticDetailedAtMs":123,"reservationToken":null}';
  native.createFile(join(controlsRoot, "desktop-settings-v1.json"), Buffer.from(settings));
  native.createFile(join(controlsRoot, "automatic-refresh-cadence-v1.json"), Buffer.from(cadence));
  native.createFile(join(controlsRoot, "unrelated-ui.json"), Buffer.from("owner-unselected"));
  const capture = { controlsRoot, expectedIdentity: native.inspectPath(controlsRoot).identity };
  let session = await openUsageBundleFreezeQualification(options);
  try {
    await session.freeze(); const before = await session.snapshot();
    const captured = await session.captureControls(capture);
    assert.deepEqual(captured.privateSourceJson, { settingsJson: settings, cadenceJson: cadence });
    assert.equal(session.summary().controls, "frozen");
    await assert.rejects(appendFile(join(controlsRoot, "desktop-settings-v1.json"), "x"));
    await appendFile(join(controlsRoot, "unrelated-ui.json"), "owner-unselected");
    assert.equal((await session.snapshot()).manifestSha256, before.manifestSha256);
    const target = join(root, "backup"), intent = join(root, "intent"); native.ensureDirectory(target); native.ensureDirectory(intent);
    const result = await session.backup({ backupRoot: target, expectedBackupIdentity: native.inspectPath(target).identity, intentRoot: intent, operationId: randomUUID(), mode: "copy" });
    assert.equal(result.summary.files, 3); assert.ok(!result.privateManifest.files.some(row => row.relativePath.includes("desktop-settings")));
    session.abandon(); session = await openUsageBundleFreezeQualification({ ...options, resume: true });
    await session.reacquire(); assert.deepEqual(await session.captureControls(capture), captured);
  } finally { await session.restorePermissions(); session.abandon(); }
  await appendFile(join(source, required[0]), "x"); await appendFile(join(controlsRoot, "desktop-settings-v1.json"), "x");
});

test("missing control evidence leaves a recoverable partial barrier and never supplies unpaused defaults", gate, async t => {
  const { native, options } = await fixture(t), controlsRoot = join(options.maintenanceParent, "desktop-settings"); native.ensureDirectory(controlsRoot);
  const settingsFile = join(controlsRoot, "desktop-settings-v1.json"); native.createFile(settingsFile, Buffer.from('{"refreshPaused":true}'));
  const session = await openUsageBundleFreezeQualification(options);
  try {
    await session.freeze();
    await assert.rejects(session.captureControls({ controlsRoot, expectedIdentity: native.inspectPath(controlsRoot).identity }), category("CONTROL_EVIDENCE_MISSING"));
    assert.equal(session.summary().status, "acquiring"); await assert.rejects(session.snapshot(), category("LIVE_BARRIER_REQUIRED"));
  } finally { await session.restorePermissions(); session.abandon(); }
  assert.equal((await readFile(settingsFile)).toString(), '{"refreshPaused":true}');
});

test("unknown usage dependency aborts selection, leaves a durable partial barrier and restores exactly", gate, async t => {
  const { source, options } = await fixture(t, ["unknown-usage-archive.bin"]), session = await openUsageBundleFreezeQualification(options);
  try {
    await assert.rejects(session.freeze(), category("SELECTION_BLOCKED"));
    assert.equal(session.summary().status, "acquiring");
    await session.restorePermissions();
    await appendFile(join(source, "unknown-usage-archive.bin"), "x");
  } finally { if (session.summary().status !== "permissions_restored") await session.restorePermissions(); session.abandon(); }
});

test("source-root mismatch and nested journal refuse before source ACL mutation", gate, async t => {
  const { native, source, options } = await fixture(t);
  const before = native.openUsageFreezeDirectory(source, Buffer.alloc(16, 3));
  const original = Buffer.from(before.originalSecurity); native.closeUsageFreezeDirectory(before.lease);
  await assert.rejects(openUsageBundleFreezeQualification({ ...options, expectedSourceIdentity: { ...options.expectedSourceIdentity, fileId: "f".repeat(32) } }), category("ROOT_COLLISION_OR_IDENTITY"));
  await assert.rejects(openUsageBundleFreezeQualification({ ...options, journalRoot: join(source, "inside") }), category("ROOT_COLLISION"));
  const after = native.openUsageFreezeDirectory(source, Buffer.alloc(16, 3));
  try { assert.deepEqual(after.originalSecurity, original); } finally { native.closeUsageFreezeDirectory(after.lease); }
  await appendFile(join(source, required[0]), "x");
});

test("native selected backup uses a durable intent, exact bytes and no automatic retry", gate, async t => {
  const { native, root, source, options } = await fixture(t, ["private/codex-speed-baseline-v0.1.json", "diagnostics-v0.1.log"]);
  const target = join(root, "backup"), intent = join(root, "backup-intent");
  native.ensureDirectory(target); native.ensureDirectory(join(target, "private")); native.ensureDirectory(intent);
  const request = { backupRoot: target, expectedBackupIdentity: native.inspectPath(target).identity,
    intentRoot: intent, operationId: randomUUID(), mode: "copy" };
  const session = await openUsageBundleFreezeQualification(options);
  try {
    await session.freeze(); const original = await session.snapshot();
    const result = await session.backup(request);
    assert.equal(result.summary.status, "selected_bytes_verified"); assert.equal(result.manifestSha256, original.manifestSha256);
    await assert.rejects(readFile(join(target, "diagnostics-v0.1.log")), { code: "ENOENT" });
    const journal = await readFile(join(intent, "operation.json"));
    await assert.rejects(session.backup(request), category("BACKUP_REFUSED"));
    const reconciled = await session.backup({ ...request, mode: "reconcile" });
    assert.equal(reconciled.manifestSha256, original.manifestSha256);
    assert.deepEqual(await readFile(join(intent, "operation.json")), journal);
    assert.equal((await session.snapshot()).manifestSha256, original.manifestSha256);
  } finally { await session.restorePermissions(); session.abandon(); }
  for (const row of required) assert.deepEqual(await readFile(join(source, row)), await readFile(join(target, row)));
});

test("backup refuses occupied targets, wrong identities and nested roots without overwriting", gate, async t => {
  const { native, root, options } = await fixture(t), target = join(root, "backup"), intent = join(root, "intent");
  native.ensureDirectory(target); native.ensureDirectory(intent);
  const occupied = join(target, required[0]); native.createFile(occupied, Buffer.from("owner-draft"));
  const request = { backupRoot: target, expectedBackupIdentity: native.inspectPath(target).identity,
    intentRoot: intent, operationId: randomUUID(), mode: "copy" };
  const session = await openUsageBundleFreezeQualification(options);
  try {
    await session.freeze();
    await assert.rejects(session.backup({ ...request, intentRoot: join(target, "nested") }), category("ROOT_COLLISION"));
    await assert.rejects(session.backup({ ...request, expectedBackupIdentity: { ...request.expectedBackupIdentity, fileId: "e".repeat(32) } }), category("ROOT_COLLISION_OR_IDENTITY"));
    await assert.rejects(session.backup(request), category("BACKUP_BYTES_MISMATCH"));
    assert.equal((await readFile(occupied)).toString(), "owner-draft");
  } finally { await session.restorePermissions(); session.abandon(); }
});

test("cancellation of backup preserves an interrupted intent and reconcile never fills missing files", gate, async t => {
  const { native, root, options } = await fixture(t), target = join(root, "backup"), intent = join(root, "intent");
  native.ensureDirectory(target); native.ensureDirectory(intent);
  const request = { backupRoot: target, expectedBackupIdentity: native.inspectPath(target).identity,
    intentRoot: intent, operationId: randomUUID(), mode: "copy" };
  const session = await openUsageBundleFreezeQualification(options), controller = new AbortController();
  let timer;
  try {
    await session.freeze();
    timer = setInterval(() => {
      try { if (readFileSync(join(intent, "operation.json"), "utf8").includes("intent_durable")) controller.abort(); } catch { /* not yet durable */ }
    }, 1);
    await assert.rejects(session.backup({ ...request, signal: controller.signal }), category("CANCELLED"));
    clearInterval(timer);
    const result = await session.backup({ ...request, mode: "reconcile" });
    assert.ok(["interrupted_backup_preserved", "selected_bytes_verified"].includes(result.summary.status));
    const again = await session.backup({ ...request, mode: "reconcile" });
    assert.equal(again.manifestSha256, result.manifestSha256); assert.equal(again.summary.files, result.summary.files);
  } finally { clearInterval(timer); await session.restorePermissions(); session.abandon(); }
});

test("pre-cancel and cancellation after intent persistence never guess a missing completion", gate, async t => {
  const { source, options } = await fixture(t), session = await openUsageBundleFreezeQualification(options);
  const before = new AbortController(); before.abort();
  await assert.rejects(session.freeze({ signal: before.signal }), category("CANCELLED"));
  assert.equal(session.summary().status, "prepared");
  const during = new AbortController(), pending = session.freeze({ signal: during.signal }); during.abort();
  await assert.rejects(pending, category("CANCELLED"));
  try { await session.restorePermissions(); await appendFile(join(source, required[0]), "x"); }
  finally { session.abandon(); }
});

test("a reopened frozen operation reacquires handles and checks actual ACLs before reading bytes", gate, async t => {
  const { source, options } = await fixture(t, ["private/codex-speed-baseline-v0.1.json"]);
  const first = await openUsageBundleFreezeQualification(options); await first.freeze(); const manifest = await first.snapshot(); first.abandon();
  await assert.rejects(appendFile(join(source, required[0]), "x"));
  const resumed = await openUsageBundleFreezeQualification({ ...options, resume: true });
  try {
    await assert.rejects(resumed.snapshot(), category("LIVE_BARRIER_REQUIRED"));
    await resumed.reacquire(); assert.equal((await resumed.snapshot()).manifestSha256, manifest.manifestSha256);
    await resumed.restorePermissions();
  } finally { if (resumed.summary().status !== "permissions_restored") await resumed.restorePermissions(); resumed.abandon(); }
});

for (const legacy of [false, true]) test(`owned process death preserves the full selected barrier until exact recovery; legacy=${legacy}`, gate, async t => {
  const value = await fixture(t), { source } = value;
  let options = value.options;
  if (legacy) { legacyAcl(options.maintenanceParent, [source, ...required.map(name => join(source, name))]); options = legacyOptions(options); }
  const moduleUrl = pathToFileURL(resolve("scripts/lib/usage-bundle-freeze.mjs")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {loadUsageFreezeQualificationAdapter,openUsageBundleFreezeQualification} from ${JSON.stringify(moduleUrl)};
    let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>input+=part);
    process.stdin.on('end',async()=>{try{
      const adapter=await loadUsageFreezeQualificationAdapter();
      const session=await openUsageBundleFreezeQualification({...JSON.parse(input),adapter});
      await session.freeze();process.stdout.write('frozen');setInterval(()=>{},1000);
    }catch{process.exit(2)}});
  `], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const { adapter: _adapter, ...serializable } = options; child.stdin.end(JSON.stringify(serializable));
  let timer;
  try {
    const result = await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("synthetic_child_exited"); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("synthetic_child_timeout")), 20000); })]);
    assert.equal(result[0].toString(), "frozen");
  } finally { clearTimeout(timer); child.kill(); await once(child, "close"); }
  await assert.rejects(appendFile(join(source, required[0]), "x"));
  await assert.rejects((await import("node:fs/promises")).rename(source, join(options.maintenanceParent, "moved")));
  const recovered = await openUsageBundleFreezeQualification({ ...options, resume: true });
  try { await recovered.reacquire(); assert.equal((await recovered.snapshot()).summary.files, 3); await recovered.restorePermissions(); }
  finally { recovered.abandon(); }
  await appendFile(join(source, required[0]), "x");
});

test("persistent SQLite close failure pins native objects through GC and permits recovery only in a fresh process", gate, async t => {
  const { source, options } = await fixture(t, [], { sqlite: true });
  const moduleUrl = pathToFileURL(resolve("scripts/lib/usage-bundle-freeze.mjs")).href;
  const { adapter: _adapter, ...serializable } = options;
  const child = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    import{DatabaseSync}from'node:sqlite';import{readFileSync,appendFileSync}from'node:fs';import{join}from'node:path';
    import{loadUsageFreezeQualificationAdapter,openUsageBundleFreezeQualification,classifyUsageBundleFreezeFailure}from ${JSON.stringify(moduleUrl)};
    const options=JSON.parse(readFileSync(0,'utf8')),adapter=await loadUsageFreezeQualificationAdapter();
    const session=await openUsageBundleFreezeQualification({...options,adapter});await session.freeze();
    DatabaseSync.prototype.close=function(){throw new Error('synthetic_close_failure')};
    const result={};try{await session.inspectColdSqlite({timingIdentity:'current'})}catch(error){result.inspect=classifyUsageBundleFreezeFailure(error)}
    try{await session.restorePermissions()}catch(error){result.restore=classifyUsageBundleFreezeFailure(error)}
    try{session.abandon()}catch(error){result.abandon=classifyUsageBundleFreezeFailure(error)}
    global.gc();try{appendFileSync(join(options.sourceRoot,'local-index-store-v1.sqlite'),'x');result.write='allowed'}catch{result.write='refused'}
    process.stdout.write(JSON.stringify(result));process.exit(0);
  `], { input: JSON.stringify(serializable), encoding: "utf8", windowsHide: true, timeout: 20000 });
  assert.equal(child.status, 0, `synthetic_close_failure_child_unavailable:${child.stderr?.match(/USAGE_BUNDLE_FREEZE_[A-Z_]+/u)?.[0] ?? "unknown"}`);
  assert.deepEqual(JSON.parse(child.stdout), { inspect: "USAGE_BUNDLE_FREEZE_SQLITE_CLOSE_FAILED", restore: "USAGE_BUNDLE_FREEZE_SQLITE_CLOSE_FAILED",
    abandon: "USAGE_BUNDLE_FREEZE_SQLITE_CLOSE_FAILED", write: "refused" });
  const recovered = await openUsageBundleFreezeQualification({ ...options, resume: true });
  try { await recovered.reacquire(); assert.equal((await recovered.inspectColdSqlite({ timingIdentity: "current" })).summary.databases, 2); await recovered.restorePermissions(); }
  finally { recovered.abandon(); }
  await appendFile(join(source, required[0]), "x");
});
