import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createProductionDesktopUpdater,
  createProductionDistributionMetadata,
  DesktopUpdaterError,
  PRODUCTION_ELECTRON_UPDATE_CHECK_INTERVAL_MS,
  productionUpdateFeedForTarget,
} from "../desktop-updater.js";

const SOURCE_REVISION = "a".repeat(40);

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function metadata(target = "win32-x64") {
  return createProductionDistributionMetadata({
    buildNumber: "20260906",
    sourceRevision: SOURCE_REVISION,
    target,
  });
}

function preferences({ automaticDownload = true, available = true } = {}) {
  return {
    async get() {
      return { automaticDownload, available };
    },
    async setAutomaticDownload(value) {
      if (!available) throw new Error("unavailable");
      automaticDownload = value;
      return { automaticDownload, available };
    },
  };
}

class FakeElectronUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = null;
    this.autoInstallOnAppQuit = null;
    this.allowPrerelease = null;
    this.allowDowngrade = null;
    this.checks = 0;
    this.downloads = 0;
    this.installs = 0;
    this.quitAndInstallResult = undefined;
  }

  async checkForUpdates() {
    this.checks += 1;
    this.emit("update-not-available", { version: "0.1.18" });
    return { updateInfo: null };
  }

  async downloadUpdate() {
    this.downloads += 1;
    this.emit("update-downloaded", { version: "0.1.19" });
    return [];
  }

  quitAndInstall(...args) {
    this.installs += 1;
    this.quitAndInstallArgs = args;
    return this.onQuitAndInstall?.() ?? this.quitAndInstallResult;
  }
}

function packagedUpdater({
  autoUpdater = new FakeElectronUpdater(),
  automaticDownload = true,
  prepareForUpdate,
  cancelPreparedUpdate,
  setIntervalImpl,
  clearIntervalImpl,
  distributionMetadata = metadata(),
} = {}) {
  const app = {
    isPackaged: true,
    quitCalls: 0,
    getVersion: () => "0.1.18",
    quit() { this.quitCalls += 1; },
  };
  return {
    app,
    autoUpdater,
    updater: createProductionDesktopUpdater({
      app,
      autoUpdater,
      distributionMetadata,
      platform: "win32",
      architecture: "x64",
      preferences: preferences({ automaticDownload }),
      prepareForUpdate,
      cancelPreparedUpdate,
      setIntervalImpl,
      clearIntervalImpl,
    }),
  };
}

test("production updater has fixed target feeds and refuses malformed candidate metadata", () => {
  assert.equal(
    productionUpdateFeedForTarget({ platform: "win32", architecture: "x64" }),
    null,
  );
  assert.equal(productionUpdateFeedForTarget({ platform: "win32", architecture: "ia32" }), null);
  assert.throws(() => createProductionDistributionMetadata({
    buildNumber: "0", sourceRevision: SOURCE_REVISION, target: "win32-x64",
  }), /invalid/u);
  assert.throws(() => createProductionDistributionMetadata({
    buildNumber: "20260906", sourceRevision: SOURCE_REVISION, target: "win32-x64",
    channel: "preview",
  }), /invalid/u);
});



test("an unconfigured local distribution never reads or starts an updater adapter", async () => {
  const autoUpdater = new Proxy({}, { get() { throw new Error("updater must stay untouched"); } });
  const { updater } = packagedUpdater({ autoUpdater });
  assert.equal((await updater.start()).state, "unavailable");
  assert.equal(updater.getStatus().canCheck, false);
  assert.equal(updater.getStatus().canDownload, false);
  assert.equal(updater.getStatus().canInstall, false);
  await assert.rejects(updater.checkForUpdates(), { code: "desktop_updater_unavailable" });
  await assert.rejects(updater.downloadUpdate(), { code: "desktop_updater_unavailable" });
  await assert.rejects(updater.installAndRestart(), { code: "desktop_updater_unavailable" });
  await updater.dispose();
});
