import { createHash } from "node:crypto";
import {
  DEPLOYMENT_ENDPOINTS,
  assertDeploymentEndpoints,
} from "../../../config/deployment-endpoints.js";
import {
  checkDeploymentEndpointConsumers,
} from "./check-deployment-endpoints.mjs";
import {
  fetchBoundedPublicHTTPS,
  PUBLIC_HTTPS_REMOTE_CODES,
} from "../../../scripts/lib/public-https-fetch.mjs";

export const RELEASE_READINESS_SCHEMA_VERSION =
  "tibotattle-release-readiness-v0.1";
export const OBSERVATION_CHANNEL = "production_containment_observer";
// The only reviewed observation channel. Windows x64 has a single production
// service and update feed, so there is no alternative channel to select.
export const STABLE_RELEASE_CHANNEL = "stable";
export const DEFAULT_RELEASE_CHANNEL = STABLE_RELEASE_CHANNEL;
export const REMOTE_CONTAINMENT_OBSERVED_STATUS =
  "remote_containment_observed";
export const EXPECTED_ENROLLMENT_MODE = "disabled";
export const DEFAULT_RELEASE_PROBE_TIMEOUT_MS = 5_000;
export const MAX_RELEASE_PROBE_TIMEOUT_MS = 30_000;

const DEFAULT_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
});

const KNOWN_ENROLLMENT_MODES = new Set([
  "local_open",
  "open",
  "invite_only",
  "disabled",
]);
const KNOWN_COLLECTION_STATES = new Set([
  "operational",
  "degraded",
  "contained",
]);

function canonicalManifestSnapshot(endpoints) {
  return {
    public: {
      origin: endpoints.public.origin,
      routeHosts: [...endpoints.public.routeHosts],
    },
    schemaVersion: endpoints.schemaVersion,
    sparkle: {
      origin: endpoints.sparkle.origin,
      r2Bucket: endpoints.sparkle.r2Bucket,
    },
  };
}

const CANONICAL_MANIFEST_SNAPSHOT = canonicalManifestSnapshot(
  DEPLOYMENT_ENDPOINTS,
);
const CANONICAL_MANIFEST_SERIALIZED = JSON.stringify(
  CANONICAL_MANIFEST_SNAPSHOT,
);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameSerializedValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function knownEnrollmentMode(value) {
  return KNOWN_ENROLLMENT_MODES.has(value) ? value : "unknown";
}

function knownCollectionState(value) {
  return KNOWN_COLLECTION_STATES.has(value) ? value : "unknown";
}

function normalizeTimeout(value) {
  if (!Number.isSafeInteger(value)
      || value < 1
      || value > MAX_RELEASE_PROBE_TIMEOUT_MS) {
    throw new TypeError(
      `timeout must be an integer from 1 to ${MAX_RELEASE_PROBE_TIMEOUT_MS}`,
    );
  }
  return value;
}

function assertObservedChannel(channel) {
  if (channel !== STABLE_RELEASE_CHANNEL) {
    const error = new Error(`Unknown release channel: ${String(channel)}`);
    error.code = "RELEASE_CHANNEL_UNKNOWN";
    throw error;
  }
}

function timestamp(clock) {
  const value = new Date(clock.now());
  if (Number.isNaN(value.getTime())) {
    throw new TypeError("clock returned an invalid timestamp");
  }
  return value.toISOString();
}

function manifestReceipt(manifest) {
  if (!manifest.ok) {
    return {
      checked: true,
      status: "invalid",
      code: manifest.code ?? "ENDPOINT_MANIFEST_INVALID",
      schemaVersion: null,
      sha256: null,
      publicOrigin: null,
      routeHosts: [],
    };
  }
  return {
    checked: true,
    status: "matched",
    code: null,
    schemaVersion: manifest.schemaVersion,
    sha256: manifest.sha256,
    publicOrigin: manifest.publicOrigin,
    routeHosts: [...manifest.routeHosts],
  };
}

function channelPolicyReceipt() {
  return {
    name: STABLE_RELEASE_CHANNEL,
    serviceOrigin: DEPLOYMENT_ENDPOINTS.public.origin,
  };
}

export function validateCanonicalEndpointManifest(
  endpoints = DEPLOYMENT_ENDPOINTS,
) {
  try {
    assertDeploymentEndpoints(endpoints);
    const snapshot = canonicalManifestSnapshot(endpoints);
    if (!sameSerializedValue(snapshot, CANONICAL_MANIFEST_SNAPSHOT)) {
      return Object.freeze({
        ok: false,
        code: "ENDPOINT_MANIFEST_DRIFT",
      });
    }
    return Object.freeze({
      ok: true,
      code: null,
      schemaVersion: snapshot.schemaVersion,
      sha256: sha256(CANONICAL_MANIFEST_SERIALIZED),
      publicOrigin: snapshot.public.origin,
      routeHosts: Object.freeze([...snapshot.public.routeHosts]),
    });
  } catch {
    return Object.freeze({
      ok: false,
      code: "ENDPOINT_MANIFEST_INVALID",
    });
  }
}

function deploymentDriftReceipt({ checked, status, code = null }) {
  return {
    checked,
    status,
    code,
  };
}

function notCheckedEndpoint() {
  return {
    checked: false,
    status: "not_checked",
    code: "PUBLIC_PROBE_NOT_REQUESTED",
    httpStatus: null,
  };
}

function requestFailure(error, prefix) {
  const remoteCode = error?.code;
  const code = remoteCode === PUBLIC_HTTPS_REMOTE_CODES.TIMEOUT
    ? `${prefix}_TIMEOUT`
    : remoteCode === PUBLIC_HTTPS_REMOTE_CODES.FETCH_REDIRECT
      ? `${prefix}_REDIRECT`
      : `${prefix}_UNAVAILABLE`;
  return {
    checked: true,
    status: "unavailable",
    code,
    httpStatus: Number.isInteger(error?.status) ? error.status : null,
  };
}

function isContentType(contentType, expected) {
  return typeof contentType === "string"
    && contentType.split(";", 1)[0].trim().toLowerCase() === expected;
}

function parseHealthBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function containedHealthChecks(body) {
  const controls = body?.collectionControls;
  return {
    serviceOk: body?.status === "ok",
    enrollmentDisabled: body?.enrollmentMode === EXPECTED_ENROLLMENT_MODE
      && controls?.enrollment === false,
    collectionContained: controls?.state === "contained"
      && controls?.enrollment === false
      && controls?.uploadRegistration === false
      && controls?.processing === false
      && controls?.publication === false,
    externalParticipantsUnauthorized:
      body?.contracts?.accountScopedContribution
        ?.externalParticipantsAuthorized === false,
  };
}

async function checkHealth({
  publicOrigin,
  clock,
  fetchImpl,
  timeoutMs,
}) {
  let response;
  try {
    response = await fetchBoundedPublicHTTPS(
      new URL("/api/health", publicOrigin).href,
      {
        accept: "application/json",
        clock,
        fetchImpl,
        maximumBytes: 64 * 1024,
        timeoutMs,
      },
    );
  } catch (error) {
    return requestFailure(error, "HEALTH");
  }
  if (response.status !== 200) {
    return {
      checked: true,
      status: "unavailable",
      code: "HEALTH_HTTP_STATUS",
      httpStatus: response.status,
    };
  }
  if (!isContentType(response.contentType, "application/json")) {
    return {
      checked: true,
      status: "unavailable",
      code: "HEALTH_CONTENT_TYPE_INVALID",
      httpStatus: response.status,
    };
  }
  const body = parseHealthBody(response.body);
  const checks = containedHealthChecks(body);
  const driftCodes = [];
  if (body?.enrollmentMode !== EXPECTED_ENROLLMENT_MODE) {
    driftCodes.push("DEPLOYED_ENROLLMENT_MODE_DRIFT");
  }
  if (!checks.collectionContained) {
    driftCodes.push("DEPLOYED_COLLECTION_CONTROLS_DRIFT");
  }
  if (!checks.externalParticipantsUnauthorized) {
    driftCodes.push("DEPLOYED_EXTERNAL_PARTICIPATION_DRIFT");
  }
  if (!body || !checks.serviceOk) {
    return {
      checked: true,
      status: "unavailable",
      code: "HEALTH_BODY_INVALID",
      httpStatus: response.status,
      enrollmentMode: knownEnrollmentMode(body?.enrollmentMode),
      collectionState: knownCollectionState(body?.collectionControls?.state),
      checks,
    };
  }
  if (driftCodes.length > 0) {
    return {
      checked: true,
      status: "drift",
      code: driftCodes[0],
      codes: Object.freeze(driftCodes),
      httpStatus: response.status,
      enrollmentMode: knownEnrollmentMode(body.enrollmentMode),
      collectionState: knownCollectionState(body.collectionControls?.state),
      checks,
    };
  }
  return {
    checked: true,
    status: "pass",
    code: null,
    codes: Object.freeze([]),
    httpStatus: response.status,
    enrollmentMode: EXPECTED_ENROLLMENT_MODE,
    collectionState: "contained",
    checks,
  };
}

function validReadyBody(body, status) {
  return [200, 503].includes(status)
    && body?.status === (status === 200 ? "ready" : "not_ready")
    && typeof body?.checks === "object"
    && body.checks !== null
    && typeof body.checks.lifecycleFresh === "boolean"
    && typeof body.checks.quarantineRetentionComplete === "boolean"
    && typeof body.checks.restoreReplayComplete === "boolean"
    && typeof body.checks.aggregateRebuildComplete === "boolean"
    && typeof body.checks.maintenanceCycleMatched === "boolean"
    && typeof body.checks.quarantineReconciliationComplete === "boolean"
    && body?.policy?.lifecycleStaleAfterMilliseconds
      === 2 * 60 * 60 * 1000;
}

async function checkReady({
  publicOrigin,
  clock,
  fetchImpl,
  timeoutMs,
}) {
  let response;
  try {
    response = await fetchBoundedPublicHTTPS(
      new URL("/api/ready", publicOrigin).href,
      {
        accept: "application/json",
        clock,
        fetchImpl,
        maximumBytes: 64 * 1024,
        timeoutMs,
      },
    );
  } catch (error) {
    return requestFailure(error, "READY");
  }
  if (![200, 503].includes(response.status)) {
    return {
      checked: true,
      status: "unavailable",
      code: "READY_HTTP_STATUS",
      httpStatus: response.status,
    };
  }
  if (!isContentType(response.contentType, "application/json")) {
    return {
      checked: true,
      status: "unavailable",
      code: "READY_CONTENT_TYPE_INVALID",
      httpStatus: response.status,
    };
  }
  const body = parseHealthBody(response.body);
  if (!validReadyBody(body, response.status)) {
    return {
      checked: true,
      status: "unavailable",
      code: "READY_BODY_INVALID",
      httpStatus: response.status,
    };
  }
  if (response.status === 503) {
    return {
      checked: true,
      status: "not_ready",
      code: "READY_NOT_READY",
      httpStatus: response.status,
    };
  }
  return {
    checked: true,
    status: "pass",
    code: null,
    httpStatus: response.status,
  };
}

function publicReceipt(publicChecks, requested) {
  return {
    requested,
    health: publicChecks.health,
    ready: publicChecks.ready,
  };
}

function endpointCodes(endpoint) {
  return Array.isArray(endpoint?.codes) && endpoint.codes.length > 0
    ? endpoint.codes
    : endpoint?.code ? [endpoint.code] : [];
}

function unique(values) {
  return [...new Set(values)];
}

function observationEvidence({ status, probePublic }) {
  const remoteContainment = !probePublic
    ? "not_checked"
    : status === REMOTE_CONTAINMENT_OBSERVED_STATUS
      ? "observed"
      : "not_observed";
  return {
    scope: "remote_containment",
    remoteContainment,
    signedUpdate: "not_proven",
    nativeClientRehearsal: "not_run",
  };
}

export async function verifyReleaseReadiness({
  channel = DEFAULT_RELEASE_CHANNEL,
  endpoints = DEPLOYMENT_ENDPOINTS,
  probePublic = false,
  endpointConsumerCheck = checkDeploymentEndpointConsumers,
  fetchImpl = globalThis.fetch,
  clock = DEFAULT_CLOCK,
  timeoutMs = DEFAULT_RELEASE_PROBE_TIMEOUT_MS,
} = {}) {
  if (typeof probePublic !== "boolean") {
    throw new TypeError("probePublic must be a boolean");
  }
  const boundedTimeout = normalizeTimeout(timeoutMs);
  assertObservedChannel(channel);
  const blockers = [];
  const deployment = deploymentDriftReceipt({
    checked: false,
    status: "not_checked",
    code: "DEPLOYMENT_DRIFT_NOT_CHECKED",
  });
  let publicChecks = {
    health: notCheckedEndpoint(),
    ready: notCheckedEndpoint(),
  };
  // The observer is bound to the reviewed production manifest. An injected
  // object is accepted only as a drift-test input and is never used for
  // consumer checks or network requests.
  const suppliedManifest = validateCanonicalEndpointManifest(endpoints);
  const endpointManifest = manifestReceipt(suppliedManifest);
  const manifestIsUsable = suppliedManifest.ok;
  const publicOrigin = DEPLOYMENT_ENDPOINTS.public.origin;
  if (!manifestIsUsable) blockers.push(suppliedManifest.code);

  if (manifestIsUsable) {
    try {
      if (typeof endpointConsumerCheck !== "function") {
        throw new TypeError("endpoint consumer checker unavailable");
      }
      await endpointConsumerCheck({ endpoints: DEPLOYMENT_ENDPOINTS });
      deployment.checked = true;
      deployment.status = "no_drift";
      deployment.code = null;
    } catch {
      deployment.checked = true;
      deployment.status = "drift";
      deployment.code = "DEPLOYMENT_ENDPOINT_DRIFT";
      blockers.push(deployment.code);
    }
  }

  if (!probePublic) {
    blockers.push("PUBLIC_PROBE_NOT_REQUESTED");
  } else if (manifestIsUsable && blockers.length === 0) {
    const requestOptions = {
      clock,
      fetchImpl,
      timeoutMs: boundedTimeout,
    };
    publicChecks = {
      health: await checkHealth({
        publicOrigin,
        ...requestOptions,
      }),
      ready: await checkReady({
        publicOrigin,
        ...requestOptions,
      }),
    };
    for (const endpoint of Object.values(publicChecks)) {
      if (endpoint.status !== "pass") {
        blockers.push(...endpointCodes(endpoint));
      }
    }
  }

  const uniqueBlockers = unique(blockers.filter(Boolean));
  const status = !manifestIsUsable || deployment.status === "drift"
    ? "blocked"
    : !probePublic
      ? "public_unchecked"
      : uniqueBlockers.length === 0
        ? REMOTE_CONTAINMENT_OBSERVED_STATUS
        : "not_ready";
  return Object.freeze({
    schemaVersion: RELEASE_READINESS_SCHEMA_VERSION,
    operation: "production_containment_observation",
    channel: STABLE_RELEASE_CHANNEL,
    observationChannel: OBSERVATION_CHANNEL,
    channelPolicy: channelPolicyReceipt(),
    generatedAt: timestamp(clock),
    endpointManifest,
    deploymentDrift: deployment,
    expected: {
      enrollmentMode: EXPECTED_ENROLLMENT_MODE,
      collectionControls: "contained",
      externalParticipantsAuthorized: false,
    },
    public: publicReceipt(publicChecks, probePublic),
    status,
    // This observer never proves a release is ready. The nested public.ready
    // receipt is only the remote endpoint's own readiness response.
    ready: false,
    releaseReady: false,
    evidence: observationEvidence({
      status,
      probePublic,
    }),
    collectionAuthorized: false,
    blockers: Object.freeze(uniqueBlockers),
  });
}
