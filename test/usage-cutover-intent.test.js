import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { rm, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { openUsageCutoverIntent, classifyUsageCutoverIntentFailure, USAGE_CUTOVER_INTENT_SCHEMA } from "../scripts/lib/usage-cutover-intent.mjs";
import { loadWindowsReleaseOperationBinding } from "../src/platform/index.js";
import { openOperation } from "../scripts/lib/release-operation.mjs";
const sha = text => createHash("sha256").update(text).digest("hex");
const binding = () => ({ operationId: "00000000-0000-4000-8000-000000000001", action: "backup_usage_bundle",
  bundleSelectionSha256: sha("bundle"), sourceRootIdentitySha256: sha("source-root"), targetRootIdentitySha256: sha("target-root"),
  toolSha256: sha("tool"), candidateSha256: sha("candidate"), preconditionsReportSha256: sha("preconditions"), historyArchiveManifestSha256: null,
  before: { sourceManifestSha256: sha("synthetic-source"), targetManifestSha256: null, stagingManifestSha256: null },
  after: { sourceManifestSha256: sha("synthetic-source"), targetManifestSha256: sha("synthetic-source"), stagingManifestSha256: null } });
const category = code => error => classifyUsageCutoverIntentFailure(error) === `USAGE_CUTOVER_INTENT_${code}`;
async function fixture(t) {
  const native = loadWindowsReleaseOperationBinding(), root = resolve(".release-build", `usage-intent-${randomUUID()}`);
  native.ensureDirectory(root);
  t.after(async () => {
    const child = relative(resolve(".release-build"), root);
    assert.ok(child && !child.startsWith("..") && !child.includes(":"));
    await rm(root, { recursive: true, force: true });
  });
  return { native, root, options: { directory: join(root, "intent"), binding: binding() } };
}

test("intent is durable before any usage action and reopening cannot replay it", async t => {
  const { options } = await fixture(t);
  const op = await openUsageCutoverIntent(options);
  assert.equal(op.summary().status, "intent_durable");
  assert.equal(op.summary().replay, "never_automatic");
  const record = JSON.parse(await readFile(join(options.directory, "operation.json"), "utf8"));
  assert.equal(record.state.schemaVersion, USAGE_CUTOVER_INTENT_SCHEMA);
  assert.equal(record.state.status, "intent_durable");
  await assert.rejects(openUsageCutoverIntent({ ...options, resume: true }), category("STORAGE_BUSY"));
  op.close();
  await assert.rejects(openUsageCutoverIntent(options), category("RESUME_REQUIRED"));
  const reopened = await openUsageCutoverIntent({ ...options, resume: true });
  try {
    assert.equal(reopened.summary().status, "intent_durable");
    assert.equal(reopened.summary().freshResourceInspection, "required_before_any_action");
    assert.equal(await reopened.reconcile({ observation: binding().before, reportSha256: sha("unchanged-report") }), "unchanged");
  } finally { reopened.close(); }
});

test("bound empty initialization crash window resumes metadata only", async t => {
  const { options } = await fixture(t);
  const raw = await openOperation({ directory: options.directory, kind: "maintenance",
    binding: { schemaVersion: USAGE_CUTOVER_INTENT_SCHEMA, binding: options.binding } });
  raw.close();
  const op = await openUsageCutoverIntent({ ...options, resume: true });
  assert.equal(op.summary().status, "intent_durable"); op.close();
});

test("native synthetic resources reconcile after physical copy but missing completion acknowledgement", async t => {
  const { native, root, options } = await fixture(t), resource = join(root, "synthetic-resources");
  native.ensureDirectory(resource);
  const guard = native.acquireProtectedDirectoryGuard(resource);
  const snapshot = () => {
    const read = name => { try { return sha(native.readProtectedChild(resource, guard.identity, name, 4096).data); }
      catch (error) { if (["ENOENT", "WINDOWS_FILESYSTEM_NOT_FOUND"].includes(error.code)) return null; throw error; } };
    return { sourceManifestSha256: read("source.bin"), targetManifestSha256: read("target.bin"), stagingManifestSha256: read("draft.bin") };
  };
  try {
    native.createProtectedChild(resource, guard.identity, "source.bin", Buffer.from("synthetic-source"));
    const op = await openUsageCutoverIntent(options);
    assert.deepEqual(snapshot(), binding().before);
    // Crash window model: action completed, completion never written.
    native.createProtectedChild(resource, guard.identity, "target.bin", Buffer.from("synthetic-source"));
    op.close();
    const recovered = await openUsageCutoverIntent({ ...options, resume: true });
    try {
      assert.equal(recovered.summary().status, "intent_durable");
      const request = { observation: snapshot(), reportSha256: sha("actual-readback") };
      assert.equal(await recovered.reconcile(request), "applied");
      const before = await readFile(join(options.directory, "operation.json"));
      assert.equal(await recovered.reconcile(request), "applied");
      assert.deepEqual(await readFile(join(options.directory, "operation.json")), before);
      await assert.rejects(recovered.reconcile({ observation: binding().before, reportSha256: sha("stale-report") }), category("RECONCILIATION_CHANGED"));
    } finally { recovered.close(); }
  } finally { native.releaseProtectedDirectoryGuard(guard.guard); }
});

test("partial draft, changed source and unexpected target become sticky conflicts", async t => {
  for (const observation of [
    { ...binding().before, stagingManifestSha256: sha("partial") },
    { ...binding().before, sourceManifestSha256: sha("changed-source") },
    { ...binding().after, targetManifestSha256: sha("unrelated-target") },
  ]) {
    const { options } = await fixture(t), op = await openUsageCutoverIntent(options);
    assert.equal(await op.reconcile({ observation, reportSha256: sha("conflict") }), "conflict"); op.close();
    const reopened = await openUsageCutoverIntent({ ...options, resume: true });
    try {
      assert.equal(reopened.summary().status, "conflict");
      await assert.rejects(reopened.reconcile({ observation: binding().after, reportSha256: sha("later-report") }), category("RECONCILIATION_CHANGED"));
    } finally { reopened.close(); }
  }
});

test("wrong bundle, roots, tool, candidate or planned outcome cannot resume an operation", async t => {
  const { options } = await fixture(t), op = await openUsageCutoverIntent(options); op.close();
  for (const key of ["bundleSelectionSha256", "sourceRootIdentitySha256", "targetRootIdentitySha256", "toolSha256", "candidateSha256"]) {
    await assert.rejects(openUsageCutoverIntent({ ...options, resume: true, binding: { ...binding(), [key]: sha("other") } }), category("BINDING_MISMATCH"));
  }
});

test("restore requires a preserved new-history archive; no-clobber actions reject existing target", async t => {
  const { options } = await fixture(t);
  await assert.rejects(openUsageCutoverIntent({ ...options, binding: { ...binding(), action: "restore_usage_bundle" } }), category("NEW_HISTORY_UNPRESERVED"));
  await assert.rejects(openUsageCutoverIntent({ ...options, binding: { ...binding(), before: binding().after } }), category("RESOURCE_PLAN_INVALID"));
  await assert.rejects(openUsageCutoverIntent({ ...options, binding: { ...binding(), before: { ...binding().before, targetManifestSha256: sha("existing") } } }), category("TARGET_NOT_EMPTY"));
});

test("closed/unknown input observations cannot supply implicit absence or leak arbitrary errors", async t => {
  const { options } = await fixture(t), op = await openUsageCutoverIntent(options);
  try {
    for (const observation of [null, {}, { ...binding().before, complete: true }, { targetManifestSha256: null, stagingManifestSha256: null }]) {
      await assert.rejects(op.reconcile({ observation, reportSha256: sha("report") }), category("OBSERVATION_INVALID"));
    }
    assert.ok(!JSON.stringify(op.summary()).includes(options.binding.operationId));
    assert.ok(!JSON.stringify(op.summary()).includes(sha("bundle")));
  } finally { op.close(); }
  await assert.rejects(op.reconcile({ observation: binding().before, reportSha256: sha("report") }), category("CLOSED"));
  assert.equal(classifyUsageCutoverIntentFailure({ code: "USAGE_CUTOVER_INTENT_CLOSED" }), "USAGE_CUTOVER_INTENT_UNAVAILABLE");
});

test("uncertain native save blocks reconciliation until reopening the durable intent", async t => {
  const { native, options } = await fixture(t), op = await openUsageCutoverIntent(options);
  const path = join(options.directory, "operation.json"), original = await readFile(path);
  try {
    await rm(path); native.createFile(path, original);
    const request = { observation: binding().after, reportSha256: sha("readback") };
    await assert.rejects(op.reconcile(request), category("PERSISTENCE_UNCERTAIN"));
    assert.equal(op.summary().persistence, "uncertain");
    await assert.rejects(op.reconcile(request), category("PERSISTENCE_UNCERTAIN"));
  } finally { op.close(); }
  const resumed = await openUsageCutoverIntent({ ...options, resume: true });
  try { assert.equal(resumed.summary().status, "intent_durable"); }
  finally { resumed.close(); }
});

test("overlapping reconciliation and close cannot race an in-flight save", async t => {
  const { options } = await fixture(t), op = await openUsageCutoverIntent(options);
  const request = { observation: binding().before, reportSha256: sha("unchanged") };
  try {
    const saving = op.reconcile(request);
    assert.equal(op.summary().persistence, "saving");
    assert.throws(() => op.close(), category("BUSY"));
    await assert.rejects(op.reconcile(request), category("BUSY"));
    await saving;
  } finally { op.close(); }
});

test("owned child death after synthetic write is reconciled from bytes without replay", { timeout: 30_000 }, async t => {
  const { native, root, options } = await fixture(t);
  const intentURL = new URL("../scripts/lib/usage-cutover-intent.mjs", import.meta.url).href;
  const platformURL = new URL("../src/platform/index.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { openUsageCutoverIntent } from ${JSON.stringify(intentURL)};
    import { loadWindowsReleaseOperationBinding } from ${JSON.stringify(platformURL)};
    const options = JSON.parse(process.argv[1]);
    const op = await openUsageCutoverIntent(options);
    const native = loadWindowsReleaseOperationBinding();
    const guard = native.acquireProtectedDirectoryGuard(process.argv[2]);
    native.createProtectedChild(process.argv[2], guard.identity, "synthetic-target.bin", Buffer.from("synthetic-source"));
    native.releaseProtectedDirectoryGuard(guard.guard);
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `, JSON.stringify(options), root], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  child.stderr.resume();
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error("Synthetic usage child readiness timeout")), 15_000);
    const failed = () => { clearTimeout(timer); reject(new Error("Synthetic usage child unavailable")); };
    child.once("error", failed); child.once("exit", failed);
    let text = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => {
      text += chunk;
      if (text.includes("ready\n")) { clearTimeout(timer); resolveReady(); }
    });
  });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const op = await openUsageCutoverIntent({ ...options, resume: true });
  try {
    assert.equal(op.summary().status, "intent_durable");
    const guard = native.acquireProtectedDirectoryGuard(root);
    let targetDigest;
    try { targetDigest = sha(native.readProtectedChild(root, guard.identity, "synthetic-target.bin", 4096).data); }
    finally { native.releaseProtectedDirectoryGuard(guard.guard); }
    assert.equal(await op.reconcile({ observation: { ...binding().after, targetManifestSha256: targetDigest },
      reportSha256: sha("post-crash-readback") }), "applied");
  } finally { op.close(); }
});
