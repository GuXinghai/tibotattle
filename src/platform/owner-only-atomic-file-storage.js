import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, lstat, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isProxy } from "node:util/types";

import { syncDirectory } from "./owner-only-filesystem.js";

function failure(code) {
  const error = new Error("Owner-only atomic publication failed");
  error.name = "OwnerOnlyAtomicFileStorageError";
  error.code = `OWNER_ONLY_ATOMIC_${code}`;
  return error;
}

const DEFAULT_FILESYSTEM = Object.freeze({
  mkdir,
  realpath,
  lstat,
  openExclusive(path, mode) {
    return open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      mode,
    );
  },
  rename,
  unlink,
  syncDirectory,
});

const DEFAULT_POLICY = Object.freeze({
  assertPlatformSupported() {
    if (process.platform !== "win32") throw failure("PLATFORM_UNSUPPORTED");
    throw failure("WINDOWS_ATOMIC_PUBLISHER_UNAVAILABLE");
  },
  assertDirectory({ stats }) {
    if (!stats.isDirectory()
        || (typeof process.getuid === "function" && stats.uid !== BigInt(process.getuid()))
        || (stats.mode & 0o022n) !== 0n) {
      throw failure("DIRECTORY_UNPROTECTED");
    }
  },
  assertStage({ stats, expectedBytes }) {
    if (!stats.isFile() || stats.nlink !== 1n || (stats.mode & 0o077n) !== 0n
        || (typeof process.getuid === "function" && stats.uid !== BigInt(process.getuid()))
        || (expectedBytes !== null && stats.size !== BigInt(expectedBytes))) {
      throw failure("STAGE_UNPROTECTED");
    }
  },
});

function ownValue(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, "value")) throw failure("INVALID_CONFIGURATION");
  return descriptor.value;
}

function snapshotRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    throw failure("INVALID_CONFIGURATION");
  }
  return value;
}

function fileIdentity(stats) {
  return Object.freeze({ dev: stats.dev, ino: stats.ino });
}

function sameFileIdentity(stats, identity) {
  return stats.dev === identity.dev && stats.ino === identity.ino;
}

function sameDirectoryIdentity(stats, identity) {
  return stats.isDirectory() && stats.dev === identity.dev && stats.ino === identity.ino;
}

async function lstatIfExists(filesystem, path) {
  try {
    return await filesystem.lstat(path, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Create an atomic single-file publisher over explicit filesystem and policy
 * ports. The default policy enforces the current production platform gate;
 * tests may inject a synthetic filesystem/policy pair without enabling a
 * native backend.
 */
export function createOwnerOnlyAtomicFilePublisher(configuration = undefined) {
  const selected = configuration === undefined
    ? Object.freeze({})
    : snapshotRecord(configuration);
  const filesystemValue = ownValue(selected, "filesystem");
  const policyValue = ownValue(selected, "policy");
  const filesystem = filesystemValue === undefined
    ? DEFAULT_FILESYSTEM
    : snapshotRecord(filesystemValue);
  const policy = policyValue === undefined
    ? DEFAULT_POLICY
    : snapshotRecord(policyValue);
  const filesystemMethods = ["mkdir", "realpath", "lstat", "openExclusive", "rename", "unlink", "syncDirectory"];
  const policyMethods = ["assertPlatformSupported", "assertDirectory", "assertStage"];
  for (const method of filesystemMethods) {
    const value = ownValue(filesystem, method);
    if (typeof value !== "function" || isProxy(value)) {
      throw failure("INVALID_CONFIGURATION");
    }
  }
  for (const method of policyMethods) {
    const value = ownValue(policy, method);
    if (typeof value !== "function" || isProxy(value)) {
      throw failure("INVALID_CONFIGURATION");
    }
  }

  const filesystemPort = Object.freeze(Object.fromEntries(filesystemMethods.map((method) => [
    method,
    ownValue(filesystem, method).bind(filesystem),
  ])));
  const policyPort = Object.freeze(Object.fromEntries(policyMethods.map((method) => [
    method,
    ownValue(policy, method).bind(policy),
  ])));
  const call = (object, method, args) => Reflect.apply(ownValue(object, method), object, args);
  const publishOwnerOnlyAtomic = async function publishOwnerOnlyAtomic(path, content) {
    if (typeof path !== "string" || path.length === 0) throw failure("INVALID_REQUEST");
    if (typeof content !== "string" && !Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
      throw failure("INVALID_REQUEST");
    }
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    await call(policyPort, "assertPlatformSupported", []);

    const requestedPath = resolve(path);
    const requestedDirectory = dirname(requestedPath);
    await call(filesystemPort, "mkdir", [requestedDirectory, { recursive: true, mode: 0o700 }]);
    const directory = await call(filesystemPort, "realpath", [requestedDirectory]);
    const directoryStats = await call(filesystemPort, "lstat", [directory, { bigint: true }]);
    await call(policyPort, "assertDirectory", [{ directory, stats: directoryStats }]);
    const directoryIdentity = fileIdentity(directoryStats);
    const targetPath = join(directory, basename(requestedPath));
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    let handle = null;
    let createdIdentity = null;

    try {
      handle = await call(filesystemPort, "openExclusive", [temporaryPath, 0o600]);
      const openedStats = await handle.stat({ bigint: true });
      if (!openedStats.isFile() || openedStats.nlink !== 1n) {
        throw failure("STAGE_UNPROTECTED");
      }
      createdIdentity = fileIdentity(openedStats);
      // Mode bits supplement the injected policy; the production Windows
      // policy fails before reaching this path and never treats chmod as DACL proof.
      await handle.chmod(0o600);
      const protectedStats = await handle.stat({ bigint: true });
      await call(policyPort, "assertStage", [{ phase: "before_write", path: temporaryPath, stats: protectedStats, expectedBytes: null }]);
      await handle.writeFile(bytes);
      await handle.sync();
      const writtenStats = await handle.stat({ bigint: true });
      await call(policyPort, "assertStage", [{ phase: "before_publish", path: temporaryPath, stats: writtenStats, expectedBytes: bytes.length }]);
      await handle.close();
      handle = null;

      const currentDirectory = await call(filesystemPort, "lstat", [directory, { bigint: true }]);
      const staged = await call(filesystemPort, "lstat", [temporaryPath, { bigint: true }]);
      if (!sameDirectoryIdentity(currentDirectory, directoryIdentity)
          || !staged.isFile() || staged.isSymbolicLink()
          || !sameFileIdentity(staged, createdIdentity)
          || staged.nlink !== 1n || staged.size !== writtenStats.size
          || staged.mode !== writtenStats.mode) {
        throw failure("STAGE_IDENTITY_CHANGED");
      }
      await call(filesystemPort, "rename", [temporaryPath, targetPath]);
      createdIdentity = null;
      await call(filesystemPort, "syncDirectory", [directory]);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (createdIdentity !== null) {
        const current = await lstatIfExists(filesystemPort, temporaryPath);
        if (current?.isFile() && !current.isSymbolicLink() && current.nlink === 1n
            && sameFileIdentity(current, createdIdentity)) {
          await call(filesystemPort, "unlink", [temporaryPath]);
        }
      }
      throw error;
    }
  };
  Object.defineProperty(publishOwnerOnlyAtomic, "assertAvailable", {
    enumerable: false,
    value: async function assertAvailable() {
      // Capability preflight is deliberately policy-only: it must not create
      // the destination directory or inspect/open a file before the caller's
      // collision checks and any later work.
      await call(policyPort, "assertPlatformSupported", []);
    },
  });
  return Object.freeze(publishOwnerOnlyAtomic);
}
