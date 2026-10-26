import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat as nodeLstat, mkdir, open as nodeOpen, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isProxy } from "node:util/types";
import { syncDirectory } from "./owner-only-filesystem.js";
import {
  createWindowsFilesystemAdapter,
  isWindowsFilesystemIdentity,
} from "./windows-filesystem.js";

import { exactLstat, exactOpen } from "./exact-filesystem-stats.js";
const lstat = (path) => exactLstat(path, nodeLstat);
const open = (path, flags, mode) => exactOpen(path, flags, nodeOpen, mode);

function configurationFailure() {
  throw new TypeError("Owner-only export workspace lease configuration is invalid");
}

function ownStableJson(configuration) {
  try {
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration) || isProxy(configuration)
        || !Object.hasOwn(configuration, "stableJson")) configurationFailure();
    const descriptor = Object.getOwnPropertyDescriptor(configuration, "stableJson");
    if (!descriptor || !Object.hasOwn(descriptor, "value")) configurationFailure();
    const stableJson = descriptor.value;
    if (typeof stableJson !== "function" || isProxy(stableJson)) configurationFailure();
    return stableJson;
  } catch {
    configurationFailure();
  }
}

/** Platform owner for the export-workspace exclusive lease protocol. */
export function createOwnerOnlyExportWorkspaceLeaseContext(configuration = {}) {
  const stableJson = ownStableJson(configuration);
const LOCK_BASENAME = ".app-usagemonitor-export-workspace.lock";
const LOCK_VERSION = "export-workspace-lock-v1";
const trustedWorkspaceLockErrors = new WeakSet();

class ExportWorkspaceLockError extends Error {
  constructor(code) {
    if (!new Set(["contended", "invalid", "race"]).has(code)) throw new TypeError("Unknown workspace-lock code");
    super(`Local export workspace lock failed (${code})`);
    this.name = "ExportWorkspaceLockError";
    this.code = `export_workspace_lock_${code}`;
    trustedWorkspaceLockErrors.add(this);
  }
}

function isTrustedExportWorkspaceLockError(error) {
  return Boolean(error && trustedWorkspaceLockErrors.has(error)
    && Object.getPrototypeOf(error) === ExportWorkspaceLockError.prototype);
}

function fail(code) {
  throw new ExportWorkspaceLockError(code);
}

function assertDirectory(stats) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("invalid");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("invalid");
}

function assertLock(stats) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size < 1 || stats.size > 1024) fail("invalid");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) fail("invalid");
}

let workspaceLeaseWindowsFilesystemAdapter;
let workspaceLeaseWindowsFilesystemAdapterResolved = false;

function getWorkspaceLeaseWindowsFilesystemAdapter() {
  if (process.platform !== "win32") return null;
  if (!workspaceLeaseWindowsFilesystemAdapterResolved) {
    workspaceLeaseWindowsFilesystemAdapterResolved = true;
    try {
      workspaceLeaseWindowsFilesystemAdapter = createWindowsFilesystemAdapter();
    } catch {
      workspaceLeaseWindowsFilesystemAdapter = null;
    }
  }
  if (!workspaceLeaseWindowsFilesystemAdapter) fail("invalid");
  return workspaceLeaseWindowsFilesystemAdapter;
}

function sameWindowsFilesystemIdentity(left, right) {
  return left?.volumeSerialNumber === right?.volumeSerialNumber
    && left?.fileId === right?.fileId
    && left?.linkCount === right?.linkCount;
}

function validProtectedDirectoryInspection(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && value.isDirectory === true && value.isRegularFile === false
      && value.isReparsePoint === false && value.ownerMatches === true
      && value.nullDacl === false && value.daclProtected === true
      && value.broadAccess === false && value.nonOwnerAllow === false
      && value.unrecognizedAce === false && value.finalPathResolved === true
      && isWindowsFilesystemIdentity(value.identity) && value.identity.linkCount > 0;
  } catch {
    return false;
  }
}

function inspectProtectedLeaseDirectory(adapter, path, { create = false } = {}) {
  let createdIdentity = null;
  if (create) {
    try {
      createdIdentity = adapter.ensureDirectory(path);
    } catch {
      fail("invalid");
    }
  }
  let inspection;
  try {
    inspection = adapter.inspectPath(path);
  } catch {
    fail("invalid");
  }
  if (!validProtectedDirectoryInspection(inspection)
      || (createdIdentity !== null
        && !sameWindowsFilesystemIdentity(createdIdentity, inspection.identity))) {
    fail("invalid");
  }
  return inspection.identity;
}

function validProtectedLockInspection(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && value.isDirectory === false && value.isRegularFile === true
      && value.isReparsePoint === false && value.ownerMatches === true
      && value.nullDacl === false && value.daclProtected === true
      && value.broadAccess === false && value.nonOwnerAllow === false
      && value.unrecognizedAce === false && value.finalPathResolved === true
      && isWindowsFilesystemIdentity(value.identity) && value.identity.linkCount === 1;
  } catch {
    return false;
  }
}

async function inspectProtectedLock(path, adapter) {
  let pathStats;
  let metadata;
  let file;
  try {
    pathStats = await lstat(path);
    assertLock(pathStats);
    metadata = adapter.inspectPath(path);
    if (!validProtectedLockInspection(metadata)) fail("invalid");
    file = adapter.readFile(path);
  } catch (error) {
    if (error instanceof ExportWorkspaceLockError) throw error;
    if (error?.code === "ENOENT") throw error;
    fail("invalid");
  }
  try {
    if (!Buffer.isBuffer(file?.data)
        || !sameWindowsFilesystemIdentity(metadata.identity, file.identity)
        || file.data.length < 1 || file.data.length > 1024) fail("invalid");
    let afterStats;
    try {
      afterStats = await lstat(path);
    } catch {
      fail("race");
    }
    assertLock(afterStats);
    if (afterStats.dev !== pathStats.dev || afterStats.ino !== pathStats.ino
        || afterStats.size !== pathStats.size) fail("race");
    let value;
    try {
      value = JSON.parse(file.data.toString("utf8"));
    } catch {
      fail("invalid");
    }
    if (value?.version !== LOCK_VERSION || !Number.isSafeInteger(value.pid)
        || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/.test(value.token)) fail("invalid");
    return { identity: metadata.identity, value, token: value.token };
  } finally {
    if (Buffer.isBuffer(file?.data)) {
      file.data.fill(0);
    }
  }
}

function createProtectedLock(path, value, adapter) {
  const bytes = Buffer.from(stableJson(value), "utf8");
  let identity;
  try {
    identity = adapter.createFile(path, bytes);
    const metadata = adapter.inspectPath(path);
    if (!validProtectedLockInspection(metadata)
        || !sameWindowsFilesystemIdentity(identity, metadata.identity)) fail("invalid");
    return { identity, value, token: value.token };
  } catch (error) {
    if (identity !== undefined) {
      try { adapter.deleteFile(path, identity); } catch { /* Preserve the fixed failure. */ }
    }
    if (error instanceof ExportWorkspaceLockError) throw error;
    if (error?.code === "EEXIST") throw error;
    fail("invalid");
  } finally {
    bytes.fill(0);
  }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function inspectLock(path, windowsAdapter = null) {
  if (process.platform === "win32") return inspectProtectedLock(path, windowsAdapter);
  const pathStats = await lstat(path);
  assertLock(pathStats);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = await handle.stat();
    assertLock(stats);
    if (stats.dev !== pathStats.dev || stats.ino !== pathStats.ino) fail("race");
    let value;
    try {
      value = JSON.parse(await handle.readFile("utf8"));
    } catch {
      fail("invalid");
    }
    if (value?.version !== LOCK_VERSION || !Number.isSafeInteger(value.pid)
        || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/.test(value.token)) fail("invalid");
    return { stats, value };
  } finally {
    await handle.close();
  }
}

async function removeExactLock(path, expected, windowsAdapter = null) {
  if (process.platform === "win32") {
    let result;
    try {
      result = windowsAdapter.deleteFile(path, expected.identity);
    } catch {
      fail("race");
    }
    if (result?.deleted !== true
        || !sameWindowsFilesystemIdentity(result.identity, expected.identity)) fail("race");
    return;
  }
  const current = await lstat(path);
  assertLock(current);
  if (current.dev !== expected.dev || current.ino !== expected.ino) fail("race");
  await unlink(path);
}

async function withExportWorkspaceLease(directory, callback, {
  create = true,
} = {}) {
  if (typeof callback !== "function") throw new TypeError("Workspace lease callback is required");
  const target = resolve(directory);
  const windowsAdapter = getWorkspaceLeaseWindowsFilesystemAdapter();
  let initialWindowsIdentity = null;
  if (windowsAdapter) {
    initialWindowsIdentity = inspectProtectedLeaseDirectory(windowsAdapter, target, { create });
  } else if (create) {
    await mkdir(target, { recursive: true, mode: 0o700 });
  }
  let initial;
  try {
    initial = await lstat(target);
  } catch (error) {
    if (!create && error.code === "ENOENT") fail("invalid");
    if (windowsAdapter) fail("invalid");
    throw error;
  }
  if (!initial.isDirectory() || initial.isSymbolicLink()
      || (typeof process.getuid === "function" && initial.uid !== process.getuid())) fail("invalid");
  let canonicalTarget;
  let canonicalStats;
  try {
    canonicalTarget = await realpath(target);
    canonicalStats = await lstat(canonicalTarget);
  } catch (error) {
    if (windowsAdapter) fail("invalid");
    throw error;
  }
  assertDirectory(canonicalStats);
  if (canonicalStats.dev !== initial.dev || canonicalStats.ino !== initial.ino) fail("race");
  if (windowsAdapter) {
    const canonicalIdentity = inspectProtectedLeaseDirectory(windowsAdapter, canonicalTarget);
    if (!sameWindowsFilesystemIdentity(initialWindowsIdentity, canonicalIdentity)) fail("race");
  }
  const lockPath = join(canonicalTarget, LOCK_BASENAME);
  let owned = null;
  for (let attempt = 0; attempt < 10 && !owned; attempt += 1) {
    const token = randomUUID();
    let handle;
    let newlyCreated = null;
    try {
      if (windowsAdapter) {
        const currentDirectoryIdentity = inspectProtectedLeaseDirectory(windowsAdapter, canonicalTarget);
        if (!sameWindowsFilesystemIdentity(initialWindowsIdentity, currentDirectoryIdentity)) fail("race");
        newlyCreated = createProtectedLock(lockPath, {
          version: LOCK_VERSION,
          pid: process.pid,
          token,
        }, windowsAdapter);
      } else {
        handle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        await handle.chmod(0o600);
        await handle.writeFile(stableJson({ version: LOCK_VERSION, pid: process.pid, token }));
        await handle.sync();
        const stats = await handle.stat();
        assertLock(stats);
        owned = { stats, token };
        await handle.close();
        handle = null;
      }
      await syncDirectory(canonicalTarget);
      if (windowsAdapter) {
        owned = newlyCreated;
        newlyCreated = null;
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      if (newlyCreated !== null) {
        try {
          await removeExactLock(lockPath, newlyCreated, windowsAdapter);
          await syncDirectory(canonicalTarget);
        } catch { /* Preserve the original fixed lease result. */ }
      }
      if (windowsAdapter && error instanceof ExportWorkspaceLockError) throw error;
      if (windowsAdapter && error?.code !== "EEXIST") fail("invalid");
      if (error.code !== "EEXIST") throw error;
      const existing = await inspectLock(lockPath, windowsAdapter);
      if (processAlive(existing.value.pid)) fail("contended");
      try {
        await removeExactLock(lockPath, windowsAdapter ? existing : existing.stats, windowsAdapter);
        await syncDirectory(canonicalTarget);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT" && !(cleanupError instanceof ExportWorkspaceLockError)) throw cleanupError;
      }
    }
  }
  if (!owned) fail("race");
  try {
    return await callback(canonicalTarget, canonicalStats);
  } finally {
    try {
      const current = await inspectLock(lockPath, windowsAdapter);
      if (current.value.token !== owned.token) fail("race");
      await removeExactLock(lockPath, windowsAdapter ? owned : owned.stats, windowsAdapter);
      await syncDirectory(canonicalTarget);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function withExistingExportWorkspaceLease(directory, callback) {
  return withExportWorkspaceLease(directory, callback, { create: false });
}

  return Object.freeze({
    ExportWorkspaceLockError,
    isTrustedExportWorkspaceLockError,
    withExportWorkspaceLease,
    withExistingExportWorkspaceLease,
  });
}
