import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveFileIds } from "../src/local-index-source-digest.js";
import { openStableRolloutSource } from "../src/rollout-source-snapshot.js";

const UNSAFE = 2n ** 53n;

test("ids a double holds exactly are formatted and zero ids are unknown", async () => {
  const infos = [
    { path: "a", dev: 3, ino: 12345 },
    { path: "b", dev: 3, ino: 0 },
    { path: "c", dev: Number.NaN, ino: 5 },
    { path: "d", dev: 3, ino: Number.MAX_SAFE_INTEGER },
  ];
  let calls = 0;
  const ids = await resolveFileIds(infos, {
    statBigint: async () => { calls += 1; throw new Error("unused"); },
  });
  assert.deepEqual(infos.map((info) => ids.get(info.path)), ["3:12345", null, null, "3:9007199254740991"]);
  assert.equal(calls, 0, "exact doubles need no second stat");
});

test("ids above 2^53 are read with BigInt precision and keep their low bit", async () => {
  const first = UNSAFE + 4n * 7n;
  const second = first + 1n;
  assert.equal(Number(first), Number(second), "the two ids are indistinguishable as doubles");
  const exact = new Map([["x", first], ["y", second]]);
  const infos = [
    { path: "x", dev: 5, ino: Number(first) },
    { path: "y", dev: 5, ino: Number(second) },
  ];
  const ids = await resolveFileIds(infos, {
    statBigint: async (path) => ({ dev: 5n, ino: exact.get(path) }),
  });
  assert.equal(ids.get("x"), `5:${first}`);
  assert.equal(ids.get("y"), `5:${second}`);
  assert.notEqual(ids.get("x"), ids.get("y"));
});

test("an id that changed or cannot be read between stats has no identity", async () => {
  const base = UNSAFE + 64n;
  const infos = [
    { path: "replaced", dev: 5, ino: Number(base) },
    { path: "missing", dev: 5, ino: Number(base) },
    { path: "zero", dev: 5, ino: Number(base) },
  ];
  const ids = await resolveFileIds(infos, {
    statBigint: async (path) => {
      if (path === "missing") throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (path === "zero") return { dev: 5n, ino: 0n };
      return { dev: 5n, ino: base + 1000n };
    },
  });
  assert.deepEqual(infos.map((info) => ids.get(info.path)), [null, null, null]);
});

test("opening a source with an exact file id refuses a different file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "local-index-file-id-"));
  try {
    const path = join(directory, "rollout.jsonl");
    writeFileSync(path, "{}\n");
    const metadata = statSync(path, { bigint: true });
    const info = {
      path,
      size: Number(metadata.size),
      dev: Number(metadata.dev),
      // An unsafe double stands in for a large NTFS id: the legacy comparison
      // skips it, so only the exact id can notice a different file.
      ino: Number(UNSAFE) + 2,
      birthtimeMs: statSync(path).birthtimeMs,
      mtimeMs: statSync(path).mtimeMs,
      ctimeMs: statSync(path).ctimeMs,
    };
    const exact = `${metadata.dev}:${metadata.ino}`;
    const accepted = await openStableRolloutSource({ ...info, fileId: exact });
    await accepted.verify();
    await accepted.close();
    await assert.rejects(
      openStableRolloutSource({ ...info, fileId: `${metadata.dev}:${metadata.ino + 1n}` }),
      (error) => error?.code === "codex_rollout_source_changed",
    );
    // Without an exact id the shared check keeps its previous behaviour.
    const legacy = await openStableRolloutSource(info);
    await legacy.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
