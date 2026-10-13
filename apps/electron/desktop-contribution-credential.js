import { createWindowsDesktopSettingsBackend } from "./desktop-settings-backends.js";

const FILE = "accountless-installation-credential-v1.json";
const SCHEMA = "accountless-encrypted-credential-v1";
const LIMIT = 4096;
const failures = new WeakSet();
const unavailable = ({ retryable = false } = {}) => {
  const error = Object.assign(new Error("Installation credential unavailable"),
    { code: "contribution_device_credential_unavailable", retryable: retryable === true });
  failures.add(error);
  return error;
};
function validate(value) {
  if (!value || Object.keys(value).sort().join(",") !== "encrypted,schemaVersion"
      || value.schemaVersion !== SCHEMA
      || (value.encrypted !== null && (typeof value.encrypted !== "string"
        || !/^[A-Za-z0-9+/]{4,3072}={0,2}$/u.test(value.encrypted)))) throw unavailable();
  return value;
}
const codec = {
  encode(value) { validate(value); return { value, bytes: Buffer.from(`${JSON.stringify(value)}\n`) }; },
  decodeBytes(bytes) { return validate(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); },
  decodeValue: validate,
};

function legacyRecoveryRequired() {
  return Object.assign(new Error("Installation credential recovery is required"), {
    code: "contribution_device_credential_recovery_required",
    retryable: false,
  });
}

function assertCredentialBackend(backend) {
  let valid = false;
  try {
    valid = backend !== null
      && typeof backend === "object"
      && !Array.isArray(backend)
      && ["read", "createIfMissing", "deleteExact"].every(
        (operation) => typeof backend[operation] === "function",
      );
  } catch {
    // An injected backend is main-process-only, but hostile values still
    // collapse to this fixed construction failure.
  }
  if (!valid) throw new TypeError("legacy recovery credential backend is invalid");
  return backend;
}

function assertLegacyCredentialProbe(legacyCredentialProbe) {
  if (typeof legacyCredentialProbe !== "function") {
    throw new TypeError("legacy credential probe is invalid");
  }
  return legacyCredentialProbe;
}

/**
 * Keep a prior Electron-encrypted installation credential from being silently
 * replaced by a later main-process native backend. This wrapper never reads,
 * decrypts, rewrites, or deletes the old record: anything except confirmed
 * absence takes the fixed recovery path before the native backend is touched.
 *
 * It is deliberately a main-process adapter. The wrapped backend is exposed
 * to an owned companion only through the existing private accountless channel.
 */
export function createDesktopContributionCredentialLegacyRecoveryBackend({
  backend,
  legacyCredentialProbe,
} = {}) {
  const selectedBackend = assertCredentialBackend(backend);
  const probe = assertLegacyCredentialProbe(legacyCredentialProbe);
  const assertLegacyCredentialAbsent = async () => {
    let status;
    try {
      status = await probe();
    } catch {
      throw legacyRecoveryRequired();
    }
    if (status !== "absent") throw legacyRecoveryRequired();
  };
  return Object.freeze({
    async read() {
      await assertLegacyCredentialAbsent();
      return selectedBackend.read();
    },
    async createIfMissing(value) {
      await assertLegacyCredentialAbsent();
      return selectedBackend.createIfMissing(value);
    },
    async deleteExact(value) {
      await assertLegacyCredentialAbsent();
      return selectedBackend.deleteExact(value);
    },
  });
}

/**
 * Inspect only the old ciphertext record before a production main-process
 * native backend mints an accountless identity. This deliberately never calls
 * safeStorage, decrypts, rewrites, or deletes the record: an encrypted or
 * unreadable legacy file must remain an explicit recovery boundary.
 */
export function createDesktopContributionCredentialLegacyProbe({
  platform = process.platform,
  rootPath,
  windowsProtectedStateStore,
  storage,
} = {}) {
  if (platform !== "win32") {
    throw new TypeError("legacy credential probe requires a supported platform");
  }
  if (storage !== undefined && (!storage || typeof storage.load !== "function")) {
    throw new TypeError("legacy credential probe storage is invalid");
  }
  // Create the platform store only when inspection begins. A native backend
  // factory failure must stop startup before this probe opens the old record.
  const selected = () => storage ?? createWindowsDesktopSettingsBackend({
    platform,
    windowsProtectedStateStore,
    childName: FILE,
    maximumBytes: LIMIT,
    codec,
  });
  return Object.freeze({
    async inspect() {
      let stored;
      try { stored = await selected().load(); }
      catch { return "unavailable"; }
      try {
        if (stored === null) return "absent";
        return validate(stored).encrypted === null ? "absent" : "present";
      } catch {
        return "unavailable";
      }
    },
  });
}
