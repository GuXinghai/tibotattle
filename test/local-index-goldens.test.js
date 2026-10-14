import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { compareProjections } from "./helpers/local-index-report-diff.js";
import { GOLDEN_CLOCKS, readGoldenViewsFromStore } from "./helpers/local-index-goldens.js";

// The committed views are what the shipping (v1) implementation produced for
// one synthetic corpus at commit cf94e9a8. They keep the successor held to it
// after the implementation is removed. See the README beside the fixture.

const golden = JSON.parse(readFileSync(
  new URL("./fixtures/local-index-goldens/views.json", import.meta.url),
  "utf8",
));

function expectSame(label, expected, actual, minimumValues) {
  const differences = [];
  const stats = { money: 0, exact: 0 };
  compareProjections(expected, actual, "$", differences, stats);
  assert.deepEqual(
    differences.slice(0, 8),
    [],
    `${label}: ${differences.length} differences over ${stats.exact} exact and ${stats.money} money values`,
  );
  assert.ok(stats.exact + stats.money >= minimumValues, `${label}: compared ${stats.exact + stats.money} values`);
}

test("the store still produces the shipping implementation's views of the golden corpus", async () => {
  const actual = await readGoldenViewsFromStore();
  assert.equal(actual.corpus, golden.corpus, "the generator still produces the corpus the goldens were made from");
  for (const [name] of GOLDEN_CLOCKS) {
    expectSame(`report at ${name}`, golden.reports[name], actual.reports[name], 400);
    expectSame(`work usage at ${name}`, golden.work[name], actual.work[name], 40);
  }
  for (const name of ["no-ledger", "ledger"]) {
    expectSame(`calibration layer (${name})`, golden.layers[name], actual.layers[name], 300);
  }
});

test("the goldens exercise the price-sensitive branches", () => {
  const everything = golden.reports["after-the-corpus"].usage.find((period) => period.id === "all");
  assert.ok(everything.priceCardIds.some((id) => id.includes(":long")), "long-context card");
  assert.ok(everything.spark.events > 0, "Spark track");
  assert.ok(everything.pricingCoverage.unpricedEvents > 0, "an unpriced model");
  for (const speed of ["standard", "fast", "ultrafast", "unknown"]) {
    assert.ok(everything.bySpeed[speed].events > 0, `observed speed ${speed}`);
  }
  const declared = Object.values(everything.declaredSpeedWeighting)
    .flatMap((row) => Object.values(row));
  assert.ok(declared.some((cell) => cell.events > 0), "the declared ledger covered events");
  assert.ok(golden.layers.ledger.weeklyCalibrationInput.retainedUsageEvents > 1_000);
});
