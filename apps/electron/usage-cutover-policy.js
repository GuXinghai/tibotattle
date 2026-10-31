import { isWindowsProtectedStateStore, isWindowsProtectedStateStoreError } from "../../src/platform/index.js";
import { shellError } from "./errors.js";

// Target-generated startup interlock, not a backup/conversion acknowledgement.
// The operator's separate durable intent must bind and reconcile the resources
// before replacing prepared with activated. App startup never performs recovery.
export const USAGE_CUTOVER_POLICY_FILE = "usage-cutover-policy-v1.json";
export const USAGE_CUTOVER_POLICY_SCHEMA = "usage-monitor-usage-cutover-policy-v1";
export const USAGE_CUTOVER_POLICY_MAX_BYTES = 2048;
const KEYS = ["schemaVersion", "operationId", "phase", "observationIdentity"];

export function validateUsageCutoverPolicy(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== KEYS.length
      || !KEYS.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"))
      || value.schemaVersion !== USAGE_CUTOVER_POLICY_SCHEMA
      || typeof value.operationId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.operationId)
      || !["prepared", "activated"].includes(value.phase)
      || value.observationIdentity !== "existing_only") throw shellError("usage_cutover_blocked");
  return Object.freeze(Object.fromEntries(KEYS.map(key => [key, value[key]])));
}

/** A missing fixed record is the ordinary non-cutover path. Inaccessible,
 * malformed, oversized and prepared records all block before a companion or
 * credential backend is composed. This function never writes or replays. */
export function readUsageCutoverStartupPolicy(store) {
  if (!isWindowsProtectedStateStore(store)) throw shellError("usage_cutover_blocked");
  let record;
  try { record = store.read(USAGE_CUTOVER_POLICY_FILE); }
  catch (error) {
    if (isWindowsProtectedStateStoreError(error) && error.code === "windows_protected_state_store_missing") return null;
    throw shellError("usage_cutover_blocked");
  }
  try {
    if (!Buffer.isBuffer(record.data) || record.data.length < 1 || record.data.length > USAGE_CUTOVER_POLICY_MAX_BYTES)
      throw shellError("usage_cutover_blocked");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(record.data);
    const value = JSON.parse(text), policy = validateUsageCutoverPolicy(value);
    // Reject ambiguous/duplicate-key encodings rather than letting the last
    // occurrence choose activation or identity semantics.
    if (text !== JSON.stringify(value) + "\n" || policy.phase !== "activated") throw shellError("usage_cutover_blocked");
    return policy;
  } catch { throw shellError("usage_cutover_blocked"); }
  finally { record?.data?.fill(0); }
}
