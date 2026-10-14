import { lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { createWindowsFilesystemAdapter } from "./windows-filesystem.js";
import { createWindowsProtectedStateStore } from "./windows-protected-state-store.js";

function requireFunction(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function failureContext(createError) {
  const factory = requireFunction(createError, "createError");
  const issued = new WeakSet();
  return Object.freeze({
    fail(code) {
      let error;
      try {
        error = Reflect.apply(factory, undefined, [code]);
      } catch {
        throw new TypeError("createError must return an Error");
      }
      if (!(error instanceof Error)) {
        throw new TypeError("createError must return an Error");
      }
      issued.add(error);
      throw error;
    },
    issued(error) {
      try {
        return error instanceof Error && issued.has(error);
      } catch {
        return false;
      }
    },
  });
}

export function createOwnerOnlySettingsStorageContext({ createError } = {}) {
  const failures = failureContext(createError);
  async function readSettingsText({ settingsFile, maximumBytes } = {}) {
    if (typeof settingsFile !== "string" || settingsFile.length < 1
        || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      failures.fail("configuration_invalid");
    }
    // Reading absent state must never provision a directory or change its ACL.
    try { await lstat(dirname(resolve(settingsFile))); }
    catch (error) {
      if (error?.code === "ENOENT") return null;
      failures.fail("settings_unavailable");
    }
    const selected = protectedTarget(settingsFile, maximumBytes, "settings_unavailable");
    const result = protectedRead(selected, "settings_unavailable");
    if (result === null) return null;
    try {
      if (result.data.length < 1) failures.fail("settings_unavailable");
      return result.data.toString("utf8");
    } finally { result.data.fill(0); }
  }

  function protectedTarget(path, maximumBytes, code) {
    if (typeof path !== "string" || path.length < 1
        || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      failures.fail("configuration_invalid");
    }
    try {
      return { name: basename(path), store: createWindowsProtectedStateStore({
        adapter: createWindowsFilesystemAdapter(), rootPath: dirname(resolve(path)), maxBytes: maximumBytes,
      }) };
    } catch { failures.fail(code); }
  }

  function protectedRead(selected, code) {
    try { return selected.store.read(selected.name); }
    catch (error) {
      if (error?.code === "windows_protected_state_store_missing") return null;
      failures.fail(code);
    }
  }

  async function writeSettingsText({
    settingsFile,
    text,
    maximumBytes,
  } = {}) {
    if (typeof text !== "string") failures.fail("configuration_invalid");
    const selected = protectedTarget(settingsFile, maximumBytes, "settings_unavailable");
    const bytes = Buffer.from(text, "utf8");
    let existing;
    try {
      if (bytes.length < 1 || bytes.length > maximumBytes) failures.fail("settings_unavailable");
      existing = protectedRead(selected, "settings_unavailable");
      if (existing === null) selected.store.create(selected.name, bytes);
      else selected.store.replace(selected.name, existing.identity, bytes);
    } catch (error) {
      if (failures.issued(error)) throw error;
      failures.fail("settings_unavailable");
    } finally { bytes.fill(0); existing?.data.fill(0); }
  }

  return Object.freeze({
    readSettingsText,
    writeSettingsText,
  });
}
