import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import zlib from "node:zlib";

import { refreshLocalIndex } from "../src/local-index-refresh.js";
import {
  assertSameFacts, createWorkspace, v2Facts, withoutOrdinals,
} from "./helpers/local-index-facts.js";

// Rollouts rotate: Codex moves a session to archived_sessions, and an
// archived rollout may be stored compressed. Rotation preserves content, so it
// must never change what the index says, never mint a second identity for the
// same session and never count an event twice.

function ordinalsBySource(file) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return new Map(database.prepare(
      "SELECT hex(source_local) AS id, source_ordinal AS ordinal FROM source",
    ).all().map((row) => [row.id, Number(row.ordinal)]));
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

test("archiving a rollout keeps its identity and counts every event once", async () => {
  const workspace = createWorkspace({ files: 12, events: 360, days: 4 });
  try {
    const live = join(workspace.state, "live.sqlite");
    const options = {
      codexHome: workspace.codexHome, indexFile: live,
      secretFile: workspace.secretFile, workerCount: 1,
    };
    await refreshLocalIndex(options);
    const before = v2Facts(live);
    const ordinalsBefore = ordinalsBySource(live);

    const archived = join(workspace.codexHome, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    const moved = workspace.receipt.sources.slice(0, 3);
    for (const path of moved) renameSync(path, join(archived, basename(path)));

    const result = await refreshLocalIndex(options);
    assert.equal(result.sourcesNew, 0, "a moved rollout is the same source");
    assert.equal(result.sourcesAbsent, 0);
    assertSameFacts(withoutOrdinals(v2Facts(live)), withoutOrdinals(before), "after archive");
    assert.deepEqual(ordinalsBySource(live), ordinalsBefore);
    assertSameFacts(
      withoutOrdinals(v2Facts(live)),
      withoutOrdinals(await coldFacts(workspace, "archive")),
      "archive vs cold",
    );
  } finally {
    workspace.cleanup();
  }
});

const nativeZstd = typeof zlib.zstdCompressSync === "function";
test("compressing an archived rollout changes no fact", { skip: !nativeZstd && "needs native Zstd" }, async () => {
  const workspace = createWorkspace({ files: 12, events: 360, days: 4 });
  try {
    const live = join(workspace.state, "live.sqlite");
    const options = {
      codexHome: workspace.codexHome, indexFile: live,
      secretFile: workspace.secretFile, workerCount: 1,
    };
    await refreshLocalIndex(options);
    const before = v2Facts(live);

    const archived = join(workspace.codexHome, "archived_sessions");
    mkdirSync(archived, { recursive: true });
    for (const path of workspace.receipt.sources.slice(0, 2)) {
      const target = join(archived, `${basename(path)}.zst`);
      writeFileSync(target, zlib.zstdCompressSync(readFileSync(path)));
      rmSync(path);
    }

    await refreshLocalIndex(options);
    const after = v2Facts(live);
    assert.equal(after.events.size, before.events.size, "no event is lost or counted twice");
    assertSameFacts(
      withoutOrdinals(after),
      withoutOrdinals(await coldFacts(workspace, "compress")),
      "compress vs cold",
    );
  } finally {
    workspace.cleanup();
  }
});
