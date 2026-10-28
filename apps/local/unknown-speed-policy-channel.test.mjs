import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createUnknownSpeedPolicyConfiguration, attachUnknownSpeedPolicyChannel } from "./unknown-speed-policy-channel.js";

const requestId = "00000000-0000-4000-8000-000000000001";
const messageFor = policy => ({ type: "usagemonitor.unknown-speed-policy.v1", requestId, policy });

test("unknown speed configuration validates startup, closes IPC shape and never starts work", () => {
  const config = createUnknownSpeedPolicyConfiguration({});
  assert.deepEqual(config.get(), { mode: "standard", customFastRatioBps: null });
  for (const value of ["", "null", '{"mode":"custom","customFastRatioBps":null}', '{"mode":"fast","customFastRatioBps":0,"extra":true}']) {
    assert.throws(() => createUnknownSpeedPolicyConfiguration({ USAGE_MONITOR_UNKNOWN_SPEED_POLICY: value }));
  }
  const channel = new EventEmitter(); let updates = 0;
  const acknowledgements = [];
  channel.send = (message, callback) => {
    assert.equal(config.get().customFastRatioBps, 300, "configuration is applied before the receipt");
    acknowledgements.push(message); callback(null);
  };
  const detach = attachUnknownSpeedPolicyChannel({ channel, setPolicy: value => { updates++; config.set(value); } });
  const source = { mode: "custom", customFastRatioBps: 300 };
  channel.emit("message", messageFor(source));
  source.customFastRatioBps = 999;
  assert.equal(config.get().customFastRatioBps, 300);
  assert.ok(Object.isFrozen(config.get()));
  for (const message of [null, { type: "other", requestId, policy: source },
    { ...messageFor(source), extra: true },
    { ...messageFor(source), requestId: "invalid" },
    { ...messageFor(source), requestId: null },
    { type: "usagemonitor.unknown-speed-policy.v1", policy: source },
    messageFor({ mode: "custom", customFastRatioBps: -1 })]) channel.emit("message", message);
  assert.equal(updates, 1);
  assert.deepEqual(acknowledgements, [{ type: "usagemonitor.unknown-speed-policy-applied.v1", requestId }]);
  detach(); assert.equal(channel.listenerCount("message"), 0);
});

test("a failed policy application cannot be acknowledged and receipt transport failures are contained", () => {
  const channel = new EventEmitter(); let acknowledgements = 0;
  channel.send = () => { acknowledgements++; };
  const detach = attachUnknownSpeedPolicyChannel({ channel, setPolicy: () => { throw new Error("synthetic apply failure"); } });
  assert.doesNotThrow(() => channel.emit("message", messageFor({ mode: "standard", customFastRatioBps: null })));
  assert.equal(acknowledgements, 0); detach();
  let applied = 0;
  channel.send = () => { throw new Error("synthetic closed channel"); };
  const detachClosed = attachUnknownSpeedPolicyChannel({ channel, setPolicy: () => { applied++; } });
  assert.doesNotThrow(() => channel.emit("message", messageFor({ mode: "fast", customFastRatioBps: null })));
  assert.equal(applied, 1); detachClosed();
});
