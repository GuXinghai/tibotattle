// Materialized request pairing for the cache-impact lenses.
//
// A cache-impact candidate is a positive-input request whose predecessor in
// the same session differs in model or reasoning effort, or is separated from
// it by a turn-context or compaction boundary. Finding them by scanning every
// request is O(events) on every report. Pairs are facts of one source, fixed
// the moment the source's cursor passes them, so they are stored:
//
//   cache_candidate    one row per qualifying pair: the current request and
//                      the offset of its predecessor in the same source
//   session_positive   positive requests per (session, source), so a session
//                      that spans several sources can be withheld without a
//                      scan
//
// Both follow the same invariant as the usage rollups: they describe the facts
// at or below each source's cursor, maintained by triggers on the cursor move
// and on committed deletes. A v2 source belongs to exactly one session, which
// is what makes "the previous request in the source" the previous request in
// the session.
//
// The one place stored pairs can differ from a pairing done at read time is a
// request dated after the future-evidence limit: the shipping reader drops it
// before pairing, which can re-form its neighbours' pairs. The reader finds
// those sessions with an index seek and evaluates only them exactly.

export const PAIRING_SCHEMA_VERSION = 1;

/** Positive-input predicate, spelled as the partial index spells it. */
export function positiveInput(alias) {
  return `COALESCE(${alias}.tokens_in_uncached, 0)
        + COALESCE(${alias}.tokens_in_cache_read, 0)
        + COALESCE(${alias}.tokens_in_cache_write, 0) > 0`;
}

export const PAIRING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS cache_candidate(
    source_id INTEGER NOT NULL,
    source_offset INTEGER NOT NULL,
    previous_offset INTEGER NOT NULL,
    session_id INTEGER NOT NULL,
    PRIMARY KEY(source_id, source_offset)) STRICT, WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS session_positive(
    session_id INTEGER NOT NULL,
    source_id INTEGER NOT NULL,
    events INTEGER NOT NULL,
    PRIMARY KEY(session_id, source_id)) STRICT, WITHOUT ROWID;
`;

/**
 * The qualifying pairs among a source's positive requests in `(from, to]`.
 * `from` and `to` are SQL expressions; the predecessor of the first request in
 * the range is the last positive request at or below `from`.
 */
function candidateSelect(sourceId, from, to) {
  return `
    SELECT w.source_id, w.source_offset, w.previous_offset, w.session_id
    FROM (
      SELECT u.source_id AS source_id, u.source_offset AS source_offset,
             u.session_id AS session_id, u.model_id AS model_id,
             u.reasoning_effort AS reasoning_effort,
             LAG(u.source_offset) OVER request_order AS previous_offset,
             LAG(u.model_id) OVER request_order AS previous_model_id,
             LAG(u.reasoning_effort) OVER request_order AS previous_reasoning_effort
      FROM usage_event u
      WHERE u.source_id = ${sourceId}
        AND ${positiveInput("u")}
        AND u.source_offset <= ${to}
        AND u.source_offset >= COALESCE((
          SELECT MAX(p.source_offset) FROM usage_event p
          WHERE p.source_id = ${sourceId} AND p.source_offset <= ${from}
            AND ${positiveInput("p")}), 0)
      WINDOW request_order AS (PARTITION BY u.source_id ORDER BY u.source_offset)
    ) w
    LEFT JOIN usage_event_boundary b
      ON b.source_id = w.source_id AND b.source_offset = w.source_offset
    WHERE w.source_offset > ${from}
      AND w.previous_offset IS NOT NULL
      AND (w.model_id != w.previous_model_id
        OR w.reasoning_effort != w.previous_reasoning_effort
        OR b.turn_context_before = 1
        OR b.compaction_before = 1)`;
}

function positiveCountSelect(sourceId, from, to, sign) {
  const negate = sign < 0 ? "-" : "";
  return `
    SELECT u.session_id, u.source_id, ${negate}COUNT(*) AS events
    FROM usage_event u
    WHERE u.source_id = ${sourceId} AND u.source_offset > ${from}
      AND u.source_offset <= ${to} AND ${positiveInput("u")}
    GROUP BY u.session_id, u.source_id`;
}

const ACCUMULATE_POSITIVE = `ON CONFLICT(session_id, source_id) DO UPDATE SET
        events = events + excluded.events`;

export const PAIRING_TRIGGER_SCHEMA = `
  CREATE TRIGGER IF NOT EXISTS cache_pairing_advance
  AFTER UPDATE OF scanned_bytes ON source
  WHEN NEW.scanned_bytes > OLD.scanned_bytes
  BEGIN
    INSERT OR REPLACE INTO cache_candidate(source_id, source_offset, previous_offset, session_id)
    ${candidateSelect("NEW.id", "OLD.scanned_bytes", "NEW.scanned_bytes")};
    INSERT INTO session_positive(session_id, source_id, events)
    ${positiveCountSelect("NEW.id", "OLD.scanned_bytes", "NEW.scanned_bytes", 1)}
    ${ACCUMULATE_POSITIVE};
  END;

  CREATE TRIGGER IF NOT EXISTS cache_pairing_retreat
  AFTER UPDATE OF scanned_bytes ON source
  WHEN NEW.scanned_bytes < OLD.scanned_bytes
  BEGIN
    DELETE FROM cache_candidate
    WHERE source_id = NEW.id AND source_offset > NEW.scanned_bytes;
    INSERT INTO session_positive(session_id, source_id, events)
    ${positiveCountSelect("NEW.id", "NEW.scanned_bytes", "OLD.scanned_bytes", -1)}
    ${ACCUMULATE_POSITIVE};
    DELETE FROM session_positive WHERE source_id = NEW.id AND events <= 0;
  END;

  CREATE TRIGGER IF NOT EXISTS cache_pairing_delete
  AFTER DELETE ON usage_event
  WHEN OLD.source_offset <= (SELECT scanned_bytes FROM source WHERE id = OLD.source_id)
  BEGIN
    DELETE FROM cache_candidate
    WHERE source_id = OLD.source_id AND source_offset = OLD.source_offset;
    UPDATE session_positive SET events = events - 1
    WHERE session_id = OLD.session_id AND source_id = OLD.source_id
      AND ${positiveInput("OLD")};
    DELETE FROM session_positive
    WHERE session_id = OLD.session_id AND source_id = OLD.source_id AND events <= 0;
  END;
`;

/** Rebuild both tables from the committed facts of every source. */
export function rebuildPairing(database) {
  database.exec("DELETE FROM cache_candidate");
  database.exec("DELETE FROM session_positive");
  for (const source of database.prepare("SELECT id, scanned_bytes FROM source").all()) {
    const id = Number(source.id);
    const cursor = Number(source.scanned_bytes);
    database.exec(`
      INSERT OR REPLACE INTO cache_candidate(source_id, source_offset, previous_offset, session_id)
      ${candidateSelect(id, "-1", cursor)}`);
    database.exec(`
      INSERT INTO session_positive(session_id, source_id, events)
      ${positiveCountSelect(id, "-1", cursor, 1)}
      ${ACCUMULATE_POSITIVE}`);
  }
}

/**
 * Compare the stored tables with a fresh derivation from the committed facts.
 * Returns the number of differing rows (0 means identical).
 */
export function auditPairing(database) {
  database.exec("DROP TABLE IF EXISTS temp.pairing_candidate_audit");
  database.exec("DROP TABLE IF EXISTS temp.pairing_positive_audit");
  database.exec(`
    CREATE TEMP TABLE pairing_candidate_audit(
      source_id INTEGER, source_offset INTEGER, previous_offset INTEGER, session_id INTEGER)`);
  database.exec(`
    CREATE TEMP TABLE pairing_positive_audit(
      session_id INTEGER, source_id INTEGER, events INTEGER)`);
  try {
    for (const source of database.prepare("SELECT id, scanned_bytes FROM source").all()) {
      const id = Number(source.id);
      const cursor = Number(source.scanned_bytes);
      database.exec(`
        INSERT INTO temp.pairing_candidate_audit
        ${candidateSelect(id, "-1", cursor)}`);
      database.exec(`
        INSERT INTO temp.pairing_positive_audit(session_id, source_id, events)
        ${positiveCountSelect(id, "-1", cursor, 1)}`);
    }
    const difference = (left, right, columns) => Number(database.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT ${columns} FROM ${left} EXCEPT SELECT ${columns} FROM ${right})`).get().n);
    const candidate = "source_id, source_offset, previous_offset, session_id";
    const positive = "session_id, source_id, events";
    const stored = "(SELECT * FROM session_positive WHERE events > 0)";
    return difference("temp.pairing_candidate_audit", "cache_candidate", candidate)
      + difference("cache_candidate", "temp.pairing_candidate_audit", candidate)
      + difference("temp.pairing_positive_audit", stored, positive)
      + difference(stored, "temp.pairing_positive_audit", positive)
      + Number(database.prepare("SELECT COUNT(*) AS n FROM session_positive WHERE events <= 0").get().n);
  } finally {
    database.exec("DROP TABLE IF EXISTS temp.pairing_candidate_audit");
    database.exec("DROP TABLE IF EXISTS temp.pairing_positive_audit");
  }
}
