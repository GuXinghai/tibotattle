import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_UNKNOWN_SPEED_POLICY, validateUnknownSpeedPolicy, unknownSpeedScenario,
  unknownSpeedCalculationIdentity, mixUnknownSpeedUsd } from "../src/unknown-speed-policy.js";
import { codexPrimaryAllowanceBasis } from "../src/codex-primary-allowance-basis.js";

test("unknown speed assumptions are closed, bounded and never inferred", () => {
  for (const value of [null, {}, { mode: "custom", customFastRatioBps: null },
    { mode: "custom", customFastRatioBps: -1 }, { mode: "custom", customFastRatioBps: 10001 },
    { mode: "custom", customFastRatioBps: 1.5 }, { mode: "custom", customFastRatioBps: NaN },
    { mode: "custom", customFastRatioBps: "300" }, { ...DEFAULT_UNKNOWN_SPEED_POLICY, extra: 1 }]) {
    assert.throws(() => validateUnknownSpeedPolicy(value));
  }
  const input = { mode: "custom", customFastRatioBps: 300 };
  const validated = validateUnknownSpeedPolicy(input);
  input.customFastRatioBps = 500;
  assert.equal(validated.customFastRatioBps, 300);
  assert.ok(Object.isFrozen(validated));
});

test("mixture applies before calibration and preserves exact endpoints and resolved speeds", () => {
  const custom = ratio => ({ mode: "custom", customFastRatioBps: ratio });
  assert.equal(mixUnknownSpeedUsd(1, 2, custom(300)), 1.03);
  assert.equal(mixUnknownSpeedUsd(1.123456789, 2.987654321, custom(0)), 1.123456789);
  assert.equal(mixUnknownSpeedUsd(1.123456789, 2.987654321, custom(10000)), 2.987654321);
  for (const ratio of [0, 1, 300, 5000, 9999, 10000]) {
    assert.equal(mixUnknownSpeedUsd(7.123456789, 7.123456789, custom(ratio)), 7.123456789);
    const amount = mixUnknownSpeedUsd(1, 2, custom(ratio));
    assert.ok(amount >= 1 && amount <= 2);
  }
  assert.equal(mixUnknownSpeedUsd(null, 2, custom(300)), null);
});

test("calculation identity ignores inactive stored ratios and binds active custom ratios", () => {
  assert.equal(unknownSpeedScenario(DEFAULT_UNKNOWN_SPEED_POLICY), "unresolved_as_standard");
  assert.equal(unknownSpeedCalculationIdentity(DEFAULT_UNKNOWN_SPEED_POLICY),
    unknownSpeedCalculationIdentity({ mode: "standard", customFastRatioBps: 300 }));
  const a = codexPrimaryAllowanceBasis("unresolved_as_custom", { mode: "custom", customFastRatioBps: 300 });
  const b = codexPrimaryAllowanceBasis("unresolved_as_custom", { mode: "custom", customFastRatioBps: 301 });
  assert.notEqual(a.basisId, b.basisId);
  assert.throws(() => codexPrimaryAllowanceBasis("unresolved_as_custom"));
});
