"use strict";

// Persistence, registration and trust identifiers. Never derive these from branding.
const APPLICATION_IDENTITY = Object.freeze({
  packageName: "app-usagemonitor",
  executableName: "usage-monitor",
  stateDirectoryName: "UsageMonitor",
  metadataKey: "usageMonitorIdentity",
  distributionMetadataKey: "usageMonitorDistribution",
  schemaVersion: "usage-monitor-application-identity-v1",
  appOpenScheme: "usagemonitor",
  appOpenHost: "open",
  appOpenURL: "usagemonitor://open",
  semanticOpenTargetPlaceholder: "__USAGE_MONITOR_SEMANTIC_OPEN_TARGET__",
});

const APPLICATION_PROFILES = Object.freeze({
  stable: Object.freeze({
    appId: "com.usagemonitor.local",
    profile: "stable",
    toastActivatorClsid: "FDA705D7-5644-50E8-8CD2-3005D51B98C5",
    appOpenURL: APPLICATION_IDENTITY.appOpenURL,
  }),
  development: Object.freeze({
    appId: "com.usagemonitor.local.dev",
    profile: "development",
    appOpenURL: "usagemonitor-dev://open",
  }),
  preview: Object.freeze({
    appId: "com.usagemonitor.local.preview",
    profile: "preview",
    appOpenURL: "usagemonitor-preview://open",
  }),
});

function applicationMetadata(profile) {
  const selected = Object.hasOwn(APPLICATION_PROFILES, profile) ? APPLICATION_PROFILES[profile] : null;
  if (selected === null) throw new TypeError("Unknown application profile");
  return Object.freeze({
    schemaVersion: APPLICATION_IDENTITY.schemaVersion,
    appId: selected.appId,
    profile: selected.profile,
  });
}

function validateApplicationMetadata(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).sort().join(",") !== "appId,profile,schemaVersion"
      || !Object.hasOwn(APPLICATION_PROFILES, value.profile)
      || value.schemaVersion !== APPLICATION_IDENTITY.schemaVersion
      || value.appId !== APPLICATION_PROFILES[value.profile].appId) {
    throw new TypeError("Invalid application identity");
  }
  return applicationMetadata(value.profile);
}

module.exports = Object.freeze({
  APPLICATION_IDENTITY, APPLICATION_PROFILES, applicationMetadata, validateApplicationMetadata,
});
