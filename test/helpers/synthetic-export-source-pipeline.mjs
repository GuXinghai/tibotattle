import { constants, lstatSync } from "node:fs";
import { lstat, open } from "node:fs/promises";

import {
  createExportCompatibilityContext,
  createLocalExportSourcePipelineContext,
} from "../../src/application/index.js";
import { localExportWorkspace } from "../../src/local-node-runtime.js";
import {
  createLocalExportSourcePorts,
  localIsProxy,
  readExportCompatibilityArtifactSet,
  sha256Hex,
} from "../../src/platform/index.js";

const exportCompatibilityTuple = createExportCompatibilityContext({
  readExportCompatibilityArtifactSet,
  sha256Hex,
}).exportCompatibilityTuple;

function fixedHex(value, width) {
  const hex = BigInt(value).toString(16);
  if (hex.length > width) throw new Error("synthetic_source_identity_out_of_range");
  return hex.padStart(width, "0");
}

function assertSyntheticRegularFile(stats) {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1n) {
    const error = new Error("synthetic_source_reparse_or_link");
    error.code = "WINDOWS_FILESYSTEM_REPARSE_POINT";
    throw error;
  }
}

function fileStats(stats, identity) {
  return Object.freeze({
    dev: identity.volumeSerialNumber,
    ino: identity.fileId,
    nlink: identity.linkCount,
    size: Number(stats.size),
    birthtimeMs: Number(stats.birthtimeMs),
    mtimeMs: Number(stats.mtimeMs),
    ctimeMs: Number(stats.ctimeMs),
    isFile: () => stats.isFile(),
    isSymbolicLink: () => stats.isSymbolicLink(),
    isDirectory: () => stats.isDirectory(),
  });
}

export function createSyntheticWindowsSourceFileAccess({
  identity = null,
  ownerMatches = true,
  onOpen = () => {},
  onClose = () => {},
  onRead = () => {},
} = {}) {
  const syntheticIdentityByFile = new Map();
  let nextSyntheticFileId = 1n;
  function selectedIdentity(stats) {
    if (identity) return Object.freeze({ ...identity, linkCount: 1 });
    const key = `${stats.dev}:${stats.ino}`;
    let fileId = syntheticIdentityByFile.get(key);
    if (fileId === undefined) {
      fileId = nextSyntheticFileId;
      nextSyntheticFileId += 1n;
      syntheticIdentityByFile.set(key, fileId);
    }
    return Object.freeze({
      volumeSerialNumber: "0000000000000001",
      fileId: fixedHex(fileId, 32),
      linkCount: 1,
    });
  }
  return Object.freeze({
    contractVersion: "windows-source-read-v1",
    inspectPath(path) {
      const stats = lstatSync(path, { bigint: true });
      const selected = selectedIdentity(stats);
      return Object.freeze({
        identity: selected,
        isDirectory: stats.isDirectory(),
        isRegularFile: stats.isFile(),
        isReparsePoint: stats.isSymbolicLink(),
        ownerMatches,
        finalPathResolved: true,
      });
    },
    async open(path) {
      const pathStats = await lstat(path, { bigint: true });
      assertSyntheticRegularFile(pathStats);
      const handle = await open(path, constants.O_RDONLY);
      onOpen();
      let closed = false;
      try {
        const descriptorStats = await handle.stat({ bigint: true });
        const currentPathStats = await lstat(path, { bigint: true });
        assertSyntheticRegularFile(currentPathStats);
        const pathIdentity = selectedIdentity(pathStats);
        const descriptorIdentity = selectedIdentity(descriptorStats);
        const currentPathIdentity = selectedIdentity(currentPathStats);
        if (pathIdentity.volumeSerialNumber !== descriptorIdentity.volumeSerialNumber
            || pathIdentity.fileId !== descriptorIdentity.fileId
            || descriptorIdentity.volumeSerialNumber !== currentPathIdentity.volumeSerialNumber
            || descriptorIdentity.fileId !== currentPathIdentity.fileId) {
          throw Object.assign(new Error("synthetic_source_identity_changed"), { code: "WINDOWS_FILESYSTEM_OPERATION_FAILED" });
        }
        return Object.freeze({
          async stat() {
            const stats = await handle.stat({ bigint: true });
            return fileStats(stats, selectedIdentity(stats));
          },
          async read(buffer, offset, length, position) {
            onRead(length);
            return handle.read(buffer, offset, length, position);
          },
          async close() {
            if (closed) return;
            closed = true;
            try { await handle.close(); } finally { onClose(); }
          },
        });
      } catch (error) {
        try { await handle.close(); } catch { /* preserve the refusal */ }
        onClose();
        throw error;
      }
    },
  });
}

export function createSyntheticExportSourcePipeline(options = {}) {
  const ports = createLocalExportSourcePorts({
    platform: "win32",
    sourceFileAccessFactory: () => createSyntheticWindowsSourceFileAccess(options),
  });
  return createLocalExportSourcePipelineContext(localIsProxy, ports, {
    workspace: localExportWorkspace,
    exportCompatibilityTuple,
  });
}
