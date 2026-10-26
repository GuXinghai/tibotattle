import { createWindowsFilesystemAdapter, createWindowsProtectedStateStore, createWindowsBrowserProfileStore } from "../../src/platform/index.js";
import { readApplicationPackage, pinApplicationProfilePaths } from "./application-profile.js";
import identity from "../../config/application-identity.cjs";
import brand from "../../config/product-brand.cjs";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { launchDesktopRuntime } from "./desktop-runtime.js";
import { createDesktopTrayIconFactory, resolveDesktopApplicationIcon } from "./desktop-tray.js";
import { createDesktopStartupDiagnostics } from "./desktop-startup-diagnostics.js";
import { validateProductionDistributionMetadata } from "./desktop-updater.js";
import { ELECTRON_ENTRY_FAILURE_DIAGNOSTIC, shellError } from "./errors.js";
import { assertElectronPlatformGate } from "./platform-gate.js";
import {
  createWindowsNormalCandidateCredentialHandover,
  createWindowsDevelopmentReadOnlyCredentialHandover,
} from "./desktop-windows-accountless-credential.js";
import {
  createWindowsElectronQualificationContext,
  WINDOWS_ELECTRON_QUALIFICATION_MARKER,
  WINDOWS_ELECTRON_TEST_LANE,
  runWindowsElectronQualificationCredentialCommand,
  runWindowsElectronQualificationCredentialProbe,
  assertWindowsElectronQualificationContext,
} from "./windows-qualification.js";
import {
  classifyWindowsAccountObservationSmokeFailure,
  runWindowsAccountObservationQualificationSmoke,
} from "./windows-account-observation-qualification-smoke.js";

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_COMPANION_SCRIPT = resolve(MODULE_DIRECTORY, "../local/server.js");
const DEFAULT_RESOURCE_ROOT = resolve(MODULE_DIRECTORY, "../..");
const ELECTRON_SMOKE_CONTROL = "quit-v1";
export const ELECTRON_COMPANION_PROCESS_DIAGNOSTIC_PREFIX =
  "USAGE_MONITOR_ELECTRON_COMPANION_PROCESS ";
export const ELECTRON_DASHBOARD_FAILURE_DIAGNOSTIC_PREFIX =
  "USAGE_MONITOR_ELECTRON_DASHBOARD_FAILURE ";
const ELECTRON_SHELL_BOOTSTRAP = Symbol("electron-shell-bootstrap");
const WINDOWS_ELECTRON_SMOKE_CONTROL = "windows-v1";
const WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE = "windows-electron-smoke-v1";
const WINDOWS_ELECTRON_SMOKE_COMMAND_MESSAGE = "command-v1";
const WINDOWS_ELECTRON_SMOKE_STATE_MESSAGE = "state-v1";
const WINDOWS_ELECTRON_SMOKE_CREDENTIAL_MESSAGE = "credential-v1";
const WINDOWS_ELECTRON_SMOKE_QUIT_MESSAGE = "quit-v1";
const WINDOWS_ELECTRON_SMOKE_ACCEPTED_STATUS = "accepted-v1";
const WINDOWS_ELECTRON_SMOKE_PASSED_STATUS = "passed-v1";
const WINDOWS_ELECTRON_SMOKE_FAILED_STATUS = "failed-v1";
const WINDOWS_ELECTRON_SMOKE_COMMANDS = new Set([
  "status-v1",
  "tray-show-v1",
  "tray-hide-v1",
  "tray-toggle-v1",
  "credential-probe-v1",
  "credential-create-v1",
  "credential-read-v1",
  "credential-delete-v1",
  "account-observation-storage-v1",
  "quit-v1",
]);
const WINDOWS_ELECTRON_SMOKE_CREDENTIAL_OPERATIONS = Object.freeze({
  "credential-probe-v1": "probe-v1",
  "credential-create-v1": "create-v1",
  "credential-read-v1": "read-v1",
  "credential-delete-v1": "delete-v1",
});

async function markStartupDiagnostics(startupDiagnostics, phase) {
  try {
    if (typeof startupDiagnostics?.checkpoint === "function") {
      await startupDiagnostics.checkpoint(phase);
    } else {
      await startupDiagnostics?.mark?.(phase);
    }
  } catch {
    // Startup diagnostics are observational and never control startup.
  }
}

async function writeStartupDiagnostics(startupDiagnostics, operation, ...args) {
  try {
    await startupDiagnostics?.[operation]?.(...args);
  } catch {
    // Startup diagnostics are observational and never control startup.
  }
}

function isPackagedElectronApp(app) {
  return app?.isPackaged === true;
}

function packagedAppPath(app) {
  const value = app?.getAppPath?.();
  return typeof value === "string" && value.length > 0 ? resolve(value) : null;
}

/** Production policy comes only from the packaged application's own manifest. */
export async function readProductionDistribution({
  app,
  platform = process.platform,
  architecture = process.arch,
  readManifest = readFile,
} = {}) {
  const packaged = await readApplicationPackage({ app, readManifest });
  if (packaged === null || packaged.identity.profile !== "stable") return null;
  try {
    return validateProductionDistributionMetadata(packaged.distribution, { platform, architecture });
  } catch {
    throw shellError("electron_configuration_invalid");
  }
}

function packagedResourcesPath(app, appPath, resourcesPath) {
  if (typeof resourcesPath === "string" && resourcesPath.length > 0) {
    return resolve(resourcesPath);
  }
  if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) {
    return resolve(process.resourcesPath);
  }
  return appPath === null ? null : dirname(appPath);
}

/**
 * The companion inherits the launch environment unchanged. The desktop product
 * adds no hosted endpoint for it; the supervisor's own allowlist decides what
 * reaches the child.
 */
export function companionEnvironment({ environment }) {
  return environment;
}

function resolveCompanionLaunchPaths({
  app,
  companionScript,
  resourceRoot,
  resourcesPath,
} = {}) {
  const packaged = isPackagedElectronApp(app);
  const appPath = packaged ? packagedAppPath(app) : null;
  const selectedResourceRoot = resourceRoot
    ?? appPath
    ?? DEFAULT_RESOURCE_ROOT;
  const selectedCompanionScript = companionScript
    ?? (appPath === null
      ? DEFAULT_COMPANION_SCRIPT
      : resolve(appPath, "apps/local/server.js"));
  const selectedCwd = packaged
    ? packagedResourcesPath(app, appPath, resourcesPath) ?? selectedResourceRoot
    : selectedResourceRoot;
  return Object.freeze({
    companionScript: selectedCompanionScript,
    companionCwd: selectedCwd,
    resourceRoot: selectedResourceRoot,
  });
}

function emitEntryFailureDiagnostic(writeDiagnostic = process.stderr?.write?.bind(process.stderr)) {
  if (typeof writeDiagnostic === "function") {
    try {
      writeDiagnostic(`${ELECTRON_ENTRY_FAILURE_DIAGNOSTIC}\n`);
    } catch {
      // Diagnostic delivery must never prevent fail-closed shutdown.
    }
  }
}

function quitAfterEntryFailure({ app, dialog, writeDiagnostic } = {}) {
  emitEntryFailureDiagnostic(writeDiagnostic);
  try {
    // showErrorBox works before app readiness. Keep the copy fixed: a startup
    // exception may contain private paths, account data, or child output.
    dialog?.showErrorBox?.(
      `${brand.displayName} could not start`,
      `Rhetrion stopped before opening the dashboard.\n\nSupport code: ${ELECTRON_ENTRY_FAILURE_DIAGNOSTIC}\n\nPlease report this code with the app and operating system versions. Preserve your local data.`,
    );
  } catch {
    // A missing or broken native dialog must not prevent fail-closed shutdown.
  }
  app?.quit?.();
}

function isCompanionProcessLifecycleEvent(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === 3
    && Object.hasOwn(value, "event")
    && Object.hasOwn(value, "phase")
    && Object.hasOwn(value, "outcome")
    && (value.event === "started" || value.event === "exited")
    && (value.phase === "starting" || value.phase === "ready" || value.phase === "stopping")
    && (value.event === "started"
      ? value.phase === "starting" && value.outcome === null
      : value.outcome === "exit_zero"
        || value.outcome === "exit_nonzero"
        || value.outcome === "signal_abrt"
        || value.outcome === "signal_segv"
        || value.outcome === "signal_kill"
        || value.outcome === "signal_term"
        || value.outcome === "signal_other");
}

function isDashboardFailureEvent(value) {
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).length !== 2
      || !Object.hasOwn(value, "stage")
      || !Object.hasOwn(value, "reason")) {
    return false;
  }
  if (value.stage === "load_url" || value.stage === "did_fail_load") {
    return value.reason === null
      || Number.isInteger(value.reason) && value.reason >= -999 && value.reason <= -1;
  }
  return value.stage === "render_process_gone"
    && (value.reason === "clean-exit"
      || value.reason === "abnormal-exit"
      || value.reason === "killed"
      || value.reason === "crashed"
      || value.reason === "oom"
      || value.reason === "launch-failed"
      || value.reason === "integrity-failure"
      || value.reason === "unknown");
}

/**
 * Emit only fixed companion lifecycle facts for the exact Windows normal
 * candidate. This is not the Windows qualification lane and is unavailable
 * whenever either qualification or test-lane marker is present.
 */
export function createWindowsNormalCandidateCompanionProcessObserver({
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
  writeDiagnostic = process.stderr?.write?.bind(process.stderr),
} = {}) {
  if (environment === null || typeof environment !== "object"
      || platform !== "win32"
      || architecture !== "x64"
      || environment.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL !== ELECTRON_SMOKE_CONTROL
      || Object.hasOwn(environment, "USAGE_MONITOR_TEST_LANE")
      || Object.hasOwn(environment, "USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION")
      || typeof writeDiagnostic !== "function") {
    return undefined;
  }
  return (event) => {
    if (!isCompanionProcessLifecycleEvent(event)) return;
    const value = {
      event: event.event,
      phase: event.phase,
      outcome: event.outcome,
    };
    try {
      writeDiagnostic(`${ELECTRON_COMPANION_PROCESS_DIAGNOSTIC_PREFIX}${JSON.stringify(value)}\n`);
    } catch {
      // Diagnostic delivery must never affect the normal desktop lifecycle.
    }
  };
}

/** Emit closed dashboard failures only for the exact Windows normal candidate. */
export function createWindowsNormalCandidateDashboardFailureObserver({
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
  writeDiagnostic = process.stderr?.write?.bind(process.stderr),
} = {}) {
  if (environment === null || typeof environment !== "object"
      || platform !== "win32"
      || architecture !== "x64"
      || environment.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL !== ELECTRON_SMOKE_CONTROL
      || Object.hasOwn(environment, "USAGE_MONITOR_TEST_LANE")
      || Object.hasOwn(environment, "USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION")
      || typeof writeDiagnostic !== "function") {
    return undefined;
  }
  return (event) => {
    if (!isDashboardFailureEvent(event)) return;
    const value = {
      stage: event.stage,
      reason: event.reason,
    };
    try {
      writeDiagnostic(`${ELECTRON_DASHBOARD_FAILURE_DIAGNOSTIC_PREFIX}${JSON.stringify(value)}\n`);
    } catch {
      // Diagnostic delivery must never affect the normal desktop lifecycle.
    }
  };
}

export function assertElectronQualificationLaunchOptions({
  qualificationContext,
  companionScript,
  resourceRoot,
  resourcesPath,
  supervisorOptions = {},
  lifecycleOptions = {},
  firstRunReceiptBackend,
  notificationBackend,
} = {}) {
  if (qualificationContext === null) return;
  assertWindowsElectronQualificationContext({
    context: qualificationContext,
    platform: "win32",
    architecture: "x64",
  });
  if (companionScript !== undefined
      || resourceRoot !== undefined
      || resourcesPath !== undefined
      || firstRunReceiptBackend !== undefined
      || notificationBackend !== undefined
      || supervisorOptions === null
      || typeof supervisorOptions !== "object"
      || Array.isArray(supervisorOptions)
      || Object.keys(supervisorOptions).length !== 0
      || lifecycleOptions === null
      || typeof lifecycleOptions !== "object"
      || Array.isArray(lifecycleOptions)
      || Object.keys(lifecycleOptions).length !== 0) {
    throw shellError("windows_qualification_launch_override_forbidden");
  }
}

function windowsSmokeStateMessage(lifecycle) {
  const state = lifecycle?.state ?? {};
  return Object.freeze({
    type: WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE,
    message: WINDOWS_ELECTRON_SMOKE_STATE_MESSAGE,
    started: state.started === true,
    primary: state.primaryInstance === true,
    window: state.hasWindow === true,
    visible: state.windowVisible === true,
    tray: state.hasTray === true,
  });
}

function windowsSmokeCredentialMessage(operation, status) {
  return Object.freeze({
    type: WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE,
    message: WINDOWS_ELECTRON_SMOKE_CREDENTIAL_MESSAGE,
    operation,
    status,
  });
}

/**
 * Ask the ordinary Windows lifecycle to quit through the test parent's
 * inherited pipe. This explicit quit-only control grants no renderer, storage,
 * status or network capability and never selects a qualification runtime.
 */
export function installWindowsNormalCandidateQuitControl(lifecycle, {
  environment = process.env,
  messageSource = process,
  platform = process.platform,
  onFailure = () => { process.exitCode = 1; },
} = {}) {
  if (platform !== "win32"
      || environment.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL !== ELECTRON_SMOKE_CONTROL
      || Object.hasOwn(environment, "USAGE_MONITOR_TEST_LANE")
      || Object.hasOwn(environment, "USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION")
      || lifecycle?.state?.primaryInstance !== true
      || typeof lifecycle?.requestQuit !== "function"
      || messageSource?.connected !== true
      || typeof messageSource?.on !== "function"
      || typeof messageSource?.send !== "function") {
    return () => {};
  }
  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false;
    messageSource.off?.("message", onMessage);
    messageSource.off?.("disconnect", cleanup);
  };
  const onMessage = (message) => {
    if (!active || message === null || typeof message !== "object"
        || Array.isArray(message) || Reflect.ownKeys(message).length !== 1
        || message.type !== "usagemonitor-electron-smoke-quit-v1") return;
    cleanup();
    let acknowledged = false;
    const flushed = (error) => {
      if (acknowledged) return;
      acknowledged = true;
      if (error) return;
      // Let the acknowledgement reach the parent before the lifecycle tears
      // down its companion and Electron closes the inherited channel.
      void Promise.resolve().then(() => lifecycle.requestQuit()).catch(onFailure);
    };
    try {
      messageSource.send({ type: "usagemonitor-electron-smoke-quit-accepted-v1" }, flushed);
    } catch {
      // An unavailable parent pipe cannot create a successful quit receipt.
    }
  };
  messageSource.on("message", onMessage);
  messageSource.on("disconnect", cleanup);
  return cleanup;
}

/**
 * Install the packaged Windows smoke control only for the exact opt-in test
 * environment. It uses the Node child-process IPC channel because a packaged
 * Windows GUI Electron process has no usable stdin/stdout stream. This is not
 * renderer IPC, a loopback endpoint, or a production readiness override.
 * Unknown or malformed messages are ignored and every response is fixed and
 * content-free.
 */
function installWindowsSmokeControlWithRunners(lifecycle, {
  environment = process.env,
  messageSource = process,
  sendMessage = null,
  platform = process.platform,
  qualificationContext = null,
} = {}, {
  credentialProbe,
  credentialCommand,
  accountObservationStorage,
} = {}) {
  if (platform !== "win32"
      || environment.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL
        !== WINDOWS_ELECTRON_SMOKE_CONTROL
      || environment.USAGE_MONITOR_WINDOWS_ELECTRON_QUALIFICATION
        !== WINDOWS_ELECTRON_QUALIFICATION_MARKER
      || environment.USAGE_MONITOR_TEST_LANE !== WINDOWS_ELECTRON_TEST_LANE
      || lifecycle?.state?.primaryInstance !== true
      || !qualificationContext
      || typeof messageSource?.on !== "function"
      || messageSource?.connected === false) {
    return () => {};
  }
  const sendControlMessage = sendMessage ?? messageSource.send;
  if (typeof sendControlMessage !== "function") return () => {};
  try {
    assertWindowsElectronQualificationContext({
      context: qualificationContext,
      platform: "win32",
      architecture: "x64",
    });
  } catch {
    return () => {};
  }
  let active = true;
  let credentialOperation = Promise.resolve();
  const send = (value, acknowledged = null) => {
    let callbackCalled = false;
    const callback = (error) => {
      if (callbackCalled) return;
      callbackCalled = true;
      // Node supplies asynchronous IPC errors here. Consume the value so a
      // closed qualification child channel cannot create an unhandled error.
      void error;
      if (typeof acknowledged === "function") {
        try {
          acknowledged();
        } catch {
          // The test-only channel must never change normal shell shutdown.
        }
      }
    };
    try {
      sendControlMessage.call(
        messageSource,
        value,
        callback,
      );
    } catch {
      // The smoke harness owns process lifetime; a closed IPC channel must
      // never change the shell's normal shutdown policy.
      callback();
    }
  };
  let cleanup = () => {};
  const handleCommand = (message) => {
    if (!active
        || message === null
        || typeof message !== "object"
        || Array.isArray(message)
        || Object.keys(message).length !== 3
        || message.type !== WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE
        || message.message !== WINDOWS_ELECTRON_SMOKE_COMMAND_MESSAGE
        || !WINDOWS_ELECTRON_SMOKE_COMMANDS.has(message.command)) {
      return;
    }
    const command = message.command;
    if (command === "status-v1") {
      send(windowsSmokeStateMessage(lifecycle));
      return;
    }
    if (command === "tray-show-v1") {
      lifecycle.invokeTrayCommand?.("show");
      send(windowsSmokeStateMessage(lifecycle));
      return;
    }
    if (command === "tray-hide-v1") {
      lifecycle.invokeTrayCommand?.("hide");
      send(windowsSmokeStateMessage(lifecycle));
      return;
    }
    if (command === "tray-toggle-v1") {
      lifecycle.invokeTrayCommand?.("toggle");
      send(windowsSmokeStateMessage(lifecycle));
      return;
    }
    if (command === "credential-probe-v1") {
      credentialOperation = credentialOperation.then(async () => {
        if (!active) return;
        try {
          await credentialProbe(qualificationContext);
          if (!active) return;
          send(windowsSmokeCredentialMessage(
            WINDOWS_ELECTRON_SMOKE_CREDENTIAL_OPERATIONS[command],
            WINDOWS_ELECTRON_SMOKE_PASSED_STATUS,
          ));
        } catch {
          if (!active) return;
          send(windowsSmokeCredentialMessage(
            WINDOWS_ELECTRON_SMOKE_CREDENTIAL_OPERATIONS[command],
            WINDOWS_ELECTRON_SMOKE_FAILED_STATUS,
          ));
        }
      });
      credentialOperation.catch(() => {});
      return;
    }
    if (command === "account-observation-storage-v1") {
      credentialOperation = credentialOperation.then(async () => {
        if (!active) return;
        try {
          const runner = accountObservationStorage;
          if (typeof runner !== "function") throw new Error("unavailable");
          if (environment.GITHUB_ACTIONS !== "true"
              || environment.USAGE_MONITOR_WINDOWS_ACCOUNT_OBSERVATION_QUALIFICATION
                !== "windows-account-observation-fd4-v1") throw new Error("unavailable");
          await runner({ context: qualificationContext, environment });
          if (!active) return;
          send(windowsSmokeCredentialMessage(
            command,
            WINDOWS_ELECTRON_SMOKE_PASSED_STATUS,
          ));
        } catch (error) {
          if (!active) return;
          const failure = windowsSmokeCredentialMessage(command, WINDOWS_ELECTRON_SMOKE_FAILED_STATUS);
          send(Object.freeze({
            ...failure,
            failureStage: classifyWindowsAccountObservationSmokeFailure(error) ?? "unavailable",
          }));
        }
      });
      credentialOperation.catch(() => {});
      return;
    }
    if (command.startsWith("credential-") && command.endsWith("-v1")) {
      const operation = WINDOWS_ELECTRON_SMOKE_CREDENTIAL_OPERATIONS[command];
      credentialOperation = credentialOperation.then(async () => {
        if (!active) return;
        try {
          await credentialCommand({
            context: qualificationContext,
            command: operation,
            runId: environment.USAGE_MONITOR_WINDOWS_QUALIFICATION_RUN_ID,
          });
          if (!active) return;
          send(windowsSmokeCredentialMessage(operation, WINDOWS_ELECTRON_SMOKE_PASSED_STATUS));
        } catch {
          if (!active) return;
          send(windowsSmokeCredentialMessage(operation, WINDOWS_ELECTRON_SMOKE_FAILED_STATUS));
        }
      });
      credentialOperation.catch(() => {});
      return;
    }
    // Quit is acknowledged before the window/tray and child are torn down so
    // the harness can distinguish a requested clean quit from a forced kill.
    send(Object.freeze({
      type: WINDOWS_ELECTRON_SMOKE_MESSAGE_TYPE,
      message: WINDOWS_ELECTRON_SMOKE_QUIT_MESSAGE,
      status: WINDOWS_ELECTRON_SMOKE_ACCEPTED_STATUS,
    }), () => {
      cleanup();
      void Promise.resolve(lifecycle.requestQuit?.()).catch(() => {
        process.exitCode = 1;
      });
    });
  };
  const onMessage = (message) => handleCommand(message);
  const onDisconnect = () => cleanup();
  cleanup = () => {
    if (!active) return;
    active = false;
    messageSource.off?.("message", onMessage);
    messageSource.off?.("disconnect", onDisconnect);
  };
  messageSource.on("message", onMessage);
  messageSource.on("disconnect", onDisconnect);
  return cleanup;
}

export function installWindowsSmokeControl(lifecycle, options = {}) {
  return installWindowsSmokeControlWithRunners(lifecycle, options, {
    credentialProbe: runWindowsElectronQualificationCredentialProbe,
    credentialCommand: runWindowsElectronQualificationCredentialCommand,
    accountObservationStorage: runWindowsAccountObservationQualificationSmoke,
  });
}

/** Dependency-injected seam for plain-Node IPC contract tests only. */
export function installWindowsSmokeControlForTest(lifecycle, {
  credentialProbe,
  credentialCommand,
  accountObservationStorage,
  ...options
} = {}) {
  if (typeof credentialProbe !== "function"
      || typeof credentialCommand !== "function") {
    return () => {};
  }
  return installWindowsSmokeControlWithRunners(lifecycle, options, {
    credentialProbe,
    credentialCommand,
    accountObservationStorage,
  });
}

/**
 * Resolve package authority and complete the one pre-ready Electron setup.
 * Electron's ESM main loader can emit `ready` while an unawaited async launch
 * continues, so this bootstrap phase is awaited before the normal lifecycle
 * composition starts.
 */
async function prepareElectronShellBootstrap({
  electron,
  platform = process.platform,
  architecture = process.arch,
  onStartupPhase,
  startStartupDiagnostics,
  configureProfilePaths = false,
  environment = process.env,
} = {}) {
  const runtime = electron ?? await import("electron");
  const app = runtime?.app;
  if (!app || typeof app.on !== "function") {
    throw new TypeError("Electron app runtime is unavailable");
  }
  const markStartupPhase = async (phase) => {
    try {
      if (typeof onStartupPhase === "function") await onStartupPhase(phase);
    } catch {
      // Startup diagnostics are observational and never control startup.
    }
  };
  // Read and validate the package marker before constructing any companion or
  // platform service.
  await markStartupPhase("package_metadata");
  const packaged = await readApplicationPackage({ app });
  const applicationProfile = packaged?.identity.profile ?? "development";
  const productionDistribution = packaged?.distribution === null || packaged === null ? null
    : validateProductionDistributionMetadata(packaged.distribution, { platform, architecture });
  if (configureProfilePaths) {
    const qualificationContext = await createWindowsElectronQualificationContext({ app, environment, platform, architecture });
    assertElectronPlatformGate({ platform, architecture, environment, productionDistribution, qualificationContext });
    const adapter = createWindowsFilesystemAdapter({ platform, architecture });
    // Reviewed QA launchers supply a private APPDATA alongside their explicit
    // profile. Electron's Windows known-folder lookup may ignore that environment
    // variable; never redirect an isolated run into the physical user's profile.
    const isolated = qualificationContext !== null
      || (productionDistribution !== null
        && environment.USAGE_MONITOR_ELECTRON_SMOKE_CONTROL === ELECTRON_SMOKE_CONTROL);
    const appData = isolated ? environment.APPDATA : app.getPath("appData");
    if (typeof appData !== "string") throw shellError("electron_configuration_invalid");
    pinApplicationProfilePaths({ app, appData, profile: applicationProfile, platform,
      prepareDirectory(path, kind) {
        if (kind === "session") createWindowsBrowserProfileStore({ adapter, rootPath: path }).ensureReady();
        else createWindowsProtectedStateStore({ adapter, rootPath: path });
      },
    });
  }
  try {
    if (typeof startStartupDiagnostics === "function") {
      await startStartupDiagnostics();
    }
  } catch {
    // Startup diagnostics are observational and never control startup.
  }
  return Object.freeze({
    [ELECTRON_SHELL_BOOTSTRAP]: true,
    applicationProfile,
    app,
    productionDistribution,
    runtime,
  });
}

/**
 * Compose the real Electron runtime. The function is intentionally separate
 * from module evaluation so all policy/lifecycle code remains plain-Node
 * testable when Electron is not installed in the source checkout.
 */
export async function launchElectronShell({
  electron,
  companionScript,
  resourceRoot,
  resourcesPath,
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
  supervisorOptions = {},
  lifecycleOptions = {},
  firstRunReceiptBackend,
  notificationBackend,
  emitFailureDiagnostic = false,
  writeDiagnostic,
  startupPreparation = null,
  startupDiagnostics = null,
} = {}) {
  const runtime = electron ?? await import("electron");
  const app = runtime?.app;
  if (!app || typeof app.on !== "function") {
    throw new TypeError("Electron app runtime is unavailable");
  }
  try {
    await markStartupDiagnostics(startupDiagnostics, "runtime_qualification");
    const qualificationContext = await createWindowsElectronQualificationContext({
      app,
      environment,
      platform,
      architecture,
    });
    assertElectronQualificationLaunchOptions({
      qualificationContext,
      companionScript,
      resourceRoot,
      resourcesPath,
      supervisorOptions,
      lifecycleOptions,
      firstRunReceiptBackend,
      notificationBackend,
    });
    const preparation = startupPreparation ?? await prepareElectronShellBootstrap({
      electron: runtime,
      platform,
      architecture,
      onStartupPhase: (phase) => markStartupDiagnostics(startupDiagnostics, phase),
      startStartupDiagnostics: () => writeStartupDiagnostics(startupDiagnostics, "start"),
    });
    if (preparation?.[ELECTRON_SHELL_BOOTSTRAP] !== true
        || preparation.runtime !== runtime
        || preparation.app !== app) {
      throw shellError("electron_configuration_invalid");
    }
    await writeStartupDiagnostics(startupDiagnostics, "start");
    const { productionDistribution } = preparation;
    await markStartupDiagnostics(startupDiagnostics, "platform_gate");
    assertElectronPlatformGate({
      platform,
      architecture,
      environment,
      qualificationContext,
      productionDistribution,
    });
    await markStartupDiagnostics(startupDiagnostics, "runtime_paths");
    const paths = resolveCompanionLaunchPaths({
      app,
      companionScript,
      resourceRoot,
      resourcesPath,
    });
    // A local-QA launch must never inherit production sending or updating.
    const productionEnabled = productionDistribution !== null
      && environment.USAGE_MONITOR_TEST_LANE === undefined;
    // Exact stable Windows candidates select the fixed FD4 account-observation
    // adapter. Qualification and installed lifecycle evidence remain separate
    // from this source selection.
    const normalCandidateCompanionProcessObserver =
      createWindowsNormalCandidateCompanionProcessObserver({
        environment,
        platform: process.platform,
        architecture: process.arch,
        writeDiagnostic,
      });
    const normalCandidateDashboardFailureObserver =
      createWindowsNormalCandidateDashboardFailureObserver({
        environment,
        platform: process.platform,
        architecture: process.arch,
        writeDiagnostic,
      });
    const windowsNormalCandidateCredentialHandover = productionEnabled
      && platform === "win32"
      && architecture === "x64"
      && productionDistribution.target === "win32-x64"
      ? createWindowsNormalCandidateCredentialHandover()
      : platform === "win32" && architecture === "x64"
        && qualificationContext !== null && qualificationContext !== undefined
        && preparation.applicationProfile === "development"
        && environment.USAGE_MONITOR_TEST_LANE === WINDOWS_ELECTRON_TEST_LANE
        ? createWindowsDevelopmentReadOnlyCredentialHandover() : null;
    await markStartupDiagnostics(startupDiagnostics, "credential_wiring");
    const trayIconFactory = createDesktopTrayIconFactory({
      nativeImage: runtime.nativeImage,
      resourceRoot: paths.resourceRoot,
      platform: process.platform,
    });
    const applicationIcon = resolveDesktopApplicationIcon({
      nativeImage: runtime.nativeImage,
      resourceRoot: paths.resourceRoot,
    });
    const desktop = await launchDesktopRuntime({
      runtime: {
        ...runtime,
        icon: applicationIcon,
        createTrayIcon: trayIconFactory.resolve,
      },
      app,
      paths: {
        ...paths,
        preloadPath: resolve(MODULE_DIRECTORY, "preload.cjs"),
      },
      environment: {
        ...companionEnvironment({ environment }),
        USAGE_MONITOR_RESOURCE_ROOT: paths.resourceRoot,
      },
      supervisorOptions: {
        ...supervisorOptions,
        ...(normalCandidateCompanionProcessObserver === undefined ? {} : {
          onChildLifecycleEvent: normalCandidateCompanionProcessObserver,
        }),
        ...(windowsNormalCandidateCredentialHandover === null ? {} : {
          attachWindowsAccountObservationBroker:
            windowsNormalCandidateCredentialHandover.attachWindowsAccountObservationBroker,
        }),
      },
      lifecycleOptions: {
        appName: productionDistribution !== null || !isPackagedElectronApp(app)
          ? brand.displayName : brand.developmentDisplayName,
        ...lifecycleOptions,
        ...(normalCandidateDashboardFailureObserver === undefined ? {} : {
          onDashboardLoadFailure: normalCandidateDashboardFailureObserver,
        }),
      },
      firstRunReceiptBackend,
      notificationBackend,
      qualificationContext,
      platform,
      architecture,
      productionDistribution: productionEnabled ? productionDistribution : undefined,
      onStartupPhase: (phase) => markStartupDiagnostics(startupDiagnostics, phase),
      onStartupStop: (code) => writeStartupDiagnostics(startupDiagnostics, "stop", code),
    });
    installWindowsSmokeControl(desktop.lifecycle, {
      environment,
      platform,
      qualificationContext,
    });
    if (desktop.lifecycle === null) {
      await writeStartupDiagnostics(startupDiagnostics, "stop", desktop.status);
    } else {
      await writeStartupDiagnostics(startupDiagnostics, "complete");
    }
    return desktop.lifecycle;
  } catch (error) {
    // This includes platform-gate and dependency/configuration failures that
    // occur before the lifecycle owns a shutdown path.
    await writeStartupDiagnostics(startupDiagnostics, "fail", error);
    if (emitFailureDiagnostic) {
      quitAfterEntryFailure({ app, dialog: runtime.dialog, writeDiagnostic });
    } else {
      app.quit?.();
    }
    throw error;
  }
}

// Node-based tests and repository tooling import this entry without executing
// a desktop launch. An actual Electron process is the only executable caller.
if (process.versions.electron) {
  const runtime = await import("electron");
  runtime.protocol.registerSchemesAsPrivileged([{
    scheme: "usagemonitor-background",
    privileges: { standard: true, secure: true, stream: true },
  }, {
    scheme: "usagemonitor-x-media",
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
  }]);
  const startupDiagnostics = createDesktopStartupDiagnostics({ app: runtime?.app });
  let startupPreparation;
  try {
    // Keep this small awaited phase ahead of the ordinary launch promise. In
    // an ESM main process an unawaited launch can lose the race with `ready`.
    startupPreparation = await prepareElectronShellBootstrap({
      electron: runtime,
      configureProfilePaths: true,
      onStartupPhase: (phase) => markStartupDiagnostics(startupDiagnostics, phase),
      startStartupDiagnostics: () => writeStartupDiagnostics(startupDiagnostics, "start"),
    });
  } catch (error) {
    await writeStartupDiagnostics(startupDiagnostics, "fail", error);
    quitAfterEntryFailure({ app: runtime?.app, dialog: runtime?.dialog });
    process.exitCode = 1;
  }
  if (startupPreparation !== undefined) {
    launchElectronShell({
      electron: runtime,
      startupPreparation,
      startupDiagnostics,
      emitFailureDiagnostic: true,
    })
      .then((lifecycle) => {
        if (lifecycle !== null) installWindowsNormalCandidateQuitControl(lifecycle);
      })
      .catch(() => {
        process.exitCode = 1;
      });
  }
}
