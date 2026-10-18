import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_DEFAULT_SETTINGS,
  projectDesktopSettingsPathFree,
} from "../desktop-contract.js";
import {
  createDesktopSettingsStore,
} from "../desktop-settings-store.js";
import { DesktopSettingsBackendError } from "../desktop-settings-backends.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const ROOT_A = "11111111-1111-4111-8111-111111111111";
const ROOT_B = "22222222-2222-4222-8222-222222222222";

function customHomes(path = "D:\\Codex", rootId = ROOT_A) {
  return {
    activityRoots: [{ rootId, kind: "custom", path, enabled: true }],
    primaryRootId: rootId,
  };
}

test("settings store uses exact defaults and a dependency-injected backend", async () => {
  const calls = [];
  const backend = {
    async load() {
      calls.push("load");
      return null;
    },
    async save(snapshot) {
      calls.push({ save: clone(snapshot) });
    },
  };
  const store = createDesktopSettingsStore({ backend });
  assert.deepEqual(await store.getSettings(), projectDesktopSettingsPathFree(DESKTOP_DEFAULT_SETTINGS));
  assert.equal(store.lastLoadFailed, false);
  assert.deepEqual(calls, ["load"]);
  const result = await store.setLanguage("es");
  assert.equal(result.language, "es");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].save, {
    ...DESKTOP_DEFAULT_SETTINGS,
    language: "es",
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.notifications), true);
});
test("settings store restores a valid persisted snapshot and rejects malformed updates", async () => {
  const persisted = {
    ...DESKTOP_DEFAULT_SETTINGS,
    codexHomes: customHomes(),
    language: "zh-Hans",
    refreshIntervalSeconds: 900,
    startAtLogin: true,
    notifications: { enabled: true, threshold: 90 },
  };
  const store = createDesktopSettingsStore({
    backend: {
      async load() { return persisted; },
      async save() {},
    },
  });
  assert.deepEqual(await store.getSettings(), projectDesktopSettingsPathFree(persisted));
  assert.deepEqual(await store.getCodexHomesForSettings(), persisted.codexHomes);
  await assert.rejects(store.setLanguage("fr"), TypeError);
  await assert.rejects(store.setRefreshInterval(5), TypeError);
  await assert.rejects(store.setNotificationPreferences({
    enabled: true,
    threshold: "90",
  }), TypeError);
  await assert.rejects(store.setNotificationPreferences({
    enabled: true,
    threshold: "ninety",
    extra: true,
  }), TypeError);
  assert.equal((await store.setAppearance("dark")).appearance, "dark");
  await assert.rejects(store.setAppearance("sepia"), TypeError);
});

test("settings writes are serialized and retain the last working state after failure", async () => {
  const saves = [];
  let rejectNext = false;
  const backend = {
    async load() { return null; },
    async save(snapshot) {
      saves.push(clone(snapshot));
      if (rejectNext) {
        rejectNext = false;
        throw new Error("backend unavailable");
      }
    },
  };
  const store = createDesktopSettingsStore({ backend });
  await store.getSettings();
  const first = store.setLanguage("en");
  const second = store.setRefreshInterval(900);
  assert.equal((await first).language, "en");
  assert.equal((await second).refreshIntervalSeconds, 900);
  assert.equal((await store.getSettings()).language, "en");
  assert.equal((await store.getSettings()).refreshIntervalSeconds, 900);
  assert.equal(saves.length, 2);
  assert.equal(saves[1].language, "en");

  rejectNext = true;
  await assert.rejects(store.setStartAtLogin(true), (error) => {
    assert.equal(error.code, "desktop_settings_persistence_failed");
    return true;
  });
  assert.deepEqual(await store.getSettings(), projectDesktopSettingsPathFree({
    ...DESKTOP_DEFAULT_SETTINGS,
    language: "en",
    refreshIntervalSeconds: 900,
  }));
  assert.equal((await store.setStartAtLogin(false)).startAtLogin, false);
});

test("settings load failures fail soft to defaults without exposing backend details", async () => {
  const store = createDesktopSettingsStore({
    backend: {
      async load() { throw new Error("private path detail"); },
      async save() {},
    },
  });
  assert.deepEqual(await store.getSettings(), projectDesktopSettingsPathFree(DESKTOP_DEFAULT_SETTINGS));
  assert.equal(store.lastLoadFailed, true);
});

test("transient pre-write reads remain retriable while invalid newer records stay blocked", async () => {
  let stored = clone(DESKTOP_DEFAULT_SETTINGS);
  let failRead = false;
  let writes = 0;
  const store = createDesktopSettingsStore({ backend: {
    async load() { if (failRead) throw new Error("synthetic unavailable"); return stored; },
    async save(next) { stored = clone(next); ++writes; },
  } });
  await store.getSettings();
  failRead = true;
  await assert.rejects(store.setLanguage("es"), { code: "desktop_settings_persistence_failed" });
  assert.equal(store.traySettingsStatus, "current");
  assert.equal((await store.getSettings()).language, DESKTOP_DEFAULT_SETTINGS.language);
  failRead = false;
  assert.equal((await store.setLanguage("es")).language, "es");
  assert.equal(writes, 1);
  stored.schemaVersion = "tibotattle-desktop-settings-v5";
  await assert.rejects(store.setLanguage("en"), { code: "desktop_settings_persistence_failed" });
  stored = clone(DESKTOP_DEFAULT_SETTINGS);
  await assert.rejects(store.setLanguage("en"), { code: "desktop_settings_persistence_failed" });
  assert.equal(store.traySettingsStatus, "invalid");
  assert.equal(writes, 1);
});

test("an initial unavailable read retries before mutating the recovered settings snapshot", async () => {
  let unavailable = true;
  let stored = { ...clone(DESKTOP_DEFAULT_SETTINGS), refreshIntervalSeconds: 600 };
  let writes = 0;
  const store = createDesktopSettingsStore({ backend: {
    async load() { if (unavailable) throw new Error("synthetic read failure"); return stored; },
    async save(next) { stored = clone(next); ++writes; },
  } });
  assert.equal((await store.getSettings()).refreshIntervalSeconds, 300);
  await assert.rejects(store.setLanguage("es"), { code: "desktop_settings_persistence_failed" });
  assert.equal(writes, 0);
  unavailable = false;
  await store.setLanguage("es");
  assert.equal(stored.refreshIntervalSeconds, 600);
  assert.equal(stored.language, "es");
  assert.equal(store.lastLoadFailed, false);
});

test("branded backend validation refusals stay invalid while a matching unbranded read failure can retry", async () => {
  for (const phase of ["initial", "pre-write"]) {
    for (const code of ["corrupt", "too_large"]) {
      let failure = phase === "initial" ? new DesktopSettingsBackendError(code) : null;
      let writes = 0;
      const store = createDesktopSettingsStore({ backend: {
        async load() { if (failure) throw failure; return null; },
        async save() { ++writes; },
      } });
      await store.getSettings();
      failure = new DesktopSettingsBackendError(code);
      await assert.rejects(store.setLanguage("es"), { code: "desktop_settings_persistence_failed" });
      failure = null;
      await assert.rejects(store.setLanguage("es"), { code: "desktop_settings_persistence_failed" });
      assert.equal(store.traySettingsStatus, "invalid");
      assert.equal(writes, 0);
    }
  }
  let failure = Object.assign(new Error("synthetic I/O failure"), { code: "desktop_settings_backend_corrupt" });
  const store = createDesktopSettingsStore({ backend: {
    async load() { if (failure) throw failure; return null; }, async save() {},
  } });
  await store.getSettings();
  assert.equal(store.traySettingsStatus, "current");
  failure = null;
  assert.equal((await store.setLanguage("es")).language, "es");
});

test("custom refresh minutes and threshold-only preferences survive reload", async () => {
  let persisted = null;
  const backend = { async load() { return persisted; }, async save(value) { persisted = clone(value); } };
  const store = createDesktopSettingsStore({ backend });
  assert.equal((await store.setRefreshInterval(420)).refreshIntervalSeconds, 420);
  assert.deepEqual((await store.setNotificationPreferences({ threshold: 37 })).notifications, { enabled: true, threshold: 37 });
  let reloaded = createDesktopSettingsStore({ backend });
  assert.equal((await reloaded.getSettings()).refreshIntervalSeconds, 420);
  assert.deepEqual((await reloaded.getSettings()).notifications, { enabled: true, threshold: 37 });
  await reloaded.setRefreshInterval(-1);
  await reloaded.setNotificationPreferences({ threshold: -1 });
  reloaded = createDesktopSettingsStore({ backend });
  assert.equal((await reloaded.getSettings()).refreshIntervalSeconds, -1);
  assert.deepEqual((await reloaded.getSettings()).notifications, { enabled: false, threshold: -1 });
});

test("a future settings schema cannot be overwritten by the current reader", async () => {
  let saves = 0;
  const store = createDesktopSettingsStore({ backend: {
    async load() { return { ...DESKTOP_DEFAULT_SETTINGS, schemaVersion: "tibotattle-desktop-settings-v5" }; },
    async save() { saves += 1; },
  } });
  await store.getSettings();
  assert.equal(store.lastLoadFailed, true);
  await assert.rejects(store.setRefreshInterval(420), { code: "desktop_settings_persistence_failed" });
  assert.equal(saves, 0);
});

test("store migrates v1 once and retains the generated root ID", async () => {
  const legacy = {
    schemaVersion: "tibotattle-desktop-settings-v1",
    codexHome: { mode: "custom", path: "D:\\Codex" },
    language: "en",
    appearance: "system",
    refreshIntervalSeconds: 300,
    startAtLogin: false,
    notifications: { enabled: false, threshold: "off" },
  };
  const saves = [];
  const store = createDesktopSettingsStore({
    idFactory: () => ROOT_A,
    backend: {
      async load() { return legacy; },
      async save(value) { saves.push(clone(value)); },
    },
  });
  assert.equal((await store.getCodexHomesForSettings()).activityRoots[0].rootId, ROOT_A);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].schemaVersion, "tibotattle-desktop-settings-v4");
  assert.equal(saves[0].codexHomes.activityRoots[0].path, "D:\\Codex");
  assert.equal(store.lastLoadFailed, false);
});

test("store root mutations are bounded, atomic, and preserve primary on reorder", async () => {
  const writes = [];
  let failNext = false;
  const store = createDesktopSettingsStore({
    idFactory: () => ROOT_B,
    backend: {
      async load() { return { ...DESKTOP_DEFAULT_SETTINGS, codexHomes: customHomes() }; },
      async save(value) {
        writes.push(clone(value));
        if (failNext) {
          failNext = false;
          throw new Error("disk unavailable");
        }
      },
    },
  });
  await store.getSettings();
  await store.addCodexHome({ path: "C:\\Users\\test\\secondary" });
  let roots = await store.getCodexHomesForSettings();
  assert.deepEqual(roots.activityRoots.map((root) => root.rootId), [ROOT_A, ROOT_B]);
  await store.setPrimaryCodexHome({ rootId: ROOT_B });
  await store.reorderCodexHomes({ rootIds: [ROOT_B, ROOT_A] });
  roots = await store.getCodexHomesForSettings();
  assert.equal(roots.primaryRootId, ROOT_B);
  assert.deepEqual(roots.activityRoots.map((root) => root.rootId), [ROOT_B, ROOT_A]);
  await store.editCodexHome({ rootId: ROOT_A, path: "/Users/test/edited" });
  assert.equal((await store.getCodexHomesForSettings()).activityRoots[1].path, "/Users/test/edited");
  await store.removeCodexHome({ rootId: ROOT_A });
  assert.deepEqual((await store.getCodexHomesForSettings()).activityRoots.map((root) => root.rootId), [ROOT_B]);

  await store.useDefaultCodexHome();
  assert.deepEqual(await store.getCodexHomesForSettings(), DESKTOP_DEFAULT_SETTINGS.codexHomes);
  failNext = true;
  await assert.rejects(store.addCodexHome({ path: "/Users/test/after-failure" }), (error) => {
    assert.equal(error.code, "desktop_settings_persistence_failed");
    return true;
  });
  assert.deepEqual(await store.getCodexHomesForSettings(), DESKTOP_DEFAULT_SETTINGS.codexHomes);
  assert.equal(writes.length > 0, true);
});

test("store rejects malformed root operations before a backend write", async () => {
  const saves = [];
  const store = createDesktopSettingsStore({
    backend: {
      async load() { return null; },
      async save(value) { saves.push(value); },
    },
  });
  await store.getSettings();
  await assert.rejects(store.addCodexHome({ path: "relative" }), TypeError);
  await assert.rejects(store.removeCodexHome({ rootId: "11111111-1111-4111-8111-111111111111" }), TypeError);
  await assert.rejects(store.reorderCodexHomes({ rootIds: [] }), TypeError);
  assert.equal(saves.length, 0);
});
