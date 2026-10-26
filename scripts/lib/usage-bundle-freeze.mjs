import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { win32, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { loadWindowsLegacyStateReadBinding } from "../../src/platform/index.js";
import { stableJson } from "../../src/export/canonical-json.js";
import { openOperation } from "./release-operation.mjs";
import { selectUsageStateBundle } from "./usage-state-bundle.mjs";
import { LOCAL_INDEX_STORE_APPLICATION_ID, LOCAL_INDEX_STORE_USER_VERSION, LOCAL_INDEX_STORE_FAMILY } from "../../src/local-index-store.js";
import { LOCAL_COLLECTOR_STATE_SCHEMA_VERSION } from "../../src/local-collector-state.js";

// Explicit qualification adapter only: no production selector, profile
// discovery, real-state CLI, credential access or process termination.
const adapters = new WeakMap(), errors = new WeakSet();
const CONTRACT = "usage-monitor-usage-bundle-freeze-qualification-v4";
const MAX_BYTES = 8 * 1024 ** 3, MAX_JOURNAL = 768 * 1024;
// A persistent SQLite close failure pins the whole live barrier until exit.
// Neither GC nor another verifier may release it or retry in that process.
const failedSqliteClosures = new Set();
const CORE_DATABASES = Object.freeze({
  "local-index-store-v1.sqlite": { application: LOCAL_INDEX_STORE_APPLICATION_ID, version: LOCAL_INDEX_STORE_USER_VERSION,
    marker: "SELECT value AS marker FROM meta WHERE key='family'", value: LOCAL_INDEX_STORE_FAMILY,
    tables: ["source", "usage_event", "quota_occurrence", "work_lifecycle_fact", "store_state", "commit_log"] },
  "local-collector-state-v1.sqlite": { application: 0x554d4353, version: 1,
    marker: "SELECT value_json AS marker FROM meta WHERE key='schema_version'", value: JSON.stringify(LOCAL_COLLECTOR_STATE_SCHEMA_VERSION),
    tables: ["records", "meta", "instance_locks"] },
});
const TIMING_SOURCE_COLUMNS = ["id", "digest", "fingerprint", "cursor", "snapshot", "state", "revision", "telemetry_revision", "parser_version", "replay_parser_version", "rebuild_kind"];
const TIMING_TURN_COLUMNS = ["key", "source", "offset", "at", "model", "effort", "tokens", "reasoning", "duration", "ttft", "responses", "covered", "quality", "sample_tokens", "sample_reasoning", "sample_duration", "sample_responses", "sample_total_responses", "sample_method", "turn_duration", "speed_mode", "speed_mode_source", "api_service_tier"];
const SOURCE_FILES = ["native/windows-filesystem/binding.gyp", "native/windows-filesystem/windows-filesystem.cc", "native/windows-filesystem/usage-freeze.inc"];
const METHODS = ["openUsageFreezeDirectory", "reopenUsageFreezeDirectory", "openUsageFreezeChildDirectory",
  "openUsageFreezeParentDirectory", "reopenUsageFreezeParentDirectory", "sealUsageFreezeParentDirectory",
  "openLegacyUsageFreezeParentDirectory", "reopenLegacyUsageFreezeParentDirectory", "readUsageFreezeDirectorySecurity",
  "inspectUsageFreezeSourcePolicy",
  "openUsageFreezeSnapshotFile", "reopenUsageFreezeSnapshotFile",
  "reopenUsageFreezeChildDirectory", "openUsageFreezeChildFile", "reopenUsageFreezeChildFile", "applyUsageDirectoryFreeze",
  "restoreUsageDirectoryFreeze", "closeUsageFreezeDirectory", "listUsageFreezeChildren", "usageFreezeObjectState", "borrowUsageFrozenObjectFile", "borrowUsageFrozenDirectory"];
const sha = value => createHash("sha256").update(value).digest("hex");
function fail(code) { const error = Object.assign(new Error("Usage bundle freeze refused"), { code: `USAGE_BUNDLE_FREEZE_${code}` }); errors.add(error); throw error; }
export const classifyUsageBundleFreezeFailure = error => errors.has(error) ? error.code : "USAGE_BUNDLE_FREEZE_UNAVAILABLE";
function exact(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));
}
function identity(value) {
  if (!exact(value, ["volumeSerialNumber", "fileId", "linkCount"]) || typeof value.volumeSerialNumber !== "string" || typeof value.fileId !== "string"
      || !/^[a-f0-9]{16}$/u.test(value.volumeSerialNumber)
      || !/^[a-f0-9]{32}$/u.test(value.fileId) || value.linkCount !== 1) fail("IDENTITY_INVALID");
  return Object.freeze({ ...value });
}
function root(value) {
  if (typeof value !== "string" || value.includes("\0") || !/^[A-Za-z]:[\\/]$/u.test(win32.parse(value).root)
      || value.split(/[\\/]/u).some(part => part === "." || part === "..") || win32.resolve(value) === win32.parse(value).root) fail("ROOT_INVALID");
  return win32.resolve(value);
}
function contains(a, b) { const child = win32.relative(a, b); return !child || !win32.isAbsolute(child) && child !== ".." && !child.startsWith("..\\"); }
const sameID = (a, b) => a.volumeSerialNumber === b.volumeSerialNumber && a.fileId === b.fileId;
const CONTROL_NAMES = ["desktop-settings-v1.json", "automatic-refresh-cadence-v1.json"];
const recoveryArchive = "overview-recovery-20261015";
const allowedDirectory = path => path === "private" || path === recoveryArchive || /^(?:inference-timing-v2|inference-timing-tool-free-v1)(?:\/source-[a-f0-9]{64})?$/u.test(path);
const snapshotFile = path => /^inference-timing-v2\/model-performance-snapshot(?:-v6-[a-f0-9]{64})?\.json$/u.test(path);
function frozen(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); } return value;
}

export async function loadUsageFreezeQualificationAdapter(options = {}) {
  if (!exact(options, [])) fail("CONFIGURATION_INVALID");
  const directory = resolve(".release-build/usage-freeze-native-v1");
  const receipt = JSON.parse(await readFile(resolve(directory, "source-binding.json"), "utf8"));
  if (receipt.node !== "26.2.0" || receipt.qualificationOnly !== true || receipt.productionSafe !== false
      || receipt.pathWalkRaceSafe !== false || !Array.isArray(receipt.sources) || receipt.sources.length !== SOURCE_FILES.length
      || new Set(receipt.sources.map(source => source.path)).size !== SOURCE_FILES.length) fail("BINDING_INVALID");
  for (const source of receipt.sources) {
    if (!SOURCE_FILES.includes(source.path) || sha(await readFile(source.path)) !== source.sha256) fail("BINDING_INVALID");
  }
  const bindingPath = resolve(directory, "native/windows-filesystem/build/Release/windows_filesystem.node");
  if (sha(await readFile(bindingPath)) !== receipt.bindingSha256) fail("BINDING_INVALID");
  const native = loadWindowsLegacyStateReadBinding({ bindingPath });
  if (native.usageFreezeQualificationContractVersion !== "windows-usage-directory-freeze-qualification-v1"
      || native.productionSafe !== false || native.pathWalkRaceSafe !== false || !METHODS.every(name => typeof native[name] === "function")) fail("BINDING_INVALID");
  const adapter = Object.freeze({ scope: "isolated_native_qualification_only" }); adapters.set(adapter, Object.freeze({ native, bindingPath })); return adapter;
}

/** Read-only native metadata binding, not a source acceptance or freeze. */
export function preflightUsageSourceAcl(options) {
  if (!options || !exact(options, ["sourceRoot", "maintenanceParent", "adapter"])) fail("CONFIGURATION_INVALID");
  const source = root(options.sourceRoot), parent = root(options.maintenanceParent), native = adapters.get(options.adapter)?.native;
  if (!native || win32.dirname(source).toLowerCase() !== parent.toLowerCase()) fail("CONFIGURATION_INVALID");
  let parentGuard, sourceGuard, security, sourceSecurity;
  try {
    parentGuard = native.acquireLegacyStateDirectoryGuard(parent);
    sourceGuard = native.acquireLegacyStateDirectoryGuard(source);
    security = native.readUsageFreezeDirectorySecurity(parentGuard.guard);
    sourceSecurity = native.readUsageFreezeDirectorySecurity(sourceGuard.guard);
    const policies = native.inspectUsageFreezeSourcePolicy(security, sourceSecurity);
    return Object.freeze({ privateBinding: frozen({ expectedSourceIdentity: identity(sourceGuard.identity),
      expectedParentIdentity: identity(parentGuard.identity), expectedParentSecuritySha256: sha(security) }),
      summary: Object.freeze({ status: "source_acl_metadata_bound", directories: 2, directoryPolicies: Object.freeze(policies), sourceFiles: "not_yet_verified",
        stateContentsRead: false, permissionsChanged: false }) });
  } catch (error) { if (errors.has(error)) throw error; fail("SOURCE_METADATA_UNAVAILABLE"); }
  finally {
    security?.fill(0);
    sourceSecurity?.fill(0);
    if (sourceGuard) native.releaseProtectedDirectoryGuard(sourceGuard.guard);
    if (parentGuard) native.releaseProtectedDirectoryGuard(parentGuard.guard);
  }
}

function validState(state) {
  if (!exact(state, ["schemaVersion", "status", "entries"]) || state.schemaVersion !== CONTRACT
      || !["prepared", "acquiring", "frozen", "restoring", "permissions_restored"].includes(state.status)
      || !Array.isArray(state.entries) || state.entries.length > 256) fail("JOURNAL_INVALID");
  for (const [index, row] of state.entries.entries()) {
    if (!exact(row, ["relativePath", "parent", "kind", "identity", "originalSecurity", "frozenSecurity", "phase"])) fail("JOURNAL_INVALID");
    const controls = row?.kind === "controls_directory" || row?.kind === "controls_file";
    if (!exact(row, ["relativePath", "parent", "kind", "identity", "originalSecurity", "frozenSecurity", "phase"])
        || typeof row.relativePath !== "string" || row.relativePath.length > 4096
        || row.relativePath.split("/").some(part => part === ".." || part === "." || /[\\:\u0000]/u.test(part))
        || !["file", "directory", "maintenance_parent", "controls_directory", "controls_file"].includes(row.kind) || !["intent", "frozen", "restored"].includes(row.phase)
        || (index === 0 ? row.relativePath !== "" || row.parent !== null || row.kind !== "maintenance_parent"
          : index === 1 ? row.relativePath !== "" || row.parent !== 0 || row.kind !== "directory"
            : controls ? row.kind === "controls_directory" ? row.parent !== 0 || row.relativePath !== "desktop-settings"
              : !Number.isInteger(row.parent) || row.parent < 2 || row.parent >= index || state.entries[row.parent].kind !== "controls_directory"
                || !CONTROL_NAMES.some(name => row.relativePath === `desktop-settings/${name}`)
              : !Number.isInteger(row.parent) || row.parent < 1 || row.parent >= index || state.entries[row.parent].kind !== "directory")) fail("JOURNAL_INVALID");
    if (index > 1 && !controls && (row.relativePath === "" || row.relativePath.slice(0, Math.max(0, row.relativePath.lastIndexOf("/"))) !== state.entries[row.parent].relativePath)) fail("JOURNAL_INVALID");
    if (row.kind === "directory" && index > 1 && !allowedDirectory(row.relativePath)) fail("JOURNAL_INVALID");
    if (row.kind === "file") {
      const parts = row.relativePath.split("/"), supplied = parts.slice(0, -1).map((_, i) => ({ relativePath: parts.slice(0, i + 1).join("/"), kind: "directory" }));
      const review = selectUsageStateBundle({ entries: [...supplied, { relativePath: row.relativePath, kind: "file" }] });
      if (!review.privateSelection.some(item => item.relativePath === row.relativePath)) fail("JOURNAL_INVALID");
    }
    identity(row.identity);
    for (const name of ["originalSecurity", "frozenSecurity"]) {
      if (typeof row[name] !== "string" || row[name].length < 28 || row[name].length > 88000
          || Buffer.from(row[name], "base64").toString("base64") !== row[name]) fail("JOURNAL_INVALID");
    }
  }
  if (Buffer.byteLength(stableJson(state)) > MAX_JOURNAL) fail("JOURNAL_TOO_LARGE");
  return frozen(structuredClone(state));
}

/** Native selected-companion boundary qualification. All writes here affect
 * only temporary ACLs and the explicit owner-private journal. No backup,
 * conversion, activation or cleanup is implied by a frozen status. */
export async function openUsageBundleFreezeQualification(options) {
  const keys = ["sourceRoot", "maintenanceParent", "journalRoot", "expectedSourceIdentity", "expectedParentIdentity", "operationId", "adapter"];
  if (options) for (const key of ["resume", "sourceAclPolicy", "expectedParentSecuritySha256"]) if (Object.hasOwn(options, key)) keys.push(key);
  if (!options || !exact(options, keys)) fail("CONFIGURATION_INVALID");
  const source = root(options.sourceRoot), parent = root(options.maintenanceParent), journalRoot = root(options.journalRoot), selectedAdapter = adapters.get(options.adapter), native = selectedAdapter?.native;
  const expected = identity(options.expectedSourceIdentity), expectedParent = identity(options.expectedParentIdentity), resume = options.resume ?? false;
  const sourceAclPolicy = Object.hasOwn(options, "sourceAclPolicy") ? options.sourceAclPolicy : "owner_only", expectedSecurity = options.expectedParentSecuritySha256 ?? null;
  const snapshotLegacy = sourceAclPolicy === "preserve_legacy_usage_snapshot_v1";
  const legacy = snapshotLegacy || sourceAclPolicy === "preserve_legacy_usage_v1";
  if (!["owner_only", "preserve_legacy_usage_v1", "preserve_legacy_usage_snapshot_v1"].includes(sourceAclPolicy)
      || (legacy ? typeof expectedSecurity !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSecurity) : Object.hasOwn(options, "expectedParentSecuritySha256"))) fail("CONFIGURATION_INVALID");
  if (!native || typeof resume !== "boolean" || typeof options.operationId !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(options.operationId)) fail("CONFIGURATION_INVALID");
  if (win32.dirname(source).toLowerCase() !== parent.toLowerCase()
      || contains(parent, journalRoot) || contains(journalRoot, parent)) fail("ROOT_COLLISION");
  const operationTag = createHash("sha256").update(`usage-freeze-operation-v1\0${options.operationId}`).digest().subarray(0, 16);
  let operation, journalGuard, sourceGuard, parentGuard, parentSecurity, sourceSecurity;
  try {
    // Journal root must already exist and be private. Native identity/ancestor
    // comparison precedes journal creation, including alternate path aliases.
    sourceGuard = native.acquireLegacyStateDirectoryGuard(source);
    parentGuard = native.acquireLegacyStateDirectoryGuard(parent);
    if (legacy) {
      parentSecurity = native.readUsageFreezeDirectorySecurity(parentGuard.guard);
      sourceSecurity = native.readUsageFreezeDirectorySecurity(sourceGuard.guard);
      if (!resume && sha(parentSecurity) !== expectedSecurity) fail("SOURCE_POLICY_CHANGED");
      if (!resume && !native.inspectUsageFreezeSourcePolicy(parentSecurity, sourceSecurity).preserveLegacyUsage) fail("SOURCE_POLICY_REFUSED");
    }
    journalGuard = native.acquireProtectedDirectoryGuard(journalRoot);
    if (!sameID(sourceGuard.identity, expected) || !sameID(parentGuard.identity, expectedParent)
        || !native.legacyStateRootsDisjoint(parentGuard.guard, journalGuard.guard)) fail("ROOT_COLLISION_OR_IDENTITY");
    operation = await openOperation({ directory: journalRoot, kind: "maintenance", resume, bindingPath: selectedAdapter.bindingPath,
      binding: { contract: CONTRACT, operationId: options.operationId, sourcePathSha256: sha(source.toLowerCase()), sourceIdentity: expected,
        parentPathSha256: sha(parent.toLowerCase()), parentIdentity: expectedParent, sourceAclPolicy, expectedParentSecuritySha256: expectedSecurity } });
  } catch (error) {
    if (journalGuard) native.releaseProtectedDirectoryGuard(journalGuard.guard);
    if (errors.has(error)) throw error; fail("STORAGE_UNAVAILABLE");
  } finally {
    if (sourceGuard) native.releaseProtectedDirectoryGuard(sourceGuard.guard);
    if (parentGuard) native.releaseProtectedDirectoryGuard(parentGuard.guard);
  }
  let state, closed = false, uncertain = false, busy = false;
  const live = new Map(), unrecorded = new Set();
  try {
    if (Object.keys(operation.record.state).length === 0) {
      state = validState({ schemaVersion: CONTRACT, status: "prepared", entries: [] }); await operation.save(state);
    } else state = validState(operation.record.state);
    if (state.entries.length && !sameID(state.entries[0].identity, expectedParent)
        || state.entries.length > 1 && !sameID(state.entries[1].identity, expected)) fail("JOURNAL_INVALID");
    if (legacy && sha(state.entries.length ? Buffer.from(state.entries[0].originalSecurity, "base64") : parentSecurity) !== expectedSecurity) fail("JOURNAL_SOURCE_POLICY_MISMATCH");
    if (legacy && !native.inspectUsageFreezeSourcePolicy(state.entries.length ? Buffer.from(state.entries[0].originalSecurity, "base64") : parentSecurity,
      state.entries.length > 1 ? Buffer.from(state.entries[1].originalSecurity, "base64") : sourceSecurity).preserveLegacyUsage) fail("JOURNAL_SOURCE_POLICY_MISMATCH");
  } catch { try { operation.close(); } finally { native.releaseProtectedDirectoryGuard(journalGuard.guard); } fail("JOURNAL_INVALID_OR_UNAVAILABLE"); }
  const active = () => { if (failedSqliteClosures.size) fail("SQLITE_CLOSE_FAILED"); if (closed) fail("CLOSED"); if (uncertain) fail("PERSISTENCE_UNCERTAIN"); if (busy) fail("BUSY"); };
  async function save(next) {
    const selected = validState(next);
    if (stableJson(selected) === stableJson(state)) return;
    try { await operation.save(selected); state = selected; }
    catch { uncertain = true; fail("PERSISTENCE_UNCERTAIN"); }
  }
  async function record(object, relativePath, parent, kind, cancelled) {
    unrecorded.add(object);
    const row = { relativePath, parent, kind, identity: identity(object.identity),
      originalSecurity: object.originalSecurity.toString("base64"), frozenSecurity: object.frozenSecurity.toString("base64"), phase: "intent" };
    const index = state.entries.length;
    await save({ ...state, status: "acquiring", entries: [...state.entries, row] });
    live.set(index, object); unrecorded.delete(object);
    await setImmediate(); cancelled();
    native.applyUsageDirectoryFreeze(object.lease);
    if (kind === "maintenance_parent") native.sealUsageFreezeParentDirectory(object.lease);
    await save({ ...state, entries: state.entries.map((entry, i) => i === index ? { ...entry, phase: "frozen" } : entry) });
    return index;
  }
  async function reopenAll() {
    for (const [index, row] of state.entries.entries()) {
      if (live.has(index)) continue;
      const object = index === 0 ? native[legacy ? "reopenLegacyUsageFreezeParentDirectory" : "reopenUsageFreezeParentDirectory"](parent, row.identity, Buffer.from(row.originalSecurity, "base64"), operationTag)
        : native[["directory", "controls_directory"].includes(row.kind) ? "reopenUsageFreezeChildDirectory"
          : snapshotLegacy && row.kind === "file" && snapshotFile(row.relativePath) ? "reopenUsageFreezeSnapshotFile" : "reopenUsageFreezeChildFile"](
          live.get(row.parent).lease, index === 1 ? win32.basename(source) : row.relativePath.slice(row.relativePath.lastIndexOf("/") + 1), row.identity, Buffer.from(row.originalSecurity, "base64"));
      if (object.frozenSecurity.toString("base64") !== row.frozenSecurity) { native.closeUsageFreezeDirectory(object.lease); fail("JOURNAL_ACL_MISMATCH"); }
      live.set(index, object);
      if (index === 0 && native.usageFreezeObjectState(object.lease) === "frozen") native.sealUsageFreezeParentDirectory(object.lease);
    }
  }
  const session = Object.freeze({
    summary() { return Object.freeze({ schemaVersion: CONTRACT, scope: "isolated_native_qualification_only", status: state.status,
      objects: state.entries.length, heldObjects: live.size, persistence: uncertain ? "uncertain" : closed ? "closed" : busy ? "working" : "settled",
      controls: state.entries.filter(row => row.kind === "controls_file" && row.phase === "frozen").length === 2 ? "frozen" : "not_established",
      sourceAclPolicy,
      productionAcceptance: "not_established" }); },
    async freeze({ signal } = {}) {
      active(); if (signal !== undefined && !(signal instanceof AbortSignal)) fail("CONFIGURATION_INVALID");
      const cancelled = () => { if (signal?.aborted) fail("CANCELLED"); }; cancelled();
      if (state.status !== "prepared" || state.entries.length) fail("EXPLICIT_RECOVERY_REQUIRED");
      busy = true;
      try {
        const parentObject = legacy ? native.openLegacyUsageFreezeParentDirectory(parent, operationTag, parentSecurity)
          : native.openUsageFreezeParentDirectory(parent, operationTag);
        if (!sameID(parentObject.identity, expectedParent)) { native.closeUsageFreezeDirectory(parentObject.lease); fail("SOURCE_IDENTITY_MISMATCH"); }
        await record(parentObject, "", null, "maintenance_parent", cancelled);
        const rootObject = native.openUsageFreezeChildDirectory(parentObject.lease, win32.basename(source), expected);
        await record(rootObject, "", 0, "directory", cancelled);
        const supplied = [], metadata = new Map();
        for (let index = 0; index < state.entries.length; index++) {
          cancelled(); const directory = state.entries[index]; if (directory.kind !== "directory") continue;
          for (const child of native.listUsageFreezeChildren(live.get(index).lease)) {
            const path = directory.relativePath ? `${directory.relativePath}/${child.name}` : child.name;
            supplied.push({ relativePath: path, kind: child.kind }); metadata.set(path, { child, parent: index });
            if (supplied.length > 8192) fail("BOUND_EXCEEDED");
            if (child.kind === "directory" && allowedDirectory(path)) {
              const object = native.openUsageFreezeChildDirectory(live.get(index).lease, child.name, child.identity);
              await record(object, path, index, "directory", cancelled);
            }
          }
        }
        const selection = selectUsageStateBundle({ entries: supplied, signal });
        if (selection.summary.blockers.some(row => ["unknown_usage_dependency", "unsafe_entry", "entry_type_mismatch", "required_state_unobserved", "historical_recovery_bundle_incomplete"].includes(row.code))) fail("SELECTION_BLOCKED");
        for (const file of selection.privateSelection) {
          cancelled(); const { child, parent } = metadata.get(file.relativePath);
          const object = native[snapshotLegacy && snapshotFile(file.relativePath) ? "openUsageFreezeSnapshotFile" : "openUsageFreezeChildFile"](live.get(parent).lease, child.name, child.identity);
          await record(object, file.relativePath, parent, "file", cancelled);
        }
        await save({ ...state, status: "frozen" });
        return selection.summary;
      } catch (error) { if (errors.has(error)) throw error; fail("NATIVE_OR_SELECTION_REFUSED"); }
      finally { busy = false; }
    },
    async reacquire() {
      active(); if (state.status !== "frozen") fail("EXPLICIT_RECOVERY_REQUIRED"); busy = true;
      try { await reopenAll(); if ([...live.values()].some(item => native.usageFreezeObjectState(item.lease) !== "frozen")) fail("BARRIER_NOT_FROZEN"); }
      catch (error) { if (errors.has(error)) throw error; fail("REACQUIRE_REFUSED"); } finally { busy = false; }
    },
    async captureControls(request) {
      active();
      if (!request || !exact(request, Object.hasOwn(request, "signal") ? ["controlsRoot", "expectedIdentity", "signal"] : ["controlsRoot", "expectedIdentity"])
          || request.signal !== undefined && !(request.signal instanceof AbortSignal)) fail("CONFIGURATION_INVALID");
      if (root(request.controlsRoot).toLowerCase() !== win32.join(parent, "desktop-settings").toLowerCase()) fail("CONTROL_BOUNDARY_INVALID");
      const expectedControl = identity(request.expectedIdentity), cancelled = () => { if (request.signal?.aborted) fail("CANCELLED"); };
      cancelled();
      if (state.status !== "frozen" || live.size !== state.entries.length) fail("LIVE_BARRIER_REQUIRED");
      busy = true;
      try {
        if ([...live.values()].some(object => native.usageFreezeObjectState(object.lease) !== "frozen")) fail("BARRIER_NOT_FROZEN");
        const indexes = [], existing = state.entries.filter(row => row.kind.startsWith("controls_"));
        if (existing.length) {
          if (existing.length !== 3 || !sameID(existing[0].identity, expectedControl)) fail("EXPLICIT_RECOVERY_REQUIRED");
          for (const name of CONTROL_NAMES) {
            const index = state.entries.findIndex(row => row.kind === "controls_file" && row.relativePath === `desktop-settings/${name}`);
            if (index < 0 || native.usageFreezeObjectState(live.get(index).lease) !== "frozen") fail("BARRIER_NOT_FROZEN"); indexes.push(index);
          }
        } else {
          const directory = native.openUsageFreezeChildDirectory(live.get(0).lease, "desktop-settings", expectedControl);
          const parentIndex = await record(directory, "desktop-settings", 0, "controls_directory", cancelled);
          const children = native.listUsageFreezeChildren(directory.lease);
          for (const name of CONTROL_NAMES) {
            cancelled(); const child = children.find(row => row.name === name);
            if (!child || child.kind !== "file") fail("CONTROL_EVIDENCE_MISSING");
            const object = native.openUsageFreezeChildFile(directory.lease, name, child.identity);
            indexes.push(await record(object, `desktop-settings/${name}`, parentIndex, "controls_file", cancelled));
          }
          await save({ ...state, status: "frozen" });
        }
        const values = [], hashes = [];
        for (const index of indexes) {
          cancelled(); const borrowed = native.borrowUsageFrozenObjectFile(live.get(index).lease);
          try {
            const before = native.statSourceFile(borrowed);
            if (before.size < 2 || before.size > 1024 ** 2) fail("CONTROL_SIZE_INVALID");
            const bytes = Buffer.alloc(before.size);
            try {
              for (let offset = 0; offset < bytes.length;) {
                cancelled(); const count = Math.min(65536, bytes.length - offset), chunk = native.readSourceFile(borrowed, offset, count);
                if (chunk.length !== count) fail("SHORT_READ"); chunk.copy(bytes, offset); chunk.fill(0); offset += count; await setImmediate();
              }
              if (stableJson(before) !== stableJson(native.statSourceFile(borrowed))) fail("SOURCE_CHANGED");
              hashes.push(sha(bytes)); values.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            } finally { bytes.fill(0); }
          } finally { native.closeSourceFile(borrowed); }
        }
        return Object.freeze({ privateSourceJson: Object.freeze({ settingsJson: values[0], cadenceJson: values[1] }),
          privateInputSha256: Object.freeze(hashes), summary: Object.freeze({ status: "frozen_control_inputs_read", records: 2,
            projection: "separate_version_bound_decoder_required", persistence: "source_not_copied" }) });
      } catch (error) { if (errors.has(error)) throw error; fail("CONTROL_CAPTURE_REFUSED"); }
      finally { busy = false; }
    },
    async snapshot({ signal } = {}) {
      active(); if (state.status !== "frozen" || live.size !== state.entries.length) fail("LIVE_BARRIER_REQUIRED");
      if (signal !== undefined && !(signal instanceof AbortSignal)) fail("CONFIGURATION_INVALID");
      busy = true; const files = []; let total = 0;
      try {
        for (const [index, row] of state.entries.entries()) {
          if (signal?.aborted) fail("CANCELLED");
          if (native.usageFreezeObjectState(live.get(index).lease) !== "frozen") fail("BARRIER_NOT_FROZEN");
          if (row.kind !== "file") continue;
          const borrowed = native.borrowUsageFrozenObjectFile(live.get(index).lease);
          try {
            const before = native.statSourceFile(borrowed), hash = createHash("sha256"); total += before.size;
            if (!Number.isSafeInteger(before.size) || before.size < 0 || total > MAX_BYTES) fail("BYTE_LIMIT_EXCEEDED");
            for (let offset = 0; offset < before.size;) {
              if (signal?.aborted) fail("CANCELLED");
              const count = Math.min(65536, before.size - offset), bytes = native.readSourceFile(borrowed, offset, count);
              if (bytes.length !== count) fail("SHORT_READ"); hash.update(bytes); bytes.fill(0); offset += count; await setImmediate();
            }
            const after = native.statSourceFile(borrowed);
            if (stableJson(before) !== stableJson(after)) fail("SOURCE_CHANGED");
            files.push({ relativePath: row.relativePath, size: before.size, sha256: hash.digest("hex") });
          } finally { native.closeSourceFile(borrowed); }
        }
        files.sort((a, b) => a.relativePath < b.relativePath ? -1 : 1);
        const privateManifest = frozen({ schemaVersion: "usage-monitor-usage-bundle-bytes-v1", files });
        return Object.freeze({ privateManifest, manifestSha256: sha(stableJson(privateManifest)),
          summary: Object.freeze({ status: "frozen_bytes_read", files: files.length, bytes: total, scope: "selected_usage_only" }) });
      } catch (error) { if (errors.has(error)) throw error; fail("SNAPSHOT_REFUSED"); } finally { busy = false; }
    },
    async inspectColdSqlite(request) {
      active();
      const requestKeys = ["timingIdentity"];
      if (Object.hasOwn(request ?? {}, "signal")) requestKeys.push("signal");
      if (Object.hasOwn(request ?? {}, "includeHistoricalTiming")) requestKeys.push("includeHistoricalTiming");
      if (!request || !exact(request, requestKeys)
          || !["legacy", "current"].includes(request.timingIdentity)
          || Object.hasOwn(request, "includeHistoricalTiming") && (request.includeHistoricalTiming !== true || request.timingIdentity !== "legacy")
          || request.signal !== undefined && !(request.signal instanceof AbortSignal)) fail("CONFIGURATION_INVALID");
      const before = await session.snapshot({ signal: request.signal }), databases = [], connections = [];
      const cancelled = () => { if (request.signal?.aborted) fail("CANCELLED"); };
      busy = true;
      try {
        for (const file of before.privateManifest.files) {
          cancelled();
          // This fixed complete archive is frozen and hashed as opaque retained
          // evidence, including original WAL/SHM bytes. No SQLite connection or
          // hot-journal replay is ever allowed for it. Live stores retain the
          // strict cold-sidecar checks below.
          if (file.relativePath.startsWith(`${recoveryArchive}/`)) continue;
          if (/(?:-shm|-wal)$/u.test(file.relativePath) && file.size !== 0) fail("DATABASE_NOT_COLD");
          if (file.relativePath.endsWith("-journal") && file.size !== 0) {
            // PERSIST commits zero the rollback header without truncating the
            // journal. Require the entire 28-byte header to be zero under the
            // frozen barrier, preserving every journal byte; no replay/repair.
            if (file.size < 28) fail("DATABASE_NOT_COLD");
            const index = state.entries.findIndex(row => row.relativePath === file.relativePath);
            const borrowed = native.borrowUsageFrozenObjectFile(live.get(index).lease);
            try {
              const header = native.readSourceFile(borrowed, 0, 28);
              try { if (header.length !== 28 || header.some(byte => byte !== 0)) fail("DATABASE_NOT_COLD"); }
              finally { header.fill(0); }
            } finally { native.closeSourceFile(borrowed); }
          }
        }
        const salt = before.privateManifest.files.find(file => file.relativePath === "local-unified-index-device-salt-v1");
        if (!salt || salt.size < 32 || salt.size > 256) fail("SALT_INVALID");
        const timingKeys = new Map(); let timingBytes = 0, timingRows = 0;
        for (const file of before.privateManifest.files) {
          const core = CORE_DATABASES[file.relativePath], timing = /^(inference-timing-v2|inference-timing-tool-free-v1)\/(?:source-[a-f0-9]{64}\/)?timing-experiment\.sqlite$/u.exec(file.relativePath);
          if (!core && !timing) continue;
          cancelled();
          if (file.size < 100 || file.size > 1024 ** 3) fail("DATABASE_SIZE_INVALID");
          const index = state.entries.findIndex(row => row.kind === "file" && row.relativePath === file.relativePath);
          const borrowed = native.borrowUsageFrozenObjectFile(live.get(index).lease);
          try {
            const header = native.readSourceFile(borrowed, 0, 100);
            try {
              if (header.length !== 100 || header.subarray(0, 16).toString("binary") !== "SQLite format 3\0"
                  || ![1, 2].includes(header[18]) || header[18] !== header[19]) fail("DATABASE_HEADER_INVALID");
            } finally { header.fill(0); }
          } finally { native.closeSourceFile(borrowed); }
          const db = new DatabaseSync(`${pathToFileURL(win32.join(source, file.relativePath)).href}?mode=ro&immutable=1`, { readOnly: true });
          connections.push(db);
          db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-2048; PRAGMA mmap_size=0;");
          db.enableDefensive?.(true);
          const application = db.prepare("PRAGMA application_id").get().application_id, version = db.prepare("PRAGMA user_version").get().user_version;
          const expectedVersion = core?.version ?? (request.timingIdentity === "legacy" ? 10 : 12) + (timing[1] === "inference-timing-tool-free-v1" ? 1 : 0);
          const historicalTiming = !core && request.includeHistoricalTiming === true
            && version === (timing[1] === "inference-timing-tool-free-v1" ? 5 : 4);
          if (application !== (core?.application ?? 0x54425450) || version !== expectedVersion && !historicalTiming) fail("DATABASE_UNSUPPORTED");
          if (historicalTiming) {
            // Known 4/5 physical contract: no parser/rebuild/replay metadata.
            // Inspect it as recorded; never fabricate a historical parser version.
            const names = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
            if (stableJson(names) !== stableJson(["metadata", "source", "turn"])) fail("DATABASE_UNSUPPORTED");
            for (const [table, expected] of [["source", TIMING_SOURCE_COLUMNS.slice(0, 8)], ["turn", TIMING_TURN_COLUMNS]]) {
              const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name).sort();
              if (stableJson(columns) !== stableJson([...expected].sort())) fail("DATABASE_UNSUPPORTED");
            }
          }
          if (core && db.prepare(core.marker).get()?.marker !== core.value) fail("DATABASE_UNSUPPORTED");
          if (db.prepare("PRAGMA quick_check(1)").get()?.quick_check !== "ok" || db.prepare("PRAGMA foreign_key_check").get() !== undefined) fail("DATABASE_INTEGRITY");
          const tables = {};
          const timingTables = historicalTiming ? ["source", "turn"] : ["source", "turn", "parser_replay_turn"];
          for (const table of core?.tables ?? timingTables) {
            const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
            if (!Number.isSafeInteger(count) || count < 0 || !core && count > 100000) fail("COUNTS_INVALID");
            tables[table] = count; cancelled();
          }
          const record = { relativePath: file.relativePath, application, version, tables };
          if (timing) {
            const columns = db.prepare("PRAGMA table_info(metadata)").all().map(row => row.name);
            if (stableJson(columns) !== stableJson(request.timingIdentity === "legacy" ? ["key"] : ["key", "identity_version"])) fail("TIMING_IDENTITY_INVALID");
            const metadata = db.prepare("SELECT * FROM metadata").all();
            if (metadata.length !== 1 || !(metadata[0].key instanceof Uint8Array) || metadata[0].key.length !== 32
                || request.timingIdentity === "current" && metadata[0].identity_version !== "usage-monitor-timing-identity-v1") fail("TIMING_IDENTITY_INVALID");
            const key = Buffer.from(metadata[0].key).toString("hex"), scope = file.relativePath.split("/").slice(1, -1).join("/");
            if (timingKeys.has(scope) && timingKeys.get(scope) !== key) fail("TIMING_CORRELATION_MISMATCH"); timingKeys.set(scope, key);
            const sourceColumns = historicalTiming ? TIMING_SOURCE_COLUMNS.slice(0, 8) : TIMING_SOURCE_COLUMNS;
            for (const table of timingTables) {
              const columns = table === "source" ? sourceColumns : TIMING_TURN_COLUMNS;
              const bytes = db.prepare(`SELECT COALESCE(SUM(${columns.map(name => `COALESCE(length(${name}),0)`).join("+")}),0) AS bytes FROM ${table}`).get().bytes;
              if (!Number.isSafeInteger(bytes) || bytes < 0) fail("TIMING_STATE_TOO_LARGE");
              timingBytes += bytes; timingRows += tables[table];
              if (timingBytes > 32 * 1024 ** 2 || timingRows > 100000) fail("TIMING_STATE_TOO_LARGE");
            }
            const rows = table => db.prepare(`SELECT ${(table === "source" ? sourceColumns : TIMING_TURN_COLUMNS).join(",")} FROM ${table}`).all().map(row => Object.fromEntries(Object.entries(row)
              .map(([name, value]) => [name, value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value])));
            record.timing = { role: timing[1] === "inference-timing-v2" ? "primary" : "supplement", key,
              sources: rows("source"), turns: rows("turn"), replayTurns: historicalTiming ? [] : rows("parser_replay_turn"),
              ...(historicalTiming ? { sourceSchema: version, historicalParserVersion: "not_recorded", replayTable: "absent_in_verified_v4_v5_contract" } : {}) };
          }
          databases.push(record); db.close(); connections.pop();
        }
      } catch (error) { if (errors.has(error)) throw error; fail("SQLITE_INSPECTION_REFUSED"); }
      finally {
        for (const db of [...connections]) { try { db.close(); connections.splice(connections.indexOf(db), 1); } catch { /* pin below */ } }
        busy = false;
        if (connections.length) {
          failedSqliteClosures.add({ connections, session, live, operation, journalGuard });
          fail("SQLITE_CLOSE_FAILED");
        }
      }
      const after = await session.snapshot({ signal: request.signal });
      if (after.manifestSha256 !== before.manifestSha256) fail("SOURCE_CHANGED");
      const retainedRecoveryFiles = before.privateManifest.files.filter(file => file.relativePath.startsWith(`${recoveryArchive}/`)).length;
      return Object.freeze({ privateReport: frozen({ manifestSha256: before.manifestSha256, databases,
        ...(retainedRecoveryFiles ? { recoveryArchive: { files: retainedRecoveryFiles, treatment: "opaque_frozen_bytes_no_sql_or_replay" } } : {}) }),
        summary: Object.freeze({ status: "cold_usage_sqlite_verified", databases: databases.length, timingIdentity: request.timingIdentity,
          accountObservationIdentity: "not_established", historicalCorrectness: "not_established" }) });
    },
    /** Copy the selected bundle into an explicit, pre-created empty skeleton.
     * A reopened operation only reconciles actual files; it never fills gaps.
     * This is backup evidence, not timing/settings conversion or activation. */
    async backup(request) {
      active();
      const keys = ["backupRoot", "expectedBackupIdentity", "intentRoot", "operationId", "mode"];
      if (request) for (const key of ["signal", "payload"]) if (Object.hasOwn(request, key)) keys.push(key);
      if (!request || !exact(request, keys)
          || !["copy", "reconcile"].includes(request.mode)
          || request.payload !== undefined && !["complete_bundle", "unchanged_bytes"].includes(request.payload)
          || typeof request.operationId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(request.operationId)
          || request.signal !== undefined && !(request.signal instanceof AbortSignal)) fail("CONFIGURATION_INVALID");
      const target = root(request.backupRoot), intentRoot = root(request.intentRoot), expectedTarget = identity(request.expectedBackupIdentity);
      for (const [a, b] of [[parent, target], [parent, intentRoot], [target, intentRoot], [journalRoot, target], [journalRoot, intentRoot]]) {
        if (contains(a, b) || contains(b, a)) fail("ROOT_COLLISION");
      }
      const observed = await session.snapshot({ signal: request.signal });
      const before = request.payload !== "unchanged_bytes" ? observed : (() => {
        const privateManifest = frozen({ ...observed.privateManifest, files: observed.privateManifest.files.filter(file =>
          !/^inference-timing-(?:v2|tool-free-v1)\/(?:source-[a-f0-9]{64}\/)?timing-experiment\.sqlite(?:-wal|-shm|-journal)?$/u.test(file.relativePath)) });
        return { privateManifest, manifestSha256: sha(stableJson(privateManifest)) };
      })();
      busy = true;
      const guards = [], held = [];
      let borrowedRoot, targetGuard, intentGuard, backupOperation;
      const cancelled = () => { if (request.signal?.aborted) fail("CANCELLED"); };
      try {
        borrowedRoot = native.borrowUsageFrozenDirectory(live.get(1).lease);
        targetGuard = native.acquireProtectedDirectoryGuard(target); guards.push(targetGuard.guard);
        intentGuard = native.acquireProtectedDirectoryGuard(intentRoot); guards.push(intentGuard.guard);
        if (!sameID(targetGuard.identity, expectedTarget)
            || !native.legacyStateRootsDisjoint(borrowedRoot, targetGuard.guard)
            || !native.legacyStateRootsDisjoint(borrowedRoot, intentGuard.guard)) fail("ROOT_COLLISION_OR_IDENTITY");
        const targetLegacy = native.acquireLegacyStateDirectoryGuard(target); guards.push(targetLegacy.guard);
        if (!native.legacyStateRootsDisjoint(targetLegacy.guard, intentGuard.guard)
            || !native.legacyStateRootsDisjoint(targetLegacy.guard, journalGuard.guard)) fail("ROOT_COLLISION");
        const journalLegacy = native.acquireLegacyStateDirectoryGuard(journalRoot); guards.push(journalLegacy.guard);
        if (!native.legacyStateRootsDisjoint(journalLegacy.guard, intentGuard.guard)) fail("ROOT_COLLISION");
        const directories = new Set([""]);
        for (const file of before.privateManifest.files) {
          const parts = file.relativePath.split("/");
          for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join("/"));
        }
        // No directory creation or ACL repair is hidden in the copy. Each
        // pre-existing protected directory is pinned before its names are read.
        for (const directory of directories) if (directory) {
          const guarded = native.acquireProtectedDirectoryGuard(win32.join(target, directory)); guards.push(guarded.guard);
        }
        const planned = new Map(before.privateManifest.files.map(file => [file.relativePath, file]));
        async function inspectActual() {
          const files = [];
          for (const directory of directories) {
            cancelled();
            for (const entry of await readdir(win32.join(target, directory), { withFileTypes: true })) {
              const path = directory ? `${directory}/${entry.name}` : entry.name;
              if (directories.has(path) && entry.isDirectory() && !entry.isSymbolicLink()) continue;
              if (!planned.has(path) || !entry.isFile() || entry.isSymbolicLink()) fail("BACKUP_UNEXPECTED_ENTRY");
              const inspected = native.inspectProtectedChild(target, targetGuard.identity, path);
              const lease = native.openLegacyStateFile(win32.join(target, path)); held.push(lease);
              const stat = native.statSourceFile(lease), hash = createHash("sha256");
              if (stat.dev !== inspected.identity.volumeSerialNumber || stat.ino !== inspected.identity.fileId || stat.nlink !== 1
                  || stat.size !== planned.get(path).size) fail("BACKUP_BYTES_MISMATCH");
              for (let offset = 0; offset < stat.size;) {
                cancelled(); const count = Math.min(65536, stat.size - offset), bytes = native.readSourceFile(lease, offset, count);
                if (bytes.length !== count) fail("SHORT_READ"); hash.update(bytes); bytes.fill(0); offset += count; await setImmediate();
              }
              if (stableJson(stat) !== stableJson(native.statSourceFile(lease)) || hash.digest("hex") !== planned.get(path).sha256) fail("BACKUP_BYTES_MISMATCH");
              files.push(planned.get(path));
            }
          }
          files.sort((a, b) => a.relativePath < b.relativePath ? -1 : 1);
          return files;
        }
        backupOperation = await openOperation({ directory: intentRoot, kind: "maintenance", resume: request.mode === "reconcile", bindingPath: selectedAdapter.bindingPath,
          binding: { contract: "usage-bundle-byte-backup-qualification-v1", operationId: request.operationId,
            payload: request.payload ?? "complete_bundle",
            sourceIdentity: expected, backupIdentity: expectedTarget, sourcePathSha256: sha(source.toLowerCase()),
            backupPathSha256: sha(target.toLowerCase()), manifest: before.privateManifest } });
        let draft = backupOperation.record.state;
        if (request.mode === "copy") {
          if (Object.keys(draft).length) fail("EXPLICIT_RECOVERY_REQUIRED");
          if ((await inspectActual()).length) fail("TARGET_NOT_EMPTY");
          draft = { status: "intent_durable", completed: [] };
          await backupOperation.save(draft); await setImmediate(); cancelled();
          for (const file of before.privateManifest.files) {
            cancelled();
            const index = state.entries.findIndex(row => row.kind === "file" && row.relativePath === file.relativePath);
            const borrowed = native.borrowUsageFrozenObjectFile(live.get(index).lease);
            try {
              const stat = native.statSourceFile(borrowed);
              if (stat.size > 1024 ** 3) fail("BYTE_LIMIT_EXCEEDED");
              // Fixed native CREATE_NEW copy, fsync and exact-handle readback;
              // no broad continuity copier or inherited preferences/secrets.
              native.copyLegacyStateFile(borrowed, target, targetGuard.identity, file.relativePath);
            } finally { native.closeSourceFile(borrowed); }
            draft = { ...draft, completed: [...draft.completed, file.relativePath] };
            await backupOperation.save(draft); await setImmediate(); cancelled();
          }
        } else if (!exact(draft, ["status", "completed"]) || !["intent_durable", "verified"].includes(draft.status)
            || !Array.isArray(draft.completed) || draft.completed.some((path, i) => path !== before.privateManifest.files[i]?.relativePath)) fail("JOURNAL_INVALID");
        const actual = await inspectActual(), complete = actual.length === planned.size;
        if (draft.status === "verified" && !complete || draft.completed.some(path => !actual.some(file => file.relativePath === path))) fail("BACKUP_ACTUAL_STATE_MISMATCH");
        // An acknowledgement is never used to infer file presence. A partial
        // result remains a preserved interrupted backup and grants no replay.
        if (complete && draft.status !== "verified") await backupOperation.save({ ...draft, status: "verified" });
        const privateManifest = frozen({ schemaVersion: before.privateManifest.schemaVersion, files: actual });
        return Object.freeze({ privateManifest, manifestSha256: sha(stableJson(privateManifest)),
          summary: Object.freeze({ status: complete ? "selected_bytes_verified" : "interrupted_backup_preserved", files: actual.length,
            replay: "never_automatic", sqliteSemantics: "not_verified", productionAcceptance: "not_established" }) });
      } catch (error) { if (errors.has(error)) throw error; fail("BACKUP_REFUSED"); }
      finally {
        for (const lease of held.reverse()) native.closeSourceFile(lease);
        try { backupOperation?.close(); } finally {
          for (const guard of guards.reverse()) native.releaseProtectedDirectoryGuard(guard);
          if (borrowedRoot) native.releaseProtectedDirectoryGuard(borrowedRoot);
          busy = false;
        }
      }
    },
    async restorePermissions() {
      active(); busy = true;
      try {
        for (const object of unrecorded) { native.closeUsageFreezeDirectory(object.lease); unrecorded.delete(object); }
        await reopenAll();
        if (state.status === "permissions_restored") {
          if ([...live.values()].some(object => native.usageFreezeObjectState(object.lease) !== "original")) fail("ACTUAL_STATE_MISMATCH");
          for (const object of [...live.values()].reverse()) native.closeUsageFreezeDirectory(object.lease);
          live.clear(); return;
        }
        await save({ ...state, status: "restoring" });
        for (let index = state.entries.length - 1; index >= 0; index--) {
          const object = live.get(index); native.restoreUsageDirectoryFreeze(object.lease);
          await save({ ...state, entries: state.entries.map((row, i) => i === index ? { ...row, phase: "restored" } : row) });
          native.closeUsageFreezeDirectory(object.lease); live.delete(index);
        }
        await save({ ...state, status: "permissions_restored" });
      } catch (error) { if (errors.has(error)) throw error; fail("RESTORE_REFUSED"); } finally { busy = false; }
    },
    abandon() {
      if (closed) return; if (busy) fail("BUSY");
      if (failedSqliteClosures.size) fail("SQLITE_CLOSE_FAILED");
      for (const object of [...unrecorded, ...[...live.values()].reverse()]) native.closeUsageFreezeDirectory(object.lease);
      unrecorded.clear(); live.clear();
      try { operation.close(); } finally { native.releaseProtectedDirectoryGuard(journalGuard.guard); closed = true; }
      parentSecurity?.fill(0);
      sourceSecurity?.fill(0);
    },
  });
  return session;
}
