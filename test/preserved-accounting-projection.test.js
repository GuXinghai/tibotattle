import test from "node:test";
import assert from "node:assert/strict";
import { projectPreservedAccountingHistory } from "../src/local-companion-data.js";
import { normalizeDashboardPayload } from "../apps/web/public/data-client.js";

function receipt() {
  return { schemaVersion: "local-accounting-preserved-history-summary-v1", status: "historical_only",
    generatedAt: "2026-10-20T00:00:00.000Z", coveredAt: { startAt: "2026-09-01T00:00:00.000Z", endAt: "2026-10-20T00:00:00.000Z" },
    priceBasis: "official_api_price_equivalent_not_subscription_allowance", unknownSpeedPolicy: null,
    history: { totals: { id: "history", label: "Preserved history", events: 14, totalTokens: 12345, apiPriceEquivalentUsd: 12.5 } }, periods: [],
    sourceCacheJson: "must not be projected", privateField: "must not be projected" };
}

test("new historical receipt retains vanished-source totals and original calculation time without allowance", () => {
  const projected = projectPreservedAccountingHistory(receipt());
  assert.equal(projected.status, "historical_only");
  assert.equal(projected.computedAt, "2026-10-20T00:00:00.000Z");
  assert.equal(projected.periods[0].events, 14);
  assert.equal(projected.periods[0].totalTokens, 12345);
  assert.equal(projected.periods[0].apiPriceEquivalentUsd, 12.5);
  assert.equal(projected.sourceCacheJson, undefined);
  assert.equal(projected.allowanceCapacity, undefined);
  const browser = normalizeDashboardPayload({ mode: "real_local_evidence", accounting: { staleServe: projected } }).accounting;
  assert.equal(browser.staleServe.status, "historical_only");
  assert.equal(browser.staleServe.computedAt, projected.computedAt);
  assert.equal(browser.staleServe.priceBasis, projected.priceBasis);
  assert.equal(browser.staleServe.periods[0].apiPriceEquivalentUsd, 12.5);
});

test("migration history projection refuses old caches, incomplete facts and contradictory receipts", () => {
  for (const mutate of [
    x => { x.schemaVersion = "local-replay-safe-accounting-v0.25"; },
    x => { delete x.generatedAt; },
    x => { x.history.totals.events = null; },
    x => { x.history.totals.apiPriceEquivalentUsd = NaN; },
    x => { x.coveredAt.startAt = "2027-01-01T00:00:00Z"; },
  ]) { const value = receipt(); mutate(value); assert.equal(projectPreservedAccountingHistory(value), null); }
});
