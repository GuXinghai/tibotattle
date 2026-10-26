import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import { constants } from "node:fs";
import { lstat as nodeLstat, open as nodeOpen } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isProxy } from "node:util/types";

import { readBoundedUtf8LineEntries } from "./bounded-jsonl-reader.js";
import { createLocalCodexLogPorts } from "./local-codex-log-ports.js";
import {
  deriveAccountScopeId,
  deriveEventOccurrenceId,
  deriveMarkerOccurrenceId,
  deriveModelFingerprint,
  deriveParticipantId,
  deriveQuotaStateId,
  deriveSessionScopeId,
  deriveSnapshotObservationId,
} from "./participant-identity.js";

import { exactLstat, exactOpen } from "./exact-filesystem-stats.js";
import { createSourceFileAccess } from "./source-file-access.js";

const CODEX_ENVIRONMENT_KEYS = Object.freeze(["CODEX_HOME"]);

export function localPlatformName() {
  return process.platform === "win32" ? "windows" : "other";
}

export const localIsProxy = isProxy;

function invalid() {
  throw new TypeError("local export-source platform configuration is invalid");
}

function ownData(configuration, key, fallback) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(configuration, key);
    if (descriptor === undefined) return fallback;
    if (!Object.hasOwn(descriptor, "value")) invalid();
    return descriptor.value === undefined ? fallback : descriptor.value;
  } catch {
    invalid();
  }
}

function snapshotEnvironment(environment, keys) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)
      || isProxy(environment)) invalid();
  const snapshot = {};
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(environment, key);
      if (descriptor === undefined) continue;
      if (!Object.hasOwn(descriptor, "value")
          || (descriptor.value !== undefined && typeof descriptor.value !== "string")) invalid();
      if (descriptor.value !== undefined) snapshot[key] = descriptor.value;
    }
  } catch {
    invalid();
  }
  return Object.freeze(snapshot);
}

const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
const UINT128_MAX = 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn;
const WINDOWS_NATIVE_READ_BYTES = 64 * 1024;
// This is the active append-proof ceiling used by the Codex source reader.
const WINDOWS_MAXIMUM_CODEX_RANGE_BYTES = 8 * 1024 * 1024;
const WINDOWS_MAXIMUM_CODEX_LINE_BYTES = 8 * 1024 * 1024;

function windowsMetadataIdentity(metadata) {
  const identity = metadata?.identity;
  if (!identity || typeof identity !== "object"
      || typeof identity.volumeSerialNumber !== "string"
      || !/^[0-9a-f]{16}$/u.test(identity.volumeSerialNumber)
      || typeof identity.fileId !== "string"
      || !/^[0-9a-f]{32}$/u.test(identity.fileId)
      || !Number.isSafeInteger(identity.linkCount) || identity.linkCount < 0
      || metadata.ownerMatches !== true
      || metadata.finalPathResolved !== true) {
    throw Object.assign(new Error("windows_source_metadata_unavailable"), {
      code: "WINDOWS_FILESYSTEM_OPERATION_FAILED",
    });
  }
  if (metadata.isReparsePoint === true) {
    throw Object.assign(new Error("windows_source_reparse_point"), {
      code: "WINDOWS_FILESYSTEM_REPARSE_POINT",
    });
  }
  if (metadata.isRegularFile !== true || metadata.isReparsePoint !== false) {
    throw Object.assign(new Error("windows_source_metadata_unavailable"), {
      code: "WINDOWS_FILESYSTEM_OPERATION_FAILED",
    });
  }
  const dev = BigInt(`0x${identity.volumeSerialNumber}`);
  const ino = BigInt(`0x${identity.fileId}`);
  if (identity.linkCount !== 1 || dev > UINT64_MAX || ino > UINT128_MAX) {
    throw Object.assign(new Error("windows_source_identity_out_of_range"), {
      code: "WINDOWS_FILESYSTEM_OPERATION_FAILED",
    });
  }
  return Object.freeze({ dev: dev.toString(10), ino: ino.toString(10) });
}

function sourceStatsFromWindowsHandle(stats) {
  if (!stats || typeof stats !== "object"
      || typeof stats.dev !== "string" || !/^[0-9a-f]{16}$/u.test(stats.dev)
      || typeof stats.ino !== "string" || !/^[0-9a-f]{32}$/u.test(stats.ino)
      || !Number.isSafeInteger(stats.nlink) || stats.nlink !== 1
      || !Number.isSafeInteger(stats.size) || stats.size < 0
      || !Number.isFinite(stats.birthtimeMs)
      || !Number.isFinite(stats.mtimeMs)
      || !Number.isFinite(stats.ctimeMs)) {
    throw Object.assign(new Error("windows_source_metadata_unavailable"), {
      code: "WINDOWS_FILESYSTEM_OPERATION_FAILED",
    });
  }
  const dev = BigInt(`0x${stats.dev}`);
  const ino = BigInt(`0x${stats.ino}`);
  if (dev > UINT64_MAX || ino > UINT128_MAX) {
    throw Object.assign(new Error("windows_source_identity_out_of_range"), {
      code: "WINDOWS_FILESYSTEM_OPERATION_FAILED",
    });
  }
  return Object.freeze({
    dev: dev.toString(10),
    ino: ino.toString(10),
    nlink: stats.nlink,
    size: stats.size,
    birthtimeMs: stats.birthtimeMs,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    uid: undefined,
    mode: undefined,
    isFile: () => true,
    isSymbolicLink: () => false,
    isDirectory: () => false,
  });
}

function sameExactIdentity(left, right) {
  return left?.dev !== undefined && right?.dev !== undefined
    && left?.ino !== undefined && right?.ino !== undefined
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino);
}

export function createLocalExportSourcePorts(configuration = {}) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)
      || isProxy(configuration)) invalid();
  const configuredEnvironment = ownData(configuration, "environment", process.env);
  const homeDirectory = ownData(configuration, "homeDirectory", homedir());
  const platform = ownData(configuration, "platform", process.platform);
  const configuredSourceFileAccessFactory = ownData(configuration, "sourceFileAccessFactory", null);
  if (typeof homeDirectory !== "string" || typeof platform !== "string") invalid();
  if (configuredSourceFileAccessFactory !== null
      && typeof configuredSourceFileAccessFactory !== "function") invalid();
  const codexEnvironment = snapshotEnvironment(configuredEnvironment, CODEX_ENVIRONMENT_KEYS);
  let windowsSourceAccess = null;
  function windowsSourceReader() {
    if (platform !== "win32") invalid();
    if (windowsSourceAccess === null) {
      const factory = configuredSourceFileAccessFactory
        ?? (() => createSourceFileAccess({ platform: "win32" }));
      const selected = factory();
      if (selected?.contractVersion !== "windows-source-read-v1"
          || typeof selected.inspectPath !== "function"
          || typeof selected.open !== "function") invalid();
      windowsSourceAccess = selected;
    }
    return windowsSourceAccess;
  }
  async function openWindowsSource(path) {
    const adapter = windowsSourceReader();
    const before = windowsMetadataIdentity(adapter.inspectPath(path));
    const handle = await adapter.open(path);
    try {
      const firstStats = sourceStatsFromWindowsHandle(await handle.stat());
      if (!sameExactIdentity(before, firstStats)) {
        throw Object.assign(new Error("windows_source_identity_changed"), {
          code: "WINDOWS_FILESYSTEM_OPERATION_FAILED",
        });
      }
      const after = windowsMetadataIdentity(adapter.inspectPath(path));
      if (!sameExactIdentity(firstStats, after)) {
        throw Object.assign(new Error("windows_source_identity_changed"), {
          code: "WINDOWS_FILESYSTEM_OPERATION_FAILED",
        });
      }
      let closed = false;
      return Object.freeze({
        async stat() {
          if (closed) throw Object.assign(new Error("source_file_closed"), {
            code: "WINDOWS_FILESYSTEM_OPERATION_FAILED",
          });
          const current = sourceStatsFromWindowsHandle(await handle.stat());
          if (!sameExactIdentity(firstStats, current)) {
            throw Object.assign(new Error("windows_source_identity_changed"), {
              code: "WINDOWS_FILESYSTEM_OPERATION_FAILED",
            });
          }
          return current;
        },
        async read(buffer, offset, length, position) {
          if (closed) throw Object.assign(new Error("source_file_closed"), {
            code: "WINDOWS_FILESYSTEM_OPERATION_FAILED",
          });
          return handle.read(buffer, offset, length, position);
        },
        async close() {
          if (closed) return;
          closed = true;
          await handle.close();
        },
      });
    } catch (error) {
      try { await handle.close(); } catch { /* preserve the refusal */ }
      throw error;
    }
  }
  const windowsLstat = async (path) => {
    const handle = await openWindowsSource(path);
    try {
      return await handle.stat();
    } finally {
      await handle.close();
    }
  };
  const windowsOpen = async (path, flags) => {
    const readOnlyFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    if (flags !== readOnlyFlags) invalid();
    return openWindowsSource(path);
  };
  const windowsCodexStat = windowsLstat;
  const windowsCodexOpen = async (path) => {
    const handle = await openWindowsSource(path);
    return Object.freeze({
      stat: () => handle.stat(),
      read: (...arguments_) => handle.read(...arguments_),
      close: () => handle.close(),
    });
  };
  async function* windowsUtf8Range(path, { start, end }) {
    if (!Number.isSafeInteger(start) || start < 0
        || !Number.isSafeInteger(end) || end < start
        || end - start + 1 > WINDOWS_MAXIMUM_CODEX_RANGE_BYTES) {
      throw new TypeError("Codex source byte range is invalid");
    }
    const handle = await windowsCodexOpen(path);
    const decoder = new StringDecoder("utf8");
    try {
      const stats = await handle.stat();
      const last = Math.min(end, stats.size - 1);
      let position = start;
      const buffer = Buffer.allocUnsafe(WINDOWS_NATIVE_READ_BYTES);
      while (position <= last) {
        const requested = Math.min(buffer.length, last - position + 1);
        const { bytesRead } = await handle.read(buffer, 0, requested, position);
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > requested) {
          throw Object.assign(new Error("windows_source_read_changed"), {
            code: "WINDOWS_FILESYSTEM_OPERATION_FAILED",
          });
        }
        const text = decoder.write(buffer.subarray(0, bytesRead));
        if (text) yield text;
        position += bytesRead;
      }
      const tail = decoder.end();
      if (tail) yield tail;
    } finally {
      await handle.close();
    }
  }
  async function* windowsUtf8LinesRange(path, range) {
    const pending = [];
    let pendingBytes = 0;
    for await (const chunk of windowsUtf8Range(path, range)) {
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf("\n", start);
        const end = newline < 0 ? chunk.length : newline;
        const segment = chunk.slice(start, end);
        pendingBytes += Buffer.byteLength(segment, "utf8");
        if (pendingBytes > WINDOWS_MAXIMUM_CODEX_LINE_BYTES) {
          throw Object.assign(new Error("windows_source_line_limit"), {
            code: "WINDOWS_FILESYSTEM_OPERATION_FAILED",
          });
        }
        if (segment.length > 0) pending.push(segment);
        if (newline < 0) break;
        let line = pending.join("");
        if (line.endsWith("\r")) line = line.slice(0, -1);
        yield line;
        pending.length = 0;
        pendingBytes = 0;
        start = newline + 1;
      }
    }
    if (pending.length > 0) {
      let line = pending.join("");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      yield line;
    }
  }
  const lstat = platform === "win32"
    ? windowsLstat
    : nodeLstat;
  const open = platform === "win32"
    ? windowsOpen
    : nodeOpen;
  const exactSourceLstat = platform === "win32"
    ? lstat
    : (path) => exactLstat(path, nodeLstat);
  const exactSourceOpen = platform === "win32"
    ? open
    : (path, flags) => exactOpen(path, flags, nodeOpen);
  function currentUid() {
    return typeof process.getuid === "function" ? process.getuid() : null;
  }

  const nodeCodexLogPorts = createLocalCodexLogPorts({ environment: codexEnvironment, homeDirectory });
  const codexLogPorts = platform === "win32"
    ? Object.freeze({
      ...nodeCodexLogPorts,
      filesystem: Object.freeze({
        ...nodeCodexLogPorts.filesystem,
        statPath: windowsCodexStat,
        lstatPath: windowsCodexStat,
        openReadOnlyNoFollow: windowsCodexOpen,
        readUtf8Range: windowsUtf8Range,
        readUtf8LinesRange: windowsUtf8LinesRange,
      }),
    })
    : nodeCodexLogPorts;
  return Object.freeze({
    allocUnsafe: Buffer.allocUnsafe.bind(Buffer),
    bufferByteLength: Buffer.byteLength.bind(Buffer),
    bufferFrom: Buffer.from.bind(Buffer),
    bufferIsBuffer: Buffer.isBuffer.bind(Buffer),
    clock: () => Date.now(),
    codexLogPorts,
    createHash,
    createHmac,
    currentUid,
    defaultHomeDirectory: homeDirectory,
    deriveAccountScopeId,
    deriveEventOccurrenceId,
    deriveMarkerOccurrenceId,
    deriveModelFingerprint,
    deriveParticipantId,
    deriveQuotaStateId,
    deriveSessionScopeId,
    deriveSnapshotObservationId,
    fsConstants: Object.freeze({
      O_NOFOLLOW: constants.O_NOFOLLOW,
      O_RDONLY: constants.O_RDONLY,
    }),
    lstat,
    open,
    exactSourceLstat,
    exactSourceOpen,
    platform,
    readBoundedUtf8LineEntries,
    resolvePath: resolve,
    rss: () => process.memoryUsage().rss,
  });
}
