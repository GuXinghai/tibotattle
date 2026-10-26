#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..");
const OWNER_MARKER_NAME = ".rhetrion-isolated-test-root";
const ALLOWED_REPORTERS = new Set(["dot", "spec", "tap"]);
const TEST_FILE_PATH = /^(?:test|apps\/(?:web\/test|electron\/test|local)|packages\/(?:accounting|identity-core|quota-analysis|telemetry-contract|i18n)\/test)\/[^/]+\.test\.(?:js|mjs)$/u;

const LOCAL_TEST_FILES = Object.freeze([
  "test/local-companion-data.test.js",
  "test/local-companion-refresh.test.js",
  "test/local-contribution-preparation.test.js",
  "test/real-local-backend-acceptance.test.js",
  "test/telemetry-contribution-builder.test.js",
  "test/contribution-device-sync.test.js",
  "test/contribution-sync-queue.test.js",
]);

const SUITE_DIRECTORIES = Object.freeze({
  root: Object.freeze([
    Object.freeze({ directory: "test", pattern: /.+\.test\.js$/u }),
    Object.freeze({ directory: "apps/web/test", pattern: /.+\.test\.mjs$/u }),
  ]),
  ui: Object.freeze([
    Object.freeze({ directory: "apps/web/test", pattern: /.+\.test\.mjs$/u }),
  ]),
  electron: Object.freeze([
    Object.freeze({ directory: "apps/electron/test", pattern: /.+\.test\.mjs$/u }),
  ]),
  local: Object.freeze([
    Object.freeze({ directory: "apps/local", pattern: /.+\.test\.mjs$/u }),
  ]),
});

const SYSTEM_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROCESSOR_LEVEL",
  "PROCESSOR_REVISION",
  "NUMBER_OF_PROCESSORS",
]);

function normalizedPath(path) {
  const selected = resolve(path);
  return process.platform === "win32" ? selected.toLowerCase() : selected;
}

function isWithin(parent, candidate) {
  const selected = relative(parent, candidate);
  return selected === ""
    || (selected !== ".."
      && !selected.startsWith(`..${sep}`)
      && !isAbsolute(selected));
}

function inheritedValue(environment, name) {
  const key = Object.keys(environment).find((candidate) => (
    candidate.toUpperCase() === name.toUpperCase()
  ));
  return key === undefined ? undefined : environment[key];
}

function setIfString(environment, key, value) {
  if (typeof value === "string" && value.length > 0) environment[key] = value;
}

/**
 * Build the closed environment used by ordinary test children. Only executable
 * lookup and Windows process requirements survive from the caller. All profile,
 * product-state, qualification, credential, and Node preload variables are
 * replaced or omitted.
 */
export function buildIsolatedTestEnvironment(rootPath, inheritedEnvironment = process.env) {
  const root = resolve(rootPath);
  const home = join(root, "home");
  const state = join(root, "state");
  const temporary = join(root, "t");
  const environment = {};

  for (const key of SYSTEM_ENVIRONMENT_KEYS) {
    setIfString(environment, key, inheritedValue(inheritedEnvironment, key));
  }

  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(root, "appdata", "roaming"),
    LOCALAPPDATA: join(root, "appdata", "local"),
    CODEX_HOME: join(root, "codex"),
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    USAGE_MONITOR_STATE_ROOT: state,
    USAGE_MONITOR_STATE_FILE: join(state, "usage-monitor-test.sqlite"),
    XDG_CONFIG_HOME: join(root, "xdg", "config"),
    XDG_DATA_HOME: join(root, "xdg", "data"),
    XDG_STATE_HOME: join(root, "xdg", "state"),
    XDG_CACHE_HOME: join(root, "xdg", "cache"),
    NPM_CONFIG_USERCONFIG: join(root, "config", "npm-user.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(root, "config", "npm-global.npmrc"),
    NPM_CONFIG_CACHE: join(root, "npm", "cache"),
    NPM_CONFIG_PREFIX: join(root, "npm", "global"),
    NPM_CONFIG_STORE_DIR: join(root, "pnpm", "store"),
    PNPM_HOME: join(root, "pnpm", "home"),
    PNPM_STORE_DIR: join(root, "pnpm", "store"),
    PNPM_CACHE_DIR: join(root, "pnpm", "cache"),
    COREPACK_HOME: join(root, "corepack"),
    ELECTRON_CACHE: join(root, "electron", "cache"),
    ELECTRON_BUILDER_CACHE: join(root, "electron", "builder-cache"),
    GIT_CONFIG_GLOBAL: join(root, "config", "git-global.config"),
    GIT_CONFIG_SYSTEM: join(root, "config", "git-system.config"),
    GIT_CONFIG_NOSYSTEM: "1",
  });

  if (process.platform === "win32") {
    const rootComponent = resolve(home).slice(0, 3);
    if (/^[A-Za-z]:\\$/u.test(rootComponent)) {
      environment.HOMEDRIVE = rootComponent.slice(0, 2);
      environment.HOMEPATH = resolve(home).slice(2);
    }
  }

  return Object.freeze(environment);
}

function invalidArguments() {
  return new Error("ISOLATED_TEST_ARGUMENTS_INVALID");
}

export function parseIsolatedTestArguments(argv) {
  const arguments_ = [...argv];
  const parsed = {
    help: false,
    suite: null,
    files: [],
    concurrency: 1,
    reporter: null,
  };
  let fileSection = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (argument === "--") {
      if (fileSection) throw invalidArguments();
      fileSection = true;
      continue;
    }
    if (fileSection) {
      parsed.files.push(argument);
      continue;
    }
    if (argument === "--suite" || argument.startsWith("--suite=")) {
      if (parsed.suite !== null) throw invalidArguments();
      const value = argument === "--suite" ? arguments_[++index] : argument.slice(8);
      if (typeof value !== "string" || !Object.hasOwn(SUITE_DIRECTORIES, value)) {
        throw invalidArguments();
      }
      parsed.suite = value;
      continue;
    }
    if (argument === "--test-concurrency=1") {
      parsed.concurrency = 1;
      continue;
    }
    if (argument.startsWith("--test-reporter=")) {
      const reporter = argument.slice("--test-reporter=".length);
      if (!ALLOWED_REPORTERS.has(reporter) || parsed.reporter !== null) {
        throw invalidArguments();
      }
      parsed.reporter = reporter;
      continue;
    }
    throw invalidArguments();
  }

  if (parsed.help) return Object.freeze({ ...parsed, files: Object.freeze([]) });
  if ((parsed.suite === null && parsed.files.length === 0)
      || (parsed.suite !== null && parsed.files.length > 0)) {
    throw invalidArguments();
  }
  return Object.freeze({ ...parsed, files: Object.freeze(parsed.files) });
}

function normalizeRepositoryPath(path) {
  return path.split(sep).join("/").replace(/^\.\//u, "");
}

async function canonicalTestFile(candidate, repositoryRoot, repositoryRootReal) {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.includes("\0")) {
    throw new Error("ISOLATED_TEST_FILE_INVALID");
  }
  const normalized = candidate.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized.includes("*") || normalized.includes("?")
      || normalized.split("/").includes("..")) {
    throw new Error("ISOLATED_TEST_FILE_INVALID");
  }
  const selected = resolve(repositoryRoot, normalized);
  const relativePath = normalizeRepositoryPath(relative(repositoryRoot, selected));
  if (relativePath === ".." || relativePath.startsWith("../")
      || !TEST_FILE_PATH.test(relativePath)) {
    throw new Error("ISOLATED_TEST_FILE_INVALID");
  }

  let metadata;
  let canonical;
  try {
    metadata = await lstat(selected);
    canonical = await realpath(selected);
  } catch {
    throw new Error("ISOLATED_TEST_FILE_INVALID");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()
      || !isWithin(repositoryRootReal, canonical)) {
    throw new Error("ISOLATED_TEST_FILE_INVALID");
  }
  return relativePath;
}

async function filesInReviewedDirectory({ directory, pattern }, repositoryRoot, repositoryRootReal) {
  const selectedDirectory = resolve(repositoryRoot, directory);
  let directoryInfo;
  let canonicalDirectory;
  let names;
  try {
    directoryInfo = await lstat(selectedDirectory);
    canonicalDirectory = await realpath(selectedDirectory);
    names = await readdir(selectedDirectory);
  } catch {
    throw new Error("ISOLATED_TEST_SUITE_DIRECTORY_INVALID");
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()
      || !isWithin(repositoryRootReal, canonicalDirectory)) {
    throw new Error("ISOLATED_TEST_SUITE_DIRECTORY_INVALID");
  }

  const selectedNames = names.filter((name) => pattern.test(name)).sort();
  const files = [];
  for (const name of selectedNames) {
    files.push(await canonicalTestFile(`${directory}/${name}`, repositoryRoot, repositoryRootReal));
  }
  return files;
}

/** Resolve either one fixed suite or an explicit file list to reviewed files. */
export async function resolveIsolatedTestFiles({ suite = null, files = [] } = {}) {
  if ((suite === null && (!Array.isArray(files) || files.length === 0))
      || (suite !== null && (!Object.hasOwn(SUITE_DIRECTORIES, suite)
        || !Array.isArray(files) || files.length > 0))) {
    throw invalidArguments();
  }

  const repositoryRootReal = await realpath(REPOSITORY_ROOT);
  const selected = [];
  if (suite === "local") selected.push(...LOCAL_TEST_FILES);
  if (suite !== null) {
    for (const directory of SUITE_DIRECTORIES[suite]) {
      selected.push(...await filesInReviewedDirectory(
        directory,
        REPOSITORY_ROOT,
        repositoryRootReal,
      ));
    }
  } else {
    selected.push(...files);
  }

  const canonical = [];
  const seen = new Set();
  for (const candidate of selected) {
    const path = await canonicalTestFile(candidate, REPOSITORY_ROOT, repositoryRootReal);
    if (!seen.has(path)) {
      seen.add(path);
      canonical.push(path);
    }
  }
  if (canonical.length === 0) throw new Error("ISOLATED_TEST_SUITE_EMPTY");
  return Object.freeze(canonical);
}

function requiredDirectories(environment) {
  return [
    environment.HOME,
    environment.APPDATA,
    environment.LOCALAPPDATA,
    environment.CODEX_HOME,
    environment.TEMP,
    environment.USAGE_MONITOR_STATE_ROOT,
    environment.XDG_CONFIG_HOME,
    environment.XDG_DATA_HOME,
    environment.XDG_STATE_HOME,
    environment.XDG_CACHE_HOME,
    environment.NPM_CONFIG_CACHE,
    environment.NPM_CONFIG_PREFIX,
    environment.NPM_CONFIG_STORE_DIR,
    environment.PNPM_HOME,
    environment.PNPM_CACHE_DIR,
    environment.COREPACK_HOME,
    environment.ELECTRON_CACHE,
    environment.ELECTRON_BUILDER_CACHE,
    dirname(environment.NPM_CONFIG_USERCONFIG),
    dirname(environment.NPM_CONFIG_GLOBALCONFIG),
    dirname(environment.GIT_CONFIG_GLOBAL),
    dirname(environment.GIT_CONFIG_SYSTEM),
  ];
}

function requiredEmptyFiles(environment) {
  return [
    environment.NPM_CONFIG_USERCONFIG,
    environment.NPM_CONFIG_GLOBALCONFIG,
    environment.GIT_CONFIG_GLOBAL,
    environment.GIT_CONFIG_SYSTEM,
  ];
}

async function safeRemoveIsolatedRoot({ root, parent, marker, markerValue }) {
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("ISOLATED_TEST_ROOT_CLEANUP_REFUSED");
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("ISOLATED_TEST_ROOT_CLEANUP_REFUSED");
  }
  let actualRoot;
  let markerInfo;
  let observedMarker;
  try {
    actualRoot = await realpath(root);
    markerInfo = await lstat(marker);
    observedMarker = await readFile(marker, "utf8");
  } catch {
    throw new Error("ISOLATED_TEST_ROOT_CLEANUP_REFUSED");
  }
  if (!isWithin(parent, actualRoot)
      || normalizedPath(actualRoot) !== normalizedPath(root)
      || !markerInfo.isFile()
      || markerInfo.isSymbolicLink()
      || observedMarker !== markerValue) {
    throw new Error("ISOLATED_TEST_ROOT_CLEANUP_REFUSED");
  }
  try {
    await rm(root, { recursive: true, force: false });
  } catch {
    throw new Error("ISOLATED_TEST_ROOT_CLEANUP_FAILED");
  }
}

/** Create a unique synthetic profile and a closed child environment. */
export async function createIsolatedTestEnvironment({
  inheritedEnvironment = process.env,
  temporaryDirectory = tmpdir(),
} = {}) {
  let parent;
  try {
    parent = await realpath(resolve(temporaryDirectory));
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new Error("ISOLATED_TEST_TEMP_PARENT_INVALID");
    }
  } catch {
    throw new Error("ISOLATED_TEST_TEMP_PARENT_INVALID");
  }

  let root;
  try {
    root = await mkdtemp(join(parent, "rt-"));
  } catch {
    throw new Error("ISOLATED_TEST_TEMP_ROOT_CREATE_FAILED");
  }
  const marker = join(root, OWNER_MARKER_NAME);
  const markerValue = randomUUID();
  try {
    await writeFile(marker, markerValue, { flag: "wx", mode: 0o600 });
    const environment = buildIsolatedTestEnvironment(root, inheritedEnvironment);
    await Promise.all(requiredDirectories(environment).map((directory) => (
      mkdir(directory, { recursive: true, mode: 0o700 })
    )));
    await Promise.all(requiredEmptyFiles(environment).map((path) => (
      writeFile(path, "", { flag: "wx", mode: 0o600 })
    )));

    const canonicalRoot = await realpath(root);
    if (normalizedPath(canonicalRoot) !== normalizedPath(root)
        || !isWithin(parent, canonicalRoot)) {
      throw new Error("ISOLATED_TEST_TEMP_ROOT_INVALID");
    }

    let disposed = false;
    return Object.freeze({
      root,
      environment,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await safeRemoveIsolatedRoot({ root, parent, marker, markerValue });
      },
    });
  } catch {
    try {
      await safeRemoveIsolatedRoot({ root, parent, marker, markerValue });
    } catch {
      // Keep the fixed setup failure authoritative; a changed root is left intact.
    }
    throw new Error("ISOLATED_TEST_ENVIRONMENT_SETUP_FAILED");
  }
}

async function spawnProcess(command, arguments_, { cwd, environment, stdio = "inherit" }) {
  await new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawn(command, arguments_, {
        cwd,
        env: environment,
        stdio,
        windowsHide: true,
      });
    } catch {
      rejectRun(new Error("ISOLATED_TEST_PROCESS_START_FAILED"));
      return;
    }
    child.once("error", () => rejectRun(new Error("ISOLATED_TEST_PROCESS_START_FAILED")));
    child.once("close", (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`ISOLATED_TEST_PROCESS_FAILED:${signal ?? code ?? "unknown"}`));
    });
  });
}

async function withIsolatedEnvironment(action, {
  environment = process.env,
  temporaryDirectory,
} = {}) {
  const isolation = await createIsolatedTestEnvironment({
    inheritedEnvironment: environment,
    temporaryDirectory: temporaryDirectory ?? inheritedValue(environment, "TEMP") ?? tmpdir(),
  });
  let actionError = null;
  try {
    await action(isolation.environment);
  } catch (error) {
    actionError = error;
  }
  try {
    await isolation.dispose();
  } catch (error) {
    if (actionError === null) throw error;
    throw new AggregateError([actionError, error], "ISOLATED_TEST_AND_CLEANUP_FAILED");
  }
  if (actionError !== null) throw actionError;
}

/** Run a command with the same closed, synthetic environment as a test child. */
export async function runIsolatedProcess(command, arguments_, options = {}) {
  const {
    environment = process.env,
    cwd = REPOSITORY_ROOT,
    stdio = "inherit",
  } = options;
  await withIsolatedEnvironment((childEnvironment) => (
    spawnProcess(command, arguments_, { cwd, environment: childEnvironment, stdio })
  ), { environment });
}

/** Run exact test files or one named suite under a fresh synthetic profile. */
export async function runIsolatedTestCommand(argv, {
  environment = process.env,
  cwd = REPOSITORY_ROOT,
  stdio = "inherit",
} = {}) {
  const selected = parseIsolatedTestArguments(argv);
  if (selected.help) {
    console.log(`Usage: node scripts/run-isolated-tests.mjs [--test-concurrency=1] [--test-reporter=dot|spec|tap] (--suite=root|ui|electron|local | -- <test-file>...)\n\nNo suite is selected by default. Exact files and suite members must be regular, canonical repository test files.`);
    return;
  }
  const files = await resolveIsolatedTestFiles({
    suite: selected.suite,
    files: selected.files,
  });
  const nodeArguments = ["--test", `--test-concurrency=${selected.concurrency}`];
  if (selected.reporter !== null) nodeArguments.push(`--test-reporter=${selected.reporter}`);
  nodeArguments.push(...files);
  await runIsolatedProcess(process.execPath, nodeArguments, { environment, cwd, stdio });
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  runIsolatedTestCommand(process.argv.slice(2)).catch((error) => {
    const message = typeof error?.message === "string"
      && /^ISOLATED_TEST_[A-Z0-9_:.-]+$/u.test(error.message)
      ? error.message
      : "ISOLATED_TEST_RUNNER_FAILED";
    console.error(message);
    process.exitCode = 1;
  });
}
