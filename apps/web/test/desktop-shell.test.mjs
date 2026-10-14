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

test("native navigation accepts only the four fixed dashboard destinations", () => {
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
