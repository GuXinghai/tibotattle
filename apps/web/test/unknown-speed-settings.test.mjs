import assert from "node:assert/strict";
import test from "node:test";
import { parseSettingsFastPercent, normalizeSettingsState } from "../public/electron-settings.js";

test("Fast proportion preserves two decimal places as integer basis points", () => {
  for (const [input, expected] of [["0", 0], ["3", 300], ["3.03", 303], ["99.99", 9999], ["100.00", 10000]]) {
    assert.equal(parseSettingsFastPercent(input), expected);
  }
  for (const input of ["", " ", "-1", "100.01", "3.001", "NaN", "Infinity", "1e2", null]) {
    assert.equal(parseSettingsFastPercent(input), null);
  }
});

test("settings projection preserves the saved policy and does not invent unknown preferences", () => {
 const policy = { mode: "custom", customFastRatioBps: 303 };
 assert.deepEqual(normalizeSettingsState({ settings: { unknownSpeedPolicy: policy } }).unknownSpeedPolicy, policy);
 assert.equal(normalizeSettingsState({ settings: {} }).unknownSpeedPolicy, null);
 assert.equal(normalizeSettingsState({ settings: { unknownSpeedPolicy: { mode: "custom", customFastRatioBps: null } } }).unknownSpeedPolicy, null);
});
