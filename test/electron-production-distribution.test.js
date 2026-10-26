import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createProductionDistributionMetadata } from "../apps/electron/desktop-updater.js";
import { buildElectronApp } from "../scripts/build-electron-app.mjs";
import {
  ELECTRON_SHELL_RUNTIME_FILES,
  ELECTRON_UPDATER_RUNTIME_PACKAGE_PINS,
  assertStagedElectronShellModuleLinkage,
} from "../scripts/build-electron-runtime.mjs";
import {
  parseProductionCandidateArguments,
  productionElectronCandidatePlan,
} from "../scripts/package-electron-production.mjs";
import { RELEASE_VERSION } from "../config/release-manifest.js";

const require = createRequire(import.meta.url);
const POLICY = require("../config/electron-production-distribution.cjs");
const ELECTRON_BUILDER_REQUIRE = createRequire(require.resolve("electron-builder/package.json"));
const { AppInfo } = ELECTRON_BUILDER_REQUIRE("app-builder-lib/out/appInfo");
const semver = ELECTRON_BUILDER_REQUIRE("semver");
const BUILDER_CONFIG_PATH = resolve("apps/electron/electron-builder.production.config.cjs");
const DEVELOPMENT_BUILDER_CONFIG_PATH = resolve("apps/electron/electron-builder.config.cjs");
const PRODUCTION_SOURCE_WORKFLOW_PATH = resolve(
  ".github/workflows/electron-production-source-preparation.yml",
);
const SOURCE_REVISION = "a".repeat(40);
const BUILD_NUMBER = "20260906";








async function withTemporaryDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), "usagemonitor-electron-production-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertStagedHandoverCompanionReady({ output, root }) {
  const syntheticRoot = join(root, "synthetic-companion");
  await mkdir(syntheticRoot, { recursive: true });
  const companionModule = pathToFileURL(join(output, "apps", "local", "server.js")).href;
  // Invoke the staged composition root directly so this is an import and
  // readiness regression, independent of the test runner's argv semantics.
  const launcher = [
    `import { startLocalCompanionServer } from ${JSON.stringify(companionModule)};`,
    "const app = await startLocalCompanionServer({ host: '127.0.0.1', port: 0 });",
    "process.stdout.write(`USAGE_MONITOR_READY http://${app.host}:${app.port}/\\n`);",
    "process.once('SIGTERM', () => { void app.close().then(() => process.exit(0), () => process.exit(1)); });",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", launcher], {
    cwd: output,
    env: {
      CODEX_HOME: join(syntheticRoot, "codex"),
      HOME: join(syntheticRoot, "home"),
      PATH: process.env.PATH ?? "",
      USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
      USAGE_MONITOR_PORT: "0",
      USAGE_MONITOR_STATE_ROOT: join(syntheticRoot, "state"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolveReady, rejectReady) => {
    let ready = false;
    let failure = null;
    let outputBytes = 0;
    let stdout = "";
    let stderr = "";
    const failureCategory = () => (
      /Invalid app-usagemonitor release metadata/u.test(stderr)
        ? "release_metadata"
        : /Parent watchdog configuration is invalid/u.test(stderr)
          ? "parent_watchdog"
          : /listen EPERM/u.test(stderr)
            ? "loopback_listener"
            : "startup"
    );
    const requestStop = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    const fail = (error) => {
      failure ??= error;
      requestStop();
    };
    const timeout = setTimeout(() => {
      fail(new Error("staged handover companion did not become ready"));
    }, 10_000);
    const forcedExit = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 12_000);
    child.once("error", () => {
      fail(new Error("staged handover companion did not become ready"));
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 2048) stderr += chunk.slice(0, 2048 - stderr.length);
    });
    child.stdout.on("data", (chunk) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > 512) {
        fail(new Error("staged handover companion emitted unexpected output"));
        return;
      }
      stdout += chunk;
      if (/^USAGE_MONITOR_READY http:\/\/127\.0\.0\.1:\d+\/$/mu.test(stdout)) {
        ready = true;
        requestStop();
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(forcedExit);
      if (failure !== null) {
        rejectReady(failure);
        return;
      }
      if (!ready) {
        rejectReady(new Error(`staged handover companion exited before ready: ${failureCategory()}`));
        return;
      }
      if (code !== 0 && signal !== "SIGTERM") {
        rejectReady(new Error("staged handover companion did not stop cleanly"));
        return;
      }
      resolveReady();
    });
  });
}

async function assertStagedReleaseManifestRejects({ output, root, overrides }) {
  const fixtureRoot = join(root, "release-manifest-fixture");
  const fixtureConfig = join(fixtureRoot, "config");
  await mkdir(fixtureConfig, { recursive: true });
  const packageJson = JSON.parse(await readFile(join(output, "package.json"), "utf8"));
  for (const name of [
    "electron-production-distribution.cjs",
    "product-brand.js",
    "product-brand.cjs",
    "application-identity.cjs",
    "release-manifest.js",
  ]) {
    await writeFile(join(fixtureConfig, name), await readFile(join(output, "config", name)));
  }
  await writeFile(join(fixtureRoot, "package.json"), `${JSON.stringify({
    ...packageJson,
      ...overrides,
  }, null, 2)}\n`);
  assert.throws(() => execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    "await import('./config/release-manifest.js');",
  ], {
    cwd: fixtureRoot,
    stdio: "ignore",
  }));
}

function loadProductionBuilderConfig(target, {
  buildNumber = BUILD_NUMBER,
} = {}) {
  const version = RELEASE_VERSION;
  const source = [
    `const config = require(${JSON.stringify(BUILDER_CONFIG_PATH)});`,
    "process.stdout.write(JSON.stringify(config));",
  ].join("\n");
  return JSON.parse(execFileSync(process.execPath, ["-e", source], {
    cwd: resolve("."),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      USAGE_MONITOR_ELECTRON_BUILD_NUMBER: buildNumber,
      USAGE_MONITOR_ELECTRON_SOURCE_REVISION: SOURCE_REVISION,
      USAGE_MONITOR_ELECTRON_TARGET: target,
      USAGE_MONITOR_ELECTRON_VERSION: version,
    },
  }));
}

function loadDevelopmentBuilderConfig(target) {
  const source = [
    `const config = require(${JSON.stringify(DEVELOPMENT_BUILDER_CONFIG_PATH)});`,
    "process.stdout.write(JSON.stringify(config));",
  ].join("\n");
  return JSON.parse(execFileSync(process.execPath, ["-e", source], {
    cwd: resolve("."),
    encoding: "utf8",
    env: {
      ...process.env,
      USAGE_MONITOR_ELECTRON_TARGET: target,
    },
  }));
}

function assertWindowsResourceVersion(version) {
  const components = version.split(".");
  assert.equal(components.length, 4);
  for (const component of components) {
    assert.match(component, /^(?:0|[1-9][0-9]*)$/u);
    assert.ok(Number(component) <= Number(POLICY.WINDOWS_FILE_VERSION_COMPONENT_LIMIT));
  }
}



test("production builder source config binds app identity, target-specific build versions, feed and artifacts", () => {
  for (const [target, spec] of Object.entries(POLICY.PRODUCTION_ELECTRON_TARGETS)) {
    const config = loadProductionBuilderConfig(target);
    assert.equal(config.appId, POLICY.PRODUCTION_ELECTRON_APP_ID, target);
    assert.equal(config.productName, "Rhetrion", target);
    assert.equal(config.buildNumber, BUILD_NUMBER, target);
    assert.equal(config.buildVersion, POLICY.productionElectronBuildVersionForTarget({
      target, version: RELEASE_VERSION, buildNumber: BUILD_NUMBER,
    }), target);
    assert.equal(config.extraMetadata.version, RELEASE_VERSION, target);
    assert.equal(Object.hasOwn(config.extraMetadata, "usageMonitorSourceReleaseVersion"), false,
      target);
    assert.deepEqual(config.extraMetadata.usageMonitorDistribution,
      createProductionDistributionMetadata({ buildNumber: BUILD_NUMBER, sourceRevision: SOURCE_REVISION, target }), target);
    assert.equal(spec.feedURL, null);
    assert.equal(config.publish, null, target);
    assert.equal(config.forceCodeSigning, true, target);
    assert.match(config.directories.app, new RegExp(`electron-production[\\\\/]${target}[\\\\/]app$`, "u"), target);
    assert.match(config.directories.output, new RegExp(`electron-production[\\\\/]${target}[\\\\/]artifacts$`, "u"), target);
    assert.equal(target, "win32-x64");
      assert.doesNotMatch(JSON.stringify(config), /SUPublicEDKey|SUFeedURL/u);
      assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
      assert.equal(config.win.verifyUpdateCodeSignature, true);
      assert.equal(config.win.signExecutable, true);
      assert.equal(config.win.signAndEditExecutable, true);
      assert.equal(config.extraMetadata.shortVersion, config.buildVersion);
      assert.equal(config.extraMetadata.shortVersionWindows, config.buildVersion);
      assertWindowsResourceVersion(config.buildVersion);
  }
});






test("Windows candidate mapping is lossless, ordered, and accepted by the pinned builder resource path", () => {
  const candidates = ["1", "65535", "65536", BUILD_NUMBER, "9999999999"];
  let previous = -1n;
  for (const candidate of candidates) {
    const mapped = POLICY.productionElectronWindowsFileVersion(candidate);
    assertWindowsResourceVersion(mapped);
    const restored = mapped.split(".").reduce(
      (value, component) => value * 65_536n + BigInt(component),
      0n,
    );
    assert.equal(restored, BigInt(candidate));
    assert.ok(restored > previous);
    previous = restored;
  }
  assert.equal(POLICY.productionElectronWindowsFileVersion(BUILD_NUMBER), "0.0.309.10282");

  const config = loadProductionBuilderConfig("win32-x64");
  const appInfo = new AppInfo({
    config: { buildNumber: config.buildNumber, buildVersion: config.buildVersion },
    metadata: { ...config.extraMetadata },
  });
  assert.equal(appInfo.buildVersion, config.buildVersion);
  assert.equal(appInfo.shortVersion, config.buildVersion);
  assert.equal(appInfo.shortVersionWindows, config.buildVersion);
  const winPackagerSource = readFileSync(
    ELECTRON_BUILDER_REQUIRE.resolve("app-builder-lib/out/winPackager"),
    "utf8",
  );
  assert.match(winPackagerSource,
    /fileVersion:\s*appInfo\.shortVersion\s*\|\|\s*appInfo\.buildVersion/u);
  assert.match(winPackagerSource,
    /productVersion:\s*appInfo\.shortVersionWindows\s*\|\|\s*appInfo\.getVersionInWeirdWindowsForm\(\)/u);
});

test("production source candidate requires an explicit numeric build number and remains non-publishing", () => {
  const options = parseProductionCandidateArguments([
    "--target", "win32-x64",
    "--source-revision", SOURCE_REVISION,
    "--build-number", BUILD_NUMBER,
  ]);
  const plan = productionElectronCandidatePlan(options);
  assert.equal(plan.buildNumber, BUILD_NUMBER);
  assert.equal(plan.version, RELEASE_VERSION);
  assert.deepEqual(plan.builderArguments, ["--win", "nsis", "--x64", "--publish", "never"]);
  assert.equal(plan.signingPerformed, false);
  assert.equal(plan.publishingPerformed, false);
  assert.throws(() => parseProductionCandidateArguments([
    "--target", "win32-x64", "--source-revision", SOURCE_REVISION, "--build-number", "0",
  ]), (error) => error?.code === "ELECTRON_PRODUCTION_ARGUMENT_INVALID");
  assert.throws(() => parseProductionCandidateArguments([
    "--target", "win32-x64", "--source-revision", SOURCE_REVISION,
  ]), (error) => error?.code === "ELECTRON_PRODUCTION_ARGUMENT_INVALID");
  assert.throws(() => parseProductionCandidateArguments([
    "--target", "win32-x64", "--source-revision", SOURCE_REVISION,
    "--build-number", "10000000000",
  ]), (error) => error?.code === "ELECTRON_PRODUCTION_ARGUMENT_INVALID");
});


test("manual production source workflow has no default candidate or finalization command", async () => {
  const workflow = await readFile(PRODUCTION_SOURCE_WORKFLOW_PATH, "utf8");
  assert.match(workflow, /^  workflow_dispatch:\n    inputs:\n      build_number:/mu);
  assert.match(workflow, /^  push:\n    branches: \[codex\/unified-desktop-accountless\]/mu);
  assert.match(workflow, /^  registration:\n    if: github\.event_name == 'push'/mu);
  assert.equal((workflow.match(/if: github\.event_name == 'workflow_dispatch'/gu) ?? []).length, 1);
  assert.match(workflow, /build_number:\n(?:.*\n){0,3}\s+required: true\n(?:.*\n){0,2}\s+type: string/mu);
  assert.doesNotMatch(workflow, /^\s+(?:pull_request|schedule):/mu);
  assert.doesNotMatch(workflow, /^\s+default:/mu);
  assert.doesNotMatch(workflow, /\belectron-builder\b/u);
  assert.doesNotMatch(workflow, /--publish\b/u);
  assert.doesNotMatch(workflow, /electron-macos-keychain-adapter/u);
  for (const target of Object.keys(POLICY.PRODUCTION_ELECTRON_TARGETS)) {
    assert.match(workflow, new RegExp(`^  ${target}:\\n    if: github\\.event_name == 'workflow_dispatch'`, "mu"), target);
    assert.match(workflow, new RegExp(`--target ${target}`, "u"), target);
    assert.match(workflow,
      new RegExp(`electron-production-source-${target}-\\$\\{\\{ github\\.sha \\}\\}`, "u"), target);
  }
});

test("production staging carries the exact app metadata and updater closure while development cannot activate it", async () => {
  await withTemporaryDirectory(async (root) => {
    const metadata = createProductionDistributionMetadata({
      buildNumber: BUILD_NUMBER,
      sourceRevision: SOURCE_REVISION,
      target: "win32-x64",
    });
    const production = await buildElectronApp({
      output: join(root, "production"),
      target: "win32-x64",
      packagingProfile: "production",
      distributionMetadata: metadata,
    });
    const development = await buildElectronApp({
      output: join(root, "development"),
      target: "win32-x64",
    });
    const productionPackage = JSON.parse(await readFile(join(production.output, "package.json"), "utf8"));
    const developmentPackage = JSON.parse(await readFile(join(development.output, "package.json"), "utf8"));
    assert.deepEqual(productionPackage.usageMonitorDistribution, metadata);
    assert.equal(Object.hasOwn(developmentPackage, "usageMonitorDistribution"), false);
    for (const name of Object.keys(ELECTRON_UPDATER_RUNTIME_PACKAGE_PINS)) {
      const segments = name.split("/");
      const packagePath = posix.join("node_modules", ...segments, "package.json");
      assert.ok(production.manifest.files.some(({ path }) => path === packagePath), packagePath);
      assert.ok(development.manifest.files.some(({ path }) => path === packagePath), packagePath);
    }
    for (const file of ELECTRON_SHELL_RUNTIME_FILES) {
      assert.ok(production.manifest.files.some(({ path }) => path === file), file);
      assert.ok(development.manifest.files.some(({ path }) => path === file), file);
    }
    const closure = await assertStagedElectronShellModuleLinkage(production.output);
    assert.ok(closure.includes("apps/electron/desktop-updater.js"));
    await assertStagedElectronShellModuleLinkage(development.output);
  });
});
