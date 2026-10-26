const applicationIdentity = require("../../config/application-identity.cjs");
const productBrand = require("../../config/product-brand.cjs");
"use strict";

/**
 * One target-specific production candidate configuration.
 *
 * This file is deliberately only a source configuration.  It does not invoke
 * electron-builder, upload a feed, sign, notarize, or make a release claim.
 * A finalizer must provide every input below and run electron-builder with
 * `--publish never`; the generic provider still makes builder write the fixed
 * app-update.yml that electron-updater reads from the installed application.
 */

const { readFileSync } = require("node:fs");
const path = require("node:path");

const distribution = require("../../config/electron-production-distribution.cjs");

const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
const TARGET_ENV = "USAGE_MONITOR_ELECTRON_TARGET";
const VERSION_ENV = "USAGE_MONITOR_ELECTRON_VERSION";
const SOURCE_REVISION_ENV = "USAGE_MONITOR_ELECTRON_SOURCE_REVISION";
const BUILD_NUMBER_ENV = "USAGE_MONITOR_ELECTRON_BUILD_NUMBER";
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

class ProductionElectronBuilderConfigError extends Error {
  constructor() {
    super("Production Electron builder configuration is invalid");
    this.name = "ProductionElectronBuilderConfigError";
    this.code = "electron_production_builder_config_invalid";
  }
}

function fail() {
  throw new ProductionElectronBuilderConfigError();
}

function exactEnvironment(name) {
  if (!Object.hasOwn(process.env, name)
      || typeof process.env[name] !== "string"
      || process.env[name].length === 0
      || process.env[name] !== process.env[name].trim()) {
    fail();
  }
  return process.env[name];
}

function readSourceReleaseVersion() {
  try {
    const manifest = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));
    if (manifest?.name !== "app-usagemonitor"
        || typeof manifest.version !== "string"
        || !VERSION_PATTERN.test(manifest.version)) {
      fail();
    }
    return manifest.version;
  } catch (error) {
    if (error instanceof ProductionElectronBuilderConfigError) throw error;
    fail();
  }
}

function readInputs() {
  const target = exactEnvironment(TARGET_ENV);
  // Rhetrion is Windows-only. Any other target has no reviewed packaging.
  if (target !== "win32-x64") fail();
  const targetSpec = distribution.PRODUCTION_ELECTRON_TARGETS[target];
  const distributionSelection = distribution.productionElectronDistributionForTarget({ target });
  const sourceReleaseVersion = readSourceReleaseVersion();
  const sourceRevision = exactEnvironment(SOURCE_REVISION_ENV);
  const buildNumber = exactEnvironment(BUILD_NUMBER_ENV);
  const version = sourceReleaseVersion;
  if (!targetSpec || distributionSelection === null
      || !SOURCE_REVISION_PATTERN.test(sourceRevision)
      || !distribution.PRODUCTION_ELECTRON_BUILD_NUMBER_PATTERN.test(buildNumber)
      || exactEnvironment(VERSION_ENV) !== version) {
    fail();
  }
  return Object.freeze({
    buildNumber,
    distributionSelection,
    sourceReleaseVersion,
    sourceRevision,
    target,
    targetSpec,
    version,
  });
}

function distributionMetadata({ buildNumber, distributionSelection, sourceRevision, target }) {
  const metadata = {
    appId: distribution.PRODUCTION_ELECTRON_APP_ID,
    buildNumber,
    channel: distributionSelection.channel,
    contributionPolicy: distributionSelection.contributionPolicy,
    schemaVersion: distributionSelection.schemaVersion,
    sourceRevision,
    target,
    updateFeed: distributionSelection.feedURL,
  };
  return Object.freeze(metadata);
}

function stagingClosure() {
  return [
    {
      from: ".",
      to: ".",
      filter: [
        "package.json",
        "electron-runtime-manifest.json",
        "apps/electron/**",
        "apps/local/**",
        "apps/web/public/**",
        "config/**",
        "contracts/**",
        "native/windows-filesystem/build/Release/windows_filesystem.node",
        "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
        "schemas/**",
        "src/**",
        "generated/**",
      ],
    },
    {
      from: "node_modules",
      to: "node_modules",
      filter: ["**/*"],
    },
  ];
}

function asarUnpackFor(target) {
  if (target !== "win32-x64") fail();
  return [
    "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
    "native/windows-filesystem/build/Release/windows_filesystem.node",
  ];
}

const INPUTS = readInputs();
const metadata = distributionMetadata(INPUTS);
const stagingPathSegments = distribution.productionElectronStagingPathSegments({
  target: INPUTS.target,
});
if (stagingPathSegments === null) fail();
const targetDirectory = path.join(
  REPOSITORY_ROOT,
  ".release-build",
  ...stagingPathSegments,
);
const targetBuildVersion = distribution.productionElectronBuildVersionForTarget({
  target: INPUTS.target,
  version: INPUTS.version,
  buildNumber: INPUTS.buildNumber,
});
function assertExactStagedManifest() {
  let staged;
  try {
    staged = JSON.parse(readFileSync(path.join(targetDirectory, "app", "package.json"), "utf8"));
  } catch {
    fail();
  }
  if (staged?.version !== INPUTS.version
      || Object.hasOwn(staged, "usageMonitorSourceReleaseVersion")) {
    fail();
  }
  if (JSON.stringify(staged.usageMonitorDistribution) !== JSON.stringify(metadata)) fail();
}

const configuration = {
  appId: distribution.PRODUCTION_ELECTRON_APP_ID,
  executableName: applicationIdentity.APPLICATION_IDENTITY.executableName,
  productName: productBrand.displayName,
  icon: path.join(REPOSITORY_ROOT, productBrand.windowsIcon),
  artifactName: productBrand.displayName + "-${version}-${os}-${arch}.${ext}",
  buildNumber: INPUTS.buildNumber,
  // electron-builder uses this for the PE FileVersion. The closed policy
  // encodes the exact candidate identifier; ambient CI variables cannot affect
  // it.
  buildVersion: targetBuildVersion,
  directories: {
    app: path.join(targetDirectory, "app"),
    output: path.join(targetDirectory, "artifacts"),
  },
  files: stagingClosure(),
  asar: { smartUnpack: false },
  asarUnpack: asarUnpackFor(INPUTS.target),
  extraMetadata: {
    usageMonitorIdentity: applicationIdentity.applicationMetadata("stable"),
    main: "apps/electron/main.js",
    name: "app-usagemonitor",
    productName: productBrand.displayName,
    version: INPUTS.version,
    usageMonitorDistribution: metadata,
    // app-builder-lib uses these fields for Windows executable and NSIS
    // ProductVersion values. Keep them in the same valid four-component form
    // as buildVersion instead of allowing its default decimal build number to
    // overflow a PE resource component.
    shortVersion: targetBuildVersion,
    shortVersionWindows: targetBuildVersion,
  },
  forceCodeSigning: true,
  electronFuses: {
    runAsNode: true,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  beforeBuild: () => false,
  // The staging script and builder config independently derive the closed
  // selection. Verify their package-level semantic version and distribution
  // metadata match before electron-builder can turn it into an installer.
  beforePack: () => assertExactStagedManifest(),
  npmRebuild: true,
  buildDependenciesFromSource: false,
  nodeGypRebuild: false,
  publish: null,
};

configuration.win = {
  icon: path.join(REPOSITORY_ROOT, productBrand.windowsIcon),
  target: [{ target: "nsis", arch: ["x64"] }],
  signAndEditExecutable: true,
  signExecutable: true,
  requestedExecutionLevel: "asInvoker",
  verifyUpdateCodeSignature: true,
};
configuration.nsis = {
  installerIcon: path.join(REPOSITORY_ROOT, productBrand.windowsIcon),
  uninstallerIcon: path.join(REPOSITORY_ROOT, productBrand.windowsIcon),
  shortcutName: productBrand.displayName,
  guid: distribution.PRODUCTION_ELECTRON_WINDOWS_TOAST_ACTIVATOR_CLSID,
  oneClick: true,
  perMachine: false,
  allowElevation: false,
  selectPerMachineByDefault: false,
  allowToChangeInstallationDirectory: false,
  runAfterFinish: false,
  createDesktopShortcut: true,
  createStartMenuShortcut: true,
  deleteAppDataOnUninstall: false,
  differentialPackage: false,
  packElevateHelper: false,
  buildUniversalInstaller: false,
};

module.exports = configuration;
