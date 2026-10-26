import { openOperation } from "./release-operation.mjs";
import { win32 } from "node:path";
import {
  advanceProfileCutoverJournal, classifyProfileCutoverFailure, createProfileCutoverJournal,
  decodeProfileCutoverJournal, encodeProfileCutoverJournal,
  PROFILE_CUTOVER_JOURNAL_SCHEMA, summarizeProfileCutoverJournal,
} from "./profile-cutover-state.mjs";

const errors = new WeakSet();
function failure(category) {
  const error = Object.assign(new Error("Profile cutover operation refused"), { code: `PROFILE_CUTOVER_${category}` });
  errors.add(error);
  return error;
}
export function classifyProfileCutoverOperationFailure(error) {
  return errors.has(error) ? error.code : classifyProfileCutoverFailure(error);
}
function storageFailure(error) {
  // Do not forward arbitrary native errors, paths or thrown context.
  const category = error?.code === "RELEASE_OPERATION_BUSY" ? "STORAGE_BUSY"
    : error?.code === "RELEASE_OPERATION_EXISTS_USE_RESUME" ? "RESUME_REQUIRED"
      : error?.code === "RELEASE_OPERATION_INPUT_MISMATCH" ? "BINDING_MISMATCH" : "STORAGE_UNAVAILABLE";
  return failure(category);
}

/** Persists only journal acknowledgements, never profile data. The reviewed
 * release-operation store supplies protected owner-only I/O, an exclusive
 * SQLite mutex and atomic expected-identity replacement. All native policy and
 * qualification limits of that store still apply. No Node filesystem fallback.
 *
 * Both new and resumed operations require the SAME original preflight evidence.
 * Binding it before creation lets a restart recover the initial empty-state
 * window without inventing proof or overwriting another operation. */
export async function openProfileCutoverOperation(options) {
  const required = ["directory", "binding", "preflightEvidence"];
  const allowed = [...required, "resume"];
  if (!options || Object.getPrototypeOf(options) !== Object.prototype
      || !required.every(key => Object.hasOwn(options, key))
      || !Reflect.ownKeys(options).every(key => allowed.includes(key)
        && Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), "value"))) throw failure("CONFIGURATION_INVALID");
  const { directory, binding, preflightEvidence, resume = false } = options;
  if (typeof directory !== "string" || directory.includes("\0")
      || !/^[A-Za-z]:[\\/]$/u.test(win32.parse(directory).root)
      || win32.resolve(directory) === win32.parse(directory).root
      || directory.split(/[\\/]/u).some(part => part === "." || part === "..")
      || typeof resume !== "boolean") throw failure("CONFIGURATION_INVALID");
  const initial = createProfileCutoverJournal(binding, preflightEvidence);
  const selected = initial.binding;
  let operation;
  try {
    operation = await openOperation({ directory, kind: "maintenance", resume,
      binding: { contract: PROFILE_CUTOVER_JOURNAL_SCHEMA, binding: selected, preflightEvidence: initial.events[0].evidence } });
  } catch (error) { throw storageFailure(error); }
  let journal, closed = false, busy = false, uncertain = false;
  try {
    const state = operation.record.state;
    if (Object.keys(state).length === 0) {
      // Only metadata initialization is resumed here. No backup/conversion/
      // activation action is automatically replayed after a crash.
      journal = initial;
      await operation.save({ journalText: encodeProfileCutoverJournal(journal, selected) });
    } else {
      if (Object.keys(state).join() !== "journalText") throw failure("STORAGE_STATE_INVALID");
      journal = decodeProfileCutoverJournal(state.journalText, selected);
      if (journal.events[0].sha256 !== initial.events[0].sha256) throw failure("STORAGE_STATE_INVALID");
    }
  } catch (error) {
    try { operation.close(); } catch { throw failure("STORAGE_CLOSE_FAILED"); }
    if (errors.has(error) || classifyProfileCutoverFailure(error) !== "PROFILE_CUTOVER_UNAVAILABLE") throw error;
    throw storageFailure(error);
  }
  return Object.freeze({
    // Private metadata; do not log or upload this journal. Only summary() is a
    // console projection. Frozen objects prevent an accidental mutable alias.
    get journal() {
      if (uncertain) throw failure("PERSISTENCE_UNCERTAIN");
      return journal;
    },
    summary() {
      return Object.freeze({ ...summarizeProfileCutoverJournal(journal, selected),
        persistence: uncertain ? "uncertain" : busy ? "saving" : closed ? "closed" : "settled" });
    },
    async advance(request) {
      if (closed) throw failure("OPERATION_CLOSED");
      if (uncertain) throw failure("PERSISTENCE_UNCERTAIN");
      if (busy) throw failure("OPERATION_BUSY");
      // Preserve the closed request contract rather than silently omitting
      // unexpected caller input (including paths or attempted rebindings).
      if (!request || Object.getPrototypeOf(request) !== Object.prototype
          || Reflect.ownKeys(request).length !== 3
          || !["previousSha256", "phase", "evidence"].every(key =>
            Object.hasOwn(Object.getOwnPropertyDescriptor(request, key) ?? {}, "value"))) throw failure("REQUEST_INVALID");
      const next = advanceProfileCutoverJournal(journal, { binding: selected, ...request });
      const text = encodeProfileCutoverJournal(next, selected);
      if (text === encodeProfileCutoverJournal(journal, selected)) return journal;
      busy = true;
      try {
        await operation.save({ journalText: text });
        journal = next;
        return journal;
      } catch {
        // An atomic save can fail after replacement. Do not keep mutating from
        // an uncertain in-memory tip; release and reopen the durable journal.
        uncertain = true;
        throw failure("PERSISTENCE_UNCERTAIN");
      } finally { busy = false; }
    },
    close() {
      if (closed) return;
      if (busy) throw failure("OPERATION_BUSY");
      closed = true;
      try { operation.close(); } catch { throw failure("STORAGE_CLOSE_FAILED"); }
    },
  });
}
