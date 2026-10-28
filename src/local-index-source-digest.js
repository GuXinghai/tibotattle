import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";

// Consistency model for append-only rollout files.
//
// Assumptions: Codex only appends whole lines; any write moves the change
// time; a replaced file has a different identity. Under them a source is fully
// described by its stat tuple plus four digests: the head (first 4 KiB), the
// boundary (the 4 KiB before the cursor), the open tail (the scanned bytes
// after the last complete segment, below one segment) and one SHA-256 per
// complete segment of the scanned prefix. Stat, head, boundary and tail are
// checked whenever a source has grown, so an edit anywhere in the newest
// segment is caught before facts are appended. Complete segments are verified
// later, off the hot path. An edit that preserves size, mtime and ctime
// together is outside the model and is found only by a manual full
// verification.

export const SEGMENT_BYTES = 256 * 1024;
export const WINDOW_BYTES = 4096;

function sha256() {
  return createHash("sha256");
}

async function readExactly(handle, start, length) {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
    if (bytesRead === 0) return null;
    filled += bytesRead;
  }
  return buffer;
}

/** Digest of exactly `[start, start + length)`, or null if the file is shorter. */
export async function digestRange(handle, start, length) {
  if (length === 0) return null;
  const hash = sha256();
  const chunk = Buffer.allocUnsafe(Math.min(length, 1024 * 1024));
  let position = start;
  const end = start + length;
  while (position < end) {
    const want = Math.min(chunk.length, end - position);
    const { bytesRead } = await handle.read(chunk, 0, want, position);
    if (bytesRead === 0) return null;
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest();
}

/** Head, boundary and open-tail digests for a scanned prefix. */
export async function digestWindows(handle, scannedBytes) {
  if (scannedBytes === 0) return { head: null, boundary: null, tail: null };
  const head = await digestRange(handle, 0, Math.min(WINDOW_BYTES, scannedBytes));
  const boundaryStart = Math.max(0, scannedBytes - WINDOW_BYTES);
  const boundary = await digestRange(handle, boundaryStart, scannedBytes - boundaryStart);
  const tailStart = Math.floor(scannedBytes / SEGMENT_BYTES) * SEGMENT_BYTES;
  const tail = tailStart === scannedBytes
    ? null
    : await digestRange(handle, tailStart, scannedBytes - tailStart);
  return { head, boundary, tail };
}

/** True when the stored head, boundary and tail still match the file's bytes. */
export async function windowsMatch(handle, row) {
  const scanned = Number(row.scanned_bytes);
  if (scanned === 0) return true;
  if (row.head_digest === null || row.boundary_digest === null) return false;
  const { head, boundary, tail } = await digestWindows(handle, scanned);
  const same = (actual, stored) => (actual === null && stored === null)
    || (actual !== null && stored !== null
      && Buffer.compare(actual, Buffer.from(stored)) === 0);
  return head !== null && boundary !== null
    && same(head, row.head_digest)
    && same(boundary, row.boundary_digest)
    && same(tail, row.tail_digest ?? null);
}

/**
 * Wrap a file handle so the bytes the extractor already reads feed the segment
 * hashers. Reads must be sequential from `startOffset`; a discontinuity
 * disables hashing rather than recording a wrong digest. `finish` returns the
 * complete segments that lie wholly below `scannedBytes`.
 */
export async function createSegmentTap(handle, { startOffset = 0 } = {}) {
  let position = startOffset;
  let broken = false;
  let hash = null;
  let segment = Math.floor(startOffset / SEGMENT_BYTES);
  const completed = new Map();
  if (startOffset % SEGMENT_BYTES !== 0) {
    // Re-hash the part of the open segment that earlier scans left unrecorded.
    const segmentStart = segment * SEGMENT_BYTES;
    const prefix = await readExactly(handle, segmentStart, startOffset - segmentStart);
    if (prefix === null) {
      broken = true;
    } else {
      hash = sha256();
      hash.update(prefix);
    }
  } else {
    hash = sha256();
  }

  function feed(buffer, length) {
    let offset = 0;
    while (offset < length) {
      const segmentEnd = (segment + 1) * SEGMENT_BYTES;
      const take = Math.min(length - offset, segmentEnd - position);
      hash.update(buffer.subarray(offset, offset + take));
      offset += take;
      position += take;
      if (position === segmentEnd) {
        completed.set(segment, hash.digest());
        segment += 1;
        hash = sha256();
      }
    }
  }

  return {
    handle: {
      stat: () => handle.stat(),
      async read(buffer, offset, length, readPosition) {
        const result = await handle.read(buffer, offset, length, readPosition);
        if (!broken && result.bytesRead > 0) {
          if (readPosition !== position) {
            broken = true;
          } else {
            feed(buffer.subarray(offset), result.bytesRead);
          }
        }
        return result;
      },
    },
    /** Complete segments below `scannedBytes`, or null if hashing was disrupted. */
    finish(scannedBytes) {
      if (broken) return null;
      const limit = Math.floor(scannedBytes / SEGMENT_BYTES);
      const result = new Map();
      for (const [index, digest] of completed) {
        if (index < limit) result.set(index, digest);
      }
      return result;
    },
  };
}

/**
 * Re-read the complete segments of `[0, scannedBytes)` and compare them with
 * the stored digests. Returns the first mismatching segment index, or -1.
 * A missing stored digest counts as a mismatch.
 */
export async function verifySegments(handle, storedSegments, scannedBytes, { signal = null } = {}) {
  const complete = Math.floor(scannedBytes / SEGMENT_BYTES);
  for (let index = 0; index < complete; index += 1) {
    signal?.throwIfAborted();
    const stored = storedSegments.get(index);
    if (stored === undefined) return index;
    const actual = await digestRange(handle, index * SEGMENT_BYTES, SEGMENT_BYTES);
    if (actual === null || Buffer.compare(actual, Buffer.from(stored)) !== 0) return index;
  }
  return -1;
}

const VERIFY_STABLE_MS = 10 * 60_000;
const VERIFY_MINIMUM_INTERVAL_MS = 24 * 60 * 60_000;
const VERIFY_MAXIMUM_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * Whether the complete segments of a source are due for re-verification.
 *
 * Segments recorded at ingest match the facts by construction. They can only
 * be stale if the closed bytes were edited and the file also grew, so a
 * source is eligible once it has grown since its last verification, has been
 * stable for ten minutes and was last verified over a day ago, and always
 * after seven days.
 */
export function needsSegmentVerification(row, nowMs, { force = false } = {}) {
  const scanned = Number(row.scanned_bytes);
  if (scanned < SEGMENT_BYTES || row.quarantine_code !== null) return false;
  if (force) return true;
  const verifiedAt = row.verified_at_ms === null ? 0 : Number(row.verified_at_ms);
  const age = nowMs - verifiedAt;
  if (age >= VERIFY_MAXIMUM_AGE_MS) return true;
  const grew = scanned > Number(row.verified_bytes);
  const stable = nowMs - Number(row.mtime_ms) >= VERIFY_STABLE_MS;
  return grew && stable && age >= VERIFY_MINIMUM_INTERVAL_MS;
}

/**
 * The exact "device:inode" of a file, or null when the platform reports none.
 *
 * Node reports ids as doubles unless asked for BigInt, and NTFS file ids use
 * up to 64 bits (a 48-bit record number plus a 16-bit sequence), so ids with a
 * sequence of 32 or more exceed 2^53 and adjacent records round to the same
 * double. A double below 2^53 is exact; only larger ones need a BigInt stat.
 */
function numericFileId(info) {
  const dev = Number(info.dev);
  const ino = Number(info.ino);
  if (!Number.isSafeInteger(dev) || dev < 0 || !Number.isFinite(ino) || ino <= 0) return null;
  return Number.isSafeInteger(ino) ? `${dev}:${ino}` : undefined;
}

/**
 * Map each discovered path to its exact file id. Ids that doubles hold exactly
 * are formatted directly; the rest are read once more with BigInt precision
 * and accepted only if they round to the id discovery saw, so a file replaced
 * in between is reported as having no usable identity (`null`).
 */
export async function resolveFileIds(infos, { concurrency = 16, statBigint = defaultStatBigint } = {}) {
  const fileIds = new Map();
  const pending = [];
  for (const info of infos) {
    const direct = numericFileId(info);
    if (direct === undefined) pending.push(info);
    else fileIds.set(info.path, direct);
  }
  let next = 0;
  async function worker() {
    while (next < pending.length) {
      const info = pending[next];
      next += 1;
      fileIds.set(info.path, null);
      try {
        const exact = await statBigint(info.path);
        if (exact.ino > 0n
            && Number(exact.ino) === Number(info.ino)
            && Number(exact.dev) === Number(info.dev)) {
          fileIds.set(info.path, `${exact.dev}:${exact.ino}`);
        }
      } catch {
        // An unreadable path keeps no identity; the source is then rescanned.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return fileIds;
}

function defaultStatBigint(path) {
  return lstat(path, { bigint: true });
}

function identityMatches(info, row) {
  if (typeof info.fileId !== "string" || row.file_id === null || row.file_id !== info.fileId) {
    return false;
  }
  if (!Number.isFinite(Number(info.birthtimeMs))) return false;
  return Math.trunc(Number(row.birthtime_ms)) === Math.trunc(Number(info.birthtimeMs));
}

/**
 * Decide what a refresh must do for one source from its stat tuple alone.
 *
 * - `new`: no catalog row.
 * - `skip` / `quarantined`: nothing changed.
 * - `append`: the file grew; the caller must confirm the head and boundary
 *   windows before resuming (`windowsMatch`), otherwise rescan.
 * - `rescan`: replacement, shrink, same-size change, parser change, or a
 *   cursor that does not describe the file.
 */
export function classifyFromStat(info, row, expectedParserVersion) {
  if (row === undefined) return { mode: "new" };
  if (row.parser_version !== expectedParserVersion) {
    return { mode: "rescan", reason: "parser_version" };
  }
  if (!identityMatches(info, row)) return { mode: "rescan", reason: "identity_changed" };
  const size = Number(info.size ?? 0);
  const rowSize = Number(row.size_bytes);
  const scanned = Number(row.scanned_bytes);
  const quarantined = row.quarantine_code !== null;
  const deferred = rowSize - scanned;
  if (scanned > rowSize
      || (!quarantined && scanned !== rowSize
        && !(deferred > 0 && Number(row.deferred_tail_bytes) === deferred))
      || (quarantined && scanned !== 0)) {
    return { mode: "rescan", reason: "cursor_invalid" };
  }
  if (size === rowSize) {
    const same = Number(row.mtime_ms) === Number(info.mtimeMs)
      && Number(row.ctime_ms) === Number(info.ctimeMs);
    if (!same) return { mode: "rescan", reason: "same_size_changed" };
    return quarantined
      ? { mode: "quarantined", reason: row.quarantine_code }
      : { mode: "skip" };
  }
  if (size > rowSize) {
    if (info.compressed === true) return { mode: "rescan", reason: "compressed_changed" };
    if (quarantined) return { mode: "rescan", reason: "quarantine_changed" };
    return { mode: "append" };
  }
  return { mode: "rescan", reason: "shrink" };
}
