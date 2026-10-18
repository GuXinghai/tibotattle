import assert from "node:assert/strict";
import test from "node:test";

import {
  mountDesktopShell,
  navigateToDashboardSection,
} from "../public/desktop-shell.js";

function fakeButton() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    click(event) {
      listeners.get("click")?.(event);
    },
  };
}

function fakeWindow() {
  const commandListeners = [];
  const events = [];
  class FakeCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const windowRef = {
    tibotattleDesktop: {
      version: "v1",
      onCommand(listener) {
        commandListeners.push(listener);
        return () => {
          const index = commandListeners.indexOf(listener);
          if (index >= 0) commandListeners.splice(index, 1);
        };
      },
      getSettings: async () => ({}),
    },
    location: { hash: "#overview" },
    CustomEvent: FakeCustomEvent,
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
  };
  return { commandListeners, events, windowRef };
}

function fakeDocument({
  settingsButton = fakeButton(),
} = {}) {
  const classList = { contains: (value) => value === "electron-dashboard" };
  return {
    documentElement: { classList },
    querySelector(selector) {
      if (selector === "#electron-settings-button") return settingsButton;
      if (selector === "[data-language-picker]") return null;
      return null;
    },
  };
}

test("native navigation accepts only the fixed dashboard destinations", () => {
  const { windowRef } = fakeWindow();
  for (const section of ["overview", "usage", "allowance", "performance"]) {
    assert.equal(navigateToDashboardSection({}, windowRef, section), true);
    assert.equal(windowRef.location.hash, `#${section}`);
  }
  windowRef.location.hash = "#overview";
  for (const rejected of [
    "#usage", "weekly", "timeline", "accounting", "projects", "community",
    "history", "backend", "data", "trends", "method", "usage/cache", "",
  ]) {
    assert.equal(navigateToDashboardSection({}, windowRef, rejected), false, rejected);
  }
  assert.equal(windowRef.location.hash, "#overview");
  assert.equal(navigateToDashboardSection({}, {}, "usage"), false);
});

test("desktop command bridge navigates the dashboard through the fixed section map", async () => {
  const { commandListeners, windowRef } = fakeWindow();
  const documentRef = fakeDocument();
  const mounted = mountDesktopShell({ documentRef, windowRef });
  assert.equal(commandListeners.length, 1);

  for (const section of ["usage", "allowance", "performance", "overview"]) {
    commandListeners[0]({ command: "dashboardSection", section });
    assert.equal(windowRef.location.hash, `#${section}`);
  }
  commandListeners[0]({ command: "dashboardSection", section: "community" });
  commandListeners[0]({ command: "dashboardSection", section: "weekly" });
  assert.equal(windowRef.location.hash, "#overview");
  commandListeners[0]({ command: "dashboardSection", section: "usage", path: "/private/secret" });
  assert.equal(windowRef.location.hash, "#overview");

  mounted.teardown();
  await Promise.resolve();
  assert.equal(commandListeners.length, 0);
});

test("desktop command bridge forwards only the closed automatic refresh mode", () => {
  const { commandListeners, events, windowRef } = fakeWindow();
  const mounted = mountDesktopShell({
    documentRef: fakeDocument(),
    windowRef,
  });

  commandListeners[0]({ command: "automaticRefresh", mode: "quick" });
  commandListeners[0]({ command: "automaticRefresh", mode: "detailed" });
  commandListeners[0]({ command: "automaticRefresh", mode: "quick", path: "/private/secret" });
  commandListeners[0]({ command: "automaticRefresh", mode: "background" });

  assert.deepEqual(events.map(({ type, detail }) => ({ type, detail })), [
    { type: "tibotattle:automatic-refresh", detail: { mode: "quick" } },
    { type: "tibotattle:automatic-refresh", detail: { mode: "detailed" } },
  ]);
  mounted.teardown();
});

test("desktop startup reapplies the persisted forced appearance", async () => {
  const { events, windowRef } = fakeWindow();
  windowRef.matchMedia = () => ({ matches: true });
  windowRef.tibotattleDesktop.getSettings = async () => ({
    settings: { appearance: "light" },
  });
  const mounted = mountDesktopShell({
    documentRef: fakeDocument(),
    windowRef,
  });

  await Promise.resolve();
  assert.deepEqual(events.map(({ type, detail }) => ({ type, detail })), [{
    type: "tibotattle:appearance-override",
    detail: { preference: "light", resolvedTheme: "light" },
  }]);
  mounted.teardown();
});

test("retired share-card commands are ignored and never become renderer events", () => {
  const { commandListeners, events, windowRef } = fakeWindow();
  const mounted = mountDesktopShell({ documentRef: fakeDocument(), windowRef });
  commandListeners[0]({ command: "shareCardDownloadCompleted", filename: "x.png" });
  commandListeners[0]({ command: "shareCardDownloadFailed" });
  assert.deepEqual(events, []);
  mounted.teardown();
});

test("the shell no longer wires a global Share button or a community link", () => {
  const { windowRef } = fakeWindow();
  const selectors = [];
  const documentRef = fakeDocument();
  const query = documentRef.querySelector;
  documentRef.querySelector = (selector) => {
    selectors.push(selector);
    return query(selector);
  };
  const mounted = mountDesktopShell({ documentRef, windowRef });
  assert.equal(selectors.some((selector) => /share|community/iu.test(selector)), false);
  mounted.teardown();
});

test("native Settings commands accept fixed categories and reject arbitrary destinations", () => {
  const { windowRef, commandListeners } = fakeWindow();
  const mounted = mountDesktopShell({ documentRef: fakeDocument(), windowRef });
  commandListeners[0]({ command: "dashboardSection", section: "settings", settingsSection: "notifications" });
  assert.equal(windowRef.location.hash, "#settings/notifications");
  for (const settingsSection of ["../private", "#usage", "", "settings/data"]) {
    commandListeners[0]({ command: "dashboardSection", section: "settings", settingsSection });
    assert.equal(windowRef.location.hash, "#settings/notifications");
  }
  commandListeners[0]({ command: "dashboardSection", section: "usage", settingsSection: "data" });
  assert.equal(windowRef.location.hash, "#settings/notifications");
  mounted.teardown();
});

function titlebarFixture() {
  const { windowRef, commandListeners } = fakeWindow();
  const documentRef = fakeDocument();
  function target() {
    const listeners = new Map();
    return {
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
      },
      removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
      emit(type, init = {}) {
        const event = { preventDefault() { this.defaultPrevented = true; }, ...init };
        for (const listener of listeners.get(type) ?? []) listener(event);
        return event;
      },
      listenerCount() { return [...listeners.values()].reduce((sum, group) => sum + group.size, 0); },
    };
  }
  function element() {
    const attributes = new Map();
    return {
      ...target(), children: [],
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
      append(...children) { children.forEach((child) => { child.parent = this; this.children.push(child); }); },
      prepend(child) { child.parent = this; this.children.unshift(child); },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      remove() { this.parent.children = this.parent.children.filter((child) => child !== this); },
      focus() { documentRef.activeElement = this; },
      blur() { if (documentRef.activeElement === this) documentRef.activeElement = documentRef.body; },
      getBoundingClientRect() { return { left: 19.5, bottom: 35.5 }; },
    };
  }
  const classes = new Set(["electron-dashboard"]);
  documentRef.documentElement.classList = {
    contains: (value) => classes.has(value),
    add: (...values) => values.forEach((value) => classes.add(value)),
    remove: (...values) => values.forEach((value) => classes.delete(value)),
    toggle(value, on) { if (on) classes.add(value); else classes.delete(value); },
  };
  Object.assign(documentRef, target());
  Object.assign(windowRef, target());
  documentRef.createElement = element;
  documentRef.body = element();
  documentRef.activeElement = documentRef.body;
  const overlay = { ...target(), visible: true };
  windowRef.navigator = { windowControlsOverlay: overlay };
  let labels = ["&File", "&Edit", "&View", "&Window", "&Help"];
  const ids = ["file", "edit", "view", "window", "help"];
  const calls = [];
  let closePopup;
  windowRef.tibotattleDesktop.getApplicationMenu = async () => ({
    menus: ids.map((id, index) => ({ id, label: labels[index] })),
    fullscreen: false,
  });
  windowRef.tibotattleDesktop.openApplicationMenu = (payload) => {
    calls.push(payload);
    return new Promise((resolve) => { closePopup = resolve; });
  };
  return {
    documentRef, windowRef, overlay, commandListeners, classes, calls,
    setLabels(next) { labels = next; },
    closePopup() { closePopup?.(true); },
    buttons() { return documentRef.body.children[0].children[0].children; },
  };
}

test("desktop titlebar uses native menu labels, coordinates and keyboard navigation without duplicating mounts", async () => {
  const fixture = titlebarFixture();
  const { documentRef, windowRef, calls } = fixture;
  const content = documentRef.createElement("input");
  content.focus();
  const mounted = mountDesktopShell({ documentRef, windowRef });
  assert.equal(mountDesktopShell({ documentRef, windowRef }), mounted);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(documentRef.body.children.length, 1);
  assert.deepEqual(fixture.buttons().map((button) => button.textContent), ["File", "Edit", "View", "Window", "Help"]);
  assert.equal(documentRef.emit("keydown", { key: "F10" }).defaultPrevented, true);
  assert.equal(documentRef.activeElement, fixture.buttons()[0]);
  documentRef.emit("keydown", { key: "ArrowRight" });
  assert.equal(documentRef.activeElement, fixture.buttons()[1]);
  documentRef.emit("keydown", { key: "End" });
  documentRef.emit("keydown", { key: "Enter" });
  assert.deepEqual(calls, [{ menu: "help", x: 20, y: 36 }]);
  assert.equal(fixture.buttons()[4].getAttribute("aria-expanded"), "true");
  fixture.closePopup();
  await Promise.resolve();
  assert.equal(fixture.buttons()[4].getAttribute("aria-expanded"), "false");
  documentRef.emit("keydown", { key: "Escape" });
  assert.equal(documentRef.activeElement, content);
  documentRef.emit("keydown", { key: "f", altKey: true });
  assert.equal(calls[1].menu, "file");
  fixture.closePopup();
  await Promise.resolve();
  mounted.teardown();
  assert.equal(documentRef.body.children.length, 0);
  assert.equal(documentRef.listenerCount(), 0);
  assert.equal(windowRef.listenerCount(), 0);
  assert.equal(fixture.overlay.listenerCount(), 0);
  assert.equal(fixture.classes.has("desktop-titlebar-active"), false);
});

test("titlebar refreshes localized labels, handles fullscreen and ignores late responses after teardown", async () => {
  const fixture = titlebarFixture();
  const { documentRef, windowRef, overlay, commandListeners, classes } = fixture;
  const mounted = mountDesktopShell({ documentRef, windowRef });
  await Promise.resolve();
  await Promise.resolve();
  fixture.setLabels(["文件(&F)", "编辑(&E)", "视图(&V)", "窗口(&W)", "帮助(&H)"]);
  commandListeners[0]({ command: "settingsChanged" });
  await Promise.resolve();
  assert.deepEqual(fixture.buttons().map((button) => button.textContent), ["文件", "编辑", "视图", "窗口", "帮助"]);
  documentRef.emit("keydown", { key: "Alt" });
  documentRef.emit("keyup", { key: "Alt" });
  assert.equal(documentRef.activeElement, fixture.buttons()[0]);
  overlay.visible = false;
  overlay.emit("geometrychange");
  assert.equal(classes.has("desktop-titlebar-fullscreen"), false);
  commandListeners[0]({ command: "windowFullscreen", fullscreen: true });
  assert.equal(classes.has("desktop-titlebar-fullscreen"), true);
  commandListeners[0]({ command: "windowFullscreen", fullscreen: false, extra: true });
  commandListeners[0]({ command: "windowFullscreen", fullscreen: "false" });
  assert.equal(classes.has("desktop-titlebar-fullscreen"), true);
  overlay.visible = true;
  overlay.emit("geometrychange");
  assert.equal(classes.has("desktop-titlebar-fullscreen"), true);
  commandListeners[0]({ command: "windowFullscreen", fullscreen: false });
  assert.equal(classes.has("desktop-titlebar-fullscreen"), false);
  documentRef.fullscreenElement = {};
  documentRef.emit("fullscreenchange");
  assert.equal(classes.has("desktop-titlebar-fullscreen"), true);
  let resolvePending;
  windowRef.tibotattleDesktop.getApplicationMenu = () => new Promise((resolve) => { resolvePending = resolve; });
  windowRef.emit("tibotattle:locale-change");
  mounted.teardown();
  resolvePending({ menus: [] });
  await Promise.resolve();
  assert.equal(documentRef.body.children.length, 0);
  assert.equal(classes.has("desktop-titlebar-fullscreen"), false);
});

test("trusted desktop without the optional overlay geometry API still has its menu row", async () => {
  const fixture = titlebarFixture();
  delete fixture.windowRef.navigator.windowControlsOverlay;
  const mounted = mountDesktopShell(fixture);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fixture.buttons().length, 5);
  assert.equal(fixture.classes.has("desktop-titlebar-fullscreen"), false);
  mounted.teardown();
});

test("native fullscreen metadata initializes the row without inferring state from overlay visibility", async () => {
  const fixture = titlebarFixture();
  const readMenu = fixture.windowRef.tibotattleDesktop.getApplicationMenu;
  fixture.windowRef.tibotattleDesktop.getApplicationMenu = async () => ({
    ...await readMenu(), fullscreen: true,
  });
  const mounted = mountDesktopShell(fixture);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fixture.buttons().length, 5);
  assert.equal(fixture.classes.has("desktop-titlebar-fullscreen"), true);
  mounted.teardown();
});
