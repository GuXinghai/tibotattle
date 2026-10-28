import test from "node:test";
import assert from "node:assert/strict";
import { mixUsdByBasisPoints } from "../index.js";

test("USD mixtures preserve endpoints and equal values exactly", () => {
  assert.equal(mixUsdByBasisPoints(0.123456789123, 0.8, 0), 0.123456789123);
  assert.equal(mixUsdByBasisPoints(0.1, 0.876543219876, 10_000), 0.876543219876);
  for (const ratio of [0, 1, 5000, 9999, 10_000]) {
    assert.equal(mixUsdByBasisPoints(0.123456789123, 0.123456789123, ratio), 0.123456789123);
  }
});

test("USD mixtures round once at nanodollar precision with half-up ties", () => {
  assert.equal(mixUsdByBasisPoints(1e-9, 2e-9, 5000), 2e-9);
  assert.equal(mixUsdByBasisPoints(1e-9, 2e-9, 4999), 1e-9);
  assert.equal(mixUsdByBasisPoints(2e-9, 4e-9, 5000), 3e-9);
  assert.equal(mixUsdByBasisPoints(1.2, 3.4, 2500), 1.75);
});

test("USD mixtures preserve unavailable input and reject invalid ratios or excessive precision", () => {
  for (const bad of [null, undefined, "1", NaN, Infinity, -1]) {
    assert.equal(mixUsdByBasisPoints(bad, 1, 3000), null);
    assert.equal(mixUsdByBasisPoints(1, bad, 3000), null);
  }
  for (const bad of [null, "5000", NaN, Infinity, -1, 10_001, 0.5]) {
    assert.throws(() => mixUsdByBasisPoints(1, 2, bad), TypeError);
  }
  assert.throws(() => mixUsdByBasisPoints(1e12, 2, 5000), RangeError);
});

test("USD mixtures stay between endpoints across the full basis-point range", () => {
  let previous = -1;
  for (let ratio = 0; ratio <= 10_000; ratio++) {
    const amount = mixUsdByBasisPoints(0.000000003, 0.000000019, ratio);
    assert.ok(amount >= previous && amount >= 0.000000003 && amount <= 0.000000019);
    previous = amount;
  }
});
