import { realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeWorkUsageRepositoryOrigin } from "./work-usage-projects.js";
import { readBoundedUtf8LineEntries } from "./bounded-jsonl-reader.js";
import { compressedRolloutHandle } from "./bounded-rollout-bytes.js";
import { createLocalCodexMetadataFilesystem } from "./local-codex-metadata-filesystem.js";

const CODEX_THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CODEX_SELECTED_ROLLOUT_NAME = new RegExp(
  "^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-"
    + "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    + "(?:_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?"
    + "\\.jsonl(?:\\.zst)?$",
  "iu",
);

/**
 * Read Codex's selected rollout heads from an owner-controlled, non-writable-
 * by-others database without retaining its titles, cwd,
 * prompts, previews or other thread-store content. Failure is a normal null
 * fallback: canonical metadata remains sufficient for accounting, while a
 * selected head only disambiguates which physical generation should provide
 * carried state to a later logical fork.
 */
export async function readCodexSelectedRolloutNames(codexHome, {
  platform = process.platform, loadWindowsBinding, databaseFactory = openMetadataDatabase,
} = {}) {
  const filesystem = createLocalCodexMetadataFilesystem({ platform, loadWindowsBinding });
  if (!await filesystem.validHome(codexHome)) return null;
  const databaseFile = join(codexHome, "state_5.sqlite");
  let database;
  let guard;
  let slot;
  try {
    await retryMetadataDatabaseCloses();
    slot = reserveMetadataDatabaseSlot();
    guard = await filesystem.guardDatabase(databaseFile);
    if (!await guard.validate()) return null;
    database = databaseFactory(guard.databasePath, { readOnly: true, timeout: 2_000 });
    if (!await guard.validate()) return null;
    database.exec("BEGIN");
    const columns = new Set(database.prepare("PRAGMA table_info(threads)")
      .all().map((row) => row.name));
    if (!columns.has("id") || !columns.has("rollout_path")) return null;
    const selected = new Map();
    for (const row of database.prepare(
      "SELECT id, rollout_path FROM threads",
    ).iterate()) {
      if (typeof row.id !== "string"
          || !CODEX_THREAD_ID.test(row.id)
          || typeof row.rollout_path !== "string") {
        continue;
      }
      const selectedName = basename(row.rollout_path);
      if (selectedName.length < 1 || selectedName.length > 255) continue;
      const selectedMatch = CODEX_SELECTED_ROLLOUT_NAME.exec(selectedName);
      if (selectedMatch === null
          || selectedMatch[1].toLowerCase() !== row.id.toLowerCase()) continue;
      selected.set(row.id.toLowerCase(), selectedName);
    }
    return await guard.validate() ? selected : null;
  } catch {
    return null;
  } finally {
    await closeMetadataDatabase(database, guard, slot);
  }
}

const MAX_LOCAL_THREAD_LOOKUPS = 160;
const MAX_CACHE_DROP_THREAD_LOOKUPS = 2_000;
const MAX_SESSION_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_SESSION_INDEX_LINE_BYTES = 64 * 1024;
const MAX_SESSION_INDEX_LINES = 200_000;
const MAX_THREAD_DISPLAY_NAME_LENGTH = 512;
const MAX_AGENT_NICKNAME_LENGTH = 80;
const MAX_THREAD_SOURCE_LENGTH = 4_096;
const MAX_THREAD_SOURCE_CLASS_LENGTH = 80;
const MAX_ROLLOUT_PATH_LENGTH = 4_096;
const MAX_SESSION_METADATA_LINE_BYTES = 64 * 1024;
const AUTO_REVIEW_THREAD_SOURCE = "guardian_review";
const AUTO_REVIEW_SOURCE_KIND = "guardian";
const LOCAL_NAVIGATION_THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function threadId(value) {
  return typeof value === "string" && LOCAL_NAVIGATION_THREAD_ID.test(value)
    ? value.toLowerCase()
    : null;
}

function displayName(value, maximumLength = MAX_THREAD_DISPLAY_NAME_LENGTH) {
  if (typeof value !== "string" || value.length > maximumLength
      || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseThreadSource(value) {
  if (typeof value !== "string" || value.length > MAX_THREAD_SOURCE_LENGTH) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function workerMetadata(source, id) {
  // This is Codex's explicit collaboration ancestry, not rollout-fork lineage
  // or an inferred relationship from timestamps, names, or working directory.
  const spawn = source?.subagent?.thread_spawn;
  if (spawn === null || typeof spawn !== "object" || Array.isArray(spawn)) {
    return null;
  }
  const parentId = threadId(spawn.parent_thread_id);
  return parentId === null || parentId === id ? null : {
    parentId,
    nickname: displayName(spawn.agent_nickname, MAX_AGENT_NICKNAME_LENGTH),
  };
}

function isAutoReviewThreadSource(value) {
  return value === AUTO_REVIEW_THREAD_SOURCE;
}

function isAutoReviewSource(value) {
  return value?.subagent?.other === AUTO_REVIEW_SOURCE_KIND;
}

function isAutoReviewSessionMetadata(record, id) {
  const payload = record?.payload;
  return record?.type === "session_meta"
    && threadId(payload?.id) === id
    && payload?.thread_source === AUTO_REVIEW_THREAD_SOURCE
    && payload?.source?.subagent?.other === AUTO_REVIEW_SOURCE_KIND;
}

function isCodexSessionPath(codexHome, rolloutPath) {
  const path = relative(codexHome, rolloutPath);
  return path.startsWith(`sessions${sep}`);
}

/**
 * Guardian-review records have no parent column in Codex's thread store. Their
 * own first, bounded session-metadata record is the only accepted source for
 * this relationship. Existing metadata callers receive only the parent UUID.
 * The indexed source-only path can also verify ordinary worker/root headers
 * and receives a narrowed relation without retaining the source record.
 */
async function readAutoReviewParent(codexHome, rolloutPath, id, filesystem, usageRelations = false, includeWorker = false, diagnosticTimer = null) {
  if (typeof rolloutPath !== "string" || rolloutPath.length === 0
      || !isAbsolute(rolloutPath)) return null;
  let handle;
  try {
    const home = diagnosticTimer ? await diagnosticTimer.measure("origin_realpath",()=>realpath(codexHome),{aggregate:true}) : await realpath(codexHome);
    let path;
    try { path = diagnosticTimer ? await diagnosticTimer.measure("origin_realpath",()=>realpath(rolloutPath),{aggregate:true}) : await realpath(rolloutPath); }
    catch (error) {
      if (!usageRelations || error.code !== "ENOENT" || !rolloutPath.endsWith(".jsonl")) return null;
      path = diagnosticTimer ? await diagnosticTimer.measure("origin_realpath",()=>realpath(`${rolloutPath}.zst`),{aggregate:true}) : await realpath(`${rolloutPath}.zst`);
    }
    if (!isCodexSessionPath(home, path)
        && !(usageRelations && relative(home, path).startsWith(`archived_sessions${sep}`))) return null;
    const opened = diagnosticTimer ? await diagnosticTimer.measure("origin_open",()=>filesystem.openFile(path),{aggregate:true}) : await filesystem.openFile(path);
    handle = opened.handle;
    const before = opened.before;
    let line;
    const finishRead = diagnosticTimer?.start("origin_read",{aggregate:true});
    if (path.endsWith(".zst")) {
      for await (const entry of readBoundedUtf8LineEntries(compressedRolloutHandle(handle), {
        maximumLineBytes: MAX_SESSION_METADATA_LINE_BYTES,
        maximumTotalBytes: MAX_SESSION_METADATA_LINE_BYTES + 1,
        highWaterMark: 4096,
      })) { line = entry.line; break; }
    } else {
      const bytes = Buffer.alloc(MAX_SESSION_METADATA_LINE_BYTES + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const newline = bytes.subarray(0, bytesRead).indexOf(0x0a);
      if (newline < 0) return null;
      line = bytes.toString("utf8", 0, newline);
    }
    finishRead?.();
    if (typeof line !== "string" || line.includes("\ufffd")) return null;
    const record = diagnosticTimer ? diagnosticTimer.measureSync("origin_parse",()=>JSON.parse(line),{aggregate:true}) : JSON.parse(line);
    const header = record?.type === "session_meta" && threadId(record.payload?.id) === id;
    const worker = includeWorker && header ? workerMetadata(record.payload?.source, id) : null;
    const root = includeWorker && header && (record.payload?.thread_source === "user"
      || ["cli", "exec", "vscode"].includes(record.payload?.source))
      && !record.payload?.source?.subagent;
    const parentId = worker?.parentId ?? threadId(record?.payload?.parent_thread_id);
    const verified = isAutoReviewSessionMetadata(record, id)
      || usageRelations && record?.type === "session_meta" && threadId(record.payload?.id) === id
        && record.payload?.thread_source === "subagent" && isAutoReviewSource(record.payload?.source);
    if ((!verified && !worker && !root) || (!root && (parentId === null || parentId === id))) {
      return null;
    }
    const finishValidate = diagnosticTimer?.start("origin_validate",{aggregate:true});
    const after = await handle.stat();
    const relation = filesystem.same(before, after)
        && before.size === after.size && before.mtimeMs === after.mtimeMs
        && filesystem.same(before, await filesystem.namedStat(path, handle))
      ? includeWorker ? { parentId: root ? null : parentId, origin: verified ? "auto_review" : null } : parentId
      : null;
    finishValidate?.();
    return relation;
  } catch {
    return null;
  } finally {
    if (diagnosticTimer) await diagnosticTimer.measure("origin_close",()=>handle?.close(),{aggregate:true});
    else await handle?.close();
  }
}

// Use retained source paths when an index already has them. This path reads
// bounded headers only and never opens Codex's live SQLite/WAL/SHM files.
async function readSourceUsageRelations(codexHome, ids, sourcePaths, knownThreadIds, filesystem, signal, diagnosticTimer = null) {
  const selected = new Map(), pending = new Set(ids);
  let reads = 0;
  for (const id of pending) {
    signal?.throwIfAborted();
    if (pending.size > 50_000) return new Map();
    const paths = (typeof sourcePaths === "function" ? sourcePaths(id) : sourcePaths.get(id)) ?? [];
    if (!Array.isArray(paths) || paths.length > 32) continue;
    if (paths.length === 0) {
      // An explicit Codex membership authenticates a terminal parent even when
      // that parent's rollout is outside the retained index.
      if (knownThreadIds.has(id)) selected.set(id, { parentId: null, origin: null });
      continue;
    }
    let accepted = null, invalid = false;
    for (const path of paths) {
      if (++reads > 50_000) return new Map();
      const record = await readAutoReviewParent(codexHome, path, id, filesystem, true, true, diagnosticTimer);
      if (!record || accepted && (accepted.parentId !== record.parentId || accepted.origin !== record.origin)) {
        invalid = true; break;
      }
      accepted = record;
    }
    if (invalid || !accepted) continue;
    selected.set(id, accepted);
    if (accepted.parentId) pending.add(accepted.parentId);
  }
  return selected;
}

function boundedTextColumn(columns, name, maximumLength) {
  // Column names are a fixed internal allowlist, never caller-controlled SQL.
  // SQLite length(TEXT) stops at NUL, so independently cap encoded bytes before
  // a value crosses into JavaScript. Four bytes per character preserves UTF-8
  // names; the existing character and control checks still apply afterward.
  return columns.has(name)
    ? `CASE WHEN typeof(${name}) = 'text'
         AND length(CAST(${name} AS BLOB)) <= ${maximumLength * 4}
         AND length(${name}) <= ${maximumLength}
       THEN ${name} ELSE NULL END AS ${name}`
    : `NULL AS ${name}`;
}


function openMetadataDatabase(path, options) { return new DatabaseSync(path, options); }

// A rare failed SQLite close must not let GC finalize its native source leases
// while the connection is still live. Keep the pair until the next bounded
// metadata attempt retries close; a repeated refusal prevents further DB opens.
const pendingMetadataDatabaseCloses = new Set();
const activeMetadataDatabaseSlots = new Set();
const MAX_METADATA_DATABASE_CONNECTIONS = 64;

function reserveMetadataDatabaseSlot() {
  if (activeMetadataDatabaseSlots.size >= MAX_METADATA_DATABASE_CONNECTIONS) {
    throw new Error("local_metadata_unavailable");
  }
  const slot = {};
  activeMetadataDatabaseSlots.add(slot);
  return slot;
}

async function closeMetadataDatabase(database, guard, slot) {
  try {
    if (database?.isOpen) database.close();
    if (database?.isOpen) throw new Error("local_metadata_unavailable");
  } catch {
    if (database?.isOpen) pendingMetadataDatabaseCloses.add({ database, guard, slot });
    else {
      try { await guard?.release(); } catch { /* Keep close errors content-free. */ }
      activeMetadataDatabaseSlots.delete(slot);
    }
    throw new Error("local_metadata_unavailable");
  }
  try { await guard?.release(); }
  catch { throw new Error("local_metadata_unavailable"); }
  finally { activeMetadataDatabaseSlots.delete(slot); }
}

async function retryMetadataDatabaseCloses() {
  for (const pending of pendingMetadataDatabaseCloses) {
    pendingMetadataDatabaseCloses.delete(pending);
    await closeMetadataDatabase(pending.database, pending.guard, pending.slot);
  }
}

function reportOriginDiagnostic(observer, code, count = 1) {
  if (typeof observer !== "function") return;
  try { Promise.resolve(observer(Object.freeze({ code, count }))).catch(() => {}); }
  catch { /* Optional diagnostics never change protected metadata access. */ }
}

async function readSelectedThreadMetadata(codexHome, ids, { ancestryOnly = false, usageRelations = false, allowTitleFallback = false, signal, filesystem, databaseFactory, onOriginDiagnostic = null, withOriginReadReceipt = false, diagnosticTimer = null } = {}) {
  const report = (code, count) => reportOriginDiagnostic(onOriginDiagnostic, code, count);
  const databaseFile = join(codexHome, "state_5.sqlite");
  let database;
  let guard;
  let slot;
  try {
    await retryMetadataDatabaseCloses();
    slot = reserveMetadataDatabaseSlot();
    guard = await filesystem.guardDatabase(databaseFile);
    if (!await guard.validate()) { report("metadata_database_changed"); return new Map(); }
    database = databaseFactory(guard.databasePath, { readOnly: true, timeout: 500 });
    if (!await guard.validate()) { report("metadata_database_changed"); return new Map(); }
    database.exec("BEGIN");
    if (database.prepare(
      "SELECT type FROM sqlite_master WHERE name = 'threads'",
    ).get()?.type !== "table") { report("metadata_schema_unsupported"); return new Map(); }
    const info = database.prepare("PRAGMA table_info(threads)").all();
    if (!info.some((column) => column.name === "id" && column.pk > 0)) {
      report("metadata_schema_unsupported"); return new Map();
    }
    const columns = new Set(info.map((column) => column.name));
    if (!columns.has("source") || !columns.has("thread_source")) report("metadata_origin_columns_missing");
    // Titles may contain opening-message text. Only the owner-approved local
    // Projects & threads display opts into this bounded fallback. Ancestry and
    // other callers keep the existing title-free contract.
    const selected = [
      "id",
      allowTitleFallback && !ancestryOnly && columns.has("title")
        ? `CASE WHEN typeof(title) = 'text' AND instr(title, char(0)) = 0 THEN substr(title, 1, ${MAX_THREAD_DISPLAY_NAME_LENGTH}) ELSE NULL END AS display_title`
        : "NULL AS display_title",
      ancestryOnly ? "NULL AS name" : boundedTextColumn(columns, "name", MAX_THREAD_DISPLAY_NAME_LENGTH),
      ancestryOnly ? "NULL AS agent_nickname" : boundedTextColumn(columns, "agent_nickname", MAX_AGENT_NICKNAME_LENGTH),
      boundedTextColumn(columns, "source", MAX_THREAD_SOURCE_LENGTH),
      boundedTextColumn(columns, "thread_source", MAX_THREAD_SOURCE_CLASS_LENGTH),
      ...(withOriginReadReceipt && columns.has("source") && columns.has("thread_source") ? [
        `CASE WHEN source IS NULL OR (typeof(source) = 'text' AND instr(source, char(0)) = 0 AND length(CAST(source AS BLOB)) <= ${MAX_THREAD_SOURCE_LENGTH * 4} AND length(source) <= ${MAX_THREAD_SOURCE_LENGTH}) THEN 1 ELSE 0 END AS origin_source_valid`,
        `CASE WHEN thread_source IS NULL OR (typeof(thread_source) = 'text' AND instr(thread_source, char(0)) = 0 AND length(CAST(thread_source AS BLOB)) <= ${MAX_THREAD_SOURCE_CLASS_LENGTH * 4} AND length(thread_source) <= ${MAX_THREAD_SOURCE_CLASS_LENGTH}) THEN 1 ELSE 0 END AS origin_class_valid`,
      ] : []),
      boundedTextColumn(columns, "rollout_path", MAX_ROLLOUT_PATH_LENGTH),
    ].join(", ");
    const statement = database.prepare(`SELECT ${selected} FROM threads WHERE id = ?`);
    const result = new Map();
    const selectedName = (row) => displayName(row.name) ??
      (allowTitleFallback && !ancestryOnly && typeof row.display_title === "string"
        ? displayName(row.display_title.replace(/\s+/gu, " ")) : null);
    const parentIds = new Set();
    let missingRows = 0, invalidRows = 0;
    for (const id of ids) {
      signal?.throwIfAborted();
      const row = statement.get(id);
      if (row === undefined) { missingRows++; continue; }
      if (threadId(row.id) !== id) { invalidRows++; continue; }
      if (withOriginReadReceipt && columns.has("source") && columns.has("thread_source")
          && (row.origin_source_valid !== 1 || row.origin_class_valid !== 1)) invalidRows++;
      const source = parseThreadSource(row.source);
      const threadStoreAutoReview = isAutoReviewThreadSource(row.thread_source);
      const sourceAutoReview = isAutoReviewSource(source);
      // Either exact guardian classification suppresses navigation to a review
      // row's internal UUID. A parent is trusted only when both stores agree.
      const autoReview = threadStoreAutoReview || sourceAutoReview;
      const verifiedAutoReview = sourceAutoReview && (threadStoreAutoReview || usageRelations && row.thread_source === "subagent");
      const worker = autoReview ? null : workerMetadata(source, id);
      const parentId = verifiedAutoReview && (!ancestryOnly || usageRelations)
        ? await readAutoReviewParent(codexHome, row.rollout_path, id, filesystem, usageRelations, false, diagnosticTimer)
        : worker?.parentId ?? null;
      if (parentId !== null) parentIds.add(parentId);
      result.set(id, {
        name: selectedName(row),
        nickname: displayName(row.agent_nickname, MAX_AGENT_NICKNAME_LENGTH)
          ?? worker?.nickname ?? null,
        parentId,
        origin: autoReview ? "auto_review" : null,
      });
    }
    for (const id of parentIds) {
      signal?.throwIfAborted();
      if (result.size + parentIds.size > 50_000) { report("metadata_parent_limit"); return new Map(); }
      if (result.has(id)) continue;
      const row = statement.get(id);
      if (row !== undefined && threadId(row.id) === id) {
        const source = parseThreadSource(row.source);
        // Internal guardian surfaces must not become navigation targets or
        // collaboration ancestors. Preserve the current display contract.
        if (!usageRelations && (isAutoReviewThreadSource(row.thread_source) || isAutoReviewSource(source))) {
          continue;
        }
        const review = isAutoReviewThreadSource(row.thread_source) || isAutoReviewSource(source);
        const verifiedReview = isAutoReviewSource(source)
          && [AUTO_REVIEW_THREAD_SOURCE, "subagent"].includes(row.thread_source);
        const parentId = usageRelations && verifiedReview
          ? await readAutoReviewParent(codexHome, row.rollout_path, id, filesystem, true, false, diagnosticTimer)
          : ancestryOnly && !review ? workerMetadata(source, id)?.parentId ?? null : null;
        if (parentId) parentIds.add(parentId);
        result.set(id, { name: selectedName(row), nickname: null, parentId, origin: review ? "auto_review" : null });
      }
    }
    if (!await guard.validate()) { report("metadata_database_changed"); return new Map(); }
    report("thread_row_missing", missingRows);
    report("thread_row_invalid", invalidRows);
    return withOriginReadReceipt
      ? { selected: result, complete: columns.has("source") && columns.has("thread_source") && invalidRows === 0 }
      : result;
  } catch (error) {
    signal?.throwIfAborted();
    const code = error?.code;
    report(["ENOENT", "WINDOWS_FILESYSTEM_NOT_FOUND"].includes(code) ? "metadata_database_missing"
      : ["SQLITE_BUSY", "SQLITE_LOCKED"].includes(code) || [5, 6].includes(error?.errcode) ? "metadata_database_busy"
      : ["EACCES", "EPERM"].includes(code) || typeof code === "string" && code.startsWith("WINDOWS_FILESYSTEM_") ? "metadata_access_refused"
      : "metadata_read_failed");
    // Local display metadata is optional. Never expose paths or SQLite errors.
    return new Map();
  } finally {
    try { await closeMetadataDatabase(database, guard, slot); }
    catch (error) { report("metadata_close_failed"); throw error; }
  }
}

async function readSelectedSessionIndexNames(codexHome, selectedIds, filesystem) {
  const file = join(codexHome, "session_index.jsonl");
  let handle;
  try {
    const opened = await filesystem.openFile(file);
    handle = opened.handle;
    const before = opened.before;
    if (before.size > MAX_SESSION_INDEX_BYTES) return new Map();
    const last = Buffer.alloc(1);
    if (before.size > 0) await handle.read(last, 0, 1, before.size - 1);
    const names = new Map();
    let lines = 0;
    for await (const entry of readBoundedUtf8LineEntries(handle, {
      maximumLineBytes: MAX_SESSION_INDEX_LINE_BYTES,
      maximumTotalBytes: before.size,
      highWaterMark: 64 * 1024,
    })) {
      lines += 1;
      if (lines > MAX_SESSION_INDEX_LINES) return new Map();
      // An appended but unterminated record is not a published display name.
      if (entry.endByteExclusive === before.size && last[0] !== 0x0a) continue;
      if (entry.line.includes("\ufffd")) continue;
      let row;
      try {
        row = JSON.parse(entry.line);
      } catch {
        continue;
      }
      const id = threadId(row?.id);
      if (id === null || !selectedIds.has(id)) continue;
      const name = displayName(row.thread_name);
      const updated = typeof row.updated_at === "string"
          && row.updated_at.length <= 40
          && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(row.updated_at)
        ? Date.parse(row.updated_at)
        : NaN;
      if (name === null || !Number.isSafeInteger(updated)) continue;
      const prior = names.get(id);
      if (prior === undefined || updated > prior.updated) {
        names.set(id, { updated, name });
      } else if (updated === prior.updated && name !== prior.name) {
        // Conflicting equally current names do not justify choosing one.
        names.set(id, { updated, name: null });
      }
    }
    const after = await handle.stat();
    if (!filesystem.same(before, after)
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || !filesystem.same(before, await filesystem.namedStat(file, handle))) return new Map();
    return new Map([...names].map(([id, value]) => [id, value.name]));
  } catch {
    return new Map();
  } finally {
    await handle?.close();
  }
}

/**
 * Resolve only selected usage-row UUIDs to ephemeral, local-only display
 * metadata. The local Projects & threads caller may explicitly allow bounded
 * Codex titles. No transcript/body is read; display text and ancestry must
 * never enter accounting caches, derived indexes, or exports. Name search may
 * explicitly request up to 25,000 selected IDs in one bounded, transient pass;
 * cache-drop navigation may request the closed 2,000-reference envelope, and
 * ordinary row display remains capped at 160 IDs.
 */
export async function readCodexLocalThreadMetadata(codexHome, threadIds, {
  allowTitleFallback = false,
  forNameSearch = false,
  forCacheDropLinks = false,
  platform = process.platform,
  loadWindowsBinding,
  databaseFactory = openMetadataDatabase,
} = {}) {
  const filesystem = createLocalCodexMetadataFilesystem({ platform, loadWindowsBinding });
  const maximumLookups = forNameSearch === true
    ? 25_000
    : forCacheDropLinks === true
      ? MAX_CACHE_DROP_THREAD_LOOKUPS
      : MAX_LOCAL_THREAD_LOOKUPS;
  if (!Array.isArray(threadIds) || threadIds.length === 0
      || threadIds.length > maximumLookups
      || !await filesystem.validHome(codexHome)) return new Map();
  const ids = [...new Set(threadIds.map(threadId))];
  if (ids.includes(null)) return new Map();
  const selected = await readSelectedThreadMetadata(codexHome, ids, { allowTitleFallback: allowTitleFallback === true, filesystem, databaseFactory });
  const nameIds = new Set(ids);
  for (const id of ids) {
    const parentId = selected.get(id)?.parentId;
    if (parentId) nameIds.add(parentId);
  }
  const names = await readSelectedSessionIndexNames(codexHome, nameIds, filesystem);
  return new Map(ids.map((id) => {
    const metadata = selected.get(id);
    const parentId = metadata?.parentId ?? null;
    const parentMetadata = parentId === null ? null : selected.get(parentId);
    const result = {
      id,
      name: names.has(id) ? names.get(id) : metadata?.name ?? null,
      nickname: metadata?.nickname ?? null,
      // A generic worker keeps its existing explicit-parent fallback. Guardian
      // review may navigate only to a parent that is itself still accessible
      // from Codex's selected local thread store.
      parent: parentId === null || (metadata?.origin === "auto_review"
        && (parentMetadata === undefined || parentMetadata.origin === "auto_review")) ? null : {
        id: parentId,
        name: names.has(parentId)
          ? names.get(parentId)
          : parentMetadata?.name ?? null,
      },
    };
    if (metadata?.origin === "auto_review") result.origin = "auto_review";
    return [id, result];
  }));
}

/**
 * Read only explicit collaboration edges; no names or prompt-bearing titles.
 * The default result remains a Map. The opt-in origin receipt is solely for
 * cache proof checks: complete means a guarded, validated database read and
 * successful close, so an absent row differs from an unreadable store. It does
 * not assert that an absent thread has an ordinary origin.
 */
export async function readCodexLocalThreadUsageRelations(codexHome, threadIds, {
  platform = process.platform, loadWindowsBinding, databaseFactory = openMetadataDatabase, signal,
  includeOriginEvidence = false,
  withOriginReadReceipt = false,
  includeProjectAncestry = false,
  sourcePaths = null,
  knownThreadIds = new Set(),
  onOriginDiagnostic = null,
  diagnosticTimer = null,
} = {}) {
  const report = (code, count) => reportOriginDiagnostic(onOriginDiagnostic, code, count);
  const unavailable = () => withOriginReadReceipt ? { complete: false, relations: new Map() } : new Map();
  const filesystem = createLocalCodexMetadataFilesystem({ platform, loadWindowsBinding });
  if (withOriginReadReceipt && (!includeOriginEvidence || sourcePaths !== null)) return unavailable();
  if (!Array.isArray(threadIds) || threadIds.length > 25_000) { report("metadata_invalid_request"); return unavailable(); }
  if (sourcePaths !== null && (!(sourcePaths instanceof Map) && typeof sourcePaths !== "function"
      || !(knownThreadIds instanceof Set))) { report("metadata_invalid_request"); return unavailable(); }
  if (!await filesystem.validHome(codexHome)) { report("metadata_home_unavailable"); return unavailable(); }
  const ids = [...new Set(threadIds.map(threadId))];
  if (ids.includes(null)) { report("metadata_invalid_request"); return unavailable(); }
  report("requested", ids.length);
  const selection = sourcePaths instanceof Map || typeof sourcePaths === "function"
    ? await readSourceUsageRelations(codexHome, ids, sourcePaths, knownThreadIds, filesystem, signal, diagnosticTimer)
    : await readSelectedThreadMetadata(codexHome, ids, {
      ancestryOnly: true, usageRelations: true, filesystem, databaseFactory, signal, onOriginDiagnostic, withOriginReadReceipt, diagnosticTimer,
    });
  const selected = withOriginReadReceipt ? selection?.selected : selection;
  if (!(selected instanceof Map)) return unavailable();
  const known = ids.filter(id => selected.has(id)).length;
  report("known", known);
  report("unknown", ids.length - known);
  const finishParents = diagnosticTimer?.start("origin_parent_chain");
  const relations = new Map(ids.map(id => {
    let current = id;
    const seen = new Set();
    const ancestors = [];
    let valid = true;
    for (let depth = 0; ; depth++) {
      if (depth >= 64 || seen.has(current)) { valid = false; break; }
      seen.add(current);
      const record = selected.get(current);
      if (!record) { valid = false; break; }
      if (!record.parentId) break;
      current = record.parentId;
      ancestors.push(current);
    }
    const autoReview = selected.get(id)?.origin === "auto_review";
    const blockedReviewTerminal = autoReview && selected.get(current)?.origin === "auto_review";
    // Never attach to a missing, cyclic, or internal-review terminal parent.
    if (!valid || blockedReviewTerminal) current = id;
    return [id, { root: current, autoReview,
      ...(includeProjectAncestry ? { ancestors: valid && !blockedReviewTerminal ? ancestors : [],
        ancestryKnown: valid && !blockedReviewTerminal } : {}),
      ...(includeOriginEvidence ? {originKnown:selected.has(id)} : {}) }];
  }));
  finishParents?.();
  return withOriginReadReceipt ? { complete: selection.complete === true, relations } : relations;
}

export async function readCodexLocalThreadAncestry(codexHome, threadIds, {
  platform = process.platform, loadWindowsBinding, databaseFactory = openMetadataDatabase,
} = {}) {
  const filesystem = createLocalCodexMetadataFilesystem({ platform, loadWindowsBinding });
  if (!Array.isArray(threadIds) || threadIds.length > 25_000 || !await filesystem.validHome(codexHome)) return new Map();
  const ids = [...new Set(threadIds.map(threadId))];
  if (ids.includes(null)) return new Map();
  const selected = await readSelectedThreadMetadata(codexHome, ids, { ancestryOnly: true, filesystem, databaseFactory });
  const roots = new Map();
  for (const id of ids) {
    let current = id;
    const seen = new Set();
    for (let depth = 0; depth <= 64; depth++) {
      if (depth === 64 || seen.has(current)) { current = id; break; }
      seen.add(current);
      const parent = selected.get(current)?.parentId;
      if (!parent) break;
      current = parent;
    }
    roots.set(id, current);
  }
  return roots;
}


/** Local-only repository hints for vanished folders or unavailable Git. Never reads titles. */
export async function readCodexLocalRepositoryOrigins(codexHome, {
  platform = process.platform, loadWindowsBinding, databaseFactory = openMetadataDatabase,
} = {}) {
  const filesystem = createLocalCodexMetadataFilesystem({ platform, loadWindowsBinding });
  if (!await filesystem.validHome(codexHome)) return new Map();
  const databaseFile = join(codexHome, "state_5.sqlite");
  let database;
  let guard;
  let slot;
  try {
    await retryMetadataDatabaseCloses();
    slot = reserveMetadataDatabaseSlot();
    guard = await filesystem.guardDatabase(databaseFile);
    if (!await guard.validate()) return new Map();
    database = databaseFactory(guard.databasePath, { readOnly: true, timeout: 500 });
    if (!await guard.validate()) return new Map();
    database.exec("BEGIN");
    if (database.prepare("SELECT type FROM sqlite_master WHERE name = 'threads'").get()?.type !== "table") return new Map();
    const columns = new Set(database.prepare("PRAGMA table_info(threads)").all().map(row => row.name));
    if (!columns.has("cwd") || !columns.has("git_origin_url")) return new Map();
    const selected = [boundedTextColumn(columns, "cwd", 4096),
      boundedTextColumn(columns, "git_origin_url", 4096),
      "CASE WHEN git_origin_url IS NULL OR (typeof(git_origin_url) = 'text' AND length(CAST(git_origin_url AS BLOB)) = 0) THEN 0 ELSE 1 END AS origin_present"].join(", ");
    const result = new Map();
    let count = 0;
    for (const row of database.prepare(`SELECT ${selected} FROM threads LIMIT 25001`).iterate()) {
      if (++count > 25_000) return new Map();
      if (typeof row.cwd !== "string" || !isAbsolute(row.cwd) || /[\u0000-\u001f\u007f]/u.test(row.cwd)) continue;
      if (!row.origin_present) continue;
      const origin = normalizeWorkUsageRepositoryOrigin(row.git_origin_url);
      const cwd = resolve(row.cwd);
      if (!result.has(cwd)) result.set(cwd, origin);
      else if (result.get(cwd) !== origin) result.set(cwd, null);
    }
    return await guard.validate() ? result : new Map();
  } catch { return new Map(); }
  finally { await closeMetadataDatabase(database, guard, slot); }
}
