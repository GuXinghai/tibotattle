import assert from "node:assert/strict";
import {
  appendFileSync, closeSync, openSync, readFileSync, readdirSync, renameSync,
  statSync, truncateSync, writeFileSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { auditPairing } from "../src/local-index-pairing.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { auditRollups } from "../src/local-index-rollup.js";
import { auditWorkRollups } from "../src/local-index-work-rollup.js";
import { SEGMENT_BYTES, WINDOW_BYTES } from "../src/local-index-source-digest.js";
import { appendSyntheticCodexEvents } from "../src/synthetic-codex-rollout-corpus.js";
import {
  assertSameFacts as assertSameFactsExactly,
  createWorkspace,
  v2Facts,
  withoutOrdinals,
} from "./helpers/local-index-facts.js";

// Live-versus-cold comparisons ignore ordinals; see withoutOrdinals.
const assertSameFacts = (actual, expected, label) => assertSameFactsExactly(
  withoutOrdinals(actual), withoutOrdinals(expected), label,
);

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Replace one ASCII digit inside `[low, high)` with a different digit. */
function editDigit(file, low, high, random) {
  const bytes = readFileSync(file);
  const candidates = [];
  for (let index = low; index < Math.min(high, bytes.length); index += 1) {
    if (bytes[index] >= 0x30 && bytes[index] <= 0x39) candidates.push(index);
  }
  assert.ok(candidates.length > 0, "the region must contain a digit");
  const position = candidates[Math.floor(random() * candidates.length)];
  const descriptor = openSync(file, "r+");
  writeSync(descriptor, Buffer.from([0x30 + ((bytes[position] - 0x30 + 1 + Math.floor(random() * 8)) % 10)]),
    0, 1, position);
  closeSync(descriptor);
}

function listSources(workspace) {
  return workspace.receipt.sources.slice().sort();
}

function largestSource(workspace) {
  return listSources(workspace)
    .map((path) => ({ path, size: statSync(path).size }))
    .sort((left, right) => right.size - left.size)[0];
}

/** Every derived table must equal its definition over the committed facts. */
function assertDerivedTablesExact(file, label) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(auditRollups(database), 0, `${label}: usage rollup`);
    assert.equal(auditWorkRollups(database), 0, `${label}: work rollup`);
    assert.equal(auditPairing(database), 0, `${label}: pairing`);
  } finally {
    database.close();
  }
}

async function coldFacts(workspace, label) {
  const file = join(workspace.state, `cold-${label}.sqlite`);
  await refreshLocalIndex({
    codexHome: workspace.codexHome, indexFile: file, secretFile: workspace.secretFile,
    workerCount: 1,
  });
  return v2Facts(file);
}

test("random mutations keep the live store equal to a cold build of the same files", async () => {
  const workspace = createWorkspace({
    files: 14, events: 500, days: 4, fillerBytesPerEvent: 6_000,
  });
  try {
    const random = createRandom(0xc0ffee);
    const live = join(workspace.state, "live.sqlite");
    const options = {
      codexHome: workspace.codexHome, indexFile: live,
      secretFile: workspace.secretFile, workerCount: 1,
    };
    await refreshLocalIndex(options);
    const biggest = largestSource(workspace);
    assert.ok(biggest.size > SEGMENT_BYTES * 2, "the corpus needs a source with closed segments");

    const mutations = [
      "append", "truncate", "same_size_edit", "edit_tail_append", "edit_head_append",
      "edit_closed_segment_append", "replace_file", "append",
    ];
    const counts = new Map();
    for (let round = 0; round < 16; round += 1) {
      const kind = mutations[round % mutations.length];
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      const sources = listSources(workspace);
      const target = kind === "edit_closed_segment_append"
        ? largestSource(workspace).path
        : sources[Math.floor(random() * sources.length)];
      const size = statSync(target).size;
      const grow = () => appendSyntheticCodexEvents([target], {
        seed: 500 + round, events: 2, fillerBytesPerEvent: 200,
        atMs: Date.parse("2026-09-03T00:00:00Z") + round * 60_000,
      });
      let undetectedUntilVerify = false;
      if (kind === "append") {
        appendSyntheticCodexEvents(
          sources.slice(0, 1 + Math.floor(random() * 4)),
          {
            seed: 900 + round, events: 3, fillerBytesPerEvent: 200,
            atMs: Date.parse("2026-09-02T00:00:00Z") + round * 60_000,
          },
        );
      } else if (kind === "truncate") {
        const text = readFileSync(target);
        let cut = Math.floor(text.length * (0.3 + random() * 0.5));
        while (cut > 0 && text[cut - 1] !== 0x0a) cut -= 1;
        truncateSync(target, cut);
      } else if (kind === "same_size_edit") {
        editDigit(target, 0, size, random);
      } else if (kind === "edit_tail_append") {
        editDigit(target, Math.max(0, size - WINDOW_BYTES * 3), size, random);
        grow();
      } else if (kind === "edit_head_append") {
        editDigit(target, 0, Math.min(size, WINDOW_BYTES), random);
        grow();
      } else if (kind === "edit_closed_segment_append") {
        editDigit(target, WINDOW_BYTES * 2, SEGMENT_BYTES - WINDOW_BYTES, random);
        grow();
        undetectedUntilVerify = true;
      } else if (kind === "replace_file") {
        const donor = sources.find((path) => path !== target);
        const replacement = `${target}.replacement`;
        writeFileSync(replacement, readFileSync(donor));
        renameSync(replacement, target);
      }

      await refreshLocalIndex(options);
      const expected = await coldFacts(workspace, `${round}`);
      if (!undetectedUntilVerify) {
        assertSameFacts(v2Facts(live), expected, `round ${round} ${kind}`);
      }
      const verified = await refreshLocalIndex({ ...options, verify: { force: true } });
      if (undetectedUntilVerify) {
        assert.ok(
          verified.verificationMismatches >= 1 || v2FactsEqual(v2Facts(live), expected),
          `round ${round}: a closed-segment edit must be found by verification`,
        );
      }
      assertSameFacts(v2Facts(live), expected, `round ${round} ${kind} after verify`);
      assertDerivedTablesExact(live, `round ${round} ${kind}`);
    }
    assert.ok(counts.size >= 7, "every mutation kind ran");
  } finally {
    workspace.cleanup();
  }
});

test("a rescan under a standing cursor leaves the pairing tables equal to the facts", async () => {
  // A same-size edit mid-file forces a full rescan of a source whose cursor
  // already covers the rewritten facts. The pairing tables have no insert
  // trigger, so they stay exact only if the rewrite is provisional.
  const workspace = createWorkspace({ files: 14, events: 500, days: 4, fillerBytesPerEvent: 600 });
  try {
    const live = join(workspace.state, "live.sqlite");
    const options = {
      codexHome: workspace.codexHome, indexFile: live,
      secretFile: workspace.secretFile, workerCount: 1,
    };
    await refreshLocalIndex(options);
    const random = createRandom(0xfeed);
    for (const target of listSources(workspace).slice(0, 4)) {
      const size = statSync(target).size;
      editDigit(target, Math.floor(size / 2), size, random);
    }
    const result = await refreshLocalIndex(options);
    assert.ok(result.sourcesRescanned >= 1, "the edits must force rescans");
    assertDerivedTablesExact(live, "after same-size rescans");
    assertSameFacts(v2Facts(live), await coldFacts(workspace, "pairing-rescan"), "facts");
  } finally {
    workspace.cleanup();
  }
});

function v2FactsEqual(left, right) {
  try {
    assertSameFacts(left, right, "probe");
    return true;
  } catch {
    return false;
  }
}

test("a size, mtime and ctime preserving edit is outside the model and found only by verification", async () => {
  // The model cannot see this edit through stat or windows, by design. The
  // test forges the stat tuple by editing the stored row, then proves the
  // manual verification still finds the divergence.
  const workspace = createWorkspace({ files: 6, events: 300, fillerBytesPerEvent: 4_000, days: 3 });
  try {
    const live = join(workspace.state, "live.sqlite");
    const options = {
      codexHome: workspace.codexHome, indexFile: live,
      secretFile: workspace.secretFile, workerCount: 1,
    };
    await refreshLocalIndex(options);
    const target = largestSource(workspace);
    assert.ok(target.size > SEGMENT_BYTES * 2);
    editDigit(target.path, WINDOW_BYTES * 2, SEGMENT_BYTES - WINDOW_BYTES, createRandom(5));
    const metadata = statSync(target.path);
    const database = new DatabaseSync(live);
    database.prepare(`
      UPDATE source SET mtime_ms = ?, ctime_ms = ?, size_bytes = ?
      WHERE path = ?`).run(metadata.mtimeMs, metadata.ctimeMs, metadata.size, target.path);
    database.close();

    const quiet = await refreshLocalIndex(options);
    assert.equal(quiet.sourcesRescanned, 0, "stat and windows cannot see the edit");
    const verified = await refreshLocalIndex({ ...options, verify: { force: true } });
    assert.equal(verified.verificationMismatches, 1);
    assert.equal(verified.sourcesRescanned, 1);
    assertSameFacts(v2Facts(live), await coldFacts(workspace, "forged"), "after verification");
  } finally {
    workspace.cleanup();
  }
});

test("an aborted lane build leaves no visible provisional facts and completes on retry", async () => {
  const workspace = createWorkspace({
    files: 40, events: 1_600, days: 6, fillerBytesPerEvent: 600,
  });
  try {
    const live = join(workspace.state, "live.sqlite");
    const options = {
      codexHome: workspace.codexHome, indexFile: live,
      secretFile: workspace.secretFile, workerCount: 3,
    };
    const controller = new AbortController();
    let aborted = false;
    const watcher = setInterval(() => {
      try {
        const database = new DatabaseSync(live, { readOnly: true });
        const count = Number(database.prepare("SELECT COUNT(*) AS n FROM usage_event").get().n);
        database.close();
        if (count > 150 && !aborted) {
          aborted = true;
          controller.abort();
        }
      } catch {
        // The store may not exist or may be mid-creation; poll again.
      }
    }, 2);
    await assert.rejects(
      refreshLocalIndex({ ...options, signal: controller.signal }),
      (error) => error?.code === "local_index_aborted" || error?.name === "AbortError",
    );
    clearInterval(watcher);
    assert.ok(aborted, "the build was interrupted mid-load");

    // Reopening removes anything beyond a cursor, then the retry completes.
    const retried = await refreshLocalIndex(options);
    assert.ok(retried.sourcesNew + retried.sourcesSkipped >= 1);
    const facts = v2Facts(live);
    assert.equal(facts.provisional, 0);
    assertSameFacts(facts, await coldFacts(workspace, "abort"), "after retry");
    const names = readdirSync(workspace.state).filter((name) => name.startsWith("live.sqlite"));
    assert.ok(names.includes("live.sqlite"));
  } finally {
    workspace.cleanup();
  }
});

test("rediscovered unchanged sources restore coverage without replaying retained facts", async () => {
  const workspace = createWorkspace({ files: 1, events: 5, days: 1 });
  try {
    const indexFile = join(workspace.state, "live.sqlite");
    const options = { codexHome: workspace.codexHome, indexFile,
      secretFile: workspace.secretFile, workerCount: 1 };
    const state = () => {
      const database = new DatabaseSync(indexFile, { readOnly: true });
      try {
        return {
          ...database.prepare("SELECT commit_seq, calculation_revision FROM store_state").get(),
          ...database.prepare("SELECT presence FROM source").get(),
        };
      } finally { database.close(); }
    };
    await refreshLocalIndex(options);
    const original = v2Facts(indexFile);
    await refreshLocalIndex({ ...options, endAt: "2020-01-01T00:00:00.000Z" });
    const hidden = state();
    assert.equal(hidden.presence, "absent");
    assertSameFactsExactly(v2Facts(indexFile), original, "narrow discovery retains facts");
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(refreshLocalIndex({ ...options, signal: cancelled.signal }));
    assert.deepEqual(state(), hidden, "cancelled refresh leaves the prior publication intact");
    const restored = await refreshLocalIndex(options);
    const visible = state();
    assert.equal(restored.sourcesSkipped, 1);
    assert.equal(restored.bytesScanned, 0);
    assert.equal(restored.unchanged, false);
    assert.equal(visible.presence, "present");
    assert.equal(visible.commit_seq, hidden.commit_seq + 1);
    assert.equal(visible.calculation_revision, hidden.calculation_revision + 1);
    assertSameFactsExactly(v2Facts(indexFile), original, "restored discovery retains facts");
    assert.equal((await refreshLocalIndex(options)).unchanged, true);
    assert.deepEqual(state(), visible, "repeated discovery does not republish");
  } finally { workspace.cleanup(); }
});

test("a vanished source keeps its facts and is marked absent", async () => {
  const workspace = createWorkspace({ files: 8, events: 200, days: 3 });
  try {
    const live = join(workspace.state, "live.sqlite");
    const options = {
      codexHome: workspace.codexHome, indexFile: live,
      secretFile: workspace.secretFile, workerCount: 1,
    };
    await refreshLocalIndex(options);
    const before = v2Facts(live).events.size;
    const victim = listSources(workspace)[0];
    const removed = new DatabaseSync(live, { readOnly: true });
    const victimEvents = Number(removed.prepare(`
      SELECT COUNT(*) AS n FROM usage_event u JOIN source s ON s.id = u.source_id
      WHERE s.path = ?`).get(victim).n);
    removed.close();
    renameSync(victim, `${victim}.gone`);
    const result = await refreshLocalIndex(options);
    assert.equal(result.sourcesAbsent, 1);
    assert.equal(v2Facts(live).events.size, before);
    assert.ok(victimEvents > 0);
    const database = new DatabaseSync(live, { readOnly: true });
    assert.equal(
      database.prepare("SELECT presence FROM source WHERE path = ?").get(victim).presence,
      "absent",
    );
    database.close();
    appendFileSync(join(workspace.state, "unrelated"), "x");
  } finally {
    workspace.cleanup();
  }
});
