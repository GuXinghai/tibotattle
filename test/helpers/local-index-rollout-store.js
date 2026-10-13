import { join } from "node:path";

import { refreshLocalIndex } from "../../src/local-index-refresh.js";
import { openLocalIndexStore } from "../../src/local-index-store.js";

// Shared by the Codex rollout ingestion tests: one refresh of a synthetic
// CODEX_HOME into a v2 store beside it, and a read-only view of that store.

export function refreshCodexHome(codexHome, options = {}) {
  return refreshLocalIndex({
    codexHome,
    indexFile: join(codexHome, "index.sqlite"),
    secretFile: join(codexHome, "salt"),
    workerCount: 1,
    ...options,
  });
}

export function withReadOnlyStore(indexFile, work) {
  const database = openLocalIndexStore(indexFile, { readOnly: true });
  try {
    return work(database);
  } finally {
    database.close();
  }
}

export function countRows(database, table) {
  return Number(database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}
