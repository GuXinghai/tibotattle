import test from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createOwnerOnlyAtomicFilePublisher } from "../src/platform/index.js";
import {
  loadWindowsReportPublicationBinding,
  WINDOWS_REPORT_PUBLICATION_CONTRACT,
} from "../src/platform/windows-filesystem.js";
import { assertInputOutputPathsDistinct } from "../src/storage.js";

const syntheticFilesystem = Object.freeze({
  mkdir,
  realpath,
  lstat,
  openExclusive(path, mode) {
    return open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      mode,
    );
  },
  rename,
  unlink,
  async syncDirectory() {},
});

const syntheticPolicy = Object.freeze({
  assertPlatformSupported() {},
  // Synthetic policy checks the publisher's call order and file shape; it
  // intentionally makes no Windows DACL claim.
  assertDirectory({ stats }) {
    assert.equal(stats.isDirectory(), true);
  },
  assertStage({ stats, expectedBytes }) {
    assert.equal(stats.isFile(), true);
    assert.equal(stats.nlink, 1n);
    if (expectedBytes !== null) assert.equal(stats.size, BigInt(expectedBytes));
  },
});

function syntheticPublisher(filesystem = syntheticFilesystem) {
  return createOwnerOnlyAtomicFilePublisher({
    filesystem,
    policy: syntheticPolicy,
  });
}

async function createWorkspace() {
  return mkdtemp(join(tmpdir(), "rhetrion-atomic-file-synthetic-"));
}

test("synthetic publisher ignores a planted predictable hard-link stage and preserves its target", async (t) => {
  const root = await createWorkspace();
  const output = join(root, "report.md");
  const protectedFile = join(root, "protected.bin");
  const predictableStage = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(protectedFile, Buffer.from([0x00, 0xff, 0x10, 0x80]));
    const original = await readFile(protectedFile);
    try {
      await link(protectedFile, predictableStage);
    } catch (error) {
      if (["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) {
        t.skip("filesystem does not allow the synthetic hard-link fixture");
        return;
      }
      throw error;
    }

    await syntheticPublisher()(output, "derived report\n");

    assert.deepEqual(await readFile(protectedFile), original);
    assert.deepEqual(await readFile(predictableStage), original);
    assert.equal(await readFile(output, "utf8"), "derived report\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic publisher ignores a planted predictable symlink stage and preserves its target", async (t) => {
  const root = await createWorkspace();
  const output = join(root, "report.md");
  const protectedFile = join(root, "protected.bin");
  const predictableStage = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(protectedFile, Buffer.from([0x00, 0xff, 0x10, 0x80]));
    const original = await readFile(protectedFile);
    try {
      await symlink(protectedFile, predictableStage, "file");
    } catch (error) {
      if (["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) {
        t.skip("filesystem does not allow the synthetic symlink fixture");
        return;
      }
      throw error;
    }

    await syntheticPublisher()(output, "derived report\n");

    assert.deepEqual(await readFile(protectedFile), original);
    assert.deepEqual(await readFile(predictableStage), original);
    assert.equal(await readFile(output, "utf8"), "derived report\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic publisher removes only its own stage after atomic rename failure", async () => {
  const root = await createWorkspace();
  const output = join(root, "report.md");
  const filesystem = Object.freeze({
    ...syntheticFilesystem,
    async rename() {
      throw Object.assign(new Error("synthetic rename failure"), { code: "EIO" });
    },
  });
  try {
    await writeFile(output, "previous report\n");
    await assert.rejects(syntheticPublisher(filesystem)(output, "replacement\n"), { code: "EIO" });
    assert.equal(await readFile(output, "utf8"), "previous report\n");
    assert.deepEqual(await readdir(root), ["report.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic concurrent publication leaves one complete result and cleans its owned stages", async () => {
  const root = await createWorkspace();
  const output = join(root, "report.md");
  const unrelated = join(root, "unrelated.bin");
  const publish = syntheticPublisher();
  const sentinel = Buffer.from([0x00, 0xff, 0x15, 0x80]);
  try {
    await writeFile(unrelated, sentinel);
    const results = await Promise.allSettled([
      publish(output, "first complete report\n"),
      publish(output, "second complete report\n"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    if (process.platform === "win32") {
      // Node's Windows rename may refuse to replace an entry won by a racing
      // publisher. This is not a partial-publication failure; it does mean
      // this test is not proof that both concurrent writers make progress.
      assert.ok(fulfilled.length >= 1, "at least one complete publication must win");
      assert.ok(rejected.every((result) => ["EPERM", "EBUSY"].includes(result.reason?.code)),
        "Windows races may fail only with an explicit target-replacement conflict");
    } else {
      assert.equal(fulfilled.length, 2);
      assert.equal(rejected.length, 0);
    }
    assert.ok(["first complete report\n", "second complete report\n"].includes(await readFile(output, "utf8")));
    assert.deepEqual(await readFile(unrelated), sentinel);
    assert.deepEqual((await readdir(root)).sort(), ["report.md", "unrelated.bin"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("availability preflight calls only the policy gate and performs no filesystem operations", async () => {
  let filesystemCalls = 0;
  let policyCalls = 0;
  const filesystem = Object.freeze(Object.fromEntries(Object.entries(syntheticFilesystem).map(([name, method]) => [
    name,
    (...args) => {
      filesystemCalls += 1;
      return method(...args);
    },
  ])));
  const policy = Object.freeze({
    ...syntheticPolicy,
    assertPlatformSupported() { policyCalls += 1; },
  });
  const publish = createOwnerOnlyAtomicFilePublisher({ filesystem, policy });

  await publish.assertAvailable();
  assert.equal(policyCalls, 1);
  assert.equal(filesystemCalls, 0);
});

test("native test binding receives an absolute path and copied report bytes without path I/O", async () => {
  const root = await createWorkspace();
  const output = join(root, "not-created", "report.md");
  const input = Buffer.from("synthetic report\n", "utf8");
  const calls = [];
  const publish = createOwnerOnlyAtomicFilePublisher({
    nativeBindingForTest: {
      reportPublicationContractVersion: WINDOWS_REPORT_PUBLICATION_CONTRACT,
      publishReport(path, bytes) {
        calls.push({ path, bytes });
      },
    },
  });
  try {
    await publish.assertAvailable();
    assert.deepEqual(calls, []);
    await assert.rejects(lstat(dirname(output)), { code: "ENOENT" });

    await publish(output, input);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, resolve(output));
    assert.notEqual(calls[0].bytes, input);
    assert.deepEqual(calls[0].bytes, input);
    await assert.rejects(lstat(dirname(output)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native publication failures map to fixed content-free categories", async () => {
  const root = await createWorkspace();
  const output = join(root, "synthetic-private-path-canary", "report.md");
  const categories = [
    ["WINDOWS_FILESYSTEM_REPORT_PUBLISH_COMMIT_UNCERTAIN", "OWNER_ONLY_ATOMIC_COMMIT_UNCERTAIN"],
    ["WINDOWS_FILESYSTEM_REPORT_PUBLISH_MUTEX_RELEASE_FAILED", "OWNER_ONLY_ATOMIC_COMMIT_UNCERTAIN"],
    ["WINDOWS_FILESYSTEM_REPORT_PUBLISH_STAGE_CLEANUP_FAILED", "OWNER_ONLY_ATOMIC_CLEANUP_FAILED"],
    ["WINDOWS_FILESYSTEM_OPERATION_FAILED", "OWNER_ONLY_ATOMIC_PUBLICATION_FAILED"],
  ];
  try {
    for (const [nativeCode, expectedCode] of categories) {
      const publish = createOwnerOnlyAtomicFilePublisher({
        nativeBindingForTest: {
          reportPublicationContractVersion: WINDOWS_REPORT_PUBLICATION_CONTRACT,
          publishReport() {
            throw Object.assign(new Error(output), { code: nativeCode });
          },
        },
      });
      await assert.rejects(publish(output, Buffer.from("synthetic report\n")), (error) => {
        assert.equal(error.code, expectedCode);
        assert.equal(error.message, "Owner-only atomic publication failed");
        assert.equal(`${error.stack}\n${JSON.stringify(error)}`.includes(output), false);
        return true;
      });
    }
    await assert.rejects(lstat(dirname(output)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native report byte limit refuses oversize content before invoking the binding", async () => {
  const root = await createWorkspace();
  const output = join(root, "not-created", "report.md");
  let calls = 0;
  const publish = createOwnerOnlyAtomicFilePublisher({
    nativeBindingForTest: {
      reportPublicationContractVersion: WINDOWS_REPORT_PUBLICATION_CONTRACT,
      publishReport() { calls += 1; },
    },
  });
  try {
    await assert.rejects(
      publish(output, Buffer.alloc(64 * 1024 * 1024 + 1, 0x53)),
      { code: "OWNER_ONLY_ATOMIC_REPORT_TOO_LARGE" },
    );
    assert.equal(calls, 0);
    await assert.rejects(lstat(dirname(output)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production publisher capability is native-backed and preflight performs no path I/O", async () => {
  const root = await createWorkspace();
  const output = join(root, "not-created", "report.md");
  try {
    const publish = createOwnerOnlyAtomicFilePublisher();
    if (process.platform === "win32" && process.arch === "x64") {
      const native = loadWindowsReportPublicationBinding();
      assert.equal(native.reportPublicationContractVersion, WINDOWS_REPORT_PUBLICATION_CONTRACT);
      assert.equal(typeof native.publishReport, "function");
      await publish.assertAvailable();
    } else {
      const code = process.platform === "win32"
        ? "OWNER_ONLY_ATOMIC_WINDOWS_ATOMIC_PUBLISHER_UNAVAILABLE"
        : "OWNER_ONLY_ATOMIC_PLATFORM_UNSUPPORTED";
      await assert.rejects(publish.assertAvailable(), { code });
      await assert.rejects(publish(output, "report"), { code });
    }
    await assert.rejects(lstat(dirname(output)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("input/output preflight rejects direct and case-folded aliases without writing", async () => {
  const root = await createWorkspace();
  const input = join(root, "transition.json");
  try {
    const original = Buffer.from('{"transitions":[]}\n');
    await writeFile(input, original);
    for (const output of [input, join(root, "TRANSITION.JSON")]) {
      await assert.rejects(
        assertInputOutputPathsDistinct([input], [output]),
        { code: "CLI_PATH_SAFETY_INPUT_OUTPUT_COLLISION" },
      );
    }
    assert.deepEqual(await readFile(input), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("input/output preflight rejects canonical-parent, symlink, and hard-link aliases", async (t) => {
  const root = await createWorkspace();
  const canonicalDirectory = join(root, "canonical");
  const aliasDirectory = join(root, "alias");
  const input = join(canonicalDirectory, "transition.json");
  const parentAliasOutput = join(aliasDirectory, "transition.json");
  const symlinkOutput = join(root, "transition-link.json");
  const hardlinkOutput = join(root, "transition-hardlink.json");
  try {
    await mkdir(canonicalDirectory);
    await writeFile(input, "synthetic transition input\n");
    const aliases = [];
    for (const [target, alias, type] of [
      [canonicalDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir"],
      [input, symlinkOutput, "file"],
      [input, hardlinkOutput, "hardlink"],
    ]) {
      try {
        if (type === "hardlink") await link(target, alias);
        else await symlink(target, alias, type);
        aliases.push(alias);
      } catch (error) {
        if (!["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error;
      }
    }
    const outputAliases = [
      ...(aliases.includes(aliasDirectory) ? [parentAliasOutput] : []),
      ...aliases.filter((alias) => alias !== aliasDirectory),
    ];
    if (outputAliases.length === 0) {
      t.skip("filesystem does not allow the synthetic link fixtures");
      return;
    }
    for (const output of outputAliases) {
      await assert.rejects(
        assertInputOutputPathsDistinct([input], [output]),
        { code: "CLI_PATH_SAFETY_INPUT_OUTPUT_COLLISION" },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("input/output preflight rejects report aliases with another output", async (t) => {
  const root = await createWorkspace();
  const output = join(root, "weekly-calibration.json");
  const reportAlias = join(root, "WEEKLY-CALIBRATION.JSON");
  const hardlinkAlias = join(root, "weekly-calibration-hardlink.json");
  const symlinkAlias = join(root, "weekly-calibration-link.json");
  try {
    await writeFile(output, "synthetic data output\n");
    await assert.rejects(
      assertInputOutputPathsDistinct([], [output, reportAlias]),
      { code: "CLI_PATH_SAFETY_OUTPUT_COLLISION" },
    );
    const aliases = [];
    try { await link(output, hardlinkAlias); aliases.push(hardlinkAlias); }
    catch (error) {
      if (!["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error;
    }
    try { await symlink(output, symlinkAlias, "file"); aliases.push(symlinkAlias); }
    catch (error) {
      if (!["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error;
    }
    if (aliases.length === 0) {
      t.skip("filesystem does not allow the synthetic output-link fixtures");
      return;
    }
    for (const alias of [hardlinkAlias, symlinkAlias]) {
      await assert.rejects(
        assertInputOutputPathsDistinct([], [output, alias]),
        { code: "CLI_PATH_SAFETY_OUTPUT_COLLISION" },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
