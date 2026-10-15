import { priceCodexUsageEvent, resolveEffectiveSpeedMode } from "@app-usagemonitor/accounting";
import { ExactUsdSum } from "./reporting/index.js";

// A speed-specific API counterfactual, separate from subscription quota weights.
// Missing published prices stay unpriced; no assumed Fast multiplier enters it.
export function speedApiPrice(event, components, standardPrice, declaredMode = "unknown", priceTier = null) {
  const known = mode => ["standard", "fast", "ultrafast"].includes(mode);
  if (!known(event.tierSemantics?.codexSpeedMode) && !known(declaredMode)) {
    return { totalUsd: "0", coverageStatus: "unpriced", components: [], speedPriceProvenance: "unknown" };
  }
  const resolved = resolveEffectiveSpeedMode({ observedMode: event.tierSemantics?.codexSpeedMode, declaredMode });
  let priced = standardPrice;
  if (resolved.mode !== "standard") {
    const tier = { fast: "priority", ultrafast: "ultrafast" }[resolved.mode];
    priced = priceTier ? priceTier(tier, event, components) : priceCodexUsageEvent({ ...event, components }, {
      apiServiceTier: tier, priceEpochBasis: "event_time",
    });
  }
  return { ...priced, speedPriceProvenance: resolved.provenance };

}

const sums = new WeakMap();
export function addSpeedApiCost(target, components, priced, weight = 1) {
  let state = sums.get(target);
  if (!state) {
    state = { sum: new ExactUsdSum(), priced: 0, incomplete: 0, components: {}, provenance: { observedEvents: 0, declaredEvents: 0, unknownEvents: 0 } };
    sums.set(target, state);
  }
  const provenanceKey = priced?.speedPriceProvenance === "observed" ? "observedEvents" : priced?.speedPriceProvenance === "declared_codex_config" ? "declaredEvents" : "unknownEvents";
  state.provenance[provenanceKey] += weight;
  const usable = ["fully_priced", "partially_priced"].includes(priced?.coverageStatus);
  if (usable) { state.sum.add(priced.totalUsd); state.priced += weight; }
  if (priced?.coverageStatus !== "fully_priced") state.incomplete += weight;
  const rows = new Map((priced?.components ?? []).map(row => [row.name, row]));
  for (const [name, tokens] of Object.entries(components)) {
    const cell = state.components[name] ??= { sum: new ExactUsdSum(), tokens: 0, pricedTokens: 0, unpricedTokens: 0 };
    cell.tokens += tokens ?? 0;
    const row = rows.get(name);
    if (row?.pricingStatus === "priced") { cell.pricedTokens += tokens ?? 0; cell.sum.add(row.costUsd); }
    else cell.unpricedTokens += tokens ?? 0;
  }
}

export function speedApiCostSummary(target) {
  const state = sums.get(target);
  if (!state) return { speedApiPriceEquivalentUsd: null, speedApiPriceEquivalentUsdExact: null, speedComponentCosts: {}, speedPricingCoverageStatus: "unpriced" };
  return {
    speedPricingProvenance: { ...state.provenance },
    speedApiPriceEquivalentUsd: state.priced ? Number(state.sum.toString()) : null,
    speedApiPriceEquivalentUsdExact: state.priced ? state.sum.toString() : null,
    speedPricingCoverageStatus: state.priced ? state.incomplete ? "partially_priced" : "fully_priced" : "unpriced",
    speedComponentCosts: Object.fromEntries(Object.entries(state.components).map(([name, row]) => [name, {
      tokens: row.tokens, pricedTokens: row.pricedTokens, unpricedTokens: row.unpricedTokens, costUsd: Number(row.sum.toString()),
    }])),
  };
}
