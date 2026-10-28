import { createHash } from "node:crypto";

export const PRESERVED_ACCOUNTING_HISTORY_SCHEMA = "local-accounting-preserved-history-v1";
export const PRESERVED_ACCOUNTING_HISTORY_META_KEY = "accounting_cache_history_v1";
export const PRESERVED_ACCOUNTING_HISTORY_MAXIMUM_BYTES = 128 * 1024 * 1024;
const SOURCE_SCHEMA = "local-replay-safe-accounting-v0.25";
const SOURCE_LIMIT = 64 * 1024 * 1024;
const SUMMARY_KEYS = ["generatedAt", "coveredAt", "sourceDescriptor", "history", "periods", "timeline",
  "quotaTimeline", "sparkUsageTimeline", "sparkQuotaTimeline", "priceBasis", "pricingMethodVersion",
  "priceEpochBasis", "priceRegistryVersion", "priceRegistryObservedAt"];
const KEYS = ["schemaVersion", "status", "sourceSchemaVersion", "sourceJsonSha256", "sourceCacheJson", "summary"];
const digest = value => createHash("sha256").update(value).digest("hex");
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Reflect.ownKeys(value).length === keys.length
  && keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));
const instant = value => typeof value === "string" && value.length <= 32
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const count = value => Number.isSafeInteger(value) && value >= 0;
const money = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

// This checks stored JSON, never provider inputs. The bounded local envelope is
// not a renderer DTO. Only the explicit small projection below may be exposed.
function boundedJson(value) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 2_000_000 || depth > 32) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return item.length <= SOURCE_LIMIT;
    if (Array.isArray(item)) return Reflect.ownKeys(item).length === item.length + 1
      && item.every(entry => visit(entry, depth + 1));
    if (!plain(item)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(item);
    return Reflect.ownKeys(descriptors).every(key => typeof key === "string"
      && key !== "__proto__" && key !== "constructor" && key !== "prototype"
      && Object.hasOwn(descriptors[key], "value") && visit(descriptors[key].value, depth + 1));
  };
  return visit(value, 0);
}

export function validatePreservedAccountingHistoryEnvelope(value) {
  if (!exact(value, KEYS) || value.schemaVersion !== PRESERVED_ACCOUNTING_HISTORY_SCHEMA
      || value.status !== "historical_only" || value.sourceSchemaVersion !== SOURCE_SCHEMA
      || typeof value.sourceCacheJson !== "string" || Buffer.byteLength(value.sourceCacheJson) < 2
      || Buffer.byteLength(value.sourceCacheJson) > SOURCE_LIMIT
      || !/^[a-f0-9]{64}$/u.test(value.sourceJsonSha256)
      || digest(value.sourceCacheJson) !== value.sourceJsonSha256
      || !exact(value.summary, SUMMARY_KEYS) || !boundedJson(value.summary)
      || !instant(value.summary.generatedAt)
      || !exact(value.summary.coveredAt, ["startAt", "endAt"])
      || !instant(value.summary.coveredAt.startAt) || !instant(value.summary.coveredAt.endAt)
      || Date.parse(value.summary.coveredAt.startAt) > Date.parse(value.summary.coveredAt.endAt)
      || !plain(value.summary.history) || !Array.isArray(value.summary.periods)
      || value.summary.periods.length > 32
      || !["timeline", "quotaTimeline", "sparkUsageTimeline", "sparkQuotaTimeline"]
        .every(key => Array.isArray(value.summary[key]) && value.summary[key].length <= 1_000_000)
      || !["priceBasis", "pricingMethodVersion", "priceEpochBasis", "priceRegistryVersion", "priceRegistryObservedAt"]
        .every(key => typeof value.summary[key] === "string" && value.summary[key].length <= 256)
      || Buffer.byteLength(JSON.stringify(value)) > PRESERVED_ACCOUNTING_HISTORY_MAXIMUM_BYTES) {
    throw Object.assign(new Error("Preserved accounting history is invalid"), { code: "preserved_accounting_history_invalid" });
  }
  return value;
}

// No old-format deserialization here: conversion owns that one-time work.
// Never return sourceCacheJson or the general local summary to the renderer.
export function projectPreservedAccountingHistorySummary(value) {
  const record = validatePreservedAccountingHistoryEnvelope(value);
  const history = record.summary.history;
  const projectPeriod = row => plain(row) && typeof row.id === "string" && /^[a-z0-9_-]{1,32}$/u.test(row.id)
    && typeof row.label === "string" && row.label.length > 0 && row.label.length <= 96 && !/[\u0000-\u001f]/u.test(row.label)
    && count(row.events) && count(row.totalTokens) && money(row.apiPriceEquivalentUsd)
    ? { id: row.id, label: row.label, events: row.events, totalTokens: row.totalTokens, apiPriceEquivalentUsd: row.apiPriceEquivalentUsd }
    : null;
  return {
    schemaVersion: "local-accounting-preserved-history-summary-v1",
    status: "historical_only",
    generatedAt: record.summary.generatedAt,
    coveredAt: { ...record.summary.coveredAt },
    priceBasis: record.summary.priceBasis,
    // This estimate is from its original evaluation, not the current setting.
    unknownSpeedPolicy: null,
    history: ["available", "unavailable"].includes(history.status) ? {
      status: history.status,
      coverageStatus: ["complete", "partial", "unavailable"].includes(history.coverage?.status)
        ? history.coverage.status : "unavailable",
      totals: history.status === "available" ? projectPeriod(history.period) : null,
    } : { status: "unavailable", coverageStatus: "unavailable", totals: null },
    periods: record.summary.periods.map(projectPeriod).filter(Boolean),
  };
}
