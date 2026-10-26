// Resolution of the previous index's published-snapshot pointer.
//
// Only the one-time cutover reads the previous index (for its ordinal map),
// and only to migrate, so this module resolves the file it should open and
// does nothing else: it never creates, writes or deletes.

import { lstatSync, readFileSync } from "node:fs";

import { open, rename } from "node:fs/promises";

import { basename, dirname, resolve, join } from "node:path";

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// Published snapshots.
//
// Publication replaces the live file by an atomic rename. POSIX lets readers
// keep the inode they opened, but Windows refuses to replace or delete a file
// while any SQLite connection holds it, in this process or any other. A long
// report read would otherwise decide whether new history can be published.
//
// When Windows refuses, the finished stage becomes an immutable snapshot beside
// the index and a small pointer file names it. Readers resolve the pointer when
// they open, so a reader keeps the snapshot it opened while later readers see
// the new one. Once a pointer exists every later publication is a new snapshot;
// returning to the plain file would need a second crash-ordered swap for no
// benefit. Superseded snapshots are deleted once nothing has them open.
const SNAPSHOT_POINTER_FORMAT = "usagemonitor-local-unified-index-pointer-v1";

const SNAPSHOT_POINTER_MAX_BYTES = 1024;

export function localUnifiedIndexPointerPath(indexFile) {
  return `${resolve(indexFile)}.current`;
}

function snapshotNamePattern(indexFile) {
  const escaped = basename(resolve(indexFile))
    .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped}\\.snapshot-([0-9a-z]{1,12})-[0-9a-f]{32}$`, "u");
}

function readSnapshotPointer(indexFile) {
  const pointer = localUnifiedIndexPointerPath(indexFile);
  let text;
  try {
    const metadata = lstatSync(pointer);
    if (!ownerOnlyRegularFile(metadata) || metadata.size > SNAPSHOT_POINTER_MAX_BYTES) {
      throw fixedError("local_unified_index_file_invalid");
    }
    text = readFileSync(pointer, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_unavailable");
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw fixedError("local_unified_index_file_invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "format,snapshot"
      || value.format !== SNAPSHOT_POINTER_FORMAT
      || typeof value.snapshot !== "string"
      || !snapshotNamePattern(indexFile).test(value.snapshot)) {
    throw fixedError("local_unified_index_file_invalid");
  }
  return value.snapshot;
}

/**
 * The physical file currently published for a logical index path: the
 * snapshot its pointer names, or the path itself when there is no pointer.
 * Resolve once per read and use the result for every check on that read.
 */
export function resolveLocalUnifiedIndexFile(indexFile) {
  const resolvedIndexFile = resolve(indexFile);
  const snapshot = readSnapshotPointer(resolvedIndexFile);
  return snapshot === null
    ? resolvedIndexFile
    : join(dirname(resolvedIndexFile), snapshot);
}

function ownerOnlyRegularFile(metadata) {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1;
}
