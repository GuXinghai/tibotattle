import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { createUsageExplainerService } from "./application/index.js";
import {
  createUsageExplainerSelectorCodec,
} from "./reporting/index.js";
import { defaultLocalUnifiedIndexSecretPath, localDigest, readExistingDeviceSalt } from "./local-device-salt.js";
import {
  defaultLocalCompanionStateRoot,
  localCompanionStatePaths,
} from "./local-installation-diagnostics.js";

// The usage explainer's service composition. The index is read only through the
// three readers the composition root injects (`localIndexReaders`, built over
// the v2 store by local-index-usage-explainer.js); this module owns discovery of
// the store and the shared device salt, the selector codec, and the allowance
// row projection.

const ALLOWANCE_SOURCE_LIMIT = 25;

export function defaultLocalUsageExplainerPaths({
  environment = process.env,
  homeDirectory = homedir(),
  fileExists = existsSync,
} = {}) {
  if (typeof fileExists !== "function") {
    throw new TypeError("fileExists must be a function");
  }
  const legacyRoot = defaultLocalCompanionStateRoot({ environment, homeDirectory });
  const roaming = environment.APPDATA
    ?? join(homeDirectory, "AppData", "Roaming");
  const candidates = [
    ["electron_production", join(roaming, "TiboTattle", "companion-state")],
    ["legacy_cli", legacyRoot],
  ];
  const selected = environment.USAGE_MONITOR_STATE_ROOT === undefined
    ? candidates.find(([, root]) => (
      fileExists(localCompanionStatePaths(root).localIndexStoreFile)
    )) ?? candidates[0]
    : ["environment_override", environment.USAGE_MONITOR_STATE_ROOT];
  const [sourceKind, stateRoot] = selected;
  const state = localCompanionStatePaths(stateRoot);
  return Object.freeze({
    sourceKind,
    indexFile: state.localIndexStoreFile,
    secretFile: state.unifiedIndexSecretFile,
    codexHome: environment.CODEX_HOME ?? join(homeDirectory, ".codex"),
  });
}

export function projectLocalAllowanceMovementRows(rows) {
  if (!Array.isArray(rows) || rows.length > ALLOWANCE_SOURCE_LIMIT) {
    throw new TypeError("allowance movement rows are invalid");
  }
  return rows.map((row) => {
    const first = Number(row.first_used_percent);
    const last = Number(row.last_used_percent);
    const observations = Number(row.observation_count);
    const resetKnown = row.resets_at_ms !== null;
    const monotonic = last >= first;
    return {
      provider: row.provider,
      planType: row.plan_type,
      limitId: row.limit_id,
      durationMins: Number(row.duration_mins),
      resetsAtMs: resetKnown ? Number(row.resets_at_ms) : null,
      firstObservedAtMs: Number(row.first_observed_at_ms),
      lastObservedAtMs: Number(row.last_observed_at_ms),
      firstUsedPercent: first,
      lastUsedPercent: last,
      movementPercentagePoints: resetKnown && monotonic && observations > 1
        ? Number((last - first).toFixed(3))
        : null,
      observationCount: observations,
      movementStatus: !resetKnown
        ? "reset_identity_missing"
        : observations < 2
          ? "single_observation"
          : monotonic
            ? "observed"
            : "non_monotonic",
    };
  });
}

/**
 * `localIndexReaders` is `{ readHealth, readWorkUsage, readAllowance }`, as
 * built by createLocalIndexUsageExplainerReaders(). The service consumes it
 * unchanged; no reader is defaulted here.
 */
export function createLocalUsageExplainer({
  environment = process.env,
  homeDirectory = homedir(),
  indexFile = null,
  secretFile = null,
  codexHome = null,
  clock = Date.now,
  localIndexReaders,
} = {}) {
  if (
    localIndexReaders === null
    || typeof localIndexReaders !== "object"
    || typeof localIndexReaders.readHealth !== "function"
    || typeof localIndexReaders.readWorkUsage !== "function"
    || typeof localIndexReaders.readAllowance !== "function"
  ) {
    throw new TypeError("localIndexReaders must provide the three index readers");
  }
  const { readHealth, readWorkUsage, readAllowance } = localIndexReaders;
  const defaults = indexFile === null
    ? defaultLocalUsageExplainerPaths({ environment, homeDirectory })
    : null;
  const selectedIndex = resolve(indexFile ?? defaults.indexFile);
  const selectedSecret = resolve(
    secretFile ?? (indexFile === null
      ? defaults.secretFile
      : defaultLocalUnifiedIndexSecretPath(selectedIndex)),
  );
  const selectedCodexHome = resolve(
    codexHome
      ?? defaults?.codexHome
      ?? environment.CODEX_HOME
      ?? join(homeDirectory, ".codex"),
  );
  const sourceKind = indexFile === null ? defaults.sourceKind : "explicit_index";
  let codecPromise = null;
  return createUsageExplainerService({
    clock,
    readHealth: async () => ({
      ...await readHealth({ indexFile: selectedIndex }),
      sourceKind,
    }),
    readWorkUsage: ({ fromMs, toMs }) => readWorkUsage({
      indexFile: selectedIndex,
      secretFile: selectedSecret,
      codexHome: selectedCodexHome,
      fromMs,
      toMs,
    }),
    readAllowance: ({ fromMs, toMs, offset, limit }) => readAllowance({
      indexFile: selectedIndex,
      fromMs,
      toMs,
      offset,
      limit,
    }),
    loadSelectorCodec: () => {
      codecPromise ??= readExistingDeviceSalt(selectedSecret).then((salt) => (
        createUsageExplainerSelectorCodec({
          digest: (subject) => localDigest(
            salt,
            "usage-explainer",
            subject,
          ).toString("hex"),
        })
      ));
      return codecPromise;
    },
  });
}
