import applicationIdentity from "../../../config/application-identity.cjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

import {
  createCompanionSupervisor,
} from "../companion-supervisor.js";
import {
  createDesktopLifecycle as composeLifecycle,
} from "../desktop-lifecycle.js";
const createDesktopLifecycle = options => composeLifecycle({ desktopLocale: "en-US", ...options });
import {
  launchDesktopRuntime,
} from "../desktop-runtime.js";
import {
  DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
} from "../desktop-first-run.js";
import {
  assertElectronQualificationLaunchOptions,
  companionEnvironment,
  installWindowsSmokeControl,
  installWindowsSmokeControlForTest,
  launchElectronShell,
  createWindowsNormalCandidateCompanionProcessObserver,
  createWindowsNormalCandidateDashboardFailureObserver,
  readProductionDistribution,
  ELECTRON_COMPANION_PROCESS_DIAGNOSTIC_PREFIX,
  ELECTRON_DASHBOARD_FAILURE_DIAGNOSTIC_PREFIX,
} from "../main.js";
import { createProductionDistributionMetadata } from "../desktop-updater.js";
import {
  ELECTRON_ENTRY_FAILURE_DIAGNOSTIC,
  ElectronShellError,
} from "../errors.js";
import {
  assertElectronPlatformGate,
} from "../platform-gate.js";
import {
  assertWindowsElectronQualificationContext,
  createWindowsElectronQualificationContext,
  runWindowsElectronQualificationCredentialCommandForTest,
} from "../windows-qualification.js";
import {
  createLoopbackNavigationPolicy,
  installLoopbackNavigationPolicy,
  parseCodexThreadURL,
  isAllowedCompanionURL,
} from "../loopback-policy.js";
import {
  COMPANION_READY_LINE_PREFIX,
  createCompanionReadyLineParser,
  parseCompanionReadyLine,
} from "../ready-line.js";
import {
  createWindowsQualificationModeContext,
  WINDOWS_QUALIFICATION_REQUIRED_RESOURCE_PATHS,
} from "../../../src/platform/windows-qualification-mode.js";
import {
  createWindowsFilesystemAdapter,
  WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS,
} from "../../../src/platform/windows-filesystem.js";
import {
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
} from "../../../src/platform/windows-account-observation-broker.js";
import {
  createWindowsFilesystemBindingManifest,
} from "../../../scripts/build-windows-filesystem-manifest.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);
const WINDOWS_KEYTAR_PATH = require.resolve(
  "@github/keytar/prebuilds/win32-x64/keytar.node",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function syntheticWindowsFilesystemBinding() {
  return {
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    credentialAuditFileGuardContractVersion: "windows-credential-audit-file-guard-v1",
    credentialMutexContractVersion: "windows-credential-mutex-v1",
    productionSafe: false,
    pathWalkRaceSafe: false,
    credentialMutexSafe: true,
    credentialAuditFileGuardSafe: true,
    ...Object.fromEntries(
      WINDOWS_FILESYSTEM_BINDING_REQUIRED_METHODS.map((method) => [method, () => undefined]),
    ),
  };
}

const WINDOWS_QUALIFICATION_IDENTITY = Object.freeze({
  volumeSerialNumber: "0000000000000001",
  fileId: "00112233445566778899aabbccddeeff",
  linkCount: 1,
});

function qualificationFilesystemAdapter() {
  const bindingBytes = Buffer.from("synthetic Windows qualification binding\n");
  const binding = {
    ...syntheticWindowsFilesystemBinding(),
    inspectPath() {
      return {
        identity: WINDOWS_QUALIFICATION_IDENTITY,
        isDirectory: true,
        isRegularFile: false,
        isReparsePoint: false,
        finalPathResolved: true,
      };
    },
  };
  return createWindowsFilesystemAdapter({
    platform: "win32",
    architecture: "x64",
    bindingPath: "C:\\qualification\\native\\windows-filesystem\\build\\Release\\windows_filesystem.node",
    resolveBinding: (path) => path,
    readManifest: () => JSON.stringify(createWindowsFilesystemBindingManifest({
      bytes: bindingBytes,
      binding,
    })),
    readBindingBytes: () => bindingBytes,
    requireBinding: () => binding,
  });
}

function qualificationProfileEnvironment(root = "C:\\qualification-profile") {
  return Object.freeze({
    USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
    USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
    USAGE_MONITOR_ACCOUNTING_SOURCE_MODE: "unified",
    TEMP: `${root}\\tmp`,
    TMP: `${root}\\tmp`,
    TMPDIR: `${root}\\tmp`,
    USERPROFILE: `${root}\\home`,
    HOME: `${root}\\home`,
    APPDATA: `${root}\\appdata`,
    LOCALAPPDATA: `${root}\\localappdata`,
    CODEX_HOME: `${root}\\codex`,
    XDG_CONFIG_HOME: `${root}\\config`,
    XDG_DATA_HOME: `${root}\\data`,
    XDG_CACHE_HOME: `${root}\\cache`,
    XDG_RUNTIME_DIR: `${root}\\runtime`,
    USAGE_MONITOR_STATE_ROOT: `${root}\\state`,
  });
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function withTestTimeout(promise, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withWindowsQualificationFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "usagemonitor-electron-qualification-"));
  const appPath = join(root, "app");
  const bindingPath = join(appPath, "native/windows-filesystem/build/Release/windows_filesystem.node");
  const bindingManifestPath = `${bindingPath}.manifest.json`;
  const keytarPath = join(appPath, "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node");
  const binding = Buffer.from("synthetic Windows qualification binding\n");
  const keytar = await readFile(WINDOWS_KEYTAR_PATH);
  const bindingManifestValue = createWindowsFilesystemBindingManifest({
    bytes: binding,
    binding: syntheticWindowsFilesystemBinding(),
  });
  const bindingManifest = Buffer.from(`${JSON.stringify(bindingManifestValue)}\n`);
  const runtimeSourcePaths = [...WINDOWS_QUALIFICATION_REQUIRED_RESOURCE_PATHS];
  const packageBytes = Buffer.from(JSON.stringify({
    name: "app-usagemonitor", main: "apps/electron/main.js",
    usageMonitorIdentity: applicationIdentity.applicationMetadata("development"),
  }));
  const runtimeFiles = [
    { path: "package.json", bytes: packageBytes.length, kind: "runtime_metadata", sha256: sha256(packageBytes) },
    ...runtimeSourcePaths.map((path) => {
      const content = Buffer.from(path, "utf8");
      return {
        bytes: content.byteLength,
        kind: path.startsWith("apps/web/")
          ? "dashboard_asset"
          : path === "apps/local/server.js"
            ? "companion_source"
            : "electron_shell",
        path,
        sha256: sha256(content),
      };
    }),
    {
      bytes: binding.byteLength,
      kind: "windows_native_binding",
      path: "native/windows-filesystem/build/Release/windows_filesystem.node",
      sha256: sha256(binding),
    },
    {
      bytes: bindingManifest.byteLength,
      kind: "windows_native_binding",
      path: "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
      sha256: sha256(bindingManifest),
    },
    {
      bytes: keytar.byteLength,
      kind: "third_party_dependency",
      path: "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
      sha256: sha256(keytar),
    },
  ].sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const payloadHash = createHash("sha256");
  let payloadBytes = 0;
  for (const row of runtimeFiles) {
    payloadBytes += row.bytes;
    payloadHash.update(`F\0${row.path}\0${row.bytes}\0${row.sha256}\0${row.kind}\0`);
  }
  const bindingRow = runtimeFiles.find((row) =>
    row.path === "native/windows-filesystem/build/Release/windows_filesystem.node");
  const runtimeManifest = {
    schemaVersion: "usage-monitor-electron-runtime-v0.1",
    target: "win32",
    architecture: "x64",
    releaseVersion: "0.1.0-dev",
    entrypoint: "apps/electron/main.js",
    dashboardRoot: "apps/web/public",
    files: runtimeFiles,
    payload: {
      bytes: payloadBytes,
      sha256: payloadHash.digest("hex"),
    },
    windowsBinding: {
      binding: {
        bytes: bindingRow.bytes,
        path: bindingRow.path,
        sha256: bindingRow.sha256,
      },
      included: true,
      manifest: {
        path: "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
      },
      status: "included_unverified",
      verified: false,
    },
  };
  await mkdir(join(appPath, "native/windows-filesystem/build/Release"), { recursive: true });
  await mkdir(join(appPath, "node_modules/@github/keytar/prebuilds/win32-x64"), {
    recursive: true,
  });
  await writeFile(join(appPath, "package.json"), packageBytes);
  await writeFile(bindingPath, binding);
  await writeFile(bindingManifestPath, bindingManifest);
  await writeFile(keytarPath, keytar);
  for (const row of runtimeSourcePaths) {
    const content = Buffer.from(row, "utf8");
    const path = join(appPath, ...row.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  await writeFile(
    join(appPath, "electron-runtime-manifest.json"),
    `${JSON.stringify(runtimeManifest)}\n`,
  );
  const app = {
    isPackaged: true,
    getAppPath: () => appPath,
    getName: () => "Rhetrion Dev",
  };
  const environment = {
    USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
    USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
  };
  try {
    const context = await createWindowsElectronQualificationContext({
      app,
      environment,
      platform: "win32",
      architecture: "x64",
    });
    return await run({
      root,
      appPath,
      context,
      environment,
      runtimeManifest,
      bindingManifest: bindingManifestValue,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function errorCode(code) {
  return (error) => {
    assert.equal(error instanceof ElectronShellError, true);
    assert.equal(error.code, `electron_shell_${code}`);
    assert.equal(error.message, "Electron shell operation failed");
    return true;
  };
}

function electronEntryCompositionFailure(error) {
  if (process.platform === "win32") {
    return error instanceof ElectronShellError
      && error.code === "electron_shell_windows_readiness_unavailable"
      && error.message === "Electron shell operation failed";
  }
  return /BrowserWindow is required/u.test(error?.message ?? "");
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kills = [];
  }

  kill(signal) {
    this.kills.push(signal);
    return true;
  }
}

class FakeApp extends EventEmitter {
  getPreferredSystemLanguages() { return ["en-US"]; }
  getLocale() { return "en-US"; }
  constructor() {
    super();
    this.quitCalls = 0;
    this.showCalls = 0;
    this.focusCalls = [];
    this.lockCalls = 0;
    this.readyCalls = 0;
  }

  requestSingleInstanceLock() {
    this.lockCalls += 1;
    return true;
  }

  async whenReady() {
    this.readyCalls += 1;
  }

  quit() {
    this.quitCalls += 1;
  }

  show() {
    this.showCalls += 1;
  }

  focus(options) {
    this.focusCalls.push(options);
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.mainFrame = { isMainFrame: true, parent: null };
    this.sent = [];
    this.session = {
      setPermissionRequestHandler: (handler) => {
        this.permissionHandler = handler;
      },
      setPermissionCheckHandler: (handler) => {
        this.permissionCheckHandler = handler;
      },
      webRequest: {
        onBeforeRequest: (filter, listener) => {
          this.requestFilter = filter;
          this.requestListener = listener;
        },
      },
    };
    this.windowOpenHandler = null;
  }

  setWindowOpenHandler(handler) {
    this.windowOpenHandler = handler;
  }

  send(channel, command) {
    this.sent.push({ channel, command });
  }
}

class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.destroyed = false;
    this.loaded = [];
    this.webContents.getURL = () => this.loaded.at(-1) ?? "";
  }

  loadURL(url) {
    this.loaded.push(url);
    return Promise.resolve();
  }

  show() {
    this.visible = true;
  }

  hide() {
    this.visible = false;
  }

  focus() {}

  isVisible() {
    return this.visible;
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
  }
}

function downloadSession() {
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  session.webRequest = {
    onBeforeRequest() {},
  };
  return session;
}

class DownloadSessionWindow extends FakeWindow {
  constructor(options) {
    super(options);
    this.webContents.session = downloadSession();
    this.webContents.getURL = () => this.loaded.at(-1) ?? "";
  }
}

class FakeTray extends EventEmitter {
  constructor(icon) {
    super();
    this.icon = icon;
    this.menu = null;
    this.destroyed = false;
  }

  setToolTip(value) {
    this.tooltip = value;
  }

  setContextMenu(menu) {
    this.menu = menu;
  }

  destroy() {
    this.destroyed = true;
  }
}

class RuntimeApp extends FakeApp {
  constructor() {
    super();
    this.ready = false;
  }

  async whenReady() {
    this.ready = true;
    return super.whenReady();
  }

  getPath(name) {
    assert.equal(name, "userData");
    return "/private/usagemonitor-shell-test-user-data";
  }
}

class RuntimeWebContents extends FakeWebContents {
  constructor() {
    super();
    this.url = "";
  }

  getURL() {
    return this.url;
  }
}

class RuntimeWindow extends FakeWindow {
  static instances = [];

  constructor(options) {
    super(options);
    this.webContents = new RuntimeWebContents();
    RuntimeWindow.instances.push(this);
  }

  loadURL(url) {
    this.loaded.push(url);
    this.webContents.url = url;
    return Promise.resolve();
  }
}

class RuntimeChild extends FakeChild {
  kill(signal) {
    this.kills.push(signal);
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}


function runtimePlatformServices() {
  return {
    defaultCodexHome: process.platform === "win32" ? "C:\\Users\\adam\\.codex" : "/Users/adam/.codex",
    defaultCodexHomeDisplay: "Default location (~/.codex)",
    validateCodexHome: async (path) => path,
    loginItemStatus: () => ({ status: "unavailable", canSet: false, detail: "unavailable" }),
    setStartAtLogin: () => ({ status: "unavailable", canSet: false, detail: "unavailable" }),
    notificationStatus: () => ({
      permission: "unavailable",
      available: false,
      detail: "unavailable",
    }),
    chooseCodexHome: async () => "/Users/adam/.codex-custom",
    openSystemSettings: async () => {},
    openExternal: async () => {},
    about: () => ({
      version: "0.1.17",
      build: "test",
      update: { status: "unavailable", canCheck: false, detail: "unavailable" },
      automaticUpdates: {
        enabled: false,
        available: false,
        canSet: false,
        detail: "unavailable",
      },
    }),
  };
}

async function launchDashboardRuntimeFixture({
  environmentOverrides = {},
} = {}) {
  RuntimeWindow.instances = [];
  const app = new RuntimeApp();
  const child = new RuntimeChild();
  const spawnCalls = [];
  const ipcMain = {
    handler: null,
    handle(channel, handler) {
      if (channel === "usagemonitor:x-reader:v1") { this.xHandler = handler; return; }
      assert.equal(channel, "usagemonitor:desktop:v1");
      this.handler = handler;
    },
    removeHandler(channel) {
      if (channel === "usagemonitor:x-reader:v1") { this.xHandler = null; return; }
      assert.equal(channel, "usagemonitor:desktop:v1");
      this.handler = null;
    },
  };
  const settingsBackend = {
    async load() {
      return null;
    },
    async save(value) {
      return value;
    },
  };
  const launch = launchDesktopRuntime({
    runtime: {
      app,
      dialog: {
        showMessageBox: async () => {
          assert.equal(app.ready, true);
          return { response: 0 };
        },
      },
      BrowserWindow: RuntimeWindow,
      Tray: FakeTray,
      Menu: { buildFromTemplate: (template) => ({ template }) },
      icon: "test-icon",
      ipcMain,
    },
    app,
    paths: {
      companionScript: "/repo/apps/local/server.js",
      companionCwd: "/repo",
      resourceRoot: "/repo",
      preloadPath: "/private/preload.cjs",
    },
    environment: {
      HOME: "/Users/adam",
      USAGE_MONITOR_RESOURCE_ROOT: "/repo",
      USAGE_MONITOR_STATE_ROOT: "/private/usagemonitor-shell-test-companion-state",
      USAGE_MONITOR_CENTRAL_ORIGIN: "http://127.0.0.1:8792",
      ...environmentOverrides,
    },
    platformServices: runtimePlatformServices(),
    settingsBackend,
    firstRunReceiptBackend: {
      load: async () => ({
        schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
        acknowledged: true,
      }),
      save: async () => {},
    },
    notificationBackend: {
      load: async () => null,
      save: async (value) => value,
    },
    platform: "win32",
    supervisorOptions: {
      spawnChild(_command, args, options) {
        spawnCalls.push({ args: [...args], options });
        queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from("USAGE_MONITOR_READY http://127.0.0.1:4811/\n"));
        });
        return child;
      },
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
    },
  });
  launch.catch(() => {});
  const desktop = await launch;
  const dashboard = RuntimeWindow.instances.find((candidate) => (
    candidate.loaded[0] === "http://127.0.0.1:4811/"
  ));
  assert.notEqual(dashboard, undefined);
  return { app, child, desktop, dashboard, ipcMain, spawnCalls };
}

function dashboardWindowsForTest(windows) {
  return windows.filter((candidate) => (
    candidate.options?.webPreferences?.preload === "/private/preload.cjs"
  ));
}

test("ready-line parser accepts only the fixed loopback contract", () => {
  assert.equal(parseCompanionReadyLine("diagnostic\n"), null);
  assert.deepEqual(
    parseCompanionReadyLine("USAGE_MONITOR_READY http://127.0.0.1:8791/\n"),
    {
      origin: "http://127.0.0.1:8791",
      url: "http://127.0.0.1:8791/",
      port: 8791,
    },
  );
  for (const line of [
    "USAGE_MONITOR_READY http://localhost:8791/\n",
    "USAGE_MONITOR_READY http://127.0.0.1:0/\n",
    "USAGE_MONITOR_READY http://127.0.0.1:65536/\n",
    "USAGE_MONITOR_READY http://127.0.0.1:8791/\r\n",
    "USAGE_MONITOR_READY http://127.0.0.1:8791/ extra\n",
  ]) {
    assert.throws(() => parseCompanionReadyLine(line), errorCode("companion_ready_invalid"), line);
  }
});

test("ready-line parser is bounded and works across stdout chunks", () => {
  const observed = [];
  const parser = createCompanionReadyLineParser({ onReady: (value) => observed.push(value) });
  parser.feed(Buffer.from(`${COMPANION_READY_LINE_PREFIX}http://127.0.`));
  assert.equal(parser.ready, null);
  parser.feed(Buffer.from("0.1:3456/\nignored after ready\n"));
  assert.equal(parser.ready.origin, "http://127.0.0.1:3456");
  assert.equal(observed.length, 1);
  assert.equal(parser.finish().port, 3456);
  assert.throws(
    () => createCompanionReadyLineParser().feed(`${COMPANION_READY_LINE_PREFIX}${"x".repeat(2_000)}`),
    errorCode("companion_ready_overflow"),
  );
});

test("loopback policy allows the selected origin and denies remote navigation and permissions", () => {
  const origin = "http://127.0.0.1:3456";
  const policy = createLoopbackNavigationPolicy({ origin });
  assert.equal(isAllowedCompanionURL(`${origin}/api/local/health`, origin), true);
  assert.equal(policy.isAllowedURL(`${origin}/`), true);
  assert.equal(policy.isAllowedURL("http://127.0.0.1:3457/"), false);
  assert.equal(policy.isAllowedURL("https://127.0.0.1:3456/"), false);
  assert.equal(policy.isAllowedURL("http://127.0.0.1:3456@evil.example/"), false);
  let prevented = false;
  assert.equal(policy.handleWillNavigate({ preventDefault() { prevented = true; } }, "https://example.test/"), false);
  assert.equal(prevented, true);
  prevented = false;
  assert.equal(policy.handleWillFrameNavigate(
    { preventDefault() { prevented = true; } },
    { url: `${origin}/report`, isMainFrame: true },
  ), true);
  assert.equal(prevented, false);
  assert.equal(policy.handleWillFrameNavigate(
    { preventDefault() { prevented = true; } },
    { url: `${origin}/embedded`, isMainFrame: false },
  ), false);
  assert.equal(prevented, true);
  prevented = false;
  assert.equal(policy.handleWillAttachWebview({ preventDefault() { prevented = true; } }), false);
  assert.equal(prevented, true);
  let callbackValue = null;
  assert.equal(policy.handlePermissionRequest({ callback: (value) => { callbackValue = value; } }), false);
  assert.equal(callbackValue, false);
  assert.deepEqual(policy.handleWindowOpen(), { action: "deny" });
  assert.throws(() => createLoopbackNavigationPolicy({ origin: "http://localhost:3456" }), errorCode("invalid_loopback_origin"));
});

test("Codex thread host parsing is exact and navigation remains fail-closed", () => {
  const canonical = "codex://threads/11111111-1111-4111-8111-111111111111";
  const parsed = parseCodexThreadURL(canonical);
  assert.deepEqual(parsed, { threadId: "11111111-1111-4111-8111-111111111111", canonicalURL: canonical });
  assert.equal(Object.isFrozen(parsed), true);
  for (const value of [
    "codex://threads/not-a-thread",
    "codex://threads/11111111-1111-0111-8111-111111111111",
    "codex://threads/11111111-1111-4111-1111-111111111111",
    "codex://threads/11111111-1111-4111-8111-111111111111/extra",
    "codex://threads/11111111-1111-4111-8111-111111111111?query",
    "codex://threads/11111111-1111-4111-8111-111111111111#fragment",
    "codex://user@threads/11111111-1111-4111-8111-111111111111",
    "codex://threads:443/11111111-1111-4111-8111-111111111111",
    "codex://threads/%31" + "1111111-1111-4111-8111-111111111111",
    "CODEX://threads/11111111-1111-4111-8111-111111111111",
  ]) {
    assert.equal(parseCodexThreadURL(value), null, value);
  }

  const policy = createLoopbackNavigationPolicy({ origin: "http://127.0.0.1:3456" });
  let prevented = false;
  assert.equal(
    policy.handleWillNavigate({ preventDefault() { prevented = true; } }, canonical),
    false,
  );
  assert.equal(prevented, true);
  prevented = false;
  assert.equal(
    policy.handleWillFrameNavigate(
      { preventDefault() { prevented = true; } },
      { url: canonical, isMainFrame: false },
    ),
    false,
  );
  assert.equal(prevented, true);
});

test("loopback policy installs exact navigation handlers and removable listeners", () => {
  const webContents = new FakeWebContents();
  const permissionCalls = [];
  const session = {
    setPermissionRequestHandler(handler) {
      this.handler = handler;
    },
    setPermissionCheckHandler(handler) {
      this.checkHandler = handler;
    },
    webRequest: {
      onBeforeRequest(filter, listener) {
        this.filter = filter;
        this.listener = listener;
      },
    },
  };
  const policy = createLoopbackNavigationPolicy({ origin: "http://127.0.0.1:3456" });
  const installed = installLoopbackNavigationPolicy({ webContents, session, policy });
  let prevented = false;
  webContents.emit("will-navigate", { preventDefault() { prevented = true; } }, "https://example.test/");
  assert.equal(prevented, true);
  session.handler(null, "geolocation", (value) => permissionCalls.push(value));
  assert.deepEqual(permissionCalls, [false]);
  assert.equal(session.checkHandler(), false);
  const requests = [];
  session.webRequest.listener(
    { url: "http://127.0.0.1:3456/api/local/health" },
    (decision) => requests.push(decision),
  );
  session.webRequest.listener(
    { url: "https://example.test/" },
    (decision) => requests.push(decision),
  );
  assert.deepEqual(requests, [{ cancel: false }, { cancel: true }]);
  assert.deepEqual(session.webRequest.filter, { urls: ["<all_urls>"] });
  webContents.emit("will-frame-navigate", { preventDefault() { prevented = true; } }, {
    url: "https://example.test/",
    isMainFrame: true,
  });
  assert.equal(prevented, true);
  assert.deepEqual(webContents.windowOpenHandler().action, "deny");
  installed.remove();
  assert.equal(session.webRequest.listener, null);
  prevented = false;
  webContents.emit("will-navigate", { preventDefault() { prevented = true; } }, "https://example.test/");
  assert.equal(prevented, false);
});

test("protected background resources require a tracked dashboard image request and lose access on removal", () => {
  const origin = "http://127.0.0.1:3456";
  const session = {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    webRequest: { onBeforeRequest(_filter, listener) { this.listener = listener; } },
  };
  const dashboard = new FakeWebContents();
  dashboard.id = 41;
  dashboard.mainFrame.url = `${origin}/#settings/general`;
  const keeper = new FakeWebContents();
  keeper.id = 42;
  const policy = createLoopbackNavigationPolicy({ origin });
  const installed = installLoopbackNavigationPolicy({ webContents: dashboard, session, policy, allowBackgroundResource: true });
  const keeperInstallation = installLoopbackNavigationPolicy({ webContents: keeper, session, policy });
  const valid = {
    url: "usagemonitor-background://image/11111111-1111-4111-8111-111111111111",
    resourceType: "image", method: "GET", webContentsId: dashboard.id, frame: dashboard.mainFrame,
  };
  const check = (details, cancel) => {
    const decisions = [];
    session.webRequest.listener(details, (value) => decisions.push(value));
    assert.deepEqual(decisions, [{ cancel }]);
  };
  check(valid, false);
  for (const patch of [
    { webContentsId: keeper.id }, { webContentsId: 999 }, { method: "POST" },
    { resourceType: "mainFrame" }, { resourceType: "xhr" }, { frame: undefined },
    { frame: { ...dashboard.mainFrame } },
    { frame: { url: `${origin}/`, parent: dashboard.mainFrame, isMainFrame: false } },
    { url: `${valid.url}?query` }, { url: `${valid.url}#fragment` },
    { url: "usagemonitor-background://image/invalid" },
    { url: "usagemonitor-background://other/11111111-1111-4111-8111-111111111111" },
  ]) check({ ...valid, ...patch }, true);
  for (const url of ["https://example.test/", `${origin}/app.js`, `${origin}/?query`, "http://127.0.0.1:3457/"]) {
    dashboard.mainFrame.url = url;
    check(valid, true);
  }
  dashboard.mainFrame.url = `${origin}/`;
  installed.remove();
  check(valid, true);
  keeperInstallation.remove();
  assert.equal(session.webRequest.listener, null);
});

test("loopback session denies Blob downloads and clipboard writes for every window", () => {
  const origin = "http://127.0.0.1:3456";
  const blob = `blob:${origin}/4a4e02e8-2cbf-4dfb-bb2a-4f6e4c0efb90`;
  const session = {
    setPermissionRequestHandler(handler) { this.handler = handler; },
    setPermissionCheckHandler(handler) { this.checkHandler = handler; },
    webRequest: {
      onBeforeRequest(filter, listener) {
        this.filter = filter;
        this.listener = listener;
      },
    },
  };
  const dashboard = new FakeWebContents();
  dashboard.id = 41;
  const settings = new FakeWebContents();
  settings.id = 42;
  const dashboardInstall = installLoopbackNavigationPolicy({
    webContents: dashboard,
    session,
    policy: createLoopbackNavigationPolicy({ origin }),
  });
  const settingsInstall = installLoopbackNavigationPolicy({
    webContents: settings,
    session,
    policy: createLoopbackNavigationPolicy({ origin }),
    allowNotificationPermission: true,
  });
  const permissions = [];
  session.handler(settings, "notifications", (allowed) => permissions.push(allowed));
  session.handler(dashboard, "notifications", (allowed) => permissions.push(allowed));
  session.handler(settings, "geolocation", (allowed) => permissions.push(allowed));
  for (const contents of [dashboard, settings]) {
    for (const permission of ["clipboard-sanitized-write", "clipboard-read"]) {
      session.handler(contents, permission, (allowed) => permissions.push(allowed), {
        isMainFrame: true, requestingUrl: `${origin}/`,
      });
    }
  }
  assert.deepEqual(permissions, [true, false, false, false, false, false, false]);
  assert.equal(session.checkHandler(settings, "notifications"), true);
  assert.equal(session.checkHandler(dashboard, "notifications"), false);
  for (const contents of [dashboard, settings]) {
    for (const permission of ["clipboard-sanitized-write", "clipboard-read"]) {
      assert.equal(session.checkHandler(contents, permission, origin, {
        isMainFrame: true, requestingUrl: `${origin}/`,
      }), false);
    }
  }
  const download = {
    url: blob,
    method: "GET",
    resourceType: "other",
    webContentsId: dashboard.id,
  };
  const decisions = [];
  const request = (details) => session.webRequest.listener(details, (value) => decisions.push(value));
  request(download);
  request({ ...download, webContentsId: settings.id });
  request({ ...download, url: "blob:https://evil.example/id" });
  request({ ...download, url: `${origin}/api/status`, resourceType: "xhr" });
  assert.deepEqual(decisions, [
    { cancel: true },
    { cancel: true },
    { cancel: true },
    { cancel: false },
  ]);
  settingsInstall.remove();
  dashboardInstall.remove();
});

test("session permission grants are revoked on final release and restored only for a newly registered window", () => {
  const session = {
    setPermissionRequestHandler(handler) { this.request = handler; },
    setPermissionCheckHandler(handler) { this.check = handler; },
    webRequest: { onBeforeRequest() {} },
  };
  const contents = new FakeWebContents();
  contents.id = 91;
  const policy = createLoopbackNavigationPolicy({ origin: "http://127.0.0.1:3456" });
  const first = installLoopbackNavigationPolicy({ webContents: contents, session, policy, allowNotificationPermission: true });
  const second = installLoopbackNavigationPolicy({ webContents: contents, session, policy, allowNotificationPermission: true });
  const deniedWindow = new FakeWebContents();
  const denied = installLoopbackNavigationPolicy({ webContents: deniedWindow, session, policy });
  const check = (target, expected) => {
    const decisions = [];
    session.request(target, "notifications", (allowed) => decisions.push(allowed));
    assert.deepEqual(decisions, [expected]);
    assert.equal(session.check(target, "notifications"), expected);
    assert.equal(session.check(target, "media"), false);
  };
  check(contents, true);
  check(deniedWindow, false);
  first.remove();
  first.remove();
  check(contents, true);
  second.remove();
  check(contents, false);
  denied.remove();
  check(contents, false);
  assert.equal(typeof session.request, "function");
  assert.equal(typeof session.check, "function");

  const replacement = new FakeWebContents();
  replacement.id = contents.id;
  const restored = installLoopbackNavigationPolicy({ webContents: replacement, session,
    policy: createLoopbackNavigationPolicy({ origin: "http://127.0.0.1:3457" }), allowNotificationPermission: true });
  check(contents, false);
  check(replacement, true);
  restored.remove();
  check(replacement, false);
});


test("companion supervisor starts a live plain child without Node IPC", async (t) => {
  const childSource = [
    "process.stdout.write('USAGE_MONITOR_READY http://127.0.0.1:4546/\\n');",
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1_000);",
  ].join("\n");
  let child = null;
  let selected = null;
  const supervisor = createCompanionSupervisor({
    command: process.execPath,
    args: ["--eval", childSource],
    cwd: REPOSITORY_ROOT,
    spawnChild(command, args, options) {
      selected = options;
      child = spawn(command, args, options);
      return child;
    },
  });
  t.after(async () => { await supervisor.stop().catch(() => {}); });

  const ready = await supervisor.start();
  assert.equal(child?.connected, false);
  assert.deepEqual(selected?.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(ready.origin, "http://127.0.0.1:4546");
  await supervisor.stop();
  assert.equal(supervisor.state.state, "stopped");
});


test("companion supervisor retains only a classified startup error before ready", async () => {
  const child = new FakeChild();
  const supervisor = createCompanionSupervisor({spawnChild:()=>child,command:"node",args:["apps/local/server.js"],cwd:REPOSITORY_ROOT});
  const starting=supervisor.start();
  child.stderr.emit("data",Buffer.from("private diagnostics\nUSAGE_MONITOR_COMPANION_FAILURE companion_state_security_policy\n"));
  const rejected=assert.rejects(starting,errorCode("companion_state_security_policy"));
  child.emit("exit",1,null);
  await rejected;
});

test("companion supervisor owns one child, injects a parent contract, and strips child output", async () => {
  const child = new FakeChild();
  const spawnCalls = [];
  const supervisor = createCompanionSupervisor({
    spawnChild(command, args, options) {
      spawnCalls.push({ command, args, options });
      return child;
    },
    command: "node",
    args: ["apps/local/server.js"],
    cwd: REPOSITORY_ROOT,
    environment: {
      PRIVATE_CANARY: "must-not-escape",
      PATH: "/safe/path",
      CODEX_HOME: "/safe/codex",
      USAGE_MONITOR_CENTRAL_ORIGIN: "http://127.0.0.1:8792",
      APP_USAGEMONITOR_EXPORT_SECRET: "secret-must-not-escape",
      APP_USAGEMONITOR_ACCOUNT_HMAC_KEY: "hmac-must-not-escape",
      USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY: "1",
      USAGE_MONITOR_DEVELOPMENT_ARTIFACT_FALLBACK: "1",
      USAGE_MONITOR_WINDOWS_FILESYSTEM_DEVELOPMENT: "1",
      USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
      USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
      USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID:
        "550e8400-e29b-41d4-a716-446655440000",
      ELECTRON_RUN_AS_NODE: "0",
    },
    parentPid: 4242,
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
  });
  const firstStart = supervisor.start();
  assert.equal(supervisor.start(), firstStart);
  child.stderr.emit("data", Buffer.from("secret child diagnostics"));
  child.stdout.emit("data", Buffer.from("ordinary child line\n"));
  child.stdout.emit("data", Buffer.from("USAGE_MONITOR_READY http://127.0.0.1:4545/\n"));
  const ready = await firstStart;
  assert.equal(ready.origin, "http://127.0.0.1:4545");
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].options.env.PRIVATE_CANARY, undefined);
  assert.equal(spawnCalls[0].options.env.PATH, "/safe/path");
  assert.equal(spawnCalls[0].options.env.CODEX_HOME, "/safe/codex");
  assert.equal(
    spawnCalls[0].options.env.USAGE_MONITOR_CENTRAL_ORIGIN,
    undefined,
    "the retired central upload origin is never forwarded to the companion",
  );
  assert.equal(spawnCalls[0].options.env.APP_USAGEMONITOR_EXPORT_SECRET, undefined);
  assert.equal(spawnCalls[0].options.env.APP_USAGEMONITOR_ACCOUNT_HMAC_KEY, undefined);
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_ENABLE_DEVELOPMENT_IDENTITY, undefined);
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_DEVELOPMENT_ARTIFACT_FALLBACK, undefined);
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_WINDOWS_FILESYSTEM_DEVELOPMENT, undefined);
  assert.equal(
    spawnCalls[0].options.env.USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION,
    "windows-electron-v1",
  );
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_TEST_LANE, "windows-electron-smoke");
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID, undefined);
  assert.equal(spawnCalls[0].options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_PORT, "0");
  assert.equal(spawnCalls[0].options.env.USAGE_MONITOR_PARENT_PID, "4242");
  assert.deepEqual(supervisor.state, {
    state: "ready",
    hasChild: true,
    origin: "http://127.0.0.1:4545",
  });
  const stopped = supervisor.stop();
  assert.deepEqual(child.kills, ["SIGTERM"]);
  child.emit("exit", 0, null);
  await stopped;
  assert.equal(supervisor.state.hasChild, false);
});


test("production policy reads only the final packaged app manifest and validates its target", async () => {
  const metadata = createProductionDistributionMetadata({
    target: "win32-x64", sourceRevision: "a".repeat(40), buildNumber: "20260906",
  });
  const packagedAppPath = join(tmpdir(), "usagemonitor-policy-fixture", "app.asar");
  const paths = [];
  const app = { isPackaged: true, getName: () => "Rhetrion",
    getAppPath: () => packagedAppPath };
  const readManifest = async (path) => {
    paths.push(path);
    return Buffer.from(JSON.stringify({ name: "app-usagemonitor", main: "apps/electron/main.js", usageMonitorIdentity: applicationIdentity.applicationMetadata("stable"), usageMonitorDistribution: metadata }));
  };
  assert.deepEqual(await readProductionDistribution({ app, platform: "win32",
    architecture: "x64", readManifest }), metadata);
  assert.deepEqual(paths, [join(packagedAppPath, "package.json")]);
  await assert.rejects(readProductionDistribution({ app, platform: "win32",
    architecture: "arm64", readManifest }), errorCode("electron_configuration_invalid"));
  for (const value of [{}, { usageMonitorDistribution: { ...metadata, updateFeed: "https://example.test" } }]) {
    await assert.rejects(readProductionDistribution({ app, platform: "win32", architecture: "x64",
      readManifest: async () => Buffer.from(JSON.stringify(value)) }),
    errorCode("electron_configuration_invalid"));
  }
  assert.equal(await readProductionDistribution({ app: { ...app, isPackaged: false },
    readManifest: () => { throw new Error("Unpackaged app must not read authority"); } }), null);
  assert.deepEqual(await readProductionDistribution({ app: { ...app, getName: () => "Any Display Name" },
    platform: "win32", architecture: "x64", readManifest }), metadata);
  assert.equal(await readProductionDistribution({ app: { ...app, getName: () => "Rhetrion" },
    readManifest: async () => Buffer.from(JSON.stringify({ name: "app-usagemonitor",
      main: "apps/electron/main.js", usageMonitorIdentity: applicationIdentity.applicationMetadata("development") })) }), null);
});




test("companion supervisor fails closed on malformed readiness and bounded startup timeout", async (t) => {
  // Real children keep the loop alive; this EventEmitter fixture has no handle.
  const keepAlive = setInterval(() => {}, 1_000);
  t.after(() => clearInterval(keepAlive));
  const malformedChild = new FakeChild();
  const malformed = createCompanionSupervisor({
    spawnChild: () => malformedChild,
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 10,
  });
  const malformedStart = malformed.start();
  malformedChild.stdout.emit("data", Buffer.from("USAGE_MONITOR_READY https://evil.test/\n"));
  await assert.rejects(malformedStart, errorCode("companion_ready_invalid"));
  assert.deepEqual(malformedChild.kills, ["SIGKILL"]);

  const timeoutChild = new FakeChild();
  const timeout = createCompanionSupervisor({
    spawnChild: () => timeoutChild,
    startupTimeoutMs: 10,
    shutdownTimeoutMs: 10,
  });
  await assert.rejects(timeout.start(), errorCode("companion_start_timeout"));
  assert.deepEqual(timeoutChild.kills, ["SIGKILL"]);

  const stubbornChild = new FakeChild();
  const stubborn = createCompanionSupervisor({
    spawnChild: () => stubbornChild,
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 10,
  });
  const stubbornStart = stubborn.start();
  stubbornChild.stdout.emit("data", "USAGE_MONITOR_READY http://127.0.0.1:4567/\n");
  await stubbornStart;
  await assert.rejects(stubborn.stop(), errorCode("companion_shutdown_timeout"));
  assert.deepEqual(stubbornChild.kills, ["SIGTERM", "SIGKILL"]);
});

test("companion supervisor settles immediately when its child exits before ready", async () => {
  const child = new FakeChild();
  const supervisor = createCompanionSupervisor({
    spawnChild: () => child,
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
  });
  const starting = supervisor.start();
  child.emit("exit", 1, null);
  let deadline = null;
  try {
    await Promise.race([
      assert.rejects(starting, errorCode("companion_exit_before_ready")),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("child exit did not settle promptly")), 100);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
  assert.deepEqual(child.kills, []);
  assert.deepEqual(supervisor.state, {
    state: "stopped",
    hasChild: false,
    origin: null,
  });
});

test("companion lifecycle observer projects only closed start and exit states", async () => {
  const child = new FakeChild();
  const events = [];
  const supervisor = createCompanionSupervisor({
    spawnChild: () => child,
    onChildLifecycleEvent(value) { events.push(value); },
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
  });
  const starting = supervisor.start();
  assert.deepEqual(events, [{
    event: "started",
    phase: "starting",
    outcome: null,
  }]);
  child.stdout.emit("data", "USAGE_MONITOR_READY http://127.0.0.1:4567/\n");
  await starting;
  child.emit("exit", null, "SIGSEGV");
  assert.deepEqual(events, [
    { event: "started", phase: "starting", outcome: null },
    { event: "exited", phase: "ready", outcome: "signal_segv" },
  ]);
  assert.equal(events.every((value) => Object.isFrozen(value)), true);
  assert.equal(supervisor.state.state, "stopped");
});

test("companion lifecycle observer retains fixed exit outcomes while starting", async () => {
  for (const [exitCode, signalCode, outcome] of [
    [0, null, "exit_zero"],
    [1, null, "exit_nonzero"],
    [null, "SIGABRT", "signal_abrt"],
    [null, "SIGSEGV", "signal_segv"],
    [null, "SIGKILL", "signal_kill"],
    [null, "SIGTERM", "signal_term"],
    [null, "SIGUSR1", "signal_other"],
  ]) {
    const child = new FakeChild();
    const events = [];
    const supervisor = createCompanionSupervisor({
      spawnChild: () => child,
      onChildLifecycleEvent(value) { events.push(value); },
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
    });
    const starting = supervisor.start();
    child.emit("exit", exitCode, signalCode);
    await assert.rejects(starting, errorCode("companion_exit_before_ready"));
    assert.deepEqual(events, [
      { event: "started", phase: "starting", outcome: null },
      { event: "exited", phase: "starting", outcome },
    ]);
  }
});

test("companion lifecycle observer marks quiet owned shutdown and cannot alter it", async () => {
  const child = new FakeChild();
  const events = [];
  const supervisor = createCompanionSupervisor({
    spawnChild: () => child,
    onChildLifecycleEvent(value) { events.push(value); },
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
  });
  const starting = supervisor.start();
  child.stdout.emit("data", "USAGE_MONITOR_READY http://127.0.0.1:4567/\n");
  await starting;
  const stopping = supervisor.stop();
  child.emit("exit", 0, null);
  await stopping;
  assert.deepEqual(events, [
    { event: "started", phase: "starting", outcome: null },
    { event: "exited", phase: "stopping", outcome: "exit_zero" },
  ]);
  assert.equal(supervisor.state.state, "stopped");

  const throwingChild = new FakeChild();
  const throwingSupervisor = createCompanionSupervisor({
    spawnChild: () => throwingChild,
    onChildLifecycleEvent() { throw new Error("observer failure"); },
    startupTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
  });
  const throwingStart = throwingSupervisor.start();
  throwingChild.stdout.emit("data", "USAGE_MONITOR_READY http://127.0.0.1:4568/\n");
  await throwingStart;
  const throwingStop = throwingSupervisor.stop();
  throwingChild.emit("exit", 0, null);
  await throwingStop;
  assert.equal(throwingSupervisor.state.state, "stopped");
});



test("Windows normal candidate diagnostics exclude qualification and test lanes", () => {
  const writes = [];
  const options = {
    environment: { USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "quit-v1" },
    platform: "win32",
    architecture: "x64",
    writeDiagnostic(value) { writes.push(value); },
  };
  const companion = createWindowsNormalCandidateCompanionProcessObserver(options);
  const dashboard = createWindowsNormalCandidateDashboardFailureObserver(options);
  assert.equal(typeof companion, "function");
  assert.equal(typeof dashboard, "function");
  companion({ event: "started", phase: "starting", outcome: null });
  companion({ event: "exited", phase: "ready", outcome: "exit_nonzero" });
  dashboard({ stage: "did_fail_load", reason: -2 });
  dashboard({ stage: "render_process_gone", reason: "private renderer detail" });
  assert.deepEqual(writes, [
    `${ELECTRON_COMPANION_PROCESS_DIAGNOSTIC_PREFIX}{"event":"started","phase":"starting","outcome":null}\n`,
    `${ELECTRON_COMPANION_PROCESS_DIAGNOSTIC_PREFIX}{"event":"exited","phase":"ready","outcome":"exit_nonzero"}\n`,
    `${ELECTRON_DASHBOARD_FAILURE_DIAGNOSTIC_PREFIX}{"stage":"did_fail_load","reason":-2}\n`,
  ]);

  for (const environment of [
    {},
    { USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "other-v1" },
    { USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "quit-v1", USAGE_MONITOR_TEST_LANE: undefined },
    {
      USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "quit-v1",
      USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-qualification-v1",
    },
  ]) {
    for (const factory of [
      createWindowsNormalCandidateCompanionProcessObserver,
      createWindowsNormalCandidateDashboardFailureObserver,
    ]) {
      assert.equal(factory({ ...options, environment }), undefined);
    }
  }
  for (const platform of ["linux", "darwin"]) {
    assert.equal(createWindowsNormalCandidateDashboardFailureObserver({ ...options, platform }), undefined);
  }
  assert.equal(createWindowsNormalCandidateCompanionProcessObserver({ ...options, architecture: "arm64" }), undefined);
});


test("Windows qualification context accepts the generated unqualified binding manifest", async () => {
  await withWindowsQualificationFixture(async ({ context, bindingManifest }) => {
    assert.deepEqual(bindingManifest.bindingProvenance, {
      contractVersion: "windows-binding-provenance-v1",
      status: "unqualified",
      source: "unsigned-development-binding",
    });
    assert.equal(context.windowsProductionReady, false);
    assert.equal(context.windowsQualificationOnly, true);
    assert.deepEqual(
      assertElectronPlatformGate({
        platform: "win32",
        architecture: "x64",
        qualificationContext: context,
      }),
      {
        platform: "win32",
        architecture: "x64",
        windowsProductionReady: false,
        windowsQualificationOnly: true,
      },
    );
    assert.equal(
      assertWindowsElectronQualificationContext({
        context,
        platform: "win32",
        architecture: "x64",
      }),
      context,
    );
    assert.throws(
      () => assertWindowsElectronQualificationContext({
        context: { ...context },
        platform: "win32",
        architecture: "x64",
      }),
      /Windows Electron qualification is unavailable/u,
    );
    assert.throws(
      () => assertElectronPlatformGate({
        platform: "win32",
        architecture: "x64",
        qualificationContext: { ...context },
      }),
      errorCode("windows_readiness_unavailable"),
    );
  });
});

test("Windows smoke control is qualification-only Node IPC with bounded cleanup", async () => {
  await withWindowsQualificationFixture(async ({ context, environment }) => {
    const source = new EventEmitter();
    const sent = [];
    let quitCalls = 0;
    const lifecycle = {
      state: {
        started: true,
        primaryInstance: true,
        hasWindow: true,
        windowVisible: false,
        hasTray: true,
      },
      invokeTrayCommand(command) {
        assert.equal(command, "show");
        this.state.windowVisible = true;
      },
      requestQuit() {
        quitCalls += 1;
      },
    };
    const qualifiedEnvironment = {
      ...environment,
      USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1",
      USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: "550e8400-e29b-41d4-a716-446655440000",
    };
    const cleanup = installWindowsSmokeControl(lifecycle, {
      platform: "win32",
      environment: qualifiedEnvironment,
      messageSource: source,
      sendMessage(message, callback) {
        sent.push(message);
        callback?.();
      },
      qualificationContext: context,
    });
    assert.equal(source.listenerCount("message"), 1);
    assert.equal(source.listenerCount("disconnect"), 1);
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "status-v1",
    });
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "tray-show-v1",
    });
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "status-v1",
      extra: "reject",
    });
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "unknown-v1",
    });
    source.emit("message", "status-v1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 2);
    assert.equal(Object.isFrozen(sent[0]), true);
    assert.deepEqual(sent[0], {
      type: "windows-electron-smoke-v1",
      message: "state-v1",
      started: true,
      primary: true,
      window: true,
      visible: false,
      tray: true,
    });
    assert.deepEqual(sent[1], {
      type: "windows-electron-smoke-v1",
      message: "state-v1",
      started: true,
      primary: true,
      window: true,
      visible: true,
      tray: true,
    });
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "quit-v1",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(quitCalls, 1);
    assert.equal(source.listenerCount("message"), 0);
    assert.equal(source.listenerCount("disconnect"), 0);
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "status-v1",
    });
    assert.equal(sent.length, 3);
    cleanup();

    const unqualifiedSource = new EventEmitter();
    const unqualifiedSent = [];
    const unqualifiedCleanup = installWindowsSmokeControl(lifecycle, {
      platform: "win32",
      environment,
      messageSource: unqualifiedSource,
      sendMessage: (message) => unqualifiedSent.push(message),
      qualificationContext: context,
    });
    assert.equal(unqualifiedSource.listenerCount("message"), 0);
    unqualifiedSource.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "status-v1",
    });
    assert.deepEqual(unqualifiedSent, []);
    unqualifiedCleanup();
  });
});

test("Windows smoke IPC maps every credential operation to a fixed result", async () => {
  await withWindowsQualificationFixture(async ({ context, environment }) => {
    const source = new EventEmitter();
    const sent = [];
    const callbacks = [];
    const operations = [];
    const lifecycle = {
      state: {
        started: true,
        primaryInstance: true,
        hasWindow: true,
        windowVisible: false,
        hasTray: true,
      },
    };
    const qualifiedEnvironment = {
      ...environment,
      USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1",
      USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: "550e8400-e29b-41d4-a716-446655440000",
      GITHUB_ACTIONS: "true",
      USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION: "windows-account-observation-fd4-v1",
    };
    const cleanup = installWindowsSmokeControlForTest(lifecycle, {
      platform: "win32",
      environment: qualifiedEnvironment,
      messageSource: source,
      sendMessage(message, callback) {
        sent.push(message);
        callbacks.push(callback);
        return false;
      },
      credentialProbe(receivedContext) {
        assert.equal(receivedContext, context);
        operations.push("probe-v1");
      },
      credentialCommand({ context: receivedContext, command, runId }) {
        assert.equal(receivedContext, context);
        assert.equal(runId, qualifiedEnvironment.USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID);
        operations.push(command);
      },
      accountlessStorage() {
        operations.push("retired-accountless-storage-v1");
      },
      accountObservationStorage({ context: receivedContext, environment: receivedEnvironment }) {
        assert.equal(receivedContext, context);
        assert.equal(receivedEnvironment, qualifiedEnvironment);
        operations.push("account-observation-storage-v1");
      },
      qualificationContext: context,
    });
    for (const [command, operation] of [
      ["credential-probe-v1", "probe-v1"],
      ["credential-create-v1", "create-v1"],
      ["credential-read-v1", "read-v1"],
      ["credential-delete-v1", "delete-v1"],
    ]) {
      source.emit("message", {
        type: "windows-electron-smoke-v1",
        message: "command-v1",
        command,
      });
      await nextTick();
      assert.equal(typeof callbacks.at(-1), "function");
      assert.deepEqual(sent.at(-1), {
        type: "windows-electron-smoke-v1",
        message: "credential-v1",
        operation,
        status: "passed-v1",
      });
      // Simulate a sender reporting an asynchronous channel error after
      // returning false for backpressure. The control handler must consume it.
      callbacks.at(-1)(new Error("ERR_IPC_CHANNEL_CLOSED"));
    }
    // The retired FD3 accountless storage command is outside the closed
    // vocabulary: it is ignored and never reaches a runner.
    const sentBeforeRetired = sent.length;
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "accountless-storage-v1",
    });
    await nextTick();
    assert.equal(sent.length, sentBeforeRetired);
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "account-observation-storage-v1",
    });
    await nextTick();
    assert.deepEqual(sent.at(-1), {
      type: "windows-electron-smoke-v1",
      message: "credential-v1",
      operation: "account-observation-storage-v1",
      status: "passed-v1",
    });
    assert.deepEqual(operations, [
      "probe-v1",
      "create-v1",
      "read-v1",
      "delete-v1",
      "account-observation-storage-v1",
    ]);
    cleanup();
    assert.equal(source.listenerCount("message"), 0);
    assert.equal(source.listenerCount("disconnect"), 0);
  });
});

test("Windows observation smoke refuses missing or wrong disposable-CI markers before invoking its runner", async () => {
  await withWindowsQualificationFixture(async ({ context, environment }) => {
    for (const overrides of [
      {},
      { GITHUB_ACTIONS: "true" },
      { GITHUB_ACTIONS: "false", USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION: "windows-account-observation-fd4-v1" },
      { GITHUB_ACTIONS: "true", USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION: "unexpected" },
    ]) {
      const source = new EventEmitter();
      const sent = [];
      let calls = 0;
      const cleanup = installWindowsSmokeControlForTest({ state: { primaryInstance: true } }, {
        platform: "win32",
        environment: { ...environment, USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1", ...overrides },
        qualificationContext: context,
        messageSource: source,
        sendMessage(message) { sent.push(message); },
        credentialProbe() {},
        credentialCommand() {},
        accountObservationStorage() { calls += 1; },
      });
      source.emit("message", { type: "windows-electron-smoke-v1", message: "command-v1", command: "account-observation-storage-v1" });
      await nextTick();
      assert.equal(calls, 0);
      assert.deepEqual(sent, [{ type: "windows-electron-smoke-v1", message: "credential-v1", operation: "account-observation-storage-v1", status: "failed-v1", failureStage: "unavailable" }]);
      cleanup();
    }
  });
});

test("Windows smoke IPC drops in-flight credential replies after disconnect", async () => {
  await withWindowsQualificationFixture(async ({ context, environment }) => {
    const source = new EventEmitter();
    const sent = [];
    const qualifiedEnvironment = {
      ...environment,
      USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1",
      USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: "550e8400-e29b-41d4-a716-446655440000",
    };
    let resolveCredential;
    let credentialStarted;
    const credentialStartedPromise = new Promise((resolve) => {
      credentialStarted = resolve;
    });
    const credentialPending = new Promise((resolve) => {
      resolveCredential = resolve;
    });
    const cleanup = installWindowsSmokeControlForTest({
      state: {
        started: true,
        primaryInstance: true,
        hasWindow: true,
        windowVisible: false,
        hasTray: true,
      },
    }, {
      platform: "win32",
      environment: qualifiedEnvironment,
      messageSource: source,
      sendMessage(message, callback) {
        sent.push(message);
        callback?.();
      },
      credentialProbe: async () => {},
      async credentialCommand() {
        credentialStarted();
        await credentialPending;
      },
      qualificationContext: context,
    });
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "credential-create-v1",
    });
    await credentialStartedPromise;
    assert.equal(source.listenerCount("message"), 1);
    source.emit("disconnect");
    assert.equal(source.listenerCount("message"), 0);
    assert.equal(source.listenerCount("disconnect"), 0);
    resolveCredential();
    await nextTick();
    assert.deepEqual(sent, []);
    cleanup();
  });
});

test("Windows smoke IPC fails closed without a connected sender and orders quit after ack", async () => {
  await withWindowsQualificationFixture(async ({ context, environment }) => {
    const qualifiedEnvironment = {
      ...environment,
      USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: "windows-v1",
      USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID: "550e8400-e29b-41d4-a716-446655440000",
    };
    const makeLifecycle = () => ({
      state: {
        started: true,
        primaryInstance: true,
        hasWindow: true,
        windowVisible: false,
        hasTray: true,
      },
      quitCalls: 0,
      requestQuit() {
        this.quitCalls += 1;
      },
    });
    const source = new EventEmitter();
    const lifecycle = makeLifecycle();
    const sent = [];
    let quitAcknowledgement = null;
    const cleanup = installWindowsSmokeControl(lifecycle, {
      platform: "win32",
      environment: qualifiedEnvironment,
      messageSource: source,
      sendMessage(message, callback) {
        sent.push(message);
        if (message.message === "quit-v1") quitAcknowledgement = callback;
        else callback?.(new Error("ERR_IPC_CHANNEL_CLOSED"));
        return false;
      },
      qualificationContext: context,
    });
    source.emit("message", {
      type: "windows-electron-smoke-v1",
      message: "command-v1",
      command: "quit-v1",
    });
    await nextTick();
    assert.equal(typeof quitAcknowledgement, "function");
    assert.equal(lifecycle.quitCalls, 0);
    assert.equal(source.listenerCount("message"), 1);
    quitAcknowledgement();
    await nextTick();
    assert.equal(lifecycle.quitCalls, 1);
    assert.equal(source.listenerCount("message"), 0);
    assert.equal(source.listenerCount("disconnect"), 0);
    assert.deepEqual(sent, [{
      type: "windows-electron-smoke-v1",
      message: "quit-v1",
      status: "accepted-v1",
    }]);
    cleanup();

    const disconnectedSource = new EventEmitter();
    disconnectedSource.connected = false;
    const disconnectedCleanup = installWindowsSmokeControl(lifecycle, {
      platform: "win32",
      environment: qualifiedEnvironment,
      messageSource: disconnectedSource,
      sendMessage() {
        throw new Error("must not send");
      },
      qualificationContext: context,
    });
    assert.equal(disconnectedSource.listenerCount("message"), 0);
    disconnectedCleanup();

    const missingSenderSource = new EventEmitter();
    const missingSenderCleanup = installWindowsSmokeControl(lifecycle, {
      platform: "win32",
      environment: qualifiedEnvironment,
      messageSource: missingSenderSource,
      qualificationContext: context,
    });
    assert.equal(missingSenderSource.listenerCount("message"), 0);
    missingSenderCleanup();
  });
});

test("Node child-process IPC roundtrip uses the portable ignored-stdio contract", async () => {
  const childSource = [
    "process.on('message', (message) => {",
    "  if (message !== 'ping-v1') return;",
    "  process.send?.('pong-v1', () => process.disconnect?.());",
    "});",
    "process.send?.('ready-v1');",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", childSource], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  const messages = [];
  let sendError = null;
  let exit;
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      resolve();
    });
  });
  const received = new Promise((resolve, reject) => {
    child.on("message", (message) => {
      messages.push(message);
      if (message === "ready-v1") {
        child.send("ping-v1", (error) => {
          sendError = error ?? null;
        });
      }
      if (message === "pong-v1") resolve();
    });
    child.once("error", reject);
  });
  try {
    await withTestTimeout(received, "IPC roundtrip timeout");
    await withTestTimeout(exited, "IPC child exit timeout");
  } finally {
    if (exit === undefined) child.kill();
  }
  assert.equal(sendError, null);
  assert.deepEqual(messages, ["ready-v1", "pong-v1"]);
  assert.deepEqual(exit, { code: 0, signal: null });
});

test("Windows qualification forbids launch-path and supervisor overrides", async () => {
  await withWindowsQualificationFixture(async ({ context }) => {
    assert.doesNotThrow(() => assertElectronQualificationLaunchOptions({
      qualificationContext: context,
    }));
    for (const options of [
      { companionScript: "C:\\forged\\server.js" },
      { resourceRoot: "C:\\forged\\resources" },
      { resourcesPath: "C:\\forged\\resources" },
      { notificationBackend: {} },
      { supervisorOptions: { command: "forged.exe" } },
      { lifecycleOptions: { appName: "Forged" } },
    ]) {
      assert.throws(
        () => assertElectronQualificationLaunchOptions({
          qualificationContext: context,
          ...options,
        }),
        errorCode("windows_qualification_launch_override_forbidden"),
      );
    }
  });
});

test("Windows qualification rejects a runtime/native manifest mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "usagemonitor-electron-qualification-mismatch-"));
  const appPath = join(root, "app");
  const bindingPath = join(appPath, "native/windows-filesystem/build/Release/windows_filesystem.node");
  const bindingManifestPath = `${bindingPath}.manifest.json`;
  const keytarPath = join(appPath, "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node");
  const binding = Buffer.from("binding\n");
  const bindingSha256 = sha256(binding);
  const bindingManifest = Buffer.from(`${JSON.stringify({
    schemaVersion: "windows-filesystem-binding-manifest-v1",
    bindingFile: "windows_filesystem.node",
    platform: "win32",
    architecture: "x64",
    bytes: binding.byteLength,
    sha256: bindingSha256,
    contractVersion: "windows-filesystem-v1",
    securityContractVersion: "windows-filesystem-security-v1",
    bindingProvenance: {
      contractVersion: "windows-binding-provenance-v1",
      status: "unqualified",
      source: "unsigned-development-binding",
    },
  })}\n`);
  const keytar = await readFile(WINDOWS_KEYTAR_PATH);
  const runtimeManifest = {
    schemaVersion: "usage-monitor-electron-runtime-v0.1",
    target: "win32",
    architecture: "x64",
    entrypoint: "apps/electron/main.js",
    dashboardRoot: "apps/web/public",
    files: [
      {
        bytes: binding.byteLength,
        kind: "windows_native_binding",
        path: "native/windows-filesystem/build/Release/windows_filesystem.node",
        sha256: bindingSha256,
      },
      {
        bytes: bindingManifest.byteLength,
        kind: "windows_native_binding",
        path: "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
        sha256: sha256(bindingManifest),
      },
      {
        bytes: keytar.byteLength,
        kind: "third_party_dependency",
        path: "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
        sha256: sha256(keytar),
      },
    ],
    windowsBinding: {
      binding: {
        bytes: binding.byteLength,
        path: "native/windows-filesystem/build/Release/windows_filesystem.node",
        sha256: "0".repeat(64),
      },
      included: true,
      manifest: {
        path: "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
      },
      status: "included_unverified",
      verified: false,
    },
  };
  await mkdir(join(appPath, "native/windows-filesystem/build/Release"), { recursive: true });
  await mkdir(join(appPath, "node_modules/@github/keytar/prebuilds/win32-x64"), {
    recursive: true,
  });
  await writeFile(bindingPath, binding);
  await writeFile(bindingManifestPath, bindingManifest);
  await writeFile(keytarPath, keytar);
  await writeFile(join(appPath, "electron-runtime-manifest.json"), JSON.stringify(runtimeManifest));
  try {
    await assert.rejects(
      createWindowsElectronQualificationContext({
        app: {
          isPackaged: true,
          getAppPath: () => appPath,
          getName: () => "Rhetrion Dev",
        },
        environment: {
          USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
          USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
        },
        platform: "win32",
        architecture: "x64",
      }),
      /Windows Electron qualification is unavailable/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows qualification cannot inject a package reader authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "usagemonitor-electron-reader-seam-"));
  try {
    await assert.rejects(
      createWindowsElectronQualificationContext({
        app: {
          isPackaged: true,
          getAppPath: () => root,
          getName: () => "Rhetrion Dev",
        },
        environment: {
          USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: "windows-electron-v1",
          USAGE_MONITOR_TEST_LANE: "windows-electron-smoke",
        },
        platform: "win32",
        architecture: "x64",
        readFileImpl: async () => Buffer.from("caller-controlled bytes"),
      }),
      (error) => error?.code
        === "WINDOWS_ELECTRON_QUALIFICATION_RESOURCE_AUTHORITY_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows qualification rejects a payload inventory byte mismatch", async () => {
  await withWindowsQualificationFixture(async ({ appPath, environment }) => {
    await writeFile(
      join(appPath, "apps/electron/main.js"),
      Buffer.from("tampered Electron entrypoint\n"),
    );
    await assert.rejects(
      createWindowsElectronQualificationContext({
        app: {
          isPackaged: true,
          getAppPath: () => appPath,
          getName: () => "Rhetrion Dev",
        },
        environment,
        platform: "win32",
        architecture: "x64",
      }),
      (error) => error?.code
        === "WINDOWS_ELECTRON_QUALIFICATION_RUNTIME_INVENTORY_MISMATCH",
    );
  });
});

test("qualification credential commands use a deterministic disposable tuple and confirm deletion", async () => {
  await withWindowsQualificationFixture(async ({ context }) => {
    const values = new Map();
    const binding = {
      async setPassword(service, account, secret) {
        values.set(`${service}\0${account}`, secret);
      },
      async getPassword(service, account) {
        return values.get(`${service}\0${account}`) ?? null;
      },
      async deletePassword(service, account) {
        return values.delete(`${service}\0${account}`);
      },
    };
    const runId = "550e8400-e29b-41d4-a716-446655440000";
    assert.deepEqual(
      await runWindowsElectronQualificationCredentialCommandForTest({
        context,
        command: "create-v1",
        runId,
        binding,
      }),
      { status: "passed", command: "create-v1", cleanup: "pending" },
    );
    assert.deepEqual(
      await runWindowsElectronQualificationCredentialCommandForTest({
        context,
        command: "read-v1",
        runId,
        binding,
      }),
      { status: "passed", command: "read-v1", cleanup: "pending" },
    );
    assert.deepEqual(
      await runWindowsElectronQualificationCredentialCommandForTest({
        context,
        command: "delete-v1",
        runId,
        binding,
      }),
      { status: "passed", command: "delete-v1", cleanup: "confirmed" },
    );
    assert.equal(values.size, 0);
  });
});

test("desktop lifecycle composes secure window, tray, single instance, retry, and quit", async () => {
  const app = new FakeApp();
  const windows = [];
  const trays = [];
  const supervisor = {
    starts: 0,
    stops: 0,
    exitHandler: null,
    setUnexpectedExitHandler(handler) {
      this.exitHandler = handler;
    },
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${4000 + this.starts}` };
    },
    async stop() {
      this.stops += 1;
    },
  };
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    Tray: class extends FakeTray {
      constructor(icon) {
        super(icon);
        trays.push(this);
      }
    },
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });
  const started = await lifecycle.start();
  assert.deepEqual(started, { status: "ready", origin: "http://127.0.0.1:4001" });
  assert.equal(app.lockCalls, 1);
  assert.equal(app.readyCalls, 1);
  assert.equal(windows.length, 2);
  const dashboard = () => windows.find((candidate) => (
    candidate.options.webPreferences.preload === "/private/preload.cjs"
  ));
  const firstDashboard = dashboard();
  assert.equal(firstDashboard.options.minWidth, 960);
  assert.equal(trays.length, 1);
  assert.equal(trays[0].menu.template.some((item) => item.label === "Retry"), false);
  assert.equal(firstDashboard.options.webPreferences.nodeIntegration, false);
  assert.equal(firstDashboard.options.webPreferences.contextIsolation, true);
  assert.equal(firstDashboard.options.webPreferences.sandbox, true);
  assert.equal(firstDashboard.options.webPreferences.preload, "/private/preload.cjs");
  assert.deepEqual(firstDashboard.loaded, ["http://127.0.0.1:4001/"]);
  firstDashboard.emit("ready-to-show");
  assert.equal(firstDashboard.visible, true);
  assert.equal(lifecycle.state.windowVisible, true);
  trays[0].menu.template.find((item) => item.label === "Allowance").click();
  assert.deepEqual(firstDashboard.webContents.sent.at(-1), {
    channel: "usagemonitor:desktop-command:v1",
    command: { command: "dashboardSection", section: "allowance" },
  });
  trays[0].menu.template.find((item) => item.label === "Usage & costs").click();
  assert.deepEqual(firstDashboard.webContents.sent.at(-1), {
    channel: "usagemonitor:desktop-command:v1",
    command: { command: "dashboardSection", section: "usage" },
  });
  trays[0].menu.template.find((item) => item.label === "Model performance").click();
  assert.deepEqual(firstDashboard.webContents.sent.at(-1), {
    channel: "usagemonitor:desktop-command:v1",
    command: { command: "dashboardSection", section: "performance" },
  });
  trays[0].emit("click");
  assert.equal(lifecycle.state.windowVisible, false);
  trays[0].menu.template.find((item) => item.label === "Open Rhetrion").click();
  assert.equal(lifecycle.state.windowVisible, true);
  trays[0].emit("click");
  assert.equal(lifecycle.state.windowVisible, false);
  trays[0].emit("click");
  assert.equal(lifecycle.state.windowVisible, true);
  firstDashboard.emit("close", { preventDefault() {} });
  assert.equal(firstDashboard.visible, false);
  assert.equal(lifecycle.state.windowVisible, false);
  app.emit("second-instance");
  assert.equal(firstDashboard.visible, true);
  await lifecycle.retry();
  assert.equal(supervisor.starts, 2);
  assert.equal(supervisor.stops, 1);
  assert.equal(windows.length, 4);
  const secondDashboard = dashboardWindowsForTest(windows)[1];
  assert.deepEqual(secondDashboard.loaded, ["http://127.0.0.1:4002/"]);
  assert.equal(lifecycle.showSettingsWindow(), true);
  assert.equal(windows.length, 4, "Settings reuses the dashboard");
  secondDashboard.emit("ready-to-show");
  assert.equal(secondDashboard.visible, true);
  const sentBeforeRetiredSection = secondDashboard.webContents.sent.length;
  assert.equal(lifecycle.navigateDashboardSection("community"), false);
  assert.equal(secondDashboard.webContents.sent.length, sentBeforeRetiredSection);
  assert.equal(lifecycle.navigateDashboardSection("overview"), true);
  assert.equal(secondDashboard.visible, true);
  assert.deepEqual(secondDashboard.webContents.sent.at(-1), {
    channel: "usagemonitor:desktop-command:v1",
    command: { command: "dashboardSection", section: "overview" },
  });
  assert.equal(lifecycle.navigateDashboardSection("https://evil.example"), false);
  await lifecycle.requestQuit();
  assert.equal(supervisor.stops, 2);
  assert.equal(app.quitCalls, 1);
});

test("desktop lifecycle opens only its current validated dashboard origin", async () => {
  const app = new FakeApp();
  const opened = [];
  const supervisor = {
    starts: 0,
    setUnexpectedExitHandler() {},
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${61000 + this.starts}` };
    },
    async stop() {},
  };
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: FakeWindow,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
    openDashboardExternal: async (url) => {
      opened.push(url);
      return true;
    },
  });
  await lifecycle.start();
  assert.equal(await lifecycle.openDashboardInBrowser(), true);
  assert.deepEqual(opened, ["http://127.0.0.1:61001/"]);
  await lifecycle.requestQuit();
});


test("desktop lifecycle leaves macOS app reveal and focus APIs unused on Windows", async () => {
  const app = new FakeApp();
  const windows = [];
  const trays = [];
  const supervisor = {
    setUnexpectedExitHandler() {},
    async start() {
      return { origin: "http://127.0.0.1:4022" };
    },
    async stop() {},
  };
  const lifecycle = createDesktopLifecycle({
    app,
    platform: "win32",
    BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    Tray: class extends FakeTray {
      constructor(icon) {
        super(icon);
        trays.push(this);
      }
    },
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });

  await lifecycle.start();
  const dashboard = dashboardWindowsForTest(windows)[0];
  dashboard.emit("ready-to-show");
  const openItem = trays[0].menu.template.find((item) => item.label === "Open Rhetrion");
  openItem.click();
  assert.equal(app.showCalls, 0);
  assert.deepEqual(app.focusCalls, []);
  assert.equal(dashboard.visible, true);
  await lifecycle.dispose();
});

test("desktop lifecycle installs no download handler and ignores the retired registry option", async () => {
  const app = new FakeApp();
  const windows = [];
  const supervisor = {
    starts: 0,
    setUnexpectedExitHandler() {},
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${4000 + this.starts}` };
    },
    async stop() {},
  };
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: class extends DownloadSessionWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
    ownedDownloadsRegistry: { prepareDownload() { throw new Error("must not be used"); } },
  });
  await lifecycle.start();
  const dashboard = windows.find((candidate) => candidate.loaded[0] === "http://127.0.0.1:4001/");
  dashboard.emit("ready-to-show");
  assert.equal(dashboard.webContents.session.listenerCount("will-download"), 0);
  assert.equal(lifecycle.revealLatestDownload, undefined);
  assert.equal(lifecycle.openLatestDownload, undefined);
  assert.equal(lifecycle.isAuthorizedDesktopDownloadContext, undefined);
  await lifecycle.requestQuit();
});

test("desktop lifecycle cancels pending dashboard loads before queued shutdown or update", async (t) => {
  for (const stage of ["startup", "retry"]) {
    for (const action of ["requestQuit", "dispose", "prepareForUpdate"]) {
      await t.test(`${stage} ${action}`, async () => {
        const app = new FakeApp();
        const windows = [];
        let hang = stage === "startup";
        let finishLoad;
        const supervisor = {
          stops: 0,
          async start() { return { origin: "http://127.0.0.1:4051" }; },
          async stop() { ++this.stops; },
        };
        class PendingWindow extends FakeWindow {
          constructor(options) { super(options); windows.push(this); }
          loadURL(url) {
            this.loaded.push(url);
            if (hang && url === "http://127.0.0.1:4051/") {
              return new Promise((resolve) => { finishLoad = resolve; });
            }
            return Promise.resolve();
          }
        }
        const lifecycle = createDesktopLifecycle({
          app, BrowserWindow: PendingWindow, Tray: FakeTray,
          Menu: { buildFromTemplate: (template) => ({ template }) },
          icon: "empty-icon", preloadPath: "/synthetic/preload.cjs", supervisor,
        });
        let pending = lifecycle.start();
        if (stage === "retry") {
          await pending;
          hang = true;
          pending = lifecycle.retry();
        }
        let pendingSettled = false;
        pending.then(() => { pendingSettled = true; }, () => { pendingSettled = true; });
        await nextTick();
        assert.equal(typeof finishLoad, "function");
        const dashboard = windows.at(-1);
        let teardownSettled = false;
        const teardown = lifecycle[action]();
        teardown.then(() => { teardownSettled = true; });
        await nextTick();
        assert.equal(pendingSettled, true, "load must settle without Chromium completing navigation");
        assert.equal(teardownSettled, true, "teardown must enter the queue after cancellation");
        await teardown;
        assert.ok(supervisor.stops > 0);
        finishLoad();
        dashboard.emit("ready-to-show");
        await nextTick();
        assert.equal(lifecycle.state.dashboardReady, false);
        assert.equal(lifecycle.state.started, false);
        assert.equal(dashboard.visible, false);
        if (action === "requestQuit") assert.ok(app.quitCalls > 0);
        if (action !== "dispose") await lifecycle.dispose();
      });
    }
  }
});

test("desktop lifecycle keeps a visible recovery window after a startup exit", async () => {
  const app = new FakeApp();
  const windows = [];
  const supervisor = {
    stops: 0,
    exitHandler: null,
    setUnexpectedExitHandler(handler) {
      this.exitHandler = handler;
    },
    async start() {
      return { origin: "http://127.0.0.1:4051" };
    },
    async stop() {
      this.stops += 1;
    },
  };
  class StartupRaceWindow extends FakeWindow {
    constructor(options) {
      super(options);
      windows.push(this);
    }

    loadURL(url) {
      this.loaded.push(url);
      // Exercise the real race: the ready-to-show event makes the window
      // visible, then the child exits before lifecycle.start() publishes
      // started=true.
      this.emit("ready-to-show");
      supervisor.exitHandler?.({ kind: "companion_exit" });
      return Promise.resolve();
    }
  }
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: StartupRaceWindow,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });

  const started = await lifecycle.start();
  assert.deepEqual(started, {
    status: "recovery",
    origin: null,
    failure: "companion_exit_before_ready",
  });
  assert.equal(windows.length, 2);
  assert.equal(windows[0].visible, true);
  assert.equal(windows[0].destroyed, false);
  assert.equal(windows[1].destroyed, true);
  assert.equal(lifecycle.state.started, false);
  assert.equal(lifecycle.state.hasWindow, false);
  assert.equal(supervisor.stops, 1);
  assert.equal(lifecycle.state.recoveryWindowVisible, true);
  assert.equal(app.quitCalls, 0);
});

test("desktop lifecycle settles a never-ending startup load after an exit and keeps recovery controls responsive", async () => {
  const app = new FakeApp();
  const windows = [];
  const supervisor = {
    starts: 0,
    stops: 0,
    exitHandler: null,
    setUnexpectedExitHandler(handler) {
      this.exitHandler = handler;
    },
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${4050 + this.starts}` };
    },
    async stop() {
      this.stops += 1;
    },
  };
  let hangFirstDashboardLoad = true;
  class StartupHangingWindow extends FakeWindow {
    constructor(options) {
      super(options);
      windows.push(this);
    }

    loadURL(url) {
      this.loaded.push(url);
      if (url.endsWith("/") && hangFirstDashboardLoad) {
        hangFirstDashboardLoad = false;
        this.emit("ready-to-show");
        supervisor.exitHandler?.({ kind: "companion_exit" });
        return new Promise(() => {});
      }
      this.emit("ready-to-show");
      return Promise.resolve();
    }
  }
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: StartupHangingWindow,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });

  const initial = await withTestTimeout(
    lifecycle.start(),
    "startup remained pending after an unexpected companion exit",
  );
  assert.deepEqual(initial, {
    status: "recovery",
    origin: null,
    failure: "companion_exit_before_ready",
  });
  const failedDashboard = dashboardWindowsForTest(windows)[0];
  assert.equal(failedDashboard.destroyed, true);
  assert.equal(lifecycle.state.hasWindow, false);
  assert.equal(lifecycle.state.recoveryWindowVisible, true);
  assert.equal(
    windows.filter((candidate) => candidate.options.show === true).length,
    1,
    "startup exit must not create duplicate recovery windows",
  );

  const retried = await withTestTimeout(
    lifecycle.retry(),
    "Retry remained pending after a settled startup exit",
  );
  assert.deepEqual(retried, {
    status: "ready",
    origin: "http://127.0.0.1:4052",
  });
  await withTestTimeout(
    lifecycle.requestQuit(),
    "Quit remained pending after a settled startup exit",
  );
  assert.equal(app.quitCalls, 1);
  assert.equal(supervisor.stops, 3);
});

test("dashboard load failure keeps startup in fixed recovery and a later Retry can succeed", async () => {
  const app = new FakeApp();
  const windows = [];
  const supervisor = {
    starts: 0,
    setUnexpectedExitHandler() {},
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${4060 + this.starts}` };
    },
    async stop() {},
  };
  let rejectDashboard = true;
  const dashboardFailures = [];
  class LoadFailWindow extends FakeWindow {
    constructor(options) {
      super(options);
      windows.push(this);
    }

    loadURL(url) {
      this.loaded.push(url);
      if (url.endsWith("/") && rejectDashboard) {
        rejectDashboard = false;
        throw Object.assign(new Error("private renderer load detail"), {
          errno: -2,
        });
      }
      return Promise.resolve();
    }
  }
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: LoadFailWindow,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
    onDashboardLoadFailure(value) {
      dashboardFailures.push(value);
    },
  });

  const initial = await lifecycle.start();
  assert.deepEqual(initial, {
    status: "recovery",
    origin: null,
    failure: "companion_spawn_failed",
  });
  assert.equal(lifecycle.state.started, false);
  assert.equal(lifecycle.state.hasWindow, false);
  assert.equal(lifecycle.state.recoveryWindowVisible, true);
  assert.deepEqual(dashboardFailures, [{ stage: "load_url", reason: -2 }]);
  assert.equal(Object.isFrozen(dashboardFailures[0]), true);
  assert.equal(windows.filter((candidate) => candidate.options.show === false).at(-1).destroyed, true);
  assert.doesNotMatch(
    decodeURIComponent(windows.find((candidate) => candidate.options.show === true).loaded.at(-1)),
    /private|renderer|load detail/u,
  );

  const retried = await lifecycle.retry();
  assert.deepEqual(retried, {
    status: "ready",
    origin: "http://127.0.0.1:4062",
  });
  assert.equal(lifecycle.state.started, true);
  assert.equal(lifecycle.state.recoveryWindowVisible, false);
  assert.equal(windows.filter((candidate) => candidate.options.show === false).length, 2);
  await lifecycle.dispose();
});

for (const failureEvent of ["did-fail-load", "render-process-gone"]) {
  test(`dashboard ${failureEvent} invalidates the old window and uses one bounded retry`, async () => {
    const app = new FakeApp();
    const windows = [];
    const supervisor = {
      starts: 0,
      setUnexpectedExitHandler() {},
      async start() {
        this.starts += 1;
        return { origin: `http://127.0.0.1:${4070 + this.starts}` };
      },
      async stop() {},
    };
    class RuntimeFailWindow extends FakeWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    }
    let invalidations = 0;
    const dashboardFailures = [];
    const lifecycle = createDesktopLifecycle({
      app,
      BrowserWindow: RuntimeFailWindow,
      Tray: FakeTray,
      Menu: { buildFromTemplate: (template) => ({ template }) },
      icon: "empty-icon",
      preloadPath: "/private/preload.cjs",
      supervisor,
      onDashboardInvalidated: () => {
        invalidations += 1;
      },
      onDashboardLoadFailure(value) {
        dashboardFailures.push(value);
      },
    });

    await lifecycle.start();
    const oldDashboard = dashboardWindowsForTest(windows)[0];
    oldDashboard.emit("ready-to-show");
    assert.equal(lifecycle.state.dashboardReady, true);
    if (failureEvent === "did-fail-load") {
      oldDashboard.webContents.emit(
        failureEvent,
        {},
        -2,
        "private renderer detail",
        "http://127.0.0.1:4071/",
        true,
      );
    } else {
      oldDashboard.webContents.emit(failureEvent, {}, {
        reason: "crashed",
        exitCode: 17,
        privateDetail: "/private/secret",
      });
    }
    assert.equal(oldDashboard.destroyed, true);
    assert.equal(invalidations, 1, "renderer teardown invalidates its refresh session");
    assert.equal(oldDashboard.webContents.listenerCount("did-fail-load"), 0);
    assert.equal(oldDashboard.webContents.listenerCount("render-process-gone"), 0);
    assert.equal(lifecycle.state.started, false);
    assert.equal(lifecycle.state.hasWindow, false);
    assert.equal(lifecycle.state.origin, null);
    assert.equal(lifecycle.state.recoveryWindowVisible, true);
    assert.deepEqual(dashboardFailures, [failureEvent === "did-fail-load"
      ? { stage: "did_fail_load", reason: -2 }
      : { stage: "render_process_gone", reason: "crashed" },
    ]);
    assert.equal(Object.isFrozen(dashboardFailures[0]), true);

    await withTestTimeout((async () => {
      while (supervisor.starts < 2 || !lifecycle.state.started) await nextTick();
    })(), `bounded retry did not recover after ${failureEvent}`);
    assert.equal(lifecycle.state.origin, "http://127.0.0.1:4072");
    await lifecycle.dispose();
  });
}

test("dashboard failure diagnostic retains its first closed failure and ignores callback errors", async () => {
  const app = new FakeApp();
  const windows = [];
  let rejectDashboardLoad;
  const supervisor = {
    setUnexpectedExitHandler() {},
    async start() {
      return { origin: "http://127.0.0.1:4079" };
    },
    async stop() {},
  };
  class DeferredDashboardWindow extends FakeWindow {
    constructor(options) {
      super(options);
      windows.push(this);
    }

    loadURL(url) {
      this.loaded.push(url);
      return new Promise((_resolve, reject) => {
        rejectDashboardLoad = reject;
      });
    }
  }
  const dashboardFailures = [];
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: DeferredDashboardWindow,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
    onDashboardLoadFailure(value) {
      dashboardFailures.push(value);
      throw new Error("synthetic diagnostic failure");
    },
  });

  const starting = lifecycle.start();
  await nextTick();
  const dashboard = dashboardWindowsForTest(windows)[0];
  assert.notEqual(dashboard, undefined);
  dashboard.webContents.emit("render-process-gone", {}, {
    reason: "private renderer reason",
  });
  rejectDashboardLoad(Object.assign(new Error("private renderer load detail"), { errno: -2 }));

  assert.deepEqual(await starting, {
    status: "recovery",
    origin: null,
    failure: "companion_spawn_failed",
  });
  assert.deepEqual(dashboardFailures, [
    { stage: "render_process_gone", reason: "unknown" },
  ]);
  await lifecycle.dispose();
});

test("Settings requests before readiness use the dashboard without constructing another window", async () => {
  const windows = [];
  const lifecycle = createDesktopLifecycle({
    app: new FakeApp(),
    BrowserWindow: class extends FakeWindow {
      constructor(options) { super(options); windows.push(this); }
    },
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon", preloadPath: "/private/preload.cjs",
    supervisor: {
      setUnexpectedExitHandler() {},
      async start() { return { origin: "http://127.0.0.1:4082" }; },
      async stop() {},
    },
  });
  await lifecycle.start();
  const dashboard = dashboardWindowsForTest(windows)[0];
  assert.equal(lifecycle.showSettingsWindow("tray"), true);
  assert.equal(lifecycle.showSettingsWindow("notifications"), true);
  assert.equal(windows.length, 2);
  assert.equal(dashboard.webContents.sent.length, 0);
  dashboard.emit("ready-to-show");
  assert.deepEqual(dashboard.webContents.sent, [{
    channel: "usagemonitor:desktop-command:v1",
    command: { command: "dashboardSection", section: "settings", settingsSection: "notifications" },
  }]);
  dashboard.emit("ready-to-show");
  assert.equal(dashboard.webContents.sent.length, 1);
  assert.equal(lifecycle.state.hasSettingsWindow, false);
  await lifecycle.dispose();
});

test("navigating away before dashboard readiness cancels an earlier Settings request", async () => {
  const windows = [];
  const lifecycle = createDesktopLifecycle({
    app: new FakeApp(),
    BrowserWindow: class extends FakeWindow {
      constructor(options) { super(options); windows.push(this); }
    },
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon", preloadPath: "/private/preload.cjs",
    supervisor: {
      setUnexpectedExitHandler() {},
      async start() { return { origin: "http://127.0.0.1:4082" }; },
      async stop() {},
    },
  });
  await lifecycle.start();
  const dashboard = dashboardWindowsForTest(windows)[0];
  assert.equal(lifecycle.showSettingsWindow("tray"), true);
  assert.equal(lifecycle.navigateDashboardSection("usage"), true);
  assert.equal(windows.length, 2);
  assert.deepEqual(dashboard.webContents.sent.at(-1).command, { command: "dashboardSection", section: "usage" });
  dashboard.emit("ready-to-show");
  assert.deepEqual(dashboard.webContents.sent, [{
    channel: "usagemonitor:desktop-command:v1",
    command: { command: "dashboardSection", section: "usage" },
  }]);
  dashboard.emit("ready-to-show");
  assert.equal(dashboard.webContents.sent.length, 1);
  assert.equal(lifecycle.state.hasSettingsWindow, false);
  await lifecycle.dispose();
});

test("desktop lifecycle invalidates a dead companion, auto-restarts once, then requires tray Retry", async () => {
  const app = new FakeApp();
  const windows = [];
  const trays = [];
  const supervisor = {
    starts: 0,
    stops: 0,
    exitHandler: null,
    setUnexpectedExitHandler(handler) {
      this.exitHandler = handler;
    },
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${4500 + this.starts}` };
    },
    async stop() {
      this.stops += 1;
    },
  };
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: class extends FakeWindow {
      constructor(options) {
        super(options);
        windows.push(this);
      }
    },
    Tray: class extends FakeTray {
      constructor(icon) {
        super(icon);
        trays.push(this);
      }
    },
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });
  await lifecycle.start();
  const firstWindow = dashboardWindowsForTest(windows)[0];
  supervisor.exitHandler({ kind: "companion_exit" });
  assert.equal(firstWindow.destroyed, true);
  assert.equal(lifecycle.state.origin, null);
  // Let the queued bounded automatic restart settle.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.starts, 2);
  assert.equal(supervisor.stops, 1);
  assert.equal(windows.length, 4);

  supervisor.exitHandler({ kind: "companion_exit" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.starts, 2);
  assert.equal(dashboardWindowsForTest(windows)[1].destroyed, true);

  const retryItem = trays[0].menu.template.find((item) => item.label === "Retry");
  const manualRetry = retryItem.click();
  await manualRetry;
  assert.equal(supervisor.starts, 3);
});

test("Settings routes menu and tray entries to the dashboard and requires its exact live root frame", async () => {
  const app = new FakeApp();
  const windows = [], trays = [], menus = [];
  const supervisor = {
    starts: 0,
    setUnexpectedExitHandler(handler) { this.exitHandler = handler; },
    async start() { this.starts += 1; return { origin: `http://127.0.0.1:${4700 + this.starts}` }; },
    async stop() {},
  };
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: class extends FakeWindow {
      constructor(options) { super(options); windows.push(this); }
    },
    Tray: class extends FakeTray {
      constructor(icon) { super(icon); trays.push(this); }
    },
    Menu: {
      buildFromTemplate: (template) => ({ template }),
      setApplicationMenu(menu) { menus.push(menu); },
    },
    platform: "win32", desktopLocale: "en", icon: "empty-icon", preloadPath: "/private/preload.cjs", supervisor,
  });
  await lifecycle.start();
  const dashboard = dashboardWindowsForTest(windows)[0];
  dashboard.emit("ready-to-show");
  const expectSection = (section) => assert.deepEqual(dashboard.webContents.sent.at(-1), {
    channel: "usagemonitor:desktop-command:v1",
    command: { command: "dashboardSection", section: "settings", settingsSection: section },
  });
  for (const section of ["general", "tray", "notifications", "data", "about"]) {
    assert.equal(lifecycle.showSettingsWindow(section), true);
    expectSection(section);
    assert.equal(windows.length, 2);
    assert.equal(dashboard.visible, true);
  }
  assert.throws(() => lifecycle.showSettingsWindow("unsupported"), /settings section is invalid/u);
  assert.equal(lifecycle.state.hasSettingsWindow, false);
  assert.equal(lifecycle.state.settingsWindowVisible, false);
  for (const menu of [menus[0].template.flatMap((item) => item.submenu ?? []), trays[0].menu.template]) {
    menu.find((item) => item.label === "Settings…").click();
    expectSection("general");
    menu.find((item) => item.label === "About Rhetrion").click();
    expectSection("about");
  }
  assert.equal(lifecycle.navigateDashboardSection("usage"), true);
  assert.equal(lifecycle.navigateDashboardSection("#usage"), false);
  assert.deepEqual(dashboard.webContents.sent.at(-1).command, { command: "dashboardSection", section: "usage" });
  assert.equal(lifecycle.setDesktopLanguage("zh-Hans"), true);
  assert.ok(menus.at(-1).template.flatMap((item) => item.submenu ?? []).some((item) => item.label === "\u5173\u4e8e Rhetrion"));
  assert.ok(trays[0].menu.template.some((item) => item.label === "\u6253\u5f00 Rhetrion"));
  assert.equal(lifecycle.setDesktopLanguage("es"), true);
  assert.ok(menus.at(-1).template.flatMap((item) => item.submenu ?? []).some((item) => item.label === "Acerca de Rhetrion"));
  assert.equal(lifecycle.refreshSettings(), true);
  assert.deepEqual(dashboard.webContents.sent.at(-1).command, { command: "settingsChanged" });
  const contents = dashboard.webContents, frame = contents.mainFrame, event = { sender: contents };
  assert.equal(lifecycle.isAuthorizedDesktopSender(contents), true);
  assert.equal(lifecycle.isAuthorizedDashboardSender(contents), true);
  for (const hash of ["#overview", "#settings/notifications"]) {
    contents.getURL = () => `http://127.0.0.1:4701/${hash}`;
    assert.equal(lifecycle.isAuthorizedSettingsFrame(frame, event), true, "hash is not an authorization boundary");
  }
  for (const url of ["https://example.test/", "http://127.0.0.1:4702/", "http://localhost:4701/",
    "http://127.0.0.1:4701/electron-settings.html", "http://127.0.0.1:4701/app.js",
    "http://127.0.0.1:4701/?settings", "http://user:pass@127.0.0.1:4701/"]) {
    contents.getURL = () => url;
    assert.equal(lifecycle.isAuthorizedSettingsFrame(frame, event), false, url);
    assert.equal(lifecycle.isAuthorizedDesktopFrame(frame, event), false, url);
  }
  contents.getURL = () => "http://127.0.0.1:4701/";
  assert.equal(lifecycle.isAuthorizedSettingsFrame({ isMainFrame: false, parent: frame }, event), false);
  assert.equal(lifecycle.isAuthorizedSettingsFrame({ isMainFrame: true, parent: null }, event), false);
  assert.equal(lifecycle.isAuthorizedSettingsFrame(frame, { sender: {} }), false);
  assert.equal(lifecycle.isAuthorizedSettingsFrame(frame), false);
  supervisor.exitHandler({ kind: "companion_exit" });
  assert.equal(dashboard.destroyed, true);
  assert.equal(lifecycle.isAuthorizedSettingsFrame(frame, event), false);
  assert.equal(lifecycle.isAuthorizedDesktopSender(contents), false);
  await nextTick();
  const replacement = dashboardWindowsForTest(windows)[1];
  replacement.emit("ready-to-show");
  assert.equal(lifecycle.showSettingsWindow("data"), true);
  assert.equal(windows.length, 4);
  assert.deepEqual(replacement.webContents.sent.at(-1).command, {
    command: "dashboardSection", section: "settings", settingsSection: "data",
  });
  assert.equal(lifecycle.isAuthorizedSettingsFrame(frame, event), false);
  await lifecycle.requestQuit();
  assert.equal(replacement.destroyed, true);
  assert.equal(app.quitCalls, 1);
});

test("Settings navigation retains shared-session loopback filtering", async () => {
  const windows = [];
  const sharedSession = {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    webRequest: { onBeforeRequest(filter, listener) { this.listener = listener; } },
  };
  const lifecycle = createDesktopLifecycle({
    app: new FakeApp(),
    BrowserWindow: class extends FakeWindow {
      constructor(options) { super(options); this.webContents.session = sharedSession; windows.push(this); }
    },
    Tray: FakeTray, Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon", preloadPath: "/private/preload.cjs",
    supervisor: {
      setUnexpectedExitHandler() {},
      async start() { return { origin: "http://127.0.0.1:4751" }; },
      async stop() {},
    },
  });
  await lifecycle.start();
  dashboardWindowsForTest(windows)[0].emit("ready-to-show");
  assert.equal(lifecycle.showSettingsWindow(), true);
  assert.equal(lifecycle.navigateDashboardSection("overview"), true);
  assert.equal(windows.length, 2);
  for (const [url, cancel] of [["https://example.test/", true], ["http://127.0.0.1:4751/api/local/health", false]]) {
    const decisions = [];
    sharedSession.webRequest.listener({ url }, (value) => decisions.push(value));
    assert.deepEqual(decisions, [{ cancel }]);
  }
  await lifecycle.dispose();
  assert.equal(sharedSession.webRequest.listener, null);
});

test("desktop lifecycle cancels an in-flight retry before quit and serializes shutdown", async () => {
  const app = new FakeApp();
  let resolveStop;
  let stopCalls = 0;
  const supervisor = {
    starts: 0,
    setUnexpectedExitHandler() {},
    async start() {
      this.starts += 1;
      return { origin: `http://127.0.0.1:${4600 + this.starts}` };
    },
    stop() {
      stopCalls += 1;
      if (stopCalls === 2) return Promise.resolve();
      return new Promise((resolve) => { resolveStop = resolve; });
    },
  };
  const lifecycle = createDesktopLifecycle({
    app,
    BrowserWindow: FakeWindow,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "empty-icon",
    preloadPath: "/private/preload.cjs",
    supervisor,
  });
  await lifecycle.start();
  const retry = lifecycle.retry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopCalls, 1);
  const quit = lifecycle.requestQuit();
  resolveStop();
  await assert.rejects(retry, errorCode("companion_busy"));
  await quit;
  assert.equal(stopCalls, 2);
  assert.equal(app.quitCalls, 1);
});

test("desktop quit waits for session persistence before destroying the window or quitting", async () => {
  const app = new FakeApp(); let finish; let drains = 0;
  const drained = new Promise(resolve => { finish = resolve; });
  const supervisor = { setUnexpectedExitHandler() {}, async start() { return { origin: 'http://127.0.0.1:4600' }; }, async stop() {} };
  const lifecycle = createDesktopLifecycle({ app, BrowserWindow: FakeWindow, Tray: FakeTray,
    Menu: { buildFromTemplate: template => ({ template }) }, icon: 'empty-icon', preloadPath: '/synthetic/preload.cjs', supervisor,
    beforeQuit: async () => { drains++; await drained; } });
  await lifecycle.start();
  const quitting = lifecycle.requestQuit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drains, 1); assert.equal(app.quitCalls, 0);
  finish(); await quitting; assert.equal(app.quitCalls, 1);
  await lifecycle.requestQuit(); assert.equal(drains, 1);
});

test("Electron entry quits explicitly when composition fails before lifecycle ownership", async () => {
  const app = new FakeApp();
  const events = [];
  const alerts = [];
  app.quit = () => {
    events.push("quit");
    app.quitCalls += 1;
  };
  const diagnostics = [];
  let recordedFailure = null;
  await assert.rejects(
    launchElectronShell({
      electron: {
        app,
        dialog: {
          showErrorBox(title, message) {
            events.push("alert");
            alerts.push({ title, message });
          },
        },
      },
      emitFailureDiagnostic: true,
      writeDiagnostic: (value) => {
        events.push("diagnostic");
        diagnostics.push(value);
      },
      startupDiagnostics: {
        mark() {},
        async fail(error) {
          events.push("startup-failure");
          recordedFailure = error;
        },
      },
    }),
    electronEntryCompositionFailure,
  );
  assert.equal(electronEntryCompositionFailure(recordedFailure), true);
  assert.deepEqual(diagnostics, [`${ELECTRON_ENTRY_FAILURE_DIAGNOSTIC}\n`]);
  assert.deepEqual(alerts, [{
    title: "Rhetrion could not start",
    message: `Rhetrion stopped before opening the dashboard.\n\nSupport code: ${ELECTRON_ENTRY_FAILURE_DIAGNOSTIC}\n\nPlease report this code with the app and operating system versions. Preserve your local data.`,
  }]);
  assert.deepEqual(events, ["startup-failure", "diagnostic", "alert", "quit"]);
  assert.equal(app.quitCalls, 1);
});

test("Electron entry ignores an unavailable startup journal", async () => {
  const app = new FakeApp();
  await assert.rejects(
    launchElectronShell({
      electron: { app, dialog: { showErrorBox() {} } },
      emitFailureDiagnostic: true,
      writeDiagnostic() {},
      startupDiagnostics: {
        mark() { throw new Error("synthetic journal failure"); },
        async start() { throw new Error("synthetic journal failure"); },
        async fail() { throw new Error("synthetic journal failure"); },
      },
    }),
    electronEntryCompositionFailure,
  );
  assert.equal(app.quitCalls, 1);
});

test("Electron entry still quits when its fixed diagnostic and native alert fail", async () => {
  const app = new FakeApp();
  let alertCalls = 0;
  await assert.rejects(
    launchElectronShell({
      electron: {
        app,
        dialog: {
          showErrorBox() {
            alertCalls += 1;
            throw new Error("synthetic native dialog failure");
          },
        },
      },
      emitFailureDiagnostic: true,
      writeDiagnostic() {
        throw new Error("synthetic diagnostic failure");
      },
    }),
    electronEntryCompositionFailure,
  );
  assert.equal(alertCalls, 1);
  assert.equal(app.quitCalls, 1);
});


test("dependency-injected composition leaves physical Electron profile paths untouched", async (t) => {
  const stableDistribution = createProductionDistributionMetadata({
    target: "win32-x64",
    sourceRevision: "e".repeat(40),
    buildNumber: "20260908",
  });
  for (const [name, appName, manifest] of [
    ["stable", "Rhetrion", { usageMonitorIdentity: applicationIdentity.applicationMetadata("stable"), usageMonitorDistribution: stableDistribution }],
    ["Dev", "Rhetrion Dev", { usageMonitorIdentity: applicationIdentity.applicationMetadata("development") }],
  ]) {
    const root = await mkdtemp(join(tmpdir(), "usagemonitor-ordinary-shell-"));
    const appPath = join(root, "Rhetrion.app", "Contents", "Resources", "app.asar");
    const appData = join(root, "app-data");
    const userData = join(appData, "Rhetrion");
    await Promise.all([
      mkdir(appPath, { recursive: true }),
      mkdir(userData, { recursive: true }),
    ]);
    await writeFile(join(appPath, "package.json"), `${JSON.stringify({
      name: "app-usagemonitor",
      main: "apps/electron/main.js",
      version: "0.1.19",
      ...manifest,
    })}\n`, "utf8");
    t.after(() => rm(root, { recursive: true, force: true }));

    const paths = new Map([["appData", appData], ["sessionData", userData], ["userData", userData]]);
    const setPathCalls = [];
    const app = new RuntimeApp();
    app.isPackaged = true;
    app.getAppPath = () => appPath;
    app.getName = () => appName;
    app.getVersion = () => "0.1.19";
    app.getPath = (key) => paths.get(key) ?? join(root, key);
    app.setPath = (key, value) => {
      setPathCalls.push([key, value]);
      paths.set(key, value);
    };
    app.whenReady = async () => { throw new Error(`${name} readiness sentinel`); };

    await assert.rejects(launchElectronShell({
      electron: { app, BrowserWindow: class {}, dialog: { showErrorBox() {}, async showOpenDialog() { return { canceled: true, filePaths: [] }; } } },
      environment: {},
      platform: "win32",
      architecture: "x64",
      resourcesPath: join(root, "Rhetrion.app", "Contents", "Resources"),
    }), name === "stable" ? new RegExp(`${name} readiness sentinel`, "u") : errorCode("windows_readiness_unavailable"));
    assert.deepEqual(setPathCalls, [], name);
    assert.equal(paths.get("userData"), userData, name);
    assert.equal(paths.get("sessionData"), userData, name);
  }
});

test("packaged Electron composition keeps the companion in app.asar and uses physical Resources as cwd", async () => {
  if (process.platform === "win32") {
    // The dependency-injected supervisor below is intentionally forbidden for
    // a Windows launch. Keep this unit active on Windows by proving that an
    // unqualified packaged composition fails closed before it can spawn a
    // companion; the native smoke supplies the real qualification context.
    const app = new FakeApp();
    app.isPackaged = true;
    await assert.rejects(
      launchElectronShell({ electron: { app } }),
      errorCode("electron_configuration_invalid"),
    );
    assert.equal(app.quitCalls, 1);
    return;
  }
  const app = new FakeApp();
  app.isPackaged = true;
  app.getAppPath = () => "/private/Rhetrion.app/Contents/Resources/app.asar";
  app.getPath = (name) => {
    assert.equal(name, "userData");
    return "/private/Rhetrion-user-data";
  };
  const child = new FakeChild();
  const spawnCalls = [];
  let resolveCompanionSpawn;
  const companionSpawned = new Promise((resolve) => {
    resolveCompanionSpawn = resolve;
  });
  const launch = launchElectronShell({
    electron: {
      app,
      dialog: {
        showMessageBox: async () => ({ response: 0 }),
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      },
      BrowserWindow: FakeWindow,
      Tray: FakeTray,
      Menu: { buildFromTemplate: (template) => ({ template }) },
      nativeImage: {
        createFromPath: () => ({
          isEmpty: () => false,
          resize: () => ({
            isEmpty: () => false,
            setTemplateImage() {},
          }),
        }),
      },
    },
    resourcesPath: "/private/Rhetrion.app/Contents/Resources",
    environment: {
      USAGE_MONITOR_CENTRAL_ORIGIN: "http://127.0.0.1:8792",
    },
    firstRunReceiptBackend: {
      load: async () => ({
        schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
        acknowledged: true,
      }),
      save: async () => {},
    },
    notificationBackend: {
      load: async () => null,
      save: async (value) => value,
    },
    supervisorOptions: {
      spawnChild(command, args, options) {
        spawnCalls.push({ command, args, options });
        resolveCompanionSpawn();
        return child;
      },
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 1_000,
    },
  });
  // Settings initialization performs real filesystem I/O; one event-loop turn
  // does not prove that composition has reached the injected spawn boundary.
  await withTestTimeout(
    Promise.race([companionSpawned, launch]),
    "packaged_companion_spawn_timeout",
  );
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, [
    "/private/Rhetrion.app/Contents/Resources/app.asar/apps/local/server.js",
  ]);
  assert.equal(
    spawnCalls[0].options.env.CODEX_HOME,
    "/Users/synthetic-user/.codex",
    "the direct companion entrypoint receives its analyzed root through CODEX_HOME",
  );
  assert.equal(
    spawnCalls[0].options.cwd,
    "/private/Rhetrion.app/Contents/Resources",
  );
  assert.equal(
    spawnCalls[0].options.env.USAGE_MONITOR_RESOURCE_ROOT,
    "/private/Rhetrion.app/Contents/Resources/app.asar",
  );
  assert.equal(
    spawnCalls[0].options.env.USAGE_MONITOR_STATE_ROOT,
    "/private/Rhetrion-user-data/companion-state",
  );
  assert.equal(
    spawnCalls[0].options.env.USAGE_MONITOR_CENTRAL_ORIGIN,
    undefined,
    "the desktop runtime must not expose the retired central transport",
  );
  child.stdout.emit("data", Buffer.from("USAGE_MONITOR_READY http://127.0.0.1:4711/\n"));
  const lifecycle = await launch;
  const dispose = lifecycle.dispose();
  child.emit("exit", 0, null);
  await dispose;
});

test("retired sharing, community, download and hosted sign-in actions are outside the IPC vocabulary", async () => {
  const fixture = await launchDashboardRuntimeFixture();
  fixture.dashboard.emit("ready-to-show");
  assert.equal(fixture.desktop.lifecycle.state.windowVisible, true);
  assert.equal(fixture.spawnCalls[0].options.env.USAGE_MONITOR_CENTRAL_ORIGIN, undefined);
  const event = {
    sender: fixture.dashboard.webContents,
    senderFrame: fixture.dashboard.webContents.mainFrame,
  };
  const commandsBefore = (fixture.dashboard.webContents.sent ?? []).length;
  for (const request of [
    { action: "getSharingPreference", args: {} },
    { action: "setSharingEnabled", args: { enabled: true } },
    { action: "sharingNoticePresented", args: { index: 1 } },
    { action: "openCommunity", args: {} },
    { action: "revealLatestDownload", args: {} },
    { action: "openLatestDownload", args: {} },
    {
      action: "openHostedSignIn",
      args: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test" },
    },
  ]) {
    await assert.rejects(
      fixture.ipcMain.handler(event, request),
      (error) => error?.code === "desktop_ipc_invalid_request",
      `${request.action} must be refused`,
    );
  }
  assert.equal((fixture.dashboard.webContents.sent ?? []).length, commandsBefore);
  await fixture.desktop.lifecycle.dispose();
});

test("preload exposes only the exact frozen v1 desktop bridge allowlist", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "apps/electron/preload.cjs"), "utf8");
  assert.doesNotMatch(source, /\bpath\b/u);
  assert.doesNotMatch(source, /new\s+URL/u);
  assert.doesNotMatch(source, /(?:readFile|writeFile|send\s*\()/u);
  const calls = [];
  const commandListeners = new Map();
  const exposed = {};
  const contextBridge = {
    exposeInMainWorld(name, bridge) {
      exposed[name] = bridge;
    },
  };
  const ipcRenderer = {
    invoke(channel, request) {
      calls.push({ channel, request });
      return Promise.resolve(request);
    },
    on(channel, listener) {
      commandListeners.set(channel, listener);
    },
    removeListener(channel, listener) {
      if (commandListeners.get(channel) === listener) commandListeners.delete(channel);
    },
  };
  const context = {
    Promise,
    contextBridge,
    ipcRenderer,
    require(specifier) {
      assert.equal(specifier, "electron");
      return { contextBridge, ipcRenderer };
    },
  };
  vm.runInNewContext(source, context, { filename: "preload.cjs" });
  assert.deepEqual(JSON.parse(JSON.stringify(context.__USAGE_MONITOR_PRELOAD_MARKER__)), {
    name: "usagemonitor-electron-preload",
    version: "v1",
    capabilities: { filesystem: false, ipc: true },
  });
  assert.equal(Object.isFrozen(context.__USAGE_MONITOR_PRELOAD_MARKER__), true);
  assert.equal(Object.isFrozen(context.__USAGE_MONITOR_PRELOAD_MARKER__.capabilities), true);
  assert.deepEqual(Object.keys(exposed), ["usageMonitorDesktop"]);
  const bridge = exposed.usageMonitorDesktop;
  assert.equal(Object.isFrozen(bridge), true);
  assert.deepEqual(Object.keys(bridge), [
    "version",
    "onCommand",
    "getSettings",
    "getApplicationMenu",
    "openApplicationMenu",
    "getWindowBackground",
    "chooseWindowBackground",
    "restoreWindowBackground",
    "setWindowBackground",
    "getCodexHomesForSettings",
    "openSettings",
    "openTraySettings",
    "restoreTrayDefaults",
    "setTrayPreferences",
    "toggleSidebar",
    "chooseCodexHome",
    "addCodexHome",
    "editCodexHome",
    "removeCodexHome",
    "setPrimaryCodexHome",
    "reorderCodexHomes",
    "useDefaultCodexHome",
    "setLanguage",
    "setAppearance",
    "setRefreshInterval",
    "setRefreshPaused",
    "setStartAtLogin",
    "sendTestNotification",
    "setNotificationPreferences",
    "openSystemSettings",
    "openExternal",
    "checkForUpdates",
    "downloadUpdate",
    "installUpdateAndRestart",
    "setAutomaticDownload",
    "openDashboardInBrowser",
    "showDiagnostics",
    "revealLocalData",
    "getXStatus", "refreshX", "getXSettings", "cancelXLogin", "configureXImport", "logoutX", "clearXCache",
    "listXPosts", "getXPost", "beginXLogin", "setXSettings",
    "getRefreshStatus",
    "refreshStarted",
    "refreshHeartbeat",
    "refreshSettled",
  ]);
  assert.equal(bridge.version, "v1");
  await bridge.getApplicationMenu();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.pop())).request, { action: "getApplicationMenu", args: {} });
  await bridge.openApplicationMenu({ menu: "file", x: 12, y: 40 });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.pop())).request, { action: "openApplicationMenu", args: { menu: "file", x: 12, y: 40 } });
  for (const args of [{ menu: "quit", x: 0, y: 40 }, { menu: "file", x: -1, y: 40 },
    { menu: "file", x: 0, y: NaN }, { menu: "file", x: 0, y: 40, command: "quit" }]) {
    await assert.rejects(bridge.openApplicationMenu(args));
  }
  await assert.rejects(bridge.getApplicationMenu("file"));
  await assert.rejects(bridge.openApplicationMenu());
  await assert.rejects(bridge.openApplicationMenu({ menu: "file", x: 0, y: 40 }, {}));
  await assert.rejects(bridge.sendTestNotification({ body: "arbitrary" }));
  await bridge.sendTestNotification();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.pop())), {
    channel: "usagemonitor:desktop:v1", request: { action: "sendTestNotification", args: {} },
  });
  const commands = [];
  const unsubscribe = bridge.onCommand((command) => commands.push(command));
  assert.equal(typeof unsubscribe, "function");
  const commandListener = commandListeners.get("usagemonitor:desktop-command:v1");
  assert.equal(typeof commandListener, "function");
  commandListener({}, { command: "refresh" });
  commandListener({}, { command: "automaticRefresh", mode: "quick" });
  commandListener({}, { command: "automaticRefresh", mode: "detailed" });
  for (const section of ["overview", "usage", "allowance", "performance", "settings"]) {
    commandListener({}, { command: "dashboardSection", section });
  }
  for (const section of ["weekly", "timeline", "accounting", "projects", "community", "#usage", "usage/", "Usage", ""]) {
    commandListener({}, { command: "dashboardSection", section });
  }
  commandListener({}, { command: "dashboardSection", section: "settings", settingsSection: "notifications" });
  commandListener({}, { command: "settingsChanged" });
  commandListener({}, { command: "dashboardSection", section: "settings", settingsSection: "unknown" });
  commandListener({}, { command: "dashboardSection", section: "usage", settingsSection: "general" });
  commandListener({}, { command: "settingsChanged", extra: true });
  commandListener({}, { command: "dashboardSection", section: "usage", search: "unexpected" });
  commandListener({}, { command: "language", value: "es" });
  commandListener({}, { command: "sidebar", collapsed: true });
  commandListener({}, { command: "windowFullscreen", fullscreen: true });
  commandListener({}, { command: "windowFullscreen", fullscreen: false });
  commandListener({}, { command: "windowFullscreen", fullscreen: "true" });
  commandListener({}, { command: "windowFullscreen", fullscreen: true, extra: true });
  // Retired native-to-renderer commands must not cross the preload boundary.
  commandListener({}, { command: "hostedSignInReturn" });
  commandListener({}, { command: "shareCardDownloadCompleted", filename: "2026-09-28-19-15-usagemonitor-results.png" });
  commandListener({}, { command: "shareCardDownloadFailed" });
  commandListener({}, { command: "language", value: "fr" });
  commandListener({}, { command: "refresh", selector: "#private" });
  commandListener({}, { command: "automaticRefresh", mode: "background" });
  commandListener({}, { command: "automaticRefresh", mode: "quick", extra: true });
  assert.deepEqual(JSON.parse(JSON.stringify(commands)), [
    { command: "refresh" },
    { command: "automaticRefresh", mode: "quick" },
    { command: "automaticRefresh", mode: "detailed" },
    { command: "dashboardSection", section: "overview" },
    { command: "dashboardSection", section: "usage" },
    { command: "dashboardSection", section: "allowance" },
    { command: "dashboardSection", section: "performance" },
    { command: "dashboardSection", section: "settings" },
    { command: "dashboardSection", section: "settings", settingsSection: "notifications" },
    { command: "settingsChanged" },
    { command: "language", value: "es" },
    { command: "sidebar", collapsed: true },
    { command: "windowFullscreen", fullscreen: true },
    { command: "windowFullscreen", fullscreen: false },
  ]);
  unsubscribe();
  assert.equal(commandListeners.size, 0);
  await bridge.getSettings();
  await bridge.getCodexHomesForSettings();
  await bridge.openSettings();
  await bridge.toggleSidebar();
  await bridge.chooseCodexHome();
  await bridge.addCodexHome();
  await bridge.editCodexHome({ rootId: "11111111-1111-4111-8111-111111111111" });
  await bridge.removeCodexHome({ rootId: "11111111-1111-4111-8111-111111111111" });
  await bridge.setPrimaryCodexHome({ rootId: "11111111-1111-4111-8111-111111111111" });
  await bridge.reorderCodexHomes({
    rootIds: ["11111111-1111-4111-8111-111111111111"],
  });
  await bridge.useDefaultCodexHome();
  await bridge.setLanguage("en");
  await bridge.setAppearance("dark");
  await bridge.setRefreshInterval(300);
  await bridge.setStartAtLogin(true);
  await bridge.setNotificationPreferences({
    threshold: 90,
  });
  await bridge.openSystemSettings("notifications");
  await bridge.openExternal("github");
  await bridge.checkForUpdates();
  await bridge.downloadUpdate();
  await bridge.installUpdateAndRestart();
  await bridge.setAutomaticDownload(false);
  await bridge.openDashboardInBrowser();
  await bridge.showDiagnostics();
  await bridge.revealLocalData();
  await bridge.getRefreshStatus();
  await bridge.refreshStarted("quick");
  await bridge.refreshHeartbeat(1);
  await bridge.refreshSettled(1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.map(({ channel, request }) => ({ channel, request })))), [
    { channel: "usagemonitor:desktop:v1", request: { action: "getSettings", args: {} } },
    { channel: "usagemonitor:desktop:v1", request: { action: "getCodexHomesForSettings", args: {} } },
    { channel: "usagemonitor:desktop:v1", request: { action: "openSettings", args: {} } },
    { channel: "usagemonitor:desktop:v1", request: { action: "toggleSidebar", args: {} } },
    { channel: "usagemonitor:desktop:v1", request: { action: "chooseCodexHome", args: {} } },
    { channel: "usagemonitor:desktop:v1", request: { action: "addCodexHome", args: {} } },
    {
      channel: "usagemonitor:desktop:v1",
      request: {
        action: "editCodexHome",
        args: { rootId: "11111111-1111-4111-8111-111111111111" },
      },
    },
    {
      channel: "usagemonitor:desktop:v1",
      request: {
        action: "removeCodexHome",
        args: { rootId: "11111111-1111-4111-8111-111111111111" },
      },
    },
    {
      channel: "usagemonitor:desktop:v1",
      request: {
        action: "setPrimaryCodexHome",
        args: { rootId: "11111111-1111-4111-8111-111111111111" },
      },
    },
    {
      channel: "usagemonitor:desktop:v1",
      request: {
        action: "reorderCodexHomes",
        args: { rootIds: ["11111111-1111-4111-8111-111111111111"] },
      },
    },
    { channel: "usagemonitor:desktop:v1", request: { action: "useDefaultCodexHome", args: {} } },
    { channel: "usagemonitor:desktop:v1", request: { action: "setLanguage", args: { value: "en" } } },
    { channel: "usagemonitor:desktop:v1", request: { action: "setAppearance", args: { value: "dark" } } },
    { channel: "usagemonitor:desktop:v1", request: { action: "setRefreshInterval", args: { seconds: 300 } } },
    { channel: "usagemonitor:desktop:v1", request: { action: "setStartAtLogin", args: { enabled: true } } },
    {
      channel: "usagemonitor:desktop:v1",
      request: {
        action: "setNotificationPreferences",
        args: { threshold: 90 },
      },
    },
    {
      channel: "usagemonitor:desktop:v1",
      request: { action: "openSystemSettings", args: { target: "notifications" } },
    },
    {
      channel: "usagemonitor:desktop:v1",
      request: { action: "openExternal", args: { target: "github" } },
    },
    { channel: "usagemonitor:desktop:v1", request: { action: "checkForUpdates", args: {} } },
    { channel: "usagemonitor:desktop:v1", request: { action: "downloadUpdate", args: {} } },
    { channel: "usagemonitor:desktop:v1", request: { action: "installUpdateAndRestart", args: {} } },
    { channel: "usagemonitor:desktop:v1", request: { action: "setAutomaticDownload", args: { enabled: false } } },
    { channel: "usagemonitor:desktop:v1", request: { action: "openDashboardInBrowser", args: {} } },
    { channel: "usagemonitor:desktop:v1", request: { action: "showDiagnostics", args: {} } },
    { channel: "usagemonitor:desktop:v1", request: { action: "revealLocalData", args: {} } },
    { channel: "usagemonitor:desktop:v1", request: { action: "getRefreshStatus", args: {} } },
    { channel: "usagemonitor:desktop:v1", request: { action: "refreshStarted", args: { mode: "quick" } } },
    { channel: "usagemonitor:desktop:v1", request: { action: "refreshHeartbeat", args: { lease: 1 } } },
    { channel: "usagemonitor:desktop:v1", request: { action: "refreshSettled", args: { lease: 1 } } },
  ]);
  await assert.rejects(
    bridge.setNotificationPreferences({ threshold: 90, extra: true }),
    (error) => error?.name === "TypeError",
  );
  for (const operation of [
    () => bridge.getWindowBackground("extra"),
    () => bridge.chooseWindowBackground({ path: "unexpected" }),
    () => bridge.restoreWindowBackground("extra"),
    () => bridge.setWindowBackground({ color: "url(x)", mask: 35, removeImage: false }),
    () => bridge.setWindowBackground({ color: "#FFFFFF", mask: 91, removeImage: false }),
    () => bridge.setWindowBackground({ color: "#FFFFFF", mask: 35, removeImage: false, extra: true }),
    () => bridge.onCommand(() => {}, "extra"),
    () => bridge.setLanguage("en", "extra"),
    () => bridge.toggleSidebar("extra"),
    () => bridge.getCodexHomesForSettings("extra"),
    () => bridge.addCodexHome("extra"),
    () => bridge.editCodexHome({ rootId: "11111111-1111-4111-8111-111111111111" }, "extra"),
    () => bridge.removeCodexHome({ rootId: "11111111-1111-4111-8111-111111111111" }, "extra"),
    () => bridge.setPrimaryCodexHome({ rootId: "11111111-1111-4111-8111-111111111111" }, "extra"),
    () => bridge.reorderCodexHomes({ rootIds: ["11111111-1111-4111-8111-111111111111"] }, "extra"),
    () => bridge.setAppearance("dark", "extra"),
    () => bridge.setRefreshInterval(300, "extra"),
    () => bridge.setStartAtLogin(true, "extra"),
    () => bridge.setNotificationPreferences(
      { threshold: 90 },
      "extra",
    ),
    () => bridge.openSystemSettings("startup", "extra"),
    () => bridge.openExternal("github", "extra"),
    () => bridge.checkForUpdates("extra"),
    () => bridge.downloadUpdate("extra"),
    () => bridge.installUpdateAndRestart("extra"),
    () => bridge.setAutomaticDownload("true"),
    () => bridge.setAutomaticDownload(true, "extra"),
    () => bridge.openDashboardInBrowser("extra"),
    () => bridge.showDiagnostics("extra"),
    () => bridge.revealLocalData("extra"),
    () => bridge.getRefreshStatus("extra"),
    () => bridge.refreshStarted(),
    () => bridge.refreshStarted("extra"),
    () => bridge.refreshStarted("quick", "extra"),
    () => bridge.refreshHeartbeat("extra"),
    () => bridge.refreshHeartbeat(0),
    () => bridge.refreshSettled("extra"),
    () => bridge.refreshSettled(0),
  ]) {
    await assert.rejects(operation(), (error) => error?.name === "TypeError");
  }
  for (const threshold of [-1, 1, 37, 100]) {
    await bridge.setNotificationPreferences({ threshold });
    assert.deepEqual(JSON.parse(JSON.stringify(calls.pop())).request.args, { threshold });
  }
  for (const threshold of [0, -2, 101, 1.5, "90", NaN, Infinity]) {
    await assert.rejects(bridge.setNotificationPreferences({ threshold }), (error) => error?.name === "TypeError");
  }
  await assert.rejects(bridge.setNotificationPreferences({ enabled: true, threshold: 90 }), (error) => error?.name === "TypeError");
  for (const seconds of [-1, 60, 2220, 86400 * 30]) {
    await bridge.setRefreshInterval(seconds);
    assert.deepEqual(JSON.parse(JSON.stringify(calls.pop())).request.args, { seconds });
  }
  for (const seconds of [0, -2, 1, 61, 60.5, "300", Infinity, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(bridge.setRefreshInterval(seconds), (error) => error?.name === "TypeError");
  }
  const validRootId = "11111111-1111-4111-8111-111111111111";
  for (const operation of [
    () => bridge.editCodexHome({ rootId: "not-a-uuid" }),
    () => bridge.editCodexHome({ rootId: validRootId, extra: true }),
    () => bridge.removeCodexHome({ rootId: "not-a-uuid" }),
    () => bridge.setPrimaryCodexHome({ rootId: "11111111-1111-5111-8111-111111111111" }),
    () => bridge.reorderCodexHomes({ rootIds: [] }),
    () => bridge.reorderCodexHomes({ rootIds: [validRootId, validRootId] }),
    () => bridge.reorderCodexHomes({
      rootIds: Array.from({ length: 9 }, () => validRootId),
    }),
    () => bridge.reorderCodexHomes({ rootIds: ["not-a-uuid"] }),
  ]) {
    await assert.rejects(operation(), (error) => error?.name === "TypeError");
  }
  for (const retired of [
    "openHostedSignIn", "getSharingPreference", "setSharingEnabled", "sharingNoticePresented",
    "openCommunity", "revealLatestDownload", "openLatestDownload",
  ]) assert.equal(Object.hasOwn(bridge, retired), false, `${retired} must not be exposed`);
});

test("preload exposes platform-qualified one-shot startup gates and rejects hostile calls", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "apps/electron/preload.cjs"), "utf8");
  function runPreload({
    platform,
    control,
    qualificationMarker,
    testLane,
    lexicalProcess = false,
  } = {}) {
    const exposed = {};
    const calls = [];
    const contextBridge = {
      exposeInMainWorld(name, bridge) {
        exposed[name] = bridge;
      },
    };
    const ipcRenderer = {
      invoke(channel, request) {
        calls.push({ channel, request });
        return Promise.resolve(request);
      },
      on() {},
      removeListener() {},
    };
    const context = {
      Promise,
      contextBridge,
      ipcRenderer,
      require(specifier) {
        assert.equal(specifier, "electron");
        return { contextBridge, ipcRenderer };
      },
    };
    const processValue = {
      platform,
      env: {
        USAGE_MONITOR_ELECTRON_SMOKE_CONTROL: control,
        USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION: qualificationMarker,
        USAGE_MONITOR_TEST_LANE: testLane,
      },
    };
    if (lexicalProcess) {
      context.lexicalProcess = processValue;
      vm.runInNewContext(`const process = lexicalProcess;\n${source}`, context, {
        filename: "preload.cjs",
      });
    } else {
      context.process = processValue;
      vm.runInNewContext(source, context, { filename: "preload.cjs" });
    }
    return { exposed, calls };
  }

  async function assertSmokeGate(smoke, name) {
    const gate = smoke.exposed[name];
    assert.equal(Object.isFrozen(gate), true);
    assert.deepEqual(Object.keys(gate), [
      "version",
      "waitForStartupRefresh",
      "releaseStartupRefresh",
    ]);
    assert.equal(gate.version, "v1");
    const pending = gate.waitForStartupRefresh();
    let settled = false;
    pending.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(gate.releaseStartupRefresh(), true);
    await pending;
    assert.equal(gate.releaseStartupRefresh(), false);
    assert.throws(
      () => gate.waitForStartupRefresh("unexpected"),
      (error) => error?.name === "TypeError",
    );
    assert.throws(
      () => gate.releaseStartupRefresh("unexpected"),
      (error) => error?.name === "TypeError",
    );
    assert.deepEqual(smoke.calls, [], "the gate carries no IPC or private data");
  }


  const windowsSmoke = runPreload({
    platform: "win32",
    control: "windows-v1",
    qualificationMarker: "windows-electron-v1",
    testLane: "windows-electron-smoke",
    lexicalProcess: true,
  });
  assert.deepEqual(Object.keys(windowsSmoke.exposed), [
    "__USAGE_MONITOR_ELECTRON_WINDOWS_SMOKE__",
    "usageMonitorDesktop",
  ]);
  await assertSmokeGate(windowsSmoke, "__USAGE_MONITOR_ELECTRON_WINDOWS_SMOKE__");

  const windowsNormalSmoke = runPreload({
    platform: "win32",
    control: "quit-v1",
    lexicalProcess: true,
  });
  assert.deepEqual(Object.keys(windowsNormalSmoke.exposed), [
    "__USAGE_MONITOR_ELECTRON_WINDOWS_SMOKE__",
    "usageMonitorDesktop",
  ]);
  await assertSmokeGate(windowsNormalSmoke, "__USAGE_MONITOR_ELECTRON_WINDOWS_SMOKE__");

  for (const options of [
    { platform: "win32", control: "windows-v1" },
    { platform: "win32", control: "windows-v1" },
    { platform: "win32", control: undefined },
    {
      platform: "win32",
      control: "windows-v1",
      qualificationMarker: "wrong-marker",
      testLane: "windows-electron-smoke",
    },
    {
      platform: "win32",
      control: "windows-v1",
      qualificationMarker: "windows-electron-v1",
      testLane: "wrong-lane",
    },
    {
      platform: "win32",
      control: "windows-v1",
      qualificationMarker: "windows-electron-v1",
    },
    {
      platform: "win32",
      control: "windows-v1",
      testLane: "windows-electron-smoke",
    },
    { platform: "win32", control: "other" },
    { platform: "win32", control: "windows-v1" },
    { platform: "win32", control: undefined },
  ]) {
    const unqualified = runPreload({ ...options, lexicalProcess: true });
    assert.equal(
      Object.hasOwn(unqualified.exposed, "__USAGE_MONITOR_ELECTRON_WINDOWS_SMOKE__"),
      false,
      JSON.stringify(options),
    );
  }
});

test("preload forwards only a trusted canonical Codex thread click", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "apps/electron/preload.cjs"), "utf8");
  const calls = [];
  const listeners = new Map();
  const contextBridge = {
    exposeInMainWorld() {},
  };
  const ipcRenderer = {
    invoke(channel, request) {
      calls.push({ channel, request });
      return Promise.resolve(true);
    },
    on() {},
    removeListener() {},
  };
  const context = {
    Promise,
    document: {
      addEventListener(name, listener, capture) {
        if (name === "click") assert.equal(capture, true);
        listeners.set(name, listener);
      },
    },
    contextBridge,
    ipcRenderer,
    require(specifier) {
      assert.equal(specifier, "electron");
      return { contextBridge, ipcRenderer };
    },
  };
  vm.runInNewContext(source, context, { filename: "preload.cjs" });
  const listener = listeners.get("click");
  assert.equal(typeof listener, "function");

  function click({ href, isTrusted = true, defaultPrevented = false } = {}) {
    let prevented = false;
    listener({
      isTrusted,
      defaultPrevented,
      preventDefault() {
        prevented = true;
      },
      target: {
        closest(selector) {
          assert.equal(selector, "a[href]");
          return href === null ? null : {
            getAttribute(name) {
              assert.equal(name, "href");
              return href;
            },
          };
        },
      },
    });
    return prevented;
  }

  const canonical = "codex://threads/11111111-1111-4111-8111-111111111111";
  assert.equal(click({ href: canonical }), true);
  assert.equal(click({ href: canonical, isTrusted: false }), false);
  assert.equal(click({ href: canonical, defaultPrevented: true }), false);
  for (const href of [
    "codex://threads/not-a-thread",
    "codex://threads/11111111-1111-4111-8111-111111111111?query",
    "codex://user@threads/11111111-1111-4111-8111-111111111111",
    "https://example.test/",
  ]) {
    assert.equal(click({ href }), false, href);
  }
  assert.equal(click({ href: null }), false);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    channel: "usagemonitor:desktop:v1",
    request: {
      action: "openCodexThread",
      args: { url: canonical },
    },
  }]);
});

test("preload marks both document roots as electron-dashboard across DOM readiness", async () => {
  const source = await readFile(join(REPOSITORY_ROOT, "apps/electron/preload.cjs"), "utf8");
  function classList() {
    const values = new Set();
    return {
      add(value) { values.add(value); },
      contains(value) { return values.has(value); },
    };
  }
  const documentElement = { classList: classList() };
  const document = {
    documentElement,
    body: null,
    addEventListener(name, callback) {
      assert.equal(name, "DOMContentLoaded");
      this.domReady = callback;
    },
  };
  vm.runInNewContext(
    source,
    {
      document,
      require(specifier) {
        assert.equal(specifier, "electron");
        return { contextBridge: undefined, ipcRenderer: undefined };
      },
    },
    { filename: "preload.cjs" },
  );
  assert.equal(documentElement.classList.contains("electron-dashboard"), true);
  assert.equal(documentElement.classList.contains("native-dashboard"), false);
  assert.equal(document.body, null);
  document.body = { classList: classList() };
  document.domReady();
  assert.equal(documentElement.classList.contains("electron-dashboard"), true);
  assert.equal(document.body.classList.contains("electron-dashboard"), true);
  assert.equal(documentElement.classList.contains("native-dashboard"), false);
  assert.equal(document.body.classList.contains("native-dashboard"), false);
});

test("dashboard minimum width fits smaller display work areas", async () => {
  const windows = [];
  const lifecycle = createDesktopLifecycle({
    app: new FakeApp(),
    BrowserWindow: class extends FakeWindow {
      constructor(options) { super(options); windows.push(this); }
    },
    Tray: FakeTray,
    Menu: { buildFromTemplate: template => ({ template }) },
    icon: "empty-icon", preloadPath: "/private/preload.cjs",
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) },
    supervisor: { async start() { return { origin: "http://127.0.0.1:4999" }; }, async stop() {} },
  });
  await lifecycle.start();
  const dashboard = windows.find(window => window.options.webPreferences.preload === "/private/preload.cjs");
  assert.equal(dashboard.options.minWidth, 800);
  assert.equal(dashboard.options.width, 800);
  await lifecycle.requestQuit();
});
