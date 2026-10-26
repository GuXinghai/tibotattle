import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  classifyProfileCutoverOperationFailure, openProfileCutoverOperation,
} from "../scripts/lib/profile-cutover-operation.mjs";
import { identityDigest, openOperation, readOperation } from "../scripts/lib/release-operation.mjs";
import { createProfileCutoverJournal, encodeProfileCutoverJournal, PROFILE_CUTOVER_JOURNAL_SCHEMA } from "../scripts/lib/profile-cutover-state.mjs";
import { loadWindowsReleaseOperationBinding } from "../src/platform/index.js";

const sha = name => createHash("sha256").update(`synthetic:${name}`).digest("hex");
const binding = () => ({ operationId: "00000000-0000-4000-8000-000000000001", profile: "development",
  sourceManifestSha256: sha("source"), sourceRootIdentitySha256: sha("source-root"),
  backupRootIdentitySha256: sha("backup-root"), targetRootIdentitySha256: sha("target-root"),
  toolSha256: sha("tool"), candidateSha256: sha("candidate") });
const preflightEvidence = { preflightReportSha256: sha("preflight") };
const category = code => error => classifyProfileCutoverOperationFailure(error) === `PROFILE_CUTOVER_${code}`;
const nextRequest = operation => ({ previousSha256: operation.journal.events.at(-1).sha256, phase: "backed_up",
  evidence: { sourceManifestSha256: sha("source"), backupManifestSha256: sha("backup"), readbackReportSha256: sha("readback") } });

async function fixture(t) {
  // This dedicated, disposable synthetic root never selects a real profile.
  const native = loadWindowsReleaseOperationBinding();
  // Do not repair ACLs on an existing shared test-temp directory. Native
  // creation gives this test's new root its protected DACL from the start.
  const root = resolve(".release-build", `profile-cutover-test-${randomUUID()}`);
  native.ensureDirectory(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { native, root, options: { directory: join(root, "journal"), binding: binding(), preflightEvidence } };
}

test("native protected storage persists and reopens only the supplied synthetic journal evidence", async t => {
  const { native, options } = await fixture(t);
  const operation = await openProfileCutoverOperation(options);
  const command = nextRequest(operation);
  let saved;
  try {
    saved = await operation.advance(command);
    assert.equal(saved.events.at(-1).phase, "backed_up");
    for (const name of ["", "operation.json", "mutex.sqlite", "mutex.sqlite-journal"]) {
      const facts = native.inspectPath(join(options.directory, name));
      assert.equal(facts.ownerMatches, true); assert.equal(facts.daclProtected, true);
      assert.equal(facts.nonOwnerAllow, false); assert.equal(facts.broadAccess, false);
      assert.equal(facts.isReparsePoint, false); assert.equal(facts.identity.linkCount, 1);
    }
    assert.equal((await readOperation(options.directory)).kind, "maintenance");
    await assert.rejects(openProfileCutoverOperation({ ...options, resume: true }), category("STORAGE_BUSY"));
  } finally { operation.close(); }
  await assert.rejects(openProfileCutoverOperation(options), category("RESUME_REQUIRED"));
  const resumed = await openProfileCutoverOperation({ ...options, resume: true });
  try {
    const bytes = await readFile(join(options.directory, "operation.json"));
    assert.deepEqual(resumed.journal, saved);
    assert.deepEqual(await resumed.advance(command), saved);
    assert.deepEqual(await readFile(join(options.directory, "operation.json")), bytes, "exact retry writes nothing");
    assert.deepEqual(resumed.summary(), { schemaVersion: PROFILE_CUTOVER_JOURNAL_SCHEMA,
      phase: "backed_up", events: 2, scope: "journal_contract_only", persistence: "settled" });
  } finally { resumed.close(); }
  resumed.close();
  await assert.rejects(resumed.advance(command), category("OPERATION_CLOSED"));
});

test("resume requires the original operation, artifact and preflight binding", async t => {
  const { options } = await fixture(t);
  const operation = await openProfileCutoverOperation(options); operation.close();
  for (const change of [
    { binding: { ...binding(), candidateSha256: sha("other-candidate") } },
    { binding: { ...binding(), sourceManifestSha256: sha("other-source") } },
    { preflightEvidence: { preflightReportSha256: sha("other-preflight") } },
  ]) {
    await assert.rejects(openProfileCutoverOperation({ ...options, ...change, resume: true }), category("BINDING_MISMATCH"));
  }
  const resumed = await openProfileCutoverOperation({ ...options, resume: true }); resumed.close();
});

test("crash window after operation creation only initializes the exact bound prepared journal", async t => {
  const { options } = await fixture(t);
  const storageBinding = { contract: PROFILE_CUTOVER_JOURNAL_SCHEMA, binding: binding(), preflightEvidence };
  const raw = await openOperation({ directory: options.directory, kind: "maintenance", binding: storageBinding });
  assert.deepEqual(raw.record.state, {}); raw.close();
  assert.equal((await readOperation(options.directory)).binding, identityDigest(storageBinding));
  const resumed = await openProfileCutoverOperation({ ...options, resume: true });
  try {
    assert.deepEqual(resumed.journal, createProfileCutoverJournal(binding(), preflightEvidence));
    assert.equal(resumed.journal.events.length, 1);
  } finally { resumed.close(); }
});

test("foreign state cannot be reinitialized or silently overwritten", async t => {
  const { options } = await fixture(t);
  const raw = await openOperation({ directory: options.directory, kind: "maintenance",
    binding: { contract: PROFILE_CUTOVER_JOURNAL_SCHEMA, binding: binding(), preflightEvidence } });
  await raw.save({ unexpectedState: "synthetic" }); raw.close();
  const before = await readFile(join(options.directory, "operation.json"));
  await assert.rejects(openProfileCutoverOperation({ ...options, resume: true }), category("STORAGE_STATE_INVALID"));
  assert.deepEqual(await readFile(join(options.directory, "operation.json")), before);
});

test("journal preparation must match the preflight evidence bound before storage creation", async t => {
  const { options } = await fixture(t);
  const raw = await openOperation({ directory: options.directory, kind: "maintenance",
    binding: { contract: PROFILE_CUTOVER_JOURNAL_SCHEMA, binding: binding(), preflightEvidence } });
  const different = createProfileCutoverJournal(binding(), { preflightReportSha256: sha("unbound-preflight") });
  await raw.save({ journalText: encodeProfileCutoverJournal(different, binding()) }); raw.close();
  const before = await readFile(join(options.directory, "operation.json"));
  await assert.rejects(openProfileCutoverOperation({ ...options, resume: true }), category("STORAGE_STATE_INVALID"));
  assert.deepEqual(await readFile(join(options.directory, "operation.json")), before);
});

test("invalid configuration refuses before native storage access", async () => {
  for (const directory of ["", ".", "relative/journal", "C:\\", "\\journal", "C:\\synthetic\\..\\journal", "C:\\synthetic\0journal"]) {
    await assert.rejects(openProfileCutoverOperation({ directory, binding: binding(), preflightEvidence }), category("CONFIGURATION_INVALID"));
  }
  await assert.rejects(openProfileCutoverOperation(), category("CONFIGURATION_INVALID"));
  await assert.rejects(openProfileCutoverOperation({ directory: "C:\\synthetic\\journal", binding: binding(), preflightEvidence, copy: true }), category("CONFIGURATION_INVALID"));
  let called = false;
  const options = { binding: binding(), preflightEvidence, get directory() { called = true; return "C:\\synthetic\\journal"; } };
  await assert.rejects(openProfileCutoverOperation(options), category("CONFIGURATION_INVALID"));
  assert.equal(called, false);
});

test("an uncertain save blocks further mutation until the durable journal is reopened", async t => {
  const { native, options } = await fixture(t);
  const operation = await openProfileCutoverOperation(options);
  const path = join(options.directory, "operation.json"), before = operation.journal;
  const command = nextRequest(operation);
  try {
    const bytes = await readFile(path);
    // Substitute only this test's own receipt. Expected-identity replacement
    // must refuse even though its contents and DACL are unchanged.
    await rm(path); native.createFile(path, bytes);
    await assert.rejects(operation.advance(command), category("PERSISTENCE_UNCERTAIN"));
    assert.throws(() => operation.journal, category("PERSISTENCE_UNCERTAIN"));
    assert.equal(operation.summary().persistence, "uncertain", "stale in-memory state is not presented as settled");
    await assert.rejects(operation.advance(command), category("PERSISTENCE_UNCERTAIN"));
    assert.deepEqual(await readFile(path), bytes);
  } finally { operation.close(); }
  const resumed = await openProfileCutoverOperation({ ...options, resume: true });
  try { assert.deepEqual(resumed.journal, before); await resumed.advance(nextRequest(resumed)); }
  finally { resumed.close(); }
});

test("concurrent calls cannot branch the in-memory journal or close its active save", async t => {
  const { options } = await fixture(t);
  const operation = await openProfileCutoverOperation(options);
  try {
    const command = nextRequest(operation), pending = operation.advance(command);
    assert.equal(operation.summary().persistence, "saving");
    assert.throws(() => operation.close(), category("OPERATION_BUSY"));
    await assert.rejects(operation.advance(command), category("OPERATION_BUSY"));
    await pending;
    assert.equal(operation.summary().persistence, "settled");
    assert.equal(operation.journal.events.length, 2);
    await assert.rejects(operation.advance({ ...command, binding: binding() }), category("REQUEST_INVALID"));
  } finally { operation.close(); }
});

test("owned child-process termination retains the last acknowledged cutover state", { timeout: 20_000 }, async t => {
  const { options } = await fixture(t);
  const moduleURL = new URL("../scripts/lib/profile-cutover-operation.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { openProfileCutoverOperation } from ${JSON.stringify(moduleURL)};
    const operation = await openProfileCutoverOperation(JSON.parse(process.argv[1]));
    process.stdout.write("ready\\n");
    setInterval(() => {}, 1000);
  `, JSON.stringify(options)], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  // Never forward child stderr: even a native failure must remain content-free.
  child.stderr.resume();
  await new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Synthetic cutover child readiness timeout")), 10_000);
    const failed = () => { clearTimeout(timer); reject(new Error("Synthetic cutover child unavailable")); };
    child.once("error", failed); child.once("exit", failed);
    child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => {
      output += chunk;
      if (output.includes("ready\n")) { clearTimeout(timer); resolveReady(); }
    });
  });
  await assert.rejects(openProfileCutoverOperation({ ...options, resume: true }), category("STORAGE_BUSY"));
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  const resumed = await openProfileCutoverOperation({ ...options, resume: true });
  try {
    assert.equal(resumed.journal.events.at(-1).phase, "prepared");
    assert.equal(resumed.journal.events.length, 1);
    await resumed.advance(nextRequest(resumed));
  } finally { resumed.close(); }
});
