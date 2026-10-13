import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { countRows, withReadOnlyStore } from "./helpers/local-index-rollout-store.js";
import {
  appendSyntheticCodexEvents,
  generateSyntheticCodexCorpus,
} from "../src/synthetic-codex-rollout-corpus.js";

const SMALL = Object.freeze({
  seed: 7, files: 24, events: 240, days: 30, fillerBytesPerEvent: 64,
});
const ALLOWED_TYPES = new Set(["session_meta", "turn_context", "event_msg", "response_item"]);
const ALLOWED_PAYLOAD_TYPES = new Set([
  "thread_settings_applied", "token_count", "function_call", "synthetic_filler", undefined,
]);

function scratch() {
  return mkdtempSync(join(tmpdir(), "synthetic-corpus-"));
}

test("the corpus is a pure function of its options", () => {
  const first = scratch();
  const second = scratch();
  const third = scratch();
  try {
    const a = generateSyntheticCodexCorpus(join(first, "home"), SMALL);
    const b = generateSyntheticCodexCorpus(join(second, "home"), SMALL);
    const c = generateSyntheticCodexCorpus(join(third, "home"), { ...SMALL, seed: 8 });
    assert.equal(a.digest, b.digest);
    assert.notEqual(a.digest, c.digest);
    assert.equal(a.files, SMALL.files);
    assert.equal(a.events, SMALL.events);
    assert.equal(a.sources.length, SMALL.files);
  } finally {
    for (const dir of [first, second, third]) rmSync(dir, { recursive: true, force: true });
  }
});

test("the corpus is content-free and has a long-tailed size distribution", () => {
  const root = scratch();
  try {
    const home = join(root, "home");
    const receipt = generateSyntheticCodexCorpus(home, { ...SMALL, files: 40, events: 2_000 });
    const sizes = [];
    for (const path of receipt.sources) {
      sizes.push(statSync(path).size);
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line === "") continue;
        const record = JSON.parse(line);
        assert.ok(ALLOWED_TYPES.has(record.type), `unexpected record type ${record.type}`);
        assert.ok(ALLOWED_PAYLOAD_TYPES.has(record.payload?.type));
        assert.doesNotMatch(line, /user_message|agent_message|"text"|"content"|"prompt"/);
      }
    }
    sizes.sort((x, y) => y - x);
    const median = sizes[Math.floor(sizes.length / 2)];
    assert.ok(sizes[0] >= 5 * median, `largest ${sizes[0]} is not a long tail over median ${median}`);
    assert.ok(receipt.forks > 0, "expected at least one inline fork");
    assert.ok(receipt.quotaEvents > 0 && receipt.toolEvents > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-empty target and an invalid shape are refused", () => {
  const root = scratch();
  try {
    generateSyntheticCodexCorpus(join(root, "home"), SMALL);
    assert.throws(() => generateSyntheticCodexCorpus(join(root, "home"), SMALL), /must be empty/);
    assert.throws(() => generateSyntheticCodexCorpus("relative/path", SMALL), /absolute/);
    assert.throws(
      () => generateSyntheticCodexCorpus(join(root, "other"), { ...SMALL, files: 10, events: 5 }),
      /at least files/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the extractor accepts the corpus and suppresses fork replay", async () => {
  const root = scratch();
  try {
    const home = join(root, "home");
    const receipt = generateSyntheticCodexCorpus(home, { ...SMALL, forkFraction: 0.25 });
    mkdirSync(join(root, "state"), { mode: 0o700 });
    const indexFile = join(root, "state", "local-index-store-v1.sqlite");
    const secretFile = join(root, "state", "local-index-device-salt-v1");
    const result = await refreshLocalIndex({
      codexHome: home,
      indexFile,
      secretFile,
      workerCount: 1,
    });
    assert.equal(result.sources, receipt.files);
    withReadOnlyStore(indexFile, (database) => {
      // Replayed parent snapshots in a fork are suppressed, so exactly the
      // generated own events are indexed.
      assert.equal(countRows(database, "usage_event"), receipt.events);
      assert.ok(countRows(database, "quota_occurrence") > 0);
      assert.ok(countRows(database, "tool_class_fact") > 0);
    });
    // Appending extends the same sources without breaking the corpus shape.
    const appended = appendSyntheticCodexEvents(receipt.sources.slice(0, 3), {
      seed: 3, events: 2, fillerBytesPerEvent: 0,
    });
    assert.equal(appended, 6);
    assert.ok(readdirSync(join(home, "sessions")).length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
