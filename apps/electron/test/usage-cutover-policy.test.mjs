import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createWindowsFilesystemAdapter, createWindowsProtectedStateStore } from "../../../src/platform/index.js";
import { readUsageCutoverStartupPolicy, validateUsageCutoverPolicy,
  USAGE_CUTOVER_POLICY_FILE, USAGE_CUTOVER_POLICY_SCHEMA, USAGE_CUTOVER_POLICY_MAX_BYTES } from "../usage-cutover-policy.js";

const policy = () => ({ schemaVersion: USAGE_CUTOVER_POLICY_SCHEMA, operationId: randomUUID(),
  phase: "activated", observationIdentity: "existing_only" });
const blocked = { code: "electron_shell_usage_cutover_blocked" };

test("cutover policy is closed, immutable and cannot request new observation identity", () => {
  const value = policy(), result = validateUsageCutoverPolicy(value);
  assert.deepEqual(result, value); assert.ok(Object.isFrozen(result));
  value.phase = "prepared"; assert.equal(result.phase, "activated");
  for (const bad of [null, [], Object.create(null), { ...policy(), extra: true },
    { ...policy(), phase: "restoring" }, { ...policy(), operationId: "not-an-operation" },
    { ...policy(), observationIdentity: "create_if_missing" },
    { ...policy(), schemaVersion: "unknown" }, { ...policy(), [Symbol()]: true }])
    assert.throws(() => validateUsageCutoverPolicy(bad), blocked);
  let reads = 0;
  const accessor = policy(); Object.defineProperty(accessor, "phase", { get() { reads++; return "activated"; } });
  assert.throws(() => validateUsageCutoverPolicy(accessor), blocked); assert.equal(reads, 0);
});

test("untrusted state-store lookalikes cannot authorize absence or activation", () => {
  for (const store of [null, {}, { read() { assert.fail("must reject before reading"); } }])
    assert.throws(() => readUsageCutoverStartupPolicy(store), blocked);
});

const gate = { skip: process.platform === "win32" && process.env.USAGE_MONITOR_USAGE_FREEZE_QUALIFICATION === "1"
  ? false : "explicit native Windows qualification required" };
function fixture() {
  const native = createRequire(import.meta.url)(resolve("native/windows-filesystem/build/Release/windows_filesystem.node"));
  const root = resolve(".release-build", `usage-cutover-policy-${randomUUID()}`);
  native.ensureDirectory(root);
  const store = () => createWindowsProtectedStateStore({ adapter: createWindowsFilesystemAdapter(),
    rootPath: root, maxBytes: USAGE_CUTOVER_POLICY_MAX_BYTES });
  return { native, root, store };
}
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("native startup gate preserves prepared intent, blocks retries and survives activation/reopen", gate, () => {
  const { store } = fixture(), first = store();
  assert.equal(readUsageCutoverStartupPolicy(first), null);
  const value = { ...policy(), phase: "prepared" };
  const created = first.createJson(USAGE_CUTOVER_POLICY_FILE, value);
  const before = hash(first.read(USAGE_CUTOVER_POLICY_FILE).data);
  for (let i = 0; i < 3; i++) assert.throws(() => readUsageCutoverStartupPolicy(store()), blocked);
  assert.equal(hash(first.read(USAGE_CUTOVER_POLICY_FILE).data), before);
  first.replaceJson(USAGE_CUTOVER_POLICY_FILE, created.identity, { ...value, phase: "activated" });
  assert.deepEqual(readUsageCutoverStartupPolicy(store()), { ...value, phase: "activated" });
});

test("native startup gate refuses corrupt, duplicate-key, oversized and unknown records without writes", gate, () => {
  const valid = policy();
  for (const bytes of [Buffer.from("{"), Buffer.from([0xff]), Buffer.alloc(2049, 32),
    Buffer.from(JSON.stringify(valid).slice(0, -1) + ',"phase":"activated"}\n'),
    Buffer.from(JSON.stringify({ ...valid, extra: true }) + "\n"),
    Buffer.from(JSON.stringify({ ...valid, schemaVersion: "unknown" }) + "\n"),
    Buffer.from(JSON.stringify(valid))]) {
    const { native, root, store } = fixture();
    native.createFile(resolve(root, USAGE_CUTOVER_POLICY_FILE), bytes);
    const original = hash(bytes);
    for (let i = 0; i < 2; i++) assert.throws(() => readUsageCutoverStartupPolicy(store()), blocked);
    const larger = createWindowsProtectedStateStore({ adapter: createWindowsFilesystemAdapter(), rootPath: root, maxBytes: 4096 });
    assert.equal(hash(larger.read(USAGE_CUTOVER_POLICY_FILE).data), original);
  }
});
