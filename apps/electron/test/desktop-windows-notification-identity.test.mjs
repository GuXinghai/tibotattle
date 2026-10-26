import applicationIdentity from "../../../config/application-identity.cjs";
import assert from "node:assert/strict";
import test from "node:test";

import { prepareWindowsNotificationIdentity } from "../desktop-windows-notification-identity.js";

const IDENTITY = Object.freeze({
  appUserModelId: "com.usagemonitor.local",
  toastActivatorClsid: "FDA705D7-5644-50E8-8CD2-3005D51B98C5",
});
const APP_DATA = "C:\\Users\\Ada\\AppData\\Roaming";
const EXECUTABLE = "C:\\Users\\Ada\\AppData\\Local\\Programs\\Rhetrion\\usage-monitor.exe";
const SHORTCUT = `${APP_DATA}\\Microsoft\\Windows\\Start Menu\\Programs\\Rhetrion.lnk`;

function fixture({
  packaged = true,
  profile = "stable",
  name = "Rhetrion",
  shortcut = { target: EXECUTABLE, appUserModelId: IDENTITY.appUserModelId },
  readShortcutLink = undefined,
  setAppUserModelId = undefined,
  setToastActivatorCLSID = undefined,
} = {}) {
  const calls = [];
  const app = {
    isPackaged: packaged,
    getName: () => name,
    getPath: (name_) => name_ === "appData" ? APP_DATA : name_ === "exe" ? EXECUTABLE : null,
    setAppUserModelId: setAppUserModelId ?? ((value) => calls.push(["appUserModelId", value])),
    setToastActivatorCLSID: setToastActivatorCLSID ?? ((value) => calls.push(["toastActivatorClsid", value])),
  };
  const shell = {
    readShortcutLink: readShortcutLink ?? ((path) => {
      calls.push(["readShortcutLink", path]);
      return shortcut;
    }),
  };
  return { app, calls, shell, applicationProfile: applicationIdentity.applicationMetadata(profile) };
}

test("Windows notification identity requires the installed Start Menu target and AUMID", () => {
  const value = fixture();
  assert.equal(prepareWindowsNotificationIdentity({
    applicationProfile: value.applicationProfile,
    app: value.app,
    shell: value.shell,
    platform: "win32",
    identity: IDENTITY,
  }), true);
  assert.deepEqual(value.calls, [
    ["readShortcutLink", SHORTCUT],
    ["appUserModelId", IDENTITY.appUserModelId],
    ["toastActivatorClsid", IDENTITY.toastActivatorClsid],
  ]);
});

test("Windows notification identity refuses development, another app, shortcut mismatch, and native errors", () => {
  const scenarios = [
    fixture({ packaged: false }),
    fixture({ profile: "development" }),
    fixture({ shortcut: { target: "C:\\other.exe", appUserModelId: IDENTITY.appUserModelId } }),
    fixture({ shortcut: { target: EXECUTABLE, appUserModelId: "other.app" } }),
    fixture({ readShortcutLink: () => { throw new Error("missing"); } }),
    fixture({ setToastActivatorCLSID: () => { throw new Error("unavailable"); } }),
    fixture({ profile: "preview" }),
  ];
  for (const value of scenarios) {
    assert.equal(prepareWindowsNotificationIdentity({
      applicationProfile: value.applicationProfile,
    app: value.app,
      shell: value.shell,
      platform: "win32",
      identity: IDENTITY,
    }), false);
  }
  const nonWindows = fixture();
  assert.equal(prepareWindowsNotificationIdentity({
    applicationProfile: nonWindows.applicationProfile,
    app: nonWindows.app,
    shell: nonWindows.shell,
    platform: "darwin",
    identity: IDENTITY,
  }), false);
  assert.deepEqual(nonWindows.calls, []);
});

test("Windows notification identity refuses an unconfigured CLSID without reading or mutating the app", () => {
  const value = fixture();
  assert.equal(prepareWindowsNotificationIdentity({
    applicationProfile: value.applicationProfile,
    app: value.app,
    shell: value.shell,
    platform: "win32",
    identity: { appUserModelId: IDENTITY.appUserModelId, toastActivatorClsid: "not-a-guid" },
  }), false);
  assert.deepEqual(value.calls, []);
});
