import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareElectronProfileStartup,
  selectElectronProfileStartup,
} from "../main.js";
import { prepareApplicationProfileDirectories } from "../application-profile.js";
import { createProductionDistributionMetadata } from "../desktop-updater.js";
import {
  isWindowsElectronQualificationRequested,
  WINDOWS_ELECTRON_QUALIFICATION_MARKER,
  WINDOWS_ELECTRON_QUALIFICATION_ENVIRONMENT_KEY,
  WINDOWS_ELECTRON_TEST_LANE,
} from "../windows-qualification.js";

const appData = "C:\\Users\\Synthetic\\AppData\\Roaming";
const isolatedAppData = `${appData}\\qualification`;

function fakeApp({ existingDirectories = [] } = {}) {
  const calls = [];
  const directories = new Set([appData, ...existingDirectories]);
  const selectedPaths = { appData };
  return {
    calls,
    directories,
    isPackaged: false,
    ready: false,
    isReady() { return this.ready; },
    getPath(name) {
      calls.push(["getPath", name]);
      return selectedPaths[name] ?? appData;
    },
    requestSingleInstanceLock() {
      calls.push(["lock"]);
      return true;
    },
    setPath(name, path) {
      if (!directories.has(path)) throw new Error("Electron setPath directory does not exist");
      calls.push(["setPath", name, path]);
      selectedPaths[name] = path;
    },
  };
}

function developmentSelection(app) {
  return selectElectronProfileStartup({
    app,
    environment: { APPDATA: isolatedAppData },
    platform: "win32",
    architecture: "x64",
    readPackage: () => ({ identity: { profile: "development" }, distribution: null }),
    qualificationRequested: () => true,
  });
}

function fakeProfileFilesystem(app) {
  const mutations = [];
  return {
    mutations,
    ensureDirectory(path) {
      app.calls.push(["ensureDirectory", path]);
      if (!app.directories.has(path)) {
        app.directories.add(path);
        mutations.push(path);
      }
      return Object.freeze({ synthetic: true });
    },
    inspectPath(path) {
      app.calls.push(["inspectPath", path]);
      if (!app.directories.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return Object.freeze({
        isDirectory: true,
        isReparsePoint: false,
        ownerMatches: true,
        finalPathResolved: true,
      });
    },
  };
}

test("qualification request selection retains the exact packaged development gate", () => {
  const app = { isPackaged: true, getAppPath: () => "C:\\synthetic\\app.asar" };
  const environment = {
    [WINDOWS_ELECTRON_QUALIFICATION_ENVIRONMENT_KEY]: WINDOWS_ELECTRON_QUALIFICATION_MARKER,
    USAGE_MONITOR_TEST_LANE: WINDOWS_ELECTRON_TEST_LANE,
  };
  assert.equal(isWindowsElectronQualificationRequested({
    app, environment, platform: "win32", architecture: "x64",
  }), true);
  assert.equal(isWindowsElectronQualificationRequested({
    app, environment: { ...environment, USAGE_MONITOR_TEST_LANE: "other" },
    platform: "win32", architecture: "x64",
  }), false);
  assert.equal(isWindowsElectronQualificationRequested({
    app: { ...app, isPackaged: false }, environment, platform: "win32", architecture: "x64",
  }), false);
});

test("existing-profile secondary validates and pins paths but performs no profile mutation", () => {
  const app = fakeApp();
  const selection = developmentSelection(app);
  app.directories.add(selection.profilePaths.userData);
  app.directories.add(selection.profilePaths.sessionData);
  app.requestSingleInstanceLock = () => {
    app.calls.push(["lock"]);
    return false;
  };
  const fileSystem = fakeProfileFilesystem(app);

  const startup = prepareElectronProfileStartup({
    app,
    selection,
    createProfileFilesystemAdapter: () => fileSystem,
  });

  assert.equal(startup.singleInstanceLockAcquired, false);
  assert.deepEqual(fileSystem.mutations, []);
  assert.deepEqual(app.calls.slice(-3), [
    ["setPath", "userData", selection.profilePaths.userData],
    ["setPath", "sessionData", selection.profilePaths.sessionData],
    ["lock"],
  ]);
  assert.equal(app.calls.some(([name]) => name === "prepareBrowserProfile"), false);
});

test("fresh primary creates only empty protected path roots, pins, locks, then prepares profile", () => {
  const app = fakeApp();
  const selection = developmentSelection(app);
  const fileSystem = fakeProfileFilesystem(app);
  const startup = prepareElectronProfileStartup({
    app,
    selection,
    createProfileFilesystemAdapter: () => fileSystem,
  });
  assert.equal(startup.singleInstanceLockAcquired, true);
  assert.deepEqual(fileSystem.mutations, [
    selection.profilePaths.userData,
    selection.profilePaths.sessionData,
  ]);

  prepareApplicationProfileDirectories({
    app,
    appData: startup.appData,
    profile: startup.applicationProfile,
    platform: "win32",
    prepareDirectory(path, kind) {
      app.calls.push(["fullProfilePreparation", kind, path]);
    },
  });

  const lockIndex = app.calls.findIndex(([name]) => name === "lock");
  const fullPreparationIndex = app.calls.findIndex(([name]) => name === "fullProfilePreparation");
  assert.ok(lockIndex >= 0);
  assert.ok(fullPreparationIndex > lockIndex);
  assert.deepEqual(app.calls.slice(-2), [
    ["fullProfilePreparation", "state", selection.profilePaths.userData],
    ["fullProfilePreparation", "session", selection.profilePaths.sessionData],
  ]);
});

test("stable and development profiles keep distinct paths before locking", () => {
  const stableApp = fakeApp();
  const stable = selectElectronProfileStartup({
    app: stableApp,
    environment: {},
    platform: "win32",
    architecture: "x64",
    readPackage: () => ({
      identity: { profile: "stable" },
      distribution: createProductionDistributionMetadata({
        buildNumber: "1",
        target: "win32-x64",
        sourceRevision: "a".repeat(40),
      }),
    }),
    qualificationRequested: () => false,
  });
  const development = developmentSelection(fakeApp());

  assert.notEqual(stable.profilePaths.userData, development.profilePaths.userData);
  assert.notEqual(stable.profilePaths.sessionData, development.profilePaths.sessionData);
  assert.notEqual(stable.appData, development.appData);
});

test("qualification completing after Electron ready fails before directory preparation", () => {
  const app = fakeApp();
  const selection = developmentSelection(app);
  const beforeReady = app.calls.slice();
  app.ready = true;
  let adapterRequests = 0;

  assert.throws(() => prepareElectronProfileStartup({
    app,
    selection,
    createProfileFilesystemAdapter() {
      adapterRequests += 1;
      throw new Error("must not request native adapter after ready");
    },
  }), { code: "electron_shell_electron_configuration_invalid" });
  assert.equal(adapterRequests, 0);
  assert.deepEqual(app.calls, beforeReady);
});
