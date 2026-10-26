import { cacheReuseCoverageNote } from "../public/cache-reuse-metrics.js";
import test from "node:test";
import { finite } from "../public/ui-format.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SUPPORTED_LOCALES, translate, translateLegacyText } from "../public/localization.js";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function appFunction(name, nextName, dependencies) {
  const start = appSource.indexOf(`function ${name}(`);
  const end = appSource.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} is available`);
  return Function(...Object.keys(dependencies),
    `${appSource.slice(start, end)}\nreturn ${name};`)(...Object.values(dependencies));
}

function localizedDependencies(locale = "en-US") {
  return {
    finite,
    t: (key, values) => translate(key, values, locale),
    localization: { translateText: value => translateLegacyText(value, locale) },
    formatCount: String,
    formatApiMoney: (value) => `$${value.toFixed(2)}`,
  };
}

test("the headline uses recorded-speed API prices and never substitutes quota weighting", () => {
  const headline = appFunction("accountingPriceHeadline", "renderAccounting", localizedDependencies());
  const period = {
    speedApiPriceEquivalentUsd: 6200, speedPricingCoverageStatus: "fully_priced",
    quotaWeightedApiPriceEquivalentUsd: 9000, apiPriceEquivalentUsd: 5929.64,
  };
  assert.equal(headline(period)[2], "$6200.00");
  assert.equal(headline(period)[3], "");
  assert.equal(headline({ ...period, speedApiPriceEquivalentUsd: null })[2], "—");
  assert.equal(headline({ ...period, speedApiPriceEquivalentUsd: undefined })[2], "—");
  assert.equal(headline({ ...period, speedApiPriceEquivalentUsd: 0 })[2], "$0.00");
  assert.equal(headline({ ...period, speedPricingCoverageStatus: "partially_priced" })[3],
    translate("dashboard.overview.partial", {}, "en-US"));
});

test("simplified headline labels translate in every locale", () => {
  for (const locale of SUPPORTED_LOCALES) {
    const headline = appFunction("accountingPriceHeadline", "renderAccounting", localizedDependencies(locale));
    const row = headline({ speedApiPriceEquivalentUsd: 2, speedPricingCoverageStatus: "fully_priced" });
    assert.equal(row[0], translate("usageSimple.apiEquivalent", {}, locale));
    assert.equal(row[3], "");
  }
});

test("cache analysis retains its historical pricing context behind details", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const table = html.match(/<table class="cache-continuity-recent-table">[\s\S]*?<\/table>/u)?.[0];
  assert.ok(table);
  assert.equal((table.match(/<th\b/gu) ?? []).length, 5);
  assert.match(table, /accounting\.cacheDropThread\.column">Thread name<\/th>/u);
  assert.match(table, /column\.configuration">Configuration<\/th>/u);
  assert.doesNotMatch(table, /lostTokens|Estimated lost reuse|Unchanged configuration/u);
  assert.equal((html.match(/<th[^>]+data-i18n-title="accounting\.apiEquivalent\.standardRateBasis"[^>]*>API equivalent<\/th>/gu) ?? []).length, 0);
  for (const kind of ["cacheSwitch", "cacheContinuity"]) {
    const caption = html.match(new RegExp(`data-i18n="accounting\\.${kind}\\.tableCaption">([^<]+)<`, "u"))?.[1];
    assert.equal(caption, translate(`accounting.${kind}.tableCaption`, {}, "en-US"));
  }
  assert.deepEqual(SUPPORTED_LOCALES.map((locale) => translate("accounting.cacheContinuity.column.configuration", {}, locale)),
    ["Configuration", "配置", "Configuración"]);
  for (const kind of ["cacheSwitch", "cacheContinuity"]) {
    assert.deepEqual(SUPPORTED_LOCALES.map((locale) => translate(`accounting.${kind}.column.apiEquivalent`, {}, locale)),
      ["API equivalent", "API 等价金额", "Equivalente de API"]);
  }
  for (const locale of SUPPORTED_LOCALES) {
    const headline = appFunction("accountingPriceHeadline", "renderAccounting", localizedDependencies(locale));
    const row = headline({ fastMode: { metricShortLabel: "API" }, quotaWeightedApiPriceEquivalentUsd: 2, apiPriceEquivalentUsd: 1, periodLabel: "period" });
    assert.equal(row[1], translate("usageSimple.apiExplanation", {}, locale));
    assert.doesNotMatch(row[1], /accounting\.|\{amount\}/u);
    assert.doesNotMatch(translate("accounting.apiEquivalent.standardRateBasis", {}, locale), /accounting\./u);
  }
});

test("cache continuity rows and empty states retain five correctly aligned cells", () => {
  const element = (tagName, className = "", textContent = "") => ({ tagName, className, textContent, children: [], append(...items) { this.children.push(...items); } });
  const sampleNote = {};
  const disclosure = { hidden: true, open: false, querySelector: () => sampleNote };
  const rows = element("tbody");
  const linkedItems = [];
  const render = appFunction("renderAccountingCacheContinuityDetails", "accountingRebuildRetrying", {
    $: (selector) => ({ "#cache-continuity-details": disclosure, "#cache-continuity-rows": rows, "#cache-continuity-sample": sampleNote })[selector] ?? null,
    cacheDropThreadLinks: { cells: { continuity: [] } },
    clear: (target) => { target.children.length = 0; },
    node: element,
    rawNode: element,
    cacheSwitchDataCell: (className, textContent) => element("td", className, textContent),
    cacheDropThreadCell: (kind, item) => {
      linkedItems.push({ kind, item });
      return element("td", "cache-drop-thread-cell", "Synthetic thread");
    },
    localizedNode: (tag, className, key) => element(tag, className, translate(key, {}, "en-US")),
    renderAccountingCacheReuseOutcome: () => {},
    renderCacheImpactPagination: () => {},
    cacheContinuityTablePagination: { page: 0, signature: "" },
    paginateCacheImpactRows: (values) => ({ rows: values }),
    cacheImpactTableSignature: () => "test",
    formatLocal: (value) => value,
    formatCacheContinuityGap: (value) => `${value}s`,
    cacheContinuityConfigurationDescription: () => "GPT-5.6 Sol · High",
    setLocalizedText: (target, key, values) => { target.textContent = translate(key, values, "en-US"); },
    ...localizedDependencies(),
  });
  const recent = { observedAt: "synthetic time", gapSeconds: 60, previousCacheReadTokens: 100, currentCacheReadTokens: 20, lostCacheTokens: 80, estimatedPremiumUsd: 0.25 };
  render({ status: "available", recent: [recent], cacheReadDrops: 100 });
  assert.equal(sampleNote.hidden, false);
  assert.match(sampleNote.textContent, /1 most recent of 100/u);
  assert.equal(disclosure.hidden, false);
  assert.deepEqual(linkedItems, [{ kind: "continuity", item: recent }]);
  assert.deepEqual(rows.children[0].children.map((cell) => cell.textContent),
    ["Synthetic thread", "60s", "GPT-5.6 Sol · High", "100 → 20", "$0.25"]);
  render({ status: "available", recent: [{ ...recent, estimatedPremiumUsd: null }] });
  assert.equal(rows.children[0].children.length, 5);
  assert.equal(rows.children[0].children[4].textContent, "Not priced");
  render({ status: "available", recent: [] });
  assert.equal(rows.children[0].children.length, 1);
  assert.equal(rows.children[0].children[0].colSpan, 5);
  assert.match(rows.children[0].children[0].textContent, /No qualifying/u);
  render(null);
  assert.equal(disclosure.hidden, true);
  assert.equal(rows.children.length, 0);
});

test("one chart-level note describes only actual global exclusions", () => {
  const base = { status: "available", coverageStatus: "complete", orderingCoverageGaps: 0, uncoveredReturns: 0, unpricedDrops: 0 };
  for (const locale of SUPPORTED_LOCALES) {
    const note = (impact) => cacheReuseCoverageNote(impact, localizedDependencies(locale));
    assert.equal(note(base), "");
    assert.equal(note(null), "");
    assert.equal(note({ ...base, status: "unavailable", unpricedDrops: 1 }), "");
    const ordering = note({ ...base, coverageStatus: "incomplete", orderingCoverageGaps: 1 });
    assert.match(ordering, /1/u);
    assert.doesNotMatch(ordering, /accounting\.|\{count\}|(?:^|\D)0(?:\D|$)/u);
    const price = note({ ...base, unpricedDrops: 3 });
    assert.match(price, /3/u, "unpriced drops are disclosed even with complete ordering coverage");
    const boundary = note({ ...base, uncoveredReturns: 2 });
    assert.match(boundary, /2/u);
    const combined = note({ ...base, coverageStatus: "incomplete", orderingCoverageGaps: 1, uncoveredReturns: 2, unpricedDrops: 3 });
    for (const count of [1, 2, 3]) assert.ok(combined.includes(String(count)));
    assert.equal(note(base), "", "coverage clears when the selected period becomes complete");
    if (locale === "en-US") {
      assert.match(ordering, /prefix equivalence and actual avoidable loss remain unverified/iu);
      assert.match(ordering, /uncertain event order: 1/u);
      assert.doesNotMatch(ordering, /unavailable|without supported prices/u);
      assert.match(price, /without supported prices: 3/u);
    }
  }
});

test("cache matrix integration forwards empty, zero-reuse and unavailable evidence without remounting", () => {
  const outcome = { hidden: true };
  const container = {};
  const renders = [];
  let mounts = 0;
  const render = appFunction("renderAccountingCacheReuseOutcome", "renderAccountingCacheContinuityDetails", {
    $: (selector) => ({ "#cache-reuse-outcome": outcome, "#cache-reuse-matrix": container })[selector],
    cacheReuseMatrix: null,
    createCacheReuseMatrix: (options) => {
      mounts += 1;
      assert.equal(options.container, container);
      return { render: (value) => renders.push(value.impact) };
    },
    ...localizedDependencies(),
    formatPercent: String,
    formatModelName: String,
    cacheReuseMetricLines: () => [],
    cacheReuseCoverageNote: () => "",
  });
  const zeroReuse = { status: "available", comparableReturns: 4, reusedMoreThanHalfReturns: 0 };
  const empty = { status: "available", comparableReturns: 0, reusedMoreThanHalfReturns: 0 };
  render(zeroReuse);
  render(empty);
  render(null);
  assert.deepEqual(renders, [zeroReuse, empty, null]);
  assert.equal(mounts, 1, "preserve selected model across dashboard renders");
  assert.equal(outcome.hidden, false, "unavailable evidence gets an explicit state");
});

test("usage keeps a compact summary and opens full analysis through light disclosures", async () => {
  const [styles, html] = await Promise.all([
    readFile(new URL("../public/usage-simple.css", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(styles, /#accounting-summary[^}]*display:flex/u);
  assert.match(styles, /\.metric-card::before\s*\{\s*display:none/u);
  assert.doesNotMatch(appSource, /node\("p", "annotation accounting-speed-coverage"\)/u);
  assert.match(html, /<details[^>]+id="usage-composition-details"/u);
  assert.match(html, /<details[^>]+id="usage-cache-details"/u);
  assert.match(html, /id="usage-model-details"/u);
  assert.match(appSource, /workUsageView.setMetric\(usageSimpleMetric\)/u);
});

test("overhead cards retain the unknown cache-evidence disclosure beside priced drops", () => {
  const element = (tagName, className = "", textContent = "") => ({
    tagName,
    className,
    textContent,
    title: "",
    children: [],
    append(...items) { this.children.push(...items); },
  });
  const render = appFunction("cacheImpactMetricBullets", "formatCacheSwitchPercentagePoints", {
    node: element,
    localizedNode: (tagName, className, key, values) => (
      element(tagName, className, translate(key, values, "en-US"))
    ),
    cacheImpactCostView: () => ({
      isSubtotal: false,
      pricedDrops: 124,
      standardApiPremiumUsd: 50.4,
    }),
    finite: (value, fallback = 0) => Number.isFinite(value) ? value : fallback,
    formatCount: String,
    t: (key, values) => translate(key, values, "en-US"),
  });
  const list = render({
    orderingCoverageGaps: 2,
    unpricedDrops: 0,
    uncoveredConfigurationChanges: 0,
  }, (details) => { details.textContent = "Full diagnostic detail"; });

  assert.deepEqual(list.children.map((item) => item.textContent), [
    "124 priced drops",
    translate("accounting.cacheImpact.evidenceUnknown", {}, "en-US"),
  ]);
  assert.match(list.children[1].textContent, /reusable prefix unverified/iu);
  assert.match(list.children[1].textContent, /actual avoidable loss is unknown/iu);
  assert.doesNotMatch(list.children.map((item) => item.textContent).join(" "), /Standard|sessions excluded/u);
  assert.equal(list.title, "Full diagnostic detail");
});
