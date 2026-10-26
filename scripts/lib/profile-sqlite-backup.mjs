import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { stableJson } from "../../src/export/canonical-json.js";
import { loadWindowsLegacyStateReadBinding } from "../../src/platform/index.js";
import {
  LOCAL_INDEX_STORE_APPLICATION_ID, LOCAL_INDEX_STORE_USER_VERSION, LOCAL_INDEX_STORE_FAMILY,
} from "../../src/local-index-store.js";
import { LOCAL_COLLECTOR_STATE_SCHEMA_VERSION } from "../../src/local-collector-state.js";

export const PROFILE_SQLITE_BACKUP_REPORT_SCHEMA = "usage-monitor-cold-local-state-backup-report-v1";
export const PROFILE_SQLITE_BACKUP_MAXIMUM_BYTES = 1024 ** 3;
const SALT = "local-unified-index-device-salt-v1";
const SIDECARS = ["-wal", "-shm", "-journal"];
const CHUNK = 64 * 1024;
const DEFINITIONS = Object.freeze({
  index: { file: "local-index-store-v1.sqlite", applicationId: LOCAL_INDEX_STORE_APPLICATION_ID,
    userVersion: LOCAL_INDEX_STORE_USER_VERSION, salt: true,
    tables: ["source", "usage_event", "quota_occurrence", "work_lifecycle_fact", "store_state", "commit_log"] },
  collector: { file: "local-collector-state-v1.sqlite", applicationId: 0x554d4353,
    userVersion: 1, salt: false, tables: ["records", "meta", "instance_locks"] },
});
const errors = new WeakSet();
// Pin failed-close resources until process exit: GC finalizers must not release
// frozen handles while an unconfirmed SQLite connection can still use a path.
// This process must stop verification after such a failure, not accumulate retries.
const retainedResources = new Set();
function fail(category) {
  const error = Object.assign(new Error("Cold local-state backup verification refused"), {
    code: `PROFILE_SQLITE_BACKUP_${category}`,
  });
  errors.add(error); throw error;
}
export function classifyProfileSqliteBackupFailure(error) {
  return errors.has(error) ? error.code : "PROFILE_SQLITE_BACKUP_UNAVAILABLE";
}
const missing = error => error?.code === "ENOENT" || error?.code === "WINDOWS_FILESYSTEM_NOT_FOUND";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const identitySha = stat => sha(stableJson({ volumeSerialNumber: stat.dev, fileId: stat.ino, linkCount: stat.nlink }));
function rootPath(value) {
  if (typeof value !== "string" || value.includes("\0")
      || !/^[A-Za-z]:[\\/]$/u.test(win32.parse(value).root)
      || value.split(/[\\/]/u).some(part => part === "." || part === "..")
      || win32.resolve(value) === win32.parse(value).root) fail("CONFIGURATION_INVALID");
  return win32.resolve(value);
}
function contained(left, right) {
  const relative = win32.relative(left, right);
  return !relative || !win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\");
}
function sameStat(left, right) {
  return ["dev", "ino", "nlink", "size", "birthtimeMs", "mtimeMs", "ctimeMs"].every(key => left[key] === right[key]);
}
function validStat(stat) {
  return stat && typeof stat.dev === "string" && /^[a-f0-9]{16}$/u.test(stat.dev)
    && typeof stat.ino === "string" && /^[a-f0-9]{32}$/u.test(stat.ino) && stat.nlink === 1
    && Number.isSafeInteger(stat.size) && stat.size >= 0
    && [stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs].every(Number.isFinite);
}

/** Explicit cold-file comparison only; never a copy, migration or activation.
 * Native frozen handles remain held through both SQLite connection closes and
 * final byte revalidation. No ordinary Node filesystem permission fallback.
 * Caller-supplied roots are never discovered from branding or current accounts. */
export async function verifyColdLocalStateBackup(options) {
  const required = ["sourceRoot", "backupRoot", "family"], allowed = [...required, "signal"];
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
      || !required.every(key => Object.hasOwn(options, key))
      || !Reflect.ownKeys(options).every(key => allowed.includes(key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), "value"))) fail("CONFIGURATION_INVALID");
  const { family, signal } = options;
  if (typeof family !== "string" || !Object.hasOwn(DEFINITIONS, family)
      || signal !== undefined && !(signal instanceof AbortSignal)) fail("CONFIGURATION_INVALID");
  const sourceRoot = rootPath(options.sourceRoot), backupRoot = rootPath(options.backupRoot);
  if (contained(sourceRoot, backupRoot) || contained(backupRoot, sourceRoot)) fail("ROOT_COLLISION");
  const cancelled = () => { if (signal?.aborted) fail("CANCELLED"); };
  cancelled();
  if (retainedResources.size) fail("CLOSE_FAILED");
  let native;
  try { native = loadWindowsLegacyStateReadBinding(); } catch { fail("NATIVE_UNAVAILABLE"); }
  const definition = DEFINITIONS[family], held = [], absent = [], connections = [];
  let sourceGuard, backupGuard, result;
  function closeConnections() {
    let failed = false;
    for (let index = connections.length - 1; index >= 0; index--) {
      try { connections[index].close(); connections.splice(index, 1); }
      catch { failed = true; }
    }
    return !failed;
  }
  function open(root, name, backup = false) {
    const path = win32.join(root, name), lease = native.openLegacyStateFile(path);
    const entry = { path, lease, before: null };
    held.push(entry);
    entry.before = native.statSourceFile(lease);
    if (!validStat(entry.before)) fail("FILE_INVALID");
    if (backup) {
      // Frozen reads alone accept inherited source ACLs. Backup payloads must
      // independently pass the stronger owner-only protected-child boundary.
      const inspected = native.inspectProtectedChild(backupRoot, backupGuard.identity, name);
      const identity = inspected.identity;
      if (identity?.volumeSerialNumber !== entry.before.dev || identity?.fileId !== entry.before.ino
          || identity?.linkCount !== entry.before.nlink) fail("BACKUP_IDENTITY_CHANGED");
    }
    return entry;
  }
  function read(entry, offset, size) {
    cancelled();
    const bytes = native.readSourceFile(entry.lease, offset, size);
    if (!Buffer.isBuffer(bytes) || bytes.length !== size) fail("READ_FAILED");
    return bytes;
  }
  async function hashFile(entry) {
    const digest = createHash("sha256");
    for (let offset = 0; offset < entry.before.size;) {
      const bytes = read(entry, offset, Math.min(CHUNK, entry.before.size - offset));
      try { digest.update(bytes); offset += bytes.length; } finally { bytes.fill(0); }
      if (offset % (4 * 1024 * 1024) === 0) { await setImmediate(); cancelled(); }
    }
    cancelled();
    return digest.digest("hex");
  }
  function checkSidecars(root, backup) {
    for (const suffix of SIDECARS) {
      const name = definition.file + suffix;
      let entry;
      try { entry = open(root, name, backup); }
      catch (error) { if (missing(error)) { absent.push(win32.join(root, name)); continue; } throw error; }
      if (entry.before.size !== 0) fail("DATABASE_NOT_COLD");
    }
  }
  function inspectDatabase(entry) {
    cancelled();
    const database = new DatabaseSync(`${pathToFileURL(entry.path).href}?mode=ro&immutable=1`, { readOnly: true });
    connections.push(database);
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-2048; PRAGMA mmap_size=0;");
    database.enableDefensive?.(true);
    if (database.prepare("PRAGMA application_id").get().application_id !== definition.applicationId
        || database.prepare("PRAGMA user_version").get().user_version !== definition.userVersion) fail("DATABASE_UNSUPPORTED");
    const marker = family === "index"
      ? database.prepare("SELECT value AS marker FROM meta WHERE key='family'").get()?.marker
      : database.prepare("SELECT value_json AS marker FROM meta WHERE key='schema_version'").get()?.marker;
    if (marker !== (family === "index" ? LOCAL_INDEX_STORE_FAMILY : JSON.stringify(LOCAL_COLLECTOR_STATE_SCHEMA_VERSION))) fail("DATABASE_UNSUPPORTED");
    if (database.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok") fail("INTEGRITY_FAILED");
    cancelled();
    if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) fail("FOREIGN_KEY_FAILED");
    const counts = {};
    for (const table of definition.tables) {
      // All SQL identifiers are fixed reviewed definitions, never file input.
      const count = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
      if (!Number.isSafeInteger(count) || count < 0) fail("COUNTS_INVALID");
      counts[table] = count; cancelled();
    }
    return counts;
  }
  try {
    sourceGuard = native.acquireLegacyStateDirectoryGuard(sourceRoot);
    backupGuard = native.acquireProtectedDirectoryGuard(backupRoot);
    if (native.legacyStateRootsDisjoint(sourceGuard.guard, backupGuard.guard) !== true) fail("ROOT_COLLISION");
    const source = open(sourceRoot, definition.file), backup = open(backupRoot, definition.file, true);
    for (const entry of [source, backup]) {
      if (entry.before.size < 100 || entry.before.size > PROFILE_SQLITE_BACKUP_MAXIMUM_BYTES) fail("SIZE_INVALID");
    }
    if (source.before.size !== backup.before.size) fail("BYTES_MISMATCH");
    checkSidecars(sourceRoot, false); checkSidecars(backupRoot, true);
    let sourceSalt, backupSalt;
    if (definition.salt) {
      sourceSalt = open(sourceRoot, SALT); backupSalt = open(backupRoot, SALT, true);
      for (const entry of [sourceSalt, backupSalt]) {
        if (entry.before.size < 32 || entry.before.size > 256) fail("SALT_INVALID");
      }
    }
    // All present inputs (including zero-length sidecars and both salts) are
    // frozen before reading any data. Sources and originals are never modified.
    for (const entry of [source, backup]) {
      const header = read(entry, 0, 100);
      try {
        if (header.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
            || ![1, 2].includes(header[18]) || header[18] !== header[19]) fail("HEADER_INVALID");
        if (header.readUInt32BE(68) !== definition.applicationId
            || header.readUInt32BE(60) !== definition.userVersion) fail("DATABASE_UNSUPPORTED");
      } finally { header.fill(0); }
    }
    let saltSha256 = null;
    if (sourceSalt) {
      const left = read(sourceSalt, 0, sourceSalt.before.size);
      let right;
      try {
        right = read(backupSalt, 0, backupSalt.before.size);
        if (!left.equals(right)) fail("SALT_MISMATCH");
        saltSha256 = sha(left);
      } finally { left.fill(0); right?.fill(0); }
    }
    const databaseSha256 = await hashFile(source);
    if (await hashFile(backup) !== databaseSha256) fail("BYTES_MISMATCH");
    const sourceCounts = inspectDatabase(source), backupCounts = inspectDatabase(backup);
    if (stableJson(sourceCounts) !== stableJson(backupCounts)) fail("COUNTS_MISMATCH");
    // Close SQLite before releasing ANY frozen handle, even on failure.
    if (!closeConnections()) fail("CLOSE_FAILED");
    if (await hashFile(source) !== databaseSha256 || await hashFile(backup) !== databaseSha256) fail("SOURCE_CHANGED");
    for (const entry of held) if (!sameStat(entry.before, native.statSourceFile(entry.lease))) fail("SOURCE_CHANGED");
    for (const path of absent) {
      let lease;
      try { lease = native.openLegacyStateFile(path); }
      catch (error) { if (missing(error)) continue; throw error; }
      held.push({ lease }); fail("SIDECAR_CHANGED");
    }
    cancelled();
    const tables = Object.freeze(sourceCounts);
    const report = Object.freeze({ schemaVersion: PROFILE_SQLITE_BACKUP_REPORT_SCHEMA, family,
      applicationId: definition.applicationId, userVersion: definition.userVersion,
      bytes: source.before.size, databaseSha256, saltSha256,
      sourceIdentitySha256: identitySha(source.before), backupIdentitySha256: identitySha(backup.before), tables });
    result = Object.freeze({ report, summary: Object.freeze({ status: "cold_sqlite_pair_verified",
      scope: definition.salt ? "index_database_and_salt_only" : "collector_database_only",
      bytes: report.bytes, tables, pageIntegrity: "ok", foreignKeys: "ok" }) });
  } catch (error) {
    if (errors.has(error)) throw error;
    fail("UNAVAILABLE");
  } finally {
    let failedClose = !closeConnections();
    // A failed close must not release file leases around an open database.
    if (!connections.length) {
      for (let index = held.length - 1; index >= 0; index--) {
        try { native.closeSourceFile(held[index].lease); held.splice(index, 1); }
        catch { failedClose = true; }
      }
      if (!held.length) {
        if (backupGuard) try { native.releaseProtectedDirectoryGuard(backupGuard.guard); backupGuard = null; } catch { failedClose = true; }
        if (sourceGuard) try { native.releaseProtectedDirectoryGuard(sourceGuard.guard); sourceGuard = null; } catch { failedClose = true; }
      }
    }
    if (failedClose) {
      retainedResources.add({ native, connections, held, sourceGuard, backupGuard });
      fail("CLOSE_FAILED");
    }
  }
  return result;
}
