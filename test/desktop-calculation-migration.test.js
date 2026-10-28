import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DESKTOP_DEFAULT_SETTINGS } from "../apps/electron/desktop-contract.js";
import { convertDesktopSettingsV5, preserveDesktopAccountingCacheV025, convertDesktopCalculationCopy } from "../scripts/lib/desktop-calculation-migration.mjs";
import { parseDesktopCalculationMigrationArguments } from "../scripts/migrate-desktop-calculation-copy.mjs";
import { projectPreservedAccountingHistorySummary, validatePreservedAccountingHistoryEnvelope } from "../src/local-accounting-preserved-history.js";
import { readLocalCollectorPreservedAccountingHistory, writeLocalCollectorAccountingCache } from "../src/local-collector-state.js";
import { loadWindowsLegacyStateReadBinding } from "../src/platform/index.js";

// Generated from HEAD e46b545f's actual v0.25 builder/validator using one
// content-free synthetic event and the resident calibration test seam.
const cacheJson = await readFile(new URL("./fixtures/desktop-accounting-v025.json", import.meta.url), "utf8");
const cache = JSON.parse(cacheJson);
const hash = value => createHash("sha256").update(value).digest("hex");
const failure = code => e => e.code === `DESKTOP_CALCULATION_MIGRATION_${code}`;
const nativeSkip = process.platform === "win32" && process.arch === "x64" ? false : "physical Windows x64 only";
function oldSettings() {
  const result = structuredClone(DESKTOP_DEFAULT_SETTINGS);
  delete result.unknownSpeedPolicy;
  result.schemaVersion = "usagemonitor-desktop-settings-v5";
  result.refreshPaused = true;
  return result;
}

test("v5 settings convert once with all existing values and pause preserved", () => {
  const input = oldSettings(), original = structuredClone(input);
  const converted = convertDesktopSettingsV5(input);
  assert.deepEqual(input, original);
  assert.equal(converted.schemaVersion, "usagemonitor-desktop-settings-v6");
  assert.deepEqual(converted.unknownSpeedPolicy, { mode: "standard", customFastRatioBps: null });
  const restored = { ...converted, schemaVersion: original.schemaVersion }; delete restored.unknownSpeedPolicy;
  assert.deepEqual(restored, original);
  assert.throws(() => convertDesktopSettingsV5(converted), failure("SETTINGS_VERSION"));
  assert.throws(() => convertDesktopSettingsV5({ ...input, unexpected: true }), failure("SETTINGS_INVALID"));
  assert.throws(() => convertDesktopSettingsV5({ ...input, schemaVersion: "usagemonitor-desktop-settings-v4" }), failure("SETTINGS_VERSION"));
});

test("actual v0.25 synthetic cache preserves exact original JSON and historical figures", () => {
  const envelope = preserveDesktopAccountingCacheV025(cacheJson);
  assert.equal(envelope.sourceCacheJson, cacheJson);
  assert.equal(envelope.sourceJsonSha256, hash(cacheJson));
  assert.deepEqual(envelope.summary.history, cache.history);
  assert.deepEqual(envelope.summary.periods, cache.periods);
  assert.deepEqual(envelope.summary.timeline, cache.timeline);
  const summary = projectPreservedAccountingHistorySummary(envelope);
  assert.equal(summary.status, "historical_only");
  assert.equal(summary.generatedAt, cache.generatedAt);
  assert.equal(summary.unknownSpeedPolicy, null);
  assert.equal(summary.history.totals.events, 1);
  assert.equal(summary.history.totals.label, cache.history.period.label);
  assert.equal(summary.periods.length, cache.periods.length);
  assert.equal(Object.hasOwn(summary, "sourceCacheJson"), false);
  assert.equal(Object.hasOwn(summary, "sourceDescriptor"), false);
});

test("one-time cache admission refuses unknown versions, fields, malformed evidence and altered payload", () => {
  assert.throws(() => preserveDesktopAccountingCacheV025("{"), failure("CACHE_INVALID"));
  assert.throws(() => preserveDesktopAccountingCacheV025(JSON.stringify({ ...cache, schemaVersion: "local-replay-safe-accounting-v0.26" })), failure("CACHE_VERSION"));
  assert.throws(() => preserveDesktopAccountingCacheV025(JSON.stringify({ ...cache, prompt: "synthetic-forbidden" })), failure("CACHE_SHAPE"));
  assert.throws(() => preserveDesktopAccountingCacheV025(JSON.stringify({ ...cache, coveredAt: { startAt: "invalid", endAt: cache.coveredAt.endAt } })), failure("CACHE_INVALID"));
  const envelope = preserveDesktopAccountingCacheV025(cacheJson);
  assert.throws(() => validatePreservedAccountingHistoryEnvelope({ ...envelope, sourceCacheJson: cacheJson + " " }), { code: "preserved_accounting_history_invalid" });
  assert.throws(() => validatePreservedAccountingHistoryEnvelope({ ...envelope, rawThread: "synthetic" }), { code: "preserved_accounting_history_invalid" });
});

test("copy arguments are explicit and unique with no discovery or default paths", () => {
  assert.throws(() => parseDesktopCalculationMigrationArguments([]));
  assert.throws(() => parseDesktopCalculationMigrationArguments(["--source-state-directory", "x", "--source-state-directory", "y"]));
  assert.throws(() => parseDesktopCalculationMigrationArguments(["--activate", "yes"]));
});

async function fixture({ cachePresent = true, lock = false, hot = false } = {}) {
  const native = loadWindowsLegacyStateReadBinding();
  const root = join(tmpdir(), `desktop-calculation-copy-${randomUUID()}`);
  native.ensureDirectory(root);
  const options = Object.fromEntries(["sourceStateDirectory", "targetStateDirectory", "sourceSettingsDirectory", "targetSettingsDirectory"]
    .map(key => [key, join(root, key)]));
  for (const value of Object.values(options)) native.ensureDirectory(value);
  const settingsPath = join(options.sourceSettingsDirectory, "desktop-settings-v1.json");
  const settingsBytes = Buffer.from(JSON.stringify(oldSettings())); native.createFile(settingsPath, settingsBytes);
  const statePath = join(options.sourceStateDirectory, "local-collector-state-v1.sqlite");
  native.createFile(statePath, Buffer.alloc(0));
  const d = new DatabaseSync(statePath);
  try {
    d.exec(`PRAGMA application_id=0x554d4353; PRAGMA user_version=1;
      CREATE TABLE meta(key TEXT PRIMARY KEY,value_json TEXT NOT NULL) STRICT;
      CREATE TABLE records(record_id INTEGER PRIMARY KEY,event_key TEXT,record_digest TEXT NOT NULL,kind TEXT NOT NULL,
        observed_at TEXT,observed_at_ms INTEGER,record_json TEXT NOT NULL,inserted_at TEXT NOT NULL) STRICT;
      CREATE TABLE instance_locks(name TEXT PRIMARY KEY,pid INTEGER NOT NULL,acquired_at TEXT NOT NULL) STRICT;`);
    const put = d.prepare("INSERT INTO meta VALUES(?,?)");
    put.run("schema_version", JSON.stringify("local-collector-state-v1"));
    put.run("checkpoint", JSON.stringify({ files: {}, collectionStartedAt: "2026-07-01T00:00:00Z", sourceAbsent: true }));
    put.run("legacy_refresh_use", JSON.stringify({ used: 7 }));
    if (cachePresent) put.run("accounting_cache", cacheJson);
    d.prepare("INSERT INTO records VALUES(1,?,?,?,?,?,?,?)").run("synthetic-event", "a".repeat(64), "codex_quota_snapshot",
      "2026-07-26T12:00:00.000Z", 1785067200000, '{"synthetic":true,"sourceAbsent":true}', "2026-07-26T12:00:01.000Z");
    if (lock) d.prepare("INSERT INTO instance_locks VALUES('synthetic',123,'2026-07-26T12:00:00Z')").run();
  } finally { d.close(); }
  if (hot) native.createFile(statePath + "-wal", Buffer.alloc(1));
  return { native, options, root, statePath, settingsPath, originalState: await readFile(statePath), settingsBytes };
}

test("physical cold copy preserves missing-source history, collector facts and source bytes", { skip: nativeSkip }, async () => {
  const f = await fixture();
  const result = await convertDesktopCalculationCopy(f.options);
  assert.equal(result.status, "converted"); assert.equal(result.preservedHistory, true);
  assert.deepEqual(await readFile(f.statePath), f.originalState);
  assert.deepEqual(await readFile(f.settingsPath), f.settingsBytes);
  const target = join(f.options.targetStateDirectory, "local-collector-state-v1.sqlite");
  const d = new DatabaseSync(target, { readOnly: true });
  try {
    assert.equal(d.prepare("SELECT COUNT(*) AS n FROM records").get().n, 1);
    assert.equal(d.prepare("SELECT value_json FROM meta WHERE key='checkpoint'").get().value_json.includes('"sourceAbsent":true'), true);
    assert.equal(d.prepare("SELECT 1 FROM meta WHERE key='accounting_cache'").get(), undefined);
    assert.equal(JSON.parse(d.prepare("SELECT value_json FROM meta WHERE key='accounting_cache_history_v1'").get().value_json).sourceCacheJson, cacheJson);
  } finally { d.close(); }
  const historical = await readLocalCollectorPreservedAccountingHistory({ stateFile: target });
  assert.equal(historical.history.totals.events, 1);
  assert.equal(historical.generatedAt, cache.generatedAt);
  assert.equal((await convertDesktopCalculationCopy(f.options)).status, "already_complete");
  await writeLocalCollectorAccountingCache({ stateFile: target,
    cache: { schemaVersion: "local-replay-safe-accounting-v0.26", synthetic: true } });
  assert.deepEqual(await readLocalCollectorPreservedAccountingHistory({ stateFile: target }), historical,
    "a subsequent current-cache publication cannot overwrite preserved history");
});

test("physical copy refuses hot/locked sources and target collisions without clearing them", { skip: nativeSkip }, async () => {
  for (const [config, code] of [[{ hot: true }, "SOURCE_NOT_COLD"], [{ lock: true }, "WRITER_ACTIVE"]]) {
    const f = await fixture(config);
    await assert.rejects(convertDesktopCalculationCopy(f.options), failure(code));
    assert.deepEqual(await readFile(f.statePath), f.originalState);
    assert.deepEqual(await readdir(f.options.targetStateDirectory), []);
  }
  const f = await fixture();
  f.native.createFile(join(f.options.targetStateDirectory, "unrelated"), Buffer.from("synthetic"));
  await assert.rejects(convertDesktopCalculationCopy(f.options), failure("TARGET_NOT_EMPTY"));
  assert.equal((await readFile(join(f.options.targetStateDirectory, "unrelated"))).toString(), "synthetic");
});

test("physical copy with no old cache retains facts without inventing history", { skip: nativeSkip }, async () => {
  const f = await fixture({ cachePresent: false });
  assert.equal((await convertDesktopCalculationCopy(f.options)).preservedHistory, false);
  assert.equal(await readLocalCollectorPreservedAccountingHistory({ stateFile: join(f.options.targetStateDirectory, "local-collector-state-v1.sqlite") }), null);
});

test("normal cache publication refuses a different version before touching the original database", { skip: nativeSkip }, async () => {
  const f = await fixture();
  await assert.rejects(writeLocalCollectorAccountingCache({ stateFile: f.statePath,
    cache: { schemaVersion: "local-replay-safe-accounting-v0.26", synthetic: true } }),
  { code: "local_collector_accounting_migration_required" });
  assert.deepEqual(await readFile(f.statePath), f.originalState);
  const d = new DatabaseSync(f.statePath);
  try { d.prepare("UPDATE meta SET value_json=? WHERE key='accounting_cache'").run('{"schemaVersion":"future-v999","synthetic":true}'); }
  finally { d.close(); }
  const before = await readFile(f.statePath);
  await assert.rejects(writeLocalCollectorAccountingCache({ stateFile: f.statePath,
    cache: { schemaVersion: "local-replay-safe-accounting-v0.26", synthetic: true } }),
  { code: "local_collector_accounting_migration_required" });
  assert.deepEqual(await readFile(f.statePath), before);
});

test("an incomplete target is preserved and refused rather than recovered or overwritten", { skip: nativeSkip }, async () => {
  const f = await fixture();
  f.native.createFile(join(f.options.targetStateDirectory, "desktop-calculation-copy-operation-v1.json"), Buffer.from('{"status":"incomplete"}'));
  await assert.rejects(convertDesktopCalculationCopy(f.options), failure("TARGET_INCOMPLETE_OR_DIFFERENT"));
  assert.equal((await readFile(join(f.options.targetStateDirectory, "desktop-calculation-copy-operation-v1.json"))).toString(), '{"status":"incomplete"}');
  assert.deepEqual(await readFile(f.statePath), f.originalState);
});

test("physical conversion refuses unsupported collector schema and cache version without publishing", { skip: nativeSkip }, async () => {
  for (const [sql, code] of [
    ["PRAGMA user_version=99", "COLLECTOR_VERSION"],
    ["UPDATE meta SET value_json='{\"schemaVersion\":\"future-v999\"}' WHERE key='accounting_cache'", "CACHE_VERSION"],
    ["CREATE TRIGGER unexpected AFTER DELETE ON meta BEGIN DELETE FROM records; END", "COLLECTOR_SCHEMA"],
  ]) {
    const f = await fixture(); const d = new DatabaseSync(f.statePath);
    try { d.exec(sql); } finally { d.close(); }
    const before = await readFile(f.statePath);
    await assert.rejects(convertDesktopCalculationCopy(f.options), failure(code));
    assert.deepEqual(await readFile(f.statePath), before);
    assert.deepEqual(await readdir(f.options.targetStateDirectory), []);
  }
});

test("cold WAL cache-version refusal creates no sidecars and leaves main bytes unchanged", { skip: nativeSkip }, async () => {
  for (const schemaVersion of ["local-replay-safe-accounting-v0.25", "future-v999"]) {
    const f = await fixture(); const d = new DatabaseSync(f.statePath);
    try {
      d.prepare("PRAGMA journal_mode=WAL").get();
      d.prepare("UPDATE meta SET value_json=? WHERE key='accounting_cache'")
        .run(JSON.stringify({ schemaVersion, synthetic: true }));
    } finally { d.close(); }
    const before = await readFile(f.statePath), files = (await readdir(f.options.sourceStateDirectory)).sort();
    assert.equal(before[18], 2); assert.equal(before[19], 2);
    assert.deepEqual(files, ["local-collector-state-v1.sqlite"]);
    await assert.rejects(writeLocalCollectorAccountingCache({ stateFile: f.statePath,
      cache: { schemaVersion: "local-replay-safe-accounting-v0.26", synthetic: true } }),
    { code: "local_collector_accounting_migration_required" });
    assert.deepEqual(await readFile(f.statePath), before);
    assert.deepEqual((await readdir(f.options.sourceStateDirectory)).sort(), files);
  }
});

test("cold WAL preserved-history reader creates no sidecars on success or family rejection", { skip: nativeSkip }, async () => {
  const f = await fixture({ cachePresent: false }), d = new DatabaseSync(f.statePath);
  try {
    d.prepare("PRAGMA journal_mode=WAL").get();
    d.prepare("INSERT INTO meta VALUES('accounting_cache_history_v1',?)")
      .run(JSON.stringify(preserveDesktopAccountingCacheV025(cacheJson)));
  } finally { d.close(); }
  const before = await readFile(f.statePath), files = (await readdir(f.options.sourceStateDirectory)).sort();
  assert.equal(before[18], 2); assert.deepEqual(files, ["local-collector-state-v1.sqlite"]);
  const summary = await readLocalCollectorPreservedAccountingHistory({ stateFile: f.statePath });
  assert.equal(summary.history.totals.events, 1);
  assert.deepEqual(await readFile(f.statePath), before);
  assert.deepEqual((await readdir(f.options.sourceStateDirectory)).sort(), files);
  const foreign = new DatabaseSync(f.statePath);
  try { foreign.exec("PRAGMA application_id=1"); } finally { foreign.close(); }
  const invalid = await readFile(f.statePath);
  await assert.rejects(readLocalCollectorPreservedAccountingHistory({ stateFile: f.statePath }),
    { code: "local_collector_state_schema_invalid" });
  assert.deepEqual(await readFile(f.statePath), invalid);
  assert.deepEqual((await readdir(f.options.sourceStateDirectory)).sort(), files);
});
