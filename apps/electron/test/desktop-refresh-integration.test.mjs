import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { createDesktopController } from "../desktop-controller.js";
import { createDesktopIpcHandler, DESKTOP_IPC_CHANNEL } from "../desktop-ipc.js";
import { createDesktopSettingsStore } from "../desktop-settings-store.js";
import {
  createElectronRefreshLease,
  ELECTRON_REFRESH_HEARTBEAT_INTERVAL_MS,
} from "../../web/public/electron-refresh-lifecycle.js";

function scheduler() {
  const timers = [];
  return {
    timers,
    schedule(callback, milliseconds) {
      const timer = { callback, milliseconds, active: true, unref() {} };
      timers.push(timer);
      return timer;
    },
    cancel(timer) {
      timer.active = false;
    },
    fire(timer) {
      assert.equal(timer?.active, true, "timer must still be armed");
      timer.active = false;
      timer.callback();
    },
    latest(milliseconds) {
      return timers.findLast((timer) => timer.active && timer.milliseconds === milliseconds);
    },
  };
}

async function flush() {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
}

for (const overviewRefreshOwnedByCompanion of [false, true]) {
test(`real renderer, preload, IPC, and controller complete two ${overviewRefreshOwnedByCompanion ? "companion-observed" : "legacy shell automatic"} refresh cycles`, async () => {
  const mainClock = scheduler();
  let nowMs = Date.parse("2026-09-21T12:00:00.000Z");
  const commands = [];
  const store = createDesktopSettingsStore({
    backend: {
      load: async () => null,
      save: async (value) => value,
    },
  });
  const controller = createDesktopController({
    overviewRefreshOwnedByCompanion,
    settingsStore: store,
    platformServices: {
      loginItemStatus: () => ({ status: "disabled", canSet: true, detail: "disabled" }),
      setStartAtLogin: async () => ({ status: "disabled", canSet: true, detail: "disabled" }),
      notificationStatus: () => ({ permission: "unknown" }),
      chooseCodexHome: async () => null,
      openSystemSettings: async () => {},
      openExternal: async () => {},
      about: () => ({
        version: "0.1.23",
        build: "test",
        update: { status: "unavailable", canCheck: false, detail: "unavailable" },
        automaticUpdates: {
          enabled: false,
          available: false,
          canSet: false,
          detail: "unavailable",
        },
      }),
    },
    getLifecycle: () => ({
      state: {
        started: true,
        quitting: false,
        primaryInstance: true,
        hasWindow: true,
        hasRecoveryWindow: false,
        dashboardReady: true,
      },
    }),
    applyCodexHome: async () => {},
    validateCodexHome: async (value) => value,
    sendDashboardCommand(command) {
      commands.push(command);
      return true;
    },
    clock: () => nowMs,
    setRecurringTimer: mainClock.schedule,
    clearRecurringTimer: mainClock.cancel,
  });
  await controller.initialize();

  const sender = {};
  const senderFrame = {};
  const ipcRequests = [];
  const handleIpc = createDesktopIpcHandler({
    handlers: controller.handlers,
    trustedSender: sender,
    trustedFrame: senderFrame,
  });
  const exposed = {};
  const preloadSource = await readFile(new URL("../preload.cjs", import.meta.url), "utf8");
  const contextBridge = {
    exposeInMainWorld(name, value) {
      exposed[name] = value;
    },
  };
  const ipcRenderer = {
    invoke(channel, request) {
      assert.equal(channel, DESKTOP_IPC_CHANNEL);
      const cloned = JSON.parse(JSON.stringify(request));
      ipcRequests.push(cloned);
      return handleIpc({ sender, senderFrame }, cloned);
    },
    on() {},
    removeListener() {},
  };
  vm.runInNewContext(preloadSource, {
    Promise,
    contextBridge,
    ipcRenderer,
    require(specifier) {
      assert.equal(specifier, "electron");
      return { contextBridge, ipcRenderer };
    },
  }, { filename: "preload.cjs" });
  const bridge = exposed.tibotattleDesktop;
  assert.equal(Object.isFrozen(bridge), true);

  const expectedModes = overviewRefreshOwnedByCompanion ? ["detailed", "detailed"] : ["quick", "detailed"];
  for (const [index, expectedMode] of expectedModes.entries()) {
    if (index === 1) nowMs += 60 * 60_000;
    if (!overviewRefreshOwnedByCompanion) {
      const cadenceTimer = mainClock.latest(300_000);
      mainClock.fire(cadenceTimer);
      await flush();
      assert.deepEqual(commands.at(-1), { command: "automaticRefresh", mode: expectedMode });
    } else {
      assert.equal(mainClock.latest(300_000), undefined);
      assert.equal(mainClock.latest(3_600_000), undefined);
    }

    const rendererClock = scheduler();
    const session = createElectronRefreshLease({
      bridge,
      mode: expectedMode,
      schedule: rendererClock.schedule,
      cancel: rendererClock.cancel,
    });
    assert.equal(await session.start(), index + 1);
    assert.equal((await bridge.getRefreshStatus()).activeLease, true);
    rendererClock.fire(rendererClock.latest(ELECTRON_REFRESH_HEARTBEAT_INTERVAL_MS));
    await flush();
    assert.equal(await session.finish(), true);
    const status = await bridge.getRefreshStatus();
    assert.equal(status.state, overviewRefreshOwnedByCompanion ? "idle" : "scheduled");
    assert.equal(status.scheduleOwner, overviewRefreshOwnedByCompanion ? "companion" : "electron");
    assert.equal(status.cadenceTimerArmed, !overviewRefreshOwnedByCompanion);
  }

  assert.equal(commands.length, overviewRefreshOwnedByCompanion ? 0 : 2);
  assert.deepEqual(
    ipcRequests.filter(({ action }) => [
      "refreshStarted",
      "refreshHeartbeat",
      "refreshSettled",
    ].includes(action)),
    [
      { action: "refreshStarted", args: { mode: expectedModes[0] } },
      { action: "refreshHeartbeat", args: { lease: 1 } },
      { action: "refreshSettled", args: { lease: 1 } },
      { action: "refreshStarted", args: { mode: "detailed" } },
      { action: "refreshHeartbeat", args: { lease: 2 } },
      { action: "refreshSettled", args: { lease: 2 } },
    ],
  );
  const paused = await bridge.setRefreshPaused(true);
  assert.equal(paused.settings.refreshPaused, true);
  assert.equal((await bridge.getRefreshStatus()).cadenceTimerArmed, false);
  await assert.rejects(bridge.setRefreshPaused("true"));
  const resumed = await bridge.setRefreshPaused(false);
  assert.equal(resumed.settings.refreshIntervalSeconds, 300);
  assert.equal(resumed.settings.refreshPaused, false);
  await controller.dispose();
});
}
