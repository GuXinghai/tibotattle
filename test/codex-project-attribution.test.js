import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { createWindowsFilesystemAdapter, createCodexWorkUsageProjectResolver,
  readCodexLocalThreadUsageRelations } from "../src/platform/index.js";
import { refreshLocalIndex } from "../src/local-index-refresh.js";
import { openLocalIndexStore } from "../src/local-index-store.js";
import { readLocalIndexWorkUsage } from "../src/local-index-work-usage.js";
import { queryWorkUsageSnapshot } from "../src/reporting/index.js";

const id = n => `${n}0000000-0000-4000-8000-000000000000`;
const at = "2026-10-01T12:00:00.000Z";
function header(uuid, cwd, parent = null) {
  return { type: "session_meta", timestamp: at, payload: {
    id: uuid, cwd, thread_source: parent ? "subagent" : "user", originator: "codex_cli_rs",
    source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : "cli",
  } };
}
async function homeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-project-attribution-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex"), sessions = join(home, "sessions", "2026", "10", "01");
  await mkdir(sessions, { recursive: true });
  const paths = new Map();
  async function source(uuid, parent = null, suffix = "", extra = []) {
    const path = join(sessions, `rollout-2026-10-01T12-00-00-${uuid}${suffix}.jsonl`);
    await writeFile(path, [header(uuid, root, parent), ...extra].map(JSON.stringify).join("\n") + "\n", { mode: 0o600 });
    return path;
  }
  return { root, home, sessions, paths, source };
}

test("source-only ancestry verifies nested parents without opening a metadata database", async t => {
  const f = await homeFixture(t);
  for (const [uuid, parent] of [[id(1), null], [id(2), id(1)], [id(3), id(2)],
    [id(4), id(5)], [id(5), id(4)], [id(6), id(9)]]) f.paths.set(uuid, [await f.source(uuid, parent)]);
  const before = await readdir(f.home);
  const actual = await readCodexLocalThreadUsageRelations(f.home, [id(3), id(4), id(6)], {
    sourcePaths: f.paths, includeProjectAncestry: true,
    databaseFactory() { assert.fail("source ancestry must not open SQLite"); },
  });
  assert.deepEqual(actual.get(id(3)).ancestors, [id(2), id(1)]);
  assert.equal(actual.get(id(3)).ancestryKnown, true);
  assert.equal(actual.get(id(3)).root, id(1));
  for (const uuid of [id(4), id(6)]) {
    assert.equal(actual.get(uuid).ancestryKnown, false);
    assert.deepEqual(actual.get(uuid).ancestors, []);
    assert.equal(actual.get(uuid).root, uuid);
  }
  assert.deepEqual(await readdir(f.home), before);
  assert.equal((await readCodexLocalThreadUsageRelations(f.home, [id(3)], {
    sourcePaths: [], databaseFactory() { assert.fail("invalid source-only options must not fall back to SQLite"); },
  })).size, 0);
  const terminal = await readCodexLocalThreadUsageRelations(f.home, [id(6)], {
    sourcePaths: f.paths, knownThreadIds: new Set([id(9)]), includeProjectAncestry: true,
  });
  assert.equal(terminal.get(id(6)).ancestryKnown, true);
  assert.deepEqual(terminal.get(id(6)).ancestors, [id(9)]);
});

test("source-only ancestry accepts compressed workers and verified review headers", async t => {
  const f = await homeFixture(t);
  f.paths.set(id(1), [await f.source(id(1))]);
  const worker = await f.source(id(2), id(1));
  await writeFile(`${worker}.zst`, zstdCompressSync(await readFile(worker)), { mode: 0o600 });
  f.paths.set(id(2), [`${worker}.zst`]);
  const review = await f.source(id(3));
  await writeFile(review, JSON.stringify({ type: "session_meta", payload: {
    id: id(3), thread_source: "guardian_review", source: { subagent: { other: "guardian" } },
    parent_thread_id: id(2),
  } }) + "\n", { mode: 0o600 });
  f.paths.set(id(3), [review]);
  const relations = await readCodexLocalThreadUsageRelations(f.home, [id(2), id(3)], {
    sourcePaths: f.paths, includeProjectAncestry: true,
  });
  assert.equal(relations.get(id(2)).root, id(1));
  assert.equal(relations.get(id(3)).root, id(1));
  assert.equal(relations.get(id(3)).autoReview, true);
  assert.deepEqual(relations.get(id(3)).ancestors, [id(2), id(1)]);
});

test("conflicting source parents, outside paths and truncated headers cannot grant ownership", async t => {
  const f = await homeFixture(t);
  f.paths.set(id(1), [await f.source(id(1))]);
  f.paths.set(id(2), [await f.source(id(2), id(1)), await f.source(id(2), id(3), "_conflict")]);
  const outside = join(f.root, "outside.jsonl");
  await writeFile(outside, JSON.stringify(header(id(3), f.root, id(1))) + "\n", { mode: 0o600 });
  f.paths.set(id(3), [outside]);
  const truncated = await f.source(id(4), id(1));
  await writeFile(truncated, JSON.stringify(header(id(4), f.root, id(1))), { mode: 0o600 });
  f.paths.set(id(4), [truncated]);
  const result = await readCodexLocalThreadUsageRelations(f.home, [id(2), id(3), id(4)], {
    sourcePaths: f.paths, includeProjectAncestry: true,
  });
  for (const relation of result.values()) assert.equal(relation.ancestryKnown, false);
});

test("nearest explicit parent wins, while own projectless, conflicts and incomplete chains stay explicit", () => {
  const memberships = { projects: new Map([["a", { name: "A" }], ["b", { name: "B" }]]),
    threads: new Map([[id(1), { kind: "project", projectId: "a" }],
      [id(2), { kind: "project", projectId: "b" }], [id(4), { kind: "non_project" }],
      [id(5), { kind: "unknown" }]]) };
  const relations = new Map([id(3), id(4), id(5)].map(uuid => [uuid,
    { ancestors: [id(2), id(1)], ancestryKnown: true }]));
  relations.set(id(6), { ancestors: [id(1)], ancestryKnown: false });
  const resolve = createCodexWorkUsageProjectResolver({ memberships, relations, digest: (k, v) => `${k}:${v}` });
  const location = { project: "git-project", worktree: "workspace", worktreeName: "Location" };
  assert.equal(resolve(id(3), location).project, "codex-project:b");
  assert.equal(resolve(id(4), location).project, "non-project");
  assert.equal(resolve(id(5), location).project, undefined);
  assert.equal(resolve(id(6), location).project, undefined);
  assert.equal(resolve(id(7), location).project, undefined);
});

test("source ancestry bounds deep chains and per-thread source counts", async t => {
  const f = await homeFixture(t);
  const chainId = n => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  for (let n = 1; n <= 66; n++) f.paths.set(chainId(n), [await f.source(chainId(n), n < 66 ? chainId(n + 1) : null)]);
  let result = await readCodexLocalThreadUsageRelations(f.home, [chainId(1)], {
    sourcePaths: uuid => f.paths.get(uuid), includeProjectAncestry: true,
  });
  assert.equal(result.get(chainId(1)).ancestryKnown, false);
  assert.deepEqual(result.get(chainId(1)).ancestors, []);
  f.paths.set(chainId(1), Array(33).fill(f.paths.get(chainId(2))[0]));
  result = await readCodexLocalThreadUsageRelations(f.home, [chainId(1)], {
    sourcePaths: f.paths, includeProjectAncestry: true,
  });
  assert.equal(result.get(chainId(1)).ancestryKnown, false);
});

test("stored facts classify non-Git projects and nested workers without rewriting or double counting", async t => {
  const f = await homeFixture(t);
  const state = join(f.root, "state");
  createWindowsFilesystemAdapter().ensureDirectory(state);
  const workspace = join(f.root, "plain-directory");
  await mkdir(workspace);
  const metadata = { "local-projects": {
    a: { id: "a", name: "Synthetic project A", rootPaths: [workspace] },
    b: { id: "b", name: "Synthetic project B", rootPaths: [join(f.root, "elsewhere")] },
  }, "thread-project-assignments": {
    [id(1)]: { projectKind: "local", projectId: "a" },
    [id(4)]: { projectKind: "local", projectId: "b" },
  }, "projectless-thread-ids": [id(5)] };
  const metadataFile = join(f.home, ".codex-global-state.json");
  await writeFile(metadataFile, JSON.stringify(metadata), { mode: 0o600 });
  const records = [];
  for (const [uuid, parent] of [[id(1), null], [id(2), id(1)], [id(3), id(2)],
    [id(4), id(1)], [id(5), id(1)], [id(6), id(9)]]) {
    const path = await f.source(uuid, parent, "", [
      { timestamp: at, type: "turn_context", payload: { cwd: workspace, model: "gpt-5.6-sol", effort: "high" } },
      { timestamp: at, type: "event_msg", payload: { type: "token_count", info: {
        total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 0, total_tokens: 100 },
        last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 0, total_tokens: 100 },
      } } },
    ]);
    records.push(path);
  }
  const indexFile = join(state, "index.sqlite"), secretFile = join(state, "local-unified-index-device-salt-v1");
  await refreshLocalIndex({ codexHome: f.home, indexFile, secretFile, workerCount: 1 });
  const history = openLocalIndexStore(indexFile);
  try {
    history.exec("BEGIN");
    const insert = history.prepare("INSERT INTO session(session_local,session_uuid) VALUES(?,?)");
    for (let i = 0; i < 25_001; i++) {
      const key = Buffer.alloc(32, 0xa5); key.writeUInt32LE(i);
      insert.run(key, `unrelated-invalid-historical-session-${i}`);
    }
    history.exec("COMMIT");
  } finally { history.close(); }
  const before = await readFile(indexFile), metadataBefore = await readFile(metadataFile);
  const sourceBefore = await Promise.all(records.map(p => readFile(p)));
  const database = openLocalIndexStore(indexFile, { readOnly: true });
  let snapshot;
  try {
    const result = await readLocalIndexWorkUsage({ database, indexFile, secretFile, codexHome: f.home,
      nowMs: Date.parse(at) + 60_000 });
    snapshot = Object.values(result.periods.all.snapshots)[0];
  } finally { database.close(); }
  const query = queryWorkUsageSnapshot(snapshot, { grouping: "project", sort: "tokens", offset: 0, pageSize: 100 });
  assert.equal(query.totals.tokens, 600);
  const a = Object.entries(snapshot.display.projects).find(([, p]) => p.name === "Synthetic project A")[0];
  const b = Object.entries(snapshot.display.projects).find(([, p]) => p.name === "Synthetic project B")[0];
  const amounts = Object.fromEntries(query.rows.map(r => [r.id, r.tokens]));
  assert.deepEqual(amounts, { [a]: 300, [b]: 100, "non-project": 100, unassigned: 100 });
  assert.equal(snapshot.metadata.resolverVersion, "work-location-v5-codex-project-membership");
  assert.deepEqual(await readFile(indexFile), before);
  assert.deepEqual(await readFile(metadataFile), metadataBefore);
  assert.deepEqual(await Promise.all(records.map(p => readFile(p))), sourceBefore);
  assert.equal(before.includes(Buffer.from("Synthetic project A")), false);
  assert.equal((await readdir(f.home)).includes("state_5.sqlite"), false);
});
