import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { isProxy } from "node:util/types";

import {
  loadWindowsReportPublicationBinding,
  WINDOWS_REPORT_PUBLICATION_CONTRACT,
} from "./windows-filesystem.js";

const MAXIMUM_REPORT_BYTES = 64 * 1024 * 1024;

function failure(code) {
  const error = new Error("Owner-only atomic publication failed");
  error.name = "OwnerOnlyAtomicFileStorageError";
  error.code = `OWNER_ONLY_ATOMIC_${code}`;
  return error;
}

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

function snapshotReportPublicationBinding(binding) {
  const record = snapshotRecord(binding);
  const contractVersion = ownValue(record, "reportPublicationContractVersion");
  const publishReport = ownValue(record, "publishReport");
  if (contractVersion !== WINDOWS_REPORT_PUBLICATION_CONTRACT
      || typeof publishReport !== "function"
      || isProxy(publishReport)) {
    throw failure("WINDOWS_ATOMIC_PUBLISHER_UNAVAILABLE");
  }
  return Object.freeze({ publishReport: publishReport.bind(record) });
}

function createNativeReportPublisher(injectedBinding = null) {
  let nativePort = injectedBinding === null
    ? null
    : snapshotReportPublicationBinding(injectedBinding);
  const getNativePort = () => {
    if (nativePort !== null) return nativePort;
    try {
      nativePort = snapshotReportPublicationBinding(loadWindowsReportPublicationBinding());
      return nativePort;
    } catch (error) {
      if (error?.code === "WINDOWS_FILESYSTEM_UNSUPPORTED_PLATFORM") {
        throw failure("PLATFORM_UNSUPPORTED");
      }
      throw failure("WINDOWS_ATOMIC_PUBLISHER_UNAVAILABLE");
    }
  };
  const publishOwnerOnlyAtomic = async function publishOwnerOnlyAtomic(path, content) {
    if (typeof path !== "string" || path.length === 0) throw failure("INVALID_REQUEST");
    if (typeof content !== "string" && !Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
      throw failure("INVALID_REQUEST");
    }
    const byteLength = typeof content === "string"
      ? Buffer.byteLength(content, "utf8")
      : content.byteLength;
    if (byteLength > MAXIMUM_REPORT_BYTES) throw failure("REPORT_TOO_LARGE");
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const absolutePath = resolve(path);
    let port;
    try {
      port = getNativePort();
      await port.publishReport(absolutePath, bytes);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "";
      if (code === "WINDOWS_FILESYSTEM_REPORT_PUBLISH_COMMIT_UNCERTAIN"
          || code === "WINDOWS_FILESYSTEM_REPORT_PUBLISH_MUTEX_RELEASE_FAILED") {
        throw failure("COMMIT_UNCERTAIN");
      }
      if (code === "WINDOWS_FILESYSTEM_REPORT_PUBLISH_STAGE_CLEANUP_FAILED") {
        throw failure("CLEANUP_FAILED");
      }
      if (code.startsWith("OWNER_ONLY_ATOMIC_")) throw error;
      throw failure("PUBLICATION_FAILED");
    }
  };
  Object.defineProperty(publishOwnerOnlyAtomic, "assertAvailable", {
    enumerable: false,
    value: async function assertAvailable() {
      getNativePort();
    },
  });
  return Object.freeze(publishOwnerOnlyAtomic);
}

/**
 * Create an atomic single-file publisher over explicit filesystem and policy
 * ports. Supplying explicit filesystem/policy ports selects the synthetic
 * seam. The production default lazily loads the separately verified native
 * report-publication capability and has no JavaScript filesystem fallback.
 */
export function createOwnerOnlyAtomicFilePublisher(configuration = undefined) {
  const selected = configuration === undefined
    ? Object.freeze({})
    : snapshotRecord(configuration);
  const filesystemValue = ownValue(selected, "filesystem");
  const policyValue = ownValue(selected, "policy");
  const nativeBindingForTest = ownValue(selected, "nativeBindingForTest");
  if (nativeBindingForTest !== undefined) {
    if (nativeBindingForTest === null
        || filesystemValue !== undefined
        || policyValue !== undefined) {
      throw failure("INVALID_CONFIGURATION");
    }
    // This bypasses manifest verification only for isolated contract tests.
    return createNativeReportPublisher(nativeBindingForTest);
  }
  if (filesystemValue === undefined && policyValue === undefined) {
    return createNativeReportPublisher();
  }
  if (filesystemValue === undefined || policyValue === undefined) {
    throw failure("INVALID_CONFIGURATION");
  }
  const filesystem = snapshotRecord(filesystemValue);
  const policy = snapshotRecord(policyValue);
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
      // This injected synthetic policy may supplement mode bits. The native
      // production writer uses its own Windows DACL checks, not chmod.
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
