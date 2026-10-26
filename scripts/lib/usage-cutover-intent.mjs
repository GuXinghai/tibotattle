import { win32 } from "node:path";
import { stableJson } from "../../src/export/canonical-json.js";
import { openOperation } from "./release-operation.mjs";

// One selected usage action per durable intent. This helper NEVER performs or
// retries a physical action. Resource observations must come from a separately
// reviewed exact-bundle inspector, not an acknowledgement phase or cached tip.
export const USAGE_CUTOVER_INTENT_SCHEMA = "usage-monitor-usage-cutover-intent-v1";
const ACTIONS = ["backup_usage_bundle", "convert_usage_copy", "activate_usage_bundle", "archive_new_usage_history", "restore_usage_bundle"];
const BINDING_KEYS = ["operationId", "action", "bundleSelectionSha256", "sourceRootIdentitySha256", "targetRootIdentitySha256",
  "toolSha256", "candidateSha256", "preconditionsReportSha256", "historyArchiveManifestSha256", "before", "after"];
const RESOURCE_KEYS = ["sourceManifestSha256", "targetManifestSha256", "stagingManifestSha256"];
const errors = new WeakSet();
function fail(code) {
  const error = Object.assign(new Error("Usage cutover intent refused"), { code: `USAGE_CUTOVER_INTENT_${code}` });
  errors.add(error); throw error;
}
export const classifyUsageCutoverIntentFailure = error => errors.has(error) ? error.code : "USAGE_CUTOVER_INTENT_UNAVAILABLE";
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function exact(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));
}
function resources(value) {
  if (!exact(value, RESOURCE_KEYS) || !digest(value.sourceManifestSha256)
      || ![value.targetManifestSha256, value.stagingManifestSha256].every(value => value === null || digest(value))) fail("OBSERVATION_INVALID");
  return Object.freeze(Object.fromEntries(RESOURCE_KEYS.map(key => [key, value[key]])));
}
function binding(value) {
  if (!exact(value, BINDING_KEYS) || typeof value.operationId !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.operationId)
      || !ACTIONS.includes(value.action) || !BINDING_KEYS.slice(2, 8).every(key => digest(value[key]))
      || value.historyArchiveManifestSha256 !== null && !digest(value.historyArchiveManifestSha256)) fail("BINDING_INVALID");
  if (value.sourceRootIdentitySha256 === value.targetRootIdentitySha256) fail("ROOT_COLLISION");
  if (value.action === "restore_usage_bundle" && value.historyArchiveManifestSha256 === null) fail("NEW_HISTORY_UNPRESERVED");
  const before = resources(value.before), after = resources(value.after);
  if (stableJson(before) === stableJson(after) || before.sourceManifestSha256 !== after.sourceManifestSha256) fail("RESOURCE_PLAN_INVALID");
  if (value.action !== "restore_usage_bundle" && before.targetManifestSha256 !== null) fail("TARGET_NOT_EMPTY");
  if (after.targetManifestSha256 === null) fail("RESOURCE_PLAN_INVALID");
  return Object.freeze({ ...Object.fromEntries(BINDING_KEYS.slice(0, 9).map(key => [key, value[key]])), before, after });
}
function storageError(error) {
  const code = error?.code === "RELEASE_OPERATION_BUSY" ? "STORAGE_BUSY"
    : error?.code === "RELEASE_OPERATION_EXISTS_USE_RESUME" ? "RESUME_REQUIRED"
      : error?.code === "RELEASE_OPERATION_INPUT_MISMATCH" ? "BINDING_MISMATCH" : "STORAGE_UNAVAILABLE";
  fail(code);
}

/** Durable pre-mutation intent + reconciliation record only. Missing completion
 * NEVER grants replay. Even an unchanged observation requires explicit caller
 * action under fresh writer exclusion. Null means inspector-proven absence of
 * the exact target/staging bundle, not omitted or unavailable evidence. */
export async function openUsageCutoverIntent(options) {
  const keys = ["directory", "binding"];
  if (!options || !exact(options, Object.hasOwn(options, "resume") ? [...keys, "resume"] : keys)) fail("CONFIGURATION_INVALID");
  const { directory, resume = false } = options;
  if (typeof directory !== "string" || directory.includes("\0") || typeof resume !== "boolean"
      || !/^[A-Za-z]:[\\/]$/u.test(win32.parse(directory).root) || win32.resolve(directory) === win32.parse(directory).root
      || directory.split(/[\\/]/u).some(part => part === "." || part === "..")) fail("CONFIGURATION_INVALID");
  const selected = binding(options.binding), storageBinding = { schemaVersion: USAGE_CUTOVER_INTENT_SCHEMA, binding: selected };
  let operation;
  try { operation = await openOperation({ directory, kind: "maintenance", binding: storageBinding, resume }); }
  catch (error) { storageError(error); }
  let state, uncertain = false, closed = false, busy = false;
  const initial = Object.freeze({ schemaVersion: USAGE_CUTOVER_INTENT_SCHEMA, status: "intent_durable", observation: null, reportSha256: null });
  try {
    const raw = operation.record.state;
    if (Reflect.ownKeys(raw).length === 0) {
      // Only the exact bound metadata initialization is recoverable here.
      // It cannot execute, repeat, authorize or acknowledge a physical action.
      await operation.save(initial); state = initial;
    } else {
      if (!exact(raw, ["schemaVersion", "status", "observation", "reportSha256"]) || raw.schemaVersion !== USAGE_CUTOVER_INTENT_SCHEMA
          || !["intent_durable", "unchanged", "applied", "conflict"].includes(raw.status)) fail("STATE_INVALID");
      if (raw.status === "intent_durable") {
        if (raw.observation !== null || raw.reportSha256 !== null) fail("STATE_INVALID"); state = initial;
      } else {
        if (!digest(raw.reportSha256)) fail("STATE_INVALID");
        const observation = resources(raw.observation);
        const expectedStatus = stableJson(observation) === stableJson(selected.after) ? "applied"
          : stableJson(observation) === stableJson(selected.before) ? "unchanged" : "conflict";
        if (raw.status !== expectedStatus) fail("STATE_INVALID");
        state = Object.freeze({ ...raw, observation });
      }
    }
  } catch (error) {
    try { operation.close(); } catch { fail("STORAGE_CLOSE_FAILED"); }
    if (errors.has(error)) throw error; storageError(error);
  }
  return Object.freeze({
    summary() { return Object.freeze({ schemaVersion: USAGE_CUTOVER_INTENT_SCHEMA, action: selected.action,
      status: state.status, scope: "intent_and_supplied_resource_observation_only", replay: "never_automatic",
      freshResourceInspection: "required_before_any_action",
      persistence: uncertain ? "uncertain" : busy ? "saving" : closed ? "closed" : "settled" }); },
    async reconcile(request) {
      if (closed) fail("CLOSED"); if (uncertain) fail("PERSISTENCE_UNCERTAIN"); if (busy) fail("BUSY");
      if (!exact(request, ["observation", "reportSha256"]) || !digest(request.reportSha256)) fail("OBSERVATION_INVALID");
      const observation = resources(request.observation);
      const status = stableJson(observation) === stableJson(selected.after) ? "applied"
        : stableJson(observation) === stableJson(selected.before) ? "unchanged" : "conflict";
      // A prior applied/conflict observation is sticky. Do not overwrite it
      // with a stale before-state, guess rollback, or clear an interrupted draft.
      const next = Object.freeze({ schemaVersion: USAGE_CUTOVER_INTENT_SCHEMA, status, observation, reportSha256: request.reportSha256 });
      if (stableJson(next) === stableJson(state)) return status;
      if (["applied", "conflict"].includes(state.status)) fail("RECONCILIATION_CHANGED");
      busy = true;
      try { await operation.save(next); state = next; return status; }
      catch { uncertain = true; fail("PERSISTENCE_UNCERTAIN"); }
      finally { busy = false; }
    },
    close() { if (closed) return; if (busy) fail("BUSY"); closed = true;
      try { operation.close(); } catch { fail("STORAGE_CLOSE_FAILED"); } },
  });
}
