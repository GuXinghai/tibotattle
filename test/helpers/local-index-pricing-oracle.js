import { addUsdStrings, priceCodexUsageEvent } from "@app-usagemonitor/accounting";
import { recognizedCodexModelId } from "../../src/export/index.js";
import { declaredSpeedModeAt } from "../../src/codex-speed-baseline.js";
import { localDigest, readExistingDeviceSalt } from "../../src/local-device-salt.js";
import { createWorkUsageProjectResolver, readCodexLocalRepositoryOrigins } from "../../src/platform/index.js";
import { createWorkUsageCollectorCore } from "../../src/local-index-work-usage.js";
import { readCommitSeq } from "../../src/local-index-store.js";
import { projectRecordedTokenComponents } from "../../src/reporting/index.js";

// Synthetic committed facts only. Deliberately avoid rollups, usageProjection,
// speedApiPrice and the memoized pricer under test. Use the public exact ledger
// once per event, preserving unknown components and selecting one output form.
export function readPricingOracleFacts(database) {
  return database.prepare(`
    SELECT u.*, m.model_id AS model, t.codex_speed_mode AS speed,
           s.session_local, s.session_uuid
    FROM usage_event u JOIN source src ON src.id = u.source_id
    JOIN model m ON m.id = u.model_id
    JOIN tier_semantics t ON t.id = u.tier_id
    JOIN session s ON s.id = u.session_id
    WHERE u.source_offset <= src.scanned_bytes
    ORDER BY u.observed_at_ms, u.source_id, u.source_offset
  `).all().map((row) => ({
    ...row,
    components: {
      input_uncached_tokens: row.tokens_in_uncached,
      input_cache_read_tokens: row.tokens_in_cache_read,
      input_cache_write_tokens: row.tokens_in_cache_write,
      output_text_tokens: row.tokens_out_text,
      output_reasoning_tokens: row.tokens_out_reasoning,
      output_combined_tokens: row.tokens_out_combined,
    },
  }));
}

export function priceOracleEvent(row, mode) {
  const recorded = projectRecordedTokenComponents(row.components);
  const components = { ...recorded.components };
  if (components.output_combined_tokens === null) delete components.output_combined_tokens;
  if (!["standard", "fast", "ultrafast"].includes(mode)) {
    return { recorded, price: { coverageStatus: "unpriced", components: [] } };
  }
  const event = {
    timestamp: new Date(Number(row.observed_at_ms)).toISOString(),
    model: recognizedCodexModelId(row.model) ?? "unknown",
    components,
    componentAvailability: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, value !== null])),
    ...(row.total_input_context === null ? {} : { totalInputContextTokens: Number(row.total_input_context) }),
  };
  return { recorded, price: priceCodexUsageEvent(event, {
    apiServiceTier: { standard: "standard", fast: "priority", ultrafast: "ultrafast" }[mode],
    priceEpochBasis: "event_time",
  }) };
}

const usable = (price) => ["fully_priced", "partially_priced"].includes(price.coverageStatus);
const knownMode = (mode) => ["standard", "fast", "ultrafast"].includes(mode);
function effectiveMode(row, ledger) {
  if (knownMode(row.speed)) return { mode: row.speed, provenance: "observedEvents" };
  const mode = declaredSpeedModeAt(ledger, Number(row.observed_at_ms));
  return knownMode(mode) ? { mode, provenance: "declaredEvents" } : { mode: "unknown", provenance: "unknownEvents" };
}

function summary() {
  return { sum: "0", priced: 0, incomplete: 0, components: {}, provenance: { observedEvents: 0, declaredEvents: 0, unknownEvents: 0 } };
}

function add(summary, row, ledger) {
  const selected = effectiveMode(row, ledger);
  const { recorded, price } = priceOracleEvent(row, selected.mode);
  if ((recorded.totalTokens ?? 0) === 0) return;
  summary.provenance[selected.provenance] += 1;
  if (usable(price)) { summary.priced += 1; summary.sum = addUsdStrings(summary.sum, price.totalUsd); }
  if (price.coverageStatus !== "fully_priced") summary.incomplete += 1;
  for (const [name, tokens] of Object.entries(recorded.components)) {
    const component = summary.components[name] ??= { tokens: 0, pricedTokens: 0, unpricedTokens: 0, sum: "0" };
    component.tokens += tokens ?? 0;
    const priced = price.components.find((item) => item.name === name && item.pricingStatus === "priced");
    if (priced) {
      component.pricedTokens += tokens ?? 0;
      component.sum = addUsdStrings(component.sum, priced.costUsd);
    } else component.unpricedTokens += tokens ?? 0;
  }
}

function finish(summary) {
  return {
    ...(Object.keys(summary.components).length ? { speedPricingProvenance: summary.provenance } : {}),
    speedApiPriceEquivalentUsd: summary.priced ? Number(summary.sum) : null,
    speedApiPriceEquivalentUsdExact: summary.priced ? summary.sum : null,
    speedPricingCoverageStatus: summary.priced ? summary.incomplete ? "partially_priced" : "fully_priced" : "unpriced",
    speedComponentCosts: Object.fromEntries(Object.entries(summary.components).map(([name, c]) => [name, {
      tokens: c.tokens, pricedTokens: c.pricedTokens, unpricedTokens: c.unpricedTokens, costUsd: Number(c.sum),
    }])),
  };
}

export const SPEED_REPORT_FIELDS = Object.freeze([
  "speedPricingProvenance", "speedApiPriceEquivalentUsd", "speedApiPriceEquivalentUsdExact",
  "speedPricingCoverageStatus", "speedComponentCosts",
]);

export function reportSpeedOracle(facts, nowMs, ledger) {
  return Object.fromEntries([["24h", 86_400_000], ["7d", 7 * 86_400_000], ["30d", 30 * 86_400_000], ["all", Infinity]].map(([id, span]) => {
    const main = summary(), spark = summary(), models = new Map(), sparkModels = new Map();
    for (const row of facts) {
      const at = Number(row.observed_at_ms);
      if (at < nowMs - span || at > nowMs + 5 * 60_000) continue;
      const model = recognizedCodexModelId(row.model) ?? "unknown";
      const isSpark = model === "gpt-5.3-codex-spark";
      const byModel = isSpark ? sparkModels : models;
      if ((projectRecordedTokenComponents(row.components).totalTokens ?? 0) === 0) continue;
      if (!byModel.has(model)) byModel.set(model, summary());
      add(isSpark ? spark : main, row, ledger);
      add(byModel.get(model), row, ledger);
    }
    const result = (total, rows) => ({ ...finish(total), byModel: Object.fromEntries([...rows].map(([model, value]) => [model, finish(value)])) });
    return [id, { ...result(main, models), spark: result(spark, sparkModels) }];
  }));
}

// Reuse only identity/family assembly and exact cell accumulation. Fact reading,
// period membership, pricing and per-event coverage bypass the grouped reader.
export async function workPricingOracle(database, facts, { nowMs, codexHome, secretFile, standard = false, ledger = [] }) {
  const salt = await readExistingDeviceSalt(secretFile);
  const resolveProject = createWorkUsageProjectResolver({
    repositoryOrigins: await readCodexLocalRepositoryOrigins(codexHome),
    digest: (kind, value) => localDigest(salt, `work-usage-${kind}`, value).toString("hex"),
  });
  const locations = new Map([[0, null]]);
  for (const row of database.prepare("SELECT id, path FROM work_directory ORDER BY id").all()) {
    locations.set(Number(row.id), await resolveProject(row.path));
  }
  const core = createWorkUsageCollectorCore({
    generation: { status: "complete", id: readCommitSeq(database), commitSeq: readCommitSeq(database), usageProvenanceComplete: true },
    scopeRows: database.prepare("SELECT id, status, scope_local, reason, plan_type FROM account_scope ORDER BY id").all(),
    periods: [["24h", 86_400_000], ["7d", 7 * 86_400_000], ["30d", 30 * 86_400_000], ["all", Infinity]]
      .map(([id, span]) => ({ id, fromMs: Math.max(0, nowMs - span), toMs: nowMs })),
    nowMs, codexHome, deviceSalt: salt,
  });
  for (const row of facts) {
    const statusOnly = (Number(row.flags) & 8) !== 0 && Object.values(row.components).every((value) => value === null);
    const { price } = priceOracleEvent(row, standard ? "standard" : effectiveMode(row, ledger).mode);
    core.add({
      observedAtMs: Number(row.observed_at_ms), accountScopeId: Number(row.account_scope_id),
      sessionLocal: row.session_local, sessionUuid: row.session_uuid,
      modelId: row.model, components: row.components, statusOnly, project: locations.get(Number(row.work_directory_id)) ?? null,
      cacheWriteAssumedZero: (Number(row.flags) & 4) !== 0, partial: (Number(row.flags) & 1) !== 0,
      price: { amount: !statusOnly && usable(price) ? price.totalUsd : null, status: price.coverageStatus },
    });
  }
  return core.finish();
}
