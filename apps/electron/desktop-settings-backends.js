import { basename } from "node:path";

import {
  validateDesktopSettingsSnapshot,
} from "./desktop-contract.js";
import {
  isWindowsProtectedStateStore,
  isWindowsProtectedStateStoreError,
} from "../../src/platform/index.js";

/**
 * The settings payload is deliberately much smaller than the native Windows
 * state-store ceiling.  Keeping the limit here means the POSIX and protected
 * Windows implementations have the same bounded input contract.
 */
export const DESKTOP_SETTINGS_BACKEND_MAX_BYTES = 64 * 1024;
export const DESKTOP_SETTINGS_FILE_NAME = "desktop-settings-v1.json";
export const DESKTOP_SETTINGS_STAGE_PREFIX = ".desktop-settings-v1";

const ERROR_CODES = new Set([
  "invalid_configuration",
  "unsupported_platform",
  "invalid_snapshot",
  "unsafe_state",
  "corrupt",
  "too_large",
  "unavailable",
  "write_failed",
  "store_invalid",
  "store_unsafe",
  "reconciliation_required",
]);
const WINDOWS_ERROR_CODES = Object.freeze({
  windows_protected_state_store_invalid_configuration: "store_invalid",
  windows_protected_state_store_invalid_adapter: "store_invalid",
  windows_protected_state_store_invalid_root: "store_unsafe",
  windows_protected_state_store_invalid_path: "store_invalid",
  windows_protected_state_store_path_escape: "store_unsafe",
  windows_protected_state_store_invalid_identity: "store_unsafe",
  windows_protected_state_store_security_policy: "store_unsafe",
  windows_protected_state_store_missing: "missing",
  windows_protected_state_store_already_exists: "write_failed",
  windows_protected_state_store_identity_mismatch: "write_failed",
  windows_protected_state_store_too_large: "too_large",
  windows_protected_state_store_unavailable: "unavailable",
  windows_protected_state_store_contended: "write_failed",
  windows_protected_state_store_audit_failed: "unavailable",
});

const BACKEND_ERRORS = new WeakSet();

/**
 * Fixed, content-free errors for both settings backends.  Native filesystem
 * messages and paths never cross the Electron settings boundary.
 */
export class DesktopSettingsBackendError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) {
      throw new TypeError("Unknown desktop settings backend error code");
    }
    super("Desktop settings backend operation failed");
    this.name = "DesktopSettingsBackendError";
    this.code = `desktop_settings_backend_${code}`;
    BACKEND_ERRORS.add(this);
  }
}

export function isDesktopSettingsBackendError(error) {
  return Boolean(error
    && BACKEND_ERRORS.has(error)
    && Object.getPrototypeOf(error) === DesktopSettingsBackendError.prototype);
}

function fail(code) {
  throw new DesktopSettingsBackendError(code);
}

function nativeCode(error) {
  try {
    return typeof error?.code === "string" ? error.code : "";
  } catch {
    return "";
  }
}

function mapWindowsError(error, { missing = false } = {}) {
  if (isDesktopSettingsBackendError(error)) throw error;
  let code = "";
  try {
    if (isWindowsProtectedStateStoreError(error)) code = nativeCode(error);
  } catch {
    code = "";
  }
  const mapped = WINDOWS_ERROR_CODES[code] ?? "unavailable";
  if (mapped === "missing" && missing) return null;
  if (mapped === "missing") fail("unavailable");
  fail(mapped);
}

function assertOptionsObject(options, label) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError(`${label} must be an object`);
  }
  return options;
}

function assertPlatform(platform) {
  if (typeof platform !== "string" || platform.length === 0) {
    throw new TypeError("platform must be a non-empty string");
  }
  if (platform !== "win32") {
    fail("unsupported_platform");
  }
  return platform;
}

function assertFixedChildName(name) {
  if (typeof name !== "string"
      || name.length < 1
      || name.length > 255
      || name.includes("\0")
      || basename(name) !== name
      || name === "."
      || name === ".."
      || name.includes("/")
      || name.includes("\\")) {
    throw new TypeError("settings filename must be one fixed child name");
  }
  return name;
}

function assertMaximumBytes(maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes)
      || maximumBytes < 1
      || maximumBytes > DESKTOP_SETTINGS_BACKEND_MAX_BYTES) {
    throw new TypeError("maximumBytes is invalid");
  }
  return maximumBytes;
}

function encodeSnapshot(snapshot, maximumBytes) {
  let validated;
  try {
    validated = validateDesktopSettingsSnapshot(snapshot);
  } catch {
    fail("invalid_snapshot");
  }
  let bytes;
  try {
    bytes = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
  } catch {
    fail("invalid_snapshot");
  }
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
    bytes.fill(0);
    fail("too_large");
  }
  return Object.freeze({ snapshot: validated, bytes });
}

function decodeSnapshot(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    fail("corrupt");
  }
  try {
    return validateDesktopSettingsSnapshot(parsed);
  } catch {
    fail("corrupt");
  }
}

/**
 * The settings file format is also used by the first-run receipt, which is a
 * separate fixed child with a different schema.  Keep the filesystem and
 * protected-store security code shared while making the value codec explicit
 * so one record can never be decoded as another record by accident.
 */
function defaultRecordCodec() {
  return Object.freeze({
    encode(value, maximumBytes) {
      const encoded = encodeSnapshot(value, maximumBytes);
      return Object.freeze({ value: encoded.snapshot, bytes: encoded.bytes });
    },
    decodeBytes(bytes) {
      return decodeSnapshot(bytes);
    },
    decodeValue(value) {
      try {
        return validateDesktopSettingsSnapshot(value);
      } catch {
        fail("corrupt");
      }
    },
  });
}

function assertRecordCodec(codec) {
  const selected = codec === undefined ? defaultRecordCodec() : codec;
  if (selected === null
      || typeof selected !== "object"
      || Array.isArray(selected)
      || typeof selected.encode !== "function"
      || typeof selected.decodeBytes !== "function"
      || typeof selected.decodeValue !== "function") {
    throw new TypeError("codec must implement encode, decodeBytes, and decodeValue");
  }
  return selected;
}

function assertEncodedRecord(encoded, maximumBytes) {
  if (encoded === null
      || typeof encoded !== "object"
      || Array.isArray(encoded)
      || !(encoded.bytes instanceof Uint8Array)
      || encoded.bytes.byteLength < 1
      || encoded.bytes.byteLength > maximumBytes
      || encoded.value === null
      || typeof encoded.value !== "object"
      || Array.isArray(encoded.value)) {
    fail("invalid_snapshot");
  }
  return encoded;
}

function assertProtectedRecordBytes(record, maximumBytes) {
  if (!(record?.data instanceof Uint8Array)
      || record.data.byteLength < 1) {
    fail("corrupt");
  }
  if (record.data.byteLength > maximumBytes) fail("too_large");
}

/**
 * Windows settings backend over the repository-branded protected state store.
 * This adapter intentionally has no ordinary Node filesystem fallback.  The
 * protected store returns an identity with every read; replacements must pass
 * that exact identity back to replaceJson.
 */
export function createWindowsDesktopSettingsBackend(options = {}) {
  const configuration = assertOptionsObject(options, "options");
  assertPlatform(configuration.platform ?? "win32");
  let store;
  try {
    store = configuration.windowsProtectedStateStore;
    if (!isWindowsProtectedStateStore(store)) fail("store_invalid");
  } catch (error) {
    if (isDesktopSettingsBackendError(error)) throw error;
    fail("store_invalid");
  }
  if (typeof store.readJson !== "function"
      || typeof store.createJson !== "function"
      || typeof store.replaceJson !== "function") {
    fail("store_invalid");
  }
  const childName = assertFixedChildName(
    configuration.childName ?? DESKTOP_SETTINGS_FILE_NAME,
  );
  const storeMaximumBytes = Number.isSafeInteger(store.maxBytes)
    ? store.maxBytes
    : DESKTOP_SETTINGS_BACKEND_MAX_BYTES;
  const maximumBytes = assertMaximumBytes(
    configuration.maximumBytes ?? Math.min(
      DESKTOP_SETTINGS_BACKEND_MAX_BYTES,
      storeMaximumBytes,
    ),
  );
  if (storeMaximumBytes < maximumBytes) fail("store_invalid");
  const codec = assertRecordCodec(configuration.codec);

  async function load() {
    let record;
    try {
      record = await store.readJson(childName);
    } catch (error) {
      return mapWindowsError(error, { missing: true });
    }
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      fail("corrupt");
    }
    assertProtectedRecordBytes(record, maximumBytes);
    const data = record.value;
    let validated;
    try {
      validated = codec.decodeValue(data);
    } catch {
      fail("corrupt");
    }
    return validated;
  }

  async function save(snapshot) {
    // validate and bound before touching the protected state store.  The
    // native store performs its own stable JSON serialization and ceiling
    // check, but the desktop contract remains the authority here.
    const encoded = assertEncodedRecord(codec.encode(snapshot, maximumBytes), maximumBytes);
    encoded.bytes.fill(0);
    let existing;
    try {
      existing = await store.readJson(childName);
    } catch (error) {
      const code = nativeCode(error);
      if (!isWindowsProtectedStateStoreError(error)
          || code !== "windows_protected_state_store_missing") {
        mapWindowsError(error);
      }
    }
    try {
      if (existing === undefined || existing === null) {
        await store.createJson(childName, encoded.value);
      } else {
        if (typeof existing !== "object" || Array.isArray(existing)) fail("corrupt");
        assertProtectedRecordBytes(existing, maximumBytes);
        try {
          codec.decodeValue(existing.value);
        } catch {
          fail("corrupt");
        }
        await store.replaceJson(childName, existing.identity, encoded.value);
      }
    } catch (error) {
      if (isDesktopSettingsBackendError(error)) throw error;
      mapWindowsError(error);
    }
    return encoded.value;
  }

  return Object.freeze({ load, save });
}
