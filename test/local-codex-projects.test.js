import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWindowsSourceReadBinding } from "../src/platform/windows-filesystem.js";
import { readCodexLocalProjectMemberships } from "../src/platform/local-codex-projects.js";

const PROJECT_THREAD = "11111111-1111-4111-8111-111111111111";
const PROJECTLESS_THREAD = "22222222-2222-4222-8222-222222222222";
const CONFLICT_THREAD = "33333333-3333-4333-8333-333333333333";
const DANGLING_THREAD = "44444444-4444-4444-8444-444444444444";
const REMOTE_THREAD = "55555555-5555-4555-8555-555555555555";
const PRIVATE_CANARY = "GLOBAL_STATE_UNKNOWN_FIELD_MUST_NOT_LEAK";

async function fixture(t, document) {
  const codexHome = await mkdtemp(join(tmpdir(), "local-codex-projects-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const file = join(codexHome, ".codex-global-state.json");
  await writeFile(file, JSON.stringify(document), { mode: 0o600 });
  return { codexHome, file };
}

function baseDocument() {
  return {
    "local-projects": {
      "local-example": {
        id: "local-example",
        name: "Example project",
        rootPaths: ["C:\\synthetic\\non-git-project", "relative\\path", "C:\\bad\u0000path"],
        createdAt: 1,
        updatedAt: 2,
        privateUnknownField: PRIVATE_CANARY,
      },
    },
    "thread-project-assignments": {
      [PROJECT_THREAD]: { projectKind: "local", projectId: "local-example", ignored: PRIVATE_CANARY },
      [DANGLING_THREAD]: { projectKind: "local", projectId: "missing-project" },
      [REMOTE_THREAD]: { projectKind: "remote", projectId: "remote-project" },
    },
    "projectless-thread-ids": [PROJECTLESS_THREAD],
    ignoredGlobalField: PRIVATE_CANARY,
  };
}

test("reads explicit local project and projectless membership without leaking other global state", async t => {
  const { codexHome, file } = await fixture(t, baseDocument());
  const before = await readFile(file);
  const result = await readCodexLocalProjectMemberships(codexHome);
  assert.equal(result.status, "available");
  assert.deepEqual([...result.projects], [["local-example", {
    name: "Example project",
    rootPaths: ["C:\\synthetic\\non-git-project"],
  }]]);
  assert.deepEqual(result.threads.get(PROJECT_THREAD), { kind: "project", projectId: "local-example" });
  assert.deepEqual(result.threads.get(PROJECTLESS_THREAD), { kind: "non_project" });
  assert.deepEqual(result.threads.get(DANGLING_THREAD), { kind: "unknown" });
  assert.deepEqual(result.threads.get(REMOTE_THREAD), { kind: "unknown" });
  assert.doesNotMatch(JSON.stringify({
    projects: [...result.projects], threads: [...result.threads],
  }), new RegExp(PRIVATE_CANARY, "u"));
  assert.equal(JSON.stringify([...result.projects]), JSON.stringify([["local-example", {
    name: "Example project", rootPaths: ["C:\\synthetic\\non-git-project"],
  }]]));
  assert.deepEqual(await readFile(file), before);
});

test("conflicting normalized thread assignments and projectless markers remain unknown", async t => {
  const upper = CONFLICT_THREAD.toUpperCase();
  const document = baseDocument();
  document["thread-project-assignments"][CONFLICT_THREAD] = {
    projectKind: "local", projectId: "local-example",
  };
  document["thread-project-assignments"][upper] = {
    projectKind: "remote", projectId: "remote-project",
  };
  document["projectless-thread-ids"].push(CONFLICT_THREAD);
  const { codexHome } = await fixture(t, document);
  const result = await readCodexLocalProjectMemberships(codexHome);
  assert.equal(result.status, "available");
  assert.deepEqual(result.threads.get(CONFLICT_THREAD), { kind: "unknown" });
});

test("project key and embedded id must match before an assignment is accepted", async t => {
  const document = baseDocument();
  document["local-projects"]["local-example"].id = "different-project";
  const { codexHome } = await fixture(t, document);
  const result = await readCodexLocalProjectMemberships(codexHome);
  assert.equal(result.status, "available");
  assert.equal(result.projects.size, 0);
  assert.deepEqual(result.threads.get(PROJECT_THREAD), { kind: "unknown" });
});

test("malformed, oversized, or identity-changing input fails closed", async t => {
  const invalidDocuments = [
    { ...baseDocument(), "local-projects": Array.from({ length: 10_001 }, (_, index) => ({
      id: `local-${index}`, name: "Project", rootPaths: [],
    })) },
    { ...baseDocument(), "thread-project-assignments": Object.fromEntries(
      Array.from({ length: 25_001 }, (_, index) => [
        `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
        { projectKind: "remote", projectId: "remote" },
      ]),
    ) },
    { ...baseDocument(), "projectless-thread-ids": Array.from({ length: 25_001 }, (_, index) =>
      `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`) },
    { ...baseDocument(), "local-projects": { "local-example": {
      id: "local-example", name: "Example", rootPaths: Array(33).fill("C:\\synthetic\\root"),
    } } },
  ];
  for (const document of invalidDocuments) {
    const { codexHome } = await fixture(t, document);
    const result = await readCodexLocalProjectMemberships(codexHome);
    assert.equal(result.status, "unavailable");
    assert.equal(result.projects.size, 0);
    assert.equal(result.threads.size, 0);
  }

  const oversized = await fixture(t, {});
  await writeFile(oversized.file, `{"padding":"${"x".repeat(8 * 1024 * 1024)}"}`);
  const oversizedResult = await readCodexLocalProjectMemberships(oversized.codexHome);
  assert.equal(oversizedResult.status, "unavailable");
  assert.equal(oversizedResult.projects.size, 0);
  assert.equal(oversizedResult.threads.size, 0);

  const duplicate = await fixture(t, {});
  await writeFile(duplicate.file, "{\"local-projects\":{},\"local-projects\":{}}");
  const duplicateResult = await readCodexLocalProjectMemberships(duplicate.codexHome);
  assert.equal(duplicateResult.status, "unavailable");
  assert.equal(duplicateResult.projects.size, 0);
  assert.equal(duplicateResult.threads.size, 0);

  const cancelled = new AbortController();
  cancelled.abort(new Error("synthetic cancellation"));
  await assert.rejects(
    readCodexLocalProjectMemberships(oversized.codexHome, { signal: cancelled.signal }),
    /synthetic cancellation/u,
  );
});

for (const [label, field, value] of [
  ["replacement identity", "ino", "00000000000000000000000000000099"],
  ["file growth", "size", 1],
]) {
  test(`refuses ${label} detected between open and publication`, async t => {
    const { codexHome } = await fixture(t, baseDocument());
    const native = loadWindowsSourceReadBinding();
    const original = native.statSourceFile;
    let stats = 0;
    const mock = t.mock.method(native, "statSourceFile", function (lease) {
      const current = original.call(this, lease);
      stats += 1;
      if (stats !== 2) return current;
      return { ...current, [field]: field === "size" ? current.size + value : value };
    });
    try {
      const result = await readCodexLocalProjectMemberships(codexHome, {
        loadWindowsBinding: () => native,
      });
      assert.equal(result.status, "unavailable");
      assert.equal(result.projects.size, 0);
      assert.equal(result.threads.size, 0);
      assert.ok(mock.mock.callCount() >= 2);
    } finally { mock.mock.restore(); }
  });
}
