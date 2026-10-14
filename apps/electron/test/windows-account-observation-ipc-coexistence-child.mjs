import { timingSafeEqual } from "node:crypto";

import {
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_CAPABILITY,
  createWindowsAccountObservationBrokerBackendFromEnvironment,
} from "../../../src/platform/index.js";

const SCHEMA = "windows-account-observation-ipc-coexistence-test-v1";

function exact(value, keys) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === keys.length
      && keys.every((key) => Object.hasOwn(value, key));
  } catch {
    return false;
  }
}

function sameSecret(left, right) {
  try {
    return Buffer.isBuffer(left)
      && Buffer.isBuffer(right)
      && left.byteLength === 32
      && right.byteLength === 32
      && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function isStart(message) {
  return exact(message, ["schemaVersion", "kind"])
    && message.schemaVersion === SCHEMA && message.kind === "start-v1";
}

function isStop(message) {
  return exact(message, ["schemaVersion", "kind"])
    && message.schemaVersion === SCHEMA && message.kind === "stop-v1";
}

let finished = false;

function finish(status) {
  if (finished) return;
  finished = true;
  try {
    process.send(Object.freeze({ schemaVersion: SCHEMA, kind: "result-v1", status }), (error) => {
      if (error) process.exit(1);
    });
  } catch {
    process.exitCode = 1;
  }
}

async function run() {
  const observation = createWindowsAccountObservationBrokerBackendFromEnvironment();
  if (observation === null) throw new Error("missing observation broker");
  const observationSecret = Buffer.alloc(32, 23);
  let observationRead = null;
  try {
    if (await observation.read(WINDOWS_ACCOUNT_OBSERVATION_BROKER_CAPABILITY) !== null) {
      throw new Error("unexpected initial record");
    }
    const created = await observation.createIfMissing(
      WINDOWS_ACCOUNT_OBSERVATION_BROKER_CAPABILITY,
      observationSecret,
    );
    if (created !== "created") throw new Error("record not created");
    observationRead = await observation.read(WINDOWS_ACCOUNT_OBSERVATION_BROKER_CAPABILITY);
    if (!sameSecret(observationRead, observationSecret)) {
      throw new Error("record roundtrip mismatch");
    }
  } finally {
    observationRead?.fill(0);
    observationSecret.fill(0);
  }
}

function onMessage(message) {
  if (message?.schemaVersion !== SCHEMA) return;
  if (finished) {
    if (isStop(message)) {
      process.off("message", onMessage);
      process.exit(0);
    }
    return;
  }
  if (!isStart(message)) {
    finish("failed-v1");
    return;
  }
  void run().then(() => finish("passed-v1"), () => finish("failed-v1"));
}

try {
  if (typeof process.send !== "function") throw new Error("missing parent IPC");
  process.on("message", onMessage);
  process.send(Object.freeze({ schemaVersion: SCHEMA, kind: "ready-v1" }), () => {});
} catch {
  process.exitCode = 1;
}
