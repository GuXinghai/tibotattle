#!/usr/bin/env node
/**
 * Checks every deployment endpoint consumer that cannot share the JavaScript
 * manifest directly. The manifest is authoritative; this script makes the
 * checked-in Wrangler, generated Worker types, and Electron runtime fail
 * closed if any of them drift.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, printParseErrorCode } from "jsonc-parser";
import {
  DEPLOYMENT_ENDPOINTS,
  assertDeploymentEndpoints,
} from "../../../config/deployment-endpoints.js";
const SCRIPT_FILE = fileURLToPath(import.meta.url);
export const REPOSITORY_ROOT = resolve(dirname(SCRIPT_FILE), "..", "..", "..");
export const WRANGLER_CONFIG_PATH = join(
  REPOSITORY_ROOT,
  "apps",
  "worker",
  "wrangler.jsonc",
);
export const WORKER_TYPES_PATH = join(
  REPOSITORY_ROOT,
  "apps",
  "worker",
  "worker-configuration.d.ts",
);
export const WORKER_PACKAGE_PATH = join(
  REPOSITORY_ROOT,
  "apps",
  "worker",
  "package.json",
);
export const ELECTRON_RUNTIME_PATH = join(
  REPOSITORY_ROOT, "apps", "electron", "desktop-runtime.js",
);
function fail(message) {
  const error = new Error(message);
  error.code = "DEPLOYMENT_ENDPOINTS_MISMATCH";
  throw error;
}

function exactArray(value, expected, label) {
  if (!Array.isArray(value)
      || value.length !== expected.length
      || value.some((entry, index) => entry !== expected[index])) {
    fail(`${label} must match config/deployment-endpoints.js`);
  }
}

function requireManifestImport(source, label) {
  if (!source.includes("DEPLOYMENT_ENDPOINTS")) {
    fail(`${label} must import config/deployment-endpoints.js`);
  }
}

function rejectEmbeddedEndpoint(source, endpoint, label) {
  if (source.includes(endpoint)) {
    fail(`${label} embeds ${endpoint}; use config/deployment-endpoints.js`);
  }
}

/**
 * Worker JSONC cannot import JavaScript. Require the production config's
 * public origin and custom domains to be exact projections of the manifest.
 */
export function validateWorkerDeploymentEndpoints(
  configuration,
  endpoints = DEPLOYMENT_ENDPOINTS,
) {
  assertDeploymentEndpoints(endpoints);
  const staging = configuration?.env?.staging;
  if (!staging || typeof staging !== "object") {
    fail("wrangler.jsonc must define an env.staging deployment");
  }
  if (staging.name !== endpoints.staging.workerName
      || staging.workers_dev !== endpoints.staging.workersDev
      || staging.preview_urls !== endpoints.staging.previewUrls
      || Object.hasOwn(staging, "routes")
      || staging.vars?.PUBLIC_ORIGIN !== endpoints.staging.origin) {
    fail("Worker staging configuration must match the reviewed nonproduction endpoint");
  }
  const production = configuration?.env?.production;
  if (!production || typeof production !== "object") {
    fail("wrangler.jsonc must define an env.production deployment");
  }
  if (production.vars?.PUBLIC_ORIGIN !== endpoints.public.origin) {
    fail("Worker PUBLIC_ORIGIN must match config/deployment-endpoints.js");
  }
  const routeHosts = production.routes?.map((route) =>
    route?.custom_domain === true ? route.pattern : null);
  // The reviewed production custom domains are the public hosts plus the
  // admin hostname the Cloudflare Access application protects.
  exactArray(
    routeHosts,
    [...endpoints.public.routeHosts, endpoints.admin.host],
    "Worker custom domains",
  );
  // The Access binding variables must exist in production, even as empty
  // fail-closed placeholders, so the admin hostname can never route without
  // a reviewed Zero Trust configuration slot.
  if (typeof production.vars?.ACCESS_TEAM_DOMAIN !== "string"
      || typeof production.vars?.ACCESS_AUD !== "string") {
    fail("Worker production vars must declare ACCESS_TEAM_DOMAIN and ACCESS_AUD");
  }
  return Object.freeze({
    adminHost: endpoints.admin.host,
    publicOrigin: production.vars.PUBLIC_ORIGIN,
    routeHosts: Object.freeze([...routeHosts]),
    stagingOrigin: endpoints.staging.origin,
  });
}

export function validateDeploymentEndpointConsumers({
  electronRuntimeSource,
  workerTypes,
  endpoints = DEPLOYMENT_ENDPOINTS,
}) {
  assertDeploymentEndpoints(endpoints);
  requireManifestImport(electronRuntimeSource, "Electron desktop runtime");
  rejectEmbeddedEndpoint(electronRuntimeSource, endpoints.public.origin, "Electron desktop runtime");
  rejectEmbeddedEndpoint(electronRuntimeSource, endpoints.sparkle.origin, "Electron desktop runtime");
  rejectEmbeddedEndpoint(electronRuntimeSource, endpoints.sparkle.r2Bucket, "Electron desktop runtime");
  if (!electronRuntimeSource.includes("DEPLOYMENT_ENDPOINTS.public.origin")) {
    fail("Electron desktop runtime must use the reviewed public origin");
  }
  if (!workerTypes.includes(
    `PUBLIC_ORIGIN: \"${endpoints.public.origin}\"`,
  )) {
    fail("generated Worker types must match the manifest public origin");
  }
  return Object.freeze({
    publicOrigin: endpoints.public.origin,
    r2Bucket: endpoints.sparkle.r2Bucket,
    updateOrigin: endpoints.sparkle.origin,
  });
}

export function validateWorkerDeploymentEndpointGates(workerPackage) {
  const scripts = workerPackage?.scripts;
  const endpointCheckCommand = "npm run deployment:endpoints:check";
  const endpointGatedDeploymentOperations = [
    ["deploy:dry", "wrangler deploy"],
    ["production:deploy:dry", "wrangler deploy"],
    ["staging:check", "wrangler deploy"],
    ["staging:deploy", "node ./scripts/deploy-disabled-staging.mjs"],
  ];
  if (!scripts || typeof scripts !== "object"
      || scripts["deployment:endpoints:check"]
        !== "node ./scripts/check-deployment-endpoints.mjs") {
    fail("Worker package must expose the deployment endpoint checker");
  }
  for (const [script, deploymentOperation] of endpointGatedDeploymentOperations) {
    const command = scripts[script];
    if (typeof command !== "string") {
      fail(`${script} must define a deployment command`);
    }
    const endpointCheckIndex = command.indexOf(endpointCheckCommand);
    const deploymentOperationIndex = command.indexOf(deploymentOperation);
    if (endpointCheckIndex < 0
        || deploymentOperationIndex < 0
        || endpointCheckIndex > deploymentOperationIndex) {
      fail(
        `${script} must run the deployment endpoint checker before ${deploymentOperation}`,
      );
    }
  }
  if (scripts["production:deploy"]
      !== "node ./scripts/production-deploy.mjs") {
    fail(
      "production:deploy must use the receipt-gated production deployment wrapper",
    );
  }
  return Object.freeze({
    checkedScripts: Object.freeze([
      "deploy:dry",
      "production:deploy",
      "production:deploy:dry",
      "staging:check",
      "staging:deploy",
    ]),
  });
}

function parseWranglerConfiguration(text) {
  const errors = [];
  const configuration = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    fail(
      `wrangler.jsonc is invalid JSONC (${printParseErrorCode(errors[0].error)})`,
    );
  }
  return configuration;
}

function parseWorkerPackage(text) {
  try {
    const workerPackage = JSON.parse(text);
    if (!workerPackage || typeof workerPackage !== "object") {
      fail("apps/worker/package.json must be a JSON object");
    }
    return workerPackage;
  } catch (error) {
    if (error?.code === "DEPLOYMENT_ENDPOINTS_MISMATCH") throw error;
    fail("apps/worker/package.json is invalid JSON");
  }
}

export async function checkDeploymentEndpointConsumers({
  wranglerConfigPath = WRANGLER_CONFIG_PATH,
  workerTypesPath = WORKER_TYPES_PATH,
  workerPackagePath = WORKER_PACKAGE_PATH,
  electronRuntimePath = ELECTRON_RUNTIME_PATH,
  endpoints = DEPLOYMENT_ENDPOINTS,
} = {}) {
  const [
    wranglerText,
    workerTypes,
    workerPackageText,
    electronRuntimeSource,
  ] = await Promise.all([
    readFile(wranglerConfigPath, "utf8"),
    readFile(workerTypesPath, "utf8"),
    readFile(workerPackagePath, "utf8"),
    readFile(electronRuntimePath, "utf8"),
  ]);
  const wranglerConfiguration = parseWranglerConfiguration(wranglerText);
  const worker = validateWorkerDeploymentEndpoints(
    wranglerConfiguration,
    endpoints,
  );
  const consumers = validateDeploymentEndpointConsumers({
    electronRuntimeSource,
    workerTypes,
    endpoints,
  });
  const gates = validateWorkerDeploymentEndpointGates(
    parseWorkerPackage(workerPackageText),
  );
  return Object.freeze({
    ...consumers,
    gates,
    worker,
  });
}

async function main() {
  const checked = await checkDeploymentEndpointConsumers();
  process.stdout.write(`Deployment endpoints: ${checked.publicOrigin}
`);
}

if (process.argv[1]
    && resolve(process.argv[1]) === resolve(SCRIPT_FILE)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
