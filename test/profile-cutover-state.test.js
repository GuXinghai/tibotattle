import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  advanceProfileCutoverJournal, classifyProfileCutoverFailure, createProfileCutoverJournal,
  decodeProfileCutoverJournal, encodeProfileCutoverJournal, PROFILE_CUTOVER_JOURNAL_MAXIMUM_BYTES,
  summarizeProfileCutoverJournal,
} from "../scripts/lib/profile-cutover-state.mjs";

const sha = name => createHash("sha256").update(`synthetic:${name}`).digest("hex");
const binding = () => ({ operationId: "00000000-0000-4000-8000-000000000001", profile: "development",
  sourceManifestSha256: sha("source"), sourceRootIdentitySha256: sha("source-root"),
  backupRootIdentitySha256: sha("backup-root"), targetRootIdentitySha256: sha("target-root"),
  toolSha256: sha("tool"), candidateSha256: sha("candidate") });
const evidence = phase => ({
  prepared: { preflightReportSha256: sha("preflight") },
  backed_up: { sourceManifestSha256: sha("source"), backupManifestSha256: sha("backup"), readbackReportSha256: sha("backup-readback") },
  converted: { backupManifestSha256: sha("backup"), targetManifestSha256: sha("converted"), conversionReportSha256: sha("conversion") },
  verified: { targetManifestSha256: sha("converted"), semanticReportSha256: sha("semantics"), recoveryRehearsalReportSha256: sha("rehearsal") },
  activated: { targetManifestSha256: sha("converted"), activationReportSha256: sha("activation") },
  accepted: { activationReportSha256: sha("activation"), acceptanceReportSha256: sha("acceptance") },
  recovery_prepared: { activationReportSha256: sha("activation"), targetHistoryManifestSha256: sha("new-history"), writerExclusionReportSha256: sha("writers-stopped") },
  history_preserved: { targetHistoryManifestSha256: sha("new-history"), historyArchiveManifestSha256: sha("history-archive"), readbackReportSha256: sha("history-readback") },
  restored: { backupManifestSha256: sha("backup"), historyArchiveManifestSha256: sha("history-archive"), restoreReportSha256: sha("restore") },
})[phase];
const FORWARD = ["prepared", "backed_up", "converted", "verified", "activated", "accepted"];
const RECOVERY = ["recovery_prepared", "history_preserved", "restored"];
const category = code => error => error.message === "Profile cutover journal refused"
  && classifyProfileCutoverFailure(error) === `PROFILE_CUTOVER_${code}`;
const create = () => createProfileCutoverJournal(binding(), evidence("prepared"));
const request = (journal, phase, proof = evidence(phase)) => ({ binding: binding(),
  previousSha256: journal.events.at(-1).sha256, phase, evidence: proof });
const advance = (journal, phase, proof) => advanceProfileCutoverJournal(journal, request(journal, phase, proof));
const reopen = journal => decodeProfileCutoverJournal(encodeProfileCutoverJournal(journal, binding()), binding());
function at(phase) {
  let journal = create();
  for (const next of FORWARD.slice(1, FORWARD.indexOf(phase) + 1)) journal = advance(journal, next);
  return journal;
}

for (const phase of FORWARD) test(`canonical reopen at ${phase} preserves exact operation and evidence`, () => {
  const journal = at(phase), text = encodeProfileCutoverJournal(journal, binding());
  assert.deepEqual(reopen(journal), journal);
  assert.equal(encodeProfileCutoverJournal(reopen(journal), binding()), text);
  assert.equal(summarizeProfileCutoverJournal(journal, binding()).phase, phase);
  assert.ok(Object.isFrozen(journal) && Object.isFrozen(journal.binding)
    && Object.isFrozen(journal.events) && journal.events.every(event => Object.isFrozen(event) && Object.isFrozen(event.evidence)));
});

for (const phase of FORWARD.slice(1)) test(`interruption before/after ${phase} is retry-safe without duplicate steps`, () => {
  const before = at(FORWARD[FORWARD.indexOf(phase) - 1]), command = request(before, phase);
  const after = advanceProfileCutoverJournal(reopen(before), command);
  // Losing an acknowledgement after saving must not append the same action.
  const retried = advanceProfileCutoverJournal(reopen(after), command);
  assert.deepEqual(retried, after);
  assert.equal(retried.events.length, before.events.length + 1);
  assert.deepEqual(advanceProfileCutoverJournal(reopen(before), command), after);
  assert.deepEqual(before, at(FORWARD[FORWARD.indexOf(phase) - 1]), "earlier state is never mutated");
});

for (const start of ["activated", "accepted"]) test(`recovery from ${start} requires preserving post-cutover history first`, () => {
  let journal = at(start);
  assert.throws(() => advance(journal, "restored"), category("TRANSITION_INVALID"));
  for (const phase of RECOVERY) {
    const command = request(journal, phase);
    const next = advanceProfileCutoverJournal(reopen(journal), command);
    assert.deepEqual(advanceProfileCutoverJournal(reopen(next), command), next);
    if (phase === "recovery_prepared") assert.throws(() => advance(next, "restored"), category("TRANSITION_INVALID"));
    journal = next;
  }
  assert.equal(journal.events.at(-1).phase, "restored");
  assert.equal(journal.events.length, start === "accepted" ? 9 : 8);
  assert.equal(journal.events.find(event => event.phase === "backed_up").evidence.backupManifestSha256, sha("backup"));
  assert.equal(journal.events.at(-1).evidence.historyArchiveManifestSha256, sha("history-archive"));
  for (const phase of [...FORWARD, ...RECOVERY.slice(0, -1)]) {
    assert.throws(() => advance(journal, phase), category("TRANSITION_INVALID"));
  }
});

test("all forward and recovery transition pairs fail closed outside the permitted graph", () => {
  const allowed = { prepared: ["backed_up"], backed_up: ["converted"], converted: ["verified"],
    verified: ["activated"], activated: ["accepted", "recovery_prepared"], accepted: ["recovery_prepared"] };
  for (const source of FORWARD) for (const target of [...FORWARD, ...RECOVERY]) {
    if (allowed[source].includes(target)) assert.equal(advance(at(source), target).events.at(-1).phase, target);
    else if (source !== target) assert.throws(() => advance(at(source), target), category("TRANSITION_INVALID"));
  }
});

for (const key of Object.keys(binding())) test(`resume refuses changed ${key}`, () => {
  const other = binding();
  other[key] = key === "operationId" ? "00000000-0000-4000-8000-000000000002"
    : key === "profile" ? "stable" : sha(`changed-${key}`);
  assert.throws(() => decodeProfileCutoverJournal(encodeProfileCutoverJournal(at("verified"), binding()), other), category("BINDING_MISMATCH"));
  const command = request(at("verified"), "activated"); command.binding = other;
  assert.throws(() => advanceProfileCutoverJournal(at("verified"), command), category("BINDING_MISMATCH"));
});

test("stale acknowledgements, changed retries and replaying older phases never advance", () => {
  const prepared = create(), command = request(prepared, "backed_up");
  const backed = advanceProfileCutoverJournal(prepared, command), converted = advance(backed, "converted");
  assert.throws(() => advanceProfileCutoverJournal(converted, command), category("STALE_TIP"));
  assert.throws(() => advanceProfileCutoverJournal(backed, { ...command, evidence: { ...command.evidence, readbackReportSha256: sha("other") } }), category("RETRY_MISMATCH"));
  assert.throws(() => advanceProfileCutoverJournal(backed, { ...command, previousSha256: backed.events.at(-1).sha256 }), category("RETRY_MISMATCH"));
  assert.throws(() => advanceProfileCutoverJournal(backed, { ...request(backed, "converted"), previousSha256: sha("stale") }), category("STALE_TIP"));
});

const mismatches = [
  ["prepared", "backed_up", "sourceManifestSha256"],
  ["backed_up", "converted", "backupManifestSha256"],
  ["converted", "verified", "targetManifestSha256"],
  ["verified", "activated", "targetManifestSha256"],
  ["activated", "accepted", "activationReportSha256"],
  ["activated", "recovery_prepared", "activationReportSha256"],
];
for (const [before, phase, key] of mismatches) test(`${phase} must reference the exact prior ${key}`, () => {
  assert.throws(() => advance(at(before), phase, { ...evidence(phase), [key]: sha("wrong") }), category("EVIDENCE_MISMATCH"));
});

test("recovery rejects the wrong history or original backup, without dropping the archive binding", () => {
  let journal = advance(at("accepted"), "recovery_prepared");
  assert.throws(() => advance(journal, "history_preserved", { ...evidence("history_preserved"), targetHistoryManifestSha256: sha("stale-history") }), category("EVIDENCE_MISMATCH"));
  journal = advance(journal, "history_preserved");
  for (const key of ["backupManifestSha256", "historyArchiveManifestSha256"]) {
    assert.throws(() => advance(journal, "restored", { ...evidence("restored"), [key]: sha("wrong") }), category("EVIDENCE_MISMATCH"));
  }
});

test("unknown, unavailable, omitted or extra evidence refuses rather than becoming proof", () => {
  const journal = at("converted");
  for (const value of [null, undefined, false, 0, "unknown", "unavailable", "", "0".repeat(63), "A".repeat(64), sha("x") + "\n"]) {
    assert.throws(() => advance(journal, "verified", { ...evidence("verified"), recoveryRehearsalReportSha256: value }), category("EVIDENCE_INVALID"));
  }
  const missing = evidence("verified"); delete missing.recoveryRehearsalReportSha256;
  assert.throws(() => advance(journal, "verified", missing), category("EVIDENCE_INVALID"));
  assert.throws(() => advance(journal, "verified", { ...evidence("verified"), path: "synthetic-private-path" }), category("EVIDENCE_INVALID"));
  for (const phase of ["__proto__", "constructor", "unknown", null, 0]) {
    assert.throws(() => advance(journal, phase, {}), category("EVIDENCE_INVALID"));
  }
});

test("binding is closed, roots are distinct and profiles cannot be arbitrary paths", () => {
  for (const change of [{ profile: "C:\\synthetic" }, { operationId: "not-an-operation" }, { extra: true }, { toolSha256: null }]) {
    assert.throws(() => createProfileCutoverJournal({ ...binding(), ...change }, evidence("prepared")), category("BINDING_INVALID"));
  }
  for (const pair of [["sourceRootIdentitySha256", "backupRootIdentitySha256"],
    ["sourceRootIdentitySha256", "targetRootIdentitySha256"], ["backupRootIdentitySha256", "targetRootIdentitySha256"]]) {
    const value = binding(); value[pair[1]] = value[pair[0]];
    assert.throws(() => createProfileCutoverJournal(value, evidence("prepared")), category("ROOT_COLLISION"));
  }
});

test("modified or reordered chains, gaps, unknown schema and extra fields are rejected", () => {
  const original = at("accepted");
  const changes = [
    value => { value.events[2].evidence.conversionReportSha256 = sha("tampered"); },
    value => { value.events[2].sha256 = sha("tampered"); },
    value => { value.events[2].previousSha256 = sha("tampered"); },
    value => { value.events[0].previousSha256 = sha("tampered"); },
    value => { value.events[2].sequence = 20; },
    value => { value.events.splice(2, 1); },
    value => { [value.events[1], value.events[2]] = [value.events[2], value.events[1]]; },
    value => { value.events[1].extra = "private"; },
    value => { value.extra = "private"; },
    value => { value.schemaVersion = "newer-unknown-schema"; },
    value => { value.events = []; },
  ];
  for (const mutate of changes) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => encodeProfileCutoverJournal(value, binding()));
  }
});

test("wire encoding rejects duplicate keys, BOMs, noncanonical bytes, truncation and oversize", () => {
  const original = encodeProfileCutoverJournal(create(), binding());
  for (const text of [original.trimEnd(), original + "\n", "\ufeff" + original, original.slice(0, -8),
    original.replace('"sequence": 0', '"sequence": 5, "sequence": 0'),
    original.replace('"events": [', '"events": [], "events": ['),
    original.replace('"phase":', '"ph\\u0061se":'),
    JSON.stringify(JSON.parse(original))]) {
    assert.throws(() => decodeProfileCutoverJournal(text, binding()));
  }
  for (const text of [null, Buffer.from(original), " ".repeat(PROFILE_CUTOVER_JOURNAL_MAXIMUM_BYTES + 1)]) {
    assert.throws(() => decodeProfileCutoverJournal(text, binding()), category("JOURNAL_BYTES_INVALID"));
  }
});

test("object inputs refuse accessors, symbols, custom prototypes and sparse/extra array properties", () => {
  let calls = 0;
  const accessor = binding(); Object.defineProperty(accessor, "profile", { get() { calls++; throw new Error("private"); } });
  assert.throws(() => createProfileCutoverJournal(accessor, evidence("prepared")), category("BINDING_INVALID"));
  assert.equal(calls, 0);
  const symbol = binding(); symbol[Symbol("private")] = true;
  assert.throws(() => createProfileCutoverJournal(symbol, evidence("prepared")), category("BINDING_INVALID"));
  assert.throws(() => createProfileCutoverJournal(Object.assign(Object.create(null), binding()), evidence("prepared")), category("BINDING_INVALID"));
  const extra = structuredClone(create()); extra.events.private = true;
  assert.throws(() => encodeProfileCutoverJournal(extra, binding()), category("JOURNAL_INVALID"));
  const sparse = structuredClone(create()); sparse.events = Array(1);
  assert.throws(() => encodeProfileCutoverJournal(sparse, binding()), category("JOURNAL_INVALID"));
  const getter = structuredClone(create()); Object.defineProperty(getter.events, 0, { get() { calls++; return create().events[0]; } });
  assert.throws(() => encodeProfileCutoverJournal(getter, binding()), category("JOURNAL_INVALID"));
  assert.equal(calls, 0);
});

test("caller-owned objects cannot change frozen journal bindings or evidence after creation", () => {
  const selected = binding(), proof = evidence("prepared");
  const journal = createProfileCutoverJournal(selected, proof);
  selected.toolSha256 = sha("changed"); proof.preflightReportSha256 = sha("changed");
  assert.deepEqual(journal, create());
  const command = request(journal, "backed_up"), next = advanceProfileCutoverJournal(journal, command);
  command.evidence.backupManifestSha256 = sha("changed");
  assert.equal(next.events.at(-1).evidence.backupManifestSha256, sha("backup"));
  assert.throws(() => { next.events.at(-1).evidence.backupManifestSha256 = sha("changed"); }, TypeError);
});

test("console-safe summary excludes all private bindings and errors cannot be forged", () => {
  const summary = summarizeProfileCutoverJournal(at("accepted"), binding());
  assert.deepEqual(Object.keys(summary).sort(), ["events", "phase", "schemaVersion", "scope"]);
  assert.equal(summary.scope, "journal_contract_only");
  for (const value of Object.values(binding())) assert.equal(JSON.stringify(summary).includes(value), false);
  assert.equal(classifyProfileCutoverFailure({ code: "PROFILE_CUTOVER_EVIDENCE_INVALID" }), "PROFILE_CUTOVER_UNAVAILABLE");
  assert.equal(classifyProfileCutoverFailure(new Error("synthetic private context")), "PROFILE_CUTOVER_UNAVAILABLE");
});
