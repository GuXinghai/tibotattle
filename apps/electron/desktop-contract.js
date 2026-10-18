import { DESKTOP_TRAY_DEFAULTS, migrateDesktopTrayPreferences, validateDesktopTrayPreferences } from "./desktop-tray-preferences.js";
import { parseCodexThreadURL } from "./loopback-policy.js";
import { validateWindowBackgroundPatch } from "./desktop-background.js";
import {
  DESKTOP_CODEX_ROOT_MAX,
  createDefaultCodexHomes,
  isValidCodexRootId,
  migrateLegacyCodexHome,
  normalizeCodexHomes,
  normalizePathFreeCodexHomes,
  projectCodexHomesPathFree,
} from "./desktop-codex-roots.js";

/**
 * Closed contract shared by the Electron main process and its preload.
 *
 * The renderer never receives this module.  It only receives the frozen
 * method surface assembled by the sandboxed preload. Keeping the request vocabulary in
 * one small module gives the main process a single place to validate the
 * structured-clone boundary before dispatching an operation.
 */

export const DESKTOP_BRIDGE_VERSION = "v1";
export const DESKTOP_IPC_CHANNEL = "tibotattle:desktop:v1";
export const DESKTOP_SETTINGS_SCHEMA_VERSION = "tibotattle-desktop-settings-v4";
export const DESKTOP_PRE_NUMERIC_SETTINGS_SCHEMA_VERSION = "tibotattle-desktop-settings-v3";
export const DESKTOP_PRE_TRAY_SETTINGS_SCHEMA_VERSION = "tibotattle-desktop-settings-v2";
export const DESKTOP_LEGACY_SETTINGS_SCHEMA_VERSION = "tibotattle-desktop-settings-v1";
export const DESKTOP_LEGACY_LAUNCHER_SETTINGS_SCHEMA_VERSION = "usage-monitor-launcher-settings-v1";
// Internal, non-serialized marker used by the storage adapter to tell the
// store that a legacy record was decoded and must be atomically rewritten as
// v2.  Symbols cannot cross JSON or the renderer bridge.
export const DESKTOP_SETTINGS_LEGACY_MIGRATION_MARKER = Symbol("desktop-settings-legacy-migration");
export const DESKTOP_CODEX_ROOT_LIMIT = DESKTOP_CODEX_ROOT_MAX;

export const DESKTOP_LANGUAGES = Object.freeze([
  "system",
  "en",
  "zh-Hans",
  "es",
]);

// Keep appearance a closed preference.  `system` delegates to the host's
// effective appearance; the other values are the only renderer-visible
// overrides accepted by the Electron shell.
export const DESKTOP_APPEARANCES = Object.freeze([
  "system",
  "light",
  "dark",
]);

// Historical v1-v3 choices, retained exclusively for strict migration validation.
export const DESKTOP_REFRESH_INTERVAL_SECONDS = Object.freeze([
  60,
  300,
  900,
  1800,
]);

export const DESKTOP_REFRESH_MODES = Object.freeze([
  "quick",
  "detailed",
]);

export const DESKTOP_NOTIFICATION_THRESHOLDS = Object.freeze([-1, ...Array.from({ length: 100 }, (_, index) => index + 1)]);
export const DESKTOP_MAX_REFRESH_INTERVAL_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 60_000) * 60;
export function isDesktopRefreshIntervalSeconds(value) {
  return value === -1 || (Number.isSafeInteger(value) && value > 0
    && value % 60 === 0 && value <= DESKTOP_MAX_REFRESH_INTERVAL_SECONDS);
}
export function isDesktopNotificationThreshold(value) {
  return Number.isInteger(value) && (value === -1 || (value >= 1 && value <= 100));
}

export const DESKTOP_SYSTEM_SETTINGS_TARGETS = Object.freeze([
  "startup",
  "notifications",
]);

export const DESKTOP_EXTERNAL_TARGETS = Object.freeze([
  "website",
  "github",
  "x",
]);
export const DESKTOP_APPLICATION_MENUS = Object.freeze(["file", "edit", "view", "window", "help"]);

export const DESKTOP_ACTIONS = Object.freeze([
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

const ACTION_ARGUMENT_KEYS = Object.freeze({
  getSettings: Object.freeze([]),
  getApplicationMenu: Object.freeze([]),
  openApplicationMenu: Object.freeze(["menu", "x", "y"]),
  getCodexHomesForSettings: Object.freeze([]),
  openSettings: Object.freeze([]),
  openTraySettings: Object.freeze([]),
  setTrayPreferences: Object.freeze(["value"]),
  restoreTrayDefaults: Object.freeze([]),
  toggleSidebar: Object.freeze([]),
  chooseCodexHome: Object.freeze([]),
  addCodexHome: Object.freeze([]),
  editCodexHome: Object.freeze(["rootId"]),
  removeCodexHome: Object.freeze(["rootId"]),
  setPrimaryCodexHome: Object.freeze(["rootId"]),
  reorderCodexHomes: Object.freeze(["rootIds"]),
  useDefaultCodexHome: Object.freeze([]),
  setLanguage: Object.freeze(["value"]),
  setAppearance: Object.freeze(["value"]),
  getWindowBackground: Object.freeze([]),
  setWindowBackground: Object.freeze(["value"]),
  chooseWindowBackground: Object.freeze([]),
  restoreWindowBackground: Object.freeze([]),
  setRefreshInterval: Object.freeze(["seconds"]),
  setStartAtLogin: Object.freeze(["enabled"]),
  setNotificationPreferences: Object.freeze(["threshold"]),
  sendTestNotification: Object.freeze([]),
  openSystemSettings: Object.freeze(["target"]),
  openExternal: Object.freeze(["target"]),
  openCodexThread: Object.freeze(["url"]),
  checkForUpdates: Object.freeze([]),
  downloadUpdate: Object.freeze([]),
  installUpdateAndRestart: Object.freeze([]),
  setAutomaticDownload: Object.freeze(["enabled"]),
  openDashboardInBrowser: Object.freeze([]),
  showDiagnostics: Object.freeze([]),
  revealLocalData: Object.freeze([]),
  getRefreshStatus: Object.freeze([]),
  refreshStarted: Object.freeze(["mode"]),
  refreshHeartbeat: Object.freeze(["lease"]),
  refreshSettled: Object.freeze(["lease"]),
});

const DEFAULT_NOTIFICATIONS = Object.freeze({
  enabled: false,
  threshold: -1,
});

export const DESKTOP_DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
  codexHomes: createDefaultCodexHomes(),
  language: "system",
  appearance: "system",
  refreshIntervalSeconds: 300,
  startAtLogin: false,
  notifications: DEFAULT_NOTIFICATIONS,
  sidebarCollapsed: false,
  tray: DESKTOP_TRAY_DEFAULTS,
});

function hasExactKeys(value, expectedKeys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(value, key));
}

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertPlainRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function assertExactKeys(value, expectedKeys, label) {
  assertPlainRecord(value, label);
  if (!hasExactKeys(value, expectedKeys)) {
    throw new TypeError(`${label} has unexpected keys`);
  }
  return value;
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} is invalid`);
  return value;
}

function assertSeconds(value) {
  if (!isDesktopRefreshIntervalSeconds(value)) {
    throw new TypeError("seconds is invalid");
  }
  return value;
}

function assertRefreshLease(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("lease is invalid");
  }
  return value;
}

function assertRootId(value, label) {
  if (!isValidCodexRootId(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function assertRootIds(value) {
  if (!Array.isArray(value)
      || value.length < 1
      || value.length > DESKTOP_CODEX_ROOT_LIMIT
      || value.some((rootId) => !isValidCodexRootId(rootId))) {
    throw new TypeError("rootIds is invalid");
  }
  return value;
}

/**
 * Validate and return a frozen request envelope.  The envelope is deliberately
 * `{ action, args }` rather than an open-ended command object: both the action
 * and the exact argument keys are authenticated at the main-process boundary.
 */
export function validateDesktopRequest(request) {
  assertExactKeys(request, ["action", "args"], "request");
  const action = assertEnum(request.action, DESKTOP_ACTIONS, "action");
  const expectedKeys = ACTION_ARGUMENT_KEYS[action];
  const args = assertExactKeys(request.args, expectedKeys, "args");

  switch (action) {
    case "openApplicationMenu":
      assertEnum(args.menu, DESKTOP_APPLICATION_MENUS, "menu");
      for (const coordinate of [args.x, args.y]) {
        if (!Number.isInteger(coordinate) || coordinate < 0 || coordinate > 16384) throw new TypeError("menu position is invalid");
      }
      break;
    case "setWindowBackground":
      validateWindowBackgroundPatch(args.value);
      break;
    case "setTrayPreferences":
      validateDesktopTrayPreferences(args.value);
      break;
    case "setLanguage":
      assertEnum(args.value, DESKTOP_LANGUAGES, "value");
      break;
    case "setAppearance":
      assertEnum(args.value, DESKTOP_APPEARANCES, "value");
      break;
    case "setRefreshInterval":
      assertSeconds(args.seconds);
      break;
    case "setStartAtLogin":
    case "setAutomaticDownload":
      assertBoolean(args.enabled, "enabled");
      break;
    case "setNotificationPreferences":
      if (!isDesktopNotificationThreshold(args.threshold)) throw new TypeError("threshold is invalid");
      break;
    case "openSystemSettings":
      assertEnum(args.target, DESKTOP_SYSTEM_SETTINGS_TARGETS, "target");
      break;
    case "openExternal":
      assertEnum(args.target, DESKTOP_EXTERNAL_TARGETS, "target");
      break;
    case "openCodexThread":
      if (parseCodexThreadURL(args.url) === null) {
        throw new TypeError("url is invalid");
      }
      break;
    case "editCodexHome":
    case "removeCodexHome":
    case "setPrimaryCodexHome":
      assertRootId(args.rootId, "rootId");
      break;
    case "reorderCodexHomes":
      assertRootIds(args.rootIds);
      break;
    case "refreshStarted":
      assertEnum(args.mode, DESKTOP_REFRESH_MODES, "mode");
      break;
    case "refreshHeartbeat":
    case "refreshSettled":
      assertRefreshLease(args.lease);
      break;
    default:
      break;
  }

  return Object.freeze({
    action,
    args: Object.freeze({ ...args, ...(action === "setTrayPreferences" ? { value: validateDesktopTrayPreferences(args.value) } : {}) }),
  });
}

export function createDesktopRequest(action, args = {}) {
  return validateDesktopRequest({ action, args });
}

const SETTINGS_KEYS = Object.freeze([
  "schemaVersion",
  "codexHomes",
  "language",
  "appearance",
  "refreshIntervalSeconds",
  "startAtLogin",
  "notifications",
  "sidebarCollapsed",
  "tray",
]);

const LEGACY_SETTINGS_BASE_KEYS = Object.freeze([
  "schemaVersion",
  "codexHome",
  "language",
  "refreshIntervalSeconds",
  "startAtLogin",
  "notifications",
]);

const LEGACY_SETTINGS_SCHEMA_VERSIONS = new Set([
  DESKTOP_LEGACY_SETTINGS_SCHEMA_VERSION,
  DESKTOP_LEGACY_LAUNCHER_SETTINGS_SCHEMA_VERSION,
]);

function validateSettingsScalarFields(snapshot) {
  assertEnum(snapshot.language, DESKTOP_LANGUAGES, "language");
  assertEnum(snapshot.appearance, DESKTOP_APPEARANCES, "appearance");
  assertSeconds(snapshot.refreshIntervalSeconds);
  assertBoolean(snapshot.startAtLogin, "startAtLogin");
  assertExactKeys(snapshot.notifications, ["enabled", "threshold"], "notifications");
  assertBoolean(snapshot.notifications.enabled, "notifications.enabled");
  if (!isDesktopNotificationThreshold(snapshot.notifications.threshold)
      || snapshot.notifications.enabled !== (snapshot.notifications.threshold !== -1)) {
    throw new TypeError("notifications.threshold is invalid");
  }
  return snapshot.sidebarCollapsed === undefined
    ? false
    : assertBoolean(snapshot.sidebarCollapsed, "sidebarCollapsed");
}

/**
 * Validate the persisted v4 settings schema with a versioned tray preference.  This does not resolve or
 * inspect paths; path policy belongs to the injected main-process picker and
 * platform validator.  A missing custom path therefore remains valid so its
 * configured root can report partial/LKG coverage after reload.
 */
export function validateDesktopSettingsSnapshot(snapshot) {
  assertPlainRecord(snapshot, "settings");
  if (!hasExactKeys(snapshot, SETTINGS_KEYS)) {
    throw new TypeError("settings has unexpected keys");
  }
  if (snapshot.schemaVersion !== DESKTOP_SETTINGS_SCHEMA_VERSION) {
    throw new TypeError("settings schemaVersion is invalid");
  }
  const codexHomes = normalizeCodexHomes(snapshot.codexHomes);
  const sidebarCollapsed = validateSettingsScalarFields(snapshot);
  return Object.freeze({
    schemaVersion: snapshot.schemaVersion,
    codexHomes,
    language: snapshot.language,
    appearance: snapshot.appearance,
    refreshIntervalSeconds: snapshot.refreshIntervalSeconds,
    startAtLogin: snapshot.startAtLogin,
    notifications: Object.freeze({ ...snapshot.notifications }),
    sidebarCollapsed,
    tray: validateDesktopTrayPreferences(snapshot.tray),
  });
}

/** Validate the generic path-free settings projection returned to a dashboard. */
export function validateDesktopSettingsProjection(snapshot) {
  assertPlainRecord(snapshot, "settings");
  if (!hasExactKeys(snapshot, SETTINGS_KEYS)) {
    throw new TypeError("settings has unexpected keys");
  }
  if (snapshot.schemaVersion !== DESKTOP_SETTINGS_SCHEMA_VERSION) {
    throw new TypeError("settings schemaVersion is invalid");
  }
  const codexHomes = normalizePathFreeCodexHomes(snapshot.codexHomes);
  const sidebarCollapsed = validateSettingsScalarFields(snapshot);
  return Object.freeze({
    schemaVersion: snapshot.schemaVersion,
    codexHomes,
    language: snapshot.language,
    appearance: snapshot.appearance,
    refreshIntervalSeconds: snapshot.refreshIntervalSeconds,
    startAtLogin: snapshot.startAtLogin,
    notifications: Object.freeze({ ...snapshot.notifications }),
    sidebarCollapsed,
    tray: validateDesktopTrayPreferences(snapshot.tray),
  });
}

/** Return a dashboard-safe copy containing no custom root path values. */
export function projectDesktopSettingsPathFree(snapshot) {
  const validated = validateDesktopSettingsSnapshot(snapshot);
  return validateDesktopSettingsProjection({
    schemaVersion: validated.schemaVersion,
    codexHomes: projectCodexHomesPathFree(validated.codexHomes),
    language: validated.language,
    appearance: validated.appearance,
    refreshIntervalSeconds: validated.refreshIntervalSeconds,
    startAtLogin: validated.startAtLogin,
    notifications: { ...validated.notifications },
    sidebarCollapsed: validated.sidebarCollapsed,
    tray: validated.tray,
  });
}

export const pathFreeDesktopSettingsProjection = projectDesktopSettingsPathFree;

function isLegacySettingsShape(snapshot) {
  if (!isPlainRecord(snapshot)
      || !LEGACY_SETTINGS_SCHEMA_VERSIONS.has(snapshot.schemaVersion)) {
    return false;
  }
  const actualKeys = Reflect.ownKeys(snapshot);
  if (actualKeys.length === 2
      && Object.hasOwn(snapshot, "schemaVersion")
      && Object.hasOwn(snapshot, "codexHome")) {
    return true;
  }
  const hasAppearance = Object.hasOwn(snapshot, "appearance");
  const hasSidebarCollapsed = Object.hasOwn(snapshot, "sidebarCollapsed");
  const hasTray = Object.hasOwn(snapshot, "tray");
  const hasMenuBar = Object.hasOwn(snapshot, "menuBarDisplayMode");
  const expected = [
    ...LEGACY_SETTINGS_BASE_KEYS,
    ...(hasAppearance ? ["appearance"] : []),
    ...(hasSidebarCollapsed ? ["sidebarCollapsed"] : []),
    ...(hasTray ? ["tray"] : []),
    ...(hasMenuBar ? ["menuBarDisplayMode"] : []),
  ];
  return actualKeys.length === expected.length
    && expected.every((key) => Object.hasOwn(snapshot, key));
}

/**
 * Migrate legacy root, presentation, and notification choices forward to v4. `idFactory` is injected by
 * the main process so IDs are opaque and testable; successful store loading
 * persists the result, making the generated ID stable across later reloads.
 * Both the historic Electron object form and the native launcher's scalar
 * path form are accepted for a bounded compatibility window.
 */
function migrateLegacyNotificationPreferences(value) {
  assertExactKeys(value, ["enabled", "threshold"], "legacy notifications");
  assertBoolean(value.enabled, "legacy notifications.enabled");
  assertEnum(value.threshold, ["off", "ninety", "eighty_and_ninety"], "legacy notifications.threshold");
  const threshold = value.enabled && value.threshold !== "off" ? 90 : -1;
  return { enabled: threshold !== -1, threshold };
}

export function migrateDesktopSettingsSnapshot(snapshot, { idFactory } = {}) {
  if (isPlainRecord(snapshot) && [DESKTOP_PRE_TRAY_SETTINGS_SCHEMA_VERSION, DESKTOP_PRE_NUMERIC_SETTINGS_SCHEMA_VERSION].includes(snapshot.schemaVersion)) {
    const expected = snapshot.schemaVersion === DESKTOP_PRE_TRAY_SETTINGS_SCHEMA_VERSION
      ? SETTINGS_KEYS.filter((key) => (key !== "tray" && key !== "sidebarCollapsed") || Object.hasOwn(snapshot, key)) : SETTINGS_KEYS;
    if (!hasExactKeys(snapshot, expected)) throw new TypeError("legacy settings has unexpected keys");
    if (!DESKTOP_REFRESH_INTERVAL_SECONDS.includes(snapshot.refreshIntervalSeconds)) throw new TypeError("legacy seconds is invalid");
    return validateDesktopSettingsSnapshot({ ...snapshot, schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
      notifications: migrateLegacyNotificationPreferences(snapshot.notifications),
      sidebarCollapsed: snapshot.sidebarCollapsed ?? false, tray: migrateDesktopTrayPreferences(snapshot.tray) });
  }
  if (!isLegacySettingsShape(snapshot)) return snapshot;
  if (snapshot.refreshIntervalSeconds !== undefined
      && !DESKTOP_REFRESH_INTERVAL_SECONDS.includes(snapshot.refreshIntervalSeconds)) {
    throw new TypeError("legacy seconds is invalid");
  }
  const codexHomes = migrateLegacyCodexHome(snapshot.codexHome, { idFactory });
  const appearance = snapshot.appearance === undefined
    ? DESKTOP_DEFAULT_SETTINGS.appearance
    : snapshot.appearance;
  const sidebarCollapsed = snapshot.sidebarCollapsed === undefined
    ? false
    : snapshot.sidebarCollapsed;
  return {
    schemaVersion: DESKTOP_SETTINGS_SCHEMA_VERSION,
    codexHomes,
    language: snapshot.language === undefined
      ? DESKTOP_DEFAULT_SETTINGS.language
      : snapshot.language,
    appearance,
    refreshIntervalSeconds: snapshot.refreshIntervalSeconds === undefined
      ? DESKTOP_DEFAULT_SETTINGS.refreshIntervalSeconds
      : snapshot.refreshIntervalSeconds,
    startAtLogin: snapshot.startAtLogin === undefined
      ? DESKTOP_DEFAULT_SETTINGS.startAtLogin
      : snapshot.startAtLogin,
    notifications: snapshot.notifications === undefined
      ? { ...DESKTOP_DEFAULT_SETTINGS.notifications }
      : migrateLegacyNotificationPreferences(snapshot.notifications),
    sidebarCollapsed,
    tray: migrateDesktopTrayPreferences(snapshot.tray ?? snapshot.menuBarDisplayMode),
  };
}

/** Migrate a standalone legacy scalar/object codexHome record. */
export function migrateLegacyDesktopSettingsSnapshot(snapshot, options = {}) {
  return migrateDesktopSettingsSnapshot(snapshot, options);
}

export const DESKTOP_ACTION_ARGUMENT_KEYS = ACTION_ARGUMENT_KEYS;
