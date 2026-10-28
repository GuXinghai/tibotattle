import { mixUsdByBasisPoints } from "@app-usagemonitor/accounting";
// A user-selected estimation assumption, never observed speed evidence.
export const DEFAULT_UNKNOWN_SPEED_POLICY = Object.freeze({ mode: "standard", customFastRatioBps: null });

export function validateUnknownSpeedPolicy(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== 2
      || !Object.hasOwn(value, "mode") || !Object.hasOwn(value, "customFastRatioBps")
      || !["standard", "fast", "custom"].includes(value.mode)
      || !(value.customFastRatioBps === null || Number.isInteger(value.customFastRatioBps)
        && value.customFastRatioBps >= 0 && value.customFastRatioBps <= 10_000)
      || value.mode === "custom" && value.customFastRatioBps === null) {
    throw new TypeError("Unknown speed policy is invalid");
  }
  return Object.freeze({ mode: value.mode, customFastRatioBps: value.customFastRatioBps });
}

export function unknownSpeedScenario(policy) {
  const value = validateUnknownSpeedPolicy(policy);
  return `unresolved_as_${value.mode}`;
}

export function unknownSpeedCalculationIdentity(policy) {
  const value = validateUnknownSpeedPolicy(policy);
  return `${value.mode}:${value.mode === "custom" ? value.customFastRatioBps : ""}`;
}

export function unknownSpeedCalibrationOptions(policy) {
  const value = validateUnknownSpeedPolicy(policy);
  return { forcedCandidateId: value.mode === "standard" ? "speed_lower"
    : value.mode === "fast" ? "speed_upper" : "speed_custom",
  ...(value.mode === "custom" ? { customFastRatioBps: value.customFastRatioBps } : {}) };
}

// Endpoints are already priced with the established USD precision. Preserve
// them exactly; round a mixture once at nanodollar precision, half up.
export function mixUnknownSpeedUsd(standard, fast, policy) {
  const value = validateUnknownSpeedPolicy(policy);
  if (![standard, fast].every(x => Number.isFinite(x) && x >= 0)) return null;
  const ratio = value.mode === "standard" ? 0 : value.mode === "fast" ? 10_000 : value.customFastRatioBps;
  if (ratio === 0 || standard === fast) return standard;
  if (ratio === 10_000) return fast;
  return mixUsdByBasisPoints(standard, fast, ratio);
}
