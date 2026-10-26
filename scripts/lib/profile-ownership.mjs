// In-memory ownership bookkeeping only. Supplied names are transient inputs,
// never a filesystem authority, complete enumeration, copy list or migration plan.
export const PROFILE_OWNERSHIP_SCHEMA = "usage-monitor-profile-ownership-review-v1";
export const PROFILE_OWNERSHIP_MAX_ENTRIES = 8192;
export const PROFILE_OWNERSHIP_MAX_PATH_BYTES = 2 * 1024 * 1024;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const ORDINAL = "(?:0|[1-9][0-9]{0,9})";
const SESSION_CHILD = new RegExp(`^desktop-settings/x-sessions/${UUID}/`, "u");
const FAMILIES = Object.freeze({
  layout: "native_tree_review",
  index: "cold_database_and_original_salt",
  collector: "cold_database_and_collector_semantics",
  retained: "retained_state_review",
  companion: "companion_state_review",
  timing: "timing_identity_conversion",
  settings: "settings_conversion",
  background: "background_references_and_bytes",
  x_reader: "x_cache_and_session_references",
  x_session: "encrypted_session_cold_restart",
  x_import: "helper_and_external_registry_binding",
  diagnostics: "local_diagnostic_review",
  chromium: "chromium_origin_and_encryption_review",
});
// Fixed names are a tool-side review catalog, not a second production path API.
// Source-parity tests bind them to current owners; unknown predecessors remain
// unknown and preserved, never guessed from the current layout.
const fixed = new Map();
function add(owner, kind, paths) {
  for (const path of paths) fixed.set(path.toLowerCase(), { owner, kind });
}
add("layout", "directory", ["companion-state", "companion-state/private", "desktop-settings", "desktop-settings/x-reader",
  "desktop-settings/x-sessions", "desktop-settings/x-import", "desktop-settings/x-diagnostics", "startup-diagnostics"]);
add("index", "file", ["companion-state/local-index-store-v1.sqlite", "companion-state/local-unified-index-device-salt-v1"]);
add("collector", "file", ["companion-state/local-collector-state-v1.sqlite"]);
add("retained", "file", ["companion-state/local-unified-index-v1.sqlite", "companion-state/export-participant-secret",
  "companion-state/private/contribution-sync-v0.1.sqlite3", "companion-state/private/automatic-contribution-v0.1.json",
  "companion-state/private/incremental-contribution-sync-v1.json", "companion-state/contribution-device-binding-v1.json",
  "companion-state/contribution-device-renewal-v1.json", "companion-state/accountless-installation-credential-v1.bin",
  "companion-state/.accountless-installation-credential-v1.journal", "desktop-settings/accountless-sharing-v1.json"]);
add("companion", "file", ["companion-state/account-observation-operation.lock", "companion-state/private/automatic-contribution-v0.1.lock",
  "companion-state/private/authoritative-dashboard-snapshot-v1.json", "companion-state/private/codex-speed-baseline-v0.1.json",
  "companion-state/work-usage-snapshot.json", "companion-state/diagnostics-v0.1.log"]);
add("settings", "file", ["desktop-settings/desktop-settings-v1.json", "desktop-settings/desktop-first-run-v1.json",
  "desktop-settings/desktop-notification-policy-v1.json", "desktop-settings/automatic-refresh-cadence-v1.json",
  "desktop-settings/update-preferences-v1.json"]);
add("background", "file", ["desktop-settings/window-background-v1.json", "desktop-settings/window-background-import-v1.json",
  "desktop-settings/window-background-picker-v1.json"]);
add("x_reader", "file", ["desktop-settings/x-reader/x-reader-v1.json", "desktop-settings/x-reader/x-reader-pending-v1.json",
  "desktop-settings/x-reader/x-session-registry-v1.json", "desktop-settings/x-reader/x-state-operation.lock"]);
add("x_import", "file", ["desktop-settings/x-import/manifest.json", "desktop-settings/x-import/popup.html",
  "desktop-settings/x-import/popup.js", "desktop-settings/x-import/UsageMonitorXImport.exe", "desktop-settings/x-import/native-host.json"]);
add("diagnostics", "file", ["startup-diagnostics/startup-diagnostic-v1.json", "desktop-settings/x-diagnostics/x-errors-v1.json"]);
const dynamic = [
  { pattern: new RegExp(`^desktop-settings/background-${UUID}-${ORDINAL}\\.bin$`, "u"), owner: "background", kind: "file" },
  { pattern: new RegExp(`^desktop-settings/x-reader/x-cache-${UUID}-${ORDINAL}\\.bin$`, "u"), owner: "x_reader", kind: "file" },
  { pattern: new RegExp(`^desktop-settings/x-reader/x-session-checkpoint-${UUID}\\.json$`, "u"), owner: "x_reader", kind: "file" },
  { pattern: new RegExp(`^desktop-settings/x-sessions/${UUID}$`, "u"), owner: "x_session", kind: "directory" },
];
const errors = new WeakSet();
function fail(category) {
  const error = Object.assign(new Error("Profile ownership review refused"), { code: `PROFILE_OWNERSHIP_${category}` });
  errors.add(error); throw error;
}
export function classifyProfileOwnershipFailure(error) {
  return errors.has(error) ? error.code : "PROFILE_OWNERSHIP_UNAVAILABLE";
}
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length
    && keys.every(key => Object.hasOwn(descriptors[key] ?? {}, "value"));
}
function validPath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 4096
    && !/[\\\u0000-\u001f\u007f:*?"<>|]/u.test(path)
    && path.split("/").length <= 32
    && path.split("/").every(part => part.length > 0 && part.length <= 240 && part !== "." && part !== ".."
      && !/[. ]$/u.test(part) && !/^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(part));
}
function classify(path) {
  const lower = path.toLowerCase(), known = fixed.get(lower);
  if (known) return known;
  const sidecar = lower.match(/^(.*)(-wal|-shm|-journal)$/u);
  if (sidecar) {
    const database = fixed.get(sidecar[1]);
    if (database && /\.sqlite(?:3)?$/u.test(sidecar[1])) return { owner: database.owner, kind: "file", sidecar: true };
  }
  for (const rule of dynamic) if (rule.pattern.test(path)) return rule;
  // An opaque subtree is attributed only to its owning subsystem. Nothing
  // beneath these roots is admitted for copying, parsing or format conversion.
  if (lower === "chromium" || lower.startsWith("chromium/")) return { owner: "chromium", kind: lower === "chromium" ? "directory" : null };
  if (lower === "companion-state/inference-timing-v2" || lower.startsWith("companion-state/inference-timing-v2/")) {
    return { owner: "timing", kind: lower === "companion-state/inference-timing-v2" ? "directory" : null };
  }
  if (SESSION_CHILD.test(path)) return { owner: "x_session", kind: null };
  return null;
}

/** No path, dynamic ID, content or path digest is returned. All results remain
 * blocked: native completeness, root identity, ACL/link evidence, reference
 * closure, physical preservation and writer exclusion are NOT inputs here. */
export function reviewProfileOwnership(options) {
  if (!exact(options, ["layout", "entries"]) || options.layout !== "pinned_profile") fail("CONFIGURATION_INVALID");
  const { entries } = options;
  if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype
      || entries.length > PROFILE_OWNERSHIP_MAX_ENTRIES
      || Reflect.ownKeys(entries).length !== entries.length + 1) fail("ENTRIES_INVALID");
  const tree = new Map();
  let pathBytes = 0;
  for (let index = 0; index < entries.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(entries, index);
    if (!Object.hasOwn(descriptor ?? {}, "value") || !exact(descriptor.value, ["relativePath", "kind"])) fail("ENTRY_INVALID");
    const { relativePath, kind } = descriptor.value;
    if (!validPath(relativePath) || !["file", "directory", "reparse", "other"].includes(kind)) fail("ENTRY_INVALID");
    pathBytes += Buffer.byteLength(relativePath);
    if (pathBytes > PROFILE_OWNERSHIP_MAX_PATH_BYTES) fail("PATH_BUDGET_EXCEEDED");
    const lower = relativePath.toLowerCase();
    if (tree.has(lower)) fail("PATH_COLLISION");
    tree.set(lower, { path: relativePath, kind });
  }
  for (const [lower] of tree) {
    const slash = lower.lastIndexOf("/");
    if (slash >= 0 && tree.get(lower.slice(0, slash))?.kind !== "directory") fail("TREE_INVALID");
  }
  const owners = new Map(), problems = new Map();
  const problem = code => problems.set(code, (problems.get(code) ?? 0) + 1);
  for (const { path, kind } of tree.values()) {
    if (kind === "reparse" || kind === "other") problem("unsafe_entry");
    const rule = classify(path);
    if (!rule) { problem("unknown_entry"); continue; }
    if (rule.kind !== null && kind !== rule.kind) problem("entry_type_mismatch");
    if (rule.sidecar) problem("database_sidecar_requires_cold_review");
    const row = owners.get(rule.owner) ?? { owner: rule.owner, entries: 0, files: 0, directories: 0, review: FAMILIES[rule.owner] };
    row.entries++;
    if (kind === "file") row.files++;
    if (kind === "directory") row.directories++;
    owners.set(rule.owner, row);
  }
  return Object.freeze({ schemaVersion: PROFILE_OWNERSHIP_SCHEMA, status: "blocked", scope: "supplied_entries_only",
    entries: tree.size,
    owners: Object.freeze([...owners.values()].sort((left, right) => left.owner < right.owner ? -1 : 1).map(Object.freeze)),
    blockers: Object.freeze([
      ...[...problems].sort(([left], [right]) => left < right ? -1 : 1).map(([code, entries]) => Object.freeze({ code, entries })),
      ...["native_enumeration_unverified", "root_and_file_security_unverified", "writer_exclusion_unverified",
        "reference_and_content_checks_unverified", "external_bindings_unverified", "backup_and_recovery_unverified"]
        .map(code => Object.freeze({ code })),
    ]),
  });
}
