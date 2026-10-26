"use strict";

/**
 * Closed production distribution policy shared by the Electron builder and
 * the main-process updater.  Development packages intentionally do not read
 * this policy: they have a separate identifier and no updater configuration.
 *
 * Rhetrion supports Windows x64 only. Every other platform, the native
 * macOS and Linux lanes, and their signing or handover rehearsals are absent
 * from this policy; a lookup for them returns null and fails closed.
 */

const { APPLICATION_PROFILES } = require("./application-identity.cjs");

const PRODUCTION_ELECTRON_DISTRIBUTION_SCHEMA_VERSION =
  "usagemonitor-electron-distribution-v1";
const PRODUCTION_ELECTRON_APP_ID = APPLICATION_PROFILES.stable.appId;
// Windows uses the same fixed product identity for its NSIS installation and
// Electron toast registration. Keeping this value in the distribution policy
// prevents separately-reviewed packaging and runtime paths from drifting.
const PRODUCTION_ELECTRON_WINDOWS_TOAST_ACTIVATOR_CLSID =
  APPLICATION_PROFILES.stable.toastActivatorClsid;
const PRODUCTION_ELECTRON_CHANNEL = "stable";
const PRODUCTION_ELECTRON_CONTRIBUTION_POLICY = "accountless-opt-out-v1";
// No update service is configured for the independent local application.
const PRODUCTION_ELECTRON_UPDATE_ORIGIN = null;
// Immutable artifact/source-candidate identity. Retain the historical
// ten-digit bound for receipt compatibility.
const PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN = /^[1-9][0-9]{0,9}$/u;
const PRODUCTION_ELECTRON_RELEASE_VERSION_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const WINDOWS_FILE_VERSION_COMPONENT_LIMIT = 65_535n;
const WINDOWS_FILE_VERSION_COMPONENTS = 4;

const PRODUCTION_ELECTRON_TARGETS = Object.freeze({
  "win32-x64": Object.freeze({
    architecture: "x64",
    feedURL: null,
    platform: "win32",
  }),
});

function productionElectronTargetFor(platform, architecture) {
  const target = `${platform}-${architecture}`;
  return Object.hasOwn(PRODUCTION_ELECTRON_TARGETS, target) ? target : null;
}

function productionElectronFeedForTarget(target) {
  return PRODUCTION_ELECTRON_TARGETS[target]?.feedURL ?? null;
}

/**
 * Return the one reviewed production distribution selection for a Windows
 * target. Rehearsal and handover selections were retired with the native
 * macOS lanes; there is no alternate selection to request.
 */
function productionElectronDistributionForTarget({ target } = {}) {
  const targetSpec = PRODUCTION_ELECTRON_TARGETS[target];
  if (!targetSpec) return null;
  return Object.freeze({
    channel: PRODUCTION_ELECTRON_CHANNEL,
    contributionPolicy: PRODUCTION_ELECTRON_CONTRIBUTION_POLICY,
    feedURL: targetSpec.feedURL,
    schemaVersion: PRODUCTION_ELECTRON_DISTRIBUTION_SCHEMA_VERSION,
    target,
  });
}

function productionElectronStagingPathSegments({ target } = {}) {
  if (productionElectronDistributionForTarget({ target }) === null) return null;
  return Object.freeze(["electron-production", target]);
}

function assertProductionBuildNumber(buildNumber) {
  if (typeof buildNumber !== "string" || !PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN.test(buildNumber)) {
    throw new TypeError("buildNumber must be a bounded positive decimal string");
  }
  return buildNumber;
}

/**
 * Convert the exact decimal candidate identifier into all four unsigned
 * 16-bit Windows resource-version components. This is a lossless base-65536
 * representation, so numeric candidate order is preserved without allowing a
 * decimal input such as 20260906 to overflow a PE version component.
 */
function productionElectronWindowsFileVersion(buildNumber) {
  let remaining = BigInt(assertProductionBuildNumber(buildNumber));
  const components = Array(WINDOWS_FILE_VERSION_COMPONENTS).fill("0");
  for (let index = WINDOWS_FILE_VERSION_COMPONENTS - 1; index >= 0; index -= 1) {
    components[index] = String(remaining % (WINDOWS_FILE_VERSION_COMPONENT_LIMIT + 1n));
    remaining /= WINDOWS_FILE_VERSION_COMPONENT_LIMIT + 1n;
  }
  if (remaining !== 0n) {
    throw new TypeError("buildNumber cannot be represented as a Windows file version");
  }
  return components.join(".");
}

/**
 * Return the value passed to electron-builder's buildVersion. Windows receives
 * four valid PE components derived from the exact candidate identifier.
 */
function productionElectronBuildVersionForTarget({ target, version, buildNumber } = {}) {
  const targetSpec = PRODUCTION_ELECTRON_TARGETS[target];
  if (!targetSpec || typeof version !== "string"
      || !PRODUCTION_ELECTRON_RELEASE_VERSION_PATTERN.test(version)) {
    throw new TypeError("target and release version are required");
  }
  return productionElectronWindowsFileVersion(assertProductionBuildNumber(buildNumber));
}

module.exports = Object.freeze({
  PRODUCTION_ELECTRON_APP_ID,
  PRODUCTION_ELECTRON_WINDOWS_TOAST_ACTIVATOR_CLSID,
  PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN,
  PRODUCTION_ELECTRON_CHANNEL,
  PRODUCTION_ELECTRON_CONTRIBUTION_POLICY,
  PRODUCTION_ELECTRON_DISTRIBUTION_SCHEMA_VERSION,
  PRODUCTION_ELECTRON_RELEASE_VERSION_PATTERN,
  PRODUCTION_ELECTRON_TARGETS,
  PRODUCTION_ELECTRON_UPDATE_ORIGIN,
  WINDOWS_FILE_VERSION_COMPONENT_LIMIT,
  productionElectronBuildVersionForTarget,
  productionElectronDistributionForTarget,
  productionElectronFeedForTarget,
  productionElectronStagingPathSegments,
  productionElectronTargetFor,
  productionElectronWindowsFileVersion,
});
