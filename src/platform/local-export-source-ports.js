import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import { constants } from "node:fs";
import { lstat as nodeLstat, open as nodeOpen } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
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
const lstat = nodeLstat;
const open = nodeOpen;
const exactSourceLstat = (path) => exactLstat(path, nodeLstat);
const exactSourceOpen = (path, flags) => exactOpen(path, flags, nodeOpen);

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

export function createLocalExportSourcePorts(configuration = {}) {
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)
      || isProxy(configuration)) invalid();
  const configuredEnvironment = ownData(configuration, "environment", process.env);
  const homeDirectory = ownData(configuration, "homeDirectory", homedir());
  const platform = ownData(configuration, "platform", process.platform);
  if (typeof homeDirectory !== "string" || typeof platform !== "string") invalid();
  const codexEnvironment = snapshotEnvironment(configuredEnvironment, CODEX_ENVIRONMENT_KEYS);
  function currentUid() {
    return typeof process.getuid === "function" ? process.getuid() : null;
  }

  const codexLogPorts = createLocalCodexLogPorts({ environment: codexEnvironment, homeDirectory });
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
