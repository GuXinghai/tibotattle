import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import { APP_OFFICIAL_PRICE_CARDS } from "@app-usagemonitor/accounting";
import { REVIEWED_MODEL_CATALOG, REVIEWED_CODEX_MODEL_IDS, REVIEWED_MODEL_CATALOG_VERSION, assertReviewedModelCatalogCompleteness, reviewedModelIdentity, codexRequestReasoningEffort, codexCacheReasoningConfiguration } from "@app-usagemonitor/codex-catalog";
import * as browser from "../apps/web/public/codex-catalog.generated.js";
import { recognizedCodexModelId, codexModelPricingStatus, codexModelAllowanceTrack } from "../src/export/registries.js";
import { exportSchemas } from "../src/export-schema.js";

test("reviewed identity catalog covers priced OpenAI models and explicit aliases, never provider tools", () => {
  const models = REVIEWED_MODEL_CATALOG;
  assert.equal(models.every((entry) => entry.provider === "openai_codex"), true);
  const priced = new Set(APP_OFFICIAL_PRICE_CARDS.filter((card) => card.provider === "openai"
    && card.model !== "openai-provider-tools").flatMap((card) => [card.model, ...(card.aliases ?? [])]));
  assert.deepEqual(models.filter((entry) => entry.pricingStatus !== "unpriced").map((entry) => entry.id).sort(), [...priced].sort());
  assert.deepEqual(models.filter((entry) => entry.pricingStatus === "unpriced").map((entry) => entry.id), ["gpt-5.3-codex-spark", "gpt-6.1-astra"]);
  assert.equal(models.length, 45);
  for (const id of ["gpt-6.1-terra", "gpt-5.1-codex-max", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) {
    assert.equal(reviewedModelIdentity(id).priceModelId, id);
    assert.equal(reviewedModelIdentity(id).pricingStatus, "published");
  }
  assert.equal(REVIEWED_CODEX_MODEL_IDS.length, new Set(REVIEWED_CODEX_MODEL_IDS).size);
  for (const entry of models) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(recognizedCodexModelId(entry.id.toUpperCase()), entry.id);
    assert.equal(codexModelPricingStatus(entry.id), entry.pricingStatus === "unpriced" ? "known_unpriced" : "priced");
    assert.equal(codexModelAllowanceTrack(entry.id), entry.allowanceTrack);
    assert.equal(reviewedModelIdentity(entry.id), entry);
  }
  assert.notEqual(reviewedModelIdentity("gpt-5.5-codex"), reviewedModelIdentity("gpt-5.5"));
  assert.equal(reviewedModelIdentity("gpt-5.5-codex").pricingStatus, "assumed_alias");
  assert.equal(reviewedModelIdentity("gpt-5.3-codex-spark").priceModelId, null);
  for (const value of ["gpt-6t", "gpt-6-astra-private", "gpt-6.1-sol-private", "gpt-6-sol-private", "gpt-6-luna-wm", "openai-provider-tools", "gpt-5.6-sol/sensitive", null, {}]) {
    assert.equal(reviewedModelIdentity(value), null);
    assert.equal(recognizedCodexModelId(value), null);
  }
});

test("browser and current local export consume the same closed Codex catalog", () => {
  assert.deepEqual(browser.REVIEWED_MODEL_CATALOG, REVIEWED_MODEL_CATALOG);
  assert.deepEqual(browser.REVIEWED_CODEX_MODEL_IDS, REVIEWED_CODEX_MODEL_IDS);
  assert.equal(browser.REVIEWED_MODEL_CATALOG_VERSION, REVIEWED_MODEL_CATALOG_VERSION);
  assert.deepEqual(exportSchemas.usageEvent.properties.modelId.enum, ["unknown", ...REVIEWED_CODEX_MODEL_IDS]);
  const validateId = new Ajv().compile(exportSchemas.usageEvent.properties.modelId);
  for (const modelId of REVIEWED_CODEX_MODEL_IDS) {
    assert.equal(validateId(modelId), true, modelId);
    assert.deepEqual(browser.reviewedModelIdentity(modelId), reviewedModelIdentity(modelId));
  }
  for (const modelId of ["claude-sonnet-5", "gpt-6t", "o3-private", "unknown-model-content"]) {
    assert.equal(validateId(modelId), false, modelId);
    assert.equal(browser.reviewedModelIdentity(modelId), null);
  }
});

test("requested effort mapping is model-specific and does not assert cache or effective update state", () => {
  for (const [model, effort, expected] of [
    ["gpt-6-astra", "ultra", "xhigh"], ["gpt-6-astra", "max", "max"],
    ["gpt-6-astra", "xhigh", "xhigh"], ["gpt-5.6-sol", "ultra", "max"],
    ["gpt-6t", "ultra", "ultra"], ["unreviewed-model", "ultra", "ultra"],
    ["gpt-6-astra", "custom-private", null],
  ]) {
    assert.equal(codexRequestReasoningEffort(model, effort), expected);
    assert.equal(browser.codexRequestReasoningEffort(model, effort), expected);
  }
  assert.equal(codexCacheReasoningConfiguration("gpt-6-astra", "ultra"), "ultra");
  assert.equal(codexCacheReasoningConfiguration("gpt-6-astra", "xhigh"), "xhigh");
  assert.equal(codexCacheReasoningConfiguration("gpt-6-astra", "max"), "max");
  assert.equal(codexCacheReasoningConfiguration("gpt-5.6-sol", "ultra"), "max");
  assert.equal(codexCacheReasoningConfiguration("gpt-6t", "ultra"), "ultra");
  assert.equal(codexCacheReasoningConfiguration("gpt-6-astra", "unreviewed"), null);
  assert.equal(browser.codexCacheReasoningConfiguration("gpt-6-astra", "ultra"), "ultra");
});

test("the exported vocabulary contract accepts the shipped catalog and refuses broken identities", () => {
  const complete = assertReviewedModelCatalogCompleteness();
  assert.equal(complete.version, REVIEWED_MODEL_CATALOG_VERSION);
  assert.equal(complete.identityCount, REVIEWED_MODEL_CATALOG.length);
  assert.deepEqual(complete.modelIds, REVIEWED_MODEL_CATALOG.map((entry) => entry.id));
  assert.equal(Object.isFrozen(complete.identities), true);
  // A label is site-visible copy, deliberately outside the compared vocabulary.
  assert.equal(Object.hasOwn(complete.identities[0], "label"), false);
  assert.deepEqual(complete.identities[0], {
    id: REVIEWED_MODEL_CATALOG[0].id,
    provider: REVIEWED_MODEL_CATALOG[0].provider,
    allowanceTrack: REVIEWED_MODEL_CATALOG[0].allowanceTrack,
    pricingStatus: REVIEWED_MODEL_CATALOG[0].pricingStatus,
    priceModelId: REVIEWED_MODEL_CATALOG[0].priceModelId,
  });

  const entry = (overrides = {}) => Object.freeze({
    id: "gpt-x", label: "GPT X", provider: "openai_codex",
    allowanceTrack: "primary", pricingStatus: "published", priceModelId: "gpt-x",
    ...overrides,
  });
  const refuses = (catalog, pattern) =>
    assert.throws(() => assertReviewedModelCatalogCompleteness({ catalog }), pattern);
  assert.doesNotThrow(() => assertReviewedModelCatalogCompleteness({ catalog: [entry()] }));
  assert.doesNotThrow(() => assertReviewedModelCatalogCompleteness({
    catalog: [entry(), entry({ id: "gpt-x-mini", priceModelId: "gpt-x" })],
  }));
  refuses([], /non-empty array/u);
  refuses("not-a-catalog", /non-empty array/u);
  refuses([null], /must be an object/u);
  refuses([entry(), entry()], /is listed more than once/u);
  refuses([entry({ id: "GPT-X" })], /bounded lowercase identity/u);
  refuses([entry({ id: `gpt-${"x".repeat(90)}` })], /bounded lowercase identity/u);
  refuses([entry({ label: "" })], /bounded single-line label/u);
  refuses([entry({ label: "  padded  " })], /bounded single-line label/u);
  refuses([entry({ label: "line\nbreak" })], /bounded single-line label/u);
  refuses([entry({ provider: "openai" })], /unreviewed provider/u);
  refuses([entry({ allowanceTrack: "bonus" })], /unreviewed allowance track/u);
  refuses([entry({ pricingStatus: "free" })], /unreviewed pricing status/u);
  refuses([entry({ pricingStatus: "unpriced" })], /pricing status with a price identity/u);
  refuses([entry({ priceModelId: "gpt-absent" })], /prices against an unreviewed/u);
  refuses([{ ...entry() }], /is not frozen/u);
  refuses([Object.freeze({ ...entry(), extra: 1 })], /does not carry exactly/u);
});
