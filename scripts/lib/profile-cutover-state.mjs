import { createHash } from "node:crypto";
import { stableJson } from "../../src/export/canonical-json.js";

// Tool-side journal contract only. No filesystem, credential or activation API.
// Digests bind reports supplied by an orchestrator; they do not authenticate
// those reports or prove that a backup, native check or recovery actually ran.
// A hash chain is not a signature or an anti-rollback anchor: restoring an
// earlier valid prefix cannot be detected without separately retained evidence.
export const PROFILE_CUTOVER_JOURNAL_SCHEMA = "usage-monitor-profile-cutover-journal-v1";
export const PROFILE_CUTOVER_JOURNAL_MAXIMUM_BYTES = 32 * 1024;
const BINDING_KEYS = [
  "operationId", "profile", "sourceManifestSha256", "sourceRootIdentitySha256",
  "backupRootIdentitySha256", "targetRootIdentitySha256", "toolSha256", "candidateSha256",
];
const EVIDENCE_KEYS = Object.freeze({
  prepared: ["preflightReportSha256"],
  backed_up: ["sourceManifestSha256", "backupManifestSha256", "readbackReportSha256"],
  converted: ["backupManifestSha256", "targetManifestSha256", "conversionReportSha256"],
  verified: ["targetManifestSha256", "semanticReportSha256", "recoveryRehearsalReportSha256"],
  activated: ["targetManifestSha256", "activationReportSha256"],
  accepted: ["activationReportSha256", "acceptanceReportSha256"],
  recovery_prepared: ["activationReportSha256", "targetHistoryManifestSha256", "writerExclusionReportSha256"],
  history_preserved: ["targetHistoryManifestSha256", "historyArchiveManifestSha256", "readbackReportSha256"],
  restored: ["backupManifestSha256", "historyArchiveManifestSha256", "restoreReportSha256"],
});
const NEXT = Object.freeze({
  prepared: ["backed_up"],
  backed_up: ["converted"],
  converted: ["verified"],
  verified: ["activated"],
  activated: ["accepted", "recovery_prepared"],
  accepted: ["recovery_prepared"],
  recovery_prepared: ["history_preserved"],
  history_preserved: ["restored"],
  restored: [],
});
const errors = new WeakSet();
function fail(category) {
  const error = Object.assign(new Error("Profile cutover journal refused"), {
    code: `PROFILE_CUTOVER_${category}`,
  });
  errors.add(error);
  throw error;
}
export function classifyProfileCutoverFailure(error) {
  return errors.has(error) ? error.code : "PROFILE_CUTOVER_UNAVAILABLE";
}
const hash = value => createHash("sha256").update(stableJson(value)).digest("hex");
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function exact(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length
    && keys.every(key => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], "value"));
}
function denseArray(value, maximum) {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
    && value.length > 0 && value.length <= maximum
    && Reflect.ownKeys(value).length === value.length + 1
    && Array.from({ length: value.length }, (_, index) =>
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, index) ?? {}, "value")).every(Boolean);
}
function bindingCopy(value) {
  if (!exact(value, BINDING_KEYS)
      || typeof value.operationId !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.operationId)
      || !["stable", "development", "preview"].includes(value.profile)
      || !BINDING_KEYS.slice(2).every(key => digest(value[key]))) fail("BINDING_INVALID");
  const roots = [value.sourceRootIdentitySha256, value.backupRootIdentitySha256, value.targetRootIdentitySha256];
  if (new Set(roots).size !== roots.length) fail("ROOT_COLLISION");
  return Object.fromEntries(BINDING_KEYS.map(key => [key, value[key]]));
}
function evidenceCopy(phase, value) {
  if (typeof phase !== "string" || !Object.hasOwn(EVIDENCE_KEYS, phase)
      || !exact(value, EVIDENCE_KEYS[phase])
      || !EVIDENCE_KEYS[phase].every(key => digest(value[key]))) fail("EVIDENCE_INVALID");
  return Object.fromEntries(EVIDENCE_KEYS[phase].map(key => [key, value[key]]));
}
function freezeJournal(journal) {
  Object.freeze(journal.binding);
  for (const event of journal.events) { Object.freeze(event.evidence); Object.freeze(event); }
  Object.freeze(journal.events);
  return Object.freeze(journal);
}
function eventDigest(binding, event) {
  return hash({ bindingSha256: hash(binding), sequence: event.sequence,
    phase: event.phase, evidence: event.evidence, previousSha256: event.previousSha256 });
}
function reference(evidence, key, expected) {
  if (evidence[key] !== expected) fail("EVIDENCE_MISMATCH");
}
function validateReferences(phase, evidence, binding, seen) {
  if (phase === "backed_up") reference(evidence, "sourceManifestSha256", binding.sourceManifestSha256);
  if (phase === "converted" || phase === "restored") {
    reference(evidence, "backupManifestSha256", seen.get("backed_up").evidence.backupManifestSha256);
  }
  if (phase === "verified" || phase === "activated") {
    reference(evidence, "targetManifestSha256", seen.get("converted").evidence.targetManifestSha256);
  }
  if (phase === "accepted" || phase === "recovery_prepared") {
    reference(evidence, "activationReportSha256", seen.get("activated").evidence.activationReportSha256);
  }
  if (phase === "history_preserved") {
    reference(evidence, "targetHistoryManifestSha256", seen.get("recovery_prepared").evidence.targetHistoryManifestSha256);
  }
  if (phase === "restored") {
    reference(evidence, "historyArchiveManifestSha256", seen.get("history_preserved").evidence.historyArchiveManifestSha256);
  }
}
function validateJournal(value, expectedBinding) {
  const expected = bindingCopy(expectedBinding);
  if (!exact(value, ["schemaVersion", "binding", "events"])
      || value.schemaVersion !== PROFILE_CUTOVER_JOURNAL_SCHEMA
      || !denseArray(value.events, 9)) fail("JOURNAL_INVALID");
  const binding = bindingCopy(value.binding);
  if (hash(binding) !== hash(expected)) fail("BINDING_MISMATCH");
  const seen = new Map(), events = [];
  let previous = null;
  for (const raw of value.events) {
    if (!exact(raw, ["sequence", "phase", "evidence", "previousSha256", "sha256"])
        || raw.sequence !== events.length
        || raw.previousSha256 !== (previous?.sha256 ?? null) || !digest(raw.sha256)) fail("CHAIN_INVALID");
    const evidence = evidenceCopy(raw.phase, raw.evidence);
    if (previous === null ? raw.phase !== "prepared" : !NEXT[previous.phase].includes(raw.phase)) fail("TRANSITION_INVALID");
    validateReferences(raw.phase, evidence, binding, seen);
    const event = { sequence: raw.sequence, phase: raw.phase, evidence,
      previousSha256: raw.previousSha256, sha256: raw.sha256 };
    if (eventDigest(binding, event) !== raw.sha256) fail("CHAIN_INVALID");
    seen.set(raw.phase, event); events.push(event); previous = event;
  }
  const journal = { schemaVersion: PROFILE_CUTOVER_JOURNAL_SCHEMA, binding, events };
  if (Buffer.byteLength(stableJson(journal)) > PROFILE_CUTOVER_JOURNAL_MAXIMUM_BYTES) fail("JOURNAL_TOO_LARGE");
  return freezeJournal(journal);
}

export function createProfileCutoverJournal(binding, evidence) {
  const selected = bindingCopy(binding);
  const event = { sequence: 0, phase: "prepared", evidence: evidenceCopy("prepared", evidence), previousSha256: null };
  event.sha256 = eventDigest(selected, event);
  return freezeJournal({ schemaVersion: PROFILE_CUTOVER_JOURNAL_SCHEMA, binding: selected, events: [event] });
}

/** Call only after the real action and its independent verification have run.
 * Persist the returned journal with an owner-only atomic, exclusive writer.
 * This reducer neither performs those actions nor makes persistence durable. */
export function advanceProfileCutoverJournal(value, request) {
  if (!exact(request, ["binding", "previousSha256", "phase", "evidence"])) fail("REQUEST_INVALID");
  const journal = validateJournal(value, request.binding);
  const evidence = evidenceCopy(request.phase, request.evidence);
  const tip = journal.events.at(-1);
  if (request.phase === tip.phase) {
    // A retry of the exact most recent acknowledgement is idempotent. Replaying
    // older steps after further progress, or changing its evidence, is not.
    if (request.previousSha256 !== tip.previousSha256 || hash(evidence) !== hash(tip.evidence)) fail("RETRY_MISMATCH");
    return journal;
  }
  if (request.previousSha256 !== tip.sha256) fail("STALE_TIP");
  if (!NEXT[tip.phase].includes(request.phase)) fail("TRANSITION_INVALID");
  validateReferences(request.phase, evidence, journal.binding, new Map(journal.events.map(event => [event.phase, event])));
  const event = { sequence: journal.events.length, phase: request.phase, evidence, previousSha256: tip.sha256 };
  event.sha256 = eventDigest(journal.binding, event);
  return freezeJournal({ ...journal, events: [...journal.events, event] });
}

/** Canonical bytes are deliberately the only accepted wire encoding. This also
 * rejects duplicate JSON keys, extra whitespace, BOMs and ambiguous encodings. */
export function encodeProfileCutoverJournal(value, expectedBinding) {
  return stableJson(validateJournal(value, expectedBinding));
}
export function decodeProfileCutoverJournal(text, expectedBinding) {
  if (typeof text !== "string" || Buffer.byteLength(text) > PROFILE_CUTOVER_JOURNAL_MAXIMUM_BYTES) fail("JOURNAL_BYTES_INVALID");
  let value;
  try { value = JSON.parse(text); } catch { fail("JOURNAL_JSON_INVALID"); }
  const journal = validateJournal(value, expectedBinding);
  if (stableJson(journal) !== text) fail("JOURNAL_ENCODING_INVALID");
  return journal;
}

// Safe to display; contains no operation ID, path, manifest or secret digest.
export function summarizeProfileCutoverJournal(value, expectedBinding) {
  const journal = validateJournal(value, expectedBinding);
  return Object.freeze({ schemaVersion: journal.schemaVersion, phase: journal.events.at(-1).phase,
    events: journal.events.length, scope: "journal_contract_only" });
}
