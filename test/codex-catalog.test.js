import test from "node:test";
import assert from "node:assert/strict";
import { CODEX_PLAN_TYPES, CODEX_PLAN_DISPLAY_NAMES } from "../packages/codex-catalog/index.js";
import * as catalog from "@app-usagemonitor/codex-catalog";
import * as browser from "../apps/web/public/codex-catalog.generated.js";
import { checkCodexBrowserMirror } from "../scripts/generate-codex-browser-mirror.js";
import { normalizeDashboardPayload } from "../apps/web/public/data-client.js";

test("Codex plan identities retain separate research plans and unknown sentinel", () => {
  assert.equal(CODEX_PLAN_DISPLAY_NAMES.prolite, "Pro 100");
  assert.equal(CODEX_PLAN_DISPLAY_NAMES.pro, "Pro 200");
  assert.equal(CODEX_PLAN_DISPLAY_NAMES.promax, "Pro 500");
  assert.equal(CODEX_PLAN_DISPLAY_NAMES.sci, "Academic Researchers");
  assert.equal(CODEX_PLAN_DISPLAY_NAMES.sci_plus, "Academic Researchers Plus");
  assert.equal(CODEX_PLAN_TYPES.filter((value) => value === "unknown").length, 1);
  assert.equal(Object.hasOwn(CODEX_PLAN_DISPLAY_NAMES, "unknown"), false);
  assert.equal(new Set(CODEX_PLAN_TYPES).size, CODEX_PLAN_TYPES.length);
});

test("local browser catalog has exactly the reviewed vocabulary and no upload contract", async () => {
  await checkCodexBrowserMirror();
  const { assertReviewedModelCatalogCompleteness, ...vocabulary } = catalog;
  assert.equal(assertReviewedModelCatalogCompleteness().identityCount, 45);
  assert.deepEqual(Object.keys(browser), Object.keys(vocabulary).sort());
  for (const [key, value] of Object.entries(vocabulary)) {
    if (typeof value !== "function") assert.deepEqual(browser[key], value, key);
  }
  for (const input of [null, {}, "private-model/path", "unreviewed-model"]) {
    assert.equal(browser.reviewedModelIdentity(input), null);
  }
});

test("research plans survive browser quota normalization with observed percentages only", () => {
  for (const planType of ["sci", "sci_plus"]) {
    const payload = normalizeDashboardPayload({ timeline: { quota: [{
      observedAt: "2026-10-31T00:00:00.000Z", usedPercent: 17,
      remainingPercent: 83, planType,
    }] } });
    assert.equal(payload.timeline.quota[0].planType, planType);
    assert.equal(payload.timeline.quota[0].usedPercent, 17);
  }
});
