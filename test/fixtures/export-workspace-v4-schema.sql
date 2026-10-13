-- Synthetic schema-only compatibility fixture retained from b8da3479.

    PRAGMA application_id=1431522612;
    PRAGMA user_version=4;
    CREATE TABLE workspace_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE source_plan (
      ordinal INTEGER PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      source_path TEXT NOT NULL,
      parent_source_key TEXT REFERENCES source_plan(source_key),
      is_fork INTEGER NOT NULL DEFAULT 0 CHECK(is_fork IN (0, 1)),
      parent_missing INTEGER NOT NULL DEFAULT 0 CHECK(parent_missing IN (0, 1)),
      device INTEGER,
      inode INTEGER,
      birthtime_ms INTEGER,
      prefix_bytes INTEGER NOT NULL CHECK(prefix_bytes >= 0),
      prefix_sha256 TEXT NOT NULL CHECK(length(prefix_sha256) = 64),
      scan_status TEXT NOT NULL DEFAULT 'pending' CHECK(scan_status IN ('pending', 'complete'))
    ) STRICT;
    CREATE INDEX source_plan_pending_order ON source_plan(scan_status, ordinal);
    CREATE TABLE source_checkpoints (
      source_key TEXT PRIMARY KEY REFERENCES source_plan(source_key),
      phase TEXT NOT NULL CHECK(phase IN ('tier_scan', 'record_scan', 'complete')),
      byte_offset INTEGER NOT NULL CHECK(byte_offset >= 0),
      line_ordinal INTEGER NOT NULL CHECK(line_ordinal >= 0),
      checkpoint_seq INTEGER NOT NULL CHECK(checkpoint_seq >= 0),
      parser_version TEXT NOT NULL,
      state_json TEXT NOT NULL,
      last_batch_sha256 TEXT CHECK(last_batch_sha256 IS NULL OR length(last_batch_sha256) = 64)
    ) STRICT;
    CREATE TABLE source_tier_events (
      source_key TEXT NOT NULL REFERENCES source_plan(source_key),
      tier_index INTEGER NOT NULL CHECK(tier_index >= 0),
      event_time_ms INTEGER NOT NULL,
      line_ordinal INTEGER NOT NULL CHECK(line_ordinal >= 1),
      tier_state_json TEXT NOT NULL,
      PRIMARY KEY(source_key, tier_index)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX source_tier_lookup
      ON source_tier_events(source_key, event_time_ms DESC, line_ordinal DESC);
    CREATE TABLE seen_occurrences (
      kind TEXT NOT NULL CHECK(kind IN ('usage_event', 'tool_call')),
      occurrence_key TEXT NOT NULL CHECK(length(occurrence_key) = 64),
      source_key TEXT NOT NULL REFERENCES source_plan(source_key),
      line_ordinal INTEGER NOT NULL CHECK(line_ordinal >= 1),
      PRIMARY KEY(kind, occurrence_key)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE source_snapshots (
      source_key TEXT NOT NULL REFERENCES source_plan(source_key),
      kind TEXT NOT NULL CHECK(kind IN ('cumulative_usage', 'tool_call')),
      snapshot_key TEXT NOT NULL CHECK(length(snapshot_key) = 64),
      PRIMARY KEY(source_key, kind, snapshot_key)
    ) STRICT, WITHOUT ROWID;
    CREATE INDEX source_snapshots_lookup
      ON source_snapshots(kind, snapshot_key, source_key);
    CREATE TABLE source_open_tasks (
      source_key TEXT NOT NULL REFERENCES source_plan(source_key),
      task_key TEXT NOT NULL CHECK(length(task_key) = 64),
      PRIMARY KEY(source_key, task_key)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE source_diagnostics (
      source_key TEXT NOT NULL REFERENCES source_plan(source_key),
      code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 64),
      count INTEGER NOT NULL CHECK(count >= 0),
      PRIMARY KEY(source_key, code)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE supplemental_source_plan (
      ordinal INTEGER PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE CHECK(length(source_key) = 64),
      kind TEXT NOT NULL CHECK(kind IN ('codex_collector_ledger', 'claude_status_snapshot', 'claude_transcript_jsonl')),
      binding_kind TEXT NOT NULL CHECK(binding_kind IN ('file_prefix', 'frozen_inventory')),
      device INTEGER,
      inode INTEGER,
      birthtime_ms INTEGER,
      prefix_bytes INTEGER,
      prefix_sha256 TEXT,
      inventory_entries INTEGER,
      inventory_bytes INTEGER,
      inventory_sha256 TEXT,
      parser_version TEXT NOT NULL,
      initial_cursor_json TEXT NOT NULL,
      scan_status TEXT NOT NULL DEFAULT 'pending' CHECK(scan_status IN ('pending', 'complete')),
      CHECK(
        (binding_kind = 'file_prefix'
          AND device IS NOT NULL AND inode IS NOT NULL AND birthtime_ms IS NOT NULL
          AND prefix_bytes IS NOT NULL AND prefix_bytes >= 0
          AND prefix_sha256 IS NOT NULL AND length(prefix_sha256) = 64
          AND inventory_entries IS NULL AND inventory_bytes IS NULL AND inventory_sha256 IS NULL)
        OR
        (binding_kind = 'frozen_inventory'
          AND device IS NULL AND inode IS NULL AND birthtime_ms IS NULL
          AND prefix_bytes IS NULL AND prefix_sha256 IS NULL
          AND inventory_entries IS NOT NULL AND inventory_entries >= 0
          AND inventory_bytes IS NOT NULL AND inventory_bytes >= 0
          AND inventory_sha256 IS NOT NULL AND length(inventory_sha256) = 64)
      )
    ) STRICT;
    CREATE INDEX supplemental_source_plan_pending_order
      ON supplemental_source_plan(scan_status, ordinal);
    CREATE TABLE supplemental_source_checkpoints (
      source_key TEXT PRIMARY KEY REFERENCES supplemental_source_plan(source_key),
      status TEXT NOT NULL CHECK(status IN ('pending', 'complete')),
      cursor_json TEXT NOT NULL,
      checkpoint_seq INTEGER NOT NULL CHECK(checkpoint_seq >= 0),
      parser_version TEXT NOT NULL,
      last_batch_sha256 TEXT CHECK(last_batch_sha256 IS NULL OR length(last_batch_sha256) = 64)
    ) STRICT;
    CREATE TABLE supplemental_source_diagnostics (
      source_key TEXT NOT NULL REFERENCES supplemental_source_plan(source_key),
      code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 64),
      count INTEGER NOT NULL CHECK(count >= 0),
      PRIMARY KEY(source_key, code)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE resource_usage (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      policy_version TEXT NOT NULL,
      source_files INTEGER NOT NULL CHECK(source_files >= 0),
      source_bytes INTEGER NOT NULL CHECK(source_bytes >= 0),
      directory_entries INTEGER NOT NULL CHECK(directory_entries >= 0),
      lines INTEGER NOT NULL CHECK(lines >= 0),
      oversized_irrelevant_lines INTEGER NOT NULL CHECK(oversized_irrelevant_lines >= 0),
      output_records INTEGER NOT NULL CHECK(output_records >= 0),
      expanded_record_bytes INTEGER NOT NULL CHECK(expanded_record_bytes >= 0),
      cumulative_elapsed_ms INTEGER NOT NULL CHECK(cumulative_elapsed_ms >= 0),
      peak_rss_bytes INTEGER NOT NULL CHECK(peak_rss_bytes >= 0),
      workspace_high_water_bytes INTEGER NOT NULL CHECK(workspace_high_water_bytes >= 0),
      recovery_reservations INTEGER NOT NULL CHECK(recovery_reservations >= 0)
    ) STRICT;
    CREATE TABLE resource_invocations (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      started_at_ms INTEGER NOT NULL CHECK(started_at_ms >= 0)
    ) STRICT;
    CREATE TABLE safe_records (
      family TEXT NOT NULL CHECK(family IN ('usageEvents', 'quotaSnapshots', 'activityMarkers')),
      family_order INTEGER NOT NULL CHECK(family_order BETWEEN 0 AND 2),
      record_id TEXT NOT NULL,
      record_time TEXT NOT NULL,
      record_json TEXT NOT NULL,
      record_bytes INTEGER NOT NULL CHECK(record_bytes > 0),
      embedded_record_bytes INTEGER NOT NULL CHECK(embedded_record_bytes > 0),
      PRIMARY KEY (family, record_id)
    ) STRICT;
    CREATE INDEX safe_records_total_order
      ON safe_records(family_order, record_time, record_id);
    CREATE TABLE diagnostics (
      code TEXT PRIMARY KEY,
      count INTEGER NOT NULL CHECK(count >= 0)
    ) STRICT;
    CREATE TABLE chunks (
      chunk_index INTEGER PRIMARY KEY CHECK(chunk_index >= 0),
      status TEXT NOT NULL CHECK(status IN ('planned', 'published', 'verified')),
      metadata_json TEXT NOT NULL
    ) STRICT;
