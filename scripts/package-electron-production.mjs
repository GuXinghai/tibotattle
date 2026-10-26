#!/usr/bin/env node

/**
 * Prepare one reviewable production Electron source candidate.
 *
 * This entrypoint stages the exact app and updater dependency closure only.
 * It intentionally never invokes electron-builder, signing, notarization, or
 * publishing. The returned plan names the later builder invocation, whose
 * config requires the same source revision and explicit build number.
 */

import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildElectronApp,
} from "./build-electron-app.mjs";
import {
  ELECTRON_TARGETS,
} from "./build-electron-runtime.mjs";
import {
  createProductionDistributionMetadata,
  validateProductionDistributionMetadata,
  PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN,
  PRODUCTION_ELECTRON_TARGETS,
} from "../apps/electron/desktop-updater.js";
import distribution from "../config/electron-production-distribution.cjs";
import { RELEASE_VERSION } from "../config/release-manifest.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const SHA = /^[0-9a-f]{40}$/u;
const SCHEMA_VERSION = "usagemonitor-electron-production-source-candidate-v1";
const TARGETS = Object.freeze(Object.keys(PRODUCTION_ELECTRON_TARGETS));
const PLATFORM_FLAGS = Object.freeze({ win32: "--win" });
const DISTRIBUTION_TARGETS = Object.freeze({
  win32: Object.freeze(["nsis"]),
});

function failure(code) {
  const error = new Error(`ELECTRON_PRODUCTION_${code}`);
  error.code = error.message;
  return error;
}

function fail(code) {
  throw failure(code);
}

function validSourceRevision(value) {
  return typeof value === "string" && SHA.test(value);
}

function validBuildNumber(value) {
  return typeof value === "string" && PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN.test(value);
}

function requireArgumentValue(argv, index) {
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")
      || value.includes("\0")) {
    fail("ARGUMENT_INVALID");
  }
  return value;
}

export function parseProductionCandidateArguments(argv) {
  if (!Array.isArray(argv)) fail("ARGUMENT_INVALID");
  const result = { replaceStaging: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) fail("DUPLICATE_ARGUMENT");
    seen.add(flag);
    if (flag === "--replace-staging") {
      result.replaceStaging = true;
      continue;
    }
    const property = {
      "--target": "target",
      "--source-revision": "sourceRevision",
      "--build-number": "buildNumber",
      "--windows-binding": "windowsBindingPath",
      "--windows-manifest": "windowsManifestPath",
    }[flag];
    if (!property) fail("ARGUMENT_INVALID");
    result[property] = requireArgumentValue(argv, index);
    index += 1;
  }
  if (!TARGETS.includes(result.target)
      || !validSourceRevision(result.sourceRevision)
      || !validBuildNumber(result.buildNumber)
      || Boolean(result.windowsBindingPath) !== Boolean(result.windowsManifestPath)) {
    fail("ARGUMENT_INVALID");
  }
  return Object.freeze(result);
}

/**
 * Make a source-only plan without inspecting the checkout or invoking a
 * builder. This keeps workflow and unit checks safe to run before a real
 * candidate number or signing environment has been allocated.
 */
export function productionElectronCandidatePlan({
  target,
  sourceRevision,
  buildNumber,
  hostPlatform = process.platform,
  hostArchitecture = process.arch,
} = {}) {
  const targetSpec = PRODUCTION_ELECTRON_TARGETS[target];
  const runtimeTarget = ELECTRON_TARGETS[target];
  const distributionSelection = distribution.productionElectronDistributionForTarget({ target });
  if (!targetSpec || !runtimeTarget || distributionSelection === null
      || targetSpec.platform !== runtimeTarget.platform
      || targetSpec.architecture !== runtimeTarget.architecture
      || !validSourceRevision(sourceRevision)
      || !validBuildNumber(buildNumber)) {
    fail("PLAN_INVALID");
  }
  const metadata = createProductionDistributionMetadata({
    buildNumber,
    sourceRevision,
    target,
  });
  const stagingPathSegments = distribution.productionElectronStagingPathSegments({ target });
  if (stagingPathSegments === null) fail("PLAN_INVALID");
  const stagingRoot = `.release-build/${stagingPathSegments.join("/")}`;
  const version = RELEASE_VERSION;
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    buildNumber,
    sourceRevision,
    version,
    target,
    updateFeed: metadata.updateFeed,
    host: Object.freeze({ platform: hostPlatform, architecture: hostArchitecture }),
    stagingDirectory: `${stagingRoot}/app`,
    artifactDirectory: `${stagingRoot}/artifacts`,
    builderConfiguration: "apps/electron/electron-builder.production.config.cjs",
    builderArguments: Object.freeze([
      PLATFORM_FLAGS[targetSpec.platform],
      ...DISTRIBUTION_TARGETS[targetSpec.platform],
      `--${targetSpec.architecture}`,
      "--publish",
      "never",
    ]),
    builderEnvironment: Object.freeze({
      USAGE_MONITOR_ELECTRON_BUILD_NUMBER: buildNumber,
      USAGE_MONITOR_ELECTRON_SOURCE_REVISION: sourceRevision,
      USAGE_MONITOR_ELECTRON_TARGET: target,
      USAGE_MONITOR_ELECTRON_VERSION: version,
    }),
    updaterEnabled: true,
    signingRequired: true,
    signingPerformed: false,
    publishingPerformed: false,
    // Source staging does not establish Windows normal-runtime or signed-release
    // qualification. Those require separate candidate and release evidence.
    windowsRuntimeQualification: "required",
  });
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    let output = "";
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const capture = (chunk) => {
      output += chunk;
      if (output.length > 64 * 1024) child.kill();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.once("error", () => reject(failure("SOURCE_COMMAND_UNAVAILABLE")));
    child.once("exit", (code) => {
      if (code !== 0 || output.length > 64 * 1024) {
        reject(failure("SOURCE_COMMAND_FAILED"));
        return;
      }
      resolveRun(output.trim());
    });
  });
}

async function cleanSourceRevision() {
  const sourceRevision = await run("git", ["rev-parse", "HEAD"]);
  if (!validSourceRevision(sourceRevision)) fail("SOURCE_INVALID");
  if ((await run("git", ["status", "--porcelain", "--untracked-files=normal"])) !== "") {
    fail("SOURCE_DIRTY");
  }
  return sourceRevision;
}

function targetOutput(plan) {
  return resolve(REPOSITORY_ROOT, plan.stagingDirectory);
}

async function assertNoSymbolicLinkPathComponents(
  path,
  pathFailureCode = "NATIVE_HANDOVER_HELPER_PATH",
) {
  const selected = resolve(path);
  const relativePath = relative(REPOSITORY_ROOT, selected);
  if (relativePath === "" || isAbsolute(relativePath)
      || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    fail(pathFailureCode);
  }
  let current = REPOSITORY_ROOT;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        fail(pathFailureCode);
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      if (error?.code?.startsWith("ELECTRON_PRODUCTION_")) throw error;
      fail(pathFailureCode);
    }
  }
}

async function removePreviousRegularFile(path, { replace, existsCode, unsafeCode }) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail(unsafeCode);
  }
  if (!replace) fail(existsCode);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) fail(unsafeCode);
  try {
    await unlink(path);
  } catch {
    fail(unsafeCode);
  }
}

/**
 * Stage the app whose package.json carries the exact source, target, and
 * selected package authority. No installer is built here; the config named in
 * the receipt is the later explicit signing/finalization boundary.
 */
export async function prepareProductionElectronCandidate(options = {}) {
  if (process.version !== "v26.2.0") fail("NODE_VERSION_REQUIRED");
  const plan = productionElectronCandidatePlan(options);
  const actualRevision = await cleanSourceRevision();
  if (actualRevision !== plan.sourceRevision) fail("SOURCE_REVISION_MISMATCH");
  const metadata = createProductionDistributionMetadata({
    buildNumber: plan.buildNumber,
    sourceRevision: plan.sourceRevision,
    target: plan.target,
  });
  const staged = await buildElectronApp({
    output: targetOutput(plan),
    target: plan.target,
    replace: options.replaceStaging === true,
    packagingProfile: "production",
    packageVersion: plan.version,
    distributionMetadata: metadata,
    ...(plan.target === "win32-x64" ? {
      windowsBindingPath: options.windowsBindingPath,
      windowsManifestPath: options.windowsManifestPath,
    } : {}),
  });
  let stagedManifest;
  try {
    stagedManifest = JSON.parse(await readFile(join(staged.output, "package.json"), "utf8"));
  } catch {
    fail("STAGED_MANIFEST_INVALID");
  }
  let stagedMetadata;
  try {
    stagedMetadata = validateProductionDistributionMetadata(stagedManifest.usageMonitorDistribution, {
      platform: PRODUCTION_ELECTRON_TARGETS[plan.target].platform,
      architecture: PRODUCTION_ELECTRON_TARGETS[plan.target].architecture,
    });
  } catch {
    fail("STAGED_MANIFEST_INVALID");
  }
  if (JSON.stringify(stagedMetadata) !== JSON.stringify(metadata)) fail("STAGED_MANIFEST_INVALID");
  if (await cleanSourceRevision() !== plan.sourceRevision) fail("SOURCE_CHANGED");
  const receipt = Object.freeze({
    ...plan,
    status: "production_source_staged",
    stagedManifest: "app/package.json",
    runtimeManifest: "app/electron-runtime-manifest.json",
  });
  const receiptPath = join(dirname(staged.output), "production-source-candidate.json");
  await removePreviousRegularFile(receiptPath, {
    replace: options.replaceStaging === true,
    existsCode: "RECEIPT_EXISTS",
    unsafeCode: "RECEIPT_UNSAFE",
  });
  await writeFile(
    receiptPath,
    `${JSON.stringify(receipt, null, 2)}
`,
    { flag: "wx", mode: 0o600 },
  );
  return receipt;
}

if (resolve(process.argv[1] ?? "") === SCRIPT_FILE) {
  try {
    const options = parseProductionCandidateArguments(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await prepareProductionElectronCandidate(options), null, 2)}\n`);
  } catch (error) {
    // The staging layers use fixed error codes. Surface those codes so a
    // protected CI candidate can be diagnosed without printing paths or
    // private error messages from the underlying filesystem/dependencies.
    process.stderr.write(`${/^[A-Z][A-Z0-9_]{0,79}$/u.test(error?.code ?? "")
      ? error.code
      : "ELECTRON_PRODUCTION_FAILED"}\n`);
    process.exitCode = 1;
  }
}
