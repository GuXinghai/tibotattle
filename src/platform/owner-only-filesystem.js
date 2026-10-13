import { lstat } from "node:fs/promises";

/**
 * Shared, low-level filesystem guards for owner-only local artifacts.
 * Consumers retain their public contracts; this module deliberately owns only
 * the canonical directory and inode primitives so those checks cannot drift.
 */

/**
 * Node cannot open a directory handle for fsync on Windows. Every caller has
 * already flushed the artifact itself before this durability barrier, so the
 * directory-entry flush is an explicit no-op on this Windows-only product.
 */
export async function syncDirectory() {}

export async function assertOwnerControlledDirectory(path) {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Export destination must be a real directory");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("Export destination must be owned by the current user");
  }
}

export async function lstatIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
