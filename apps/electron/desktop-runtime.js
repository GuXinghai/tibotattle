import applicationIdentity from "../../config/application-identity.cjs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import distribution from "../../config/electron-production-distribution.cjs";

import { createCompanionSupervisor } from "./companion-supervisor.js";
import { createDesktopController } from "./desktop-controller.js";
import { createDesktopDeepLinkQueue } from "./desktop-deep-links.js";
import { createDesktopLifecycle } from "./desktop-lifecycle.js";
import { installDesktopIpc } from "./desktop-ipc.js";
import { installDesktopXIpc } from "./desktop-x-ipc.js";
import { createDesktopXRepository } from "./desktop-x-repository.js";
import { createDesktopXService } from "./desktop-x-service.js";
import { createDesktopXDiagnostics } from "./desktop-x-diagnostics.js";
import { createDesktopXImport } from "./desktop-x-import.js";
import { X_SESSION_ERRORS, xError } from "./desktop-x-contract.js";
import {
  createDesktopPlatformServices,
  validateDesktopCodexHome,
} from "./desktop-platform-services.js";
import { createWindowsDesktopSettingsBackend } from "./desktop-settings-backends.js";
import { createDesktopSettingsStore } from "./desktop-settings-store.js";
import { createDesktopBackgroundController, createWindowsBackgroundRepository, createBackgroundImagePicker } from "./desktop-background.js";
import { DESKTOP_APPEARANCES } from "./desktop-contract.js";
import {
  isAbsoluteCodexPath,
  normalizeCodexHomes,
  normalizeCodexPathForComparison,
} from "./desktop-codex-roots.js";
import { desktopText } from "./desktop-copy.js";
import {
  createDesktopDiagnostics,
  formatDesktopDiagnostics,
} from "./desktop-diagnostics.js";
import {
  createDesktopFirstRunReceiptBackend,
  ensureDesktopFirstRunAcknowledged,
} from "./desktop-first-run.js";
import { createDesktopFirstRunLoginRegistrar } from "./desktop-first-run-login.js";
import { createDesktopRecoverySettingsAction } from "./desktop-recovery-settings.js";
import {
  createDesktopNotificationCoordinator,
  createDesktopNotificationPolicyCodec,
  DESKTOP_NOTIFICATION_POLICY_FILE_NAME,
} from "./desktop-notification-coordinator.js";
import { createDesktopNotificationDelivery } from "./desktop-notification-delivery.js";
import { prepareWindowsNotificationIdentity } from "./desktop-windows-notification-identity.js";
import { shellError } from "./errors.js";
import {
  createProductionDesktopUpdater,
  validateProductionDistributionMetadata,
} from "./desktop-updater.js";
import { createDesktopUpdatePreferences, createDesktopUpdatePreferencesBackend } from "./desktop-update-preferences.js";
import {
  createWindowsFilesystemAdapter,
  createWindowsProtectedStateStore,
  createWindowsBrowserProfileStore,
} from "../../src/platform/index.js";

const DESKTOP_SETTINGS_DIRECTORY = "desktop-settings";
const SETTINGS_CODEX_ROOT_ACTIONS = new Set([
  "getCodexHomesForSettings",
  "chooseCodexHome",
  "addCodexHome",
  "editCodexHome",
  "removeCodexHome",
  "setPrimaryCodexHome",
  "reorderCodexHomes",
  "useDefaultCodexHome",
]);

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function userDataPath(app) {
  const selected = app?.getPath?.("userData");
  if (typeof selected !== "string" || selected.length === 0) {
    throw new TypeError("Electron userData path is unavailable");
  }
  return resolve(selected);
}

function electronSystemLocales(app) {
  const locales = [];
  try {
    const preferred = app?.getPreferredSystemLanguages?.();
    if (Array.isArray(preferred)) locales.push(...preferred);
  } catch {
    // Locale discovery is presentation-only; the desktop runtime can still
    // start with the catalog's English fallback.
  }
  try {
    const selected = app?.getLocale?.();
    if (typeof selected === "string") locales.push(selected);
  } catch {
    // See the preferred-languages fallback above.
  }
  return locales;
}

function applyElectronAppearance(nativeTheme, preference) {
  if (!DESKTOP_APPEARANCES.includes(preference)
      || nativeTheme === null
      || typeof nativeTheme !== "object") {
    return null;
  }
  try {
    nativeTheme.themeSource = preference;
  } catch {
    return null;
  }
  const resolvedTheme = preference === "dark"
    ? "dark"
    : preference === "light"
      ? "light"
      : nativeTheme.shouldUseDarkColors === true ? "dark" : "light";
  return resolvedTheme;
}

function childEnvironmentWithStateRoot({ app, environment }) {
  const selected = { ...environment };
  if (!Object.hasOwn(selected, "USAGE_MONITOR_STATE_ROOT")) {
    selected.USAGE_MONITOR_STATE_ROOT = join(
      userDataPath(app),
      "companion-state",
    );
  }
  return selected;
}

function runtimeHomeDirectory({ environment }) {
  for (const key of ["USERPROFILE", "HOME"]) {
    const value = environment[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return homedir();
}

function isWindowsCodexPath(value) {
  return typeof value === "string"
    && (/^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value));
}

function isPlatformCodexPath(value) {
  if (!isAbsoluteCodexPath(value)) return false;
  // A child on Windows must never receive a POSIX spelling that the Win32 APIs
  // would reinterpret as relative/current-drive state.
  return isWindowsCodexPath(value);
}

function assertNoWindowsTestOverrides({
  qualificationContext,
  platformServices,
  settingsBackend,
  settingsStore,
  notificationBackend,
  firstRunReceiptBackend,
  automaticRefreshCadence,
  argv,
} = {}) {
  if (qualificationContext === null || qualificationContext === undefined) return;
  if (platformServices !== undefined
      || settingsBackend !== undefined
      || settingsStore !== undefined
      || firstRunReceiptBackend !== undefined
      || notificationBackend !== undefined
      || automaticRefreshCadence !== undefined
      || argv !== undefined) {
    throw shellError("windows_qualification_launch_override_forbidden");
  }
}

function createUnavailableElectronNotificationConstructor() {
  return class UnavailableElectronNotification {
    static isSupported() {
      return false;
    }
  };
}

function electronNotificationConstructor(runtime) {
  return typeof runtime?.Notification === "function"
    && typeof runtime.Notification.isSupported === "function"
    ? runtime.Notification
    : createUnavailableElectronNotificationConstructor();
}

function createNotificationPolicyBackend({
  app,
  notificationBackend,
  rootPath,
  windowsProtectedStateStore,
  qualificationContext,
  windowsNormalCandidate = false,
  architecture = process.arch,
} = {}) {
  if (notificationBackend !== undefined) {
    if (qualificationContext !== null && qualificationContext !== undefined) {
      throw shellError("windows_qualification_launch_override_forbidden");
    }
    return notificationBackend;
  }
  const selectedRootPath = rootPath ?? join(userDataPath(app), DESKTOP_SETTINGS_DIRECTORY);
  const codec = createDesktopNotificationPolicyCodec();
  // The qualified and exact stable-candidate Windows lanes must use the
  // branded protected store for every desktop record. There is no ordinary
  // Node filesystem fallback.
  if ((qualificationContext === null || qualificationContext === undefined)
      && windowsNormalCandidate !== true) {
    throw shellError("windows_readiness_unavailable");
  }
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture,
  });
  const protectedStore = windowsProtectedStateStore ?? createWindowsProtectedStateStore({
    adapter,
    rootPath: selectedRootPath,
  });
  return createWindowsDesktopSettingsBackend({
    platform: "win32",
    windowsProtectedStateStore: protectedStore,
    childName: DESKTOP_NOTIFICATION_POLICY_FILE_NAME,
    codec,
  });
}

function runtimePlatformServices({
  runtime,
  app,
  platform,
  homeDirectory,
  environment,
  getUpdater,
}) {
  // Electron always supplies these modules in a real launch.  The bounded
  // fallback keeps the plain-Node composition tests independent of Electron;
  // it is never selected for the qualified Windows lane.
  const dialog = runtime?.dialog ?? {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  };
  const shell = runtime?.shell ?? {
    openExternal: async () => true,
  };
  const Notification = runtime?.Notification ?? {
    isSupported: () => false,
  };
  return createDesktopPlatformServices({
    app,
    dialog,
    shell,
    Notification,
    platform,
    homeDirectory,
    environment,
    getUpdater,
  });
}

function createSettingsBackend({
  app,
  settingsBackend,
  rootPath,
  windowsProtectedStateStore,
  qualificationContext,
  windowsNormalCandidate = false,
  architecture = process.arch,
} = {}) {
  if (settingsBackend !== undefined) return settingsBackend;
  const selectedRootPath = rootPath ?? join(userDataPath(app), DESKTOP_SETTINGS_DIRECTORY);
  // Windows never falls back to Node filesystem state. The repository's
  // branded adapter and protected store are the only accepted backend.
  if ((qualificationContext === null || qualificationContext === undefined)
      && windowsNormalCandidate !== true) {
    // The platform gate normally prevents this branch. Keeping the check
    // explicit prevents a future caller from silently enabling an unqualified
    // Windows desktop state path.
    throw shellError("windows_readiness_unavailable");
  }
  const adapter = createWindowsFilesystemAdapter({
    platform: "win32",
    architecture,
  });
  const protectedStore = windowsProtectedStateStore ?? createWindowsProtectedStateStore({
    adapter,
    rootPath: selectedRootPath,
  });
  return createWindowsDesktopSettingsBackend({
    platform: "win32",
    windowsProtectedStateStore: protectedStore,
  });
}

function createNoopIpcInstallation() {
  return Object.freeze({
    channel: null,
    dispose() {},
  });
}

/**
 * Compose and start the real Electron desktop runtime.
 *
 * The child environment is intentionally mutable only inside this module. A
 * persisted custom CODEX_HOME is applied before the first supervisor.start;
 * later changes mutate that private environment and use lifecycle.retry().
 * The controller owns persistence rollback when a restart or write fails.
 */
export async function launchDesktopRuntime({
  runtime,
  app,
  paths,
  environment = process.env,
  supervisorOptions = {},
  lifecycleOptions = {},
  qualificationContext = null,
  singleInstanceLockAcquired: preAcquiredSingleInstanceLock = undefined,
  platform = process.platform,
  architecture = process.arch,
  platformServices,
  settingsBackend,
  settingsStore,
  notificationBackend,
  firstRunReceiptBackend,
  automaticRefreshCadence,
  argv,
  productionDistribution,
  onStartupPhase,
  onStartupStop,
  loadProductionUpdater = () => import("electron-updater"),
} = {}) {
  assertObject(runtime, "runtime");
  if (!app || typeof app.on !== "function") throw new TypeError("app is required");
  assertObject(paths, "paths");
  if (typeof paths.companionScript !== "string"
      || typeof paths.companionCwd !== "string"
      || typeof paths.resourceRoot !== "string"
      || typeof paths.preloadPath !== "string") {
    throw new TypeError("companion launch paths are invalid");
  }
  assertObject(environment, "environment");
  const markStartupPhase = async (phase) => {
    try {
      if (typeof onStartupPhase === "function") await onStartupPhase(phase);
    } catch {
      // Startup diagnostics are observational and never control startup.
    }
  };
  const stopStartup = async (code) => {
    try {
      if (typeof onStartupStop === "function") await onStartupStop(code);
    } catch {
      // Startup diagnostics are observational and never control shutdown.
    }
  };
  if (productionDistribution !== undefined) {
    validateProductionDistributionMetadata(productionDistribution, {
      platform,
      architecture,
    });
    if (app.isPackaged !== true
        || environment.USAGE_MONITOR_TEST_LANE !== undefined
        || qualificationContext !== null || platformServices !== undefined
        || typeof loadProductionUpdater !== "function") {
      throw shellError("electron_configuration_invalid");
    }
  }
  // `productionDistribution` has just passed the exact package identity,
  // platform, architecture, test-lane, and qualification-context checks.
  // This permits the protected Windows state route for the one stable
  // candidate without changing the native sidecar's own safety claims.
  const windowsNormalCandidate = platform === "win32"
    && productionDistribution !== undefined;
  assertObject(supervisorOptions, "supervisorOptions");
  assertObject(lifecycleOptions, "lifecycleOptions");
  assertNoWindowsTestOverrides({
    qualificationContext,
    platformServices,
    settingsBackend,
    settingsStore,
    notificationBackend,
    firstRunReceiptBackend,
    automaticRefreshCadence,
    argv,
  });
  if (platform === "win32" && qualificationContext !== null
      && qualificationContext !== undefined && architecture !== "x64") {
    throw shellError("windows_readiness_unavailable");
  }

  if (typeof runtime.BrowserWindow !== "function") {
    throw new TypeError("BrowserWindow is required");
  }
  const runtimeEnvironment = environment;
  const childEnvironment = childEnvironmentWithStateRoot({
    app,
    environment: runtimeEnvironment,
  });
  if (productionDistribution !== undefined) {
    childEnvironment.USAGE_MONITOR_STATE_ROOT = join(userDataPath(app), "companion-state");
    delete childEnvironment.USAGE_MONITOR_DEVELOPMENT_ACCOUNT_SECRET_FILE;
  }
  // Keep one mutable argument vector for the lifetime of this runtime. The
  // supervisor snapshots it for each spawn, so a Settings root change can
  // persist first, update this vector, and then use the ordinary bounded
  // lifecycle Retry path without constructing a second supervisor.
  const companionArgs = [paths.companionScript];
  const {
    args: ignoredSupervisorArgs,
    command: ignoredSupervisorCommand,
    cwd: ignoredSupervisorCwd,
    environment: ignoredSupervisorEnvironment,
    ...safeSupervisorOptions
  } = supervisorOptions;
  void ignoredSupervisorArgs;
  void ignoredSupervisorCommand;
  void ignoredSupervisorCwd;
  void ignoredSupervisorEnvironment;
  const supervisor = createCompanionSupervisor({
    ...safeSupervisorOptions,
    command: process.execPath,
    args: companionArgs,
    cwd: paths.companionCwd,
    environment: childEnvironment,
  });
  let updater = null;
  const selectedPlatformServices = platformServices ?? runtimePlatformServices({
    runtime,
    app,
    platform,
    homeDirectory: runtimeHomeDirectory({ environment: runtimeEnvironment }),
    environment: runtimeEnvironment,
    getUpdater: () => updater,
  });
  const services = selectedPlatformServices;
  const requestedDesktopSystemLocales = lifecycleOptions.desktopSystemLocales;
  const firstRunLocale = lifecycleOptions.desktopLocale ?? "system";
  const deepLinkQueue = createDesktopDeepLinkQueue();
  let lifecycle = null;
  let dashboardReady = false;
  let deepLinkIntakeCleanup = () => {};

  // The executable bootstrap may already own this lock after pinning the
  // selected profile paths and before full profile preparation. Direct
  // composition callers acquire it here before first-run/settings work.
  const singleInstanceLockAcquired = preAcquiredSingleInstanceLock === undefined
    ? (typeof app.requestSingleInstanceLock === "function"
      ? app.requestSingleInstanceLock()
      : true)
    : preAcquiredSingleInstanceLock;
  if (typeof singleInstanceLockAcquired !== "boolean") {
    throw shellError("electron_configuration_invalid");
  }
  if (!singleInstanceLockAcquired) {
    await stopStartup("secondary_instance");
    app.quit?.();
    return Object.freeze({
      firstRun: null,
      lifecycle: null,
      supervisor: null,
      controller: null,
      settingsStore: null,
      settingsBackend: null,
      ipc: createNoopIpcInstallation(),
      childEnvironment: null,
      status: "secondary_instance",
    });
  }

  const dispatchPendingDeepLinks = () => {
    if (!dashboardReady || lifecycle === null) return 0;
    const pending = deepLinkQueue.drain();
    let delivered = 0;
    for (const target of pending) {
      // The app link is a plain wake target: it only brings the dashboard
      // forward and carries no renderer-visible command.
      const shown = lifecycle.showWindow?.() === true;
      if (shown) {
        delivered += 1;
      } else {
        // Requeue only the fixed canonical target. The original URL/argv is
        // never retained or forwarded across the renderer boundary.
        deepLinkQueue.enqueue(target.canonicalURL);
      }
    }
    return delivered;
  };

  const acceptDeepLinkArgv = (values) => {
    if (!Array.isArray(values)) return 0;
    const accepted = deepLinkQueue.enqueueMany(values);
    dispatchPendingDeepLinks();
    return accepted.length;
  };
  const onSecondInstance = (_event, commandLine) => {
    acceptDeepLinkArgv(commandLine);
  };
  app.on("second-instance", onSecondInstance);
  deepLinkIntakeCleanup = () => {
    app.off?.("second-instance", onSecondInstance);
    deepLinkIntakeCleanup = () => {};
  };
  acceptDeepLinkArgv(argv ?? process.argv);
  // Electron's native dialog must be shown only after the app is ready. This
  // does not start the companion, register a login item, or enable updates.
  await markStartupPhase("app_ready");
  await app.whenReady?.();
  const desktopSystemLocales = requestedDesktopSystemLocales
    ?? electronSystemLocales(app);
  const startupTextOptions = { locale: firstRunLocale, systemLocales: desktopSystemLocales };
  const settingsRootPath = join(userDataPath(app), DESKTOP_SETTINGS_DIRECTORY);
  const injectedSettings = settingsBackend !== undefined || settingsStore !== undefined
    || firstRunReceiptBackend !== undefined;
  const needsWindowsProtectedStateStore = platform === "win32"
    && (qualificationContext !== null
      && qualificationContext !== undefined
      || firstRunReceiptBackend === undefined
      || settingsBackend === undefined
      || notificationBackend === undefined);
  const windowsProtectedStateStore = needsWindowsProtectedStateStore
    ? createWindowsProtectedStateStore({
      adapter: createWindowsFilesystemAdapter({
        platform: "win32",
        architecture,
      }),
      rootPath: settingsRootPath,
    })
    : null;
  const firstRunBackend = firstRunReceiptBackend
    ?? createDesktopFirstRunReceiptBackend({
      platform,
      rootPath: settingsRootPath,
      windowsProtectedStateStore,
    });
  await markStartupPhase("first_run");
  const firstRun = await ensureDesktopFirstRunAcknowledged({
    dialog: runtime.dialog,
    receiptBackend: firstRunBackend,
    quit: async () => {
      await stopStartup("startup_stopped");
      app.quit?.();
    },
    locale: firstRunLocale,
    systemLocales: desktopSystemLocales,
    production: productionDistribution !== undefined,
  });
  if (firstRun.status !== "acknowledged") {
    deepLinkIntakeCleanup();
    return Object.freeze({
      firstRun,
      lifecycle: null,
      supervisor,
      controller: null,
      settingsStore: null,
      settingsBackend: null,
      ipc: createNoopIpcInstallation(),
      childEnvironment,
    });
  }
  await markStartupPhase("secure_storage");
  await markStartupPhase("runtime_services");
  const validateCodexHome = typeof services.validateCodexHome === "function"
    ? services.validateCodexHome
    : (path) => validateDesktopCodexHome(path);
  const backend = settingsStore === undefined
    ? createSettingsBackend({
      app,
      platform,
      settingsBackend,
      rootPath: settingsRootPath,
      qualificationContext,
      windowsNormalCandidate,
      architecture,
      windowsProtectedStateStore,
    })
    : null;
  const policyBackend = createNotificationPolicyBackend({
    app,
    platform,
    notificationBackend,
    rootPath: settingsRootPath,
    qualificationContext,
    windowsNormalCandidate,
    architecture,
    windowsProtectedStateStore,
  });
  const store = settingsStore ?? createDesktopSettingsStore({ backend });
  const backgroundRepository = windowsProtectedStateStore === null ? null : createWindowsBackgroundRepository(windowsProtectedStateStore);
  const backgroundController = createDesktopBackgroundController({
    repository: backgroundRepository,
    chooseImage: createBackgroundImagePicker({ repository: backgroundRepository, dialog: runtime.dialog, nativeImage: runtime.nativeImage }),
    notify: () => { lifecycle?.sendDashboardCommand?.({ command: "windowBackground" }); },
  });

  // The session request policy checks the exact requesting WebContents and
  // trusted top frame. Keep no-referrer intact; no capability travels via headers.
  runtime.protocol?.handle?.("usagemonitor-background", request => backgroundController.handleResource(request));

  const windowsNotificationIdentityReady = prepareWindowsNotificationIdentity({
          applicationProfile: productionDistribution === undefined ? null : applicationIdentity.applicationMetadata("stable"),
    app,
    shell: runtime.shell,
    platform,
  });
  let activeDesktopLocale = lifecycleOptions.desktopLocale ?? firstRunLocale;
  let activeNotificationDelivery = createDesktopNotificationDelivery({
    Notification: electronNotificationConstructor(runtime),
    app,
    platform,
    locale: activeDesktopLocale,
    systemLocales: desktopSystemLocales,
    windowsIdentityReady: windowsNotificationIdentityReady,
  });
  const notificationDelivery = Object.freeze({
    status() {
      return activeNotificationDelivery.status();
    },
    deliver(value) {
      return activeNotificationDelivery.deliver(value);
    },
    sendTest() {
      return activeNotificationDelivery.sendTest();
    },
  });
  const notificationCoordinator = createDesktopNotificationCoordinator({
    backend: policyBackend,
    delivery: notificationDelivery,
  });

  let facade = null;
  let controller;
  let ipcInstallation = createNoopIpcInstallation();
  let xIpcInstallation = createNoopIpcInstallation();
  let xService;
  let xImport;
  let xMediaProtocol;
  let xInitializationError = null;
  let xShutdownPromise;
  let resolveXInitialization;
  const xInitialized = new Promise(resolve => { resolveXInitialization = resolve; });
  function drainXSession() {
    if (!xShutdownPromise) xShutdownPromise = (async () => {
      try { await xService?.dispose(); }
      catch (error) {
        const code = X_SESSION_ERRORS.includes(error?.code) ? error.code : "session_persist_failed";
        const options = { locale: activeDesktopLocale, systemLocales: desktopSystemLocales };
        const title = desktopText("x.title", {}, options);
        const message = desktopText(`x.${code}`, {}, options);
        if (typeof runtime.dialog?.showErrorBox === "function") runtime.dialog.showErrorBox(title, message);
        else if (typeof runtime.dialog?.showMessageBox === "function") await runtime.dialog.showMessageBox({ type: "error", title, message });
        else throw xError(code);
      }
    })();
    return xShutdownPromise;
  }
  // Chromium snapshots protocol loaders when a document is created. Register
  // this lightweight handler before the dashboard's first navigation; compose
  // storage/authentication later without delaying the main window.
  if (platform === "win32" && app.isPackaged === true && typeof runtime.protocol?.handle === "function") {
    runtime.protocol.handle("usagemonitor-x-media", async request => {
      await xInitialized;
      return xService ? xService.resourceHandler(request) : new Response(null, { status: 503 });
    });
    xMediaProtocol = runtime.protocol;
  }
  // Install a narrow capability before showing the main frame. Its storage and
  // network owners are composed after that frame is visible, independently of
  // the companion's first data response.
  const xPort = Object.fromEntries([
    "getStatus", "listPosts", "getPost", "refresh", "beginLogin", "cancelLogin",
    "getSettings", "setSettings", "logout", "clearCache",
  ].map(name => [name, async (...args) => {
    await xInitialized;
    if (!xService) {
      if (name === "getStatus") return { auth: "disconnected", operation: "error", error: xInitializationError ?? "storage_unavailable", loginMethod: null, cacheBytes: 0, notificationsAvailable: false };
      throw xError(xInitializationError ?? "storage_unavailable");
    }
    return xService[name](...args);
  }]));
  function initializeXReader() {
    try {
      if (xShutdownPromise) return;
      // Only the reviewed packaged runtime enables persistent X credentials;
      // its build gate verifies CookieEncryption on the exact executable.
      if (platform !== "win32" || app.isPackaged !== true
          || !runtime.session?.fromPath || !windowsProtectedStateStore || !xMediaProtocol) return;
      const adapter = createWindowsFilesystemAdapter({ platform: "win32", architecture });
      const protectedStore = path => createWindowsProtectedStateStore({ adapter, rootPath: path });
      const xDiagnostic = createDesktopXDiagnostics({ store: protectedStore(join(settingsRootPath, "x-diagnostics")) });
      const repository = createDesktopXRepository({
        store: protectedStore(join(settingsRootPath, "x-reader")),
        createSessionStore: id => createWindowsBrowserProfileStore({ adapter, rootPath: join(settingsRootPath, "x-sessions", id) }),
      });
      const importPort = {
        begin: () => xImport.begin(), cancel: () => xImport?.cancel(), status: () => xImport?.status(),
      };
      const deliverX = notificationDelivery.status().status === "ready" ? async value => {
        if (notificationDelivery.status().status !== "ready"
            || !Number.isSafeInteger(value?.posts) || value.posts < 0
            || !Number.isSafeInteger(value?.replies) || value.replies < 0
            || value.posts + value.replies < 1
            || typeof value.latestId !== "string" || !/^[0-9]{1,24}$/.test(value.latestId)) return;
        const options = { locale: activeDesktopLocale, systemLocales: desktopSystemLocales };
        const notification = new runtime.Notification({
          title: desktopText("x.notification.title", {}, options),
          body: desktopText("x.notification.body", { posts: value.posts, replies: value.replies }, options),
        });
        notification.on("click", () => {
          lifecycle.navigateDashboardSection("x");
          lifecycle.sendDashboardCommand({ command: "xPost", id: value.latestId });
        });
        notification.show();
      } : undefined;
      xService = createDesktopXService({
        runtime, repository, importBridge: importPort, notify: deliverX, onDiagnostic: xDiagnostic,
        allowedOrigin: () => supervisor.state?.origin,
      });
      xImport = createDesktopXImport({
        protectedStore: protectedStore(join(settingsRootPath, "x-import")),
        onImport: (cookies, permit) => xService.importCookies(cookies, permit),
      });
    } catch (error) {
      // An unavailable optional reader must not prevent offline local analysis.
      xInitializationError = X_SESSION_ERRORS.includes(error?.code) ? error.code : "storage_unavailable";
      xImport?.dispose();
      void xService?.dispose().catch(() => { xInitializationError = "session_persist_failed"; });
      xService = undefined;
    } finally { resolveXInitialization(); }
  }
  let cleanupPromise = null;
  let removeNativeThemeListener = () => {};

  async function collectDesktopDiagnostics() {
    let snapshot = null;
    try {
      snapshot = await controller?.snapshot?.();
    } catch {
      snapshot = null;
    }
    return formatDesktopDiagnostics(createDesktopDiagnostics({
      platform,
      architecture,
      version: snapshot?.about?.version ?? app.getVersion?.(),
      build: snapshot?.about?.build ?? environment.USAGE_MONITOR_BUILD_ID,
      lifecycle: lifecycle?.state,
      settings: snapshot?.settings,
      refresh: controller?.refreshStatus?.(),
    }));
  }

  async function showDesktopDiagnostics() {
    if (typeof runtime.dialog?.showMessageBox !== "function") {
      throw shellError("desktop_diagnostics_unavailable");
    }
    const textOptions = {
      locale: activeDesktopLocale,
      systemLocales: desktopSystemLocales,
    };
    const detail = `${await collectDesktopDiagnostics()}\n`
      + "crash_report_upload: false\n";
    const actions = ["copy", "done"];
    const buttons = actions.map((action) => desktopText(`electron.diagnostics.${action === "support" ? "prepareSupportIssue" : action}`, {}, textOptions));
    const response = await runtime.dialog.showMessageBox({
      type: "info",
      title: desktopText("electron.diagnostics.title", {}, textOptions),
      message: desktopText("electron.diagnostics.message", {}, textOptions),
      detail,
      buttons,
      defaultId: buttons.length - 1,
      cancelId: buttons.length - 1,
      noLink: true,
    });
    const action = actions[response?.response] ?? "done";
    if (action !== "copy") return Object.freeze({ status: "shown" });
    if (typeof runtime.clipboard?.writeText !== "function") {
      return Object.freeze({ status: "copy_unavailable" });
    }
    try {
      runtime.clipboard.writeText(detail);
      return Object.freeze({ status: "copied" });
    } catch {
      return Object.freeze({ status: "copy_unavailable" });
    }
  }

  async function revealLocalData() {
    const selected = childEnvironment.USAGE_MONITOR_STATE_ROOT;
    if (typeof selected !== "string" || !isAbsolute(selected)
        || typeof runtime.shell?.showItemInFolder !== "function") {
      throw shellError("desktop_local_data_unavailable");
    }
    runtime.shell.showItemInFolder(resolve(selected));
    return true;
  }

  async function openDashboardInBrowser() {
    const selected = lifecycle;
    if (selected === null || typeof selected.openDashboardInBrowser !== "function") {
      throw shellError("desktop_dashboard_browser_unavailable");
    }
    return selected.openDashboardInBrowser();
  }

  const updateDesktopAppearance = (value) => applyElectronAppearance(
    runtime.nativeTheme,
    value,
  );

  function updateDesktopLanguage(value) {
    activeDesktopLocale = value;
    try {
      activeNotificationDelivery = createDesktopNotificationDelivery({
        Notification: electronNotificationConstructor(runtime),
        app,
        platform,
        locale: value,
        systemLocales: desktopSystemLocales,
        windowsIdentityReady: windowsNotificationIdentityReady,
      });
    } catch {
      // A copy/catalog failure must not make a persisted language change
      // fail. The previous delivery adapter remains authoritative in that
      // unlikely case, while its status stays capability-gated.
    }
    if (recoverySettingsAction !== undefined) {
      try {
        recoverySettingsAction = createDesktopRecoverySettingsAction({
          controller,
          dialog: runtime.dialog,
          locale: value,
          systemLocales: desktopSystemLocales,
        });
      } catch {
        // Recovery repair remains available in the previously resolved
        // language if a later catalog rebuild unexpectedly fails.
      }
    }
    const platformUpdated = typeof services.setLocale === "function"
      && services.setLocale(value) === true;
    const lifecycleUpdated = lifecycle?.setDesktopLanguage?.(value) === true;
    return platformUpdated || lifecycleUpdated;
  }

  function assignCodexHome(home) {
    if (home.mode === "custom") {
      childEnvironment.CODEX_HOME = home.path;
    } else {
      childEnvironment.CODEX_HOME = services.defaultCodexHome
        ?? join(runtimeHomeDirectory({ environment: runtimeEnvironment }), ".codex");
    }
  }

  function effectiveCodexHomes(configuration) {
    let selected;
    try {
      selected = normalizeCodexHomes(configuration);
    } catch {
      throw shellError("desktop_codex_roots_invalid");
    }
    // v2 settings can retain additional roots for a future multi-folder
    // release. The current local companion supports one CODEX_HOME only, so
    // resolve and validate just the persisted primary rather than passing
    // ignored argv flags or treating retained roots as activity sources.
    const primary = selected.activityRoots.find(
      ({ rootId }) => rootId === selected.primaryRootId,
    );
    if (!primary) throw shellError("desktop_codex_roots_invalid");
    let primaryPath = primary.kind === "default"
      ? services.defaultCodexHome
        ?? join(runtimeHomeDirectory({ environment: runtimeEnvironment }), ".codex")
      : primary.path;
    if (typeof primaryPath !== "string" || !isPlatformCodexPath(primaryPath)) {
      throw shellError("desktop_codex_roots_invalid");
    }
    try {
      normalizeCodexPathForComparison(primaryPath);
    } catch {
      throw shellError("desktop_codex_roots_invalid");
    }
    return Object.freeze({
      configuration: selected,
      primaryPath,
    });
  }

  function assignCodexHomes(configuration) {
    const selected = effectiveCodexHomes(configuration);
    // The production companion reads CODEX_HOME. It does not implement the
    // historical multi-root argv proposal, so keep its invocation honest.
    // Mutate in place in case a previous runtime candidate supplied flags,
    // while preserving the server script at argv[0].
    companionArgs.splice(1);
    childEnvironment.CODEX_HOME = selected.primaryPath;
    return selected;
  }

  async function applyCodexHome(home, previous) {
    assignCodexHome(home);
    // Initialization has no running child. Every subsequent selection uses
    // the lifecycle's bounded stop/start path, so no unbounded direct spawn is
    // introduced by the settings bridge.
    if (previous !== null && previous !== undefined) {
      if (lifecycle === null) throw shellError("companion_not_running");
      await lifecycle.retry();
    }
  }

  async function applyCodexHomes(configuration, previous) {
    assignCodexHomes(configuration);
    // Initialization has no running child. All later updates are a bounded
    // stop/start through lifecycle.retry; if it fails the persisted config and
    // this argv/env candidate intentionally remain in place for Retry.
    if (previous !== null && previous !== undefined) {
      if (lifecycle === null) throw shellError("companion_not_running");
      await lifecycle.retry();
    }
  }

  function sendDashboardCommand(command) {
    return lifecycle?.sendDashboardCommand?.(command) === true;
  }

  controller = createDesktopController({
    windowBackgroundActions: backgroundController.handlers,
    overviewRefreshOwnedByCompanion: true,
    settingsStore: store,
    platformServices: services,
    desktopSystemLocales,
    notificationCoordinator,
    notificationDelivery,
    getLifecycle: () => facade ?? lifecycle,
    applyCodexHome,
    applyCodexHomes,
    validateCodexHome,
    sendDashboardCommand,
    onLanguageChanged: (value) => updateDesktopLanguage(value),
    onAppearanceChanged: updateDesktopAppearance,
    onUnknownSpeedPolicyChanged: async (policy) => {
      childEnvironment.USAGE_MONITOR_UNKNOWN_SPEED_POLICY = JSON.stringify(policy);
      await supervisor.setUnknownSpeedPolicy(policy);
    },
    onRefreshIntervalChanged: async (seconds, paused) => {
      childEnvironment.USAGE_MONITOR_REFRESH_INTERVAL_SECONDS = String(seconds);
      childEnvironment.USAGE_MONITOR_REFRESH_PAUSED = String(paused);
      await supervisor.setRefreshInterval(seconds, paused);
    },
    openDashboardInBrowserAction: openDashboardInBrowser,
    showDiagnosticsAction: showDesktopDiagnostics,
    revealLocalDataAction: revealLocalData,
    automaticRefreshCadence,
  });

  // Load persisted settings before starting the child. This is what makes a
  // previously selected Codex root effective on the first launch.
  let initialDesktopSnapshot;
  let firstRunLogin = Object.freeze({ status: "not_requested" });
  let recoverySettingsAction;
  await markStartupPhase("settings");
  try {
    initialDesktopSnapshot = await controller.initialize();
    const firstRunLoginRegistrar = createDesktopFirstRunLoginRegistrar({
      controller,
      dialog: runtime.dialog,
      locale: firstRunLocale,
      systemLocales: desktopSystemLocales,
    });
    firstRunLogin = await firstRunLoginRegistrar.apply(firstRun);
    recoverySettingsAction = createDesktopRecoverySettingsAction({
      controller,
      dialog: runtime.dialog,
      locale: initialDesktopSnapshot.settings.language,
      systemLocales: desktopSystemLocales,
    });
  } catch (error) {
    deepLinkIntakeCleanup();
    await controller.dispose();
    await notificationCoordinator.drain().catch(() => {});
    await notificationCoordinator.dispose().catch(() => {});
    throw error;
  }
  const callerActions = lifecycleOptions.desktopActions;
  const callerOnDesktopStatus = lifecycleOptions.onDesktopStatus;
  const boundedCallerActions = callerActions !== null
    && typeof callerActions === "object"
    && !Array.isArray(callerActions)
    ? callerActions
    : {};
  const desktopActions = {
    ...boundedCallerActions,
    refresh: () => controller.refreshUsage(),
    toggleSidebar: () => {
      const operation = controller.toggleSidebar();
      operation?.catch?.(() => {});
      return operation;
    },
    retry: () => lifecycle?.retry?.(),
    settings: () => controller.showSettings("general"),
    about: () => controller.showSettings("about"),
    recoverySettings: () => recoverySettingsAction.show(),
    diagnostics: () => controller.handlers.showDiagnostics({}),
    quit: () => { void requestQuit(); },
  };
  const selectedLifecycleOptions = {
    ...lifecycleOptions,
    desktopActions,
    desktopLocale: initialDesktopSnapshot.settings.language,
    initialTrayPreferences: initialDesktopSnapshot.settings.tray,
    onTrayHistoryRange: async (historyRange) => {
      const current = await store.getSettings();
      return controller.handlers.setTrayPreferences({ value: { ...current.tray, historyRange } });
    },
    desktopSystemLocales,
    singleInstanceLockAcquired,
    openDashboardExternal: lifecycleOptions.openDashboardExternal
      ?? (async (url) => {
        if (typeof runtime.shell?.openExternal !== "function") return false;
        await runtime.shell.openExternal(url, { activate: true });
        return true;
      }),
    onDashboardReady: () => {
      dashboardReady = true;
      controller.reconcileDashboardSession?.();
      dispatchPendingDeepLinks();
    },
    onDashboardInvalidated: () => {
      controller.reconcileDashboardSession?.();
    },
    onDesktopStatus: (status) => {
      // The lifecycle has already validated this closed status contract. The
      // coordinator serializes persistence and delivery; a notification
      // failure is capability state, never a lifecycle failure.
      void notificationCoordinator.evaluate(status).catch(() => {});
      if (typeof callerOnDesktopStatus === "function") {
        try {
          callerOnDesktopStatus(status);
        } catch {
          // A caller observer is diagnostic/UI convenience only.
        }
      }
    },
  };
  try {
    lifecycle = createDesktopLifecycle({
      app,
      nativeAutoUpdater: runtime.autoUpdater,
      BrowserWindow: runtime.BrowserWindow,
      Tray: runtime.Tray,
      Menu: runtime.Menu,
      screen: runtime.screen,
      icon: runtime.icon,
      createTrayIcon: runtime.createTrayIcon,
      preloadPath: paths.preloadPath,
      supervisor,
      ...selectedLifecycleOptions,
      beforeQuit: drainXSession,
      platform,
    });
  } catch (error) {
    deepLinkIntakeCleanup();
    await controller.dispose();
    await notificationCoordinator.drain().catch(() => {});
    await notificationCoordinator.dispose().catch(() => {});
    throw error;
  }

  async function disposeControllerAndIpc() {
    if (cleanupPromise !== null) return cleanupPromise;
    cleanupPromise = (async () => {
      removeNativeThemeListener();
      removeNativeThemeListener = () => {};
      updater?.dispose();
      ipcInstallation.dispose?.();
      xIpcInstallation.dispose?.();
      xImport?.dispose();
      await drainXSession();
      xMediaProtocol?.unhandle?.("usagemonitor-x-media");
      await controller.dispose();
      await backgroundController.drain();
      runtime.protocol?.unhandle?.("usagemonitor-background");
      // Drain first so a final status evaluation cannot race disposal. The
      // coordinator is idempotent, which also tolerates a future controller
      // implementation that owns the same disposal seam.
      await notificationCoordinator.drain().catch(() => {});
      await notificationCoordinator.dispose().catch(() => {});
    })();
    cleanupPromise.catch(() => {});
    return cleanupPromise;
  }

  async function requestQuit() {
    deepLinkIntakeCleanup();
    await disposeControllerAndIpc();
    return lifecycle?.requestQuit?.();
  }

  const onBeforeQuit = () => {
    deepLinkIntakeCleanup();
    void disposeControllerAndIpc();
  };
  app.on("before-quit", onBeforeQuit);

  try {
    // Install the fixed bridge before lifecycle.start creates a visible
    // window. The renderer remains unauthorized until its BrowserWindow and
    // top frame exist.
    if (runtime.ipcMain?.handle) {
      xIpcInstallation = installDesktopXIpc({
        ipcMain: runtime.ipcMain,
        service: xPort,
        importBridge: { configure: async () => {
          await xInitialized;
          if (!xImport) throw new Error("X import unavailable");
          return xImport.configure();
        } },
        authorize: event => lifecycle?.isAuthorizedSettingsFrame?.(event?.senderFrame, { sender: event?.sender }) === true,
      });
      ipcInstallation = installDesktopIpc({
        ipcMain: runtime.ipcMain,
        handlers: controller.handlers,
        trustedSender: (sender, event) => lifecycle?.isAuthorizedDesktopSender?.(sender, event) === true,
        trustedFrame: (frame, event) => lifecycle?.isAuthorizedDesktopFrame?.(frame, event) === true,
        trustedAction: (action, event) => {
          if (["setWindowBackground", "chooseWindowBackground", "restoreWindowBackground"].includes(action)) {
            return lifecycle?.isAuthorizedSettingsFrame?.(event?.senderFrame, { sender: event?.sender }) === true;
          }
          if (action === "sendTestNotification" || SETTINGS_CODEX_ROOT_ACTIONS.has(action)) {
            return lifecycle?.isAuthorizedSettingsFrame?.(
              event?.senderFrame,
              { sender: event?.sender },
            ) === true;
          }
          if (action === "openCodexThread") {
            return lifecycle?.isAuthorizedCodexThreadNavigation?.(
              event?.senderFrame,
              { sender: event?.sender },
            ) === true;
          }
          if (action !== "getRefreshStatus"
              && action !== "setRefreshPaused"
              && action !== "refreshStarted"
              && action !== "refreshHeartbeat"
              && action !== "refreshSettled"
              && action !== "toggleSidebar") return true;
          return lifecycle?.isAuthorizedDashboardFrame?.(
            event?.senderFrame,
            { sender: event?.sender },
          ) === true;
        },
      });
    } else if (qualificationContext !== null && qualificationContext !== undefined) {
      throw shellError("desktop_ipc_unavailable");
    }
    if (typeof runtime.nativeTheme?.on === "function") {
      const onNativeThemeUpdated = () => {
        void store.getSettings().then((settings) => {
          const resolvedTheme = updateDesktopAppearance(settings.appearance);
          if (resolvedTheme !== null) {
            facade?.sendDashboardCommand?.({
              command: "appearance",
              preference: settings.appearance,
              resolvedTheme,
            });
          }
        }).catch(() => {});
      };
      runtime.nativeTheme.on("updated", onNativeThemeUpdated);
      removeNativeThemeListener = () => {
        runtime.nativeTheme.removeListener?.("updated", onNativeThemeUpdated);
      };
    }
    await markStartupPhase("lifecycle");
    await lifecycle.start();
    initializeXReader();
    if (productionDistribution !== undefined && productionDistribution.updateFeed !== null) {
      await markStartupPhase("updater");
      // Electron's built-in autoUpdater lacks electron-updater's explicit
      // download contract, so the selected package consistently uses the
      // pinned updater.
      const updaterModule = await loadProductionUpdater();
      const autoUpdater = updaterModule?.autoUpdater ?? updaterModule?.default?.autoUpdater;
      updater = createProductionDesktopUpdater({
        app, autoUpdater, distributionMetadata: productionDistribution,
        platform, architecture,
        preferences: createDesktopUpdatePreferences({
          backend: createDesktopUpdatePreferencesBackend({
            platform, rootPath: settingsRootPath, windowsProtectedStateStore,
          }),
        }),
        prepareForUpdate: () => lifecycle.prepareForUpdate(),
        cancelPreparedUpdate: () => lifecycle.cancelUpdatePreparation(),
        onStatus: () => lifecycle.refreshSettings(),
      });
      await updater.start();
    }
    await markStartupPhase("ready");
  } catch (error) {
    deepLinkIntakeCleanup();
    await disposeControllerAndIpc();
    app.off?.("before-quit", onBeforeQuit);
    throw error;
  }

  facade = Object.freeze({
    start: lifecycle.start,
    retry: lifecycle.retry,
    showWindow: lifecycle.showWindow,
    showTrayPopover: lifecycle.showTrayPopover,
    showSettingsWindow: lifecycle.showSettingsWindow,
    hideWindow: lifecycle.hideWindow,
    toggleWindow: lifecycle.toggleWindow,
    sendDashboardCommand: lifecycle.sendDashboardCommand,
    getApplicationMenu: lifecycle.getApplicationMenu,
    openApplicationMenu: lifecycle.openApplicationMenu,
    navigateDashboardSection: lifecycle.navigateDashboardSection,
    setDesktopLanguage: lifecycle.setDesktopLanguage,
    setDesktopTrayPreferences: lifecycle.setDesktopTrayPreferences,
    invokeTrayCommand: lifecycle.invokeTrayCommand,
    requestQuit,
    openDashboardInBrowser: lifecycle.openDashboardInBrowser,
    dispose: async () => {
      deepLinkIntakeCleanup();
      await disposeControllerAndIpc();
      app.off?.("before-quit", onBeforeQuit);
      return lifecycle.dispose();
    },
    isAuthorizedDesktopSender: lifecycle.isAuthorizedDesktopSender,
    isAuthorizedDesktopFrame: lifecycle.isAuthorizedDesktopFrame,
    isAuthorizedDashboardSender: lifecycle.isAuthorizedDashboardSender,
    isAuthorizedDashboardFrame: lifecycle.isAuthorizedDashboardFrame,
    isAuthorizedCodexThreadNavigation: lifecycle.isAuthorizedCodexThreadNavigation,
    isAuthorizedSettingsFrame: lifecycle.isAuthorizedSettingsFrame,
    get state() {
      return lifecycle.state;
    },
  });

  return Object.freeze({
    firstRun,
    firstRunLogin,
    lifecycle: facade,
    supervisor,
    controller,
    notificationCoordinator,
    xService,
    settingsStore: store,
    settingsBackend: backend,
    ipc: ipcInstallation,
    childEnvironment,
  });
}

export const DESKTOP_SETTINGS_DIRECTORY_NAME = DESKTOP_SETTINGS_DIRECTORY;
