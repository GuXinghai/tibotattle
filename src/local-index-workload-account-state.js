import {
  createWindowsFilesystemAdapter,
  createWindowsProtectedStateStore,
  isWindowsProtectedStateStoreError,
} from "./platform/index.js";
import { dirname, join } from "node:path";
import { codexPrimaryAllowanceBasis } from "./codex-primary-allowance-basis.js";

export const WORKLOAD_ACCOUNT_STATE_SCHEMA = "overview-workload-account-state-v1";
export const WORKLOAD_ACCOUNT_STATE_FILE = "overview-workload-account-state.json";
export const WORKLOAD_ACCOUNT_STATE_MAX_ACCOUNTS = 64;
const WORKLOAD_STATE_SCHEMA = "overview-workload-state-v3";
const SCOPE_TOKEN = /^[a-f0-9]{64}$/u;
const PLAN_TYPE = /^[a-z0-9_]{1,64}$/u;
const VERSION = /^[a-f0-9]{64}$/u;
const BASIS_ID = codexPrimaryAllowanceBasis("unresolved_as_standard").basisId;

function exactObject(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validBaseline(value) {
  return value === null || exactObject(value, ["atMs", "usedPercent", "resetAtMs", "planType", "limitId"])
    && Number.isSafeInteger(value.atMs) && value.atMs >= 0
    && Number.isSafeInteger(value.resetAtMs) && value.resetAtMs >= 0
    && Number.isFinite(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100
    && typeof value.planType === "string" && PLAN_TYPE.test(value.planType)
    && value.limitId === "codex";
}

/** Validate only the v3 workload payload, not the account-state container. */
export function validateWorkloadAccountState(value) {
  try {
    if (!exactObject(value, ["schemaVersion", "comparison", "capacityHistory"])
        || value.schemaVersion !== WORKLOAD_STATE_SCHEMA
        || !exactObject(value.comparison, ["startedAtMs", "capacityUsd", "planType", "baseline"])
        || !Number.isSafeInteger(value.comparison.startedAtMs) || value.comparison.startedAtMs < 0
        || !(value.comparison.capacityUsd === null
          || Number.isFinite(value.comparison.capacityUsd) && value.comparison.capacityUsd > 0)
        || !(value.comparison.planType === null
          || typeof value.comparison.planType === "string" && PLAN_TYPE.test(value.comparison.planType))
        || !validBaseline(value.comparison.baseline)
        || value.comparison.baseline !== null
          && value.comparison.baseline.atMs < value.comparison.startedAtMs
        || !Array.isArray(value.capacityHistory) || value.capacityHistory.length > 4096) return false;
    return value.capacityHistory.every((entry) => exactObject(entry,
      ["usd", "availableAtMs", "planType", "version", "basisId"])
      && Number.isFinite(entry.usd) && entry.usd > 0
      && Number.isSafeInteger(entry.availableAtMs) && entry.availableAtMs >= 0
      && (entry.planType === null || typeof entry.planType === "string" && PLAN_TYPE.test(entry.planType))
      && typeof entry.version === "string" && VERSION.test(entry.version)
      && entry.basisId === BASIS_ID);
  } catch {
    return false;
  }
}

function validContainer(value) {
  try {
    if (!exactObject(value, ["schemaVersion", "accounts"])
        || value.schemaVersion !== WORKLOAD_ACCOUNT_STATE_SCHEMA
        || !Array.isArray(value.accounts)
        || value.accounts.length > WORKLOAD_ACCOUNT_STATE_MAX_ACCOUNTS) return false;
    const seen = new Set();
    for (const account of value.accounts) {
      if (!exactObject(account, ["scopeToken", "state"])
          || typeof account.scopeToken !== "string" || !SCOPE_TOKEN.test(account.scopeToken)
          || seen.has(account.scopeToken) || !validateWorkloadAccountState(account.state)) return false;
      seen.add(account.scopeToken);
    }
    return true;
  } catch {
    return false;
  }
}

function fixedError(code) {
  return Object.assign(new Error(code), { code });
}

function validateScopeToken(scopeToken) {
  if (typeof scopeToken !== "string" || !SCOPE_TOKEN.test(scopeToken)) {
    throw fixedError("workload_account_state_scope_invalid");
  }
}

function cloneState(state) {
  return {
    schemaVersion: state.schemaVersion,
    comparison: {
      startedAtMs: state.comparison.startedAtMs,
      capacityUsd: state.comparison.capacityUsd,
      planType: state.comparison.planType,
      baseline: state.comparison.baseline === null ? null : { ...state.comparison.baseline },
    },
    capacityHistory: state.capacityHistory.map((entry) => ({ ...entry })),
  };
}

function invalidContainer() {
  throw fixedError("workload_account_state_invalid");
}

/**
 * Store v3 workload payloads in an account-keyed, single-file protected
 * container. The unscoped v3 file is deliberately not read or modified.
 */
export function createWorkloadAccountStateStore(indexFile) {
  if (typeof indexFile !== "string" || indexFile.length === 0 || indexFile.includes("\0")) {
    throw new TypeError("Invalid workload index path");
  }
  const root = join(dirname(indexFile), "private");
  let backend = null;
  const store = () => backend ??= createWindowsProtectedStateStore({
    rootPath: root,
    adapter: createWindowsFilesystemAdapter(),
  });

  function readContainer(target) {
    try {
      const persisted = target.readJson(WORKLOAD_ACCOUNT_STATE_FILE);
      if (!validContainer(persisted.value)) invalidContainer();
      return persisted;
    } catch (error) {
      if (isWindowsProtectedStateStoreError(error)
          && error.code === "windows_protected_state_store_missing") return null;
      if (error?.code === "workload_account_state_invalid") throw error;
      if (isWindowsProtectedStateStoreError(error)) throw error;
      invalidContainer();
    }
  }

  return Object.freeze({
    async read(scopeToken) {
      if (scopeToken === null) return null;
      validateScopeToken(scopeToken);
      const persisted = readContainer(store());
      if (persisted === null) return null;
      const account = persisted.value.accounts.find((entry) => entry.scopeToken === scopeToken);
      return account === undefined ? null : cloneState(account.state);
    },

    async write(scopeToken, state) {
      if (scopeToken === null) return false;
      validateScopeToken(scopeToken);
      if (!validateWorkloadAccountState(state)) throw fixedError("workload_account_state_invalid");
      const target = store();
      target.ensureProtectedDirectory();
      const persisted = readContainer(target);
      const accounts = persisted === null ? [] : persisted.value.accounts.map((entry) => ({
        scopeToken: entry.scopeToken,
        state: cloneState(entry.state),
      }));
      const existingIndex = accounts.findIndex((entry) => entry.scopeToken === scopeToken);
      if (existingIndex < 0 && accounts.length >= WORKLOAD_ACCOUNT_STATE_MAX_ACCOUNTS) {
        throw fixedError("workload_account_state_limit");
      }
      const account = { scopeToken, state: cloneState(state) };
      if (existingIndex < 0) accounts.push(account);
      else accounts[existingIndex] = account;
      const next = { schemaVersion: WORKLOAD_ACCOUNT_STATE_SCHEMA, accounts };
      if (persisted === null) target.createJson(WORKLOAD_ACCOUNT_STATE_FILE, next);
      else target.replaceJson(WORKLOAD_ACCOUNT_STATE_FILE, persisted.identity, next);
      return true;
    },
  });
}
