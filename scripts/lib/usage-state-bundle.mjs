// Tool-side, filesystem-free selection of usage dependencies. This is not a
// manifest, native enumeration, copy permission or physical migration command.
export const USAGE_STATE_BUNDLE_SCHEMA = "usage-monitor-usage-state-bundle-v1";
export const USAGE_STATE_BUNDLE_MAX_ENTRIES = 8192;
export const USAGE_STATE_BUNDLE_MAX_PATH_BYTES = 2 * 1024 * 1024;
// Separate settings inputs: never copy either record wholesale or follow root
// paths. Legacy formats and missing pause evidence require separate review.
export const USAGE_STATE_CONTROL_INPUTS = Object.freeze([
  Object.freeze({ relativePath: "desktop-settings/desktop-settings-v1.json", action: "extract_validated_usage_controls",
    fields: Object.freeze(["codexHomes", "refreshPaused", "refreshIntervalSeconds"]) }),
  Object.freeze({ relativePath: "desktop-settings/automatic-refresh-cadence-v1.json", action: "cadence_reservation_review",
    fields: Object.freeze(["lastAutomaticDetailedAtMs", "reservationToken"]) }),
]);
const definitions = new Map();
// Exact dated usage-recovery bundle produced by the reviewed local ACL journal
// and recovery-copy tools. Opaque evidence only; never an ACL restore input.
const RECOVERY_ROOT = "overview-recovery-20261015";
const RECOVERY_FILES = ["local-index-before-workload-v5.sqlite", "local-index-before-workload-v5.sqlite-wal",
  "local-index-before-workload-v5.sqlite-shm", "private-acl-repair-v1.json", "private-acl-inheritance-v1.json", "private-acl-backup-v1.json"];
function files(action, names) {
  for (const name of names) definitions.set(name, { kind: "file", action });
}
files("preserve_bytes", ["local-index-store-v1.sqlite", "local-unified-index-device-salt-v1",
  "local-collector-state-v1.sqlite", "private/codex-speed-baseline-v0.1.json", "private/overview-workload-state.json"]);
files("retain_dated_evidence", ["work-usage-snapshot.json", "private/authoritative-dashboard-snapshot-v1.json"]);
files("legacy_preservation_review", ["local-unified-index-v1.sqlite", "local-unified-index-v1.sqlite.current",
  "collector-events.jsonl", "collector-events.jsonl.projection-v1.json", "collector-checkpoint-v0.3.json",
  "collector-checkpoint-v0.3.json.batch-journal", "local-replay-safe-accounting-v0.1.json",
  "local-replay-safe-accounting-v0.2.json", "activity-markers-v0.1.jsonl"]);
files("legacy_preservation_review", RECOVERY_FILES.map(name => `${RECOVERY_ROOT}/${name}`));
files("writer_exclusion_only", ["account-observation-operation.lock", "private/automatic-contribution-v0.1.lock",
  "collector.lock", "local-collector-state-v1.sqlite.migration.lock"]);
files("leave_source_untouched", ["diagnostics-v0.1.log", "export-participant-secret",
  "private/accountless-performance-sync-state-v1.json",
  "private/contribution-sync-v0.1.sqlite3", "private/automatic-contribution-v0.1.json",
  "private/incremental-contribution-sync-v1.json", "contribution-device-binding-v1.json",
  "contribution-device-renewal-v1.json", "accountless-installation-credential-v1.bin",
  ".accountless-installation-credential-v1.journal"]);
const TIMING_ROOT = "(?:inference-timing-v2|inference-timing-tool-free-v1)";
const SCOPE = "source-[a-f0-9]{64}";
const timingDirectory = new RegExp(`^${TIMING_ROOT}(?:/${SCOPE})?$`, "u");
const timingDatabase = new RegExp(`^${TIMING_ROOT}(?:/${SCOPE})?/timing-experiment\\.sqlite$`, "u");
const timingSnapshot = /^inference-timing-v2\/model-performance-snapshot(?:-(?:v6-)?[a-f0-9]{64})?\.json$/u;
const legacySnapshot = /^local-unified-index-v1\.sqlite\.snapshot-[0-9a-z]{1,12}-[a-f0-9]{32}$/u;
const errors = new WeakSet();
function fail(category) {
  const error = Object.assign(new Error("Usage-state bundle selection refused"), { code: `USAGE_STATE_BUNDLE_${category}` });
  errors.add(error); throw error;
}
export function classifyUsageStateBundleFailure(error) {
  return errors.has(error) ? error.code : "USAGE_STATE_BUNDLE_UNAVAILABLE";
}
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length
    && keys.every(key => Object.hasOwn(descriptors[key] ?? {}, "value"));
}
function validPath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 4096
    && !/[\\\u0000-\u001f\u007f:*?"<>|]/u.test(path) && path.split("/").length <= 32
    && path.split("/").every(part => part.length > 0 && part.length <= 240 && part !== "." && part !== ".."
      && !/[. ]$/u.test(part) && !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(part));
}
function ruleFor(path) {
  // Diagnostic probe created by stateDirectoryWritable, never usage evidence.
  // Exclusion leaves it in place; this selector never authorizes cleanup.
  if (/^\.onboarding-write-probe-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(path))
    return { kind: "file", action: "leave_source_untouched" };
  if (path === "private" || path === RECOVERY_ROOT) return { kind: "directory", action: "boundary_only" };
  if (timingDirectory.test(path)) return { kind: "directory", action: "boundary_only" };
  if (timingDatabase.test(path)) return { kind: "file", action: "timing_conversion_review" };
  if (timingSnapshot.test(path)) return { kind: "file", action: "retain_dated_evidence" };
  if (legacySnapshot.test(path)) return { kind: "file", action: "legacy_preservation_review" };
  const fixed = definitions.get(path);
  if (fixed) return fixed;
  const sidecar = path.match(/^(.*)(?:-wal|-shm|-journal)$/u);
  if (sidecar && /\.sqlite(?:3)?$/u.test(sidecar[1])) {
    const database = ruleFor(sidecar[1]);
    if (database?.kind === "file") return { kind: "file", action: database.action === "leave_source_untouched"
      ? database.action : "cold_sidecar_review" };
  }
  return null;
}

/** Entries are relative to one explicitly selected companion-state root, NOT
 * a profile. Supply only that boundary, never X/browser/UI trees. Omitted names
 * remain unobserved, not absent. Returned paths are PRIVATE transient operands;
 * only summary is suitable for logs. No target activation list is produced. */
export function selectUsageStateBundle(options) {
  if (!options || !exact(options, Object.hasOwn(options, "signal") ? ["entries", "signal"] : ["entries"])) fail("CONFIGURATION_INVALID");
  const { entries, signal } = options;
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail("CONFIGURATION_INVALID");
  const cancelled = () => { if (signal?.aborted) fail("CANCELLED"); };
  cancelled();
  if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype
      || entries.length > USAGE_STATE_BUNDLE_MAX_ENTRIES
      || Reflect.ownKeys(entries).length !== entries.length + 1) fail("ENTRIES_INVALID");
  const tree = new Map();
  let bytes = 0;
  for (let index = 0; index < entries.length; index++) {
    cancelled();
    const descriptor = Object.getOwnPropertyDescriptor(entries, index);
    if (!Object.hasOwn(descriptor ?? {}, "value") || !exact(descriptor.value, ["relativePath", "kind"])) fail("ENTRY_INVALID");
    const { relativePath, kind } = descriptor.value;
    if (!validPath(relativePath) || !["file", "directory", "reparse", "other"].includes(kind)) fail("ENTRY_INVALID");
    bytes += Buffer.byteLength(relativePath);
    if (bytes > USAGE_STATE_BUNDLE_MAX_PATH_BYTES) fail("PATH_BUDGET_EXCEEDED");
    const lower = relativePath.toLowerCase();
    if (tree.has(lower)) fail("PATH_COLLISION");
    tree.set(lower, { relativePath, kind });
  }
  for (const [path] of tree) {
    const slash = path.lastIndexOf("/");
    if (slash >= 0 && tree.get(path.slice(0, slash))?.kind !== "directory") fail("TREE_INVALID");
  }
  const counts = new Map(), problems = new Map(), selected = [];
  const problem = code => problems.set(code, (problems.get(code) ?? 0) + 1);
  for (const entry of [...tree.values()].sort((a, b) => a.relativePath < b.relativePath ? -1 : 1)) {
    cancelled();
    const rule = ruleFor(entry.relativePath);
    if (entry.kind === "reparse" || entry.kind === "other") problem("unsafe_entry");
    if (!rule) { problem("unknown_usage_dependency"); continue; }
    if (rule.kind !== entry.kind) { problem("entry_type_mismatch"); continue; }
    counts.set(rule.action, (counts.get(rule.action) ?? 0) + 1);
    if (["boundary_only", "leave_source_untouched", "writer_exclusion_only"].includes(rule.action)) continue;
    selected.push(Object.freeze({ ...entry, action: rule.action }));
    if (["legacy_preservation_review", "timing_conversion_review", "cold_sidecar_review"].includes(rule.action)) problem(rule.action);
  }
  for (const name of ["local-index-store-v1.sqlite", "local-unified-index-device-salt-v1", "local-collector-state-v1.sqlite"]) {
    if (!selected.some(entry => entry.relativePath === name && entry.action === "preserve_bytes")) problem("required_state_unobserved");
  }
  if (tree.has(RECOVERY_ROOT) && RECOVERY_FILES.some(name => tree.get(`${RECOVERY_ROOT}/${name}`)?.kind !== "file"))
    problem("historical_recovery_bundle_incomplete");
  const blockers = Object.freeze([
    ...[...problems].sort(([a], [b]) => a < b ? -1 : 1).map(([code, entries]) => Object.freeze({ code, entries })),
    ...["native_boundary_enumeration_unverified", "selected_source_security_unverified", "bundle_writer_exclusion_unverified",
      "source_controls_and_pause_unverified", "account_observation_identity_unverified", "protected_backup_and_semantics_unverified",
      "durable_intent_and_reconciliation_unimplemented", "activation_and_history_preserving_recovery_unverified"]
      .map(code => Object.freeze({ code })),
  ]);
  return Object.freeze({
    privateSelection: Object.freeze(selected),
    summary: Object.freeze({ schemaVersion: USAGE_STATE_BUNDLE_SCHEMA, status: "blocked", scope: "supplied_usage_entries_only",
      entries: tree.size, selected: selected.length,
      actions: Object.freeze([...counts].sort(([a], [b]) => a < b ? -1 : 1).map(([action, entries]) => Object.freeze({ action, entries }))),
      blockers }),
  });
}
