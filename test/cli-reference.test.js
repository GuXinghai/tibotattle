import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs, run } from "../src/cli.js";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TEST_DIRECTORY, "..");

async function repositoryFile(path) {
  return readFile(join(ROOT, path), "utf8");
}

function usageLines(source) {
  const match = /function usage\(\) \{\s*console\.log\(`Usage:\n([\s\S]*?)\n`\);\s*\}/u.exec(source);
  assert.ok(match, "CLI usage template is missing");
  return match[1].split("\n").map((line) => line.trim())
    .filter((line) => line.startsWith("usage-monitor "));
}

function documentedUsageLines(markdown) {
  const section = /## Exact invocation synopsis\s+```text\n([\s\S]*?)\n```/u.exec(markdown);
  assert.ok(section, "CLI reference synopsis is missing");
  return section[1].split("\n").map((line) => line.trim())
    .filter((line) => line.startsWith("usage-monitor "));
}

test("maintained CLI reference exactly mirrors every CLI invocation", async () => {
  const [source, markdown, packageSource] = await Promise.all([
    repositoryFile("src/cli.js"),
    repositoryFile("docs/reference/cli-reference.md"),
    repositoryFile("package.json"),
  ]);
  const sourceUsage = usageLines(source);
  assert.equal(sourceUsage.length, 33, "review unexpected CLI surface change");
  assert.deepEqual(documentedUsageLines(markdown), sourceUsage);
  assert.equal(
    Object.hasOwn(JSON.parse(packageSource).scripts, "register-account"),
    false,
    "dead register-account package entrypoint must not return",
  );
});

const RETIRED_CLI_COMMANDS = Object.freeze([
  "register-account",
  "pair-contribution-device",
  "sync-contributions-inspect-next",
  "sync-contributions-once",
  "sync-contributions-watch",
  "sync-contributions-status",
  "sync-contributions-pause",
  "sync-contributions-resume",
  "benchmark-r7",
  "inspect-claude-callback",
  "install-claude-callback",
  "uninstall-claude-callback",
  "recover-claude-callback",
  "rotate-claude-callback-identity",
  "remove-claude-callback-identity",
]);

test("retired commands cannot be invoked", async () => {
  for (const command of RETIRED_CLI_COMMANDS) {
    await assert.rejects(run([command]), {
      message: `Unknown command: ${command}`,
    });
  }
});

test("retired provider-specific CLI options are rejected during parsing", () => {
  for (const args of [
    ["export-set", "--workspace", "C:\\work", "--directory", "C:\\out", "--claude-status"],
    ["export-set", "--workspace", "C:\\work", "--directory", "C:\\out", "--claude-state-dir", "C:\\state"],
    ["export-set", "--workspace", "C:\\work", "--directory", "C:\\out", "--claude-usage"],
    ["export-set", "--workspace", "C:\\work", "--directory", "C:\\out", "--claude-projects-dir", "C:\\projects"],
    ["remove-claude-callback-identity", "--confirm-removal", "ABC"],
    ["benchmark-r7", "--profile", "smoke", "--output", "C:\\receipt.json"],
  ]) {
    assert.throws(() => parseArgs(args), /Unknown argument:/u);
  }
});
