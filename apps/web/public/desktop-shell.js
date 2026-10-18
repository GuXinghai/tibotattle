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
  settings: "#settings/general",
});
const mountedDocuments = new WeakMap();
const APPLICATION_MENU_IDS = new Set(["file", "edit", "view", "window", "help"]);

// The renderer owns only the compact row and its keyboard entry points. Menu
// commands, translated labels and accelerators stay in the native menu owner.
function mountApplicationTitlebar(documentRef, windowRef, bridge) {
  if (typeof bridge?.getApplicationMenu !== "function"
      || typeof bridge?.openApplicationMenu !== "function"
      || typeof documentRef?.createElement !== "function" || !documentRef.body) {
    return { refresh() {}, setFullscreen() {}, teardown() {} };
  }
  const root = documentRef.documentElement;
  const bar = documentRef.createElement("div");
  bar.className = "desktop-titlebar";
  const menubar = documentRef.createElement("div");
  menubar.className = "desktop-application-menu";
  menubar.setAttribute("role", "menubar");
  bar.append(menubar);
  documentRef.body.prepend(bar);
  root.classList.add("desktop-titlebar-active");
  let disposed = false;
  let generation = 0;
  let menus = [];
  let buttons = [];
  let previousFocus = null;
  let altPressed = false;
  let activePopup = null;
  let nativeFullscreen = false;

  const focusMenu = (index) => {
    buttons.forEach((button, candidate) => { button.tabIndex = candidate === index ? 0 : -1; });
    buttons[index]?.focus?.({ preventScroll: true });
  };
  const leaveMenubar = () => {
    if (previousFocus) previousFocus.focus?.({ preventScroll: true });
    else if (buttons.includes(documentRef.activeElement)) documentRef.activeElement.blur?.();
    previousFocus = null;
  };
  const enterMenubar = (index = 0) => {
    if (!buttons.includes(documentRef.activeElement)) previousFocus = documentRef.activeElement;
    focusMenu(index);
  };
  const openMenu = async (index) => {
    if (disposed || activePopup || !buttons[index]) return;
    enterMenubar(index);
    const button = buttons[index];
    const rect = button.getBoundingClientRect();
    const popup = {};
    activePopup = popup;
    button.setAttribute("aria-expanded", "true");
    try {
      await bridge.openApplicationMenu({
        menu: menus[index].id,
        x: Math.round(rect.left),
        y: Math.round(rect.bottom),
      });
    } catch {
      // A closing window or unavailable bridge leaves a usable keyboard row.
    } finally {
      if (activePopup === popup) activePopup = null;
      if (!disposed) button.setAttribute("aria-expanded", "false");
    }
  };
  const displayLabel = (label) => label.replace(/\(&([^&])\)/gu, "").replace(/&&|&/gu, (part) => part === "&&" ? "&" : "").trim();
  const refresh = async () => {
    if (disposed) return;
    const requested = ++generation;
    try {
      const state = await bridge.getApplicationMenu();
      if (disposed || requested !== generation || !Array.isArray(state?.menus)) return;
      if (typeof state.fullscreen === "boolean") setFullscreen(state.fullscreen);
      const next = state.menus;
      if (next.length !== APPLICATION_MENU_IDS.size
          || new Set(next.map((menu) => menu?.id)).size !== APPLICATION_MENU_IDS.size
          || next.some((menu) => !APPLICATION_MENU_IDS.has(menu?.id)
            || typeof menu.label !== "string" || !displayLabel(menu.label))) return;
      const focusedId = menus[buttons.indexOf(documentRef.activeElement)]?.id;
      menus = next;
      buttons = next.map((menu, index) => {
        const button = documentRef.createElement("button");
        button.type = "button";
        button.textContent = displayLabel(menu.label);
        button.setAttribute("role", "menuitem");
        button.setAttribute("aria-haspopup", "menu");
        button.setAttribute("aria-expanded", "false");
        button.tabIndex = index === 0 ? 0 : -1;
        button.addEventListener("click", () => { void openMenu(index); });
        return button;
      });
      menubar.replaceChildren(...buttons);
      if (focusedId) focusMenu(menus.findIndex((menu) => menu.id === focusedId));
    } catch {
      // Preserve the last complete native menu labels on a transient failure.
    }
  };
  const onKeyDown = (event) => {
    if (event.key === "Alt" && !event.ctrlKey && !event.metaKey && !event.shiftKey) { altPressed = true; return; }
    if (event.key !== "Alt") altPressed = false;
    if (event.altKey && !event.ctrlKey && !event.metaKey && event.key?.length === 1) {
      const key = event.key.toLowerCase();
      const index = menus.findIndex((menu) => {
        const mnemonic = /(?:^|[^&])&([^&])/u.exec(menu.label)?.[1];
        return (mnemonic ?? menu.id[0]).toLowerCase() === key;
      });
      if (index >= 0) { event.preventDefault(); void openMenu(index); }
      return;
    }
    if (event.key === "F10" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      if (buttons.includes(documentRef.activeElement)) leaveMenubar();
      else enterMenubar();
      return;
    }
    const index = buttons.indexOf(documentRef.activeElement);
    if (index < 0 || event.ctrlKey || event.altKey || event.metaKey) return;
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      focusMenu(next);
    } else if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      void openMenu(index);
    } else if (event.key === "Escape") {
      event.preventDefault();
      leaveMenubar();
    }
  };
  const onKeyUp = (event) => {
    if (event.key !== "Alt" || !altPressed) return;
    altPressed = false;
    event.preventDefault();
    if (buttons.includes(documentRef.activeElement)) leaveMenubar();
    else enterMenubar();
  };
  const overlay = windowRef?.navigator?.windowControlsOverlay;
  const syncFullscreen = () => {
    const fullscreen = nativeFullscreen || Boolean(documentRef.fullscreenElement);
    root.classList.toggle("desktop-titlebar-fullscreen", fullscreen);
    if (fullscreen && buttons.includes(documentRef.activeElement)) leaveMenubar();
  };
  const setFullscreen = (fullscreen) => {
    if (disposed || typeof fullscreen !== "boolean") return;
    nativeFullscreen = fullscreen;
    syncFullscreen();
  };
  const resetAlt = () => { altPressed = false; };
  documentRef.addEventListener("keydown", onKeyDown);
  documentRef.addEventListener("keyup", onKeyUp);
  documentRef.addEventListener("fullscreenchange", syncFullscreen);
  windowRef.addEventListener?.("blur", resetAlt);
  windowRef.addEventListener?.("tibotattle:locale-change", refresh);
  overlay?.addEventListener?.("geometrychange", syncFullscreen);
  syncFullscreen();
  void refresh();
  return {
    refresh,
    setFullscreen,
    teardown() {
      disposed = true;
      generation += 1;
      documentRef.removeEventListener("keydown", onKeyDown);
      documentRef.removeEventListener("keyup", onKeyUp);
      documentRef.removeEventListener("fullscreenchange", syncFullscreen);
      windowRef.removeEventListener?.("blur", resetAlt);
      windowRef.removeEventListener?.("tibotattle:locale-change", refresh);
      overlay?.removeEventListener?.("geometrychange", syncFullscreen);
      bar.remove();
      root.classList.remove("desktop-titlebar-active", "desktop-titlebar-fullscreen");
    },
  };
}

/**
 * Navigate to one of the dashboard's evidence views from a native menu or
 * tray action. The main process validates the same fixed values before this
 * command reaches the page, and this local mapping keeps the renderer from
 * ever accepting an arbitrary selector, hash, path, or URL.
 */
export function navigateToDashboardSection(_documentRef, windowRef, section, settingsSection = "general") {
  if (section === "settings" && !["general", "tray", "notifications", "data", "about"].includes(settingsSection)) return false;
  const hash = section === "settings" ? `#settings/${settingsSection}` : DASHBOARD_SECTION_HASHES[section];
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

function installCommandBridge(documentRef, windowRef, applyLanguage, applySidebar, refreshMenu, setFullscreen) {
  const bridge = windowRef?.tibotattleDesktop;
  if (bridge?.version !== ELECTRON_API_VERSION
      || typeof bridge.onCommand !== "function") return () => {};
  const onCommand = (command) => {
    if (!command || typeof command !== "object") return;
    if (command.command === "windowFullscreen") {
      if (Reflect.ownKeys(command).length === 2 && Object.hasOwn(command, "fullscreen")
          && typeof command.fullscreen === "boolean") {
        setFullscreen(command.fullscreen);
      }
      return;
    }
    if (command.command === "settingsChanged") { void refreshMenu(); return; }
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
      const keys = Reflect.ownKeys(command);
      if (!Object.hasOwn(command, "section") || keys.some((key) => !["command", "section", "settingsSection"].includes(key))
          || (command.settingsSection !== undefined && command.section !== "settings")) return;
      navigateToDashboardSection(documentRef, windowRef, command.section, command.settingsSection);
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
  const titlebar = mountApplicationTitlebar(documentRef, windowRef, bridge);
  const picker = documentRef.querySelector?.("[data-language-picker]");
  const applySidebar = (collapsed) => applySidebarState(documentRef, collapsed);
  const applyAppearance = (preference) => {
    const resolvedTheme = resolveDesktopAppearance(preference, { windowRef });
    if (resolvedTheme === null) return false;
    return dispatchAppearanceOverride(windowRef, { preference, resolvedTheme });
  };
  let applyingLanguage = false;
  const applyLanguage = (value) => {
    if (LANGUAGE_VALUES.has(value)) void titlebar.refresh();
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
    titlebar.refresh,
    titlebar.setFullscreen,
  );
  const mounted = Object.freeze({
    teardown() {
      settingsButton.removeEventListener?.("click", onSettings);
      picker?.removeEventListener?.("change", onLanguageChange);
      unsubscribeCommand();
      titlebar.teardown();
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
