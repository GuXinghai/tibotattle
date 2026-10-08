import { resolve } from "node:path";

export const LOCAL_UNIFIED_INDEX_PUBLICATION_TIMEOUT_MS = 120_000;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// Process-local admission complements (rather than replaces) the filesystem,
// identity and recovery-lock checks. Other processes are handled by publication's
// bounded sharing-conflict retry, never by deleting the destination first.
export function createLocalUnifiedIndexPublicationCoordinator({
  platform = process.platform,
} = {}) {
  const states = new Map();
  function stateFor(path) {
    const key = resolve(path).toLowerCase();
    let state = states.get(key);
    if (!state) {
      state = { key, readers: new Set(), publishing: false, waiters: new Set() };
      states.set(key, state);
    }
    return state;
  }
  function notify(state) {
    for (const waiter of [...state.waiters]) waiter();
    if (states.get(state.key) === state
        && !state.publishing && !state.readers.size && !state.waiters.size) {
      states.delete(state.key);
    }
  }
  async function wait(state, predicate, signal, deadline) {
    if (signal?.aborted) throw failure("local_unified_index_aborted");
    if (predicate()) return;
    await new Promise((resolvePromise, reject) => {
      let timer;
      const finish = (error) => {
        clearTimeout(timer);
        state.waiters.delete(check);
        signal?.removeEventListener("abort", aborted);
        error ? reject(error) : resolvePromise();
      };
      const aborted = () => finish(failure("local_unified_index_aborted"));
      const check = () => { if (predicate()) finish(); };
      state.waiters.add(check);
      signal?.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(() => finish(failure(
        "local_unified_index_publication_timed_out",
      )), Math.max(0, deadline - performance.now()));
      check();
    });
  }
  return {
    assertReadable(path) {
      if (platform === "win32" && states.get(resolve(path).toLowerCase())?.publishing) {
        throw failure("local_unified_index_publication_busy");
      }
    },
    trackReader(path, database) {
      if (platform !== "win32") return database;
      const state = stateFor(path);
      if (state.publishing) {
        database.close();
        throw failure("local_unified_index_publication_busy");
      }
      const token = {};
      state.readers.add(token);
      const close = database.close.bind(database);
      database.close = (...args) => {
        try { return close(...args); }
        finally {
          if (database.isOpen === false) {
            state.readers.delete(token);
            notify(state);
          }
        }
      };
      return database;
    },
    async openReader(path, openIndex, { signal = null } = {}) {
      if (platform !== "win32") return openIndex();
      const deadline = performance.now() + LOCAL_UNIFIED_INDEX_PUBLICATION_TIMEOUT_MS;
      while (true) {
        const state = stateFor(path);
        await wait(state, () => !state.publishing, signal, deadline);
        if (signal?.aborted) throw failure("local_unified_index_aborted");
        // A publisher can enter before this continuation resumes. Rejoin its
        // wait instead of opening a connection across the publication barrier.
        if (stateFor(path).publishing) continue;
        try { return openIndex(); }
        finally { notify(state); }
      }
    },
    async publish(path, operation, {
      signal = null,
      timeoutMs = LOCAL_UNIFIED_INDEX_PUBLICATION_TIMEOUT_MS,
    } = {}) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError("publication timeout must be positive");
      }
      if (platform !== "win32") return operation();
      const state = stateFor(path);
      if (state.publishing) throw failure("local_unified_index_publication_busy");
      state.publishing = true;
      const deadline = performance.now() + timeoutMs;
      try {
        await wait(state, () => state.readers.size === 0, signal, deadline);
        if (signal?.aborted) throw failure("local_unified_index_aborted");
        return await operation(deadline);
      } finally {
        state.publishing = false;
        notify(state);
      }
    },
  };
}

export const localUnifiedIndexPublication =
  createLocalUnifiedIndexPublicationCoordinator();
