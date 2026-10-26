import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import test from "node:test";
import { classifyUsageStateBundleFailure, selectUsageStateBundle, USAGE_STATE_BUNDLE_MAX_ENTRIES,
  USAGE_STATE_BUNDLE_MAX_PATH_BYTES, USAGE_STATE_CONTROL_INPUTS } from "../scripts/lib/usage-state-bundle.mjs";
import { localCompanionStatePaths } from "../src/local-installation-diagnostics.js";
import { legacyLocalCollectorStatePaths } from "../src/local-collector-state.js";

const scope = "a".repeat(64);
const primary = `inference-timing-v2/source-${scope}/timing-experiment.sqlite`;
const supplement = `inference-timing-tool-free-v1/source-${scope}/timing-experiment.sqlite`;
function tree(files = [], directories = []) {
  const result = new Map();
  for (const [name, kind] of [...files.map(name => [name, "file"]), ...directories.map(name => [name, "directory"])]) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) result.set(parts.slice(0, i).join("/"), "directory");
    result.set(name, kind);
  }
  return [...result].map(([relativePath, kind]) => ({ relativePath, kind }));
}
const select = files => selectUsageStateBundle({ entries: tree(files) });
const issue = (result, code) => result.summary.blockers.find(item => item.code === code);
const refusal = code => error => classifyUsageStateBundleFailure(error) === `USAGE_STATE_BUNDLE_${code}`;
const required = ["local-index-store-v1.sqlite", "local-unified-index-device-salt-v1", "local-collector-state-v1.sqlite"];

test("bundle separates unchanged bytes, dated evidence, timing conversion and legacy review", () => {
  const result = select([...required, "private/codex-speed-baseline-v0.1.json", "work-usage-snapshot.json",
    "private/authoritative-dashboard-snapshot-v1.json", primary, supplement, "local-unified-index-v1.sqlite"]);
  const actions = result.privateSelection.map(row => row.action);
  assert.equal(actions.filter(action => action === "preserve_bytes").length, 4);
  assert.equal(actions.filter(action => action === "retain_dated_evidence").length, 2);
  assert.equal(actions.filter(action => action === "timing_conversion_review").length, 2);
  assert.ok(issue(result, "legacy_preservation_review"));
  assert.equal(issue(result, "required_state_unobserved"), undefined);
  assert.equal(issue(result, "unknown_usage_dependency"), undefined);
  assert.equal(result.summary.status, "blocked");
});

test("every current companion path and legacy collector dependency has an explicit treatment", () => {
  const root = "C:\\synthetic\\state";
  const paths = localCompanionStatePaths(root);
  const legacy = legacyLocalCollectorStatePaths(paths.collectorStateFile);
  const files = [...new Set([...Object.values(paths), ...Object.values(legacy).flat()])]
    .map(path => win32.relative(root, path).replaceAll("\\", "/"));
  assert.equal(issue(select(files), "unknown_usage_dependency"), undefined);
});

test("workload comparison anchor and capacity history are unchanged usage state", () => {
  const selected = select([...required, "private/overview-workload-state.json"]);
  assert.equal(issue(selected, "unknown_usage_dependency"), undefined);
  assert.equal(selected.privateSelection.find(row => row.relativePath === "private/overview-workload-state.json").action, "preserve_bytes");
});

test("timing siblings and source-bound snapshots stay in scope without assuming identity continuity", async () => {
  const controller = await readFile(new URL("../apps/local/model-performance-controller.js", import.meta.url), "utf8");
  const worker = await readFile(new URL("../apps/local/model-performance-worker.js", import.meta.url), "utf8");
  const filesystem = await readFile(new URL("../src/platform/inference-timing-filesystem.js", import.meta.url), "utf8");
  const snapshots = await readFile(new URL("../apps/local/model-performance-snapshots.js", import.meta.url), "utf8");
  assert.ok(controller.includes('`source-${sourceScope}`'));
  assert.ok(worker.includes("'inference-timing-tool-free-v1'"));
  assert.ok(filesystem.includes("'timing-experiment.sqlite'"));
  assert.ok(snapshots.includes('`model-performance-snapshot-v6-${source}.json`'));
  const result = select([primary, supplement, `inference-timing-v2/model-performance-snapshot-v6-${scope}.json`,
    "inference-timing-v2/model-performance-snapshot.json", "inference-timing-v2/timing-experiment.sqlite"]);
  assert.equal(result.privateSelection.length, 5);
  assert.equal(issue(result, "unknown_usage_dependency"), undefined);
  assert.ok(issue(result, "timing_conversion_review"));
});

test("legacy pointers, immutable snapshots and unfinished transactions require review, never replay", () => {
  const result = select(["local-unified-index-v1.sqlite.current", `local-unified-index-v1.sqlite.snapshot-abc-${"b".repeat(32)}`,
    "collector-checkpoint-v0.3.json.batch-journal"]);
  assert.equal(result.privateSelection.length, 3);
  assert.ok(result.privateSelection.every(row => row.action === "legacy_preservation_review"));
});

test("the dated recovery bundle is exact opaque evidence; partial and broadened trees block", () => {
  const root = "overview-recovery-20261015";
  const names = ["local-index-before-workload-v5.sqlite", "local-index-before-workload-v5.sqlite-wal",
    "local-index-before-workload-v5.sqlite-shm", "private-acl-repair-v1.json", "private-acl-inheritance-v1.json", "private-acl-backup-v1.json"];
  const files = names.map(name => `${root}/${name}`), result = select(files);
  assert.equal(issue(result, "unknown_usage_dependency"), undefined);
  assert.equal(issue(result, "historical_recovery_bundle_incomplete"), undefined);
  assert.equal(result.privateSelection.length, 6);
  assert.ok(result.privateSelection.every(row => row.action === "legacy_preservation_review"));
  for (let index = 0; index < files.length; index++) assert.ok(issue(select(files.filter((_, i) => i !== index)), "historical_recovery_bundle_incomplete"));
  for (const extra of [`${root}/extra.json`, `${root}/nested/private-acl-repair-v1.json`, "overview-recovery-20261016/private-acl-repair-v1.json"])
    assert.ok(issue(select([...files, extra]), "unknown_usage_dependency"));
  assert.equal(issue(select([...files].reverse()), "historical_recovery_bundle_incomplete"), undefined);
});

test("the v5 producer filename is dated evidence without broadening snapshot discovery", () => {
  const name = `inference-timing-v2/model-performance-snapshot-${scope}.json`;
  const result = select([name]);
  assert.equal(result.privateSelection[0].action, "retain_dated_evidence");
  assert.equal(issue(result, "unknown_usage_dependency"), undefined);
  for (const near of [`private/model-performance-snapshot-${scope}.json`, name.replace(scope, "a".repeat(63)), name.replace("snapshot-", "snapshot-v5-")])
    assert.ok(issue(select([near]), "unknown_usage_dependency"));
});

test("source controls are field-level inputs; pause and primary-root structure are not defaulted", async () => {
  assert.deepEqual(USAGE_STATE_CONTROL_INPUTS[0].fields, ["codexHomes", "refreshPaused", "refreshIntervalSeconds"]);
  assert.deepEqual(USAGE_STATE_CONTROL_INPUTS[1].fields, ["lastAutomaticDetailedAtMs", "reservationToken"]);
  const contract = await readFile(new URL("../apps/electron/desktop-contract.js", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../apps/electron/desktop-runtime.js", import.meta.url), "utf8");
  for (const field of USAGE_STATE_CONTROL_INPUTS[0].fields) assert.ok(contract.includes(field));
  assert.ok(runtime.includes("USAGE_MONITOR_REFRESH_PAUSED"));
  assert.ok(issue(select(required), "source_controls_and_pause_unverified"));
});

test("locks and excluded retired state are never payloads", () => {
  const result = select(["account-observation-operation.lock", "private/automatic-contribution-v0.1.lock", "collector.lock",
    "local-collector-state-v1.sqlite.migration.lock", "export-participant-secret", "accountless-installation-credential-v1.bin",
    ".accountless-installation-credential-v1.journal", "private/contribution-sync-v0.1.sqlite3",
    "private/contribution-sync-v0.1.sqlite3-wal", "private/accountless-performance-sync-state-v1.json", "diagnostics-v0.1.log"]);
  assert.deepEqual(result.privateSelection, []);
  assert.equal(issue(result, "unknown_usage_dependency"), undefined);
});

test("no profile-wide enumeration or X/browser completeness is required", () => {
  const result = select(required);
  assert.equal(issue(result, "unknown_usage_dependency"), undefined);
  assert.ok(!JSON.stringify(result).match(/x_session|chromium|background|external_bindings/iu));
  assert.ok(issue(result, "bundle_writer_exclusion_unverified"));
});

test("only the producer's root diagnostic probe pattern is excluded without cleanup", () => {
  const name = ".onboarding-write-probe-12345678-1234-4123-8123-123456789abc";
  const result = select([...required, name]);
  assert.equal(issue(result, "unknown_usage_dependency"), undefined);
  assert.ok(!result.privateSelection.some(row => row.relativePath === name));
  for (const nearMiss of [name + ".json", name.replace("-4123-", "-3123-"), `private/${name}`])
    assert.ok(issue(select([nearMiss]), "unknown_usage_dependency"));
  for (const kind of ["directory", "reparse", "other"])
    assert.ok(issue(selectUsageStateBundle({ entries: [{ relativePath: name, kind }] }), "entry_type_mismatch"));
});

test("omitted required files remain unobserved, never empty or absent", () => {
  assert.deepEqual(issue(select([]), "required_state_unobserved"), { code: "required_state_unobserved", entries: 3 });
});

test("unknown files, archives and unknown timing descendants block without leaking names", () => {
  for (const name of ["private/private-synthetic-marker.json", "archives", "inference-timing-v2/unreviewed.db",
    "inference-timing-tool-free-v1/private-synthetic-marker", "local-index-store-v1.sqlite.current"]) {
    const result = select([name]);
    assert.ok(issue(result, "unknown_usage_dependency"));
    assert.equal(result.privateSelection.length, 0);
    assert.ok(!JSON.stringify(result.summary).includes(name));
  }
});

test("sidecars require cold preservation review and are not ordinary unchanged payloads", () => {
  for (const name of [required[0], required[2], primary, supplement]) {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const result = select([`${name}${suffix}`]);
      assert.ok(issue(result, "cold_sidecar_review"));
      assert.equal(result.privateSelection[0].action, "cold_sidecar_review");
    }
  }
});

for (const kind of ["directory", "reparse", "other"]) test(`wrong/unsafe kind ${kind} cannot become a payload`, () => {
  const result = selectUsageStateBundle({ entries: [{ relativePath: required[0], kind }] });
  assert.equal(result.privateSelection.length, 0);
  assert.ok(issue(result, "entry_type_mismatch"));
});

for (const path of ["../private", "a/../b", "C:/state", "a\\b", "/absolute", "a//b", "a.", "a ", "NUL.json", "a:b", "a\0b"])
  test(`unsafe lexical input is refused (${JSON.stringify(path)})`, () => {
    assert.throws(() => select([path]), refusal("ENTRY_INVALID"));
  });

test("aliases, malformed trees and sparse arrays refuse", () => {
  assert.throws(() => select([required[0], required[0].toUpperCase()]), refusal("PATH_COLLISION"));
  assert.throws(() => selectUsageStateBundle({ entries: [{ relativePath: "private/a", kind: "file" }] }), refusal("TREE_INVALID"));
  assert.throws(() => selectUsageStateBundle({ entries: new Array(1) }), refusal("ENTRIES_INVALID"));
  assert.throws(() => selectUsageStateBundle({ entries: new Array(USAGE_STATE_BUNDLE_MAX_ENTRIES + 1) }), refusal("ENTRIES_INVALID"));
});

test("closed inputs reject accessors, symbols, claimed completeness and caller error codes", () => {
  const entries = [];
  for (const value of [null, { entries, complete: true }, { entries, [Symbol()]: true },
    Object.defineProperty({}, "entries", { get() { throw new Error("must not execute"); } }), { entries, signal: {} }]) {
    assert.throws(() => selectUsageStateBundle(value), refusal("CONFIGURATION_INVALID"));
  }
  assert.equal(classifyUsageStateBundleFailure({ code: "USAGE_STATE_BUNDLE_CANCELLED" }), "USAGE_STATE_BUNDLE_UNAVAILABLE");
});

test("entry and array accessors are never evaluated and caller inputs stay unchanged", () => {
  let called = false;
  const bad = { get relativePath() { called = true; return required[0]; }, kind: "file" };
  assert.throws(() => selectUsageStateBundle({ entries: [bad] }), refusal("ENTRY_INVALID"));
  const accessorArray = [];
  Object.defineProperty(accessorArray, 0, { get() { called = true; return bad; } });
  assert.throws(() => selectUsageStateBundle({ entries: accessorArray }), refusal("ENTRY_INVALID"));
  assert.equal(called, false);
  const entries = Object.freeze(tree(required).map(Object.freeze));
  const before = JSON.stringify(entries);
  const result = selectUsageStateBundle({ entries });
  assert.equal(JSON.stringify(entries), before);
  assert.throws(() => { result.privateSelection[0].action = "activate"; }, TypeError);
  assert.throws(() => { USAGE_STATE_CONTROL_INPUTS[0].fields.push("appearance"); }, TypeError);
});

test("aggregate byte and entry budgets reject instead of truncating a supplied boundary", () => {
  const entries = Array.from({ length: USAGE_STATE_BUNDLE_MAX_ENTRIES }, (_, i) => ({ relativePath: `unknown-${i}`, kind: "file" }));
  assert.equal(selectUsageStateBundle({ entries }).summary.entries, USAGE_STATE_BUNDLE_MAX_ENTRIES);
  const long = Array.from({ length: 5000 }, (_, i) => ({ relativePath: `${"a".repeat(230)}${i}/${"b".repeat(230)}`, kind: "file" }));
  assert.ok(long.reduce((sum, row) => sum + Buffer.byteLength(row.relativePath), 0) > USAGE_STATE_BUNDLE_MAX_PATH_BYTES);
  assert.throws(() => selectUsageStateBundle({ entries: long }), refusal("PATH_BUDGET_EXCEEDED"));
});

test("cancellation, retry and serialization keep no operation state or activation authority", () => {
  const entries = tree([...required, primary, supplement]);
  const controller = new AbortController(); controller.abort("private-synthetic-marker");
  assert.throws(() => selectUsageStateBundle({ entries, signal: controller.signal }), refusal("CANCELLED"));
  const result = selectUsageStateBundle({ entries });
  assert.deepEqual(result, selectUsageStateBundle({ entries: JSON.parse(JSON.stringify(entries)).reverse() }));
  assert.ok(Object.isFrozen(result.privateSelection[0]));
  assert.ok(Object.isFrozen(result.summary.blockers));
  assert.ok(!JSON.stringify(result.summary).includes(scope));
  assert.ok(issue(result, "durable_intent_and_reconciliation_unimplemented"));
});
