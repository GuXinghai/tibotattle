import assert from "node:assert/strict";
import test from "node:test";
import { prepareUsageStateControls, classifyUsageStateControlsFailure } from "../scripts/lib/usage-state-controls.mjs";
import { DESKTOP_DEFAULT_SETTINGS, validateDesktopSettingsSnapshot } from "../apps/electron/desktop-contract.js";
import { DESKTOP_AUTOMATIC_REFRESH_CADENCE_SCHEMA_VERSION } from "../apps/electron/desktop-automatic-refresh-cadence.js";
import { USAGE_STATE_CONTROL_INPUTS } from "../scripts/lib/usage-state-bundle.mjs";
const id = "00000000-0000-4000-8000-000000000002";
const fixture = () => ({ controls: { codexHomes: { activityRoots: [
  { rootId: id, kind: "custom", path: "C:\\synthetic-selected-source", enabled: true },
  ...structuredClone(DESKTOP_DEFAULT_SETTINGS.codexHomes.activityRoots),
], primaryRootId: id }, refreshPaused: true, refreshIntervalSeconds: 120 },
cadence: { schemaVersion: DESKTOP_AUTOMATIC_REFRESH_CADENCE_SCHEMA_VERSION,
  lastAutomaticDetailedAtMs: 1792886400000, reservationToken: id } });
const category = code => error => classifyUsageStateControlsFailure(error) === `USAGE_STATE_CONTROLS_${code}`;

test("preserves source-root order, IDs, path, primary semantics, pause and cadence reservation", () => {
  const input = fixture(), before = structuredClone(input);
  const result = prepareUsageStateControls(input);
  assert.deepEqual(result.privateTargets.desktopSettings.codexHomes, input.controls.codexHomes);
  assert.equal(result.privateTargets.desktopSettings.refreshPaused, true);
  assert.equal(result.privateTargets.desktopSettings.refreshIntervalSeconds, 120);
  assert.deepEqual(result.privateTargets.cadence, input.cadence);
  assert.deepEqual(validateDesktopSettingsSnapshot(result.privateTargets.desktopSettings), result.privateTargets.desktopSettings);
  assert.deepEqual(input, before);
  assert.deepEqual(Object.keys(input.controls), USAGE_STATE_CONTROL_INPUTS[0].fields);
  assert.ok(!JSON.stringify(result.summary).includes("synthetic-selected-source"));
  assert.ok(!JSON.stringify(result.summary).includes(id));
});

test("all unrelated target preferences originate only in current defaults", () => {
  const settings = prepareUsageStateControls(fixture()).privateTargets.desktopSettings;
  for (const key of Object.keys(DESKTOP_DEFAULT_SETTINGS).filter(key => !USAGE_STATE_CONTROL_INPUTS[0].fields.includes(key))) {
    assert.deepEqual(settings[key], DESKTOP_DEFAULT_SETTINGS[key]);
  }
  for (const extra of ["appearance", "notifications", "language", "startAtLogin", "tray", "background", "x", "schemaVersion"]) {
    const input = fixture(); input.controls[extra] = "not-imported";
    assert.throws(() => prepareUsageStateControls(input), category("CONTROLS_INVALID"));
  }
});

test("never defaults missing pause, source controls or cadence evidence", () => {
  for (const key of USAGE_STATE_CONTROL_INPUTS[0].fields) {
    const input = fixture(); delete input.controls[key];
    assert.throws(() => prepareUsageStateControls(input), category("CONTROLS_INVALID"));
  }
  for (const value of [null, undefined, {}]) {
    const input = fixture(); input.cadence = value;
    assert.throws(() => prepareUsageStateControls(input), category("CADENCE_INVALID"));
  }
});

test("explicit unpaused and disabled-interval states remain distinct", () => {
  for (const paused of [true, false]) for (const interval of [-1, 60, 300]) {
    const input = fixture(); input.controls.refreshPaused = paused; input.controls.refreshIntervalSeconds = interval;
    const settings = prepareUsageStateControls(input).privateTargets.desktopSettings;
    assert.equal(settings.refreshPaused, paused); assert.equal(settings.refreshIntervalSeconds, interval);
  }
});

test("invalid controls and primary-root ambiguity fail without discovering source paths", () => {
  for (const mutate of [
    input => { input.controls.refreshPaused = "true"; },
    input => { input.controls.refreshIntervalSeconds = 1; },
    input => { input.controls.codexHomes.primaryRootId = "00000000-0000-4000-8000-000000000003"; },
    input => { input.controls.codexHomes.activityRoots.push(input.controls.codexHomes.activityRoots[0]); },
    input => { input.controls.codexHomes.activityRoots[0].enabled = false; },
    input => { input.controls.codexHomes.activityRoots[0].path = "relative"; },
    input => { input.controls.codexHomes.activityRoots = new Array(1); },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => prepareUsageStateControls(input), category("CONTROLS_INVALID"));
  }
});

test("unknown cadence schema and impossible reservation refuse instead of resetting", () => {
  for (const mutate of [
    input => { input.cadence.schemaVersion = "unknown"; },
    input => { input.cadence.lastAutomaticDetailedAtMs = null; },
    input => { input.cadence.lastAutomaticDetailedAtMs = -1; },
    input => { input.cadence.reservationToken = "invalid"; },
    input => { input.cadence.extra = true; },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => prepareUsageStateControls(input), category("CADENCE_INVALID"));
  }
  const input = fixture(); input.cadence.lastAutomaticDetailedAtMs = null; input.cadence.reservationToken = null;
  assert.deepEqual(prepareUsageStateControls(input).privateTargets.cadence, input.cadence);
});

test("closed input and nested accessors refuse without evaluating private context", () => {
  let called = false;
  const getter = { get() { called = true; throw new Error("private-context"); } };
  for (const mutate of [
    input => { Object.defineProperty(input, "controls", getter); },
    input => { Object.defineProperty(input.controls, "codexHomes", getter); },
    input => { Object.defineProperty(input.controls.codexHomes.activityRoots[0], "path", getter); },
    input => { Object.defineProperty(input.cadence, "reservationToken", getter); },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => prepareUsageStateControls(input));
  }
  assert.equal(called, false);
  assert.throws(() => prepareUsageStateControls({ ...fixture(), persist: true }), category("CONFIGURATION_INVALID"));
  assert.equal(classifyUsageStateControlsFailure({ code: "USAGE_STATE_CONTROLS_CANCELLED" }), "USAGE_STATE_CONTROLS_UNAVAILABLE");
});

test("cancellation, retries and input serialization neither resume observation nor save anything", () => {
  const input = fixture(), controller = new AbortController(); controller.abort();
  assert.throws(() => prepareUsageStateControls({ ...input, signal: controller.signal }), category("CANCELLED"));
  const result = prepareUsageStateControls(input);
  assert.deepEqual(result, prepareUsageStateControls(JSON.parse(JSON.stringify(input))));
  assert.equal(result.summary.persistence, "not_performed");
  assert.ok(Object.isFrozen(result.privateTargets.desktopSettings.codexHomes.activityRoots[0]));
  assert.ok(Object.isFrozen(result.privateTargets.cadence));
});
