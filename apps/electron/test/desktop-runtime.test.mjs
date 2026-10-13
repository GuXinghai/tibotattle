import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { DESKTOP_DEFAULT_SETTINGS } from "../desktop-contract.js";
import { DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION } from "../desktop-first-run.js";
import { launchDesktopRuntime } from "../desktop-runtime.js";
import distribution from "../../../config/electron-production-distribution.cjs";
import {
  DESKTOP_SHELL_NOTIFICATION_EVIDENCE_SCHEMA_VERSION,
  DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
} from "../../../src/desktop-shell-status.js";

const DEFAULT_CODEX_ROOT_ID = DESKTOP_DEFAULT_SETTINGS.codexHomes.primaryRootId;
const CUSTOM_CODEX_ROOT_ID = "11111111-1111-4111-8111-111111111111";

function customCodexHomes(path, rootId = CUSTOM_CODEX_ROOT_ID) {
  return {
    activityRoots: [{
      rootId,
      kind: "custom",
      path,
      enabled: true,
    }],
    primaryRootId: rootId,
  };
}

function twoCodexHomes(primaryRootId = DEFAULT_CODEX_ROOT_ID) {
  return {
    activityRoots: [
      {
        rootId: DEFAULT_CODEX_ROOT_ID,
        kind: "default",
        path: null,
        enabled: true,
      },
      {
        rootId: CUSTOM_CODEX_ROOT_ID,
        kind: "custom",
        path: "C:\\Users\\adam\\.codex-custom",
        enabled: true,
      },
    ],
    primaryRootId,
  };
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill() {
    queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

class FakeIpcChild extends FakeChild {
  constructor() {
    super();
    this.connected = true;
    this.messages = [];
  }

  send(message, callback) {
    this.messages.push(structuredClone(message));
    callback?.();
    return true;
  }
}

class FakeApp extends EventEmitter {
  constructor({ lockResult = true } = {}) {
    super();
    this.isPackaged = false;
    this.quitCalls = 0;
    this.readyCalls = 0;
    this.ready = false;
    this.lockResult = lockResult;
    this.lockCalls = 0;
  }

  requestSingleInstanceLock() {
    this.lockCalls += 1;
    return this.lockResult;
  }

  async whenReady() {
    this.readyCalls += 1;
    this.ready = true;
  }

  getPath(name) {
    assert.equal(name, "userData");
    return "/Users/adam/Library/Application Support/TiboTattle";
  }

  quit() {
    this.quitCalls += 1;
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.session = {};
    this.mainFrame = { isMainFrame: true, parent: null };
    this.commands = [];
    this.url = "";
  }

  send(channel, value) {
    this.commands.push({ channel, value });
  }

  getURL() {
    return this.url;
  }
}

class FakeWindow extends EventEmitter {
  static instances = [];

  constructor(options) {
    super();
    this.options = options;
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.destroyed = false;
    FakeWindow.instances.push(this);
  }

  loadURL(url) {
    this.webContents.url = url;
    return Promise.resolve();
  }

  once(event, callback) {
    return super.once(event, callback);
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

class FakeTray extends EventEmitter {
  static instances = [];

  constructor(...args) {
    super(...args);
    this.icon = args[0];
    FakeTray.instances.push(this);
  }

  setToolTip() {}

  setContextMenu(menu) {
    this.menu = menu;
  }

  destroy() {}
}

function platformServices() {
  return {
    defaultCodexHome: "C:\\Users\\adam\\.codex",
    defaultCodexHomeDisplay: "Default location (~/.codex)",
    validateCodexHome: async (path) => path,
    loginItemStatus: () => ({
      status: "unavailable",
      canSet: false,
      detail: "unavailable",
    }),
    setStartAtLogin: () => ({
      status: "unavailable",
      canSet: false,
      detail: "unavailable",
    }),
    notificationStatus: () => ({
      permission: "unavailable",
      available: false,
      detail: "unavailable",
    }),
    chooseCodexHome: async () => "C:\\Users\\adam\\.codex-custom",
    openSystemSettings: async () => {},
    openExternal: async () => {},
    about: () => ({
      version: "0.1.16",
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

function notificationBackendFixture({ value = null, events = [] } = {}) {
  let stored = value;
  return {
    get stored() {
      return stored;
    },
    async load() {
      events.push("load");
      return stored;
    },
    async save(next) {
      events.push("save");
      stored = next;
      return next;
    },
  };
}

function runtime(app) {
  return {
    app,
    dialog: {
      showMessageBox: async () => {
        assert.equal(app.ready, true);
        return { response: 0 };
      },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    BrowserWindow: FakeWindow,
    Tray: FakeTray,
    Menu: { buildFromTemplate: (template) => ({ template }) },
    icon: "test-icon",
  };
}

function signedStagingRuntimeComposition(metadata, createWindowsCredentialBackend) {
  return Object.freeze({
    createWindowsCredentialBackend,
    executionProfile: metadata.executionProfile,
    expectedTestUID: metadata.expectedTestUID,
    expectedTestUsername: metadata.expectedTestUsername,
    origin: metadata.origin,
    policyVersion: metadata.contributionPolicy,
  });
}

function shellStatus({ usedPercent, observedAt }) {
  const notificationEvidence = {
    schemaVersion: "tibotattle-notification-evidence-v2",
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt,
    continuityKey: "a".repeat(43),
    windows: [{
      lane: "primary",
      durationMinutes: 300,
      resetAt: "2026-09-01T10:00:00.000Z",
      resetProofKind: "provider_reported_schedule_only",
      usedPercent,
    }],
  };
  return {
    schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
    state: "fresh",
    allowance: {
      source: "direct",
      window: "five_hour",
      remainingPercent: 100 - usedPercent,
    },
    notificationEvidence: {
      ...notificationEvidence,
      schemaVersion: DESKTOP_SHELL_NOTIFICATION_EVIDENCE_SCHEMA_VERSION,
    },
  };
}

function fakeNotification({ supported = true } = {}) {
  const shown = [];
  class FakeNotification {
    static isSupported() {
      return supported;
    }

    constructor(options) {
      shown.push(options);
    }

    show() {}
  }
  return { Notification: FakeNotification, shown };
}

async function launchFixture({
  load,
  save = async () => {},
  platformServices: suppliedPlatformServices,
  notificationBackend = notificationBackendFixture(),
  firstRunReceiptBackend = {
    load: async () => ({
      schemaVersion: DESKTOP_FIRST_RUN_RECEIPT_SCHEMA_VERSION,
      acknowledged: true,
    }),
    save: async () => {},
  },
  platform = "win32",
  architecture = process.arch,
  argv = [],
  app: suppliedApp,
  runtimeOverrides = {},
  lifecycleOptions = {},
  accountlessLaboratory,
  accountlessProduction,
  productionDistribution,
  prepareNativeHandover,
  onStartupPhase,
  onStartupStop,
  getuid,
  getUserInfo,
  loadProductionUpdater,
  sharingBackend,
  sharingInstallationState,
  ownedCompanionScript,
  crashCapture,
  childFactory,
  onSpawn = () => {},
  environment = {
    HOME: "/Users/adam",
    USAGE_MONITOR_RESOURCE_ROOT: "/repo",
  },
} = {}) {
  FakeTray.instances = [];
  FakeWindow.instances = [];
  const app = suppliedApp ?? new FakeApp();
  const children = [];
  const spawnCalls = [];
  const backend = { load, save };
  const launch = launchDesktopRuntime({
    runtime: { ...runtime(app), ...runtimeOverrides },
    app,
    paths: {
      companionScript: ownedCompanionScript ?? "/repo/apps/local/server.js",
      companionCwd: ownedCompanionScript ? process.cwd() : "/repo",
      resourceRoot: "/repo",
      preloadPath: "/repo/apps/electron/preload.cjs",
    },
    environment,
    platformServices: suppliedPlatformServices ?? (productionDistribution
      ? undefined : platformServices()),
    notificationBackend,
    firstRunReceiptBackend,
    platform,
    architecture,
    crashCapture,
    argv,
    lifecycleOptions,
    accountlessLaboratory,
    accountlessProduction,
    productionDistribution,
    prepareNativeHandover,
    onStartupPhase,
    onStartupStop,
    getuid,
    getUserInfo,
    loadProductionUpdater,
    sharingBackend,
    sharingInstallationState,
    settingsBackend: backend,
    supervisorOptions: {
      spawnChild(_command, args, options) {
        spawnCalls.push({ args: [...args], options });
        onSpawn({ args: [...args], options });
        const child = ownedCompanionScript ? spawn(_command, args, options)
          : childFactory?.() ?? new FakeChild();
        children.push(child);
        if (productionDistribution && !ownedCompanionScript) queueMicrotask(() => {
          child.stdout.emit("data", Buffer.from("USAGE_MONITOR_READY http://127.0.0.1:4811/\n"));
        });
        return child;
      },
      startupTimeoutMs: ownedCompanionScript ? 5_000 : 1_000,
      shutdownTimeoutMs: 1_000,
    },
  });
  // Attach a rejection observer before the readiness tick. Some negative
  // launch cases fail during controller initialization, before this helper
  // can return its outer promise to the test.
  launch.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  if (!ownedCompanionScript && !productionDistribution) children[0]?.stdout.emit("data", Buffer.from("USAGE_MONITOR_READY http://127.0.0.1:4811/\n"));
  const desktop = await launch;
  return { app, children, spawnCalls, desktop };
}

test("normal desktop cannot enable accountless uploads through environment variables", async () => {
  let productionUpdaterLoads = 0;
  const fixture = await launchFixture({ load: async () => null, environment: {
    HOME: "/Users/adam", USAGE_MONITOR_CENTRAL_ORIGIN: "https://tibotattle.com",
    USAGE_MONITOR_ACCOUNTLESS_ORIGIN: "https://tibotattle.com",
  }, loadProductionUpdater: async () => {
    productionUpdaterLoads += 1;
    return { autoUpdater: null };
  } });
  assert.equal(fixture.spawnCalls[0].options.env.USAGE_MONITOR_CENTRAL_ORIGIN, undefined);
  assert.equal(fixture.spawnCalls[0].options.env.USAGE_MONITOR_ACCOUNTLESS_ORIGIN, undefined);
  assert.deepEqual(fixture.spawnCalls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(productionUpdaterLoads, 0, "ordinary desktop startup never loads the production updater");
  await fixture.desktop.lifecycle.requestQuit();
});














test("accountless laboratory rejects hosted destinations and absent synthetic lane", async () => {
  for (const [origin, lane] of [["https://tibotattle.com", "accountless-local-lab-v1"], ["http://127.0.0.1:18901", undefined]]) {
    await assert.rejects(launchFixture({ load: async () => null,
      environment: { HOME: "/Users/adam", ...(lane ? { USAGE_MONITOR_TEST_LANE: lane } : {}) },
      sharingBackend: { load: async () => null, save: async () => {} }, sharingInstallationState: "fresh",
      accountlessLaboratory: { origin, backend: {} },
    }), { code: "electron_shell_electron_configuration_invalid" });
  }
});

test("accountless laboratory rejects incomplete injected credential capabilities before readiness", async () => {
  for (const backend of [null, {}, { read: async () => null }, {
    read: async () => null, createIfMissing: async () => "created", deleteExact: false,
  }]) {
    const app = new FakeApp();
    await assert.rejects(launchFixture({ app, load: async () => null,
      environment: { HOME: "/synthetic", USAGE_MONITOR_TEST_LANE: "accountless-local-lab-v1" },
      sharingBackend: { load: async () => null, save: async () => {} }, sharingInstallationState: "fresh",
      accountlessLaboratory: { origin: "http://127.0.0.1:18901", backend },
    }), { code: "electron_shell_electron_configuration_invalid" });
    assert.equal(app.readyCalls, 0);
  }
});







test("Windows production accountless requires an explicit native factory before readiness", async () => {
  const app = new FakeApp();
  app.isPackaged = true;
  app.getName = () => "TiboTattle";
  let safeStorageCalls = 0;
  let spawned = 0;
  await assert.rejects(launchFixture({
    app,
    platform: "win32",
    architecture: "x64",
    load: async () => null,
    runtimeOverrides: {
      safeStorage: {
        isAsyncEncryptionAvailable: async () => { safeStorageCalls += 1; return true; },
        encryptStringAsync: async () => { safeStorageCalls += 1; return Buffer.alloc(0); },
        decryptStringAsync: async () => { safeStorageCalls += 1; return null; },
      },
    },
    environment: { USERPROFILE: "C:\\synthetic" },
    sharingBackend: { load: async () => null, save: async () => {} },
    sharingInstallationState: "fresh",
    accountlessProduction: {
      origin: "https://tibotattle.com",
      policyVersion: "accountless-opt-out-v1",
    },
    onSpawn: () => { spawned += 1; },
  }), { code: "electron_shell_electron_configuration_invalid" });
  assert.equal(app.readyCalls, 0);
  assert.equal(spawned, 0);
  assert.equal(safeStorageCalls, 0);
});

test("Windows production accountless factory failure prevents child startup without safeStorage", async () => {
  const app = new FakeApp();
  app.isPackaged = true;
  app.getName = () => "TiboTattle";
  let safeStorageCalls = 0;
  let factoryCalls = 0;
  let spawned = 0;
  await assert.rejects(launchFixture({
    app,
    platform: "win32",
    architecture: "x64",
    load: async () => null,
    runtimeOverrides: {
      safeStorage: {
        isAsyncEncryptionAvailable: async () => { safeStorageCalls += 1; return true; },
        encryptStringAsync: async () => { safeStorageCalls += 1; return Buffer.alloc(0); },
        decryptStringAsync: async () => { safeStorageCalls += 1; return null; },
      },
    },
    environment: { USERPROFILE: "C:\\synthetic" },
    sharingBackend: { load: async () => null, save: async () => {} },
    sharingInstallationState: "fresh",
    accountlessProduction: {
      origin: "https://tibotattle.com",
      policyVersion: "accountless-opt-out-v1",
      createWindowsCredentialBackend() {
        factoryCalls += 1;
        throw new Error("Windows native credential backend is unavailable");
      },
    },
    onSpawn: () => { spawned += 1; },
  }), /Windows native credential backend is unavailable/u);
  assert.equal(factoryCalls, 1);
  assert.equal(spawned, 0);
  assert.equal(safeStorageCalls, 0);
});

test("Windows native accountless recovery remains FD3-only and never initializes safeStorage", async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "windows-accountless-runtime-"));
  const app = new FakeApp();
  app.isPackaged = true;
  app.getName = () => "TiboTattle";
  app.getPath = () => profile;
  let fixture;
  let factoryCalls = 0;
  let nativeCalls = 0;
  let safeStorageCalls = 0;
  t.after(async () => {
    try { await fixture?.desktop.lifecycle.requestQuit(); }
    finally { await rm(profile, { recursive: true, force: true }); }
  });
  fixture = await launchFixture({
    app,
    platform: "win32",
    architecture: "x64",
    load: async () => null,
    runtimeOverrides: {
      safeStorage: {
        isAsyncEncryptionAvailable: async () => { safeStorageCalls += 1; throw new Error("must not run"); },
        encryptStringAsync: async () => { safeStorageCalls += 1; throw new Error("must not run"); },
        decryptStringAsync: async () => { safeStorageCalls += 1; throw new Error("must not run"); },
      },
    },
    environment: { USERPROFILE: profile },
    platformServices: {
      ...platformServices(),
      defaultCodexHome: "C:\\synthetic\\.codex",
    },
    sharingBackend: { load: async () => null, save: async () => {} },
    sharingInstallationState: "fresh",
    accountlessProduction: {
      origin: "https://tibotattle.com",
      policyVersion: "accountless-opt-out-v1",
      createWindowsCredentialBackend({ legacyCredentialProbe, rootPath }) {
        factoryCalls += 1;
        assert.equal(typeof legacyCredentialProbe, "function");
        assert.equal(rootPath, join(profile, "desktop-settings"));
        return {
          async read() { nativeCalls += 1; throw new Error("must not access native credential"); },
          async createIfMissing() { nativeCalls += 1; throw new Error("must not access native credential"); },
          async deleteExact() { nativeCalls += 1; throw new Error("must not access native credential"); },
        };
      },
    },
    childFactory: () => new FakeIpcChild(),
  });
  assert.equal(factoryCalls, 1);
  assert.deepEqual(fixture.spawnCalls[0].options.stdio, ["ignore", "pipe", "pipe", "ipc"]);
  assert.equal(Object.hasOwn(fixture.spawnCalls[0].options.env, "USAGE_MONITOR_KEYCHAIN_BROKER_FD"), false);
  assert.equal(Object.hasOwn(fixture.spawnCalls[0].options.env, "USAGE_MONITOR_WINDOWS_ACCOUNTLESS_CREDENTIAL"), false);
  fixture.children[0].emit("message", {
    schemaVersion: "accountless-process-v1",
    kind: "request",
    id: 1,
    operation: "read",
    value: null,
  });
  const deadline = Date.now() + 5_000;
  while (!fixture.children[0].messages.some((message) => message.kind === "response" && message.id === 1)) {
    assert.ok(Date.now() < deadline, "Windows accountless recovery did not stay on the private FD3 route");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(fixture.children[0].messages, [{
    schemaVersion: "accountless-process-v1",
    kind: "response",
    id: 1,
    ok: false,
    value: "credential_recovery_required",
  }]);
  assert.equal(nativeCalls, 0);
  assert.equal(safeStorageCalls, 0);
});




for (const production of [false, true]) test(`desktop ${production ? "production" : "laboratory"} composes protected credentials with an owned companion and durable opt-out`, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), "accountless-runtime-"));
  const launched = [];
  const app = new FakeApp();
  app.getPath = () => profile;
  app.isPackaged = production;
  app.getName = () => "TiboTattle";
  const key = randomBytes(32);
  t.after(async () => {
    try { await Promise.all(launched.map((fixture) => fixture.desktop.lifecycle.requestQuit())); }
    finally { key.fill(0); nativeSecret?.fill(0); await rm(profile, { recursive: true, force: true }); }
  });
  let safeStorageCalls = 0;
  let encryptions = 0;
  let decryptions = 0;
  let encryptionAvailable = false;
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => {
      safeStorageCalls += 1;
      assert.equal(app.ready, true);
      return encryptionAvailable;
    },
    async encryptStringAsync(value) {
      safeStorageCalls += 1;
      encryptions += 1;
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    async decryptStringAsync(bytes) {
      safeStorageCalls += 1;
      decryptions += 1;
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"), shouldReEncrypt: false };
    },
  };
  // Production now proves the active accountless Keychain path before the
  // companion starts. The dedicated blocked/retry tests above cover its
  // unavailable transition; this end-to-end fixture starts ready.
  let nativeAvailable = production;
  let nativeSecret = null;
  let nativeCreates = 0;
  const nativeUnavailable = () => Object.assign(new Error("native credential unavailable"), {
    code: "contribution_device_credential_unavailable",
    retryable: true,
  });
  const createWindowsCredentialBackend = ({ legacyCredentialProbe }) => {
    assert.equal(typeof legacyCredentialProbe, "function");
    const readyNative = async () => {
      assert.equal(await legacyCredentialProbe(), "absent");
      if (!nativeAvailable) throw nativeUnavailable();
    };
    return {
      async read() {
        await readyNative();
        return nativeSecret === null ? null : Buffer.from(nativeSecret);
      },
      async createIfMissing(value) {
        await readyNative();
        if (nativeSecret !== null) return "existing";
        nativeSecret = Buffer.from(value);
        nativeCreates += 1;
        return "created";
      },
      async deleteExact(value) {
        await readyNative();
        if (nativeSecret === null) return "missing";
        if (!nativeSecret.equals(value)) return "mismatch";
        nativeSecret.fill(0);
        nativeSecret = null;
        return "deleted";
      },
    };
  };
  let savedChoice = null;
  const sharingBackend = {
    load: async () => savedChoice,
    save: async (value) => { savedChoice = structuredClone(value); },
  };
  const options = {
    app, load: async () => null, runtimeOverrides: { safeStorage },
    environment: { HOME: profile, ...(production ? {} : { USAGE_MONITOR_TEST_LANE: "accountless-local-lab-v1" }) },
    sharingBackend, sharingInstallationState: "fresh",
    ...(production ? { accountlessProduction: {
      origin: "https://tibotattle.com", policyVersion: "accountless-opt-out-v1",
      createWindowsCredentialBackend,
    } } : { accountlessLaboratory: { origin: "http://127.0.0.1:18901" } }),
    ownedCompanionScript: fileURLToPath(new URL("../../../test/fixtures/accountless-runtime-child.mjs", import.meta.url)),
  };
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 5_000;
    while (!await predicate()) {
      assert.ok(Date.now() < deadline, "owned companion did not reach expected state");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const first = await launchFixture(options);
  launched.push(first);
  assert.deepEqual(first.spawnCalls[0].options.stdio, ["ignore", "pipe", "pipe", "ipc"]);
  if (production) {
    await waitFor(async () =>
      (await first.desktop.sharingCoordinator.inspect()).transportStatus === "up_to_date");
  } else {
    await waitFor(async () =>
      (await first.desktop.sharingCoordinator.inspect()).transportStatus === "retry_wait");
    assert.equal(encryptions, 0,
      "unavailable laboratory credentials must not mint an installation");
    encryptionAvailable = true;
    first.children[0].send({
      schemaVersion: "synthetic-accountless-runtime-control-v1",
      action: "run",
    });
  }
  await waitFor(async () => (await first.desktop.sharingCoordinator.inspect()).transportStatus === "up_to_date");
  const credentialPath = join(profile, "desktop-settings", "accountless-installation-credential-v1.json");
  let stored = null;
  if (production) {
    assert.equal(encryptions, 0);
    assert.equal(safeStorageCalls, 0, "production macOS must not initialize safeStorage");
    assert.equal(nativeCreates, 1);
    await assert.rejects(readFile(credentialPath), { code: "ENOENT" });
  } else {
    assert.equal(encryptions, 1);
    stored = await readFile(credentialPath, "utf8");
    assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ["encrypted", "schemaVersion"]);
  }
  first.children[0].send({ schemaVersion: "synthetic-accountless-runtime-control-v1", action: "run" });
  await waitFor(async () => (await first.desktop.sharingCoordinator.inspect()).transportStatus === "uploading");
  await first.desktop.sharingCoordinator.setEnabled(false);
  assert.equal((await first.desktop.sharingCoordinator.inspect()).transportStatus, "off");
  await first.desktop.lifecycle.requestQuit();
  const readsBeforeRestart = decryptions;
  const restarted = await launchFixture(options);
  launched.push(restarted);
  await waitFor(async () => (await restarted.desktop.sharingCoordinator.inspect()).transportStatus === "off");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(decryptions, readsBeforeRestart, "saved opt-out must deny credential access on restart");
  if (production) {
    assert.equal(safeStorageCalls, 0, "restart must still avoid safeStorage");
    assert.equal(nativeCreates, 1, "restart must not rotate the installation");
    await assert.rejects(readFile(credentialPath), { code: "ENOENT" });
  } else {
    assert.equal(await readFile(credentialPath, "utf8"), stored, "restart must not rotate the installation");
  }
  await restarted.desktop.sharingCoordinator.setEnabled(true);
  await waitFor(async () => (await restarted.desktop.sharingCoordinator.inspect()).transportStatus === "up_to_date");
  if (production) {
    assert.equal(nativeCreates, 1, "explicit re-enable reuses the same installation credential");
    assert.equal(safeStorageCalls, 0);
  } else {
    assert.equal(encryptions, 1, "explicit re-enable reuses the same installation credential");
  }
  await restarted.desktop.lifecycle.requestQuit();
});


test("runtime persists the fixed Electron appearance and updates live renderers", async () => {
  const nativeTheme = new EventEmitter();
  nativeTheme.themeSource = "system";
  nativeTheme.shouldUseDarkColors = true;
  const { desktop } = await launchFixture({
    load: async () => null,
    runtimeOverrides: { nativeTheme },
  });

  assert.equal(nativeTheme.themeSource, "system");
  assert.equal((await desktop.controller.handlers.getSettings()).settings.appearance, "system");

  const dark = await desktop.controller.handlers.setAppearance({ value: "dark" });
  assert.equal(nativeTheme.themeSource, "dark");
  assert.equal(dark.settings.appearance, "dark");
  assert.ok(FakeWindow.instances.some((candidate) => (
    candidate.webContents.commands.some(({ value }) => (
      value?.command === "appearance"
      && value.preference === "dark"
      && value.resolvedTheme === "dark"
    ))
  )));

  nativeTheme.shouldUseDarkColors = false;
  nativeTheme.emit("updated");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nativeTheme.themeSource, "dark", "a forced theme remains forced when the system changes");

  await desktop.controller.handlers.setAppearance({ value: "system" });
  assert.equal(nativeTheme.themeSource, "system");
  nativeTheme.emit("updated");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(FakeWindow.instances.some((candidate) => (
    candidate.webContents.commands.some(({ value }) => (
      value?.command === "appearance"
      && value.preference === "system"
      && value.resolvedTheme === "light"
    ))
  )));
  await desktop.lifecycle.dispose();
});

test("runtime applies the persisted appearance before creating the first window", async () => {
  for (const appearance of ["system", "light", "dark"]) {
    const nativeTheme = new EventEmitter();
    nativeTheme.themeSource = "system";
    nativeTheme.shouldUseDarkColors = true;
    const themeSourcesAtWindowCreation = [];
    class AppearanceWindow extends FakeWindow {
      constructor(options) {
        themeSourcesAtWindowCreation.push(nativeTheme.themeSource);
        super(options);
      }
    }
    const { desktop } = await launchFixture({
      load: async () => ({ ...DESKTOP_DEFAULT_SETTINGS, appearance }),
      runtimeOverrides: { BrowserWindow: AppearanceWindow, nativeTheme },
    });

    assert.equal(themeSourcesAtWindowCreation[0], appearance);
    await desktop.lifecycle.dispose();
  }
});

test("runtime accepts Codex handoff only from the ready dashboard main frame", async () => {
  const opened = [];
  const ipcMain = {
    handler: null,
    handle(channel, handler) {
      assert.equal(channel, "tibotattle:desktop:v1");
      this.handler = handler;
    },
    removeHandler(channel) {
      assert.equal(channel, "tibotattle:desktop:v1");
      this.handler = null;
    },
  };
  const { desktop } = await launchFixture({
    load: async () => null,
    runtimeOverrides: { ipcMain },
    platformServices: {
      ...platformServices(),
      openCodexThread: async (url) => {
        opened.push(url);
        return true;
      },
    },
  });
  const dashboard = FakeWindow.instances.find((candidate) => (
    candidate.options.webPreferences.preload === "/repo/apps/electron/preload.cjs"
  ));
  assert.notEqual(dashboard, undefined);
  dashboard.emit("ready-to-show");
  assert.equal(desktop.lifecycle.state.dashboardReady, true);
  const canonical = "codex://threads/11111111-1111-4111-8111-111111111111";
  const event = {
    sender: dashboard.webContents,
    senderFrame: dashboard.webContents.mainFrame,
  };
  const dashboardOrigin = "http://127.0.0.1:4811";
  dashboard.webContents.url = `${dashboardOrigin}/#section`;
  assert.equal(
    desktop.lifecycle.isAuthorizedCodexThreadNavigation(
      event.senderFrame,
      { sender: event.sender },
    ),
    true,
  );
  for (const liveURL of [
    `${dashboardOrigin}/electron-settings.html#general`,
    `${dashboardOrigin}/other-dashboard-page`,
    `${dashboardOrigin}/?query`,
  ]) {
    dashboard.webContents.url = liveURL;
    assert.equal(
      desktop.lifecycle.isAuthorizedCodexThreadNavigation(
        event.senderFrame,
        { sender: event.sender },
      ),
      false,
      `same-origin non-dashboard URL must fail closed: ${liveURL}`,
    );
    await assert.rejects(
      ipcMain.handler(event, { action: "openCodexThread", args: { url: canonical } }),
      (error) => error?.code === "desktop_ipc_untrusted_context",
    );
  }
  dashboard.webContents.url = `${dashboardOrigin}/`;
  assert.equal(
    await ipcMain.handler(event, { action: "openCodexThread", args: { url: canonical } }),
    true,
  );
  assert.deepEqual(opened, [canonical]);
  await assert.rejects(
    ipcMain.handler(
      { sender: dashboard.webContents, senderFrame: {} },
      { action: "openCodexThread", args: { url: canonical } },
    ),
    (error) => error?.code === "desktop_ipc_untrusted_context",
  );
  await assert.rejects(
    ipcMain.handler(
      event,
      { action: "openCodexThread", args: { url: `${canonical}?query` } },
    ),
    (error) => error?.code === "desktop_ipc_invalid_request",
  );
  assert.deepEqual(opened, [canonical]);
  assert.equal(
    await ipcMain.handler(event, { action: "openCommunity", args: {} }),
    true,
  );
  assert.deepEqual(dashboard.webContents.commands.at(-1), {
    channel: "tibotattle:desktop-command:v1",
    value: { command: "dashboardSection", section: "community" },
  });
  await assert.rejects(
    ipcMain.handler(
      { sender: dashboard.webContents, senderFrame: {} },
      { action: "openCommunity", args: {} },
    ),
    (error) => error?.code === "desktop_ipc_untrusted_context",
  );
  await assert.rejects(
    ipcMain.handler(event, { action: "openCommunity", args: { extra: true } }),
    (error) => error?.code === "desktop_ipc_invalid_request",
  );
  await desktop.lifecycle.dispose();
});

test("runtime awaits Electron readiness before the first-run native dialog", async () => {
  const app = new FakeApp();
  const dialogCalls = [];
  const children = [];
  const startupEvents = [];
  app.quit = () => {
    startupEvents.push("quit");
    app.quitCalls += 1;
  };
  const launch = launchDesktopRuntime({
    runtime: {
      ...runtime(app),
      dialog: {
        showMessageBox: async (options) => {
          dialogCalls.push({ ready: app.ready, options });
          return { response: 1 };
        },
      },
    },
    app,
    paths: {
      companionScript: "/repo/apps/local/server.js",
      companionCwd: "/repo",
      resourceRoot: "/repo",
      preloadPath: "/repo/apps/electron/preload.cjs",
    },
    environment: { HOME: "/Users/adam", USAGE_MONITOR_RESOURCE_ROOT: "/repo" },
    platformServices: platformServices(),
    firstRunReceiptBackend: {
      load: async () => null,
      save: async () => {},
    },
    supervisorOptions: {
      spawnChild() {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    },
    onStartupStop: async (code) => {
      startupEvents.push(`stop:${code}`);
    },
  });
  const desktop = await launch;
  assert.equal(app.readyCalls, 1);
  assert.deepEqual(dialogCalls.map(({ ready }) => ready), [true]);
  assert.equal(desktop.firstRun.status, "cancelled");
  assert.equal(children.length, 0);
  assert.equal(app.quitCalls, 1);
  assert.deepEqual(startupEvents, ["stop:startup_stopped", "quit"]);
});

test("runtime uses Electron preferred system languages for first-run copy", async () => {
  const app = new FakeApp();
  app.getPreferredSystemLanguages = () => ["es-ES"];
  app.getLocale = () => "en-US";
  const dialogCalls = [];
  const launch = launchDesktopRuntime({
    runtime: {
      ...runtime(app),
      dialog: {
        showMessageBox: async (options) => {
          dialogCalls.push(options);
          return { response: 1 };
        },
      },
    },
    app,
    paths: {
      companionScript: "/repo/apps/local/server.js",
      companionCwd: "/repo",
      resourceRoot: "/repo",
      preloadPath: "/repo/apps/electron/preload.cjs",
    },
    environment: { HOME: "/Users/adam", USAGE_MONITOR_RESOURCE_ROOT: "/repo" },
    platformServices: platformServices(),
    firstRunReceiptBackend: {
      load: async () => null,
      save: async () => {},
    },
    supervisorOptions: {
      spawnChild() {
        return new FakeChild();
      },
    },
  });
  const desktop = await launch;
  assert.equal(desktop.firstRun.status, "cancelled");
  assert.deepEqual(dialogCalls[0].buttons, ["Continuar", "Salir"]);
  assert.match(dialogCalls[0].detail, /servicio auxiliar|contribución/u);
});

test("runtime applies persisted custom CODEX_HOME before first child start", async () => {
  const fixture = await launchFixture({
    load: async () => ({
      ...DESKTOP_DEFAULT_SETTINGS,
      codexHomes: customCodexHomes("C:\\Users\\adam\\.codex-first"),
    }),
  });
  assert.equal(fixture.desktop.childEnvironment.CODEX_HOME, "C:\\Users\\adam\\.codex-first");
  assert.deepEqual(fixture.spawnCalls[0].args, ["/repo/apps/local/server.js"]);
  await fixture.desktop.lifecycle.dispose();
});

test("runtime launches the companion with only the selected primary CODEX_HOME", async () => {
  const fixture = await launchFixture({
    load: async () => ({
      ...DESKTOP_DEFAULT_SETTINGS,
      codexHomes: twoCodexHomes(CUSTOM_CODEX_ROOT_ID),
    }),
  });
  assert.deepEqual(fixture.spawnCalls[0].args, ["/repo/apps/local/server.js"]);
  assert.equal(fixture.spawnCalls[0].options.env.CODEX_HOME, "C:\\Users\\adam\\.codex-custom");

  const roots = await fixture.desktop.controller.handlers.getCodexHomesForSettings({});
  assert.deepEqual(roots.activityRoots.map(({ rootId }) => rootId), [
    DEFAULT_CODEX_ROOT_ID,
    CUSTOM_CODEX_ROOT_ID,
  ]);
  const setPrimary = fixture.desktop.controller.handlers.setPrimaryCodexHome({
    rootId: DEFAULT_CODEX_ROOT_ID,
  });
  for (let attempt = 0; attempt < 20 && fixture.children.length < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fixture.children.length, 2);
  fixture.children[1].stdout.emit("data", Buffer.from("USAGE_MONITOR_READY http://127.0.0.1:4812/\n"));
  await setPrimary;
  assert.deepEqual(fixture.spawnCalls[1].args, ["/repo/apps/local/server.js"]);
  assert.equal(fixture.spawnCalls[1].options.env.CODEX_HOME, "C:\\Users\\adam\\.codex");
  const persisted = await fixture.desktop.controller.handlers.getCodexHomesForSettings({});
  assert.deepEqual(persisted.activityRoots.map(({ rootId }) => rootId), [
    DEFAULT_CODEX_ROOT_ID,
    CUSTOM_CODEX_ROOT_ID,
  ]);
  assert.equal(persisted.primaryRootId, DEFAULT_CODEX_ROOT_ID);
  await fixture.desktop.lifecycle.dispose();
});


test("runtime wires safe browser, diagnostics, and local-data actions", async () => {
  const external = [];
  const revealed = [];
  const copied = [];
  const dialogs = [];
  const fixture = await launchFixture({
    load: async () => null,
    runtimeOverrides: {
      dialog: {
        showMessageBox: async (options) => {
          dialogs.push(options);
          return { response: 0 };
        },
      },
      shell: {
        openExternal: async (url) => external.push(url),
        showItemInFolder: (path) => revealed.push(path),
      },
      clipboard: {
        writeText: (value) => copied.push(value),
      },
    },
  });

  assert.equal(await fixture.desktop.controller.handlers.openDashboardInBrowser({}), true);
  assert.deepEqual(external, ["http://127.0.0.1:4811/"]);

  assert.equal(await fixture.desktop.controller.handlers.revealLocalData({}), true);
  assert.deepEqual(revealed, ["/Users/adam/Library/Application Support/TiboTattle/companion-state"]);

  assert.deepEqual(
    await fixture.desktop.controller.handlers.showDiagnostics({}),
    { status: "copied" },
  );
  assert.equal(dialogs.length, 1);
  assert.equal(copied.length, 1);
  assert.equal(copied[0], dialogs[0].detail);
  assert.match(dialogs[0].detail, /tibotattle-electron-diagnostics-v2/u);
  assert.match(dialogs[0].detail, /"cadenceTimerArmed": true/u);
  assert.doesNotMatch(dialogs[0].detail, /Users|127\.0\.0\.1|codex-first/u);
  await fixture.desktop.lifecycle.dispose();
});


test("runtime applies the persisted desktop language to the initial tray menu", async () => {
  const fixture = await launchFixture({
    load: async () => ({
      ...DESKTOP_DEFAULT_SETTINGS,
      language: "zh-Hans",
    }),
  });
  const tray = FakeTray.instances.at(-1);
  assert.equal(tray.menu.template.find((item) => item.label === "打开 TiboTattle")?.label, "打开 TiboTattle");
  await fixture.desktop.lifecycle.dispose();
});

test("runtime forwards the trusted dynamic tray-image factory to lifecycle", async () => {
  const dynamicIcon = Object.freeze({ kind: "dynamic-tray-icon" });
  const calls = [];
  const fixture = await launchFixture({
    load: async () => null,
    runtimeOverrides: {
      createTrayIcon: (trayStatus) => {
        calls.push(trayStatus.status);
        return dynamicIcon;
      },
    },
  });
  const tray = FakeTray.instances.at(-1);
  assert.equal(tray.icon, dynamicIcon);
  assert.ok(calls.includes("starting"));
  await fixture.desktop.lifecycle.dispose();
});

test("runtime invalidates a dashboard refresh lease when its renderer is replaced", async () => {
  const fixture = await launchFixture({
    load: async () => null,
  });
  const dashboard = FakeWindow.instances.find((candidate) => (
    candidate.options.webPreferences.preload === "/repo/apps/electron/preload.cjs"
  ));
  assert.notEqual(dashboard, undefined);
  dashboard.emit("ready-to-show");
  const lease = await fixture.desktop.controller.handlers.refreshStarted({ mode: "quick" });
  dashboard.webContents.emit("render-process-gone", {}, {
    reason: "crashed",
    exitCode: 17,
  });
  assert.equal(
    await fixture.desktop.controller.handlers.refreshSettled({ lease }),
    false,
    "a replaced dashboard cannot settle the abandoned renderer lease",
  );
  await fixture.desktop.lifecycle.dispose();
});



test("a secondary Electron instance exits before first-run or companion startup", async () => {
  const app = new FakeApp({ lockResult: false });
  const startupEvents = [];
  app.quit = () => {
    startupEvents.push("quit");
    app.quitCalls += 1;
  };
  const fixture = await launchFixture({
    app,
    platform: "win32",
    argv: ["usagemonitor://open"],
    load: async () => null,
    onStartupStop: async (code) => {
      assert.equal(app.quitCalls, 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
      startupEvents.push(`stop:${code}`);
    },
  });
  assert.equal(fixture.desktop.status, "secondary_instance");
  assert.equal(app.quitCalls, 1);
  assert.deepEqual(startupEvents, ["stop:secondary_instance", "quit"]);
  assert.equal(app.readyCalls, 0);
  assert.equal(fixture.children.length, 0);
});

test("runtime retains a configured root when its path is currently unavailable", async () => {
  const validated = [];
  const missing = "C:\\Users\\adam\\.codex-gone";
  const services = {
    ...platformServices(),
    validateCodexHome: async (path) => {
      validated.push(path);
      throw new Error("saved folder disappeared");
    },
  };
  const fixture = await launchFixture({
    platformServices: services,
    load: async () => ({
      ...DESKTOP_DEFAULT_SETTINGS,
      codexHomes: customCodexHomes(missing),
    }),
  });
  assert.deepEqual(validated, []);
  assert.equal(fixture.desktop.childEnvironment.CODEX_HOME, missing);
  assert.deepEqual(fixture.spawnCalls[0].args, ["/repo/apps/local/server.js"]);
  assert.equal(
    (await fixture.desktop.controller.handlers.getCodexHomesForSettings({})).activityRoots[0].path,
    missing,
  );
  const settings = await fixture.desktop.controller.handlers.getSettings({});
  assert.equal(settings.settings.codexFolder.kind, "custom");
  assert.equal(Object.hasOwn(settings.settings.codexFolder, "recovery"), false);
  await fixture.desktop.lifecycle.dispose();
});

test("runtime keeps the prior child and environment when root persistence fails", async () => {
  let saves = 0;
  const fixture = await launchFixture({
    load: async () => null,
    save: async () => {
      saves += 1;
      throw new Error("synthetic persistence failure");
    },
  });
  await assert.rejects(
    fixture.desktop.controller.handlers.chooseCodexHome({}),
    (error) => error?.code === "desktop_codex_roots_persistence_failed",
  );
  assert.equal(saves, 1);
  assert.equal(fixture.children.length, 1);
  assert.equal(fixture.desktop.childEnvironment.CODEX_HOME, "C:\\Users\\adam\\.codex");
  assert.deepEqual(fixture.spawnCalls[0].args, ["/repo/apps/local/server.js"]);
  await fixture.desktop.lifecycle.dispose();
});

test("runtime keeps policy persistence separate and delivers one localized crossing", async () => {
  const fake = fakeNotification();
  const policyEvents = [];
  const policyBackend = notificationBackendFixture({ events: policyEvents });
  const app = new FakeApp();
  app.isPackaged = true;
  const fixture = await launchFixture({
    app,
    runtimeOverrides: { Notification: fake.Notification },
    notificationBackend: policyBackend,
    load: async () => null,
  });
  assert.deepEqual(policyEvents.slice(0, 2), ["load", "save"]);
  await fixture.desktop.controller.handlers.setLanguage({ value: "es" });
  await fixture.desktop.notificationCoordinator.setPreferences({
    enabled: true,
    threshold: "ninety",
  });
  const first = await fixture.desktop.notificationCoordinator.evaluate(shellStatus({
    usedPercent: 40,
    observedAt: "2026-08-22T10:00:00.000Z",
  }));
  const crossing = await fixture.desktop.notificationCoordinator.evaluate(shellStatus({
    usedPercent: 95,
    observedAt: "2026-08-22T10:05:00.000Z",
  }));
  const duplicate = await fixture.desktop.notificationCoordinator.evaluate(shellStatus({
    usedPercent: 95,
    observedAt: "2026-08-22T10:06:00.000Z",
  }));
  assert.equal(first.outcome, "first_observation");
  assert.equal(crossing.outcome, "notification");
  assert.equal(duplicate.outcome, "no_crossing");
  assert.equal(fake.shown.length, 1);
  assert.equal(fake.shown[0].title, "El uso de la cuota alcanzó el 90 %");
  assert.match(fake.shown[0].body, /superó el umbral/u);
  assert.ok(policyEvents.includes("save"));
  const recovery = await fixture.desktop.notificationCoordinator.evaluate({
    schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
    state: "stale",
    allowance: null,
    notificationEvidence: null,
  });
  assert.equal(recovery.outcome, "ineligible");
  const afterRecovery = await fixture.desktop.notificationCoordinator.evaluate(shellStatus({
    usedPercent: 95,
    observedAt: "2026-08-22T10:10:00.000Z",
  }));
  assert.equal(afterRecovery.outcome, "first_observation");
  await fixture.desktop.lifecycle.dispose();
  assert.equal(fixture.desktop.notificationCoordinator.status().state, "disposed");
});

test("runtime truthfully gates development and Windows notification identity", async () => {
  const development = await launchFixture({
    load: async () => null,
    notificationBackend: notificationBackendFixture(),
  });
  const developmentSettings = await development.desktop.controller.handlers.getSettings({});
  assert.equal(developmentSettings.settings.notifications.delivery, "not_packaged");
  await development.desktop.lifecycle.dispose();

  const fake = fakeNotification();
  const app = new FakeApp();
  app.isPackaged = true;
  const windowsServices = {
    ...platformServices(),
    defaultCodexHome: "C:\\Users\\adam\\.codex",
  };
  const windows = await launchFixture({
    app,
    platform: "win32",
    platformServices: windowsServices,
    runtimeOverrides: { Notification: fake.Notification },
    notificationBackend: notificationBackendFixture(),
    load: async () => null,
    environment: {
      USERPROFILE: "C:\\Users\\adam",
      USAGE_MONITOR_RESOURCE_ROOT: "/repo",
    },
  });
  const windowsSettings = await windows.desktop.controller.handlers.getSettings({});
  assert.equal(
    windowsSettings.settings.notifications.delivery,
    "windows_identity_unavailable",
  );
  assert.equal(windowsSettings.settings.notifications.canSet, false);
  await windows.desktop.lifecycle.dispose();
});

test("runtime enables Windows delivery only after the installed identity matches and retains it across language changes", async () => {
  const fake = fakeNotification();
  const calls = [];
  const app = new FakeApp();
  app.isPackaged = true;
  app.getName = () => "TiboTattle";
  const originalGetPath = app.getPath.bind(app);
  app.getPath = (name) => ({
    appData: "C:\\Users\\adam\\AppData\\Roaming",
    exe: "C:\\Users\\adam\\AppData\\Local\\Programs\\TiboTattle\\TiboTattle.exe",
  })[name] ?? originalGetPath(name);
  app.setAppUserModelId = (value) => calls.push(["appUserModelId", value]);
  app.setToastActivatorCLSID = (value) => calls.push(["toastActivatorClsid", value]);
  const windows = await launchFixture({
    app,
    platform: "win32",
    platformServices: { ...platformServices(), defaultCodexHome: "C:\\Users\\adam\\.codex" },
    runtimeOverrides: {
      Notification: fake.Notification,
      shell: {
        readShortcutLink(path) {
          calls.push(["shortcut", path]);
          return {
            target: "C:\\Users\\adam\\AppData\\Local\\Programs\\TiboTattle\\TiboTattle.exe",
            appUserModelId: distribution.PRODUCTION_ELECTRON_APP_ID,
          };
        },
      },
    },
    notificationBackend: notificationBackendFixture(),
    load: async () => null,
    environment: { USERPROFILE: "C:\\Users\\adam", USAGE_MONITOR_RESOURCE_ROOT: "/repo" },
  });
  assert.equal(
    (await windows.desktop.controller.handlers.getSettings({})).settings.notifications.delivery,
    "ready",
  );
  await windows.desktop.controller.handlers.setLanguage({ value: "es" });
  assert.equal(
    (await windows.desktop.controller.handlers.getSettings({})).settings.notifications.delivery,
    "ready",
  );
  assert.deepEqual(calls, [
    ["shortcut", "C:\\Users\\adam\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\TiboTattle.lnk"],
    ["appUserModelId", distribution.PRODUCTION_ELECTRON_APP_ID],
    ["toastActivatorClsid", distribution.PRODUCTION_ELECTRON_WINDOWS_TOAST_ACTIVATOR_CLSID],
  ]);
  await windows.desktop.lifecycle.dispose();
});

test("fresh first-run login choice is applied once without changing the receipt", async () => {
  const calls = [];
  let loginEnabled = false;
  const services = {
    ...platformServices(),
    loginItemStatus: () => ({
      status: loginEnabled ? "enabled" : "disabled",
      canSet: true,
      detail: "fixed",
    }),
    setStartAtLogin: (enabled) => {
      calls.push(enabled);
      loginEnabled = enabled;
      return {
        status: enabled ? "enabled" : "disabled",
        canSet: true,
        detail: "fixed",
      };
    },
  };
  const dialogs = [];
  const app = new FakeApp();
  const firstRunReceiptBackend = {
    value: null,
    async load() {
      return this.value;
    },
    async save(value) {
      this.value = value;
    },
  };
  const launch = launchDesktopRuntime({
    runtime: {
      ...runtime(app),
      dialog: {
        async showMessageBox(options) {
          dialogs.push(options);
          return dialogs.length === 1
            ? { response: 0, checkboxChecked: true }
            : { response: 0 };
        },
      },
    },
    app,
    paths: {
      companionScript: "/repo/apps/local/server.js",
      companionCwd: "/repo",
      resourceRoot: "/repo",
      preloadPath: "/repo/apps/electron/preload.cjs",
    },
    environment: { HOME: "/Users/adam", USAGE_MONITOR_RESOURCE_ROOT: "/repo" },
    platformServices: services,
    settingsBackend: {
      async load() {
        return null;
      },
      async save() {},
    },
    firstRunReceiptBackend,
    notificationBackend: notificationBackendFixture(),
    supervisorOptions: {
      spawnChild() {
        const child = new FakeChild();
        queueMicrotask(() => child.stdout.emit(
          "data",
          Buffer.from("USAGE_MONITOR_READY http://127.0.0.1:4811/\n"),
        ));
        return child;
      },
    },
  });
  const desktop = await launch;
  assert.deepEqual(desktop.firstRunLogin, { status: "enabled" });
  assert.deepEqual(calls, [true]);
  assert.equal(firstRunReceiptBackend.value.acknowledged, true);
  assert.equal(Object.hasOwn(firstRunReceiptBackend.value, "startAtLogin"), false);
  assert.equal(dialogs.length, 1);
  await desktop.lifecycle.dispose();
});

test("Windows qualification rejects injected notification persistence", async () => {
  const app = new FakeApp();
  await assert.rejects(
    launchDesktopRuntime({
      runtime: runtime(app),
      app,
      paths: {
        companionScript: "/repo/apps/local/server.js",
        companionCwd: "/repo",
        resourceRoot: "/repo",
        preloadPath: "/repo/apps/electron/preload.cjs",
      },
      platform: "win32",
      qualificationContext: {},
      notificationBackend: notificationBackendFixture(),
      environment: { USERPROFILE: "C:\\Users\\adam", USAGE_MONITOR_RESOURCE_ROOT: "/repo" },
    }),
    (error) => error?.code === "electron_shell_windows_qualification_launch_override_forbidden",
  );
});


test("production contributions reject development identity, ambient QA and conflicting destinations before readiness", async () => {
  for (const override of [
    { packaged: false }, { name: "TiboTattle Dev" },
    { environment: { USAGE_MONITOR_TEST_LANE: "macos-electron-local-qa-v1" } },
    { origin: "https://unreviewed.example" }, { policyVersion: "unknown" },
  ]) {
    const app = new FakeApp();
    app.isPackaged = override.packaged ?? true;
    app.getName = () => override.name ?? "TiboTattle";
    await assert.rejects(launchFixture({ app, load: async () => null,
      environment: override.environment ?? {},
      accountlessProduction: { origin: override.origin ?? "https://tibotattle.com",
        policyVersion: override.policyVersion ?? "accountless-opt-out-v1" },
    }), { code: "electron_shell_electron_configuration_invalid" });
    assert.equal(app.readyCalls, 0);
  }
});

test("runtime authorizes a manual notification test only from the live Settings frame", async () => {
  const fake = fakeNotification();
  const ipcMain = {
    handler: null,
    handle(channel, handler) {
      assert.equal(channel, "tibotattle:desktop:v1");
      this.handler = handler;
    },
    removeHandler() {
      this.handler = null;
    },
  };
  const app = new FakeApp();
  app.isPackaged = true;
  const { desktop } = await launchFixture({
    app,
    load: async () => null,
    runtimeOverrides: { ipcMain, Notification: fake.Notification },
  });
  await desktop.controller.handlers.openSettings({});
  const settings = FakeWindow.instances.find((candidate) => (
    candidate.webContents.url.endsWith("/electron-settings.html#general")
  ));
  const dashboard = FakeWindow.instances.find((candidate) => candidate !== settings);
  assert.notEqual(settings, undefined);
  assert.notEqual(dashboard, undefined);

  const settingsEvent = {
    sender: settings.webContents,
    senderFrame: settings.webContents.mainFrame,
  };
  const dashboardEvent = {
    sender: dashboard.webContents,
    senderFrame: dashboard.webContents.mainFrame,
  };
  await assert.rejects(
    ipcMain.handler(dashboardEvent, { action: "sendTestNotification", args: {} }),
    (error) => error?.code === "desktop_ipc_untrusted_context",
  );
  assert.deepEqual(
    await ipcMain.handler(settingsEvent, { action: "sendTestNotification", args: {} }),
    { status: "requested" },
  );
  assert.equal(fake.shown.length, 1);
  settings.webContents.url = "http://127.0.0.1:4811/other";
  await assert.rejects(
    ipcMain.handler(settingsEvent, { action: "sendTestNotification", args: {} }),
    (error) => error?.code === "desktop_ipc_untrusted_context",
  );
  await desktop.lifecycle.dispose();
});
