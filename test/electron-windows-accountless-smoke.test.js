import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import {
  parseWindowsAccountlessSmokeArguments,
  assertWindowsAccountlessPackageIdentity,
  createWindowsAccountlessSmokeProtocol,
  exerciseWindowsAccountlessSmoke,
  observeWindowsSmokeStderr,
  prepareWindowsAccountlessSmokeFirstRunAcknowledgementForTest,
} from "../scripts/smoke-electron-windows-accountless.mjs";

const type = "windows-electron-smoke-v1";
const state = { type, message: "state-v1", started: true, primary: true, window: true, visible: true, tray: true };
const observationStorage = { type, message: "credential-v1", operation: "account-observation-storage-v1", status: "passed-v1" };
const retiredStorage = { ...observationStorage, operation: "accountless-storage-v1" };
const quit = { type, message: "quit-v1", status: "accepted-v1" };
function fakeChild(reply) {
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  child.commands = [];
  child.send = (message, callback) => {
    child.commands.push(message);
    callback(null);
    queueMicrotask(() => reply(child, message));
  };
  return child;
}

function disposableWindowsProfile() {
  return Object.freeze({
    root: "C:\\smoke",
    userData: "C:\\smoke\\user-data",
    home: "C:\\smoke\\home",
    codex: "C:\\smoke\\codex",
    state: "C:\\smoke\\state",
    tmp: "C:\\smoke\\tmp",
  });
}

function qualificationEnvironment(profile) {
  return Object.freeze({
    USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
    USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
    USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
    USAGE_MONITOR_STATE_ROOT: profile.state,
    USERPROFILE: profile.home,
    HOME: profile.home,
    CODEX_HOME: profile.codex,
    TEMP: profile.tmp,
  });
}

test("Windows accountless runner requires exact absolute inputs and refuses endpoint/credential options", () => {
  const argv = ["--app", resolve("usage-monitor.exe"), "--staged-app", resolve("staged"), "--package-receipt", resolve("package.json"), "--source-revision", "a".repeat(40), "--receipt", resolve("receipt.json")];
  assert.equal(parseWindowsAccountlessSmokeArguments(argv).sourceRevision, "a".repeat(40));
  for (const invalid of [[], argv.slice(0, -1), [...argv, "--app", resolve("other.exe")], [...argv, "--endpoint", "https://invalid.test"], [...argv, "--value", "synthetic"], argv.map((v) => v === resolve("staged") ? "relative" : v)]) {
    assert.throws(() => parseWindowsAccountlessSmokeArguments(invalid), /ARGUMENT_INVALID/u);
  }
});

test("identity requires matching source, executable and ASAR instead of accepting a green older package", () => {
  const sourceRevision = "a".repeat(40);
  const executable = { bytes: 128, sha256: "b".repeat(64) };
  const asar = { bytes: 256, sha256: "c".repeat(64) };
  const receipt = { sourceRevision, target: "win32-x64", status: "development_package_verified", runtimeExecuted: false, executable, asar };
  assertWindowsAccountlessPackageIdentity({ receipt, sourceRevision, executable, asar });
  for (const changed of [{ sourceRevision: "d".repeat(40) }, { target: "darwin-arm64" }, { runtimeExecuted: true }, { asar: { ...asar, bytes: 1 } }, { executable: { ...executable, sha256: "e".repeat(64) } }]) {
    assert.throws(() => assertWindowsAccountlessPackageIdentity({ receipt: { ...receipt, ...changed }, sourceRevision, executable, asar }), /PACKAGE_IDENTITY_INVALID/u);
  }
});

test("Windows smoke prepares and readbacks only the fixed first-run receipt in its authenticated disposable profile", async () => {
  const profile = disposableWindowsProfile();
  const environment = qualificationEnvironment(profile);
  const resourceRoot = "C:\\staged-app";
  const adapter = Object.freeze({ productionSafe: false });
  const context = Object.freeze({
    qualificationOnly: true,
    productionSafe: false,
    resourceRoot,
    stateRoot: profile.userData,
  });
  const store = Object.freeze({ kind: "protected-store" });
  const calls = [];
  const result = await prepareWindowsAccountlessSmokeFirstRunAcknowledgementForTest({
    profile,
    environment,
    stagedAppPath: resourceRoot,
    createAdapter(options) {
      calls.push(["adapter", options]);
      return adapter;
    },
    createQualificationContext(options) {
      calls.push(["context", options]);
      return context;
    },
    createProtectedStore(options) {
      calls.push(["store", options]);
      return store;
    },
    createReceiptBackend(options) {
      calls.push(["backend", options]);
      return Object.freeze({
        async save(value) {
          calls.push(["save", value]);
        },
        async load() {
          calls.push(["load"]);
          return {
            schemaVersion: "usagemonitor-desktop-first-run-v1",
            acknowledged: true,
          };
        },
      });
    },
  });

  assert.deepEqual(result, { status: "prepared-v1" });
  assert.deepEqual(calls[0][1].bindingPath,
    "C:\\staged-app\\native\\windows-filesystem\\build\\Release\\windows_filesystem.node");
  assert.equal(calls[0][1].platform, "win32");
  assert.equal(calls[0][1].architecture, "x64");
  assert.equal(calls[1][1].resourceRoot, resourceRoot);
  assert.equal(calls[1][1].environment.TEMP, profile.root);
  assert.equal(calls[1][1].environment.USAGE_MONITOR_STATE_ROOT, profile.userData);
  assert.equal(environment.TEMP, profile.tmp);
  assert.equal(environment.USAGE_MONITOR_STATE_ROOT, profile.state);
  assert.equal(calls[2][1].rootPath, "C:\\smoke\\user-data\\desktop-settings");
  assert.equal(calls[2][1].windowsQualificationModeContext, context);
  assert.equal(calls[2][1].resourceRoot, resourceRoot);
  assert.deepEqual(calls[3][1], {
    platform: "win32",
    windowsProtectedStateStore: store,
  });
  assert.deepEqual(calls[4][1], {
    schemaVersion: "usagemonitor-desktop-first-run-v1",
    acknowledged: true,
  });
  assert.deepEqual(calls[5], ["load"]);
});

test("Windows smoke refuses an unauthenticated first-run context before it writes a receipt", async () => {
  const profile = disposableWindowsProfile();
  let receiptWrites = 0;
  await assert.rejects(
    prepareWindowsAccountlessSmokeFirstRunAcknowledgementForTest({
      profile,
      environment: qualificationEnvironment(profile),
      stagedAppPath: "C:\\staged-app",
      createAdapter: () => ({ productionSafe: false }),
      createQualificationContext: () => ({
        qualificationOnly: true,
        productionSafe: true,
        resourceRoot: "C:\\staged-app",
        stateRoot: profile.userData,
      }),
      createProtectedStore: () => ({ kind: "unreachable" }),
      createReceiptBackend: () => ({
        save: async () => { receiptWrites += 1; },
        load: async () => null,
      }),
    }),
    /FIRST_RUN_CONTEXT_INVALID/u,
  );
  assert.equal(receiptWrites, 0);
});

test("runner waits for ready then completes the fixed observation storage journey and clean quit in order", async () => {
  const child = fakeChild((target, { command }) => {
    target.emit("message", command === "status-v1" ? state : command === "account-observation-storage-v1" ? observationStorage : quit);
    if (command === "quit-v1") setImmediate(() => { target.exitCode = 0; target.emit("exit", 0, null); });
  });
  const observations = {};
  await exerciseWindowsAccountlessSmoke(child, { timeoutMs: 1000, observations });
  assert.deepEqual(child.commands, ["status-v1", "account-observation-storage-v1", "quit-v1"].map((command) => ({ type, message: "command-v1", command })));
  assert.equal(observations.accountObservationStoragePassed, true);
  assert.equal(observations.quitAcknowledged, true);
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("exit"), 0);
});

test("the retired accountless storage command is refused by the fixed protocol", async () => {
  const child = fakeChild(() => {});
  const protocol = createWindowsAccountlessSmokeProtocol(child, { timeoutMs: 50 });
  await assert.rejects(protocol.request("accountless-storage-v1"), /COMMAND_REFUSED/u);
  assert.equal(child.commands.length, 0);
  protocol.close();
});

test("observation storage rejects failures, extra fields and results from any other operation", async () => {
  for (const response of [{ ...observationStorage, status: "failed-v1" }, { ...observationStorage, privateValue: "unexpected" }, retiredStorage]) {
    const child = fakeChild((target) => target.emit("message", response));
    const protocol = createWindowsAccountlessSmokeProtocol(child, { timeoutMs: 50 });
    await assert.rejects(protocol.request("account-observation-storage-v1"), /OBSERVATION_STORAGE_FAILED/u);
    protocol.close();
  }
});

test("observation failure does not claim the journey or a clean quit", async () => {
  const observations = {};
  const child = fakeChild((target, { command }) => {
    target.emit("message", command === "status-v1" ? state : { ...observationStorage, status: "failed-v1" });
  });
  await assert.rejects(exerciseWindowsAccountlessSmoke(child, { timeoutMs: 100, observations }), /OBSERVATION_STORAGE_FAILED/u);
  assert.equal(observations.accountObservationStorageRequested, true);
  assert.notEqual(observations.accountObservationStoragePassed, true);
  assert.notEqual(observations.quitAcknowledged, true);
  assert.equal(child.commands.some(({ command }) => command === "quit-v1"), false);
  assert.equal(child.listenerCount("message"), 0);
});

test("observation failure records only the closed stage enum and never native error detail", async () => {
  for (const failureStage of [
    "preparation",
    "child_create",
    "child_restart_read",
    "child_initial_read_existing_record",
    "child_initial_read_broker_unavailable",
    "child_initial_read_broker_locked",
    "child_initial_read_broker_denied",
    "child_initial_read_broker_recovery_required",
    "child_initial_read_broker_timeout",
    "child_initial_read_broker_protocol",
    "child_initial_read_broker_invalid_configuration",
    "unavailable",
    "private native detail",
  ]) {
    const observations = { accountObservationFailureStage: null };
    const child = fakeChild((target) => target.emit("message", {
      ...observationStorage, status: "failed-v1", failureStage,
    }));
    const protocol = createWindowsAccountlessSmokeProtocol(child, { timeoutMs: 50, observations });
    await assert.rejects(protocol.request("account-observation-storage-v1"), /OBSERVATION_STORAGE_FAILED/u);
    assert.equal(observations.accountObservationFailureStage, failureStage === "private native detail" ? null : failureStage);
    protocol.close();
  }
});

test("unknown commands and concurrent requests are refused; silent or exited children terminate the request", async () => {
  const child = fakeChild(() => {});
  const protocol = createWindowsAccountlessSmokeProtocol(child, { timeoutMs: 25 });
  await assert.rejects(protocol.request("credential-create-v1"), /COMMAND_REFUSED/u);
  const waiting = protocol.request("status-v1");
  await assert.rejects(protocol.request("status-v1"), /COMMAND_REFUSED/u);
  await assert.rejects(waiting, /TIMEOUT/u);
  const interrupted = protocol.request("status-v1");
  child.emit("exit", 1, null);
  await assert.rejects(interrupted, /CHILD_EXITED/u);
  protocol.close();
});

test("malformed lifecycle state and asynchronous send errors fail without leaking underlying errors", async () => {
  const child = fakeChild((target) => target.emit("message", { ...state, started: "yes" }));
  const protocol = createWindowsAccountlessSmokeProtocol(child, { timeoutMs: 50 });
  await assert.rejects(protocol.request("status-v1"), /RESPONSE_INVALID/u);
  child.send = (_message, callback) => callback(new Error("private process detail"));
  await assert.rejects(protocol.request("status-v1"), (error) => error.message === "ELECTRON_WINDOWS_ACCOUNTLESS_SMOKE_SEND_FAILED");
  protocol.close();
});

test("startup observation can be retried while the storage request is never replayed", async () => {
  let statusCount = 0;
  const child = fakeChild((target, { command }) => {
    if (command === "status-v1" && ++statusCount === 2) target.emit("message", state);
  });
  const protocol = createWindowsAccountlessSmokeProtocol(child, { timeoutMs: 600 });
  assert.equal((await protocol.request("status-v1")).started, true);
  assert.equal(child.commands.filter(({ command }) => command === "status-v1").length, 2);
  await assert.rejects(protocol.request("account-observation-storage-v1"), /TIMEOUT/u);
  assert.equal(child.commands.filter(({ command }) => command === "account-observation-storage-v1").length, 1);
  protocol.close();
});

test("failure observations expose only a fixed startup marker and allowlisted IPC class", async () => {
  const stream = new EventEmitter(); stream.setEncoding = () => {};
  const observations = { entryFailureObserved: false, sendFailureCode: null };
  observeWindowsSmokeStderr(stream, observations);
  stream.emit("data", "private path and credential\n" + "x".repeat(500) + "electron_shell_entry_failed\n");
  assert.equal(observations.entryFailureObserved, false);
  stream.emit("data", "electron_shell_"); stream.emit("data", "entry_failed\r\n");
  assert.equal(observations.entryFailureObserved, true);
  const child = fakeChild(() => {});
  child.send = (_message, callback) => callback(Object.assign(new Error("private detail"), { code: "EPIPE" }));
  const protocol = createWindowsAccountlessSmokeProtocol(child, { observations });
  await assert.rejects(protocol.request("status-v1"), /SEND_FAILED/u);
  assert.deepEqual(observations, { entryFailureObserved: true, sendFailureCode: "EPIPE" });
  protocol.close();
});
