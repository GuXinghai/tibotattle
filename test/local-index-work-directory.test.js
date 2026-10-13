import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { extractRolloutWorkContexts } from "../src/local-index-extract.js";
import { appendSyntheticCodexEvents } from "../src/synthetic-codex-rollout-corpus.js";
import {
  assertSameFacts, createWorkspace, v2Facts, withoutOrdinals,
} from "./helpers/local-index-facts.js";

function sources(workspace) {
  return workspace.receipt.sources.slice().sort();
}

/** Insert context-bearing records, valid and awkward, before token counts. */
function injectContexts(path, seed) {
  const lines = readFileSync(path, "utf8").split("\n");
  const out = [];
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const stamp = "2026-08-31T00:00:00.000Z";
  const variants = [
    () => JSON.stringify({ timestamp: stamp, type: "turn_context", payload: { cwd: `/synthetic/project-${Math.floor(next() * 5)}`, model: "gpt-5.5" } }),
    () => JSON.stringify({ timestamp: stamp, type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { cwd: `/synthetic/moved-${Math.floor(next() * 4)}` } } }),
    () => JSON.stringify({ timestamp: stamp, type: "turn_context", payload: { model: "gpt-5.5" } }),
    () => JSON.stringify({ timestamp: stamp, type: "turn_context", payload: { cwd: 12345 } }),
    () => JSON.stringify({ timestamp: stamp, type: "turn_context", payload: { cwd: "/synthetic/bad\u0007path" } }),
    () => JSON.stringify({ timestamp: stamp, type: "turn_context", payload: { cwd: `/synthetic/${"x".repeat(4100)}` } }),
    () => JSON.stringify({ timestamp: stamp, type: "turn_context", payload: { cwd: null } }),
  ];
  let injected = 0;
  for (const line of lines) {
    if (line.includes('"token_count"') && next() < 0.35) {
      out.push(variants[Math.floor(next() * variants.length)]());
      injected += 1;
    }
    out.push(line);
  }
  writeFileSync(path, out.join("\n"));
  return injected;
}

async function oracle(path) {
  const contexts = [];
  await extractRolloutWorkContexts(path, {
    end: statSync(path).size,
    onContext: (context) => { contexts.push(context); },
  });
  return (offset) => {
    let found = null;
    for (const context of contexts) {
      if (context.offset <= offset) found = context.cwd; else break;
    }
    return found;
  };
}

test("stored working directories equal the metadata traversal for every event", async () => {
  const workspace = createWorkspace({ files: 12, events: 500, fillerBytesPerEvent: 200 });
  try {
    let injected = 0;
    for (const [index, path] of sources(workspace).entries()) {
      injected += injectContexts(path, 100 + index);
    }
    assert.ok(injected > 40);
    const file = join(workspace.state, "v2.sqlite");
    const options = {
      codexHome: workspace.codexHome, indexFile: file,
      secretFile: workspace.secretFile, workerCount: 1,
    };
    await refreshLocalIndex(options);

    const database = new DatabaseSync(file, { readOnly: true });
    const rows = database.prepare(`
      SELECT s.path AS source_path, u.source_offset, w.path AS cwd
      FROM usage_event u
      JOIN source s ON s.id = u.source_id
      LEFT JOIN work_directory w ON w.id = u.work_directory_id
      WHERE s.quarantine_code IS NULL
      ORDER BY s.path, u.source_offset`).all();
    database.close();
    assert.ok(rows.length > 200);
    const lookups = new Map();
    let withDirectory = 0;
    let unknown = 0;
    for (const row of rows) {
      if (!lookups.has(row.source_path)) lookups.set(row.source_path, await oracle(row.source_path));
      const expected = lookups.get(row.source_path)(Number(row.source_offset));
      assert.equal(row.cwd, expected, `${row.source_path}@${row.source_offset}`);
      if (row.cwd === null) unknown += 1; else withDirectory += 1;
    }
    assert.ok(withDirectory > 50 && unknown > 0, "the corpus must exercise known and unknown directories");

    // A resumed scan labels new events exactly as a whole-file scan would.
    appendSyntheticCodexEvents(sources(workspace).slice(0, 5), {
      seed: 321, events: 4, fillerBytesPerEvent: 100,
      atMs: Date.parse("2026-09-03T00:00:00Z"),
    });
    await refreshLocalIndex(options);
    const cold = join(workspace.state, "cold.sqlite");
    await refreshLocalIndex({ ...options, indexFile: cold });
    assertSameFacts(
      withoutOrdinals(v2Facts(file, { workDirectories: true })),
      withoutOrdinals(v2Facts(cold, { workDirectories: true })),
      "resume vs cold with working directories",
    );
    assert.ok(readdirSync(workspace.state).length > 0);
  } finally {
    workspace.cleanup();
  }
});
