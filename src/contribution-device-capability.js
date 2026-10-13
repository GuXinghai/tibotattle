import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  lstat,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { defaultExportStateDirectory } from "./export-identity.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  assertWindowsProductionReadiness,
  createWindowsProductionCapabilityBackend,
  createWindowsFilesystemAdapter,
  createWindowsProtectedStateStore,
} from "./platform/index.js";

const SECRET_BYTES = 32;
const MAXIMUM_STATE_BYTES = 512;
const STATE_SCHEMA_VERSION = "contribution-device-binding-v1";
const HASH_DOMAIN = "app-usagemonitor/device/v1\0";
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAPABILITY = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.contributionDevice;

const ERROR_CODES = new Set([
  "invalid_configuration",
  "origin_invalid",
  "origin_conflict",
  "device_id_invalid",
  "credential_locked",
  "credential_denied",
  "credential_migration_required",
  "credential_recovery_required",
  "credential_unavailable",
  "credential_mutation_uncertain",
  "credential_missing",
  "credential_conflict",
  "state_unavailable",
  "state_invalid",
  "operation_failed",
  "callback_result_invalid",
  "remote_revocation_required",
  "confirmation_invalid",
]);

export class ContributionDeviceCapabilityError extends Error {
  constructor(code, { retryable = false } = {}) {
    if (!ERROR_CODES.has(code)) throw new TypeError("Unknown contribution device capability error code");
    super("Contribution device capability operation failed");
    this.name = "ContributionDeviceCapabilityError";
    this.code = `contribution_device_${code}`;
    this.retryable = retryable === true;
  }
}

function fail(code, options = {}) {
  throw new ContributionDeviceCapabilityError(code, options);
}

function assertBackend(backend) {
  let valid = false;
  try {
    valid = backend !== null && typeof backend === "object"
      && typeof backend.read === "function"
      && typeof backend.createIfMissing === "function"
      && typeof backend.deleteExact === "function";
  } catch {
    // Collapse hostile injected backends to one fixed configuration error.
  }
  if (!valid) fail("invalid_configuration");
  return backend;
}

function translateBackendFailure(error) {
  let code;
  let retryable;
  try {
    code = error?.code;
    retryable = error?.retryable === true;
  } catch {
    fail("credential_unavailable");
  }
  if (code === "export_identity_keychain_locked") fail("credential_locked");
  if (code === "export_identity_keychain_denied") fail("credential_denied");
  if (code === "export_identity_keychain_migration_required") {
    fail("credential_migration_required");
  }
  if (code === "contribution_device_credential_mutation_uncertain") {
    fail("credential_mutation_uncertain", { retryable });
  }
  if (code === "contribution_device_credential_recovery_required") {
    fail("credential_recovery_required");
  }
  // A protected parent channel and the Electron credential adapter mark only
  // provider availability failures as retryable. Do not infer retryability for
  // malformed, missing, conflicting, or unauthorized credential state.
  if (code === "contribution_device_credential_unavailable") {
    fail("credential_unavailable", { retryable });
  }
  fail("credential_unavailable");
}

async function invokeBackend(backend, method, ...args) {
  try {
    return await backend[method](CAPABILITY, ...args);
  } catch (error) {
    if (error instanceof ContributionDeviceCapabilityError) throw error;
    translateBackendFailure(error);
  }
}

function copySecret(value) {
  if (!Buffer.isBuffer(value) || value.byteLength !== SECRET_BYTES) {
    if (Buffer.isBuffer(value)) value.fill(0);
    fail("credential_unavailable");
  }
  return Buffer.from(value);
}

function normalizeDeviceId(value) {
  if (typeof value !== "string" || !DEVICE_ID_PATTERN.test(value)) fail("device_id_invalid");
  return value;
}

function normalizeOrigin(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2048) fail("origin_invalid");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("origin_invalid");
  }
  const loopback = parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost");
  if ((parsed.protocol !== "https:" && !loopback)
      || parsed.username !== "" || parsed.password !== ""
      || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== ""
      || parsed.origin === "null") {
    fail("origin_invalid");
  }
  return parsed.origin;
}

function canonicalState({ origin, deviceId, createdAt }) {
  return `${JSON.stringify({
    schemaVersion: STATE_SCHEMA_VERSION,
    origin,
    deviceId,
    createdAt,
  })}\n`;
}

function parseState(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_STATE_BYTES) {
    fail("state_invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("state_invalid");
  }
  const keys = Object.keys(parsed ?? {}).sort().join("\0");
  const createdAtMs = Date.parse(parsed?.createdAt);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || keys !== "createdAt\0deviceId\0origin\0schemaVersion"
      || parsed.schemaVersion !== STATE_SCHEMA_VERSION
      || !Number.isFinite(createdAtMs)
      || new Date(createdAtMs).toISOString() !== parsed.createdAt) {
    fail("state_invalid");
  }
  const state = {
    origin: normalizeOrigin(parsed.origin),
    deviceId: normalizeDeviceId(parsed.deviceId),
    createdAt: parsed.createdAt,
  };
  if (canonicalState(state) !== bytes.toString("utf8")) fail("state_invalid");
  return Object.freeze(state);
}

async function inspectState(stateFile) {
  if (typeof stateFile !== "string" || stateFile.length < 1 || stateFile.length > 4096) {
    fail("invalid_configuration");
  }
  try { await lstat(dirname(resolve(stateFile))); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("state_unavailable");
  }
  const store = protectedStateStore(stateFile);
  let nativeBytes;
  try {
    const result = store.read(basename(stateFile));
    nativeBytes = result.data;
    return Object.freeze({ state: parseState(nativeBytes), store,
      name: basename(stateFile), identity: result.identity });
  } catch (error) {
    if (error?.code === "windows_protected_state_store_missing") return null;
    if (error instanceof ContributionDeviceCapabilityError) throw error;
    fail("state_invalid");
  } finally { nativeBytes?.fill(0); }
}

function protectedStateStore(stateFile) {
  try {
    return createWindowsProtectedStateStore({ adapter: createWindowsFilesystemAdapter(),
      rootPath: dirname(resolve(stateFile)), maxBytes: MAXIMUM_STATE_BYTES });
  } catch { fail("state_unavailable"); }
}

async function readState(stateFile) {
  return (await inspectState(stateFile))?.state ?? null;
}

async function writeNewState(stateFile, content) {
  const store = protectedStateStore(stateFile);
  const name = basename(stateFile);
  const bytes = Buffer.from(content, "utf8");
  try {
    const created = store.create(name, bytes);
    return Object.freeze({ store, name, identity: created.identity });
  } catch (error) {
    if (error?.code === "windows_protected_state_store_already_exists") fail("credential_conflict");
    fail("state_unavailable");
  } finally { bytes.fill(0); }
}

async function removeCreatedState(publication) {
  try { publication.store.delete(publication.name, publication.identity); }
  catch (error) {
    if (["missing", "identity_mismatch"].some((code) =>
      error?.code === `windows_protected_state_store_${code}`)) return;
    fail("state_unavailable");
  }
}

async function removeInspectedState(inspection) {
  try { inspection.store.delete(inspection.name, inspection.identity); }
  catch { fail("state_invalid"); }
}

function hashSecret(deviceId, secret) {
  const selectedId = normalizeDeviceId(deviceId);
  let copied = null;
  try {
    copied = copySecret(secret);
    return createHash("sha256")
      .update(HASH_DOMAIN)
      .update(selectedId)
      .update("\0")
      .update(copied)
      .digest("hex");
  } finally {
    copied?.fill(0);
  }
}

function publicResult(status, state, secret) {
  return Object.freeze({
    status,
    origin: state.origin,
    deviceId: state.deviceId,
    createdAt: state.createdAt,
    deviceSecretHash: hashSecret(state.deviceId, secret),
  });
}

function sameState(left, right) {
  return left?.origin === right?.origin
    && left?.deviceId === right?.deviceId
    && left?.createdAt === right?.createdAt;
}

export function defaultContributionDeviceStateFile(options) {
  return join(defaultExportStateDirectory(options), "contribution-device-binding-v1.json");
}

export function createProductionContributionDeviceBackend({
  platform = process.platform,
  architecture = process.arch,
  windowsReadiness = null,
  createWindowsBackend = null,
} = {}) {
  if (platform !== "win32"
      || architecture !== "x64"
      || typeof createWindowsBackend !== "function") {
    fail("invalid_configuration");
  }
  try {
    assertWindowsProductionReadiness({
      platform,
      architecture,
      readiness: windowsReadiness,
    });
    const windowsBackend = createWindowsBackend({ platform, architecture });
    return createWindowsProductionCapabilityBackend({
      backend: windowsBackend,
      capability: CAPABILITY,
      readiness: windowsReadiness,
    });
  } catch {
    fail("invalid_configuration");
  }
}

export async function readContributionDeviceCapability({
  backend,
  stateFile = defaultContributionDeviceStateFile(),
  expectedOrigin = null,
} = {}) {
  const selected = assertBackend(backend);
  const state = await readState(stateFile);
  let stored = null;
  try {
    stored = await invokeBackend(selected, "read");
    if (state === null && stored === null) return null;
    if (state === null) fail("credential_conflict");
    if (stored === null) fail("credential_missing");
    if (expectedOrigin !== null && state.origin !== normalizeOrigin(expectedOrigin)) fail("origin_conflict");
    return publicResult("available", state, stored);
  } finally {
    if (Buffer.isBuffer(stored)) stored.fill(0);
  }
}

export async function ensureContributionDeviceCapability({
  backend,
  origin,
  stateFile = defaultContributionDeviceStateFile(),
  generateDeviceId = randomUUID,
  generateSecret = () => randomBytes(SECRET_BYTES),
  clock = () => Date.now(),
} = {}) {
  const selected = assertBackend(backend);
  const normalizedOrigin = normalizeOrigin(origin);
  if (typeof generateDeviceId !== "function" || typeof generateSecret !== "function"
      || typeof clock !== "function") {
    fail("invalid_configuration");
  }
  const existing = await readContributionDeviceCapability({
    backend: selected,
    stateFile,
    expectedOrigin: normalizedOrigin,
  });
  if (existing !== null) return Object.freeze({ ...existing, status: "existing" });

  let generatedValue = null;
  let generated = null;
  let readback = null;
  let publication = null;
  let stored = false;
  let mutationOutcomeUncertain = false;
  try {
    let generatedDeviceId;
    let now;
    try {
      generatedDeviceId = generateDeviceId();
      now = clock();
    } catch {
      fail("invalid_configuration");
    }
    const deviceId = normalizeDeviceId(generatedDeviceId);
    if (!Number.isFinite(now)) fail("invalid_configuration");
    let createdAt;
    try {
      createdAt = new Date(now).toISOString();
    } catch {
      fail("invalid_configuration");
    }
    const state = Object.freeze({
      origin: normalizedOrigin,
      deviceId,
      createdAt,
    });
    if (Date.parse(state.createdAt) !== now) fail("invalid_configuration");
    try {
      generatedValue = generateSecret();
    } catch {
      fail("credential_unavailable");
    }
    generated = copySecret(generatedValue);
    publication = await writeNewState(stateFile, canonicalState(state));
    let outcome;
    try {
      outcome = await invokeBackend(selected, "createIfMissing", generated);
    } catch (error) {
      mutationOutcomeUncertain = error instanceof ContributionDeviceCapabilityError
        && error.code === "contribution_device_credential_mutation_uncertain";
      throw error;
    }
    if (outcome !== "created") fail("credential_conflict");
    stored = true;
    readback = await invokeBackend(selected, "read");
    if (readback === null || !Buffer.isBuffer(readback) || readback.byteLength !== SECRET_BYTES
        || !timingSafeEqual(readback, generated)) {
      fail("credential_unavailable");
    }
    return publicResult("created", state, readback);
  } finally {
    if (Buffer.isBuffer(generatedValue)) generatedValue.fill(0);
    generated?.fill(0);
    if (Buffer.isBuffer(readback)) readback.fill(0);
    if (publication !== null && !stored && !mutationOutcomeUncertain) {
      await removeCreatedState(publication);
    }
  }
}

function aliasesSecret(result, secret) {
  if (result instanceof ArrayBuffer) return result === secret.buffer;
  if (!ArrayBuffer.isView(result)) return false;
  if (result.buffer !== secret.buffer) return false;
  const resultStart = result.byteOffset;
  const resultEnd = resultStart + result.byteLength;
  const secretStart = secret.byteOffset;
  const secretEnd = secretStart + secret.byteLength;
  return resultStart < secretEnd && resultEnd > secretStart;
}

/**
 * Lease the device secret to one awaited in-memory operation. The temporary
 * Buffer is zeroized before this function settles and must never be returned by
 * the callback. Callers remain responsible for ensuring their operation does
 * not log or persist the secret.
 */
export async function withContributionDeviceSecret({
  backend,
  stateFile = defaultContributionDeviceStateFile(),
  expectedOrigin = null,
  operation,
} = {}) {
  const selected = assertBackend(backend);
  if (typeof operation !== "function") fail("invalid_configuration");
  const state = await readState(stateFile);
  let stored = null;
  let temporary = null;
  try {
    stored = await invokeBackend(selected, "read");
    if (state === null && stored === null) fail("credential_missing");
    if (state === null) fail("credential_conflict");
    if (stored === null) fail("credential_missing");
    if (expectedOrigin !== null && state.origin !== normalizeOrigin(expectedOrigin)) fail("origin_conflict");
    temporary = copySecret(stored);
    let result;
    try {
      result = await operation(temporary, Object.freeze({
        origin: state.origin,
        deviceId: state.deviceId,
        createdAt: state.createdAt,
      }));
    } catch {
      fail("operation_failed");
    }
    if (aliasesSecret(result, temporary)) fail("callback_result_invalid");
    return result;
  } finally {
    temporary?.fill(0);
    if (Buffer.isBuffer(stored)) stored.fill(0);
  }
}

/**
 * Silently rotate this Mac's device-upload secret in place — the local half of
 * the sign-in-once auto-renewal (docs/design/2026-08-11-sign-in-once-durability
 * section 2). A fresh 32-byte secret is generated locally, its
 * domain-separated hash is handed to `performRemoteRotation` (the caller's
 * network call to the renew route), and only after the service confirms the
 * rotation committed is the Keychain value replaced compare-and-swap. No user
 * sign-in is involved: the existing secret authenticates the renewal.
 *
 * Ordering guarantees the credential is never left invalid by a benign failure:
 * if the remote rotation does not commit, the service still holds the old
 * secret and the untouched Keychain value stays valid; the next pass retries.
 * The one residual hazard is a failure strictly between the service commit and
 * the local swap (a wedged Keychain, or a crash in that window) — the service
 * would then hold the new secret while the Keychain holds the old, and the next
 * device auth is revoked, degrading to exactly today's re-pair. That window is a
 * single keytar update wide and only reachable ~monthly, so it is accepted
 * rather than guarded by persisting the new secret to disk.
 */
export async function rotateContributionDeviceCredential({
  backend,
  stateFile = defaultContributionDeviceStateFile(),
  expectedOrigin = null,
  performRemoteRotation,
  generateSecret = () => randomBytes(SECRET_BYTES),
  deriveSecret = null,
} = {}) {
  const selected = assertBackend(backend);
  if (typeof performRemoteRotation !== "function"
      || typeof generateSecret !== "function"
      || (deriveSecret !== null && typeof deriveSecret !== "function")) {
    fail("invalid_configuration");
  }
  const state = await readState(stateFile);
  let oldStored = null;
  let oldSecret = null;
  let newValue = null;
  let newSecret = null;
  let readback = null;
  try {
    oldStored = await invokeBackend(selected, "read");
    if (state === null && oldStored === null) fail("credential_missing");
    if (state === null) fail("credential_conflict");
    if (oldStored === null) fail("credential_missing");
    if (expectedOrigin !== null
        && state.origin !== normalizeOrigin(expectedOrigin)) {
      fail("origin_conflict");
    }
    oldSecret = copySecret(oldStored);
    try {
      // Fresh-social re-pairing uses a deterministic, purpose-separated target
      // so an unacknowledged remote commit can be reconstructed on retry. The
      // ordinary renewal API retains its existing random-secret default.
      newValue = deriveSecret === null ? generateSecret() : deriveSecret(Object.freeze({
        currentSecret: oldSecret, origin: state.origin, deviceId: state.deviceId,
      }));
    } catch {
      fail("credential_unavailable");
    }
    newSecret = copySecret(newValue);
    // A rotation to the same secret is rejected by the service and would be a
    // no-op locally; a working generator makes this astronomically unlikely.
    if (timingSafeEqual(oldSecret, newSecret)) fail("credential_conflict");
    const nextDeviceSecretHash = hashSecret(state.deviceId, newSecret);
    let remote;
    try {
      remote = await performRemoteRotation(Object.freeze({
        origin: state.origin,
        deviceId: state.deviceId,
        currentSecret: oldSecret,
        nextDeviceSecretHash,
      }));
    } catch (error) {
      if (error instanceof ContributionDeviceCapabilityError) throw error;
      fail("operation_failed");
    }
    if (!remote || typeof remote !== "object" || Array.isArray(remote)
        || remote.committed !== true
        || typeof remote.expiresAt !== "string"
        || !Number.isFinite(Date.parse(remote.expiresAt))) {
      // Not committed: the service still holds the old secret. Leave the
      // Keychain value untouched and valid; the caller retries next pass.
      fail("operation_failed");
    }
    const outcome = await invokeBackend(
      selected,
      "replaceExact",
      oldSecret,
      newSecret,
    );
    if (outcome === "conflict") fail("credential_conflict");
    if (outcome === "missing") fail("credential_missing");
    if (outcome !== "replaced") fail("credential_unavailable");
    readback = await invokeBackend(selected, "read");
    if (readback === null || !Buffer.isBuffer(readback)
        || readback.byteLength !== SECRET_BYTES
        || !timingSafeEqual(readback, newSecret)) {
      fail("credential_unavailable");
    }
    return Object.freeze({
      status: "renewed",
      origin: state.origin,
      deviceId: state.deviceId,
      expiresAt: new Date(remote.expiresAt).toISOString(),
    });
  } finally {
    if (Buffer.isBuffer(oldStored)) oldStored.fill(0);
    oldSecret?.fill(0);
    if (Buffer.isBuffer(newValue)) newValue.fill(0);
    newSecret?.fill(0);
    if (Buffer.isBuffer(readback)) readback.fill(0);
  }
}

/**
 * Remove the local device binding only after the caller has confirmed that the
 * remote device was revoked. A failed or unattempted remote operation must pass
 * false and therefore cannot delete the local credential.
 */
export async function removeContributionDeviceCapability({
  backend,
  stateFile = defaultContributionDeviceStateFile(),
  expectedOrigin = null,
  confirmDeviceId,
  remoteRevocationConfirmed = false,
} = {}) {
  const selected = assertBackend(backend);
  if (remoteRevocationConfirmed !== true) fail("remote_revocation_required");
  const inspection = await inspectState(stateFile);
  let stored = null;
  let expected = null;
  try {
    stored = await invokeBackend(selected, "read");
    if (inspection === null && stored === null) return Object.freeze({ status: "missing" });
    if (inspection === null) fail("credential_conflict");
    const { state } = inspection;
    if (confirmDeviceId !== state.deviceId) fail("confirmation_invalid");
    if (expectedOrigin !== null && state.origin !== normalizeOrigin(expectedOrigin)) fail("origin_conflict");
    let credential = "already_missing";
    if (stored !== null) {
      expected = copySecret(stored);
      const outcome = await invokeBackend(selected, "deleteExact", expected);
      if (outcome === "conflict") fail("credential_conflict");
      if (outcome !== "deleted" && outcome !== "missing") fail("credential_unavailable");
      credential = outcome === "deleted" ? "deleted" : "already_missing";
    }
    await removeInspectedState(inspection);
    return Object.freeze({
      status: "removed",
      deviceId: state.deviceId,
      credential,
      secureErasure: false,
    });
  } finally {
    expected?.fill(0);
    if (Buffer.isBuffer(stored)) stored.fill(0);
  }
}
