import { createHmac, createSecretKey, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Device-local identity for the local index store.
//
// The salt is the root of every local join key and, through the export
// boundary, of every hosted pseudonym. It is created once and never rotated or
// regenerated: a missing or damaged salt is an error, not a reason to mint a
// new one over existing facts. `localDigest` is byte-identical to the shipping
// index's derivation so ids stay stable across the store change.

const SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 256;
const DIGEST_KEYS = new WeakMap();

export const RAW_SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function ownerOnlyRegularFile(metadata) {
  return metadata.isFile()
    && metadata.nlink === 1
    && (typeof process.getuid !== "function" || metadata.uid === process.getuid())
    && (process.platform === "win32" || (metadata.mode & 0o077) === 0);
}

/** Read the salt, creating it exactly once when the file does not exist. */
export async function readOrCreateDeviceSalt(secretFile) {
  const path = resolve(secretFile);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (error?.code !== "EEXIST") throw fixedError("local_index_secret_unavailable");
    return readExistingDeviceSalt(path);
  }
  try {
    const secret = randomBytes(SECRET_BYTES);
    writeSync(descriptor, secret);
    return secret;
  } finally {
    closeSync(descriptor);
  }
}

/** Read an existing salt without creating or repairing anything. */
export async function readExistingDeviceSalt(secretFile) {
  const path = resolve(secretFile);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = fstatSync(descriptor);
    if (!ownerOnlyRegularFile(metadata)
        || metadata.size < SECRET_BYTES
        || metadata.size > MAX_SECRET_BYTES) {
      throw fixedError("local_index_secret_invalid");
    }
    const buffer = readFileSync(descriptor);
    if (buffer.length !== metadata.size) throw fixedError("local_index_secret_invalid");
    if (process.platform !== "win32") await chmod(path, 0o600);
    return buffer;
  } catch (error) {
    if (error?.code?.startsWith("local_index_")) throw error;
    throw fixedError("local_index_secret_unavailable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function digestKey(deviceSalt) {
  const bytes = Buffer.isBuffer(deviceSalt)
    ? deviceSalt
    : new Uint8Array(deviceSalt.buffer, deviceSalt.byteOffset, deviceSalt.byteLength);
  if (bytes.byteLength > MAX_SECRET_BYTES) return deviceSalt;
  let cached = DIGEST_KEYS.get(deviceSalt);
  if (cached === undefined || !cached.bytes.equals(bytes)) {
    cached = { bytes: Buffer.from(bytes), key: createSecretKey(bytes) };
    DIGEST_KEYS.set(deviceSalt, cached);
  }
  return cached.key;
}

/** Domain-separated HMAC-SHA-256 returning 32 raw bytes. */
export function localDigest(deviceSalt, domain, subject) {
  if (!Buffer.isBuffer(deviceSalt) && !ArrayBuffer.isView(deviceSalt)) {
    throw new TypeError("deviceSalt must be a byte buffer");
  }
  if (typeof domain !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(domain)) {
    throw new TypeError("domain must be a short lowercase label");
  }
  if (typeof subject !== "string" || subject.length < 1 || subject.length > 4096) {
    throw new TypeError("subject must be a bounded string");
  }
  return createHmac("sha256", digestKey(deviceSalt))
    .update(`app-usagemonitor/${domain}/v1\0`, "utf8")
    .update(subject, "utf8")
    .digest();
}

export const sessionLocal = (salt, codexSessionId) => localDigest(salt, "unified-index-session", codexSessionId);
export const scopeLocal = (salt, accountScopeId) => localDigest(salt, "unified-index-scope", accountScopeId);
export const sourceLocal = (salt, rolloutKey) => localDigest(salt, "unified-index-source", rolloutKey);
export const snapshotLocal = (salt, snapshotKey) => localDigest(salt, "unified-index-snapshot", snapshotKey);
