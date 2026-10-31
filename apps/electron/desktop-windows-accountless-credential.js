import {
  createWindowsNormalCandidateAccountObservationCredentialBackend,
  isWindowsAccountObservationCredentialError,
} from "../../src/platform/windows-account-observation-credential.js";

import {
  attachDesktopWindowsAccountObservationBroker,
} from "./desktop-windows-account-observation-broker.js";

const WINDOWS_PLATFORM = "win32";
const WINDOWS_ARCHITECTURE = "x64";
const NORMAL_CANDIDATE_HANDOVER_TEST_OPTION_KEYS = Object.freeze([
  "architecture",
  "attachBroker",
  "createAccountObservationCredentialBackend",
  "isAccountObservationBackendError",
  "platform",
]);

function failure() {
  return Object.assign(new Error("Windows credential handover unavailable"), {
    code: "windows_credential_handover_unavailable",
    retryable: false,
  });
}

function exactObjectKeys(value, keys) {
  try {
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
  } catch {
    return false;
  }
}

function createWindowsNormalCandidateCredentialHandoverWithDependencies({
  architecture,
  attachBroker,
  createAccountObservationCredentialBackend,
  isAccountObservationBackendError,
  platform,
}, readOnly = false) {
  if (platform !== WINDOWS_PLATFORM || architecture !== WINDOWS_ARCHITECTURE
      || typeof attachBroker !== "function"
      || typeof createAccountObservationCredentialBackend !== "function"
      || typeof isAccountObservationBackendError !== "function") {
    throw failure();
  }
  return Object.freeze({
    attachWindowsAccountObservationBroker(channel) {
      return attachBroker({
        channel,
        createBackend: createAccountObservationCredentialBackend,
        isBackendError: isAccountObservationBackendError,
        readOnly,
      });
    },
  });
}

/**
 * Main's exact stable Windows/x64 selection is the sole normal-runtime caller.
 * It exposes only the fixed read/create-only FD4 account-observation Node-IPC
 * broker. It does not load a generic Credential Manager route or alter any
 * native `productionSafe`/`pathWalkRaceSafe` fact.
 */
export function createWindowsNormalCandidateCredentialHandover() {
  return createWindowsNormalCandidateCredentialHandoverWithDependencies({
    architecture: process.arch,
    attachBroker: attachDesktopWindowsAccountObservationBroker,
    createAccountObservationCredentialBackend:
      createWindowsNormalCandidateAccountObservationCredentialBackend,
    isAccountObservationBackendError: isWindowsAccountObservationCredentialError,
    platform: process.platform,
  });
}

// A qualified development shell may read the existing fixed observation key.
// The parent broker refuses creation before any credential mutation can run.
export function createWindowsDevelopmentReadOnlyCredentialHandover() {
  return createWindowsExistingObservationCredentialHandover();
}

// A migrated stable profile is restricted to its existing observation identity.
// No read miss, retry or account switch may manufacture continuity via creation.
export function createWindowsExistingObservationCredentialHandover() {
  return createWindowsNormalCandidateCredentialHandoverWithDependencies({
    architecture: process.arch,
    attachBroker: attachDesktopWindowsAccountObservationBroker,
    createAccountObservationCredentialBackend:
      createWindowsNormalCandidateAccountObservationCredentialBackend,
    isAccountObservationBackendError: isWindowsAccountObservationCredentialError,
    platform: process.platform,
  }, true);
}

export function createWindowsExistingObservationCredentialHandoverForTest(options = {}) {
  if (!exactObjectKeys(options, NORMAL_CANDIDATE_HANDOVER_TEST_OPTION_KEYS)) throw failure();
  return createWindowsNormalCandidateCredentialHandoverWithDependencies(options, true);
}

export function createWindowsDevelopmentReadOnlyCredentialHandoverForTest(options = {}) {
  if (!exactObjectKeys(options, NORMAL_CANDIDATE_HANDOVER_TEST_OPTION_KEYS)) throw failure();
  return createWindowsNormalCandidateCredentialHandoverWithDependencies(options, true);
}

/** Explicit dependency seam for the fixed normal-Windows handover contract. */
export function createWindowsNormalCandidateCredentialHandoverForTest(options = {}) {
  if (!exactObjectKeys(options, NORMAL_CANDIDATE_HANDOVER_TEST_OPTION_KEYS)) throw failure();
  return createWindowsNormalCandidateCredentialHandoverWithDependencies(options);
}
