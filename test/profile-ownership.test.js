import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import test from "node:test";
import {
  classifyProfileOwnershipFailure, PROFILE_OWNERSHIP_MAX_ENTRIES,
  PROFILE_OWNERSHIP_MAX_PATH_BYTES, PROFILE_OWNERSHIP_SCHEMA, reviewProfileOwnership,
} from "../scripts/lib/profile-ownership.mjs";
import { localCompanionStatePaths } from "../src/local-installation-diagnostics.js";

const ID = "00000000-0000-4000-8000-000000000001";
const category = code => error => classifyProfileOwnershipFailure(error) === `PROFILE_OWNERSHIP_${code}`;
function tree(files = [], directories = []) {
  const entries = new Map();
  const add = (relativePath, kind) => {
    const parts = relativePath.split("/");
    for (let end = 1; end < parts.length; end++) entries.set(parts.slice(0, end).join("/"), "directory");
    entries.set(relativePath, kind);
  };
  for (const directory of directories) add(directory, "directory");
  for (const file of files) add(file, "file");
  return [...entries].map(([relativePath, kind]) => ({ relativePath, kind }));
}
const review = entries => reviewProfileOwnership({ layout: "pinned_profile", entries });
const owner = (result, name) => result.owners.find(row => row.owner === name);
const issue = (result, code) => result.blockers.find(row => row.code === code);

test("even an empty or entirely known supplied tree cannot prove native enumeration, backup or activation", () => {
  for (const entries of [[], tree(["companion-state/local-index-store-v1.sqlite", "companion-state/local-unified-index-device-salt-v1"])]) {
    const result = review(entries);
    assert.equal(result.schemaVersion, PROFILE_OWNERSHIP_SCHEMA);
    assert.equal(result.scope, "supplied_entries_only"); assert.equal(result.status, "blocked");
    assert.equal(issue(result, "unknown_entry"), undefined);
    for (const code of ["native_enumeration_unverified", "root_and_file_security_unverified", "writer_exclusion_unverified",
      "reference_and_content_checks_unverified", "external_bindings_unverified", "backup_and_recovery_unverified"]) {
      assert.deepEqual(issue(result, code), { code });
    }
  }
});

test("all current companion state paths have an explicit owner, without opening the paths", () => {
  const root = "C:\\synthetic\\state";
  const files = Object.values(localCompanionStatePaths(root)).map(path => `companion-state/${win32.relative(root, path).replaceAll("\\", "/")}`);
  const result = review(tree(files));
  assert.equal(issue(result, "unknown_entry"), undefined);
  assert.equal(owner(result, "index").files, 2);
  assert.equal(owner(result, "collector").files, 1);
  assert.equal(owner(result, "retained").files, 1);
  assert.equal(owner(result, "companion").files, 4);
});

test("companion composition filenames outside the path facade remain explicitly reviewed", async () => {
  const source = await readFile(new URL("../apps/local/server.js", import.meta.url), "utf8");
  for (const name of ["work-usage-snapshot.json", "diagnostics-v0.1.log"]) assert.ok(source.includes(`"${name}"`));
  const result = review(tree(["companion-state/work-usage-snapshot.json", "companion-state/diagnostics-v0.1.log"]));
  assert.equal(owner(result, "companion").files, 2);
  assert.equal(issue(result, "unknown_entry"), undefined);
});

test("reviewed desktop filename constants remain attributed to their source owners", async () => {
  const sources = [
    ["apps/electron/desktop-settings-backends.js", "desktop-settings", "settings"],
    ["apps/electron/desktop-first-run.js", "desktop-settings", "settings"],
    ["apps/electron/desktop-notification-coordinator.js", "desktop-settings", "settings"],
    ["apps/electron/desktop-automatic-refresh-cadence.js", "desktop-settings", "settings"],
    ["apps/electron/desktop-update-preferences.js", "desktop-settings", "settings"],
    ["apps/electron/desktop-background.js", "desktop-settings", "background"],
    ["apps/electron/desktop-x-repository.js", "desktop-settings/x-reader", "x_reader"],
    ["apps/electron/desktop-x-diagnostics.js", "desktop-settings/x-diagnostics", "diagnostics"],
    ["apps/electron/desktop-startup-diagnostics.js", "startup-diagnostics", "diagnostics"],
  ];
  for (const [path, directory, expectedOwner] of sources) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    const names = [...source.matchAll(/(?:const|export const)\s+[A-Z_]+\s*=\s*["']([^"']+\.json)["']/gu)].map(match => match[1]);
    assert.ok(names.length > 0, path);
    const result = review(tree(names.map(name => `${directory}/${name}`)));
    assert.equal(issue(result, "unknown_entry"), undefined, path);
    assert.equal(owner(result, expectedOwner).files, names.length, path);
  }
});

test("X import file ownership stays tied to the installed helper and registry-writing entrypoint", async () => {
  const source = await readFile(new URL("../apps/electron/desktop-x-import.js", import.meta.url), "utf8");
  const declared = source.match(/const FILES = \[([^\]]+)\]/u);
  assert.ok(declared);
  const names = [...declared[1].matchAll(/'([^']+)'/gu)].map(match => match[1]);
  assert.ok(source.includes("upsert('native-host.json'"));
  assert.ok(source.includes("HKCU\\\\Software\\\\Google\\\\Chrome\\\\NativeMessagingHosts"));
  const result = review(tree([...names, "native-host.json"].map(name => `desktop-settings/x-import/${name}`)));
  assert.equal(issue(result, "unknown_entry"), undefined);
  assert.equal(owner(result, "x_import").files, names.length + 1);
  assert.equal(owner(result, "x_import").review, "helper_and_external_registry_binding");
  assert.ok(issue(result, "external_bindings_unverified"));
});

test("opaque Chromium, timing and X session trees are owned but never content-verified", async () => {
  const result = review(tree(["chromium/Local Storage/leveldb/synthetic-private-name.ldb",
    "companion-state/inference-timing-v2/timing-experiment.sqlite",
    `desktop-settings/x-sessions/${ID}/Network/Cookies`, `desktop-settings/x-sessions/${ID}/Local State`]));
  assert.equal(issue(result, "unknown_entry"), undefined);
  for (const [name, requirement] of [["chromium", "chromium_origin_and_encryption_review"],
    ["timing", "timing_identity_conversion"], ["x_session", "encrypted_session_cold_restart"]]) {
    assert.equal(owner(result, name).review, requirement);
  }
  const application = await readFile(new URL("../apps/electron/application-profile.js", import.meta.url), "utf8");
  assert.ok(application.includes('win32.join(userData, "chromium")'));
  const runtime = await readFile(new URL("../apps/electron/desktop-runtime.js", import.meta.url), "utf8");
  for (const name of ["companion-state", "desktop-settings", "x-reader", "x-sessions", "x-import", "x-diagnostics"]) {
    assert.ok(runtime.includes(`"${name}"`), name);
  }
  const companion = await readFile(new URL("../apps/local/server.js", import.meta.url), "utf8");
  assert.ok(companion.includes('join(stateRoot, "inference-timing-v2")'));
});

test("background and X dynamic chunk/checkpoint names are attributed without treating references as checked", async () => {
  const files = [`desktop-settings/background-${ID}-0.bin`, `desktop-settings/background-${ID}-123.bin`,
    `desktop-settings/x-reader/x-cache-${ID}-0.bin`, `desktop-settings/x-reader/x-session-checkpoint-${ID}.json`];
  const result = review(tree(files));
  assert.equal(owner(result, "background").files, 2);
  assert.equal(owner(result, "x_reader").files, 2);
  assert.ok(issue(result, "reference_and_content_checks_unverified"));
  for (const [sourcePath, markers] of [
    ["apps/electron/desktop-background.js", ["`background-${image.id}-${index}.bin`", '"window-background-import-v1.json"']],
    ["apps/electron/desktop-x-repository.js", ["`x-cache-${record.generation}-${index}.bin`", "`x-session-checkpoint-${sessionId(id)}.json`", "'x-session-registry-v1.json'"]],
  ]) {
    const source = await readFile(new URL(`../${sourcePath}`, import.meta.url), "utf8");
    for (const marker of markers) assert.ok(source.includes(marker), sourcePath);
  }
});

test("near-matching dynamic names, unregistered subtrees and unknown predecessors are not silently admitted", () => {
  const paths = [`desktop-settings/background-${ID}-01.bin`, `desktop-settings/background-${ID}--1.bin`,
    `desktop-settings/background-${ID}-0.bin.old`, `desktop-settings/x-sessions/not-a-session/Network/Cookies`,
    `desktop-settings/x-reader/x-cache-${ID}-1.json`, "companion-state/recovery-20261025/index.sqlite",
    "companion-state/local-contribution-prepared-v0.1/private-receipt.json", "Preferences", "Local State",
    "companion-state/desktop-settings/desktop-settings-v1.json"];
  const entries = tree(paths), result = review(entries);
  assert.ok(issue(result, "unknown_entry").entries >= paths.length);
  assert.equal(result.entries, entries.length);
});

for (const base of ["local-index-store-v1.sqlite", "local-collector-state-v1.sqlite", "local-unified-index-v1.sqlite", "private/contribution-sync-v0.1.sqlite3"]) {
  test(`all sidecars of ${base} require cold review regardless of a supplied file type`, () => {
    const result = review(tree(["-wal", "-shm", "-journal"].map(suffix => `companion-state/${base}${suffix}`)));
    assert.equal(issue(result, "database_sidecar_requires_cold_review").entries, 3);
    assert.equal(issue(result, "unknown_entry"), undefined);
    assert.equal(result.status, "blocked");
  });
}

test("retained choices, salt and credential records receive no deletion or credential-access policy", () => {
  const result = review(tree(["companion-state/export-participant-secret", "companion-state/accountless-installation-credential-v1.bin",
    "companion-state/.accountless-installation-credential-v1.journal", "desktop-settings/accountless-sharing-v1.json"]));
  assert.equal(owner(result, "retained").files, 4);
  assert.equal(owner(result, "retained").review, "retained_state_review");
  assert.doesNotMatch(JSON.stringify(result), /delete|rotate|activate|copy|create_credential/u);
});

test("dangerous entry types and known-name type mismatches block instead of being ignored", () => {
  const result = review([{ relativePath: "chromium", kind: "reparse" }, { relativePath: "desktop-settings", kind: "directory" },
    { relativePath: "desktop-settings/desktop-settings-v1.json", kind: "directory" }, { relativePath: "private-sensitive", kind: "other" }]);
  assert.equal(issue(result, "unsafe_entry").entries, 2);
  assert.equal(issue(result, "entry_type_mismatch").entries, 2);
  assert.equal(issue(result, "unknown_entry").entries, 1);
});

test("paths, IDs and private filename fragments never enter results or refusal errors", () => {
  const sentinel = "synthetic-private-sentinel";
  const result = review(tree([`chromium/${sentinel}.ldb`, `desktop-settings/background-${ID}-0.bin`, `unknown-${sentinel}.txt`]));
  for (const privateFragment of [sentinel, ID, "relativePath", "sha256", ".ldb", ".bin", ".txt"]) {
    assert.equal(JSON.stringify(result).includes(privateFragment), false);
  }
  assert.throws(() => review([{ relativePath: `C:\\${sentinel}`, kind: "file" }]), error => {
    assert.equal(error.message, "Profile ownership review refused");
    assert.equal(error.stack.includes(sentinel), false);
    return category("ENTRY_INVALID")(error);
  });
  assert.equal(classifyProfileOwnershipFailure({ code: "PROFILE_OWNERSHIP_ENTRY_INVALID", message: sentinel }), "PROFILE_OWNERSHIP_UNAVAILABLE");
});

test("summary is deterministic, deeply frozen, independent of input order and later input mutation", () => {
  const entries = tree(["desktop-settings/desktop-settings-v1.json", "companion-state/local-index-store-v1.sqlite", "unknown"]);
  const before = structuredClone(entries), result = review(entries);
  assert.deepEqual(entries, before);
  assert.deepEqual(review([...entries].reverse()), result);
  assert.equal(Object.isFrozen(result), true);
  for (const rows of [result.owners, result.blockers]) {
    assert.equal(Object.isFrozen(rows), true);
    for (const row of rows) assert.equal(Object.isFrozen(row), true);
  }
  entries[0].relativePath = "mutated"; entries.length = 0;
  assert.deepEqual(result, review(before));
});

test("closed configuration, entries and arrays reject unknown keys, symbols, getters and holes", () => {
  for (const options of [undefined, null, [], {}, { layout: "legacy_profile", entries: [] },
    { layout: "pinned_profile", entries: [], complete: true }, { layout: "pinned_profile", entries: [], [Symbol()]: true }]) {
    assert.throws(() => reviewProfileOwnership(options), category("CONFIGURATION_INVALID"));
  }
  for (const entries of [null, {}, [undefined], new Array(1), Object.assign([], { extra: true }),
    [{ relativePath: "file", kind: "file", identity: "unverified" }], [{ relativePath: "file", kind: "symlink" }]]) {
    assert.throws(() => review(entries));
  }
  let called = false;
  assert.throws(() => reviewProfileOwnership({ layout: "pinned_profile", get entries() { called = true; return []; } }), category("CONFIGURATION_INVALID"));
  assert.throws(() => review([{ get relativePath() { called = true; return "file"; }, kind: "file" }]), category("ENTRY_INVALID"));
  const entries = [];
  Object.defineProperty(entries, 0, { get() { called = true; return { relativePath: "file", kind: "file" }; } });
  assert.throws(() => review(entries), category("ENTRY_INVALID"));
  assert.equal(called, false);
});

for (const relativePath of ["", "/file", "file/", "file//child", "C:/file", "../file", "a/../b", "./file", "a\\b", "file:stream",
  "file\0", "file\n", "file\x7f", "a*", "a?", 'a"', "a<", "a>", "a|", "file.", "file ", "NUL", "con.json", "COM1.bin", "LPT¹.txt", "CONIN$", "conout$.txt",
  "x".repeat(241), Array(33).fill("a").join("/"), "x".repeat(4097)]) {
  test(`unsafe relative path syntax case ${JSON.stringify(relativePath).slice(0, 48)} refuses content-free`, () => {
    assert.throws(() => review([{ relativePath, kind: "file" }]), category("ENTRY_INVALID"));
  });
}

test("case aliases, exact duplicates, missing parents and non-directory ancestors refuse", () => {
  for (const entries of [[{ relativePath: "file", kind: "file" }, { relativePath: "file", kind: "file" }],
    [{ relativePath: "Chromium", kind: "directory" }, { relativePath: "chromium", kind: "directory" }]]) {
    assert.throws(() => review(entries), category("PATH_COLLISION"));
  }
  for (const entries of [[{ relativePath: "a/b", kind: "file" }], [{ relativePath: "a", kind: "file" }, { relativePath: "a/b", kind: "file" }],
    [{ relativePath: "a", kind: "reparse" }, { relativePath: "a/b", kind: "file" }]]) {
    assert.throws(() => review(entries), category("TREE_INVALID"));
  }
});

test("entry count and aggregate path-byte limits fail closed without truncation", () => {
  assert.equal(review(Array.from({ length: PROFILE_OWNERSHIP_MAX_ENTRIES }, (_, index) => ({ relativePath: `unknown-${index}`, kind: "file" }))).entries,
    PROFILE_OWNERSHIP_MAX_ENTRIES);
  assert.throws(() => review(Array.from({ length: PROFILE_OWNERSHIP_MAX_ENTRIES + 1 }, (_, index) => ({ relativePath: `unknown-${index}`, kind: "file" }))), category("ENTRIES_INVALID"));
  const paths = Array.from({ length: 5000 }, (_, index) => `${"a".repeat(235)}${index}/child-${"b".repeat(230)}`);
  assert.ok(paths.reduce((sum, path) => sum + Buffer.byteLength(path), 0) > PROFILE_OWNERSHIP_MAX_PATH_BYTES);
  assert.throws(() => review(paths.map(relativePath => ({ relativePath, kind: "file" }))), category("PATH_BUDGET_EXCEEDED"));
});
