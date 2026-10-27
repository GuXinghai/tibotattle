import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { run } from "../src/cli.js";
import { loadWindowsFilesystemBinding } from "../src/platform/windows-filesystem.js";

test("quality publishes JSON and Markdown using only explicit synthetic inputs", {
  skip: process.platform === "win32" ? false : "native Windows only",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "rhetrion-cli-report-"));
  const input = join(root, "transitions.json");
  const collector = join(root, "observations.jsonl");
  const directory = join(root, "protected-reports");
  const output = join(directory, "quality.json");
  const report = join(directory, "quality.md");
  const inputBytes = Buffer.from(JSON.stringify({
    schemaVersion: "0.3", windowGroups: [], snapshotIntervals: [], transitions: [],
  }));
  try {
    await writeFile(input, inputBytes);
    await writeFile(collector, "");
    const args = ["quality", "--input", input, "--collector-file", collector,
      "--output", output, "--report-file", report];
    await run(args);
    const first = JSON.parse(await readFile(output, "utf8"));
    assert.equal(typeof first, "object");
    assert.match(await readFile(report, "utf8"), /quality/i);
    // Exercise replacement through the public CLI as well as creation.
    await run(args);
    assert.deepEqual(await readFile(input), inputBytes);
    assert.equal(await readFile(collector, "utf8"), "");
    assert.deepEqual((await readdir(directory)).sort(), ["quality.json", "quality.md"]);
    assert.deepEqual((await readdir(root)).sort(),
      ["observations.jsonl", "protected-reports", "transitions.json"]);
    const native = loadWindowsFilesystemBinding();
    for (const path of [directory, output, report]) {
      const metadata = native.inspectPath(path);
      assert.equal(metadata.daclProtected, true);
      assert.equal(metadata.ownerMatches, true);
      assert.equal(metadata.broadAccess, false);
      assert.equal(metadata.identity.linkCount, 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
