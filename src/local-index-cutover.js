import { DatabaseSync } from "node:sqlite";

import { resolveLocalUnifiedIndexFile } from "./local-index-legacy-pointer.js";

// One-time cutover input for the local index store.
//
// Hosted quota observation ids hash `source_ordinal`, and a rebuild re-ranks
// ordinals, so the previous index's `source_local -> source_ordinal` map is
// carried into the new store (owner decision 2026-10-12, option A). It is
// identity metadata, not index data: nothing else is read from the previous
// file, and this module is deleted with it at the end of the cutover.

/**
 * Read the previous index's ordinal map. Returns `{ ordinalSeed, summary }`,
 * where `ordinalSeed` is a Map of 64-character hex `source_local` to ordinal.
 *
 * A source with conflicting ordinals, or an ordinal claimed by two sources,
 * is left out of the seed (it receives a fresh ordinal) and counted, so a
 * damaged map can never create a duplicate identity.
 */
export function readLegacyOrdinalMap(legacyIndexFile) {
  const physical = resolveLocalUnifiedIndexFile(legacyIndexFile);
  let database;
  try {
    database = new DatabaseSync(physical, { readOnly: true, timeout: 5_000 });
    const tableNames = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((row) => row.name));
    const claims = new Map();
    const conflicted = new Set();
    const collect = (rows) => {
      for (const row of rows) {
        const ordinal = Number(row.source_ordinal);
        if (!Number.isSafeInteger(ordinal) || ordinal < 0) continue;
        const hex = Buffer.from(row.source_local).toString("hex");
        const existing = claims.get(hex);
        if (existing === undefined) claims.set(hex, ordinal);
        else if (existing !== ordinal) conflicted.add(hex);
      }
    };
    // Cursors are authoritative; facts cover sources whose cursor was removed.
    if (tableNames.has("source_cursor")) {
      collect(database.prepare(`
        SELECT source_local, source_ordinal FROM source_cursor
        WHERE source_ordinal IS NOT NULL`).all());
    }
    if (tableNames.has("quota_occurrence")) {
      collect(database.prepare(`
        SELECT DISTINCT source_local, source_ordinal FROM quota_occurrence`).all());
    }
    if (tableNames.has("usage_event")) {
      collect(database.prepare(`
        SELECT DISTINCT source_local, source_ordinal FROM usage_event
        WHERE source_local IS NOT NULL AND source_ordinal IS NOT NULL`).all());
    }
    const owners = new Map();
    const duplicated = new Set();
    for (const [hex, ordinal] of claims) {
      if (conflicted.has(hex)) continue;
      if (owners.has(ordinal)) {
        duplicated.add(ordinal);
      } else {
        owners.set(ordinal, hex);
      }
    }
    const ordinalSeed = new Map();
    for (const [hex, ordinal] of claims) {
      if (conflicted.has(hex) || duplicated.has(ordinal)) continue;
      ordinalSeed.set(hex, ordinal);
    }
    return {
      ordinalSeed,
      summary: Object.freeze({
        sources: ordinalSeed.size,
        conflictingSources: conflicted.size,
        duplicatedOrdinals: duplicated.size,
        maximumOrdinal: ordinalSeed.size === 0 ? -1 : Math.max(...ordinalSeed.values()),
      }),
    };
  } finally {
    if (database?.isOpen) database.close();
  }
}

const RETIREMENT_COUNT_LIMIT = Number.MAX_SAFE_INTEGER;

function sourceKey(value) {
  return Buffer.from(value).toString("hex");
}

function countsBySource(database, sql) {
  const counts = new Map();
  for (const row of database.prepare(sql).iterate()) {
    if (row.source_local === null || row.source_local === undefined) continue;
    const count = Number(row.events);
    if (Number.isSafeInteger(count) && count >= 0 && count <= RETIREMENT_COUNT_LIMIT) {
      counts.set(sourceKey(row.source_local), count);
    }
  }
  return counts;
}

/**
 * Read-only retirement assessment: does the previous index hold facts the new
 * store does not?
 *
 * The previous file may only be deleted when every source it knows is present
 * in the new store with at least as many committed usage events. A source
 * absent from the new store is one whose rollout is no longer on disk (the new
 * store is built from rollouts, and never deletes by absence), so its facts
 * exist only in the previous file and cannot be rebuilt.
 *
 * Returns counts only: no path, source identity or content. This function
 * decides nothing and deletes nothing; the receipt-backed deletion step owns
 * that and needs explicit authorization.
 */
export function assessLegacyIndexRetirement({ legacyIndexFile, indexFile } = {}) {
  if (typeof legacyIndexFile !== "string" || legacyIndexFile.length < 1
      || typeof indexFile !== "string" || indexFile.length < 1) {
    throw new TypeError("legacyIndexFile and indexFile must be non-empty strings");
  }
  let legacy;
  let current;
  try {
    legacy = new DatabaseSync(resolveLocalUnifiedIndexFile(legacyIndexFile), {
      readOnly: true, timeout: 5_000,
    });
    current = new DatabaseSync(indexFile, { readOnly: true, timeout: 5_000 });
    const legacyTables = new Set(legacy.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map((row) => row.name));
    const legacySources = new Map();
    const remember = (sql) => {
      for (const [key, events] of countsBySource(legacy, sql)) {
        legacySources.set(key, Math.max(legacySources.get(key) ?? 0, events));
      }
    };
    if (legacyTables.has("source_cursor")) {
      remember(`SELECT source_local, 0 AS events FROM source_cursor
        WHERE source_local IS NOT NULL`);
    }
    if (legacyTables.has("quota_occurrence")) {
      remember(`SELECT source_local, 0 AS events FROM quota_occurrence
        WHERE source_local IS NOT NULL GROUP BY source_local`);
    }
    if (legacyTables.has("usage_event")) {
      remember(`SELECT source_local, COUNT(*) AS events FROM usage_event
        WHERE source_local IS NOT NULL GROUP BY source_local`);
    }
    const currentCounts = countsBySource(current, `
      SELECT s.source_local AS source_local, COUNT(u.source_offset) AS events
      FROM source s LEFT JOIN usage_event u
        ON u.source_id = s.id AND u.source_offset <= s.scanned_bytes
      GROUP BY s.id`);
    let absentSources = 0;
    let absentEvents = 0;
    let shortfallSources = 0;
    let shortfallEvents = 0;
    for (const [key, events] of legacySources) {
      const present = currentCounts.get(key);
      if (present === undefined) {
        absentSources += 1;
        absentEvents += events;
      } else if (present < events) {
        shortfallSources += 1;
        shortfallEvents += events - present;
      }
    }
    return Object.freeze({
      status: "assessed",
      legacySources: legacySources.size,
      currentSources: currentCounts.size,
      absentSources,
      absentEvents,
      shortfallSources,
      shortfallEvents,
      retirable: absentSources === 0 && shortfallSources === 0,
    });
  } catch {
    // An unreadable file is never evidence that nothing would be lost.
    return Object.freeze({ status: "unreadable", retirable: false });
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (current?.isOpen) current.close();
  }
}
