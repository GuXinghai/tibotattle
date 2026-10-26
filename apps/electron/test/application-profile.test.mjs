import assert from "node:assert/strict";
import test from "node:test";
import identity from "../../../config/application-identity.cjs";
import {
  applicationProfilePaths,
  pinApplicationProfilePaths,
  prepareApplicationProfileDirectories,
  readApplicationPackage,
  readApplicationPackageSync,
} from "../application-profile.js";

const appData = "C:\\Users\\Ada\\AppData\\Roaming";
function manifest(profile = "stable", productName = "Synthetic Brand") {
  return {
    name: identity.APPLICATION_IDENTITY.packageName,
    main: "apps/electron/main.js",
    productName,
    usageMonitorIdentity: identity.applicationMetadata(profile),
    ...(profile === "stable" ? { usageMonitorDistribution: { synthetic: true } } : {}),
  };
}
function packaged(value) {
  return readApplicationPackage({
    app: { isPackaged: true, getAppPath: () => "C:\\application\\app.asar" },
    readManifest: async () => Buffer.from(JSON.stringify(value)),
  });
}

test("display branding cannot select or change the persisted application identity", async () => {
  const a = await packaged(manifest("stable", "First Brand"));
  const b = await packaged(manifest("stable", "Second Brand"));
  assert.deepEqual(a, b);
  assert.deepEqual(applicationProfilePaths({ appData, profile: a.identity.profile, platform: "win32" }),
    applicationProfilePaths({ appData, profile: b.identity.profile, platform: "win32" }));
  assert.notDeepEqual(applicationProfilePaths({ appData, profile: "stable", platform: "win32" }),
    applicationProfilePaths({ appData, profile: "development", platform: "win32" }));
});

test("packaged authority rejects missing, foreign, newer or mixed profile metadata", async () => {
  const base = manifest();
  for (const value of [
    {}, { ...base, name: "another-package" }, { ...base, main: "other.js" },
    { ...base, usageMonitorIdentity: undefined },
    { ...base, usageMonitorIdentity: { ...base.usageMonitorIdentity, profile: "unknown" } },
    { ...base, usageMonitorIdentity: { ...base.usageMonitorIdentity, appId: "other.app" } },
    { ...base, usageMonitorIdentity: { ...base.usageMonitorIdentity, schemaVersion: "future-version" } },
    { ...base, usageMonitorIdentity: { ...base.usageMonitorIdentity, extra: true } },
    { ...base, usageMonitorIdentity: identity.applicationMetadata("development") },
    { ...manifest("development"), usageMonitorDistribution: {} },
  ]) await assert.rejects(packaged(value), { code: "electron_shell_electron_configuration_invalid" });
  assert.equal((await packaged(manifest("development"))).identity.profile, "development");
});

test("synchronous packaged metadata supports pre-ready path selection", () => {
  const value = manifest("stable");
  const selected = readApplicationPackageSync({
    app: { isPackaged: true, getAppPath: () => "C:\\application\\app.asar" },
    readManifest: () => Buffer.from(JSON.stringify(value)),
  });
  assert.equal(selected.identity.profile, "stable");
  assert.throws(() => readApplicationPackageSync({
    app: { isPackaged: true, getAppPath: () => "C:\\application\\app.asar" },
    readManifest: async () => Buffer.from(JSON.stringify(value)),
  }), { code: "electron_shell_electron_configuration_invalid" });
});

test("profile paths pin before separate protected directory preparation", () => {
  const calls = [];
  const selectedPaths = { appData };
  const existingDirectories = new Set([appData]);
  const app = { getPath: (name) => selectedPaths[name] ?? appData, isReady: () => false,
    setPath: (name, path) => {
      if (!existingDirectories.has(path)) throw new Error("Electron setPath directory does not exist");
      calls.push(["set", name, path]);
      selectedPaths[name] = path;
    } };
  const expected = applicationProfilePaths({ appData, profile: "stable", platform: "win32" });
  assert.throws(() => pinApplicationProfilePaths({ app, platform: "win32", profile: "stable" }),
    /directory does not exist/);
  assert.deepEqual(calls, []);
  existingDirectories.add(expected.userData);
  existingDirectories.add(expected.sessionData);
  const result = pinApplicationProfilePaths({ app, platform: "win32", profile: "stable" });
  assert.deepEqual(result, expected);
  assert.deepEqual(calls, [["set", "userData", result.userData],
    ["set", "sessionData", result.sessionData]]);
  prepareApplicationProfileDirectories({ app, appData, profile: "stable", platform: "win32",
    prepareDirectory: (...args) => calls.push(["prepare", ...args]) });
  assert.deepEqual(calls, [["set", "userData", result.userData],
    ["set", "sessionData", result.sessionData], ["prepare", result.userData, "state"],
    ["prepare", result.sessionData, "session"]]);
  for (const profile of ["..", "stable/../development", "unknown"]) {
    assert.throws(() => applicationProfilePaths({ appData, profile, platform: "win32" }));
  }
  assert.throws(() => pinApplicationProfilePaths({ app: { ...app, isReady: () => true },
    profile: "stable", platform: "win32" }));
  assert.throws(() => prepareApplicationProfileDirectories({ app, appData, profile: "development",
    platform: "win32", prepareDirectory() {} }),
  { code: "electron_shell_electron_configuration_invalid" });
});
