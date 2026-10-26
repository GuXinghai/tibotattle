import { spawn as nodeSpawn } from "node:child_process";

import {
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV,
  WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER,
} from "../../src/platform/index.js";
import { shellError } from "./errors.js";
import { isDesktopRefreshIntervalSeconds } from "./desktop-contract.js";
import { createCompanionReadyLineParser } from "./ready-line.js";
import { createCompanionStartupErrorParser } from "../../src/local-companion-startup-error.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

const COMPANION_PROCESS_LIFECYCLE_PHASES = new Set([
  "starting",
  "ready",
  "stopping",
]);

function companionProcessExitOutcome(exitCode, signalCode) {
  if (signalCode === "SIGABRT") return "signal_abrt";
  if (signalCode === "SIGSEGV") return "signal_segv";
  if (signalCode === "SIGKILL") return "signal_kill";
  if (signalCode === "SIGTERM") return "signal_term";
  if (typeof signalCode === "string") return "signal_other";
  return exitCode === 0 ? "exit_zero" : "exit_nonzero";
}

function emitCompanionProcessLifecycleEvent(observer, event, phase, exitCode, signalCode) {
  if (typeof observer !== "function") return;
  const selectedPhase = COMPANION_PROCESS_LIFECYCLE_PHASES.has(phase)
    ? phase : "starting";
  const value = Object.freeze({
    event,
    phase: selectedPhase,
    outcome: event === "started" ? null : companionProcessExitOutcome(exitCode, signalCode),
  });
  try {
    observer(value);
  } catch {
    // The optional diagnostic observer cannot alter supervisor lifecycle.
  }
}

// The renderer/launcher environment is not a credential transport. Keep the
// child input explicit: platform runtime discovery plus the reviewed
// Rhetrion/Codex/Claude configuration knobs only. NODE_OPTIONS, arbitrary
// provider credentials, and unrelated shell secrets never cross the boundary.
const COMPANION_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "CODEX_HOME",
  "CODEX_BIN",
  "CODEX_THREAD_ID",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PROJECT_DIRECTORY",
  "USAGE_MONITOR_ACCOUNTING_SOURCE_MODE",
  "USAGE_MONITOR_RESOURCE_ROOT",
  "USAGE_MONITOR_STATE_ROOT",
  "USAGE_MONITOR_REFRESH_INTERVAL_SECONDS",
  "USAGE_MONITOR_REFRESH_PAUSED",
  "USAGE_MONITOR_PREPARED_DIRECTORY",
  "USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION",
  "USAGE_MONITOR_TEST_LANE",
]);

function assertTimeout(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new TypeError(`${label} must be a bounded positive integer`);
  }
}

function discardStream(stream) {
  stream?.on?.("data", () => {});
  stream?.resume?.();
}

function killChild(child, signal) {
  try {
    child?.kill?.(signal);
  } catch {
    // The process may have exited between the bounded state transition and
    // kill(). The supervisor reports only its fixed lifecycle result.
  }
}

function disposeCredentialBroker(broker) {
  try { broker?.dispose?.(); } catch { /* Child teardown must still complete. */ }
}

function companionEnvironment(environment, parentPid, credentialBrokerKind = null) {
  const selected = {};
  for (const key of COMPANION_ENVIRONMENT_KEYS) {
    const value = environmentValue(environment, key);
    if (value !== undefined) selected[key] = value;
  }
  // The child is a Node companion launched by Electron, never another GUI.
  selected.ELECTRON_RUN_AS_NODE = "1";
  selected.USAGE_MONITOR_PORT = "0";
  selected.USAGE_MONITOR_PARENT_PID = String(parentPid);
  // Only an explicitly composed parent broker can announce this descriptor.
  // An inherited native-app FD is never accepted from the launch environment.
  if (credentialBrokerKind === "windows_account_observation") {
    selected[WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_ENV] =
      WINDOWS_ACCOUNT_OBSERVATION_BROKER_IPC_MARKER;
  }
  return selected;
}

function environmentValue(environment, key) {
  const candidates = environmentCandidates(environment, key);
  const stringCandidate = candidates.find((name) => typeof environment[name] === "string");
  return stringCandidate === undefined ? undefined : environment[stringCandidate];
}

function environmentCandidates(environment, key) {
  // Windows treats environment variable names without regard to case, while
  // callers and tests can still supply a plain object containing both PATH
  // and Path. Prefer the canonical allowlist spelling, then use a stable
  // ordinal name order so object insertion order cannot change the result.
  return Object.getOwnPropertyNames(environment)
    .filter((name) => name.toUpperCase() === key.toUpperCase())
    .sort((left, right) => {
      if (left === key) return right === key ? 0 : -1;
      if (right === key) return 1;
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

/**
 * Own exactly one local companion child. The supervisor never forwards child
 * output and never includes child error text in a rejection.
 */
export function createCompanionSupervisor({
  spawnChild = nodeSpawn,
  command = process.execPath,
  args = [],
  cwd,
  environment = process.env,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
  parentPid = process.pid,
  onUnexpectedExit,
  onChildLifecycleEvent,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  attachWindowsAccountObservationBroker,
} = {}) {
  if (typeof spawnChild !== "function") throw new TypeError("spawnChild is required");
  if (typeof command !== "string" || command.length === 0) {
    throw new TypeError("command is required");
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    throw new TypeError("args must be strings");
  }
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    throw new TypeError("environment must be an object");
  }
  if (attachWindowsAccountObservationBroker !== undefined
      && typeof attachWindowsAccountObservationBroker !== "function") {
    throw new TypeError("Windows account-observation broker factory is invalid");
  }
  assertTimeout(startupTimeoutMs, "startupTimeoutMs");
  assertTimeout(shutdownTimeoutMs, "shutdownTimeoutMs");
  if (!Number.isSafeInteger(parentPid) || parentPid < 2) {
    throw new TypeError("parentPid is invalid");
  }
  if (onUnexpectedExit !== undefined && typeof onUnexpectedExit !== "function") {
    throw new TypeError("onUnexpectedExit must be a function");
  }
  if (onChildLifecycleEvent !== undefined && typeof onChildLifecycleEvent !== "function") {
    throw new TypeError("onChildLifecycleEvent must be a function");
  }

  let state = "stopped";
  let child = null;
  let ready = null;
  let startPromise = null;
  let stopPromise = null;
  let generation = 0;
  let unexpectedExitHandler = onUnexpectedExit;
  let credentialBroker = null;
  let activeChildLifecycleObservation = null;
  let refreshIntervalSeconds = null;
  const selectedAccountObservationBroker = attachWindowsAccountObservationBroker;
  const requiresNodeIpc = selectedAccountObservationBroker !== undefined;
  const credentialBrokerKind = selectedAccountObservationBroker !== undefined
    ? "windows_account_observation" : null;

  function stateSnapshot() {
    return Object.freeze({
      state,
      hasChild: child !== null,
      origin: ready?.origin ?? null,
    });
  }

  function observeChildStarted(currentChild) {
    if (typeof onChildLifecycleEvent !== "function") return null;
    const observation = {
      child: currentChild,
      phase: "starting",
      exited: false,
    };
    activeChildLifecycleObservation = observation;
    emitCompanionProcessLifecycleEvent(onChildLifecycleEvent, "started", observation.phase);
    return observation;
  }

  function observeChildReady(observation) {
    if (observation !== null && observation.exited !== true) {
      observation.phase = "ready";
    }
  }

  function observeChildStopping(currentChild) {
    if (activeChildLifecycleObservation?.child === currentChild
        && activeChildLifecycleObservation.exited !== true) {
      activeChildLifecycleObservation.phase = "stopping";
    }
  }

  function observeChildExit(observation, exitCode, signalCode) {
    if (observation === null || observation.exited === true) return;
    observation.exited = true;
    if (activeChildLifecycleObservation === observation) {
      activeChildLifecycleObservation = null;
    }
    emitCompanionProcessLifecycleEvent(
      onChildLifecycleEvent,
      "exited",
      observation.phase,
      exitCode,
      signalCode,
    );
  }

  function start() {
    if (state === "ready") return Promise.resolve(ready);
    if (state === "starting" && startPromise !== null) return startPromise;
    if (state === "stopping") return Promise.reject(shellError("companion_busy"));

    const currentGeneration = ++generation;
    state = "starting";
    startPromise = new Promise((resolveStart, rejectStart) => {
      let settled = false;
      let startupTimer = null;
      let currentChild = null;
      let currentCredentialBroker = null;
      let currentChildLifecycleObservation = null;
      let parser;

      const cleanupStartup = () => {
        if (startupTimer !== null) clearTimer(startupTimer);
        startupTimer = null;
        currentChild?.stdout?.off?.("data", onStdout);
      };

      const terminateStartupChild = (target, done, {
        alreadyExited = false,
        lifecycleObservation = null,
      } = {}) => {
        if (alreadyExited || !target || typeof target.once !== "function") {
          if (alreadyExited) {
            observeChildExit(lifecycleObservation, target?.exitCode, target?.signalCode);
          }
          done();
          return;
        }
        let finished = false;
        let timer = null;
        const finish = (exitCode, signalCode, { exited = true } = {}) => {
          if (finished) return;
          finished = true;
          if (timer !== null) clearTimer(timer);
          target.removeListener?.("exit", finish);
          if (exited) observeChildExit(lifecycleObservation, exitCode, signalCode);
          done();
        };
        target.once("exit", finish);
        killChild(target, "SIGKILL");
        timer = setTimer(() => finish(undefined, undefined, { exited: false }), shutdownTimeoutMs);
        timer?.unref?.();
      };

      const fail = (error, { childAlreadyExited = false } = {}) => {
        if (settled) return;
        settled = true;
        cleanupStartup();
        disposeCredentialBroker(currentCredentialBroker);
        if (credentialBroker === currentCredentialBroker) credentialBroker = null;
        if (currentGeneration === generation) {
          state = "stopped";
          child = null;
          ready = null;
        }
        terminateStartupChild(
          currentChild,
          () => rejectStart(error),
          {
            alreadyExited: childAlreadyExited,
            lifecycleObservation: currentChildLifecycleObservation,
          },
        );
      };

      const succeed = (value) => {
        if (settled) return;
        settled = true;
        cleanupStartup();
        // The ready line is the only stdout contract. Keep draining any later
        // child output so a full pipe cannot stall the companion, but never
        // forward or retain that output in the desktop process.
        discardStream(currentChild?.stdout);
        if (currentGeneration !== generation) {
          killChild(currentChild, "SIGKILL");
          rejectStart(shellError("companion_busy"));
          return;
        }
        state = "ready";
        child = currentChild;
        ready = value;
        observeChildReady(currentChildLifecycleObservation);
        resolveStart(value);
      };

      const onStdout = (chunk) => {
        try {
          parser.feed(chunk);
        } catch {
          fail(shellError("companion_ready_invalid"));
        }
      };

      const onError = () => {
        fail(shellError("companion_spawn_failed"));
      };

      const onExit = (exitCode, signalCode) => {
        observeChildExit(currentChildLifecycleObservation, exitCode, signalCode);
        disposeCredentialBroker(currentCredentialBroker);
        if (credentialBroker === currentCredentialBroker) credentialBroker = null;
        if (!settled) {
          fail(shellError(startupFailureCode ?? "companion_exit_before_ready"), { childAlreadyExited: true });
          return;
        }
        currentChild?.off?.("error", onError);
        if (currentGeneration !== generation || child !== currentChild) return;
        child = null;
        ready = null;
        state = "stopped";
        try {
          unexpectedExitHandler?.(Object.freeze({ kind: "companion_exit" }));
        } catch {
          // The lifecycle observer cannot change the supervisor state.
        }
      };

      parser = createCompanionReadyLineParser({
        onReady: (value) => succeed(value),
      });
      try {
        currentChild = spawnChild(command, [...args], {
          cwd,
          env: companionEnvironment(environment, parentPid, credentialBrokerKind),
          // Fixed schedule control and the credential broker share the
          // inherited channel; neither exposes a general command transport.
          stdio: selectedAccountObservationBroker || refreshIntervalSeconds !== null
            ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        fail(shellError("companion_spawn_failed"));
        return;
      }
      if (!currentChild || typeof currentChild.once !== "function") {
        fail(shellError("companion_spawn_failed"));
        return;
      }
      currentChildLifecycleObservation = observeChildStarted(currentChild);
      const childAlreadyExited = Number.isSafeInteger(currentChild.exitCode)
        || typeof currentChild.signalCode === "string";
      if (childAlreadyExited || (requiresNodeIpc && currentChild.connected === false)) {
        fail(shellError("companion_exit_before_ready"), { childAlreadyExited });
        return;
      }
      try {
        if (selectedAccountObservationBroker) {
          currentCredentialBroker = selectedAccountObservationBroker(currentChild);
          if (typeof currentCredentialBroker?.dispose !== "function") {
            throw new TypeError("credential broker is invalid");
          }
          credentialBroker = currentCredentialBroker;
        }
      } catch { fail(shellError("companion_spawn_failed")); return; }
      let startupFailureCode = null;
      currentChild.stderr?.on?.("data", createCompanionStartupErrorParser((code) => {
        startupFailureCode = code;
      }));
      currentChild.stderr?.resume?.();
      if (!currentChild.stdout || typeof currentChild.stdout.on !== "function") {
        fail(shellError("companion_spawn_failed"));
        return;
      }
      currentChild.stdout.on("data", onStdout);
      currentChild.once("exit", onExit);
      currentChild.on?.("error", onError);
      startupTimer = setTimer(() => {
        fail(shellError("companion_start_timeout"));
      }, startupTimeoutMs);
      startupTimer?.unref?.();
    });
    startPromise.catch(() => {});
    return startPromise;
  }

  function stop() {
    if (stopPromise !== null) return stopPromise;
    if (child === null) {
      if (state === "starting") return Promise.reject(shellError("companion_busy"));
      state = "stopped";
      ready = null;
      return Promise.resolve();
    }

    const currentChild = child;
    const currentGeneration = generation;
    observeChildStopping(currentChild);
    state = "stopping";
    disposeCredentialBroker(credentialBroker);
    credentialBroker = null;
    ++generation;
    stopPromise = new Promise((resolveStop, rejectStop) => {
      let finished = false;
      let timer = null;
      const finish = (error = null) => {
        if (finished) return;
        finished = true;
        if (timer !== null) clearTimer(timer);
        currentChild.removeListener?.("exit", onStopExit);
        child = null;
        ready = null;
        state = "stopped";
        if (error === null) resolveStop();
        else rejectStop(error);
      };
      const onStopExit = () => finish();
      currentChild.once?.("exit", onStopExit);
      killChild(currentChild, "SIGTERM");
      timer = setTimer(() => {
        killChild(currentChild, "SIGKILL");
        finish(shellError("companion_shutdown_timeout"));
      }, shutdownTimeoutMs);
      timer?.unref?.();
      // Keep the generation referenced to make the intent explicit: a late
      // event from the old child cannot affect a later start.
      void currentGeneration;
    }).finally(() => {
      stopPromise = null;
    });
    stopPromise.catch(() => {});
    return stopPromise;
  }

  return Object.freeze({
    start,
    stop,
    setRefreshInterval(seconds, paused = false) {
      if (!isDesktopRefreshIntervalSeconds(seconds)) throw new TypeError("refresh interval is invalid");
      if (typeof paused !== "boolean") throw new TypeError("refresh pause is invalid");
      refreshIntervalSeconds = seconds;
      environment.USAGE_MONITOR_REFRESH_INTERVAL_SECONDS = String(seconds);
      environment.USAGE_MONITOR_REFRESH_PAUSED = String(paused);
      if (child === null || state !== "ready") return false;
      if (typeof child.send !== "function" || child.connected === false) {
        throw shellError("companion_refresh_interval_unavailable");
      }
      return new Promise((resolve, reject) => {
        try {
          child.send({ type: "usagemonitor.refresh-interval.v2", seconds, paused }, (error) => {
            if (error) reject(shellError("companion_refresh_interval_unavailable"));
            else resolve(true);
          });
        } catch { reject(shellError("companion_refresh_interval_unavailable")); }
      });
    },
    setUnexpectedExitHandler(handler) {
      if (handler !== undefined && typeof handler !== "function") {
        throw new TypeError("handler must be a function");
      }
      unexpectedExitHandler = handler;
    },
    get state() {
      return stateSnapshot();
    },
  });
}
