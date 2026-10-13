// The device salt and the local one-way digests derived from it.
//
// The salt file keeps its historical name (`local-unified-index-device-salt-v1`):
// it is the durable root of local and hosted pseudonym continuity and must
// never be rotated, renamed or regenerated. Every index generation, past and
// future, derives its join keys from it.

import { createHmac, createSecretKey, randomBytes } from "node:crypto";

import { constants, lstatSync } from "node:fs";

import { chmod, mkdir, open } from "node:fs/promises";

import { dirname, resolve, join } from "node:path";

const SECRET_BYTES = 32;

const MAX_SECRET_BYTES = 256;

const LOCAL_DIGEST_KEYS = new WeakMap();

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function defaultLocalUnifiedIndexPath(root = process.cwd()) {
  return resolve(root, ".usage-monitor", "local-unified-index-v1.sqlite");
}

export function defaultLocalUnifiedIndexSecretPath(
  indexFile = defaultLocalUnifiedIndexPath(),
) {
  return resolve(dirname(resolve(indexFile)), "local-unified-index-device-salt-v1");
}

function ownerOnlyRegularFile(metadata) {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1;
}

function safeDirectoryComponent(metadata) {
  return metadata.isDirectory() && !metadata.isSymbolicLink();
}

function captureSafeLocalUnifiedIndexDirectoryChain(indexFile) {
  const chain = [];
  let directory = dirname(resolve(indexFile));
  while (true) {
    let metadata;
    try {
      metadata = lstatSync(directory);
    } catch {
      throw fixedError("local_unified_index_file_invalid");
    }
    const parent = dirname(directory);
    if (!safeDirectoryComponent(metadata)) {
      throw fixedError("local_unified_index_file_invalid");
    }
    chain.push(Object.freeze({
      path: directory,
      dev: metadata.dev,
      ino: metadata.ino,
    }));
    if (parent === directory) break;
    directory = parent;
  }
  return Object.freeze(chain);
}

function sameLocalUnifiedIndexDirectoryChain(left, right) {
  return left.length === right.length && left.every((entry, index) => (
    entry.path === right[index].path
      && entry.dev === right[index].dev
      && entry.ino === right[index].ino
  ));
}

function recheckLocalUnifiedIndexDirectoryChain(indexFile, expected) {
  const current = captureSafeLocalUnifiedIndexDirectoryChain(indexFile);
  if (!sameLocalUnifiedIndexDirectoryChain(expected, current)) {
    throw fixedError("local_unified_index_file_invalid");
  }
  return current;
}

/**
 * The device salt. 32 random bytes, owner-only, created once and never
 * rotated: it is the key for `session_local`, which is the join key of the
 * whole index. Rotation is deliberately not offered — the value it protects
 * never leaves this machine, and rotating it would orphan every stored row.
 */
export async function readOrCreateDeviceSalt(
  secretFile = defaultLocalUnifiedIndexSecretPath(),
) {
  await mkdir(dirname(resolve(secretFile)), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(
      secretFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const secret = randomBytes(SECRET_BYTES);
    await handle.writeFile(secret);
    await handle.sync();
    return secret;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw fixedError("local_unified_index_secret_unavailable");
    }
  } finally {
    await handle?.close();
  }
  const secret = await readExistingDeviceSalt(secretFile);
  await chmod(secretFile, 0o600);
  return secret;
}

/**
 * Read an existing device salt without creating directories, changing mode,
 * or otherwise mutating the path. Recovery preparation uses this stricter
 * operation so a missing or damaged live identity cannot be silently repaired
 * while constructing a candidate.
 */
export async function readExistingDeviceSalt(
  secretFile = defaultLocalUnifiedIndexSecretPath(),
) {
  const directoryChain = captureSafeLocalUnifiedIndexDirectoryChain(secretFile);
  let readHandle;
  try {
    readHandle = await open(
      secretFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const metadata = await readHandle.stat();
    if (!ownerOnlyRegularFile(metadata)
        || metadata.size < SECRET_BYTES
        || metadata.size > MAX_SECRET_BYTES) {
      throw fixedError("local_unified_index_secret_invalid");
    }
    const buffer = await readHandle.readFile();
    const finalMetadata = await readHandle.stat();
    if (buffer.length !== metadata.size
        || finalMetadata.dev !== metadata.dev
        || finalMetadata.ino !== metadata.ino
        || finalMetadata.size !== metadata.size
        || finalMetadata.mtimeMs !== metadata.mtimeMs
        || finalMetadata.ctimeMs !== metadata.ctimeMs) {
      throw fixedError("local_unified_index_secret_invalid");
    }
    recheckLocalUnifiedIndexDirectoryChain(secretFile, directoryChain);
    return buffer;
  } catch (error) {
    if (error?.code?.startsWith("local_unified_index_")) throw error;
    throw fixedError("local_unified_index_secret_unavailable");
  } finally {
    await readHandle?.close();
  }
}

function reusableLocalDigestKey(deviceSalt) {
  const bytes = Buffer.isBuffer(deviceSalt)
    ? deviceSalt
    : new Uint8Array(
      deviceSalt.buffer,
      deviceSalt.byteOffset,
      deviceSalt.byteLength,
    );
  // `localDigest` remains a general byte-buffer API. Only retain key material
  // inside the same bound enforced for an on-disk device secret; unusually
  // large caller-owned buffers keep the one-shot behavior.
  if (bytes.byteLength > MAX_SECRET_BYTES) return deviceSalt;
  let cached = LOCAL_DIGEST_KEYS.get(deviceSalt);
  if (cached === undefined || !cached.bytes.equals(bytes)) {
    cached = {
      // Keep a comparison copy so a caller that mutates a supplied view gets a
      // freshly keyed digest, exactly as it did before this cache existed.
      bytes: Buffer.from(bytes),
      key: createSecretKey(bytes),
    };
    LOCAL_DIGEST_KEYS.set(deviceSalt, cached);
  }
  return cached.key;
}

/**
 * The single local one-way derivation used by this index.
 *
 * Domain-separated exactly as the rest of the product does it: a
 * NUL-terminated `app-usagemonitor/<domain>/v1\0` label is committed before the
 * subject, so a session id can never collide with an account scope id.
 * Returns 32 raw bytes; the old shape stored 64 hex characters for the same
 * information.
 */
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
  return createHmac("sha256", reusableLocalDigestKey(deviceSalt))
    .update(`app-usagemonitor/${domain}/v1\0`, "utf8")
    .update(subject, "utf8")
    .digest();
}

export function sessionLocal(deviceSalt, codexSessionId) {
  return localDigest(deviceSalt, "unified-index-session", codexSessionId);
}

export function scopeLocal(deviceSalt, accountScopeId) {
  return localDigest(deviceSalt, "unified-index-scope", accountScopeId);
}

export function sourceLocal(deviceSalt, rolloutKey) {
  return localDigest(deviceSalt, "unified-index-source", rolloutKey);
}

/**
 * A persisted fork-replay snapshot key. The raw key is a "|"-joined tuple of
 * cumulative token counters; membership is the only question the boundary
 * check ever asks, so what is stored is a salted digest of it.
 */
export function snapshotLocal(deviceSalt, snapshotKey) {
  return localDigest(deviceSalt, "unified-index-snapshot", snapshotKey);
}
