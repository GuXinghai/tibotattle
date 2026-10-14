import { createWorkUsageService } from "../../src/application/index.js";
import { createWorkUsageSnapshotStore } from "./work-usage-snapshots.js";
import { enrichWorkUsageRows } from "../../src/work-usage-display.js";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_COMPANION_REPORT_FILES,
  LOCAL_COMPANION_SCHEMA_VERSION,
  LocalCompanionDataStore,
  buildLocalCompanionSnapshot,
} from "../../src/local-companion-data.js";
import {
  resolveLocalLegacyReportReadPath,
} from "../../src/local-legacy-report-storage.js";
import { createLocalIndexBackend } from "../../src/local-index-backend.js";
import {
  createModelPerformanceController,
} from "./model-performance-controller.js";
import {
  createCodexSpeedBaselineController,
} from "../../src/codex-speed-baseline.js";
import {
  LOCAL_COMPANION_FRESH_INDEX_REFRESH_TIMEOUT_MS,
  LocalCompanionRefreshController,
  createDeferredAccountingRebuildRecorder,
  createLocalCollectorRefreshRunner,
  createTerminalRefreshFailureRecorder,
} from "../../src/local-companion-refresh.js";
import {
  acquireCompanionInstanceLock,
  createWindowsAccountObservationBrokerBackendFromEnvironment,
} from "../../src/platform/index.js";
import {
  assertLocalAbsolutePath,
  assertLocalResourceDirectory,
  assertLocalStatePath,
  defaultLocalCompanionStateRoot,
  inspectLocalOnboarding,
  prepareLocalInstallationRoots,
  projectLocalOnboarding,
} from "../../src/local-installation-diagnostics.js";
import {
  selectProductionAccountObservationSecret,
} from "../../src/account-observation-production.js";
import {
  PREVIEW_PRODUCT_BRAND,
  PRODUCT_BRAND,
  SEMANTIC_OPEN_TARGET_PLACEHOLDER,
} from "../../config/product-brand.js";
import {
  projectDesktopShellStatus,
} from "../../src/desktop-shell-status.js";
import {
  RELEASE_VERSION,
  RELEASE_VERSION_PLACEHOLDER,
} from "../../config/release-manifest.js";
import {
  installedAgentErrorResult,
  isInstalledAgentInvocation,
  runInstalledAgentCli,
} from "./agent-cli.js";
import {
  LOCAL_COMPANION_STATIC_FILES as STATIC_FILES,
  createLocalCompanionReportRoutes,
} from "./static-assets.js";


const LOOPBACK_HOST = "127.0.0.1";
const LOCAL_COMPANION_MODULE_FILE = fileURLToPath(import.meta.url);
const DEFAULT_RESOURCE_ROOT = resolve(
  dirname(LOCAL_COMPANION_MODULE_FILE),
  "..",
  "..",
);
const PARENT_WATCHDOG_PID = Symbol("parentWatchdogPid");
const PARENT_PID_ENV = "USAGE_MONITOR_PARENT_PID";
const PARENT_PID = /^[1-9][0-9]{0,9}$/u;
const MAXIMUM_PARENT_PID = 2_147_483_647;
const PARENT_WATCHDOG_INTERVAL_MS = 250;
const PARENT_WATCHDOG_EXIT_GRACE_MS = 1_000;
const MAX_REQUEST_BODY_BYTES = 1_024;
const MAX_STATIC_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
export const LOCAL_COMPANION_INCREMENTAL_REFRESH_TIMEOUT_MS = 5 * 60_000;


function projectionAborted() {
  const error = new Error("local_unified_companion_projection_aborted");
  error.code = "local_unified_companion_projection_aborted";
  return error;
}

/** Reuse cloneable accounting results, with one cancellable build per exact key. */
export function createCachedLocalUnifiedProjectionReader({
  reader,
  validUntil,
  readGeneration,
} = {}) {
  for (const callback of [reader, validUntil, readGeneration]) {
    if (typeof callback !== "function") throw new TypeError("reader must be a function");
  }
  let cached = null;
  let closed = false;
  let revision = 0;
  const pending = new Map();
  function subscribe(build, signal, select = value => value) {
    if (signal?.aborted) return Promise.reject(projectionAborted());
    build.subscribers += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (callback, value) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", abort);
        build.subscribers -= 1;
        if (build.subscribers === 0 && !build.settled) build.controller.abort();
        callback(value);
      };
      const abort = () => finish(reject, projectionAborted());
      signal?.addEventListener("abort", abort, { once: true });
      build.promise.then(value => {
        try { finish(resolve, structuredClone(select(value))); }
        catch (error) { finish(reject, error); }
      }, error => finish(reject, error));
    });
  }
  const read = async function read(options, controls = {}) {
    if (closed) throw projectionAborted();
    if (controls.signal?.aborted) throw projectionAborted();
    // Deferred startup reads do not invalidate a completed full result.
    const select = controls.selectProjection ?? (value => value);
    if (options?.mode !== "full") return select(await reader(options, controls));
    const nowMs = options.nowMs;
    const key = JSON.stringify([
      options.indexFile, options.declaredSpeedBaselines ?? [],
      options.includeWorkUsage === true, options.exactWindow === true, options.codexHome ?? null, options.secretFile ?? null,
    ]);
    const expectedFingerprint = controls.reuse?.generationFingerprint
      ?? (options.includeWorkUsage ? await readGeneration(options) : null);
    if (closed || controls.signal?.aborted) throw projectionAborted();
    if (cached && key === cached.key && expectedFingerprint === cached.generationFingerprint
        && (!options.exactWindow || nowMs === cached.projectedAtMs)
        && Number.isFinite(nowMs) && nowMs >= cached.projectedAtMs && nowMs < cached.validUntilMs) {
      return structuredClone(select(cached.projection));
    }
    // Exact timestamps can share immediately. Different timestamps use the
    // finished cache only after its time-membership proof has completed.
    const buildKey = JSON.stringify([key, expectedFingerprint, nowMs]);
    const earlier = [...pending.values()].find(item => item.key === key
      && expectedFingerprint !== null && item.fingerprint === expectedFingerprint
      && item.nowMs < nowMs && !item.controller.signal.aborted);
    if (earlier) {
      await subscribe(earlier, controls.signal, () => null);
      return read(options, controls);
    }
    let build = pending.get(buildKey);
    if (!build || build.controller.signal.aborted) {
      const buildRevision = ++revision;
      build = { key, fingerprint: expectedFingerprint, nowMs, controller: new AbortController(), subscribers: 0, settled: false };
      const selected = build;
      selected.promise = Promise.resolve().then(async () => {
        const projection = await reader(options, { ...controls, signal: selected.controller.signal });
        const companion = projection?.companion ?? projection;
        const generationFingerprint = companion?.generation?.fingerprint;
        if (companion?.status === "available"
            && (!options.includeWorkUsage || projection?.workUsage?.status === "available")
            && /^generation-v2-[0-9a-f]{64}$/u.test(generationFingerprint ?? "")
            && Number.isFinite(nowMs)) {
          const validUntilMs = await validUntil({
            indexFile: options.indexFile, generationFingerprint, nowMs,
            includeWorkUsage: options.includeWorkUsage === true,
          });
          if (!selected.controller.signal.aborted && buildRevision === revision && validUntilMs > nowMs) {
            cached = { key, generationFingerprint, projectedAtMs: nowMs, validUntilMs,
              projection: structuredClone(projection) };
          }
        }
        return projection;
      }).finally(() => {
        selected.settled = true;
        if (pending.get(buildKey) === selected) pending.delete(buildKey);
      });
      pending.set(buildKey, selected);
    }
    return subscribe(build, controls.signal, select);
  };
  read.close = async () => {
    if (closed) return;
    closed = true;
    revision += 1;
    cached = null;
    for (const build of pending.values()) build.controller.abort();
    await reader.close?.();
  };
  return read;
}

/** Internal work summaries stay out of the dashboard's persisted/public DTO. */
export function selectSharedWorkUsageSnapshot(projection, query) {
  const work = projection?.workUsage;
  if (work?.status !== "available") {
    if (/^work_usage_[a-z_]+$/u.test(work?.errorCode ?? "")) {
      const error = new Error(work.errorCode);
      error.code = work.errorCode;
      throw error;
    }
    return { status: work?.status ?? "unavailable" };
  }
  const period = work.periods?.[query.period];
  if (!period) return { status: "unavailable" };
  const scope = query.scope ?? period.scopes.find(item => item.status === "unavailable")?.id
    ?? period.scopes[0]?.id ?? "scope-0";
  const snapshot = period.snapshots[scope];
  if (!snapshot) {
    const error = new Error("work_usage_scope_unavailable");
    error.code = "work_usage_scope_unavailable";
    throw error;
  }
  return { ...snapshot, fromMs: period.fromMs, toMs: period.toMs };
}

// One appended line per user-visible failure, so a support conversation can
// quote a reference the user can also see on the page. The file name is fixed
// and lives beside the other local state.
const DIAGNOSTICS_LOG_FILE_NAME = "diagnostics-v0.1.log";
export const LOCAL_DIAGNOSTIC_NOTE_SCHEMA_VERSION =
  "local-diagnostic-note-v0.1";
// Startup notes are minted by this server only. They are deliberately not part
// of DIAGNOSTIC_SURFACES, which remains the closed vocabulary for caller POSTs.
export const LOCAL_STARTUP_DIAGNOSTIC_STEPS = Object.freeze([
  "data_store",
]);
export const LOCAL_STARTUP_DIAGNOSTIC_DETAILS = Object.freeze([
  "codex_speed_baseline_unavailable",
  "collector_invalid_size",
  "collector_unavailable",
  "local_collector_projection_aborted",
  "local_collector_projection_worker_failed",
  "local_collector_state_corrupt",
  "local_collector_state_migration_busy",
  "local_collector_state_schema_invalid",
  "local_collector_state_unavailable",
  "local_companion_snapshot_reload_aborted",
  "local_unified_companion_projection_aborted",
  "local_unified_companion_projection_worker_failed",
  "local_unified_index_file_changed",
  "local_unified_index_generation_mismatch",
  "local_unified_index_missing",
  "local_unified_index_schema_invalid",
  "local_unified_index_schema_newer",
  "local_unified_index_tool_attestation_mismatch",
  "local_unified_index_unavailable",
  "local_unified_index_worker_failed",
  "snapshot_invalid",
  "snapshot_unavailable",
  "syntax_error",
  "type_error",
  "unexpected_error",
]);
const MAX_DIAGNOSTICS_LOG_BYTES = 256 * 1024;
const DIAGNOSTIC_REFERENCE = /^TT-[0-9A-HJKMNP-TV-Z]{6}$/u;
const DIAGNOSTIC_REFERENCE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LOCAL_STARTUP_DIAGNOSTIC_DETAIL_SET = new Set(
  LOCAL_STARTUP_DIAGNOSTIC_DETAILS,
);
const LOCAL_STARTUP_DIAGNOSTIC_SURFACE = "local_startup";
const LOCAL_STARTUP_DIAGNOSTIC_CODE = "snapshot_unavailable";
// Fixed journey names. Anything else is refused, so no free-form label can
// ever be written to the log.
const DIAGNOSTIC_SURFACES = new Set([
  "local_refresh",
]);
// Identifier-shaped fixed codes only: SCREAMING_SNAKE or lower_snake. Neither
// shape can carry a sentence, a path, or a quoted value.
const DIAGNOSTIC_ERROR_CODE =
  /^(?:[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9_]{1,63})$/u;
const DIAGNOSTIC_SERVICE_REQUEST_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function createLocalStartupDiagnosticReference() {
  let reference = "TT-";
  for (const byte of randomBytes(6)) {
    reference += DIAGNOSTIC_REFERENCE_ALPHABET[byte & 0b11111];
  }
  return reference;
}

function localStartupDiagnosticDetail(error) {
  if (LOCAL_STARTUP_DIAGNOSTIC_DETAIL_SET.has(error?.code)) {
    return error.code;
  }
  if (error instanceof TypeError) return "type_error";
  if (error instanceof SyntaxError) return "syntax_error";
  return "unexpected_error";
}

const REPORT_ROUTES = createLocalCompanionReportRoutes(
  LOCAL_COMPANION_REPORT_FILES,
);

const API_ROUTES = new Set([
  "/api/local/health",
  "/api/local/desktop-status",
  "/api/local/diagnostics/note",
  "/api/local/onboarding",
  "/api/local/overview",
  "/api/local/cache-drop-thread-links",
  "/api/local/work-usage/query",
  "/api/local/gradient",
  "/api/local/weekly",
  "/api/local/weekly-pace-outlook",
  "/api/local/quality",
  "/api/local/timeline/window-breakdown",
  "/api/local/model-performance",
  "/api/local/refresh",
  "/api/local/refresh/quick",
  "/api/local/refresh/cancel",
]);

// Routes that do not read the Codex dashboard snapshot must answer while that
// snapshot is still being built (or even if it fails): readiness, diagnostics,
// and the independently reconstructed timing analysis.
const SNAPSHOT_INDEPENDENT_API_ROUTES = new Set([
  "/api/local/health",
  "/api/local/desktop-status",
  "/api/local/diagnostics/note",
  "/api/local/model-performance",
]);


function jsonBody(value) {
  return Buffer.from(JSON.stringify(value));
}

// A query-string parameter that must be a plain base-ten safe integer. Anything
// else — a float, a sign, whitespace, scientific notation, an empty value — is
// rejected rather than coerced, so the two bounded window parameters can never
// carry a surprising value into the reader.
function integerParameter(value) {
  if (typeof value !== "string" || !/^-?\d{1,16}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function securityHeaders({ report = false } = {}) {
  const scriptPolicy = report ? "'self' 'unsafe-inline'" : "'self'";
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src ${scriptPolicy}; style-src 'self' 'unsafe-inline'`,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function send(response, statusCode, body, type = "application/json; charset=utf-8", options = {}) {
  const payload = Buffer.isBuffer(body) ? body : jsonBody(body);
  response.writeHead(statusCode, {
    ...securityHeaders(options),
    ...(options.headers ?? {}),
    "Content-Type": type,
    "Content-Length": payload.length,
  });
  response.end(payload);
}

function sendError(response, statusCode, code) {
  send(response, statusCode, {
    schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
    error: { code },
  });
}

/**
 * Append one bounded diagnostics line the user can quote to support.
 *
 * Every field was validated before this point and is either minted by the
 * dashboard or this companion (the reference), chosen from a fixed set (the
 * surface, and for server-minted refresh-failure notes the step), fixed and
 * identifier-shaped (the code and the optional detail code), or the service's
 * own request id. No message, payload, path, or participant value is written.
 * The optional step member exists only on server-minted terminal
 * refresh-failure notes; the POST route's key validation keeps it unreachable
 * to callers. The optional detail is either server-minted the same way or, for
 * a caller, one member of a closed vocabulary of resource-bound codes — a
 * coarse code such as export_too_large is useless to a reader who cannot see
 * which bound it stood for. The file is capped: once it would exceed the bound,
 * the current file becomes the single previous generation and a fresh one
 * starts, so the log can never grow without limit.
 */
// Server-minted resource measurements for a budget-miss note: a closed set of
// three keys whose values are rounded whole MiB or null, and nothing else. A
// coarse code such as accounting_transition_rss_limit_exceeded is useless to a
// reader who cannot see how far over the bound it went or what the bound was —
// the same reasoning that already admits `detail`. Bounded integers carry no
// message, payload, path, or participant value, so the privacy contract above
// is unchanged; anything not matching that exact shape is dropped rather than
// written, so a caller can never widen this into a free-form channel.
const NOTE_MEASUREMENT_KEYS = Object.freeze([
  "baselineRssMib",
  "observedRssMib",
  "ceilingRssMib",
]);

function boundedNoteMeasurements(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const bounded = {};
  for (const key of NOTE_MEASUREMENT_KEYS) {
    const measurement = value[key];
    bounded[key] = Number.isSafeInteger(measurement) && measurement >= 0
      ? measurement
      : null;
  }
  return bounded;
}

async function appendDiagnosticNote({
  file,
  note,
  now = Date.now(),
}) {
  const line = `${JSON.stringify({
    schemaVersion: LOCAL_DIAGNOSTIC_NOTE_SCHEMA_VERSION,
    recordedAt: new Date(now).toISOString(),
    reference: note.reference,
    surface: note.surface,
    code: note.code,
    requestId: note.requestId,
    ...(note.step === undefined ? {} : { step: note.step }),
    ...(note.detail === undefined ? {} : { detail: note.detail }),
    ...(note.measurements === undefined
      ? {}
      : { measurements: boundedNoteMeasurements(note.measurements) }),
  })}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  let current = null;
  try {
    current = await lstat(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (current !== null
      && (!current.isFile()
        || current.isSymbolicLink()
        || current.nlink !== 1)) {
    throw new Error("diagnostics log is not a plain owner-only file");
  }
  if (current !== null && current.size + bytes > MAX_DIAGNOSTICS_LOG_BYTES) {
    try {
      await rename(file, `${file}.previous`);
    } catch (error) {
      // Another concurrent note may have rotated first. Losing that race is
      // fine; losing this line because of it is not.
      if (error?.code !== "ENOENT") throw error;
    }
  }
  let handle;
  try {
    handle = await open(
      file,
      constants.O_WRONLY
        | constants.O_APPEND
        | constants.O_CREAT
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(line, "utf8");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function actualPort(server) {
  const address = server.address();
  return address && typeof address === "object" ? address.port : null;
}

function allowedHostHeader(server, value) {
  const port = actualPort(server);
  if (!Number.isSafeInteger(port) || typeof value !== "string") return false;
  const normalized = value.toLowerCase();
  return normalized === `${LOOPBACK_HOST}:${port}` || normalized === `localhost:${port}`;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin !== "string" || typeof host !== "string") return false;
  return origin.toLowerCase() === `http://${host.toLowerCase()}`;
}

function isLoopbackPeer(request) {
  const peer = request.socket.remoteAddress;
  return peer === LOOPBACK_HOST || peer === "::ffff:127.0.0.1";
}

async function readEmptyJsonObject(
  request,
  { allowFixedUserRequest = true } = {},
) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    const error = new Error("unsupported_media_type");
    error.code = "unsupported_media_type";
    throw error;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    const error = new Error("request_too_large");
    error.code = "request_too_large";
    throw error;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      const error = new Error("request_too_large");
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.code = "invalid_json";
    throw error;
  }
  const isObject = value && typeof value === "object" && !Array.isArray(value);
  const keys = isObject ? Object.keys(value) : [];
  const isEmpty = isObject && keys.length === 0;
  const isFixedUserRequest = isObject && keys.length === 1 && keys[0] === "reason" && value.reason === "user_request";
  if (!isEmpty && !(allowFixedUserRequest && isFixedUserRequest)) {
    const error = new Error("invalid_request");
    error.code = "invalid_request";
    throw error;
  }
}

async function authorizeLocalMutation(
  request,
  response,
  errorCode,
  { allowFixedUserRequest = true } = {},
) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, errorCode);
    return false;
  }
  try {
    await readEmptyJsonObject(request, { allowFixedUserRequest });
    return true;
  } catch (error) {
    const status = error.code === "unsupported_media_type"
      ? 415
      : error.code === "request_too_large" ? 413 : 400;
    sendError(response, status, error.code ?? "invalid_request");
    return false;
  }
}

async function readBoundedJsonObject(request) {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string"
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    const error = new Error("unsupported_media_type");
    error.code = "unsupported_media_type";
    throw error;
  }
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength)
      && declaredLength > MAX_REQUEST_BODY_BYTES) {
    const error = new Error("request_too_large");
    error.code = "request_too_large";
    throw error;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      const error = new Error("request_too_large");
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid_json");
    error.code = "invalid_json";
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("invalid_request");
    error.code = "invalid_request";
    throw error;
  }
  return value;
}

function boundedRequestStatus(error) {
  if (error?.code === "unsupported_media_type") return 415;
  return error?.code === "request_too_large" ? 413 : 400;
}

async function authorizeDiagnosticNote(request, response) {
  if (!sameOrigin(request)
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, "diagnostic_note_not_authorized");
    return null;
  }
  let value;
  try {
    value = await readBoundedJsonObject(request);
  } catch (error) {
    sendError(
      response,
      boundedRequestStatus(error),
      error.code ?? "invalid_request",
    );
    return null;
  }
  const keys = Object.keys(value).sort().join("\0");
  if (keys !== "code\0reference\0requestId\0surface"
      || !DIAGNOSTIC_REFERENCE.test(value.reference)
      || !DIAGNOSTIC_SURFACES.has(value.surface)
      || !DIAGNOSTIC_ERROR_CODE.test(value.code)
      || typeof value.requestId !== "string"
      || (value.requestId !== ""
        && !DIAGNOSTIC_SERVICE_REQUEST_ID.test(value.requestId))) {
    sendError(response, 400, "invalid_request");
    return null;
  }
  return Object.freeze({
    reference: value.reference,
    surface: value.surface,
    code: value.code,
    requestId: value.requestId,
  });
}

function authorizeCacheDropThreadLinksRead(request, response) {
  // This optional read includes private local display names. Ordinary browser
  // same-origin GETs omit Origin; the custom header still requires a CORS
  // preflight from a foreign page, which the companion never grants.
  const origin = request.headers.origin;
  if ((origin !== undefined && !sameOrigin(request))
      || request.headers["x-usage-monitor-local"] !== "1") {
    sendError(response, 403, "cache_drop_thread_links_not_authorized");
    return false;
  }
  return true;
}

async function readFixedFile(root, file, maximumBytes) {
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, file);
  const rootPrefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  if (!path.startsWith(rootPrefix)) {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maximumBytes) {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  return readFile(path);
}

const ALLOWED_SEMANTIC_OPEN_TARGETS = new Set([
  PRODUCT_BRAND.appOpenURL,
  PREVIEW_PRODUCT_BRAND.appOpenURL,
]);

export function configuredSemanticOpenTarget(environment = process.env) {
  const value = environment?.USAGE_MONITOR_APP_OPEN_URL
    ?? PRODUCT_BRAND.appOpenURL;
  if (typeof value !== "string" || !ALLOWED_SEMANTIC_OPEN_TARGETS.has(value)) {
    throw new Error(
      "USAGE_MONITOR_APP_OPEN_URL must match a reviewed product identity",
    );
  }
  return value;
}

function stampSemanticOpenTarget(body, semanticOpenTarget) {
  const source = body.toString("utf8");
  const first = source.indexOf(SEMANTIC_OPEN_TARGET_PLACEHOLDER);
  if (first < 0
      || source.indexOf(
        SEMANTIC_OPEN_TARGET_PLACEHOLDER,
        first + SEMANTIC_OPEN_TARGET_PLACEHOLDER.length,
      ) >= 0) {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  return Buffer.from(
    source.replace(
      SEMANTIC_OPEN_TARGET_PLACEHOLDER,
      semanticOpenTarget,
    ),
  );
}

function stampReleaseVersion(body) {
  const source = body.toString("utf8");
  const first = source.indexOf(RELEASE_VERSION_PLACEHOLDER);
  if (first < 0) return Buffer.from(source);
  if (source.indexOf(
    RELEASE_VERSION_PLACEHOLDER,
    first + RELEASE_VERSION_PLACEHOLDER.length,
  ) >= 0) {
    const error = new Error("not_found");
    error.code = "not_found";
    throw error;
  }
  return Buffer.from(source.replace(RELEASE_VERSION_PLACEHOLDER, RELEASE_VERSION));
}

function stampLocalDashboard(body, semanticOpenTarget) {
  return stampReleaseVersion(
    stampSemanticOpenTarget(body, semanticOpenTarget),
  );
}

function configuredHomeDirectory(environment) {
  const selected = process.platform === "win32"
    ? environment.USERPROFILE
    : environment.HOME;
  if (typeof selected === "string" && selected.length > 0
      && isAbsolute(selected) && resolve(selected) === selected) {
    return selected;
  }
  const fallback = homedir();
  if (!isAbsolute(fallback) || resolve(fallback) !== fallback) {
    throw new TypeError("Home directory is invalid");
  }
  return fallback;
}

function parentWatchdogConfigurationError() {
  const error = new TypeError(
    "Parent watchdog configuration is invalid",
  );
  error.code = "USAGE_MONITOR_PARENT_PID_INVALID";
  return error;
}

function configuredParentWatchdogPid(
  environment,
  observedParentPid = process.ppid,
) {
  if (!Object.hasOwn(environment, PARENT_PID_ENV)) return null;
  const value = environment[PARENT_PID_ENV];
  if (typeof value !== "string" || !PARENT_PID.test(value)) {
    throw parentWatchdogConfigurationError();
  }
  const selected = Number(value);
  if (!Number.isSafeInteger(selected)
      || selected <= 1
      || selected > MAXIMUM_PARENT_PID
      || String(selected) !== value
      || selected !== observedParentPid) {
    throw parentWatchdogConfigurationError();
  }
  return selected;
}

function declaredParentIsCurrent(expectedParentPid) {
  if (expectedParentPid === null) return true;
  if (process.ppid !== expectedParentPid) return false;
  try {
    process.kill(expectedParentPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function closeHttpServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (!error || error.code === "ERR_SERVER_NOT_RUNNING") {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
    server.closeAllConnections?.();
  });
}

function startParentDeathWatchdog({
  server,
  expectedParentPid,
  terminateProcess,
}) {
  if (expectedParentPid === null) {
    return Object.freeze({ stop() {} });
  }
  let active = true;
  const timer = setInterval(() => {
    if (!active || declaredParentIsCurrent(expectedParentPid)) return;
    active = false;
    clearInterval(timer);
    let forcedExit = null;
    if (terminateProcess) {
      // `server.close()` can wait indefinitely on platform-specific socket
      // bookkeeping after the launcher has already disappeared. Preserve a
      // short graceful-close window, then guarantee that the orphan cannot
      // survive its declared parent on Linux or Windows.
      forcedExit = setTimeout(
        () => process.exit(0),
        PARENT_WATCHDOG_EXIT_GRACE_MS,
      );
    }
    void closeHttpServer(server)
      .catch(() => {})
      .then(() => {
        if (forcedExit !== null) clearTimeout(forcedExit);
        if (terminateProcess) process.exit(0);
      });
  }, PARENT_WATCHDOG_INTERVAL_MS);
  timer.unref?.();
  return Object.freeze({
    stop() {
      if (!active) return;
      active = false;
      clearInterval(timer);
    },
  });
}

export function createLocalCompanionServer(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("options must be an object");
  }
  const environment = options.environment ?? process.env;
  if (!environment || typeof environment !== "object"
      || Array.isArray(environment)) {
    throw new TypeError("environment must be an object");
  }
  const semanticOpenTarget = configuredSemanticOpenTarget(environment);
  const parentWatchdogPid = configuredParentWatchdogPid(environment);
  const homeDirectory = configuredHomeDirectory(environment);
  const resourceRoot = options.resourceRoot
    ?? environment.USAGE_MONITOR_RESOURCE_ROOT
    ?? options.root
    ?? DEFAULT_RESOURCE_ROOT;
  const stateRoot = options.stateRoot
    ?? environment.USAGE_MONITOR_STATE_ROOT
    ?? defaultLocalCompanionStateRoot({
      homeDirectory,
      environment,
    });
  const installation = prepareLocalInstallationRoots({
    resourceRoot,
    stateRoot,
  });
  const staticRoot = assertLocalResourceDirectory(
    installation.resourceRoot,
    options.staticRoot
      ?? resolve(installation.resourceRoot, "apps", "web", "public"),
  );
  const codexHome = assertLocalAbsolutePath(
    options.codexHome
      ?? environment.CODEX_HOME
      ?? join(homeDirectory, ".codex"),
  );
  const diagnosticsLogFile = assertLocalStatePath(
    installation.stateRoot,
    options.diagnosticsLogFile
      ?? join(installation.stateRoot, DIAGNOSTICS_LOG_FILE_NAME),
  );
  return createPreparedLocalCompanionServer({
    ...options,
    environment,
    resourceRoot: installation.resourceRoot,
    stateRoot: installation.stateRoot,
    statePaths: installation.paths,
    staticRoot,
    codexHome,
    diagnosticsLogFile,
    parentWatchdogPid,
    homeDirectory,
    semanticOpenTarget,
  });
}

function createPreparedLocalCompanionServer({
  environment,
  resourceRoot,
  stateRoot,
  statePaths,
  staticRoot,
  codexHome,
  homeDirectory,
  diagnosticsLogFile,
  parentWatchdogPid,
  semanticOpenTarget,
  // A declared speed baseline supplements missing per-turn/applied-settings
  // evidence. Only the configuration's top-level `service_tier` key is read;
  // each timestamped observation covers its established time interval and
  // never backfills retained history or overrides explicit tier evidence.
  codexSpeedBaseline = createCodexSpeedBaselineController({
    ledgerFile: statePaths.codexSpeedBaselineFile,
    configFile: join(codexHome, "config.toml"),
  }),
  // The local index. A previous installation's index is read once for
  // continuity of the local identity ordinals; its device salt is the same file.
  localIndexBackend = createLocalIndexBackend({
    indexFile: statePaths.localIndexStoreFile,
    secretFile: statePaths.unifiedIndexSecretFile,
    legacyIndexFile: statePaths.unifiedIndexFile,
  }),
  // The store every index consumer below reads.
  unifiedStoreFile = localIndexBackend.indexFile,
  sharedProjectionReader = createCachedLocalUnifiedProjectionReader(
    localIndexBackend.projectionReader,
  ),
  unifiedProjectionReader = async (options, controls) => {
    return sharedProjectionReader({ ...options, includeWorkUsage: true, codexHome }, {
      ...controls, selectProjection: projection => projection.companion ?? projection,
    });
  },
  dataStore = new LocalCompanionDataStore({
    snapshotFile: statePaths.authoritativeDashboardSnapshotFile,
    builder: async ({
      purpose = "full",
      signal = null,
      unifiedProjectionReuse = null,
    } = {}) => buildLocalCompanionSnapshot({
      root: resourceRoot,
      collectorStateFile: statePaths.collectorStateFile,
      unifiedIndexFile: unifiedStoreFile,
      codexHome,
      unifiedProjectionMode: ["startup", "quick"].includes(purpose)
        ? "deferred"
        : "full",
      unifiedProjectionReader,
      unifiedProjectionReuse,
      signal,
      allowDevelopmentArtifactFallback:
        environment.USAGE_MONITOR_DEVELOPMENT_ARTIFACT_FALLBACK === "1",
      // Timestamped declared baselines. They fill only the turns the rollout
      // log left unobserved and that a reading actually covers; an observed
      // tier always wins, and an unreadable ledger is simply no coverage.
      codexSpeedBaselines: await codexSpeedBaseline.readWindows(),
    }),
  }),
  // Reprice the usage events inside a bounded [from, to] window from the
  // unified local index, grouped by model and observed speed. Injected so a
  // test can drive the route's range validation and response shape without a
  // real index on disk; in production it reads the same index the snapshot
  // draws from, strictly read-only.
  windowBreakdownProvider = ({ fromMs, toMs }) => (
    localIndexBackend.windowBreakdown({ fromMs, toMs })
  ),
  modelPerformanceProvider = null,
  // Never enrich the persisted overview or report DTOs with names. This
  // optional, transient read resolves only rows from the attested snapshot.
  cacheDropThreadLinksProvider = ({ overview }) => (
    localIndexBackend.cacheDropThreadLinks({ codexHome, overview })
  ),
  workUsageBuild = async (query, controls) => sharedProjectionReader({
      mode: "full", nowMs: query.toMs, includeWorkUsage: true, exactWindow: query.exactWindow === true,
      indexFile: unifiedStoreFile, codexHome,
      declaredSpeedBaselines: await codexSpeedBaseline.readWindows(),
    }, { ...controls, selectProjection: projection => selectSharedWorkUsageSnapshot(projection, query) }),
  workUsageEnrich = (query) => enrichWorkUsageRows({ ...query, codexHome }),
  refreshRunner = createLocalCollectorRefreshRunner({
    codexHome,
    stateFile: statePaths.collectorStateFile,
    accountObservationOperationLockFile:
      statePaths.accountObservationLockFile,
    selectAccountObservationSecret: (options = {}) => (
      selectProductionAccountObservationSecret({
        ...options,
        createWindowsBrokerBackend: () =>
          createWindowsAccountObservationBrokerBackendFromEnvironment(environment),
      })
    ),
    refreshAccounting: localIndexBackend.refreshAccounting,
    // Advance the index by its cursors on every foreground refresh: an
    // ordinary pass reads only the bytes the rollout corpus grew.
    refreshUnifiedIndex: localIndexBackend.refreshUnifiedIndex,
    unifiedIndexFile: unifiedStoreFile,
    unifiedIndexSecretFile: statePaths.unifiedIndexSecretFile,
    recordCodexSpeedBaseline: async () => (
      (await codexSpeedBaseline.record()).windows
    ),
  }),
  onboardingProvider = () => inspectLocalOnboarding({
    codexHome,
    stateRoot,
    explicitRefresh: true,
    customCodexHomeConfigured:
      typeof environment.CODEX_HOME === "string"
      && environment.CODEX_HOME.length > 0,
  }),
  refreshTimeoutMs = LOCAL_COMPANION_INCREMENTAL_REFRESH_TIMEOUT_MS,
  refreshTimeoutMsForRun = () => localIndexBackend.refreshTimeoutMs({
    existingTimeoutMs: refreshTimeoutMs,
    freshTimeoutMs: LOCAL_COMPANION_FRESH_INDEX_REFRESH_TIMEOUT_MS,
  }),
  diagnosticNoteRecorder = null,
  diagnosticReferenceFactory = createLocalStartupDiagnosticReference,
  clock = () => Date.now(),
  instanceLockAcquirer = acquireCompanionInstanceLock,
  onError = () => {},
} = {}) {
  // This optional analysis owns neither accounting refresh nor snapshot
  // readiness. Create its controller only when its page is first requested.
  let modelPerformanceController = null;
  let modelPerformanceShutdown = null;
  const readModelPerformance = modelPerformanceProvider ?? ((period, options) => {
    if (modelPerformanceShutdown !== null) {
      throw new Error("model_performance_unavailable");
    }
    modelPerformanceController ??= createModelPerformanceController({
      directory: join(stateRoot, "inference-timing-v2"),
      codexHome,
    });
    return modelPerformanceController.read(period, options);
  });
  const closeModelPerformance = () => {
    modelPerformanceShutdown ??= Promise.resolve().then(() => (
      modelPerformanceController?.close()
    ));
    return modelPerformanceShutdown;
  };
  if (!environment || typeof environment !== "object"
      || Array.isArray(environment)) {
    throw new TypeError("environment must be an object");
  }
  if (!dataStore || typeof dataStore.initialize !== "function") {
    throw new TypeError("dataStore.initialize must be a function");
  }
  if (typeof onboardingProvider !== "function") {
    throw new TypeError("onboardingProvider must be a function");
  }
  if (typeof cacheDropThreadLinksProvider !== "function") {
    throw new TypeError("cacheDropThreadLinksProvider must be a function");
  }
  if (modelPerformanceProvider !== null
      && typeof modelPerformanceProvider !== "function") {
    throw new TypeError("modelPerformanceProvider must be a function");
  }
  if (typeof diagnosticsLogFile !== "string"
      || diagnosticsLogFile.length < 1
      || typeof clock !== "function"
      || typeof diagnosticReferenceFactory !== "function"
      || (diagnosticNoteRecorder !== null
        && typeof diagnosticNoteRecorder !== "function")) {
    throw new TypeError("local diagnostics controls are invalid");
  }
  const recordDiagnosticNote = diagnosticNoteRecorder
    ?? ((note) => appendDiagnosticNote({
      file: diagnosticsLogFile,
      note,
      now: clock(),
    }));
  let instanceLock = null;
  let instanceLockRelease = null;
  let instanceLockPromise = null;
  let snapshotPromise = null;
  // The first snapshot defers full-history projection, but even its bounded
  // local reads can wait on storage. The port opens before that work, so this
  // records whether the in-memory snapshot the read routes project actually
  // exists. /api/local/health reports it without smoothing it into "ready".
  let snapshotState = { status: "building", errorCode: null };
  const releaseInstanceLock = () => {
    if (instanceLockRelease !== null) return instanceLockRelease;
    const lock = instanceLock;
    instanceLock = null;
    instanceLockRelease = Promise.resolve(lock?.release());
    return instanceLockRelease;
  };
  let runtimeShutdown = null;
  const shutdownRuntime = () => {
    // Publish the shutdown fence before awaiting anything asynchronous.
    runtimeShutdown ??= Promise.resolve().then(() => releaseInstanceLock());
    return runtimeShutdown;
  };
  // Single-instance exclusion is cheap (one lock file) and must still be
  // decided before this process is allowed to accept requests, so it stays on
  // the pre-listen path. Only the snapshot build moves behind the port. The
  // lock file keeps its long-standing name so a still-running older companion
  // build recognizes this process.
  const acquireInstanceLock = () => {
    instanceLockPromise ??= (async () => {
      instanceLock = await instanceLockAcquirer({
        lockFile: statePaths.companionInstanceLockFile,
      });
    })();
    return instanceLockPromise;
  };
  // Resolved the moment the outcome of the first build is known. A failing
  // build still releases the instance lock before it rethrows, but a request
  // waiting to read the snapshot is answered as soon as the answer exists, not
  // held behind someone else's teardown.
  let announceSnapshotOutcome = null;
  const snapshotOutcome = new Promise((resolveOutcome) => {
    announceSnapshotOutcome = resolveOutcome;
  });
  const buildSnapshot = () => {
    if (snapshotPromise === null) {
      snapshotPromise = (async () => {
        let startupStep = "data_store";
        try {
          // Publish the bounded startup projection first. The store retains
          // validated prior evidence with its provenance; the normal refresh
          // supplies the subsequent quick and full projections.
          await dataStore.initialize({ purpose: "startup" });
          snapshotState = { status: "ready", errorCode: null };
          announceSnapshotOutcome();
        } catch (error) {
          snapshotState = {
            status: "failed",
            errorCode: typeof error?.code === "string"
              && /^[a-z0-9_]{1,64}$/u.test(error.code)
              ? error.code
              : "snapshot_unavailable",
          };
          announceSnapshotOutcome();
          try {
            const reference = diagnosticReferenceFactory();
            if (DIAGNOSTIC_REFERENCE.test(reference)) {
              await recordDiagnosticNote({
                reference,
                surface: LOCAL_STARTUP_DIAGNOSTIC_SURFACE,
                code: LOCAL_STARTUP_DIAGNOSTIC_CODE,
                requestId: "",
                step: startupStep,
                detail: localStartupDiagnosticDetail(error),
              });
            }
          } catch {
            // Failure retention is best-effort. It cannot change the startup
            // error or skip its normal teardown.
          }
          await shutdownRuntime().catch(() => {});
          throw error;
        }
      })();
    }
    return snapshotPromise;
  };
  // Read routes wait for the first build instead of projecting an empty or
  // half-built snapshot. A build that failed is reported as a failure rather
  // than waited on forever.
  const whenSnapshotSettled = async () => {
    buildSnapshot().catch(() => {});
    await snapshotOutcome;
    return snapshotState;
  };
  const refresh = new LocalCompanionRefreshController({
    runner: refreshRunner,
    dataStore,
    timeoutMs: refreshTimeoutMs,
    timeoutMsForRun: refreshTimeoutMsForRun,
    clock,
    // Five hours of refresh_resource_limited loops once left zero local
    // trail: the terminal classification lived only in this controller's
    // in-memory state. Every terminal refresh failure now files one bounded,
    // rate-limited diagnostics note — codes, step, and timestamp only.
    onTerminalFailure: createTerminalRefreshFailureRecorder({
      recordNote: recordDiagnosticNote,
      clock,
    }),
    // A memory-budget miss is now a SOFT outcome (the refresh succeeds serving
    // the retained cache), so the terminal recorder above never files it. This
    // sibling recorder keeps that one bounded, rate-limited diagnostics note —
    // the trail the five-hour incident was found by — for the degraded event.
    onDegradedOutcome: createDeferredAccountingRebuildRecorder({
      recordNote: recordDiagnosticNote,
      clock,
    }),
  });

  const workUsage = createWorkUsageService({ build: workUsageBuild, enrich: workUsageEnrich,
    snapshotStore: createWorkUsageSnapshotStore({
      snapshotFile: join(stateRoot, "work-usage-snapshot.json"),
      codexHome, indexFile: unifiedStoreFile,
    }),
  });
  let workUsageShutdown = null;
  const closeWorkUsage = () => workUsageShutdown ??= workUsage.close();
  let projectionShutdown = null;
  const closeProjectionReader = () => projectionShutdown ??= Promise.resolve()
    .then(() => sharedProjectionReader.close?.());
  let shutdownRequested = false;
  const beginShutdown = () => { shutdownRequested = true; };
  const server = createServer(async (request, response) => {
    try {
      if (!isLoopbackPeer(request)) {
        sendError(response, 403, "loopback_required");
        return;
      }
      if (!allowedHostHeader(server, request.headers.host)) {
        sendError(response, 403, "host_not_allowed");
        return;
      }
      if (shutdownRequested) {
        if (request.method !== "GET" && !sameOrigin(request)) {
          sendError(response, 403, "shutdown_not_authorized");
          return;
        }
        sendError(response, 503, "server_shutting_down");
        return;
      }
      let url;
      try {
        url = new URL(request.url, `http://${request.headers.host}`);
      } catch {
        sendError(response, 400, "invalid_request");
        return;
      }
      const path = url.pathname;
      // Only window breakdown and model performance accept query strings,
      // with closed route-specific parameters. Every other route stays
      // query-free by construction.
      const acceptsQueryString = path === "/api/local/timeline/window-breakdown"
        || path === "/api/local/model-performance";
      if (url.hash !== "" || (url.search !== "" && !acceptsQueryString)) {
        sendError(response, 400, "invalid_request");
        return;
      }
      if (path.startsWith("/api/") && !API_ROUTES.has(path)) {
        sendError(response, 404, "not_found");
        return;
      }
      // The listening port no longer proves the snapshot exists: it is opened
      // first so the window, its static assets, and readiness answer at once.
      // Every route that reads the snapshot therefore waits for the first build
      // here, and a build that failed is refused rather than answered with an
      // empty projection. Health and the diagnostic note stay outside the gate
      // precisely so a slow or failed build can still be observed.
      if (path.startsWith("/api/") && !SNAPSHOT_INDEPENDENT_API_ROUTES.has(path)) {
        if ((await whenSnapshotSettled()).status !== "ready") {
          sendError(response, 503, "snapshot_unavailable");
          return;
        }
      }

      if (path === "/api/local/health") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          status: "ready",
          // `status` above states that this loopback surface is answering, which
          // it now does from the first millisecond. Whether the evidence
          // snapshot behind the read routes exists yet is a separate fact, and
          // it is stated separately rather than being folded into that word.
          snapshot: {
            status: snapshotState.status,
            errorCode: snapshotState.errorCode,
          },
          mode: "loopback_real_local_evidence",
          remoteUploadEnabled: false,
          capabilities: {
            localDashboard: true,
            explicitRefresh: true,
            arbitraryPathAccess: false,
            remoteProxy: false,
          },
        });
        return;
      }
      if (path === "/api/local/desktop-status") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        // The shell receives only the closed projection. It deliberately reads
        // the in-memory lifecycle, refresh receipt, and a tiny cached display
        // proof rather than the full dashboard snapshot, so five-second polls
        // neither clone timeline data nor expose paths, source details, or
        // accounting. Notification evidence remains exclusively on the refresh
        // receipt; the display proof cannot authorize a notification.
        let displayEvidence = null;
        try {
          displayEvidence = typeof dataStore.getDesktopShellDisplayEvidence === "function"
            ? dataStore.getDesktopShellDisplayEvidence()
            : null;
        } catch {
          // A local accessor fault is indistinguishable from unavailable
          // display evidence at this closed route boundary.
        }
        send(response, 200, projectDesktopShellStatus({
          snapshotStatus: snapshotState.status,
          refresh: refresh.getStatus(),
          displayEvidence,
          now: clock(),
        }));
        return;
      }
      if (path === "/api/local/diagnostics/note") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        const note = await authorizeDiagnosticNote(request, response);
        if (note === null) return;
        try {
          await recordDiagnosticNote(note);
        } catch {
          sendError(response, 500, "diagnostic_note_not_recorded");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_DIAGNOSTIC_NOTE_SCHEMA_VERSION,
          status: "recorded",
          reference: note.reference,
        });
        return;
      }
      if (path === "/api/local/onboarding") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        let onboarding = null;
        try {
          onboarding = await onboardingProvider();
        } catch {
          // A failed source inspection is projected as closed, path-free
          // readiness rather than disclosing filesystem diagnostics.
        }
        send(response, 200, projectLocalOnboarding(onboarding));
        return;
      }
      if (path === "/api/local/overview") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, dataStore.getOverview());
        return;
      }
      if (path === "/api/local/work-usage/query") {
        if (request.method !== "POST") { sendError(response, 405, "method_not_allowed"); return; }
        if (!authorizeCacheDropThreadLinksRead(request, response)) return;
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers["content-type"] ?? "")) {
          sendError(response, 415, "unsupported_media_type"); return;
        }
        if (Number(request.headers["content-length"]) > 4096) { sendError(response, 413, "request_too_large"); return; }
        let bytes = 0; const chunks = [];
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 4096) { sendError(response, 413, "request_too_large"); return; }
          chunks.push(chunk);
        }
        let query;
        try { query = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { sendError(response, 400, "invalid_json"); return; }
        try { send(response, 200, await workUsage.query(query)); }
        catch (error) {
          const code = /^work_usage_[a-z_]+$/u.test(error?.code ?? "") ? error.code : "work_usage_unavailable";
          sendError(response, code.includes("snapshot") ? 409 : code.includes("query") ? 400 : 503, code);
        }
        return;
      }
      if (path === "/api/local/cache-drop-thread-links") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!authorizeCacheDropThreadLinksRead(request, response)) return;
        try {
          send(response, 200, await cacheDropThreadLinksProvider({
            overview: dataStore.getOverview(),
          }));
        } catch {
          // Missing optional metadata is not a failed accounting refresh.
          // Never surface filesystem errors, names, or raw thread state.
          send(response, 200, {
            schemaVersion: "local-cache-drop-thread-links-v1",
            status: "unavailable",
            generation: null,
            entries: [],
          });
        }
        return;
      }
      if (path === "/api/local/gradient") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          gradient: dataStore.getGradient(),
        });
        return;
      }
      if (path === "/api/local/weekly") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          weekly: dataStore.getWeekly(),
        });
        return;
      }
      if (path === "/api/local/weekly-pace-outlook") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          weekly: {
            paceOutlook: dataStore.getWeeklyPaceOutlook(),
          },
        });
        return;
      }
      if (path === "/api/local/model-performance") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        const entries = [...url.searchParams.entries()];
        const period = url.searchParams.get("period");
        const endAt = url.searchParams.get("endAt");
        const speedMode = url.searchParams.get("speedMode") ?? "standard";
        const end = endAt === null ? null : Date.parse(endAt);
        if (url.searchParams.getAll("period").length !== 1
            || url.searchParams.getAll("endAt").length > 1
            || url.searchParams.getAll("speedMode").length > 1
            || entries.some(([key]) => !["period", "endAt", "speedMode"].includes(key))
            || !["standard", "fast", "ultrafast"].includes(speedMode)
            || !["1", "7", "30", "all"].includes(period)
            || (endAt !== null && (!Number.isSafeInteger(end) || end < 0
              || end > Date.now() || new Date(end).toISOString() !== endAt))) {
          sendError(response, 400, "invalid_request");
          return;
        }
        try {
          send(response, 200, await readModelPerformance(period, { speedMode, ...(endAt === null ? {} : { endAt }) }));
        } catch {
          sendError(response, 503, "model_performance_unavailable");
        }
        return;
      }
      if (path === "/api/local/quality") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          quality: dataStore.getQuality(),
        });
        return;
      }
      if (path === "/api/local/timeline/window-breakdown") {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        // The two bounded integer parameters, and only those. Anything else in
        // the query string is refused rather than ignored, so the one route
        // that reads a query string cannot be turned into a general parameter
        // channel. The window itself is bounded and validated by the reader.
        const allowed = new Set(["from", "to"]);
        for (const key of url.searchParams.keys()) {
          if (!allowed.has(key)) {
            sendError(response, 400, "invalid_request");
            return;
          }
        }
        const fromMs = integerParameter(url.searchParams.get("from"));
        const toMs = integerParameter(url.searchParams.get("to"));
        if (fromMs === null || toMs === null) {
          sendError(response, 400, "invalid_request");
          return;
        }
        let breakdown;
        try {
          breakdown = await windowBreakdownProvider({ fromMs, toMs });
        } catch (error) {
          sendError(
            response,
            error?.code === "window_range_invalid" ? 400 : 500,
            error?.code === "window_range_invalid"
              ? "window_range_invalid"
              : "window_breakdown_unavailable",
          );
          return;
        }
        send(response, 200, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          breakdown,
        });
        return;
      }
      if (path === "/api/local/refresh") {
        if (request.method === "GET") {
          send(response, 200, {
            schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
            refresh: refresh.getStatus(),
          });
          return;
        }
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeLocalMutation(
          request,
          response,
          "refresh_not_authorized",
        )) return;
        if (!refresh.start({ mode: "detailed" })) {
          // Keep the terminal receipt's opaque run identifier available to a
          // first-party native caller that joined an already-running explicit
          // refresh. It contains no account or evidence data and lets the
          // caller reject a later, unrelated terminal receipt.
          send(response, 409, {
            schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
            error: { code: "refresh_in_progress" },
            refresh: refresh.getStatus(),
          });
          return;
        }
        send(response, 202, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          refresh: refresh.getStatus(),
        });
        return;
      }
      if (path === "/api/local/refresh/quick") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeLocalMutation(
          request,
          response,
          "refresh_not_authorized",
        )) return;
        if (!refresh.start({ mode: "quick" })) {
          send(response, 409, {
            schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
            error: { code: "refresh_in_progress" },
            refresh: refresh.getStatus(),
          });
          return;
        }
        send(response, 202, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          refresh: refresh.getStatus(),
        });
        return;
      }
      if (path === "/api/local/refresh/cancel") {
        if (request.method !== "POST") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        if (!await authorizeLocalMutation(
          request,
          response,
          "refresh_cancel_not_authorized",
        )) return;
        if (!refresh.cancel()) {
          sendError(response, 409, "refresh_not_running");
          return;
        }
        send(response, 202, {
          schemaVersion: LOCAL_COMPANION_SCHEMA_VERSION,
          refresh: refresh.getStatus(),
        });
        return;
      }

      const report = REPORT_ROUTES[path];
      if (report) {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        try {
          const reportPath = await resolveLocalLegacyReportReadPath(
            resourceRoot,
            report.file,
          );
          const body = await readFixedFile(
            resourceRoot,
            reportPath,
            MAX_REPORT_BYTES,
          );
          send(response, 200, body, report.type, { report: true });
        } catch {
          sendError(response, 404, "not_found");
        }
        return;
      }

      const staticFile = STATIC_FILES[path];
      if (staticFile) {
        if (request.method !== "GET") {
          sendError(response, 405, "method_not_allowed");
          return;
        }
        try {
          const source = await readFixedFile(
            staticRoot,
            staticFile.file,
            MAX_STATIC_BYTES,
          );
          const body = staticFile.file === "index.html"
            ? stampLocalDashboard(source, semanticOpenTarget)
            : source;
          send(response, 200, body, staticFile.type);
        } catch {
          sendError(response, 404, "not_found");
        }
        return;
      }
      sendError(response, 404, "not_found");
    } catch {
      onError("request_failed");
      if (!response.headersSent) sendError(response, 500, "internal_error");
      else response.destroy();
    }
  });
  // Node's 5-second keep-alive default races CFNetwork's connection pooling:
  // the WKWebView holds loopback sockets far longer, discovers the server's
  // FIN only on the next write, and a click-driven POST written onto the
  // torn-down socket dies with zero response bytes ("Load failed", no
  // request id) — CFNetwork silently retries idempotent GETs but never
  // POSTs, so exactly the user-initiated actions surfaced it. Ninety
  // seconds comfortably outlasts the pool's reuse horizon; headersTimeout
  // must stay above keepAliveTimeout or Node kills sockets mid-headers.
  server.keepAliveTimeout = 90_000;
  server.headersTimeout = 95_000;
  server.once("close", () => {
    void shutdownRuntime()
      .catch(() => {
        onError("instance_lock_release_failed");
      })
      .finally(() => closeModelPerformance().catch(() => {
        onError("model_performance_shutdown_failed");
      }));
  });

  server.on("close", () => {
    void closeWorkUsage().catch(() => onError("work_usage_shutdown_failed"));
    void closeProjectionReader().catch(() => onError("local_projection_shutdown_failed"));
  });

  return {
    server,
    dataStore,
    refresh,
    [PARENT_WATCHDOG_PID]: parentWatchdogPid,
    async initialize() {
      await acquireInstanceLock();
      await buildSnapshot();
    },
    acquireInstanceLock,
    buildSnapshot,
    snapshotStatus: () => ({ ...snapshotState }),
    shutdownRuntime,
    closeModelPerformance,
    closeWorkUsage,
    closeProjectionReader,
    beginShutdown,
  };
}

export async function startLocalCompanionServer({
  port = 8787,
  host = LOOPBACK_HOST,
  terminateProcessOnParentDeath = false,
  ...options
} = {}) {
  if (host !== LOOPBACK_HOST) throw new TypeError("Local companion must bind to 127.0.0.1");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new TypeError("port is invalid");
  if (typeof terminateProcessOnParentDeath !== "boolean") {
    throw new TypeError("terminateProcessOnParentDeath must be a boolean");
  }
  const app = createLocalCompanionServer(options);
  const expectedParentPid = app[PARENT_WATCHDOG_PID];
  if (!declaredParentIsCurrent(expectedParentPid)) {
    throw parentWatchdogConfigurationError();
  }
  const parentWatchdog = startParentDeathWatchdog({
    server: app.server,
    expectedParentPid,
    terminateProcess: terminateProcessOnParentDeath,
  });
  try {
    // Single-instance exclusion still decides whether this process may serve at
    // all, so it stays ahead of listen(). The snapshot build does not: it used
    // to hold the port shut for the 3-7 s it takes to read the retained
    // collector state on a real install, and for far longer when a rejected
    // accounting cache forces a full re-price - long enough to exceed the
    // launcher's own startup budget and have the companion killed before it
    // could finish repairing itself.
    await app.acquireInstanceLock();
    if (!declaredParentIsCurrent(expectedParentPid)) {
      throw parentWatchdogConfigurationError();
    }
    await new Promise((resolveListen, rejectListen) => {
      app.server.once("error", rejectListen);
      app.server.listen(port, host, () => {
        app.server.off("error", rejectListen);
        resolveListen();
      });
    });
    if (!declaredParentIsCurrent(expectedParentPid)) {
      throw parentWatchdogConfigurationError();
    }
  } catch (error) {
    parentWatchdog.stop();
    await closeHttpServer(app.server).catch(() => {});
    await app.shutdownRuntime().catch(() => {});
    throw error;
  }
  // Started behind the open port. The read routes await this same promise, and
  // a failure is surfaced through `snapshotReady` rather than being swallowed:
  // it still releases the instance lock.
  const snapshotReady = app.buildSnapshot();
  snapshotReady.catch(() => {});
  let closePromise = null;
  return {
    ...app,
    host,
    port: actualPort(app.server),
    snapshotReady,
    close: () => closePromise ??= (async () => {
      app.beginShutdown();
      parentWatchdog.stop();
      // Keep the listener referenced while workers drain: their shutdown
      // polling timers are unrefed and cannot keep the process alive alone.
      const results = await Promise.allSettled([
        app.shutdownRuntime(),
        app.closeWorkUsage(),
      ]);
      results.push(...await Promise.allSettled([
        app.closeModelPerformance(),
        app.closeProjectionReader(),
      ]));
      // A producer failure must not leave the listening socket behind.
      await closeHttpServer(app.server);
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    })(),
  };
}

if (process.argv[1]
    && resolve(process.argv[1]) === LOCAL_COMPANION_MODULE_FILE) {
  if (isInstalledAgentInvocation(process.argv.slice(2))) {
    try {
      await runInstalledAgentCli(process.argv.slice(2));
    } catch (error) {
      process.stdout.write(`${JSON.stringify(installedAgentErrorResult(error))}\n`);
      process.exitCode = 1;
    }
  } else {
    const requestedPort = Number(process.env.USAGE_MONITOR_PORT ?? 8787);
    const app = await startLocalCompanionServer({
      port: requestedPort,
      terminateProcessOnParentDeath: true,
    });
    process.stdout.write(`USAGE_MONITOR_READY http://${app.host}:${app.port}/\n`);
    let closing = false;
    const close = () => {
      if (closing) process.exit(0);
      closing = true;
      app.server.closeAllConnections?.();
      void app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    // A snapshot that cannot be built leaves nothing for the read routes to
    // project, so the process still exits and the host still sees a failed
    // companion - the same outcome as before the port moved ahead of the build,
    // reported once the port is open rather than in place of opening it.
    app.snapshotReady.catch(() => {
      if (closing) return;
      closing = true;
      app.server.closeAllConnections?.();
      void app.close().then(
        () => process.exit(1),
        () => process.exit(1),
      );
    });
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  }
}
