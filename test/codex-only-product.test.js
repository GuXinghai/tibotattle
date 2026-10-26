import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function stateBytes(root, relative = "") {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const result = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(relative, entry.name);
    assert.equal(entry.isSymbolicLink(), false, "synthetic state must not acquire links");
    if (entry.isDirectory()) Object.assign(result, await stateBytes(root, path));
    else {
      assert.equal(entry.isFile(), true);
      result[path] = createHash("sha256").update(await readFile(join(root, path))).digest("hex");
    }
  }
  return result;
}

test("retired provider commands and flags reject without changing existing state", async () => {
  const parent = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(parent, "rhetrion-codex-only-")));
  try {
    const home = join(root, "home");
    const state = join(root, "state");
    const local = join(root, "local");
    for (const directory of [home, state, local, join(home, ".claude"), join(home, ".codex"), join(local, "app-usagemonitor", "claude-statusline-v0.2")]) {
      await mkdir(directory, { recursive: true });
    }
    await writeFile(join(home, ".claude", "settings.json"), '{"statusLine":null}\n');
    await writeFile(join(local, "app-usagemonitor", "claude-statusline-v0.2", "record.json"), '{"legacy":true}\n');
    await writeFile(join(state, "credential-marker.bin"), Buffer.from([0, 1, 2, 255]));
    const before = await stateBytes(root);
    const env = Object.fromEntries(["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC"]
      .filter(key => typeof process.env[key] === "string").map(key => [key, process.env[key]]));
    Object.assign(env, {
      HOME: home, USERPROFILE: home, APPDATA: local, LOCALAPPDATA: local,
      CODEX_HOME: join(home, ".codex"), USAGE_MONITOR_STATE_ROOT: state,
      TEMP: root, TMP: root,
    });
    const run = args => spawnSync(process.execPath, [cli, ...args], {
      cwd: root, env, encoding: "utf8", timeout: 20_000, windowsHide: true,
    });
    for (const command of [
      "inspect-claude-callback", "install-claude-callback", "uninstall-claude-callback",
      "recover-claude-callback", "rotate-claude-callback-identity", "remove-claude-callback-identity",
      "benchmark-r7",
    ]) {
      const result = run([command]);
      assert.ifError(result.error);
      assert.equal(result.status, 1, command);
      assert.ok(result.stderr.includes(`Unknown command: ${command}`), result.stderr);
      assert.deepEqual(await stateBytes(root), before, command);
    }
    for (const flag of ["--claude-status", "--claude-usage", "--claude-state-dir", "--claude-projects-dir"]) {
      const result = run(["export-set", flag, state]);
      assert.ifError(result.error);
      assert.equal(result.status, 1, flag);
      assert.ok(result.stderr.includes(`Unknown argument: ${flag}`), result.stderr);
      assert.deepEqual(await stateBytes(root), before, flag);
    }
    const help = run(["--help"]);
    assert.ifError(help.error);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /usage-monitor/u);
    assert.doesNotMatch(help.stdout, /claude|anthropic/iu);
    assert.deepEqual(await stateBytes(root), before);
  } finally {
    assert.equal(dirname(root), parent);
    assert.ok(basename(root).startsWith("rhetrion-codex-only-"));
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true });
  }
});
