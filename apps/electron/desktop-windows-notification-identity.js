import { win32 } from "node:path";

import applicationIdentity from "../../config/application-identity.cjs";
import brand from "../../config/product-brand.cjs";

import distribution from "../../config/electron-production-distribution.cjs";

const WINDOWS_NOTIFICATION_SHORTCUT_LEAF = `${brand.displayName}.lnk`;
const WINDOWS_NOTIFICATION_START_MENU_SEGMENTS = Object.freeze([
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  WINDOWS_NOTIFICATION_SHORTCUT_LEAF,
]);

function isPlainRecord(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizedClsid(value) {
  if (typeof value !== "string") return null;
  const plain = value.replace(/^\{(.*)\}$/u, "$1");
  return /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(plain)
    ? plain.toLowerCase() : null;
}

function configuredIdentity(identity) {
  if (!isPlainRecord(identity)
      || Reflect.ownKeys(identity).length !== 2
      || typeof identity.appUserModelId !== "string"
      || identity.appUserModelId.length === 0
      || normalizedClsid(identity.toastActivatorClsid) === null) {
    return null;
  }
  return identity;
}

function productionIdentity() {
  return configuredIdentity({
    appUserModelId: distribution.PRODUCTION_ELECTRON_APP_ID,
    toastActivatorClsid: distribution.PRODUCTION_ELECTRON_WINDOWS_TOAST_ACTIVATOR_CLSID,
  });
}

function normalizedWindowsPath(value, pathApi) {
  if (typeof value !== "string" || value.length === 0 || !pathApi.isAbsolute(value)) {
    return null;
  }
  return pathApi.normalize(value).toLowerCase();
}

/**
 * Configure Windows toast delivery only after verifying the real installed
 * Start Menu entry. This proves the in-process AppUserModelID is bound to the
 * executable the installer registered; it does not replace signed-installer
 * verification, which remains a release qualification responsibility.
 *
 * Electron 43 owns the toast registration. Its fixed CLSID is set only after
 * the Start Menu target, AppUserModelID and any existing activator are verified.
 * An absent installer activator is initialized with the fixed value. A mismatch
 * is refused; this helper never repairs a shortcut or COM registration.
 */
export function prepareWindowsNotificationIdentity({
  app,
  shell,
  platform = process.platform,
  identity = productionIdentity(),
  applicationProfile = null,
  pathApi = win32,
} = {}) {
  try {
    if (platform !== "win32" || app?.isPackaged !== true
        || applicationIdentity.validateApplicationMetadata(applicationProfile).profile !== "stable"
        || typeof app.getPath !== "function"
        || typeof app.setAppUserModelId !== "function"
        || typeof app.setToastActivatorCLSID !== "function"
        || typeof shell?.readShortcutLink !== "function") {
      return false;
    }
  } catch {
    return false;
  }
  const selectedIdentity = configuredIdentity(identity);
  if (selectedIdentity === null) return false;

  let shortcut;
  let expectedTarget;
  try {
    const appData = app.getPath("appData");
    const target = app.getPath("exe");
    if (normalizedWindowsPath(appData, pathApi) === null) return false;
    expectedTarget = normalizedWindowsPath(target, pathApi);
    if (expectedTarget === null) return false;
    shortcut = shell.readShortcutLink(pathApi.join(
      appData,
      ...WINDOWS_NOTIFICATION_START_MENU_SEGMENTS,
    ));
  } catch {
    return false;
  }
  if (!isPlainRecord(shortcut)
      || normalizedWindowsPath(shortcut.target, pathApi) !== expectedTarget
      || shortcut.appUserModelId !== selectedIdentity.appUserModelId
      // NSIS may leave this property absent before the first verified launch.
      // Electron must not adopt a conflicting existing activator when probing.
      || (shortcut.toastActivatorClsid !== undefined
        && normalizedClsid(shortcut.toastActivatorClsid) !== normalizedClsid(selectedIdentity.toastActivatorClsid))) {
    return false;
  }

  try {
    app.setAppUserModelId(selectedIdentity.appUserModelId);
    app.setToastActivatorCLSID(selectedIdentity.toastActivatorClsid);
  } catch {
    return false;
  }
  return true;
}
