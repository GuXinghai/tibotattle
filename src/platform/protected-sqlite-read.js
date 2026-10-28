import { DatabaseSync } from "node:sqlite";
import { createLocalCodexMetadataFilesystem } from "./local-codex-metadata-filesystem.js";

// Reuse the reviewed source-handle/sidecar policy. In particular a cold WAL
// database with no sidecars MUST use immutable URI mode: readOnly alone can
// otherwise create WAL/SHM coordination files before a caller rejects a row.
const pinnedAfterCloseFailure = new Set();
const failure = code => Object.assign(new Error("Protected SQLite read refused"), { code });

export async function withProtectedSqliteReadSnapshot({ path, read } = {}) {
  if (typeof path !== "string" || path.length < 1 || typeof read !== "function") {
    throw failure("protected_sqlite_read_invalid");
  }
  const filesystem = createLocalCodexMetadataFilesystem();
  let guard, database;
  try {
    guard = await filesystem.guardDatabase(path);
    if (!await guard.validate()) throw failure("protected_sqlite_read_changed");
    database = new DatabaseSync(guard.databasePath, { readOnly: true, timeout: 5_000 });
    if (!await guard.validate()) throw failure("protected_sqlite_read_changed");
    database.exec("PRAGMA trusted_schema=OFF; BEGIN");
    database.enableDefensive?.(true);
    const value = read(database);
    if (value && typeof value.then === "function") throw failure("protected_sqlite_read_invalid");
    if (!await guard.validate()) throw failure("protected_sqlite_read_changed");
    return value;
  } finally {
    try { database?.close(); }
    catch {
      pinnedAfterCloseFailure.add({ database, guard });
      throw failure("protected_sqlite_read_close_failed");
    }
    if (guard) {
      // Close is part of the read proof. Never publish a value whose sidecar
      // set or immutable main file changed while SQLite was closing.
      let valid;
      try { valid = await guard.validate(); }
      finally { await guard.release(); }
      if (!valid) throw failure("protected_sqlite_read_changed");
    }
  }
}
