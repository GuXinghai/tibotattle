import { validateUnknownSpeedPolicy } from "./unknown-speed-policy.js";
import {
  FAST_MODE_MULTIPLIER_SOURCE,
} from "@app-usagemonitor/accounting";

export const CODEX_PRIMARY_ALLOWANCE_UNRESOLVED_SCENARIOS = Object.freeze([
  "unresolved_as_standard",
  "unresolved_as_fast",
  "unresolved_as_custom",
]);

const CODEX_PRIMARY_ALLOWANCE_BASIS_FAMILY_ID =
  "codex_primary:speed_priced_api_equivalent:v5:published_speed_card_ratio_2026_09_29:event_time:observed_declared_scenario";

// One constructor couples a weighted timeline numerator and capacity fitted
// under the same user-selected assumption. An active custom ratio is part of
// its identity; changing the calculation policy requires a new publication.
export function codexPrimaryAllowanceBasis(unresolvedScenario, policy = null) {
  if (!CODEX_PRIMARY_ALLOWANCE_UNRESOLVED_SCENARIOS.includes(
    unresolvedScenario,
  )) {
    throw new TypeError("Unknown Codex primary allowance scenario");
  }
  const ratio = unresolvedScenario === "unresolved_as_custom"
    ? validateUnknownSpeedPolicy(policy).customFastRatioBps : null;
  if (unresolvedScenario === "unresolved_as_custom" && policy.mode !== "custom") throw new TypeError("Custom allowance policy required");
  return Object.freeze({
    metric: "speed_priced_api_equivalent",
    version: 5,
    multiplierRegistryRecordedAt: FAST_MODE_MULTIPLIER_SOURCE.recordedAt,
    priceEpochBasis: "event_time_when_registry_has_effective_evidence",
    speedResolutionPolicy: "observed_declared_preference_unknown_v1",
    unresolvedScenario,
    ...(ratio === null ? {} : { customFastRatioBps: ratio }),
    allowanceTrack: "codex_primary",
    basisFamilyId: CODEX_PRIMARY_ALLOWANCE_BASIS_FAMILY_ID,
    basisId:
      `${CODEX_PRIMARY_ALLOWANCE_BASIS_FAMILY_ID}:${unresolvedScenario}${ratio === null ? "" : `:${ratio}`}`,
  });
}
