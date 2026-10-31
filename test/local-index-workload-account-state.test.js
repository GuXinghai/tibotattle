import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { codexPrimaryAllowanceBasis } from "../src/codex-primary-allowance-basis.js";
import {
  createWorkloadAccountStateStore,
  WORKLOAD_ACCOUNT_STATE_FILE,
  WORKLOAD_ACCOUNT_STATE_MAX_ACCOUNTS,
  WORKLOAD_ACCOUNT_STATE_SCHEMA,
  validateWorkloadAccountState,
} from "../src/local-index-workload-account-state.js";
import {
  createWindowsFilesystemAdapter,
  createWindowsProtectedStateStore,
} from "../src/platform/index.js";

const BASIS_ID = codexPrimaryAllowanceBasis("unresolved_as_standard").basisId;
const accountA = "a".repeat(64);
const accountB = "b".repeat(64);

function state(startedAtMs, planType = "pro", version = "1".repeat(64)) {
  return {
    schemaVersion: "overview-workload-state-v3",
    comparison: {
      startedAtMs,
      capacityUsd: 100,
      planType,
      baseline: {
        atMs: startedAtMs,
        usedPercent: 12,
        resetAtMs: startedAtMs + 7 * 24 * 60 * 60 * 1000,
        planType,
        limitId: "codex",
      },
    },
    capacityHistory: [{ usd: 100, availableAtMs: startedAtMs, planType, version, basisId: BASIS_ID }],
  };
}

async function syntheticIndex(t) {
  const root = await mkdtemp(join(tmpdir(), "workload-account-state-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return join(root, "index.sqlite");
}

function rawProtectedStore(indexFile) {
  return createWindowsProtectedStateStore({
    rootPath: join(dirname(indexFile), "private"),
    adapter: createWindowsFilesystemAdapter(),
  });
}

test("v3 payload validation is closed and excludes legacy or future state shapes", () => {
  const value = state(100);
  assert.equal(validateWorkloadAccountState(value), true);
  assert.equal(validateWorkloadAccountState({ ...value, extra: true }), false);
  assert.equal(validateWorkloadAccountState({ ...value, schemaVersion: "overview-workload-state-v2" }), false);
  assert.equal(validateWorkloadAccountState({ ...value, schemaVersion: "overview-workload-state-v4" }), false);
  assert.equal(validateWorkloadAccountState({ ...value, comparison: { ...value.comparison, baseline: { ...value.comparison.baseline, accountKey: accountA } } }), false);
  assert.equal(validateWorkloadAccountState({ ...value, capacityHistory: [{ ...value.capacityHistory[0], scopeToken: accountA }] }), false);
  assert.equal(validateWorkloadAccountState({ ...value, comparison: { ...value.comparison, startedAtMs: -1 } }), false);
  assert.equal(validateWorkloadAccountState({ ...value, capacityHistory: [{ ...value.capacityHistory[0], version: "not-a-digest" }] }), false);
});

test("null account scope is a no-op and never creates a protected store", async (t) => {
  const indexFile = await syntheticIndex(t);
  const store = createWorkloadAccountStateStore(indexFile);
  assert.equal(await store.read(null), null);
  assert.equal(await store.write(null, state(100)), false);
  assert.equal(existsSync(join(dirname(indexFile), "private")), false);
});

test("account partitions survive restart without overwriting each other or the old v3 file", async (t) => {
  const indexFile = await syntheticIndex(t);
  const backend = rawProtectedStore(indexFile);
  backend.ensureProtectedDirectory();
  const oldV3 = state(50, "prolite", "5".repeat(64));
  backend.createJson("overview-workload-state.json", oldV3);
  const oldBytes = backend.read("overview-workload-state.json").data;

  const store = createWorkloadAccountStateStore(indexFile);
  const valueA = state(100, "pro", "1".repeat(64));
  const valueB = state(200, "pro", "2".repeat(64));
  assert.equal(await store.write(accountA, valueA), true);
  assert.equal(await store.write(accountB, valueB), true);
  valueA.comparison.baseline.usedPercent = 99;
  const readA = await store.read(accountA);
  assert.equal(readA.comparison.baseline.usedPercent, 12);
  assert.deepEqual(await store.read(accountB), valueB);
  readA.capacityHistory[0].usd = 999;
  assert.equal((await store.read(accountA)).capacityHistory[0].usd, 100);

  const restarted = createWorkloadAccountStateStore(indexFile);
  assert.deepEqual(await restarted.read(accountA), state(100, "pro", "1".repeat(64)));
  assert.deepEqual(await restarted.read(accountB), valueB);
  assert.deepEqual(backend.read("overview-workload-state.json").data, oldBytes);
  assert.deepEqual(backend.readJson("overview-workload-state.json").value, oldV3);
  const container = backend.readJson(WORKLOAD_ACCOUNT_STATE_FILE).value;
  assert.equal(container.schemaVersion, WORKLOAD_ACCOUNT_STATE_SCHEMA);
  assert.deepEqual(container.accounts.map((entry) => entry.scopeToken).sort(), [accountA, accountB].sort());
});

test("invalid scope tokens and malformed payloads are rejected without replacing last-good bytes", async (t) => {
  const indexFile = await syntheticIndex(t);
  const store = createWorkloadAccountStateStore(indexFile);
  await assert.rejects(store.read("raw-account-id"), { code: "workload_account_state_scope_invalid" });
  await assert.rejects(store.write("A".repeat(64), state(100)), { code: "workload_account_state_scope_invalid" });
  await assert.rejects(store.write(accountA, { ...state(100), unexpected: true }), { code: "workload_account_state_invalid" });

  await store.write(accountA, state(100));
  const backend = rawProtectedStore(indexFile);
  const before = backend.read(WORKLOAD_ACCOUNT_STATE_FILE).data;
  await assert.rejects(store.write(accountA, { ...state(101), capacityHistory: [{ usd: Infinity }] }),
    { code: "workload_account_state_invalid" });
  assert.deepEqual(backend.read(WORKLOAD_ACCOUNT_STATE_FILE).data, before);
});

test("future or malformed account containers fail closed and remain untouched", async (t) => {
  const indexFile = await syntheticIndex(t);
  const backend = rawProtectedStore(indexFile);
  backend.ensureProtectedDirectory();
  const future = { schemaVersion: "overview-workload-account-state-v99", accounts: [] };
  backend.createJson(WORKLOAD_ACCOUNT_STATE_FILE, future);
  const before = backend.read(WORKLOAD_ACCOUNT_STATE_FILE).data;
  const store = createWorkloadAccountStateStore(indexFile);
  await assert.rejects(store.read(accountA), { code: "workload_account_state_invalid" });
  await assert.rejects(store.write(accountA, state(100)), { code: "workload_account_state_invalid" });
  assert.deepEqual(backend.read(WORKLOAD_ACCOUNT_STATE_FILE).data, before);
});

test("the account bound refuses a new partition without pruning prior accounts", async (t) => {
  const indexFile = await syntheticIndex(t);
  const store = createWorkloadAccountStateStore(indexFile);
  const tokens = Array.from({ length: WORKLOAD_ACCOUNT_STATE_MAX_ACCOUNTS }, (_, index) =>
    index.toString(16).padStart(64, "0"));
  for (let index = 0; index < tokens.length; index += 1) {
    await store.write(tokens[index], state(100 + index));
  }
  const before = await store.read(tokens[0]);
  const additional = "f".repeat(64);
  assert.equal(tokens.includes(additional), false);
  await assert.rejects(store.write(additional, state(999)), { code: "workload_account_state_limit" });
  assert.deepEqual(await store.read(tokens[0]), before);
  assert.deepEqual(await store.read(tokens.at(-1)), state(100 + tokens.length - 1));
});
