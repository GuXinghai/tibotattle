import { win32, isAbsolute, join } from "node:path";
import { TextDecoder } from "node:util";
import { createLocalCodexMetadataFilesystem } from "./local-codex-metadata-filesystem.js";

const GLOBAL_STATE_FILE = ".codex-global-state.json";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_TOKENS = 500_000;
const MAX_PROJECTS = 10_000;
const MAX_PROJECT_ROOTS = 32;
const MAX_ASSIGNMENTS = 25_000;
const MAX_PROJECTLESS_THREADS = 25_000;
const MAX_THREADS = MAX_ASSIGNMENTS + MAX_PROJECTLESS_THREADS;
const MAX_PROJECT_ID_LENGTH = 128;
const MAX_PROJECT_NAME_LENGTH = 512;
const MAX_ROOT_PATH_LENGTH = 4_096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

const unavailable = () => ({
  status: "unavailable",
  projects: new Map(),
  threads: new Map(),
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeProjectId(value) {
  return typeof value === "string" && value.length <= MAX_PROJECT_ID_LENGTH
    && PROJECT_ID.test(value)
    ? value
    : null;
}

function safeThreadId(value) {
  return typeof value === "string" && UUID.test(value)
    ? value.toLowerCase()
    : null;
}

function safeProjectName(value) {
  if (typeof value !== "string" || value.length > MAX_PROJECT_NAME_LENGTH
      || CONTROL.test(value)) return null;
  const name = value.trim();
  return name.length > 0 ? name : null;
}

function safeRootPath(value, platform) {
  if (typeof value !== "string" || value.length === 0
      || value.length > MAX_ROOT_PATH_LENGTH || CONTROL.test(value)) return null;
  const absolute = platform === "win32"
    ? win32.isAbsolute(value) && win32.parse(value).root.length > 1
    : isAbsolute(value);
  return absolute ? value : null;
}

function sameStat(filesystem, before, after) {
  return filesystem.same(before, after)
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function hasDuplicateJsonKeys(source) {
  let offset = 0;
  let tokens = 0;

  function whitespace() {
    while (offset < source.length && /[\u0009\u000a\u000d\u0020]/u.test(source[offset])) offset += 1;
  }

  function string() {
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      const code = source.charCodeAt(offset);
      if (code === 0x5c) {
        offset += 2;
      } else if (code === 0x22) {
        offset += 1;
        return JSON.parse(source.slice(start, offset));
      } else {
        offset += 1;
      }
    }
    throw new Error("invalid_json");
  }

  function value(depth) {
    whitespace();
    if (++tokens > MAX_JSON_TOKENS || depth > MAX_JSON_DEPTH) throw new Error("json_bound");
    const current = source[offset];
    if (current === "{") {
      offset += 1;
      whitespace();
      const keys = new Set();
      if (source[offset] === "}") { offset += 1; return false; }
      let duplicate = false;
      for (;;) {
        whitespace();
        if (source[offset] !== "\"") throw new Error("invalid_json");
        const key = string();
        if (keys.has(key)) duplicate = true;
        else keys.add(key);
        whitespace();
        if (source[offset] !== ":") throw new Error("invalid_json");
        offset += 1;
        duplicate = value(depth + 1) || duplicate;
        whitespace();
        if (source[offset] === "}") { offset += 1; return duplicate; }
        if (source[offset] !== ",") throw new Error("invalid_json");
        offset += 1;
      }
    }
    if (current === "[") {
      offset += 1;
      whitespace();
      if (source[offset] === "]") { offset += 1; return false; }
      let duplicate = false;
      for (;;) {
        duplicate = value(depth + 1) || duplicate;
        whitespace();
        if (source[offset] === "]") { offset += 1; return duplicate; }
        if (source[offset] !== ",") throw new Error("invalid_json");
        offset += 1;
      }
    }
    if (current === "\"") { string(); return false; }
    while (offset < source.length && !/[\u0009\u000a\u000d\u0020,\]}]/u.test(source[offset])) offset += 1;
    if (offset === 0) throw new Error("invalid_json");
    return false;
  }

  const duplicate = value(0);
  whitespace();
  return duplicate || offset !== source.length;
}

function parseMemberships(document, platform) {
  if (!isRecord(document)) return null;
  const rawProjects = Object.hasOwn(document, "local-projects")
    ? document["local-projects"] : {};
  const rawAssignments = Object.hasOwn(document, "thread-project-assignments")
    ? document["thread-project-assignments"] : {};
  const rawProjectless = Object.hasOwn(document, "projectless-thread-ids")
    ? document["projectless-thread-ids"] : [];
  if (!isRecord(rawProjects) || !isRecord(rawAssignments) || !Array.isArray(rawProjectless)) return null;

  const projectEntries = Object.entries(rawProjects);
  const assignmentEntries = Object.entries(rawAssignments);
  if (projectEntries.length > MAX_PROJECTS
      || assignmentEntries.length > MAX_ASSIGNMENTS
      || rawProjectless.length > MAX_PROJECTLESS_THREADS) return null;

  const projects = new Map();
  for (const [key, record] of projectEntries) {
    const id = safeProjectId(key);
    if (id === null || !isRecord(record) || record.id !== id
        || safeProjectId(record.id) !== id || !Array.isArray(record.rootPaths)) continue;
    if (record.rootPaths.length > MAX_PROJECT_ROOTS) return null;
    const name = safeProjectName(record.name);
    if (name === null) continue;
    const rootPaths = [];
    const seenRoots = new Set();
    for (const rawPath of record.rootPaths) {
      const path = safeRootPath(rawPath, platform);
      if (path !== null && !seenRoots.has(path)) {
        seenRoots.add(path);
        rootPaths.push(path);
      }
    }
    projects.set(id, Object.freeze({ name, rootPaths: Object.freeze(rootPaths) }));
  }

  const assignments = new Map();
  const conflicting = new Set();
  for (const [rawThreadId, assignment] of assignmentEntries) {
    const threadId = safeThreadId(rawThreadId);
    if (threadId === null) continue;
    let selected = Object.freeze({ kind: "unknown" });
    if (isRecord(assignment) && assignment.projectKind === "local") {
      const projectId = safeProjectId(assignment.projectId);
      if (projectId !== null && projects.has(projectId)) {
        selected = Object.freeze({ kind: "project", projectId });
      }
    }
    const previous = assignments.get(threadId);
    if (previous && (previous.kind !== selected.kind
        || previous.projectId !== selected.projectId)) {
      conflicting.add(threadId);
    } else if (!previous) {
      assignments.set(threadId, selected);
    }
  }

  const projectless = new Set();
  for (const rawThreadId of rawProjectless) {
    const threadId = safeThreadId(rawThreadId);
    if (threadId !== null) projectless.add(threadId);
  }

  const threadIds = new Set([...assignments.keys(), ...projectless]);
  if (threadIds.size > MAX_THREADS) return null;
  const threads = new Map();
  for (const threadId of threadIds) {
    const assignment = assignments.get(threadId);
    if (conflicting.has(threadId) || assignment && projectless.has(threadId)) {
      threads.set(threadId, Object.freeze({ kind: "unknown" }));
    } else if (assignment) {
      threads.set(threadId, assignment);
    } else {
      threads.set(threadId, Object.freeze({ kind: "non_project" }));
    }
  }
  return { status: "available", projects, threads };
}

/**
 * Read only local project memberships and explicit projectless thread IDs.
 * No other Codex global-state fields are projected to callers.
 */
export async function readCodexLocalProjectMemberships(codexHome, {
  platform = process.platform,
  loadWindowsBinding,
  signal = null,
} = {}) {
  const filesystem = createLocalCodexMetadataFilesystem({ platform, loadWindowsBinding });
  let handle;
  let result = unavailable();
  let failed = false;
  try {
    signal?.throwIfAborted();
    if (!await filesystem.validHome(codexHome)) return unavailable();
    signal?.throwIfAborted();
    const path = join(codexHome, GLOBAL_STATE_FILE);
    const opened = await filesystem.openFile(path);
    handle = opened.handle;
    const before = opened.before;
    if (!before.isFile() || !Number.isSafeInteger(before.size)
        || before.size < 1 || before.size > MAX_FILE_BYTES) return unavailable();

    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < before.size + 1) {
      signal?.throwIfAborted();
      const length = Math.min(READ_CHUNK_BYTES, before.size + 1 - offset);
      const { bytesRead } = await handle.read(bytes, offset, length, offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > length) return unavailable();
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > MAX_FILE_BYTES) return unavailable();
    }
    if (offset !== before.size) return unavailable();

    signal?.throwIfAborted();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    if (hasDuplicateJsonKeys(text)) return unavailable();
    const document = JSON.parse(text);
    result = parseMemberships(document, platform) ?? unavailable();

    signal?.throwIfAborted();
    const after = await handle.stat();
    const named = await filesystem.namedStat(path, handle);
    if (!sameStat(filesystem, before, after) || !sameStat(filesystem, before, named)
        || after.size !== offset) return unavailable();
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    failed = true;
  } finally {
    try { await handle?.close(); }
    catch { failed = true; }
  }
  if (signal?.aborted) signal.throwIfAborted();
  return failed ? unavailable() : result;
}
