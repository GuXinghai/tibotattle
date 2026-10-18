import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopNotificationDelivery,
  DESKTOP_NOTIFICATION_COPY_KEYS,
  DESKTOP_NOTIFICATION_DELIVERY_STATUSES,
  validateDesktopNotificationToDeliver,
} from "../desktop-notification-delivery.js";
import { DESKTOP_NOTIFICATION_KEYS } from "../desktop-notification-policy.js";

function fakeNotification({ supported = true, supportError = null, constructError = null, showError = null } = {}) {
  const state = {
    supportCalls: 0,
    constructorCalls: [],
    showCalls: 0,
    supported,
    supportError,
    constructError,
    showError,
  };
  class FakeNotification {
    constructor(options) {
      state.constructorCalls.push(options);
      if (state.constructError) throw state.constructError;
      this.options = options;
    }

    show() {
      state.showCalls += 1;
      if (state.showError) throw state.showError;
    }

    static isSupported() {
      state.supportCalls += 1;
      if (state.supportError) throw state.supportError;
      return state.supported;
    }
  }
  return { Notification: FakeNotification, state };
}

const PACKAGED_APP = Object.freeze({ isPackaged: true });

test("delivery vocabulary and semantic notification validator are closed", () => {
  assert.deepEqual(DESKTOP_NOTIFICATION_DELIVERY_STATUSES, [
    "ready",
    "delivered",
    "not_packaged",
    "windows_identity_unavailable",
    "unsupported",
    "capability_error",
    "native_error",
  ]);
  assert.deepEqual(DESKTOP_NOTIFICATION_COPY_KEYS, {
    THRESHOLD_80_TITLE: "electron.notification.threshold80.title",
    THRESHOLD_80_BODY: "electron.notification.threshold80.body",
    THRESHOLD_90_TITLE: "electron.notification.threshold90.title",
    THRESHOLD_90_BODY: "electron.notification.threshold90.body",
    RESET_TITLE: "electron.notification.reset.title",
    RESET_BODY: "electron.notification.reset.body",
  });

  const threshold = validateDesktopNotificationToDeliver({
    key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD,
    thresholdPercent: 80,
  });
  assert.deepEqual(threshold, {
    key: "quota.threshold",
    thresholdPercent: 80,
  });
  assert.equal(Object.isFrozen(threshold), true);
  assert.deepEqual(
    validateDesktopNotificationToDeliver({ key: DESKTOP_NOTIFICATION_KEYS.RESET }),
    { key: "quota.reset" },
  );

  const invalid = [
    null,
    [],
    { key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD, thresholdPercent: 101 },
    { key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD, thresholdPercent: "90" },
    { key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD, thresholdPercent: 90, text: "raw" },
    { key: DESKTOP_NOTIFICATION_KEYS.RESET, thresholdPercent: 90 },
    { key: DESKTOP_NOTIFICATION_KEYS.RESET, path: "/private" },
    { key: DESKTOP_NOTIFICATION_KEYS.RESET, identity: "account" },
    { key: "quota.other" },
    { state: {}, outcome: "notification", reason: "fresh", notification: { key: "quota.reset" } },
  ];
  for (const value of invalid) {
    assert.throws(() => validateDesktopNotificationToDeliver(value), TypeError);
  }
});
test("packaged delivery maps each semantic output to complete localized copy", () => {
  const expectations = [
    ["en-US", "Quota usage reached 80%", "A fresh provider-reported observation crossed the 80% usage threshold."],
    ["zh-Hans", "额度使用量已达到 80%", "提供商报告的最新观测显示，额度用量已达到 80% 的提醒阈值。"],
    ["es", "El uso de la cuota alcanzó el 80 %", "Una observación reciente informada por el proveedor alcanzó el umbral de uso del 80 %."],
  ];
  for (const [locale, title, body] of expectations) {
    const fake = fakeNotification();
    const delivery = createDesktopNotificationDelivery({
      Notification: fake.Notification,
      app: PACKAGED_APP,
      platform: "win32",
      locale,
      windowsIdentityReady: true,
    });
    assert.deepEqual(delivery.status(), { status: "ready" });
    assert.deepEqual(delivery.deliver({
      key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD,
      thresholdPercent: 80,
    }), { status: "delivered" });
    assert.deepEqual(fake.state.constructorCalls, [{ title, body }]);
    assert.equal(fake.state.showCalls, 1);
  }

  const resetFake = fakeNotification();
  const resetDelivery = createDesktopNotificationDelivery({
    Notification: resetFake.Notification,
    app: PACKAGED_APP,
    platform: "win32",
    locale: "en-US",
    windowsIdentityReady: true,
  });
  assert.deepEqual(resetDelivery.deliver({ key: DESKTOP_NOTIFICATION_KEYS.RESET }), {
    status: "delivered",
  });
  assert.deepEqual(resetFake.state.constructorCalls, [{
    title: "Quota reset observed",
    body: "Fresh provider-reported quota evidence shows that the window has reset.",
  }]);
  assert.equal(resetFake.state.showCalls, 1);
});


test("development and Windows identity gates do not claim delivery", () => {
  const development = fakeNotification();
  const developmentDelivery = createDesktopNotificationDelivery({
    Notification: development.Notification,
    app: { isPackaged: false },
    platform: "win32",
  });
  assert.deepEqual(developmentDelivery.status(), { status: "not_packaged" });
  assert.deepEqual(developmentDelivery.deliver({ key: DESKTOP_NOTIFICATION_KEYS.RESET }), {
    status: "not_packaged",
  });
  assert.equal(development.state.supportCalls, 0);
  assert.equal(development.state.showCalls, 0);

  const windows = fakeNotification();
  const windowsDelivery = createDesktopNotificationDelivery({
    Notification: windows.Notification,
    app: PACKAGED_APP,
    platform: "win32",
  });
  assert.deepEqual(windowsDelivery.status(), { status: "windows_identity_unavailable" });
  assert.deepEqual(windowsDelivery.deliver({
    key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD,
    thresholdPercent: 90,
  }), { status: "windows_identity_unavailable" });
  assert.equal(windows.state.supportCalls, 0);

  const configured = fakeNotification();
  const configuredDelivery = createDesktopNotificationDelivery({
    Notification: configured.Notification,
    app: PACKAGED_APP,
    platform: "win32",
    windowsIdentityReady: true,
  });
  assert.deepEqual(configuredDelivery.status(), { status: "ready" });
  assert.deepEqual(configuredDelivery.deliver({ key: DESKTOP_NOTIFICATION_KEYS.RESET }), {
    status: "delivered",
  });
  assert.equal(configured.state.showCalls, 1);
});

test("custom percentages reach localized native copy without a fixed 80 or 90 label", () => {
  const fake = fakeNotification();
  const delivery = createDesktopNotificationDelivery({ Notification: fake.Notification, app: PACKAGED_APP,
    platform: "win32", windowsIdentityReady: true, locale: "en-US" });
  for (const percent of [1, 37, 100]) {
    assert.deepEqual(delivery.deliver({ key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD, thresholdPercent: percent }), { status: "delivered" });
    assert.deepEqual(fake.state.constructorCalls.at(-1), { title: `Quota usage reached ${percent}%`, body: `A fresh provider-reported observation crossed the ${percent}% usage threshold.` });
  }
});


test("invalid semantic input is rejected before capability or native delivery", () => {
  const fake = fakeNotification();
  const delivery = createDesktopNotificationDelivery({
    Notification: fake.Notification,
    app: PACKAGED_APP,
    platform: "win32",
  });
  assert.throws(() => delivery.deliver({
    key: DESKTOP_NOTIFICATION_KEYS.THRESHOLD,
    thresholdPercent: 90,
    body: "arbitrary renderer text",
  }), TypeError);
  assert.equal(fake.state.supportCalls, 0);
  assert.equal(fake.state.constructorCalls.length, 0);
  assert.equal(fake.state.showCalls, 0);
});
