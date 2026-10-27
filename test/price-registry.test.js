import test from "node:test";
import assert from "node:assert/strict";
import { calculateCost, compilePriceCatalog } from "runcost/browser";
import {
  APP_OFFICIAL_PRICE_CARDS,
  APP_PRICE_REGISTRY_MANIFEST,
  OPENAI_PRICE_EVIDENCE_START_DATE,
  priceCodexUsageEvent,
  priceUsageEvent,
} from "../packages/accounting/index.js";
import {
  APP_PRICE_REGISTRY_SHA256,
  NORMALIZED_PRICE_EVIDENCE_ROWS,
  OPENAI_OFFICIAL_PRICE_CARDS,
  PROVIDER_TOOL_PRICE_CARDS,
  addOfficialPriceRegistry,
  validateOfficialPriceRegistry,
} from "../packages/accounting/src/price-registry.js";
import { sha256Json } from "./helpers/pricing-hash.js";

// Registry-content tests use RunCost directly. Public timestamp and exact-tier
// policy is asserted separately through the accounting package below.
function price({ provider, model, tier = "standard", pricedAt = "2026-07-26", components, totalInputTokens }) {
  return calculateCost({
    usageLedger: {
      schema_version: "0.1",
      provider,
      surface: "openai.responses",
      model: { requested: model },
      context: {
        service_tier: tier,
        region: "global",
        priced_at: pricedAt,
        ...(totalInputTokens === undefined ? {} : { total_input_tokens: String(totalInputTokens) }),
      },
      components: Object.entries(components).map(([name, quantity]) => ({
        name,
        quantity: String(quantity),
        unit: "token",
      })),
    },
    priceCards: compilePriceCatalog(APP_OFFICIAL_PRICE_CARDS),
    // Compatibility mode returns RunCost's structured warnings so the registry's
    // intentionally unpriced boundaries can be asserted below. Production callers
    // can use strict mode to turn the same warnings into failures.
    mode: "compatibility",
  });
}

test("Terra 6.1 appends independent cards without changing existing price evidence", () => {
  const cards = OPENAI_OFFICIAL_PRICE_CARDS.filter(card => card.model === "gpt-6.1-terra");
  assert.equal(cards.length, 8);
  assert.equal(sha256Json(NORMALIZED_PRICE_EVIDENCE_ROWS.openaiTerra61), cards[0].metadata.provenance.evidence_sha256);
  assert.equal(sha256Json(APP_OFFICIAL_PRICE_CARDS.filter(card => card.model !== "gpt-6.1-terra")),
    "14d655a17d41e263ff98cee5028e9ffd50c7c35e1f6015c2194541858dff4bdf");
  assert.ok(cards.every(card => card.effective.from === undefined
    && card.metadata.provenance.vendor_effective_from === null));
});

test("registry validates and preserves exact decimal strings and provenance", () => {
  assert.equal(validateOfficialPriceRegistry(), APP_OFFICIAL_PRICE_CARDS);
  assert.equal(APP_OFFICIAL_PRICE_CARDS.every((card) => card.provider === "openai"), true);
  assert.equal(OPENAI_OFFICIAL_PRICE_CARDS.length, 178);
  assert.equal(PROVIDER_TOOL_PRICE_CARDS.length, 1);
  const batch54 = OPENAI_OFFICIAL_PRICE_CARDS.find((card) => card.model === "gpt-5.4" && card.service_tier === "batch");
  assert.equal(batch54.components.find((item) => item.usage_component === "input_cache_read_tokens").price.amount, "0.13");
  assert.match(batch54.metadata.provenance.evidence_sha256, /^[a-f0-9]{64}$/);
  assert.match(APP_PRICE_REGISTRY_SHA256, /^[a-f0-9]{64}$/);
  assert.equal(APP_PRICE_REGISTRY_MANIFEST.sha256, APP_PRICE_REGISTRY_SHA256);
  assert.equal(APP_PRICE_REGISTRY_MANIFEST.sources.length, 6);
  assert.equal(batch54.metadata.provenance.vendor_effective_from, null);
  assert.equal(OPENAI_PRICE_EVIDENCE_START_DATE, "2026-07-26");
  assert.equal(batch54.effective.from, undefined);
  assert.equal(
    batch54.metadata.provenance.evidence_urls.some((url) => url.endsWith("/models/gpt-5.4")),
    true,
  );
  assert.equal(
    sha256Json(NORMALIZED_PRICE_EVIDENCE_ROWS.openai),
    APP_PRICE_REGISTRY_MANIFEST.sources.find((source) => source.provider === "openai").evidenceSha256,
  );
  assert.equal(sha256Json(APP_OFFICIAL_PRICE_CARDS), APP_PRICE_REGISTRY_SHA256);
  assert.equal(
    sha256Json(NORMALIZED_PRICE_EVIDENCE_ROWS.openaiAstra),
    APP_PRICE_REGISTRY_MANIFEST.sources.find((source) => source.evidenceVersion === "openai-astra-api-pricing-reviewed-2026-09-03").evidenceSha256,
  );
  // Later model additions must not change the provenance bytes of legacy cards.
  assert.equal(
    sha256Json(APP_OFFICIAL_PRICE_CARDS.filter((card) => ![
      "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-5.1-codex-max", "gpt-6.1-terra",
    ].includes(card.model))),
    "ed6259cf730144202bf1e427fe719eef92516a4d68188d6a7979a7f4654105ba",
  );
});

test("GPT-5.1 Codex Max has an independent historical Standard card and no invented service tiers", () => {
  const cards = APP_OFFICIAL_PRICE_CARDS.filter((card) => card.model === "gpt-5.1-codex-max");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].aliases, undefined);
  assert.deepEqual(cards[0].effective, {});
  assert.equal(cards[0].source.url, "https://developers.openai.com/api/docs/models/gpt-5.1-codex-max");
  assert.equal(cards[0].metadata.provenance.vendor_effective_from, null);
  assert.equal(sha256Json(NORMALIZED_PRICE_EVIDENCE_ROWS.openaiCodexMax), cards[0].metadata.provenance.evidence_sha256);
  // A new review must not rewrite any previously shipped price/provenance bytes.
  assert.equal(sha256Json(APP_OFFICIAL_PRICE_CARDS.filter((card) => !["gpt-5.1-codex-max", "gpt-6.1-terra"].includes(card.model))),
    "8b0ce65aa2c6d9eda831b9da045bc6d69ed9379f59adbcc61e9986882d878deb");
  for (const pricedAt of ["2025-11-22", "2026-10-19"]) {
    const result = price({ provider: "openai", model: "gpt-5.1-codex-max", pricedAt,
      totalInputTokens: 400_000, components: {
        input_uncached_tokens: 1_000_000, input_cache_read_tokens: 1_000_000, output_text_tokens: 1_000_000,
      } });
    assert.equal(result.total, "11.375");
    assert.deepEqual(result.warnings, []);
  }
  for (const tier of ["priority", "ultrafast", "batch", "flex"]) {
    const result = price({ provider: "openai", model: "gpt-5.1-codex-max", tier,
      components: { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 } });
    assert.ok(result.warnings.some((warning) => warning.code === "service_tier_unsupported"));
  }
});

test("Astra retains eight original cards with a strict above-272K boundary and independent release provenance", () => {
  const expected = {
    standard: { short: ["10", "1", "12.5", "50"], long: ["20", "2", "25", "75"] },
    batch: { short: ["5", "0.5", "6.25", "25"], long: ["10", "1", "12.5", "37.5"] },
    flex: { short: ["5", "0.5", "6.25", "25"], long: ["10", "1", "12.5", "37.5"] },
    priority: { short: ["20", "2", "25", "100"], long: ["40", "4", "50", "150"] },
  };
  const names = ["input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens", "output_text_tokens"];
  assert.equal(OPENAI_OFFICIAL_PRICE_CARDS.filter((card) => card.model === "gpt-6-astra"
    && card.service_tier !== "ultrafast").length, 8);
  for (const [tier, bands] of Object.entries(expected)) {
    for (const totalInputTokens of [271_999, 272_000, 272_001]) {
      const values = totalInputTokens > 272_000 ? bands.long : bands.short;
      for (const [index, name] of names.entries()) {
        const result = price({ provider: "openai", model: "gpt-6-astra", tier,
          pricedAt: "2026-09-03", totalInputTokens, components: { [name]: 1_000_000 } });
        assert.equal(result.total, values[index], `${tier}/${totalInputTokens}/${name}`);
        assert.deepEqual(result.warnings, []);
      }
    }
  }
  const card = OPENAI_OFFICIAL_PRICE_CARDS.find((item) => item.model === "gpt-6-astra");
  assert.deepEqual(card.effective, { from: "2026-09-03" });
  assert.equal(card.metadata.provenance.vendor_effective_from, "2026-09-03");
  assert.equal(card.source.retrieved_at, "2026-09-04T02:30:56Z");
  assert.equal(card.aliases, undefined);
  assert.ok(card.metadata.provenance.evidence_urls.includes("https://developers.openai.com/api/docs/models/gpt-6-astra"));
  for (const request of [
    { model: "gpt-6-astra", pricedAt: "2026-09-02", totalInputTokens: 1_000 },
    { model: "gpt-6t", pricedAt: "2026-09-03", totalInputTokens: 1_000 },
  ]) {
    const result = price({ provider: "openai", ...request, components: { input_uncached_tokens: 1_000 } });
    assert.notEqual(result.warnings.length, 0, JSON.stringify(request));
  }
});

test("Sol and Luna retain exact launch prices across every tier, component, and context boundary", () => {
  const expected = {
    "gpt-6-sol": {
      standard: { short: ["2", "0.2", "2.5", "10"], long: ["4", "0.4", "5", "15"] },
      batch: { short: ["1", "0.1", "1.25", "5"], long: ["2", "0.2", "2.5", "7.5"] },
      flex: { short: ["1", "0.1", "1.25", "5"], long: ["2", "0.2", "2.5", "7.5"] },
      priority: { short: ["4", "0.4", "5", "20"], long: ["8", "0.8", "10", "30"] },
    },
    "gpt-6-luna": {
      standard: { short: ["0.1", "0.01", "0.125", "0.5"], long: ["0.2", "0.02", "0.25", "0.75"] },
      batch: { short: ["0.05", "0.005", "0.0625", "0.25"], long: ["0.1", "0.01", "0.125", "0.375"] },
      flex: { short: ["0.05", "0.005", "0.0625", "0.25"], long: ["0.1", "0.01", "0.125", "0.375"] },
      priority: { short: ["0.2", "0.02", "0.25", "1"], long: ["0.4", "0.04", "0.5", "1.5"] },
    },
  };
  const names = ["input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens", "output_text_tokens"];
  for (const [model, tiers] of Object.entries(expected)) {
    assert.equal(OPENAI_OFFICIAL_PRICE_CARDS.filter((card) => card.model === model).length, 8);
    for (const [tier, bands] of Object.entries(tiers)) {
      for (const totalInputTokens of [271_999, 272_000, 272_001]) {
        const values = totalInputTokens > 272_000 ? bands.long : bands.short;
        for (const [index, name] of names.entries()) {
          const result = price({ provider: "openai", model, tier, pricedAt: "2026-09-22",
            totalInputTokens, components: { [name]: 1_000_000 } });
          assert.equal(result.total, values[index], `${model}/${tier}/${totalInputTokens}/${name}`);
          assert.deepEqual(result.warnings, []);
        }
      }
    }
    const card = OPENAI_OFFICIAL_PRICE_CARDS.find((item) => item.model === model);
    assert.deepEqual(card.effective, { from: "2026-09-22" });
    assert.equal(card.metadata.provenance.vendor_effective_from, "2026-09-22");
    assert.equal(card.source.retrieved_at, "2026-09-22T18:54:35Z");
    assert.equal(card.aliases, undefined);
    assert.ok(card.metadata.provenance.evidence_urls.includes(`https://developers.openai.com/api/docs/models/${model}`));
    for (const request of [
      { model, pricedAt: "2026-09-21", totalInputTokens: 1_000 },
      { model: `${model}-preview`, pricedAt: "2026-09-22", totalInputTokens: 1_000 },
      { model: `${model}-wm`, pricedAt: "2026-09-22", totalInputTokens: 1_000 },
      { model, tier: "turbo", pricedAt: "2026-09-22", totalInputTokens: 1_000 },
    ]) {
      const result = price({ provider: "openai", ...request, components: { input_uncached_tokens: 1_000 } });
      assert.notEqual(result.warnings.length, 0, JSON.stringify(request));
    }
  }
  assert.equal(sha256Json(NORMALIZED_PRICE_EVIDENCE_ROWS.openaiSolLuna),
    APP_PRICE_REGISTRY_MANIFEST.sources.find((source) => source.evidenceVersion === "openai-sol-luna-api-pricing-reviewed-2026-09-22").evidenceSha256);
  // Cards predating the Sol/Luna and Codex Max additions retain their exact bytes.
  assert.equal(sha256Json(APP_OFFICIAL_PRICE_CARDS.filter((card) => ![
    "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-5.1-codex-max", "gpt-6.1-terra",
  ].includes(card.model) && card.service_tier !== "ultrafast")),
    "e2762f5bb37bf579845983fef7c275130547e43b8d63536aaa684c702caa7da1");
});

test("Sol 6.1 and Astra Ultrafast price every published component at the release and context boundaries", () => {
  const expected = {
    "gpt-6.1-sol": {
      standard: { short: ["2", "0.1", "2.5", "10"], long: ["4", "0.2", "5", "15"] },
      batch: { short: ["1", "0.05", "1.25", "5"], long: ["2", "0.1", "2.5", "7.5"] },
      flex: { short: ["1", "0.05", "1.25", "5"], long: ["2", "0.1", "2.5", "7.5"] },
      priority: { short: ["4", "0.2", "5", "20"], long: ["8", "0.4", "10", "30"] },
    },
    "gpt-6-astra": {
      ultrafast: { short: ["60", "6", "75", "300"], long: ["120", "12", "150", "450"] },
    },
  };
  const componentNames = ["input_uncached_tokens", "input_cache_read_tokens", "input_cache_write_tokens", "output_text_tokens"];
  for (const [model, tiers] of Object.entries(expected)) {
    for (const [tier, bands] of Object.entries(tiers)) {
      for (const totalInputTokens of [271_999, 272_000, 272_001]) {
        const values = totalInputTokens > 272_000 ? bands.long : bands.short;
        for (const [index, name] of componentNames.entries()) {
          const result = price({ provider: "openai", model, tier, pricedAt: "2026-09-29",
            totalInputTokens, components: { [name]: 1_000_000 } });
          assert.equal(result.total, values[index], `${model}/${tier}/${totalInputTokens}/${name}`);
          assert.deepEqual(result.warnings, []);
        }
        const beforeLaunch = price({ provider: "openai", model, tier, pricedAt: "2026-09-28",
          totalInputTokens, components: { input_uncached_tokens: 1_000_000 } });
        assert.equal(beforeLaunch.total, "0");
        assert.notEqual(beforeLaunch.warnings.length, 0);
      }
    }
  }
  const sourceVersion = "openai-sol61-ultrafast-api-pricing-reviewed-2026-09-29";
  const newCards = OPENAI_OFFICIAL_PRICE_CARDS.filter((card) => card.source.version === sourceVersion);
  assert.equal(newCards.length, 10);
  for (const card of newCards) {
    assert.deepEqual(card.effective, { from: "2026-09-29" });
    assert.equal(card.metadata.provenance.vendor_effective_from, "2026-09-29");
    assert.equal(card.source.retrieved_at, "2026-09-29T18:16:22Z");
    assert.equal(card.aliases, undefined);
    assert.ok(card.metadata.provenance.evidence_urls.includes(`https://developers.openai.com/api/docs/models/${card.model}`));
  }
  assert.equal(sha256Json(NORMALIZED_PRICE_EVIDENCE_ROWS.openaiSol61Ultrafast),
    APP_PRICE_REGISTRY_MANIFEST.sources.find((source) => source.evidenceVersion === sourceVersion).evidenceSha256);
  // Every previously shipped card, including each old Astra tier, is byte-stable.
  assert.equal(sha256Json(APP_OFFICIAL_PRICE_CARDS.filter((card) => card.source.version !== sourceVersion && !["gpt-5.1-codex-max", "gpt-6.1-terra"].includes(card.model))),
    "24833c8b5df9da3221c40bedbff12aaab5101da25a79876b2a91b4800b062d75");
});

test("unpublished Ultrafast model pairs and unreviewed Sol 6.1 aliases remain unpriced", () => {
  for (const model of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"]) {
    assert.equal(OPENAI_OFFICIAL_PRICE_CARDS.some((card) => card.model === model
      && card.service_tier === "ultrafast"), false);
  }
  for (const model of ["gpt-6.1-sol-preview", "gpt-6.1-sol-wm"]) {
    const result = price({ provider: "openai", model, pricedAt: "2026-09-29",
      totalInputTokens: 1_000, components: { input_uncached_tokens: 1_000_000 } });
    assert.equal(result.total, "0");
    assert.notEqual(result.warnings.length, 0);
  }
});

test("exact provider tool units use official call prices without pricing client wrappers", () => {
  const openAi = calculateCost({
    usageLedger: {
      schema_version: "0.1",
      provider: "openai",
      surface: "openai.responses",
      model: { requested: "gpt-5.6-luna" },
      context: { service_tier: "standard", priced_at: "2026-07-26" },
      components: [
        { name: "web_search_units", quantity: "1000", unit: "search" },
        { name: "file_search_units", quantity: "1000", unit: "call" },
      ],
    },
    priceCards: compilePriceCatalog(APP_OFFICIAL_PRICE_CARDS),
    mode: "compatibility",
  });
  assert.equal(openAi.total, "12.5");
  assert.equal(openAi.warnings.length, 0);

});

test("OpenAI official Standard, Batch, Flex, and Priority rows price exact components", () => {
  const expected = {
    "gpt-5.6-sol": {
      standard: ["5", "0.5", "6.25", "30", "41.75"],
      batch: ["2.5", "0.25", "3.125", "15", "20.875"],
      flex: ["2.5", "0.25", "3.125", "15", "20.875"],
      priority: ["10", "1", "12.5", "60", "83.5"],
    },
    "gpt-5.6-terra": {
      standard: ["2.5", "0.25", "3.125", "15", "20.875"],
      batch: ["1.25", "0.125", "1.5625", "7.5", "10.4375"],
      flex: ["1.25", "0.125", "1.5625", "7.5", "10.4375"],
      priority: ["5", "0.5", "6.25", "30", "41.75"],
    },
    "gpt-5.6-luna": {
      standard: ["1", "0.1", "1.25", "6", "8.35"],
      batch: ["0.5", "0.05", "0.625", "3", "4.175"],
      flex: ["0.5", "0.05", "0.625", "3", "4.175"],
      priority: ["2", "0.2", "2.5", "12", "16.7"],
    },
  };
  const names = [
    "input_uncached_tokens",
    "input_cache_read_tokens",
    "input_cache_write_tokens",
    "output_reasoning_tokens",
  ];
  for (const [model, tiers] of Object.entries(expected)) {
    for (const [tier, values] of Object.entries(tiers)) {
      for (let index = 0; index < names.length; index += 1) {
        const single = price({
          provider: "openai",
          model,
          tier,
          totalInputTokens: 271_999,
          components: { [names[index]]: 1_000_000 },
        });
        assert.equal(single.total, values[index], `${model}/${tier}/${names[index]}`);
        assert.equal(single.warnings.length, 0);
      }
      const result = price({
        provider: "openai",
        model,
        tier,
        totalInputTokens: 271_999,
        components: Object.fromEntries(names.map((name) => [name, 1_000_000])),
      });
      assert.equal(result.total, values[4], `${model}/${tier}/combined`);
      assert.equal(result.warnings.length, 0);
    }
  }
});

test("OpenAI short and long context rows meet the exact 272K boundary without inventing Priority long rates", () => {
  const expectedShort = {
    "gpt-5.5": {
      standard: "35.5",
      batch: "17.75",
      flex: "17.75",
      priority: "88.75",
    },
    "gpt-5.4": {
      standard: "17.75",
      batch: "8.88",
      flex: "8.88",
      priority: "35.5",
    },
  };
  const expectedLong = {
    "gpt-5.5": {
      standard: "56",
      batch: "28",
      flex: "28",
      priority: null,
    },
    "gpt-5.4": {
      standard: "28",
      batch: "14.01",
      flex: "14.01",
      priority: null,
    },
  };
  for (const [model, tiers] of Object.entries(expectedShort)) {
    for (const [tier, shortTotal] of Object.entries(tiers)) {
      const below = price({
        provider: "openai",
        model,
        tier,
        totalInputTokens: 271_999,
        components: {
          input_uncached_tokens: 1_000_000,
          input_cache_read_tokens: 1_000_000,
          output_text_tokens: 1_000_000,
        },
      });
      assert.equal(below.total, shortTotal, `${model}/${tier}/below-threshold`);
      assert.equal(below.warnings.length, 0);

      const atThreshold = price({
        provider: "openai",
        model,
        tier,
        totalInputTokens: 272_000,
        components: {
          input_uncached_tokens: 1_000_000,
          input_cache_read_tokens: 1_000_000,
          output_text_tokens: 1_000_000,
        },
      });
      const longTotal = expectedLong[model][tier];
      assert.equal(atThreshold.total, longTotal ?? "0", `${model}/${tier}/at-threshold`);
      if (longTotal === null) {
        assert.ok(atThreshold.warnings.some((warning) => (
          warning.code === "long_context_rule_missing"
        )));
      } else {
        assert.equal(atThreshold.warnings.length, 0);
      }
    }
  }
});

test("GPT-5.6 context bands apply exact official long multipliers and fail closed for Priority long context", () => {
  const expected = {
    "gpt-5.6-sol": { standard: "56", batch: "28", flex: "28" },
    "gpt-5.6-terra": { standard: "28", batch: "14", flex: "14" },
    "gpt-5.6-luna": { standard: "11.2", batch: "5.6", flex: "5.6" },
  };
  for (const [model, tiers] of Object.entries(expected)) {
    for (const [tier, total] of Object.entries(tiers)) {
      const result = price({
        provider: "openai",
        model,
        tier,
        totalInputTokens: 272_000,
        components: {
          input_uncached_tokens: 1_000_000,
          input_cache_read_tokens: 1_000_000,
          output_text_tokens: 1_000_000,
        },
      });
      assert.equal(result.total, total, `${model}/${tier}/long`);
      assert.equal(result.warnings.length, 0);
    }
    const priority = price({
      provider: "openai",
      model,
      tier: "priority",
      totalInputTokens: 272_000,
      components: { input_uncached_tokens: 1_000_000 },
    });
    assert.equal(priority.total, "0", `${model}/priority/long`);
    assert.ok(priority.warnings.some((warning) => warning.code === "long_context_rule_missing"));
  }
});

test("GPT-5.6 Priority long-context rows price only from their published boundaries", () => {
  // The Fast (priority) tab first showed long-context rates in the 2026-08-30
  // review. Terra and Luna rows carry the 2026-07-30 repricing boundary; Sol's
  // carries its own 2026-08-21 repricing boundary. Before each boundary the
  // priority long context stays deliberately unpriced (asserted above at the
  // default 2026-07-26 pricing date).
  const expected = {
    "gpt-5.6-terra": { pricedAt: "2026-08-01", total: "44" },
    "gpt-5.6-luna": { pricedAt: "2026-08-01", total: "4.4" },
    "gpt-5.6-sol": { pricedAt: "2026-08-22", total: "76" },
  };
  for (const [model, { pricedAt, total }] of Object.entries(expected)) {
    const result = price({
      provider: "openai",
      model,
      tier: "priority",
      pricedAt,
      totalInputTokens: 272_000,
      components: { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 },
    });
    assert.equal(result.total, total, `${model}/priority/long/${pricedAt}`);
    assert.equal(result.warnings.length, 0, `${model}/priority/long/${pricedAt}/warnings`);
  }
  const solBeforeBoundary = price({
    provider: "openai",
    model: "gpt-5.6-sol",
    tier: "priority",
    pricedAt: "2026-08-20",
    totalInputTokens: 272_000,
    components: { input_uncached_tokens: 1_000_000 },
  });
  assert.equal(solBeforeBoundary.total, "0");
  assert.ok(solBeforeBoundary.warnings.some((warning) => warning.code === "long_context_rule_missing"));
});

test("GPT-5.6 Sol pricing changes at the owner-stated August 21 boundary", () => {
  const components = { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 };
  const cases = [
    { tier: "standard", before: "35", after: "24" },
    { tier: "batch", before: "17.5", after: "12" },
    { tier: "priority", before: "70", after: "48" },
  ];
  for (const { tier, before, after } of cases) {
    const closed = price({ provider: "openai", model: "gpt-5.6-sol", tier, pricedAt: "2026-08-20", totalInputTokens: 1000, components });
    const open = price({ provider: "openai", model: "gpt-5.6-sol", tier, pricedAt: "2026-08-21", totalInputTokens: 1000, components });
    assert.equal(closed.total, before, `sol/${tier}/2026-08-20`);
    assert.equal(closed.warnings.length, 0, `sol/${tier}/2026-08-20/warnings`);
    assert.equal(open.total, after, `sol/${tier}/2026-08-21`);
    assert.equal(open.warnings.length, 0, `sol/${tier}/2026-08-21/warnings`);
  }
  // The captured Flex tab prices Sol flex across the boundary as well.
  const flexBefore = price({ provider: "openai", model: "gpt-5.6-sol", tier: "flex", pricedAt: "2026-08-20", totalInputTokens: 1000, components });
  assert.equal(flexBefore.total, "17.5");
  const flexAfter = price({ provider: "openai", model: "gpt-5.6-sol", tier: "flex", pricedAt: "2026-08-21", totalInputTokens: 1000, components });
  assert.equal(flexAfter.total, "12");
});

test("second-table and Codex variant models price at their reviewed rates", () => {
  const components = { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 };
  const expected = [
    ["gpt-5.2", "standard", "15.75"],
    ["gpt-5.2", "priority", "31.5"],
    ["gpt-5.1", "standard", "11.25"],
    ["gpt-5.1", "priority", "22.5"],
    ["gpt-5-mini", "priority", "4.05"],
    ["gpt-5-nano", "standard", "0.45"],
    ["gpt-4o", "priority", "21.25"],
    ["o3", "batch", "5"],
    ["gpt-5.3-codex", "standard", "15.75"],
    ["gpt-5.2-codex", "standard", "15.75"],
    ["gpt-5.1-codex", "standard", "11.25"],
    // Owner-stated Priority row: 2x the Standard rates, matching base gpt-5.1.
    ["gpt-5.1-codex", "priority", "22.5"],
    ["gpt-5.1-codex-mini", "standard", "2.25"],
    ["gpt-5-codex", "standard", "11.25"],
  ];
  for (const [model, tier, total] of expected) {
    const result = price({ provider: "openai", model, tier, totalInputTokens: 1000, components });
    assert.equal(result.total, total, `${model}/${tier}`);
    assert.equal(result.warnings.length, 0, `${model}/${tier}/warnings`);
  }
  // The pro models price on Standard/Batch/Flex but carry no priority row:
  // the page states they do not support Fast mode.
  const proBatch = price({ provider: "openai", model: "gpt-5.4-pro", tier: "batch", totalInputTokens: 1000, components });
  assert.equal(proBatch.total, "105");
  const proStandard = price({ provider: "openai", model: "gpt-5.4-pro", tier: "standard", totalInputTokens: 1000, components });
  assert.equal(proStandard.total, "210");
  const proLong = price({ provider: "openai", model: "gpt-5.5-pro", tier: "standard", totalInputTokens: 272_000, components: { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 } });
  assert.equal(proLong.total, "330");
  const nanoStandard = price({ provider: "openai", model: "gpt-5.4-nano", tier: "standard", totalInputTokens: 1000, components });
  assert.equal(nanoStandard.total, "1.45");
  const proPriority = price({ provider: "openai", model: "gpt-5.4-pro", tier: "priority", totalInputTokens: 1000, components });
  assert.equal(proPriority.total, "0");
  assert.ok(proPriority.warnings.some((warning) => warning.code === "service_tier_unsupported"));
});

test("GPT-5.6 Terra and Luna pricing changes at the official July 30 boundary", () => {
  // Sol was not part of the 2026-07-30 repricing; its totals must not move.
  const expected = {
    "gpt-5.6-terra": { before: "17.5", after: "14" },
    "gpt-5.6-luna": { before: "7", after: "1.4" },
    "gpt-5.6-sol": { before: "35", after: "35" },
  };
  for (const [model, totals] of Object.entries(expected)) {
    const components = { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 };
    const before = price({ provider: "openai", model, pricedAt: "2026-07-29", totalInputTokens: 1000, components });
    const after = price({ provider: "openai", model, pricedAt: "2026-07-31", totalInputTokens: 1000, components });
    assert.equal(before.total, totals.before, `${model}/2026-07-29`);
    assert.equal(before.warnings.length, 0, `${model}/2026-07-29/warnings`);
    assert.equal(after.total, totals.after, `${model}/2026-07-31`);
    assert.equal(after.warnings.length, 0, `${model}/2026-07-31/warnings`);
  }
  const successor = OPENAI_OFFICIAL_PRICE_CARDS.find((card) => (
    card.model === "gpt-5.6-terra" && card.service_tier === "standard"
      && card.effective.from === "2026-07-30" && card.metadata.total_input_context_band === "short"
  ));
  assert.equal(successor.metadata.provenance.vendor_effective_from, "2026-07-30");
  const closed = OPENAI_OFFICIAL_PRICE_CARDS.find((card) => (
    card.model === "gpt-5.6-terra" && card.service_tier === "standard"
      && card.effective.to === "2026-07-29" && card.metadata.total_input_context_band === "short"
  ));
  assert.equal(closed.metadata.provenance.vendor_effective_to, "2026-07-29");
  assert.equal(closed.effective.from, undefined);
});

test("low-level RunCost compatibility exposes its explicit fast-to-Priority fallback", () => {
  // OpenAI renamed API Priority processing to Fast mode on 2026-07-30, and
  // RunCost 0.2.1 resolves an OpenAI "fast" request onto Priority cards with
  // an explicit service_tier_resolution marker instead of pricing silently.
  // Subscription speed modes still never reach the engine as API tiers; the
  // worker maps subscription usage to the Standard counterfactual first.
  const expected = {
    "gpt-5.6-sol": { total: "10", cardSuffix: "short-through-2026-08-20" },
    "gpt-5.6-terra": { total: "4", cardSuffix: "short-from-2026-07-30" },
    "gpt-5.6-luna": { total: "0.4", cardSuffix: "short-from-2026-07-30" },
  };
  for (const [model, { total, cardSuffix }] of Object.entries(expected)) {
    const result = price({
      provider: "openai",
      model,
      tier: "fast",
      pricedAt: "2026-07-31",
      totalInputTokens: 1000,
      components: { input_uncached_tokens: 1_000_000 },
    });
    assert.equal(result.total, total, model);
    assert.deepEqual(result.metadata.service_tier_resolution, {
      requested: "fast",
      priced_as: "priority",
      fallback: true,
      price_card_ids: [
        `openai:${model}:priority:${cardSuffix}:official-observed-2026-08-30`,
      ],
    }, model);
  }
});

test("public kernel historical pricing requires canonical timestamps and exact API tiers", () => {
  const event = { provider: "openai", model: "gpt-5.6-sol", apiTier: "priority",
    components: { input_uncached_tokens: 1_000_000 }, totalInputContextTokens: 1_000 };
  const pricingContext = { priceEpochBasis: "event_time_when_registry_has_effective_evidence" };
  for (const timestamp of [undefined, "2026-08-21", "2026-08-21T00:00:00Z"]) {
    const result = priceUsageEvent({ ...event, timestamp }, { priceCards: APP_OFFICIAL_PRICE_CARDS, pricingContext });
    assert.equal(result.coverageStatus, "unpriced");
    assert.equal(result.totalUsd, "0");
    assert.ok(result.warnings.coverage.some(w => w.code === "historical_price_timestamp_missing"));
  }
  const timestamp = "2026-08-21T00:00:00.000Z";
  const exact = priceUsageEvent({ ...event, timestamp }, { priceCards: APP_OFFICIAL_PRICE_CARDS, pricingContext });
  assert.equal(exact.coverageStatus, "fully_priced");
  assert.equal(exact.totalUsd, "8");
  const fallback = priceUsageEvent({ ...event, timestamp, apiTier: "fast" }, { priceCards: APP_OFFICIAL_PRICE_CARDS, pricingContext });
  assert.equal(fallback.coverageStatus, "unpriced");
  assert.equal(fallback.totalUsd, "0");
  assert.deepEqual(fallback.selectedPriceCardIds, []);
  assert.ok(fallback.warnings.coverage.some(w => w.code === "service_tier_exact_card_missing"));
});

test("public Codex kernel selects reviewed epoch and context boundaries without inferred Priority prices", () => {
  const components = { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 };
  for (const [model, before, at, oldTotal, newTotal] of [
    ["gpt-5.6-terra", "2026-07-29T23:59:59.999Z", "2026-07-30T00:00:00.000Z", "17.5", "14"],
    ["gpt-5.6-luna", "2026-07-29T23:59:59.999Z", "2026-07-30T00:00:00.000Z", "7", "1.4"],
    ["gpt-5.6-sol", "2026-08-20T23:59:59.999Z", "2026-08-21T00:00:00.000Z", "35", "24"],
    ["gpt-6-astra", "2026-09-02T23:59:59.999Z", "2026-09-03T00:00:00.000Z", "0", "60"],
  ]) {
    for (const [timestamp, total] of [[before, oldTotal], [at, newTotal]]) {
      const result = priceCodexUsageEvent({ timestamp, model, totalInputContextTokens: 1_000, components });
      assert.equal(result.totalUsd, total, `${model}/${timestamp}`);
      assert.equal(result.coverageStatus, total === "0" ? "unpriced" : "fully_priced");
    }
  }
  for (const model of ["gpt-5.5", "gpt-5.5-codex", "gpt-5.4", "gpt-6.1-sol"]) {
    for (const totalInputContextTokens of [271_999, 272_000, 272_001]) {
      const result = priceCodexUsageEvent({ timestamp: "2026-10-18T00:00:00.000Z", model, totalInputContextTokens, components }, { apiServiceTier: "priority" });
      const missing = model !== "gpt-6.1-sol" && totalInputContextTokens >= 272_000;
      assert.equal(result.coverageStatus, missing ? "unpriced" : "fully_priced", `${model}/${totalInputContextTokens}`);
      if (missing) {
        assert.equal(result.totalUsd, "0");
        assert.deepEqual(result.selectedPriceCardIds, []);
        assert.ok(result.warnings.coverage.some(w => w.code === "long_context_rule_missing"));
      } else if (model === "gpt-6.1-sol") {
        assert.equal(result.totalUsd, totalInputContextTokens > 272_000 ? "38" : "24");
      }
    }
  }
});

test("GPT-5.5 Codex alias is explicit and is not a separate official model claim", () => {
  const result = price({
    provider: "openai",
    model: "gpt-5.5-codex",
    components: { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 },
    totalInputTokens: 1000,
  });
  assert.equal(result.total, "35");
  assert.equal(result.model.billed, "gpt-5.5");
  assert.ok(result.warnings.some((warning) => warning.code === "alias_inferred"));
  const card = OPENAI_OFFICIAL_PRICE_CARDS.find((item) => item.model === "gpt-5.5" && item.service_tier === "standard");
  assert.match(card.metadata.alias_assumptions["gpt-5.5-codex"], /Assumed/);
});

test("missing official components and unsupported tiers fail closed", () => {
  const omittedCache = price({
    provider: "openai",
    model: "gpt-4.1",
    tier: "batch",
    components: { input_cache_read_tokens: 1_000_000 },
  });
  assert.equal(omittedCache.total, "0");
  assert.ok(omittedCache.warnings.some((warning) => warning.code === "component_unpriced"));

  const unsupportedFlex = price({
    provider: "openai",
    model: "gpt-4.1",
    tier: "flex",
    components: { input_uncached_tokens: 1_000_000 },
  });
  assert.equal(unsupportedFlex.total, "0");
  assert.ok(unsupportedFlex.warnings.some((warning) => warning.code === "service_tier_unsupported"));
});

test("OpenAI Priority rows do not invent long-context prices", () => {
  const result = price({
    provider: "openai",
    model: "gpt-5.5",
    tier: "priority",
    components: { input_uncached_tokens: 1_000_000, output_text_tokens: 1_000_000 },
    totalInputTokens: 272000,
  });
  assert.equal(result.total, "0");
  assert.ok(result.warnings.some((warning) => warning.code === "long_context_rule_missing"));
});

test("provider tool unit cards price billable units from before the review date", () => {
  const toolUnits = {
    openai: [
      { name: "web_search_units", quantity: "1000", unit: "search" },
      { name: "file_search_units", quantity: "1000", unit: "call" },
    ],
  };
  const expected = { openai: "12.5" };
  for (const [provider, components] of Object.entries(toolUnits)) {
    for (const pricedAt of ["2025-06-01", "2026-01-15", "2026-07-24", "2026-08-01"]) {
      const result = calculateCost({
        usageLedger: {
          schema_version: "0.1",
          provider,
          surface: "openai.responses",
          model: { requested: `${provider}-provider-tools` },
          context: { service_tier: "standard", region: "global", priced_at: pricedAt },
          components,
        },
        priceCards: compilePriceCatalog(APP_OFFICIAL_PRICE_CARDS),
        mode: "compatibility",
      });
      assert.equal(result.total, expected[provider], `${provider}/${pricedAt}`);
      assert.equal(result.warnings.length, 0, `${provider}/${pricedAt}`);
    }
  }
  for (const card of PROVIDER_TOOL_PRICE_CARDS) {
    assert.deepEqual(card.effective, {}, card.id);
    assert.equal(card.metadata.provenance.vendor_effective_from, null, card.id);
    assert.equal(
      card.metadata.provenance.historical_validity,
      "reviewed_rate_without_vendor_effective_date",
      card.id,
    );
  }
});

test("validation rejects unsupported tiers, absent provenance, overlaps, and destructive aliases", () => {
  const [base] = OPENAI_OFFICIAL_PRICE_CARDS;
  const withoutProvenance = structuredClone(base);
  delete withoutProvenance.metadata.provenance.evidence_sha256;
  assert.throws(() => validateOfficialPriceRegistry([withoutProvenance]), /provenance/);

  const invalidTier = structuredClone(base);
  invalidTier.service_tier = "fast";
  assert.throws(() => validateOfficialPriceRegistry([invalidTier]), /unsupported API service tier/);

  const overlap = structuredClone(base);
  overlap.id = `${base.id}:duplicate`;
  assert.throws(() => validateOfficialPriceRegistry([base, overlap]), /overlap in the same pricing context/);

  const malformedContextBand = structuredClone(base);
  malformedContextBand.components[0].conditions.max_total_input_tokens = "272000";
  assert.throws(
    () => validateOfficialPriceRegistry([malformedContextBand]),
    /malformed short-context component boundary/,
  );

  const destructiveAlias = structuredClone(base);
  destructiveAlias.id = `${base.id}:alias-collision`;
  destructiveAlias.model = "another-model";
  destructiveAlias.aliases = [base.model];
  assert.throws(() => validateOfficialPriceRegistry([base, destructiveAlias]), /destructively overlaps canonical model/);
});

test("registry augmentation retains existing cards instead of replacing every card for a model", () => {
  const external = {
    schema_version: "0.1",
    id: "external:gpt-5.6-sol:private-contract",
    provider: "openai",
    model: "gpt-5.6-sol",
    service_tier: "standard",
    region: "private-contract",
    components: [],
    source: { name: "private-contract" },
  };
  const result = addOfficialPriceRegistry({
    selected_source: "external",
    price_cards: [external],
    sources: [],
  });
  assert.ok(result.price_cards.includes(external));
  assert.equal(result.price_cards.filter((card) => card.id === external.id).length, 1);
  assert.match(result.selected_source, /app-official-price-registry/);
});
