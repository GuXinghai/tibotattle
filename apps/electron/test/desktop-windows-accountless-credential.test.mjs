import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  createWindowsNormalCandidateCredentialHandoverForTest,
  createWindowsDevelopmentReadOnlyCredentialHandoverForTest,
} from "../desktop-windows-accountless-credential.js";

test("main enables the development reader only inside the qualified Windows lane", async () => {
  const source = await readFile(new URL("../main.js", import.meta.url), "utf8");
  const block = source.match(/const windowsNormalCandidateCredentialHandover =[\s\S]*?;\n/u)?.[0];
  assert.ok(block);
  const select = new Function("productionEnabled", "platform", "architecture",
    "productionDistribution", "qualificationContext", "preparation", "environment",
    "WINDOWS_ELECTRON_TEST_LANE", "createWindowsNormalCandidateCredentialHandover",
    "createWindowsDevelopmentReadOnlyCredentialHandover", `${block} return windowsNormalCandidateCredentialHandover;`);
  const valid = { platform: "win32", architecture: "x64", context: {},
    profile: "development", lane: "windows-electron-smoke" };
  for (const [change, expected] of [
    [{}, "reader"], [{ platform: "linux" }, null], [{ architecture: "arm64" }, null],
    [{ context: null }, null], [{ profile: "preview" }, null], [{ lane: undefined }, null],
  ]) {
    const v = { ...valid, ...change };
    assert.equal(select(false, v.platform, v.architecture, null, v.context,
      { applicationProfile: v.profile }, { USAGE_MONITOR_TEST_LANE: v.lane },
      "windows-electron-smoke", () => "normal", () => "reader"), expected);
  }
  assert.equal(select(true, "win32", "x64", { target: "win32-x64" }, null,
    { applicationProfile: "stable" }, {}, "windows-electron-smoke",
    () => "normal", () => "reader"), "normal");
});

test("development handover fixes read-only policy on the owned broker", () => {
  let options;
  const handover = createWindowsDevelopmentReadOnlyCredentialHandoverForTest({
    platform: "win32", architecture: "x64",
    createAccountObservationCredentialBackend: () => ({}),
    isAccountObservationBackendError: () => false,
    attachBroker(value) { options = value; return {}; },
  });
  handover.attachWindowsAccountObservationBroker({});
  assert.equal(options.readOnly, true);
});

test("normal Windows handover exposes only the fixed FD4 parent route", () => {
  const calls = [];
  const handover = createWindowsNormalCandidateCredentialHandoverForTest({
    platform: "win32",
    architecture: "x64",
    createAccountObservationCredentialBackend() {
      calls.push(["fd4-factory"]);
      return Object.freeze({});
    },
    isAccountObservationBackendError(error) {
      return error?.trusted === true;
    },
    attachBroker(options) {
      calls.push(["fd4", options]);
      return Object.freeze({ close() {} });
    },
  });
  assert.deepEqual(Object.keys(handover), ["attachWindowsAccountObservationBroker"]);

  const channel = Object.freeze({ kind: "supervisor-owned-ipc" });
  handover.attachWindowsAccountObservationBroker(channel);
  assert.equal(calls[0][0], "fd4");
  assert.equal(calls[0][1].channel, channel);
  assert.equal(typeof calls[0][1].createBackend, "function");
  assert.equal(calls[0][1].isBackendError({ trusted: true }), true);
  assert.equal(calls[0][1].isBackendError({ trusted: false }), false);
  assert.deepEqual(calls[0][1].createBackend(), {});
  assert.deepEqual(calls.map(([name]) => name), ["fd4", "fd4-factory"]);
});

test("normal Windows handover refuses alternate platforms and unexpected controls", () => {
  for (const overrides of [
    { platform: "linux" },
    { architecture: "arm64" },
    { unexpected: true },
  ]) {
    let calls = 0;
    assert.throws(
      () => createWindowsNormalCandidateCredentialHandoverForTest({
        platform: "win32",
        architecture: "x64",
        createAccountObservationCredentialBackend() { calls += 1; },
        isAccountObservationBackendError: () => false,
        attachBroker() { calls += 1; },
        ...overrides,
      }),
      { code: "windows_credential_handover_unavailable" },
    );
    assert.equal(calls, 0);
  }
  // The retired accountless installation route is not part of the handover.
  assert.throws(
    () => createWindowsNormalCandidateCredentialHandoverForTest({
      platform: "win32",
      architecture: "x64",
      createAccountlessCredentialBackend() { assert.fail("accountless route is retired"); },
      createAccountObservationCredentialBackend() { assert.fail("must not construct FD4"); },
      isAccountObservationBackendError: () => false,
      attachBroker() { assert.fail("must not attach FD4"); },
    }),
    { code: "windows_credential_handover_unavailable" },
  );
});
