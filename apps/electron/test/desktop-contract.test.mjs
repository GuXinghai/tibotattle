import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_ACTIONS,
  DESKTOP_ACTION_ARGUMENT_KEYS,
  DESKTOP_DEFAULT_SETTINGS,
  DESKTOP_EXTERNAL_TARGETS,
  DESKTOP_IPC_CHANNEL,
  DESKTOP_LANGUAGES,
  DESKTOP_NOTIFICATION_THRESHOLDS,
  DESKTOP_REFRESH_INTERVAL_SECONDS,
  DESKTOP_REFRESH_MODES,
  DESKTOP_SETTINGS_SCHEMA_VERSION,
  DESKTOP_MAX_REFRESH_INTERVAL_SECONDS,
  DESKTOP_SYSTEM_SETTINGS_TARGETS,
  createDesktopRequest,
  migrateDesktopSettingsSnapshot,
  projectDesktopSettingsPathFree,
  validateDesktopRequest,
  validateDesktopSettingsSnapshot,
} from "../desktop-contract.js";

test("desktop contract freezes the exact bridge action and enum vocabulary", () => {
  assert.equal(DESKTOP_IPC_CHANNEL, "usagemonitor:desktop:v1");
  assert.deepEqual(DESKTOP_ACTIONS, [
    "getSettings",
    "getApplicationMenu",
    "openApplicationMenu",
    "getCodexHomesForSettings",
    "openSettings",
    "openTraySettings",
    "setTrayPreferences",
    "restoreTrayDefaults",
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
    "getWindowBackground",
    "setWindowBackground",
    "chooseWindowBackground",
    "restoreWindowBackground",
    "setRefreshInterval",
    "setRefreshPaused",
    "setStartAtLogin",
    "setNotificationPreferences",
    "sendTestNotification",
    "openSystemSettings",
    "openExternal",
    "openCodexThread",
    "checkForUpdates",
    "downloadUpdate",
    "installUpdateAndRestart",
    "setAutomaticDownload",
    "openDashboardInBrowser",
    "showDiagnostics",
    "revealLocalData",
    "getRefreshStatus",
    "refreshStarted",
    "refreshHeartbeat",
    "refreshSettled",
  ]);
  assert.deepEqual(DESKTOP_LANGUAGES, ["system", "en", "zh-Hans", "es"]);
  assert.deepEqual(DESKTOP_REFRESH_INTERVAL_SECONDS, [60, 300, 900, 1800]);
  assert.deepEqual(DESKTOP_REFRESH_MODES, ["quick", "detailed"]);
  assert.deepEqual(DESKTOP_NOTIFICATION_THRESHOLDS, [-1, ...Array.from({ length: 100 }, (_, index) => index + 1)]);
  assert.deepEqual(DESKTOP_SYSTEM_SETTINGS_TARGETS, ["startup", "notifications"]);
  assert.deepEqual(DESKTOP_EXTERNAL_TARGETS, ["website", "github", "x"]);
  assert.equal(Object.isFrozen(DESKTOP_ACTIONS), true);
  assert.equal(Object.isFrozen(DESKTOP_ACTION_ARGUMENT_KEYS), true);
  assert.equal(Object.isFrozen(DESKTOP_DEFAULT_SETTINGS), true);
  assert.equal(Object.isFrozen(DESKTOP_DEFAULT_SETTINGS.codexHomes), true);
  assert.equal(Object.isFrozen(DESKTOP_DEFAULT_SETTINGS.notifications), true);
});

test("refresh pause has a closed boolean contract and requires the current setting field", () => {
  for (const paused of [true, false]) assert.equal(createDesktopRequest("setRefreshPaused", { paused }).args.paused, paused);
  for (const paused of [0, 1, "true", null, undefined]) assert.throws(() => createDesktopRequest("setRefreshPaused", { paused }), TypeError);
  assert.throws(() => createDesktopRequest("setRefreshPaused", { paused: true, extra: true }), TypeError);
  const missing = { ...DESKTOP_DEFAULT_SETTINGS }; delete missing.refreshPaused;
  assert.throws(() => validateDesktopSettingsSnapshot(missing), TypeError);
  assert.throws(() => validateDesktopSettingsSnapshot({ ...DESKTOP_DEFAULT_SETTINGS, refreshPaused: 1 }), TypeError);
});

test("application menu requests accept only fixed menus and bounded integer coordinates", () => {
  assert.deepEqual(createDesktopRequest("getApplicationMenu"), { action: "getApplicationMenu", args: {} });
  for (const menu of ["file", "edit", "view", "window", "help"]) {
    const args = { menu, x: 0, y: 40 };
    assert.deepEqual(createDesktopRequest("openApplicationMenu", args).args, args);
  }
  for (const args of [
    { menu: "quit", x: 0, y: 40 }, { menu: "file", x: -1, y: 40 },
    { menu: "file", x: 1.5, y: 40 }, { menu: "file", x: 1, y: Infinity },
    { menu: "file", x: 16385, y: 40 }, { menu: "file", x: 0, y: 40, action: "quit" },
  ]) assert.throws(() => createDesktopRequest("openApplicationMenu", args), TypeError);
  assert.throws(() => createDesktopRequest("getApplicationMenu", { menu: "file" }), TypeError);
});

test("request validation accepts exact envelopes and freezes the result", () => {
  const request = createDesktopRequest("setNotificationPreferences", {
    threshold: 85,
  });
  assert.deepEqual(request, {
    action: "setNotificationPreferences",
    args: {
      threshold: 85,
    },
  });
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.args), true);

  for (const action of [
    "getSettings",
    "getCodexHomesForSettings",
    "openSettings",
    "toggleSidebar",
    "chooseCodexHome",
    "addCodexHome",
    "useDefaultCodexHome",
    "checkForUpdates",
    "downloadUpdate",
    "installUpdateAndRestart",
    "openDashboardInBrowser",
    "showDiagnostics",
    "revealLocalData",
    "getRefreshStatus",
  ]) {
    assert.deepEqual(validateDesktopRequest({ action, args: {} }), { action, args: {} });
  }
  for (const mode of DESKTOP_REFRESH_MODES) {
    assert.deepEqual(
      validateDesktopRequest({ action: "refreshStarted", args: { mode } }),
      { action: "refreshStarted", args: { mode } },
    );
  }
  assert.deepEqual(
    validateDesktopRequest({ action: "refreshHeartbeat", args: { lease: 1 } }),
    { action: "refreshHeartbeat", args: { lease: 1 } },
  );
  for (const action of ["setAutomaticDownload"]) {
    for (const enabled of [true, false]) {
      assert.deepEqual(
        validateDesktopRequest({ action, args: { enabled } }),
        { action, args: { enabled } },
      );
    }
  }
  assert.deepEqual(
    validateDesktopRequest({ action: "refreshSettled", args: { lease: 1 } }),
    { action: "refreshSettled", args: { lease: 1 } },
  );
  assert.deepEqual(
    validateDesktopRequest({
      action: "openCodexThread",
      args: {
        url: "codex://threads/11111111-1111-4111-8111-111111111111",
      },
    }),
    {
      action: "openCodexThread",
      args: {
        url: "codex://threads/11111111-1111-4111-8111-111111111111",
      },
    },
  );
  for (const action of ["editCodexHome", "removeCodexHome", "setPrimaryCodexHome"]) {
    assert.deepEqual(
      validateDesktopRequest({
        action,
        args: { rootId: "11111111-1111-4111-8111-111111111111" },
      }),
      { action, args: { rootId: "11111111-1111-4111-8111-111111111111" } },
    );
  }
  assert.deepEqual(
    validateDesktopRequest({
      action: "reorderCodexHomes",
      args: { rootIds: ["11111111-1111-4111-8111-111111111111"] },
    }),
    {
      action: "reorderCodexHomes",
      args: { rootIds: ["11111111-1111-4111-8111-111111111111"] },
    },
  );
});

test("request validation rejects unknown actions, extra keys, malformed values, and prototypes", () => {
  const invalidRequests = [
    { action: "unknown", args: {} },
    { action: "getSettings", args: { extra: true } },
    // Actions removed with community sharing are unknown to the closed contract.
    { action: "getSharingPreference", args: {} },
    { action: "setSharingEnabled", args: { enabled: true } },
    { action: "sharingNoticePresented", args: { index: 1 } },
    { action: "openCommunity", args: {} },
    { action: "openHostedSignIn", args: { authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" } },
    { action: "revealLatestDownload", args: {} },
    { action: "openLatestDownload", args: {} },
    { action: "setAutomaticDownload", args: {} },
    { action: "setAutomaticDownload", args: { enabled: "true" } },
    { action: "downloadUpdate", args: { extra: true } },
    { action: "getSettings", args: {}, extra: true },
    { action: "setLanguage", args: { value: "fr" } },
    { action: "setLanguage", args: { value: "en", extra: true } },
    { action: "setRefreshInterval", args: { seconds: 5 } },
    { action: "setStartAtLogin", args: { enabled: "true" } },
    { action: "setNotificationPreferences", args: { enabled: true, threshold: "90" } },
    { action: "refreshStarted", args: {} },
    { action: "refreshStarted", args: { mode: "full" } },
    { action: "refreshStarted", args: { mode: "quick", extra: true } },
    { action: "refreshHeartbeat", args: {} },
    { action: "refreshHeartbeat", args: { lease: 0 } },
    { action: "refreshHeartbeat", args: { lease: 1, extra: true } },
    { action: "refreshSettled", args: {} },
    { action: "refreshSettled", args: { lease: 0 } },
    { action: "refreshSettled", args: { lease: Number.MAX_SAFE_INTEGER + 1 } },
    { action: "refreshSettled", args: { lease: 1, extra: true } },
    { action: "openSystemSettings", args: { target: "arbitrary" } },
    { action: "openExternal", args: { target: "https://evil.example" } },
    { action: "openCodexThread", args: { url: "codex://threads/not-a-thread" } },
    { action: "openCodexThread", args: { url: "codex://threads/11111111-1111-4111-8111-111111111111?query" } },
    { action: "openCodexThread", args: { url: "codex://user@threads/11111111-1111-4111-8111-111111111111" } },
    { action: "editCodexHome", args: { rootId: "root-a" } },
    { action: "removeCodexHome", args: { rootId: "11111111-1111-4111-8111-111111111111", extra: true } },
    { action: "reorderCodexHomes", args: { rootIds: [] } },
    { action: "openExternal", args: Object.assign(Object.create(null), {
      target: "github",
      extra: "reject",
    }) },
    { action: "getSettings", args: Object.create(null) },
    { action: "getSettings", args: [] },
    null,
  ];
  for (const value of invalidRequests) {
    assert.throws(() => validateDesktopRequest(value), TypeError, JSON.stringify(value));
  }
});

test("settings snapshot validator enforces the exact schema and defaults", () => {
  assert.deepEqual(validateDesktopSettingsSnapshot(DESKTOP_DEFAULT_SETTINGS), {
    schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
    codexHomes: {
      activityRoots: [{
        rootId: "00000000-0000-4000-8000-000000000001",
        kind: "default",
        path: null,
        enabled: true,
      }],
      primaryRootId: "00000000-0000-4000-8000-000000000001",
    },
    language: "system",
    appearance: "system",
    refreshIntervalSeconds: 300,
    refreshPaused: false,
    startAtLogin: false,
    notifications: { enabled: false, threshold: -1 },
    sidebarCollapsed: false,
    tray: DESKTOP_DEFAULT_SETTINGS.tray,
  });

  const valid = validateDesktopSettingsSnapshot({
    ...DESKTOP_DEFAULT_SETTINGS,
    codexHomes: {
      activityRoots: [{
        rootId: "11111111-1111-4111-8111-111111111111",
        kind: "custom",
        path: "C:\\Users\\adam\\.codex",
        enabled: true,
      }],
      primaryRootId: "11111111-1111-4111-8111-111111111111",
    },
    language: "zh-Hans",
    appearance: "dark",
    refreshIntervalSeconds: 1800,
    startAtLogin: true,
    notifications: { enabled: true, threshold: 90 },
  });
  assert.equal(valid.codexHomes.activityRoots[0].kind, "custom");
  assert.equal(Object.isFrozen(valid.notifications), true);

  const prior = {
    schemaVersion: "usagemonitor-desktop-settings-v2",
    codexHomes: DESKTOP_DEFAULT_SETTINGS.codexHomes,
    language: "system", appearance: "system", refreshIntervalSeconds: 300,
    startAtLogin: false, notifications: { enabled: false, threshold: "off" },
  };
  assert.equal(migrateDesktopSettingsSnapshot(prior).sidebarCollapsed, false);
  assert.equal(migrateDesktopSettingsSnapshot(prior).tray.preset, "automatic");
  assert.throws(() => validateDesktopSettingsSnapshot({ ...prior, schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION }), TypeError);


  for (const invalid of [
    { ...DESKTOP_DEFAULT_SETTINGS, schemaVersion: "v2" },
    { ...DESKTOP_DEFAULT_SETTINGS, extra: true },
    { ...DESKTOP_DEFAULT_SETTINGS, codexHomes: {
      activityRoots: [{
        rootId: "00000000-0000-4000-8000-000000000001",
        kind: "default",
        path: "/tmp",
        enabled: true,
      }],
      primaryRootId: "00000000-0000-4000-8000-000000000001",
    } },
    { ...DESKTOP_DEFAULT_SETTINGS, codexHomes: {
      activityRoots: [{
        rootId: "11111111-1111-4111-8111-111111111111",
        kind: "custom",
        path: null,
        enabled: true,
      }],
      primaryRootId: "11111111-1111-4111-8111-111111111111",
    } },
    { ...DESKTOP_DEFAULT_SETTINGS, language: "fr" },
    { ...DESKTOP_DEFAULT_SETTINGS, appearance: "sepia" },
    { ...DESKTOP_DEFAULT_SETTINGS, refreshIntervalSeconds: 1 },
    { ...DESKTOP_DEFAULT_SETTINGS, startAtLogin: 1 },
    { ...DESKTOP_DEFAULT_SETTINGS, notifications: { enabled: false, threshold: "90" } },
    { ...DESKTOP_DEFAULT_SETTINGS, sidebarCollapsed: "false" },
  ]) {
    assert.throws(() => validateDesktopSettingsSnapshot(invalid), TypeError);
  }
});

test("v1 scalar migration creates one stable v2 root and path-free projection", () => {
  const legacy = {
    schemaVersion: "usagemonitor-desktop-settings-v1",
    codexHome: { mode: "custom", path: "C:\\Users\\adam\\.codex" },
    language: "en",
    appearance: "light",
    refreshIntervalSeconds: 900,
    startAtLogin: true,
    notifications: { enabled: false, threshold: "off" },
  };
  const migrated = migrateDesktopSettingsSnapshot(legacy, {
    idFactory: () => "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(migrated.schemaVersion, DESKTOP_SETTINGS_SCHEMA_VERSION);
  assert.equal(migrated.codexHomes.activityRoots[0].rootId, "11111111-1111-4111-8111-111111111111");
  const projected = projectDesktopSettingsPathFree(migrated);
  assert.equal(Object.hasOwn(projected.codexHomes.activityRoots[0], "path"), false);
  assert.equal(JSON.stringify(projected).includes("Users"), false);

  const scalar = migrateDesktopSettingsSnapshot({
    schemaVersion: "usage-monitor-launcher-settings-v1",
    codexHome: "/Users/adam/.codex",
  });
  assert.equal(scalar.schemaVersion, DESKTOP_SETTINGS_SCHEMA_VERSION);
  assert.equal(scalar.language, "system");
  assert.equal(scalar.codexHomes.activityRoots[0].kind, "custom");
});


test("test notification accepts no renderer content", () => {
  assert.deepEqual(createDesktopRequest("sendTestNotification", {}), {
    action: "sendTestNotification", args: {},
  });
  for (const args of [{ body: "text" }, { title: "title" }, { enabled: true }, { url: "https://example.com" }]) {
    assert.throws(() => createDesktopRequest("sendTestNotification", args), TypeError);
  }
});

test("numeric settings reject fractional and unsafe values and migrate legacy choices forward", () => {
  for (const seconds of [-1, 60, 420, DESKTOP_MAX_REFRESH_INTERVAL_SECONDS]) {
    assert.equal(createDesktopRequest("setRefreshInterval", { seconds }).args.seconds, seconds);
  }
  for (const seconds of [0, -60, 61, 60.5, Infinity, Number.MAX_SAFE_INTEGER, "60"]) {
    assert.throws(() => createDesktopRequest("setRefreshInterval", { seconds }), TypeError);
  }
  for (const threshold of [-1, 1, 37, 100]) {
    assert.equal(createDesktopRequest("setNotificationPreferences", { threshold }).args.threshold, threshold);
  }
  for (const threshold of [0, -2, 101, 37.5, NaN, Infinity, "90", "ninety"]) {
    assert.throws(() => createDesktopRequest("setNotificationPreferences", { threshold }), TypeError);
  }
  assert.throws(() => createDesktopRequest("setNotificationPreferences", { enabled: true, threshold: 90 }), TypeError);
  for (const [enabled, mode, expected] of [[false, "ninety", -1], [true, "off", -1], [true, "ninety", 90], [true, "eighty_and_ninety", 90]]) {
    const legacy = { ...DESKTOP_DEFAULT_SETTINGS, schemaVersion: "usagemonitor-desktop-settings-v3", notifications: { enabled, threshold: mode } };
    delete legacy.refreshPaused;
    const migrated = migrateDesktopSettingsSnapshot(legacy);
    assert.equal(migrated.schemaVersion, DESKTOP_SETTINGS_SCHEMA_VERSION);
    assert.deepEqual(migrated.notifications, { enabled: expected !== -1, threshold: expected });
  }
  assert.throws(() => migrateDesktopSettingsSnapshot({ ...DESKTOP_DEFAULT_SETTINGS, schemaVersion: "usagemonitor-desktop-settings-v3", notifications: { enabled: true, threshold: 90 } }), TypeError);
  assert.throws(() => validateDesktopSettingsSnapshot({ ...DESKTOP_DEFAULT_SETTINGS, notifications: { enabled: false, threshold: 90 } }), TypeError);
});
