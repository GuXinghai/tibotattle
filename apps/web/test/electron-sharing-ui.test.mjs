import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { mountSettingsPage, normalizeSettingsState, validSettingsRefreshSeconds, validSettingsNotificationThreshold } from "../public/electron-settings.js";

function fixture({ settings = {}, getSettings, permission = "granted" } = {}) {
  const listeners = new Map();
  function element() {
    return { dataset: {}, attributes: new Map(), hidden: false, disabled: false, value: "", textContent: "", classList: { toggle() {} }, listeners: new Map(),
      setAttribute(k,v) { this.attributes.set(k,v); }, getAttribute(k) { return this.attributes.get(k) ?? null; }, removeAttribute(k) { this.attributes.delete(k); },
      addEventListener(k,v) { this.listeners.set(k,v); }, removeEventListener(k,v) { if (this.listeners.get(k) === v) this.listeners.delete(k); },
      async fire(type, extra = {}) { this.listeners.get(type)?.({ target: this, preventDefault() {}, ...extra }); await new Promise(setImmediate); }, focus() {} };
  }
  const selectors = ["settings-content", "settings-bridge-status", "settings-language", "settings-appearance", "settings-codex-roots-title", "settings-codex-roots-status", "settings-choose-codex-folder", "settings-refresh-interval", "settings-refresh-error", "settings-start-at-login", "settings-notifications-detail", "settings-notification-threshold", "settings-threshold-error", "settings-notification-status", "settings-open-notification-settings", "settings-test-notification", "settings-notification-test-status", "settings-automatic-updates", "settings-check-for-updates", "settings-download-update", "settings-install-update", "settings-open-dashboard-browser", "settings-show-diagnostics", "settings-reveal-local-data", "settings-version", "settings-build", "settings-updates-status", "settings-operation-status"];
  const elements = new Map(selectors.map((id) => [`#${id}`, element()]));
  const tabs = ["general", "tray", "notifications", "data", "x", "about"].map((id) => Object.assign(element(), { dataset: { settingsTab: id } }));
  const panels = tabs.map((tab) => Object.assign(element(), { dataset: { settingsPanel: tab.dataset.settingsTab } }));
  const doc = { documentElement: { dataset: {}, classList: { toggle() {} } }, querySelector(s) { return elements.get(s) ?? null; }, querySelectorAll(s) { return s === "[data-settings-tab]" ? tabs : s === "[data-settings-panel]" ? panels : []; }, addEventListener(k,v) { listeners.set(k,v); }, removeEventListener(k,v) { if (listeners.get(k) === v) listeners.delete(k); } };
  const calls = [];
  let command;
  const rootId = "00000000-0000-4000-8000-000000000001";
  let roots = { primaryRootId: rootId, activityRoots: [{ rootId, kind: "default", path: null, enabled: true }] };
  let current = { language: "en", appearance: "system", refreshIntervalSeconds: 300, codexHomes: roots, startAtLogin: { status: "disabled", canSet: true }, notifications: { enabled: false, threshold: -1, state: "ready", delivery: "ready", canSet: true, permission: "authorized" }, ...settings };
  const snapshot = () => ({ settings: current, about: { version: "test", build: "test", update: { status: "available", canDownload: true }, automaticUpdates: {} } });
  const bridge = { version: "v1", getSettings: getSettings ?? (async () => snapshot()), getCodexHomesForSettings: async () => roots,
    onCommand(listener) { command = listener; calls.push(["subscribe"]); return () => { command = null; calls.push(["unsubscribe"]); }; },
    async setRefreshInterval(seconds) { calls.push(["refresh", seconds]); current = { ...current, refreshIntervalSeconds: seconds }; return snapshot(); },
    async setNotificationPreferences(value) { calls.push(["threshold", value]); current = { ...current, notifications: { ...current.notifications, ...value } }; return snapshot(); },
    async setLanguage(value) { calls.push(["language", value]); throw new Error("synthetic"); },
    async chooseCodexHome() { calls.push(["choose"]); roots = { primaryRootId: "11111111-1111-4111-8111-111111111111", activityRoots: [{ rootId: "11111111-1111-4111-8111-111111111111", kind: "custom", path: "/synthetic/selected", enabled: true }] }; current = { ...current, codexHomes: roots }; return snapshot(); },
    async editCodexHome(value) { calls.push(["edit", value]); return snapshot(); },
    async sendTestNotification() { calls.push(["test"]); return { status: "requested" }; }, async openSystemSettings(value) { calls.push(["system", value]); },
  };
  const winListeners = new Map();
  const win = { usageMonitorDesktop: bridge, location: { hash: "#settings/notifications" }, history: { replaceState(_state,_title,hash) { win.location.hash = hash; } }, Notification: { permission, async requestPermission() { calls.push(["permission"]); return "granted"; } }, addEventListener(k,v) { winListeners.set(k,v); }, removeEventListener(k,v) { if (winListeners.get(k) === v) winListeners.delete(k); } };
  const localizer = { t: (key, values = {}) => key === "electron.settings.codexRoots.locationTitle" ? `Codex folder (${values.path})` : key, setLanguagePreference(value) { calls.push(["locale",value]); } };
  return { doc, win, bridge, localizer, calls, elements, tabs, panels, listeners, winListeners, command: (value) => command?.(value) };
}
const mount = (f) => mountSettingsPage({ documentRef: f.doc, windowRef: f.win, bridge: f.bridge, localizer: f.localizer });

test("Settings has one complete main-window destination and six ordered categories", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="settings-content"[^>]*data-dashboard-page="settings"/u);
  assert.deepEqual([...html.matchAll(/data-settings-tab="([^"]+)"/gu)].map((m) => m[1]), ["general", "tray", "notifications", "data", "x", "about"]);
  for (const retired of ["settings-notifications-enabled", "settings-start-at-login-summary", "settings-open-login-items", "data-background-reset", "background.imageHint", "background.custom", "background.image\""]) assert.equal(html.includes(retired), false, retired);
  assert.match(html, /id="settings-refresh-interval" type="number"/u);
  assert.match(html, /id="settings-notification-threshold" type="number"/u);
  assert.match(await readFile(new URL("../public/electron-settings.html", import.meta.url), "utf8"), /index.html#settings\/general/u);
});

test("Settings preserves unknown capability while numeric contracts reject ambiguous values", () => {
  for (const value of [-1,60,120,300,7200]) assert.equal(validSettingsRefreshSeconds(value), true);
  for (const value of [0,-60,1,90,NaN,Infinity,Number.MAX_SAFE_INTEGER,"300"]) assert.equal(validSettingsRefreshSeconds(value), false);
  for (const value of [-1,1,57,100]) assert.equal(validSettingsNotificationThreshold(value), true);
  for (const value of [0,-2,101,1.2,"90",NaN]) assert.equal(validSettingsNotificationThreshold(value), false);
  const state = normalizeSettingsState({ settings: { refreshIntervalSeconds: 420, notifications: { threshold: 57, canSet: false } } });
  assert.equal(state.refreshIntervalSeconds,420);
  assert.equal(state.notifications.threshold,57);
  assert.equal(state.notifications.canSet,false);
});

test("Settings mounts once, deep-links tabs, and removes every navigation subscription", async () => {
  const f = fixture(); const first = mount(f); const second = mount(f); assert.equal(first,second);
  const mounted = await first;
  assert.equal(f.calls.filter(([name]) => name === "subscribe").length,1);
  assert.equal(f.panels.find((p) => !p.hidden).dataset.settingsPanel,"notifications");
  await f.tabs[3].fire("click"); assert.equal(f.win.location.hash,"#settings/data");
  f.win.location.hash="#settings/tray"; f.winListeners.get("hashchange")();
  assert.equal(f.panels.find((p) => !p.hidden).dataset.settingsPanel,"tray");
  f.listeners.get("usagemonitor:page-view")({ detail: { page: "settings", view: "about" } });
  assert.equal(f.panels.find((p) => !p.hidden).dataset.settingsPanel,"about");
  mounted.teardown(); assert.equal(f.listeners.size,0); assert.equal(f.winListeners.size,0);
  assert.equal(f.tabs.every((t) => t.listeners.size === 0),true);
});

test("refresh minutes and threshold inputs persist exact values and retain invalid drafts", async () => {
  const f=fixture(); const mounted=await mount(f);
  const interval=f.elements.get("#settings-refresh-interval"); assert.equal(interval.value,"5");
  for (const value of ["7","-1"]) { interval.value=value; await interval.fire("change"); }
  assert.deepEqual(f.calls.filter(([name]) => name === "refresh"),[["refresh",420],["refresh",-1]]);
  for (const value of ["","0","1.5","-2"]) { interval.value=value; await interval.fire("change"); assert.equal(f.elements.get("#settings-refresh-error").hidden,false); }
  assert.equal(f.calls.filter(([name]) => name === "refresh").length,2);
  const threshold=f.elements.get("#settings-notification-threshold");
  for (const value of ["57","100","-1"]) { threshold.value=value; await threshold.fire("change"); }
  assert.deepEqual(f.calls.filter(([name]) => name === "threshold").map((c) => c[1]),[{threshold:57},{threshold:100},{threshold:-1}]);
  for (const value of ["","0","101","1.2"]) { threshold.value=value; await threshold.fire("change"); assert.equal(f.elements.get("#settings-threshold-error").hidden,false); }
  assert.equal(f.calls.filter(([name]) => name === "threshold").length,3);
  mounted.teardown();
});

test("the chooser refreshes only the authoritative primary path and keeps retained roots private", async () => {
  const f=fixture(); const mounted=await mount(f); assert.equal(f.elements.get("#settings-codex-roots-title").textContent,"Codex folder (~/.codex)");
  await f.elements.get("#settings-choose-codex-folder").fire("click");
  assert.equal(f.elements.get("#settings-codex-roots-title").textContent,"Codex folder (/synthetic/selected)");
  await f.elements.get("#settings-choose-codex-folder").fire("click");
  assert.equal(f.calls.at(-1)?.[0] === "edit" || f.calls.some(([name])=>name==="edit"),true);
  mounted.teardown();
});

test("Settings coalesces updater changes and never overwrites the later status with an older read", async () => {
  let reads=0, resolveRead; let downloaded=false;
  const f=fixture({ getSettings: async () => { reads++; const snapshot={ settings:{ notifications:{threshold:-1} }, about:{update:downloaded ? {status:"downloaded",canInstall:true} : {status:"available",canDownload:true}}}; if(reads===2) return new Promise((resolve)=>{resolveRead=()=>resolve(snapshot);}); return snapshot; } });
  const mounted=await mount(f); f.command({command:"settingsChanged"}); await new Promise(setImmediate);
  downloaded=true; f.command({command:"settingsChanged"}); await new Promise(setImmediate); assert.equal(reads,2);
  resolveRead(); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(reads,3); assert.equal(f.elements.get("#settings-install-update").hidden,false);
  mounted.teardown();
});

test("language rejection restores saved preference and notification tests do not depend on threshold", async () => {
  const f=fixture(); const mounted=await mount(f);
  const language=f.elements.get("#settings-language"); language.value="es"; await language.fire("change"); assert.equal(language.value,"en");
  const testButton=f.elements.get("#settings-test-notification"); assert.equal(testButton.disabled,false);
  await testButton.fire("click"); assert.equal(f.calls.some(([name])=>name==="test"),true);
  assert.equal(f.elements.get("#settings-notification-test-status").textContent,"electron.settings.notifications.testRequested");
  mounted.teardown();
});

test("notification permission stays main-process authoritative and settings remain reachable", async () => {
  const notifications = (permission) => ({
    enabled: false,
    threshold: -1,
    state: "ready",
    delivery: "ready",
    canSet: true,
    permission,
  });
  const unknown = fixture({
    permission: "granted",
    settings: { notifications: notifications("unknown") },
  });
  const unknownPage = await mount(unknown);
  const unknownButton = unknown.elements.get("#settings-open-notification-settings");
  assert.equal(unknown.elements.get("#settings-notification-status").textContent,
    "electron.settings.notifications.permission.unknown");
  assert.equal(unknownButton.disabled, false);
  assert.equal(unknownButton.textContent, "electron.settings.notifications.openPermission");
  await unknownButton.fire("click");
  assert.equal(unknown.calls.some(([name, value]) =>
    name === "system" && value === "notifications"), true);
  assert.equal(unknown.calls.some(([name]) => name === "permission"), false);
  assert.equal(unknown.elements.get("#settings-notification-status").textContent,
    "electron.settings.notifications.permission.unknown");
  assert.equal(unknownButton.disabled, false);
  unknownPage.teardown();

  for (const permission of ["denied", "unavailable"]) {
    const settings = fixture({
      permission: permission === "denied" ? "denied" : "granted",
      settings: { notifications: notifications(permission) },
    });
    const mounted = await mount(settings);
    const button = settings.elements.get("#settings-open-notification-settings");
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "electron.settings.notifications.openPermission");
    await button.fire("click");
    assert.equal(settings.calls.some(([name, value]) =>
      name === "system" && value === "notifications"), true);
    mounted.teardown();
  }
});
