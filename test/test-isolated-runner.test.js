import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildIsolatedTestEnvironment,
  createIsolatedTestEnvironment,
  parseIsolatedTestArguments,
  resolveIsolatedTestFiles,
} from "../scripts/run-isolated-tests.mjs";
import {
  assertWindowsCredentialQualificationIsolation,
  windowsCredentialQualificationSkipReason,
} from "./helpers/windows-credential-qualification.js";

test("isolated test runner requires an explicit fixed suite or exact test files", () => {
  assert.throws(
    () => parseIsolatedTestArguments([]),
    { message: "ISOLATED_TEST_ARGUMENTS_INVALID" },
  );
  assert.throws(
    () => parseIsolatedTestArguments(["--suite=unknown"]),
    { message: "ISOLATED_TEST_ARGUMENTS_INVALID" },
  );
  assert.throws(
    () => parseIsolatedTestArguments(["--require=some-preload.js", "--", "test/example.test.js"]),
    { message: "ISOLATED_TEST_ARGUMENTS_INVALID" },
  );
  assert.deepEqual(parseIsolatedTestArguments([
    "--test-concurrency=1",
    "--test-reporter=tap",
    "--suite=electron",
  ]), {
    help: false,
    suite: "electron",
    files: [],
    concurrency: 1,
    reporter: "tap",
  });
  assert.deepEqual(parseIsolatedTestArguments([
    "--",
    "test/windows-credential-manager.test.js",
  ]), {
    help: false,
    suite: null,
    files: ["test/windows-credential-manager.test.js"],
    concurrency: 1,
    reporter: null,
  });
});

test("ordinary test environment replaces profile, state, package-manager, and preload values", () => {
  const root = join(tmpdir(), "synthetic-isolated-test-root");
  const environment = buildIsolatedTestEnvironment(root, {
    PATH: "synthetic-system-path",
    USERPROFILE: "C:\\private\\profile",
    HOME: "C:\\private\\profile",
    APPDATA: "C:\\private\\profile\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\private\\profile\\AppData\\Local",
    CODEX_HOME: "C:\\private\\profile\\.codex",
    USAGE_MONITOR_WINDOWS_QUALIFICATION: "1",
    USAGE_MONITOR_WINDOWS_QUALIFICATION_STATE_ROOT: "C:\\private\\qualification-state",
    GITHUB_ACTIONS: "true",
    OPENAI_API_KEY: "private-test-canary",
    NODE_OPTIONS: "--require=private-preload.js",
    NPM_CONFIG_USERCONFIG: "C:\\private\\profile\\.npmrc",
  });

  assert.equal(environment.PATH, "synthetic-system-path");
  assert.equal(environment.HOME, join(root, "home"));
  assert.equal(environment.USERPROFILE, join(root, "home"));
  assert.equal(environment.APPDATA, join(root, "appdata", "roaming"));
  assert.equal(environment.LOCALAPPDATA, join(root, "appdata", "local"));
  assert.equal(environment.CODEX_HOME, join(root, "codex"));
  assert.equal(environment.TEMP, join(root, "t"));
  assert.equal(environment.USAGE_MONITOR_STATE_ROOT, join(root, "state"));
  assert.equal(environment.NPM_CONFIG_USERCONFIG, join(root, "config", "npm-user.npmrc"));
  assert.equal(environment.NPM_CONFIG_GLOBALCONFIG, join(root, "config", "npm-global.npmrc"));
  assert.equal(environment.PNPM_HOME, join(root, "pnpm", "home"));
  assert.equal(environment.PNPM_CACHE_DIR, join(root, "pnpm", "cache"));
  assert.equal(environment.PNPM_STORE_DIR, join(root, "pnpm", "store"));
  for (const key of [
    "GITHUB_ACTIONS",
    "USAGE_MONITOR_WINDOWS_QUALIFICATION",
    "USAGE_MONITOR_WINDOWS_QUALIFICATION_STATE_ROOT",
    "OPENAI_API_KEY",
    "NODE_OPTIONS",
  ]) {
    assert.equal(Object.hasOwn(environment, key), false, `${key} must not reach ordinary test children`);
  }
});

test("fixed suites preserve current root coverage and exact package files remain selectable", async () => {
  const rootFiles = await resolveIsolatedTestFiles({ suite: "root" });
  assert.ok(rootFiles.includes("test/windows-credential-manager.test.js"));
  assert.ok(rootFiles.includes("apps/web/test/lib.test.mjs"));
  assert.equal(rootFiles.includes("test/electron-windows-normal-candidate-archive.test.mjs"), false);

  const quotaFile = await resolveIsolatedTestFiles({
    files: ["packages/quota-analysis/test/quota-windows.test.js"],
  });
  assert.deepEqual(quotaFile, ["packages/quota-analysis/test/quota-windows.test.js"]);
  await assert.rejects(
    resolveIsolatedTestFiles({ files: ["test/*.test.js"] }),
    { message: "ISOLATED_TEST_FILE_INVALID" },
  );
  await assert.rejects(
    resolveIsolatedTestFiles({ files: ["test/helpers/windows-credential-qualification.js"] }),
    { message: "ISOLATED_TEST_FILE_INVALID" },
  );
});

test("native credential binding tests require the explicit qualification marker", () => {
  assert.equal(windowsCredentialQualificationSkipReason({
    platform: "win32",
    architecture: "x64",
    environment: {},
  }), "explicit Windows security qualification required");
  assert.equal(windowsCredentialQualificationSkipReason({
    platform: "win32",
    architecture: "x64",
    environment: { USAGE_MONITOR_WINDOWS_QUALIFICATION: "1" },
  }), false);
  assert.equal(windowsCredentialQualificationSkipReason({
    platform: "linux",
    architecture: "x64",
    environment: { USAGE_MONITOR_WINDOWS_QUALIFICATION: "1" },
  }), "native Windows x64 Credential Manager qualification only");
});

test("credential qualification rejects missing and non-isolated roots before filesystem access", async () => {
  const base = {
    GITHUB_ACTIONS: "true",
    USAGE_MONITOR_WINDOWS_QUALIFICATION: "1",
    RUNNER_TEMP: "C:\\synthetic-runner\\temp",
    CODEX_HOME: "C:\\synthetic-runner\\temp\\usagemonitor-codex-home",
  };
  await assert.rejects(
    assertWindowsCredentialQualificationIsolation({
      environment: {
        USAGE_MONITOR_WINDOWS_QUALIFICATION: "1",
      },
    }),
    { message: "CREDENTIAL_QUALIFICATION_REQUIRES_HOSTED_RUNNER" },
  );
  await assert.rejects(
    assertWindowsCredentialQualificationIsolation({ environment: { ...base } }),
    { message: "CREDENTIAL_QUALIFICATION_STATE_ROOT_INVALID" },
  );
  await assert.rejects(
    assertWindowsCredentialQualificationIsolation({
      environment: {
        ...base,
        USAGE_MONITOR_WINDOWS_QUALIFICATION_STATE_ROOT: "C:\\synthetic-runner\\temp\\usagemonitor-windows-private-state",
        CODEX_HOME: undefined,
      },
    }),
    { message: "CREDENTIAL_QUALIFICATION_CODEX_HOME_INVALID" },
  );
  await assert.rejects(
    assertWindowsCredentialQualificationIsolation({
      environment: {
        ...base,
        USAGE_MONITOR_WINDOWS_QUALIFICATION_STATE_ROOT: "C:\\synthetic-runner\\other-state",
      },
    }),
    { message: "CREDENTIAL_QUALIFICATION_STATE_ROOT_NOT_ISOLATED" },
  );
  await assert.rejects(
    assertWindowsCredentialQualificationIsolation({
      environment: {
        ...base,
        USAGE_MONITOR_WINDOWS_QUALIFICATION_STATE_ROOT: "C:\\synthetic-runner\\temp\\usagemonitor-windows-private-state",
        CODEX_HOME: "C:\\private\\real-codex-home",
      },
    }),
    { message: "CREDENTIAL_QUALIFICATION_CODEX_HOME_NOT_ISOLATED" },
  );
});

test("native credential loader and round-trip bodies assert their isolated qualification root first", async () => {
  const qualificationHelperSource = await readFile(
    new URL("./helpers/windows-credential-qualification.js", import.meta.url),
    "utf8",
  );
  assert.match(qualificationHelperSource, /codexMetadata = await lstat\(codexHome\)/u);
  assert.match(qualificationHelperSource, /codexRealPath = await realpath\(codexHome\)/u);
  assert.match(qualificationHelperSource, /codexMetadata\.isSymbolicLink\(\)/u);
  assert.match(qualificationHelperSource, /CREDENTIAL_QUALIFICATION_CODEX_HOME_REPARSE_POINT/u);

  const managerSource = await readFile(
    new URL("./windows-credential-manager.test.js", import.meta.url),
    "utf8",
  );
  const managerNativeTests = managerSource.slice(
    managerSource.indexOf('test("native Windows x64 qualification adapter'),
  );
  assert.match(managerNativeTests, /skip: windowsCredentialQualificationSkipReason\(\)/u);
  assert.match(managerNativeTests, /await assertWindowsCredentialQualificationIsolation\(\);\s+const backend = createWindowsCredentialManagerBackend\(\);/u);
  assert.equal((managerNativeTests.match(/createWindowsCredentialManagerBackend\(\)/gu) ?? []).length, 3);

  const probeSource = await readFile(
    new URL("./windows-credential-manager-probe.test.js", import.meta.url),
    "utf8",
  );
  const probeNativeTest = probeSource.slice(
    probeSource.indexOf('test("Credential Manager native x64 binding'),
  );
  assert.match(probeNativeTest, /skip: windowsCredentialQualificationSkipReason\(\)/u);
  assert.match(probeNativeTest, /await assertWindowsCredentialQualificationIsolation\(\);\s+const binding = loadAuditedWindowsCredentialBinding\(\);\s+const receipt = await runWindowsCredentialManagerProbe\(\{ binding \}\);/u);

  // Native mutex IDs are shared with the real application, even when a test's
  // SQLite audit file is synthetic. Ordinary tests must not acquire them.
  for (const [file, count] of [["windows-credential-mutex-native.test.js", 4], ["windows-credential-mutex.test.js", 1]]) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    assert.equal((source.match(/skip: windowsCredentialQualificationSkipReason\(\)/gu) ?? []).length, count);
    assert.equal((source.match(/await assertWindowsCredentialQualificationIsolation\(\);/gu) ?? []).length, count);
    assert.doesNotMatch(source, /skip: process\.platform !== "win32"/u);
  }
});

test("isolated test environment creates and removes only its sentinel-bound temporary root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "isolated-test-parent-"));
  try {
    const isolation = await createIsolatedTestEnvironment({
      inheritedEnvironment: {},
      temporaryDirectory: parent,
    });
    const rootInfo = await lstat(isolation.root);
    assert.equal(rootInfo.isDirectory(), true);
    assert.equal(isolation.environment.TEMP.startsWith(isolation.root), true);
    await isolation.dispose();
    await assert.rejects(lstat(isolation.root), { code: "ENOENT" });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
