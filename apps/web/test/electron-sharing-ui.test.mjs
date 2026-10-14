import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { mountSettingsPage } from "../public/electron-settings.js";

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `production source defines ${name}`);
  const opening = source.indexOf("{", start);
  let depth = 0;
  for (let index = opening; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`production source closes ${name}`);
}

test("Electron settings expose one analyzed Codex folder and retain extras without actions", async () => {
  const [settingsHtml, settingsSource] = await Promise.all([
    readFile(new URL("../public/electron-settings.html", import.meta.url), "utf8"),
    readFile(new URL("../public/electron-settings.js", import.meta.url), "utf8"),
  ]);
  const renderer = extractFunction(settingsSource, "renderCodexRoots");
  assert.match(settingsHtml, /TiboTattle analyzes the selected Codex folder/u);
  assert.match(settingsHtml, /kept for future multi-folder support but aren't analyzed/u);
  assert.match(settingsHtml, /id="settings-add-codex-root"[^>]*hidden[^>]*disabled/u);
  assert.match(settingsHtml, /id="settings-use-default-codex-folder"[^>]*disabled/u);
  assert.match(renderer, /add\.hidden = true;[\s\S]*?add\.disabled = true;/u);
  assert.match(renderer, /useDefault\.hidden = false;[\s\S]*?useDefault\.disabled = !bridgeAvailable/u);
  assert.match(renderer, /electron\.settings\.codexRoots\.retained/u);
  assert.match(renderer, /if \(isPrimary && detailsAvailable && \(root\.kind === "custom" \|\| roots\.length === 1\)\)/u);
  assert.doesNotMatch(renderer, /addCodexHome|removeCodexHome|setPrimaryCodexHome|reorderCodexHomes/u);
  assert.match(
    settingsSource,
    /if \(roots\.length === 1\) \{\s*void invoke\("useDefaultCodexHome"\);/u,
  );
  assert.match(
    settingsSource,
    /void invoke\("setPrimaryCodexHome", \{ rootId: defaultRoot\.rootId \}\);/u,
  );

  const configureRootAction = extractFunction(settingsSource, "configureRootAction");
  const renderCodexRoots = new Function(
    "queryRequired",
    "translateSettingsMessage",
    "createSettingsElement",
    "configureRootAction",
    `${renderer}\nreturn renderCodexRoots;`,
  )(
    (documentRef, selector) => documentRef.elements.get(selector),
    (_localizer, key, values = {}) => `${key}${values.position === undefined ? "" : `:${values.position}`}`,
    (documentRef, tagName, className = "") => documentRef.createElement(tagName, className),
    new Function(`${configureRootAction}\nreturn configureRootAction;`)(),
  );
  const element = (tagName = "div", className = "") => ({
    tagName,
    className,
    childNodes: [],
    dataset: {},
    attributes: new Map(),
    textContent: "",
    hidden: false,
    disabled: false,
    append(...children) { this.childNodes.push(...children); },
    replaceChildren(...children) { this.childNodes = children; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener() {},
  });
  const documentRef = {
    elements: new Map(),
    createElement(tagName, className) { return element(tagName, className); },
  };
  const list = element();
  const status = element();
  const add = element("button");
  const useDefault = element("button");
  documentRef.elements.set("#settings-codex-roots", list);
  documentRef.elements.set("#settings-codex-roots-status", status);
  documentRef.elements.set("#settings-add-codex-root", add);
  documentRef.elements.set("#settings-use-default-codex-folder", useDefault);
  renderCodexRoots(documentRef, {
    codexHomesForSettings: {
      primaryRootId: "11111111-1111-4111-8111-111111111111",
      activityRoots: [
        {
          rootId: "11111111-1111-4111-8111-111111111111",
          kind: "custom",
          path: "/synthetic/primary",
        },
        {
          rootId: "22222222-2222-4222-8222-222222222222",
          kind: "custom",
          path: "/synthetic/retained",
        },
      ],
    },
    codexHomes: { activityRoots: [], primaryRootId: "" },
  }, true, null, () => assert.fail("retained roots must not dispatch an action"));
  const descendants = (node) => [node, ...node.childNodes.flatMap(descendants)];
  assert.equal(add.hidden, true);
  assert.equal(add.disabled, true);
  assert.equal(useDefault.hidden, false);
  assert.equal(useDefault.disabled, true);
  assert.equal(list.childNodes.length, 2);
  const [primary, retained] = list.childNodes;
  assert.equal(primary.dataset.primary, "true");
  assert.equal(retained.dataset.primary, "false");
  assert.equal(primary.dataset.analysisScope, "primary");
  assert.equal(retained.dataset.analysisScope, "retained");
  assert.ok(descendants(primary).some((node) => (
    node.textContent === "electron.settings.codexRoots.primaryHelp"
  )));
  assert.ok(descendants(primary).some((node) => node.tagName === "button"));
  assert.ok(descendants(retained).some((node) => (
    node.textContent === "electron.settings.codexRoots.retained"
  )));
  assert.equal(descendants(retained).some((node) => node.tagName === "button"), false);

  const defaultList = element();
  const defaultStatus = element();
  const defaultAdd = element("button");
  const defaultUse = element("button");
  documentRef.elements.set("#settings-codex-roots", defaultList);
  documentRef.elements.set("#settings-codex-roots-status", defaultStatus);
  documentRef.elements.set("#settings-add-codex-root", defaultAdd);
  documentRef.elements.set("#settings-use-default-codex-folder", defaultUse);
  renderCodexRoots(documentRef, {
    codexHomesForSettings: {
      primaryRootId: "00000000-0000-4000-8000-000000000001",
      activityRoots: [{
        rootId: "00000000-0000-4000-8000-000000000001",
        kind: "default",
        path: null,
      }],
    },
    codexHomes: { activityRoots: [], primaryRootId: "" },
  }, true, null, () => assert.fail("rendering must not dispatch an action"));
  const defaultButton = descendants(defaultList).find((node) => node.tagName === "button");
  assert.equal(defaultButton?.dataset.rootAction, "chooseCodexHome");
  assert.equal(defaultUse.disabled, true, "the current default root needs no reset");

  const customList = element();
  const customStatus = element();
  const customAdd = element("button");
  const customUse = element("button");
  documentRef.elements.set("#settings-codex-roots", customList);
  documentRef.elements.set("#settings-codex-roots-status", customStatus);
  documentRef.elements.set("#settings-add-codex-root", customAdd);
  documentRef.elements.set("#settings-use-default-codex-folder", customUse);
  renderCodexRoots(documentRef, {
    codexHomesForSettings: {
      primaryRootId: "11111111-1111-4111-8111-111111111111",
      activityRoots: [{
        rootId: "11111111-1111-4111-8111-111111111111",
        kind: "custom",
        path: "/synthetic/only-root",
      }],
    },
    codexHomes: { activityRoots: [], primaryRootId: "" },
  }, true, null, () => assert.fail("rendering must not dispatch an action"));
  assert.equal(customUse.disabled, false, "a single selected custom folder can return to default");
});

test("the singleton default chooser refreshes the rendered folder card after selection", async () => {
  const listeners = new Map();
  const element = (tagName = "div", className = "") => ({
    tagName,
    className,
    childNodes: [],
    dataset: {},
    attributes: new Map(),
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    classList: { toggle() {} },
    append(...children) { this.childNodes.push(...children); },
    replaceChildren(...children) { this.childNodes = children; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    removeAttribute(name) { this.attributes.delete(name); },
    addEventListener(type, handler) { this.listeners ??= new Map(); this.listeners.set(type, handler); },
    removeEventListener(type, handler) { if (this.listeners?.get(type) === handler) this.listeners.delete(type); },
    click() { this.listeners?.get("click")?.({ preventDefault() {} }); },
  });
  const selectors = [
    "#settings-bridge-status", "#settings-language", "#settings-appearance",
    "#settings-codex-folder-status", "#settings-codex-roots",
    "#settings-codex-roots-status", "#settings-add-codex-root",
    "#settings-use-default-codex-folder", "#settings-refresh-interval",
    "#settings-start-at-login", "#settings-start-at-login-summary",
    "#settings-open-login-items", "#settings-refresh-login-status",
    "#settings-notifications-enabled", "#settings-notifications-detail",
    "#settings-notification-status", "#settings-open-notification-settings",
    "#settings-automatic-updates", "#settings-check-for-updates",
    "#settings-download-update", "#settings-install-update",
    "#settings-open-dashboard-browser", "#settings-show-diagnostics",
    "#settings-reveal-local-data", "#settings-version", "#settings-build",
    "#settings-updates-status", "#settings-operation-status",
  ];
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  const documentRef = {
    documentElement: { dataset: {}, classList: { toggle() {} } },
    createElement: element,
    querySelector(selector) { return elements.get(selector) ?? null; },
    querySelectorAll() { return []; },
  };
  const defaultRootId = "00000000-0000-4000-8000-000000000001";
  const customRootId = "11111111-1111-4111-8111-111111111111";
  let roots = {
    activityRoots: [{ rootId: defaultRootId, kind: "default", path: null, enabled: true }],
    primaryRootId: defaultRootId,
  };
  const bridge = {
    version: "v1",
    getSettings: async () => ({
      settings: {
        language: "en", appearance: "system", refreshIntervalSeconds: 300,
        codexHomes: roots,
        codexFolder: { kind: roots.activityRoots[0].kind },
        startAtLogin: { status: "disabled", canSet: false },
        notifications: { enabled: false, threshold: "off", canSet: false },
      },
      about: { version: "0.1.18", build: "test", update: {}, automaticUpdates: {} },
    }),
    getCodexHomesForSettings: async () => roots,
    chooseCodexHome: async () => {
      roots = {
        activityRoots: [{
          rootId: customRootId,
          kind: "custom",
          path: "/synthetic/chosen-codex",
          enabled: true,
        }],
        primaryRootId: customRootId,
      };
      return { settings: { codexHomes: roots, codexFolder: { kind: "custom" } } };
    },
  };
  const mounted = await mountSettingsPage({
    documentRef,
    windowRef: { tibotattleDesktop: bridge, location: { hash: "#general" } },
    bridge,
  });
  const list = elements.get("#settings-codex-roots");
  const beforeButton = list.childNodes[0].childNodes
    .flatMap((node) => node.childNodes)
    .find((node) => node.tagName === "button");
  assert.equal(beforeButton?.dataset.rootAction, "chooseCodexHome");
  beforeButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  const card = list.childNodes[0];
  assert.equal(card.dataset.primary, "true");
  assert.equal(card.dataset.analysisScope, "primary");
  assert.equal(card.getAttribute("aria-labelledby"), `settings-codex-root-${customRootId}`);
  const text = [card, ...card.childNodes, ...card.childNodes.flatMap((node) => node.childNodes)]
    .map((node) => node.textContent)
    .join(" ");
  assert.match(text, /\/synthetic\/chosen-codex/u);
  mounted.teardown();
});

test("Settings coalesces trusted updater status refreshes and renders a later download", async () => {
  const element = (tagName = "div", className = "") => ({
    tagName,
    className,
    childNodes: [],
    dataset: {},
    attributes: new Map(),
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    classList: { toggle() {} },
    append(...children) { this.childNodes.push(...children); },
    replaceChildren(...children) { this.childNodes = children; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    removeAttribute(name) { this.attributes.delete(name); },
    addEventListener(type, handler) { this.listeners ??= new Map(); this.listeners.set(type, handler); },
    removeEventListener(type, handler) { if (this.listeners?.get(type) === handler) this.listeners.delete(type); },
  });
  const selectors = [
    "#settings-bridge-status", "#settings-language", "#settings-appearance",
    "#settings-codex-folder-status", "#settings-codex-roots",
    "#settings-codex-roots-status", "#settings-add-codex-root",
    "#settings-use-default-codex-folder", "#settings-refresh-interval",
    "#settings-start-at-login", "#settings-start-at-login-summary",
    "#settings-open-login-items", "#settings-refresh-login-status",
    "#settings-notifications-enabled", "#settings-notifications-detail",
    "#settings-notification-status", "#settings-open-notification-settings",
    "#settings-automatic-updates", "#settings-check-for-updates",
    "#settings-download-update", "#settings-install-update",
    "#settings-open-dashboard-browser", "#settings-show-diagnostics",
    "#settings-reveal-local-data", "#settings-version", "#settings-build",
    "#settings-updates-status", "#settings-operation-status",
  ];
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  const documentRef = {
    documentElement: { dataset: {}, classList: { toggle() {} } },
    createElement: element,
    querySelector(selector) { return elements.get(selector) ?? null; },
    querySelectorAll() { return []; },
  };
  const rootId = "00000000-0000-4000-8000-000000000001";
  let downloaded = false;
  let failRead = false;
  let loginStatus = "disabled";
  let canOpenLoginSettings = true;
  const windowListeners = new Map();
  let refreshCommand = null;
  let reads = 0;
  let failNextRead = false;
  let activeReads = 0;
  let maximumActiveReads = 0;
  let resolveStaleRefresh = null;
  const snapshot = () => ({
    settings: {
      language: "en", appearance: "system", refreshIntervalSeconds: 300,
      codexHomes: { activityRoots: [{ rootId, kind: "default", path: null, enabled: true }], primaryRootId: rootId },
      codexFolder: { kind: "default" },
      startAtLogin: {
        status: loginStatus,
        canSet: true,
        canOpenSettings: canOpenLoginSettings,
      },
      notifications: { enabled: false, threshold: "off", canSet: false },
    },
    about: {
      version: "0.1.18", build: "test",
      update: downloaded
        ? { status: "downloaded", canCheck: false, canDownload: false, canInstall: true, error: "none" }
        : { status: "available", canCheck: false, canDownload: true, canInstall: false, error: "none" },
      automaticUpdates: { enabled: true, available: true, canSet: true },
    },
  });
  const bridge = {
    version: "v1",
    onCommand(listener) {
      refreshCommand = listener;
      return () => { refreshCommand = null; };
    },
    getSettings: async () => {
      reads += 1;
      if (failRead) throw new Error("synthetic settings read failure");
      if (failNextRead) {
        failNextRead = false;
        throw new Error("synthetic bridge read failure");
      }
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      const response = snapshot();
      if (reads === 2) {
        return await new Promise((resolve) => {
          resolveStaleRefresh = () => { activeReads -= 1; resolve(response); };
        });
      }
      activeReads -= 1;
      return response;
    },
  };
  const mounted = await mountSettingsPage({
    documentRef,
    windowRef: {
      tibotattleDesktop: bridge,
      location: { hash: "#about" },
      addEventListener(type, handler) { windowListeners.set(type, handler); },
      removeEventListener(type) { windowListeners.delete(type); },
    },
    bridge,
  });
  assert.equal(elements.get("#settings-bridge-status").hidden, true);
  assert.equal(elements.get("#settings-bridge-status").textContent, "");
  const install = elements.get("#settings-install-update");
  assert.equal(install.hidden, true);
  assert.equal(install.disabled, true);
  refreshCommand({ command: "refresh" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(activeReads, 1);
  downloaded = true;
  refreshCommand({ command: "refresh" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2, "a later status is retained instead of starting a concurrent read");
  assert.equal(maximumActiveReads, 1);
  resolveStaleRefresh();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 3, "the trailing refresh re-reads current main-process status");
  assert.equal(install.hidden, false);
  assert.equal(install.disabled, false);
  failRead = true;
  refreshCommand({ command: "refresh" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#settings-bridge-status").hidden, false);
  assert.match(elements.get("#settings-bridge-status").textContent, /Couldn't read desktop settings/u);
  failRead = false;
  refreshCommand({ command: "refresh" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get("#settings-bridge-status").hidden, true);
  const loginSwitch = elements.get("#settings-start-at-login");
  const openLoginSettings = elements.get("#settings-open-login-items");
  const retryLoginStatus = elements.get("#settings-refresh-login-status");
  assert.equal(loginSwitch.checked, false);
  assert.equal(retryLoginStatus.hidden, true);
  loginStatus = "enabled";
  windowListeners.get("focus")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loginSwitch.checked, true, "returning from OS settings re-reads login status");
  loginStatus = "error";
  windowListeners.get("focus")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retryLoginStatus.hidden, false, "retry is only offered for a failed status read");
  loginStatus = "disabled";
  canOpenLoginSettings = false;
  windowListeners.get("focus")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retryLoginStatus.hidden, true);
  assert.equal(openLoginSettings.hidden, true, "no system startup page is offered without the capability");
  failNextRead = true;
  windowListeners.get("focus")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retryLoginStatus.hidden, false, "failed bridge reads offer a retry");
  windowListeners.get("focus")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retryLoginStatus.hidden, true, "a successful read clears the retry");
  mounted.teardown();
});

test("Settings restores its saved language when the language bridge rejects", async () => {
  const element = (tagName = "div", className = "") => ({
    tagName,
    className,
    childNodes: [],
    dataset: {},
    attributes: new Map(),
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    classList: { toggle() {} },
    append(...children) { this.childNodes.push(...children); },
    replaceChildren(...children) { this.childNodes = children; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    removeAttribute(name) { this.attributes.delete(name); },
    addEventListener(type, handler) { this.listeners ??= new Map(); this.listeners.set(type, handler); },
    removeEventListener(type, handler) { if (this.listeners?.get(type) === handler) this.listeners.delete(type); },
    dispatchChange() { this.listeners?.get("change")?.({ target: this }); },
  });
  const selectors = [
    "#settings-bridge-status", "#settings-language", "#settings-appearance",
    "#settings-codex-folder-status", "#settings-codex-roots",
    "#settings-codex-roots-status", "#settings-add-codex-root",
    "#settings-use-default-codex-folder", "#settings-refresh-interval",
    "#settings-start-at-login", "#settings-start-at-login-summary",
    "#settings-open-login-items", "#settings-refresh-login-status",
    "#settings-notifications-enabled", "#settings-notifications-detail",
    "#settings-notification-status", "#settings-open-notification-settings",
    "#settings-automatic-updates", "#settings-check-for-updates",
    "#settings-download-update", "#settings-install-update",
    "#settings-open-dashboard-browser", "#settings-show-diagnostics",
    "#settings-reveal-local-data", "#settings-version", "#settings-build",
    "#settings-updates-status", "#settings-operation-status",
  ];
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  const documentRef = {
    documentElement: { dataset: {}, classList: { toggle() {} } },
    createElement: element,
    querySelector(selector) { return elements.get(selector) ?? null; },
    querySelectorAll() { return []; },
  };
  const languagePreferences = [];
  const localizer = {
    t(key) { return key; },
    setLanguagePreference(value, options) { languagePreferences.push({ value, options }); },
  };
  const bridge = {
    version: "v1",
    getSettings: async () => ({
      settings: {
        language: "en", appearance: "system", refreshIntervalSeconds: 300,
        codexHomes: {
          activityRoots: [{
            rootId: "00000000-0000-4000-8000-000000000001",
            kind: "default",
            path: null,
            enabled: true,
          }],
          primaryRootId: "00000000-0000-4000-8000-000000000001",
        },
        codexFolder: { kind: "default" },
        startAtLogin: { status: "disabled", canSet: false },
        notifications: { enabled: false, threshold: "off", canSet: false },
      },
      about: { version: "0.1.18", build: "test", update: {}, automaticUpdates: {} },
    }),
    setLanguage: async () => { throw new Error("synthetic persistence failure"); },
  };
  const mounted = await mountSettingsPage({
    documentRef,
    windowRef: { tibotattleDesktop: bridge, location: { hash: "#general" } },
    bridge,
    localizer,
  });
  const language = elements.get("#settings-language");
  assert.equal(language.value, "en");
  language.value = "es";
  language.dispatchChange();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(language.value, "en", "restore the persisted select value after a rejected save");
  assert.deepEqual(
    languagePreferences.map(({ value }) => value),
    ["en-US", "es", "en-US"],
    "restore the persisted document locale after a rejected save",
  );
  mounted.teardown();
});

test("Settings asks Electron for notification permission before opening system settings", async () => {
  const element = () => ({
    childNodes: [],
    dataset: {},
    attributes: new Map(),
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    classList: { toggle() {} },
    append(...children) { this.childNodes.push(...children); },
    replaceChildren(...children) { this.childNodes = children; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    addEventListener(type, handler) { this.listeners ??= new Map(); this.listeners.set(type, handler); },
    removeEventListener(type, handler) { if (this.listeners?.get(type) === handler) this.listeners.delete(type); },
    click() { this.listeners?.get("click")?.({ preventDefault() {} }); },
  });
  const selectors = [
    "#settings-bridge-status", "#settings-language", "#settings-appearance",
    "#settings-codex-folder-status", "#settings-codex-roots",
    "#settings-codex-roots-status", "#settings-add-codex-root",
    "#settings-use-default-codex-folder", "#settings-refresh-interval",
    "#settings-start-at-login", "#settings-start-at-login-summary",
    "#settings-open-login-items", "#settings-refresh-login-status",
    "#settings-notifications-enabled", "#settings-notifications-detail",
    "#settings-notification-status", "#settings-open-notification-settings",
    "#settings-test-notification", "#settings-notification-test-status",
    "#settings-automatic-updates", "#settings-check-for-updates",
    "#settings-download-update", "#settings-install-update",
    "#settings-open-dashboard-browser", "#settings-show-diagnostics",
    "#settings-reveal-local-data", "#settings-version", "#settings-build",
    "#settings-updates-status", "#settings-operation-status",
  ];
  const elements = new Map(selectors.map((selector) => [selector, element()]));
  const documentRef = {
    documentElement: { dataset: {}, classList: { toggle() {} } },
    createElement: element,
    querySelector(selector) { return elements.get(selector) ?? null; },
    querySelectorAll() { return []; },
  };
  const opened = [];
  let testCalls = 0;
  let testFails = false;
  const bridge = {
    version: "v1",
    getSettings: async () => ({
      settings: {
        language: "en", appearance: "system", refreshIntervalSeconds: 300,
        codexHomes: { activityRoots: [], primaryRootId: "" },
        codexFolder: { kind: "default" },
        startAtLogin: { status: "disabled", canSet: false },
        notifications: {
          enabled: false,
          threshold: "off",
          canSet: true,
          state: "ready",
          delivery: "ready",
          permission: "unknown",
        },
      },
      about: { version: "0.1.18", build: "test", update: {}, automaticUpdates: {} },
    }),
    openSystemSettings: async (target) => opened.push(target),
    sendTestNotification: async () => {
      testCalls++;
      if (testFails) throw new Error("unavailable");
      return { status: "requested" };
    },
  };
  let permission = "default";
  let requests = 0;
  const windowRef = {
    tibotattleDesktop: bridge,
    location: { hash: "#notifications" },
    Notification: {
      get permission() { return permission; },
      async requestPermission() {
        requests += 1;
        permission = "denied";
        return permission;
      },
    },
  };
  const mounted = await mountSettingsPage({ documentRef, windowRef, bridge });
  const testButton = elements.get("#settings-test-notification");
  assert.equal(testButton.disabled, false);
  testButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(testCalls, 1);
  assert.equal(elements.get("#settings-notifications-enabled").checked, false);
  assert.match(elements.get("#settings-notification-test-status").textContent, /Test sent/u);
  testFails = true;
  testButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(elements.get("#settings-notification-test-status").textContent, /Couldn't send the test/u);
  const permissionButton = elements.get("#settings-open-notification-settings");
  assert.equal(permissionButton.textContent, "Allow Notifications");
  permissionButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.deepEqual(opened, []);
  assert.equal(permissionButton.textContent, "Open Notification Settings");
  permissionButton.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, ["notifications"]);
  mounted.teardown();
});

test("Settings only shows its page focus ring for keyboard-visible focus", async () => {
  const css = await readFile(new URL("../public/electron-settings.css", import.meta.url), "utf8");
  assert.match(css, /#settings-content:focus-visible\s*\{[\s\S]*?outline: 3px solid var\(--blue\)/u);
  assert.doesNotMatch(css, /#settings-content:focus\s*\{/u);
});
