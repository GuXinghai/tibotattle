import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";

import { createWindowsFilesystemAdapter } from "./windows-filesystem.js";
import { createWindowsProtectedStateStore } from "./windows-protected-state-store.js";

// The local companion's single-instance lock. The file name, location and
// payload schema are a cross-version contract: an older companion build that
// is still running must recognize this process's lock and a newer build must
// recognize an older one's, so the payload schema string keeps its original
// spelling even though the feature that first owned it is gone.
const INSTANCE_LOCK_SCHEMA_VERSION =
  "automatic-contribution-instance-lock-v0.1";
const INSTANCE_LOCK_KEYS = Object.freeze([
  "createdAt",
  "nonce",
  "pid",
  "schemaVersion",
]);
const MAXIMUM_INSTANCE_LOCK_BYTES = 4 * 1_024;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class CompanionInstanceLockError extends Error {
  constructor(code) {
    super("Companion instance lock failed closed");
    this.name = "CompanionInstanceLockError";
    this.code = `companion_${code}`;
  }
}

function fail(code) {
  throw new CompanionInstanceLockError(code);
}

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function nullableTimestamp(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const normalized = new Date(milliseconds).toISOString();
  return normalized === value ? normalized : null;
}

function timestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail("configuration_invalid");
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

function protectedTarget(lockFile) {
  if (typeof lockFile !== "string" || lockFile.length < 1) {
    fail("configuration_invalid");
  }
  try {
    return {
      name: basename(lockFile),
      store: createWindowsProtectedStateStore({
        adapter: createWindowsFilesystemAdapter(),
        rootPath: dirname(resolve(lockFile)),
        maxBytes: MAXIMUM_INSTANCE_LOCK_BYTES,
      }),
    };
  } catch {
    return fail("instance_lock_unavailable");
  }
}

function protectedRead(selected) {
  try {
    return selected.store.read(selected.name);
  } catch (error) {
    if (error?.code === "windows_protected_state_store_missing") return null;
    return fail("instance_lock_unavailable");
  }
}

function readInstanceLock(selected) {
  const current = protectedRead(selected);
  if (current === null) return null;
  try {
    const payload = JSON.parse(current.data.toString("utf8"));
    if (!validInstanceLockPayload(payload)) fail("instance_lock_unavailable");
    return { payload, identity: current.identity };
  } catch (error) {
    if (error instanceof CompanionInstanceLockError) throw error;
    return fail("instance_lock_unavailable");
  } finally {
    current.data.fill(0);
  }
}

function nextNonce(uuid) {
  let value;
  try {
    value = Reflect.apply(uuid, undefined, []);
  } catch {
    fail("instance_lock_unavailable");
  }
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    fail("instance_lock_unavailable");
  }
  return value;
}

/**
 * Acquire the owner-only single-instance lock for one companion state root.
 * An unreadable, foreign or live-owned lock fails closed; only a lock whose
 * recorded process is gone is replaced. Release verifies the exact file
 * identity, pid and nonce so it can never delete another process's lock.
 */
export async function acquireCompanionInstanceLock({
  lockFile,
  pid = process.pid,
  now = () => new Date(),
  processIsAlive = defaultProcessIsAlive,
  uuid = randomUUID,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647
      || typeof now !== "function"
      || typeof processIsAlive !== "function"
      || typeof uuid !== "function") {
    fail("configuration_invalid");
  }
  const selected = protectedTarget(lockFile);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const payload = {
      schemaVersion: INSTANCE_LOCK_SCHEMA_VERSION,
      pid,
      createdAt: timestamp(now()),
      nonce: nextNonce(uuid),
    };
    const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
    let identity;
    try {
      identity = selected.store.create(selected.name, bytes).identity;
    } catch (error) {
      if (error?.code !== "windows_protected_state_store_already_exists") {
        fail("instance_lock_unavailable");
      }
    } finally {
      bytes.fill(0);
    }
    if (identity !== undefined) {
      let releasePromise = null;
      return Object.freeze({
        schemaVersion: INSTANCE_LOCK_SCHEMA_VERSION,
        pid,
        createdAt: payload.createdAt,
        release() {
          if (releasePromise !== null) return releasePromise;
          releasePromise = (async () => {
            const current = readInstanceLock(selected);
            if (current === null) return;
            if (current.identity.volumeSerialNumber !== identity.volumeSerialNumber
                || current.identity.fileId !== identity.fileId
                || current.payload.pid !== pid
                || current.payload.nonce !== payload.nonce) {
              fail("instance_lock_unavailable");
            }
            try {
              selected.store.delete(selected.name, identity);
            } catch {
              fail("instance_lock_unavailable");
            }
          })();
          releasePromise.catch(() => { releasePromise = null; });
          return releasePromise;
        },
      });
    }
    const existing = readInstanceLock(selected);
    if (existing === null) continue;
    let active;
    try {
      active = await processIsAlive(existing.payload.pid);
    } catch {
      fail("instance_lock_unavailable");
    }
    if (active !== false) fail("instance_active");
    try {
      selected.store.delete(selected.name, existing.identity);
    } catch (error) {
      if (["missing", "identity_mismatch"].some((code) =>
        error?.code === `windows_protected_state_store_${code}`)) continue;
      fail("instance_lock_unavailable");
    }
  }
  return fail("instance_lock_unavailable");
}
