import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { generateSyntheticCodexCorpus } from "../../src/synthetic-codex-rollout-corpus.js";

// Shared by the local index store tests: a synthetic workspace and a
// canonical, content-free projection of every fact table, so two stores can be
// compared exactly.

const hex = (value) => (value === null ? null : Buffer.from(value).toString("hex"));

export function createWorkspace(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "local-index-refresh-"));
  const codexHome = join(root, "codex-home");
  const state = join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  const receipt = generateSyntheticCodexCorpus(codexHome, {
    seed: 7, files: 60, events: 2_400, days: 12, fillerBytesPerEvent: 160,
    endAt: "2026-09-01T00:00:00.000Z", ...options,
  });
  return {
    root, codexHome, state, receipt,
    secretFile: join(state, "local-unified-index-device-salt-v1"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function v2Facts(file, { workDirectories = false } = {}) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const events = new Map();
    for (const row of db.prepare(`
      SELECT u.event_key, u.observed_at_ms, src.source_local, u.source_offset,
             src.source_ordinal, ses.session_local, u.reasoning_effort,
             u.tokens_in_uncached, u.tokens_in_cache_read, u.tokens_in_cache_write,
             u.tokens_out_text, u.tokens_out_reasoning, u.tokens_out_combined,
             u.total_input_context, u.tier_observed_at_ms, u.flags,
             m.model_id, m.recognition,
             t.api_service_tier, t.billing_surface, t.codex_speed_mode,
             t.tier_source, t.provider_tier_raw,
             s.agent_scope, s.surface, s.thread_source, s.lineage_disposition,
             q.observed_at_ms AS q_at, q.limit_id AS q_limit, q.slot AS q_slot,
             q.used_percent AS q_used, q.resets_at_ms AS q_resets,
             wd.path AS work_directory
      FROM usage_event u
      LEFT JOIN work_directory wd ON wd.id = u.work_directory_id
      JOIN source src ON src.id = u.source_id
      JOIN session ses ON ses.id = u.session_id
      JOIN model m ON m.id = u.model_id
      JOIN tier_semantics t ON t.id = u.tier_id
      JOIN surface_class s ON s.id = u.surface_id
      LEFT JOIN quota_observation q ON q.id = u.quota_observation_id
      WHERE u.source_offset <= src.scanned_bytes`).all()) {
      events.set(hex(row.event_key), JSON.stringify([
        row.observed_at_ms, hex(row.source_local), row.source_offset, row.source_ordinal,
        hex(row.session_local), row.reasoning_effort,
        row.tokens_in_uncached, row.tokens_in_cache_read, row.tokens_in_cache_write,
        row.tokens_out_text, row.tokens_out_reasoning, row.tokens_out_combined,
        row.total_input_context, row.tier_observed_at_ms,
        row.model_id, row.recognition,
        row.api_service_tier, row.billing_surface, row.codex_speed_mode,
        row.tier_source, row.provider_tier_raw,
        row.agent_scope, row.surface, row.thread_source, row.lineage_disposition,
        // Bit 8 (status-only) has no counterpart in the shipping encoding.
        row.flags & 7,
        row.q_at, row.q_limit, row.q_slot, row.q_used, row.q_resets,
        ...(workDirectories ? [row.work_directory] : []),
      ]));
    }
    const occurrences = db.prepare(`
      SELECT hex(src.source_local) AS s, o.source_offset, o.slot_order,
             src.source_ordinal, o.observed_at_ms, o.provider, o.plan_type,
             o.limit_id, o.slot, o.used_percent, o.resets_at_ms, o.duration_mins,
             o.admission
      FROM quota_occurrence o JOIN source src ON src.id = o.source_id
      ORDER BY s, o.source_offset, o.slot_order`).all()
      .map((row) => JSON.stringify(Object.values(row)));
    const tools = db.prepare(`
      SELECT hex(f.event_key) AS k, hex(src.source_local) AS s, f.source_offset,
             f.tool_ordinal, hex(ses.session_local) AS session, f.observed_at_ms,
             f.tool_class, f.source_kind
      FROM tool_class_fact f
      JOIN source src ON src.id = f.source_id
      JOIN session ses ON ses.id = f.session_id ORDER BY k`).all()
      .map((row) => JSON.stringify(Object.values(row)));
    const boundaries = db.prepare(`
      SELECT hex(u.event_key) AS k, b.compaction_before, b.turn_context_before,
             b.compacted_at_ms
      FROM usage_event_boundary b
      JOIN usage_event u ON u.source_id = b.source_id AND u.source_offset = b.source_offset
      ORDER BY k`).all()
      .map((row) => JSON.stringify(Object.values(row)));
    const snapshots = db.prepare(`
      SELECT hex(ses.session_local) AS s, hex(l.snapshot_local) AS k
      FROM lineage_snapshot l JOIN session ses ON ses.id = l.session_id
      ORDER BY s, k`).all()
      .map((row) => JSON.stringify(Object.values(row)));
    const cursors = db.prepare(`
      SELECT hex(source_local) AS s, source_ordinal, scanned_bytes, quarantine_code,
             snapshots_persisted, turn_context_seen, carry_model, carry_effort,
             carry_tier_raw, carry_tier_observed_at_ms, carry_total_input,
             carry_total_cached, carry_total_cache_write, carry_total_output,
             carry_total_reasoning, carry_total_total
      FROM source
      WHERE quarantine_code IS NULL OR quarantine_code IN (
        'codex_rollout_content_invalid', 'codex_rollout_tail_incomplete',
        'codex_rollout_lineage_invalid')
      ORDER BY s`).all()
      .map((row) => JSON.stringify(Object.values(row)));
    const provisional = Number(db.prepare(`
      SELECT COUNT(*) AS n FROM usage_event u JOIN source s ON s.id = u.source_id
      WHERE u.source_offset > s.scanned_bytes`).get().n);
    return { events, occurrences, tools, boundaries, snapshots, cursors, provisional };
  } finally {
    db.close();
  }
}

/**
 * Blank `source_ordinal` in every projection. A live store keeps the ordinal a
 * source was first given, while a cold build re-ranks the current set, so the
 * two legitimately differ; ordinals are carried identity metadata, not facts.
 */
export function withoutOrdinals(facts) {
  const blank = (text, index) => {
    const values = JSON.parse(text);
    values[index] = null;
    return JSON.stringify(values);
  };
  return {
    ...facts,
    events: new Map([...facts.events].map(([key, value]) => [key, blank(value, 3)])),
    occurrences: facts.occurrences.map((text) => blank(text, 3)),
    cursors: facts.cursors.map((text) => blank(text, 1)),
  };
}

export function assertSameFacts(actual, expected, label) {
  assert.equal(actual.events.size, expected.events.size, `${label}: event count`);
  for (const [key, value] of expected.events) {
    assert.equal(actual.events.get(key), value, `${label}: event ${key}`);
  }
  for (const name of ["occurrences", "tools", "boundaries", "snapshots", "cursors"]) {
    assert.deepEqual(actual[name], expected[name], `${label}: ${name}`);
  }
}
