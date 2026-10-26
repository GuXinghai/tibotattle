import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createSourceFileAccess } from "./source-file-access.js";

const DEFAULT_FILE_SYSTEM = Object.freeze({
  allocate(size) {
    return Buffer.allocUnsafe(size);
  },
  lstat,
  open,
  realpath,
});
const WINDOWS_SOURCE_READ_CONTRACT = "windows-source-read-v1";
const WINDOWS_ID_PATTERN = /^[0-9a-f]{16}$/u;
const WINDOWS_FILE_ID_PATTERN = /^[0-9a-f]{32}$/u;

function failureContext(createError) {
  if (typeof createError !== "function") {
    throw new TypeError("createError must be a function");
  }
  const issued = new WeakSet();
  return Object.freeze({
    fail(code) {
      const error = createError(code);
      if (!(error instanceof Error)) {
        throw new TypeError("createError must return an Error");
      }
      issued.add(error);
      throw error;
    },
    issued(error) {
      return error instanceof Error && issued.has(error);
    },
  });
}

function assertPositiveSafeInteger(value, code, failures) {
  if (!Number.isSafeInteger(value) || value < 1) {
    failures.fail(code);
  }
}

function assertOwnerOnlyRegular(
  stats,
  label,
  maximumBytes,
  failures,
) {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    failures.fail(`${label}_not_regular`);
  }
  if (stats.nlink !== 1) failures.fail(`${label}_link_count`);
  if (
    !Number.isSafeInteger(stats.size)
    || stats.size < 1
    || stats.size > maximumBytes
  ) {
    failures.fail(`${label}_size`);
  }
  if (
    typeof process.getuid === "function"
    && stats.uid !== process.getuid()
  ) {
    failures.fail(`${label}_owner`);
  }
}

function assertOwnerControlledDirectory(stats, failures) {
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    failures.fail("parent_directory_type");
  }
  if (
    typeof process.getuid === "function"
    && stats.uid !== process.getuid()
  ) {
    failures.fail("parent_directory_owner");
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameReadVersion(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function parentSnapshot(canonicalPath, stats) {
  return Object.freeze({
    canonicalPath,
    dev: stats.dev,
    ino: stats.ino,
  });
}

function sameParentIdentity(snapshot, canonicalPath, stats) {
  return canonicalPath === snapshot.canonicalPath
    && stats.dev === snapshot.dev
    && stats.ino === snapshot.ino;
}

function validWindowsIdentity(identity) {
  return identity !== null
    && typeof identity === "object"
    && !Array.isArray(identity)
    && typeof identity.volumeSerialNumber === "string"
    && WINDOWS_ID_PATTERN.test(identity.volumeSerialNumber)
    && typeof identity.fileId === "string"
    && WINDOWS_FILE_ID_PATTERN.test(identity.fileId)
    && Number.isSafeInteger(identity.linkCount)
    && identity.linkCount >= 0;
}

function sameWindowsIdentity(identity, stats) {
  return validWindowsIdentity(identity)
    && stats?.dev === identity.volumeSerialNumber
    && stats?.ino === identity.fileId
    && stats?.nlink === identity.linkCount;
}

function assertWindowsAclEvidence(metadata, kind, label, failures) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
      || !validWindowsIdentity(metadata.identity)
      || typeof metadata.isDirectory !== "boolean"
      || typeof metadata.isRegularFile !== "boolean"
      || typeof metadata.isReparsePoint !== "boolean"
      || typeof metadata.ownerMatches !== "boolean"
      || typeof metadata.nullDacl !== "boolean"
      || typeof metadata.daclProtected !== "boolean"
      || typeof metadata.broadAccess !== "boolean"
      || typeof metadata.nonOwnerAllow !== "boolean"
      || typeof metadata.unrecognizedAce !== "boolean"
      || typeof metadata.finalPathResolved !== "boolean") {
    failures.fail("windows_protection_unavailable");
  }
  if (metadata.isReparsePoint !== false
      || metadata.ownerMatches !== true
      || metadata.nullDacl !== false
      || metadata.daclProtected !== true
      || metadata.broadAccess !== false
      || metadata.nonOwnerAllow !== false
      || metadata.unrecognizedAce !== false
      || metadata.finalPathResolved !== true) {
    failures.fail(`${label}_permissions`);
  }
  if (kind === "directory") {
    if (metadata.isDirectory !== true || metadata.isRegularFile !== false) {
      failures.fail("parent_directory_type");
    }
  } else if (metadata.isDirectory !== false
      || metadata.isRegularFile !== true
      || metadata.identity.linkCount !== 1) {
    failures.fail(`${label}_not_regular`);
  }
  return metadata.identity;
}

function validatedWindowsSourceAccess(sourceAccess, failures) {
  if (sourceAccess?.contractVersion !== WINDOWS_SOURCE_READ_CONTRACT
      || typeof sourceAccess.inspectPath !== "function"
      || typeof sourceAccess.open !== "function") {
    failures.fail("windows_protection_unavailable");
  }
  return sourceAccess;
}

async function inspectWindowsPath(sourceAccess, path, kind, label, failures) {
  let metadata;
  try {
    metadata = await sourceAccess.inspectPath(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "WINDOWS_FILESYSTEM_NOT_FOUND") {
      failures.fail(kind === "directory" ? "parent_directory" : `${label}_missing`);
    }
    failures.fail("windows_protection_unavailable");
  }
  return assertWindowsAclEvidence(metadata, kind, label, failures);
}

async function revalidateWindowsParent(sourceAccess, path, expected, failures) {
  const current = await inspectWindowsPath(sourceAccess, path, "directory", "parent", failures);
  if (current.volumeSerialNumber !== expected.volumeSerialNumber
      || current.fileId !== expected.fileId) {
    failures.fail("parent_directory_changed");
  }
}

async function readWindowsOwnerOnlyArtifact({
  sourceAccess,
  path,
  parentPath,
  parentIdentity,
  label,
  maximumBytes,
  failures,
  fileSystem,
}) {
  const pathIdentity = await inspectWindowsPath(sourceAccess, path, "file", label, failures);
  await revalidateWindowsParent(sourceAccess, parentPath, parentIdentity, failures);
  let handle;
  try {
    handle = await sourceAccess.open(path);
    const descriptorStats = await handle.stat();
    assertOwnerOnlyRegular(descriptorStats, label, maximumBytes, failures);
    if (!sameWindowsIdentity(pathIdentity, descriptorStats)) {
      failures.fail(`${label}_changed_during_open`);
    }
    const openedMetadata = await inspectWindowsPath(sourceAccess, path, "file", label, failures);
    if (openedMetadata.volumeSerialNumber !== pathIdentity.volumeSerialNumber
        || openedMetadata.fileId !== pathIdentity.fileId) {
      failures.fail(`${label}_changed_during_open`);
    }
    await revalidateWindowsParent(sourceAccess, parentPath, parentIdentity, failures);
    const bytes = await readExactDescriptorBytes(
      handle,
      descriptorStats,
      label,
      failures,
      fileSystem,
    );
    const postDescriptorStats = await handle.stat();
    assertOwnerOnlyRegular(postDescriptorStats, label, maximumBytes, failures);
    if (!sameReadVersion(descriptorStats, postDescriptorStats)) {
      failures.fail(`${label}_changed_during_read`);
    }
    const postMetadata = await inspectWindowsPath(sourceAccess, path, "file", label, failures);
    if (postMetadata.volumeSerialNumber !== pathIdentity.volumeSerialNumber
        || postMetadata.fileId !== pathIdentity.fileId) {
      failures.fail(`${label}_changed_during_read`);
    }
    await revalidateWindowsParent(sourceAccess, parentPath, parentIdentity, failures);
    return bytes;
  } catch (error) {
    if (failures.issued(error)) throw error;
    failures.fail(`${label}_read`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readWindowsOwnerOnlyPair({
  bundlePath,
  receiptPath,
  maximumBundleBytes,
  maximumReceiptBytes,
  sourceAccessFactory,
  failures,
  fileSystem,
}) {
  if (bundlePath.toLowerCase() === receiptPath.toLowerCase()) {
    failures.fail("paths_not_distinct");
  }
  let sourceAccess;
  try {
    if (typeof sourceAccessFactory !== "function") failures.fail("windows_protection_unavailable");
    sourceAccess = validatedWindowsSourceAccess(sourceAccessFactory(), failures);
  } catch (error) {
    if (failures.issued(error)) throw error;
    failures.fail("windows_protection_unavailable");
  }
  const bundleParentPath = dirname(bundlePath);
  const receiptParentPath = dirname(receiptPath);
  const bundleParentIdentity = await inspectWindowsPath(
    sourceAccess,
    bundleParentPath,
    "directory",
    "parent",
    failures,
  );
  const receiptParentIdentity = await inspectWindowsPath(
    sourceAccess,
    receiptParentPath,
    "directory",
    "parent",
    failures,
  );
  if (bundleParentIdentity.volumeSerialNumber !== receiptParentIdentity.volumeSerialNumber
      || bundleParentIdentity.fileId !== receiptParentIdentity.fileId) {
    failures.fail("paths_not_adjacent");
  }

  const receiptBytes = await readWindowsOwnerOnlyArtifact({
    sourceAccess,
    path: receiptPath,
    parentPath: receiptParentPath,
    parentIdentity: receiptParentIdentity,
    label: "receipt",
    maximumBytes: maximumReceiptBytes,
    failures,
    fileSystem,
  });
  const bundleBytes = await readWindowsOwnerOnlyArtifact({
    sourceAccess,
    path: bundlePath,
    parentPath: bundleParentPath,
    parentIdentity: bundleParentIdentity,
    label: "bundle",
    maximumBytes: maximumBundleBytes,
    failures,
    fileSystem,
  });
  return Object.freeze({ bundleBytes, receiptBytes });
}

function validatedFileSystem(fileSystem) {
  if (!fileSystem || typeof fileSystem !== "object") {
    throw new TypeError("fileSystem must be an object");
  }
  for (const name of ["allocate", "lstat", "open", "realpath"]) {
    if (typeof fileSystem[name] !== "function") {
      throw new TypeError(`fileSystem.${name} must be a function`);
    }
  }
  return fileSystem;
}

async function inspectParent(parentPath, failures, fileSystem) {
  try {
    const canonicalPath = await fileSystem.realpath(parentPath);
    const stats = await fileSystem.lstat(canonicalPath);
    assertOwnerControlledDirectory(stats, failures);
    return parentSnapshot(canonicalPath, stats);
  } catch (error) {
    if (failures.issued(error)) throw error;
    failures.fail("parent_directory");
  }
}

async function revalidateParent(
  requestedParentPath,
  snapshot,
  failures,
  fileSystem,
) {
  try {
    const canonicalPath = await fileSystem.realpath(requestedParentPath);
    const stats = await fileSystem.lstat(canonicalPath);
    assertOwnerControlledDirectory(stats, failures);
    if (!sameParentIdentity(snapshot, canonicalPath, stats)) {
      failures.fail("parent_directory_changed");
    }
  } catch (error) {
    if (failures.issued(error)) throw error;
    failures.fail("parent_directory_changed");
  }
}

function allocateExact(size, fileSystem) {
  const bytes = fileSystem.allocate(size);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
    throw new TypeError(
      "fileSystem.allocate must return exact Uint8Array storage",
    );
  }
  return bytes;
}

async function readExactDescriptorBytes(
  handle,
  descriptorStats,
  label,
  failures,
  fileSystem,
) {
  const expectedSize = descriptorStats.size;
  const bytes = allocateExact(expectedSize, fileSystem);
  let offset = 0;
  while (offset < expectedSize) {
    const requestedBytes = expectedSize - offset;
    const result = await handle.read(
      bytes,
      offset,
      requestedBytes,
      offset,
    );
    if (
      !result
      || !Number.isSafeInteger(result.bytesRead)
      || result.bytesRead < 0
      || result.bytesRead > requestedBytes
      || result.bytesRead === 0
    ) {
      failures.fail(`${label}_changed_during_read`);
    }
    offset += result.bytesRead;
  }

  const growthProbe = allocateExact(1, fileSystem);
  const probeResult = await handle.read(
    growthProbe,
    0,
    1,
    expectedSize,
  );
  if (
    !probeResult
    || !Number.isSafeInteger(probeResult.bytesRead)
    || probeResult.bytesRead < 0
    || probeResult.bytesRead > 1
  ) {
    failures.fail(`${label}_read`);
  }
  if (probeResult.bytesRead !== 0) {
    failures.fail(`${label}_changed_during_read`);
  }
  return bytes;
}

async function readOwnerOnlyArtifact(
  path,
  requestedParentPath,
  parent,
  label,
  maximumBytes,
  failures,
  fileSystem,
) {
  await revalidateParent(
    requestedParentPath,
    parent,
    failures,
    fileSystem,
  );
  let pathStats;
  try {
    pathStats = await fileSystem.lstat(path);
  } catch {
    failures.fail(`${label}_missing`);
  }
  assertOwnerOnlyRegular(pathStats, label, maximumBytes, failures);
  let handle;
  try {
    handle = await fileSystem.open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const descriptorStats = await handle.stat();
    assertOwnerOnlyRegular(
      descriptorStats,
      label,
      maximumBytes,
      failures,
    );
    if (!sameReadVersion(descriptorStats, pathStats)) {
      failures.fail(`${label}_changed_during_open`);
    }
    await revalidateParent(
      requestedParentPath,
      parent,
      failures,
      fileSystem,
    );
    const bytes = await readExactDescriptorBytes(
      handle,
      descriptorStats,
      label,
      failures,
      fileSystem,
    );
    const postDescriptorStats = await handle.stat();
    assertOwnerOnlyRegular(
      postDescriptorStats,
      label,
      maximumBytes,
      failures,
    );
    if (!sameReadVersion(descriptorStats, postDescriptorStats)) {
      failures.fail(`${label}_changed_during_read`);
    }
    const postPathStats = await fileSystem.lstat(path);
    assertOwnerOnlyRegular(
      postPathStats,
      label,
      maximumBytes,
      failures,
    );
    if (!sameReadVersion(postDescriptorStats, postPathStats)) {
      failures.fail(`${label}_changed_during_read`);
    }
    await revalidateParent(
      requestedParentPath,
      parent,
      failures,
      fileSystem,
    );
    return bytes;
  } catch (error) {
    if (failures.issued(error)) throw error;
    failures.fail(`${label}_read`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createOwnerOnlyLocalMetadataBundlePairReader({
  fileSystem = DEFAULT_FILE_SYSTEM,
  platform = process.platform,
  windowsSourceAccessFactory = null,
} = {}) {
  const files = validatedFileSystem(fileSystem);
  if (typeof platform !== "string") throw new TypeError("platform must be a string");
  return async function readOwnerOnlyLocalMetadataBundlePair({
    bundleFile,
    receiptFile,
    maximumBundleBytes,
    maximumReceiptBytes,
    createError,
  } = {}) {
    const failures = failureContext(createError);
    assertPositiveSafeInteger(
      maximumBundleBytes,
      "maximum_bundle_bytes",
      failures,
    );
    assertPositiveSafeInteger(
      maximumReceiptBytes,
      "maximum_receipt_bytes",
      failures,
    );
    if (!bundleFile || !receiptFile) failures.fail("paths_required");
    const bundlePath = resolve(bundleFile);
    const receiptPath = resolve(receiptFile);
    if (bundlePath === receiptPath) failures.fail("paths_not_distinct");
    if (platform === "win32") {
      return readWindowsOwnerOnlyPair({
        bundlePath,
        receiptPath,
        maximumBundleBytes,
        maximumReceiptBytes,
        sourceAccessFactory: windowsSourceAccessFactory,
        failures,
        fileSystem: files,
      });
    }

    const bundleParentPath = dirname(bundlePath);
    const receiptParentPath = dirname(receiptPath);
    const bundleParent = await inspectParent(
      bundleParentPath,
      failures,
      files,
    );
    const receiptParent = await inspectParent(
      receiptParentPath,
      failures,
      files,
    );
    if (bundleParent.canonicalPath !== receiptParent.canonicalPath) {
      failures.fail("paths_not_adjacent");
    }
    if (
      bundleParent.dev !== receiptParent.dev
      || bundleParent.ino !== receiptParent.ino
    ) {
      failures.fail("parent_directory_changed");
    }
    await revalidateParent(
      bundleParentPath,
      bundleParent,
      failures,
      files,
    );
    const canonicalBundlePath = join(
      bundleParent.canonicalPath,
      basename(bundlePath),
    );
    const canonicalReceiptPath = join(
      receiptParent.canonicalPath,
      basename(receiptPath),
    );

    const receiptBytes = await readOwnerOnlyArtifact(
      canonicalReceiptPath,
      receiptParentPath,
      bundleParent,
      "receipt",
      maximumReceiptBytes,
      failures,
      files,
    );
    const bundleBytes = await readOwnerOnlyArtifact(
      canonicalBundlePath,
      bundleParentPath,
      bundleParent,
      "bundle",
      maximumBundleBytes,
      failures,
      files,
    );
    return Object.freeze({ bundleBytes, receiptBytes });
  };
}

export const readOwnerOnlyLocalMetadataBundlePair =
  createOwnerOnlyLocalMetadataBundlePairReader({
    platform: process.platform,
    // The default Windows path stays lazy and fail-closed. Every caller of the
    // shared platform facade therefore uses the same native ACL/handle reader.
    windowsSourceAccessFactory: () => createSourceFileAccess({ platform: "win32" }),
  });
