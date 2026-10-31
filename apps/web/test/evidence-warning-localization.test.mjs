import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  evidenceWarningLocalization,
  SUPPORTED_LOCALES,
  translate,
  translateLegacyText,
  WEB_MESSAGES,
} from "../public/localization.js";

test("every fixed companion projection warning has translated presentation copy", async () => {
  const source = await readFile(new URL("../../../src/local-companion-data.js", import.meta.url), "utf8");
  const warnings = [...source.matchAll(/(?:const|export const) [A-Z_]+_WARNING\s*=\s*"([^"]+)";/gu)]
    .map((match) => match[1]);
  // 7 since the retained-evidence "recalculating" sentence was retired (2026-10-14).
  assert.ok(warnings.length >= 7);
  for (const warning of warnings) {
    const message = evidenceWarningLocalization(warning);
    assert.ok(message, warning);
    assert.equal(translate(message.key, message.values, "en-US"), warning);
    for (const locale of ["zh-Hans", "es"]) {
      const copy = translate(message.key, message.values, locale);
      assert.notEqual(copy, warning);
      assert.notEqual(copy, message.key);
      if (locale === "zh-Hans") assert.match(copy, /[\u4e00-\u9fff]/u);
    }
  }
});

test("bounded companion warning templates retain counts, dates and missing-evidence qualifications", () => {
  const fixtures = [
    "The unified local index is 17 minutes behind the newest collector evidence.",
    "Verified OpenAI price evidence was reviewed beginning 2026-08-01; events without a recognized or separately evidenced card remain unpriced.",
    "Indexed-history totals currently cover 11/23 discovered sources and expand as later foreground refreshes advance the index.",
    "Indexed-history totals include 11 of 23 verified sources. 12 sources across 3 threads did not pass local validation, so this result has limited history coverage; missing usage remains unavailable rather than zero.",
    "Indexed-history totals include 11 of 23 verified sources. 12 sources across 3 threads did not pass local validation. This is a material coverage gap; missing usage remains unavailable rather than zero.",
    "Excluded from indexed history: 1 source across 1 thread did not pass local validation. Their usage remains unavailable.",
    "Excluded from indexed history: 12 sources across 3 threads did not pass local validation. Their usage remains unavailable.",
    "Historical response coverage is partial. Recorded response amounts remain counted; earlier usage remains unavailable.",
  ];
  for (const warning of fixtures) {
    const message = evidenceWarningLocalization(warning);
    assert.ok(message, warning);
    assert.equal(translate(message.key, message.values, "en-US"), warning);
    for (const locale of SUPPORTED_LOCALES) {
      const copy = translate(message.key, message.values, locale);
      assert.doesNotMatch(copy, /\{[a-z]+\}/u);
      for (const [name, value] of Object.entries(message.values)) {
        if (!name.endsWith("noun")) assert.ok(copy.includes(value), `${locale}: ${value}`);
      }
    }
    if (message.key.includes("coverageLimited") || message.key.includes("coverageGap")) {
      assert.match(translate(message.key, message.values, "zh-Hans"), /缺失用量仍不可用，不会记为零/u);
    }
  }
});

test("warning localization recognizes only closed source-owned sentences", () => {
  for (const value of [null, {}, "synthetic user text", "Time intervals",
    "The unified local index is synthetic/path minutes behind the newest collector evidence.",
    "The unified local index is 9999999999999999 minutes behind the newest collector evidence.",
    "The unified local index is 17 minutes behind the newest collector evidence.\n",
    "Excluded from indexed history: 1 private-source across 1 thread did not pass local validation. Their usage remains unavailable.",
  ]) assert.equal(evidenceWarningLocalization(value), null);
});

test("warning catalogs have complete locale rows with matching placeholders", () => {
  const rows = Object.entries(WEB_MESSAGES).filter(([key]) => key.startsWith("dashboard.warning."));
  // 22 since dashboard.warning.retainedRefresh was retired (2026-10-14).
  assert.ok(rows.length >= 22);
  for (const [key, row] of rows) {
    assert.equal(row.length, SUPPORTED_LOCALES.length, key);
    for (const copy of row) assert.ok(copy.length > 0, key);
    const placeholders = (copy) => [...copy.matchAll(/\{([a-z]+)\}/gu)]
      .map((match) => match[1]).filter((name) => !name.endsWith("noun")).sort();
    for (const copy of row.slice(1)) assert.deepEqual(placeholders(copy), placeholders(row[0]), key);
  }
});

test("timeline metric labels and explanations translate without changing the pricing disclosure", () => {
  for (const value of ["Time intervals", "The number of displayed hour, day, or week intervals.",
    "Speed-priced API equivalent", "Standard-rate API-price equivalent",
    "Standard API prices with Fast and Ultrafast increments priced at their published API rates, compared only with a capacity fitted on the same basis. This is a comparison, not a bill or included-allowance formula.",
    "A Standard-rate accounting series. Provider allowance is hidden because no matching weighted capacity is available.",
  ]) {
    assert.equal(translateLegacyText(value, "en-US"), value);
    for (const locale of ["zh-Hans", "es"]) assert.notEqual(translateLegacyText(value, locale), value);
  }
  assert.equal(translateLegacyText("Last 7 days", "zh-Hans"), "过去 7 天");
  assert.equal(translateLegacyText("synthetic provider model", "zh-Hans"), "synthetic provider model");
});

test("all source-owned component labels translate while combined output keeps its unavailable split", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const block = source.match(/const COMPONENT_LABELS = Object\.freeze\(\{([\s\S]*?)\}\);/u);
  assert.ok(block);
  const labels = [...block[1].matchAll(/:\s*"([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(labels.length, 6);
  for (const value of labels) {
    assert.equal(translateLegacyText(value, "en-US"), value);
    for (const locale of ["zh-Hans", "es"]) assert.notEqual(translateLegacyText(value, locale), value);
  }
  assert.equal(translateLegacyText("Output (split unavailable)", "zh-Hans"), "输出（无法拆分）");
  assert.match(translateLegacyText("Output (split unavailable)", "es"), /desglose no disponible/u);
});
