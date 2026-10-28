import { DEFAULT_UNKNOWN_SPEED_POLICY, validateUnknownSpeedPolicy } from "../../src/unknown-speed-policy.js";

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Process-local settings only: configuration never starts a refresh. */
export function createUnknownSpeedPolicyConfiguration(environment = {}) {
  const serialized = environment.USAGE_MONITOR_UNKNOWN_SPEED_POLICY;
  let policy = validateUnknownSpeedPolicy(serialized === undefined
    ? DEFAULT_UNKNOWN_SPEED_POLICY : JSON.parse(serialized));
  return Object.freeze({
    get: () => policy,
    set: value => { policy = validateUnknownSpeedPolicy(value); },
  });
}

/** Only the inherited parent IPC channel may update this closed setting. */
export function attachUnknownSpeedPolicyChannel({ channel, setPolicy }) {
  const onMessage = message => {
    if (!message || Object.getPrototypeOf(message) !== Object.prototype
        || Reflect.ownKeys(message).length !== 3
        || message.type !== "usagemonitor.unknown-speed-policy.v1"
        || !Object.hasOwn(message, "requestId")
        || typeof message.requestId !== "string" || !REQUEST_ID.test(message.requestId)
        || !Object.hasOwn(message, "policy")) return;
    let policy;
    try { policy = validateUnknownSpeedPolicy(message.policy); }
    catch { return; }
    try { setPolicy(policy); }
    catch { return; }
    // A successful send callback on the parent only proves transport. This
    // receipt is sent after the synchronous configuration update is applied.
    // An unavailable channel leaves the parent to its bounded failure path.
    try {
      channel.send({ type: "usagemonitor.unknown-speed-policy-applied.v1", requestId: message.requestId }, () => {});
    } catch { /* A closed parent channel cannot authorize a successful save. */ }
  };
  channel.on("message", onMessage);
  return () => channel.off("message", onMessage);
}
