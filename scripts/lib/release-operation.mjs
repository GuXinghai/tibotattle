import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureGuardedSqliteConnection, loadWindowsReleaseOperationBinding } from "../../src/platform/index.js";

const OPERATION_KINDS = new Set(["native", "production", "publication", "qualification", "maintenance"]);
const MAXIMUM_BYTES = 1024 * 1024;
export function operationError(code) { return Object.assign(new Error(code), { code }); }
export function identityDigest(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
const missing = error => error?.code === "WINDOWS_FILESYSTEM_NOT_FOUND" || error?.code === "ENOENT";
const exists = error => error?.code === "WINDOWS_FILESYSTEM_ALREADY_EXISTS" || error?.code === "EEXIST";
function fileFailure(error) {
  if (error?.code === "WINDOWS_FILESYSTEM_FILE_TOO_LARGE") return operationError("RELEASE_OPERATION_TOO_LARGE");
  return operationError(missing(error) ? "RELEASE_OPERATION_FILE_UNAVAILABLE" : "RELEASE_OPERATION_FILE_UNSAFE");
}
// Pin the authenticated root and its ancestors until close. Each child operation
// resolves relative to that exact root identity. SQLite serializes cooperating
// writers across processes/sessions. A hostile same-owner process bypassing the
// transaction is outside the native conditional-replacement contract.
function privateStorage(directory, create = false) {
  let native;
  try { native = loadWindowsReleaseOperationBinding(); }
  catch { throw operationError("RELEASE_OPERATION_NATIVE_UNAVAILABLE"); }
  let lease;
  try {
    if (create) native.ensureDirectory(directory);
    lease = native.acquireProtectedDirectoryGuard(directory);
  } catch { throw operationError("RELEASE_OPERATION_DIRECTORY_UNSAFE"); }
  const rootIdentity = lease.identity;
  let closed = false;
  return {
    native, directory, rootIdentity,
    read(name, optional = false) {
      try { return native.readProtectedChild(directory, rootIdentity, name, MAXIMUM_BYTES); }
      catch (error) { if (optional && missing(error)) return null; throw fileFailure(error); }
    },
    write(name, bytes, expected) {
      if (bytes.length > MAXIMUM_BYTES) throw operationError("RELEASE_OPERATION_TOO_LARGE");
      try {
        return expected === null ? native.createProtectedChild(directory, rootIdentity, name, bytes)
          : native.replaceProtectedChild(directory, rootIdentity, name, expected, bytes);
      } catch (error) { throw fileFailure(error); }
    },
    close() {
      if (closed) return;
      closed = true;
      try { native.releaseProtectedDirectoryGuard(lease.guard); }
      catch { throw operationError("RELEASE_OPERATION_RELEASE_FAILED"); }
    },
  };
}
function jsonBytes(value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAXIMUM_BYTES) throw operationError("RELEASE_OPERATION_TOO_LARGE");
  return bytes;
}
export async function durablePrivateJson(path, value) {
  const storage = privateStorage(resolve(dirname(path)));
  let closeMutex;
  try {
    closeMutex = openMutex(storage);
    const name = basename(path);
    const prior = storage.read(name, true);
    storage.write(name, jsonBytes(value), prior?.identity ?? null);
  } finally { try { closeMutex?.(); } finally { storage.close(); } }
}
function readRecord(storage) {
  let value;
  const result = storage.read("operation.json");
  try { value = JSON.parse(result.data.toString("utf8")); }
  catch { throw operationError("RELEASE_OPERATION_INVALID"); }
  if (!value || Object.keys(value).sort().join() !== "binding,createdAt,id,kind,schema,state,updatedAt"
      || value.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.binding)
      || !/^[a-f0-9-]{36}$/.test(value.id) || !OPERATION_KINDS.has(value.kind)
      || !value.state || typeof value.state !== "object" || Array.isArray(value.state)
      || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw operationError("RELEASE_OPERATION_INVALID");
  }
  return { value, identity: result.identity };
}
export async function readOperation(directory) {
  const storage = privateStorage(resolve(directory));
  try { return readRecord(storage).value; } finally { storage.close(); }
}
// Precreate protected rollback files, keep their native identity guards until
// AFTER SQLite closes, and recover PERSIST hot journals in place. Process death
// releases OS guards/SQLite locks; durable operation state is not rolled back.
function openMutex(storage) {
  const { native, directory, rootIdentity } = storage;
  const guards = [];
  let database;
  try {
    for (const name of ["mutex.sqlite", "mutex.sqlite-journal"]) {
      try { native.createProtectedChild(directory, rootIdentity, name, Buffer.alloc(0)); }
      catch (error) { if (!exists(error)) throw error; }
      guards.push(native.acquireProtectedChildGuard(directory, rootIdentity, name).guard);
    }
    try {
      database = new DatabaseSync(join(directory, "mutex.sqlite"));
      configureGuardedSqliteConnection(database);
      database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
    } catch { throw operationError("RELEASE_OPERATION_BUSY"); }
  } catch (error) {
    database?.close();
    for (const guard of guards.reverse()) native.releaseCredentialAuditFileGuard(guard);
    if (error?.code?.startsWith("RELEASE_OPERATION_")) throw error;
    throw operationError("RELEASE_OPERATION_FILE_UNSAFE");
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    let failed = false;
    try { database.close(); } catch { failed = true; }
    for (const guard of guards.reverse()) {
      try { native.releaseCredentialAuditFileGuard(guard); } catch { failed = true; }
    }
    if (failed) throw operationError("RELEASE_OPERATION_RELEASE_FAILED");
  };
}
export async function openOperation({ directory, kind, binding, resume = false }) {
  if (!OPERATION_KINDS.has(kind)) throw operationError("RELEASE_OPERATION_KIND_INVALID");
  directory = resolve(directory);
  const storage = privateStorage(directory, !resume);
  let closeMutex;
  try {
    closeMutex = openMutex(storage);
    let record, recordIdentity;
    if (resume) {
      const current = readRecord(storage);
      record = current.value; recordIdentity = current.identity;
      if (record.kind !== kind || record.binding !== identityDigest(binding)) throw operationError("RELEASE_OPERATION_INPUT_MISMATCH");
    } else {
      if (storage.read("operation.json", true) !== null) throw operationError("RELEASE_OPERATION_EXISTS_USE_RESUME");
      const now = new Date().toISOString();
      record = { schema: 1, kind, binding: identityDigest(binding), id: randomUUID(), createdAt: now, updatedAt: now, state: {} };
      recordIdentity = storage.write("operation.json", jsonBytes(record), null);
    }
    let closed = false;
    return {
      directory,
      get record() { return structuredClone(record); },
      async save(state) {
        if (closed) throw operationError("RELEASE_OPERATION_CLOSED");
        const next = { ...record, state: structuredClone(state), updatedAt: new Date().toISOString() };
        recordIdentity = storage.write("operation.json", jsonBytes(next), recordIdentity);
        record = next;
      },
      close() {
        if (closed) return;
        closed = true;
        try { closeMutex(); } finally { storage.close(); }
      },
    };
  } catch (error) {
    try { closeMutex?.(); } finally { storage.close(); }
    throw error;
  }
}
