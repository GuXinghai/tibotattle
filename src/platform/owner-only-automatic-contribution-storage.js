import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { createWindowsFilesystemAdapter } from "./windows-filesystem.js";
import { createWindowsProtectedStateStore } from "./windows-protected-state-store.js";

const INSTANCE_LOCK_SCHEMA_VERSION =
  "automatic-contribution-instance-lock-v0.1";
const INSTANCE_LOCK_KEYS = Object.freeze([
  "createdAt",
  "nonce",
  "pid",
  "schemaVersion",
]);
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function failureContext(createError) {
  const factory = requireFunction(createError, "createError");
  const issued = new WeakSet();
  return Object.freeze({
    fail(code) {
      let error;
      try {
        error = Reflect.apply(factory, undefined, [code]);
      } catch {
        throw new TypeError("createError must return an Error");
      }
      if (!(error instanceof Error)) {
        throw new TypeError("createError must return an Error");
      }
      issued.add(error);
      throw error;
    },
    issued(error) {
      try {
        return error instanceof Error && issued.has(error);
      } catch {
        return false;
      }
    },
  });
}

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function nullableTimestamp(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 32) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const normalized = new Date(milliseconds).toISOString();
  return normalized === value ? normalized : null;
}

function timestamp(value, failures) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) failures.fail("configuration_invalid");
  return date.toISOString();
}

function defaultProcessIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function validInstanceLockPayload(value) {
  return exactKeys(value, INSTANCE_LOCK_KEYS)
    && value.schemaVersion === INSTANCE_LOCK_SCHEMA_VERSION
    && Number.isSafeInteger(value.pid)
    && value.pid >= 1
    && value.pid <= 2_147_483_647
    && nullableTimestamp(value.createdAt) !== null
    && UUID_V4.test(value.nonce);
}

export function createOwnerOnlyAutomaticContributionStorageContext({
  createError,
  uuid = randomUUID,
  processId = process.pid,
  defaultProcessLiveness = defaultProcessIsAlive,
} = {}) {
  const failures = failureContext(createError);
  const createUuid = requireFunction(uuid, "uuid");
  const processIsAliveByDefault = requireFunction(
    defaultProcessLiveness,
    "defaultProcessLiveness",
  );
  if (!Number.isSafeInteger(processId)
      || processId < 1
      || processId > 2_147_483_647) {
    throw new TypeError("processId must be a positive 32-bit integer");
  }

  function nextUuid(code) {
    let value;
    try {
      value = Reflect.apply(createUuid, undefined, []);
    } catch {
      failures.fail(code);
    }
    if (typeof value !== "string" || !UUID_V4.test(value)) failures.fail(code);
    return value;
  }

  async function readSettingsText({ settingsFile, maximumBytes } = {}) {
    if (typeof settingsFile !== "string" || settingsFile.length < 1
        || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      failures.fail("configuration_invalid");
    }
    // Reading absent state must never provision a directory or change its ACL.
    try { await lstat(dirname(resolve(settingsFile))); }
    catch (error) {
      if (error?.code === "ENOENT") return null;
      failures.fail("settings_unavailable");
    }
    const selected = protectedTarget(settingsFile, maximumBytes, "settings_unavailable");
    const result = protectedRead(selected, "settings_unavailable");
    if (result === null) return null;
    try {
      if (result.data.length < 1) failures.fail("settings_unavailable");
      return result.data.toString("utf8");
    } finally { result.data.fill(0); }
  }

  function protectedTarget(path, maximumBytes, code) {
    if (typeof path !== "string" || path.length < 1
        || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      failures.fail("configuration_invalid");
    }
    try {
      return { name: basename(path), store: createWindowsProtectedStateStore({
        adapter: createWindowsFilesystemAdapter(), rootPath: dirname(resolve(path)), maxBytes: maximumBytes,
      }) };
    } catch { failures.fail(code); }
  }

  function protectedRead(selected, code) {
    try { return selected.store.read(selected.name); }
    catch (error) {
      if (error?.code === "windows_protected_state_store_missing") return null;
      failures.fail(code);
    }
  }

  async function writeSettingsText({
    settingsFile,
    text,
    maximumBytes,
  } = {}) {
    if (typeof text !== "string") failures.fail("configuration_invalid");
    const selected = protectedTarget(settingsFile, maximumBytes, "settings_unavailable");
    const bytes = Buffer.from(text, "utf8");
    let existing;
    try {
      if (bytes.length < 1 || bytes.length > maximumBytes) failures.fail("settings_unavailable");
      existing = protectedRead(selected, "settings_unavailable");
      if (existing === null) selected.store.create(selected.name, bytes);
      else selected.store.replace(selected.name, existing.identity, bytes);
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail("settings_unavailable");
    } finally { bytes.fill(0); existing?.data.fill(0); }
  }

  function readInstanceLock(selected) {
    const current = protectedRead(selected, "instance_lock_unavailable");
    if (current === null) return null;
    try {
      const payload = JSON.parse(current.data.toString("utf8"));
      if (!validInstanceLockPayload(payload)) failures.fail("instance_lock_unavailable");
      return { payload, identity: current.identity };
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail("instance_lock_unavailable");
    } finally { current.data.fill(0); }
  }

  async function acquireInstanceLock({ lockFile, pid = processId, now = () => new Date(),
    processIsAlive = processIsAliveByDefault, maximumBytes } = {}) {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647
        || typeof now !== "function" || typeof processIsAlive !== "function") {
      failures.fail("configuration_invalid");
    }
    const selected = protectedTarget(lockFile, maximumBytes, "instance_lock_unavailable");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const payload = { schemaVersion: INSTANCE_LOCK_SCHEMA_VERSION, pid,
        createdAt: timestamp(now(), failures), nonce: nextUuid("instance_lock_unavailable") };
      const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
      let identity;
      try {
        if (bytes.length > maximumBytes) failures.fail("instance_lock_unavailable");
        identity = selected.store.create(selected.name, bytes).identity;
      } catch (error) {
        if (error?.code !== "windows_protected_state_store_already_exists") {
          if (failures.issued(error)) throw error;
          failures.fail("instance_lock_unavailable");
        }
      } finally { bytes.fill(0); }
      if (identity !== undefined) {
        let releasePromise = null;
        return Object.freeze({ schemaVersion: INSTANCE_LOCK_SCHEMA_VERSION, pid,
          createdAt: payload.createdAt,
          release() {
            if (releasePromise !== null) return releasePromise;
            releasePromise = (async () => {
              const current = readInstanceLock(selected);
              if (current === null) return;
              if (current.identity.volumeSerialNumber !== identity.volumeSerialNumber
                  || current.identity.fileId !== identity.fileId
                  || current.payload.pid !== pid || current.payload.nonce !== payload.nonce) {
                failures.fail("instance_lock_unavailable");
              }
              try { selected.store.delete(selected.name, identity); }
              catch { failures.fail("instance_lock_unavailable"); }
            })();
            releasePromise.catch(() => { releasePromise = null; });
            return releasePromise;
          },
        });
      }
      const existing = readInstanceLock(selected);
      if (existing === null) continue;
      let active;
      try { active = await processIsAlive(existing.payload.pid); }
      catch { failures.fail("instance_lock_unavailable"); }
      if (active !== false) failures.fail("instance_active");
      try { selected.store.delete(selected.name, existing.identity); }
      catch (error) {
        if (["missing", "identity_mismatch"].some((code) =>
          error?.code === `windows_protected_state_store_${code}`)) continue;
        failures.fail("instance_lock_unavailable");
      }
    }
    failures.fail("instance_lock_unavailable");
  }

  return Object.freeze({
    acquireInstanceLock,
    readSettingsText,
    writeSettingsText,
  });
}
