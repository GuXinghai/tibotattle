import { constants as fsConstants } from "node:fs";
import { access, stat, lstat, readdir, realpath } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { deriveOpenAIAccountScope, sanitizeAccountScope } from "./account-scope.js";
import { normalizeProviderPlanType } from "./plan-normalization.js";
import {
  sanitizeProviderQuotaLimitDisplayName,
  sanitizeProviderQuotaLimitId,
} from "./quota-metadata.js";
import { normalizeProviderQuotaWindow } from "./quota-normalization.js";
import { RELEASE_VERSION } from "../../../config/release-manifest.js";

const DEFAULT_TIMEOUT_MS = 20_000;
let rateLimitReadTail = Promise.resolve();
const BINARY_VERSION_TIMEOUT_MS = 5_000;
const BINARY_VERSION_MAXIMUM_BYTES = 4_096;
const CODEX_BINARY_DIAGNOSTIC_SCHEMA_VERSION = "codex-binary-diagnostic-v0.2";
const execFileAsync = promisify(execFile);
const windowsBinaryCache = { key: null, selected: null };
const ACCOUNT_HMAC_ENV = "APP_USAGEMONITOR_ACCOUNT_HMAC_KEY";
const VOLATILE_RESET_CREDIT_INVENTORY = Symbol(
  "usagemonitor.volatileResetCreditInventory",
);
const MAX_RESET_CREDIT_DETAILS = 1_024;
const MAX_RESET_CREDIT_COUNT = 1_000_000;
const SAFE_RESET_CREDIT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const RESET_CREDIT_FINGERPRINT_DOMAIN =
  "app-usagemonitor/reset-credit-fingerprint/v1\u0000";
// The app's Keychain broker announcement names a descriptor in *this*
// process, and this child's descriptor 0 is a different file entirely. No
// secret leaks — the child cannot reach the socketpair — but an announcement
// that resolves to an unrelated descriptor is a trap for anything downstream
// that trusts it, so the key never crosses the spawn.
const KEYCHAIN_BROKER_FD_ENV = "USAGE_MONITOR_KEYCHAIN_BROKER_FD";

export function codexAppServerChildEnv(environment = process.env) {
  const childEnvironment = { ...environment };
  delete childEnvironment[ACCOUNT_HMAC_ENV];
  delete childEnvironment[KEYCHAIN_BROKER_FD_ENV];
  return childEnvironment;
}

async function isExecutable(path, accessFile = access, statFile = stat) {
  try {
    if (!(await statFile(path)).isFile()) return false;
    await accessFile(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCodexBinary({
  environment = process.env,
  accessFile = access,
  statFile = stat,
  platform = process.platform,
  lstatFile = lstat,
  readDirectory = readdir,
  resolvePath = realpath,
  readVersion = readCodexBinaryVersion,
  now = () => performance.now(),
  forceRefresh = false,
  binaryCache = environment === process.env && statFile === stat && readVersion === readCodexBinaryVersion
    ? windowsBinaryCache : null,
} = {}) {
  const candidates = [{
    binary: environment.CODEX_BIN,
    source: "environment_override",
    location: "explicit_override",
  }];
  for (const candidate of candidates.filter((candidate) => (
    typeof candidate.binary === "string" && candidate.binary.length > 0
  ))) {
    if (await isExecutable(candidate.binary, accessFile, statFile)) return candidate;
  }
  if (platform === "win32") {
    const envValue = (name) => {
      const key = Object.keys(environment).sort().find((key) => key.toUpperCase() === name);
      return key === undefined ? undefined : environment[key];
    };
    const path = typeof envValue("PATH") === "string" ? envValue("PATH") : "";
    const localAppData = envValue("LOCALAPPDATA");
    const cacheKey = `${path}\0${localAppData ?? ""}`;
    if (binaryCache && !forceRefresh && binaryCache.key === cacheKey
        && binaryCache.selected && await isExecutable(binaryCache.selected.binary, accessFile, statFile)) {
      const selected = binaryCache.selected;
      try {
        if (selected.location !== "user_windows_cli"
            || (!(await lstatFile(selected.binary)).isSymbolicLink()
              && await resolvePath(selected.binary) === selected.binary)) return selected;
      } catch { /* Removal between the cache check and identity check forces rediscovery. */ }
    }
    if (binaryCache) { binaryCache.key = null; binaryCache.selected = null; }
    const deadline = now() + BINARY_VERSION_TIMEOUT_MS;
    const discover = async () => {
      const validate = async (candidate) => {
        const remaining = Math.floor(deadline - now());
        if (remaining <= 0) return false;
        let timer;
        try {
          const version = normalizedCodexBinaryVersion(await Promise.race([
            readVersion(candidate, { environment, timeoutMs: remaining }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("binary_probe_timeout")), remaining); }),
          ]));
          return now() < deadline ? version : null;
        } catch { return false; }
        finally { clearTimeout(timer); }
      };
      const remember = (selected) => {
        if (now() >= deadline) return null;
        if (binaryCache) { binaryCache.key = cacheKey; binaryCache.selected = selected; }
        return selected;
      };
      for (const directory of path.split(";")) {
        const clean = directory.trim().replace(/^"|"$/gu, "");
        if (!isAbsolute(clean)) continue;
        const binary = join(clean, "codex.exe");
        if (await isExecutable(binary, accessFile, statFile)) {
          const version = await validate(binary);
          if (version) return remember({ binary, source: "path", location: "path", version });
        }
        if (now() >= deadline) break;
      }
      if (typeof localAppData === "string" && isAbsolute(localAppData) && now() < deadline) {
        const root = join(localAppData, "OpenAI", "Codex", "bin");
        try {
          const rootMetadata = await lstatFile(root);
          if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return null;
          const canonicalRoot = await resolvePath(root);
          const expectedRoot = join(await resolvePath(localAppData), "OpenAI", "Codex", "bin");
          if (relative(expectedRoot, canonicalRoot) !== "") return null;
          const directories = [];
          for (const entry of await readDirectory(root, { withFileTypes: true })) {
            if (now() >= deadline) break;
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const metadata = await lstatFile(join(root, entry.name));
            if (!metadata.isDirectory() || metadata.isSymbolicLink() || !Number.isFinite(metadata.mtimeMs)) continue;
            directories.push({ name: entry.name, mtimeMs: metadata.mtimeMs });
          }
          directories.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name, "en"));
          for (const directory of directories.slice(0, 3)) {
            if (now() >= deadline) break;
            const binary = join(root, directory.name, "codex.exe");
            try {
              const metadata = await lstatFile(binary);
              if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
              const canonical = await resolvePath(binary);
              const within = relative(canonicalRoot, canonical);
              if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) continue;
              if (await isExecutable(canonical, accessFile, statFile)) {
                const version = await validate(canonical);
                if (version) return remember({ binary: canonical, source: "codex_bundled", location: "user_windows_cli", version });
              }
            } catch { /* A rotated or invalid candidate cannot widen discovery. */ }
          }
        } catch { /* A missing desktop installation preserves the PATH fallback. */ }
      }
      return null;
    };
    let deadlineTimer;
    try {
      const selected = await Promise.race([
        discover(),
        new Promise((resolve) => { deadlineTimer = setTimeout(() => resolve(null), BINARY_VERSION_TIMEOUT_MS); }),
      ]);
      if (selected !== null) return selected;
    } finally { clearTimeout(deadlineTimer); }
  }
  return { binary: "codex", source: "path", location: "path" };
}

export async function findCodexBinary(options = {}) {
  return (await resolveCodexBinary(options)).binary;
}

async function readCodexBinaryVersion(binary, {
  environment = process.env,
  timeoutMs = BINARY_VERSION_TIMEOUT_MS,
} = {}) {
  const { stdout } = await execFileAsync(binary, ["--version"], {
    encoding: "utf8",
    env: codexAppServerChildEnv(environment),
    maxBuffer: BINARY_VERSION_MAXIMUM_BYTES,
    timeout: timeoutMs,
    windowsHide: true,
  });
  return stdout;
}

function normalizedCodexBinaryVersion(value) {
  if (typeof value !== "string" || value.length > BINARY_VERSION_MAXIMUM_BYTES) {
    return null;
  }
  const pattern = /^(?:codex(?:-cli)?\s+)?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u;
  for (const line of value.split(/\r?\n/u)) {
    const match = pattern.exec(line.trim());
    if (match) return match[1];
  }
  return null;
}

/**
 * Resolve the same binary precedence as the app-server client, but return only
 * a path-free, closed diagnostic. Version inspection is best effort: doctor
 * must still identify the selected source when an old or broken binary cannot
 * answer `--version`.
 */
export async function inspectCodexBinary({
  environment = process.env,
  accessFile = access,
  statFile = stat,
  platform = process.platform,
  readVersion = readCodexBinaryVersion,
  ...discoveryOptions
} = {}) {
  const selected = await resolveCodexBinary({
    environment, accessFile, statFile, platform, readVersion, ...discoveryOptions,
  });
  let version = selected.version ?? null;
  try {
    if (version === null) version = normalizedCodexBinaryVersion(await readVersion(selected.binary, {
      environment,
    }));
  } catch {
    // Reachability is established separately by app-server initialization.
    // Never copy process errors, stderr, or a raw path into this diagnostic.
  }
  return {
    schemaVersion: CODEX_BINARY_DIAGNOSTIC_SCHEMA_VERSION,
    source: selected.source,
    location: selected.location,
    versionStatus: version === null ? "unavailable" : "available",
    version,
  };
}

export class CodexAppServerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "CodexAppServerError";
    this.code = code;
  }
}

function classifyAppServerFailure(error, stderr = "") {
  const detail = `${error?.message ?? ""} ${stderr}`.toLowerCase();
  if (error?.code === "ENOENT") return "app_server_unavailable";
  if (detail.includes("auth") || detail.includes("login") || detail.includes("token")) return "authentication_failure";
  if (detail.includes("json") || detail.includes("malformed") || detail.includes("parse")) return "malformed_output";
  return "temporary_disconnect";
}

export class CodexAppServerClient extends EventEmitter {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, spawnProcess = spawn, findBinary = findCodexBinary } = {}) {
    super();
    this.timeoutMs = timeoutMs;
    this.spawnProcess = spawnProcess;
    this.findBinary = findBinary;
    this.child = null;
    this.binary = null;
    this.lines = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.stderr = "";
    this.closed = false;
    this.malformedMessages = 0;
    this.rateLimitParamsSupported = true;
  }

  async start() {
    if (this.child) return this;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const binary = await this.findBinary({ forceRefresh: attempt > 0 });
      try { return await this.#startOnce(binary); }
      catch (error) {
        if (attempt > 0 || error?.code !== "app_server_unavailable") throw error;
        this.lines?.close();
        this.child?.kill("SIGTERM");
        this.child = null;
        this.lines = null;
        this.stderr = "";
      }
    }
  }

  async #startOnce(binary) {
    try {
      this.child = this.spawnProcess(binary, ["app-server"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: codexAppServerChildEnv(),
      });
    } catch (error) {
      throw new CodexAppServerError(classifyAppServerFailure(error), "Unable to start the Codex app-server", { cause: error });
    }
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-2_000);
    });
    this.lines.on("line", (line) => this.#handleLine(line));
    const startedChild = this.child;
    this.child.once("error", (error) => {
      if (this.child === startedChild) this.#handleDisconnect(error);
    });
    this.child.once("exit", (code, signal) => {
      if (this.closed || this.child !== startedChild) return;
      this.#handleDisconnect(new Error(`Codex app-server exited (${code ?? signal})`));
    });
    await this.request("initialize", {
      clientInfo: {
        name: "app_usagemonitor",
        title: "Usage Monitor",
        version: RELEASE_VERSION,
      },
      capabilities: {
        optOutNotificationMethods: ["remoteControl/status/changed"],
      },
    }, { requestId: 0 });
    this.notify("initialized", {});
    this.binary = binary;
    return this;
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.malformedMessages += 1;
      this.emit("protocolWarning", { code: "malformed_output" });
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new CodexAppServerError("request_failed", message.error.message ?? "Codex app-server request failed");
        error.rpcCode = Number.isInteger(message.error.code) ? message.error.code : null;
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (message.method === "account/rateLimits/updated") {
      this.emit("rateLimitsUpdated", message.params ?? null);
    } else if (message.method === "account/updated" || message.method === "account/login/completed") {
      // Account-change notifications can contain identity/login material. The
      // collector only needs an invalidation signal, never that payload.
      this.emit("accountChanged");
    }
  }

  #handleDisconnect(error) {
    if (this.closed) return;
    const code = classifyAppServerFailure(error, this.stderr);
    const wrapped = new CodexAppServerError(code, "Codex app-server disconnected", { cause: error });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(wrapped);
    }
    this.pending.clear();
    this.emit("disconnect", { code });
  }

  request(method, params, { requestId = null } = {}) {
    if (method === "account/rateLimits/read") {
      return this.readRateLimits({
        excludeResetCreditDetails: params?.excludeResetCreditDetails === true,
      });
    }
    return this.#sendRequest(method, params, { requestId });
  }

  #sendRequest(method, params, { requestId = null } = {}) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new CodexAppServerError("temporary_disconnect", "Codex app-server is not writable"));
    }
    const id = requestId ?? this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError("request_timeout", `Codex app-server request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (!this.child?.stdin?.writable) return false;
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    return true;
  }

  readRateLimits(options = {}) {
    // Quota reads are stateful observations. Keep one wire request active at a
    // time, including the legacy-parameter retry, while preserving each
    // caller's requested projection. A rejected or timed-out read releases the
    // queue so the next poll can retry.
    const previous = rateLimitReadTail;
    let release;
    rateLimitReadTail = new Promise((resolve) => { release = resolve; });
    const operation = (async () => {
      await previous;
      try {
        if (this.closed) {
          throw new CodexAppServerError("temporary_disconnect", "Codex app-server client closed");
        }
        return await this.#readRateLimits(options);
      } finally {
        release();
      }
    })();
    return this.#raceClose(operation);
  }

  #raceClose(operation) {
    if (this.closed) {
      return Promise.reject(new CodexAppServerError("temporary_disconnect", "Codex app-server client closed"));
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => this.removeListener("closed", onClose);
      const onClose = () => {
        cleanup();
        reject(new CodexAppServerError("temporary_disconnect", "Codex app-server client closed"));
      };
      this.once("closed", onClose);
      operation.then((value) => {
        cleanup();
        resolve(value);
      }, (error) => {
        cleanup();
        reject(error);
      });
      if (this.closed) onClose();
    });
  }

  async #readRateLimits({ excludeResetCreditDetails = false } = {}) {
    // Passive readers must never advertise automatic Luna Reserve fallback.
    const params = excludeResetCreditDetails === true && this.rateLimitParamsSupported
      ? { excludeResetCreditDetails: true }
      : undefined;
    try {
      return await this.#sendRequest("account/rateLimits/read", params);
    } catch (error) {
      // Older servers can reject object params. Retry that protocol failure
      // once, without params; auth, timeout and transport failures propagate.
      if (params === undefined || error.code !== "request_failed"
          || ![-32600, -32602].includes(error.rpcCode)) throw error;
      this.rateLimitParamsSupported = false;
      return this.#sendRequest("account/rateLimits/read");
    }
  }

  readAccount() {
    return this.request("account/read", {});
  }

  readAccountUsage() {
    return this.request("account/usage/read", {});
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexAppServerError("temporary_disconnect", "Codex app-server client closed"));
    }
    this.pending.clear();
    this.lines?.close();
    this.child?.kill("SIGTERM");
  }
}

export async function readCodexAccountSnapshot({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createClient = (options) => new CodexAppServerClient(options),
} = {}) {
  const client = createClient({ timeoutMs });
  try {
    await client.start();
    const accountBefore = await client.readAccount();
    const [rateLimits, accountUsage] = await Promise.all([
      client.readRateLimits(),
      client.readAccountUsage(),
    ]);
    const accountAfter = await client.readAccount();
    return {
      account: accountAfter,
      accountBefore,
      accountAfter,
      rateLimits,
      accountUsage,
      binary: client.binary,
    };
  } finally {
    client.close();
  }
}

function sanitizeLimitWindow(window) {
  if (!window) return null;
  return normalizeProviderQuotaWindow(window);
}

export function sanitizeRateLimit(limit, fallbackLimitId = "unknown") {
  if (!limit || typeof limit !== "object" || Array.isArray(limit)) return null;
  return {
    limitId: sanitizeProviderQuotaLimitId(limit.limitId ?? fallbackLimitId),
    limitName: sanitizeProviderQuotaLimitDisplayName(limit.limitName),
    primary: sanitizeLimitWindow(limit.primary),
    secondary: sanitizeLimitWindow(limit.secondary),
    planType: normalizeProviderPlanType(limit.planType),
    rateLimitReachedType: limit.rateLimitReachedType ?? null,
    spendControlReached: limit.spendControlReached ?? null,
    credits: limit.credits
      ? {
          hasCredits: limit.credits.hasCredits ?? null,
          unlimited: limit.credits.unlimited ?? null,
        }
      : null,
  };
}

function sanitizeUsageSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const result = {};
  for (const field of ["currentStreakDays", "lifetimeTokens", "longestRunningTurnSec", "longestStreakDays", "peakDailyTokens"]) {
    const value = summary[field];
    result[field] = Number.isFinite(value) && value >= 0 ? value : null;
  }
  return result;
}

function resetCreditInstant(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  const milliseconds = value * 1_000;
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return undefined;
  }
}

function resetCreditFingerprint(id, accountHmacKey) {
  if (accountHmacKey === null || accountHmacKey === undefined) return null;
  try {
    return `reset-credit:v1:${createHmac("sha256", accountHmacKey)
      .update(RESET_CREDIT_FINGERPRINT_DOMAIN, "utf8")
      .update(id, "utf8")
      .digest("base64url")}`;
  } catch {
    return null;
  }
}

function sanitizeResetCreditDetail(value, accountHmacKey) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.id !== "string"
      || !SAFE_RESET_CREDIT_ID.test(value.id)
      || (value.status !== undefined && value.status !== "available")) {
    return null;
  }
  const grantedAt = resetCreditInstant(value.grantedAt ?? null);
  const expiresAt = resetCreditInstant(value.expiresAt ?? null);
  const id = resetCreditFingerprint(value.id, accountHmacKey);
  if (grantedAt === undefined || expiresAt === undefined || id === null) return null;
  return Object.freeze({ id, grantedAt, expiresAt });
}

function sanitizeResetCreditInventory(value, accountHmacKey) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !Number.isSafeInteger(value.availableCount)
      || value.availableCount < 0
      || value.availableCount > MAX_RESET_CREDIT_COUNT) return null;
  if (!Array.isArray(value.credits)) {
    return Object.freeze({
      availableCount: value.availableCount,
      detailsStatus: "unavailable",
      credits: Object.freeze([]),
    });
  }
  if (value.credits.length > MAX_RESET_CREDIT_DETAILS
      || value.credits.length > value.availableCount) {
    return Object.freeze({
      availableCount: value.availableCount,
      detailsStatus: "unavailable",
      credits: Object.freeze([]),
    });
  }
  const credits = value.credits.map((credit) => (
    sanitizeResetCreditDetail(credit, accountHmacKey)
  ));
  const ids = new Set(credits.filter(Boolean).map((credit) => credit.id));
  if (credits.includes(null) || ids.size !== credits.length) {
    return Object.freeze({
      availableCount: value.availableCount,
      detailsStatus: "unavailable",
      credits: Object.freeze([]),
    });
  }
  return Object.freeze({
    availableCount: value.availableCount,
    detailsStatus: credits.length === value.availableCount
      ? "complete"
      : "partial",
    credits: Object.freeze(credits),
  });
}

/**
 * Read the local-only reset-credit inventory attached by the sanitizer. Its
 * IDs are already account-keyed fingerprints. The symbol key survives
 * internal object spread but is invisible to ordinary JSON, stable quota
 * records, diagnostics, and the browser contract; only the bounded collector
 * continuity checkpoint may deliberately retain the fingerprint projection.
 */
export function volatileResetCreditInventory(snapshot) {
  return snapshot?.[VOLATILE_RESET_CREDIT_INVENTORY] ?? null;
}

export function sanitizeCodexAccountSnapshot(snapshot, capturedAt, {
  accountHmacKey = null,
  accountCredentialUnavailableReason = null,
} = {}) {
  const raw = snapshot.rateLimits;
  if (!raw?.rateLimits) {
    throw new Error(raw?.error?.message ?? "Codex did not return a canonical rate-limit snapshot");
  }
  const canonical = sanitizeRateLimit(raw.rateLimits);
  if (canonical === null) {
    throw new Error("Codex returned a malformed canonical rate-limit snapshot");
  }
  const additional = Object.entries(raw.rateLimitsByLimitId ?? {}).flatMap(([id, limit]) => {
      const sanitized = sanitizeRateLimit(limit, id);
      return sanitized === null ? [] : [[sanitized.limitId, sanitized]];
    });
  // The canonical entry and keyed entries are representations of ONE response,
  // not sequential observations. Validate before an object/map can overwrite one.
  const slots=new Map(),windows=new Map();
  for(const limit of [canonical,...additional.map(([,limit])=>limit)]){
    for(const slot of ['primary','secondary']){
      const window=limit[slot];if(window===null)continue;
      const slotKey=JSON.stringify([limit.limitId,slot]);
      const value=JSON.stringify([window.usedPercent,window.windowDurationMins,window.resetsAt]);
      const windowKey=JSON.stringify([limit.limitId,window.windowDurationMins,window.resetsAt]);
      if(slots.has(slotKey)&&slots.get(slotKey)!==value
        ||windows.has(windowKey)&&windows.get(windowKey)!==window.usedPercent){
        throw new CodexAppServerError('malformed_output','Conflicting quota windows in one app-server response');
      }
      slots.set(slotKey,value);windows.set(windowKey,window.usedPercent);
    }
  }
  const byLimitId = Object.fromEntries(additional);
  if (!Object.hasOwn(byLimitId, canonical.limitId)) {
    byLimitId[canonical.limitId] = canonical;
  }

  const usage = snapshot.accountUsage;
  const dailyUsageBuckets = Array.isArray(usage?.dailyUsageBuckets)
    ? usage.dailyUsageBuckets
        .filter((bucket) => typeof bucket?.startDate === "string" && Number.isFinite(bucket?.tokens))
        .map((bucket) => ({ date: bucket.startDate, tokens: bucket.tokens }))
    : [];
  const currentAccount = Object.hasOwn(snapshot, "accountAfter")
    ? snapshot.accountAfter
    : snapshot.account;
  const providerPlanType = normalizeProviderPlanType(
    currentAccount?.account?.planType ?? canonical.planType,
  );
  let accountScope = sanitizeAccountScope(deriveOpenAIAccountScope(currentAccount, {
    secret: accountHmacKey,
    planType: providerPlanType,
    unavailableSecretReason: accountCredentialUnavailableReason,
  }));
  if (Object.hasOwn(snapshot, "accountBefore") || Object.hasOwn(snapshot, "accountAfter")) {
    const afterAccount = Object.hasOwn(snapshot, "accountAfter")
      ? snapshot.accountAfter
      : snapshot.account;
    const before = sanitizeAccountScope(deriveOpenAIAccountScope(snapshot.accountBefore, {
      secret: accountHmacKey,
      planType: normalizeProviderPlanType(snapshot.accountBefore?.account?.planType ?? canonical.planType),
      unavailableSecretReason: accountCredentialUnavailableReason,
    }));
    const after = sanitizeAccountScope(deriveOpenAIAccountScope(afterAccount, {
      secret: accountHmacKey,
      planType: normalizeProviderPlanType(snapshot.accountAfter?.account?.planType ?? canonical.planType),
      unavailableSecretReason: accountCredentialUnavailableReason,
    }));
    if (before.status !== "available" || after.status !== "available") {
      accountScope = after.status === "unavailable" ? after : before;
    } else {
      const knownPlans = new Set([
        before.planType,
        after.planType,
        canonical.planType,
        ...additional.map(([, limit]) => limit.planType),
      ].filter((plan) => plan !== null && plan !== "unknown"));
      if (before.scopeId !== after.scopeId || knownPlans.size > 1) {
        throw new CodexAppServerError(
          "request_failed",
          "Codex account or plan changed during quota observation",
        );
      }
    }
  }

  const result = {
    capturedAt,
    accountScope,
    ordinaryUsageAllowed: accountScope.status === "available"
      && typeof raw.ordinaryUsageAllowed === "boolean" ? raw.ordinaryUsageAllowed : null,
    canonical,
    byLimitId,
    officialDailyTokens: dailyUsageBuckets,
    officialUsageSummary: sanitizeUsageSummary(usage?.summary),
  };
  Object.defineProperty(result, VOLATILE_RESET_CREDIT_INVENTORY, {
    value: sanitizeResetCreditInventory(
      raw.rateLimitResetCredits,
      accountHmacKey,
    ),
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return result;
}

async function loadAccountObservationSecretSafely(loadAccountObservationSecret) {
  if (typeof loadAccountObservationSecret !== "function") {
    return { secret: null, unavailableReason: "credential_unavailable" };
  }
  try {
    const secret = await loadAccountObservationSecret();
    if (!Buffer.isBuffer(secret) || secret.byteLength !== 32) {
      if (Buffer.isBuffer(secret)) secret.fill(0);
      return { secret: null, unavailableReason: "credential_unavailable" };
    }
    return { secret, unavailableReason: null };
  } catch (error) {
    let unavailableReason = "credential_unavailable";
    if (error?.code === "account_observation_credential_locked") {
      unavailableReason = "credential_locked";
    } else if (error?.code
        === "account_observation_credential_migration_required") {
      unavailableReason = "credential_migration_required";
    }
    return {
      secret: null,
      unavailableReason,
    };
  }
}

export async function deriveOpenAIAccountScopeWithSecretLoader(accountRead, {
  loadAccountObservationSecret,
  planType = null,
} = {}) {
  const loaded = await loadAccountObservationSecretSafely(loadAccountObservationSecret);
  try {
    return sanitizeAccountScope(deriveOpenAIAccountScope(accountRead, {
      secret: loaded.secret,
      planType,
      unavailableSecretReason: loaded.unavailableReason,
    }));
  } finally {
    loaded.secret?.fill(0);
  }
}

export async function sanitizeCodexAccountSnapshotWithSecretLoader(snapshot, capturedAt, {
  loadAccountObservationSecret,
} = {}) {
  const loaded = await loadAccountObservationSecretSafely(loadAccountObservationSecret);
  try {
    return sanitizeCodexAccountSnapshot(snapshot, capturedAt, {
      accountHmacKey: loaded.secret,
      accountCredentialUnavailableReason: loaded.unavailableReason,
    });
  } finally {
    loaded.secret?.fill(0);
  }
}

/**
 * A matching account read on each side is provisional evidence, not an exact
 * bridge to a rollout occurrence. Unknown identity remains unattributed;
 * a known account or plan change invalidates the quota observation entirely.
 */
export async function sanitizeBracketedCodexAccountSnapshotWithSecretLoader(snapshot, capturedAt, {
  loadAccountObservationSecret,
} = {}) {
  return sanitizeCodexAccountSnapshotWithSecretLoader(snapshot, capturedAt, {
    loadAccountObservationSecret,
  });
}
