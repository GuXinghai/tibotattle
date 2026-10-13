import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Deterministic, content-free synthetic Codex rollout corpus.
 *
 * The generator reproduces the structural boundaries the unified-index
 * extractor consumes (session identity, turn contexts, cumulative token
 * counts, rate-limit windows, tool calls, inline forks, long-tail file sizes)
 * without any prompt, response or user text. Every string it emits comes from
 * a fixed vocabulary or a seeded random generator, so the output is a pure
 * function of its options.
 *
 * It writes only into a caller-supplied empty directory and is meant for tests
 * and benchmarks; production code must not import it.
 */

const DEFAULTS = Object.freeze({
  seed: 1,
  files: 2_400,
  events: 259_000,
  days: 323,
  endAt: "2026-10-01T00:00:00.000Z",
  forkFraction: 0.04,
  // Zipf-like skew of events per file; larger concentrates more events in few files.
  sizeSkew: 1.15,
  // Content-free filler per usage event, so byte volume can approximate real
  // rollouts without carrying any text.
  fillerBytesPerEvent: 2_048,
  quotaRate: 0.7,
  toolRate: 0.9,
  projects: 60,
  // Off by default so existing seeds keep their bytes. When on, the corpus also
  // crosses the long-context price boundary, uses Spark, an unrecognized model,
  // observed fast and ultrafast tiers, per-turn tier overrides, partial token
  // records and several surfaces, so a price-sensitive reader is exercised.
  variety: false,
});

const MODELS = Object.freeze([
  "gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex-mini",
]);
const MODEL_WEIGHTS = Object.freeze([0.42, 0.22, 0.14, 0.1, 0.08, 0.04]);
const TIERS = Object.freeze([undefined, "default", "priority"]);
const TIER_WEIGHTS = Object.freeze([0.47, 0.51, 0.02]);
const EFFORTS = Object.freeze(["low", "medium", "high"]);
const TOOLS = Object.freeze(["shell", "apply_patch", "read_file", "update_plan"]);
const VARIETY_MODELS = Object.freeze([
  "gpt-5.6-sol", "gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark",
  "gpt-5.2-codex", "gpt-5.1-codex-mini", "gpt-synthetic-unrecognized",
]);
const VARIETY_MODEL_WEIGHTS = Object.freeze([0.3, 0.2, 0.14, 0.1, 0.08, 0.08, 0.06, 0.04]);
const VARIETY_TIERS = Object.freeze([undefined, "default", "priority", "ultrafast"]);
const VARIETY_TIER_WEIGHTS = Object.freeze([0.4, 0.3, 0.2, 0.1]);
const VARIETY_INPUT_BOUNDARIES = Object.freeze([
  271_999, 272_000, 272_001, 272_002, 300_000, 640_000,
]);
const VARIETY_SESSION_SOURCES = Object.freeze([
  { thread_source: "user", originator: "codex_cli_rs" },
  { thread_source: "user", originator: "codex_vscode", source: "vscode" },
  { thread_source: "subagent", originator: "codex_cli_rs", source: "subagent" },
  { thread_source: "automation", originator: "codex_exec", source: "exec" },
  { thread_source: "user", originator: "codex_cli_rs", source: "cli" },
]);
const PLAN_TYPES = Object.freeze(["pro", "plus"]);
const EVENT_SPACING_MS = Object.freeze([15_000, 120_000]);
const TURN_LENGTH = 8;
const MAX_FORK_REPLAY = 5;

/** mulberry32: small seeded generator with a stable cross-runtime sequence. */
function createRandom(seed) {
  let state = (seed >>> 0) || 1;
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (low, high) => low + Math.floor(next() * (high - low + 1));
  const pick = (values, weights = null) => {
    if (weights === null) return values[Math.floor(next() * values.length)];
    let roll = next();
    for (let index = 0; index < values.length; index += 1) {
      roll -= weights[index];
      if (roll < 0) return values[index];
    }
    return values.at(-1);
  };
  return { next, int, pick };
}

function uuid(random) {
  const hex = (count) => Array.from({ length: count }, () => (
    Math.floor(random.next() * 16).toString(16)
  )).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

function resolveOptions(options) {
  const resolved = { ...DEFAULTS, ...options };
  for (const key of ["files", "events", "days", "projects"]) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] < 1) {
      throw new TypeError(`${key} must be a positive safe integer`);
    }
  }
  if (!Number.isSafeInteger(resolved.seed)) throw new TypeError("seed must be a safe integer");
  if (resolved.events < resolved.files) {
    throw new TypeError("events must be at least files");
  }
  if (!Number.isSafeInteger(resolved.fillerBytesPerEvent) || resolved.fillerBytesPerEvent < 0) {
    throw new TypeError("fillerBytesPerEvent must be a non-negative safe integer");
  }
  if (typeof resolved.variety !== "boolean") throw new TypeError("variety must be a boolean");
  for (const key of ["forkFraction", "quotaRate", "toolRate"]) {
    if (!(resolved[key] >= 0 && resolved[key] <= 1)) throw new TypeError(`${key} must be in [0, 1]`);
  }
  if (!Number.isFinite(Date.parse(resolved.endAt))) throw new TypeError("endAt must be an ISO instant");
  return resolved;
}

/** Distribute `events` over `files` with a Zipf-like long tail, at least one each. */
function eventCounts(random, files, events, skew) {
  const weights = Array.from({ length: files }, (_, index) => 1 / ((index + 1) ** skew));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const counts = weights.map(() => 1);
  let remaining = events - files;
  const shares = weights.map((weight) => Math.floor((weight / total) * remaining));
  for (let index = 0; index < files; index += 1) counts[index] += shares[index];
  remaining -= shares.reduce((sum, value) => sum + value, 0);
  for (let index = 0; remaining > 0; index = (index + 1) % files, remaining -= 1) counts[index] += 1;
  // The long tail should not be ordered by time: shuffle deterministically.
  for (let index = files - 1; index > 0; index -= 1) {
    const other = random.int(0, index);
    [counts[index], counts[other]] = [counts[other], counts[index]];
  }
  return counts;
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function rolloutName(startMs, id) {
  return `rollout-${isoAt(startMs).slice(0, 19).replaceAll(":", "-")}-${id}.jsonl`;
}

function usageBlock(random, variety = false, session = null) {
  let input;
  let cached;
  if (variety) {
    // A conversation grows: each request carries the previous context plus a
    // little, and its cache normally still holds the previous context. A cache
    // collapse (the miss a configuration change causes) now and then keeps
    // only a sliver, so lost cache tokens are plausibly re-sent as input.
    const previous = session === null ? 0 : session.previousInput;
    const restart = previous === 0 || random.next() < 0.04;
    const wide = random.next() < 0.05;
    input = wide
      ? random.pick(VARIETY_INPUT_BOUNDARIES)
      : restart
        ? random.int(1_000, 60_000)
        : previous + random.int(500, 24_000);
    cached = restart ? Math.floor(input * random.pick([0, 0.4]))
      : random.next() < 0.12
        ? Math.floor(input * 0.05)
        : Math.min(previous, input);
    if (session !== null) session.previousInput = input;
  } else {
    input = random.int(1_000, 180_000);
    cached = Math.floor(input * random.pick([0, 0.4, 0.8, 0.95]));
  }
  const output = random.int(50, 4_000);
  const reasoning = Math.floor(output * random.pick([0, 0.3, 0.6]));
  if (variety) {
    // Absent fields are unknown, never zero: omit one now and then.
    const shape = random.next();
    const block = {
      input_tokens: input,
      cached_input_tokens: cached,
      cache_write_input_tokens: 0,
      output_tokens: output,
      reasoning_output_tokens: reasoning,
      total_tokens: input + output,
    };
    if (shape < 0.08) delete block.cache_write_input_tokens;
    else if (shape < 0.14) delete block.reasoning_output_tokens;
    else if (shape < 0.18) delete block.cached_input_tokens;
    return block;
  }
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

function addUsage(total, last) {
  return Object.fromEntries(Object.entries(total).map(([key, value]) => [key, value + (last[key] ?? 0)]));
}

const FILLER_ALPHABET = "abcdefghijklmnopqrstuvwxyz";

function fillerLine(timestamp, bytes, random) {
  // Fixed-vocabulary letters only: size without semantics.
  const length = Math.max(0, bytes);
  const body = Array.from({ length }, () => FILLER_ALPHABET[Math.floor(random.next() * 26)]).join("");
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "synthetic_filler", filler: body },
  });
}

const FIVE_HOURS_MS = 5 * 3_600_000;
const WEEK_MS = 7 * 86_400_000;

function rateLimits(random, usedPercent, resetsAtSec, variety = false, at = 0, planSwitchMs = 0) {
  const limits = {
    limit_id: "codex",
    plan_type: random.pick(PLAN_TYPES),
    primary: { used_percent: usedPercent, window_minutes: 300, resets_at: resetsAtSec + 18_000 },
    secondary: { used_percent: Math.min(100, usedPercent / 4), window_minutes: 10_080, resets_at: resetsAtSec + 604_800 },
  };
  if (!variety) return limits;
  // A coherent allowance: fixed window boundaries and a percent that climbs
  // through each window and resets at its end, so a calibration has resets,
  // displayed steps and usage between them to work with.
  const fiveStart = Math.floor(at / FIVE_HOURS_MS) * FIVE_HOURS_MS;
  const weekStart = Math.floor(at / WEEK_MS) * WEEK_MS;
  const fraction = (value, start, span) => Math.min(99.9, ((value - start) / span) * 92);
  // One plan per era, so plan attribution has a stable label and one change.
  limits.plan_type = at < planSwitchMs ? "plus" : "pro";
  limits.primary = {
    used_percent: Math.round(fraction(at, fiveStart, FIVE_HOURS_MS)),
    window_minutes: 300,
    resets_at: (fiveStart + FIVE_HOURS_MS) / 1000,
  };
  limits.secondary = {
    used_percent: Math.round(fraction(at, weekStart, WEEK_MS)),
    window_minutes: 10_080,
    resets_at: (weekStart + WEEK_MS) / 1000,
  };
  const roll = random.next();
  // Two windows of one duration at one instant (a track conflict), a window
  // without a reset instant, and the ends of the percent range.
  if (roll < 0.03) limits.secondary.window_minutes = 300;
  else if (roll < 0.05) delete limits.primary.resets_at;
  else if (roll < 0.06) limits.primary.used_percent = 0;
  else if (roll < 0.07) limits.primary.used_percent = 100;
  else if (roll < 0.09) limits.limit_id = "codex_bengalfox";
  return limits;
}

/**
 * Build the lines of one source. `parentLines` are the fork parent's
 * replayable token_count lines (already serialized), emitted before the
 * child's own history. Returns the lines plus the number of own usage events.
 */
function buildSource(random, config, {
  sessionId, parentId, parentReplay, startMs, eventCount, projects,
}) {
  const lines = [];
  const sourceShape = config.variety
    ? random.pick(VARIETY_SESSION_SOURCES)
    : { thread_source: "user", originator: "codex_cli_rs" };
  const meta = {
    timestamp: isoAt(startMs),
    type: "session_meta",
    payload: {
      id: sessionId,
      session_id: sessionId,
      ...sourceShape,
      cwd: projects[0],
      ...(parentId === null ? {} : { forked_from_id: parentId }),
    },
  };
  lines.push(JSON.stringify(meta));
  const tier = config.variety
    ? random.pick(VARIETY_TIERS, VARIETY_TIER_WEIGHTS)
    : random.pick(TIERS, TIER_WEIGHTS);
  const models = config.variety ? VARIETY_MODELS : MODELS;
  const modelWeights = config.variety ? VARIETY_MODEL_WEIGHTS : MODEL_WEIGHTS;
  if (tier !== undefined) {
    lines.push(JSON.stringify({
      timestamp: isoAt(startMs),
      type: "event_msg",
      payload: { type: "thread_settings_applied", thread_settings: { service_tier: tier, reasoning_effort: "medium" } },
    }));
  }
  let model = random.pick(models, modelWeights);
  let total = {
    input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
    output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0,
  };
  for (const replay of parentReplay) {
    lines.push(replay.line);
    total = replay.total;
  }
  let at = startMs;
  let toolEvents = 0;
  let quotaEvents = 0;
  const growth = config.variety ? { previousInput: 0 } : null;
  for (let index = 0; index < eventCount; index += 1) {
    at += random.int(EVENT_SPACING_MS[0], EVENT_SPACING_MS[1]);
    const timestamp = isoAt(at);
    if (index % TURN_LENGTH === 0) {
      if (random.next() < 0.1) model = random.pick(models, modelWeights);
      const turnTier = config.variety && random.next() < 0.15
        ? random.pick(["default", "priority", "ultrafast"])
        : undefined;
      lines.push(JSON.stringify({
        timestamp,
        type: "turn_context",
        payload: {
          turn_id: `t${index}`,
          cwd: random.pick(projects),
          model,
          effort: random.pick(EFFORTS),
          ...(turnTier === undefined ? {} : { service_tier: turnTier }),
        },
      }));
    }
    if (random.next() < config.toolRate) {
      toolEvents += 1;
      lines.push(JSON.stringify({
        timestamp,
        type: "response_item",
        payload: { type: "function_call", name: random.pick(TOOLS), call_id: `c${index}` },
      }));
    }
    if (config.fillerBytesPerEvent > 0) {
      lines.push(fillerLine(timestamp, config.fillerBytesPerEvent, random));
    }
    const last = usageBlock(random, config.variety, growth);
    total = addUsage(total, last);
    const withQuota = random.next() < config.quotaRate;
    if (withQuota) quotaEvents += 1;
    lines.push(JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: total, last_token_usage: last },
        ...(withQuota
          ? { rate_limits: rateLimits(random, Math.min(99, (at / 86_400_000) % 100), Math.floor(at / 1000), config.variety, at, config.planSwitchMs) }
          : {}),
      },
    }));
    if (config.variety && random.next() < 0.06) {
      // A status update: quota reported again with no spend, either on an
      // unchanged cumulative total or with no usage object at all.
      const statusAt = at + 1_000;
      lines.push(JSON.stringify({
        timestamp: isoAt(statusAt),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: random.next() < 0.5
            ? { total_token_usage: total, last_token_usage: last }
            : null,
          rate_limits: rateLimits(random, 0, Math.floor(statusAt / 1000), true, statusAt, config.planSwitchMs),
        },
      }));
    }
  }
  return { lines, finalTotal: total, toolEvents, quotaEvents, endMs: at };
}

/**
 * Generate the corpus under `root` (an absolute, empty or missing directory).
 * Returns a content-free receipt: counts, byte volume and a digest of the
 * generated bytes, so determinism is checkable without reading the files.
 */
export function generateSyntheticCodexCorpus(root, options = {}) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new TypeError("root must be an absolute path");
  }
  const config = resolveOptions(options);
  try {
    if (readdirSync(root).length > 0) throw new Error("synthetic corpus root must be empty");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const random = createRandom(config.seed);
  config.planSwitchMs = Date.parse(config.endAt) - Math.floor(config.days * 86_400_000 * 0.45);
  const projects = Array.from({ length: config.projects }, (_, index) => `/synthetic/project-${index}`);
  const counts = eventCounts(random, config.files, config.events, config.sizeSkew);
  const spanMs = config.days * 86_400_000;
  const startMs = Date.parse(config.endAt) - spanMs;
  const digest = createHash("sha256");
  const sources = [];
  let bytes = 0;
  let toolEvents = 0;
  let quotaEvents = 0;
  let forks = 0;
  let ownEvents = 0;
  for (let index = 0; index < config.files; index += 1) {
    // Start times increase with the file index, with jitter, so a fork parent
    // always precedes its child.
    const sessionStart = startMs + Math.floor((index / config.files) * spanMs) + random.int(0, 3_600_000);
    const sessionId = uuid(random);
    const parent = index > 0 && random.next() < config.forkFraction
      ? sources[random.int(Math.max(0, index - 50), index - 1)]
      : null;
    const replay = parent === null ? [] : parent.replay.slice(0, MAX_FORK_REPLAY);
    const built = buildSource(random, config, {
      sessionId,
      parentId: parent === null ? null : parent.sessionId,
      parentReplay: replay,
      startMs: sessionStart,
      eventCount: counts[index],
      projects,
    });
    if (parent !== null) forks += 1;
    const day = isoAt(sessionStart).slice(0, 10).split("-");
    const directory = join(root, "sessions", day[0], day[1], day[2]);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = rolloutName(sessionStart, sessionId);
    const text = `${built.lines.join("\n")}\n`;
    writeFileSync(join(directory, name), text, { mode: 0o600 });
    digest.update(name).update("\0").update(text);
    bytes += Buffer.byteLength(text);
    toolEvents += built.toolEvents;
    quotaEvents += built.quotaEvents;
    ownEvents += counts[index];
    // The first few token_count lines of this source can be replayed by a child.
    const replayable = [];
    let running = null;
    for (const line of built.lines) {
      if (replayable.length >= MAX_FORK_REPLAY) break;
      if (!line.includes('"token_count"')) continue;
      const info = JSON.parse(line).payload.info;
      // A status update carries no usage object to replay.
      if (info === null || info === undefined) continue;
      running = info.total_token_usage;
      replayable.push({ line, total: running });
    }
    sources.push({
      sessionId,
      replay: replayable,
      dir: directory,
      name,
      endMs: built.endMs,
      finalTotal: built.finalTotal,
    });
  }
  return Object.freeze({
    seed: config.seed,
    files: config.files,
    events: ownEvents,
    forks,
    toolEvents,
    quotaEvents,
    bytes,
    digest: digest.digest("hex"),
    sources: sources.map(({ dir, name }) => join(dir, name)),
  });
}

/**
 * Append `events` new usage events to each source in `paths`, as an active
 * session would. Content-free and deterministic for a given seed and the
 * file's current length. Returns the number of events written.
 */
export function appendSyntheticCodexEvents(paths, { seed = 1, events = 3, fillerBytesPerEvent = 2_048, atMs } = {}) {
  const random = createRandom(seed);
  let written = 0;
  for (const path of paths) {
    const timeMs = atMs ?? Date.now();
    const lines = [];
    let total = {
      input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
      output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0,
    };
    // Continue the cumulative counters from the file's own last token_count.
    const existing = readLastTotals(path);
    if (existing !== null) total = existing;
    for (let index = 0; index < events; index += 1) {
      const timestamp = isoAt(timeMs + (index + 1) * 1_000);
      if (fillerBytesPerEvent > 0) lines.push(fillerLine(timestamp, fillerBytesPerEvent, random));
      const last = usageBlock(random);
      total = addUsage(total, last);
      lines.push(JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } },
      }));
      written += 1;
    }
    appendFileSync(path, `${lines.join("\n")}\n`);
  }
  return written;
}

function readLastTotals(path) {
  // Sources written by this module end with a token_count line; read the tail.
  const text = readTail(path);
  const lines = text.split("\n").filter((line) => line.includes('"token_count"'));
  const line = lines.at(-1);
  if (line === undefined) return null;
  try {
    return JSON.parse(line).payload.info.total_token_usage;
  } catch {
    return null;
  }
}

function readTail(path, maxBytes = 64 * 1024) {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
