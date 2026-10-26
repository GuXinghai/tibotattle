import { DESKTOP_CODEX_ROOT_LIMIT, DESKTOP_DEFAULT_SETTINGS, validateDesktopSettingsSnapshot } from "../../apps/electron/desktop-contract.js";
import { DESKTOP_AUTOMATIC_REFRESH_CADENCE_CODEC } from "../../apps/electron/desktop-automatic-refresh-cadence.js";

// Pure projection AFTER a separately version-bound source decoder. No profile,
// source discovery, legacy-format interpretation, settings save or credentials.
const errors = new WeakSet();
function fail(category) {
  const error = Object.assign(new Error("Usage-state control projection refused"), { code: `USAGE_STATE_CONTROLS_${category}` });
  errors.add(error); throw error;
}
export function classifyUsageStateControlsFailure(error) {
  return errors.has(error) ? error.code : "USAGE_STATE_CONTROLS_UNAVAILABLE";
}
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length
    && keys.every(key => Object.hasOwn(descriptors[key] ?? {}, "value"));
}
function sourceControls(value) {
  if (!exact(value, ["codexHomes", "refreshPaused", "refreshIntervalSeconds"])
      || typeof value.refreshPaused !== "boolean" || typeof value.refreshIntervalSeconds !== "number") fail("CONTROLS_INVALID");
  const homes = value.codexHomes;
  if (!exact(homes, ["activityRoots", "primaryRootId"]) || typeof homes.primaryRootId !== "string"
      || !Array.isArray(homes.activityRoots) || Object.getPrototypeOf(homes.activityRoots) !== Array.prototype
      || homes.activityRoots.length < 1 || homes.activityRoots.length > DESKTOP_CODEX_ROOT_LIMIT
      || Reflect.ownKeys(homes.activityRoots).length !== homes.activityRoots.length + 1) fail("CONTROLS_INVALID");
  for (let i = 0; i < homes.activityRoots.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(homes.activityRoots, i);
    if (!Object.hasOwn(descriptor ?? {}, "value")) fail("CONTROLS_INVALID");
    const root = descriptor.value;
    if (!exact(root, ["rootId", "kind", "path", "enabled"]) || typeof root.rootId !== "string"
        || typeof root.kind !== "string" || root.path !== null && typeof root.path !== "string"
        || typeof root.enabled !== "boolean") fail("CONTROLS_INVALID");
  }
  return value;
}

/** Requires explicit pause evidence and cadence state. Null/omitted cadence is
 * unknown, not a reset permission. Returned targets contain private source paths
 * and reservation identity: never log them. Unrelated target preferences come
 * exclusively from current defaults, not the source's settings record. */
export function prepareUsageStateControls(options) {
  if (!options || !exact(options, Object.hasOwn(options, "signal") ? ["controls", "cadence", "signal"] : ["controls", "cadence"])) fail("CONFIGURATION_INVALID");
  const { signal } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail("CONFIGURATION_INVALID");
  if (signal?.aborted) fail("CANCELLED");
  const controls = sourceControls(options.controls), cadence = options.cadence;
  if (!exact(cadence, ["schemaVersion", "lastAutomaticDetailedAtMs", "reservationToken"])
      || typeof cadence.schemaVersion !== "string"
      || cadence.lastAutomaticDetailedAtMs !== null && typeof cadence.lastAutomaticDetailedAtMs !== "number"
      || cadence.reservationToken !== null && typeof cadence.reservationToken !== "string") fail("CADENCE_INVALID");
  let desktopSettings, cadenceState;
  try {
    desktopSettings = validateDesktopSettingsSnapshot({
      ...DESKTOP_DEFAULT_SETTINGS,
      codexHomes: controls.codexHomes,
      refreshPaused: controls.refreshPaused,
      refreshIntervalSeconds: controls.refreshIntervalSeconds,
    });
  } catch { fail("CONTROLS_INVALID"); }
  try { cadenceState = DESKTOP_AUTOMATIC_REFRESH_CADENCE_CODEC.encode(cadence).value; }
  catch { fail("CADENCE_INVALID"); }
  return Object.freeze({ privateTargets: Object.freeze({ desktopSettings, cadence: cadenceState }),
    summary: Object.freeze({ schemaVersion: "usage-monitor-usage-control-projection-v1", status: "projected",
      scope: "validated_in_memory_targets_only", sourceRoots: desktopSettings.codexHomes.activityRoots.length,
      paused: desktopSettings.refreshPaused, persistence: "not_performed" }) });
}
