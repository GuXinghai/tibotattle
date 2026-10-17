import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { compareProjections } from "./helpers/local-index-report-diff.js";
import { GOLDEN_CLOCKS, readGoldenViewsFromStore } from "./helpers/local-index-goldens.js";
import { SPEED_REPORT_FIELDS } from "./helpers/local-index-pricing-oracle.js";

// The committed views are what the shipping (v1) implementation produced for
// one synthetic corpus at commit cf94e9a8. They keep the successor held to it
// after the implementation is removed. See the README beside the fixture.

const golden = JSON.parse(readFileSync(
  new URL("./fixtures/local-index-goldens/views.json", import.meta.url),
  "utf8",
));
let views;
const readViews = () => views ??= readGoldenViewsFromStore();

// Only the reviewed additive fields leave this historical projection. New or
// changed fields elsewhere still fail the frozen contract; the removed values
// are independently checked below, never copied into a regenerated fixture.
function standardReportView(report) {
  const copy = structuredClone(report);
  for (const period of copy.usage) {
    for (const group of [period, period.spark]) {
      for (const row of [group, ...group.byModel, ...group.modelUsage]) {
        for (const field of SPEED_REPORT_FIELDS) delete row[field];
      }
    }
  }
  return copy;
}

function speedFields(row) {
  return Object.fromEntries(SPEED_REPORT_FIELDS.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]]));
}

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

test("the frozen Standard reports, work identities and calibration remain unchanged", async () => {
  const actual = await readViews();
  assert.equal(actual.corpus, golden.corpus, "the generator still produces the corpus the goldens were made from");
  for (const [name] of GOLDEN_CLOCKS) {
    expectSame(`Standard report at ${name}`, golden.reports[name], standardReportView(actual.reports[name]), 400);
    expectSame(`per-event Standard work at ${name}`, golden.work[name], actual.standardWork[name], 40);
  }
  for (const name of ["no-ledger", "ledger"]) {
    expectSame(`calibration layer (${name})`, golden.layers[name], actual.layers[name], 300);
  }
});

test("speed-tier report totals, provenance, model amounts and components equal the per-event ledger", async () => {
  const actual = await readViews();
  const differences = [];
  const stats = { money: 0, exact: 0 };
  for (const [name] of GOLDEN_CLOCKS) {
    for (const period of actual.reports[name].usage) {
      const expected = actual.speedReports[name][period.id];
      for (const [label, group, reference] of [["normal", period, expected], ["Spark", period.spark, expected.spark]]) {
        const expectedModels = reference.byModel;
        const expectedAliases = label === "normal" ? { ...reference.byModel, ...expected.spark.byModel } : reference.byModel;
        compareProjections({ ...speedFields(reference), byModel: expectedModels, modelUsage: expectedAliases }, {
          ...speedFields(group),
          byModel: Object.fromEntries(group.byModel.map((row) => [row.model, speedFields(row)])),
          modelUsage: Object.fromEntries(group.modelUsage.map((row) => [row.model, speedFields(row)])),
        }, `${name}/${period.id}/${label}`, differences, stats);
      }
    }
  }
  assert.deepEqual(differences.slice(0, 8), [], `${differences.length} speed-tier differences across both clocks and every period/model/component`);
});

test("every speed-priced work cell and coverage count equals independent per-event pricing", async () => {
  const actual = await readViews();
  const differences = [];
  const stats = { money: 0, exact: 0 };
  for (const [name] of GOLDEN_CLOCKS) {
    compareProjections(actual.speedWork[name], actual.work[name], `speed-priced work at ${name}`, differences, stats);
    for (const id of ["24h", "7d", "30d", "all"]) {
      const before = golden.work[name][id];
      const after = actual.work[name][id];
      assert.deepEqual(after.scopes, before.scopes, "pricing cannot change scope event counts");
      for (const [scope, snapshot] of Object.entries(after.snapshots)) {
        for (const key of ["events", "tokens", "incomplete"]) {
          assert.equal(snapshot.totals[key], before.snapshots[scope].totals[key], `${name}/${id}/${key}`);
        }
      }
    }
  }
  assert.deepEqual(differences.slice(0, 8), [], `${differences.length} speed-priced cell/coverage differences across both clocks`);
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
