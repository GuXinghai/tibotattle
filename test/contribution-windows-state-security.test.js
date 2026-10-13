import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowsFilesystemAdapter, createOwnerOnlyAutomaticContributionStorageContext } from "../src/platform/index.js";
import { assertWindowsOwnerOnly, grantSyntheticEveryoneRead } from "./helpers/windows-owner-only-fixture.js";

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), "contribution-state-security-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "private");
  createWindowsFilesystemAdapter().ensureDirectory(root);
  return { parent, root, storage: createOwnerOnlyAutomaticContributionStorageContext({
    createError: (code) => Object.assign(new Error("Contribution storage unavailable"), { code }),
  }) };
}

test("Windows settings replace keeps protected DACL and refuses unsafe existing state without repair", async (t) => {
  const { root, storage } = await fixture(t);
  const settingsFile = join(root, "settings.json");
  const options = { settingsFile, maximumBytes: 512 };
  await storage.writeSettingsText({ ...options, text: '{"paused":true}' });
  assertWindowsOwnerOnly(settingsFile);
  await storage.writeSettingsText({ ...options, text: '{"paused":false}' });
  assertWindowsOwnerOnly(settingsFile);
  assert.equal(await storage.readSettingsText(options), '{"paused":false}');
  grantSyntheticEveryoneRead(settingsFile);
  const before = await readFile(settingsFile);
  await assert.rejects(storage.readSettingsText(options), { code: "settings_unavailable" });
  await assert.rejects(storage.writeSettingsText({ ...options, text: '{}' }), { code: "settings_unavailable" });
  assert.deepEqual(await readFile(settingsFile), before);
  assert.equal(createWindowsFilesystemAdapter().inspectPath(settingsFile).broadAccess, true);
});

test("Windows instance locks remain owner-only, recover only explicit dead owners and reject replacements", async (t) => {
  const { root, storage } = await fixture(t);
  const lockFile = join(root, "instance.json");
  const options = { lockFile, maximumBytes: 512 };
  const first = await storage.acquireInstanceLock(options);
  assertWindowsOwnerOnly(lockFile);
  await assert.rejects(storage.acquireInstanceLock({ ...options, processIsAlive: () => true }), { code: "instance_active" });
  const second = await storage.acquireInstanceLock({ ...options, processIsAlive: () => false });
  assertWindowsOwnerOnly(lockFile);
  await assert.rejects(first.release(), { code: "instance_lock_unavailable" });
  const changed = JSON.parse(await readFile(lockFile, "utf8"));
  changed.nonce = "22222222-2222-4222-8222-222222222222";
  await writeFile(lockFile, JSON.stringify(changed));
  await assert.rejects(second.release(), { code: "instance_lock_unavailable" });
  assertWindowsOwnerOnly(lockFile);
});

test("Windows settings reads do not create missing roots or accept an inherited temp root", async (t) => {
  const { parent, storage } = await fixture(t);
  assert.equal(await storage.readSettingsText({ settingsFile: join(parent, "absent", "state.json"), maximumBytes: 512 }), null);
  await assert.rejects(readFile(join(parent, "absent", "state.json")), { code: "ENOENT" });
  await assert.rejects(storage.writeSettingsText({ settingsFile: join(parent, "state.json"), maximumBytes: 512, text: '{}' }), { code: "settings_unavailable" });
});
