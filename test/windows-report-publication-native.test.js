import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadWindowsFilesystemBinding,
  loadWindowsReportPublicationBinding,
  WINDOWS_REPORT_PUBLICATION_CONTRACT,
} from "../src/platform/windows-filesystem.js";

const NATIVE_SKIP = process.platform === "win32" ? false : "native Windows only";
const MAXIMUM_REPORT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_REPORT_PATH_COMPONENTS = 256;
const WINDOWS_FILESYSTEM_MODULE = new URL(
  "../src/platform/windows-filesystem.js",
  import.meta.url,
).href;

async function withProtectedRoot(run) {
  const parent = await mkdtemp(join(tmpdir(), "rhetrion-windows-report-publication-"));
  const root = join(parent, "protected");
  try {
    const filesystem = loadWindowsFilesystemBinding();
    filesystem.ensureDirectory(root);
    return await run({ parent, root, filesystem });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function assertContentFreeNativeFailure(error, targetPath) {
  assert.match(error?.code ?? "", /^WINDOWS_FILESYSTEM_[A-Z0-9_]+$/u);
  assert.equal(error.message, "Windows filesystem operation failed");
  const rendered = `${error.stack ?? ""}\n${JSON.stringify(error)}`;
  assert.equal(rendered.includes(targetPath), false);
  return true;
}

function assertOwnerOnlyPath(filesystem, path, { directory }) {
  const metadata = filesystem.inspectPath(path);
  assert.equal(metadata.isDirectory, directory);
  assert.equal(metadata.isRegularFile, !directory);
  assert.equal(metadata.isReparsePoint, false);
  assert.equal(metadata.ownerMatches, true);
  assert.equal(metadata.nullDacl, false);
  assert.equal(metadata.daclProtected, true);
  assert.equal(metadata.broadAccess, false);
  assert.equal(metadata.nonOwnerAllow, false);
  assert.equal(metadata.unrecognizedAce, false);
  assert.equal(metadata.finalPathResolved, true);
  assert.equal(metadata.identity.linkCount, 1);
}

test("native report publication creates protected directories and files, replaces atomically, and removes stages", {
  skip: NATIVE_SKIP,
}, async () => withProtectedRoot(async ({ root, filesystem }) => {
  const native = loadWindowsReportPublicationBinding();
  assert.equal(native.reportPublicationContractVersion, WINDOWS_REPORT_PUBLICATION_CONTRACT);
  assert.equal(typeof native.publishReport, "function");

  const first = Buffer.from("synthetic first report\n", "utf8");
  const replacement = Buffer.from("synthetic replacement report\n", "utf8");
  const firstDirectory = join(root, "reports");
  const targetDirectory = join(firstDirectory, "nested");
  const target = join(targetDirectory, "report.md");

  native.publishReport(target, first);
  assert.deepEqual(await readFile(target), first);
  assert.deepEqual(await readdir(root), ["reports"]);
  assert.deepEqual(await readdir(firstDirectory), ["nested"]);
  assert.deepEqual(await readdir(targetDirectory), ["report.md"]);
  assertOwnerOnlyPath(filesystem, root, { directory: true });
  assertOwnerOnlyPath(filesystem, firstDirectory, { directory: true });
  assertOwnerOnlyPath(filesystem, targetDirectory, { directory: true });
  assertOwnerOnlyPath(filesystem, target, { directory: false });

  native.publishReport(target, replacement);
  assert.deepEqual(await readFile(target), replacement);
  assert.deepEqual(await readdir(targetDirectory), ["report.md"]);
  assertOwnerOnlyPath(filesystem, target, { directory: false });

  const largeTarget = join(targetDirectory, "large-report.md");
  const largeReport = Buffer.alloc(1024 * 1024 + 17, 0x73);
  native.publishReport(largeTarget, largeReport);
  assert.deepEqual(await readFile(largeTarget), largeReport);
  assert.deepEqual((await readdir(targetDirectory)).sort(), ["large-report.md", "report.md"]);
  assertOwnerOnlyPath(filesystem, largeTarget, { directory: false });
}));

test("native report publication refuses an inherited ACL and preserves the existing report", {
  skip: NATIVE_SKIP,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rhetrion-windows-report-inherited-acl-"));
  const target = join(root, "report.md");
  const original = Buffer.from("synthetic retained report\n", "utf8");
  const replacement = Buffer.from("synthetic blocked replacement\n", "utf8");
  try {
    const native = loadWindowsReportPublicationBinding();
    const filesystem = loadWindowsFilesystemBinding();
    const inheritance = spawnSync("icacls.exe", [root, "/inheritance:e"], {
      stdio: "ignore",
      windowsHide: true,
    });
    assert.equal(inheritance.status, 0, "could not prepare the inherited-ACL fixture");
    const parentBefore = filesystem.inspectPath(root);
    assert.equal(parentBefore.daclProtected, false);
    await writeFile(target, original);
    const before = await lstat(target, { bigint: true });
    const targetBefore = filesystem.inspectPath(target);
    const entriesBefore = await readdir(root);

    assert.throws(
      () => native.publishReport(target, replacement),
      (error) => assertContentFreeNativeFailure(error, target),
    );

    assert.deepEqual(await readFile(target), original);
    const after = await lstat(target, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    const parentAfter = filesystem.inspectPath(root);
    const targetAfter = filesystem.inspectPath(target);
    for (const key of ["ownerMatches", "nullDacl", "daclProtected", "broadAccess", "nonOwnerAllow", "unrecognizedAce"]) {
      assert.equal(parentAfter[key], parentBefore[key]);
      assert.equal(targetAfter[key], targetBefore[key]);
    }
    assert.deepEqual(await readdir(root), entriesBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native report publication refuses hard-linked report targets and cleans only its stage", {
  skip: NATIVE_SKIP,
}, async (t) => withProtectedRoot(async ({ root, filesystem }) => {
  const native = loadWindowsReportPublicationBinding();
  const sentinel = join(root, "sentinel.bin");
  const target = join(root, "report.md");
  const original = Buffer.from([0x00, 0xff, 0x14, 0x80]);
  filesystem.createFile(sentinel, original);
  try {
    await link(sentinel, target);
  } catch (error) {
    if (["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) {
      t.skip("hard-link creation is unavailable on this Windows runner");
      return;
    }
    throw error;
  }
  const before = await lstat(sentinel, { bigint: true });

  assert.throws(
    () => native.publishReport(target, Buffer.from("synthetic replacement\n", "utf8")),
    (error) => assertContentFreeNativeFailure(error, target),
  );

  const after = await lstat(sentinel, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.nlink, 2n);
  assert.deepEqual(await readFile(sentinel), original);
  assert.deepEqual(await readFile(target), original);
  assert.deepEqual((await readdir(root)).sort(), ["report.md", "sentinel.bin"]);
}));

test("native report publication refuses symbolic-link targets and preserves the link and target", {
  skip: NATIVE_SKIP,
}, async (t) => withProtectedRoot(async ({ root, filesystem }) => {
  const native = loadWindowsReportPublicationBinding();
  const sentinel = join(root, "sentinel.bin");
  const target = join(root, "report.md");
  const original = Buffer.from("synthetic link target\n", "utf8");
  filesystem.createFile(sentinel, original);
  try {
    await symlink(sentinel, target, "file");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) {
      t.skip("symbolic-link creation is unavailable on this Windows runner");
      return;
    }
    throw error;
  }
  const entriesBefore = (await readdir(root)).sort();

  assert.throws(
    () => native.publishReport(target, Buffer.from("synthetic replacement\n", "utf8")),
    (error) => assertContentFreeNativeFailure(error, target),
  );

  assert.equal((await lstat(target)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(sentinel), original);
  assert.deepEqual(await readFile(target), original);
  assert.deepEqual((await readdir(root)).sort(), entriesBefore);
}));

test("native report publication rejects bytes above the 64 MiB bound before creating a stage", {
  skip: NATIVE_SKIP,
}, async () => withProtectedRoot(async ({ root }) => {
  const native = loadWindowsReportPublicationBinding();
  const target = join(root, "oversize.md");
  const oversized = Buffer.alloc(MAXIMUM_REPORT_BYTES + 1, 0x53);

  assert.throws(
    () => native.publishReport(target, oversized),
    (error) => assertContentFreeNativeFailure(error, target),
  );
  await assert.rejects(lstat(target), { code: "ENOENT" });
  assert.deepEqual(await readdir(root), []);
}));

test("native report publication rejects paths beyond its component bound before creating directories", {
  skip: NATIVE_SKIP,
}, async () => withProtectedRoot(async ({ root }) => {
  const native = loadWindowsReportPublicationBinding();
  const target = join(
    root,
    ...Array.from({ length: MAXIMUM_REPORT_PATH_COMPONENTS + 1 }, () => "x"),
    "report.md",
  );

  assert.throws(
    () => native.publishReport(target, Buffer.from("synthetic report\n", "utf8")),
    (error) => assertContentFreeNativeFailure(error, target),
  );
  assert.deepEqual(await readdir(root), []);
}));

test("native report publication rejects overlong UTF-16 paths before creating directories", {
  skip: NATIVE_SKIP,
}, async () => withProtectedRoot(async ({ root }) => {
  const native = loadWindowsReportPublicationBinding();
  const target = `${root}\\${"x".repeat(32768)}.md`;
  assert.equal(target.length > 32767, true);

  assert.throws(
    () => native.publishReport(target, Buffer.from("synthetic report\n", "utf8")),
    (error) => assertContentFreeNativeFailure(error, target),
  );
  assert.deepEqual(await readdir(root), []);
}));

function startConcurrentWriter(target, payload) {
  const source = `
    import { loadWindowsReportPublicationBinding } from ${JSON.stringify(WINDOWS_FILESYSTEM_MODULE)};
    const native = loadWindowsReportPublicationBinding();
    process.stdout.write("ready\\n");
    let released = false;
    for await (const chunk of process.stdin) {
      if (chunk.toString("utf8").includes("go")) { released = true; break; }
    }
    if (!released) process.exit(2);
    try {
      native.publishReport(process.argv[1], Buffer.from(process.argv[2], "base64"));
      process.stdout.write("published\\n");
    } catch {
      process.stdout.write("failed\\n");
      process.exitCode = 1;
    }
  `;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    source,
    target,
    payload.toString("base64"),
  ], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const state = { closed: false };
  child.once("close", () => { state.closed = true; });
  let output = "";
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const completion = new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.split(/\r?\n/u).includes("ready")) readyResolve();
    });
    child.on("error", () => {
      readyReject(new Error("synthetic report writer could not start"));
      reject(new Error("synthetic report writer failed"));
    });
    child.on("close", (code) => {
      if (!output.split(/\r?\n/u).includes("ready")) {
        readyReject(new Error("synthetic report writer exited before its start gate"));
      }
      if (code === 0) resolve(output);
      else reject(new Error("synthetic report writer failed"));
    });
  });
  completion.catch(() => {});
  return { child, state, ready, completion };
}

function startStageRaceWriter(target, byteCount) {
  const source = `
    import { loadWindowsReportPublicationBinding } from ${JSON.stringify(WINDOWS_FILESYSTEM_MODULE)};
    const native = loadWindowsReportPublicationBinding();
    const payload = Buffer.alloc(Number(process.argv[2]), 0x53);
    try {
      native.publishReport(process.argv[1], payload);
      process.stdout.write("published\\n");
    } catch (error) {
      if (error?.code === "WINDOWS_FILESYSTEM_ALREADY_EXISTS") {
        process.stdout.write("refused\\n");
      } else {
        process.stdout.write("failed\\n");
        process.exitCode = 1;
      }
    }
  `;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    source,
    target,
    String(byteCount),
  ], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const state = { closed: false };
  child.once("close", () => { state.closed = true; });
  let output = "";
  const completion = new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", () => reject(new Error("synthetic report race writer could not start")));
    child.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error("synthetic report race writer failed"));
    });
  });
  return { child, state, completion };
}

function waitForSignal(signal, milliseconds) {
  let timer;
  return Promise.race([
    signal,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function withDeadline(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function terminateChildBeforeCleanup(writer) {
  const { child, state } = writer;
  if (state.closed || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", () => {
    state.closed = true;
    resolve();
  }));
  child.kill();
  await closed;
}

test("native report publication serializes concurrent child-process replacements", {
  skip: NATIVE_SKIP,
}, async () => withProtectedRoot(async ({ root, filesystem }) => {
  const native = loadWindowsReportPublicationBinding();
  assert.equal(native.reportPublicationContractVersion, WINDOWS_REPORT_PUBLICATION_CONTRACT);
  const sentinel = join(root, "sentinel.bin");
  const targetDirectory = join(root, "reports");
  const target = join(targetDirectory, "report.md");
  const sentinelBytes = Buffer.from([0x00, 0xff, 0x27, 0x80]);
  filesystem.createFile(sentinel, sentinelBytes);
  const writers = [];
  try {
    writers.push(startConcurrentWriter(target, Buffer.from("synthetic writer one\n", "utf8")));
    writers.push(startConcurrentWriter(target, Buffer.from("synthetic writer two\n", "utf8")));
    await withDeadline(
      Promise.all(writers.map((writer) => writer.ready)),
      30_000,
      "synthetic native report writers did not reach the start gate",
    );
    for (const writer of writers) writer.child.stdin.end("go\n");
    const results = await withDeadline(
      Promise.all(writers.map((writer) => writer.completion)),
      60_000,
      "concurrent native report publication exceeded its deadline",
    );

    assert.ok(results.every((output) => output.includes("published\n")));
    assert.ok([
      "synthetic writer one\n",
      "synthetic writer two\n",
    ].includes((await readFile(target, "utf8"))));
    assert.deepEqual(await readFile(sentinel), sentinelBytes);
    assert.deepEqual((await readdir(targetDirectory)).sort(), ["report.md"]);
    assert.deepEqual((await readdir(root)).sort(), ["reports", "sentinel.bin"]);
    assertOwnerOnlyPath(filesystem, targetDirectory, { directory: true });
    assertOwnerOnlyPath(filesystem, target, { directory: false });
  } finally {
    await Promise.all(writers.map((writer) => terminateChildBeforeCleanup(writer)));
  }
}));

test("native report publication refuses a target created after staging and removes its exact stage", {
  skip: NATIVE_SKIP,
}, async () => withProtectedRoot(async ({ root, filesystem }) => {
  const native = loadWindowsReportPublicationBinding();
  assert.equal(native.reportPublicationContractVersion, WINDOWS_REPORT_PUBLICATION_CONTRACT);
  const sentinelBytes = Buffer.from("synthetic target won the publication race\n", "utf8");
  let interleaved = false;

  for (let attempt = 0; attempt < 3 && !interleaved; attempt += 1) {
    const attemptDirectory = join(root, `attempt-${attempt}`);
    filesystem.ensureDirectory(attemptDirectory);
    const target = join(attemptDirectory, "report.md");
    let targetIdentity = null;
    let signalStage;
    const stageObserved = new Promise((resolve) => { signalStage = resolve; });
    let stageHandled = false;
    let stageFailureCode = null;
    const watcher = watch(attemptDirectory, {
      encoding: "utf8",
      persistent: false,
    }, (_eventType, filename) => {
      const name = typeof filename === "string" ? filename : filename?.toString("utf8");
      if (stageHandled || !name?.startsWith(".usagemonitor-report-")) return;
      stageHandled = true;
      try {
        targetIdentity = filesystem.createFile(target, sentinelBytes);
        signalStage({ state: "created" });
      } catch (error) {
        stageFailureCode = error?.code ?? "unknown";
        signalStage({ state: "not-created" });
      }
    });
    let watcherClosed = false;
    const closeWatcher = () => {
      if (watcherClosed) return;
      watcherClosed = true;
      watcher.close();
    };
    let writer;
    let output;
    let observed;
    try {
      writer = startStageRaceWriter(target, MAXIMUM_REPORT_BYTES);
      output = await withDeadline(
        writer.completion,
        60_000,
        "staged native report race exceeded its deadline",
      );
      observed = await waitForSignal(stageObserved, 1000);
    } finally {
      closeWatcher();
      if (writer) await terminateChildBeforeCleanup(writer);
    }

    if (observed?.state === "created" && output === "refused\n") {
      interleaved = true;
      assert.deepEqual(await readFile(target), sentinelBytes);
      assert.deepEqual(filesystem.inspectPath(target).identity, targetIdentity);
      assert.deepEqual(await readdir(attemptDirectory), ["report.md"]);
      assertOwnerOnlyPath(filesystem, attemptDirectory, { directory: true });
      assertOwnerOnlyPath(filesystem, target, { directory: false });
      break;
    }

    assert.equal(output, "published\n", "publication failed for a reason other than the expected race");
    if (observed?.state === "created") {
      assert.fail("native publication replaced a target created after staging");
    }
    if (stageFailureCode !== null && stageFailureCode !== "WINDOWS_FILESYSTEM_ALREADY_EXISTS") {
      assert.fail("race fixture could not create its synthetic target");
    }
    assert.deepEqual(await readdir(attemptDirectory), ["report.md"]);
    await rm(attemptDirectory, { recursive: true, force: true });
  }

  assert.equal(interleaved, true, "the stage watcher did not interleave a target creation within the bounded attempts");
}));
