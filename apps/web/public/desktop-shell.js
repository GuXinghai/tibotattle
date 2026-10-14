/**
 * Small Electron-only bridge for controls that belong to the desktop shell,
 * not to the hosted dashboard. It intentionally has no filesystem or URL
 * input: Settings is one fixed local route/bridge action and dashboard
 * sections are a fixed set of hashes.
 */

import {
  isElectronDashboard,
  resolveDesktopAppearance,
} from "./desktop-appearance.js";

const ELECTRON_API_VERSION = "v1";
const LANGUAGE_VALUES = new Set(["system", "en", "zh-Hans", "es"]);
const LANGUAGE_PICKER_VALUES = Object.freeze({
  system: "system",
  en: "en-US",
  "zh-Hans": "zh-Hans",
  es: "es",
});
const DESKTOP_LANGUAGE_BY_PICKER_VALUE = Object.freeze(
  Object.fromEntries(
    Object.entries(LANGUAGE_PICKER_VALUES).map(([desktop, picker]) => [picker, desktop]),
  ),
);
const DASHBOARD_SECTION_HASHES = Object.freeze({
  overview: "#overview",
  usage: "#usage",
  allowance: "#allowance",
  performance: "#performance",
});
const mountedDocuments = new WeakMap();

/**
 * Navigate to one of the dashboard's evidence views from a native menu or
 * tray action. The main process validates the same fixed values before this
 * command reaches the page, and this local mapping keeps the renderer from
 * ever accepting an arbitrary selector, hash, path, or URL.
 */
export function navigateToDashboardSection(_documentRef, windowRef, section) {
  const hash = DASHBOARD_SECTION_HASHES[section];
  const location = windowRef?.location;
  if (typeof hash !== "string" || !location || typeof location !== "object") {
    return false;
  }
  if (location.hash !== hash) location.hash = hash;
  return true;
}

function openSettings(windowRef) {
  const bridge = windowRef?.tibotattleDesktop;
  if (bridge?.version === ELECTRON_API_VERSION
      && typeof bridge.openSettings === "function") {
    try {
      // Keep the renderer action fire-and-forget, but consume a rejected IPC
      // promise. A closed/restarting shell must not turn a button click into
      // an unhandled rejection that makes the control look dead.
      void Promise.resolve(bridge.openSettings()).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function applySidebarState(documentRef, collapsed) {
  if (typeof collapsed !== "boolean") return false;
  const shell = documentRef?.querySelector?.(".dashboard-shell");
  const sidebar = documentRef?.querySelector?.(".dashboard-sidebar");
  if (!shell) return false;
  shell.classList?.toggle?.("sidebar-collapsed", collapsed);
  if (sidebar) {
    sidebar.setAttribute?.("aria-hidden", collapsed ? "true" : "false");
    if ("inert" in sidebar) sidebar.inert = collapsed;
    else if (collapsed) sidebar.setAttribute?.("inert", "");
    else sidebar.removeAttribute?.("inert");
  }
  if (collapsed && sidebar && documentRef.activeElement
      && sidebar.contains?.(documentRef.activeElement)) {
    documentRef.querySelector?.("#main")?.focus?.({ preventScroll: true });
  }
  return true;
}

function readPersistedSettings(bridge, applyLanguage, applySidebar, applyAppearance) {
  if (typeof bridge?.getSettings !== "function") return;
  void bridge.getSettings().then((state) => {
    const candidate = state?.settings?.language ?? state?.language;
    applyLanguage(candidate);
    const sidebarCollapsed = state?.settings?.sidebarCollapsed ?? state?.sidebarCollapsed;
    applySidebar(sidebarCollapsed);
    const appearance = state?.settings?.appearance ?? state?.appearance;
    applyAppearance(appearance);
  }).catch(() => {});
}

function dispatchAutomaticRefresh(windowRef, mode) {
  if (mode !== "quick" && mode !== "detailed") return false;
  const CustomEventConstructor = windowRef?.CustomEvent;
  if (typeof CustomEventConstructor !== "function"
      || typeof windowRef?.dispatchEvent !== "function") return false;
  windowRef.dispatchEvent(new CustomEventConstructor(
    "tibotattle:automatic-refresh",
    { detail: Object.freeze({ mode }) },
  ));
  return true;
}

function dispatchAppearanceOverride(windowRef, command) {
  if (![
    "system",
    "light",
    "dark",
  ].includes(command?.preference)
      || !["light", "dark"].includes(command?.resolvedTheme)) return false;
  const CustomEventConstructor = windowRef?.CustomEvent;
  if (typeof CustomEventConstructor !== "function"
      || typeof windowRef?.dispatchEvent !== "function") return false;
  windowRef.dispatchEvent(new CustomEventConstructor(
    "tibotattle:appearance-override",
    {
      detail: Object.freeze({
        preference: command.preference,
        resolvedTheme: command.resolvedTheme,
      }),
    },
  ));
  return true;
}

function installCommandBridge(documentRef, windowRef, applyLanguage, applySidebar) {
  const bridge = windowRef?.tibotattleDesktop;
  if (bridge?.version !== ELECTRON_API_VERSION
      || typeof bridge.onCommand !== "function") return () => {};
  const onCommand = (command) => {
    if (!command || typeof command !== "object") return;
    if (command.command === "refresh") {
      documentRef.querySelector?.("#refresh-button")?.click?.();
      return;
    }
    if (command.command === "automaticRefresh") {
      if (Reflect.ownKeys(command).length !== 2
          || !Object.hasOwn(command, "mode")) return;
      dispatchAutomaticRefresh(windowRef, command.mode);
      return;
    }
    if (command.command === "dashboardSection") {
      if (Reflect.ownKeys(command).length !== 2
          || !Object.hasOwn(command, "section")) return;
      navigateToDashboardSection(documentRef, windowRef, command.section);
      return;
    }
    if (command.command === "sidebar") {
      applySidebar(command.collapsed);
      return;
    }
    if (command.command === "appearance") {
      dispatchAppearanceOverride(windowRef, command);
      return;
    }
    if (command.command !== "language" || !LANGUAGE_VALUES.has(command.value)) return;
    applyLanguage(command.value);
  };
  const unsubscribe = bridge.onCommand(onCommand);
  return typeof unsubscribe === "function" ? unsubscribe : () => {};
}

export function mountDesktopShell({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
} = {}) {
  if (!isElectronDashboard(documentRef, windowRef)) {
    return Object.freeze({ teardown() {} });
  }
  const existing = mountedDocuments.get(documentRef);
  if (existing) return existing;
  const settingsButton = documentRef.querySelector?.("#electron-settings-button");
  if (!settingsButton) return Object.freeze({ teardown() {} });
  settingsButton.hidden = false;
  const onSettings = () => openSettings(windowRef);
  const bridge = windowRef?.tibotattleDesktop;
  const picker = documentRef.querySelector?.("[data-language-picker]");
  const applySidebar = (collapsed) => applySidebarState(documentRef, collapsed);
  const applyAppearance = (preference) => {
    const resolvedTheme = resolveDesktopAppearance(preference, { windowRef });
    if (resolvedTheme === null) return false;
    return dispatchAppearanceOverride(windowRef, { preference, resolvedTheme });
  };
  let applyingLanguage = false;
  const applyLanguage = (value) => {
    if (!LANGUAGE_VALUES.has(value) || !picker) return;
    applyingLanguage = true;
    try {
      picker.value = LANGUAGE_PICKER_VALUES[value];
      picker.dispatchEvent?.(new Event("change", { bubbles: true }));
    } finally {
      applyingLanguage = false;
    }
  };
  const onLanguageChange = () => {
    if (applyingLanguage || bridge?.version !== ELECTRON_API_VERSION) return;
    const value = DESKTOP_LANGUAGE_BY_PICKER_VALUE[picker?.value];
    if (!LANGUAGE_VALUES.has(value) || typeof bridge.setLanguage !== "function") return;
    try {
      void Promise.resolve(bridge.setLanguage(value)).catch(() => {});
    } catch {
      // A renderer control must not surface bridge implementation errors.
    }
  };
  settingsButton.addEventListener("click", onSettings);
  picker?.addEventListener?.("change", onLanguageChange);
  readPersistedSettings(bridge, applyLanguage, applySidebar, applyAppearance);
  const unsubscribeCommand = installCommandBridge(
    documentRef,
    windowRef,
    applyLanguage,
    applySidebar,
  );
  const mounted = Object.freeze({
    teardown() {
      settingsButton.removeEventListener?.("click", onSettings);
      picker?.removeEventListener?.("change", onLanguageChange);
      unsubscribeCommand();
      mountedDocuments.delete(documentRef);
    },
  });
  mountedDocuments.set(documentRef, mounted);
  return mounted;
}

function autoMountDesktopShell() {
  if (typeof document === "undefined") return;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mountDesktopShell(), { once: true });
  } else {
    mountDesktopShell();
  }
}

autoMountDesktopShell();
