import {
  createAccountObservationSecretLoader,
  createDevelopmentAccountObservationSecretLoader,
  defaultAccountObservationOperationLockFile,
} from "./account-observation-secret.js";
import {
  EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES,
  assertWindowsProductionReadiness,
  createWindowsProductionCapabilityBackend,
  isWindowsAccountObservationBrokerBackend,
} from "./platform/index.js";

function fail(code) {
  const error = new Error("Production account observation credential selection failed");
  error.code = code;
  throw error;
}

export function selectProductionAccountObservationSecret({
  platform = process.platform,
  architecture = process.arch,
  operationLockFile = defaultAccountObservationOperationLockFile(),
  keychainCapability = EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES.accountObservation,
  createIfMissing = true,
  developmentSecret = null,
  windowsReadiness = null,
  createWindowsBackend = null,
  createWindowsBrokerBackend = null,
} = {}) {
  if (typeof createIfMissing !== "boolean") fail("ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_INVALID");
  if (developmentSecret !== null) {
    return Object.freeze({
      mode: "injected_development_secret",
      loadAccountObservationSecret: createDevelopmentAccountObservationSecretLoader(developmentSecret),
    });
  }
  if (platform !== "win32") {
    fail("ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE");
  }
  if (architecture !== "x64") {
    fail("ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE");
  }
  // The Electron parent owns the fixed observation capability and its
  // mutation lease. Selecting this explicit IPC route must never fall back
  // to the child-native manager when its announcement is absent or invalid.
  if (createWindowsBrokerBackend !== null) {
    if (typeof createWindowsBrokerBackend !== "function") {
      fail("ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE");
    }
    try {
      const backend = createWindowsBrokerBackend();
      if (!isWindowsAccountObservationBrokerBackend(backend)) {
        throw new Error("Unavailable Windows observation broker");
      }
      return Object.freeze({
        mode: "windows_parent_ipc_account_observation",
        loadAccountObservationSecret: createAccountObservationSecretLoader({
          backend,
          capability: keychainCapability,
          createIfMissing,
          operationLockFile: undefined,
          parentAuthoritativeMutationLease: true,
        }),
      });
    } catch {
      fail("ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE");
    }
  }
  if (typeof createWindowsBackend !== "function") {
    fail("ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE");
  }
  try {
    assertWindowsProductionReadiness({
      platform,
      architecture,
      readiness: windowsReadiness,
    });
    const windowsBackend = createWindowsBackend({ platform, architecture });
    const backend = createWindowsProductionCapabilityBackend({
      backend: windowsBackend,
      capability: keychainCapability,
      readiness: windowsReadiness,
    });
    return Object.freeze({
      mode: "windows_credential_manager_account_observation",
      loadAccountObservationSecret: createAccountObservationSecretLoader({
        backend,
        capability: keychainCapability,
        operationLockFile,
        createIfMissing,
      }),
    });
  } catch {
    fail("ACCOUNT_OBSERVATION_PRODUCTION_BACKEND_UNAVAILABLE");
  }
}
