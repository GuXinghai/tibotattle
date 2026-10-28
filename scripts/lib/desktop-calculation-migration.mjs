import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { validateDesktopSettingsSnapshot } from "../../apps/electron/desktop-contract.js";
import {
  acquireProtectedSqliteFiles, configureGuardedSqliteConnection, loadWindowsLegacyStateReadBinding,
} from "../../src/platform/index.js";
import {
  PRESERVED_ACCOUNTING_HISTORY_META_KEY, PRESERVED_ACCOUNTING_HISTORY_SCHEMA,
  validatePreservedAccountingHistoryEnvelope,
} from "../../src/local-accounting-preserved-history.js";

const SETTINGS = "desktop-settings-v1.json", STATE = "local-collector-state-v1.sqlite";
const RECEIPT = "desktop-calculation-copy-operation-v1.json";
const OLD_CACHE = "local-replay-safe-accounting-v0.25";
const MAX_CACHE = 64 * 1024 * 1024, MAX_STATE = 1024 ** 3;
// A SQLite close failure must not release the native identity/writer guards
// while the connection may still be live. Keep them pinned until process exit.
const retainedOnCloseFailure = new Set();
const SUMMARY_KEYS = ["generatedAt", "coveredAt", "sourceDescriptor", "history", "periods", "timeline", "quotaTimeline",
  "sparkUsageTimeline", "sparkQuotaTimeline", "priceBasis", "pricingMethodVersion", "priceEpochBasis", "priceRegistryVersion", "priceRegistryObservedAt"];
const CACHE_KEYS = ["schemaVersion", "generatedAt", "coveredAt", "bucketMinutes", "accountingMethod", "priceBasis",
  "pricingMethodVersion", "priceEpochBasis", "priceRegistryVersion", "priceRegistryObservedAt", "sourceDescriptor",
  "history", "periods", "timeline", "planScopedTimeline", "historicalPlanComparisons", "weeklyApiIntervals",
  "sparkUsageTimeline", "quotaTimeline", "sparkQuotaTimeline", "weeklyCalibration", "allowanceCapacityByScenario",
  "fiveHourAllowanceCalibration", "weeklyCalibrationInput", "diagnostics"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const missing = e => ["ENOENT", "WINDOWS_FILESYSTEM_NOT_FOUND"].includes(e?.code);
const fail = code => { throw Object.assign(new Error("Desktop calculation migration refused"), { code: `DESKTOP_CALCULATION_MIGRATION_${code}` }); };

export function convertDesktopSettingsV5(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== "usagemonitor-desktop-settings-v5"
      || Object.hasOwn(value, "unknownSpeedPolicy")) fail("SETTINGS_VERSION");
  try {
    return validateDesktopSettingsSnapshot({ ...value, schemaVersion: "usagemonitor-desktop-settings-v6",
      unknownSpeedPolicy: { mode: "standard", customFastRatioBps: null } });
  } catch { fail("SETTINGS_INVALID"); }
}

export function preserveDesktopAccountingCacheV025(sourceCacheJson) {
  if (typeof sourceCacheJson !== "string" || Buffer.byteLength(sourceCacheJson) > MAX_CACHE) fail("CACHE_SIZE");
  let cache;
  try { cache = JSON.parse(sourceCacheJson); } catch { fail("CACHE_INVALID"); }
  if (!cache || cache.schemaVersion !== OLD_CACHE) fail("CACHE_VERSION");
  if (Object.keys(cache).some(key => ![...CACHE_KEYS, "weekly"].includes(key))
      || CACHE_KEYS.some(key => !Object.hasOwn(cache, key))) fail("CACHE_SHAPE");
  const value = {
    schemaVersion: PRESERVED_ACCOUNTING_HISTORY_SCHEMA, status: "historical_only",
    sourceSchemaVersion: OLD_CACHE, sourceJsonSha256: sha(sourceCacheJson), sourceCacheJson,
    summary: Object.fromEntries(SUMMARY_KEYS.map(key => [key, structuredClone(cache[key])])),
  };
  try { validatePreservedAccountingHistoryEnvelope(value); } catch { fail("CACHE_INVALID"); }
  return value;
}

function path(value) {
  if (typeof value !== "string" || value.length > 4096 || !/^[a-z]:[\\/]/iu.test(value)
      || /[\u0000-\u001f]/u.test(value) || value.replaceAll("/", "\\").slice(3).split("\\")
        .some(p => !p || p === "." || p === ".." || /[<>:"|?*]|[. ]$/u.test(p))) fail("PATH_INVALID");
  return win32.resolve(value);
}

function readLease(native, lease, maximum) {
  const st = native.statSourceFile(lease);
  if (!Number.isSafeInteger(st.size) || st.size < 1 || st.size > maximum) fail("SIZE");
  const parts = [];
  for (let at = 0; at < st.size; at += 65536) {
    const bytes = native.readSourceFile(lease, at, Math.min(65536, st.size - at));
    if (!Buffer.isBuffer(bytes) || bytes.length !== Math.min(65536, st.size - at)) fail("READ");
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

function leaseHash(native, lease, maximum = MAX_STATE) {
  const st = native.statSourceFile(lease), hash = createHash("sha256");
  if (!Number.isSafeInteger(st.size) || st.size < 1 || st.size > maximum) fail("SIZE");
  for (let at = 0; at < st.size; at += 65536) {
    const n = Math.min(65536, st.size - at), bytes = native.readSourceFile(lease, at, n);
    if (!Buffer.isBuffer(bytes) || bytes.length !== n) fail("READ");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

// Closed table/column admission prevents triggers or unexpected writable schema
// objects from turning a copied metadata update into a wider mutation.
function inspectCollector(database) {
  if (database.prepare("PRAGMA application_id").get().application_id !== 0x554d4353
      || database.prepare("PRAGMA user_version").get().user_version !== 1
      || database.prepare("SELECT value_json FROM meta WHERE key='schema_version'").get()?.value_json
        !== JSON.stringify("local-collector-state-v1")) fail("COLLECTOR_VERSION");
  const tables = { meta: ["key", "value_json"], records: ["record_id", "event_key", "record_digest", "kind", "observed_at",
    "observed_at_ms", "record_json", "inserted_at"], instance_locks: ["name", "pid", "acquired_at"] };
  const objects = database.prepare("SELECT type,name,tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  if (objects.some(o => !["table", "index"].includes(o.type) || !Object.hasOwn(tables, o.tbl_name))
      || objects.filter(o => o.type === "table").length !== 3) fail("COLLECTOR_SCHEMA");
  for (const [name, columns] of Object.entries(tables)) {
    const info = database.prepare(`PRAGMA table_info(${name})`).all();
    if (info.map(x => x.name).join() !== columns.join()) fail("COLLECTOR_SCHEMA");
  }
  if (database.prepare("SELECT 1 FROM instance_locks LIMIT 1").get()) fail("WRITER_ACTIVE");
  if (database.prepare("PRAGMA quick_check").get().quick_check !== "ok") fail("COLLECTOR_INTEGRITY");
}

function factsDigest(database) {
  const hash = createHash("sha256"); let rows = 0;
  for (const sql of ["SELECT * FROM records ORDER BY record_id", "SELECT * FROM instance_locks ORDER BY name",
    "SELECT * FROM meta WHERE key NOT IN ('accounting_cache','accounting_cache_history_v1') ORDER BY key"]) {
    hash.update(sql);
    const stmt = database.prepare(sql); stmt.setReadBigInts(true);
    for (const row of stmt.iterate()) {
      if (++rows > 2_000_000) fail("ROW_BOUND");
      hash.update(JSON.stringify(Object.values(row).map(v => [v === null ? "null" : typeof v,
        typeof v === "bigint" ? v.toString() : v])) + "\n");
    }
  }
  return { rows, sha256: hash.digest("hex") };
}

/** Cold copy-only conversion. No defaults, discovery, activation, rollback,
 * source writes, credential calls or automatic checkpoint/recovery. */
export async function convertDesktopCalculationCopy(options) {
  if (!options || Object.keys(options).sort().join() !== "sourceSettingsDirectory,sourceStateDirectory,targetSettingsDirectory,targetStateDirectory") fail("CONFIGURATION");
  const paths = Object.fromEntries(Object.entries(options).map(([k, v]) => [k, path(v)]));
  const roots = Object.values(paths);
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    const r = win32.relative(roots[i], roots[j]), reverse = win32.relative(roots[j], roots[i]);
    const outside = value => win32.isAbsolute(value) || value === ".." || value.startsWith("..\\");
    if (!outside(r) || !outside(reverse)) fail("ROOT_COLLISION");
  }
  const native = loadWindowsLegacyStateReadBinding(), held = [], guards = [];
  let sourceDb, targetDb, sqliteLease;
  try {
    for (const key of ["sourceStateDirectory", "sourceSettingsDirectory"]) {
      const g = native.acquireLegacyStateDirectoryGuard(paths[key]); guards.push(g.guard);
    }
    const targetState = native.acquireProtectedDirectoryGuard(paths.targetStateDirectory); guards.push(targetState.guard);
    const targetSettings = native.acquireProtectedDirectoryGuard(paths.targetSettingsDirectory); guards.push(targetSettings.guard);
    const hold = acquire => { const result = acquire(); guards.push(result.guard); return result; };
    const sourceProtected = [hold(() => native.acquireProtectedDirectoryGuard(paths.sourceStateDirectory)),
      hold(() => native.acquireProtectedDirectoryGuard(paths.sourceSettingsDirectory))];
    const targetLegacy = [hold(() => native.acquireLegacyStateDirectoryGuard(paths.targetStateDirectory)),
      hold(() => native.acquireLegacyStateDirectoryGuard(paths.targetSettingsDirectory))];
    const legacyRoots = [guards[0], guards[1], ...targetLegacy.map(x => x.guard)];
    const protectedRoots = [...sourceProtected.map(x => x.guard), targetState.guard, targetSettings.guard];
    for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
      if (!native.legacyStateRootsDisjoint(legacyRoots[i], protectedRoots[j])) fail("ROOT_COLLISION");
    }
    const sourceFile = win32.join(paths.sourceStateDirectory, STATE);
    const stateLease = native.openLegacyStateFile(sourceFile); held.push(stateLease);
    const settingsLease = native.openLegacyStateFile(win32.join(paths.sourceSettingsDirectory, SETTINGS)); held.push(settingsLease);
    // Every sidecar must be absent; even zero-byte coordination remnants are
    // refused so immutable reads cannot omit committed WAL facts.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      let sidecar;
      try { sidecar = native.openLegacyStateFile(sourceFile + suffix); held.push(sidecar); }
      catch (e) { if (!missing(e)) throw e; }
      if (sidecar) fail("SOURCE_NOT_COLD");
    }
    const settingsBytes = readLease(native, settingsLease, 65536);
    let oldSettings; try { oldSettings = JSON.parse(settingsBytes.toString("utf8")); } catch { fail("SETTINGS_INVALID"); }
    const settings = convertDesktopSettingsV5(oldSettings), settingsSha256 = sha(settingsBytes);
    const sourceSha256 = leaseHash(native, stateLease);
    sourceDb = new DatabaseSync(`${pathToFileURL(sourceFile).href}?mode=ro&immutable=1`, { readOnly: true });
    sourceDb.exec("PRAGMA trusted_schema=OFF; BEGIN"); inspectCollector(sourceDb);
    const facts = factsDigest(sourceDb);
    if (sourceDb.prepare("SELECT 1 FROM meta WHERE key=?").get(PRESERVED_ACCOUNTING_HISTORY_META_KEY)) fail("HISTORY_COLLISION");
    const oldCache = sourceDb.prepare("SELECT value_json FROM meta WHERE key='accounting_cache'").get()?.value_json;
    const historical = oldCache === undefined ? null : preserveDesktopAccountingCacheV025(oldCache);
    const settingsTargetBytes = Buffer.from(`${JSON.stringify(settings)}\n`);
    const binding = { sourceSha256, settingsSha256, targetSettingsSha256: sha(settingsTargetBytes), facts,
      historicalSha256: historical?.sourceJsonSha256 ?? null };
    const existing = await readdir(paths.targetStateDirectory);
    if (existing.includes(RECEIPT)) {
      const receipt = JSON.parse(native.readProtectedChild(paths.targetStateDirectory, targetState.identity, RECEIPT, 65536).data.toString());
      if (receipt.status !== "complete" || JSON.stringify(receipt.binding) !== JSON.stringify(binding)) fail("TARGET_INCOMPLETE_OR_DIFFERENT");
      const targetSettingsBytes = native.readProtectedChild(paths.targetSettingsDirectory, targetSettings.identity, SETTINGS, 65536).data;
      if (sha(targetSettingsBytes) !== binding.targetSettingsSha256) fail("TARGET_CHANGED");
      if (existing.some(name => name === `${STATE}-wal` || name === `${STATE}-shm`)) fail("TARGET_CHANGED");
      const targetLease = native.openLegacyStateFile(win32.join(paths.targetStateDirectory, STATE)); held.push(targetLease);
      if (leaseHash(native, targetLease) !== receipt.targetSha256) fail("TARGET_CHANGED");
      return { schemaVersion: "desktop-calculation-copy-result-v1", status: "already_complete", facts: facts.rows,
        preservedHistory: historical !== null, sourceUnchanged: true };
    }
    if (existing.length || (await readdir(paths.targetSettingsDirectory)).length) fail("TARGET_NOT_EMPTY");
    const initial = { schemaVersion: "desktop-calculation-copy-operation-v1", status: "incomplete", binding };
    const receiptIdentity = native.createProtectedChild(paths.targetStateDirectory, targetState.identity, RECEIPT, Buffer.from(JSON.stringify(initial)));
    native.createProtectedChild(paths.targetSettingsDirectory, targetSettings.identity, SETTINGS, settingsTargetBytes);
    native.copyLegacyStateFile(stateLease, paths.targetStateDirectory, targetState.identity, STATE);
    const targetFile = win32.join(paths.targetStateDirectory, STATE);
    sqliteLease = acquireProtectedSqliteFiles({ native, path: targetFile });
    targetDb = new DatabaseSync(targetFile); configureGuardedSqliteConnection(targetDb);
    targetDb.exec("PRAGMA trusted_schema=OFF"); targetDb.enableDefensive?.(true);
    targetDb.exec("BEGIN EXCLUSIVE"); inspectCollector(targetDb);
    if (JSON.stringify(factsDigest(targetDb)) !== JSON.stringify(facts)) fail("COPY_MISMATCH");
    if (historical !== null) targetDb.prepare("INSERT INTO meta(key,value_json) VALUES(?,?)")
      .run(PRESERVED_ACCOUNTING_HISTORY_META_KEY, JSON.stringify(historical));
    targetDb.prepare("DELETE FROM meta WHERE key='accounting_cache'").run();
    if (JSON.stringify(factsDigest(targetDb)) !== JSON.stringify(facts)) fail("FACTS_CHANGED");
    const preserved = targetDb.prepare("SELECT value_json FROM meta WHERE key=?").get(PRESERVED_ACCOUNTING_HISTORY_META_KEY);
    if (historical !== null && JSON.stringify(JSON.parse(preserved.value_json)) !== JSON.stringify(historical)) fail("HISTORY_CHANGED");
    targetDb.exec("COMMIT"); targetDb.close(); targetDb = null;
    sqliteLease.release(); sqliteLease = null;
    if (leaseHash(native, stateLease) !== sourceSha256 || sha(readLease(native, settingsLease, 65536)) !== settingsSha256) fail("SOURCE_CHANGED");
    const targetLease = native.openLegacyStateFile(targetFile); held.push(targetLease);
    const targetSha256 = leaseHash(native, targetLease);
    native.replaceProtectedChild(paths.targetStateDirectory, targetState.identity, RECEIPT, receiptIdentity,
      Buffer.from(JSON.stringify({ ...initial, status: "complete", targetSha256 })));
    return { schemaVersion: "desktop-calculation-copy-result-v1", status: "converted", facts: facts.rows,
      preservedHistory: historical !== null, sourceUnchanged: true };
  } catch (e) {
    if (typeof e?.code === "string" && e.code.startsWith("DESKTOP_CALCULATION_MIGRATION_")) throw e;
    fail("UNAVAILABLE");
  } finally {
    let closeFailed = false;
    try { targetDb?.close(); } catch { closeFailed = true; }
    try { sourceDb?.close(); } catch { closeFailed = true; }
    if (closeFailed) {
      retainedOnCloseFailure.add({ targetDb, sourceDb, sqliteLease, held, guards, native });
      fail("RELEASE_FAILED");
    }
    let releaseFailed = false;
    for (const close of [() => sqliteLease?.release(),
      ...held.reverse().map(lease => () => native.closeSourceFile(lease)),
      ...guards.reverse().map(guard => () => native.releaseProtectedDirectoryGuard(guard))]) {
      try { close(); } catch { releaseFailed = true; }
    }
    if (releaseFailed) fail("RELEASE_FAILED");
  }
}
